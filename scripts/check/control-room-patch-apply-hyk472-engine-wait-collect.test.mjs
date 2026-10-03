// HYK-472 (coder-task.md §2-ⓑ) -- integration test: does
// docs/control-room-patches/HYK-472-dispatch-worker-engine-wait.md ACTUALLY
// reproduce the committed "applied" fixture through control-room-patch-
// apply.mjs, byte-for-byte, AND reverse back to the "before" fixture?
// Same shape as control-room-patch-apply-hyk378-exit4-collect.test.mjs.
//
// The "before" fixture is a byte copy of the live D:\문서관리\하네스-관제실\
// dispatch-worker.ps1 taken read-only on 2026-10-03 (sha256 34f8f43c…,
// 802 lines, CRLF). That makes the reverse check a real round trip: the
// applied bytes minus the patch must equal the live bytes we started from.
//
// ⚠️정직 한계 (HYK-378 선례와 동일 형태): 이 시험은 저장소에 커밋된
// fixture 만 읽는다. 관제실 live 파일은 열지 않는다. 라이브가 나중에 바뀌면
// 이 시험은 알 도리가 없고 초록으로 남는다 -- 막는 것은 저장소 안의 계약
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
    "../../docs/control-room-patches/HYK-472-dispatch-worker-engine-wait.md",
    import.meta.url,
  ),
);
const BEFORE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk472-engine-wait-before.ps1.txt",
    import.meta.url,
  ),
);
const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk472-engine-wait-applied.ps1.txt",
    import.meta.url,
  ),
);
const BEFORE_SHA256 =
  "34f8f43cb7b80252e3cce41ef1a404f9dd678d2f7dc27752e8e7c0a63c687018";
const APPLIED_SHA256 =
  "f36af6352c36b0ea209fde46735a6fc9d594b7184487e16d91cefc8bf919f21a";
const UNIT_ID = "hyk472-engine-wait";

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("before fixture is still the SHA-256 of the live copy this patch was cut against (self-check)", () => {
  assert.equal(sha256Of(BEFORE_PATH), BEFORE_SHA256);
});

test("applied fixture is still the byte-identical value this test was written against (self-check)", () => {
  assert.equal(sha256Of(APPLIED_PATH), APPLIED_SHA256);
});

test("HYK-472-dispatch-worker-engine-wait.md declares exactly 1 control-room-patch-unit block: one replace", () => {
  const parsed = parsePatchDocument(readFileSync(DOC_PATH, "utf8"));
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, UNIT_ID);
  assert.equal(parsed.units[0].mode, "replace");
});

test("★applying the document's unit to the before snapshot reproduces the applied fixture BYTE-FOR-BYTE", () => {
  const outcome = applyControlRoomPatch(
    readFileSync(DOC_PATH, "utf8"),
    readFileSync(BEFORE_PATH, "utf8"),
  );
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(
    outcome.result,
    readFileSync(APPLIED_PATH, "utf8"),
    "tool output diverges from the committed applied fixture -- the document's anchor/content no longer reproduce it",
  );
});

test("★REVERSE round trip: swapping the unit's anchor and content and applying to the applied fixture reproduces the before snapshot (= the live bytes we started from) BYTE-FOR-BYTE", () => {
  const parsed = parsePatchDocument(readFileSync(DOC_PATH, "utf8"));
  assert.equal(parsed.ok, true, parsed.reason);
  const [unit] = parsed.units;
  const reversed = [
    {
      id: unit.id,
      mode: "replace",
      anchor: unit.content,
      content: unit.anchor,
    },
  ];
  const outcome = applyPatchUnits(reversed, readFileSync(APPLIED_PATH, "utf8"));
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result, readFileSync(BEFORE_PATH, "utf8"));
});

test("CRLF guard: the applied fixture's inserted lines are CRLF (match the live file), with no stray bare-LF line", () => {
  const applied = readFileSync(APPLIED_PATH, "utf8");
  const lf = (applied.match(/\n/g) ?? []).length;
  const crlf = (applied.match(/\r\n/g) ?? []).length;
  assert.equal(
    crlf,
    lf,
    "every line ending in the applied fixture must be CRLF",
  );
});

test("LF path unchanged: the same patch applied to an LF-only copy of the before snapshot gives the LF-only copy of the applied fixture (the CRLF fallback never fires on LF input)", () => {
  const beforeLf = readFileSync(BEFORE_PATH, "utf8").replace(/\r\n/g, "\n");
  const appliedLf = readFileSync(APPLIED_PATH, "utf8").replace(/\r\n/g, "\n");
  const outcome = applyControlRoomPatch(
    readFileSync(DOC_PATH, "utf8"),
    beforeLf,
  );
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result, appliedLf);
  assert.equal(outcome.result.includes("\r"), false);
});

test("★되돌림 변이: mangling one character of the anchor flips the document RED (ANCHOR_NOT_FOUND) -- proves the collect test above is not vacuous", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const anchorMarkerAndText =
    "@@ANCHOR@@\n& orca terminal show --terminal $handle --json | Out-File";
  const idx = docText.indexOf(anchorMarkerAndText);
  assert.notEqual(
    idx,
    -1,
    "sanity-check: the real @@ANCHOR@@ marker + anchor text must be found before mutating it",
  );
  const mutated =
    docText.slice(0, idx) +
    "@@ANCHOR@@\n& orca terminal shox --terminal $handle --json | Out-File" +
    docText.slice(idx + anchorMarkerAndText.length);
  const outcome = applyControlRoomPatch(
    mutated,
    readFileSync(BEFORE_PATH, "utf8"),
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
});

test("★되돌림 변이 (값): changing the retry cap in the document changes the applied output away from the committed fixture -- the cap is pinned, not decorative", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const needle = "$engineDetectMaxAttempts = 10\n";
  assert.notEqual(
    docText.indexOf(needle),
    -1,
    "sanity-check: cap line must exist in the document",
  );
  const mutated = docText.replace(needle, "$engineDetectMaxAttempts = 9\n");
  const outcome = applyControlRoomPatch(
    mutated,
    readFileSync(BEFORE_PATH, "utf8"),
  );
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.notEqual(outcome.result, readFileSync(APPLIED_PATH, "utf8"));
});
