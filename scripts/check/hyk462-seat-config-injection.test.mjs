// HYK-462 (coder-task.md §2-A/§2-D/§3) -- behavioral regression tests for
// scripts/check/seat-config-inject.mjs.
//
// ⛔ Never touches D:\문서관리\하네스-관제실 or this seat's own live
// config folder (coder-task.md §0/§4) -- every path used here is a
// synthetic temp directory under the OS temp root, created and torn down
// by this test file itself.
//
// Two things this file must NOT settle for (coder-task.md §2-D):
//  1. "개수만 세는 시험" -- checking that a settings file merely EXISTS is
//     not proof role-guard is wired; §역할 훅 실효 시험 below spawns the
//     REAL role-guard.mjs with a synthetic PreToolUse violation and checks
//     it is actually rejected (exit 2), not just that a config blob exists.
//  2. "주입 실패해도 좌석이 뜬다" -- §fail-closed below asserts the CLI's
//     own exit code contract (non-zero on any injection failure), which is
//     exactly what the launcher patch (docs/control-room-patches/
//     HYK-462-seat-config-injection.md) branches on to decide whether to
//     start the seat at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureRoleGuardHookSettings,
  ensureSafetyKeys,
  injectSeatConfig,
  ROLE_GUARD_HOOK_COMMAND,
  ROLE_GUARD_MATCHER,
  SAFETY_KEYS,
  SEAT_LAUNCH_MARKER_RELATIVE_PATH,
} from "./seat-config-inject.mjs";

const CLI_PATH = fileURLToPath(
  new URL("./seat-config-inject.mjs", import.meta.url),
);
const ROLE_GUARD_PATH = fileURLToPath(
  new URL("./role-guard.mjs", import.meta.url),
);

function freshDir(label) {
  return mkdtempSync(join(tmpdir(), `hyk462-${label}-`));
}

// ---------------------------------------------------------------------------
// §1 ensureRoleGuardHookSettings -- injection into a fresh worktree
// ---------------------------------------------------------------------------

test("ensureRoleGuardHookSettings: fresh worktree with no .claude dir gets the hook wired", () => {
  const worktree = freshDir("fresh-worktree");
  try {
    const settingsPath = join(worktree, ".claude", "settings.local.json");
    const result = ensureRoleGuardHookSettings(settingsPath);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    assert.equal(result.changed, true);
    assert.equal(existsSync(settingsPath), true);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    const group = written.hooks.PreToolUse.find(
      (g) => g.matcher === ROLE_GUARD_MATCHER,
    );
    assert.ok(group, "PreToolUse group for the role-guard matcher must exist");
    assert.ok(
      group.hooks.some((h) => h.command === ROLE_GUARD_HOOK_COMMAND),
      "role-guard.mjs command must be wired",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ensureRoleGuardHookSettings: idempotent -- second call on an already-wired file reports changed:false and does not duplicate the hook entry", () => {
  const worktree = freshDir("idempotent");
  try {
    const settingsPath = join(worktree, ".claude", "settings.local.json");
    const first = ensureRoleGuardHookSettings(settingsPath);
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);

    const second = ensureRoleGuardHookSettings(settingsPath);
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    const matchingGroups = written.hooks.PreToolUse.filter(
      (g) => g.matcher === ROLE_GUARD_MATCHER,
    );
    assert.equal(
      matchingGroups.length,
      1,
      "must not duplicate the PreToolUse group on re-run",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ensureRoleGuardHookSettings: preserves pre-existing unrelated settings content (merge, not overwrite)", () => {
  const worktree = freshDir("merge");
  try {
    const settingsPath = join(worktree, ".claude", "settings.local.json");
    mkdirSync(join(worktree, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: { PostToolUse: [{ matcher: "X", hooks: [] }] },
      }),
      "utf8",
    );

    const result = ensureRoleGuardHookSettings(settingsPath);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.theme, "dark");
    assert.equal(written.hooks.PostToolUse[0].matcher, "X");
    assert.ok(
      written.hooks.PreToolUse.some((g) => g.matcher === ROLE_GUARD_MATCHER),
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ensureRoleGuardHookSettings: fail-closed on corrupt existing JSON -- does not overwrite, returns ok:false", () => {
  const worktree = freshDir("corrupt");
  try {
    const settingsPath = join(worktree, ".claude", "settings.local.json");
    mkdirSync(join(worktree, ".claude"), { recursive: true });
    const corrupt = "{ this is not valid json";
    writeFileSync(settingsPath, corrupt, "utf8");

    const result = ensureRoleGuardHookSettings(settingsPath);
    assert.equal(result.ok, false);
    assert.equal(
      readFileSync(settingsPath, "utf8"),
      corrupt,
      "corrupt file must be left untouched, not blindly overwritten",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §2 ensureSafetyKeys
// ---------------------------------------------------------------------------

test("ensureSafetyKeys: missing keys get added with the fixed correct values", () => {
  const dir = freshDir("safety-add");
  try {
    const configPath = join(dir, "settings.json");
    writeFileSync(configPath, JSON.stringify({ model: "opus" }), "utf8");

    const result = ensureSafetyKeys(configPath);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(
      written.remoteControlAtStartup,
      SAFETY_KEYS.remoteControlAtStartup,
    );
    assert.equal(
      written.agentPushNotifEnabled,
      SAFETY_KEYS.agentPushNotifEnabled,
    );
    assert.equal(written.model, "opus", "unrelated keys must be preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSafetyKeys: already-correct file reports changed:false and leaves bytes untouched by value (idempotent)", () => {
  const dir = freshDir("safety-noop");
  try {
    const configPath = join(dir, "settings.json");
    writeFileSync(configPath, JSON.stringify(SAFETY_KEYS), "utf8");

    const result = ensureSafetyKeys(configPath);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSafetyKeys: a tampered value (true instead of false) gets corrected back", () => {
  const dir = freshDir("safety-tampered");
  try {
    const configPath = join(dir, "settings.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        remoteControlAtStartup: true,
        agentPushNotifEnabled: true,
      }),
      "utf8",
    );

    const result = ensureSafetyKeys(configPath);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(written.remoteControlAtStartup, false);
    assert.equal(written.agentPushNotifEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSafetyKeys: fail-closed when the config settings file does not exist (does not synthesize one)", () => {
  const dir = freshDir("safety-missing");
  try {
    const configPath = join(dir, "does-not-exist", "settings.json");
    const result = ensureSafetyKeys(configPath);
    assert.equal(result.ok, false);
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §3 injectSeatConfig -- end-to-end, and fail-closed CLI exit-code contract
// (this is what the launcher patch's `$LASTEXITCODE -ne 0` branch depends on)
// ---------------------------------------------------------------------------

test("injectSeatConfig: both steps succeed -> ok:true", () => {
  const worktree = freshDir("e2e-worktree");
  const configDir = freshDir("e2e-config");
  try {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({}), "utf8");
    const result = injectSeatConfig({
      worktree,
      configSettingsPath: join(configDir, "settings.json"),
      role: "CODER",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("injectSeatConfig: on full success writes the HYK-460 launch-provenance marker (§2-B candidate ⓑ)", () => {
  const worktree = freshDir("marker-worktree");
  const configDir = freshDir("marker-config");
  try {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({}), "utf8");
    const result = injectSeatConfig({
      worktree,
      configSettingsPath: join(configDir, "settings.json"),
      role: "REVIEW",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);

    const markerPath = join(
      worktree,
      ...SEAT_LAUNCH_MARKER_RELATIVE_PATH.split("/"),
    );
    assert.equal(
      existsSync(markerPath),
      true,
      "marker file must be written on success",
    );
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.viaScript, "orca-worker-seat.ps1");
    assert.equal(marker.role, "REVIEW");
    assert.ok(marker.launchedAt);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("injectSeatConfig: no marker is written when an earlier step fails (marker only proves a FULL success, not a partial one)", () => {
  const worktree = freshDir("marker-fail-worktree");
  const configDir = freshDir("marker-fail-config"); // no settings.json -> safety-keys step fails
  try {
    const result = injectSeatConfig({
      worktree,
      configSettingsPath: join(configDir, "settings.json"),
      role: "CODER",
    });
    assert.equal(result.ok, false);
    const markerPath = join(
      worktree,
      ...SEAT_LAUNCH_MARKER_RELATIVE_PATH.split("/"),
    );
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("★양성 관측: CLI exits 0 and prints '좌석 기동 가능' when both injections succeed", () => {
  const worktree = freshDir("cli-pass-worktree");
  const configDir = freshDir("cli-pass-config");
  try {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({}), "utf8");
    const proc = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "--role",
        "CODER",
        "--worktree",
        worktree,
        "--config-dir",
        configDir,
      ],
      {
        encoding: "utf8",
      },
    );
    assert.equal(
      proc.status,
      0,
      `expected exit 0, got ${proc.status}; stderr=${proc.stderr}`,
    );
    assert.match(proc.stdout, /좌석 기동 가능/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("★음성 관측 ⓑ: hook-settings injection failure (corrupt .claude/settings.local.json) -> CLI exits non-zero (좌석 안 뜸)", () => {
  const worktree = freshDir("cli-hook-fail-worktree");
  const configDir = freshDir("cli-hook-fail-config");
  try {
    mkdirSync(join(worktree, ".claude"), { recursive: true });
    writeFileSync(
      join(worktree, ".claude", "settings.local.json"),
      "{ not json",
      "utf8",
    );
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({}), "utf8");

    const proc = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "--role",
        "CODER",
        "--worktree",
        worktree,
        "--config-dir",
        configDir,
      ],
      {
        encoding: "utf8",
      },
    );
    assert.notEqual(
      proc.status,
      0,
      "corrupt hook settings must block launch (fail-closed), not silently pass",
    );
    assert.match(proc.stderr, /role-guard-hook/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("★음성 관측 ⓒ: missing safety-key config file -> CLI exits non-zero (좌석 안 뜸)", () => {
  const worktree = freshDir("cli-keys-fail-worktree");
  const configDir = freshDir("cli-keys-fail-config"); // deliberately: no settings.json written inside
  try {
    const proc = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "--role",
        "CODER",
        "--worktree",
        worktree,
        "--config-dir",
        configDir,
      ],
      {
        encoding: "utf8",
      },
    );
    assert.notEqual(
      proc.status,
      0,
      "missing safety-key config must block launch (fail-closed), not silently pass",
    );
    assert.match(proc.stderr, /safety-keys/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §4 역할 훅 실효 시험 -- proves role-guard is not just PRESENT in the
// injected settings but is a REAL script that REJECTS a real violation,
// exactly as it would be invoked by Claude Code's PreToolUse hook contract
// (JSON on stdin: {tool_name, tool_input}). This is the "설정 파일 존재
// 확인만으로는 부족하다" requirement from coder-task.md §2-D.
// ---------------------------------------------------------------------------

function runRoleGuard({ role, filePath, toolName = "Write" }) {
  return spawnSync(process.execPath, [ROLE_GUARD_PATH], {
    input: JSON.stringify({
      tool_name: toolName,
      tool_input: { file_path: filePath },
    }),
    encoding: "utf8",
    env: { ...process.env, HARNESS_ROLE: role },
  });
}

test("★역할 훅 실효: CODER writing .harness/review.md (REVIEW-owned) is REJECTED (exit 2) by the real role-guard.mjs", () => {
  const result = runRoleGuard({
    role: "CODER",
    filePath: ".harness/review.md",
  });
  assert.equal(
    result.status,
    2,
    `expected exit 2 (rejected); got ${result.status}, stderr=${result.stderr}`,
  );
  assert.match(result.stderr, /role-guard:/);
});

test("★역할 훅 실효 (양성 대조): CODER writing an ordinary repo file it owns is ALLOWED (exit 0) -- the rejection above is not a blanket deny", () => {
  const result = runRoleGuard({
    role: "CODER",
    filePath: "scripts/check/some-normal-file.mjs",
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0 (allowed); got ${result.status}, stderr=${result.stderr}`,
  );
});

test("★역할 훅 실효: the exact hook command string this module injects, when actually run through a POSIX shell with $CLAUDE_PROJECT_DIR resolved, invokes role-guard.mjs and rejects the same violation", (t) => {
  const bashProbe = spawnSync("where", ["bash"], { encoding: "utf8" });
  if (bashProbe.status !== 0) {
    t.skip(
      "SKIP_REASON: no `bash` executable found on PATH -- Claude Code's own hook runner resolves $VAR-style commands through a POSIX shell, which this test emulates; layer-1 string checks above already cover the command's literal contents on any platform",
    );
    return;
  }
  const bashPath = bashProbe.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0];
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(
    /\/$/,
    "",
  );
  const proc = spawnSync(bashPath, ["-c", ROLE_GUARD_HOOK_COMMAND], {
    input: JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: ".harness/review.md" },
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ROLE: "CODER",
      CLAUDE_PROJECT_DIR: repoRoot,
    },
  });
  assert.equal(
    proc.status,
    2,
    `wired command must reject the violation end-to-end; got ${proc.status}, stderr=${proc.stderr}`,
  );
});
