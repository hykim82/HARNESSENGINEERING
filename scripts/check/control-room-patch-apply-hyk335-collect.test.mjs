// HYK-335-rule-anchor-1 (coder-task.md §3-4) -- integration test: does
// docs/control-room-patches/HYK-335-ask-forbidden-3c.md ACTUALLY reproduce
// the committed "applied" fixture when run through control-room-patch-
// apply.mjs? Mirrors control-room-patch-apply-hyk330-collect.test.mjs's
// shape (same tool, same byte-identity contract) for a single-unit,
// insert_after document.
//
// If this test goes RED, the document (§3 of the patch doc) and the
// fixture have drifted apart -- see the patch doc's §4 for the SHA-256 the
// anchor was cut against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parsePatchDocument,
  applyControlRoomPatch,
  applyPatchUnits,
} from "./control-room-patch-apply.mjs";

const DOC_PATH = fileURLToPath(
  new URL(
    "../../docs/control-room-patches/HYK-335-ask-forbidden-3c.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-before.md.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-applied.md.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "70cbb5d5b786679cf40cdc52374ae8e46dba57ab7cd4702965d8ad1d3e71125f";
const EXPECTED_SHA256 =
  "4c7a40ef9af954eb27d50404ae4ca2d62c3b5f66bbfc9f171076e148d57c57ac";

test("source fixture is still the SHA-256 this document's anchor was cut against (self-check before trusting the comparison below)", () => {
  const bytes = readFileSync(SOURCE_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SOURCE_SHA256);
});

test("expected fixture is still the byte-identical value this test was written against (self-check before trusting the comparison below)", () => {
  const bytes = readFileSync(EXPECTED_PATH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    EXPECTED_SHA256,
  );
});

test("HYK-335-ask-forbidden-3c.md declares exactly 1 control-room-patch-unit block", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk335-ask-forbidden");
  assert.equal(parsed.units[0].mode, "insert_after");
});

test("★applying the document's unit to the source snapshot reproduces the applied fixture BYTE-FOR-BYTE", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const outcome = applyControlRoomPatch(docText, source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(
    outcome.result,
    expected,
    "tool output diverges from the committed applied fixture -- the document's anchor/content no longer reproduces it",
  );
});

test("applying via applyPatchUnits directly (single-unit array, trivially order-independent) still reproduces the same fixture", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  const outcome = applyPatchUnits(parsed.units, source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result, expected);
});
