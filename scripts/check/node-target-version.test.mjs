import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  majorFromRange,
  resolveEnginesMajor,
  resolveWorkflowMajor,
  checkNodeVersionDrift,
} from "./node-target-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// --- majorFromRange ---

test("majorFromRange: plain major number", () => {
  assert.equal(majorFromRange("20"), 20);
});

test("majorFromRange: x-range", () => {
  assert.equal(majorFromRange("20.x"), 20);
});

test("majorFromRange: caret range", () => {
  assert.equal(majorFromRange("^20.10.0"), 20);
});

test("majorFromRange: no digits -> null", () => {
  assert.equal(majorFromRange("latest"), null);
});

test("majorFromRange: non-string -> null", () => {
  assert.equal(majorFromRange(undefined), null);
});

// --- resolveEnginesMajor ---

test("resolveEnginesMajor: declared engines.node -> major parsed", () => {
  const result = resolveEnginesMajor(
    JSON.stringify({ engines: { node: "20.x" } }),
  );
  assert.equal(result.major, 20);
});

test("resolveEnginesMajor: no engines field -> null with reason", () => {
  const result = resolveEnginesMajor(JSON.stringify({ name: "x" }));
  assert.equal(result.major, null);
  assert.match(result.reason, /no engines\.node declared/);
});

test("resolveEnginesMajor: invalid JSON -> null with reason", () => {
  const result = resolveEnginesMajor("{not json");
  assert.equal(result.major, null);
  assert.match(result.reason, /did not parse as JSON/);
});

// --- resolveWorkflowMajor ---

test("resolveWorkflowMajor: node-version line found", () => {
  const result = resolveWorkflowMajor(
    "      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n",
  );
  assert.equal(result.major, 20);
});

test("resolveWorkflowMajor: quoted node-version value", () => {
  const result = resolveWorkflowMajor('node-version: "20"');
  assert.equal(result.major, 20);
});

test("resolveWorkflowMajor: no node-version line -> null with reason", () => {
  const result = resolveWorkflowMajor("name: enforce\non: [push]\n");
  assert.equal(result.major, null);
  assert.match(result.reason, /no node-version:/);
});

// --- checkNodeVersionDrift (fixtures) ---

function fixtureReadFile(files) {
  return (path) => {
    const key = Object.keys(files).find((k) =>
      path.replace(/\\/g, "/").endsWith(k),
    );
    if (!key)
      throw new Error(`fixtureReadFile: no fixture registered for ${path}`);
    return files[key];
  };
}

test("checkNodeVersionDrift: matching majors -> ok true", () => {
  const result = checkNodeVersionDrift({
    cwd: "/repo",
    readFile: fixtureReadFile({
      "package.json": JSON.stringify({ engines: { node: "20.x" } }),
      "enforce.yml": "node-version: 20\n",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.enginesMajor, 20);
  assert.equal(result.workflowMajor, 20);
});

test("checkNodeVersionDrift: MISMATCHED majors -> ok false, DRIFT (this is the drift-detection RED case)", () => {
  const result = checkNodeVersionDrift({
    cwd: "/repo",
    readFile: fixtureReadFile({
      "package.json": JSON.stringify({ engines: { node: "20.x" } }),
      "enforce.yml": "node-version: 22\n",
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /DRIFT/);
  assert.equal(result.enginesMajor, 20);
  assert.equal(result.workflowMajor, 22);
});

test("checkNodeVersionDrift: engines.node undeclared -> ok false (fail-closed, not silently skipped)", () => {
  const result = checkNodeVersionDrift({
    cwd: "/repo",
    readFile: fixtureReadFile({
      "package.json": JSON.stringify({ name: "x" }),
      "enforce.yml": "node-version: 20\n",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.enginesMajor, null);
});

test("checkNodeVersionDrift: workflow node-version missing -> ok false", () => {
  const result = checkNodeVersionDrift({
    cwd: "/repo",
    readFile: fixtureReadFile({
      "package.json": JSON.stringify({ engines: { node: "20.x" } }),
      "enforce.yml": "name: enforce\n",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.workflowMajor, null);
});

// --- checkNodeVersionDrift against the REAL repo files ---
//
// This is the actual drift gate this task exists to add (HYK-417 §3-1):
// package.json's engines.node and .github/workflows/enforce.yml's
// node-version must agree, checked against the real files on every `npm
// test` run (scripts/check/*.test.mjs is auto-collected by
// isolated-suite-runner.mjs's TEST_DIRS, so this runs under the CI-
// canonical `npm test` command with no separate wiring needed). Edit either
// file so the majors disagree and this test alone goes red.
test("checkNodeVersionDrift: REAL repo -- package.json engines.node and enforce.yml node-version agree", () => {
  const result = checkNodeVersionDrift({ cwd: REPO_ROOT });
  assert.equal(result.ok, true, result.reason);
});
