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
  DEFAULT_RESIDUE_THRESHOLD_SECONDS,
} from "./pledge-derive-core.mjs";
import {
  ARTIFACT_KIND,
  PLEDGE_RESOLUTION_STATUS,
  judgeOrchProgress,
  ORCH_PROGRESS_VERDICT,
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

// ---------------------------------------------------------------------------
// HYK-203 guard/site3 -- isValidDroppedTaskFileEntry(:201)의
// `isFiniteNumber(item.droppedAtMs)` 검사(coder-task.md §1 표 #3).
//
// ★§2 판정 -- 생산자·소비자가 site1/site2(둘 다 orch-stall-detect.mjs
// 안에서 자기 자신이 만든 evidence를 자기 자신이 검사)와 다르다: 여기
// 소비자는 이 파일(pledge-derive-core.mjs, "순수 코어") 자신이고, 생산자는
// 별도 파일(orch-stall-detect.mjs)의 `collectPledgeDerivationEvidence`다.
// 오늘의 유일한 프로덕션 호출자(`runOrchStallDetect`)는 그 생산자가 만든
// evidence만 넘기므로(:1962-1963 실측, 다른 프로덕션 호출자 0 -- grep
// 재확인), droppedAtMs는 오늘도 null 아니면 유한수만 온다(site1/2와 같은
// 근거: buildDroppedTaskFileItem:355가 NaN을 null로 접고 Date.parse는
// Infinity를 만들 수 없다). 그런데도 (나)로 판정하는 이유가 site1/2와
// 다르다 -- 이 코어는 "evidence 자체가 완전히 재구조화(타 소스에서 조립)
// 되어도 형식 위반을 형식 위반으로 계속 접는다"는, 파일 경계를 넘는
// 계약이다(주석 §"evidence 형태" 참조 -- 이 코어는 자신의 유일한 실제
// 호출자를 신뢰하지 않고 매 인자를 구조적으로 재검증한다). isFiniteNumber는
// typeof+Number.isFinite를 한 표현식으로 합쳐 놓아 site1/2처럼 "형제 절"로
// 쪼개 시험할 지점이 없다 -- 이 함수 하나가 전체 여섯 값을 막는다.
// ---------------------------------------------------------------------------
for (const [label, badValue] of [
  ["null", null],
  ["string", "2026-01-01"],
  ["NaN", NaN],
  ["+Infinity", Infinity],
  ["-Infinity", -Infinity],
]) {
  test(`HYK-203 guard/site3: droppedAtMs=${label} -> no pledge fabricated, noted as TASK_FILE_ENTRY_MALFORMED (isFiniteNumber(item.droppedAtMs) blocks it)`, () => {
    const result = derivePledges({
      evidence: {
        droppedTaskFiles: [droppedTaskFileItem({ droppedAtMs: badValue })],
      },
      now: NOW_MS,
    });
    assert.deepEqual(result.pledges, []);
    assert.equal(
      result.notes[0].reasonCode,
      PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_ENTRY_MALFORMED,
    );
  });
}

test("HYK-203 guard/site3: an ordinary finite number droppedAtMs -> derives normally (control: the guard does not over-block valid input)", () => {
  const result = derivePledges({
    evidence: { droppedTaskFiles: [droppedTaskFileItem()] },
    now: NOW_MS,
  });
  assert.equal(result.pledges.length, 1);
  assert.deepEqual(result.notes, []);
});

// ★★필수(coder-task.md §4) -- isValidDroppedTaskFileEntry의 droppedAtMs
// 검사 줄을 지운 상태에서 위 여섯-값 계약이 RED가 되는 것을 고정한다.
// site1(typeof 절 단독)과 달리 여기서는 함수 하나(isFiniteNumber 호출)가
// 통째로 없어지므로, 가드가 없으면 "형식 위반"으로 거부되지 않고
// `deriveAwaitResultPledge`(resultFile.exists:false 분기, recordedAt이
// `item.droppedAtMs`를 직접 쓴다)까지 흘러 들어간다 -- 그 안의
// `new Date(NaN).toISOString()`은 **예외를 던진다**(직접 실측, 아래
// assert.throws가 그대로 재현). site1의 "관측된 차이 0"과 정반대로,
// 여기서는 가드 제거가 순수 코어 전체를 **크래시**시킨다(§"throw로
// 판정을 대신하지 않는다"는 이 코어가 스스로 지키지 못하게 되는
// 지점 -- 이 가드가 바로 그 실패를 막는 마지막 벽이다).
test("NC mutation/HYK-203 site3 (필수 -- 가드 제거): isValidDroppedTaskFileEntry에서 droppedAtMs 검사를 지움 -> RED (NaN droppedAtMs 항목이 '형식 위반'으로 거부되지 않고 deriveAwaitResultPledge까지 흘러가 new Date(NaN).toISOString()에서 예외로 크래시한다)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace("  if (!isFiniteNumber(item.droppedAtMs)) return false;\n", ""),
  );
  assert.throws(
    () =>
      mutant.derivePledges({
        evidence: {
          droppedTaskFiles: [
            droppedTaskFileItem({
              droppedAtMs: NaN,
              resultFile: {
                path: ".harness/coder.md",
                exists: false,
                mtimeMs: null,
              },
            }),
          ],
        },
        now: NOW_MS,
      }),
    /Invalid time value/,
    "mutant must let the structurally invalid (NaN droppedAtMs) entry reach deriveAwaitResultPledge, which crashes on new Date(NaN).toISOString() (RED signal; proves isFiniteNumber(item.droppedAtMs) is load-bearing -- with the guard, this core NEVER throws, per its own fail-closed-not-throw contract)",
  );
});

// 추가 변조 #1(목록 안 -- §1 표의 +Infinity 행을 정확히 재현하는 «그럴듯한
// 실수», HYK-202 #2와 동형): `isFiniteNumber`의 `Number.isFinite`를 하한만
// 있는 부등식(`x > -Infinity`)으로 약화 -- droppedAtMs=+Infinity가
// 구조적으로는 "유효"해진다. ★그런데도 관측 가능한 차이가 0이다: 그
// 값은 `deriveAwaitResultPledge`의 `recordedAtMs > now` 미래-검사에
// 그대로 걸린다(어떤 유한 `now`에 대해서도 `+Infinity > now`는 항상
// 참이다) -- 이 코어가 "미래 시각"과 "+Infinity 시각"을 같은 노트
// (TASK_FILE_RECORDED_AT_IN_FUTURE)로 우연히 이중 방어하고 있다는
// 뜻이다. §4의 "아무 시험도 안 깨지는 변조를 찾으면 그것을 보고하라 --
// 최대 산출이다"에 해당하는 site3의 두 번째 실측(첫 번째는 site1
// 전체가 no-op).
test("NC mutation/HYK-203 site3 추가#1 (목록 안 -- +Infinity만 새는 상한 누락, HYK-202 #2와 동형) -> 관측된 차이 0, no-op 실측: isFiniteNumber를 'x > -Infinity'로 약화해도 +Infinity droppedAtMs는 여전히 미래-검사(recordedAtMs > now)에 걸려 약속이 안 지어진다", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      '  return typeof v === "number" && Number.isFinite(v);\n',
      '  return typeof v === "number" && v > -Infinity;\n',
    ),
  );
  const result = mutant.derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          droppedAtMs: Infinity,
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
  assert.deepEqual(
    result.pledges,
    [],
    "no observed difference: +Infinity droppedAtMs still produces no pledge even with the upper-bound check weakened (the downstream future-check independently blocks it)",
  );
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_RECORDED_AT_IN_FUTURE,
    "blocked by the future-check note, not by TASK_FILE_ENTRY_MALFORMED -- the structural guard itself no longer catches it, but a second, independent guard does",
  );
});

// 추가 변조 #2(★목록 밖 -- 자유 변조, HYK-202 #3과 동형 발상이지만 site3
// 고유의 결과를 낸다): `isFiniteNumber`를 하한 없는 형태
// (`x === x && x < Infinity`, 음의 무한대 누락)로 약화 -- droppedAtMs=
// -Infinity가 구조적으로 "유효"해진다. 이번엔 추가#1과 달리 미래-검사도
// 못 막는다(`-Infinity > now`는 항상 거짓이므로 미래로 오인되지 않는다)
// -- 그래서 그대로 `new Date(-Infinity).toISOString()`까지 흘러가
// 크래시한다(위 필수 RED와 같은 실패 형태, 다른 값·다른 변조로 재현).
test("NC mutation/HYK-203 site3 추가#2 (★목록 밖 -- 자유 변조, 하한 무한대 누락) -> RED: isFiniteNumber를 'x === x && x < Infinity'로 약화하면 -Infinity droppedAtMs가 미래-검사도 통과해(-Infinity > now는 항상 거짓) new Date(-Infinity).toISOString()에서 크래시한다", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      '  return typeof v === "number" && Number.isFinite(v);\n',
      '  return typeof v === "number" && v === v && v < Infinity;\n',
    ),
  );
  assert.throws(
    () =>
      mutant.derivePledges({
        evidence: {
          droppedTaskFiles: [
            droppedTaskFileItem({
              droppedAtMs: -Infinity,
              resultFile: {
                path: ".harness/coder.md",
                exists: false,
                mtimeMs: null,
              },
            }),
          ],
        },
        now: NOW_MS,
      }),
    /Invalid time value/,
    "mutant must let -Infinity slip past BOTH the structural guard and the future-check (RED signal; proves the guard's lower-bound coverage is independently load-bearing, distinct from the upper-bound mutation above)",
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
// HYK-185-residue-rule-2(coder-task.md §3-a/b/c, §R P1-1 반려 수리) --
// «잔재 의심» 규칙. 1R은 이 판정을 orch-progress-core.mjs(판정층)에 넣어
// REVIEW가 반려했다(사람 게이트 의미론 우회). 2R은 이 파일(유도층)로
// 옮겼다 -- 잔재로 판단되면 소비 약속을 **아예 유도하지 않고** notes로만
// 남긴다.
// ---------------------------------------------------------------------------

// (a) 합성 잔재 fixture 1 -- 나이 축. 1단계에서 실제로 지운 잔재와 같은
// 형태(끝난 사이클의 소비 약속이 재드롭 없이 오래 방치됨, 실측 사례 =
// HYK-129-selfcheck-2026-07-30 · QUEUE01-REVIEW-1, coder-task.md §1)를
// 본떴다.
test("(a) synthetic residue #1 (age > 72h default threshold, modeled on the real HYK-129-selfcheck-2026-07-30 residue shape): NOT derived (pledges empty) -- surfaced only via a RESIDUE_SUSPECTED_NOT_DERIVED note, not a fabricated pledge", () => {
  const recordedAtMs = Date.parse("2026-07-30T11:26:00+09:00");
  const now = recordedAtMs + 100 * 3600 * 1000; // 100시간, 72시간 임계 초과
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          taskId: "HYK-129-selfcheck-2026-07-30",
          path: ".harness/verify-task.md",
          resultFile: {
            path: ".harness/verify.md",
            exists: true,
            mtimeMs: recordedAtMs,
          },
          taskIdMismatch: false,
        }),
      ],
    },
    now,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pledges, []);
  assert.equal(result.notes.length, 1);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.RESIDUE_SUSPECTED_NOT_DERIVED,
  );
});

// (a) 합성 잔재 fixture 2 -- 짝 어긋남 축. §1 실측 그대로: 태스크 파일의
// task_id(HYK-167-cycle0-1)와 결과 파일이 echo하는 task_id(HYK-166-coder-2)가
// 다르다. 나이는 임계 밖(2시간, 72시간 미만)이라 나이 축만으로는 잔재로
// 안 걸린다 -- 짝 어긋남 신호가 단독으로 잔재를 유발함을 고정한다.
test("(a) synthetic residue #2 (pair mismatch, exact real shape from coder-task.md §1: coder-task.md task_id=HYK-167-cycle0-1 vs coder.md task_id=HYK-166-coder-2, age only 2h < 72h threshold): NOT derived via taskIdMismatch alone (without age)", () => {
  const recordedAtMs = Date.parse("2026-08-01T10:00:00+09:00");
  const now = recordedAtMs + 2 * 3600 * 1000; // 2시간(72시간엔 한참 못 미침)
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          taskId: "HYK-167-cycle0-1",
          path: ".harness/coder-task.md",
          resultFile: {
            path: ".harness/coder.md",
            exists: true,
            mtimeMs: recordedAtMs,
          },
          taskIdMismatch: true,
        }),
      ],
    },
    now,
  });
  assert.deepEqual(result.pledges, []);
  assert.equal(
    result.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.RESIDUE_SUSPECTED_NOT_DERIVED,
  );
});

// (a) ★1R 반려 P1-1의 직접 수리 -- 잔재는 derivePledges 단계에서 이미
// 걸러지므로, 그 산출물을 그대로 judgeOrchProgress(판정층)에 넘겨도
// STALLED·WAITING_HUMAN_GATE 둘 다 0건이어야 한다(사람 게이트 의미론을
// 우회하지 않는다 -- 새 verdict를 만들지 않았다는 것의 직접 증거).
test("(a) end-to-end: a residue-suppressed derivation, fed into judgeOrchProgress, yields ZERO STALLED and ZERO WAITING_HUMAN_GATE verdicts (the pledge was never derived, so the judge never sees it -- proves P1-1 is fixed, not just relocated)", () => {
  const recordedAtMs = Date.parse("2026-07-30T11:26:00+09:00");
  const now = recordedAtMs + 100 * 3600 * 1000;
  const derivation = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          taskId: "HYK-129-selfcheck-2026-07-30",
          path: ".harness/verify-task.md",
          resultFile: {
            path: ".harness/verify.md",
            exists: true,
            mtimeMs: recordedAtMs,
          },
          taskIdMismatch: false,
        }),
      ],
    },
    now,
  });
  assert.equal(derivation.pledges.length, 0);
  const judged = judgeOrchProgress({
    pledges: derivation.pledges,
    observation: {},
    now,
  });
  assert.equal(judged.verdict, ORCH_PROGRESS_VERDICT.PROGRESSING);
  assert.equal(
    judged.details.perPledge.filter(
      (p) => p.verdict === ORCH_PROGRESS_VERDICT.STALLED,
    ).length,
    0,
  );
  assert.equal(
    judged.details.perPledge.filter(
      (p) => p.verdict === ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE,
    ).length,
    0,
  );
});

// (b) ★안전핀 -- 이 유도층에서도 §6 실제 정지 4건 중 최장(#1, 10시간
// 48분)과 같은 형태(나이 임계 안쪽·짝 어긋남 없음)는 잔재로 오분류되지
// 않고 정상적으로 유도돼야 한다(orch-progress-core.test.mjs의 4건
// fixture는 이 파일과 무관하게 그대로 재사용되며 이 파일은 손대지
// 않는다 -- 이 test는 그와 별개로 "유도층 자체"의 안전핀이다).
test("(b) SAFETY PIN (derivation layer) -- an evidence item shaped like real stall #1 (10h48m old, no pair mismatch) is still normally derived, NOT suppressed as residue", () => {
  const recordedAtMs = Date.parse("2026-08-01T23:06:44+09:00");
  const now = recordedAtMs + (10 * 3600 + 48 * 60) * 1000; // 10h48m < 72h
  const result = derivePledges({
    evidence: {
      droppedTaskFiles: [
        droppedTaskFileItem({
          taskId: "HYK-000-stall1",
          path: ".harness/coder-task.md",
          resultFile: {
            path: ".harness/coder.md",
            exists: true,
            mtimeMs: recordedAtMs,
          },
          taskIdMismatch: false,
        }),
      ],
    },
    now,
  });
  assert.equal(result.pledges.length, 1);
  assert.equal(result.pledges[0].pledgeId, "derived:consume:HYK-000-stall1");
  assert.deepEqual(result.notes, []);
});

// (c) 임계 경계 양방향 -- 정확히 72시간(경계 자체는 아직 잔재 아님, 엄격
// `>`) vs 72시간+1초(잔재).
test("(c) residue age threshold boundary is bidirectional: exactly at 72h -> still derived (not residue), 72h+1s -> NOT derived (residue) (strict >, boundary itself doesn't flip)", () => {
  const recordedAtMs = Date.parse("2026-08-01T00:00:00+09:00");
  const thresholdMs = DEFAULT_RESIDUE_THRESHOLD_SECONDS * 1000;

  const buildEvidence = () => ({
    droppedTaskFiles: [
      droppedTaskFileItem({
        taskId: "HYK-000-boundary",
        path: ".harness/x-task.md",
        resultFile: {
          path: ".harness/x.md",
          exists: true,
          mtimeMs: recordedAtMs,
        },
        taskIdMismatch: false,
      }),
    ],
  });

  const atThreshold = derivePledges({
    evidence: buildEvidence(),
    now: recordedAtMs + thresholdMs,
  });
  assert.equal(
    atThreshold.pledges.length,
    1,
    "exactly at 72h must NOT be residue yet",
  );
  assert.deepEqual(atThreshold.notes, []);

  const pastThreshold = derivePledges({
    evidence: buildEvidence(),
    now: recordedAtMs + thresholdMs + 1000,
  });
  assert.equal(
    pastThreshold.pledges.length,
    0,
    "1s past 72h must flip to residue",
  );
  assert.equal(
    pastThreshold.notes[0].reasonCode,
    PLEDGE_DERIVE_NOTE_REASON.RESIDUE_SUSPECTED_NOT_DERIVED,
  );
});

// residueThresholdSeconds도 기존 thresholdSeconds류 인자와 같은 규약을
// 따른다(생략 시 기본값 · 인자로 조정 가능 · 양수 아니면 ok:false).
test("residueThresholdSeconds: invalid value (0, negative, non-number) -> ok:false, reasonCode RESIDUE_THRESHOLD_INVALID (3/3)", () => {
  for (const bad of [0, -1, "nope"]) {
    const result = derivePledges({
      evidence: {},
      now: NOW_MS,
      residueThresholdSeconds: bad,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      PLEDGE_DERIVE_REASON.RESIDUE_THRESHOLD_INVALID,
    );
  }
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

// HYK-185-residue-rule-2 -- `SRC_COMMITTED`만으로는 부족하다: 이 파일은
// 이전 사이클(gap#61)부터 이미 HEAD에 있었으므로(신규 파일이 아님) 위
// 플래그는 true이지만, 이번 라운드가 새로 추가한 `isResidueSuspected`
// 함수 자체는 아직 커밋 전이라 HEAD 스냅샷에 없을 수 있다 -- 그 상태에서
// mutation을 돌리면 `.replace()`가 매치를 못 찾고 no-op으로 통과해 옛
// 코드를 그대로 시험하는 조용한 오검증이 된다(1R에서 orch-progress-
// core.test.mjs가 실제로 겪은 정확히 그 문제, `.harness/coder.md` §(d)
// 참조). 그래서 이 3개는 HEAD 스냅샷에 실제로 그 함수가 있는지까지
// 확인해 별도로 skip한다.
const SRC_HAS_RESIDUE_RULE =
  SRC_COMMITTED && CORE_SRC.includes("function isResidueSuspected(");
const RESIDUE_RULE_NOT_COMMITTED_SKIP_REASON =
  "isResidueSuspected가 아직 HEAD 추적본에 없다(이번 라운드가 새로 추가했지만 아직 커밋 전) -- SRC_COMMITTED만 보면 pledge-derive-core.mjs 파일 자체는 이전 사이클부터 HEAD에 있어 true로 나오지만, 그 스냅샷에는 이번에 추가한 잔재 규칙 코드가 없어 mutation의 `.replace()`가 매치 대상을 못 찾고 조용히 no-op으로 새어나간다 -- 그래서 SRC_COMMITTED 대신 이 전용 플래그로 막는다. 커밋 후 자동 실행된다(수동 확인은 별도로 `.harness/coder.md`에 임시 클론+커밋 결과를 기록했다).";

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
  // HYK-185-residue-rule-2 -- 이 mutation의 exact-match 대상 문자열은
  // deriveFromDroppedTaskFile/deriveConsumePledge의 시그니처(2R이
  // residueThresholdMs 인자를 추가)에 의존한다. SRC_COMMITTED만 보면
  // 이 파일 자체는 이전 사이클부터 HEAD에 있어 통과하지만, 그 스냅샷은
  // 아직 옛 시그니처라 새 문자열이 매치되지 않는다 -- 전용 가드로 막는다.
  { skip: !SRC_HAS_RESIDUE_RULE && RESIDUE_RULE_NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (item.resultFile.exists === true) {\n    deriveConsumePledge(item, now, pledges, notes, residueThresholdMs);\n    return;\n  }\n  deriveAwaitResultPledge(item, now, pledges, notes);\n",
        "  deriveConsumePledge(item, now, pledges, notes, residueThresholdMs);\n",
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
      // HYK-185-residue-rule-2 -- `mtimeMs:null`이 여기서 `now - 0`(거대한
      // 절대 epoch 값)로 산술 강제돼 잔재 나이 축이 우연히 걸릴 수 있다
      // (이 mutant는 원래 exists-검사를 지운 것이지 잔재 축을 지운 게
      // 아니다 -- 두 축이 섞이지 않도록 잔재 임계를 사실상 무한대로 둬
      // 이 test가 원래 노리는 것(exists 분기 선택)만 격리해 확인한다).
      residueThresholdSeconds: Number.MAX_SAFE_INTEGER,
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
  // HYK-185-residue-rule-2 -- #1과 같은 이유(위 주석 참조)로 전용 가드.
  { skip: !SRC_HAS_RESIDUE_RULE && RESIDUE_RULE_NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (item.resultFile.exists === true) {\n    deriveConsumePledge(item, now, pledges, notes, residueThresholdMs);\n    return;\n  }\n  deriveAwaitResultPledge(item, now, pledges, notes);\n",
        "  if (item.resultFile.exists === true) {\n    deriveConsumePledge(item, now, pledges, notes, residueThresholdMs);\n  }\n",
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

// HYK-185-residue-rule-2(coder-task.md §3-d, 필수 mutation 3종, §R
// "③은 이제 «잔재를 그냥 약속으로 유도해 버리기»(=수리 이전으로 되돌림)")
// -- 아래 3개는 각각 §2-2의 두 축(나이·짝 어긋남)과 "잔재를 유도하지
// 않는다"는 비타협 자체를 하나씩 무력화한다.

test(
  "NC mutation/pledge-derive-core #7 (필수·HYK-185-residue-rule-2): 나이 기준(ㄱ) 제거 -> RED (100시간 방치된 잔재가 여전히 소비 약속으로 유도됨, 잔재로 안 걸러짐)",
  { skip: !SRC_HAS_RESIDUE_RULE && RESIDUE_RULE_NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function isResidueSuspected(item, now, recordedAtMs, residueThresholdMs) {\n  const isAged = now - recordedAtMs > residueThresholdMs;\n  const isPairMismatch = item.taskIdMismatch === true;\n  return isAged || isPairMismatch;\n}",
        "function isResidueSuspected(item, now, recordedAtMs, residueThresholdMs) {\n  const isPairMismatch = item.taskIdMismatch === true;\n  return isPairMismatch;\n}",
      ),
    );
    const recordedAtMs = Date.parse("2026-07-30T11:26:00+09:00");
    const now = recordedAtMs + 100 * 3600 * 1000; // 100시간, 72시간 임계 초과
    const result = mutant.derivePledges({
      evidence: {
        droppedTaskFiles: [
          {
            path: ".harness/verify-task.md",
            taskId: "HYK-129-selfcheck-2026-07-30",
            droppedAtMs: recordedAtMs - 3600_000,
            resultFile: {
              path: ".harness/verify.md",
              exists: true,
              mtimeMs: recordedAtMs,
            },
            taskIdMismatch: false,
          },
        ],
      },
      now,
    });
    assert.equal(
      result.pledges.length,
      1,
      "mutant must fabricate a consume pledge for a 100h-old (>>72h threshold) item (RED signal; proves the age axis alone is load-bearing)",
    );
  },
);

test(
  "NC mutation/pledge-derive-core #8 (필수·HYK-185-residue-rule-2): 짝 어긋남 기준(ㄴ) 제거 -> RED (task_id 에코 불일치가 있어도 소비 약속으로 유도됨)",
  { skip: !SRC_HAS_RESIDUE_RULE && RESIDUE_RULE_NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function isResidueSuspected(item, now, recordedAtMs, residueThresholdMs) {\n  const isAged = now - recordedAtMs > residueThresholdMs;\n  const isPairMismatch = item.taskIdMismatch === true;\n  return isAged || isPairMismatch;\n}",
        "function isResidueSuspected(item, now, recordedAtMs, residueThresholdMs) {\n  const isAged = now - recordedAtMs > residueThresholdMs;\n  return isAged;\n}",
      ),
    );
    const recordedAtMs = Date.parse("2026-08-01T10:00:00+09:00");
    const now = recordedAtMs + 2 * 3600 * 1000; // 2시간, 72시간 임계 미달
    const result = mutant.derivePledges({
      evidence: {
        droppedTaskFiles: [
          {
            path: ".harness/coder-task.md",
            taskId: "HYK-167-cycle0-1",
            droppedAtMs: recordedAtMs - 3600_000,
            resultFile: {
              path: ".harness/coder.md",
              exists: true,
              mtimeMs: recordedAtMs,
            },
            taskIdMismatch: true,
          },
        ],
      },
      now,
    });
    assert.equal(
      result.pledges.length,
      1,
      "mutant must fabricate a consume pledge for a taskId-mismatched pair (age < 72h threshold) (RED signal; proves the pair-mismatch axis alone is load-bearing)",
    );
  },
);

// ★1R 반려 P1-1의 직접 재검증 -- 잔재 억제 자체를 통째로 지우면
// «수리 이전»으로 되돌아가 STALLED가 재발해야 한다(=이 mutation이
// «되돌림»과 동치임을 증명).
test(
  "NC mutation/pledge-derive-core #9 (필수·HYK-185-residue-rule-2): 잔재 억제 분기 전체 제거 -> RED (=수리 이전으로 되돌림, 잔재가 그냥 소비 약속으로 유도되고 판정층에서 STALLED가 재발)",
  { skip: !SRC_HAS_RESIDUE_RULE && RESIDUE_RULE_NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (isResidueSuspected(item, now, recordedAtMs, residueThresholdMs)) {\n    notes.push(\n      note(PLEDGE_DERIVE_NOTE_REASON.RESIDUE_SUSPECTED_NOT_DERIVED, item),\n    );\n    return;\n  }\n",
        "",
      ),
    );
    const recordedAtMs = Date.parse("2026-07-30T11:26:00+09:00");
    const now = recordedAtMs + 100 * 3600 * 1000;
    const result = mutant.derivePledges({
      evidence: {
        droppedTaskFiles: [
          {
            path: ".harness/verify-task.md",
            taskId: "HYK-129-selfcheck-2026-07-30",
            droppedAtMs: recordedAtMs - 3600_000,
            resultFile: {
              path: ".harness/verify.md",
              exists: true,
              mtimeMs: recordedAtMs,
            },
            taskIdMismatch: false,
          },
        ],
      },
      now,
    });
    assert.equal(
      result.pledges.length,
      1,
      "mutant must fabricate a consume pledge from residue evidence (RED signal; proves the residue-suppression branch itself is load-bearing -- removing it is exactly the pre-fix STALLED-forever regression, coder-task.md §R)",
    );
    // 판정층에 넘기면 실제로 STALLED가 재발함을 함께 확인(이 mutation이
    // "수리 이전"과 동치라는 것의 종단 증거).
    const judged = judgeOrchProgress({
      pledges: mutant.derivePledges({
        evidence: {
          droppedTaskFiles: [
            {
              path: ".harness/verify-task.md",
              taskId: "HYK-129-selfcheck-2026-07-30",
              droppedAtMs: recordedAtMs - 3600_000,
              resultFile: {
                path: ".harness/verify.md",
                exists: true,
                mtimeMs: recordedAtMs,
              },
              taskIdMismatch: false,
            },
          ],
        },
        now,
      }).pledges,
      observation: {
        "derived:consume:HYK-129-selfcheck-2026-07-30": {
          collected: true,
          taskFileExists: false,
          droppedAtMs: null,
        },
      },
      now,
    });
    assert.equal(
      judged.verdict,
      ORCH_PROGRESS_VERDICT.STALLED,
      "the fabricated pledge must re-trigger STALLED once judged (RED signal; confirms this mutation is equivalent to reverting the fix, not merely a local no-op)",
    );
  },
);
