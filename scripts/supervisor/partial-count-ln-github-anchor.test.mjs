// HYK-255-ln-github-anchor-1 (coder-task.md §2 ⓒ) -- ㄴ 독립 수집기 1호
// («GitHub 웹 Update branch 병합 커밋» 후보 + 무인증 REST 서명 확인)의
// 계약 시험. ⛔헛시험 금지: 프로덕션 export(collectExternalEvidenceCandidates ·
// runPartialCountOnce)를 직접 구동하고, 후보 고름은 mkdtemp 합성 git 저장소
// (committer GitHub · 부모 2 · «Merge branch» 메시지 / 사람 committer 일반
// 병합 / 창 밖)에 실제 git 을 돌려 만든다. fetchJson 은 주입 가짜 -- 이 시험
// 에서 실제 네트워크·gh·토큰·관제실·받는함 접촉은 0 이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as report from "./partial-count-report.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const REPO = "hykim82/HARNESSENGINEERING";
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
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});
const LN_LINE_PREFIX = "- 외부 독립 증거 후보: ";

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

// 합성 저장소용 git 실행 -- 사용자 전역 설정(서명·훅)에 기대지 않는다.
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

function commitTree(cwd, { parents, message, committer, authorName, atMs }) {
  const tree = git(cwd, ["rev-parse", `${parents[0]}^{tree}`]);
  const iso = new Date(atMs).toISOString();
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", message);
  return git(cwd, args, {
    GIT_AUTHOR_NAME: authorName ?? "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: iso,
  });
}

const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };

// 합성 저장소: 루트(허용 목록 파일 포함) -> origin/master. specs 순서대로
// «PR 브랜치 쪽 병합 커밋»을 만들고 마지막에 GitHub «Merge pull request»
// 로 origin/master 에 합친다(후보는 first-parent 가 아니라 «도달 가능»
// 해야 한다 -- 실물 Update branch 병합 커밋이 그 모양이다). 루트 커밋의
// 트리는 commit-tree 가 부모에서 못 얻으므로 write-tree 로 만든다.
function buildRepo(specs) {
  const dir = tmpDir("nc-ln-gh-anchor-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
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
  // PR 브랜치: S0 -> (spec 병합 커밋들, 각각 부모 = [직전, root])
  let prev = commitTree(dir, {
    parents: [root],
    message: "feat: work on the PR branch",
    committer: HUMAN_COMMITTER,
    atMs: NOW - 90 * 24 * HOUR,
  });
  const shas = [];
  for (const spec of specs) {
    const sha = commitTree(dir, {
      parents: spec.parents ? spec.parents(prev, root) : [prev, root],
      message: spec.message ?? "Merge branch 'master' into feat/x",
      committer: spec.committer ?? GITHUB_COMMITTER,
      atMs: spec.atMs,
    });
    shas.push(sha);
    prev = sha;
  }
  const mainline = commitTree(dir, {
    parents: [root, prev],
    message: "Merge pull request #1 from hykim82/feat-x",
    committer: GITHUB_COMMITTER,
    atMs: NOW - 5 * 60 * 1000,
  });
  git(dir, ["update-ref", "refs/remotes/origin/master", mainline]);
  return { dir, root, shas, mainline };
}

function updateBranchSpec(minutesAgo, extra = {}) {
  return { atMs: NOW - minutesAgo * 60 * 1000, ...extra };
}

function validCommitPayload(sha, overrides = {}) {
  return {
    sha,
    commit: {
      verification: { verified: true, reason: "valid" },
      committer: { name: "GitHub", email: "noreply@github.com" },
    },
    author: { login: "hykim82", id: 286230306 },
    committer: { login: "web-flow", id: 19864447 },
    ...overrides,
  };
}

// fetchJson 가짜 -- 호출 인자를 전부 기록한다(재시도 0 · 호출 상한 단언용).
function makeFetch(handler) {
  const calls = [];
  const fetchJson = async (opts) => {
    calls.push(opts);
    return handler(opts, calls.length);
  };
  return { fetchJson, calls };
}

function okResponse(json) {
  return { ok: true, status: 200, json, linkHeader: null };
}

function commitUrl(sha) {
  return `https://api.github.com/repos/${REPO}/commits/${sha}`;
}

function shaOfUrl(url) {
  return url.split("/commits/")[1];
}

function processGit(dir) {
  return report.createProcessGitPort(dir);
}

async function collect(dir, fetchJson, extra = {}) {
  return report.collectExternalEvidenceCandidates({
    fetchJson,
    git: processGit(dir),
    allowlistPath: ALLOWLIST_PATH,
    windowStartMs: NOW - 24 * HOUR,
    windowEndMs: NOW,
    maxChecks: 10,
    ...extra,
  });
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("확인 1: Update branch 후보 + 검증 통과 fetch -> 확인 1 · 미조회 0, 호출 1회, 인증 헤더·옵션 없는 {url} 뿐", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(({ url }) =>
      okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.known, true);
    assert.equal(r.confirmed, 1);
    assert.equal(r.unchecked, 0);
    assert.deepEqual(r.confirmedShas, [repo.shas[0]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, commitUrl(repo.shas[0]));
    assert.deepEqual(Object.keys(calls[0]), ["url"]);
  } finally {
    cleanup(repo.dir);
  }
});

test("서명 미검증 -> 확인 0 (verified:false · reason unsigned)", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(({ url }) =>
      okResponse(
        validCommitPayload(shaOfUrl(url), {
          commit: {
            verification: { verified: false, reason: "unsigned" },
            committer: { name: "GitHub", email: "noreply@github.com" },
          },
        }),
      ),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.known, true);
    assert.equal(r.confirmed, 0);
    assert.equal(calls.length, 1);
  } finally {
    cleanup(repo.dir);
  }
});

test("verified:true 라도 reason 이 valid 가 아니면 확인 0", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson } = makeFetch(({ url }) =>
      okResponse(
        validCommitPayload(shaOfUrl(url), {
          commit: {
            verification: { verified: true, reason: "unknown_key" },
            committer: { name: "GitHub", email: "noreply@github.com" },
          },
        }),
      ),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.confirmed, 0);
  } finally {
    cleanup(repo.dir);
  }
});

test("서명 주체가 web-flow 가 아니면 확인 0", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson } = makeFetch(({ url }) =>
      okResponse(
        validCommitPayload(shaOfUrl(url), {
          committer: { login: "some-human", id: 1 },
        }),
      ),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.confirmed, 0);
  } finally {
    cleanup(repo.dir);
  }
});

test("작성자가 승인 허용 목록의 사람이 아니면 확인 0 (login 불일치 · id 불일치 둘 다)", async () => {
  const repo = buildRepo([updateBranchSpec(30), updateBranchSpec(20)]);
  try {
    const authors = new Map([
      [repo.shas[0], { login: "stranger", id: 286230306 }],
      [repo.shas[1], { login: "hykim82", id: 1 }],
    ]);
    const { fetchJson } = makeFetch(({ url }) => {
      const sha = shaOfUrl(url);
      return okResponse(validCommitPayload(sha, { author: authors.get(sha) }));
    });
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.confirmed, 0);
    assert.equal(r.unchecked, 0);
  } finally {
    cleanup(repo.dir);
  }
});

test("사람 committer 일반 병합 · 부모 1 · «Merge pull request» · 창 밖 -> 후보 아님, REST 호출 0", async () => {
  const repo = buildRepo([
    updateBranchSpec(30, { committer: HUMAN_COMMITTER }),
    updateBranchSpec(25, { message: "Merge pull request #9 from a/b" }),
    updateBranchSpec(20, { parents: (prev) => [prev] }),
    { atMs: NOW - 30 * HOUR },
  ]);
  try {
    const { fetchJson, calls } = makeFetch(() => okResponse({}));
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.known, true);
    assert.equal(r.candidatesInWindow, 0);
    assert.equal(r.confirmed, 0);
    assert.equal(r.unchecked, 0);
    assert.equal(calls.length, 0);
  } finally {
    cleanup(repo.dir);
  }
});

test("후보 11 -> 조회 10 · 미조회(예산) 1 (회차 상한 10, 11번째 REST 호출 0)", async () => {
  const specs = [];
  for (let i = 0; i < 11; i++) specs.push(updateBranchSpec(200 - i * 10));
  const repo = buildRepo(specs);
  try {
    const { fetchJson, calls } = makeFetch(({ url }) =>
      okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(r.candidatesInWindow, 11);
    assert.equal(calls.length, 10);
    assert.equal(r.confirmed, 10);
    assert.equal(r.unchecked, 1);
    assert.equal(r.uncheckedByBudget, 1);
  } finally {
    cleanup(repo.dir);
  }
});

test("403 rate limit -> 미조회(예산 · rate limit) -- 판정 문면 «미조회(예산)» 안에 rate limit 이 묶인다, 재시도 0 (가짜 fetch 호출 수 단언) 이고 이후 후보도 조회하지 않는다", async () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push(updateBranchSpec(200 - i * 10));
  const repo = buildRepo(specs);
  try {
    const { fetchJson, calls } = makeFetch(({ url }, n) =>
      n === 2
        ? { ok: false, status: 403, json: null, linkHeader: null }
        : okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(calls.length, 2, "403 뒤 재시도·추가 조회 0");
    assert.equal(r.confirmed, 1);
    assert.equal(r.unchecked, 4);
    assert.equal(r.uncheckedByRateLimit, 1);
    assert.equal(r.uncheckedByBudget, 3);
  } finally {
    cleanup(repo.dir);
  }
});

// HYK-255-g-aux-render-1 커밋 3 (D1 검토 P2-2) -- 403/429 는 판정 문면 «미조회(예산)»
// 의 한 갈래다. 진단 줄이 «예산» 과 나란한 별도 낱말로 «rate limit» 을 찍지 않고
// «예산(rate limit 포함)» 으로 묶어 표기한다. 계수 필드(uncheckedByRateLimit ·
// uncheckedByBudget · unchecked)와 중단 동작은 그대로다(위 시험이 단언).
test("P2-2: 403 진단 줄은 «미조회: 예산(rate limit 포함) 4(그중 rate limit 1) · 조회 실패 0» 이고 후보별 진단도 «미조회(예산 · rate limit: …)» 다", async () => {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push(updateBranchSpec(200 - i * 10));
  const repo = buildRepo(specs);
  try {
    const { fetchJson } = makeFetch(({ url }, n) =>
      n === 2
        ? { ok: false, status: 403, json: null, linkHeader: null }
        : okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const result = await runOnce(repo, fetchJson);
    // ㄴ 절 줄은 무변: U = 예산 3 + rate limit 1.
    assert.ok(
      result.reportText.includes(
        `${LN_LINE_PREFIX}확인 1 · 미조회 4 · ㄴ 분자 반영\n`,
      ),
    );
    const healthText = result.reportText.slice(
      result.reportText.indexOf("관측 건강:"),
    );
    assert.match(
      healthText,
      /미조회: 예산\(rate limit 포함\) 4\(그중 rate limit 1\) · 조회 실패 0/,
    );
    assert.match(healthText, /[0-9a-f]{7} 미조회\(예산 · rate limit: [^)]*\)/);
    // 옛 표기(«예산 N · rate limit M» 나란히)는 남지 않는다.
    assert.doesNotMatch(healthText, /미조회: 예산 \d+ · rate limit \d+/);
    assert.doesNotMatch(healthText, /[0-9a-f]{7} rate limit\(/);
  } finally {
    cleanup(repo.dir);
  }
});

test("그 밖 조회 실패(404 · 던짐 · 모양 위반)는 확인으로 세지 않고 미조회에 들어가며 사유가 진단에 남는다 (다음 후보 조회는 계속)", async () => {
  const specs = [];
  for (let i = 0; i < 4; i++) specs.push(updateBranchSpec(200 - i * 10));
  const repo = buildRepo(specs);
  try {
    const { fetchJson, calls } = makeFetch(({ url }, n) => {
      if (n === 1) return { ok: false, status: 404, json: null };
      if (n === 2) throw new Error("socket hang up");
      if (n === 3) return okResponse({ sha: shaOfUrl(url), commit: "bad" });
      return okResponse(validCommitPayload(shaOfUrl(url)));
    });
    const r = await collect(repo.dir, fetchJson);
    assert.equal(calls.length, 4);
    assert.equal(r.confirmed, 1);
    assert.equal(r.unchecked, 3);
    assert.equal(r.uncheckedByFailure, 3);
    assert.ok(
      r.diagnostics.some((d) => d.includes("404")),
      "404 사유가 진단에 남는다",
    );
    assert.ok(r.diagnostics.some((d) => d.includes("socket hang up")));
    assert.ok(r.diagnostics.some((d) => d.includes("모양")));
  } finally {
    cleanup(repo.dir);
  }
});

test("다른 커밋의 응답(sha 불일치)은 검증 통과 모양이어도 확인이 아니라 미조회(모양 위반)다", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(() =>
      okResponse(validCommitPayload("d".repeat(40))),
    );
    const r = await collect(repo.dir, fetchJson);
    assert.equal(calls.length, 1);
    assert.equal(r.confirmed, 0);
    assert.equal(r.unchecked, 1);
    assert.equal(r.uncheckedByFailure, 1);
    assert.ok(r.diagnostics.some((d) => d.includes("모양")));
  } finally {
    cleanup(repo.dir);
  }
});

test("캐시는 승인 권위가 아니다: 같은 후보도 회차마다 그 회차 REST 응답으로만 확인된다", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const first = makeFetch(({ url }) =>
      okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const second = makeFetch(({ url }) =>
      okResponse(
        validCommitPayload(shaOfUrl(url), {
          commit: {
            verification: { verified: false, reason: "unsigned" },
            committer: { name: "GitHub", email: "noreply@github.com" },
          },
        }),
      ),
    );
    assert.equal((await collect(repo.dir, first.fetchJson)).confirmed, 1);
    assert.equal((await collect(repo.dir, second.fetchJson)).confirmed, 0);
    assert.equal(second.calls.length, 1, "두 번째 회차도 다시 조회한다");
  } finally {
    cleanup(repo.dir);
  }
});

test("후보 고름 git 실패 -> known:false + 사유 (bare 0 으로 접히지 않는다)", async () => {
  const { fetchJson, calls } = makeFetch(() => okResponse({}));
  const r = await report.collectExternalEvidenceCandidates({
    fetchJson,
    git: { run: () => ({ code: 128, stdout: "", stderr: "no origin/master" }) },
    allowlistPath: ALLOWLIST_PATH,
    windowStartMs: NOW - 24 * HOUR,
    windowEndMs: NOW,
    maxChecks: 10,
  });
  assert.equal(r.known, false);
  assert.match(r.reason, /no origin\/master/);
  assert.equal(calls.length, 0);
});

test("허용 목록 읽기 실패 -> known:false + 사유, REST 호출 0", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(() => okResponse({}));
    const r = await collect(repo.dir, fetchJson, {
      allowlistPath: "scripts/supervisor/does-not-exist.json",
    });
    assert.equal(r.known, false);
    assert.match(r.reason, /허용 목록/);
    assert.equal(calls.length, 0);
  } finally {
    cleanup(repo.dir);
  }
});

// ---- runPartialCountOnce 결선 (프로덕션 조립 함수) -----------------------

async function runOnce(repo, fetchJson, extra = {}) {
  const root = tmpDir("nc-ln-gh-anchor-run-");
  try {
    return await report.runPartialCountOnce({
      now: NOW,
      repoRoot: repo.dir,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "none.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      fetchJson: passGithubEvents(fetchJson),
      git: processGit(repo.dir),
      gitWorktreeListExecFn: () => "",
      ...extra,
    });
  } finally {
    cleanup(root);
  }
}

test("보고서 ㄴ 절 새 줄: 확인 1 · 미조회 0 · ㄴ 분자 반영, 그리고 ㄴ 확인 사건(분자)은 «확인 1건» (HYK-255-ln-update-branch-1 의도된 변경 -- 옛 단언은 «확인 0건» 그대로였다)", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson } = makeFetch(({ url }) =>
      okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const result = await runOnce(repo, fetchJson);
    const text = result.reportText;
    assert.ok(
      text.includes(`${LN_LINE_PREFIX}확인 1 · 미조회 0 · ㄴ 분자 반영\n`),
      text,
    );
    assert.ok(text.includes("- 외부 독립 증거로 확인된 사건: 확인 1건\n"));
    assert.ok(!text.includes("외부 독립 증거로 확인된 사건: 확인 0건"));
    // 줄은 정확히 1개, ㄴ 절 안에 있다.
    const lnStart = text.indexOf("ㄴ 계획 밖 개입:");
    const healthStart = text.indexOf("관측 건강:");
    const idx = text.indexOf(LN_LINE_PREFIX);
    assert.ok(idx > lnStart && idx < healthStart);
    assert.equal(text.split(LN_LINE_PREFIX).length - 1, 1);
    assert.equal(result.externalEvidence.confirmed, 1);
  } finally {
    cleanup(repo.dir);
  }
});

// HYK-255-ln-update-branch-1 커밋 3 (의도된 변경 · 판정 1804/교정 1904): D1 기본 상한 10 -> 4.
// 후보 11 -> 확인 4 · 미조회 7(예산) · 호출 4 (옛 값: 확인 10 · 미조회 1 · 호출 10).
test("보고서: 예산 초과 모양 (후보 11 -> 확인 4 · 미조회 7 · 호출 4 -- 기본 상한 4)", async () => {
  const specs = [];
  for (let i = 0; i < 11; i++) specs.push(updateBranchSpec(200 - i * 10));
  const repo = buildRepo(specs);
  try {
    const { fetchJson, calls } = makeFetch(({ url }) =>
      okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const result = await runOnce(repo, fetchJson);
    assert.ok(
      result.reportText.includes(
        `${LN_LINE_PREFIX}확인 4 · 미조회 7 · ㄴ 분자 반영\n`,
      ),
    );
    assert.ok(
      result.reportText.includes(
        "- 외부 독립 증거로 확인된 사건: 확인 4건 이상 · 미조회 7\n",
      ),
    );
    assert.equal(calls.length, 4);
  } finally {
    cleanup(repo.dir);
  }
});

test("보고서: 수집 실패 모양 -> «수집 실패(사유)» 줄, bare 숫자 0 금지", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson } = makeFetch(() => okResponse({}));
    const failingLog = {
      run(args) {
        if (args[0] === "log") {
          return { code: 128, stdout: "", stderr: "fatal: bad revision" };
        }
        return processGit(repo.dir).run(args);
      },
    };
    const result = await runOnce(repo, fetchJson, { git: failingLog });
    const line = result.reportText
      .split("\n")
      .find((l) => l.startsWith(LN_LINE_PREFIX));
    assert.ok(line, "줄이 있어야 한다");
    assert.match(
      line,
      /^- 외부 독립 증거 후보: 수집 실패\(.*fatal: bad revision.*\)$/,
    );
    assert.ok(!/확인 0/.test(line));
  } finally {
    cleanup(repo.dir);
  }
});

test("기존 ㄱ-4 상한(maxMergeChecks)과 별개: maxMergeChecks:0 이어도 새 수집기는 자기 상한(기본 4 · 옛 10 -- 커밋 3 의도된 변경)으로 돈다", async () => {
  const repo = buildRepo([updateBranchSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(({ url }) =>
      okResponse(validCommitPayload(shaOfUrl(url))),
    );
    await runOnce(repo, fetchJson, { maxMergeChecks: 0 });
    assert.equal(calls.length, 1);
    assert.equal(report.DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS, 4);
  } finally {
    cleanup(repo.dir);
  }
});

test("진단 줄(관측 건강)에 조회 실패 사유가 남는다 -- ㄴ 절 줄은 1개뿐", async () => {
  const repo = buildRepo([updateBranchSpec(30), updateBranchSpec(20)]);
  try {
    const { fetchJson } = makeFetch(({ url }, n) =>
      n === 1
        ? { ok: false, status: 404, json: null }
        : okResponse(validCommitPayload(shaOfUrl(url))),
    );
    const result = await runOnce(repo, fetchJson);
    assert.ok(
      result.reportText.includes(
        `${LN_LINE_PREFIX}확인 1 · 미조회 1 · ㄴ 분자 반영\n`,
      ),
    );
    const healthText = result.reportText.slice(
      result.reportText.indexOf("관측 건강:"),
    );
    assert.match(healthText, /외부독립증거후보수집기[^\n]*404/);
  } finally {
    cleanup(repo.dir);
  }
});
