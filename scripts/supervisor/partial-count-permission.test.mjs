// HYK-255-p5a-perm-1 (coder-task.md §2 ⓒ) -- 권한 확인창 답 수집기(ㄴ 유형 4) 시험.
//
// ⛔헛시험 금지: 프로덕션 export 를 직접 구동한다 -- collectPermissionAnswers(수집기) · runPartialCountOnce(실제 보고
// 조립) · partial-count-core 의 순수 함수. 사본 import 0. 합성 홈(mkdtemp) 아래 합성 세션 jsonl · 주입 시계(now) · 가짜
// fetchJson -- 실제 네트워크 · 실물 세션 기록 · 관제실 · 받는함 쓰기 0. 합성 jsonl 의 대화 본문 칸은 전부 검출용 표식
// 문자열(BODY-SENTINEL)이거나 «<본문 생략>» 자리표다(실제 대화 본문 0).
// 코어 함수는 `core.<이름>` 네임스페이스로 부른다(없으면 칸 하나씩 TypeError 로 RED -- 링크 오류 하나로 뭉개지 않는다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import { runPartialCountStep } from "./watch-run.mjs";

const HOUR = 60 * 60 * 1000;
// "2026-11-13 15:34:29" (KST) -> epoch ms. 초 없는 "2026-11-14 10:00" 도 받는다.
const kst = (s) =>
  Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+09:00`);
const NOW = kst("2026-11-14 10:00:00");
const WINDOW_START = NOW - 24 * HOUR;
const BODY = "BODY-SENTINEL-대화본문-표식";

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
const nextId = () => `id${(seq += 1)}`;

// user · tool_result 줄(판정 칸 포함/없음). 본문 칸(content · toolUseResult)에는 표식을 넣는다 -- 결과에 새면 잡힌다.
function decisionLine({
  atMs,
  cwd,
  sessionId = "sess-1",
  uuid,
  toolUseId = nextId(),
  decision = "accept",
  source,
  rawDecision,
  version = "2.1.322",
  entrypoint = "cli",
  type = "user",
}) {
  const pd =
    rawDecision !== undefined
      ? { permissionDecision: rawDecision }
      : source === undefined
        ? {}
        : { permissionDecision: { decision, source } };
  return JSON.stringify({
    type,
    uuid: uuid ?? `u-${toolUseId}`,
    timestamp: new Date(atMs).toISOString(),
    cwd,
    sessionId,
    version,
    entrypoint,
    permissionMode: "default",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: BODY }],
    },
    toolUseResult: BODY,
    ...pd,
  });
}

function toolUseLine({ atMs, cwd, sessionId = "sess-1", toolUseId, name }) {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${toolUseId}`,
    timestamp: new Date(atMs).toISOString(),
    cwd,
    sessionId,
    version: "2.1.322",
    entrypoint: "cli",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: BODY },
        { type: "tool_use", id: toolUseId, name, input: { command: BODY } },
      ],
    },
  });
}

// 합성 홈 -- 두 뿌리 + 통역 폴더(보내는함의 부모) + 좌석 경로들.
function makeHome() {
  const home = tmpDir("nc-perm-home-");
  const interpreter = join(home, "통역-합성");
  fs.mkdirSync(join(interpreter, "보내는함"), { recursive: true });
  const h = {
    home,
    interpreter,
    outboxDir: join(interpreter, "보내는함"),
    main: join(home, "Documents", "HARNESSENGINEERING"),
    harnessWt: join(home, "orca", "workspaces", "HARNESSENGINEERING", "wt-1"),
    otherWt: join(home, "orca", "workspaces", "AL06TEAM10", "wt-9"),
    elsewhere: join(home, "개인-문서"),
  };
  for (const r of [".claude", ".claude-team"]) {
    fs.mkdirSync(join(home, r, "projects", "p1"), { recursive: true });
  }
  return h;
}

// 세션 파일 1개 쓰기. root = "claude" | "claude-team".
function putSession(h, { root, name, lines, sub, mtimeMs }) {
  const dir = join(
    h.home,
    root === "claude" ? ".claude" : ".claude-team",
    "projects",
    "p1",
    ...(sub ? [sub] : []),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  if (mtimeMs !== undefined) {
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  }
  return file;
}

function collect(h, extra = {}) {
  return report.collectPermissionAnswers({
    homeDir: h.home,
    interpreterRoot: h.interpreter,
    windowStartMs: WINDOW_START,
    windowEndMs: NOW,
    ...extra,
  });
}

// 판정 1건을 자기 세션 1개로 심는다 -- 칸별 시험용.
function putOne(h, { root = "claude-team", cwd, source, ...rest }, n = 1) {
  const sessionId = rest.sessionId ?? nextId();
  putSession(h, {
    root,
    name: sessionId,
    lines: Array.from({ length: n }, (_, i) =>
      decisionLine({
        atMs: kst("2026-11-13 12:00:00") + i * 1000,
        cwd: cwd === undefined ? h.harnessWt : cwd,
        sessionId,
        source,
        ...rest,
      }),
    ),
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
  const repo = tmpDir("nc-perm-repo-");
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
  // HYK-255-p3-gh-1 -- P3(GitHub 사람 손 수집기)는 이 시험의 관심 밖이다. 봇 목록 파일을 둬서 P3 가 «수집 실패» 로 ㄴ 분자
  // 표기(하한 토막)를 바꾸지 않게 하고, 아래 runReal 의 사건 목록 호출은 빈 목록(사람 손 0)으로 받는다.
  fs.writeFileSync(
    join(repo, "scripts", "supervisor", "github-bot-accounts.json"),
    JSON.stringify({
      schema_version: "github-bot-accounts/v1",
      bots: [{ login: "bot-fixture-a" }],
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

async function runReal(options) {
  const root = tmpDir("nc-perm-run-");
  const repo = repoOnce();
  return report.runPartialCountOnce({
    now: NOW,
    repoRoot: repo,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson: async ({ url }) =>
      /\/events\?per_page=/.test(url)
        ? { ok: true, status: 200, json: [], linkHeader: null }
        : { ok: false, status: 404, json: null, linkHeader: null },
    git: report.createProcessGitPort(repo),
    gitWorktreeListExecFn: () => "",
    ...options,
  });
}

const lnLine = (text) =>
  /^- 외부 독립 증거로 확인된 사건: (.*)$/m.exec(text)?.[1];
const permLine = (text) =>
  /^- 권한 확인창 사람 답\(B · 세션 기록\): (.*)$/m.exec(text)?.[1];

// ======================================================================================
// ⑴ 칸 -- 판정 값 분류(합성 jsonl -> 수집기)
// ======================================================================================

test("칸 config · classifier · hook = 자동 -> 사람 답 0 · 자동 3 (워커 bypass 모양도 0)", () => {
  const h = makeHome();
  for (const source of ["config", "classifier", "hook"]) {
    putOne(h, { source, permissionMode: "bypassPermissions" });
  }
  const r = collect(h);
  assert.equal(r.known, true);
  assert.equal(r.humanTotal, 0);
  assert.equal(r.auto, 3);
  assert.equal(r.undecided, 0);
});

test("칸 user_temporary · user_permanent · user_reject · user_abort = 사람 답(분자) 각 1", () => {
  const h = makeHome();
  for (const source of [
    "user_temporary",
    "user_permanent",
    "user_reject",
    "user_abort",
  ]) {
    putOne(h, { source });
  }
  const r = collect(h);
  assert.equal(r.human, 4);
  assert.equal(r.humanTotal, 4);
  assert.equal(r.auto, 0);
});

test("칸 기계 종료 W 3값(invalid_input · permission_updated_input_invalid · server_fallback_tombstone) = 분자", () => {
  const h = makeHome();
  for (const source of [
    "invalid_input",
    "permission_updated_input_invalid",
    "server_fallback_tombstone",
  ]) {
    putOne(h, { source });
  }
  const r = collect(h);
  assert.equal(r.machineEnd, 3);
  assert.equal(r.humanTotal, 3);
});

test("칸 모르는 source · source 없음 · 모르는 decision · 문자열 아닌 판정 = 모르는 값 U = 분자", () => {
  const h = makeHome();
  putOne(h, { source: "brand_new_source_v9" });
  putOne(h, { rawDecision: { decision: "accept" } }); // source 없음
  putOne(h, { source: "config", decision: "maybe" }); // decision 목록 밖
  putOne(h, { rawDecision: "not-an-object" }); // 판정 칸이 객체가 아님
  putOne(h, { source: 42 }); // source 가 문자열 아님
  const r = collect(h);
  assert.equal(r.unknownValue, 5);
  assert.equal(r.humanTotal, 5);
  assert.equal(r.auto, 0);
});

test("칸 판정 없음 = 판정 불가 K(하한) -- 같은 세션에 판정 줄이 있으면 K 로 센다(자동으로 접지 않는다)", () => {
  const h = makeHome();
  const sessionId = "s-k";
  const at = kst("2026-11-13 12:00:00");
  putSession(h, {
    root: "claude-team",
    name: sessionId,
    lines: [
      decisionLine({ atMs: at, cwd: h.harnessWt, sessionId, source: "config" }),
      decisionLine({ atMs: at + 1, cwd: h.harnessWt, sessionId }), // 판정 칸 없음
      decisionLine({ atMs: at + 2, cwd: h.harnessWt, sessionId }),
    ],
  });
  const r = collect(h);
  assert.equal(r.undecided, 2);
  assert.equal(r.fieldMissingSessions, 0);
  assert.equal(r.humanTotal, 0);
  assert.deepEqual(core.permissionGapPieces(r), ["판정 불가 2"]);
});

test("칸 2.1.322 미만 판 줄이 섞인 세션 = 필드 없는 세션 S(수집 실패) · K 로 접지 않는다", () => {
  const h = makeHome();
  const sessionId = "s-old";
  const at = kst("2026-11-13 12:00:00");
  putSession(h, {
    root: "claude-team",
    name: sessionId,
    lines: [
      decisionLine({ atMs: at, cwd: h.harnessWt, sessionId, source: "config" }),
      decisionLine({
        atMs: at + 1,
        cwd: h.harnessWt,
        sessionId,
        version: "2.1.300", // 판정 칸이 없던 판
      }),
    ],
  });
  const r = collect(h);
  assert.equal(r.fieldMissingSessions, 1);
  assert.equal(r.undecided, 0, "구판 줄은 하한 K 가 아니라 측정 불가");
  assert.equal(r.auto, 1);
  assert.deepEqual(core.permissionGapPieces(r), ["권한기록 필드 없는 세션 1"]);
});

test("칸 판정 줄이 한 줄도 없는 세션(구판) = S · 수집기 목록에서 FAIL", async () => {
  const h = makeHome();
  putOne(h, { version: "2.1.100" }, 2); // 판정 칸 없는 구판 세션
  const r = collect(h);
  assert.equal(r.fieldMissingSessions, 1);
  assert.equal(r.undecided, 0);
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  assert.match(result.reportText, /권한기록수집기 FAIL\(/);
  assert.ok(result.dailyTick.collectorFails.includes("권한기록수집기"));
});

test("칸 SDK entrypoint 세션 = 분자 + «SDK j건» 별도 표기", () => {
  const h = makeHome();
  putOne(h, { source: "user_temporary", entrypoint: "sdk-ts" });
  putOne(h, { source: "user_temporary", entrypoint: "cli" });
  const r = collect(h);
  assert.equal(r.humanTotal, 2);
  assert.equal(r.sdkAnswers, 1);
});

test("칸 통역 cwd = 분자 + 통역 칸 · 통역 하위 폴더(보내는함 SDK 세션)도 통역", () => {
  const h = makeHome();
  putOne(h, { root: "claude", cwd: h.interpreter, source: "user_temporary" });
  putOne(h, {
    root: "claude",
    cwd: join(h.interpreter, "보내는함"),
    source: "user_reject",
    entrypoint: "sdk-ts",
  });
  const r = collect(h);
  assert.equal(r.humanTotal, 2);
  assert.equal(r.interpreterAnswers, 2);
  assert.equal(r.bySeat["통역"].human, 2);
  assert.equal(r.excluded.sessions, 0);
});

test("칸 레인 밖 cwd(.claude 의 그 밖) = 분자 제외 · 건수만 «제외 X(사람 답 y)»", () => {
  const h = makeHome();
  putOne(h, { root: "claude", cwd: h.elsewhere, source: "user_permanent" });
  putOne(h, { root: "claude", cwd: h.elsewhere, source: "config" });
  const r = collect(h);
  assert.equal(r.humanTotal, 0, "레인 밖 사람 답은 분자가 아니다");
  assert.equal(r.auto, 0, "레인 밖 자동도 자동 건수에 안 섞인다");
  assert.deepEqual(r.excluded, { sessions: 2, human: 1 });
});

test("칸 좌석 종류: ORCH(.claude · 본체 경로) · 워커본체(.claude-team · 본체 경로) · 워커H · 워커E · 미분류 · cwd 없음 = 미분류(제외 아님)", () => {
  const h = makeHome();
  putOne(h, { root: "claude", cwd: h.main, source: "user_temporary" });
  putOne(h, { root: "claude-team", cwd: h.main, source: "user_temporary" });
  putOne(h, {
    root: "claude-team",
    cwd: h.harnessWt,
    source: "user_temporary",
  });
  putOne(h, { root: "claude-team", cwd: h.otherWt, source: "user_temporary" });
  putOne(h, {
    root: "claude-team",
    cwd: h.elsewhere,
    source: "user_temporary",
  });
  putOne(h, { root: "claude", cwd: null, source: "user_temporary" }); // cwd 칸 없음
  const r = collect(h);
  assert.equal(r.humanTotal, 6, "레인 밖이 하나도 없다");
  assert.equal(r.bySeat["ORCH"].human, 1);
  assert.equal(r.bySeat["워커본체"].human, 1);
  assert.equal(r.bySeat["워커H"].human, 1);
  assert.equal(r.bySeat["워커E"].human, 1);
  assert.equal(r.bySeat["미분류"].human, 2);
  assert.equal(r.excluded.sessions, 0);
});

test("칸 KST 자정 경계: 23:59:59 와 00:00:01 은 다른 KST 날 · UTC 날짜로 가르면 같은 날(UTC 자정은 KST 09:00)", () => {
  const h = makeHome();
  const sessionId = "s-mid";
  const sess = (atMs) =>
    decisionLine({
      atMs,
      cwd: h.harnessWt,
      sessionId,
      source: "user_temporary",
    });
  putSession(h, {
    root: "claude-team",
    name: sessionId,
    lines: [
      sess(kst("2026-11-13 23:59:59")),
      sess(kst("2026-11-14 00:00:01")),
      sess(kst("2026-11-13 08:59:59")), // UTC 로는 11-12 23:59:59 -- KST 는 11-13
      sess(kst("2026-11-13 09:00:01")), // UTC 로는 11-13 00:00:01
    ],
  });
  const r = collect(h, { windowStartMs: kst("2026-11-13 00:00:00") });
  assert.equal(r.humanTotal, 4);
  assert.deepEqual(r.byKstDay, { "2026-11-13": 3, "2026-11-14": 1 });
});

test("칸 창 밖 = 0: 창 시작 직전 · 창 끝 직후 줄은 안 센다 · 경계(시작 · 끝 정각)는 센다", () => {
  const h = makeHome();
  const sessionId = "s-win";
  const sess = (atMs) =>
    decisionLine({
      atMs,
      cwd: h.harnessWt,
      sessionId,
      source: "user_temporary",
    });
  putSession(h, {
    root: "claude-team",
    name: sessionId,
    lines: [
      sess(WINDOW_START - 1),
      sess(WINDOW_START),
      sess(NOW),
      sess(NOW + 1),
    ],
  });
  const r = collect(h);
  assert.equal(r.humanTotal, 2);
});

test("칸 mtime 이 창 시작보다 오래된 파일은 읽지 않는다 · 하위 subagents 폴더는 읽는다", () => {
  const h = makeHome();
  const line = (sessionId) =>
    decisionLine({
      atMs: kst("2026-11-13 12:00:00"),
      cwd: h.harnessWt,
      sessionId,
      source: "user_temporary",
    });
  putSession(h, {
    root: "claude-team",
    name: "old",
    lines: [line("s-old-file")],
    mtimeMs: WINDOW_START - HOUR,
  });
  putSession(h, {
    root: "claude-team",
    name: "agent-1",
    sub: "subagents",
    lines: [line("s-sub")],
  });
  const r = collect(h);
  assert.equal(r.filesScanned, 1, "오래된 파일은 목록에서 빠진다");
  assert.equal(r.humanTotal, 1);
});

test("칸 두 뿌리(.claude · .claude-team) 둘 다 읽는다 · 이어받기로 같은 uuid 줄이 두 파일에 있으면 한 건", () => {
  const h = makeHome();
  const dup = decisionLine({
    atMs: kst("2026-11-13 12:00:00"),
    cwd: h.harnessWt,
    sessionId: "s-r",
    uuid: "same-uuid",
    toolUseId: "tu-same",
    source: "user_temporary",
  });
  putSession(h, { root: "claude", name: "a", lines: [dup] });
  putSession(h, { root: "claude-team", name: "b", lines: [dup] });
  const r = collect(h);
  assert.equal(r.filesScanned, 2);
  assert.equal(r.humanTotal, 1, "같은 줄 uuid 는 한 건");
  assert.equal(r.duplicates, 1);
});

test("칸 시각 불명 줄 · 깨진 줄은 조용히 접지 않고 값으로 남는다", () => {
  const h = makeHome();
  const sessionId = "s-bad";
  putSession(h, {
    root: "claude-team",
    name: sessionId,
    lines: [
      decisionLine({
        atMs: NOW - HOUR,
        cwd: h.harnessWt,
        sessionId,
        source: "config",
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        cwd: h.harnessWt,
        message: { content: [{ type: "tool_result", tool_use_id: "x" }] },
        permissionDecision: { decision: "accept", source: "user_temporary" },
      }), // timestamp 칸 없음
      '{"permissionDecision": {"decision":"accept"', // 깨진 줄(쓰는 도중 잘림)
    ],
  });
  const r = collect(h);
  assert.equal(r.undated, 1);
  assert.equal(r.parseFailures, 1);
  assert.match(core.renderPermissionCollectorDetail(r), /시각 불명 1줄/);
  assert.match(core.renderPermissionCollectorDetail(r), /줄 파싱 실패 1줄/);
});

test("칸 뿌리를 못 읽으면 수집 실패(known:false) -- 0 으로 접지 않는다", () => {
  const h = makeHome();
  fs.rmSync(join(h.home, ".claude-team"), { recursive: true, force: true });
  const r = collect(h);
  assert.equal(r.known, false);
  assert.match(r.reason, /세션 뿌리 읽기 실패\(team: /);
  assert.deepEqual(core.permissionGapPieces(r), ["권한기록 수집 실패"]);
  assert.equal(core.permissionHumanTotal(r), 0);
});

test("칸 파일 읽기 실패는 readFailures 로 남고 그 칸은 수집 실패(FAIL)", () => {
  const h = makeHome();
  putOne(h, { source: "user_temporary" });
  const r = collect(h, {
    readFn: () => {
      throw new Error("synthetic read failure");
    },
  });
  assert.equal(r.known, true);
  assert.equal(r.readFailures, 1);
  assert.deepEqual(core.permissionGapPieces(r), ["권한기록 읽기 실패 1파일"]);
});

// ======================================================================================
// ⑵ 본문 0 · 회차 사이 상태 0 · 도구 이름
// ======================================================================================

test("본문 0: 합성 줄의 본문 표식은 수집 결과 · 보고문 · 일별 회차 값 어디에도 없다", async () => {
  const h = makeHome();
  const at = kst("2026-11-13 15:34:29");
  const sessionId = "s-body";
  putSession(h, {
    root: "claude",
    name: sessionId,
    lines: [
      toolUseLine({
        atMs: at - 1000,
        cwd: h.interpreter,
        sessionId,
        toolUseId: "tu-body",
        name: "PowerShell",
      }),
      decisionLine({
        atMs: at,
        cwd: h.interpreter,
        sessionId,
        toolUseId: "tu-body",
        source: "user_temporary",
      }),
    ],
  });
  const r = collect(h);
  assert.equal(r.humanTotal, 1);
  assert.equal(JSON.stringify(r).includes("BODY-SENTINEL"), false, "수집 결과");
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  assert.equal(result.reportText.includes("BODY-SENTINEL"), false, "보고문");
  assert.equal(
    JSON.stringify(result.dailyTick).includes("BODY-SENTINEL"),
    false,
    "일별 회차 값",
  );
});

test("도구 이름: 사람 답의 tool_use_id 로 같은 파일 앞쪽 tool_use 의 name 만 읽는다 · 이름 모양이 아니면 «(형식 밖)»", () => {
  const h = makeHome();
  const sessionId = "s-tool";
  const at = kst("2026-11-13 15:34:29");
  putSession(h, {
    root: "claude",
    name: sessionId,
    lines: [
      toolUseLine({
        atMs: at - 2000,
        cwd: h.interpreter,
        sessionId,
        toolUseId: "tu-a",
        name: "PowerShell",
      }),
      decisionLine({
        atMs: at,
        cwd: h.interpreter,
        sessionId,
        toolUseId: "tu-a",
        source: "user_temporary",
      }),
      toolUseLine({
        atMs: at + 1000,
        cwd: h.interpreter,
        sessionId,
        toolUseId: "tu-b",
        name: "이 도구 이름은 문장처럼 길고 공백이 있다 BODY",
      }),
      decisionLine({
        atMs: at + 2000,
        cwd: h.interpreter,
        sessionId,
        toolUseId: "tu-b",
        source: "user_reject",
      }),
    ],
  });
  const r = collect(h);
  assert.deepEqual(
    r.humanEvents.map((e) => [formatKstSec(e.atMs), e.toolName, e.source]),
    [
      ["2026-11-13 15:34:29 KST", "PowerShell", "user_temporary"],
      ["2026-11-13 15:34:31 KST", "(형식 밖)", "user_reject"],
    ],
  );
  assert.match(
    core.renderPermissionCollectorDetail(r),
    /2026-11-13 15:34:29 KST PowerShell\(통역 · user_temporary\)/,
  );
});

const formatKstSec = (ms) => core.formatKst(ms);

test("회차 사이 상태 0: 같은 입력 두 번 = 같은 값 · 파일을 지우면 다음 회차는 0 · 수집기는 어떤 파일도 만들지 않는다", () => {
  const h = makeHome();
  const file = putSession(h, {
    root: "claude-team",
    name: "s-state",
    lines: [
      decisionLine({
        atMs: kst("2026-11-13 12:00:00"),
        cwd: h.harnessWt,
        sessionId: "s-state",
        source: "user_temporary",
      }),
    ],
  });
  const listing = () =>
    fs.readdirSync(h.home, { recursive: true }).map(String).sort().join("|");
  const before = listing();
  const first = collect(h);
  const second = collect(h);
  assert.deepEqual(second, first);
  assert.equal(listing(), before, "수집기가 홈 아래 파일을 만들지 않았다");
  fs.rmSync(file);
  assert.equal(collect(h).humanTotal, 0, "캐시가 있었다면 1 이 남는다");
});

// ======================================================================================
// ⑶ 보고 · 일별 줄 -- 실제 runPartialCountOnce 구동
// ======================================================================================

// 설계 «칸 표» 한 판 -- 좌석 6종 · 자동 · 판정 불가 · SDK · 레인 밖이 한 창에 모두 있다.
function seedFullScenario(h) {
  const at = kst("2026-11-13 15:34:29");
  const sess = (root, name, cwd, parts) =>
    putSession(h, {
      root,
      name,
      lines: parts.map((p, i) =>
        decisionLine({ atMs: at + i * 1000, cwd, sessionId: name, ...p }),
      ),
    });
  sess("claude", "s-tong", h.interpreter, [
    { source: "user_temporary" },
    { source: "config" },
  ]);
  sess("claude", "s-orch", h.main, [
    { source: "user_reject" },
    { source: "config" },
    { source: "config" },
  ]);
  sess("claude-team", "s-wh", h.harnessWt, [
    { source: "invalid_input" },
    { source: "config" },
    { source: "config" },
    { source: "config" },
    {}, // 판정 칸 없음 -> K
  ]);
  sess("claude-team", "s-we", h.otherWt, [
    { source: "weird_value_v9", entrypoint: "sdk-ts" },
  ]);
  sess("claude-team", "s-un", h.elsewhere, [{ source: "config" }]);
  sess("claude", "s-out", h.elsewhere, [
    { source: "user_permanent" },
    { source: "config" },
  ]);
}

test("보고: 칸 표 한 판 -> ㄴ 분자 «확인 4건 이상 · 판정 불가 1» · 사람 답 줄(통역 · SDK · 판정 불가 · 레인 밖 제외) · 수집기 진단 줄", async () => {
  const h = makeHome();
  seedFullScenario(h);
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  assert.equal(lnLine(result.reportText), "확인 4건 이상 · 판정 불가 1");
  assert.equal(
    permLine(result.reportText),
    "확인 4건 이상(통역 1 · SDK 1 · 판정 불가 1 · 레인 밖 제외 1(사람 답 1)) · ORCH 1 · 워커 2 · 미분류 0 · 자동 7 — ㄴ 확인 건수에 포함 · 세션 기록 한정(다른 엔진 좌석 미포함)",
  );
  assert.match(
    result.reportText,
    /권한기록수집기 OK\(세션 5 · 파일 6 · 사람 답 4\(사용자 2 · 기계 종료 1 · 모르는 값 1\) · 자동 7 · 판정 불가 1 · KST 일별 사람 답 2026-11-13 4 · 사람 답 시각·도구 2026-11-13 15:34:29 KST/,
  );
  assert.equal(result.dailyTick.permissionHumanAnswers, 4);
  assert.equal(result.dailyTick.permissionUndecidable, 1);
  assert.equal(
    result.dailyTick.lnConfirmed,
    0,
    "기존 칸 lnConfirmed 의미 무변 = D1 확인분만",
  );
});

test("보고: 사람 답 0 · 판정 불가 0 이면 «확인 0건» (bare «0건» 금지) · 일별 칸 0 · 0", async () => {
  const h = makeHome();
  putOne(h, { source: "config" }, 3);
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  assert.equal(lnLine(result.reportText), "확인 0건");
  assert.match(
    permLine(result.reportText),
    /^확인 0건\(통역 0 · SDK 0 · 판정 불가 0 · 레인 밖 제외 0\(사람 답 0\)\)/,
  );
  assert.equal(result.dailyTick.permissionHumanAnswers, 0);
  assert.equal(result.dailyTick.permissionUndecidable, 0);
});

test("보고: 수집 실패(뿌리 없음) = 분자에 안 더하고 «수집 실패(사유)» · 하한 토막 · 일별 칸 null 2개(0 아님)", async () => {
  const h = makeHome();
  fs.rmSync(join(h.home, ".claude"), { recursive: true, force: true });
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  assert.equal(lnLine(result.reportText), "확인 0건 이상 · 권한기록 수집 실패");
  assert.match(
    permLine(result.reportText),
    /^수집 실패\(세션 뿌리 읽기 실패\(home: /,
  );
  assert.equal(result.dailyTick.permissionHumanAnswers, null);
  assert.equal(result.dailyTick.permissionUndecidable, null);
  assert.ok(result.dailyTick.collectorFails.includes("권한기록수집기"));
});

test("보고: 미결선(--outbox-dir 없음) = 사람 답 줄 0 · 수집기 줄 0 · 일별 새 칸 «싣지 않음» · 분자 옛 문면", async () => {
  const h = makeHome();
  putOne(h, { source: "user_temporary" });
  const result = await runReal({ sessionHomeDir: h.home });
  assert.equal(permLine(result.reportText), undefined);
  assert.doesNotMatch(result.reportText, /권한기록수집기/);
  assert.equal(lnLine(result.reportText), "확인 0건");
  assert.equal(
    Object.hasOwn(result.dailyTick, "permissionHumanAnswers"),
    false,
  );
  assert.equal(Object.hasOwn(result.dailyTick, "permissionUndecidable"), false);
});

test("보고: ㄴ 분자는 D1 확인분과 «더해진다» -- 사람 답 2 + 판정 불가 0 -> 확인 2건", async () => {
  const h = makeHome();
  putOne(h, { source: "user_temporary" });
  putOne(h, { source: "user_abort", root: "claude", cwd: h.main });
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  assert.equal(lnLine(result.reportText), "확인 2건");
  assert.match(permLine(result.reportText), /^확인 2건\(/);
});

test("renderConfirmedLnCount: 두 인자 호출은 옛 문면 그대로 · gapPieces 만 이상 표기를 켠다", () => {
  assert.equal(core.renderConfirmedLnCount(0), "확인 0건");
  assert.equal(core.renderConfirmedLnCount(2, 0), "확인 2건");
  assert.equal(core.renderConfirmedLnCount(1, 3), "확인 1건 이상 · 미조회 3");
  assert.equal(
    core.renderConfirmedLnCount(1, 3, ["판정 불가 2"]),
    "확인 1건 이상 · 미조회 3 · 판정 불가 2",
  );
  assert.equal(
    core.renderConfirmedLnCount(0, 0, ["판정 불가 2"]),
    "확인 0건 이상 · 판정 불가 2",
  );
});

// ---- 일별 줄 새 칸 2 ------------------------------------------------------------------

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

test("일별: 회차 값의 새 칸 2 가 상태 · 마감 줄에 실리고 «기존 칸» 값은 그대로다", () => {
  const nowMs = kst("2026-11-13 23:50");
  const tick = {
    ...DAY_ZERO,
    permissionHumanAnswers: 3,
    permissionUndecidable: 1,
  };
  const state = core.recordDailyTick({ state: null, nowMs, tick });
  assert.equal(state.permissionHumanAnswers, 3);
  assert.equal(state.permissionUndecidable, 1);
  const next = core.rolloverDailyState({
    state,
    nowMs: kst("2026-11-14 00:05"),
    closedDays: new Set(),
  });
  const line = next.closedLine;
  assert.equal(line.permissionHumanAnswers, 3);
  assert.equal(line.permissionUndecidable, 1);
  assert.equal(line.lnConfirmed, 0);
  assert.equal(line.lnUnchecked, 0);
  assert.deepEqual(line.collectorFails, []);
});

test("일별: 새 칸 없는 회차(미결선)는 칸을 싣지 않는다 · 마지막 회차 값 규칙 -- 칸 없는 마지막 회차가 앞 회차 값을 지운다", () => {
  const day = kst("2026-11-13 09:00");
  const withCols = core.recordDailyTick({
    state: null,
    nowMs: day,
    tick: { ...DAY_ZERO, permissionHumanAnswers: 2, permissionUndecidable: 0 },
  });
  assert.equal(withCols.permissionHumanAnswers, 2);
  const withoutCols = core.recordDailyTick({
    state: withCols,
    nowMs: day + 15 * 60 * 1000,
    tick: DAY_ZERO,
  });
  assert.equal(Object.hasOwn(withoutCols, "permissionHumanAnswers"), false);
  assert.equal(Object.hasOwn(withoutCols, "permissionUndecidable"), false);
});

test("일별: 칸이 있는데 값 모양이 틀리면 null(값 모름) -- 0 으로 접지 않는다", () => {
  const tick = core.normalizeDailyTick({
    ...DAY_ZERO,
    permissionHumanAnswers: "3",
    permissionUndecidable: -1,
  });
  assert.equal(tick.permissionHumanAnswers, null);
  assert.equal(tick.permissionUndecidable, null);
});

test("연속 확인-0: 사람 답 > 0 · 판정 불가 > 0 · 칸 null 인 날은 끊김 사유 · 0 · 0 인 날과 «칸 없는 옛 줄»은 이어진다", () => {
  const nowMs = kst("2026-11-14 09:00");
  const lines = [
    dailyLineFor("2026-11-13", {
      permissionHumanAnswers: 0,
      permissionUndecidable: 0,
    }),
    dailyLineFor("2026-11-12"), // 옛 줄 -- 새 칸 없음
    dailyLineFor("2026-11-11", {
      permissionHumanAnswers: 0,
      permissionUndecidable: 0,
    }),
  ];
  const ok = core.computeConfirmedZeroStreak({ lines, nowMs });
  assert.equal(ok.days, 3);
  assert.equal(ok.lastBreak.reasons[0], "줄 없음");

  const human = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [
      dailyLineFor("2026-11-13", {
        permissionHumanAnswers: 1,
        permissionUndecidable: 0,
      }),
    ],
  });
  assert.equal(human.days, 0);
  assert.deepEqual(human.lastBreak.reasons, ["권한 확인창 사람 답 1"]);

  const undecided = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [
      dailyLineFor("2026-11-13", {
        permissionHumanAnswers: 0,
        permissionUndecidable: 2,
      }),
    ],
  });
  assert.deepEqual(undecided.lastBreak.reasons, ["권한 판정 불가 2"]);

  const unknown = core.computeConfirmedZeroStreak({
    nowMs,
    lines: [
      dailyLineFor("2026-11-13", {
        permissionHumanAnswers: null,
        permissionUndecidable: null,
      }),
    ],
  });
  assert.deepEqual(unknown.lastBreak.reasons, [
    "권한 확인창 사람 답 UNKNOWN",
    "권한 판정 불가 UNKNOWN",
  ]);
});

test("연속 확인-0: 필드 없는 세션 S 의 날은 collectorFails «권한기록수집기» 로 끊긴다(그날 끊김)", async () => {
  const h = makeHome();
  putOne(h, { version: "2.1.100" }, 1);
  const result = await runReal({
    sessionHomeDir: h.home,
    outboxDir: h.outboxDir,
  });
  const line = dailyLineFor("2026-11-13", {
    collectorFails: result.dailyTick.collectorFails.filter(
      (n) => n === "권한기록수집기",
    ),
    permissionHumanAnswers: result.dailyTick.permissionHumanAnswers,
    permissionUndecidable: result.dailyTick.permissionUndecidable,
  });
  const streak = core.computeConfirmedZeroStreak({
    lines: [line],
    nowMs: kst("2026-11-14 09:00"),
  });
  assert.equal(streak.days, 0);
  assert.deepEqual(streak.lastBreak.reasons, ["수집 실패(권한기록수집기)"]);
});

// ---- 좌석 경로 · 분류 순수 함수 ----------------------------------------------------------

test("ORCH 자리 경로는 홈에서 파생한 값이 orca-adapter MAIN_REPO_PATH 코드 상수와 같다(상수 줄을 원문에서 읽어 대조 -- supervisor 시험이 relay 모듈을 import 하지 않는다)", () => {
  const adapterSource = fs.readFileSync(
    new URL("../relay/adapters/orca-adapter.mjs", import.meta.url),
    "utf8",
  );
  const m = /export const MAIN_REPO_PATH =\s*"([^"]+)";/.exec(adapterSource);
  assert.ok(m, "orca-adapter.mjs 에 MAIN_REPO_PATH 상수 줄이 있다");
  const roots = core.deriveSeatRoots({
    homeDir: "C:/Users/Administrator",
    interpreterRoot: "D:/문서관리/통역",
  });
  assert.equal(roots.main, core.normalizeSessionPath(m[1]));
  assert.equal(roots.workspaces, "c:/users/administrator/orca/workspaces");
  assert.equal(roots.interpreter, "d:/문서관리/통역");
});

test("parentDirOf: --outbox-dir 값(백슬래시 · 끝 슬래시 포함)의 부모 폴더 · 못 구하면 null", () => {
  assert.equal(
    core.parentDirOf("D:\\문서관리\\통역\\보내는함"),
    "d:/문서관리/통역",
  );
  assert.equal(
    core.parentDirOf("D:/문서관리/통역/보내는함/"),
    "d:/문서관리/통역",
  );
  assert.equal(core.parentDirOf("보내는함"), null);
  assert.equal(core.parentDirOf(null), null);
});

test("classifyPermissionDecision 표: 값 목록 10개 + 모르는 값", () => {
  const cls = (decision, source) =>
    core.classifyPermissionDecision({ decision, source });
  for (const s of ["config", "classifier", "hook"]) {
    assert.equal(cls("accept", s), "M", s);
  }
  for (const s of [
    "user_temporary",
    "user_permanent",
    "user_reject",
    "user_abort",
  ]) {
    assert.equal(cls("accept", s), "N", s);
  }
  for (const s of [
    "invalid_input",
    "permission_updated_input_invalid",
    "server_fallback_tombstone",
  ]) {
    assert.equal(cls("reject", s), "W", s);
  }
  for (const s of ["unknown", "", "USER_TEMPORARY", undefined, null, 1]) {
    assert.equal(cls("accept", s), "U", String(s));
  }
  assert.equal(cls("cancelled", "user_abort"), "N");
  assert.equal(cls("approve", "user_temporary"), "U");
  assert.equal(core.classifyPermissionDecision(null), "U");
  assert.equal(core.classifyPermissionDecision("config"), "U");
});

test("isPermissionFieldVersion: 2.1.322 이상만 true · 모르는 판 = false", () => {
  assert.equal(core.isPermissionFieldVersion("2.1.322"), true);
  assert.equal(core.isPermissionFieldVersion("2.1.323"), true);
  assert.equal(core.isPermissionFieldVersion("2.2.0"), true);
  assert.equal(core.isPermissionFieldVersion("3.0.0"), true);
  assert.equal(core.isPermissionFieldVersion("2.1.321"), false);
  assert.equal(core.isPermissionFieldVersion("2.0.999"), false);
  assert.equal(core.isPermissionFieldVersion("1.9.9999"), false);
  assert.equal(core.isPermissionFieldVersion(null), false);
  assert.equal(core.isPermissionFieldVersion("abc"), false);
});

test("summarizePermissionRecords: 입력이 레코드 배열이 아니면 0 건 · 같은 레코드를 다시 줘도 같은 값(순수)", () => {
  const roots = core.deriveSeatRoots({
    homeDir: "/h",
    interpreterRoot: "/h/t",
  });
  const args = { windowStartMs: 0, windowEndMs: 10, roots };
  assert.equal(
    core.summarizePermissionRecords({ records: null, ...args }).humanTotal,
    0,
  );
  const records = [
    {
      sessionKey: "a",
      uid: "u1",
      toolUseId: "t1",
      atMs: 5,
      cwd: "/h/t",
      rootName: "home",
      entrypoint: "cli",
      version: "2.1.322",
      hasDecision: true,
      decision: { decision: "accept", source: "user_temporary" },
      toolName: "Bash",
    },
  ];
  const first = core.summarizePermissionRecords({ records, ...args });
  assert.deepEqual(
    core.summarizePermissionRecords({ records, ...args }),
    first,
  );
  assert.equal(first.humanTotal, 1);
  assert.equal(first.interpreterAnswers, 1);
});

// ---- 일별 결선 -- runPartialCountStep(감시 단계) + 실제 수집기 ------------------------------------

test("일별 결선: 실제 수집기를 단 감시 단계 -> 상태 파일 · 마감 줄에 새 칸 2 · 다음 날 연속 확인-0 줄이 사람 답으로 끊긴다", async () => {
  const h = makeHome();
  putOne(h, {
    root: "claude",
    cwd: h.interpreter,
    source: "user_temporary",
  });
  const watchDir = tmpDir("nc-perm-watch-");
  const step = (now) =>
    runPartialCountStep({
      watchDir,
      now,
      logPath: join(watchDir, "watch.log"),
      options: { outboxDir: h.outboxDir, sessionHomeDir: h.home },
      runPartialCountOnceFn: (args) => runReal(args),
    });
  await step(kst("2026-11-13 23:50"));
  const state = JSON.parse(
    fs.readFileSync(join(watchDir, "partial-count-daily-state.json"), "utf8"),
  );
  assert.equal(state.permissionHumanAnswers, 1);
  assert.equal(state.permissionUndecidable, 0);
  await step(kst("2026-11-14 00:05"));
  const closed = fs
    .readFileSync(join(watchDir, "partial-count-daily.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].day, "2026-11-13");
  assert.equal(closed[0].permissionHumanAnswers, 1);
  assert.equal(closed[0].permissionUndecidable, 0);
  const text = fs.readFileSync(
    join(watchDir, "partial-count-report.md"),
    "utf8",
  );
  assert.match(text, /^연속 확인-0 일수: 0일\(.*권한 확인창 사람 답 1/m);
});
