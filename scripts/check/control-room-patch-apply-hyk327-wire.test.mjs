// HYK-327-wire-2 (coder-task.md §2-2, 검토 1R P1 반려의 직접 수리) --
// integration test: does docs/control-room-patches/HYK-327-wire-two-
// checkers.md ACTUALLY reproduce the existing "applied" fixture when run
// through control-room-patch-apply.mjs? 1R's document only *described*
// the edits in prose; a reviewer applying them by hand got a different
// (wrong) result because two units silently shared an anchor region. This
// test closes that gap by literally running the tool the way ORCH's §7
// one-liner does, and asserting byte-for-byte equality with the fixture
// that was previously hand-verified against the two checkers (ALL_OK /
// WRAPPER_CHANGED: NO / PARSE_OK, see the two *-hyk327-applied-snapshot
// test files).
//
// If this test goes RED, it means the document (§5) and the fixture have
// drifted apart -- see the document's §6 "갱신 절차" for what to do.
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
    "../../docs/control-room-patches/HYK-327-wire-two-checkers.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_SHA256 =
  "29fb025f23dbf8ae14f9adf81305de20975996ab0312ef1a352f67413aa707e6";

test("expected fixture is still the byte-identical value this test was written against (self-check before trusting the comparison below)", () => {
  const bytes = readFileSync(EXPECTED_PATH);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    EXPECTED_SHA256,
  );
});

test("HYK-327-wire-two-checkers.md declares exactly 4 control-room-patch-unit blocks (P2-1 fix: fence count == extraction target count)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 4);
  assert.deepEqual(parsed.units.map((u) => u.id).sort(), [
    "hyk315-dedupe-admission-def",
    "hyk315-def-and-hyk319-check",
    "hyk315-gate-call-arg",
    "hyk323-wrapper-check",
  ]);
});

test("★applying the document's units to the original snapshot reproduces the applied fixture BYTE-FOR-BYTE (P1 fix, forward declaration order)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const outcome = applyControlRoomPatch(docText, source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(
    outcome.result,
    expected,
    "tool output diverges from the hand-verified applied fixture -- the document's anchors/content no longer reproduce it",
  );
});

test("applying the document's units in REVERSED declaration order still reproduces the same fixture (order-independence, §4 claim)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  const outcome = applyPatchUnits([...parsed.units].reverse(), source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result, expected);
});
