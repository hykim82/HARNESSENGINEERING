// HYK-185 startcheck (coder-task.md §7, §3) -- dispatch-start-core.mjs
// 계약 시험.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 이 스위트가 100% 통과해도 "실제 좌석이 실제로 시작됐다"를 증명하지
//    않는다 -- 이 코어는 주입된 `observations`만 판정한다(실제 조회는
//    이 코어 밖, A-5).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeDispatchStart,
  DISPATCH_START_VERDICT,
  DISPATCH_START_REASON,
  DEFAULT_MIN_NO_PROGRESS_SECONDS,
} from "./dispatch-start-core.mjs";

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

const DISPATCHED_AT_MS = Date.parse("2026-08-02T11:56:32+09:00");
const THRESHOLD_S = 300; // 시험 전용 값(코어 기본값과 무관, 인자로만 넘긴다).

function dispatch(overrides = {}) {
  return {
    dispatchId: "ctx_test",
    dispatchedAtMs: DISPATCHED_AT_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/Date.now are never invoked while judging dispatch start", () => {
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
        throw new Error(`unexpected fs.${n} call from judgeDispatchStart`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from judgeDispatchStart`,
        );
      }),
    );
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from judgeDispatchStart");
  });
  try {
    judgeDispatchStart({
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS + 1000,
          lastOutputAt: DISPATCHED_AT_MS + 1000,
        },
        {
          observedAtMs: DISPATCHED_AT_MS + 2000,
          lastOutputAt: DISPATCHED_AT_MS + 2000,
        },
      ],
      now: DISPATCHED_AT_MS + 2000,
      thresholds: { minNoProgressSeconds: THRESHOLD_S },
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
  join(ROOT, "scripts", "supervisor", "dispatch-start-core.mjs"),
  "utf8",
);
test("static: dispatch-start-core.mjs has zero import statements (no I/O surface at all)", () => {
  const imports = [
    ...SRC_TEXT.matchAll(/^import[\s\S]*?from\s+["'](.+)["'];?\s*$/gm),
  ];
  assert.deepEqual(imports, []);
});

test("static: dispatch-start-core.mjs never reads screen strings (preview/title) as judgment input", () => {
  assert.equal(/\bpreview\b/.test(SRC_TEXT.replace(/\/\/.*$/gm, "")), false);
  assert.equal(/\btitle\b/.test(SRC_TEXT.replace(/\/\/.*$/gm, "")), false);
});

test("static: dispatch-start-core.mjs never reads dispatch.injected as judgment input", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  assert.equal(/\.injected\b/.test(codeOnly), false);
  assert.equal(/dispatch\[.injected.\]/.test(codeOnly), false);
});

// ---------------------------------------------------------------------------
// (b) 닫힌 3상태.
// ---------------------------------------------------------------------------
test("closed 3-state: verdict is always one of STARTED/NOT_STARTED/UNDECIDABLE (5/5 arbitrary inputs)", () => {
  const closedSet = new Set(Object.values(DISPATCH_START_VERDICT));
  assert.deepEqual(
    [...closedSet].sort(),
    ["NOT_STARTED", "STARTED", "UNDECIDABLE"].sort(),
  );
  const cases = [
    undefined,
    null,
    {},
    { dispatch: dispatch(), observations: [], now: DISPATCHED_AT_MS },
    {
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS + 1000,
          lastOutputAt: DISPATCHED_AT_MS + 1000,
        },
        {
          observedAtMs: DISPATCHED_AT_MS + 2000,
          lastOutputAt: DISPATCHED_AT_MS + 5000,
        },
      ],
      now: DISPATCHED_AT_MS + 2000,
    },
  ];
  for (const c of cases) {
    const result = judgeDispatchStart(c);
    assert.equal(
      closedSet.has(result.verdict),
      true,
      `unexpected verdict ${result.verdict} for ${JSON.stringify(c)}`,
    );
  }
});

test("fail-closed: args/dispatch/now/threshold malformed never throw, always UNDECIDABLE (6/6)", () => {
  const cases = [
    undefined,
    null,
    "not-an-object",
    { dispatch: null, observations: [], now: 1 },
    { dispatch: dispatch(), observations: [], now: "not-a-number" },
    {
      dispatch: dispatch(),
      observations: [],
      now: DISPATCHED_AT_MS,
      thresholds: { minNoProgressSeconds: -1 },
    },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => {
      const result = judgeDispatchStart(c);
      assert.equal(result.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);
    });
  }
});

// ---------------------------------------------------------------------------
// (c) ★붙여넣기만 되고 제출 안 된 상태를 시작됨으로 판정하지 않는다.
// ---------------------------------------------------------------------------
test("(c) single post-delivery echo alone is never STARTED, regardless of elapsed time (2/2)", () => {
  // 배달 직후 한 번 튄 출력(붙여넣기 메아리)뿐 -- 비교할 두 번째 관측이
  // 없으므로 STARTED로 새지 않는다.
  const soonAfter = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + 1000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.notEqual(soonAfter.verdict, DISPATCH_START_VERDICT.STARTED);
  assert.equal(soonAfter.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);

  // 임계를 훌쩍 넘긴 뒤에도 여전히 관측이 하나뿐이면 STARTED가 아니다
  // (그렇다고 NOT_STARTED로 단정하지도 않는다 -- 관측 결손 자체가
  // "확인 못 함"이다).
  const longAfter = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 60_000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.notEqual(longAfter.verdict, DISPATCH_START_VERDICT.STARTED);
  assert.equal(longAfter.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);
  assert.equal(
    longAfter.reasonCode,
    DISPATCH_START_REASON.SINGLE_OBSERVATION_PAST_THRESHOLD,
  );
});

test("(c) STARTED requires forward movement between two distinct observations -- bidirectional counter-examples (2/2)", () => {
  // 반례 1: 두 관측이 있어도 lastOutputAt이 전진하지 않으면 STARTED가
  // 아니다(전진 없음 -> NOT_STARTED, 임계 지남).
  const flat = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 60_000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 60_000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.notEqual(flat.verdict, DISPATCH_START_VERDICT.STARTED);

  // 반례 2(양성): 두 관측 사이에 실제로 전진했으면 STARTED다.
  const moving = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 5000,
        lastOutputAt: DISPATCHED_AT_MS + 4500,
      },
    ],
    now: DISPATCHED_AT_MS + 5000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.equal(moving.verdict, DISPATCH_START_VERDICT.STARTED);
  assert.equal(
    moving.reasonCode,
    DISPATCH_START_REASON.PROGRESSED_BETWEEN_OBSERVATIONS,
  );
});

// ---------------------------------------------------------------------------
// (d) ★오늘 실제 사례(2026-08-02, 83분 무진행) fixture 재현.
// 출처: PHASE 델타-AH ⑥(2026-08-02) -- 배달 11:56:32 KST, `injected:true`,
// 좌석 마지막 출력이 11:56:33 KST에서 멈춘 채 83분 무진행. 아래 타임
// 스탬프는 그 기록에서 복원한 타임라인이지 실측 계측값이 아니다
// (coder-task.md §3-d "기록 복원이지 계측값 아님").
// ---------------------------------------------------------------------------
test("(d) 2026-08-02 83-minute stall fixture (dispatch 11:56:32 / frozen last-output 11:56:33) -> NOT_STARTED", () => {
  const frozenOutputMs = Date.parse("2026-08-02T11:56:33+09:00");
  const observations = [
    // 붙여넣기 메아리(배달 1초 뒤) -- 이것만 봤다면 STARTED로 오판할 뻔한
    // 지점(§2-3의 정확한 형태).
    { observedAtMs: frozenOutputMs, lastOutputAt: frozenOutputMs },
    // 사람이 눈으로 확인하기 전까지 반복 폴링됐다고 복원한 중간 관측 --
    // 출력은 그대로 얼어붙어 있다.
    {
      observedAtMs: DISPATCHED_AT_MS + 13 * 60_000,
      lastOutputAt: frozenOutputMs,
    },
    // 83분 뒤(사람이 실제로 발견한 시점) -- 여전히 11:56:33에서 그대로.
    {
      observedAtMs: DISPATCHED_AT_MS + 83 * 60_000,
      lastOutputAt: frozenOutputMs,
    },
  ];
  const result = judgeDispatchStart({
    dispatch: dispatch(),
    observations,
    now: DISPATCHED_AT_MS + 83 * 60_000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.equal(result.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
  assert.equal(
    result.reasonCode,
    DISPATCH_START_REASON.NO_PROGRESS_PAST_THRESHOLD,
  );
});

// ---------------------------------------------------------------------------
// (e) 관측 결손·형식 위반·순서 역전·미래 시각 -> 전부 UNDECIDABLE.
// ---------------------------------------------------------------------------
test("(e) missing/malformed/reversed-order/future observations never leak into STARTED (7/7)", () => {
  const cases = [
    // 관측 배열 자체가 아님.
    {
      dispatch: dispatch(),
      observations: "not-an-array",
      now: DISPATCHED_AT_MS,
    },
    // 관측 0건, 임계 이내.
    { dispatch: dispatch(), observations: [], now: DISPATCHED_AT_MS + 1000 },
    // 관측 0건, 임계 지남.
    {
      dispatch: dispatch(),
      observations: [],
      now: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 1,
    },
    // 형식 위반: lastOutputAt 결손.
    {
      dispatch: dispatch(),
      observations: [{ observedAtMs: DISPATCHED_AT_MS + 1000 }],
      now: DISPATCHED_AT_MS + 1000,
    },
    // 형식 위반: lastOutputAt이 관측 시각보다 미래(구조적 모순).
    {
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS + 1000,
          lastOutputAt: DISPATCHED_AT_MS + 5000,
        },
      ],
      now: DISPATCHED_AT_MS + 5000,
    },
    // 순서 역전: 관측이 배달보다 이르다.
    {
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS - 5000,
          lastOutputAt: DISPATCHED_AT_MS - 5000,
        },
      ],
      now: DISPATCHED_AT_MS,
    },
    // 미래 시각: 관측 시각이 now보다 나중.
    {
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS + 10_000,
          lastOutputAt: DISPATCHED_AT_MS + 10_000,
        },
      ],
      now: DISPATCHED_AT_MS + 1000,
    },
  ];
  for (const c of cases) {
    const result = judgeDispatchStart(c);
    assert.equal(
      result.verdict,
      DISPATCH_START_VERDICT.UNDECIDABLE,
      `expected UNDECIDABLE for ${JSON.stringify(c)}, got ${result.verdict}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (f) 정상 케이스 오탐 0(분모 병기) + "아직 이른" 관측은 판정 보류.
// ---------------------------------------------------------------------------
test("(f) normal healthy starts are never misjudged NOT_STARTED (0/4 false positives)", () => {
  const normalCases = [
    // 3초 뒤 진전.
    [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 3000,
        lastOutputAt: DISPATCHED_AT_MS + 3000,
      },
    ],
    // 30초 뒤 진전.
    [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 30_000,
        lastOutputAt: DISPATCHED_AT_MS + 29_000,
      },
    ],
    // 임계 훨씬 지나서까지 계속 진전.
    [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 10_000,
        lastOutputAt: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 9_000,
      },
    ],
    // 세 번째 관측에서야 진전(가운데는 아직 그대로).
    [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 2000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 3000,
        lastOutputAt: DISPATCHED_AT_MS + 2500,
      },
    ],
  ];
  let falsePositives = 0;
  for (const observations of normalCases) {
    const now = observations[observations.length - 1].observedAtMs;
    const result = judgeDispatchStart({
      dispatch: dispatch(),
      observations,
      now,
      thresholds: { minNoProgressSeconds: THRESHOLD_S },
    });
    if (result.verdict === DISPATCH_START_VERDICT.NOT_STARTED) falsePositives++;
    assert.equal(result.verdict, DISPATCH_START_VERDICT.STARTED);
  }
  assert.equal(falsePositives, 0, "0/4 expected");
});

test("(f) not-yet-progressed observation within threshold is UNDECIDABLE (deferred), never NOT_STARTED (3/3 boundary)", () => {
  const withinThreshold = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 2000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + 2000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.equal(withinThreshold.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);
  assert.equal(
    withinThreshold.reasonCode,
    DISPATCH_START_REASON.NO_PROGRESS_TOO_EARLY,
  );

  // 정확히 임계 경계(elapsed === thresholdMs) -- 아직 "지났다"가 아니므로
  // 여전히 판정 보류.
  const atBoundary = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + THRESHOLD_S * 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + THRESHOLD_S * 1000,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.equal(atBoundary.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);

  // 경계를 1ms 지나면 비로소 NOT_STARTED.
  const pastBoundary = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 1,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 1,
    thresholds: { minNoProgressSeconds: THRESHOLD_S },
  });
  assert.equal(pastBoundary.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
});

test("default threshold: DEFAULT_MIN_NO_PROGRESS_SECONDS is a positive finite number used when thresholds omitted (1/1)", () => {
  assert.equal(typeof DEFAULT_MIN_NO_PROGRESS_SECONDS, "number");
  assert.ok(DEFAULT_MIN_NO_PROGRESS_SECONDS > 0);
  const result = judgeDispatchStart({
    dispatch: dispatch(),
    observations: [
      {
        observedAtMs: DISPATCHED_AT_MS + 1000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
      {
        observedAtMs: DISPATCHED_AT_MS + 2000,
        lastOutputAt: DISPATCHED_AT_MS + 1000,
      },
    ],
    now: DISPATCHED_AT_MS + 2000,
    // thresholds 생략.
  });
  assert.equal(result.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, DISPATCH_START_REASON.NO_PROGRESS_TOO_EARLY);
});

// ---------------------------------------------------------------------------
// (g) 판별력 자동화 -- copy-and-mutate. 신규 파일이라 아직 HEAD에 없으면
// 명시적 사유로 skip한다(커밋 후 자동 해제).
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/dispatch-start-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "dispatch-start-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

// ★재작업 1R(coder-task.md §10): 치환 대상 문자열이 소스에서 **정확히
// 1회** 일치하는지 먼저 단언한다. 0회(대상이 실제 구현과 어긋남 -- 오늘
// 사고의 정확한 형태, mutation #3이 헛변이였던 원인)·2회 이상(어느 자리를
// 바꿨는지 불분명) 둘 다 "skip"이 아니라 **시험 실패**로 처리한다 --
// 그래야 "변이체가 사실은 원본과 동일해서 RED가 날 수 없다"는 헛시험이
// 조용히 통과하는 사고가 재발하지 않는다.
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
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-dispatch-start-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "dispatch-start-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/dispatch-start-core #1 (필수): 단일 관측 가드 제거 -> RED (붙여넣기 메아리 1건이 STARTED로 오판됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  if (sorted.length < 2) return { comparable: false, progressed: false };",
        "  if (sorted.length < 2) return { comparable: true, progressed: true };",
      ),
    );
    const result = mutant.judgeDispatchStart({
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS + 1000,
          lastOutputAt: DISPATCHED_AT_MS + 1000,
        },
      ],
      now: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 60_000,
      thresholds: { minNoProgressSeconds: THRESHOLD_S },
    });
    assert.equal(
      result.verdict,
      "STARTED",
      "mutant must misjudge a single post-delivery echo as STARTED (RED signal; proves the single-observation guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/dispatch-start-core #2 (필수): 관측 형식 검사 제거 -> RED (형식 위반 관측이 새어나감)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "function isWellFormedObservation(entry) {\n  if (!isPlainObject(entry)) return false;\n  if (!isFiniteNumber(entry.observedAtMs)) return false;\n  if (!isFiniteNumber(entry.lastOutputAt)) return false;\n  // 출력 시각이 그 출력을 관측한 시각보다 나중일 수 없다(구조적 모순).\n  return entry.lastOutputAt <= entry.observedAtMs;\n}",
        "function isWellFormedObservation(entry) {\n  return true;\n}",
      ),
    );
    // 관측 2건(단일 관측 가드를 지나가도록)에 형식 위반(lastOutputAt이
    // 숫자가 아님)을 섞어 임계도 지나게 한다 -- 정상 코어는 구조 검사에서
    // OBSERVATION_MALFORMED로 즉시 닫히지만, 이 mutant는 그 검사가 없어
    // 손상된 값이 비교 로직까지 새어나가 (잘못된) NOT_STARTED를 낸다.
    const observations = [
      { observedAtMs: DISPATCHED_AT_MS + 1000, lastOutputAt: "not-a-number" },
      {
        observedAtMs: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 60_000,
        lastOutputAt: "not-a-number",
      },
    ];
    const result = mutant.judgeDispatchStart({
      dispatch: dispatch(),
      observations,
      now: DISPATCHED_AT_MS + THRESHOLD_S * 1000 + 60_000,
      thresholds: { minNoProgressSeconds: THRESHOLD_S },
    });
    assert.notEqual(
      result.verdict,
      "UNDECIDABLE",
      "mutant must misjudge a structurally malformed observation (RED signal; proves the shape gate is load-bearing)",
    );
  },
);

test(
  "NC mutation/dispatch-start-core #3 (필수): 진전 비교를 항상 참으로 -> RED (정지된 좌석이 STARTED로 오판됨, 오늘 사고 그 형태)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    // ★재작업 1R(coder-task.md §10): 치환 대상을 실제 구현
    // (`detectProgression`, dispatch-start-core.mjs 167~182행)과 동기화한다.
    // 이전 버전은 리팩터 전 형태("progressed = true; break;")를 그대로
    // 남겨둔 채여서 실제 소스에 0회 매치 -- 변이체가 원본과 동일해져
    // RED가 날 수 없는 헛시험이었다(REVIEW P1, ORCH 독립 확인). 지금은
    // "진전 비교"(`sorted[i].lastOutputAt > runningMin`)를 무력화(항상
    // 전진했다고 우김)하는 정확한 지점을 겨냥한다.
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "    if (sorted[i].lastOutputAt > runningMin) {\n      return { comparable: true, progressed: true };\n    }",
        "    if (true) {\n      return { comparable: true, progressed: true };\n    }",
      ),
    );
    const frozenOutputMs = Date.parse("2026-08-02T11:56:33+09:00");
    const result = mutant.judgeDispatchStart({
      dispatch: dispatch(),
      observations: [
        { observedAtMs: frozenOutputMs, lastOutputAt: frozenOutputMs },
        {
          observedAtMs: DISPATCHED_AT_MS + 83 * 60_000,
          lastOutputAt: frozenOutputMs,
        },
      ],
      now: DISPATCHED_AT_MS + 83 * 60_000,
      thresholds: { minNoProgressSeconds: THRESHOLD_S },
    });
    assert.equal(
      result.verdict,
      "STARTED",
      "mutant must misjudge the frozen-output 83-minute shape as STARTED (RED signal; proves the strict-forward-progress check is load-bearing)",
    );
  },
);

test(
  "NC mutation/dispatch-start-core #4 (필수): 임계 이내 판정 보류 제거 -> RED (정상적으로 아직 이른 관측이 NOT_STARTED로 오판됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  if (!pastThreshold) {\n    return undecidable(DISPATCH_START_REASON.NO_PROGRESS_TOO_EARLY);\n  }\n\n  return {",
        "  return {",
      ),
    );
    const result = mutant.judgeDispatchStart({
      dispatch: dispatch(),
      observations: [
        {
          observedAtMs: DISPATCHED_AT_MS + 1000,
          lastOutputAt: DISPATCHED_AT_MS + 1000,
        },
        {
          observedAtMs: DISPATCHED_AT_MS + 2000,
          lastOutputAt: DISPATCHED_AT_MS + 1000,
        },
      ],
      now: DISPATCHED_AT_MS + 2000,
      thresholds: { minNoProgressSeconds: THRESHOLD_S },
    });
    assert.equal(
      result.verdict,
      "NOT_STARTED",
      "mutant must misjudge a not-yet-due observation as NOT_STARTED (RED signal; proves the too-early deferral gate is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #7).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "dispatch-start-core.test.mjs must leave the real worktree exactly as it found it",
  );
});
