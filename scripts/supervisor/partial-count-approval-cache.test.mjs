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
function makeFetch(repo) {
  const behavior = {};
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
      return respond({
        number: Number(path.split("/").pop()),
        merged: true,
        base: { ref: "master" },
        head: { sha: PULL_HEAD_SHA },
        user: { login: "harness-bot", id: 999 },
      });
    }
    const reviews = /^\/pulls\/(\d+)\/reviews\?per_page=100$/.exec(path);
    if (reviews) {
      const sha = repo.mergeShas[Number(reviews[1]) - 1];
      if (behavior[sha] === "notapproved") return respond([]);
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
  return { fetchJson, calls, behavior };
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
            !l.includes("ㄱ-4") && !l.includes("캐시") && !l.startsWith("생성"),
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
