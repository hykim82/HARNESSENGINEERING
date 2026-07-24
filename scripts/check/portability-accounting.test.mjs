import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  computePortabilityAccounting,
  ACCOUNTING_SUMMARY_PHRASE,
} from "./portability-accounting.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./portability-accounting.mjs", import.meta.url),
);
const REPO_ROOT = dirname(dirname(dirname(SCRIPT_PATH)));
const MANIFEST_PATH = join(
  REPO_ROOT,
  "scripts",
  "check",
  "enforcement-inventory.json",
);

function loadRealChecks() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  return manifest.checks;
}

function directPortable(id) {
  return {
    id,
    claude_only: true,
    portability: {
      classification: "DIRECT_A_B_PORTABLE",
      completion_disposition: "ENGINE_NEUTRAL_PASS_TARGET",
      approval_status: "N/A",
      human_approval_ref: null,
      counts_toward_baseline: true,
      counts_toward_engine_neutral_pass: true,
    },
  };
}

function redefined(id) {
  return {
    id,
    claude_only: true,
    portability: {
      classification: "REDEFINED",
      completion_disposition: "REDEFINED_TARGET",
      approval_status: "N/A",
      human_approval_ref: null,
      counts_toward_baseline: true,
      counts_toward_engine_neutral_pass: true,
    },
  };
}

function clearException(overrides = {}) {
  return {
    id: "clear-safe-check",
    claude_only: true,
    portability: {
      classification: "ENGINE_SPECIFIC_AUXILIARY",
      completion_disposition: "HUMAN_APPROVED_EXCLUSION",
      approval_status: "APPROVED",
      human_approval_ref:
        "PKT-20260723-HYK167-R1-REANCHOR / 승인: OK 한용 2026-07-24 16:00",
      counts_toward_baseline: true,
      counts_toward_engine_neutral_pass: false,
      ...overrides,
    },
  };
}

// A well-formed 11-entry fixture matching the real classification split
// (6 direct + 4 redefined + 1 clear exception).
function goodFixture() {
  return [
    directPortable("selfcheck-freshness"),
    directPortable("worker-status-onstart"),
    directPortable("go-task-id-gate"),
    directPortable("status-fresh"),
    directPortable("linear-sync"),
    directPortable("controlroom-fresh"),
    redefined("context-inject"),
    redefined("report-style-guard"),
    redefined("role-guard"),
    redefined("pm-guard"),
    clearException(),
  ];
}

// ---------------------------------------------------------------------------
// baseline good path
// ---------------------------------------------------------------------------

test("(1) computePortabilityAccounting: well-formed 11-entry fixture -> ok:true, exact B0 §4 counts", () => {
  const result = computePortabilityAccounting(goodFixture());
  assert.deepEqual(result, {
    baseline_count: 11,
    classified_count: 11,
    engine_neutral_required: 10,
    engine_neutral_pass: 10,
    approved_exclusion_count: 1,
    unresolved_count: 0,
    overall_accounted: 11,
    ok: true,
  });
});

test("(2) computePortabilityAccounting: real enforcement-inventory.json manifest -> ok:true", () => {
  const result = computePortabilityAccounting(loadRealChecks());
  assert.equal(result.ok, true);
  assert.equal(result.baseline_count, 11);
  assert.equal(result.engine_neutral_pass, 10);
  assert.equal(result.approved_exclusion_count, 1);
  assert.equal(result.unresolved_count, 0);
});

test("(3) ACCOUNTING_SUMMARY_PHRASE is the exact mandated wording -- never '11/11 PASS'", () => {
  assert.equal(
    ACCOUNTING_SUMMARY_PHRASE,
    "10 engine-neutral PASS + 1 approved engine-specific exclusion; 11/11 accounted",
  );
  assert.ok(!ACCOUNTING_SUMMARY_PHRASE.includes("11/11 PASS"));
});

// ---------------------------------------------------------------------------
// zero-check prevention (HYK-157)
// ---------------------------------------------------------------------------

test("(4) known-bad: empty checks array -> ok:false, never a vacuous PASS", () => {
  const result = computePortabilityAccounting([]);
  assert.equal(result.ok, false);
  assert.equal(result.baseline_count, 0);
  assert.equal(result.overall_accounted, 0);
});

test("(5) known-bad: checks present but none carry a portability block -> ok:false", () => {
  const result = computePortabilityAccounting([
    { id: "x", claude_only: true },
    { id: "y", claude_only: true },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.baseline_count, 0);
});

test("(6) computePortabilityAccounting: non-array input -> treated as empty, ok:false (never throws)", () => {
  const result = computePortabilityAccounting(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.baseline_count, 0);
});

// ---------------------------------------------------------------------------
// D0-1 §2.3 mandated mutations -- each must be RED (ok:false)
// ---------------------------------------------------------------------------

test("(7) mutation 1: clear entry deleted entirely -> baseline!=11 -> ok:false", () => {
  const mutated = goodFixture().filter((e) => e.id !== "clear-safe-check");
  const result = computePortabilityAccounting(mutated);
  assert.equal(result.baseline_count, 10);
  assert.equal(result.ok, false);
});

test("(8) mutation 2: clear counts_toward_baseline forced false -> baseline=10 -> ok:false", () => {
  const mutated = goodFixture().map((e) =>
    e.id === "clear-safe-check"
      ? {
          ...e,
          portability: { ...e.portability, counts_toward_baseline: false },
        }
      : e,
  );
  const result = computePortabilityAccounting(mutated);
  assert.equal(result.baseline_count, 10);
  assert.equal(result.ok, false);
});

test("(9) mutation 3: clear counts_toward_engine_neutral_pass forged true -> engine_neutral_pass=11 -> ok:false", () => {
  const mutated = goodFixture().map((e) =>
    e.id === "clear-safe-check"
      ? {
          ...e,
          portability: {
            ...e.portability,
            counts_toward_engine_neutral_pass: true,
          },
        }
      : e,
  );
  const result = computePortabilityAccounting(mutated);
  assert.equal(result.engine_neutral_pass, 11);
  assert.equal(result.ok, false);
});

test("(10) mutation 4: clear approval_status=APPROVED but human_approval_ref=null -> approved_exclusion_count=0, ok:false", () => {
  const mutated = goodFixture().map((e) =>
    e.id === "clear-safe-check"
      ? { ...e, portability: { ...e.portability, human_approval_ref: null } }
      : e,
  );
  const result = computePortabilityAccounting(mutated);
  assert.equal(result.approved_exclusion_count, 0);
  assert.equal(result.overall_accounted, 10);
  assert.equal(result.ok, false);
});

test("(11) mutation 5: one of the 10 non-clear entries set to PENDING_HUMAN_APPROVAL -> unresolved=1 -> ok:false", () => {
  const mutated = goodFixture().map((e) =>
    e.id === "role-guard"
      ? {
          ...e,
          portability: {
            ...e.portability,
            approval_status: "PENDING_HUMAN_APPROVAL",
          },
        }
      : e,
  );
  const result = computePortabilityAccounting(mutated);
  assert.equal(result.unresolved_count, 1);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// CLI smoke
// ---------------------------------------------------------------------------

test("(12) CLI: run against the real manifest -> exit 0, prints the mandated summary phrase", () => {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync("node", [SCRIPT_PATH], { encoding: "utf8" });
  } catch (err) {
    status = err.status;
    stdout = err.stdout ?? "";
  }
  assert.equal(status, 0);
  assert.ok(stdout.includes(ACCOUNTING_SUMMARY_PHRASE));
});
