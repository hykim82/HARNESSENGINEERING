// HYK-255-p2d-nonecause-1 (판정 2026-11-16 18:04 상신 1 채택) -- «1-C 판정 자격: 없음» 줄이 «실제 원인 1개» 를 머리와 꼬리 사이에 적는다.
// 원인 3종 = 기계 계수 범위 기준 미충족 / 기계 계수 범위 기준 판독 불가 / 못 세는 종류 설정 읽기 실패 -- 고르는 곳은 순수 함수 한 곳(qualificationNoneCause) ·
// 렌더는 그 값만 문면으로. 머리 «1-C 판정 자격: 없음» · 꼬리 «미계수 범위가 남아 있어 «ㄴ=0» 판정 불가» · «부분 있음» 줄 · 진단 줄 문면 무변.
//
// ⛔헛시험 금지: 프로덕션 export(runPartialCountOnce · buildPartialCountReport · computeQualification · renderQualificationLine · parseQualificationLine ·
// runReachOnce)를 직접 구동한다 -- 사본 import 0. ⛔시험 단언 규율: 보고서 줄 «전체» 문자열 동등 단언 0 -- 자격 줄은 «머리 · 원인 낱말 · 꼬리» 자기 토막만 읽는다.
// mkdtemp 합성 저장소 · 합성 받는함 · 주입 시계만. 네트워크 · gh · 관제실 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import { runReachOnce } from "./reach-report.mjs";

const NOW = Date.parse("2026-11-15T15:00:00+09:00");
const SCOPE_CONFIG_PATH = "scripts/supervisor/partial-count-machine-scope.json";
const KINDS_CONFIG_PATH =
  "scripts/supervisor/partial-count-uncountable-kinds.json";
const KINDS_SCHEMA = "partial-count-uncountable-kinds/v1";
const QUAL_PREFIX = "1-C 판정 자격: ";
const DIAG_PREFIX = "종류 설정 진단: ";
const FAIL404 = { ok: false, status: 404, json: null, linkHeader: null };

// 옛 상수 문면(P2c 이전 · base 6b509dc) -- 호환 시험용 리터럴. 새 렌더는 이 줄을 더 이상 쓰지 않는다(원인 1개가 머리와 꼬리 사이에 들어간다).
const LEGACY_NONE_LINE =
  "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가";
const HEAD = "1-C 판정 자격: 없음";
const TAIL = "미계수 범위가 남아 있어 «ㄴ=0» 판정 불가";
// 원인 3종의 «토막» -- 서로 겹치지 않는 낱말이라 줄 안에서 몇 개 나오는지 센다(정확히 1개).
const CAUSE_FRAGMENTS = Object.freeze({
  unmet: "기계 계수 범위 기준 미충족",
  unreadable: "기계 계수 범위 기준 판독 불가",
  kinds: "못 세는 종류 설정 읽기 실패",
});
const causesIn = (line) =>
  Object.entries(CAUSE_FRAGMENTS)
    .filter(([, frag]) => line.includes(frag))
    .map(([name]) => name);

// 부분 있음 줄 -- base 6b509dc 렌더 출력 바이트 그대로(합성 값 7/7/2 · 15 = 0/14/1) -- 이 조각이 건드리지 않는 줄.
const PARTIAL_INPUT = {
  state: "partial",
  days: 7,
  observationDays: 7,
  minConcurrentTracks: 2,
  total: 15,
  preventionProof: 0,
  partialScope: 14,
  excluded: 1,
};
const PARTIAL_LINE_BASE =
  "1-C 판정 자격: 부분 있음 — 기계 계수 범위 기준 충족(연속 7일 / 기준 7일 · 동시 배달 최대 ≥ 2) · 알려진 못 세는 종류 15 = 예방 증명 0 / 부분 범위 14 / 정의상 제외(잠정) 1 · «ㄴ=0» 판정 아님";

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
test.after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 합성 일별 줄 · 합성 저장소 ---------------------------------------------------------------------------------------
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
  permissionHumanAnswers: 0,
  permissionUndecidable: 0,
  githubHumanActions: 0,
  ...over,
});
const dayLines = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => dayLine(from + i));
const MET_LINES = dayLines(-7, -1); // 7일 연속 · 동시 2 = 설정 7/2 에서 «충족»
const UNMET_LINES = dayLines(-6, -1); // 6일 = «미충족»

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
  JSON.stringify({
    schema_version: "partial-count-machine-scope/v1",
    observationDays: 7,
    minConcurrentTracks: 2,
    ...over,
  });

function buildRepo(kindsConfig, { scopeConfig = scopeJson() } = {}) {
  const dir = tmpDir("nc-nonecause-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  fs.writeFileSync(join(dir, SCOPE_CONFIG_PATH), scopeConfig, "utf8");
  if (kindsConfig !== null) {
    fs.writeFileSync(join(dir, KINDS_CONFIG_PATH), kindsConfig, "utf8");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "root"]);
  git(dir, ["remote", "add", "origin", "https://example.invalid/f.git"]);
  git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  return dir;
}

const kindRow = (i, handling) => ({
  id: `k${String(i).padStart(2, "0")}`,
  name: `합성 종류 ${i}`,
  handling,
  source: `synthetic:${i}`,
});
const kindsJson = (rows, over = {}) =>
  JSON.stringify({ schema_version: KINDS_SCHEMA, kinds: rows, ...over });
const GOOD_KINDS = kindsJson([
  kindRow(1, "partial-scope"),
  kindRow(2, "partial-scope"),
  kindRow(3, "excluded-by-definition-provisional"),
]);
const GOOD_KIND_ROWS = JSON.parse(GOOD_KINDS).kinds;

async function runReport(
  repoDir,
  extra = {},
  root = tmpDir("nc-nonecause-run-"),
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
const linesOf = (text) => text.split("\n");
const qualLines = (text) =>
  linesOf(text).filter((l) => l.startsWith(QUAL_PREFIX));
const qualOf = (text) => qualLines(text)[0];
const diagOf = (text) => linesOf(text).find((l) => l.startsWith(DIAG_PREFIX));

// ---- ① 원인을 고르는 순수 함수 한 곳 -------------------------------------------------------------------------------------

test("원인 고르기(순수 함수 qualificationNoneCause): 기준 모름 -> 판독 불가 · 기준 known ∧ met 아님 -> 미충족 · 기준 충족 + 종류 목록 못 씀(null · 빈 목록 · 모르는 처리 값) -> 종류 설정 · 모두 정상 -> null(부분 있음)", () => {
  const C = core.QUALIFICATION_NONE_CAUSE;
  const cause = core.qualificationNoneCause;
  const met = {
    known: true,
    met: true,
    days: 7,
    observationDays: 7,
    minConcurrentTracks: 2,
  };
  const unmet = { ...met, met: false, days: 3 };
  assert.deepEqual(
    [C.SCOPE_UNREADABLE, C.SCOPE_UNMET, C.KINDS_CONFIG].length,
    3,
  );
  assert.equal(new Set(Object.values(C)).size, 3, "원인 값 3종은 서로 다르다");
  // 기준 known 아님 = 판독 불가(종류 목록은 보지 않는다).
  assert.equal(
    cause({ machineScope: undefined, kinds: GOOD_KIND_ROWS }),
    C.SCOPE_UNREADABLE,
  );
  assert.equal(cause({ machineScope: null, kinds: null }), C.SCOPE_UNREADABLE);
  assert.equal(
    cause({
      machineScope: { known: false, reason: "x" },
      kinds: GOOD_KIND_ROWS,
    }),
    C.SCOPE_UNREADABLE,
  );
  assert.equal(cause({}), C.SCOPE_UNREADABLE, "기준을 안 넘긴 기본 경로");
  // 기준 known ∧ met 아님 = 미충족(종류 목록이 깨져 있어도 미충족 -- 기준이 먼저다).
  assert.equal(
    cause({ machineScope: unmet, kinds: GOOD_KIND_ROWS }),
    C.SCOPE_UNMET,
  );
  assert.equal(cause({ machineScope: unmet, kinds: null }), C.SCOPE_UNMET);
  assert.equal(
    cause({ machineScope: { ...met, met: undefined }, kinds: GOOD_KIND_ROWS }),
    C.SCOPE_UNMET,
  );
  // 기준 충족 + 종류 설정 못 씀.
  assert.equal(cause({ machineScope: met, kinds: null }), C.KINDS_CONFIG);
  assert.equal(cause({ machineScope: met, kinds: undefined }), C.KINDS_CONFIG);
  assert.equal(cause({ machineScope: met, kinds: [] }), C.KINDS_CONFIG);
  assert.equal(
    cause({
      machineScope: met,
      kinds: [...GOOD_KIND_ROWS, { id: "k99", handling: "invented" }],
    }),
    C.KINDS_CONFIG,
    "모르는 처리 값이 섞이면 a+b+c=K 를 못 지킨다",
  );
  // 전부 정상 = 원인 없음(null) = 부분 있음.
  assert.equal(cause({ machineScope: met, kinds: GOOD_KIND_ROWS }), null);
});

test("computeQualification: «없음» 은 원인을 값으로 돌려준다(state none + cause) · «부분 있음» 에는 원인 칸이 없다 · 같은 입력 = 같은 값", () => {
  const met = {
    known: true,
    met: true,
    days: 7,
    observationDays: 7,
    minConcurrentTracks: 2,
  };
  const unmet = { ...met, met: false, days: 3 };
  const C = core.QUALIFICATION_NONE_CAUSE;
  assert.deepEqual(
    core.computeQualification({ machineScope: unmet, kinds: GOOD_KIND_ROWS }),
    { state: "none", cause: C.SCOPE_UNMET },
  );
  assert.deepEqual(
    core.computeQualification({ machineScope: undefined, kinds: undefined }),
    { state: "none", cause: C.SCOPE_UNREADABLE },
  );
  assert.deepEqual(
    core.computeQualification({ machineScope: met, kinds: [] }),
    { state: "none", cause: C.KINDS_CONFIG },
  );
  const partial = core.computeQualification({
    machineScope: met,
    kinds: GOOD_KIND_ROWS,
  });
  assert.equal(partial.state, "partial");
  assert.equal("cause" in partial, false, "부분 있음은 원인을 갖지 않는다");
  assert.equal(partial.total, 3);
  // 계산이 돌려준 원인 = 순수 함수가 고른 원인(두 군데에서 따로 고르지 않는다).
  for (const kinds of [GOOD_KIND_ROWS, null, [], [{ handling: "x" }]]) {
    for (const machineScope of [undefined, unmet, met]) {
      const q = core.computeQualification({ machineScope, kinds });
      const cause = core.qualificationNoneCause({ machineScope, kinds });
      assert.equal(q.state === "none" ? q.cause : null, cause);
    }
  }
});

// ---- ② 렌더: 머리 · 원인 정확히 1개 · 꼬리 ------------------------------------------------------------------------------

test("renderQualificationLine(none): 원인 3종 각각 «머리 — 원인 1개 — 꼬리» · 원인 낱말은 줄에 정확히 1개 · 옛 상수 줄과 다르다 · «ㄴ=0» 긍정 문면 0", () => {
  const C = core.QUALIFICATION_NONE_CAUSE;
  const expected = {
    [C.SCOPE_UNMET]: "unmet",
    [C.SCOPE_UNREADABLE]: "unreadable",
    [C.KINDS_CONFIG]: "kinds",
  };
  for (const [cause, name] of Object.entries(expected)) {
    const line = core.renderQualificationLine({ state: "none", cause });
    assert.ok(line.startsWith(`${HEAD} — `), `${name}: 머리`);
    assert.ok(
      line.endsWith(` — ${TAIL}`),
      `${name}: 꼬리(«ㄴ=0» 판정 불가 뜻 유지)`,
    );
    assert.deepEqual(causesIn(line), [name], `${name}: 원인 정확히 1개`);
    assert.notEqual(line, LEGACY_NONE_LINE, `${name}: 옛 상수 줄이 아니다`);
    assert.equal(line.includes("\n"), false, `${name}: 한 줄`);
    assert.equal(line.includes("부분 있음"), false, `${name}: 긍정 문면 0`);
    for (const banned of ["자격 있음", "완료", "달성", "통과", "합격"]) {
      assert.equal(line.includes(banned), false, `${name}: ${banned}`);
    }
  }
  // 세 줄은 서로 다르다.
  const lines = Object.keys(expected).map((cause) =>
    core.renderQualificationLine({ state: "none", cause }),
  );
  assert.equal(new Set(lines).size, 3);
});

test("renderQualificationLine: 원인 없는 none · 모르는 원인 · 상태 없음 = 그래도 원인 정확히 1개(판독 불가) -- 원인 없는 «없음» 렌더 0", () => {
  for (const q of [
    { state: "none" },
    { state: "none", cause: "invented" },
    { state: "none", cause: undefined },
    undefined,
    null,
    {},
  ]) {
    const line = core.renderQualificationLine(q);
    assert.ok(line.startsWith(`${HEAD} — `), JSON.stringify(q));
    assert.ok(line.endsWith(` — ${TAIL}`), JSON.stringify(q));
    assert.deepEqual(causesIn(line), ["unreadable"], JSON.stringify(q));
  }
});

test("부분 있음 줄 바이트 무변: 합성 값으로 렌더한 줄이 base(6b509dc) 출력과 같고 원인 낱말 0 · 줄 수 1", () => {
  const line = core.renderQualificationLine(PARTIAL_INPUT);
  assert.equal(line, PARTIAL_LINE_BASE);
  assert.deepEqual(causesIn(line), []);
});

// ---- ③ 보고서 머리: 결선 없는 기본 경로 = 판독 불가 --------------------------------------------------------------------

function baseInput(overrides = {}) {
  const T0 = Date.parse("2026-08-14T00:00:00.000Z");
  const HOUR = 60 * 60 * 1000;
  return {
    generatedAtMs: T0 + 24 * HOUR,
    windowStartMs: T0,
    windowEndMs: T0 + 24 * HOUR,
    delivered: { known: true, count: 5 },
    consumed: { known: true, count: 3 },
    missingReceipts: { known: true, count: 2 },
    gate4: {
      known: true,
      candidatesInWindow: 1,
      checked: 1,
      approved: 1,
      notApproved: 0,
      undecidable: 0,
      uncheckedByBudget: 0,
      approvedEvents: [
        { sha: "a".repeat(40), pullNumber: 152, reviewerLogin: "hykim82" },
      ],
    },
    confirmedLnEvents: [],
    suspected: { known: true, closedCount: 3, openCount: 0 },
    collectors: [{ name: "배달영수증", ok: true }],
    lastAliveMs: T0 + 23 * HOUR,
    coverageGaps: { known: true, count: 1, totalMs: 2 * HOUR },
    ...overrides,
  };
}

test("buildPartialCountReport: 자격 줄 인자가 없으면(미결선 호출자) 첫 자격 줄 = «없음 — 기계 계수 범위 기준 판독 불가 — 꼬리» · 자격 줄 1개 · 머리·꼬리 유지", () => {
  const text = core.buildPartialCountReport(baseInput());
  const qual = qualLines(text);
  assert.equal(qual.length, 1, "자격 줄 1개");
  assert.ok(qual[0].startsWith(`${HEAD} — `));
  assert.ok(qual[0].endsWith(` — ${TAIL}`));
  assert.deepEqual(causesIn(qual[0]), ["unreadable"]);
  assert.equal(
    text.includes(LEGACY_NONE_LINE),
    false,
    "옛 상수 줄은 더 이상 렌더되지 않는다",
  );
  // 값으로 넘기면 그 줄이 그대로 첫 자격 줄이다(렌더 위치 무변: 3번째 줄).
  const given = core.renderQualificationLine({
    state: "none",
    cause: core.QUALIFICATION_NONE_CAUSE.SCOPE_UNMET,
  });
  const wired = core.buildPartialCountReport(
    baseInput({ qualificationLine: given }),
  );
  assert.equal(linesOf(wired)[3], given);
  assert.deepEqual(causesIn(qualOf(wired)), ["unmet"]);
});

// ---- ④ 프로덕션 보고 진입점: «없음» 경로마다 원인 1개 -----------------------------------------------------------------

test("프로덕션 보고 진입점(runPartialCountOnce): 기준 미충족(6일) = 원인 «미충족» · 종류 설정을 읽지 않으므로 진단 줄 0", async () => {
  const { reportText } = await runReport(buildRepo(GOOD_KINDS), {
    machineScopeDailyLines: UNMET_LINES,
  });
  assert.equal(qualLines(reportText).length, 1);
  assert.deepEqual(causesIn(qualOf(reportText)), ["unmet"]);
  assert.ok(qualOf(reportText).startsWith(`${HEAD} — `));
  assert.ok(qualOf(reportText).endsWith(` — ${TAIL}`));
  assert.equal(diagOf(reportText), undefined);
});

test("프로덕션 보고 진입점: 기준 판독 불가 3갈래(일별 줄 미결선 undefined · 못 읽음 null · 기계 계수 설정 깨짐) = 원인 «판독 불가» 1개", async () => {
  const cases = [
    ["미결선", buildRepo(GOOD_KINDS), undefined],
    ["못 읽음", buildRepo(GOOD_KINDS), null],
    [
      "설정 깨짐",
      buildRepo(GOOD_KINDS, { scopeConfig: "{not json" }),
      MET_LINES,
    ],
  ];
  for (const [name, repo, lines] of cases) {
    const { reportText } = await runReport(repo, {
      machineScopeDailyLines: lines,
    });
    assert.equal(qualLines(reportText).length, 1, name);
    assert.deepEqual(causesIn(qualOf(reportText)), ["unreadable"], name);
    assert.ok(qualOf(reportText).endsWith(` — ${TAIL}`), name);
    assert.equal(diagOf(reportText), undefined, `${name}: 종류 진단 줄 0`);
  }
});

test("프로덕션 보고 진입점: 기준 충족 + 종류 설정 읽기 실패(없음 · 깨짐 · 스키마 불일치 · 빈 목록 · 모르는 handling) = 원인 «종류 설정 읽기 실패» 1개 + 진단 줄 1개(문면 무변 · unreadable 되읽기)", async () => {
  const cases = [
    ["파일 없음", null],
    ["JSON 깨짐", "{not json"],
    ["스키마 불일치", kindsJson(GOOD_KIND_ROWS, { schema_version: "x/v9" })],
    ["빈 목록", kindsJson([])],
    ["모르는 handling", kindsJson([kindRow(1, "invented-kind")])],
  ];
  for (const [name, config] of cases) {
    const { reportText } = await runReport(buildRepo(config), {
      machineScopeDailyLines: MET_LINES,
    });
    assert.equal(qualLines(reportText).length, 1, name);
    assert.deepEqual(causesIn(qualOf(reportText)), ["kinds"], name);
    assert.ok(qualOf(reportText).startsWith(`${HEAD} — `), name);
    assert.ok(qualOf(reportText).endsWith(` — ${TAIL}`), name);
    const diag = diagOf(reportText);
    assert.notEqual(diag, undefined, `${name}: 진단 줄`);
    assert.equal(
      linesOf(reportText).filter((l) => l.startsWith(DIAG_PREFIX)).length,
      1,
      `${name}: 진단 줄 1개`,
    );
    // 진단 줄 문면 무변 -- 접두 · 읽기 실패 낱말 · «없음 그대로» 꼬리.
    assert.ok(
      diag.startsWith(`${core.QUALIFICATION_DIAG_PREFIX}종류 설정 읽기 실패(`),
      name,
    );
    assert.ok(
      diag.endsWith(") — «1-C 판정 자격» 은 «없음» 그대로") ||
        diag.endsWith(" — «1-C 판정 자격» 은 «없음» 그대로"),
      name,
    );
    assert.equal(
      core.parseQualificationLine(reportText).state,
      "unreadable",
      name,
    );
  }
});

test("프로덕션 보고 진입점: 기준 충족 + 종류 설정 정상 = 부분 있음 줄(원인 낱말 0) · 자격 줄 1개 · 진단 줄 0 -- 부분 있음 줄 바이트 = 렌더 함수 출력", async () => {
  const { reportText } = await runReport(buildRepo(GOOD_KINDS), {
    machineScopeDailyLines: MET_LINES,
  });
  assert.equal(qualLines(reportText).length, 1);
  assert.equal(
    qualOf(reportText),
    core.renderQualificationLine({
      state: "partial",
      days: 7,
      observationDays: 7,
      minConcurrentTracks: 2,
      total: 3,
      preventionProof: 0,
      partialScope: 2,
      excluded: 1,
    }),
  );
  assert.deepEqual(causesIn(qualOf(reportText)), []);
  assert.ok(qualOf(reportText).startsWith(`${QUAL_PREFIX}부분 있음 — `));
  assert.equal(diagOf(reportText), undefined);
});

test("모든 «없음» 렌더는 정확히 원인 1개 -- 보고 진입점 8경로(미충족 1 · 판독 불가 3 · 종류 설정 4) 전부", async () => {
  const runs = [
    [buildRepo(GOOD_KINDS), UNMET_LINES],
    [buildRepo(GOOD_KINDS), undefined],
    [buildRepo(GOOD_KINDS), null],
    [buildRepo(GOOD_KINDS, { scopeConfig: "{not json" }), MET_LINES],
    [buildRepo(null), MET_LINES],
    [buildRepo("{not json"), MET_LINES],
    [buildRepo(kindsJson([])), MET_LINES],
    [buildRepo(kindsJson([kindRow(1, "invented-kind")])), MET_LINES],
  ];
  const seen = [];
  for (const [repo, lines] of runs) {
    const { reportText } = await runReport(repo, {
      machineScopeDailyLines: lines,
    });
    const q = qualOf(reportText);
    assert.equal(qualLines(reportText).length, 1);
    assert.equal(causesIn(q).length, 1, q);
    seen.push(causesIn(q)[0]);
  }
  assert.deepEqual(seen, [
    "unmet",
    "unreadable",
    "unreadable",
    "unreadable",
    "kinds",
    "kinds",
    "kinds",
    "kinds",
  ]);
});

test("보고서의 나머지 줄 바이트 무변: 자격 줄 · 진단 줄만 빼면 보고서가 (기준 미충족 · 판독 불가 · 종류 설정 실패) 서로 같고, 연속 줄 · 기준 줄은 각 갈래에 그대로 있다", async () => {
  const root = tmpDir("nc-nonecause-run-");
  const unmet = await runReport(
    buildRepo(GOOD_KINDS),
    { machineScopeDailyLines: UNMET_LINES },
    root,
  );
  const kinds = await runReport(
    buildRepo(null),
    { machineScopeDailyLines: UNMET_LINES },
    root,
  );
  // 같은 일별 줄 = 같은 갈래 -> 종류 설정 파일 유무가 보고서를 바꾸지 않는다(기준 미충족이면 종류 설정을 읽지 않는다).
  assert.equal(unmet.reportText, kinds.reportText);
  const strip = (text) =>
    linesOf(text)
      .filter((l) => !l.startsWith(QUAL_PREFIX) && !l.startsWith(DIAG_PREFIX))
      .join("\n");
  const unreadable = await runReport(
    buildRepo(GOOD_KINDS),
    { machineScopeDailyLines: undefined },
    root,
  );
  const kindsFail = await runReport(
    buildRepo(null),
    { machineScopeDailyLines: MET_LINES },
    root,
  );
  // 줄 수 = 자격 줄 1개 + (연속 줄 · 기준 줄 · 진단 줄 유무)만 다르다 -- 자격 줄 개수는 항상 1.
  for (const r of [unmet, unreadable, kindsFail]) {
    assert.equal(qualLines(r.reportText).length, 1);
    assert.equal(
      linesOf(r.reportText)[3].startsWith(QUAL_PREFIX),
      true,
      "자격 줄 자리(첫 줄 묶음) 무변",
    );
  }
  assert.equal(
    linesOf(kindsFail.reportText).length -
      linesOf(strip(kindsFail.reportText)).length,
    2,
    "종류 설정 실패 = 자격 줄 + 진단 줄만 strip 에서 빠진다",
  );
  assert.equal(
    linesOf(unmet.reportText).length - linesOf(strip(unmet.reportText)).length,
    1,
  );
});

// ---- ⑤ 되읽기 --------------------------------------------------------------------------------------------------------

test("parseQualificationLine: 옛 상수 문면 = 없음 · 새 문면 3종 = 없음 · 부분 있음 = partial(줄 그대로) · 줄 없음 = absent · 진단 줄 = unreadable", () => {
  const C = core.QUALIFICATION_NONE_CAUSE;
  assert.deepEqual(
    core.parseQualificationLine(`${LEGACY_NONE_LINE}\n연속 확인-0 일수: 0일`),
    { state: "none" },
  );
  assert.deepEqual(
    core.parseQualificationLine(core.ONE_C_QUALIFICATION_NONE_LINE),
    { state: "none" },
    "옛 상수 export 도 없음",
  );
  for (const cause of Object.values(C)) {
    const line = core.renderQualificationLine({ state: "none", cause });
    assert.deepEqual(
      core.parseQualificationLine(
        `집계 성격: PARTIAL — 전수 아님\n${line}\n다음 줄`,
      ),
      { state: "none" },
      cause,
    );
  }
  assert.deepEqual(core.parseQualificationLine(`${PARTIAL_LINE_BASE}\n다음`), {
    state: "partial",
    line: PARTIAL_LINE_BASE,
  });
  assert.deepEqual(
    core.parseQualificationLine("집계 성격: PARTIAL — 전수 아님\n"),
    { state: "absent" },
  );
  assert.deepEqual(core.parseQualificationLine(undefined), { state: "absent" });
  const withDiag = `${core.renderQualificationLine({ state: "none", cause: C.KINDS_CONFIG })}\n${core.QUALIFICATION_DIAG_PREFIX}종류 설정 읽기 실패(x) — «1-C 판정 자격» 은 «없음» 그대로`;
  assert.deepEqual(core.parseQualificationLine(withDiag), {
    state: "unreadable",
  });
  // 옛 문면 + 진단 줄(옛 보고서의 종류 설정 실패 회차)도 unreadable 그대로.
  assert.deepEqual(
    core.parseQualificationLine(
      `${LEGACY_NONE_LINE}\n${core.QUALIFICATION_DIAG_PREFIX}x`,
    ),
    { state: "unreadable" },
  );
});

// ---- ⑥ 통지(프로덕션 runReachOnce · 합성 받는함 · 합성 상태 파일) -----------------------------------------------------

async function stateReports() {
  const make = async (repo, lines) =>
    (await runReport(repo, { machineScopeDailyLines: lines })).reportText;
  return {
    partial: await make(buildRepo(GOOD_KINDS), MET_LINES),
    unmet: await make(buildRepo(GOOD_KINDS), UNMET_LINES),
    unreadable: await make(buildRepo(GOOD_KINDS), undefined),
    kinds: await make(buildRepo(null), MET_LINES),
  };
}

function makeReach() {
  const root = tmpDir("nc-nonecause-reach-");
  const watchLogPath = join(root, "watch.log");
  const partialCountPath = join(root, "partial-count-report.md");
  const statePath = join(root, "state.json");
  const fx = {
    root,
    statePath,
    notifyDir: join(root, "받는함"),
    tick(reportText, offsetMs = 0) {
      fs.writeFileSync(partialCountPath, reportText, "utf8");
      return runReachOnce({
        watchLogPath,
        partialCountPath,
        reportOutPath: join(root, "morning-report.md"),
        statePath,
        notifyDir: fx.notifyDir,
        now: NOW + offsetMs,
      });
    },
    files() {
      return fs.existsSync(fx.notifyDir) ? fs.readdirSync(fx.notifyDir) : [];
    },
  };
  return fx;
}

test("통지: «없음(원인 A) -> 없음(원인 B)» = 0장 -- 미충족 · 판독 불가 · 종류 설정 · 옛 상수 문면 사이를 오가도 0장 · 상태 파일에는 원인이 새지 않는다", async () => {
  const r = await stateReports();
  const fx = makeReach();
  const legacy = `집계 성격: PARTIAL — 전수 아님\n${LEGACY_NONE_LINE}\n`;
  const sequence = [
    r.unmet,
    r.unreadable,
    r.unmet,
    legacy,
    r.unreadable,
    legacy,
  ];
  for (const [i, text] of sequence.entries()) {
    assert.equal(fx.tick(text, i * 1000).noticePath, null, `회차 ${i}`);
  }
  assert.equal(fx.files().length, 0, "받는함 0장");
  const state = JSON.parse(fs.readFileSync(fx.statePath, "utf8"));
  assert.deepEqual(state.__partialQualification, { state: "none" });
  // 종류 설정 실패 회차(진단 줄)는 변화가 아니다 -- 0장 · 직전 없음 기억 유지.
  assert.equal(fx.tick(r.kinds, 10000).noticePath, null);
  assert.equal(fx.files().length, 0);
});

test("통지: «없음(어느 원인이든) -> 부분 있음» = 1장 무변(줄의 값 · 전이 문면 포함) · 같은 상태 0장 · 옛 상수 문면에서 와도 1장", async () => {
  const r = await stateReports();
  for (const none of [r.unmet, r.unreadable, `${LEGACY_NONE_LINE}\n`]) {
    const fx = makeReach();
    assert.equal(fx.tick(none).noticePath, null, "없음 기준선 = 0장");
    const first = fx.tick(r.partial, 1000);
    assert.ok(first.noticePath, "처음 부분 있음 = 1장");
    const body = fs.readFileSync(first.noticePath, "utf8");
    assert.match(body, /없음 -> 부분 있음/);
    assert.match(
      body,
      /알려진 못 세는 종류 3 = 예방 증명 0 \/ 부분 범위 2 \/ 정의상 제외\(잠정\) 1/,
    );
    assert.match(body, /«ㄴ=0» 판정이 아닙니다/);
    assert.equal(fx.tick(r.partial, 2000).noticePath, null, "같은 상태 0장");
    assert.equal(fx.files().length, 1);
  }
});
