import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  validateMigrationEntry,
  validateMigrationLedger,
  MIGRATION_ACTIONS,
  CYCLE0_LEDGER_HEADER,
} from "./migration-ledger.schema.mjs";
import { computePortabilityAccounting } from "./portability-accounting.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./migration-ledger.schema.mjs", import.meta.url),
);
const CHECK_DIR = dirname(SCRIPT_PATH);

function goodDownagradeEntry(overrides = {}) {
  return {
    migration_id: "mig-1",
    check_id: "role-guard",
    old_substrate: "claude-pretooluse",
    old_install_targets: ["repo-settings:PreToolUse"],
    old_hash: "sha-old-1",
    action: "DOWNGRADE_AUXILIARY",
    reason: "engine-neutral replacement anchor landed",
    replacement_anchor_ids: ["role-guard-neutral-v1"],
    replacement_anchor_versions: ["v1"],
    actual_canary_refs: "canary-2026-08-01.json",
    hook_disabled_A_B_matrix_ref: "ab-matrix-2026-08-01.md",
    fake_adapter_ref: "fake-adapter-check-2026-08-01.md",
    manual_A_regression_ref: "manual-regression-2026-08-01.md",
    independent_review_ref: "review:HYK-200-r1",
    scope_and_mode: "role-guard only, LIMITED mode",
    residual_gap: "none identified",
    packet_and_human_approval_ref: "PKT-2026-08-01 / 승인: OK 한용 2026-08-01",
    inventory_before_sha256: "sha-before",
    inventory_after_sha256: "sha-after",
    rollback_or_restore_ref: "rollback-plan-2026-08-01.md",
    recorded_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function goodRemoveEntry(overrides = {}) {
  return {
    ...goodDownagradeEntry({ action: "REMOVE", migration_id: "mig-2" }),
    tombstone_ref: "RETIRED_TOMBSTONE:role-guard",
    ...overrides,
  };
}

function goodDualRunEntry(overrides = {}) {
  const e = goodDownagradeEntry({ action: "DUAL_RUN", migration_id: "mig-3" });
  // DUAL_RUN doesn't require promotion-bundle evidence -- strip it to prove
  // that path independently.
  delete e.actual_canary_refs;
  delete e.hook_disabled_A_B_matrix_ref;
  delete e.fake_adapter_ref;
  delete e.manual_A_regression_ref;
  delete e.independent_review_ref;
  return { ...e, ...overrides };
}

// ---------------------------------------------------------------------------
// good paths
// ---------------------------------------------------------------------------

test("(1) validateMigrationEntry: well-formed DOWNGRADE_AUXILIARY entry -> PASS", () => {
  const result = validateMigrationEntry(goodDownagradeEntry());
  assert.equal(result.status, "PASS", result.reason);
});

test("(2) validateMigrationEntry: well-formed REMOVE entry with tombstone_ref -> PASS", () => {
  const result = validateMigrationEntry(goodRemoveEntry());
  assert.equal(result.status, "PASS", result.reason);
});

test("(3) validateMigrationEntry: DUAL_RUN entry needs no promotion-bundle evidence -> PASS", () => {
  const result = validateMigrationEntry(goodDualRunEntry());
  assert.equal(result.status, "PASS", result.reason);
});

test("(4) MIGRATION_ACTIONS is the closed 3-value enum", () => {
  assert.deepEqual(MIGRATION_ACTIONS, [
    "DUAL_RUN",
    "DOWNGRADE_AUXILIARY",
    "REMOVE",
  ]);
});

// ---------------------------------------------------------------------------
// cycle-0 ledger initial state
// ---------------------------------------------------------------------------

test("(5) validateMigrationLedger: cycle-0 empty ledger (header only, 0 entries) -> PASS", () => {
  const ledger = { header: CYCLE0_LEDGER_HEADER, entries: [] };
  const result = validateMigrationLedger(ledger);
  assert.equal(result.status, "PASS", result.reason);
});

test("(6) validateMigrationLedger: missing header -> FAIL LEDGER_HEADER_MISSING", () => {
  const result = validateMigrationLedger({ entries: [] });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "LEDGER_HEADER_MISSING");
});

test("(6b) review-1 repro: forged header on an empty-entries ledger -> FAIL CYCLE0_HEADER_MISMATCH", () => {
  const result = validateMigrationLedger({
    header: "forged cycle-zero header",
    entries: [],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "CYCLE0_HEADER_MISMATCH");
});

test("(6c) review-1 repro: entries is a non-array object -> FAIL ENTRIES_NOT_ARRAY", () => {
  const result = validateMigrationLedger({
    header: CYCLE0_LEDGER_HEADER,
    entries: { forged: true },
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "ENTRIES_NOT_ARRAY");
});

test("(6d) regression: the real scripts/check/migration-ledger.json loads and validates PASS", () => {
  const realLedger = JSON.parse(
    readFileSync(join(CHECK_DIR, "migration-ledger.json"), "utf8"),
  );
  const result = validateMigrationLedger(realLedger);
  assert.equal(result.status, "PASS", result.reason);
});

// ---------------------------------------------------------------------------
// D0-3 §4.3 mandated mutations
// ---------------------------------------------------------------------------

test("(7) mutation: DOWNGRADE_AUXILIARY missing actual_canary_refs -> FAIL PROMOTION_BUNDLE_EVIDENCE_REQUIRED", () => {
  const entry = goodDownagradeEntry();
  delete entry.actual_canary_refs;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

test("(8) mutation: DOWNGRADE_AUXILIARY missing hook_disabled_A_B_matrix_ref -> FAIL PROMOTION_BUNDLE_EVIDENCE_REQUIRED", () => {
  const entry = goodDownagradeEntry();
  delete entry.hook_disabled_A_B_matrix_ref;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

test("(9) mutation: DOWNGRADE_AUXILIARY missing fake_adapter_ref -> FAIL PROMOTION_BUNDLE_EVIDENCE_REQUIRED", () => {
  const entry = goodDownagradeEntry();
  delete entry.fake_adapter_ref;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

test("(10) mutation: DOWNGRADE_AUXILIARY missing manual_A_regression_ref -> FAIL PROMOTION_BUNDLE_EVIDENCE_REQUIRED", () => {
  const entry = goodDownagradeEntry();
  delete entry.manual_A_regression_ref;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

test("(11) mutation: DOWNGRADE_AUXILIARY missing independent_review_ref -> FAIL PROMOTION_BUNDLE_EVIDENCE_REQUIRED", () => {
  const entry = goodDownagradeEntry();
  delete entry.independent_review_ref;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

test("(12) mutation: REMOVE with full promotion bundle but no tombstone_ref -> FAIL TOMBSTONE_REQUIRED", () => {
  const entry = goodRemoveEntry();
  delete entry.tombstone_ref;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "TOMBSTONE_REQUIRED");
});

test("(13) mutation: REMOVE missing promotion bundle evidence AND tombstone_ref -> FAIL on evidence first (fail fast, not silently accepted)", () => {
  const entry = goodRemoveEntry();
  delete entry.actual_canary_refs;
  delete entry.tombstone_ref;
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

test("(14) invalid action string -> FAIL ACTION_INVALID", () => {
  const entry = goodDownagradeEntry({ action: "SILENTLY_DELETE" });
  const result = validateMigrationEntry(entry);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "ACTION_INVALID");
});

test("(15) validateMigrationLedger: a ledger whose entries include one unevidenced transition -> FAIL (propagates entry failure)", () => {
  const badEntry = goodDownagradeEntry();
  delete badEntry.independent_review_ref;
  const ledger = { header: CYCLE0_LEDGER_HEADER, entries: [badEntry] };
  const result = validateMigrationLedger(ledger);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROMOTION_BUNDLE_EVIDENCE_REQUIRED");
});

// ---------------------------------------------------------------------------
// cross-check with D0-1: manifest ID deletion path must show up as baseline
// drift in the portability accounting, independent of the ledger's own view
// ---------------------------------------------------------------------------

test("(16) cross-check: deleting a manifest entry (as a REMOVE would, absent a tombstone) drops baseline below 11 in D0-1's aggregator -- the two modules agree a bare deletion is wrong", () => {
  const elevenGoodEntries = [
    "selfcheck-freshness",
    "worker-status-onstart",
    "go-task-id-gate",
    "status-fresh",
    "linear-sync",
    "controlroom-fresh",
    "context-inject",
    "report-style-guard",
    "role-guard",
    "pm-guard",
    "clear-safe-check",
  ].map((id) => ({
    id,
    portability: {
      classification:
        id === "clear-safe-check"
          ? "ENGINE_SPECIFIC_AUXILIARY"
          : "DIRECT_A_B_PORTABLE",
      completion_disposition:
        id === "clear-safe-check"
          ? "HUMAN_APPROVED_EXCLUSION"
          : "ENGINE_NEUTRAL_PASS_TARGET",
      approval_status: id === "clear-safe-check" ? "APPROVED" : "N/A",
      human_approval_ref: id === "clear-safe-check" ? "PKT-x" : null,
      counts_toward_baseline: true,
      counts_toward_engine_neutral_pass: id !== "clear-safe-check",
    },
  }));
  const afterBareDeletion = elevenGoodEntries.filter(
    (e) => e.id !== "role-guard",
  );
  const result = computePortabilityAccounting(afterBareDeletion);
  assert.equal(result.baseline_count, 10);
  assert.equal(result.ok, false);
});
