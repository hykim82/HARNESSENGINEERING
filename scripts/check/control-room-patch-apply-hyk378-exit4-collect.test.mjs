// HYK-378-ps1-exit4-1 (coder-task.md §3) -- integration test: does
// docs/control-room-patches/HYK-378-ps1-exit4-consume.md ACTUALLY reproduce
// the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk357-
// 352-collect.test.mjs's shape (same tool, same byte-identity contract):
// two units, one `replace` (dispatch-start-confirm-cli.mjs 4=INVALID_ARGS
// 를 미지의 코드로 취급하던 자리를 계약 위반 플래그로 바꿔치기) and one
// `insert_after` (그 플래그가 서면 exit 4로 끝나는 블록을 새로 붙임).
//
// If this test goes RED, the document (its two control-room-patch-unit
// blocks) and the fixture have drifted apart -- see the patch doc's header
// for the SHA-256 the anchors were cut against (dispatch-worker.ps1, 648
// lines, LF, no BOM -- CODER recomputed and confirmed this matches the
// ORCH draft's claimed value exactly, see .harness/coder.md §1).
//
// ⚠️정직 한계 (HYK-357-352/HYK-335 선례와 동일 형태): 이 시험은 저장소에
// 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// dispatch-worker.ps1은 어디서도 열지 않는다. 그래서 라이브 파일이 나중에
// 수정되거나 이 두 단위가 통째로 삭제되더라도, 이 시험은 그 사실을 알
// 도리가 없고 계속 초록으로 남는다 -- CI는 라이브 드리프트를 잡지 못한다.
// 이 시험이 실제로 막는 것은 "저장소 안"의 계약 문면 변경뿐이다: 패치
// 문서나 fixture에서 두 단위의 앵커/내용을 지우거나 어긋나게 바꾸면 이
// 시험(및 -effect.test.mjs)이 빨간불을 낸다. 관제실 live 파일과 저장소
// fixture를 계속 같은 값으로 유지하는 것은 이 시험의 책임 밖이며, 그
// 동기화는 사람/ORCH가 patch-apply 절차로 수행한다.
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
    "../../docs/control-room-patches/HYK-378-ps1-exit4-consume.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-applied.ps1.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "c366edd32436942745321ff66c47d532fbbb216eae631e436289c95495bbaea0";
const EXPECTED_SHA256 =
  "a0d40e760f05d139ed9fcdffa1fe99cf6291e21cba6ddc023ec2d3dd66a57dd3";

test("source fixture is still the SHA-256 this document's anchors were cut against (self-check before trusting the comparison below)", () => {
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

test("HYK-378-ps1-exit4-consume.md declares exactly 2 control-room-patch-unit blocks: one replace, one insert_after", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 2);
  const byId = Object.fromEntries(parsed.units.map((u) => [u.id, u]));
  assert.equal(byId["hyk378-exit4-capture"].mode, "replace");
  assert.equal(byId["hyk378-exit4-fail-loud"].mode, "insert_after");
});

test("★applying the document's units to the source snapshot reproduces the applied fixture BYTE-FOR-BYTE", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const outcome = applyControlRoomPatch(docText, source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(
    outcome.result,
    expected,
    "tool output diverges from the committed applied fixture -- the document's anchors/content no longer reproduce it",
  );
});

test("applying via applyPatchUnits directly (both orderings, order-independent by construction) still reproduces the same fixture", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);

  const forward = applyPatchUnits(parsed.units, source);
  assert.equal(forward.ok, true, forward.ok ? "" : forward.reason);
  assert.equal(forward.result, expected);

  const reversed = applyPatchUnits([...parsed.units].reverse(), source);
  assert.equal(reversed.ok, true, reversed.ok ? "" : reversed.reason);
  assert.equal(reversed.result, expected);
});

test("★되돌림 변이: mangling one character of unit hyk378-exit4-capture's anchor flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  // ⚠️§1's human-readable prose quotes this SAME 3-line snippet verbatim as
  // an illustration (inside a plain ```powershell fence, not a
  // control-room-patch-unit fence). A plain docText.replace(...) mutates
  // whichever copy comes FIRST in the document -- that is the prose
  // illustration, not the real @@ANCHOR@@ inside the unit fence -- and the
  // real anchor stays untouched, so the tool still applies successfully
  // and this test's own RED assertion never fires (caught during this
  // round's own verification, see .harness/coder.md). Anchoring the
  // mutation to right after the literal "@@ANCHOR@@\n" marker guarantees it
  // lands on the actual extraction target.
  const anchorMarkerAndText =
    "@@ANCHOR@@\n" +
    '  if ($confirmExit -notin @(0, 1, 2, 3)) {\n    Write-Warning "dispatch-start-confirm unexpected exit=$confirmExit; delivery continues"\n  }';
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must still be found verbatim before mutating it",
  );
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    "@@ANCHOR@@\n" +
    '  if ($confirmExit -notin @(0, 1, 2, 9)) {\n    Write-Warning "dispatch-start-confirm unexpected exit=$confirmExit; delivery continues"\n  }' +
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
