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

// ===========================================================================
// ★HYK-448 -- ORCH-60 이 어젯밤(2026-09-06 21:00~03:00) 각성 4회를 건별로
// 판정해 남긴 «세 얼굴»을 그대로 픽스처로 고정한다.
// 원문 = .harness/evidence-448/ORCH-measured-awakening-faces.txt
//
//   형태 A(상시 오탐)  -- 중단 종결 라운드. 영수증 0개. 침묵해야 한다.
//   형태 B(진행 중 오탐) -- 아직 안 끝난 라운드. 종료 표지 0개. 침묵해야 한다.
//   진짜 1건(살려야 함) -- 소비가 끝난 «뒤» 결과 파일이 다시 바뀌었다.
//
// ⛔이 세 픽스처의 값(시각·개수)은 위 실측 원문에서 그대로 옮긴 것이지
// 지어낸 것이 아니다. 각 상수 옆에 출처를 적어 둔다.
// ===========================================================================

// FACE 1 -- worktree hyk437-admission-anchor-1, 결과 파일 mtime 17:58:29.
// 그 라운드는 «중단»으로 정상 종결됐고 원장은 그것을 닫았다(중단 종결의
// completion_reason = BLOCKED_TERMINATION_RELEASED).
const FACE_A_RESULT_MS = Date.parse("2026-09-05T17:58:29+09:00");
// 원장은 결과 파일이 쓰인 «뒤»에 그 결과를 보고 닫는다(어댑터가 결과 파일의
// 표지·task_id 에코를 확인한 다음 완료를 찍는다) -- 그래서 닫힌 시각이 결과
// 파일보다 나중이다. 여기서는 30초 뒤로 둔다.
const FACE_A_CLOSED_MS = FACE_A_RESULT_MS + 30_000;
// 각성이 실제로 이 워크트리를 «매 주기» 지목한 시점대(다음날 새벽).
const FACE_A_NOW_MS = Date.parse("2026-09-07T02:48:00+09:00");

// FACE 2 -- worktree hyk431-seat-reclaim-1, HYK-449 가 아직 돌던 21:29 관측.
// coder.md mtime 21:00:32, ★종료 표지 0개, 세 소비 흔적은 전부 결과 파일보다
// 이르다(그래서 신호가 하나도 서지 않는다).
const FACE_B_RESULT_MS = Date.parse("2026-09-06T21:00:32+09:00");
const FACE_B_NOW_MS = Date.parse("2026-09-06T21:29:00+09:00");

// FACE 3(진짜) -- 같은 워크트리, 소비가 «끝난 뒤». 영수증 r10 23:08:29 로
// 소비 확정 -> 워커가 23:11:36 에 그 결과 파일을 다시 고쳤다.
const FACE_C_CLOSED_MS = Date.parse("2026-09-06T23:08:29+09:00");
const FACE_C_RESULT_MS = Date.parse("2026-09-06T23:11:36+09:00");
const FACE_C_NOW_MS = Date.parse("2026-09-07T02:48:00+09:00");

// 세 얼굴 모두 «신호 0건 + 임계 초과» 라는 같은 자리에서 갈린다 -- 그래서
// 이 헬퍼 하나로 세 픽스처를 만든다(차이는 오직 새 입력 둘뿐임을 드러낸다).
function judgeFace({ resultMs, nowMs, terminalMarkerCount, roundClosure }) {
  return judgeUnconsumed({
    resultFile:
      terminalMarkerCount === undefined
        ? { updatedAtMs: resultMs }
        : { updatedAtMs: resultMs, terminalMarkerCount },
    signals: [],
    now: nowMs,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
    ...(roundClosure === undefined ? {} : { roundClosure }),
  });
}

test("★HYK-448 형태 A(상시 오탐): 중단으로 끝나 영수증이 0개인 보존 워크트리 -- 수리 전(원장 정보 없음)은 SUSPECTED_UNCONSUMED 로 발화하고, 원장 종결을 넘기면 CONSUMED 로 조용해진다 (RED/GREEN 2/2)", () => {
  // RED: 이 라운드 전의 호출 모양 그대로(새 입력 둘 다 없음) -- 매 주기
  // 발화하던 바로 그 판정이다.
  const before = judgeFace({
    resultMs: FACE_A_RESULT_MS,
    nowMs: FACE_A_NOW_MS,
  });
  assert.equal(
    before.verdict,
    UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    "수리 전 재현: 영수증이 없다는 이유만으로 미소비로 발화했다(이것이 등재된 결함)",
  );
  assert.equal(before.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_PAST_THRESHOLD);

  // GREEN: 원장이 「닫았다」고 말한다. 결과 파일은 닫힌 시각보다 이르다.
  const after = judgeFace({
    resultMs: FACE_A_RESULT_MS,
    nowMs: FACE_A_NOW_MS,
    terminalMarkerCount: 1, // 중단 표지 1개로 끝난 파일.
    roundClosure: {
      closed: true,
      closedAtMs: FACE_A_CLOSED_MS,
      completionReason: "BLOCKED_TERMINATION_RELEASED",
    },
  });
  assert.equal(
    after.verdict,
    UNCONSUMED_VERDICT.CONSUMED,
    "원장이 닫은 라운드는 영수증 파일이 없어도 소비된 것이다 -- 「영수증 없음」은 「미소비」가 아니다",
  );
  assert.equal(after.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_LEDGER_CLOSURE);
  assert.equal(after.details.consumedAtMs, FACE_A_CLOSED_MS);
  assert.equal(after.details.completionReason, "BLOCKED_TERMINATION_RELEASED");
});

test("★HYK-448 형태 B(진행 중 오탐): 아직 안 끝난 라운드(종료 표지 0개) -- 수리 전은 SUSPECTED_UNCONSUMED, 표지 개수를 넘기면 UNDECIDABLE/ROUND_NOT_FINISHED 로 조용해진다 (RED/GREEN 2/2)", () => {
  const before = judgeFace({
    resultMs: FACE_B_RESULT_MS,
    nowMs: FACE_B_NOW_MS,
  });
  assert.equal(
    before.verdict,
    UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    "수리 전 재현: 판별기가 「종료 표지가 있는가」를 아예 안 봤다",
  );

  const after = judgeFace({
    resultMs: FACE_B_RESULT_MS,
    nowMs: FACE_B_NOW_MS,
    terminalMarkerCount: 0, // ★실측: 종료 표지가 하나도 없었다.
  });
  assert.equal(
    after.verdict,
    UNCONSUMED_VERDICT.UNDECIDABLE,
    "끝나지 않은 라운드에는 소비할 결과 자체가 없다 -- 「미소비」로도 「소비」로도 새지 않는다",
  );
  assert.equal(after.reasonCode, UNCONSUMED_REASON.ROUND_NOT_FINISHED);
});

test("★★HYK-448 진짜 1건(§1-4)은 살아 있다: 원장이 «닫은» 라운드라도 결과 파일이 닫힌 뒤에 바뀌었으면 MODIFIED_AFTER_CLOSURE 로 발화한다 -- 「원장이 닫았으면 침묵」으로 번역하지 않았다는 증거 (1/1)", () => {
  const judged = judgeFace({
    resultMs: FACE_C_RESULT_MS,
    nowMs: FACE_C_NOW_MS,
    terminalMarkerCount: 1, // DONE 으로 끝난 파일이었다(그 «뒤»에 절이 붙었다).
    roundClosure: {
      closed: true,
      closedAtMs: FACE_C_CLOSED_MS,
      completionReason: "OK",
    },
  });
  assert.equal(
    judged.verdict,
    UNCONSUMED_VERDICT.MODIFIED_AFTER_CLOSURE,
    "★이 발화가 사라지면 ORCH 는 「소비 후 편집」과 새 커밋을 영영 몰랐을 것이다(실측 원문)",
  );
  assert.equal(
    judged.reasonCode,
    UNCONSUMED_REASON.RESULT_EDITED_AFTER_CLOSURE,
  );
  assert.equal(judged.details.closedAtMs, FACE_C_CLOSED_MS);
  // 실측된 편집 지연(23:08:29 -> 23:11:36 = 187초)이 그대로 실린다.
  assert.equal(judged.details.editedAfterClosureMs, 187_000);
  // ⛔그리고 「미소비」와 «다른 이름»이어야 한다 -- 사람이 취할 조치가 다르다.
  assert.notEqual(judged.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
});

test("★★HYK-448 요구2(헛수리 방지): 진짜 미소비는 여전히 발화한다 -- 원장이 «안 닫았고» 종료 표지도 있는 라운드는 새 입력을 다 줘도 SUSPECTED_UNCONSUMED 다 (3/3)", () => {
  // ⛔이 시험이 없으면 「전부 침묵」으로 통과시킨 헛수리가 된다.
  for (const [label, roundClosure] of [
    ["원장이 ACTIVE 로 안다(closed:false)", { closed: false }],
    ["원장을 못 읽었다(null)", null],
    ["원장 정보를 아예 안 넘겼다(undefined)", undefined],
  ]) {
    const judged = judgeFace({
      resultMs: FACE_A_RESULT_MS,
      nowMs: FACE_A_NOW_MS,
      terminalMarkerCount: 1, // 끝난 라운드다(형태 B 로 새지 않는다).
      roundClosure,
    });
    assert.equal(
      judged.verdict,
      UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
      `${label}: 닫혔다는 근거가 없으면 종전대로 발화해야 한다(모르면 침묵이 아니다)`,
    );
    assert.equal(judged.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_PAST_THRESHOLD);
  }
});

test("★HYK-448 회귀 0: 새 입력을 넘겨도 «신호가 있으면» 즉시 CONSUMED 이고 «임계 이내»면 NO_SIGNAL_TOO_EARLY 다 -- 이 라운드는 발화 자리 한 곳만 넓혔다 (2/2)", () => {
  const consumed = judgeUnconsumed({
    resultFile: { updatedAtMs: FACE_A_RESULT_MS, terminalMarkerCount: 0 },
    signals: [
      {
        kind: UNCONSUMED_SIGNAL_KIND.TASK_FILE_DROPPED_AFTER,
        atMs: FACE_A_RESULT_MS + 60_000,
      },
    ],
    now: FACE_A_NOW_MS,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
    // 닫혔다고 말해도 «신호» 경로가 먼저다 -- 종전 판정이 그대로 유지된다.
    roundClosure: { closed: true, closedAtMs: FACE_A_CLOSED_MS },
  });
  assert.equal(consumed.verdict, UNCONSUMED_VERDICT.CONSUMED);
  assert.equal(consumed.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_TASK_DROP);

  const tooEarly = judgeFace({
    resultMs: FACE_B_RESULT_MS,
    nowMs: FACE_B_RESULT_MS + 10_000, // 임계(300초) 이내.
    terminalMarkerCount: 0,
  });
  assert.equal(tooEarly.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  assert.equal(tooEarly.reasonCode, UNCONSUMED_REASON.NO_SIGNAL_TOO_EARLY);
});

test("★HYK-448 형식 위반은 조용히 무시하지 않는다: roundClosure 가 깨졌으면 CLOSURE_MALFORMED, terminalMarkerCount 가 깨졌으면 RESULT_FILE_INVALID (6/6)", () => {
  for (const bad of [
    { closed: "yes" }, // boolean 아님
    { closed: true }, // closedAtMs 없음
    { closed: true, closedAtMs: "23:08" }, // 유한수 아님
    { closed: true, closedAtMs: FACE_A_CLOSED_MS, completionReason: 7 },
  ]) {
    const judged = judgeFace({
      resultMs: FACE_A_RESULT_MS,
      nowMs: FACE_A_NOW_MS,
      roundClosure: bad,
    });
    assert.equal(judged.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(judged.reasonCode, UNCONSUMED_REASON.CLOSURE_MALFORMED);
  }
  for (const badCount of [-1, 1.5]) {
    const judged = judgeFace({
      resultMs: FACE_A_RESULT_MS,
      nowMs: FACE_A_NOW_MS,
      terminalMarkerCount: badCount,
    });
    assert.equal(judged.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
    assert.equal(judged.reasonCode, UNCONSUMED_REASON.RESULT_FILE_INVALID);
  }
});

test("NC mutation/unconsumed-core #4 (HYK-448): 원장 종결 갈래를 통째로 제거 -> RED (형태 A 가 다시 상시 발화한다)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "  if (roundClosure && roundClosure.closed) {",
      "  if (false) {",
    ),
  );
  const judged = mutant.judgeUnconsumed({
    resultFile: { updatedAtMs: FACE_A_RESULT_MS, terminalMarkerCount: 1 },
    signals: [],
    now: FACE_A_NOW_MS,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
    roundClosure: {
      closed: true,
      closedAtMs: FACE_A_CLOSED_MS,
      completionReason: "BLOCKED_TERMINATION_RELEASED",
    },
  });
  assert.equal(
    judged.verdict,
    UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    "mutant must go back to firing on a ledger-closed round (RED signal; proves the closure branch is load-bearing)",
  );
});

// ⛔이 시험의 이름은 반드시 `"NC mutation/<suite> #<n>` 로 «시작»해야 한다 --
// unconsumed-mutation-count.test.mjs 의 MUTATION_TEST_NAME_RE 가 그 형태만
// 세기 때문이다(1R 실측: 앞에 강조 기호를 붙였더니 #5 가 통째로 안 세어져
// 「1,2,3,4,6 -- 빈틈」으로 러너가 빨갛게 났다). 강조는 이름 «안»에 둔다.
test("NC mutation/unconsumed-core #5 (★HYK-448 §1-4 비타협): 「닫힌 뒤 변경」 갈래만 제거 -> RED (진짜 1건이 침묵으로 사라진다)", async () => {
  // ⛔이 변이가 잡아내는 것이 정확히 「원장이 닫았으면 무조건 침묵」이라는
  // 잘못된 번역이다 -- 그렇게 고쳤다면 이 시험이 빨강으로 죽는다.
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "    if (updatedAtMs > closedAtMs) {",
      "    if (false) {",
    ),
  );
  const judged = mutant.judgeUnconsumed({
    resultFile: { updatedAtMs: FACE_C_RESULT_MS, terminalMarkerCount: 1 },
    signals: [],
    now: FACE_C_NOW_MS,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
    roundClosure: { closed: true, closedAtMs: FACE_C_CLOSED_MS },
  });
  assert.equal(
    judged.verdict,
    UNCONSUMED_VERDICT.CONSUMED,
    "mutant must silently swallow the post-closure edit (RED signal; proves the true-positive branch is load-bearing)",
  );
});

test("NC mutation/unconsumed-core #6 (HYK-448): 「아직 안 끝난 라운드」 갈래 제거 -> RED (형태 B 가 다시 발화한다)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "  if (terminalMarkerCount === 0) {\n    return undecidable(UNCONSUMED_REASON.ROUND_NOT_FINISHED);\n  }\n",
      "",
    ),
  );
  const judged = mutant.judgeUnconsumed({
    resultFile: { updatedAtMs: FACE_B_RESULT_MS, terminalMarkerCount: 0 },
    signals: [],
    now: FACE_B_NOW_MS,
    thresholds: { minUnconsumedSeconds: THRESHOLD_S },
  });
  assert.equal(
    judged.verdict,
    UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    "mutant must go back to firing on an unfinished round (RED signal; proves the in-flight branch is load-bearing)",
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
