// HYK-153-adapter-registry-1 (coder-task.md §2, piece D of HYK-153): the
// single picking point between a role and the relay adapter port set
// (ensureSeat/observeSeatCandidates/deliverTask/collectCompletionSignals/
// teardownSeat + execFn) it should use to talk to that role's seat.
// run-step.mjs no longer imports any ./adapters/*.mjs module statically --
// it calls selectRelayAdapterForRole(role) and uses whatever it returns
// (coder-task.md §2 product_scope ⓘⓘⓘⓘ).
//
// Honesty contract (coder-task.md §2 ⓘⓘⓘ "고름 층"): this module never
// throws and never falls back to a default adapter. Every failure is a
// reasoned { ok: false, reasonCode, reason } -- an engine with no adapter
// wired, or whose adapter module fails to resolve/import/satisfy the port
// contract, is refused, never silently routed through whichever adapter
// happens to load.
//
// Two layers of validation, two different failure classes (same §2 ⓘⓘⓘ):
//   - the config SHAPE (engine-profile.mjs's schema validation, enforced at
//     loadEngineProfiles() time -- a missing key, an empty/blank value, or
//     a string that does not match the adapterModule naming pattern) is a
//     load-time throw this module catches and passes through verbatim
//     (EngineProfileLoadError.reason, e.g. CONFIG_SCHEMA_INVALID).
//   - the real FILESYSTEM containment of the resolved path (this module's
//     own isWithinAllowedDir, below) is a SEPARATE, real-path-resolved
//     check: a string that matches the naming pattern can still be a
//     symlink/junction on disk that resolves outside
//     scripts/relay/adapters/ -- the shape check cannot see that, so this
//     module re-checks it itself, after resolving real paths, before ever
//     importing anything.
import { realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadEngineProfiles,
  getRoleProfile,
  getEngineAttr,
} from "../check/engine-profile.mjs";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object" && typeof err.message === "string") {
      return err.message;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

export const ADAPTER_SELECT_REASON = Object.freeze({
  ROLE_PROFILE_MISSING: "ROLE_PROFILE_MISSING",
  ADAPTER_MODULE_MISSING: "ADAPTER_MODULE_MISSING",
  ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR: "ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR",
  ADAPTER_MODULE_IMPORT_FAILED: "ADAPTER_MODULE_IMPORT_FAILED",
  ADAPTER_CONTRACT_INVALID: "ADAPTER_CONTRACT_INVALID",
});

// HYK-153-adapter-registry-1 (coder-task.md §2 product_scope ⓘⓘⓘ "기준 경로
// = 등록부 모듈 자기 위치에서 계산한 저장소 루트(설정 파일 위치 아님)"):
// this anchor is fixed at this module's own on-disk location -- it is
// never read from config or from any opts, so a synthetic config injected
// via HARNESS_ENGINE_PROFILES_PATH (or a test's own loadProfilesFn) cannot
// widen where an adapterModule is allowed to resolve.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ALLOWED_ADAPTER_DIR = resolve(
  REPO_ROOT,
  "scripts",
  "relay",
  "adapters",
);

export const REQUIRED_ADAPTER_PORTS = Object.freeze([
  "ensureSeat",
  "observeSeatCandidates",
  "deliverTask",
  "collectCompletionSignals",
  "teardownSeat",
]);

function fail(reasonCode, reason, extra = {}) {
  return { ok: false, reasonCode, reason, ...extra };
}

// realpath resolution with a safe fallback: a non-existent path cannot be
// realpath'd (ENOENT) -- in that case there is no symlink/junction to
// resolve, so the literal (already path.resolve-normalized, `..`-free)
// path is used as-is. A missing file is not this function's job to
// report -- the subsequent dynamic import() call reports that as
// ADAPTER_MODULE_IMPORT_FAILED.
function resolveRealOrLiteral(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

// Containment check, real-filesystem-anchored: a symlink/junction placed
// directly under scripts/relay/adapters/ (passing the load-layer naming
// pattern) can still resolve, on disk, to a target outside that directory
// -- this is the check the naming-pattern regex structurally cannot make
// (it only ever sees the string, never what it points to).
function isWithinAllowedDir(adapterModule) {
  const literalPath = resolve(REPO_ROOT, adapterModule);
  const real = resolveRealOrLiteral(literalPath);
  const allowedReal = resolveRealOrLiteral(ALLOWED_ADAPTER_DIR);
  const rel = relative(allowedReal, dirname(real));
  const within = rel === "" && !isAbsolute(rel);
  return { literalPath, real, within };
}

function validateAdapterContract(created) {
  if (!isPlainObject(created)) {
    return "createRelayAdapter did not return an object";
  }
  if (!isPlainObject(created.adapter)) {
    return "createRelayAdapter result is missing an 'adapter' object";
  }
  for (const port of REQUIRED_ADAPTER_PORTS) {
    if (typeof created.adapter[port] !== "function") {
      return `createRelayAdapter's adapter is missing required port '${port}'`;
    }
  }
  if (typeof created.execFn !== "function") {
    return "createRelayAdapter result is missing an 'execFn' function";
  }
  return null;
}

function loadProfilesOrFail(opts) {
  const loadFn =
    typeof opts.loadProfilesFn === "function"
      ? opts.loadProfilesFn
      : loadEngineProfiles;
  try {
    return { ok: true, profiles: loadFn() };
  } catch (err) {
    const reasonCode =
      isPlainObject(err) && isNonEmptyString(err.reason)
        ? err.reason
        : "ENGINE_PROFILE_LOAD_FAILED";
    return fail(
      reasonCode,
      `engine-adapter-registry: loading engine profiles failed (${errText(err)})`,
    );
  }
}

async function importAdapterModule(literalPath, opts) {
  const importFn =
    typeof opts.importFn === "function"
      ? opts.importFn
      : (href) => import(href);
  try {
    return { ok: true, mod: await importFn(pathToFileURL(literalPath).href) };
  } catch {
    return null;
  }
}

// selectRelayAdapterForRole(role, opts?) -- the one production entry point
// run-step.mjs calls. Never throws. opts.loadProfilesFn/opts.importFn are
// test-only injection seams (default to the real loadEngineProfiles()/
// dynamic import()) -- production call sites never pass them.
export async function selectRelayAdapterForRole(role, opts = {}) {
  const loaded = loadProfilesOrFail(opts);
  if (!loaded.ok) return loaded;
  const { profiles } = loaded;

  const roleProfile = getRoleProfile(role, profiles);
  if (!roleProfile) {
    return fail(
      ADAPTER_SELECT_REASON.ROLE_PROFILE_MISSING,
      `engine-adapter-registry: no role profile for role ${JSON.stringify(role)}`,
    );
  }

  const engine = roleProfile.engine;
  const adapterModule = getEngineAttr(engine, "adapterModule", profiles);
  if (!isNonEmptyString(adapterModule)) {
    return fail(
      ADAPTER_SELECT_REASON.ADAPTER_MODULE_MISSING,
      `engine-adapter-registry: engine ${JSON.stringify(engine)} (role ${JSON.stringify(role)}) has no adapterModule configured`,
    );
  }

  const { literalPath, within } = isWithinAllowedDir(adapterModule);
  if (!within) {
    return fail(
      ADAPTER_SELECT_REASON.ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR,
      `engine-adapter-registry: adapterModule '${adapterModule}' resolves outside the allowed directory (${ALLOWED_ADAPTER_DIR}) after real-path resolution`,
    );
  }

  const imported = await importAdapterModule(literalPath, opts);
  if (!imported) {
    return fail(
      ADAPTER_SELECT_REASON.ADAPTER_MODULE_IMPORT_FAILED,
      `engine-adapter-registry: importing adapterModule '${adapterModule}' failed`,
    );
  }
  const { mod } = imported;

  if (typeof mod.createRelayAdapter !== "function") {
    return fail(
      ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
      `engine-adapter-registry: adapterModule '${adapterModule}' does not export createRelayAdapter(selection)`,
    );
  }

  let created;
  try {
    created = mod.createRelayAdapter({
      role,
      engine,
      profile: roleProfile,
      adapterModule,
      configPathUsed: profiles.configPathUsed,
    });
  } catch (err) {
    return fail(
      ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
      `engine-adapter-registry: adapterModule '${adapterModule}' createRelayAdapter threw (${errText(err)})`,
    );
  }

  const contractError = validateAdapterContract(created);
  if (contractError) {
    return fail(
      ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
      `engine-adapter-registry: adapterModule '${adapterModule}' -- ${contractError}`,
    );
  }

  return {
    ok: true,
    adapter: created.adapter,
    execFn: created.execFn,
    engine,
    role,
    adapterModule,
  };
}
