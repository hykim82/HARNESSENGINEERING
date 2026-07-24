// HYK-167 사이클0 D0-3 (B0 §5.3, HG10): migration ledger (G8 receipt) shape
// + a pure validator. Cycle 0's own ledger state is the empty-transitions
// case (§4.2: "전이 0건, 11종 PRIMARY_CLAUDE") -- this module's job is to
// define what a FUTURE promotion/downgrade/removal entry must carry before
// it's accepted, and to keep that initial empty state honestly passable
// without also accepting a forged transition. No entry is ever created,
// approved, or executed by this diff.

export const MIGRATION_ACTIONS = Object.freeze([
  "DUAL_RUN",
  "DOWNGRADE_AUXILIARY",
  "REMOVE",
]);

// The 5 promotion-bundle evidence fields a DOWNGRADE_AUXILIARY/REMOVE
// action must carry (task §4.2/§4.3) -- named exactly as the field list
// gives them.
const PROMOTION_BUNDLE_FIELDS = [
  "actual_canary_refs",
  "hook_disabled_A_B_matrix_ref",
  "fake_adapter_ref",
  "manual_A_regression_ref",
  "independent_review_ref",
];

const REQUIRED_ENTRY_FIELDS = [
  "migration_id",
  "check_id",
  "old_substrate",
  "old_install_targets",
  "old_hash",
  "action",
  "reason",
  "replacement_anchor_ids",
  "replacement_anchor_versions",
  "scope_and_mode",
  "residual_gap",
  "packet_and_human_approval_ref",
  "inventory_before_sha256",
  "inventory_after_sha256",
  "rollback_or_restore_ref",
  "recorded_at",
];

export const LEDGER_REASON_CODES = [
  "ENTRY_FIELD_MISSING",
  "ACTION_INVALID",
  "PROMOTION_BUNDLE_EVIDENCE_REQUIRED",
  "TOMBSTONE_REQUIRED",
  "LEDGER_HEADER_MISSING",
];

function nonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function fail(code, reason) {
  return { status: "FAIL", ok: false, code, reason: `${code}: ${reason}` };
}

function pass(reason) {
  return { status: "PASS", ok: true, code: null, reason };
}

// Validates one migration-ledger entry's shape and evidence completeness.
// Pure function -- no filesystem/network access, no ORCH-side side effects.
export function validateMigrationEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return fail("ENTRY_FIELD_MISSING", "entry must be an object");
  }
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (!nonEmptyString(entry[field]) && !Array.isArray(entry[field])) {
      return fail("ENTRY_FIELD_MISSING", `entry.${field} is required`);
    }
  }
  if (!MIGRATION_ACTIONS.includes(entry.action)) {
    return fail(
      "ACTION_INVALID",
      `entry.action '${entry.action}' is not one of ${JSON.stringify(MIGRATION_ACTIONS)}`,
    );
  }

  // DUAL_RUN is the low-risk shadow-run action -- no promotion bundle
  // required yet (it hasn't disabled or removed anything real).
  if (entry.action === "DUAL_RUN") {
    return pass(`entry '${entry.migration_id}' valid (action=DUAL_RUN)`);
  }

  // DOWNGRADE_AUXILIARY / REMOVE both require the full promotion bundle --
  // a real canary, an A/B disabled-hook matrix, a fake-adapter check, a
  // manual A-path regression, and an independent review. Any one missing
  // means the transition is unevidenced and must not be accepted.
  const missingEvidence = PROMOTION_BUNDLE_FIELDS.filter(
    (f) => !nonEmptyString(entry[f]),
  );
  if (missingEvidence.length > 0) {
    return fail(
      "PROMOTION_BUNDLE_EVIDENCE_REQUIRED",
      `entry '${entry.migration_id}' (action=${entry.action}) missing promotion-bundle evidence field(s): ${missingEvidence.join(", ")}`,
    );
  }

  // REMOVE additionally requires a tombstone reference -- an id must never
  // silently vanish from the manifest (§4.2 tombstone rule); it is retired
  // as RETIRED_TOMBSTONE, not deleted.
  if (entry.action === "REMOVE" && !nonEmptyString(entry.tombstone_ref)) {
    return fail(
      "TOMBSTONE_REQUIRED",
      `entry '${entry.migration_id}' (action=REMOVE) has no tombstone_ref -- removal without a RETIRED_TOMBSTONE record is forbidden`,
    );
  }

  return pass(`entry '${entry.migration_id}' valid (action=${entry.action})`);
}

// Validates a whole ledger document: { header, entries: [...] }. Cycle 0's
// initial state is entries=[] with the fixed header text below -- this must
// validate cleanly (an empty ledger is not a zero-check bug here, since
// "zero transitions this cycle" is the actual, honestly-recorded truth).
export const CYCLE0_LEDGER_HEADER =
  "cycle 0: no transitions, all PRIMARY_CLAUDE";

export function validateMigrationLedger(ledger) {
  if (!ledger || typeof ledger !== "object") {
    return fail("LEDGER_HEADER_MISSING", "ledger must be an object");
  }
  if (!nonEmptyString(ledger.header)) {
    return fail("LEDGER_HEADER_MISSING", "ledger.header is required");
  }
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  for (const entry of entries) {
    const result = validateMigrationEntry(entry);
    if (result.status === "FAIL") return result;
  }
  return pass(
    `ledger valid (header='${ledger.header}', ${entries.length} entrie(s))`,
  );
}
