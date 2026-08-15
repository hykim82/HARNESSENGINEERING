// HYK-252 -- contract tests for repair-authority-core.mjs. Imports the real
// exports directly and calls them (no CLI spawn here -- that is the wire
// test's job, repair-authority-shadow-wire.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  judgeRepairAuthority,
  normalizeApprovedManifest,
  classifyGate,
  REPAIR_VERDICT,
  REASON_CODE,
} from "./repair-authority-core.mjs";

test("repair-authority-core.mjs has zero import statements (pure core contract)", () => {
  const text = readFileSync(
    new URL("./repair-authority-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPROVED_MANIFEST = new Set([
  "G-DELIVER-STREAK",
  "G-DELIVER-CHAIN",
  "G-COMMIT-REVIEW-BINDING",
  "G-COMMIT-QUALITY",
]);

// HYK-252-shadow-judge-2 review fix: the authoritative reference values
// (expectedApprovalSignature/expectedRepoIdentity/expectedBaseIdentity/
// expectedPolicyDigest/expectedManifestDigest) now live in a SEPARATE
// object passed as judgeRepairAuthority's second argument -- never inside
// the `input` object being judged. baseValidInput() below returns only the
// attempt; baseAuthority() returns the matching authoritative context a
// caller must supply from a distinct channel.
function baseValidInput(overrides = {}) {
  return {
    gateId: "G-DELIVER-STREAK",
    approvalSignature: {
      signerId: "sig-1",
      signatureHash: "hash-1",
      authorized: true,
    },
    failureReceipt: { digest: "d1", expectedDigest: "d1" },
    issueId: "HYK-252",
    repairTaskId: "HYK-252-r1",
    dispatchId: "disp-1",
    repoIdentity: "repo-a",
    baseIdentity: "base-a",
    policyDigest: "hyk252-frozen-policy-digest-v1",
    manifestDigest: "hyk252-frozen-manifest-digest-v1",
    materializedBoundary: ["scripts/supervisor/**"],
    permissionSeparationObserved: true,
    evidenceClass: "SYNTHETIC",
    approvedGateManifest: APPROVED_MANIFEST,
    ...overrides,
  };
}

function baseAuthority(overrides = {}) {
  return {
    expectedApprovalSignature: { signerId: "sig-1", signatureHash: "hash-1" },
    expectedRepoIdentity: "repo-a",
    expectedBaseIdentity: "base-a",
    expectedPolicyDigest: "hyk252-frozen-policy-digest-v1",
    expectedManifestDigest: "hyk252-frozen-manifest-digest-v1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Gate classification helpers
// ---------------------------------------------------------------------------

test("normalizeApprovedManifest: Set passes through unchanged", () => {
  const set = new Set(["G-X"]);
  assert.equal(normalizeApprovedManifest(set), set);
});

test("normalizeApprovedManifest: array form only keeps approved:true rows", () => {
  const result = normalizeApprovedManifest([
    { gateId: "G-A", approved: true },
    { gateId: "G-B", approved: false },
    { gateId: "G-C" },
  ]);
  assert.deepEqual([...result].sort(), ["G-A"]);
});

test("classifyGate: sealed and permanently-unissuable gates are never approved even if the caller's manifest says so", () => {
  const rogueManifest = new Set([
    "G-DELIVER-CONSUME-VERDICT",
    "G-COMMIT-SECRET",
  ]);
  assert.deepEqual(classifyGate("G-DELIVER-CONSUME-VERDICT", rogueManifest), {
    sealed: true,
    permanentlyUnissuable: false,
    approved: false,
  });
  assert.deepEqual(classifyGate("G-COMMIT-SECRET", rogueManifest), {
    sealed: false,
    permanentlyUnissuable: true,
    approved: false,
  });
});

// ---------------------------------------------------------------------------
// WOULD_ISSUE_ENTRY synthetic-positive path
// ---------------------------------------------------------------------------

test("WOULD_ISSUE_ENTRY: synthetic fixture satisfying every condition on an approved gate", () => {
  const verdict = judgeRepairAuthority(baseValidInput(), baseAuthority());
  assert.equal(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY);
  assert.equal(verdict.primaryReasonCode, null);
  assert.deepEqual(verdict.blockingReasons, []);
  assert.equal(verdict.evidenceClass, "SYNTHETIC");
  assert.equal(verdict.operationalEligibility, false);
  assert.equal(verdict.actualGateEffect, "NONE");
});

test("WOULD_ISSUE_ENTRY: reaches the same verdict for each of the four approved-manifest gates", () => {
  for (const gateId of APPROVED_MANIFEST) {
    const verdict = judgeRepairAuthority(
      baseValidInput({ gateId }),
      baseAuthority(),
    );
    assert.equal(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY, gateId);
  }
});

test("approvedGateManifest is data, not hardcoded -- shrinking the manifest changes judgment", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ approvedGateManifest: new Set(["G-DELIVER-CHAIN"]) }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.GATE_NO_APPROVED_MANIFEST,
  );
});

// ---------------------------------------------------------------------------
// HYK-252-shadow-judge-2 review fix: authority must come from a separate
// channel, never from fields the same untrusted input declares about itself
// ---------------------------------------------------------------------------

test("self-vouching rejected: input carries its own expectedApprovalSignature/expected*Digest fields, but authority is not supplied -- must NOT reach WOULD_ISSUE_ENTRY", () => {
  const selfVouchingInput = baseValidInput({
    // An attacker-shaped input embedding its own "authoritative" answer.
    expectedApprovalSignature: { signerId: "sig-1", signatureHash: "hash-1" },
    expectedRepoIdentity: "repo-a",
    expectedBaseIdentity: "base-a",
    expectedPolicyDigest: "hyk252-frozen-policy-digest-v1",
    expectedManifestDigest: "hyk252-frozen-manifest-digest-v1",
  });
  // No authority argument at all -- these input.expected* fields must be
  // completely inert (never read by the core module).
  const verdict = judgeRepairAuthority(selfVouchingInput);
  assert.notEqual(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.SIGNATURE_UNAUTHORIZED);
});

test("self-vouching rejected: authority explicitly supplied but with a DIFFERENT signature than the one embedded in input.expectedApprovalSignature -- authority wins, input's self-claim is ignored", () => {
  const selfVouchingInput = baseValidInput({
    expectedApprovalSignature: { signerId: "sig-1", signatureHash: "hash-1" }, // self-claimed, must be ignored
  });
  const realAuthority = baseAuthority({
    expectedApprovalSignature: { signerId: "sig-1", signatureHash: "hash-1" },
  });
  // Sanity: this DOES pass, because the real authority (not input's claim)
  // happens to agree here.
  assert.equal(
    judgeRepairAuthority(selfVouchingInput, realAuthority).verdict,
    REPAIR_VERDICT.WOULD_ISSUE_ENTRY,
  );
  // Now flip the real authority to disagree -- verdict must follow the
  // authority argument, proving input's embedded expected* is never read.
  const disagreeingAuthority = baseAuthority({
    expectedApprovalSignature: {
      signerId: "sig-1",
      signatureHash: "DIFFERENT",
    },
  });
  const verdict = judgeRepairAuthority(selfVouchingInput, disagreeingAuthority);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.SIGNATURE_UNAUTHORIZED);
});

// ---------------------------------------------------------------------------
// HYK-252-shadow-judge-3 review fix (round 3, REVIEW-r2.md 축 B): round 2's
// DEFAULT_EXPECTED_POLICY_DIGEST/DEFAULT_EXPECTED_MANIFEST_DIGEST fallback
// constants are gone entirely. `authority` must now supply BOTH digests as
// non-empty strings, or the digest axis is a hard DENY
// (POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING) -- there is no module-owned
// placeholder to fall back to anymore, so a "placeholder-shaped" input can
// never coast through on an empty/absent authority digest.
//
// IMPORTANT HONESTY NOTE (also see coder.md's honesty-limits section): the
// "authoritative" digest here is still whatever the CALLER's `authority`
// argument claims -- this round does not add a live SHA-256 read of the
// FROZEN policy doc or the approved manifest (explicitly out of scope,
// 한용 2026-08-14 20:45 범위 확대 금지). So these tests name the CLI/test
// harness's `authority` argument as "the authority channel", never as "the
// real approved-manifest SHA" -- WOULD_ISSUE_ENTRY here proves the field-
// level contract is enforced correctly, not that the digest was ever
// checked against a real, materialized, approved document.
// ---------------------------------------------------------------------------

test("REGRESSION (round-2 defect): authority omits BOTH digests + a placeholder-shaped input -> DENY/POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING, never WOULD_ISSUE_ENTRY (round-2 shipped WOULD_ISSUE_ENTRY here via a frozen fallback constant -- the exact defect REVIEW-r2.md 축 B caught)", () => {
  const placeholderShapedInput = baseValidInput({
    // These string literals are exactly what round 2's now-deleted
    // DEFAULT_EXPECTED_POLICY_DIGEST/DEFAULT_EXPECTED_MANIFEST_DIGEST used
    // to equal -- a caller that still sends "the old placeholder value"
    // must not get treated as authoritative just because it happens to
    // match a constant this module no longer even defines.
    policyDigest: "hyk252-frozen-policy-digest-v1",
    manifestDigest: "hyk252-frozen-manifest-digest-v1",
  });
  const authorityMissingBothDigests = baseAuthority({
    expectedPolicyDigest: undefined,
    expectedManifestDigest: undefined,
  });
  const verdict = judgeRepairAuthority(
    placeholderShapedInput,
    authorityMissingBothDigests,
  );
  assert.notEqual(
    verdict.verdict,
    REPAIR_VERDICT.WOULD_ISSUE_ENTRY,
    "authority omitting both digests must never reach WOULD_ISSUE_ENTRY, regardless of what input claims",
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING,
  );
  assert.ok(
    verdict.blockingReasons.includes(
      REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING,
    ),
  );
  assert.ok(
    !verdict.blockingReasons.includes(
      REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH,
    ),
    "missing-authority-digest is its own distinct reason code, not folded into a value-mismatch code",
  );
});

test("authority supplies ONLY expectedPolicyDigest (expectedManifestDigest missing) -> still DENY/POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING -- BOTH digests are required, not just one", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput(),
    baseAuthority({ expectedManifestDigest: undefined }),
  );
  assert.notEqual(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING,
  );
});

test("authority supplies an empty-string digest -> treated the same as missing (not a valid authoritative value) -> POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput(),
    baseAuthority({ expectedPolicyDigest: "  " }),
  );
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING,
  );
});

test("WOULD_ISSUE_ENTRY only when authority supplies BOTH digests as non-empty strings AND input matches them exactly (field-content check, not just verdict)", () => {
  const verdict = judgeRepairAuthority(baseValidInput(), baseAuthority());
  assert.equal(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY);
  assert.deepEqual(verdict.blockingReasons, []);
  assert.equal(verdict.primaryReasonCode, null);

  // Same authority, but input's digest now disagrees with the (present,
  // non-empty) authority value -- this is the DIFFERENT reason code
  // (an actual mismatch, not a missing-authority-value).
  const mismatchVerdict = judgeRepairAuthority(
    baseValidInput({ policyDigest: "some-other-digest-entirely" }),
    baseAuthority(),
  );
  assert.equal(
    mismatchVerdict.primaryReasonCode,
    REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH,
  );
  assert.ok(
    !mismatchVerdict.blockingReasons.includes(
      REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING,
    ),
  );
});

// ---------------------------------------------------------------------------
// Hard-DENY reasons, one at a time
// ---------------------------------------------------------------------------

test("DENY: sealed gate (G-DELIVER-CONSUME-VERDICT) -> GATE_SEALED_HUMAN_ONLY", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ gateId: "G-DELIVER-CONSUME-VERDICT" }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.GATE_SEALED_HUMAN_ONLY);
  assert.ok(
    verdict.blockingReasons.includes(REASON_CODE.GATE_SEALED_HUMAN_ONLY),
  );
});

test("DENY: permanently un-issuable gates (G-COMMIT-SECRET / G-COMMIT-NUL) -> GATE_PERMANENTLY_UNISSUABLE", () => {
  for (const gateId of ["G-COMMIT-SECRET", "G-COMMIT-NUL"]) {
    const verdict = judgeRepairAuthority(
      baseValidInput({ gateId }),
      baseAuthority(),
    );
    assert.equal(verdict.verdict, REPAIR_VERDICT.DENY, gateId);
    assert.equal(
      verdict.primaryReasonCode,
      REASON_CODE.GATE_PERMANENTLY_UNISSUABLE,
      gateId,
    );
  }
});

test("DENY: human-only gate with no exact-path manifest (G-COMMIT-REVIEW-APPROVAL) -> GATE_NO_APPROVED_MANIFEST", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ gateId: "G-COMMIT-REVIEW-APPROVAL" }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.GATE_NO_APPROVED_MANIFEST,
  );
});

test("DENY: unknown/unlisted gateId is conservative -> GATE_NO_APPROVED_MANIFEST", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ gateId: "G-SOME-UNKNOWN-GATE" }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.GATE_NO_APPROVED_MANIFEST,
  );
});

test("DENY: unauthorized/self-reported signature -> SIGNATURE_UNAUTHORIZED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({
      approvalSignature: {
        signerId: "sig-1",
        signatureHash: "hash-1",
        authorized: false,
      },
    }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.SIGNATURE_UNAUTHORIZED);
});

test("DENY: signature not validated against any authoritative reference -> SIGNATURE_UNAUTHORIZED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput(),
    baseAuthority({ expectedApprovalSignature: undefined }),
  );
  assert.equal(verdict.primaryReasonCode, REASON_CODE.SIGNATURE_UNAUTHORIZED);
});

test("DENY: signature mismatches the authoritative reference -> SIGNATURE_UNAUTHORIZED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput(),
    baseAuthority({
      expectedApprovalSignature: {
        signerId: "sig-1",
        signatureHash: "OTHER-HASH",
      },
    }),
  );
  assert.equal(verdict.primaryReasonCode, REASON_CODE.SIGNATURE_UNAUTHORIZED);
});

test("DENY: tampered failure receipt (explicit suspectedTamper) -> RECEIPT_TAMPER_SUSPECTED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({
      failureReceipt: {
        digest: "d1",
        expectedDigest: "d1",
        suspectedTamper: true,
      },
    }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.RECEIPT_TAMPER_SUSPECTED);
});

test("DENY: failure receipt digest mismatch -> RECEIPT_TAMPER_SUSPECTED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ failureReceipt: { digest: "d1", expectedDigest: "d2" } }),
    baseAuthority(),
  );
  assert.equal(verdict.primaryReasonCode, REASON_CODE.RECEIPT_TAMPER_SUSPECTED);
});

test("DENY: failure receipt missing digest -> RECEIPT_TAMPER_SUSPECTED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ failureReceipt: {} }),
    baseAuthority(),
  );
  assert.equal(verdict.primaryReasonCode, REASON_CODE.RECEIPT_TAMPER_SUSPECTED);
});

test("DENY: identity/boundary field missing -> IDENTITY_BOUNDARY_MISMATCH", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ issueId: undefined }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.IDENTITY_BOUNDARY_MISMATCH,
  );
});

test("DENY: explicit identityMismatch flag -> IDENTITY_BOUNDARY_MISMATCH", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ identityMismatch: true }),
    baseAuthority(),
  );
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.IDENTITY_BOUNDARY_MISMATCH,
  );
});

test("DENY: repoIdentity mismatches the authority's expectedRepoIdentity -> IDENTITY_BOUNDARY_MISMATCH", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput(),
    baseAuthority({ expectedRepoIdentity: "some-other-repo" }),
  );
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.IDENTITY_BOUNDARY_MISMATCH,
  );
});

test("DENY: policyDigest/manifestDigest mismatch expected -> POLICY_MANIFEST_DIGEST_MISMATCH", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ policyDigest: "wrong-digest" }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH,
  );
});

test("DENY: manifestDigest mismatch alone also fires POLICY_MANIFEST_DIGEST_MISMATCH", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ manifestDigest: "wrong-digest" }),
    baseAuthority(),
  );
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH,
  );
});

test("DENY: REAL evidenceClass can never reach WOULD_ISSUE_ENTRY -> PRODUCTION_INPUT_REJECTED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ evidenceClass: "REAL" }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.PRODUCTION_INPUT_REJECTED,
  );
  assert.notEqual(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY);
});

test("DENY: evidenceClass anything other than the literal SYNTHETIC/REAL strings -> EVIDENCE_CLASS_INVALID, never WOULD_ISSUE_ENTRY", () => {
  for (const badValue of [
    undefined,
    null,
    "",
    "synthetic",
    "Synthetic",
    "FAKE",
  ]) {
    const verdict = judgeRepairAuthority(
      baseValidInput({ evidenceClass: badValue }),
      baseAuthority(),
    );
    assert.notEqual(
      verdict.verdict,
      REPAIR_VERDICT.WOULD_ISSUE_ENTRY,
      `evidenceClass=${JSON.stringify(badValue)} must never reach WOULD_ISSUE_ENTRY`,
    );
    assert.ok(
      verdict.blockingReasons.includes(REASON_CODE.EVIDENCE_CLASS_INVALID),
      `evidenceClass=${JSON.stringify(badValue)} must carry EVIDENCE_CLASS_INVALID`,
    );
  }
});

test("DENY: empty materializedBoundary -> MATERIALIZED_BOUNDARY_MISSING", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ materializedBoundary: [] }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.MATERIALIZED_BOUNDARY_MISSING,
  );
});

test("DENY: missing materializedBoundary -> MATERIALIZED_BOUNDARY_MISSING", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ materializedBoundary: undefined }),
    baseAuthority(),
  );
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.MATERIALIZED_BOUNDARY_MISSING,
  );
});

// ---------------------------------------------------------------------------
// UNDECIDABLE -- required-observation-failure path
// ---------------------------------------------------------------------------

test("UNDECIDABLE: permission separation unmeasured (undefined), no other DENY firing -> PERMISSION_SEPARATION_UNMEASURED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ permissionSeparationObserved: undefined }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.UNDECIDABLE);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.PERMISSION_SEPARATION_UNMEASURED,
  );
  assert.deepEqual(verdict.blockingReasons, [
    REASON_CODE.PERMISSION_SEPARATION_UNMEASURED,
  ]);
});

test("UNDECIDABLE: permission separation measured false is treated the same as unmeasured (strict !== true)", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ permissionSeparationObserved: false }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.UNDECIDABLE);
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.PERMISSION_SEPARATION_UNMEASURED,
  );
});

test("UNDECIDABLE never collapses into DENY or WOULD_ISSUE_ENTRY on its own", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({ permissionSeparationObserved: null }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.UNDECIDABLE);
});

// ---------------------------------------------------------------------------
// Multi-DENY-reasons: blockingReasons sorted + priority-order primary pick
// ---------------------------------------------------------------------------

test("multi-DENY: blockingReasons is sorted+deduped, primaryReasonCode follows the documented priority order", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({
      gateId: "G-DELIVER-CONSUME-VERDICT", // sealed -> GATE_SEALED_HUMAN_ONLY (top priority)
      evidenceClass: "REAL", // PRODUCTION_INPUT_REJECTED
      approvalSignature: {
        signerId: "sig-1",
        signatureHash: "hash-1",
        authorized: false,
      }, // SIGNATURE_UNAUTHORIZED
      failureReceipt: { suspectedTamper: true }, // RECEIPT_TAMPER_SUSPECTED
      issueId: undefined, // IDENTITY_BOUNDARY_MISMATCH
      policyDigest: "wrong", // POLICY_MANIFEST_DIGEST_MISMATCH
      permissionSeparationObserved: undefined, // PERMISSION_SEPARATION_UNMEASURED
    }),
    baseAuthority(),
  );
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.GATE_SEALED_HUMAN_ONLY);

  const sorted = [...verdict.blockingReasons].sort();
  assert.deepEqual(
    verdict.blockingReasons,
    sorted,
    "blockingReasons must be lexicographically sorted",
  );
  const deduped = [...new Set(verdict.blockingReasons)];
  assert.equal(
    verdict.blockingReasons.length,
    deduped.length,
    "blockingReasons must be deduped",
  );

  for (const expected of [
    REASON_CODE.GATE_SEALED_HUMAN_ONLY,
    REASON_CODE.PRODUCTION_INPUT_REJECTED,
    REASON_CODE.SIGNATURE_UNAUTHORIZED,
    REASON_CODE.RECEIPT_TAMPER_SUSPECTED,
    REASON_CODE.IDENTITY_BOUNDARY_MISMATCH,
    REASON_CODE.POLICY_MANIFEST_DIGEST_MISMATCH,
    REASON_CODE.PERMISSION_SEPARATION_UNMEASURED,
  ]) {
    assert.ok(
      verdict.blockingReasons.includes(expected),
      `expected ${expected} in blockingReasons`,
    );
  }
});

test("multi-DENY: without the sealed gate, GATE_NO_APPROVED_MANIFEST outranks SIGNATURE_UNAUTHORIZED", () => {
  const verdict = judgeRepairAuthority(
    baseValidInput({
      gateId: "G-COMMIT-REVIEW-APPROVAL",
      approvalSignature: {
        signerId: "sig-1",
        signatureHash: "hash-1",
        authorized: false,
      },
    }),
    baseAuthority(),
  );
  assert.equal(
    verdict.primaryReasonCode,
    REASON_CODE.GATE_NO_APPROVED_MANIFEST,
  );
  assert.ok(
    verdict.blockingReasons.includes(REASON_CODE.SIGNATURE_UNAUTHORIZED),
  );
});

// ---------------------------------------------------------------------------
// Real-world-shaped negative control: 2026-08-14 18:22 event
// ---------------------------------------------------------------------------

test("real-world negative control (2026-08-14 18:22 KST G-DELIVER-CONSUME-VERDICT event): DENY / GATE_SEALED_HUMAN_ONLY", () => {
  const realWorldInput = {
    gateId: "G-DELIVER-CONSUME-VERDICT",
    evidenceClass: "REAL",
    sourceEvidence: "ORCH_RECORDED_PM_UNVERIFIED",
    issueId: "HYK-252",
    repairTaskId: "HYK-252-repair-1",
    dispatchId: "dispatch-2026-08-14-1822",
    repoIdentity: "hyk252-shadow-r1",
    baseIdentity: "master",
    failureReceipt: {
      note: "ORCH-recorded PM claim, unverified against an authoritative source",
    },
    approvalSignature: { signerId: "orch", authorized: false },
    policyDigest: "unknown",
    manifestDigest: "unknown",
    materializedBoundary: [],
    permissionSeparationObserved: undefined,
    approvedGateManifest: APPROVED_MANIFEST,
  };
  const verdict = judgeRepairAuthority(realWorldInput);
  assert.equal(verdict.verdict, REPAIR_VERDICT.DENY);
  assert.equal(verdict.primaryReasonCode, REASON_CODE.GATE_SEALED_HUMAN_ONLY);
  assert.equal(verdict.operationalEligibility, false);
  assert.equal(verdict.actualGateEffect, "NONE");
});

// ---------------------------------------------------------------------------
// Malformed-input fail-safety
// ---------------------------------------------------------------------------

test("malformed input (undefined/non-object) never throws and never reaches WOULD_ISSUE_ENTRY", () => {
  for (const bad of [undefined, null, "not-an-object", 42, []]) {
    const verdict = judgeRepairAuthority(bad);
    assert.notEqual(verdict.verdict, REPAIR_VERDICT.WOULD_ISSUE_ENTRY);
    assert.equal(verdict.operationalEligibility, false);
    assert.equal(verdict.actualGateEffect, "NONE");
  }
});
