// HYK-255-g7-token-diag-1 (coder-task.md §2) -- 커밋 1 시험.
//   ⓐ 관측 건강 «진단 줄»(외부독립증거후보수집기)에 D1 확인 낙차 «낙차 M→N(미조회)»
//   1토막 -- 미조회로 확인이 떨어진 회차에만. 통지 조건 · 장 수 · 확인 N · ㄴ 분자 ·
//   REST 호출 수는 무변. (ⓑ ⓒ = partial-count-g7-token-boundary.test.mjs)
// ⛔헛시험 금지: 프로덕션 export(runPartialCountOnce · runReachOnce)를 직접 구동한다.
// 입력은 전부 mkdtemp 합성(상태 파일 · 합성 저장소 · 주입 가짜 fetchJson)이며
// 실제 원장 · 관제실 · 받는함 · 네트워크 접촉은 0 이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as report from "./partial-count-report.mjs";
import { runReachOnce } from "./reach-report.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T10:00:00.000Z"); // 2026-11-12 19:00 KST

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// ⓐ 진단 줄 낙차 토막
// ---------------------------------------------------------------------------

const EXT_PREFIX = "- 외부 독립 증거 후보: ";
const STATE_KEY = "__externalEvidenceCandidates";
const STALE_AT_MS = Date.parse("2026-11-12T02:05:00.000Z"); // 11:05 KST
const DIAG_NAME = "외부독립증거후보수집기";
const DROP_RE = /낙차 (\d+)→(\d+)\(미조회\)/g;

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

const REPO_FULL = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";
// HYK-255-p3-gh-1 -- P3(GitHub 사람 손 수집기)는 이 시험의 관심 밖이다. 합성 저장소에 봇 목록 파일을 둬서 P3 가 «수집 실패»
// 로 분자 표기(하한 토막)를 바꾸지 않게 하고, 사건 목록 호출은 빈 목록(사람 손 0)으로 받아 이 시험의 호출 기록에 섞지 않는다.
const BOTS_PATH = "scripts/supervisor/github-bot-accounts.json";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: "bot-fixture-a" }],
});
const passGithubEvents = (fetchJson) => (opts) =>
  /\/events\?per_page=/.test(opts.url)
    ? { ok: true, status: 200, json: [], linkHeader: null }
    : fetchJson(opts);

// 합성 저장소 -- GitHub 웹 «Update branch» 병합 커밋 후보 1개가 origin/master 에 닿는다.
function buildCandidateRepo() {
  const dir = tmpDir("nc-g7-diag-repo-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, BOTS_PATH), BOTS_JSON, "utf8");
  fs.writeFileSync(
    join(dir, ALLOWLIST_PATH),
    JSON.stringify({
      schema_version: "approver-allowlist/v1",
      repo: REPO_FULL,
      approvers: [{ login: "hykim82", id: 286230306 }],
    }),
    "utf8",
  );
  git(dir, ["add", "-A"]);
  const tree = git(dir, ["write-tree"]);
  const ident = (name, email, atMs) => ({
    GIT_AUTHOR_NAME: "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: new Date(atMs).toISOString(),
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: new Date(atMs).toISOString(),
  });
  const human = (atMs) => ident("hykim82", "hykim82@example.com", atMs);
  const web = (atMs) => ident("GitHub", "noreply@github.com", atMs);
  const root = git(
    dir,
    ["commit-tree", tree, "-m", "root"],
    human(NOW - 100 * 24 * HOUR),
  );
  git(dir, ["remote", "add", "origin", `https://github.com/${REPO_FULL}.git`]);
  const work = git(
    dir,
    ["commit-tree", tree, "-p", root, "-m", "feat: work"],
    human(NOW - 90 * 24 * HOUR),
  );
  const candidate = git(
    dir,
    [
      "commit-tree",
      tree,
      "-p",
      work,
      "-p",
      root,
      "-m",
      "Merge branch 'master' into feat/x",
    ],
    web(NOW - 30 * 60 * 1000),
  );
  const mainline = git(
    dir,
    [
      "commit-tree",
      tree,
      "-p",
      root,
      "-p",
      candidate,
      "-m",
      "Merge pull request #1 from hykim82/feat-x",
    ],
    web(NOW - 5 * 60 * 1000),
  );
  git(dir, ["update-ref", "refs/remotes/origin/master", mainline]);
  return { dir, candidate };
}

function validPayload(sha) {
  return {
    sha,
    commit: {
      verification: { verified: true, reason: "valid" },
      committer: { name: "GitHub", email: "noreply@github.com" },
    },
    author: { login: "hykim82", id: 286230306 },
    committer: { login: "web-flow", id: 19864447 },
  };
}

const rateLimited = () => ({
  ok: false,
  status: 403,
  json: null,
  linkHeader: null,
});
const failure500 = () => ({
  ok: false,
  status: 500,
  json: null,
  linkHeader: null,
});
const confirmedResponse = ({ url }) => ({
  ok: true,
  status: 200,
  json: validPayload(url.split("/commits/")[1]),
  linkHeader: null,
});
const unsignedResponse = ({ url }) => ({
  ok: true,
  status: 200,
  json: {
    ...validPayload(url.split("/commits/")[1]),
    commit: { verification: { verified: false, reason: "unsigned" } },
  },
  linkHeader: null,
});

// 한 회차를 돌려 «보고서 본문의 후보 줄» 과 «관측 건강의 진단 줄» 을 함께 돌려준다.
async function runTick({ stateEntry, fetchHandler, extra = {} }) {
  const repo = buildCandidateRepo();
  const root = tmpDir("nc-g7-diag-run-");
  try {
    if (stateEntry !== undefined) {
      fs.writeFileSync(
        join(root, "reach-notify-state.json"),
        JSON.stringify({ [STATE_KEY]: stateEntry }),
        "utf8",
      );
    }
    const calls = [];
    const result = await report.runPartialCountOnce({
      now: NOW,
      repoRoot: repo.dir,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      fetchJson: passGithubEvents(async (opts) => {
        calls.push(opts);
        return fetchHandler(opts);
      }),
      git: report.createProcessGitPort(repo.dir),
      gitWorktreeListExecFn: () => "",
      ...extra,
    });
    const lines = result.reportText.split("\n");
    const healthStart = lines.indexOf("관측 건강:");
    // 수집 성공/실패 줄은 수집기들을 « · » 로 이은 한 줄이다 -- 앞쪽(합성 임시 경로가
    // 든 배달영수증 칸 등)은 회차마다 달라 비교에서 빼고, 이 수집기 토막부터 자른다.
    const healthLine = lines
      .slice(healthStart + 1)
      .find((l) => l.includes(DIAG_NAME));
    const diagLine = healthLine
      ? healthLine.slice(healthLine.indexOf(DIAG_NAME))
      : undefined;
    const extLine = lines.find((l) => l.startsWith(EXT_PREFIX));
    return { result, calls, diagLine, extLine, reportText: result.reportText };
  } finally {
    cleanup(root);
    cleanup(repo.dir);
  }
}

const dropPieces = (line) => [...(line ?? "").matchAll(DROP_RE)];

test("ⓐ 낙차 회차(직전 확인 1 · 이번 403 미조회 -> 확인 0): 진단 줄에 «낙차 1→0(미조회)» 가 정확히 1토막 찍힌다", async () => {
  const { diagLine, calls } = await runTick({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
  });
  assert.ok(diagLine, "진단 줄이 있어야 한다");
  assert.equal(dropPieces(diagLine).length, 1, diagLine);
  assert.ok(diagLine.includes(" · 낙차 1→0(미조회)"), diagLine);
  assert.equal(calls.length, 1, "REST 호출 수 무변");
});

test("ⓐ 낙차 회차는 예산 미조회(상한 0)에도 · 조회 실패(500) 미조회에도 찍힌다 (M 은 상태 파일의 직전 확인값)", async () => {
  const budget = await runTick({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
    extra: { maxExternalEvidenceChecks: 0 },
  });
  assert.equal(budget.calls.length, 0);
  assert.ok(budget.diagLine.includes("낙차 1→0(미조회)"), budget.diagLine);
  const failed = await runTick({
    stateEntry: { confirmed: 2, atMs: STALE_AT_MS },
    fetchHandler: failure500,
  });
  assert.ok(failed.diagLine.includes("낙차 2→0(미조회)"), failed.diagLine);
});

test("ⓐ 낙차 없는 회차엔 토막 0: 이번 회차가 확인했거나 · 전부 조회한 진짜 감소거나 · 직전 값이 없거나 · 상태 파일이 0 이면", async () => {
  const cases = [
    [
      "이번 회차 확인(1 -> 1)",
      { confirmed: 1, atMs: STALE_AT_MS },
      confirmedResponse,
    ],
    [
      "진짜 감소(미조회 0)",
      { confirmed: 1, atMs: STALE_AT_MS },
      unsignedResponse,
    ],
    ["상태 파일 없음(미조회 1)", undefined, rateLimited],
    ["직전 확인 0(미조회 1)", { confirmed: 0 }, rateLimited],
  ];
  for (const [label, stateEntry, fetchHandler] of cases) {
    const { diagLine } = await runTick({ stateEntry, fetchHandler });
    assert.ok(diagLine, `${label}: 진단 줄이 있어야 한다`);
    assert.equal(dropPieces(diagLine).length, 0, `${label}: ${diagLine}`);
    assert.ok(!diagLine.includes("낙차"), `${label}: ${diagLine}`);
  }
});

test("ⓐ 낙차 토막 말고 진단 줄은 한 글자도 안 바뀐다 (직전 확인 값 유무만 다른 두 회차의 줄 비교)", async () => {
  const withPrev = await runTick({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
  });
  const noPrev = await runTick({ fetchHandler: rateLimited });
  assert.equal(
    withPrev.diagLine.replace(" · 낙차 1→0(미조회)", ""),
    noPrev.diagLine,
  );
});

test("ⓐ 동작 보존: 낙차 회차의 후보 줄은 base 의 스테일 문면 그대로 · 확인 N=0 · ㄴ 분자 확인 0건 · 직전 값은 확인이 아니다", async () => {
  const { extLine, result, reportText } = await runTick({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
  });
  assert.equal(
    extLine,
    `${EXT_PREFIX}확인 0 · 미조회 1 · ㄴ 분자 반영 · 스테일 표시(확인 아님): 직전 확인 1 · 마지막 확인 11:05 KST`,
  );
  assert.equal(result.externalEvidence.confirmed, 0);
  assert.equal(result.externalEvidence.unchecked, 1);
  // 분자 = 이 회차 확인 0 · 하한 표기(미조회 1) -- HYK-255-ln-update-branch-1 커밋 3 의도된 변경.
  assert.ok(
    reportText.includes(
      "- 외부 독립 증거로 확인된 사건: 확인 0건 이상 · 미조회 1\n",
    ),
  );
  const lines = reportText.split("\n");
  assert.equal(
    lines.filter((l) => l.startsWith(EXT_PREFIX)).length,
    1,
    "ㄴ 절 후보 줄은 1개뿐 -- 낙차는 진단 줄에만 있다",
  );
  assert.ok(
    !lines
      .filter((l) => !l.includes(DIAG_NAME))
      .some((l) => l.includes("낙차")),
    "낙차 토막은 진단 줄 밖에 새지 않는다",
  );
});

function writeReachWatchLog(root) {
  const watchLogPath = join(root, "watch.log");
  const t0 = Date.parse("2026-11-12T00:00:00.000Z");
  fs.writeFileSync(
    watchLogPath,
    `${new Date(t0).toISOString()} exit=0 verdict=PROGRESSING reason=OK ` +
      `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
      `idle_status=SEAT_IDLE_NOT_APPLICABLE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=1 ` +
      `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
      `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`,
    "utf8",
  );
  return { watchLogPath, t0 };
}

test("ⓐ 통지 장 수 무변: 낙차 토막이 있는 «실제 보고서 본문» 을 reach 에 먹여도 통지 0장이고 기준선 · 시각이 남는다 (통지는 확인 증가에만)", async () => {
  const { reportText, diagLine } = await runTick({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
  });
  assert.ok(diagLine.includes("낙차 1→0(미조회)"), "전제: 낙차 회차");
  const root = tmpDir("nc-g7-diag-reach-");
  try {
    const { watchLogPath, t0 } = writeReachWatchLog(root);
    const opts = {
      watchLogPath,
      partialCountPath: join(root, "partial-count-report.md"),
      reportOutPath: join(root, "morning-report.md"),
      statePath: join(root, "state.json"),
      notifyDir: join(root, "받는함"),
    };
    // 기준선 확인 1 을 먼저 만든다(확인 1 줄 -> 첫 관측 통지 1장).
    fs.writeFileSync(
      opts.partialCountPath,
      [
        "집계 성격: PARTIAL — 전수 아님",
        "생성 시각: 2026-11-12 09:00:00 KST",
        `${EXT_PREFIX}확인 1 · 미조회 0 · ㄴ 분자 반영`,
        "",
      ].join("\n"),
      "utf8",
    );
    runReachOnce({ ...opts, now: t0 + HOUR });
    const noticesBefore = fs.readdirSync(opts.notifyDir).length;
    const stateBefore = fs.readFileSync(opts.statePath, "utf8");
    fs.writeFileSync(opts.partialCountPath, reportText, "utf8");
    const tickResult = runReachOnce({ ...opts, now: t0 + HOUR + 1000 });
    assert.equal(tickResult.noticePath, null, "낙차 회차는 통지 0장");
    assert.equal(fs.readdirSync(opts.notifyDir).length, noticesBefore);
    assert.equal(
      JSON.parse(fs.readFileSync(opts.statePath, "utf8"))[STATE_KEY].confirmed,
      JSON.parse(stateBefore)[STATE_KEY].confirmed,
      "기준선 유지",
    );
  } finally {
    cleanup(root);
  }
});
