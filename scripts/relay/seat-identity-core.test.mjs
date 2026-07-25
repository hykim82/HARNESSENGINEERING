import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OWNERSHIP,
  REASON,
  DEFAULT_MIN_CORROBORATION,
  judgeSeatOwnership,
  resolveMinCorroboration,
} from "./seat-identity-core.mjs";

function registryWith(records) {
  return { schemaVersion: 1, seats: records };
}

const FULL_RECORD = {
  ptyId: "pty-1",
  worktreeId: "wt-1",
  paneKey: "seatOne",
  capturedAt: "2026-07-26T03:00:00Z",
};

test("OWNED: ptyId + worktreeId + paneKey all corroborate", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1", paneKey: "seatOne" },
  });
  assert.equal(r.verdict, OWNERSHIP.OWNED);
  assert.equal(r.reason, REASON.SEAT_OWNED);
  assert.equal(r.corroboration, 3);
});

test("OWNED: ptyId + worktreeId alone meets the default minCorroboration=2 (paneKey absent from observation)", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.OWNED);
  assert.equal(r.corroboration, 2);
});

test("NOT_OWNED: ptyId absent from registry entirely", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-unknown", worktreeId: "wt-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(r.reason, REASON.SEAT_NOT_IN_REGISTRY);
});

test("NOT_OWNED: ptyId matches but worktreeId explicitly differs (different worktree, not merely low corroboration)", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-other" },
  });
  assert.equal(r.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(r.reason, REASON.SEAT_NOT_IN_REGISTRY);
});

test("UNPROVEN: registry record missing a required field (worktreeId null)", () => {
  const registry = registryWith([{ ...FULL_RECORD, worktreeId: null }]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_PROVENANCE_INCOMPLETE);
});

test("UNPROVEN: registry record missing capturedAt", () => {
  const registry = registryWith([{ ...FULL_RECORD, capturedAt: null }]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_PROVENANCE_INCOMPLETE);
});

test("UNPROVEN: only 1 corroborating axis (worktreeId not supplied by observation) -- ptyId alone is not enough", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  assert.equal(r.corroboration, 1);
});

test("UNPROVEN: minCorroboration raised to 3 -- ptyId+worktreeId alone (2) is now insufficient", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
    policy: { minCorroboration: 3 },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  assert.equal(r.corroboration, 2);
});

test("AMBIGUOUS: registry has 2 records sharing the same ptyId (registry itself is the corrupted signal)", () => {
  const registry = registryWith([FULL_RECORD, { ...FULL_RECORD }]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.AMBIGUOUS);
  assert.equal(r.reason, REASON.SEAT_REGISTRY_CONFLICT);
});

test("AMBIGUOUS: 2 independently-observed candidates both resolve to OWNED -- no auto-pick of the first", () => {
  const registry = registryWith([
    FULL_RECORD,
    { ...FULL_RECORD, ptyId: "pty-2" },
  ]);
  const r = judgeSeatOwnership({
    registry,
    observed: [
      { ptyId: "pty-1", worktreeId: "wt-1" },
      { ptyId: "pty-2", worktreeId: "wt-1" },
    ],
  });
  assert.equal(r.verdict, OWNERSHIP.AMBIGUOUS);
  assert.equal(r.reason, REASON.SEAT_AMBIGUOUS_CANDIDATES);
  assert.equal(r.candidateCount, 2);
});

test("array observed with only 1 resolving to OWNED -- that one wins, no ambiguity", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: [
      { ptyId: "pty-1", worktreeId: "wt-1" },
      { ptyId: "pty-unrelated", worktreeId: "wt-9" },
    ],
  });
  assert.equal(r.verdict, OWNERSHIP.OWNED);
});

test("handle/title/preview are not accepted anywhere in the ownership signature -- passing them alongside ptyId has zero effect on the verdict", () => {
  const registry = registryWith([FULL_RECORD]);
  const withoutExtras = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
  });
  const withTamperedExtras = judgeSeatOwnership({
    registry,
    observed: {
      ptyId: "pty-1",
      worktreeId: "wt-1",
      handle: "term_totally_different_rotated_handle",
      title: "some spoofed title",
      preview: "some spoofed preview text",
    },
  });
  assert.equal(withoutExtras.verdict, withTamperedExtras.verdict);
  assert.equal(withoutExtras.reason, withTamperedExtras.reason);
});

test("empty/malformed registry -> NOT_OWNED, never throws", () => {
  const r = judgeSeatOwnership({
    registry: null,
    observed: { ptyId: "pty-1", worktreeId: "wt-1" },
  });
  assert.equal(r.verdict, OWNERSHIP.NOT_OWNED);
});

test("missing observed candidate entirely -> NOT_OWNED, never throws", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({ registry });
  assert.equal(r.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(r.reason, REASON.SEAT_NOT_IN_REGISTRY);
});

test("DEFAULT_MIN_CORROBORATION is 2 (sanity, not dead export)", () => {
  assert.equal(DEFAULT_MIN_CORROBORATION, 2);
});

test("resolveMinCorroboration: clamps invalid/below-floor values to the default, honors valid integers >= 2 verbatim", () => {
  for (const badValue of [1, 0, -5, 1.5, "2", null, undefined, NaN]) {
    assert.equal(resolveMinCorroboration(badValue), DEFAULT_MIN_CORROBORATION);
  }
  assert.equal(resolveMinCorroboration(2), 2);
  assert.equal(resolveMinCorroboration(3), 3);
});

// REVIEW review-1 P1-1 regression coverage --------------------------------

test("REVIEW P1-1: policy.minCorroboration below the floor (1) cannot be used to admit a ptyId-only match -- still UNPROVEN, not OWNED", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1" },
    policy: { minCorroboration: 1 },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  assert.equal(r.corroboration, 1);
});

for (const badValue of [0, -1, 1.5, "2", null, NaN, undefined]) {
  test(`REVIEW P1-1: policy.minCorroboration=${String(badValue)} (invalid/below floor) falls back to the default of 2, not accepted verbatim`, () => {
    const registry = registryWith([FULL_RECORD]);
    const r = judgeSeatOwnership({
      registry,
      observed: { ptyId: "pty-1" },
      policy: { minCorroboration: badValue },
    });
    assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
    assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  });
}

test("REVIEW P1-1: policy.minCorroboration=3 (stricter, allowed) is honored", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-1", worktreeId: "wt-1", paneKey: "seatOne" },
    policy: { minCorroboration: 3 },
  });
  assert.equal(r.verdict, OWNERSHIP.OWNED);
});

test("REVIEW P1-1: observed worktreeId absent is a mandatory-condition failure even when ptyId+paneKey alone would otherwise reach minCorroboration=2 (worktreeId confirmation is independent of the corroboration tally)", () => {
  const registry = registryWith([FULL_RECORD]);
  const r = judgeSeatOwnership({
    registry,
    // no worktreeId at all -- only ptyId + paneKey supplied.
    observed: { ptyId: "pty-1", paneKey: "seatOne" },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  // corroboration tally itself would be 2 (ptyId + paneKey) -- the mandatory
  // worktreeId-confirmed gate must still block OWNED regardless of that tally.
  assert.equal(r.corroboration, 2);
});
