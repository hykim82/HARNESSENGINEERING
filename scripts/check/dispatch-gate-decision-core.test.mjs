import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideFromGateExit,
  combineGateDecisions,
  checkGatePreconditions,
  checkLedgerEntryShape,
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
// checkLedgerEntryShape (3R §2/§3 반례7) -- reject-streak.mjs reads
// `ledger?.issues?.[issueId]?.streak ?? 0`, which folds a literal `null`
// streak to 0 (JS `??` treats null/undefined as nullish). This function
// inspects the RAW entry before that fold happens.
// ---------------------------------------------------------------------------

test("checkLedgerEntryShape: no entry for the issue -> valid (never-rejected is a normal state)", () => {
  const r = checkLedgerEntryShape({ schema_version: 1, issues: {} }, "HYK-1");
  assert.equal(r.valid, true);
});

test("checkLedgerEntryShape: entry.streak is a valid non-negative finite number -> valid", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: 3, history: [] } } },
    "HYK-1",
  );
  assert.equal(r.valid, true);
});

test("checkLedgerEntryShape: 반례7 -- entry.streak === null -> invalid", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: null, history: [] } } },
    "HYK-1",
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /streak/);
});

test("checkLedgerEntryShape: entry.streak is a string, negative, NaN, or Infinity -> invalid", () => {
  for (const streak of ["2", -1, NaN, Infinity, -Infinity]) {
    const r = checkLedgerEntryShape(
      { issues: { "HYK-1": { streak, history: [] } } },
      "HYK-1",
    );
    assert.equal(r.valid, false, `expected invalid for streak=${streak}`);
  }
});

test("checkLedgerEntryShape: 4R §2 실측 -- entry.streak is a non-integer finite number (e.g. 1.5) -> invalid (2R/3R 형태 검사가 이 값을 놓쳤던 지점)", () => {
  for (const streak of [1.5, 0.1, 2.999, -0.5]) {
    const r = checkLedgerEntryShape(
      { issues: { "HYK-1": { streak, history: [] } } },
      "HYK-1",
    );
    assert.equal(r.valid, false, `expected invalid for streak=${streak}`);
    assert.match(r.reason, /정수/);
  }
});

test("checkLedgerEntryShape: entry.streak is a valid non-negative INTEGER (incl. 0) -> valid", () => {
  for (const streak of [0, 1, 2, 100]) {
    const r = checkLedgerEntryShape(
      { issues: { "HYK-1": { streak, history: [] } } },
      "HYK-1",
    );
    assert.equal(r.valid, true, `expected valid for streak=${streak}`);
  }
});

test("checkLedgerEntryShape: entry.history present but not an array -> invalid", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: 2, history: "not-an-array" } } },
    "HYK-1",
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /history/);
});

test("checkLedgerEntryShape: entry.history absent -> valid (history is optional)", () => {
  const r = checkLedgerEntryShape(
    { issues: { "HYK-1": { streak: 0 } } },
    "HYK-1",
  );
  assert.equal(r.valid, true);
});

test("checkLedgerEntryShape: entry itself is not a plain object (array/null/primitive) -> invalid", () => {
  for (const entry of [null, [1, 2], "oops", 5]) {
    const r = checkLedgerEntryShape({ issues: { "HYK-1": entry } }, "HYK-1");
    assert.equal(r.valid, false);
  }
});

test("checkLedgerEntryShape: malformed ledger object itself (missing .issues) -> does not throw, treated as no-entry (valid)", () => {
  assert.doesNotThrow(() => checkLedgerEntryShape({}, "HYK-1"));
  assert.doesNotThrow(() => checkLedgerEntryShape(null, "HYK-1"));
  assert.doesNotThrow(() => checkLedgerEntryShape(undefined, "HYK-1"));
});

// ---------------------------------------------------------------------------
// checkGatePreconditions (1R/2R/3R §2) -- 3R rewrites this to a confirmative
// (default-reject) model: ALLOW (return null) requires EVERY fact to be the
// literal boolean `true` for the taskIdMatchCount===1 -- unexpected types
// (numbers, strings, undefined) fail the strict comparisons and fall to
// REJECT, closing the set defensively. All facts here are the same
// structural shape the CLI extracts (regex match count on task_id lines,
// loadLedger()'s own .ok boolean, checkLedgerEntryShape's own .valid
// boolean) -- never a string match on the sub-gate's own stdout/stderr (S8).
// ---------------------------------------------------------------------------

const ALL_GOOD = {
  taskIdMatchCount: 1,
  taskIdFormatValid: true,
  ledgerExists: true,
  ledgerLoadOk: true,
  ledgerEntryShapeValid: true,
};

test("checkGatePreconditions: all facts good -> null (proceed to real gates)", () => {
  assert.equal(checkGatePreconditions(ALL_GOOD), null);
});

test("checkGatePreconditions: taskIdMatchCount=0 (no task_id line) -> REJECT_TASK_ID_NOT_UNIQUE, checked before all others", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    taskIdMatchCount: 0,
    taskIdFormatValid: false,
    ledgerExists: false,
    ledgerLoadOk: false,
    ledgerEntryShapeValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_NOT_UNIQUE);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: 3R 반례6 -- taskIdMatchCount=2 (duplicate task_id lines) -> REJECT_TASK_ID_NOT_UNIQUE", () => {
  const r = checkGatePreconditions({ ...ALL_GOOD, taskIdMatchCount: 2 });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_NOT_UNIQUE);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: taskIdFormatValid=false (line present exactly once, bad format) -> REJECT_TASK_ID_MALFORMED", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    taskIdFormatValid: false,
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_TASK_ID_MALFORMED);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ledgerExists=false -> REJECT_LEDGER_MISSING", () => {
  const r = checkGatePreconditions({ ...ALL_GOOD, ledgerExists: false });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING);
  assert.equal(r.allow, false);
});

test("checkGatePreconditions: ledgerLoadOk=false (present but corrupt) -> REJECT_LEDGER_CORRUPT, reason carries ledgerLoadReason", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    ledgerLoadOk: false,
    ledgerLoadReason: "ledger 'x.json' is not valid JSON (boom)",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_CORRUPT);
  assert.equal(r.allow, false);
  assert.match(r.reason, /boom/);
});

test("checkGatePreconditions: 3R 반례7 -- ledgerEntryShapeValid=false (e.g. streak: null) -> REJECT_LEDGER_ENTRY_MALFORMED, reason carries ledgerEntryShapeReason", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    ledgerEntryShapeValid: false,
    ledgerEntryShapeReason:
      "이슈 'HYK-9999'.streak이 유효한 음이 아닌 유한 수가 아님(null)",
  });
  assert.equal(r.state, DISPATCH_GATE_STATE.REJECT_LEDGER_ENTRY_MALFORMED);
  assert.equal(r.allow, false);
  assert.match(r.reason, /streak이 유효한/);
});

test("checkGatePreconditions: all six rejecting states produce mutually distinct reason strings and state codes", () => {
  const states = [
    checkGatePreconditions({ ...ALL_GOOD, taskIdMatchCount: 0 }),
    checkGatePreconditions({ ...ALL_GOOD, taskIdMatchCount: 2 }),
    checkGatePreconditions({ ...ALL_GOOD, taskIdFormatValid: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerExists: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerLoadOk: false }),
    checkGatePreconditions({ ...ALL_GOOD, ledgerEntryShapeValid: false }),
  ];
  const uniqueReasons = new Set(states.map((s) => s.reason));
  assert.equal(uniqueReasons.size, 6);
  // taskIdMatchCount=0 and =2 are DIFFERENT root causes (missing vs
  // duplicate) but 3R deliberately maps both to the SAME state
  // (REJECT_TASK_ID_NOT_UNIQUE, "not exactly one") -- only 5 distinct
  // state codes across 6 reasons, verified explicitly here so a future
  // change can't accidentally merge a genuinely different cause into this
  // shared state without this assertion catching the count shift.
  const uniqueStates = new Set(states.map((s) => s.state));
  assert.equal(uniqueStates.size, 5);
});

test("checkGatePreconditions: missing/undefined args object -> does not throw, treated as all-bad (fail-closed)", () => {
  assert.doesNotThrow(() => checkGatePreconditions());
  const r = checkGatePreconditions();
  assert.equal(r.allow, false);
});

// ---------------------------------------------------------------------------
// 3R §2-2: closed-set defense -- unexpected/malformed CALLER input (wrong
// types, not just wrong values) must default to REJECT, never accidentally
// satisfy a strict `=== true` / `=== 1` comparison. This is what "그 외
// 전부가 반드시 거부 쪽에 있어야 한다" means at the type level, not just the
// value level covered by the per-field tests above.
// ---------------------------------------------------------------------------

test("checkGatePreconditions: closed-set defense -- truthy-but-not-strictly-true/1 values never satisfy the checks (all reject)", () => {
  const weirdInputs = [
    { ...ALL_GOOD, taskIdMatchCount: "1" }, // string, not number
    { ...ALL_GOOD, taskIdMatchCount: 1.5 }, // not exactly 1
    { ...ALL_GOOD, taskIdFormatValid: 1 }, // truthy number, not boolean true
    { ...ALL_GOOD, taskIdFormatValid: "true" }, // truthy string, not boolean true
    { ...ALL_GOOD, ledgerExists: "yes" },
    { ...ALL_GOOD, ledgerLoadOk: {} }, // truthy object, not boolean true
    { ...ALL_GOOD, ledgerEntryShapeValid: [] }, // truthy array, not boolean true
    { ...ALL_GOOD, taskIdMatchCount: NaN },
    { ...ALL_GOOD, taskIdMatchCount: Infinity },
  ];
  for (const input of weirdInputs) {
    const r = checkGatePreconditions(input);
    assert.notEqual(
      r,
      null,
      `expected reject for ${JSON.stringify(input)}, got ALLOW`,
    );
    assert.equal(r.allow, false);
  }
});

test("checkGatePreconditions: closed-set defense -- an entirely unrecognized extra field never flips the verdict to allow", () => {
  const r = checkGatePreconditions({
    ...ALL_GOOD,
    someFutureFieldNobodyCheckedFor: true,
    anotherSurprise: "whatever",
  });
  // extra unknown fields are simply ignored -- the known five checks still
  // all pass, so this one is the one legitimate ALLOW case even with junk
  // fields attached, proving unknown fields can't SUPPRESS a real reject
  // either (the function only reads the five names it destructures).
  assert.equal(r, null);
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
