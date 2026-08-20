// HYK-330-pm-guard-prefix-1 (coder-task.md §3) -- integration test: does
// docs/control-room-patches/HYK-330-pm-guard-linear-prefix.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors
// control-room-patch-apply-hyk286-collect.test.mjs's shape (same tool, same
// byte-identity contract) for a single-unit document.
//
// If this test goes RED, the document (§3) and the fixture have drifted
// apart -- see the document's §4 for the SHA-256 the anchor was cut
// against.
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
    "../../docs/control-room-patches/HYK-330-pm-guard-linear-prefix.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-settings-2026-08-20-hyk330-before.json.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-settings-2026-08-20-hyk330-applied.json.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "e27a1b19f07c66e1ccf1a3123c0ce7b90abd79bd201786e4ee409afa8d334bf8";
const EXPECTED_SHA256 =
  "68414b4fd678c97edaf632d56a549a906344967a0d7d66cde3ef9a4e24ea3c7c";

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

test("HYK-330-pm-guard-linear-prefix.md declares exactly 1 control-room-patch-unit block", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk330-pm-guard-linear-prefix");
  assert.equal(parsed.units[0].mode, "replace");
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
