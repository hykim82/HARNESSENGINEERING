// HYK-365 2R: contract test for ci-gitleaks-order.mjs -- pins that
// enforce.yml keeps gitleaks installed BEFORE the test suite runs (ⓐ), and
// that the install step's run: text actually performs the install as
// EXECUTED code rather than merely mentioning the target path in a comment
// (ⓑ). continue-on-error is deliberately NOT this file's concern anymore
// (2R downgrade after review-1 P1-1) -- see ci-gitleaks-order.mjs's module
// header and the comment above §4 test 3 below (no automated test here;
// nc-ci-enforce.test.mjs's own workflow-wide continue-on-error contract
// already owns it, verified live once instead -- see coder.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseWorkflowSteps,
  judgeGitleaksOrder,
} from "./ci-gitleaks-order.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const ENFORCE_YML_PATH = `${ROOT}/.github/workflows/enforce.yml`;

function realWorkflowText() {
  return readFileSync(ENFORCE_YML_PATH, "utf8");
}

// A minimal, self-contained fixture shaped like enforce.yml's real
// jobs.enforce.steps sequence (HYK-365 2R order, no continue-on-error), used
// for the break/no-break scenarios below so those tests never depend on the
// real file's exact text drifting for unrelated reasons.
function goodFixture() {
  return [
    "name: enforce",
    "jobs:",
    "  enforce:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    "",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        run: |",
    "          curl -sSL -o gitleaks.tar.gz https://example.invalid/gitleaks.tar.gz",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
    "",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
}

test("HYK-365: parseWorkflowSteps builds a real ordered step array from indentation (not a name lookup)", () => {
  const steps = parseWorkflowSteps(goodFixture());
  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((s) => s.name),
    [
      "Checkout",
      "Install gitleaks (pinned, checksum-verified)",
      "check test suites",
      "gitleaks secret scan",
    ],
  );
  assert.equal(
    steps[2].run.trim(),
    "node scripts/check/isolated-suite-runner.mjs",
  );
});

test("HYK-365 ⑴: the REAL enforce.yml passes both remaining invariants (ⓐ order, ⓑ install realness)", () => {
  const result = judgeGitleaksOrder(realWorkflowText());
  assert.equal(result.ok, true, result.reasons.join("; "));
});

// §4 test 1: order violation -> RED (original text unchanged from 1R).
test("HYK-365 §4-1 counterfactual: install step moved back AFTER the suite -> RED naming ⓐ, indices, and the consequence", () => {
  const broken = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        run: |",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
  const result = judgeGitleaksOrder(broken);
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 1);
  assert.match(
    result.reasons[0],
    /gitleaks-install step is at index 1 but the test-suite step is at index 0/,
  );
  assert.match(result.reasons[0], /silently skip again/);
});

// §4 test 2 (★the P1-2 fix, must show GREEN-before / RED-after): the exact
// review-1 repro -- real `sudo mv` replaced by a no-op echo, target path
// only survives in a trailing run: comment.
test("HYK-365 §4-2 ⓑ regression repro: review-1's install-marker-in-run-comment mutation -- BEFORE this file's bashWords fix it was a silent 7/7 GREEN, AFTER it must be RED", () => {
  const mutatedNoInstall = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        run: |",
    "          echo install-skipped",
    "          # intended install path: /usr/local/bin/gitleaks",
    "",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");

  // "BEFORE": demonstrate the raw-substring shape (what 1R's `run.includes`
  // would have seen) still finds the marker in the comment -- proving this
  // mutation really is invisible to a plain substring search, i.e. review-1's
  // repro is real and would have been a false GREEN under the old detector.
  assert.equal(
    mutatedNoInstall.includes("/usr/local/bin/gitleaks"),
    true,
    "fixture assumption: the marker text is present SOMEWHERE (in the comment) -- a naive substring check would have wrongly passed this",
  );

  // "AFTER": the real (2R, bashWords-based) detector must go RED.
  const result = judgeGitleaksOrder(mutatedNoInstall);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /as executed code \(ⓑ\)/);
  assert.match(
    result.reasons.join(" "),
    /a comment mentioning the path, or a different real install method, does not count/,
  );

  // Restoring the real command (not just the comment) must flip back to GREEN.
  const restored = mutatedNoInstall.replace(
    "          echo install-skipped\n          # intended install path: /usr/local/bin/gitleaks",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
  );
  assert.notEqual(restored, mutatedNoInstall);
  const restoredResult = judgeGitleaksOrder(restored);
  assert.equal(restoredResult.ok, true, restoredResult.reasons.join("; "));
});

test("HYK-365 §4-2 ⓑ: a legitimate but unrecognized install method (apt-get, different path) is judged LOUDLY (RED), never silently accepted", () => {
  const aptInstall = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: Install gitleaks via apt",
    "        run: |",
    "          sudo apt-get update",
    "          sudo apt-get install -y gitleaks",
    "",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
  const result = judgeGitleaksOrder(aptInstall);
  assert.equal(
    result.ok,
    false,
    "an unrecognized install shape must not silently pass",
  );
  assert.match(result.reasons.join(" "), /as executed code \(ⓑ\)/);
});

// §4 test 3 (scan-step continue-on-error contamination) is deliberately NOT
// an automated test in this file. nc-ci-enforce.test.mjs reads its baseline
// via `git show HEAD:.github/workflows/enforce.yml` (tracked commit content,
// by its own explicit design -- see that file's header), not the working
// tree, so mutating the disk copy here would not actually change what that
// file's ENFORCE_YML sees; and its detector function (hasContinueOnError)
// is not exported, so it cannot be imported and driven directly without
// touching that file (forbidden this round, coder-task.md §6). This
// invariant was instead verified once, live, via a temporary commit +
// `git reset --hard` back to the prior commit (both real, both reverted) --
// see coder.md's §4 test 3 section for the full transcript. Baking a
// commit/reset cycle into a permanently-running test would mutate real git
// history on every run, which is a worse cost than the one-time manual
// verification recorded in the result file.

// §4 test 4: legitimate changes stay GREEN (regression list carried from 1R,
// minus the two continue-on-error cases which no longer apply to this file).
test("HYK-365 §4-4: legitimate changes (name, quoting, whitespace, unrelated step, extra job) stay GREEN", () => {
  const variants = {
    "renamed step": [
      "jobs:",
      "  enforce:",
      "    steps:",
      "      - name: Install gitleaks (renamed by a future maintainer)",
      "        run: |",
      "          sudo mv gitleaks /usr/local/bin/gitleaks",
      "",
      "      - name: check test suites",
      "        run: node scripts/check/isolated-suite-runner.mjs",
      "",
      "      - name: gitleaks secret scan",
      "        run: gitleaks detect --source . --redact",
      "",
    ].join("\n"),
    "quoted install path": [
      "jobs:",
      "  enforce:",
      "    steps:",
      "      - name: Install gitleaks",
      "        run: |",
      '          sudo mv gitleaks "/usr/local/bin/gitleaks"',
      "",
      "      - name: check test suites",
      "        run: node scripts/check/isolated-suite-runner.mjs",
      "",
      "      - name: gitleaks secret scan",
      "        run: gitleaks detect --source . --redact",
      "",
    ].join("\n"),
    "unrelated step + extra job": [
      "jobs:",
      "  enforce:",
      "    steps:",
      "      - name: A brand new, entirely unrelated future step",
      "        run: echo unrelated",
      "",
      "      - name: Install gitleaks",
      "        run: |",
      "          sudo mv gitleaks /usr/local/bin/gitleaks",
      "",
      "      - name: check test suites",
      "        run: node scripts/check/isolated-suite-runner.mjs",
      "",
      "      - name: gitleaks secret scan",
      "        run: gitleaks detect --source . --redact",
      "",
      "  docs:",
      "    steps:",
      "      - name: build docs",
      "        run: echo docs",
      "",
    ].join("\n"),
  };
  for (const [label, text] of Object.entries(variants)) {
    const result = judgeGitleaksOrder(text);
    assert.equal(result.ok, true, `${label}: ${result.reasons.join("; ")}`);
  }
});

test("HYK-365: a step referencing the runner in an UNRECOGNIZED shape (e.g. with a flag) is not mistaken for the suite step", () => {
  const withFlag = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: check test suites but with a flag",
    "        run: node scripts/check/isolated-suite-runner.mjs --verbose",
    "",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        run: |",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
  const result = judgeGitleaksOrder(withFlag);
  assert.equal(result.ok, false);
  assert.match(
    result.reasons.join(" "),
    /no step's run: text is the one recognized invocation/,
  );
});
