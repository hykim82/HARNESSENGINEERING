import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
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
  checkEnforcementInventoryRegistration,
  checkHookSetAdditive,
  checkHookWiringRegistered,
  EXPECTED_INJECTED_HOOKS,
  checkControlRoomDoc,
  parseRunnerTestDirs,
} from "./selfcheck-inventory.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
      const out = execFileSync("where", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
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
  let ok;
  try {
    mkdirSync(join(dir, "scripts", "check"), { recursive: true });
    for (const f of ["a.test.mjs", "b.test.mjs"])
      writeFileSync(join(dir, "scripts", "check", f), "//\n", "utf8");
    // (1) the glob must expand POSIX-style to both fixture files in argv
    const script = `set -- scripts/check/*.test.mjs\nfor a in "$@"; do echo "ARG:$a"; done`;
    const out = execFileSync(cmd, ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const argv = out
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    ok = ["a.test.mjs", "b.test.mjs"].every((f) =>
      argv.some((a) => a.endsWith(f)),
    );
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
  const list = candidates ?? [
    "sh",
    ...GIT_FOR_WINDOWS_SHELLS,
    "bash",
    ...whereResults(["sh", "bash"]),
  ];
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
  const out = execFileSync(POSIX_SHELL, ["-c", script], {
    cwd,
    encoding: "utf8",
  });
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
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: 'node "scripts/check/role-guard.mjs"' },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node scripts/check/status-fresh.mjs --status x",
            },
          ],
        },
      ],
    },
  };
  const result = parseHookCommands(settings);
  assert.deepEqual(result, [
    {
      hookEvent: "PreToolUse",
      matcher: "Edit|Write",
      command: 'node "scripts/check/role-guard.mjs"',
    },
    {
      hookEvent: "Stop",
      matcher: null,
      command: "node scripts/check/status-fresh.mjs --status x",
    },
  ]);
});

test("(2) parseHookCommands: missing/malformed hooks object -> []", () => {
  assert.deepEqual(parseHookCommands({}), []);
  assert.deepEqual(parseHookCommands(null), []);
  assert.deepEqual(parseHookCommands({ hooks: "not-an-object" }), []);
  assert.deepEqual(parseHookCommands({ hooks: { Stop: "not-an-array" } }), []);
});

test("(3) extractCheckScriptId: extracts id from forward- or back-slash command", () => {
  assert.equal(
    extractCheckScriptId(
      'node "$CLAUDE_PROJECT_DIR/scripts/check/role-guard.mjs"',
    ),
    "role-guard",
  );
  assert.equal(
    extractCheckScriptId(
      "node C:\\repo\\scripts\\check\\controlroom-fresh.mjs --x",
    ),
    "controlroom-fresh",
  );
});

test("(4) extractCheckScriptId: non-check command (e.g. notification balloon) -> null", () => {
  assert.equal(
    extractCheckScriptId("Add-Type -AssemblyName System.Windows.Forms"),
    null,
  );
  assert.equal(extractCheckScriptId(null), null);
  assert.equal(extractCheckScriptId(undefined), null);
});

// --- findInstalledTarget / findExtraInvocations (G6) ---

test("(5) findInstalledTarget: installed with matching matcher -> installed:true", () => {
  const hookCommands = [
    {
      hookEvent: "PreToolUse",
      matcher: "Edit|Write",
      command: "node scripts/check/role-guard.mjs",
    },
  ];
  const result = findInstalledTarget(hookCommands, {
    id: "role-guard",
    hookEvent: "PreToolUse",
    matcher: "Edit|Write",
  });
  assert.equal(result.installed, true);
  assert.equal(result.matcherMismatch, false);
});

test("(6) findInstalledTarget: missing entirely -> installed:false (G6 'missing')", () => {
  const result = findInstalledTarget([], {
    id: "role-guard",
    hookEvent: "PreToolUse",
    matcher: "Edit|Write",
  });
  assert.equal(result.installed, false);
});

test("(7) findInstalledTarget: installed but matcher differs -> matcherMismatch:true", () => {
  const hookCommands = [
    {
      hookEvent: "PreToolUse",
      matcher: "Edit",
      command: "node scripts/check/role-guard.mjs",
    },
  ];
  const result = findInstalledTarget(hookCommands, {
    id: "role-guard",
    hookEvent: "PreToolUse",
    matcher: "Edit|Write",
  });
  assert.equal(result.installed, true);
  assert.equal(result.matcherMismatch, true);
});

test("(8) findExtraInvocations: a hook command referencing an id not in expectedIds -> flagged extra (G6 'extra')", () => {
  const hookCommands = [
    {
      hookEvent: "Stop",
      matcher: null,
      command: "node scripts/check/status-fresh.mjs",
    },
    {
      hookEvent: "Stop",
      matcher: null,
      command: "node scripts/check/mystery-check.mjs",
    },
  ];
  const extras = findExtraInvocations(hookCommands, ["status-fresh"]);
  assert.deepEqual(extras, ["mystery-check"]);
});

test("(9) findExtraInvocations: nothing unexpected -> []", () => {
  const hookCommands = [
    {
      hookEvent: "Stop",
      matcher: null,
      command: "node scripts/check/status-fresh.mjs",
    },
  ];
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
    const result = checkNativeGitHook({
      versionedPath,
      installedPath: join(dir, "does-not-exist"),
    });
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
    const result = checkNativeGitHook({
      versionedPath: join(dir, "nope"),
      installedPath: join(dir, "also-nope"),
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(14) sha256Hex: deterministic, differs for different content", () => {
  assert.equal(sha256Hex("a"), sha256Hex("a"));
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});

// --- checkCanaryReceipt (G9) ---

test("(15) checkCanaryReceipt: no canaryDir given -> UNJUDGABLE", () => {
  const result = checkCanaryReceipt({
    id: "clear-safe-check",
    canaryDir: undefined,
  });
  assert.equal(result.status, "UNJUDGABLE");
});

test("(16) checkCanaryReceipt: receipt file missing -> UNJUDGABLE (G9 'missing receipt fixture')", () => {
  withFixtureDir((dir) => {
    const result = checkCanaryReceipt({
      id: "clear-safe-check",
      canaryDir: dir,
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(17) checkCanaryReceipt: fresh, complete, matching receipt -> ALIVE", () => {
  withFixtureDir((dir) => {
    const now = new Date("2026-07-13T00:00:00+09:00").getTime();
    writeFileSync(
      join(dir, "clear-safe-check.json"),
      JSON.stringify({
        check_id: "clear-safe-check",
        checked_at: "2026-07-12T23:00:00+09:00",
        bad_exit: 2,
        good_exit: 0,
      }),
      "utf8",
    );
    const result = checkCanaryReceipt({
      id: "clear-safe-check",
      canaryDir: dir,
      now,
    });
    assert.equal(result.status, "ALIVE");
  });
});

test("(18) checkCanaryReceipt: missing required field -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    writeFileSync(
      join(dir, "clear-safe-check.json"),
      JSON.stringify({
        check_id: "clear-safe-check",
        checked_at: "2026-07-12T23:00:00+09:00",
      }),
      "utf8",
    );
    const result = checkCanaryReceipt({
      id: "clear-safe-check",
      canaryDir: dir,
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(19) checkCanaryReceipt: check_id mismatch -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    writeFileSync(
      join(dir, "clear-safe-check.json"),
      JSON.stringify({
        check_id: "controlroom-fresh",
        checked_at: "2026-07-12T23:00:00+09:00",
        bad_exit: 2,
        good_exit: 0,
      }),
      "utf8",
    );
    const result = checkCanaryReceipt({
      id: "clear-safe-check",
      canaryDir: dir,
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(20) checkCanaryReceipt: stale (older than maxAgeMs) -> UNJUDGABLE", () => {
  withFixtureDir((dir) => {
    const now = new Date("2026-07-13T00:00:00Z").getTime();
    const old = new Date(
      now - (DEFAULT_CANARY_MAX_AGE_MS + 3600000),
    ).toISOString();
    writeFileSync(
      join(dir, "clear-safe-check.json"),
      JSON.stringify({
        check_id: "clear-safe-check",
        checked_at: old,
        bad_exit: 2,
        good_exit: 0,
      }),
      "utf8",
    );
    const result = checkCanaryReceipt({
      id: "clear-safe-check",
      canaryDir: dir,
      now,
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(21) checkCanaryReceipt: malformed JSON -> UNJUDGABLE, never throws", () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, "clear-safe-check.json"), "not-json", "utf8");
    const result = checkCanaryReceipt({
      id: "clear-safe-check",
      canaryDir: dir,
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

// --- resolvePlaceholderPath ---

test("(22) resolvePlaceholderPath: resolves REPO/CONTROL_ROOM/USER_HOME placeholders", () => {
  const roots = {
    REPO: "/repo",
    CONTROL_ROOM: "/control",
    USER_HOME: "/home/x",
  };
  assert.equal(
    resolvePlaceholderPath("REPO/.claude/settings.local.json", roots),
    join("/repo", ".claude/settings.local.json"),
  );
  assert.equal(
    resolvePlaceholderPath("CONTROL_ROOM/.claude/settings.local.json", roots),
    join("/control", ".claude/settings.local.json"),
  );
  assert.equal(
    resolvePlaceholderPath("USER_HOME/.claude-team/settings.json", roots),
    join("/home/x", ".claude-team/settings.json"),
  );
});

test("(23) resolvePlaceholderPath: unknown placeholder or missing root -> null", () => {
  assert.equal(resolvePlaceholderPath("NOPE/x", { REPO: "/repo" }), null);
  assert.equal(resolvePlaceholderPath("USER_HOME/x", {}), null);
});

// --- checkSourceReference (packet-gate's indirect wiring) ---

test("(24) checkSourceReference: caller file still contains the pattern -> ALIVE", () => {
  withFixtureDir((dir) => {
    const file = join(dir, "role-guard.mjs");
    writeFileSync(
      file,
      'import { checkPacketGate } from "./packet-gate.mjs";\n',
      "utf8",
    );
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
    const result = checkSourceReference({
      file: join(dir, "does-not-exist.mjs"),
      pattern: "packet-gate.mjs",
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

// --- checkCiCoverage ---

test("(27) checkCiCoverage: all test files referenced -> ALIVE", () => {
  const result = checkCiCoverage({
    workflowText:
      "run: node scripts/check/a.test.mjs\nrun: node scripts/check/b.test.mjs\n",
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
    workflowText:
      "      - name: check test suites (all scripts/check/*.test.mjs)\n        run: node --test scripts/check/*.test.mjs\n",
    testFiles: [
      "a.test.mjs",
      "b.test.mjs",
      "brand-new-never-named-anywhere.test.mjs",
    ],
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
  for (const frag of [
    "scripts/check/*.test.mjs;echo done",
    "scripts/check/*.test.mjs|cat",
  ]) {
    const result = checkCiCoverage({
      workflowText: `run: node --test ${frag}\n`,
      testFiles: ["a.test.mjs", "b.test.mjs"],
    });
    assert.equal(
      result.status,
      "ALIVE",
      `fragment '${frag}' should be full coverage`,
    );
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
  assert.equal(
    coversViaCheckDirGlob("node --test scripts/check/*.test.mjs"),
    true,
  );
  assert.equal(
    coversViaCheckDirGlob("node --test scripts/check/*.test.mjs&&x"),
    true,
  );
  assert.equal(
    coversViaCheckDirGlob('node --test "scripts/check/*.test.mjs"'),
    false,
  );
  assert.equal(
    coversViaCheckDirGlob("node --test 'scripts/check/*.test.mjs'"),
    false,
  );
  assert.equal(
    coversViaCheckDirGlob("node --test scripts/check/*check.test.mjs"),
    false,
  );
  assert.equal(
    coversViaCheckDirGlob("node --test scripts/check/*.test.mjs.bak"),
    false,
  );
  assert.equal(
    coversViaCheckDirGlob("node --test xscripts/check/*.test.mjs"),
    false,
  );
  assert.equal(
    coversViaCheckDirGlob("node --test scripts/other/*.test.mjs"),
    false,
  );
});

test("(28r) coversViaCheckDirGlob: a quoted directory prefix with the '*' left UNQUOTED still expands in Bash -> true (matches real shell)", () => {
  // Bash: `"scripts/check/"*.test.mjs` -> prefix quoted, `*` unquoted -> expands.
  assert.equal(
    coversViaCheckDirGlob('node --test "scripts/check/"*.test.mjs'),
    true,
  );
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
      for (const f of expected)
        writeFileSync(join(dir, "scripts", "check", f), "// stub\n", "utf8");

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
      for (const f of expected)
        writeFileSync(join(dir, "scripts", "check", f), "// stub\n", "utf8");

      const frag = "'scripts/check/*.test.mjs'";
      const realRuns = bashSuiteRuns(dir, frag, expected);
      assert.equal(
        realRuns,
        false,
        "sanity: sh must NOT expand a single-quoted glob",
      );
      const verdict = checkCiCoverage({
        workflowText: `run: node --test ${frag}\n`,
        testFiles: expected,
      });
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
  const found = findPosixShell({
    probe,
    candidates: ["sh", "bash", "/opt/git/usr/bin/bash", "never-reached"],
  });
  assert.equal(found, "/opt/git/usr/bin/bash");
  assert.deepEqual(probed, ["sh", "bash", "/opt/git/usr/bin/bash"]);
});

test("(28v) findPosixShell: no candidate works -> null (this is the honest-skip path, not a crash)", () => {
  const found = findPosixShell({
    probe: () => false,
    candidates: ["sh", "bash", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"],
  });
  assert.equal(found, null);
});

test("(28w) oracle shell diagnostic: records which shell the real-Bash oracle used, so 28s/28t running-vs-skipping is auditable", () => {
  // Deliberately NOT an assertion that a shell exists -- a shell-less box keeps
  // the honest skip. This just surfaces the resolved path in the output so a
  // reviewer can confirm the oracle actually executed rather than silently
  // skipping (the exact gap review-8 found in coder-8).
  console.log(
    `[oracle-shell] findPosixShell -> ${POSIX_SHELL ?? "NONE (28s/28t honestly skipped)"}`,
  );
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
  assert.equal(
    found,
    gitBash,
    "WSL bash must not be selected once it fails the functional probe",
  );
  assert.deepEqual(
    probed,
    [wsl, gitBash],
    "probed the bad one, rejected it, accepted the good one, stopped",
  );
});

test(
  "(28w3) functionalShellProbe: accepts a real POSIX shell (glob expands + cwd releases cleanly) and rejects a missing/non-shell binary",
  { skip: SHELL_SKIP },
  () => {
    assert.equal(
      functionalShellProbe(POSIX_SHELL),
      true,
      "the resolved shell must pass its own functional probe",
    );
    assert.equal(
      functionalShellProbe("definitely-not-a-real-shell-binary-xyz"),
      false,
      "a missing binary must be rejected, not throw",
    );
  },
);

// --- extractRunText (review-8 defect 1): only the run: steps execute, so only
// they may count as coverage. name:, other keys, and YAML comments are out. ---

test("(28x) extractRunText: an inline scalar yields just the command", () => {
  assert.equal(
    extractRunText("        run: node --test scripts/check/*.test.mjs\n"),
    "node --test scripts/check/*.test.mjs",
  );
});

test("(28y) extractRunText: a whole-command YAML quote is stripped (YAML quotes are not shell quotes)", () => {
  assert.equal(
    extractRunText('        run: "node --test scripts/check/*.test.mjs"\n'),
    "node --test scripts/check/*.test.mjs",
  );
  assert.equal(
    extractRunText("        run: 'node --test scripts/check/*.test.mjs'\n"),
    "node --test scripts/check/*.test.mjs",
  );
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
  assert.ok(
    out.includes("sh -n hooks/commit-msg"),
    "block body line 1 present",
  );
  assert.ok(
    out.includes("sh -n hooks/pre-commit"),
    "block body line 2 present",
  );
  assert.ok(
    out.includes("echo hi"),
    "the sibling step's inline run is also captured",
  );
  assert.ok(
    !/(^|\n) {2,}sh -n/.test(out),
    "block body must be dedented (no leading indent survives)",
  );
  assert.ok(
    !out.includes("hooks POSIX syntax check"),
    "step name: must NOT leak into run text",
  );
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
  assert.equal(
    extractRunText("        run: echo one\n        run: echo two\n"),
    "echo one\necho two",
  );
});

test("(28ac) extractRunText: the '- run:' form (no separate name key) is captured, block dedented", () => {
  const yaml = ["      - run: |", "          echo a", "          echo b"].join(
    "\n",
  );
  const out = extractRunText(yaml);
  assert.ok(out.includes("echo a") && out.includes("echo b"));
});

// --- decodeYamlScalar (review-9 defect 2): YAML quoting is decoded BEFORE the
// shell tokenizer runs, so the two quoting layers don't get conflated. ---

test("(28ac2) decodeYamlScalar: plain scalar is verbatim; any quotes in it are literal shell quotes", () => {
  assert.equal(decodeYamlScalar('node --test "x"'), 'node --test "x"');
  assert.equal(
    decodeYamlScalar("  node --test scripts/check/*.test.mjs  "),
    "node --test scripts/check/*.test.mjs",
  );
});

test("(28ac3) decodeYamlScalar: single-quoted scalar removes outer quotes and decodes '' -> ' (the review-9 case)", () => {
  // YAML `'node --test ''scripts/check/*.test.mjs'''` -> the shell string
  // `node --test 'scripts/check/*.test.mjs'` (glob single-quoted at shell level).
  assert.equal(
    decodeYamlScalar("'node --test ''scripts/check/*.test.mjs'''"),
    "node --test 'scripts/check/*.test.mjs'",
  );
  assert.equal(
    decodeYamlScalar("'plain single quoted'"),
    "plain single quoted",
  );
});

test("(28ac4) decodeYamlScalar: double-quoted scalar removes outer quotes and resolves backslash escapes", () => {
  assert.equal(
    decodeYamlScalar('"node --test scripts/check/*.test.mjs"'),
    "node --test scripts/check/*.test.mjs",
  );
  assert.equal(decodeYamlScalar('"say \\"hi\\""'), 'say "hi"');
});

test("(28ac5) decodeYamlScalar: an ambiguous/unbalanced quoted scalar -> '' (bias to DRIFT, never a false ALIVE)", () => {
  assert.equal(decodeYamlScalar("'unterminated"), "");
  assert.equal(decodeYamlScalar("'a' trailing junk"), "");
  assert.equal(decodeYamlScalar('"a" then more'), "");
});

test("(28ac6) checkCiCoverage: review-9 repro -- YAML single-quoted glob `run: 'node --test ''scripts/check/*.test.mjs'''` -> DRIFT (after YAML decode the glob is shell-single-quoted and expands to nothing)", () => {
  const workflowText =
    "        run: 'node --test ''scripts/check/*.test.mjs'''\n";
  const result = checkCiCoverage({
    workflowText,
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["a.test.mjs", "b.test.mjs"]);
});

test("(28ac7) checkCiCoverage: a whole-command YAML single-quote wrapper (no inner '') -> ALIVE (YAML quotes are not shell quotes, glob expands unquoted)", () => {
  const workflowText = "        run: 'node --test scripts/check/*.test.mjs'\n";
  const result = checkCiCoverage({
    workflowText,
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "ALIVE");
});

// --- review-8 defect 1 repros: coverage credited ONLY from run: text ---

test("(28ad) checkCiCoverage: whole-dir glob in a step name: but run: runs one file -> DRIFT (name: executes nothing; review-8 repro)", () => {
  const workflowText = [
    "      - name: check test suites (all scripts/check/*.test.mjs)",
    "        run: node --test scripts/check/a.test.mjs",
    "",
  ].join("\n");
  const result = checkCiCoverage({
    workflowText,
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
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
  const result = checkCiCoverage({
    workflowText,
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["b.test.mjs"]);
});

test("(28af) checkCiCoverage: the REAL enforce.yml shape (glob in BOTH name: and run:) -> ALIVE (the run: glob is present and is what counts)", () => {
  const workflowText = [
    "      - name: check test suites (all scripts/check/*.test.mjs)",
    "        run: node --test scripts/check/*.test.mjs",
    "",
  ].join("\n");
  const result = checkCiCoverage({
    workflowText,
    testFiles: ["a.test.mjs", "b.test.mjs", "brand-new.test.mjs"],
  });
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
  const result = checkCiCoverage({
    workflowText,
    testFiles: ["a.test.mjs", "b.test.mjs"],
  });
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
    writeFileSync(
      join(repoDir, "scripts", "check", "role-guard.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "role-guard.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const entry = {
      id: "role-guard",
      script: "scripts/check/role-guard.mjs",
      test: "scripts/check/role-guard.test.mjs",
      claude_only: false,
      install_targets: [
        {
          location: "repo-settings",
          kind: "claude-settings",
          path: "REPO/.claude/settings.local.json",
          hook_event: "PreToolUse",
          matcher: "Edit|Write",
          required: true,
        },
      ],
    };
    const settingsByLocation = {
      "repo-settings": {
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [{ command: "node scripts/check/role-guard.mjs" }],
            },
          ],
        },
      },
    };
    const result = judgeEntry(entry, { repoRoot: repoDir, settingsByLocation });
    assert.equal(result.status, "ALIVE");
  });
});

test("(31) judgeEntry: required claude-settings target missing -> NOT_INSTALLED (G6)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "role-guard.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "role-guard.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const entry = {
      id: "role-guard",
      script: "scripts/check/role-guard.mjs",
      test: "scripts/check/role-guard.test.mjs",
      claude_only: false,
      install_targets: [
        {
          location: "repo-settings",
          kind: "claude-settings",
          path: "REPO/.claude/settings.local.json",
          hook_event: "PreToolUse",
          matcher: "Edit|Write",
          required: true,
        },
      ],
    };
    const result = judgeEntry(entry, {
      repoRoot: repoDir,
      settingsByLocation: { "repo-settings": { hooks: {} } },
    });
    assert.equal(result.status, "NOT_INSTALLED");
  });
});

test("(32) judgeEntry: script referenced by manifest doesn't exist -> SILENT_BROKEN (dead path, G6)", () => {
  withRepoFixture((repoDir) => {
    const entry = {
      id: "ghost-check",
      script: "scripts/check/ghost-check.mjs",
      test: null,
      claude_only: false,
      install_targets: [],
    };
    const result = judgeEntry(entry, { repoRoot: repoDir });
    assert.equal(result.status, "SILENT_BROKEN");
  });
});

test("(33) judgeEntry: claude_only + fully wired but no canary receipt -> UNJUDGABLE (G9)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "clear-safe-check.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "clear-safe-check.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const entry = {
      id: "clear-safe-check",
      script: "scripts/check/clear-safe-check.mjs",
      test: "scripts/check/clear-safe-check.test.mjs",
      claude_only: true,
      install_targets: [
        {
          location: "repo-settings",
          kind: "claude-settings",
          path: "REPO/.claude/settings.local.json",
          hook_event: "Stop",
          matcher: null,
          required: true,
        },
      ],
    };
    const settingsByLocation = {
      "repo-settings": {
        hooks: {
          Stop: [
            { hooks: [{ command: "node scripts/check/clear-safe-check.mjs" }] },
          ],
        },
      },
    };
    const result = judgeEntry(entry, {
      repoRoot: repoDir,
      settingsByLocation,
      canaryDir: undefined,
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(34) judgeEntry: claude_only + wired + fresh canary receipt -> ALIVE", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "clear-safe-check.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "clear-safe-check.test.mjs"),
      "// stub\n",
      "utf8",
    );
    withFixtureDir((canaryDir) => {
      const now = new Date("2026-07-13T00:00:00Z").getTime();
      writeFileSync(
        join(canaryDir, "clear-safe-check.json"),
        JSON.stringify({
          check_id: "clear-safe-check",
          checked_at: new Date(now - 3600000).toISOString(),
          bad_exit: 2,
          good_exit: 0,
        }),
        "utf8",
      );
      const entry = {
        id: "clear-safe-check",
        script: "scripts/check/clear-safe-check.mjs",
        test: "scripts/check/clear-safe-check.test.mjs",
        claude_only: true,
        install_targets: [
          {
            location: "repo-settings",
            kind: "claude-settings",
            path: "REPO/.claude/settings.local.json",
            hook_event: "Stop",
            matcher: null,
            required: true,
          },
        ],
      };
      const settingsByLocation = {
        "repo-settings": {
          hooks: {
            Stop: [
              {
                hooks: [{ command: "node scripts/check/clear-safe-check.mjs" }],
              },
            ],
          },
        },
      };
      const result = judgeEntry(entry, {
        repoRoot: repoDir,
        settingsByLocation,
        canaryDir,
        now,
      });
      assert.equal(result.status, "ALIVE");
    });
  });
});

test("(35) judgeEntry: install_targets=[] and no source_reference_check (orch-direct) -> ALIVE from script+test existence alone", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "relay-handshake.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "relay-handshake.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const entry = {
      id: "relay-handshake",
      script: "scripts/check/relay-handshake.mjs",
      test: "scripts/check/relay-handshake.test.mjs",
      claude_only: false,
      install_targets: [],
    };
    const result = judgeEntry(entry, { repoRoot: repoDir });
    assert.equal(result.status, "ALIVE");
  });
});

test("(36) runInventory: aggregates a manifest's worth of entries into a 5-state summary", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "a.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "a.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const manifest = {
      checks: [
        {
          id: "a",
          script: "scripts/check/a.mjs",
          test: "scripts/check/a.test.mjs",
          claude_only: false,
          install_targets: [],
        },
        {
          id: "ghost",
          script: "scripts/check/ghost.mjs",
          test: null,
          claude_only: false,
          install_targets: [],
        },
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
  assert.deepEqual(discoverCheckTestFiles("/any/path", fakeReaddir), [
    "a.test.mjs",
    "b.test.mjs",
  ]);
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
      {
        id: "pm-guard",
        install_targets: [
          { location: "control-room-settings", kind: "claude-settings" },
        ],
      },
    ],
  };
  assert.deepEqual(expectedIdsForLocation(manifest, "repo-settings"), [
    "context-inject",
  ]);
  assert.deepEqual(expectedIdsForLocation(manifest, "control-room-settings"), [
    "pm-guard",
  ]);
  assert.deepEqual(expectedIdsForLocation(manifest, "nowhere"), []);
});

test("(39) findExtraResults: a settings file with an unregistered hook command -> one DRIFT result naming it (G6 'extra', review-1 repro)", () => {
  const manifest = {
    checks: [
      {
        id: "role-guard",
        install_targets: [
          { location: "repo-settings", kind: "claude-settings" },
        ],
      },
    ],
  };
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ command: "node scripts/check/role-guard.mjs" }],
          },
        ],
        Stop: [
          { hooks: [{ command: "node scripts/check/mystery-check.mjs" }] },
        ],
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
    checks: [
      {
        id: "role-guard",
        install_targets: [
          { location: "repo-settings", kind: "claude-settings" },
        ],
      },
    ],
  };
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ command: "node scripts/check/role-guard.mjs" }],
          },
        ],
      },
    },
  };
  assert.deepEqual(findExtraResults(manifest, settingsByLocation), []);
});

test("(41) findExtraResults: unresolved/null settings for a location -> skipped, never throws", () => {
  const manifest = { checks: [] };
  assert.deepEqual(
    findExtraResults(manifest, {
      "repo-settings": null,
      "other-settings": undefined,
    }),
    [],
  );
});

test("(42) runInventory: end-to-end -- role-guard wired normally + an unregistered mystery-check hook in the SAME settings file -> the extra is surfaced in runInventory's own results/summary (review-1's exact reproduction, not just the isolated helper)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "role-guard.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "role-guard.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const manifest = {
      checks: [
        {
          id: "role-guard",
          script: "scripts/check/role-guard.mjs",
          test: "scripts/check/role-guard.test.mjs",
          claude_only: false,
          install_targets: [
            {
              location: "repo-settings",
              kind: "claude-settings",
              path: "REPO/.claude/settings.local.json",
              hook_event: "PreToolUse",
              matcher: "Edit|Write",
              required: true,
            },
          ],
        },
      ],
    };
    const settingsByLocation = {
      "repo-settings": {
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [{ command: "node scripts/check/role-guard.mjs" }],
            },
          ],
          Stop: [
            { hooks: [{ command: "node scripts/check/mystery-check.mjs" }] },
          ],
        },
      },
    };
    const { results, summary } = runInventory({
      manifest,
      repoRoot: repoDir,
      settingsByLocation,
    });
    assert.equal(results.find((r) => r.id === "role-guard").status, "ALIVE");
    const extra = results.find((r) => r.id.startsWith("extra:"));
    assert.ok(
      extra,
      "runInventory must surface the extra hook, not just findExtraResults in isolation",
    );
    assert.equal(extra.status, "DRIFT");
    assert.equal(
      summary.DRIFT,
      1,
      "extra must be counted in the 5-state summary",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-160 라이더ⓐ: checkEnforcementInventoryRegistration (ENFORCEMENT_INVENTORY_MISSING)
// ---------------------------------------------------------------------------

function ledgerManifestWithNoTargets(id) {
  return {
    schema_version: 1,
    checks: [
      {
        id,
        script: `scripts/check/${id}.mjs`,
        test: null,
        install_targets: [],
      },
    ],
  };
}

test("(43) known-bad: a hook wired in settings but registered with install_targets:[] -> ENFORCEMENT_INVENTORY_MISSING (synthetic fixture, fail-closed)", () => {
  const manifest = ledgerManifestWithNoTargets("some-guard");
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ command: "node scripts/check/some-guard.mjs" }],
          },
        ],
      },
    },
  };
  const result = checkEnforcementInventoryRegistration({
    manifest,
    settingsByLocation,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^ENFORCEMENT_INVENTORY_MISSING/);
  assert.match(result.reason, /some-guard/);
});

test("(44) paired good: same fixture, install_targets entry restored to match the real wiring -> PASS", () => {
  const manifest = {
    schema_version: 1,
    checks: [
      {
        id: "some-guard",
        script: "scripts/check/some-guard.mjs",
        test: null,
        install_targets: [
          {
            location: "repo-settings",
            kind: "claude-settings",
            path: "REPO/.claude/settings.local.json",
            hook_event: "PreToolUse",
            matcher: "Edit|Write",
            required: true,
          },
        ],
      },
    ],
  };
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ command: "node scripts/check/some-guard.mjs" }],
          },
        ],
      },
    },
  };
  const result = checkEnforcementInventoryRegistration({
    manifest,
    settingsByLocation,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(45) known-bad: no wired hooks at all beyond what's registered -> PASS (nothing to flag, not falsely BLOCK)", () => {
  const manifest = ledgerManifestWithNoTargets("some-guard");
  const result = checkEnforcementInventoryRegistration({
    manifest,
    settingsByLocation: {},
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(46) forbidden side effect: checkEnforcementInventoryRegistration never mutates the manifest or settings objects passed in", () => {
  const manifest = ledgerManifestWithNoTargets("some-guard");
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ command: "node scripts/check/some-guard.mjs" }],
          },
        ],
      },
    },
  };
  const manifestBefore = JSON.stringify(manifest);
  const settingsBefore = JSON.stringify(settingsByLocation);
  checkEnforcementInventoryRegistration({ manifest, settingsByLocation });
  assert.equal(JSON.stringify(manifest), manifestBefore);
  assert.equal(JSON.stringify(settingsByLocation), settingsBefore);
});

// HYK-160-coder-8 (PR #37 enforce CI fail): `.claude/settings.local.json` is
// git-untracked by design (C2-0/HYK-160-coder-4 confirmed this directly --
// a fresh worktree/CI checkout never has it). Local runs on this machine DO
// have the real file, so this test's job is a live-wiring regression guard
// there; on a CI runner (or any other checkout without it) there is no live
// wiring to audit at all -- that gap is covered by the local weekly
// selfcheck loop instead (게이트-기준.md 주간 루프), not by this suite.
//
// The skip decision itself is a pure function (`resolveRealRepoGuard47`) so
// its three states -- absent (skip, exact reason), present+drifted (still
// FAIL, never swallowed), present+matching (PASS) -- can each be pinned by
// a test without relying on node:test's own skip semantics to prove the
// point. A path can be injected so the "absent" state is exercised
// deterministically, never by moving/deleting the real file.
const CI_MISSING_SETTINGS_SKIP_REASON =
  "live wiring file '.claude/settings.local.json' is local-only (git-untracked) -- CI has no live wiring to audit here; local weekly selfcheck covers this gap";

export function resolveRealRepoGuard47({
  repoRoot,
  settingsPathOverride,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
}) {
  const settingsPath =
    settingsPathOverride ?? join(repoRoot, ".claude", "settings.local.json");
  if (!existsFn(settingsPath)) {
    return { outcome: "skip", reason: CI_MISSING_SETTINGS_SKIP_REASON };
  }
  const manifest = JSON.parse(
    readFileFn(
      join(repoRoot, "scripts", "check", "enforcement-inventory.json"),
    ),
  );
  const settings = JSON.parse(readFileFn(settingsPath));
  const result = checkEnforcementInventoryRegistration({
    manifest,
    settingsByLocation: { "repo-settings": settings },
  });
  return {
    outcome: result.status === "PASS" ? "pass" : "fail",
    reason: result.reason,
  };
}

test("(47) real-repo regression guard: the actual enforcement-inventory.json + the actual repo .claude/settings.local.json agree (report-style-guard drift closed, HYK-160 라이더ⓐ)", (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const result = resolveRealRepoGuard47({ repoRoot });
  if (result.outcome === "skip") {
    t.skip(result.reason);
    return;
  }
  assert.equal(result.outcome, "pass", result.reason);
});

test("(47b) skip-decision counterfactual: settings path missing (injected) -> deterministic skip with the exact reason, never a crash", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const result = resolveRealRepoGuard47({
    repoRoot,
    settingsPathOverride: join(
      repoRoot,
      "does-not-exist",
      "settings.local.json",
    ),
  });
  assert.equal(result.outcome, "skip");
  assert.equal(result.reason, CI_MISSING_SETTINGS_SKIP_REASON);
});

test("(47c) skip-decision counterfactual: settings path present in a synthetic fixture but drifted -> FAIL, skip never swallows a real failure", () => {
  withFixtureDir((dir) => {
    const checkDir = join(dir, "scripts", "check");
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(
      join(checkDir, "enforcement-inventory.json"),
      JSON.stringify({ schema_version: 1, checks: [] }),
      "utf8",
    );
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit",
              hooks: [{ command: "node scripts/check/some-guard.mjs" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const result = resolveRealRepoGuard47({ repoRoot: dir });
    assert.equal(result.outcome, "fail");
    assert.match(result.reason, /^ENFORCEMENT_INVENTORY_MISSING/);
  });
});

test("(47d) skip-decision counterfactual: settings path present in a synthetic fixture and matching -> PASS", () => {
  withFixtureDir((dir) => {
    const checkDir = join(dir, "scripts", "check");
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(
      join(checkDir, "enforcement-inventory.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          {
            id: "some-guard",
            script: "scripts/check/some-guard.mjs",
            test: null,
            install_targets: [
              {
                location: "repo-settings",
                kind: "claude-settings",
                path: "REPO/.claude/settings.local.json",
                hook_event: "PreToolUse",
                matcher: "Edit",
                required: true,
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit",
              hooks: [{ command: "node scripts/check/some-guard.mjs" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const result = resolveRealRepoGuard47({ repoRoot: dir });
    assert.equal(result.outcome, "pass", result.reason);
  });
});

// ---------------------------------------------------------------------------
// HYK-160 라이더ⓑ: checkHookSetAdditive (HOOK_SET_DRIFT) / checkHookWiringRegistered (HOOK_WIRING_MISSING)
// ---------------------------------------------------------------------------

function allExpectedHooksWired() {
  // Synthesizes exactly the 10 expected hook-command instances into two
  // "settings" shapes (repo + user-level) -- the union real Orca-injected
  // settings would produce.
  return [
    { hookEvent: "PreToolUse", command: "node scripts/check/role-guard.mjs" },
    {
      hookEvent: "PreToolUse",
      command: "node scripts/check/report-style-guard.mjs",
    },
    { hookEvent: "Stop", command: "node scripts/check/status-fresh.mjs" },
    { hookEvent: "Stop", command: "node scripts/check/clear-safe-check.mjs" },
    { hookEvent: "Stop", command: "node scripts/check/linear-sync.mjs" },
    { hookEvent: "Stop", command: "node scripts/check/controlroom-fresh.mjs" },
    {
      hookEvent: "SessionStart",
      command: "node scripts/check/context-inject.mjs --mode session-start",
    },
    {
      hookEvent: "SessionStart",
      command: "node scripts/check/selfcheck-freshness.mjs",
    },
    {
      hookEvent: "UserPromptSubmit",
      command:
        "node scripts/check/context-inject.mjs --mode user-prompt-submit",
    },
    {
      hookEvent: "UserPromptSubmit",
      command: "node scripts/check/worker-status-onstart.mjs",
    },
  ];
}

test("(48) EXPECTED_INJECTED_HOOKS is fixed at exactly 10 entries", () => {
  assert.equal(EXPECTED_INJECTED_HOOKS.length, 10);
});

test("(49) checkHookSetAdditive: all 10 expected hooks present -> PASS", () => {
  const result = checkHookSetAdditive({
    hookCommands: allExpectedHooksWired(),
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(50) known-bad: one expected hook deleted (role-guard removed) -> HOOK_SET_DRIFT naming it", () => {
  const commands = allExpectedHooksWired().filter(
    (h) => !h.command.includes("role-guard"),
  );
  const result = checkHookSetAdditive({ hookCommands: commands });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^HOOK_SET_DRIFT/);
  assert.match(result.reason, /role-guard@PreToolUse/);
});

test("(51) known-bad: an expected hook replaced with a different script at the same hookEvent -> still HOOK_SET_DRIFT (same as deletion)", () => {
  const commands = allExpectedHooksWired().map((h) =>
    h.command.includes("linear-sync")
      ? { ...h, command: "node scripts/check/mystery.mjs" }
      : h,
  );
  const result = checkHookSetAdditive({ hookCommands: commands });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /linear-sync@Stop/);
});

test("(52) paired good: deleted hook restored (single-variable fix) -> PASS", () => {
  const bad = checkHookSetAdditive({
    hookCommands: allExpectedHooksWired().filter(
      (h) => !h.command.includes("controlroom-fresh"),
    ),
  });
  assert.equal(bad.status, "BLOCK");
  const good = checkHookSetAdditive({ hookCommands: allExpectedHooksWired() });
  assert.equal(good.status, "PASS", good.reason);
});

test("(53) additive-only: an EXTRA hook beyond the expected 10 does not trigger HOOK_SET_DRIFT (that's ENFORCEMENT_INVENTORY_MISSING's concern, not this one)", () => {
  const commands = [
    ...allExpectedHooksWired(),
    {
      hookEvent: "PreToolUse",
      command: "node scripts/check/some-new-guard.mjs",
    },
  ];
  const result = checkHookSetAdditive({ hookCommands: commands });
  assert.equal(result.status, "PASS", result.reason);
});

test("(54) C2-0 confirmed shape: a fresh worktree (settings entirely absent) -> HOOK_SET_DRIFT naming all 10 -- 'settings existing' and 'hooks alive' are never conflated into one state (G11)", () => {
  const result = checkHookSetAdditive({ hookCommands: [] });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^HOOK_SET_DRIFT/);
  for (const exp of EXPECTED_INJECTED_HOOKS) {
    assert.match(result.reason, new RegExp(`${exp.id}@${exp.hookEvent}`));
  }
});

// checkHookWiringRegistered

// Uses a real, existing script (role-guard.mjs) as the fixture's id/script
// so judgeEntry's step-1 script-existence check never contributes noise
// (SILENT_BROKEN) unrelated to what this test is isolating: wiring only.
function wiringManifest(installTargets) {
  return {
    schema_version: 1,
    checks: [
      {
        id: "role-guard",
        script: "scripts/check/role-guard.mjs",
        test: "scripts/check/role-guard.test.mjs",
        install_targets: installTargets,
      },
    ],
  };
}

test("(55) checkHookWiringRegistered: registered entry actually wired -> PASS", () => {
  const manifest = wiringManifest([
    {
      location: "repo-settings",
      kind: "claude-settings",
      path: "REPO/.claude/settings.local.json",
      hook_event: "PreToolUse",
      matcher: "Edit",
      required: true,
    },
  ]);
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ command: "node scripts/check/role-guard.mjs" }],
          },
        ],
      },
    },
  };
  const result = checkHookWiringRegistered({
    manifest,
    repoRoot: fileURLToPath(new URL("../..", import.meta.url)),
    settingsByLocation,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(56) known-bad: settings ARE loaded for the location but this hook isn't among its commands (broken wiring, not 'never loaded') -> HOOK_WIRING_MISSING naming it", () => {
  const manifest = wiringManifest([
    {
      location: "repo-settings",
      kind: "claude-settings",
      path: "REPO/.claude/settings.local.json",
      hook_event: "PreToolUse",
      matcher: "Edit",
      required: true,
    },
  ]);
  // settings loaded successfully, but role-guard's command is absent --
  // this is NOT_INSTALLED (a real judgment), distinct from settingsByLocation
  // being empty entirely (which judgeEntry treats as UNJUDGABLE, "cannot
  // judge," not "definitely not installed" -- a different honest state).
  const settingsByLocation = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ command: "node scripts/check/report-style-guard.mjs" }],
          },
        ],
      },
    },
  };
  const result = checkHookWiringRegistered({
    manifest,
    repoRoot: fileURLToPath(new URL("../..", import.meta.url)),
    settingsByLocation,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^HOOK_WIRING_MISSING/);
  assert.match(result.reason, /role-guard/);
});

test("(57) paired good: role-guard's command restored into the same loaded settings (single-variable fix) -> PASS", () => {
  const manifest = wiringManifest([
    {
      location: "repo-settings",
      kind: "claude-settings",
      path: "REPO/.claude/settings.local.json",
      hook_event: "PreToolUse",
      matcher: "Edit",
      required: true,
    },
  ]);
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const badSettings = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ command: "node scripts/check/report-style-guard.mjs" }],
          },
        ],
      },
    },
  };
  const bad = checkHookWiringRegistered({
    manifest,
    repoRoot: root,
    settingsByLocation: badSettings,
  });
  assert.equal(bad.status, "BLOCK");
  const goodSettings = {
    "repo-settings": {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ command: "node scripts/check/role-guard.mjs" }],
          },
        ],
      },
    },
  };
  const good = checkHookWiringRegistered({
    manifest,
    repoRoot: root,
    settingsByLocation: goodSettings,
  });
  assert.equal(good.status, "PASS", good.reason);
});

// HYK-160-coder-8 (PR #37 enforce CI fail): same git-untracked-local-file
// gap as test 47 above -- `.claude/settings.local.json` is absent on a CI
// runner by design (C2-0 confirmed this directly), so there is no live
// repo-settings wiring to check against at all there. The user-level
// `~/.claude-team/settings.json` path already degrades gracefully (treated
// as empty hooks when absent, same as before this fix) -- only the repo
// settings file needed the same skip-if-absent treatment test 47 got.
const CI_MISSING_REPO_SETTINGS_SKIP_REASON =
  "live wiring file '.claude/settings.local.json' is local-only (git-untracked) -- CI has no repo-settings wiring to audit here; local weekly selfcheck covers this gap";

export function resolveRealRepoGuard58({
  repoRoot,
  repoSettingsPathOverride,
  userSettingsPathOverride,
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
}) {
  const repoSettingsPath =
    repoSettingsPathOverride ??
    join(repoRoot, ".claude", "settings.local.json");
  if (!existsFn(repoSettingsPath)) {
    return { outcome: "skip", reason: CI_MISSING_REPO_SETTINGS_SKIP_REASON };
  }
  const repoSettings = JSON.parse(readFileFn(repoSettingsPath));

  const userSettingsPath =
    userSettingsPathOverride ??
    join(
      process.env.USERPROFILE || process.env.HOME,
      ".claude-team",
      "settings.json",
    );
  let userSettings = { hooks: {} };
  if (existsFn(userSettingsPath)) {
    try {
      userSettings = JSON.parse(readFileFn(userSettingsPath));
    } catch {
      userSettings = { hooks: {} };
    }
  }

  const hookCommands = [
    ...parseHookCommands(repoSettings),
    ...parseHookCommands(userSettings),
  ];
  const result = checkHookSetAdditive({ hookCommands });
  return {
    outcome: result.status === "PASS" ? "pass" : "fail",
    reason: result.reason,
  };
}

test("(58) real-repo regression guard: EXPECTED_INJECTED_HOOKS all appear in the actual repo settings.local.json + user-level settings.json (both real files, additive check against live wiring)", (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const result = resolveRealRepoGuard58({ repoRoot });
  if (result.outcome === "skip") {
    t.skip(result.reason);
    return;
  }
  assert.equal(result.outcome, "pass", result.reason);
});

test("(58b) skip-decision counterfactual: repo settings path missing (injected) -> deterministic skip with the exact reason, never a crash", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const result = resolveRealRepoGuard58({
    repoRoot,
    repoSettingsPathOverride: join(
      repoRoot,
      "does-not-exist",
      "settings.local.json",
    ),
  });
  assert.equal(result.outcome, "skip");
  assert.equal(result.reason, CI_MISSING_REPO_SETTINGS_SKIP_REASON);
});

test("(58c) skip-decision counterfactual: repo settings present in a synthetic fixture but missing one expected hook -> FAIL, skip never swallows a real drift", () => {
  withFixtureDir((dir) => {
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const commands = [
      {
        hookEvent: "PreToolUse",
        command: "node scripts/check/report-style-guard.mjs",
      }, // role-guard missing
      { hookEvent: "Stop", command: "node scripts/check/status-fresh.mjs" },
      { hookEvent: "Stop", command: "node scripts/check/clear-safe-check.mjs" },
      { hookEvent: "Stop", command: "node scripts/check/linear-sync.mjs" },
      {
        hookEvent: "Stop",
        command: "node scripts/check/controlroom-fresh.mjs",
      },
      {
        hookEvent: "SessionStart",
        command: "node scripts/check/context-inject.mjs --mode session-start",
      },
      {
        hookEvent: "SessionStart",
        command: "node scripts/check/selfcheck-freshness.mjs",
      },
      {
        hookEvent: "UserPromptSubmit",
        command:
          "node scripts/check/context-inject.mjs --mode user-prompt-submit",
      },
    ];
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: commands.reduce((acc, c) => {
          (acc[c.hookEvent] ??= []).push({
            matcher: null,
            hooks: [{ command: c.command }],
          });
          return acc;
        }, {}),
      }),
      "utf8",
    );
    const result = resolveRealRepoGuard58({
      repoRoot: dir,
      userSettingsPathOverride: join(dir, "no-user-settings.json"),
    });
    assert.equal(result.outcome, "fail");
    assert.match(result.reason, /^HOOK_SET_DRIFT/);
  });
});

// --- HYK-175 (F-01/F-02): manifest drift repairs -- go-task-id-gate's two
// UserPromptSubmit wirings, research-receipt's PostToolUse wiring, and the
// PostToolUse blind spot in HOOK_EVENTS itself. Each test is mutation-backed:
// undoing the corresponding manifest.mjs fix flips it back to RED. ---

test("(59) parseHookCommands: extracts a PostToolUse hook command (F-02 (1) -- reverting HOOK_EVENTS to drop PostToolUse makes this return [] again)", () => {
  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: "WebSearch|WebFetch",
          hooks: [
            {
              type: "command",
              command: "node scripts/check/research-receipt.mjs record",
            },
          ],
        },
      ],
    },
  };
  const result = parseHookCommands(settings);
  assert.deepEqual(result, [
    {
      hookEvent: "PostToolUse",
      matcher: "WebSearch|WebFetch",
      command: "node scripts/check/research-receipt.mjs record",
    },
  ]);
});

test("(60) findExtraResults: go-task-id-gate registered with control-room + coder-user UserPromptSubmit install_targets -> no extra:* DRIFT for either location (F-01)", () => {
  const manifest = {
    checks: [
      {
        id: "go-task-id-gate",
        install_targets: [
          { location: "control-room-settings", kind: "claude-settings" },
          { location: "coder-user-settings", kind: "claude-settings" },
        ],
      },
    ],
  };
  const settingsByLocation = {
    "control-room-settings": {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ command: "node scripts/check/go-task-id-gate.mjs" }],
          },
        ],
      },
    },
    "coder-user-settings": {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ command: "node scripts/check/go-task-id-gate.mjs" }],
          },
        ],
      },
    },
  };
  const extras = findExtraResults(manifest, settingsByLocation);
  assert.deepEqual(extras, []);
});

test("(61) findExtraResults: counterfactual -- with go-task-id-gate's install_targets emptied (pre-HYK-175 state), the same two wirings ARE flagged extra:* DRIFT", () => {
  const manifest = {
    checks: [{ id: "go-task-id-gate", install_targets: [] }],
  };
  const settingsByLocation = {
    "control-room-settings": {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ command: "node scripts/check/go-task-id-gate.mjs" }],
          },
        ],
      },
    },
    "coder-user-settings": {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ command: "node scripts/check/go-task-id-gate.mjs" }],
          },
        ],
      },
    },
  };
  const extras = findExtraResults(manifest, settingsByLocation);
  assert.deepEqual(
    extras.map((r) => r.id).sort(),
    [
      "extra:coder-user-settings:go-task-id-gate",
      "extra:control-room-settings:go-task-id-gate",
    ].sort(),
  );
});

test("(62) judgeEntry: research-receipt with its repo-settings PostToolUse install_target wired -> ALIVE (F-02 (2), the shape now in enforcement-inventory.json)", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "research-receipt.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "research-receipt.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const entry = {
      id: "research-receipt",
      script: "scripts/check/research-receipt.mjs",
      test: "scripts/check/research-receipt.test.mjs",
      claude_only: false,
      install_targets: [
        {
          location: "repo-settings",
          kind: "claude-settings",
          path: "REPO/.claude/settings.local.json",
          hook_event: "PostToolUse",
          matcher: "WebSearch|WebFetch",
          required: true,
        },
      ],
    };
    const settingsByLocation = {
      "repo-settings": {
        hooks: {
          PostToolUse: [
            {
              matcher: "WebSearch|WebFetch",
              hooks: [
                {
                  command: "node scripts/check/research-receipt.mjs record",
                },
              ],
            },
          ],
        },
      },
    };
    const result = judgeEntry(entry, { repoRoot: repoDir, settingsByLocation });
    assert.equal(result.status, "ALIVE");
  });
});

test("(63) judgeEntry: counterfactual -- research-receipt's install_target removed (pre-HYK-175 state) reverts to 'ALIVE via script+test existence alone' (not wiring-confirmed), and the PostToolUse hook now reads as an unregistered extra", () => {
  withRepoFixture((repoDir) => {
    writeFileSync(
      join(repoDir, "scripts", "check", "research-receipt.mjs"),
      "// stub\n",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "scripts", "check", "research-receipt.test.mjs"),
      "// stub\n",
      "utf8",
    );
    const entry = {
      id: "research-receipt",
      script: "scripts/check/research-receipt.mjs",
      test: "scripts/check/research-receipt.test.mjs",
      claude_only: false,
      install_targets: [],
    };
    const result = judgeEntry(entry, { repoRoot: repoDir });
    assert.equal(result.status, "ALIVE");
    assert.match(
      result.evidence.join(" "),
      /judged from script\/test existence alone/,
    );

    const manifest = { checks: [entry] };
    const settingsByLocation = {
      "repo-settings": {
        hooks: {
          PostToolUse: [
            {
              matcher: "WebSearch|WebFetch",
              hooks: [
                {
                  command: "node scripts/check/research-receipt.mjs record",
                },
              ],
            },
          ],
        },
      },
    };
    const extras = findExtraResults(manifest, settingsByLocation);
    assert.deepEqual(
      extras.map((r) => r.id),
      ["extra:repo-settings:research-receipt"],
    );
  });
});

// --- checkControlRoomDoc (HYK-336: control-room live doc <-> repo drift
// baseline copy, reusing checkNativeGitHook's 4-state judgment against a
// CONTROL_ROOM-placeholder-resolved root instead of .git/hooks) ------------
//
// Every test below builds its own SYNTHETIC temp directory and points the
// CONTROL_ROOM root at it -- per coder-task.md §0/§3-3, the real control
// room (D:\문서관리\하네스-관제실\) is read-only and must never be touched
// by a corruption test.

const CONTRACT_DOC = [
  "# worker-dispatch-rule (synthetic fixture)",
  "",
  "## 3-c. ask timeout contract",
  "",
  "`orca orchestration ask` cuts off at 30s; use send+check --wait instead.",
  "",
].join("\n");

const CONTRACT_DOC_WITH_CLAUSE_DELETED = [
  "# worker-dispatch-rule (synthetic fixture)",
  "",
  "(계약 절 삭제됨 -- 합성 훼손)",
  "",
].join("\n");

test("(64) checkControlRoomDoc: live copy byte-identical to repo baseline -> ALIVE", () => {
  withFixtureDir((repoDir) => {
    withFixtureDir((controlRoomDir) => {
      writeFileSync(
        join(repoDir, "worker-dispatch-rule.md.txt"),
        CONTRACT_DOC,
        "utf8",
      );
      writeFileSync(
        join(controlRoomDir, "worker-dispatch-rule.md"),
        CONTRACT_DOC,
        "utf8",
      );
      const result = checkControlRoomDoc({
        target: {
          versioned_path: "REPO/worker-dispatch-rule.md.txt",
          installed_path: "CONTROL_ROOM/worker-dispatch-rule.md",
        },
        roots: { REPO: repoDir, CONTROL_ROOM: controlRoomDir },
      });
      assert.equal(result.status, "ALIVE");
    });
  });
});

test("(65) checkControlRoomDoc: synthetic corruption -- live copy has the contract clause deleted -> DRIFT (완료조건 2)", () => {
  withFixtureDir((repoDir) => {
    withFixtureDir((controlRoomDir) => {
      writeFileSync(
        join(repoDir, "worker-dispatch-rule.md.txt"),
        CONTRACT_DOC,
        "utf8",
      );
      writeFileSync(
        join(controlRoomDir, "worker-dispatch-rule.md"),
        CONTRACT_DOC_WITH_CLAUSE_DELETED,
        "utf8",
      );
      const result = checkControlRoomDoc({
        target: {
          versioned_path: "REPO/worker-dispatch-rule.md.txt",
          installed_path: "CONTROL_ROOM/worker-dispatch-rule.md",
        },
        roots: { REPO: repoDir, CONTROL_ROOM: controlRoomDir },
      });
      assert.equal(result.status, "DRIFT");
    });
  });
});

test("(66) checkControlRoomDoc: CONTROL_ROOM root missing from roots -> UNJUDGABLE (installed_path unresolved, never a false ALIVE)", () => {
  withFixtureDir((repoDir) => {
    writeFileSync(
      join(repoDir, "worker-dispatch-rule.md.txt"),
      CONTRACT_DOC,
      "utf8",
    );
    const result = checkControlRoomDoc({
      target: {
        versioned_path: "REPO/worker-dispatch-rule.md.txt",
        installed_path: "CONTROL_ROOM/worker-dispatch-rule.md",
      },
      roots: { REPO: repoDir },
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(67) checkControlRoomDoc: REPO baseline missing from roots -> UNJUDGABLE", () => {
  withFixtureDir((controlRoomDir) => {
    writeFileSync(
      join(controlRoomDir, "worker-dispatch-rule.md"),
      CONTRACT_DOC,
      "utf8",
    );
    const result = checkControlRoomDoc({
      target: {
        versioned_path: "REPO/worker-dispatch-rule.md.txt",
        installed_path: "CONTROL_ROOM/worker-dispatch-rule.md",
      },
      roots: { CONTROL_ROOM: controlRoomDir },
    });
    assert.equal(result.status, "UNJUDGABLE");
  });
});

test("(68) judgeEntry: control-room-doc install_target, live matches baseline, roots threaded end-to-end -> ALIVE (완료조건 3, 오탐 0)", () => {
  withRepoFixture((repoDir) => {
    withFixtureDir((controlRoomDir) => {
      writeFileSync(
        join(repoDir, "scripts", "check", "control-room-live-drift.mjs"),
        "// stub\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "scripts", "check", "control-room-live-drift.test.mjs"),
        "// stub\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "worker-dispatch-rule.md.txt"),
        CONTRACT_DOC,
        "utf8",
      );
      writeFileSync(
        join(controlRoomDir, "worker-dispatch-rule.md"),
        CONTRACT_DOC,
        "utf8",
      );
      const entry = {
        id: "control-room-live-drift",
        script: "scripts/check/control-room-live-drift.mjs",
        test: "scripts/check/control-room-live-drift.test.mjs",
        claude_only: false,
        install_targets: [
          {
            location: "control-room-doc",
            kind: "control-room-doc",
            versioned_path: "REPO/worker-dispatch-rule.md.txt",
            installed_path: "CONTROL_ROOM/worker-dispatch-rule.md",
            required: true,
          },
        ],
      };
      const result = judgeEntry(entry, {
        repoRoot: repoDir,
        roots: { REPO: repoDir, CONTROL_ROOM: controlRoomDir },
      });
      assert.equal(result.status, "ALIVE");
    });
  });
});

test("(69) judgeEntry: counterfactual -- fake CONTROL_ROOM live copy synthetically corrupted (contract clause deleted) -> DRIFT surfaces through the full judgeEntry/runInventory pipeline, not just the primitive (완료조건 2)", () => {
  withRepoFixture((repoDir) => {
    withFixtureDir((controlRoomDir) => {
      writeFileSync(
        join(repoDir, "scripts", "check", "control-room-live-drift.mjs"),
        "// stub\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "scripts", "check", "control-room-live-drift.test.mjs"),
        "// stub\n",
        "utf8",
      );
      writeFileSync(
        join(repoDir, "worker-dispatch-rule.md.txt"),
        CONTRACT_DOC,
        "utf8",
      );
      writeFileSync(
        join(controlRoomDir, "worker-dispatch-rule.md"),
        CONTRACT_DOC_WITH_CLAUSE_DELETED,
        "utf8",
      );
      const entry = {
        id: "control-room-live-drift",
        script: "scripts/check/control-room-live-drift.mjs",
        test: "scripts/check/control-room-live-drift.test.mjs",
        claude_only: false,
        install_targets: [
          {
            location: "control-room-doc",
            kind: "control-room-doc",
            versioned_path: "REPO/worker-dispatch-rule.md.txt",
            installed_path: "CONTROL_ROOM/worker-dispatch-rule.md",
            required: true,
          },
        ],
      };
      const manifest = { checks: [entry] };
      const { results, summary } = runInventory({
        manifest,
        repoRoot: repoDir,
        roots: { REPO: repoDir, CONTROL_ROOM: controlRoomDir },
      });
      assert.equal(results[0].status, "DRIFT");
      assert.match(results[0].evidence.join(" "), /sha256 mismatch/);
      assert.equal(summary.DRIFT, 1);
    });
  });
});

// --- HYK-338: checkCiCoverage recognizes indirect coverage via
// isolated-suite-runner.mjs (task §2-1..§2-4). The false "133 test suites
// not wired into CI" DRIFT this task fixes came from checkCiCoverage only
// ever crediting a directory glob or per-file literal names -- never a
// `run:` step that just invokes the runner script, which is what
// enforce.yml actually does since HYK-208 (commit c39ce31). ---

const REAL_RUNNER_SOURCE = `
// comment
export const TEST_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/relay/adapters",
  "scripts/supervisor",
];

export function collectTestFiles() {}
`;

test("(70) parseRunnerTestDirs: extracts the TEST_DIRS string array literal", () => {
  assert.deepEqual(parseRunnerTestDirs(REAL_RUNNER_SOURCE), [
    "scripts/check",
    "scripts/relay",
    "scripts/relay/adapters",
    "scripts/supervisor",
  ]);
});

test("(71) parseRunnerTestDirs: no TEST_DIRS export in source -> null (unparseable, not [])", () => {
  assert.equal(parseRunnerTestDirs("export const OTHER = [1, 2];"), null);
});

test("(72) parseRunnerTestDirs: TEST_DIRS export present but empty -> null (unparseable, not [])", () => {
  assert.equal(parseRunnerTestDirs("export const TEST_DIRS = [];"), null);
});

test("(73) checkCiCoverage §2-4(1): the real workflow string (runner invocation, no glob/file names) -> ALIVE, runner's TEST_DIRS includes scripts/check", () => {
  const result = checkCiCoverage({
    workflowText:
      "      - name: check test suites\n        run: node scripts/check/isolated-suite-runner.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
    runnerSourceText: REAL_RUNNER_SOURCE,
  });
  assert.equal(result.status, "ALIVE");
  assert.deepEqual(result.missing, []);
  assert.match(result.reason, /isolated-suite-runner\.mjs/);
});

test("(74) checkCiCoverage §2-4(2): the old whole-directory glob form still works unchanged -> ALIVE (no regression from the runner-indirection addition)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node --test scripts/check/*.test.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
    runnerSourceText: REAL_RUNNER_SOURCE,
  });
  assert.equal(result.status, "ALIVE");
  assert.deepEqual(result.missing, []);
});

test("(75) checkCiCoverage §2-4(3): neither a runner invocation nor a glob nor per-file names -> DRIFT (proves the signal is not dead)", () => {
  const result = checkCiCoverage({
    workflowText: "run: echo nothing-to-do\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
    runnerSourceText: REAL_RUNNER_SOURCE,
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["a.test.mjs", "b.test.mjs"]);
});

test("(76) checkCiCoverage §2-4(4): runner is invoked but its source could not be read -> UNJUDGABLE, never ALIVE (fail-closed, §2-2)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node scripts/check/isolated-suite-runner.mjs\n",
    testFiles: ["a.test.mjs"],
    runnerSourceText: undefined,
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.match(result.reason, /could not be read/);
});

test("(76b) checkCiCoverage: runner is invoked but its TEST_DIRS export can't be parsed -> UNJUDGABLE, never ALIVE (fail-closed, §2-2)", () => {
  const result = checkCiCoverage({
    workflowText: "run: node scripts/check/isolated-suite-runner.mjs\n",
    testFiles: ["a.test.mjs"],
    runnerSourceText: "export const NOT_TEST_DIRS = [];",
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.match(result.reason, /could not parse TEST_DIRS/);
});

test("(77) checkCiCoverage §2-4(5): runner invoked, but its TEST_DIRS omits scripts/check -> DRIFT naming the missing suites, not credited as wired", () => {
  const runnerSourceWithoutCheckDir = `
export const TEST_DIRS = [
  "scripts/relay",
  "scripts/supervisor",
];
`;
  const result = checkCiCoverage({
    workflowText: "run: node scripts/check/isolated-suite-runner.mjs\n",
    testFiles: ["a.test.mjs", "b.test.mjs"],
    runnerSourceText: runnerSourceWithoutCheckDir,
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["a.test.mjs", "b.test.mjs"]);
  assert.match(result.reason, /does not include 'scripts\/check'/);
});

test("(78) checkCiCoverage: the runner-indirection path never fires for a workflow that merely mentions the runner path in a step name: (only run: steps count, review-8 defect 1)", () => {
  const result = checkCiCoverage({
    workflowText:
      "      - name: runs scripts/check/isolated-suite-runner.mjs\n        run: echo hi\n",
    testFiles: ["a.test.mjs"],
    runnerSourceText: REAL_RUNNER_SOURCE,
  });
  assert.equal(result.status, "DRIFT");
  assert.deepEqual(result.missing, ["a.test.mjs"]);
});

test("(79) judgeEntry: ci-enforce entry against the real repo's enforce.yml + real isolated-suite-runner.mjs -> ALIVE (end-to-end, real files, no injection)", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const entry = {
    id: "ci-enforce",
    script: ".github/workflows/enforce.yml",
    test: null,
    claude_only: false,
    install_targets: [],
  };
  const testFiles = discoverCheckTestFiles(join(root, "scripts", "check"));
  const result = judgeEntry(entry, {
    repoRoot: root,
    testFiles,
  });
  assert.equal(result.status, "ALIVE");
  assert.match(result.evidence.join(" "), /isolated-suite-runner\.mjs/);
});
