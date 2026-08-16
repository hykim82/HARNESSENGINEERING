import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeDispatchStartBySize,
  DISPATCH_START_SIZE_VERDICT,
  DISPATCH_START_SIZE_REASON,
  DEFAULT_TIMEOUT_MS,
} from "./dispatch-start-size-core.mjs";

test("judgeDispatchStartBySize: args가 plain object 아니면 UNDECIDABLE/ARGS_INVALID", () => {
  const r = judgeDispatchStartBySize(null);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.ARGS_INVALID);
});

test("judgeDispatchStartBySize: now/dispatchedAtMs 결손 -> UNDECIDABLE", () => {
  const r = judgeDispatchStartBySize({ observations: [] });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
});

test("judgeDispatchStartBySize: observations가 배열이 아니면 UNDECIDABLE/OBSERVATIONS_INVALID", () => {
  const r = judgeDispatchStartBySize({
    observations: "x",
    dispatchedAtMs: 0,
    now: 1000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.OBSERVATIONS_INVALID);
});

test("judgeDispatchStartBySize: 관측 항목 형식 위반(totalBytes 음수) -> UNDECIDABLE/OBSERVATION_MALFORMED", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 100, totalBytes: -1 }],
    dispatchedAtMs: 0,
    now: 1000,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.OBSERVATION_MALFORMED);
});

test("judgeDispatchStartBySize: 관측이 미래 시각이면 UNDECIDABLE/OBSERVATION_IN_FUTURE", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 5000, totalBytes: 10 }],
    dispatchedAtMs: 0,
    now: 1000,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.OBSERVATION_IN_FUTURE);
});

test("★사례1(아예 시작 못 함): 관측 1건뿐이고 아직 타임아웃 전이면 NOT_STARTED로 단정하지 않고 UNDECIDABLE", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 1000, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    timeoutMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
});

test("★사례1(아예 시작 못 함): 타임아웃까지 계속 0에서 안 늘면 NOT_STARTED", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 60000, totalBytes: 0 },
      { observedAtMs: 200000, totalBytes: 0 },
    ],
    dispatchedAtMs: 0,
    now: 200000,
    timeoutMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.NOT_STARTED);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.NO_GROWTH_PAST_TIMEOUT);
});

test("★사례2(시작 후 멈춤): 처음엔 커지다가 이후 안 늘어도, 두 관측 사이에 한 번이라도 증가가 있었으면 STARTED", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 100 },
      { observedAtMs: 15000, totalBytes: 5000 },
      { observedAtMs: 30000, totalBytes: 5000 },
    ],
    dispatchedAtMs: 0,
    now: 30000,
    timeoutMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.GREW);
});

test("judgeDispatchStartBySize: timeoutMs 생략 시 DEFAULT_TIMEOUT_MS(3분) 사용", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: DEFAULT_TIMEOUT_MS + 1000, totalBytes: 0 },
    ],
    dispatchedAtMs: 0,
    now: DEFAULT_TIMEOUT_MS + 1000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.NOT_STARTED);
});

test("judgeDispatchStartBySize: timeoutMs가 0 이하면 UNDECIDABLE/THRESHOLD_INVALID", () => {
  const r = judgeDispatchStartBySize({
    observations: [],
    dispatchedAtMs: 0,
    now: 1000,
    timeoutMs: 0,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});
