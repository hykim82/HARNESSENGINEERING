// HYK-255-p2a-scope-1 커밋 1 -- (ⓐ) 판정 불가 항목이 섞인 목록 응답은 «그 회차 덮음 구간 없음» 규칙을 일별 칸으로 지킨다 ·
// (ⓑ) GitHub사람손수집기 진단 줄에 `병합 PR 제외 N` 토막이 실린다.
//
// ⛔헛시험 금지: 프로덕션 진입점(collectGithubHumanActions -> assembleGithubHumanActions -> buildDailyTickValues -> recordDailyTick ·
// rolloverDailyState · runPartialCountOnce)을 직접 구동한다 -- 사본 import 0 · helper 만 단언하는 칸 0. 저장소는 mkdtemp 합성 git, 목록 응답은 주입한
// 가짜 fetchJson. 실제 네트워크 · gh · 토큰 · 관제실 접촉 0.
// ⛔시험 단언 규율: 진단 줄 · ㄴ 분자 줄 «전체» 를 문자열 동등으로 단언하지 않는다 -- 자기 토막(`병합 PR 제외` · `항목` · `창 밖`)만 값으로 단언한다
// (다른 수집기 토막이 붙거나 빠져도 깨지지 않는다 · PR 374 CI 빨강의 원인이 줄 전체 단언이었다).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";

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
const HUMAN = "human-fixture";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: "bot-fixture-a" }],
});
const LIST_KEYS = ["closedPrs", "issueComments", "reviewComments"];
const ok200 = (json) => ({ ok: true, status: 200, json, linkHeader: null });
const FAIL404 = { ok: false, status: 404, json: null, linkHeader: null };
const FAIL500 = { ok: false, status: 500, json: null, linkHeader: null };
const iso = (ms) => new Date(ms).toISOString();
const kst = (s) =>
  Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+09:00`);
const at = (day, hhmm) => kst(`${day} ${hhmm}`);

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

// 합성 저장소 -- origin/master 에 허용 목록 + 봇 목록(병합 커밋 0).
function buildRepo() {
  const dir = tmpDir("nc-undecidable-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, ALLOWLIST_PATH), ALLOWLIST_JSON, "utf8");
  fs.writeFileSync(join(dir, BOTS_PATH), BOTS_JSON, "utf8");
  git(dir, ["add", "-A"]);
  const tree = git(dir, ["write-tree"]);
  const rootIso = iso(NOW - 100 * 24 * HOUR);
  const root = git(dir, ["commit-tree", tree, "-m", "root"], {
    GIT_AUTHOR_NAME: "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: rootIso,
    GIT_COMMITTER_NAME: "hykim82",
    GIT_COMMITTER_EMAIL: "hykim82@example.com",
    GIT_COMMITTER_DATE: rootIso,
  });
  git(dir, ["remote", "add", "origin", `https://github.com/${REPO}.git`]);
  git(dir, ["update-ref", "refs/remotes/origin/master", root]);
  return { dir };
}

// 실제 git 은 인자마다 1회만(일별 시험은 수백 회차를 돈다).
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

// ---- 가짜 목록 항목 -- 책임자 실측 칸 목록(닫힌 PR · 대화 댓글 · 리뷰 줄 댓글)뿐 ---------------------------------------------
let seq = 7000;
const nextId = () => (seq += 1);
function closedPr({
  closedAtMs,
  mergedAtMs = null,
  updatedAtMs = closedAtMs,
  id,
}) {
  return {
    id: id ?? nextId(),
    number: 1,
    state: "closed",
    closed_at: iso(closedAtMs),
    merged_at: mergedAtMs === null ? null : iso(mergedAtMs),
    updated_at: iso(updatedAtMs),
    user: { login: HUMAN },
  };
}
const issueComment = ({ atMs, id }) => ({
  id: id ?? nextId(),
  user: { login: HUMAN },
  issue_url: `https://api.github.com/repos/${REPO}/issues/7`,
  created_at: iso(atMs),
  updated_at: iso(atMs),
});
const reviewComment = ({ atMs, id }) => ({
  id: id ?? nextId(),
  user: { login: HUMAN },
  pull_request_url: `https://api.github.com/repos/${REPO}/pulls/7`,
  created_at: iso(atMs),
  updated_at: iso(atMs),
});
// 판정 불가 항목 -- 판정에 쓰는 칸 하나가 없다(닫힌 PR = merged_at · 댓글 둘 = 목록별 주소 칸).
const undecidableItem = (key, atMs) => {
  if (key === "closedPrs") {
    const item = closedPr({ closedAtMs: atMs });
    delete item.merged_at;
    return item;
  }
  if (key === "issueComments") {
    const item = issueComment({ atMs });
    delete item.issue_url;
    return item;
  }
  const item = reviewComment({ atMs });
  delete item.pull_request_url;
  return item;
};
const listKeyOfUrl = (url) => {
  const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
  if (/^\/pulls\?/.test(path)) return "closedPrs";
  if (/^\/issues\/comments\?/.test(path)) return "issueComments";
  if (/^\/pulls\/comments\?/.test(path)) return "reviewComments";
  return null;
};

// 그 시각에 «맨 앞» 으로 불리는 목록이 key 가 되는 회차 시각(NOW 이후 가장 가까운 15분 칸).
const nowWithFirst = (key) => {
  const k = LIST_KEYS.indexOf(key);
  let t = NOW;
  while (Math.floor(t / TICK_MS) % 3 !== k) t += TICK_MS;
  return t;
};

const collectAt = (repoGit, fetchJson, nowMs) =>
  report.collectGithubHumanActions({
    fetchJson,
    git: repoGit,
    allowlistPath: ALLOWLIST_PATH,
    botAccountsPath: BOTS_PATH,
    windowStartMs: nowMs - 24 * HOUR,
    windowEndMs: nowMs,
    budget: 2,
  });

const tickValues = (g, windowStartMs) =>
  core.buildDailyTickValues({
    externalEvidence: { known: true, confirmedShas: [], unchecked: 0 },
    collectors: [],
    delivered: { known: true, count: 1 },
    uncountedExamples: { items: [], version: "v1" },
    githubHumanActions: g,
    windowStartMs,
  });

// ---- ⓐ P2-1 -- 판정 불가가 있는 목록 응답 = 그 회차 덮음 구간 없음 -------------------------------------------------------

test("P2-1 회차 값: 목록 응답에 판정 불가 항목 1 이 섞이면 그 목록의 덮음 구간 = null · 판정 불가 0 이면 [창 시작, 창 끝] (세 목록 각각)", async () => {
  const repo = buildRepo();
  const repoGit = cachedGit(repo);
  const valid = {
    closedPrs: (t) => closedPr({ closedAtMs: t - 2 * HOUR }),
    issueComments: (t) => issueComment({ atMs: t - 2 * HOUR }),
    reviewComments: (t) => reviewComment({ atMs: t - 2 * HOUR }),
  };
  for (const key of LIST_KEYS) {
    const t = nowWithFirst(key);
    const respond =
      (withUndecidable) =>
      async ({ url }) => {
        if (listKeyOfUrl(url) !== key) return ok200([]);
        return ok200(
          withUndecidable
            ? [valid[key](t), undecidableItem(key, t - 3 * HOUR)]
            : [valid[key](t)],
        );
      };
    const dirty = await collectAt(repoGit, respond(true), t);
    assert.equal(dirty.lists[key].state, "ok", `${key} 호출 성공`);
    assert.equal(dirty.lists[key].undecidable, 1, `${key} 판정 불가 1`);
    assert.equal(dirty.lists[key].count, 1, `${key} 센 값은 그대로(하한)`);
    assert.equal(
      dirty.listCover[key],
      null,
      `${key} 판정 불가 있음 = 덮음 없음`,
    );
    const dirtyTick = tickValues(dirty, t - 24 * HOUR);
    assert.equal(
      dirtyTick.githubListCover[key],
      null,
      `${key} 회차 값 덮음 null`,
    );
    const clean = await collectAt(repoGit, respond(false), t);
    assert.equal(clean.lists[key].undecidable, 0);
    assert.deepEqual(
      tickValues(clean, t - 24 * HOUR).githubListCover[key],
      { startMs: t - 24 * HOUR, endMs: t },
      `${key} 판정 불가 0 = 덮음`,
    );
  }
});

// 세계 = {kind, atMs, id?, undecidable?} -- 닫힌 PR · 댓글 목록은 그 시각 이전 항목을 최신순 100건(가짜 목록이 실제 의미를 흉내낸다).
function worldFetch(world, nowMs) {
  const items = {
    closedPrs: (w) =>
      w.undecidable
        ? undecidableItem("closedPrs", w.atMs)
        : closedPr({ closedAtMs: w.atMs, id: w.id }),
    issueComments: (w) => issueComment({ atMs: w.atMs, id: w.id }),
    reviewComments: (w) => reviewComment({ atMs: w.atMs, id: w.id }),
  };
  return async ({ url }) => {
    const key = listKeyOfUrl(url);
    if (key === null) return FAIL404;
    const picked = world
      .filter((w) => w.kind === key && w.atMs <= nowMs)
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, 100);
    return ok200(picked.map(items[key]));
  };
}

async function simulate(world, days) {
  const repoGit = cachedGit(buildRepo());
  let state = null;
  const lines = [];
  for (const { day, from, to } of days) {
    for (let t = at(day, from); t <= at(day, to); t += TICK_MS) {
      const rolled = core.rolloverDailyState({
        state,
        nowMs: t,
        closedDays: new Set(lines.map((l) => l.day)),
      });
      if (rolled.closedLine) lines.push(rolled.closedLine);
      const g = await collectAt(repoGit, worldFetch(world, t), t);
      state = core.recordDailyTick({
        state: rolled.state,
        nowMs: t,
        tick: tickValues(g, t - 24 * HOUR),
        concurrentActive: 0,
      });
    }
  }
  return lines;
}

const THREE_KINDS_ON_DAY_TWO = [
  { kind: "closedPrs", id: 201, atMs: at("2026-11-11", "09:20") },
  { kind: "issueComments", id: 202, atMs: at("2026-11-11", "09:20") },
  { kind: "reviewComments", id: 203, atMs: at("2026-11-11", "09:20") },
];
const DAYS = [
  { day: "2026-11-10", from: "00:00", to: "23:45" },
  { day: "2026-11-11", from: "00:00", to: "23:45" },
  { day: "2026-11-12", from: "00:00", to: "00:15" },
];

test("P2-1 일별 칸: 판정 불가 항목이 그날 내내 목록에 있으면 그날 GitHub 칸 = null(0 아님) + 사유 · 판정 불가 0 이면 같은 입력에서 수", async () => {
  // 대조군 -- 판정 불가 항목 없음: 둘째 날 = 그날 센 3건.
  const control = (await simulate(THREE_KINDS_ON_DAY_TWO, DAYS)).find(
    (l) => l.day === "2026-11-11",
  );
  assert.equal(control.githubHumanActions, 3, "판정 불가 0 = 덮임 = 수");
  assert.equal(control.githubHumanActionsGap, undefined);
  // 같은 입력 + 닫힌 PR 목록에 판정 불가 항목 1(앞 날부터 계속 목록에 있다).
  const dirtyWorld = [
    ...THREE_KINDS_ON_DAY_TWO,
    { kind: "closedPrs", atMs: at("2026-11-09", "12:00"), undecidable: true },
  ];
  const dirty = (await simulate(dirtyWorld, DAYS)).find(
    (l) => l.day === "2026-11-11",
  );
  assert.equal(
    dirty.githubHumanActions,
    null,
    "판정 불가 있음 = 덮이지 않음 = null",
  );
  assert.notEqual(dirty.githubHumanActions, 0, "0 으로 접지 않는다");
  assert.match(dirty.githubHumanActionsGap, /닫힌 PR 덮지 못함/);
  assert.equal(
    /대화 댓글 덮지 못함|리뷰 줄 댓글 덮지 못함/.test(
      dirty.githubHumanActionsGap,
    ),
    false,
    "덮이지 않은 것은 판정 불가가 섞인 목록 하나뿐",
  );
});

// ---- ⓑ 진단 줄 `병합 PR 제외 N` ---------------------------------------------------------------------------------------

async function runReport(lists, { first = "closedPrs", failKeys = [] } = {}) {
  const now = nowWithFirst(first);
  const repo = buildRepo();
  const root = tmpDir("nc-undecidable-run-");
  const fetchJson = async ({ url }) => {
    const key = listKeyOfUrl(url);
    if (key === null) return FAIL404;
    if (failKeys.includes(key)) return FAIL500;
    const data = typeof lists === "function" ? lists(now) : lists;
    return ok200(data[key] ?? []);
  };
  const result = await report.runPartialCountOnce({
    now,
    repoRoot: repo.dir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson,
    git: report.createProcessGitPort(repo.dir),
    gitWorktreeListExecFn: () => "",
  });
  return { result, now };
}

// 관측 건강 줄에서 GitHub사람손수집기 토막의 괄호 안 -- 자기 토막만 읽는다(다른 수집기 토막은 읽지 않는다).
const githubCollectorDetail = (reportText) => {
  const m = /GitHub사람손수집기 OK\(([^)]*)\)/.exec(reportText);
  assert.notEqual(m, null, "GitHub사람손수집기 진단 토막이 있다");
  return m[1];
};

test("진단 줄: 닫힌 PR 목록 병합 3 · 미병합 창 안 1 · 창 밖 1 -> `병합 PR 제외 3` · `창 밖 1` · `항목 5건` (값 단언 · 이웃 순서 = 봇 제외 바로 뒤)", async () => {
  const { result } = await runReport((t) => ({
    closedPrs: [
      closedPr({ closedAtMs: t - 3 * HOUR, mergedAtMs: t - 3 * HOUR }),
      closedPr({ closedAtMs: t - 4 * HOUR, mergedAtMs: t - 4 * HOUR }),
      closedPr({ closedAtMs: t - 5 * HOUR, mergedAtMs: t - 5 * HOUR }),
      closedPr({ closedAtMs: t - 2 * HOUR }),
      closedPr({ closedAtMs: t - 25 * HOUR, updatedAtMs: t - 1 * HOUR }),
    ],
  }));
  const detail = githubCollectorDetail(result.reportText);
  assert.match(detail, /항목 5건/);
  assert.match(detail, /병합 PR 제외 3(?!\d)/);
  assert.match(detail, /창 밖 1(?!\d)/);
  assert.match(
    detail,
    /봇 제외 \d+ · 병합 PR 제외 3(?!\d)/,
    "봇 제외 바로 뒤 토막",
  );
  assert.equal(
    result.githubHumanActions.unmergedClose,
    1,
    "병합 3 은 분자에 안 든다",
  );
  assert.equal(
    Object.hasOwn(result.githubHumanActions, "mergedClosed"),
    false,
    "core 반환 칸 무변 -- 병합 수는 목록별 칸에서만 읽는다",
  );
  assert.equal(result.githubHumanActions.lists.closedPrs.mergedClosed, 3);
});

test("진단 줄: 100건 전부 병합이면 `항목 100건` 이어도 `창 밖 0` 이고 `병합 PR 제외 100` -- 100건이 다 창 안이라는 오독을 푼다", async () => {
  const { result } = await runReport((t) => ({
    // 100건 꽉 참 -- 끝 항목의 갱신 시각이 창 시작 이전이어야 «덮음» (그렇지 않으면 미조회).
    closedPrs: Array.from({ length: 100 }, (_, i) =>
      closedPr({
        closedAtMs: t - (2 + i) * 15 * MIN,
        mergedAtMs: t - (2 + i) * 15 * MIN,
        updatedAtMs: i === 99 ? t - 25 * HOUR : t - (2 + i) * 15 * MIN,
      }),
    ),
  }));
  const detail = githubCollectorDetail(result.reportText);
  assert.match(detail, /항목 100건/);
  assert.match(detail, /창 밖 0(?!\d)/);
  assert.match(detail, /병합 PR 제외 100(?!\d)/);
});

test("진단 줄: 실패한 목록(500)의 병합분은 합에 들지 않는다 -- 닫힌 PR 목록 실패 + 댓글 목록 성공 = `병합 PR 제외 0`", async () => {
  const { result } = await runReport(
    (t) => ({
      closedPrs: [
        closedPr({ closedAtMs: t - 3 * HOUR, mergedAtMs: t - 3 * HOUR }),
      ],
      issueComments: [issueComment({ atMs: t - 2 * HOUR })],
    }),
    { failKeys: ["closedPrs"] },
  );
  assert.equal(result.githubHumanActions.lists.closedPrs.state, "failed");
  assert.equal(result.githubHumanActions.lists.issueComments.state, "ok");
  const detail = githubCollectorDetail(result.reportText);
  assert.match(detail, /병합 PR 제외 0(?!\d)/);
  assert.match(detail, /항목 1건/, "성공한 목록만 센다");
});
