import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The five judgment values this whole module ever returns for a check's
// wiring state (design report §2, "판정 5값 고정") -- listed worst-first so
// combineStatuses below can pick the most severe one deterministically.
export const STATUS_SEVERITY = ["NOT_INSTALLED", "SILENT_BROKEN", "DRIFT", "UNJUDGABLE", "ALIVE"];

const HOOK_EVENTS = ["PreToolUse", "Stop", "SessionStart", "UserPromptSubmit"];

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// Extracts only { hookEvent, matcher, command } from a Claude settings JSON
// object -- never the whole file, never any other field (permissions, env,
// model, statusLine, ...). This is the one place this module ever looks at
// a settings file's shape, satisfying the "JSON 전문·env 값 출력 금지"
// constraint by construction (nothing else is ever read out of it).
export function parseHookCommands(settingsJson) {
  const out = [];
  if (!settingsJson || typeof settingsJson !== "object") return out;
  const hooks = settingsJson.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const hookEvent of HOOK_EVENTS) {
    const entries = hooks[hookEvent];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = typeof entry?.matcher === "string" ? entry.matcher : null;
      const innerHooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const h of innerHooks) {
        if (typeof h?.command === "string") {
          out.push({ hookEvent, matcher, command: h.command });
        }
      }
    }
  }
  return out;
}

// Normalizes a hook command string (backslash/forward-slash agnostic) and
// extracts the scripts/check/<id>.mjs id it invokes -- null if the command
// doesn't reference a check script at all (e.g. a PowerShell notification
// balloon, which is UI, not a check -- see enforcement-inventory.json's
// "전역/CODER 알림 Stop" classification).
const SCRIPT_ID_RE = /scripts[\\/]check[\\/]([A-Za-z0-9_-]+)\.mjs/;
export function extractCheckScriptId(command) {
  if (typeof command !== "string") return null;
  const normalized = command.replace(/\\/g, "/");
  const match = normalized.match(SCRIPT_ID_RE);
  return match ? match[1] : null;
}

// Whether a manifest install_target (id + hookEvent + optional matcher) is
// actually present among a settings file's parsed hook commands.
export function findInstalledTarget(hookCommands, { id, hookEvent, matcher }) {
  const candidates = hookCommands.filter((h) => h.hookEvent === hookEvent && extractCheckScriptId(h.command) === id);
  if (candidates.length === 0) return { installed: false };
  if (matcher) {
    const exact = candidates.find((h) => h.matcher === matcher);
    if (!exact) {
      return { installed: true, matcherMismatch: true, actualMatchers: candidates.map((h) => h.matcher) };
    }
  }
  return { installed: true, matcherMismatch: false };
}

// Every scripts/check/<id>.mjs id referenced anywhere in `hookCommands` that
// is NOT among `expectedIds` -- an invocation the manifest doesn't know
// about at all (G6's "extra" case, e.g. a hand-added hook nobody registered).
export function findExtraInvocations(hookCommands, expectedIds) {
  const expected = new Set(expectedIds);
  const found = new Set();
  for (const h of hookCommands) {
    const id = extractCheckScriptId(h.command);
    if (id && !expected.has(id)) found.add(id);
  }
  return [...found];
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Compares a versioned git hook (tracked in the repo, e.g. hooks/commit-msg)
// against its installed copy (e.g. .git/hooks/commit-msg, or core.hooksPath
// if set) by content hash -- native git hooks have no "settings.json" to
// inspect, so wiring here means "the installed file is byte-identical to
// what's versioned," not "a JSON entry points at it."
export function checkNativeGitHook({
  versionedPath,
  installedPath,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  if (!existsFn(versionedPath)) {
    return { status: "UNJUDGABLE", reason: `versioned hook '${versionedPath}' not found in repo -- cannot compare` };
  }
  if (!existsFn(installedPath)) {
    return {
      status: "NOT_INSTALLED",
      reason: `'${installedPath}' not installed (versioned copy exists at '${versionedPath}')`,
    };
  }
  const versioned = readFileFn(versionedPath);
  const installed = readFileFn(installedPath);
  if (sha256Hex(versioned) !== sha256Hex(installed)) {
    return {
      status: "DRIFT",
      reason: `installed hook '${installedPath}' differs from versioned '${versionedPath}' (sha256 mismatch)`,
    };
  }
  return { status: "ALIVE", reason: `installed hook '${installedPath}' matches versioned copy (sha256 match)` };
}

// 8 days: matches the HYK-129 design's own bootstrap-warning window (a
// canary older than this is treated the same as "never ran" -- ORCH's boot
// reminder for a missed weekly trigger uses the same threshold).
export const DEFAULT_CANARY_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

// A Claude-only check (Stop/PreToolUse/UserPromptSubmit) cannot be judged
// ALIVE from static wiring alone (G9) -- static inspection only proves a
// hook *entry* exists, never that Claude Code actually invoked it and this
// harness observed a real bad->block->good transition. That requires a
// canary receipt: a small JSON record an isolated Claude Stop-hook run (or
// equivalent) writes after actually exercising the check.
export function checkCanaryReceipt({
  id,
  canaryDir,
  now = Date.now(),
  maxAgeMs = DEFAULT_CANARY_MAX_AGE_MS,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  if (!canaryDir) {
    return {
      status: "UNJUDGABLE",
      reason: `no canary receipt directory given -- cannot confirm '${id}' fired under a real Claude runtime event`,
    };
  }
  const receiptPath = join(canaryDir, `${id}.json`);
  if (!existsFn(receiptPath)) {
    return {
      status: "UNJUDGABLE",
      reason: `no canary receipt at '${receiptPath}' -- Claude-only check cannot be ALIVE from static wiring alone (G9)`,
    };
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileFn(receiptPath));
  } catch (err) {
    return { status: "UNJUDGABLE", reason: `canary receipt '${receiptPath}' is not valid JSON (${err.message})` };
  }
  const required = ["check_id", "checked_at", "bad_exit", "good_exit"];
  const missing = required.filter((f) => receipt[f] === undefined || receipt[f] === null || receipt[f] === "");
  if (missing.length) {
    return { status: "UNJUDGABLE", reason: `canary receipt '${receiptPath}' missing field(s): ${missing.join(", ")}` };
  }
  if (receipt.check_id !== id) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt at '${receiptPath}' is for check_id '${receipt.check_id}', not '${id}'`,
    };
  }
  const checkedAt = new Date(receipt.checked_at);
  if (Number.isNaN(checkedAt.getTime())) {
    return { status: "UNJUDGABLE", reason: `canary receipt '${receiptPath}' has an unparseable checked_at ('${receipt.checked_at}')` };
  }
  const ageMs = now - checkedAt.getTime();
  if (ageMs > maxAgeMs) {
    return {
      status: "UNJUDGABLE",
      reason: `canary receipt '${receiptPath}' is ${Math.round(ageMs / 86400000)}d old (max ${Math.round(maxAgeMs / 86400000)}d) -- stale, re-run the canary`,
    };
  }
  return {
    status: "ALIVE",
    reason: `canary receipt fresh (checked_at=${receipt.checked_at}, bad_exit=${receipt.bad_exit}, good_exit=${receipt.good_exit})`,
  };
}

// Manifest install_target paths use a leading placeholder segment
// (REPO/... , CONTROL_ROOM/..., USER_HOME/...) instead of a real root, so
// the manifest itself never hardcodes a machine-specific path -- tests
// substitute temp directories here instead of writing to real settings files.
export function resolvePlaceholderPath(pathTemplate, roots) {
  const m = /^(REPO|CONTROL_ROOM|USER_HOME)\/(.*)$/.exec(pathTemplate);
  if (!m) return null;
  const root = roots[m[1]];
  if (!root) return null;
  return join(root, m[2]);
}

// For a check that's never installed as its own hook but is instead
// imported and called by another script's source (packet-gate.mjs, called
// from role-guard.mjs) -- "wiring" here means "the caller's source still
// references it," checked by a plain substring search over that file.
export function checkSourceReference({ file, pattern, readFileFn = (p) => readFileSync(p, "utf8"), existsFn = existsSync }) {
  if (!existsFn(file)) {
    return { status: "UNJUDGABLE", reason: `referencing file '${file}' not found -- cannot confirm it still calls this check` };
  }
  const text = readFileFn(file);
  if (!text.includes(pattern)) {
    return { status: "SILENT_BROKEN", reason: `'${file}' no longer references '${pattern}' -- caller may have stopped invoking this check` };
  }
  return { status: "ALIVE", reason: `'${file}' still references '${pattern}'` };
}

// CI coverage: every scripts/check/*.test.mjs basename that actually exists
// on disk (discovered dynamically, not hardcoded, so a brand-new check's
// test file is caught even before anyone updates the manifest) must appear
// somewhere in the workflow's text.
export function checkCiCoverage({ workflowText, testFiles }) {
  const missing = testFiles.filter((f) => !workflowText.includes(f));
  if (missing.length === 0) {
    return { status: "ALIVE", missing: [], reason: `all ${testFiles.length} check test suite(s) referenced in CI` };
  }
  return {
    status: "DRIFT",
    missing,
    reason: `${missing.length}/${testFiles.length} check test suite(s) not wired into CI: ${missing.join(", ")}`,
  };
}

// Picks the single worst status among a list, per STATUS_SEVERITY's
// worst-first ordering -- e.g. [ALIVE, DRIFT, ALIVE] -> DRIFT.
export function combineStatuses(statuses) {
  for (const s of STATUS_SEVERITY) {
    if (statuses.includes(s)) return s;
  }
  return "ALIVE";
}

// Judges a single manifest entry against injected file/settings state --
// every filesystem/settings read is a parameter with a real-world default,
// the same injection-point convention as status-fresh.mjs/controlroom-fresh.mjs.
export function judgeEntry(
  entry,
  {
    repoRoot: root,
    roots = {},
    settingsByLocation = {},
    canaryDir,
    now = Date.now(),
    existsFn = existsSync,
    readFileFn = (p) => readFileSync(p, "utf8"),
    testFiles,
  } = {},
) {
  const evidence = [];
  const statuses = [];

  // 1. Script (and, for CI, the workflow file) must exist at all.
  const scriptPath = join(root, entry.script);
  if (!existsFn(scriptPath)) {
    statuses.push("SILENT_BROKEN");
    evidence.push(`script '${entry.script}' not found at '${scriptPath}'`);
  }

  // 2. Test file must exist (S3) -- absence is a DRIFT against this
  // harness's own "every check ships with .test.mjs" convention, not a
  // functional break, so it doesn't outrank SILENT_BROKEN/NOT_INSTALLED.
  if (entry.test) {
    const testPath = join(root, entry.test);
    if (!existsFn(testPath)) {
      statuses.push("DRIFT");
      evidence.push(`test '${entry.test}' not found at '${testPath}' (S3 violation)`);
    }
  }

  // 3. Wiring, dispatched by install_target kind (or a source-reference /
  // CI-coverage special case for entries with no settings-based wiring).
  if (entry.id === "ci-enforce") {
    if (existsFn(scriptPath) && testFiles) {
      const workflowText = readFileFn(scriptPath);
      const ci = checkCiCoverage({ workflowText, testFiles });
      statuses.push(ci.status);
      evidence.push(ci.reason);
    } else if (existsFn(scriptPath)) {
      statuses.push("UNJUDGABLE");
      evidence.push("no discovered test file list given -- cannot judge CI coverage");
    }
  } else if (entry.source_reference_check) {
    const src = checkSourceReference({
      file: join(root, entry.source_reference_check.file),
      pattern: entry.source_reference_check.pattern,
      readFileFn,
      existsFn,
    });
    statuses.push(src.status);
    evidence.push(src.reason);
  } else if (Array.isArray(entry.install_targets) && entry.install_targets.length > 0) {
    for (const target of entry.install_targets) {
      if (target.kind === "git-hook") {
        const git = checkNativeGitHook({
          versionedPath: join(root, target.versioned_path),
          installedPath: join(root, target.installed_path),
          readFileFn,
          existsFn,
        });
        statuses.push(git.status);
        evidence.push(git.reason);
      } else if (target.kind === "claude-settings") {
        const settings = settingsByLocation[target.location];
        if (settings === undefined) {
          statuses.push("UNJUDGABLE");
          evidence.push(`no settings loaded for location '${target.location}' -- cannot judge wiring`);
          continue;
        }
        const hookCommands = parseHookCommands(settings);
        const result = findInstalledTarget(hookCommands, {
          id: entry.id,
          hookEvent: target.hook_event,
          matcher: target.matcher,
        });
        if (!result.installed) {
          statuses.push(target.required ? "NOT_INSTALLED" : "UNJUDGABLE");
          evidence.push(`'${entry.id}' not found in ${target.location}'s ${target.hook_event} hooks`);
        } else if (result.matcherMismatch) {
          statuses.push("DRIFT");
          evidence.push(
            `'${entry.id}' installed in ${target.location}'s ${target.hook_event} but matcher differs (expected '${target.matcher}', found ${JSON.stringify(result.actualMatchers)})`,
          );
        } else {
          evidence.push(`'${entry.id}' wired in ${target.location}'s ${target.hook_event}`);
        }
      }
    }
  } else {
    // install_targets === [] and no source_reference_check (relay-handshake,
    // pm-snapshot-gate): nothing to check beyond script/test existence above,
    // but a report row must still say *why* this is ALIVE rather than
    // leaving evidence empty (review-1 caught an earlier round leaving these
    // two entries' evidence blank in the actual generated report).
    evidence.push(`'${entry.id}' is not hook-installed (ORCH invokes it directly) -- judged from script/test existence alone`);
  }

  // 4. Claude-only checks additionally require a fresh canary receipt (G9),
  // but only once wiring itself hasn't already confirmed a worse problem --
  // no point demanding a canary for a hook that isn't even installed.
  if (entry.claude_only && combineStatuses(statuses) === "ALIVE") {
    const canary = checkCanaryReceipt({ id: entry.id, canaryDir, now });
    statuses.push(canary.status);
    evidence.push(canary.reason);
  }

  const status = statuses.length === 0 ? "ALIVE" : combineStatuses(statuses);
  return { id: entry.id, status, evidence };
}

// Discovers scripts/check/*.test.mjs basenames on disk -- the real,
// dynamic set CI coverage is judged against (not the manifest's own,
// necessarily-incomplete `test` field list).
export function discoverCheckTestFiles(checkDir, readdirFn = readdirSync) {
  return readdirFn(checkDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
}

// Every id a manifest expects at a given claude-settings location (i.e. the
// ids findExtraInvocations should NOT flag there) -- an entry can have more
// than one install_target at the same location (context-inject: SessionStart
// + UserPromptSubmit), so this collects across all of an entry's targets.
export function expectedIdsForLocation(manifest, location) {
  const ids = new Set();
  for (const entry of manifest.checks) {
    for (const target of entry.install_targets ?? []) {
      if (target.kind === "claude-settings" && target.location === location) ids.add(entry.id);
    }
  }
  return [...ids];
}

// G6's "extra" half: for every settings file this run actually loaded,
// finds every scripts/check/<id>.mjs invocation the manifest doesn't expect
// there at all -- a hand-added hook nobody registered. Returns one DRIFT-shaped
// result per extra invocation (prefixed `extra:` so it can never collide with
// a real manifest entry's id), carrying the hookEvent(s) it was found under
// as evidence. review-1 caught an earlier round of this module where
// findExtraInvocations existed, was unit-tested, but nothing ever called it
// from runInventory -- so a real extra hook was silently never reported.
export function findExtraResults(manifest, settingsByLocation) {
  const results = [];
  for (const [location, settings] of Object.entries(settingsByLocation)) {
    if (settings === undefined || settings === null) continue;
    const hookCommands = parseHookCommands(settings);
    const expectedIds = expectedIdsForLocation(manifest, location);
    for (const extraId of findExtraInvocations(hookCommands, expectedIds)) {
      const hookEvents = [...new Set(hookCommands.filter((h) => extractCheckScriptId(h.command) === extraId).map((h) => h.hookEvent))];
      results.push({
        id: `extra:${location}:${extraId}`,
        status: "DRIFT",
        evidence: [
          `manifest에 없는 hook command '${extraId}.mjs' found in ${location}'s ${hookEvents.join(", ")} hooks -- register it in enforcement-inventory.json or remove the hook entry`,
        ],
      });
    }
  }
  return results;
}

export function runInventory({
  manifest,
  repoRoot: root,
  roots = {},
  settingsByLocation = {},
  canaryDir,
  now = Date.now(),
  existsFn = existsSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  testFiles,
}) {
  const results = manifest.checks.map((entry) =>
    judgeEntry(entry, { repoRoot: root, roots, settingsByLocation, canaryDir, now, existsFn, readFileFn, testFiles }),
  );
  results.push(...findExtraResults(manifest, settingsByLocation));
  const summary = { ALIVE: 0, SILENT_BROKEN: 0, DRIFT: 0, UNJUDGABLE: 0, NOT_INSTALLED: 0 };
  for (const r of results) summary[r.status]++;
  return { results, summary };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/selfcheck-inventory.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let manifestPath;
  let canaryDir = process.env.HARNESS_CANARY_DIR;
  let controlRoomPath = process.env.HARNESS_CONTROL_ROOM_PATH || "D:/문서관리/하네스-관제실";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest") manifestPath = args[++i];
    else if (args[i] === "--canary-dir") canaryDir = args[++i];
    else if (args[i] === "--control-room") controlRoomPath = args[++i];
  }
  const root = repoRoot();
  manifestPath = manifestPath || join(root, "scripts", "check", "enforcement-inventory.json");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`selfcheck-inventory: could not read/parse manifest '${manifestPath}' (${err.message})`);
    process.exit(1);
  }

  const roots = { REPO: root, CONTROL_ROOM: controlRoomPath, USER_HOME: process.env.USERPROFILE || process.env.HOME };
  const settingsByLocation = {};
  for (const entry of manifest.checks) {
    for (const target of entry.install_targets ?? []) {
      if (target.kind !== "claude-settings" || settingsByLocation[target.location] !== undefined) continue;
      const resolved = resolvePlaceholderPath(target.path, roots);
      if (resolved && existsSync(resolved)) {
        try {
          settingsByLocation[target.location] = JSON.parse(readFileSync(resolved, "utf8"));
        } catch {
          settingsByLocation[target.location] = null;
        }
      }
    }
  }

  const testFiles = discoverCheckTestFiles(join(root, "scripts", "check"));
  const { results, summary } = runInventory({ manifest, repoRoot: root, roots, settingsByLocation, canaryDir, testFiles });

  console.log(`selfcheck-inventory: ${JSON.stringify(summary)}`);
  for (const r of results) {
    console.log(`  ${r.status.padEnd(14)} ${r.id} -- ${r.evidence.join("; ")}`);
  }
  process.exit(0);
}
