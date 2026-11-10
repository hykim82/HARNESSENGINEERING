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

const DEFAULT_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "engine-profiles.json",
);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
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

function validateEngines(engines, configPath) {
  if (!isPlainObject(engines) || Object.keys(engines).length === 0) {
    invalid(configPath, `"engines" must be a non-empty object`);
  }
  for (const [engineName, engineCfg] of Object.entries(engines)) {
    if (!isPlainObject(engineCfg)) {
      invalid(configPath, `engines.${engineName} must be an object`);
    }
    if (!isNonEmptyString(engineCfg.deliveryMode)) {
      invalid(
        configPath,
        `engines.${engineName}.deliveryMode must be a non-empty string`,
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
    if (!isNonEmptyString(roleCfg.engine) || !engines[roleCfg.engine]) {
      invalid(
        configPath,
        `roles.${role}.engine must name a key present in "engines"`,
      );
    }
    if (!isNonEmptyString(roleCfg.model)) {
      invalid(configPath, `roles.${role}.model must be a non-empty string`);
    }
    if (!isNonEmptyString(roleCfg.effort)) {
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
  return validateSchema(parsed, configPath);
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
