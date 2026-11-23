// HYK-255-p2a-scope-1 커밋 2 -- 보고서 «기계 계수 범위 기준» 한 줄: 일별 줄에서 연속 N일(날마다 배달(24시간 창) ≥ 설정 문턱 ∧ 마지막 회차 ≥ 설정 시각(KST) ∧ 끊김 사유 0)을 세어
// «충족 | 미충족 | UNKNOWN» 으로 싣는다. 값(관측 일수 · 배달 문턱 · 마지막 회차 컷 · 기준 변경일)은 설정 파일에서만 온다.
// HYK-255-p2e-workday-2 바뀐 기준(한용 확정 + 판정 #20261117-2026 ③ · 2104 ②): 「동시 배달 최대 ≥ 2」 폐기 -> 「일한 날」 = 그날 일별 줄의 배달 값(마지막 회차에서 거꾸로 24시간 창) ≥ 문턱 ∧
// 마지막 회차 시각 ≥ 컷(23:30 · 설정) · 배달 값 없음 = 끊김 · 동시 배달 최대는 계속 기록하되 판정 0. 합성 설정 값(문턱 · 컷 · 기준 변경일)은 실물 설정과 «다른» 값 -- 코드가 실물 값을 박았다면 이 파일이 잡는다.
//
// ⛔헛시험 금지: 프로덕션 export(computeMachineScope · renderMachineScopeLine · buildPartialCountReport · runPartialCountOnce ·
// runPartialCountStep)를 직접 구동한다 -- 사본 import 0. 모든 칸은 입력(합성 일별 줄 · 합성 설정 파일)을 넣고 «값» 을 단언한다(표기 산수만 단언 0).
// ⛔시험 단언 규율: 보고서 줄 «전체» 문자열 동등 단언 0 -- 자기 줄(`기계 계수 범위 기준: …`)의 토막만 읽는다. 예외 = «1-C 판정 자격: 없음» ·
// «연속 확인-0 일수» 줄의 바이트 무변 단언(그 줄 자체가 계약). 실제 네트워크 · gh · 토큰 · 관제실 접촉 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import { runPartialCountStep } from "./watch-run.mjs";

const NOW = Date.parse("2026-11-15T15:00:00+09:00");
const CONFIG_PATH = "scripts/supervisor/partial-count-machine-scope.json";
// HYK-255-skipday-scope-1 바뀐 문면(뜻 무변): 설정 스키마 v2 -> v3(건너뜀 두 칸 추가). 이 파일의 합성 설정은 lowDayHandling = break -- 적은 날 = 끊김(건너뜀 이전 동작)을 그대로 단언하는 회귀 시험으로 산다.
const SCHEMA = "partial-count-machine-scope/v3";
const OLD_SCHEMA = "partial-count-machine-scope/v1";
const SCOPE_PREFIX = "기계 계수 범위 기준: ";
// HYK-255-p2d-nonecause-1 바뀐 단언(판정 2026-11-16 1804 상신 1): 옛 상수 줄 리터럴 -> 프로덕션 렌더 출력. 이 파일의 보고서는 기준 «충족» + 종류 설정 파일 없는 합성 저장소라
// 자격 줄 원인 = 못 세는 종류 설정 읽기 실패(렌더 함수 출력과 비교 · 줄 자리 = 연속 확인-0 줄 바로 위는 무변).
const ONE_C_LINE = core.renderQualificationLine({
  state: "none",
  cause: core.QUALIFICATION_NONE_CAUSE.KINDS_CONFIG,
});
const QUAL_PREFIX = "1-C 판정 자격: ";
const STREAK_LINE =
  "연속 확인-0 일수: 2일(부분 — 마지막 끊김 2026-11-12 줄 없음)";
const FAIL404 = { ok: false, status: 404, json: null, linkHeader: null };

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
test.after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

// 합성 기계 계수 범위 설정(일한 날 판) -- 실물 설정(문턱 · 컷 · 기준 변경일)과 일부러 다른 값.
const SYNTH = {
  observationDays: 7,
  minDeliveredPerDay: 3,
  lastTickCutoffKst: "23:15",
  criterionChangedOn: "2026-11-01",
  lowDayHandling: "break",
  lowDayHandlingChangedOn: "2026-11-10",
};

// ---- 합성 일별 줄 -----------------------------------------------------------------------------------------------------
// offset = 오늘(2026-11-15) 기준 날 수(-1 = 어제).
const dayStr = (offset) =>
  new Date(Date.UTC(2026, 10, 15 + offset)).toISOString().slice(0, 10);
// 그날 KST 시각(HH:MM) -> epoch ms.
const kstAt = (offset, hhmm) =>
  Date.parse(`${dayStr(offset)}T${hhmm}:00+09:00`);
const dayLine = (offset, over = {}) => ({
  schema: core.DAILY_SCHEMA,
  day: dayStr(offset),
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  coverageGaps: { count: 0, totalMs: 0 },
  concurrentTracksMax: 2,
  // HYK-255-p2e-workday-2 -- «일한 날» 줄: 배달 = 합성 문턱(경계값) · 마지막 회차 = 그날 23:58 KST(컷 뒤).
  delivered: SYNTH.minDeliveredPerDay,
  lastTickAtMs: kstAt(offset, "23:58"),
  uncountedExampleIds: [],
  // HYK-255-p2c-nofield-1 -- 칸 없는 줄 = 끊김(판정 1404): «깨끗한 날» 은 권한 두 칸 + GitHub 칸이 있고 값 0 이다.
  permissionHumanAnswers: 0,
  permissionUndecidable: 0,
  githubHumanActions: 0,
  ...over,
});
// from..to(포함) 날마다 줄 1개 -- over(offset) 이 줄 칸을 덮는다. 빠진 날 = 줄 없음.
const dayLines = (from, to, over = () => ({})) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    dayLine(from + i, over(from + i)),
  );

const scopeOf = (lines, cfg = SYNTH) =>
  core.computeMachineScope({ lines, nowMs: NOW, ...cfg });
const renderScope = (lines, cfg = SYNTH) =>
  core.renderMachineScopeLine(scopeOf(lines, cfg));

// 자기 줄의 토막 읽기.
const verdictOf = (line) => /^기계 계수 범위 기준: (\S+)/.exec(line)?.[1];
const streakDays = (line) => Number(/일한 날 (\d+)일/.exec(line)?.[1]);
// [기준 일수, 배달 문턱, 마지막 회차 컷(HH:MM)] -- 줄의 «기준» 토막.
const criterion = (line) => {
  const m =
    /기준 (\d+)일\(배달\(24시간 창\) ≥ (\d+)건 · 마지막 회차 ≥ (\d{2}:\d{2}) KST/.exec(
      line,
    );
  return m ? [Number(m[1]), Number(m[2]), m[3]] : null;
};
// 기준 변경 표기(날짜).
const changedOn = (line) => /기준 변경 (\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
const countedRange = (line) => /달력 기간 (\S+)/.exec(line)?.[1];
const lastBreak = (line) =>
  /마지막 끊김 (\d{4}-\d{2}-\d{2}) (.*?)(?: — |$)/.exec(line)?.slice(1);

// ---- 계산 + 렌더(프로덕션 순수 함수 · 합성 일별 줄) -----------------------------------------------------------------

test("7일 연속(배달 ≥ 문턱 · 마지막 회차 ≥ 컷 · 끊김 0) = 충족 · 날짜 범위 = 실제로 센 7일(2026-11-08~2026-11-14) · 마지막 끊김 = 줄 없는 날 · 문면에 값의 범위(24시간 창)와 기준 변경일", () => {
  const line = renderScope(dayLines(-7, -1));
  assert.equal(verdictOf(line), "충족");
  assert.equal(streakDays(line), 7);
  assert.deepEqual(criterion(line), [
    7,
    SYNTH.minDeliveredPerDay,
    SYNTH.lastTickCutoffKst,
  ]);
  assert.equal(changedOn(line), SYNTH.criterionChangedOn);
  assert.equal(line.includes("동시 배달"), false, "옛 기준 낱말 0");
  assert.equal(countedRange(line), "2026-11-08~2026-11-14");
  assert.deepEqual(lastBreak(line), ["2026-11-07", "줄 없음"]);
});

test("6일 연속 = 미충족 · 범위 = 센 6일(2026-11-09~2026-11-14) · 7일째 줄 없음이 마지막 끊김", () => {
  const line = renderScope(dayLines(-6, -1));
  assert.equal(verdictOf(line), "미충족");
  assert.equal(streakDays(line), 6);
  assert.equal(countedRange(line), "2026-11-09~2026-11-14");
  assert.deepEqual(lastBreak(line), ["2026-11-08", "줄 없음"]);
});

test("7일 중 하루(11-11)만 배달 문턱 미만 = 그날 끊김 -> 어제부터 3일(11-12~11-14) · 미충족 · 끊김 사유에 값(24시간 창)과 문턱", () => {
  const under = SYNTH.minDeliveredPerDay - 1;
  const lines = dayLines(-7, -1, (o) => (o === -4 ? { delivered: under } : {}));
  const line = renderScope(lines);
  assert.equal(verdictOf(line), "미충족");
  assert.equal(streakDays(line), 3);
  assert.equal(countedRange(line), "2026-11-12~2026-11-14");
  const [day, reason] = lastBreak(line);
  assert.equal(day, "2026-11-11");
  assert.ok(
    reason.includes(
      `배달(24시간 창) ${under}건 < 기준 ${SYNTH.minDeliveredPerDay}건`,
    ),
    reason,
  );
});

test("경계: 배달 = 문턱 = 센 날(≥) · 문턱 - 1 = 끊김 · 문턱을 훨씬 넘는 날 = 센 날", () => {
  const K = SYNTH.minDeliveredPerDay;
  assert.equal(
    streakDays(renderScope(dayLines(-7, -1, () => ({ delivered: K })))),
    7,
  );
  assert.equal(
    streakDays(renderScope(dayLines(-7, -1, () => ({ delivered: K + 50 })))),
    7,
  );
  assert.equal(
    streakDays(renderScope(dayLines(-7, -1, () => ({ delivered: K - 1 })))),
    0,
  );
});

test("배달이 null · 칸 없음 · 숫자가 아님 = 모름 = 통과가 아니라 그날 끊김(사유 «배달 값 없음») -- 값을 0 으로 읽지도 않는다", () => {
  for (const over of [
    { delivered: null },
    { delivered: undefined },
    { delivered: "17" },
    { delivered: -1 },
    { delivered: 3.5 },
  ]) {
    const lines = dayLines(-7, -1, (o) => (o === -3 ? over : {}));
    const line = renderScope(lines);
    assert.equal(verdictOf(line), "미충족", JSON.stringify(over));
    assert.equal(streakDays(line), 2, "11-12 가 끊김 -> 11-14 · 11-13 두 날");
    assert.deepEqual(lastBreak(line), ["2026-11-12", "배달 값 없음"]);
  }
});

test("동시 배달 최대는 판정에 쓰지 않는다 -- 1 · null · 칸 없음 · 큰 값이어도 배달이 문턱 이상이면 센 날 · 배달이 문턱 미만이면 동시 배달이 커도 끊김", () => {
  const K = SYNTH.minDeliveredPerDay;
  for (const concurrentTracksMax of [1, 0, null, undefined, 99]) {
    const line = renderScope(dayLines(-7, -1, () => ({ concurrentTracksMax })));
    assert.equal(verdictOf(line), "충족", String(concurrentTracksMax));
    assert.equal(streakDays(line), 7);
  }
  const low = renderScope(
    dayLines(-7, -1, () => ({ concurrentTracksMax: 99, delivered: K - 1 })),
  );
  assert.equal(streakDays(low), 0);
  assert.match(lastBreak(low)[1], /배달\(24시간 창\)/);
  assert.equal(lastBreak(low)[1].includes("동시 배달"), false);
});

test("마지막 회차 시각(KST) 규칙: 컷보다 이르면 그날 끊김(사유 «마지막 회차가 자정 전에 끊김») · 컷 정각 = 센 날 · 컷 뒤 = 센 날 -- 컷은 설정 값 · UTC 가 아니라 KST 로 읽는다", () => {
  const cutoff = SYNTH.lastTickCutoffKst; // 23:15
  const withTick = (hhmm) =>
    renderScope(
      dayLines(-7, -1, (o) =>
        o === -2 ? { lastTickAtMs: kstAt(o, hhmm) } : {},
      ),
    );
  // 컷보다 1분 이른 날 = 끊김(11-13 이 끊김 -> 11-14 한 날만 센다).
  const early = withTick("23:14");
  assert.equal(verdictOf(early), "미충족");
  assert.equal(streakDays(early), 1);
  const [day, reason] = lastBreak(early);
  assert.equal(day, "2026-11-13");
  assert.ok(reason.includes("마지막 회차가 자정 전에 끊김"), reason);
  assert.ok(reason.includes(cutoff), "사유에 컷 값(설정)");
  assert.ok(reason.includes("23:14"), "사유에 그날 마지막 회차 시각(KST)");
  // 컷 정각 · 컷 뒤 · 자정 직전 = 센 날.
  for (const hhmm of [cutoff, "23:16", "23:59"]) {
    assert.equal(streakDays(withTick(hhmm)), 7, hhmm);
  }
  // 한참 이른 시각(오후)도 끊김.
  assert.equal(streakDays(withTick("15:00")), 1);
  // KST 로 읽는다: 14:20Z = 23:20 KST(컷 뒤 = 센 날). UTC 분으로 읽으면 14:20 < 23:15 라 끊김이 된다.
  const kst2320 = Date.parse(`${dayStr(-2)}T14:20:00Z`);
  const utcTrap = renderScope(
    dayLines(-7, -1, (o) => (o === -2 ? { lastTickAtMs: kst2320 } : {})),
  );
  assert.equal(streakDays(utcTrap), 7, "23:20 KST = 컷(23:15) 뒤");
  // 반대 함정: 23:20Z = 다음날 08:20 KST(컷 앞 = 끊김) -- UTC 분으로 읽으면 23:20 ≥ 컷 이라 센 날이 된다.
  const kst0820 = Date.parse(`${dayStr(-2)}T23:20:00Z`);
  const utcTrap2 = renderScope(
    dayLines(-7, -1, (o) => (o === -2 ? { lastTickAtMs: kst0820 } : {})),
  );
  assert.equal(streakDays(utcTrap2), 1, "08:20 KST = 컷 앞 = 끊김");
});

test("마지막 회차 시각 칸이 없는 옛 줄(null · 칸 없음 · 숫자가 아님) = 이 규칙을 적용하지 않는다(새 칸을 만들지 않는다 · 정직 한계) -- 배달 · 다른 끊김 사유는 그대로 적용", () => {
  for (const lastTickAtMs of [null, undefined, "x", Number.NaN]) {
    const ok = renderScope(
      dayLines(-7, -1, (o) => (o === -2 ? { lastTickAtMs } : {})),
    );
    assert.equal(streakDays(ok), 7, String(lastTickAtMs));
    const low = renderScope(
      dayLines(-7, -1, (o) =>
        o === -2
          ? { lastTickAtMs, delivered: SYNTH.minDeliveredPerDay - 1 }
          : {},
      ),
    );
    assert.equal(streakDays(low), 1, "배달 미만은 그대로 끊김");
  }
});

test("한 날에 사유가 겹치면 모두 적는다(기존 사유 → 배달 → 마지막 회차 순)", () => {
  const line = renderScope(
    dayLines(-7, -1, (o) =>
      o === -1
        ? {
            lnUnchecked: 1,
            delivered: null,
            lastTickAtMs: kstAt(o, "10:00"),
          }
        : {},
    ),
  );
  const [day, reason] = lastBreak(line);
  assert.equal(day, "2026-11-14");
  const iUnchecked = reason.indexOf("미조회 1");
  const iDelivered = reason.indexOf("배달 값 없음");
  const iTick = reason.indexOf("마지막 회차가 자정 전에 끊김");
  assert.ok(
    iUnchecked >= 0 && iDelivered > iUnchecked && iTick > iDelivered,
    reason,
  );
});

test("끊김 사유가 있는 날(수집 실패 · 확인 > 0 · 미조회 · 관측 공백) = 그날 끊김 -- 동시 배달이 충분해도", () => {
  const breakers = [
    [{ collectorFails: ["독립ㄴ수집기"] }, /수집 실패\(독립ㄴ수집기\)/],
    [{ lnConfirmed: 2 }, /확인 2/],
    [{ lnUnchecked: 1 }, /미조회 1/],
    [{ coverageGaps: { count: 1, totalMs: 1 } }, /관측 공백 1구간/],
  ];
  for (const [over, reasonRe] of breakers) {
    const line = renderScope(dayLines(-7, -1, (o) => (o === -2 ? over : {})));
    assert.equal(verdictOf(line), "미충족", JSON.stringify(over));
    assert.equal(streakDays(line), 1, "11-14 만 센다(11-13 이 끊김)");
    const [day, reason] = lastBreak(line);
    assert.equal(day, "2026-11-13");
    assert.match(reason, reasonRe);
  }
});

test("같은 날 줄이 둘 = 끊김(줄 중복) · 줄이 없는 날 = 끊김(줄 없음)", () => {
  const dup = [...dayLines(-7, -1), dayLine(-1)];
  const line = renderScope(dup);
  assert.equal(streakDays(line), 0);
  assert.equal(countedRange(line), "없음", "센 날 0 = 범위 없음");
  assert.deepEqual(lastBreak(line), ["2026-11-14", "줄 중복 2"]);
  const none = renderScope([]);
  assert.deepEqual(lastBreak(none), ["2026-11-14", "줄 없음"]);
  assert.equal(verdictOf(none), "미충족");
});

test("끊긴 뒤 재시작: 연속은 끊김 뒤 날부터 다시 센다 -- 끊김 앞의 좋은 날은 합치지 않는다 · 끊김 뒤 7일이 차면 충족", () => {
  // 11-01~11-14 중 11-10 이 끊김: 어제부터 거꾸로 11-14..11-11 = 4일. 11-01~11-09 의 9일은 끊김 앞이라 센 날이 아니다.
  const broken = renderScope(
    dayLines(-14, -1, (o) => (o === -5 ? { lnUnchecked: 1 } : {})),
  );
  assert.equal(verdictOf(broken), "미충족");
  assert.equal(streakDays(broken), 4);
  assert.equal(countedRange(broken), "2026-11-11~2026-11-14");
  assert.deepEqual(lastBreak(broken)?.[0], "2026-11-10");
  // 끊김(11-06) 뒤 8일(11-07~11-14) = 충족 · 범위 시작 = 끊김 바로 다음 날.
  const restarted = renderScope(
    dayLines(-14, -1, (o) => (o === -9 ? { lnUnchecked: 1 } : {})),
  );
  assert.equal(verdictOf(restarted), "충족");
  assert.equal(streakDays(restarted), 8);
  assert.equal(countedRange(restarted), "2026-11-07~2026-11-14");
});

test("오늘(미마감)은 세지 않는다 -- 오늘 줄이 있어도 범위 끝 = 어제 · 오늘 줄이 센 날 수를 늘리지 않는다", () => {
  const line = renderScope(dayLines(-7, 0)); // 11-08~11-15(오늘 포함 8줄)
  assert.equal(streakDays(line), 7);
  assert.equal(countedRange(line), "2026-11-08~2026-11-14");
});

test("기준 숫자 · 문턱 · 컷 · 기준 변경일은 읽은 설정 값 그대로 -- 완화 설정(3일 · 배달 1건 · 컷 12:00)이면 같은 줄(배달 1 · 마지막 회차 13:00)이 충족 · 합성 기본 설정이면 미충족 (코드 리터럴 0 증명)", () => {
  const lines = dayLines(-3, -1, (o) => ({
    delivered: 1,
    lastTickAtMs: kstAt(o, "13:00"),
  }));
  const loose = renderScope(lines, {
    observationDays: 3,
    minDeliveredPerDay: 1,
    lastTickCutoffKst: "12:00",
    criterionChangedOn: "2026-11-02",
  });
  assert.equal(verdictOf(loose), "충족");
  assert.deepEqual(criterion(loose), [3, 1, "12:00"]);
  assert.equal(changedOn(loose), "2026-11-02");
  assert.equal(countedRange(loose), "2026-11-12~2026-11-14");
  const strict = renderScope(lines);
  assert.equal(verdictOf(strict), "미충족");
  assert.deepEqual(criterion(strict), [
    7,
    SYNTH.minDeliveredPerDay,
    SYNTH.lastTickCutoffKst,
  ]);
  assert.equal(streakDays(strict), 0, "배달 1 < 문턱 -> 어제부터 끊김");
  // 문턱만 바꾸면(컷 같음) 결과가 따라간다 · 컷만 바꾸면 따라간다.
  const onlyK = renderScope(lines, { ...SYNTH, minDeliveredPerDay: 1 });
  assert.equal(
    lastBreak(onlyK)[1].includes("마지막 회차가 자정 전에 끊김"),
    true,
  );
  const onlyCut = renderScope(lines, { ...SYNTH, lastTickCutoffKst: "12:00" });
  assert.match(lastBreak(onlyCut)[1], /배달\(24시간 창\) 1건 < 기준/);
});

test("지나간 날 재계산: 일별 줄 입력을 바꾸지 않는다(쓰기 0) -- 동결한 줄로 구동해도 같은 값 · 입력 배열 · 줄 객체 불변", () => {
  const lines = dayLines(-7, -1);
  const frozen = lines.map((l) => Object.freeze({ ...l }));
  Object.freeze(frozen);
  const before = JSON.stringify(frozen);
  const line = renderScope(frozen);
  assert.equal(JSON.stringify(frozen), before);
  assert.equal(line, renderScope(lines));
  assert.equal(verdictOf(line), "충족");
});

test("설정을 못 읽은 결과(UNKNOWN) 렌더 = 충족도 미충족도 아니다 · 줄에 사유", () => {
  const line = core.renderMachineScopeLine({
    known: false,
    reason: "시험 사유",
  });
  assert.equal(verdictOf(line), "UNKNOWN(시험");
  assert.match(line, /UNKNOWN\(시험 사유\)/);
  assert.equal(/충족|미충족/.test(line), false);
});

// ---- 보고 진입점(프로덕션 runPartialCountOnce · 합성 origin/master 설정 파일) -----------------------------------------

function git(cwd, args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

// config: 문자열 = 그 내용의 설정 파일을 origin/master 판본에 심는다 · null = 설정 파일 없음.
function buildRepo(config) {
  const dir = tmpDir("nc-machine-scope-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  if (config !== null) fs.writeFileSync(join(dir, CONFIG_PATH), config, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "root"]);
  git(dir, [
    "remote",
    "add",
    "origin",
    "https://github.com/example/fixture.git",
  ]);
  git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  return dir;
}

const configJson = (over = {}) =>
  JSON.stringify({
    schema_version: SCHEMA,
    ...SYNTH,
    ...over,
  });

async function runReport(
  repoDir,
  extra = {},
  root = tmpDir("nc-machine-scope-run-"),
) {
  return report.runPartialCountOnce({
    now: NOW,
    repoRoot: repoDir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson: async () => FAIL404,
    git: report.createProcessGitPort(repoDir),
    gitWorktreeListExecFn: () => "",
    ...extra,
  });
}
const scopeLineOf = (text) =>
  text.split("\n").find((l) => l.startsWith(SCOPE_PREFIX));

test("보고서: 합성 설정(7일 · 배달 문턱 · 컷) + 7일 연속 줄 = 충족 한 줄 -- «연속 확인-0 일수» 줄 바로 아래 · «1-C 판정 자격: 없음» · 연속 확인-0 줄 바이트 무변", async () => {
  const { reportText } = await runReport(buildRepo(configJson()), {
    confirmedZeroStreakLine: STREAK_LINE,
    machineScopeDailyLines: dayLines(-7, -1),
  });
  const lines = reportText.split("\n");
  const at = (text) => lines.indexOf(text);
  assert.notEqual(at(ONE_C_LINE), -1, "1-C 줄 바이트 그대로 있다");
  assert.equal(
    at(STREAK_LINE),
    at(ONE_C_LINE) + 1,
    "연속 확인-0 줄 바이트 그대로 · 1-C 줄 다음",
  );
  const scope = scopeLineOf(reportText);
  assert.equal(
    lines.indexOf(scope),
    at(STREAK_LINE) + 1,
    "기준 줄 = 연속 확인-0 줄 바로 아래",
  );
  assert.equal(verdictOf(scope), "충족");
  assert.equal(streakDays(scope), 7);
  assert.deepEqual(criterion(scope), [
    7,
    SYNTH.minDeliveredPerDay,
    SYNTH.lastTickCutoffKst,
  ]);
  assert.equal(changedOn(scope), SYNTH.criterionChangedOn);
  assert.equal(countedRange(scope), "2026-11-08~2026-11-14");
  assert.equal(
    lines.filter((l) => l.startsWith(SCOPE_PREFIX)).length,
    1,
    "한 줄",
  );
});

test("보고서: 읽은 설정이 기준을 정한다 -- 설정(3일 · 배달 1건 · 컷 12:00 · 기준 변경 11-02)이면 배달 1건 · 13:00 마지막 회차 줄이 충족하고 줄의 기준 숫자도 그 값 (합성 기본 설정이면 미충족)", async () => {
  const lines = dayLines(-3, -1, (o) => ({
    delivered: 1,
    lastTickAtMs: kstAt(o, "13:00"),
  }));
  const loose = await runReport(
    buildRepo(
      configJson({
        observationDays: 3,
        minDeliveredPerDay: 1,
        lastTickCutoffKst: "12:00",
        criterionChangedOn: "2026-11-02",
      }),
    ),
    { machineScopeDailyLines: lines },
  );
  const looseLine = scopeLineOf(loose.reportText);
  assert.equal(verdictOf(looseLine), "충족");
  assert.deepEqual(criterion(looseLine), [3, 1, "12:00"]);
  assert.equal(changedOn(looseLine), "2026-11-02");
  assert.equal(countedRange(looseLine), "2026-11-12~2026-11-14");
  const strict = await runReport(buildRepo(configJson()), {
    machineScopeDailyLines: lines,
  });
  assert.equal(verdictOf(scopeLineOf(strict.reportText)), "미충족");
});

test("보고서: 동시 배달 1 이면서 배달 ≥ 문턱 · 마지막 회차 ≥ 컷 인 7일 = 충족(옛 기준에서는 미충족이던 줄) -- 판정이 배달 건수로 바뀐 것을 진입점 끝에서 확인", async () => {
  const { reportText } = await runReport(buildRepo(configJson()), {
    machineScopeDailyLines: dayLines(-7, -1, () => ({
      concurrentTracksMax: 1,
    })),
  });
  const scope = scopeLineOf(reportText);
  assert.equal(verdictOf(scope), "충족");
  assert.equal(streakDays(scope), 7);
});

test("보고서: 배달 값 없음 · 문턱 미만 · 마지막 회차 컷 이전 = 각각 그 사유가 «마지막 끊김» 에 실린다(진입점 · 합성 설정)", async () => {
  const run = async (over) =>
    scopeLineOf(
      (
        await runReport(buildRepo(configJson()), {
          machineScopeDailyLines: dayLines(-7, -1, (o) =>
            o === -1 ? over(o) : {},
          ),
        })
      ).reportText,
    );
  const none = await run(() => ({ delivered: null }));
  assert.equal(verdictOf(none), "미충족");
  assert.deepEqual(lastBreak(none), ["2026-11-14", "배달 값 없음"]);
  const under = await run(() => ({
    delivered: SYNTH.minDeliveredPerDay - 1,
  }));
  assert.ok(
    lastBreak(under)[1].includes(
      `배달(24시간 창) ${SYNTH.minDeliveredPerDay - 1}건 < 기준 ${SYNTH.minDeliveredPerDay}건`,
    ),
  );
  const early = await run((o) => ({ lastTickAtMs: kstAt(o, "09:00") }));
  assert.ok(lastBreak(early)[1].includes("마지막 회차가 자정 전에 끊김"));
});

test("설정 없음 · 깨짐 · 옛 판(v1) · 스키마 불일치 · 0 · 음수 · 소수 · 문자열 · 시각 · 날짜 모양 오류 = UNKNOWN(설정 읽기 실패) -- 충족도 미충족도 아니고 기본값으로 대체하지도 않는다", async () => {
  const goodLines = dayLines(-7, -1);
  const cases = [
    ["파일 없음", null],
    ["JSON 깨짐", "{not json"],
    ["스키마 불일치", configJson({ schema_version: "other/v9" })],
    [
      "옛 판 설정(v1 · 동시 배달 문턱)",
      JSON.stringify({
        schema_version: OLD_SCHEMA,
        observationDays: 7,
        minConcurrentTracks: 2,
      }),
    ],
    ["옛 판 이름 + 새 칸", configJson({ schema_version: OLD_SCHEMA })],
    ["observationDays 0", configJson({ observationDays: 0 })],
    ["observationDays 음수", configJson({ observationDays: -7 })],
    ["minDeliveredPerDay 0", configJson({ minDeliveredPerDay: 0 })],
    ["minDeliveredPerDay 소수", configJson({ minDeliveredPerDay: 1.5 })],
    ["minDeliveredPerDay 문자열", configJson({ minDeliveredPerDay: "4" })],
    [
      "minDeliveredPerDay 칸 없음",
      configJson({ minDeliveredPerDay: undefined }),
    ],
    [
      "lastTickCutoffKst 시 범위 밖",
      configJson({ lastTickCutoffKst: "24:00" }),
    ],
    [
      "lastTickCutoffKst 분 범위 밖",
      configJson({ lastTickCutoffKst: "23:60" }),
    ],
    ["lastTickCutoffKst 모양 오류", configJson({ lastTickCutoffKst: "2330" })],
    ["lastTickCutoffKst 숫자", configJson({ lastTickCutoffKst: 2330 })],
    ["lastTickCutoffKst 칸 없음", configJson({ lastTickCutoffKst: undefined })],
    [
      "criterionChangedOn 모양 오류",
      configJson({ criterionChangedOn: "11-17" }),
    ],
    [
      "criterionChangedOn 없는 날짜",
      configJson({ criterionChangedOn: "2026-13-40" }),
    ],
    [
      "criterionChangedOn 칸 없음",
      configJson({ criterionChangedOn: undefined }),
    ],
    ["observationDays 문자열", configJson({ observationDays: "7" })],
    ["칸 없음", JSON.stringify({ schema_version: SCHEMA })],
  ];
  for (const [name, config] of cases) {
    const { reportText } = await runReport(buildRepo(config), {
      machineScopeDailyLines: goodLines,
    });
    const line = scopeLineOf(reportText);
    assert.notEqual(line, undefined, `${name}: 줄이 사라지지 않는다`);
    assert.equal(verdictOf(line), "UNKNOWN(설정", name);
    assert.match(line, /UNKNOWN\(설정 읽기 실패/, name);
    assert.equal(/충족|미충족/.test(line), false, `${name}: 기본값 대체 0`);
  }
});

test("일별 줄을 못 읽었으면(null) UNKNOWN(일별 파일 읽기 실패) · 일별 줄 입력이 없으면(미결선 호출자) 기준 줄 0개 -- 나머지 보고서는 바이트 무변", async () => {
  const repo = buildRepo(configJson());
  const root = tmpDir("nc-machine-scope-run-");
  const base = await runReport(
    repo,
    { confirmedZeroStreakLine: STREAK_LINE },
    root,
  );
  assert.equal(scopeLineOf(base.reportText), undefined, "미결선 = 줄 0개");
  const unreadable = await runReport(
    repo,
    { confirmedZeroStreakLine: STREAK_LINE, machineScopeDailyLines: null },
    root,
  );
  const line = scopeLineOf(unreadable.reportText);
  assert.equal(verdictOf(line), "UNKNOWN(일별");
  assert.match(line, /UNKNOWN\(일별 파일 읽기 실패\)/);
  const withLines = await runReport(
    repo,
    {
      confirmedZeroStreakLine: STREAK_LINE,
      machineScopeDailyLines: dayLines(-7, -1),
    },
    root,
  );
  // 줄 1개를 빼면 입력 없는 보고서와 같다 -- 통지 · 장 수 · ㄴ 분자 · 1-C · 연속 확인-0 줄 전부 바이트 무변(줄만 1개 늘었다).
  // HYK-255-p2b-qual-1 -- 이 픽스처 저장소에는 종류 설정 파일이 없고 기준은 «충족» 이라, withLines 에는 «종류 설정 진단:» 줄이 하나 더 실린다(자격 줄은 «없음» 그대로).
  // 그래서 기준 줄과 진단 줄 둘 다 빼야 입력 없는 보고서와 같다(바뀐 단언: 줄 수 +1 -> +2).
  // HYK-255-p2d-nonecause-1 바뀐 단언(판정 1804 상신 1): 자격 «없음» 줄이 원인에 따라 달라진다(입력 없음 · 못 읽음 = 판독 불가 / 충족 + 종류 설정 없음 = 종류 설정 읽기 실패) --
  // 자격 줄도 strip 대상에 넣고 «자격 줄 1개씩 있다» 만 따로 단언한다(줄 수 +2 · 나머지 바이트 무변은 그대로).
  const DIAG_PREFIX = "종류 설정 진단: ";
  const stripScope = (text) =>
    text
      .split("\n")
      .filter(
        (l) =>
          !l.startsWith(SCOPE_PREFIX) &&
          !l.startsWith(DIAG_PREFIX) &&
          !l.startsWith(QUAL_PREFIX),
      )
      .join("\n");
  for (const r of [base, unreadable, withLines]) {
    assert.equal(
      r.reportText.split("\n").filter((l) => l.startsWith(QUAL_PREFIX)).length,
      1,
      "자격 줄 1개",
    );
  }
  assert.equal(stripScope(withLines.reportText), stripScope(base.reportText));
  assert.equal(stripScope(unreadable.reportText), stripScope(base.reportText));
  assert.equal(
    withLines.reportText.split("\n").length,
    base.reportText.split("\n").length + 2,
  );
  assert.deepEqual(Object.keys(withLines).sort(), Object.keys(base).sort());
  assert.deepEqual(withLines.dailyTick, base.dailyTick, "일별 칸 무변");
});

// ---- watch-run 결선 -- 일별 줄을 보고 단계에 넘기는 기존 길(옵션 한 칸) -----------------------------------------------------

test("일별 단계: 읽은 일별 줄을 보고 단계 옵션 machineScopeDailyLines 로 넘긴다 · 못 읽으면 null · 연속 확인-0 줄 옵션은 그대로", async () => {
  const lines = dayLines(-2, -1);
  const mk = () => {
    const watchDir = tmpDir("nc-machine-scope-watch-");
    fs.writeFileSync(
      join(watchDir, "partial-count-daily.jsonl"),
      lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
      "utf8",
    );
    return watchDir;
  };
  let captured = null;
  const runOnce = async (readFn) => {
    await runPartialCountStep({
      watchDir: mk(),
      now: NOW,
      runPartialCountOnceFn: async (options) => {
        captured = options;
        return { reportText: "x\n" };
      },
      ...(readFn ? { readFn } : {}),
    });
    return captured;
  };
  const ok = await runOnce();
  assert.deepEqual(
    ok.machineScopeDailyLines.map((l) => l.day),
    lines.map((l) => l.day),
  );
  assert.equal(
    ok.confirmedZeroStreakLine,
    core.renderConfirmedZeroStreakLine(
      core.computeConfirmedZeroStreak({ lines, nowMs: NOW }),
    ),
    "연속 확인-0 줄 옵션 무변",
  );
  const broken = await runOnce((p, enc) => {
    if (String(p).endsWith("partial-count-daily.jsonl")) {
      throw new Error("읽기 실패 합성");
    }
    return fs.readFileSync(p, enc);
  });
  assert.equal(broken.machineScopeDailyLines, null);
  assert.equal(
    broken.confirmedZeroStreakLine,
    core.renderConfirmedZeroStreakLine({
      known: false,
      reason: "일별 파일 읽기 실패",
    }),
  );
});

// ---- 설정 파일 · 코드 리터럴 -----------------------------------------------------------------------------------------

test("실물 설정 파일 = 스키마(v3)대로 · 문턱 · 컷 · 기준 변경일이 «이 한 파일» 에만 있다 -- 코드(core · report)에는 그 값을 대입한 리터럴이 없고 옛 키(minConcurrentTracks)는 설정에 없다", () => {
  const raw = fs.readFileSync(
    new URL("./partial-count-machine-scope.json", import.meta.url),
    "utf8",
  );
  const cfg = JSON.parse(raw);
  assert.equal(cfg.schema_version, SCHEMA);
  assert.ok(Number.isInteger(cfg.observationDays) && cfg.observationDays > 0);
  assert.ok(
    Number.isInteger(cfg.minDeliveredPerDay) && cfg.minDeliveredPerDay > 0,
    "배달 문턱 = 양의 정수(값 자체는 단언하지 않는다 -- 설정 값)",
  );
  assert.match(cfg.lastTickCutoffKst, /^([01]\d|2[0-3]):[0-5]\d$/);
  assert.match(cfg.criterionChangedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    Object.hasOwn(cfg, "minConcurrentTracks"),
    false,
    "옛 키 재사용 0",
  );
  // 실물 설정이 합성 설정과 같은 파서로 읽힌다(합성 저장소에 실물 본문을 그대로 심는다).
  const wellFormed = JSON.parse(raw);
  assert.deepEqual(Object.keys(wellFormed).sort(), [
    "criterionChangedOn",
    "lastTickCutoffKst",
    "lowDayHandling",
    "lowDayHandlingChangedOn",
    "minDeliveredPerDay",
    "observationDays",
    "schema_version",
  ]);
  const stripped = (file) =>
    fs
      .readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      .replace(/\/\/.*$/gm, "");
  for (const file of [
    "partial-count-core.mjs",
    "partial-count-report.mjs",
    "partial-count-rescan-core.mjs",
    "partial-count-rescan.mjs",
  ]) {
    const src = stripped(file);
    assert.equal(
      /(observationDays|minDeliveredPerDay|minConcurrentTracks)\s*[:=]\s*\d/.test(
        src,
      ),
      false,
      `${file} 에 관측 일수 · 배달 문턱 리터럴`,
    );
    // 실물 설정의 컷 · 기준 변경일 · 문턱 값이 코드에 문자열/숫자 리터럴로 박혀 있지 않다(설정 값에서 읽어 비교).
    for (const value of [
      cfg.lastTickCutoffKst,
      cfg.criterionChangedOn,
      cfg.lowDayHandlingChangedOn,
    ]) {
      assert.equal(
        src.includes(value),
        false,
        `${file} 에 설정 값 «${value}» 리터럴`,
      );
    }
    assert.equal(
      new RegExp(`\\b${cfg.minDeliveredPerDay}\\s*건`).test(src),
      false,
      `${file} 에 «${cfg.minDeliveredPerDay}건» 리터럴`,
    );
  }
});

test("실물 설정 본문을 합성 origin/master 에 심으면 같은 파서가 읽는다 -- 줄의 기준 숫자 · 컷 · 기준 변경일 = 설정 파일 값 그대로(값 단언은 파일에서 읽은 값과 비교)", async () => {
  const raw = fs.readFileSync(
    new URL("./partial-count-machine-scope.json", import.meta.url),
    "utf8",
  );
  const cfg = JSON.parse(raw);
  const K = cfg.minDeliveredPerDay;
  const [h, m] = cfg.lastTickCutoffKst.split(":").map(Number);
  const cutMin = h * 60 + m;
  const hhmm = (min) =>
    `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const lines = dayLines(-7, -1, (o) => ({
    delivered: K,
    lastTickAtMs: kstAt(o, hhmm(cutMin)),
  }));
  const { reportText } = await runReport(buildRepo(raw), {
    machineScopeDailyLines: lines,
  });
  const scope = scopeLineOf(reportText);
  assert.equal(verdictOf(scope), "충족");
  assert.deepEqual(criterion(scope), [
    cfg.observationDays,
    K,
    cfg.lastTickCutoffKst,
  ]);
  assert.equal(changedOn(scope), cfg.criterionChangedOn);
  // 실물 컷 1분 전 = 끊김 · 문턱 - 1 = (실물 설정 = skip) 건너뜀 -- 7일 모두 건너뜀이면 일한 날 0 = 미충족(단언 무변 · 건너뜀 쪽 정본 시험은 partial-count-skipday.test.mjs).
  const early = await runReport(buildRepo(raw), {
    machineScopeDailyLines: dayLines(-7, -1, (o) => ({
      delivered: K,
      lastTickAtMs: kstAt(o, hhmm(cutMin - 1)),
    })),
  });
  assert.equal(verdictOf(scopeLineOf(early.reportText)), "미충족");
  const under = await runReport(buildRepo(raw), {
    machineScopeDailyLines: dayLines(-7, -1, (o) => ({
      delivered: K - 1,
      lastTickAtMs: kstAt(o, hhmm(cutMin)),
    })),
  });
  assert.equal(verdictOf(scopeLineOf(under.reportText)), "미충족");
});
