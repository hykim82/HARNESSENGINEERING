// HYK-255-g3-record-1 (묶음 B · 조각 B1 · 전달 #20261123-1740 확정 2 · 판정 #20261123-1905 G1 ⓐ · G4 ⓐ) -- 게이트 3 GitHub 기록(S4).
//
//   한용 손 = 전용 기록 가지(gate3-record)로 열린 «결정 PR» 의 초록 Merge 1회. 수집기는 목록 1회 + 창 안 병합분 상세 `pulls/{n}` 으로
//   «병합자 login+id ∈ origin/master 명단 · ≠ 작성자 · ∉ 봇 목록» 인 병합만 «ㄱ-3 독립 확인» 으로 센다 -- 기록만 · 차단 0 · 커버리지 상수
//   `[4]` 무변(별도 줄) · 양성 캐시 0 · 회차 REST 천장 12 무변(S4 몫 = P3 뒤 남는 몫 min(2, 12 - 앞 사용)).
//
// ⛔헛시험 금지: 프로덕션 진입점(runPartialCountOnce · runWatchCliPartialCountStep · buildPartialCountReport)을 직접 구동한다.
//   저장소는 mkdtemp 합성 git(실제 git), fetchJson 은 호출을 기록하는 주입 가짜 · 전달 폴더는 mkdtemp 합성 파일.
//   실제 네트워크 · gh · 토큰 · 관제실 · 실제 `.harness` 접촉 0. 기대값은 전부 이 파일 안에서 손으로 정한 값이다.
//   S4 진리표 20칸 ↔ 시험 이름 접두 R1~R14 · L1~L4 · C1 · C2 1:1(+ 고정 머리 M23 칸 · 차단 0 · opt-in · 천장 칸).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import {
  buildPartialCountStepOptions,
  runWatchCliPartialCountStep,
} from "./watch-run.mjs";
import { DEFAULT_CALL_BUDGET } from "./approval-authority-adapter.mjs";

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
// 시험 고정값 = 합성 이름(실제 봇 계정 이름 0).
const BOT_A = "bot-fixture-a";
const BOT_B = "bot-fixture-b";
const BOTS_JSON = JSON.stringify({
  schema_version: "github-bot-accounts/v1",
  bots: [{ login: BOT_A }, { login: BOT_B }],
});
const HANYONG = { login: "hykim82", id: 286230306 };
const GITHUB_COMMITTER = { name: "GitHub", email: "noreply@github.com" };
const HUMAN_COMMITTER = { name: "hykim82", email: "hykim82@example.com" };
const PULL_HEAD_SHA = "e".repeat(40);
// 시험이 손으로 적은 고정 머리 / 기록 가지 이름(상수와 독립 사본 -- 상수가 바뀌면 이 시험이 RED).
const HEAD = "[게이트3 승인 기록]";
const RECORD_BASE = "gate3-record";
const NUM = "20261123-1740";
const GATE3_LINE_PREFIX = "- ㄱ-3 GitHub 기록";
const LIST_URL = `https://api.github.com/repos/${REPO}/pulls?state=all&base=${RECORD_BASE}&sort=created&direction=desc&per_page=100`;

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

// 합성 저장소 -- origin/master 에 허용 목록 + 봇 목록(옵션) · ubCounts[i] = i 번째 PR 브랜치의 Update branch 병합 커밋 수
// («Merge pull request» 로 합침: ㄱ-4 후보 = PR 수 · D1 후보 = Update branch 합계 -- rest-cap 시험과 같은 모양).
function buildRepo(ubCounts = [], { allowlist = true, bots = true } = {}) {
  const dir = tmpDir("nc-g3rec-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(join(dir, "README.md"), "synthetic\n", "utf8");
  if (allowlist)
    fs.writeFileSync(join(dir, ALLOWLIST_PATH), ALLOWLIST_JSON, "utf8");
  if (bots) fs.writeFileSync(join(dir, BOTS_PATH), BOTS_JSON, "utf8");
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

// ---- 합성 응답 -------------------------------------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();
const ok200 = (json) => ({ ok: true, status: 200, json, linkHeader: null });
const ERR500 = { ok: false, status: 500, json: null, linkHeader: null };
const RATE403 = { ok: false, status: 403, json: null, linkHeader: null };

const IN_WINDOW_MERGED = NOW - 2 * HOUR; // 11-24 10:00 KST
const IN_WINDOW_MERGED_KST = "11-24 10:00 KST";

// 기록 PR 한 건의 «목록 항목» (판정 1905 · 설계 (나) 표: base.ref · head.ref · title · user.login · merged_at · state).
function recPr(over = {}) {
  const o = {
    pr: 101,
    number: NUM,
    author: BOT_A,
    base: RECORD_BASE,
    state: "closed",
    mergedAtMs: IN_WINDOW_MERGED,
    createdAtMs: NOW - 3 * HOUR,
    ...over,
  };
  const closedAtMs = o.closedAtMs ?? o.mergedAtMs ?? IN_WINDOW_MERGED;
  return {
    number: o.pr,
    state: o.state,
    title: o.title ?? `${HEAD} #${o.number} 결정 요지`,
    head: { ref: o.head ?? `g3-${o.number}` },
    base: { ref: o.base },
    user: { login: o.author, id: 300438013 },
    created_at: iso(o.createdAtMs),
    closed_at: o.state === "open" ? null : iso(closedAtMs),
    merged_at: o.mergedAtMs === null ? null : iso(o.mergedAtMs),
  };
}
const openPr = (over = {}) =>
  recPr({ state: "open", mergedAtMs: null, ...over });
const unmergedClosedPr = (over = {}) =>
  recPr({ state: "closed", mergedAtMs: null, closedAtMs: NOW - HOUR, ...over });

// 병합된 PR 상세 (`pulls/{n}`): merged_by 가 병합 버튼을 누른 계정.
const detailOf = (
  pr,
  mergedBy,
  { author = BOT_A, mergedAtMs = IN_WINDOW_MERGED } = {},
) => ({
  number: pr,
  merged: true,
  merged_at: iso(mergedAtMs),
  base: { ref: RECORD_BASE },
  user: { login: author, id: 300438013 },
  merged_by: mergedBy,
});

// 가짜 fetchJson -- 기록 목록 · 상세 · P3 목록 · ㄱ-4/D1 체인을 구분해 기록한다.
//   list: 배열 | 응답 객체 | 던지는 함수 · details: {번호: 응답 json | 응답 객체}
function makeFetch({ repo, list = [], details = {}, listThrows = false } = {}) {
  const calls = {
    g3List: [],
    g3Detail: [],
    p3: [],
    d1: [],
    gate4: [],
    all: [],
  };
  const mergeNumber = new Map(
    (repo?.mergeShas ?? []).map((s, i) => [s, i + 1]),
  );
  const fetchJson = async ({ url }) => {
    calls.all.push(url);
    const path = url.replace(`https://api.github.com/repos/${REPO}`, "");
    if (path.startsWith(`/pulls?state=all&base=${RECORD_BASE}`)) {
      calls.g3List.push(url);
      return g3ListReply({ list, listThrows });
    }
    if (P3_PATH_RE.test(path)) {
      calls.p3.push(url);
      return ok200([]);
    }
    const detail = /^\/pulls\/(\d+)$/.exec(path);
    if (detail && Object.hasOwn(details, Number(detail[1]))) {
      calls.g3Detail.push(url);
      return g3DetailReply(details[Number(detail[1])]);
    }
    const d1 = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (d1) {
      calls.d1.push(url);
      return d1Reply(d1[1]);
    }
    calls.gate4.push(url);
    return chainReply(path, repo, mergeNumber);
  };
  return { fetchJson, calls };
}

const P3_PATH_RE =
  /^\/pulls\?state=closed|^\/issues\/comments\?|^\/pulls\/comments\?/;

function g3ListReply({ list, listThrows }) {
  if (listThrows) throw new Error("합성 네트워크 예외");
  return Array.isArray(list) ? ok200(list) : list;
}

const g3DetailReply = (d) =>
  d && typeof d === "object" && "ok" in d ? d : ok200(d);

// D1(Update branch 서명 확인) 응답 -- 확인 모양.
const d1Reply = (sha) =>
  ok200({
    sha,
    commit: {
      verification: { verified: true, reason: "valid" },
      committer: { name: "GitHub", email: "noreply@github.com" },
    },
    author: HANYONG,
    committer: { login: "web-flow", id: 19864447 },
  });

// ㄱ-4 체인 응답 -- «체인을 끝까지 끄는» 승인 모양(rest-cap 시험과 같다).
function chainReply(path, repo, mergeNumber) {
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
        user: HANYONG,
        state: "APPROVED",
        commit_id: PULL_HEAD_SHA,
        submitted_at: iso(NOW - 3 * HOUR),
      },
    ]);
  }
  return { ok: false, status: 404, json: null, linkHeader: null };
}

let sharedRepo = null;
const plainRepo = () => (sharedRepo ??= buildRepo([]));

// 프로덕션 진입점 1회. gate3 = false 면 옵션을 «주지 않는다»(옛 호출자). relay = 전달 폴더 글롭(없으면 교차 미결선).
async function run({
  repo = plainRepo(),
  list,
  details,
  listThrows,
  gate3 = true,
  relayGlob,
  outboxDir,
  inboxDir,
  now = NOW,
  extra = {},
} = {}) {
  const root = tmpDir("nc-g3rec-run-");
  const { fetchJson, calls } = makeFetch({ repo, list, details, listThrows });
  const options = {
    now,
    repoRoot: repo.dir,
    dispatchReceiptsPath: join(root, "none.jsonl"),
    watchLogPath: join(root, "watch.log"),
    extraRepoRoots: [],
    archiveRoot: join(root, "archive-missing"),
    fetchJson,
    git: report.createProcessGitPort(repo.dir),
    gitWorktreeListExecFn: () => "",
    ...extra,
  };
  if (gate3) options.gate3RecordBase = RECORD_BASE;
  if (relayGlob) options.relayGlob = relayGlob;
  if (outboxDir) options.outboxDir = outboxDir;
  if (inboxDir) options.inboxDir = inboxDir;
  const result = await report.runPartialCountOnce(options);
  return { result, calls, text: result.reportText, root };
}

const textLines = (text) => text.split("\n");
const g3Line = (text) =>
  textLines(text).find((l) => l.startsWith(GATE3_LINE_PREFIX));
const g3EventLines = (text) =>
  textLines(text).filter(
    (l) => l.includes("확인 사건") && l.includes("병합자"),
  );
const crossLine = (text) =>
  textLines(text).find((l) => l.includes("전달 ㄱ-3 분류"));

// ---- R1~R14 · 수집 + 렌더 (프로덕션 진입점) -----------------------------------------------------------------------------------

test("R1 확인: 기록 가지 · 모양 · 봇 작성 · 창 안 병합 · 병합자 ∈ 명단 -> «독립 확인 1건» + 확인 사건 줄(PR 번호 · 전달 번호 · 병합자 · 시각) · 호출 = 목록 1 + 상세 1", async () => {
  const { text, calls } = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const line = g3Line(text);
  assert.ok(line, "ㄱ-3 GitHub 기록 줄이 없다");
  assert.ok(
    line.includes("(한용 Merge · 기록만 · 차단 0): 독립 확인 1건"),
    line,
  );
  assert.ok(
    line.includes(
      " · 대기(열림) 0 · 무효 0(병합자 명단 밖 0 · 봇·작성자 병합 0 · 모양 위반 0) · 닫힘(미병합) 0 · 이번 회차 조회 2",
    ),
    line,
  );
  const ev = g3EventLines(text);
  assert.equal(ev.length, 1);
  assert.ok(
    ev[0].includes(`PR#101 #${NUM} 병합자 hykim82 ${IN_WINDOW_MERGED_KST}`),
    ev[0],
  );
  assert.equal(calls.g3List.length, 1);
  assert.equal(calls.g3List[0], LIST_URL, "목록 주소 = 설계 (나) 그대로");
  assert.equal(calls.g3Detail.length, 1);
});

test("R2 창 밖 병합: 창 시작보다 앞선 병합은 독립 확인이 아니고 상세 조회도 하지 않는다", async () => {
  const { text, calls } = await run({
    list: [recPr({ mergedAtMs: NOW - 30 * HOUR })],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.ok(g3Line(text).includes("독립 확인 0건"), g3Line(text));
  assert.equal(calls.g3Detail.length, 0);
});

test("R3 병합자가 명단 밖(login 다름 · login 같고 id 다름): 확인 0 · 무효 1(병합자 명단 밖 1)", async () => {
  for (const mergedBy of [
    { login: "other-human", id: 5 },
    { login: "hykim82", id: 999 },
  ]) {
    const { text } = await run({
      list: [recPr()],
      details: { 101: detailOf(101, mergedBy) },
    });
    const line = g3Line(text);
    assert.ok(line.includes("독립 확인 0건"), line);
    assert.ok(
      line.includes(
        "무효 1(병합자 명단 밖 1 · 봇·작성자 병합 0 · 모양 위반 0)",
      ),
      line,
    );
    assert.equal(g3EventLines(text).length, 0);
  }
});

test("R4 봇 병합: 병합자가 봇 목록의 다른 계정이면 확인 0 · 무효 1(봇·작성자 병합 1) -- 명단 밖으로 접지 않는다", async () => {
  const { text } = await run({
    list: [recPr({ author: BOT_A })],
    details: { 101: detailOf(101, { login: BOT_B, id: 77 }) },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(
    line.includes("무효 1(병합자 명단 밖 0 · 봇·작성자 병합 1 · 모양 위반 0)"),
    line,
  );
});

test("R5 작성자 = 병합자: 봇이 자기 PR 을 병합하면 확인 0 · 무효 1(봇·작성자 병합 1)", async () => {
  const { text } = await run({
    list: [recPr({ author: BOT_A })],
    details: { 101: detailOf(101, { login: BOT_A, id: 300438013 }) },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(
    line.includes("무효 1(병합자 명단 밖 0 · 봇·작성자 병합 1 · 모양 위반 0)"),
    line,
  );
});

test("R5b 작성자 = 병합자(이름만 바뀐 같은 계정): 병합자 login 이 달라도 id 가 작성자 id 와 같으면 «봇·작성자 병합» 이다 -- 명단 밖으로 접지 않는다", async () => {
  const { text } = await run({
    list: [recPr({ author: BOT_A })],
    details: {
      101: detailOf(101, { login: "renamed-account", id: 300438013 }),
    },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(
    line.includes("무효 1(병합자 명단 밖 0 · 봇·작성자 병합 1 · 모양 위반 0)"),
    line,
  );
});

test("R6 작성자가 봇 목록에 없다: 모양 위반 1(확인 0) · 상세 조회 0 -- 한용이 직접 연 PR 도 기록이 아니다", async () => {
  const { text, calls } = await run({
    list: [recPr({ author: "human-fixture" })],
    details: { 101: detailOf(101, HANYONG, { author: "human-fixture" }) },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(
    line.includes("무효 1(병합자 명단 밖 0 · 봇·작성자 병합 0 · 모양 위반 1)"),
    line,
  );
  assert.equal(calls.g3Detail.length, 0, "봇 아닌 작성자는 예산을 쓰지 않는다");
});

test("R7 가지 이름 불일치: head.ref 가 g3-<번호> 가 아니면 모양 위반 1(확인 0)", async () => {
  const { text } = await run({
    list: [recPr({ head: "feature/gate3-note" })],
    details: { 101: detailOf(101, HANYONG) },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(line.includes("모양 위반 1)"), line);
});

test("R8 제목 번호 불일치: 제목의 #번호 가 가지 번호와 다르면(또는 번호 뒤에 글자가 붙으면) 모양 위반 1(확인 0)", async () => {
  for (const title of [
    `${HEAD} #20261123-9999 결정 요지`,
    `${HEAD} #${NUM}a 결정 요지`,
    `${HEAD} 결정 요지(번호 없음)`,
  ]) {
    const { text } = await run({
      list: [recPr({ title })],
      details: { 101: detailOf(101, HANYONG) },
    });
    const line = g3Line(text);
    assert.ok(line.includes("독립 확인 0건"), `${title} -> ${line}`);
    assert.ok(line.includes("모양 위반 1)"), `${title} -> ${line}`);
  }
});

test("M23 고정 머리: 제목 맨 앞이 «[게이트3 승인 기록]» 이 아니면(옛 시안 «[게이트3]» · 머리 없음 · 앞에 다른 글자) 모양 위반 1(확인 0)", async () => {
  assert.equal(
    report.GATE3_RECORD_TITLE_HEAD,
    HEAD,
    "고정 머리 상수 = 판정 1905 문면",
  );
  for (const title of [
    `[게이트3] #${NUM} 결정 요지`,
    `#${NUM} 결정 요지`,
    `Re: ${HEAD} #${NUM} 결정 요지`,
  ]) {
    const { text } = await run({
      list: [recPr({ title })],
      details: { 101: detailOf(101, HANYONG) },
    });
    const line = g3Line(text);
    assert.ok(line.includes("독립 확인 0건"), `${title} -> ${line}`);
    assert.ok(line.includes("모양 위반 1)"), `${title} -> ${line}`);
  }
});

test("R9 열림: 병합 전 PR 은 «대기(열림) 1» 이고 확인이 아니다(상세 조회 0)", async () => {
  const { text, calls } = await run({ list: [openPr()] });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건 · 대기(열림) 1 ·"), line);
  assert.ok(
    line.includes("무효 0(병합자 명단 밖 0 · 봇·작성자 병합 0 · 모양 위반 0)"),
    line,
  );
  assert.ok(line.includes("이번 회차 조회 1"), "열림은 상세를 부르지 않는다");
  assert.equal(calls.g3Detail.length, 0);
  assert.equal(calls.gate4.length, 0, "상세 주소가 다른 길로 새지 않았다");
});

test("R10 닫힘(미병합): «닫힘(미병합) 1» 이고 확인이 아니다 · 무효 0", async () => {
  const { text } = await run({ list: [unmergedClosedPr()] });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건 · 대기(열림) 0 · 무효 0("), line);
  assert.ok(line.includes("닫힘(미병합) 1"), line);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(line.includes("이번 회차 조회 1"), "닫힘은 상세를 부르지 않는다");
});

test("R11 상세 조회 실패: 무효로 접지 않고 «상세 미확정 1(… 조회 실패 1)» 로 드러낸다(0 아님) · 확인 0", async () => {
  const { text } = await run({ list: [recPr()], details: { 101: ERR500 } });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(
    line.includes("무효 0(병합자 명단 밖 0 · 봇·작성자 병합 0 · 모양 위반 0)"),
    `상세 실패를 무효로 접으면 안 된다: ${line}`,
  );
  assert.ok(
    line.includes("상세 미확정 1(예산 0 · 조회 실패 1 · rate limit 0)"),
    line,
  );
});

test("R12 상세 rate limit(403): «상세 미확정 1(… rate limit 1)» · 확인 0 · 무효 0", async () => {
  const { text } = await run({ list: [recPr()], details: { 101: RATE403 } });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 0건"), line);
  assert.ok(line.includes("무효 0("), line);
  assert.ok(
    line.includes("상세 미확정 1(예산 0 · 조회 실패 0 · rate limit 1)"),
    line,
  );
});

test("R13 merged_by 없음(null · login/id 칸 없음): 모양 위반 1(확인 0)", async () => {
  for (const mergedBy of [null, { login: "hykim82" }, { id: 286230306 }]) {
    const { text } = await run({
      list: [recPr()],
      details: { 101: detailOf(101, mergedBy) },
    });
    const line = g3Line(text);
    assert.ok(line.includes("독립 확인 0건"), line);
    assert.ok(line.includes("모양 위반 1)"), line);
  }
});

test("R14 같은 번호 중복 병합: 1사건으로만 세고 중복 표지를 남긴다(둘째 PR 은 상세 조회도 하지 않는다)", async () => {
  const { text, calls } = await run({
    list: [recPr({ pr: 102 }), recPr({ pr: 101 })],
    details: {
      101: detailOf(101, HANYONG),
      102: detailOf(102, HANYONG),
    },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 1건"), line);
  assert.ok(line.includes("같은 번호 중복 병합 1(1사건으로만 셈)"), line);
  assert.equal(g3EventLines(text).length, 1);
  assert.equal(calls.g3Detail.length, 1, "상세 1회만(예산 min(2,·) 안)");
});

test("예산 안의 상세 1회: 창 안 병합이 둘이면 한 건만 상세 확인되고 나머지는 «상세 미확정(예산)» 으로 드러난다(0 아님)", async () => {
  const { text, calls } = await run({
    list: [
      recPr({ pr: 101, number: "20261123-1740" }),
      recPr({
        pr: 102,
        number: "20261123-1800",
        mergedAtMs: IN_WINDOW_MERGED - HOUR,
      }),
    ],
    details: {
      101: detailOf(101, HANYONG),
      102: detailOf(102, HANYONG, { mergedAtMs: IN_WINDOW_MERGED - HOUR }),
    },
  });
  const line = g3Line(text);
  assert.ok(line.includes("독립 확인 1건"), line);
  assert.ok(
    line.includes("상세 미확정 1(예산 1 · 조회 실패 0 · rate limit 0)"),
    line,
  );
  assert.equal(calls.g3Detail.length, 1);
  assert.ok(
    g3EventLines(text)[0].includes("PR#101"),
    "최근 병합이 먼저 상세 확인된다",
  );
});

// ---- L1~L4 목록 수준 ------------------------------------------------------------------------------------------------------

test("L1 목록 실패(HTTP 500 · 던짐 · 배열 아님): 0 이 아니라 UNKNOWN(사유) — 0 아님 · «독립 확인» 숫자 줄 0", async () => {
  const bad = [
    { list: ERR500 },
    { list: [], listThrows: true },
    { list: ok200({ message: "not an array" }) },
  ];
  for (const b of bad) {
    const { text } = await run(b);
    const line = g3Line(text);
    assert.ok(line.includes(": UNKNOWN("), line);
    assert.ok(line.endsWith(" — 0 아님"), line);
    assert.equal(line.includes("독립 확인 0건"), false, line);
  }
});

// 앞의 둘(ㄱ-4 · D1)이 이미 12 이상을 쓴 회차를 만든다 -- 기본 상한(ㄱ-4 1건)으로는 합성 체인이 12 에 못 미치므로 ㄱ-4 상한을 3 으로 올린 «시험용 부하» 다
// (프로덕션 기본값은 그대로 · 이 회차는 «예산 0 -> 호출 0» 만 본다).
const HEAVY_EXTRA = { maxMergeChecks: 3 };

test("L2 예산 0: 앞의 둘(ㄱ-4 · D1)이 12 이상을 썼으면 S4 목록 호출 0 · P3 도 0 · «미조회(예산 · 0 아님)»", async () => {
  const repo = buildRepo([2, 2, 1]);
  const { text, calls } = await run({
    repo,
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
    extra: HEAVY_EXTRA,
  });
  assert.ok(
    calls.gate4.length + calls.d1.length >= 12,
    `앞의 둘이 12 이상을 써야 이 칸이 성립한다: ${calls.gate4.length + calls.d1.length}`,
  );
  assert.equal(calls.g3List.length, 0, "예산 0 이면 목록도 부르지 않는다");
  assert.equal(calls.g3Detail.length, 0);
  assert.equal(calls.p3.length, 0, "P3 도 같은 산술로 0");
  assert.ok(g3Line(text).includes(": 미조회(예산 · 0 아님)"), g3Line(text));
});

test("L3 목록이 100건 꽉 참: 잘렸을 수 있어 UNKNOWN(목록 잘림) — 0 아님 · 확인 숫자를 내지 않는다", async () => {
  const full = Array.from({ length: 100 }, (_, i) =>
    unmergedClosedPr({ pr: 1000 + i, number: `20261101-${String(1000 + i)}` }),
  );
  const { text } = await run({ list: full });
  const line = g3Line(text);
  assert.ok(line.includes(": UNKNOWN("), line);
  assert.ok(line.includes("100건"), line);
  assert.equal(line.includes("독립 확인 0건"), false, line);
});

test("L4 명단 · 봇 목록을 못 읽음: UNKNOWN(사유) — 0 아님 · 목록 호출 0(읽기 전에 멈춘다)", async () => {
  for (const repoOpts of [{ allowlist: false }, { bots: false }]) {
    const repo = buildRepo([], repoOpts);
    const { text, calls } = await run({
      repo,
      list: [recPr()],
      details: { 101: detailOf(101, HANYONG) },
    });
    const line = g3Line(text);
    assert.ok(line.includes(": UNKNOWN("), line);
    assert.ok(line.endsWith(" — 0 아님"), line);
    assert.equal(calls.g3List.length, 0, "명단 없이 목록을 부르지 않는다");
  }
});

// ---- C1 · C2 전달 교차(자기 분류 · 독립 아님) ------------------------------------------------------------------------------------

function relayHeader({ number, timeKst, cls = "ㄱ-3" }) {
  return `[책임자 경유 · 한용 확정 · #${number} · ${timeKst} KST · 지시 · ${cls}]\n> 한용: «합성 결정 문장입니다»\n\n`;
}

test("C1 전달 교차: 창 안 ㄱ-3 전달 d 건 중 기록 짝 m · 짝 없음 d-m · 전달 없는 기록 e (ㄱ-3 아닌 분류 · 창 밖 전달은 d 에서 빠진다)", async () => {
  const dir = tmpDir("nc-g3rec-relay-");
  fs.writeFileSync(
    join(dir, "전달-2026-11-24.md"),
    relayHeader({ number: NUM, timeKst: "2026-11-24 10:00" }) + // 짝 있음
      relayHeader({ number: "20261123-1800", timeKst: "2026-11-24 09:00" }) + // 짝 없음
      relayHeader({
        number: "20261123-1830",
        timeKst: "2026-11-24 09:30",
        cls: "ㄴ",
      }) + // ㄱ-3 아님
      relayHeader({ number: "20261110-1000", timeKst: "2026-11-10 10:00" }), // 창 밖
    "utf8",
  );
  const { text } = await run({
    list: [
      recPr({ pr: 101, number: NUM }),
      recPr({
        pr: 103,
        number: "20261123-1900",
        mergedAtMs: IN_WINDOW_MERGED - 2 * HOUR,
      }), // 전달 없는 기록
    ],
    details: { 101: detailOf(101, HANYONG) },
    relayGlob: join(dir, "전달-*.md"),
  });
  const cross = crossLine(text);
  assert.ok(cross, "교차 줄이 없다");
  assert.ok(cross.includes("전달 ㄱ-3 분류(자기 분류 · 독립 아님)"), cross);
  assert.ok(
    cross.includes("2건 중 기록 짝 1 · 짝 없음 1 · 전달 없는 기록 1"),
    cross,
  );
  assert.ok(
    g3Line(text).includes("독립 확인 1건"),
    "교차는 독립 확인 수를 바꾸지 않는다",
  );
});

test("C1b 전달 폴더를 못 읽음: 교차 칸만 UNKNOWN(사유) — 0 아님 · 독립 확인 줄은 그대로", async () => {
  const { text } = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
    relayGlob: join(tmpdir(), "nc-g3rec-no-such-dir-zzz", "전달-*.md"),
  });
  const cross = crossLine(text);
  assert.ok(cross.includes("UNKNOWN("), cross);
  assert.ok(cross.endsWith("— 0 아님"), cross);
  assert.ok(g3Line(text).includes("독립 확인 1건"));
});

test("C2 --relay-glob 없음: 교차 미결선 한 줄(0 으로 접지 않는다)", async () => {
  const { text } = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const cross = crossLine(text);
  assert.ok(cross.includes("교차 미결선"), cross);
  assert.equal(/\d+건 중 기록 짝/.test(cross), false, cross);
});

// ---- opt-in · 위치 · 무접촉 · 차단 0 ----------------------------------------------------------------------------------------------

test("M21 opt-in: gate3RecordBase 를 안 주는 호출자는 새 줄 0개 · 기록 목록 호출 0 · 건강 행 0 · 결과에 gate3Record 없음(null)", async () => {
  const { text, calls, result } = await run({
    gate3: false,
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(text.includes("ㄱ-3 GitHub 기록"), false);
  assert.equal(text.includes("ㄱ-3기록수집기"), false);
  assert.equal(calls.g3List.length, 0);
  assert.equal(calls.g3Detail.length, 0);
  assert.equal(result.gate3Record ?? null, null);
});

test("위치 · 커버리지 무변(G4 ⓐ): ㄱ-3 줄은 ㄱ-4 블록 뒤 · 보조 관측 앞 · 커버리지 두 줄은 한 글자도 안 바뀐다 · 독립 확인이 있어도 ㄱ-4 확인 수 · 커버리지 분자에 더하지 않는다", async () => {
  const withG3 = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const without = await run({ gate3: false });
  const idx = (t, needle) => textLines(t).findIndex((l) => l.includes(needle));
  const iG3 = idx(withG3.text, GATE3_LINE_PREFIX);
  const iCand = idx(withG3.text, "ㄱ-4 후보 병합");
  const iAux = idx(withG3.text, "ORCH-writeable 보조 관측:");
  assert.ok(
    iCand >= 0 && iAux >= 0 && iG3 > iCand && iG3 < iAux,
    `${iCand} ${iG3} ${iAux}`,
  );
  // 커버리지 두 줄 + ㄱ-4 확인 수 줄은 gate3 켬/끔이 같다.
  for (const needle of [
    "독립 앵커 유형 커버리지:",
    "미커버 ㄱ 유형:",
    "외부 독립 앵커로 확인:",
  ]) {
    const a = textLines(withG3.text).find((l) => l.includes(needle));
    const b = textLines(without.text).find((l) => l.includes(needle));
    assert.ok(a && a === b, `${needle}: ${a} vs ${b}`);
  }
  assert.ok(withG3.text.includes("독립 앵커 유형 커버리지: 1/6"));
  assert.ok(withG3.text.includes("외부 독립 앵커로 확인: 0건"));
});

test("M20 게이트 1 · 7 무접촉: 보조 관측 줄(ㄱ-1 · ㄱ-2 · ㄱ-6 · ㄱ-7)은 gate3 켬/끔이 같다", async () => {
  const outboxDir = tmpDir("nc-g3rec-outbox-");
  const inboxDir = tmpDir("nc-g3rec-inbox-");
  const auxOf = async (gate3) => {
    const r = await run({
      gate3,
      list: [recPr()],
      details: { 101: detailOf(101, HANYONG) },
      outboxDir,
      inboxDir,
    });
    return textLines(r.text).find((l) =>
      l.startsWith("- 보조 관측(독립 아님):"),
    );
  };
  const on = await auxOf(true);
  const off = await auxOf(false);
  assert.ok(on, "보조 관측 줄이 없다(공허)");
  assert.equal(on, off);
});

test("M13 일별 끊김 사유 무접촉: 독립 확인 · UNKNOWN · 미조회 어느 쪽이든 dailyTick(수집기 실패 이름 · 확인 사건 식별자 포함)이 gate3 끔과 같다 · 건강 행은 항상 OK", async () => {
  const off = (await run({ gate3: false })).result.dailyTick;
  const cases = [
    { list: [recPr()], details: { 101: detailOf(101, HANYONG) } }, // 확인
    { list: ERR500 }, // UNKNOWN
    { list: ok200([]), repo: buildRepo([2, 2, 1]), extra: HEAVY_EXTRA }, // 미조회(예산) -- 아래서 따로 비교
  ];
  for (const c of cases.slice(0, 2)) {
    const { result, text } = await run(c);
    assert.deepEqual(result.dailyTick, off);
    assert.equal(
      result.dailyTick.collectorFails.includes("ㄱ-3기록수집기"),
      false,
    );
    assert.ok(text.includes("ㄱ-3기록수집기 OK("), "건강 행은 있고 OK");
  }
  // 예산 0 회차: gate3 끔과 같은 repo 로 비교.
  const heavy = buildRepo([2, 2, 1]);
  const heavyOff = (
    await run({ repo: heavy, gate3: false, extra: HEAVY_EXTRA })
  ).result.dailyTick;
  const heavyRun = await run({ ...cases[2], repo: heavy });
  assert.ok(
    g3Line(heavyRun.text).includes("미조회(예산"),
    "미조회 회차가 성립",
  );
  assert.deepEqual(heavyRun.result.dailyTick, heavyOff);
});

test("M14 차단 0: 기록이 없어도(전달 ㄱ-3 만 있고 PR 0 · 목록 실패 · 던지는 fetch) 예외 · 새 파일 · 받는함 통지 0 -- 보고 줄만 달라진다", async () => {
  const relayDir = tmpDir("nc-g3rec-relay2-");
  fs.writeFileSync(
    join(relayDir, "전달-2026-11-24.md"),
    relayHeader({ number: NUM, timeKst: "2026-11-24 10:00" }),
    "utf8",
  );
  const outboxDir = tmpDir("nc-g3rec-outbox2-");
  const inboxDir = tmpDir("nc-g3rec-inbox2-");
  const snap = (d) => fs.readdirSync(d).sort().join("|");
  const before = [relayDir, outboxDir, inboxDir].map(snap);
  const scenarios = [
    { list: [] },
    { list: ERR500 },
    { list: [], listThrows: true },
  ];
  for (const s of scenarios) {
    const { text, result } = await run({
      ...s,
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.ok(text.startsWith("집계 성격: PARTIAL"), "보고는 정상 생성");
    assert.ok(result.dailyTick, "일별 값도 정상");
  }
  assert.deepEqual(
    [relayDir, outboxDir, inboxDir].map(snap),
    before,
    "새 파일 0",
  );
  // 짝 없는 전달은 «짝 없음 1» 로만 보인다(아무것도 막지 않는다).
  const { text } = await run({
    list: [],
    relayGlob: join(relayDir, "전달-*.md"),
  });
  assert.ok(
    crossLine(text).includes("1건 중 기록 짝 0 · 짝 없음 1 · 전달 없는 기록 0"),
  );
});

test("M14b 차단 0 정적 고정: 새 수집기 · 렌더 소스는 종료 코드 · 파일 쓰기 · 통지 호출을 갖지 않는다(그 칸의 소스 조각만 검사)", () => {
  const reportSrc = fs.readFileSync(
    fileURLToPath(new URL("./partial-count-report.mjs", import.meta.url)),
    "utf8",
  );
  const a = reportSrc.indexOf("export async function collectGate3Record(");
  const b = reportSrc.indexOf("async function collectGate3RecordSafely(");
  assert.ok(a >= 0 && b > a, "collectGate3Record 소스를 찾지 못했다");
  const end = reportSrc.indexOf("\n}\n", b);
  const piece = reportSrc.slice(a, end);
  for (const banned of [
    "process.exit",
    "process.exitCode",
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "notify",
    "throw ",
  ]) {
    assert.equal(piece.includes(banned), false, `새 수집기에 ${banned}`);
  }
  const coreSrc = fs.readFileSync(
    fileURLToPath(new URL("./partial-count-core.mjs", import.meta.url)),
    "utf8",
  );
  const c = coreSrc.indexOf("export function renderGate3RecordLines(");
  assert.ok(c >= 0);
  const renderPiece = coreSrc.slice(c, coreSrc.indexOf("\n}\n", c));
  for (const banned of ["process.exit", "writeFileSync", "notify", "throw "]) {
    assert.equal(renderPiece.includes(banned), false, `새 렌더에 ${banned}`);
  }
});

test("양성 캐시 0: 확인이 있는 회차 뒤에도 감시 폴더 · 저장소에 새 파일이 생기지 않는다 · 두 번째 회차는 처음부터 다시 읽는다(호출 수 같음)", async () => {
  const repo = plainRepo();
  const before = fs.readdirSync(repo.dir).sort().join("|");
  const first = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const second = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(fs.readdirSync(repo.dir).sort().join("|"), before);
  assert.equal(first.calls.g3Detail.length, 1);
  assert.equal(
    second.calls.g3Detail.length,
    1,
    "캐시가 없으니 상세를 다시 읽는다",
  );
  assert.equal(g3Line(first.text), g3Line(second.text));
});

// ---- 천장 12 · 시간당 48 (M10 · M11) -----------------------------------------------------------------------------------------

test("M10/M11 천장: S4 몫 = P3 뒤 남는 몫 min(2, 12 - 앞 사용) -- 앞의 셋이 11 을 썼으면 목록만(상세 0) · 어느 조합에서도 회차 총 ≤ 12 · 시간당 ≤ 48", async () => {
  const repo = buildRepo([2, 2, 1]);
  // 앞(ㄱ-4 + D1 + P3)이 이 회차에 쓰는 호출 수를 gate3 끔으로 재고(합성 repo 고정), D1 상한을 조절해 «앞 = 11» 을 만든다.
  const base = await run({ repo, gate3: false });
  const g4 = base.calls.gate4.length;
  assert.ok(g4 >= 1 && g4 <= DEFAULT_CALL_BUDGET, `ㄱ-4 호출 ${g4}`);
  // 앞 = g4 + d1 + p3 = 11 이 되도록 d1 상한 d 를 고른다: p3 = min(2, 12 - g4 - d).
  const pick = [0, 1, 2, 3, 4].find(
    (d) => g4 + d + Math.min(2, 12 - g4 - d) === 11,
  );
  assert.ok(pick !== undefined, "앞 = 11 을 만드는 D1 상한이 없다");
  const run11 = await run({
    repo,
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
    extra: { maxExternalEvidenceChecks: pick },
  });
  assert.equal(run11.calls.g3List.length, 1, "남는 몫 1 = 목록 1");
  assert.equal(run11.calls.g3Detail.length, 0, "상세는 못 부른다");
  assert.ok(
    g3Line(run11.text).includes(
      "상세 미확정 1(예산 1 · 조회 실패 0 · rate limit 0)",
    ),
    g3Line(run11.text),
  );
  assert.ok(run11.calls.all.length <= 12, `총 ${run11.calls.all.length}`);
  assert.ok(run11.calls.all.length * 4 <= 48);
  // 앞이 가벼운 회차(ㄱ-4 후보 0): 목록 1 + 상세 1 = 2 · 총 ≤ 12.
  const light = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  assert.equal(light.calls.g3List.length + light.calls.g3Detail.length, 2);
  assert.ok(light.calls.all.length <= 12);
  assert.ok(light.calls.all.length * 4 <= 48);
});

test("P3 몫 무변: 기록 수집을 켜도 P3(GitHub 사람 손) 목록 호출 수 · 순서는 켜지 않았을 때와 같다 -- S4 가 P3 몫을 빼앗지 않는다", async () => {
  const on = await run({
    list: [recPr()],
    details: { 101: detailOf(101, HANYONG) },
  });
  const off = await run({ gate3: false });
  assert.equal(on.calls.p3.length, 2);
  assert.deepEqual(on.calls.p3, off.calls.p3);
});

// ---- core 렌더 단독(입력 -> 줄) ------------------------------------------------------------------------------------------------

test("M7/M8 core 렌더: 미조회 · UNKNOWN 은 «독립 확인 0건» 으로 접히지 않는다 · null 입력은 줄 0개", () => {
  assert.deepEqual(core.renderGate3RecordLines(undefined), []);
  assert.deepEqual(core.renderGate3RecordLines(null), []);
  const unchecked = core.renderGate3RecordLines({
    known: false,
    unchecked: true,
    reason: "예산",
  });
  assert.deepEqual(unchecked, ["- ㄱ-3 GitHub 기록: 미조회(예산 · 0 아님)"]);
  const unknown = core.renderGate3RecordLines({
    known: false,
    reason: "기록 PR 목록 HTTP 500",
  });
  assert.deepEqual(unknown, [
    "- ㄱ-3 GitHub 기록: UNKNOWN(기록 PR 목록 HTTP 500) — 0 아님",
  ]);
  for (const l of [...unchecked, ...unknown]) {
    assert.equal(l.includes("독립 확인"), false, l);
  }
});

test("M12 core 렌더: 독립 확인이 있어도 buildPartialCountReport 의 커버리지 줄은 1/6 그대로이고 «외부 독립 앵커로 확인» 은 ㄱ-4 값만 센다", () => {
  const text = core.buildPartialCountReport({
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
    gate3Record: {
      known: true,
      confirmed: 3,
      events: [],
      open: 0,
      invalidNotAllowlisted: 0,
      invalidBotOrAuthor: 0,
      invalidShape: 0,
      closedUnmerged: 0,
      duplicates: 0,
      unresolved: { budget: 0, failed: 0, rateLimited: 0 },
      calls: 2,
      relayCross: { wired: false },
    },
  });
  assert.ok(text.includes("독립 앵커 유형 커버리지: 1/6"));
  assert.ok(text.includes("외부 독립 앵커로 확인: 0건"));
  assert.ok(text.includes("독립 확인 3건"));
});

// ---- 렌더 표본 3종 + 0줄(완료 조건 3) · watch-run 인자 · CLI 인자 ------------------------------------------------------------

test("표본: 확인 1 · 미조회 1 · UNKNOWN 1 · 인자 없음 0줄 (결과 파일에 옮길 렌더 표본)", async () => {
  const samples = {
    확인: g3Line(
      (await run({ list: [recPr()], details: { 101: detailOf(101, HANYONG) } }))
        .text,
    ),
    미조회: g3Line(
      (await run({ repo: buildRepo([2, 2, 1]), list: [], extra: HEAVY_EXTRA }))
        .text,
    ),
    UNKNOWN: g3Line((await run({ list: ERR500 })).text),
    인자없음: g3Line((await run({ gate3: false })).text),
  };
  assert.ok(samples.확인.includes("독립 확인 1건"));
  assert.ok(samples.미조회.includes("미조회(예산 · 0 아님)"));
  assert.ok(samples.UNKNOWN.includes("UNKNOWN("));
  assert.equal(samples.인자없음, undefined);
  console.log(`# SAMPLE ${JSON.stringify(samples)}`);
});

test("watch-run 인자 전달: --gate3-record-base 값이 runPartialCountStep 옵션까지 간다 · 안 주면 키 자체가 없다(옛 deepEqual 보존) · 값 없는 플래그도 무해", async () => {
  const seen = [];
  const stepFn = async ({ options }) => {
    seen.push(options);
    return { ran: true, ok: true };
  };
  const args = {
    repoRoot: "/repo",
    watchDir: "/repo/watch",
    now: 1000,
    result: { logPath: "/repo/watch/watch.log" },
    runPartialCountStepFn: stepFn,
  };
  await runWatchCliPartialCountStep({
    ...args,
    argv: ["--gate3-record-base", "gate3-record", "--outbox-dir", "/o"],
  });
  await runWatchCliPartialCountStep({ ...args, argv: ["--outbox-dir", "/o"] });
  assert.equal(seen[0].gate3RecordBase, "gate3-record");
  assert.equal(seen[0].outboxDir, "/o");
  assert.equal(Object.hasOwn(seen[1], "gate3RecordBase"), false);
  assert.deepEqual(
    buildPartialCountStepOptions({
      repoRoot: "/r",
      watchLogPath: "/w",
      outboxDir: null,
      relayGlob: null,
      inboxDir: null,
    }),
    {
      repoRoot: "/r",
      watchLogPath: "/w",
      outboxDir: null,
      relayGlob: null,
      inboxDir: null,
    },
  );
  assert.equal(
    buildPartialCountStepOptions({
      repoRoot: "/r",
      watchLogPath: "/w",
      gate3RecordBase: "gate3-record",
    }).gate3RecordBase,
    "gate3-record",
  );
});

test("CLI 인자: parseCliArgs 가 --gate3-record-base 를 opts.gate3RecordBase 로 읽는다 · 안 주면 키 없음 · 기본 상수 = gate3-record", () => {
  assert.equal(report.GATE3_RECORD_BASE, RECORD_BASE);
  assert.equal(
    report.parseCliArgs(["--gate3-record-base", "gate3-record"])
      .gate3RecordBase,
    "gate3-record",
  );
  assert.equal(
    Object.hasOwn(
      report.parseCliArgs(["--window-hours", "24"]),
      "gate3RecordBase",
    ),
    false,
  );
});

// ---- TZ=UTC 자식 프로세스(ⓔ · ⓙ) ------------------------------------------------------------------------------------------------

test("TZ 무관: 자식 프로세스(env 에 TZ 만 다르게 · 시각은 인자로 고정)에서 같은 입력의 ㄱ-3 줄이 TZ=UTC · Asia/Seoul · America/New_York 에서 한 글자도 다르지 않다", () => {
  const coreUrl = pathToFileURL(
    fileURLToPath(new URL("./partial-count-core.mjs", import.meta.url)),
  ).href;
  const script = `
    const core = await import(${JSON.stringify(coreUrl)});
    const mergedAtMs = Number(process.argv[1]);
    const lines = core.renderGate3RecordLines({
      known: true, confirmed: 1,
      events: [{ number: "${NUM}", pullNumber: 101, mergedBy: "hykim82", mergedAtMs }],
      open: 0, invalidNotAllowlisted: 0, invalidBotOrAuthor: 0, invalidShape: 0,
      closedUnmerged: 0, duplicates: 0,
      unresolved: { budget: 0, failed: 0, rateLimited: 0 }, calls: 2,
      relayCross: { wired: false },
    });
    console.log(JSON.stringify(lines));
  `;
  const outs = ["UTC", "Asia/Seoul", "America/New_York"].map((tz) =>
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, String(IN_WINDOW_MERGED)],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", TZ: tz },
      },
    ).trim(),
  );
  assert.equal(outs[0], outs[1]);
  assert.equal(outs[0], outs[2]);
  assert.ok(
    outs[0].includes(`PR#101 #${NUM} 병합자 hykim82 ${IN_WINDOW_MERGED_KST}`),
    outs[0],
  );
});
