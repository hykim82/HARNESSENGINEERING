// HYK-462 (coder-task.md §2-A) -- fail-closed seat CONFIG injection, meant
// to be invoked by the control-room seat launcher (`orca-worker-seat.ps1`)
// AFTER seat-preflight.mjs but BEFORE the worker engine (codex/claude) is
// actually spawned.
//
// Why this exists (coder-task.md §1-A/§1-C, ORCH's own 2026-09-10
// measurements): a worktree's `.claude/settings.local.json` -- the file
// that wires the PreToolUse `role-guard.mjs` hook -- is globally
// git-ignored (`C:\Users\Administrator/.config/git/ignore:1:
// **/.claude/settings.local.json`), so it is NEVER present in a fresh
// worktree; role-guard.mjs exists but nothing ever calls it there. Separately,
// the worker-wide `CLAUDE_CONFIG_DIR` settings file
// (`C:\Users\Administrator\.claude-team\settings.json`) is the ONE place
// two safety keys (`remoteControlAtStartup`, `agentPushNotifEnabled`) live,
// and ORCH had to hand-patch them in as a temporary fix after a worker
// session showed up in the remote-control registry unattended. Both are
// per-launch state that can silently regress; this module makes the
// launcher re-assert them on every seat boot, fail-closed (mirrors the
// already-merged seat-preflight.mjs contract: exit != 0 => launcher must
// not start the seat).
//
// Design choice (coder-task.md §2-A-1 "복사가 최선인지 생성이 최선인지는
// 네 설계 판단"): GENERATE a minimal role-guard-only fragment rather than
// COPY the main repo's full `.claude/settings.local.json`. The main file
// also wires report-style-guard/linear-sync/controlroom-fresh/context-inject
// -- ORCH-lane automation that has no business running inside an unattended
// worker seat's project directory, and that would silently drift the
// worker's hook surface every time the main file's other hooks change for
// unrelated reasons. Generating exactly the one hook this issue is about
// keeps the worker's injected surface minimal and auditable; if a future
// round decides workers need one of those other hooks too, it should be
// added here explicitly, not inherited by blindly copying a file this
// module wasn't asked to reason about.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// HYK-462 2R (coder-task.md §2 "그 실측에 맞춰 수리한다"): 1R's rejection
// reported this failing on a real Windows seat with `Cannot find module
// '/scripts/check/role-guard.mjs'`, exit 1 -- consistent only with
// $CLAUDE_PROJECT_DIR being empty at hook-execution time, never with it
// being merely mis-formatted (2R live-measured BOTH the real
// forward-slash Windows form Claude Code's own hook runner actually sets,
// e.g. "C:/Users/.../hyk442-blocked-door-1" -- verified via three separate
// live PreToolUse-hook firings, see coder.md 2R §1 -- and a backslash
// `fileURLToPath`-style form; both resolve and reject a real violation
// correctly, so the specific interactive-seat trigger could not be
// reproduced from this dispatched session, see coder.md 2R honesty-limits).
//
// What IS a confirmed, independently-worth-fixing problem regardless of
// that unreproduced trigger: if $CLAUDE_PROJECT_DIR is ever empty for any
// reason (this launcher's own future drift, a Claude Code regression, a
// differently-invoked seat), the *old* bare command dies with Node's
// module-resolution error at **exit 1** -- and Claude Code's PreToolUse
// contract only treats **exit 2** as "block the tool call"; any other
// non-zero exit is a non-blocking hook error, so exit 1 here means the
// role-guard silently FAILS OPEN at exactly the moment it's needed most.
// That directly contradicts this whole issue's fail-closed goal. So this
// command now guards the precondition itself and exits 2 (not node's
// exit 1) when the variable is unset/empty, converting an ambiguous crash
// into an explicit, always-blocking failure.
export const ROLE_GUARD_HOOK_COMMAND =
  'if [ -z "$CLAUDE_PROJECT_DIR" ]; then echo "role-guard: CLAUDE_PROJECT_DIR is unset/empty -- refusing to fail-open (HYK-462 2R hardening)" >&2; exit 2; fi; node "$CLAUDE_PROJECT_DIR/scripts/check/role-guard.mjs"';
export const ROLE_GUARD_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

// The two safety keys HYK-462 §1-C ties down. Values are fixed booleans --
// this module does not offer any other value, by design (fail-closed
// contract: there is exactly one correct state, not a range of "safe"
// states to preserve if already set to something else).
export const SAFETY_KEYS = Object.freeze({
  remoteControlAtStartup: false,
  agentPushNotifEnabled: false,
});

function readJsonObjectOrEmpty(path) {
  if (!existsSync(path)) {
    return { ok: true, value: {}, existed: false };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read ${path}: ${err.message}` };
  }
  if (raw.trim() === "") {
    return { ok: true, value: {}, existed: true };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `${path} exists but is not valid JSON -- refusing to overwrite blindly (fail-closed): ${err.message}`,
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `${path} top level is not a JSON object` };
  }
  return { ok: true, value, existed: true };
}

// Ensures the worktree's `.claude/settings.local.json` wires the
// role-guard PreToolUse hook. Merges into whatever is already there
// (idempotent, never duplicates the entry on a re-run) instead of
// overwriting the whole file -- a worktree could in principle already carry
// other project-local settings this module has no business erasing.
export function ensureRoleGuardHookSettings(settingsLocalPath) {
  const read = readJsonObjectOrEmpty(settingsLocalPath);
  if (!read.ok) return { ok: false, reason: read.reason };
  const settings = read.value;

  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  if (!Array.isArray(settings.hooks.PreToolUse)) {
    return {
      ok: false,
      reason: `${settingsLocalPath}: hooks.PreToolUse is not an array -- refusing to overwrite blindly`,
    };
  }

  const alreadyWired = settings.hooks.PreToolUse.some(
    (group) =>
      group &&
      group.matcher === ROLE_GUARD_MATCHER &&
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (h) =>
          h && h.type === "command" && h.command === ROLE_GUARD_HOOK_COMMAND,
      ),
  );

  if (!alreadyWired) {
    settings.hooks.PreToolUse.push({
      matcher: ROLE_GUARD_MATCHER,
      hooks: [{ type: "command", command: ROLE_GUARD_HOOK_COMMAND }],
    });
  }

  try {
    mkdirSync(dirname(settingsLocalPath), { recursive: true });
    writeFileSync(
      settingsLocalPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    return {
      ok: false,
      reason: `cannot write ${settingsLocalPath}: ${err.message}`,
    };
  }

  return { ok: true, changed: !alreadyWired };
}

// Ensures the worker CLAUDE_CONFIG_DIR settings file carries both safety
// keys with the fixed correct value. Deliberately fails closed (does NOT
// create the file) if it does not already exist -- a missing worker config
// folder is a different, more serious failure this module is not equipped
// to repair by inventing a whole settings file from nothing (coder-task.md
// §4 "네 좌석 설정을 스스로 바꾸지 마라" -- this module edits an EXISTING
// worker config, it does not synthesize one).
export function ensureSafetyKeys(configSettingsPath) {
  if (!existsSync(configSettingsPath)) {
    return {
      ok: false,
      reason: `worker config settings not found at ${configSettingsPath} -- refusing to synthesize a config folder that should already exist`,
    };
  }
  const read = readJsonObjectOrEmpty(configSettingsPath);
  if (!read.ok) return { ok: false, reason: read.reason };
  const settings = read.value;

  let changed = false;
  for (const [key, value] of Object.entries(SAFETY_KEYS)) {
    if (settings[key] !== value) {
      settings[key] = value;
      changed = true;
    }
  }

  if (changed) {
    try {
      writeFileSync(
        configSettingsPath,
        JSON.stringify(settings, null, 2) + "\n",
        "utf8",
      );
    } catch (err) {
      return {
        ok: false,
        reason: `cannot write ${configSettingsPath}: ${err.message}`,
      };
    }
  }

  return { ok: true, changed };
}

// HYK-460 §2-B candidate ⓑ (docs/control-room-patches/HYK-462-seat-config-injection.md
// §4): this is the "launch provenance" marker a future dispatcher-side
// check could require before delivering work to a pane -- a seat started
// by hand (bypassing this launcher entirely) never gets this file written,
// so a consumer that checks for it can refuse to treat that pane as a
// legitimate worker. This round writes the marker only; wiring a delivery
// check to consume it is out of scope (see the patch doc's honesty-limits
// section -- that would touch a different live file, dispatch-worker.ps1).
export const SEAT_LAUNCH_MARKER_RELATIVE_PATH =
  ".harness/.seat-launch-marker.json";

function writeSeatLaunchMarker({ worktree, role }) {
  const markerPath = join(
    worktree,
    ...SEAT_LAUNCH_MARKER_RELATIVE_PATH.split("/"),
  );
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          launchedAt: new Date().toISOString(),
          role,
          viaScript: "orca-worker-seat.ps1",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `cannot write seat launch marker: ${err.message}`,
    };
  }
}

// End-to-end: both injections must succeed for the seat to be allowed to
// launch (coder-task.md §2-A-3 "하나라도 실패하면 좌석을 띄우지 않는다").
// Returns which step failed so the launcher's screen message (and this
// module's own tests) can say which of the two things is broken. On full
// success also writes the launch-provenance marker (see above).
export function injectSeatConfig({ worktree, configSettingsPath, role }) {
  const settingsLocalPath = join(worktree, ".claude", "settings.local.json");
  const hookResult = ensureRoleGuardHookSettings(settingsLocalPath);
  if (!hookResult.ok) {
    return { ok: false, step: "role-guard-hook", reason: hookResult.reason };
  }
  const keysResult = ensureSafetyKeys(configSettingsPath);
  if (!keysResult.ok) {
    return { ok: false, step: "safety-keys", reason: keysResult.reason };
  }
  const markerResult = writeSeatLaunchMarker({ worktree, role });
  if (!markerResult.ok) {
    return { ok: false, step: "launch-marker", reason: markerResult.reason };
  }
  return {
    ok: true,
    hookChanged: hookResult.changed,
    keysChanged: keysResult.changed,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--role") out.role = argv[++i];
    else if (argv[i] === "--worktree") out.worktree = argv[++i];
    else if (argv[i] === "--config-dir") out.configDir = argv[++i];
  }
  return out;
}

// Matches the live launcher's own hardcoded worker config dir literal
// (orca-worker-seat.ps1:34, `$env:CLAUDE_CONFIG_DIR = "C:\Users\Administrator\.claude-team"`)
// -- this module is not more parameterized than the script that will call it.
export const DEFAULT_CONFIG_DIR = "C:\\Users\\Administrator\\.claude-team";

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-config-inject.mjs");
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.worktree) {
    console.error(
      "usage: node seat-config-inject.mjs --role <Role> --worktree <path> [--config-dir <path>]",
    );
    process.exit(1);
  }
  const configDir = args.configDir ?? DEFAULT_CONFIG_DIR;
  const configSettingsPath = join(configDir, "settings.json");

  const result = injectSeatConfig({
    worktree: args.worktree,
    configSettingsPath,
    role: args.role,
  });
  if (!result.ok) {
    console.error(
      `seat-config-inject: BLOCK -- ${result.step} 주입 실패: ${result.reason}`,
    );
    process.exit(1);
  }
  console.log(
    `seat-config-inject: OK -- role-guard hook ${result.hookChanged ? "wired" : "already wired"}, safety keys ${result.keysChanged ? "corrected" : "already correct"}. 좌석 기동 가능.`,
  );
  process.exit(0);
}
