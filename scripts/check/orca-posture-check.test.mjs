import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  sha256Hex,
  secretFingerprint,
  containsFingerprint,
  checkLinearReconnect,
  checkAutomationsPresent,
  checkTerminalHistorySecretScan,
  runOrcaPostureCheck,
} from "./orca-posture-check.mjs";

const WS_PATH = "/home/.orca/linear-workspaces.json";
const TOKENS_DIR = "/home/.orca/linear-tokens";
const DB_PATH = "/appdata/orca/orchestration.db";
const HIST_DIR = "/appdata/orca/terminal-history";

function existsOnly(present) {
  return (p) => present.includes(p);
}

// ---- secretFingerprint / containsFingerprint --------------------------------

test("(1) secretFingerprint is null for empty/non-string input", () => {
  assert.equal(secretFingerprint(""), null);
  assert.equal(secretFingerprint(undefined), null);
});

test("(2) secretFingerprint never echoes the raw value", () => {
  const fp = secretFingerprint("synthetic-secret-abc123");
  assert.equal(fp.length, "synthetic-secret-abc123".length);
  assert.equal(fp.sha256, sha256Hex("synthetic-secret-abc123"));
  assert.equal(JSON.stringify(fp).includes("synthetic-secret-abc123"), false);
});

test("(3) containsFingerprint finds a substring match", () => {
  const fp = secretFingerprint("XYZ-TOKEN-1");
  assert.equal(
    containsFingerprint("prefix ... XYZ-TOKEN-1 ... suffix", fp),
    true,
  );
});

test("(4) containsFingerprint returns false with no match", () => {
  const fp = secretFingerprint("XYZ-TOKEN-1");
  assert.equal(containsFingerprint("nothing sensitive here at all", fp), false);
});

test("(5) containsFingerprint returns false when haystack shorter than fingerprint", () => {
  const fp = secretFingerprint("a-fairly-long-synthetic-token");
  assert.equal(containsFingerprint("short", fp), false);
});

test("(6) containsFingerprint returns false for null fingerprint", () => {
  assert.equal(containsFingerprint("anything", null), false);
});

// ---- checkLinearReconnect ----------------------------------------------------

test("(7) linear-reconnect: both paths absent -> OK", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([]),
  });
  assert.equal(r.status, "OK");
});

test("(8) linear-reconnect: tokensDir has files -> WARN", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([TOKENS_DIR]),
    readdirFn: () => ["token-abc.json"],
  });
  assert.equal(r.status, "WARN");
});

test("(9) linear-reconnect: tokensDir exists but empty, workspaces absent -> OK", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([TOKENS_DIR]),
    readdirFn: () => [],
  });
  assert.equal(r.status, "OK");
});

test("(10) linear-reconnect: workspaces=[] -> OK", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([WS_PATH]),
    readdirFn: () => [],
    readFileFn: () => JSON.stringify({ workspaces: [] }),
  });
  assert.equal(r.status, "OK");
});

test("(11) linear-reconnect: workspaces non-empty -> WARN", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([WS_PATH]),
    readdirFn: () => [],
    readFileFn: () => JSON.stringify({ workspaces: [{ id: "w1" }] }),
  });
  assert.equal(r.status, "WARN");
});

test("(12) linear-reconnect: malformed JSON -> UNJUDGABLE", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([WS_PATH]),
    readdirFn: () => [],
    readFileFn: () => "{not json",
  });
  assert.equal(r.status, "UNJUDGABLE");
});

test("(13) linear-reconnect: workspaces field missing -> UNJUDGABLE (no false OK)", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([WS_PATH]),
    readdirFn: () => [],
    readFileFn: () => JSON.stringify({ other: 1 }),
  });
  assert.equal(r.status, "UNJUDGABLE");
});

test("(14) linear-reconnect: tokensDir readdir throws -> UNJUDGABLE", () => {
  const r = checkLinearReconnect({
    workspacesPath: WS_PATH,
    tokensDir: TOKENS_DIR,
    existsFn: existsOnly([TOKENS_DIR]),
    readdirFn: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(r.status, "UNJUDGABLE");
});

// ---- checkAutomationsPresent --------------------------------------------------

test("(15) automations-present: db absent -> OK", () => {
  const r = checkAutomationsPresent({
    dbPath: DB_PATH,
    existsFn: existsOnly([]),
  });
  assert.equal(r.status, "OK");
});

test("(16) automations-present: db exists, marker present -> WARN", () => {
  const r = checkAutomationsPresent({
    dbPath: DB_PATH,
    existsFn: existsOnly([DB_PATH]),
    readFileFn: () =>
      Buffer.from("...SQLite format 3...CREATE TABLE automations (...)..."),
  });
  assert.equal(r.status, "WARN");
});

test("(17) automations-present: db exists, no marker -> UNJUDGABLE (no false OK)", () => {
  const r = checkAutomationsPresent({
    dbPath: DB_PATH,
    existsFn: existsOnly([DB_PATH]),
    readFileFn: () => Buffer.from("...SQLite format 3...unrelated bytes..."),
  });
  assert.equal(r.status, "UNJUDGABLE");
});

test("(18) automations-present: read error -> UNJUDGABLE", () => {
  const r = checkAutomationsPresent({
    dbPath: DB_PATH,
    existsFn: existsOnly([DB_PATH]),
    readFileFn: () => {
      throw new Error("EBUSY");
    },
  });
  assert.equal(r.status, "UNJUDGABLE");
});

// ---- checkTerminalHistorySecretScan --------------------------------------------

test("(19) terminal-history-secret-scan: dir absent -> OK", () => {
  const r = checkTerminalHistorySecretScan({
    dir: HIST_DIR,
    fingerprints: [],
    existsFn: existsOnly([]),
  });
  assert.equal(r.status, "OK");
});

test("(20) terminal-history-secret-scan: no fingerprints available -> UNJUDGABLE", () => {
  const r = checkTerminalHistorySecretScan({
    dir: HIST_DIR,
    fingerprints: [],
    existsFn: existsOnly([HIST_DIR]),
    readdirFn: () => ["session1.log"],
  });
  assert.equal(r.status, "UNJUDGABLE");
});

test("(21) terminal-history-secret-scan: files present, no match -> OK", () => {
  const fp = secretFingerprint("synthetic-bot-pat-value-000");
  const r = checkTerminalHistorySecretScan({
    dir: HIST_DIR,
    fingerprints: [fp],
    existsFn: existsOnly([HIST_DIR]),
    readdirFn: () => ["session1.log"],
    readFileFn: () => "$ git status\nnothing to commit\n",
  });
  assert.equal(r.status, "OK");
});

test("(22) terminal-history-secret-scan: fingerprint match -> FAIL, reason never echoes the secret", () => {
  const secret = "synthetic-bot-pat-value-000";
  const fp = secretFingerprint(secret);
  const r = checkTerminalHistorySecretScan({
    dir: HIST_DIR,
    fingerprints: [fp],
    existsFn: existsOnly([HIST_DIR]),
    readdirFn: () => ["session1.log"],
    readFileFn: () => `$ echo ${secret}\ndone\n`,
  });
  assert.equal(r.status, "FAIL");
  assert.equal(r.reason.includes(secret), false);
});

test("(23) terminal-history-secret-scan: unreadable file is skipped, scan continues", () => {
  const fp = secretFingerprint("synthetic-bot-pat-value-000");
  const r = checkTerminalHistorySecretScan({
    dir: HIST_DIR,
    fingerprints: [fp],
    existsFn: existsOnly([HIST_DIR]),
    readdirFn: () => ["locked.log", "session1.log"],
    readFileFn: (p) => {
      if (p.endsWith("locked.log")) throw new Error("EBUSY");
      return "clean content";
    },
  });
  assert.equal(r.status, "OK");
});

test("(24) terminal-history-secret-scan: readdir throws -> UNJUDGABLE", () => {
  const fp = secretFingerprint("synthetic-bot-pat-value-000");
  const r = checkTerminalHistorySecretScan({
    dir: HIST_DIR,
    fingerprints: [fp],
    existsFn: existsOnly([HIST_DIR]),
    readdirFn: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(r.status, "UNJUDGABLE");
});

// ---- runOrcaPostureCheck (조립점) ------------------------------------------

test("(25) runOrcaPostureCheck returns all 3 ids, all-absent posture is all OK", () => {
  const results = runOrcaPostureCheck({
    orcaHome: "/home/.orca",
    appDataOrca: "/appdata/orca",
    botPatPath: "/home/.bot_pat",
    existsFn: existsOnly([]),
  });
  assert.deepEqual(
    results.map((r) => r.id),
    ["linear-reconnect", "automations-present", "terminal-history-secret-scan"],
  );
  assert.ok(results.every((r) => r.status === "OK"));
});

test("(26) runOrcaPostureCheck end-to-end: .bot_pat leaked into terminal-history -> FAIL, secret never echoed", () => {
  const secret = "REAL-LOOKING-SYNTHETIC-PAT-VALUE";
  const orcaHome = join("/home", ".orca");
  const appDataOrca = join("/appdata", "orca");
  const histDir = join(appDataOrca, "terminal-history");
  const botPatPath = join("/home", ".bot_pat");
  const existsFn = existsOnly([histDir, botPatPath]);
  const readdirFn = (p) => (p === histDir ? ["session1.log"] : []);
  const readFileFn = (p) => {
    if (p === botPatPath) return secret;
    if (p === join(histDir, "session1.log")) return `$ echo ${secret}\n`;
    throw new Error(`unexpected read: ${p}`);
  };

  const results = runOrcaPostureCheck({
    orcaHome,
    appDataOrca,
    botPatPath,
    existsFn,
    readFileFn,
    readdirFn,
  });

  const scan = results.find((r) => r.id === "terminal-history-secret-scan");
  assert.equal(scan.status, "FAIL");
  assert.equal(JSON.stringify(results).includes(secret), false);
});

test("(27) runOrcaPostureCheck end-to-end: .bot_pat present but no leak -> OK, injected fs fully isolates from the real filesystem", () => {
  const secret = "REAL-LOOKING-SYNTHETIC-PAT-VALUE";
  const orcaHome = join("/home", ".orca");
  const appDataOrca = join("/appdata", "orca");
  const histDir = join(appDataOrca, "terminal-history");
  const botPatPath = join("/home", ".bot_pat");
  const existsFn = existsOnly([histDir, botPatPath]);
  const readdirFn = (p) => (p === histDir ? ["session1.log"] : []);
  const readFileFn = (p) => {
    if (p === botPatPath) return secret;
    if (p === join(histDir, "session1.log"))
      return "$ git status\nnothing to commit\n";
    throw new Error(`unexpected read: ${p}`);
  };

  const results = runOrcaPostureCheck({
    orcaHome,
    appDataOrca,
    botPatPath,
    existsFn,
    readFileFn,
    readdirFn,
  });

  const scan = results.find((r) => r.id === "terminal-history-secret-scan");
  assert.equal(scan.status, "OK");
});
