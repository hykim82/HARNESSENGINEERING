import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runEngineProfileCli } from "./engine-profile-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "engine-profile-cli.mjs");

// HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘⓘ): a synthetic
// config of the exact same shape as production, written to a temp path, so
// HARNESS_ENGINE_PROFILES_PATH injection drives the real CLI entrypoint
// (not a copy) at a non-default path -- the P2-2 self-report contract.
function withSyntheticConfig(fn) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "engine-profile-cli-test-"));
  const file = join(dir, "engine-profiles.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      engines: {
        claude: {
          deliveryMode: "inject",
          homeDirName: null,
          modelFamilyPatterns: {},
          agentMarkerWords: [],
        },
      },
      bannerMarkerPatterns: {
        orcaAdapterAgentMarker: "x",
        seatCensusAgentBanner: "y",
      },
      roles: {
        CODER: { engine: "claude", model: "m-sonnet", effort: "high" },
      },
    }),
    "utf8",
  );
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

// ---- P2-2 (coder-task.md §2 product_scope ⓘⓘ): HARNESS_ENGINE_PROFILES_PATH
// self-report. Default path -> output byte-identical to the tests above
// (no stderr line). Non-default (injected) path -> the path used is
// reported in one line -- on stderr, not stdout, so --json's
// `JSON.parse(stdout.trim())` contract above is never put at risk by this
// report (coder-task.md §2 product_scope ⓘⓘ: "표준 출력 1줄 추가가 기존
// 소비자를 깨면 표준 오류로").

test("CLI end-to-end: default path (no HARNESS_ENGINE_PROFILES_PATH) -- stderr is empty, stdout unchanged", () => {
  const { stdout, stderr, status } = execFileSyncCapture([
    SCRIPT_PATH,
    "resolve",
    "--role",
    "CODER",
    "--json",
  ]);
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout.trim()).engine, "claude");
});

test("CLI end-to-end: HARNESS_ENGINE_PROFILES_PATH set to a non-default file -- the path used is reported on stderr, stdout stays pure parseable JSON", () => {
  withSyntheticConfig((configPath) => {
    const { stdout, stderr, status } = execFileSyncCapture(
      [SCRIPT_PATH, "resolve", "--role", "CODER", "--json"],
      { HARNESS_ENGINE_PROFILES_PATH: configPath },
    );
    assert.equal(status, 0);
    assert.ok(
      stderr.includes(configPath),
      `expected stderr to report the injected path, got: ${JSON.stringify(stderr)}`,
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.engine, "claude");
    assert.match(parsed.model, /sonnet/i);
  });
});

test("CLI end-to-end: HARNESS_ENGINE_PROFILES_PATH set, no --json -- stdout key=value lines unaffected, path report stays on stderr", () => {
  withSyntheticConfig((configPath) => {
    const { stdout, stderr, status } = execFileSyncCapture(
      [SCRIPT_PATH, "resolve", "--role", "CODER"],
      { HARNESS_ENGINE_PROFILES_PATH: configPath },
    );
    assert.equal(status, 0);
    assert.match(stdout, /^engine=claude$/m);
    assert.ok(stderr.includes(configPath));
  });
});

// spawnSync (not execFileSync) -- execFileSync only returns stdout on
// success and discards stderr, which is exactly the channel the P2-2
// self-report writes to; spawnSync hands back both regardless of exit code.
function execFileSyncCapture(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}
