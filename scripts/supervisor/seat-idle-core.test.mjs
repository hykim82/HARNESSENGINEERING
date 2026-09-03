// HYK-185-seat-idle-1 (coder-task.md §3, §4) -- seat-idle-core.mjs 계약
// 시험.
//
// 이 계약이 보장하지 않는 것(S11, 코어 헤더와 동일 4가지 -- 여기서는
// 짧게만 반복한다): (1) 두 방치 표본이 각 1건뿐이라 기본 임계 근거가
// 약하다, (2) 이 코어를 부르는 프로덕션 경로는 이 파일 시험 범위 밖(별도
// wire 시험이 본다), (3) 화면 축의 한계, (4) 감시자 자신이 멈추면 이
// 축도 함께 멈춘다.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeSeatIdle,
  SEAT_IDLE_VERDICT,
  SEAT_IDLE_REASON,
  DEFAULT_MAX_ABANDONED_SECONDS,
  DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS,
} from "./seat-idle-core.mjs";

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

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/Date.now are never invoked while judging seat idle", () => {
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
        throw new Error(`unexpected fs.${n} call from judgeSeatIdle`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from judgeSeatIdle`,
        );
      }),
    );
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from judgeSeatIdle");
  });
  try {
    judgeSeatIdle({
      observation: {
        observedAtMs: 1000,
        lastOutputAt: 1000,
        reasonHint: "some screen text",
      },
      now: 2000,
      thresholds: { maxAbandonedSeconds: THRESHOLD_S },
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
  join(ROOT, "scripts", "supervisor", "seat-idle-core.mjs"),
  "utf8",
);
test("static: seat-idle-core.mjs has zero import statements (no I/O surface at all)", () => {
  const imports = [
    ...SRC_TEXT.matchAll(/^import[\s\S]*?from\s+["'](.+)["'];?\s*$/gm),
  ];
  assert.deepEqual(imports, []);
});

test("static: seat-idle-core.mjs never uses reasonHint (screen text) in judgment logic -- only in the details passthrough line", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  const reasonHintLines = codeOnly
    .split("\n")
    .filter((l) => l.includes("reasonHint"));
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

test("static: seat-idle-core.mjs never uses SEAT_LIVENESS_* vocabulary in actual code (distinct axis, coder-task.md §2-1-1 -- comments may still reference the other axis for contrast)", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  assert.equal(/SEAT_LIVENESS_/.test(codeOnly), false);
});

// ---------------------------------------------------------------------------
// (b) 닫힌 3상태 + fail-closed.
// ---------------------------------------------------------------------------
test("closed 3-state: verdict is always one of IDLE_OK/SUSPECTED_ABANDONED/UNDECIDABLE (4/4 arbitrary inputs)", () => {
  const closedSet = new Set(Object.values(SEAT_IDLE_VERDICT));
  assert.deepEqual(
    [...closedSet].sort(),
    ["IDLE_OK", "SUSPECTED_ABANDONED", "UNDECIDABLE"].sort(),
  );
  const cases = [
    undefined,
    null,
    {},
    { observation: { observedAtMs: 1, lastOutputAt: 1 }, now: 1 },
  ];
  for (const c of cases) {
    const result = judgeSeatIdle(c);
    assert.equal(
      closedSet.has(result.verdict),
      true,
      `unexpected verdict ${result.verdict} for ${JSON.stringify(c)}`,
    );
  }
});

test("fail-closed: args/now/threshold/observation malformed never throw, always UNDECIDABLE (6/6)", () => {
  const cases = [
    undefined,
    null,
    "not-an-object",
    { observation: {}, now: 1 },
    { observation: {}, now: "not-a-number" },
    {
      observation: { observedAtMs: 1, lastOutputAt: 1 },
      now: 1,
      thresholds: { maxAbandonedSeconds: -1 },
    },
    { observation: "not-an-object", now: 1 },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => {
      const result = judgeSeatIdle(c);
      assert.equal(result.verdict, SEAT_IDLE_VERDICT.UNDECIDABLE);
    });
  }
});

// ---------------------------------------------------------------------------
// (a) 양방향 반례 고정(coder-task.md §3-a) -- 오늘 실측 두 표본
// (5.33h·13.75h)이 발화하고, 정상 라운드 간 유휴(10분·59분)는 발화하지
// 않는다. 같은 입력에서 경과 시간만 바꿔 결과가 뒤집히는 시험.
// ---------------------------------------------------------------------------
const IDLE_BASE_AT = Date.parse("2026-08-04T09:00:00+09:00");

test("(a)★ real abandoned sample 1: pm-lane seat idle 5.33h -> SUSPECTED_ABANDONED", () => {
  const lastOutputAt = IDLE_BASE_AT;
  const now = IDLE_BASE_AT + 5.33 * 60 * 60 * 1000;
  const result = judgeSeatIdle({
    observation: { observedAtMs: now, lastOutputAt },
    now,
  });
  assert.equal(result.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
  assert.equal(result.reasonCode, SEAT_IDLE_REASON.NO_OUTPUT_PAST_THRESHOLD);
});

test("(a)★ real abandoned sample 2: main worktree seat idle 13.75h -> SUSPECTED_ABANDONED", () => {
  const lastOutputAt = IDLE_BASE_AT;
  const now = IDLE_BASE_AT + 13.75 * 60 * 60 * 1000;
  const result = judgeSeatIdle({
    observation: { observedAtMs: now, lastOutputAt },
    now,
  });
  assert.equal(result.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
  assert.equal(result.reasonCode, SEAT_IDLE_REASON.NO_OUTPUT_PAST_THRESHOLD);
});

test("(a)★ normal between-round idle 10 minutes -> IDLE_OK, never SUSPECTED_ABANDONED", () => {
  const lastOutputAt = IDLE_BASE_AT;
  const now = IDLE_BASE_AT + 10 * 60 * 1000;
  const result = judgeSeatIdle({
    observation: { observedAtMs: now, lastOutputAt },
    now,
  });
  assert.equal(result.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
  assert.notEqual(result.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
});

test("(a)★ normal between-round idle 59 minutes -> IDLE_OK, never SUSPECTED_ABANDONED", () => {
  const lastOutputAt = IDLE_BASE_AT;
  const now = IDLE_BASE_AT + 59 * 60 * 1000;
  const result = judgeSeatIdle({
    observation: { observedAtMs: now, lastOutputAt },
    now,
  });
  assert.equal(result.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
  assert.notEqual(result.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
});

test("(a)★ same input, only elapsed time changes -> verdict flips at the threshold boundary (elapsed=threshold is still OK, elapsed=threshold+1ms flips)", () => {
  const lastOutputAt = IDLE_BASE_AT;
  const thresholdMs = DEFAULT_MAX_ABANDONED_SECONDS * 1000;
  const atThreshold = judgeSeatIdle({
    observation: { observedAtMs: lastOutputAt + thresholdMs, lastOutputAt },
    now: lastOutputAt + thresholdMs,
  });
  assert.equal(atThreshold.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
  const pastThreshold = judgeSeatIdle({
    observation: {
      observedAtMs: lastOutputAt + thresholdMs + 1,
      lastOutputAt,
    },
    now: lastOutputAt + thresholdMs + 1,
  });
  assert.equal(pastThreshold.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
});

test("(weak-evidence disclosure)★ the two real abandoned samples straddle the default threshold: 1h normal < threshold < 5.33h abandoned", () => {
  const thresholdS = DEFAULT_MAX_ABANDONED_SECONDS;
  assert.ok(60 * 60 < thresholdS, "1h normal idle must be below threshold");
  assert.ok(
    thresholdS < 5.33 * 60 * 60,
    "5.33h abandoned sample must be above threshold",
  );
});

// ---------------------------------------------------------------------------
// (c) 수집 실패 -> UNDECIDABLE (coder-task.md §3-c) -- 관측 결손·형식
// 위반·미래 시각은 전부 판정 불가로 닫힌다. 빈 목록(정상)과 "못 읽었다"가
// 다른 결과임은 wire 시험(orch-stall-detect 결선)이 별도로 고정한다 --
// 이 코어 수준에서는 "관측이 아예 없음/형식 위반/미래 시각"이 곧 그
// 대응물이다.
// ---------------------------------------------------------------------------
test("(c) missing/malformed/future observations never leak into SUSPECTED_ABANDONED or IDLE_OK (4/4)", () => {
  const cases = [
    // 관측 자체가 없음.
    { observation: undefined, now: 1000 },
    // 형식 위반: lastOutputAt 결손.
    { observation: { observedAtMs: 1000 }, now: 1000 },
    // 형식 위반: lastOutputAt이 관측 시각보다 «허용치를 훨씬 넘겨»
    // 미래(구조적 모순) -- HYK-421 1R로 바쁜 좌석의 정상 왕복(수백 ms)은
    // DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS(5000ms) 이내로 통과하므로
    // 이 표본은 그 허용치를 자릿수로 넘는 10분 뒤로 둬 "진짜 malformed"임을
    // 분명히 한다(seat-liveness-core.test.mjs와 동일 이유).
    {
      observation: { observedAtMs: 1000, lastOutputAt: 1000 + 600_000 },
      now: 1000 + 600_000,
    },
    // 미래 시각: 관측 시각이 now보다 나중.
    { observation: { observedAtMs: 10_000, lastOutputAt: 10_000 }, now: 1000 },
  ];
  for (const c of cases) {
    const result = judgeSeatIdle(c);
    assert.equal(
      result.verdict,
      SEAT_IDLE_VERDICT.UNDECIDABLE,
      `expected UNDECIDABLE for ${JSON.stringify(c)}, got ${result.verdict}`,
    );
  }
});

// ---------------------------------------------------------------------------
// HYK-421 1R (결함 1 -- seat-liveness-core.mjs와 같은 원인의 같은 결함,
// coder-task.md §2 요구6): 이 축의 관측도 같은 어댑터 함수가 만드므로
// 바쁜 좌석 왕복시간이 그대로 새어 들어온다. 대칭 시험.
// ---------------------------------------------------------------------------
test("HYK-421 1R ⓐ 바쁜 좌석: lastOutputAt이 observedAtMs보다 실측 왕복시간(170~264ms) 만큼 뒤여도 UNDECIDABLE이 아니라 정상 판정된다", () => {
  const busySamplesMs = [170, 192, 264];
  for (const gapMs of busySamplesMs) {
    const observedAtMs = 1_000_000;
    const result = judgeSeatIdle({
      observation: {
        observedAtMs,
        lastOutputAt: observedAtMs + gapMs,
      },
      now: observedAtMs + gapMs,
    });
    assert.notEqual(
      result.verdict,
      SEAT_IDLE_VERDICT.UNDECIDABLE,
      `busy-seat gap ${gapMs}ms must not be misjudged as UNDECIDABLE`,
    );
    assert.equal(result.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
  }
});

test("HYK-421 1R ⓑ 진짜 malformed: 허용치를 자릿수로 넘는 시각 역전은 여전히 OBSERVATION_MALFORMED로 거부된다", () => {
  const observedAtMs = 1_000_000;
  const genuinelyMalformedGapMs =
    DEFAULT_OBSERVATION_CLOCK_SKEW_TOLERANCE_MS + 10 * 60 * 1000;
  const result = judgeSeatIdle({
    observation: {
      observedAtMs,
      lastOutputAt: observedAtMs + genuinelyMalformedGapMs,
    },
    now: observedAtMs + genuinelyMalformedGapMs,
  });
  assert.equal(result.verdict, SEAT_IDLE_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, SEAT_IDLE_REASON.OBSERVATION_MALFORMED);
});

// ---------------------------------------------------------------------------
// (e) 화면 텍스트는 판정에 쓰이지 않는다.
// ---------------------------------------------------------------------------
test("screen text (reasonHint) never changes the verdict -- identical time observations with different screen strings agree (2/2 pairs)", () => {
  const pairs = [
    { observedAtMs: IDLE_BASE_AT + 1000, lastOutputAt: IDLE_BASE_AT + 1000 },
    {
      observedAtMs: IDLE_BASE_AT + THRESHOLD_S * 1000 + 60_000,
      lastOutputAt: IDLE_BASE_AT + 1000,
    },
  ];
  const screenStrings = [
    "ORCH idle waiting for input",
    "완전히 다른 화면 문구",
    undefined,
  ];
  for (const base of pairs) {
    const results = screenStrings.map((reasonHint) =>
      judgeSeatIdle({
        observation: { ...base, reasonHint },
        now: base.observedAtMs,
        thresholds: { maxAbandonedSeconds: THRESHOLD_S },
      }),
    );
    for (const r of results.slice(1)) {
      assert.equal(r.verdict, results[0].verdict);
      assert.equal(r.reasonCode, results[0].reasonCode);
    }
  }
});

test("default threshold: DEFAULT_MAX_ABANDONED_SECONDS is a positive finite number used when thresholds omitted (1/1)", () => {
  assert.equal(typeof DEFAULT_MAX_ABANDONED_SECONDS, "number");
  assert.ok(DEFAULT_MAX_ABANDONED_SECONDS > 0);
  const result = judgeSeatIdle({
    observation: { observedAtMs: 1000, lastOutputAt: 1000 },
    now: 1000,
    // thresholds 생략.
  });
  assert.equal(result.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
});

// ---------------------------------------------------------------------------
// (f) 판별력 자동화 -- copy-and-mutate. 신규 파일이라 아직 HEAD에 없으면
// 명시적 사유로 skip한다(seat-liveness-core.test.mjs 선례와 동일 형태,
// 커밋 후 자동 해제).
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/seat-idle-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "seat-idle-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

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
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-seat-idle-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "seat-idle-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/seat-idle-core #1 (필수): 시간 임계 비교 제거 -> RED (13.75h 방치 표본이 IDLE_OK로 오판됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  const pastThreshold = elapsedMs > thresholdMs;",
        "  const pastThreshold = false;",
      ),
    );
    const lastOutputAt = IDLE_BASE_AT;
    const now = IDLE_BASE_AT + 13.75 * 60 * 60 * 1000;
    const result = mutant.judgeSeatIdle({
      observation: { observedAtMs: now, lastOutputAt },
      now,
    });
    assert.equal(
      result.verdict,
      "IDLE_OK",
      "mutant must misjudge the real 13.75h abandonment as IDLE_OK (RED signal; proves the time-threshold comparison is load-bearing)",
    );
  },
);

test(
  "NC mutation/seat-idle-core #2 (필수): 미래 시각 검사 제거 -> RED (관측이 now보다 미래인 손상된 입력도 판정됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  if (observation.observedAtMs > now) {\n    return SEAT_IDLE_REASON.OBSERVATION_IN_FUTURE;\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeSeatIdle({
      observation: { observedAtMs: 10_000, lastOutputAt: 10_000 },
      now: 1000,
    });
    assert.notEqual(
      result.verdict,
      "UNDECIDABLE",
      "mutant must fail to reject a future-timestamped observation as UNDECIDABLE (RED signal; proves the future-timestamp guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/seat-idle-core #3 (필수): 화면 텍스트를 판정에 사용 -> RED (같은 시간 관측이 문구만으로 다르게 판정됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      applyMutation(
        src,
        "  const pastThreshold = elapsedMs > thresholdMs;",
        '  const pastThreshold = elapsedMs > thresholdMs || reasonHint === "Dangerous";',
      ),
    );
    const base = {
      observedAtMs: IDLE_BASE_AT + 1000,
      lastOutputAt: IDLE_BASE_AT + 1000,
    };
    const result = mutant.judgeSeatIdle({
      observation: { ...base, reasonHint: "Dangerous" },
      now: base.observedAtMs,
      thresholds: { maxAbandonedSeconds: THRESHOLD_S },
    });
    assert.equal(
      result.verdict,
      "SUSPECTED_ABANDONED",
      "mutant must let screen text alone flip a normal in-threshold observation to SUSPECTED_ABANDONED (RED signal; proves screen text is correctly excluded from judgment in the real core)",
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
    "seat-idle-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "seat-idle-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
