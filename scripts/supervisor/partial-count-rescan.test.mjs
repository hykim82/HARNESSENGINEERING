// HYK-255-rescan-wire-1 (판정 #20261120-1424 3 레인 1 · #20261120-1519 · #20261120-2346 · PM 설계 (마) R2) -- 전수 재조회 CLI 계약 시험.
//
// ⛔헛시험 금지: 프로덕션 진입점 runRescanOnce(CLI 가 부르는 바로 그 함수)를 «합성 GitHub seam»(fetchJson 주입 · 주소별 응답표)과
// «합성 git 포트»(명령별 출력표)로 실제 구동하고, 기대 줄 · 수는 아래 응답표를 시험이 «손으로 센 값»으로 적는다(같은 함수로 기대값을 만들지 않는다).
// 출력 줄 «전체» 동등 단언은 «줄 형식 고정» 칸에서만 · 그 밖은 자기 토막만.
// ⛔실제 GitHub · 실제 .harness · 실제 watch 폴더 · 실제 봇 PAT 파일 접촉 0 -- 망은 전부 주입이고(전역 fetch 는 이 파일이 던지게 막는다), 파일은
// mkdtemp 안 합성 상태 · 보고 파일뿐이다.
// 실행 환경 무관: 시각은 전부 +09:00 문자열 · epoch 로 만들고 로컬 시각 생성자 · 접근자 · 로캘 서식을 쓰지 않는다. 자식 프로세스 칸(CLI 스폰 · TZ 대조)은
// 시계를 주입하는 길(nowMs)로 맞추거나(TZ 대조) 시계와 무관한 갈래(인자 거부 · 먼 미래 창)만 쓴다.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RESCAN_CLI_FLAGS,
  defaultRescanIo,
  main,
  parseRescanArgs,
  runRescanOnce,
  writeTextAtomic,
} from "./partial-count-rescan.mjs";
import {
  RESCAN_EXIT,
  acceptRescanState,
  buildRescanFingerprint,
  computeRescanWindow,
  createRescanState,
  recordRescanRun,
} from "./partial-count-rescan-core.mjs";

// 이 파일 안 어떤 코드도 실제 망을 부르지 못하게 막는다(주입 seam 이 아닌 전역 fetch 로 새면 시험이 빨개진다).
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("합성 시험에서 실제 망 호출 금지");
};
after(() => {
  globalThis.fetch = realFetch;
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "partial-count-rescan.mjs");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const kst = (s) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);
const isoOf = (ms) => new Date(ms).toISOString();
const iso = (s) => isoOf(kst(s));
const W = computeRescanWindow({ fromDay: "2026-11-14", days: 7 });
const RUN1_NOW = kst("2026-11-21 10:00");
const RUN2_NOW = kst("2026-11-21 13:00");
const RUN3_NOW = kst("2026-11-21 15:00");

const REPO = "owner-fixture/repo-fixture";
const API = `https://api.github.com/repos/${REPO}`;
const BOT = "bot-fixture-a";
const HUMAN = "human-fixture";
const APPROVER = "approver-fixture";
const BOT_PATH = "scripts/supervisor/github-bot-accounts.json";
const ALLOW_PATH = "scripts/supervisor/approver-allowlist.json";
const BOT_BLOB = "c".repeat(40);
const MASTER_SHA = "d".repeat(40);
const D1_SHA = "e".repeat(40);
const SINCE = "2026-11-13T15:00:00.000Z"; // 창 시작 2026-11-14 00:00 KST (손으로 환산)
const WINDOW_LINE = "2026-11-14 00:00 KST ~ 2026-11-21 00:00 KST";

// ---- 합성 GitHub 응답표 -------------------------------------------------------------------------------------------------

const prItem = (
  number,
  { state, mergedAt = null, closedAt = null, updatedAt },
) => ({
  id: number * 1000,
  number,
  state,
  merged_at: mergedAt === null ? null : iso(mergedAt),
  closed_at: closedAt === null ? null : iso(closedAt),
  updated_at: iso(updatedAt),
  user: { login: "author-fixture" },
});
const review = (id, state, at, login = HUMAN) => ({
  id,
  state,
  submitted_at: iso(at),
  user: { login },
});
const commentAtMs = (id, ms, urlField, login = HUMAN) => ({
  id,
  created_at: isoOf(ms),
  user: { login },
  [urlField]: "https://example.invalid/x",
});
const relLinks = (pairs) =>
  pairs.map(([url, rel]) => `<${url}>; rel="${rel}"`).join(", ");

// 주소 -- CLI 가 부르는 주소 모양을 시험이 «손으로» 적는다.
const U = {
  prList: (k) =>
    `${API}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${k}`,
  reviews: (n, k) => `${API}/pulls/${n}/reviews?per_page=100&page=${k}`,
  issue: (k) =>
    `${API}/issues/comments?since=${SINCE}&sort=created&direction=desc&per_page=100&page=${k}`,
  reviewComments: (k) =>
    `${API}/pulls/comments?since=${SINCE}&sort=created&direction=desc&per_page=100&page=${k}`,
  commit: `${API}/commits/${D1_SHA}`,
};

// PR 목록 한 쪽(6건 미만 = 더 없음) -- 열림 13 · 미병합 닫기 12 · 병합 11 · 창 밖 14.
const PR_LIST = [
  prItem(13, { state: "open", updatedAt: "2026-11-20 09:00" }),
  prItem(12, {
    state: "closed",
    closedAt: "2026-11-17 09:00",
    updatedAt: "2026-11-17 09:00",
  }),
  prItem(11, {
    state: "closed",
    mergedAt: "2026-11-16 12:00",
    closedAt: "2026-11-16 12:00",
    updatedAt: "2026-11-16 12:00",
  }),
  prItem(14, {
    state: "closed",
    closedAt: "2026-11-10 09:00",
    updatedAt: "2026-11-10 09:00",
  }),
];
const REVIEWS_11 = [
  review(503, "APPROVED", "2026-11-16 11:00"),
  review(502, "CHANGES_REQUESTED", "2026-11-16 10:30", BOT),
];
const FILLER_REVIEWS = Array.from({ length: 99 }, (_, i) =>
  review(9001 + i, "COMMENTED", "2026-11-18 11:00"),
);
const reviews13Page1 = (state504) => [
  review(504, state504, "2026-11-18 10:00"),
  ...FILLER_REVIEWS,
];
const REVIEWS_13_PAGE2 = [review(9100, "COMMENTED", "2026-11-18 12:00")];
const REVIEWS_15 = [review(601, "DISMISSED", "2026-11-19 10:00")];

// 대화 댓글 101건(2쪽) -- 7001(창 끝 뒤) · 7050(봇) · 나머지 99 가 센다. 내림차순.
const ISSUE_BASE_MS = kst("2026-11-20 12:00");
const ISSUE_PAGE1 = Array.from({ length: 100 }, (_, i) => {
  const id = 7001 + i;
  if (i === 0) return commentAtMs(id, kst("2026-11-21 03:00"), "issue_url");
  return commentAtMs(
    id,
    ISSUE_BASE_MS - i * MIN,
    "issue_url",
    id === 7050 ? BOT : HUMAN,
  );
});
const ISSUE_PAGE2 = [commentAtMs(7101, kst("2026-11-14 01:00"), "issue_url")];
const REVIEW_COMMENT_PAGE1 = [
  commentAtMs(8001, kst("2026-11-19 10:00"), "pull_request_url"),
  commentAtMs(8002, kst("2026-11-18 10:00"), "pull_request_url", BOT),
  commentAtMs(8003, kst("2026-11-15 10:00"), "pull_request_url"),
];
const D1_COMMIT = {
  sha: D1_SHA,
  commit: { verification: { verified: true, reason: "valid" } },
  committer: { login: "web-flow" },
  author: { login: APPROVER, id: 424242 },
};

const okResp = (json, linkHeader = null) => ({
  ok: true,
  status: 200,
  json,
  linkHeader,
});
const failResp = (status) => ({
  ok: false,
  status,
  json: null,
  linkHeader: null,
});

// 세계 한 벌 = {responses: {주소: 응답}, git: [[명령 접두, 출력]]} -- 순수 데이터(자식 프로세스에도 그대로 넘긴다).
function buildWorld({ blob = BOT_BLOB, state504 = "CHANGES_REQUESTED" } = {}) {
  const responses = {
    [U.prList(1)]: okResp(PR_LIST),
    [U.reviews(11, 1)]: okResp(REVIEWS_11),
    [U.reviews(12, 1)]: okResp([]),
    [U.reviews(13, 1)]: okResp(
      reviews13Page1(state504),
      relLinks([
        [U.reviews(13, 2), "next"],
        [U.reviews(13, 2), "last"],
      ]),
    ),
    [U.reviews(13, 2)]: okResp(
      REVIEWS_13_PAGE2,
      relLinks([
        [U.reviews(13, 1), "prev"],
        [U.reviews(13, 1), "first"],
      ]),
    ),
    [U.reviews(15, 1)]: okResp(REVIEWS_15),
    [U.issue(1)]: okResp(
      ISSUE_PAGE1,
      relLinks([
        [U.issue(2), "next"],
        [U.issue(2), "last"],
      ]),
    ),
    [U.issue(2)]: okResp(ISSUE_PAGE2),
    [U.reviewComments(1)]: okResp(REVIEW_COMMENT_PAGE1),
    [U.commit]: okResp(D1_COMMIT),
  };
  const out = (stdout) => ({ code: 0, stdout, stderr: "" });
  const sep = "\x1f";
  const mergeLines = [
    `${"1".repeat(40)}${sep}2026-11-16T12:00:00+09:00${sep}Merge pull request #11 from owner-fixture/branch-a`,
    `${"2".repeat(40)}${sep}2026-11-19T10:00:00+09:00${sep}Merge pull request #15 from owner-fixture/branch-b`,
    `${"3".repeat(40)}${sep}2026-11-10T09:00:00+09:00${sep}Merge pull request #14 from owner-fixture/branch-c`,
    `${"4".repeat(40)}${sep}2026-11-18T09:00:00+09:00${sep}Merge branch 'master' into branch-d`,
  ].join("\n");
  const candidateLines = [
    `${D1_SHA}${sep}2026-11-19T12:00:00+09:00${sep}${"5".repeat(40)} ${"6".repeat(40)}${sep}GitHub${sep}noreply@github.com${sep}Merge branch 'master' into topic`,
    `${"7".repeat(40)}${sep}2026-11-19T13:00:00+09:00${sep}${"5".repeat(40)} ${"6".repeat(40)}${sep}Someone${sep}someone@example.invalid${sep}Merge branch 'master' into topic`,
  ].join("\n");
  const git = [
    [
      "remote get-url origin",
      out("https://github.com/owner-fixture/repo-fixture"),
    ],
    [`rev-parse origin/master:${BOT_PATH}`, out(blob)],
    [
      `cat-file blob origin/master:${BOT_PATH}`,
      out(
        JSON.stringify({
          schema_version: "github-bot-accounts/v1",
          bots: [{ login: BOT }],
        }),
      ),
    ],
    ["rev-parse origin/master", out(MASTER_SHA)],
    [
      `cat-file blob origin/master:${ALLOW_PATH}`,
      out(
        JSON.stringify({
          schema_version: "approver-allowlist/v1",
          repo: REPO,
          approvers: [{ login: APPROVER, id: 424242 }],
        }),
      ),
    ],
    ["log --first-parent --merges", out(mergeLines)],
    ["log --merges", out(candidateLines)],
  ];
  return { responses, git };
}

// seam -- 자기완결 함수(자식 프로세스 스크립트에 소스째 실어 보낸다). log 에 부른 주소 · git 명령 · 응답표에 없는 주소를 남긴다.
function makeSeam(world, log) {
  const fetchJson = async ({ url }) => {
    log.urls.push(url);
    const hit = world.responses[url];
    if (hit === undefined) {
      log.unexpected.push(url);
      return { ok: false, status: 404, json: null, linkHeader: null };
    }
    return JSON.parse(JSON.stringify(hit));
  };
  const git = {
    run(args) {
      const key = args.join(" ");
      log.git.push(key);
      const hit = world.git.find(([prefix]) => key.startsWith(prefix));
      return hit
        ? JSON.parse(JSON.stringify(hit[1]))
        : { code: 128, stdout: "", stderr: "fatal: 합성 git 에 없는 명령" };
    },
  };
  return { fetchJson, git };
}
const newLog = () => ({ urls: [], unexpected: [], git: [] });

// ---- 임시 폴더 · 입출력 감시 ------------------------------------------------------------------------------------------------

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescan-wire-"));
  const finish = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    finish();
    throw err;
  }
  return Promise.resolve(result).finally(finish);
}

function spyIo(overrides = {}) {
  const ops = [];
  const io = {
    ...defaultRescanIo,
    writeFileSync: (file, text, enc) => {
      ops.push({ op: "write", file });
      return (overrides.writeFileSync ?? fs.writeFileSync)(file, text, enc);
    },
    renameSync: (from, to) => {
      ops.push({ op: "rename", from, to });
      return (overrides.renameSync ?? fs.renameSync)(from, to);
    },
    mkdirSync: (dir, opts) => {
      ops.push({ op: "mkdir", dir });
      return fs.mkdirSync(dir, opts);
    },
    unlinkSync: (file) => {
      ops.push({ op: "unlink", file });
      return fs.unlinkSync(file);
    },
  };
  return { io, ops };
}
const writeOps = (ops) => ops.filter((o) => o.op !== "mkdir");

function paths(dir) {
  return {
    statePath: path.join(dir, "rescan", "state.json"),
    reportOut: path.join(dir, "rescan", "report.md"),
  };
}

// 실행 한 번 -- 프로덕션 진입점 runRescanOnce 를 합성 seam 으로 구동.
async function runOnce({ dir, world, nowMs, log = newLog(), io, ...extra }) {
  const seam = makeSeam(world, log);
  const result = await runRescanOnce({
    fromDay: "2026-11-14",
    days: 7,
    ...paths(dir),
    nowMs,
    fetchJson: seam.fetchJson,
    git: seam.git,
    ...(io === undefined ? {} : { io }),
    ...extra,
  });
  return { result, log };
}
const readState = (dir) =>
  JSON.parse(fs.readFileSync(paths(dir).statePath, "utf8"));
const lastLine = (result) => result.lines[result.lines.length - 1];

// ---- ⓐ 합성 seam 2회차 완주 -- 줄 형식 고정 --------------------------------------------------------------------------

test("ⓐ 실행 1(--max-calls 4) = 미완 · exit 3 · «미완 — 남은 미조회 U» / 실행 2 = 완료 · exit 0 · «변경 요청 1» · «완료 — 남은 미조회 0» -- 줄 형식 고정(손으로 센 값)", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const { result: r1, log: log1 } = await runOnce({
      dir,
      world,
      nowMs: RUN1_NOW,
      maxCalls: 4,
    });
    // 실행 1: 호출 4 = PR 쓸기 1 + 리뷰 11 · 12 · 13(1쪽 · Link next 남음). 리뷰 13 의 2쪽은 예산 밖이라 부르지 않는다.
    assert.deepEqual(log1.urls, [
      U.prList(1),
      U.reviews(11, 1),
      U.reviews(12, 1),
      U.reviews(13, 1),
    ]);
    assert.deepEqual(r1.lines, [
      `전수 재조회 창: ${WINDOW_LINE} (캐시 끔 · 실행 1회 · 호출 4)`,
      "ㄴ GitHub 사람 손(창 전체): 변경 요청 1 · 미병합 닫기 1 · 대화 댓글 0 · 리뷰 줄 댓글 0 · Update branch 0 · 기각된 리뷰 0건(원래 상태를 응답에서 알 수 없음) · 판정 불가 0",
      "조회 범위: PR 4개(목록 3 ∪ git 병합 2) · 리뷰 응답 쪽 3 · 목록 쪽 1 · D1 후보 1",
      "선언 재료: 불가 — 미완(남은 미조회 5)",
      "전수 재조회: 미완 — 남은 미조회 5(PR 쓸기 0 · PR 리뷰 2 · 목록 2 · D1 1 · 수집 실패 0) — 다음 실행 가능 ≥ 10:00 KST",
    ]);
    assert.equal(r1.exit, 3);
    assert.equal(r1.exit, RESCAN_EXIT.INCOMPLETE);
    assert.equal(r1.calls, 4);
    assert.equal(r1.stop, "budget");
    assert.deepEqual(log1.unexpected, []);
    assert.equal(
      fs.readFileSync(paths(dir).reportOut, "utf8"),
      `${r1.lines.join("\n")}\n`,
      "보고 파일 = 출력 줄 그대로 + 개행",
    );

    // 실행 2(3시간 뒤 · 60분 합 비어 있음): 리뷰 13(2쪽) · 15 + 목록 3쪽 + D1 1 = 7회 -- 다 본다.
    const { result: r2, log: log2 } = await runOnce({
      dir,
      world,
      nowMs: RUN2_NOW,
    });
    assert.deepEqual(log2.urls, [
      U.reviews(13, 1),
      U.reviews(13, 2),
      U.reviews(15, 1),
      U.issue(1),
      U.issue(2),
      U.reviewComments(1),
      U.commit,
    ]);
    assert.deepEqual(r2.lines, [
      `전수 재조회 창: ${WINDOW_LINE} (캐시 끔 · 실행 2회 · 호출 11)`,
      "ㄴ GitHub 사람 손(창 전체): 변경 요청 1 · 미병합 닫기 1 · 대화 댓글 99 · 리뷰 줄 댓글 2 · Update branch 1 · 기각된 리뷰 1건(원래 상태를 응답에서 알 수 없음) · 판정 불가 0",
      "조회 범위: PR 4개(목록 3 ∪ git 병합 2) · 리뷰 응답 쪽 5 · 목록 쪽 4 · D1 후보 1",
      "선언 재료: 가능",
      "전수 재조회: 완료 — 남은 미조회 0",
    ]);
    assert.equal(r2.exit, 0);
    assert.equal(r2.exit, RESCAN_EXIT.COMPLETE);
    assert.equal(r2.complete, true);
    assert.equal(r2.stop, null);
    assert.deepEqual(log2.unexpected, []);
    assert.equal(
      fs.readFileSync(paths(dir).reportOut, "utf8"),
      `${r2.lines.join("\n")}\n`,
    );

    // 같은 리뷰 중복 1: 리뷰 13 의 1쪽(504)을 실행 1 · 실행 2 가 모두 봤어도 변경 요청 사건은 하나다.
    const events = readState(dir).events;
    assert.deepEqual(
      Object.keys(events).filter((k) => k.startsWith("cr:")),
      ["cr:504"],
    );
    assert.equal(r2.counts.changeRequest, 1);
    // 상태 파일의 실행 기록 = 호출 수 합(4 + 7)
    assert.deepEqual(
      readState(dir).runs.map((r) => [r.atMs, r.calls, r.stop]),
      [
        [RUN1_NOW, 4, "budget"],
        [RUN2_NOW, 7, null],
      ],
    );
  }));

test("ⓐ 완료한 상태로 또 실행하면 호출 0 · 같은 완료 줄 · exit 0 -- 상태 바이트 무변", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
    await runOnce({ dir, world, nowMs: RUN2_NOW });
    const before = fs.readFileSync(paths(dir).statePath, "utf8");
    const { result, log } = await runOnce({ dir, world, nowMs: RUN3_NOW });
    assert.deepEqual(log.urls, []);
    assert.equal(result.exit, 0);
    assert.equal(lastLine(result), "전수 재조회: 완료 — 남은 미조회 0");
    assert.equal(result.lines[0].includes("실행 2회 · 호출 11"), true);
    assert.equal(fs.readFileSync(paths(dir).statePath, "utf8"), before);
  }));

test("ⓐ 기각된 리뷰는 ㄴ 분자에 따로 보이고 판정 문면 그대로 «기각된 리뷰 n건(원래 상태를 응답에서 알 수 없음)»", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
    const { result } = await runOnce({ dir, world, nowMs: RUN2_NOW });
    assert.ok(
      result.lines[1].includes(
        "기각된 리뷰 1건(원래 상태를 응답에서 알 수 없음)",
      ),
    );
    assert.equal(result.lines[1].includes("(원래 상태 미상)"), false);
  }));

// ---- ⓑ 기각 침식 방어 -----------------------------------------------------------------------------------------------

test("ⓑ 실행 사이에 리뷰 504 가 «기각» 으로 바뀌어도 변경 요청 1 이 유지되고 기각으로 두 번 세지 않는다(침식 방어)", () =>
  withTmp(async (dir) => {
    await runOnce({
      dir,
      world: buildWorld(),
      nowMs: RUN1_NOW,
      maxCalls: 4,
    });
    const eroded = buildWorld({ state504: "DISMISSED" });
    const { result } = await runOnce({ dir, world: eroded, nowMs: RUN2_NOW });
    assert.equal(result.exit, 0);
    // 변경 요청 1(504 · 실행 1 이 본 것) · 기각 1(601 뿐 -- 504 는 «변경 요청» 에만 센다 · 1건 1번)
    assert.ok(
      result.lines[1].startsWith("ㄴ GitHub 사람 손(창 전체): 변경 요청 1 · "),
    );
    assert.ok(
      result.lines[1].includes(
        "기각된 리뷰 1건(원래 상태를 응답에서 알 수 없음)",
      ),
    );
    assert.equal(result.counts.numerator, 1 + 1 + 99 + 2 + 1 + 1);
    const keys = Object.keys(readState(dir).events);
    assert.ok(keys.includes("cr:504"), "먼저 본 변경 요청은 지우지 않는다");
    assert.ok(keys.includes("dr:504"), "기각으로 본 기록도 합집합에 남는다");
  }));

// ---- ⓒ 403 / 429 즉시 중단 · 상태 보존 ------------------------------------------------------------------------------------

for (const status of [403, 429]) {
  test(`ⓒ HTTP ${status} 는 그 실행을 «바로» 멈춘다 -- 남은 호출 0 · 상태 보존 · 다음 실행이 이어서 완주`, () =>
    withTmp(async (dir) => {
      const world = buildWorld();
      await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
      const limited = buildWorld();
      limited.responses[U.issue(1)] = failResp(status);
      const { result, log } = await runOnce({
        dir,
        world: limited,
        nowMs: RUN2_NOW,
      });
      // 실행 2: 리뷰 13(2쪽) · 15 · 대화 댓글 1쪽(한도) = 4회 -- 그 뒤 리뷰 줄 댓글 · D1 은 부르지 않는다.
      assert.deepEqual(log.urls, [
        U.reviews(13, 1),
        U.reviews(13, 2),
        U.reviews(15, 1),
        U.issue(1),
      ]);
      assert.equal(result.exit, 3);
      assert.equal(result.stop, "rateLimit");
      assert.equal(result.calls, 4);
      assert.match(lastLine(result), /^전수 재조회: 미완 — 남은 미조회 /);
      const state = readState(dir);
      assert.deepEqual(state.runs[1], {
        atMs: RUN2_NOW,
        calls: 4,
        stop: "rateLimit",
      });
      assert.equal(
        state.reviews["13"].state,
        "done",
        "한도 전에 끝낸 단위는 보존",
      );
      assert.equal(state.reviews["15"].state, "done");
      assert.ok(Object.keys(state.events).includes("cr:504"), "사건 보존");
      assert.ok(Object.keys(state.events).includes("dr:601"));
      assert.equal(state.lists.issueComments.done, false);
      // 3시간 뒤 다시 치면 이어서 끝낸다(남은 단위만 부른다)
      const { result: again, log: logAgain } = await runOnce({
        dir,
        world,
        nowMs: RUN3_NOW,
      });
      assert.deepEqual(logAgain.urls, [
        U.issue(1),
        U.issue(2),
        U.reviewComments(1),
        U.commit,
      ]);
      assert.equal(again.exit, 0);
      assert.equal(lastLine(again), "전수 재조회: 완료 — 남은 미조회 0");
    }));
}

// ---- 일시 실패(5xx) -- 그 단위만 실패로 두고 다음 실행이 다시 부른다 ------------------------------------------------------------

test("5xx 는 그 단위만 «수집 실패» 로 두고 나머지는 계속 -- 다음 실행이 그 단위만 다시 불러 완료", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
    const flaky = buildWorld();
    flaky.responses[U.reviews(15, 1)] = failResp(502);
    const { result, log } = await runOnce({
      dir,
      world: flaky,
      nowMs: RUN2_NOW,
    });
    assert.equal(
      log.urls.length,
      7,
      "실패 단위 뒤에도 목록 · D1 을 계속 부른다",
    );
    assert.equal(result.exit, 3);
    assert.equal(
      lastLine(result),
      "전수 재조회: 미완 — 남은 미조회 1(PR 쓸기 0 · PR 리뷰 0 · 목록 0 · D1 0 · 수집 실패 1) — 다음 실행 가능 ≥ 13:00 KST",
    );
    assert.equal(readState(dir).reviews["15"].state, "failed");
    const { result: fixed, log: fixedLog } = await runOnce({
      dir,
      world,
      nowMs: RUN3_NOW,
    });
    assert.deepEqual(fixedLog.urls, [U.reviews(15, 1)]);
    assert.equal(fixed.exit, 0);
    assert.equal(fixed.lines[0].includes("실행 3회"), true);
  }));

// ---- ⓓ 거부 갈래 = exit 1 · 쓰기 0 · 호출 0 -----------------------------------------------------------------------------

function assertRefused(out, io, reasonPattern) {
  assert.equal(out.result.exit, 1);
  assert.equal(out.result.exit, RESCAN_EXIT.REFUSED);
  assert.equal(out.result.lines.length, 1);
  assert.match(out.result.lines[0], /^전수 재조회: 거부 — /);
  assert.match(out.result.lines[0], reasonPattern);
  assert.deepEqual(out.log.urls, [], "GitHub 호출 0");
  assert.deepEqual(
    writeOps(io.ops),
    [],
    "쓰기 0(상태 · 보고 · 임시 파일 전부)",
  );
}

test("ⓓ 창 미종료 = exit 1 · 쓰기 0 · 호출 0 · git 읽기도 0 -- 창이 닫힌 첫 순간부터 받는다", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const io = spyIo();
    const out = await runOnce({
      dir,
      world,
      nowMs: W.endMs - 1,
      io: io.io,
    });
    assertRefused(out, io, /창이 아직 닫히지 않음/);
    assert.deepEqual(out.log.git, [], "문은 git 읽기 앞이다");
    assert.equal(fs.existsSync(paths(dir).statePath), false);
    assert.equal(fs.existsSync(paths(dir).reportOut), false);
    // 창 끝 정각은 받는다(한 실행 10 호출로 이 세계를 다 본다)
    const open = await runOnce({ dir, world, nowMs: W.endMs });
    assert.equal(open.result.exit, 0);
    assert.equal(open.log.urls.length, 10);
  }));

test("ⓓ 깨진 상태 = exit 1 · 쓰기 0 · 호출 0 -- JSON 깨짐 · 스키마 틀림 · 모르는 칸 · 읽을 수 없음(폴더)", () =>
  withTmp(async (dir) => {
    const { statePath } = paths(dir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const world = buildWorld();
    const bodies = [
      "{ not json",
      JSON.stringify({ schema: "other/v9" }),
      JSON.stringify([]),
    ];
    for (const body of bodies) {
      fs.writeFileSync(statePath, body, "utf8");
      const io = spyIo();
      const out = await runOnce({ dir, world, nowMs: RUN1_NOW, io: io.io });
      assertRefused(out, io, /상태 파일/);
      assert.equal(
        fs.readFileSync(statePath, "utf8"),
        body,
        "상태 바이트 무변",
      );
    }
    // 정상 상태에 모르는 최상위 칸을 더하면 거부
    fs.rmSync(statePath);
    await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
    const good = readState(dir);
    fs.writeFileSync(statePath, JSON.stringify({ ...good, extra: 1 }), "utf8");
    const io = spyIo();
    const out = await runOnce({ dir, world, nowMs: RUN2_NOW, io: io.io });
    assertRefused(out, io, /모르는 칸: extra/);
    assert.equal(
      fs.existsSync(paths(dir).reportOut),
      true,
      "앞 실행의 보고는 그대로",
    );
  }));

test("ⓓ fingerprint 불일치(봇 목록 blob · 창 · 저장소) = exit 1 · 쓰기 0 · 호출 0 -- 다른 재조회의 상태를 섞지 않는다", () =>
  withTmp(async (dir) => {
    await runOnce({
      dir,
      world: buildWorld(),
      nowMs: RUN1_NOW,
      maxCalls: 4,
    });
    const before = fs.readFileSync(paths(dir).statePath, "utf8");
    const reportBefore = fs.readFileSync(paths(dir).reportOut, "utf8");
    // 봇 목록 blob 이 바뀜
    let io = spyIo();
    let out = await runOnce({
      dir,
      world: buildWorld({ blob: "f".repeat(40) }),
      nowMs: RUN2_NOW,
      io: io.io,
    });
    assertRefused(out, io, /fingerprint 불일치\(botListBlob\)/);
    // 일수가 바뀜(같은 상태 파일에 다른 창)
    io = spyIo();
    out = await runOnce({
      dir,
      world: buildWorld(),
      nowMs: RUN2_NOW + 30 * 24 * HOUR,
      days: 6,
      io: io.io,
    });
    assertRefused(out, io, /fingerprint 불일치\(days\)/);
    assert.equal(fs.readFileSync(paths(dir).statePath, "utf8"), before);
    assert.equal(fs.readFileSync(paths(dir).reportOut, "utf8"), reportBefore);
  }));

test("ⓓ git 입력을 못 읽으면(저장소 신원 · 봇 목록 · 병합 로그) exit 1 · 쓰기 0 · 호출 0", () =>
  withTmp(async (dir) => {
    for (const drop of [
      "remote get-url origin",
      `cat-file blob origin/master:${BOT_PATH}`,
      "log --first-parent --merges",
    ]) {
      const world = buildWorld();
      world.git = world.git.filter(([prefix]) => prefix !== drop);
      const io = spyIo();
      const out = await runOnce({ dir, world, nowMs: RUN1_NOW, io: io.io });
      assertRefused(out, io, /읽기 실패|측정 실패|읽기 불가|일 수|없음|fatal/);
    }
  }));

test("ⓓ 인자 오류 · 필수 인자 없음 · 잘못된 창 = exit 1 · 쓰기 0 · 호출 0", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const base = { dir, world, nowMs: RUN1_NOW };
    for (const [bad, pattern] of [
      [{ fromDay: "2026-13-40" }, /시작일|존재하지 않는 날짜/],
      [{ days: 0 }, /일수 오류/],
      [{ days: 32 }, /일수 오류/],
      [{ statePath: "" }, /경로가 필요/],
      [{ maxCalls: 0 }, /max-calls/],
    ]) {
      const io = spyIo();
      const out = await runOnce({ ...base, ...bad, io: io.io });
      assertRefused(out, io, pattern);
    }
  }));

// ---- ⓔ 60분 합 예산 -------------------------------------------------------------------------------------------------------

test("ⓔ 직전 60분 합이 10 이면 호출 0 -- 다음 실행 가능 시각만 찍고 상태는 그대로(실행 기록을 만들지 않는다)", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const fingerprint = buildRescanFingerprint({
      fromDay: "2026-11-14",
      days: 7,
      repo: REPO,
      botListBlob: BOT_BLOB,
    });
    const seeded = recordRescanRun({
      state: createRescanState({ fingerprint }),
      atMs: RUN1_NOW - 10 * MIN,
      calls: 10,
      stop: "budget",
    });
    fs.mkdirSync(path.dirname(paths(dir).statePath), { recursive: true });
    fs.writeFileSync(paths(dir).statePath, JSON.stringify(seeded), "utf8");
    const { result, log } = await runOnce({ dir, world, nowMs: RUN1_NOW });
    assert.deepEqual(log.urls, [], "GitHub 호출 0");
    assert.equal(result.calls, 0);
    assert.equal(result.exit, 3);
    assert.deepEqual(result.lines, [
      `전수 재조회 창: ${WINDOW_LINE} (캐시 끔 · 실행 1회 · 호출 10)`,
      "ㄴ GitHub 사람 손(창 전체): 변경 요청 0 · 미병합 닫기 0 · 대화 댓글 0 · 리뷰 줄 댓글 0 · Update branch 0 · 기각된 리뷰 0건(원래 상태를 응답에서 알 수 없음) · 판정 불가 0",
      "조회 범위: PR 0개(목록 0 ∪ git 병합 0) · 리뷰 응답 쪽 0 · 목록 쪽 0 · D1 후보 1",
      "선언 재료: 불가 — 미완(남은 미조회 4)",
      "전수 재조회: 미완 — 남은 미조회 4(PR 쓸기 1 · PR 리뷰 0 · 목록 2 · D1 1 · 수집 실패 0) — 다음 실행 가능 ≥ 10:50 KST",
    ]);
    assert.equal(
      readState(dir).runs.length,
      1,
      "호출 0 실행은 기록하지 않는다",
    );
    // 60분이 지난 정각에는 다시 받는다
    const later = await runOnce({ dir, world, nowMs: RUN1_NOW + 50 * MIN });
    assert.ok(later.log.urls.length > 0);
  }));

test("ⓔ --max-calls 가 10 을 넘어도 한 실행은 10 호출까지(상한 10)", () =>
  withTmp(async (dir) => {
    // 병합 PR 16 을 하나 더 얹어 «한 실행에 11 호출이 필요한» 세계로 만든다(쓸기 1 + 리뷰 6 + 목록 3 + D1 1).
    const world = buildWorld();
    const at = world.git.findIndex(
      ([p]) => p === "log --first-parent --merges",
    );
    world.git[at][1].stdout +=
      `\n${"8".repeat(40)}\x1f2026-11-17T08:00:00+09:00\x1fMerge pull request #16 from owner-fixture/branch-e`;
    world.responses[U.reviews(16, 1)] = okResp([]);
    const { result, log } = await runOnce({
      dir,
      world,
      nowMs: RUN1_NOW,
      maxCalls: 99,
    });
    assert.equal(log.urls.length, 10);
    assert.equal(result.calls, 10);
    assert.equal(result.stop, "budget");
    assert.equal(result.exit, 3);
  }));

// ---- ⓑ 창 문 -- 닫히기 전 시각으로 done 이 된 단위는 닫힌 뒤 다시 부른다 ---------------------------------------------------------

test("ⓑ 닫히기 전 시각으로 done 이 찍힌 리뷰 · D1 이 상태에 있으면 닫힌 뒤 실행이 그 단위만 다시 부른다 -- 사건 합집합은 그대로", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
    const complete = await runOnce({ dir, world, nowMs: RUN2_NOW });
    assert.equal(complete.result.exit, 0);
    const eventsBefore = JSON.stringify(readState(dir).events);
    // 리뷰 13 · D1 한 건 · D1 후보 수집 표지를 «창이 닫히기 전 시각» 의 done 으로 되돌린다
    const state = readState(dir);
    state.reviews["13"].doneAtMs = W.endMs - 1;
    state.d1.shas[D1_SHA].doneAtMs = W.endMs - 1;
    state.d1.collectedAtMs = W.endMs - 1;
    fs.writeFileSync(paths(dir).statePath, JSON.stringify(state), "utf8");
    const { result, log } = await runOnce({ dir, world, nowMs: RUN3_NOW });
    assert.deepEqual(log.urls, [U.reviews(13, 1), U.reviews(13, 2), U.commit]);
    assert.equal(result.exit, 0);
    assert.equal(lastLine(result), "전수 재조회: 완료 — 남은 미조회 0");
    assert.equal(
      JSON.stringify(readState(dir).events),
      eventsBefore,
      "같은 사건은 중복되지 않는다",
    );
    assert.ok(
      readState(dir).reviews["13"].doneAtMs >= W.endMs,
      "다시 부른 단위는 닫힌 뒤 시각으로 done",
    );
  }));

// ---- ⓔ 쪽 넘김 ------------------------------------------------------------------------------------------------------------

test("ⓔ PR 목록 쪽 넘김 -- 1쪽이 100건 꽉 차고 끝 항목이 창 안이면 2쪽을 불러 «창 덮음» 까지(쓸기 완료는 그때)", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    // 1쪽 = 열린 PR 100건(번호 200~299 · 모두 창 안 · 내림차순) · 2쪽 = 병합 11 · 창 밖 14
    const page1 = Array.from({ length: 100 }, (_, i) =>
      prItem(299 - i, {
        state: "open",
        updatedAt: "2026-11-20 12:00",
      }),
    ).map((item, i) => ({
      ...item,
      updated_at: isoOf(kst("2026-11-20 12:00") - i * MIN),
    }));
    world.responses[U.prList(1)] = okResp(
      page1,
      relLinks([[U.prList(2), "next"]]),
    );
    world.responses[U.prList(2)] = okResp([PR_LIST[2], PR_LIST[3]]);
    const { result, log } = await runOnce({
      dir,
      world,
      nowMs: RUN1_NOW,
      maxCalls: 2,
    });
    assert.deepEqual(log.urls, [U.prList(1), U.prList(2)], "2쪽까지 부른다");
    assert.equal(result.calls, 2);
    const state = readState(dir);
    assert.equal(state.prSweep.done, true);
    assert.equal(state.prSweep.pages, 2);
    assert.equal(
      state.prSweep.listPrs.length,
      101,
      "200~299 + 11 (14 는 창 밖)",
    );
    // 1쪽만 부르고 멈춘 쓸기는 «끝난 것» 이 아니다
    const only1 = await withTmp((dir2) =>
      runOnce({ dir: dir2, world, nowMs: RUN1_NOW, maxCalls: 1 }).then((o) => ({
        ...o,
        state: readState(dir2),
      })),
    );
    assert.equal(only1.state.prSweep.done, false);
    assert.match(
      lastLine(only1.result),
      /^전수 재조회: 미완 — 남은 미조회 \d+\(PR 쓸기 1 · /,
    );
  }));

test("ⓔ 쪽 넘김 -- 리뷰는 Link next 가 끝날 때까지 · 댓글 목록은 창 덮음까지(대화 댓글 101건 = 2쪽 · 센 수 99)", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    await runOnce({ dir, world, nowMs: RUN1_NOW, maxCalls: 4 });
    const { log } = await runOnce({ dir, world, nowMs: RUN2_NOW });
    // 리뷰 13 은 1쪽 Link next → 2쪽 · 리뷰 11 · 12 · 15 는 Link 가 없어 1쪽으로 끝
    assert.equal(
      log.urls.filter((u) => u.includes("/pulls/13/reviews")).length,
      2,
    );
    assert.equal(
      log.urls.filter((u) => u.includes("/pulls/15/reviews")).length,
      1,
    );
    // 대화 댓글 1쪽 100건(끝 항목이 창 안) → 2쪽 · 리뷰 줄 댓글 1쪽 3건(100 미만 = 끝)
    assert.equal(
      log.urls.filter((u) => u.includes("/issues/comments")).length,
      2,
    );
    assert.equal(
      log.urls.filter((u) => u.includes("/pulls/comments")).length,
      1,
    );
    const pages = readState(dir).lists;
    assert.equal(pages.issueComments.pages, 2);
    assert.equal(pages.reviewComments.pages, 1);
  }));

// ---- ⓔ 원자 쓰기 ------------------------------------------------------------------------------------------------------------

test("ⓔ 원자 쓰기 -- 상태 · 보고는 tmp 에 쓴 뒤 rename · 최종 경로에 직접 쓰지 않고 · 단위 하나 끝날 때마다 «받아들일 수 있는» 상태가 디스크에 있다", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const snapshots = [];
    const { io, ops } = spyIo({
      renameSync: (from, to) => {
        fs.renameSync(from, to);
        if (to === paths(dir).statePath) {
          const accepted = acceptRescanState({
            stateValue: JSON.parse(fs.readFileSync(to, "utf8")),
            expectedFingerprint: buildRescanFingerprint({
              fromDay: "2026-11-14",
              days: 7,
              repo: REPO,
              botListBlob: BOT_BLOB,
            }),
          });
          snapshots.push(accepted.ok);
        }
      },
    });
    const { result } = await runOnce({
      dir,
      world,
      nowMs: RUN1_NOW,
      maxCalls: 4,
      io,
    });
    assert.equal(result.exit, 3);
    const writes = ops.filter((o) => o.op === "write");
    assert.ok(writes.length >= 5);
    for (const w of writes) {
      assert.ok(w.file.endsWith(".tmp"), `직접 쓰기 금지: ${w.file}`);
      assert.notEqual(w.file, paths(dir).statePath);
      assert.notEqual(w.file, paths(dir).reportOut);
    }
    const toState = ops.filter(
      (o) => o.op === "rename" && o.to === paths(dir).statePath,
    );
    // 단위 5(D1 후보 등록 · 쓸기 · 리뷰 11 · 12 · 13 일부) + 마지막 실행 기록 = 상태 렌더가 6번 이상 디스크에 간다
    assert.ok(toState.length >= 5, `단위마다 rename: ${toState.length}`);
    assert.equal(snapshots.length, toState.length);
    assert.ok(
      snapshots.every(Boolean),
      "중간 상태가 매번 받아들일 수 있는 모양",
    );
    assert.equal(
      ops.filter((o) => o.op === "rename" && o.to === paths(dir).reportOut)
        .length,
      1,
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(paths(dir).statePath)).sort(),
      ["report.md", "state.json"],
      "임시 파일이 남지 않는다",
    );
  }));

test("ⓔ 저장 도중 rename 이 죽으면(디스크 오류) 앞 단위까지의 상태가 그대로 있고 임시 파일은 정리된다 -- exit 1", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    let renames = 0;
    const { io } = spyIo({
      renameSync: (from, to) => {
        renames += 1;
        if (renames === 3) throw new Error("디스크 오류(합성)");
        fs.renameSync(from, to);
      },
    });
    const { result, log } = await runOnce({
      dir,
      world,
      nowMs: RUN1_NOW,
      io,
    });
    assert.equal(result.exit, 1);
    assert.match(
      result.lines[0],
      /^전수 재조회: 거부 — 상태 저장 실패\(디스크 오류\(합성\)\)/,
    );
    // 세 번째 저장이 죽었다 = 앞 두 번(D1 후보 등록 · PR 쓸기)이 디스크에 있다
    const onDisk = readState(dir);
    assert.equal(onDisk.d1.collected, true);
    assert.equal(onDisk.prSweep.done, true);
    assert.deepEqual(
      Object.keys(onDisk.reviews),
      [],
      "죽은 저장의 단위(리뷰 11)는 없다",
    );
    assert.equal(
      log.urls.length,
      2,
      "저장이 죽자 더 부르지 않는다(쓸기 1 + 리뷰 11 1)",
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(paths(dir).statePath)),
      ["state.json"],
      "임시 파일 정리",
    );
    assert.equal(
      fs.existsSync(paths(dir).reportOut),
      false,
      "보고는 쓰지 않았다",
    );
    // 다시 치면 디스크의 상태에서 이어서 끝낸다
    const retry = await runOnce({ dir, world, nowMs: RUN2_NOW });
    assert.equal(
      retry.log.urls.length,
      9,
      "리뷰 5쪽 + 목록 3쪽 + D1 1 = 디스크 상태에서 이어서",
    );
    assert.equal(retry.result.exit, 0);
  }));

test("ⓔ writeTextAtomic -- 없는 폴더도 만들고 성공하면 null · 쓰기가 죽으면 사유 문자열(throw 0) · tmp 이름은 최종 이름과 다르다", () =>
  withTmp((dir) => {
    const target = path.join(dir, "deep", "er", "y.txt");
    assert.equal(
      writeTextAtomic({ io: defaultRescanIo, filePath: target, text: "t" }),
      null,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "t");
    const boom = {
      ...defaultRescanIo,
      writeFileSync: () => {
        throw new Error("쓰기 불가");
      },
    };
    assert.equal(
      writeTextAtomic({ io: boom, filePath: target, text: "u" }),
      "쓰기 불가",
    );
    assert.equal(
      fs.readFileSync(target, "utf8"),
      "t",
      "실패해도 기존 파일 무변",
    );
  }));

// ---- ⓕ TZ 무관 ---------------------------------------------------------------------------------------------------------------

test("ⓕ 같은 입력의 상태 · 보고 바이트는 시스템 시간대와 무관하다 -- 자식 프로세스를 UTC · Asia/Seoul · America/Los_Angeles 로 띄워 바이트 대조", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const childPath = path.join(dir, "tz-child.mjs");
    const seamSource = makeSeam.toString();
    fs.writeFileSync(
      childPath,
      [
        `process.env.TZ = process.argv[2];`,
        `import("node:fs").then(async (fs) => {`,
        `  const { runRescanOnce } = await import(${JSON.stringify(pathToFileURL(CLI_PATH).href)});`,
        `  const makeSeam = ${seamSource};`,
        `  const input = JSON.parse(fs.readFileSync(0, "utf8"));`,
        `  const log = { urls: [], unexpected: [], git: [] };`,
        `  const seam = makeSeam(input.world, log);`,
        `  const run = (nowMs, maxCalls) => runRescanOnce({`,
        `    fromDay: "2026-11-14", days: 7, statePath: input.statePath, reportOut: input.reportOut,`,
        `    nowMs, maxCalls, fetchJson: seam.fetchJson, git: seam.git });`,
        `  const r1 = await run(input.run1, 4);`,
        `  const r2 = await run(input.run2, undefined);`,
        `  process.stdout.write(JSON.stringify({`,
        `    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,`,
        `    lines1: r1.lines, lines2: r2.lines,`,
        `    state: fs.readFileSync(input.statePath, "utf8"), report: fs.readFileSync(input.reportOut, "utf8"),`,
        `    unexpected: log.unexpected }));`,
        `});`,
      ].join("\n"),
      "utf8",
    );
    const outputs = {};
    for (const tz of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
      const sub = path.join(dir, `tz-${tz.replace("/", "-")}`);
      fs.mkdirSync(sub);
      const child = spawnSync(process.execPath, [childPath, tz], {
        input: JSON.stringify({
          world,
          statePath: path.join(sub, "state.json"),
          reportOut: path.join(sub, "report.md"),
          run1: RUN1_NOW,
          run2: RUN2_NOW,
        }),
        encoding: "utf8",
        env: { ...process.env, TZ: tz },
      });
      assert.equal(child.status, 0, `${tz}: ${child.stderr}`);
      outputs[tz] = JSON.parse(child.stdout);
      assert.equal(outputs[tz].tz, tz, "자식이 실제로 그 시간대로 돌았다");
      assert.deepEqual(outputs[tz].unexpected, []);
    }
    const base = outputs.UTC;
    assert.equal(base.lines2[4], "전수 재조회: 완료 — 남은 미조회 0");
    for (const tz of ["Asia/Seoul", "America/Los_Angeles"]) {
      assert.equal(outputs[tz].state, base.state, `${tz} 상태 바이트`);
      assert.equal(outputs[tz].report, base.report, `${tz} 보고 바이트`);
      assert.deepEqual(outputs[tz].lines1, base.lines1);
    }
    // 이 프로세스에서 돌린 같은 입력과도 같다(시험 러너의 시간대와도 무관)
    const sub = path.join(dir, "inproc");
    const inproc1 = await runRescanOnce({
      fromDay: "2026-11-14",
      days: 7,
      statePath: path.join(sub, "state.json"),
      reportOut: path.join(sub, "report.md"),
      nowMs: RUN1_NOW,
      maxCalls: 4,
      ...makeSeam(world, newLog()),
    });
    assert.deepEqual(inproc1.lines, base.lines1);
    await runRescanOnce({
      fromDay: "2026-11-14",
      days: 7,
      statePath: path.join(sub, "state.json"),
      reportOut: path.join(sub, "report.md"),
      nowMs: RUN2_NOW,
      ...makeSeam(world, newLog()),
    });
    assert.equal(
      fs.readFileSync(path.join(sub, "state.json"), "utf8"),
      base.state,
    );
  }));

// ---- ⓖ 프로덕션 진입점 · CLI --------------------------------------------------------------------------------------------------

test("ⓖ 인자 해석 -- 다섯 플래그만 · 모르는 플래그 · 값 없음 · 중복 · 필수 없음 · 숫자 오류는 거부", () => {
  assert.deepEqual(Object.keys(RESCAN_CLI_FLAGS).sort(), [
    "--days",
    "--from-day",
    "--max-calls",
    "--report-out",
    "--state",
  ]);
  const good = [
    "--from-day",
    "2026-11-14",
    "--days",
    "7",
    "--state",
    "s.json",
    "--report-out",
    "r.md",
  ];
  assert.deepEqual(parseRescanArgs(good), {
    ok: true,
    options: {
      fromDay: "2026-11-14",
      days: 7,
      statePath: "s.json",
      reportOut: "r.md",
    },
  });
  assert.equal(
    parseRescanArgs([...good, "--max-calls", "4"]).options.maxCalls,
    4,
  );
  for (const [argv, pattern] of [
    [[...good, "--window-hours", "24"], /모르는 플래그: --window-hours/],
    [[...good, "--cache", "x"], /모르는 플래그: --cache/],
    [["--bogus"], /모르는 플래그: --bogus/],
    [["extra", ...good], /모르는 플래그: extra/],
    [good.slice(0, -1), /--report-out 값 없음/],
    [[...good, "--days", "8"], /--days 중복/],
    [good.slice(0, 2), /필수 인자 없음/],
    [
      [...good.slice(0, 2), "--days", "x", "--state", "s", "--report-out", "r"],
      /--days 는 0 이상 정수/,
    ],
    [[...good, "--max-calls", "-1"], /--max-calls/],
  ]) {
    const out = parseRescanArgs(argv);
    assert.equal(out.ok, false, argv.join(" "));
    assert.match(out.reason, pattern);
  }
});

test("ⓖ CLI main -- 인자 해석 → runRescanOnce(프로덕션 진입점) → 줄 출력 → 종료 값 · 보고 파일(합성 seam · 실제 파일은 mkdtemp 안)", () =>
  withTmp(async (dir) => {
    const world = buildWorld();
    const printed = [];
    const run = (nowMs, extraArgs = []) =>
      main(
        [
          "--from-day",
          "2026-11-14",
          "--days",
          "7",
          "--state",
          paths(dir).statePath,
          "--report-out",
          paths(dir).reportOut,
          ...extraArgs,
        ],
        {
          out: (line) => printed.push(line),
          err: () => {},
          inject: { nowMs, ...makeSeam(world, newLog()) },
        },
      );
    assert.equal(await run(RUN1_NOW, ["--max-calls", "4"]), 3);
    assert.equal(
      printed[printed.length - 1],
      "전수 재조회: 미완 — 남은 미조회 5(PR 쓸기 0 · PR 리뷰 2 · 목록 2 · D1 1 · 수집 실패 0) — 다음 실행 가능 ≥ 10:00 KST",
    );
    printed.length = 0;
    assert.equal(await run(RUN2_NOW), 0);
    assert.equal(printed.length, 5);
    assert.equal(printed[4], "전수 재조회: 완료 — 남은 미조회 0");
    // 인자 오류는 진입점을 부르지 않고 1
    printed.length = 0;
    let called = 0;
    const code = await main(["--bogus", "1"], {
      out: (line) => printed.push(line),
      runRescanOnce: async () => {
        called += 1;
        return { exit: 0, lines: [] };
      },
    });
    assert.equal(code, 1);
    assert.equal(called, 0);
    assert.deepEqual(printed, ["전수 재조회: 거부 — 모르는 플래그: --bogus"]);
  }));

test("ⓖ CLI 스폰(망 0) -- 인자 거부 갈래 · 먼 미래 창 거부(시계와 무관한 갈래) = exit 1 · 마지막 줄이 신호 · 파일 0", () =>
  withTmp((dir) => {
    const spawnCli = (args) =>
      spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: "utf8",
        env: { ...process.env },
      });
    const unknown = spawnCli(["--bogus", "1"]);
    assert.equal(unknown.status, 1);
    assert.equal(
      unknown.stdout.trim().split("\n").pop(),
      "전수 재조회: 거부 — 모르는 플래그: --bogus",
    );
    const missing = spawnCli(["--from-day", "2026-11-14", "--days", "7"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /필수 인자 없음: --state --report-out/);
    // 먼 미래 창(2099) = 어떤 시계에서도 아직 닫히지 않음 -- 문이 git · 망 읽기 앞에서 거부한다
    const statePath = path.join(dir, "s.json");
    const reportOut = path.join(dir, "r.md");
    const future = spawnCli([
      "--from-day",
      "2099-01-01",
      "--days",
      "7",
      "--state",
      statePath,
      "--report-out",
      reportOut,
    ]);
    assert.equal(future.status, 1);
    assert.match(
      future.stdout.trim().split("\n").pop(),
      /^전수 재조회: 거부 — 창이 아직 닫히지 않음\(창 끝 2099-01-08 00:00 KST 이후에 실행한다\)$/,
    );
    assert.equal(fs.existsSync(statePath), false);
    assert.equal(fs.existsSync(reportOut), false);
  }));

test("ⓖ 이 CLI 는 감시 회차 · 승인 캐시 · 일별 파일에 닿지 않는다 -- watch-run import 0 · 캐시 이름 0 · 봇 이름 리터럴 0", () => {
  const src = fs.readFileSync(CLI_PATH, "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.equal(/watch-run|anchor-seal/.test(code), false);
  assert.equal(
    /approval-cache|partial-count-daily|resolveApprovalCachePath/.test(code),
    false,
  );
  const cfg = JSON.parse(
    fs.readFileSync(
      new URL("./github-bot-accounts.json", import.meta.url),
      "utf8",
    ),
  );
  for (const bot of cfg.bots) {
    assert.equal(src.includes(bot.login), false, "봇 이름 리터럴 0");
  }
  assert.equal(
    /\.bot_pat|credential|patFile/i.test(code),
    false,
    "자격 · PAT 경로 0",
  );
});
