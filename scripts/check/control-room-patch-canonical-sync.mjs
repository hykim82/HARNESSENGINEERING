// HYK-415 (canonical-sync-1/2): check axis -- "does a control-room patch
// document that touches a repo-pinned function fingerprint ship together
// with EVERY repo-tracked copy of that fingerprint, kept in sync?"
//
// Incident this axis targets (2026-09-01, coder-task.md §0-C, 1R): ORCH
// applied docs/control-room-patches/HYK-271-wire-modal-check.md's patch
// unit to the live control-room dispatch-worker.ps1. That patch's content
// lands inside Invoke-SeatProofGate's function body, so the live file's
// fingerprint moved -- but scripts/check/seat-proof-wrapper-canonical.json
// (the repo's pinned "known-good" fingerprint for that function) was not
// updated in the same change. Local seat-proof-wrapper-shape.test.mjs's
// live-file regression test caught the drift and went RED, which in turn
// tripped the HYK-411 consumption gate and forced a rollback.
//
// 2R widening (HYK-415-canonical-sync-2, 책임자 판정 2026-09-01 20:15):
// 1R's fix updated canonical.json but left OTHER checked-in copies of the
// same function body -- seat-proof-wrapper-fixtures.mjs's
// FIXED_FUNCTION_TEXT and a dedicated post-HYK-271 snapshot fixture --
// unsynced from canonical.json's own tests until a *second* manual sweep
// found and fixed them. That is exactly the failure mode this axis exists
// to prevent, just one layer deeper: "the fingerprint has more than one
// checked-in copy, and syncing only the one the incident happened to touch
// isn't enough." This module now verifies ALL registered copies together,
// not just canonical.json.
//
// Scope / honesty limit (kept from 1R, still true): this module knows
// about exactly ONE pinned FUNCTION -- Invoke-SeatProofGate. Extending
// coverage to a second pinned function requires a second
// PINNED_FUNCTION_REGISTRY entry AND a second extractBody function
// (extractAllFunctionBodies, imported below, is hard-coded to the name
// "Invoke-SeatProofGate" inside seat-proof-wrapper-shape.mjs -- it is not
// parameterizable today).
//
// Default-to-danger rule (task §1-3/2R-1-2 "미열거의 기본값은 위험"), two
// layers:
//   (a) doc-vs-copies (unchanged from 1R): a patch document is in scope
//       the moment it mentions the pinned function's name; a doc this
//       axis can't mechanically verify (no resolvable literal --source)
//       is SOURCE_UNRESOLVED (RED), never silently skipped.
//   (b) copy-registry-vs-repo (NEW in 2R): every git-tracked file that
//       literally mentions "Invoke-SeatProofGate" must be classified in
//       MENTION_BASELINE below as either a registered `copy` (checked for
//       sync, see PINNED_FUNCTION_REGISTRY[].copies) or an explicitly
//       reasoned `reference` (mentions the name but is provably not a
//       body-copy needing sync -- doc prose, checker/test code, or a
//       frozen historical snapshot no test compares against canonical).
//       A file the repo scan finds that ISN'T in MENTION_BASELINE is
//       UNREGISTERED_MENTION (RED) -- this is what answers "how do you
//       know you found every copy": you don't, permanently and by
//       construction (see §3 of the result file) -- but any FUTURE new
//       mention of the function name in a git-tracked file, copy or not,
//       trips this ratchet until a human classifies it here. That is the
//       actual guarantee, not "I grepped once and trust the list forever."

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { applyControlRoomPatch } from "./control-room-patch-apply.mjs";
import { extractAllFunctionBodies } from "./seat-proof-wrapper-shape.mjs";

export const REASON = Object.freeze({
  OK_NOT_APPLICABLE: "OK_NOT_APPLICABLE", // doc doesn't mention the pinned function at all
  OK_UNCHANGED: "OK_UNCHANGED", // doc mentions it, but applying the patch doesn't change its body
  OK_SYNCED: "OK_SYNCED", // doc's applied body matches EVERY registered copy
  OK_EXEMPT: "OK_EXEMPT", // explicit exemption with a reason (see EXEMPTIONS)
  CANONICAL_NOT_SYNCED: "CANONICAL_NOT_SYNCED", // applied body != at least one registered copy
  SOURCE_UNRESOLVED: "SOURCE_UNRESOLVED", // mentions the function, no single resolvable --source fixture
  PATCH_APPLY_FAILED: "PATCH_APPLY_FAILED", // applyControlRoomPatch rejected the doc
  SOURCE_FUNCTION_NOT_FOUND: "SOURCE_FUNCTION_NOT_FOUND", // source fixture itself has no such function
  UNREGISTERED_MENTION: "UNREGISTERED_MENTION", // a repo file mentions the pinned function but isn't classified in MENTION_BASELINE
});

const RED_REASONS = new Set([
  REASON.CANONICAL_NOT_SYNCED,
  REASON.SOURCE_UNRESOLVED,
  REASON.PATCH_APPLY_FAILED,
  REASON.SOURCE_FUNCTION_NOT_FOUND,
  REASON.UNREGISTERED_MENTION,
]);

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

// A "copy" is a repo-tracked location that is supposed to hold a
// live-matching snapshot of the pinned function's body. `getHash(ctx)`
// returns the copy's CURRENT hash (or null if unreadable/malformed --
// treated as fail-closed unsynced, never silently skipped). `ctx` is
// `{ repoRoot, readFile, importModule }`, all injectable for tests so a
// mutation test can feed a stale value into exactly one copy without
// touching any real file on disk.
export const PINNED_FUNCTION_REGISTRY = Object.freeze([
  Object.freeze({
    functionName: "Invoke-SeatProofGate",
    extractBodies: extractAllFunctionBodies,
    copies: Object.freeze([
      Object.freeze({
        id: "scripts/check/seat-proof-wrapper-canonical.json:sha256",
        relPath: "scripts/check/seat-proof-wrapper-canonical.json",
        getHash: (ctx) => {
          try {
            return (
              JSON.parse(
                ctx.readFile(
                  join(
                    ctx.repoRoot,
                    "scripts/check/seat-proof-wrapper-canonical.json",
                  ),
                ),
              ).sha256 ?? null
            );
          } catch {
            return null;
          }
        },
      }),
      Object.freeze({
        id: "scripts/check/seat-proof-wrapper-fixtures.mjs:FIXED_FUNCTION_TEXT",
        relPath: "scripts/check/seat-proof-wrapper-fixtures.mjs",
        getHash: async (ctx) => {
          try {
            const mod = await ctx.importModule(
              join(
                ctx.repoRoot,
                "scripts/check/seat-proof-wrapper-fixtures.mjs",
              ),
            );
            return fingerprintOf(
              extractAllFunctionBodies,
              mod.FIXED_FUNCTION_TEXT,
            );
          } catch {
            return null;
          }
        },
      }),
      Object.freeze({
        id: "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
        relPath:
          "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
        getHash: (ctx) => {
          try {
            return fingerprintOf(
              extractAllFunctionBodies,
              ctx.readFile(
                join(
                  ctx.repoRoot,
                  "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
                ),
              ),
            );
          } catch {
            return null;
          }
        },
      }),
      Object.freeze({
        id: "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied-hyk271-synced.ps1.txt",
        relPath:
          "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied-hyk271-synced.ps1.txt",
        getHash: (ctx) => {
          try {
            return fingerprintOf(
              extractAllFunctionBodies,
              ctx.readFile(
                join(
                  ctx.repoRoot,
                  "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied-hyk271-synced.ps1.txt",
                ),
              ),
            );
          } catch {
            return null;
          }
        },
      }),
    ]),
  }),
]);

// Every git-tracked file this round found (exhaustive grep, 2026-09-01 --
// `git ls-files | xargs grep -l "Invoke-SeatProofGate"`) that mentions the
// pinned function name, classified. `role: "copy"` entries MUST also
// appear in PINNED_FUNCTION_REGISTRY[].copies above (checkMentionRegistry
// below cross-checks this). `role: "reference"` entries carry a `reason`
// -- checkMentionRegistry throws at startup if one is missing/empty, same
// fail-closed contract as EXEMPTIONS.
export const MENTION_BASELINE = Object.freeze([
  // -- registered copies (see PINNED_FUNCTION_REGISTRY[0].copies) --
  { relPath: "scripts/check/seat-proof-wrapper-canonical.json", role: "copy" },
  { relPath: "scripts/check/seat-proof-wrapper-fixtures.mjs", role: "copy" },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
    role: "copy",
  },
  {
    relPath:
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied-hyk271-synced.ps1.txt",
    role: "copy",
  },
  // -- checker/test/behavior-harness code: mentions the function name in
  // source/comments/registry entries, never embeds a standalone body copy
  // this axis would need to keep synced (verified by reading each file) --
  {
    relPath: "scripts/check/control-room-patch-canonical-sync.mjs",
    role: "reference",
    reason:
      "this checker itself -- registry/comments name the function, not a body copy",
  },
  {
    relPath: "scripts/check/control-room-patch-canonical-sync.test.mjs",
    role: "reference",
    reason:
      "test file -- builds synthetic small function bodies for its own unit tests, not a copy of the real pinned body",
  },
  {
    relPath: "scripts/check/seat-proof-wrapper-behavior.mjs",
    role: "reference",
    reason:
      "behavioral test harness -- mentions the function name in comments and writes a fake modal-check stub; does not embed the pinned body itself",
  },
  {
    relPath: "scripts/check/seat-proof-wrapper-shape.mjs",
    role: "reference",
    reason:
      "the fingerprint/shape checker itself -- FUNCTION_NAME constant names the function, this file contains no body copy",
  },
  {
    relPath: "scripts/check/seat-proof-wrapper-shape.test.mjs",
    role: "reference",
    reason:
      "test file -- imports FIXED_FUNCTION_TEXT from the registered copy rather than embedding its own; also builds small synthetic BROKEN/BYPASS bodies for negative tests, none asserted to match canonical",
  },
  {
    relPath:
      "scripts/check/seat-proof-wrapper-shape-hyk327-applied-snapshot.test.mjs",
    role: "reference",
    reason:
      "test file -- reads the registered fixture copy above, does not embed its own body text",
  },
  // -- design/patch docs: prose describing the function, or (for patch
  // docs with a machine-applicable unit) already governed by the
  // doc-vs-copies check in this same module (judgeDocAgainstPinnedFunction
  // below), not a standalone body copy needing its own sync check --
  {
    relPath: "docs/control-room-patches/HYK-271-preflight-preview-marker.md",
    role: "reference",
    reason:
      "design doc prose, no control-room-patch-unit fence (not machine-applicable, not a body copy)",
  },
  {
    relPath: "docs/control-room-patches/HYK-271-wire-modal-check.md",
    role: "reference",
    reason:
      "patch doc with a unit -- already checked by judgeDocAgainstPinnedFunction (doc-vs-copies), not itself a standalone copy",
  },
  {
    relPath: "docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md",
    role: "reference",
    reason: "design doc prose, no control-room-patch-unit fence",
  },
  {
    relPath:
      "docs/control-room-patches/HYK-323-seat-proof-wrapper-shape-check.md",
    role: "reference",
    reason: "design doc prose, no control-room-patch-unit fence",
  },
  {
    relPath: "docs/control-room-patches/HYK-327-wire-two-checkers.md",
    role: "reference",
    reason:
      "patch doc with units -- already checked by judgeDocAgainstPinnedFunction (doc-vs-copies), not itself a standalone copy",
  },
  {
    relPath: "docs/control-room-patches/HYK-422-dispatch-run-boundary.md",
    role: "reference",
    reason:
      "patch doc whose own control-room-patch-unit targets Invoke-Dispatch (a different function) -- mentions Invoke-SeatProofGate only in its own §모양 고정 scope-investigation prose, quoting seat-proof-wrapper-shape.mjs/control-room-patch-canonical-sync.mjs to show that axis is untouched by this patch; already checked by judgeDocAgainstPinnedFunction (doc-vs-copies sweep, resolves OK_UNCHANGED since the patch never edits Invoke-SeatProofGate's body), not itself a standalone copy",
  },
  {
    relPath:
      "scripts/check/control-room-patch-apply-hyk422-canonical-scope.test.mjs",
    role: "reference",
    reason:
      "test file for HYK-422's own §모양 고정 investigation -- mentions Invoke-SeatProofGate in comments/module header describing why that axis is untouched, does not embed a body copy",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-before.ps1.txt",
    role: "reference",
    reason:
      "frozen full-file snapshot for HYK-422's own patch-apply byte-identity tests (target function is Invoke-Dispatch, not Invoke-SeatProofGate) -- incidentally contains the live Invoke-SeatProofGate body verbatim because it is a whole-file copy, but no test compares that portion against canonical",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-applied.ps1.txt",
    role: "reference",
    reason:
      "frozen full-file snapshot for HYK-422's own patch-apply byte-identity tests (target function is Invoke-Dispatch, not Invoke-SeatProofGate) -- incidentally contains the live Invoke-SeatProofGate body verbatim because it is a whole-file copy, but no test compares that portion against canonical",
  },
  // -- frozen historical / unrelated-patch fixtures: confirmed (this
  // round, by running every seat-proof-wrapper-canonical-comparing test
  // file and grepping for "seat-proof-wrapper-canonical" importers) that
  // NO test compares these against canonical.json -- they exist to support
  // OTHER patches' own before/after byte-identity tests (HYK-378/272/387/
  // 396/286/327-original/hyk271-wire-before/base snapshot), several of
  // which pin this exact file's SHA-256 and would break if it were edited
  // in place. Deliberately left at their pre-HYK-271 (or otherwise
  // unrelated) body -- that is correct, not a sync gap. --
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-applied.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-378's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-before.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-378's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-applied.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-272's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-before.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-272's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-applied.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-387's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-before.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-387's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-applied.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-396's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-before.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-396's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt",
    role: "reference",
    reason:
      "the deliberately-pre-HYK-271 --source fixture HYK-271-wire-modal-check.md's own apply-test reads; supposed to stay old",
  },
  {
    relPath:
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt",
    role: "reference",
    reason:
      "frozen base snapshot for HYK-327/HYK-286's own patch-apply tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk286-applied.ps1.txt",
    role: "reference",
    reason:
      "frozen fixture for HYK-286's own patch-apply byte-identity tests, not compared against seat-proof canonical anywhere",
  },
  {
    relPath:
      "scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt",
    role: "reference",
    reason:
      "SHA-256-pinned by 5 OTHER tests (control-room-patch-apply-hyk286-collect/hyk327-wire, dispatch-arg-contract-hyk327-applied-snapshot/snapshot, codex-snapshot-behavior) -- deliberately left at its original (pre-HYK-271) body; the post-HYK-271-synced copy lives in a separate dedicated file (see copies) so this shared one never has to change",
  },
]);

function validateMentionBaseline(baseline) {
  for (const e of baseline) {
    if (e.role === "reference" && (!e.reason || !e.reason.trim())) {
      throw new Error(
        `control-room-patch-canonical-sync: MENTION_BASELINE entry for '${e.relPath}' has role "reference" but no reason -- fail-closed: a reason-less reference must never silently take effect`,
      );
    }
    if (e.role !== "copy" && e.role !== "reference") {
      throw new Error(
        `control-room-patch-canonical-sync: MENTION_BASELINE entry for '${e.relPath}' has unknown role '${e.role}'`,
      );
    }
  }
}

// Explicit per-doc exemptions from the doc-vs-copies fail-closed default.
// Each entry MUST carry a non-empty `reason`. Empty today.
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

// Finds every literal, existing, non-live `--source <path>` fixture this
// doc's own text names. Placeholder tokens (`<원본>` etc, containing `<`),
// Windows absolute drive paths (`D:\...`, the live control room), and
// paths that don't resolve to a real file are all excluded. Returns the
// deduplicated set of resolved absolute paths -- callers require exactly
// one to proceed (zero or ambiguous-many both fail closed).
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

// Checks `afterHash` against EVERY registered copy (not just one). Returns
// the list of copies that do NOT match (empty = all synced). Each entry's
// getHash() may be sync or async -- always awaited uniformly.
async function findUnsyncedCopies(entry, afterHash, copyCtx) {
  const unsynced = [];
  for (const copy of entry.copies) {
    const hash = await copy.getHash(copyCtx);
    if (hash !== afterHash) {
      unsynced.push({ id: copy.id, hash });
    }
  }
  return unsynced;
}

async function judgeAgainstCopies(entry, beforeHash, afterHash, copyCtx) {
  if (afterHash === beforeHash) {
    return { reasonCode: REASON.OK_UNCHANGED };
  }

  const unsynced = await findUnsyncedCopies(entry, afterHash, copyCtx);
  if (unsynced.length === 0) {
    return { reasonCode: REASON.OK_SYNCED };
  }

  return {
    reasonCode: REASON.CANONICAL_NOT_SYNCED,
    detail:
      `patch changes ${entry.functionName}'s body (before=${beforeHash} after=${afterHash}) but ` +
      `${unsynced.length}/${entry.copies.length} registered cop${unsynced.length === 1 ? "y is" : "ies are"} not synced to the applied ` +
      `result: ${unsynced.map((u) => `${u.id} (has ${u.hash ?? "(unreadable)"})`).join("; ")}`,
  };
}

// Judges a single (doc, pinnedFunction) pair against ALL registered copies.
// `readFile`/`fileExists`/`importModule` are injectable for tests.
export async function judgeDocAgainstPinnedFunction(
  docText,
  docRelPath,
  entry,
  {
    repoRoot,
    readFile = (p) => readFileSync(p, "utf8"),
    fileExists = existsSync,
    importModule = (absPath) => import(pathToFileURL(absPath).href),
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

  return judgeAgainstCopies(entry, hashes.beforeHash, hashes.afterHash, {
    repoRoot,
    readFile,
    importModule,
  });
}

// NEW in 2R: scans every git-tracked file for the pinned function's name
// and fails closed (UNREGISTERED_MENTION) on any file MENTION_BASELINE
// hasn't classified. `listTrackedFiles`/`readFile` injectable for tests.
export function checkMentionRegistry({
  repoRoot,
  registry = PINNED_FUNCTION_REGISTRY,
  baseline = MENTION_BASELINE,
  listTrackedFiles = (root) =>
    execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
  readFile = (p) => readFileSync(p, "utf8"),
} = {}) {
  validateMentionBaseline(baseline);

  const baselineByPath = new Map(baseline.map((e) => [e.relPath, e]));
  const registeredCopyPaths = new Set(
    registry.flatMap((entry) => entry.copies.map((c) => c.relPath)),
  );

  const findings = [];
  const tracked = listTrackedFiles(repoRoot);
  for (const relPath of tracked) {
    const abs = join(repoRoot, relPath);
    let text;
    try {
      text = readFile(abs);
    } catch {
      continue; // unreadable (e.g. binary) -- not this axis's concern
    }
    if (!text.includes("Invoke-SeatProofGate")) continue;

    const known = baselineByPath.get(relPath);
    if (!known) {
      findings.push({
        relPath,
        reasonCode: REASON.UNREGISTERED_MENTION,
        detail: `file mentions Invoke-SeatProofGate but is not classified in MENTION_BASELINE (copy or reference) -- fail-closed`,
      });
      continue;
    }
    if (known.role === "copy" && !registeredCopyPaths.has(relPath)) {
      findings.push({
        relPath,
        reasonCode: REASON.UNREGISTERED_MENTION,
        detail: `MENTION_BASELINE marks this a "copy" but no PINNED_FUNCTION_REGISTRY[].copies entry targets it -- registry/baseline drifted apart`,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

// Sweeps every *.md under docsDir that carries a ```control-room-patch-unit
// fence, judged against every registry entry's copies. Split out of
// checkControlRoomPatchCanonicalSync purely to keep that function's
// cyclomatic complexity within this repo's lint budget -- no behavior
// change.
async function sweepPatchDocs({
  docsDir,
  registry,
  readFile,
  readdir,
  repoRoot,
  fileExists,
  importModule,
  exemptions,
}) {
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
      const result = await judgeDocAgainstPinnedFunction(
        docText,
        docRelPath,
        entry,
        { repoRoot, readFile, fileExists, importModule, exemptions },
      );
      findings.push({
        doc: docRelPath,
        functionName: entry.functionName,
        ...result,
      });
    }
  }
  return findings;
}

// Full sweep: doc-vs-copies (sweepPatchDocs above) PLUS the
// mention-registry ratchet.
export async function checkControlRoomPatchCanonicalSync({
  repoRoot,
  docsDir = join(repoRoot, "docs", "control-room-patches"),
  registry = PINNED_FUNCTION_REGISTRY,
  exemptions = EXEMPTIONS,
  readFile = (p) => readFileSync(p, "utf8"),
  readdir = readdirSync,
  importModule = (absPath) => import(pathToFileURL(absPath).href),
  fileExists = existsSync,
} = {}) {
  validateExemptions(exemptions);

  const findings = await sweepPatchDocs({
    docsDir,
    registry,
    readFile,
    readdir,
    repoRoot,
    fileExists,
    importModule,
    exemptions,
  });

  const mentionResult = checkMentionRegistry({ repoRoot, registry, readFile });
  for (const f of mentionResult.findings) {
    findings.push({ doc: f.relPath, functionName: "(mention-registry)", ...f });
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
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();

  const { ok, findings, redFindings } =
    await checkControlRoomPatchCanonicalSync({
      repoRoot,
    });

  for (const f of findings) {
    const line = `${f.reasonCode}: ${f.doc} (${f.functionName})`;
    console.log(f.detail ? `${line} -- ${f.detail}` : line);
  }

  if (ok) {
    console.log(
      `CANONICAL_SYNC: OK -- ${findings.length} finding(s) checked, 0 unsynced`,
    );
    process.exit(0);
  }
  console.log(`CANONICAL_SYNC: RED -- ${redFindings.length} finding(s) above`);
  process.exit(2);
}
