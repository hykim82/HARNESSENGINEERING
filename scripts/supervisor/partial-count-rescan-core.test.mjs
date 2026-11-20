// HYK-255-rescan-core-1 (판정 #20261120-1424 3 레인 1 · #20261120-1519) -- 전수 재조회 core 계약 시험.
//
// ⛔헛시험 금지: 새 core 의 export(absorb* · mergeRescanEvents · planRunBudget · judgeRescanRemaining · renderRescanReport ·
// acceptRescanState …)를 실제로 구동하고 «값» 을 단언한다. 기대 수는 응답표를 손으로 센 값(시험이 직접 적는다) -- 같은 함수로 기대값을 만들지 않는다.
// 출력 줄 «전체» 문자열 동등 단언은 «줄 형식 고정» 칸에서만(기대 줄은 시험 안에서 값으로 조립).
// 실행 환경 무관: 시각은 전부 +09:00 문자열 · epoch 로 만들고 로컬 시각 생성자 · 접근자 · 로캘 서식을 쓰지 않는다. 실제 저장소 루트의 .harness · 체크아웃
// 상태 · 망 · 파일 접촉 0(상태는 전부 합성 객체).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as rescan from "./partial-count-rescan-core.mjs";

const {
  RESCAN_EXIT,
  acceptRescanState,
  absorbCommentPages,
  absorbPrSweep,
  absorbReviewPages,
  buildRescanFingerprint,
  compareRescanFingerprint,
  computeRescanWindow,
  countRescanEvents,
  createRescanState,
  judgeRescanRemaining,
  judgeWindowClosed,
  markUnitFailed,
  mergeRescanEvents,
  planRescanTargets,
  planRunBudget,
  recordRescanRun,
  recordUpdateBranchResult,
  registerUpdateBranchCandidates,
  renderRescanReport,
  validateRescanState,
} = rescan;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const kst = (s) => Date.parse(`${s.replace(" ", "T")}:00+09:00`);
const iso = (s) => new Date(kst(s)).toISOString();
const NOW = kst("2026-11-21 10:00");
const W = computeRescanWindow({ fromDay: "2026-11-14", days: 7 });
const BOT = "bot-fixture-a";
const HUMAN = "human-fixture";
const BOTS = new Set([BOT]);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const FP = buildRescanFingerprint({
  fromDay: "2026-11-14",
  days: 7,
  repo: "owner/repo",
  botListBlob: "c".repeat(40),
});

// ---- 합성 응답표 ---------------------------------------------------------------------------------------------------

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
const comment = (id, at, urlField, login = HUMAN) => ({
  id,
  created_at: iso(at),
  user: { login },
  [urlField]: "https://example.invalid/x",
});

// PR 목록 한 쪽 -- 병합(11) · 미병합 닫기(12) · 열림(13) · 창 밖(14).
const SWEEP_PAGE = [
  prItem(11, {
    state: "closed",
    mergedAt: "2026-11-16 12:00",
    closedAt: "2026-11-16 12:00",
    updatedAt: "2026-11-16 12:00",
  }),
  prItem(12, {
    state: "closed",
    closedAt: "2026-11-17 09:00",
    updatedAt: "2026-11-17 09:00",
  }),
  prItem(13, { state: "open", updatedAt: "2026-11-18 09:00" }),
  prItem(14, {
    state: "closed",
    closedAt: "2026-11-10 09:00",
    updatedAt: "2026-11-10 09:00",
  }),
];
const REVIEWS_11 = [
  review(501, "CHANGES_REQUESTED", "2026-11-16 10:00"),
  review(502, "CHANGES_REQUESTED", "2026-11-16 10:30", BOT),
  review(503, "APPROVED", "2026-11-16 11:00"),
];
const REVIEWS_13 = [
  review(504, "CHANGES_REQUESTED", "2026-11-18 10:00"),
  review(505, "CHANGES_REQUESTED", "2026-11-05 10:00"),
];
const REVIEWS_15 = [
  review(601, "DISMISSED", "2026-11-19 10:00"),
  review(602, "DISMISSED", "2026-11-19 10:30", BOT),
  review(603, "CHANGES_REQUESTED", "2026-11-19 11:00"),
];
const ISSUE_COMMENTS = [
  comment(7001, "2026-11-17 09:00", "issue_url"),
  comment(7002, "2026-11-17 09:30", "issue_url", BOT),
  comment(7003, "2026-11-22 09:00", "issue_url"),
];
const REVIEW_COMMENT_PAGES = [
  [
    comment(8001, "2026-11-18 09:00", "pull_request_url"),
    comment(8002, "2026-11-19 09:00", "pull_request_url"),
  ],
  [comment(8001, "2026-11-18 09:00", "pull_request_url")],
];

const fresh = () => createRescanState({ fingerprint: FP });
const sweep = (
  state,
  { nowMs = NOW, pages = [SWEEP_PAGE], git = [11, 15] } = {},
) =>
  absorbPrSweep({
    state,
    pages,
    gitMergePrNumbers: git,
    window: W,
    nowMs,
    botLogins: BOTS,
  });
const reviews = (state, prNumber, pages, complete = true) =>
  absorbReviewPages({
    state,
    prNumber,
    pages: [pages],
    complete,
    window: W,
    botLogins: BOTS,
  });
const comments = (state, listKey, pages, nowMs = NOW) =>
  absorbCommentPages({
    state,
    listKey,
    pages,
    window: W,
    nowMs,
    botLogins: BOTS,
  });

// 전부 본 상태(손으로 센 값: 변경 요청 3 · 미병합 닫기 1 · 대화 댓글 1 · 리뷰 줄 댓글 2 · Update branch 1 · 기각된 리뷰 1 · 판정 불가 0).
function completeState() {
  let s = sweep(fresh());
  s = reviews(s, 11, REVIEWS_11);
  s = reviews(s, 12, []);
  s = reviews(s, 13, REVIEWS_13);
  s = reviews(s, 15, REVIEWS_15);
  s = comments(s, "issueComments", [ISSUE_COMMENTS]);
  s = comments(s, "reviewComments", REVIEW_COMMENT_PAGES);
  s = registerUpdateBranchCandidates({ state: s, shas: [SHA_A, SHA_B] });
  s = recordUpdateBranchResult({
    state: s,
    sha: SHA_A,
    counted: true,
    atMs: kst("2026-11-19 12:00"),
  });
  s = recordUpdateBranchResult({
    state: s,
    sha: SHA_B,
    counted: false,
    atMs: kst("2026-11-19 13:00"),
  });
  return s;
}
const runs = (state, list) =>
  list.reduce(
    (s, [atMs, calls, stop]) =>
      recordRescanRun({ state: s, atMs, calls, stop }),
    state,
  );

// ---- ⑴ fingerprint · 상태 모양 ---------------------------------------------------------------------------------------

test("⑴ fingerprint 가 한 칸이라도 다르면 거부 -- 칸 이름을 말하고 상태를 받아들이지 않는다", () => {
  const state = completeState();
  const cases = {
    fromDay: { ...FP, fromDay: "2026-11-15" },
    days: { ...FP, days: 6 },
    repo: { ...FP, repo: "owner/other" },
    botListBlob: { ...FP, botListBlob: "d".repeat(40) },
  };
  for (const [key, expected] of Object.entries(cases)) {
    const verdict = acceptRescanState({
      stateValue: JSON.parse(JSON.stringify(state)),
      expectedFingerprint: expected,
    });
    assert.equal(verdict.ok, false, key);
    assert.equal(verdict.exit, RESCAN_EXIT.REFUSED, key);
    assert.match(verdict.reason, /fingerprint 불일치/, key);
    assert.ok(verdict.reason.includes(key), `${key} 이름이 사유에 없음`);
    assert.equal(
      compareRescanFingerprint(state.fingerprint, expected).ok,
      false,
      key,
    );
  }
  const same = acceptRescanState({
    stateValue: JSON.parse(JSON.stringify(state)),
    expectedFingerprint: { ...FP },
  });
  assert.equal(same.ok, true);
  assert.deepEqual(same.state.events, state.events);
});

test("⑴ 기대 fingerprint 가 비었거나 모양이 틀리면 «둘 다 비었으니 같다» 로 통과시키지 않는다", () => {
  const broken = { ...FP, botListBlob: "" };
  const state = createRescanState({ fingerprint: broken });
  assert.equal(compareRescanFingerprint(broken, broken).ok, false);
  assert.equal(compareRescanFingerprint(undefined, undefined).ok, false);
  const verdict = acceptRescanState({
    stateValue: state,
    expectedFingerprint: broken,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.exit, RESCAN_EXIT.REFUSED);
});

test("⑴ 상태 모양 검증 -- 정상 상태(JSON 왕복)는 통과 · 깨진 모양은 칸마다 거부(종료 값 1)", () => {
  const good = JSON.parse(JSON.stringify(completeState()));
  assert.equal(validateRescanState(good).ok, true);
  const breakers = {
    "schema 불일치": (s) => (s.schema = "partial-count-rescan-state/v0"),
    "모르는 칸": (s) => (s.extra = 1),
    runs: (s) => s.runs.push({ atMs: "x", calls: 1, stop: null }),
    "prSweep.done": (s) => (s.prSweep.done = "yes"),
    "prSweep.listPrs": (s) => (s.prSweep.listPrs = [0]),
    "reviews 키": (s) => (s.reviews.abc = s.reviews["11"]),
    "reviews 상태": (s) => (s.reviews["11"].state = "weird"),
    "lists 칸": (s) => delete s.lists.reviewComments,
    "d1.collected": (s) => delete s.d1.collected,
    "d1 sha": (s) => (s.d1.shas["zz"] = { state: "done", reason: null }),
    "events kind": (s) => (s.events["cr:1"] = { kind: "nope", atMs: 1 }),
    "events atMs": (s) =>
      (s.events["cr:2"] = { kind: "changeRequest", atMs: "1" }),
    undecidable: (s) => (s.undecidable.closedPrs = -1),
    "fingerprint 칸": (s) => (s.fingerprint.botListBlob = ""),
  };
  for (const [name, breaker] of Object.entries(breakers)) {
    const bad = JSON.parse(JSON.stringify(good));
    breaker(bad);
    const verdict = validateRescanState(bad);
    assert.equal(verdict.ok, false, name);
    assert.ok(verdict.errors.length >= 1, name);
    const accepted = acceptRescanState({
      stateValue: bad,
      expectedFingerprint: FP,
    });
    assert.equal(accepted.exit, RESCAN_EXIT.REFUSED, name);
  }
  assert.equal(validateRescanState(null).ok, false);
  assert.equal(validateRescanState([]).ok, false);
});

test("⑴ 창 -- 시작일 00:00 KST ~ 시작일 + 일수 00:00 KST · 잘못된 입력 거부 · 창 끝 전 실행 거부", () => {
  assert.equal(W.ok, true);
  assert.equal(W.startMs, Date.UTC(2026, 10, 13, 15, 0, 0));
  assert.equal(W.endMs, Date.UTC(2026, 10, 20, 15, 0, 0));
  assert.equal(W.windowEndMs, W.endMs - 1);
  assert.equal(W.startLabel, "2026-11-14 00:00 KST");
  assert.equal(W.endLabel, "2026-11-21 00:00 KST");
  for (const bad of [
    { fromDay: "2026-13-01", days: 7 },
    { fromDay: "2026-02-30", days: 7 },
    { fromDay: "20261114", days: 7 },
    { fromDay: "2026-11-14", days: 0 },
    { fromDay: "2026-11-14", days: 1.5 },
    { fromDay: "2026-11-14", days: 99 },
    {},
  ]) {
    assert.equal(computeRescanWindow(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(judgeWindowClosed({ window: W, nowMs: W.endMs - 1 }).ok, false);
  assert.match(
    judgeWindowClosed({ window: W, nowMs: W.endMs - 1 }).reason,
    /창이 아직 닫히지 않음/,
  );
  assert.equal(judgeWindowClosed({ window: W, nowMs: W.endMs }).ok, true);
});

// ---- ⑵ 합집합 -------------------------------------------------------------------------------------------------------

test("⑵ 실행 2회 합집합 -- 같은 리뷰 · 같은 PR 중복 1 · 두 번째 실행이 못 본 사건도 남는다", () => {
  // 실행 1: PR 목록 + PR 11 리뷰(변경 요청 501) + PR 12 리뷰(0)
  let s = sweep(fresh());
  s = reviews(s, 11, REVIEWS_11);
  s = reviews(s, 12, []);
  s = recordRescanRun({ state: s, atMs: NOW, calls: 4, stop: "budget" });
  assert.equal(countRescanEvents(s).changeRequest, 1);
  assert.equal(countRescanEvents(s).unmergedClose, 1);
  // 실행 2: PR 목록을 다시 쓸었는데 PR 12 가 응답에 없다 · PR 11 응답은 501 을 담지 않고(못 봄) 새 변경 요청 503 만 · PR 13 리뷰 추가
  const sweepAgain = [SWEEP_PAGE[0], SWEEP_PAGE[2], SWEEP_PAGE[3]];
  s = sweep(s, { nowMs: NOW + 3 * HOUR, pages: [sweepAgain] });
  s = reviews(s, 11, [review(503, "CHANGES_REQUESTED", "2026-11-16 12:00")]);
  s = reviews(s, 13, REVIEWS_13);
  const counts = countRescanEvents(s);
  assert.equal(counts.changeRequest, 3, "501(못 봄 · 남음) + 503 + 504");
  assert.equal(
    counts.unmergedClose,
    1,
    "PR 12 가 두 번째 응답에 없어도 남는다",
  );
  assert.deepEqual(s.prSweep.listPrs, [11, 12, 13]);
  // 같은 응답을 한 번 더 먹여도 변하지 않는다(멱등)
  const again = reviews(s, 13, REVIEWS_13);
  assert.deepEqual(again.events, s.events);
  assert.equal(Object.keys(s.events).length, 4);
});

test("⑵ 같은 PR 이 목록 ∪ git 병합 번호 양쪽에 있어도 1 · 출처는 따로 센다", () => {
  const s = sweep(fresh());
  assert.deepEqual(s.prSweep.listPrs, [11, 12, 13]);
  assert.deepEqual(s.prSweep.gitPrs, [11, 15]);
  const again = sweep(s, { git: [11, 15, 16] });
  assert.deepEqual(again.prSweep.gitPrs, [11, 15, 16]);
  assert.deepEqual(rescanPrNumbersOf(again), [11, 12, 13, 15, 16]);
  assert.equal(countRescanEvents(again).unmergedClose, 1);
});
const rescanPrNumbersOf = (state) => rescan.rescanPrNumbers(state);

test("⑵ mergeRescanEvents -- 같은 키는 먼저 본 기록이 이기고 새 키만 더해진다 · 입력 무변", () => {
  const base = { "cr:1": { kind: "changeRequest", atMs: 10 } };
  const merged = mergeRescanEvents(base, [
    { key: "cr:1", kind: "changeRequest", atMs: 99 },
    { key: "cr:2", kind: "changeRequest", atMs: 20 },
  ]);
  assert.deepEqual(merged, {
    "cr:1": { kind: "changeRequest", atMs: 10 },
    "cr:2": { kind: "changeRequest", atMs: 20 },
  });
  assert.deepEqual(base, { "cr:1": { kind: "changeRequest", atMs: 10 } });
  assert.deepEqual(mergeRescanEvents(merged, []), merged);
});

test("⑵ absorb 함수는 입력 상태를 바꾸지 않는다(새 객체)", () => {
  const before = completeState();
  const snapshot = JSON.stringify(before);
  sweep(before, { nowMs: NOW + HOUR });
  reviews(before, 11, REVIEWS_11);
  comments(before, "issueComments", [ISSUE_COMMENTS]);
  markUnitFailed({ state: before, unit: "prSweep", reason: "x" });
  recordRescanRun({ state: before, atMs: NOW, calls: 1 });
  assert.equal(JSON.stringify(before), snapshot);
});

// ---- ⑶ 예산 ---------------------------------------------------------------------------------------------------------

test("⑶ 예산 -- 실행당 10 · 직전 60분 합 10 · 넘으면 호출 0 + 다음 실행 가능 시각", () => {
  const empty = fresh();
  assert.deepEqual(planRunBudget({ state: empty, nowMs: NOW }), {
    ok: true,
    allowedCalls: 10,
    usedLastHour: 0,
    nextRunAtMs: null,
  });
  assert.equal(
    planRunBudget({ state: empty, nowMs: NOW, maxCalls: 4 }).allowedCalls,
    4,
  );
  assert.equal(
    planRunBudget({ state: empty, nowMs: NOW, maxCalls: 99 }).allowedCalls,
    10,
  );
  for (const bad of [0, -1, 1.5, Number.NaN, "10"]) {
    assert.equal(
      planRunBudget({ state: empty, nowMs: NOW, maxCalls: bad }).ok,
      false,
      String(bad),
    );
  }
  // 직전 60분에 4회 쓴 뒤 = 남은 6
  const used4 = runs(empty, [[NOW - 30 * MIN, 4, null]]);
  const six = planRunBudget({ state: used4, nowMs: NOW });
  assert.equal(six.allowedCalls, 6);
  assert.equal(six.usedLastHour, 4);
  // 직전 60분 합이 10 -> 호출 0 · 가장 이른 실행이 빠지는 때 = 그 실행 + 60분
  const full = runs(empty, [
    [NOW - 50 * MIN, 6, "budget"],
    [NOW - 20 * MIN, 4, "budget"],
  ]);
  const blocked = planRunBudget({ state: full, nowMs: NOW });
  assert.equal(blocked.allowedCalls, 0);
  assert.equal(blocked.usedLastHour, 10);
  assert.equal(blocked.nextRunAtMs, NOW - 50 * MIN + HOUR);
  // 그 시각이 되면 첫 실행이 빠져 6 이 열린다
  assert.equal(
    planRunBudget({ state: full, nowMs: blocked.nextRunAtMs }).allowedCalls,
    6,
  );
  // 한 칸 앞에서는 아직 0
  assert.equal(
    planRunBudget({ state: full, nowMs: blocked.nextRunAtMs - 1 }).allowedCalls,
    0,
  );
});

test("⑶ 60분 창의 경계 -- 정확히 60분 전 실행은 합에서 빠지고 · 59분 59초 전은 든다 · 오래된 실행은 무관", () => {
  const empty = fresh();
  const exactly60 = runs(empty, [[NOW - HOUR, 10, null]]);
  assert.equal(
    planRunBudget({ state: exactly60, nowMs: NOW }).allowedCalls,
    10,
  );
  const justInside = runs(empty, [[NOW - HOUR + 1, 10, null]]);
  const verdict = planRunBudget({ state: justInside, nowMs: NOW });
  assert.equal(verdict.allowedCalls, 0);
  assert.equal(verdict.nextRunAtMs, NOW + 1);
  const old = runs(empty, [
    [NOW - 5 * HOUR, 10, null],
    [NOW - 3 * HOUR, 10, null],
  ]);
  assert.equal(planRunBudget({ state: old, nowMs: NOW }).allowedCalls, 10);
});

test("⑶ 예산 합은 실행 하나가 10 을 넘게 쓴 기록(손 편집)이어도 남은 몫을 음수로 만들지 않는다", () => {
  const over = runs(fresh(), [[NOW - 10 * MIN, 25, null]]);
  const verdict = planRunBudget({ state: over, nowMs: NOW });
  assert.equal(verdict.allowedCalls, 0);
  assert.equal(verdict.nextRunAtMs, NOW - 10 * MIN + HOUR);
});

// ---- ⑷ 남은 미조회 -------------------------------------------------------------------------------------------------

test("⑷ 전부 끝나면 남은 미조회 0 · 완료", () => {
  const remaining = judgeRescanRemaining(completeState());
  assert.equal(remaining.complete, true);
  assert.equal(remaining.total, 0);
  assert.deepEqual(remaining.unqueried, {
    sweep: 0,
    prReviews: 0,
    lists: 0,
    d1: 0,
    failed: 0,
  });
});

test("⑷ PR 쓸기 전에는 다른 건 전부 끝나 있어도 0 이라 말하지 않는다", () => {
  // 쓸기만 «창이 닫히기 전» 시각으로 먹이면 끝나지 않는다(닫힌 뒤의 쓸기 1회가 꼭 필요)
  const early = sweep(fresh(), { nowMs: W.endMs - 1 });
  assert.equal(early.prSweep.done, false);
  let s = early;
  for (const [n, pages] of [
    [11, REVIEWS_11],
    [12, []],
    [13, REVIEWS_13],
    [15, REVIEWS_15],
  ]) {
    s = reviews(s, n, pages);
  }
  s = comments(s, "issueComments", [ISSUE_COMMENTS]);
  s = comments(s, "reviewComments", REVIEW_COMMENT_PAGES);
  s = registerUpdateBranchCandidates({ state: s, shas: [] });
  const remaining = judgeRescanRemaining(s);
  assert.equal(remaining.complete, false);
  assert.equal(remaining.unqueried.sweep, 1);
  assert.ok(remaining.total >= 1);
  // 아무것도 안 한 새 상태도 0 이 아니다
  assert.ok(judgeRescanRemaining(fresh()).total >= 1);
  // 닫힌 뒤 쓸기를 하면 완료
  const done = sweep(s, { nowMs: NOW });
  assert.equal(judgeRescanRemaining(done).complete, true);
});

test("⑷ 쓸기 마지막 쪽이 창 시작까지 닿지 못하면(100건 꽉 참 · 끝 항목이 창 안) 쓸기는 끝난 것이 아니다", () => {
  const full = Array.from({ length: 100 }, (_, i) =>
    prItem(1000 + i, { state: "open", updatedAt: "2026-11-18 09:00" }),
  );
  const s = sweep(fresh(), { pages: [full], git: [] });
  assert.equal(s.prSweep.done, false);
  assert.equal(judgeRescanRemaining(s).unqueried.sweep, 1);
  assert.equal(s.prSweep.listPrs.length, 100, "본 PR 은 모은다");
  // 마지막 항목이 창 시작 이전이면 닿은 것
  const reached = [
    ...full.slice(0, 99),
    prItem(2000, { state: "open", updatedAt: "2026-11-01 09:00" }),
  ];
  assert.equal(
    sweep(fresh(), { pages: [reached], git: [] }).prSweep.done,
    true,
  );
  // 쪽이 0 개(아무 응답도 못 받음)는 끝난 것이 아니다
  assert.equal(sweep(fresh(), { pages: [], git: [] }).prSweep.done, false);
});

test("⑷ 조건 하나씩 빼면 미완 -- 리뷰 · 목록 둘 · D1 · 후보 수집 · 실패", () => {
  const base = () => {
    let s = sweep(fresh());
    for (const [n, pages] of [
      [11, REVIEWS_11],
      [12, []],
      [13, REVIEWS_13],
      [15, REVIEWS_15],
    ]) {
      s = reviews(s, n, pages);
    }
    s = comments(s, "issueComments", [ISSUE_COMMENTS]);
    s = comments(s, "reviewComments", REVIEW_COMMENT_PAGES);
    return registerUpdateBranchCandidates({ state: s, shas: [SHA_A] });
  };
  const finish = (s) =>
    recordUpdateBranchResult({
      state: s,
      sha: SHA_A,
      counted: false,
      atMs: NOW,
    });
  assert.equal(judgeRescanRemaining(finish(base())).complete, true);
  // D1 후보 결과를 못 받음
  const noD1 = judgeRescanRemaining(base());
  assert.equal(noD1.complete, false);
  assert.equal(noD1.unqueried.d1, 1);
  // D1 후보 수집 자체를 안 함
  let uncollected = sweep(fresh());
  for (const [n, pages] of [
    [11, REVIEWS_11],
    [12, []],
    [13, REVIEWS_13],
    [15, REVIEWS_15],
  ]) {
    uncollected = reviews(uncollected, n, pages);
  }
  uncollected = comments(uncollected, "issueComments", [ISSUE_COMMENTS]);
  uncollected = comments(uncollected, "reviewComments", REVIEW_COMMENT_PAGES);
  assert.equal(judgeRescanRemaining(uncollected).unqueried.d1, 1);
  // 리뷰 하나가 쪽 남음(pending)
  const partial = reviews(finish(base()), 13, REVIEWS_13, false);
  assert.equal(partial.reviews["13"].state, "pending");
  assert.equal(judgeRescanRemaining(partial).unqueried.prReviews, 1);
  // PR 하나의 리뷰를 아직 안 부름(git 병합 번호로만 늘어난 PR)
  const grown = sweep(finish(base()), { git: [11, 15, 16] });
  assert.equal(judgeRescanRemaining(grown).unqueried.prReviews, 1);
  assert.deepEqual(planRescanTargets(grown).reviews, [16]);
  // 목록 하나(리뷰 줄 댓글)를 안 부름
  let noList = sweep(fresh());
  for (const [n, pages] of [
    [11, REVIEWS_11],
    [12, []],
    [13, REVIEWS_13],
    [15, REVIEWS_15],
  ]) {
    noList = reviews(noList, n, pages);
  }
  noList = comments(noList, "issueComments", [ISSUE_COMMENTS]);
  noList = finish(
    registerUpdateBranchCandidates({ state: noList, shas: [SHA_A] }),
  );
  const lists = judgeRescanRemaining(noList);
  assert.equal(lists.unqueried.lists, 1);
  assert.deepEqual(planRescanTargets(noList).lists, ["reviewComments"]);
});

// ---- ⑸ 실패 단위 ---------------------------------------------------------------------------------------------------

test("⑸ 실패 단위는 수집 실패로 세고 다음 실행 대상이 된다 -- 다음에 성공하면 풀린다", () => {
  const ok = completeState();
  const failed = markUnitFailed({
    state: ok,
    unit: "reviews",
    key: 13,
    reason: "HTTP 502",
  });
  const remaining = judgeRescanRemaining(failed);
  assert.equal(remaining.complete, false);
  assert.equal(remaining.unqueried.failed, 1);
  assert.equal(remaining.unqueried.prReviews, 0, "실패는 한 번만 센다");
  assert.equal(failed.reviews["13"].reason, "HTTP 502");
  assert.deepEqual(planRescanTargets(failed).reviews, [13]);
  // 이미 센 사건은 실패 표시로 지워지지 않는다
  assert.deepEqual(failed.events, ok.events);
  // 다음 실행에서 성공
  const healed = reviews(failed, 13, REVIEWS_13);
  assert.equal(judgeRescanRemaining(healed).complete, true);
  assert.deepEqual(planRescanTargets(healed).reviews, []);
});

test("⑸ 응답 모양 위반(배열 아님)은 그 단위만 실패 -- 쓸기 · 리뷰 · 목록 · D1 각각", () => {
  const ok = completeState();
  const badSweep = absorbPrSweep({
    state: ok,
    pages: "not-an-array",
    window: W,
    nowMs: NOW,
    botLogins: BOTS,
  });
  assert.match(badSweep.prSweep.failure, /모양 위반/);
  assert.equal(judgeRescanRemaining(badSweep).unqueried.failed, 1);
  assert.equal(planRescanTargets(badSweep).sweep, true);
  assert.equal(
    judgeRescanRemaining(sweep(badSweep)).complete,
    true,
    "다음 성공 응답이 실패를 지운다",
  );

  const badReview = absorbReviewPages({
    state: ok,
    prNumber: 11,
    pages: [{ not: "array" }],
    complete: true,
    window: W,
    botLogins: BOTS,
  });
  assert.equal(badReview.reviews["11"].state, "failed");
  assert.equal(
    countRescanEvents(badReview).changeRequest,
    3,
    "먼저 센 사건 보존",
  );

  const badList = comments(ok, "issueComments", ["oops"]);
  assert.match(badList.lists.issueComments.failure, /모양 위반/);
  assert.equal(judgeRescanRemaining(badList).unqueried.failed, 1);
  assert.deepEqual(planRescanTargets(badList).lists, ["issueComments"]);
  assert.equal(
    judgeRescanRemaining(comments(badList, "issueComments", [ISSUE_COMMENTS]))
      .complete,
    true,
  );

  const badD1 = markUnitFailed({
    state: ok,
    unit: "d1",
    key: SHA_A,
    reason: "404",
  });
  assert.equal(judgeRescanRemaining(badD1).unqueried.failed, 1);
  assert.deepEqual(planRescanTargets(badD1).d1, [SHA_A]);
  assert.throws(
    () => markUnitFailed({ state: ok, unit: "nope", reason: "x" }),
    RangeError,
  );
  assert.throws(() => comments(ok, "closedPrs", [[]]), RangeError);
});

test("⑸ 읽을 수 없는 변경 요청 · 기각 리뷰는 0 으로 접지 않고 판정 불가로 센다 -- 완료여도 선언 재료는 불가", () => {
  const unreadable = [
    { id: 9001, state: "CHANGES_REQUESTED", user: { login: HUMAN } },
    { id: 9002, state: "DISMISSED", submitted_at: iso("2026-11-16 09:00") },
    review(9003, "APPROVED", "2026-11-16 09:00"),
  ];
  const s = reviews(completeState(), 12, unreadable);
  assert.equal(s.reviews["12"].undecidable, 2);
  const out = renderRescanReport({ state: s, window: W, nowMs: NOW });
  assert.equal(out.undecidable, 2);
  assert.equal(out.complete, true);
  assert.equal(out.declarationReady, false);
  assert.ok(out.lines[3].startsWith("선언 재료: 불가 — "));
  assert.ok(out.lines[3].includes("판정 불가 2"));
  assert.equal(out.exit, RESCAN_EXIT.COMPLETE);
});

// ---- ⑺ 기각된 리뷰 ---------------------------------------------------------------------------------------------------

test("⑺ 기각된 리뷰는 ㄴ 분자에 들어가고 끄는 길이 없다 -- 인자를 줘도 무시", () => {
  const withOption = absorbReviewPages({
    state: fresh(),
    prNumber: 15,
    pages: [REVIEWS_15],
    complete: true,
    window: W,
    botLogins: BOTS,
    includeDismissed: false,
    countDismissed: false,
  });
  const counts = countRescanEvents(withOption, { includeDismissed: false });
  assert.equal(
    counts.dismissedReview,
    1,
    "601 (사람 · 창 안) · 602 는 봇이라 제외",
  );
  assert.equal(counts.changeRequest, 1, "603");
  assert.equal(counts.numerator, 2, "기각 1 + 변경 요청 1 이 분자에 함께");
  assert.equal(Object.keys(withOption.events).sort().join(), "cr:603,dr:601");
});

test("⑺ 같은 리뷰가 앞 실행엔 변경 요청 · 뒤 실행엔 기각으로 보이면 «변경 요청» 에만 1번", () => {
  let s = reviews(fresh(), 11, [
    review(501, "CHANGES_REQUESTED", "2026-11-16 10:00"),
  ]);
  assert.equal(countRescanEvents(s).changeRequest, 1);
  s = reviews(s, 11, [review(501, "DISMISSED", "2026-11-16 10:00")]);
  const counts = countRescanEvents(s);
  assert.equal(counts.changeRequest, 1);
  assert.equal(counts.dismissedReview, 0);
  assert.equal(counts.numerator, 1);
  // 처음부터 기각으로만 본 다른 리뷰는 기각된 리뷰 1
  s = reviews(s, 11, [review(777, "dismissed", "2026-11-16 10:00")]);
  assert.equal(countRescanEvents(s).dismissedReview, 1);
  assert.equal(countRescanEvents(s).numerator, 2);
  // 창 밖 · 봇의 기각은 세지 않는다
  s = reviews(s, 11, [
    review(778, "DISMISSED", "2026-11-05 10:00"),
    review(779, "DISMISSED", "2026-11-16 10:00", BOT),
  ]);
  assert.equal(countRescanEvents(s).dismissedReview, 1);
});

test("⑺ 렌더 -- 기각된 리뷰는 따로 «기각된 리뷰 n(원래 상태 미상)» 으로 보이고 분자 합(numerator)에는 들어 있다", () => {
  const out = renderRescanReport({
    state: completeState(),
    window: W,
    nowMs: NOW,
  });
  assert.ok(out.lines[1].includes("기각된 리뷰 1(원래 상태 미상)"));
  assert.equal(out.counts.numerator, 9);
});

// ---- ⑹ 렌더 · KST 고정 -------------------------------------------------------------------------------------------------

const COMPLETE_RUNS = [
  [kst("2026-11-21 06:00"), 10, "budget"],
  [kst("2026-11-21 09:00"), 7, null],
];

test("⑹ 줄 형식 고정 -- 완료 표본(손으로 센 값)", () => {
  const state = runs(completeState(), COMPLETE_RUNS);
  const out = renderRescanReport({ state, window: W, nowMs: NOW });
  const expected = [
    "전수 재조회 창: 2026-11-14 00:00 KST ~ 2026-11-21 00:00 KST (캐시 끔 · 실행 2회 · 호출 17)",
    "ㄴ GitHub 사람 손(창 전체): 변경 요청 3 · 미병합 닫기 1 · 대화 댓글 1 · 리뷰 줄 댓글 2 · Update branch 1 · 기각된 리뷰 1(원래 상태 미상) · 판정 불가 0",
    "조회 범위: PR 4개(목록 3 ∪ git 병합 2) · 리뷰 응답 쪽 4 · 목록 쪽 4 · D1 후보 2",
    "선언 재료: 가능",
    "전수 재조회: 완료 — 남은 미조회 0",
  ];
  assert.deepEqual(out.lines, expected);
  assert.equal(out.exit, 0);
  assert.equal(out.complete, true);
  assert.equal(out.declarationReady, true);
});

// 미완 표본: 쓸기 끝 · PR 11 · 12 리뷰 끝 · PR 13 실패 · PR 15 미조회 · 목록 둘 끝 · D1 sha A 끝 · sha B 미조회.
function incompleteState() {
  let s = sweep(fresh());
  s = reviews(s, 11, REVIEWS_11);
  s = reviews(s, 12, []);
  s = markUnitFailed({
    state: s,
    unit: "reviews",
    key: 13,
    reason: "HTTP 502",
  });
  s = comments(s, "issueComments", [ISSUE_COMMENTS]);
  s = comments(s, "reviewComments", REVIEW_COMMENT_PAGES);
  s = registerUpdateBranchCandidates({ state: s, shas: [SHA_A, SHA_B] });
  s = recordUpdateBranchResult({
    state: s,
    sha: SHA_A,
    counted: true,
    atMs: kst("2026-11-19 12:00"),
  });
  return runs(s, [
    [kst("2026-11-21 06:00"), 10, "budget"],
    [kst("2026-11-21 09:30"), 10, "budget"],
  ]);
}

test("⑹ 줄 형식 고정 -- 미완 표본(남은 미조회 · 다음 실행 가능 시각 · 선언 재료 불가)", () => {
  const out = renderRescanReport({
    state: incompleteState(),
    window: W,
    nowMs: NOW,
  });
  const expected = [
    "전수 재조회 창: 2026-11-14 00:00 KST ~ 2026-11-21 00:00 KST (캐시 끔 · 실행 2회 · 호출 20)",
    "ㄴ GitHub 사람 손(창 전체): 변경 요청 1 · 미병합 닫기 1 · 대화 댓글 1 · 리뷰 줄 댓글 2 · Update branch 1 · 기각된 리뷰 0(원래 상태 미상) · 판정 불가 0",
    "조회 범위: PR 4개(목록 3 ∪ git 병합 2) · 리뷰 응답 쪽 2 · 목록 쪽 4 · D1 후보 2",
    "선언 재료: 불가 — 미완(남은 미조회 3)",
    "전수 재조회: 미완 — 남은 미조회 3(PR 쓸기 0 · PR 리뷰 1 · 목록 0 · D1 1 · 수집 실패 1) — 다음 실행 가능 ≥ 10:30 KST",
  ];
  assert.deepEqual(out.lines, expected);
  assert.equal(out.complete, false);
  assert.equal(out.declarationReady, false);
});

test("⑹ 미완 줄의 «다음 실행 가능 ≥» -- 예산이 남으면 지금 · 막히면 60분 창이 풀리는 시각", () => {
  const roomy = runs(incompleteState(), []);
  const lastLine = (state, nowMs) => {
    const out = renderRescanReport({ state, window: W, nowMs });
    return out.lines[out.lines.length - 1];
  };
  // 직전 60분 합 0 -> 지금(10:00)부터
  const idle = { ...roomy, runs: [] };
  assert.ok(lastLine(idle, NOW).endsWith("다음 실행 가능 ≥ 10:00 KST"));
  // 직전 60분 합 10 -> 가장 이른 실행 + 60분
  assert.ok(
    lastLine(incompleteState(), NOW).endsWith("다음 실행 가능 ≥ 10:30 KST"),
  );
});

test("⑹ 창 · 시각 표기는 KST 고정(+09:00) -- 시스템 시간대가 바뀌어도 줄이 같다", () => {
  const original = process.env.TZ;
  const expectedLines = renderRescanReport({
    state: runs(completeState(), COMPLETE_RUNS),
    window: W,
    nowMs: NOW,
  }).lines;
  try {
    for (const tz of [
      "UTC",
      "America/Los_Angeles",
      "Pacific/Kiritimati",
      "Asia/Seoul",
    ]) {
      process.env.TZ = tz;
      assert.equal(
        new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone,
        tz,
        `시험 환경이 ${tz} 로 바뀌었는가`,
      );
      const window = computeRescanWindow({ fromDay: "2026-11-14", days: 7 });
      assert.equal(window.startMs, Date.UTC(2026, 10, 13, 15, 0, 0), tz);
      assert.equal(window.startLabel, "2026-11-14 00:00 KST", tz);
      assert.equal(window.endLabel, "2026-11-21 00:00 KST", tz);
      const lines = renderRescanReport({
        state: runs(completeState(), COMPLETE_RUNS),
        window,
        nowMs: NOW,
      }).lines;
      assert.deepEqual(lines, expectedLines, tz);
      const incomplete = renderRescanReport({
        state: incompleteState(),
        window,
        nowMs: NOW,
      });
      assert.ok(
        incomplete.lines[4].endsWith("다음 실행 가능 ≥ 10:30 KST"),
        `${tz}: ${incomplete.lines[4]}`,
      );
      assert.equal(
        rescan.kstMinuteLabel(kst("2026-11-21 23:59")),
        "2026-11-21 23:59 KST",
        tz,
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ---- ⑻ 미완은 0 이 아니다 · 종료 값 -------------------------------------------------------------------------------------

test("⑻ 완료가 아닌 실행은 종료 값 3 · 마지막 줄 «전수 재조회: 미완 — 남은 미조회 U(…)» -- PR 쓸기 전", () => {
  const out = renderRescanReport({ state: fresh(), window: W, nowMs: NOW });
  assert.equal(out.exit, RESCAN_EXIT.INCOMPLETE);
  assert.equal(RESCAN_EXIT.INCOMPLETE, 3);
  const last = out.lines[out.lines.length - 1];
  assert.match(last, /^전수 재조회: 미완 — 남은 미조회 [1-9]\d*\(PR 쓸기 1 · /);
  assert.equal(last.includes("남은 미조회 0"), false);
  assert.equal(
    out.lines.some((l) => l.includes("완료 — 남은 미조회 0")),
    false,
  );
  assert.equal(out.declarationReady, false);
});

test("⑻ 완료가 아닌 실행은 종료 값 3 -- 실패 단위가 남음", () => {
  const state = markUnitFailed({
    state: completeState(),
    unit: "lists",
    key: "reviewComments",
    reason: "HTTP 500",
  });
  const out = renderRescanReport({ state, window: W, nowMs: NOW });
  assert.equal(out.exit, 3);
  const last = out.lines[out.lines.length - 1];
  assert.match(
    last,
    /^전수 재조회: 미완 — 남은 미조회 1\(PR 쓸기 0 · PR 리뷰 0 · 목록 0 · D1 0 · 수집 실패 1\)/,
  );
});

test("⑻ 완료가 아닌 실행은 종료 값 3 -- 리뷰 미조회가 남음 · 센 수가 0 이어도 0 건 완료가 아니다", () => {
  // 사건이 하나도 없는 상태에서 PR 하나의 리뷰만 안 본 경우 -- ㄴ 줄 값은 0 이지만 신호는 미완
  let s = sweep(fresh(), { pages: [[SWEEP_PAGE[3]]], git: [20] });
  s = comments(s, "issueComments", [[]]);
  s = comments(s, "reviewComments", [[]]);
  s = registerUpdateBranchCandidates({ state: s, shas: [] });
  const out = renderRescanReport({ state: s, window: W, nowMs: NOW });
  assert.equal(out.counts.numerator, 0);
  assert.equal(out.exit, 3);
  assert.match(
    out.lines[out.lines.length - 1],
    /^전수 재조회: 미완 — 남은 미조회 1\(PR 쓸기 0 · PR 리뷰 1 · 목록 0 · D1 0 · 수집 실패 0\)/,
  );
  // 그 PR 의 리뷰를 보면 사건 0 이어도 «완료» 가 된다 -- 완료일 때만 0
  s = reviews(s, 20, []);
  const done = renderRescanReport({ state: s, window: W, nowMs: NOW });
  assert.equal(done.exit, 0);
  assert.equal(
    done.lines[done.lines.length - 1],
    "전수 재조회: 완료 — 남은 미조회 0",
  );
});

test("⑻ 종료 값 -- 완료 0 · 미완 3 · 거부/고장 1(상태 깨짐 · fingerprint)", () => {
  assert.deepEqual(RESCAN_EXIT, { COMPLETE: 0, REFUSED: 1, INCOMPLETE: 3 });
  assert.equal(
    rescan.rescanExitValue(judgeRescanRemaining(completeState())),
    0,
  );
  assert.equal(rescan.rescanExitValue(judgeRescanRemaining(fresh())), 3);
  assert.equal(
    acceptRescanState({ stateValue: { schema: "x" }, expectedFingerprint: FP })
      .exit,
    1,
  );
});

// ---- 정직 한계 · 순수성 ---------------------------------------------------------------------------------------------

test("정직 한계 문면 -- 승인 리뷰 자동 기각 과대 계수 · 상태 파일 독립 앵커 아님 · 실제 응답 미측이 내보내진다", () => {
  const joined = rescan.RESCAN_HONESTY_LIMITS.join("\n");
  assert.ok(joined.includes("독립 앵커가 아니다"));
  assert.ok(joined.includes("지워진 댓글"));
  assert.ok(joined.includes("updated_at"));
  assert.ok(joined.includes("자동으로 기각된 경우"));
  assert.ok(joined.includes("실제보다 높게 찍힐 수 있다"));
  assert.ok(joined.includes("실제 GitHub 응답은 재지 않았다"));
  assert.ok(Object.isFrozen(rescan.RESCAN_HONESTY_LIMITS));
  const src = fs.readFileSync(
    new URL("./partial-count-rescan-core.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("자동으로 기각된 경우도"), "모듈 머리 주석에도 있다");
});

test("순수 모듈 -- core 밖 import 0 · 파일 · 망 · 자식 프로세스 접근 0", () => {
  const src = fs.readFileSync(
    new URL("./partial-count-rescan-core.mjs", import.meta.url),
    "utf8",
  );
  const code = src.replace(/\/\/.*$/gm, "");
  const specs = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(specs, ["./partial-count-core.mjs"]);
  for (const banned of [
    "node:fs",
    "node:child_process",
    "fetch(",
    "process.env",
    "Date.now(",
    "new Date(",
  ]) {
    assert.equal(code.includes(banned), false, banned);
  }
  // core 파일은 이 라운드가 건드리지 않는다는 점은 git diff 로 대조(결과 파일)
});
