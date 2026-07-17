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
  loadFingerprints,
  runFingerprintInit,
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

// ---- runOrcaPostureCheck (조립점) — fingerprints는 항상 이미 로드된 배열로
// 주입된다. review-1 R1 수리: 이 함수는 어떤 real secret path도 받지 않고,
// 실제 파일시스템을 읽는 경로가 구조적으로 없다. ------------------------------

test("(25) runOrcaPostureCheck returns all 3 ids, all-absent posture is all OK", () => {
  const results = runOrcaPostureCheck({
    orcaHome: "/home/.orca",
    appDataOrca: "/appdata/orca",
    fingerprints: [],
    existsFn: existsOnly([]),
  });
  assert.deepEqual(
    results.map((r) => r.id),
    ["linear-reconnect", "automations-present", "terminal-history-secret-scan"],
  );
  assert.ok(results.every((r) => r.status === "OK"));
});

test("(26) runOrcaPostureCheck end-to-end: leaked fingerprint found in terminal-history -> FAIL, secret never echoed", () => {
  const secret = "REAL-LOOKING-SYNTHETIC-PAT-VALUE";
  const fp = secretFingerprint(secret);
  const orcaHome = join("/home", ".orca");
  const appDataOrca = join("/appdata", "orca");
  const histDir = join(appDataOrca, "terminal-history");
  const existsFn = existsOnly([histDir]);
  const readdirFn = (p) => (p === histDir ? ["session1.log"] : []);
  const readFileFn = (p) => {
    if (p === join(histDir, "session1.log")) return `$ echo ${secret}\n`;
    throw new Error(`unexpected read: ${p}`);
  };

  const results = runOrcaPostureCheck({
    orcaHome,
    appDataOrca,
    fingerprints: [fp],
    existsFn,
    readFileFn,
    readdirFn,
  });

  const scan = results.find((r) => r.id === "terminal-history-secret-scan");
  assert.equal(scan.status, "FAIL");
  assert.equal(JSON.stringify(results).includes(secret), false);
});

test("(27) runOrcaPostureCheck end-to-end: fingerprint present but no leak -> OK, injected fs fully isolates from the real filesystem", () => {
  const secret = "REAL-LOOKING-SYNTHETIC-PAT-VALUE";
  const fp = secretFingerprint(secret);
  const orcaHome = join("/home", ".orca");
  const appDataOrca = join("/appdata", "orca");
  const histDir = join(appDataOrca, "terminal-history");
  const existsFn = existsOnly([histDir]);
  const readdirFn = (p) => (p === histDir ? ["session1.log"] : []);
  const readFileFn = (p) => {
    if (p === join(histDir, "session1.log"))
      return "$ git status\nnothing to commit\n";
    throw new Error(`unexpected read: ${p}`);
  };

  const results = runOrcaPostureCheck({
    orcaHome,
    appDataOrca,
    fingerprints: [fp],
    existsFn,
    readFileFn,
    readdirFn,
  });

  const scan = results.find((r) => r.id === "terminal-history-secret-scan");
  assert.equal(scan.status, "OK");
});

test("(28) runOrcaPostureCheck never receives/touches a real secret path -- fingerprints-only contract", () => {
  // No botPatPath-shaped param exists on the function anymore; passing one
  // is simply ignored (not a supported option) -- existsFn below throws only
  // if ever called with that exact path, proving the default check path has
  // no real-secret parameter it could read from at all.
  const botPatPath = "/home/.bot_pat";
  const results = runOrcaPostureCheck({
    orcaHome: "/home/.orca",
    appDataOrca: "/appdata/orca",
    botPatPath, // dead param -- must be a no-op
    fingerprints: [],
    existsFn: (p) => {
      if (p === botPatPath)
        throw new Error(
          "existsFn must never be called with the real secret path",
        );
      return false;
    },
  });
  assert.ok(Array.isArray(results));
});

// ---- loadFingerprints --------------------------------------------------------

test("(29) loadFingerprints: file absent -> present:false, empty list", () => {
  const r = loadFingerprints("/harness/secret-fingerprints.json", {
    existsFn: existsOnly([]),
  });
  assert.deepEqual(r, { fingerprints: [], present: false });
});

test("(30) loadFingerprints: valid file -> parsed fingerprints, never the raw value", () => {
  const fp = secretFingerprint("synthetic-value-xyz");
  const path = "/harness/secret-fingerprints.json";
  const r = loadFingerprints(path, {
    existsFn: existsOnly([path]),
    readFileFn: () =>
      JSON.stringify({
        fingerprints: [{ id: "bot_pat", length: fp.length, sha256: fp.sha256 }],
      }),
  });
  assert.equal(r.present, true);
  assert.equal(r.fingerprints.length, 1);
  assert.equal(r.fingerprints[0].sha256, fp.sha256);
});

test("(31) loadFingerprints: malformed JSON -> present:true, malformed:true, empty list", () => {
  const path = "/harness/secret-fingerprints.json";
  const r = loadFingerprints(path, {
    existsFn: existsOnly([path]),
    readFileFn: () => "{not json",
  });
  assert.equal(r.present, true);
  assert.equal(r.malformed, true);
  assert.deepEqual(r.fingerprints, []);
});

test("(32) loadFingerprints: schema mismatch (no fingerprints array) -> malformed, empty list", () => {
  const path = "/harness/secret-fingerprints.json";
  const r = loadFingerprints(path, {
    existsFn: existsOnly([path]),
    readFileFn: () => JSON.stringify({ other: 1 }),
  });
  assert.equal(r.malformed, true);
  assert.deepEqual(r.fingerprints, []);
});

test("(33) loadFingerprints: drops malformed individual entries", () => {
  const path = "/harness/secret-fingerprints.json";
  const r = loadFingerprints(path, {
    existsFn: existsOnly([path]),
    readFileFn: () =>
      JSON.stringify({
        fingerprints: [{ id: "ok", length: 5, sha256: "abc" }, { id: "bad" }],
      }),
  });
  assert.equal(r.fingerprints.length, 1);
  assert.equal(r.fingerprints[0].id, "ok");
});

// ---- runFingerprintInit — the ONLY function allowed to read a real secret ---

test("(34) runFingerprintInit: writes {id,length,sha256} only, never the raw value, for existing sources", () => {
  const secret = "REAL-LOOKING-SYNTHETIC-PAT-VALUE";
  const srcPath = "/home/.bot_pat";
  const outPath = "/harness/secret-fingerprints.json";
  let written = null;
  const result = runFingerprintInit({
    sources: [{ id: "bot_pat", path: srcPath }],
    outPath,
    existsFn: existsOnly([srcPath]),
    readFileFn: () => secret,
    writeFileFn: (p, content) => {
      written = { path: p, content };
    },
  });
  assert.equal(result.count, 1);
  assert.equal(result.outPath, outPath);
  assert.equal(written.path, outPath);
  assert.equal(written.content.includes(secret), false);
  const parsed = JSON.parse(written.content);
  assert.equal(parsed.fingerprints[0].id, "bot_pat");
  assert.equal(parsed.fingerprints[0].sha256, sha256Hex(secret));
});

test("(35) runFingerprintInit: absent source is skipped, not an error, no read attempted for it", () => {
  const outPath = "/harness/secret-fingerprints.json";
  let written = null;
  const result = runFingerprintInit({
    sources: [{ id: "bot_pat", path: "/home/.bot_pat" }],
    outPath,
    existsFn: existsOnly([]),
    readFileFn: () => {
      throw new Error("must not read a source that does not exist");
    },
    writeFileFn: (p, content) => {
      written = { path: p, content };
    },
  });
  assert.equal(result.count, 0);
  assert.deepEqual(JSON.parse(written.content).fingerprints, []);
});
