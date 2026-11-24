// HYK-255-linear-binding-1 (묶음 B · 조각 B2 · 전달 #20261123-1740 확정 4 · 판정 #20261123-2305) -- S3: Linear Done «결속 확인».
//
//   Linear 변경 이력(읽기 전용 · 상수 문서 1개 · 쓰기 0 · linear-sync 와 같은 키 · 새 자격 0)에서 창 안 Done 전이를 읽고, 그 이슈의 «Done 이전 가장 최근 병합»
//   PR 의 ㄱ-4 판정(이번 회차 판정 · 캐시 · 추가 REST 0)이 APPROVED 면 «결속». 결속 확인이지 독립 증거가 아니다 -- 결속 수는 커버리지 · 독립 확인 수 · ㄴ 분자
//   어디에도 더하지 않고 아무것도 막지 않는다(차단 0). 켜는 길 = 감시 폴더 표지 파일 linear-binding.json(HYK-491 teardown-arm.json 꼴) 또는 보고 CLI --linear-binding on.
//
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce · runWatchCliPartialCountStep · parseCliArgs · judgeLinearBindingFlag)을 직접 구동한다.
//   저장소 = mkdtemp 합성 git(실제 git) · GitHub = 주입 가짜 fetchJson · Linear = 주입 가짜 linearFetch · 키 = 주입 env 의 가짜 문자열 · 감시 폴더 = mkdtemp.
//   실제 네트워크 · Linear · 실제 .env.local · 실제 .harness · 실제 감시 폴더 · 실제 linear-binding.json 접촉 0. 기대값은 전부 이 파일 안에서 손으로 정한 값이다.
//   S3 진리표 칸 = 시험 이름 접두 T1~T4 · T5-12 · S1~S7 · 재오픈 · 최근(같은 이슈 옛 APPROVED · 최근 NOT_APPROVED) / 표지 칸 F1~F13 / 감시 회차 W1~W5 / 차단 0 · 변이 칸.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import * as watch from "./watch-run.mjs";

// 새 모듈이 없는 base 에서도 «칸마다» 빨강이 되게 동적으로 불러온다(없으면 빈 객체).
const lb = await import("./linear-done-binding.mjs").catch(() => ({}));

const HOUR = 60 * 60 * 1000;
// 2026-11-24 12:00 KST. 창 = 24시간 = [11-23 12:00 KST, 11-24 12:00 KST].
const NOW = Date.parse("2026-11-24T03:00:00.000Z");
const REPO = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";
const BOTS_PATH = "scripts/supervisor/github-bot-accounts.json";
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: "bot-fixture-a" }],
});
const HANYONG = { login: "hykim82", id: 286230306 };
const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
const PULL_HEAD_SHA = "e".repeat(40);
// 가짜 키(합성 · 실제 키 아님). 어디에도 새면 안 된다(M19).
const FAKE_KEY = "lin_api_FAKEKEY0123456789abcdefghijklmnop";
const VIEWER = "viewer-key-owner";
const LINE = "- ㄱ-4 Linear Done 결속 확인";
const CAPTION = "(결속 확인 · 독립 아님)";

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

// 합성 저장소 -- merges = [{pr, issue(번호), atMs, branch?}] 를 시각 오름차순 first-parent 줄기로 쌓는다. 병합 제목 = «Merge pull request #<pr> from hykim82/<branch>».
// 가지 이름 기본 = hyk<issue>-slice-1 (관례). origin/master 에 명단 · 봇 목록 blob.
function buildRepo(merges = []) {
  const dir = tmpDir("nc-lb-");
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
  let main = root;
  const shaOfPr = new Map();
  const sorted = [...merges].sort((a, b) => a.atMs - b.atMs);
  sorted.forEach((m) => {
    const feat = commitTree(dir, {
      parents: [main],
      message: `feat: work for PR ${m.pr}`,
      committer: HUMAN_COMMITTER,
      atMs: m.atMs - 60 * 1000,
    });
    main = commitTree(dir, {
      parents: [main, feat],
      message: `Merge pull request #${m.pr} from hykim82/${m.branch ?? `hyk${m.issue}-slice-1`}`,
      committer: GITHUB_COMMITTER,
      atMs: m.atMs,
    });
    shaOfPr.set(m.pr, main);
  });
  git(dir, ["update-ref", "refs/remotes/origin/master", main]);
  return { dir, shaOfPr, headSha: main };
}

// ---- 합성 GitHub 응답(ㄱ-4 체인) -- approvals = {PR번호: "A"(승인) | "N"(승인 없음) | "U"(상세 조회 실패 = UNDECIDABLE)} --------------------------------
const iso = (ms) => new Date(ms).toISOString();
const ok200 = (json) => ({ ok: true, status: 200, json, linkHeader: null });

function makeGithubFetch(repo, approvals) {
  const calls = [];
  const prOfSha = new Map([...repo.shaOfPr].map(([pr, sha]) => [sha, pr]));
  const fetchJson = async ({ url }) => {
    calls.push(url);
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    if (path === "") return ok200({ default_branch: "master" });
    if (path === "/branches/master")
      return ok200({ protected: true, commit: { sha: repo.headSha } });
    const pulls = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (pulls) {
      const n = prOfSha.get(pulls[1]);
      return ok200(n ? [{ merge_commit_sha: pulls[1], number: n }] : []);
    }
    const detail = /^\/pulls\/(\d+)$/.exec(path);
    if (detail) {
      if (approvals[Number(detail[1])] === "U")
        return { ok: false, status: 500, json: null, linkHeader: null };
      return ok200({
        merged: true,
        base: { ref: "master" },
        head: { sha: PULL_HEAD_SHA },
        user: { login: "harness-bot", id: 999 },
      });
    }
    const reviews = /^\/pulls\/(\d+)\/reviews\?per_page=100$/.exec(path);
    if (reviews) {
      return ok200(
        approvals[Number(reviews[1])] === "A"
          ? [
              {
                id: 1,
                user: HANYONG,
                state: "APPROVED",
                commit_id: PULL_HEAD_SHA,
                submitted_at: iso(NOW - 3 * HOUR),
              },
            ]
          : [],
      );
    }
    if (
      /^\/pulls\?state=closed|^\/issues\/comments\?|^\/pulls\/comments\?/.test(
        path,
      )
    )
      return ok200([]);
    const d1 = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (d1) return ok200({ sha: d1[1], commit: {}, author: HANYONG });
    return { ok: false, status: 404, json: null, linkHeader: null };
  };
  return { fetchJson, calls };
}

// ---- 합성 Linear 응답 ---------------------------------------------------------------------------------------------------
const ev = (atMs, over = {}) => ({
  atMs,
  type: "completed",
  actor: { id: "human-1" },
  ...over,
});
const issueNode = (identifier, events, { next = false } = {}) => ({
  identifier,
  history: {
    pageInfo: { hasNextPage: next },
    nodes: events.map((e) => ({
      createdAt: iso(e.atMs),
      actor: e.actor,
      toState: e.type === null ? null : { type: e.type },
    })),
  },
});
const linearBody = ({ viewer = VIEWER, nodes = [], next = false } = {}) => ({
  data: {
    viewer: { id: viewer },
    issues: { pageInfo: { hasNextPage: next }, nodes },
  },
});

function makeLinearFetch(reply) {
  const calls = [];
  const linearFetch = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === "function" ? await reply(url, init) : reply;
    if (r instanceof Error) throw r;
    if (r && r.__http)
      return { ok: false, status: r.__http, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  return { linearFetch, calls };
}

// ---- 프로덕션 진입점 1회 ----------------------------------------------------------------------------------------------------
async function run({
  merges = [],
  approvals = {},
  linear = linearBody(),
  env = { LINEAR_API_KEY: FAKE_KEY },
  linearOn = true,
  status,
  gitWrap,
  extra = {},
} = {}) {
  const repo = buildRepo(merges);
  const root = tmpDir("nc-lb-run-");
  const gh = makeGithubFetch(repo, approvals);
  const lin = makeLinearFetch(linear);
  const base = report.createProcessGitPort(repo.dir);
  const options = {
    now: NOW,
    repoRoot: repo.dir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson: gh.fetchJson,
    git: gitWrap ? gitWrap(base) : base,
    gitWorktreeListExecFn: () => "",
    maxMergeChecks: 10,
    env,
    linearFetch: lin.linearFetch,
    ...extra,
  };
  if (linearOn) options.linearBinding = true;
  if (status) options.linearBindingStatus = status;
  const result = await report.runPartialCountOnce(options);
  return { result, text: result.reportText, gh, lin, repo, root };
}

const lines = (text) => text.split("\n");
const lbLines = (text) => lines(text).filter((l) => l.startsWith(LINE));
const lbResult = (text) =>
  lbLines(text).find((l) => l.includes(CAPTION) || l.includes(": UNKNOWN("));
const A = 3 * HOUR; // 병합이 Done 보다 앞서는 간격(합성)

// ---- 포트 · 상수 문서(쓰기 0 의 기계 보장) ---------------------------------------------------------------------------------
test("P1 포트: 상수 문서 1개만 POST · 본문 = {query: 상수, variables: {since}} · 상수에 mutation 낱말 0 · 키는 헤더 Authorization 으로만", async () => {
  const { linearFetch, calls } = makeLinearFetch(linearBody());
  const port = lb.createLinearHistoryPort({ apiKey: FAKE_KEY, linearFetch });
  const r = await port.readDoneHistory({ sinceIso: iso(NOW - 24 * HOUR) });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["query", "variables"]);
  assert.equal(body.query, lb.LINEAR_DONE_QUERY);
  assert.deepEqual(body.variables, { since: iso(NOW - 24 * HOUR) });
  assert.ok(
    !/mutation/i.test(lb.LINEAR_DONE_QUERY),
    "상수 문서에 mutation 낱말",
  );
  assert.ok(!/mutation/i.test(calls[0].init.body));
  assert.equal(calls[0].init.headers.Authorization, FAKE_KEY);
  assert.ok(!calls[0].init.body.includes(FAKE_KEY), "키가 본문에 실림");
});

test("P2 포트: 상수 밖 문서(mutation · 다른 query)는 요청 전에 거부 -- linearFetch 호출 0 (M18)", async () => {
  const { linearFetch, calls } = makeLinearFetch(linearBody());
  const port = lb.createLinearHistoryPort({ apiKey: FAKE_KEY, linearFetch });
  for (const doc of [
    'mutation { issueUpdate(id: "x", input: {}) { success } }',
    "query { viewer { id } }",
    `${lb.LINEAR_DONE_QUERY} mutation { x }`,
    "",
  ]) {
    const r = await port.request({ query: doc, variables: { since: "x" } });
    assert.equal(r.ok, false, `거부돼야 한다: ${doc}`);
  }
  // 상수 문서라도 변수 모양이 다르면(since 외 키) 거부.
  const bad = await port.request({
    query: lb.LINEAR_DONE_QUERY,
    variables: { since: "x", extra: 1 },
  });
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 0, "거부된 요청이 네트워크로 나갔다");
});

test("P3 포트 표면: 읽기 메서드 둘뿐(request · readDoneHistory) -- 그 밖 메서드 0", () => {
  const port = lb.createLinearHistoryPort({
    apiKey: FAKE_KEY,
    linearFetch: async () => ({}),
  });
  assert.deepEqual(Object.keys(port).sort(), ["readDoneHistory", "request"]);
});

// ---- 병합 제목 -> 이슈 연결(로컬 git · REST 0) -------------------------------------------------------------------------------
test("L1 병합 제목 파서: hyk<NNN>- 가지 -> HYK-NNN · 관례 밖 가지 · 병합 아닌 줄은 연결 없음", () => {
  const sha = (c) => c.repeat(40);
  const out = lb.parseMergeLinks(
    [
      `${sha("a")} 2026-11-24T01:00:00+09:00 Merge pull request #394 from hykim82/hyk255-seal-orphan-1`,
      `${sha("b")} 2026-11-24T02:00:00+09:00 Merge pull request #12 from hykim82/hyk77-Foo`,
      `${sha("c")} 2026-11-24T03:00:00+09:00 Merge pull request #13 from hykim82/feature-x`,
      `${sha("d")} 2026-11-24T04:00:00+09:00 Merge pull request #14 from hykim82/hyk9`,
      `${sha("e")} 2026-11-24T05:00:00+09:00 Merge pull request #15 from hykim82/HYK-88-Bar`,
      "garbage line",
    ].join("\n"),
  );
  assert.deepEqual(
    out.map((m) => [m.sha, m.pull, m.issue]),
    [
      [sha("a"), 394, "HYK-255"],
      [sha("b"), 12, "HYK-77"],
    ],
  );
  assert.equal(out[0].tsMs, Date.parse("2026-11-24T01:00:00+09:00"));
});

// ---- T1~T4 · T5~T12 -----------------------------------------------------------------------------------------------------
test("T1 결속: Done 직전 연결 PR 의 ㄱ-4 판정 APPROVED -> «Done 1건 중 결속 1 · 미결속 0 · 미조회 0» + 문면 고정(결속 확인 · 독립 아님 · 행위자는 근거가 아니다)", async () => {
  const { text, lin } = await run({
    merges: [{ pr: 11, issue: 201, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-201", [ev(NOW - HOUR)])] }),
  });
  const l = lbResult(text);
  assert.ok(l, "결속 확인 줄이 없다");
  assert.ok(
    l.startsWith(
      `${LINE}${CAPTION}: Done 1건 중 결속 1 · 미결속 0(승인 아님 0 · PR 연결 없음 0) · 미조회 0`,
    ),
    l,
  );
  assert.ok(l.includes("행위자 = 기계 키 주인과 같은 계정 0/1"), l);
  assert.ok(l.endsWith("— Linear 행위자는 근거가 아니다"), l);
  assert.equal(lin.calls.length, 1, "Linear 호출은 회차당 1회");
});

test("T2 승인 아님: 연결 PR 이 ㄱ-4 NOT_APPROVED -> 미결속 1(승인 아님 1)", async () => {
  const { text } = await run({
    merges: [{ pr: 11, issue: 202, atMs: NOW - A }],
    approvals: { 11: "N" },
    linear: linearBody({ nodes: [issueNode("HYK-202", [ev(NOW - HOUR)])] }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes(
      "Done 1건 중 결속 0 · 미결속 1(승인 아님 1 · PR 연결 없음 0) · 미조회 0",
    ),
    l,
  );
});

test("T3a 미조회: 연결 PR 의 ㄱ-4 판정이 UNDECIDABLE -> 미조회 1 (미결속으로도 0 으로도 접지 않음)", async () => {
  const { text } = await run({
    merges: [{ pr: 11, issue: 203, atMs: NOW - A }],
    approvals: { 11: "U" },
    linear: linearBody({ nodes: [issueNode("HYK-203", [ev(NOW - HOUR)])] }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes(
      "Done 1건 중 결속 0 · 미결속 0(승인 아님 0 · PR 연결 없음 0) · 미조회 1",
    ),
    l,
  );
});

test("T3b 미조회: 연결 PR 이 ㄱ-4 창 밖(조회 대상 아님) -> 미조회 1", async () => {
  const { text } = await run({
    merges: [{ pr: 11, issue: 204, atMs: NOW - 30 * HOUR }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-204", [ev(NOW - HOUR)])] }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes("결속 0 · 미결속 0(승인 아님 0 · PR 연결 없음 0) · 미조회 1"),
    l,
  );
});

test("T4 PR 연결 없음: 그 이슈의 병합이 없다 / 가지 관례 밖 / Done «뒤» 병합뿐 -> 미결속(PR 연결 없음)", async () => {
  const { text } = await run({
    merges: [
      {
        pr: 21,
        issue: 205,
        atMs: NOW - A,
        branch: "feature-without-convention",
      },
      { pr: 22, issue: 206, atMs: NOW - 10 * 60 * 1000 }, // Done(NOW-1h) 뒤 병합
    ],
    approvals: { 21: "A", 22: "A" },
    linear: linearBody({
      nodes: [
        issueNode("HYK-205", [ev(NOW - HOUR)]),
        issueNode("HYK-206", [ev(NOW - HOUR)]),
        issueNode("HYK-207", [ev(NOW - HOUR)]),
      ],
    }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes(
      "Done 3건 중 결속 0 · 미결속 3(승인 아님 0 · PR 연결 없음 3) · 미조회 0",
    ),
    l,
  );
});

test("T5-12 센 대상 아님: Done 없는 병합 · canceled/duplicate 전이 · 창 밖 Done · 비 HYK 식별자 -> Done 0건(수 0) · 병합만 있고 Done 없음은 정상", async () => {
  const { text } = await run({
    merges: [{ pr: 31, issue: 208, atMs: NOW - A }],
    approvals: { 31: "A" },
    linear: linearBody({
      nodes: [
        issueNode("HYK-209", [ev(NOW - HOUR, { type: "canceled" })]),
        issueNode("HYK-210", [ev(NOW - HOUR, { type: "duplicate" })]),
        issueNode("HYK-211", [ev(NOW - 30 * HOUR)]),
        issueNode("HYK-212", [ev(NOW - HOUR, { type: null })]),
        issueNode("ABC-1", [ev(NOW - HOUR)]),
      ],
    }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes(
      "Done 0건 중 결속 0 · 미결속 0(승인 아님 0 · PR 연결 없음 0) · 미조회 0",
    ),
    l,
  );
});

test("재오픈: 같은 이슈의 Done 전이 둘(재오픈 뒤 다시 Done) = 2사건 -- 각 Done 은 «자기 이전» 가장 최근 병합으로 판정", async () => {
  const { text } = await run({
    merges: [
      { pr: 41, issue: 213, atMs: NOW - 12 * HOUR },
      { pr: 42, issue: 213, atMs: NOW - 5 * HOUR },
    ],
    approvals: { 41: "A", 42: "N" },
    linear: linearBody({
      nodes: [issueNode("HYK-213", [ev(NOW - 10 * HOUR), ev(NOW - HOUR)])],
    }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes(
      "Done 2건 중 결속 1 · 미결속 1(승인 아님 1 · PR 연결 없음 0) · 미조회 0",
    ),
    l,
  );
});

test("최근: 같은 이슈에 옛 APPROVED · 최근 NOT_APPROVED 병합 -> 최근 것으로 판정(미결속 1) -- 아무 APPROVED 병합으로 결속하지 않는다 (M22)", async () => {
  const { text } = await run({
    merges: [
      { pr: 51, issue: 214, atMs: NOW - 8 * HOUR },
      { pr: 52, issue: 214, atMs: NOW - 4 * HOUR },
    ],
    approvals: { 51: "A", 52: "N" },
    linear: linearBody({ nodes: [issueNode("HYK-214", [ev(NOW - HOUR)])] }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes("Done 1건 중 결속 0 · 미결속 1(승인 아님 1 · PR 연결 없음 0)"),
    l,
  );
});

test("행위자: Done 행위자 = 키 주인(viewer) 이면 같은 계정 s/t 에 센다 · 다르면 0 · actor null(시스템)은 같은 계정 아님", async () => {
  const mk = (actor) =>
    run({
      merges: [{ pr: 11, issue: 215, atMs: NOW - A }],
      approvals: { 11: "A" },
      linear: linearBody({
        nodes: [issueNode("HYK-215", [ev(NOW - HOUR, { actor })])],
      }),
    });
  const same = await mk({ id: VIEWER });
  assert.ok(
    lbResult(same.text).includes("기계 키 주인과 같은 계정 1/1"),
    lbResult(same.text),
  );
  const other = await mk({ id: "someone-else" });
  assert.ok(lbResult(other.text).includes("기계 키 주인과 같은 계정 0/1"));
  const system = await mk(null);
  assert.ok(lbResult(system.text).includes("기계 키 주인과 같은 계정 0/1"));
});

// ---- S1~S7 --------------------------------------------------------------------------------------------------------------
test("S1 키 없음: env 에도 .env.local 에도 키가 없으면 UNKNOWN(키 없음) -- Linear 호출 0", async () => {
  const { text, lin } = await run({ env: {} });
  const l = lbResult(text);
  assert.equal(l, `${LINE}: UNKNOWN(키 없음) — 0 아님`);
  assert.equal(lin.calls.length, 0);
});

test("S2 Linear 응답 실패: HTTP 오류 · GraphQL errors · 네트워크 예외 -> UNKNOWN(Linear 응답 실패: 사유 1줄) · 0 으로 접지 않음 (M17)", async () => {
  const http = await run({ linear: { __http: 500 } });
  assert.ok(
    lbResult(http.text).startsWith(`${LINE}: UNKNOWN(Linear 응답 실패: `),
    lbResult(http.text),
  );
  assert.ok(lbResult(http.text).includes("HTTP 500"));
  assert.ok(lbResult(http.text).endsWith(") — 0 아님"));
  const gql = await run({
    linear: { errors: [{ message: "Authentication required" }] },
  });
  assert.ok(
    lbResult(gql.text).includes("Linear 응답 실패: ") &&
      lbResult(gql.text).includes("Authentication required"),
    lbResult(gql.text),
  );
  const thrown = await run({ linear: new Error("socket hang up") });
  assert.ok(
    lbResult(thrown.text).includes("Linear 응답 실패: ") &&
      lbResult(thrown.text).includes("socket hang up"),
    lbResult(thrown.text),
  );
  for (const r of [http, gql, thrown])
    assert.ok(!lbResult(r.text).includes("Done 0건"), "실패를 0건으로 접었다");
});

test("S3 응답 모양 위반: viewer 없음 · issues 없음 · 이력 노드 모양 깨짐 -> UNKNOWN(모양 위반)", async () => {
  const shapes = [
    { data: {} },
    { data: { viewer: { id: VIEWER } } },
    {
      data: {
        viewer: { id: VIEWER },
        issues: { pageInfo: { hasNextPage: false }, nodes: "x" },
      },
    },
    {
      data: {
        viewer: { id: VIEWER },
        issues: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              identifier: "HYK-1",
              history: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { createdAt: "not-a-date", toState: { type: "completed" } },
                ],
              },
            },
          ],
        },
      },
    },
    "not an object",
  ];
  for (const s of shapes) {
    const { text } = await run({ linear: s });
    assert.equal(
      lbResult(text),
      `${LINE}: UNKNOWN(모양 위반) — 0 아님`,
      JSON.stringify(s).slice(0, 60),
    );
  }
});

test("S4 목록 잘림: 이슈 목록 hasNextPage · 이력 hasNextPage 가 true 면 UNKNOWN(목록 잘림) -- 일부만 센 값을 확정으로 내지 않는다", async () => {
  const issues = await run({ linear: linearBody({ nodes: [], next: true }) });
  assert.equal(lbResult(issues.text), `${LINE}: UNKNOWN(목록 잘림) — 0 아님`);
  const hist = await run({
    linear: linearBody({
      nodes: [issueNode("HYK-216", [ev(NOW - HOUR)], { next: true })],
    }),
  });
  assert.equal(lbResult(hist.text), `${LINE}: UNKNOWN(목록 잘림) — 0 아님`);
});

test("S5 병합 목록 실패: 병합 제목 git log 실패 -> UNKNOWN(병합 목록 실패)", async () => {
  const gitWrap = (base) => ({
    run(args) {
      if (args.includes("--format=%H %cI %s"))
        return { code: 128, stdout: "", stderr: "fatal: synthetic" };
      return base.run(args);
    },
  });
  const { text } = await run({
    gitWrap,
    linear: linearBody({ nodes: [issueNode("HYK-217", [ev(NOW - HOUR)])] }),
  });
  assert.equal(lbResult(text), `${LINE}: UNKNOWN(병합 목록 실패) — 0 아님`);
});

test("S6 ㄱ-4 known:false: 병합 후보 조회가 실패한 회차 -> 결속 칸 전부 미조회(미결속 · 결속으로 접지 않음)", async () => {
  const gitWrap = (base) => ({
    run(args) {
      if (args.includes("--format=%H %cI"))
        return { code: 128, stdout: "", stderr: "fatal: synthetic" };
      return base.run(args);
    },
  });
  const { text } = await run({
    gitWrap,
    merges: [{ pr: 11, issue: 218, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({
      nodes: [
        issueNode("HYK-218", [ev(NOW - HOUR)]),
        issueNode("HYK-219", [ev(NOW - HOUR)]), // 병합 없음(PR 연결 없음 칸이지만 ㄱ-4 를 모르는 회차는 전부 미조회)
      ],
    }),
  });
  const l = lbResult(text);
  assert.ok(
    l.includes(
      "Done 2건 중 결속 0 · 미결속 0(승인 아님 0 · PR 연결 없음 0) · 미조회 2",
    ),
    l,
  );
});

test("S7 인자 없음: linearBinding 도 상태도 없는 호출자 -> 결속 줄 0개 · Linear 호출 0 · 키 읽기 0 (M21 회귀 0)", async () => {
  const { text, lin } = await run({ linearOn: false });
  assert.equal(lbLines(text).length, 0);
  assert.ok(!text.includes("Linear Done 결속"));
  assert.equal(lin.calls.length, 0);
});

// ---- 결속 수는 어디에도 더하지 않는다 · 차단 0 · 추가 REST 0 · 키 노출 0 ---------------------------------------------------------
test("M15 결속 수 합산 0: 결속 1 회차와 줄 없는 회차의 «외부 독립 앵커로 확인» · 커버리지 두 줄 · ㄴ 절이 한 글자도 안 다르다", async () => {
  const args = {
    merges: [{ pr: 11, issue: 219, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-219", [ev(NOW - HOUR)])] }),
  };
  const withLb = await run(args);
  const without = await run({ ...args, linearOn: false });
  // 결속 줄(과 수집 건강 행 -- 경로 · 새 수집기 이름이 다르다)만 빼면 보고문 전체가 한 글자도 안 다르다.
  const strip = (t) =>
    lines(t).filter(
      (l) => !l.startsWith(LINE) && !l.startsWith("- 수집 성공/실패"),
    );
  assert.ok(
    strip(withLb.text).some((l) =>
      l.startsWith("- 독립 앵커 유형 커버리지: 1/6"),
    ),
    "커버리지 줄이 없다",
  );
  assert.ok(
    strip(withLb.text).some((l) => l.startsWith("- 외부 독립 앵커로 확인: ")),
    "독립 확인 줄이 없다",
  );
  assert.deepEqual(strip(withLb.text), strip(without.text));
  assert.ok(withLb.text.includes("- 독립 앵커 유형 커버리지: 1/6"));
  assert.ok(lbResult(withLb.text).includes("결속 1"));
});

test("M13/M14 차단 0: 결속 UNKNOWN 이어도 일별 마감 값 · 종료 모양 · 수집 건강 행 ok 가 줄 없는 회차와 같다(일별 끊김 사유 0 · 통지 0)", async () => {
  const base = await run({ linearOn: false });
  for (const linear of [
    { __http: 500 },
    new Error("boom"),
    linearBody({ nodes: [issueNode("HYK-220", [ev(NOW - HOUR)])] }),
  ]) {
    const r = await run({ linear });
    assert.deepEqual(r.result.dailyTick, base.result.dailyTick);
    assert.equal(
      r.result.dailyTick.collectorFails.includes("Linear결속수집기"),
      false,
    );
    assert.equal(r.result.gate4.known, base.result.gate4.known);
  }
  const bad = await run({ linear: { __http: 500 } });
  const health = lines(bad.text).filter((l) => l.includes("Linear결속수집기"));
  assert.equal(health.length, 1, "관측 건강 행이 없거나 둘이다");
  // 수집 건강 행은 한 줄에 수집기들을 «이름 OK|FAIL(…)» 로 잇는다 -- Linear 칸은 실패해도 OK(일별 끊김 사유 아님)여야 한다.
  assert.ok(health[0].includes("Linear결속수집기 OK("), health[0]);
  assert.ok(!health[0].includes("Linear결속수집기 FAIL"), health[0]);
});

test("M20 게이트 1 · 7 무접촉: 보조 관측 줄(ㄱ-1 · ㄱ-2 · ㄱ-6 · ㄱ-7)은 결속 켬/끔이 같다", async () => {
  const outboxDir = tmpDir("nc-lb-outbox-");
  const inboxDir = tmpDir("nc-lb-inbox-");
  const auxOf = async (linearOn) => {
    const r = await run({
      linearOn,
      linear: linearBody({ nodes: [issueNode("HYK-230", [ev(NOW - HOUR)])] }),
      extra: { outboxDir, inboxDir },
    });
    return lines(r.text).find((l) => l.startsWith("- 보조 관측(독립 아님):"));
  };
  const on = await auxOf(true);
  const off = await auxOf(false);
  assert.ok(on, "보조 관측 줄이 없다(공허)");
  assert.equal(on, off);
});

test("M14 차단 0: Linear 실패 · 던지는 fetch · 키 없음 회차에도 보고는 정상 생성되고 받는함 · 보내는함 · 회차 폴더에 새 파일이 생기지 않는다(켬/끔 파일 목록 같음)", async () => {
  const outboxDir = tmpDir("nc-lb-outbox2-");
  const inboxDir = tmpDir("nc-lb-inbox2-");
  const snap = (d) => fs.readdirSync(d).sort().join("|");
  const before = [outboxDir, inboxDir].map(snap);
  const off = await run({ linearOn: false, extra: { outboxDir, inboxDir } });
  const offFiles = snap(off.root);
  for (const scenario of [
    { linear: { __http: 500 } },
    { linear: new Error("boom") },
    { env: {} },
  ]) {
    const r = await run({ ...scenario, extra: { outboxDir, inboxDir } });
    assert.ok(r.text.startsWith("집계 성격: PARTIAL"), "보고는 정상 생성");
    assert.ok(r.result.dailyTick, "일별 값도 정상");
    assert.equal(snap(r.root), offFiles, "회차 폴더 파일 목록이 달라졌다");
  }
  assert.deepEqual(
    [outboxDir, inboxDir].map(snap),
    before,
    "받는함 · 보내는함에 파일이 생겼다",
  );
});

test("M-REST 추가 GitHub REST 0: 결속을 켠 회차와 끈 회차의 GitHub 호출 목록이 같다(ㄱ-4 판정 · 캐시 재사용)", async () => {
  const args = {
    merges: [{ pr: 11, issue: 221, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-221", [ev(NOW - HOUR)])] }),
  };
  const on = await run(args);
  const off = await run({ ...args, linearOn: false });
  assert.equal(on.gh.calls.length, off.gh.calls.length);
  assert.deepEqual(on.gh.calls, off.gh.calls);
});

test("M19 키 노출 0: 키가 예외 · GraphQL 오류 문면에 섞여 돌아와도 보고문 · 결과 객체 · 로그에 없다", async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));
  let runs;
  try {
    runs = [
      await run({
        linear: new Error(`request failed with Authorization ${FAKE_KEY}`),
      }),
      await run({ linear: { errors: [{ message: `bad key ${FAKE_KEY}` }] } }),
      await run({
        linear: linearBody({ nodes: [issueNode("HYK-222", [ev(NOW - HOUR)])] }),
      }),
    ];
  } finally {
    Object.assign(console, orig);
  }
  for (const r of runs) {
    assert.ok(!r.text.includes(FAKE_KEY), "보고문에 키");
    assert.ok(!JSON.stringify(r.result).includes(FAKE_KEY), "결과 객체에 키");
    assert.ok(!r.text.includes("lin_api_"), "키 접두 노출");
  }
  assert.ok(!logs.join("\n").includes(FAKE_KEY), "로그에 키");
  // 오류 문면은 남되(0 아님) 키만 가려진다.
  assert.ok(lbResult(runs[0].text).includes("UNKNOWN(Linear 응답 실패: "));
});

test("키 길: env 에 키가 없고 repoRoot/.env.local 에 있으면 linear-sync 와 같은 길(loadLinearApiKey)로 읽는다 -- 새 자격 0", async () => {
  const repo = buildRepo([]);
  fs.writeFileSync(
    join(repo.dir, ".env.local"),
    `LINEAR_API_KEY=${FAKE_KEY}\n`,
    "utf8",
  );
  const { linearFetch, calls } = makeLinearFetch(linearBody());
  const r = await lb.collectLinearDoneBinding({
    repoRoot: repo.dir,
    env: {},
    linearFetch,
    git: report.createProcessGitPort(repo.dir),
    windowStartMs: NOW - 24 * HOUR,
    windowEndMs: NOW,
    gate4: { known: true, shaStatuses: [] },
  });
  assert.equal(r.known, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, FAKE_KEY);
});

// ---- 렌더 표본(순수) -------------------------------------------------------------------------------------------------------
test("R1 렌더: 상태 없음 + 결과 없음 = 줄 0개 · 상태만(꺼짐) = 사유 토큰 한 줄 · 결과 UNKNOWN = 한 줄", () => {
  assert.deepEqual(core.renderLinearDoneBindingLines(undefined), []);
  assert.deepEqual(core.renderLinearDoneBindingLines(null), []);
  assert.deepEqual(
    core.renderLinearDoneBindingLines({
      status: { on: false, reason: "LINEAR_BINDING_FLAG_ABSENT" },
      result: null,
    }),
    [`${LINE} 꺼짐(LINEAR_BINDING_FLAG_ABSENT)`],
  );
  assert.deepEqual(
    core.renderLinearDoneBindingLines({
      status: { on: true, reason: "LINEAR_BINDING_FLAG_ENABLED" },
      result: { known: false, reason: "키 없음" },
    }),
    [
      `${LINE} 켜짐(LINEAR_BINDING_FLAG_ENABLED)`,
      `${LINE}: UNKNOWN(키 없음) — 0 아님`,
    ],
  );
  assert.deepEqual(
    core.renderLinearDoneBindingLines({
      status: undefined,
      result: { known: false, reason: "목록 잘림" },
    }),
    [`${LINE}: UNKNOWN(목록 잘림) — 0 아님`],
  );
});

// ---- 표지 판정(판정 2305 · HYK-491 judgeTeardownArmFlag 꼴) -----------------------------------------------------------------
function flagDir(content, { asDir = false } = {}) {
  const d = tmpDir("nc-lb-flag-");
  const p = join(d, "linear-binding.json");
  if (asDir) fs.mkdirSync(p);
  else if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return d;
}
const judge = (watchDir, extra = {}) =>
  watch.judgeLinearBindingFlag({
    watchDir,
    existsFn: fs.existsSync,
    readFn: fs.readFileSync,
    ...extra,
  });
const R = () => watch.LINEAR_BINDING_FLAG_REASON;

test("F0 사유 토큰: 얼린 상수 · 전부 서로 다름 · 이름 머리 LINEAR_BINDING_FLAG_", () => {
  const reasons = R();
  assert.ok(Object.isFrozen(reasons));
  const values = Object.values(reasons);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(v.startsWith("LINEAR_BINDING_FLAG_"), v);
  assert.equal(reasons.ENABLED, "LINEAR_BINDING_FLAG_ENABLED");
});

test("F1 켜짐: JSON 객체 ∧ enabled 정확히 true -> on · 사유 ENABLED", () => {
  const j = judge(flagDir('{"enabled": true}'));
  assert.deepEqual(j, { on: true, reason: R().ENABLED });
  // 다른 키가 같이 있어도 enabled 만 본다(기록용 키는 판정에 불사용).
  assert.equal(
    judge(flagDir('{"enabled": true, "confirmed_by": "x"}')).on,
    true,
  );
});

test("F2 없음 -> off ABSENT(감시 폴더 없음 · 폴더 인자 없음 포함)", () => {
  assert.deepEqual(judge(flagDir(undefined)), {
    on: false,
    reason: R().ABSENT,
  });
  assert.deepEqual(judge(join(tmpdir(), "nc-lb-no-such-dir-xyz")), {
    on: false,
    reason: R().ABSENT,
  });
  assert.deepEqual(judge(undefined), { on: false, reason: R().ABSENT });
  assert.deepEqual(judge(""), { on: false, reason: R().ABSENT });
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
  assert.deepEqual(judge(flagDir("{enabled: true")), {
    on: false,
    reason: R().NOT_JSON,
  });
  assert.deepEqual(judge(flagDir("enabled")), {
    on: false,
    reason: R().NOT_JSON,
  });
});

test("F6 최상위가 배열 -> off VALUE_IS_ARRAY", () => {
  assert.deepEqual(judge(flagDir("[true]")), {
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
  assert.deepEqual(judge(flagDir("true")), {
    on: false,
    reason: R().NOT_OBJECT,
  });
  assert.deepEqual(judge(flagDir("null")), {
    on: false,
    reason: R().NOT_OBJECT,
  });
});

test("F9 enabled 키 없음 -> off ENABLED_KEY_MISSING", () => {
  assert.deepEqual(judge(flagDir("{}")), {
    on: false,
    reason: R().ENABLED_KEY_MISSING,
  });
  assert.deepEqual(judge(flagDir('{"armed": true}')), {
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

test('F11 M24 enabled 가 true 가 아닌 참 값(문자열 "true" · 1 · "on" · [] · {}) -> 전부 off ENABLED_NOT_TRUE', () => {
  for (const v of ['"true"', "1", '"on"', "[]", "{}", "null", '"yes"']) {
    const j = judge(flagDir(`{"enabled": ${v}}`));
    assert.deepEqual(j, { on: false, reason: R().ENABLED_NOT_TRUE }, v);
  }
});

test("F12 읽기 실패(EACCES 등 · EISDIR 아님) -> off READ_FAILED -- NOT_JSON 과 구분", () => {
  const d = flagDir('{"enabled": true}');
  const j = judge(d, {
    readFn: () => {
      const e = new Error("denied");
      e.code = "EACCES";
      throw e;
    },
  });
  assert.deepEqual(j, { on: false, reason: R().READ_FAILED });
});

test("F13 존재 확인 예외 -> off ABSENT (fail-closed) · 함수 인자 누락 -> off ABSENT", () => {
  const d = flagDir('{"enabled": true}');
  assert.deepEqual(
    judge(d, {
      existsFn: () => {
        throw new Error("boom");
      },
    }),
    { on: false, reason: R().ABSENT },
  );
  assert.deepEqual(watch.judgeLinearBindingFlag({ watchDir: d }), {
    on: false,
    reason: R().ABSENT,
  });
});

test("F14 실제 판정 파일 이름 = linear-binding.json (HYK-491 teardown-arm.json 과 다른 이름 · 서로 읽지 않는다)", () => {
  const d = tmpDir("nc-lb-flag-name-");
  fs.writeFileSync(join(d, "teardown-arm.json"), '{"enabled": true}', "utf8");
  assert.deepEqual(judge(d), { on: false, reason: R().ABSENT });
  assert.equal(watch.LINEAR_BINDING_FLAG_FILENAME, "linear-binding.json");
});

// ---- 감시 회차(결선) -- 매 회차 켜짐/꺼짐 + 사유 토큰 한 줄 (M25) --------------------------------------------------------------
// 감시 회차의 «실제 입구» runWatchCliPartialCountStep 에 단계 함수를 주입 -- 받은 옵션을 그대로 프로덕션 보고 진입점에 넘겨 보고문을 만든다(네트워크 · 실제 폴더 0).
async function watchRound({
  flagContent,
  asDir = false,
  argv = [],
  approvals = {},
  merges = [],
  linear = linearBody(),
}) {
  const watchDir = flagDir(flagContent, { asDir });
  const repo = buildRepo(merges);
  const root = tmpDir("nc-lb-w-");
  const gh = makeGithubFetch(repo, approvals);
  const lin = makeLinearFetch(linear);
  let seen = null;
  const res = await watch.runWatchCliPartialCountStep({
    argv,
    repoRoot: repo.dir,
    watchDir,
    now: NOW,
    result: { logPath: join(root, "watch.log") },
    notifyDir: join(root, "notify"),
    runPartialCountStepFn: async ({ options }) => {
      seen = options;
      return report.runPartialCountOnce({
        ...options,
        now: NOW,
        dispatchReceiptsPath: join(root, "none.jsonl"),
        extraRepoRoots: [],
        archiveRoot: join(root, "archive-missing"),
        fetchJson: gh.fetchJson,
        git: report.createProcessGitPort(repo.dir),
        gitWorktreeListExecFn: () => "",
        maxMergeChecks: 10,
        env: { LINEAR_API_KEY: FAKE_KEY },
        linearFetch: lin.linearFetch,
      });
    },
  });
  return { seen, text: res.reportText, lin };
}

test("W1 감시 회차 + 표지 없음: «결속 확인 꺼짐(LINEAR_BINDING_FLAG_ABSENT)» 한 줄이 찍히고 Linear 호출 0 (M25)", async () => {
  const { text, lin, seen } = await watchRound({ flagContent: undefined });
  assert.deepEqual(lbLines(text), [`${LINE} 꺼짐(LINEAR_BINDING_FLAG_ABSENT)`]);
  assert.equal(lin.calls.length, 0);
  assert.equal(seen.linearBinding, undefined, "꺼진 회차가 수집 옵션을 켰다");
});

test("W2 감시 회차 + 표지 칸마다 꺼짐 줄에 칸의 사유 토큰이 찍힌다(없음 · 폴더 · 빈 · 깨짐 · false · 문자열 true)", async () => {
  const cases = [
    [{ flagContent: undefined }, "LINEAR_BINDING_FLAG_ABSENT"],
    [
      { flagContent: undefined, asDir: true },
      "LINEAR_BINDING_FLAG_IS_DIRECTORY",
    ],
    [{ flagContent: "" }, "LINEAR_BINDING_FLAG_EMPTY"],
    [{ flagContent: "{bad" }, "LINEAR_BINDING_FLAG_NOT_JSON"],
    [
      { flagContent: '{"enabled": false}' },
      "LINEAR_BINDING_FLAG_ENABLED_NOT_TRUE",
    ],
    [
      { flagContent: '{"enabled": "true"}' },
      "LINEAR_BINDING_FLAG_ENABLED_NOT_TRUE",
    ],
  ];
  for (const [args, token] of cases) {
    const { text, lin } = await watchRound(args);
    assert.deepEqual(lbLines(text), [`${LINE} 꺼짐(${token})`], token);
    assert.equal(lin.calls.length, 0, token);
  }
});

test("W3 감시 회차 + 표지 켜짐: «결속 확인 켜짐(LINEAR_BINDING_FLAG_ENABLED)» + 결속 결과 줄 · Linear 호출 1회", async () => {
  const { text, lin } = await watchRound({
    flagContent: '{"enabled": true}',
    merges: [{ pr: 11, issue: 301, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-301", [ev(NOW - HOUR)])] }),
  });
  const ls = lbLines(text);
  assert.equal(ls.length, 2, ls.join("\n"));
  assert.equal(ls[0], `${LINE} 켜짐(LINEAR_BINDING_FLAG_ENABLED)`);
  assert.ok(ls[1].includes("Done 1건 중 결속 1"), ls[1]);
  assert.equal(lin.calls.length, 1);
});

test("W4 감시 argv --linear-binding on: 표지가 없어도 켜짐(LINEAR_BINDING_ARG_ON) · on 이 아닌 값은 켜지 않는다", async () => {
  const on = await watchRound({
    flagContent: undefined,
    argv: ["--linear-binding", "on"],
  });
  assert.equal(lbLines(on.text)[0], `${LINE} 켜짐(LINEAR_BINDING_ARG_ON)`);
  assert.equal(on.lin.calls.length, 1);
  const off = await watchRound({
    flagContent: undefined,
    argv: ["--linear-binding", "off"],
  });
  assert.deepEqual(lbLines(off.text), [
    `${LINE} 꺼짐(LINEAR_BINDING_FLAG_ABSENT)`,
  ]);
  assert.equal(off.lin.calls.length, 0);
});

test("W5 옵션 전달: 켜짐 회차의 단계 옵션에 linearBinding true + 상태 · 꺼짐 회차는 상태만 -- argv · 표지 판정 호출부 삭제 변이가 잡힌다", async () => {
  const on = await watchRound({ flagContent: '{"enabled": true}' });
  assert.equal(on.seen.linearBinding, true);
  assert.deepEqual(on.seen.linearBindingStatus, {
    on: true,
    reason: "LINEAR_BINDING_FLAG_ENABLED",
  });
  const off = await watchRound({ flagContent: "{}" });
  assert.deepEqual(off.seen.linearBindingStatus, {
    on: false,
    reason: "LINEAR_BINDING_FLAG_ENABLED_KEY_MISSING",
  });
  assert.ok(!("linearBinding" in off.seen));
});

test("W6 buildPartialCountStepOptions: 스위치를 안 주면 옛 옵션 모양 그대로(회귀 0) · 주면 두 키가 실린다", () => {
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
    linearBindingSwitch: { on: true, reason: "X" },
  });
  assert.equal(on.linearBinding, true);
  assert.deepEqual(on.linearBindingStatus, { on: true, reason: "X" });
  const off = watch.buildPartialCountStepOptions({
    ...base,
    linearBindingSwitch: { on: false, reason: "Y" },
  });
  assert.ok(!("linearBinding" in off));
  assert.deepEqual(off.linearBindingStatus, { on: false, reason: "Y" });
});

test("C1 보고 CLI: --linear-binding on -> linearBinding true · 인자 없음 -> 키 없음(옛 호출자 회귀 0) · on 아닌 값 -> false", () => {
  assert.equal(
    report.parseCliArgs(["--linear-binding", "on"]).linearBinding,
    true,
  );
  assert.ok(!("linearBinding" in report.parseCliArgs(["--repo-root", "x"])));
  assert.equal(
    report.parseCliArgs(["--linear-binding", "off"]).linearBinding,
    false,
  );
});

test("C2 수동 CLI 모양(상태 없이 linearBinding 만): 결과 줄만 찍히고 꺼짐/켜짐 줄은 없다 -- 표지 토큰 줄은 감시 회차 몫", async () => {
  const { text } = await run({
    merges: [{ pr: 11, issue: 302, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-302", [ev(NOW - HOUR)])] }),
  });
  const ls = lbLines(text);
  assert.equal(ls.length, 1);
  assert.ok(ls[0].includes("결속 1"));
});

// ---- 줄 배치 · 실행 환경 무관 ---------------------------------------------------------------------------------------------------
test("O1 줄 순서: ㄱ-4 블록 -> (B1 ㄱ-3 줄) -> Linear 결속 줄 -> ORCH-writeable 보조 관측 -> 커버리지 두 줄", async () => {
  const { text } = await run({
    merges: [{ pr: 11, issue: 303, atMs: NOW - A }],
    approvals: { 11: "A" },
    linear: linearBody({ nodes: [issueNode("HYK-303", [ev(NOW - HOUR)])] }),
  });
  const ls = lines(text);
  const iA = ls.findIndex((l) => l.startsWith("- 외부 독립 앵커로 확인"));
  const iL = ls.findIndex((l) => l.startsWith(LINE));
  const iAux = ls.findIndex((l) =>
    l.startsWith("- ORCH-writeable 보조 관측: "),
  );
  const iCov = ls.findIndex((l) => l.startsWith("- 독립 앵커 유형 커버리지"));
  assert.ok(
    iA >= 0 && iA < iL && iL < iAux && iAux < iCov,
    `${iA} ${iL} ${iAux} ${iCov}`,
  );
});

test("Z1 TZ=UTC 자식: 순수 판정 · 렌더가 실행 환경 시간대와 무관(자식 env 에 TZ 만 · 시각은 고정 값)", () => {
  const script = `
    const lb = await import(${JSON.stringify(new URL("./linear-done-binding.mjs", import.meta.url).href)});
    const core = await import(${JSON.stringify(new URL("./partial-count-core.mjs", import.meta.url).href)});
    const merges = lb.parseMergeLinks("${"a".repeat(40)} 2026-11-24T01:00:00+09:00 Merge pull request #1 from o/hyk5-x");
    const events = [{ identifier: "HYK-5", atMs: Date.parse("2026-11-24T02:00:00Z"), actorId: "u" }];
    const j = lb.judgeLinearDoneBinding({ events, merges, shaStatuses: [{ sha: "${"a".repeat(40)}", status: "APPROVED" }], gate4Known: true, viewerId: "u" });
    process.stdout.write(JSON.stringify({ j, lines: core.renderLinearDoneBindingLines({ status: undefined, result: { known: true, ...j } }) }));
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    },
  );
  const child = JSON.parse(out);
  const merges = lb.parseMergeLinks(
    `${"a".repeat(40)} 2026-11-24T01:00:00+09:00 Merge pull request #1 from o/hyk5-x`,
  );
  const j = lb.judgeLinearDoneBinding({
    events: [
      {
        identifier: "HYK-5",
        atMs: Date.parse("2026-11-24T02:00:00Z"),
        actorId: "u",
      },
    ],
    merges,
    shaStatuses: [{ sha: "a".repeat(40), status: "APPROVED" }],
    gate4Known: true,
    viewerId: "u",
  });
  assert.deepEqual(child.j, JSON.parse(JSON.stringify(j)));
  assert.equal(child.j.bound, 1);
  assert.ok(child.lines[0].includes("결속 1"), child.lines[0]);
});
