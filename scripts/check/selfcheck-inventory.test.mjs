import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  combineStatuses,
  judgeEntry,
  runInventory,
  discoverCheckTestFiles,
  expectedIdsForLocation,
  findExtraResults,
} from "./selfcheck-inventory.mjs";

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
