// HYK-191-reach-1 (coder-task.md §7) -- reach-notify-core.mjs 계약 시험.
// 순수 함수 시험, 파일시스템 접촉 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideNotifications,
  buildNoticeText,
  buildNoticeFileName,
} from "./reach-notify-core.mjs";

function anomaly(axisKey, sinceMs, verdict = "SUSPECTED_ABANDONED") {
  return { axisKey, label: axisKey, verdict, status: null, sinceMs, openMs: 0 };
}

test("first-ever open anomaly (no previous state) is notified (1/1)", () => {
  const { toNotify, nextState } = decideNotifications({
    previousState: null,
    openAnomalies: [anomaly("idle", 1000)],
  });
  assert.equal(toNotify.length, 1);
  assert.equal(toNotify[0].axisKey, "idle");
  assert.deepEqual(nextState, { idle: { sinceMs: 1000 } });
});

test("(d) same ongoing anomaly (same sinceMs) across many ticks is NOT re-notified -- notice fires exactly once (1/1)", () => {
  let state = null;
  let notifyCount = 0;
  for (let i = 0; i < 50; i++) {
    const { toNotify, nextState } = decideNotifications({
      previousState: state,
      openAnomalies: [anomaly("idle", 1000)], // same sinceMs every tick
    });
    notifyCount += toNotify.length;
    state = nextState;
  }
  assert.equal(
    notifyCount,
    1,
    "50 ticks of the SAME open anomaly must produce exactly 1 notification total",
  );
});

test("axis recovers (no longer open) then reopens with a NEW sinceMs -> notified again (fresh transition) (1/1)", () => {
  const afterFirstOpen = decideNotifications({
    previousState: null,
    openAnomalies: [anomaly("seat", 1000)],
  }).nextState;
  const afterRecovery = decideNotifications({
    previousState: afterFirstOpen,
    openAnomalies: [], // recovered
  });
  assert.deepEqual(afterRecovery.nextState, {});
  const afterReopen = decideNotifications({
    previousState: afterRecovery.nextState,
    openAnomalies: [anomaly("seat", 5000)], // new sinceMs
  });
  assert.equal(afterReopen.toNotify.length, 1);
  assert.equal(afterReopen.toNotify[0].sinceMs, 5000);
});

test("multiple axes transitioning in the same tick are all included in toNotify (one bundled event, coder-task.md §1 요건3-b '파일 1장') (1/1)", () => {
  const { toNotify } = decideNotifications({
    previousState: {},
    openAnomalies: [anomaly("seat", 1000), anomaly("idle", 2000)],
  });
  assert.equal(toNotify.length, 2);
});

test("one axis stays open (no notify) while another axis newly opens (notify) in the same tick -- independent per-axis (1/1)", () => {
  const state1 = decideNotifications({
    previousState: null,
    openAnomalies: [anomaly("seat", 1000)],
  }).nextState;
  const { toNotify, nextState } = decideNotifications({
    previousState: state1,
    openAnomalies: [anomaly("seat", 1000), anomaly("idle", 2000)],
  });
  assert.equal(toNotify.length, 1);
  assert.equal(toNotify[0].axisKey, "idle");
  assert.deepEqual(nextState, {
    seat: { sinceMs: 1000 },
    idle: { sinceMs: 2000 },
  });
});

test("buildNoticeText never blank, lists every entry in toNotify, and buildNoticeFileName is filesystem-safe (no colons) (1/1)", () => {
  const text = buildNoticeText({
    toNotify: [anomaly("idle", 1000), anomaly("seat", 2000)],
    nowMs: 3000,
  });
  assert.match(text, /idle/);
  assert.match(text, /seat/);
  assert.ok(text.trim().length > 0);
  const fname = buildNoticeFileName(Date.parse("2026-08-05T05:06:00.000Z"));
  assert.doesNotMatch(fname, /:/);
  assert.match(fname, /\.md$/);
});
