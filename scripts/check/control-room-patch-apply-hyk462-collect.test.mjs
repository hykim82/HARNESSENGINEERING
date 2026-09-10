// HYK-462 (coder-task.md §3) -- integration test: does
// docs/control-room-patches/HYK-462-seat-config-injection.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk379-
// update-suppress-collect.test.mjs's shape (same tool, same byte-identity
// contract): five units, all against orca-worker-seat.ps1 -- one
// `insert_after` (the new fail-closed seat-config-inject gate) and four
// `replace` (model/comment drift fix, split across the two lines they
// individually anchor so no anchor needs to span a line break -- this file
// has mixed CRLF/LF line endings, see the doc header, and `indexOf`-based
// anchor matching would otherwise need to guess which newline style
// separates two anchored lines).
//
// If this test goes RED, the document (its five control-room-patch-unit
// blocks) and the fixture have drifted apart -- see the patch doc's header
// for the SHA-256 the anchors were cut against (orca-worker-seat.ps1, 43
// lines, mixed CRLF/LF -- CODER recomputed via `Get-FileHash` against the
// LIVE control-room file and confirmed the match).
//
// ⚠️정직 한계 (HYK-378/HYK-379/HYK-422 선례와 동일 형태): 이 시험은
// 저장소에 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// orca-worker-seat.ps1은 이 시험 실행 중에는 열지 않는다(단, before
// fixture 자체는 CODER가 라이브 파일에서 `Copy-Item`으로 복사해 SHA-256을
// 대조한 것이다 -- §0-1이 금지하는 "살아 있는 좌석 조작"이 아니라 정적
// 파일 읽기). 그래서 라이브 파일이 나중에 수정되거나 이 단위들이 통째로
// 삭제되더라도, 이 시험은 그 사실을 알 도리가 없고 계속 초록으로 남는다.
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
    "../../docs/control-room-patches/HYK-462-seat-config-injection.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-orca-worker-seat-2026-09-10-hyk462-seat-config-injection-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-orca-worker-seat-2026-09-10-hyk462-seat-config-injection-applied.ps1.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "58780a8b1f263da0413cc8b7a016d270ad4d6038728575f85ea3df5af283ba5c";
const EXPECTED_SHA256 =
  "80e8da57b3b1a3b1747ca10f4d352a694a5a6423d3d22873d7ee8c02e3300229";

const EXPECTED_UNITS = [
  ["hyk462-seat-config-inject-gate", "insert_after"],
  ["hyk462-review-model-terra", "replace"],
  ["hyk462-review-reasoning-effort-flag", "replace"],
  ["hyk462-review-model-comment-fix", "replace"],
  ["hyk462-review-model-comment-history", "replace"],
];

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

test("HYK-462-seat-config-injection.md declares exactly 5 control-room-patch-unit blocks with the expected ids/modes", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, EXPECTED_UNITS.length);
  const byId = Object.fromEntries(parsed.units.map((u) => [u.id, u]));
  for (const [id, mode] of EXPECTED_UNITS) {
    assert.ok(byId[id], `unit '${id}' must be declared`);
    assert.equal(byId[id].mode, mode, `unit '${id}' must be mode '${mode}'`);
  }
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

test("★되돌림 변이 1/2 (앵커 훼손): mangling unit hyk462-seat-config-inject-gate's anchor flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const anchorMarkerAndText =
    '@@ANCHOR@@\n$global:LASTEXITCODE = 1; node scripts/check/seat-preflight.mjs; if ($LASTEXITCODE -ne 0) { Write-Host "[$Role seat] BLOCKED -- 훅 대조에 실패했습니다. 좌석을 띄우지 않습니다. 위에 뜬 «고치는 명령»을 실행한 뒤 다시 기동하십시오."; exit $LASTEXITCODE }';
  const anchorIdx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must still be found verbatim before mutating it",
  );
  const mutated =
    docText.slice(0, anchorIdx) +
    '@@ANCHOR@@\n$global:LASTEXITCODE = 1; node scripts/check/seat-preflight.MJS; if ($LASTEXITCODE -ne 0) { Write-Host "[$Role seat] BLOCKED -- 훅 대조에 실패했습니다. 좌석을 띄우지 않습니다. 위에 뜬 «고치는 명령»을 실행한 뒤 다시 기동하십시오."; exit $LASTEXITCODE }' +
    docText.slice(anchorIdx + anchorMarkerAndText.length);
  assert.notEqual(
    mutated,
    docText,
    "mutation must actually change the document text",
  );
  const outcome = applyControlRoomPatch(mutated, source);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});

test("★되돌림 변이 2/2 (CONTENT 삭제): deleting the reasoning-effort flag from unit hyk462-review-reasoning-effort-flag's CONTENT makes applying the document diverge from the committed applied fixture (byte mismatch, not a crash) -- collect test catches silent drift, not just hard parse failures", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const target =
    "  codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false -c reasoning_effort=$codexReasoningEffort";
  const idx = docText.indexOf(target);
  assert.notEqual(
    idx,
    -1,
    "sanity-check: the real CONTENT line must still be found verbatim before mutating it",
  );
  const mutated =
    docText.slice(0, idx) +
    "  codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false" +
    docText.slice(idx + target.length);
  assert.notEqual(mutated, docText);

  const outcome = applyControlRoomPatch(mutated, source);
  assert.equal(
    outcome.ok,
    true,
    outcome.ok ? "" : outcome.reason,
    "mutated content is still well-formed, just wrong -- this is a silent-drift case, not a parse error",
  );
  assert.notEqual(
    outcome.result,
    expected,
    "mutated document must no longer reproduce the committed applied fixture byte-for-byte",
  );
});
