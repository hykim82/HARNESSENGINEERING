// HYK-396 1R (coder-task.md §3 Q3) -- integration test: does
// docs/control-room-patches/HYK-396-dispatch-id-stamp.md ACTUALLY reproduce
// the committed "applied" fixture when run through control-room-patch-
// apply.mjs? Mirrors control-room-patch-apply-hyk387-receipt-pointer-
// collect.test.mjs's shape (same tool, same byte-identity contract): one
// unit, `replace` (Record-DispatchReceipt의 $cliArgs 줄에 --harness-dir을
// 추가하는 한 줄 치환).
//
// If this test goes RED, the document (its control-room-patch-unit block)
// and the fixture have drifted apart -- see the patch doc's header for the
// SHA-256 the anchor was cut against (695 lines, LF, SHA 90763ec2...).
//
// ⚠️정직 한계 (HYK-387/HYK-378 선례와 동일 형태): 이 시험은 저장소에
// 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// dispatch-worker.ps1은 어디서도 열지 않는다. 그래서 라이브 파일이 나중에
// 수정되거나 이 단위가 삭제되더라도, 이 시험은 그 사실을 알 도리가 없고
// 계속 초록으로 남는다 -- CI는 라이브 드리프트를 잡지 못한다. 이 시험이
// 실제로 막는 것은 "저장소 안"의 계약 문면 변경뿐이다.
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
    "../../docs/control-room-patches/HYK-396-dispatch-id-stamp.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-applied.ps1.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "90763ec2640ddd4b46d59922a84aab821b23944cb6e375532bfa56fb6bfe23e7";

test("source fixture is still the SHA-256 this document's anchor was cut against (self-check before trusting the comparison below)", () => {
  const bytes = readFileSync(SOURCE_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SOURCE_SHA256);
});

test("HYK-396-dispatch-id-stamp.md declares exactly 1 control-room-patch-unit block: replace", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk396-dispatch-id-stamp");
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

test("applying via applyPatchUnits directly reproduces the same fixture", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);

  const forward = applyPatchUnits(parsed.units, source);
  assert.equal(forward.ok, true, forward.ok ? "" : forward.reason);
  assert.equal(forward.result, expected);
});

test("★되돌림 변이: mangling the unit's anchor (inside the @@ANCHOR@@ fence) flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const anchorMarkerAndText =
    "@@ANCHOR@@\n" +
    '  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath)';
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must still be found verbatim before mutating it",
  );
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    "@@ANCHOR@@\n" +
    '  $cliArgs = @($cliPath, "--role", $role, "--task-label_MUTATED", $label, "--receipt-path", $receiptPath)' +
    docText.slice(anchorIdx + anchorMarkerAndText.length);
  assert.notEqual(mutatedDoc, docText);
  const outcome = applyControlRoomPatch(mutatedDoc, source);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});
