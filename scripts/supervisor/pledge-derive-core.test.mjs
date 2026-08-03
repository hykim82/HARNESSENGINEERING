// HYK-185 gap#61 (coder-task.md §7, §3) -- pledge-derive-core.mjs 계약
// 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 이 스위트가 100% 통과해도 "진입점이 실제로 이 형태의 evidence를
//    모은다"를 증명하지 않는다 -- 그건 orch-stall-detect.test.mjs의 몫.
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  derivePledges,
  PLEDGE_SOURCE,
  PLEDGE_DERIVE_REASON,
  PLEDGE_DERIVE_NOTE_REASON,
} from "./pledge-derive-core.mjs";
import {
  ARTIFACT_KIND,
  PLEDGE_RESOLUTION_STATUS,
} from "./orch-progress-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();

const NOW_MS = Date.parse("2026-08-03T18:00:00+09:00");

function droppedTaskFileItem(overrides = {}) {
  return {
    path: ".harness/coder-task.md",
    taskId: "HYK-000-x",
    droppedAtMs: NOW_MS - 3600_000,
    resultFile: {
      path: ".harness/coder.md",
      exists: true,
      mtimeMs: NOW_MS - 1800_000,
    },
    ...overrides,
  };
}

function commitItem(overrides = {}) {
  return {
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    commitTimeMs: NOW_MS - 1800_000,
    remoteRef: "origin/master",
    contains: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/fetch/Date.now are never invoked while deriving from a mixed evidence batch", () => {
  const fsWatched = [
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
    "existsSync",
    "statSync",
    "readdirSync",
    "mkdirSync",
    "rmSync",
  ];
  const cpWatched = [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
  ];
  const fsMocks = fsWatched
    .filter((n) => typeof fs[n] === "function")
    .map((n) =>
      mock.method(fs, n, () => {
        throw new Error(`unexpected fs.${n} call from derivePledges`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from derivePledges`,
        );
      }),
    );
  const hasFetch = typeof globalThis.fetch === "function";
  const fetchMock = hasFetch
    ? mock.method(globalThis, "fetch", () => {
        throw new Error("unexpected fetch call from derivePledges");
      })
    : null;
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from derivePledges");
  });
  try {
    derivePledges({
      evidence: {
        droppedTaskFiles: [droppedTaskFileItem(), { bogus: true }],
        localVsRemote: [commitItem(), { contains: true }],
      },
      now: NOW_MS,
    });
    for (const m of [...fsMocks, ...cpMocks])
      assert.equal(m.mock.calls.length, 0);
    if (fetchMock) assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(dateNowMock.mock.calls.length, 0);
  } finally {
    for (const m of [...fsMocks, ...cpMocks]) m.mock.restore();
    if (fetchMock) fetchMock.mock.restore();
    dateNowMock.mock.restore();
  }
});

const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "pledge-derive-core.mjs"),
  "utf8",
);
test("static: pledge-derive-core.mjs's only import is orch-progress-core.mjs (vocabulary reuse, no other I/O surface)", () => {
  const imports = [
    ...SRC_TEXT.matchAll(/^import[\s\S]*?from\s+["'](.+)["'];?\s*$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(imports, ["./orch-progress-core.mjs"]);
});

// ---------------------------------------------------------------------------
// args 결손 -- throw 없이 ok:false로 닫힌다.
// ---------------------------------------------------------------------------
test("fail-closed: args not a plain object -> ok:false, reasonCode INVALID_ARGUMENTS, never thrown (2/2: undefined and a string)", () => {
  for (const bad of [undefined, "not-an-object"]) {
    assert.doesNotThrow(() => {
      const result = derivePledges(bad);
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, PLEDGE_DERIVE_REASON.INVALID_ARGUMENTS);
      assert.deepEqual(result.pledges, []);
    });
  }
});

test("fail-closed: now not a finite number -> ok:false, reasonCode NOW_INVALID", () => {
  const result = derivePledges({ evidence: {}, now: "not-a-number" });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PLEDGE_DERIVE_REASON.NOW_INVALID);
});

test("fail-closed: evidence not a plain object -> ok:false, reasonCode EVIDENCE_INVALID", () => {
  const result = derivePledges({ evidence: "nope", now: NOW_MS });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PLEDGE_DERIVE_REASON.EVIDENCE_INVALID);
});

test("both evidence categories absent -> ok:true, 0 pledges, 0 notes (legitimately empty, not an error)", () => {
  const result = derivePledges({ evidence: {}, now: NOW_MS });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pledges, []);
  assert.deepEqual(result.notes, []);
});

// ---------------------------------------------------------------------------
// ★재작업 2R(coder-task.md §11 P1, REVIEW 반려 소비) -- "정상적으로
// 없음"(collectionFailures 없음/빈 배열)과 "확인 못 함"(collectionFailures
// 비어있지 않음)을 반드시 구별한다. REVIEW가 재현한 fail-open(수집 실패가
// PROGRESSING/NO_PLEDGES_RECORDED로 새는 것)을 여기서 직접 막는다.
// ---------------------------------------------------------------------------
test("collectionFailures absent -> ok:true (backward compatible with callers that don't signal failures, e.g. earlier-cycle unit tests)", () => {
  const result = derivePledges({
    evidence: { droppedTaskFiles: [droppedTaskFileItem()] },
    now: NOW_MS,
  });
  assert.equal(result.ok, true);
});

test("collectionFailures: [] (empty array, explicit 'no failures') -> ok:true, processes evidence normally", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [droppedTaskFileItem()],
      collectionFailures: [],
    },
    now: NOW_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.pledges.length, 1);
});

test("collectionFailures: ['droppedTaskFiles'] (non-empty, real collection failure) -> ok:false, reasonCode COLLECTION_FAILED, 0 pledges (does NOT silently fall through to PROGRESSING/empty)", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [droppedTaskFileItem()], // 개별 항목은 멀쩡해 보여도
      collectionFailures: ["droppedTaskFiles"], // 이 계열의 수집 기반 자체가 흔들렸다.
    },
    now: NOW_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PLEDGE_DERIVE_REASON.COLLECTION_FAILED);
  assert.deepEqual(result.pledges, []);
});

test("collectionFailures not an array (malformed signal itself) -> ok:false, reasonCode COLLECTION_FAILURES_INVALID (fail-closed on a malformed failure-signal too, not just on a real failure)", () => {
  const result = derivePledges({
    evidence: { collectionFailures: "not-an-array" },
    now: NOW_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.reasonCode,
    PLEDGE_DERIVE_REASON.COLLECTION_FAILURES_INVALID,
  );
  assert.deepEqual(result.pledges, []);
});

// ---------------------------------------------------------------------------
// 드롭된 태스크 파일 -> 소비 약속 유도.
// ---------------------------------------------------------------------------
test("droppedTaskFiles: well-formed entry with a produced result file -> derives an OPEN TASK_FILE_DROPPED_AFTER pledge tagged DERIVED", () => {
  const result = derivePledges({
    evidence: { droppedTaskFiles: [droppedTaskFileItem()] },
    now: NOW_MS,
  });
  assert.equal(result.pledges.length, 1);
  const p = result.pledges[0];
  assert.equal(p.pledgeId, "derived:consume:HYK-000-x");
  assert.equal(p.source, PLEDGE_SOURCE.DERIVED);
  assert.equal(p.expectedArtifact.kind, ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER);
  assert.equal(p.expectedArtifact.path, ".harness/coder-task.md");
  assert.equal(p.resolution.status, PLEDGE_RESOLUTION_STATUS.OPEN);
  assert.equal(p.recordedAt, new Date(NOW_MS - 1800_000).toISOString());
});

// ★재작업 1R(coder-task.md §10) -- 결과 미도착은 더 이상 "약속 없음"이
// 아니다. 태스크가 떨어졌다는 흔적 자체가 이미 실재하므로, "결과 도착을
// 기다린다"는 약속(RESULT_FILE_APPEARS_AFTER, 기존 어휘 재사용)을
// 유도한다 -- 지어내기가 아니라 evidence에 이미 있는 사실에서 파생.
test("droppedTaskFiles: result file NOT yet produced -> derives an OPEN RESULT_FILE_APPEARS_AFTER pledge (await-result, tagged DERIVED, not a no-op) [gap#61 1R]", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          resultFile: {
            path: ".harness/coder.md",
            exists: false,
            mtimeMs: null,
          },
        }),
      ],
    },
    now: NOW_MS,
  });
  assert.equal(result.pledges.length, 1);
  assert.deepEqual(result.notes, []);
  const p = result.pledges[0];
  assert.equal(p.pledgeId, "derived:await-result:HYK-000-x");
  assert.equal(p.source, PLEDGE_SOURCE.DERIVED);
  assert.equal(
    p.expectedArtifact.kind,
    ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER,
  );
  assert.equal(p.expectedArtifact.path, ".harness/coder.md");
  assert.equal(p.resolution.status, PLEDGE_RESOLUTION_STATUS.OPEN);
  // 결과 파일이 없어 mtime을 쓸 수 없다 -- droppedAtMs가 약속 시각이다.
  assert.equal(p.recordedAt, new Date(NOW_MS - 3600_000).toISOString());
});

test("droppedTaskFiles: droppedAtMs in the future (await-result branch) -> not derived (no fabricated pledge from an impossible timestamp)", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          droppedAtMs: NOW_MS + 60_000,
          resultFile: {
            path: ".harness/coder.md",
            exists: false,
            mtimeMs: null,
          },
        }),
      ],
    },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_RECORDED_AT_IN_FUTURE,
  );
});

// (배타성) 같은 항목에서 소비 약속과 대기 약속이 동시에 나오지 않는다 --
// resultFile.exists 값에 따라 정확히 하나만 유도된다(coder-task.md §10
// "두 분기는 서로 배타적 -- 그 배타성을 시험으로 고정하라").
test("droppedTaskFiles: consume vs await-result are mutually exclusive -- a batch of 1 produced-result item + 1 not-yet-produced item derives EXACTLY 2 pledges, one of each kind, never both/neither for a single item", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({ taskId: "HYK-A" }), // resultFile.exists:true (default)
        droppedTaskFileItem({
          taskId: "HYK-B",
          resultFile: {
            path: ".harness/review.md",
            exists: false,
            mtimeMs: null,
          },
        }),
      ],
    },
    now: NOW_MS,
  });
  assert.equal(result.pledges.length, 2);
  const kinds = result.pledges.map((p) => p.expectedArtifact.kind).sort();
  assert.deepEqual(
    kinds,
    [
      ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER,
      ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
    ].sort(),
  );
  const ids = result.pledges.map((p) => p.pledgeId).sort();
  assert.deepEqual(
    ids,
    ["derived:await-result:HYK-B", "derived:consume:HYK-A"].sort(),
  );
});

test("droppedTaskFiles: malformed entry (missing taskId) -> no pledge fabricated, noted as ENTRY_MALFORMED", () => {
  const result = derivePledges({
    evidence: { droppedTaskFiles: [{ path: ".harness/x-task.md" }] },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_ENTRY_MALFORMED,
  );
});

test("droppedTaskFiles: malformed entry (resultFile.path missing) -> no pledge fabricated, noted as ENTRY_MALFORMED (path is required so an await-result pledge always has a target)", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({ resultFile: { exists: false, mtimeMs: null } }),
      ],
    },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_ENTRY_MALFORMED,
  );
});

test("droppedTaskFiles: result mtime in the future relative to `now` -> not derived (no fabricated pledge from an impossible timestamp)", () => {
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          resultFile: {
            path: ".harness/coder.md",
            exists: true,
            mtimeMs: NOW_MS + 60_000,
          },
        }),
      ],
    },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_RECORDED_AT_IN_FUTURE,
  );
});

test("droppedTaskFiles: category present but not an array -> whole category noted malformed, other category still processed (denominator=1 malformed category)", () => {
  const result = derivePledges({
    evidence: { droppedTaskFiles: "nope", localVsRemote: [commitItem()] },
    now: NOW_MS,
  });
  assert.equal(result.pledges.length, 1); // commit category still derives
  const malformedNotes = result.notes.filter(
    (n) =>
      n.reasonCode ===
      PLEDGE_DERIVE_NOTE_REASON.DROPPED_TASK_FILES_CATEGORY_MALFORMED,
  );
  assert.equal(malformedNotes.length, 1);
});

// ---------------------------------------------------------------------------
// 로컬 커밋 vs 원격 -> 발행 약속 유도.
// ---------------------------------------------------------------------------
test("localVsRemote: not-yet-contained commit -> derives an OPEN REMOTE_REF_CONTAINS_COMMIT pledge tagged DERIVED", () => {
  const result = derivePledges({
    evidence: { localVsRemote: [commitItem()] },
    now: NOW_MS,
  });
  assert.equal(result.pledges.length, 1);
  const p = result.pledges[0];
  assert.equal(
    p.pledgeId,
    "derived:publish:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  );
  assert.equal(p.source, PLEDGE_SOURCE.DERIVED);
  assert.equal(
    p.expectedArtifact.kind,
    ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT,
  );
  assert.equal(p.expectedArtifact.remoteRef, "origin/master");
  assert.equal(p.expectedArtifact.commitSha, commitItem().commitSha);
});

test("localVsRemote: commit already contained -> no pledge needed (already resolved), noted distinctly (not an error)", () => {
  const result = derivePledges({
    evidence: { localVsRemote: [commitItem({ contains: true })] },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.COMMIT_ALREADY_CONTAINED_NO_DERIVATION_NEEDED,
  );
});

test("localVsRemote: containment unresolved (collection failed, contains:null) -> fail-closed, not derived as either state", () => {
  const result = derivePledges({
    evidence: { localVsRemote: [commitItem({ contains: null })] },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.COMMIT_CONTAINMENT_UNRESOLVED,
  );
});

test("localVsRemote: malformed entry (commitTimeMs missing) -> no pledge fabricated, noted as ENTRY_MALFORMED", () => {
  const result = derivePledges({
    evidence: {
      localVsRemote: [
        { commitSha: "x", remoteRef: "origin/master", contains: false },
      ],
    },
    now: NOW_MS,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.COMMIT_ENTRY_MALFORMED,
  );
});

// ---------------------------------------------------------------------------
// (f) 정상 대조군 오탐 0 -- "이미 발행됨"/"수집 실패(불확실)" 흔적에서
// STALLED로 이어질 OPEN 약속을 만들지 않는다(분모=2, localVsRemote
// 계열). ★재작업 1R: droppedTaskFiles 계열은 더 이상 여기 없다 --
// 결과 미도착도 이제 정당한 OPEN 파생 대상(await-result)이라 "오탐 없이
// 0을 내야 하는 이미 해소된 상태"의 예시가 아니게 됐다(위 배타성 시험이
// 그 정확한 동작을 이미 고정한다).
// ---------------------------------------------------------------------------
test("(f) false-derivation count is 0 across 2 already-resolved/unresolvable localVsRemote fixtures (denominator=2): no OPEN pledge is fabricated for already-settled or unresolvable evidence", () => {
  const fixtures = [
    { localVsRemote: [commitItem({ contains: true })] },
    { localVsRemote: [commitItem({ contains: null })] },
  ];
  let derived = 0;
  for (const evidence of fixtures) {
    const result = derivePledges({ evidence, now: NOW_MS });
    derived += result.pledges.length;
  }
  assert.equal(derived, 0, "denominator=2");
});

// ---------------------------------------------------------------------------
// (g) 판별력 자동화 -- copy-and-mutate 층(orch-progress-core.test.mjs
// 선례 재사용). 신규 파일이라 아직 HEAD에 없으면 명시적 사유로 skip한다.
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/pledge-derive-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "pledge-derive-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-pledge-derive-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "pledge-derive-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  const orig = join(ROOT, "scripts", "supervisor", "orch-progress-core.mjs");
  fs.copyFileSync(orig, join(dir, "orch-progress-core.mjs"));
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/pledge-derive-core #1 (필수): 결과 파일 존재 확인(분기 선택) 제거 -> RED (결과가 아직 없는데도 소비 약속으로 강제 오판, null mtime에서 날짜 조작)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (item.resultFile.exists === true) {\n    deriveConsumePledge(item, now, pledges, notes);\n    return;\n  }\n  deriveAwaitResultPledge(item, now, pledges, notes);\n",
        "  deriveConsumePledge(item, now, pledges, notes);\n",
      ),
    );
    const result = mutant.derivePledges({
      evidence: {
        droppedTaskFiles: [
          {
            path: ".harness/coder-task.md",
            taskId: "HYK-000-x",
            droppedAtMs: NOW_MS - 3600_000,
            resultFile: {
              path: ".harness/coder.md",
              exists: false,
              mtimeMs: null,
            },
          },
        ],
      },
      now: NOW_MS,
    });
    assert.equal(
      result.pledges.length,
      1,
      "mutant must still fabricate a pledge (RED signal precondition)",
    );
    assert.equal(
      result.pledges[0].expectedArtifact.kind,
      ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
      "mutant misclassifies a not-yet-produced result as an already-consumed one (wrong kind -- proves the exists-based branch selection is load-bearing)",
    );
    assert.equal(
      result.pledges[0].recordedAt,
      new Date(null).toISOString(),
      "mutant fabricates recordedAt from a null mtime (epoch 1970) instead of correctly refusing/awaiting -- proves the branch guard prevents nonsense timestamps",
    );
  },
);

test(
  "NC mutation/pledge-derive-core #5 (필수·재작업 1R 신규): 결과-미도착 대기 약속 유도 분기 제거 -> RED (배달했으나 결과 안 옴이 다시 «약속 없음»으로 후퇴)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (item.resultFile.exists === true) {\n    deriveConsumePledge(item, now, pledges, notes);\n    return;\n  }\n  deriveAwaitResultPledge(item, now, pledges, notes);\n",
        "  if (item.resultFile.exists === true) {\n    deriveConsumePledge(item, now, pledges, notes);\n  }\n",
      ),
    );
    const result = mutant.derivePledges({
      evidence: {
        droppedTaskFiles: [
          {
            path: ".harness/review-task.md",
            taskId: "HYK-000-y",
            droppedAtMs: NOW_MS - 3600_000,
            resultFile: {
              path: ".harness/review.md",
              exists: false,
              mtimeMs: null,
            },
          },
        ],
      },
      now: NOW_MS,
    });
    assert.equal(
      result.pledges.length,
      0,
      "mutant must regress to producing 0 pledges for a not-yet-produced result (RED signal; proves the await-result derivation branch is load-bearing -- this is exactly the gap#61 1R regression this suite must catch)",
    );
  },
);

test(
  "NC mutation/pledge-derive-core #2 (필수): 원격 포함 검사 제거 -> RED (이미 push된 커밋도 발행 약속으로 유도)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (item.contains === true) {\n    notes.push(\n      note(\n        PLEDGE_DERIVE_NOTE_REASON.COMMIT_ALREADY_CONTAINED_NO_DERIVATION_NEEDED,\n        item,\n      ),\n    );\n    return;\n  }\n",
        "",
      ),
    );
    const result = mutant.derivePledges({
      evidence: {
        localVsRemote: [
          {
            commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            commitTimeMs: NOW_MS - 1800_000,
            remoteRef: "origin/master",
            contains: true,
          },
        ],
      },
      now: NOW_MS,
    });
    assert.equal(
      result.pledges.length,
      1,
      "mutant must fabricate a publish pledge for an already-pushed commit (RED signal; proves the containment gate is load-bearing)",
    );
  },
);

test(
  "NC mutation/pledge-derive-core #3 (필수): 증거 결손 fail-closed 제거 -> RED (수집 실패(contains:null)가 그대로 약속으로 새어나감)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (item.contains === null) {\n    notes.push(\n      note(PLEDGE_DERIVE_NOTE_REASON.COMMIT_CONTAINMENT_UNRESOLVED, item),\n    );\n    return;\n  }\n",
        "",
      ),
    );
    const result = mutant.derivePledges({
      evidence: {
        localVsRemote: [
          {
            commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            commitTimeMs: NOW_MS - 1800_000,
            remoteRef: "origin/master",
            contains: null,
          },
        ],
      },
      now: NOW_MS,
    });
    // 이 가드를 지우면 null(수집 실패)이 `=== true` 검사를 그냥 통과해
    // 더 내려가 무조건 발행 약속을 만든다 -- "수집 실패"를 "발행
    // 필요"로 오판하는 정확한 누출.
    assert.equal(
      result.pledges.length,
      1,
      "mutant must fabricate a publish pledge from unresolved (collection-failed) containment evidence (RED signal; proves the null-containment fail-closed guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/pledge-derive-core #4 (필수): 출처 표시 제거 -> RED (유도/선언 구별이 사라짐)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(/source: PLEDGE_SOURCE\.DERIVED,\n/g, ""),
    );
    const result = mutant.derivePledges({
      evidence: { droppedTaskFiles: [droppedTaskFileItem()] },
      now: NOW_MS,
    });
    assert.equal(
      result.pledges[0].source,
      undefined,
      "mutant must produce a pledge with no `source` tag (RED signal; proves derived/declared provenance tagging is load-bearing, §3-e)",
    );
  },
);

// ★재작업 2R(coder-task.md §11 P1 항목 5, REVIEW 반려 소비 -- 신규
// mutation, 총 6종) -- 수집 실패 fail-closed 가드 제거 -> RED (수집
// 실패가 다시 "약속 없음"(ok:true, 빈 배열)으로 새어나간다 -- 정확히
// REVIEW가 재현한 fail-open의 재발).
test(
  "NC mutation/pledge-derive-core #6 (필수·재작업 2R 신규): 수집 실패 fail-closed 가드 제거 -> RED (collectionFailures가 있어도 ok:true로 새어나감 -- REVIEW P1 재발)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function checkCollectionFailures(evidence) {\n  if (evidence.collectionFailures === undefined) return null;\n  if (!Array.isArray(evidence.collectionFailures)) {\n    return invalidArgs(PLEDGE_DERIVE_REASON.COLLECTION_FAILURES_INVALID);\n  }\n  if (evidence.collectionFailures.length > 0) {\n    return invalidArgs(PLEDGE_DERIVE_REASON.COLLECTION_FAILED);\n  }\n  return null;\n}",
        "function checkCollectionFailures() {\n  return null;\n}",
      ),
    );
    const result = mutant.derivePledges({
      evidence: { collectionFailures: ["droppedTaskFiles"] },
      now: NOW_MS,
    });
    assert.equal(
      result.ok,
      true,
      "mutant must let a real collection failure leak into ok:true (RED signal; proves the collection-failure fail-closed guard is load-bearing -- this is the exact bug REVIEW P1 caught)",
    );
  },
);
