// node-target-version: single source of truth for "which Node major version
// is this repo targeting" (HYK-417 §3-1).
//
// Before this file, the only place the target Node version was written down
// was `.github/workflows/enforce.yml`'s `node-version: 20` -- package.json
// had no `engines.node` at all (confirmed: `grep engines package.json` ->
// no match, before this commit). That meant nothing machine-checked that
// the workflow's pinned version and "the version this repo actually
// targets" stayed the same value; a workflow edit could silently drift from
// what everyone assumed the target was, with no test anywhere to catch it.
//
// This file adds `engines.node` in package.json as the declared target, and
// `checkNodeVersionDrift` below compares its major version against the
// workflow file's `node-version:` value. node-target-version.test.mjs runs
// this against the REAL repo files (not just fixtures) as part of `npm
// test`, so an edit to either side that breaks the match turns the local
// suite red before it ever reaches CI.
//
// Scope note: this compares MAJOR versions only (e.g. "20"), not exact
// patch versions. `actions/setup-node` with `node-version: 20` resolves to
// whatever the latest 20.x release is at run time (observed: 20.20.2 on
// 2026-09-03) -- pinning an exact patch here would go stale on its own and
// falsely drift every time GitHub ships a new 20.x patch. Major-version
// drift (e.g. someone bumping the workflow to `node-version: 22`) is the
// failure mode this guards against.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// Extracts the leading major version number from a semver-range-ish string
// such as "20.x", "20", "^20.10.0", ">=20 <21". Returns null if no leading
// digit run is found (fail-closed callers treat null as "undeclared").
export function majorFromRange(range) {
  if (typeof range !== "string") return null;
  const match = range.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

// Reads `engines.node` out of a package.json TEXT (not a parsed object, so
// callers can hand this raw file content read from disk or from a fixture
// string without a JSON.parse round-trip at the call site).
export function resolveEnginesMajor(packageJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch (err) {
    return {
      major: null,
      reason: `package.json did not parse as JSON (${err.message})`,
    };
  }
  const raw = pkg.engines?.node;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { major: null, reason: "package.json has no engines.node declared" };
  }
  const major = majorFromRange(raw);
  if (major === null) {
    return {
      major: null,
      reason: `engines.node value "${raw}" has no parseable major version`,
    };
  }
  return { major, raw };
}

// Reads the FIRST `node-version:` value out of a GitHub Actions workflow
// YAML text. Intentionally a narrow line-regex, not a YAML parser -- adding
// a YAML-parsing dependency is out of scope (coder-task.md §0: no new
// dependencies), and this repo's workflow file only ever sets
// `node-version` once (enforce.yml, actions/setup-node step).
export function resolveWorkflowMajor(workflowYamlText) {
  const match = workflowYamlText.match(/node-version:\s*["']?(\d+)/);
  if (!match) {
    return {
      major: null,
      reason: "no node-version: line found in workflow YAML",
    };
  }
  return { major: Number(match[1]), raw: match[0] };
}

// Core drift check: package.json's declared engines.node major must equal
// enforce.yml's node-version major. Fail-closed -- a missing/unparseable
// value on EITHER side is `ok: false`, not silently skipped, because a
// single source of truth that can silently go undeclared again is not a
// single source of truth (that undeclared-since-day-one state is exactly
// what this task found).
export function checkNodeVersionDrift({
  cwd,
  readFile = readFileSync,
  packageJsonPath = "package.json",
  workflowPath = ".github/workflows/enforce.yml",
} = {}) {
  const packageJsonText = readFile(join(cwd, packageJsonPath), "utf8");
  const workflowYamlText = readFile(join(cwd, workflowPath), "utf8");

  const engines = resolveEnginesMajor(packageJsonText);
  if (engines.major === null) {
    return {
      ok: false,
      reason: `node-target-version: ${engines.reason}`,
      enginesMajor: null,
      workflowMajor: null,
    };
  }

  const workflow = resolveWorkflowMajor(workflowYamlText);
  if (workflow.major === null) {
    return {
      ok: false,
      reason: `node-target-version: ${workflow.reason}`,
      enginesMajor: engines.major,
      workflowMajor: null,
    };
  }

  if (engines.major !== workflow.major) {
    return {
      ok: false,
      reason:
        `node-target-version: DRIFT -- package.json engines.node ("${engines.raw}" -> major ${engines.major}) ` +
        `does not match ${workflowPath}'s node-version (major ${workflow.major})`,
      enginesMajor: engines.major,
      workflowMajor: workflow.major,
    };
  }

  return {
    ok: true,
    reason: `node-target-version: package.json engines.node and ${workflowPath} both declare Node ${engines.major}`,
    enginesMajor: engines.major,
    workflowMajor: workflow.major,
  };
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/node-target-version.mjs");
if (invokedDirectly) {
  const result = checkNodeVersionDrift({ cwd: repoRoot() });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
