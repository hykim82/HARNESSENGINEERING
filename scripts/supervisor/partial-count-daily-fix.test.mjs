// HYK-255-p1fix-1 (판정 2026-11-14 0206 ③④ · 검토 1R P2-1 · P2-2) -- 일별 줄 수리 시험.
//
//   (가) 칸 이름 uncountedRanges -> uncountedExampleIds · 값 = «V<판본>-<순번>» (설계 U-id 와 문자열이 겹치지 않는다)
//   (나) 자정을 걸친 회차 간격 = 하나로 재고, 20분 초과면 두 날 각각에 공백 1(몫 = 그 날 안에 든 길이)
//   (다) 일별 줄 창 시작 = 직전 일별 줄의 창 끝(없으면 그날 첫 회차의 창 시작)
//
// ⛔헛시험 금지: 프로덕션 export 를 직접 구동한다 -- runPartialCountStep(watch-run 부분 계수 단계) · partial-count-core 의
// 순수 함수. 사본 import 0. 저장소/파일은 전부 mkdtemp 합성 watchDir · 주입 시계(now) -- 실제 네트워크 · 관제실 쓰기 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "./partial-count-core.mjs";
import { runPartialCountStep } from "./watch-run.mjs";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const kst = (s) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);

const tmpDir = (prefix) => fs.mkdtempSync(join(tmpdir(), prefix));
const dailyPath = (dir) => join(dir, "partial-count-daily.jsonl");
const statePath = (dir) => join(dir, "partial-count-daily-state.json");
const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), "utf8"));
const readLines = (dir) =>
  fs.existsSync(dailyPath(dir))
    ? fs
        .readFileSync(dailyPath(dir), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : [];

// 프로덕션 값 만들기(buildDailyTickValues)를 그대로 쓴다 -- 칸 이름 · 값 꼴이 «만드는 곳» 에서 검증된다.
const TICK = core.buildDailyTickValues({
  externalEvidence: { known: true, confirmedShas: [], unchecked: 0 },
  collectors: [],
  delivered: { known: true, count: 3 },
  uncountedExamples: core.UNCOUNTED_EXAMPLES_V3,
  permissionAnswers: { known: true, humanTotal: 0, undecided: 0 },
});

function fakeOnce(dailyTick) {
  return async (args) => ({
    reportText: `집계 성격: PARTIAL — 전수 아님\n${args.confirmedZeroStreakLine ?? ""}\n`,
    dailyTick,
  });
}

async function tickAt(dir, nowMs, dailyTick = TICK) {
  return runPartialCountStep({
    watchDir: dir,
    now: nowMs,
    logPath: join(dir, "watch.log"),
    runPartialCountOnceFn: fakeOnce(dailyTick),
  });
}

// 그날을 «틈 없이» 돈다: 마지막 회차(last)에서 15분씩 거슬러 올라가 날 시작 15분 안의 첫 회차까지.
// 첫 회차가 00:00 에서 15분 미만이라 날 안 공백은 0 이다(자정 걸친 공백만 따로 본다).
async function runDay(dir, day, last, dailyTick = TICK) {
  const start = core.kstDayStartMs(day);
  const times = [kst(`${day} ${last}`)];
  while (times[0] - 15 * MIN >= start) times.unshift(times[0] - 15 * MIN);
  for (const t of times) await tickAt(dir, t, dailyTick);
  return times;
}

function stringValues(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringValues(x, out));
  else if (v && typeof v === "object") {
    Object.values(v).forEach((x) => stringValues(x, out));
  }
  return out;
}

// ---- (가) 칸 이름 · 값 꼴 ------------------------------------------------------------------

test("(가-1) 회차 값 = uncountedExampleIds [V3-1..] · 옛 칸 uncountedRanges 는 만들지 않는다 · uncountedVersion 은 남는다", () => {
  const n = core.UNCOUNTED_EXAMPLES_V3.items.length;
  assert.deepEqual(
    TICK.uncountedExampleIds,
    Array.from({ length: n }, (_, i) => `V3-${i + 1}`),
  );
  assert.equal(TICK.uncountedExampleIds[1], "V3-2");
  assert.equal(Object.hasOwn(TICK, "uncountedRanges"), false);
  assert.equal(TICK.uncountedVersion, "uncounted-examples/v3");
  // 판본이 다르면 접두도 다르다(V1 · V2 가 V3 와 섞이지 않는다).
  const v1 = core.buildDailyTickValues({
    uncountedExamples: core.UNCOUNTED_EXAMPLES_V1,
  });
  assert.ok(v1.uncountedExampleIds.every((s) => /^V1-\d+$/.test(s)));
});

test("(가-2) 판본을 읽을 수 없으면 설계 U-id 와 안 겹치는 접두 VX 로 적는다", () => {
  const t = core.buildDailyTickValues({
    uncountedExamples: { version: null, items: ["a", "b"] },
  });
  assert.deepEqual(t.uncountedExampleIds, ["VX-1", "VX-2"]);
});

test("(가-3) 마감 줄: uncountedExampleIds 에 V3-2 · U-id 문자열 0 · P5a 새 칸 2개는 수 또는 null(문자열 0) · 충돌 0", async () => {
  const dir = tmpDir("nc-fix-names-");
  try {
    await tickAt(dir, kst("2026-11-13 23:50"));
    await tickAt(dir, kst("2026-11-14 00:05"));
    const [line] = readLines(dir);
    assert.ok(line.uncountedExampleIds.includes("V3-2"));
    assert.equal(Object.hasOwn(line, "uncountedRanges"), false);
    assert.equal(line.uncountedVersion, "uncounted-examples/v3");
    const strings = stringValues(line);
    assert.deepEqual(
      strings.filter((s) => /^U\d+$/.test(s)),
      [],
      "줄 전체에 설계 U-id 꼴 문자열 0",
    );
    const idSet = new Set(line.uncountedExampleIds);
    for (const [key, value] of Object.entries(line)) {
      if (key === "uncountedExampleIds") continue;
      assert.equal(
        stringValues(value).some((s) => idSet.has(s) || /^V\d+-\d+$/.test(s)),
        false,
        `${key} 값이 예시 식별자와 겹침`,
      );
    }
    // P5a 새 칸 2개: 이름 · 값이 예시 식별자 이름공간 밖(값은 건수 또는 null).
    for (const key of ["permissionHumanAnswers", "permissionUndecidable"]) {
      assert.ok(Object.hasOwn(line, key), key);
      assert.ok(Number.isInteger(line[key]) || line[key] === null, key);
      assert.equal(/^[UV]\d/.test(key), false, `칸 이름 ${key}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(가-4) 옛 칸 이름 상태 파일(uncountedRanges · U1..)이 마감될 때 새 줄은 V 꼴로 옮겨 적는다 · 옛 칸 이름은 줄에 없다", async () => {
  const dir = tmpDir("nc-fix-legacy-state-");
  try {
    fs.writeFileSync(
      statePath(dir),
      JSON.stringify({
        schema: "partial-count-daily-state/v1",
        day: "2026-11-13",
        firstTickAtMs: kst("2026-11-13 23:40"),
        lastTickAtMs: kst("2026-11-13 23:55"),
        ticks: 2,
        gapCount: 1,
        gapTotalMs: 100 * MIN,
        lnConfirmed: 0,
        lnUnchecked: 0,
        collectorFails: [],
        concurrentTracksMax: 1,
        delivered: 3,
        uncountedRanges: ["U1", "U2", "U3"],
        uncountedVersion: "uncounted-examples/v3",
      }),
      "utf8",
    );
    await tickAt(dir, kst("2026-11-14 00:05"));
    const [line] = readLines(dir);
    assert.deepEqual(line.uncountedExampleIds, ["V3-1", "V3-2", "V3-3"]);
    assert.equal(Object.hasOwn(line, "uncountedRanges"), false);
    assert.equal(
      stringValues(line).some((s) => /^U\d+$/.test(s)),
      false,
    );
    // 같은 날 안 상태 갱신(옛 상태 위에 새 회차)도 옛 칸 이름을 남기지 않는다.
    const next = core.recordDailyTick({
      state: {
        ...readState(dir),
        uncountedRanges: ["U1"],
        uncountedVersion: "uncounted-examples/v3",
      },
      nowMs: kst("2026-11-14 00:20"),
      tick: TICK,
    });
    assert.equal(Object.hasOwn(next, "uncountedRanges"), false);
    assert.ok(Array.isArray(next.uncountedExampleIds));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (나) 자정을 걸친 간격 --------------------------------------------------------------------

test("(나-1) 23:41 -> 00:20 (39분) = 두 날 각각 공백 1 · 몫 19분 · 20분", async () => {
  const dir = tmpDir("nc-fix-midnight-39-");
  try {
    await runDay(dir, "2026-11-13", "23:41");
    const before = readState(dir);
    assert.equal(before.gapCount, 0, "그날 안 공백 0(합성 일 구성)");
    await tickAt(dir, kst("2026-11-14 00:20"));
    const [line] = readLines(dir);
    assert.equal(line.day, "2026-11-13");
    assert.deepEqual(line.coverageGaps, { count: 1, totalMs: 19 * MIN });
    const s = readState(dir);
    assert.equal(s.day, "2026-11-14");
    assert.equal(s.gapCount, 1);
    assert.equal(s.gapTotalMs, 20 * MIN);
    // 같은 간격을 다음 회차가 또 세지 않는다(간격은 한 번만 잰다).
    await tickAt(dir, kst("2026-11-14 00:35"));
    assert.equal(readState(dir).gapCount, 1);
    assert.equal(readState(dir).gapTotalMs, 20 * MIN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(나-2) 23:59 -> 00:14 (15분) = 두 날 공백 0", async () => {
  const dir = tmpDir("nc-fix-midnight-15-");
  try {
    await runDay(dir, "2026-11-13", "23:59");
    await tickAt(dir, kst("2026-11-14 00:14"));
    assert.deepEqual(readLines(dir)[0].coverageGaps, { count: 0, totalMs: 0 });
    assert.equal(readState(dir).gapCount, 0);
    assert.equal(readState(dir).gapTotalMs, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(나-3) 경계: 자정 걸친 간격 정확히 20분 = 공백 0 · 21분 = 두 날 공백 1(몫 10분 · 11분)", async () => {
  const exact = tmpDir("nc-fix-midnight-20-");
  const over = tmpDir("nc-fix-midnight-21-");
  try {
    await runDay(exact, "2026-11-13", "23:50");
    await tickAt(exact, kst("2026-11-14 00:10"));
    assert.equal(readLines(exact)[0].coverageGaps.count, 0);
    assert.equal(readState(exact).gapCount, 0);
    await runDay(over, "2026-11-13", "23:50");
    await tickAt(over, kst("2026-11-14 00:11"));
    assert.deepEqual(readLines(over)[0].coverageGaps, {
      count: 1,
      totalMs: 10 * MIN,
    });
    assert.equal(readState(over).gapCount, 1);
    assert.equal(readState(over).gapTotalMs, 11 * MIN);
  } finally {
    fs.rmSync(exact, { recursive: true, force: true });
    fs.rmSync(over, { recursive: true, force: true });
  }
});

test("(나-4) 절전(23:41 -> 다음 날 07:00) · 여러 날 건너뜀(23:50 -> 이틀 뒤 00:05) = 마지막 날 · 새 날 각각 공백 1(몫)", async () => {
  const sleep = tmpDir("nc-fix-midnight-sleep-");
  const skip = tmpDir("nc-fix-midnight-skip-");
  try {
    await runDay(sleep, "2026-11-13", "23:41");
    await tickAt(sleep, kst("2026-11-14 07:00"));
    assert.deepEqual(readLines(sleep)[0].coverageGaps, {
      count: 1,
      totalMs: 19 * MIN,
    });
    assert.equal(readState(sleep).gapCount, 1);
    assert.equal(readState(sleep).gapTotalMs, 7 * 60 * MIN);
    await runDay(skip, "2026-11-13", "23:50");
    await tickAt(skip, kst("2026-11-15 00:05"));
    const lines = readLines(skip);
    assert.deepEqual(
      lines.map((l) => l.day),
      ["2026-11-13"],
      "건너뛴 날 줄 없음",
    );
    assert.deepEqual(lines[0].coverageGaps, { count: 1, totalMs: 10 * MIN });
    assert.equal(readState(skip).day, "2026-11-15");
    assert.equal(readState(skip).gapCount, 1);
    assert.equal(readState(skip).gapTotalMs, 5 * MIN);
  } finally {
    fs.rmSync(sleep, { recursive: true, force: true });
    fs.rmSync(skip, { recursive: true, force: true });
  }
});

test("(나-5) 직전 회차 정보가 없는 새 날 첫 회차(첫 실행)는 옛 기준(00:00 -> 첫 회차) 그대로", async () => {
  const dir = tmpDir("nc-fix-first-tick-");
  try {
    await tickAt(dir, kst("2026-11-14 10:00"));
    assert.equal(readState(dir).gapCount, 1);
    assert.equal(readState(dir).gapTotalMs, 600 * MIN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (다) 창 연속 ------------------------------------------------------------------------------

// HYK-255-p1fix-2 (판정 0706) -- 1R 의 «직전 줄 창 끝부터» 라벨은 되돌렸다. 일별 줄 창 = 그날 첫 회차의 창 시작 ~ 마지막 회차 ·
// 확인 값 = 그날 처음 본 사건(앞 줄에서 센 사건 제외). 아래 칸은 사건을 넣고 «값» 을 함께 단언한다(라벨 산수만 단언 금지).
const withShas = (shas) =>
  core.buildDailyTickValues({
    externalEvidence: { known: true, confirmedShas: shas, unchecked: 0 },
    collectors: [],
    delivered: { known: true, count: 3 },
    uncountedExamples: core.UNCOUNTED_EXAMPLES_V3,
    permissionAnswers: { known: true, humanTotal: 0, undecided: 0 },
  });

// 사건 = 날마다 sha 하나(그날 첫 회차부터 다음 날 끝까지 24시간 창에 보인다 -- 오늘 것 + 어제 것).
const shaOfDay = (day) => day.replaceAll("-", "").padEnd(40, "f");
const everyDayTick = (now) =>
  withShas([shaOfDay(core.kstDayOf(now)), shaOfDay(core.kstDayOf(now - DAY))]);

async function runDayEvents(dir, day, last) {
  const start = core.kstDayStartMs(day);
  const times = [kst(`${day} ${last}`)];
  while (times[0] - 15 * MIN >= start) times.unshift(times[0] - 15 * MIN);
  for (const t of times) await tickAt(dir, t, everyDayTick(t));
  return times;
}

test("(다-1) 3일 연속: 각 날 줄의 창 = 그날 첫 회차의 창 시작 ~ 마지막 회차 · 날마다 새 사건 1(앞 줄에서 센 어제 사건 1건은 제외)", async () => {
  const dir = tmpDir("nc-fix-window-chain-");
  try {
    const t12 = await runDayEvents(dir, "2026-11-12", "23:45");
    const t13 = await runDayEvents(dir, "2026-11-13", "23:41");
    const t14 = await runDayEvents(dir, "2026-11-14", "23:59");
    await tickAt(dir, kst("2026-11-15 00:10"));
    const lines = readLines(dir);
    assert.deepEqual(
      lines.map((l) => l.day),
      ["2026-11-12", "2026-11-13", "2026-11-14"],
    );
    assert.equal(lines[0].windowStartMs, t12[0] - DAY, "첫 회차의 창 시작");
    assert.equal(lines[0].windowEndMs, kst("2026-11-12 23:45"));
    assert.equal(
      lines[1].windowStartMs,
      t13[0] - DAY,
      "직전 줄 창 끝이 아니다",
    );
    assert.equal(lines[1].windowEndMs, kst("2026-11-13 23:41"));
    assert.equal(
      lines[2].windowStartMs,
      t14[0] - DAY,
      "직전 줄 창 끝이 아니다",
    );
    assert.equal(lines[2].windowEndMs, kst("2026-11-14 23:59"));
    // 값: 첫 날은 어제(11-11) 사건까지 새로 본다 2 · 이튿날부터 어제 사건은 앞 줄에서 센 것이라 오늘 사건 1 만 센다
    assert.deepEqual(
      lines.map((l) => l.lnConfirmed),
      [2, 1, 1],
    );
    assert.deepEqual(
      lines.map((l) => l.confirmedExcludedEarlier),
      [0, 1, 1],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(다-2) 틈 사건: 23:41 -> 00:20 사이 사건(23:45)은 11-13 줄 0 · 11-14 줄 1 — 두 줄 합 1 (어느 줄에서도 0 으로 사라지지 않는다)", async () => {
  const dir = tmpDir("nc-fix-window-gap-");
  try {
    const gapSha = "9".repeat(40);
    // 23:45 의 사건 = 11-13 23:45 이후 회차의 창에 보인다(회차 시각 ≥ 사건 시각 · ≤ 사건 + 24h)
    const seen = (now) =>
      now >= kst("2026-11-13 23:45") && now <= kst("2026-11-14 23:45")
        ? withShas([gapSha])
        : withShas([]);
    for (const hhmm of ["23:11", "23:26", "23:41"]) {
      await tickAt(
        dir,
        kst(`2026-11-13 ${hhmm}`),
        seen(kst(`2026-11-13 ${hhmm}`)),
      );
    }
    for (const hhmm of ["00:20", "12:00", "23:50"]) {
      await tickAt(
        dir,
        kst(`2026-11-14 ${hhmm}`),
        seen(kst(`2026-11-14 ${hhmm}`)),
      );
    }
    await tickAt(dir, kst("2026-11-15 00:05"), withShas([]));
    const [l13, l14] = readLines(dir);
    assert.deepEqual([l13.lnConfirmed, l14.lnConfirmed], [0, 1]);
    // 마지막 회차 값(1R 규칙)이면 11-14 줄은 23:50 회차의 창(11-13 23:50 ~) 밖이라 0 이 된다 -- 그게 막은 거짓 0
    assert.equal(l14.windowStartMs, kst("2026-11-14 00:20") - DAY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(다-3) 여러 날 건너뜀 뒤 첫 줄 = 직전 줄이 어제가 아니므로 그날 첫 회차의 창 시작", async () => {
  const dir = tmpDir("nc-fix-window-skip-");
  try {
    await runDay(dir, "2026-11-11", "23:50");
    const t13 = await runDay(dir, "2026-11-13", "23:50"); // 11-12 통째 빔
    await tickAt(dir, kst("2026-11-14 00:05"));
    const lines = readLines(dir);
    assert.deepEqual(
      lines.map((l) => l.day),
      ["2026-11-11", "2026-11-13"],
    );
    assert.equal(lines[1].windowStartMs, t13[0] - DAY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(다-4) 직전 줄이 옛 칸 이름이어도 이미 쓴 줄은 바이트 무변 · 새 줄 창 = 그날 첫 회차의 창 시작(옛 줄 창 끝을 읽지 않는다) · 값은 사건 합집합", async () => {
  const dir = tmpDir("nc-fix-window-oldline-");
  try {
    const old = {
      schema: "partial-count-daily/v1",
      day: "2026-11-12",
      windowStartMs: kst("2026-11-11 23:50"),
      windowEndMs: kst("2026-11-12 23:50"),
      closedAtMs: kst("2026-11-13 00:05"),
      lnConfirmed: 0,
      lnUnchecked: 0,
      collectorFails: [],
      coverageGaps: { count: 0, totalMs: 0 },
      concurrentTracksMax: 1,
      delivered: 3,
      uncountedRanges: ["U1", "U2"],
      uncountedVersion: "uncounted-examples/v3",
    };
    fs.writeFileSync(dailyPath(dir), `${JSON.stringify(old)}\n`, "utf8");
    const seeded = fs.readFileSync(dailyPath(dir));
    const oldSha = "8".repeat(40);
    const t13 = await runDay(dir, "2026-11-13", "23:41", withShas([oldSha]));
    await tickAt(dir, kst("2026-11-14 00:10"), withShas([]));
    const after = fs.readFileSync(dailyPath(dir));
    assert.ok(
      after.subarray(0, seeded.length).equals(seeded),
      "옛 줄 바이트 무변",
    );
    const lines = readLines(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].windowStartMs, t13[0] - DAY);
    assert.notEqual(lines[1].windowStartMs, old.windowEndMs);
    assert.equal(lines[1].lnConfirmed, 1, "옛 줄 뒤 첫 줄도 사건 합집합 값");
    assert.ok(Array.isArray(lines[1].uncountedExampleIds));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 읽는 쪽: 옛 칸 이름 줄 + 새 줄 섞임 --------------------------------------------------------

function line(day, extra = {}) {
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
    ...extra,
  };
}

test("읽는 쪽: 옛 칸 이름 줄 + 새 칸 이름 줄이 섞여도 연속 일수가 이어지고 미계수 개수는 가장 최근 줄의 칸에서 읽는다", () => {
  const nowMs = kst("2026-11-14 09:00");
  const mixed = [
    line("2026-11-13", { uncountedExampleIds: ["V3-1", "V3-2", "V3-3"] }),
    line("2026-11-12", { uncountedExampleIds: ["V3-1"] }),
    line("2026-11-11", { uncountedRanges: ["U1", "U2"] }),
    line("2026-11-10", { uncountedRanges: ["U1"] }),
  ];
  const s = core.computeConfirmedZeroStreak({ lines: mixed, nowMs });
  assert.equal(s.days, 4);
  assert.equal(s.uncountedRangeCount, 3, "가장 최근 줄(새 칸 이름)");
  const legacyLatest = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [
      line("2026-11-13", { uncountedRanges: ["U1", "U2"] }),
      line("2026-11-12", { uncountedExampleIds: ["V3-1"] }),
    ],
  });
  assert.equal(legacyLatest.days, 2);
  assert.equal(legacyLatest.uncountedRangeCount, 2, "가장 최근 줄(옛 칸 이름)");
});

test("읽는 쪽: 옛 칸 이름 줄을 무시하지 않는다(그 날도 센다) · 줄 렌더 문면 무변", () => {
  const nowMs = kst("2026-11-14 09:00");
  const s = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [line("2026-11-13", { uncountedRanges: ["U1", "U2"] })],
  });
  assert.equal(s.days, 1);
  assert.equal(
    core.renderConfirmedZeroStreakLine(s),
    "연속 확인-0 일수: 1일(부분 — 미계수 범위 2개 동반 · 마지막 끊김 2026-11-12 줄 없음)",
  );
});

// ---- 불변: 문턱 0 · 자격 줄 무변 ----------------------------------------------------------------

test("불변: 20분 기준 상수 무변 · 보고문의 1-C 판정 자격 줄 무변 · 문턱 문면 0", () => {
  assert.equal(core.DAILY_COVERAGE_GAP_MS, 20 * MIN);
  const text = core.buildPartialCountReport({
    generatedAtMs: kst("2026-11-14 10:00"),
    windowStartMs: kst("2026-11-13 10:00"),
    windowEndMs: kst("2026-11-14 10:00"),
    delivered: { known: true, count: 0 },
    consumed: { known: true, count: 0 },
    missingReceipts: { known: true, count: 0 },
    gate4: { known: true, count: 0 },
    suspected: { known: true, closedCount: 0, openCount: 0 },
    coverageGaps: { known: true, count: 0, totalMs: 0 },
    confirmedZeroStreakLine:
      "연속 확인-0 일수: 0일(부분 — 마지막 끊김 2026-11-13 줄 없음)",
  });
  assert.ok(
    text.includes(
      "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가\n연속 확인-0 일수:",
    ),
  );
  assert.ok(!/자격: 있음|충족|달성|통과/.test(text));
});
