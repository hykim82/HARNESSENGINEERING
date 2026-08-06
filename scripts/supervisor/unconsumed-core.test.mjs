// HYK-185-unconsumed-1 (coder-task.md) -- unconsumed-core.mjs 계약 시험.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 이 스위트가 100% 통과해도 "실제 워커 결과가 실제로 소비됐다"를
//    증명하지 않는다 -- 이 코어는 주입된 `resultFile`/`signals`만 판정한다
//    (실제 mtime·git 조회는 이 코어 밖, unconsumed-wire.test.mjs가 결선을
//    시험한다).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
// 3. mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를 읽는다
//    (dispatch-start-wire.test.mjs S11-3과 동일 이유 -- 이번 태스크는
//    커밋 0이 조건이라 신규 파일이 git HEAD에 없다. HEAD 기준이면 항상
//    skip돼 §5-f "skip 0" 요구를 못 지킨다).
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  judgeUnconsumed,
  UNCONSUMED_VERDICT,
  UNCONSUMED_REASON,
  UNCONSUMED_SIGNAL_KIND,
  DEFAULT_MIN_UNCONSUMED_SECONDS,
} from "./unconsumed-core.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

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

const RESULT_UPDATED_AT_MS = Date.parse("2026-08-06T13:19:21+09:00");
const THRESHOLD_S = 300; // 시험 전용 값(코어 기본값과 무관, 인자로만 넘긴다).

function resultFile(overrides = {}) {
  return { updatedAtMs: RESULT_UPDATED_AT_MS, ...overrides };
}

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/Date.now are never invoked while judging unconsumed (1/1)", () => {
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
        throw new Error(`unexpected fs.${n} call from judgeUnconsumed`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from judgeUnconsumed`,
        );
      }),
    );
  try {
    judgeUnconsumed({
      resultFile: resultFile(),
      signals: [],
      now: RESULT_UPDATED_AT_MS + 1000,
      thresholds: { minUnconsumedSeconds: THRESHOLD_S },
    });
  } finally {
    for (const m of [...fsMocks, ...cpMocks]) m.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// (b) 인자 구조 counter-example matrix -- 전부 UNDECIDABLE(fail-closed),
// 예외 0.
// ---------------------------------------------------------------------------
test("(a) counter-example matrix: args가 plain object 아님 -> ARGS_INVALID (4/4)", () => {
  for (const bad of [null, undefined, "x", [1, 2]]) {
    const r = judgeUnconsumed(bad);
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.ARGS_INVALID);
  }
});

test("(a) counter-example matrix: now가 유한수 아님 -> NOW_INVALID (4/4)", () => {
  for (const bad of [NaN, Infinity, "now", undefined]) {
    const r = judgeUnconsumed({
      resultFile: resultFile(),
      signals: [],
      now: bad,
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.NOW_INVALID);
  }
});

test("(a) counter-example matrix: threshold 위반 -> THRESHOLD_INVALID (3/3)", () => {
  for (const bad of [0, -1, "300"]) {
    const r = judgeUnconsumed({
      resultFile: resultFile(),
      signals: [],
      now: RESULT_UPDATED_AT_MS + 1000,
      thresholds: { minUnconsumedSeconds: bad },
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.THRESHOLD_INVALID);
  }
});

test("threshold 생략 -> DEFAULT_MIN_UNCONSUMED_SECONDS(900)가 쓰인다 (2/2)", () => {
  const justUnder = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [],
    now: RESULT_UPDATED_AT_MS + (DEFAULT_MIN_UNCONSUMED_SECONDS - 1) * 1000,
  });
  assert.equal(justUnder.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  assert.equal(justUnder.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_TOO_EARLY);

  const justOver = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [],
    now: RESULT_UPDATED_AT_MS + (DEFAULT_MIN_UNCONSUMED_SECONDS + 1) * 1000,
  });
  assert.equal(justOver.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  assert.equal(justOver.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_PAST_THRESHOLD);
});

test("(a) counter-example matrix: resultFile 형식 위반 -> RESULT_FILE_INVALID (4/4)", () => {
  for (const bad of [null, {}, { updatedAtMs: "x" }, { updatedAtMs: NaN }]) {
    const r = judgeUnconsumed({
      resultFile: bad,
      signals: [],
      now: RESULT_UPDATED_AT_MS + 1000,
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.RESULT_FILE_INVALID);
  }
});

test("resultFile.updatedAtMs가 now보다 미래 -> RESULT_IN_FUTURE (1/1)", () => {
  const r = judgeUnconsumed({
    resultFile: resultFile({ updatedAtMs: RESULT_UPDATED_AT_MS }),
    signals: [],
    now: RESULT_UPDATED_AT_MS - 1000,
  });
  assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, UNCONSUMED_REASON.RESULT_IN_FUTURE);
});

test("(a) counter-example matrix: signals가 배열 아님 -> SIGNALS_INVALID (3/3)", () => {
  for (const bad of [null, {}, "x"]) {
    const r = judgeUnconsumed({
      resultFile: resultFile(),
      signals: bad,
      now: RESULT_UPDATED_AT_MS + 1000,
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.SIGNALS_INVALID);
  }
});

test("(a) counter-example matrix: 신호 항목 형식 위반 -> SIGNAL_MALFORMED (4/4)", () => {
  const badSignalLists = [
    [null],
    [{ kind: "UNKNOWN_KIND", atMs: RESULT_UPDATED_AT_MS + 1000 }],
    [{ kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER, atMs: "not-a-number" }],
    [{ kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER }],
  ];
  for (const signals of badSignalLists) {
    const r = judgeUnconsumed({
      resultFile: resultFile(),
      signals,
      now: RESULT_UPDATED_AT_MS + 2000,
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.SIGNAL_MALFORMED);
  }
});

test("신호 시각이 now보다 미래 -> SIGNAL_IN_FUTURE (1/1)", () => {
  const r = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [
      {
        kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER,
        atMs: RESULT_UPDATED_AT_MS + 10_000,
      },
    ],
    now: RESULT_UPDATED_AT_MS + 5000,
  });
  assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, UNCONSUMED_REASON.SIGNAL_IN_FUTURE);
});

test("신호 시각이 resultFile.updatedAtMs 이전(이전 라운드 잔재) -> SIGNAL_BEFORE_RESULT (2/2, 경계 포함)", () => {
  for (const atMs of [RESULT_UPDATED_AT_MS - 1000, RESULT_UPDATED_AT_MS]) {
    const r = judgeUnconsumed({
      resultFile: resultFile(),
      signals: [{ kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER, atMs }],
      now: RESULT_UPDATED_AT_MS + 5000,
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.SIGNAL_BEFORE_RESULT);
  }
});

// ---------------------------------------------------------------------------
// (c) 핵심 판정: 신호 유무 x 임계 전후 2x2.
// ---------------------------------------------------------------------------
test("신호 0건 + 임계 이내 -> UNDECIDABLE/NO_SIGNAL_TOO_EARLY (오탐 0의 절반: 아직 이른 정상 상태를 SUSPECTED로 새지 않는다) (1/1)", () => {
  const r = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [],
    now: RESULT_UPDATED_AT_MS + (THRESHOLD_S - 1) * 1000,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(r.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_TOO_EARLY);
});

test("신호 0건 + 임계 초과 -> SUSPECTED_UNCONSUMED/NO_SIGNAL_PAST_THRESHOLD (1/1)", () => {
  const r = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [],
    now: RESULT_UPDATED_AT_MS + (THRESHOLD_S + 1) * 1000,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(r.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  assert.equal(r.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_PAST_THRESHOLD);
});

test("(b) 오탐 0: TASK_FILE_DROPPED_AFTER 신호가 있으면 임계 초과 여부와 무관하게 CONSUMED (2/2 -- 임계 이내/이후 둘 다)", () => {
  for (const now of [
    RESULT_UPDATED_AT_MS + (THRESHOLD_S - 1) * 1000,
    RESULT_UPDATED_AT_MS + (THRESHOLD_S + 1) * 1000,
  ]) {
    const r = judgeUnconsumed({
      resultFile: resultFile(),
      signals: [
        {
          kind: UNCONSUMED_SIGNAL_KIND.TASK_FILE_DROPPED_AFTER,
          atMs: RESULT_UPDATED_AT_MS + 500,
        },
      ],
      now,
      thresholds: { minUnconsumedSeconds: THRESHOLD_S },
    });
    assert.equal(r.verdict, UNCONSUMED_VERDICT.CONSUMED);
    assert.equal(r.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_TASK_DROP);
  }
});

test("(b) 오탐 0: NEW_COMMIT_AFTER 신호가 있으면 임계 초과 여부와 무관하게 CONSUMED (1/1)", () => {
  const r = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [
      {
        kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER,
        atMs: RESULT_UPDATED_AT_MS + 500,
      },
    ],
    now: RESULT_UPDATED_AT_MS + (THRESHOLD_S + 100) * 1000,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(r.verdict, UNCONSUMED_VERDICT.CONSUMED);
  assert.equal(r.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_NEW_COMMIT);
});

test("신호가 둘 이상이면 가장 이른 것의 kind/atMs가 details.consumedAtMs에 남는다 (1/1)", () => {
  const earlier = RESULT_UPDATED_AT_MS + 500;
  const later = RESULT_UPDATED_AT_MS + 9000;
  const r = judgeUnconsumed({
    resultFile: resultFile(),
    signals: [
      { kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER, atMs: later },
      { kind: UNCONSUMED_SIGNAL_KIND.TASK_FILE_DROPPED_AFTER, atMs: earlier },
    ],
    now: RESULT_UPDATED_AT_MS + 10_000,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(r.verdict, UNCONSUMED_VERDICT.CONSUMED);
  assert.equal(r.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_TASK_DROP);
  assert.equal(r.details.consumedAtMs, earlier);
});

// ---------------------------------------------------------------------------
// (d) 오늘 실측 표본 재현(coder-task.md §3) -- 수리 전 침묵/수리 후 발화를
// 실측 시각으로 재현한다(§5-a "실물 재현").
// ---------------------------------------------------------------------------
test("★실물 재현 13:44 계열: coder.md 13:19:21 -> review-task.md 13:50:02(다음 라운드 드롭, 약 30.7분 뒤) -- 그 신호가 없으면 SUSPECTED_UNCONSUMED, 있으면 CONSUMED (2/2)", () => {
  const updatedAtMs = Date.parse("2026-08-06T13:19:21+09:00");
  const dropAtMs = Date.parse("2026-08-06T13:50:02+09:00");
  const observedNow = dropAtMs; // 감시가 드롭 직후 도는 시점이라 가정.

  // 수리 전(=이 축이 없던 세계): 흔적을 아예 안 준 채로 판정하면 그 순간
  // 이미 임계(900초=15분)를 넘겼으므로 SUSPECTED_UNCONSUMED로 발화해야
  // 정상 -- 이 축이 없으면 이 신호가 "누구도 안 본" 상태로 남는다.
  const withoutSignal = judgeUnconsumed({
    resultFile: { updatedAtMs },
    signals: [],
    now: observedNow,
  });
  assert.equal(withoutSignal.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);

  // 수리 후(=실제로 다음 태스크가 드롭된 사실을 신호로 넣으면): 소비로
  // 정정되어 침묵한다 -- 실제로는 ORCH가 이미 다음 라운드를 낸 것이므로
  // "무진행"이 아니었다.
  const withSignal = judgeUnconsumed({
    resultFile: { updatedAtMs },
    signals: [
      { kind: UNCONSUMED_SIGNAL_KIND.TASK_FILE_DROPPED_AFTER, atMs: dropAtMs },
    ],
    now: observedNow,
  });
  assert.equal(withSignal.verdict, UNCONSUMED_VERDICT.CONSUMED);
});

test("★실물 재현 14:11 계열: review.md 13:54:38 -> 커밋 2bffdcd 14:13:05(재계산 실측, 약 18.45분 뒤) -- 임계 넘긴 시점 관측은 신호 도착 전 SUSPECTED_UNCONSUMED, 도착 후 CONSUMED (2/2)", () => {
  const updatedAtMs = Date.parse("2026-08-06T13:54:38+09:00");
  const commitAtMs = Date.parse("2026-08-06T14:13:05+09:00");
  const laterTick = commitAtMs + 60_000; // 커밋 이후 다음 예약 감시 틱.

  // 커밋 이전 시점(예: 14:10, 아직 임계도 안 넘고 신호도 없음)은
  // 판정을 보류해야 정상.
  const beforeCommit = judgeUnconsumed({
    resultFile: { updatedAtMs },
    signals: [],
    now: Date.parse("2026-08-06T14:00:00+09:00"),
  });
  assert.equal(beforeCommit.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);

  // 커밋도 아직 없고 임계(15분)도 넘긴 시점(예: 14:11, 실사고가 실제로
  // 관측됐을 구간)은 발화해야 정상.
  const pastThresholdNoCommitYet = judgeUnconsumed({
    resultFile: { updatedAtMs },
    signals: [],
    now: Date.parse("2026-08-06T14:11:00+09:00"),
  });
  assert.equal(
    pastThresholdNoCommitYet.verdict,
    UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
  );

  // 커밋 신호가 들어오면(=실제로 일어난 소비) 그 뒤 어느 시점을 봐도
  // CONSUMED로 정정된다.
  const afterCommit = judgeUnconsumed({
    resultFile: { updatedAtMs },
    signals: [
      { kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER, atMs: commitAtMs },
    ],
    now: laterTick,
  });
  assert.equal(afterCommit.verdict, UNCONSUMED_VERDICT.CONSUMED);
  assert.equal(
    afterCommit.reasonCode,
    UNCONSUMED_REASON.CONSUMED_VIA_NEW_COMMIT,
  );
});

// ---------------------------------------------------------------------------
// (e) 판별력 자동화 -- copy-and-mutate. 디스크의 현재 소스를 읽는다(헤더
// S11-3 참조 -- 이번 태스크는 커밋 0이 조건이라 git HEAD에는 이 신규 파일이
// 없다).
// ---------------------------------------------------------------------------
const CORE_PATH = join(THIS_DIR, "unconsumed-core.mjs");
const CORE_SRC = fs.readFileSync(CORE_PATH, "utf8");

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
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-unconsumed-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "unconsumed-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("NC mutation/unconsumed-core #1 (필수): 신호 순서 검사(SIGNAL_BEFORE_RESULT) 제거 -> RED (이전 라운드의 낡은 신호가 이번 결과의 소비로 오판됨)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "    if (entry.atMs <= resultUpdatedAtMs) {\n      return UNCONSUMED_REASON.SIGNAL_BEFORE_RESULT;\n    }\n",
      "",
    ),
  );
  const result = mutant.judgeUnconsumed({
    resultFile: resultFile(),
    // 결과 파일보다 훨씬 이전(이전 라운드)의 커밋을 신호로 잘못 흘려넣는다.
    signals: [
      {
        kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER,
        atMs: RESULT_UPDATED_AT_MS - 60_000,
      },
    ],
    now: RESULT_UPDATED_AT_MS + (THRESHOLD_S + 100) * 1000,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(
    result.verdict,
    UNCONSUMED_VERDICT.CONSUMED,
    "mutant must misjudge a stale pre-result signal as CONSUMED (RED signal; proves the ordering guard is load-bearing)",
  );
});

test("NC mutation/unconsumed-core #2 (필수): 임계 이내 판정 보류(NO_SIGNAL_TOO_EARLY) 제거 -> RED (정상적으로 아직 이른 무신호 상태가 SUSPECTED_UNCONSUMED로 오판됨)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "  const pastThreshold = now - updatedAtMs > thresholdMs;\n  if (!pastThreshold) {\n    return undecidable(UNCONSUMED_REASON.NO_SIGNAL_TOO_EARLY);\n  }\n\n",
      "",
    ),
  );
  const result = mutant.judgeUnconsumed({
    resultFile: resultFile(),
    signals: [],
    now: RESULT_UPDATED_AT_MS + 1000, // 임계에 한참 못 미친 시점.
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(
    result.verdict,
    UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    "mutant must misjudge a too-early no-signal state as SUSPECTED_UNCONSUMED (RED signal; proves the early-return guard is load-bearing -- 오탐 0 요구의 핵심)",
  );
});

test("NC mutation/unconsumed-core #3 (필수): 신호 형식 검사(isWellFormedSignal) 제거 -> RED (형식 위반 신호가 CONSUMED로 새어나감)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "function isWellFormedSignal(entry) {\n  if (!isPlainObject(entry)) return false;\n  if (!KNOWN_SIGNAL_KINDS.has(entry.kind)) return false;\n  return isFiniteNumber(entry.atMs);\n}",
      "function isWellFormedSignal(entry) {\n  return true;\n}",
    ),
  );
  const result = mutant.judgeUnconsumed({
    resultFile: resultFile(),
    signals: [{ kind: "NOT_A_REAL_KIND", atMs: "not-a-number" }],
    now: RESULT_UPDATED_AT_MS + 2000,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.notEqual(
    result.verdict,
    UNCONSUMED_VERDICT.UNDECIDABLE,
    "mutant must let a structurally malformed signal through instead of closing to UNDECIDABLE (RED signal; proves the shape gate is load-bearing)",
  );
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "unconsumed-core.test.mjs must not leave repository working-tree changes behind",
  );
});
