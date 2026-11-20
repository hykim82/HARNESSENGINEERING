// HYK-255-c1-approval-cache-1 (판정 #20261119-1406 ① · 1412 ① · C1) -- ㄱ-4 병합 후보 승인 조회 «판정 캐시».
//
// 계약: 창 안 후보 sha 별 마지막 판정(APPROVED · NOT_APPROVED · UNDECIDABLE · 조회 시각)을 watch 상태 파일 1개에 남기고,
// 회차 조회 몫(maxMergeChecks)은 «캐시에 없는 sha» -> «UNDECIDABLE 이었던 sha» -> «가장 오래 전에 본 sha(NOT_APPROVED 재확인
// 시한 지남)» 순으로 쓴다. APPROVED 는 다시 부르지 않고 재사용 · 캐시 깨짐/없음 = 지금과 같은 동작(앞자리 조회 · 미조회 그대로 ·
// ⛔0 으로 접지 않음) + 사유 1줄 · 보고 줄은 «캐시 포함 확인 N · 이번 회차 조회 M · 미조회(예산) K건» 으로 캐시 재사용과
// 이번 회차 조회를 구별한다. 회차 예산(maxMergeChecks) · sha당 callBudget · GitHub 사람 손 목록 순번 · 다른 줄은 무변.
//
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce)을 «기본 몫(상한 인자 없이)» 으로 회차 여러 번 직접 구동한다. 저장소는 mkdtemp
// 합성 git(실제 git), fetchJson 은 호출을 기록하는 주입 가짜 -- 실제 네트워크 · gh · 토큰 · 관제실 · 받는함 접촉 0.
// 출력 «전체» 문자열 동등 단언 0 -- 자기 토막만.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as report from "./partial-count-report.mjs";
import * as core from "./partial-count-core.mjs";
import { runReachOnce } from "./reach-report.mjs";
import { DEFAULT_CALL_BUDGET } from "./approval-authority-adapter.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const STEP = 15 * MIN; // 감시 회차 간격
const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const REPO = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});
const BOTS_PATH = "scripts/supervisor/github-bot-accounts.json";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: "bot-fixture-a" }],
});
const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
const PULL_HEAD_SHA = "e".repeat(40);
const CACHE_NAME = "partial-count-approval-cache.json";
const GATE4_PREFIX = "- ㄱ-4 후보 병합";

const tmpDir = (prefix) => fs.mkdtempSync(join(tmpdir(), prefix));

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

// 합성 저장소: GitHub «Merge pull request #n» 병합 커밋 prCount 개를 origin/master first-parent 줄에 쌓는다
// (ㄱ-4 후보 = 이 병합 커밋들 · 창 안). mergeShas[i] 가 i+1 번째(오래된 쪽부터) -- git log 는 새 것부터라 후보 순서는 역순이다.
// 병합 시각 = NOW - (60 - i*10)분 -> i=0 이 60분 전 · i=4 가 20분 전.
function buildRepo(prCount) {
  const dir = tmpDir("nc-c1-cache-");
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
  let main = root;
  const mergeShas = [];
  for (let i = 0; i < prCount; i++) {
    const branch = commitTree(dir, {
      parents: [main],
      message: `feat: work on PR branch ${i + 1}`,
      committer: HUMAN_COMMITTER,
      atMs: NOW - 90 * 24 * HOUR + i * HOUR,
    });
    main = commitTree(dir, {
      parents: [main, branch],
      message: `Merge pull request #${i + 1} from hykim82/feat-${i + 1}`,
      committer: GITHUB_COMMITTER,
      atMs: NOW - (60 - i * 10) * MIN,
    });
    mergeShas.push(main);
  }
  git(dir, ["update-ref", "refs/remotes/origin/master", main]);
  return { dir, mergeShas, headSha: main };
}

// 호출을 기록하는 가짜 fetchJson. behavior[sha] = "approved"(기본) | "notapproved" | "http500".
// pullsFor = ㄱ-4 조회가 sha 별 «첫 호출»(/commits/<sha>/pulls)을 부른 순서 -- 조회 1건 = 이 배열에 1개.
// 2R: behavior[sha] = "openpr"(PR 상세가 merged:false = 열린 PR) 도 줄 수 있고, extraReviews[PR 번호] = 그 PR 리뷰 응답에 덧붙일 리뷰들
// (사람 CHANGES_REQUESTED 합성용 -- 승인자 hykim82 의 마지막 리뷰는 그대로라 판정은 변하지 않는다).
function makeFetch(repo) {
  const behavior = {};
  const extraReviews = {};
  const calls = { gate4: [], pullsFor: [], events: [], d1: [] };
  const mergeNumber = new Map(repo.mergeShas.map((s, i) => [s, i + 1]));
  const respond = (json) => ({ ok: true, status: 200, json, linkHeader: null });
  const fetchJson = async ({ url }) => {
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    if (
      /^\/(?:pulls\?state=closed|issues\/comments\?|pulls\/comments\?)/.test(
        path,
      )
    ) {
      calls.events.push(url);
      return respond([]);
    }
    const d1 = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (d1) {
      calls.d1.push(url);
      return { ok: false, status: 404, json: null, linkHeader: null };
    }
    calls.gate4.push(url);
    if (path === "") return respond({ default_branch: "master" });
    if (path === "/branches/master") {
      return respond({ protected: true, commit: { sha: repo.headSha } });
    }
    const pulls = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (pulls) {
      calls.pullsFor.push(pulls[1]);
      if (behavior[pulls[1]] === "http500") {
        return { ok: false, status: 500, json: null, linkHeader: null };
      }
      const n = mergeNumber.get(pulls[1]);
      return respond(n ? [{ merge_commit_sha: pulls[1], number: n }] : []);
    }
    if (/^\/pulls\/\d+$/.test(path)) {
      const num = Number(path.split("/").pop());
      return respond({
        number: num,
        merged: behavior[repo.mergeShas[num - 1]] !== "openpr",
        base: { ref: "master" },
        head: { sha: PULL_HEAD_SHA },
        user: { login: "harness-bot", id: 999 },
      });
    }
    const reviews = /^\/pulls\/(\d+)\/reviews\?per_page=100$/.exec(path);
    if (reviews) {
      const sha = repo.mergeShas[Number(reviews[1]) - 1];
      const extra = extraReviews[Number(reviews[1])] ?? [];
      if (behavior[sha] === "notapproved") return respond([...extra]);
      return respond([
        {
          id: 1,
          user: { login: "hykim82", id: 286230306 },
          state: "APPROVED",
          commit_id: PULL_HEAD_SHA,
          submitted_at: "2026-11-13T09:00:00Z",
        },
        ...extra,
      ]);
    }
    return { ok: false, status: 404, json: null, linkHeader: null };
  };
  return { fetchJson, calls, behavior, extraReviews };
}

// 프로덕션 진입점 1회 -- ⛔기본 몫: maxMergeChecks 인자를 주지 않는다(예약 감시 watch-run.mjs 가 부르는 모양 그대로).
// cache = {path} 명시(approvalCachePath) 또는 derive(watchLogPath 형제) 또는 none(둘 다 끔).
async function cycle(rig, i, extra = {}) {
  return report.runPartialCountOnce({
    now: NOW + i * STEP,
    repoRoot: rig.repo.dir,
    dispatchReceiptsPath: join(rig.root, "none.jsonl"),
    watchLogPath: join(rig.root, "watch.log"),
    approvalCachePath: join(rig.root, CACHE_NAME),
    extraRepoRoots: [],
    archiveRoot: join(rig.root, "archive-missing"),
    fetchJson: rig.fetch.fetchJson,
    git: report.createProcessGitPort(rig.repo.dir),
    gitWorktreeListExecFn: () => "",
    ...extra,
  });
}

function makeRig(prCount) {
  const repo = buildRepo(prCount);
  const root = tmpDir("nc-c1-cache-run-");
  return {
    repo,
    root,
    fetch: makeFetch(repo),
    cachePath: join(root, CACHE_NAME),
  };
}
const cleanup = (rig) => {
  fs.rmSync(rig.repo.dir, { recursive: true, force: true });
  fs.rmSync(rig.root, { recursive: true, force: true });
};
const gate4Line = (text) =>
  text.split("\n").find((l) => l.startsWith(GATE4_PREFIX)) ?? "";
const reverse = (a) => [...a].reverse();
// 회차 i 에서 새로 불린 sha 들(조회 1건 = pullsFor 1개).
function lookedUpSince(rig, mark) {
  return rig.fetch.calls.pullsFor.slice(mark);
}

// ---- ⓐ 몫 1 · 후보 5 · 5회차 안에 5개 모두 확인 -----------------------------------

test("ⓐ 후보 5 · 기본 몫 1 · 회차 5번 -> 매 회차 «다른» sha 를 조회해 5회차 안에 5개 모두 확인 · 6회차 조회 0 (APPROVED 재조회 0)", async () => {
  const rig = makeRig(5);
  try {
    const looked = [];
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const mark = rig.fetch.calls.pullsFor.length;
      const r = await cycle(rig, i);
      looked.push(lookedUpSince(rig, mark));
      rows.push({
        candidates: r.gate4.candidatesInWindow,
        checked: r.gate4.checked,
        approved: r.gate4.approved,
        unchecked: r.gate4.uncheckedByBudget,
      });
    }
    // 후보 순서 = git log 새 것부터. 캐시에 없는 sha 를 후보 순서대로 하나씩 -> 5회차에 전부.
    assert.deepEqual(
      looked.slice(0, 5),
      reverse(rig.repo.mergeShas).map((s) => [s]),
      "회차마다 다른 sha 한 개씩(앞자리 반복 아님)",
    );
    assert.deepEqual(
      looked[5],
      [],
      "6회차: 전부 APPROVED 라 조회 0 · APPROVED 재조회 0",
    );
    assert.deepEqual(
      rows.map((r) => r.unchecked),
      [4, 3, 2, 1, 0, 0],
      "미조회(예산)가 회차를 거듭하며 0 으로 수렴",
    );
    assert.deepEqual(
      rows.map((r) => r.approved),
      [1, 2, 3, 4, 5, 5],
      "캐시 포함 APPROVED 누적",
    );
    assert.deepEqual(
      rows.map((r) => r.checked),
      [1, 1, 1, 1, 1, 0],
      "checked = 이번 회차 조회(캐시 재사용 제외)",
    );
    assert.ok(rows.every((r) => r.candidates === 5));
  } finally {
    cleanup(rig);
  }
});

test("ⓐ 같은 앞자리만 조회되는 옛 동작이 아님: 5회차에 조회된 서로 다른 sha 개수 = 5 (옛 동작 = 1)", async () => {
  const rig = makeRig(5);
  try {
    for (let i = 0; i < 5; i++) await cycle(rig, i);
    assert.equal(new Set(rig.fetch.calls.pullsFor).size, 5);
    assert.equal(
      rig.fetch.calls.pullsFor.length,
      5,
      "APPROVED 재조회 0 -> 조회 5건 정확히",
    );
  } finally {
    cleanup(rig);
  }
});

// ---- ⓑ 보고 줄: 캐시 재사용 ≠ 이번 회차 조회 ------------------------------------------

test("ⓑ 보고 ㄱ-4 줄: «캐시 포함 확인 N · 이번 회차 조회 M · … 미조회(예산) K건» -- 캐시 재사용은 이번 회차 조회와 따로 적힌다", async () => {
  const rig = makeRig(5);
  try {
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push(gate4Line((await cycle(rig, i)).reportText));
    }
    // 회차 1: 캐시 0 · 조회 1 · 미조회 4.
    assert.match(lines[0], /5건 중 캐시 포함 확인 1 · 이번 회차 조회 1 · /);
    assert.match(lines[0], /미조회\(예산\) 4건 — 미조회는 미계수다/);
    // 회차 3: 확인 3 중 이번 회차 조회는 1 (나머지 2 는 캐시 재사용).
    assert.match(lines[2], /캐시 포함 확인 3 · 이번 회차 조회 1 · /);
    assert.match(lines[2], /미조회\(예산\) 2건 — 미조회는 미계수다/);
    // 회차 5: 확인 5 · 조회 1 · 미조회 0.
    assert.match(lines[4], /캐시 포함 확인 5 · 이번 회차 조회 1 · /);
    assert.match(lines[4], /미조회\(예산\) 0건 — 미조회는 미계수다/);
    // 회차 6: 확인 5 중 이번 회차 조회 0 -- 5건 전부 캐시.
    assert.match(lines[5], /캐시 포함 확인 5 · 이번 회차 조회 0 · /);
  } finally {
    cleanup(rig);
  }
});

test("ⓑ 캐시에서 온 값은 «이번 회차 확인» 처럼 적히지 않는다: gate4.cache 에 재사용 수가 따로 있고, 보고서에 «캐시 재사용» 줄 · 확인 사건 줄에 캐시 표지", async () => {
  const rig = makeRig(3);
  try {
    await cycle(rig, 0);
    const r2 = await cycle(rig, 1);
    assert.equal(r2.gate4.checked, 1, "이번 회차 조회는 1건");
    assert.equal(r2.gate4.approved, 2, "캐시 포함 APPROVED 2");
    assert.equal(r2.gate4.cache.lookedUp, 1);
    assert.equal(r2.gate4.cache.reused, 1);
    assert.equal(r2.gate4.cache.reusedApproved, 1);
    const text = r2.reportText;
    assert.match(
      text,
      /캐시 재사용: APPROVED 1 · NOT_APPROVED 0 · UNDECIDABLE 0/,
    );
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("  · 확인 사건:"));
    assert.equal(events.length, 2);
    assert.equal(
      events.filter((l) => l.includes("캐시 재사용")).length,
      1,
      "캐시에서 온 확인 사건 1건만 «캐시 재사용» 표지",
    );
    const fresh = events.find((l) => !l.includes("캐시 재사용"));
    assert.ok(
      fresh.includes(rig.repo.mergeShas[1].slice(0, 7)),
      "이번 회차 조회분 = 새로 본 sha",
    );
  } finally {
    cleanup(rig);
  }
});

// ---- ⓒ 예산 · callBudget · 사람 손 목록 순번 무변 -------------------------------------------

test("ⓒ 예산 무변: 회차당 ㄱ-4 조회 ≤ 몫(기본 1) · ㄱ-4 호출 ≤ sha당 callBudget · 회차 총 호출 ≤ 12 · 몫을 2 로 주면 회차당 조회 ≤ 2", async () => {
  const rig = makeRig(5);
  try {
    for (let i = 0; i < 6; i++) {
      const gate4Mark = rig.fetch.calls.gate4.length;
      const evMark = rig.fetch.calls.events.length;
      const pMark = rig.fetch.calls.pullsFor.length;
      const r = await cycle(rig, i);
      assert.ok(r.gate4.checked <= report.DEFAULT_MAX_MERGE_CHECKS);
      assert.ok(rig.fetch.calls.pullsFor.length - pMark <= 1);
      const g4 = rig.fetch.calls.gate4.length - gate4Mark;
      assert.ok(
        g4 <= DEFAULT_CALL_BUDGET * report.DEFAULT_MAX_MERGE_CHECKS,
        `ㄱ-4 호출 ${g4}`,
      );
      const total = g4 + (rig.fetch.calls.events.length - evMark);
      assert.ok(total <= report.PER_TICK_CALL_CEILING, `회차 총 ${total} > 12`);
    }
  } finally {
    cleanup(rig);
  }
  const rig2 = makeRig(5);
  try {
    for (let i = 0; i < 3; i++) {
      const mark = rig2.fetch.calls.pullsFor.length;
      const r = await cycle(rig2, i, { maxMergeChecks: 2 });
      assert.ok(rig2.fetch.calls.pullsFor.length - mark <= 2);
      assert.equal(r.gate4.checked, i < 2 ? 2 : 1, "5후보 · 몫 2 -> 2 · 2 · 1");
    }
  } finally {
    cleanup(rig2);
  }
});

test("ⓒ 몫 0 이면 캐시가 있어도 조회 0 -- 캐시 재사용 + 미조회(예산) 로 남는다(0 으로 접지 않음)", async () => {
  const rig = makeRig(3);
  try {
    await cycle(rig, 0);
    await cycle(rig, 1);
    const mark = rig.fetch.calls.pullsFor.length;
    const r = await cycle(rig, 2, { maxMergeChecks: 0 });
    assert.equal(rig.fetch.calls.pullsFor.length, mark, "몫 0 = 호출 0");
    assert.equal(r.gate4.checked, 0);
    assert.equal(r.gate4.approved, 2, "캐시 2건은 그대로 확인");
    assert.equal(r.gate4.uncheckedByBudget, 1, "나머지 1건은 미조회(예산)");
  } finally {
    cleanup(rig);
  }
});

test("ⓒ GitHub 사람 손 목록 순번 · 다른 줄 무변: 캐시 켠 5회차와 캐시 끈 5회차의 P3 목록 호출 순서가 회차마다 같고, ㄱ-4 줄 · 캐시 줄 밖 보고 줄이 회차 1 에서 같다", async () => {
  const on = makeRig(5);
  const off = makeRig(5);
  try {
    const onEvents = [];
    const offEvents = [];
    let onFirst;
    let offFirst;
    for (let i = 0; i < 5; i++) {
      const a = on.fetch.calls.events.length;
      const rOn = await cycle(on, i);
      onEvents.push(
        on.fetch.calls.events.slice(a).map((u) => u.replace(REPO, "R")),
      );
      const b = off.fetch.calls.events.length;
      const rOff = await cycle(off, i, {
        approvalCachePath: null,
        watchLogPath: join(off.root, "off.log"),
      });
      offEvents.push(
        off.fetch.calls.events.slice(b).map((u) => u.replace(REPO, "R")),
      );
      if (i === 0) {
        onFirst = rOn.reportText;
        offFirst = rOff.reportText;
      }
    }
    assert.deepEqual(onEvents, offEvents, "회차 시각 순번 · 호출 수 무변");
    const strip = (t) =>
      t
        .split("\n")
        .filter(
          (l) =>
            !l.includes("ㄱ-4") &&
            !l.includes("캐시") &&
            !l.startsWith("생성") &&
            // 2R: ㄱ 머리 줄(캐시 재사용 표지) · ㄴ «GitHub 사람 손» 줄(이월 표기)은 새 표기가 붙는 줄이라 여기서 빼고, 값은 아래 2R 칸이 회차마다 비교한다.
            !l.startsWith(ANCHOR_LINE) &&
            !l.startsWith(GH_LINE),
        )
        .join("\n")
        // 두 장비(rig)의 합성 임시 폴더 이름만 다르다 -- 그 이름은 값이 아니다.
        .replace(/nc-c1-cache-run-[A-Za-z0-9]+/g, "RUNDIR");
    assert.equal(
      strip(onFirst),
      strip(offFirst),
      "ㄱ-4 · 캐시 줄 밖은 한 글자도 안 바뀐다(회차 1)",
    );
  } finally {
    cleanup(on);
    cleanup(off);
  }
});

// ---- ⓓ 캐시 깨짐 · 없음 = 지금과 같은 동작 + 사유 1줄 -----------------------------------

const BROKEN_CACHES = [
  ["깨진 JSON", "{ not json"],
  ["스키마 불일치", JSON.stringify({ schema: "other/v9", entries: {} })],
  [
    "entries 가 배열",
    JSON.stringify({ schema: "partial-count-approval-cache/v1", entries: [] }),
  ],
  ["빈 파일", ""],
];

for (const [name, body] of BROKEN_CACHES) {
  test(`ⓓ 캐시 깨짐(${name}) -> 지금과 같은 동작(앞자리 1건 조회 · 미조회(예산) 4 그대로 · 0 으로 접지 않음) + 사유 1줄`, async () => {
    const rig = makeRig(5);
    try {
      fs.writeFileSync(rig.cachePath, body, "utf8");
      const r = await cycle(rig, 0);
      assert.deepEqual(
        rig.fetch.calls.pullsFor,
        [rig.repo.mergeShas[4]],
        "앞자리(가장 새 병합) 1건만 조회",
      );
      assert.equal(r.gate4.checked, 1);
      assert.equal(r.gate4.uncheckedByBudget, 4, "미조회를 0 으로 접지 않는다");
      assert.equal(r.gate4.candidatesInWindow, 5);
      const reasonLines = r.reportText
        .split("\n")
        .filter((l) => l.startsWith("  · 캐시 상태:"));
      assert.equal(reasonLines.length, 1, "사유 줄 정확히 1줄");
      assert.match(reasonLines[0], /캐시 깨짐/);
      assert.match(r.reportText, /미조회\(예산\) 4건 — 미조회는 미계수다/);
    } finally {
      cleanup(rig);
    }
  });
}

test("ⓓ 캐시 파일 없음(첫 회차) -> 앞자리 조회 + 사유 1줄(«캐시 없음») · 같은 회차에 캐시 파일이 새로 써진다", async () => {
  const rig = makeRig(3);
  try {
    assert.equal(fs.existsSync(rig.cachePath), false);
    const r = await cycle(rig, 0);
    const reasonLines = r.reportText
      .split("\n")
      .filter((l) => l.startsWith("  · 캐시 상태:"));
    assert.equal(reasonLines.length, 1);
    assert.match(reasonLines[0], /캐시 없음/);
    assert.equal(fs.existsSync(rig.cachePath), true, "회차 끝에 캐시 저장");
    const r2 = await cycle(rig, 1);
    assert.equal(
      r2.reportText.split("\n").filter((l) => l.startsWith("  · 캐시 상태:"))
        .length,
      0,
      "정상 캐시 회차에는 사유 줄 0",
    );
  } finally {
    cleanup(rig);
  }
});

test("ⓓ 창 안 후보 0 이면 «캐시 없음» 사유 줄도 빈 캐시 파일도 만들지 않는다(물러날 동작이 없다) -- 깨진 캐시는 후보 0 이어도 사유 줄 + 다시 쓴다", async () => {
  const rig = makeRig(2);
  try {
    const r = await cycle(rig, 0, { windowHours: 0.01 }); // 36초 창 = 병합 20분 전보다 좁다
    assert.equal(r.gate4.candidatesInWindow, 0);
    assert.equal(r.gate4.uncheckedByBudget, 0);
    assert.equal(r.reportText.includes("캐시 상태:"), false);
    assert.equal(fs.existsSync(rig.cachePath), false);
    fs.writeFileSync(rig.cachePath, "{ broken", "utf8");
    const r2 = await cycle(rig, 0, { windowHours: 0.01 });
    assert.match(r2.reportText, /캐시 깨짐/);
    assert.equal(
      JSON.parse(fs.readFileSync(rig.cachePath, "utf8")).schema,
      "partial-count-approval-cache/v1",
    );
  } finally {
    cleanup(rig);
  }
});

test("ⓓ 깨진 캐시는 그 회차 조회 결과로 다시 써져 다음 회차부터 정상 -- 깨짐이 영구 고착되지 않는다", async () => {
  const rig = makeRig(3);
  try {
    fs.writeFileSync(rig.cachePath, "{ broken", "utf8");
    await cycle(rig, 0);
    const parsed = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    assert.equal(parsed.schema, "partial-count-approval-cache/v1");
    assert.deepEqual(Object.keys(parsed.entries), [rig.repo.mergeShas[2]]);
    const mark = rig.fetch.calls.pullsFor.length;
    await cycle(rig, 1);
    assert.deepEqual(
      lookedUpSince(rig, mark),
      [rig.repo.mergeShas[1]],
      "다음 회차 = 다음 미조회 sha",
    );
  } finally {
    cleanup(rig);
  }
});

test("ⓓ 항목 하나가 무효(status 오타)면 그 sha 만 «캐시에 없음» 으로 다시 조회 + 사유 줄에 무효 개수 -- 나머지 항목은 재사용", async () => {
  const rig = makeRig(3);
  try {
    await cycle(rig, 0);
    await cycle(rig, 1);
    const parsed = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    const [s2, s1] = [rig.repo.mergeShas[2], rig.repo.mergeShas[1]];
    parsed.entries[s2].status = "MAYBE";
    fs.writeFileSync(rig.cachePath, JSON.stringify(parsed), "utf8");
    const mark = rig.fetch.calls.pullsFor.length;
    const r = await cycle(rig, 2);
    assert.ok(parsed.entries[s1]);
    assert.deepEqual(
      lookedUpSince(rig, mark),
      [s2],
      "무효 항목 sha 가 캐시에 없는 sha 로 먼저 조회됨(몫 1)",
    );
    assert.match(r.reportText, /무효 항목 1개 무시/);
  } finally {
    cleanup(rig);
  }
});

test("ⓓ 캐시 읽기 «실패»(권한 등 · 없음/깨짐 아님) -> 지금과 같은 동작(앞자리 조회 · 미조회 그대로) + 사유 줄 + 기존 캐시 파일은 덮어쓰지 않는다", async () => {
  const rig = makeRig(3);
  try {
    await cycle(rig, 0);
    const before = fs.readFileSync(rig.cachePath, "utf8");
    const mark = rig.fetch.calls.pullsFor.length;
    const r = await cycle(rig, 1, {
      readFn: (p, enc) => {
        if (String(p).endsWith(CACHE_NAME)) {
          const err = new Error("EACCES: permission denied");
          err.code = "EACCES";
          throw err;
        }
        return fs.readFileSync(p, enc);
      },
    });
    assert.deepEqual(
      lookedUpSince(rig, mark),
      [rig.repo.mergeShas[2]],
      "읽지 못했으니 앞자리(가장 새 병합)를 다시 조회",
    );
    assert.equal(r.gate4.uncheckedByBudget, 2, "미조회를 0 으로 접지 않는다");
    assert.match(r.reportText, /캐시 읽기 실패\(EACCES/);
    assert.equal(
      fs.readFileSync(rig.cachePath, "utf8"),
      before,
      "읽기 실패 회차는 기존 캐시 바이트를 덮어쓰지 않는다",
    );
  } finally {
    cleanup(rig);
  }
});

test("ⓓ 캐시 저장 실패(경로가 파일 밑) -> 던지지 않고 그 회차 값은 정상 · 사유 줄 «캐시 저장 실패»", async () => {
  const rig = makeRig(3);
  try {
    const blocker = join(rig.root, "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    const r = await cycle(rig, 0, {
      approvalCachePath: join(blocker, "sub", CACHE_NAME),
    });
    assert.equal(r.gate4.known, true);
    assert.equal(r.gate4.checked, 1);
    assert.equal(r.gate4.uncheckedByBudget, 2);
    assert.match(r.reportText, /캐시 저장 실패/);
  } finally {
    cleanup(rig);
  }
});

// ---- ⓔ 창 밖 sha 정리 -------------------------------------------------------------------

test("ⓔ 창 밖 sha 는 캐시에서 지워진다 -- 창을 좁히면(후보 5 -> 2) 캐시 항목도 그 2 개만 남는다", async () => {
  const rig = makeRig(5);
  try {
    for (let i = 0; i < 5; i++) await cycle(rig, i);
    let parsed = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    assert.equal(Object.keys(parsed.entries).length, 5);
    // 창 0.5h = 30분: 병합 시각 NOW-60..-20분 중 i=3(-30분) · i=4(-20분) 만 창 안(now = NOW + 4*15분 이므로 아래서 맞춘다).
    const nowIdx = 0; // now = NOW 로 창을 잡는다
    const r = await cycle(rig, nowIdx, { windowHours: 0.5 });
    assert.equal(r.gate4.candidatesInWindow, 2);
    parsed = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    assert.deepEqual(
      Object.keys(parsed.entries).sort(),
      [rig.repo.mergeShas[3], rig.repo.mergeShas[4]].sort(),
      "창 안 2 개만 남음",
    );
    assert.equal(r.gate4.approved, 2, "그 2 개는 캐시로 확인");
    assert.equal(r.gate4.checked, 0);
  } finally {
    cleanup(rig);
  }
});

test("ⓔ 후보 수집 실패(origin/master 없음) 회차는 캐시를 건드리지 않는다(지워 버리지 않음)", async () => {
  const rig = makeRig(3);
  try {
    for (let i = 0; i < 3; i++) await cycle(rig, i);
    const before = fs.readFileSync(rig.cachePath, "utf8");
    git(rig.repo.dir, ["update-ref", "-d", "refs/remotes/origin/master"]);
    const r = await cycle(rig, 3);
    assert.equal(r.gate4.known, false);
    assert.equal(
      fs.readFileSync(rig.cachePath, "utf8"),
      before,
      "캐시 바이트 무변",
    );
  } finally {
    cleanup(rig);
  }
});

// ---- ⓕ 순서: 캐시에 없는 sha -> UNDECIDABLE -> 가장 오래 전에 본 sha(NOT_APPROVED 시한 후) -----------

test("ⓕ UNDECIDABLE 이었던 sha 는 «캐시에 없는 sha» 뒤에 다시 조회되고, 풀리면 APPROVED 로 굳어 더 이상 안 부른다", async () => {
  const rig = makeRig(2);
  try {
    const [older, newer] = rig.repo.mergeShas;
    rig.fetch.behavior[newer] = "http500";
    const mark0 = rig.fetch.calls.pullsFor.length;
    const r1 = await cycle(rig, 0);
    assert.deepEqual(
      lookedUpSince(rig, mark0),
      [newer],
      "회차 1: 앞자리(newer) -> UNDECIDABLE",
    );
    assert.equal(r1.gate4.undecidable, 1);
    const mark1 = rig.fetch.calls.pullsFor.length;
    const r2 = await cycle(rig, 1);
    assert.deepEqual(
      lookedUpSince(rig, mark1),
      [older],
      "회차 2: UNDECIDABLE newer 보다 «캐시에 없는» older 가 먼저",
    );
    assert.equal(r2.gate4.approved, 1);
    assert.equal(
      r2.gate4.undecidable,
      1,
      "캐시 UNDECIDABLE 도 그대로 보인다(0 으로 접지 않음)",
    );
    const mark2 = rig.fetch.calls.pullsFor.length;
    rig.fetch.behavior[newer] = "approved";
    const r3 = await cycle(rig, 2);
    assert.deepEqual(
      lookedUpSince(rig, mark2),
      [newer],
      "회차 3: 남은 건 UNDECIDABLE 재조회",
    );
    assert.equal(r3.gate4.approved, 2);
    const mark3 = rig.fetch.calls.pullsFor.length;
    await cycle(rig, 3);
    assert.equal(
      rig.fetch.calls.pullsFor.length,
      mark3,
      "회차 4: 둘 다 APPROVED -> 조회 0",
    );
  } finally {
    cleanup(rig);
  }
});

test("ⓕ UNDECIDABLE 여럿이면 «가장 오래 전에 본» 것부터 돌려 가며 다시 본다(앞자리 고착 0)", async () => {
  const rig = makeRig(3);
  try {
    for (const s of rig.repo.mergeShas) rig.fetch.behavior[s] = "http500";
    const order = [];
    for (let i = 0; i < 6; i++) {
      const mark = rig.fetch.calls.pullsFor.length;
      await cycle(rig, i);
      order.push(...lookedUpSince(rig, mark));
    }
    const [a, b, c] = reverse(rig.repo.mergeShas); // 후보 순서(새 것부터)
    assert.deepEqual(
      order,
      [a, b, c, a, b, c],
      "후보 순 3 회 후 가장 오래 전에 본 것부터 순환",
    );
  } finally {
    cleanup(rig);
  }
});

test("ⓕ NOT_APPROVED 는 재확인 시한 전엔 재사용 · 시한이 지나면 다시 조회(미조회 sha · UNDECIDABLE 이 없을 때)", async () => {
  const rig = makeRig(1);
  try {
    const sha = rig.repo.mergeShas[0];
    rig.fetch.behavior[sha] = "notapproved";
    const r1 = await cycle(rig, 0);
    assert.equal(r1.gate4.notApproved, 1);
    assert.equal(rig.fetch.calls.pullsFor.length, 1);
    const ttl = report.NOT_APPROVED_RECHECK_MS;
    assert.ok(
      Number.isFinite(ttl) && ttl >= STEP,
      "재확인 시한은 회차 간격 이상",
    );
    await cycle(rig, 0, { now: NOW + ttl - 1, windowHours: 48 });
    assert.equal(
      rig.fetch.calls.pullsFor.length,
      1,
      "시한 -1ms 전: 재사용 · 조회 0",
    );
    const r3 = await cycle(rig, 0, { now: NOW + ttl, windowHours: 48 });
    assert.equal(rig.fetch.calls.pullsFor.length, 2, "시한 도달: 다시 조회");
    assert.equal(r3.gate4.checked, 1);
    assert.equal(r3.gate4.notApproved, 1);
  } finally {
    cleanup(rig);
  }
});

test("ⓕ NOT_APPROVED 시한 지난 sha 보다 «캐시에 없는» sha 가 먼저 -- 새 병합이 낡은 NOT_APPROVED 재조회에 밀리지 않는다", async () => {
  const rig = makeRig(2);
  try {
    const [older, newer] = rig.repo.mergeShas;
    rig.fetch.behavior[newer] = "notapproved";
    await cycle(rig, 0); // newer 조회 -> NOT_APPROVED
    const ttl = report.NOT_APPROVED_RECHECK_MS;
    const mark = rig.fetch.calls.pullsFor.length;
    await cycle(rig, 0, { now: NOW + ttl, windowHours: 48 });
    assert.deepEqual(
      lookedUpSince(rig, mark),
      [older],
      "캐시에 없는 older 가 시한 지난 newer 보다 먼저",
    );
  } finally {
    cleanup(rig);
  }
});

// ---- ⓖ 경로 주입 · 끄기 · 옛 동작 보존 --------------------------------------------------

test("ⓖ 캐시 경로를 못 정하면(watchLogPath · approvalCachePath 둘 다 없음) 옛 동작 그대로: 줄 문면 옛 모양 · 캐시 파일 0 · 앞자리 반복", async () => {
  const rig = makeRig(3);
  try {
    const watchDirFiles = () => fs.readdirSync(rig.root).sort();
    const before = watchDirFiles();
    const outs = [];
    for (let i = 0; i < 3; i++) {
      outs.push(
        await report.runPartialCountOnce({
          now: NOW + i * STEP,
          repoRoot: rig.repo.dir,
          dispatchReceiptsPath: join(rig.root, "none.jsonl"),
          watchLogPath: undefined,
          extraRepoRoots: [],
          archiveRoot: join(rig.root, "archive-missing"),
          fetchJson: rig.fetch.fetchJson,
          git: report.createProcessGitPort(rig.repo.dir),
          gitWorktreeListExecFn: () => "",
          // 기본 watch.log 경로(관제실 실물)를 «읽지» 않도록 그 경로 읽기만 막는다 -- 합성 폴더 읽기는 그대로.
          readFn: (p, enc) => {
            if (/^[A-Za-z]:[\\/]문서관리/.test(String(p))) {
              throw new Error("ENOENT: 시험이 관제실 실물을 읽지 않는다");
            }
            return fs.readFileSync(p, enc);
          },
          approvalCachePath: undefined,
        }),
      );
    }
    assert.deepEqual(watchDirFiles(), before, "합성 폴더에 캐시 파일 0");
    assert.equal(
      outs[0].gate4.cache,
      undefined,
      "캐시 비활성 = gate4.cache 없음",
    );
    assert.deepEqual(
      new Set(rig.fetch.calls.pullsFor).size,
      1,
      "옛 동작 = 같은 앞자리만 조회",
    );
    assert.ok(
      !gate4Line(outs[0].reportText).includes("캐시 포함 확인"),
      "옛 줄 문면 그대로",
    );
    assert.match(gate4Line(outs[0].reportText), /중 조회 1건 · APPROVED 1/);
  } finally {
    cleanup(rig);
  }
});

test("ⓖ watchLogPath 만 주면 그 형제 «partial-count-approval-cache.json» 을 쓴다(감시 상태 파일 선례 · 경로 주입 = approvalCachePath 가 우선 · null 이면 끔)", async () => {
  const rig = makeRig(2);
  try {
    assert.equal(report.APPROVAL_CACHE_FILENAME, CACHE_NAME);
    const base = {
      repoRoot: rig.repo.dir,
      dispatchReceiptsPath: join(rig.root, "none.jsonl"),
      watchLogPath: join(rig.root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(rig.root, "archive-missing"),
      fetchJson: rig.fetch.fetchJson,
      git: report.createProcessGitPort(rig.repo.dir),
      gitWorktreeListExecFn: () => "",
    };
    await report.runPartialCountOnce({ ...base, now: NOW });
    assert.equal(fs.existsSync(rig.cachePath), true, "형제 파일에 저장");
    fs.rmSync(rig.cachePath);
    const custom = join(rig.root, "custom-cache.json");
    await report.runPartialCountOnce({
      ...base,
      now: NOW,
      approvalCachePath: custom,
    });
    assert.equal(fs.existsSync(custom), true, "주입 경로 우선");
    assert.equal(
      fs.existsSync(rig.cachePath),
      false,
      "형제 파일은 안 만들어짐",
    );
    const off = await report.runPartialCountOnce({
      ...base,
      now: NOW,
      approvalCachePath: null,
    });
    assert.equal(off.gate4.cache, undefined, "null = 캐시 끔");
    assert.equal(fs.existsSync(rig.cachePath), false);
  } finally {
    cleanup(rig);
  }
});

test("ⓖ 캐시 파일 표본: schema · 항목(sha → status · checkedAtMs · 증거) -- APPROVED 항목은 PR 번호 · 승인자를 담아 재사용 때 확인 사건 줄을 그대로 낼 수 있다", async () => {
  const rig = makeRig(2);
  try {
    await cycle(rig, 0);
    await cycle(rig, 1);
    const parsed = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    assert.equal(parsed.schema, "partial-count-approval-cache/v1");
    const shas = Object.keys(parsed.entries);
    assert.equal(shas.length, 2);
    for (const sha of shas) {
      const e = parsed.entries[sha];
      assert.equal(e.status, "APPROVED");
      assert.ok(Number.isFinite(e.checkedAtMs));
      assert.ok(Number.isInteger(e.pullNumber));
      assert.equal(e.reviewerLogin, "hykim82");
    }
    assert.equal(parsed.entries[rig.repo.mergeShas[1]].checkedAtMs, NOW);
    assert.equal(parsed.entries[rig.repo.mergeShas[0]].checkedAtMs, NOW + STEP);
  } finally {
    cleanup(rig);
  }
});

// ====================================================================================================================
// 2R (판정 #20261119-2020 · 검토 1R P1-1 수리) -- 캐시가 ㄴ «GitHub 사람 손» 변경 요청 분자를 낮추지 않는다.
//
// 1R 의 구멍: ㄴ 변경 요청은 ㄱ-4 가 그 회차에 «받은» /pulls/<n>/reviews 응답만 읽는다. 캐시가 이미 본 sha 의 조회를 건너뛰자 회차 2 부터
// 그 응답이 사라져 분자가 1 -> 0(회차 4 · 5 는 «미수집») 으로 내려갔다. 1R 시험은 두 쪽이 같은 sha 를 보는 회차 1 만 비교해 못 봤다.
// 수리: 양성(사람 변경 요청 사건 = 리뷰 식별자 + 제출 시각 + 작성자)만 캐시 항목에 실어 창 안에서 뒤 회차에도 센다 · «없다»는 이월하지
// 않는다(건너뛴 조회 수 + «새 변경 요청 미수집» 표지) · 열린 PR(PR_NOT_MERGED)은 캐시로 건너뛰지 않는다 · ㄱ 머리 줄에 캐시 재사용 표지.
// ⛔검토자 표(합성 3후보 · 가장 새 PR#3 에 창 안 사람 CHANGES_REQUESTED 1건 · 같은 입력 · 켬/끔 5회차)를 «회차마다» 비교한다.
// ====================================================================================================================

const LN_HEAD = "- 외부 독립 증거로 확인된 사건:";
const GH_LINE = "- GitHub 사람 손 ";
const ANCHOR_LINE = "- 외부 독립 앵커로 확인:";
const CR_AT_ISO = "2026-11-13T09:30:00Z";
const CR_REVIEW = {
  id: 77,
  user: { login: "human-rev", id: 4242 },
  state: "CHANGES_REQUESTED",
  commit_id: PULL_HEAD_SHA,
  submitted_at: CR_AT_ISO,
};
const CR_EVENT_ID = `${core.DAILY_EVENT_PREFIX.GITHUB}cr:77`;
const lineOf = (text, prefix) =>
  text.split("\n").find((l) => l.startsWith(prefix)) ?? "";
// 3R (판정 #20261120-0148) -- 캐시로 조회를 건너뛴 건수 s ≥ 1 인 회차의 ㄴ 머리 줄 끝에 붙는 표지(분자 = 하한). s = 0 이면 «없다».
const SKIP_MARK = (s) => ` · 캐시로 조회 ${s}건 건너뜀 · 새 변경 요청 미수집`;
const skipTailOf = (result) => {
  const s = result.githubHumanActions.changeRequestCacheSkipped;
  return s > 0 ? SKIP_MARK(s) : "";
};
const ghNumerator = (text) =>
  Number(/^- GitHub 사람 손 (\d+)건 이상/.exec(lineOf(text, GH_LINE))?.[1]);
const offOpts = (rig) => ({
  approvalCachePath: null,
  watchLogPath: join(rig.root, "off.log"),
});
// 가장 새 병합(PR#3)에 창 안 사람 변경 요청 1건 -- 검토자 표의 입력.
const withCr = (rig) => {
  rig.fetch.extraReviews[3] = [CR_REVIEW];
};

// 같은 입력으로 캐시 켬 rig · 끔 rig 를 나란히 cycles 회차 돈다 -- 결과를 회차 순서대로 돌려준다.
async function runPair(prCount, setup, cycles = 5) {
  const on = makeRig(prCount);
  const off = makeRig(prCount);
  setup(on);
  setup(off);
  const rOn = [];
  const rOff = [];
  for (let i = 0; i < cycles; i++) {
    rOn.push(await cycle(on, i));
    rOff.push(await cycle(off, i, offOpts(off)));
  }
  return { on, off, rOn, rOff };
}
const cleanupPair = (p) => {
  cleanup(p.on);
  cleanup(p.off);
};

test("2R ⑴ 검토자 표 5회차: 같은 입력에서 캐시 켬 = 끔 -- ㄴ «GitHub 사람 손» 분자 · 변경 요청 수 · ㄴ 머리 줄이 회차 1~5 모두 같다(회차 2~5 에서 내려가지 않는다)", async () => {
  const p = await runPair(3, withCr);
  try {
    for (let i = 0; i < 5; i++) {
      const a = p.rOn[i];
      const b = p.rOff[i];
      assert.equal(b.githubHumanActions.changeRequest, 1, `끔 회차 ${i + 1}`);
      assert.equal(
        a.githubHumanActions.changeRequest,
        b.githubHumanActions.changeRequest,
        `회차 ${i + 1}: 변경 요청 수`,
      );
      assert.equal(
        a.githubHumanActions.humanTotal,
        b.githubHumanActions.humanTotal,
        `회차 ${i + 1}: 사람 손 합계`,
      );
      assert.equal(
        ghNumerator(a.reportText),
        ghNumerator(b.reportText),
        `회차 ${i + 1}: ㄴ GitHub 사람 손 분자`,
      );
      // 3R: 캐시로 조회를 건너뛴 회차(s ≥ 1)는 머리 줄 끝에 표지가 붙는다 -- 표지 앞(분자 · 하한 토막)은 끔과 한 글자도 다르지 않다.
      assert.equal(
        lineOf(a.reportText, LN_HEAD),
        lineOf(b.reportText, LN_HEAD) + skipTailOf(a),
        `회차 ${i + 1}: ㄴ 머리 줄(분자 · 하한 토막 + 건너뜀 표지)`,
      );
    }
    // 끔 쪽 문면은 옛 그대로(캐시를 안 켠 회차는 새 표기가 없다).
    assert.ok(
      lineOf(p.rOff[0].reportText, GH_LINE).includes(
        "변경 요청 1(ㄱ-4 가 읽은 PR 1건 한정)",
      ),
    );
    assert.ok(!lineOf(p.rOff[0].reportText, GH_LINE).includes("이월"));
  } finally {
    cleanupPair(p);
  }
});

test("2R ⑴ 한계 값 고정 ㉠: 끔이 안 읽는 PR(가장 오래된 PR#1)에 변경 요청이 있으면 켬은 그 PR 을 읽는 회차부터 «더 센다»(켬 ≥ 끔 · 내려가지 않는다) -- 그 사건은 «이번 회차 확인» 으로 표지된다", async () => {
  const p = await runPair(3, (rig) => {
    rig.fetch.extraReviews[1] = [CR_REVIEW];
  });
  try {
    const on = p.rOn.map((r) => r.githubHumanActions.changeRequest ?? 0);
    const off = p.rOff.map((r) => r.githubHumanActions.changeRequest ?? 0);
    assert.deepEqual(
      off,
      [0, 0, 0, 0, 0],
      "끔 = 가장 새 PR#3 만 읽어 PR#1 사건을 못 본다",
    );
    // 켬: 회차 3 에 PR#1 을 읽는다(그 회차 «이번 회차 확인» 1) -> 회차 4 · 5 는 그 사건을 이월로 센다.
    assert.deepEqual(on, [0, 0, 1, 1, 1]);
    on.forEach((n, i) => assert.ok(n >= off[i], `회차 ${i + 1}: 켬 ≥ 끔`));
    assert.equal(p.rOn[2].githubHumanActions.changeRequestFresh, 1);
    assert.equal(p.rOn[3].githubHumanActions.changeRequestCarried, 1);
  } finally {
    cleanupPair(p);
  }
});

test("2R ⑴ 한계 값 고정 ㉡: 캐시가 건너뛴 PR 에 «나중에» 생긴 변경 요청은 못 읽는다 -- 끔(매 회차 가장 새 PR 을 읽음)보다 낮을 수 있고, 그때 줄이 «캐시로 조회 s건 건너뜀 · 새 변경 요청 미수집» 으로 그 사실을 보인다", async () => {
  const p = await runPair(3, () => {}, 2);
  try {
    // 회차 3 부터 PR#3 에 변경 요청이 생긴다(회차 1 · 2 에는 없었다).
    for (const rig of [p.on, p.off]) withCr(rig);
    p.rOn.push(await cycle(p.on, 2));
    p.rOff.push(await cycle(p.off, 2, offOpts(p.off)));
    assert.equal(p.rOff[2].githubHumanActions.changeRequest, 1, "끔은 읽는다");
    const g = p.rOn[2].githubHumanActions;
    assert.ok(
      (g.changeRequest ?? 0) < 1,
      "켬은 PR#3 이 캐시 재사용이라 새 변경 요청을 못 읽는다(낮을 수 있는 방향)",
    );
    assert.equal(
      g.changeRequestCacheSkipped,
      2,
      "건너뛴 조회 2건이 값으로 보인다",
    );
    assert.ok(
      lineOf(p.rOn[2].reportText, GH_LINE).includes(
        "캐시로 조회 2건 건너뜀 · 새 변경 요청 미수집",
      ),
      "표지 없이 조용히 낮아지지 않는다",
    );
  } finally {
    cleanupPair(p);
  }
});

test("2R ⑵ 이월 표기: «이번 회차 확인 m건 · 이전 회차 확인 이월 n건(캐시)» -- 양성 사건은 회차 1 에서 확인 · 뒤 회차에서는 이월로 따로 보이고 조회를 건너뛴 건수가 붙는다", async () => {
  const p = await runPair(3, withCr);
  try {
    // 회차별 [이번 회차 확인 m, 이전 회차 확인 이월 n, ㄱ-4 가 읽은 PR 수, 캐시로 조회 건너뜀]
    const expected = [
      [1, 0, 1, 0],
      [0, 1, 1, 1],
      [0, 1, 1, 2],
      [0, 1, 0, 3],
      [0, 1, 0, 3],
    ];
    expected.forEach(([m, n, prs, skipped], i) => {
      const tail =
        skipped > 0
          ? ` · 캐시로 조회 ${skipped}건 건너뜀 · 새 변경 요청 미수집`
          : "";
      // 회차 1(이월 0 · 건너뜀 0)은 캐시가 값에 닿지 않은 회차라 옛 문면 그대로.
      const cell =
        n === 0 && skipped === 0
          ? `변경 요청 1(ㄱ-4 가 읽은 PR ${prs}건 한정)`
          : `변경 요청 1(이번 회차 확인 ${m}건 · 이전 회차 확인 이월 ${n}건(캐시) · ㄱ-4 가 읽은 PR ${prs}건 한정${tail})`;
      assert.ok(
        lineOf(p.rOn[i].reportText, GH_LINE).includes(cell),
        `회차 ${i + 1}: ${cell}\n실제: ${lineOf(p.rOn[i].reportText, GH_LINE)}`,
      );
      assert.equal(p.rOn[i].githubHumanActions.changeRequestCarried, n);
      assert.equal(p.rOn[i].githubHumanActions.changeRequestFresh, m);
    });
  } finally {
    cleanupPair(p);
  }
});

test("2R ⑵ 이월은 «양성 · 창 안 · 사람» 만: 창 밖 제출 · 봇 계정은 이월 줄에서 세지 않는다(사건은 캐시 항목에 리뷰 식별자 · 제출 시각 · 작성자로 적힌다)", async () => {
  const rig = makeRig(3);
  try {
    const crAtMs = Date.parse(CR_AT_ISO);
    const entry = (n) => ({
      status: "APPROVED",
      checkedAtMs: NOW,
      pullNumber: n,
      reviewerLogin: "hykim82",
    });
    const entries = {
      [rig.repo.mergeShas[2]]: {
        ...entry(3),
        changeRequests: [
          { id: "501", login: "human-rev", atMs: crAtMs },
          { id: "502", login: "human-rev", atMs: NOW - 30 * HOUR },
          { id: "503", login: "bot-fixture-a", atMs: NOW - HOUR },
        ],
      },
      [rig.repo.mergeShas[1]]: entry(2),
      [rig.repo.mergeShas[0]]: entry(1),
    };
    fs.writeFileSync(
      rig.cachePath,
      JSON.stringify({ schema: "partial-count-approval-cache/v1", entries }),
      "utf8",
    );
    const r = await cycle(rig, 0, { maxMergeChecks: 0 });
    assert.equal(rig.fetch.calls.pullsFor.length, 0, "몫 0 = 조회 0");
    assert.equal(r.githubHumanActions.changeRequest, 1, "창 안 사람 1건만");
    assert.equal(r.githubHumanActions.changeRequestCarried, 1);
    assert.equal(r.githubHumanActions.changeRequestFresh, 0);
    assert.deepEqual(
      r.githubHumanActions.humanEventIds.filter((id) => id.startsWith("cr:")),
      ["cr:501"],
    );
    // 창 시작보다 오래된 기록(502)은 다시는 셀 수 없어 캐시에서 버려지고, 창 안 기록(봇 503 포함 -- 봇 판정은 세는 때)은 남는다.
    const saved = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    assert.deepEqual(
      saved.entries[rig.repo.mergeShas[2]].changeRequests.map((x) => x.id),
      ["501", "503"],
    );
  } finally {
    cleanup(rig);
  }
});

test("2R ⑶ 없다는 쪽은 이월하지 않는다: 변경 요청이 없던 입력에서 캐시 회차 4·5 는 «0» 이 아니라 «미수집» + 건너뛴 조회 수 + «새 변경 요청 미수집» · 셈 0 · 캐시 파일에 «없음» 이 기록되지 않는다", async () => {
  const p = await runPair(3, () => {});
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(
        p.rOn[i].githubHumanActions.humanTotal,
        p.rOff[i].githubHumanActions.humanTotal,
        `회차 ${i + 1}: 분자 켬 = 끔`,
      );
      assert.equal(
        lineOf(p.rOn[i].reportText, LN_HEAD),
        lineOf(p.rOff[i].reportText, LN_HEAD) + skipTailOf(p.rOn[i]),
        `회차 ${i + 1}: ㄴ 머리 줄(+ 건너뜀 표지)`,
      );
    }
    for (const i of [3, 4]) {
      const g = p.rOn[i].githubHumanActions;
      assert.equal(g.changeRequest, null, `회차 ${i + 1}: 0 이 아니라 미수집`);
      assert.equal(g.changeRequestCarried, 0, "없음은 이월하지 않는다");
      assert.ok(
        lineOf(p.rOn[i].reportText, GH_LINE).includes(
          "변경 요청 미수집(ㄱ-4 리뷰 응답 없음 · 캐시로 조회 3건 건너뜀 · 새 변경 요청 미수집)",
        ),
        lineOf(p.rOn[i].reportText, GH_LINE),
      );
      assert.ok(
        !lineOf(p.rOn[i].reportText, GH_LINE).includes("변경 요청 0("),
        "0 으로 접지 않는다",
      );
    }
    const parsed = JSON.parse(fs.readFileSync(p.on.cachePath, "utf8"));
    for (const e of Object.values(parsed.entries)) {
      assert.ok(
        !Array.isArray(e.changeRequests) || e.changeRequests.length === 0,
        "없다는 기록(빈 목록 · 0)을 사건처럼 적지 않는다",
      );
    }
  } finally {
    cleanupPair(p);
  }
});

test("2R ⑷ 열린 PR 은 캐시로 건너뛰지 않는다: PR_NOT_MERGED(열린 PR) 항목은 캐시 재사용 0 · 매 회차 조회 · 조회 횟수(예산) 무변 -- 병합되면 다시 일반 순서", async () => {
  const rig = makeRig(3);
  try {
    const [s1, s2, s3] = rig.repo.mergeShas;
    rig.fetch.behavior[s2] = "openpr";
    const rows = [];
    for (let i = 0; i < 5; i++) {
      if (i === 3) rig.fetch.behavior[s2] = "approved"; // 회차 4 에서 병합 처리됨
      const mark = rig.fetch.calls.pullsFor.length;
      const r = await cycle(rig, i);
      assert.ok(
        rig.fetch.calls.pullsFor.length - mark <= 1,
        "회차당 조회 ≤ 몫 1(예산 무변)",
      );
      rows.push({
        looked: lookedUpSince(rig, mark),
        reusedUndecidable: r.gate4.cache.reusedUndecidable,
        undecidable: r.gate4.undecidable,
        approved: r.gate4.approved,
        unchecked: r.gate4.uncheckedByBudget,
      });
    }
    // 열린 s2 는 회차 2 에 처음 보인 뒤 병합될 때까지 «매 회차» 다시 조회된다(캐시 재사용 0) -- 병합 뒤 s1 이 일반 순서로 돌아온다.
    assert.deepEqual(
      rows.map((r) => r.looked),
      [[s3], [s2], [s2], [s2], [s1]],
    );
    assert.deepEqual(
      rows.map((r) => r.reusedUndecidable),
      [0, 0, 0, 0, 0],
      "열린 PR 판정은 캐시에서 재사용되지 않는다",
    );
    assert.deepEqual(
      rows.map((r) => r.undecidable),
      [0, 1, 1, 0, 0],
      "열린 동안만 UNDECIDABLE(이번 회차 조회분)",
    );
    assert.deepEqual(
      rows.map((r) => r.unchecked),
      [2, 1, 1, 1, 0],
      "조회하지 못한 s1 은 미조회(예산)로 남는다(캐시 재사용으로 접지 않음)",
    );
    assert.equal(
      rig.fetch.calls.pullsFor.length,
      5,
      "5회차 조회 5건 = 캐시 끈 옛 동작(앞자리 5건)과 같은 횟수(예산 영향 0)",
    );
  } finally {
    cleanup(rig);
  }
});

test("2R ⑷ 열린 PR 은 조회 못 한 회차에도 캐시 판정으로 «재사용» 되지 않는다: 몫 0 회차 · 열린 PR 이 몫보다 많은 회차 -- 미조회(예산)로 남고 «열린 PR n건은 캐시로 건너뛰지 않음» 줄이 찍힌다", async () => {
  const rig = makeRig(3);
  try {
    const [s1, s2] = rig.repo.mergeShas;
    rig.fetch.behavior[s1] = "openpr";
    rig.fetch.behavior[s2] = "openpr";
    await cycle(rig, 0); // s3 APPROVED
    await cycle(rig, 1); // s2 열림 -> UNDECIDABLE(PR_NOT_MERGED) 저장
    await cycle(rig, 2); // 열린 s2 가 먼저 다시 조회됨(s1 은 미조회)
    const parsed = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
    assert.equal(parsed.entries[s2].reason, "PR_NOT_MERGED", "캐시 항목 표본");
    // 몫 0: 아무것도 조회 못 한다 -- 캐시에 있는 열린 s2 는 판정으로 재사용되지 않고, 닫힌 s3 만 재사용된다.
    const mark = rig.fetch.calls.pullsFor.length;
    const r0 = await cycle(rig, 3, { maxMergeChecks: 0 });
    assert.equal(rig.fetch.calls.pullsFor.length, mark, "몫 0 = 조회 0");
    assert.equal(r0.gate4.cache.reusedUndecidable, 0);
    assert.equal(r0.gate4.undecidable, 0, "열린 PR 판정을 캐시로 세지 않는다");
    assert.equal(r0.gate4.uncheckedByBudget, 2, "열린 s2 · 새 s1 모두 미조회");
    assert.equal(r0.gate4.cache.openPrNotReused, 1);
    assert.match(r0.reportText, /열린 PR 1건은 캐시로 건너뛰지 않음/);
    // 열린 PR 이 둘이고 몫이 1: 몫 밖 열린 PR 도 재사용되지 않는다.
    rig.fetch.behavior[s1] = "openpr";
    await cycle(rig, 4); // 열린 둘 중 하나 조회(캐시에 s1 이 없던 터라 s1 이 새 sha 로 먼저)
    const r5 = await cycle(rig, 5);
    assert.equal(r5.gate4.cache.reusedUndecidable, 0);
    assert.equal(r5.gate4.undecidable, 1, "이번 회차 조회한 열린 PR 1건만");
  } finally {
    cleanup(rig);
  }
});

test("2R ⑵ 코어 직접: 이월 기록도 이번 회차 응답과 같은 규칙으로 센다 -- 창 시작 전 · 창 끝 뒤 · 봇 · 같은 id 중복은 세지 않는다", () => {
  const start = NOW - 24 * HOUR;
  const base = {
    reviewLists: [],
    botLogins: new Set(["bot-fixture-a"]),
    windowStartMs: start,
    windowEndMs: NOW,
  };
  const rec = (id, login, atMs) => ({ id, login, atMs });
  const out = core.summarizeChangeRequests({
    ...base,
    carriedRecords: [
      rec("1", "human-rev", start - 1), // 창 시작 전
      rec("2", "human-rev", NOW + 1), // 창 끝 뒤
      rec("3", "bot-fixture-a", NOW - HOUR), // 봇
      rec("4", "human-rev", start), // 창 경계 = 안
      rec("4", "other-human", NOW - HOUR), // 같은 id 중복
      { id: "", login: "human-rev", atMs: NOW - HOUR }, // 모양 틀림
    ],
  });
  assert.equal(out.count, 1);
  assert.equal(out.carried, 1);
  assert.equal(out.fresh, 0);
  assert.deepEqual(
    out.events.map((e) => e.id),
    ["cr:4"],
  );
});

test("2R ⑸ 일별 줄 합집합이 회차 1 사건을 잃지 않는다: 회차 4 에서 후보 수집이 실패해(그 회차 변경 요청 판독 재료 0) 사건이 안 보여도 오늘 합집합 · 사건 시각 장부에 cr 사건이 남고, 켬 = 끔", async () => {
  const p = await runPair(3, withCr, 3);
  try {
    // 회차 4 = 두 쪽 모두 origin/master 없음(후보 수집 실패 · ㄱ-4 unknown) -> 그 회차 tick 에는 변경 요청 사건이 없다. 회차 5 = 복구.
    for (const rig of [p.on, p.off]) {
      git(rig.repo.dir, ["update-ref", "-d", "refs/remotes/origin/master"]);
    }
    p.rOn.push(await cycle(p.on, 3));
    p.rOff.push(await cycle(p.off, 3, offOpts(p.off)));
    for (const rig of [p.on, p.off]) {
      git(rig.repo.dir, [
        "update-ref",
        "refs/remotes/origin/master",
        rig.repo.headSha,
      ]);
    }
    p.rOn.push(await cycle(p.on, 4));
    p.rOff.push(await cycle(p.off, 4, offOpts(p.off)));
    assert.equal(p.rOn[3].gate4.known, false);
    assert.ok(
      !p.rOn[3].dailyTick.confirmedEventIds.includes(CR_EVENT_ID),
      "회차 4 tick 에는 사건이 없다(합집합이 살려야 하는 상황)",
    );
    let stOn = null;
    let stOff = null;
    const crAtMs = Date.parse(CR_AT_ISO);
    for (let i = 0; i < 5; i++) {
      const nowMs = NOW + i * STEP;
      stOn = core.recordDailyTick({
        state: stOn,
        nowMs,
        tick: p.rOn[i].dailyTick,
        concurrentActive: 0,
      });
      stOff = core.recordDailyTick({
        state: stOff,
        nowMs,
        tick: p.rOff[i].dailyTick,
        concurrentActive: 0,
      });
      assert.ok(
        stOn.confirmedEventIds.includes(CR_EVENT_ID),
        `회차 ${i + 1} 뒤 켬 합집합에 회차 1 사건이 남아 있다`,
      );
      assert.equal(stOn.githubItemAtMs["cr:77"], crAtMs);
      assert.deepEqual(
        [...stOn.confirmedEventIds].sort(),
        [...stOff.confirmedEventIds].sort(),
        `회차 ${i + 1}: 일별 합집합 켬 = 끔`,
      );
    }
  } finally {
    cleanupPair(p);
  }
});

test("2R ⑹ 캐시 항목 통째 삭제 -> 다음 회차에 다시 조회돼 사건이 «이번 회차 확인» 으로 되살아난다(이월 0) · 파일 통째 삭제도 같다", async () => {
  for (const mode of ["entry", "file"]) {
    const rig = makeRig(3);
    try {
      withCr(rig);
      for (let i = 0; i < 3; i++) await cycle(rig, i);
      const s3 = rig.repo.mergeShas[2];
      const before = JSON.parse(fs.readFileSync(rig.cachePath, "utf8"));
      assert.equal(
        before.entries[s3].changeRequests?.length,
        1,
        "삭제 전: 양성 사건이 항목에 적혀 있다",
      );
      assert.deepEqual(
        { ...before.entries[s3].changeRequests[0] },
        { id: "77", login: "human-rev", atMs: Date.parse(CR_AT_ISO) },
        "리뷰 식별자 · 제출 시각 · 작성자",
      );
      if (mode === "entry") {
        delete before.entries[s3];
        fs.writeFileSync(rig.cachePath, JSON.stringify(before), "utf8");
      } else {
        fs.rmSync(rig.cachePath);
      }
      const mark = rig.fetch.calls.pullsFor.length;
      const r = await cycle(rig, 3);
      assert.deepEqual(
        lookedUpSince(rig, mark),
        [s3],
        `${mode} 삭제: 사라진 sha 가 다시 조회됨(가장 새 병합 = 캐시에 없는 sha 순서 첫째)`,
      );
      assert.equal(r.githubHumanActions.changeRequest, 1, "사건이 되살아남");
      assert.equal(r.githubHumanActions.changeRequestFresh, 1);
      assert.equal(r.githubHumanActions.changeRequestCarried, 0);
    } finally {
      cleanup(rig);
    }
  }
});

test("2R ⑺ ㄱ 머리 줄 «외부 독립 앵커로 확인: N건» 에 캐시 재사용 표지(k건) -- 끔 쪽 머리 줄은 옛 그대로", async () => {
  const p = await runPair(3, () => {});
  try {
    const marks = p.rOn.map((r) => lineOf(r.reportText, ANCHOR_LINE));
    assert.deepEqual(marks, [
      "- 외부 독립 앵커로 확인: 1건 (캐시 재사용 0건)",
      "- 외부 독립 앵커로 확인: 2건 (캐시 재사용 1건)",
      "- 외부 독립 앵커로 확인: 3건 (캐시 재사용 2건)",
      "- 외부 독립 앵커로 확인: 3건 (캐시 재사용 3건)",
      "- 외부 독립 앵커로 확인: 3건 (캐시 재사용 3건)",
    ]);
    for (const r of p.rOff) {
      assert.equal(
        lineOf(r.reportText, ANCHOR_LINE),
        "- 외부 독립 앵커로 확인: 1건",
        "캐시를 안 켠 회차의 머리 줄은 표지 0",
      );
    }
  } finally {
    cleanupPair(p);
  }
});

// ====================================================================================================================
// 3R (판정 #20261120-0148 · 검토 2R P2-1 · P2-2 수리) -- 캐시로 조회를 건너뛴 회차의 ㄴ 머리 줄에도 «분자 = 하한» 표지.
//
// 2R 의 구멍: 캐시가 건너뛴 PR 에 «나중에» 생긴 변경 요청은 못 읽는다(끔보다 낮을 수 있는 유일한 방향). 그 사실은 ㄴ «GitHub 사람 손» 줄에는
// 표지로 보였지만, 아침 보고가 읽는 ㄴ 머리 줄(`- 외부 독립 증거로 확인된 사건: …`)에는 없어 분자가 조용히 낮게 읽혔다.
// 수리: s ≥ 1 인 회차의 ㄴ 머리 줄 끝에 «캐시로 조회 s건 건너뜀 · 새 변경 요청 미수집» · s = 0 인 회차의 머리 줄은 바이트 무변.
// ====================================================================================================================

// 검토 2R 입력 L: 회차 1 · 2 에는 변경 요청이 없고 회차 3 부터 가장 새 PR#3 에 사람 변경 요청이 «나중에» 생긴다 · 4회차.
// (검토자 표 -- 켬 0·0·0·0 / 끔 0·0·1·1: 켬은 PR#3 이 캐시 재사용이라 새 변경 요청을 못 읽는다.)
async function runInputL() {
  const p = await runPair(3, () => {}, 2);
  for (const rig of [p.on, p.off]) withCr(rig);
  for (let i = 2; i < 4; i++) {
    p.rOn.push(await cycle(p.on, i));
    p.rOff.push(await cycle(p.off, i, offOpts(p.off)));
  }
  return p;
}

test("3R ⑴ 입력 L(병합 뒤 변경 요청 · 4회차): s ≥ 1 회차의 ㄴ 머리 줄 끝에 «캐시로 조회 s건 건너뜀 · 새 변경 요청 미수집» -- 표지 앞은 끔과 같고 분자는 하한으로 읽힌다", async () => {
  const p = await runInputL();
  try {
    const nums = (rs) => rs.map((r) => r.githubHumanActions.changeRequest ?? 0);
    assert.deepEqual(nums(p.rOff), [0, 0, 1, 1], "끔 = 0·0·1·1(검토자 표)");
    assert.deepEqual(
      nums(p.rOn),
      [0, 0, 0, 0],
      "켬 = 0·0·0·0(캐시가 새 요청을 못 읽는다)",
    );
    const skipped = p.rOn.map(
      (r) => r.githubHumanActions.changeRequestCacheSkipped,
    );
    assert.deepEqual(skipped, [0, 1, 2, 3], "건너뛴 조회 s = 0·1·2·3");
    skipped.forEach((s, i) => {
      const head = lineOf(p.rOn[i].reportText, LN_HEAD);
      const off = lineOf(p.rOff[i].reportText, LN_HEAD);
      if (s === 0) {
        assert.equal(head, off, `회차 ${i + 1}: s = 0 은 끔과 바이트 같다`);
        assert.ok(!head.includes("캐시로 조회"), `회차 ${i + 1}: 표지 0`);
      } else {
        assert.ok(
          head.endsWith(SKIP_MARK(s)),
          `회차 ${i + 1}: 끝 표지 ${SKIP_MARK(s)}\n실제: ${head}`,
        );
        // 표지 앞 = 켬 자신의 분자(회차 3 · 4 는 끔보다 낮은 0 -- 바로 그 «조용히 낮게 읽히는» 값에 표지가 붙는 칸이다).
        const n = p.rOn[i].githubHumanActions.humanTotal;
        assert.equal(
          head.slice(0, -SKIP_MARK(s).length),
          `${LN_HEAD} 확인 ${n}건 이상 · GitHub 사람 손 목록 1개 미조회`,
          `회차 ${i + 1}: 표지 앞 = 켬 자신의 분자 · 하한 토막`,
        );
        assert.ok(
          n <= p.rOff[i].githubHumanActions.humanTotal,
          `회차 ${i + 1}: 켬 분자는 끔보다 높지 않다(낮을 수 있는 방향)`,
        );
        assert.ok(
          head.includes("건 이상"),
          `회차 ${i + 1}: 분자는 «이상»(하한) 표기`,
        );
        assert.equal(head.split("캐시로 조회").length - 1, 1, "표지는 한 번만");
      }
    });
    // 사람 손 줄의 옛 표지(2R)는 그대로 -- 머리 줄과 사람 손 줄 양쪽에 표지.
    assert.ok(
      lineOf(p.rOn[3].reportText, GH_LINE).includes(
        "캐시로 조회 3건 건너뜀 · 새 변경 요청 미수집",
      ),
    );
  } finally {
    cleanupPair(p);
  }
});

// 9bf90a5(3R 시작 head)에서 «프로덕션 진입점으로» 뽑은 s = 0 회차의 ㄴ 머리 줄 원문 -- 표지가 붙지 않고 바이트가 그대로다.
const HEAD_NO_CR = `${LN_HEAD} 확인 0건 이상 · GitHub 사람 손 목록 1개 미조회`;
const HEAD_WITH_CR = `${LN_HEAD} 확인 1건 이상 · GitHub 사람 손 목록 1개 미조회`;
const BASELINE_HEADS = {
  "변경요청없음-끔-1": HEAD_NO_CR,
  "변경요청없음-끔-2": HEAD_NO_CR,
  "변경요청없음-끔-3": HEAD_NO_CR,
  "변경요청없음-켬-1": HEAD_NO_CR,
  "변경요청있음-끔-1": HEAD_WITH_CR,
  "변경요청있음-끔-2": HEAD_WITH_CR,
  "변경요청있음-끔-3": HEAD_WITH_CR,
  "변경요청있음-켬-1": HEAD_WITH_CR,
};

test("3R ⑵ s = 0 회차의 ㄴ 머리 줄은 9bf90a5 와 바이트 같다 -- 캐시 끔 여러 회차 · 캐시 켠 첫 회차(건너뜀 0) · 변경 요청 있는 입력 · 없는 입력", async () => {
  const seen = {};
  for (const [name, setup] of [
    ["변경요청없음", () => {}],
    ["변경요청있음", withCr],
  ]) {
    const p = await runPair(3, setup, 3);
    try {
      p.rOff.forEach((r, i) => {
        seen[`${name}-끔-${i + 1}`] = lineOf(r.reportText, LN_HEAD);
        assert.equal(skipTailOf(r), "", "끔은 건너뜀 0");
      });
      seen[`${name}-켬-1`] = lineOf(p.rOn[0].reportText, LN_HEAD);
      assert.equal(p.rOn[0].githubHumanActions.changeRequestCacheSkipped, 0);
    } finally {
      cleanupPair(p);
    }
  }
  assert.deepEqual(seen, BASELINE_HEADS);
});

// 건너뜀 표지는 «새 조회 없이 캐시로 판정한» 건수가 값일 때만 붙는다 -- 캐시를 켰어도 건너뜀이 0 인 회차(첫 회차 · 몫 안에 다 든 회차)는 옛 문면이다.
test("3R ⑵ 캐시를 켜고 건너뜀이 0 인 회차(몫 2 -- 회차 총 호출 10 ≤ 12 라 사람 손 목록 몫이 남는다)의 머리 줄도 표지 0 · 끔과 바이트 같다", async () => {
  const rig = makeRig(3);
  const rigOff = makeRig(3);
  try {
    for (const r of [rig, rigOff]) withCr(r);
    const on = await cycle(rig, 0, { maxMergeChecks: 2 });
    const off = await cycle(rigOff, 0, {
      ...offOpts(rigOff),
      maxMergeChecks: 2,
    });
    assert.equal(on.githubHumanActions.changeRequestCacheSkipped, 0);
    assert.equal(
      lineOf(on.reportText, LN_HEAD),
      lineOf(off.reportText, LN_HEAD),
    );
    assert.ok(!lineOf(on.reportText, LN_HEAD).includes("캐시로 조회"));
  } finally {
    cleanup(rig);
    cleanup(rigOff);
  }
});

// reach-report(아침 보고) 판독 -- 부분 계수 보고서 «텍스트» 를 읽는 프로덕션 wire(runReachOnce). 표지 붙은 머리 줄을 깨지지 않고 표지째 옮긴다.
const REACH_WATCH_LINE = (ts) =>
  `${new Date(ts).toISOString()} exit=0 verdict=PROGRESSING reason=OK ` +
  `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
  `idle_status=SEAT_IDLE_NOT_APPLICABLE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=1 ` +
  `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
  `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`;

function reachTickOver(root, reportText, nowMs) {
  const watchLogPath = join(root, "watch.log");
  const partialCountPath = join(root, "partial-count-report.md");
  fs.writeFileSync(watchLogPath, REACH_WATCH_LINE(nowMs), "utf8");
  fs.writeFileSync(partialCountPath, reportText, "utf8");
  return runReachOnce({
    watchLogPath,
    partialCountPath,
    reportOutPath: join(root, "morning-report.md"),
    statePath: join(root, "state.json"),
    notifyDir: join(root, "받는함"),
    now: nowMs,
  });
}

test("3R ⑶ 아침 보고(reach-report)가 표지 붙은 ㄴ 머리 줄을 깨지지 않고 표지째 옮긴다 -- 머리 줄 원문 그대로 · 후보 N 판독 · 자격 판독 · 통지 변화 켬 = 끔", async () => {
  const p = await runPair(3, withCr, 3);
  const root = tmpDir("nc-c1-reach-");
  try {
    const on = p.rOn[2];
    const off = p.rOff[2];
    assert.equal(skipTailOf(on), SKIP_MARK(2), "입력: 건너뜀 2 회차");
    const head = lineOf(on.reportText, LN_HEAD);
    assert.ok(head.endsWith(SKIP_MARK(2)), "표지 붙은 머리 줄");
    const nowMs = NOW + 3 * STEP;
    const reach = reachTickOver(root, on.reportText, nowMs);
    assert.equal(
      lineOf(reach.reportText, LN_HEAD),
      head,
      "아침 보고의 머리 줄 = 부분 계수 보고서의 머리 줄(표지째 · 한 글자도 안 바뀐다)",
    );
    assert.ok(reach.reportText.includes(head));
    // 같은 줄 판독기들이 표지 때문에 깨지지 않는다 -- 켬(표지 있음) 과 끔(표지 없음)이 같은 값을 읽는다.
    const parsedOn = core.parseExternalEvidenceCandidateLine(on.reportText);
    const parsedOff = core.parseExternalEvidenceCandidateLine(off.reportText);
    assert.equal(parsedOn.state, "count", "후보 N 줄이 읽힌다");
    assert.deepEqual(parsedOn, parsedOff);
    assert.deepEqual(
      core.parseQualificationLine(on.reportText),
      core.parseQualificationLine(off.reportText),
    );
    // 끔 보고서로 돈 아침 보고와 통지 · 상태가 같다(표지는 통지 판독 값을 바꾸지 않는다).
    const rootOff = tmpDir("nc-c1-reach-off-");
    try {
      const reachOff = reachTickOver(rootOff, off.reportText, nowMs);
      assert.equal(reach.toNotify.length, reachOff.toNotify.length);
      assert.equal(reach.noticePath === null, reachOff.noticePath === null);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(join(root, "state.json"), "utf8")),
        JSON.parse(fs.readFileSync(join(rootOff, "state.json"), "utf8")),
      );
    } finally {
      fs.rmSync(rootOff, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanupPair(p);
  }
});

// 검토 2R P2-2(변이 D) -- «다시 조회한 sha 가 앞 양성 기록을 버린다» 는 변이를 잡는 칸. 입력 = 검토자 drive3(캐시에 양성 기록이 있는 sha 가
// 6시간 뒤 재확인 대상이 되고, 그 재조회가 리뷰 응답을 받기 전에 HTTP 500 으로 실패한다).
test("3R ⑷ 다시 조회한 sha 도 앞 양성 기록을 버리지 않는다: 재조회 HTTP 500(UNDECIDABLE · 응답 없음) · 재조회 응답에 그 변경 요청이 없음 -- 두 경우 모두 이월 1 · 캐시 항목 기록 보존", async () => {
  const rig = makeRig(1);
  try {
    const s1 = rig.repo.mergeShas[0];
    rig.fetch.behavior[s1] = "notapproved";
    rig.fetch.extraReviews[1] = [CR_REVIEW];
    const r1 = await cycle(rig, 0);
    assert.equal(r1.gate4.notApproved, 1, "회차 1: NOT_APPROVED(승인 없음)");
    assert.equal(r1.githubHumanActions.changeRequest, 1);
    assert.equal(r1.githubHumanActions.changeRequestFresh, 1);
    const savedIds = () =>
      JSON.parse(fs.readFileSync(rig.cachePath, "utf8")).entries[
        s1
      ].changeRequests?.map((x) => x.id);
    assert.deepEqual(savedIds(), ["77"], "회차 1 뒤 캐시 항목에 양성 기록");

    // 회차 2: NOT_APPROVED 재확인 시한 지남 -> 다시 조회되는데 그 조회가 응답 전에 실패한다.
    const t2 = NOW + report.NOT_APPROVED_RECHECK_MS + 15 * MIN;
    rig.fetch.behavior[s1] = "http500";
    const mark = rig.fetch.calls.pullsFor.length;
    const r2 = await cycle(rig, 0, { now: t2 });
    assert.deepEqual(lookedUpSince(rig, mark), [s1], "다시 조회된 sha");
    assert.equal(r2.gate4.checked, 1);
    assert.equal(r2.gate4.undecidable, 1, "재조회 실패 = UNDECIDABLE");
    assert.equal(
      r2.githubHumanActions.changeRequest,
      1,
      "앞 양성 기록이 살아 있다",
    );
    assert.equal(r2.githubHumanActions.changeRequestCarried, 1);
    assert.equal(r2.githubHumanActions.changeRequestFresh, 0);
    assert.deepEqual(savedIds(), ["77"], "회차 2 뒤 캐시 항목 기록 보존");

    // 회차 3: UNDECIDABLE 항목이 다시 조회되고 이번엔 응답이 오는데, 그 응답에는 그 변경 요청이 없다(기각 · 삭제) -- 한 번 일어난 사건은 낮추지 않는다.
    rig.fetch.behavior[s1] = "notapproved";
    rig.fetch.extraReviews[1] = [];
    const r3 = await cycle(rig, 0, { now: t2 + STEP });
    assert.equal(r3.gate4.checked, 1);
    assert.equal(r3.gate4.notApproved, 1);
    assert.equal(
      r3.githubHumanActions.changeRequest,
      1,
      "응답에 없어도 앞 기록 ∪ 새 기록",
    );
    assert.equal(r3.githubHumanActions.changeRequestCarried, 1);
    assert.deepEqual(savedIds(), ["77"]);
  } finally {
    cleanup(rig);
  }
});

const GATE4_CALLS_PER_SHA = 5;

// 사전 확인 값(코드 변경 아님) -- 캐시를 끄고 창 전체를 다시 조회하는 실행이 지금 인자로 가능한가.
test("3R 사전 확인 값 고정: 캐시 끔 + 기본 몫(1) = 몇 회차를 돌아도 같은 앞자리 sha 한 건만 · 캐시 끔 + 몫 인자(--max-merge-checks) = 후보 수 W 면 한 회차에 창 전체 · 캐시 켬 + 기본 몫 = W 회차 · CLI 에서 캐시는 --watch-log 를 «안 주면» 꺼진다", async () => {
  const W = 5;
  const rig = makeRig(W);
  const rigAll = makeRig(W);
  try {
    // 캐시 끔 · 기본 몫 1: 5회차를 돌아도 조회된 서로 다른 sha 는 1(가장 새 병합) -- 창 전체를 못 본다.
    let last;
    for (let i = 0; i < W; i++) last = await cycle(rig, i, offOpts(rig));
    assert.equal(new Set(rig.fetch.calls.pullsFor).size, 1);
    assert.equal(rig.fetch.calls.pullsFor.length, W);
    assert.equal(last.gate4.uncheckedByBudget, W - 1);
    // 캐시 끔 · 몫 인자 W: 한 회차에 W 건 전부(몫 인자 = CLI `--max-merge-checks W`).
    const mark = rigAll.fetch.calls.gate4.length;
    const all = await cycle(rigAll, 0, {
      ...offOpts(rigAll),
      maxMergeChecks: W,
    });
    assert.equal(all.gate4.checked, W);
    assert.equal(all.gate4.uncheckedByBudget, 0);
    assert.equal(all.gate4.approved, W);
    assert.equal(new Set(rigAll.fetch.calls.pullsFor).size, W);
    const gate4Calls = rigAll.fetch.calls.gate4.length - mark;
    // 이 합성(승인 응답 1페이지 · 승인 sha)에서 sha 한 건당 ㄱ-4 호출 수 = 5(저장소 · 브랜치 · 병합 PR 찾기 · PR 상세 · 리뷰) -- callBudget 8 안.
    assert.equal(gate4Calls, W * GATE4_CALLS_PER_SHA);
    assert.ok(
      GATE4_CALLS_PER_SHA <= DEFAULT_CALL_BUDGET,
      "sha당 상한(callBudget 8) 안",
    );
    // 부수 값: 회차 합산 천장(12)을 ㄱ-4 만으로 넘기므로 같은 회차의 사람 손 목록(P3)은 몫 0 -> 미조회(예산) -- 전체 재조회 회차의 ㄴ 사람 손 분자는 «미조회».
    assert.ok(W * GATE4_CALLS_PER_SHA > report.PER_TICK_CALL_CEILING);
    assert.equal(
      all.githubHumanActions.known,
      false,
      "사람 손 목록 몫 0 = 미조회",
    );
    // 캐시 켬 · 기본 몫: W 회차(ⓐ 칸이 값으로 이미 고정 -- 여기서는 경로 해석만).
    const root = rig.root;
    assert.equal(
      report.resolveApprovalCachePath({}),
      null,
      "CLI 기본 = 캐시 끔",
    );
    assert.equal(
      report.resolveApprovalCachePath({
        watchLogPath: join(root, "watch.log"),
      }),
      join(root, CACHE_NAME),
      "--watch-log 를 주면 그 옆 캐시 파일(켬)",
    );
    assert.equal(
      report.resolveApprovalCachePath({
        approvalCachePath: null,
        watchLogPath: join(root, "watch.log"),
      }),
      null,
      "주입 null = 끔(CLI 인자로는 못 준다)",
    );
  } finally {
    cleanup(rig);
    cleanup(rigAll);
  }
});
