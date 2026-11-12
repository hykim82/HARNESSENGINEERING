import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  selectRelayAdapterForRole,
  ADAPTER_SELECT_REASON,
  ALLOWED_ADAPTER_DIR,
  REQUIRED_ADAPTER_PORTS,
} from "./engine-adapter-registry.mjs";
import {
  ensureSeat,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
} from "./adapters/orca-adapter.mjs";
import { observeSeatCandidates } from "./adapters/seat-candidate-adapter.mjs";
import { ENGINE_PROFILE_LOAD_REASON } from "../check/engine-profile.mjs";

// HYK-153-adapter-registry-1 / HYK-153-fake-engine-2 (coder-task.md §2,
// piece D of HYK-153, 2R contract restoration after review-1 P1-1): these
// tests drive the real production export (selectRelayAdapterForRole), not
// a copy. The picking layer no longer has any opts-based config/import
// override seam -- the ONLY sanctioned way left to steer what a negative
// cell sees is the real, existing HARNESS_ENGINE_PROFILES_PATH env var
// (same convention engine-profile.mjs already documents), pointed at a
// mkdtemp config COPY, exercised through a FRESH child process (see
// probeSelectRelayAdapterForRole below for why a child process, not an
// in-process dynamic import, is required). A cell that needs the registry
// to actually import a module with specific content/shape places a REAL
// file directly inside the real scripts/relay/adapters/ directory of THIS
// worktree, under a fixed, unique synthetic-only prefix, removed again in
// a `finally` (coder-task.md §4 evidence_rule/live_send_ban -- synthetic
// injected config/adapter only, never the real engine-profiles.json).
// ALLOWED_ADAPTER_DIR itself is never test-steerable (fixed at this
// module's own on-disk location, by design) -- the one test that needs a
// REAL symlink/junction escape places it directly inside the real
// scripts/relay/adapters/ directory of THIS worktree (a separate git
// worktree's own checkout, not the shared main repo) and removes it again
// in a `finally`.

const SYNTHETIC_ADAPTER_PREFIX = "hyk153c2-";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(HERE, "engine-adapter-registry.mjs");

// Guard against a previous crashed run's leftovers masquerading as a clean
// start (coder-task.md §2 product_scope ⓘⓘ "시험 시작 시 같은 접두사 잔재가
// 있으면 먼저 실패 원문") -- fails loudly with the real listing, never
// silently continues atop stale synthetic files.
before(() => {
  const leftovers = fs
    .readdirSync(ALLOWED_ADAPTER_DIR)
    .filter((name) => name.startsWith(SYNTHETIC_ADAPTER_PREFIX));
  assert.deepEqual(
    leftovers,
    [],
    `refusing to start -- leftover synthetic adapter file(s) from a previous crashed run still present in ${ALLOWED_ADAPTER_DIR}: ${JSON.stringify(leftovers)}`,
  );
});

// A full, schema-shaped config (same shape engine-profile.mjs's
// validateSchema requires of the REAL config) -- unlike the removed opts
// seam, this goes through the real load-time schema validation every time,
// exactly like production.
function fullTestConfig({ adapterModule, dropAdapterModule = false } = {}) {
  const engineCfg = {
    deliveryMode: "inject",
    homeDirName: null,
    modelFamilyPatterns: {},
    agentMarkerWords: [],
    adapterModule,
  };
  if (dropAdapterModule) delete engineCfg.adapterModule;
  return {
    engines: { testengine: engineCfg },
    roles: { TESTROLE: { engine: "testengine", model: "m", effort: "e" } },
    bannerMarkerPatterns: {
      orcaAdapterAgentMarker: "x",
      seatCensusAgentBanner: "x",
    },
  };
}

function writeTestConfig(dir, opts) {
  const configPath = path.join(dir, "engine-profiles.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(fullTestConfig(opts), null, 2),
    "utf8",
  );
  return configPath;
}

// HYK-153-fake-engine-2: engine-profile.mjs's module-level
// DEFAULT_CONFIG_PATH captures HARNESS_ENGINE_PROFILES_PATH exactly once,
// the first time that module is ever imported in a given process -- this
// test file's own top-level static import already did that once (for the
// positive "4 live roles" test's real default config), so no later
// same-process env change can ever steer it again. A genuinely different
// config therefore needs a genuinely fresh process: this probe writes a
// tiny runner script to mkdtemp and spawns `node <runner>` with the
// desired HARNESS_ENGINE_PROFILES_PATH already set at spawn time, so the
// runner's own (first, only) import of engine-adapter-registry.mjs is
// truly env-driven.
function probeSelectRelayAdapterForRole({ role, configPath }) {
  const runnerDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-registry-probe-"),
  );
  const runnerPath = path.join(runnerDir, "probe.mjs");
  const registryHref = pathToFileURL(REGISTRY_PATH).href;
  fs.writeFileSync(
    runnerPath,
    [
      `const mod = await import(${JSON.stringify(registryHref)});`,
      `const result = await mod.selectRelayAdapterForRole(${JSON.stringify(role)});`,
      "process.stdout.write(JSON.stringify({",
      "  ok: result.ok,",
      "  reasonCode: result.reasonCode ?? null,",
      "  reason: result.reason ?? null,",
      "  engine: result.engine ?? null,",
      "  adapterModule: result.adapterModule ?? null,",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const env = { ...process.env, HARNESS_ENGINE_PROFILES_PATH: configPath };
    const out = execFileSync(process.execPath, [runnerPath], {
      env,
      encoding: "utf8",
    });
    return JSON.parse(out.trim());
  } finally {
    fs.rmSync(runnerDir, { recursive: true, force: true });
  }
}

// Same idea as fullTestConfig/writeTestConfig, but for SEVERAL (role,
// engine, adapterModule) triples at once, each schema-shaped exactly like
// production -- lets one probeSelectRelayAdapterForRoles call drive
// several real adapter files through ONE child process (see that
// function's own header for why batching matters here).
function multiRoleTestConfig(entries) {
  const engines = {};
  const roles = {};
  for (const { role, engineName, adapterModule } of entries) {
    engines[engineName] = {
      deliveryMode: "inject",
      homeDirName: null,
      modelFamilyPatterns: {},
      agentMarkerWords: [],
      adapterModule,
    };
    roles[role] = { engine: engineName, model: "m", effort: "e" };
  }
  return {
    engines,
    roles,
    bannerMarkerPatterns: {
      orcaAdapterAgentMarker: "x",
      seatCensusAgentBanner: "x",
    },
  };
}

function writeMultiRoleTestConfig(dir, entries) {
  const configPath = path.join(dir, "engine-profiles.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(multiRoleTestConfig(entries), null, 2),
    "utf8",
  );
  return configPath;
}

// HYK-153-fake-engine-2 (discovered writing this round's own cells, not a
// pre-existing finding -- see the batched contract-invalid test below for
// the full writeup): a ONE-SHOT child process per real adapter file still
// leaves that file sitting in the real, shared scripts/relay/adapters/
// directory for that whole process's lifetime (Node startup + the entire
// engine-profile.mjs/engine-adapter-registry.mjs import chain, measured
// ~200-400ms) -- long enough to race a concurrently-running, repo-wide
// file-scanning test in a SEPARATE node --test child process. This starts
// ONE PERSISTENT child (a tiny stdin/stdout line-protocol loop) that pays
// that whole startup+import-chain cost exactly ONCE, up front, before any
// case-specific adapter file is ever written -- each subsequent role
// lookup only needs its own one small file's dynamic import() (observed:
// low single-digit ms), so the caller can write that ONE file immediately
// before asking and delete it immediately after the answer comes back,
// shrinking the real-file exposure window by roughly two orders of
// magnitude versus a fresh process per case.
function startRegistryProbeServer(configPath) {
  const runnerDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-registry-probe-server-"),
  );
  const runnerPath = path.join(runnerDir, "server.mjs");
  const registryHref = pathToFileURL(REGISTRY_PATH).href;
  fs.writeFileSync(
    runnerPath,
    [
      `const mod = await import(${JSON.stringify(registryHref)});`,
      "const { createInterface } = await import('node:readline');",
      "const rl = createInterface({ input: process.stdin });",
      "rl.on('line', async (line) => {",
      "  const role = JSON.parse(line);",
      "  const result = await mod.selectRelayAdapterForRole(role);",
      "  process.stdout.write(",
      "    JSON.stringify({",
      "      ok: result.ok,",
      "      reasonCode: result.reasonCode ?? null,",
      "      reason: result.reason ?? null,",
      "    }) + '\\n',",
      "  );",
      "});",
      "process.stdout.write('READY\\n');",
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawn(process.execPath, [runnerPath], {
    env: { ...process.env, HARNESS_ENGINE_PROFILES_PATH: configPath },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = createInterface({ input: child.stdout });
  const pendingLines = [];
  const waiters = [];
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  });
  function nextLine() {
    if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
    return new Promise((resolve) => waiters.push(resolve));
  }
  const readyPromise = nextLine().then((line) => {
    if (line !== "READY") {
      throw new Error(`registry probe server did not start cleanly: ${line}`);
    }
  });
  return {
    ready: readyPromise,
    async ask(role) {
      child.stdin.write(`${JSON.stringify(role)}\n`);
      return JSON.parse(await nextLine());
    },
    close() {
      rl.close();
      child.stdin.end();
      child.kill();
      fs.rmSync(runnerDir, { recursive: true, force: true });
    },
  };
}

// ---- positive: production wiring, all 4 live roles ----

test("selectRelayAdapterForRole: all 4 live roles (CODER/REVIEW/VERIFY/PM) resolve to the real orca-relay-adapter with port-for-port === identity, never a copy/wrapper", async () => {
  for (const role of ["CODER", "REVIEW", "VERIFY", "PM"]) {
    const selection = await selectRelayAdapterForRole(role);
    assert.equal(selection.ok, true, JSON.stringify(selection));
    assert.equal(selection.engine, "claude");
    assert.equal(selection.role, role);
    assert.equal(
      selection.adapterModule,
      "scripts/relay/adapters/orca-relay-adapter.mjs",
    );
    assert.equal(selection.adapter.ensureSeat, ensureSeat);
    assert.equal(
      selection.adapter.observeSeatCandidates,
      observeSeatCandidates,
    );
    assert.equal(selection.adapter.deliverTask, deliverTask);
    assert.equal(
      selection.adapter.collectCompletionSignals,
      collectCompletionSignals,
    );
    assert.equal(selection.adapter.teardownSeat, teardownSeat);
    assert.equal(typeof selection.execFn, "function");
  }
});

test("REQUIRED_ADAPTER_PORTS names exactly the 5 relayStep ports (ensureSeat/observeSeatCandidates/deliverTask/collectCompletionSignals/teardownSeat)", () => {
  assert.deepEqual(
    [...REQUIRED_ADAPTER_PORTS].sort(),
    [
      "collectCompletionSignals",
      "deliverTask",
      "ensureSeat",
      "observeSeatCandidates",
      "teardownSeat",
    ].sort(),
  );
});

// ---- negative ①: ROLE_PROFILE_MISSING (no seam involved -- unchanged) ----

test("selectRelayAdapterForRole: a role absent from config.roles is ROLE_PROFILE_MISSING, not a thrown exception or a guessed default", async () => {
  const selection = await selectRelayAdapterForRole("NOT-A-REAL-ROLE");
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ROLE_PROFILE_MISSING,
  );
  assert.match(selection.reason, /no role profile/);
});

// ---- negative: adapterModule absent from the engine config ----
//
// REVIEW-r1.md §1 P1-1 (the seam this round removes) let a RAW, unvalidated
// profiles object reach the registry directly, bypassing engine-profile.
// mjs's own schema validation entirely -- that is exactly how the original
// cell here reached the registry's OWN defensive ADAPTER_MODULE_MISSING
// branch. Through the real, schema-enforced loader (the only sanctioned
// path left), every engine key present in config.engines is REQUIRED to
// have a valid adapterModule before loadEngineProfiles() ever returns
// (scripts/check/engine-profile.mjs's validateEngines) -- so this exact
// shape is rejected at CONFIG_SCHEMA_INVALID, one layer earlier, and the
// registry's own ADAPTER_MODULE_MISSING reasonCode (kept, unchanged, as
// defense-in-depth per coder-task.md §2 deviation_rule) is now unreachable
// through any config a real caller could ever hand it. This is confirmed
// here, not left unmeasured -- matching review-1's own base/HEAD probe
// table (REVIEW-r1.md §2 ⓐ, row c1).
test("selectRelayAdapterForRole (env path): a config copy whose engine omits the REQUIRED adapterModule key is rejected at load time (CONFIG_SCHEMA_INVALID) -- the registry's own ADAPTER_MODULE_MISSING branch is defense-in-depth, unreachable through the real schema-enforced loader", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-config-nomodule-"),
  );
  try {
    const configPath = writeTestConfig(dir, { dropAdapterModule: true });
    const result = probeSelectRelayAdapterForRole({
      role: "TESTROLE",
      configPath,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
    );
    assert.match(result.reason, /adapterModule is required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- negative: adapterModule path algebra ("..") ----
//
// Same shape as above: engine-profile.mjs's ADAPTER_MODULE_NAME_RE already
// rejects any value containing "..", an absolute path, a backslash, or a
// subfolder at load time -- so through the real loader, only a REAL
// symlink/junction (next test) can still reach the registry's own
// real-filesystem ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR check. REVIEW-r1.md §2
// ⓐ's own probe table (rows c3-c7) found the same thing.
test("selectRelayAdapterForRole (env path): an adapterModule value containing '..' is rejected at load time (CONFIG_SCHEMA_INVALID) by the naming-pattern regex -- the registry's own path-algebra-only ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR branch is unreachable the same way", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyk153c2-config-dotdot-"));
  try {
    const configPath = writeTestConfig(dir, {
      adapterModule: "scripts/relay/adapters/../orca-adapter.mjs",
    });
    const result = probeSelectRelayAdapterForRole({
      role: "TESTROLE",
      configPath,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
    );
    assert.match(result.reason, /must match/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- negative: ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR (real symlink/junction escape, Windows real fs) ----

test("selectRelayAdapterForRole (env path, via a persistent probe server -- see startRegistryProbeServer's header): a REAL symlink placed directly inside scripts/relay/adapters/ that resolves outside it on disk is ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR (junction/link escape, 실경로 -- not just the naming-pattern string check)", async (t) => {
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153-adapter-registry-escape-target-"),
  );
  const outsideFile = path.join(outsideDir, "escape-target.mjs");
  fs.writeFileSync(
    outsideFile,
    "export function createRelayAdapter() { return null; }\n",
    "utf8",
  );
  const linkName = `${SYNTHETIC_ADAPTER_PREFIX}junction-escape-relay-adapter.mjs`;
  const linkPath = path.join(ALLOWED_ADAPTER_DIR, linkName);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-config-symlink-"),
  );
  // The config (pointing TESTROLE at this fixed linkName) is written and
  // the probe server started up front -- the symlink itself is the only
  // thing this test places in the real, scanned directory, and only for
  // the brief window between creating it and getting the server's answer.
  const configPath = writeTestConfig(dir, {
    adapterModule: `scripts/relay/adapters/${linkName}`,
  });
  const server = startRegistryProbeServer(configPath);
  let linkCreated = false;
  try {
    await server.ready;
    try {
      fs.symlinkSync(outsideFile, linkPath, "file");
      linkCreated = true;
    } catch (err) {
      // Honesty contract (coder-task.md §4 universal_claim_discipline):
      // creating a real file symlink on Windows needs
      // SeCreateSymbolicLinkPrivilege (admin/Developer Mode) -- if this
      // account/session does not have it, this cell is UNMEASURED, not
      // assumed-green. Skip with the real error attached, do not fabricate
      // a pass.
      t.skip(
        `못쟀다 -- fs.symlinkSync failed on this machine/account (${err.code ?? err.message}), real junction/link escape not measured here`,
      );
      return;
    }
    let result;
    try {
      result = await server.ask("TESTROLE");
    } finally {
      fs.rmSync(linkPath, { force: true });
      linkCreated = false;
    }
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      ADAPTER_SELECT_REASON.ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR,
      `expected a real symlink resolving outside ${ALLOWED_ADAPTER_DIR} to be caught by the real-path containment check, got: ${JSON.stringify(result)}`,
    );
  } finally {
    server.close();
    if (linkCreated) fs.rmSync(linkPath, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- negative: ADAPTER_MODULE_IMPORT_FAILED ----

test("selectRelayAdapterForRole (env path): an adapterModule naming a file that does not exist is ADAPTER_MODULE_IMPORT_FAILED (naming-pattern-valid, but the dynamic import itself fails)", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-config-missingfile-"),
  );
  try {
    const configPath = writeTestConfig(dir, {
      adapterModule: `scripts/relay/adapters/${SYNTHETIC_ADAPTER_PREFIX}does-not-exist-relay-adapter.mjs`,
    });
    const result = probeSelectRelayAdapterForRole({
      role: "TESTROLE",
      configPath,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      ADAPTER_SELECT_REASON.ADAPTER_MODULE_IMPORT_FAILED,
    );
    assert.match(result.reason, /importing adapterModule/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- negative: ADAPTER_MODULE_IMPORT_FAILED (real throw) + ADAPTER_CONTRACT_INVALID (several sub-shapes), each via a REAL file, one-at-a-time against a persistent probe server ----
//
// Discovered while writing this round's own cells (not a pre-existing
// finding): engine-name-literal.test.mjs's own repo-wide scanner
// (scripts/check/engine-name-literal.test.mjs's listScanTargets/scanRepo)
// walks scripts/ with a plain readdirSync, snapshotting file NAMES, then
// readFileSync's each one -- a transient synthetic *-relay-adapter.mjs file
// that exists at snapshot time but is removed (by this file's own cleanup,
// running concurrently in a SEPARATE node --test child process) before the
// scanner gets to read it throws ENOENT and fails that unrelated test
// (reproduced directly: `node --test` with multiple file args runs them
// with real cross-process concurrency by default). A fresh process PER
// case (5 separate spawns) failed repeatedly; merging into one SHORT-LIVED
// spawn per batch still failed in 2 of 5 repeated runs (each spawn's whole
// Node-startup-plus-import-chain lifetime, ~200-400ms, is still long
// enough to collide with the scanner's own ~150-350ms pass). `--test-
// concurrency=1` reproduces 0 failures, confirming the diagnosis.
// engine-name-literal.test.mjs is not in this round's allowed file list
// (coder-task.md §2 product_scope), so the fix lives entirely on this
// side: startRegistryProbeServer above pays the Node-startup-plus-import
// cost exactly ONCE, up front, with no case-specific adapter file on disk
// yet -- each case below then writes its own real file immediately before
// asking that already-warm server and deletes it immediately after the
// answer returns, so each individual file's real-disk lifetime is bounded
// by one small dynamic import() (observed: low single-digit ms) rather
// than a whole process lifetime, roughly two orders of magnitude shorter
// than the one-spawn-per-case version. Residual risk and a scanner-side
// hardening suggestion (tolerate ENOENT as "skip", not "fail") are
// recorded in this round's result file for the responsible party, since
// this file cannot change the scanner itself.
// Data for the batched contract-invalid/import-failed test below, hoisted
// to module scope purely to keep that test under quality-check's
// max-lines-per-function ceiling -- not reused anywhere else.
const CONTRACT_BATCH_CASES = [
  {
    suffix: "throw-on-import",
    role: "THROWIMPORTROLE",
    engine: "throwimportengine",
    content: "throw new Error('synthetic import failure');\n",
    reasonCode: ADAPTER_SELECT_REASON.ADAPTER_MODULE_IMPORT_FAILED,
    match: null,
  },
  {
    suffix: "no-export",
    role: "NOEXPORTROLE",
    engine: "noexportengine",
    content: "export const notCreateRelayAdapter = true;\n",
    reasonCode: ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
    match: /does not export createRelayAdapter/,
  },
  {
    suffix: "missing-port",
    role: "MISSINGPORTROLE",
    engine: "missingportengine",
    content: [
      "export function createRelayAdapter() {",
      "  return {",
      "    adapter: {",
      "      ensureSeat: () => {},",
      "      observeSeatCandidates: () => {},",
      "      deliverTask: () => {},",
      "      collectCompletionSignals: () => {},",
      "      // teardownSeat intentionally missing",
      "    },",
      "    execFn: () => {},",
      "  };",
      "}",
      "",
    ].join("\n"),
    reasonCode: ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
    match: /missing required port 'teardownSeat'/,
  },
  {
    suffix: "bad-execfn",
    role: "BADEXECFNROLE",
    engine: "badexecfnengine",
    content: [
      "export function createRelayAdapter() {",
      "  return {",
      "    adapter: {",
      "      ensureSeat: () => {},",
      "      observeSeatCandidates: () => {},",
      "      deliverTask: () => {},",
      "      collectCompletionSignals: () => {},",
      "      teardownSeat: () => {},",
      "    },",
      "    execFn: 'not-a-function',",
      "  };",
      "}",
      "",
    ].join("\n"),
    reasonCode: ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
    match: /missing an 'execFn' function/,
  },
  {
    suffix: "create-throws",
    role: "CREATETHROWSROLE",
    engine: "createthrowsengine",
    content: [
      "export function createRelayAdapter() {",
      "  throw new Error('synthetic createRelayAdapter failure');",
      "}",
      "",
    ].join("\n"),
    reasonCode: ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
    match: /createRelayAdapter threw/,
  },
];

test("selectRelayAdapterForRole (env path, one real file at a time against a persistent probe server to minimize the real scripts/relay/adapters/ exposure window): import-throws is ADAPTER_MODULE_IMPORT_FAILED, and no-export/missing-port/bad-execFn/createRelayAdapter-throws are each ADAPTER_CONTRACT_INVALID", async () => {
  const CASES = CONTRACT_BATCH_CASES;
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-config-contract-batch-"),
  );
  // The config (role -> engine -> adapterModule PATH) is written up front --
  // it lives in mkdtemp, never in the real, scanned scripts/relay/adapters/
  // directory, so it carries none of this test's race risk. Only the real
  // adapter FILES named below are written one at a time, below.
  const entries = CASES.map(({ suffix, role, engine }) => ({
    role,
    engineName: engine,
    adapterModule: `scripts/relay/adapters/${SYNTHETIC_ADAPTER_PREFIX}${suffix}-relay-adapter.mjs`,
  }));
  const configPath = writeMultiRoleTestConfig(dir, entries);
  const server = startRegistryProbeServer(configPath);
  try {
    await server.ready;
    for (const c of CASES) {
      const fileName = `${SYNTHETIC_ADAPTER_PREFIX}${c.suffix}-relay-adapter.mjs`;
      const absPath = path.join(ALLOWED_ADAPTER_DIR, fileName);
      fs.writeFileSync(absPath, c.content, "utf8");
      let result;
      try {
        result = await server.ask(c.role);
      } finally {
        fs.rmSync(absPath, { force: true });
      }
      assert.equal(result.ok, false, `${c.role}: ${JSON.stringify(result)}`);
      assert.equal(result.reasonCode, c.reasonCode, c.role);
      if (c.match) assert.match(result.reason, c.match);
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- load-layer errors pass through verbatim (no default fallback) ----

test("selectRelayAdapterForRole (env path): HARNESS_ENGINE_PROFILES_PATH pointing at a file that does not exist is CONFIG_FILE_UNREADABLE, passed through verbatim, never papered over with a default adapter", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153c2-config-missing-"),
  );
  try {
    const configPath = path.join(dir, "does-not-exist.json");
    const result = probeSelectRelayAdapterForRole({
      role: "TESTROLE",
      configPath,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_UNREADABLE,
    );
    assert.match(result.reason, /loading engine profiles failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
