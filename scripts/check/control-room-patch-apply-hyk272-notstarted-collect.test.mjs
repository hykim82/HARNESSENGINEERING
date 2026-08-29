// HYK-272-consume-notstarted-1 (coder-task.md §3) -- integration test: does
// docs/control-room-patches/HYK-272-ps1-notstarted-consume.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk378-
// exit4-collect.test.mjs's shape (same tool, same byte-identity contract):
// one unit, `insert_after`, anchored on the whole HYK-378 exit4 block (the
// live file already has that block applied -- the before-fixture here IS
// that HYK-378 applied fixture, byte-identical to it, see SHA-256 below).
//
// ⚠️정직 한계 (HYK-378/HYK-357-352/HYK-335 선례와 동일 형태): 이 시험은
// 저장소에 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// dispatch-worker.ps1은 어디서도 열지 않는다. 그래서 라이브 파일이 나중에
// 수정되거나 이 단위가 통째로 삭제되더라도, 이 시험은 그 사실을 알 도리가
// 없고 계속 초록으로 남는다 -- CI는 라이브 드리프트를 잡지 못한다. 이
// 시험이 실제로 막는 것은 "저장소 안"의 계약 문면(패치 문서·fixture)
// 변경뿐이다. 관제실 live 파일과 저장소 fixture를 계속 같은 값으로
// 유지하는 것은 이 시험의 책임 밖이며, 그 동기화는 사람/ORCH가
// patch-apply 절차로 수행한다.
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
    "../../docs/control-room-patches/HYK-272-ps1-notstarted-consume.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-applied.ps1.txt",
    import.meta.url,
  ),
);
// This before-fixture is byte-identical to HYK-378's applied fixture (the
// live control-room file has not been touched since that round merged --
// CODER recomputed the live file's SHA-256 directly and confirmed it
// matches this value exactly, see .harness/coder.md §1).
const SOURCE_SHA256 =
  "a0d40e760f05d139ed9fcdffa1fe99cf6291e21cba6ddc023ec2d3dd66a57dd3";
const EXPECTED_SHA256 =
  "b62fe264ae5004448d0bf58eb921ed0efb899574560142ae6076c53dcb066596";

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

test("HYK-272-ps1-notstarted-consume.md declares exactly 1 control-room-patch-unit block: insert_after", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk272-notstarted-consume");
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

test("applying via applyPatchUnits directly still reproduces the same fixture (single-unit document -- ordering is not a variable here, unlike the 2-unit HYK-378 precedent)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);

  const applied = applyPatchUnits(parsed.units, source);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  assert.equal(applied.result, expected);
});

test("★되돌림 변이: mangling one character of unit hyk272-notstarted-consume's anchor flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  // ⚠️§1's human-readable prose quotes a similar snippet as illustration
  // (inside a plain ```powershell fence, not a control-room-patch-unit
  // fence) -- HYK-378's collect test hit exactly this trap (a naive
  // docText.replace mutated the prose copy first, leaving the real
  // @@ANCHOR@@ untouched and the RED assertion never firing). Anchoring the
  // mutation to right after the literal "@@ANCHOR@@\n" marker guarantees it
  // lands on the actual extraction target, not the prose illustration.
  const realAnchorFirstLine = "if ($confirmContractViolation) {";
  const anchorMarkerAndFirstLine = "@@ANCHOR@@\n" + realAnchorFirstLine;
  const anchorIdx = docText.indexOf(anchorMarkerAndFirstLine);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor first line must still be found verbatim before mutating it",
  );
  const mutatedFirstLine = "if ($confirmContractViolationXX) {";
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    "@@ANCHOR@@\n" +
    mutatedFirstLine +
    docText.slice(anchorIdx + anchorMarkerAndFirstLine.length);
  assert.notEqual(
    mutatedDoc,
    docText,
    "mutation must actually change the document text (sanity-check the replace target still exists)",
  );
  const outcome = applyControlRoomPatch(mutatedDoc, source);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});
