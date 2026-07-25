import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptLaunch, REASON } from "./launch-seam.mjs";
import { INTENT_STATUS, computeStableIntentId } from "./stable-intent.mjs";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";
import {
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
  makeStableIntentFields,
  makeArmGrant,
  makeSinkSpy,
  makeHumanReceipt,
  makeIssuedIntent,
  makeSubGrantEnvelopeFields,
  ARM_GRANT_CYCLE_ID,
  ARM_GRANT_IN_WINDOW_NOW,
} from "./hyk171-cycle3b-fixtures.mjs";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk171-cycle3b-launch-seam-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function readIntentStatus(intentDir, stableIntentId) {
  return JSON.parse(
    readFileSync(
      join(intentDir, `intent-${stableIntentId}.claim.json`),
      "utf8",
    ),
  ).status;
}

// setupIssuedIntent: intentDir/receiptDir + an already-ISSUED intent record
// (the precondition acceptLaunch's ISSUED->RUNNING transition needs) +
// the matching subGrantEnvelope fields.
function setupIssuedIntent(intentDir, overrides = {}) {
  const stableIntentId = computeStableIntentId(makeStableIntentFields());
  makeIssuedIntent(intentDir, stableIntentId);
  const envelope = makeSubGrantEnvelopeFields(stableIntentId, overrides);
  return { stableIntentId, envelope };
}

function fullyValidGateInputs(bundleDir) {
  const { pullAdmission, gates } = pipelineFixture(bundleDir);
  return {
    requiredBindings: { taskHash: "task-hash-3b-1", role: "CODER" },
    armGrant: makeArmGrant(),
    expectedCycleId: ARM_GRANT_CYCLE_ID,
    nowMs: ARM_GRANT_IN_WINDOW_NOW,
    humanReceipt: makeHumanReceipt(),
    pullAdmission,
    gates,
  };
}
function pipelineFixture(bundleDir) {
  const { pinPath } = writePullAdmissionBundle(bundleDir);
  return {
    pullAdmission: pullAdmissionInput(bundleDir, pinPath),
    gates: makeAllowGates(),
  };
}

// ---- default armed=false: launch acceptance only, sink 0 ----
test("acceptLaunch: armed omitted (default) -> RUNNING receipt recorded, intent ISSUED->RUNNING, sink NEVER called", () => {
  const intentDir = freshDir();
  const receiptDir = freshDir();
  try {
    const { stableIntentId, envelope } = setupIssuedIntent(intentDir);
    const sink = makeSinkSpy();
    const result = acceptLaunch({
      subGrantEnvelope: envelope,
      runningReceiptDir: receiptDir,
      intentDir,
      sink,
      at: "t1",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.launched, false);
    assert.equal(result.running, true);
    assert.equal(result.armed, false);
    assert.equal(sink.calls.length, 0);
    assert.equal(
      readIntentStatus(intentDir, stableIntentId),
      INTENT_STATUS.RUNNING,
    );
  } finally {
    cleanup(intentDir);
    cleanup(receiptDir);
  }
});

test("acceptLaunch: armed explicitly false -> same as default, sink 0", () => {
  const intentDir = freshDir();
  const receiptDir = freshDir();
  try {
    const { envelope } = setupIssuedIntent(intentDir);
    const sink = makeSinkSpy();
    const result = acceptLaunch({
      subGrantEnvelope: envelope,
      armed: false,
      runningReceiptDir: receiptDir,
      intentDir,
      sink,
      at: "t1",
    });
    assert.equal(result.ok, true);
    assert.equal(sink.calls.length, 0);
  } finally {
    cleanup(intentDir);
    cleanup(receiptDir);
  }
});

// ---- non-negotiable: only `=== true` is armed, truthy values are forced false ----
for (const truthyNonTrue of ["true", 1, {}, [], "yes"]) {
  test(`acceptLaunch: armed=${JSON.stringify(truthyNonTrue)} (truthy but not === true) is forced to false -- sink NEVER called`, () => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: truthyNonTrue,
        runningReceiptDir: receiptDir,
        intentDir,
        sink,
        at: "t1",
      });
      assert.equal(result.armed, false);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
}

// ---- paired-good: armed=true + all 6 gates positive -> sink exactly once ----
test("acceptLaunch: armed=true + all gates positive (paired-good) -> sink called EXACTLY once, launched=true", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { stableIntentId, envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.launched, true);
      assert.equal(result.reason, REASON.SINK_INVOKED);
      assert.equal(sink.calls.length, 1);
      assert.equal(sink.calls[0].stableIntentId, stableIntentId);
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.RUNNING,
      );
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- each of the 6 gates independently denies sink (fail-closed) ----
test("acceptLaunch: armed=true but envelope binding mismatch (task_hash) -> sink 0", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
        requiredBindings: { taskHash: "WRONG-HASH", role: "CODER" },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.ENVELOPE_BINDING_MISMATCH);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

test("acceptLaunch: armed=true but armGrant expired -> sink 0", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
        armGrant: makeArmGrant({ expires_at: "2020-01-01T00:00:00.000Z" }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.ARM_EXPIRED);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

test("acceptLaunch: armed=true but armGrant.cycle_id mismatch (generation) -> sink 0", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
        expectedCycleId: "some-other-cycle",
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.ARM_GENERATION_MISMATCH);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

test("acceptLaunch: armed=true but humanReceipt missing -> sink 0", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const inputs = fullyValidGateInputs(bundleDir);
      delete inputs.humanReceipt;
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...inputs,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.HUMAN_RECEIPT_MISSING);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

test("acceptLaunch: armed=true but second admission judgement denies (hard-stop) -> sink 0", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const inputs = fullyValidGateInputs(bundleDir);
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...inputs,
        gates: makeAllowGates({ hardStop: true }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.ADMISSION_DENIED);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

test("acceptLaunch: armed=true + all gates positive but no sink function provided -> sink 0 (SINK_MISSING)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.SINK_MISSING);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- RUNNING receipt uniqueness / exact-count across "concurrent supervisors" ----
test("acceptLaunch: SAME stable intent, two sequential 'supervisor' calls (armed=true both) -> RUNNING total=1, sink total=1", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { stableIntentId, envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const gateInputs = fullyValidGateInputs(bundleDir);

      const first = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...gateInputs,
      });
      const second = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t2",
        ...gateInputs,
      });

      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(second.ok, false, JSON.stringify(second));
      // The second call's ISSUED->RUNNING transition is denied (status is
      // already RUNNING from the first call) before the RUNNING-receipt
      // uniqueness check even runs -- both guards independently block a
      // second acceptance, this just asserts which one fires first given
      // the current gate ordering.
      assert.equal(second.reason, REASON.INTENT_TRANSITION_DENIED);
      assert.equal(
        sink.calls.length,
        1,
        "sink must be called exactly once total",
      );
      assert.equal(
        readdirSync(receiptDir).filter((f) => f.startsWith("running-receipt-"))
          .length,
        1,
        "exactly one RUNNING receipt file must exist for this stable intent",
      );
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.RUNNING,
      );
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- no-respawn after crash: RUNNING recorded, sink denied by a gate, then a
// "restart" (plain re-call) must NOT reach sink either ----
test("acceptLaunch: RUNNING recorded but a gate denies sink (crash-before-sink analogue) -> restart re-call is denied too, sink stays 0 forever for this intent", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const gateInputs = fullyValidGateInputs(bundleDir);

      // First attempt: RUNNING gets recorded (ISSUED->RUNNING + receipt),
      // but the human-receipt gate denies before sink (this stands in for
      // "crash/incomplete-authorization right before the real launch").
      const badInputs = { ...gateInputs };
      delete badInputs.humanReceipt;
      const crashLike = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...badInputs,
      });
      assert.equal(crashLike.ok, false);
      assert.equal(crashLike.reason, REASON.HUMAN_RECEIPT_MISSING);
      assert.equal(crashLike.running, true);
      assert.equal(sink.calls.length, 0);

      // "Restart": a fully-valid re-call for the SAME intent must not
      // auto-respawn -- the ISSUED->RUNNING transition is no longer legal
      // (status is already RUNNING, not ISSUED), so it is denied before any
      // gate/sink evaluation happens again.
      const restart = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t2",
        ...gateInputs,
      });
      assert.equal(restart.ok, false);
      assert.equal(restart.reason, REASON.INTENT_TRANSITION_DENIED);
      assert.equal(
        sink.calls.length,
        0,
        "no automatic respawn after the crash-like denial",
      );
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- launch acceptance != worker completion (§1 structural separation) ----
test("acceptLaunch: a RUNNING receipt alone does not satisfy relay-handshake completion (separate authorities, counted separately)", () => {
  const intentDir = freshDir();
  const receiptDir = freshDir();
  const harnessDir = freshDir();
  try {
    const { envelope } = setupIssuedIntent(intentDir);
    const sink = makeSinkSpy();
    const result = acceptLaunch({
      subGrantEnvelope: envelope,
      runningReceiptDir: receiptDir,
      intentDir,
      sink,
      at: "t1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.running, true);

    // No .harness/CODER-task.md or CODER.md exists in this fresh harnessDir
    // -- checkRelayHandshake (the completion authority, untouched, read-only
    // reference here) must refuse, proving RUNNING receipt count (1) !=
    // completion judgement count (0) for this intent.
    const handshake = checkRelayHandshake({ role: "CODER", harnessDir });
    assert.equal(handshake.ok, false);
    assert.match(handshake.reason, /task file not found/);
  } finally {
    cleanup(intentDir);
    cleanup(receiptDir);
    cleanup(harnessDir);
  }
});

// ---- structural: launch-seam.mjs never imports the orca adapter, so the
// real sink is only reachable via explicit caller wiring (mirrors §5/§8) ----
test("static: launch-seam.mjs source never references the orca adapter (no default real-sink wiring)", () => {
  const src = readFileSync(
    new URL("./launch-seam.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/orca-adapter/i.test(src), false);
  assert.equal(/createRealLaunchSink/.test(src), false);
  assert.equal(/createOrcaExecFn/.test(src), false);
});
