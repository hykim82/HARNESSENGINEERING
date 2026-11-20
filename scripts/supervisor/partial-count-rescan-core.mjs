// HYK-255-rescan-core-1 (판정 #20261120-1424 3 레인 1 · PM 설계 2026-11-20 조각 R1 · 판정 #20261120-1519) -- 전수 재조회 core.
//
// 무엇: 1-C 선언 직전 «캐시 끔 전수 재조회» 가 여러 번에 나눠 돌 때, 그 합을 중복 없이 하나로 모으고 «정말 다 본 때만» 완료라고
// 말하는 판정 심장. 순수 함수 모음이다 -- I/O 0 · 시계 · 망 · 파일 접근은 전부 인자로 받는다(CLI · 망 연결 = R2).
//   - 상태 파일 모양 `partial-count-rescan-state/v1` 검증 · fingerprint 대조(다르면 거부 · 섞지 않는다)
//   - 사건 키 합집합(같은 리뷰 · 같은 PR 은 몇 번 봐도 1 · 한 번 본 사건은 뒤 실행이 못 봐도 지우지 않는다)
//   - 실행 예산 계획(실행당 10 · 직전 60분 합 10 · 넘으면 호출 0 + «다음 실행 가능 ≥ 시각»)
//   - 남은 미조회 판정(PR 쓸기 끝 ∧ 리뷰 전부 ∧ 목록 둘 ∧ D1 ∧ 실패 0 -- PR 쓸기 전에는 0 이라 말하지 않는다)
//   - 출력 줄 렌더(KST 고정 +09:00 · 시스템 시간대 무관) · 종료 값(완료 0 · 미완 3 · 거부/고장 1)
//
// 셈 규칙은 새로 쓰지 않는다 -- partial-count-core 의 summarizeGithubList · summarizeChangeRequests · githubListCoversWindow ·
// DAILY_EVENT_PREFIX(D1) · KST 함수를 import 해서 부른다(정의 두 벌 금지). 사건 키 접두(cr: pr: ic: rc:)는 그 함수가 돌려준 식별자에
// 이미 붙어 있다 -- 이 파일은 그 접두를 다시 적지 않는다.
//
// 판정 #20261120-1519(책임자):
//   3. 기각된 리뷰(state DISMISSED)는 ㄴ 분자에 «넣는다». 설정 · 인자로 끄고 켜는 길 0(선택지를 남기면 좋아 보이는 쪽으로 쓰인다).
//      표기는 따로 = «기각된 리뷰 n건(원래 상태를 응답에서 알 수 없음)» (판정 #20261120-2346 3 문면 그대로). 같은 리뷰가 앞 실행에 변경 요청으로 보였다면 그 건은 «변경 요청» 에만 센다(1건 1번).
//   창 문(R2 · 판정 #20261120-2346 3 · R1 검토 P2 둘째): 모든 흡수(PR 쓸기 · 리뷰 · 댓글 · D1)는 «창이 닫힌 뒤» 에만 한다(닫히기 전이면 RangeError).
//      닫히기 전 시각으로 «done» 이 찍힌 단위(리뷰 · D1 · 쓸기 · 목록 · D1 후보 수집)는 done 으로 치지 않아 닫힌 뒤 실행이 다시 부른다(사건 합집합은 그대로).
//   - 완료가 아닌 실행은 «0건» 이 아니라 «미완» 으로 찍는다(종료 값 3 · 마지막 줄 «전수 재조회: 미완 — 남은 미조회 U(…)»).
//
// ⚠️정직 한계(그대로 RESCAN_HONESTY_LIMITS 로 내보낸다):
//   ⑴ 상태 파일은 ORCH 가 쓸 수 있는 파일이라 독립 앵커가 아니다 -- 사건을 위조로 더하거나 지울 수 있다(봉인은 S1 계열 몫).
//   ⑵ 첫 실행 전에 지워진 댓글과 웹 화면에서 보기만 한 행위는 셀 수 없다(기존 수집기 한계 그대로).
//   ⑶ 열린 PR 의 updated_at 이 리뷰 제출 때 갱신된다는 가정은 미확인이다(R2 에서 실제 응답 1건으로 값 확인).
//   ⑷ 승인 리뷰가 새 커밋 때문에 자동으로 기각된 경우도 «기각된 리뷰» 로 같은 모양으로 잡혀 ㄴ 이 실제보다 높게 찍힐 수 있다
//      (높은 쪽 오차 · 그때는 사람이 그 건을 보고 판정한다 · 누가 기각했는지 가르는 것은 등재 후보).
//   ⑸ 실제 GitHub 응답은 재지 않았다 -- R2 전에는 실행 수단이 아니다.
//   ⑹ 범위 = GitHub 쪽 ㄴ 종류(변경 요청 · 미병합 닫기 · 대화 댓글 · 리뷰 줄 댓글 · Update branch · 기각된 리뷰). 권한 확인창 사람 답은 이 수단 밖.
//
// 설계(다)의 상태 모양과 다른 점(전부 덧붙임 · 이름 바꿈 1): prSweep 에 listPrs · gitPrs(출처 둘을 따로 보관 -- «목록 n1 ∪ git 병합 n2» 줄의
// 재료) · doneAtMs · pages · failure / lists 칸마다 doneAtMs · pages · failure / d1 = {collected, shas} / reviews 칸마다 pages · undecidable /
// D1 사건 접두는 설계의 `ub:` 대신 core 가 이미 쓰는 DAILY_EVENT_PREFIX.D1(`sha:`)을 재사용한다.
import {
  DAILY_EVENT_PREFIX,
  formatKst,
  githubListCoversWindow,
  kstDayOf,
  kstDayStartMs,
  summarizeChangeRequests,
  summarizeGithubList,
} from "./partial-count-core.mjs";

export const RESCAN_STATE_SCHEMA = "partial-count-rescan-state/v1";
export const RESCAN_MAX_CALLS_PER_RUN = 10;
export const RESCAN_HOURLY_CALL_CAP = 10;
export const RESCAN_BUDGET_WINDOW_MS = 60 * 60 * 1000;
export const RESCAN_MAX_DAYS = 31;
// 종료 값 -- 완료 0 · 거부/고장 1 · 미완 3(다시 실행). 마지막 줄 문면이 신호의 정본이다.
export const RESCAN_EXIT = Object.freeze({
  COMPLETE: 0,
  REFUSED: 1,
  INCOMPLETE: 3,
});
export const RESCAN_COMMENT_LIST_KEYS = Object.freeze([
  "issueComments",
  "reviewComments",
]);
export const RESCAN_HONESTY_LIMITS = Object.freeze([
  "상태 파일은 ORCH 가 쓸 수 있어 독립 앵커가 아니다(사건을 위조로 더하거나 지울 수 있다)",
  "첫 실행 전에 지워진 댓글과 웹 화면에서 보기만 한 행위는 셀 수 없다",
  "열린 PR 의 updated_at 이 리뷰 제출 때 갱신된다는 가정은 미확인이다(R2 에서 실제 응답 1건으로 값 확인)",
  "승인 리뷰가 새 커밋 때문에 자동으로 기각된 경우도 «기각된 리뷰» 로 같은 모양으로 잡혀 ㄴ 이 실제보다 높게 찍힐 수 있다(높은 쪽 오차 · 그때는 사람이 그 건을 보고 판정한다 · 누가 기각했는지 가르는 것은 등재 후보)",
  "실제 GitHub 응답은 재지 않았다 -- R2 전에는 실행 수단이 아니다",
  "범위 = GitHub 쪽 ㄴ 종류뿐이다 -- 권한 확인창 사람 답은 이 수단 밖이다",
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const PR_KEY_RE = /^[1-9]\d*$/;
const DISMISSED_REVIEW_PREFIX = "dr:";
const FINGERPRINT_KEYS = Object.freeze([
  "fromDay",
  "days",
  "repo",
  "botListBlob",
  "schema",
]);
const TOP_KEYS = Object.freeze([
  "schema",
  "fingerprint",
  "runs",
  "prSweep",
  "reviews",
  "lists",
  "d1",
  "events",
  "undecidable",
]);
const UNIT_STATES = Object.freeze(["done", "pending", "failed"]);

// 사건 종류 -- 상태 파일 events[키].kind.
export const RESCAN_EVENT_KIND = Object.freeze({
  CHANGE_REQUEST: "changeRequest",
  DISMISSED_REVIEW: "dismissedReview",
  UNMERGED_CLOSE: "unmergedClose",
  COMMENT: "comment",
  REVIEW_COMMENT: "reviewComment",
  UPDATE_BRANCH: "updateBranch",
});
const EVENT_KINDS = new Set(Object.values(RESCAN_EVENT_KIND));
const LIST_EVENT_KIND = Object.freeze({
  closedPrs: RESCAN_EVENT_KIND.UNMERGED_CLOSE,
  issueComments: RESCAN_EVENT_KIND.COMMENT,
  reviewComments: RESCAN_EVENT_KIND.REVIEW_COMMENT,
});

const isRecord = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isFilledString = (v) => typeof v === "string" && v !== "";
const isPrNumber = (v) => Number.isInteger(v) && v >= 1;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (values) => values.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// KST 고정(+09:00) -- 시스템 시간대와 무관(PR #389 CI 빨강 교훈). 로컬 시각 접근자 · toLocale* 을 쓰지 않는다.
// ---------------------------------------------------------------------------

export const kstMinuteLabel = (ms) => `${formatKst(ms).slice(0, 16)} KST`;
const kstClock = (ms) => `${formatKst(ms).slice(11, 16)} KST`;

// {fromDay: "YYYY-MM-DD"(KST), days} -> 창 [시작 00:00 KST, 시작 + days 일 00:00 KST). windowEndMs = 마지막 «포함» 순간(core 요약 함수는 끝을 포함으로 읽는다).
export function computeRescanWindow({ fromDay, days } = {}) {
  if (typeof fromDay !== "string" || !DAY_RE.test(fromDay)) {
    return { ok: false, reason: "시작일 형식 오류(YYYY-MM-DD · KST)" };
  }
  if (!Number.isInteger(days) || days < 1 || days > RESCAN_MAX_DAYS) {
    return { ok: false, reason: `일수 오류(1~${RESCAN_MAX_DAYS} 정수)` };
  }
  const startMs = kstDayStartMs(fromDay);
  if (!Number.isFinite(startMs) || kstDayOf(startMs) !== fromDay) {
    return { ok: false, reason: "존재하지 않는 날짜" };
  }
  const endMs = startMs + days * DAY_MS;
  return {
    ok: true,
    fromDay,
    days,
    startMs,
    endMs,
    windowEndMs: endMs - 1,
    startLabel: kstMinuteLabel(startMs),
    endLabel: kstMinuteLabel(endMs),
  };
}

// 창 끝 전 실행은 거부 -- 창이 닫힌 뒤에 쓸어야 «창 전체» 다.
export function judgeWindowClosed({ window, nowMs }) {
  return isRecord(window) &&
    Number.isFinite(window.endMs) &&
    Number.isFinite(nowMs) &&
    nowMs >= window.endMs
    ? { ok: true }
    : { ok: false, reason: "창이 아직 닫히지 않음" };
}

// 모든 흡수 앞의 문 -- 닫히기 전이면(창 · 시각을 못 읽는 경우 포함) 아무것도 흡수하지 않고 던진다. CLI · runRescanOnce 가 먼저 거부하므로 이 문은 두 번째 벽이다.
function assertWindowClosed({ window, nowMs }) {
  const gate = judgeWindowClosed({ window, nowMs });
  if (!gate.ok) throw new RangeError(`흡수 거부: ${gate.reason}`);
}

// 상태의 fingerprint 에서 창을 다시 계산한다(창이 모양 오류면 null -- 그러면 «done» 을 하나도 믿지 않는다).
function stateWindow(state) {
  const fp = state.fingerprint;
  const w = computeRescanWindow({ fromDay: fp?.fromDay, days: fp?.days });
  return w.ok ? w : null;
}

// «done» 은 창이 닫힌 뒤 시각으로 찍혔을 때만 done 이다 -- 닫히기 전 시각(또는 시각 없음)의 done 은 닫힌 뒤 실행이 다시 부른다.
const settledAfterClose = (isDone, doneAtMs, window) =>
  isDone === true &&
  window !== null &&
  Number.isFinite(doneAtMs) &&
  doneAtMs >= window.endMs;

// ---------------------------------------------------------------------------
// fingerprint -- 창 · 저장소 · 봇 목록 blob 이 다르면 거부한다(다른 재조회의 상태를 섞지 않는다).
// ---------------------------------------------------------------------------

export function buildRescanFingerprint({ fromDay, days, repo, botListBlob }) {
  return {
    fromDay,
    days,
    repo,
    botListBlob,
    schema: RESCAN_STATE_SCHEMA,
  };
}

function fingerprintErrors(fp) {
  if (!isRecord(fp)) return ["fingerprint 가 객체가 아님"];
  const errors = [];
  if (typeof fp.fromDay !== "string" || !DAY_RE.test(fp.fromDay)) {
    errors.push("fingerprint.fromDay 형식 오류");
  }
  if (!Number.isInteger(fp.days) || fp.days < 1) {
    errors.push("fingerprint.days 형식 오류");
  }
  if (!isFilledString(fp.repo)) errors.push("fingerprint.repo 비어 있음");
  if (!isFilledString(fp.botListBlob)) {
    errors.push("fingerprint.botListBlob 비어 있음");
  }
  if (fp.schema !== RESCAN_STATE_SCHEMA) {
    errors.push("fingerprint.schema 불일치");
  }
  return errors;
}

// 두 쪽 다 모양이 맞아야 «같다» 고 말한다(둘 다 칸이 비었다고 같은 것이 아니다).
export function compareRescanFingerprint(actual, expected) {
  const malformed = [
    ...fingerprintErrors(actual).map(() => "(저장된 fingerprint 모양)"),
    ...fingerprintErrors(expected).map(() => "(기대 fingerprint 모양)"),
  ];
  if (malformed.length > 0)
    return { ok: false, differs: [...new Set(malformed)] };
  const differs = FINGERPRINT_KEYS.filter((k) => actual[k] !== expected[k]);
  return differs.length === 0
    ? { ok: true, differs: [] }
    : { ok: false, differs };
}

// ---------------------------------------------------------------------------
// 상태 파일 모양 `partial-count-rescan-state/v1`
// ---------------------------------------------------------------------------

export function createRescanState({ fingerprint }) {
  return {
    schema: RESCAN_STATE_SCHEMA,
    fingerprint: clone(fingerprint),
    runs: [],
    prSweep: {
      done: false,
      doneAtMs: null,
      pages: 0,
      listPrs: [],
      gitPrs: [],
      failure: null,
    },
    reviews: {},
    lists: Object.fromEntries(
      RESCAN_COMMENT_LIST_KEYS.map((key) => [
        key,
        { done: false, doneAtMs: null, pages: 0, failure: null },
      ]),
    ),
    d1: { collected: false, collectedAtMs: null, shas: {} },
    events: {},
    undecidable: {},
  };
}

const nullableString = (v) => v === null || typeof v === "string";
// doneAtMs 는 없어도(옛 판 상태) · null 이어도 모양은 맞다 -- 없거나 null 인 done 은 «닫힌 뒤 done» 이 아니라 다시 부른다(settledAfterClose).
const optionalTimeOk = (v) =>
  v === undefined || v === null || Number.isFinite(v);

function runsErrors(runs) {
  if (!Array.isArray(runs)) return ["runs 가 배열이 아님"];
  const bad = runs.some(
    (r) =>
      !isRecord(r) ||
      !Number.isFinite(r.atMs) ||
      !isCount(r.calls) ||
      !nullableString(r.stop),
  );
  return bad ? ["runs 항목 모양 오류(atMs · calls · stop)"] : [];
}

const prListOk = (v) => Array.isArray(v) && v.every(isPrNumber);

function prSweepErrors(p) {
  if (!isRecord(p)) return ["prSweep 가 객체가 아님"];
  const errors = [];
  if (typeof p.done !== "boolean") errors.push("prSweep.done 불리언 아님");
  if (p.doneAtMs !== null && !Number.isFinite(p.doneAtMs)) {
    errors.push("prSweep.doneAtMs 오류");
  }
  if (!isCount(p.pages)) errors.push("prSweep.pages 오류");
  if (!prListOk(p.listPrs) || !prListOk(p.gitPrs)) {
    errors.push("prSweep.listPrs · gitPrs 오류");
  }
  if (!nullableString(p.failure)) errors.push("prSweep.failure 오류");
  return errors;
}

function reviewsErrors(reviews) {
  if (!isRecord(reviews)) return ["reviews 가 객체가 아님"];
  const bad = Object.entries(reviews).some(
    ([key, v]) =>
      !PR_KEY_RE.test(key) ||
      !isRecord(v) ||
      !UNIT_STATES.includes(v.state) ||
      !nullableString(v.reason) ||
      !optionalTimeOk(v.doneAtMs) ||
      !isCount(v.pages) ||
      !isCount(v.undecidable),
  );
  return bad ? ["reviews 항목 모양 오류"] : [];
}

function listsErrors(lists) {
  if (!isRecord(lists)) return ["lists 가 객체가 아님"];
  const keysOk =
    Object.keys(lists).length === RESCAN_COMMENT_LIST_KEYS.length &&
    RESCAN_COMMENT_LIST_KEYS.every((k) => isRecord(lists[k]));
  if (!keysOk) return ["lists 칸 오류(대화 댓글 · 리뷰 줄 댓글 둘)"];
  const bad = RESCAN_COMMENT_LIST_KEYS.some((k) => {
    const l = lists[k];
    return (
      typeof l.done !== "boolean" ||
      (l.doneAtMs !== null && !Number.isFinite(l.doneAtMs)) ||
      !isCount(l.pages) ||
      !nullableString(l.failure)
    );
  });
  return bad ? ["lists 항목 모양 오류"] : [];
}

function d1Errors(d1) {
  if (
    !isRecord(d1) ||
    typeof d1.collected !== "boolean" ||
    !optionalTimeOk(d1.collectedAtMs)
  ) {
    return ["d1 모양 오류(collected · collectedAtMs)"];
  }
  if (!isRecord(d1.shas)) return ["d1.shas 가 객체가 아님"];
  const bad = Object.entries(d1.shas).some(
    ([sha, v]) =>
      !SHA_RE.test(sha) ||
      !isRecord(v) ||
      !UNIT_STATES.includes(v.state) ||
      !nullableString(v.reason) ||
      !optionalTimeOk(v.doneAtMs),
  );
  return bad ? ["d1.shas 항목 모양 오류"] : [];
}

function eventsErrors(events) {
  if (!isRecord(events)) return ["events 가 객체가 아님"];
  const bad = Object.entries(events).some(
    ([key, v]) =>
      key === "" ||
      !isRecord(v) ||
      !EVENT_KINDS.has(v.kind) ||
      !Number.isFinite(v.atMs),
  );
  return bad ? ["events 항목 모양 오류(kind · atMs)"] : [];
}

function undecidableErrors(u) {
  if (!isRecord(u)) return ["undecidable 가 객체가 아님"];
  return Object.values(u).every(isCount)
    ? []
    : ["undecidable 값이 0 이상 정수가 아님"];
}

// 상태 값 -> {ok:true, state} | {ok:false, errors}. 모르는 최상위 칸 · 모양 오류 = 거부(깨진 상태 = 종료 값 1).
export function validateRescanState(value) {
  if (!isRecord(value)) return { ok: false, errors: ["상태가 객체가 아님"] };
  const errors = [];
  if (value.schema !== RESCAN_STATE_SCHEMA) errors.push("schema 불일치");
  const extra = Object.keys(value).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length > 0) errors.push(`모르는 칸: ${extra.join(", ")}`);
  errors.push(
    ...fingerprintErrors(value.fingerprint),
    ...runsErrors(value.runs),
    ...prSweepErrors(value.prSweep),
    ...reviewsErrors(value.reviews),
    ...listsErrors(value.lists),
    ...d1Errors(value.d1),
    ...eventsErrors(value.events),
    ...undecidableErrors(value.undecidable),
  );
  return errors.length === 0
    ? { ok: true, state: value }
    : { ok: false, errors };
}

// 읽은 상태 값 + 이번 실행의 fingerprint -> 모양 검증 -> 대조. 거부 = 종료 값 1(다른 재조회의 상태를 섞지 않는다).
export function acceptRescanState({ stateValue, expectedFingerprint }) {
  const valid = validateRescanState(stateValue);
  if (!valid.ok) {
    return {
      ok: false,
      exit: RESCAN_EXIT.REFUSED,
      reason: `상태 파일 깨짐: ${valid.errors.join(" · ")}`,
    };
  }
  const same = compareRescanFingerprint(
    valid.state.fingerprint,
    expectedFingerprint,
  );
  if (!same.ok) {
    return {
      ok: false,
      exit: RESCAN_EXIT.REFUSED,
      reason: `fingerprint 불일치(${same.differs.join(", ")}) -- 새 상태로 시작해야 한다`,
    };
  }
  return { ok: true, state: valid.state };
}

// ---------------------------------------------------------------------------
// 사건 합집합 -- 같은 키는 1 · 먼저 본 사건은 뒤 실행이 못 봐도 남는다(덮어쓰기 0 · 지우기 0).
// ---------------------------------------------------------------------------

export function mergeRescanEvents(events, incoming) {
  const out = { ...events };
  for (const e of incoming) {
    if (!Object.hasOwn(out, e.key)) out[e.key] = { kind: e.kind, atMs: e.atMs };
  }
  return out;
}

const toIncoming = (coreEvents, kind) =>
  coreEvents.map((e) => ({ key: e.id, kind, atMs: e.atMs }));

const reviewIdOfKey = (key) => key.slice(key.indexOf(":") + 1);
const sortedUnion = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y);
const raise = (prev, value) => Math.max(isCount(prev) ? prev : 0, value);

// ---------------------------------------------------------------------------
// 응답 묶음 -> 상태(새 객체를 돌려준다 · 입력 상태 무변). 응답 모양이 틀리면 그 단위만 failed 로 둔다.
// ---------------------------------------------------------------------------

export function recordRescanRun({ state, atMs, calls, stop = null }) {
  const next = clone(state);
  next.runs.push({ atMs, calls, stop });
  return next;
}

// 실패 단위 표시 -- unit: "prSweep" | "reviews"(key = PR 번호) | "lists"(key = 목록 키) | "d1"(key = sha). 실패 단위는 다음 실행 대상이다.
export function markUnitFailed({ state, unit, key, reason }) {
  const next = clone(state);
  const why = isFilledString(reason) ? reason : "사유 미상";
  if (unit === "prSweep") {
    next.prSweep.failure = why;
  } else if (unit === "reviews" && isPrNumber(key)) {
    const prev = next.reviews[String(key)] ?? emptyReviewUnit();
    next.reviews[String(key)] = {
      ...prev,
      state: "failed",
      reason: why,
      doneAtMs: null,
    };
  } else if (unit === "lists" && RESCAN_COMMENT_LIST_KEYS.includes(key)) {
    next.lists[key].failure = why;
  } else if (unit === "d1" && SHA_RE.test(String(key))) {
    const prev = next.d1.shas[key] ?? { state: "pending", reason: null };
    next.d1.shas[key] = {
      ...prev,
      state: "failed",
      reason: why,
      doneAtMs: null,
    };
  } else {
    throw new RangeError(`알 수 없는 실패 단위: ${unit}`);
  }
  return next;
}

const emptyReviewUnit = () => ({
  state: "pending",
  reason: null,
  doneAtMs: null,
  pages: 0,
  undecidable: 0,
});

const pagesAreArrays = (pages) =>
  Array.isArray(pages) && pages.every((p) => Array.isArray(p));
const isOpenPr = (item) => isRecord(item) && item.state === "open";

// PR 목록 항목 -> 창 안 PR 번호 · 읽을 수 없는 항목 수(번호 · updated_at 을 못 읽으면 그 PR 의 리뷰를 부를 수 없다 = 판정 불가).
function readPrListNumbers(items, windowStartMs) {
  const numbers = [];
  let undecidable = 0;
  for (const item of items) {
    const updatedMs = isRecord(item) ? Date.parse(item.updated_at) : NaN;
    if (
      !isRecord(item) ||
      !isPrNumber(item.number) ||
      Number.isNaN(updatedMs)
    ) {
      undecidable += 1;
    } else if (updatedMs >= windowStartMs) {
      numbers.push(item.number);
    }
  }
  return { numbers, undecidable };
}

// PR 쓸기(PR 목록 state=all · updated 내림차순 · 한 실행 안에서 끝까지 넘긴 쪽들) -> 창 안 PR 집합 + 미병합 닫기 사건.
// 쓸기 «끝» = 마지막 쪽이 창 시작까지 닿음(core githubListCoversWindow) ∧ 창이 닫힌 뒤(nowMs ≥ 창 끝). 한 번 끝난 쓸기는 되돌리지 않는다.
export function absorbPrSweep({
  state,
  pages,
  gitMergePrNumbers = [],
  window,
  nowMs,
  botLogins,
}) {
  assertWindowClosed({ window, nowMs });
  if (!pagesAreArrays(pages)) {
    return markUnitFailed({
      state,
      unit: "prSweep",
      reason: "PR 목록 응답 모양 위반",
    });
  }
  const next = clone(state);
  const items = pages.flat();
  const closed = summarizeGithubList({
    listKey: "closedPrs",
    items: items.filter((i) => !isOpenPr(i)),
    botLogins,
    windowStartMs: window.startMs,
    windowEndMs: window.windowEndMs,
  });
  next.events = mergeRescanEvents(
    next.events,
    toIncoming(closed.events, LIST_EVENT_KIND.closedPrs),
  );
  next.undecidable.closedPrs = raise(
    next.undecidable.closedPrs,
    closed.undecidable,
  );
  const read = readPrListNumbers(items, window.startMs);
  const gitNumbers = Array.isArray(gitMergePrNumbers) ? gitMergePrNumbers : [];
  next.prSweep.listPrs = sortedUnion(next.prSweep.listPrs, read.numbers);
  next.prSweep.gitPrs = sortedUnion(
    next.prSweep.gitPrs,
    gitNumbers.filter(isPrNumber),
  );
  next.undecidable.prList = raise(
    next.undecidable.prList,
    read.undecidable + gitNumbers.filter((n) => !isPrNumber(n)).length,
  );
  next.prSweep.pages = raise(next.prSweep.pages, pages.length);
  next.prSweep.failure = null;
  const covered =
    pages.length > 0 &&
    githubListCoversWindow(
      "closedPrs",
      pages[pages.length - 1],
      window.startMs,
    );
  if (
    covered &&
    !settledAfterClose(next.prSweep.done, next.prSweep.doneAtMs, window)
  ) {
    next.prSweep.done = true;
    next.prSweep.doneAtMs = nowMs;
  }
  return next;
}

// 리뷰 응답에서 «읽을 수 없는» 변경 요청 · 기각 후보 수 -- core 요약은 읽을 수 없는 리뷰를 조용히 건너뛴다. 그 건을 0 으로 접지 않고 판정 불가로 센다.
function unreadableReviewCount(pages) {
  let count = 0;
  for (const review of pages.flat()) {
    const state = isRecord(review) ? review.state : null;
    const relevant =
      typeof state === "string" &&
      ["changes_requested", "dismissed"].includes(state.toLowerCase());
    const readable =
      isRecord(review) &&
      (isFilledString(review.id) || Number.isFinite(review.id)) &&
      isRecord(review.user) &&
      isFilledString(review.user.login) &&
      Number.isFinite(Date.parse(review.submitted_at));
    if (relevant && !readable) count += 1;
  }
  return count;
}

// 기각된 리뷰만 «변경 요청 모양» 으로 바꿔 core 요약(창 · 봇 · id 중복 규칙)에 태운다 -- 센 규칙은 core 한 벌이다.
function dismissedReviewLists(pages) {
  return pages.map((page) =>
    page
      .filter(
        (r) =>
          isRecord(r) &&
          typeof r.state === "string" &&
          r.state.toLowerCase() === "dismissed",
      )
      .map((r) => ({ ...r, state: "CHANGES_REQUESTED" })),
  );
}

// PR 하나의 리뷰 응답 쪽들(complete = 마지막 쪽까지 넘겼는가) -> 변경 요청 · 기각된 리뷰 사건. 기각된 리뷰는 ㄴ 분자에 들어간다(설정 0).
export function absorbReviewPages({
  state,
  prNumber,
  pages,
  complete,
  window,
  nowMs,
  botLogins,
}) {
  assertWindowClosed({ window, nowMs });
  if (!isPrNumber(prNumber) || !pagesAreArrays(pages)) {
    return markUnitFailed({
      state,
      unit: "reviews",
      key: prNumber,
      reason: "리뷰 응답 모양 위반",
    });
  }
  const next = clone(state);
  const args = {
    carriedRecords: [],
    botLogins,
    windowStartMs: window.startMs,
    windowEndMs: window.windowEndMs,
  };
  const requested = summarizeChangeRequests({ ...args, reviewLists: pages });
  const dismissed = summarizeChangeRequests({
    ...args,
    reviewLists: dismissedReviewLists(pages),
  });
  next.events = mergeRescanEvents(next.events, [
    ...toIncoming(requested.events, RESCAN_EVENT_KIND.CHANGE_REQUEST),
    ...dismissed.events.map((e) => ({
      key: `${DISMISSED_REVIEW_PREFIX}${reviewIdOfKey(e.id)}`,
      kind: RESCAN_EVENT_KIND.DISMISSED_REVIEW,
      atMs: e.atMs,
    })),
  ]);
  const prev = next.reviews[String(prNumber)] ?? emptyReviewUnit();
  next.reviews[String(prNumber)] = {
    state: complete === true ? "done" : "pending",
    reason: complete === true ? null : "응답 쪽 남음",
    doneAtMs: complete === true ? nowMs : null,
    pages: raise(prev.pages, pages.length),
    undecidable: raise(prev.undecidable, unreadableReviewCount(pages)),
  };
  return next;
}

// 대화 댓글 · 리뷰 줄 댓글 목록(쪽들 · 내림차순) -> 사건. 끝 = 마지막 쪽이 창 시작까지 닿음 ∧ 창이 닫힌 뒤.
export function absorbCommentPages({
  state,
  listKey,
  pages,
  window,
  nowMs,
  botLogins,
}) {
  assertWindowClosed({ window, nowMs });
  if (!RESCAN_COMMENT_LIST_KEYS.includes(listKey)) {
    throw new RangeError(`알 수 없는 목록: ${listKey}`);
  }
  if (!pagesAreArrays(pages)) {
    return markUnitFailed({
      state,
      unit: "lists",
      key: listKey,
      reason: "목록 응답 모양 위반",
    });
  }
  const next = clone(state);
  const summary = summarizeGithubList({
    listKey,
    items: pages.flat(),
    botLogins,
    windowStartMs: window.startMs,
    windowEndMs: window.windowEndMs,
  });
  next.events = mergeRescanEvents(
    next.events,
    toIncoming(summary.events, LIST_EVENT_KIND[listKey]),
  );
  next.undecidable[listKey] = raise(
    next.undecidable[listKey],
    summary.undecidable,
  );
  const unit = next.lists[listKey];
  unit.pages = raise(unit.pages, pages.length);
  unit.failure = null;
  const covered =
    pages.length > 0 &&
    githubListCoversWindow(listKey, pages[pages.length - 1], window.startMs);
  if (covered && !settledAfterClose(unit.done, unit.doneAtMs, window)) {
    unit.done = true;
    unit.doneAtMs = nowMs;
  }
  return next;
}

// D1(Update branch) 후보 sha 등록 -- 후보 수집(git)을 끝냈다는 표지(collected) + 아직 모르는 후보는 pending. 후보 0 개도 «수집했다» 로 남는다.
export function registerUpdateBranchCandidates({ state, shas, window, nowMs }) {
  assertWindowClosed({ window, nowMs });
  const next = clone(state);
  next.d1.collected = true;
  next.d1.collectedAtMs = nowMs;
  for (const sha of Array.isArray(shas) ? shas : []) {
    if (SHA_RE.test(String(sha)) && !Object.hasOwn(next.d1.shas, sha)) {
      next.d1.shas[sha] = { state: "pending", reason: null, doneAtMs: null };
    }
  }
  return next;
}

// sha 하나의 판정 결과(기존 D1 판정 함수가 낸 값) -> counted 면 사건 1건(core 의 D1 접두). 판정 단위는 done.
// atMs = 사건 시각(커밋 시각) · nowMs = 이 판정을 흡수한 시각(done 표지 · 창이 닫힌 뒤여야 한다).
export function recordUpdateBranchResult({
  state,
  sha,
  counted,
  atMs,
  window,
  nowMs,
}) {
  assertWindowClosed({ window, nowMs });
  if (!SHA_RE.test(String(sha))) {
    return markUnitFailed({
      state,
      unit: "d1",
      key: sha,
      reason: "sha 모양 오류",
    });
  }
  const next = clone(state);
  next.d1.shas[sha] = { state: "done", reason: null, doneAtMs: nowMs };
  if (counted === true) {
    next.events = mergeRescanEvents(next.events, [
      {
        key: `${DAILY_EVENT_PREFIX.D1}${sha}`,
        kind: RESCAN_EVENT_KIND.UPDATE_BRANCH,
        atMs,
      },
    ]);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 실행 예산 계획 -- 실행당 10 · 직전 60분 합 10(감시 최악 48/h + 여유 12/h 안 · 익명 60/h). 넘으면 호출 0 + 다음 실행 가능 시각.
// ---------------------------------------------------------------------------

export function planRunBudget({
  state,
  nowMs,
  maxCalls = RESCAN_MAX_CALLS_PER_RUN,
}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || !Number.isFinite(nowMs)) {
    return { ok: false, reason: "max-calls 는 1 이상 정수 · 시각은 유한 수" };
  }
  const perRun = Math.min(maxCalls, RESCAN_MAX_CALLS_PER_RUN);
  const recent = state.runs
    .filter((r) => r.atMs > nowMs - RESCAN_BUDGET_WINDOW_MS && r.atMs <= nowMs)
    .sort((a, b) => a.atMs - b.atMs);
  const used = sum(recent.map((r) => r.calls));
  const room = Math.max(0, RESCAN_HOURLY_CALL_CAP - used);
  const allowedCalls = Math.min(perRun, room);
  if (allowedCalls > 0) {
    return { ok: true, allowedCalls, usedLastHour: used, nextRunAtMs: null };
  }
  let freed = 0;
  let nextRunAtMs = nowMs;
  for (const run of recent) {
    freed += run.calls;
    nextRunAtMs = run.atMs + RESCAN_BUDGET_WINDOW_MS;
    if (used - freed < RESCAN_HOURLY_CALL_CAP) break;
  }
  return { ok: true, allowedCalls: 0, usedLastHour: used, nextRunAtMs };
}

// ---------------------------------------------------------------------------
// 남은 미조회 판정 + 다음 실행 대상
// ---------------------------------------------------------------------------

export const rescanPrNumbers = (state) =>
  sortedUnion(state.prSweep.listPrs, state.prSweep.gitPrs);

// 단위 상태 읽기 -- done 은 «창이 닫힌 뒤 시각으로 찍힌 done» 만 done 이다(아니면 pending = 닫힌 뒤 실행이 다시 부른다).
const readUnitState = (unit, window) =>
  unit.state === "done" && !settledAfterClose(true, unit.doneAtMs, window)
    ? "pending"
    : unit.state;
const reviewState = (state, n) => {
  const unit = state.reviews[String(n)];
  return unit ? readUnitState(unit, stateWindow(state)) : "pending";
};
const listUnitState = (state, key) => {
  const l = state.lists[key];
  if (l.failure !== null) return "failed";
  return settledAfterClose(l.done, l.doneAtMs, stateWindow(state))
    ? "done"
    : "pending";
};
const sweepSettled = (state) =>
  settledAfterClose(
    state.prSweep.done,
    state.prSweep.doneAtMs,
    stateWindow(state),
  );
const d1Settled = (state) =>
  settledAfterClose(
    state.d1.collected,
    state.d1.collectedAtMs,
    stateWindow(state),
  );
const d1ShaStates = (state) =>
  Object.values(state.d1.shas).map((s) => readUnitState(s, stateWindow(state)));

// 단위 상태 -> {pending(아직 안 부름 · 일부만 부름), failed}. 실패는 따로 센다(두 번 세지 않는다).
function unitCounts(states) {
  return {
    pending: states.filter((s) => s === "pending").length,
    failed: states.filter((s) => s === "failed").length,
  };
}

// 남은 미조회 U = PR 쓸기(끝 전 1) + PR 리뷰 u1 + 목록 u2 + D1 u3 + 수집 실패 f. PR 쓸기가 끝나기 전에는 «남은 수 미상» 이라 U ≥ 1 이다 -- 0 이라 말하지 않는다.
export function judgeRescanRemaining(state) {
  const sweepFailed = state.prSweep.failure !== null;
  const sweep = !sweepSettled(state) && !sweepFailed ? 1 : 0;
  const reviews = unitCounts(
    rescanPrNumbers(state).map((n) => reviewState(state, n)),
  );
  const lists = unitCounts(
    RESCAN_COMMENT_LIST_KEYS.map((k) => listUnitState(state, k)),
  );
  const d1 = unitCounts(d1ShaStates(state));
  const d1Uncollected = d1Settled(state) ? 0 : 1;
  const strayFailedReviews = Object.entries(state.reviews).filter(
    ([k, v]) =>
      v.state === "failed" && !rescanPrNumbers(state).includes(Number(k)),
  ).length;
  const failed =
    (sweepFailed ? 1 : 0) +
    reviews.failed +
    strayFailedReviews +
    lists.failed +
    d1.failed;
  const unqueried = {
    sweep,
    prReviews: reviews.pending,
    lists: lists.pending,
    d1: d1.pending + d1Uncollected,
    failed,
  };
  const total = sum(Object.values(unqueried));
  return { complete: total === 0, total, unqueried };
}

// 다음 실행이 불러야 할 단위 -- 실패 단위도 포함(실패 단위는 다음 실행 대상).
export function planRescanTargets(state) {
  const failedOrPending = (s) => s !== "done";
  const win = stateWindow(state);
  return {
    sweep: !sweepSettled(state) || state.prSweep.failure !== null,
    reviews: rescanPrNumbers(state).filter((n) =>
      failedOrPending(reviewState(state, n)),
    ),
    lists: RESCAN_COMMENT_LIST_KEYS.filter((k) =>
      failedOrPending(listUnitState(state, k)),
    ),
    d1Collect: !d1Settled(state),
    d1: Object.entries(state.d1.shas)
      .filter(([, v]) => failedOrPending(readUnitState(v, win)))
      .map(([sha]) => sha),
  };
}

// ---------------------------------------------------------------------------
// 셈 · 판정 불가 · 종료 값
// ---------------------------------------------------------------------------

// 합집합 사건 -> 종류별 수. 기각된 리뷰는 ㄴ 분자에 넣는다(끄는 길 0). 같은 리뷰가 변경 요청으로도 보였다면 «변경 요청» 에만 센다(1건 1번).
export function countRescanEvents(state) {
  const tally = Object.fromEntries(
    Object.values(RESCAN_EVENT_KIND).map((k) => [k, 0]),
  );
  const entries = Object.entries(state.events);
  const requestedIds = new Set(
    entries
      .filter(([, e]) => e.kind === RESCAN_EVENT_KIND.CHANGE_REQUEST)
      .map(([key]) => reviewIdOfKey(key)),
  );
  for (const [key, e] of entries) {
    const overlapped =
      e.kind === RESCAN_EVENT_KIND.DISMISSED_REVIEW &&
      requestedIds.has(reviewIdOfKey(key));
    if (!overlapped) tally[e.kind] += 1;
  }
  return { ...tally, numerator: sum(Object.values(tally)) };
}

export function countRescanUndecidable(state) {
  return (
    sum(Object.values(state.undecidable)) +
    sum(Object.values(state.reviews).map((r) => r.undecidable))
  );
}

// 완료 0 · 미완 3. 거부/고장(1)은 acceptRescanState · 창 검사가 돌려준다.
export const rescanExitValue = (remaining) =>
  remaining.complete ? RESCAN_EXIT.COMPLETE : RESCAN_EXIT.INCOMPLETE;

// 선언 재료 -- 완료 ∧ 판정 불가 0 일 때만 «가능» (완료면 실패 0).
export function judgeDeclarationMaterial({ remaining, undecidable }) {
  const reasons = [];
  if (!remaining.complete) reasons.push(`미완(남은 미조회 ${remaining.total})`);
  if (undecidable > 0) reasons.push(`판정 불가 ${undecidable}`);
  return reasons.length === 0
    ? { ready: true, reasons }
    : { ready: false, reasons };
}

// ---------------------------------------------------------------------------
// 출력 줄(설계 (나) · 줄 형식 고정) -- 마지막 줄 = 신호의 정본(완료 / 미완). 창 계산 · 시각 표기는 KST 고정.
// ---------------------------------------------------------------------------

function scopePieces(state) {
  const prs = rescanPrNumbers(state);
  const reviewPages = sum(Object.values(state.reviews).map((r) => r.pages));
  const listPages =
    state.prSweep.pages +
    sum(RESCAN_COMMENT_LIST_KEYS.map((k) => state.lists[k].pages));
  return {
    prs: prs.length,
    fromList: state.prSweep.listPrs.length,
    fromGit: state.prSweep.gitPrs.length,
    reviewPages,
    listPages,
    d1: Object.keys(state.d1.shas).length,
  };
}

export function renderRescanReport({ state, window, nowMs }) {
  const remaining = judgeRescanRemaining(state);
  const counts = countRescanEvents(state);
  const undecidable = countRescanUndecidable(state);
  const declaration = judgeDeclarationMaterial({ remaining, undecidable });
  const plan = planRunBudget({ state, nowMs });
  const nextMs = plan.ok && plan.allowedCalls === 0 ? plan.nextRunAtMs : nowMs;
  const scope = scopePieces(state);
  const u = remaining.unqueried;
  const callTotal = sum(state.runs.map((r) => r.calls));
  const lines = [
    `전수 재조회 창: ${window.startLabel} ~ ${window.endLabel} (캐시 끔 · 실행 ${state.runs.length}회 · 호출 ${callTotal})`,
    `ㄴ GitHub 사람 손(창 전체): 변경 요청 ${counts.changeRequest} · 미병합 닫기 ${counts.unmergedClose} · 대화 댓글 ${counts.comment} · 리뷰 줄 댓글 ${counts.reviewComment} · Update branch ${counts.updateBranch} · 기각된 리뷰 ${counts.dismissedReview}건(원래 상태를 응답에서 알 수 없음) · 판정 불가 ${undecidable}`,
    `조회 범위: PR ${scope.prs}개(목록 ${scope.fromList} ∪ git 병합 ${scope.fromGit}) · 리뷰 응답 쪽 ${scope.reviewPages} · 목록 쪽 ${scope.listPages} · D1 후보 ${scope.d1}`,
    declaration.ready
      ? "선언 재료: 가능"
      : `선언 재료: 불가 — ${declaration.reasons.join(" · ")}`,
    remaining.complete
      ? "전수 재조회: 완료 — 남은 미조회 0"
      : `전수 재조회: 미완 — 남은 미조회 ${remaining.total}(PR 쓸기 ${u.sweep} · PR 리뷰 ${u.prReviews} · 목록 ${u.lists} · D1 ${u.d1} · 수집 실패 ${u.failed}) — 다음 실행 가능 ≥ ${kstClock(nextMs)}`,
  ];
  return {
    lines,
    exit: rescanExitValue(remaining),
    complete: remaining.complete,
    declarationReady: declaration.ready,
    counts,
    undecidable,
    remaining,
  };
}
