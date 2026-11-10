import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runEngineProfileCli } from "./engine-profile-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "engine-profile-cli.mjs");

test("runEngineProfileCli: resolve --role CODER --json returns the real config's profile", () => {
  const r = runEngineProfileCli(["resolve", "--role", "CODER", "--json"]);
  assert.equal(r.ok, true);
  assert.equal(r.profile.engine, "claude");
  assert.match(r.profile.model, /sonnet/i);
  assert.equal(r.profile.effort, "high");
});

test("runEngineProfileCli: resolve --role REVIEW resolves to claude (matches live seat-launch-registry, HYK-153 piece B fix)", () => {
  const r = runEngineProfileCli(["resolve", "--role", "REVIEW"]);
  assert.equal(r.ok, true);
  assert.equal(r.profile.engine, "claude");
  assert.match(r.profile.model, /opus/i);
});

test("runEngineProfileCli: an unknown role is a clean failure, not a thrown exception or guessed default", () => {
  const r = runEngineProfileCli(["resolve", "--role", "NOT_A_ROLE"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no profile for role/);
});

test("runEngineProfileCli: missing --role is a clean failure", () => {
  const r = runEngineProfileCli(["resolve"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing --role/);
});

test("runEngineProfileCli: an unknown command is a clean failure", () => {
  const r = runEngineProfileCli(["bogus"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown command/);
});

test("CLI end-to-end: resolve --role CODER --json prints parseable JSON on stdout, exit 0", () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT_PATH, "resolve", "--role", "CODER", "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.engine, "claude");
});

test("CLI end-to-end: resolve --role CODER (no --json) prints key=value lines, exit 0", () => {
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT_PATH, "resolve", "--role", "CODER"],
    { encoding: "utf8" },
  );
  assert.match(stdout, /^engine=claude$/m);
  assert.match(stdout, /^effort=high$/m);
});

test("CLI end-to-end: an unknown role exits non-zero with a reason on stderr", () => {
  let thrown = null;
  try {
    execFileSync(
      process.execPath,
      [SCRIPT_PATH, "resolve", "--role", "NOT_A_ROLE"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "unknown role must not exit 0");
  assert.equal(thrown.status, 2);
  assert.equal(thrown.stdout, "");
  assert.match(thrown.stderr, /no profile for role/);
});
