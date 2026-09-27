// HYK-280-exit5-repair-2 (coder-task.md §3/§9) -- integration test: does
// docs/control-room-patches/HYK-280-exit5-observation-consume.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk272-
// notstarted-collect.test.mjs's shape (same tool, same byte-identity
// contract): two units, both `replace`, each anchored on the EXACT block it
// changes and nothing more (deliberately narrower than 1R's rejected design
// -- see the doc's own §0/§6 for why a wider anchor duplicated code when
// applied against a live-like source).
//
// The before-fixture here is a fresh CRLF->LF-normalized snapshot of the
// REAL control-room dispatch-worker.ps1 taken 2026-09-28 (782 lines) -- NOT
// the stale 2026-08-28 648-line snapshot HYK-378's own document still uses
// (that document is a historical record of an already-applied patch; this
// one targets what is live TODAY, which already includes HYK-378's AND
// HYK-272's effects plus many more patches, per coder-task.md §3's ⓐ
// requirement to re-cut anchors from a current live snapshot).
//
// ⚠️정직 한계 (HYK-378/HYK-272/HYK-357-352/HYK-335 선례와 동일 형태): 이
// 시험은 저장소에 커밋된 before/applied fixture만 읽는다. 관제실의 살아
// 있는 dispatch-worker.ps1은 어디서도 열지 않는다. 그래서 라이브 파일이
// 나중에 더 수정되면 이 fixture는 다시 낡는다 -- CI는 라이브 드리프트를
// 잡지 못한다. 이 시험이 실제로 막는 것은 "저장소 안"의 계약 문면(패치
// 문서·fixture) 변경뿐이다.
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
    "../../docs/control-room-patches/HYK-280-exit5-observation-consume.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-09-28-hyk280-exit5-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-09-28-hyk280-exit5-applied.ps1.txt",
    import.meta.url,
  ),
);
// The before-fixture is a CRLF->LF normalization of the REAL live control-
// room file as CODER directly re-read it on 2026-09-28 (live CRLF SHA-256 =
// 5c1a8f6b6ff13546f3d4a39630d2c96092365b15cd13e4c7bbc7bf5edba88962, mtime
// unchanged since 2026-09-16 -- see .harness/coder.md §10). This LF-
// normalized SHA-256 is the value the two units' anchors were cut against.
const SOURCE_SHA256 =
  "e323cfe3a569afb2fdbc1b9e13ccc42c7a49b44d3d9e9556bbe72bbfdccb2a2b";
const EXPECTED_SHA256 =
  "4a21432dcde7b924031a10ddef546daad54db3f6862bbb7e383f892d4c449091";

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

test("HYK-280-exit5-observation-consume.md declares exactly 2 control-room-patch-unit blocks, both replace", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 2);
  const byId = Object.fromEntries(parsed.units.map((u) => [u.id, u]));
  assert.equal(byId["hyk280-exit5-capture"].mode, "replace");
  assert.equal(byId["hyk280-exit5-report"].mode, "replace");
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
    "tool output diverges from the committed applied fixture -- the document's anchor/content no longer reproduces it",
  );
});

test("applying via applyPatchUnits directly still reproduces the same fixture, in REVERSED declaration order (order-independence, HYK-378 precedent)", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);

  const reversed = [...parsed.units].reverse();
  const applied = applyPatchUnits(reversed, source);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  assert.equal(applied.result, expected);
});

test("★no duplication: the applied fixture contains exactly ONE $confirmContractViolation flag-init and exactly ONE `if ($confirmContractViolation)` block (1R's rejected wider-anchor design produced 2 of each against a live-like source -- see doc §0/§6)", () => {
  const applied = readFileSync(EXPECTED_PATH, "utf8");
  assert.equal(
    (applied.match(/\$confirmContractViolation = \$false/g) || []).length,
    1,
  );
  assert.equal(
    (applied.match(/if \(\$confirmContractViolation\)/g) || []).length,
    1,
  );
});

test("★HYK-272's own exit 5 block (착수 확인 결과 미성공) survives completely untouched -- still exactly TWO bare `exit 5` statements (the pre-existing, unrelated AMBIGUOUS-seat one + HYK-272's), and this document never mints a THIRD one", () => {
  const applied = readFileSync(EXPECTED_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const lines = applied.split("\n");
  const bareExit5Lines = lines
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter(({ l }) => l === "exit 5");
  const bareExit5LinesBefore = source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l === "exit 5");
  assert.equal(
    bareExit5Lines.length,
    bareExit5LinesBefore.length,
    "the count of bare `exit 5` statements must be unchanged by this patch (AMBIGUOUS-seat + HYK-272's, both pre-existing) -- this document must not add a new one",
  );
  assert.ok(
    applied.includes(
      'Write-Host "[4/4] 이 스크립트는 5 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 · 5=착수 확인 결과 미성공)."',
    ),
    "HYK-272's own diagnostic line must be byte-identical and untouched",
  );
});

test("★되돌림 변이: mangling one character of unit hyk280-exit5-capture's anchor flips this document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const realAnchorFirstLine =
    "  # HYK-378 후속(ORCH 레인 · S7): 계약 밖 종료코드는 fail-closed 로 다룬다.";
  const anchorMarkerAndFirstLine = "@@ANCHOR@@\n" + realAnchorFirstLine;
  const anchorIdx = docText.indexOf(anchorMarkerAndFirstLine);
  assert.notEqual(
    anchorIdx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor first line must still be found verbatim before mutating it",
  );
  const mutatedFirstLine =
    "  # HYK-378 후속(ORCH 레인 · S7)XX: 계약 밖 종료코드는 fail-closed 로 다룬다.";
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
