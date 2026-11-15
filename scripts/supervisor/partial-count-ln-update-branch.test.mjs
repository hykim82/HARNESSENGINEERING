// HYK-255-ln-update-branch-1 (coder-task.md §2) -- «GitHub 웹 Update branch 클릭» 이
// 외부 독립 증거로 확인되면 ㄴ 분자(계획 밖 개입 확인 건수)에 들어간다.
// 한용 확정 2026-11-13 15:3x(전달 #20261113-1540) 항목 1 · 3 · 4.
//   커밋 1 = 확인분(그 회차 REST 응답으로 확인된 Update branch 커밋)이 «분류 대기» 에서
//            ㄴ 분자(`외부 독립 증거로 확인된 사건: 확인 N건`)로 옮겨 간다. 미조회 · 불일치 ·
//            스테일 직전 값 · 창 밖 · 로컬 봇 병합 커밋은 분자 밖이다.
//   커밋 3 = 회차당 호출 상한(두 기본 상수) + 분자 하한 표기 (아래 별도 구간).
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce · collectExternalEvidenceCandidates ·
// buildPartialCountReport)을 직접 구동한다. 저장소는 mkdtemp 합성 git(실제 git 을 돌린다),
// fetchJson 은 주입 가짜 -- 실제 네트워크 · gh · 토큰 · 관제실 · 받는함 접촉 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as report from "./partial-count-report.mjs";
import {
  buildPartialCountReport,
  parseExternalEvidenceCandidateLine,
  renderConfirmedLnCount,
} from "./partial-count-core.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const REPO = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});
// HYK-255-p3-gh-1 -- P3(GitHub 사람 손 수집기)는 이 시험의 관심 밖이다. 합성 저장소에 봇 목록 파일을 둬서 P3 가 «수집 실패»
// 로 분자 표기(하한 토막)를 바꾸지 않게 하고, 사건 목록 호출은 빈 목록(사람 손 0)으로 받아 이 시험의 호출 기록 · 상한 단언에
// 섞지 않는다(passGithubEvents).
const BOTS_PATH = "scripts/supervisor/github-bot-accounts.json";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: "bot-fixture-a" }],
});
const passGithubEvents = (fetchJson) => (opts) =>
  /\/events\?per_page=/.test(opts.url)
    ? { ok: true, status: 200, json: [], linkHeader: null }
    : fetchJson(opts);
const LN_LINE_PREFIX = "- 외부 독립 증거 후보: ";
const NUMERATOR_PREFIX = "- 외부 독립 증거로 확인된 사건: ";
const STATE_KEY = "__externalEvidenceCandidates";
const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
// 로컬 봇(자동 갱신) 병합 커밋 -- 사람 계정이 아니고 GitHub 웹 committer 도 아니다.
const LOCAL_BOT_COMMITTER = { name: "harness-bot", email: "bot@harness.local" };

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

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

// 합성 저장소: 루트(허용 목록 파일 포함) -> PR 브랜치 위에 spec 병합 커밋들 ->
// GitHub «Merge pull request» 로 origin/master 에 합친다(후보는 도달 가능해야 한다).
function buildRepo(specs) {
  const dir = tmpDir("nc-ln-ub-");
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
  let prev = commitTree(dir, {
    parents: [root],
    message: "feat: work on the PR branch",
    committer: HUMAN_COMMITTER,
    atMs: NOW - 90 * 24 * HOUR,
  });
  const shas = [];
  for (const spec of specs) {
    const sha = commitTree(dir, {
      parents: [prev, root],
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
  return { dir, shas };
}

const ubSpec = (minutesAgo, extra = {}) => ({
  atMs: NOW - minutesAgo * 60 * 1000,
  ...extra,
});

function validPayload(sha, overrides = {}) {
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

function makeFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchJson: async (opts) => {
      calls.push(opts);
      return handler(opts, calls.length);
    },
  };
}

const shaOfUrl = (url) => url.split("/commits/")[1];
const okResponse = (json) => ({
  ok: true,
  status: 200,
  json,
  linkHeader: null,
});
const confirmedHandler = ({ url }) => okResponse(validPayload(shaOfUrl(url)));

// runPartialCountOnce 프로덕션 진입점 1회 구동. stateEntry 를 주면 감시 상태 파일
// (reach-notify-state.json -- watch 로그와 같은 폴더)에 직전 확인값을 둔다.
async function runOnce(repo, fetchJson, { stateEntry, extra = {} } = {}) {
  const root = tmpDir("nc-ln-ub-run-");
  try {
    if (stateEntry !== undefined) {
      fs.writeFileSync(
        join(root, "reach-notify-state.json"),
        JSON.stringify({ [STATE_KEY]: stateEntry }),
        "utf8",
      );
    }
    return await report.runPartialCountOnce({
      now: NOW,
      repoRoot: repo.dir,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      fetchJson: passGithubEvents(fetchJson),
      git: report.createProcessGitPort(repo.dir),
      gitWorktreeListExecFn: () => "",
      ...extra,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const numeratorLine = (text) =>
  text.split("\n").find((l) => l.startsWith(NUMERATOR_PREFIX));
const candidateLine = (text) =>
  text.split("\n").find((l) => l.startsWith(LN_LINE_PREFIX));
const cleanup = (repo) => fs.rmSync(repo.dir, { recursive: true, force: true });

// ---- 순수 렌더 (core) ------------------------------------------------------

test("ㄴ 분자 렌더: 확인 N건 모양 -- 0 은 «확인 0건», 1 은 «확인 1건» (bare «0건» 금지)", () => {
  assert.equal(renderConfirmedLnCount(0), "확인 0건");
  assert.equal(renderConfirmedLnCount(1), "확인 1건");
  assert.equal(renderConfirmedLnCount(4), "확인 4건");
});

// ---- 확인 1 -> 분자 1 -----------------------------------------------------

test("ⓐ 확인 1: Update branch 1건이 그 회차 REST 응답으로 확인되면 ㄴ 분자 «확인 1건» (분류 대기 아님)", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    const text = result.reportText;
    assert.equal(numeratorLine(text), `${NUMERATOR_PREFIX}확인 1건`);
    assert.equal(
      candidateLine(text),
      `${LN_LINE_PREFIX}확인 1 · 미조회 0 · ㄴ 분자 반영`,
    );
    assert.ok(
      !text.includes("분류 대기"),
      "사실과 맞지 않는 «분류 대기» 문면 0",
    );
    assert.equal(calls.length, 1, "REST 호출 수 무변 -- 후보당 1회");
    assert.equal(result.externalEvidence.confirmed, 1);
  } finally {
    cleanup(repo);
  }
});

test("ⓐ 확인 2: 서로 다른 Update branch 2건이 확인되면 ㄴ 분자 «확인 2건»", async () => {
  const repo = buildRepo([ubSpec(60), ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 2건`,
    );
    assert.equal(result.externalEvidence.confirmed, 2);
  } finally {
    cleanup(repo);
  }
});

test("ⓐ 분자는 그 회차 REST 응답으로만 센다: 같은 후보가 다음 회차에 불일치면 분자 0 (캐시는 승인 권위 아님)", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const first = makeFetch(confirmedHandler);
    const second = makeFetch(({ url }) =>
      okResponse(
        validPayload(shaOfUrl(url), {
          commit: {
            verification: { verified: false, reason: "unsigned" },
            committer: { name: "GitHub", email: "noreply@github.com" },
          },
        }),
      ),
    );
    const r1 = await runOnce(repo, first.fetchJson);
    const r2 = await runOnce(repo, second.fetchJson);
    assert.equal(numeratorLine(r1.reportText), `${NUMERATOR_PREFIX}확인 1건`);
    assert.equal(numeratorLine(r2.reportText), `${NUMERATOR_PREFIX}확인 0건`);
    assert.equal(second.calls.length, 1, "두 번째 회차도 다시 조회한다");
  } finally {
    cleanup(repo);
  }
});

// ---- 분자 밖 (미조회 · 불일치 · 스테일 · 창 밖) -----------------------------

test("분자 밖 ⓑ 미조회(조회 실패 404): 확인 0건 · 미조회 1 -- 분자에 넣지 않는다", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(() => ({
      ok: false,
      status: 404,
      json: null,
    }));
    const result = await runOnce(repo, fetchJson);
    // 분자 0 -- 미조회 1 이라 커밋 3 의 하한 표기가 붙는다(«확인 0건 이상 · 미조회 1»).
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건 이상 · 미조회 1`,
    );
    assert.equal(
      candidateLine(result.reportText),
      `${LN_LINE_PREFIX}확인 0 · 미조회 1 · ㄴ 분자 반영`,
    );
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓒ rate limit(429): 미조회 -- 분자에 넣지 않는다 · 재시도 0", async () => {
  const repo = buildRepo([ubSpec(60), ubSpec(30)]);
  try {
    const { fetchJson, calls } = makeFetch(() => ({
      ok: false,
      status: 429,
      json: null,
      linkHeader: null,
    }));
    const result = await runOnce(repo, fetchJson);
    // 분자 0 · 미조회 2(429 한 건 + 429 뒤 남은 후보 한 건) -- 하한 표기.
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건 이상 · 미조회 2`,
    );
    assert.equal(calls.length, 1, "429 뒤 남은 후보는 더 조회하지 않는다");
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓓ 서명 불일치(verified:false): 불일치 -- 분자에 넣지 않는다", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(({ url }) =>
      okResponse(
        validPayload(shaOfUrl(url), {
          commit: {
            verification: { verified: false, reason: "unsigned" },
            committer: { name: "GitHub", email: "noreply@github.com" },
          },
        }),
      ),
    );
    const result = await runOnce(repo, fetchJson);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
    assert.equal(result.externalEvidence.notConfirmed, 1);
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓓ 작성자가 허용 목록 밖: 불일치 -- 분자에 넣지 않는다", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(({ url }) =>
      okResponse(
        validPayload(shaOfUrl(url), { author: { login: "stranger", id: 1 } }),
      ),
    );
    const result = await runOnce(repo, fetchJson);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
    assert.equal(result.externalEvidence.notConfirmed, 1);
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓓ 응답 sha 불일치: 검증 통과 모양이어도 분자에 넣지 않는다(미조회)", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(() =>
      okResponse(validPayload("d".repeat(40))),
    );
    const result = await runOnce(repo, fetchJson);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건 이상 · 미조회 1`,
    );
    assert.equal(result.externalEvidence.unchecked, 1);
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓔ 스테일 직전 값: 직전 확인 1 · 이번 회차 403 -> 스테일 표시만 붙고 분자는 «확인 0건»", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(() => ({
      ok: false,
      status: 403,
      json: null,
      linkHeader: null,
    }));
    const result = await runOnce(repo, fetchJson, {
      stateEntry: { confirmed: 1, atMs: NOW - 2 * HOUR },
    });
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건 이상 · 미조회 1`,
    );
    assert.ok(
      candidateLine(result.reportText).includes(
        "스테일 표시(확인 아님): 직전 확인 1",
      ),
    );
    assert.equal(result.externalEvidence.confirmed, 0);
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓕ 창 밖(25시간 전) Update branch: 후보 0 · REST 0 -- 분자 «확인 0건» (창 = 수집기 현행 24시간 그대로)", async () => {
  const repo = buildRepo([ubSpec(25 * 60)]);
  try {
    const { fetchJson, calls } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
    assert.equal(calls.length, 0);
    assert.equal(result.externalEvidence.candidatesInWindow, 0);
  } finally {
    cleanup(repo);
  }
});

test("분자 밖 ⓖ 수집 실패(known:false): 분자는 «확인 0건» -- 줄은 «수집 실패(사유)» (0 으로 접히지 않는다)", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(confirmedHandler);
    const failingLog = {
      run(args) {
        if (args[0] === "log") {
          return { code: 128, stdout: "", stderr: "fatal: bad revision" };
        }
        return report.createProcessGitPort(repo.dir).run(args);
      },
    };
    const result = await runOnce(repo, fetchJson, {
      extra: { git: failingLog },
    });
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
    assert.match(
      candidateLine(result.reportText),
      /^- 외부 독립 증거 후보: 수집 실패\(.*fatal: bad revision.*\)$/,
    );
  } finally {
    cleanup(repo);
  }
});

// ---- 후보 조건 반례 (한용 확정 1540 항목 4) -----------------------------------

test("반례 ⓗ 로컬 봇 병합 커밋(«Merge remote-tracking branch origin/master» · 사람 아닌 committer) = 후보 0 · REST 0 · 분자 «확인 0건»", async () => {
  const repo = buildRepo([
    ubSpec(30, {
      message: "Merge remote-tracking branch 'origin/master' into feat/x",
      committer: LOCAL_BOT_COMMITTER,
    }),
  ]);
  try {
    const { fetchJson, calls } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    assert.equal(result.externalEvidence.candidatesInWindow, 0);
    assert.equal(calls.length, 0);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
  } finally {
    cleanup(repo);
  }
});

test("반례 ⓗ 사람 committer 일반 병합 · GitHub committer 인데 제목이 «Merge branch» 가 아닌 병합 = 후보 0", async () => {
  const repo = buildRepo([
    ubSpec(40, { committer: HUMAN_COMMITTER }),
    ubSpec(30, { message: "Merge remote-tracking branch 'origin/master'" }),
  ]);
  try {
    const { fetchJson, calls } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    assert.equal(result.externalEvidence.candidatesInWindow, 0);
    assert.equal(calls.length, 0);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
  } finally {
    cleanup(repo);
  }
});

test("반례 ⓗ 한 저장소에 로컬 봇 병합 + Update branch 확인 1: 분자는 «확인 1건» -- 봇 커밋은 분자를 부풀리지 않는다", async () => {
  const repo = buildRepo([
    ubSpec(60, {
      message: "Merge remote-tracking branch 'origin/master' into feat/x",
      committer: LOCAL_BOT_COMMITTER,
    }),
    ubSpec(30),
  ]);
  try {
    const { fetchJson, calls } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    assert.equal(calls.length, 1);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 1건`,
    );
  } finally {
    cleanup(repo);
  }
});

// ---- 문면 사실성: 진단 줄 «독립ㄴ수집기» ------------------------------------

test("진단 줄: 수집기가 돈 회차의 «독립ㄴ수집기» 는 더는 «FAIL(부재 -- 이 라운드 결선 없음 · 원리적으로 불가)» 가 아니다", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    const health = result.reportText.slice(
      result.reportText.indexOf("관측 건강:"),
    );
    assert.ok(!health.includes("독립ㄴ수집기 FAIL(부재"), health);
    assert.ok(!health.includes("원리적으로 불가"), health);
    assert.match(health, /독립ㄴ수집기 OK\(/);
    // 그 밖 ㄴ 유형은 여전히 결선이 없다는 사실도 그 줄에 남는다.
    assert.match(health, /독립ㄴ수집기 OK\([^\n]*결선 없음/);
  } finally {
    cleanup(repo);
  }
});

test("진단 줄: 수집 실패 회차의 «독립ㄴ수집기» 는 FAIL(수집 실패: 사유) 이다", async () => {
  const repo = buildRepo([ubSpec(30)]);
  try {
    const { fetchJson } = makeFetch(confirmedHandler);
    const failingLog = {
      run(args) {
        if (args[0] === "log") {
          return { code: 128, stdout: "", stderr: "fatal: bad revision" };
        }
        return report.createProcessGitPort(repo.dir).run(args);
      },
    };
    const result = await runOnce(repo, fetchJson, {
      extra: { git: failingLog },
    });
    const health = result.reportText.slice(
      result.reportText.indexOf("관측 건강:"),
    );
    assert.match(
      health,
      /독립ㄴ수집기 FAIL\(수집 실패[^\n]*fatal: bad revision/,
    );
  } finally {
    cleanup(repo);
  }
});

// ---- 통지 장 수 무변 (reach-report) -------------------------------------------

test("통지: 분자가 올라가도(확인 0 -> 1) 받는함 통지 조건 · 장 수는 그대로 -- 1장, 같은 값 반복은 0장", async () => {
  const { runReachOnce } = await import("./reach-report.mjs");
  const repo = buildRepo([ubSpec(30)]);
  const root = tmpDir("nc-ln-ub-reach-");
  try {
    const { fetchJson } = makeFetch(confirmedHandler);
    const result = await runOnce(repo, fetchJson);
    const watchLogPath = join(root, "watch.log");
    const t0 = Date.parse("2026-11-13T00:00:00.000Z");
    fs.writeFileSync(
      watchLogPath,
      `${new Date(t0).toISOString()} exit=0 verdict=PROGRESSING reason=OK ` +
        `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
        `idle_status=SEAT_IDLE_NOT_APPLICABLE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=1 ` +
        `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
        `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`,
      "utf8",
    );
    const partialCountPath = join(root, "partial-count-report.md");
    const notifyDir = join(root, "받는함");
    const run = (offset, text) => {
      fs.writeFileSync(partialCountPath, text, "utf8");
      runReachOnce({
        watchLogPath,
        partialCountPath,
        reportOutPath: join(root, "morning-report.md"),
        statePath: join(root, "state.json"),
        notifyDir,
        now: t0 + 3_600_000 + offset,
      });
    };
    const count = () =>
      fs.existsSync(notifyDir) ? fs.readdirSync(notifyDir).length : 0;
    // 실제 프로덕션 보고서 텍스트(확인 1)를 reach 가 그대로 읽는다.
    const zeroText = result.reportText
      .replace(`확인 1 · 미조회 0`, `확인 0 · 미조회 0`)
      .replace(`${NUMERATOR_PREFIX}확인 1건`, `${NUMERATOR_PREFIX}확인 0건`);
    run(0, zeroText);
    assert.equal(count(), 0, "기준선 N=0 은 통지 0장");
    run(1000, result.reportText);
    assert.equal(count(), 1, "확인 0 -> 1 은 통지 1장");
    const body = fs.readFileSync(
      join(notifyDir, fs.readdirSync(notifyDir)[0]),
      "utf8",
    );
    assert.ok(!body.includes("분류 대기"), body);
    assert.ok(body.includes("ㄴ 분자"), body);
    run(2000, result.reportText);
    assert.equal(count(), 1, "같은 값 반복은 통지 0장");
  } finally {
    cleanup(repo);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("파서 호환: 새 문면과 옛 문면(«분류 대기» -- 옛 버전이 쓴 보고서 파일)을 둘 다 같은 {확인, 미조회} 로 읽는다", () => {
  const read = (suffix) =>
    parseExternalEvidenceCandidateLine(
      `${LN_LINE_PREFIX}확인 3 · 미조회 2 · ${suffix}\n`,
    );
  assert.deepEqual(read("ㄴ 분자 반영"), {
    state: "count",
    confirmed: 3,
    unchecked: 2,
  });
  assert.deepEqual(read("분류 대기"), {
    state: "count",
    confirmed: 3,
    unchecked: 2,
  });
  assert.deepEqual(read("모르는 꼬리"), { state: "absent" });
});

// ---- core: 분자 입력과 외부 증거 줄은 별개 입력이다 ---------------------------

function coreInput(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test("core: confirmedLnEvents 길이가 분자 -- 1건이면 «확인 1건», 줄 문면에 «분류 대기» 0", () => {
  const text = buildPartialCountReport(
    coreInput({
      confirmedLnEvents: [{ source: "update-branch", ref: "a".repeat(40) }],
      externalEvidence: { known: true, confirmed: 1, unchecked: 0 },
    }),
  );
  assert.ok(text.includes(`${NUMERATOR_PREFIX}확인 1건\n`));
  assert.ok(!text.includes("분류 대기"));
});
