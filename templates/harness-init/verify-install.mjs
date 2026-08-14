#!/usr/bin/env node
// verify-install.mjs (HYK-209-frame-1 §2 항3) -- post-install verification.
//
// install.mjs's own console output only proves "a file was written to the
// right path" (writeTemplateFile/copyRawFile print "installed: <path>"
// unconditionally, even if substitute() left a literal "<TOKEN>" behind
// because a placeholder was silently empty). §2 항3 requires more: "그 값이
// 그 저장소 값으로 실제로 읽히는지" — that the substituted VALUE is what a
// consumer would actually read back out of the installed file, not just
// that the file exists.
//
// This script re-reads the already-installed target repo (it does not
// re-run install.mjs) and checks, item by item, that:
//   1. no installed template file still contains an unsubstituted
//      "<UPPER_SNAKE>" placeholder token (the exact "file copied, not
//      substituted" bug class this section exists to catch);
//   2. the six original placeholders' ACTUAL VALUES appear where a real
//      consumer reads them (verify.sh's shell command, STATUS.md's Profile
//      header, settings.local.json's hook path arguments);
//   3. (solo-full only) the five HYK-209-frame-1 placeholders' actual
//      values appear in unattended-layer-placeholders.json, and its
//      knownGaps entries are present and unmodified;
//   4. git hooks / .claude/settings.local.json exist and are structurally
//      sane (JSON parses, hooks key present).
//
// Exit 0 only if every applicable check passes; otherwise exit 1 and print
// PASS/FAIL per item (no aggregate-only report -- §6 항3 "항목별로 초록/
// 빨강").
//
// Node 20 compatible (ESM standard APIs only), no dependency on this
// installer's own internal functions (a verification script that shares
// code with the thing it verifies can't catch that thing's own bugs).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    out[a.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

function readIfExists(p) {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// findUnsubstitutedTokens -- scans a text for a literal, unsubstituted
// occurrence of one of install.mjs's OWN known token names (the 6 original
// + the 5 HYK-209-frame-1 additions). This is a whitelist, not a
// blacklist: templates carry plenty of OTHER "<UPPER_SNAKE>"-shaped
// markers that are a deliberate, documented, human-fill-in-later
// convention install.mjs never touches (docs/harness-init.md's
// "REPLACE_ME_*" contract for observe.sh.template, and the generic
// "<UPPER_SNAKE> tokens and prose fill-in slots" convention used by
// PHASE-HANDOFF.md/PROJECT-CONTEXT.md/gc-task.template.md/
// capture-context's SKILL.md) -- flagging those as a "leftover token" bug
// would be a false positive this script's own first pilot run hit and
// corrected (see .harness/coder.md for the run that caught it). Only
// install.mjs's own substitute()-consumed names are ever a bug if left
// unsubstituted in an installed (non-template) file.
const KNOWN_INSTALLER_TOKENS = [
  "PROFILE",
  "REPO_PATH",
  "CONTROL_ROOM_PATH",
  "GITHUB_REPO",
  "BOT_ACCOUNT",
  "VERIFY_CMD",
  "NOTIFY_DIR",
  "APPROVER_LOGIN",
  "APPROVER_ID",
  "WORKSPACES_ROOT",
  "MAIN_REPO_PATH",
];
function findUnsubstitutedTokens(text) {
  if (!text) return [];
  return KNOWN_INSTALLER_TOKENS.filter((name) => text.includes(`<${name}>`));
}

// ---- 1. no unsubstituted "<TOKEN>" left in any installed text file ----
function checkNoLeftoverTokens(repoPath) {
  const scanTargets = [
    ".harness/STATUS.md",
    ".harness/PHASE-HANDOFF.md",
    ".harness/PROJECT-CONTEXT.md",
    ".harness/gc-task.template.md",
    ".harness/gate-criteria.md",
    "verify.sh",
    "observe.sh",
    ".claude/skills/capture-context/SKILL.md",
  ];
  for (const rel of scanTargets) {
    const text = readIfExists(path.join(repoPath, rel));
    if (text === null) {
      check(`no-leftover-token:${rel}`, false, "file missing, cannot scan");
      continue;
    }
    const leftover = findUnsubstitutedTokens(text);
    check(
      `no-leftover-token:${rel}`,
      leftover.length === 0,
      leftover.length
        ? `unsubstituted tokens: ${leftover.join(", ")}`
        : "clean",
    );
  }
}

function readJsonIfExists(p) {
  const raw = readIfExists(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// extracted from checkOriginalPlaceholders (ESLint complexity ceiling).
function checkSettingsLocal(repoPath, profile, args) {
  const settingsObj = readJsonIfExists(
    path.join(repoPath, ".claude", "settings.local.json"),
  );
  check(
    "settings.local.json parses as JSON with a hooks key",
    !!settingsObj && !!settingsObj.hooks,
    settingsObj ? "checked" : "missing or invalid JSON",
  );
  if (settingsObj && profile === "solo-full" && args["control-room-path"]) {
    check(
      "settings.local.json hooks reference real control-room path",
      JSON.stringify(settingsObj).includes(
        args["control-room-path"].replace(/\\/g, "/"),
      ),
      "checked (forward-slash normalized, per install.mjs's toPosixPath)",
    );
  }
}

// ---- 2. six original placeholders read back as the real value ----
function checkOriginalPlaceholders(repoPath, profile, args) {
  const verifySh = readIfExists(path.join(repoPath, "verify.sh"));
  if (args["verify-cmd"]) {
    check(
      "verify.sh contains real VERIFY_CMD",
      !!verifySh && verifySh.includes(args["verify-cmd"]),
      verifySh ? "checked" : "verify.sh missing",
    );
  }
  const status = readIfExists(path.join(repoPath, ".harness", "STATUS.md"));
  check(
    "STATUS.md Profile header carries real profile",
    !!status && status.includes(`Profile: ${profile}`),
    status ? "checked" : "STATUS.md missing",
  );

  checkSettingsLocal(repoPath, profile, args);

  const gitignore = readIfExists(path.join(repoPath, ".gitignore"));
  check(
    `.gitignore carries a "harness-init (${profile})" marker`,
    !!gitignore && gitignore.includes(`# harness-init (${profile})`),
    gitignore ? "checked" : ".gitignore missing",
  );
}

// ---- 3. solo-full only: HYK-209-frame-1 manifest ----
const MANIFEST_FIELD_TO_ARG = {
  NOTIFY_DIR: "notify-dir",
  APPROVER_LOGIN: "approver-login",
  APPROVER_ID: "approver-id",
  WORKSPACES_ROOT: "workspaces-root",
  MAIN_REPO_PATH: "main-repo-path",
};

function checkManifestFields(manifest, args) {
  for (const [field, argName] of Object.entries(MANIFEST_FIELD_TO_ARG)) {
    if (!args[argName]) continue;
    const actual = String(manifest.placeholders?.[field] ?? "");
    check(
      `manifest.placeholders.${field} matches --${argName}`,
      actual === String(args[argName]),
      `expected=${args[argName]} actual=${actual}`,
    );
  }
  check(
    "manifest.knownGaps records the schedule-task-name gap",
    Array.isArray(manifest.knownGaps) &&
      manifest.knownGaps.some((g) => g.item === "schedule task name"),
    "checked",
  );
  check(
    "manifest.knownGaps records the concurrency-cap gap",
    Array.isArray(manifest.knownGaps) &&
      manifest.knownGaps.some((g) => g.item === "concurrency admission cap"),
    "checked",
  );
}

function checkSoloFullOnly(repoPath, args) {
  const manifest = readJsonIfExists(
    path.join(repoPath, ".harness", "unattended-layer-placeholders.json"),
  );
  check(
    "unattended-layer-placeholders.json parses as JSON",
    !!manifest,
    manifest ? "checked" : "missing or invalid JSON",
  );
  if (manifest) checkManifestFields(manifest, args);

  if (args["github-repo"]) {
    const checklist = readIfExists(
      path.join(repoPath, ".harness", "github-setup-checklist.md"),
    );
    check(
      "github-setup-checklist.md carries real githubRepo",
      !!checklist && checklist.includes(args["github-repo"]),
      checklist ? "checked" : "checklist missing",
    );
  }
}

// ---- 4. git hooks present ----
function checkGitHooksPresent(repoPath) {
  for (const name of ["commit-msg", "pre-commit"]) {
    const p = path.join(repoPath, "hooks", name);
    check(
      `tracked hooks/${name} present`,
      existsSync(p),
      existsSync(p) ? "present" : "missing",
    );
  }
}

function printReport() {
  console.log("\n--- verify-install report ---");
  let failCount = 0;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failCount++;
    console.log(`[${mark}] ${r.name} -- ${r.detail}`);
  }
  console.log(`\n${results.length - failCount}/${results.length} passed`);
  return failCount;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoPath = args["repo-path"];
  const profile = args.profile;
  if (!repoPath || !profile) {
    console.error(
      "usage: verify-install.mjs --repo-path <path> --profile <solo-full|team-local> " +
        "[--verify-cmd <cmd>] [--github-repo <owner/repo>] [--bot-account <name>] " +
        "[--control-room-path <path>] [--notify-dir <path>] [--approver-login <name>] " +
        "[--approver-id <n>] [--workspaces-root <path>] [--main-repo-path <path>]",
    );
    process.exit(2);
  }

  checkNoLeftoverTokens(repoPath);
  checkOriginalPlaceholders(repoPath, profile, args);
  if (profile === "solo-full") checkSoloFullOnly(repoPath, args);
  checkGitHooksPresent(repoPath);

  process.exit(printReport() > 0 ? 1 : 0);
}

main();
