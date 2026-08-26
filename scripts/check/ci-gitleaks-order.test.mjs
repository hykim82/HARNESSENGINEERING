// HYK-365 라′: contract test for ci-gitleaks-order.mjs -- pins that
// enforce.yml keeps gitleaks installed BEFORE the test suite runs (ⓐ), the
// install step tolerates its own failure (ⓑ), and the actual scan step does
// not (ⓒ). See ci-gitleaks-order.mjs's own header for why this is a
// structural step-array parse, not a known-name list walk.
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
// jobs.enforce.steps sequence (HYK-365-fixed order), used for the
// break/no-break scenarios below so those tests never depend on the real
// file's exact text drifting for unrelated reasons.
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
    "        continue-on-error: true",
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
  assert.equal(steps[1].continueOnError, true);
  assert.equal(
    steps[2].run.trim(),
    "node scripts/check/isolated-suite-runner.mjs",
  );
  assert.equal(steps[3].continueOnError, false);
});

test("HYK-365 ⑴/⑶ⓐⓑⓒ: the REAL enforce.yml passes all three invariants", () => {
  const result = judgeGitleaksOrder(realWorkflowText());
  assert.equal(result.ok, true, result.reasons.join("; "));
});

test("HYK-365 ⑷ counterfactual: install step moved back AFTER the suite -> RED naming ⓐ, indices, and the consequence", () => {
  const broken = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        continue-on-error: true",
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

test("HYK-365 ⑷ counterfactual: install step missing continue-on-error -> RED naming ⓑ and the widened blast radius", () => {
  const broken = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        run: |",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
    "",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
  const result = judgeGitleaksOrder(broken);
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /missing continue-on-error: true \(ⓑ\)/);
  assert.match(result.reasons[0], /widening blast radius/);
});

test("HYK-365 ⑷ counterfactual: continue-on-error added to the SCAN step -> RED naming ⓒ and the weakened gate", () => {
  const broken = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        continue-on-error: true",
    "        run: |",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
    "",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: gitleaks secret scan",
    "        continue-on-error: true",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
  const result = judgeGitleaksOrder(broken);
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /ⓒ forbids this/);
  assert.match(result.reasons[0], /silently weakening enforcement/);
});

test("HYK-365 ⑸: an unrelated NEW step added anywhere does not turn this contract red (GREEN stays GREEN)", () => {
  const withExtraStep = [
    "jobs:",
    "  enforce:",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    "",
    "      - name: A brand new, entirely unrelated future step",
    "        run: echo unrelated",
    "",
    "      - name: Install gitleaks (pinned, checksum-verified)",
    "        continue-on-error: true",
    "        run: |",
    "          sudo mv gitleaks /usr/local/bin/gitleaks",
    "",
    "      - name: Another brand new step, this time between install and suite",
    "        run: echo also unrelated",
    "",
    "      - name: check test suites",
    "        run: node scripts/check/isolated-suite-runner.mjs",
    "",
    "      - name: gitleaks secret scan",
    "        run: gitleaks detect --source . --redact",
    "",
  ].join("\n");
  const result = judgeGitleaksOrder(withExtraStep);
  assert.equal(result.ok, true, result.reasons.join("; "));
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
    "        continue-on-error: true",
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
