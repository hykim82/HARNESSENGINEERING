import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeRateLimitStall,
  RATE_LIMIT_STALL_VERDICT,
  RATE_LIMIT_STALL_REASON,
  DEFAULT_LIMIT_WINDOW_MS,
} from "./rate-limit-stall-core.mjs";

test("judgeRateLimitStall: args가 plain object가 아니면 UNDECIDABLE/ARGS_INVALID", () => {
  const r = judgeRateLimitStall(null);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.ARGS_INVALID);
});

test("judgeRateLimitStall: now가 유한수가 아니면 UNDECIDABLE/NOW_INVALID", () => {
  const r = judgeRateLimitStall({ observation: {}, now: "x" });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.NOW_INVALID);
});

test("judgeRateLimitStall: observation이 plain object가 아니면 UNDECIDABLE/OBSERVATION_INVALID", () => {
  const r = judgeRateLimitStall({ observation: "x", now: 1000 });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.OBSERVATION_INVALID);
});

test("judgeRateLimitStall: hitAtMs가 null이면 NOT_APPLICABLE(한도에 걸린 흔적 없음)", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: null, recoveredAtMs: null },
    now: 10000,
  });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.NOT_APPLICABLE);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.NO_HIT_OBSERVED);
});

test("judgeRateLimitStall: hitAtMs가 미래면 UNDECIDABLE/HIT_IN_FUTURE(시계 역전 방어)", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: 20000, recoveredAtMs: null },
    now: 10000,
  });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.HIT_IN_FUTURE);
});

test("judgeRateLimitStall: 회복 관측이 hitAtMs보다 이르면 UNDECIDABLE/RECOVERED_BEFORE_HIT(구조적 모순)", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: 10000, recoveredAtMs: 5000 },
    now: 20000,
  });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.RECOVERED_BEFORE_HIT);
});

test("judgeRateLimitStall: hitAtMs 있고 그 뒤 활동 관측 -> RECOVERED", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: 10000, recoveredAtMs: 15000 },
    now: 20000,
  });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.RECOVERED);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.RECOVERY_OBSERVED);
  assert.deepEqual(r.details, { hitAtMs: 10000, recoveredAtMs: 15000 });
});

test("★HYK-270 핵심: hitAtMs 있고 그 뒤 활동 관측 0 -> STALLED_ON_LIMIT + estimatedRecoveryAtMs(=hitAtMs+창)", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: 10000, recoveredAtMs: null },
    now: 3600000,
  });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.STALLED_ON_LIMIT);
  assert.equal(r.reasonCode, RATE_LIMIT_STALL_REASON.NO_RECOVERY_OBSERVED);
  assert.equal(r.details.hitAtMs, 10000);
  assert.equal(
    r.details.estimatedRecoveryAtMs,
    10000 + DEFAULT_LIMIT_WINDOW_MS,
  );
  assert.equal(r.details.limitWindowMs, DEFAULT_LIMIT_WINDOW_MS);
});

test("judgeRateLimitStall: limitWindowMs를 호출자가 다른 값으로 덮어쓸 수 있다(하드코딩 아님)", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: 10000, recoveredAtMs: null },
    now: 3600000,
    limitWindowMs: 60000,
  });
  assert.equal(r.details.estimatedRecoveryAtMs, 70000);
});

test("judgeRateLimitStall: limitWindowMs가 0 이하면 UNDECIDABLE(형식 위반)", () => {
  const r = judgeRateLimitStall({
    observation: { hitAtMs: 10000, recoveredAtMs: null },
    now: 3600000,
    limitWindowMs: 0,
  });
  assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.UNDECIDABLE);
});
