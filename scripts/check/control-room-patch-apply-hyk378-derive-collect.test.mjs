// HYK-378-ps1-derive-consume-1 (coder-task.md §2-3) -- integration test: does
// docs/control-room-patches/HYK-378-ps1-derive-consume.md ACTUALLY reproduce
// the committed "applied" fixture when run through control-room-patch-apply.mjs?
// Mirrors control-room-patch-apply-hyk280-exit5-collect.test.mjs (same tool,
// same byte-identity contract): one `replace` unit whose anchor is the three
// live lines 514-516 (the self-computed project-dir fold, the join that uses
// it, and the baseline read that consumes it) and nothing wider.
//
// The before-fixture is a CRLF->LF-normalized snapshot of the REAL control-room
// dispatch-worker.ps1 as CODER re-read it on 2026-10-03 (live CRLF SHA-256 =
// 34f8f43cb7b80252e3cce41ef1a404f9dd678d2f7dc27752e8e7c0a63c687018, 802 lines).
//
// ⚠️정직 한계 (H4 선례와 동일 형태): 이 시험은 저장소에 커밋된 before/applied
// fixture 만 읽는다. 관제실의 살아 있는 dispatch-worker.ps1 은 어디서도 열지
// 않는다 -- 라이브가 나중에 바뀌면 CI 는 잡지 못한다. 이 시험이 막는 것은
// "저장소 안" 계약 문면(패치 문서 · fixture)의 변경뿐이다.
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
    "../../docs/control-room-patches/HYK-378-ps1-derive-consume.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk378-derive-before.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk378-derive-applied.ps1.txt",
    import.meta.url,
  ),
);
// The LF-normalized before-fixture SHA-256 = the value the anchor was cut against.
const SOURCE_SHA256 =
  "4a21432dcde7b924031a10ddef546daad54db3f6862bbb7e383f892d4c449091";
// The applied fixture is the byte-identical result of applying the doc to SOURCE.
const EXPECTED_SHA256 =
  "96b8fb4f320a3157e490f8c1018918a840ae8217598b4c43964e68909bd538f4";

const DOC_TEXT = readFileSync(DOC_PATH, "utf8");
const SOURCE = readFileSync(SOURCE_PATH, "utf8");
const EXPECTED = readFileSync(EXPECTED_PATH, "utf8");

test("source fixture is still the SHA-256 this document's anchor was cut against (self-check before trusting the comparison below)", () => {
  assert.equal(
    createHash("sha256").update(readFileSync(SOURCE_PATH)).digest("hex"),
    SOURCE_SHA256,
  );
});

test("expected fixture is still the byte-identical value this test was written against (self-check before trusting the comparison below)", () => {
  assert.equal(
    createHash("sha256").update(readFileSync(EXPECTED_PATH)).digest("hex"),
    EXPECTED_SHA256,
  );
});

test("HYK-378-ps1-derive-consume.md declares exactly 1 control-room-patch-unit block, and it is replace", () => {
  const parsed = parsePatchDocument(DOC_TEXT);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk378-derive-consume");
  assert.equal(parsed.units[0].mode, "replace");
});

test("★applying the document's unit to the source snapshot reproduces the applied fixture BYTE-FOR-BYTE", () => {
  const outcome = applyControlRoomPatch(DOC_TEXT, SOURCE);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(
    outcome.result,
    EXPECTED,
    "tool output diverges from the committed applied fixture -- the document's anchor/content no longer reproduces it",
  );
});

test("applying via applyPatchUnits directly reproduces the same fixture (unit order is irrelevant for a single unit; the reversed call is the same path)", () => {
  const parsed = parsePatchDocument(DOC_TEXT);
  assert.equal(parsed.ok, true, parsed.reason);
  const applied = applyPatchUnits([...parsed.units].reverse(), SOURCE);
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  assert.equal(applied.result, EXPECTED);
});

test("★no duplication: the applied fixture contains exactly ONE `$deriveCliPath = ` assignment and exactly ONE baseline read of `$confirmProjectDir` (rules out a wider-anchor double insert)", () => {
  const count = (s) => EXPECTED.split(s).length - 1;
  assert.equal(count("$deriveCliPath = "), 1);
  assert.equal(
    count("$confirmClaudeBaseline = Confirm-GetClaudeBytes $confirmProjectDir"),
    1,
  );
});

test("★the old self-computed fold is GONE from the applied fixture, and the new fold is produced ONLY by the CLI call", () => {
  assert.equal(
    EXPECTED.includes("$confirmProjectName = [string]$Worktree -replace"),
    false,
  );
  assert.equal(EXPECTED.includes("& node $deriveCliPath $Worktree 2>&1"), true);
});

test("★anti-vacuity: mangling one character of the unit's anchor flips the document RED (ANCHOR_NOT_FOUND) -- proves the byte-identity test above is not vacuous", () => {
  const mangled = DOC_TEXT.replace(
    "  $confirmClaudeBaseline = Confirm-GetClaudeBytes $confirmProjectDir\n@@CONTENT@@",
    "  $confirmClaudeBaseline = Confirm-GetClaudeBytez $confirmProjectDir\n@@CONTENT@@",
  );
  assert.notEqual(mangled, DOC_TEXT, "the mangle must actually change the doc");
  const outcome = applyControlRoomPatch(mangled, SOURCE);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});
