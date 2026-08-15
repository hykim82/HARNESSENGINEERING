// HYK-252 -- CLI wrapper + shadow-log writer for repair-authority-core.mjs.
//
// This is the ONLY module allowed to touch fs -- repair-authority-core.mjs
// stays pure (see its own header). This file: (1) reads an input JSON file,
// (2) calls the pure judge, (3) prints a one-line-readable summary to
// stdout, (4) appends a NON-authoritative shadow-log record to a caller-
// supplied path that is validated to be safely inside a caller-supplied
// fixture root -- never inside this repo, never inside any `.harness`,
// `receipts`, or `ledger` path, no matter how the caller points `--log`.
//
// There is NO hardcoded control-room/production log path anywhere below.
// `--log` and `--fixture-root` are both required CLI arguments; there is no
// default that would let this CLI write anywhere on its own.
//
// Usage:
//   node scripts/supervisor/repair-authority-shadow.mjs \
//     --input <path.json> --log <path-under-fixture-root> \
//     --fixture-root <dir> [--authority <path.json>]
//
// --authority is optional and, when given, is the ONLY source of
// authoritative expected-signature/identity/digest values -- see
// repair-authority-core.mjs's judgeRepairAuthority header. Omitting it is
// safe (checks fail closed toward DENY -- there is no module-owned frozen
// fallback digest to fall back to; authority must supply BOTH the policy
// and manifest digest or the digest check is itself a hard DENY); it must
// never be satisfied by fields embedded in --input itself.
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { judgeRepairAuthority } from "./repair-authority-core.mjs";

// Defense-in-depth (task requirement): reject any resolved path that
// contains one of these segments anywhere, case-insensitively, even if it
// is nominally under --fixture-root (e.g. fixture-root itself pointed AT a
// `.harness` directory).
const FORBIDDEN_SEGMENT_RE = /(^|[\\/])(\.harness|receipts|ledger)([\\/]|$)/i;

export const CLOSED_POLICY_BANNER = "CLOSED_POLICY_INCOMPLETE";

function findRepoRoot(startDir) {
  for (let dir = startDir; ;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function containmentReject(childReal, ancestorReal) {
  const rel = relative(ancestorReal, childReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rejectIfRepoAdjacent(resolvedLogReal, cwd, existsFn) {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;
  const repoRootReal = realpathSync(repoRoot);
  if (containmentReject(resolvedLogReal, repoRootReal)) {
    return `--log path resolves inside the git repo root (${repoRootReal}) -- shadow logs must never touch the repo`;
  }
  if (containmentReject(repoRootReal, resolvedLogReal)) {
    return `--log path is an ancestor of the git repo root (${repoRootReal}) -- rejected`;
  }
  return void existsFn;
}

function resolveFixtureRootReal(fixtureRootArg, realpathFn) {
  try {
    return { ok: true, value: realpathFn(fixtureRootArg) };
  } catch (err) {
    return {
      ok: false,
      reason: `--fixture-root does not exist or is unreadable: ${fixtureRootArg} (${err.message})`,
    };
  }
}

// Walks every ancestor path component of `pathAbs` (from root down to the
// full path itself) and lstat()s each one that currently exists. If any
// existing component is a symlink -- which on this platform also covers
// NTFS junctions and other reparse points, since Node's fs.lstat reports
// those via isSymbolicLink() -- this rejects BEFORE any mkdir/append is
// attempted. HYK-252-shadow-judge-2 review fix: the prior version only
// canonicalized the *parent directory* of --log and never lstat'd the
// final log-file path itself, so an already-existing symlinked final file
// was joined back onto the (correctly canonicalized) real parent by
// basename alone and then appendFileSync silently followed it outside
// --fixture-root. This check runs first, before resolveLogParentReal's
// mkdirFn call, so a malicious existing symlink/junction/reparse point --
// whether it is the final log file itself or one of its ancestor
// directories -- is caught before any filesystem mutation happens.
function rejectIfAnyPathComponentIsSymlink(pathAbs, lstatFn) {
  const components = [];
  for (let cur = pathAbs; ;) {
    components.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const component of components) {
    let stat;
    try {
      stat = lstatFn(component);
    } catch {
      continue; // does not exist yet -- nothing to check at this level
    }
    if (stat.isSymbolicLink()) {
      return `path component already exists and is a symlink/junction/reparse point (rejected before any mkdir/append): ${component}`;
    }
  }
  return null;
}

// Creates (if needed) and canonicalizes the parent directory of --log, then
// returns the fully-resolved candidate log path joined back onto that real
// parent. Split out of resolveLogPathSafely purely to keep that function's
// cyclomatic complexity under this repo's eslint limit (12) -- no behavior
// change from the inline version.
function resolveLogParentReal(logArg, mkdirFn, realpathFn) {
  const resolvedLogAbs = resolve(logArg);
  const parentDir = dirname(resolvedLogAbs);
  try {
    mkdirFn(parentDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `cannot create parent directory for --log: ${parentDir} (${err.message})`,
    };
  }
  try {
    const parentReal = realpathFn(parentDir);
    return { ok: true, value: join(parentReal, basename(resolvedLogAbs)) };
  } catch (err) {
    return {
      ok: false,
      reason: `--log parent directory not resolvable after mkdir: ${parentDir} (${err.message})`,
    };
  }
}

// The three defense-in-depth checks against the already-resolved,
// canonicalized paths: fixture-root containment, forbidden production-
// shaped segments, and repo-root adjacency. Returns a rejection reason
// string, or null if all three pass.
function checkLogPathConstraints(
  resolvedLogReal,
  fixtureRootReal,
  cwd,
  existsFn,
) {
  if (!containmentReject(resolvedLogReal, fixtureRootReal)) {
    return `--log path resolves outside --fixture-root: ${resolvedLogReal} is not under ${fixtureRootReal}`;
  }
  if (
    FORBIDDEN_SEGMENT_RE.test(resolvedLogReal) ||
    FORBIDDEN_SEGMENT_RE.test(fixtureRootReal)
  ) {
    return `--log path or --fixture-root contains a forbidden production-shaped segment (.harness/receipts/ledger): ${resolvedLogReal}`;
  }
  return rejectIfRepoAdjacent(resolvedLogReal, cwd, existsFn);
}

// Combines fixture-root resolution, the pre-mkdir symlink/junction/reparse
// guard (both on the raw path and again on the post-mkdir canonicalized
// one), and parent-directory canonicalization. Split out of
// resolveLogPathSafely purely to keep that function's cyclomatic
// complexity under this repo's eslint limit (12) -- no behavior change.
// Returns {ok:true, fixtureRootReal, resolvedLogPath} or {ok:false, reason}.
function resolveAndGuardLogParent(logArg, fixtureRootArg, fns) {
  const { mkdirFn, realpathFn, lstatFn } = fns;
  const fixtureRootResult = resolveFixtureRootReal(fixtureRootArg, realpathFn);
  if (!fixtureRootResult.ok) return fixtureRootResult;

  // Symlink/junction/reparse check runs BEFORE any mkdir/append -- on the
  // raw (uncanonicalized-parent) absolute path, so an existing malicious
  // component is caught even before the parent directory is touched.
  const resolvedLogAbs = resolve(logArg);
  const symlinkRejection = rejectIfAnyPathComponentIsSymlink(
    resolvedLogAbs,
    lstatFn,
  );
  if (symlinkRejection) return { ok: false, reason: symlinkRejection };

  const logParentResult = resolveLogParentReal(logArg, mkdirFn, realpathFn);
  if (!logParentResult.ok) return logParentResult;

  // Re-check the fully-canonicalized candidate too (defense in depth: the
  // parent's realpath could differ from its pre-mkdir form in edge cases).
  const finalSymlinkRejection = rejectIfAnyPathComponentIsSymlink(
    logParentResult.value,
    lstatFn,
  );
  if (finalSymlinkRejection)
    return { ok: false, reason: finalSymlinkRejection };

  return {
    ok: true,
    fixtureRootReal: fixtureRootResult.value,
    resolvedLogPath: logParentResult.value,
  };
}

// Resolves --log against --fixture-root with full canonicalization
// (symlinks/junctions/reparse points included, via fs.realpathSync), and
// rejects BEFORE any write happens. Returns {ok:true, resolvedLogPath} or
// {ok:false, reason}.
export function resolveLogPathSafely({
  logArg,
  fixtureRootArg,
  cwd = process.cwd(),
  mkdirFn = mkdirSync,
  realpathFn = realpathSync,
  existsFn = existsSync,
  lstatFn = lstatSync,
} = {}) {
  if (!fixtureRootArg)
    return { ok: false, reason: "--fixture-root is required" };
  if (!logArg) return { ok: false, reason: "--log is required" };

  const guarded = resolveAndGuardLogParent(logArg, fixtureRootArg, {
    mkdirFn,
    realpathFn,
    lstatFn,
  });
  if (!guarded.ok) return guarded;

  const rejection = checkLogPathConstraints(
    guarded.resolvedLogPath,
    guarded.fixtureRootReal,
    cwd,
    existsFn,
  );
  if (rejection) return { ok: false, reason: rejection };

  return { ok: true, resolvedLogPath: guarded.resolvedLogPath };
}

export function buildShadowRecord({ input, verdict, timestamp }) {
  const record = {
    recordType: "NON_AUTHORITATIVE_REPAIR_SHADOW_V1",
    authoritative: false,
    eligibleForGateConsumption: false,
    gateEffect: "NONE",
    timestamp,
    issueId: input.issueId,
    repairTaskId: input.repairTaskId,
    dispatchId: input.dispatchId,
    verdict,
  };
  if (Object.prototype.hasOwnProperty.call(input, "sourceEvidence")) {
    record.sourceEvidence = input.sourceEvidence;
  }
  return record;
}

export function formatSummary(verdict) {
  return [
    `verdict: ${verdict.verdict}`,
    `primaryReasonCode: ${verdict.primaryReasonCode}`,
    `blockingReasons: ${JSON.stringify(verdict.blockingReasons)}`,
    `evidenceClass: ${verdict.evidenceClass}`,
    `operationalEligibility=${verdict.operationalEligibility}`,
    `actualGateEffect=${verdict.actualGateEffect}`,
    `authoritative=false`,
    CLOSED_POLICY_BANNER,
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--log") args.log = argv[++i];
    else if (argv[i] === "--fixture-root") args.fixtureRoot = argv[++i];
    else if (argv[i] === "--authority") args.authority = argv[++i];
  }
  return args;
}

// Testable orchestration entry point -- everything the CLI does, minus
// process.exit/argv parsing, with injectable fs functions.
export function runShadowJudgment({
  inputPath,
  logPath,
  fixtureRoot,
  authorityPath,
  cwd = process.cwd(),
  readFileFn = readFileSync,
  appendFileFn = appendFileSync,
  now = () => new Date().toISOString(),
} = {}) {
  if (!inputPath)
    return { ok: false, exitCode: 1, message: "--input is required" };

  const safety = resolveLogPathSafely({
    logArg: logPath,
    fixtureRootArg: fixtureRoot,
    cwd,
  });
  if (!safety.ok) {
    return {
      ok: false,
      exitCode: 1,
      message: `log path rejected: ${safety.reason}`,
    };
  }

  let inputJson;
  try {
    inputJson = JSON.parse(readFileFn(inputPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      message: `--input not readable/parseable: ${err.message}`,
    };
  }

  // Authority context is optional and, when supplied, MUST come from a
  // separate file (--authority), never from fields embedded in --input --
  // see repair-authority-core.mjs's judgeRepairAuthority header for why.
  // When omitted, an empty authority context is used: signature/identity
  // cross-checks then fail safe toward SIGNATURE_UNAUTHORIZED/
  // IDENTITY_BOUNDARY_MISMATCH (no authoritative reference supplied), and
  // the digest check fails safe too -- there is no frozen module-owned
  // fallback digest; authority must supply BOTH expectedPolicyDigest and
  // expectedManifestDigest as non-empty strings or the digest axis is a
  // hard DENY (POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING). Honesty limit:
  // authority's digests are still whatever the caller supplied, not a
  // live SHA-256 read of the FROZEN policy doc / approved manifest.
  let authorityJson = {};
  if (authorityPath) {
    try {
      authorityJson = JSON.parse(readFileFn(authorityPath, "utf8"));
    } catch (err) {
      return {
        ok: false,
        exitCode: 1,
        message: `--authority not readable/parseable: ${err.message}`,
      };
    }
  }

  const verdict = judgeRepairAuthority(inputJson, authorityJson);
  const record = buildShadowRecord({
    input: inputJson,
    verdict,
    timestamp: now(),
  });
  appendFileFn(safety.resolvedLogPath, JSON.stringify(record) + "\n", "utf8");

  return {
    ok: true,
    exitCode: 0,
    message: formatSummary(verdict),
    resolvedLogPath: safety.resolvedLogPath,
    verdict,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/repair-authority-shadow.mjs");
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const outcome = runShadowJudgment({
    inputPath: args.input,
    logPath: args.log,
    fixtureRoot: args.fixtureRoot,
    authorityPath: args.authority,
  });
  if (outcome.ok) {
    console.log(outcome.message);
    process.exit(0);
  } else {
    console.error(outcome.message);
    process.exit(outcome.exitCode ?? 1);
  }
}
