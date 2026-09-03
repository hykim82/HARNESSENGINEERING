// HYK-185 seat-liveness-1 (coder-task.md §3, §4) -- seat-liveness-core.mjs
// 계약 시험.
//
// 이 계약이 보장하지 않는 것(S11, 코어 헤더와 동일 4가지 -- 여기서는
// 짧게만 반복한다): (1) 두 표본이 각 1건뿐이라 기본 임계 근거가 약하다,
// (2) 이 코어를 부르는 프로덕션 경로가 아직 없다, (3) 화면 축의 한계
// 3가지(§2-2), (4) 감시자 자신이 멈추면 이 축도 함께 멈춘다.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeSeatLiveness,
  SEAT_LIVENESS_VERDICT,
  SEAT_LIVENESS_REASON,
  DEFAULT_MAX_NO_OUTPUT_SECONDS,
  DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS,
} from "./seat-liveness-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

const THRESHOLD_S = 300; // 시험 전용 값(코어 기본값과 무관, 인자로만 넘긴다).

function dispatch(overrides = {}) {
  return {
    dispatchId: "ctx_test",
    dispatchedAtMs: Date.parse("2026-08-04T11:23:00+09:00"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/Date.now are never invoked while judging seat liveness", () => {
  const fsWatched = [
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
    "existsSync",
    "statSync",
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
        throw new Error(`unexpected fs.${n} call from judgeSeatLiveness`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from judgeSeatLiveness`,
        );
      }),
    );
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from judgeSeatLiveness");
  });
  try {
    const d = dispatch();
    judgeSeatLiveness({
      dispatch: d,
      observation: {
        observedAtMs: d.dispatchedAtMs + 1000,
        lastOutputAt: d.dispatchedAtMs + 1000,
        reasonHint: "some screen text",
      },
      now: d.dispatchedAtMs + 2000,
      thresholds: { maxNoOutputSeconds: THRESHOLD_S },
    });
    for (const m of [...fsMocks, ...cpMocks])
      assert.equal(m.mock.calls.length, 0);
    assert.equal(dateNowMock.mock.calls.length, 0);
  } finally {
    for (const m of [...fsMocks, ...cpMocks]) m.mock.restore();
    dateNowMock.mock.restore();
  }
});

const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "seat-liveness-core.mjs"),
  "utf8",
);
test("static: seat-liveness-core.mjs has zero import statements (no I/O surface at all)", () => {
  const imports = [
    ...SRC_TEXT.matchAll(/^import[\s\S]*?from\s+["'](.+)["'];?\s*$/gm),
  ];
  assert.deepEqual(imports, []);
});

test("static: seat-liveness-core.mjs never uses reasonHint (screen text) in judgment logic -- only in the details passthrough line", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  const reasonHintLines = codeOnly
    .split("\n")
    .filter((l) => l.includes("reasonHint"));
  // 딱 두 곳만 허용: 구조분해(destructure)와 details로 그대로 옮기는 줄.
  for (const line of reasonHintLines) {
    const isDestructure = /const\s*\{[^}]*reasonHint[^}]*\}/.test(line);
    const isPassthrough =
      /reasonHint:\s*reasonHint === undefined \? null : reasonHint/.test(line);
    assert.equal(
      isDestructure || isPassthrough,
      true,
      `reasonHint must only appear in destructuring or the details passthrough, found: ${line}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) 닫힌 3상태 + fail-closed.
// ---------------------------------------------------------------------------
test("closed 3-state: verdict is always one of RESPONSIVE/SUSPECTED_UNRESPONSIVE/UNDECIDABLE (4/4 arbitrary inputs)", () => {
  const closedSet = new Set(Object.values(SEAT_LIVENESS_VERDICT));
  assert.deepEqual(
    [...closedSet].sort(),
    ["RESPONSIVE", "SUSPECTED_UNRESPONSIVE", "UNDECIDABLE"].sort(),
  );
  const d = dispatch();
  const cases = [
    undefined,
    null,
    {},
    {
      dispatch: d,
      observation: {
        observedAtMs: d.dispatchedAtMs + 1,
        lastOutputAt: d.dispatchedAtMs + 1,
      },
      now: d.dispatchedAtMs + 1,
    },
  ];
  for (const c of cases) {
    const result = judgeSeatLiveness(c);
    assert.equal(
      closedSet.has(result.verdict),
      true,
      `unexpected verdict ${result.verdict} for ${JSON.stringify(c)}`,
    );
  }
});

test("fail-closed: args/dispatch/now/threshold/observation malformed never throw, always UNDECIDABLE (7/7)", () => {
  const d = dispatch();
  const cases = [
    undefined,
    null,
    "not-an-object",
    { dispatch: null, observation: {}, now: 1 },
    { dispatch: d, observation: {}, now: "not-a-number" },
    {
      dispatch: d,
      observation: {
        observedAtMs: d.dispatchedAtMs + 1,
        lastOutputAt: d.dispatchedAtMs + 1,
      },
      now: d.dispatchedAtMs + 1,
      thresholds: { maxNoOutputSeconds: -1 },
    },
    { dispatch: d, observation: "not-an-object", now: d.dispatchedAtMs + 1 },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => {
      const result = judgeSeatLiveness(c);
      assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.UNDECIDABLE);
    });
  }
});

// ---------------------------------------------------------------------------
// (b)★ 오늘 실제 사고 fixture: 배달 11:23 -> 무출력 시작 11:36 -> 발견
// 12:04(약 28분 갇힘). 출처: coder-task.md §1.
// ---------------------------------------------------------------------------
const REAL_STALL_DISPATCHED_AT = Date.parse("2026-08-04T11:23:00+09:00");
const REAL_STALL_FROZEN_OUTPUT_AT = Date.parse("2026-08-04T11:36:00+09:00");
const REAL_STALL_DISCOVERED_AT = Date.parse("2026-08-04T12:04:00+09:00");

test("(b) real 2026-08-04 ~28min stall fixture (dispatch 11:23 / frozen output 11:36 / discovered 12:04) -> SUSPECTED_UNRESPONSIVE", () => {
  const result = judgeSeatLiveness({
    dispatch: dispatch({ dispatchedAtMs: REAL_STALL_DISPATCHED_AT }),
    observation: {
      observedAtMs: REAL_STALL_DISCOVERED_AT,
      lastOutputAt: REAL_STALL_FROZEN_OUTPUT_AT,
      reasonHint: "Dangerous rm operation on critical path: /tmp_newblock.mjs",
    },
    now: REAL_STALL_DISCOVERED_AT,
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
  assert.equal(
    result.reasonCode,
    SEAT_LIVENESS_REASON.NO_OUTPUT_PAST_THRESHOLD,
  );
});

test("(b)★ the real stall fixture must already have crossed the threshold BEFORE the human discovered it at 12:04 -- earliest crossing instant is strictly earlier than discovery", () => {
  const thresholdMs = DEFAULT_MAX_NO_OUTPUT_SECONDS * 1000;
  const earliestCrossingMs = REAL_STALL_FROZEN_OUTPUT_AT + thresholdMs + 1;
  assert.ok(
    earliestCrossingMs < REAL_STALL_DISCOVERED_AT,
    "default threshold must fire before the 28-minute mark where the human actually noticed",
  );
  const result = judgeSeatLiveness({
    dispatch: dispatch({ dispatchedAtMs: REAL_STALL_DISPATCHED_AT }),
    observation: {
      observedAtMs: earliestCrossingMs,
      lastOutputAt: REAL_STALL_FROZEN_OUTPUT_AT,
    },
    now: earliestCrossingMs,
    // thresholds 생략 -- 기본값으로 판정.
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
});

// ---------------------------------------------------------------------------
// (c)★ 오늘 정상 사례: codex 좌석이 정상 작업 중 약 15분 침묵 -> 오탐 0.
// ---------------------------------------------------------------------------
test("(c) real 2026-08-04 normal 15-minute silence during active work (codex seat) -> RESPONSIVE, never SUSPECTED_UNRESPONSIVE", () => {
  const dispatchedAt = Date.parse("2026-08-04T09:00:00+09:00");
  const lastOutputAt = Date.parse("2026-08-04T09:10:00+09:00");
  const observedAt = Date.parse("2026-08-04T09:25:00+09:00"); // +15min silence.
  const result = judgeSeatLiveness({
    dispatch: dispatch({ dispatchedAtMs: dispatchedAt }),
    observation: { observedAtMs: observedAt, lastOutputAt },
    now: observedAt,
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.RESPONSIVE);
  assert.notEqual(result.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
});

test("(c)★ the two real samples straddle the default threshold: 15min normal < threshold < 28min real stall", () => {
  const thresholdS = DEFAULT_MAX_NO_OUTPUT_SECONDS;
  assert.ok(
    15 * 60 < thresholdS,
    "15min normal silence must be below threshold",
  );
  assert.ok(thresholdS < 28 * 60, "28min real stall must be above threshold");
});

// ---------------------------------------------------------------------------
// (d) 배달 전 침묵은 무응답이 아니다 -- 기준선(배달 시각) 적용.
// ---------------------------------------------------------------------------
test("(d) pre-dispatch silence is never SUSPECTED_UNRESPONSIVE -- stale lastOutputAt from before dispatch is anchored to dispatch time, not itself", () => {
  const dispatchedAt = Date.parse("2026-08-04T11:23:00+09:00");
  // 마지막 출력이 배달 1시간 전(오래됨)이지만, 아직 배달 뒤 얼마 안
  // 지났다 -- 정상적인 초기 침묵이어야 한다.
  const staleLastOutputAt = dispatchedAt - 60 * 60 * 1000;
  const observedAt = dispatchedAt + 5000;
  const result = judgeSeatLiveness({
    dispatch: dispatch({ dispatchedAtMs: dispatchedAt }),
    observation: { observedAtMs: observedAt, lastOutputAt: staleLastOutputAt },
    now: observedAt,
    thresholds: { maxNoOutputSeconds: THRESHOLD_S },
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.RESPONSIVE);
  assert.equal(result.details.referencePointMs, dispatchedAt);
});

test("(d) an observation timestamped before dispatch is rejected as UNDECIDABLE, never judged -- pre-baseline silence produces no verdict", () => {
  const dispatchedAt = Date.parse("2026-08-04T11:23:00+09:00");
  const result = judgeSeatLiveness({
    dispatch: dispatch({ dispatchedAtMs: dispatchedAt }),
    observation: {
      observedAtMs: dispatchedAt - 1000,
      lastOutputAt: dispatchedAt - 2000,
    },
    now: dispatchedAt,
    thresholds: { maxNoOutputSeconds: THRESHOLD_S },
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.UNDECIDABLE);
  assert.equal(
    result.reasonCode,
    SEAT_LIVENESS_REASON.OBSERVATION_BEFORE_DISPATCH,
  );
});

// ---------------------------------------------------------------------------
// (e) 화면 텍스트는 판정에 쓰이지 않는다 -- 같은 시간 관측, 다른 문자열
// -> 동일 판정.
// ---------------------------------------------------------------------------
test("(e) screen text (reasonHint) never changes the verdict -- identical time observations with different screen strings agree (3/3 pairs)", () => {
  const d = dispatch();
  const pairs = [
    // 정상 구간.
    {
      observedAtMs: d.dispatchedAtMs + 1000,
      lastOutputAt: d.dispatchedAtMs + 1000,
    },
    // 임계 지남.
    {
      observedAtMs: d.dispatchedAtMs + THRESHOLD_S * 1000 + 60_000,
      lastOutputAt: d.dispatchedAtMs + 1000,
    },
    // 미지정(undefined) reasonHint까지 포함.
    {
      observedAtMs: d.dispatchedAtMs + 2000,
      lastOutputAt: d.dispatchedAtMs + 2000,
    },
  ];
  const screenStrings = [
    "Dangerous rm operation on critical path: /tmp_newblock.mjs",
    "완전히 다른 화면 문구 -- 승인 대기 없음",
    "",
  ];
  for (const base of pairs) {
    const withA = judgeSeatLiveness({
      dispatch: d,
      observation: { ...base, reasonHint: screenStrings[0] },
      now: base.observedAtMs,
      thresholds: { maxNoOutputSeconds: THRESHOLD_S },
    });
    const withB = judgeSeatLiveness({
      dispatch: d,
      observation: { ...base, reasonHint: screenStrings[1] },
      now: base.observedAtMs,
      thresholds: { maxNoOutputSeconds: THRESHOLD_S },
    });
    const withNone = judgeSeatLiveness({
      dispatch: d,
      observation: { ...base },
      now: base.observedAtMs,
      thresholds: { maxNoOutputSeconds: THRESHOLD_S },
    });
    assert.equal(withA.verdict, withB.verdict);
    assert.equal(withA.reasonCode, withB.reasonCode);
    assert.equal(withA.verdict, withNone.verdict);
    assert.equal(withA.reasonCode, withNone.reasonCode);
  }
});

// ---------------------------------------------------------------------------
// (e-지속) 관측 결손·형식 위반·순서 역전·미래 시각 -> 전부 UNDECIDABLE.
// ---------------------------------------------------------------------------
test("missing/malformed/reversed-order/future observations never leak into SUSPECTED_UNRESPONSIVE or RESPONSIVE (6/6)", () => {
  const d = dispatch();
  const cases = [
    // 관측 자체가 없음.
    { dispatch: d, observation: undefined, now: d.dispatchedAtMs + 1000 },
    // 형식 위반: lastOutputAt 결손.
    {
      dispatch: d,
      observation: { observedAtMs: d.dispatchedAtMs + 1000 },
      now: d.dispatchedAtMs + 1000,
    },
    // 형식 위반: lastOutputAt이 관측 시각보다 «허용치를 훨씬 넘겨»
    // 미래(구조적 모순) -- HYK-421 1R로 바쁜 좌석의 정상 왕복(수백 ms)은
    // DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS(5000ms) 이내로 통과하므로
    // 이 표본은 그 허용치를 자릿수로 넘는 10분 뒤로 둬 "진짜 malformed"임을
    // 분명히 한다(coder-task.md §2 요구3 ⓑ).
    {
      dispatch: d,
      observation: {
        observedAtMs: d.dispatchedAtMs + 1000,
        lastOutputAt: d.dispatchedAtMs + 1000 + 600_000,
      },
      now: d.dispatchedAtMs + 1000 + 600_000,
    },
    // 순서 역전: 관측이 배달보다 이르다(위 (d) 테스트와 다른 각도).
    {
      dispatch: d,
      observation: {
        observedAtMs: d.dispatchedAtMs - 5000,
        lastOutputAt: d.dispatchedAtMs - 5000,
      },
      now: d.dispatchedAtMs,
    },
    // 미래 시각: 관측 시각이 now보다 나중.
    {
      dispatch: d,
      observation: {
        observedAtMs: d.dispatchedAtMs + 10_000,
        lastOutputAt: d.dispatchedAtMs + 10_000,
      },
      now: d.dispatchedAtMs + 1000,
    },
    // 배달 자체가 형식 위반.
    {
      dispatch: { dispatchId: "x" },
      observation: {
        observedAtMs: d.dispatchedAtMs + 1000,
        lastOutputAt: d.dispatchedAtMs + 1000,
      },
      now: d.dispatchedAtMs + 1000,
    },
  ];
  for (const c of cases) {
    const result = judgeSeatLiveness(c);
    assert.equal(
      result.verdict,
      SEAT_LIVENESS_VERDICT.UNDECIDABLE,
      `expected UNDECIDABLE for ${JSON.stringify(c)}, got ${result.verdict}`,
    );
  }
});

test("default threshold: DEFAULT_MAX_NO_OUTPUT_SECONDS is a positive finite number used when thresholds omitted (1/1)", () => {
  assert.equal(typeof DEFAULT_MAX_NO_OUTPUT_SECONDS, "number");
  assert.ok(DEFAULT_MAX_NO_OUTPUT_SECONDS > 0);
  const d = dispatch();
  const result = judgeSeatLiveness({
    dispatch: d,
    observation: {
      observedAtMs: d.dispatchedAtMs + 1000,
      lastOutputAt: d.dispatchedAtMs + 1000,
    },
    now: d.dispatchedAtMs + 1000,
    // thresholds 생략.
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.RESPONSIVE);
});

// ---------------------------------------------------------------------------
// HYK-421 1R (결함 1 -- 시계 선후, coder-task.md §2 요구3): 합성 표본
// 4종이 서로 다른 결과를 내야 한다 -- ⓐ바쁜 좌석(정상 판정) ⓑ진짜
// malformed(여전히 거부) ⓒ정상 유휴(정상) ⓓ대상 없음(무대상, 이 파일
// 수준에서는 dispatch 자체가 없는 것과 동형이라 여기서는 다루지 않는다
// -- ⓓ는 orch-stall-detect.mjs의 NOT_APPLICABLE 경로, 결함 2 시험에서
// 다룬다).
// ---------------------------------------------------------------------------
test("HYK-421 1R ⓐ 바쁜 좌석: lastOutputAt이 observedAtMs보다 실측 왕복시간(170~264ms) 만큼 뒤여도 UNDECIDABLE이 아니라 정상 판정된다 (수리 전 실사고 재현: 재현 3/3, +170/+192/+264ms)", () => {
  const d = dispatch();
  const busySamplesMs = [170, 192, 264];
  for (const gapMs of busySamplesMs) {
    const observedAtMs = d.dispatchedAtMs + 1000;
    const result = judgeSeatLiveness({
      dispatch: d,
      observation: {
        observedAtMs,
        lastOutputAt: observedAtMs + gapMs,
      },
      now: observedAtMs + gapMs, // 판정 시각도 왕복 뒤로 자연스럽게 흘러간다.
    });
    assert.notEqual(
      result.verdict,
      SEAT_LIVENESS_VERDICT.UNDECIDABLE,
      `busy-seat gap ${gapMs}ms must not be misjudged as UNDECIDABLE`,
    );
    assert.equal(
      result.verdict,
      SEAT_LIVENESS_VERDICT.RESPONSIVE,
      `busy-seat gap ${gapMs}ms is well within threshold -- must be RESPONSIVE`,
    );
    assert.notEqual(
      result.reasonCode,
      SEAT_LIVENESS_REASON.OBSERVATION_MALFORMED,
      `busy-seat gap ${gapMs}ms must not trip the structural-order guard`,
    );
  }
});

test("HYK-421 1R ⓑ 진짜 malformed: 허용치(DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS)를 자릿수로 넘는 시각 역전은 여전히 OBSERVATION_MALFORMED로 거부된다 (구조 검사 생존 증명)", () => {
  const d = dispatch();
  const observedAtMs = d.dispatchedAtMs + 1000;
  const genuinelyMalformedGapMs =
    DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS + 10 * 60 * 1000; // 허용치 + 10분.
  const result = judgeSeatLiveness({
    dispatch: d,
    observation: {
      observedAtMs,
      lastOutputAt: observedAtMs + genuinelyMalformedGapMs,
    },
    now: observedAtMs + genuinelyMalformedGapMs,
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, SEAT_LIVENESS_REASON.OBSERVATION_MALFORMED);
});

test("HYK-421 1R: 허용치 경계값 -- 정확히 허용치만큼 뒤는 통과(<=), 허용치+1ms는 거부", () => {
  const d = dispatch();
  const observedAtMs = d.dispatchedAtMs + 1000;
  const atBoundary = judgeSeatLiveness({
    dispatch: d,
    observation: {
      observedAtMs,
      lastOutputAt: observedAtMs + DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS,
    },
    now: observedAtMs + DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS,
  });
  assert.notEqual(
    atBoundary.reasonCode,
    SEAT_LIVENESS_REASON.OBSERVATION_MALFORMED,
  );

  const overBoundary = judgeSeatLiveness({
    dispatch: d,
    observation: {
      observedAtMs,
      lastOutputAt:
        observedAtMs + DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS + 1,
    },
    now: observedAtMs + DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS + 1,
  });
  assert.equal(
    overBoundary.reasonCode,
    SEAT_LIVENESS_REASON.OBSERVATION_MALFORMED,
  );
});

test("HYK-421 1R: thresholds.observationClockSkewToleranceMs를 명시적으로 넘기면 그 값을 쓴다 (0으로 좁히면 예전 동작 -- 왕복 264ms도 다시 MALFORMED)", () => {
  const d = dispatch();
  const observedAtMs = d.dispatchedAtMs + 1000;
  const result = judgeSeatLiveness({
    dispatch: d,
    observation: {
      observedAtMs,
      lastOutputAt: observedAtMs + 264,
    },
    now: observedAtMs + 264,
    thresholds: {
      maxNoOutputSeconds: THRESHOLD_S,
      observationClockSkewToleranceMs: 0,
    },
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, SEAT_LIVENESS_REASON.OBSERVATION_MALFORMED);
});

test("HYK-421 1R: 음수 observationClockSkewToleranceMs는 THRESHOLD_INVALID로 거부된다 (예외가 아니라 UNDECIDABLE)", () => {
  const d = dispatch();
  const result = judgeSeatLiveness({
    dispatch: d,
    observation: {
      observedAtMs: d.dispatchedAtMs + 1000,
      lastOutputAt: d.dispatchedAtMs + 1000,
    },
    now: d.dispatchedAtMs + 1000,
    thresholds: {
      maxNoOutputSeconds: THRESHOLD_S,
      observationClockSkewToleranceMs: -1,
    },
  });
  assert.equal(result.verdict, SEAT_LIVENESS_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, SEAT_LIVENESS_REASON.THRESHOLD_INVALID);
});

// ---------------------------------------------------------------------------
// (f) 판별력 자동화 -- copy-and-mutate. 신규 파일이라 아직 HEAD에 없으면
// 명시적 사유로 skip한다(커밋 후 자동 해제, dispatch-start-core.test.mjs
// 선례와 동일 형태).
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/seat-liveness-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "seat-liveness-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- either the target string is stale (doesn't match the real implementation) or it's ambiguous (matches more than one spot)`,
  );
  return src.replace(find, replacement);
}

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-seat-liveness-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "seat-liveness-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/seat-liveness-core #1 (필수): 시간 임계 비교 제거 -> RED (오늘 실제 사고가 RESPONSIVE로 오판됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  const pastThreshold = elapsedMs > thresholdMs;",
        "  const pastThreshold = false;",
      ),
    );
    const result = mutant.judgeSeatLiveness({
      dispatch: dispatch({ dispatchedAtMs: REAL_STALL_DISPATCHED_AT }),
      observation: {
        observedAtMs: REAL_STALL_DISCOVERED_AT,
        lastOutputAt: REAL_STALL_FROZEN_OUTPUT_AT,
      },
      now: REAL_STALL_DISCOVERED_AT,
    });
    assert.equal(
      result.verdict,
      "RESPONSIVE",
      "mutant must misjudge the real 28-minute stall as RESPONSIVE (RED signal; proves the time-threshold comparison is load-bearing)",
    );
  },
);

test(
  "NC mutation/seat-liveness-core #2 (필수): 배달 기준선 무시(max 제거, lastOutputAt만 사용) -> RED (배달 전 정상 초기 침묵이 무응답으로 오판됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  const referencePointMs = Math.max(lastOutputAt, dispatchedAtMs);",
        "  const referencePointMs = lastOutputAt;",
      ),
    );
    const dispatchedAt = Date.parse("2026-08-04T11:23:00+09:00");
    const staleLastOutputAt = dispatchedAt - 60 * 60 * 1000; // 배달 1시간 전.
    const observedAt = dispatchedAt + 5000; // 배달 직후, 정상 초기 침묵.
    const result = mutant.judgeSeatLiveness({
      dispatch: dispatch({ dispatchedAtMs: dispatchedAt }),
      observation: {
        observedAtMs: observedAt,
        lastOutputAt: staleLastOutputAt,
      },
      now: observedAt,
      thresholds: { maxNoOutputSeconds: THRESHOLD_S },
    });
    assert.equal(
      result.verdict,
      "SUSPECTED_UNRESPONSIVE",
      "mutant must misjudge normal pre-dispatch-stale-output silence as SUSPECTED_UNRESPONSIVE (RED signal; proves the dispatch baseline is load-bearing)",
    );
  },
);

test(
  "NC mutation/seat-liveness-core #3 (필수): 화면 텍스트를 판정에 사용(특정 reasonHint면 항상 SUSPECTED_UNRESPONSIVE) -> RED (같은 시간 관측이 문구만으로 다르게 판정됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  const pastThreshold = elapsedMs > thresholdMs;",
        '  const pastThreshold = elapsedMs > thresholdMs || reasonHint === "Dangerous";',
      ),
    );
    const d = dispatch();
    const base = {
      observedAtMs: d.dispatchedAtMs + 1000,
      lastOutputAt: d.dispatchedAtMs + 1000,
    };
    const result = mutant.judgeSeatLiveness({
      dispatch: d,
      observation: { ...base, reasonHint: "Dangerous" },
      now: base.observedAtMs,
      thresholds: { maxNoOutputSeconds: THRESHOLD_S },
    });
    assert.equal(
      result.verdict,
      "SUSPECTED_UNRESPONSIVE",
      "mutant must let screen text alone flip a normal in-threshold observation to SUSPECTED_UNRESPONSIVE (RED signal; proves screen text is correctly excluded from judgment in the real core)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #5).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "seat-liveness-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "seat-liveness-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
