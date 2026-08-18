// HYK-285-wake-1 (coder-task.md §3-D) -- wake-decide-core.mjs 계약 시험.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 이 스위트가 100% 통과해도 "실제로 각성이 전송됐다"를 증명하지 않는다
//    -- 이 코어는 주입된 ticks/activeRoundCount/lastWakeAtMs만 판정한다
//    (실 전송·영수증 기록은 wake-wire.test.mjs가 결선을 시험한다).
// 2. 표본 수와 조건은 각 test 이름에 명시한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideWake,
  WAKE_VERDICT,
  WAKE_REASON,
  DEFAULT_WAKE_CONFIG,
} from "./wake-decide-core.mjs";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const CONFIG = {
  sustainTicks: 2,
  cooldownMs: 3_600_000,
  maxTickAgeMs: 2_700_000,
};

function tick(
  offsetMs,
  unconsumedVerdict,
  unconsumedStatus = "UNCONSUMED_JUDGED",
) {
  return { tsMs: NOW + offsetMs, unconsumedStatus, unconsumedVerdict };
}

function baseArgs(overrides = {}) {
  return {
    ticks: [
      tick(-30 * 60_000, "SUSPECTED_UNCONSUMED"),
      tick(-15 * 60_000, "SUSPECTED_UNCONSUMED"),
    ],
    activeRoundCount: 1,
    lastWakeAtMs: null,
    nowMs: NOW,
    config: CONFIG,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 판정 3종 (2 tick 표본, sustainTicks=2 고정)
// ---------------------------------------------------------------------------
test("WAKE: 연속 2 tick SUSPECTED_UNCONSUMED + activeRoundCount>=1 + 쿨다운 없음 (1/1)", () => {
  const r = decideWake(baseArgs());
  assert.equal(r.ok, true);
  assert.equal(r.verdict, WAKE_VERDICT.WAKE);
  assert.equal(r.reasonCode, WAKE_REASON.WAKE_SUSTAINED_UNCONSUMED);
});

test("HOLD: 최신 tick이 CONSUMED면 sustain 조건이 사실로 깨진다 (1/1)", () => {
  const r = decideWake(
    baseArgs({
      ticks: [
        tick(-30 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-15 * 60_000, "CONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.HOLD);
  assert.equal(r.reasonCode, WAKE_REASON.HOLD_NOT_SUSTAINED);
});

test("HOLD: activeRoundCount=0이면 sustain은 만족해도 깨운다 (1/1)", () => {
  const r = decideWake(baseArgs({ activeRoundCount: 0 }));
  assert.equal(r.verdict, WAKE_VERDICT.HOLD);
  assert.equal(r.reasonCode, WAKE_REASON.HOLD_NO_ACTIVE_ROUNDS);
});

test("HOLD: 쿨다운 안(방금 각성을 보냈다) (1/1)", () => {
  const r = decideWake(baseArgs({ lastWakeAtMs: NOW - 1000 }));
  assert.equal(r.verdict, WAKE_VERDICT.HOLD);
  assert.equal(r.reasonCode, WAKE_REASON.HOLD_COOLDOWN);
});

test("UNDECIDABLE: tick 수가 sustainTicks보다 적다 (1/1)", () => {
  const r = decideWake(
    baseArgs({ ticks: [tick(-5 * 60_000, "SUSPECTED_UNCONSUMED")] }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.INSUFFICIENT_TICKS);
});

test("UNDECIDABLE: tick이 하나도 없다 (1/1)", () => {
  const r = decideWake(baseArgs({ ticks: [] }));
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.NO_TICKS);
});

test("UNDECIDABLE: 최신 tick이 maxTickAgeMs보다 오래됐다(감시가 죽음) (1/1)", () => {
  const r = decideWake(
    baseArgs({
      ticks: [
        tick(-60 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-46 * 60_000, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.STALE_WATCH);
});

test("UNDECIDABLE: activeRoundCount 관측 실패(null) (1/1)", () => {
  const r = decideWake(baseArgs({ activeRoundCount: null }));
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.ACTIVE_ROUNDS_UNKNOWN);
});

test("UNDECIDABLE: tick 시각 역전 (1/1)", () => {
  const r = decideWake(
    baseArgs({
      ticks: [
        tick(-5 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-10 * 60_000, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.TICK_OUT_OF_ORDER);
});

test("UNDECIDABLE: tick이 미래 시각 (1/1)", () => {
  const r = decideWake(
    baseArgs({
      ticks: [
        tick(-15 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(60_000, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.TICK_IN_FUTURE);
});

test("UNDECIDABLE: lastWakeAtMs가 미래 시각 (1/1)", () => {
  const r = decideWake(baseArgs({ lastWakeAtMs: NOW + 60_000 }));
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.LAST_WAKE_IN_FUTURE);
});

test("UNDECIDABLE: 형식 위반(ticks가 배열이 아님) (1/1)", () => {
  const r = decideWake(baseArgs({ ticks: "not-an-array" }));
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.TICKS_INVALID);
});

test("UNDECIDABLE: args 자체가 객체가 아니면 throw 없이 판정한다 (1/1)", () => {
  assert.doesNotThrow(() => decideWake(null));
  const r = decideWake(null);
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.ARGS_INVALID);
});

test("UNDECIDABLE: nowMs가 유한수가 아니다 (1/1)", () => {
  const r = decideWake(baseArgs({ nowMs: NaN }));
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.NOW_INVALID);
});

// ---------------------------------------------------------------------------
// 경계값: 정확히 sustainTicks개 / 하나 모자람 / 쿨다운 경계 ±1ms
// ---------------------------------------------------------------------------
test("경계: 정확히 sustainTicks(=3)개 연속이면 WAKE (1/1)", () => {
  const r = decideWake(
    baseArgs({
      config: { ...CONFIG, sustainTicks: 3 },
      ticks: [
        tick(-45 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-30 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-15 * 60_000, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.WAKE);
});

test("경계: sustainTicks(=3)에서 하나 모자라면(2개) UNDECIDABLE(INSUFFICIENT_TICKS) (1/1)", () => {
  const r = decideWake(
    baseArgs({
      config: { ...CONFIG, sustainTicks: 3 },
      ticks: [
        tick(-30 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-15 * 60_000, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.INSUFFICIENT_TICKS);
});

test("경계: 3개 중 가장 오래된 하나만 CONSUMED면(나머지 2 SUSPECTED) HOLD(모자란 sustain) (1/1)", () => {
  const r = decideWake(
    baseArgs({
      config: { ...CONFIG, sustainTicks: 3 },
      ticks: [
        tick(-45 * 60_000, "CONSUMED"),
        tick(-30 * 60_000, "SUSPECTED_UNCONSUMED"),
        tick(-15 * 60_000, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.HOLD);
  assert.equal(r.reasonCode, WAKE_REASON.HOLD_NOT_SUSTAINED);
});

test("경계: 쿨다운 정확히 cooldownMs 지남(포함)이면 WAKE (1/1)", () => {
  const r = decideWake(
    baseArgs({
      lastWakeAtMs: NOW - DEFAULT_WAKE_CONFIG.cooldownMs,
      config: DEFAULT_WAKE_CONFIG,
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.WAKE);
});

test("경계: 쿨다운 1ms 모자라면 HOLD_COOLDOWN (1/1)", () => {
  const r = decideWake(
    baseArgs({
      lastWakeAtMs: NOW - (DEFAULT_WAKE_CONFIG.cooldownMs - 1),
      config: DEFAULT_WAKE_CONFIG,
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.HOLD);
  assert.equal(r.reasonCode, WAKE_REASON.HOLD_COOLDOWN);
});

test("경계: 최신 tick 나이가 정확히 maxTickAgeMs면 아직 UNDECIDABLE(STALE)이 아니다 (1/1)", () => {
  const r = decideWake(
    baseArgs({
      ticks: [
        tick(-(CONFIG.maxTickAgeMs + 15 * 60_000), "SUSPECTED_UNCONSUMED"),
        tick(-CONFIG.maxTickAgeMs, "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.WAKE);
});

test("경계: 최신 tick 나이가 maxTickAgeMs+1ms면 STALE_WATCH (1/1)", () => {
  const r = decideWake(
    baseArgs({
      ticks: [
        tick(-(CONFIG.maxTickAgeMs + 15 * 60_000 + 1), "SUSPECTED_UNCONSUMED"),
        tick(-(CONFIG.maxTickAgeMs + 1), "SUSPECTED_UNCONSUMED"),
      ],
    }),
  );
  assert.equal(r.verdict, WAKE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, WAKE_REASON.STALE_WATCH);
});
