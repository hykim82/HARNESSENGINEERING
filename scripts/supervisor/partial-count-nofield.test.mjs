// HYK-255-p2c-nofield-1 (판정 2026-11-16 1404 ②) -- 일별 줄은 있는데 권한 칸 또는 GitHub 칸이 «아예 없는» 날 = 끊김(사유 «… 칸 없음»).
// 모르는 날을 센 날로 넘기지 않는다. 칸이 «있고» 값이 0 = 끊김 아님 · 칸이 있고 값 모름(null · 모양 오류) = `… UNKNOWN` 바이트 무변 · 감사 칸 = 끊김에 쓰지 않는다.
//
// ⛔헛시험 금지: 프로덕션 export(parseDailyLines · computeConfirmedZeroStreak · renderConfirmedZeroStreakLine · computeMachineScope ·
// renderMachineScopeLine · computeQualification · renderQualificationLine)를 직접 구동한다 -- 사본 import 0. 합성 줄만 · 주입 시계만 ·
// 실제 watch 폴더 · 관제실 · 네트워크 · gh · 토큰 0. ⛔시험 단언 규율: 줄 «전체» 문자열 동등 단언 0 -- 사유 배열의 자기 원소 · 줄의 자기 토막만.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "./partial-count-core.mjs";

const NOW = Date.parse("2026-11-15T15:00:00+09:00");
const CFG = { observationDays: 7, minConcurrentTracks: 2 };

const NO_PERM_HUMAN = "권한 확인창 사람 답 칸 없음";
const NO_PERM_UNDECIDABLE = "권한 판정 불가 칸 없음";
const NO_GITHUB = "GitHub 사람 손 조작 칸 없음";

const cleanups = [];
test.after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

// offset = 오늘(2026-11-15) 기준 날 수(-1 = 어제). 기본 줄 = 칸 다 있음(0 · 감사 칸 포함).
const dayStr = (offset) =>
  new Date(Date.UTC(2026, 10, 15 + offset)).toISOString().slice(0, 10);
const fullLine = (offset, over = {}) => ({
  schema: core.DAILY_SCHEMA,
  day: dayStr(offset),
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  coverageGaps: { count: 0, totalMs: 0 },
  concurrentTracksMax: 2,
  uncountedExampleIds: [],
  permissionHumanAnswers: 0,
  permissionUndecidable: 0,
  permissionErrorEnded: 0,
  githubHumanActions: 0,
  ...over,
});
// 칸을 «빼서» 칸 없는 줄을 만든다(값 undefined 로 두지 않는다 -- JSON 줄에는 칸 자체가 없다).
const without = (line, ...keys) => {
  const copy = { ...line };
  for (const k of keys) delete copy[k];
  return copy;
};
const lines7 = (from = -7, to = -1, mutate = (_o, l) => l) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    mutate(from + i, fullLine(from + i)),
  );

const streakOf = (lines) =>
  core.computeConfirmedZeroStreak({ lines, nowMs: NOW });
const scopeOf = (lines) =>
  core.computeMachineScope({ lines, nowMs: NOW, ...CFG });
const KINDS = [
  { id: "x1", name: "합성 종류 1", handling: "partial-scope" },
  {
    id: "x2",
    name: "합성 종류 2",
    handling: "excluded-by-definition-provisional",
  },
];

// ---- 양성: 칸 없음 = 끊김 ------------------------------------------------------------------------------------------

test("① 권한 칸 둘 다 없음 = 끊김 -- 칸마다 사유 1개(권한 확인창 사람 답 · 권한 판정 불가 각각 «칸 없음») · 순서 = 칸 순서", () => {
  const line = without(
    fullLine(-1),
    "permissionHumanAnswers",
    "permissionUndecidable",
  );
  const streak = streakOf([line]);
  assert.equal(streak.days, 0, "센 날 0");
  assert.equal(streak.lastBreak.day, "2026-11-14");
  assert.deepEqual(streak.lastBreak.reasons, [
    NO_PERM_HUMAN,
    NO_PERM_UNDECIDABLE,
  ]);
});

test("② 권한 칸 «한 칸만» 없음 = 끊김 -- 없는 칸 하나에만 사유 1개(다른 칸은 값 0 이라 사유 0)", () => {
  const noUndecidable = streakOf([
    without(fullLine(-1), "permissionUndecidable"),
  ]);
  assert.deepEqual(noUndecidable.lastBreak.reasons, [NO_PERM_UNDECIDABLE]);
  const noHuman = streakOf([without(fullLine(-1), "permissionHumanAnswers")]);
  assert.deepEqual(noHuman.lastBreak.reasons, [NO_PERM_HUMAN]);
});

test("③ GitHub 칸 없음(11-14 꼴: 권한 두 칸 있음 · githubHumanActions 없음) = 끊김 · 마지막 끊김 사유에 «… 칸 없음»", () => {
  const eleven14 = without(fullLine(-1), "githubHumanActions");
  const streak = streakOf([eleven14]);
  assert.equal(streak.days, 0);
  assert.deepEqual(streak.lastBreak.reasons, [NO_GITHUB]);
  const rendered = core.renderConfirmedZeroStreakLine(streak);
  assert.ok(rendered.startsWith("연속 확인-0 일수: 0일("), rendered);
  assert.ok(rendered.includes(`2026-11-14 ${NO_GITHUB}`), rendered);
});

test("④ 권한 두 칸 + GitHub 칸 «다» 없음 = 사유 3개(사유 2종 이상 · 권한 먼저 GitHub 나중)", () => {
  const bare = without(
    fullLine(-1),
    "permissionHumanAnswers",
    "permissionUndecidable",
    "githubHumanActions",
  );
  const streak = streakOf([bare]);
  assert.deepEqual(streak.lastBreak.reasons, [
    NO_PERM_HUMAN,
    NO_PERM_UNDECIDABLE,
    NO_GITHUB,
  ]);
});

test("⑤ 칸 없는 줄이 «중간» 날이면 그 날에서 끊긴다 -- 어제 · 그제는 센 날(2일) · 끊김 날 = 11-12 · 사유 = 칸 없음", () => {
  const lines = lines7(-5, -1, (o, l) =>
    o === -3 ? without(l, "githubHumanActions") : l,
  );
  const streak = streakOf(lines);
  assert.equal(streak.days, 2);
  assert.equal(streak.lastBreak.day, "2026-11-12");
  assert.deepEqual(streak.lastBreak.reasons, [NO_GITHUB]);
});

// ---- 음성 ------------------------------------------------------------------------------------------------------------

test("⑥ 음성: 칸이 «있고» 값이 0 = 끊김 아님 -- 7일 모두 칸 다 있음(0)이면 연속 7 · 센 날 모두 포함", () => {
  const streak = streakOf(lines7());
  assert.equal(streak.days, 7);
  assert.equal(streak.lastBreak.day, "2026-11-07");
  assert.deepEqual(streak.lastBreak.reasons, ["줄 없음"]);
  for (const reason of streak.lastBreak.reasons) {
    assert.equal(reason.includes("칸 없음"), false);
  }
});

test("⑦ 칸이 있고 값을 «모름»(null · 모양 오류) = 지금 문면 `… UNKNOWN` 바이트 무변 -- «칸 없음» 과 합치지 않는다", () => {
  const unknown = streakOf([
    fullLine(-1, {
      permissionHumanAnswers: null,
      permissionUndecidable: "3",
      githubHumanActions: null,
    }),
  ]);
  assert.deepEqual(unknown.lastBreak.reasons, [
    "권한 확인창 사람 답 UNKNOWN",
    "권한 판정 불가 UNKNOWN",
    "GitHub 사람 손 조작 UNKNOWN",
  ]);
  const withGap = streakOf([
    fullLine(-1, {
      githubHumanActions: null,
      githubHumanActionsGap: "목록 대화 댓글 덮지 못함",
    }),
  ]);
  assert.deepEqual(withGap.lastBreak.reasons, [
    "GitHub 사람 손 조작 UNKNOWN(목록 대화 댓글 덮지 못함)",
  ]);
  // 값 > 0 문면도 무변.
  const positive = streakOf([
    fullLine(-1, { permissionHumanAnswers: 2, githubHumanActions: 3 }),
  ]);
  assert.deepEqual(positive.lastBreak.reasons, [
    "권한 확인창 사람 답 2",
    "GitHub 사람 손 조작 3",
  ]);
});

test("⑧ 음성: 감사 칸(permissionErrorEnded)이 없는 줄 = 끊김 아님 -- 감사 칸은 끊김 사유에 «쓰지 않는다»(칸 없음 · null · 값 > 0 모두)", () => {
  const noAudit = streakOf(
    lines7(-3, -1, (_o, l) => without(l, "permissionErrorEnded")),
  );
  assert.equal(noAudit.days, 3, "감사 칸 없는 3일 = 센 날 3");
  assert.deepEqual(noAudit.lastBreak.reasons, ["줄 없음"]);
  for (const audit of [null, 5, "x"]) {
    const streak = streakOf(
      lines7(-3, -1, (_o, l) => ({ ...l, permissionErrorEnded: audit })),
    );
    assert.equal(
      streak.days,
      3,
      `감사 칸 ${JSON.stringify(audit)} = 끊김 아님`,
    );
  }
});

// ---- 프로덕션 진입점: 일별 파일 -> 줄 해석 -> 연속 · 기계 계수 범위 · 자격 -------------------------------------------

test("⑨ 일별 파일(mkdtemp 합성 · 11-14 꼴 + 11-15 꼴) -> parseDailyLines -> 연속 확인-0 일수 · 기계 계수 범위 기준 · 자격 «둘 이상의 진입점» 이 같은 날에서 끊긴다", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-nofield-"));
  cleanups.push(dir);
  const file = join(dir, "partial-count-daily.jsonl");
  // 어제까지 7일: 11-14 줄만 GitHub 칸 없음(실물 11-14 의 칸 이름 꼴) · 11-08~11-13 은 칸 다 있음(11-15 꼴).
  const rows = lines7(-7, -1, (o, l) =>
    o === -1 ? without(l, "githubHumanActions") : l,
  );
  fs.writeFileSync(
    file,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  const { lines, malformed } = core.parseDailyLines(
    fs.readFileSync(file, "utf8"),
  );
  assert.equal(malformed, 0);
  assert.equal(lines.length, 7);

  const streak = streakOf(lines);
  assert.equal(streak.days, 0, "어제(11-14)가 칸 없음 = 끊김 -> 연속 0");
  const streakLine = core.renderConfirmedZeroStreakLine(streak);
  assert.ok(streakLine.includes(`2026-11-14 ${NO_GITHUB}`), streakLine);

  const scope = scopeOf(lines);
  assert.equal(scope.met, false);
  assert.equal(scope.days, 0, "기계 계수 범위도 같은 날에서 끊김");
  assert.equal(scope.lastBreak.day, "2026-11-14");
  assert.deepEqual(scope.lastBreak.reasons, [NO_GITHUB]);
  const scopeLine = core.renderMachineScopeLine(scope);
  assert.ok(
    scopeLine.startsWith("기계 계수 범위 기준: 미충족 — 연속 0일"),
    scopeLine,
  );
  assert.ok(
    scopeLine.includes(`마지막 끊김 2026-11-14 ${NO_GITHUB}`),
    scopeLine,
  );

  // 같은 줄이 칸 다 있으면(대조) 충족 -> 자격 «부분 있음». 칸 없는 판은 «없음».
  const full = scopeOf(lines7());
  assert.equal(full.met, true);
  assert.equal(
    core.computeQualification({ machineScope: full, kinds: KINDS }).state,
    "partial",
  );
  const q = core.computeQualification({ machineScope: scope, kinds: KINDS });
  assert.equal(q.state, "none");
  // HYK-255-p2d-nonecause-1 바뀐 단언(판정 2026-11-16 1804 상신 1): 옛 «자격 줄 = 상수 줄 바이트 그대로» -> 같은 «없음» 줄에 원인 «기계 계수 범위 기준 미충족» 1개.
  // 칸 없는 날이 센 날이 아니라 끊김 = 기준 미충족이라는 뜻(P2c)은 무변 -- 머리 · 꼬리는 옛 상수 줄과 같다.
  assert.equal(q.cause, core.QUALIFICATION_NONE_CAUSE.SCOPE_UNMET);
  const noneLine = core.renderQualificationLine(q);
  assert.ok(
    noneLine.startsWith("1-C 판정 자격: 없음 — 기계 계수 범위 기준 미충족 — "),
  );
  assert.ok(noneLine.endsWith(" — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가"));
  assert.notEqual(
    noneLine,
    core.ONE_C_QUALIFICATION_NONE_LINE,
    "옛 상수 줄이 아니다",
  );
});

test("⑩ 기계 계수 범위: 7일 중 하루(11-11)가 권한 칸 없음이면 그날에서 끊겨 어제부터 3일(11-12~11-14) · 미충족 · 자격 없음", () => {
  const lines = lines7(-7, -1, (o, l) =>
    o === -4
      ? without(l, "permissionHumanAnswers", "permissionUndecidable")
      : l,
  );
  const scope = scopeOf(lines);
  assert.equal(scope.days, 3);
  assert.equal(scope.met, false);
  assert.equal(scope.fromDay, "2026-11-12");
  assert.equal(scope.lastBreak.day, "2026-11-11");
  assert.deepEqual(scope.lastBreak.reasons, [
    NO_PERM_HUMAN,
    NO_PERM_UNDECIDABLE,
  ]);
  assert.equal(
    core.computeQualification({ machineScope: scope, kinds: KINDS }).state,
    "none",
  );
});
