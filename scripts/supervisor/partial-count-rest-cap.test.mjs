// HYK-255-ln-update-branch-1 (coder-task.md §2 ⓒ · 커밋 3 · 책임자 판정 1804 + 교정 1904)
//   ⓐ 예약 감시(watch-run.mjs)는 기본값으로 부른다(상한 인자 없음) -- 그래서 «회차당 최악 호출 수»
//     는 두 기본 상수가 정한다: DEFAULT_MAX_MERGE_CHECKS 3 -> 1 (ㄱ-4 · sha당 callBudget 8 =
//     회차당 최대 8) · DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS 10 -> 4 (D1 · 후보당 1회 = 회차당
//     최대 4). 회차당 최악 8 + 4 = 12 · 15분 회차 4개 = 시간당 최악 48 (목표 <= 48).
//   ⓑ 상한 밖 D1 후보는 «미조회(예산)» 그대로(숨김 0). 미조회가 1 이상인 회차에는 ㄴ 분자 옆에
//     하한 표기(«확인 N건 이상 · 미조회 K») -- 분자가 하한임이 그 줄에서 읽힌다. 미조회 0 이면 표기 0.
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce · buildPartialCountReport)을 «기본 옵션 ·
// 상한 인자 없이» 직접 구동한다. 저장소는 mkdtemp 합성 git(실제 git), fetchJson 은 호출 수를 세는
// 주입 가짜 -- 실제 네트워크 · gh · 토큰 · 관제실 · 받는함 접촉 0.
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
const NUMERATOR_PREFIX = "- 외부 독립 증거로 확인된 사건: ";
const LN_LINE_PREFIX = "- 외부 독립 증거 후보: ";
const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
const PULL_HEAD_SHA = "e".repeat(40);
// sha당 callBudget(approval-authority-adapter DEFAULT_CALL_BUDGET) -- 이 라운드는 무변(8).
const CALL_BUDGET_PER_SHA = 8;
const ROUNDS_PER_HOUR = 4; // 15분 회차

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

// 합성 저장소: PR 브랜치마다 Update branch 병합 커밋 ubCounts[i] 개를 얹고, 각 PR 을
// GitHub «Merge pull request #n» 으로 origin/master 첫 부모 줄에 합친다.
//   ㄱ-4 후보 = 그 «Merge pull request» 커밋들(first-parent · 창 안) -- PR 수만큼.
//   D1 후보   = Update branch 병합 커밋들(committer GitHub · 부모 2 · «Merge branch») -- 합계만큼.
function buildRepo(ubCounts) {
  const dir = tmpDir("nc-rest-cap-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, ALLOWLIST_PATH), ALLOWLIST_JSON, "utf8");
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
  const ubShas = [];
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
      const sha = commitTree(dir, {
        parents: [prev, root],
        message: "Merge branch 'master' into feat/x",
        committer: GITHUB_COMMITTER,
        atMs: NOW - (200 - ubSeq) * 60 * 1000,
      });
      ubShas.push(sha);
      prev = sha;
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
  return { dir, mergeShas, ubShas, headSha: main };
}

const cleanup = (repo) => fs.rmSync(repo.dir, { recursive: true, force: true });

// 호출 수를 세는 가짜 fetchJson -- 모든 응답이 «체인을 끝까지 끄는» 모양이다:
//   ㄱ-4 후보(병합 커밋) = repo · 보호 브랜치 · pulls · pull 상세 · reviews 가 전부 승인 모양.
//   D1 후보(Update branch) = 서명·작성자 확인 모양 응답.
function makeCountingFetch(repo) {
  const calls = { gate4: [], d1: [] };
  const mergeNumber = new Map(repo.mergeShas.map((s, i) => [s, i + 1]));
  const respond = (json) => ({ ok: true, status: 200, json, linkHeader: null });
  const fetchJson = async ({ url }) => {
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    const d1 = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (d1) {
      calls.d1.push(url);
      return respond({
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
    if (path === "") return respond({ default_branch: "master" });
    if (path === "/branches/master") {
      return respond({ protected: true, commit: { sha: repo.headSha } });
    }
    const pulls = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (pulls) {
      const n = mergeNumber.get(pulls[1]);
      return respond(n ? [{ merge_commit_sha: pulls[1], number: n }] : []);
    }
    if (/^\/pulls\/\d+$/.test(path)) {
      return respond({
        merged: true,
        base: { ref: "master" },
        head: { sha: PULL_HEAD_SHA },
        user: { login: "harness-bot", id: 999 },
      });
    }
    if (/^\/pulls\/\d+\/reviews\?per_page=100$/.test(path)) {
      return respond([
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

// 프로덕션 진입점 1회 -- ⛔기본 옵션: maxMergeChecks · maxExternalEvidenceChecks 인자를 주지 않는다
// (예약 감시 watch-run.mjs 가 부르는 모양 그대로).
async function runDefault(repo, fetchJson) {
  const root = tmpDir("nc-rest-cap-run-");
  try {
    return await report.runPartialCountOnce({
      now: NOW,
      repoRoot: repo.dir,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      fetchJson,
      git: report.createProcessGitPort(repo.dir),
      gitWorktreeListExecFn: () => "",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const numeratorLine = (text) =>
  text.split("\n").find((l) => l.startsWith(NUMERATOR_PREFIX));

// ---- ⓐ 호출 상한 ---------------------------------------------------------------

test("ⓐ 기본 상수: ㄱ-4 = 1 (sha당 최대 8회 = 회차당 최대 8) · D1 = 4 (후보당 1회 = 회차당 최대 4) · 회차당 최악 12 · 시간당 = 회차 × 4 = 48 ≤ 48", () => {
  assert.equal(report.DEFAULT_MAX_MERGE_CHECKS, 1);
  assert.equal(report.DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS, 4);
  const perRoundWorst =
    report.DEFAULT_MAX_MERGE_CHECKS * CALL_BUDGET_PER_SHA +
    report.DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS * 1;
  assert.equal(perRoundWorst, 12);
  assert.equal(perRoundWorst * ROUNDS_PER_HOUR, 48);
  assert.ok(
    perRoundWorst * ROUNDS_PER_HOUR <= 48,
    "시간당 = 회차 × 4 = 48 ≤ 48",
  );
});

test("ⓐ 프로덕션 진입점 1회(기본 옵션 · 상한 인자 없이) · ㄱ-4 후보 3 · D1 후보 5 · 모든 응답이 체인을 끝까지 끈다 -> 회차 총 호출 ≤ 12 (ㄱ-4 ≤ 8 · D1 ≤ 4 · 시간당 = 회차 × 4 = 48 ≤ 48)", async () => {
  const repo = buildRepo([2, 2, 1]);
  try {
    const { fetchJson, calls } = makeCountingFetch(repo);
    const result = await runDefault(repo, fetchJson);
    assert.equal(result.gate4.candidatesInWindow, 3, "ㄱ-4 후보 ≥ 3");
    assert.equal(result.externalEvidence.candidatesInWindow, 5, "D1 후보 ≥ 5");
    assert.ok(calls.gate4.length <= 8, `ㄱ-4 호출 ${calls.gate4.length} > 8`);
    assert.ok(calls.d1.length <= 4, `D1 호출 ${calls.d1.length} > 4`);
    const total = calls.gate4.length + calls.d1.length;
    assert.ok(total <= 12, `회차 총 호출 ${total} > 12`);
    assert.ok(
      total * ROUNDS_PER_HOUR <= 48,
      `시간당 ${total * ROUNDS_PER_HOUR} > 48`,
    );
    // 체인이 실제로 끝까지 돌았다(공허 시험 방지): ㄱ-4 는 최신 1건을 끝까지 조회했다.
    assert.equal(result.gate4.checked, 1);
    assert.equal(result.gate4.approved, 1);
    assert.equal(calls.d1.length, 4, "D1 은 상한 4 까지 조회했다");
  } finally {
    cleanup(repo);
  }
});

test("ⓐ 상한 밖 후보는 «미조회(예산)» 으로 남는다(숨김 0): ㄱ-4 후보 3 중 1 조회 · 2 미조회(예산) · D1 후보 5 중 4 조회 · 1 미조회(예산)", async () => {
  const repo = buildRepo([2, 2, 1]);
  try {
    const { fetchJson } = makeCountingFetch(repo);
    const result = await runDefault(repo, fetchJson);
    assert.equal(result.gate4.uncheckedByBudget, 2);
    assert.equal(result.externalEvidence.uncheckedByBudget, 1);
    assert.equal(result.externalEvidence.unchecked, 1);
    assert.ok(
      result.reportText.includes("미조회(예산) 2건 — 미조회는 미계수다"),
      "ㄱ-4 미조회(예산) 줄",
    );
    const health = result.reportText.slice(
      result.reportText.indexOf("관측 건강:"),
    );
    assert.match(
      health,
      /미조회: 예산\(rate limit 포함\) 1\(그중 rate limit 0\)/,
    );
  } finally {
    cleanup(repo);
  }
});

// ---- ⓑ 하한 표기 ---------------------------------------------------------------

test("ⓑ D1 후보 5 · 상한 4 · 전부 확인 응답 -> 확인 4 + 미조회 1 + ㄴ 분자 옆 하한 표기(«확인 4건 이상 · 미조회 1»)", async () => {
  const repo = buildRepo([2, 2, 1]);
  try {
    const { fetchJson } = makeCountingFetch(repo);
    const result = await runDefault(repo, fetchJson);
    assert.equal(result.externalEvidence.confirmed, 4);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 4건 이상 · 미조회 1`,
    );
    assert.ok(
      result.reportText.includes(
        `${LN_LINE_PREFIX}확인 4 · 미조회 1 · ㄴ 분자 반영\n`,
      ),
    );
  } finally {
    cleanup(repo);
  }
});

test("ⓑ 미조회 0 인 회차(D1 후보 4 = 상한 4)는 하한 표기 0 -- «확인 4건» 그대로", async () => {
  const repo = buildRepo([2, 2]);
  try {
    const { fetchJson } = makeCountingFetch(repo);
    const result = await runDefault(repo, fetchJson);
    assert.equal(result.externalEvidence.confirmed, 4);
    assert.equal(result.externalEvidence.unchecked, 0);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 4건`,
    );
    assert.ok(!result.reportText.includes("이상"), "하한 표기 0");
  } finally {
    cleanup(repo);
  }
});

test("ⓑ 후보 0 인 회차 · 수집 실패 회차는 하한 표기 0 (분자 «확인 0건»)", async () => {
  const repo = buildRepo([0]);
  try {
    const { fetchJson } = makeCountingFetch(repo);
    const result = await runDefault(repo, fetchJson);
    assert.equal(
      numeratorLine(result.reportText),
      `${NUMERATOR_PREFIX}확인 0건`,
    );
  } finally {
    cleanup(repo);
  }
  const text = buildPartialCountReport(
    coreInput({
      externalEvidence: { known: false, reason: "허용 목록 읽기 실패" },
    }),
  );
  assert.equal(numeratorLine(text), `${NUMERATOR_PREFIX}확인 0건`);
});

// ---- core 렌더: 분자 옆 하한 표기 ------------------------------------------------

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

const events = (n) =>
  Array.from({ length: n }, (_, i) => ({
    source: "update-branch",
    ref: `s${i}`,
  }));

test("ⓑ core: 미조회 K ≥ 1 이면 분자 옆 «확인 N건 이상 · 미조회 K» (N = 0 도 «확인 0건 이상» -- bare 0 아님)", () => {
  const withUnchecked = (n, k) =>
    numeratorLine(
      buildPartialCountReport(
        coreInput({
          confirmedLnEvents: events(n),
          externalEvidence: { known: true, confirmed: n, unchecked: k },
        }),
      ),
    );
  assert.equal(
    withUnchecked(4, 1),
    `${NUMERATOR_PREFIX}확인 4건 이상 · 미조회 1`,
  );
  assert.equal(
    withUnchecked(0, 3),
    `${NUMERATOR_PREFIX}확인 0건 이상 · 미조회 3`,
  );
  assert.equal(withUnchecked(2, 0), `${NUMERATOR_PREFIX}확인 2건`);
});

test("ⓑ core: 외부 증거 입력이 없으면(미결선 호출자) 하한 표기 0 · 옛 모양 그대로", () => {
  const text = buildPartialCountReport(
    coreInput({ confirmedLnEvents: events(1) }),
  );
  assert.equal(numeratorLine(text), `${NUMERATOR_PREFIX}확인 1건`);
});

test("ⓑ core: 후보 줄(확인 N · 미조회 U)의 파서는 하한 표기 줄에 영향을 받지 않는다 -- 줄이 따로 있다", () => {
  const text = buildPartialCountReport(
    coreInput({
      confirmedLnEvents: events(4),
      externalEvidence: { known: true, confirmed: 4, unchecked: 1 },
    }),
  );
  assert.deepEqual(parseExternalEvidenceCandidateLine(text), {
    state: "count",
    confirmed: 4,
    unchecked: 1,
  });
});
