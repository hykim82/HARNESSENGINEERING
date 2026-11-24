// HYK-255-skipday-scope-1 (한용 확정 2026-11-23 «선택할 일은 책임 추천대로 진행해» · 전달 #20261123-1740 확정 1 + 확정 3 · 설계 PM-receipt-r36 (라) T-A~T-G) --
// 적은 날(배달 4건 미만 · 0 포함)이고 다른 끊김 사유가 없는 날은 건너뜀(연속을 더하지도 끊지도 않음) · 끊김 사유가 하나라도 있으면 여전히 끊김 ·
// met = 일한 날 ≥ 관측 일수 · 보고 줄 · 자격 줄에 일한 날 · 건너뛴 날 · 달력 기간 · 설정 v3(lowDayHandling) · 종류 설정 v2(plain 필수 · 잠정 꼬리표 없음) ·
// 자격 «부분 있음» 회차에만 «선언문 범위 시안» 절.
//
// ⛔헛시험 금지: 프로덕션 export(computeMachineScope · renderMachineScopeLine · computeQualification · renderQualificationLine · renderDeclarationScopeLines ·
// runPartialCountOnce)를 직접 구동한다 -- 사본 import 0. 기대값은 이 파일 안에서 손으로 정한 값(같은 함수로 기대값을 만들지 않는다).
// ⛔시험 단언 규율: 출력 «전체» 문자열 동등 단언 0 -- 토막 단언. 실제 .harness · 관제실 일별 줄 · 보고 파일 · 원격 · 토큰 읽기 0(mkdtemp 합성 저장소 · 주입 시계 · 주입 일별 줄).
// ⛔실행 환경 무관: 시각은 전부 «+09:00» 명시 Date.parse · 달력 날짜는 Date.UTC 산수 -- 로컬 시각 생성자 · 로컬 접근자 · toLocale* 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";

const NOW = Date.parse("2026-11-15T15:00:00+09:00");
const SCOPE_CONFIG_PATH = "scripts/supervisor/partial-count-machine-scope.json";
const KINDS_CONFIG_PATH =
  "scripts/supervisor/partial-count-uncountable-kinds.json";
const SCOPE_SCHEMA = "partial-count-machine-scope/v3";
const KINDS_SCHEMA = "partial-count-uncountable-kinds/v2";
const SCOPE_PREFIX = "기계 계수 범위 기준: ";
const QUAL_PREFIX = "1-C 판정 자격: ";
const DIAG_PREFIX = "종류 설정 진단: ";
const SILENT_ZERO_LIMIT =
  "배달 기록이 조용히 고장 나 0 이 된 날은 쉬는 날과 구별되지 않는다";
const K8_PLAIN = "화면을 보기만 한 것은 개입으로 세지 않는다";
const K8_LIMIT =
  "못 덮는 경우: 보고 나서 한 판단은 채팅 지시 등 다른 종류로 센다";
const FAIL404 = { ok: false, status: 404, json: null, linkHeader: null };
const PROOF_DEVICE = "scripts/synthetic-proof-device.mjs";

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
test.after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

// 합성 설정 -- 실물 설정(7 · 4 · 23:30 · 2026-11-17 · 2026-11-23)과 일부러 다른 값(코드가 실물 값을 박았다면 이 파일이 잡는다).
const K = 3;
const CFG = {
  observationDays: 7,
  minDeliveredPerDay: K,
  lastTickCutoffKst: "23:15",
  criterionChangedOn: "2026-11-01",
  lowDayHandling: "skip",
  lowDayHandlingChangedOn: "2026-11-10",
};

// ---- 합성 일별 줄(오늘 = 2026-11-15 · offset -1 = 어제) -------------------------------------------------------------------
const dayStr = (offset) =>
  new Date(Date.UTC(2026, 10, 15 + offset)).toISOString().slice(0, 10);
const kstAt = (offset, hhmm) =>
  Date.parse(`${dayStr(offset)}T${hhmm}:00+09:00`);
const dayLine = (offset, over = {}) => ({
  schema: core.DAILY_SCHEMA,
  day: dayStr(offset),
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  coverageGaps: { count: 0, totalMs: 0 },
  // 동시 배달 최대 = 2 -- 배달 0 인 날에도 이 값이 있다(ⓒ-3: 이 값으로는 «기록 불일치» 를 판정하지 않는다).
  concurrentTracksMax: 2,
  delivered: K,
  lastTickAtMs: kstAt(offset, "23:58"),
  uncountedExampleIds: [],
  permissionHumanAnswers: 0,
  permissionUndecidable: 0,
  githubHumanActions: 0,
  ...over,
});
// offset 마다 [offset, 덮을 칸] 쌍 목록에서 줄을 만든다.
const linesOf = (spec) =>
  spec.map(([offset, over]) => dayLine(offset, over ?? {}));
const WORKED = {}; // 일한 날(배달 = 문턱)
const SKIPPED = { delivered: 0 }; // 적은 날(배달 0)
const scopeOf = (lines, over = {}) =>
  core.computeMachineScope({ lines, nowMs: NOW, ...CFG, ...over });
const renderScope = (lines, over = {}) =>
  core.renderMachineScopeLine(scopeOf(lines, over));

// ---- T-A 진리표 20칸 1:1 -------------------------------------------------------------------------------------------------
// 열 = 배달 값 모양 · 행 = [다른 끊김 사유 · 마지막 회차 컷]. 결과 = count(셈) | skip(건너뜀) | break(끊김).
const DELIVERED_VALUES = {
  high: [K, K + 10],
  low: [0, K - 1],
  unknown: [null, undefined, "5", 2.5, -1],
};
const CUT_TIME = { ok: "23:58", short: "22:00", none: null };
// [id, 다른 끊김 사유 있음, 컷, 배달 열, 기대]
const CELLS = [
  ["A01", true, "ok", "high", "break"],
  ["A02", true, "ok", "low", "break"],
  ["A03", true, "ok", "unknown", "break"],
  ["A04", true, "short", "high", "break"],
  ["A05", true, "short", "low", "break"],
  ["A06", true, "short", "unknown", "break"],
  ["A07", true, "none", "high", "break"],
  ["A08", true, "none", "low", "break"],
  ["A09", true, "none", "unknown", "break"],
  ["A10", false, "ok", "high", "count"],
  ["A11", false, "ok", "low", "skip"],
  ["A12", false, "ok", "unknown", "break"],
  ["A13", false, "short", "high", "break"],
  ["A14", false, "short", "low", "break"],
  ["A15", false, "short", "unknown", "break"],
  ["A16", false, "none", "high", "count"],
  ["A17", false, "none", "low", "skip"],
  ["A18", false, "none", "unknown", "break"],
];
const YESTERDAY = dayStr(-1);
const DAY_BEFORE = dayStr(-2);

function cellLine(other, cut, value) {
  const over = {};
  if (value === undefined) over.delivered = undefined;
  else over.delivered = value;
  if (CUT_TIME[cut] === null) over.lastTickAtMs = undefined;
  else over.lastTickAtMs = kstAt(-1, CUT_TIME[cut]);
  if (other) over.lnUnchecked = 1;
  const line = dayLine(-1, over);
  for (const k of Object.keys(line)) {
    if (line[k] === undefined) delete line[k];
  }
  return line;
}
function expectedBreakReasons(other, cut, column, value) {
  const want = [];
  if (other) want.push("미조회 1");
  if (column === "unknown") want.push("배달 값 없음");
  if (column === "low") want.push(`배달(24시간 창) ${value}건 < 기준 ${K}건`);
  if (cut === "short") want.push("마지막 회차가 자정 전에 끊김");
  return want;
}

for (const [id, other, cut, column, expected] of CELLS) {
  for (const value of DELIVERED_VALUES[column]) {
    test(`T-A ${id} 진리표: 다른 끊김 사유 ${other ? "있음" : "없음"} · 컷 ${cut} · 배달 ${column}(${String(value)}) = ${expected}`, () => {
      const scope = scopeOf([cellLine(other, cut, value)]);
      assert.equal(scope.known, true);
      if (expected === "break") {
        assert.equal(scope.days, 0, "일한 날 0");
        assert.equal(scope.skippedDays, 0, "건너뛴 날 0");
        assert.equal(scope.fromDay, null);
        assert.equal(scope.toDay, null);
        assert.equal(scope.lastBreak.day, YESTERDAY, "어제에서 끊김");
        for (const want of expectedBreakReasons(other, cut, column, value)) {
          assert.ok(
            scope.lastBreak.reasons.some((r) => r.includes(want)),
            `${want} ∈ ${scope.lastBreak.reasons.join(" | ")}`,
          );
        }
        return;
      }
      assert.equal(scope.days, expected === "count" ? 1 : 0);
      assert.equal(scope.skippedDays, expected === "skip" ? 1 : 0);
      assert.equal(scope.fromDay, YESTERDAY, "달력 기간 첫날 = 그날");
      assert.equal(scope.toDay, YESTERDAY, "달력 기간 끝 = 어제");
      assert.equal(scope.lastBreak.day, DAY_BEFORE, "그 앞 줄 없음에서 끊김");
      assert.deepEqual(scope.lastBreak.reasons, ["줄 없음"]);
    });
  }
}

test("T-A A19 진리표: 줄 없음 = 끊김(건너뜀이 아니다 · 무한 루프 없이 멈춘다) -- 줄이 하나도 없어도 · 어제 줄이 없고 더 앞 줄만 있어도", () => {
  for (const lines of [[], linesOf([[-3, WORKED]]), linesOf([[-5, SKIPPED]])]) {
    const scope = scopeOf(lines);
    assert.equal(scope.days, 0);
    assert.equal(scope.skippedDays, 0);
    assert.equal(scope.lastBreak.day, YESTERDAY);
    assert.deepEqual(scope.lastBreak.reasons, ["줄 없음"]);
    assert.equal(scope.toDay, null);
  }
});

test("T-A A20 진리표: 줄 중복 = 끊김 -- 같은 날 줄이 둘이면 둘 다 일한 날 모양이어도 · 둘 다 적은 날 모양이어도", () => {
  for (const spec of [
    [WORKED, WORKED],
    [SKIPPED, SKIPPED],
  ]) {
    const scope = scopeOf(spec.map((over) => dayLine(-1, over)));
    assert.equal(scope.days, 0);
    assert.equal(scope.skippedDays, 0);
    assert.equal(scope.lastBreak.day, YESTERDAY);
    assert.deepEqual(scope.lastBreak.reasons, ["줄 중복 2"]);
  }
});

test("T-A 20칸 목록 = 셈 2 · 건너뜀 2 · 끊김 16(진리표 칸 수가 설계와 같다)", () => {
  const all = [...CELLS.map((c) => c[4]), "break", "break"];
  assert.equal(all.length, 20);
  assert.equal(all.filter((v) => v === "count").length, 2);
  assert.equal(all.filter((v) => v === "skip").length, 2);
  assert.equal(all.filter((v) => v === "break").length, 16);
});

// ---- T-B 다른 끊김 사유 종류별 -------------------------------------------------------------------------------------------
const OTHER_BREAKS = [
  ["미조회", { lnUnchecked: 2 }, "미조회 2"],
  ["확인", { lnConfirmed: 1 }, "확인 1"],
  ["수집 실패", { collectorFails: ["aux"] }, "수집 실패(aux)"],
  ["수집 실패 UNKNOWN", { collectorFails: null }, "수집 실패 UNKNOWN"],
  ["관측 공백", { coverageGaps: { count: 1, totalMs: 1 } }, "관측 공백 1구간"],
  ["권한 사람 답", { permissionHumanAnswers: 1 }, "권한 확인창 사람 답 1"],
  ["권한 판정 불가", { permissionUndecidable: 2 }, "권한 판정 불가 2"],
  [
    "권한 칸 없음",
    { permissionHumanAnswers: undefined },
    "권한 확인창 사람 답 칸 없음",
  ],
  ["GitHub 사람 손", { githubHumanActions: 1 }, "GitHub 사람 손 조작 1"],
  [
    "GitHub 칸 없음",
    { githubHumanActions: undefined },
    "GitHub 사람 손 조작 칸 없음",
  ],
];
for (const [name, over, want] of OTHER_BREAKS) {
  test(`T-B 건너뛴 날 × ${name} = 끊김 -- lastBreak.reasons 에 그 사유와 적은 날 사유가 함께 남는다(쉬는 날로 개입을 숨길 수 없다)`, () => {
    const line = dayLine(-1, { ...SKIPPED, ...over });
    for (const k of Object.keys(line)) {
      if (line[k] === undefined) delete line[k];
    }
    const scope = scopeOf([line]);
    assert.equal(scope.days, 0);
    assert.equal(scope.skippedDays, 0, "건너뜀이 아니다");
    assert.equal(scope.lastBreak.day, YESTERDAY);
    assert.ok(
      scope.lastBreak.reasons.some((r) => r.includes(want)),
      `${want} ∈ ${scope.lastBreak.reasons.join(" | ")}`,
    );
    assert.ok(
      scope.lastBreak.reasons.includes(`배달(24시간 창) 0건 < 기준 ${K}건`),
      "적은 날 사유도 함께",
    );
  });
}

test("T-B 같은 사유를 일한 날에 심어도 끊김 -- 건너뛴 날에만 특별 취급하지 않는다(어제 일한 날 + 그제 건너뛴 날 + 그끄제 개입)", () => {
  const scope = scopeOf(
    linesOf([
      [-3, { lnConfirmed: 1 }],
      [-2, SKIPPED],
      [-1, WORKED],
    ]),
  );
  assert.equal(scope.days, 1);
  assert.equal(scope.skippedDays, 1);
  assert.equal(
    scope.fromDay,
    dayStr(-2),
    "달력 기간 첫날 = 끊김 다음 날(건너뛴 날)",
  );
  assert.equal(scope.lastBreak.day, dayStr(-3));
  assert.deepEqual(scope.lastBreak.reasons, ["확인 1"]);
});

// ---- T-C 묶음 -------------------------------------------------------------------------------------------------------------
test("T-C① 일한 날 7 + 건너뛴 날 2 섞임 = 충족 -- 달력 기간 = 마지막 끊김 다음 날~어제(건너뛴 날 포함) · 줄에 일한 날 · 건너뛴 날 · 달력 기간", () => {
  const spec = [
    [-9, WORKED],
    [-8, SKIPPED],
    [-7, WORKED],
    [-6, WORKED],
    [-5, WORKED],
    [-4, SKIPPED],
    [-3, WORKED],
    [-2, WORKED],
    [-1, WORKED],
  ];
  const scope = scopeOf(linesOf(spec));
  assert.equal(scope.days, 7);
  assert.equal(scope.skippedDays, 2);
  assert.equal(scope.met, true);
  assert.equal(scope.fromDay, "2026-11-06");
  assert.equal(scope.toDay, "2026-11-14");
  assert.equal(scope.lastBreak.day, "2026-11-05");
  const line = core.renderMachineScopeLine(scope);
  assert.ok(line.startsWith(`${SCOPE_PREFIX}충족`), line);
  assert.ok(line.includes("일한 날 7일 / 기준 7일"), line);
  assert.ok(line.includes("건너뛴 날 2일"), line);
  assert.ok(line.includes("달력 기간 2026-11-06~2026-11-14"), line);
});

test("T-C② 일한 날 6 + 건너뛴 날 3 = 미충족 -- 건너뛴 날은 일한 날에 더하지 않는다(6 + 3 = 9 ≥ 7 이어도 미충족)", () => {
  const spec = [
    [-9, SKIPPED],
    [-8, WORKED],
    [-7, WORKED],
    [-6, WORKED],
    [-5, SKIPPED],
    [-4, WORKED],
    [-3, WORKED],
    [-2, SKIPPED],
    [-1, WORKED],
  ];
  const scope = scopeOf(linesOf(spec));
  assert.equal(scope.days, 6);
  assert.equal(scope.skippedDays, 3);
  assert.equal(scope.met, false);
  assert.ok(
    core
      .renderMachineScopeLine(scope)
      .startsWith(`${SCOPE_PREFIX}미충족 — 일한 날 6일 / 기준 7일`),
  );
});

test("T-C③ 앞쪽 건너뜀(끊김 → 건너뜀 → 일 → 일) -- 달력 기간 첫날 = 그 건너뛴 날(첫 일한 날이 아니다)", () => {
  const scope = scopeOf(
    linesOf([
      [-4, { lnUnchecked: 1 }],
      [-3, SKIPPED],
      [-2, WORKED],
      [-1, WORKED],
    ]),
  );
  assert.equal(scope.days, 2);
  assert.equal(scope.skippedDays, 1);
  assert.equal(scope.fromDay, "2026-11-12");
  assert.equal(scope.toDay, "2026-11-14");
  assert.equal(scope.lastBreak.day, "2026-11-11");
});

test("T-C④ 건너뜀만(일한 날 0) = 달력 기간 있음 · 미충족 -- 줄에 «달력 기간 없음» 이 아니다", () => {
  const scope = scopeOf(
    linesOf([
      [-3, { lnUnchecked: 1 }],
      [-2, SKIPPED],
      [-1, SKIPPED],
    ]),
  );
  assert.equal(scope.days, 0);
  assert.equal(scope.skippedDays, 2);
  assert.equal(scope.met, false);
  assert.equal(scope.fromDay, "2026-11-13");
  assert.equal(scope.toDay, "2026-11-14");
  const line = core.renderMachineScopeLine(scope);
  assert.ok(line.includes("일한 날 0일"), line);
  assert.ok(line.includes("건너뛴 날 2일"), line);
  assert.ok(line.includes("달력 기간 2026-11-13~2026-11-14"), line);
});

test("T-C⑤ 어제가 끊김 = 달력 기간 «없음»(일한 날 0 · 건너뛴 날 0)", () => {
  const scope = scopeOf(
    linesOf([
      [-3, WORKED],
      [-2, WORKED],
      [-1, { lnConfirmed: 1 }],
    ]),
  );
  assert.equal(scope.days, 0);
  assert.equal(scope.skippedDays, 0);
  assert.equal(scope.fromDay, null);
  assert.equal(scope.toDay, null);
  const line = core.renderMachineScopeLine(scope);
  assert.ok(line.includes("달력 기간 없음"), line);
  assert.ok(line.includes("마지막 끊김 2026-11-14 확인 1"), line);
});

// 11-14~11-22 실물 일별 줄 칸 값을 «합성 줄로 복사»한 재생(근거 부록 §B · 원본 파일을 읽지 않는다).
const REAL_NOW = Date.parse("2026-11-23T08:00:00+09:00");
const REAL_CFG = {
  observationDays: 7,
  minDeliveredPerDay: 4,
  lastTickCutoffKst: "23:30",
  criterionChangedOn: "2026-11-17",
  lowDayHandling: "skip",
  lowDayHandlingChangedOn: "2026-11-23",
};
const realLine = (day, over) => ({
  schema: core.DAILY_SCHEMA,
  day,
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  coverageGaps: { count: 0, totalMs: 0 },
  concurrentTracksMax: 2,
  lastTickAtMs: Date.parse(`${day}T23:58:00+09:00`),
  uncountedExampleIds: [],
  permissionHumanAnswers: 0,
  permissionUndecidable: 0,
  githubHumanActions: 0,
  ...over,
});
const REAL_REPLAY = [
  realLine("2026-11-14", {
    delivered: 17,
    lnConfirmed: 1,
    coverageGaps: { count: 1, totalMs: 1 },
    permissionHumanAnswers: 1,
    permissionUndecidable: 6,
    githubHumanActions: undefined,
  }),
  realLine("2026-11-15", {
    delivered: 3,
    lnConfirmed: 1,
    githubHumanActions: null,
  }),
  realLine("2026-11-16", { delivered: 13 }),
  realLine("2026-11-17", { delivered: 14 }),
  realLine("2026-11-18", { delivered: 17, permissionHumanAnswers: 1 }),
  realLine("2026-11-19", { delivered: 18, permissionHumanAnswers: 1 }),
  realLine("2026-11-20", { delivered: 21 }),
  realLine("2026-11-21", { delivered: 5 }),
  realLine("2026-11-22", { delivered: 3 }),
].map((l) => {
  const copy = { ...l };
  for (const k of Object.keys(copy)) if (copy[k] === undefined) delete copy[k];
  return copy;
});

test("T-C⑥ 11-17~11-22 실물 줄 값 재생 = 일한 날 2 · 건너뛴 날 1 · 달력 기간 11-20~11-22 · 마지막 끊김 11-19(권한 확인창 사람 답 1) · 미충족", () => {
  const scope = core.computeMachineScope({
    lines: REAL_REPLAY,
    nowMs: REAL_NOW,
    ...REAL_CFG,
  });
  assert.equal(scope.days, 2);
  assert.equal(scope.skippedDays, 1);
  assert.equal(scope.fromDay, "2026-11-20");
  assert.equal(scope.toDay, "2026-11-22");
  assert.equal(scope.lastBreak.day, "2026-11-19");
  assert.deepEqual(scope.lastBreak.reasons, ["권한 확인창 사람 답 1"]);
  assert.equal(scope.met, false);
  const line = core.renderMachineScopeLine(scope);
  assert.ok(line.includes("일한 날 2일 / 기준 7일"), line);
  assert.ok(line.includes("건너뛴 날 1일"), line);
  assert.ok(line.includes("달력 기간 2026-11-20~2026-11-22"), line);
  assert.ok(
    line.includes("마지막 끊김 2026-11-19 권한 확인창 사람 답 1"),
    line,
  );
});

test("T-C⑥ 같은 재생을 «건너뜀 끔(break)» 설정으로 돌리면 11-22(배달 3 < 4)가 끊김 = 일한 날 0 · 건너뛴 날 0 -- 옛 판 동작(지금 값 연속 0일)이 설정 한 칸으로 돌아온다", () => {
  const scope = core.computeMachineScope({
    lines: REAL_REPLAY,
    nowMs: REAL_NOW,
    ...REAL_CFG,
    lowDayHandling: "break",
  });
  assert.equal(scope.days, 0);
  assert.equal(scope.skippedDays, 0);
  assert.equal(scope.lastBreak.day, "2026-11-22");
  assert.deepEqual(scope.lastBreak.reasons, ["배달(24시간 창) 3건 < 기준 4건"]);
});

test("T-C⑦ 경계: 배달 = 기준 K 는 셈 · K - 1 은 건너뜀 -- 어제 하루로 가름", () => {
  const atK = scopeOf(linesOf([[-1, { delivered: K }]]));
  assert.equal(atK.days, 1);
  assert.equal(atK.skippedDays, 0);
  const underK = scopeOf(linesOf([[-1, { delivered: K - 1 }]]));
  assert.equal(underK.days, 0);
  assert.equal(underK.skippedDays, 1);
});

test("ⓒ-3 모순 칸 미적용 -- 배달 0 인데 동시 배달 최대 ≥ 1 인 날도 건너뜀(끊김 아님) · 보고 줄에 정직 한계 문면이 건너뜀 여부와 무관하게 늘 실린다", () => {
  const scope = scopeOf(
    linesOf([[-1, { delivered: 0, concurrentTracksMax: 5 }]]),
  );
  assert.equal(scope.skippedDays, 1);
  assert.equal(scope.days, 0);
  for (const over of [{}, { lowDayHandling: "break" }]) {
    const line = renderScope(linesOf([[-1, WORKED]]), over);
    assert.ok(
      line.includes(SILENT_ZERO_LIMIT),
      `${over.lowDayHandling}: ${line}`,
    );
    const unmet = renderScope(linesOf([[-1, { lnConfirmed: 1 }]]), over);
    assert.ok(unmet.includes(SILENT_ZERO_LIMIT), unmet);
  }
});

// ---- 합성 저장소 · 보고 진입점 --------------------------------------------------------------------------------------------
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
const scopeJson = (over = {}) =>
  JSON.stringify({ schema_version: SCOPE_SCHEMA, ...CFG, ...over });
const REAL_KINDS = fs.readFileSync(
  new URL("./partial-count-uncountable-kinds.json", import.meta.url),
  "utf8",
);
const REAL_SCOPE = fs.readFileSync(
  new URL("./partial-count-machine-scope.json", import.meta.url),
  "utf8",
);

// scopeConfig · kindsConfig: 문자열 = 그 내용을 origin/master 판본에 심는다 · null = 파일 없음.
function buildRepo({
  scopeConfig = scopeJson(),
  kindsConfig = REAL_KINDS,
} = {}) {
  const dir = tmpDir("nc-skipday-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  fs.writeFileSync(join(dir, PROOF_DEVICE), "// device\n", "utf8");
  if (scopeConfig !== null) {
    fs.writeFileSync(join(dir, SCOPE_CONFIG_PATH), scopeConfig, "utf8");
  }
  if (kindsConfig !== null) {
    fs.writeFileSync(join(dir, KINDS_CONFIG_PATH), kindsConfig, "utf8");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "root"]);
  git(dir, ["remote", "add", "origin", "https://example.invalid/f.git"]);
  git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  return dir;
}
async function runReport(repoDir, extra = {}) {
  const root = tmpDir("nc-skipday-run-");
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
const reportLines = (text) => text.split("\n");
const lineStarting = (text, prefix) =>
  reportLines(text).find((l) => l.startsWith(prefix));
// T-C① 와 같은 9일(일한 날 7 · 건너뛴 날 2) -- 합성 설정에서 «충족».
const MET_SPEC = [
  [-9, WORKED],
  [-8, SKIPPED],
  [-7, WORKED],
  [-6, WORKED],
  [-5, WORKED],
  [-4, SKIPPED],
  [-3, WORKED],
  [-2, WORKED],
  [-1, WORKED],
];
const MET_LINES = linesOf(MET_SPEC);
const UNMET_LINES = linesOf(MET_SPEC.slice(3)); // 일한 날 5 · 건너뛴 날 1 · 미충족 -- 앞쪽은 줄 없음 끊김

// ---- T-D 설정 v3 -----------------------------------------------------------------------------------------------------------
test("T-D 설정 v3 skip: 어제 배달 0(적은 날) -> 보고 줄 = 일한 날 2 · 건너뛴 날 1 · 달력 기간 · 설정의 건너뜀 날짜", async () => {
  const lines = linesOf([
    [-3, WORKED],
    [-2, WORKED],
    [-1, SKIPPED],
  ]);
  const { reportText } = await runReport(buildRepo(), {
    machineScopeDailyLines: lines,
  });
  const line = lineStarting(reportText, SCOPE_PREFIX);
  assert.ok(line.startsWith(`${SCOPE_PREFIX}미충족`), line);
  assert.ok(line.includes("일한 날 2일 / 기준 7일"), line);
  assert.ok(line.includes("건너뛴 날 1일"), line);
  assert.ok(line.includes("달력 기간 2026-11-12~2026-11-14"), line);
  assert.ok(line.includes("건너뜀 2026-11-10"), "설정의 건너뜀 날짜");
});

test("T-D 설정 v3 break(= 지금 동작): 같은 줄에서 어제 배달 0 = 끊김 · 일한 날 0 · 사유 문면 그대로 · 건너뛴 날 토막 없음", async () => {
  const lines = linesOf([
    [-3, WORKED],
    [-2, WORKED],
    [-1, SKIPPED],
  ]);
  const { reportText } = await runReport(
    buildRepo({ scopeConfig: scopeJson({ lowDayHandling: "break" }) }),
    { machineScopeDailyLines: lines },
  );
  const line = lineStarting(reportText, SCOPE_PREFIX);
  assert.ok(line.includes("일한 날 0일 / 기준 7일"), line);
  assert.ok(
    line.includes("마지막 끊김 2026-11-14 배달(24시간 창) 0건 < 기준 3건"),
    line,
  );
  assert.equal(line.includes("건너뛴 날"), false, line);
  assert.equal(line.includes("건너뜀 20"), false, line);
});

const BAD_SCOPE_CONFIGS = [
  ["옛 v2 스키마", { schema_version: "partial-count-machine-scope/v2" }],
  ["lowDayHandling 칸 없음", { lowDayHandling: undefined }],
  ["모르는 lowDayHandling 값", { lowDayHandling: "ignore" }],
  ["lowDayHandling 이 문자열이 아님", { lowDayHandling: true }],
  ["건너뜀 날짜 칸 없음", { lowDayHandlingChangedOn: undefined }],
  ["건너뜀 날짜 모양 오류", { lowDayHandlingChangedOn: "yesterday" }],
  ["건너뜀 날짜가 달력에 없는 날", { lowDayHandlingChangedOn: "2026-13-40" }],
];
for (const [name, over] of BAD_SCOPE_CONFIGS) {
  test(`T-D 설정 ${name} = UNKNOWN(설정 읽기 실패) -- 기본값으로 대체하지 않는다 · 자격 줄은 «판독 불가» 원인`, async () => {
    const { reportText } = await runReport(
      buildRepo({ scopeConfig: scopeJson(over) }),
      { machineScopeDailyLines: MET_LINES },
    );
    const line = lineStarting(reportText, SCOPE_PREFIX);
    assert.ok(line.startsWith(`${SCOPE_PREFIX}UNKNOWN(설정 읽기 실패`), line);
    const qual = lineStarting(reportText, QUAL_PREFIX);
    assert.ok(qual.startsWith(`${QUAL_PREFIX}없음`), qual);
    assert.equal(reportText.includes("선언문 범위 시안"), false);
  });
}

test("T-D 실물 설정 파일 = v3 · lowDayHandling skip · 건너뜀 날짜 2026-11-23 · 이 값들은 «이 한 파일» 에만 있다(core · report 코드에 날짜 리터럴 0)", () => {
  const cfg = JSON.parse(REAL_SCOPE);
  assert.equal(cfg.schema_version, SCOPE_SCHEMA);
  assert.equal(cfg.lowDayHandling, "skip");
  assert.equal(cfg.lowDayHandlingChangedOn, "2026-11-23");
  assert.equal(cfg.observationDays, 7);
  assert.equal(cfg.minDeliveredPerDay, 4);
  for (const f of ["partial-count-core.mjs", "partial-count-report.mjs"]) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.equal(src.includes("2026-11-23"), false, `${f}: 날짜 리터럴 0`);
  }
});

// ---- T-E 보고 진입점 -------------------------------------------------------------------------------------------------------
test("T-E 부분 있음 회차: 기계 계수 줄 · 자격 줄에 일한 날 · 건너뛴 날 · 달력 기간 · 보고서에 «잠정» 0 · 선언문 범위 절 정확히 1번", async () => {
  const { reportText } = await runReport(buildRepo(), {
    machineScopeDailyLines: MET_LINES,
  });
  const scopeLine = lineStarting(reportText, SCOPE_PREFIX);
  assert.ok(scopeLine.startsWith(`${SCOPE_PREFIX}충족`), scopeLine);
  assert.ok(scopeLine.includes("일한 날 7일 / 기준 7일"), scopeLine);
  assert.ok(scopeLine.includes("건너뛴 날 2일"), scopeLine);
  assert.ok(scopeLine.includes("달력 기간 2026-11-06~2026-11-14"), scopeLine);
  const qual = lineStarting(reportText, QUAL_PREFIX);
  assert.ok(qual.startsWith(`${QUAL_PREFIX}부분 있음`), qual);
  assert.ok(qual.includes("일한 날 7일 / 기준 7일"), qual);
  assert.ok(qual.includes("건너뛴 날 2일"), qual);
  assert.ok(qual.includes("달력 기간 2026-11-06~2026-11-14"), qual);
  assert.ok(qual.includes("알려진 못 세는 종류 15"), qual);
  assert.ok(qual.includes("범위 밖은 영구 부분"), qual);
  assert.equal(reportText.includes("잠정"), false, "보고서에 «잠정» 0");
  assert.equal(
    reportLines(reportText).filter((l) => l.startsWith("선언문 범위 시안"))
      .length,
    1,
  );
  assert.equal(lineStarting(reportText, DIAG_PREFIX), undefined);
});

test("T-E 선언문 범위 절: 실물 종류 설정 15행의 쉬운 말(plain)이 설정 순서대로 · k08 두 줄(보기만 한 것 · 못 덮는 경우)이 바로 이어서 · 기간 줄에 일한 날 · 건너뛴 날 · 달력 기간", async () => {
  const { reportText } = await runReport(buildRepo(), {
    machineScopeDailyLines: MET_LINES,
  });
  const lines = reportLines(reportText);
  const at = lines.findIndex((l) => l.startsWith("선언문 범위 시안"));
  assert.notEqual(at, -1);
  const section = lines.slice(at);
  const period = section.find((l) => l.startsWith("- 기간:"));
  assert.ok(period.includes("달력 2026-11-06~2026-11-14"), period);
  assert.ok(period.includes("일한 날 7일"), period);
  assert.ok(period.includes("건너뛴 날 2일"), period);
  const kinds = JSON.parse(REAL_KINDS).kinds;
  assert.equal(kinds.length, 15);
  const listed = section.filter((l) => /^ {2}· k\d+ /.test(l));
  assert.deepEqual(
    listed.map((l) => l.trim().split(" ")[1]),
    [
      ...kinds.filter((k) => k.handling === "partial-scope").map((k) => k.id),
      "k08",
    ],
    "범위 밖 칸 = 부분 범위 14행(설정 순서) · 이어서 정의상 개입이 아닌 것 칸의 k08 -- 15행 전부",
  );
  for (const k of kinds) {
    assert.ok(
      listed.some((l) => l.includes(`${k.id} ${k.plain}`)),
      `${k.id} 쉬운 말`,
    );
    assert.equal(
      section.some((l) => l.includes(k.name)),
      false,
      `${k.id}: 이름(name)이 아니라 쉬운 말(plain)을 싣는다`,
    );
  }
  const k8 = section.findIndex((l) => l.includes(`k08 ${K8_PLAIN}`));
  assert.notEqual(k8, -1, "k08 첫 줄");
  assert.ok(section[k8 + 1].includes(K8_LIMIT), "k08 둘째 줄이 바로 다음");
  assert.ok(
    section.some((l) => l.startsWith("- 정의상 개입이 아닌 것")),
    "정의상 개입이 아닌 것 칸",
  );
  assert.ok(
    section.some(
      (l) => l.startsWith("- 예방 증명이 선 종류") && l.includes("없음"),
    ),
    "예방 증명 0 = 없음",
  );
});

test("T-E «없음» 회차(일한 날 5 · 미충족): 선언문 범위 절 0줄 · 자격 줄 «없음» 은 바이트 무변(원인 = 기계 계수 범위 기준 미충족) · 줄에 일한 날 · 건너뛴 날 · 달력 기간", async () => {
  const { reportText } = await runReport(buildRepo(), {
    machineScopeDailyLines: UNMET_LINES,
  });
  assert.equal(reportText.includes("선언문 범위 시안"), false);
  assert.equal(
    reportLines(reportText).filter((l) => l === "- 기간:").length,
    0,
  );
  const noneLine = core.renderQualificationLine({
    state: "none",
    cause: core.QUALIFICATION_NONE_CAUSE.SCOPE_UNMET,
  });
  assert.ok(reportLines(reportText).includes(noneLine), noneLine);
  const scopeLine = lineStarting(reportText, SCOPE_PREFIX);
  assert.ok(
    scopeLine.startsWith(`${SCOPE_PREFIX}미충족 — 일한 날 5일`),
    scopeLine,
  );
  assert.ok(scopeLine.includes("건너뛴 날 1일"), scopeLine);
  assert.ok(scopeLine.includes("달력 기간 2026-11-09~2026-11-14"), scopeLine);
  assert.equal(reportText.includes("잠정"), false);
});

test("T-E 일별 줄을 못 받은 회차(machineScopeDailyLines 없음 · null): 선언문 범위 절 0줄", async () => {
  for (const extra of [{}, { machineScopeDailyLines: null }]) {
    const { reportText } = await runReport(buildRepo(), extra);
    assert.equal(reportText.includes("선언문 범위 시안"), false);
  }
});

// ---- T-F 확정 3 ------------------------------------------------------------------------------------------------------------
const kindRow = (i, handling, extra = {}) => ({
  id: `k${String(i).padStart(2, "0")}`,
  name: `합성-이름-${i}`,
  plain: `합성-쉬운말-${i}`,
  handling,
  source: `synthetic:${i}`,
  ...extra,
});
const THREE_ROWS = [
  kindRow(1, "prevention-proof", { proofDevice: PROOF_DEVICE }),
  kindRow(2, "partial-scope"),
  kindRow(3, "excluded-by-definition", { plainLimit: "합성-한계-3" }),
];
const kindsJson = (rows, over = {}) =>
  JSON.stringify({ schema_version: KINDS_SCHEMA, kinds: rows, ...over });
const metScope = () => scopeOf(MET_LINES);

test("T-F 설정 3행(예방 1 · 부분 1 · 정의상 제외 1): 선언문 절 = 범위 밖 목록에 부분 1 · 정의상 칸에 제외 1(한계 줄 바로 아래) · 예방 증명 행은 «범위 밖» 에 없다 · 문면 = plain(이름 · 종류 수 리터럴 아님)", () => {
  const qualification = core.computeQualification({
    machineScope: metScope(),
    kinds: THREE_ROWS,
  });
  assert.equal(qualification.state, "partial");
  assert.equal(qualification.excluded, 1);
  const lines = core.renderDeclarationScopeLines({
    qualification,
    kinds: THREE_ROWS,
  });
  assert.ok(lines.length > 0);
  const text = lines.join("\n");
  assert.equal(text.includes("잠정"), false);
  assert.equal(text.includes("합성-이름"), false, "이름(name) 0 -- plain 만");
  const outAt = lines.findIndex((l) =>
    l.startsWith("- 기계로 못 세는 알려진 종류"),
  );
  const defAt = lines.findIndex((l) => l.startsWith("- 정의상 개입이 아닌 것"));
  const proofAt = lines.findIndex((l) => l.startsWith("- 예방 증명이 선 종류"));
  assert.ok(outAt !== -1 && defAt > outAt && proofAt > defAt, "세 칸 순서");
  assert.ok(lines[outAt].includes("알려진 종류 1개는"), lines[outAt]);
  assert.ok(lines[outAt].includes("하한"), "열린 집합 낱말");
  assert.ok(
    lines[outAt].includes("(위 1개는 하한)"),
    `하한 괄호 문면(수 뒤 조사 «은» 오류 없이 «개는») -- ${lines[outAt]}`,
  );
  const outside = lines.slice(outAt + 1, defAt);
  assert.deepEqual(
    outside.map((l) => l.trim()),
    ["· k02 합성-쉬운말-2"],
    "범위 밖 = 부분 범위 행만 · 예방 증명 행(k01)과 제외 행(k03) 없음",
  );
  const defined = lines.slice(defAt + 1, proofAt);
  assert.deepEqual(
    defined.map((l) => l.trim()),
    ["· k03 합성-쉬운말-3", "합성-한계-3"],
    "정의상 제외 행 + 그 한계 줄이 바로 다음 줄",
  );
  assert.ok(lines[proofAt].includes("k01 합성-쉬운말-1"), lines[proofAt]);
  assert.ok(
    lines.some((l) => l.includes("일한 날 7일") && l.includes("건너뛴 날 2일")),
  );
});

test("T-F 예방 증명 행이 없으면 «예방 증명이 선 종류» 칸은 «없음» · 정의상 제외 행이 없으면 그 칸도 «없음» · 상태가 부분 있음이 아니면 0줄", () => {
  const rows = [kindRow(2, "partial-scope")];
  const qualification = core.computeQualification({
    machineScope: metScope(),
    kinds: rows,
  });
  const lines = core.renderDeclarationScopeLines({
    qualification,
    kinds: rows,
  });
  assert.ok(
    lines.some(
      (l) => l.startsWith("- 예방 증명이 선 종류") && l.endsWith("없음"),
    ),
  );
  assert.ok(
    lines.some(
      (l) => l.startsWith("- 정의상 개입이 아닌 것") && l.endsWith("없음"),
    ),
  );
  const none = core.computeQualification({
    machineScope: scopeOf(UNMET_LINES),
    kinds: rows,
  });
  assert.equal(none.state, "none");
  assert.deepEqual(
    core.renderDeclarationScopeLines({ qualification: none, kinds: rows }),
    [],
  );
  assert.deepEqual(core.renderDeclarationScopeLines({}), []);
});

test("T-F 렌더 출력 어디에도 «잠정» 0 -- 자격 줄(부분 있음 · 없음) · 기계 계수 줄 · 선언문 절", () => {
  const partial = core.computeQualification({
    machineScope: metScope(),
    kinds: THREE_ROWS,
  });
  const none = core.computeQualification({
    machineScope: scopeOf(UNMET_LINES),
    kinds: THREE_ROWS,
  });
  const out = [
    core.renderQualificationLine(partial),
    core.renderQualificationLine(none),
    core.renderMachineScopeLine(metScope()),
    ...core.renderDeclarationScopeLines({
      qualification: partial,
      kinds: THREE_ROWS,
    }),
  ].join("\n");
  assert.equal(out.includes("잠정"), false);
  assert.ok(out.includes("정의상 제외 1"), "정의상 제외 낱말은 남는다");
});

test("T-F 옛 handling(excluded-by-definition-provisional) 설정 = 모르는 값 -> 종류 설정 읽기 실패 진단 줄 · 자격 줄 «없음» · 선언문 절 0줄", async () => {
  const rows = [
    kindRow(1, "partial-scope"),
    kindRow(2, "excluded-by-definition-provisional", { plainLimit: "x" }),
  ];
  const { reportText } = await runReport(
    buildRepo({ kindsConfig: kindsJson(rows) }),
    { machineScopeDailyLines: MET_LINES },
  );
  const diag = lineStarting(reportText, DIAG_PREFIX);
  assert.ok(diag.includes("종류 설정 읽기 실패"), diag);
  assert.ok(diag.includes("모르는 handling"), diag);
  assert.ok(
    lineStarting(reportText, QUAL_PREFIX).startsWith(`${QUAL_PREFIX}없음`),
  );
  assert.equal(reportText.includes("선언문 범위 시안"), false);
});

const BAD_KIND_CONFIGS = [
  ["plain 빈칸", [kindRow(1, "partial-scope", { plain: "  " })], "plain"],
  [
    "plain 칸 없음",
    [kindRow(1, "partial-scope", { plain: undefined })],
    "plain",
  ],
  [
    "plain 이 문자열이 아님",
    [kindRow(1, "partial-scope", { plain: 7 })],
    "plain",
  ],
  [
    "정의상 제외 행에 plainLimit 없음",
    [kindRow(1, "excluded-by-definition")],
    "plainLimit",
  ],
  [
    "정의상 제외 행의 plainLimit 빈칸",
    [kindRow(1, "excluded-by-definition", { plainLimit: "" })],
    "plainLimit",
  ],
];
for (const [name, rows, word] of BAD_KIND_CONFIGS) {
  test(`T-F 종류 설정 ${name} = 읽기 실패 진단 줄(${word}) · 자격 «없음» · 선언문 절 0줄`, async () => {
    const { reportText } = await runReport(
      buildRepo({ kindsConfig: kindsJson(rows) }),
      { machineScopeDailyLines: MET_LINES },
    );
    const diag = lineStarting(reportText, DIAG_PREFIX);
    assert.ok(diag && diag.includes(word), String(diag));
    assert.ok(
      lineStarting(reportText, QUAL_PREFIX).startsWith(`${QUAL_PREFIX}없음`),
    );
    assert.equal(reportText.includes("선언문 범위 시안"), false);
  });
}

test("T-F 옛 v1 종류 스키마 = 스키마 불일치(읽기 실패) -- 옛 키를 새 뜻으로 재사용하지 않는다", async () => {
  const { reportText } = await runReport(
    buildRepo({
      kindsConfig: kindsJson(THREE_ROWS, {
        schema_version: "partial-count-uncountable-kinds/v1",
      }),
    }),
    { machineScopeDailyLines: MET_LINES },
  );
  const diag = lineStarting(reportText, DIAG_PREFIX);
  assert.ok(diag.includes("스키마 불일치"), diag);
});

test("T-F 실물 종류 설정 = v2 · 15행 · 모든 행 plain(비지 않음) · k08 = 정의상 제외 확정(excluded-by-definition) + 두 줄 문면 · plainLimit 은 정의상 제외 행에만 · 옛 provisional 값 0", () => {
  const cfg = JSON.parse(REAL_KINDS);
  assert.equal(cfg.schema_version, KINDS_SCHEMA);
  assert.equal(cfg.kinds.length, 15);
  assert.deepEqual(
    cfg.kinds.map((k) => k.id),
    Array.from({ length: 15 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`),
  );
  for (const k of cfg.kinds) {
    assert.equal(typeof k.plain, "string", `${k.id} plain`);
    assert.notEqual(k.plain.trim(), "", `${k.id} plain 빈칸 아님`);
  }
  const excluded = cfg.kinds.filter(
    (k) => k.handling === "excluded-by-definition",
  );
  assert.deepEqual(
    excluded.map((k) => k.id),
    ["k08"],
  );
  assert.equal(excluded[0].plain, K8_PLAIN);
  assert.equal(excluded[0].plainLimit, K8_LIMIT);
  assert.deepEqual(
    cfg.kinds.filter((k) => "plainLimit" in k).map((k) => k.id),
    ["k08"],
    "plainLimit 은 정의상 제외 행에만",
  );
  assert.equal(REAL_KINDS.includes("provisional"), false);
  assert.equal(REAL_KINDS.includes("잠정"), false);
});

// ---- T-G 위생 --------------------------------------------------------------------------------------------------------------
const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
};

test("T-G 입력 동결(쓰기 0): 얼린 일별 줄 · 종류 행으로 계산 · 렌더가 입력을 바꾸지 않는다(엄격 모드 쓰기는 예외)", () => {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const lines = deepFreeze(clone(MET_LINES));
  const kinds = deepFreeze(clone(THREE_ROWS));
  const before = JSON.stringify([lines, kinds]);
  const scope = scopeOf(lines);
  const qualification = core.computeQualification({
    machineScope: scope,
    kinds,
  });
  core.renderMachineScopeLine(scope);
  core.renderQualificationLine(qualification);
  core.renderDeclarationScopeLines({ qualification, kinds });
  assert.equal(JSON.stringify([lines, kinds]), before);
});

const CHILD_SCRIPT = `
import { readFileSync } from "node:fs";
const core = await import(process.argv[1]);
const { lines, nowMs, cfg } = JSON.parse(readFileSync(0, "utf8"));
const scope = core.computeMachineScope({ lines, nowMs, ...cfg });
process.stdout.write(JSON.stringify({ scope, line: core.renderMachineScopeLine(scope), tz: process.env.TZ }));
`;

test("T-G TZ=UTC 자식 프로세스: 같은 합성 줄 · 같은 nowMs(인자로 고정)를 UTC 시간대 자식에게 주면 부모(현재 시간대)와 같은 값 -- 일한 날 · 건너뛴 날 · 달력 기간 · 보고 줄", () => {
  const here = scopeOf(MET_LINES);
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHILD_SCRIPT,
      new URL("./partial-count-core.mjs", import.meta.url).href,
    ],
    {
      input: JSON.stringify({ lines: MET_LINES, nowMs: NOW, cfg: CFG }),
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    },
  );
  const child = JSON.parse(out);
  assert.equal(child.tz, "UTC");
  assert.deepEqual(child.scope, JSON.parse(JSON.stringify(here)));
  assert.equal(child.line, core.renderMachineScopeLine(here));
  assert.equal(child.scope.days, 7);
  assert.equal(child.scope.skippedDays, 2);
  assert.equal(child.scope.fromDay, "2026-11-06");
  assert.equal(child.scope.toDay, "2026-11-14");
});
