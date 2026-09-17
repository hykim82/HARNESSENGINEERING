// HYK-460-staging-list-fix-3: single source of truth for the sibling files
// dispatch-gate-decision.mjs statically imports (transitively). Every
// isolated-clone mutation/wire test that stages a mutant copy of
// dispatch-gate-decision.mjs in a tmpdir must stage all of these too, or the
// clone fails to load at all (ERR_MODULE_NOT_FOUND) -- not a red assertion
// on the axis under test, a load-time crash that breaks every test in the
// file.
//
// Before this file existed, each of ~8 test files hand-maintained its own
// copy of this list (as individual `*_PATH` constants or a local array).
// When dispatch-gate-decision.mjs gained a new static import
// (seat-origin-warn.mjs / seat-origin-registry.mjs, HYK-460 축 C), only ONE
// of those ~8 copies was updated (hyk241-oneb-gate-mutation.test.mjs) --
// the other 8 files' fixed lists silently fell out of sync and their
// mutation tests went red with ERR_MODULE_NOT_FOUND instead of testing
// their actual axis. This has now recurred across HYK-244/257/298/311/457/
// 307/460 -- seven separate rounds hitting the exact same shape of bug.
//
// Fix: consumers that stage a full scripts/check/ clone read this array at
// run time and union it into whatever they already write, so a future new
// static import needs exactly ONE edit (append it here) instead of one edit
// per consuming test file.
export const DISPATCH_GATE_DECISION_SIBLINGS = [
  "dispatch-gate-decision-core.mjs",
  "reject-streak.mjs",
  "reject-streak-chain.mjs",
  "consumption-receipt-core.mjs",
  "dropped-at-stamp-core.mjs",
  "abort-record-core.mjs",
  "retirement-record-core.mjs",
  "retirement-block-reason-shared.mjs",
  "envelope-archive.mjs",
  "seat-origin-warn.mjs",
  "seat-origin-registry.mjs",
];
