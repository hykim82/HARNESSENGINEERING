import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeDispatchStartBySize,
  DISPATCH_START_SIZE_VERDICT,
  DISPATCH_START_SIZE_REASON,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALL_THRESHOLD_MS,
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

test("계속 늘고 있으면(마지막 증가가 stallThresholdMs 이내) STARTED", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 100 },
      { observedAtMs: 15000, totalBytes: 5000 },
      { observedAtMs: 30000, totalBytes: 9000 }, // 방금도 늘었다.
    ],
    dispatchedAtMs: 0,
    now: 30000,
    stallThresholdMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.GREW_RECENTLY);
});

// ★★HYK-270-stall-visible-3 핵심 -- 2R REVIEW 반려 원문 그대로의 반례
// 관측열(검토자가 `runDispatchStartConfirm`에 직접 주입한 것과 동일 모양):
// `totalBytes = 0 -> 5000 -> 5000 -> …`(승인창 등으로 시작 후 멈춘 사례 2).
// 마지막 증가(15000ms 시점) 이후 `stallThresholdMs`(여기선 60000ms로
// 축소해 시험을 빠르게)를 넘게 더 안 늘었으면 STALLED_AFTER_START여야
// 한다 -- ★2R 코드(운영 중이던 버전)는 "언젠가 늘었다"만 보고 영구히
// STARTED를 냈다(이 시험이 그 결함의 재현 fixture).
test("★★2R 반례 fixture: 0 -> 5000 -> 5000(그 뒤로도 계속 안 늘어남, 마지막 증가로부터 stallThresholdMs 초과) -> STALLED_AFTER_START(★수리 전엔 STARTED로 영구히 새던 자리)", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 15000, totalBytes: 5000 },
      { observedAtMs: 30000, totalBytes: 5000 },
      { observedAtMs: 90000, totalBytes: 5000 }, // 마지막 증가(15000)로부터 75000ms 경과.
    ],
    dispatchedAtMs: 0,
    now: 90000,
    timeoutMs: 180000,
    stallThresholdMs: 60000, // 참고 실측(ORCH)의 3분을 시험 편의상 1분으로 축소(호출자 덮어쓰기 그대로 실증).
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.STALLED_PAST_THRESHOLD);
  assert.equal(r.details.lastGrowthAtMs, 15000);
});

test("«시작 못 함»과 «시작 후 멈춤»은 절대 같은 verdict 문자열이 아니다(사람 조치가 다르므로 값을 뭉개지 않는다)", () => {
  assert.notEqual(
    DISPATCH_START_SIZE_VERDICT.NOT_STARTED,
    DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START,
  );
});

test("judgeDispatchStartBySize: timeoutMs/stallThresholdMs 생략 시 각각의 기본값(3분) 사용", () => {
  const r1 = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: DEFAULT_TIMEOUT_MS + 1000, totalBytes: 0 },
    ],
    dispatchedAtMs: 0,
    now: DEFAULT_TIMEOUT_MS + 1000,
  });
  assert.equal(r1.verdict, DISPATCH_START_SIZE_VERDICT.NOT_STARTED);

  const r2 = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 1000, totalBytes: 100 },
      { observedAtMs: DEFAULT_STALL_THRESHOLD_MS + 2000, totalBytes: 100 },
    ],
    dispatchedAtMs: 0,
    now: DEFAULT_STALL_THRESHOLD_MS + 2000,
  });
  assert.equal(r2.verdict, DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START);
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

test("judgeDispatchStartBySize: stallThresholdMs가 0 이하면 UNDECIDABLE/THRESHOLD_INVALID", () => {
  const r = judgeDispatchStartBySize({
    observations: [],
    dispatchedAtMs: 0,
    now: 1000,
    stallThresholdMs: -1,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});
