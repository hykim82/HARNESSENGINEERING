// HYK-387 3R (coder-task.md §3) -- integration test: does
// docs/control-room-patches/HYK-387-receipt-path-pointer.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk378-
// exit4-collect.test.mjs's shape (same tool, same byte-identity contract):
// one unit, `insert_after` (배달기가 $ReceiptPath를 해석한 직후 포인터
// 파일을 쓰는 블록을 새로 붙임).
//
// If this test goes RED, the document (its control-room-patch-unit block)
// and the fixture have drifted apart -- see the patch doc's header for the
// SHA-256 the anchor was cut against (dispatch-worker.ps1, 676 lines, CRLF
// -- CODER recomputed and confirmed this matches the live file's current
// fingerprint exactly, coder-task.md §3-2's b62fe264… value).
//
// ⚠️정직 한계 (HYK-378/HYK-357-352 선례와 동일 형태): 이 시험은 저장소에
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
    "../../docs/control-room-patches/HYK-387-receipt-path-pointer.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-applied.ps1.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "b62fe264ae5004448d0bf58eb921ed0efb899574560142ae6076c53dcb066596";

test("source fixture is still the SHA-256 this document's anchor was cut against (self-check before trusting the comparison below), AND matches coder-task.md §3-2's stated live fingerprint", () => {
  const bytes = readFileSync(SOURCE_PATH);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SOURCE_SHA256);
});

test("HYK-387-receipt-path-pointer.md declares exactly 1 control-room-patch-unit block: insert_after", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk387-receipt-path-pointer");
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

test("applying via applyPatchUnits directly (single unit -- order-independence is vacuously true, still asserted for parity with the multi-unit precedent) reproduces the same fixture", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);

  const forward = applyPatchUnits(parsed.units, source);
  assert.equal(forward.ok, true, forward.ok ? "" : forward.reason);
  assert.equal(forward.result, expected);
});

test("★되돌림 변이: mangling one character of the unit's anchor (inside the @@ANCHOR@@ fence, not the prose illustration) flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  // ⚠️§1/§3의 산문도 이 앵커 3줄을 ```powershell 삽화로 인용한다(HYK-378
  // 선례가 실측한 바로 그 함정) -- 삽화가 아니라 @@ANCHOR@@ 펜스 「안」의
  // 실제 추출 대상만 훼손하도록, "@@ANCHOR@@\n" 마커 바로 뒤에 이어붙는
  // 텍스트를 정확히 찾는다.
  const anchorMarkerAndText =
    "@@ANCHOR@@\n" +
    'if (-not $ReceiptPath) {\n  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }\n}';
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must still be found verbatim before mutating it",
  );
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    "@@ANCHOR@@\n" +
    'if (-not $ReceiptPath) {\n  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH_MUTATED) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }\n}' +
    docText.slice(anchorIdx + anchorMarkerAndText.length);
  assert.notEqual(
    mutatedDoc,
    docText,
    "mutation must actually change the document text (sanity-check the replace target still exists)",
  );
  const outcome = applyControlRoomPatch(mutatedDoc, source);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});
