// HYK-379-prompt-answer-1 (coder-task.md §3) -- integration test: does
// docs/control-room-patches/HYK-379-seat-update-prompt-suppress.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk378-
// exit4-collect.test.mjs's shape (same tool, same byte-identity contract):
// two units, both against orca-worker-seat.ps1 -- one `replace` (codex 실행
// 줄에 `-c check_for_update_on_startup=false`를 덧붙임) and one
// `insert_after` (claude 분기에 `$env:DISABLE_AUTOUPDATER = '1'`를 삽입함).
//
// If this test goes RED, the document (its two control-room-patch-unit
// blocks) and the fixture have drifted apart -- see the patch doc's header
// for the SHA-256 the anchors were cut against (orca-worker-seat.ps1, 36
// lines, CRLF -- CODER recomputed via `Get-FileHash` against the LIVE
// control-room file and confirmed the match, see .harness/coder.md §0/§1).
//
// ⚠️정직 한계 (HYK-378/HYK-357-352 선례와 동일 형태): 이 시험은 저장소에
// 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// orca-worker-seat.ps1은 이 시험 실행 중에는 열지 않는다(단, before fixture
// 자체는 CODER가 라이브 파일에서 `Copy-Item`으로 복사해 SHA-256을 대조한
// 것이다 -- §0-1이 금지하는 "살아 있는 좌석 조작"이 아니라 정적 파일 읽기).
// 그래서 라이브 파일이 나중에 수정되거나 이 두 단위가 통째로 삭제되더라도,
// 이 시험은 그 사실을 알 도리가 없고 계속 초록으로 남는다 -- CI는 라이브
// 드리프트를 잡지 못한다. 이 시험이 실제로 막는 것은 "저장소 안"의 계약
// 문면 변경뿐이다.
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
    "../../docs/control-room-patches/HYK-379-seat-update-prompt-suppress.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-orca-worker-seat-2026-08-29-hyk379-update-suppress-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-orca-worker-seat-2026-08-29-hyk379-update-suppress-applied.ps1.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "14e8a6ef50b988e06d19cfa5426d7529e5813571688e4b35c261fd4770af423c";
const EXPECTED_SHA256 =
  "58780a8b1f263da0413cc8b7a016d270ad4d6038728575f85ea3df5af283ba5c";

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

test("HYK-379-seat-update-prompt-suppress.md declares exactly 2 control-room-patch-unit blocks: one replace, one insert_after", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 2);
  const byId = Object.fromEntries(parsed.units.map((u) => [u.id, u]));
  assert.equal(byId["hyk379-codex-update-check-off"].mode, "replace");
  assert.equal(byId["hyk379-claude-autoupdater-off"].mode, "insert_after");
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

test("★되돌림 변이: mangling one character of unit hyk379-codex-update-check-off's anchor flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const anchorMarkerAndText =
    "@@ANCHOR@@\n  codex --model $codexModel -a never -s danger-full-access";
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must still be found verbatim before mutating it",
  );
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    "@@ANCHOR@@\n  codex --model $codexModel -a never -s danger-FULL-access" +
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

test("★되돌림 변이: mangling unit hyk379-claude-autoupdater-off's anchor flips this document RED (ANCHOR_NOT_FOUND)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const anchorMarkerAndText =
    '@@ANCHOR@@\n  $env:CLAUDE_CONFIG_DIR = "C:\\Users\\Administrator\\.claude-team"';
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(anchorIdx, -1);
  const mutatedDoc =
    docText.slice(0, anchorIdx) +
    '@@ANCHOR@@\n  $env:CLAUDE_CONFIG_DIR = "C:\\Users\\Administrator\\.claude-TEAM"' +
    docText.slice(anchorIdx + anchorMarkerAndText.length);
  assert.notEqual(mutatedDoc, docText);
  const outcome = applyControlRoomPatch(mutatedDoc, source);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});
