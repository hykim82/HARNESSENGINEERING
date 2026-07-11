import { test } from "node:test";
import assert from "node:assert/strict";
import { watchResult, DEFAULT_INTERVAL_S, DEFAULT_KEEPALIVE_S, EXIT_DONE, EXIT_TICK } from "./watch-result.mjs";

// Fake clock: sleepFn advances a shared counter by intervalS*1000 and
// resolves immediately (no real timer), nowFn reads that counter -- this
// lets every test run in milliseconds of wall time while still exercising
// the loop's elapsed-time arithmetic exactly as the real setTimeout-backed
// path would.
function fakeClock(intervalS) {
  let t = 0;
  let sleepCalls = 0;
  return {
    nowFn: () => t,
    sleepFn: async () => {
      sleepCalls++;
      t += intervalS * 1000;
    },
    sleepCallCount: () => sleepCalls,
  };
}

function checkSequence(results) {
  let i = 0;
  return () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
}

test("(1) already done on the first check -> immediate done, no sleep", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([{ ok: true, reason: "relay handshake ok for X" }]);
  const result = await watchResult({ role: "coder", intervalS: 60, maxWaitS: 240, checkFn, sleepFn, nowFn });
  assert.equal(result.status, "done");
  assert.equal(result.elapsedS, 0);
  assert.equal(sleepCallCount(), 0);
});

test("(2) done after 3 ticks -> done, sleepFn called exactly 3 times", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, reason: "not done" },
    { ok: false, reason: "not done" },
    { ok: false, reason: "not done" },
    { ok: true, reason: "relay handshake ok for X" },
  ]);
  const result = await watchResult({ role: "coder", intervalS: 60, maxWaitS: 240, checkFn, sleepFn, nowFn });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 3);
  assert.equal(result.elapsedS, 180);
});

test("(3) maxWaitS reached while still not done -> tick", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([{ ok: false, reason: "not done" }]);
  const result = await watchResult({ role: "review", intervalS: 60, maxWaitS: 180, checkFn, sleepFn, nowFn });
  assert.equal(result.status, "tick");
  assert.equal(result.elapsedS, 180);
  assert.equal(sleepCallCount(), 3);
  assert.match(result.reason, /not done after 180s \(keep-alive tick\)/);
});

test("(4) maxWaitS: 0 (plain mode) -> ignores keep-alive, keeps polling until done", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  // 10 ticks of not-done, well past what DEFAULT_KEEPALIVE_S (240s = 4
  // ticks at 60s) would have tick'd at, then done on the 11th check.
  const notDone = Array(10).fill({ ok: false, reason: "not done" });
  const checkFn = checkSequence([...notDone, { ok: true, reason: "relay handshake ok for X" }]);
  const result = await watchResult({ role: "verify", intervalS: 60, maxWaitS: 0, checkFn, sleepFn, nowFn });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 10);
});

test("(5) checkFn throws -> treated as not done, loop continues instead of crashing", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  let calls = 0;
  const checkFn = () => {
    calls++;
    if (calls < 3) throw new Error("transient read error");
    return { ok: true, reason: "relay handshake ok for X" };
  };
  const result = await watchResult({ role: "coder", intervalS: 60, maxWaitS: 240, checkFn, sleepFn, nowFn });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 2);
});

test("(6) exported constants are fixed at 60/240, exit codes at 0/3", () => {
  assert.equal(DEFAULT_INTERVAL_S, 60);
  assert.equal(DEFAULT_KEEPALIVE_S, 240);
  assert.equal(EXIT_DONE, 0);
  assert.equal(EXIT_TICK, 3);
});
