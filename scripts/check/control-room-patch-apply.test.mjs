// HYK-327-wire-2 (coder-task.md §2-1/§2-2, 검토 1R P1 반려 수리) --
// generic unit tests for control-room-patch-apply.mjs's parser/applier,
// independent of any specific patch document. The HYK-327-specific
// integration test (does THIS document reproduce THAT fixture) lives in
// control-room-patch-apply-hyk327-wire.test.mjs -- this file only proves
// the tool itself behaves correctly on small synthetic inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePatchDocument,
  applyPatchUnits,
  applyControlRoomPatch,
  PATCH_APPLY_REASON,
} from "./control-room-patch-apply.mjs";

function unitBlock(id, mode, anchor, content) {
  return [
    "```control-room-patch-unit",
    `id: ${id}`,
    `mode: ${mode}`,
    "@@ANCHOR@@",
    anchor,
    "@@CONTENT@@",
    content,
    "@@END@@",
    "```",
  ].join("\n");
}

const SOURCE = "line1\nline2\nline3\nline4\n";

test("parsePatchDocument: no fenced units at all -> NO_UNITS_FOUND", () => {
  const result = parsePatchDocument("just some prose, no fences here");
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.NO_UNITS_FOUND);
});

test("parsePatchDocument: a plain ```powershell illustration fence is never mistaken for a unit (P2-1 fix)", () => {
  const doc =
    "```powershell\nWrite-Host 'not a unit, just an example'\n```\n\n" +
    unitBlock("only-real-unit", "insert_after", "line1", "INSERTED");
  const result = parsePatchDocument(doc);
  assert.equal(result.ok, true);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].id, "only-real-unit");
});

test("parsePatchDocument: malformed block (missing @@CONTENT@@) -> MALFORMED_UNIT", () => {
  const doc =
    "```control-room-patch-unit\nid: broken\nmode: insert_after\n@@ANCHOR@@\nfoo\n@@END@@\n```";
  const result = parsePatchDocument(doc);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.MALFORMED_UNIT);
});

test("parsePatchDocument: unknown mode -> INVALID_MODE", () => {
  const doc = unitBlock("bad-mode", "delete_everything", "line1", "X");
  const result = parsePatchDocument(doc);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.INVALID_MODE);
});

test("parsePatchDocument: duplicate unit id -> DUPLICATE_ID", () => {
  const doc = [
    unitBlock("dup", "insert_after", "line1", "A"),
    unitBlock("dup", "insert_after", "line2", "B"),
  ].join("\n\n");
  const result = parsePatchDocument(doc);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.DUPLICATE_ID);
});

test("parsePatchDocument: preserves interior blank lines in anchor/content exactly (round-trips through join)", () => {
  const doc = unitBlock("blank-lines", "insert_after", "line1", "\nA\n\nB\n");
  const result = parsePatchDocument(doc);
  assert.equal(result.ok, true);
  assert.equal(result.units[0].content, "\nA\n\nB\n");
});

test("applyPatchUnits: insert_after splices content immediately after the anchor, anchor text itself unchanged", () => {
  const units = [
    { id: "u1", mode: "insert_after", anchor: "line2", content: "\nNEW" },
  ];
  const result = applyPatchUnits(units, SOURCE);
  assert.equal(result.ok, true);
  assert.equal(result.result, "line1\nline2\nNEW\nline3\nline4\n");
});

test("applyPatchUnits: replace substitutes the anchor span with content", () => {
  const units = [
    { id: "u1", mode: "replace", anchor: "line2", content: "REPLACED" },
  ];
  const result = applyPatchUnits(units, SOURCE);
  assert.equal(result.ok, true);
  assert.equal(result.result, "line1\nREPLACED\nline3\nline4\n");
});

test("applyPatchUnits: anchor not present in source -> ANCHOR_NOT_FOUND, no partial edit", () => {
  const units = [
    { id: "u1", mode: "replace", anchor: "not-in-source", content: "X" },
  ];
  const result = applyPatchUnits(units, SOURCE);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.ANCHOR_NOT_FOUND);
});

test("applyPatchUnits: anchor appears twice in source -> ANCHOR_NOT_UNIQUE (fail-closed, never guesses the first match)", () => {
  const repeatedSource = "dup\ndup\n";
  const units = [{ id: "u1", mode: "replace", anchor: "dup", content: "X" }];
  const result = applyPatchUnits(units, repeatedSource);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.ANCHOR_NOT_UNIQUE);
});

test("applyPatchUnits: two units claiming the exact same anchor span -> ANCHOR_OVERLAP, never silently resolved by declaration order (this is 1R's actual defect, synthetically reproduced)", () => {
  const units = [
    { id: "first", mode: "insert_after", anchor: "line2", content: "\nA" },
    { id: "second", mode: "replace", anchor: "line2", content: "B" },
  ];
  const result = applyPatchUnits(units, SOURCE);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.ANCHOR_OVERLAP);
});

test("applyPatchUnits: two units with partially overlapping (not identical) anchor spans -> ANCHOR_OVERLAP", () => {
  // "line2\nline3" and "line3\nline4" share the "line3" region.
  const units = [
    { id: "a", mode: "replace", anchor: "line2\nline3", content: "X" },
    { id: "b", mode: "replace", anchor: "line3\nline4", content: "Y" },
  ];
  const result = applyPatchUnits(units, SOURCE);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, PATCH_APPLY_REASON.ANCHOR_OVERLAP);
});

test("applyPatchUnits: non-overlapping units apply cleanly regardless of source order", () => {
  const units = [
    { id: "late", mode: "replace", anchor: "line4", content: "L4" },
    { id: "early", mode: "replace", anchor: "line1", content: "L1" },
  ];
  const result = applyPatchUnits(units, SOURCE);
  assert.equal(result.ok, true);
  assert.equal(result.result, "L1\nline2\nline3\nL4\n");
});

test("applyPatchUnits: declaration order never changes the result (forward vs reversed array)", () => {
  const units = [
    { id: "a", mode: "insert_after", anchor: "line1", content: "\nAFTER1" },
    { id: "b", mode: "replace", anchor: "line3", content: "REPLACED3" },
    { id: "c", mode: "insert_after", anchor: "line4", content: "\nAFTER4" },
  ];
  const forward = applyPatchUnits(units, SOURCE);
  const reversed = applyPatchUnits([...units].reverse(), SOURCE);
  assert.equal(forward.ok, true);
  assert.equal(reversed.ok, true);
  assert.equal(forward.result, reversed.result);
});

test("applyControlRoomPatch: end-to-end doc -> source -> result, multiple non-overlapping units", () => {
  const doc = [
    unitBlock("head", "insert_after", "line1", "\nHEAD-INSERTED"),
    unitBlock("tail", "replace", "line4", "TAIL-REPLACED"),
  ].join("\n\n");
  const outcome = applyControlRoomPatch(doc, SOURCE);
  assert.equal(outcome.ok, true);
  assert.equal(
    outcome.result,
    "line1\nHEAD-INSERTED\nline2\nline3\nTAIL-REPLACED\n",
  );
});

test("applyControlRoomPatch: source is never mutated by a failing apply (caller still holds the original string)", () => {
  const doc = unitBlock("missing", "replace", "not-there", "X");
  const before = SOURCE;
  const outcome = applyControlRoomPatch(doc, SOURCE);
  assert.equal(outcome.ok, false);
  assert.equal(SOURCE, before);
});
