import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeLiveness, LIVENESS_REASON } from "./auth-grant-liveness.mjs";

// pm-2 §3.3 표를 그대로 코드화한다: 전 필드 exact+alive+fresh인 baseline에서
// 단 하나의 변수만 바꿔 각각 독립적으로 deny를 반사실 확인한다. 죽이는 변이:
// judgeLiveness가 이 필드들 중 하나라도 실제로 비교하지 않으면(예: 리팩터링
// 실수로 fingerprint 비교를 빠뜨림) 그 필드만 바뀐 이 테스트가 잘못 ALLOW를
// 반환해 실패한다.

const SIGNED_TARGET = Object.freeze({
  handle: "test-terminal",
  fingerprint: "test-fingerprint",
  agent_instance: "test-agent-instance",
});
const EXPECTED_WORKTREE = "worktree-main";
const NOW_MS = Date.parse("2026-07-20T12:00:00.000Z");
const MAX_AGE_MS = 30_000;

const GOOD_OBSERVED = Object.freeze({
  handle: SIGNED_TARGET.handle,
  fingerprint: SIGNED_TARGET.fingerprint,
  agent_instance: SIGNED_TARGET.agent_instance,
  worktree: EXPECTED_WORKTREE,
  liveness: true,
  snapshot_at: NOW_MS - 1000,
  // 보조 관측값(allow 권위 아님) -- 판정에 영향 없어야 한다.
  connected: true,
  writable: true,
  title: "some title",
  preview: "some preview",
  lastOutputAt: NOW_MS - 500,
  heartbeat: null,
});

function judge(overrides = {}) {
  return judgeLiveness({
    signedTarget: SIGNED_TARGET,
    expectedWorktree: EXPECTED_WORKTREE,
    observed: { ...GOOD_OBSERVED, ...overrides },
    nowMs: NOW_MS,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
}

test("judgeLiveness: 전 필드 exact + alive + fresh -> ALLOW", () => {
  const result = judge();
  assert.equal(result.ok, true);
  assert.equal(result.reason, LIVENESS_REASON.ALLOW);
});

test("judgeLiveness: liveness=false -> DENY LIVENESS_NOT_ALIVE", () => {
  const result = judge({ liveness: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.LIVENESS_NOT_ALIVE);
});

test("judgeLiveness: liveness='unknown' (not exact boolean) -> DENY LIVENESS_NOT_ALIVE", () => {
  const result = judge({ liveness: "unknown" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.LIVENESS_NOT_ALIVE);
});

test("judgeLiveness: liveness=null -> DENY LIVENESS_NOT_ALIVE", () => {
  const result = judge({ liveness: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.LIVENESS_NOT_ALIVE);
});

test("judgeLiveness: liveness missing (undefined) -> DENY LIVENESS_NOT_ALIVE", () => {
  const observed = { ...GOOD_OBSERVED };
  delete observed.liveness;
  const result = judgeLiveness({
    signedTarget: SIGNED_TARGET,
    expectedWorktree: EXPECTED_WORKTREE,
    observed,
    nowMs: NOW_MS,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.LIVENESS_NOT_ALIVE);
});

test("judgeLiveness: liveness=1 (truthy but not exact boolean true) -> DENY LIVENESS_NOT_ALIVE", () => {
  const result = judge({ liveness: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.LIVENESS_NOT_ALIVE);
});

test("judgeLiveness: handle 변경 -> DENY HANDLE_MISMATCH", () => {
  const result = judge({ handle: "other-terminal" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.HANDLE_MISMATCH);
});

test("judgeLiveness: fingerprint 변경 -> DENY FINGERPRINT_MISMATCH", () => {
  const result = judge({ fingerprint: "other-fingerprint" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.FINGERPRINT_MISMATCH);
});

test("judgeLiveness: worktree identity 변경 -> DENY WORKTREE_MISMATCH", () => {
  const result = judge({ worktree: "other-worktree" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.WORKTREE_MISMATCH);
});

test("judgeLiveness: agent instance 변경 -> DENY AGENT_INSTANCE_MISMATCH", () => {
  const result = judge({ agent_instance: "other-agent" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.AGENT_INSTANCE_MISMATCH);
});

test("judgeLiveness: agent instance 누락 -> DENY AGENT_INSTANCE_MISMATCH", () => {
  const observed = { ...GOOD_OBSERVED };
  delete observed.agent_instance;
  const result = judgeLiveness({
    signedTarget: SIGNED_TARGET,
    expectedWorktree: EXPECTED_WORKTREE,
    observed,
    nowMs: NOW_MS,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.AGENT_INSTANCE_MISMATCH);
});

test("judgeLiveness: snapshot stale(윈도 초과) -> DENY SNAPSHOT_STALE", () => {
  const result = judge({ snapshot_at: NOW_MS - MAX_AGE_MS - 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.SNAPSHOT_STALE);
});

test("judgeLiveness: snapshot이 미래시각(시계 역전) -> DENY SNAPSHOT_STALE", () => {
  const result = judge({ snapshot_at: NOW_MS + 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.SNAPSHOT_STALE);
});

test("judgeLiveness: 관측시각 파싱 불가 -> DENY SNAPSHOT_TIMESTAMP_INVALID", () => {
  const result = judge({ snapshot_at: "not-a-timestamp" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.SNAPSHOT_TIMESTAMP_INVALID);
});

test("judgeLiveness: 관측시각 누락 -> DENY SNAPSHOT_TIMESTAMP_INVALID", () => {
  const observed = { ...GOOD_OBSERVED };
  delete observed.snapshot_at;
  const result = judgeLiveness({
    signedTarget: SIGNED_TARGET,
    expectedWorktree: EXPECTED_WORKTREE,
    observed,
    nowMs: NOW_MS,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.SNAPSHOT_TIMESTAMP_INVALID);
});

test("judgeLiveness: nowMs가 안전정수 아님 -> DENY SNAPSHOT_TIMESTAMP_INVALID (fail-closed)", () => {
  const result = judgeLiveness({
    signedTarget: SIGNED_TARGET,
    expectedWorktree: EXPECTED_WORKTREE,
    observed: GOOD_OBSERVED,
    nowMs: Number.NaN,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.SNAPSHOT_TIMESTAMP_INVALID);
});

// [보조 관측값 비권위] connected/writable/title/preview/lastOutputAt/heartbeat만
// 나쁘게 바꿔도(다른 모든 권위 필드는 good) 여전히 ALLOW여야 한다 -- pm-2 §3.3
// "이 필드만으로 G6 완료 주장 금지"의 역: 이 필드들이 "거부 권위"도 아님을 증명.
test("judgeLiveness: 보조 관측값(connected/writable/title/preview/lastOutputAt/heartbeat)만 나빠도 ALLOW 유지 -- 권위 아님", () => {
  const result = judge({
    connected: false,
    writable: false,
    title: null,
    preview: null,
    lastOutputAt: null,
    heartbeat: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, LIVENESS_REASON.ALLOW);
});

test("judgeLiveness: signedTarget 필드 결손 -> DENY INPUT_INVALID (never throws)", () => {
  for (const bad of [{}, { handle: "h" }, null, undefined]) {
    assert.doesNotThrow(() => {
      const result = judgeLiveness({
        signedTarget: bad,
        expectedWorktree: EXPECTED_WORKTREE,
        observed: GOOD_OBSERVED,
        nowMs: NOW_MS,
        maxSnapshotAgeMs: MAX_AGE_MS,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, LIVENESS_REASON.INPUT_INVALID);
    });
  }
});

test("judgeLiveness: expectedWorktree 결손 -> DENY INPUT_INVALID", () => {
  const result = judgeLiveness({
    signedTarget: SIGNED_TARGET,
    expectedWorktree: "",
    observed: GOOD_OBSERVED,
    nowMs: NOW_MS,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, LIVENESS_REASON.INPUT_INVALID);
});

test("judgeLiveness: observed가 plain object 아님 -> DENY INPUT_INVALID (never throws)", () => {
  for (const bad of [null, undefined, "string", 42]) {
    assert.doesNotThrow(() => {
      const result = judgeLiveness({
        signedTarget: SIGNED_TARGET,
        expectedWorktree: EXPECTED_WORKTREE,
        observed: bad,
        nowMs: NOW_MS,
        maxSnapshotAgeMs: MAX_AGE_MS,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, LIVENESS_REASON.INPUT_INVALID);
    });
  }
});
