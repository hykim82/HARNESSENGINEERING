// HYK-255-p3-gh-2 (판정 2026-11-14 1407 ④⑤ · P3 2R 원천 교체) -- GitHub 사람 손 조작 수집기(실시간 저장소 목록 3종).
//
//   1R 의 저장소 사건 목록(/events)은 공개 활동을 수십 시간 늦게 싣는다(책임자 실측: 최신 사건이 지금보다 약 40시간 앞 · 병합 사건
//   누락) -- 창 안 0건이라는 거짓 0 이 나온다. 2R 은 사건 목록을 버리고 «실시간 목록» 세 개를 돌아가며 부른다:
//     ⓐ 닫힌 PR   GET /repos/<o>/<r>/pulls?state=closed&sort=updated&direction=desc&per_page=100   (merged_at null ∧ closed_at 창 안)
//     ⓑ 대화 댓글 GET /repos/<o>/<r>/issues/comments?since=<창 시작>&…                         (PR · 이슈 구분 없이 둘 다 셈)
//     ⓒ 리뷰 줄 댓글 GET /repos/<o>/<r>/pulls/comments?since=<창 시작>&…
//   변경 요청 = ㄱ-4 가 이미 받는 리뷰 응답의 `state`(추가 조회 0) · 그 응답이 없으면 «미수집»(0 아님). 회차당 호출 = min(2, 12 - 앞의 둘이
//   쓴 호출 수) · 목록 순번은 회차 시각에서만 정한다(상태 0). 못 부른 목록 = 미조회. 일별 칸은 세 목록 «모두» 가 그날을 덮을 때만 수.
//
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce · collectGithubHumanActions · buildDailyTickValues · recordDailyTick ·
// rolloverDailyState)을 직접 구동한다 -- 사본 import 0 · helper 만 단언하는 칸 0. 저장소는 mkdtemp 합성 git(실제 git), fetchJson 은
// 호출을 기록하는 주입 가짜. 가짜 응답의 칸은 책임자 실측 칸 목록(판정 1407 ③ ④(사))뿐이다. 실제 네트워크 · gh · 토큰 · 관제실 ·
// 받는함 접촉 0. 모든 칸은 응답을 넣고 «값» 을 단언한다. 네임스페이스 import(core · report) -- 옛 판에서도 파일이 로드돼 칸마다 «값» 으로 RED.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import { DEFAULT_CALL_BUDGET } from "./approval-authority-adapter.mjs";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const TICK_MS = 15 * MIN;
const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const REPO = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";
const BOTS_PATH = "scripts/supervisor/github-bot-accounts.json";
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});
// 시험 고정값 = 합성 이름(실제 봇 계정 이름 0).
const BOT_A = "bot-fixture-a";
const BOT_B = "bot-fixture-b";
const HUMAN = "human-fixture";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: BOT_A }, { login: BOT_B }],
});
const NUMERATOR_PREFIX = "- 외부 독립 증거로 확인된 사건: ";
const GH_PREFIX = "- GitHub 사람 손 ";
const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
const PULL_HEAD_SHA = "e".repeat(40);
// 기본 회차(예산 2 · 세 목록 중 둘만 부른다)의 분자 하한 토막 -- 못 부른 목록 1개 = 미조회.
const ONE_UNCHECKED = "GitHub 사람 손 목록 1개 미조회";

const LIST_KEYS = ["closedPrs", "issueComments", "reviewComments"];
// 목록 순번 규칙(문서화된 계약 · 시험이 독립으로 다시 적는다): 시작 위치 = floor(회차 시각 / 15분) % 3 · 그 위치부터 돌려 앞에서 몫만큼 부른다.
const expectedOrder = (nowMs) => {
  const start = Math.floor(nowMs / TICK_MS) % 3;
  return [0, 1, 2].map((i) => LIST_KEYS[(start + i) % 3]);
};
// 목록 k 가 «맨 앞» 에 오는 회차 시각(NOW 이후 가장 가까운 15분 칸).
const nowWithOffset = (k) => {
  let t = NOW;
  while (Math.floor(t / TICK_MS) % 3 !== k) t += TICK_MS;
  return t;
};

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

function commitTree(cwd, { parents, message, committer, atMs }) {
  const tree = git(cwd, ["rev-parse", `${parents[0]}^{tree}`]);
  const isoAt = new Date(atMs).toISOString();
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", message);
  return git(cwd, args, {
    GIT_AUTHOR_NAME: "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: isoAt,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: isoAt,
  });
}

// 합성 저장소 -- origin/master 에 허용 목록 + (옵션) 봇 목록이 있고, PR 브랜치마다 Update branch 병합 커밋 ubCounts[i] 개를 얹어
// «Merge pull request» 로 합친다(rest-cap 시험과 같은 모양 -- ㄱ-4 후보 = PR 수 · D1 후보 = Update branch 합계).
//   bots: 문자열 = 그 내용으로 봇 목록 파일을 심는다 · null = 파일 없음.
function buildRepo(ubCounts = [], { bots = BOTS_JSON } = {}) {
  const dir = tmpDir("nc-gh-human-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, ALLOWLIST_PATH), ALLOWLIST_JSON, "utf8");
  if (bots !== null) fs.writeFileSync(join(dir, BOTS_PATH), bots, "utf8");
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
  let main = root;
  const mergeShas = [];
  let ubSeq = 0;
  ubCounts.forEach((count, i) => {
    let prev = commitTree(dir, {
      parents: [main],
      message: `feat: work on PR branch ${i + 1}`,
      committer: HUMAN_COMMITTER,
      atMs: NOW - 90 * 24 * HOUR + i * HOUR,
    });
    for (let k = 0; k < count; k++) {
      ubSeq += 1;
      prev = commitTree(dir, {
        parents: [prev, root],
        message: "Merge branch 'master' into feat/x",
        committer: GITHUB_COMMITTER,
        atMs: NOW - (200 - ubSeq) * 60 * 1000,
      });
    }
    main = commitTree(dir, {
      parents: [main, prev],
      message: `Merge pull request #${i + 1} from hykim82/feat-${i + 1}`,
      committer: GITHUB_COMMITTER,
      atMs: NOW - (60 - i * 10) * 60 * 1000,
    });
    mergeShas.push(main);
  });
  git(dir, ["update-ref", "refs/remotes/origin/master", main]);
  return { dir, mergeShas, headSha: main };
}

// ---- 실제 응답 모양(판정 1407 ③ · ④(사) -- 책임자 익명 실측 칸 목록) ----------------------------------------------------
// 닫힌 PR 항목 칸 = id · number · state · closed_at · merged_at · updated_at · user.login(작성자 · 닫은 사람 아님)
// 대화 댓글 칸   = id · user.login · issue_url · created_at · updated_at
// 리뷰 줄 댓글 칸 = id · user.login · pull_request_url · created_at · updated_at
// 시험 고정값은 이 칸만 -- 본문(body) 칸은 읽지도 단언하지도 않는다.
const iso = (ms) => new Date(ms).toISOString();
let seq = 5000;
const nextId = () => {
  seq += 1;
  return seq;
};
const CLOSED_PR_FIELDS = [
  "id",
  "number",
  "state",
  "closed_at",
  "merged_at",
  "updated_at",
  "user",
];
const ISSUE_COMMENT_FIELDS = [
  "id",
  "user",
  "issue_url",
  "created_at",
  "updated_at",
];
const REVIEW_COMMENT_FIELDS = [
  "id",
  "user",
  "pull_request_url",
  "created_at",
  "updated_at",
];

// 닫힌 PR: closedAtMs 에 닫힘 · mergedAtMs 가 있으면 병합 닫기 · updated_at = 닫힌 뒤(기본 = 닫힌 시각).
function closedPr({
  closedAtMs,
  mergedAtMs = null,
  login = HUMAN,
  id = nextId(),
  updatedAtMs = closedAtMs,
}) {
  return {
    id,
    number: id - 4000,
    state: "closed",
    closed_at: iso(closedAtMs),
    merged_at: mergedAtMs === null ? null : iso(mergedAtMs),
    updated_at: iso(updatedAtMs),
    user: { login },
  };
}
function issueComment({
  atMs,
  login = HUMAN,
  id = nextId(),
  updatedAtMs = atMs,
  onPr = true,
}) {
  return {
    id,
    user: { login },
    issue_url: `https://api.github.com/repos/${REPO}/issues/${onPr ? 7 : 8}`,
    created_at: iso(atMs),
    updated_at: iso(updatedAtMs),
  };
}
function reviewComment({
  atMs,
  login = HUMAN,
  id = nextId(),
  updatedAtMs = atMs,
}) {
  return {
    id,
    user: { login },
    pull_request_url: `https://api.github.com/repos/${REPO}/pulls/7`,
    created_at: iso(atMs),
    updated_at: iso(updatedAtMs),
  };
}
// 본문 칸 읽음 감시 -- 항목에 body getter 를 달아 «읽으면 센다» (프로덕션이 읽지 않으면 0).
const bodyReads = { count: 0 };
function withBodyTrap(item) {
  Object.defineProperty(item, "body", {
    enumerable: true,
    get() {
      bodyReads.count += 1;
      return "BODY-TRAP";
    },
  });
  return item;
}

// ---- 가짜 fetchJson (호출 기록) -----------------------------------------------------------------
// 목록 응답 = lists[key] (200 JSON 배열 | 응답 객체 그대로). 없는 목록 = 빈 배열. 사건 목록(/events)을 받으면 «기록 + 404».
// ㄱ-4 · D1 응답 = rest-cap 시험과 같은 «체인을 끝까지 끄는» 모양(리뷰 응답에 reviewExtra 를 덧붙일 수 있다).
const ok200 = (json) => ({ ok: true, status: 200, json, linkHeader: null });
const FAIL404 = { ok: false, status: 404, json: null, linkHeader: null };
// 사건 목록(/events)이 실제로 있다면 -- 책임자 실측 모양(판정 1407 ③): 최신 사건이 회차보다 약 40시간 앞 · 창 시작보다 오래된 사건이 있다 ·
// PullRequestEvent 의 action 은 opened · merged 뿐이고 pull_request 칸에 merged 칸이 없다. 2R 은 이 목록을 «부르지 않는다» -- 불리면
// calls.events 에 쌓여 시험이 실패한다. (옛 원천이 이 목록을 믿으면 창 안 미병합 닫기가 0 으로 나온다 = 거짓 0.)
const staleEvents = (nowMs) => [
  {
    id: "stale-1",
    type: "PullRequestEvent",
    actor: { login: HUMAN },
    repo: { name: REPO },
    payload: {
      action: "merged",
      pull_request: { url: "u", id: 1, number: 371, head: {}, base: {} },
    },
    created_at: iso(nowMs - 40 * HOUR),
  },
  {
    id: "stale-2",
    type: "PullRequestEvent",
    actor: { login: HUMAN },
    repo: { name: REPO },
    payload: {
      action: "opened",
      pull_request: { url: "u", id: 2, number: 370, head: {}, base: {} },
    },
    created_at: iso(nowMs - 60 * HOUR),
  },
];
function makeFetch(repo, { lists = {}, reviewExtra = [], nowMs = NOW } = {}) {
  const calls = {
    gate4: [],
    d1: [],
    events: [],
    all: [],
    order: [],
    lists: { closedPrs: [], issueComments: [], reviewComments: [] },
  };
  const mergeNumber = new Map((repo.mergeShas ?? []).map((s, i) => [s, i + 1]));
  const listReply = (key) => {
    calls.order.push(key);
    const p = lists[key];
    if (p === undefined) return ok200([]);
    return Array.isArray(p) ? ok200(p) : p;
  };
  const fetchJson = async ({ url }) => {
    calls.all.push(url);
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    if (/^\/events/.test(path)) {
      calls.events.push(url);
      return ok200(staleEvents(nowMs));
    }
    if (/^\/pulls\?/.test(path)) {
      calls.lists.closedPrs.push(url);
      return listReply("closedPrs");
    }
    if (/^\/issues\/comments\?/.test(path)) {
      calls.lists.issueComments.push(url);
      return listReply("issueComments");
    }
    if (/^\/pulls\/comments\?/.test(path)) {
      calls.lists.reviewComments.push(url);
      return listReply("reviewComments");
    }
    const d1 = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (d1) {
      calls.d1.push(url);
      return d1Reply(d1[1]);
    }
    calls.gate4.push(url);
    return gate4Reply(path, { repo, mergeNumber, reviewExtra });
  };
  return { fetchJson, calls };
}

// D1(Update branch 서명 확인) 응답 -- 확인 모양.
const d1Reply = (sha) =>
  ok200({
    sha,
    commit: {
      verification: { verified: true, reason: "valid" },
      committer: { name: "GitHub", email: "noreply@github.com" },
    },
    author: { login: "hykim82", id: 286230306 },
    committer: { login: "web-flow", id: 19864447 },
  });

// ㄱ-4 체인 응답(저장소 · 보호 브랜치 · 커밋의 PR · PR 상세 · 리뷰) -- 승인 모양 · 리뷰에 reviewExtra 를 덧붙인다.
function gate4Reply(path, { repo, mergeNumber, reviewExtra }) {
  if (path === "") return ok200({ default_branch: "master" });
  if (path === "/branches/master") {
    return ok200({ protected: true, commit: { sha: repo.headSha } });
  }
  const pulls = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
  if (pulls) {
    const n = mergeNumber.get(pulls[1]);
    return ok200(n ? [{ merge_commit_sha: pulls[1], number: n }] : []);
  }
  if (/^\/pulls\/\d+$/.test(path)) {
    return ok200({
      merged: true,
      base: { ref: "master" },
      head: { sha: PULL_HEAD_SHA },
      user: { login: "harness-bot", id: 999 },
    });
  }
  if (/^\/pulls\/\d+\/reviews\?per_page=100$/.test(path)) {
    return ok200([
      {
        id: 1,
        user: { login: "hykim82", id: 286230306 },
        state: "APPROVED",
        commit_id: PULL_HEAD_SHA,
        submitted_at: "2026-11-13T09:00:00Z",
      },
      ...reviewExtra,
    ]);
  }
  return FAIL404;
}

// 프로덕션 진입점 1회 -- ⛔기본 옵션(상한 인자 없음 · 예약 감시가 부르는 모양 그대로).
async function runDefault(repo, fetchJson, extra = {}) {
  const root = tmpDir("nc-gh-human-run-");
  return report.runPartialCountOnce({
    now: NOW,
    repoRoot: repo.dir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson,
    git: report.createProcessGitPort(repo.dir),
    gitWorktreeListExecFn: () => "",
    ...extra,
  });
}

// lists 는 (now) => 목록 응답 모음 | 모음 -- 항목 시각이 회차 시각에 맞게 만들어지도록 함수 형태를 받는다.
// first = 그 회차 순번에서 «맨 앞» 에 오는 목록(= 반드시 불리는 목록 · 둘째 = 순번상 다음 목록).
async function runLists(
  lists,
  { first = "closedPrs", ubCounts = [], bots, reviewExtra, extra = {} } = {},
) {
  const now = nowWithOffset(LIST_KEYS.indexOf(first));
  const data = typeof lists === "function" ? lists(now) : lists;
  const repo = buildRepo(ubCounts, bots === undefined ? undefined : { bots });
  const { fetchJson, calls } = makeFetch(repo, {
    lists: data,
    reviewExtra:
      typeof reviewExtra === "function" ? reviewExtra(now) : reviewExtra,
    nowMs: now,
  });
  const result = await runDefault(repo, fetchJson, { now, ...extra });
  return { repo, calls, result, now };
}

const lineStarting = (text, prefix) =>
  text.split("\n").find((l) => l.startsWith(prefix));
const numerator = (text) => lineStarting(text, NUMERATOR_PREFIX);
const ghLine = (text) => lineStarting(text, GH_PREFIX);
const inWin = (now) => now - 2 * HOUR;

// ---- ⑴ RED 대표 칸: 책임자 실측 모양(사건 목록이 40시간 늦음) 에서도 창 안 미병합 닫기 1건이 잡힌다 -----------------------------

test("⑴ 거짓 0 제거: 사건 목록 최신이 창보다 40시간 늦어도(옛 원천이면 0) 닫힌 PR 목록의 창 안 미병합 닫기 1건 = 1 · 분자 «확인 1건 이상»", async () => {
  // 사건 목록(/events)이 있다면 이런 모양 -- 최신 사건 = 지금보다 40시간 앞 · 창 시작보다 오래된 사건 있음 · 미병합 닫기가 안 실려 있다(거짓 0).
  // 2R 은 사건 목록을 «부르지 않는다» -- 가짜가 /events 를 받으면 calls.events 에 쌓여 아래에서 실패한다.
  const { result, calls } = await runLists((t) => ({
    closedPrs: [closedPr({ closedAtMs: inWin(t) })],
  }));
  const g = result.githubHumanActions;
  assert.equal(g.known, true);
  assert.equal(g.unmergedClose, 1, "창 안 미병합 닫기 = 1 (옛 원천은 0)");
  assert.equal(g.humanTotal, 1);
  assert.equal(
    numerator(result.reportText),
    `${NUMERATOR_PREFIX}확인 1건 이상 · ${ONE_UNCHECKED}`,
  );
  assert.equal(calls.events.length, 0, "사건 목록 호출 0");
  assert.equal(calls.lists.closedPrs.length, 1);
});

// ---- ⑵ 목록 3 × (사람 = 1 · 봇 = 0 · 창) ---------------------------------------------------------------------------

test("⑵ 닫힌 PR 목록: 미병합 닫기 창 안 = 1 · 병합 닫기(merged_at 있음) = 0 · 창 밖(24시간 전) = 0", async () => {
  const { result } = await runLists((t) => ({
    closedPrs: [
      closedPr({ closedAtMs: inWin(t) }),
      closedPr({ closedAtMs: inWin(t), mergedAtMs: inWin(t) }),
      closedPr({ closedAtMs: t - 25 * HOUR, updatedAtMs: t - 1 * HOUR }),
      closedPr({ closedAtMs: t + 5 * MIN }),
    ],
  }));
  const g = result.githubHumanActions;
  assert.equal(g.unmergedClose, 1);
  assert.equal(g.humanTotal, 1);
  assert.equal(g.lists.closedPrs.mergedClosed, 1, "병합 닫기는 진단 칸에만");
  assert.equal(g.lists.closedPrs.outOfWindow, 2, "창 밖 둘(오래됨 · 미래)");
});

test("⑵ 닫힌 PR 목록: 닫은 행위자 칸이 없다 -> 작성자가 봇 목록에 있어도 사람 손으로 센다(애매하면 ㄴ · 한계 표기)", async () => {
  const { result } = await runLists((t) => ({
    closedPrs: [closedPr({ closedAtMs: inWin(t), login: BOT_A })],
  }));
  assert.equal(result.githubHumanActions.unmergedClose, 1);
  assert.match(
    ghLine(result.reportText),
    /닫은 행위자 칸 없음 -> 미병합 닫기는 전부 사람 손으로 셈/,
  );
});

test("⑵ 대화 댓글 목록: 사람 = 1 · 봇(설정 목록) = 0 · 이슈 댓글(issue_url 이 PR 아님)도 1 -- PR · 이슈 구분 없이 둘 다 센다", async () => {
  const human = await runLists(
    (t) => ({ issueComments: [issueComment({ atMs: inWin(t) })] }),
    { first: "issueComments" },
  );
  assert.equal(human.result.githubHumanActions.comment, 1);
  assert.equal(human.result.githubHumanActions.humanTotal, 1);
  const issue = await runLists(
    (t) => ({
      issueComments: [issueComment({ atMs: inWin(t), onPr: false })],
    }),
    { first: "issueComments" },
  );
  assert.equal(issue.result.githubHumanActions.comment, 1, "이슈 댓글도 센다");
  const bot = await runLists(
    (t) => ({
      issueComments: [
        issueComment({ atMs: inWin(t), login: BOT_A }),
        issueComment({ atMs: inWin(t), login: BOT_B }),
      ],
    }),
    { first: "issueComments" },
  );
  assert.equal(bot.result.githubHumanActions.comment, 0);
  assert.equal(bot.result.githubHumanActions.botSkipped, 2);
  assert.equal(bot.result.githubHumanActions.humanTotal, 0);
});

test("⑵ 리뷰 줄 댓글 목록: 사람 = 1 · 봇(설정 목록) = 0", async () => {
  const human = await runLists(
    (t) => ({ reviewComments: [reviewComment({ atMs: inWin(t) })] }),
    { first: "reviewComments" },
  );
  assert.equal(human.result.githubHumanActions.reviewComment, 1);
  assert.equal(human.result.githubHumanActions.humanTotal, 1);
  const bot = await runLists(
    (t) => ({
      reviewComments: [reviewComment({ atMs: inWin(t), login: BOT_A })],
    }),
    { first: "reviewComments" },
  );
  assert.equal(bot.result.githubHumanActions.reviewComment, 0);
  assert.equal(bot.result.githubHumanActions.botSkipped, 1);
});

test("⑵ 세 종류가 섞이면 종류별 칸에 갈려 담기고 합계 = 분자 · 못 부른 종류 칸 = null(0 아님)", async () => {
  // 순번 시작 = 닫힌 PR -> 닫힌 PR · 대화 댓글을 부르고 리뷰 줄 댓글은 못 부른다.
  const { result } = await runLists(
    (t) => ({
      closedPrs: [closedPr({ closedAtMs: inWin(t) })],
      issueComments: [
        issueComment({ atMs: inWin(t) }),
        issueComment({ atMs: inWin(t), login: "another-human" }),
      ],
      reviewComments: [reviewComment({ atMs: inWin(t) })],
    }),
    { first: "closedPrs" },
  );
  const g = result.githubHumanActions;
  assert.deepEqual(
    [g.unmergedClose, g.comment, g.reviewComment, g.humanTotal],
    [1, 2, null, 3],
  );
  assert.equal(g.lists.reviewComments.state, "unchecked");
  assert.equal(g.lists.reviewComments.reason, "순번");
  assert.equal(
    numerator(result.reportText),
    `${NUMERATOR_PREFIX}확인 3건 이상 · ${ONE_UNCHECKED}`,
  );
  assert.match(
    ghLine(result.reportText),
    /^- GitHub 사람 손 3건 이상\(댓글 2 · 리뷰 줄 댓글 미조회\(순번\) · 변경 요청 미수집\(ㄱ-4 리뷰 응답 없음\) · 미병합 닫기 1 · 판정 불가 0\)/,
  );
});

test("⑵ 창 필터: since 목록이 돌려준 «창 밖에 만들어졌고 창 안에 고쳐진» 댓글 · 창 끝 뒤 댓글 = 0 · 같은 id 중복 = 1", async () => {
  const { result } = await runLists(
    (t) => ({
      issueComments: [
        issueComment({ atMs: t - 25 * HOUR, updatedAtMs: inWin(t) }),
        issueComment({ atMs: t + 5 * MIN }),
        issueComment({ atMs: inWin(t), id: 90001 }),
        issueComment({ atMs: inWin(t), id: 90001 }),
      ],
    }),
    { first: "issueComments" },
  );
  const g = result.githubHumanActions;
  assert.equal(g.comment, 1);
  assert.equal(g.lists.issueComments.outOfWindow, 2);
  assert.equal(g.lists.issueComments.duplicates, 1);
  assert.deepEqual(g.humanEventIds, ["ic:90001"]);
});

test("⑵ 모양이 어긋난 항목(칸 없음) = 0 이 아니라 판정 불가 K (하한 «이상» 표기) · 정상 항목은 그대로 센다", async () => {
  const run = await runLists(
    (t) => {
      const a = issueComment({ atMs: inWin(t) });
      delete a.user;
      const b = issueComment({ atMs: inWin(t) });
      delete b.created_at;
      const c = issueComment({ atMs: inWin(t) });
      delete c.issue_url;
      return { issueComments: [a, b, c, issueComment({ atMs: inWin(t) })] };
    },
    { first: "issueComments" },
  );
  const g = run.result.githubHumanActions;
  assert.equal(g.undecidable, 3);
  assert.equal(g.comment, 1);
  assert.equal(
    numerator(run.result.reportText),
    `${NUMERATOR_PREFIX}확인 1건 이상 · ${ONE_UNCHECKED} · GitHub 판정 불가 3`,
  );
  assert.match(
    ghLine(run.result.reportText),
    /^- GitHub 사람 손 1건 이상\(.*판정 불가 3\)/,
  );
  const closed = await runLists((t) => {
    const noMerged = closedPr({ closedAtMs: inWin(t) });
    delete noMerged.merged_at;
    const noClosed = closedPr({ closedAtMs: inWin(t) });
    noClosed.closed_at = null;
    return {
      closedPrs: [noMerged, noClosed, closedPr({ closedAtMs: inWin(t) })],
    };
  });
  assert.equal(closed.result.githubHumanActions.undecidable, 2);
  assert.equal(closed.result.githubHumanActions.unmergedClose, 1);
});

test("⑵ 앱 계정(`…[bot]`)이 봇 목록에 없으면 사람으로 센다(부풀리는 쪽 · 목록 추가는 사람 결정) -- 목록에 넣으면 0", async () => {
  const app = "some-app[bot]";
  const data = (t) => ({
    issueComments: [issueComment({ atMs: inWin(t), login: app })],
  });
  const unlisted = await runLists(data, { first: "issueComments" });
  assert.equal(unlisted.result.githubHumanActions.humanTotal, 1);
  const listed = await runLists(data, {
    first: "issueComments",
    bots: JSON.stringify({
      schema_version: "github-bot-accounts/v1",
      bots: [{ login: app }],
    }),
  });
  assert.equal(listed.result.githubHumanActions.humanTotal, 0);
});

test("⑵ 본문(body) 칸 0 읽음 -- 항목에 본문 getter 를 달아도 읽지 않는다", async () => {
  bodyReads.count = 0;
  await runLists(
    (t) => ({
      closedPrs: [withBodyTrap(closedPr({ closedAtMs: inWin(t) }))],
      issueComments: [withBodyTrap(issueComment({ atMs: inWin(t) }))],
      reviewComments: [withBodyTrap(reviewComment({ atMs: inWin(t) }))],
    }),
    { first: "closedPrs" },
  );
  await runLists(
    (t) => ({
      reviewComments: [withBodyTrap(reviewComment({ atMs: inWin(t) }))],
    }),
    { first: "reviewComments" },
  );
  assert.equal(bodyReads.count, 0);
});

test("⑵ 실제 응답 모양 고정: 가짜 항목의 칸 = 책임자 실측 칸 목록 그대로(본문 칸 없음) -- 시험 고정값이 이 칸만임을 못 박는다", () => {
  assert.deepEqual(
    Object.keys(closedPr({ closedAtMs: NOW })),
    CLOSED_PR_FIELDS,
  );
  assert.deepEqual(
    Object.keys(issueComment({ atMs: NOW })),
    ISSUE_COMMENT_FIELDS,
  );
  assert.deepEqual(
    Object.keys(reviewComment({ atMs: NOW })),
    REVIEW_COMMENT_FIELDS,
  );
});

// ---- ⑶ 창 덮음 · 미조회 · 실패 -----------------------------------------------------------------------------------

// 닫힌 PR 100건(updated 내림차순) -- 끝 항목(100번째)만 lastMs 에 닫힘 · 갱신.
const fullClosed = (t, lastMs) =>
  Array.from({ length: 100 }, (_, i) =>
    closedPr({
      closedAtMs: i === 99 ? lastMs : inWin(t) - i * MIN,
    }),
  );
const fullComments = (t, lastAtMs, make) =>
  Array.from({ length: 100 }, (_, i) =>
    make({ atMs: i === 99 ? lastAtMs : inWin(t) - i * MIN }),
  );

test("⑶ 100건 꽉 참 + 끝 항목이 창 안 = 그 목록 미조회(창 덮지 못함) -- 0 이 아니다 · 2쪽 호출 0 · 다른 목록 값은 살아 있다", async () => {
  const { result, calls } = await runLists((t) => ({
    closedPrs: fullClosed(t, inWin(t)),
    issueComments: [issueComment({ atMs: inWin(t) })],
  }));
  assert.equal(calls.lists.closedPrs.length, 1, "2쪽 없음 · 재시도 0");
  const g = result.githubHumanActions;
  assert.equal(g.lists.closedPrs.state, "unchecked");
  assert.equal(g.lists.closedPrs.reason, "창 덮지 못함");
  assert.equal(g.unmergedClose, null, "미조회 = null (0 아님)");
  assert.equal(g.comment, 1, "덮은 목록은 센다");
  assert.match(ghLine(result.reportText), /미병합 닫기 미조회\(창 덮지 못함\)/);
});

test("⑶ 100건 꽉 참 + 끝 항목이 창 시작 이전 = 덮음(정상) · 100건 미만 = 덮음 -- 세 목록 모두", async () => {
  const closed = await runLists((t) => ({
    closedPrs: fullClosed(t, t - 30 * HOUR),
  }));
  assert.equal(closed.result.githubHumanActions.lists.closedPrs.state, "ok");
  assert.equal(
    closed.result.githubHumanActions.unmergedClose,
    99,
    "끝 항목은 창 밖(30시간 전) 닫기 = 0",
  );
  const issues = await runLists(
    (t) => ({
      issueComments: fullComments(t, t - 30 * HOUR, (o) => issueComment(o)),
    }),
    { first: "issueComments" },
  );
  assert.equal(
    issues.result.githubHumanActions.lists.issueComments.state,
    "ok",
  );
  const reviews = await runLists(
    (t) => ({
      reviewComments: fullComments(t, t - 30 * HOUR, (o) => reviewComment(o)),
    }),
    { first: "reviewComments" },
  );
  assert.equal(
    reviews.result.githubHumanActions.lists.reviewComments.state,
    "ok",
  );
  const notFull = await runLists(
    (t) => ({
      issueComments: fullComments(t, inWin(t), issueComment).slice(1),
    }),
    { first: "issueComments" },
  );
  assert.equal(
    notFull.result.githubHumanActions.lists.issueComments.state,
    "ok",
  );
  const commentsFull = await runLists(
    (t) => ({ issueComments: fullComments(t, inWin(t), issueComment) }),
    { first: "issueComments" },
  );
  assert.equal(
    commentsFull.result.githubHumanActions.lists.issueComments.state,
    "unchecked",
  );
  assert.equal(
    commentsFull.result.githubHumanActions.lists.issueComments.reason,
    "창 덮지 못함",
  );
});

test("⑶ 세 목록 모두 요청 URL 모양 고정: 저장소 단위 · per_page=100 · 창 시작 since(댓글 둘) · 닫힌 PR 은 updated 내림차순 · PR 마다 조회 0", async () => {
  const run = await runLists({}, { first: "closedPrs" });
  assert.deepEqual(run.calls.lists.closedPrs, [
    `https://api.github.com/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
  ]);
  const second = await runLists({}, { first: "issueComments" });
  assert.deepEqual(second.calls.lists.issueComments, [
    `https://api.github.com/repos/${REPO}/issues/comments?since=${iso(second.now - 24 * HOUR)}&sort=created&direction=desc&per_page=100`,
  ]);
  assert.deepEqual(second.calls.lists.reviewComments, [
    `https://api.github.com/repos/${REPO}/pulls/comments?since=${iso(second.now - 24 * HOUR)}&sort=created&direction=desc&per_page=100`,
  ]);
  // 후보 0 회차의 호출은 이 두 가지 목록뿐 -- 어떤 호출도 PR 번호를 URL 에 싣지 않는다.
  assert.equal(
    second.calls.all.every((u) => !/\/pulls\/\d+/.test(u)),
    true,
  );
});

for (const status of [403, 429]) {
  test(`⑶ HTTP ${status} = 미조회(rate limit) -- 0 아님 · 재시도 0 · 그 뒤 다른 목록도 부르지 않는다(호출 1)`, async () => {
    const { result, calls } = await runLists(
      { closedPrs: { ok: false, status, json: null, linkHeader: null } },
      { first: "closedPrs" },
    );
    assert.equal(calls.all.length, 1, "재시도 0 · 다음 목록 호출 0");
    const g = result.githubHumanActions;
    assert.equal(g.known, false);
    assert.equal(g.unchecked, true);
    assert.match(g.reason, new RegExp(`rate limit.*HTTP ${status}`));
    assert.match(
      ghLine(result.reportText),
      /^- GitHub 사람 손 미조회\(rate limit/,
    );
    assert.equal(
      numerator(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건 이상 · GitHub 사람 손 미조회`,
    );
  });
}

test("⑶ 한 목록 404 · 모양 위반(배열 아님) · 던짐 = 그 목록 수집 실패(0 아님) · 다른 목록이 성공하면 부분 결과 + «목록 1개 수집 실패»", async () => {
  const partial = await runLists(
    {
      closedPrs: { ok: false, status: 404, json: null, linkHeader: null },
      issueComments: [],
    },
    { first: "closedPrs" },
  );
  const pg = partial.result.githubHumanActions;
  assert.equal(pg.known, true);
  assert.equal(pg.lists.closedPrs.state, "failed");
  assert.equal(pg.unmergedClose, null);
  assert.equal(pg.comment, 0, "성공한 빈 목록 = 진짜 0");
  assert.equal(
    numerator(partial.result.reportText),
    `${NUMERATOR_PREFIX}확인 0건 이상 · ${ONE_UNCHECKED} · GitHub 사람 손 목록 1개 수집 실패`,
  );
  assert.match(ghLine(partial.result.reportText), /미병합 닫기 수집 실패\(/);
  const allFail = await runLists(
    {
      closedPrs: ok200({ message: "not an array" }),
      issueComments: { ok: false, status: 500, json: null, linkHeader: null },
    },
    { first: "closedPrs" },
  );
  const ag = allFail.result.githubHumanActions;
  assert.equal(ag.known, false);
  assert.notEqual(ag.unchecked, true);
  assert.match(ag.reason, /모양 위반/);
  assert.match(
    ghLine(allFail.result.reportText),
    /^- GitHub 사람 손 수집 실패\(/,
  );
  assert.match(
    numerator(allFail.result.reportText),
    /^- 외부 독립 증거로 확인된 사건: 확인 0건 이상 · GitHub 사람 손 수집 실패$/,
  );
  const repo = buildRepo([]);
  const throwing = await runDefault(
    repo,
    async ({ url }) => {
      if (/\/pulls\?|\/issues\/comments\?|\/pulls\/comments\?/.test(url)) {
        throw new Error("boom");
      }
      return FAIL404;
    },
    { now: nowWithOffset(0) },
  );
  assert.equal(throwing.githubHumanActions.known, false);
  assert.match(throwing.githubHumanActions.reason, /boom/);
});

test("⑶ 봇 목록 없음 · 깨짐 · 스키마 불일치 · 비어 있음 = 수집 실패(0 아님) · 그때 목록 REST 호출 0", async () => {
  const variants = {
    없음: null,
    "깨진 JSON": "{ not json",
    "스키마 불일치": JSON.stringify({
      schema_version: "x/v9",
      bots: [{ login: BOT_A }],
    }),
    "빈 목록": JSON.stringify({
      schema_version: "github-bot-accounts/v1",
      bots: [],
    }),
    "login 모양 위반": JSON.stringify({
      schema_version: "github-bot-accounts/v1",
      bots: [{ login: 7 }],
    }),
  };
  for (const [name, bots] of Object.entries(variants)) {
    const { result, calls } = await runLists(
      (t) => ({ issueComments: [issueComment({ atMs: inWin(t) })] }),
      { bots, first: "issueComments" },
    );
    assert.equal(result.githubHumanActions.known, false, name);
    assert.notEqual(result.githubHumanActions.unchecked, true, name);
    assert.match(result.githubHumanActions.reason, /봇 목록/, name);
    assert.equal(
      calls.lists.closedPrs.length +
        calls.lists.issueComments.length +
        calls.lists.reviewComments.length,
      0,
      `${name}: 목록 호출 0`,
    );
    // 사유에 git stderr 의 개행이 섞여도 보고문 줄 · 관측 건강 줄이 «한 줄» 로 남는다.
    assert.equal(/[\r\n]/.test(result.githubHumanActions.reason), false, name);
    assert.match(
      ghLine(result.reportText),
      /^- GitHub 사람 손 수집 실패\(봇 목록 읽기 실패: [^\r\n]*\) — ㄴ 확인 건수에 미반영 · 0 아님$/,
      name,
    );
    assert.equal(
      numerator(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건 이상 · GitHub 사람 손 수집 실패`,
      name,
    );
  }
});

// ---- ⑷ 예산 · 순번 (시간당 48 무변 · 회차 총 ≤ 12) -------------------------------------------------------------------

test("⑷ 상수: 회차 총 12 = ㄱ-4(1 × callBudget 8) + D1(4) · 시간당 12 × 4 = 48 · P3 몫 상한 2 · ㄱ-4 · D1 상한 무변", () => {
  assert.equal(report.DEFAULT_MAX_MERGE_CHECKS, 1);
  assert.equal(report.DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS, 4);
  assert.equal(
    report.PER_TICK_CALL_CEILING,
    report.DEFAULT_MAX_MERGE_CHECKS * DEFAULT_CALL_BUDGET +
      report.DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS,
  );
  assert.equal(report.PER_TICK_CALL_CEILING * 4, 48);
  assert.equal(report.GITHUB_HUMAN_MAX_CALLS, 2);
});

test("⑷ 몫 함수: min(2, 12 - 사용) · 음수 없음 -- 사용 0→2 · 10→2 · 11→1 · 12→0 · 15→0", () => {
  const b = report.githubHumanBudget;
  assert.deepEqual(
    [0, 10, 11, 12, 15].map((u) => b(u)),
    [2, 2, 1, 0, 0],
  );
});

test("⑷ 순번 규칙: 회차 시각에서만 정한다(같은 시각 = 같은 순번 · 상태 0) -- floor(시각/15분) % 3 에서 시작해 돌린다", () => {
  const order = report.githubListOrder;
  for (const t of [NOW, NOW + TICK_MS, NOW + 2 * TICK_MS, NOW + 3 * TICK_MS]) {
    assert.deepEqual(order(t), expectedOrder(t));
    assert.deepEqual(order(t), order(t), "같은 시각 = 같은 순번");
  }
  assert.deepEqual(
    [0, 1, 2].map((k) => order(nowWithOffset(k))[0]),
    LIST_KEYS,
    "세 연속 회차의 맨 앞 = 세 목록이 한 번씩",
  );
});

test("⑷ 순번 3 회차: 회차마다 정확히 2 목록 호출 · 세 회차 합쳐 세 목록 모두 한 번 이상 · 못 부른 목록 = 미조회(순번)", async () => {
  const seen = new Set();
  for (let k = 0; k < 3; k++) {
    const { calls, result, now } = await runLists({}, { first: LIST_KEYS[k] });
    assert.equal(calls.order.length, 2, "회차당 목록 호출 2");
    assert.deepEqual(calls.order, expectedOrder(now).slice(0, 2));
    for (const key of calls.order) seen.add(key);
    const g = result.githubHumanActions;
    const skipped = LIST_KEYS.filter((key) => !calls.order.includes(key));
    assert.equal(skipped.length, 1);
    assert.equal(g.lists[skipped[0]].state, "unchecked");
    assert.equal(g.lists[skipped[0]].reason, "순번");
  }
  assert.deepEqual([...seen].sort(), [...LIST_KEYS].sort());
});

test("⑷ 최악 입력(ㄱ-4 10 + D1 2 = 앞의 둘이 12 를 다 씀) -> P3 목록 호출 0 · 미조회(예산) · 회차 총 ≤ 12 (0 아님)", async () => {
  const { result, calls } = await runLists(
    (t) => ({ issueComments: [issueComment({ atMs: inWin(t) })] }),
    {
      ubCounts: [2, 2, 1],
      extra: { maxMergeChecks: 2, maxExternalEvidenceChecks: 2 },
    },
  );
  assert.equal(calls.gate4.length, 10, "ㄱ-4 2 sha × 5");
  assert.equal(calls.d1.length, 2, "D1 2");
  assert.equal(calls.order.length, 0, "P3 호출 0");
  assert.ok(calls.all.length <= 12, `회차 총 ${calls.all.length} > 12`);
  const g = result.githubHumanActions;
  assert.equal(g.known, false);
  assert.equal(g.unchecked, true);
  assert.equal(g.reason, "예산");
  assert.equal(
    ghLine(result.reportText),
    `${GH_PREFIX}미조회(예산) — ㄴ 확인 건수에 미반영 · 0 아님`,
  );
  assert.equal(
    numerator(result.reportText),
    `${NUMERATOR_PREFIX}확인 2건 이상 · 미조회 3 · GitHub 사람 손 미조회`,
  );
});

test("⑷ 기본 옵션 최악(ㄱ-4 후보 3 · D1 후보 5 -- 상한까지 조회) -> 합 ≤ 12 · 시간당 ≤ 48 · P3 몫은 남은 만큼(여기서는 2 목록)", async () => {
  const { result, calls } = await runLists(
    (t) => ({ issueComments: [issueComment({ atMs: inWin(t) })] }),
    { ubCounts: [2, 2, 1], first: "issueComments" },
  );
  assert.equal(calls.gate4.length + calls.d1.length, 9);
  assert.equal(result.githubHumanActions.budget, 2);
  assert.equal(calls.order.length, 2);
  assert.equal(result.githubHumanActions.humanTotal, 1);
  assert.ok(calls.all.length <= 12);
  assert.ok(calls.all.length * 4 <= 48);
});

test("⑷ 몫 1(앞의 둘이 11 사용: ㄱ-4 2 sha 10 + D1 1) -> 목록 1개만 부른다 · 나머지 둘 = 미조회 · 회차 총 ≤ 12", async () => {
  const { result, calls, now } = await runLists(
    (t) => ({ closedPrs: [closedPr({ closedAtMs: inWin(t) })] }),
    {
      ubCounts: [2, 1],
      extra: { maxMergeChecks: 2, maxExternalEvidenceChecks: 1 },
      first: "closedPrs",
    },
  );
  assert.equal(calls.gate4.length + calls.d1.length, 11);
  assert.equal(calls.order.length, 1);
  assert.deepEqual(calls.order, expectedOrder(now).slice(0, 1));
  const g = result.githubHumanActions;
  assert.equal(g.known, true);
  assert.equal(g.budget, 1);
  assert.equal(g.unmergedClose, 1);
  assert.equal(g.lists.issueComments.state, "unchecked");
  assert.equal(g.lists.issueComments.reason, "예산");
  assert.equal(g.lists.reviewComments.reason, "순번");
  assert.ok(calls.all.length <= 12);
  // D1 확인 1(상한 1 로 조회한 Update branch 1건) + P3 미병합 닫기 1 = 2 · D1 미조회 2 · 못 부른 P3 목록 2개.
  assert.equal(
    numerator(result.reportText),
    `${NUMERATOR_PREFIX}확인 2건 이상 · 미조회 2 · GitHub 사람 손 목록 2개 미조회`,
  );
});

test("⑷ 여유 입력(ㄱ-4 · D1 후보 있음) -> P3 호출 ≤ 2 · 회차 총 ≤ 12 · 호출 순서 = 기존 둘 먼저 · P3 마지막", async () => {
  const { calls } = await runLists({}, { ubCounts: [1], first: "closedPrs" });
  assert.equal(calls.order.length, 2);
  assert.ok(calls.all.length <= 12);
  const lastNonList = Math.max(
    ...calls.all.map((u, i) =>
      /\/pulls\?|\/issues\/comments\?|\/pulls\/comments\?/.test(u) ? -1 : i,
    ),
  );
  const firstList = calls.all.findIndex((u) =>
    /\/pulls\?|\/issues\/comments\?|\/pulls\/comments\?/.test(u),
  );
  assert.ok(firstList > lastNonList, "P3 는 ㄱ-4 · D1 뒤에 부른다");
});

// HYK-255-g3-record-1 (설계 (라) · 뜻 무변 단언 추가) -- ㄱ-3 GitHub 기록(S4)은 P3 «뒤» 남는 몫만 쓴다. 켜도 P3 목록 호출 수 · 순서 · 값은 끈 회차와 같다.
test("⑷ ㄱ-3 GitHub 기록(S4)을 켜도 P3 몫 무변: P3 목록 호출 수 · 순서 · 값은 끈 회차와 같고 S4 목록은 P3 뒤에 min(2, 12 - 앞 사용) 몫으로만 불린다(총 ≤ 12)", async () => {
  const lists = (t) => ({ issueComments: [issueComment({ atMs: inWin(t) })] });
  const off = await runLists(lists, {
    ubCounts: [2, 1],
    first: "issueComments",
  });
  const now = off.now;
  const repo = buildRepo([2, 1]);
  const { fetchJson: inner, calls } = makeFetch(repo, {
    lists: lists(now),
    nowMs: now,
  });
  const g3Calls = [];
  const wrapped = async (args) => {
    if (/\/pulls\?state=all&base=gate3-record/.test(args.url)) {
      g3Calls.push(calls.all.length);
      return ok200([]);
    }
    return inner(args);
  };
  const on = await runDefault(repo, wrapped, {
    now,
    gate3RecordBase: "gate3-record",
  });
  // P3 는 켜도 끈 회차와 같다(호출 수 · 순서 · 값).
  assert.deepEqual(calls.order, off.calls.order);
  assert.equal(
    on.githubHumanActions.humanTotal,
    off.result.githubHumanActions.humanTotal,
  );
  assert.equal(
    on.githubHumanActions.budget,
    off.result.githubHumanActions.budget,
  );
  // S4 몫 = min(2, 12 - 앞 셋이 쓴 수) -- 시험이 관측한 «앞 셋 사용» 으로 손 계산한 기대(목록 1 + 상세 0: 빈 목록).
  const usedBeforeS4 = calls.all.length;
  const s4Budget = Math.min(2, 12 - usedBeforeS4);
  assert.equal(g3Calls.length, s4Budget >= 1 ? 1 : 0, "S4 목록 호출 수");
  assert.deepEqual(
    g3Calls,
    s4Budget >= 1 ? [usedBeforeS4] : [],
    "P3 뒤에 부른다",
  );
  assert.ok(usedBeforeS4 + g3Calls.length <= 12, "회차 총 ≤ 12 무변");
});

test("⑷ 사건 목록 호출 0 -- 어떤 회차에서도 /events 를 부르지 않는다 · 코드에 사건 목록 원천 0", async () => {
  for (let k = 0; k < 3; k++) {
    const { calls } = await runLists(
      {},
      { first: LIST_KEYS[k], ubCounts: [1] },
    );
    assert.equal(calls.events.length, 0);
  }
  const src = fs.readFileSync(
    new URL("./partial-count-report.mjs", import.meta.url),
    "utf8",
  );
  const code = fs.readFileSync(
    new URL("./partial-count-core.mjs", import.meta.url),
    "utf8",
  );
  // 줄 주석만 걷는다(`https://` 의 `//` 는 앞이 공백이 아니라 남는다).
  const stripComments = (text) => text.replace(/(^|\s)\/\/.*$/gm, "$1");
  for (const [name, text] of [
    ["report", src],
    ["core", code],
  ]) {
    assert.equal(/\/events\b/.test(stripComments(text)), false, name);
    assert.equal(
      /PullRequestReviewCommentEvent|IssueCommentEvent|PullRequestEvent|PullRequestReviewEvent/.test(
        stripComments(text),
      ),
      false,
      `${name}: 사건 종류 분류 코드`,
    );
  }
});

// ---- ⑸ 변경 요청 (ㄱ-4 가 이미 받는 리뷰 응답에서 · 추가 조회 0 · 없으면 미수집 = 0 아님) -------------------------------------

const crReview = (t, over = {}) => ({
  id: 77,
  user: { login: HUMAN, id: 4242 },
  state: "CHANGES_REQUESTED",
  commit_id: PULL_HEAD_SHA,
  submitted_at: iso(inWin(t)),
  ...over,
});

test("⑸ 변경 요청: ㄱ-4 가 받은 리뷰 응답의 CHANGES_REQUESTED(창 안 · 사람) = 1 · 읽은 PR 1건 한정 표기 · 추가 호출 0", async () => {
  const base = await runLists({}, { ubCounts: [0], first: "closedPrs" });
  const withCr = await runLists(
    {},
    {
      ubCounts: [0],
      first: "closedPrs",
      reviewExtra: (t) => [crReview(t)],
    },
  );
  const g = withCr.result.githubHumanActions;
  assert.equal(g.changeRequest, 1);
  assert.equal(g.changeRequestPrs, 1);
  assert.equal(g.humanTotal, 1);
  assert.equal(
    withCr.calls.all.length,
    base.calls.all.length,
    "변경 요청을 세려고 늘어난 호출 0",
  );
  assert.match(
    ghLine(withCr.result.reportText),
    /변경 요청 1\(ㄱ-4 가 읽은 PR 1건 한정\)/,
  );
  assert.equal(
    base.result.githubHumanActions.changeRequest,
    0,
    "읽었고 없으면 진짜 0",
  );
  assert.equal(base.result.githubHumanActions.changeRequestPrs, 1);
});

test("⑸ 변경 요청: 봇 · 승인 · 일반 리뷰 · 창 밖 · 같은 id 중복 = 0 (소문자 state 도 흡수)", async () => {
  const { result } = await runLists(
    {},
    {
      ubCounts: [0],
      first: "closedPrs",
      reviewExtra: (t) => [
        crReview(t, { id: 11, user: { login: BOT_A, id: 1 } }),
        crReview(t, {
          id: 12,
          state: "COMMENTED",
          submitted_at: iso(inWin(t) - MIN),
        }),
        crReview(t, {
          id: 13,
          state: "DISMISSED",
          submitted_at: iso(inWin(t) - 2 * MIN),
        }),
        crReview(t, { id: 14, submitted_at: iso(t - 30 * HOUR) }),
        crReview(t, {
          id: 15,
          state: "changes_requested",
          submitted_at: iso(inWin(t) - 3 * MIN),
        }),
        crReview(t, {
          id: 15,
          state: "changes_requested",
          submitted_at: iso(inWin(t) - 3 * MIN),
        }),
      ],
    },
  );
  assert.equal(result.githubHumanActions.changeRequest, 1);
});

test("⑸ 변경 요청 미수집: ㄱ-4 후보 0(리뷰 응답 없음) -> null + «미수집» 표기 · 0 으로 적지 않는다 · 합계에 안 들어간다", async () => {
  const { result } = await runLists(
    (t) => ({ closedPrs: [closedPr({ closedAtMs: inWin(t) })] }),
    { first: "closedPrs" },
  );
  const g = result.githubHumanActions;
  assert.equal(g.changeRequest, null);
  assert.equal(g.changeRequestPrs, 0);
  assert.equal(g.humanTotal, 1);
  const line = ghLine(result.reportText);
  assert.match(line, /변경 요청 미수집\(ㄱ-4 리뷰 응답 없음\)/);
  assert.equal(/변경 요청 0/.test(line), false, "변경 요청 0 표기 금지");
});

// ---- ⑹ 봇 이름 리터럴 0 (코드) ---------------------------------------------------------------------------------

test("⑹ 코드에 봇 이름 리터럴 0 -- 설정 파일의 login 이 수집기 · 코어 소스에 없다 · 설정 파일은 스키마대로", () => {
  const cfg = JSON.parse(
    fs.readFileSync(
      new URL("./github-bot-accounts.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(cfg.schema_version, "github-bot-accounts/v1");
  assert.ok(Array.isArray(cfg.bots) && cfg.bots.length >= 1);
  for (const file of [
    "partial-count-report.mjs",
    "partial-count-core.mjs",
    "partial-count-rescan-core.mjs",
    "partial-count-rescan.mjs",
  ]) {
    const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const bot of cfg.bots) {
      assert.equal(src.includes(bot.login), false, `${file} 에 봇 이름 리터럴`);
    }
    assert.equal(
      /\[bot\]/.test(src.replace(/\/\/.*$/gm, "")),
      false,
      `${file} 코드에 앱 계정 리터럴`,
    );
  }
});

// ---- ⑺ 일별 칸 -- 세 목록이 그날을 «모두» 덮을 때만 수 ----------------------------------------------------------------

const kst = (s) =>
  Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+09:00`);

// 일별 시험은 프로덕션 수집기(collectGithubHumanActions)를 15분 간격으로 직접 돌린다. 세계 = {kind, id, atMs} 목록 -- 가짜 목록 응답이
// 실제 목록 의미를 흉내낸다(닫힌 PR = 닫힌 시각이 회차 이전인 것 최신순 100건 · 댓글 = since 이후 갱신분 최신순 100건).
function worldFetch(world, nowMs, { failKey = null } = {}) {
  const pick = (kind) =>
    world
      .filter((w) => w.kind === kind && w.atMs <= nowMs)
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, 100);
  return async ({ url }) => {
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    const key = /^\/pulls\?/.test(path)
      ? "closedPrs"
      : /^\/issues\/comments\?/.test(path)
        ? "issueComments"
        : /^\/pulls\/comments\?/.test(path)
          ? "reviewComments"
          : null;
    if (key === null) return FAIL404;
    if (failKey === key) {
      return { ok: false, status: 500, json: null, linkHeader: null };
    }
    if (key === "closedPrs") {
      return ok200(
        pick("closedPr").map((w) =>
          closedPr({ closedAtMs: w.atMs, id: w.id, login: w.login ?? HUMAN }),
        ),
      );
    }
    if (key === "issueComments") {
      return ok200(
        pick("issueComment").map((w) =>
          issueComment({ atMs: w.atMs, id: w.id, login: w.login ?? HUMAN }),
        ),
      );
    }
    return ok200(
      pick("reviewComment").map((w) =>
        reviewComment({ atMs: w.atMs, id: w.id, login: w.login ?? HUMAN }),
      ),
    );
  };
}

// 실제 git 은 1회만 -- 같은 인자는 캐시(일별 시험은 수백 회차를 돈다).
function cachedGit(repo) {
  const real = report.createProcessGitPort(repo.dir);
  const cache = new Map();
  return {
    run(args) {
      const k = args.join("\u0000");
      if (!cache.has(k)) cache.set(k, real.run(args));
      return cache.get(k);
    },
  };
}

async function collectAt(env, nowMs, opts = {}) {
  // failWhen(시각) -> 그 회차에 500 을 줄 목록 이름 | null (없으면 failKey 고정).
  const failKey = opts.failWhen ? opts.failWhen(nowMs) : (opts.failKey ?? null);
  return report.collectGithubHumanActions({
    fetchJson: worldFetch(env.world, nowMs, { failKey }),
    git: env.git,
    allowlistPath: ALLOWLIST_PATH,
    botAccountsPath: BOTS_PATH,
    windowStartMs: nowMs - 24 * HOUR,
    windowEndMs: nowMs,
    budget: 2,
  });
}

const tickValues = (g, windowStartMs) =>
  core.buildDailyTickValues({
    externalEvidence: { known: true, confirmedShas: [], unchecked: 0 },
    collectors: [],
    delivered: { known: true, count: 1 },
    uncountedExamples: { items: [], version: "v1" },
    githubHumanActions: g,
    windowStartMs,
  });

// days = [{day, from, to, failKey?}] -- 15분 간격. 마감 줄과 «마감 직전 상태»(그날 마지막 회차까지 적은 상태)를 모은다.
async function simulate(env, days) {
  let state = null;
  const lines = [];
  const states = {};
  for (const { day, from, to, ...opts } of days) {
    for (
      let t = kst(`${day} ${from}`);
      t <= kst(`${day} ${to}`);
      t += TICK_MS
    ) {
      const rolled = core.rolloverDailyState({
        state,
        nowMs: t,
        closedDays: new Set(lines.map((l) => l.day)),
      });
      if (rolled.closedLine) {
        lines.push(rolled.closedLine);
        states[rolled.closedLine.day] = state;
      }
      const g = await collectAt(env, t, opts);
      state = core.recordDailyTick({
        state: rolled.state,
        nowMs: t,
        tick: tickValues(g, t - 24 * HOUR),
        concurrentActive: 0,
      });
    }
  }
  return { state, lines, states };
}

function dayEnv(world) {
  const repo = buildRepo([]);
  return { repo, world, git: cachedGit(repo) };
}
const at = (day, hhmm) => kst(`${day} ${hhmm}`);
const THREE_KINDS = (day, hhmm, base) => [
  { kind: "closedPr", id: base + 1, atMs: at(day, hhmm) },
  { kind: "issueComment", id: base + 2, atMs: at(day, hhmm) },
  { kind: "reviewComment", id: base + 3, atMs: at(day, hhmm) },
];
const lineOf = (lines, day) => lines.find((l) => l.day === day);

test("⑺ 일별 칸 = 세 목록이 그날을 덮을 때만 수: 둘째 날(앞 날 덮음 이어받음) = 값 + 덮음 범위 단언 · 첫 날(앞 날 기록 없음) = null + 사유", async () => {
  const world = [
    ...THREE_KINDS("2026-11-10", "08:10", 100),
    ...THREE_KINDS("2026-11-11", "09:20", 200),
    { kind: "issueComment", id: 301, atMs: at("2026-11-11", "14:05") },
  ];
  const env = dayEnv(world);
  const { lines, states } = await simulate(env, [
    { day: "2026-11-10", from: "00:00", to: "23:45" },
    { day: "2026-11-11", from: "00:00", to: "23:45" },
    { day: "2026-11-12", from: "00:00", to: "00:15" },
  ]);
  const first = lineOf(lines, "2026-11-10");
  assert.equal(first.githubHumanActions, null, "첫 날은 앞 날 덮음이 없다");
  assert.match(first.githubHumanActionsGap, /덮지 못함/);
  const second = lineOf(lines, "2026-11-11");
  // 앞 날 줄이 null 이라 앞 줄이 세지 않은 사건 = 둘째 날이 처음 센다(값을 잃지 않는다): 첫날 3 + 둘째 날 4.
  assert.equal(second.githubHumanActions, 7);
  assert.equal(second.githubHumanActionsGap, undefined);
  // 덮음 범위 단언: 값이 센 범위 = 줄의 창 표기 · 세 목록 모두의 덮음 구간이 [창 시작, 마지막 회차 - 여유] 를 이어서 덮는다.
  const st = states["2026-11-11"];
  assert.equal(second.windowStartMs, st.firstWindowStartMs);
  assert.equal(second.windowEndMs, st.lastTickAtMs);
  for (const key of LIST_KEYS) {
    const spans = st.githubListCover[key];
    assert.equal(
      spans.some(
        ([s, e]) =>
          s <= second.windowStartMs &&
          e >= second.windowEndMs - core.GITHUB_LIST_TAIL_SLACK_MS,
      ),
      true,
      `${key} 덮음 구간이 그날 범위를 덮는다`,
    );
  }
});

test("⑺ 일별 칸: 앞 줄이 센 사건은 다음 날 다시 보여도 중복 0 (사건 id) · 마지막 회차 뒤에 생긴 사건은 다음 날 처음 본 것으로 센다", async () => {
  const world = [
    ...THREE_KINDS("2026-11-10", "08:10", 100),
    ...THREE_KINDS("2026-11-11", "09:20", 200),
    // 11-11 의 마지막 회차(23:45) 뒤에 생긴 댓글 -- 11-11 줄은 못 센다 -> 11-12 줄이 센다.
    { kind: "issueComment", id: 401, atMs: at("2026-11-11", "23:58") },
    { kind: "reviewComment", id: 402, atMs: at("2026-11-12", "10:10") },
  ];
  const env = dayEnv(world);
  const { lines } = await simulate(env, [
    { day: "2026-11-10", from: "00:00", to: "23:45" },
    { day: "2026-11-11", from: "00:00", to: "23:45" },
    { day: "2026-11-12", from: "00:00", to: "23:45" },
    { day: "2026-11-13", from: "00:00", to: "00:15" },
  ]);
  assert.equal(
    lineOf(lines, "2026-11-11").githubHumanActions,
    6,
    "첫날 3 + 둘째 날 3",
  );
  assert.equal(
    lineOf(lines, "2026-11-12").githubHumanActions,
    2,
    "23:58 댓글(11-11 밤) + 10:10 리뷰 줄 댓글 -- 앞 줄이 센 6건은 중복 0",
  );
});

test("⑺ 빈틈 = null + 사유: 한 목록이 그날 내내 실패(500)하면 그날 칸은 null · 사유에 그 목록 이름 · 값을 지어내지 않는다", async () => {
  const world = [
    ...THREE_KINDS("2026-11-10", "08:10", 100),
    ...THREE_KINDS("2026-11-11", "09:20", 200),
  ];
  const env = dayEnv(world);
  const { lines } = await simulate(env, [
    { day: "2026-11-10", from: "00:00", to: "23:45" },
    {
      day: "2026-11-11",
      from: "00:00",
      to: "23:45",
      failKey: "reviewComments",
    },
    { day: "2026-11-12", from: "00:00", to: "00:15" },
  ]);
  const gap = lineOf(lines, "2026-11-11");
  assert.equal(gap.githubHumanActions, null);
  assert.match(gap.githubHumanActionsGap, /리뷰 줄 댓글 덮지 못함/);
  assert.equal(
    /닫힌 PR 덮지 못함|대화 댓글 덮지 못함/.test(gap.githubHumanActionsGap),
    false,
  );
});

test("⑺ 몇 시간 못 부른 것만으로는 덮음이 끊기지 않는다: 한낮 6시간 한 목록이 실패해도 24시간 창이 이어 붙어 값이 난다 · 24시간을 넘는 공백이면 null", async () => {
  const world = THREE_KINDS("2026-11-11", "09:20", 200);
  const env = dayEnv(world);
  const during = (from, to, key) => (t) =>
    t >= at("2026-11-11", from) && t <= at("2026-11-11", to) ? key : null;
  const short = await simulate(env, [
    { day: "2026-11-10", from: "00:00", to: "23:45" },
    {
      day: "2026-11-11",
      from: "00:00",
      to: "23:45",
      failWhen: during("10:00", "16:00", "reviewComments"),
    },
    { day: "2026-11-12", from: "00:00", to: "00:15" },
  ]);
  assert.equal(
    lineOf(short.lines, "2026-11-11").githubHumanActions,
    3,
    "6시간 공백 = 24시간 창이 이어 붙인다",
  );
  // 다음 날 다시 한 목록이 하루 내내 실패하고 그날은 앞 날 끝에서 24시간 넘게 끊긴다 -> null.
  const long = await simulate(dayEnv(world), [
    { day: "2026-11-10", from: "00:00", to: "23:45" },
    { day: "2026-11-11", from: "00:00", to: "23:45" },
    {
      day: "2026-11-12",
      from: "00:00",
      to: "23:45",
      failKey: "issueComments",
    },
    { day: "2026-11-13", from: "00:00", to: "00:15" },
  ]);
  const gap = lineOf(long.lines, "2026-11-12");
  assert.equal(gap.githubHumanActions, null);
  assert.match(gap.githubHumanActionsGap, /대화 댓글 덮지 못함/);
});

test("⑺ 회차 값: 수집 성공 = 칸 수 + 사건 식별자 `gh:<목록 접두>:<id>` · 덮음 구간 · 미조회 · 실패 = null(0 아님) · 미결선 = 칸 없음", async () => {
  const world = THREE_KINDS("2026-11-13", "08:10", 100);
  const env = dayEnv(world);
  const t = at("2026-11-13", "10:00");
  const g = await collectAt(env, t);
  const tick = tickValues(g, t - 24 * HOUR);
  assert.equal(typeof tick.githubHumanActions, "number");
  assert.equal(
    tick.confirmedEventIds.every((id) => /^gh:(pr|ic|rc):\d+$/.test(id)),
    true,
    JSON.stringify(tick.confirmedEventIds),
  );
  const okKeys = LIST_KEYS.filter((k) => g.lists[k].state === "ok");
  assert.equal(okKeys.length, 2);
  for (const k of LIST_KEYS) {
    assert.deepEqual(
      tick.githubListCover[k],
      okKeys.includes(k) ? { startMs: t - 24 * HOUR, endMs: t } : null,
      k,
    );
  }
  const unchecked = tickValues({
    known: false,
    unchecked: true,
    reason: "예산",
  });
  assert.equal(unchecked.githubHumanActions, null);
  assert.deepEqual(unchecked.confirmedEventIds, []);
  assert.equal(
    tickValues({ known: false, reason: "x" }).githubHumanActions,
    null,
  );
  assert.equal(
    Object.hasOwn(tickValues(undefined), "githubHumanActions"),
    false,
  );
  assert.equal(Object.hasOwn(tickValues(null), "githubHumanActions"), false);
  assert.equal(Object.hasOwn(tickValues(undefined), "githubListCover"), false);
});

test("⑺ 회차 값 모양 = 프로덕션 수집 결과와 같다 -- 시험 helper 의 가짜 결과가 프로덕션 칸 이름에서 벗어나지 않는다(헛시험 방지)", async () => {
  const { result } = await runLists({}, { first: "closedPrs" });
  const g = result.githubHumanActions;
  const direct = await collectAt(dayEnv([]), at("2026-11-13", "10:00"));
  assert.deepEqual(Object.keys(direct).sort(), Object.keys(g).sort());
  for (const k of [
    "known",
    "comment",
    "reviewComment",
    "changeRequest",
    "unmergedClose",
    "humanTotal",
    "undecidable",
    "humanEventIds",
    "lists",
    "listCover",
    "budget",
  ]) {
    assert.equal(Object.hasOwn(g, k), true, `수집 결과 칸 ${k}`);
  }
});

test("⑺ 연속 확인-0: 새 칸이 있는 줄에서 값 > 0 · null 이면 끊김 사유(빈틈 사유 병기) · 0 이면 이어짐 · 칸 없는 옛 줄은 끊김(HYK-255-p2c-nofield-1 · 판정 1404)", () => {
  const base = (day, extra) => ({
    schema: core.DAILY_SCHEMA,
    day,
    lnConfirmed: 0,
    lnUnchecked: 0,
    collectorFails: [],
    coverageGaps: { count: 0, totalMs: 0 },
    uncountedExampleIds: [],
    // 권한 칸은 이 시험의 관심 밖이라 «있고 0» 으로 둔다(GitHub 칸만 시험마다 넣거나 뺀다).
    permissionHumanAnswers: 0,
    permissionUndecidable: 0,
    ...extra,
  });
  const nowMs = kst("2026-11-14 09:00");
  const streak = (extra) =>
    core.computeConfirmedZeroStreak({
      lines: [base("2026-11-13", extra)],
      nowMs,
    });
  assert.equal(streak({ githubHumanActions: 0 }).days, 1);
  const noField = streak({});
  assert.equal(
    noField.days,
    0,
    "GitHub 칸 없는 줄 = 끊김(옛 규칙 «무변» 이 뒤집혔다)",
  );
  assert.deepEqual(noField.lastBreak.reasons, ["GitHub 사람 손 조작 칸 없음"]);
  const positive = streak({ githubHumanActions: 3 });
  assert.equal(positive.days, 0);
  assert.deepEqual(positive.lastBreak.reasons, ["GitHub 사람 손 조작 3"]);
  const unknown = streak({ githubHumanActions: null });
  assert.equal(unknown.days, 0);
  assert.deepEqual(unknown.lastBreak.reasons, ["GitHub 사람 손 조작 UNKNOWN"]);
  const withGap = streak({
    githubHumanActions: null,
    githubHumanActionsGap: "목록 대화 댓글 덮지 못함",
  });
  assert.deepEqual(withGap.lastBreak.reasons, [
    "GitHub 사람 손 조작 UNKNOWN(목록 대화 댓글 덮지 못함)",
  ]);
});

test("⑺ 일별 사건 접두 = 기존 관례 -- sha: · perm: 와 겹치지 않는 gh: 한 종류만 늘었다", () => {
  assert.equal(core.DAILY_EVENT_PREFIX.D1, "sha:");
  assert.equal(core.DAILY_EVENT_PREFIX.PERMISSION, "perm:");
  assert.equal(core.DAILY_EVENT_PREFIX.GITHUB, "gh:");
});

// ---- ⑻ 렌더 ----------------------------------------------------------------------------------------------------

const renderInput = () => ({
  generatedAtMs: NOW,
  windowStartMs: NOW - 24 * HOUR,
  windowEndMs: NOW,
  delivered: { known: true, count: 2 },
  consumed: { known: true, count: 2 },
  missingReceipts: { known: true, count: 0 },
  gate4: {
    known: true,
    candidatesInWindow: 0,
    checked: 0,
    approved: 0,
    notApproved: 0,
    undecidable: 0,
    uncheckedByBudget: 0,
    approvedEvents: [],
  },
  suspected: { known: true, closedCount: 0, openCount: 0 },
  coverageGaps: { known: true, count: 0, totalMs: 0 },
  lastAliveMs: NOW,
  collectors: [],
});

test("⑻ 렌더: 미결선(입력 없음)은 새 줄 0개 · 옛 문면 그대로 -- 기존 호출자 회귀 0", async () => {
  const text = core.buildPartialCountReport(renderInput());
  assert.equal(text.includes("GitHub 사람 손"), false);
  assert.equal(numerator(text), `${NUMERATOR_PREFIX}확인 0건`);
  // 프로덕션 수집 결과를 그대로 렌더에 넣는다.
  const env = dayEnv(THREE_KINDS("2026-11-13", "08:10", 100));
  const g = await collectAt(env, at("2026-11-13", "10:00"));
  const withGh = core.buildPartialCountReport({
    ...renderInput(),
    githubHumanActions: g,
  });
  assert.equal(
    numerator(withGh),
    `${NUMERATOR_PREFIX}확인 2건 이상 · ${ONE_UNCHECKED}`,
  );
  assert.match(
    ghLine(withGh),
    /^- GitHub 사람 손 2건 이상\(댓글 .* · 리뷰 줄 댓글 .* · 변경 요청 미수집\(ㄱ-4 리뷰 응답 없음\) · 미병합 닫기 .* · 판정 불가 0\) — ㄴ 확인 건수에 포함/,
  );
});
