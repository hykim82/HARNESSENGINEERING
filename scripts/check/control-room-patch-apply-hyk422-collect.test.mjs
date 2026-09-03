// HYK-422-dispatch-run-1 (coder-task.md §2⑷ⓒ, §2⑸) -- integration test:
// does docs/control-room-patches/HYK-422-dispatch-run-boundary.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk378-
// exit4-collect.test.mjs's shape (same tool, same byte-identity contract) --
// one unit, mode `replace`, D14's `& orca orchestration task-update ... |
// Out-Null` swapped for a JSON-checked call that surfaces the failure
// reason on screen instead of silently swallowing it (HYK-422 §1).
//
// ⚠️정직 한계 (HYK-378/HYK-357-352/HYK-335 선례와 동일 형태): 이 시험은
// 저장소에 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// dispatch-worker.ps1은 어디서도 열지 않는다. 라이브가 나중에 이 함수
// 주변을 바꾸거나 이 단위가 통째로 삭제돼도 이 시험은 그 사실을 알 도리가
// 없고 계속 초록으로 남는다 -- 라이브 드리프트는 이 시험의 책임 밖이다.
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
    "../../docs/control-room-patches/HYK-422-dispatch-run-boundary.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-applied.ps1.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "88aead564559c1e7214aa8eefbdf369ef366173c4ec0f89c42f696ef56d2c615";
const EXPECTED_SHA256 =
  "ba652b15b3ae51bb3a17ade10894267e9760b0d44dd8608fa0a4538fc1fd2ee0";

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

test("HYK-422-dispatch-run-boundary.md declares exactly 1 control-room-patch-unit block, mode replace", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk422-stale-cleanup-visible");
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

test("applying via applyPatchUnits directly still reproduces the same fixture (single unit, order is moot but exercises the same code path as multi-unit docs)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);

  const direct = applyPatchUnits(parsed.units, source);
  assert.equal(direct.ok, true, direct.ok ? "" : direct.reason);
  assert.equal(direct.result, expected);
});

// ---- ★되돌림 변이 1/3 (coder-task.md §2⑸ -- 실제로 돌려 RED를 눈으로 봄) ----

test("★되돌림 변이 1/3: mangling the anchor's --status value flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  // ⚠️§ⓑ's human-readable prose quotes this SAME anchor line verbatim as a
  // "전" illustration (inside a plain ```powershell fence, not a
  // control-room-patch-unit fence). Anchoring the mutation to right after
  // the literal "@@ANCHOR@@\n" marker (HYK-378 collect test's own caught
  // mistake) guarantees it lands on the real extraction target, not the
  // prose copy that appears earlier in the document.
  const anchorMarkerAndText =
    "@@ANCHOR@@\n" +
    "    & orca orchestration task-update --id $stale --status completed --json | Out-Null";
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must still be found verbatim before mutating it",
  );
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    "@@ANCHOR@@\n" +
    "    & orca orchestration task-update --id $stale --status closed --json | Out-Null" +
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

test("★되돌림 변이 2/3: deleting the failure-report Write-Host line from @@CONTENT@@ makes the applied result diverge from the committed fixture -- proves the byte-identity test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const failureLine =
    '      Write-Host "      stale 정리 실패(HYK-422 -- D14 무음 삼킴 수리, 이전엔 이 사유가 화면에 안 떴다): $staleCleanupReason"\n';
  // ⚠️§ⓑ's human-readable "후" prose illustration quotes this SAME line
  // verbatim (inside a plain ```powershell fence, not a control-room-
  // patch-unit fence) BEFORE the real fence appears later in the document.
  // A plain docText.replace(...) mutates whichever copy comes FIRST -- the
  // prose illustration, not the real @@CONTENT@@ line -- leaving the real
  // unit untouched so the tool still reproduces the fixture and this
  // test's own divergence assertion never fires (same class of mistake
  // HYK-378's collect test documented and fixed for its anchor mutation;
  // caught here during this round's own verification, see
  // .harness/coder.md). Anchoring the search to AFTER the literal
  // "@@CONTENT@@\n" marker guarantees it lands on the real unit's content.
  const contentMarkerIdx = docText.indexOf("@@CONTENT@@\n");
  assert.notEqual(
    contentMarkerIdx,
    -1,
    "sanity-check: @@CONTENT@@ marker must exist",
  );
  const failureLineIdx = docText.indexOf(failureLine, contentMarkerIdx);
  assert.notEqual(
    failureLineIdx,
    -1,
    "sanity-check: the failure-report line must still be found verbatim inside @@CONTENT@@ before mutating it",
  );
  const mutatedDoc =
    docText.slice(0, failureLineIdx) +
    docText.slice(failureLineIdx + failureLine.length);
  assert.notEqual(mutatedDoc, docText);

  const outcome = applyControlRoomPatch(mutatedDoc, source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.notEqual(
    outcome.result,
    expected,
    "deleting the failure-report line must make the applied result diverge from the committed fixture",
  );
});
