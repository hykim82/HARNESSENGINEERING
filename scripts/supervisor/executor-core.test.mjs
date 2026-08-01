// HYK-183 A-1 (coder-task.md §5-§7, §11) -- executor-core.mjs 계약 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 주장 범위 -- 여기서 만드는 queueEvaluation은 전부 손으로 조립한
//    SYNTHETIC 리터럴이다. 실제 evaluateQueueManifest(observation)의 반환값이
//    이 형태와 일치하는지는 queue-manifest-core.test.mjs의 몫이지 여기서
//    다시 증명하지 않는다.
// 2. 표본 수와 조건 -- 각 test 이름·§검증 표에 분모를 명시한다.
// 3. 이 스위트가 100% 통과해도 "계획이 옳다"를 증명하지 않는다 -- judgeExecutionPlan
//    자신의 헤더 주석과 동일한 한계가 그대로 적용된다.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeExecutionPlan, EXECUTION_REASON } from "./executor-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();

// §2 비타협 #6 -- 원상복구 단언 준비(시작값 캡처, after()에서 재캡처해 동일
// 단언). "빈 출력"을 요구하지 않는다 -- 시작 시점의 diff/status가 그대로
// 보존됨만 확인한다(nc-review-gate.test.mjs 선례를 그대로 따름).
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function baseEntry(overrides = {}) {
  return {
    issue_id: "HYK-100",
    ordinal: 1,
    approved_merge_commit: "a".repeat(40),
    enabled: true,
    ...overrides,
  };
}

function validQueueEvaluation(overrides = {}) {
  return {
    verdict: "START_ALLOWED",
    reason: "OK",
    entries: [
      baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
      baseEntry({ issue_id: "HYK-101", ordinal: 2 }),
    ],
    ...overrides,
  };
}

function blockedQueueEvaluation(reason) {
  return { verdict: "START_BLOCKED", reason, entries: [] };
}

const NOW = 1_800_000_000_000; // fixed synthetic epoch ms -- Date.now() is never called.

// ---------------------------------------------------------------------------
// positive: exactly 1 plan, false-positive 0 across a denominator of fixtures.
// ---------------------------------------------------------------------------
const POSITIVE_FIXTURES = [
  {
    name: "two enabled entries, ascending ordinal already",
    queueEvaluation: validQueueEvaluation(),
    expectIssueId: "HYK-100",
    expectOrdinal: 1,
  },
  {
    name: "enabled entry is not first in array order (ordinal 5 vs 2)",
    queueEvaluation: validQueueEvaluation({
      entries: [
        baseEntry({ issue_id: "HYK-102", ordinal: 5 }),
        baseEntry({ issue_id: "HYK-101", ordinal: 2 }),
      ],
    }),
    expectIssueId: "HYK-101",
    expectOrdinal: 2,
  },
  {
    name: "one disabled entry ahead of the ready one is skipped",
    queueEvaluation: validQueueEvaluation({
      entries: [
        baseEntry({ issue_id: "HYK-099", ordinal: 0, enabled: false }),
        baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
      ],
    }),
    expectIssueId: "HYK-100",
    expectOrdinal: 1,
  },
  {
    name: "single entry queue",
    queueEvaluation: validQueueEvaluation({
      entries: [baseEntry({ issue_id: "HYK-200", ordinal: 7 })],
    }),
    expectIssueId: "HYK-200",
    expectOrdinal: 7,
  },
];

for (const fixture of POSITIVE_FIXTURES) {
  test(`positive: ${fixture.name} -> exactly 1 plan, ok:true, PLAN_READY (denominator: ${POSITIVE_FIXTURES.length})`, () => {
    const result = judgeExecutionPlan({
      queueEvaluation: fixture.queueEvaluation,
      now: NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, EXECUTION_REASON.PLAN_READY);
    assert.equal(result.queueReason, "OK");
    assert.deepEqual(result.plan, {
      intent: "RUN_ISSUE_CYCLE",
      issueId: fixture.expectIssueId,
      ordinal: fixture.expectOrdinal,
      approvedMergeCommit: "a".repeat(40),
      decidedAt: NOW,
    });
  });
}

test(`positive: false-positive count is 0 across all ${POSITIVE_FIXTURES.length} positive fixtures above (every one produced ok:true)`, () => {
  const falsePositives = POSITIVE_FIXTURES.filter((fixture) => {
    const result = judgeExecutionPlan({
      queueEvaluation: fixture.queueEvaluation,
      now: NOW,
    });
    return result.ok !== true;
  });
  assert.deepEqual(
    falsePositives.map((f) => f.name),
    [],
    `denominator=${POSITIVE_FIXTURES.length}, false positives=${falsePositives.length}`,
  );
});

// ---------------------------------------------------------------------------
// SV-3 반례 3종 -- 큐 정본이 보호 브랜치 exact commit이 아니면 계획 생성 0.
// ---------------------------------------------------------------------------
const SV3_COUNTEREXAMPLES = [
  { label: "dirty checkout", reason: "WORKTREE_DIRTY" },
  {
    label: "local modification (blob hash mismatch)",
    reason: "BLOB_HASH_MISMATCH",
  },
  { label: "unapproved commit", reason: "NOT_HUMAN_APPROVED" },
];
for (const { label, reason } of SV3_COUNTEREXAMPLES) {
  test(`SV-3 counterexample: ${label} (queueEvaluation.reason=${reason}) -> no plan, QUEUE_START_BLOCKED, queueReason preserved`, () => {
    const result = judgeExecutionPlan({
      queueEvaluation: blockedQueueEvaluation(reason),
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan, null);
    assert.equal(result.reasonCode, EXECUTION_REASON.QUEUE_START_BLOCKED);
    assert.equal(result.queueReason, reason);
  });
}

// ---------------------------------------------------------------------------
// SV-4 반례 3종 -- 큐 조작(삭제·순서변경·비승인 추가/변조) 검출 시 정지.
// ---------------------------------------------------------------------------
const SV4_COUNTEREXAMPLES = [
  { label: "append-only removed", reason: "APPEND_ONLY_REMOVED" },
  { label: "append-only reordered", reason: "APPEND_ONLY_REORDERED" },
  { label: "append-only mutated", reason: "APPEND_ONLY_MUTATED" },
];
for (const { label, reason } of SV4_COUNTEREXAMPLES) {
  test(`SV-4 counterexample: ${label} (queueEvaluation.reason=${reason}) -> no plan, QUEUE_START_BLOCKED, queueReason preserved`, () => {
    const result = judgeExecutionPlan({
      queueEvaluation: blockedQueueEvaluation(reason),
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan, null);
    assert.equal(result.reasonCode, EXECUTION_REASON.QUEUE_START_BLOCKED);
    assert.equal(result.queueReason, reason);
  });
}

// ---------------------------------------------------------------------------
// NO_READY_ITEM -- verdict은 START_ALLOWED(reason OK)이지만 고를 활성 항목이
// 없다.
// ---------------------------------------------------------------------------
test("NO_READY_ITEM: START_ALLOWED with empty entries -> no plan, NO_READY_ITEM, queueReason 'OK'", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({ entries: [] }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.plan, null);
  assert.equal(result.reasonCode, EXECUTION_REASON.NO_READY_ITEM);
  assert.equal(result.queueReason, "OK");
});

test("NO_READY_ITEM: START_ALLOWED with only disabled entries -> no plan, NO_READY_ITEM", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({
      entries: [baseEntry({ enabled: false })],
    }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.NO_READY_ITEM);
});

// ---------------------------------------------------------------------------
// fail-closed / INVALID_ARGUMENTS -- 인자가 이상하면 예외 없이 ok:false +
// plan:null.
// ---------------------------------------------------------------------------
for (const badArgs of [null, undefined, "queue", 42, [], true]) {
  test(`fail-closed: judgeExecutionPlan(${JSON.stringify(badArgs)}) -> INVALID_ARGUMENTS`, () => {
    const result = judgeExecutionPlan(badArgs);
    assert.equal(result.ok, false);
    assert.equal(result.plan, null);
    assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
    assert.equal(result.queueReason, null);
  });
}

for (const badNow of [undefined, null, "now", NaN, Infinity, -Infinity]) {
  test(`fail-closed: now=${JSON.stringify(badNow)} -> INVALID_ARGUMENTS`, () => {
    const result = judgeExecutionPlan({
      queueEvaluation: validQueueEvaluation(),
      now: badNow,
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan, null);
    assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
  });
}

for (const badQueueEvaluation of [null, undefined, "x", 1, [], true]) {
  test(`fail-closed: queueEvaluation=${JSON.stringify(badQueueEvaluation)} -> INVALID_ARGUMENTS`, () => {
    const result = judgeExecutionPlan({
      queueEvaluation: badQueueEvaluation,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
  });
}

test("fail-closed: queueEvaluation.verdict is an unrecognized string -> INVALID_ARGUMENTS", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({ verdict: "MAYBE_ALLOWED" }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

test("fail-closed: queueEvaluation.entries is not an array -> INVALID_ARGUMENTS", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({ entries: {} }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

test("fail-closed (tamper detection): verdict START_ALLOWED but reason !== 'OK' -> INVALID_ARGUMENTS (untrusted queueEvaluation)", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({ reason: "WORKTREE_DIRTY" }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

test("fail-closed (tamper detection): verdict START_BLOCKED but reason === 'OK' -> INVALID_ARGUMENTS", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: { verdict: "START_BLOCKED", reason: "OK", entries: [] },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

test("fail-closed (tamper detection): verdict START_BLOCKED but entries is non-empty -> INVALID_ARGUMENTS (core contract says blocked entries are always [])", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: {
      verdict: "START_BLOCKED",
      reason: "WORKTREE_DIRTY",
      entries: [baseEntry()],
    },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

test("fail-closed: a malformed entry (missing approved_merge_commit) inside an otherwise START_ALLOWED evaluation -> INVALID_ARGUMENTS, no crash", () => {
  const entry = baseEntry();
  delete entry.approved_merge_commit;
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({ entries: [entry] }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

test("fail-closed: an entry with wrong-typed 'enabled' (string, not boolean) -> INVALID_ARGUMENTS, no crash", () => {
  const result = judgeExecutionPlan({
    queueEvaluation: validQueueEvaluation({
      entries: [baseEntry({ enabled: "true" })],
    }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, EXECUTION_REASON.INVALID_ARGUMENTS);
});

// ---------------------------------------------------------------------------
// ok:false -> plan은 항상 null(부분 계획 금지) -- 여러 반례에 걸쳐 재확인.
// ---------------------------------------------------------------------------
test("every ok:false result across all negative fixtures above returns plan === null", () => {
  const negativeArgs = [
    { queueEvaluation: blockedQueueEvaluation("WORKTREE_DIRTY"), now: NOW },
    {
      queueEvaluation: blockedQueueEvaluation("APPEND_ONLY_REMOVED"),
      now: NOW,
    },
    { queueEvaluation: validQueueEvaluation({ entries: [] }), now: NOW },
    { queueEvaluation: validQueueEvaluation(), now: "not-a-number" },
    { queueEvaluation: "not-an-object", now: NOW },
  ];
  for (const args of negativeArgs) {
    const result = judgeExecutionPlan(args);
    assert.equal(result.ok, false);
    assert.equal(result.plan, null);
  }
});

// ---------------------------------------------------------------------------
// purity -- 입력 queueEvaluation을 변형하지 않는다.
// ---------------------------------------------------------------------------
test("purity: judgeExecutionPlan does not mutate its input queueEvaluation", () => {
  const qe = validQueueEvaluation();
  const clone = JSON.parse(JSON.stringify(qe));
  judgeExecutionPlan({ queueEvaluation: qe, now: NOW });
  assert.deepEqual(qe, clone);
});

// ---------------------------------------------------------------------------
// §3(a) 부작용 0 -- 주입된 감시자(spy)로 fs/child_process/네트워크 호출 횟수가
// 0임을 단언한다("안 했다"는 서술이 아니라 호출되지 않았음의 단언).
// ---------------------------------------------------------------------------
test("side effects: fs write-family functions are never invoked while judging any of the above inputs (spied, not merely 'not imported')", () => {
  const watchedFsMethods = [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "unlink",
    "unlinkSync",
    "mkdir",
    "mkdirSync",
    "rm",
    "rmSync",
    "rename",
    "renameSync",
  ];
  const mocks = watchedFsMethods
    .filter((name) => typeof fs[name] === "function")
    .map((name) =>
      mock.method(fs, name, () => {
        throw new Error(`unexpected fs.${name} call from judgeExecutionPlan`);
      }),
    );
  try {
    judgeExecutionPlan({ queueEvaluation: validQueueEvaluation(), now: NOW });
    judgeExecutionPlan({
      queueEvaluation: blockedQueueEvaluation("WORKTREE_DIRTY"),
      now: NOW,
    });
    judgeExecutionPlan(null);
    judgeExecutionPlan({
      queueEvaluation: validQueueEvaluation({ entries: [] }),
      now: NOW,
    });
    for (const m of mocks) {
      assert.equal(
        m.mock.calls.length,
        0,
        `expected 0 calls, got ${m.mock.calls.length}`,
      );
    }
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});

test("side effects: child_process spawn-family functions are never invoked (covers 'orca' CLI calls too -- orca is always spawned as a child process)", () => {
  const watchedCpMethods = [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ];
  const mocks = watchedCpMethods
    .filter((name) => typeof child_process[name] === "function")
    .map((name) =>
      mock.method(child_process, name, () => {
        throw new Error(
          `unexpected child_process.${name} call from judgeExecutionPlan`,
        );
      }),
    );
  try {
    judgeExecutionPlan({ queueEvaluation: validQueueEvaluation(), now: NOW });
    judgeExecutionPlan({
      queueEvaluation: blockedQueueEvaluation("APPEND_ONLY_MUTATED"),
      now: NOW,
    });
    for (const m of mocks) {
      assert.equal(
        m.mock.calls.length,
        0,
        `expected 0 calls, got ${m.mock.calls.length}`,
      );
    }
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});

test("side effects: global fetch (network) is never invoked", () => {
  const hasFetch = typeof globalThis.fetch === "function";
  const fetchMock = hasFetch
    ? mock.method(globalThis, "fetch", () => {
        throw new Error("unexpected fetch call from judgeExecutionPlan");
      })
    : null;
  try {
    judgeExecutionPlan({ queueEvaluation: validQueueEvaluation(), now: NOW });
    judgeExecutionPlan({
      queueEvaluation: blockedQueueEvaluation("NOT_HUMAN_APPROVED"),
      now: NOW,
    });
    if (fetchMock) {
      assert.equal(fetchMock.mock.calls.length, 0);
    }
  } finally {
    if (fetchMock) fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// §11 판별력 자동화 -- copy-and-mutate 층(nc-review-gate.test.mjs 선례 재사용).
// 추적본(git show HEAD:)에서 소스를 읽어 mkdtemp에 변조 사본을 쓰고 동적
// import()로 불러온다. 신규 파일이라 아직 HEAD에 없으면 명시적 사유로
// skip한다(커밋 후 자동 실행 -- no-op 아님).
// ---------------------------------------------------------------------------
let EXECUTOR_CORE_SRC = null;
try {
  EXECUTOR_CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/executor-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  EXECUTOR_CORE_SRC = null;
}
const SRC_COMMITTED = EXECUTOR_CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "executor-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본(이 시험이 `git show HEAD:`로 읽는 스냅샷)에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-executor-core-mutant-"));
  const mutated = mutate(EXECUTOR_CORE_SRC);
  const filePath = join(dir, "executor-core.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/executor-core #1: neutralizing the 'verdict !== START_ALLOWED' gate -> RED (a forged START_BLOCKED+entries input now produces a plan)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    // The trustworthiness pre-check also refuses a START_BLOCKED queueEvaluation
    // that carries non-empty entries (the shape a real evaluateQueueManifest
    // never returns) -- that guard has to be neutralized too, or the forged
    // attack fixture below never reaches the main gate at all. Removing both
    // together isolates exactly the defense this mutation targets: "a
    // not-START_ALLOWED verdict must never reach plan selection."
    const mutant = await importMutatedCopy((src) =>
      src
        .replace(
          'if (qe.verdict === "START_BLOCKED" && qe.entries.length !== 0) return false;\n',
          "",
        )
        .replace(
          'if (queueEvaluation.verdict !== "START_ALLOWED") {\n    return blockedByQueue(queueEvaluation.reason);\n  }\n',
          "",
        ),
    );
    const result = mutant.judgeExecutionPlan({
      queueEvaluation: {
        verdict: "START_BLOCKED",
        reason: "WORKTREE_DIRTY",
        entries: [baseEntry()],
      },
      now: NOW,
    });
    assert.equal(
      result.ok,
      true,
      "mutant must produce a plan for a forged START_BLOCKED+entries input (RED signal for the mutation; proves the gate is load-bearing)",
    );
  },
);

test(
  "NC mutation/executor-core #2: replacing preserved queueReason with a fixed literal -> RED (original QUEUE_REASON is lost)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function blockedByQueue(reason) {\n  return {\n    ok: false,\n    plan: null,\n    reasonCode: EXECUTION_REASON.QUEUE_START_BLOCKED,\n    queueReason: reason,\n  };\n}",
        'function blockedByQueue() {\n  return {\n    ok: false,\n    plan: null,\n    reasonCode: EXECUTION_REASON.QUEUE_START_BLOCKED,\n    queueReason: "SOMETHING_WENT_WRONG",\n  };\n}',
      ),
    );
    const result = mutant.judgeExecutionPlan({
      queueEvaluation: blockedQueueEvaluation("APPEND_ONLY_REORDERED"),
      now: NOW,
    });
    assert.notEqual(
      result.queueReason,
      "APPEND_ONLY_REORDERED",
      "mutant must lose the original QUEUE_REASON (RED signal for the mutation; proves queueReason preservation is load-bearing)",
    );
  },
);

test(
  "NC mutation/executor-core #3: removing the 'enabled' filter in selectReadyEntry -> RED (a disabled entry gets selected)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace("    if (entry.enabled !== true) continue;\n", ""),
    );
    const result = mutant.judgeExecutionPlan({
      queueEvaluation: validQueueEvaluation({
        entries: [
          baseEntry({ issue_id: "HYK-DISABLED", ordinal: 0, enabled: false }),
        ],
      }),
      now: NOW,
    });
    assert.equal(
      result.ok,
      true,
      "mutant must select the disabled-only entry (RED signal for the mutation; proves the enabled filter is load-bearing)",
    );
    assert.equal(result.plan.issueId, "HYK-DISABLED");
  },
);

test(
  "NC mutation/executor-core #4: neutralizing the ordinal-minimum selection rule (picks the last entry instead) -> RED (a non-first-active item is selected)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "    if (ready === null || entry.ordinal < ready.ordinal) ready = entry;\n",
        "    ready = entry;\n",
      ),
    );
    const result = mutant.judgeExecutionPlan({
      queueEvaluation: validQueueEvaluation({
        entries: [
          baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
          baseEntry({ issue_id: "HYK-101", ordinal: 2 }),
        ],
      }),
      now: NOW,
    });
    assert.notEqual(
      result.plan.issueId,
      "HYK-100",
      "mutant must select something other than the smallest-ordinal entry (RED signal for the mutation; proves the min-ordinal rule is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언 (§2 비타협 #6).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "executor-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "executor-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
