// HYK-403: blocks the exact invocation shape that caused the 2026-08-30
// control-room contamination -- a hand-built
// `node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs
// scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs`, typed by
// a worker/ORCH directly against a live worktree, bypassing both canonical
// entry points (isolated-suite-runner.mjs's disposable clone;
// full-sweep-local.mjs's ledger-isolation preload) and picking up whatever
// test happened to touch the live checkout.
//
// Mechanism: any construction of that old form necessarily includes
// scripts/check (it is one of the four canonical TEST_DIRS -- see
// isolated-suite-runner.mjs), so this file rides along inside the very
// sweep it is guarding, no matter how that sweep was invoked. Both
// canonical entry points set HYK403_CANONICAL_SUITE_ENTRYPOINT on the
// child's env right before spawning `node --test`; a bare `node --test
// <glob>` run by hand never sets it, so the assertion below fails and the
// whole run goes red. `npm test` (CI-canonical, package.json) resolves to
// isolated-suite-runner.mjs, so this also proves CI and `npm test` take the
// same path.
import { test } from "node:test";
import assert from "node:assert/strict";

test("full suite was invoked via a canonical entry point (npm test / full-sweep-local.mjs), not a hand-built node --test glob", () => {
  const entrypoint = process.env.HYK403_CANONICAL_SUITE_ENTRYPOINT;
  assert.ok(
    entrypoint === "isolated-suite-runner" || entrypoint === "full-sweep-local",
    "HYK403_CANONICAL_SUITE_ENTRYPOINT is unset (or unrecognized) -- this " +
      "looks like a hand-built `node --test <glob>` run against the live " +
      "checkout, the exact shape that contaminated the control room on " +
      "2026-08-30. Use `npm test` (CI-canonical) or " +
      "`node scripts/check/full-sweep-local.mjs` (live checkout) instead.",
  );
});
