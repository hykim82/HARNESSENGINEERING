#!/usr/bin/env node
// harness-init installer (HYK-92) — parameterized, profile-aware.
//
// Reads a profile (`solo-full` | `team-local`) plus five placeholder
// parameters (repoPath, controlRoomPath, githubRepo, botAccount,
// verifyCmd), copies the matching template set into the target repo with
// placeholder substitution, and never overwrites a file that already
// exists (skip + warn instead).
//
// Source of truth for hook/check scripts: this installer reads
// `hooks/*` and `scripts/check/*.mjs` directly from THIS repository (the
// live solo-full instance) at install time, rather than from a frozen
// duplicate under templates/. That is deliberate — HYK-92 exists because a
// frozen copy drifts from the real implementation; reading the live files
// means an install always ships whatever this repo's enforcement layer
// currently is.
//
// Usage:
//   node install.mjs --profile <solo-full|team-local> --repo-path <path>
//     [--control-room-path <path>] --github-repo <owner/repo>
//     [--bot-account <name>] --verify-cmd "<command>"
//     [solo-full only, HYK-209-frame-1 — see installUnattendedLayerManifest:
//      --notify-dir <path> --approver-login <name> --approver-id <n>
//      --workspaces-root <path> --main-repo-path <path>]
//     [--dry-run]
//   node install.mjs --config <path-to-harness-init.config.json> [--dry-run]
//
// If --config is omitted, the installer also looks for
// `<repo-path>/harness-init.config.json` (or `./harness-init.config.json`
// when --repo-path is not yet known) and merges it under any CLI flags
// given (CLI wins on conflicting keys).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  appendFileSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEMPLATES_DIR, "..", "..");

const PROFILES = ["solo-full", "team-local"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "dry-run") {
      out.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    i++;
    out[key] = value;
  }
  return out;
}

function loadConfigFile(configPath) {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to parse config file '${configPath}': ${err.message}`,
      { cause: err },
    );
  }
}

// CLI flag names are kebab-case; config file / internal keys are camelCase.
const FLAG_TO_KEY = {
  profile: "profile",
  "repo-path": "repoPath",
  "control-room-path": "controlRoomPath",
  "github-repo": "githubRepo",
  "bot-account": "botAccount",
  "verify-cmd": "verifyCmd",
  // HYK-209-frame-1: five new placeholders for the "무인·병렬 층"
  // (unattended/parallel layer -- scripts/supervisor/*,
  // scripts/relay/adapters/orca-adapter.mjs) that ORCH's own instance has
  // built directly into itself, hardcoded, never through this installer
  // (§2 placeholder table in .harness/coder.md has the exact file:line
  // citations). This round does NOT copy those source files (§3
  // "내용물 조립 0" -- that is a separate, later assembly step) -- these
  // flags exist so the installer already knows how to receive and validate
  // the values a future assembly round's templates will need, and records
  // them now in a manifest (installUnattendedLayerManifest below) instead
  // of silently deferring the whole question.
  "notify-dir": "notifyDir",
  "approver-login": "approverLogin",
  "approver-id": "approverId",
  "workspaces-root": "workspacesRoot",
  "main-repo-path": "mainRepoPath",
  config: "config",
};

function normalizeCliArgs(rawArgs) {
  const out = { dryRun: !!rawArgs.dryRun };
  for (const [flag, key] of Object.entries(FLAG_TO_KEY)) {
    if (rawArgs[flag] !== undefined) out[key] = rawArgs[flag];
  }
  return out;
}

function resolveParams(argv) {
  const cli = normalizeCliArgs(parseArgs(argv));
  const configPath =
    cli.config ||
    (cli.repoPath && path.join(cli.repoPath, "harness-init.config.json")) ||
    (existsSync(path.join(process.cwd(), "harness-init.config.json"))
      ? path.join(process.cwd(), "harness-init.config.json")
      : null);
  const fileConfig = loadConfigFile(configPath);
  const merged = { ...fileConfig, ...cli };
  delete merged.config;
  return merged;
}

// HYK-209-frame-1: extracted from validateParams (ESLint complexity ceiling)
// -- loud-reject, not a silent default, same convention as
// controlRoomPath/botAccount in validateParams itself. Each of these five
// mirrors a real hardcoded value ORCH's own instance carries outside this
// installer's current copy list (source cited so the rejection message
// itself tells a human *why* the value is needed, not just that it's
// missing). team-local never calls this — it has no control room, no bot
// collaborator, and (since it has neither a control room nor a
// scheduler/PM-lane install) no unattended layer to describe.
function validateUnattendedLayerParams(params, errors) {
  if (!params.notifyDir)
    errors.push(
      "solo-full requires notifyDir (--notify-dir) -- mirrors reach-report.mjs's DEFAULT_NOTIFY_DIR hardcode",
    );
  if (!params.approverLogin)
    errors.push(
      "solo-full requires approverLogin (--approver-login) -- mirrors approver-allowlist.json's approvers[].login hardcode",
    );
  if (!params.approverId)
    errors.push(
      "solo-full requires approverId (--approver-id) -- mirrors approver-allowlist.json's approvers[].id hardcode",
    );
  if (!params.workspacesRoot)
    errors.push(
      "solo-full requires workspacesRoot (--workspaces-root) -- mirrors orca-adapter.mjs's WORKSPACES_ROOT hardcode",
    );
  if (!params.mainRepoPath)
    errors.push(
      "solo-full requires mainRepoPath (--main-repo-path) -- mirrors orca-adapter.mjs's MAIN_REPO_PATH hardcode",
    );
}

function validateParams(params) {
  const errors = [];
  if (!PROFILES.includes(params.profile)) {
    errors.push(
      `--profile must be one of ${PROFILES.join(" | ")} (got: ${params.profile ?? "<missing>"})`,
    );
  }
  if (!params.repoPath) errors.push("repoPath is required (--repo-path)");
  if (!params.githubRepo)
    errors.push("githubRepo is required (--github-repo, owner/repo form)");
  if (!params.verifyCmd) errors.push("verifyCmd is required (--verify-cmd)");
  if (params.profile === "solo-full") {
    if (!params.controlRoomPath)
      errors.push("solo-full requires controlRoomPath (--control-room-path)");
    if (!params.botAccount)
      errors.push("solo-full requires botAccount (--bot-account)");
    validateUnattendedLayerParams(params, errors);
  }
  // team-local: controlRoomPath / botAccount / the five unattended-layer
  // placeholders are all allowed to be empty or absent — team-local has no
  // control room, no bot collaborator, and (since it has neither a control
  // room nor a scheduler/PM-lane install) no unattended layer to describe.
  if (errors.length) {
    throw new Error("invalid parameters:\n  - " + errors.join("\n  - "));
  }
}

function placeholderMap(params) {
  return {
    "<PROFILE>": params.profile,
    "<REPO_PATH>": params.repoPath,
    "<CONTROL_ROOM_PATH>":
      params.controlRoomPath || "(none — team-local has no control room)",
    "<GITHUB_REPO>": params.githubRepo,
    "<BOT_ACCOUNT>":
      params.botAccount ||
      "(none — team-local pushes directly under this account)",
    "<VERIFY_CMD>": params.verifyCmd,
    // HYK-209-frame-1: not yet substituted into any template file this
    // installer writes (see installUnattendedLayerManifest) — carried here
    // too so `--dry-run`'s printed plan (main() logs this whole map) shows
    // every placeholder this install run knows about, substituted or not.
    "<NOTIFY_DIR>":
      params.notifyDir || "(none — team-local has no unattended layer)",
    "<APPROVER_LOGIN>":
      params.approverLogin || "(none — team-local has no unattended layer)",
    "<APPROVER_ID>":
      params.approverId || "(none — team-local has no unattended layer)",
    "<WORKSPACES_ROOT>":
      params.workspacesRoot || "(none — team-local has no unattended layer)",
    "<MAIN_REPO_PATH>":
      params.mainRepoPath || "(none — team-local has no unattended layer)",
  };
}

function substitute(content, map) {
  let out = content;
  for (const [token, value] of Object.entries(map)) {
    out = out.split(token).join(value);
  }
  return out;
}

const installed = [];
const skipped = [];

function ensureParentDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeTemplateFile(srcPath, destPath, map, { dryRun, executable }) {
  if (existsSync(destPath)) {
    skipped.push(destPath);
    console.warn(`skip (already exists): ${destPath}`);
    return;
  }
  const content = substitute(readFileSync(srcPath, "utf8"), map);
  if (!dryRun) {
    ensureParentDir(destPath);
    writeFileSync(destPath, content, "utf8");
    if (executable) {
      try {
        chmodSync(destPath, 0o755);
      } catch {
        // best-effort; not all filesystems (e.g. some Windows setups) honor this
      }
    }
  }
  installed.push(destPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${destPath}`,
  );
}

function copyRawFile(srcPath, destPath, { dryRun, executable }) {
  if (!existsSync(srcPath)) {
    console.warn(`source missing, skipping: ${srcPath}`);
    return;
  }
  if (existsSync(destPath)) {
    skipped.push(destPath);
    console.warn(`skip (already exists): ${destPath}`);
    return;
  }
  if (!dryRun) {
    ensureParentDir(destPath);
    writeFileSync(destPath, readFileSync(srcPath));
    if (executable) {
      try {
        chmodSync(destPath, 0o755);
      } catch {
        // best-effort; not all filesystems (e.g. some Windows setups) honor this
      }
    }
  }
  installed.push(destPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${destPath}`,
  );
}

function appendGitignoreBlock(profile, targetRepoPath, { dryRun }) {
  const templatePath = path.join(TEMPLATES_DIR, "gitignore.append.template");
  const raw = readFileSync(templatePath, "utf8");
  // \r?\n tolerates the template being saved with either LF or CRLF line
  // endings (this file has been re-saved as CRLF by Windows-side tooling
  // before, which silently broke a plain \n-only match).
  const re = new RegExp(`# @profile:${profile}\\r?\\n([\\s\\S]*?)# @end`, "m");
  const match = raw.match(re);
  if (!match)
    throw new Error(
      `gitignore.append.template has no block for profile '${profile}'`,
    );
  const block = match[1]
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#") && line.trim() !== "")
    .join("\n");
  const gitignorePath = path.join(targetRepoPath, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  const marker = `# harness-init (${profile})`;

  if (existing.includes(block.trim())) {
    skipped.push(gitignorePath);
    console.warn(`skip (block already present): ${gitignorePath}`);
    return;
  }

  // HYK-98: the check above only catches an exact, current-template match.
  // If this profile's marker is already present, some earlier install ran
  // here before -- re-appending would duplicate lines a prior (possibly
  // older-template) run already added. Never auto-upgrade/rewrite what's
  // there (that risks clobbering a hand-edit); skip and print exactly which
  // current-template lines are missing so a human can merge them by hand.
  if (existing.includes(marker)) {
    skipped.push(gitignorePath);
    const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missingLines = block
      .split("\n")
      .filter((line) => !existingLines.has(line.trim()));
    if (missingLines.length === 0) {
      console.warn(
        `skip (marker '${marker}' already present, current-template lines already covered): ${gitignorePath}`,
      );
    } else {
      console.warn(
        `skip (marker '${marker}' already present, from an older template version -- not auto-upgrading): ${gitignorePath}\n` +
          `Missing lines from the current template -- add these by hand if still wanted:\n${missingLines.map((l) => `  ${l}`).join("\n")}`,
      );
    }
    return;
  }

  if (!dryRun) {
    ensureParentDir(gitignorePath);
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${sep}\n${marker}\n${block}\n`, "utf8");
  }
  installed.push(gitignorePath);
  console.log(
    `${dryRun ? "[dry-run] would append to" : "appended to"}: ${gitignorePath}`,
  );
}

function appendAgentsFile(targetRepoPath, { dryRun }) {
  const agentsPath = path.join(targetRepoPath, "AGENTS.md");
  const snippet = readFileSync(
    path.join(TEMPLATES_DIR, "AGENTS.append.md"),
    "utf8",
  );
  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, "utf8");
    if (existing.includes("Harness Operating Rules")) {
      skipped.push(agentsPath);
      console.warn(`skip (equivalent rules already present): ${agentsPath}`);
      return;
    }
    if (!dryRun) appendFileSync(agentsPath, `\n${snippet}`, "utf8");
    installed.push(agentsPath);
    console.log(
      `${dryRun ? "[dry-run] would append to" : "appended to"}: ${agentsPath}`,
    );
    return;
  }
  if (!dryRun) writeFileSync(agentsPath, snippet, "utf8");
  installed.push(agentsPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${agentsPath}`,
  );
}

// Windows-native params.controlRoomPath arrives with backslashes; the live
// solo-full example this mirrors (.claude/settings.local.json's own
// `--context "D:/문서관리/..."`) uses forward slashes, so normalize before
// building a command string.
function toPosixPath(p) {
  return p.replace(/\\/g, "/");
}

function joinPosix(base, file) {
  return `${toPosixPath(base).replace(/\/+$/, "")}/${file}`;
}

// Builds the same `hooks` object this repository's own live
// `.claude/settings.local.json` carries (PreToolUse role-guard, Stop
// status-fresh + clear-safe-check, SessionStart + UserPromptSubmit
// context-inject), with STATUS/PROJECT-CONTEXT paths resolved per profile:
// solo-full points at the control room (outside the repo), team-local has
// no control room and points at its own `.harness/` via the portable
// `$CLAUDE_PROJECT_DIR` token (no substitution needed, unlike the other
// placeholder tokens this installer replaces in template files).
function buildHooksBlock(params) {
  const statusPath =
    params.profile === "solo-full"
      ? joinPosix(params.controlRoomPath, "STATUS.md")
      : "$CLAUDE_PROJECT_DIR/.harness/STATUS.md";
  const contextPath =
    params.profile === "solo-full"
      ? joinPosix(params.controlRoomPath, "PROJECT-CONTEXT.md")
      : "$CLAUDE_PROJECT_DIR/.harness/PROJECT-CONTEXT.md";

  return {
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [
          {
            type: "command",
            command: 'node "$CLAUDE_PROJECT_DIR/scripts/check/role-guard.mjs"',
          },
          // HYK-186 3R P1-1: done-line-write-guard.mjs was documented as
          // "the second PreToolUse hook" (docs/harness-init.md) but never
          // actually wired here -- an independent review caught the
          // mismatch (0 occurrences of "done-line-write-guard" in this file
          // before this fix). Same matcher as role-guard.mjs (both inspect
          // Edit/Write/MultiEdit tool_input.file_path); NotebookEdit is
          // included in the matcher for consistency with role-guard's own
          // entry even though this guard's own WRITE_TOOLS set doesn't act
          // on it (matches role-guard's pre-existing matcher shape exactly,
          // no new behavior invented here).
          {
            type: "command",
            command:
              'node "$CLAUDE_PROJECT_DIR/scripts/check/done-line-write-guard.mjs"',
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/status-fresh.mjs" --status "${statusPath}"`,
          },
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/clear-safe-check.mjs" --status "${statusPath}"`,
          },
          // solo-full only: team-local has no control room to check against
          // (see checkControlRoomFresh's own vacuous-ok path for the
          // absent-path case this guards even if that ever drifted).
          ...(params.profile === "solo-full"
            ? [
                {
                  type: "command",
                  command: `node "$CLAUDE_PROJECT_DIR/scripts/check/controlroom-fresh.mjs" --control-room "${toPosixPath(params.controlRoomPath)}"`,
                },
              ]
            : []),
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/context-inject.mjs" --mode session-start --context "${contextPath}"`,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/context-inject.mjs" --mode user-prompt-submit --context "${contextPath}"`,
          },
        ],
      },
    ],
  };
}

// Generates or merges the target's `.claude/settings.local.json` hooks
// block. Merge semantics, in order:
//   1. file absent -> create `{ "hooks": {...} }`.
//   2. file present, no top-level `hooks` key -> preserve everything else,
//      add `hooks` (e.g. a file that only has a `permissions` block).
//   3. file present, `hooks` key already exists -> do not touch it (an
//      existing wiring could be intentionally different); skip, warn, and
//      print the hooks block as a snippet for a human to merge by hand.
//      Auto-merging hook arrays is not attempted -- silently interleaving
//      commands into an existing hook the operator wrote risks misrouting
//      it in a way that is hard to notice.
//   4. file present but not valid JSON -> do not touch it; same snippet
//      fallback as (3).
// All object assembly goes through `JSON.stringify(obj, null, 2)` -- no
// regex/string surgery on existing JSON, so a merge can never corrupt
// unrelated keys it didn't intend to touch.
function installSettingsLocal(params, targetRepoPath, { dryRun }) {
  const settingsPath = path.join(
    targetRepoPath,
    ".claude",
    "settings.local.json",
  );
  const hooksBlock = buildHooksBlock(params);
  const hooksOnlySnippet = JSON.stringify({ hooks: hooksBlock }, null, 2);
  const restartNote =
    "Restart Claude Code once and confirm the hooks actually fire before relying on them -- this is a one-time human step (self-modifying a live session's own settings mid-task is out of scope for this installer); see docs/harness-init.md.";

  if (!existsSync(settingsPath)) {
    if (!dryRun) {
      ensureParentDir(settingsPath);
      writeFileSync(settingsPath, `${hooksOnlySnippet}\n`, "utf8");
    }
    installed.push(settingsPath);
    console.log(
      `${dryRun ? "[dry-run] would create" : "created"}: ${settingsPath}\n${hooksOnlySnippet}\n${restartNote}`,
    );
    return;
  }

  let existingRaw;
  try {
    existingRaw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    skipped.push(settingsPath);
    console.warn(
      `skip (could not read existing ${settingsPath}: ${err.message}) -- merge this manually:\n${hooksOnlySnippet}`,
    );
    return;
  }

  let existingObj;
  try {
    existingObj = existingRaw.trim() ? JSON.parse(existingRaw) : {};
  } catch (err) {
    skipped.push(settingsPath);
    console.warn(
      `skip (existing ${settingsPath} is not valid JSON: ${err.message}) -- not touched. Merge this manually:\n${hooksOnlySnippet}`,
    );
    return;
  }

  if (existingObj.hooks) {
    skipped.push(settingsPath);
    console.warn(
      `skip (${settingsPath} already has a "hooks" key -- not touched, auto-merging hook arrays risks misrouting an existing wiring). Merge this manually:\n${hooksOnlySnippet}`,
    );
    return;
  }

  const merged = { ...existingObj, hooks: hooksBlock };
  const mergedSnippet = JSON.stringify(merged, null, 2);
  if (!dryRun) {
    writeFileSync(settingsPath, `${mergedSnippet}\n`, "utf8");
  }
  installed.push(settingsPath);
  console.log(
    `${dryRun ? "[dry-run] would merge hooks into" : "merged hooks into"}: ${settingsPath} (existing keys preserved)\n${mergedSnippet}\n${restartNote}`,
  );
}

// Installs commit-msg/pre-commit into `<target>/.git/hooks/` (per-clone,
// untracked by git itself -- this is the one part of a git hook's model
// that has always required a local, non-committed install step, same as
// the manual `cp hooks/commit-msg .git/hooks/commit-msg` documented in
// docs/enforcement-v1.md). Only runs when `<target>/.git` exists as a real
// directory; a target that is not yet a git repository (or uses some other
// VCS layout) gets a warning instead of a crash, and the tracked copy under
// `hooks/` (already installed above) remains available for a manual install
// later.
function installGitHooksIntoDotGit(targetRepoPath, { dryRun }) {
  const gitDir = path.join(targetRepoPath, ".git");
  let isGitDir;
  try {
    isGitDir = existsSync(gitDir) && statSync(gitDir).isDirectory();
  } catch {
    isGitDir = false;
  }
  if (!isGitDir) {
    console.warn(
      `skip (.git/hooks/ auto-install): '${gitDir}' is not a directory -- per-clone install is manual here: copy hooks/commit-msg and hooks/pre-commit into .git/hooks/ and chmod +x them.`,
    );
    return;
  }
  for (const name of ["commit-msg", "pre-commit"]) {
    copyRawFile(
      path.join(REPO_ROOT, "hooks", name),
      path.join(gitDir, "hooks", name),
      { dryRun, executable: true },
    );
  }
}

// HYK-100: a real near-miss on a machine with multiple github.com
// credentials -- a team-local push attempted under the harness bot's
// identity instead of the operator's own account (blocked only because the
// bot lacked write access; had it had access, the bot's identity would have
// leaked into a shared team repo's history). The fix that was applied by
// hand, `git config --local credential.helper "!gh auth git-credential"`,
// pins this one clone's push identity to whatever account `gh` is logged in
// as, regardless of which credential a global/manager-stored entry would
// otherwise have raced to supply. This function mechanizes that for every
// team-local install.
const CREDENTIAL_HELPER_KEY = "credential.helper";
const CREDENTIAL_HELPER_VALUE = "!gh auth git-credential";

function commandSucceeds(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitConfigLocalGet(targetRepoPath, key) {
  try {
    return execFileSync(
      "git",
      ["-C", targetRepoPath, "config", "--local", "--get", key],
      { encoding: "utf8" },
    ).trim();
  } catch {
    // Non-zero exit from `git config --get` means "not set at this scope"
    // (or, much less likely, a transient git error) -- either way, treated
    // as "nothing to preserve," matching this function's only two real
    // outcomes (skip because something's already there, or set because
    // nothing is).
    return null;
  }
}

function originRemoteUrl(targetRepoPath) {
  try {
    return execFileSync(
      "git",
      ["-C", targetRepoPath, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
}

// SSH remotes (`git@host:...` or `ssh://...`) never consult a credential
// helper at all -- setting one would be inert, not wrong, but skipping is
// more honest than claiming to have "pinned" something that plays no role
// in how that remote authenticates.
function isSshRemoteUrl(url) {
  return !!url && /^(git@|ssh:\/\/)/i.test(url);
}

function installCredentialBoundary(targetRepoPath, { dryRun }) {
  const gitDir = path.join(targetRepoPath, ".git");
  let isGitDir;
  try {
    isGitDir = existsSync(gitDir) && statSync(gitDir).isDirectory();
  } catch {
    isGitDir = false;
  }
  if (!isGitDir) {
    console.warn(
      `skip (credential.helper): '${targetRepoPath}' is not a git repository yet -- manual setup once it is: ` +
        `git -C <repo> config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}"`,
    );
    return;
  }

  try {
    const origin = originRemoteUrl(targetRepoPath);
    if (isSshRemoteUrl(origin)) {
      console.log(
        `credential.helper: origin ('${origin}') is an SSH remote -- credential helpers are not consulted for SSH pushes, nothing to pin.`,
      );
      return;
    }

    const existing = gitConfigLocalGet(targetRepoPath, CREDENTIAL_HELPER_KEY);
    if (existing) {
      console.warn(
        `skip (credential.helper already set to '${existing}' at repo-local scope -- not touched, same never-overwrite convention as every other file this installer writes). ` +
          `If this clone's pushes should go out under a specific account, consider: git -C <repo> config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}"`,
      );
      return;
    }

    if (!commandSucceeds("gh", ["--version"])) {
      console.warn(
        `skip (credential.helper): 'gh' CLI not found on PATH -- not setting it automatically (pinning to a helper that can't authenticate would break every push, worse than leaving the ambiguity). ` +
          `Once gh is installed and logged in as the intended account: git -C <repo> config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}"`,
      );
      return;
    }

    if (dryRun) {
      console.log(
        `[dry-run] would set credential.helper: git -C ${targetRepoPath} config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}" (pins push identity to the current \`gh\` login account)`,
      );
      return;
    }

    execFileSync("git", [
      "-C",
      targetRepoPath,
      "config",
      "--local",
      CREDENTIAL_HELPER_KEY,
      CREDENTIAL_HELPER_VALUE,
    ]);
    console.log(
      `push identity pinned: credential.helper -> "${CREDENTIAL_HELPER_VALUE}" (this clone's pushes now authenticate as whichever account \`gh auth status\` currently reports)`,
    );
  } catch (err) {
    // Fail-open: this is a safety nicety on top of the install, not the
    // install itself -- an unexpected git/gh error here must never abort
    // the rest of install.mjs.
    console.warn(
      `skip (credential.helper): unexpected error (${err.message}) -- not touched, install continues.`,
    );
  }
}

function soloFullChecklist(params) {
  return `# solo-full GitHub setup checklist (do once, in the GitHub web UI)

Repo: ${params.githubRepo}

- [ ] Make the repo visible as intended (public/private) per project decision.
- [ ] Invite ${params.botAccount} as a collaborator with **Write** access only
      (not Admin) — this is the identity-separation step (HYK-87/B1) that
      keeps the acting agent unable to disable branch protection itself.
- [ ] Protect the default branch: require a pull request before merging,
      require the \`enforce\` status check to pass, require at least one
      approving review, and enable "Do not allow bypassing the above
      settings" (enforce_admins) so repo admins are not exempt.
- [ ] Enable GitHub secret scanning + push protection (Settings > Code
      security).
- [ ] Confirm \`.github/workflows/enforce.yml\` is present and green on the
      first PR.
- [ ] Local hooks: this installer already copied \`hooks/commit-msg\` and
      \`hooks/pre-commit\` into \`.git/hooks/\` when it ran (if \`.git/\` existed
      at install time) — confirm they're there and re-install if missing:
      \`cp hooks/commit-msg hooks/pre-commit .git/hooks/ && chmod +x .git/hooks/commit-msg .git/hooks/pre-commit\`.
- [ ] Install gitleaks locally for fast pre-commit feedback (optional; CI is
      authoritative regardless): https://github.com/gitleaks/gitleaks#installing
- [ ] Credential boundary (HYK-100): confirm this clone's push identity is
      what it should be — bot PAT if this is meant to push as
      \`${params.botAccount}\`, this account's own credentials otherwise.
      Check: \`git config --local credential.helper\` plus the actual
      account name in a real push's log/prompt. Not set automatically here —
      unlike team-local, solo-full has no single "always pin to gh login"
      answer (a bot-push flow legitimately wants the bot's PAT, not
      \`gh\`'s logged-in account), so which credential is correct is a human
      call, not something this installer can decide on its own.
`;
}

// Extracted from main() (quality-check: keeps main()'s own line-count/
// complexity under the repo's ESLint ceiling) -- copies the local git hooks
// plus every scripts/check/scripts/relay file that hook wiring depends on.
// Both profiles get these; they are local-only (no server dependency).
function installEnforcementScripts(targetRepoPath, { dryRun }) {
  copyRawFile(
    path.join(REPO_ROOT, "hooks", "commit-msg"),
    path.join(targetRepoPath, "hooks", "commit-msg"),
    { dryRun, executable: true },
  );
  copyRawFile(
    path.join(REPO_ROOT, "hooks", "pre-commit"),
    path.join(targetRepoPath, "hooks", "pre-commit"),
    { dryRun, executable: true },
  );
  for (const name of [
    "review-gate.mjs",
    "review-gate.test.mjs",
    "relay-handshake.mjs",
    "relay-handshake.test.mjs",
    // HYK-186 1R: relay-handshake.mjs imports "./time-authority.mjs" (the
    // future-skew registry) -- without a copy alongside it, an installed
    // relay-handshake.mjs fails to even load (MODULE_NOT_FOUND) on a fresh
    // target repo. Never caught before this round because no installer
    // test had ever actually run the copied file.
    "time-authority.mjs",
    "time-authority.test.mjs",
    "role-guard.mjs",
    "role-guard.test.mjs",
    // HYK-186 3R P1-1: the PreToolUse entry above now references this file
    // -- it must be copied or the wired hook command fails on every
    // Edit/Write/MultiEdit (MODULE_NOT_FOUND, same class of gap as
    // time-authority.mjs's above).
    "done-line-write-guard.mjs",
    "done-line-write-guard.test.mjs",
    "context-inject.mjs",
    "context-inject.test.mjs",
    "status-fresh.mjs",
    "status-fresh.test.mjs",
    "clear-safe-check.mjs",
    "clear-safe-check.test.mjs",
    "controlroom-fresh.mjs",
    "controlroom-fresh.test.mjs",
    "path-normalize.mjs",
    "path-normalize.test.mjs",
    "pm-guard.mjs",
    "pm-guard.test.mjs",
    "packet-gate.mjs",
    "packet-gate.test.mjs",
    "worker-status-onstart.mjs",
    "worker-status-onstart.test.mjs",
  ]) {
    copyRawFile(
      path.join(REPO_ROOT, "scripts", "check", name),
      path.join(targetRepoPath, "scripts", "check", name),
      { dryRun, executable: false },
    );
  }
  // HYK-186 3R P1-1: done-line-write-guard.mjs's whole purpose is to point
  // a blocked worker at `node scripts/relay/finalize-done.mjs <role>
  // .harness` -- that target must exist on the installed repo too, or the
  // guard's own redirect instruction is dead on a fresh install (scripts/
  // relay/ was never copied by this installer at all before this round).
  for (const name of ["finalize-done.mjs", "finalize-done.test.mjs"]) {
    copyRawFile(
      path.join(REPO_ROOT, "scripts", "relay", name),
      path.join(targetRepoPath, "scripts", "relay", name),
      { dryRun, executable: false },
    );
  }
}

// Extracted from main() (quality-check: keeps main()'s own line-count/
// complexity under the repo's ESLint ceiling) -- the profile-agnostic
// template writes + gitignore append + AGENTS.md append every install gets.
function installProfileAgnosticCore(params, targetRepoPath, map, { dryRun }) {
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "status.template.md"),
    path.join(targetRepoPath, ".harness", "STATUS.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "phase-handoff.template.md"),
    path.join(targetRepoPath, ".harness", "PHASE-HANDOFF.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "project-context.template.md"),
    path.join(targetRepoPath, ".harness", "PROJECT-CONTEXT.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "verify.sh.template"),
    path.join(targetRepoPath, "verify.sh"),
    map,
    { dryRun, executable: true },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "observe.sh.template"),
    path.join(targetRepoPath, "observe.sh"),
    map,
    { dryRun, executable: true },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "gc-task.template.md"),
    path.join(targetRepoPath, ".harness", "gc-task.template.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "gate-criteria.template.md"),
    path.join(targetRepoPath, ".harness", "gate-criteria.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "skill", "capture-context", "SKILL.md"),
    path.join(
      targetRepoPath,
      ".claude",
      "skills",
      "capture-context",
      "SKILL.md",
    ),
    map,
    { dryRun },
  );
  appendGitignoreBlock(params.profile, targetRepoPath, { dryRun });
  if (params.profile === "solo-full") {
    // team-local: AGENTS.md (or an equivalent project-instruction file) is
    // shared, committed team state — appending personal harness rules to it
    // would impose this account's tooling on the team repo, exactly what
    // HYK-92 says not to do. solo-full owns its own repo, so appending
    // there is fine.
    appendAgentsFile(targetRepoPath, { dryRun });
  } else {
    console.log(
      "team-local profile: skipping AGENTS.md append (shared team file — not this account's to change).",
    );
  }
}

// installAdmissionLedgerPointer -- HYK-227 2R §2/§3 항2 (한용 판정
// 2026-08-12 08:56): writes the persistent pointer file
// `admission-completion-adapter.mjs`'s `resolvePersistentLedgerPaths()`
// reads as its env-absent fallback. solo-full only -- team-local has no
// control room (no `controlRoomPath`), so there is no admission ledger to
// point at; the adapter's own no-op stays the whole story for that
// profile, unchanged from 1R.
//
// ★정직 한계 (§2-4, 미리 못 박은 그대로): this file write happens ONLY when
// install.mjs itself runs against a target repo. install.mjs has no
// automatic/scheduled/hooked invocation anywhere in this repo (confirmed:
// every reference to it in docs/harness-init.md is a documented CLI
// example for a human/agent to run by hand at bootstrap time) -- so for a
// repo that was already bootstrapped BEFORE this round (this repo itself
// included), this pointer file does not appear on its own. It requires
// one manual re-run of install.mjs against that target (idempotent and
// safe: writeTemplateFile-style skip-if-exists means a re-run only adds
// files that are still missing, never overwrites anything already there).
function installAdmissionLedgerPointer(params, targetRepoPath, { dryRun }) {
  const pointerPath = path.join(
    targetRepoPath,
    ".harness",
    "admission-ledger-path.json",
  );
  if (existsSync(pointerPath)) {
    skipped.push(pointerPath);
    console.warn(`skip (already exists): ${pointerPath}`);
    return;
  }
  const ledgerPath = joinPosix(params.controlRoomPath, "admission-ledger.json");
  const pointer = {
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
  };
  const content = `${JSON.stringify(pointer, null, 2)}\n`;
  if (!dryRun) {
    ensureParentDir(pointerPath);
    writeFileSync(pointerPath, content, "utf8");
  }
  installed.push(pointerPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${pointerPath}\n${content}`,
  );
}

// installUnattendedLayerManifest -- HYK-209-frame-1 §2 항2 ("설치기 «틀»
// 확장"). Writes `.harness/unattended-layer-placeholders.json`: the five
// new placeholder values (validated above, never silently defaulted) plus
// an honest `knownGaps` list of the source hardcodes they mirror and the
// two hardcodes found during this round that have NO placeholder yet
// (scheduler task name, concurrency cap value) because they live in code
// this round is not allowed to touch (§3 "본체 동작 변경 0").
//
// ★정직 한계, stated once here and not repeated at every call site: this
// manifest is a record of what a FUTURE assembly round needs, not an
// install of the unattended layer itself. None of the files this manifest
// cites (scripts/supervisor/*, scripts/relay/adapters/orca-adapter.mjs,
// scripts/check/{linear-sync,pm-guard,selfcheck,selfcheck-inventory}.mjs,
// scripts/supervisor/approver-allowlist.json) are copied by this
// installer, in this round or any prior one — a repo installed today with
// this manifest present still has zero unattended/parallel-layer
// enforcement. solo-full only: team-local has no control room, no
// scheduler, no PM lane, so it has no unattended layer for this manifest
// to describe.
// buildSourceHardcodes/buildKnownGaps -- extracted from
// installUnattendedLayerManifest (ESLint max-lines-per-function ceiling);
// pure data, no behavior. See that function's own header for what this
// data means and its honesty boundary.
function buildSourceHardcodes() {
  return [
    {
      placeholder: "NOTIFY_DIR",
      file: "scripts/supervisor/reach-report.mjs",
      line: 49,
      constant: "DEFAULT_NOTIFY_DIR",
    },
    {
      placeholder: "APPROVER_LOGIN / APPROVER_ID",
      file: "scripts/supervisor/approver-allowlist.json",
      line: 4,
      constant: "approvers[].login / approvers[].id",
    },
    {
      placeholder: "WORKSPACES_ROOT",
      file: "scripts/relay/adapters/orca-adapter.mjs",
      line: 158,
      constant: "WORKSPACES_ROOT",
    },
    {
      placeholder: "MAIN_REPO_PATH",
      file: "scripts/relay/adapters/orca-adapter.mjs",
      line: 159,
      constant: "MAIN_REPO_PATH",
    },
    {
      placeholder: "(also CONTROL_ROOM_PATH, already an existing token)",
      file:
        "scripts/check/linear-sync.mjs:8, scripts/check/pm-guard.mjs:10, " +
        "scripts/check/selfcheck.mjs:90,144, scripts/check/selfcheck-inventory.mjs:1021, " +
        "scripts/relay/adapters/orca-adapter.mjs:161",
      line: null,
      constant:
        "DEFAULT_STATUS_PATH / CONTROL_ROOM_ROOT / controlRoomPath default / CONTROL_ROOM_PATH",
    },
    {
      placeholder:
        "SEAT_LAUNCHER_PATH (derivable: <CONTROL_ROOM_PATH>/orca-worker-seat.ps1)",
      file: "scripts/relay/adapters/orca-adapter.mjs",
      line: 141,
      constant: "SEAT_LAUNCHER_PATH",
    },
  ];
}

function buildKnownGaps() {
  return [
    {
      item: "schedule task name",
      file: "scripts/supervisor/schedule-plan-core.mjs",
      line: 87,
      constant: "TASK_NAME",
      value: "HARNESS\\OrchStallWatch",
      gap: "고정 문자열(§2-3 자기 주석: '이 감시자 하나만 등록하는 고정 이름') -- 자리표가 아니다. 같은 계정에 두 저장소를 이식하면 schtasks 작업 이름이 충돌한다. 이번 라운드는 고치지 않는다(§3 '본체 동작 변경 0' -- schedule-plan-core.mjs는 scripts/ 산하 강제 장치).",
    },
    {
      item: "concurrency admission cap",
      file: "scripts/supervisor/concurrency-cap.json",
      line: 3,
      constant: "global_hard_cap",
      value: 2,
      gap: "커밋된 값 파일(코드 상수는 아니다, concurrency-cap-adapter.mjs가 fail-closed로 읽음)이지만 install.mjs는 scripts/supervisor/*를 전혀 복사하지 않으므로 이 파일 자체가 이식 대상 밖이다. 값의 출처는 한용(PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1 S-5)이지 이 설치기가 아니다.",
    },
  ];
}

function installUnattendedLayerManifest(params, targetRepoPath, { dryRun }) {
  const manifestPath = path.join(
    targetRepoPath,
    ".harness",
    "unattended-layer-placeholders.json",
  );
  if (existsSync(manifestPath)) {
    skipped.push(manifestPath);
    console.warn(`skip (already exists): ${manifestPath}`);
    return;
  }
  const manifest = {
    note: "이 파일이 존재해도 무인·병렬 층(scripts/supervisor/*, scripts/relay/adapters/orca-adapter.mjs 등)은 이 저장소에 설치되지 않았다 -- install.mjs는 그 파일들을 아직 복사하지 않는다(HYK-209 §3 '내용물 조립 0'). 이 값들은 그 조립 단계가 실제로 시작될 때 쓰일 자리표 값의 기록일 뿐이다.",
    placeholders: {
      NOTIFY_DIR: params.notifyDir,
      APPROVER_LOGIN: params.approverLogin,
      APPROVER_ID: params.approverId,
      WORKSPACES_ROOT: params.workspacesRoot,
      MAIN_REPO_PATH: params.mainRepoPath,
    },
    sourceHardcodes: buildSourceHardcodes(),
    knownGaps: buildKnownGaps(),
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!dryRun) {
    ensureParentDir(manifestPath);
    writeFileSync(manifestPath, content, "utf8");
  }
  installed.push(manifestPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${manifestPath}\n${content}`,
  );
}

function main() {
  const params = resolveParams(process.argv.slice(2));
  validateParams(params);
  const map = placeholderMap(params);
  const dryRun = !!params.dryRun;
  const targetRepoPath = params.repoPath;

  if (!existsSync(targetRepoPath)) {
    throw new Error(`repoPath does not exist: ${targetRepoPath}`);
  }

  console.log(
    `\nharness-init install — profile=${params.profile} target=${targetRepoPath}${dryRun ? " [DRY RUN]" : ""}\n`,
  );

  // Profile-agnostic core.
  installProfileAgnosticCore(params, targetRepoPath, map, { dryRun });

  // Local enforcement hooks + check scripts: both profiles get these —
  // they are local-only (no server dependency) and useful whether or not
  // a server-side gate exists on top.
  installEnforcementScripts(targetRepoPath, { dryRun });

  // .git/hooks/ (per-clone, real install) and .claude/settings.local.json
  // (Claude Code hook pre-wiring) -- both profiles, both one-shot
  // completeness fixes for HYK-95. See installGitHooksIntoDotGit/
  // installSettingsLocal above for the exact conditions and merge rules.
  installGitHooksIntoDotGit(targetRepoPath, { dryRun });
  installSettingsLocal(params, targetRepoPath, { dryRun });

  if (params.profile === "team-local") {
    // HYK-100: pin this clone's push identity so it can't silently race
    // against a bot credential meant for a different repo. solo-full gets
    // a checklist item instead (soloFullChecklist below) -- see that
    // function and installCredentialBoundary's own comment for why the
    // two profiles are handled asymmetrically.
    installCredentialBoundary(targetRepoPath, { dryRun });
  }

  if (params.profile === "solo-full") {
    // HYK-227 2R §3 항2: the persistent admission-ledger pointer file --
    // see installAdmissionLedgerPointer's own header for scope/limits.
    installAdmissionLedgerPointer(params, targetRepoPath, { dryRun });

    // HYK-209-frame-1 §2 항2: record the five new unattended-layer
    // placeholder values (+ the two known gaps this round found but can't
    // place) — see installUnattendedLayerManifest's own header for limits.
    installUnattendedLayerManifest(params, targetRepoPath, { dryRun });

    // Server-side anchor: CI workflow + gitleaks ruleset. Never automated
    // past the file copy — branch protection, bot invite, and secret
    // scanning are one-time human steps in the GitHub web UI (checklist
    // below), per this repo's own B1 anchor precedent.
    copyRawFile(
      path.join(REPO_ROOT, ".github", "workflows", "enforce.yml"),
      path.join(targetRepoPath, ".github", "workflows", "enforce.yml"),
      { dryRun, executable: false },
    );
    const gitleaksToml = path.join(REPO_ROOT, ".gitleaks.toml");
    if (existsSync(gitleaksToml)) {
      copyRawFile(gitleaksToml, path.join(targetRepoPath, ".gitleaks.toml"), {
        dryRun,
        executable: false,
      });
    }
    const checklistPath = path.join(
      targetRepoPath,
      ".harness",
      "github-setup-checklist.md",
    );
    const checklist = soloFullChecklist(params);
    if (existsSync(checklistPath)) {
      skipped.push(checklistPath);
      console.warn(`skip (already exists): ${checklistPath}`);
    } else {
      if (!dryRun) {
        ensureParentDir(checklistPath);
        writeFileSync(checklistPath, checklist, "utf8");
      }
      installed.push(checklistPath);
      console.log(
        `${dryRun ? "[dry-run] would install" : "installed"}: ${checklistPath}`,
      );
    }
    console.log("\n" + checklist);
  } else {
    console.log(
      "\nteam-local profile: no server-side setup — skipping GitHub checklist (no branch protection or CI to add on a shared team repo).",
    );
  }

  console.log(`\n--- summary ---`);
  console.log(`installed (${installed.length}):`);
  for (const f of installed) console.log(`  + ${f}`);
  console.log(`skipped, already existed (${skipped.length}):`);
  for (const f of skipped) console.log(`  = ${f}`);
  console.log("");
}

main();
