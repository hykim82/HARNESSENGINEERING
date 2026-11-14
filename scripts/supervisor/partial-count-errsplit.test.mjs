// HYK-255-p5a-errsplit-1 (판정 1306 ④⑤ · 1407) -- 권한 기록 수집기: 오류로 끝난 도구 결과 분리 · 시각 불명 사람 답 하한 토막.
//
// ⛔헛시험 금지: 프로덕션 export 를 직접 구동한다 -- report.collectPermissionAnswers(수집기) · report.runPartialCountOnce
// (실제 보고 조립) · core 의 순수 함수(일별 회차 값 · 줄 · 연속 일수). 사본 import 0. 합성 홈(mkdtemp) 아래 합성 세션
// jsonl · 주입 시계(now) · 가짜 fetchJson -- 실제 네트워크 · 실물 세션 기록 · 관제실 · 받는함 쓰기 0.
// 합성 jsonl 의 대화 본문 칸은 전부 검출용 표식 문자열(BODY-SENTINEL)이다(실제 대화 본문 0).
//
// 계약(판정 1306 ④ + 1407): 판정 칸 없는 도구 결과 중 `is_error === true` 인 것은 새 칸(errorEndedNoDecision)으로 세고
// K(undecided)에서 뺀다 -- 끊김 사유가 아니다. 새 판 세션이 «전부 오류» 면 S 가 아니다. 구판 줄이 섞이면 S 그대로.
// 시각 불명 + 사람 답 계열 판정은 버리지 않고 하한 토막(undatedHumanAnswers)에 넣는다. `is_error` «칸» 만 읽는다(본문 0).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";

const HOUR = 60 * 60 * 1000;
const kst = (s) =>
  Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+09:00`);
const NOW = kst("2026-11-14 10:00:00");
const WINDOW_START = NOW - 24 * HOUR;
const BODY = "BODY-SENTINEL-대화본문-표식";
const AT = kst("2026-11-13 12:00:00");

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

// ---- 합성 세션 jsonl ------------------------------------------------------------------

let seq = 0;
const nextId = () => `eid${(seq += 1)}`;

// user · tool_result 줄. 판정 칸 = source 가 있을 때만. 오류 칸 = isError 가 undefined 가 아닐 때만 tool_result 항목에 싣는다
// (실물 모양: message.content[].is_error). contentOverride 는 «본문 안에 오류처럼 보이는 글자» 시험용.
function resultLine({
  atMs,
  cwd,
  sessionId,
  uuid,
  toolUseId = nextId(),
  source,
  decision = "accept",
  isError,
  contentOverride,
  version = "2.1.322",
  noTimestamp = false,
}) {
  const item = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: contentOverride ?? BODY,
  };
  if (isError !== undefined) item.is_error = isError;
  const o = {
    type: "user",
    uuid: uuid ?? `u-${toolUseId}`,
    cwd,
    sessionId,
    version,
    entrypoint: "cli",
    permissionMode: "default",
    message: { role: "user", content: [item] },
    toolUseResult: BODY,
  };
  if (!noTimestamp) o.timestamp = new Date(atMs).toISOString();
  if (source !== undefined) o.permissionDecision = { decision, source };
  return JSON.stringify(o);
}

function makeHome() {
  const home = tmpDir("nc-errsplit-home-");
  const interpreter = join(home, "통역-합성");
  fs.mkdirSync(join(interpreter, "보내는함"), { recursive: true });
  const h = {
    home,
    interpreter,
    outboxDir: join(interpreter, "보내는함"),
    main: join(home, "Documents", "HARNESSENGINEERING"),
    harnessWt: join(home, "orca", "workspaces", "HARNESSENGINEERING", "wt-1"),
    elsewhere: join(home, "개인-문서"),
  };
  for (const r of [".claude", ".claude-team"]) {
    fs.mkdirSync(join(home, r, "projects", "p1"), { recursive: true });
  }
  return h;
}

function putSession(h, { root = "claude-team", name, lines }) {
  const dir = join(
    h.home,
    root === "claude" ? ".claude" : ".claude-team",
    "projects",
    "p1",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, `${name}.jsonl`), lines.join("\n") + "\n", "utf8");
}

// 세션 1개 = parts 의 줄들. 각 part 는 resultLine 인자(시각 · cwd · 세션은 자동).
function sess(h, name, parts, { root = "claude-team", cwd } = {}) {
  putSession(h, {
    root,
    name,
    lines: parts.map((p, i) =>
      resultLine({
        atMs: AT + i * 1000,
        cwd: cwd ?? h.harnessWt,
        sessionId: name,
        ...p,
      }),
    ),
  });
}

function collect(h) {
  return report.collectPermissionAnswers({
    homeDir: h.home,
    interpreterRoot: h.interpreter,
    windowStartMs: WINDOW_START,
    windowEndMs: NOW,
  });
}

// ---- 합성 저장소(실제 보고 조립용) ----------------------------------------------------

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
let sharedRepo = null;
function repoOnce() {
  if (sharedRepo) return sharedRepo;
  const repo = tmpDir("nc-errsplit-repo-");
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
  git(repo, ["remote", "add", "origin", `https://github.com/${REPO_SLUG}.git`]);
  git(repo, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  sharedRepo = repo;
  return repo;
}

async function runReal(h, options = {}) {
  const root = tmpDir("nc-errsplit-run-");
  const repo = repoOnce();
  return report.runPartialCountOnce({
    now: NOW,
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
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
    ...options,
  });
}

const lnLine = (text) =>
  /^- 외부 독립 증거로 확인된 사건: (.*)$/m.exec(text)?.[1];
const permLine = (text) =>
  /^- 권한 확인창 사람 답\(B · 세션 기록\): (.*)$/m.exec(text)?.[1];

const ERR_PIECE = (n) => `오류로 끝난 도구 결과 ${n}(판정 없음 · 끊김 아님)`;

// ======================================================================================
// ⑵-1 칸 -- 판정 없음 + 오류 표시 분리(수집기 값)
// ======================================================================================

test("칸 판정 없음 + 오류 참 = 새 칸 1 · K 0 · 하한 토막 없음(끊김 아님) -- 판정 있는 줄과 같은 세션", () => {
  const h = makeHome();
  sess(h, "s-a", [{ source: "config" }, { isError: true }]);
  const r = collect(h);
  assert.equal(r.known, true);
  assert.equal(r.errorEndedNoDecision, 1);
  assert.equal(r.undecided, 0, "오류 참 판정 없음은 K 가 아니다");
  assert.equal(r.fieldMissingSessions, 0);
  assert.deepEqual(core.permissionGapPieces(r), [], "끊김 사유(하한 토막) 0");
});

test("칸 판정 없음 + 오류 거짓 · 오류 칸 없음 = K(끊김) -- 새 칸 0", () => {
  const h = makeHome();
  sess(h, "s-b", [
    { source: "config" },
    { isError: false },
    {}, // 오류 칸 없음
  ]);
  const r = collect(h);
  assert.equal(r.undecided, 2);
  assert.equal(r.errorEndedNoDecision, 0);
  assert.deepEqual(core.permissionGapPieces(r), ["판정 불가 2"]);
});

test("칸 «참» 이 아닌 모든 모양(문자열 «true» · 1 · null · 객체)은 오류로 치지 않는다 = K (애매하면 K)", () => {
  const h = makeHome();
  sess(h, "s-c", [
    { source: "config" },
    { isError: "true" },
    { isError: 1 },
    { isError: null },
    { isError: { value: true } },
  ]);
  const r = collect(h);
  assert.equal(r.undecided, 4);
  assert.equal(r.errorEndedNoDecision, 0);
});

test("칸 오류 참 + 판정 있음(사람 거절) = 판정이 이긴다 -- 사람 답 그대로 · 새 칸 0", () => {
  const h = makeHome();
  sess(h, "s-d", [{ source: "user_reject", isError: true }]);
  const r = collect(h);
  assert.equal(r.human, 1);
  assert.equal(r.humanTotal, 1);
  assert.equal(r.errorEndedNoDecision, 0);
  assert.equal(r.undecided, 0);
});

// ======================================================================================
// ⑵-2 칸 -- 세션 단위(S)
// ======================================================================================

test("칸 새 판 세션의 도구 결과가 «전부» 오류 참 = 필드 없는 세션 S 아님 -- 새 칸 N · K 0 · 수집기 OK", async () => {
  const h = makeHome();
  sess(h, "s-all-err", [
    { isError: true },
    { isError: true },
    { isError: true },
  ]);
  const r = collect(h);
  assert.equal(r.fieldMissingSessions, 0);
  assert.equal(r.errorEndedNoDecision, 3);
  assert.equal(r.undecided, 0);
  assert.deepEqual(core.permissionGapPieces(r), []);
  const result = await runReal(h);
  assert.match(result.reportText, /권한기록수집기 OK\(/);
  assert.equal(
    result.dailyTick.collectorFails.includes("권한기록수집기"),
    false,
  );
});

test("칸 새 판 판정 0 세션에 «오류 아닌» 결과가 하나라도 섞이면 S 그대로 (오류 섞인 판정 0 세션)", () => {
  const h = makeHome();
  sess(h, "s-mixed-new", [{ isError: true }, { isError: true }, {}]);
  const r = collect(h);
  assert.equal(r.fieldMissingSessions, 1);
  assert.equal(
    r.undecided,
    0,
    "S 세션의 판정 없음은 K 로 세지 않는다(기존 규칙)",
  );
  assert.equal(
    r.errorEndedNoDecision,
    0,
    "S 세션은 K 와 같이 새 칸에도 넣지 않는다",
  );
});

test("칸 구판 줄이 섞인 세션 = S 그대로 -- 새 판 오류 줄이 있어도 · 구판 줄 자체가 오류 참이어도", () => {
  const h = makeHome();
  sess(h, "s-old-mix", [
    { source: "config" },
    { isError: true }, // 새 판 오류
    { version: "2.1.300", isError: true }, // 구판 줄(판정 칸이 없던 판)
  ]);
  sess(h, "s-old-all-err", [
    { version: "2.1.300", isError: true },
    { version: "2.1.300", isError: true },
  ]);
  const r = collect(h);
  assert.equal(r.fieldMissingSessions, 2);
  assert.equal(r.errorEndedNoDecision, 0);
  assert.equal(r.undecided, 0);
  assert.deepEqual(core.permissionGapPieces(r), ["권한기록 필드 없는 세션 2"]);
});

test("칸 판정 있는 세션 + 오류 참 + 오류 거짓 판정 없음 = 새 칸은 오류만 · K 는 아닌 것만", () => {
  const h = makeHome();
  sess(h, "s-split", [
    { source: "config" },
    { isError: true },
    { isError: true },
    { isError: false },
  ]);
  const r = collect(h);
  assert.equal(r.errorEndedNoDecision, 2);
  assert.equal(r.undecided, 1);
});

// ======================================================================================
// ⑵-3 칸 -- 시각 불명 사람 답 = 하한 토막
// ======================================================================================

test("칸 시각 불명 + user_temporary = 분자 이상 토막 1 (날짜 칸에는 안 들어간다 · 사람 답 합계 불변)", () => {
  const h = makeHome();
  sess(h, "s-und", [
    { source: "config" },
    { source: "user_temporary", noTimestamp: true },
  ]);
  const r = collect(h);
  assert.equal(r.undated, 1);
  assert.equal(r.undatedHumanAnswers, 1);
  assert.equal(r.humanTotal, 0, "날짜를 모르니 분자 합계에는 안 더한다");
  assert.deepEqual(r.byKstDay, {}, "일별 칸 0");
  assert.deepEqual(r.humanEventIds, []);
  assert.deepEqual(core.permissionGapPieces(r), ["시각 불명 사람 답 1"]);
});

test("칸 시각 불명 + config(자동) = 0 -- 시각 불명 건수만", () => {
  const h = makeHome();
  sess(h, "s-und-auto", [
    { source: "config" },
    { source: "config", noTimestamp: true },
  ]);
  const r = collect(h);
  assert.equal(r.undated, 1);
  assert.equal(r.undatedHumanAnswers, 0);
  assert.deepEqual(core.permissionGapPieces(r), []);
});

test("칸 시각 불명 + 판정 칸 없음 = 지금처럼 시각 불명 건수만(하한 토막 아님)", () => {
  const h = makeHome();
  sess(h, "s-und-none", [{ source: "config" }, { noTimestamp: true }]);
  const r = collect(h);
  assert.equal(r.undated, 1);
  assert.equal(r.undatedHumanAnswers, 0);
});

test("칸 시각 불명 + 기계 종료 W · 모르는 값 U = 사람 답 계열이라 하한 토막(애매하면 ㄴ) · 같은 줄 uuid 중복은 1건", () => {
  const h = makeHome();
  sess(h, "s-und-wu", [
    { source: "config" },
    { source: "invalid_input", noTimestamp: true },
    { source: "brand_new_source_v9", noTimestamp: true },
    { source: "user_abort", noTimestamp: true, uuid: "dup-1", toolUseId: "t1" },
    { source: "user_abort", noTimestamp: true, uuid: "dup-1", toolUseId: "t1" },
  ]);
  const r = collect(h);
  assert.equal(r.undated, 4);
  assert.equal(
    r.undatedHumanAnswers,
    3,
    "W 1 + U 1 + 중복 제거한 user_abort 1",
  );
});

test("칸 시각 불명 + 사람 답 + 레인 밖 cwd = 하한 토막에서도 제외(레인 밖 제외 규칙 그대로)", () => {
  const h = makeHome();
  sess(h, "s-und-out", [{ source: "user_temporary", noTimestamp: true }], {
    root: "claude",
    cwd: h.elsewhere,
  });
  const r = collect(h);
  assert.equal(r.undatedHumanAnswers, 0);
});

// ======================================================================================
// ⑵-4 칸 -- 값의 범위(K + 새 칸 = 판정 없는 레인 안 결과 수) · 레인 밖 · KST 자정 경계 · 본문 0
// ======================================================================================

test("값 단언: K + 새 칸 = «판정 없는 레인 안 결과 수»(S 세션 제외) -- 레인 밖 오류 결과는 어느 칸에도 안 들어간다", () => {
  const h = makeHome();
  // 레인 안 · 비-S 세션 둘: 판정 없음 = 오류 참 3 + 오류 아님 2
  sess(h, "s-v1", [{ source: "config" }, { isError: true }, {}, {}]);
  sess(h, "s-v2", [{ isError: true }, { isError: true }], {
    root: "claude",
    cwd: h.main,
  });
  // 레인 밖 세션: 오류 참 4 + 오류 아님 1 -- 전부 제외
  sess(
    h,
    "s-v3-out",
    [
      { isError: true },
      { isError: true },
      { isError: true },
      { isError: true },
      {},
    ],
    { root: "claude", cwd: h.elsewhere },
  );
  const r = collect(h);
  assert.equal(r.errorEndedNoDecision, 3);
  assert.equal(r.undecided, 2);
  assert.equal(r.undecided + r.errorEndedNoDecision, 5);
  assert.equal(r.excluded.sessions, 1);
});

test("KST 자정 경계: 23:59:59 와 00:00:01 의 오류 결과는 같은 창(회차 −24h ~ 회차)에서 둘 다 센다 · 일별 사람 답 칸에는 안 들어간다", () => {
  const h = makeHome();
  putSession(h, {
    name: "s-midnight",
    lines: [
      resultLine({
        atMs: kst("2026-11-13 12:00:00"),
        cwd: h.harnessWt,
        sessionId: "s-midnight",
        source: "config",
      }),
      resultLine({
        atMs: kst("2026-11-13 23:59:59"),
        cwd: h.harnessWt,
        sessionId: "s-midnight",
        isError: true,
      }),
      resultLine({
        atMs: kst("2026-11-14 00:00:01"),
        cwd: h.harnessWt,
        sessionId: "s-midnight",
        isError: true,
      }),
    ],
  });
  const r = collect(h);
  assert.equal(r.errorEndedNoDecision, 2);
  assert.equal(r.undecided, 0);
  assert.deepEqual(r.byKstDay, {});
});

test("창 밖(24시간 이전) 오류 결과는 세지 않는다", () => {
  const h = makeHome();
  putSession(h, {
    name: "s-old-window",
    lines: [
      resultLine({
        atMs: AT,
        cwd: h.harnessWt,
        sessionId: "s-old-window",
        source: "config",
      }),
      resultLine({
        atMs: WINDOW_START - HOUR,
        cwd: h.harnessWt,
        sessionId: "s-old-window",
        isError: true,
      }),
    ],
  });
  const r = collect(h);
  assert.equal(r.errorEndedNoDecision, 0);
});

test("본문 0 읽음: 본문 글자에 is_error · 오류 모양이 있어도 «칸» 이 참이 아니면 오류로 안 센다 · 결과 어디에도 본문 표식 0", async () => {
  const h = makeHome();
  const lookalike = JSON.stringify({ is_error: true, text: BODY });
  sess(h, "s-body", [
    { source: "config" },
    { contentOverride: lookalike }, // 본문 안의 글자 -- 칸이 아니다
    { contentOverride: { is_error: true, text: BODY } }, // 본문 객체 안의 칸 -- 항목 칸이 아니다
    { isError: true, contentOverride: BODY }, // 진짜 칸
  ]);
  const r = collect(h);
  assert.equal(r.errorEndedNoDecision, 1);
  assert.equal(r.undecided, 2);
  const result = await runReal(h);
  assert.equal(JSON.stringify(r).includes("BODY-SENTINEL"), false);
  assert.equal(result.reportText.includes("BODY-SENTINEL"), false);
  assert.equal(
    JSON.stringify(result.dailyTick).includes("BODY-SENTINEL"),
    false,
  );
});

// ======================================================================================
// ⑵-5 보고 · 일별 줄 -- 실제 runPartialCountOnce 구동
// ======================================================================================

test("보고: 오류 참 판정 없음 -> «오류로 끝난 도구 결과 N(판정 없음 · 끊김 아님)» 따로 · ㄴ 분자 «이상» 안 켬 · 일별 칸 permissionErrorEnded N · K 0", async () => {
  const h = makeHome();
  sess(h, "s-rep", [
    { source: "user_temporary" },
    { isError: true },
    { isError: true },
  ]);
  const result = await runReal(h);
  assert.equal(
    lnLine(result.reportText),
    "확인 1건",
    "하한 토막 없음 = 이상 없음",
  );
  const line = permLine(result.reportText);
  assert.ok(line.includes(ERR_PIECE(2)), `B 줄에 새 칸 문면: ${line}`);
  assert.match(line, /판정 불가 0/);
  assert.match(
    result.reportText,
    /권한기록수집기 OK\(.*오류로 끝난 도구 결과 2\(판정 없음 · 끊김 아님\)/,
  );
  assert.equal(result.dailyTick.permissionErrorEnded, 2);
  assert.equal(result.dailyTick.permissionUndecidable, 0);
  assert.equal(result.dailyTick.permissionHumanAnswers, 1);
});

test("보고: 오류 아닌 판정 없음만 K -- «판정 불가 1» · 일별 permissionUndecidable 1 · 새 칸 0 이면 문면 생략(0 이면 안 적는 보조 칸)", async () => {
  const h = makeHome();
  sess(h, "s-rep2", [{ source: "config" }, {}]);
  const result = await runReal(h);
  assert.equal(lnLine(result.reportText), "확인 0건 이상 · 판정 불가 1");
  assert.equal(permLine(result.reportText).includes("오류로 끝난"), false);
  assert.equal(result.dailyTick.permissionUndecidable, 1);
  assert.equal(result.dailyTick.permissionErrorEnded, 0);
});

test("보고: 시각 불명 사람 답 -> ㄴ 분자 «이상 · 시각 불명 사람 답 1» · B 줄 · 수집기 진단 줄 · 일별 칸 불변", async () => {
  const h = makeHome();
  sess(h, "s-rep3", [
    { source: "config" },
    { source: "user_temporary", noTimestamp: true },
  ]);
  const result = await runReal(h);
  assert.equal(
    lnLine(result.reportText),
    "확인 0건 이상 · 시각 불명 사람 답 1",
  );
  assert.ok(permLine(result.reportText).includes("시각 불명 사람 답 1"));
  assert.match(result.reportText, /권한기록수집기 OK\(.*시각 불명 사람 답 1/);
  assert.equal(result.dailyTick.permissionHumanAnswers, 0);
  assert.equal(result.dailyTick.permissionUndecidable, 0);
  assert.equal(Object.hasOwn(result.dailyTick, "undatedHumanAnswers"), false);
});

test("보고: 수집 실패 = permissionErrorEnded null(0 아님) · 미결선(--outbox-dir 없음) = 새 칸을 싣지 않음", async () => {
  const h = makeHome();
  sess(h, "s-rep4", [{ isError: true }]);
  const noOutbox = await runReal(h, { outboxDir: undefined });
  assert.equal(
    Object.hasOwn(noOutbox.dailyTick, "permissionErrorEnded"),
    false,
  );
  fs.rmSync(join(h.home, ".claude"), { recursive: true, force: true });
  const failed = await runReal(h);
  assert.equal(failed.dailyTick.permissionErrorEnded, null);
  assert.equal(failed.dailyTick.permissionUndecidable, null);
});

// ---- 일별 줄 -----------------------------------------------------------------------------

const DAY_ZERO = Object.freeze({
  lnConfirmed: 0,
  lnUnchecked: 0,
  collectorFails: [],
  delivered: 3,
  uncountedExampleIds: ["V3-1"],
  uncountedVersion: "uncounted-examples/v3",
});

function dailyLineFor(day, overrides = {}) {
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
    uncountedRanges: ["U1"],
    ...overrides,
  };
}

test("일별: permissionErrorEnded 가 회차 값 -> 상태 -> 마감 줄에 실리고 «기존 칸»(사람 답 · K) 값은 그대로다", () => {
  const state = core.recordDailyTick({
    state: null,
    nowMs: kst("2026-11-13 23:50"),
    tick: {
      ...DAY_ZERO,
      permissionHumanAnswers: 3,
      permissionUndecidable: 1,
      permissionErrorEnded: 7,
    },
  });
  assert.equal(state.permissionErrorEnded, 7);
  const next = core.rolloverDailyState({
    state,
    nowMs: kst("2026-11-14 00:05"),
    closedDays: new Set(),
  });
  assert.equal(next.closedLine.permissionErrorEnded, 7);
  assert.equal(next.closedLine.permissionHumanAnswers, 3);
  assert.equal(next.closedLine.permissionUndecidable, 1);
});

test("일별: 칸 모양이 틀리면 null · 새 칸 없는 회차는 칸을 싣지 않고 앞 회차 값도 지운다(마지막 회차 값 규칙)", () => {
  const bad = core.normalizeDailyTick({
    ...DAY_ZERO,
    permissionErrorEnded: "7",
  });
  assert.equal(bad.permissionErrorEnded, null);
  const neg = core.normalizeDailyTick({
    ...DAY_ZERO,
    permissionErrorEnded: -1,
  });
  assert.equal(neg.permissionErrorEnded, null);
  const day = kst("2026-11-13 09:00");
  const withCol = core.recordDailyTick({
    state: null,
    nowMs: day,
    tick: { ...DAY_ZERO, permissionErrorEnded: 2 },
  });
  const without = core.recordDailyTick({
    state: withCol,
    nowMs: day + 15 * 60 * 1000,
    tick: DAY_ZERO,
  });
  assert.equal(Object.hasOwn(without, "permissionErrorEnded"), false);
});

test("연속 확인-0: permissionErrorEnded 는 끊김 사유가 아니다 -- 값 > 0 · null · 칸 없는 옛 줄 모두 이어진다(감사 칸)", () => {
  const nowMs = kst("2026-11-14 09:00");
  const base = { permissionHumanAnswers: 0, permissionUndecidable: 0 };
  const lines = [
    dailyLineFor("2026-11-13", { ...base, permissionErrorEnded: 9 }),
    dailyLineFor("2026-11-12", { ...base, permissionErrorEnded: null }),
    dailyLineFor("2026-11-11", base), // 옛 줄 -- 새 칸 없음
  ];
  const s = core.computeConfirmedZeroStreak({ lines, nowMs });
  assert.equal(s.days, 3);
  assert.equal(s.lastBreak.reasons[0], "줄 없음");
});

test("연속 확인-0: 오류 아닌 판정 없음 K > 0 인 날은 여전히 끊긴다 · 오류 참뿐인 날은 안 끊긴다(두 줄의 대비)", () => {
  const nowMs = kst("2026-11-14 09:00");
  const k = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [
      dailyLineFor("2026-11-13", {
        permissionHumanAnswers: 0,
        permissionUndecidable: 2,
        permissionErrorEnded: 0,
      }),
    ],
  });
  assert.equal(k.days, 0);
  assert.deepEqual(k.lastBreak.reasons, ["권한 판정 불가 2"]);
  const e = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [
      dailyLineFor("2026-11-13", {
        permissionHumanAnswers: 0,
        permissionUndecidable: 0,
        permissionErrorEnded: 5,
      }),
    ],
  });
  assert.equal(e.days, 1);
});

test("종단: 오류 참 판정 없음뿐인 날 = 실제 보고 회차 값으로 만든 일별 줄이 끊기지 않는다 · K 가 있는 날은 끊긴다", async () => {
  const hErr = makeHome();
  sess(hErr, "s-e2e", [
    { source: "config" },
    { isError: true },
    { isError: true },
  ]);
  const okRun = await runReal(hErr);
  const okLine = dailyLineFor("2026-11-13", {
    // 이 시험은 권한기록수집기만 본다 -- 가짜 fetch 404 로 실패하는 다른 수집기 이름은 걸러낸다(기존 권한 시험과 같은 방식).
    collectorFails: okRun.dailyTick.collectorFails.filter(
      (n) => n === "권한기록수집기",
    ),
    permissionHumanAnswers: okRun.dailyTick.permissionHumanAnswers,
    permissionUndecidable: okRun.dailyTick.permissionUndecidable,
    permissionErrorEnded: okRun.dailyTick.permissionErrorEnded,
  });
  const nowMs = kst("2026-11-14 09:00");
  assert.equal(
    core.computeConfirmedZeroStreak({ lines: [okLine], nowMs }).days,
    1,
  );

  const hK = makeHome();
  sess(hK, "s-e2e-k", [{ source: "config" }, {}]);
  const kRun = await runReal(hK);
  const kLine = dailyLineFor("2026-11-13", {
    collectorFails: kRun.dailyTick.collectorFails.filter(
      (n) => n === "권한기록수집기",
    ),
    permissionHumanAnswers: kRun.dailyTick.permissionHumanAnswers,
    permissionUndecidable: kRun.dailyTick.permissionUndecidable,
    permissionErrorEnded: kRun.dailyTick.permissionErrorEnded,
  });
  const brk = core.computeConfirmedZeroStreak({ lines: [kLine], nowMs });
  assert.equal(brk.days, 0);
  assert.deepEqual(brk.lastBreak.reasons, ["권한 판정 불가 1"]);
});

// ---- 순수 렌더 -----------------------------------------------------------------------------

test("렌더: 새 칸 · 시각 불명 사람 답 문면 -- 0 이면 안 적고 > 0 이면 B 줄 · 진단 줄 · 하한 토막에 정해진 문면으로 나온다", () => {
  const p = {
    known: true,
    humanTotal: 1,
    human: 1,
    undecided: 0,
    fieldMissingSessions: 0,
    errorEndedNoDecision: 0,
    undatedHumanAnswers: 0,
    interpreterAnswers: 0,
    sdkAnswers: 0,
    excluded: { sessions: 0, human: 0 },
    bySeat: {},
    auto: 0,
  };
  assert.equal(
    core.renderPermissionAnswersLine(p).includes("오류로 끝난"),
    false,
  );
  assert.equal(
    core.renderPermissionAnswersLine(p).includes("시각 불명 사람 답"),
    false,
  );
  assert.deepEqual(core.permissionGapPieces(p), []);
  const q = { ...p, errorEndedNoDecision: 4, undatedHumanAnswers: 2 };
  assert.ok(core.renderPermissionAnswersLine(q).includes(ERR_PIECE(4)));
  assert.ok(
    core.renderPermissionAnswersLine(q).includes("시각 불명 사람 답 2"),
  );
  assert.ok(core.renderPermissionCollectorDetail(q).includes(ERR_PIECE(4)));
  assert.deepEqual(core.permissionGapPieces(q), ["시각 불명 사람 답 2"]);
});
