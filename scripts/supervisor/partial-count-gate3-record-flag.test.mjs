// HYK-255-g3-record-flag-1 (판정 #20261124-0728 · 판정 #20261123-2305 의 복제) -- ㄱ-3 GitHub 기록 수집(B1 · S4)을 감시 폴더 표지 파일 gate3-record.json 으로 켠다.
//
//   표지 = 감시 폴더 안 gate3-record.json. 켜짐 = 내용이 JSON 객체 ∧ enabled 가 정확히 불리언 true -- 그 밖 전부 꺼짐 + 경우마다 다른 사유 토큰(GATE3_RECORD_FLAG_*).
//   기록 가지 이름 = 코드 상수 GATE3_RECORD_BASE 그대로(표지의 다른 키는 무시) · 수동 인자 --gate3-record-base 가 있으면 그것이 앞선다 · 두 표지(linear-binding.json 과)는 서로 독립.
//   감시 회차 보고서는 «ㄱ-3 GitHub 기록 수집 켜짐/꺼짐(사유 토큰)» 한 줄을 매 회차 싣고, 보고 CLI 를 인자 없이 직접 부르면 새 줄 0개. 기록 수는 커버리지 · 독립 확인 수 어디에도 더하지 않고 아무것도 막지 않는다.
//
// ⛔헛시험 금지: 프로덕션 진입점(runWatchCliPartialCountStep · runPartialCountOnce · judgeGate3RecordFlag · buildPartialCountStepOptions)을 직접 구동한다.
//   저장소 = mkdtemp 합성 git · GitHub = 주입 가짜 fetchJson · Linear = 주입 가짜 linearFetch · 감시 폴더 = mkdtemp · 세션 홈 = mkdtemp.
//   실제 네트워크 · 실제 감시 폴더 · 실제 gate3-record.json · 실제 .harness · 홈 폴더 세션 기록 접촉 0. 기대값은 전부 이 파일 안에서 손으로 정한 값이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import * as watch from "./watch-run.mjs";

const HOUR = 60 * 60 * 1000;
// 2026-11-24 12:00 KST. 창 = 24시간.
const NOW = Date.parse("2026-11-24T03:00:00.000Z");
const REPO = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";
const BOTS_PATH = "scripts/supervisor/github-bot-accounts.json";
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});
const BOT_A = "bot-fixture-a";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: BOT_A }],
});
const HANYONG = { login: "hykim82", id: 286230306 };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
const FAKE_KEY = "lin_api_FAKEKEY0123456789abcdefghijklmnop";
const HEAD = "[게이트3 승인 기록]";
const RECORD_BASE = "gate3-record";
const NUM = "20261124-0728";
const STATUS = "- ㄱ-3 GitHub 기록 수집";
const RECORD_LINE = "- ㄱ-3 GitHub 기록(";
const LINEAR_STATUS = "- ㄱ-4 Linear Done 결속 확인 ";
const IN_WINDOW_MERGED = NOW - 2 * HOUR;

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
test.after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd, args, env = {}) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      ...env,
    },
  }).trim();
}

// 합성 저장소: 루트 커밋 1개(명단 · 봇 목록 blob) = origin/master. 병합 0건(ㄱ-4 후보 없음).
function buildRepo() {
  const dir = tmpDir("nc-g3flag-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, "README.md"), "synthetic\n", "utf8");
  fs.writeFileSync(join(dir, ALLOWLIST_PATH), ALLOWLIST_JSON, "utf8");
  fs.writeFileSync(join(dir, BOTS_PATH), BOTS_JSON, "utf8");
  git(dir, ["add", "-A"]);
  const tree = git(dir, ["write-tree"]);
  const rootIso = new Date(NOW - 100 * 24 * HOUR).toISOString();
  const root = git(dir, ["commit-tree", tree, "-m", "root"], {
    GIT_AUTHOR_NAME: "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: rootIso,
    GIT_COMMITTER_NAME: HUMAN_COMMITTER.name,
    GIT_COMMITTER_EMAIL: HUMAN_COMMITTER.email,
    GIT_COMMITTER_DATE: rootIso,
  });
  git(dir, ["remote", "add", "origin", `https://github.com/${REPO}.git`]);
  git(dir, ["update-ref", "refs/remotes/origin/master", root]);
  return { dir, headSha: root };
}
let sharedRepo = null;
const plainRepo = () => (sharedRepo ??= buildRepo());

// ---- 합성 GitHub 응답 -------------------------------------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();
const ok200 = (json) => ({ ok: true, status: 200, json, linkHeader: null });
const P3_PATH_RE =
  /^\/pulls\?state=closed|^\/issues\/comments\?|^\/pulls\/comments\?/;

// 기록 PR 한 건(목록 항목) · 병합된 PR 상세(merged_by = 병합 버튼을 누른 계정).
const recPr = (over = {}) => ({
  number: over.pr ?? 101,
  state: "closed",
  title: `${HEAD} #${NUM} 결정 요지`,
  head: { ref: `g3-${NUM}` },
  base: { ref: over.base ?? RECORD_BASE },
  user: { login: BOT_A, id: 300438013 },
  created_at: iso(NOW - 3 * HOUR),
  closed_at: iso(IN_WINDOW_MERGED),
  merged_at: iso(IN_WINDOW_MERGED),
});
const detailOf = (pr, mergedBy) => ({
  number: pr,
  merged: true,
  merged_at: iso(IN_WINDOW_MERGED),
  base: { ref: RECORD_BASE },
  user: { login: BOT_A, id: 300438013 },
  merged_by: mergedBy,
});

// 가짜 fetchJson -- 기록 목록(base 가 무엇이든 /pulls?state=all&base=) · 상세 · 그 밖 호출을 구분해 기록한다.
function makeFetch({ repo, list = [], details = {} } = {}) {
  const calls = { g3List: [], g3Detail: [], other: [], all: [] };
  const fetchJson = async ({ url }) => {
    calls.all.push(url);
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    if (path.startsWith("/pulls?state=all&base=")) {
      calls.g3List.push(url);
      return ok200(list);
    }
    const detail = /^\/pulls\/(\d+)$/.exec(path);
    if (detail && Object.hasOwn(details, Number(detail[1]))) {
      calls.g3Detail.push(url);
      return ok200(details[Number(detail[1])]);
    }
    calls.other.push(url);
    if (P3_PATH_RE.test(path)) return ok200([]);
    if (path === "") return ok200({ default_branch: "master" });
    if (path === "/branches/master")
      return ok200({ protected: true, commit: { sha: repo.headSha } });
    return { ok: false, status: 404, json: null, linkHeader: null };
  };
  return { fetchJson, calls };
}

function makeLinearFetch() {
  const calls = [];
  const linearFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: { id: "viewer-key-owner" },
          issues: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      }),
    };
  };
  return { linearFetch, calls };
}

// ---- 프로덕션 진입점 1회(보고 CLI 모양 = 상태 인자 없음) ----------------------------------------------------------------------
async function run({
  list,
  details,
  gate3 = false,
  status,
  extra = {},
  repo = plainRepo(),
} = {}) {
  const root = tmpDir("nc-g3flag-run-");
  const gh = makeFetch({ repo, list, details });
  const options = {
    now: NOW,
    repoRoot: repo.dir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    sessionHomeDir: join(root, "home-missing"),
    fetchJson: gh.fetchJson,
    git: report.createProcessGitPort(repo.dir),
    gitWorktreeListExecFn: () => "",
    ...extra,
  };
  if (gate3) options.gate3RecordBase = RECORD_BASE;
  if (status) options.gate3RecordStatus = status;
  const result = await report.runPartialCountOnce(options);
  return { result, text: result.reportText, calls: gh.calls, root };
}

const lines = (text) => text.split("\n");
const statusLines = (text) => lines(text).filter((l) => l.startsWith(STATUS));
const recordLines = (text) =>
  lines(text).filter((l) => l.startsWith(RECORD_LINE));

// ---- 표지 판정 ---------------------------------------------------------------------------------------------------------------
function flagDir(content, { asDir = false, name = "gate3-record.json" } = {}) {
  const d = tmpDir("nc-g3flag-flag-");
  const p = join(d, name);
  if (asDir) fs.mkdirSync(p);
  else if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return d;
}
const judge = (watchDir, extra = {}) =>
  watch.judgeGate3RecordFlag({
    watchDir,
    existsFn: fs.existsSync,
    readFn: fs.readFileSync,
    ...extra,
  });
const R = () => watch.GATE3_RECORD_FLAG_REASON;

test("F0 사유 토큰: 얼린 상수 · 전부 서로 다름 · 이름 머리 GATE3_RECORD_FLAG_ · Linear 토큰과 값이 겹치지 않는다 · 수동 인자 토큰은 따로", () => {
  const reasons = R();
  assert.ok(Object.isFrozen(reasons));
  const values = Object.values(reasons);
  assert.equal(values.length, 12);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(v.startsWith("GATE3_RECORD_FLAG_"), v);
  assert.equal(reasons.ENABLED, "GATE3_RECORD_FLAG_ENABLED");
  const linear = Object.values(watch.LINEAR_BINDING_FLAG_REASON);
  for (const v of values) assert.ok(!linear.includes(v), v);
  assert.equal(watch.GATE3_RECORD_ARG_BASE_REASON, "GATE3_RECORD_ARG_BASE");
  assert.ok(!values.includes(watch.GATE3_RECORD_ARG_BASE_REASON));
});

test("F1 켜짐: JSON 객체 ∧ enabled 정확히 true -> on · 사유 ENABLED (다른 키가 같이 있어도 enabled 만 본다)", () => {
  assert.deepEqual(judge(flagDir('{"enabled": true}')), {
    on: true,
    reason: R().ENABLED,
  });
  assert.equal(
    judge(flagDir('{"enabled": true, "confirmed_by": "x", "base": "y"}')).on,
    true,
  );
});

test("F2 없음 -> off ABSENT(감시 폴더 없음 · 폴더 인자 없음 · 빈 문자열 포함)", () => {
  const off = { on: false, reason: R().ABSENT };
  assert.deepEqual(judge(flagDir(undefined)), off);
  assert.deepEqual(judge(join(tmpdir(), "nc-g3flag-no-such-dir-xyz")), off);
  assert.deepEqual(judge(undefined), off);
  assert.deepEqual(judge(""), off);
});

test("F3 폴더 -> off IS_DIRECTORY", () => {
  assert.deepEqual(judge(flagDir(undefined, { asDir: true })), {
    on: false,
    reason: R().IS_DIRECTORY,
  });
});

test("F4 빈 파일 · 공백만 -> off EMPTY", () => {
  assert.deepEqual(judge(flagDir("")), { on: false, reason: R().EMPTY });
  assert.deepEqual(judge(flagDir("  \n\t ")), { on: false, reason: R().EMPTY });
});

test("F5 깨진 JSON -> off NOT_JSON", () => {
  for (const bad of ["{enabled: true", "enabled", "{'enabled': true}"])
    assert.deepEqual(judge(flagDir(bad)), { on: false, reason: R().NOT_JSON });
});

test("F6 최상위가 배열 -> off VALUE_IS_ARRAY (켜짐처럼 보이는 모양도 같다)", () => {
  assert.deepEqual(judge(flagDir("[]")), {
    on: false,
    reason: R().VALUE_IS_ARRAY,
  });
  assert.deepEqual(judge(flagDir('[{"enabled": true}]')), {
    on: false,
    reason: R().VALUE_IS_ARRAY,
  });
});

test("F7 최상위가 문자열 · 숫자 -> off VALUE_IS_STRING · VALUE_IS_NUMBER", () => {
  assert.deepEqual(judge(flagDir('"true"')), {
    on: false,
    reason: R().VALUE_IS_STRING,
  });
  assert.deepEqual(judge(flagDir("1")), {
    on: false,
    reason: R().VALUE_IS_NUMBER,
  });
});

test("F8 최상위가 불리언 · null -> off NOT_OBJECT", () => {
  for (const raw of ["true", "false", "null"])
    assert.deepEqual(judge(flagDir(raw)), {
      on: false,
      reason: R().NOT_OBJECT,
    });
});

test("F9 enabled 키 없음 -> off ENABLED_KEY_MISSING", () => {
  assert.deepEqual(judge(flagDir("{}")), {
    on: false,
    reason: R().ENABLED_KEY_MISSING,
  });
  assert.deepEqual(judge(flagDir('{"enable": true, "on": true}')), {
    on: false,
    reason: R().ENABLED_KEY_MISSING,
  });
});

test("F10 enabled 가 false -> off ENABLED_NOT_TRUE", () => {
  assert.deepEqual(judge(flagDir('{"enabled": false}')), {
    on: false,
    reason: R().ENABLED_NOT_TRUE,
  });
});

test('F11 M26 enabled 가 true 가 아닌 참 값(문자열 "true" · 1 · "on" · [] · {} · null) -> 전부 off ENABLED_NOT_TRUE', () => {
  for (const v of ['"true"', "1", '"on"', "[]", "{}", "null", '"yes"'])
    assert.deepEqual(
      judge(flagDir(`{"enabled": ${v}}`)),
      { on: false, reason: R().ENABLED_NOT_TRUE },
      v,
    );
});

test("F12 읽기 실패(EACCES 등 · EISDIR 아님) -> off READ_FAILED -- NOT_JSON 과 구분 · EISDIR 이면 IS_DIRECTORY", () => {
  const dir = flagDir('{"enabled": true}');
  const throwing = (code) => () => {
    const e = new Error("합성 읽기 실패");
    e.code = code;
    throw e;
  };
  assert.deepEqual(judge(dir, { readFn: throwing("EACCES") }), {
    on: false,
    reason: R().READ_FAILED,
  });
  assert.deepEqual(judge(dir, { readFn: throwing("EISDIR") }), {
    on: false,
    reason: R().IS_DIRECTORY,
  });
  assert.deepEqual(judge(dir, { readFn: () => 42 }), {
    on: false,
    reason: R().EMPTY,
  });
});

test("F13 존재 확인 예외 -> off ABSENT (fail-closed · 던지지 않는다) · 함수 인자 누락 -> off ABSENT", () => {
  const dir = flagDir('{"enabled": true}');
  assert.deepEqual(
    judge(dir, {
      existsFn: () => {
        throw new Error("boom");
      },
    }),
    { on: false, reason: R().ABSENT },
  );
  assert.deepEqual(judge(dir, { existsFn: undefined }), {
    on: false,
    reason: R().ABSENT,
  });
  assert.deepEqual(judge(dir, { readFn: undefined }), {
    on: false,
    reason: R().ABSENT,
  });
});

test("F14 파일 이름 = gate3-record.json · 읽는 파일이 이것뿐이다(M31 교차): linear-binding.json 만 있으면 ㄱ-3 꺼짐 · gate3-record.json 만 있으면 Linear 꺼짐", () => {
  assert.equal(watch.GATE3_RECORD_FLAG_FILENAME, "gate3-record.json");
  const linearOnly = flagDir('{"enabled": true}', {
    name: "linear-binding.json",
  });
  assert.deepEqual(judge(linearOnly), { on: false, reason: R().ABSENT });
  assert.deepEqual(
    watch.judgeLinearBindingFlag({
      watchDir: linearOnly,
      existsFn: fs.existsSync,
      readFn: fs.readFileSync,
    }),
    { on: true, reason: watch.LINEAR_BINDING_FLAG_REASON.ENABLED },
  );
  const g3Only = flagDir('{"enabled": true}');
  assert.deepEqual(judge(g3Only), { on: true, reason: R().ENABLED });
  assert.deepEqual(
    watch.judgeLinearBindingFlag({
      watchDir: g3Only,
      existsFn: fs.existsSync,
      readFn: fs.readFileSync,
    }),
    { on: false, reason: watch.LINEAR_BINDING_FLAG_REASON.ABSENT },
  );
});

test("F15 스위치 = 수동 인자가 있으면 그것(ARG_BASE · 표지 내용 무관) · 없으면 표지 판정", () => {
  const args = (watchDir, argBase) => ({
    argBase,
    watchDir,
    existsFn: fs.existsSync,
    readFn: fs.readFileSync,
  });
  const arg = { on: true, reason: "GATE3_RECORD_ARG_BASE" };
  assert.deepEqual(
    watch.resolveGate3RecordSwitch(args(flagDir(undefined), "custom")),
    arg,
  );
  assert.deepEqual(
    watch.resolveGate3RecordSwitch(
      args(flagDir('{"enabled": false}'), "custom"),
    ),
    arg,
  );
  assert.deepEqual(
    watch.resolveGate3RecordSwitch(
      args(flagDir('{"enabled": true}'), "custom"),
    ),
    arg,
  );
  // 값 없는 인자(null · undefined · "")는 인자가 아니다 -> 표지 판정.
  for (const none of [null, undefined, ""])
    assert.deepEqual(
      watch.resolveGate3RecordSwitch(args(flagDir('{"enabled": true}'), none)),
      { on: true, reason: R().ENABLED },
    );
  assert.deepEqual(
    watch.resolveGate3RecordSwitch(args(flagDir(undefined), null)),
    { on: false, reason: R().ABSENT },
  );
});

// ---- 감시 회차(결선) -- 매 회차 켜짐/꺼짐 + 사유 토큰 한 줄 -------------------------------------------------------------------------------
// 감시 회차의 «실제 입구» runWatchCliPartialCountStep 에 단계 함수를 주입 -- 받은 옵션을 그대로 프로덕션 보고 진입점에 넘겨 보고문을 만든다(네트워크 · 실제 폴더 0).
async function watchRound({
  flag,
  linearFlag,
  asDir = false,
  argv = [],
  list = [],
  details = {},
  existsFn,
  readFn,
} = {}) {
  const watchDir = tmpDir("nc-g3flag-w-");
  const g3Path = join(watchDir, "gate3-record.json");
  if (asDir) fs.mkdirSync(g3Path);
  else if (flag !== undefined) fs.writeFileSync(g3Path, flag, "utf8");
  if (linearFlag !== undefined)
    fs.writeFileSync(join(watchDir, "linear-binding.json"), linearFlag, "utf8");
  const repo = plainRepo();
  const root = tmpDir("nc-g3flag-wr-");
  const gh = makeFetch({ repo, list, details });
  const lin = makeLinearFetch();
  let seen = null;
  const res = await watch.runWatchCliPartialCountStep({
    argv,
    repoRoot: repo.dir,
    watchDir,
    now: NOW,
    result: { logPath: join(root, "watch.log") },
    notifyDir: join(root, "notify"),
    ...(existsFn ? { existsFn } : {}),
    ...(readFn ? { readFn } : {}),
    runPartialCountStepFn: async ({ options }) => {
      seen = options;
      return report.runPartialCountOnce({
        ...options,
        now: NOW,
        dispatchReceiptsPath: join(root, "none.jsonl"),
        extraRepoRoots: [],
        archiveRoot: join(root, "archive-missing"),
        sessionHomeDir: join(root, "home-missing"),
        fetchJson: gh.fetchJson,
        git: report.createProcessGitPort(repo.dir),
        gitWorktreeListExecFn: () => "",
        env: { LINEAR_API_KEY: FAKE_KEY },
        linearFetch: lin.linearFetch,
      });
    },
  });
  return { seen, res, text: res.reportText, calls: gh.calls, lin };
}

test("W1 감시 회차 + 표지 없음: «ㄱ-3 GitHub 기록 수집 꺼짐(GATE3_RECORD_FLAG_ABSENT)» 정확히 한 줄 · 기록 목록 호출 0 · 기록 줄 0 · 수집 옵션 없음 (M27)", async () => {
  const { text, calls, seen } = await watchRound({ flag: undefined });
  assert.deepEqual(statusLines(text), [
    `${STATUS} 꺼짐(GATE3_RECORD_FLAG_ABSENT)`,
  ]);
  assert.equal(calls.g3List.length, 0);
  assert.equal(recordLines(text).length, 0);
  assert.ok(!("gate3RecordBase" in seen), "꺼진 회차가 수집 옵션을 켰다");
  assert.deepEqual(seen.gate3RecordStatus, {
    on: false,
    reason: "GATE3_RECORD_FLAG_ABSENT",
  });
});

test("W2 감시 회차 + 표지 칸마다 꺼짐 줄에 칸의 사유 토큰이 찍힌다 · 호출 0", async () => {
  const cases = [
    [{ flag: undefined }, "GATE3_RECORD_FLAG_ABSENT"],
    [{ flag: undefined, asDir: true }, "GATE3_RECORD_FLAG_IS_DIRECTORY"],
    [{ flag: "" }, "GATE3_RECORD_FLAG_EMPTY"],
    [{ flag: "{bad" }, "GATE3_RECORD_FLAG_NOT_JSON"],
    [{ flag: "[]" }, "GATE3_RECORD_FLAG_VALUE_IS_ARRAY"],
    [{ flag: '"x"' }, "GATE3_RECORD_FLAG_VALUE_IS_STRING"],
    [{ flag: "7" }, "GATE3_RECORD_FLAG_VALUE_IS_NUMBER"],
    [{ flag: "null" }, "GATE3_RECORD_FLAG_NOT_OBJECT"],
    [{ flag: "{}" }, "GATE3_RECORD_FLAG_ENABLED_KEY_MISSING"],
    [{ flag: '{"enabled": false}' }, "GATE3_RECORD_FLAG_ENABLED_NOT_TRUE"],
    [{ flag: '{"enabled": "true"}' }, "GATE3_RECORD_FLAG_ENABLED_NOT_TRUE"],
    [{ flag: '{"enabled": 1}' }, "GATE3_RECORD_FLAG_ENABLED_NOT_TRUE"],
    [
      {
        flag: '{"enabled": true}',
        readFn: () => {
          const e = new Error("합성");
          e.code = "EACCES";
          throw e;
        },
      },
      "GATE3_RECORD_FLAG_READ_FAILED",
    ],
  ];
  for (const [args, token] of cases) {
    const { text, calls, seen } = await watchRound(args);
    assert.deepEqual(statusLines(text), [`${STATUS} 꺼짐(${token})`], token);
    assert.equal(calls.g3List.length, 0, token);
    assert.equal(calls.g3Detail.length, 0, token);
    assert.ok(!("gate3RecordBase" in seen), token);
  }
});

test("W3 감시 회차 + 표지 켜짐: «켜짐(GATE3_RECORD_FLAG_ENABLED)» + 코드 상수 가지로 기록 수집 + B1 ㄱ-3 줄(문면 그대로) · 호출 = 목록 1 + 상세 1", async () => {
  const { text, calls, seen } = await watchRound({
    flag: '{"enabled": true}',
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.deepEqual(statusLines(text), [
    `${STATUS} 켜짐(GATE3_RECORD_FLAG_ENABLED)`,
  ]);
  assert.equal(seen.gate3RecordBase, "gate3-record");
  assert.deepEqual(seen.gate3RecordStatus, {
    on: true,
    reason: "GATE3_RECORD_FLAG_ENABLED",
  });
  assert.equal(calls.g3List.length, 1);
  assert.ok(calls.g3List[0].includes("&base=gate3-record&"), calls.g3List[0]);
  assert.equal(calls.g3Detail.length, 1);
  const rec = recordLines(text);
  assert.equal(rec.length, 1, rec.join("\n"));
  assert.ok(
    rec[0].includes("(한용 Merge · 기록만 · 차단 0): 독립 확인 1건"),
    rec[0],
  );
  assert.ok(text.includes(`PR#101 #${NUM} 병합자 hykim82`));
  // GitHub REST 사용 합계 표본(켜짐 회차): 목록 1 + 상세 1 = 2 -- 수동 인자 회차와 같다(W5).
  console.log(
    `# SAMPLE REST g3List=${calls.g3List.length} g3Detail=${calls.g3Detail.length} other=${calls.other.length}`,
  );
});

test("W4 M28 켜짐이어도 기록 가지는 코드 상수 그대로: 표지의 다른 키(base · gate3RecordBase · branch)는 무시된다 · 목록 URL 에 다른 가지 이름 0", async () => {
  const { calls, seen, text } = await watchRound({
    flag: '{"enabled": true, "base": "evil-branch", "gate3RecordBase": "evil-2", "branch": "evil-3", "recordBase": "evil-4"}',
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(seen.gate3RecordBase, "gate3-record");
  assert.equal(calls.g3List.length, 1);
  assert.ok(calls.g3List[0].includes("&base=gate3-record&"), calls.g3List[0]);
  for (const url of calls.all) assert.ok(!url.includes("evil"), url);
  assert.deepEqual(statusLines(text), [
    `${STATUS} 켜짐(GATE3_RECORD_FLAG_ENABLED)`,
  ]);
});

test("W5 M29 수동 인자 --gate3-record-base 는 표지가 없어도 켜짐(GATE3_RECORD_ARG_BASE) · 인자의 가지 이름이 그대로 · 표지 켜짐이어도 인자가 앞선다 · REST 합계는 표지 켜짐 회차와 같다", async () => {
  const noFlag = await watchRound({
    flag: undefined,
    argv: ["--gate3-record-base", "custom-branch"],
    list: [recPr({ base: "custom-branch" })],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.deepEqual(statusLines(noFlag.text), [
    `${STATUS} 켜짐(GATE3_RECORD_ARG_BASE)`,
  ]);
  assert.equal(noFlag.seen.gate3RecordBase, "custom-branch");
  assert.equal(noFlag.calls.g3List.length, 1);
  assert.ok(
    noFlag.calls.g3List[0].includes("&base=custom-branch&"),
    noFlag.calls.g3List[0],
  );
  const withFlag = await watchRound({
    flag: '{"enabled": true}',
    argv: ["--gate3-record-base", "custom-branch"],
    list: [recPr({ base: "custom-branch" })],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(withFlag.seen.gate3RecordBase, "custom-branch");
  assert.deepEqual(statusLines(withFlag.text), [
    `${STATUS} 켜짐(GATE3_RECORD_ARG_BASE)`,
  ]);
  const flagOff = await watchRound({
    flag: '{"enabled": false}',
    argv: ["--gate3-record-base", "custom-branch"],
  });
  assert.equal(flagOff.seen.gate3RecordBase, "custom-branch");
  assert.equal(flagOff.calls.g3List.length, 1);
  // 값 없는 인자(끝 인자)는 인자가 아니다 -> 표지 판정(없음 -> 꺼짐).
  const bare = await watchRound({
    flag: undefined,
    argv: ["--gate3-record-base"],
  });
  assert.deepEqual(statusLines(bare.text), [
    `${STATUS} 꺼짐(GATE3_RECORD_FLAG_ABSENT)`,
  ]);
  // 켜짐(표지) 회차와 켜짐(인자) 회차의 GitHub 호출 모양이 같다(가지 이름만 다르다).
  const viaFlag = await watchRound({
    flag: '{"enabled": true}',
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(viaFlag.calls.all.length, noFlag.calls.all.length);
  assert.equal(viaFlag.calls.g3Detail.length, noFlag.calls.g3Detail.length);
});

test("W6 M31 두 표지는 서로 독립: linear-binding.json 만 켜짐 -> ㄱ-3 꺼짐(ABSENT) · Linear 켜짐 / gate3-record.json 만 켜짐 -> ㄱ-3 켜짐 · Linear 꺼짐(호출 0)", async () => {
  const linearOnly = await watchRound({
    flag: undefined,
    linearFlag: '{"enabled": true}',
  });
  assert.deepEqual(statusLines(linearOnly.text), [
    `${STATUS} 꺼짐(GATE3_RECORD_FLAG_ABSENT)`,
  ]);
  assert.equal(linearOnly.calls.g3List.length, 0);
  assert.ok(!("gate3RecordBase" in linearOnly.seen));
  assert.equal(linearOnly.seen.linearBinding, true);
  assert.equal(linearOnly.lin.calls.length, 1, "Linear 는 켜졌어야 한다");
  const linearLine = lines(linearOnly.text).find((l) =>
    l.startsWith(LINEAR_STATUS),
  );
  assert.equal(linearLine, `${LINEAR_STATUS}켜짐(LINEAR_BINDING_FLAG_ENABLED)`);

  const g3Only = await watchRound({
    flag: '{"enabled": true}',
    linearFlag: undefined,
  });
  assert.equal(g3Only.seen.gate3RecordBase, "gate3-record");
  assert.equal(g3Only.calls.g3List.length, 1);
  assert.ok(!("linearBinding" in g3Only.seen));
  assert.equal(g3Only.lin.calls.length, 0);
  assert.equal(
    lines(g3Only.text).find((l) => l.startsWith(LINEAR_STATUS)),
    `${LINEAR_STATUS}꺼짐(LINEAR_BINDING_FLAG_ABSENT)`,
  );
});

test("W7 buildPartialCountStepOptions: 스위치를 안 주면 옛 옵션 모양 그대로(회귀 0) · 켜짐이면 코드 상수 가지 + 상태 · 꺼짐이면 상태만 · 수동 값이 있으면 그 값", () => {
  const base = {
    repoRoot: "r",
    watchLogPath: "w",
    outboxDir: null,
    relayGlob: null,
    inboxDir: null,
  };
  assert.deepEqual(
    Object.keys(watch.buildPartialCountStepOptions(base)).sort(),
    ["inboxDir", "outboxDir", "relayGlob", "repoRoot", "watchLogPath"],
  );
  const on = watch.buildPartialCountStepOptions({
    ...base,
    gate3RecordSwitch: { on: true, reason: "X" },
  });
  assert.equal(on.gate3RecordBase, "gate3-record");
  assert.deepEqual(on.gate3RecordStatus, { on: true, reason: "X" });
  const off = watch.buildPartialCountStepOptions({
    ...base,
    gate3RecordSwitch: { on: false, reason: "Y" },
  });
  assert.ok(!("gate3RecordBase" in off));
  assert.deepEqual(off.gate3RecordStatus, { on: false, reason: "Y" });
  const manual = watch.buildPartialCountStepOptions({
    ...base,
    gate3RecordBase: "custom",
    gate3RecordSwitch: { on: true, reason: "GATE3_RECORD_ARG_BASE" },
  });
  assert.equal(manual.gate3RecordBase, "custom");
  assert.equal(report.GATE3_RECORD_BASE, "gate3-record");
});

// ---- 보고 줄 · 인자 없는 보고 CLI 새 줄 0 · 렌더 ----------------------------------------------------------------------------------------
test("C1 M30 인자 없는 보고 CLI: 상태 없이 직접 부르면 «기록 수집» 줄 0개(기록 수집 옵션이 있어도) -- 옛 호출자 회귀 0", async () => {
  const bare = await run({});
  assert.equal(statusLines(bare.text).length, 0);
  assert.ok(!bare.text.includes("GitHub 기록 수집"));
  assert.equal(bare.calls.g3List.length, 0);
  const manual = await run({
    gate3: true,
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(statusLines(manual.text).length, 0);
  assert.equal(recordLines(manual.text).length, 1);
  assert.equal(manual.calls.g3List.length, 1);
  assert.ok(
    !("gate3RecordStatus" in report.parseCliArgs(["--repo-root", "x"])),
  );
});

test("R1 렌더: 상태 없음 = 줄 0개 · 켜짐 · 꺼짐 = 사유 토큰 한 줄(손으로 정한 문면) · 던지지 않는다", () => {
  assert.deepEqual(core.renderGate3RecordStatusLines(undefined), []);
  assert.deepEqual(core.renderGate3RecordStatusLines(null), []);
  assert.deepEqual(
    core.renderGate3RecordStatusLines({
      on: true,
      reason: "GATE3_RECORD_FLAG_ENABLED",
    }),
    ["- ㄱ-3 GitHub 기록 수집 켜짐(GATE3_RECORD_FLAG_ENABLED)"],
  );
  assert.deepEqual(
    core.renderGate3RecordStatusLines({
      on: false,
      reason: "GATE3_RECORD_FLAG_NOT_JSON",
    }),
    ["- ㄱ-3 GitHub 기록 수집 꺼짐(GATE3_RECORD_FLAG_NOT_JSON)"],
  );
  // 켜짐이 아닌 모든 값은 «꺼짐» 으로 쓴다(on 이 정확히 true 일 때만 켜짐).
  assert.ok(
    core
      .renderGate3RecordStatusLines({ on: "yes", reason: "Z" })[0]
      .includes("꺼짐(Z)"),
  );
});

test("O1 줄 순서: ㄱ-4 블록 -> 기록 수집 상태 줄 -> ㄱ-3 GitHub 기록 줄 -> 보조 관측 -> 커버리지 두 줄", async () => {
  const { text } = await watchRound({
    flag: '{"enabled": true}',
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const ls = lines(text);
  const iA = ls.findIndex((l) => l.startsWith("- 외부 독립 앵커로 확인"));
  const iS = ls.findIndex((l) => l.startsWith(STATUS));
  const iR = ls.findIndex((l) => l.startsWith(RECORD_LINE));
  const iAux = ls.findIndex((l) =>
    l.startsWith("- ORCH-writeable 보조 관측: "),
  );
  const iCov = ls.findIndex((l) => l.startsWith("- 독립 앵커 유형 커버리지"));
  assert.ok(
    iA >= 0 && iA < iS && iS < iR && iR < iAux && iAux < iCov,
    `${iA} ${iS} ${iR} ${iAux} ${iCov}`,
  );
});

// ---- 차단 0 · 기록 수 합산 0 -------------------------------------------------------------------------------------------------------
test("M13 차단 0: 꺼짐 · 없음(표지 어느 칸이든)이 일별 마감 값 · 수집 건강 행 · 종료 모양 · 새 파일을 바꾸지 않는다 -- 줄 하나만 더 생긴다", async () => {
  const outboxDir = tmpDir("nc-g3flag-outbox-");
  const inboxDir = tmpDir("nc-g3flag-inbox-");
  const snap = (d) => fs.readdirSync(d).sort().join("|");
  const before = [outboxDir, inboxDir].map(snap);
  const base = await run({ extra: { outboxDir, inboxDir } });
  const baseFiles = snap(base.root);
  for (const token of [
    "GATE3_RECORD_FLAG_ABSENT",
    "GATE3_RECORD_FLAG_NOT_JSON",
    "GATE3_RECORD_FLAG_READ_FAILED",
    "GATE3_RECORD_FLAG_ENABLED_NOT_TRUE",
  ]) {
    const r = await run({
      status: { on: false, reason: token },
      extra: { outboxDir, inboxDir },
    });
    assert.ok(r.text.startsWith("집계 성격: PARTIAL"), "보고는 정상 생성");
    assert.deepEqual(r.result.dailyTick, base.result.dailyTick, token);
    assert.equal(r.result.gate4.known, base.result.gate4.known);
    assert.equal(snap(r.root), baseFiles, "회차 폴더 파일 목록이 달라졌다");
    // 수집 건강 행에 FAIL 이 새로 생기지 않는다 · 상태 줄 하나 말고는 보고문이 같다(회차마다 다른 합성 임시 폴더 경로만 같은 글자로 바꿔서 비교).
    const norm = (x) => x.text.split(x.root).join("<ROOT>");
    const health = (x) =>
      lines(norm(x)).find((l) => l.startsWith("- 수집 성공/실패"));
    assert.equal(health(r), health(base), token);
    assert.deepEqual(
      lines(norm(r)).filter((l) => !l.startsWith(STATUS)),
      lines(norm(base)),
      token,
    );
    assert.equal(statusLines(r.text).length, 1, token);
  }
  assert.deepEqual(
    [outboxDir, inboxDir].map(snap),
    before,
    "받는함 · 보내는함에 파일이 생겼다",
  );
});

test("M13b 차단 0: 켜짐 회차에 목록 실패 · 던지는 fetch 가 와도 보고는 정상 생성 · 일별 끊김 사유에 ㄱ-3 수집기 이름이 없다", async () => {
  const base = await run({});
  const throwing = await run({
    status: { on: true, reason: "GATE3_RECORD_FLAG_ENABLED" },
    gate3: true,
    extra: {
      fetchJson: async ({ url }) => {
        if (url.includes("base=gate3-record"))
          throw new Error("합성 네트워크 예외");
        return makeFetch({ repo: plainRepo() }).fetchJson({ url });
      },
    },
  });
  assert.ok(throwing.text.startsWith("집계 성격: PARTIAL"));
  assert.deepEqual(throwing.result.dailyTick, base.result.dailyTick);
  assert.equal(
    throwing.result.dailyTick.collectorFails.some((n) => n.includes("ㄱ-3")),
    false,
  );
  assert.equal(statusLines(throwing.text).length, 1);
});

test("M14 기록 수 합산 0: 독립 확인 1건이 있는 켜짐 회차와 상태만 있는 꺼짐 회차의 «외부 독립 앵커로 확인» · 커버리지 두 줄 · ㄴ 절이 한 글자도 안 다르다", async () => {
  const on = await run({
    gate3: true,
    status: { on: true, reason: "GATE3_RECORD_FLAG_ENABLED" },
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const off = await run({
    status: { on: false, reason: "GATE3_RECORD_FLAG_ABSENT" },
  });
  assert.ok(
    recordLines(on.text)[0].includes("독립 확인 1건"),
    "기록 1건이 잡혀야 비교가 공허하지 않다",
  );
  // 상태 줄 · ㄱ-3 기록 줄(과 그 아래 확인 사건 · 전달 분류 줄) · 수집 건강 행만 빼면 같다.
  const strip = (t) =>
    lines(t).filter(
      (l) =>
        !l.startsWith(STATUS) &&
        !l.startsWith(RECORD_LINE) &&
        !l.startsWith("  · 확인 사건: PR#") &&
        !l.startsWith("  · 전달 ㄱ-3 분류") &&
        !l.startsWith("- 수집 성공/실패"),
    );
  assert.deepEqual(strip(on.text), strip(off.text));
  const anchor = (t) =>
    lines(t).find((l) => l.startsWith("- 외부 독립 앵커로 확인: "));
  assert.equal(anchor(on.text), anchor(off.text));
  assert.ok(
    anchor(on.text).startsWith("- 외부 독립 앵커로 확인: 0건"),
    anchor(on.text),
  );
  for (const t of [on.text, off.text])
    assert.ok(t.includes("- 독립 앵커 유형 커버리지: 1/6"));
});

test("M14b 게이트 1 · 7 · 보조 관측 무접촉 + 켜짐 줄이 감시 회차 전체에서 한 번만: 보조 관측 줄은 켬/끔이 같다", async () => {
  const outboxDir = tmpDir("nc-g3flag-outbox2-");
  const inboxDir = tmpDir("nc-g3flag-inbox2-");
  const auxOf = async (gate3) => {
    const r = await run({
      gate3,
      status: gate3
        ? { on: true, reason: "GATE3_RECORD_FLAG_ENABLED" }
        : { on: false, reason: "GATE3_RECORD_FLAG_ABSENT" },
      list: [recPr()],
      details: { 101: detailOf(101, HANYONG) },
      extra: { outboxDir, inboxDir },
    });
    return lines(r.text).find((l) => l.startsWith("- 보조 관측(독립 아님):"));
  };
  const on = await auxOf(true);
  const off = await auxOf(false);
  assert.ok(on, "보조 관측 줄이 없다(공허)");
  assert.equal(on, off);
});

// ---- 줄 표본 · TZ=UTC 자식 -------------------------------------------------------------------------------------------------------
test("S1 표본: 감시 회차 꺼짐 줄 1 · 켜짐 줄 1 · 수동 인자 줄 1 · 인자 없는 CLI 0줄 (출력은 SAMPLE 로 남긴다)", async () => {
  const off = await watchRound({ flag: undefined });
  const on = await watchRound({
    flag: '{"enabled": true}',
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const arg = await watchRound({
    flag: undefined,
    argv: ["--gate3-record-base", "gate3-record"],
  });
  const bare = await run({});
  const samples = {
    꺼짐: statusLines(off.text),
    켜짐: statusLines(on.text),
    수동인자: statusLines(arg.text),
    인자없음: statusLines(bare.text),
  };
  assert.deepEqual(samples.꺼짐, [`${STATUS} 꺼짐(GATE3_RECORD_FLAG_ABSENT)`]);
  assert.deepEqual(samples.켜짐, [`${STATUS} 켜짐(GATE3_RECORD_FLAG_ENABLED)`]);
  assert.deepEqual(samples.수동인자, [`${STATUS} 켜짐(GATE3_RECORD_ARG_BASE)`]);
  assert.deepEqual(samples.인자없음, []);
  console.log(`# SAMPLE ${JSON.stringify(samples)}`);
});

test("Z1 TZ=UTC 자식: 순수 판정 · 렌더가 실행 환경 시간대와 무관(자식 env 에 TZ 만 · 시각 값 없음 · 입력은 고정 문자열)", () => {
  const coreUrl = pathToFileURL(
    fileURLToPath(new URL("./partial-count-core.mjs", import.meta.url)),
  ).href;
  const watchUrl = pathToFileURL(
    fileURLToPath(new URL("./watch-run.mjs", import.meta.url)),
  ).href;
  const script = `
    const core = await import(${JSON.stringify(coreUrl)});
    const watch = await import(${JSON.stringify(watchUrl)});
    const sw = (raw) => watch.judgeGate3RecordFlag({
      watchDir: "W",
      existsFn: () => true,
      readFn: () => raw,
    });
    const judged = [sw('{"enabled": true}'), sw('{"enabled": "true"}'), sw("")];
    const rendered = judged.flatMap((j) => core.renderGate3RecordStatusLines(j));
    console.log(JSON.stringify({ judged, rendered }));
  `;
  const outs = ["UTC", "Asia/Seoul", "America/New_York"].map((tz) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    }).trim(),
  );
  assert.equal(outs[0], outs[1]);
  assert.equal(outs[0], outs[2]);
  const child = JSON.parse(outs[0]);
  assert.deepEqual(child.judged, [
    { on: true, reason: "GATE3_RECORD_FLAG_ENABLED" },
    { on: false, reason: "GATE3_RECORD_FLAG_ENABLED_NOT_TRUE" },
    { on: false, reason: "GATE3_RECORD_FLAG_EMPTY" },
  ]);
  assert.deepEqual(child.rendered, [
    "- ㄱ-3 GitHub 기록 수집 켜짐(GATE3_RECORD_FLAG_ENABLED)",
    "- ㄱ-3 GitHub 기록 수집 꺼짐(GATE3_RECORD_FLAG_ENABLED_NOT_TRUE)",
    "- ㄱ-3 GitHub 기록 수집 꺼짐(GATE3_RECORD_FLAG_EMPTY)",
  ]);
});
