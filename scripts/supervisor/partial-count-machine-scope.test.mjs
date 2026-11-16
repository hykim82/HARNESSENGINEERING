// HYK-255-p2a-scope-1 커밋 2 -- 보고서 «기계 계수 범위 기준» 한 줄: 일별 줄에서 연속 N일(날마다 동시 배달 최대 ≥ 설정 문턱 ∧ 끊김 사유 0)을 세어
// «충족 | 미충족 | UNKNOWN» 으로 싣는다. 값(관측 일수 · 동시 문턱)은 설정 파일에서만 온다.
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
const SCHEMA = "partial-count-machine-scope/v1";
const SCOPE_PREFIX = "기계 계수 범위 기준: ";
const ONE_C_LINE =
  "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가";
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

// ---- 합성 일별 줄 -----------------------------------------------------------------------------------------------------
// offset = 오늘(2026-11-15) 기준 날 수(-1 = 어제).
const dayStr = (offset) =>
  new Date(Date.UTC(2026, 10, 15 + offset)).toISOString().slice(0, 10);
const dayLine = (offset, over = {}) => ({
  schema: core.DAILY_SCHEMA,
  day: dayStr(offset),
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  coverageGaps: { count: 0, totalMs: 0 },
  concurrentTracksMax: 2,
  uncountedExampleIds: [],
  ...over,
});
// from..to(포함) 날마다 줄 1개 -- over(offset) 이 줄 칸을 덮는다. 빠진 날 = 줄 없음.
const dayLines = (from, to, over = () => ({})) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    dayLine(from + i, over(from + i)),
  );

const SYNTH = { observationDays: 7, minConcurrentTracks: 2 };
const scopeOf = (lines, cfg = SYNTH) =>
  core.computeMachineScope({ lines, nowMs: NOW, ...cfg });
const renderScope = (lines, cfg = SYNTH) =>
  core.renderMachineScopeLine(scopeOf(lines, cfg));

// 자기 줄의 토막 읽기.
const verdictOf = (line) => /^기계 계수 범위 기준: (\S+)/.exec(line)?.[1];
const streakDays = (line) => Number(/연속 (\d+)일/.exec(line)?.[1]);
const criterion = (line) =>
  /기준 (\d+)일\(동시 배달 최대 ≥ (\d+)/.exec(line)?.slice(1).map(Number);
const countedRange = (line) => /센 날 (\S+)/.exec(line)?.[1];
const lastBreak = (line) =>
  /마지막 끊김 (\d{4}-\d{2}-\d{2}) (.*?)(?: — |$)/.exec(line)?.slice(1);

// ---- 계산 + 렌더(프로덕션 순수 함수 · 합성 일별 줄) -----------------------------------------------------------------

test("7일 연속(동시 ≥ 2 · 끊김 0) = 충족 · 날짜 범위 = 실제로 센 7일(2026-11-08~2026-11-14) · 마지막 끊김 = 줄 없는 날", () => {
  const line = renderScope(dayLines(-7, -1));
  assert.equal(verdictOf(line), "충족");
  assert.equal(streakDays(line), 7);
  assert.deepEqual(criterion(line), [7, 2]);
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

test("7일 중 하루(11-11)만 동시 배달 최대 1 = 그날 끊김 -> 어제부터 3일(11-12~11-14) · 미충족 · 끊김 사유에 값과 문턱", () => {
  const lines = dayLines(-7, -1, (o) =>
    o === -4 ? { concurrentTracksMax: 1 } : {},
  );
  const line = renderScope(lines);
  assert.equal(verdictOf(line), "미충족");
  assert.equal(streakDays(line), 3);
  assert.equal(countedRange(line), "2026-11-12~2026-11-14");
  const [day, reason] = lastBreak(line);
  assert.equal(day, "2026-11-11");
  assert.match(reason, /동시 배달 최대 1 < 기준 2/);
});

test("동시 배달 최대가 null · 칸 없음 = 모름 = 통과가 아니라 그날 끊김(사유 «동시 배달 최대 모름»)", () => {
  for (const over of [
    { concurrentTracksMax: null },
    { concurrentTracksMax: undefined },
  ]) {
    const lines = dayLines(-7, -1, (o) => (o === -3 ? over : {}));
    const line = renderScope(lines);
    assert.equal(verdictOf(line), "미충족");
    assert.equal(streakDays(line), 2, "11-12 가 끊김 -> 11-14 · 11-13 두 날");
    assert.deepEqual(lastBreak(line), ["2026-11-12", "동시 배달 최대 모름"]);
  }
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

test("기준 숫자 · 문턱은 읽은 설정 값 그대로 -- 3일/동시 ≥ 1 설정이면 같은 줄(동시 1 · 3일)이 충족 · 7/2 설정이면 미충족 (코드 리터럴 0 증명)", () => {
  const lines = dayLines(-3, -1, () => ({ concurrentTracksMax: 1 }));
  const loose = renderScope(lines, {
    observationDays: 3,
    minConcurrentTracks: 1,
  });
  assert.equal(verdictOf(loose), "충족");
  assert.deepEqual(criterion(loose), [3, 1]);
  assert.equal(countedRange(loose), "2026-11-12~2026-11-14");
  const strict = renderScope(lines);
  assert.equal(verdictOf(strict), "미충족");
  assert.deepEqual(criterion(strict), [7, 2]);
  assert.equal(streakDays(strict), 0, "동시 1 < 2 -> 어제부터 끊김");
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
    observationDays: 7,
    minConcurrentTracks: 2,
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

test("보고서: 설정 7/2 + 7일 연속 줄 = 충족 한 줄 -- «연속 확인-0 일수» 줄 바로 아래 · «1-C 판정 자격: 없음» · 연속 확인-0 줄 바이트 무변", async () => {
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
  assert.deepEqual(criterion(scope), [7, 2]);
  assert.equal(countedRange(scope), "2026-11-08~2026-11-14");
  assert.equal(
    lines.filter((l) => l.startsWith(SCOPE_PREFIX)).length,
    1,
    "한 줄",
  );
});

test("보고서: 읽은 설정이 기준을 정한다 -- 설정 3/1 이면 3일 · 동시 ≥ 1 로 판정하고 줄의 기준 숫자도 그 값 (같은 줄 7/2 설정이면 미충족)", async () => {
  const lines = dayLines(-3, -1, () => ({ concurrentTracksMax: 1 }));
  const loose = await runReport(
    buildRepo(configJson({ observationDays: 3, minConcurrentTracks: 1 })),
    { machineScopeDailyLines: lines },
  );
  const looseLine = scopeLineOf(loose.reportText);
  assert.equal(verdictOf(looseLine), "충족");
  assert.deepEqual(criterion(looseLine), [3, 1]);
  assert.equal(countedRange(looseLine), "2026-11-12~2026-11-14");
  const strict = await runReport(buildRepo(configJson()), {
    machineScopeDailyLines: lines,
  });
  assert.equal(verdictOf(scopeLineOf(strict.reportText)), "미충족");
});

test("설정 없음 · 깨짐 · 스키마 불일치 · 0 · 음수 · 소수 · 문자열 = UNKNOWN(설정 읽기 실패) -- 충족도 미충족도 아니고 기본값으로 대체하지도 않는다", async () => {
  const goodLines = dayLines(-7, -1);
  const cases = [
    ["파일 없음", null],
    ["JSON 깨짐", "{not json"],
    ["스키마 불일치", configJson({ schema_version: "other/v9" })],
    ["observationDays 0", configJson({ observationDays: 0 })],
    ["observationDays 음수", configJson({ observationDays: -7 })],
    ["minConcurrentTracks 0", configJson({ minConcurrentTracks: 0 })],
    ["minConcurrentTracks 소수", configJson({ minConcurrentTracks: 1.5 })],
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
  const DIAG_PREFIX = "종류 설정 진단: ";
  const stripScope = (text) =>
    text
      .split("\n")
      .filter((l) => !l.startsWith(SCOPE_PREFIX) && !l.startsWith(DIAG_PREFIX))
      .join("\n");
  assert.equal(stripScope(withLines.reportText), base.reportText);
  assert.equal(stripScope(unreadable.reportText), base.reportText);
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

test("설정 파일 = 스키마대로 · 관측 7일 · 동시 문턱 2 -- 코드(core · report)에는 그 값을 대입한 리터럴이 없다", () => {
  const cfg = JSON.parse(
    fs.readFileSync(
      new URL("./partial-count-machine-scope.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(cfg.schema_version, SCHEMA);
  assert.equal(cfg.observationDays, 7);
  assert.equal(cfg.minConcurrentTracks, 2);
  for (const file of ["partial-count-core.mjs", "partial-count-report.mjs"]) {
    const src = fs
      .readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      .replace(/\/\/.*$/gm, "");
    assert.equal(
      /(observationDays|minConcurrentTracks)\s*[:=]\s*\d/.test(src),
      false,
      `${file} 에 관측 일수 · 동시 문턱 리터럴`,
    );
  }
});
