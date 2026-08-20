// HYK-327-wire-2 (coder-task.md §2-1, 검토 1R P1 반려 수리) -- machine-
// reproducible "document -> applied file" for control-room patch
// proposals. Round 1 (HYK-327-wire-1) hand-wrote the "applied" fixture and
// only *described* the insertion/replacement text in prose PowerShell
// fences alongside it. The review found that description insufficient to
// mechanically reproduce the fixture: two units silently claimed the same
// anchor region, and the document's own PowerShell-fence count (7) did not
// match its claimed extraction-target count (5) because before/after
// illustration snippets were fenced with the same language tag as the
// real target blocks.
//
// This module fixes both by construction:
// 1. Extraction targets live in a fence with a DISTINCT language tag
//    (`control-room-patch-unit`) that nothing else in a patch document
//    should ever use for illustration -- counting them is unambiguous.
// 2. Each unit's anchor is resolved against the source text and checked
//    for uniqueness and for overlap with every other unit's anchor BEFORE
//    any edit is applied. Two units cannot silently share an anchor region
//    -- that is now a hard parse-time rejection (ANCHOR_OVERLAP), not a
//    reader's-discretion ordering question.
// 3. Application order is irrelevant by construction: edits are always
//    resolved against the ORIGINAL source's offsets, verified non-
//    overlapping, then spliced back-to-front (highest offset first) so
//    earlier offsets never shift under a still-pending edit. The unit list
//    order in the document (or in the caller's array) never affects the
//    result -- see applyPatchUnits' internal sort.
//
// ⛔This module never touches the real control-room path. `--source` is
// read-only; the only write this CLI performs is to `--out`. There is no
// default for either flag -- callers must name both paths explicitly, so a
// forgotten `--source`/`--out` cannot accidentally fall back onto a real
// control-room file.

import { readFileSync, writeFileSync } from "node:fs";

// Distinct from the "powershell" language tag used for human illustration
// elsewhere in a patch document -- this is the ONLY fence language this
// module treats as an extraction target (P2-1 fix: fence-count now equals
// extraction-target count by construction, because nothing else is allowed
// to use this tag).
const UNIT_FENCE_RE = /```control-room-patch-unit\r?\n([\s\S]*?)\r?\n```/g;

const VALID_MODES = new Set(["insert_after", "replace"]);

export const PATCH_APPLY_REASON = Object.freeze({
  OK: "OK",
  NO_UNITS_FOUND: "NO_UNITS_FOUND",
  MALFORMED_UNIT: "MALFORMED_UNIT",
  DUPLICATE_ID: "DUPLICATE_ID",
  INVALID_MODE: "INVALID_MODE",
  ANCHOR_NOT_FOUND: "ANCHOR_NOT_FOUND",
  ANCHOR_NOT_UNIQUE: "ANCHOR_NOT_UNIQUE",
  ANCHOR_OVERLAP: "ANCHOR_OVERLAP",
});

// Splits a fenced block's raw interior into lines, then slices between the
// three `@@...@@` markers. Deliberately line-based (not regex-across-the-
// whole-block) so interior blank lines inside an anchor/content span are
// preserved exactly (join('\n') is the exact inverse of split('\n')).
function parseUnitBlock(raw, blockIndex) {
  const lines = raw.split("\n");
  const idLine = lines[0] ?? "";
  const modeLine = lines[1] ?? "";
  const idMatch = idLine.match(/^id:\s*(\S+)\s*$/);
  const modeMatch = modeLine.match(/^mode:\s*(\S+)\s*$/);
  const anchorMarkerIdx = lines.indexOf("@@ANCHOR@@");
  const contentMarkerIdx = lines.indexOf("@@CONTENT@@");
  const endMarkerIdx = lines.indexOf("@@END@@");

  if (
    !idMatch ||
    !modeMatch ||
    anchorMarkerIdx !== 2 ||
    contentMarkerIdx === -1 ||
    endMarkerIdx === -1 ||
    contentMarkerIdx <= anchorMarkerIdx ||
    endMarkerIdx <= contentMarkerIdx
  ) {
    return {
      ok: false,
      reasonCode: PATCH_APPLY_REASON.MALFORMED_UNIT,
      reason:
        `control-room-patch-unit block #${blockIndex + 1}: expected ` +
        `"id: <slug>" then "mode: <insert_after|replace>" then an ` +
        `@@ANCHOR@@ .. @@CONTENT@@ .. @@END@@ marker sequence (in that ` +
        `order, one per line) -- did not find that shape`,
    };
  }

  const mode = modeMatch[1];
  if (!VALID_MODES.has(mode)) {
    return {
      ok: false,
      reasonCode: PATCH_APPLY_REASON.INVALID_MODE,
      reason: `unit '${idMatch[1]}': unknown mode '${mode}' (expected insert_after|replace)`,
    };
  }

  const anchor = lines.slice(anchorMarkerIdx + 1, contentMarkerIdx).join("\n");
  const content = lines.slice(contentMarkerIdx + 1, endMarkerIdx).join("\n");

  return {
    ok: true,
    unit: { id: idMatch[1], mode, anchor, content },
  };
}

// Extracts every `control-room-patch-unit` fence from a patch document and
// parses each into a { id, mode, anchor, content } unit. Fails closed on
// the first malformed block or duplicate id -- never silently drops a
// unit and proceeds with fewer edits than the document claims.
export function parsePatchDocument(docText) {
  const matches = [...docText.matchAll(UNIT_FENCE_RE)];
  if (matches.length === 0) {
    return {
      ok: false,
      reasonCode: PATCH_APPLY_REASON.NO_UNITS_FOUND,
      reason:
        "no ```control-room-patch-unit fenced blocks found in document -- nothing to apply",
    };
  }

  const units = [];
  const seenIds = new Set();
  for (let i = 0; i < matches.length; i++) {
    const parsed = parseUnitBlock(matches[i][1], i);
    if (!parsed.ok) return parsed;
    if (seenIds.has(parsed.unit.id)) {
      return {
        ok: false,
        reasonCode: PATCH_APPLY_REASON.DUPLICATE_ID,
        reason: `duplicate unit id '${parsed.unit.id}' (block #${i + 1}) -- ids must be unique`,
      };
    }
    seenIds.add(parsed.unit.id);
    units.push(parsed.unit);
  }

  return { ok: true, units };
}

// Resolves each unit's anchor against `source` to a [start, end) byte
// offset span. Fails closed if an anchor is missing or ambiguous (found
// more than once) -- a non-unique anchor cannot be applied unambiguously,
// so this never guesses "the first match."
function resolveSpans(units, source) {
  const spans = [];
  for (const unit of units) {
    const first = source.indexOf(unit.anchor);
    if (first === -1) {
      return {
        ok: false,
        reasonCode: PATCH_APPLY_REASON.ANCHOR_NOT_FOUND,
        reason: `unit '${unit.id}': anchor text not found in source (source changed, or anchor transcribed incorrectly)`,
      };
    }
    const second = source.indexOf(unit.anchor, first + 1);
    if (second !== -1) {
      return {
        ok: false,
        reasonCode: PATCH_APPLY_REASON.ANCHOR_NOT_UNIQUE,
        reason: `unit '${unit.id}': anchor text matches more than once in source -- cannot apply unambiguously (fail-closed, not "first match wins")`,
      };
    }
    spans.push({ unit, start: first, end: first + unit.anchor.length });
  }
  return { ok: true, spans };
}

// Fail-closed overlap guard (coder-task.md §2-1: "앵커 구간이 겹치면
// 거부하라 -- 겹침을 조용히 순서로 해결하지 마라"). Two units whose
// resolved anchor spans overlap (including exact duplicates, which is
// what round 1's actual defect looked like -- two units both anchored on
// the same "gap#96 참조." line) are rejected outright; this function never
// picks a winner by document order.
function findOverlap(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      return { a: sorted[i - 1].unit.id, b: sorted[i].unit.id };
    }
  }
  return null;
}

// Applies units to `source` and returns the result text. Order-independent
// by construction: spans are resolved against the ORIGINAL source, checked
// for overlap, then spliced from the highest offset down to the lowest --
// so the order units appear in `units` (== order in the document) never
// changes the output. Callers that want to prove this themselves can pass
// `units` in any permutation and diff the results (see the test file's
// "reversed declaration order" case).
export function applyPatchUnits(units, source) {
  const spanResult = resolveSpans(units, source);
  if (!spanResult.ok) return spanResult;
  const { spans } = spanResult;

  const overlap = findOverlap(spans);
  if (overlap) {
    return {
      ok: false,
      reasonCode: PATCH_APPLY_REASON.ANCHOR_OVERLAP,
      reason: `units '${overlap.a}' and '${overlap.b}' claim overlapping anchor spans in source -- refusing to guess an order (fail-closed); merge them into one unit or fix the anchors`,
    };
  }

  const byStartDesc = [...spans].sort((a, b) => b.start - a.start);
  let result = source;
  for (const { unit, start, end } of byStartDesc) {
    if (unit.mode === "insert_after") {
      result = result.slice(0, end) + unit.content + result.slice(end);
    } else {
      // mode === "replace" (only other value VALID_MODES allows)
      result = result.slice(0, start) + unit.content + result.slice(end);
    }
  }

  return { ok: true, result };
}

// End-to-end convenience: parse the document, apply to source, return the
// result text (or a fail-closed reason). This is what the CLI below calls.
export function applyControlRoomPatch(docText, source) {
  const parsed = parsePatchDocument(docText);
  if (!parsed.ok) return parsed;
  return applyPatchUnits(parsed.units, source);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--doc") out.doc = argv[++i];
    else if (argv[i] === "--source") out.source = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

const REASON_EXIT_CODE = {
  [PATCH_APPLY_REASON.NO_UNITS_FOUND]: 2,
  [PATCH_APPLY_REASON.MALFORMED_UNIT]: 2,
  [PATCH_APPLY_REASON.DUPLICATE_ID]: 2,
  [PATCH_APPLY_REASON.INVALID_MODE]: 2,
  [PATCH_APPLY_REASON.ANCHOR_NOT_FOUND]: 3,
  [PATCH_APPLY_REASON.ANCHOR_NOT_UNIQUE]: 4,
  [PATCH_APPLY_REASON.ANCHOR_OVERLAP]: 5,
};

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/control-room-patch-apply.mjs");
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.doc || !args.source || !args.out) {
    console.error(
      "usage: node control-room-patch-apply.mjs --doc <patch-doc.md> --source <input-file> --out <output-file>",
    );
    process.exit(1);
  }

  const docText = readFileSync(args.doc, "utf8");
  // ⛔--source is read-only from here on -- this CLI never writes back to it.
  const source = readFileSync(args.source, "utf8");

  const outcome = applyControlRoomPatch(docText, source);
  if (!outcome.ok) {
    console.error(
      `control-room-patch-apply: REJECT reason=${outcome.reasonCode} -- ${outcome.reason}`,
    );
    process.exit(REASON_EXIT_CODE[outcome.reasonCode] ?? 1);
  }

  writeFileSync(args.out, outcome.result, "utf8");
  const lineCount = outcome.result.split("\n").length - 1;
  console.log(
    `control-room-patch-apply: OK -- wrote ${args.out} (${Buffer.byteLength(outcome.result, "utf8")} bytes, ${lineCount} lines)`,
  );
}
