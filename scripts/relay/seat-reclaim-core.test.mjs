import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeSeatReclaim,
  judgeReclaimAnomaly,
  SEAT_ELIGIBILITY,
  SEAT_REASON,
  ANOMALY_STATUS,
  ANOMALY_REASON,
  SEAT_RECLAIM_SCHEMA_VERSION,
} from "./seat-reclaim-core.mjs";

// HYK-431 1R/2R -- seat-reclaim-core.mjs 단위시험. 순수 함수라 fake execFn 등이
// 필요 없다(입력 봉투를 손으로 만든다, teardown-core.test.mjs와 동형).
//
// 2R: judgeSeatReclaim은 이제 `nowMs`를 요구한다(§2⑷, coder-task.md).
// 시험 전체에서 baseline completedAt("2026-09-04T03:00:00Z")보다 뒤인
// 고정 시각을 NOW로 쓴다 -- Date.now() 호출 0(코어 관례).
const NOW = Date.parse("2026-09-05T00:00:00Z");

function baseSeatInventory(overrides = {}) {
  return {
    schemaVersion: SEAT_RECLAIM_SCHEMA_VERSION,
    seat: { paneKey: "pane-1" },
    dispatch: { completedAt: "2026-09-04T03:00:00Z", observable: true },
    activity: { idleMs: 10 * 60 * 1000, observable: true },
    ...overrides,
  };
}

function judge(
  overrides = {},
  policy = { protectedSeats: [], minIdleMs: 0 },
  nowMs = NOW,
) {
  return judgeSeatReclaim({
    inventory: baseSeatInventory(overrides),
    policy,
    nowMs,
  });
}

// ---- 합성 표적: 「회수 대상」 ----

test("judgeSeatReclaim: dispatch 종료 + 유예 지남 + 비보호 -- RECLAIM_ELIGIBLE", () => {
  const r = judge({}, { protectedSeats: [], minIdleMs: 5 * 60 * 1000 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE);
  assert.equal(r.reclaimEligible, true);
  assert.equal(r.reason, SEAT_REASON.ELIGIBLE);
});

// ---- 합성 표적: 「회수 금지」 ----

test("judgeSeatReclaim: dispatch 진행중(completedAt null) -- DISPATCH_ACTIVE, 회수 금지", () => {
  const r = judge({ dispatch: { completedAt: null, observable: true } });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.DISPATCH_ACTIVE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.DISPATCH_ACTIVE);
});

test("judgeSeatReclaim: 미래의 새 status 문자열이어도 completedAt이 non-null·과거면 종료로 본다(§2⑵ 이분 축)", () => {
  // 상태 문자열을 목록으로 열거하지 않는다는 설계를 직접 시험한다 --
  // 이 코어는 status라는 필드 자체를 아예 보지 않는다(inventory에도
  // 없다). 미래에 어떤 새 vendor 상태값이 생겨도 completedAt만 채워지고
  // 그 시각이 nowMs를 넘지 않으면 이 시험은 그대로 통과해야 한다.
  // (§2⑴ 규칙과 겹치지 않도록 completedAt은 NOW보다 과거로 둔다 --
  // "미래 completedAt 자체를 거부"하는 시험은 아래 별도로 있다.)
  const r = judge(
    {
      dispatch: { completedAt: "2026-12-31T00:00:00Z", observable: true },
    },
    { protectedSeats: [], minIdleMs: 0 },
    Date.parse("2027-01-01T00:00:00Z"),
  );
  assert.equal(r.reclaimEligible, true);
});

test("judgeSeatReclaim: 보호 목록(exact match) -- PROTECTED가 다른 모든 축을 이긴다", () => {
  const r = judge({}, { protectedSeats: ["pane-1"], minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_SEAT);
});

test("judgeSeatReclaim: 보호 목록 부분일치는 보호로 치지 않는다(exact match만)", () => {
  const r = judge(
    { seat: { paneKey: "pane-12" } },
    { protectedSeats: ["pane-1"], minIdleMs: 0 },
  );
  assert.notEqual(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
});

test("judgeSeatReclaim: 유예 구간 안(idleMs < minIdleMs) -- WITHIN_GRACE_PERIOD, 회수 금지", () => {
  const r = judge(
    { activity: { idleMs: 60 * 1000, observable: true } },
    { protectedSeats: [], minIdleMs: 5 * 60 * 1000 },
  );
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.WITHIN_GRACE_PERIOD);
});

// ---- fail-closed: 불확실 입력은 반드시 회수 금지로 떨어진다 ----

test("judgeSeatReclaim: dispatch.observable false -- UNOBSERVABLE, 회수 금지(fail-closed)", () => {
  const r = judge({ dispatch: { completedAt: null, observable: false } });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.DISPATCH_UNOBSERVABLE);
});

test("judgeSeatReclaim: activity.observable false -- UNOBSERVABLE, 회수 금지(fail-closed)", () => {
  const r = judge({ activity: { idleMs: null, observable: false } });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.ACTIVITY_UNOBSERVABLE);
});

test("judgeSeatReclaim: policy.minIdleMs 결손 -- 유예 무한대로 접어 회수 금지(fail-closed)", () => {
  const r = judge({}, { protectedSeats: [] });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD);
  assert.equal(r.reclaimEligible, false);
});

test("judgeSeatReclaim: 스키마 결손(target 봉투 자체가 잘못됨) -- UNOBSERVABLE, 회수 금지", () => {
  const r = judgeSeatReclaim({
    inventory: { not: "valid" },
    policy: {},
    nowMs: NOW,
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("judgeSeatReclaim: inventory 자체가 undefined여도 던지지 않고 회수 금지로 떨어진다", () => {
  const r = judgeSeatReclaim({ nowMs: NOW });
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("judgeSeatReclaim: nowMs가 유한수가 아니면(결손) 회수 금지로 떨어진다(§2⑷ fail-closed) -- reason은 SCHEMA_INVALID와 구별되는 NOW_MS_INVALID(HYK-431 잔여 축 B)", () => {
  const r = judgeSeatReclaim({ inventory: baseSeatInventory(), policy: {} });
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.NOW_MS_INVALID);
});

// ---- HYK-431 잔여 축 B: inventory 형상 실패와 nowMs 결손이 서로 다른
// reason으로 구별되는지 직접 대조한다(이전엔 둘 다 SCHEMA_INVALID 하나로
// 접혀 "무엇이 왜 걸렸는지"가 안 보였다). fail-closed 판정 자체(둘 다
// UNOBSERVABLE/reclaimEligible:false)는 바뀌지 않는다.

test("HYK-431 잔여 축 B: inventory 형상 실패와 nowMs 결손은 reason이 서로 다르다(관측성)", () => {
  const shapeInvalid = judgeSeatReclaim({
    inventory: { not: "a valid inventory" },
    policy: { protectedSeats: [], minIdleMs: 0 },
    nowMs: NOW,
  });
  const nowMsInvalid = judgeSeatReclaim({
    inventory: baseSeatInventory(),
    policy: { protectedSeats: [], minIdleMs: 0 },
    nowMs: "not-a-number",
  });
  assert.equal(shapeInvalid.reason, SEAT_REASON.SCHEMA_INVALID);
  assert.equal(nowMsInvalid.reason, SEAT_REASON.NOW_MS_INVALID);
  assert.notEqual(shapeInvalid.reason, nowMsInvalid.reason);
  assert.equal(shapeInvalid.reclaimEligible, false);
  assert.equal(nowMsInvalid.reclaimEligible, false);
  assert.equal(shapeInvalid.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(nowMsInvalid.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
});

// ---- §2⑴ 반례 6건(REVIEW 1R P1-1 재현, coder-task.md §3-1) ----
// 검토자 재현 명령을 이 저장소 시험 형태로 그대로 옮긴다 -- 결과 파일
// (coder.md)에는 원문 node 명령 재실행 로그를 별도로 붙인다.

test("§2⑴ 반례: seat.paneKey null -- TARGET_UNIDENTIFIED, 회수 금지", () => {
  const r = judge({ seat: { paneKey: null } });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.TARGET_UNIDENTIFIED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.TARGET_UNIDENTIFIED);
});

test("§2⑴ 반례: policy.protectedSeats 결손 -- 보호 목록 못 읽음, PROTECTED로 접어 회수 금지", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory(),
    policy: { minIdleMs: 0 },
    nowMs: NOW,
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_LIST_INVALID);
});

test("§2⑴ 반례: policy.protectedSeats가 배열이 아니라 문자열 -- PROTECTED_LIST_INVALID, 회수 금지", () => {
  const r = judge({}, { protectedSeats: "pane-1", minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_LIST_INVALID);
});

test("§2⑴ 반례: activity.idleMs null + minIdleMs 0 -- ACTIVITY_IDLE_UNKNOWN, 회수 금지(coercion 통과 안 함)", () => {
  const r = judge(
    { activity: { idleMs: null, observable: true } },
    { protectedSeats: [], minIdleMs: 0 },
  );
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.ACTIVITY_IDLE_UNKNOWN);
});

test("§2⑴ 반례: completedAt 파싱 불가('not-a-date') -- SCHEMA_INVALID, 회수 금지", () => {
  const r = judge({
    dispatch: { completedAt: "not-a-date", observable: true },
  });
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("§2⑴ 반례: completedAt 파싱 불가('2026-99-99') -- SCHEMA_INVALID, 회수 금지", () => {
  const r = judge({
    dispatch: { completedAt: "2026-99-99", observable: true },
  });
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("§2⑴ 반례: completedAt 공백 문자열 -- SCHEMA_INVALID, 회수 금지", () => {
  const r = judge({ dispatch: { completedAt: "   ", observable: true } });
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("§2⑴ 반례: completedAt이 미래(nowMs보다 뒤) -- DISPATCH_COMPLETED_AT_FUTURE, 회수 금지", () => {
  const r = judge({
    dispatch: { completedAt: "2999-01-01T00:00:00Z", observable: true },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.DISPATCH_ACTIVE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.DISPATCH_COMPLETED_AT_FUTURE);
});

// ---- §2⑴ P1-1 반례 4건(REVIEW 3R 재현, coder-task.md §3-3) ----
// 검토자 재현 명령(§9 원문)을 그대로 시험 형태로 옮긴다 -- protectedSeats가
// 배열"이기만" 하면 통과하던 2R의 구멍(원소 타입 미검증)이 3R
// PROTECTED_SEATS_SCHEMA(TArrayOf(TNonEmptyString()))로 닫혔는지 직접 본다.

test("§2⑴ P1-1 반례: protectedSeats=[null] -- 원소가 null이면 목록 전체 무효, 회수 금지", () => {
  const r = judge({}, { protectedSeats: [null], minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_LIST_INVALID);
});

test("§2⑴ P1-1 반례: protectedSeats=[1] -- 원소가 숫자면 목록 전체 무효, 회수 금지", () => {
  const r = judge({}, { protectedSeats: [1], minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_LIST_INVALID);
});

test("§2⑴ P1-1 반례: protectedSeats=[{}] -- 원소가 객체면 목록 전체 무효, 회수 금지", () => {
  const r = judge({}, { protectedSeats: [{}], minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_LIST_INVALID);
});

test("§2⑴ P1-1 반례: protectedSeats=['other', null] -- 원소 하나만 무효여도 목록 전체 무효, 회수 금지", () => {
  const r = judge({}, { protectedSeats: ["other", null], minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_LIST_INVALID);
});

test("§2⑴ P1-1 경계: protectedSeats=[] -- 빈 배열은 원소 검사 vacuously 통과, 여전히 비보호(회수 가능 축은 열려 있다)", () => {
  const r = judge({}, { protectedSeats: [], minIdleMs: 0 });
  assert.notEqual(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
});

test("§2⑴ P1-1 경계: protectedSeats=['pane-1'] -- 유효한 원소만 있는 목록은 정상 동작(exact match)", () => {
  const r = judge({}, { protectedSeats: ["pane-1"], minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reason, SEAT_REASON.PROTECTED_SEAT);
});

// ---- HYK-436 반례 2건(REVIEW 4R P1 재현): 검사가 입력 자신의 메서드를
// 부르면 입력이 그 메서드를 재정의해 판정을 뒤집을 수 있다. Array를
// 상속하며 every/includes를 재정의한 인스턴스로 재현한다 -- 수리 전에는
// 둘 다 회수 허용/보호 상실로 샜다(REVIEW 4R 원문).
// ★HYK-447 1R 계약 변경: 이제 이 두 입력은 판정 로직에 닿기도 전에 신뢰
// 경계에서 거부된다(Array 서브클래스 인스턴스는 평범한 자료가 아니다) --
// 회수 금지라는 결론은 같고 사유만 SCHEMA_INVALID로 앞당겨진다. 4R/5R의
// 원형 메서드 차용(Array.prototype.X.call)은 두 번째 층으로 남아 있다.

class EveryBypassArray extends Array {
  every() {
    return true;
  }
}
class IncludesBypassArray extends Array {
  includes() {
    return false;
  }
}

test("HYK-436 반례: protectedSeats가 every()를 항상 true로 재정의한 Array 서브클래스([null]) -- 신뢰 경계가 먼저 거부, 회수 금지", () => {
  const protectedSeats = new EveryBypassArray();
  protectedSeats.push(null);
  const r = judge({}, { protectedSeats, minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("HYK-436 반례: protectedSeats가 includes()를 항상 false로 재정의한 Array 서브클래스(['pane-1']) -- 신뢰 경계가 먼저 거부, 회수 금지", () => {
  const protectedSeats = new IncludesBypassArray();
  protectedSeats.push("pane-1");
  const r = judge({}, { protectedSeats, minIdleMs: 0 });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

// ---- §2⑶(P1-2) 반례 2건: null 인자는 throw 대신 판정 ----

test("§2⑶ 반례: judgeSeatReclaim(null) -- throw 없이 회수 금지 판정", () => {
  const r = judgeSeatReclaim(null);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("§2⑶ 반례: judgeReclaimAnomaly(null) -- throw 없이 ANOMALY 판정(fail-open)", () => {
  const r = judgeReclaimAnomaly(null);
  assert.equal(r.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(r.reason, ANOMALY_REASON.INPUT_INVALID);
});

// ---- judgeReclaimAnomaly: 회수 누락이 이상으로 열리는가 ----

test("judgeReclaimAnomaly: 회수 대상 없음(count 0) -- OK", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 0,
      systemPressure: { availableMemoryBytes: 1_000_000, observable: true },
    },
    { memoryFloorBytes: 4 * 1024 ** 3 },
  );
  assert.equal(r.status, ANOMALY_STATUS.OK);
});

test("judgeReclaimAnomaly: 회수 대상 있음 + 메모리 여유 -- WATCH까지만(ANOMALY 아님, 개수 단독 임계 폐기)", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 8,
      systemPressure: {
        availableMemoryBytes: 10 * 1024 ** 3,
        observable: true,
      },
    },
    { memoryFloorBytes: 4 * 1024 ** 3 },
  );
  assert.equal(r.status, ANOMALY_STATUS.WATCH);
  assert.notEqual(r.status, ANOMALY_STATUS.ANOMALY);
});

test("judgeReclaimAnomaly: 극단 개수(1,000,000) + 여유 메모리 -- 여전히 WATCH까지만(개수 단독 반증 시도)", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 1_000_000,
      systemPressure: {
        availableMemoryBytes: 10 * 1024 ** 3,
        observable: true,
      },
    },
    { memoryFloorBytes: 4 * 1024 ** 3 },
  );
  assert.equal(r.status, ANOMALY_STATUS.WATCH);
});

test("judgeReclaimAnomaly: 회수 대상 있음 + 가용 메모리가 바닥 아래 -- ANOMALY", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 8,
      systemPressure: { availableMemoryBytes: 1 * 1024 ** 3, observable: true },
    },
    { memoryFloorBytes: 4 * 1024 ** 3 },
  );
  assert.equal(r.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(r.reason, ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR);
});

test("judgeReclaimAnomaly: 회수 대상 적어도(count 낮아도) 메모리가 바닥이면 ANOMALY -- 개수만으론 못 막는다는 것을 뒤집어 확인", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 1,
      systemPressure: {
        availableMemoryBytes: 0.5 * 1024 ** 3,
        observable: true,
      },
    },
    { memoryFloorBytes: 4 * 1024 ** 3 },
  );
  assert.equal(r.status, ANOMALY_STATUS.ANOMALY);
});

test("judgeReclaimAnomaly: 회수 대상 있음 + 메모리 관측 불가 -- ANOMALY(fail-open, 침묵 금지)", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 3,
      systemPressure: { availableMemoryBytes: null, observable: false },
    },
    { memoryFloorBytes: 4 * 1024 ** 3 },
  );
  assert.equal(r.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(r.reason, ANOMALY_REASON.BACKLOG_MEMORY_UNOBSERVABLE);
});

test("judgeReclaimAnomaly: 입력 스키마 결손 -- ANOMALY(침묵보다 신호 우선)", () => {
  const r = judgeReclaimAnomaly({}, { memoryFloorBytes: 4 * 1024 ** 3 });
  assert.equal(r.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(r.reason, ANOMALY_REASON.INPUT_INVALID);
});

test("judgeReclaimAnomaly: policy.memoryFloorBytes 결손 -- ANOMALY(fail-open)", () => {
  const r = judgeReclaimAnomaly(
    {
      eligibleUnreclaimedCount: 2,
      systemPressure: {
        availableMemoryBytes: 10 * 1024 ** 3,
        observable: true,
      },
    },
    {},
  );
  assert.equal(r.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(r.reason, ANOMALY_REASON.INPUT_INVALID);
});

// ---- status/state 미참조(REVIEW 1R ⑵ 재확인, coder-task.md §3-3) ----

test("judgeSeatReclaim: dispatch.status/state 필드가 무엇이든 결과가 안 바뀐다(코어가 그 필드를 안 본다)", () => {
  const results = ["succeeded", "vendor-future-state", "anything"].map(
    (status) =>
      judgeSeatReclaim({
        inventory: {
          ...baseSeatInventory(),
          dispatch: {
            completedAt: "2026-09-04T03:00:00Z",
            observable: true,
            status,
          },
        },
        policy: { protectedSeats: [], minIdleMs: 0 },
        nowMs: NOW,
      }).reclaimEligible,
  );
  assert.deepEqual(results, [true, true, true]);
});
