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

// HYK-431 1R -- seat-reclaim-core.mjs 단위시험. 순수 함수라 fake execFn 등이
// 필요 없다(입력 봉투를 손으로 만든다, teardown-core.test.mjs와 동형).

function baseSeatInventory(overrides = {}) {
  return {
    schemaVersion: SEAT_RECLAIM_SCHEMA_VERSION,
    seat: { paneKey: "pane-1" },
    dispatch: { completedAt: "2026-09-04T03:00:00Z", observable: true },
    activity: { idleMs: 10 * 60 * 1000, observable: true },
    ...overrides,
  };
}

// ---- 합성 표적: 「회수 대상」 ----

test("judgeSeatReclaim: dispatch 종료 + 유예 지남 + 비보호 -- RECLAIM_ELIGIBLE", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory(),
    policy: { protectedSeats: [], minIdleMs: 5 * 60 * 1000 },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE);
  assert.equal(r.reclaimEligible, true);
  assert.equal(r.reason, SEAT_REASON.ELIGIBLE);
});

// ---- 합성 표적: 「회수 금지」 ----

test("judgeSeatReclaim: dispatch 진행중(completedAt null) -- DISPATCH_ACTIVE, 회수 금지", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory({
      dispatch: { completedAt: null, observable: true },
    }),
    policy: { protectedSeats: [], minIdleMs: 0 },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.DISPATCH_ACTIVE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.DISPATCH_ACTIVE);
});

test("judgeSeatReclaim: 미래의 새 status 문자열이어도 completedAt이 non-null이면 종료로 본다(§2⑵ 이분 축)", () => {
  // 상태 문자열을 목록으로 열거하지 않는다는 설계를 직접 시험한다 --
  // 이 코어는 status라는 필드 자체를 아예 보지 않는다(inventory에도
  // 없다). 미래에 어떤 새 vendor 상태값이 생겨도 completedAt만 채워지면
  // 이 시험은 그대로 통과해야 한다.
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory({
      dispatch: { completedAt: "2026-12-31T00:00:00Z", observable: true },
    }),
    policy: { protectedSeats: [], minIdleMs: 0 },
  });
  assert.equal(r.reclaimEligible, true);
});

test("judgeSeatReclaim: 보호 목록(exact match) -- PROTECTED가 다른 모든 축을 이긴다", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory(),
    policy: { protectedSeats: ["pane-1"], minIdleMs: 0 },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(r.reclaimEligible, false);
});

test("judgeSeatReclaim: 보호 목록 부분일치는 보호로 치지 않는다(exact match만)", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory({ seat: { paneKey: "pane-12" } }),
    policy: { protectedSeats: ["pane-1"], minIdleMs: 0 },
  });
  assert.notEqual(r.eligibility, SEAT_ELIGIBILITY.PROTECTED);
});

test("judgeSeatReclaim: 유예 구간 안(idleMs < minIdleMs) -- WITHIN_GRACE_PERIOD, 회수 금지", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory({
      activity: { idleMs: 60 * 1000, observable: true },
    }),
    policy: { protectedSeats: [], minIdleMs: 5 * 60 * 1000 },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD);
  assert.equal(r.reclaimEligible, false);
});

// ---- fail-closed: 불확실 입력은 반드시 회수 금지로 떨어진다 ----

test("judgeSeatReclaim: dispatch.observable false -- UNOBSERVABLE, 회수 금지(fail-closed)", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory({
      dispatch: { completedAt: null, observable: false },
    }),
    policy: { protectedSeats: [], minIdleMs: 0 },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.DISPATCH_UNOBSERVABLE);
});

test("judgeSeatReclaim: activity.observable false -- UNOBSERVABLE, 회수 금지(fail-closed)", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory({
      activity: { idleMs: null, observable: false },
    }),
    policy: { protectedSeats: [], minIdleMs: 0 },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.ACTIVITY_UNOBSERVABLE);
});

test("judgeSeatReclaim: policy.minIdleMs 결손 -- 유예 무한대로 접어 회수 금지(fail-closed)", () => {
  const r = judgeSeatReclaim({
    inventory: baseSeatInventory(),
    policy: { protectedSeats: [] },
  });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD);
  assert.equal(r.reclaimEligible, false);
});

test("judgeSeatReclaim: 스키마 결손(target 봉투 자체가 잘못됨) -- UNOBSERVABLE, 회수 금지", () => {
  const r = judgeSeatReclaim({ inventory: { not: "valid" }, policy: {} });
  assert.equal(r.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("judgeSeatReclaim: inventory 자체가 undefined여도 던지지 않고 회수 금지로 떨어진다", () => {
  const r = judgeSeatReclaim({});
  assert.equal(r.reclaimEligible, false);
  assert.equal(r.reason, SEAT_REASON.SCHEMA_INVALID);
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
