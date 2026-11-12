// HYK-153-engine-profile-1 (coder-task.md §2, piece B of HYK-153) -- single
// config-reading point for role defaults (engine/model/effort) and the
// per-engine attributes production code used to branch on by literal engine
// name (`engine === "codex"` etc). Config lives at ./engine-profiles.json
// (not a new top-level `config/` folder -- templates/harness-init/install.mjs
// has no top-level `config/` copy list). This module lives under
// scripts/check/ (not scripts/relay/, where it was first written) because
// eslint.config.mjs's no-restricted-imports rule makes scripts/relay/* a
// one-way sink -- nothing outside scripts/relay/ may import from it, while
// scripts/check/* may be imported from scripts/relay/, scripts/supervisor/
// and scripts/check/ itself (the actual consumer set here: orca-adapter.mjs,
// dispatch-correlation-adapter.mjs, seat-candidate-adapter.mjs (relay),
// worker-launch-rules.mjs (supervisor), seat-engine-detect.mjs,
// seat-census.mjs, engine-split-rounds.mjs (check)). Decision recorded in
// the config file's own `note` field and in
// docs/control-room-patches/HYK-153-engine-profile.md.
//
// Honesty contract (coder-task.md §2 ⓒ): a missing or malformed config file
// is never papered over with a silent in-code default. loadEngineProfiles
// throws a specific, named reason -- callers that need a non-throwing path
// (e.g. CLI tools) catch and report, they do not get a default handed to
// them. An engine name absent from config.engines is likewise never
// guessed at: getEngineDeliveryMode/getEngineAttr return null for it, and
// assertKnownEngine throws (HYK-472 "엔진 unknown 거부" contract, carried
// forward into the config-reading layer).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// HYK-153-engine-profile-3 (coder-task.md §2 product_scope P2-E): minimal
// path-injection seam -- no CLI flag or other override existed to point a
// *spawned child process* (seat-engine-detect.mjs run as a real CLI,
// engine-split-rounds.mjs's module-top-level pattern read) at a synthetic
// broken config, so committed tests for the config-failure exit-3 path and
// the P2-A missing-pattern path could not drive real entry points without
// writing to the actual shared engine-profiles.json. Follows the existing
// HARNESS_<NAME>_PATH override convention used elsewhere in scripts/check/
// (e.g. HARNESS_STATUS_PATH, HARNESS_CONTROL_ROOM_PATH): unset, the default
// path is exactly what it was before this round.
const DEFAULT_CONFIG_PATH =
  process.env.HARNESS_ENGINE_PROFILES_PATH ||
  join(dirname(fileURLToPath(import.meta.url)), "engine-profiles.json");

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘ): a value that
// is a non-empty string of pure whitespace is, for every consumer of this
// config (a delivery-mode tag, a directory name, a regex source, a marker
// word), exactly as useless/dangerous as "" -- isNonEmptyString alone would
// let "   " through every check below. This is the one closure point for
// the whole "empty config value" family named in that scope: empty string,
// whitespace-only string, an empty array ELEMENT -- never a requirement
// that an array/object itself be non-empty, which stays key-by-key (see
// validateEngines' modelFamilyPatterns/agentMarkerWords comments below for
// which arrays/objects may legitimately be empty and why).
function isNonBlankString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export const ENGINE_PROFILE_LOAD_REASON = Object.freeze({
  CONFIG_FILE_UNREADABLE: "CONFIG_FILE_UNREADABLE",
  CONFIG_FILE_INVALID_JSON: "CONFIG_FILE_INVALID_JSON",
  CONFIG_SCHEMA_INVALID: "CONFIG_SCHEMA_INVALID",
});

class EngineProfileLoadError extends Error {
  constructor(reason, detail) {
    super(`engine-profile: ${reason} -- ${detail}`);
    this.name = "EngineProfileLoadError";
    this.reason = reason;
  }
}

function invalid(configPath, detail) {
  throw new EngineProfileLoadError(
    ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
    `${configPath}: ${detail}`,
  );
}

// HYK-153-engine-profile-2 (coder-task.md §2 P2-2): deliveryMode is a
// closed value set, not merely "any non-empty string" -- a typo or a new
// delivery strategy that forgot to teach deliverTaskInternal about itself
// must fail loudly at config-load time, not fall through
// getEngineDeliveryMode(engine) === "no-inject" as false and silently take
// the claude-shaped branch.
const KNOWN_DELIVERY_MODES = new Set(["inject", "no-inject"]);

// HYK-153-engine-profile-2 (coder-task.md §2 P2-3): these per-engine keys
// are consumed by production code (getEngineAttr(engine,"homeDirName"),
// getEngineModelFamilyPatterns, getEngineAgentMarkerWords) that used to
// default silently (null / {} / []) when the key was simply absent from
// config -- a missing key looked identical to "this engine deliberately
// has none". Requiring the key's *presence* (homeDirName may still be
// null, e.g. codex) turns that silent default into a load-time rejection.
// HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘ): homeDirName
// may be null (codex's deliberate "no home dir"), but a *present, non-null*
// value that is "" or whitespace-only is neither --
// orca-adapter.mjs:2656-2658's isNonEmptyString(homeDirName) guard already
// treats "" the same as null (skip the settings-copy step), so this never
// caused a wrong *action*, only a silently-swallowed typo that looks
// identical to the deliberate null case in a diff review.
function validateEngineHomeDirName(engineName, homeDirName, configPath) {
  if (homeDirName !== null && !isNonBlankString(homeDirName)) {
    invalid(
      configPath,
      `engines.${engineName}.homeDirName must be null or a non-empty string, got ${JSON.stringify(homeDirName)}`,
    );
  }
}

// HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘ, converges the
// review-4/B3 fix in engine-split-rounds.mjs's module-local
// requireFamilyPatterns into this one schema-validation place): an empty
// modelFamilyPatterns OBJECT is fine (codex's real config has one -- no
// consumer presupposes the object itself is non-empty), but a present KEY
// with an empty-string/whitespace-only VALUE is exactly the
// `new RegExp(undefined/"", "i")` match-all bug review-4 found (confirmed
// probe: "gpt-5.6-luna" matched SONNET_FAMILY_PATTERN AND
// "claude-sonnet-5" matched OPUS_FAMILY_PATTERN). Rejecting every present
// key's value here, not just the two keys engine-split-rounds.mjs happens
// to read, closes the family instead of waiting for the next consumer to
// need a third key and rediscover the same bug.
function validateEngineModelFamilyPatterns(
  engineName,
  modelFamilyPatterns,
  configPath,
) {
  for (const [patternKey, patternValue] of Object.entries(
    modelFamilyPatterns,
  )) {
    if (!isNonBlankString(patternValue)) {
      invalid(
        configPath,
        `engines.${engineName}.modelFamilyPatterns.${patternKey} must be a non-empty string, got ${JSON.stringify(patternValue)}`,
      );
    }
  }
}

// HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘ): an empty
// ARRAY is safe -- seat-candidate-adapter.mjs's consumption is
// `CLAUDE_AGENT_MARKERS.some((m) => text.includes(m))`, and `.some()` on an
// empty array is simply false (no consumer presupposes at least one
// marker). An empty-string ELEMENT is the opposite: `"".includes` is never
// called -- `text.includes("")` is, and that is `true` for EVERY `text`,
// turning "no live markers configured" into "every seat preview counts as
// this engine's agent" (the confirmed agentMarkerWords: [""] bug
// coder-task.md §1 names). So the array may be empty; no element in it may
// be blank.
function validateEngineAgentMarkerWords(
  engineName,
  agentMarkerWords,
  configPath,
) {
  for (const [index, word] of agentMarkerWords.entries()) {
    if (!isNonBlankString(word)) {
      invalid(
        configPath,
        `engines.${engineName}.agentMarkerWords[${index}] must be a non-empty string, got ${JSON.stringify(word)}`,
      );
    }
  }
}

// HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘ):
// previewMarkerPattern stays OPTIONAL (an engine may legitimately not
// participate in by-preview-text detection -- matchEngineByPreviewMarkers
// already skips any engine whose pattern fails isNonEmptyString, so
// "absent" and "present but empty" behave identically to that one call
// site today). But a *present* empty/blank value is a regex source string
// (`new RegExp(pattern)`), and leaving it unvalidated means a typo that
// empties this field makes its engine silently and permanently unmatchable
// by preview, with no reasoned failure anywhere -- the same family as
// modelFamilyPatterns/bannerMarkerPatterns above, closed the same way.
function validateEnginePreviewMarkerPattern(engineName, engineCfg, configPath) {
  if (
    "previewMarkerPattern" in engineCfg &&
    !isNonBlankString(engineCfg.previewMarkerPattern)
  ) {
    invalid(
      configPath,
      `engines.${engineName}.previewMarkerPattern must be a non-empty string when present, got ${JSON.stringify(engineCfg.previewMarkerPattern)}`,
    );
  }
}

// HYK-153-adapter-registry-1 (coder-task.md §2 product_scope ⓘ, piece D):
// adapterModule names the repo-root-relative POSIX path of the module
// engine-adapter-registry.mjs's selectRelayAdapterForRole() dynamically
// imports to pick a role's relay adapter port set (ensureSeat/
// observeSeatCandidates/deliverTask/collectCompletionSignals/teardownSeat).
// REQUIRED (unlike homeDirName, never null) -- an engine with no relay
// adapter wired cannot be picked for any role, and that must fail loudly at
// config-load time, not surface later as a silent undefined. Load-layer
// validation is SHAPE-ONLY (string pattern -- no filesystem/existsSync
// check: the installed-target shape of this repo never ships
// scripts/relay/adapters/*, and engine-profile.test.mjs must stay green on
// that installed shape, see templates/harness-init/install-net-closure.test
// .mjs's own header). The picking layer (engine-adapter-registry.mjs) does
// its OWN separate, real-filesystem containment check (realpath-based,
// catches a symlink/junction that passes this shape check but resolves
// outside scripts/relay/adapters/ on disk) -- two layers, two different
// failure classes, per coder-task.md §2 product_scope ⓘⓘⓘ.
const ADAPTER_MODULE_NAME_RE =
  /^scripts\/relay\/adapters\/[a-z0-9][a-z0-9-]*-relay-adapter\.mjs$/;

function validateEngineAdapterModule(engineName, adapterModule, configPath) {
  if (!isNonBlankString(adapterModule)) {
    invalid(
      configPath,
      `engines.${engineName}.adapterModule must be a non-empty string, got ${JSON.stringify(adapterModule)}`,
    );
  }
  if (!ADAPTER_MODULE_NAME_RE.test(adapterModule)) {
    invalid(
      configPath,
      `engines.${engineName}.adapterModule must match ${ADAPTER_MODULE_NAME_RE} (repo-root-relative POSIX path directly under scripts/relay/adapters/, no '..', no absolute path, no backslash, no subfolder), got ${JSON.stringify(adapterModule)}`,
    );
  }
}

// HYK-153-engine-profile-2 (coder-task.md §2 P2-3): these per-engine keys
// are consumed by production code (getEngineAttr(engine,"homeDirName"),
// getEngineModelFamilyPatterns, getEngineAgentMarkerWords) that used to
// default silently (null / {} / []) when the key was simply absent from
// config -- a missing key looked identical to "this engine deliberately
// has none". Requiring the key's *presence* (homeDirName may still be
// null, e.g. codex) turns that silent default into a load-time rejection.
// HYK-153-engine-profile-4 split the per-key empty-VALUE checks into the
// small validateEngine*() helpers above so this function's own cyclomatic
// complexity stays low -- each helper is one key's whole rule, not one
// branch among many here.
function validateEngines(engines, configPath) {
  if (!isPlainObject(engines) || Object.keys(engines).length === 0) {
    invalid(configPath, `"engines" must be a non-empty object`);
  }
  for (const [engineName, engineCfg] of Object.entries(engines)) {
    if (!isPlainObject(engineCfg)) {
      invalid(configPath, `engines.${engineName} must be an object`);
    }
    if (!KNOWN_DELIVERY_MODES.has(engineCfg.deliveryMode)) {
      invalid(
        configPath,
        `engines.${engineName}.deliveryMode must be one of ${[...KNOWN_DELIVERY_MODES].join(", ")}, got ${JSON.stringify(engineCfg.deliveryMode)}`,
      );
    }
    if (!("homeDirName" in engineCfg)) {
      invalid(
        configPath,
        `engines.${engineName}.homeDirName is required (may be null)`,
      );
    }
    validateEngineHomeDirName(engineName, engineCfg.homeDirName, configPath);
    if (!isPlainObject(engineCfg.modelFamilyPatterns)) {
      invalid(
        configPath,
        `engines.${engineName}.modelFamilyPatterns must be an object (may be empty)`,
      );
    }
    validateEngineModelFamilyPatterns(
      engineName,
      engineCfg.modelFamilyPatterns,
      configPath,
    );
    if (!Array.isArray(engineCfg.agentMarkerWords)) {
      invalid(
        configPath,
        `engines.${engineName}.agentMarkerWords must be an array (may be empty)`,
      );
    }
    validateEngineAgentMarkerWords(
      engineName,
      engineCfg.agentMarkerWords,
      configPath,
    );
    validateEnginePreviewMarkerPattern(engineName, engineCfg, configPath);
    if (!("adapterModule" in engineCfg)) {
      invalid(configPath, `engines.${engineName}.adapterModule is required`);
    }
    validateEngineAdapterModule(
      engineName,
      engineCfg.adapterModule,
      configPath,
    );
  }
}

// HYK-153-engine-profile-2 (coder-task.md §2 P2-3): bannerMarkerPatterns.*
// is consumed by getBannerMarkerPattern("orcaAdapterAgentMarker"/
// "seatCensusAgentBanner") -- same silent-default problem as the per-engine
// keys above, fixed the same way (required presence, rejected at load).
const REQUIRED_BANNER_MARKER_PATTERN_KEYS = [
  "orcaAdapterAgentMarker",
  "seatCensusAgentBanner",
];

function validateBannerMarkerPatterns(bannerMarkerPatterns, configPath) {
  if (!isPlainObject(bannerMarkerPatterns)) {
    invalid(configPath, `"bannerMarkerPatterns" must be an object`);
  }
  for (const key of REQUIRED_BANNER_MARKER_PATTERN_KEYS) {
    // HYK-153-engine-profile-4: upgraded to the blank-aware check (coder-task
    // §2 product_scope ⓘ) -- these are regex source strings
    // (orca-adapter.mjs's AGENT_MARKER_RE / seat-census.mjs's
    // AGENT_BANNER_MARKERS), and a whitespace-only value is as useless a
    // detector as "" while passing the plain length check B2 originally
    // wrote here.
    if (!isNonBlankString(bannerMarkerPatterns[key])) {
      invalid(
        configPath,
        `bannerMarkerPatterns.${key} must be a non-empty string`,
      );
    }
  }
}

function validateRoles(roles, engines, configPath) {
  if (!isPlainObject(roles) || Object.keys(roles).length === 0) {
    invalid(configPath, `"roles" must be a non-empty object`);
  }
  for (const [role, roleCfg] of Object.entries(roles)) {
    if (!isPlainObject(roleCfg)) {
      invalid(configPath, `roles.${role} must be an object`);
    }
    // HYK-153-engine-profile-4: upgraded to isNonBlankString (coder-task.md
    // §2 product_scope ⓘ) -- engine/model/effort all drive the same
    // "copied verbatim, no substitution" path getRoleProfile returns to
    // callers (e.g. the CLI's `engine=<value>` output line), so a
    // whitespace-only value is exactly as empty in spirit as "".
    if (!isNonBlankString(roleCfg.engine) || !engines[roleCfg.engine]) {
      invalid(
        configPath,
        `roles.${role}.engine must name a key present in "engines"`,
      );
    }
    if (!isNonBlankString(roleCfg.model)) {
      invalid(configPath, `roles.${role}.model must be a non-empty string`);
    }
    if (!isNonBlankString(roleCfg.effort)) {
      invalid(configPath, `roles.${role}.effort must be a non-empty string`);
    }
  }
}

function validateSchema(parsed, configPath) {
  if (!isPlainObject(parsed)) {
    invalid(configPath, "top-level value is not an object");
  }
  validateEngines(parsed.engines, configPath);
  validateRoles(parsed.roles, parsed.engines, configPath);
  validateBannerMarkerPatterns(parsed.bannerMarkerPatterns, configPath);
  return parsed;
}

// loadEngineProfiles(configPath?) -- the one production entry point that
// reads engine-profiles.json off disk. No caching: callers that want a
// cheap repeated lookup use the helpers below, which call this once and
// hold the result in a local variable, not a module-level singleton --
// CODER-task honesty rule §4 (synthetic/mkdtemp configs in tests must drive
// this exact function, not a copy, and must not collide with a cached
// value left over from a previous test).
export function loadEngineProfiles(configPath = DEFAULT_CONFIG_PATH) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new EngineProfileLoadError(
      ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_UNREADABLE,
      `${configPath}: ${err.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new EngineProfileLoadError(
      ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_INVALID_JSON,
      `${configPath}: ${err.message}`,
    );
  }
  const profiles = validateSchema(parsed, configPath);
  // HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘⓘ): the one
  // self-report cell on the loaded result object -- whichever path was
  // actually read (default or HARNESS_ENGINE_PROFILES_PATH-injected), a
  // caller holding `profiles` can see it without re-deriving it from the
  // env var. Not part of the validated schema itself (added after
  // validateSchema returns), so it is never mistaken for config content.
  profiles.configPathUsed = configPath;
  return profiles;
}

// getKnownEngines(profiles?) -- replaces the old hardcoded
// KNOWN_ENGINES = ["claude", "codex"] array (worker-launch-rules.mjs).
export function getKnownEngines(profiles = loadEngineProfiles()) {
  return Object.keys(profiles.engines);
}

// assertKnownEngine(engine, profiles?) -- HYK-472 "엔진 unknown 거부"
// contract: throws (does not guess / does not default) when `engine` is
// not a key in config.engines.
export function assertKnownEngine(engine, profiles = loadEngineProfiles()) {
  if (!isNonEmptyString(engine) || !profiles.engines[engine]) {
    throw new Error(
      `engine-profile: unknown engine ${JSON.stringify(engine)} (known: ${getKnownEngines(profiles).join(", ")})`,
    );
  }
  return engine;
}

// getEngineByRole(profiles?) -- replaces the old hardcoded
// ENGINE_BY_ROLE = { CODER: "claude", REVIEW: "codex", VERIFY: "claude" }
// object in orca-adapter.mjs. Frozen, same shape: { [role]: engineName }.
export function getEngineByRole(profiles = loadEngineProfiles()) {
  const out = {};
  for (const [role, roleCfg] of Object.entries(profiles.roles)) {
    out[role] = roleCfg.engine;
  }
  return Object.freeze(out);
}

// getRoleProfile(role, profiles?) -- {engine, model, effort} for a role, or
// null if the role is not in config.roles (roles outside ENGINE_BY_ROLE's
// old domain, e.g. ORCH/PM, are legitimately absent -- callers decide what
// "no profile" means for them, this module does not guess a default).
export function getRoleProfile(role, profiles = loadEngineProfiles()) {
  const roleCfg = profiles.roles[role];
  if (!isPlainObject(roleCfg)) return null;
  return {
    engine: roleCfg.engine,
    model: roleCfg.model,
    effort: roleCfg.effort,
  };
}

// getEngineDeliveryMode(engine, profiles?) -- "inject" | "no-inject" | null.
// This is the profile attribute that replaces every
// `engine === "claude"` / `engine === "codex"` delivery-routing branch
// (orca-adapter.mjs deliverTaskInternal, dispatch-correlation-adapter.mjs
// judgeInjectedProfile): both now compare deliveryMode, never the engine
// name literal. null (not a throw) for an unknown engine -- callers that
// must distinguish "no side effects for unknown profiles" (D11) from a
// thrown exception rely on this being a quiet null.
export function getEngineDeliveryMode(engine, profiles = loadEngineProfiles()) {
  const cfg = profiles.engines[engine];
  return isPlainObject(cfg) ? cfg.deliveryMode : null;
}

export function getEngineAttr(engine, attr, profiles = loadEngineProfiles()) {
  const cfg = profiles.engines[engine];
  if (!isPlainObject(cfg)) return null;
  return attr in cfg ? cfg[attr] : null;
}

// matchEngineByPreviewMarkers(previewText, profiles?) -- tests every
// engine's previewMarkerPattern against previewText and returns the engine
// name if exactly one matches, or null if zero or more than one match
// (ambiguous/no-evidence; HYK-472 2R "엔진을 추측하지 않고 거부"). Replaces
// seat-engine-detect.mjs's old hardcoded
// CLAUDE_ENGINE_MARKERS/CODEX_ENGINE_MARKERS + literal "claude"/"codex"
// return values -- no engine-name literal is written in that file anymore,
// the names come back as data read from config.
export function matchEngineByPreviewMarkers(
  previewText,
  profiles = loadEngineProfiles(),
) {
  const text = String(previewText ?? "");
  const matches = [];
  for (const [engineName, engineCfg] of Object.entries(profiles.engines)) {
    const pattern = engineCfg.previewMarkerPattern;
    if (isNonEmptyString(pattern) && new RegExp(pattern).test(text)) {
      matches.push(engineName);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// describePreviewMarkerPatterns(profiles?) -- {engineName: patternSource}
// for building a human-readable "which markers did I look for" message
// (seat-engine-detect.mjs describeUnknown) without hardcoding the pattern
// text a second time.
export function describePreviewMarkerPatterns(profiles = loadEngineProfiles()) {
  const out = {};
  for (const [engineName, engineCfg] of Object.entries(profiles.engines)) {
    out[engineName] = engineCfg.previewMarkerPattern ?? null;
  }
  return out;
}

export function getBannerMarkerPattern(name, profiles = loadEngineProfiles()) {
  const patterns = isPlainObject(profiles.bannerMarkerPatterns)
    ? profiles.bannerMarkerPatterns
    : {};
  return isNonEmptyString(patterns[name]) ? patterns[name] : null;
}

export function getEngineModelFamilyPatterns(
  engine,
  profiles = loadEngineProfiles(),
) {
  const cfg = profiles.engines[engine];
  return isPlainObject(cfg) && isPlainObject(cfg.modelFamilyPatterns)
    ? cfg.modelFamilyPatterns
    : {};
}

export function getEngineAgentMarkerWords(
  engine,
  profiles = loadEngineProfiles(),
) {
  const cfg = profiles.engines[engine];
  return isPlainObject(cfg) && Array.isArray(cfg.agentMarkerWords)
    ? cfg.agentMarkerWords
    : [];
}

export const DEFAULT_ENGINE_PROFILES_PATH = DEFAULT_CONFIG_PATH;
export { ADAPTER_MODULE_NAME_RE };
