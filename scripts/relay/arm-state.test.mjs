import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import * as mod from "./arm-state.mjs";
import {
  STATE,
  DISARM_CAUSE,
  MARKER_FIELDS,
  canTransition,
  validateGrant,
  createArmStore,
  needsRestartRecovery,
  hashContent,
  verifyClaimBinding,
  claim,
  start,
  finishAttempt,
  cancel,
  checkExpiry,
  recoverIncompleteClaim,
  saveStoreAtomic,
  loadStore,
  commit,
} from "./arm-state.mjs";

// Gate refs = 게이트-기준.md §PKT-20260714-HYK-135-GO-WAIT (이번 사이클 스코프: G1·G2·G3·G4·G9).
// coder-4 (opus 라운드): review-3(HYK-135-review-3, rejected, streak 3)의 fail-closed
// 경계 감사 계약에 맞춰 확장 -- 입력 경계(모든 public 함수 malformed 입력 거부, 누락
// 불가 export 순회), 오류 경계(spawnFn이 marker 삭제 후 throw해도 disarm 보존), 구조
// 경계(loadStore 스키마 검증·손상 store가 TypeError 안 냄). barrier는 import 후·실호출
// 직전으로 이동(review-3 #5).

function makeGrant(overrides = {}) {
  return {
    arm_id: "arm-1",
    cycle_id: "cycle-1",
    human_approval_ref: "sign-1",
    issued_at: "2026-07-14T05:00:00.000Z",
    expires_at: "2026-07-14T06:00:00.000Z",
    allowed_lanes: ["coder"],
    allowed_task_ids: ["HYK-135-coder-1"],
    max_starts_total: 1,
    max_starts_per_lane: 1,
    max_rejections: 0,
    question_policy: "pause",
    error_policy: "pause",
    publish_allowed: false,
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    task_id: "HYK-135-coder-1",
    lane: "coder",
    cycle_id: "cycle-1",
    attempt_id: "attempt-1",
    content_hash: "hash-a",
    at: "2026-07-14 05:30 KST",
    ...overrides,
  };
}

function armedStore(grantOverrides = {}) {
  const created = createArmStore(makeGrant(grantOverrides), { at: "2026-07-14 05:00 KST" });
  assert.equal(created.ok, true);
  return created.store;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "arm-state-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const NOW_OK = () => Date.parse("2026-07-14T05:30:00.000Z");
const NOW_EXPIRED = () => Date.parse("2026-07-14T07:00:00.000Z");

function counter() {
  let n = 0;
  const fn = () => { n++; };
  fn.count = () => n;
  return fn;
}

function markerPathFor(dir, armId, taskId) {
  return join(dir, `claim-${armId}__${taskId}.lock.json`);
}

function tamperMarkerField(dir, armId, taskId, field, value) {
  const path = markerPathFor(dir, armId, taskId);
  const marker = JSON.parse(readFileSync(path, "utf8"));
  marker[field] = value;
  writeFileSync(path, JSON.stringify(marker), "utf8");
}

// Standard claim -> (optionally) started fixture shared by the mutation-loop
// and prototype-key tests below, so each entry point is set up identically.
function setupClaimed(dir, { started } = {}) {
  const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
  const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
  assert.equal(c.ok, true);
  if (!started) return c.store;
  const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
  assert.equal(s.ok, true);
  return s.store;
}

function callEntrypoint(entrypoint, working, { dir, task_id = "HYK-135-coder-1", attempt_id = "attempt-1", spawnFn } = {}) {
  if (entrypoint === "claim-redrop") return claim(working, makeTask({ task_id, attempt_id: "attempt-redrop" }), { dir, nowFn: NOW_OK });
  if (entrypoint === "start") return start(working, { task_id, attempt_id, at: "t2", dir, spawnFn });
  if (entrypoint === "finishAttempt") return finishAttempt(working, { task_id, attempt_id, at: "t2", outcome: "done", dir });
  if (entrypoint === "recover") return recoverIncompleteClaim(working, { at: "t2", task_id, attempt_id, dir });
  throw new Error(`unknown entrypoint ${entrypoint}`);
}

const ENTRYPOINTS = ["claim-redrop", "start", "finishAttempt", "recover"];

// review-1 #6 / review-2 (권고): real cross-thread races with a SharedArrayBuffer
// barrier -- both workers block until both have arrived, so the race actually
// happens at the same instant rather than "whichever worker's async import
// resolved first." Each worker imports the real module and calls the real
// exported function; the exclusivity proven here is the actual node:fs O_EXCL
// guarantee, not an artifact of JS being single-threaded or of scheduling luck.
const ARM_STATE_MODULE_URL = new URL("./arm-state.mjs", import.meta.url).href;

function runInWorker(source, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData });
    worker.once("message", (msg) => {
      worker.terminate().then(() => resolve(msg));
    });
    worker.once("error", reject);
  });
}

// review-4 #5: the barrier must use Atomics.notify -- the earlier version relied on
// a 5ms Atomics.wait timeout, so a second worker could run its real call up to 5ms
// before the first, i.e. sequentially, and the test would still PASS. Now: each
// worker increments; the last to arrive (count >= total) notifies all waiters and
// returns immediately, and every earlier worker blocks in a timeout-less
// Atomics.wait until that notify wakes it. Both are released by the same event, so
// they enter the real fs call together -- the winner is decided by the OS O_EXCL
// race alone, not by scheduling luck.
const BARRIER_WAIT_SRC = `
function barrierWait(sab, total) {
  const arr = new Int32Array(sab);
  Atomics.add(arr, 0, 1);
  if (Atomics.load(arr, 0) >= total) {
    Atomics.notify(arr, 0);
    return;
  }
  for (;;) {
    const v = Atomics.load(arr, 0);
    if (v >= total) return;
    Atomics.wait(arr, 0, v);
  }
}
`;

// review-3 #5: the barrier must sit AFTER `await import()`, immediately before the
// real call -- otherwise the module-load scheduling (not the fs op) is what gets
// synchronized, and a sequential run could still PASS. Importing first, then
// barrier-waiting, guarantees both threads are parked at the exact call site
// and released together, so the winner is decided by the OS O_EXCL race alone.
const CLAIM_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${BARRIER_WAIT_SRC}
(async () => {
  try {
    const mod = await import(workerData.modulePath);
    barrierWait(workerData.barrierBuffer, workerData.barrierCount);
    const result = mod.claim(workerData.store, workerData.task, { dir: workerData.dir, nowFn: () => workerData.nowMs });
    parentPort.postMessage({ ok: result.ok, spawnAllowed: result.spawnAllowed, reason: result.reason });
  } catch (err) {
    parentPort.postMessage({ ok: false, reason: 'worker error: ' + err.message });
  }
})();
`;

const START_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${BARRIER_WAIT_SRC}
(async () => {
  try {
    const mod = await import(workerData.modulePath);
    barrierWait(workerData.barrierBuffer, workerData.barrierCount);
    const result = mod.start(workerData.store, { task_id: workerData.task_id, attempt_id: workerData.attempt_id, at: workerData.at, dir: workerData.dir });
    parentPort.postMessage({ ok: result.ok, spawned: result.spawned, reason: result.reason });
  } catch (err) {
    parentPort.postMessage({ ok: false, spawned: false, reason: 'worker error: ' + err.message });
  }
})();
`;

// G4-3 fix (frozen decidability restore, coder-2 §0): CLAIM_WORKER_SRC used the
// real wall clock (no nowFn), so this test raced against makeGrant()'s fixed
// expires_at (2026-07-14T06:00:00.000Z) -- a time bomb that flips the test to
// permanently red once real time passes that instant. Same nowFn-injection
// pattern as TX_WORKER_SRC (line ~221) to pin the worker's clock to NOW_OK().
function claimInWorker(dir, store, task, barrierBuffer, nowMs = NOW_OK()) {
  return runInWorker(CLAIM_WORKER_SRC, { modulePath: ARM_STATE_MODULE_URL, dir, store, task, barrierBuffer, barrierCount: 2, nowMs });
}

function startInWorker(dir, store, { task_id, attempt_id, at }, barrierBuffer) {
  return runInWorker(START_WORKER_SRC, { modulePath: ARM_STATE_MODULE_URL, dir, store, task_id, attempt_id, at, barrierBuffer, barrierCount: 2 });
}

// coder-6: transaction worker -- calls claimTx (+ startTx if claimed) against a shared
// on-disk arm store, barrier-synced so all workers enter the arm transaction together.
// A stub spawnFn atomically bumps a SharedArrayBuffer counter so the main thread can read
// the true cross-thread spawn total (the oracle for arm-cap enforcement).
const TX_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${BARRIER_WAIT_SRC}
(async () => {
  try {
    const mod = await import(workerData.modulePath);
    barrierWait(workerData.barrierBuffer, workerData.barrierCount);
    const spawnArr = new Int32Array(workerData.spawnBuffer);
    const opts = { nowFn: () => workerData.nowMs, spawnFn: () => { Atomics.add(spawnArr, 0, 1); } };
    const c = mod.claimTx(workerData.dir, workerData.arm_id, workerData.task, opts);
    let s = { ok: false, spawned: false };
    if (c.ok === true && c.spawnAllowed === true) {
      s = mod.startTx(workerData.dir, workerData.arm_id, { task_id: workerData.task.task_id, attempt_id: workerData.task.attempt_id, at: workerData.task.at }, opts);
    }
    parentPort.postMessage({ claimOk: c.ok === true, spawnAllowed: c.spawnAllowed === true, startOk: s.ok === true, spawned: s.spawned === true });
  } catch (err) {
    parentPort.postMessage({ workerThrew: (err && typeof err.message === "string") ? err.message : String(err) });
  }
})();
`;

function txWorker(dir, arm_id, task, nowMs, barrierBuffer, barrierCount, spawnBuffer) {
  return runInWorker(TX_WORKER_SRC, { modulePath: ARM_STATE_MODULE_URL, dir, arm_id, task, nowMs, barrierBuffer, barrierCount, spawnBuffer });
}

// coder-2 (계약 검증): claim-only oracle -- same barrier-synced race as TX_WORKER_SRC but
// calls ONLY claimTx (never startTx), so admission/budget invariants are proven for the
// claim action in isolation from start/spawn semantics.
const CLAIM_ONLY_TX_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${BARRIER_WAIT_SRC}
(async () => {
  try {
    const mod = await import(workerData.modulePath);
    barrierWait(workerData.barrierBuffer, workerData.barrierCount);
    const opts = { nowFn: () => workerData.nowMs };
    const c = mod.claimTx(workerData.dir, workerData.arm_id, workerData.task, opts);
    parentPort.postMessage({ claimOk: c.ok === true, spawnAllowed: c.spawnAllowed === true });
  } catch (err) {
    parentPort.postMessage({ workerThrew: (err && typeof err.message === "string") ? err.message : String(err) });
  }
})();
`;

function claimOnlyTxWorker(dir, arm_id, task, nowMs, barrierBuffer, barrierCount) {
  return runInWorker(CLAIM_ONLY_TX_WORKER_SRC, { modulePath: ARM_STATE_MODULE_URL, dir, arm_id, task, nowMs, barrierBuffer, barrierCount });
}

const FUTURE_ISO = "2026-07-14T12:00:00.000Z";
const TX_NOW_MS = Date.parse("2026-07-14T05:30:00.000Z");

function seedArmStore(dir, arm_id, { taskIds, maxTotal, maxPerLane }) {
  const grant = {
    arm_id,
    cycle_id: "cycle-1",
    human_approval_ref: "sign-1",
    issued_at: "2026-07-14T05:00:00.000Z",
    expires_at: FUTURE_ISO,
    allowed_lanes: ["coder"],
    allowed_task_ids: taskIds,
    max_starts_total: maxTotal,
    max_starts_per_lane: maxPerLane,
    max_rejections: 0,
    question_policy: "pause",
    error_policy: "pause",
    publish_allowed: false,
  };
  const created = createArmStore(grant, { at: "seed" });
  assert.equal(created.ok, true, "seed grant must be valid");
  const saved = commit(mod.armStorePath(dir, arm_id), { ok: true, persist_required: true, store: created.store });
  assert.equal(saved.ok, true);
}

// deterministic PRNG (mulberry32) so property cases are reproducible from a fixed seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// G1: arm x task 전부 일치일 때만 원자 claim, 내용 해시 변경 시 정지
// ---------------------------------------------------------------------------

test("G1-1: normal claim succeeds exactly once (spawn=1)", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    const spawnFn = counter();
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, true);
    assert.equal(c.spawnAllowed, true);
    assert.equal(c.store.state, STATE.CLAIMED);
    assert.equal(c.store.attempts_total, 1);
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), true);

    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "2026-07-14 05:31 KST", dir, spawnFn });
    assert.equal(s.ok, true);
    assert.equal(s.spawned, true);
    assert.equal(spawnFn.count(), 1);
  } finally {
    cleanup(dir);
  }
});

test("G1-2: cycle_id mismatch -> refused AND disarmed (id_mismatch), no marker", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    const c = claim(store, makeTask({ cycle_id: "wrong-cycle" }), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, false);
    assert.equal(c.store.state, STATE.DISARMED);
    assert.equal(c.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), false);
  } finally {
    cleanup(dir);
  }
});

test("G1-3: lane not in allowed_lanes -> refused AND disarmed (id_mismatch), no marker", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    const c = claim(store, makeTask({ lane: "review" }), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, false);
    assert.equal(c.store.state, STATE.DISARMED);
    assert.equal(c.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), false);
  } finally {
    cleanup(dir);
  }
});

test("G1-4: task_id not in allowed_task_ids -> refused AND disarmed (id_mismatch), no marker", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    const c = claim(store, makeTask({ task_id: "HYK-999-coder-1" }), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, false);
    assert.equal(c.store.state, STATE.DISARMED);
    assert.equal(c.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-999-coder-1")), false);
  } finally {
    cleanup(dir);
  }
});

test("G1-5: content hash replaced on same task_id -> id_mismatch, disarm, no second spawn", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const spawnFn = counter();
    const first = claim(store, makeTask({ content_hash: "hash-a" }), { dir, nowFn: NOW_OK });
    assert.equal(first.ok, true);
    start(first.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn });

    const second = claim(first.store, makeTask({ attempt_id: "attempt-2", content_hash: "hash-b" }), { dir, nowFn: NOW_OK });
    assert.equal(second.ok, false);
    assert.equal(second.store.state, STATE.DISARMED);
    assert.equal(second.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
    assert.equal(spawnFn.count(), 1, "second (mismatched) attempt must never spawn");
  } finally {
    cleanup(dir);
  }
});

test("G1-6: pre-existing corrupt/partial marker at first-ever claim -> STATE_CORRUPT, disarm, no spawn", () => {
  const dir = freshDir();
  try {
    writeFileSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1"), '{"arm_id":"arm-1","task_i', "utf8");
    const store = armedStore();
    const spawnFn = counter();
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, false);
    assert.equal(c.store.state, STATE.DISARMED);
    assert.equal(c.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
    assert.equal(spawnFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

test("G1-7: crash before marker write (non-EEXIST throw) -> no marker, next real claim is the one normal attempt", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const crashWrite = () => { throw new Error("simulated crash before fs write"); };
    const crashed = claim(store, makeTask(), { dir, nowFn: NOW_OK, writeFn: crashWrite });
    assert.equal(crashed.ok, false);
    assert.equal(crashed.store.state, STATE.ARMED);
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), false);

    const spawnFn = counter();
    const real = claim(crashed.store, makeTask({ attempt_id: "attempt-2" }), { dir, nowFn: NOW_OK });
    assert.equal(real.ok, true);
    start(real.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-2", at: "t2", dir, spawnFn });
    assert.equal(spawnFn.count(), 1, "exactly the one normal claim spawns");
  } finally {
    cleanup(dir);
  }
});

test("G1-8: crash right after marker write -> a resumed process sees duplicate, spawns 0 extra", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    // Real fs write succeeds (marker committed); process then "crashes" -- start() is
    // deliberately never called, simulating exit before the agent was spawned.
    const claimed = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(claimed.ok, true);

    // A resumed watcher re-reads the same drop and re-attempts the same content.
    const spawnFn = counter();
    const resumed = claim(armedStore(), makeTask({ attempt_id: "attempt-1-resume" }), { dir, nowFn: NOW_OK });
    assert.equal(resumed.ok, false);
    assert.match(resumed.reason, /duplicate|already claimed/);
    assert.equal(spawnFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

test("G1-9: start() refuses when task_id/attempt_id doesn't match the claimed record -- no spawn", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const spawnFn = counter();

    const wrongTask = start(c.store, { task_id: "HYK-999-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn });
    assert.equal(wrongTask.ok, false);
    assert.equal(spawnFn.count(), 0);

    const wrongAttempt = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-wrong", at: "t1", dir, spawnFn });
    assert.equal(wrongAttempt.ok, false);
    assert.equal(spawnFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

test("G1-10: same CLAIMED snapshot passed to start() twice -> second is physically blocked (fs start-marker), spawn stays 1", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const spawnFn = counter();
    const first = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn });
    assert.equal(first.spawned, true);

    // Reuse the SAME stale (pre-start) snapshot -- simulates a caller that
    // didn't thread the returned store forward (exactly review-1's repro).
    const second = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn });
    assert.equal(second.ok, false);
    assert.equal(second.spawned, false);
    assert.equal(spawnFn.count(), 1);
  } finally {
    cleanup(dir);
  }
});

test("G1-11: claim marker deleted mid-flight, per entry point -- STATE_CORRUPT, 0 spawn, only the 'disarmed' receipt added", () => {
  for (const entrypoint of ENTRYPOINTS) {
    const dir = freshDir();
    try {
      const working = setupClaimed(dir, { started: entrypoint === "finishAttempt" });
      unlinkSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1"));

      const spawnFn = counter();
      const receiptsBefore = working.receipts.length;
      const result = callEntrypoint(entrypoint, working, { dir, spawnFn });

      assert.equal(result.ok, false, entrypoint);
      assert.equal(result.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT, entrypoint);
      assert.equal(spawnFn.count(), 0, entrypoint);
      assert.equal(result.store.receipts.length, receiptsBefore + 1, `${entrypoint}: no extra receipts beyond the disarm record`);
      assert.equal(result.store.receipts.at(-1).event, "disarmed", entrypoint);
    } finally {
      cleanup(dir);
    }
  }
});

test("G1-12: claim marker field tampered (valid JSON, one field wrong) mid-flight, per entry point -- ID_MISMATCH", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, true);
    const path = markerPathFor(dir, "arm-1", "HYK-135-coder-1");
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.content_hash = "tampered-hash";
    writeFileSync(path, JSON.stringify(tampered), "utf8");

    const redrop = claim(c.store, makeTask({ attempt_id: "attempt-2" }), { dir, nowFn: NOW_OK });
    assert.equal(redrop.ok, false);
    assert.equal(redrop.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
  } finally {
    cleanup(dir);
  }
});

// coder-3 계약: 5필드 전수 변조 x 4 진입점 -- 필드·진입점을 배열로 돌려 누락 불가
// 구조로(module이 내보내는 MARKER_FIELDS를 그대로 씀 -- 목록이 module/test 사이에서
// 어긋날 수 없다). 매 조합에서 fail-closed disarm(ID_MISMATCH) + 기동 0 + receipt는
// "disarmed" 한 줄만 추가(오염 0)를 확인한다.
test("G1-13: 5-field marker mutation loop x 4 entry points -> fail-closed ID_MISMATCH, 0 spawn, 0 receipt pollution", () => {
  assert.equal(MARKER_FIELDS.length, 5, "sanity: the invariant covers all 5 identity fields");
  let combinations = 0;
  for (const field of MARKER_FIELDS) {
    for (const entrypoint of ENTRYPOINTS) {
      combinations++;
      const dir = freshDir();
      try {
        const working = setupClaimed(dir, { started: entrypoint === "finishAttempt" });
        tamperMarkerField(dir, "arm-1", "HYK-135-coder-1", field, "tampered-value");

        const spawnFn = counter();
        const receiptsBefore = working.receipts.length;
        const result = callEntrypoint(entrypoint, working, { dir, spawnFn });

        assert.equal(result.ok, false, `${field}/${entrypoint} must fail-closed`);
        assert.equal(result.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH, `${field}/${entrypoint} cause`);
        assert.equal(spawnFn.count(), 0, `${field}/${entrypoint} no spawn`);
        assert.equal(result.store.receipts.length, receiptsBefore + 1, `${field}/${entrypoint} no receipt pollution`);
        assert.equal(result.store.receipts.at(-1).event, "disarmed", `${field}/${entrypoint}`);
      } finally {
        cleanup(dir);
      }
    }
  }
  assert.equal(combinations, MARKER_FIELDS.length * ENTRYPOINTS.length);
});

// coder-3 계약: prototype-polluting task_id/attempt_id(toString/constructor/
// __proto__ 등) x 진입점 -- Object.hasOwn 기반 own-property 검사라 브라켓 접근의
// 프로토타입 체인 우회가 통하지 않음을 직접 증명한다(review-2 실제 재현 사례).
test("G1-14: prototype-polluting task_id/attempt_id refused at every entry point (own-property check, not bracket lookup)", () => {
  const PROTOTYPE_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];
  for (const key of PROTOTYPE_KEYS) {
    for (const entrypoint of ["start", "finishAttempt", "recover"]) {
      // (a) task_id itself is a prototype key -- Object.hasOwn(claims, key) must be false.
      const dirA = freshDir();
      try {
        const working = setupClaimed(dirA, { started: entrypoint === "finishAttempt" });
        const spawnFn = counter();
        const result = callEntrypoint(entrypoint, working, { dir: dirA, task_id: key, attempt_id: "attempt-1", spawnFn });
        assert.equal(result.ok, false, `task_id=${key}/${entrypoint}`);
        assert.equal(spawnFn.count(), 0, `task_id=${key}/${entrypoint}`);
      } finally {
        cleanup(dirA);
      }

      // (b) task_id is valid, attempt_id is a prototype key -- must mismatch, not resolve.
      const dirB = freshDir();
      try {
        const working = setupClaimed(dirB, { started: entrypoint === "finishAttempt" });
        const spawnFn = counter();
        const result = callEntrypoint(entrypoint, working, { dir: dirB, task_id: "HYK-135-coder-1", attempt_id: key, spawnFn });
        assert.equal(result.ok, false, `attempt_id=${key}/${entrypoint}`);
        assert.equal(spawnFn.count(), 0, `attempt_id=${key}/${entrypoint}`);
      } finally {
        cleanup(dirB);
      }
    }
  }
});

test("G1-15: verifyClaimBinding directly -- own-property + required fields + 5-field marker match, all in one place", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const ok = verifyClaimBinding(c.store, { dir, task_id: "HYK-135-coder-1", attempt_id: "attempt-1" });
    assert.equal(ok.ok, true);
    assert.equal(ok.claimRecord.attempt_id, "attempt-1");

    const badTask = verifyClaimBinding(c.store, { dir, task_id: "toString", attempt_id: "attempt-1" });
    assert.equal(badTask.ok, false);
    assert.equal(badTask.corrupt, true);

    const badAttempt = verifyClaimBinding(c.store, { dir, task_id: "HYK-135-coder-1", attempt_id: "wrong" });
    assert.equal(badAttempt.ok, false);
    assert.equal(badAttempt.mismatch, true);

    const missingArgs = verifyClaimBinding(c.store, { dir, task_id: "HYK-135-coder-1", attempt_id: undefined });
    assert.equal(missingArgs.ok, false);
    assert.equal(missingArgs.corrupt, true);
  } finally {
    cleanup(dir);
  }
});

// review-3 #1 (입력 경계): 초기 ARMED claim이 undefined attempt_id/content_hash를
// 수락해 부분 marker를 만들던 구멍. 이제 순수 거부(disarm 아님 -- caller 버그가
// 멀쩡한 ARMED arm을 죽이면 안 됨) + marker 0.
test("G1-16: claim() rejects malformed task input (undefined attempt_id/content_hash) -- no marker, no state change", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    for (const bad of [{ attempt_id: undefined }, { content_hash: undefined }, { attempt_id: "" }, { cycle_id: null }, { at: undefined }]) {
      const r = claim(store, makeTask(bad), { dir, nowFn: NOW_OK });
      assert.equal(r.ok, false, `bad=${JSON.stringify(bad)}`);
      assert.match(r.reason, /input rejected/, `bad=${JSON.stringify(bad)}`);
      assert.equal(r.store.state, STATE.ARMED, "pure refuse -- no disarm on malformed input");
      assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), false, "no partial marker written");
    }
    // task not even an object.
    const r2 = claim(store, undefined, { dir, nowFn: NOW_OK });
    assert.equal(r2.ok, false);
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), false);
  } finally {
    cleanup(dir);
  }
});

// review-3 #2 (marker 무결성): 부분 marker(attempt_id 없는 유효 JSON)가 정상 재시도와
// 섞였을 때. content 필드는 일치해도 5요소 구조 검증에서 STATE_CORRUPT로 걸린다
// (조용한 duplicate로 넘어가지 않음).
test("G1-17: fresh claim colliding with a partial marker (missing attempt_id) -> STATE_CORRUPT, not silent duplicate", () => {
  const dir = freshDir();
  try {
    const partial = { arm_id: "arm-1", task_id: "HYK-135-coder-1", cycle_id: "cycle-1", content_hash: "hash-a", claimed_at: "old" };
    writeFileSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1"), JSON.stringify(partial), "utf8");
    const store = armedStore();
    const r = claim(store, makeTask({ attempt_id: "attempt-new" }), { dir, nowFn: NOW_OK });
    assert.equal(r.ok, false);
    assert.equal(r.store.state, STATE.DISARMED);
    assert.equal(r.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
  } finally {
    cleanup(dir);
  }
});

// review-4 #1 (값-수준: grant 중첩): allowed_lanes/allowed_task_ids가 배열이 아니면
// (문자열/객체) loadStore부터 STATE_CORRUPT. 배열이면 .includes는 정확 일치만 --
// 부분문자열(lane="view" vs allowed ["review"])은 미허용으로 disarm.
test("G1-18: grant nested value validation -- string/object in array fields rejected by loadStore; matching is exact (no substring)", () => {
  const dir = freshDir();
  try {
    // (a) 문자열이 배열 자리에 -> loadStore STATE_CORRUPT (이후 .includes 부분일치·TypeError 봉쇄).
    const strGrant = { ...makeGrant(), allowed_lanes: "review", allowed_task_ids: "HYK-135" };
    const p1 = join(dir, "str-grant.json");
    writeFileSync(p1, JSON.stringify({ ...armedStore(), grant: strGrant }), "utf8");
    const l1 = loadStore(p1);
    assert.equal(l1.ok, false);
    assert.match(l1.reason, /STATE_CORRUPT/);
    assert.match(l1.reason, /allowed_lanes|allowed_task_ids/);

    // (b) 객체 {}가 배열 자리에 -> 거부, 이후 .includes is not a function TypeError 없음.
    const objGrant = { ...makeGrant(), allowed_lanes: {}, allowed_task_ids: {} };
    const p2 = join(dir, "obj-grant.json");
    writeFileSync(p2, JSON.stringify({ ...armedStore(), grant: objGrant }), "utf8");
    assert.equal(loadStore(p2).ok, false);

    // (c) 정확 일치: allowed=["review"] 에 lane="view"(부분문자열)는 미허용 -> mismatch disarm.
    const store = armedStore({ allowed_lanes: ["review"], allowed_task_ids: ["HYK-135-coder-1"] });
    const rv = claim(store, makeTask({ lane: "view" }), { dir, nowFn: NOW_OK });
    assert.equal(rv.ok, false);
    assert.equal(rv.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
    // ...and task_id substring is likewise rejected.
    const store2 = armedStore({ allowed_lanes: ["coder"], allowed_task_ids: ["HYK-135-coder-1"] });
    const rt = claim(store2, makeTask({ task_id: "HYK-135" }), { dir, nowFn: NOW_OK });
    assert.equal(rt.ok, false);
    assert.equal(rt.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
  } finally {
    cleanup(dir);
  }
});

// review-4 #2 (값-수준: 예산 내부값): attempts_*·per_lane 값이 유한·비음수 정수가 아니면
// (음수/Symbol/문자열) loadStore 또는 진입점 가드에서 STATE_CORRUPT -- 상한 우회·TypeError 0.
test("G1-19: per-lane budget corruption (negative / symbol / string) -> STATE_CORRUPT, no cap bypass, no TypeError", () => {
  const dir = freshDir();
  try {
    // (a) JSON-serializable 음수 -> loadStore 거부(상한 우회 봉쇄).
    const p = join(dir, "neg-budget.json");
    writeFileSync(p, JSON.stringify({ ...armedStore(), attempts_total: 1, attempts_per_lane: { coder: -1 } }), "utf8");
    const l = loadStore(p);
    assert.equal(l.ok, false);
    assert.match(l.reason, /STATE_CORRUPT/);

    // (b) 문자열 rejections -> loadStore 거부.
    const p2 = join(dir, "str-budget.json");
    writeFileSync(p2, JSON.stringify({ ...armedStore(), rejections: "0" }), "utf8");
    assert.equal(loadStore(p2).ok, false);

    // (c) 인메모리 Symbol 주입이 진입점에 도달해도 TypeError 없이 STATE_CORRUPT 거부/disarm.
    const symStore = { ...armedStore(), attempts_per_lane: { coder: Symbol("bad") } };
    let res;
    assert.doesNotThrow(() => { res = claim(symStore, makeTask(), { dir, nowFn: NOW_OK }); }, "Symbol budget must not TypeError");
    assert.equal(res.ok, false);
    assert.match(res.reason, /STATE_CORRUPT/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// G2: 전이표 밖 전부 거부, disarm 원인별, 추정 DONE 금지
// ---------------------------------------------------------------------------

test("G2-1: exhaustive transition matrix -- only the designed edges are accepted", () => {
  const allowed = new Set([
    `${STATE.ARMED}->${STATE.CLAIMED}`,
    `${STATE.CLAIMED}->${STATE.RUNNING}`,
    `${STATE.RUNNING}->${STATE.DONE}`,
    `${STATE.RUNNING}->${STATE.QUESTION_PAUSED}`,
    `${STATE.RUNNING}->${STATE.ERROR_PAUSED}`,
    `${STATE.DONE}->${STATE.DISARMED}`,
    `${STATE.QUESTION_PAUSED}->${STATE.DISARMED}`,
    `${STATE.ERROR_PAUSED}->${STATE.DISARMED}`,
  ]);
  const all = Object.values(STATE);
  let checked = 0;
  for (const from of all) {
    for (const to of all) {
      const key = `${from}->${to}`;
      assert.equal(canTransition(from, to), allowed.has(key), `mismatch for ${key}`);
      checked++;
    }
  }
  assert.equal(checked, all.length * all.length);
});

test("G2-2: illegal transition via API rejected -- start() on a terminal DONE store", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "done", dir });
    assert.equal(f.store.state, STATE.DISARMED);

    // Binding still checks out (the claim marker is untouched by finish), and
    // the start-marker from the original start() already exists here too --
    // either the transition-table rejection or the start-marker duplicate can
    // legitimately be what fires first; both correctly refuse with 0 spawn,
    // which is the actual property under test.
    const illegal = start(f.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t3", dir });
    assert.equal(illegal.ok, false);
    assert.match(illegal.reason, /illegal transition|already started/);
    assert.equal(illegal.spawned, false);
  } finally {
    cleanup(dir);
  }
});

test("G2-3: disarm cause=complete on outcome 'done', never accidentally on other outcomes", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "done", dir });
    assert.equal(f.ok, true);
    assert.equal(f.store.state, STATE.DISARMED);
    assert.equal(f.store.disarm_cause, DISARM_CAUSE.COMPLETE);
  } finally {
    cleanup(dir);
  }
});

test("G2-4: disarm cause=question, classified QUESTION_PAUSED, immediate disarm", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "question", dir, detail: { question_id: "q1" } });
    assert.equal(f.ok, true);
    assert.equal(f.store.state, STATE.DISARMED);
    assert.equal(f.store.disarm_cause, DISARM_CAUSE.QUESTION);
    assert.equal(f.store.paused_label, "QUESTION_PAUSED");
  } finally {
    cleanup(dir);
  }
});

test("G2-5: disarm cause=error for outcome 'error'", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "error", dir });
    assert.equal(f.store.disarm_cause, DISARM_CAUSE.ERROR);
    assert.equal(f.store.paused_label, "ERROR_PAUSED");
  } finally {
    cleanup(dir);
  }
});

test("G2-6: disarm cause=expired when grant TTL has passed", () => {
  const store = armedStore();
  const r = checkExpiry(store, NOW_EXPIRED, "2026-07-14 07:00 KST");
  assert.equal(r.expired, true);
  assert.equal(r.store.state, STATE.DISARMED);
  assert.equal(r.store.disarm_cause, DISARM_CAUSE.EXPIRED);
});

test("G2-7: disarm cause=cancelled", () => {
  const store = armedStore();
  const r = cancel(store, { at: "t1", reason: "human cancel" });
  assert.equal(r.ok, true);
  assert.equal(r.store.state, STATE.DISARMED);
  assert.equal(r.store.disarm_cause, DISARM_CAUSE.CANCELLED);
});

test("G2-8: disarm cause=id_mismatch (content replaced mid-flight)", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const first = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const second = claim(first.store, makeTask({ attempt_id: "a2", content_hash: "hash-b" }), { dir, nowFn: NOW_OK });
    assert.equal(second.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);
  } finally {
    cleanup(dir);
  }
});

test("G2-9: disarm cause=state_corrupt (marker unreadable at initial claim)", () => {
  const dir = freshDir();
  try {
    writeFileSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1"), "not-json{{{", "utf8");
    const store = armedStore();
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(c.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
  } finally {
    cleanup(dir);
  }
});

test("G2-10: disarm cause=incomplete_claim_restart", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const r = recoverIncompleteClaim(s.store, { at: "t2", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir });
    assert.equal(r.ok, true);
    assert.equal(r.store.disarm_cause, DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART);
  } finally {
    cleanup(dir);
  }
});

test("G2-11: disarm cause=budget_exhausted", () => {
  const grant = makeGrant({ max_starts_total: 1 });
  const created = createArmStore(grant, { at: "t0" });
  const atCapStore = { ...created.store, state: STATE.ARMED, attempts_total: 1 };
  const c = claim(atCapStore, makeTask(), { dir: freshDir(), nowFn: NOW_OK });
  assert.equal(c.ok, false);
  assert.equal(c.store.disarm_cause, DISARM_CAUSE.BUDGET_EXHAUSTED);
});

// ---------------------------------------------------------------------------
// G3: 예산 = claim 시점 차감, 상한 초과 기동 0
// ---------------------------------------------------------------------------

test("G3-1: attempt charged once at claim; finishAttempt never re-charges regardless of outcome", () => {
  for (const outcome of ["done", "error", "rejected", "cli_abnormal_exit", "startup_failure"]) {
    const dir = freshDir();
    try {
      const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
      const c = claim(store, makeTask({ attempt_id: `a-${outcome}` }), { dir, nowFn: NOW_OK });
      assert.equal(c.store.attempts_total, 1, `outcome=${outcome}`);
      const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: `a-${outcome}`, at: "t1", dir });
      const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: `a-${outcome}`, at: "t2", outcome, dir });
      assert.equal(f.store.attempts_total, 1, `outcome=${outcome} must not add a second charge`);
    } finally {
      cleanup(dir);
    }
  }
});

test("G3-2: max_starts_total exhausted -> next claim refused, 0 additional spawns", () => {
  const grant = makeGrant({ max_starts_total: 1 });
  const created = createArmStore(grant, { at: "t0" });
  const atCap = { ...created.store, state: STATE.ARMED, attempts_total: 1 };
  const spawnFn = counter();
  const c = claim(atCap, makeTask(), { dir: freshDir(), nowFn: NOW_OK });
  assert.equal(c.ok, false);
  assert.equal(c.spawnAllowed, false);
  assert.equal(spawnFn.count(), 0);
});

test("G3-3: max_starts_per_lane exhausted -> next claim in that lane refused", () => {
  const grant = makeGrant({ max_starts_total: 5, max_starts_per_lane: 1 });
  const created = createArmStore(grant, { at: "t0" });
  const atCap = { ...created.store, state: STATE.ARMED, attempts_per_lane: { coder: 1 } };
  const c = claim(atCap, makeTask(), { dir: freshDir(), nowFn: NOW_OK });
  assert.equal(c.ok, false);
  assert.equal(c.store.disarm_cause, DISARM_CAUSE.BUDGET_EXHAUSTED);
});

test("G3-4: max_rejections exhausted -> next claim refused", () => {
  const grant = makeGrant({ max_starts_total: 5, max_starts_per_lane: 5, max_rejections: 1 });
  const created = createArmStore(grant, { at: "t0" });
  const atCap = { ...created.store, state: STATE.ARMED, attempts_total: 1, rejections: 1 };
  const c = claim(atCap, makeTask(), { dir: freshDir(), nowFn: NOW_OK });
  assert.equal(c.ok, false);
  assert.equal(c.store.disarm_cause, DISARM_CAUSE.BUDGET_EXHAUSTED);
});

test("G3-5: outcome 'rejected' increments the rejections counter exactly once", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5, max_rejections: 3 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "rejected", dir });
    assert.equal(f.store.rejections, 1);
  } finally {
    cleanup(dir);
  }
});

test("G3-6: spawnFn throws -> caught as startup_failure (ERROR_PAUSED->DISARMED), never left stuck in CLAIMED/RUNNING", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const throwingSpawn = () => { throw new Error("agent failed to launch"); };
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn: throwingSpawn });
    assert.equal(s.ok, false);
    assert.equal(s.spawned, false);
    assert.equal(s.store.state, STATE.DISARMED);
    assert.equal(s.store.disarm_cause, DISARM_CAUSE.ERROR);
    assert.equal(s.store.attempts_total, 1, "attempt charged once at claim, not re-charged on startup failure");

    const again = claim(s.store, makeTask({ attempt_id: "attempt-2" }), { dir, nowFn: NOW_OK });
    assert.equal(again.ok, false, "an already-disarmed arm never spawns again");
  } finally {
    cleanup(dir);
  }
});

// review-3 #3 (오류 경계): spawnFn이 claim marker를 삭제한 뒤 throw하면, 이전엔
// finishAttempt의 disarm 결과를 버리고 RUNNING을 반환했다. 이제 start()는 spawn throw
// 이후 절대 RUNNING으로 남지 않는다 -- disarm이 보존된다.
test("G3-7: spawnFn deletes the claim marker then throws -> start() still disarms (disarm result preserved)", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const markerP = markerPathFor(dir, "arm-1", "HYK-135-coder-1");
    const evilSpawn = () => {
      unlinkSync(markerP);
      throw new Error("crash after tampering the marker");
    };
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn: evilSpawn });
    assert.equal(s.ok, false);
    assert.equal(s.spawned, false);
    assert.equal(s.store.state, STATE.DISARMED, "must never remain RUNNING after a spawn throw");
    assert.ok(
      [DISARM_CAUSE.STATE_CORRUPT, DISARM_CAUSE.ERROR].includes(s.store.disarm_cause),
      `expected a terminal disarm cause, got ${s.store.disarm_cause}`,
    );
    // The stop is observable: the last receipt records a disarm (or the fail-closed fallback).
    assert.ok(["disarmed", "fail_closed_fallback"].includes(s.store.receipts.at(-1).event));
  } finally {
    cleanup(dir);
  }
});

// review-4 #3 (오류 경계, 비표준 throw): spawnFn이 Error가 아닌 값(null/문자열/객체)을
// throw해도 catch가 2차 throw 없이 완주, DISARMED로 끝난다.
test("G3-8: spawnFn throws a non-Error value (null / string / object) -> start() still disarms, no secondary throw", () => {
  for (const thrown of [null, "string failure", 42, { weird: true }, undefined]) {
    const dir = freshDir();
    try {
      const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
      const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
      const badSpawn = () => { throw thrown; };
      let s;
      assert.doesNotThrow(() => {
        s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn: badSpawn });
      }, `throw ${JSON.stringify(thrown)} must not cause a secondary throw`);
      assert.equal(s.ok, false, `thrown=${JSON.stringify(thrown)}`);
      assert.equal(s.spawned, false);
      assert.equal(s.store.state, STATE.DISARMED, `thrown=${JSON.stringify(thrown)} must end DISARMED`);
    } finally {
      cleanup(dir);
    }
  }
});

// ---------------------------------------------------------------------------
// G4: 경계 케이스 전반에서 중복 기동 0 (실제 동시 경합 포함, barrier로 동시 진입 보장)
// ---------------------------------------------------------------------------

test("G4-1: same-instant drop twice -> exactly one spawn", () => {
  const dir = freshDir();
  try {
    const at = "2026-07-14 05:30:00 KST";
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const spawnFn = counter();
    const first = claim(store, makeTask({ at }), { dir, nowFn: NOW_OK });
    assert.equal(first.ok, true);
    start(first.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at, dir, spawnFn });

    const second = claim(store, makeTask({ attempt_id: "attempt-1b", at }), { dir, nowFn: NOW_OK });
    assert.equal(second.ok, false);
    assert.equal(spawnFn.count(), 1);
  } finally {
    cleanup(dir);
  }
});

test("G4-2: rapid successive identical-content drops -> only the first wins", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const spawnFn = counter();
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = claim(store, makeTask({ attempt_id: `attempt-${i}` }), { dir, nowFn: NOW_OK });
      results.push(r);
      if (r.ok) start(r.store, { task_id: "HYK-135-coder-1", attempt_id: `attempt-${i}`, at: `t${i}`, dir, spawnFn });
    }
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(spawnFn.count(), 1);
  } finally {
    cleanup(dir);
  }
});

test("G4-3: real barrier-synchronized concurrent claim race (two worker threads, same task, forced same instant) -- exactly one wins", async () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const task = makeTask({ attempt_id: "attempt-race" });
    const barrierBuffer = new SharedArrayBuffer(4);
    const [a, b] = await Promise.all([claimInWorker(dir, store, task, barrierBuffer), claimInWorker(dir, store, task, barrierBuffer)]);
    const wins = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    assert.equal(wins.length, 1, `expected exactly one winner, got ${JSON.stringify([a, b])}`);
    assert.equal(losers.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("G4-3b: real barrier-synchronized concurrent start race (two worker threads, same claimed attempt, forced same instant) -- exactly one spawns", async () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, true);
    const barrierBuffer = new SharedArrayBuffer(4);
    const [a, b] = await Promise.all([
      startInWorker(dir, c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1" }, barrierBuffer),
      startInWorker(dir, c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1" }, barrierBuffer),
    ]);
    const spawned = [a, b].filter((r) => r.spawned);
    assert.equal(spawned.length, 1, `expected exactly one spawn, got ${JSON.stringify([a, b])}`);
  } finally {
    cleanup(dir);
  }
});

test("G4-4: stale DONE -- claim against an already-disarmed (done) arm is refused, no spawn", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "done", dir });
    assert.equal(f.store.state, STATE.DISARMED);

    const spawnFn = counter();
    const stale = claim(f.store, makeTask({ attempt_id: "attempt-late" }), { dir, nowFn: NOW_OK });
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /already DISARMED/);
    assert.equal(spawnFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

test("G4-5: content replaced after claim -- total spawns across both attempts stays 1", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const spawnFn = counter();
    const first = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    start(first.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn });
    const second = claim(first.store, makeTask({ attempt_id: "a2", content_hash: "hash-changed" }), { dir, nowFn: NOW_OK });
    assert.equal(second.ok, false);
    assert.equal(spawnFn.count(), 1);
  } finally {
    cleanup(dir);
  }
});

// review-4 #4 (TOCTOU): binding 확인과 spawn 사이 창에서 claim marker가 사라지면
// start()는 spawn 없이 disarm해야 한다. start marker write 훅이 그 순간 claim marker를
// 삭제하도록 주입 -- spawn 직전 재검증이 이를 잡는다.
test("G4-6: TOCTOU -- claim marker deleted during start-marker write -> re-verify catches it, 0 spawn, disarm", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const markerP = markerPathFor(dir, "arm-1", "HYK-135-coder-1");
    const spawnFn = counter();
    // Injected start-marker writer: deletes the claim marker (the TOCTOU window),
    // then writes the start marker normally so acquireStartMarker still "wins".
    const racyStartWrite = (path, content) => {
      unlinkSync(markerP);
      writeFileSync(path, content, { flag: "wx" });
    };
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn, writeFn: racyStartWrite });
    assert.equal(s.ok, false);
    assert.equal(s.spawned, false);
    assert.equal(spawnFn.count(), 0, "spawn must not happen once the marker vanished");
    assert.equal(s.store.state, STATE.DISARMED);
    assert.equal(s.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
    assert.match(s.reason, /TOCTOU/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// G9: 재시작 시 미완료 claim -> 자동 재소비 금지, 결과 덮어쓰기 금지
// ---------------------------------------------------------------------------

test("G9-1: recover on RUNNING store -> PAUSED/disarmed, no spawn triggered by recovery", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    assert.equal(needsRestartRecovery(s.store), true);

    const spawnLogFn = counter();
    const r = recoverIncompleteClaim(s.store, { at: "t2", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir, spawnLogFn });
    assert.equal(r.ok, true);
    assert.equal(r.store.state, STATE.DISARMED);
    assert.equal(r.store.disarm_cause, DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART);
    assert.equal(r.store.paused_label, "PAUSED");
    assert.equal(r.store.needs_human_ack, true);
    assert.equal(spawnLogFn.count(), 1, "recovery itself must never spawn -- only log the no-op");
  } finally {
    cleanup(dir);
  }
});

test("G9-2: recover on CLAIMED (never reached RUNNING) store -> same recovery path", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(needsRestartRecovery(c.store), true);
    const r = recoverIncompleteClaim(c.store, { at: "t2", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir });
    assert.equal(r.ok, true);
    assert.equal(r.store.disarm_cause, DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART);
  } finally {
    cleanup(dir);
  }
});

test("G9-3: recover is a no-op on an already-DONE store -- result byte-identical, no overwrite", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "done", dir });
    assert.equal(needsRestartRecovery(f.store), false);

    const before = JSON.stringify(f.store);
    const r = recoverIncompleteClaim(f.store, { at: "t3", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir });
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(f.store), before, "existing DONE result must not be mutated");
  } finally {
    cleanup(dir);
  }
});

test("G9-4: recover is a no-op on an ARMED (never claimed) store", () => {
  const store = armedStore();
  const r = recoverIncompleteClaim(store, { at: "t1" });
  assert.equal(r.ok, false);
});

test("G9-5: fail-closed commit -- persistence failure leaves on-disk state untouched, never DONE", () => {
  const dir = freshDir();
  const path = join(dir, "arm-1.json");
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const okSave = commit(path, c);
    assert.equal(okSave.ok, true);
    const before = readFileSync(path, "utf8");

    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    const f = finishAttempt(s.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t2", outcome: "question", dir });
    assert.equal(f.ok, true, "pure transition itself succeeds in memory");

    const failingWrite = () => { throw new Error("simulated disk full"); };
    const failedCommit = commit(path, f, { writeFileFn: failingWrite });
    assert.equal(failedCommit.ok, false);
    assert.match(failedCommit.reason, /fail-closed/);

    const after = readFileSync(path, "utf8");
    assert.equal(after, before, "on-disk store must remain the last successfully committed state");
    const reloaded = loadStore(path);
    assert.equal(reloaded.store.state, STATE.CLAIMED, "never silently advanced to QUESTION_PAUSED/DONE on disk");
  } finally {
    cleanup(dir);
  }
});

test("G9-6: recoverIncompleteClaim round-trips through commit/loadStore on real fs", () => {
  const dir = freshDir();
  const path = join(dir, "arm-1.json");
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    commit(path, s);

    const loaded = loadStore(path);
    assert.equal(loaded.ok, true);
    assert.equal(needsRestartRecovery(loaded.store), true);

    const recovered = commit(path, recoverIncompleteClaim(loaded.store, { at: "t2", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir }));
    assert.equal(recovered.ok, true);

    const final = loadStore(path);
    assert.equal(final.store.state, STATE.DISARMED);
    assert.equal(final.store.disarm_cause, DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART);
  } finally {
    cleanup(dir);
  }
});

test("G9-7: recover records needs_human_ack and preserves an existing result file's hash (real fs, not just store JSON)", () => {
  const dir = freshDir();
  const resultPath = join(dir, "result.txt");
  try {
    writeFileSync(resultPath, "worker deliverable v1\n", "utf8");
    const before = readFileSync(resultPath, "utf8");
    const beforeHash = hashContent(before);

    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });

    const r = recoverIncompleteClaim(s.store, { at: "t2", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir, resultPath });
    assert.equal(r.ok, true);
    assert.equal(r.store.needs_human_ack, true);

    const after = readFileSync(resultPath, "utf8");
    assert.equal(after, before, "recovery must never write to the result file");

    const recoveryReceipt = r.store.receipts.at(-1);
    assert.equal(recoveryReceipt.needs_human_ack, true);
    assert.equal(recoveryReceipt.result_hash_at_recovery, beforeHash);
  } finally {
    cleanup(dir);
  }
});

// ===========================================================================
// C6 구조 전환 (PM 수렴진단 pm-3): review-5 6계열 frozen regression + arm 트랜잭션
// property. 기대값은 reviewer-owned이며 이후 라운드에서 변경·삭제 금지.
// ===========================================================================

// RED-A (review-5 ①, P0): 서로 다른 task 2개가 max_starts_total=1에서 둘 다 spawn하던
// arm 예산 race. claimTx(arm mutex + 디스크 store reload)로 arm 전역 예산이 원자화됨.
test("C6-RED-A: two DIFFERENT tasks racing one arm (max_starts_total=1) -> exactly one spawn total (arm transaction)", async () => {
  const dir = freshDir();
  try {
    const arm_id = "arm-race";
    seedArmStore(dir, arm_id, { taskIds: ["task-a", "task-b"], maxTotal: 1, maxPerLane: 1 });
    const spawnBuffer = new SharedArrayBuffer(4);
    const barrierBuffer = new SharedArrayBuffer(4);
    const mkT = (id) => ({ task_id: id, lane: "coder", cycle_id: "cycle-1", attempt_id: `att-${id}`, content_hash: `h-${id}`, at: "t" });
    const [a, b] = await Promise.all([
      txWorker(dir, arm_id, mkT("task-a"), TX_NOW_MS, barrierBuffer, 2, spawnBuffer),
      txWorker(dir, arm_id, mkT("task-b"), TX_NOW_MS, barrierBuffer, 2, spawnBuffer),
    ]);
    assert.ok(!a.workerThrew, `worker A threw: ${a.workerThrew}`);
    assert.ok(!b.workerThrew, `worker B threw: ${b.workerThrew}`);
    const spawnTotal = Atomics.load(new Int32Array(spawnBuffer), 0);
    // review-5 ① regression: this raced to 2 spawns before. The arm is single-track, so
    // exactly one of the two different tasks is admitted (budget allows one); the other is
    // refused without disarming. Safety: never 2.
    assert.equal(spawnTotal, 1, `arm cap=1 must yield exactly one spawn, got ${spawnTotal} (${JSON.stringify([a, b])})`);
    const admitted = [a, b].filter((r) => r.spawnAllowed).length;
    assert.equal(admitted, 1, "exactly one worker is admitted");
    const disk = loadStore(mod.armStorePath(dir, arm_id));
    assert.equal(disk.ok, true);
    assert.equal(disk.store.attempts_total, 1, "persisted attempts_total must equal accepted claims");
    assert.equal(disk.store.attempts_per_lane.coder, 1);
  } finally {
    cleanup(dir);
  }
});

// RED-B (review-5, G2): 손상 store의 disarm receipt가 반환 객체에만 있고 디스크에
// 영속되지 않던 문제. commit이 persist_required를 따라 원자 저장 → 파일 재독으로 확인.
test("C6-RED-B: a corruption disarm receipt is actually persisted to disk (commit follows persist_required)", () => {
  const dir = freshDir();
  const path = join(dir, "corrupt-arm.json");
  try {
    // seed a structurally-corrupt store (claims:null) but with a valid receipts array on disk.
    const good = armedStore();
    writeFileSync(path, JSON.stringify({ ...good, claims: null }), "utf8");
    const loaded = loadStore(path);
    assert.equal(loaded.ok, false, "loadStore must flag the corrupt store");

    // decoding via claim() yields a persist_required disarm result...
    const result = claim({ ...good, claims: null }, makeTask(), { dir });
    assert.equal(result.ok, false);
    assert.equal(result.persist_required, true);
    assert.equal(result.store.state, STATE.DISARMED);

    // ...and commit must write it to disk (not skip because ok:false).
    const committed = commit(path, result);
    assert.equal(committed.ok, false); // request still refused
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.state, STATE.DISARMED, "disk must show DISARMED after commit");
    assert.equal(onDisk.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
    assert.equal(onDisk.receipts.at(-1).event, "disarmed");
  } finally {
    cleanup(dir);
  }
});

// RED-C (review-5 ②, G2/G3): 오류 객체의 message getter가 throw해 fail-closed catch를
// 탈출하던 문제. errText가 message 접근까지 try/catch → DISARMED 완주.
test("C6-RED-C: spawnFn throws an object whose message getter itself throws -> start disarms, no uncaught throw", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    const c = claim(store, makeTask(), { dir, nowFn: NOW_OK });
    const evilThrow = () => {
      throw {
        get message() {
          throw new Error("message-getter-explodes");
        },
      };
    };
    let s;
    assert.doesNotThrow(() => {
      s = start(c.store, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir, spawnFn: evilThrow });
    }, "throwing message getter must not escape start()");
    assert.equal(s.ok, false);
    assert.equal(s.spawned, false);
    assert.equal(s.store.state, STATE.DISARMED);
  } finally {
    cleanup(dir);
  }
});

// RED-D (review-5 ③, G2/G3/G9): null/invalid callback과 invalid clock 반환.
test("C6-RED-D: invalid dependency callbacks and a bad clock are fail-closed (no TypeError, no expiry fail-open)", () => {
  const dir = freshDir();
  try {
    const store = armedStore({ max_starts_total: 5, max_starts_per_lane: 5 });
    // null callbacks -> fail-closed refuse, no throw.
    assert.doesNotThrow(() => {
      const r = claim(store, makeTask(), { dir, nowFn: null });
      assert.equal(r.ok, false);
      assert.match(r.reason, /nowFn|not a function/);
    });
    assert.doesNotThrow(() => {
      const r = claim(store, makeTask(), { dir, existsFn: null });
      assert.equal(r.ok, false);
    });
    assert.doesNotThrow(() => {
      const r = checkExpiry(store, null, "t1");
      assert.equal(r.ok, false);
    });
    // clock returning a non-safe-integer must NOT fail-open an expired-grant claim.
    const expiredStore = armedStore({ expires_at: "2026-07-14T04:00:00.000Z" });
    const r = claim(expiredStore, makeTask(), { dir, nowFn: () => undefined });
    assert.equal(r.ok, false, "invalid clock must not accept a claim");
    assert.equal(r.store.state, STATE.DISARMED);
  } finally {
    cleanup(dir);
  }
});

// RED-E (review-5 ④, P0 G1/G3): 상속 컨테이너·변조 배열 메서드·Symbol state.
test("C6-RED-E: inherited container / tampered array method / Symbol state cannot bypass canonical decode", () => {
  const dir = freshDir();
  try {
    // (a) attempts_per_lane inherits {coder:-1} via prototype; own keys are empty ->
    // decode copies only own keys -> the inherited -1 never reaches budget math.
    const good = armedStore({ max_starts_per_lane: 0 });
    const inheritedLane = { ...good, attempts_per_lane: Object.create({ coder: -1 }) };
    const rInh = claim(inheritedLane, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(rInh.ok, false, "inherited lane counter must not authorize a claim");
    // max_starts_per_lane:0 -> canonical own-lane usage is 0 -> 0>=0 budget exhausted -> disarm.
    assert.equal(rInh.store.state, STATE.DISARMED);
    assert.equal(rInh.store.disarm_cause, DISARM_CAUSE.BUDGET_EXHAUSTED);

    // (b) grant.allowed_lanes is a real array but with a tampered own .includes=()=>true.
    // decode builds a Set from index-copied elements and never calls the array's .includes,
    // so an unauthorized lane is still rejected.
    const evilArr = ["coder"];
    evilArr.includes = () => true;
    const tamperedGrant = { ...good, grant: { ...good.grant, allowed_lanes: evilArr, max_starts_per_lane: 5 } };
    const rTamper = claim(tamperedGrant, makeTask({ lane: "evil-lane" }), { dir, nowFn: NOW_OK });
    assert.equal(rTamper.ok, false, "tampered .includes must not authorize an unlisted lane");
    assert.equal(rTamper.store.disarm_cause, DISARM_CAUSE.ID_MISMATCH);

    // (c) state is a Symbol -> decode rejects without a stringification TypeError.
    const symState = { ...good, state: Symbol("bad") };
    let rSym;
    assert.doesNotThrow(() => { rSym = claim(symState, makeTask(), { dir, nowFn: NOW_OK }); }, "Symbol state must not TypeError");
    assert.equal(rSym.ok, false);
    assert.match(rSym.reason, /STATE_CORRUPT/);
  } finally {
    cleanup(dir);
  }
});

// RED-F (review-5 ⑤, P0 G3): unsafe integer budget.
test("C6-RED-F: unsafe-integer caps/counters are rejected (Number.isSafeInteger), no silent cap bypass", () => {
  const dir = freshDir();
  try {
    // (a) cap = MAX_SAFE_INTEGER+1 in a JSON store -> loadStore/decode rejects.
    const good = armedStore();
    const unsafeCap = { ...good, grant: { ...good.grant, max_starts_total: Number.MAX_SAFE_INTEGER + 1 } };
    const p = join(dir, "unsafe.json");
    writeFileSync(p, JSON.stringify(unsafeCap), "utf8");
    assert.equal(loadStore(p).ok, false, "unsafe cap must be rejected on load");

    // (b) counter already at MAX_SAFE_INTEGER -> increment would be unsafe -> fail-closed,
    // never a silent no-op increment that lets the arm run unbounded.
    const atMax = { ...good, attempts_total: Number.MAX_SAFE_INTEGER, grant: { ...good.grant, max_starts_total: Number.MAX_SAFE_INTEGER } };
    const r = claim(atMax, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(r.ok, false);
    // total >= max_starts_total (MAX===MAX) fires budget-exhausted before the increment guard;
    // either way it is fail-closed (disarmed), never accepted.
    assert.equal(r.store.state, STATE.DISARMED);
  } finally {
    cleanup(dir);
  }
});

// C6-PROP: arm 트랜잭션 불변식 property. 고정 seed로 (N task, K total cap, L lane cap)를
// 조합해 실제 Worker + 공유 디스크 store로 5-oracle 검사:
//   uncaught throw 0 · unauthorized spawn 0 · cap 초과 0 · 필수 counter/receipt 디스크 반영 · counter 일치.
// 모든 task는 같은 lane("coder")이므로 유효 cap = min(N, K, L).
test("C6-PROP: arm-transaction invariants across N/K/L combos (real Workers, shared disk store, 5 oracles)", async () => {
  const seed = 135135;
  const rng = mulberry32(seed);
  const startedAt = Date.now();
  // The arm state machine is single-track (ARMED->CLAIMED->...), so an arm admits AT MOST
  // ONE task regardless of how large max_starts_total/per_lane are (multi-attempt = new arm
  // per §4, cycle 2). The safety invariant under N racing DIFFERENT tasks is therefore:
  // spawn_total <= 1, and = 1 iff budget allows the one (K>=1 && L>=1). Curated combos vary
  // N (fan-out breadth) and force budget-zero cases; seed-derived combos add breadth. The
  // review-5 ① violation was spawn_total=2 -- these prove it can never exceed 1.
  const curated = [
    { N: 2, K: 1, L: 1 }, // classic review-5 ① race
    { N: 4, K: 2, L: 5 }, // larger total budget still single-track -> 1
    { N: 4, K: 5, L: 2 }, // larger lane budget still single-track -> 1
    { N: 8, K: 3, L: 3 }, // 8-way fan-out, still exactly 1 admitted
    { N: 5, K: 0, L: 5 }, // total budget 0 -> 0 admitted
    { N: 6, K: 6, L: 0 }, // lane budget 0 -> 0 admitted
  ];
  const combos = [...curated];
  for (let i = 0; i < 3; i++) {
    const N = 2 + Math.floor(rng() * 7); // 2..8
    const K = Math.floor(rng() * (N + 1)); // 0..N
    const L = Math.floor(rng() * (N + 1)); // 0..N
    combos.push({ N, K, L });
  }
  let casesRun = 0;
  for (const { N, K, L } of combos) {
    const dir = freshDir();
    try {
      const arm_id = `arm-prop-${N}-${K}-${L}-${casesRun}`;
      const taskIds = Array.from({ length: N }, (_, i) => `task-${i}`);
      seedArmStore(dir, arm_id, { taskIds, maxTotal: K, maxPerLane: L });
      const spawnBuffer = new SharedArrayBuffer(4);
      const barrierBuffer = new SharedArrayBuffer(4);
      const workers = taskIds.map((id) =>
        txWorker(dir, arm_id, { task_id: id, lane: "coder", cycle_id: "cycle-1", attempt_id: `att-${id}`, content_hash: `h-${id}`, at: "t" }, TX_NOW_MS, barrierBuffer, N, spawnBuffer),
      );
      const results = await Promise.all(workers);
      // oracle 1: uncaught throw 0.
      for (const r of results) assert.ok(!r.workerThrew, `N=${N} K=${K} L=${L}: worker threw ${r.workerThrew}`);
      const expectedSpawn = K >= 1 && L >= 1 ? 1 : 0; // single-track + budget gate
      const spawnTotal = Atomics.load(new Int32Array(spawnBuffer), 0);
      const admitted = results.filter((r) => r.spawnAllowed).length;
      // oracle 2+3: over-cap / unauthorized spawn 0 -- never more than the single-track budget.
      assert.ok(spawnTotal <= 1, `N=${N} K=${K} L=${L}: spawn ${spawnTotal} exceeded single-track bound 1`);
      assert.equal(spawnTotal, expectedSpawn, `N=${N} K=${K} L=${L}: spawn ${spawnTotal} != expected ${expectedSpawn}`);
      assert.ok(admitted <= 1, `N=${N} K=${K} L=${L}: ${admitted} admitted (>1)`);
      // oracle 4+5: persisted counters equal accepted claims (and thus <= caps), reflected on disk.
      const disk = loadStore(mod.armStorePath(dir, arm_id));
      assert.equal(disk.ok, true, `N=${N} K=${K} L=${L}: disk store must reload`);
      assert.equal(disk.store.attempts_total, expectedSpawn, `N=${N} K=${K} L=${L}: persisted attempts_total`);
      assert.equal(disk.store.attempts_per_lane.coder ?? 0, expectedSpawn, `N=${N} K=${K} L=${L}: persisted lane counter`);
      assert.ok(disk.store.attempts_total <= K, `N=${N} K=${K} L=${L}: attempts_total ${disk.store.attempts_total} > cap ${K}`);
      casesRun++;
    } finally {
      cleanup(dir);
    }
  }
  // record seed / case count / wall time for reproducibility (PM §2.3 / 관찰 항목).
  const ms = Date.now() - startedAt;
  console.log(`[C6-PROP] seed=${seed} cases=${casesRun} combos=${JSON.stringify(combos)} wall_ms=${ms}`);
  assert.equal(casesRun, combos.length);
});

// coder-2 (계약 검증, 패킷 §4 그룹2): C6-RED-A/C6-PROP를 claim-only oracle로 재실행.
// TX_WORKER_SRC/txWorker는 claimTx 성공 시 startTx까지 이어서 부른다(spawn 포함) --
// 아래는 claimTx만 호출해 admission/예산 불변식을 start/spawn 의미론과 분리해 증명한다.
// 오라클: admitted<=cap · persisted attempts=admitted · uncaught throw 0.
// (C6-RED-E/F는 이미 claim()을 직접 호출하는 순수 함수 테스트라 claim-only이다 -- 변경 불필요.)
test("C6-RED-A-CLAIM-ONLY: two DIFFERENT tasks racing one arm (max_starts_total=1), claimTx only -- exactly one admitted", async () => {
  const dir = freshDir();
  try {
    const arm_id = "arm-race-claim-only";
    seedArmStore(dir, arm_id, { taskIds: ["task-a", "task-b"], maxTotal: 1, maxPerLane: 1 });
    const barrierBuffer = new SharedArrayBuffer(4);
    const mkT = (id) => ({ task_id: id, lane: "coder", cycle_id: "cycle-1", attempt_id: `att-${id}`, content_hash: `h-${id}`, at: "t" });
    const [a, b] = await Promise.all([
      claimOnlyTxWorker(dir, arm_id, mkT("task-a"), TX_NOW_MS, barrierBuffer, 2),
      claimOnlyTxWorker(dir, arm_id, mkT("task-b"), TX_NOW_MS, barrierBuffer, 2),
    ]);
    assert.ok(!a.workerThrew, `worker A threw: ${a.workerThrew}`);
    assert.ok(!b.workerThrew, `worker B threw: ${b.workerThrew}`);
    const admitted = [a, b].filter((r) => r.spawnAllowed).length;
    assert.equal(admitted, 1, `arm cap=1 must admit exactly one claim, got ${admitted} (${JSON.stringify([a, b])})`);
    const disk = loadStore(mod.armStorePath(dir, arm_id));
    assert.equal(disk.ok, true);
    assert.equal(disk.store.attempts_total, admitted, "persisted attempts_total must equal admitted claims");
  } finally {
    cleanup(dir);
  }
});

test("C6-PROP-CLAIM: claim-only oracle across N/K/L combos (claimTx only, no startTx)", async () => {
  const seed = 138138;
  const rng = mulberry32(seed);
  const startedAt = Date.now();
  const curated = [
    { N: 2, K: 1, L: 1 },
    { N: 4, K: 2, L: 5 },
    { N: 4, K: 5, L: 2 },
    { N: 8, K: 3, L: 3 },
    { N: 5, K: 0, L: 5 },
    { N: 6, K: 6, L: 0 },
  ];
  const combos = [...curated];
  for (let i = 0; i < 3; i++) {
    const N = 2 + Math.floor(rng() * 7);
    const K = Math.floor(rng() * (N + 1));
    const L = Math.floor(rng() * (N + 1));
    combos.push({ N, K, L });
  }
  let casesRun = 0;
  for (const { N, K, L } of combos) {
    const dir = freshDir();
    try {
      const arm_id = `arm-prop-claim-${N}-${K}-${L}-${casesRun}`;
      const taskIds = Array.from({ length: N }, (_, i) => `task-${i}`);
      seedArmStore(dir, arm_id, { taskIds, maxTotal: K, maxPerLane: L });
      const barrierBuffer = new SharedArrayBuffer(4);
      const workers = taskIds.map((id) =>
        claimOnlyTxWorker(dir, arm_id, { task_id: id, lane: "coder", cycle_id: "cycle-1", attempt_id: `att-${id}`, content_hash: `h-${id}`, at: "t" }, TX_NOW_MS, barrierBuffer, N),
      );
      const results = await Promise.all(workers);
      // oracle: uncaught throw 0.
      for (const r of results) assert.ok(!r.workerThrew, `N=${N} K=${K} L=${L}: worker threw ${r.workerThrew}`);
      const expectedAdmitted = K >= 1 && L >= 1 ? 1 : 0; // single-track + budget gate
      const admitted = results.filter((r) => r.spawnAllowed).length;
      // oracle: admitted <= cap (single-track bound of 1, and never exceeds budget gate).
      assert.ok(admitted <= 1, `N=${N} K=${K} L=${L}: ${admitted} admitted (>1)`);
      assert.equal(admitted, expectedAdmitted, `N=${N} K=${K} L=${L}: admitted ${admitted} != expected ${expectedAdmitted}`);
      // oracle: persisted attempts == admitted (and thus <= cap).
      const disk = loadStore(mod.armStorePath(dir, arm_id));
      assert.equal(disk.ok, true, `N=${N} K=${K} L=${L}: disk store must reload`);
      assert.equal(disk.store.attempts_total, admitted, `N=${N} K=${K} L=${L}: persisted attempts_total`);
      assert.equal(disk.store.attempts_per_lane.coder ?? 0, admitted, `N=${N} K=${K} L=${L}: persisted lane counter`);
      assert.ok(disk.store.attempts_total <= K, `N=${N} K=${K} L=${L}: attempts_total ${disk.store.attempts_total} > cap ${K}`);
      casesRun++;
    } finally {
      cleanup(dir);
    }
  }
  const ms = Date.now() - startedAt;
  console.log(`[C6-PROP-CLAIM] seed=${seed} cases=${casesRun} combos=${JSON.stringify(combos)} wall_ms=${ms}`);
  assert.equal(casesRun, combos.length);
});

// ===========================================================================
// HYK-137 그룹1 사이클 1A frozen regression (review-6 ②④⑤ = R6-2/R6-4/R6-5).
// 기대값은 재편 패킷 §6 원문 -- 이후 라운드에서 변경·삭제 금지(RG2/RG3).
// ===========================================================================

// R6-2 (packet §6.1): corrupt-load disarm은 반환 객체뿐 아니라 실제 디스크에 영속되고,
// 저장 실패 시 성공/영속 완료로 위장하지 않고 fail-closed로 명시한다.
test("R6-2: corrupt-load disarm is persisted to disk; a save failure is reported fail-closed (disk stays corrupt)", () => {
  const dir = freshDir();
  try {
    const good = armedStore();
    // (a) save-success: commit writes DISARMED + state_corrupt receipt to disk.
    const pathOk = join(dir, "arm-corrupt-ok.json");
    writeFileSync(pathOk, JSON.stringify({ ...good, claims: null }), "utf8");
    const result = claim({ ...good, claims: null }, makeTask(), { dir });
    assert.equal(result.ok, false);
    assert.equal(result.persist_required, true);
    const committed = commit(pathOk, result);
    assert.equal(committed.ok, false, "the request itself is still refused");
    const onDisk = JSON.parse(readFileSync(pathOk, "utf8"));
    assert.equal(onDisk.state, STATE.DISARMED);
    assert.equal(onDisk.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
    assert.equal(onDisk.receipts.at(-1).event, "disarmed");

    // (b) save-failure via claimTx: a corrupt on-disk store + a failing store writer must
    // NOT report success/persisted; it returns fail-closed and the disk stays corrupt.
    const arm_id = "arm-corrupt-fail";
    const storePath = mod.armStorePath(dir, arm_id);
    const corruptOnDisk = JSON.stringify({ ...good, grant: { ...good.grant, arm_id }, claims: null });
    writeFileSync(storePath, corruptOnDisk, "utf8");
    const failStoreWrite = (p, c) => {
      // only the store's atomic save must fail; let the mutex/marker exclusive write work.
      if (String(p).endsWith(".store.json.tmp") || String(p).includes(".store.json.tmp-")) throw new Error("simulated disk full");
      throw new Error("simulated disk full");
    };
    const tx = mod.claimTx(dir, arm_id, { task_id: "t-a", lane: "coder", cycle_id: "cycle-1", attempt_id: "att", content_hash: "h", at: "t" }, { nowFn: NOW_OK, writeFileFn: failStoreWrite });
    assert.equal(tx.ok, false);
    assert.match(tx.reason, /fail-closed|remains corrupt/);
    const stillOnDisk = readFileSync(storePath, "utf8");
    assert.equal(stillOnDisk, corruptOnDisk, "disk must remain the corrupt ARMED store when persist failed (no fake success)");
  } finally {
    cleanup(dir);
  }
});

// R6-2b (HYK-137-review-1 국소): 저장 성공한 corrupt-load disarm은 반드시 loadStore로
// 재독 가능해야 한다 -- 손상 필드를 원형 복사하지 않고 canonical로 정규화하므로, 영속된
// DISARMED가 다음 트랜잭션의 재사용 가능한 상태가 된다(매번 corrupt-load 재진입 금지).
test("R6-2b: a persisted corrupt-load disarm is reloadable by loadStore (canonical, not raw-corrupt copy)", () => {
  const dir = freshDir();
  const path = join(dir, "arm-corrupt-reload.json");
  try {
    const good = armedStore();
    writeFileSync(path, JSON.stringify({ ...good, claims: null }), "utf8");

    // decode the corrupt store via claim() -> persist_required disarm, then commit it.
    const result = claim({ ...good, claims: null }, makeTask(), { dir });
    assert.equal(result.persist_required, true);
    const committed = commit(path, result);
    assert.equal(committed.ok, false);

    // the KEY fix: the persisted file reloads cleanly as a reusable DISARMED store.
    const reloaded = loadStore(path);
    assert.equal(reloaded.ok, true, "persisted corrupt-load disarm must reload (not re-enter corrupt-load)");
    assert.equal(reloaded.existed, true);
    assert.equal(reloaded.store.state, STATE.DISARMED);
    assert.equal(reloaded.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
    // the corruption truth is preserved in the receipt trail.
    assert.equal(reloaded.store.receipts.at(-1).event, "disarmed");
    assert.equal(reloaded.store.receipts.at(-1).cause, DISARM_CAUSE.STATE_CORRUPT);
    // normalized: claims is now a (empty) plain object, not the original null.
    assert.deepEqual(reloaded.store.claims, {});
  } finally {
    cleanup(dir);
  }
});

// R6-4 (packet §6.3): existsFn throw와 err.code getter throw가 seam 밖으로 나오지 않고
// 권한·spawn 0으로 끝난다.
test("R6-4: a throwing existsFn and a throwing err.code getter stay inside the I/O seam (no uncaught, 0 authority)", () => {
  const dir = freshDir();
  try {
    // existsFn throws -> loadStore returns STATE_CORRUPT, does not escape.
    let loaded;
    assert.doesNotThrow(() => {
      loaded = loadStore(join(dir, "x.json"), { existsFn: () => { throw new Error("exists boom"); } });
    }, "existsFn throw must not escape loadStore");
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /STATE_CORRUPT/);

    // a write error object whose `code` getter itself throws must not cause an uncaught
    // throw in the marker I/O -> claim refuses without spawning.
    const store = armedStore();
    const evilWrite = () => {
      throw {
        get code() {
          throw new Error("code-getter-explodes");
        },
        message: "evil",
      };
    };
    const spawnFn = counter();
    let r;
    assert.doesNotThrow(() => {
      r = claim(store, makeTask(), { dir, nowFn: NOW_OK, writeFn: evilWrite });
    }, "throwing err.code getter must not escape the marker I/O seam");
    assert.equal(r.ok, false);
    assert.equal(spawnFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

// R6-5 (packet §6.4): decoder가 root prototype 상속 객체와 상태-내용 모순(ARMED+claims)을
// 거부한다.
test("R6-5: decodeStore rejects a prototype-inherited root object and a state/claims-inconsistent store", () => {
  const dir = freshDir();
  try {
    const good = armedStore();
    // (a) Object.create(validStore): every field is inherited, none own -> rejected.
    const inheritedRoot = Object.create(good);
    assert.equal(mod.decodeStore(inheritedRoot).ok, false, "inherited-root object must be rejected");
    // reached through a public entry too (no uncaught throw, refuse).
    let cr;
    assert.doesNotThrow(() => { cr = claim(inheritedRoot, makeTask(), { dir, nowFn: NOW_OK }); });
    assert.equal(cr.ok, false);

    // (b) ARMED but carrying a claim record -> semantic inconsistency -> rejected.
    const armedWithClaim = { ...good, state: STATE.ARMED, claims: { "HYK-135-coder-1": { attempt_id: "a", cycle_id: "cycle-1", content_hash: "h", claimed_at: "t" } } };
    const decArmed = mod.decodeStore(armedWithClaim);
    assert.equal(decArmed.ok, false, "ARMED+claims must be rejected");
    assert.match(decArmed.reason, /ARMED/);

    // (c) CLAIMED with no claim record -> also inconsistent -> rejected.
    const claimedNoRecord = { ...good, state: STATE.CLAIMED, claims: {} };
    assert.equal(mod.decodeStore(claimedNoRecord).ok, false, "CLAIMED without a claim record must be rejected");

    // sanity: a well-formed ARMED (empty claims) and a well-formed CLAIMED still decode.
    assert.equal(mod.decodeStore(good).ok, true);
    const c = claim(good, makeTask(), { dir, nowFn: NOW_OK });
    assert.equal(c.ok, true);
    assert.equal(mod.decodeStore(c.store).ok, true, "a real CLAIMED store (with its record) decodes");
  } finally {
    cleanup(dir);
  }
});

// ===========================================================================
// HYK-137 그룹1 사이클 1B frozen regression (review-6 ③⑥ = R6-3/R6-6).
// 기대값은 재편 패킷 §6 원문 -- 이후 라운드에서 변경·삭제 금지(RG2/RG3).
// ===========================================================================

// R6-3 (packet §6.2): transaction의 arm_id(=store 경로·mutex 경로 결정)와 decoded
// grant.arm_id 중 하나라도 불일치하면 claim/start 권한 0. 같은 grant를 다른 경로에
// 복제해도 그 경로의 grant.arm_id가 경로 arm_id와 달라 승인되지 않는다.
test("R6-3: path<->arm_id<->grant.arm_id binding -- a mislocated store (grant.arm_id != path arm_id) gets 0 authority", () => {
  const dir = freshDir();
  try {
    // build a store whose grant.arm_id is "arm-A" but write it at the path for "arm-B".
    const grantA = {
      arm_id: "arm-A",
      cycle_id: "cycle-1",
      human_approval_ref: "sign-1",
      issued_at: "2026-07-14T05:00:00.000Z",
      expires_at: "2026-07-14T12:00:00.000Z",
      allowed_lanes: ["coder"],
      allowed_task_ids: ["task-x"],
      max_starts_total: 1,
      max_starts_per_lane: 1,
      max_rejections: 0,
      question_policy: "pause",
      error_policy: "pause",
      publish_allowed: false,
    };
    const created = createArmStore(grantA, { at: "seed" });
    assert.equal(created.ok, true);
    // mislocate: write the arm-A store into arm-B's canonical path.
    writeFileSync(mod.armStorePath(dir, "arm-B"), JSON.stringify(created.store), "utf8");
    const task = { task_id: "task-x", lane: "coder", cycle_id: "cycle-1", attempt_id: "att", content_hash: "h", at: "t" };

    // claimTx on "arm-B" loads the store, but grant.arm_id "arm-A" != path arm_id "arm-B" -> refuse.
    const c = mod.claimTx(dir, "arm-B", task, { nowFn: NOW_OK });
    assert.equal(c.ok, false);
    assert.equal(c.spawnAllowed, false);
    assert.match(c.reason, /path binding mismatch/);

    // startTx mirrors the binding check.
    const s = mod.startTx(dir, "arm-B", { task_id: "task-x", attempt_id: "att", at: "t" }, { nowFn: NOW_OK });
    assert.equal(s.ok, false);
    assert.equal(s.spawned, false);
    assert.match(s.reason, /path binding mismatch/);

    // sanity: the correctly-located store (grant.arm_id == path arm_id) is honored.
    writeFileSync(mod.armStorePath(dir, "arm-A"), JSON.stringify(created.store), "utf8");
    const ok = mod.claimTx(dir, "arm-A", task, { nowFn: NOW_OK });
    assert.equal(ok.ok, true);
    assert.equal(ok.spawnAllowed, true);
  } finally {
    cleanup(dir);
  }
});

// R6-6 (packet §6.5): mutex release는 "read 후 unlink"의 비원자 창을 없애 타 nonce lock을
// 삭제하지 않는다(자동 stale 삭제 0). tombstone 원자 rename 후 nonce 검사 방식.
test("R6-6: mutex release never deletes another nonce's lock (atomic tombstone), and stale locks are not auto-removed", () => {
  const dir = freshDir();
  const mdeps = { writeFn: (p, c) => writeFileSync(p, c, { flag: "wx" }), readFn: (p) => readFileSync(p, "utf8") };
  try {
    // (a) normal release: our own lock is removed.
    const m1 = mod.acquireArmMutex(dir, "arm-1", mdeps);
    assert.equal(m1.ok, true);
    assert.equal(existsSync(m1.path), true);
    mod.releaseArmMutex(m1, mdeps);
    assert.equal(existsSync(m1.path), false, "our own lock is released");

    // (b) THE RACE: another holder replaces our lock in the read->unlink window. We model
    // it by a readFn that, as a one-time side effect, swaps the canonical lock to a foreign
    // nonce at the exact moment release reads. The old "read (matches ours) then unlink
    // canonical" deleted the foreign lock; the tombstone rename-first design cannot, because
    // it only ever unlinks its own-nonce tombstone (a path unique to this release).
    const m2 = mod.acquireArmMutex(dir, "arm-2", mdeps);
    assert.equal(m2.ok, true);
    let swapped = false;
    const racingRead = (p) => {
      const content = readFileSync(p, "utf8");
      if (!swapped) {
        swapped = true;
        writeFileSync(m2.path, "OTHER-NONCE-xyz", "utf8"); // a concurrent holder takes the canonical path
      }
      return content;
    };
    mod.releaseArmMutex(m2, { readFn: racingRead });
    assert.equal(existsSync(m2.path), true, "a foreign lock taken during the read window must survive release");
    assert.equal(readFileSync(m2.path, "utf8"), "OTHER-NONCE-xyz", "the other nonce lock is intact (0 deletion)");

    // (c) stale lock (never released) is not auto-removed by acquire timeout (I7).
    const m3 = mod.acquireArmMutex(dir, "arm-3", mdeps);
    assert.equal(m3.ok, true);
    const blocked = mod.acquireArmMutex(dir, "arm-3", mdeps, 40); // short wait -> times out
    assert.equal(blocked.ok, false);
    assert.equal(blocked.paused, true);
    assert.equal(existsSync(m3.path), true, "stale lock is left in place (no auto-delete, I7)");
    mod.releaseArmMutex(m3, mdeps); // cleanup our own
  } finally {
    cleanup(dir);
  }
});

// R6-6-fc (HYK-137-review-4 국소): release가 deps seam(rename/read)을 실제 사용하고, 그
// 실패를 삼키지 않고 fail-closed 반환으로 드러낸다. claimTx는 release 실패를 성공 결과에
// 숨기지 않는다(mutex_release_failed 표식). 타 nonce 삭제 0 유지.
test("R6-6-fc: release failure is surfaced fail-closed via the deps seam, and claimTx does not hide it", () => {
  const dir = freshDir();
  const mdeps = { writeFn: (p, c) => writeFileSync(p, c, { flag: "wx" }), readFn: (p) => readFileSync(p, "utf8") };
  try {
    // (a) deps.renameFn throws EXDEV -> release reports fail-closed; our lock survives intact.
    const m1 = mod.acquireArmMutex(dir, "arm-fc-1", mdeps);
    assert.equal(m1.ok, true);
    const rel1 = mod.releaseArmMutex(m1, { renameFn: () => { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; }, readFn: mdeps.readFn });
    assert.equal(rel1.released, false, "a failed release must not report released");
    assert.match(rel1.reason, /rename failed/);
    assert.equal(rel1.lock_state, "survived");
    assert.equal(existsSync(m1.path), true, "lock survives the failed rename (0 deletion)");
    assert.equal(readFileSync(m1.path, "utf8"), m1.nonce, "our own lock intact");
    mod.releaseArmMutex(m1, mdeps); // real cleanup

    // (b) deps.readFn throws after the atomic take -> fail-closed, ownership unknown, restore attempted.
    const m2 = mod.acquireArmMutex(dir, "arm-fc-2", mdeps);
    const rel2 = mod.releaseArmMutex(m2, { readFn: () => { throw new Error("read boom"); } });
    assert.equal(rel2.released, false);
    assert.match(rel2.reason, /read failed/);
    assert.equal(existsSync(m2.path), true, "lock restored to canonical path (0 deletion)");
    mod.releaseArmMutex(m2, mdeps);

    // (c) claimTx must NOT hide a release failure: only the mutex tombstone rename fails
    // (the store save rename still succeeds) -> claim result carries mutex_release_failed.
    const arm_id = "arm-fc-3";
    seedArmStore(dir, arm_id, { taskIds: ["task-0"], maxTotal: 1, maxPerLane: 1 });
    const selectiveRename = (from, to) => {
      if (String(from).includes(".mutex.lock") || String(to).includes(".releasing")) {
        const e = new Error("EXDEV on mutex tombstone");
        e.code = "EXDEV";
        throw e;
      }
      return renameSync(from, to);
    };
    const task = { task_id: "task-0", lane: "coder", cycle_id: "cycle-1", attempt_id: "att", content_hash: "h", at: "t" };
    const r = mod.claimTx(dir, arm_id, task, { nowFn: NOW_OK, renameFn: selectiveRename });
    assert.equal(r.ok, true, "the claim itself (store save) succeeds");
    assert.equal(r.mutex_release_failed, true, "release failure is surfaced, not hidden");
    assert.equal(existsSync(join(dir, `arm-${arm_id}.mutex.lock`)), true, "the un-released lock lingers (next acquire will PAUSE)");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 입력 경계(①) 전수: 모든 export된 함수가 malformed 입력에 대해 throw 없이 fail-closed
// 거부하는지. FUNCTION_CONTRACTS는 export를 순회해 대조하므로, 새 함수를 export하면서
// 계약을 안 쓰면 이 테스트가 실패한다(누락 불가 구조 -- review-3 계약 요구사항).
// ---------------------------------------------------------------------------

test("input-boundary: every exported function is covered by a malformed-input contract and none throws", () => {
  const dir = freshDir();
  try {
    const validStore = armedStore();
    const FUNCTION_CONTRACTS = {
      canTransition: () => {
        assert.equal(mod.canTransition(undefined, undefined), false);
        assert.equal(mod.canTransition(null, "X"), false);
      },
      validateGrant: () => {
        assert.ok(Array.isArray(mod.validateGrant(undefined)));
        assert.ok(mod.validateGrant(null).length > 0);
      },
      createArmStore: () => {
        assert.equal(mod.createArmStore(undefined).ok, false);
        assert.equal(mod.createArmStore(null).ok, false);
      },
      isExpired: () => {
        // fail-closed: absent/unparseable expiry -> treated as expired.
        assert.equal(mod.isExpired(undefined, 0), true);
        assert.equal(mod.isExpired({ expires_at: "not-a-date" }, 0), true);
      },
      needsRestartRecovery: () => {
        assert.equal(mod.needsRestartRecovery(undefined), false);
        assert.equal(mod.needsRestartRecovery(null), false);
      },
      hashContent: () => {
        assert.throws(() => mod.hashContent(undefined));
        assert.throws(() => mod.hashContent(null));
      },
      acquireClaimMarker: () => {
        const r = mod.acquireClaimMarker(dir, { arm_id: undefined, task_id: undefined, cycle_id: undefined, attempt_id: undefined, content_hash: undefined, at: undefined });
        assert.equal(r.ok, false);
        assert.equal(r.invalid_input, true);
      },
      verifyClaimBinding: () => {
        assert.equal(mod.verifyClaimBinding(undefined, {}).ok, false);
        assert.equal(mod.verifyClaimBinding(validStore, { dir, task_id: undefined, attempt_id: undefined }).ok, false);
      },
      claim: () => {
        assert.equal(mod.claim(undefined, makeTask()).ok, false);
        const r = mod.claim(validStore, {}, { dir });
        assert.equal(r.ok, false);
        assert.equal(r.store.state, STATE.ARMED, "malformed task -> pure refuse, store unchanged");
      },
      start: () => {
        assert.equal(mod.start(undefined, {}).ok, false);
        assert.equal(mod.start(validStore, {}).ok, false);
      },
      finishAttempt: () => {
        assert.equal(mod.finishAttempt(undefined, {}).ok, false);
        assert.equal(mod.finishAttempt(validStore, {}).ok, false);
      },
      cancel: () => {
        assert.equal(mod.cancel(undefined, {}).ok, false);
        assert.equal(mod.cancel(null).ok, false);
      },
      checkExpiry: () => {
        assert.equal(mod.checkExpiry(undefined).ok, false);
        assert.equal(mod.checkExpiry(null).ok, false);
      },
      recoverIncompleteClaim: () => {
        assert.equal(mod.recoverIncompleteClaim(undefined, {}).ok, false);
        assert.equal(mod.recoverIncompleteClaim(null).ok, false);
      },
      saveStoreAtomic: () => {
        const r = mod.saveStoreAtomic(join(dir, "sv.json"), { a: 1 });
        assert.equal(typeof r.ok, "boolean");
      },
      loadStore: () => {
        const r = mod.loadStore(join(dir, "does-not-exist.json"));
        assert.equal(r.ok, true);
        assert.equal(r.existed, false);
      },
      commit: () => {
        assert.equal(mod.commit(join(dir, "c.json"), { ok: false, reason: "r" }).ok, false);
        assert.doesNotThrow(() => mod.commit(join(dir, "c.json"), undefined));
      },
      decodeStore: () => {
        assert.equal(mod.decodeStore(undefined).ok, false);
        assert.equal(mod.decodeStore(null).ok, false);
        assert.equal(mod.decodeStore({}).ok, false);
      },
      claimTx: () => {
        assert.equal(mod.claimTx(dir, undefined, makeTask()).ok, false);
        assert.equal(mod.claimTx(dir, "arm-1", {}).ok, false);
        assert.equal(mod.claimTx(dir, "arm-nostore", makeTask(), { nowFn: NOW_OK }).ok, false);
      },
      startTx: () => {
        assert.equal(mod.startTx(dir, undefined, {}).ok, false);
        assert.equal(mod.startTx(dir, "arm-nostore", { task_id: "x", attempt_id: "y" }).ok, false);
      },
      armStorePath: () => {
        assert.equal(mod.armStorePath(null, null), null);
        assert.equal(typeof mod.armStorePath(dir, "arm-1"), "string");
      },
      acquireArmMutex: () => {
        assert.equal(mod.acquireArmMutex(null, null, {}).ok, false);
        assert.equal(mod.acquireArmMutex(dir, "arm-x", null).ok, false);
      },
      releaseArmMutex: () => {
        assert.doesNotThrow(() => mod.releaseArmMutex(undefined, {}));
        assert.doesNotThrow(() => mod.releaseArmMutex(null, null));
        assert.doesNotThrow(() => mod.releaseArmMutex({ ok: true, path: join(dir, "no-such.lock"), nonce: "x" }, { readFn: () => "" }));
      },
    };

    const exportedFns = Object.entries(mod).filter(([, v]) => typeof v === "function").map(([k]) => k);
    for (const name of exportedFns) {
      assert.ok(name in FUNCTION_CONTRACTS, `exported function '${name}' has no input-boundary contract -- add one to FUNCTION_CONTRACTS`);
    }
    for (const name of Object.keys(FUNCTION_CONTRACTS)) {
      assert.ok(exportedFns.includes(name), `FUNCTION_CONTRACTS has a contract for '${name}' which is not an exported function`);
    }
    for (const [name, check] of Object.entries(FUNCTION_CONTRACTS)) {
      assert.doesNotThrow(check, `${name} threw on malformed input`);
    }
  } finally {
    cleanup(dir);
  }
});

// review-4 #6a: probe 심화 -- Object.create(validTask)류 프로토타입 상속 객체는 task
// 필드가 own-property가 아니므로 거부돼야 한다(이전엔 claim되어 CLAIMED가 됐다).
test("input-boundary-6a: a prototype-inherited task (fields not own-properties) is refused, no marker", () => {
  const dir = freshDir();
  try {
    const store = armedStore();
    const inherited = Object.create(makeTask()); // every field inherited, none own
    const r = claim(store, inherited, { dir, nowFn: NOW_OK });
    assert.equal(r.ok, false);
    assert.equal(r.store.state, STATE.ARMED, "inherited task -> pure refuse, arm untouched");
    assert.equal(existsSync(markerPathFor(dir, "arm-1", "HYK-135-coder-1")), false, "no marker");
  } finally {
    cleanup(dir);
  }
});

// review-4 #6b: null/undefined가 어느 인자 위치에 들어와도 uncaught TypeError 0
// (options 인자 `?? {}` 정규화 + marker-path null 안전성). 리뷰어가 직접 지적한
// createArmStore(g,null)/claim(vs,vt,null)/start(vs,null)/loadStore("x",null) 포함.
test("input-boundary-6b: null/undefined in any argument position never causes an uncaught throw", () => {
  const dir = freshDir();
  try {
    const g = makeGrant();
    const vs = armedStore();
    const vt = makeTask();
    const probes = [
      () => createArmStore(g, null),
      () => createArmStore(null, null),
      () => claim(vs, vt, null),
      () => claim(vs, null, null),
      () => claim(null, null, null),
      () => start(vs, null),
      () => start(null, null),
      () => finishAttempt(vs, null),
      () => finishAttempt(null, null),
      () => cancel(vs, null),
      () => cancel(null, null),
      () => checkExpiry(vs, undefined, undefined),
      () => checkExpiry(null, undefined, undefined),
      () => recoverIncompleteClaim(vs, null),
      () => recoverIncompleteClaim(null, null),
      () => verifyClaimBinding(vs, null, null),
      () => verifyClaimBinding(null, null, null),
      () => mod.acquireClaimMarker(dir, null, null),
      () => mod.acquireClaimMarker(null, null, null),
      () => saveStoreAtomic(join(dir, "p.json"), null, null),
      () => loadStore("x", null),
      () => loadStore(join(dir, "nope.json"), null),
      () => commit(join(dir, "c.json"), null, null),
      () => commit(join(dir, "c.json"), { ok: false, reason: "r" }, null),
    ];
    for (const p of probes) {
      assert.doesNotThrow(p, `probe threw: ${p.toString()}`);
    }
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 구조 경계(③, review-3 #4): loadStore 스키마 검증 + 손상 store가 어느 진입점에서도
// TypeError를 내지 않음.
// ---------------------------------------------------------------------------

test("structure-boundary: loadStore rejects schema-corrupt stores as STATE_CORRUPT (no downstream TypeError)", () => {
  const dir = freshDir();
  try {
    const good = armedStore();
    const withDeleted = (key) => {
      const s = { ...good };
      delete s[key];
      return s;
    };
    const variants = {
      claimsNull: { ...good, claims: null },
      claimsArray: { ...good, claims: [] },
      receiptsNonArray: { ...good, receipts: "nope" },
      attemptsTotalMissing: withDeleted("attempts_total"),
      rejectionsString: { ...good, rejections: "0" },
      stateInvalid: { ...good, state: "BOGUS" },
      grantNull: { ...good, grant: null },
      perLaneArray: { ...good, attempts_per_lane: [] },
    };
    let n = 0;
    for (const [label, bad] of Object.entries(variants)) {
      const path = join(dir, `bad-${label}.json`);
      writeFileSync(path, JSON.stringify(bad), "utf8");
      const loaded = loadStore(path);
      assert.equal(loaded.ok, false, `${label}: loadStore must reject`);
      assert.match(loaded.reason, /STATE_CORRUPT/, `${label}: reason`);
      n++;
    }
    assert.equal(n, Object.keys(variants).length);

    // A schema-corrupt store that somehow reaches a state-changing function must
    // be refused without a TypeError (belt-and-suspenders guard, not loadStore).
    const badStore = { ...good, claims: null };
    for (const call of [
      () => claim(badStore, makeTask(), { dir }),
      () => start(badStore, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir }),
      () => finishAttempt(badStore, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", outcome: "done", dir }),
      () => recoverIncompleteClaim(badStore, { at: "t1", task_id: "HYK-135-coder-1", attempt_id: "attempt-1", dir }),
      () => cancel(badStore, { at: "t1" }),
      () => checkExpiry(badStore, NOW_OK, "t1"),
    ]) {
      let result;
      assert.doesNotThrow(() => { result = call(); }, "must not TypeError on corrupt store");
      assert.equal(result.ok, false);
      assert.match(result.reason, /STATE_CORRUPT/);
    }
  } finally {
    cleanup(dir);
  }
});

// review-4 disarm-vs-refuse 세부 판정(§3 정합): 상태 파일 손상 시, 안전한 disarm receipt를
// 남길 수 있으면(receipts가 배열) auto-disarm+persist해야 하고, receipts 자체가 손상돼
// 안전 기록이 물리적으로 불가한 경우만 순수 거부.
test("structure-boundary: recordable corruption auto-disarms (§3); receipts-corrupt store is pure-refused (unchanged)", () => {
  const dir = freshDir();
  try {
    const good = armedStore();
    // (a) recordable: claims broken, receipts is still a valid array -> disarm+persist.
    const recordable = { ...good, claims: null };
    const r1 = claim(recordable, makeTask(), { dir });
    assert.equal(r1.ok, false);
    assert.equal(r1.store.state, STATE.DISARMED, "recordable corruption -> §3 auto-disarm");
    assert.equal(r1.store.disarm_cause, DISARM_CAUSE.STATE_CORRUPT);
    assert.equal(r1.store.receipts.at(-1).event, "disarmed");
    // (b) unrecordable: receipts itself is not an array -> cannot record a disarm safely
    // -> pure refuse, the same (untouched) store object echoed back.
    const unrecordable = { ...good, receipts: "not-an-array" };
    const r2 = start(unrecordable, { task_id: "HYK-135-coder-1", attempt_id: "attempt-1", at: "t1", dir });
    assert.equal(r2.ok, false);
    assert.equal(r2.store, unrecordable, "unrecordable corruption -> pure refuse, store reference unchanged");
    assert.match(r2.reason, /cannot record disarm/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// grant validation sanity (used by every gate above via armedStore())
// ---------------------------------------------------------------------------

test("validateGrant: publish_allowed must be fixed false, question/error_policy must be 'pause'", () => {
  assert.deepEqual(validateGrant(makeGrant()), []);
  assert.match(validateGrant(makeGrant({ publish_allowed: true })).join(";"), /publish_allowed/);
  assert.match(validateGrant(makeGrant({ question_policy: "auto" })).join(";"), /question_policy/);
  assert.match(validateGrant(makeGrant({ error_policy: "auto" })).join(";"), /error_policy/);
  const missing = validateGrant({});
  assert.ok(missing.length >= 10);
});

test("createArmStore rejects an invalid grant instead of producing a store", () => {
  const r = createArmStore({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid grant/);
});
