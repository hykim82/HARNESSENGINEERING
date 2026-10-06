import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectTestFiles } from "./isolated-suite-runner.mjs";

// HYK-209 e5 (testdirs-coverage): mechanical coverage count for the CI-canonical
// runner. "Every git-tracked *.test.mjs must be collected by the runner" is
// asserted as an empty set difference, so the next test file that lands outside
// TEST_DIRS turns this suite red instead of silently leaving CI.
//
// Two independent sources, on purpose:
//   - tracked  = git's own index (`git ls-files`), filtered by a regex.
//   - collected = the runner's PRODUCTION collectTestFiles(), called with its
//     default TEST_DIRS (not a copy, not a shared constant the test owns).
// If both sides came from one list, the check would be a tautology.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function trackedTestFiles() {
  const out = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((p) => /\.test\.mjs$/.test(p))
    .map((p) => p.trim())
    .sort();
}

test("TEST_DIRS coverage: every git-tracked *.test.mjs is collected by the runner (empty difference)", () => {
  const tracked = trackedTestFiles();
  // A temp-dir run or a broken index would yield [] and "pass" the diff below
  // vacuously -- refuse that shape outright.
  assert.ok(
    tracked.length > 0,
    `no git-tracked *.test.mjs found under ${repoRoot} -- refusing a vacuous pass (is the repo root right / is git available?)`,
  );

  const collected = new Set(
    collectTestFiles(repoRoot).map((p) => p.split("\\").join("/")),
  );
  const missing = tracked.filter((p) => !collected.has(p));

  assert.deepEqual(
    missing,
    [],
    `${missing.length} git-tracked *.test.mjs file(s) are OUTSIDE the runner's TEST_DIRS and would never run in CI. Add the directory to TEST_DIRS in scripts/check/isolated-suite-runner.mjs (or move the file). Missing:\n  ${missing.join("\n  ")}`,
  );
});
