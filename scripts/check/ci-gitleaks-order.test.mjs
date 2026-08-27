// HYK-365 3R: contract test for ci-gitleaks-order.mjs -- pins ONLY that
// enforce.yml keeps gitleaks installed BEFORE the test suite runs (ⓐ
// order). The install-REALNESS check (does the install step actually
// execute, not just mention the target path) that 2R added is deliberately
// REMOVED this round (책임자 판정 2026-08-27, 갈래 ⓐ) -- see
// ci-gitleaks-order.mjs's module header for the full separation rationale
// and HYK-368 (the new observation-based layer that owns that concern now).
// continue-on-error remains not-this-file's-concern (2R downgrade, owned by
// nc-ci-enforce.test.mjs:145).
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
// jobs.enforce.steps sequence, used for the break/no-break scenarios below
// so those tests never depend on the real file's exact text drifting for
// unrelated reasons.
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

test("HYK-365 ⑴: the REAL enforce.yml passes the one remaining invariant (ⓐ order)", () => {
  const result = judgeGitleaksOrder(realWorkflowText());
  assert.equal(result.ok, true, result.reasons.join("; "));
});

// §4 test 1: order violation -> RED (unchanged shape since 1R).
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

// §4 test 2: legitimate changes stay GREEN (regression list carried since
// 1R/2R -- name/quoting/whitespace/unrelated-step/extra-job).
test("HYK-365 §4-2: legitimate changes (name, quoting, whitespace, unrelated step, extra job) stay GREEN", () => {
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

// §4 test 3 (★the required "separation is not a silent feature loss"
// proof): review-1's exact original repro -- the real `sudo mv` replaced by
// a no-op echo, the target path surviving only in a trailing run: comment.
// In 2R this was RED (the whole point of that round's REALNESS check). In
// 3R it is intentionally GREEN again -- not because the underlying gap
// reopened silently, but because this file no longer claims to verify
// installation realness at all; that concern now lives at HYK-368's
// observation layer. This test exists specifically so that fact is visible
// and tested, not just asserted in prose.
test("HYK-365 §4-3 (separation is not silent loss): review-1's install-marker-in-run-comment mutation is GREEN again in 3R -- REALNESS moved to HYK-368, not lost", () => {
  const installMentionOnlyInComment = [
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

  const result = judgeGitleaksOrder(installMentionOnlyInComment);
  assert.equal(
    result.ok,
    true,
    `this mutation must be GREEN in 3R (order-only) -- if it isn't, REALNESS checking crept back in: ${result.reasons.join("; ")}`,
  );
});

// §4 test 4: the residual P2-1 shape (review-2) -- an install method that
// never mentions the target path at all (apt-get, installing wherever the
// package manager puts the binary) still cannot be ORDER-checked, because
// order-location shares the same substring anchor. This is an accepted,
// documented limitation (module header), NOT something this round tries to
// fix further (coder-task.md 3R §6 explicitly forbids making the
// install-detection "smarter") -- the requirement is only that it fails
// LOUDLY, never silently passes.
test("HYK-365 §4-4 (P2-1, accepted limitation): an apt-get-style install that never mentions the target path still cannot be ORDER-checked -- loud RED, never a silent pass", () => {
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
  assert.match(
    result.reasons.join(" "),
    /this contract only orders that step against the suite step/,
  );
  assert.match(result.reasons.join(" "), /HYK-368/);
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
