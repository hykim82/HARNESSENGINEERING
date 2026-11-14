// HYK-255-p3-gh-1 (판정 2026-11-14 0939 ④⑤ · 1-C 설계 P3 행) -- GitHub 사람 손 조작 수집기.
//
//   저장소 단위 사건 목록 «하나»(GET /repos/<owner>/<repo>/events?per_page=100 · 1쪽이 창을 못 덮으면 2쪽 1회)에서
//   행위자가 «봇 목록 밖»인 PR 대화 댓글 · PR 리뷰 줄 댓글 · 변경 요청 · 미병합 닫기를 센다. 승인 · 병합 = 계획된 개입이라 세지
//   않는다. 봇 목록 = 새 설정 파일(코드에 봇 이름 리터럴 0). 예산 = 시간당 48 무변 -- P3 는 ㄱ-4 · D1 이 그 회차에 실제로 쓴
//   호출 수를 뺀 나머지(12 - 사용)와 2 중 작은 수만 쓰고, 모자라면 0 이 아니라 «미조회».
//
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce · buildDailyTickValues · recordDailyTick · rolloverDailyState)을 직접
// 구동한다 -- 사본 import 0 · helper 만 단언하는 칸 0. 저장소는 mkdtemp 합성 git(실제 git), fetchJson 은 호출을 기록하는
// 주입 가짜. 실제 네트워크(api.github.com) · gh · 토큰 · 관제실 · 받는함 접촉 0. 모든 칸은 사건을 넣고 «값» 을 단언한다.
// 네임스페이스 import(core · report) -- 옛 판(수집기 없음)에서도 파일이 로드돼 칸마다 «값» 으로 RED 가 난다.
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
  const iso = new Date(atMs).toISOString();
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", message);
  return git(cwd, args, {
    GIT_AUTHOR_NAME: "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: iso,
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

// ---- 합성 사건 -------------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();
const IN_WINDOW = NOW - 2 * HOUR;
let evSeq = 1000;
function ev(type, login, payload, atMs = IN_WINDOW, id = undefined) {
  evSeq += 1;
  return {
    id: id ?? String(evSeq),
    type,
    actor: { login },
    repo: { name: REPO },
    payload,
    created_at: iso(atMs),
  };
}
const prComment = (login = HUMAN, atMs, id) =>
  ev(
    "IssueCommentEvent",
    login,
    {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://x/pulls/7" } },
    },
    atMs,
    id,
  );
const issueComment = (login = HUMAN, atMs, id) =>
  ev(
    "IssueCommentEvent",
    login,
    { action: "created", issue: { number: 8 } },
    atMs,
    id,
  );
const reviewLine = (login = HUMAN, atMs, id) =>
  ev(
    "PullRequestReviewCommentEvent",
    login,
    { action: "created", pull_request: { number: 7 } },
    atMs,
    id,
  );
const review = (state, login = HUMAN, atMs, id) =>
  ev(
    "PullRequestReviewEvent",
    login,
    { action: "submitted", review: { state }, pull_request: { number: 7 } },
    atMs,
    id,
  );
const prAction = (action, merged, login = HUMAN, atMs, id) =>
  ev(
    "PullRequestEvent",
    login,
    { action, pull_request: { number: 7, merged } },
    atMs,
    id,
  );
const push = (login = HUMAN, atMs, id) =>
  ev("PushEvent", login, { ref: "refs/heads/x" }, atMs, id);

// ---- 가짜 fetchJson (호출 기록) -----------------------------------------------------------------
// 사건 목록 = pages[n] (200 JSON 배열 | 응답 객체 그대로). ㄱ-4 · D1 응답 = rest-cap 시험과 같은 «체인을 끝까지 끄는» 모양.
const ok200 = (json) => ({ ok: true, status: 200, json, linkHeader: null });
function makeFetch(repo, { pages = {} } = {}) {
  const calls = { gate4: [], d1: [], events: [], all: [] };
  const mergeNumber = new Map((repo.mergeShas ?? []).map((s, i) => [s, i + 1]));
  const fetchJson = async ({ url }) => {
    calls.all.push(url);
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    const evPage = /^\/events\?per_page=100(?:&page=(\d+))?$/.exec(path);
    if (evPage) {
      calls.events.push(url);
      const n = Number(evPage[1] ?? 1);
      const p = pages[n];
      if (p === undefined) return ok200([]);
      return Array.isArray(p) ? ok200(p) : p;
    }
    const d1 = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (d1) {
      calls.d1.push(url);
      return ok200({
        sha: d1[1],
        commit: {
          verification: { verified: true, reason: "valid" },
          committer: { name: "GitHub", email: "noreply@github.com" },
        },
        author: { login: "hykim82", id: 286230306 },
        committer: { login: "web-flow", id: 19864447 },
      });
    }
    calls.gate4.push(url);
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
      ]);
    }
    return { ok: false, status: 404, json: null, linkHeader: null };
  };
  return { fetchJson, calls };
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

async function runWith(pages, { ubCounts = [], bots, extra = {} } = {}) {
  const repo = buildRepo(ubCounts, bots === undefined ? undefined : { bots });
  const { fetchJson, calls } = makeFetch(repo, { pages });
  const result = await runDefault(repo, fetchJson, extra);
  return { repo, calls, result };
}

const lineStarting = (text, prefix) =>
  text.split("\n").find((l) => l.startsWith(prefix));
const numerator = (text) => lineStarting(text, NUMERATOR_PREFIX);
const ghLine = (text) => lineStarting(text, GH_PREFIX);

// ---- ⑴ RED 대표 칸: 사람 PR 댓글 1건이 ㄴ 분자에 들어간다 ----------------------------------------

test("⑴ 사람 PR 대화 댓글 1건 -> ㄴ 분자 «확인 1건» + ㄴ 절 «GitHub 사람 손 1건(댓글 1 · …)»", async () => {
  const { result, calls } = await runWith({ 1: [prComment(HUMAN)] });
  assert.equal(numerator(result.reportText), `${NUMERATOR_PREFIX}확인 1건`);
  assert.equal(
    ghLine(result.reportText).startsWith(
      `${GH_PREFIX}1건(댓글 1 · 리뷰 줄 댓글 0 · 변경 요청 0 · 미병합 닫기 0 · 판정 불가 0)`,
    ),
    true,
    ghLine(result.reportText),
  );
  assert.equal(calls.events.length, 1, "사건 목록 조회 1회(1쪽이 창을 덮음)");
  assert.equal(result.githubHumanActions.humanTotal, 1);
});

// ---- ⑵ 종류 4 × (사람 = 1 · 봇 = 0) ---------------------------------------------------------------

const KIND_CASES = [
  ["댓글", (l) => prComment(l), "comment"],
  ["리뷰 줄 댓글", (l) => reviewLine(l), "reviewComment"],
  ["변경 요청", (l) => review("changes_requested", l), "changeRequest"],
  ["미병합 닫기", (l) => prAction("closed", false, l), "unmergedClose"],
];

for (const [label, make, field] of KIND_CASES) {
  test(`⑵ 종류 «${label}»: 사람 = 1 · 봇(설정 목록) = 0`, async () => {
    const human = await runWith({ 1: [make(HUMAN)] });
    assert.equal(human.result.githubHumanActions[field], 1);
    assert.equal(human.result.githubHumanActions.humanTotal, 1);
    assert.equal(
      numerator(human.result.reportText),
      `${NUMERATOR_PREFIX}확인 1건`,
    );
    const bot = await runWith({ 1: [make(BOT_A), make(BOT_B)] });
    assert.equal(bot.result.githubHumanActions[field], 0);
    assert.equal(bot.result.githubHumanActions.humanTotal, 0);
    assert.equal(bot.result.githubHumanActions.botSkipped, 2);
    assert.equal(
      numerator(bot.result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
  });
}

test("⑵ 네 종류가 섞이면 종류별 칸에 갈려 담기고 합계 = 분자 (댓글 2 · 리뷰 줄 1 · 변경 요청 1 · 미병합 닫기 1)", async () => {
  const { result } = await runWith({
    1: [
      prComment(HUMAN),
      prComment("another-human"),
      reviewLine(HUMAN),
      review("changes_requested", HUMAN),
      prAction("closed", false, HUMAN),
    ],
  });
  const g = result.githubHumanActions;
  assert.deepEqual(
    [
      g.comment,
      g.reviewComment,
      g.changeRequest,
      g.unmergedClose,
      g.humanTotal,
    ],
    [2, 1, 1, 1, 5],
  );
  assert.equal(numerator(result.reportText), `${NUMERATOR_PREFIX}확인 5건`);
});

test("⑵ 이슈(PR 아님) 댓글 · 승인 · 일반 리뷰 · 병합 닫기 · 열기/다시 열기 = 0 (계획된 개입 · PR 아님)", async () => {
  const { result } = await runWith({
    1: [
      issueComment(HUMAN),
      review("approved", HUMAN),
      review("commented", HUMAN),
      review("dismissed", HUMAN),
      prAction("closed", true, HUMAN),
      prAction("opened", false, HUMAN),
      prAction("reopened", false, HUMAN),
    ],
  });
  const g = result.githubHumanActions;
  assert.equal(g.known, true);
  assert.equal(g.humanTotal, 0);
  assert.equal(g.undecidable, 0);
  assert.equal(numerator(result.reportText), `${NUMERATOR_PREFIX}확인 0건`);
});

test("⑵ 변경 요청 state 는 대소문자 무관(API 판 모양 차이 흡수) · 승인(APPROVED)은 여전히 0", async () => {
  const { result } = await runWith({
    1: [review("CHANGES_REQUESTED", HUMAN), review("APPROVED", HUMAN)],
  });
  assert.equal(result.githubHumanActions.changeRequest, 1);
  assert.equal(result.githubHumanActions.humanTotal, 1);
});

test("⑵ 모르는 사건 종류 = 버린다(건수만 진단) · 창 밖 = 0 · 같은 사건 id 중복 = 1", async () => {
  const { result } = await runWith({
    1: [
      push(HUMAN),
      ev("WatchEvent", HUMAN, {}),
      prComment(HUMAN, NOW - 25 * HOUR),
      prComment(HUMAN, NOW + 5 * MIN),
      prComment(HUMAN, IN_WINDOW, "dup-1"),
      prComment(HUMAN, IN_WINDOW, "dup-1"),
    ],
  });
  const g = result.githubHumanActions;
  assert.equal(g.humanTotal, 1);
  assert.equal(g.unknownKinds, 2);
  assert.equal(g.outOfWindow, 2);
  assert.equal(g.duplicates, 1);
  assert.deepEqual(g.humanEventIds, ["dup-1"]);
});

test("⑵ 모양이 어긋난 사건(필드 없음) = 0 이 아니라 판정 불가 K (하한 «이상» 표기) · 정상 사건은 그대로 센다", async () => {
  const noActor = prComment(HUMAN);
  delete noActor.actor;
  const noReviewState = ev("PullRequestReviewEvent", HUMAN, { review: {} });
  const noMerged = ev("PullRequestEvent", HUMAN, {
    action: "closed",
    pull_request: { number: 7 },
  });
  const noPayload = ev("IssueCommentEvent", HUMAN, undefined);
  const noTime = prComment(HUMAN);
  delete noTime.created_at;
  const noType = {
    id: "t-1",
    actor: { login: HUMAN },
    created_at: iso(IN_WINDOW),
  };
  const { result } = await runWith({
    1: [
      noActor,
      noReviewState,
      noMerged,
      noPayload,
      noTime,
      noType,
      prComment(HUMAN),
    ],
  });
  const g = result.githubHumanActions;
  assert.equal(g.undecidable, 6);
  assert.equal(g.humanTotal, 1);
  assert.equal(
    numerator(result.reportText),
    `${NUMERATOR_PREFIX}확인 1건 이상 · GitHub 판정 불가 6`,
  );
  assert.match(
    ghLine(result.reportText),
    /^- GitHub 사람 손 1건 이상\(.*판정 불가 6\)/,
  );
});

test("⑵ 앱 계정(`…[bot]`)이 봇 목록에 없으면 사람으로 센다(부풀리는 쪽 · 목록 추가는 사람 결정) -- 목록에 넣으면 0", async () => {
  const app = "some-app[bot]";
  const unlisted = await runWith({ 1: [prComment(app)] });
  assert.equal(unlisted.result.githubHumanActions.humanTotal, 1);
  const listed = await runWith(
    { 1: [prComment(app)] },
    {
      bots: JSON.stringify({
        schema_version: "github-bot-accounts/v1",
        bots: [{ login: app }],
      }),
    },
  );
  assert.equal(listed.result.githubHumanActions.humanTotal, 0);
});

// ---- ⑶ 쪽 · 미조회 · 실패 ------------------------------------------------------------------------

function fullPage(first, last, fillLogin = HUMAN) {
  // 100건 꽉 찬 1쪽(전부 창 안) -- 모르는 종류 채움 98건 + 앞 사건 + 뒤 사건.
  const filler = Array.from({ length: 98 }, () =>
    push(fillLogin, IN_WINDOW - HOUR),
  );
  return [first, ...filler, last];
}

test("⑶ 1쪽 100건 꽉 참 · 마지막 사건이 창 안 -> 2쪽 1회 조회 · 두 쪽 합쳐 센다 · 호출 2", async () => {
  const { result, calls } = await runWith({
    1: fullPage(
      prComment(HUMAN, IN_WINDOW, "p1-a"),
      review("changes_requested", HUMAN, IN_WINDOW - 3 * HOUR, "p1-z"),
    ),
    2: [
      prAction("closed", false, HUMAN, NOW - 20 * HOUR, "p2-a"),
      reviewLine(HUMAN, NOW - 30 * HOUR, "p2-old"),
    ],
  });
  assert.equal(calls.events.length, 2);
  assert.match(calls.events[1], /\/events\?per_page=100&page=2$/);
  const g = result.githubHumanActions;
  assert.equal(g.known, true);
  assert.equal(g.pages, 2);
  assert.deepEqual(
    [
      g.comment,
      g.changeRequest,
      g.unmergedClose,
      g.reviewComment,
      g.humanTotal,
    ],
    [1, 1, 1, 0, 3],
  );
  assert.equal(g.outOfWindow, 1, "2쪽의 창 밖 사건은 0");
});

test("⑶ 1쪽이 100건 미만이면 2쪽을 부르지 않는다 · 1쪽에 창보다 오래된 사건이 있으면(꽉 차도) 2쪽 0", async () => {
  const short = await runWith({ 1: [prComment(HUMAN)] });
  assert.equal(short.calls.events.length, 1);
  const reached = await runWith({
    1: [
      ...Array.from({ length: 99 }, () => push(HUMAN, IN_WINDOW)),
      push(HUMAN, NOW - 30 * HOUR),
    ],
  });
  assert.equal(reached.calls.events.length, 1);
  assert.equal(reached.result.githubHumanActions.known, true);
});

test("⑶ 2쪽까지 봐도 창을 못 덮으면 = 미조회(창 덮지 못함) -- 0 이 아니다 · 분자에 안 들어가고 하한 표기", async () => {
  const { result, calls } = await runWith({
    1: fullPage(prComment(HUMAN), prComment(HUMAN)),
    2: fullPage(prComment(HUMAN), prComment(HUMAN)),
  });
  assert.equal(calls.events.length, 2, "3쪽은 부르지 않는다");
  const g = result.githubHumanActions;
  assert.equal(g.known, false);
  assert.equal(g.unchecked, true);
  assert.equal(g.reason, "창 덮지 못함");
  assert.equal(
    numerator(result.reportText),
    `${NUMERATOR_PREFIX}확인 0건 이상 · GitHub 사람 손 미조회`,
  );
  assert.equal(
    ghLine(result.reportText),
    `${GH_PREFIX}미조회(창 덮지 못함) — ㄴ 확인 건수에 미반영 · 0 아님`,
  );
});

for (const status of [403, 429]) {
  test(`⑶ HTTP ${status} = 미조회(rate limit) -- 0 아님 · 재시도 0 (사건 목록 호출 1)`, async () => {
    const { result, calls } = await runWith({
      1: { ok: false, status, json: null, linkHeader: null },
    });
    assert.equal(calls.events.length, 1, "재시도 0");
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

test("⑶ 404/500 · 응답 모양 위반(배열 아님) · 던짐 = 수집 실패(0 아님 · 미조회와 다른 문면)", async () => {
  const notFound = await runWith({
    1: { ok: false, status: 404, json: null, linkHeader: null },
  });
  assert.equal(notFound.result.githubHumanActions.known, false);
  assert.notEqual(notFound.result.githubHumanActions.unchecked, true);
  assert.match(
    ghLine(notFound.result.reportText),
    /^- GitHub 사람 손 수집 실패\(/,
  );
  const bad = await runWith({ 1: ok200({ message: "not an array" }) });
  assert.match(bad.result.githubHumanActions.reason, /모양 위반/);
  assert.match(
    numerator(bad.result.reportText),
    /^- 외부 독립 증거로 확인된 사건: 확인 0건 이상 · GitHub 사람 손 수집 실패$/,
  );
  const repo = buildRepo([]);
  const throwing = await runDefault(repo, async ({ url }) => {
    if (url.includes("/events")) throw new Error("boom");
    return { ok: false, status: 404, json: null, linkHeader: null };
  });
  assert.equal(throwing.githubHumanActions.known, false);
  assert.match(throwing.githubHumanActions.reason, /boom/);
});

test("⑶ 봇 목록 없음 · 깨짐 · 스키마 불일치 · 비어 있음 = 수집 실패(0 아님) · 그때 사건 목록 REST 호출 0", async () => {
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
    const { result, calls } = await runWith(
      { 1: [prComment(HUMAN)] },
      { bots },
    );
    assert.equal(result.githubHumanActions.known, false, name);
    assert.notEqual(result.githubHumanActions.unchecked, true, name);
    assert.match(result.githubHumanActions.reason, /봇 목록/, name);
    assert.equal(calls.events.length, 0, `${name}: 사건 목록 호출 0`);
    // 사유에 git stderr 의 개행이 섞여도 보고문 줄 · 관측 건강 줄이 «한 줄» 로 남는다(합성 렌더에서 실측한 줄 깨짐).
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

// ---- ⑷ 예산 (시간당 48 무변 · 회차 총 ≤ 12) ---------------------------------------------------------

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

// ㄱ-4 한 sha 의 체인 실호출 = 5(저장소 · 보호 브랜치 · 커밋의 PR · PR 상세 · 리뷰 -- callBudget 8 은 천장). 기본 옵션의 합 =
// 5 + 4 = 9 라 P3 몫은 2 로 남는다. 몫이 1 · 0 으로 줄어드는 경로는 «이미 쓴 호출이 11 · 12» 인 입력으로 구동한다 -- 이미 있는
// 옵션(maxMergeChecks · maxExternalEvidenceChecks)으로 ㄱ-4 2 sha(10) + D1 N 을 만든다(상한 상수 · callBudget 은 안 건드린다).
test("⑷ 최악 입력(ㄱ-4 10 + D1 2 = 앞의 둘이 12 를 다 씀) -> P3 사건 목록 호출 0 · 미조회(예산) · 회차 총 ≤ 12 (0 아님)", async () => {
  const { result, calls } = await runWith(
    { 1: [prComment(HUMAN)] },
    {
      ubCounts: [2, 2, 1],
      extra: { maxMergeChecks: 2, maxExternalEvidenceChecks: 2 },
    },
  );
  assert.equal(calls.gate4.length, 10, "ㄱ-4 2 sha × 5");
  assert.equal(calls.d1.length, 2, "D1 2");
  assert.equal(calls.events.length, 0, "P3 호출 0");
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

test("⑷ 기본 옵션 최악(ㄱ-4 후보 3 · D1 후보 5 -- 상한까지 조회) -> 합 ≤ 12 · 시간당 ≤ 48 · P3 몫은 남은 만큼(여기서는 2)", async () => {
  const { result, calls } = await runWith(
    { 1: [prComment(HUMAN)] },
    { ubCounts: [2, 2, 1] },
  );
  const before = calls.gate4.length + calls.d1.length;
  assert.equal(before, 9);
  assert.equal(result.githubHumanActions.budget, 2);
  assert.equal(result.githubHumanActions.humanTotal, 1);
  assert.ok(calls.all.length <= 12);
  assert.ok(calls.all.length * 4 <= 48);
});

test("⑷ 여유 입력(후보 0) -> P3 호출 ≤ 2 · 회차 총 ≤ 12 · 호출 순서 = 기존 둘 먼저 · P3 마지막", async () => {
  const { calls, result } = await runWith({
    1: fullPage(prComment(HUMAN), prComment(HUMAN)),
    2: [push(HUMAN, NOW - 30 * HOUR)],
  });
  assert.equal(calls.events.length, 2);
  assert.ok(calls.all.length <= 12);
  assert.equal(result.githubHumanActions.known, true);
  const { calls: cs } = await runWith(
    { 1: [prComment(HUMAN)] },
    { ubCounts: [1] },
  );
  const lastNonEvent = Math.max(
    ...cs.all.map((u, i) => (u.includes("/events") ? -1 : i)),
  );
  const firstEvent = cs.all.findIndex((u) => u.includes("/events"));
  assert.ok(firstEvent > lastNonEvent, "P3 는 ㄱ-4 · D1 뒤에 부른다");
});

test("⑷ 몫 1(앞의 둘이 11 사용: ㄱ-4 2 sha 10 + D1 1) -> 1쪽 1회만 · 1쪽이 창을 못 덮으면 «미조회(예산 · 창 덮지 못함)» · 덮으면 정상", async () => {
  const opts = {
    ubCounts: [2, 1],
    extra: { maxMergeChecks: 2, maxExternalEvidenceChecks: 1 },
  };
  const notCovered = await runWith(
    {
      1: fullPage(prComment(HUMAN), prComment(HUMAN)),
      2: [prComment(HUMAN)],
    },
    opts,
  );
  assert.equal(notCovered.calls.gate4.length + notCovered.calls.d1.length, 11);
  assert.equal(notCovered.calls.events.length, 1);
  assert.equal(notCovered.result.githubHumanActions.known, false);
  assert.equal(
    notCovered.result.githubHumanActions.reason,
    "예산 · 창 덮지 못함",
  );
  assert.ok(notCovered.calls.all.length <= 12);
  const covered = await runWith({ 1: [prComment(HUMAN)] }, opts);
  assert.equal(covered.calls.events.length, 1);
  assert.equal(covered.result.githubHumanActions.humanTotal, 1);
  assert.ok(covered.calls.all.length <= 12);
});

test("⑷ 재시도 0 · PR 마다 조회 0 -- 사건 목록 URL 은 저장소 단위 목록 한 가지뿐", async () => {
  const { calls } = await runWith({
    1: [prComment(HUMAN), reviewLine(HUMAN), prAction("closed", false, HUMAN)],
  });
  assert.equal(calls.events.length, 1);
  assert.equal(
    calls.events[0],
    `https://api.github.com/repos/${REPO}/events?per_page=100`,
  );
  assert.deepEqual(
    calls.all,
    calls.events,
    "후보 0 회차의 호출은 사건 목록 한 번뿐",
  );
});

// ---- ⑸ 봇 이름 리터럴 0 (코드) ---------------------------------------------------------------------

test("⑸ 코드에 봇 이름 리터럴 0 -- 설정 파일의 login 이 수집기 · 코어 소스에 없다 · 설정 파일은 스키마대로", () => {
  const cfg = JSON.parse(
    fs.readFileSync(
      new URL("./github-bot-accounts.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(cfg.schema_version, "github-bot-accounts/v1");
  assert.ok(Array.isArray(cfg.bots) && cfg.bots.length >= 1);
  for (const file of ["partial-count-report.mjs", "partial-count-core.mjs"]) {
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

// ---- ⑹ 일별 줄 새 칸 · 일별 사건 합집합 ------------------------------------------------------------------

const kst = (s) =>
  Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+09:00`);
const gh = (humanTotal, ids, extra = {}) => ({
  known: true,
  comment: humanTotal,
  reviewComment: 0,
  changeRequest: 0,
  unmergedClose: 0,
  humanTotal,
  undecidable: 0,
  humanEventIds: ids,
  ...extra,
});
const tickOf = (githubHumanActions) =>
  core.buildDailyTickValues({
    externalEvidence: { known: true, confirmedShas: [], unchecked: 0 },
    collectors: [],
    delivered: { known: true, count: 1 },
    uncountedExamples: { items: [], version: "v1" },
    githubHumanActions,
  });

test("⑹ 회차 값: P3 known = 새 칸 수 + 사건 식별자 `gh:<id>` · 미조회 · 실패 = null(0 아님) · 판정 불가 K > 0 = null · 미결선 = 칸 없음", () => {
  const known = tickOf(gh(2, ["e1", "e2"]));
  assert.equal(known.githubHumanActions, 2);
  assert.deepEqual(known.confirmedEventIds, ["gh:e1", "gh:e2"]);
  const unchecked = tickOf({ known: false, unchecked: true, reason: "예산" });
  assert.equal(unchecked.githubHumanActions, null);
  assert.deepEqual(unchecked.confirmedEventIds, []);
  assert.equal(tickOf({ known: false, reason: "x" }).githubHumanActions, null);
  const lower = tickOf(gh(2, ["e1", "e2"], { undecidable: 1 }));
  assert.equal(lower.githubHumanActions, null);
  assert.deepEqual(lower.confirmedEventIds, []);
  assert.equal(Object.hasOwn(tickOf(undefined), "githubHumanActions"), false);
  assert.equal(Object.hasOwn(tickOf(null), "githubHumanActions"), false);
});

// 한 날을 15분 간격으로 돌고(마지막 회차 값 = 마지막 tick), 다음 날 첫 회차로 넘겨 마감 줄을 얻는다.
function runDays(days) {
  let state = null;
  const lines = [];
  for (const { day, ticks } of days) {
    for (const [hhmm, value] of ticks) {
      const nowMs = kst(`${day} ${hhmm}`);
      const rolled = core.rolloverDailyState({
        state,
        nowMs,
        closedDays: new Set(lines.map((l) => l.day)),
      });
      if (rolled.closedLine) lines.push(rolled.closedLine);
      state = core.recordDailyTick({
        state: rolled.state,
        nowMs,
        tick: tickOf(value),
        concurrentActive: 0,
      });
    }
  }
  return { state, lines };
}
const everyQuarter = (from, to, value) => {
  const out = [];
  for (
    let t = kst(`2000-01-01 ${from}`);
    t <= kst(`2000-01-01 ${to}`);
    t += 15 * MIN
  ) {
    out.push([new Date(t + 9 * HOUR).toISOString().slice(11, 16), value]);
  }
  return out;
};

test("⑹ 일별 줄 새 칸 = 그날 처음 본 사건 수 · 사건 id 로 이틀 중복 1 (24시간 창 겹침)", () => {
  const { lines } = runDays([
    { day: "2026-11-10", ticks: everyQuarter("08:00", "08:45", gh(1, ["e1"])) },
    {
      day: "2026-11-10",
      ticks: [["23:45", gh(2, ["e1", "e2"])]],
    },
    // 다음 날 창이 어제 e1 · e2 를 다시 본다 + 새 사건 e3.
    { day: "2026-11-11", ticks: [["00:15", gh(3, ["e1", "e2", "e3"])]] },
    { day: "2026-11-12", ticks: [["00:15", gh(1, ["e3"])]] },
  ]);
  const byDay = (d) => lines.find((l) => l.day === d);
  assert.equal(byDay("2026-11-10").githubHumanActions, 2, "첫날 = e1 · e2");
  assert.equal(
    byDay("2026-11-11").githubHumanActions,
    1,
    "둘째 날 = e3 만(e1 · e2 는 앞 줄이 셈)",
  );
});

test("⑹ 그날 회차 중 P3 미조회 · 실패가 하나라도 있으면 그날 칸 = null (마지막 회차가 정상이어도)", () => {
  const { lines } = runDays([
    {
      day: "2026-11-10",
      ticks: [
        ["08:00", gh(1, ["e1"])],
        ["08:15", { known: false, unchecked: true, reason: "예산" }],
        ["08:30", gh(1, ["e1"])],
      ],
    },
    { day: "2026-11-11", ticks: [["00:15", gh(0, [])]] },
  ]);
  const line = lines.find((l) => l.day === "2026-11-10");
  assert.equal(Object.hasOwn(line, "githubHumanActions"), true);
  assert.equal(line.githubHumanActions, null);
  const failed = runDays([
    {
      day: "2026-11-10",
      ticks: [["08:00", { known: false, reason: "봇 목록 읽기 실패" }]],
    },
    { day: "2026-11-11", ticks: [["00:15", gh(0, [])]] },
  ]);
  assert.equal(failed.lines[0].githubHumanActions, null);
});

test("⑹ 미조회 날의 사건은 앞 줄이 세지 않은 것이라 다음 날에 처음 본 것으로 센다(값을 잃지 않는다)", () => {
  const { lines } = runDays([
    {
      day: "2026-11-10",
      ticks: [
        ["08:00", gh(1, ["e1"])],
        ["08:15", { known: false, unchecked: true, reason: "예산" }],
      ],
    },
    { day: "2026-11-11", ticks: [["09:00", gh(1, ["e1"])]] },
    { day: "2026-11-12", ticks: [["00:15", gh(0, [])]] },
  ]);
  assert.equal(
    lines.find((l) => l.day === "2026-11-10").githubHumanActions,
    null,
  );
  assert.equal(lines.find((l) => l.day === "2026-11-11").githubHumanActions, 1);
});

test("⑹ 연속 확인-0: 새 칸이 있는 줄에서 값 > 0 · null 이면 끊김 사유 · 0 이면 이어짐 · 칸 없는 옛 줄은 옛 규칙 그대로", () => {
  const base = (day, extra) => ({
    schema: core.DAILY_SCHEMA,
    day,
    lnConfirmed: 0,
    lnUnchecked: 0,
    collectorFails: [],
    coverageGaps: { count: 0, totalMs: 0 },
    uncountedExampleIds: [],
    ...extra,
  });
  const nowMs = kst("2026-11-14 09:00");
  const streak = (extra) =>
    core.computeConfirmedZeroStreak({
      lines: [base("2026-11-13", extra)],
      nowMs,
    });
  assert.equal(streak({ githubHumanActions: 0 }).days, 1);
  assert.equal(streak({}).days, 1, "칸 없는 옛 줄 = 무변");
  const positive = streak({ githubHumanActions: 3 });
  assert.equal(positive.days, 0);
  assert.deepEqual(positive.lastBreak.reasons, ["GitHub 사람 손 조작 3"]);
  const unknown = streak({ githubHumanActions: null });
  assert.equal(unknown.days, 0);
  assert.deepEqual(unknown.lastBreak.reasons, ["GitHub 사람 손 조작 UNKNOWN"]);
});

test("⑹ 일별 사건 접두 = 기존 관례 -- sha: · perm: 와 겹치지 않는 gh: 한 종류만 늘었다", () => {
  assert.equal(core.DAILY_EVENT_PREFIX.D1, "sha:");
  assert.equal(core.DAILY_EVENT_PREFIX.PERMISSION, "perm:");
  assert.equal(core.DAILY_EVENT_PREFIX.GITHUB, "gh:");
});

// ---- ⑺ 렌더 ----------------------------------------------------------------------------------------

test("⑺ 렌더: 미결선(입력 없음)은 새 줄 0개 · 옛 문면 그대로 -- 기존 호출자 회귀 0", () => {
  const input = {
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
  };
  const text = core.buildPartialCountReport(input);
  assert.equal(text.includes("GitHub 사람 손"), false);
  assert.equal(numerator(text), `${NUMERATOR_PREFIX}확인 0건`);
  const withGh = core.buildPartialCountReport({
    ...input,
    githubHumanActions: gh(3, ["a", "b", "c"], {
      comment: 1,
      reviewComment: 1,
      changeRequest: 1,
      unmergedClose: 0,
    }),
  });
  assert.equal(numerator(withGh), `${NUMERATOR_PREFIX}확인 3건`);
  assert.match(
    ghLine(withGh),
    /^- GitHub 사람 손 3건\(댓글 1 · 리뷰 줄 댓글 1 · 변경 요청 1 · 미병합 닫기 0 · 판정 불가 0\) — ㄴ 확인 건수에 포함/,
  );
});
