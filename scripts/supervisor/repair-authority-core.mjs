// HYK-252 -- "shadow judgment" core for a repair-authorization ENTRY
// decision. This module is a pure judge: no fs, no child_process, no
// network, no Date.now()/clock reads, zero imports. It is never wired into
// any production gate -- the CLI wrapper module that calls this one only
// ever *observes* what this module would decide, it never lets the
// decision touch a real gate. `operationalEligibility` is always
// `false` and `actualGateEffect` is always the literal `"NONE"` on every
// verdict this module returns, on purpose -- that is the "shadow" contract:
// this judge can never grant real operational eligibility, no matter what
// it decides.
//
// Scope: this is an ENTRY-only judge. EXIT-only conditions (independent
// review completion, exact-diff match, diff-subset check) are never read by
// this module at all -- there is no field name below shaped like those
// concepts, on purpose, so there is no code path that could accidentally
// let an EXIT-shaped field grant WOULD_ISSUE_ENTRY.
//
// Today's real, non-synthetic input in this repo (2026-08-14 18:22 KST
// G-DELIVER-CONSUME-VERDICT event) is expected to resolve to a hard DENY
// (`GATE_SEALED_HUMAN_ONLY`) before permission-separation-unmeasured ever
// becomes relevant -- see this module's contract test's negative-control
// case. That is expected, not a gap: 봉인 축은 그 자체로 무조건 DENY다.

// ---------------------------------------------------------------------
// Public enums
// ---------------------------------------------------------------------

export const REPAIR_VERDICT = Object.freeze({
  WOULD_ISSUE_ENTRY: "WOULD_ISSUE_ENTRY",
  DENY: "DENY",
  UNDECIDABLE: "UNDECIDABLE",
});

export const REASON_CODE = Object.freeze({
  GATE_SEALED_HUMAN_ONLY: "GATE_SEALED_HUMAN_ONLY",
  GATE_PERMANENTLY_UNISSUABLE: "GATE_PERMANENTLY_UNISSUABLE",
  GATE_NO_APPROVED_MANIFEST: "GATE_NO_APPROVED_MANIFEST",
  SIGNATURE_UNAUTHORIZED: "SIGNATURE_UNAUTHORIZED",
  RECEIPT_TAMPER_SUSPECTED: "RECEIPT_TAMPER_SUSPECTED",
  IDENTITY_BOUNDARY_MISMATCH: "IDENTITY_BOUNDARY_MISMATCH",
  POLICY_MANIFEST_DIGEST_MISMATCH: "POLICY_MANIFEST_DIGEST_MISMATCH",
  POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING:
    "POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING",
  PRODUCTION_INPUT_REJECTED: "PRODUCTION_INPUT_REJECTED",
  EVIDENCE_CLASS_INVALID: "EVIDENCE_CLASS_INVALID",
  MATERIALIZED_BOUNDARY_MISSING: "MATERIALIZED_BOUNDARY_MISSING",
  PERMISSION_SEPARATION_UNMEASURED: "PERMISSION_SEPARATION_UNMEASURED",
});

// Fixed priority order for primaryReasonCode selection when multiple
// blockingReasons apply (documented per coder-task.md requirement). The two
// codes not explicitly named in the task's priority list --
// MATERIALIZED_BOUNDARY_MISSING -- are this module's own addition (the task
// only fixes WOULD_ISSUE_ENTRY-eligibility on a non-empty boundary, it does
// not name a reason code for "boundary absent"); it is placed just above
// PERMISSION_SEPARATION_UNMEASURED because both are "an ENTRY precondition
// this module itself requires" rather than "an authenticity/authority
// check against an external claim" -- but it is still classified as a hard
// DENY (never UNDECIDABLE), because the task is explicit that UNDECIDABLE
// is reserved *only* for the permission-separation-unmeasured branch.
const PRIORITY_ORDER = Object.freeze([
  REASON_CODE.GATE_SEALED_HUMAN_ONLY,
  REASON_CODE.GATE_PERMANENTLY_UNISSUABLE,
  REASON_CODE.PRODUCTION_INPUT_REJECTED,
  REASON_CODE.EVIDENCE_CLASS_INVALID,
  REASON_CODE.GATE_NO_APPROVED_MANIFEST,
  REASON_CODE.SIGNATURE_UNAUTHORIZED,
  REASON_CODE.RECEIPT_TAMPER_SUSPECTED,
  REASON_CODE.IDENTITY_BOUNDARY_MISMATCH,
  REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING,
  REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH,
  REASON_CODE.MATERIALIZED_BOUNDARY_MISSING,
  REASON_CODE.PERMISSION_SEPARATION_UNMEASURED,
]);

// ---------------------------------------------------------------------
// Gate classification (data-driven, not an if/else chain of literals)
// ---------------------------------------------------------------------

// Sealed / hard DENY unconditionally: 봉인 배달 판정 축.
const SEALED_GATE_IDS = Object.freeze(new Set(["G-DELIVER-CONSUME-VERDICT"]));

// Permanently un-issuable / hard DENY unconditionally.
const PERMANENTLY_UNISSUABLE_GATE_IDS = Object.freeze(
  new Set(["G-COMMIT-SECRET", "G-COMMIT-NUL"]),
);

// HYK-252-shadow-judge-3 review fix (round 3, reviewer-required): there is
// NO frozen fallback digest anymore. Round 2 shipped
// DEFAULT_EXPECTED_POLICY_DIGEST/DEFAULT_EXPECTED_MANIFEST_DIGEST as
// placeholder constants used whenever `authority` omitted a digest -- the
// reviewer proved that placeholder-vs-placeholder comparisons could reach
// WOULD_ISSUE_ENTRY with no real approved-policy/manifest SHA ever in the
// loop at all ("실제 승인본 SHA를 authority에 주면 placeholder 입력은
// DENY이고 ... placeholder가 승인본 권위가 될 수 있는 경로 자체가
// 남아 있다" -- REVIEW-r2.md 축 B). The rule now is: `authority` MUST
// supply BOTH `expectedPolicyDigest` and `expectedManifestDigest` as
// non-empty strings, or the whole check is a hard DENY
// (POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING) -- there is no value this
// module can compare against on its own. A safer wiring (the CLI/authority
// supplier reading the FROZEN policy doc and approved manifest directly
// and computing a live SHA-256 every evaluation) is explicitly OUT OF
// SCOPE for this round (한용 2026-08-14 20:45 범위 확대 금지) -- see this
// module's judgeRepairAuthority header and the coder.md report's honesty-
// limits section for what that leaves unproven.

const IDENTITY_FIELDS = Object.freeze([
  "issueId",
  "repairTaskId",
  "dispatchId",
  "repoIdentity",
  "baseIdentity",
]);

// Accepts either a Set<string> of approved gate IDs, or an array of
// {gateId, approved} rows (only rows with approved===true count). The
// caller supplies this -- the approved-gate set is never a literal list of
// gate IDs baked into this module's control flow.
export function normalizeApprovedManifest(manifest) {
  if (manifest instanceof Set) return manifest;
  const approved = new Set();
  if (Array.isArray(manifest)) {
    for (const entry of manifest) {
      if (
        entry &&
        entry.approved === true &&
        typeof entry.gateId === "string"
      ) {
        approved.add(entry.gateId);
      }
    }
  }
  return approved;
}

export function classifyGate(gateId, approvedSet) {
  const sealed = SEALED_GATE_IDS.has(gateId);
  const permanentlyUnissuable = PERMANENTLY_UNISSUABLE_GATE_IDS.has(gateId);
  const approved = !sealed && !permanentlyUnissuable && approvedSet.has(gateId);
  return { sealed, permanentlyUnissuable, approved };
}

// ---------------------------------------------------------------------
// Individual DENY-condition checks. Each returns a REASON_CODE string on
// failure, or null on pass -- kept as small pure functions to stay under
// this repo's eslint complexity/max-lines-per-function limits.
// ---------------------------------------------------------------------

function checkSignatureReason(input, authority) {
  const sig = input.approvalSignature;
  if (!sig || typeof sig !== "object")
    return REASON_CODE.SIGNATURE_UNAUTHORIZED;
  if (sig.authorized !== true) return REASON_CODE.SIGNATURE_UNAUTHORIZED;
  // Authoritative reference MUST come from the separate `authority`
  // argument, never from `input` itself -- a self-reported
  // expectedApprovalSignature sitting in the same untrusted object as
  // approvalSignature is never sufficient (task requirement: "must be
  // validated against an authoritative signature, not self-reported").
  const expected = authority.expectedApprovalSignature;
  if (!expected || typeof expected !== "object") {
    return REASON_CODE.SIGNATURE_UNAUTHORIZED;
  }
  if (
    sig.signerId !== expected.signerId ||
    sig.signatureHash !== expected.signatureHash
  ) {
    return REASON_CODE.SIGNATURE_UNAUTHORIZED;
  }
  return null;
}

function checkReceiptReason(input) {
  const receipt = input.failureReceipt;
  if (!receipt || typeof receipt !== "object") {
    return REASON_CODE.RECEIPT_TAMPER_SUSPECTED;
  }
  if (receipt.suspectedTamper === true) {
    return REASON_CODE.RECEIPT_TAMPER_SUSPECTED;
  }
  if (typeof receipt.digest !== "string" || receipt.digest.trim() === "") {
    return REASON_CODE.RECEIPT_TAMPER_SUSPECTED;
  }
  if (
    typeof receipt.expectedDigest === "string" &&
    receipt.digest !== receipt.expectedDigest
  ) {
    return REASON_CODE.RECEIPT_TAMPER_SUSPECTED;
  }
  return null;
}

function checkIdentityReason(input, authority) {
  if (input.identityMismatch === true) {
    return REASON_CODE.IDENTITY_BOUNDARY_MISMATCH;
  }
  for (const field of IDENTITY_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.trim() === "") {
      return REASON_CODE.IDENTITY_BOUNDARY_MISMATCH;
    }
  }
  // Cross-checked against the AUTHORITY context, never against an
  // expected* field the same untrusted input declares about itself.
  if (
    typeof authority.expectedRepoIdentity === "string" &&
    input.repoIdentity !== authority.expectedRepoIdentity
  ) {
    return REASON_CODE.IDENTITY_BOUNDARY_MISMATCH;
  }
  if (
    typeof authority.expectedBaseIdentity === "string" &&
    input.baseIdentity !== authority.expectedBaseIdentity
  ) {
    return REASON_CODE.IDENTITY_BOUNDARY_MISMATCH;
  }
  return null;
}

// HYK-252-shadow-judge-3: no fallback. `authority` must supply BOTH digests
// as non-empty strings -- an untrusted/absent authority digest is never
// silently treated as "matches" NOR compared against a placeholder this
// module invented. Missing either one is its own hard-DENY reason,
// distinct from (and checked before) an actual value mismatch.
function checkDigestReason(input, authority) {
  const hasExpectedPolicy =
    typeof authority.expectedPolicyDigest === "string" &&
    authority.expectedPolicyDigest.trim() !== "";
  const hasExpectedManifest =
    typeof authority.expectedManifestDigest === "string" &&
    authority.expectedManifestDigest.trim() !== "";
  if (!hasExpectedPolicy || !hasExpectedManifest) {
    return REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING;
  }
  if (input.policyDigest !== authority.expectedPolicyDigest) {
    return REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH;
  }
  if (input.manifestDigest !== authority.expectedManifestDigest) {
    return REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH;
  }
  return null;
}

// evidenceClass must be exactly "SYNTHETIC" or exactly "REAL" -- anything
// else (missing, empty string, a typo, any other value) is invalid and
// must never be able to reach WOULD_ISSUE_ENTRY simply because it also
// isn't the literal string "REAL". HYK-252-shadow-judge-2 review fix: the
// prior version only special-cased "REAL"; a caller supplying e.g.
// evidenceClass: undefined or "SYNTHETICish" with every other field
// otherwise valid could previously reach WOULD_ISSUE_ENTRY unchecked.
function checkEvidenceClassReason(input) {
  if (input.evidenceClass === "SYNTHETIC") return null;
  if (input.evidenceClass === "REAL") {
    return REASON_CODE.PRODUCTION_INPUT_REJECTED;
  }
  return REASON_CODE.EVIDENCE_CLASS_INVALID;
}

function checkBoundaryReason(input) {
  const boundary = input.materializedBoundary;
  if (Array.isArray(boundary)) {
    return boundary.length === 0
      ? REASON_CODE.MATERIALIZED_BOUNDARY_MISSING
      : null;
  }
  if (typeof boundary === "string") {
    return boundary.trim() === ""
      ? REASON_CODE.MATERIALIZED_BOUNDARY_MISSING
      : null;
  }
  return REASON_CODE.MATERIALIZED_BOUNDARY_MISSING;
}

function collectBlockingReasons(input, gateClass, authority) {
  const reasons = new Set();
  if (gateClass.sealed) reasons.add(REASON_CODE.GATE_SEALED_HUMAN_ONLY);
  if (gateClass.permanentlyUnissuable) {
    reasons.add(REASON_CODE.GATE_PERMANENTLY_UNISSUABLE);
  }
  const evidenceReason = checkEvidenceClassReason(input);
  if (evidenceReason) reasons.add(evidenceReason);
  if (
    !gateClass.sealed &&
    !gateClass.permanentlyUnissuable &&
    !gateClass.approved
  ) {
    reasons.add(REASON_CODE.GATE_NO_APPROVED_MANIFEST);
  }
  // These three are validated against the separate `authority` context.
  for (const check of [
    checkSignatureReason,
    checkIdentityReason,
    checkDigestReason,
  ]) {
    const reason = check(input, authority);
    if (reason) reasons.add(reason);
  }
  // These two only ever look at `input` itself.
  for (const check of [checkReceiptReason, checkBoundaryReason]) {
    const reason = check(input);
    if (reason) reasons.add(reason);
  }
  if (input.permissionSeparationObserved !== true) {
    reasons.add(REASON_CODE.PERMISSION_SEPARATION_UNMEASURED);
  }
  return reasons;
}

function pickPrimaryReasonCode(blockingReasons) {
  for (const code of PRIORITY_ORDER) {
    if (blockingReasons.includes(code)) return code;
  }
  return null;
}

function pickVerdict(primaryReasonCode) {
  if (primaryReasonCode === null) return REPAIR_VERDICT.WOULD_ISSUE_ENTRY;
  if (primaryReasonCode === REASON_CODE.PERMISSION_SEPARATION_UNMEASURED) {
    return REPAIR_VERDICT.UNDECIDABLE;
  }
  return REPAIR_VERDICT.DENY;
}

// ---------------------------------------------------------------------
// The one function this module exists to provide.
// ---------------------------------------------------------------------

/**
 * Judge a hypothetical repair-authorization ENTRY attempt. Pure function --
 * no I/O, no clock reads, never throws on malformed input (missing/wrong-
 * shaped fields fail safe toward DENY/UNDECIDABLE, never toward
 * WOULD_ISSUE_ENTRY).
 *
 * @param {object} input
 * @param {string} input.gateId
 * @param {object} input.approvalSignature
 * @param {object} [input.expectedApprovalSignature]
 * @param {object} input.failureReceipt
 * @param {string} input.issueId
 * @param {string} input.repairTaskId
 * @param {string} input.dispatchId
 * @param {string} input.repoIdentity
 * @param {string} input.baseIdentity
 * @param {boolean} [input.identityMismatch]
 * @param {string} input.policyDigest
 * @param {string} input.manifestDigest
 * @param {string[]|string} input.materializedBoundary
 * @param {boolean|undefined} input.permissionSeparationObserved
 * @param {"SYNTHETIC"|"REAL"} input.evidenceClass
 * @param {Set<string>|Array<{gateId:string,approved:boolean}>} input.approvedGateManifest
 * @param {object} [authority] Separate, caller-supplied authoritative
 *   reference context -- NEVER read from `input`. HYK-252-shadow-judge-2
 *   review fix: the attempt being judged and what it is judged against
 *   must come from two different channels, or a self-reported input can
 *   always vouch for itself.
 * @param {object} [authority.expectedApprovalSignature]
 * @param {string} [authority.expectedRepoIdentity]
 * @param {string} [authority.expectedBaseIdentity]
 * @param {string} [authority.expectedPolicyDigest]
 * @param {string} [authority.expectedManifestDigest]
 * @returns {{
 *   verdict: "WOULD_ISSUE_ENTRY"|"DENY"|"UNDECIDABLE",
 *   primaryReasonCode: string,
 *   blockingReasons: string[],
 *   evidenceClass: string|undefined,
 *   operationalEligibility: false,
 *   actualGateEffect: "NONE",
 * }}
 */
export function judgeRepairAuthority(input = {}, authority = {}) {
  const safeInput = input && typeof input === "object" ? input : {};
  const safeAuthority =
    authority && typeof authority === "object" ? authority : {};
  const approvedSet = normalizeApprovedManifest(safeInput.approvedGateManifest);
  const gateClass = classifyGate(safeInput.gateId, approvedSet);

  const blockingReasons = [
    ...collectBlockingReasons(safeInput, gateClass, safeAuthority),
  ].sort();
  const primaryReasonCode = pickPrimaryReasonCode(blockingReasons);
  const verdict = pickVerdict(primaryReasonCode);

  return {
    verdict,
    primaryReasonCode,
    blockingReasons,
    evidenceClass: safeInput.evidenceClass,
    operationalEligibility: false,
    actualGateEffect: "NONE",
  };
}
