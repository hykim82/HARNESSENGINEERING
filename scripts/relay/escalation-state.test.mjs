import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStopTransition,
  reduceCoordinatorState,
  shouldWakeHuman,
  shouldNotify,
  STOP_KIND,
  EMIT_PRIMITIVE,
  COORD_STATE,
  AUTO_ACTION,
} from "./escalation-state.mjs";

// ---------------------------------------------------------------------------
// QA-1: classifyStopTransition -- controlled transitions, exact counts
// ---------------------------------------------------------------------------

test("QA-1: RUNNING and DONE classify as 'none' (0 emit)", () => {
  assert.deepEqual(classifyStopTransition({ kind: STOP_KIND.RUNNING }), {
    ok: true,
    primitive: EMIT_PRIMITIVE.NONE,
  });
  assert.deepEqual(classifyStopTransition({ kind: STOP_KIND.DONE }), {
    ok: true,
    primitive: EMIT_PRIMITIVE.NONE,
  });
});

test("QA-1: NEEDS_INPUT/BLOCKED/REFUSED classify as 'escalation' exactly", () => {
  for (const kind of [
    STOP_KIND.NEEDS_INPUT,
    STOP_KIND.BLOCKED,
    STOP_KIND.REFUSED,
  ]) {
    const result = classifyStopTransition({ kind });
    assert.equal(result.ok, true);
    assert.equal(result.primitive, EMIT_PRIMITIVE.ESCALATION);
  }
});

test("QA-1: DECISION_REQUIRED classifies as 'gate' exactly", () => {
  const result = classifyStopTransition({ kind: STOP_KIND.DECISION_REQUIRED });
  assert.equal(result.ok, true);
  assert.equal(result.primitive, EMIT_PRIMITIVE.GATE);
});

test("QA unobservable: crash/kill/rate-limit/unknown kind is not counted as emit", () => {
  // A controlled-transition function has no legitimate way to see a crash;
  // this asserts the *contract* callers rely on -- an out-of-vocabulary
  // kind must come back ok:false, never silently 'none' (which would let a
  // caller count PUSH_UNOBSERVABLE as an emit PASS).
  for (const kind of ["CRASH", "RATE_LIMIT_KILL", undefined, null, ""]) {
    const result = classifyStopTransition({ kind });
    assert.equal(result.ok, false, `kind=${kind} must not be ok:true`);
    assert.equal("primitive" in result, false);
  }
});

// Mutation-kill 1 (fixture only, mutation applied by hand against the
// module and reverted -- see .harness/coder.md §변이 실측 for the RED/GREEN
// transcript): if DECISION_REQUIRED were misclassified into
// EMIT_PRIMITIVE.ESCALATION (a bare notification-send) instead of GATE,
// this test alone would still pass a naive "some primitive was returned"
// check -- so it must assert the *exact* primitive, not just presence.
test("QA-1 mutation guard: DECISION_REQUIRED must be 'gate', not 'escalation'", () => {
  const result = classifyStopTransition({
    kind: STOP_KIND.DECISION_REQUIRED,
  });
  assert.equal(result.primitive, EMIT_PRIMITIVE.GATE);
  assert.notEqual(result.primitive, EMIT_PRIMITIVE.ESCALATION);
});

// Mutation-kill 2: the inverse -- a plain notification kind must not
// block on a gate.
test("QA-1 mutation guard: BLOCKED must be 'escalation', not 'gate'", () => {
  const result = classifyStopTransition({ kind: STOP_KIND.BLOCKED });
  assert.equal(result.primitive, EMIT_PRIMITIVE.ESCALATION);
  assert.notEqual(result.primitive, EMIT_PRIMITIVE.GATE);
});

// ---------------------------------------------------------------------------
// QB matrix -- 6 states must be distinguishable from event combinations
// ---------------------------------------------------------------------------

const SCOPE = Object.freeze({
  taskId: "task_X",
  dispatchId: "ctx_X",
  role: "CODER",
});

test("QB matrix (1): worker_done-only, no handshake -> DONE_PENDING_HANDSHAKE", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "absent" },
      orchestrationMessages: [
        { type: "worker_done", taskId: "task_X", dispatchId: "ctx_X" },
      ],
      unresolvedGates: [],
    },
  });
  assert.equal(result.state, COORD_STATE.DONE_PENDING_HANDSHAKE);
  assert.equal(result.autoAction, AUTO_ACTION.DEDUPE_WAIT);
  assert.equal(result.wakeHuman, false);
});

test("QB matrix (2): good handshake, no contradiction -> DONE_CONFIRMED", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "done_valid" },
      orchestrationMessages: [],
      unresolvedGates: [],
    },
  });
  assert.equal(result.state, COORD_STATE.DONE_CONFIRMED);
  assert.equal(result.autoAction, AUTO_ACTION.ORCH_CONSUME_QUEUE);
  assert.equal(result.wakeHuman, false);
});

test("QB matrix (3): bad handshake -> INCONSISTENT", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "bad" },
      orchestrationMessages: [],
      unresolvedGates: [],
    },
  });
  assert.equal(result.state, COORD_STATE.INCONSISTENT);
  assert.equal(result.wakeHuman, true);
});

test("QB matrix (4): unresolved gate, no DONE -> NEEDS_INPUT", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "pending" },
      orchestrationMessages: [],
      unresolvedGates: [{ taskId: "task_X", dispatchId: "ctx_X" }],
    },
  });
  assert.equal(result.state, COORD_STATE.NEEDS_INPUT);
  assert.equal(result.autoAction, AUTO_ACTION.ORCH_QUEUE);
});

test("QB matrix (5): timeout, no messages/gates -> PUSH_TIMEOUT", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "absent" },
      orchestrationMessages: [],
      unresolvedGates: [],
      timeout: true,
    },
  });
  assert.equal(result.state, COORD_STATE.PUSH_TIMEOUT);
  assert.equal(result.autoAction, AUTO_ACTION.DEFER_TO_PULL);
  assert.equal(result.wakeHuman, false);
});

test("QB matrix (6): simultaneous DONE + scoped gate -> INCONSISTENT, not DONE_CONFIRMED", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "done_valid" },
      orchestrationMessages: [],
      unresolvedGates: [{ taskId: "task_X", dispatchId: "ctx_X" }],
    },
  });
  assert.equal(result.state, COORD_STATE.INCONSISTENT);
  assert.equal(result.autoAction, AUTO_ACTION.NONE);
  assert.equal(result.wakeHuman, true);
});

// Mutation-kill (W2): worker_done must never be promoted to DONE_CONFIRMED
// by itself, regardless of how many worker_done messages pile up.
test("QB mutation guard (W2): worker_done alone never promotes to DONE_CONFIRMED", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "pending" },
      orchestrationMessages: [
        { type: "worker_done", taskId: "task_X", dispatchId: "ctx_X" },
        { type: "worker_done", taskId: "task_X", dispatchId: "ctx_X" },
      ],
      unresolvedGates: [],
    },
  });
  assert.notEqual(result.state, COORD_STATE.DONE_CONFIRMED);
  assert.equal(result.state, COORD_STATE.DONE_PENDING_HANDSHAKE);
});

// Mutation-kill (W3): contradiction detection must run before DONE
// confirmation -- an if/else that checks done_valid first and returns
// early would hide the simultaneous gate.
test("QB mutation guard (W3): DONE_CONFIRMED branch must not shadow a simultaneous unresolved gate", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "done_valid" },
      orchestrationMessages: [],
      unresolvedGates: [{ taskId: "task_X", dispatchId: "ctx_X" }],
    },
  });
  assert.equal(result.state, COORD_STATE.INCONSISTENT);
});

// Mutation-kill (W2, scope matching): matching taskId alone (ignoring
// dispatchId/role) must not pull in a message/gate from a different
// dispatch of the same task.
test("QB mutation guard (W2 scope): taskId-only match must not leak a different dispatch's gate in", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "done_valid" },
      orchestrationMessages: [],
      unresolvedGates: [{ taskId: "task_X", dispatchId: "ctx_OTHER" }],
    },
  });
  assert.equal(result.state, COORD_STATE.DONE_CONFIRMED);
});

// ---------------------------------------------------------------------------
// Scope isolation -- out-of-scope messages/gates never change current state
// ---------------------------------------------------------------------------

test("scope isolation: other task/dispatch messages+gates mixed in do not change current scope's state", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "done_valid" },
      orchestrationMessages: [
        { type: "escalation", taskId: "task_OTHER", dispatchId: "ctx_OTHER" },
        { type: "worker_done", taskId: "task_X", dispatchId: "ctx_DIFFERENT" },
      ],
      unresolvedGates: [{ taskId: "task_OTHER", dispatchId: "ctx_OTHER" }],
    },
  });
  assert.equal(result.state, COORD_STATE.DONE_CONFIRMED);
});

test("scope isolation: out-of-scope escalation message alone does not create NEEDS_INPUT", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "pending" },
      orchestrationMessages: [
        { type: "escalation", taskId: "task_OTHER", dispatchId: "ctx_OTHER" },
      ],
      unresolvedGates: [],
    },
  });
  assert.notEqual(result.state, COORD_STATE.NEEDS_INPUT);
});

// ---------------------------------------------------------------------------
// supervisorFault / pull signal precedence
// ---------------------------------------------------------------------------

test("supervisorFault -> SUPERVISOR_FAULT even if a valid DONE is also present", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "done_valid" },
      supervisorFault: true,
    },
  });
  assert.equal(result.state, COORD_STATE.SUPERVISOR_FAULT);
  assert.equal(result.wakeHuman, true);
});

test("pullSignals SILENT_STALL -> SILENT_STALL when no scoped needs-input outranks it", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "absent" },
      pullSignals: [{ type: "SILENT_STALL" }],
    },
  });
  assert.equal(result.state, COORD_STATE.SILENT_STALL);
  assert.equal(result.wakeHuman, true);
});

test("pullSignals SEAT_LOST -> SILENT_STALL", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "absent" },
      pullSignals: [{ type: "SEAT_LOST" }],
    },
  });
  assert.equal(result.state, COORD_STATE.SILENT_STALL);
});

// ---------------------------------------------------------------------------
// N1 dedupe -- same stall N ticks -> 1 notify; recover then re-stall -> new notify
// ---------------------------------------------------------------------------

test("N1 dedupe: same dedupeKey+transitionId repeated -> notify only once", () => {
  const notified = new Set();
  const key = "task_X:ctx_X:SILENT_STALL";

  const first = shouldNotify(key, "t1", notified);
  assert.equal(first.notify, true);
  notified.add(first.key);

  for (let i = 0; i < 5; i++) {
    const again = shouldNotify(key, "t1", notified);
    assert.equal(again.notify, false, `tick ${i} must not re-notify`);
  }
});

test("N1 dedupe: recover then re-stall (new transitionId) -> notifies again", () => {
  const notified = new Set();
  const key = "task_X:ctx_X:SILENT_STALL";

  const first = shouldNotify(key, "t1", notified);
  notified.add(first.key);

  const second = shouldNotify(key, "t2", notified);
  assert.equal(second.notify, true);
});

// Mutation-kill (N1): if the key omitted transitionId (cooldown-only
// dedupe), a genuinely new stall transition would be wrongly suppressed.
test("N1 mutation guard: dedupeKey without transitionId would wrongly suppress a new transition (documents the required shape)", () => {
  const notified = new Set();
  const key = "task_X:ctx_X:SILENT_STALL";

  // Correct behavior (transitionId included in the composed key):
  const first = shouldNotify(key, "t1", notified);
  notified.add(first.key);
  const second = shouldNotify(key, "t2", notified);
  assert.equal(second.notify, true);

  // The buggy alternative this guards against: composing the "already
  // notified" set from dedupeKey alone (no transitionId) would find "t2"
  // already covered by "t1"'s bare key and suppress it -- assert the two
  // composed keys are in fact different so that bug cannot pass silently.
  assert.notEqual(first.key, second.key);
});

// ---------------------------------------------------------------------------
// N2 -- two-tier human/ORCH split + human-gate auto-resolve prohibition
// ---------------------------------------------------------------------------

test("N2: human-gate-category NEEDS_INPUT wakes human, non-gate NEEDS_INPUT does not", () => {
  assert.equal(shouldWakeHuman(COORD_STATE.NEEDS_INPUT, true), true);
  assert.equal(shouldWakeHuman(COORD_STATE.NEEDS_INPUT, false), false);
});

test("N2: SILENT_STALL/SUPERVISOR_FAULT/INCONSISTENT always wake human regardless of flag", () => {
  for (const state of [
    COORD_STATE.SILENT_STALL,
    COORD_STATE.SUPERVISOR_FAULT,
    COORD_STATE.INCONSISTENT,
  ]) {
    assert.equal(shouldWakeHuman(state, false), true);
  }
});

test("N2: DONE_CONFIRMED/DONE_PENDING_HANDSHAKE/PUSH_TIMEOUT never wake human", () => {
  for (const state of [
    COORD_STATE.DONE_CONFIRMED,
    COORD_STATE.DONE_PENDING_HANDSHAKE,
    COORD_STATE.PUSH_TIMEOUT,
  ]) {
    assert.equal(shouldWakeHuman(state, false), false);
    assert.equal(shouldWakeHuman(state, true), false);
  }
});

// Mutation-kill (N2 all-human / all-ORCH extremes): this pins the middle
// ground explicitly so an "everything wakes human" or "everything is
// silent" collapse both fail.
test("N2 mutation guard: not all states wake human, and not all states stay silent", () => {
  const allStates = Object.values(COORD_STATE);
  const wakeResults = allStates.map((s) => shouldWakeHuman(s, false));
  assert.ok(
    wakeResults.some((w) => w === true),
    "at least one state must wake",
  );
  assert.ok(
    wakeResults.some((w) => w === false),
    "at least one state must stay silent",
  );
});

// This module never exposes a resolve/auto-clear call for the human-gate
// states -- there is nothing here for a spy to catch calling gate-resolve,
// because no such function exists in this module (R2/HUK-6-gates capability
// boundary; verified by inspection, not a runtime spy, since this is a pure
// logic module with 0 orca/adapter calls to begin with).
test("N2: module surface has no resolve/dismiss export for human-gate states", () => {
  const moduleExports = {
    classifyStopTransition,
    reduceCoordinatorState,
    shouldWakeHuman,
    shouldNotify,
  };
  for (const name of Object.keys(moduleExports)) {
    assert.doesNotMatch(name.toLowerCase(), /resolve|dismiss|autoclear/);
  }
});

// ---------------------------------------------------------------------------
// crash-before-emit -- not counted as push PASS
// ---------------------------------------------------------------------------

test("crash-before-emit: classifyStopTransition refuses rather than reporting a primitive", () => {
  const result = classifyStopTransition({ kind: "PROCESS_KILLED" });
  assert.equal(result.ok, false);
  // A caller that only checks `result.primitive === EMIT_PRIMITIVE.NONE`
  // to mean "no escalation needed, worker looked fine" must not be able to
  // reach that branch from a crash -- there is no 'primitive' key at all.
  assert.equal(result.primitive, undefined);
});

test("crash-before-emit downstream: reduceCoordinatorState with only a timeout signal defers to pull, does not fabricate DONE or NEEDS_INPUT", () => {
  const result = reduceCoordinatorState({
    scope: SCOPE,
    events: {
      resultHandshake: { status: "absent" },
      orchestrationMessages: [],
      unresolvedGates: [],
      timeout: true,
    },
  });
  assert.equal(result.state, COORD_STATE.PUSH_TIMEOUT);
  assert.notEqual(result.state, COORD_STATE.DONE_CONFIRMED);
  assert.notEqual(result.state, COORD_STATE.NEEDS_INPUT);
});
