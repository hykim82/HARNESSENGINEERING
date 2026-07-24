import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  LAUNCH_MODE,
  LIMITED_MODE_HIGH_AUTHORITY_UNATTENDED_START_COUNT,
  BRIDGE_CONDITIONS,
  HOOKS_REMOVED_THIS_CYCLE,
  assertNoHighAssuranceEnableCalls,
} from "./bridge-conditions.mjs";

const SELF_PATH = fileURLToPath(
  new URL("./bridge-conditions.mjs", import.meta.url),
);
const CHECK_DIR = dirname(SELF_PATH);

test("(1) LAUNCH_MODE is the closed {LIMITED, HIGH_ASSURANCE} enum", () => {
  assert.deepEqual(Object.keys(LAUNCH_MODE).sort(), [
    "HIGH_ASSURANCE",
    "LIMITED",
  ]);
  assert.equal(LAUNCH_MODE.LIMITED, "LIMITED");
  assert.equal(LAUNCH_MODE.HIGH_ASSURANCE, "HIGH_ASSURANCE");
});

test("(2) H1: LIMITED mode high-authority unattended-seat start count is 0", () => {
  assert.equal(LIMITED_MODE_HIGH_AUTHORITY_UNATTENDED_START_COUNT, 0);
});

test("(3) BRIDGE_CONDITIONS: exactly 6 entries, each with a unique id and non-empty description", () => {
  assert.equal(BRIDGE_CONDITIONS.length, 6);
  const ids = BRIDGE_CONDITIONS.map((c) => c.id);
  assert.equal(new Set(ids).size, 6, "ids must be unique");
  for (const c of BRIDGE_CONDITIONS) {
    assert.ok(typeof c.description === "string" && c.description.trim() !== "");
  }
});

test("(4) BRIDGE_CONDITIONS entries are frozen (data, not mutable at runtime)", () => {
  assert.ok(Object.isFrozen(BRIDGE_CONDITIONS));
  for (const c of BRIDGE_CONDITIONS) assert.ok(Object.isFrozen(c));
});

test("(5) H3: HOOKS_REMOVED_THIS_CYCLE is 0", () => {
  assert.equal(HOOKS_REMOVED_THIS_CYCLE, 0);
});

test("(6) assertNoHighAssuranceEnableCalls: returns ok:true", () => {
  const result = assertNoHighAssuranceEnableCalls();
  assert.equal(result.ok, true);
});

// HIGH_ASSURANCE enable-path-0 assertion (task §4.1): a source scan across
// every scripts/check/*.mjs this cycle touches, confirming none of them ever
// sets a mode value to the literal string "HIGH_ASSURANCE" via an
// assignment (as opposed to merely mentioning it in an enum/comparison) --
// distinguishes "the string appears" (fine -- enums/comparisons/docs
// reference it) from "something assigns/enables it" (must be absent).
test("(7) no cycle-0 file assigns/enables HIGH_ASSURANCE via a mode= or enable(...) call", () => {
  const filesToScan = [
    "bridge-conditions.mjs",
    "launch-envelope.schema.mjs",
    "role-profiles.json",
    "migration-ledger.schema.mjs",
    "portability-accounting.mjs",
  ];
  const enableAssignmentRe =
    /\b(mode|envelope\.mode)\s*=\s*["']HIGH_ASSURANCE["']|enableHighAssurance\s*\(/;
  for (const f of filesToScan) {
    const text = readFileSync(join(CHECK_DIR, f), "utf8");
    assert.equal(
      enableAssignmentRe.test(text),
      false,
      `${f} must not assign/enable HIGH_ASSURANCE`,
    );
  }
});

test("(8) sanity: CHECK_DIR actually contains this cycle's new files (scan isn't vacuously skipping everything)", () => {
  const names = readdirSync(CHECK_DIR);
  assert.ok(names.includes("bridge-conditions.mjs"));
  assert.ok(names.includes("launch-envelope.schema.mjs"));
});
