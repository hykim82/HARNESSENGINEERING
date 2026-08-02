// HYK-183 C-3 (coder-task.md §6, §3, §10 재작업 1R) -- requery-join-core.mjs
// 계약 시험 (SV-8 후반부: 두 관측이 서로 다른 조회에서 나왔고 이번 소비
// 회차의 것이며, 좌석 증명이 PROVEN이고 좌석 생애(correlation) 판정도
// PROVEN일 때에만 JOINED. 나머지는 전부 NOT_JOINED).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 주장 범위 -- 여기서 만드는 fixture는 전부 손으로 조립한 SYNTHETIC
//    리터럴이다(합성 표적, coder-task.md §2-12). 실제 좌석.실제 원장을
//    이 시험이 접촉하지 않는다.
// 2. 이 스위트가 100% 통과해도 "호출자가 실제로 두 번 조회했다"를
//    증명하지 않는다 -- judgeIndependentRequeryJoin 자신의 헤더 주석과
//    동일한 한계가 그대로 적용된다.
// 3. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeIndependentRequeryJoin,
  REQUERY_JOIN_VERDICT,
  REQUERY_JOIN_REASON,
  CAPTURE_SOURCE,
} from "./requery-join-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();

// §2 비타협 #6 -- 원상복구 단언 준비(raw-preserve-core.test.mjs 선례 그대로).
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// ---------------------------------------------------------------------------
// §6-1 실재 필드 표(자세한 표는 .harness/coder.md) -- 여기서는 그 표가
// 근거하는 정규화 출력 모양을 그대로 fixture로 재현한다.
// normalizeTerminalShow(ok:true) 출력 계약(terminal-show-adapter.mjs).
// normalizeDispatchShow(ok:true) 출력 계약(dispatch-correlation-adapter.mjs).
// judgeDispatchBoundSeatProof 출력 계약(dispatch-bound-seat-proof.mjs) --
// { verdict: "PROVEN"|"UNPROVEN", reasonCode }.
// ---------------------------------------------------------------------------
const TARGET_PANE_KEY =
  "22508fb0-49dc-4bc3-bc01-bc2d4d28399a:69308e19-aa97-40ed-b109-7a3119c0b9d9";

const VALID_TERMINAL_NORMALIZED = Object.freeze({
  ok: true,
  handle: "term_0817fabe-e01a-4cc2-a323-393c3db72409",
  ptyId: "pty_synthetic",
  worktreeId: "wt_synthetic",
  worktreePath: "C:\\synthetic\\worktree",
  tabId: "22508fb0-49dc-4bc3-bc01-bc2d4d28399a",
  leafId: "69308e19-aa97-40ed-b109-7a3119c0b9d9",
  paneKeyFromShow: TARGET_PANE_KEY,
  reasonCode: "VALID",
});

const VALID_DISPATCH_NORMALIZED = Object.freeze({
  ok: true,
  taskId: "task_synthetic",
  dispatchId: "ctx_synthetic",
  assigneePaneKey: TARGET_PANE_KEY,
  reasonCode: "VALID",
  assigneeHandle: "term_0817fabe-e01a-4cc2-a323-393c3db72409",
});

const VALID_SEAT_PROOF = Object.freeze({
  verdict: "PROVEN",
  reasonCode: "PROVEN",
});

// judgeDispatchCorrelation 출력 계약(dispatch-correlation-core.mjs) --
// { verdict: "PROVEN"|"UNPROVEN"|"MISMATCH", reason }. §10 재작업 1R --
// 좌석 생애(종료 전후 뒤섞임) 축을 이 출력에 위임한다.
const VALID_CORRELATION = Object.freeze({
  verdict: "PROVEN",
  reason: "CORRELATION_PROVEN",
});

function buildArgs(overrides = {}) {
  const base = {
    terminal: {
      normalized: VALID_TERMINAL_NORMALIZED,
      capture: {
        queryId: "q-terminal-round1",
        requeryRound: 1,
        source: CAPTURE_SOURCE.TERMINAL_SHOW,
      },
    },
    dispatch: {
      normalized: VALID_DISPATCH_NORMALIZED,
      capture: {
        queryId: "q-dispatch-round1",
        requeryRound: 1,
        source: CAPTURE_SOURCE.DISPATCH_SHOW,
      },
    },
    seatProof: VALID_SEAT_PROOF,
    correlation: VALID_CORRELATION,
    observedPaneKeys: [TARGET_PANE_KEY, "other-tab:other-leaf"],
    expectedRequeryRound: 1,
  };
  return {
    ...base,
    ...overrides,
    terminal: { ...base.terminal, ...(overrides.terminal || {}) },
    dispatch: { ...base.dispatch, ...(overrides.dispatch || {}) },
  };
}

// ---------------------------------------------------------------------------
// (b)(f) 정상 케이스 -- 독립 조회 성질(다른 queryId, 같은 회차, 올바른
// source, 중복 없는 pane, 좌석 증명 PROVEN)을 전부 만족하면 JOINED.
// ---------------------------------------------------------------------------
test("(b) happy path: distinct queryId, matching round, correct source, no duplicate pane, PROVEN seat proof, PROVEN correlation -> ok:true, JOINED, REQUERY_JOINED", () => {
  const result = judgeIndependentRequeryJoin(buildArgs());
  assert.equal(result.ok, true);
  assert.equal(result.verdict, REQUERY_JOIN_VERDICT.JOINED);
  assert.equal(result.reasonCode, REQUERY_JOIN_REASON.REQUERY_JOINED);
  assert.equal(result.seatProofReason, "PROVEN");
  assert.equal(result.correlationReason, "CORRELATION_PROVEN");
});

test("(e) false-positive count is 0 across 3 independently-varied happy-path fixtures (round 1/2/5, expectedRequeryRound matched to each, denominator=3)", () => {
  const fixtures = [1, 2, 5].map((round) =>
    buildArgs({
      terminal: {
        capture: {
          queryId: `q-terminal-r${round}`,
          requeryRound: round,
          source: CAPTURE_SOURCE.TERMINAL_SHOW,
        },
      },
      dispatch: {
        capture: {
          queryId: `q-dispatch-r${round}`,
          requeryRound: round,
          source: CAPTURE_SOURCE.DISPATCH_SHOW,
        },
      },
      expectedRequeryRound: round,
    }),
  );
  const falseNegatives = fixtures.filter(
    (args) =>
      judgeIndependentRequeryJoin(args).verdict !== REQUERY_JOIN_VERDICT.JOINED,
  );
  assert.deepEqual(
    falseNegatives,
    [],
    `denominator=${fixtures.length}, wrongly-rejected=${falseNegatives.length}`,
  );
});

// ---------------------------------------------------------------------------
// §2-10 -- 좌석 증명 실패 사유는 접지 않고 그대로 보존한다(어떤 reasonCode
// 값이 와도 그 문자열 그대로 seatProofReason에 실린다).
// ---------------------------------------------------------------------------
for (const seatProofReasonCode of [
  "PANE_KEY_MISMATCH",
  "HANDLE_MISMATCH",
  "TASK_ID_MISMATCH",
  "DISPATCH_ID_MISMATCH",
  "WORKTREE_MISMATCH",
  "DISPATCH_SHOW_INVALID",
  "TERMINAL_SHOW_INVALID",
  "EXPECTED_FIELDS_MISSING",
]) {
  test(`(g) seat proof failure reason is preserved verbatim, not folded: UNPROVEN/${seatProofReasonCode} -> NOT_JOINED, SEAT_PROOF_UNPROVEN, seatProofReason=${seatProofReasonCode} (denominator=8, exact reason codes from seat-proof-contract-v1.mjs SEAT_PROOF_REASON)`, () => {
    const result = judgeIndependentRequeryJoin(
      buildArgs({
        seatProof: { verdict: "UNPROVEN", reasonCode: seatProofReasonCode },
      }),
    );
    assert.equal(result.verdict, REQUERY_JOIN_VERDICT.NOT_JOINED);
    assert.equal(result.reasonCode, REQUERY_JOIN_REASON.SEAT_PROOF_UNPROVEN);
    assert.equal(result.seatProofReason, seatProofReasonCode);
    // 좌석 증명에서 이미 실패했으므로 correlation 단계에 도달하지 않는다
    // (§10 재작업 1R 판정 순서: 좌석 증명 -> 좌석 생애).
    assert.equal(result.correlationReason, null);
  });
}

// ---------------------------------------------------------------------------
// §10 재작업 1R + §2-10 -- correlation(좌석 생애 축) 실패 사유도 접지 않고
// 그대로 보존한다(dispatch-correlation-core.mjs REASON의 UNPROVEN/MISMATCH
// 6종 전부, CORRELATION_PROVEN 제외).
// ---------------------------------------------------------------------------
for (const [correlationVerdict, correlationReasonCode] of [
  ["UNPROVEN", "ADOPTION_NOT_OBSERVABLE"],
  ["UNPROVEN", "SEAT_RECORD_INCOMPLETE"],
  ["UNPROVEN", "DISPATCH_SHOW_NOT_OK"],
  ["MISMATCH", "INCARNATION_MISMATCH"],
  ["MISMATCH", "REGISTRY_PANE_KEY_MISMATCH"],
  ["MISMATCH", "DISPATCH_PANE_KEY_MISMATCH"],
]) {
  test(`(g) correlation failure reason is preserved verbatim, not folded: ${correlationVerdict}/${correlationReasonCode} -> NOT_JOINED, CORRELATION_NOT_PROVEN, correlationReason=${correlationReasonCode}, seatProofReason still PROVEN (denominator=6, exact reason codes from dispatch-correlation-core.mjs REASON)`, () => {
    const result = judgeIndependentRequeryJoin(
      buildArgs({
        correlation: {
          verdict: correlationVerdict,
          reason: correlationReasonCode,
        },
      }),
    );
    assert.equal(result.verdict, REQUERY_JOIN_VERDICT.NOT_JOINED);
    assert.equal(result.reasonCode, REQUERY_JOIN_REASON.CORRELATION_NOT_PROVEN);
    assert.equal(result.correlationReason, correlationReasonCode);
    // seatProof는 이미 PROVEN을 통과했으므로 그 사유는 그대로 실려 있어야
    // 한다(correlation 실패가 seatProof의 성공 기록을 접지 않는다).
    assert.equal(result.seatProofReason, "PROVEN");
  });
}

// ---------------------------------------------------------------------------
// (c) 반례 전수 -- §6-5가 요구하는 8개 축 + 인자 오류.
// ---------------------------------------------------------------------------
const COUNTEREXAMPLE_FIXTURES = [
  {
    label: "same queryId shared across terminal/dispatch capture",
    args: buildArgs({
      dispatch: {
        capture: {
          queryId: "q-terminal-round1", // terminal과 동일 -- 한 번 조회해 나눠 씀.
          requeryRound: 1,
          source: CAPTURE_SOURCE.DISPATCH_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.SAME_QUERY_SHARED,
  },
  {
    label: "requeryRound mismatch between terminal and dispatch capture",
    args: buildArgs({
      dispatch: {
        capture: {
          queryId: "q-dispatch-round1",
          requeryRound: 2, // terminal은 1.
          source: CAPTURE_SOURCE.DISPATCH_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.REQUERY_ROUND_MISMATCH,
  },
  {
    label: "source mismatch: terminal capture claims dispatch-show",
    args: buildArgs({
      terminal: {
        capture: {
          queryId: "q-terminal-round1",
          requeryRound: 1,
          source: CAPTURE_SOURCE.DISPATCH_SHOW, // 엇갈림.
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.SOURCE_MISMATCH,
  },
  {
    label: "source mismatch: sources swapped entirely",
    args: buildArgs({
      terminal: {
        capture: {
          queryId: "q-terminal-round1",
          requeryRound: 1,
          source: CAPTURE_SOURCE.DISPATCH_SHOW,
        },
      },
      dispatch: {
        capture: {
          queryId: "q-dispatch-round1",
          requeryRound: 1,
          source: CAPTURE_SOURCE.TERMINAL_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.SOURCE_MISMATCH,
  },
  {
    label: "capture missing: terminal.capture.queryId absent",
    args: buildArgs({
      terminal: {
        capture: {
          requeryRound: 1,
          source: CAPTURE_SOURCE.TERMINAL_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.CAPTURE_INCOMPLETE,
  },
  {
    label: "capture missing: dispatch.capture.requeryRound absent",
    args: buildArgs({
      dispatch: {
        capture: {
          queryId: "q-dispatch-round1",
          source: CAPTURE_SOURCE.DISPATCH_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.CAPTURE_INCOMPLETE,
  },
  {
    label: "capture malformed: requeryRound is not a positive integer (0)",
    args: buildArgs({
      terminal: {
        capture: {
          queryId: "q-terminal-round1",
          requeryRound: 0,
          source: CAPTURE_SOURCE.TERMINAL_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.CAPTURE_INCOMPLETE,
  },
  {
    label: "observedPaneKeys missing (undefined)",
    args: buildArgs({ observedPaneKeys: undefined }),
    expectedReason: REQUERY_JOIN_REASON.OBSERVED_PANE_KEYS_MISSING,
  },
  {
    label: "observedPaneKeys not an array (string)",
    args: buildArgs({ observedPaneKeys: TARGET_PANE_KEY }),
    expectedReason: REQUERY_JOIN_REASON.OBSERVED_PANE_KEYS_MISSING,
  },
  {
    label: "duplicate pane: target pane key claimed twice in observedPaneKeys",
    args: buildArgs({
      observedPaneKeys: [TARGET_PANE_KEY, TARGET_PANE_KEY, "x:y"],
    }),
    expectedReason: REQUERY_JOIN_REASON.DUPLICATE_PANE,
  },
  {
    label: "seat proof UNPROVEN (fields missing)",
    args: buildArgs({
      seatProof: { verdict: "UNPROVEN", reasonCode: "EXPECTED_FIELDS_MISSING" },
    }),
    expectedReason: REQUERY_JOIN_REASON.SEAT_PROOF_UNPROVEN,
  },
  {
    label: "seat proof malformed: missing verdict field entirely",
    args: buildArgs({ seatProof: { reasonCode: "PROVEN" } }),
    expectedReason: REQUERY_JOIN_REASON.SEAT_PROOF_INVALID,
  },
  {
    label: "seat proof malformed: not a plain object",
    args: buildArgs({ seatProof: "PROVEN" }),
    expectedReason: REQUERY_JOIN_REASON.SEAT_PROOF_INVALID,
  },
  {
    label: "terminal.normalized.ok is false",
    args: buildArgs({
      terminal: { normalized: { ...VALID_TERMINAL_NORMALIZED, ok: false } },
    }),
    expectedReason: REQUERY_JOIN_REASON.TERMINAL_NORMALIZED_INVALID,
  },
  {
    label: "dispatch.normalized.ok is false",
    args: buildArgs({
      dispatch: { normalized: { ...VALID_DISPATCH_NORMALIZED, ok: false } },
    }),
    expectedReason: REQUERY_JOIN_REASON.DISPATCH_NORMALIZED_INVALID,
  },
  {
    label: "terminal.normalized missing paneKeyFromShow",
    args: buildArgs({
      terminal: {
        normalized: {
          ...VALID_TERMINAL_NORMALIZED,
          paneKeyFromShow: undefined,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.TERMINAL_NORMALIZED_INVALID,
  },
  {
    label: "correlation missing (undefined) -- §10 재작업 1R",
    args: buildArgs({ correlation: undefined }),
    expectedReason: REQUERY_JOIN_REASON.CORRELATION_INVALID,
  },
  {
    label: "correlation malformed: not a plain object -- §10 재작업 1R",
    args: buildArgs({ correlation: "PROVEN" }),
    expectedReason: REQUERY_JOIN_REASON.CORRELATION_INVALID,
  },
  {
    label:
      "correlation malformed: missing verdict field entirely -- §10 재작업 1R",
    args: buildArgs({ correlation: { reason: "CORRELATION_PROVEN" } }),
    expectedReason: REQUERY_JOIN_REASON.CORRELATION_INVALID,
  },
  {
    label:
      "correlation.verdict = MISMATCH (stale incarnation) -- §10 재작업 1R",
    args: buildArgs({
      correlation: { verdict: "MISMATCH", reason: "INCARNATION_MISMATCH" },
    }),
    expectedReason: REQUERY_JOIN_REASON.CORRELATION_NOT_PROVEN,
  },
  {
    // §11 재작업 2R ⓐ -- REVIEW가 실측한 정확한 구멍: expectedRequeryRound=99
    // 인데 양쪽 capture가 서로 일치하는 "1"이라 (mutual round 검사는
    // 통과하고) 과거 회차 쌍이 새어나가던 것. 이제 EXPECTED_REQUERY_ROUND_
    // MISMATCH가 막는다.
    label:
      "expectedRequeryRound=99, both captures agree on stale round 1 (REVIEW P1-1 exact repro) -- §11 재작업 2R",
    args: buildArgs({ expectedRequeryRound: 99 }),
    expectedReason: REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_MISMATCH,
  },
  {
    // §11 재작업 2R ⓑ -- 한쪽만 기대 회차와 일치(다른 쪽은 다름). 이 경우
    // 두 capture도 서로 어긋나므로 우선순위상 REQUERY_ROUND_MISMATCH(상호
    // 불일치)가 먼저 걸린다 -- 그래도 반드시 거부됨(NOT_JOINED)을 확인한다
    // (요구사항 문구 "한쪽만 기대와 일치 → 거부"는 정확한 reasonCode를
    // 지정하지 않는다, 거부 자체만 요구).
    label:
      "only one side matches expectedRequeryRound, the other doesn't -- §11 재작업 2R",
    args: buildArgs({
      expectedRequeryRound: 1,
      dispatch: {
        capture: {
          queryId: "q-dispatch-round1",
          requeryRound: 2, // terminal은 expected(1)와 일치, dispatch는 불일치.
          source: CAPTURE_SOURCE.DISPATCH_SHOW,
        },
      },
    }),
    expectedReason: REQUERY_JOIN_REASON.REQUERY_ROUND_MISMATCH,
  },
  {
    label: "expectedRequeryRound missing (undefined) -- §11 재작업 2R",
    args: buildArgs({ expectedRequeryRound: undefined }),
    expectedReason: REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_INVALID,
  },
  {
    label:
      "expectedRequeryRound malformed: not a positive integer (0) -- §11 재작업 2R",
    args: buildArgs({ expectedRequeryRound: 0 }),
    expectedReason: REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_INVALID,
  },
  {
    label:
      "expectedRequeryRound malformed: not a number (string) -- §11 재작업 2R",
    args: buildArgs({ expectedRequeryRound: "1" }),
    expectedReason: REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_INVALID,
  },
];

// §11 재작업 2R ⓓ -- 셋 다(terminal/dispatch/expectedRequeryRound) 일치하면
// 통과(오탐 0). 분모=3(round 1/7/42로 독립 변주).
test("(f) §11 P1-1-5ⓓ: expectedRequeryRound matches both captures -> JOINED, false-positive count is 0 (round 1/7/42, denominator=3)", () => {
  const rounds = [1, 7, 42];
  const results = rounds.map((round) =>
    judgeIndependentRequeryJoin(
      buildArgs({
        terminal: {
          capture: {
            queryId: "q-terminal-x",
            requeryRound: round,
            source: CAPTURE_SOURCE.TERMINAL_SHOW,
          },
        },
        dispatch: {
          capture: {
            queryId: "q-dispatch-x",
            requeryRound: round,
            source: CAPTURE_SOURCE.DISPATCH_SHOW,
          },
        },
        expectedRequeryRound: round,
      }),
    ),
  );
  const falseNegatives = results.filter(
    (r) => r.verdict !== REQUERY_JOIN_VERDICT.JOINED,
  );
  assert.deepEqual(
    falseNegatives,
    [],
    `denominator=${rounds.length}, wrongly-rejected=${falseNegatives.length}`,
  );
});

for (const { label, args, expectedReason } of COUNTEREXAMPLE_FIXTURES) {
  test(`(c) counterexample: ${label} -> NOT_JOINED/${expectedReason} (denominator: ${COUNTEREXAMPLE_FIXTURES.length})`, () => {
    const result = judgeIndependentRequeryJoin(args);
    assert.equal(result.verdict, REQUERY_JOIN_VERDICT.NOT_JOINED);
    assert.equal(result.reasonCode, expectedReason);
  });
}

test(`(c) false-positive count is 0 across all ${COUNTEREXAMPLE_FIXTURES.length} counterexamples above (none produced JOINED)`, () => {
  const falsePositives = COUNTEREXAMPLE_FIXTURES.filter(
    ({ args }) =>
      judgeIndependentRequeryJoin(args).verdict === REQUERY_JOIN_VERDICT.JOINED,
  );
  assert.deepEqual(
    falsePositives.map((f) => f.label),
    [],
    `denominator=${COUNTEREXAMPLE_FIXTURES.length}, false positives=${falsePositives.length}`,
  );
});

// ---------------------------------------------------------------------------
// fail-closed / INVALID_ARGUMENTS -- 최상위 인자가 이상하면 예외 없이
// ok:false + NOT_JOINED(never JOINED even on invalid shape).
// ---------------------------------------------------------------------------
for (const badArgs of [null, undefined, "args", 42, [], true, {}]) {
  test(`fail-closed: judgeIndependentRequeryJoin(${JSON.stringify(badArgs)}) -> ok:false, NOT_JOINED, INVALID_ARGUMENTS`, () => {
    const result = judgeIndependentRequeryJoin(badArgs);
    assert.equal(result.ok, false);
    assert.equal(result.verdict, REQUERY_JOIN_VERDICT.NOT_JOINED);
    assert.equal(result.reasonCode, REQUERY_JOIN_REASON.INVALID_ARGUMENTS);
    assert.equal(result.seatProofReason, null);
    assert.equal(result.correlationReason, null);
  });
}

// ---------------------------------------------------------------------------
// (a) 순수 함수 -- 결정적, 예외 없음, 입력 불변.
// ---------------------------------------------------------------------------
test("(a) same input twice -> identical result (deterministic, no crash)", () => {
  const input = buildArgs();
  const first = judgeIndependentRequeryJoin(input);
  const second = judgeIndependentRequeryJoin(input);
  assert.deepEqual(first, second);
});

test("purity: judgeIndependentRequeryJoin does not mutate its input", () => {
  const input = buildArgs();
  const clone = JSON.parse(JSON.stringify(input));
  judgeIndependentRequeryJoin(input);
  assert.deepEqual(input, clone);
});

// ---------------------------------------------------------------------------
// (a) 부작용 0 -- 주입된 감시자(spy)로 fs/child_process/네트워크 호출
// 횟수가 0임을 단언한다("안 했다"는 서술이 아니라 호출되지 않았음의 단언,
// raw-preserve-core.test.mjs 선례 그대로).
// ---------------------------------------------------------------------------
test("side effects: fs write-family functions are never invoked while judging any of the above inputs (spied, not merely 'not imported')", () => {
  const watchedFsMethods = [
    "readFile",
    "readFileSync",
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
        throw new Error(
          `unexpected fs.${name} call from judgeIndependentRequeryJoin`,
        );
      }),
    );
  try {
    judgeIndependentRequeryJoin(buildArgs());
    judgeIndependentRequeryJoin(null);
    judgeIndependentRequeryJoin(
      buildArgs({ seatProof: { verdict: "UNPROVEN", reasonCode: "X" } }),
    );
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
          `unexpected child_process.${name} call from judgeIndependentRequeryJoin`,
        );
      }),
    );
  try {
    judgeIndependentRequeryJoin(buildArgs());
    judgeIndependentRequeryJoin(null);
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
        throw new Error(
          "unexpected fetch call from judgeIndependentRequeryJoin",
        );
      })
    : null;
  try {
    judgeIndependentRequeryJoin(buildArgs());
    if (fetchMock) {
      assert.equal(fetchMock.mock.calls.length, 0);
    }
  } finally {
    if (fetchMock) fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// §3(g) 판별력 자동화 -- copy-and-mutate 층(raw-preserve-core.test.mjs
// 선례 재사용). 추적본(git show HEAD:)에서 소스를 읽어 mkdtemp에 변조
// 사본을 쓰고 동적 import()로 불러온다. 신규 파일이라 아직 HEAD에 없으면
// 명시적 사유로 skip한다(커밋 후 자동 실행 -- no-op 아님).
// ---------------------------------------------------------------------------
let REQUERY_JOIN_CORE_SRC = null;
try {
  REQUERY_JOIN_CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/requery-join-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  REQUERY_JOIN_CORE_SRC = null;
}
const SRC_COMMITTED = REQUERY_JOIN_CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "requery-join-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본(이 시험이 `git show HEAD:`로 읽는 스냅샷)에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-requery-join-core-mutant-"));
  const mutated = mutate(REQUERY_JOIN_CORE_SRC);
  const filePath = join(dir, "requery-join-core.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/requery-join-core #1: removing the same-queryId check ('같은 queryId 검사 제거') -> RED (a single query reused for both terminal and dispatch now passes as JOINED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (terminal.capture.queryId === dispatch.capture.queryId) {\n    return REQUERY_JOIN_REASON.SAME_QUERY_SHARED;\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeIndependentRequeryJoin(
      buildArgs({
        dispatch: {
          capture: {
            queryId: "q-terminal-round1", // terminal과 동일.
            requeryRound: 1,
            source: CAPTURE_SOURCE.DISPATCH_SHOW,
          },
        },
      }),
    );
    assert.equal(
      result.verdict,
      "JOINED",
      "mutant must let a shared-queryId pair pass as JOINED (RED signal; proves the same-query guard is load-bearing)",
    );
  },
);

test(
  // §11 재작업 2R P1-2 점검(REVIEW가 #4에서 잡은 것과 같은 성질이 #2에도
  // 있는지) -- **있었다.** expectedRequeryRound(§11 P1-1 신규)가 필수가
  // 된 뒤로는, terminal/dispatch capture가 서로 다른 회차(mutual mismatch)
  // 이면 수학적으로 최소 한쪽은 반드시 expectedRequeryRound와도 다르다
  // (둘 다 같은 expected 값과 일치하면서 서로 다를 수는 없다) -- 그래서
  // REQUERY_ROUND_MISMATCH 검사를 지워도 EXPECTED_REQUERY_ROUND_MISMATCH가
  // 항상 대신 잡아 verdict는 JOINED로 새지 않는다(실측 확인: 아래 fixture로
  // 직접 mutate해 실행하면 NOT_JOINED/EXPECTED_REQUERY_ROUND_MISMATCH가
  // 나온다, JOINED가 아니다). raw-preserve-core.test.mjs의 mutation #1
  // 선례(RAW_MISSING 제거 -> RAW_UNREADABLE로 오분류, PRESERVED로 새지는
  // 않음)와 같은 형태다 -- RED 신호를 "verdict가 JOINED로 샌다"가 아니라
  // "고정 reasonCode 계약이 깨진다"(REQUERY_ROUND_MISMATCH가 나와야 할
  // 자리에 다른 코드가 나옴)로 정확히 다시 정의한다.
  "NC mutation/requery-join-core #2: removing the mutual requeryRound check ('상호 회차 검사 제거') -> RED (a mismatched round pair is misclassified as EXPECTED_REQUERY_ROUND_MISMATCH instead of REQUERY_ROUND_MISMATCH -- breaks the fixed-reasonCode contract even though NOT_JOINED survives via the downstream expectedRequeryRound safety net)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (terminal.capture.requeryRound !== dispatch.capture.requeryRound) {\n    return REQUERY_JOIN_REASON.REQUERY_ROUND_MISMATCH;\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeIndependentRequeryJoin(
      buildArgs({
        dispatch: {
          capture: {
            queryId: "q-dispatch-round1",
            requeryRound: 99, // terminal은 1, expectedRequeryRound도 1.
            source: CAPTURE_SOURCE.DISPATCH_SHOW,
          },
        },
      }),
    );
    assert.notEqual(
      result.verdict,
      "JOINED",
      "mutant must still be rejected (proves the expectedRequeryRound safety net alone is not a substitute for the mutual-mismatch guard's distinct semantics)",
    );
    assert.notEqual(
      result.reasonCode,
      "REQUERY_ROUND_MISMATCH",
      "mutant must fail to classify a mutually-mismatched round pair as REQUERY_ROUND_MISMATCH (RED signal for the mutation; proves the dedicated mutual-mismatch guard is load-bearing for the fixed-reasonCode contract in §5/§11, independent of the downstream expectedRequeryRound safety net)",
    );
  },
);

test(
  "NC mutation/requery-join-core #3: removing the duplicate-pane check ('중복 pane 검사 제거') -> RED (a pane key claimed twice in observedPaneKeys now passes as JOINED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (duplicateCount > 1) return REQUERY_JOIN_REASON.DUPLICATE_PANE;\n",
        "",
      ),
    );
    const result = mutant.judgeIndependentRequeryJoin(
      buildArgs({
        observedPaneKeys: [TARGET_PANE_KEY, TARGET_PANE_KEY, "x:y"],
      }),
    );
    assert.equal(
      result.verdict,
      "JOINED",
      "mutant must let a duplicate-claimed pane pass as JOINED (RED signal; proves the duplicate-pane guard is load-bearing)",
    );
  },
);

test(
  // §11 재작업 2R P1-2 -- REVIEW가 일회용 클론 임시 커밋(`23a7b33`)에서
  // 실측: 원래 fixture(terminal.capture에서 queryId·requeryRound 둘 다
  // 제거)는 requeryRound 결손이 undefined!==1(dispatch)로 REQUERY_ROUND_
  // MISMATCH를 먼저 걸어 이 mutation의 방어(hasCompleteCaptureFields)가
  // 유일한 관문이 아니었다("다른 방어가 대신 막음" -- 헛시험). 고친
  // fixture는 **queryId만** 제거한다 -- requeryRound·source는 정상이고
  // 다른 모든 조건(round·source·pane·seatProof·correlation)도 전부
  // 통과하므로, hasCompleteCaptureFields가 무력화될 때에만 정확히
  // JOINED가 나온다(queryId 결손은 SAME_QUERY_SHARED에도 걸리지 않는다 --
  // undefined !== "q-dispatch-round1"이므로 "같음" 비교가 애초에 거짓).
  "NC mutation/requery-join-core #4: loosening capture-completeness to a default pass ('채취 정보 결손을 기본 통과로 느슨화') -> RED (queryId-only-missing, every other condition valid, now passes as JOINED -- this defense is the sole guard for this exact fixture)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function hasCompleteCaptureFields(capture) {\n  return (\n    isNonEmptyString(capture.queryId) &&\n    isPositiveInteger(capture.requeryRound) &&\n    isNonEmptyString(capture.source)\n  );\n}",
        "function hasCompleteCaptureFields() {\n  return true;\n}",
      ),
    );
    const result = mutant.judgeIndependentRequeryJoin(
      buildArgs({
        terminal: {
          capture: {
            requeryRound: 1,
            source: CAPTURE_SOURCE.TERMINAL_SHOW,
            // queryId 없음 -- 이 fixture의 유일한 결손.
          },
        },
      }),
    );
    assert.equal(
      result.verdict,
      "JOINED",
      "mutant must let a queryId-only-missing capture (every other condition valid) pass as JOINED (RED signal; proves the capture-completeness guard is the sole guard for this fixture, not masked by any other check)",
    );
  },
);

test(
  "NC mutation/requery-join-core #5 (§10 재작업 1R): loosening findCorrelationFailure to always report success -> RED (a stale/mismatched incarnation now passes as JOINED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function findCorrelationFailure(correlation) {\n  const correlationResult = readCorrelationResult(correlation);\n  if (correlationResult === null) {\n    return {\n      failed: true,\n      reasonCode: REQUERY_JOIN_REASON.CORRELATION_INVALID,\n      reason: null,\n    };\n  }\n  if (correlationResult.verdict !== CORRELATION_VERDICT_PROVEN) {\n    return {\n      failed: true,\n      reasonCode: REQUERY_JOIN_REASON.CORRELATION_NOT_PROVEN,\n      reason: correlationResult.reason,\n    };\n  }\n  return { failed: false, reason: correlationResult.reason };\n}",
        "function findCorrelationFailure() {\n  return { failed: false, reason: null };\n}",
      ),
    );
    const result = mutant.judgeIndependentRequeryJoin(
      buildArgs({
        correlation: { verdict: "MISMATCH", reason: "INCARNATION_MISMATCH" },
      }),
    );
    assert.equal(
      result.verdict,
      "JOINED",
      "mutant must let a MISMATCH/stale-incarnation correlation pass as JOINED (RED signal; proves the correlation (seat-lifecycle) guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/requery-join-core #6 (§11 재작업 2R P1-1 신규): removing the expectedRequeryRound check -> RED (a stale-but-mutually-consistent round pair now passes as JOINED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (\n    terminal.capture.requeryRound !== expectedRequeryRound ||\n    dispatch.capture.requeryRound !== expectedRequeryRound\n  ) {\n    return REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_MISMATCH;\n  }\n",
        "",
      ),
    );
    // REVIEW의 정확한 재현: 양쪽 capture는 서로 일치(상호 검사 통과)하지만
    // 기대 회차(99)와는 다른 "1"이다 -- expectedRequeryRound 검사가 이
    // 유일한 관문이다.
    const result = mutant.judgeIndependentRequeryJoin(
      buildArgs({ expectedRequeryRound: 99 }),
    );
    assert.equal(
      result.verdict,
      "JOINED",
      "mutant must let a stale-but-mutually-consistent round pair (both captures agree on round 1 while expectedRequeryRound is 99) pass as JOINED (RED signal; proves the expectedRequeryRound guard is load-bearing, not merely redundant with the mutual-mismatch guard)",
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
    "requery-join-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "requery-join-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
