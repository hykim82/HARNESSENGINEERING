import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeEnforcementEntry,
  gradeEnforcementInventory,
  ENFORCEMENT_GRADE,
} from "./enforcement-grade-core.mjs";

test("gradeEnforcementEntry: entry missing entirely -> UNVERIFIED", () => {
  assert.equal(
    gradeEnforcementEntry(undefined, undefined),
    ENFORCEMENT_GRADE.UNVERIFIED,
  );
});

test("gradeEnforcementEntry: entry has no script field -> UNVERIFIED", () => {
  assert.equal(
    gradeEnforcementEntry({ id: "x" }, undefined),
    ENFORCEMENT_GRADE.UNVERIFIED,
  );
});

test("gradeEnforcementEntry: entry has a script but no evidence at all -> DOCUMENTED_PROMISE (not machine-enforced without proof)", () => {
  assert.equal(
    gradeEnforcementEntry(
      { id: "x", script: "scripts/check/x.mjs" },
      undefined,
    ),
    ENFORCEMENT_GRADE.DOCUMENTED_PROMISE,
  );
});

test("gradeEnforcementEntry: evidence present but exit!==0 -> DOCUMENTED_PROMISE, not MACHINE_ENFORCED", () => {
  const evidence = {
    command: "node x.mjs",
    exit: 1,
    at: "2026-08-17T00:00:00+09:00",
  };
  assert.equal(
    gradeEnforcementEntry({ id: "x", script: "x.mjs" }, evidence),
    ENFORCEMENT_GRADE.DOCUMENTED_PROMISE,
  );
});

test("gradeEnforcementEntry: evidence missing the 'at' receipt timestamp -> DOCUMENTED_PROMISE (partial evidence does not upgrade)", () => {
  const evidence = { command: "node x.mjs", exit: 0 };
  assert.equal(
    gradeEnforcementEntry({ id: "x", script: "x.mjs" }, evidence),
    ENFORCEMENT_GRADE.DOCUMENTED_PROMISE,
  );
});

test("gradeEnforcementEntry: full evidence (command+exit0+at) -> MACHINE_ENFORCED", () => {
  const evidence = {
    command: "node x.mjs",
    exit: 0,
    at: "2026-08-17T00:00:00+09:00",
  };
  assert.equal(
    gradeEnforcementEntry({ id: "x", script: "x.mjs" }, evidence),
    ENFORCEMENT_GRADE.MACHINE_ENFORCED,
  );
});

test("gradeEnforcementInventory: preserves input order and grades each independently", () => {
  const entries = [
    { id: "a" },
    { id: "b", script: "b.mjs" },
    { id: "c", script: "c.mjs" },
  ];
  const evidenceByCheckId = {
    c: { command: "node c.mjs", exit: 0, at: "2026-08-17T00:00:00+09:00" },
  };
  const graded = gradeEnforcementInventory(entries, evidenceByCheckId);
  assert.deepEqual(graded, [
    { id: "a", grade: ENFORCEMENT_GRADE.UNVERIFIED },
    { id: "b", grade: ENFORCEMENT_GRADE.DOCUMENTED_PROMISE },
    { id: "c", grade: ENFORCEMENT_GRADE.MACHINE_ENFORCED },
  ]);
});

test("gradeEnforcementInventory: no evidence map supplied at all -> nothing is MACHINE_ENFORCED (fail-closed default)", () => {
  const entries = [
    { id: "a", script: "a.mjs" },
    { id: "b", script: "b.mjs" },
  ];
  const graded = gradeEnforcementInventory(entries);
  assert.ok(
    graded.every((g) => g.grade !== ENFORCEMENT_GRADE.MACHINE_ENFORCED),
  );
});
