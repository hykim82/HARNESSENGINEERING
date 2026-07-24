// HYK-167 사이클0 D0-2 (B0 §3.2/§3.3): dynamic launch-envelope STRUCTURAL
// schema + a pure `validateEnvelope` binder against a static role profile
// (role-profiles.json). This module never spawns anything and never reads
// real clocks/filesystems/hashes on its own -- every value it judges is a
// parameter, exactly like status-fresh.mjs/controlroom-fresh.mjs's own
// injection convention. Actual enforcement (rejecting a real spawn, hashing
// a real root, comparing `expires_at` against a real clock) is cycle 4 --
// see this module's honesty notes below and the task's §0 boundary.

export const LAUNCH_MODES = Object.freeze(["LIMITED", "HIGH_ASSURANCE"]);
export const ANCHOR_CLASSES = Object.freeze([
  "REQUIRED",
  "ADVISORY",
  "CONDITIONAL",
  "OUTPUT",
]);
const ROOT_KEYS = ["POLICY_ROOT", "TASK_ROOT", "CONTROL_ROOT", "STATE_ROOT"];

// Fixed reason codes this validator ever emits -- exported so a doc/test can
// assert the contract's vocabulary never silently drifts (same convention
// as b0-gate.mjs's B0_REASON_CODES).
export const ENVELOPE_REASON_CODES = [
  "FIELD_MISSING",
  "FIELD_TYPE_INVALID",
  "MODE_INVALID",
  "PROFILE_ID_MISMATCH",
  "MODE_NOT_ALLOWED_FOR_PROFILE",
  "ANCHOR_COUNT_MISMATCH",
  "ZERO_REQUIRED_ANCHORS",
  "EXPIRES_AT_INVALID",
  "EXPIRES_AT_NOT_AFTER_ISSUED_AT",
  "HIGH_AUTHORITY_RECEIPT_REQUIRED",
  "SHADOW_AUTHORITY_DETECTED",
  "ROOT_FIELD_INCOMPLETE",
];

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fail(code, reason) {
  return { status: "FAIL", ok: false, code, reason: `${code}: ${reason}` };
}

function pass(reason) {
  return { status: "PASS", ok: true, code: null, reason };
}

const REQUIRED_STRING_FIELDS = [
  "envelope_version",
  "orchestration_task_id",
  "dispatch_id",
  "assignee_pane_key",
  "harness_task_id",
  "role",
  "mode",
  "profile_id",
  "profile_sha256",
  "policy_sha256",
  "issued_at",
  "expires_at",
];

// checkRequiredFields' top-level string-field pass, extracted so the parent
// function's own branch count stays under the repo's ESLint complexity
// ceiling (same quality-check convention selfcheck-inventory.mjs already
// uses for its own helpers) -- identical checks, no behavior change.
function checkTopLevelStrings(envelope) {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (envelope[field] === undefined || envelope[field] === null) {
      return fail("FIELD_MISSING", `envelope.${field} is required`);
    }
    if (typeof envelope[field] !== "string" || envelope[field] === "") {
      return fail(
        "FIELD_TYPE_INVALID",
        `envelope.${field} must be a non-empty string`,
      );
    }
  }
  return null;
}

// checkRequiredFields' roots{} pass -- extracted for the same reason.
function checkRoots(envelope) {
  if (!envelope.roots || typeof envelope.roots !== "object") {
    return fail("FIELD_MISSING", "envelope.roots is required");
  }
  for (const key of ROOT_KEYS) {
    const root = envelope.roots[key];
    if (
      !root ||
      typeof root.realpath !== "string" ||
      root.realpath === "" ||
      typeof root.sentinel_sha256 !== "string" ||
      root.sentinel_sha256 === ""
    ) {
      return fail(
        "ROOT_FIELD_INCOMPLETE",
        `envelope.roots.${key} must carry a non-empty realpath and sentinel_sha256`,
      );
    }
  }
  return null;
}

// checkRequiredFields' task{} pass -- extracted for the same reason.
function checkTask(envelope) {
  if (!envelope.task || typeof envelope.task !== "object") {
    return fail("FIELD_MISSING", "envelope.task is required");
  }
  for (const field of ["selector", "sha256", "dropped_at"]) {
    if (
      typeof envelope.task[field] !== "string" ||
      envelope.task[field] === ""
    ) {
      return fail(
        "FIELD_TYPE_INVALID",
        `envelope.task.${field} must be a non-empty string`,
      );
    }
  }
  return null;
}

// Structural-only field presence/type check -- does not resolve or read any
// of the paths/hashes it validates the shape of (cycle 4's job).
function checkRequiredFields(envelope) {
  return (
    checkTopLevelStrings(envelope) ??
    checkRoots(envelope) ??
    checkTask(envelope)
  );
}

function checkModeAndProfile(envelope, profile) {
  if (!LAUNCH_MODES.includes(envelope.mode)) {
    return fail(
      "MODE_INVALID",
      `envelope.mode '${envelope.mode}' is not one of ${JSON.stringify(LAUNCH_MODES)}`,
    );
  }
  if (envelope.profile_id !== profile.profile_id) {
    return fail(
      "PROFILE_ID_MISMATCH",
      `envelope.profile_id '${envelope.profile_id}' does not match profile.profile_id '${profile.profile_id}'`,
    );
  }
  const allowed = Array.isArray(profile.allowed_modes)
    ? profile.allowed_modes
    : [];
  if (!allowed.includes(envelope.mode)) {
    return fail(
      "MODE_NOT_ALLOWED_FOR_PROFILE",
      `mode '${envelope.mode}' is not in profile '${profile.profile_id}'.allowed_modes ${JSON.stringify(allowed)}`,
    );
  }
  return null;
}

// HG7 zero-check prevention: a profile whose min_required_anchors is 0 (or
// whose REQUIRED anchor count is 0) must never validate -- a role with no
// REQUIRED anchors at all is a vacuous binding, not a real contract.
function checkAnchorBinding(profile) {
  const requiredAnchors = (profile.anchors ?? []).filter(
    (a) => a.class === "REQUIRED",
  );
  if (requiredAnchors.length === 0) {
    return fail(
      "ZERO_REQUIRED_ANCHORS",
      `profile '${profile.profile_id}' declares zero REQUIRED anchors -- a role binding must have at least one`,
    );
  }
  if (
    typeof profile.min_required_anchors !== "number" ||
    profile.min_required_anchors < 1
  ) {
    return fail(
      "ZERO_REQUIRED_ANCHORS",
      `profile '${profile.profile_id}'.min_required_anchors must be >= 1 (got ${profile.min_required_anchors})`,
    );
  }
  if (requiredAnchors.length !== profile.min_required_anchors) {
    return fail(
      "ANCHOR_COUNT_MISMATCH",
      `profile '${profile.profile_id}' declares ${requiredAnchors.length} REQUIRED anchor(s) but min_required_anchors=${profile.min_required_anchors}`,
    );
  }
  return null;
}

// Format-only: confirms both timestamps parse as ISO-8601 and expires_at is
// textually/numerically after issued_at. Never compares against a real
// clock (Date.now()) -- that live "has this envelope actually expired"
// judgment is cycle 4's runtime enforcement, not this structural contract.
function checkExpiry(envelope) {
  if (!ISO_8601_RE.test(envelope.issued_at)) {
    return fail(
      "EXPIRES_AT_INVALID",
      `envelope.issued_at '${envelope.issued_at}' is not a valid ISO-8601 timestamp`,
    );
  }
  if (!ISO_8601_RE.test(envelope.expires_at)) {
    return fail(
      "EXPIRES_AT_INVALID",
      `envelope.expires_at '${envelope.expires_at}' is not a valid ISO-8601 timestamp`,
    );
  }
  if (Date.parse(envelope.expires_at) <= Date.parse(envelope.issued_at)) {
    return fail(
      "EXPIRES_AT_NOT_AFTER_ISSUED_AT",
      `envelope.expires_at (${envelope.expires_at}) must be strictly after envelope.issued_at (${envelope.issued_at})`,
    );
  }
  return null;
}

function checkCapabilityReceipt(envelope, profile) {
  if (
    profile.high_authority_requires === true &&
    envelope.mode === "HIGH_ASSURANCE" &&
    (envelope.capability_receipt === null ||
      envelope.capability_receipt === undefined)
  ) {
    return fail(
      "HIGH_AUTHORITY_RECEIPT_REQUIRED",
      `profile '${profile.profile_id}' is high-authority; mode=HIGH_ASSURANCE requires a non-null capability_receipt (LIMITED_DENY otherwise)`,
    );
  }
  return null;
}

// HG5/§3.3: cwd/git-toplevel/local-.harness values are NEVER inputs to this
// judgment -- by construction, this function accepts no such parameter at
// all, so there is nothing here for an attacker-controlled worktree value
// to override. The only way a caller can signal a local/canonical naming
// collision is the explicit `envelope.shadow_authority_detected` boolean
// (set by whatever upstream discovery step noticed the collision); this
// validator's only job with that signal is to refuse to validate further.
function checkShadowAuthority(envelope) {
  if (envelope.shadow_authority_detected === true) {
    return fail(
      "SHADOW_AUTHORITY_DETECTED",
      "envelope reports a shadow (local file colliding with canonical policy root) -- refusing to validate against a non-authoritative source",
    );
  }
  return null;
}

// The full D0-2 structural contract: field presence/type, mode/profile
// binding, REQUIRED-anchor <-> min_required_anchors consistency, ISO-format
// expiry ordering, and the high-authority capability_receipt rule. Pure
// function -- `envelope` and `profile` are both plain data, no I/O.
export function validateEnvelope(envelope, profile) {
  if (!envelope || typeof envelope !== "object") {
    return fail("FIELD_MISSING", "envelope must be an object");
  }
  if (!profile || typeof profile !== "object") {
    return fail("FIELD_MISSING", "profile must be an object");
  }

  const shadow = checkShadowAuthority(envelope);
  if (shadow) return shadow;

  const fields = checkRequiredFields(envelope);
  if (fields) return fields;

  const modeProfile = checkModeAndProfile(envelope, profile);
  if (modeProfile) return modeProfile;

  const anchors = checkAnchorBinding(profile);
  if (anchors) return anchors;

  const expiry = checkExpiry(envelope);
  if (expiry) return expiry;

  const receipt = checkCapabilityReceipt(envelope, profile);
  if (receipt) return receipt;

  return pass(
    `envelope valid for profile '${profile.profile_id}' (role=${envelope.role}, mode=${envelope.mode})`,
  );
}
