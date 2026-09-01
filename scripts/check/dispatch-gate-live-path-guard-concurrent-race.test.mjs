// HYK-404-race-1: deliberately reproduces the concurrent-test race that
// made dispatch-gate-live-path-guard.test.mjs intermittently RED inside
// `npm test` (5 independent observations logged 2026-08-31, latest in an
// isolated clone).
//
// Root cause (pinned in code, not guessed): control-room-patch-apply-
// hyk387-receipt-pointer-effect.test.mjs used to build its PowerShell
// fixture scratch root as `join(<repo root>, ".harness",
// "hyk387-3r-ps1-scratch")` -- INSIDE the exact same live `.harness/` tree
// that dispatch-gate-live-path-guard.test.mjs fingerprints (file list +
// per-file sha256) in its own before()/after() hooks (HYK-394 P1). Because
// `npm test`'s node:test runner runs test FILES concurrently, a
// fingerprintBefore() snapshot taken while the other file's scratch write
// is mid-flight (or a fingerprintAfter() taken before that write's cleanup
// has finished) observes an extra file that was not there a moment ago --
// a false "the live worktree changed" failure, even though the guard
// test's own code never touched anything. Both files ran 100% green in
// isolation (matching every independent observer's report) because the
// overlap only exists when they run at the same time.
//
// This reproduction does NOT rely on OS thread-scheduling luck (a
// timing-based reproduction -- and fix -- is rejected per this round's
// task). Instead it drives the exact real production functions/constants,
// factored into shared, non-test modules for exactly this purpose
// (live-harness-fingerprint.mjs: repoRootFromHere/fingerprintDir, the same
// logic dispatch-gate-live-path-guard.test.mjs's own before()/after() hooks
// use; hyk387-ps1-scratch-root.mjs: SCRATCH_ROOT, the same path
// control-room-patch-apply-hyk387-receipt-pointer-effect.test.mjs's own
// withPs1FixtureDir() builds fixtures under) -- and deterministically
// sequences, in plain JS control flow, the exact interleaving that
// produces the false positive: fingerprint the live `.harness/`, then --
// before the second fingerprint -- run the real scratch-directory-creation
// step the other test performs and leave it in place (exactly what "the
// other test hasn't finished yet" looks like from the guard's point of
// view), then fingerprint again.
//
// RED before the fix (SCRATCH_ROOT nested under the live `.harness/`): the
// second fingerprint differs from the first -- the exact false positive
// this round investigated.
// GREEN after the fix (SCRATCH_ROOT under os.tmpdir(), HYK-404-race-1):
// the scratch write never touches the live `.harness/` tree at all, so the
// fingerprints stay byte-identical no matter how the two files interleave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  repoRootFromHere,
  fingerprintDir,
} from "./live-harness-fingerprint.mjs";
import { SCRATCH_ROOT } from "./hyk387-ps1-scratch-root.mjs";

test("HYK-404-race-1: a real concurrently-running test's real scratch write, deterministically interleaved between the guard's two live-.harness fingerprints, must not change the fingerprint", () => {
  const liveHarnessDir = join(repoRootFromHere(), ".harness");

  const fingerprintBefore = fingerprintDir(liveHarnessDir);

  // Deterministic stand-in for "the other test file is mid-flight": runs
  // the REAL production scratch-creation shape (mkdirSync + mkdtempSync,
  // same as withPs1FixtureDir in the real effect test) against the REAL,
  // imported SCRATCH_ROOT, and deliberately leaves it in place before the
  // second fingerprint -- exactly the observable state during the failure
  // window. No sleeps, timers, or process spawning involved.
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const otherTestDir = mkdtempSync(join(SCRATCH_ROOT, "effect-"));
  writeFileSync(
    join(otherTestDir, "synthetic-dispatch-receipts.jsonl"),
    "probe",
    "utf8",
  );

  let fingerprintAfter;
  try {
    fingerprintAfter = fingerprintDir(liveHarnessDir);
  } finally {
    // Clean up regardless of the assertion outcome -- but only THIS
    // reproduction's own mkdtemp subdir, never the shared SCRATCH_ROOT
    // itself (HYK-404-race-1, self-caught: an earlier version of this test
    // rmSync'd the whole SCRATCH_ROOT here, which -- since SCRATCH_ROOT is
    // the same fixed os.tmpdir() path this test imports from the real
    // production module -- deleted the REAL effect test's own in-flight
    // mkdtemp subdir out from under it whenever the two files happened to
    // run concurrently, an ENOENT observed directly:
    // `npm test` -> control-room-patch-apply-hyk387-receipt-pointer-
    // effect.test.mjs's layer2 test failed with
    // "ENOENT: ... hyk387-3r-ps1-scratch\effect-WX1iAh\harness.ps1" the
    // first time this reproduction ran as part of the full suite. Removing
    // only `otherTestDir` mirrors the real production idiom exactly --
    // withPs1FixtureDir's own `finally` also only ever removes its own
    // mkdtemp subdir, never SCRATCH_ROOT itself; SCRATCH_ROOT is removed
    // only by that file's own `after()`, once, after ALL its own tests
    // finish.
    rmSync(otherTestDir, { recursive: true, force: true });
  }

  assert.equal(
    fingerprintAfter,
    fingerprintBefore,
    "HYK-404-race-1: a concurrently-running test's real scratch write must not be observable inside dispatch-gate-live-path-guard.test.mjs's live-.harness fingerprint window -- if this fails, SCRATCH_ROOT (control-room-patch-apply-hyk387-receipt-pointer-effect.test.mjs) has regressed back to nesting under the live `.harness/` tree instead of os.tmpdir()",
  );
});
