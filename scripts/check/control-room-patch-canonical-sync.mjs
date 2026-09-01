// HYK-415 (canonical-sync-1): new check axis -- "does a control-room patch
// document that touches a repo-pinned function fingerprint ship together
// with the matching fingerprint update?"
//
// Incident this axis targets (2026-09-01, coder-task.md §0-C): ORCH applied
// docs/control-room-patches/HYK-271-wire-modal-check.md's patch unit to the
// live control-room dispatch-worker.ps1. That patch's content lands inside
// Invoke-SeatProofGate's function body, so the live file's fingerprint
// moved -- but scripts/check/seat-proof-wrapper-canonical.json (the repo's
// pinned "known-good" fingerprint for that function) was not updated in the
// same change. Local seat-proof-wrapper-shape.test.mjs's live-file
// regression test caught the drift and went RED, which in turn tripped the
// HYK-411 consumption gate and forced a rollback. This module mechanizes
// the check that should have caught this *before* apply: "if a patch
// document's applied effect changes a pinned function's body, the repo's
// canonical fingerprint for that function must already equal the applied
// result."
//
// Scope / honesty limit (task §1-3 "한계"): this module knows about exactly
// ONE pinned function/file pair -- Invoke-SeatProofGate in
// dispatch-worker.ps1, pinned by seat-proof-wrapper-canonical.json (see
// PINNED_FUNCTION_REGISTRY below). It does NOT generalize to "any file this
// repo pins a fingerprint for" -- there happens to be exactly one such file
// in this repo today (verified: scripts/relay/auth-grant-canonical.mjs and
// pull-grant-canonical.mjs are unrelated JSON-serialization canonicalizers,
// not function-fingerprint pins). Extending coverage to a second pinned
// pair requires adding a second PINNED_FUNCTION_REGISTRY entry AND a second
// extractBody function (extractAllFunctionBodies, imported below, is
// hard-coded to the name "Invoke-SeatProofGate" inside
// seat-proof-wrapper-shape.mjs -- it is not parameterizable today).
//
// Default-to-danger rule (task §1-3 "미열거의 기본값은 위험"): a patch
// document is in this axis's scope the moment it mentions the pinned
// function's name anywhere in its text (docs without a resolvable
// `--source` fixture are NOT silently skipped just because this checker
// cannot compute their applied effect -- see SOURCE_UNRESOLVED below,
// which is a RED, fail-closed outcome, not a pass). A doc can only escape
// that fail-closed default via an explicit EXEMPTIONS entry that names a
// reason (see below) -- there are none today (both docs that currently
// mention the pinned function name, HYK-271-wire-modal-check.md and
// HYK-327-wire-two-checkers.md, resolve a literal source and are checked
// for real, not exempted).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyControlRoomPatch } from "./control-room-patch-apply.mjs";
import { extractAllFunctionBodies } from "./seat-proof-wrapper-shape.mjs";

export const REASON = Object.freeze({
  OK_NOT_APPLICABLE: "OK_NOT_APPLICABLE", // doc doesn't mention the pinned function at all
  OK_UNCHANGED: "OK_UNCHANGED", // doc mentions it, but applying the patch doesn't change its body
  OK_SYNCED: "OK_SYNCED", // doc's applied body matches the currently-pinned fingerprint
  OK_EXEMPT: "OK_EXEMPT", // explicit exemption with a reason (see EXEMPTIONS)
  CANONICAL_NOT_SYNCED: "CANONICAL_NOT_SYNCED", // applied body != pinned fingerprint
  SOURCE_UNRESOLVED: "SOURCE_UNRESOLVED", // mentions the function, no single resolvable --source fixture
  PATCH_APPLY_FAILED: "PATCH_APPLY_FAILED", // applyControlRoomPatch rejected the doc
  SOURCE_FUNCTION_NOT_FOUND: "SOURCE_FUNCTION_NOT_FOUND", // source fixture itself has no such function
});

const RED_REASONS = new Set([
  REASON.CANONICAL_NOT_SYNCED,
  REASON.SOURCE_UNRESOLVED,
  REASON.PATCH_APPLY_FAILED,
  REASON.SOURCE_FUNCTION_NOT_FOUND,
]);

// The one known pinned function/file pair (see module header honesty note).
export const PINNED_FUNCTION_REGISTRY = Object.freeze([
  Object.freeze({
    functionName: "Invoke-SeatProofGate",
    canonicalJsonRelPath: "scripts/check/seat-proof-wrapper-canonical.json",
    extractBodies: extractAllFunctionBodies,
  }),
]);

// Explicit per-doc exemptions from the fail-closed default. Each entry MUST
// carry a non-empty `reason` -- validateExemptions() below throws at
// startup if one doesn't, so a reason-less exemption can never silently
// take effect. Empty today: every doc currently in scope resolves a real
// source and is checked for real (see module header).
export const EXEMPTIONS = Object.freeze([]);

function validateExemptions(exemptions) {
  for (const e of exemptions) {
    if (!e.doc || !e.functionName || !e.reason || !e.reason.trim()) {
      throw new Error(
        `control-room-patch-canonical-sync: malformed EXEMPTIONS entry ${JSON.stringify(e)} -- ` +
          `doc, functionName, and a non-empty reason are all required (fail-closed: a reason-less ` +
          `exemption must never silently take effect)`,
      );
    }
  }
}

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

function fingerprintOf(extractBodies, scriptText) {
  const bodies = extractBodies(normalizeNewlines(scriptText));
  if (bodies.length === 0) return null;
  const live = bodies[bodies.length - 1];
  if (live === null) return null;
  return createHash("sha256").update(live, "utf8").digest("hex");
}

// Finds every literal, existing, non-live `--source <path>` fixture this
// doc's own text names. Placeholder tokens (`<원본>` etc, containing `<`),
// Windows absolute drive paths (`D:\...`, the live control room), and
// paths that don't resolve to a real file are all excluded. Returns the
// deduplicated set of resolved absolute paths -- callers require exactly
// one to proceed (§1-3 "미열거의 기본값은 위험": zero or ambiguous-many
// both fail closed, see SOURCE_UNRESOLVED).
export function resolveDocSourcePaths(
  docText,
  repoRoot,
  { fileExists = existsSync } = {},
) {
  const re = /--source\s+"?([^\s"]+)"?/g;
  const found = new Set();
  let m;
  while ((m = re.exec(docText)) !== null) {
    const raw = m[1];
    if (raw.includes("<") || /^[A-Za-z]:/.test(raw) || raw.includes("\\")) {
      continue; // placeholder or a live Windows path -- never resolvable/desired here
    }
    const abs = join(repoRoot, raw);
    if (fileExists(abs)) found.add(abs);
  }
  return [...found];
}

// Resolves the exactly-one literal source fixture this doc names, or a
// fail-closed SOURCE_UNRESOLVED result. Split out of
// judgeDocAgainstPinnedFunction purely to keep that function's cyclomatic
// complexity within this repo's lint budget -- no behavior change.
function resolveSingleSource(docText, entry, { repoRoot, fileExists }) {
  const sources = resolveDocSourcePaths(docText, repoRoot, { fileExists });
  if (sources.length !== 1) {
    return {
      ok: false,
      reasonCode: REASON.SOURCE_UNRESOLVED,
      detail:
        `doc mentions ${entry.functionName} but names ${sources.length} resolvable literal ` +
        `--source fixture(s) (need exactly 1) -- cannot compute this patch's applied effect, ` +
        `fail-closed`,
    };
  }
  return { ok: true, path: sources[0] };
}

// Applies the doc's patch unit(s) to `sourceText` and returns the pinned
// function's before/after fingerprints, or a fail-closed result explaining
// why that couldn't be computed. Split out for the same reason as
// resolveSingleSource above.
function computeBeforeAfterHashes(docText, entry, sourceText, sourcePath) {
  const beforeHash = fingerprintOf(entry.extractBodies, sourceText);
  if (beforeHash === null) {
    return {
      ok: false,
      reasonCode: REASON.SOURCE_FUNCTION_NOT_FOUND,
      detail: `source fixture ${sourcePath} has no ${entry.functionName} function (or unbalanced braces)`,
    };
  }

  const applied = applyControlRoomPatch(docText, sourceText);
  if (!applied.ok) {
    return {
      ok: false,
      reasonCode: REASON.PATCH_APPLY_FAILED,
      detail: `applyControlRoomPatch rejected: ${applied.reasonCode} -- ${applied.reason}`,
    };
  }

  return {
    ok: true,
    beforeHash,
    afterHash: fingerprintOf(entry.extractBodies, applied.result),
  };
}

// Compares the applied-effect hashes against the pinned canonical value.
// Split out for the same complexity-budget reason as the two helpers above.
function judgeAgainstCanonical(entry, canonical, beforeHash, afterHash) {
  if (afterHash === beforeHash) {
    return { reasonCode: REASON.OK_UNCHANGED };
  }

  if (canonical && canonical.sha256 === afterHash) {
    return { reasonCode: REASON.OK_SYNCED };
  }

  return {
    reasonCode: REASON.CANONICAL_NOT_SYNCED,
    detail:
      `patch changes ${entry.functionName}'s body (before=${beforeHash} after=${afterHash}) but ` +
      `pinned canonical sha256=${canonical ? canonical.sha256 : "(missing)"} does not match the ` +
      `applied result -- this doc's effect is not accounted for in the pinned fingerprint`,
  };
}

// Judges a single (doc, pinnedFunction) pair. `readFile`/`fileExists` are
// injectable for tests; default to real node:fs calls.
export function judgeDocAgainstPinnedFunction(
  docText,
  docRelPath,
  entry,
  canonical,
  {
    repoRoot,
    readFile = (p) => readFileSync(p, "utf8"),
    fileExists = existsSync,
    exemptions = EXEMPTIONS,
  } = {},
) {
  if (!docText.includes(entry.functionName)) {
    return { reasonCode: REASON.OK_NOT_APPLICABLE };
  }

  const exemption = exemptions.find(
    (e) => e.doc === docRelPath && e.functionName === entry.functionName,
  );
  if (exemption) {
    return { reasonCode: REASON.OK_EXEMPT, detail: exemption.reason };
  }

  const resolved = resolveSingleSource(docText, entry, {
    repoRoot,
    fileExists,
  });
  if (!resolved.ok)
    return { reasonCode: resolved.reasonCode, detail: resolved.detail };

  const sourceText = readFile(resolved.path);
  const hashes = computeBeforeAfterHashes(
    docText,
    entry,
    sourceText,
    resolved.path,
  );
  if (!hashes.ok)
    return { reasonCode: hashes.reasonCode, detail: hashes.detail };

  return judgeAgainstCanonical(
    entry,
    canonical,
    hashes.beforeHash,
    hashes.afterHash,
  );
}

// Full sweep: every *.md under docsDir that carries a
// ```control-room-patch-unit fence, judged against every registry entry.
export function checkControlRoomPatchCanonicalSync({
  repoRoot,
  docsDir = join(repoRoot, "docs", "control-room-patches"),
  registry = PINNED_FUNCTION_REGISTRY,
  exemptions = EXEMPTIONS,
  readFile = (p) => readFileSync(p, "utf8"),
  readdir = readdirSync,
} = {}) {
  validateExemptions(exemptions);

  const docFiles = readdir(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const findings = [];
  for (const file of docFiles) {
    const docAbsPath = join(docsDir, file);
    const docRelPath = `docs/control-room-patches/${file}`;
    const docText = readFile(docAbsPath);
    if (!docText.includes("```control-room-patch-unit")) continue; // not "적용 가능"

    for (const entry of registry) {
      const canonicalAbsPath = join(repoRoot, entry.canonicalJsonRelPath);
      let canonical;
      try {
        canonical = JSON.parse(readFile(canonicalAbsPath));
      } catch {
        canonical = null; // judged as CANONICAL_MISSING-equivalent mismatch below
      }
      const result = judgeDocAgainstPinnedFunction(
        docText,
        docRelPath,
        entry,
        canonical,
        {
          repoRoot,
          readFile,
          exemptions,
        },
      );
      findings.push({
        doc: docRelPath,
        functionName: entry.functionName,
        ...result,
      });
    }
  }

  const redFindings = findings.filter((f) => RED_REASONS.has(f.reasonCode));
  return {
    ok: redFindings.length === 0,
    findings,
    redFindings,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/control-room-patch-canonical-sync.mjs");
if (invokedDirectly) {
  const { execFileSync } = await import("node:child_process");
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();

  const { ok, findings, redFindings } = checkControlRoomPatchCanonicalSync({
    repoRoot,
  });

  for (const f of findings) {
    const line = `${f.reasonCode}: ${f.doc} (${f.functionName})`;
    console.log(f.detail ? `${line} -- ${f.detail}` : line);
  }

  if (ok) {
    console.log(
      `CANONICAL_SYNC: OK -- ${findings.length} (doc, function) pair(s) checked, 0 unsynced`,
    );
    process.exit(0);
  }
  console.log(`CANONICAL_SYNC: RED -- ${redFindings.length} finding(s) above`);
  process.exit(2);
}
