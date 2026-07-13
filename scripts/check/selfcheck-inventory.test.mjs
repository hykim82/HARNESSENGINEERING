import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  parseHookCommands,
  extractCheckScriptId,
  findInstalledTarget,
  findExtraInvocations,
  sha256Hex,
  checkNativeGitHook,
  checkCanaryReceipt,
  DEFAULT_CANARY_MAX_AGE_MS,
  resolvePlaceholderPath,
  checkSourceReference,
  checkCiCoverage,
  coversViaCheckDirGlob,
  extractRunText,
  decodeYamlScalar,
  combineStatuses,
  judgeEntry,
  runInventory,
  discoverCheckTestFiles,
  expectedIdsForLocation,
  findExtraResults,
} from "./selfcheck-inventory.mjs";

// --- POSIX shell discovery (HYK-129 coder-9/10, review-8/9 defect 2/1) ------
// History: coder-8 hardcoded `sh`; coder-9 added a `-c exit 0` probe with a
// Git-for-Windows fallback. review-9 found that `-c exit 0` is too weak: in
// the codex review sandbox it selected `C:\Windows\System32\bash.exe` (WSL),
// which passes `exit 0` but does NOT share the Windows filesystem semantics
// the oracle relies on -- the glob didn't expand against the Windows-path
// fixture and the lingering process made rmSync throw EPERM, so 28s/28t RAN
// but FAILED (2 failures unseen on the Claude host).
//
// Fix (coder-10): the probe is now FUNCTIONAL, not existence-only. A candidate
// is accepted only if, in a throwaway fixture dir, it (1) expands
// `scripts/check/*.test.mjs` POSIX-style into argv AND (2) releases the cwd so
// the fixture deletes without EPERM. WSL bash fails both, so it is rejected no
// matter where it sits on PATH. Candidate order additionally puts the
// Git-for-Windows shells ahead of a bare PATH `bash` (which on Windows is
// usually WSL), but ORDER ALONE IS NOT RELIED ON -- the functional probe is
// the real gate, since another environment could surface a broken shell under
// a different name. All still-injectable (`probe`/`candidates`) so the unit
// tests below pin the logic without needing any real shell.
function whereResults(names) {
  // Windows `where` (absent on Linux CI -> throws -> []); on ubuntu the PATH
  // name `sh` already succeeds as candidate 1 so this isn't needed there.
  const found = [];
  for (const name of names) {
    try {
      const out = execFileSync("where", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      for (const l of out.split(/\r?\n/)) if (l.trim()) found.push(l.trim());
    } catch {
      /* `where` missing or no match -> ignore */
    }
  }
  return found;
}

const GIT_FOR_WINDOWS_SHELLS = [
  "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

// Functional probe (review-9 defect 1): prove the candidate behaves like a
// POSIX shell on THIS filesystem -- glob expansion + clean cwd release --
// rather than merely existing. This is exactly what WSL bash fails.
function functionalShellProbe(cmd) {
  const dir = mkdtempSync(join(tmpdir(), "shell-probe-"));
  let ok = false;
  try {
    mkdirSync(join(dir, "scripts", "check"), { recursive: true });
    for (const f of ["a.test.mjs", "b.test.mjs"]) writeFileSync(join(dir, "scripts", "check", f), "//\n", "utf8");
    // (1) the glob must expand POSIX-style to both fixture files in argv
    const script = `set -- scripts/check/*.test.mjs\nfor a in "$@"; do echo "ARG:$a"; done`;
    const out = execFileSync(cmd, ["-c", script], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const argv = out.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
    ok = ["a.test.mjs", "b.test.mjs"].every((f) => argv.some((a) => a.endsWith(f)));
  } catch {
    ok = false; // missing binary, non-shell, or glob machinery threw
  }
  // (2) cleanup must succeed without EPERM -- WSL bash keeps a handle on the
  //     Windows cwd, so this throws and disqualifies the candidate.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    ok = false;
  }
  return ok;
}

function findPosixShell({ probe = functionalShellProbe, candidates } = {}) {
  const list = candidates ?? ["sh", ...GIT_FOR_WINDOWS_SHELLS, "bash", ...whereResults(["sh", "bash"])];
  for (const cand of list) {
    if (probe(cand)) return cand;
  }
  return null;
}

const POSIX_SHELL = findPosixShell();
const SHELL_SKIP = POSIX_SHELL
  ? false
  : "no functionally-verified POSIX shell (glob-expanding + clean cwd release) found on PATH, via `where`, or at any Git-for-Windows path -- oracle skipped, honestly recorded";

// --- Real-Bash oracle (HYK-129 coder-8/9, review-7 requirement 4) ----------
// Instead of trusting our own reasoning about Bash quoting, these helpers ask
// a real POSIX shell. `bashSuiteRuns` stands in for `node --test` with the
// shell builtin `set --`, so `$@` becomes *exactly* the argv Bash would hand
// node for a given run-command fragment. If every discovered test file lands
// in that argv, the whole suite runs; if the glob was suppressed (quotes) the
// argv is the literal pattern and no real file appears.
function bashArgvFor(cwd, runFragment) {
  // runFragment == exactly what follows `node --test ` in the workflow line.
  const script = `set -- ${runFragment}\nfor a in "$@"; do echo "ARG:$a"; done`;
  const out = execFileSync(POSIX_SHELL, ["-c", script], { cwd, encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.startsWith("ARG:"))
    .map((l) => l.slice(4));
}

function bashSuiteRuns(cwd, runFragment, expectedFiles) {
  const argv = bashArgvFor(cwd, runFragment);
  return expectedFiles.every((f) => argv.some((a) => a.endsWith(f)));
}

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "selfcheck-inventory-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- parseHookCommands / extractCheckScriptId ---

test("(1) parseHookCommands: extracts hookEvent/matcher/command, ignores every other settings field", () => {
  const settings = {
    permissions: { allow: ["Bash(rm -rf /)"] },
    env: { SECRET: "should-never-appear" },
    hooks: {
      PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: 'node "scripts/check/role-guard.mjs"' }] }],
      Stop: [{ hooks: [{ type: "command", command: "node scripts/check/status-fresh.mjs --status x" }] }],
    },
  };
  const result = parseHookCommands(settings);
  assert.deepEqual(result, [
    { hookEvent: "PreToolUse", matcher: "Edit|Write", command: 'node "scripts/check/role-guard.mjs"' },
    { hookEvent: "Stop", matcher: null, command: "node scripts/check/status-fresh.mjs --status x" },
  ]);
});

test("(2) parseHookCommands: missing/malformed hooks object -> []", () => {
  assert.deepEqual(parseHookCommands({}), []);
  assert.deepEqual(parseHookCommands(null), []);
  assert.deepEqual(parseHookCommands({ hooks: "not-an-object" }), []);
  assert.deepEqual(parseHookCommands({ hooks: { Stop: "not-an-array" } }), []);
});

test("(3) extractCheckScriptId: extracts id from forward- or back-slash command", () => {
  assert.equal(extractCheckScriptId('node "$CLAUDE_PROJECT_DIR/scripts/check/role-guard.mjs"'), "role-guard");
  assert.equal(extractCheckScriptId("node C:\\repo\\scripts\\check\\controlroom-fresh.mjs --x"), "controlroom-fresh");
});

test("(4) extractCheckScriptId: non-check command (e.g. notification balloon) -> null", () => {
  assert.equal(extractCheckScriptId("Add-Type -AssemblyName System.Windows.Forms"), null);
  assert.equal(extractCheckScriptId(null), null);
  assert.equal(extractCheckScriptId(undefined), null);
});

// --- findInstalledTarget / findExtraInvocations (G6) ---

test("(5) findInstalledTarget: installed with matching matcher -> installed:true", () => {
  const hookCommands = [{ hookEvent: "PreToolUse", matcher: "Edit|Write", command: "node scripts/check/role-guard.mjs" }];
  const result = findInstalledTarget(hookCommands, { id: "role-guard", hookEvent: "PreToolUse", matcher: "Edit|Write" });
  assert.equal(result.installed, true);
  assert.equal(result.matcherMismatch, false);
});

test("(6) findInstalledTarget: missing entirely -> installed:false (G6 'missing')", () => {
  const result = findInstalledTarget([], { id: "role-guard", hookEvent: "PreToolUse", matcher: "Edit|Write" });
  assert.equal(result.installed, false);
});

test("(7) findInstalledTarget: installed but matcher differs -> matcherMismatch:true", () => {
  const hookCommands = [{ hookEvent: "PreToolUse", matcher: "Edit", command: "node scripts/check/role-guard.mjs" }];
  const result = findInstalledTarget(hookCommands, { id: "role-guard", hookEvent: "PreToolUse", matcher: "Edit|Write" });
  assert.equal(result.installed, true);
  assert.equal(result.matcherMismatch, true);
});

test("(8) findExtraInvocations: a hook command referencing an id not in expectedIds -> flagged extra (G6 'extra')", () => {
  const hookCommands = [
    { hookEvent: "Stop", matcher: null, command: "node scripts/check/status-fresh.mjs" },
    { hookEvent: "Stop", matcher: null, command: "node scripts/check/mystery-check.mjs" },
  ];
  const extras = findExtraInvocations(hookCommands, ["status-fresh"]);
  assert.deepEqual(extras, ["mystery-check"]);
});

test("(9) findExtraInvocations: nothing unexpected -> []", () => {
  const hookCommands = [{ hookEvent: "Stop", matcher: null, command: "node scripts/check/status-fresh.mjs" }];
  assert.deepEqual(findExtraInvocations(hookCommands, ["status-fresh"]), []);
});

// --- checkNativeGitHook (G7) ---

test("(10) checkNativeGitHook: installed matches versioned (hash equal) -> ALIVE", () => {
  withFixtureDir((dir) => {
    const versionedPath = join(dir, "hooks-commit-msg");
    const installedPath = join(dir, "git-hooks-commit-msg");
    writeFileSync(versionedPath, "#!/bin/sh\necho ok\n", "utf8");
    writeFileSync(installedPath, "#!/bin/sh\necho ok\n", "utf8");
    const result = checkNativeGitHook({ versionedPath, installedPath });
    assert.equal(result.status, "ALIVE");
  });
});

test("(11) checkNativeGitHook: installed copy missing -> NOT_INSTALLED (G7 'bad')", () => {
  withFixtureDir((dir) => {
    const versionedPath = join(dir, "hooks-pre-commit");
    writeFileSync(versionedPath, "#!/bin/sh\ngitleaks detect\n", "utf8");
    const result = checkNativeGitHook({ versionedPath, installedPath: join(dir, "does-not-exist") });
    assert.equal(result.status, "NOT_INSTALLED");
  });
});

test("(12) checkNativeGitHook: installed differs from versioned (hash mismatch) -> DRIFT", () => {
  withFixtureDir((dir) => {
    const versionedPath = join(dir, "hooks-commit-msg");
    const installedPath = join(dir, "git-hooks-commit-msg");
    writeFileSync(versionedPath, "#!/bin/sh\necho v2\n", "utf8");
    writeFileSync(installedPath, "#!/bin/sh\necho v1-stale\n", "utf8");
    const result = checkNativeGitHook({ versionedPath, installedPath });
    assert.equal(result.status, "DRIFT");
  });
});

test("(13) checkNativeGitHook: versioned copy itself missing -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    const result = checkNativeGitHook({ versionedPath: join(dir, "nope"), installedPath: join(dir, "also-nope") });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(14) sha256Hex: deterministic, differs for different content", () => {
  assert.equal(sha256Hex("a"), sha256Hex("a"));
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});

// --- checkCanaryReceipt (G9) ---

test("(15) checkCanaryReceipt: no canaryDir given -> UNJUDGABLE", () => {
  const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: undefined });
  assert.equal(result.status, "UNJUDGABLE");
});

test("(16) checkCanaryReceipt: receipt file missing -> UNJUDGABLE (G9 'missing receipt fixture')", () => {
  withFixtureDir((dir) => {
    const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: dir });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(17) checkCanaryReceipt: fresh, complete, matching receipt -> ALIVE", () => {
  withFixtureDir((dir) => {
    const now = new Date("2026-07-13T00:00:00+09:00").getTime();
    writeFileSync(
      join(dir, "clear-safe-check.json"),
      JSON.stringify({ check_id: "clear-safe-check", checked_at: "2026-07-12T23:00:00+09:00", bad_exit: 2, good_exit: 0 }),
      "utf8",
    );
    const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: dir, now });
    assert.equal(result.status, "ALIVE");
  });
});

test("(18) checkCanaryReceipt: missing required field -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, "clear-safe-check.json"), JSON.stringify({ check_id: "clear-safe-check", checked_at: "2026-07-12T23:00:00+09:00" }), "utf8");
    const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: dir });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(19) checkCanaryReceipt: check_id mismatch -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    writeFileSync(
      join(dir, "clear-safe-check.json"),
      JSON.stringify({ check_id: "controlroom-fresh", checked_at: "2026-07-12T23:00:00+09:00", bad_exit: 2, good_exit: 0 }),
      "utf8",
    );
    const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: dir });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(20) checkCanaryReceipt: stale (older than maxAgeMs) -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    const now = new Date("2026-07-13T00:00:00Z").getTime();
    const old = new Date(now - (DEFAULT_CANARY_MAX_AGE_MS + 3600000)).toISOString();
    writeFileSync(join(dir, "clear-safe-check.json"), JSON.stringify({ check_id: "clear-safe-check", checked_at: old, bad_exit: 2, good_exit: 0 }), "utf8");
    const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: dir, now });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(21) checkCanaryReceipt: malformed JSON -> UNJUDGABLE, never throws", () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, "clear-safe-check.json"), "not-json", "utf8");
    const result = checkCanaryReceipt({ id: "clear-safe-check", canaryDir: dir });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

// --- resolvePlaceholderPath ---

test("(22) resolvePlaceholderPath: resolves REPO/CONTROL_ROOM/USER_HOME placeholders", () => {
  const roots = { REPO: "/repo", CONTROL_ROOM: "/control", USER_HOME: "/home/x" };
  assert.equal(resolvePlaceholderPath("REPO/.claude/settings.local.json", roots), join("/repo", ".claude/settings.local.json"));
  assert.equal(resolvePlaceholderPath("CONTROL_ROOM/.claude/settings.local.json", roots), join("/control", ".claude/settings.local.json"));
  assert.equal(resolvePlaceholderPath("USER_HOME/.claude-team/settings.json", roots), join("/home/x", ".claude-team/settings.json"));
});

test("(23) resolvePlaceholderPath: unknown placeholder or missing root -> null", () => {
  assert.equal(resolvePlaceholderPath("NOPE/x", { REPO: "/repo" }), null);
  assert.equal(resolvePlaceholderPath("USER_HOME/x", {}), null);
});

// --- checkSourceReference (packet-gate's indirect wiring) ---

test("(24) checkSourceReference: caller file still contains the pattern -> ALIVE", () => {
  withFixtureDir((dir) => {
    const file = join(dir, "role-guard.mjs");
    writeFileSync(file, 'import { checkPacketGate } from "./packet-gate.mjs";\n', "utf8");
    const result = checkSourceReference({ file, pattern: "packet-gate.mjs" });
    assert.equal(result.status, "ALIVE");
  });
});

test("(25) checkSourceReference: pattern no longer present -> SILENT_BROKEN", () => {
  withFixtureDir((dir) => {
    const file = join(dir, "role-guard.mjs");
    writeFileSync(file, "// packet-gate import removed\n", "utf8");
    const result = checkSourceReference({ file, pattern: "packet-gate.mjs" });
    assert.equal(result.status, "SILENT_BROKEN");
  });
});

test("(26) checkSourceReference: caller file missing entirely -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    const result = checkSourceReference({ file: join(dir, "does-not-exist.mjs"), pattern: "packet-gate.mjs" });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

// --- checkCiCoverage ---

test("(27) checkCiCoverage: all test files referenced -> ALIVE", () => {
  const result = checkCiCoverage({
    workflowText: "run: node scripts/check/a.test.mjs\nrun: node scripts/check/b.test.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
  assert.deepEqual(result.missing, []);
});

test("(28) checkCiCoverage: some test files missing from workflow -> DRIFT, names them", () => {
  const result = checkCiCoverage({
    workflowText: "run: node scripts/check/a.test.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs", "c.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["b.test.mjs", "c.test.mjs"]);
});

test("(28b) checkCiCoverage: a glob step (scripts/check/*.test.mjs) covers every discovered file, including ones never named literally -> ALIVE (HYK-129 사이클3)", () => {
  const result = checkCiCoverage({
    workflowText: "      - name: check test suites (all scripts/check/*.test.mjs)\n        run: node --test scripts/check/*.test.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs", "brand-new-never-named-anywhere.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
  assert.deepEqual(result.missing, []);
});

test("(28c) checkCiCoverage: a glob for a different directory does NOT count as covering scripts/check", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/other/*.test.mjs\n",
    testFiles: ["a.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
});

// --- review-5 rejected fix: a *partial* wildcard must NOT be treated as
// full-directory coverage (it only covers a subset, not everything) ---

test("(28d) checkCiCoverage: partial glob 'scripts/check/*check.test.mjs' -> NOT treated as full-directory coverage (review-5 repro: this used to wrongly return ALIVE)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*check.test.mjs\n",
    testFiles: ["a.test.mjs", "role-guard-check.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
  assert.ok(result.missing.includes("a.test.mjs"));
});

test("(28e) checkCiCoverage: partial glob 'scripts/check/selfcheck*.test.mjs' -> NOT full coverage (review-5 repro)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/selfcheck*.test.mjs\n",
    testFiles: ["a.test.mjs", "selfcheck.test.mjs"],
  });
  // The whole-directory glob regex correctly does not match this partial
  // glob, so this falls through to literal substring matching -- which also
  // can't credit "selfcheck.test.mjs" (the workflow text has a literal `*`
  // in the middle, not the real filename), so both are reported missing.
  // The important assertion is the one that matters: never ALIVE here.
  assert.equal(result.status, "DRIFT");
  assert.ok(result.missing.includes("a.test.mjs"));
});

test("(28f) checkCiCoverage: exact whole-directory glob still recognized with backslash path separators", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts\\check\\*.test.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
});

// --- review-6 rejected fix: missing end/start boundary on the glob regex ---

test("(28g) checkCiCoverage: 'scripts/check/*.test.mjs.bak' -> NOT full coverage (review-6 repro: a real shell glob with this suffix runs zero actual tests)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*.test.mjs.bak\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
});

// review-7 case 1 (was a false ALIVE): Bash does NOT expand a glob inside
// quotes, so `node --test "scripts/check/*.test.mjs"` looks for one literal
// file named `*.test.mjs`, runs zero tests, and must NOT count as coverage.
// (coder-7 wrongly treated a trailing quote as a valid end boundary.)
test("(28h) checkCiCoverage: the exact glob wrapped in double quotes -> DRIFT (Bash suppresses glob expansion inside quotes; review-7 case 1)", () => {
  const result = checkCiCoverage({
    workflowText: 'run: node --test "scripts/check/*.test.mjs"\n',
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["a.test.mjs", "b.test.mjs"]);
});

test("(28h2) checkCiCoverage: the exact glob wrapped in single quotes -> DRIFT (same suppression as double quotes)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test 'scripts/check/*.test.mjs'\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
});

test("(28i) checkCiCoverage: the exact glob followed by end-of-string (no trailing newline) -> still ALIVE", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*.test.mjs",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
});

test("(28j) checkCiCoverage: the exact glob followed by trailing whitespace -> still ALIVE (no regression)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*.test.mjs \n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
});

test("(28k) checkCiCoverage: an accidental prefix like 'xscripts/check/*.test.mjs' does not count as coverage (leading boundary)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test xscripts/check/*.test.mjs\n",
    testFiles: ["a.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
});

// review-7 case 2 (was a false DRIFT): a shell control operator immediately
// after the glob (no space) still terminates the word, so Bash expands the
// glob and runs the whole suite -- must count as coverage. coder-7's trailing
// lookahead only accepted quote/space/EOS, so `&&` was wrongly rejected.
test("(28l) checkCiCoverage: glob immediately followed by '&&' (no space) -> ALIVE (control operator terminates the word; review-7 case 2)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*.test.mjs&&echo done\n",
    testFiles: ["a.test.mjs", "b.test.mjs", "never-named.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
  assert.deepEqual(result.missing, []);
});

test("(28l2) checkCiCoverage: glob immediately followed by ';' or '|' (no space) -> ALIVE (both are word-terminating control operators)", () => {
  for (const frag of ["scripts/check/*.test.mjs;echo done", "scripts/check/*.test.mjs|cat"]) {
    const result = checkCiCoverage({
      workflowText: `run: node --test ${frag}\n`,
      testFiles: ["a.test.mjs", "b.test.mjs"],
    });
    assert.equal(result.status, "ALIVE", `fragment '${frag}' should be full coverage`);
  }
});

test("(28m) checkCiCoverage: glob separated by a TAB is still recognized (tab is a word separator, no regression)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test\tscripts/check/*.test.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
});

test("(28n) checkCiCoverage: glob with a CRLF line ending is still recognized (\\r terminates the word, no regression)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*.test.mjs\r\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
});

test("(28o) checkCiCoverage: a recursive glob 'scripts/check/**/*.test.mjs' is NOT treated as the canonical whole-directory glob (no false ALIVE)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/**/*.test.mjs\n",
    testFiles: ["a.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
});

test("(28p) checkCiCoverage: a case-mismatched path 'scripts/Check/*.test.mjs' does not count (Ubuntu paths are case-sensitive)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/Check/*.test.mjs\n",
    testFiles: ["a.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
});

// --- coversViaCheckDirGlob: direct unit coverage of the tokenizer contract ---

test("(28q) coversViaCheckDirGlob: bare glob true; quoted/partial/prefixed/other-dir false", () => {
  assert.equal(coversViaCheckDirGlob("node --test scripts/check/*.test.mjs"), true);
  assert.equal(coversViaCheckDirGlob("node --test scripts/check/*.test.mjs&&x"), true);
  assert.equal(coversViaCheckDirGlob('node --test "scripts/check/*.test.mjs"'), false);
  assert.equal(coversViaCheckDirGlob("node --test 'scripts/check/*.test.mjs'"), false);
  assert.equal(coversViaCheckDirGlob("node --test scripts/check/*check.test.mjs"), false);
  assert.equal(coversViaCheckDirGlob("node --test scripts/check/*.test.mjs.bak"), false);
  assert.equal(coversViaCheckDirGlob("node --test xscripts/check/*.test.mjs"), false);
  assert.equal(coversViaCheckDirGlob("node --test scripts/other/*.test.mjs"), false);
});

test("(28r) coversViaCheckDirGlob: a quoted directory prefix with the '*' left UNQUOTED still expands in Bash -> true (matches real shell)", () => {
  // Bash: `"scripts/check/"*.test.mjs` -> prefix quoted, `*` unquoted -> expands.
  assert.equal(coversViaCheckDirGlob('node --test "scripts/check/"*.test.mjs'), true);
});

// --- REAL-BASH ORACLE (review-7 requirement 4): the checker's ALIVE/not-ALIVE
// verdict must equal whether a real POSIX shell actually runs the whole suite.
// Representative fragments: unquoted, double-quoted, and `&&`-terminated. ---

test(
  "(28s) real Bash oracle: for unquoted / double-quoted / '&&'-terminated fragments, checkCiCoverage ALIVE iff a real sh actually hands every test file to node",
  { skip: SHELL_SKIP },
  () => {
    withFixtureDir((dir) => {
      mkdirSync(join(dir, "scripts", "check"), { recursive: true });
      const expected = ["a.test.mjs", "b.test.mjs"];
      for (const f of expected) writeFileSync(join(dir, "scripts", "check", f), "// stub\n", "utf8");

      const fragments = [
        "scripts/check/*.test.mjs", // unquoted -> expands
        '"scripts/check/*.test.mjs"', // double-quoted -> suppressed
        "scripts/check/*.test.mjs&&echo done", // control operator -> expands
      ];
      for (const frag of fragments) {
        const realRuns = bashSuiteRuns(dir, frag, expected);
        const verdict = checkCiCoverage({
          workflowText: `run: node --test ${frag}\n`,
          testFiles: expected,
        });
        const checkerAlive = verdict.status === "ALIVE";
        assert.equal(
          checkerAlive,
          realRuns,
          `fragment '${frag}': checker ALIVE=${checkerAlive} but real sh runs-whole-suite=${realRuns}`,
        );
      }
    });
  },
);

test(
  "(28t) real Bash oracle: single-quoted glob is suppressed by sh AND judged not-covered by the checker (they agree it runs zero tests)",
  { skip: SHELL_SKIP },
  () => {
    withFixtureDir((dir) => {
      mkdirSync(join(dir, "scripts", "check"), { recursive: true });
      const expected = ["a.test.mjs", "b.test.mjs"];
      for (const f of expected) writeFileSync(join(dir, "scripts", "check", f), "// stub\n", "utf8");

      const frag = "'scripts/check/*.test.mjs'";
      const realRuns = bashSuiteRuns(dir, frag, expected);
      assert.equal(realRuns, false, "sanity: sh must NOT expand a single-quoted glob");
      const verdict = checkCiCoverage({ workflowText: `run: node --test ${frag}\n`, testFiles: expected });
      assert.equal(verdict.status, "DRIFT");
    });
  },
);

// --- POSIX shell discovery (review-8 defect 2): findPosixShell must be pinned
// with injected probe/candidates so it is testable without a real shell, and
// the oracle must report which shell (if any) it resolved -- so a silent skip
// (coder-8's failure) becomes visible in the test output. ---

test("(28u) findPosixShell: returns the first candidate the probe accepts, and stops probing after it", () => {
  const probed = [];
  const probe = (c) => {
    probed.push(c);
    return c === "/opt/git/usr/bin/bash";
  };
  const found = findPosixShell({ probe, candidates: ["sh", "bash", "/opt/git/usr/bin/bash", "never-reached"] });
  assert.equal(found, "/opt/git/usr/bin/bash");
  assert.deepEqual(probed, ["sh", "bash", "/opt/git/usr/bin/bash"]);
});

test("(28v) findPosixShell: no candidate works -> null (this is the honest-skip path, not a crash)", () => {
  const found = findPosixShell({ probe: () => false, candidates: ["sh", "bash", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"] });
  assert.equal(found, null);
});

test("(28w) oracle shell diagnostic: records which shell the real-Bash oracle used, so 28s/28t running-vs-skipping is auditable", () => {
  // Deliberately NOT an assertion that a shell exists -- a shell-less box keeps
  // the honest skip. This just surfaces the resolved path in the output so a
  // reviewer can confirm the oracle actually executed rather than silently
  // skipping (the exact gap review-8 found in coder-8).
  console.log(`[oracle-shell] findPosixShell -> ${POSIX_SHELL ?? "NONE (28s/28t honestly skipped)"}`);
  if (POSIX_SHELL !== null) assert.equal(typeof POSIX_SHELL, "string");
});

// review-9 defect 1: a candidate that merely EXISTS (passes `-c exit 0`) but
// does not behave like a POSIX shell on this filesystem -- WSL bash, whose
// glob doesn't expand against a Windows-path fixture and whose lingering
// process makes cleanup throw EPERM -- must be rejected. The functional probe
// models this: the WSL-like candidate returns false, so findPosixShell skips
// it and takes the first functionally-good one instead.
test("(28w2) findPosixShell: a WSL-like candidate that fails the functional probe is rejected; the first functionally-good shell wins even if the bad one is earlier", () => {
  const wsl = "C:\\Windows\\System32\\bash.exe";
  const gitBash = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
  const probed = [];
  const probe = (c) => {
    probed.push(c);
    return c === gitBash; // only real Git bash passes the functional check
  };
  const found = findPosixShell({ probe, candidates: [wsl, gitBash, "unused"] });
  assert.equal(found, gitBash, "WSL bash must not be selected once it fails the functional probe");
  assert.deepEqual(probed, [wsl, gitBash], "probed the bad one, rejected it, accepted the good one, stopped");
});

test(
  "(28w3) functionalShellProbe: accepts a real POSIX shell (glob expands + cwd releases cleanly) and rejects a missing/non-shell binary",
  { skip: SHELL_SKIP },
  () => {
    assert.equal(functionalShellProbe(POSIX_SHELL), true, "the resolved shell must pass its own functional probe");
    assert.equal(functionalShellProbe("definitely-not-a-real-shell-binary-xyz"), false, "a missing binary must be rejected, not throw");
  },
);

// --- extractRunText (review-8 defect 1): only the run: steps execute, so only
// they may count as coverage. name:, other keys, and YAML comments are out. ---

test("(28x) extractRunText: an inline scalar yields just the command", () => {
  assert.equal(extractRunText("        run: node --test scripts/check/*.test.mjs\n"), "node --test scripts/check/*.test.mjs");
});

test("(28y) extractRunText: a whole-command YAML quote is stripped (YAML quotes are not shell quotes)", () => {
  assert.equal(extractRunText('        run: "node --test scripts/check/*.test.mjs"\n'), "node --test scripts/check/*.test.mjs");
  assert.equal(extractRunText("        run: 'node --test scripts/check/*.test.mjs'\n"), "node --test scripts/check/*.test.mjs");
});

test("(28z) extractRunText: a '|' block scalar is captured and dedented; a following sibling step ends the block", () => {
  const yaml = [
    "      - name: hooks POSIX syntax check",
    "        run: |",
    "          sh -n hooks/commit-msg",
    "          sh -n hooks/pre-commit",
    "",
    "      - name: next",
    "        run: echo hi",
    "",
  ].join("\n");
  const out = extractRunText(yaml);
  assert.ok(out.includes("sh -n hooks/commit-msg"), "block body line 1 present");
  assert.ok(out.includes("sh -n hooks/pre-commit"), "block body line 2 present");
  assert.ok(out.includes("echo hi"), "the sibling step's inline run is also captured");
  assert.ok(!/(^|\n) {2,}sh -n/.test(out), "block body must be dedented (no leading indent survives)");
  assert.ok(!out.includes("hooks POSIX syntax check"), "step name: must NOT leak into run text");
});

test("(28aa) extractRunText: name: and YAML-comment lines are excluded; only run: survives", () => {
  const yaml = [
    "      # node --test scripts/check/*.test.mjs   (comment, never runs)",
    "      - name: all scripts/check/*.test.mjs",
    "        run: node --test scripts/check/a.test.mjs",
  ].join("\n");
  assert.equal(extractRunText(yaml), "node --test scripts/check/a.test.mjs");
});

test("(28ab) extractRunText: multiple run: steps are all captured, newline-joined", () => {
  assert.equal(extractRunText("        run: echo one\n        run: echo two\n"), "echo one\necho two");
});

test("(28ac) extractRunText: the '- run:' form (no separate name key) is captured, block dedented", () => {
  const yaml = ["      - run: |", "          echo a", "          echo b"].join("\n");
  const out = extractRunText(yaml);
  assert.ok(out.includes("echo a") && out.includes("echo b"));
});

// --- decodeYamlScalar (review-9 defect 2): YAML quoting is decoded BEFORE the
// shell tokenizer runs, so the two quoting layers don't get conflated. ---

test("(28ac2) decodeYamlScalar: plain scalar is verbatim; any quotes in it are literal shell quotes", () => {
  assert.equal(decodeYamlScalar('node --test "x"'), 'node --test "x"');
  assert.equal(decodeYamlScalar("  node --test scripts/check/*.test.mjs  "), "node --test scripts/check/*.test.mjs");
});

test("(28ac3) decodeYamlScalar: single-quoted scalar removes outer quotes and decodes '' -> ' (the review-9 case)", () => {
  // YAML `'node --test ''scripts/check/*.test.mjs'''` -> the shell string
  // `node --test 'scripts/check/*.test.mjs'` (glob single-quoted at shell level).
  assert.equal(decodeYamlScalar("'node --test ''scripts/check/*.test.mjs'''"), "node --test 'scripts/check/*.test.mjs'");
  assert.equal(decodeYamlScalar("'plain single quoted'"), "plain single quoted");
});

test("(28ac4) decodeYamlScalar: double-quoted scalar removes outer quotes and resolves backslash escapes", () => {
  assert.equal(decodeYamlScalar('"node --test scripts/check/*.test.mjs"'), "node --test scripts/check/*.test.mjs");
  assert.equal(decodeYamlScalar('"say \\"hi\\""'), 'say "hi"');
});

test("(28ac5) decodeYamlScalar: an ambiguous/unbalanced quoted scalar -> '' (bias to DRIFT, never a false ALIVE)", () => {
  assert.equal(decodeYamlScalar("'unterminated"), "");
  assert.equal(decodeYamlScalar("'a' trailing junk"), "");
  assert.equal(decodeYamlScalar('"a" then more'), "");
});

test("(28ac6) checkCiCoverage: review-9 repro -- YAML single-quoted glob `run: 'node --test ''scripts/check/*.test.mjs'''` -> DRIFT (after YAML decode the glob is shell-single-quoted and expands to nothing)", () => {
  const workflowText = "        run: 'node --test ''scripts/check/*.test.mjs'''\n";
  const result = checkCiCoverage({ workflowText, testFiles: ["a.test.mjs", "b.test.mjs"] });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["a.test.mjs", "b.test.mjs"]);
});

test("(28ac7) checkCiCoverage: a whole-command YAML single-quote wrapper (no inner '') -> ALIVE (YAML quotes are not shell quotes, glob expands unquoted)", () => {
  const workflowText = "        run: 'node --test scripts/check/*.test.mjs'\n";
  const result = checkCiCoverage({ workflowText, testFiles: ["a.test.mjs", "b.test.mjs"] });
  assert.equal(result.status, "ALIVE");
});

// --- review-8 defect 1 repros: coverage credited ONLY from run: text ---

test("(28ad) checkCiCoverage: whole-dir glob in a step name: but run: runs one file -> DRIFT (name: executes nothing; review-8 repro)", () => {
  const workflowText = [
    "      - name: check test suites (all scripts/check/*.test.mjs)",
    "        run: node --test scripts/check/a.test.mjs",
    "",
  ].join("\n");
  const result = checkCiCoverage({ workflowText, testFiles: ["a.test.mjs", "b.test.mjs"] });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["b.test.mjs"]);
});

test("(28ae) checkCiCoverage: whole-dir glob only in a YAML comment, run: runs one file -> DRIFT (comments execute nothing; review-8 repro)", () => {
  const workflowText = [
    "      # node --test scripts/check/*.test.mjs",
    "      - name: check",
    "        run: node --test scripts/check/a.test.mjs",
    "",
  ].join("\n");
  const result = checkCiCoverage({ workflowText, testFiles: ["a.test.mjs", "b.test.mjs"] });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["b.test.mjs"]);
});

test("(28af) checkCiCoverage: the REAL enforce.yml shape (glob in BOTH name: and run:) -> ALIVE (the run: glob is present and is what counts)", () => {
  const workflowText = [
    "      - name: check test suites (all scripts/check/*.test.mjs)",
    "        run: node --test scripts/check/*.test.mjs",
    "",
  ].join("\n");
  const result = checkCiCoverage({ workflowText, testFiles: ["a.test.mjs", "b.test.mjs", "brand-new.test.mjs"] });
  assert.equal(result.status, "ALIVE");
  assert.deepEqual(result.missing, []);
});

test("(28ag) checkCiCoverage: a commented-out glob INSIDE a run: block is not counted (bashWords drops shell #-comments)", () => {
  const workflowText = [
    "        run: |",
    "          # node --test scripts/check/*.test.mjs",
    "          node --test scripts/check/a.test.mjs",
    "",
  ].join("\n");
  const result = checkCiCoverage({ workflowText, testFiles: ["a.test.mjs", "b.test.mjs"] });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["b.test.mjs"]);
});

// --- combineStatuses ---

test("(29) combineStatuses: picks the worst status present, worst-first order", () => {
  assert.equal(combineStatuses(["ALIVE", "UNJUDGABLE"]), "UNJUDGABLE");
  assert.equal(combineStatuses(["ALIVE", "DRIFT", "UNJUDGABLE"]), "DRIFT");
  assert.equal(combineStatuses(["DRIFT", "NOT_INSTALLED"]), "NOT_INSTALLED");
  assert.equal(combineStatuses(["ALIVE", "SILENT_BROKEN"]), "SILENT_BROKEN");
  assert.equal(combineStatuses([]), "ALIVE");
  assert.equal(combineStatuses(["ALIVE"]), "ALIVE");
});

// --- judgeEntry / runInventory (integration over synthetic fixtures) ---

function withRepoFixture(fn) {
  withFixtureDir((repoDir) => {
    mkdirSync(join(repoDir, "scripts", "check"), { recursive: true });
    fn(repoDir);
  });
}

test("(30) judgeEntry: claude-settings target installed + matching + no claude_only requirement -> ALIVE", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "role-guard.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "role-guard.test.mjs"), "// stub\n", "utf8");
    const entry = {
      id: "role-guard",
      script: "scripts/check/role-guard.mjs",
      test: "scripts/check/role-guard.test.mjs",
      claude_only: false,
      install_targets: [
        { location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "PreToolUse", matcher: "Edit|Write", required: true },
      ],
    };
    const settingsByLocation = {
      "repo-settings": { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "node scripts/check/role-guard.mjs" }] }] } },
    };
    const result = judgeEntry(entry, { repoRoot: repoDir, settingsByLocation });
    assert.equal(result.status, "ALIVE");
  });
});

test("(31) judgeEntry: required claude-settings target missing -> NOT_INSTALLED (G6)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "role-guard.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "role-guard.test.mjs"), "// stub\n", "utf8");
    const entry = {
      id: "role-guard",
      script: "scripts/check/role-guard.mjs",
      test: "scripts/check/role-guard.test.mjs",
      claude_only: false,
      install_targets: [
        { location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "PreToolUse", matcher: "Edit|Write", required: true },
      ],
    };
    const result = judgeEntry(entry, { repoRoot: repoDir, settingsByLocation: { "repo-settings": { hooks: {} } } });
    assert.equal(result.status, "NOT_INSTALLED");
  });
});

test("(32) judgeEntry: script referenced by manifest doesn't exist -> SILENT_BROKEN (dead path, G6)", () => {
  withRepoFixture((repoDir) => {
    const entry = { id: "ghost-check", script: "scripts/check/ghost-check.mjs", test: null, claude_only: false, install_targets: [] };
    const result = judgeEntry(entry, { repoRoot: repoDir });
    assert.equal(result.status, "SILENT_BROKEN");
  });
});

test("(33) judgeEntry: claude_only + fully wired but no canary receipt -> UNJUDGABLE (G9)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "clear-safe-check.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "clear-safe-check.test.mjs"), "// stub\n", "utf8");
    const entry = {
      id: "clear-safe-check",
      script: "scripts/check/clear-safe-check.mjs",
      test: "scripts/check/clear-safe-check.test.mjs",
      claude_only: true,
      install_targets: [
        { location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "Stop", matcher: null, required: true },
      ],
    };
    const settingsByLocation = {
      "repo-settings": { hooks: { Stop: [{ hooks: [{ command: "node scripts/check/clear-safe-check.mjs" }] }] } },
    };
    const result = judgeEntry(entry, { repoRoot: repoDir, settingsByLocation, canaryDir: undefined });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(34) judgeEntry: claude_only + wired + fresh canary receipt -> ALIVE", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "clear-safe-check.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "clear-safe-check.test.mjs"), "// stub\n", "utf8");
    withFixtureDir((canaryDir) => {
      const now = new Date("2026-07-13T00:00:00Z").getTime();
      writeFileSync(
        join(canaryDir, "clear-safe-check.json"),
        JSON.stringify({ check_id: "clear-safe-check", checked_at: new Date(now - 3600000).toISOString(), bad_exit: 2, good_exit: 0 }),
        "utf8",
      );
      const entry = {
        id: "clear-safe-check",
        script: "scripts/check/clear-safe-check.mjs",
        test: "scripts/check/clear-safe-check.test.mjs",
        claude_only: true,
        install_targets: [
          { location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "Stop", matcher: null, required: true },
        ],
      };
      const settingsByLocation = {
        "repo-settings": { hooks: { Stop: [{ hooks: [{ command: "node scripts/check/clear-safe-check.mjs" }] }] } },
      };
      const result = judgeEntry(entry, { repoRoot: repoDir, settingsByLocation, canaryDir, now });
      assert.equal(result.status, "ALIVE");
    });
  });
});

test("(35) judgeEntry: install_targets=[] and no source_reference_check (orch-direct) -> ALIVE from script+test existence alone", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "relay-handshake.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "relay-handshake.test.mjs"), "// stub\n", "utf8");
    const entry = { id: "relay-handshake", script: "scripts/check/relay-handshake.mjs", test: "scripts/check/relay-handshake.test.mjs", claude_only: false, install_targets: [] };
    const result = judgeEntry(entry, { repoRoot: repoDir });
    assert.equal(result.status, "ALIVE");
  });
});

test("(36) runInventory: aggregates a manifest's worth of entries into a 5-state summary", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "a.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "a.test.mjs"), "// stub\n", "utf8");
    const manifest = {
      checks: [
        { id: "a", script: "scripts/check/a.mjs", test: "scripts/check/a.test.mjs", claude_only: false, install_targets: [] },
        { id: "ghost", script: "scripts/check/ghost.mjs", test: null, claude_only: false, install_targets: [] },
      ],
    };
    const { results, summary } = runInventory({ manifest, repoRoot: repoDir });
    assert.equal(results.length, 2);
    assert.equal(summary.ALIVE, 1);
    assert.equal(summary.SILENT_BROKEN, 1);
  });
});

// --- discoverCheckTestFiles ---

test("(37) discoverCheckTestFiles: lists only *.test.mjs basenames, sorted", () => {
  const fakeReaddir = () => ["b.test.mjs", "a.test.mjs", "a.mjs", "README.md"];
  assert.deepEqual(discoverCheckTestFiles("/any/path", fakeReaddir), ["a.test.mjs", "b.test.mjs"]);
});

// --- review-1 rejected fix: G6 "extra" detection must actually be wired
// into runInventory, not merely unit-tested in isolation ---

test("(38) expectedIdsForLocation: collects every entry's id whose install_targets include this location, across multiple targets", () => {
  const manifest = {
    checks: [
      {
        id: "context-inject",
        install_targets: [
          { location: "repo-settings", kind: "claude-settings" },
          { location: "repo-settings", kind: "claude-settings" },
        ],
      },
      { id: "pm-guard", install_targets: [{ location: "control-room-settings", kind: "claude-settings" }] },
    ],
  };
  assert.deepEqual(expectedIdsForLocation(manifest, "repo-settings"), ["context-inject"]);
  assert.deepEqual(expectedIdsForLocation(manifest, "control-room-settings"), ["pm-guard"]);
  assert.deepEqual(expectedIdsForLocation(manifest, "nowhere"), []);
});

test("(39) findExtraResults: a settings file with an unregistered hook command -> one DRIFT result naming it (G6 'extra', review-1 repro)", () => {
  const manifest = {
    checks: [{ id: "role-guard", install_targets: [{ location: "repo-settings", kind: "claude-settings" }] }],
  };
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "node scripts/check/role-guard.mjs" }] }],
        Stop: [{ hooks: [{ command: "node scripts/check/mystery-check.mjs" }] }],
      },
    },
  };
  const extras = findExtraResults(manifest, settingsByLocation);
  assert.equal(extras.length, 1);
  assert.equal(extras[0].status, "DRIFT");
  assert.match(extras[0].id, /^extra:repo-settings:mystery-check$/);
  assert.match(extras[0].evidence.join(" "), /mystery-check\.mjs/);
  assert.match(extras[0].evidence.join(" "), /Stop/);
});

test("(40) findExtraResults: nothing unexpected anywhere -> []", () => {
  const manifest = {
    checks: [{ id: "role-guard", install_targets: [{ location: "repo-settings", kind: "claude-settings" }] }],
  };
  const settingsByLocation = {
    "repo-settings": { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "node scripts/check/role-guard.mjs" }] }] } },
  };
  assert.deepEqual(findExtraResults(manifest, settingsByLocation), []);
});

test("(41) findExtraResults: unresolved/null settings for a location -> skipped, never throws", () => {
  const manifest = { checks: [] };
  assert.deepEqual(findExtraResults(manifest, { "repo-settings": null, "other-settings": undefined }), []);
});

test("(42) runInventory: end-to-end -- role-guard wired normally + an unregistered mystery-check hook in the SAME settings file -> the extra is surfaced in runInventory's own results/summary (review-1's exact reproduction, not just the isolated helper)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(join(repoDir, "scripts", "check", "role-guard.mjs"), "// stub\n", "utf8");
    writeFileSync(join(repoDir, "scripts", "check", "role-guard.test.mjs"), "// stub\n", "utf8");
    const manifest = {
      checks: [
        {
          id: "role-guard",
          script: "scripts/check/role-guard.mjs",
          test: "scripts/check/role-guard.test.mjs",
          claude_only: false,
          install_targets: [
            { location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "PreToolUse", matcher: "Edit|Write", required: true },
          ],
        },
      ],
    };
    const settingsByLocation = {
      "repo-settings": {
        hooks: {
          PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "node scripts/check/role-guard.mjs" }] }],
          Stop: [{ hooks: [{ command: "node scripts/check/mystery-check.mjs" }] }],
        },
      },
    };
    const { results, summary } = runInventory({ manifest, repoRoot: repoDir, settingsByLocation });
    assert.equal(results.find((r) => r.id === "role-guard").status, "ALIVE");
    const extra = results.find((r) => r.id.startsWith("extra:"));
    assert.ok(extra, "runInventory must surface the extra hook, not just findExtraResults in isolation");
    assert.equal(extra.status, "DRIFT");
    assert.equal(summary.DRIFT, 1, "extra must be counted in the 5-state summary");
  });
});
