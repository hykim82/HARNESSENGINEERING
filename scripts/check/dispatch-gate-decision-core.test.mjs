import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideFromGateExit,
  combineGateDecisions,
  checkGatePreconditions,
  DISPATCH_GATE_STATE,
} from "./dispatch-gate-decision-core.mjs";

test("dispatch-gate-decision-core.mjs has zero import statements (pure core contract)", () => {
  const text = readFileSync(
    new URL("./dispatch-gate-decision-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

// ---------------------------------------------------------------------------
// decideFromGateExit -- closed state set {ALLOW, REJECT_BLOCKED,
// REJECT_OPERATIONAL_ERROR, REJECT_UNKNOWN_EXIT}
// ---------------------------------------------------------------------------

test("exit 0 -> ALLOW, reason carries stdout", () => {
  const r = decideFromGateExit({
    exitCode: 0,
    stdout:
      "reject-streak gate: HYK-217 streak=0 (<2) -- envelope not required",
    stderr: "",
    label: "reject-streak gate",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.ALLOW);
  assert.equal(r.allow, true);
  assert.match(r.reason, /PASS\(exit 0\)/);
  assert.match(r.reason, /streak=0/);
});

test("exit 2 -> REJECT_BLOCKED, reason carries stderr not stdout", () => {
  const r = decideFromGateExit({
    exitCode: 2,
    stdout: "should not appear",
    stderr: "reject-streak gate: HYK-217 streak=3 (>=2) -- no envelope",
    label: "reject-streak gate",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_BLOCKED);
  assert.equal(r.allow, false);
  assert.match(r.reason, /BLOCK\(exit 2\)/);
  assert.match(r.reason, /streak=3/);
  assert.doesNotMatch(r.reason, /should not appear/);
});

test("exit 1 -> REJECT_OPERATIONAL_ERROR (never ALLOW -- no silent-normal fold)", () => {
  const r = decideFromGateExit({
    exitCode: 1,
    stdout: "",
    stderr: "reject-streak gate: task file not found: /tmp/missing.md",
    label: "reject-streak gate",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_OPERATIONAL_ERROR);
  assert.equal(r.allow, false);
  assert.match(r.reason, /운영 오류/);
  assert.match(r.reason, /task file not found/);
});

test("unexpected exit code (e.g. killed by signal, exitCode null) -> REJECT_UNKNOWN_EXIT", () => {
  for (const exitCode of [null, undefined, 3, -1, 137]) {
    const r = decideFromGateExit({
      exitCode,
      stdout: "",
      stderr: "",
      label: "reject-streak gate",
    });
    assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_UNKNOWN_EXIT);
    assert.equal(r.allow, false);
  }
});

test("reason is always a non-empty human-readable string, even with no output", () => {
  for (const exitCode of [0, 1, 2, 5]) {
    const r = decideFromGateExit({
      exitCode,
      stdout: "",
      stderr: "",
      label: "x",
    });
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
    assert.doesNotMatch(r.reason, /undefined/);
  }
});

test("label defaults to 'dispatch gate' when omitted", () => {
  const r = decideFromGateExit({ exitCode: 0, stdout: "ok", stderr: "" });
  assert.match(r.reason, /^dispatch gate:/);
});

// ---------------------------------------------------------------------------
// checkGatePreconditions (2R §2, P1-B) -- fail-closed on unidentifiable
// input, ahead of ever spawning the sub-gate. All facts here are the same
// structural shape the CLI extracts (regex match on task_id line,
// loadLedger()'s own .ok/.existed booleans) -- never a string match on the
// sub-gate's own stdout/stderr (S8).
// ---------------------------------------------------------------------------

const ALL_GOOD = {
  hasTaskIdLine: true,
  taskIdIssueFormatValid: true,
  ledgerExists: true,
  ledgerLoadOk: true,
};

test("checkGatePreconditions: all facts good -> null (proceed to real gates)", () => {
  assert.equal(checkGatePreconditions(ALL_GOOD), null);
});

test("checkGatePreconditions: ⓐ hasTaskIdLine=false -> REJECT_TASK_ID_MISSING, checked before all others", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    hasTaskIdLine: false,
    taskIdIssueFormatValid: false,
    ledgerExists: false,
    ledgerLoadOk: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_MISSING);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ⓑ taskIdIssueFormatValid=false (line present, bad format) -> REJECT_TASK_ID_MALFORMED", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    taskIdIssueFormatValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_MALFORMED);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ⓒ ledgerExists=false -> REJECT_LEDGER_MISSING", () => {
  const r = checkGatePreconditions({ ...ALL_GOOD, ledgerExists: false });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ⓓ ledgerLoadOk=false (present but corrupt) -> REJECT_LEDGER_CORRUPT, reason carries ledgerLoadReason", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    ledgerLoadOk: false,
    ledgerLoadReason: "ledger 'x.json' is not valid JSON (boom)",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_CORRUPT);
  assert.equal(r.allow, false);
  assert.match(r.reason, /boom/);
});

test("checkGatePreconditions: all four rejecting states produce mutually distinct reason strings", () => {
  const states = [
    checkGatePreconditions({ ...ALL_GOOD, hasTaskIdLine: false }),
    checkGatePreconditions({ ...ALL_GOOD, taskIdIssueFormatValid: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerExists: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerLoadOk: false }),
  ];
  const uniqueReasons = new Set(states.map((s) => s.reason));
  assert.equal(uniqueReasons.size, 4);
  const uniqueStates = new Set(states.map((s) => s.state));
  assert.equal(uniqueStates.size, 4);
});

test("checkGatePreconditions: missing/undefined args object -> does not throw, treated as all-bad (fail-closed)", () => {
  assert.doesNotThrow(() => checkGatePreconditions());
  const r = checkGatePreconditions();
  assert.equal(r.allow, false);
});

// ---------------------------------------------------------------------------
// combineGateDecisions
// ---------------------------------------------------------------------------

test("combine: all ALLOW -> allow=true, reasons preserved in order", () => {
  const a = decideFromGateExit({
    exitCode: 0,
    stdout: "a-ok",
    stderr: "",
    label: "A",
  });
  const b = decideFromGateExit({
    exitCode: 0,
    stdout: "b-ok",
    stderr: "",
    label: "B",
  });
  const combined = combineGateDecisions([a, b]);
  assert.equal(combined.allow, true);
  assert.deepEqual(combined.states, [
    DISPATCH_GATE_STATE.ALLOW,
    DISPATCH_GATE_STATE.ALLOW,
  ]);
  assert.equal(combined.reasons.length, 2);
});

test("combine: one REJECT among ALLOWs -> allow=false, both reasons kept", () => {
  const a = decideFromGateExit({
    exitCode: 0,
    stdout: "a-ok",
    stderr: "",
    label: "A",
  });
  const b = decideFromGateExit({
    exitCode: 2,
    stdout: "",
    stderr: "b-blocked",
    label: "B",
  });
  const combined = combineGateDecisions([a, b]);
  assert.equal(combined.allow, false);
  assert.equal(combined.reasons.length, 2);
  assert.match(combined.reasons[1], /b-blocked/);
});

test("combine: empty list -> allow=false (never silently allow on no input)", () => {
  const combined = combineGateDecisions([]);
  assert.equal(combined.allow, false);
});

test("combine: non-array input -> allow=false, does not throw", () => {
  assert.doesNotThrow(() => combineGateDecisions(null));
  assert.equal(combineGateDecisions(undefined).allow, false);
});
