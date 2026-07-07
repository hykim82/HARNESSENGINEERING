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
//     [--bot-account <name>] --verify-cmd "<command>" [--dry-run]
//   node install.mjs --config <path-to-harness-init.config.json> [--dry-run]
//
// If --config is omitted, the installer also looks for
// `<repo-path>/harness-init.config.json` (or `./harness-init.config.json`
// when --repo-path is not yet known) and merges it under any CLI flags
// given (CLI wins on conflicting keys).

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, appendFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEMPLATES_DIR, "..", "..");

const PROFILES = ["solo-full", "team-local"];

function repoRootOf(dir) {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return dir;
  }
}

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
    throw new Error(`failed to parse config file '${configPath}': ${err.message}`);
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

function validateParams(params) {
  const errors = [];
  if (!PROFILES.includes(params.profile)) {
    errors.push(`--profile must be one of ${PROFILES.join(" | ")} (got: ${params.profile ?? "<missing>"})`);
  }
  if (!params.repoPath) errors.push("repoPath is required (--repo-path)");
  if (!params.githubRepo) errors.push("githubRepo is required (--github-repo, owner/repo form)");
  if (!params.verifyCmd) errors.push("verifyCmd is required (--verify-cmd)");
  if (params.profile === "solo-full") {
    if (!params.controlRoomPath) errors.push("solo-full requires controlRoomPath (--control-room-path)");
    if (!params.botAccount) errors.push("solo-full requires botAccount (--bot-account)");
  }
  // team-local: controlRoomPath / botAccount are allowed to be empty or
  // absent — team-local has no control room and no bot collaborator.
  if (errors.length) {
    throw new Error("invalid parameters:\n  - " + errors.join("\n  - "));
  }
}

function placeholderMap(params) {
  return {
    "<PROFILE>": params.profile,
    "<REPO_PATH>": params.repoPath,
    "<CONTROL_ROOM_PATH>": params.controlRoomPath || "(none — team-local has no control room)",
    "<GITHUB_REPO>": params.githubRepo,
    "<BOT_ACCOUNT>": params.botAccount || "(none — team-local pushes directly under this account)",
    "<VERIFY_CMD>": params.verifyCmd,
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
  console.log(`${dryRun ? "[dry-run] would install" : "installed"}: ${destPath}`);
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
  console.log(`${dryRun ? "[dry-run] would install" : "installed"}: ${destPath}`);
}

function appendGitignoreBlock(profile, targetRepoPath, { dryRun }) {
  const templatePath = path.join(TEMPLATES_DIR, "gitignore.append.template");
  const raw = readFileSync(templatePath, "utf8");
  // \r?\n tolerates the template being saved with either LF or CRLF line
  // endings (this file has been re-saved as CRLF by Windows-side tooling
  // before, which silently broke a plain \n-only match).
  const re = new RegExp(`# @profile:${profile}\\r?\\n([\\s\\S]*?)# @end`, "m");
  const match = raw.match(re);
  if (!match) throw new Error(`gitignore.append.template has no block for profile '${profile}'`);
  const block = match[1]
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#") && line.trim() !== "")
    .join("\n");
  const gitignorePath = path.join(targetRepoPath, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (existing.includes(block.trim())) {
    skipped.push(gitignorePath);
    console.warn(`skip (block already present): ${gitignorePath}`);
    return;
  }
  if (!dryRun) {
    ensureParentDir(gitignorePath);
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${sep}\n# harness-init (${profile})\n${block}\n`, "utf8");
  }
  installed.push(gitignorePath);
  console.log(`${dryRun ? "[dry-run] would append to" : "appended to"}: ${gitignorePath}`);
}

function appendAgentsFile(targetRepoPath, { dryRun }) {
  const agentsPath = path.join(targetRepoPath, "AGENTS.md");
  const snippet = readFileSync(path.join(TEMPLATES_DIR, "AGENTS.append.md"), "utf8");
  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, "utf8");
    if (existing.includes("Harness Operating Rules")) {
      skipped.push(agentsPath);
      console.warn(`skip (equivalent rules already present): ${agentsPath}`);
      return;
    }
    if (!dryRun) appendFileSync(agentsPath, `\n${snippet}`, "utf8");
    installed.push(agentsPath);
    console.log(`${dryRun ? "[dry-run] would append to" : "appended to"}: ${agentsPath}`);
    return;
  }
  if (!dryRun) writeFileSync(agentsPath, snippet, "utf8");
  installed.push(agentsPath);
  console.log(`${dryRun ? "[dry-run] would install" : "installed"}: ${agentsPath}`);
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
    params.profile === "solo-full" ? joinPosix(params.controlRoomPath, "STATUS.md") : "$CLAUDE_PROJECT_DIR/.harness/STATUS.md";
  const contextPath =
    params.profile === "solo-full"
      ? joinPosix(params.controlRoomPath, "PROJECT-CONTEXT.md")
      : "$CLAUDE_PROJECT_DIR/.harness/PROJECT-CONTEXT.md";

  return {
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/check/role-guard.mjs"' }],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: "command", command: `node "$CLAUDE_PROJECT_DIR/scripts/check/status-fresh.mjs" --status "${statusPath}"` },
          { type: "command", command: `node "$CLAUDE_PROJECT_DIR/scripts/check/clear-safe-check.mjs" --status "${statusPath}"` },
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
  const settingsPath = path.join(targetRepoPath, ".claude", "settings.local.json");
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
    console.log(`${dryRun ? "[dry-run] would create" : "created"}: ${settingsPath}\n${hooksOnlySnippet}\n${restartNote}`);
    return;
  }

  let existingRaw;
  try {
    existingRaw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    skipped.push(settingsPath);
    console.warn(`skip (could not read existing ${settingsPath}: ${err.message}) -- merge this manually:\n${hooksOnlySnippet}`);
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
  let isGitDir = false;
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
    copyRawFile(path.join(REPO_ROOT, "hooks", name), path.join(gitDir, "hooks", name), { dryRun, executable: true });
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
`;
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

  console.log(`\nharness-init install — profile=${params.profile} target=${targetRepoPath}${dryRun ? " [DRY RUN]" : ""}\n`);

  // Profile-agnostic core.
  writeTemplateFile(path.join(TEMPLATES_DIR, "status.template.md"), path.join(targetRepoPath, ".harness", "STATUS.md"), map, { dryRun });
  writeTemplateFile(path.join(TEMPLATES_DIR, "phase-handoff.template.md"), path.join(targetRepoPath, ".harness", "PHASE-HANDOFF.md"), map, { dryRun });
  writeTemplateFile(path.join(TEMPLATES_DIR, "project-context.template.md"), path.join(targetRepoPath, ".harness", "PROJECT-CONTEXT.md"), map, { dryRun });
  writeTemplateFile(path.join(TEMPLATES_DIR, "verify.sh.template"), path.join(targetRepoPath, "verify.sh"), map, { dryRun, executable: true });
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "skill", "capture-context", "SKILL.md"),
    path.join(targetRepoPath, ".claude", "skills", "capture-context", "SKILL.md"),
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
    console.log("team-local profile: skipping AGENTS.md append (shared team file — not this account's to change).");
  }

  // Local enforcement hooks + check scripts: both profiles get these —
  // they are local-only (no server dependency) and useful whether or not
  // a server-side gate exists on top.
  copyRawFile(path.join(REPO_ROOT, "hooks", "commit-msg"), path.join(targetRepoPath, "hooks", "commit-msg"), { dryRun, executable: true });
  copyRawFile(path.join(REPO_ROOT, "hooks", "pre-commit"), path.join(targetRepoPath, "hooks", "pre-commit"), { dryRun, executable: true });
  for (const name of [
    "review-gate.mjs",
    "review-gate.test.mjs",
    "relay-handshake.mjs",
    "relay-handshake.test.mjs",
    "role-guard.mjs",
    "role-guard.test.mjs",
    "context-inject.mjs",
    "context-inject.test.mjs",
    "status-fresh.mjs",
    "status-fresh.test.mjs",
    "clear-safe-check.mjs",
    "clear-safe-check.test.mjs",
  ]) {
    copyRawFile(path.join(REPO_ROOT, "scripts", "check", name), path.join(targetRepoPath, "scripts", "check", name), { dryRun, executable: false });
  }

  // .git/hooks/ (per-clone, real install) and .claude/settings.local.json
  // (Claude Code hook pre-wiring) -- both profiles, both one-shot
  // completeness fixes for HYK-95. See installGitHooksIntoDotGit/
  // installSettingsLocal above for the exact conditions and merge rules.
  installGitHooksIntoDotGit(targetRepoPath, { dryRun });
  installSettingsLocal(params, targetRepoPath, { dryRun });

  if (params.profile === "solo-full") {
    // Server-side anchor: CI workflow + gitleaks ruleset. Never automated
    // past the file copy — branch protection, bot invite, and secret
    // scanning are one-time human steps in the GitHub web UI (checklist
    // below), per this repo's own B1 anchor precedent.
    copyRawFile(path.join(REPO_ROOT, ".github", "workflows", "enforce.yml"), path.join(targetRepoPath, ".github", "workflows", "enforce.yml"), { dryRun, executable: false });
    const gitleaksToml = path.join(REPO_ROOT, ".gitleaks.toml");
    if (existsSync(gitleaksToml)) {
      copyRawFile(gitleaksToml, path.join(targetRepoPath, ".gitleaks.toml"), { dryRun, executable: false });
    }
    const checklistPath = path.join(targetRepoPath, ".harness", "github-setup-checklist.md");
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
      console.log(`${dryRun ? "[dry-run] would install" : "installed"}: ${checklistPath}`);
    }
    console.log("\n" + checklist);
  } else {
    console.log("\nteam-local profile: no server-side setup — skipping GitHub checklist (no branch protection or CI to add on a shared team repo).");
  }

  console.log(`\n--- summary ---`);
  console.log(`installed (${installed.length}):`);
  for (const f of installed) console.log(`  + ${f}`);
  console.log(`skipped, already existed (${skipped.length}):`);
  for (const f of skipped) console.log(`  = ${f}`);
  console.log("");
}

main();
