import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  validateEnvelope,
  LAUNCH_MODES,
  ANCHOR_CLASSES,
  ENVELOPE_REASON_CODES,
} from "./launch-envelope.schema.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./launch-envelope.schema.mjs", import.meta.url),
);
const REPO_ROOT = dirname(dirname(dirname(SCRIPT_PATH)));
const PROFILES = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "scripts", "check", "role-profiles.json"),
    "utf8",
  ),
).profiles;

function profileFor(role) {
  const p = PROFILES.find((p) => p.role === role);
  if (!p) throw new Error(`no profile for role ${role}`);
  return p;
}

function root(n) {
  return { realpath: `C:/canonical/root${n}`, sentinel_sha256: `sha${n}` };
}

function goodEnvelope(profile, overrides = {}) {
  return {
    envelope_version: "1",
    orchestration_task_id: "task_abc123",
    dispatch_id: "ctx_def456",
    assignee_pane_key: "pane-a:pane-b",
    harness_task_id: "HYK-167-cycle0-1",
    role: profile.role,
    mode: "LIMITED",
    profile_id: profile.profile_id,
    profile_sha256: "profilehash",
    policy_sha256: "policyhash",
    roots: {
      POLICY_ROOT: root(1),
      TASK_ROOT: root(2),
      CONTROL_ROOT: root(3),
      STATE_ROOT: root(4),
    },
    task: {
      selector: "HYK-167-cycle0-1",
      sha256: "taskhash",
      dropped_at: "2026-07-24T16:26:00+09:00",
    },
    issued_at: "2026-07-24T16:30:00Z",
    expires_at: "2026-07-24T18:30:00Z",
    capability_receipt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// role-matrix positive (all 6 roles)
// ---------------------------------------------------------------------------

test("(1) role matrix positive: all 6 role profiles validate a well-formed matching envelope", () => {
  for (const role of ["PM", "CODER", "REVIEW", "VERIFY", "ORCH"]) {
    const profile = profileFor(role);
    const result = validateEnvelope(goodEnvelope(profile), profile);
    assert.equal(result.status, "PASS", `${role}: ${result.reason}`);
  }
});

test("(2) COMMON profile itself also validates structurally (not launchable in practice, but the contract holds)", () => {
  const profile = profileFor("COMMON");
  const result = validateEnvelope(goodEnvelope(profile), profile);
  assert.equal(result.status, "PASS", result.reason);
});

test("(3) LAUNCH_MODES / ANCHOR_CLASSES enums match the B0-mandated closed sets", () => {
  assert.deepEqual(LAUNCH_MODES, ["LIMITED", "HIGH_ASSURANCE"]);
  assert.deepEqual(ANCHOR_CLASSES, [
    "REQUIRED",
    "ADVISORY",
    "CONDITIONAL",
    "OUTPUT",
  ]);
});

// ---------------------------------------------------------------------------
// zero-check mutation (HG7)
// ---------------------------------------------------------------------------

test("(4) known-bad: profile min_required_anchors=0 -> FAIL ZERO_REQUIRED_ANCHORS", () => {
  const profile = { ...profileFor("CODER"), min_required_anchors: 0 };
  const result = validateEnvelope(goodEnvelope(profile), profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "ZERO_REQUIRED_ANCHORS");
});

test("(5) known-bad: profile REQUIRED anchor count is 0 (all anchors downgraded to ADVISORY) -> FAIL ZERO_REQUIRED_ANCHORS", () => {
  const base = profileFor("CODER");
  const profile = {
    ...base,
    anchors: base.anchors.map((a) => ({ ...a, class: "ADVISORY" })),
  };
  const result = validateEnvelope(goodEnvelope(profile), profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "ZERO_REQUIRED_ANCHORS");
});

// ---------------------------------------------------------------------------
// binding mutations (HG5) -- each must FAIL
// ---------------------------------------------------------------------------

test("(6) known-bad: profile_id mismatch -> FAIL PROFILE_ID_MISMATCH", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile, { profile_id: "profile-coder-v99" });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "PROFILE_ID_MISMATCH");
});

test("(7) known-bad: mode not in profile.allowed_modes -> FAIL MODE_NOT_ALLOWED_FOR_PROFILE", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile, { mode: "HIGH_ASSURANCE" });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "MODE_NOT_ALLOWED_FOR_PROFILE");
});

test("(8) known-bad: REQUIRED anchor count != min_required_anchors -> FAIL ANCHOR_COUNT_MISMATCH", () => {
  const base = profileFor("CODER");
  const profile = {
    ...base,
    min_required_anchors: base.min_required_anchors + 1,
  };
  const result = validateEnvelope(goodEnvelope(profile), profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "ANCHOR_COUNT_MISMATCH");
});

test("(9) known-bad: expired envelope (expires_at <= issued_at) -> FAIL EXPIRES_AT_NOT_AFTER_ISSUED_AT", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile, {
    issued_at: "2026-07-24T16:30:00Z",
    expires_at: "2026-07-24T16:00:00Z",
  });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "EXPIRES_AT_NOT_AFTER_ISSUED_AT");
});

test("(10) known-bad: malformed expires_at -> FAIL EXPIRES_AT_INVALID", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile, { expires_at: "not-a-date" });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "EXPIRES_AT_INVALID");
});

test("(11) known-bad: pane/task hash fields missing (task.sha256 absent) -> FAIL FIELD_TYPE_INVALID", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile);
  delete envelope.task.sha256;
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "FIELD_TYPE_INVALID");
});

test("(12) known-bad: assignee_pane_key missing -> FAIL FIELD_MISSING", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile);
  delete envelope.assignee_pane_key;
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "FIELD_MISSING");
});

test("(13) known-bad: high-authority profile (ORCH), mode=HIGH_ASSURANCE, capability_receipt=null -> FAIL HIGH_AUTHORITY_RECEIPT_REQUIRED (LIMITED_DENY)", () => {
  const profile = profileFor("ORCH");
  const envelope = goodEnvelope(profile, {
    mode: "HIGH_ASSURANCE",
    capability_receipt: null,
  });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "HIGH_AUTHORITY_RECEIPT_REQUIRED");
});

test("(14) paired good: same ORCH HIGH_ASSURANCE envelope but with a non-null capability_receipt -> PASS", () => {
  const profile = profileFor("ORCH");
  const envelope = goodEnvelope(profile, {
    mode: "HIGH_ASSURANCE",
    capability_receipt: { receipt_id: "cap-1", issued_by: "human" },
  });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "PASS", result.reason);
});

// ---------------------------------------------------------------------------
// authority fallback must not exist (HG5) -- cwd/git-toplevel/local .harness
// are not parameters to validateEnvelope at all, so this asserts the
// function's arity/behavior never changes verdict based on such a value
// smuggled into the envelope object itself.
// ---------------------------------------------------------------------------

test("(15) authority fallback: smuggling cwd/git-toplevel/local-.harness-shaped fields into the envelope changes nothing -- validator ignores unknown fields entirely", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile, {
    cwd: "C:/attacker/worktree",
    git_toplevel: "C:/attacker/worktree",
    local_harness_profile_path:
      "C:/attacker/worktree/.harness/role-profiles.json",
  });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "PASS", result.reason);
});

test("(16) shadow detection: envelope.shadow_authority_detected=true -> FAIL SHADOW_AUTHORITY_DETECTED regardless of otherwise-valid fields", () => {
  const profile = profileFor("CODER");
  const envelope = goodEnvelope(profile, { shadow_authority_detected: true });
  const result = validateEnvelope(envelope, profile);
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "SHADOW_AUTHORITY_DETECTED");
});

// ---------------------------------------------------------------------------
// reason-code contract
// ---------------------------------------------------------------------------

test("(17) every FAIL code produced above is a member of ENVELOPE_REASON_CODES", () => {
  const profile = profileFor("CODER");
  const codes = new Set();
  codes.add(
    validateEnvelope(
      { ...goodEnvelope(profile), min_required_anchors: 0 },
      { ...profile, min_required_anchors: 0 },
    ).code,
  );
  codes.add(
    validateEnvelope(goodEnvelope(profile, { profile_id: "x" }), profile).code,
  );
  for (const c of codes) {
    assert.ok(ENVELOPE_REASON_CODES.includes(c), `unexpected code: ${c}`);
  }
});
