// HYK-255-p1-daily-1 (coder-task.md §2 ⓒ · 판정 2205 ④ · 2305 ②③) -- 일별 마감 줄 + 연속 확인-0 일수.
//
// ⛔헛시험 금지: 프로덕션 export 를 직접 구동한다 -- runPartialCountStep(watch-run 부분 계수 단계) ·
// runPartialCountOnce(실제 수집기) · partial-count-core 의 순수 함수. 사본 import 0. 저장소/파일은 전부
// mkdtemp 합성 watchDir · 주입 시계(now) · 가짜 fetchJson · 합성 원장 -- 실제 네트워크 · 관제실 · 받는함 쓰기 0.
// 코어 함수는 `core.<이름>` 네임스페이스로 부른다(없으면 칸 하나씩 TypeError 로 RED -- 링크 오류 하나로 뭉개지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import {
  runPartialCountStep,
  runWatchCliPartialCountStep,
} from "./watch-run.mjs";
import {
  createEmptyLedger,
  admitReservation,
} from "./admission-ledger-core.mjs";

const MIN = 60 * 1000;
// "2026-11-13 23:59" (KST) -> epoch ms. 분 단위 입력만 쓴다(초는 합성 시계에 불필요).
const kst = (s) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);

// HYK-255-p1fix-1 -- 새 칸 이름(uncountedExampleIds · V3-n). 옛 칸 이름 줄(uncountedRanges · U1..)은 «지나간 줄» 합성 입력
// (dailyLine)에만 남긴다 -- 읽는 쪽이 둘 다 받는지 보기 위함.
const UNCOUNTED_V3 = ["V3-1", "V3-2", "V3-3", "V3-4", "V3-5", "V3-6", "V3-7"];
const LEGACY_UNCOUNTED_V3 = ["U1", "U2", "U3", "U4", "U5", "U6", "U7"];
const ZERO = Object.freeze({
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  delivered: 3,
  uncountedExampleIds: UNCOUNTED_V3,
  uncountedVersion: "uncounted-examples/v3",
});

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

const STREAK_PREFIX = "연속 확인-0 일수: ";

// 주입 runPartialCountOnceFn -- 프로덕션 runPartialCountOnce 와 같은 «결과 모양»(reportText · dailyTick)을
// 돌려주고, 받은 confirmedZeroStreakLine 을 보고문에 그대로 싣는다(단계가 그 줄을 보고에 넘기는지 읽기 위함).
function fakeOnce(dailyTick) {
  const seen = [];
  const fn = async (args) => {
    seen.push(args);
    return {
      reportText: `집계 성격: PARTIAL — 전수 아님\n${args.confirmedZeroStreakLine ?? "(줄 없음)"}\n`,
      dailyTick,
    };
  };
  fn.seen = seen;
  return fn;
}

async function tickAt(watchDir, nowMs, dailyTick = ZERO, extra = {}) {
  return runPartialCountStep({
    watchDir,
    now: nowMs,
    logPath: join(watchDir, "watch.log"),
    runPartialCountOnceFn: fakeOnce(dailyTick),
    ...extra,
  });
}

const dailyPath = (watchDir) => join(watchDir, "partial-count-daily.jsonl");
const statePath = (watchDir) =>
  join(watchDir, "partial-count-daily-state.json");

function readDailyLines(watchDir) {
  if (!fs.existsSync(dailyPath(watchDir))) return [];
  return fs
    .readFileSync(dailyPath(watchDir), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

const readState = (watchDir) =>
  JSON.parse(fs.readFileSync(statePath(watchDir), "utf8"));

const streakLineOf = (watchDir) =>
  fs
    .readFileSync(join(watchDir, "partial-count-report.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(STREAK_PREFIX));

// 손으로 쓴 일별 줄(합성 입력) -- 읽는 쪽(연속 일수) 시험용.
function dailyLine(day, overrides = {}) {
  return {
    schema: "partial-count-daily/v1",
    day,
    closedAtMs: kst(`${day} 00:10`),
    lnConfirmed: 0,
    lnUnchecked: 0,
    collectorFails: [],
    coverageGaps: { count: 0, totalMs: 0 },
    concurrentTracksMax: 1,
    delivered: 3,
    uncountedRanges: LEGACY_UNCOUNTED_V3,
    ...overrides,
  };
}

function seedDaily(watchDir, lines) {
  fs.writeFileSync(
    dailyPath(watchDir),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

// ---- ⑴ 같은 날 회차 · 자정 · 덧붙이기 전용 ------------------------------------------

test("⑴ 같은 날 회차 3번 -> 상태 파일만 갱신(회차 3 · 마지막 값) · 일별 줄 0", async () => {
  const dir = tmpDir("nc-daily-same-");
  try {
    await tickAt(dir, kst("2026-11-13 09:00"), { ...ZERO, lnConfirmed: 5 });
    await tickAt(dir, kst("2026-11-13 09:15"), { ...ZERO, lnConfirmed: 6 });
    await tickAt(dir, kst("2026-11-13 09:30"), { ...ZERO, lnConfirmed: 7 });
    assert.equal(fs.existsSync(dailyPath(dir)), false, "일별 줄 파일 없음");
    const s = readState(dir);
    assert.equal(s.day, "2026-11-13");
    assert.equal(s.ticks, 3);
    assert.equal(s.lnConfirmed, 7, "상태 = 그날 마지막 회차 값(덮어씀)");
    assert.equal(s.lastTickAtMs, kst("2026-11-13 09:30"));
    assert.equal(s.firstTickAtMs, kst("2026-11-13 09:00"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑵ KST 자정을 넘긴 첫 회차 -> 전날 줄 정확히 1 · 값 = 그날 마지막 회차 값 · 첫 회차 값 아님", async () => {
  const dir = tmpDir("nc-daily-midnight-");
  try {
    await tickAt(dir, kst("2026-11-13 00:05"), {
      ...ZERO,
      lnConfirmed: 1,
      lnUnchecked: 4,
      delivered: 1,
    });
    await tickAt(dir, kst("2026-11-13 23:45"), {
      ...ZERO,
      lnConfirmed: 0,
      lnUnchecked: 0,
      delivered: 9,
    });
    assert.equal(readDailyLines(dir).length, 0, "자정 전 줄 0");
    // 23:59 -> 00:14 : 이 간격은 15분(공백 아님) 이다.
    await tickAt(dir, kst("2026-11-13 23:59"), { ...ZERO, delivered: 9 });
    await tickAt(dir, kst("2026-11-14 00:14"), { ...ZERO, delivered: 2 });
    const lines = readDailyLines(dir);
    assert.equal(lines.length, 1, "전날 줄 정확히 1");
    const l = lines[0];
    assert.equal(l.schema, "partial-count-daily/v1");
    assert.equal(l.day, "2026-11-13");
    assert.equal(l.lnConfirmed, 0, "그날 마지막 회차 값");
    assert.equal(l.lnUnchecked, 0);
    assert.deepEqual(l.collectorFails, []);
    assert.equal(l.delivered, 9, "마지막 회차(23:59)의 delivered");
    assert.equal(l.firstTickAtMs, kst("2026-11-13 00:05"));
    assert.equal(l.lastTickAtMs, kst("2026-11-13 23:59"));
    assert.equal(l.closedAtMs, kst("2026-11-14 00:14"));
    assert.equal(l.ticks, 3);
    // 00:05 -> 23:45 는 회차를 채우지 않아 23시간 40분 공백 1 · 23:45 -> 23:59(14분) · 23:59 -> 24:00(1분)은 아님.
    assert.deepEqual(l.coverageGaps, {
      count: 1,
      totalMs: (23 * 60 + 40) * MIN,
    });
    assert.deepEqual(l.uncountedExampleIds, UNCOUNTED_V3);
    assert.equal(Object.hasOwn(l, "uncountedRanges"), false, "옛 칸 이름 없음");
    // 새 날의 상태는 새 날 값으로 시작한다.
    const s = readState(dir);
    assert.equal(s.day, "2026-11-14");
    assert.equal(s.ticks, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑶ 이미 있는 줄은 바이트 무변 · 같은 날 재실행도 줄이 늘지 않는다(덧붙이기 전용)", async () => {
  const dir = tmpDir("nc-daily-append-only-");
  try {
    await tickAt(dir, kst("2026-11-13 23:50"));
    await tickAt(dir, kst("2026-11-14 00:05"));
    const first = fs.readFileSync(dailyPath(dir));
    await tickAt(dir, kst("2026-11-14 00:20"));
    await tickAt(dir, kst("2026-11-14 23:50"), { ...ZERO, lnConfirmed: 2 });
    await tickAt(dir, kst("2026-11-15 00:05"), { ...ZERO, lnConfirmed: 2 });
    const second = fs.readFileSync(dailyPath(dir));
    assert.ok(
      second.subarray(0, first.length).equals(first),
      "앞의 줄은 바이트 그대로",
    );
    assert.equal(readDailyLines(dir).length, 2, "날마다 정확히 1줄");
    assert.equal(second.at(-1), 0x0a, "줄은 개행으로 끝난다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑷ 전날 줄이 이미 파일에 있으면(상태 파일만 남은 재실행) 같은 날 줄을 또 쓰지 않는다", async () => {
  const dir = tmpDir("nc-daily-idem-");
  try {
    await tickAt(dir, kst("2026-11-13 23:50"));
    const stateBefore = fs.readFileSync(statePath(dir), "utf8");
    await tickAt(dir, kst("2026-11-14 00:05"));
    assert.equal(readDailyLines(dir).length, 1);
    // 상태 파일을 «전날 상태» 로 되돌린다(줄은 썼는데 상태 쓰기가 실패한 상황의 합성).
    fs.writeFileSync(statePath(dir), stateBefore, "utf8");
    await tickAt(dir, kst("2026-11-14 00:20"));
    assert.equal(readDailyLines(dir).length, 1, "중복 줄 0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ⑸ 관측 공백(20분 초과) ----------------------------------------------------------

test("⑸ 관측 공백: 회차 간격 21분 = 공백 1 · 15분 = 0 · 정확히 20분 = 0(초과만) · 합계는 초과 구간 길이", async () => {
  const dir = tmpDir("nc-daily-gap-exact-");
  try {
    await tickAt(dir, kst("2026-11-13 00:10")); // 00:00 -> 00:10 = 10분
    await tickAt(dir, kst("2026-11-13 00:31")); // 21분 -> 공백
    await tickAt(dir, kst("2026-11-13 00:46")); // 15분
    await tickAt(dir, kst("2026-11-13 01:06")); // 정확히 20분
    const s = readState(dir);
    assert.equal(s.gapCount, 1, "21분 1건만");
    assert.equal(s.gapTotalMs, 21 * MIN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑹ 00:00 -> 첫 회차가 25분 = 공백(자정에서 재기) · 20분 = 공백 아님", async () => {
  const late = tmpDir("nc-daily-from-midnight-");
  const ok = tmpDir("nc-daily-from-midnight-ok-");
  try {
    await tickAt(late, kst("2026-11-13 00:25"));
    await tickAt(late, kst("2026-11-13 00:40"));
    assert.equal(readState(late).gapCount, 1);
    assert.equal(readState(late).gapTotalMs, 25 * MIN);
    await tickAt(ok, kst("2026-11-13 00:20"));
    assert.equal(readState(ok).gapCount, 0, "정확히 20분은 공백 아님");
  } finally {
    fs.rmSync(late, { recursive: true, force: true });
    fs.rmSync(ok, { recursive: true, force: true });
  }
});

test("⑺ 마지막 회차 -> 24:00 이 30분 = 공백(마감 때 판정) · 10분 = 공백 아님", async () => {
  const far = tmpDir("nc-daily-to-midnight-");
  const near = tmpDir("nc-daily-to-midnight-ok-");
  try {
    // 00:05 시작 -> 23:30 마지막 회차(사이는 같은 날 큰 공백이 아니도록 15분 간격 대신 한 번에 건너뛰지 않는다):
    // 상태를 직접 쓰지 않고 «첫 회차 23:30» 하나로 -- 00:00 -> 23:30 공백 1 + 23:30 -> 24:00(30분) 공백 1 = 2.
    await tickAt(far, kst("2026-11-13 23:30"));
    await tickAt(far, kst("2026-11-14 00:05"));
    const l = readDailyLines(far)[0];
    assert.equal(
      l.coverageGaps.count,
      2,
      "자정 -> 첫 회차(23:30) + 마지막 회차 -> 24:00(30분)",
    );
    assert.equal(l.coverageGaps.totalMs, (23 * 60 + 30) * MIN + 30 * MIN);
    await tickAt(near, kst("2026-11-13 23:50"));
    await tickAt(near, kst("2026-11-14 00:05"));
    const l2 = readDailyLines(near)[0];
    assert.equal(
      l2.coverageGaps.count,
      1,
      "자정 -> 23:50 만 공백 · 23:50 -> 24:00(10분)은 아님",
    );
    assert.equal(l2.coverageGaps.totalMs, (23 * 60 + 50) * MIN);
  } finally {
    fs.rmSync(far, { recursive: true, force: true });
    fs.rmSync(near, { recursive: true, force: true });
  }
});

test("⑻ 절전 645분(같은 날 안) = 공백 1 · 합계 645분", async () => {
  const dir = tmpDir("nc-daily-sleep-");
  try {
    await tickAt(dir, kst("2026-11-13 00:05"));
    await tickAt(dir, kst("2026-11-13 00:20"));
    await tickAt(dir, kst("2026-11-13 11:05")); // 00:20 + 645분
    const s = readState(dir);
    assert.equal(s.gapCount, 1);
    assert.equal(s.gapTotalMs, 645 * MIN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⑼ 하루 통째 빔(11-13 다음 회차가 11-15) -> 11-13 줄만 있고 11-14 줄 없음 -> 연속 일수 끊김(사유 줄 없음)", async () => {
  const dir = tmpDir("nc-daily-empty-day-");
  try {
    await tickAt(dir, kst("2026-11-13 23:50"));
    await tickAt(dir, kst("2026-11-15 00:05"));
    const lines = readDailyLines(dir);
    assert.deepEqual(
      lines.map((l) => l.day),
      ["2026-11-13"],
    );
    await tickAt(dir, kst("2026-11-15 00:20"));
    const line = streakLineOf(dir);
    assert.ok(line.startsWith(`${STREAK_PREFIX}0일(`), line);
    assert.ok(line.includes("2026-11-14"), "끊김 날짜 = 줄 없는 날");
    assert.ok(line.includes("줄 없음"), line);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ⑽ 연속 확인-0 일수(읽는 쪽) -----------------------------------------------------

async function streakWith(
  lines,
  nowKst = "2026-11-14 10:00",
  dailyTick = ZERO,
) {
  const dir = tmpDir("nc-daily-streak-");
  try {
    seedDaily(dir, lines);
    await tickAt(dir, kst(nowKst), dailyTick);
    return streakLineOf(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("⑽ 연속 확인-0: 어제까지 3일 깨끗 + 그 전날 줄 없음 -> 3일 · 미계수 범위 7개 동반 · 마지막 끊김 날짜·사유", async () => {
  const line = await streakWith([
    dailyLine("2026-11-13"),
    dailyLine("2026-11-12"),
    dailyLine("2026-11-11"),
  ]);
  assert.equal(
    line,
    `${STREAK_PREFIX}3일(부분 — 미계수 범위 7개 동반 · 마지막 끊김 2026-11-10 줄 없음)`,
  );
});

test("⑾ 미조회 1 = 끊김 · 수집 실패 1 = 끊김 · 확인 1 = 끊김 · 관측 공백 1 = 끊김(각각 그날에서 멈춘다)", async () => {
  const cases = [
    [{ lnUnchecked: 1 }, "미조회"],
    [{ lnUnchecked: null }, "미조회"],
    [{ collectorFails: ["외부독립증거후보수집기"] }, "수집 실패"],
    [{ lnConfirmed: 1 }, "확인"],
    [{ lnConfirmed: null }, "확인"],
    [{ coverageGaps: { count: 1, totalMs: 21 * MIN } }, "관측 공백"],
  ];
  for (const [override, word] of cases) {
    const line = await streakWith([
      dailyLine("2026-11-13"),
      dailyLine("2026-11-12", override),
      dailyLine("2026-11-11"),
    ]);
    assert.ok(line.startsWith(`${STREAK_PREFIX}1일(`), `${word}: ${line}`);
    assert.ok(line.includes("마지막 끊김 2026-11-12"), `${word}: ${line}`);
    assert.ok(line.includes(word), `${word}: ${line}`);
  }
});

test("⑿ 어제 줄이 끊겼으면 0일 · 셋 다 0 + 공백 0 이면 이어진다 · 오늘(미마감) 줄은 세지 않는다", async () => {
  const broken = await streakWith([
    dailyLine("2026-11-13", { lnUnchecked: 2 }),
    dailyLine("2026-11-12"),
  ]);
  assert.ok(broken.startsWith(`${STREAK_PREFIX}0일(`), broken);
  assert.ok(broken.includes("마지막 끊김 2026-11-13"), broken);
  // 오늘 날짜(2026-11-14) 줄이 파일에 있어도(손으로 넣은 합성) 세지 않는다 -- 어제부터 거꾸로.
  const withToday = await streakWith([
    dailyLine("2026-11-14"),
    dailyLine("2026-11-13", { lnUnchecked: 2 }),
  ]);
  assert.ok(withToday.startsWith(`${STREAK_PREFIX}0일(`), withToday);
});

test("⒀ 일별 줄이 하나도 없으면(첫 실행) 0일 · 줄 없음 -- 0 으로 접지 않고 끊김 사유를 적는다", async () => {
  const dir = tmpDir("nc-daily-nofile-");
  try {
    await tickAt(dir, kst("2026-11-14 10:00"));
    const line = streakLineOf(dir);
    assert.equal(
      line,
      `${STREAK_PREFIX}0일(부분 — 마지막 끊김 2026-11-13 줄 없음)`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⒁ 같은 날 두 줄(중복) · 깨진 줄 · 낯선 schema 는 그날을 끊김으로 둔다(UNKNOWN 을 0 으로 접지 않는다)", async () => {
  const dup = await streakWith([
    dailyLine("2026-11-13"),
    dailyLine("2026-11-13"),
  ]);
  assert.ok(dup.startsWith(`${STREAK_PREFIX}0일(`), dup);
  const dir = tmpDir("nc-daily-bad-");
  try {
    fs.writeFileSync(
      dailyPath(dir),
      `${JSON.stringify(dailyLine("2026-11-12"))}\n{깨진 줄\n${JSON.stringify({ ...dailyLine("2026-11-13"), schema: "other/v9" })}\n`,
      "utf8",
    );
    await tickAt(dir, kst("2026-11-14 10:00"));
    const line = streakLineOf(dir);
    assert.ok(line.startsWith(`${STREAK_PREFIX}0일(`), line);
    assert.ok(line.includes("마지막 끊김 2026-11-13"), line);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⒂ 일별 파일을 읽지 못하면(디렉터리가 파일 자리에) UNKNOWN(사유) 줄 -- 숫자를 지어내지 않고 단계는 죽지 않는다", async () => {
  const dir = tmpDir("nc-daily-unreadable-");
  try {
    fs.mkdirSync(dailyPath(dir));
    const step = await tickAt(dir, kst("2026-11-14 10:00"));
    assert.equal(step.ok, true, "단계는 계속된다");
    const line = streakLineOf(dir);
    assert.ok(line.startsWith(`${STREAK_PREFIX}UNKNOWN(`), line);
    assert.ok(
      fs.readFileSync(join(dir, "watch.log"), "utf8").includes("DAILY"),
      "watch.log 에 일별 실패 줄",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ⒃ 동시 배달 최대 · 회차 표본 -------------------------------------------------

function writeLedger(file, activeCount) {
  let ledger = createEmptyLedger("2026-11-13T00:00:00.000Z");
  for (let i = 0; i < activeCount; i++) {
    const r = admitReservation(ledger, {
      reservationId: `res-${i}`,
      cap: 99,
      now: "2026-11-13T00:01:00.000Z",
      role: "CODER",
      seatKey: `seat-${i}`,
    });
    assert.equal(r.ok, true);
    ledger = r.ledger;
  }
  fs.writeFileSync(file, JSON.stringify(ledger), "utf8");
}

test("⒃ 그날 동시 배달 최대 = 회차 표본(원장 활성 예약 수)의 최대 -- 마지막 회차 값이 아니다 · 원장은 읽기만", async () => {
  const dir = tmpDir("nc-daily-conc-");
  try {
    const ledgerPath = join(dir, "admission-ledger.json");
    const samples = [1, 3, 2];
    let at = kst("2026-11-13 10:00");
    for (const n of samples) {
      writeLedger(ledgerPath, n);
      await tickAt(dir, at, ZERO, { admissionLedgerPath: ledgerPath });
      at += 15 * MIN;
    }
    const before = fs.readFileSync(ledgerPath);
    assert.equal(readState(dir).concurrentTracksMax, 3);
    await tickAt(dir, kst("2026-11-14 00:05"), ZERO, {
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(readDailyLines(dir)[0].concurrentTracksMax, 3);
    assert.ok(fs.readFileSync(ledgerPath).equals(before), "원장 바이트 무변");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⒄ 원장 경로가 없거나 못 읽으면 그 회차 표본은 «모름»(null) -- 0 으로 접지 않는다", async () => {
  const dir = tmpDir("nc-daily-conc-unknown-");
  try {
    await tickAt(dir, kst("2026-11-13 10:00"));
    assert.equal(readState(dir).concurrentTracksMax, null);
    await tickAt(dir, kst("2026-11-13 10:15"), ZERO, {
      admissionLedgerPath: join(dir, "없는-원장.json"),
    });
    assert.equal(readState(dir).concurrentTracksMax, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⒅ runWatchCliPartialCountStep 은 argv 의 --admission-sweep-ledger 를 단계에 admissionLedgerPath 로 넘긴다(새 CLI 인자 0)", async () => {
  let got = null;
  await runWatchCliPartialCountStep({
    argv: ["--repo-root", "R", "--admission-sweep-ledger", "L.json"],
    repoRoot: "R",
    watchDir: "W",
    now: 1,
    result: { logPath: "W/watch.log" },
    runPartialCountStepFn: async (args) => {
      got = args;
      return {};
    },
  });
  assert.equal(got.admissionLedgerPath, "L.json");
  let none = null;
  await runWatchCliPartialCountStep({
    argv: ["--repo-root", "R"],
    repoRoot: "R",
    watchDir: "W",
    now: 1,
    result: { logPath: "W/watch.log" },
    runPartialCountStepFn: async (args) => {
      none = args;
      return {};
    },
  });
  assert.equal(none.admissionLedgerPath ?? null, null);
});

// ---- ⒆ 단계 실패 · 상태 파일 손상 -----------------------------------------------------

test("⒆ 부분 계수 수집이 던져도 그 회차는 일별 상태에 «수집 실패» 로 기록된다(회차가 돌았다는 사실은 남는다)", async () => {
  const dir = tmpDir("nc-daily-throw-");
  try {
    const step = await runPartialCountStep({
      watchDir: dir,
      now: kst("2026-11-13 09:00"),
      logPath: join(dir, "watch.log"),
      runPartialCountOnceFn: async () => {
        throw new Error("injected collector failure");
      },
    });
    assert.equal(step.ok, false);
    const s = readState(dir);
    assert.equal(s.ticks, 1);
    assert.ok(s.collectorFails.length >= 1, "실패 회차 = 수집 실패 표지");
    assert.equal(s.lnConfirmed, null);
    assert.equal(s.lnUnchecked, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("⒇ 결과에 dailyTick 이 없으면(옛 수집기) 그 회차는 수집 실패 표지 -- 0 으로 접지 않는다", async () => {
  const dir = tmpDir("nc-daily-notick-");
  try {
    await runPartialCountStep({
      watchDir: dir,
      now: kst("2026-11-13 09:00"),
      logPath: join(dir, "watch.log"),
      runPartialCountOnceFn: async () => ({ reportText: "x\n" }),
    });
    const s = readState(dir);
    assert.ok(s.collectorFails.length >= 1);
    assert.equal(s.lnConfirmed, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(21) 상태 파일이 깨져 있으면 전날 줄을 지어내지 않고(줄 없음 = 끊김) watch.log 에 사유 · 새 상태로 다시 시작", async () => {
  const dir = tmpDir("nc-daily-corrupt-");
  try {
    fs.writeFileSync(statePath(dir), "{깨진", "utf8");
    await tickAt(dir, kst("2026-11-14 00:05"));
    assert.equal(readDailyLines(dir).length, 0);
    assert.equal(readState(dir).day, "2026-11-14");
    assert.ok(
      fs.readFileSync(join(dir, "watch.log"), "utf8").includes("DAILY"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (22) 순수 함수 · 날 경계 ---------------------------------------------------------

test("(22) KST 날 경계: 23:59:59 KST 와 00:00:00 KST 는 다른 날 · UTC 자정(09:00 KST)은 날 경계가 아니다", () => {
  assert.equal(
    core.kstDayOf(Date.parse("2026-11-13T23:59:59+09:00")),
    "2026-11-13",
  );
  assert.equal(
    core.kstDayOf(Date.parse("2026-11-14T00:00:00+09:00")),
    "2026-11-14",
  );
  assert.equal(
    core.kstDayOf(Date.parse("2026-11-13T09:00:00+09:00")),
    "2026-11-13",
  );
  assert.equal(
    core.kstDayOf(Date.parse("2026-11-13T08:59:59+09:00")),
    "2026-11-13",
  );
  // UTC 날짜는 09:00 KST 에 바뀐다 -- KST 날은 그때 바뀌지 않는다.
  assert.equal(core.kstDayOf(Date.parse("2026-11-13T09:00:00Z")), "2026-11-13");
  assert.equal(core.kstDayOf(Date.parse("2026-11-13T15:00:00Z")), "2026-11-14");
});

test("(23) 그날 마지막 회차의 24시간 창 · 줄 모양 필드(schema · day · windowStartMs/EndMs · closedAtMs · 첫/마지막 회차 · uncountedExampleIds)", async () => {
  const dir = tmpDir("nc-daily-shape-");
  try {
    await tickAt(dir, kst("2026-11-13 23:50"));
    await tickAt(dir, kst("2026-11-14 00:05"));
    const l = readDailyLines(dir)[0];
    assert.equal(l.windowEndMs, kst("2026-11-13 23:50"));
    assert.equal(l.windowStartMs, kst("2026-11-13 23:50") - 24 * 60 * MIN);
    for (const key of [
      "schema",
      "day",
      "windowStartMs",
      "windowEndMs",
      "closedAtMs",
      "firstTickAtMs",
      "lastTickAtMs",
      "ticks",
      "lnConfirmed",
      "lnUnchecked",
      "collectorFails",
      "coverageGaps",
      "concurrentTracksMax",
      "delivered",
      "uncountedExampleIds",
    ]) {
      assert.ok(key in l, `필드 ${key}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (24) 실제 수집기(runPartialCountOnce) 구동 -- dailyTick · 보고 줄 -----------------

function git(cwd, args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

const REPO_SLUG = "hykim82/HARNESSENGINEERING";

async function runRealOnce(options) {
  const root = tmpDir("nc-daily-real-");
  const repo = tmpDir("nc-daily-real-repo-");
  try {
    git(repo, ["init", "-q"]);
    fs.mkdirSync(join(repo, "scripts", "supervisor"), { recursive: true });
    fs.writeFileSync(
      join(repo, "scripts", "supervisor", "approver-allowlist.json"),
      JSON.stringify({
        schema_version: "approver-allowlist/v1",
        repo: REPO_SLUG,
        approvers: [{ login: "hykim82", id: 286230306 }],
      }),
      "utf8",
    );
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "root"]);
    git(repo, [
      "remote",
      "add",
      "origin",
      `https://github.com/${REPO_SLUG}.git`,
    ]);
    git(repo, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    return await report.runPartialCountOnce({
      now: kst("2026-11-14 10:00"),
      repoRoot: repo,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      fetchJson: async () => ({
        ok: false,
        status: 404,
        json: null,
        linkHeader: null,
      }),
      git: report.createProcessGitPort(repo),
      gitWorktreeListExecFn: () => "",
      ...options,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("(24) 실제 runPartialCountOnce: dailyTick = 그 회차 보고가 센 값(확인 · 미조회 · 수집 실패 목록 · 미계수 범위) -- 보고문과 같은 원천", async () => {
  const result = await runRealOnce({});
  const t = result.dailyTick;
  assert.ok(t, "dailyTick 이 결과에 있다");
  // 외부 증거 수집이 known 이면 보고 줄의 «확인 N · 미조회 U» 와 같은 값이다.
  const m = /^- 외부 독립 증거 후보: 확인 (\d+) · 미조회 (\d+)/m.exec(
    result.reportText,
  );
  if (m) {
    assert.equal(t.lnConfirmed, Number(m[1]));
    assert.equal(t.lnUnchecked, Number(m[2]));
  } else {
    assert.equal(t.lnConfirmed, null, "수집 실패면 0 이 아니라 null");
    assert.equal(t.lnUnchecked, null);
    assert.ok(t.collectorFails.length >= 1);
  }
  // 수집기 목록의 FAIL 이름이 collectorFails 에 그대로 반영된다.
  const failNames = [...result.reportText.matchAll(/(\S+) FAIL\(/g)].length;
  assert.ok(t.collectorFails.length >= (failNames > 0 ? 1 : 0));
  assert.equal(Array.isArray(t.uncountedExampleIds), true);
  assert.ok(t.uncountedExampleIds.length >= 1);
  assert.ok(t.uncountedExampleIds.every((s) => /^V\d+-\d+$/.test(s)));
  assert.equal(Object.hasOwn(t, "uncountedRanges"), false);
  assert.match(t.uncountedVersion, /^uncounted-examples\/v\d+$/);
});

test("(25) 실제 단계 종단: 단계가 연속 일수 줄을 «1-C 판정 자격» 줄 바로 아래에 싣고, 1-C 줄은 바이트 무변 · 문턱 판정 문면 0", async () => {
  const dir = tmpDir("nc-daily-e2e-");
  const repo = tmpDir("nc-daily-e2e-repo-");
  try {
    seedDaily(dir, [dailyLine("2026-11-13"), dailyLine("2026-11-12")]);
    git(repo, ["init", "-q"]);
    await runPartialCountStep({
      watchDir: dir,
      now: kst("2026-11-14 10:00"),
      logPath: join(dir, "watch.log"),
      options: {
        repoRoot: repo,
        dispatchReceiptsPath: join(dir, "none.jsonl"),
        watchLogPath: join(dir, "watch.log"),
        maxMergeChecks: 0,
        maxExternalEvidenceChecks: 0,
        extraRepoRoots: [],
        archiveRoot: join(dir, "archive-missing"),
      },
    });
    const text = fs.readFileSync(join(dir, "partial-count-report.md"), "utf8");
    const lines = text.split("\n");
    const i1c = lines.indexOf(
      "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가",
    );
    assert.ok(i1c >= 0, "1-C 판정 자격 줄 바이트 무변");
    assert.ok(lines[i1c + 1].startsWith(STREAK_PREFIX), lines[i1c + 1]);
    assert.match(
      lines[i1c + 1],
      /^연속 확인-0 일수: 2일\(부분 — 미계수 범위 \d+개 동반 · 마지막 끊김 2026-11-11 줄 없음\)$/,
    );
    // 문턱 판정 0: «자격 있음» · «충족» · «달성» 류 문면이 없다.
    assert.ok(!/자격: 있음|충족|달성|통과/.test(text), "문턱 판정 문면 0");
    assert.ok(!lines[i1c + 1].includes("ㄴ=0"), "«ㄴ=0» 문면 금지");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("(26) 미결선 호출자(스트릭 줄 인자 없음)의 보고문은 새 줄 0개 -- 기존 출력 무변", () => {
  const text = core.buildPartialCountReport({
    generatedAtMs: kst("2026-11-14 10:00"),
    windowStartMs: kst("2026-11-13 10:00"),
    windowEndMs: kst("2026-11-14 10:00"),
    delivered: { known: true, count: 0 },
    consumed: { known: true, count: 0 },
    missingReceipts: { known: true, count: 0 },
    gate4: {
      known: true,
      candidatesInWindow: 0,
      checked: 0,
      approved: 0,
      notApproved: 0,
      undecidable: 0,
      uncheckedByBudget: 0,
      undecidableReasons: {},
      uncheckedReasons: {},
    },
    suspected: { known: true, closedCount: 0, openCount: 0 },
    coverageGaps: { known: true, count: 0, totalMs: 0 },
  });
  assert.ok(!text.includes(STREAK_PREFIX));
});

test("(27) 순수 함수: computeConfirmedZeroStreak 는 어제부터 거꾸로 · 줄 없는 날에서 멈춘다 · 입력을 바꾸지 않는다", () => {
  const lines = [dailyLine("2026-11-13"), dailyLine("2026-11-12")];
  const snapshot = JSON.stringify(lines);
  const s = core.computeConfirmedZeroStreak({
    lines,
    nowMs: kst("2026-11-14 10:00"),
  });
  assert.equal(s.days, 2);
  assert.equal(s.lastBreak.day, "2026-11-11");
  assert.equal(JSON.stringify(lines), snapshot);
  assert.equal(
    core.renderConfirmedZeroStreakLine(s),
    `${STREAK_PREFIX}2일(부분 — 미계수 범위 7개 동반 · 마지막 끊김 2026-11-11 줄 없음)`,
  );
});
