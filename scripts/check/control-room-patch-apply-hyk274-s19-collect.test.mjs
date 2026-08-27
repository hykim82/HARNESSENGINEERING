// HYK-274-stale-screen-1 (coder-task.md §5, 완료 조건 3) -- integration
// test: does docs/control-room-patches/HYK-274-s19-screen-evidence.md
// ACTUALLY reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk357-
// 352-collect.test.mjs's shape (same tool, same byte-identity contract),
// three `replace`-mode units instead of two.
//
// If this test goes RED, the document (its three control-room-patch-unit
// blocks) and the fixture have drifted apart -- see the patch doc's header
// for the SHA-256 the anchors were cut against.
//
// ⚠️정직 한계(HYK-357/352 선례와 동일 형태): 이 시험은 저장소에 커밋된
// before/applied fixture만 읽는다. 관제실의 살아 있는 게이트-기준.md는
// 어디서도 열지 않는다(§0 원장/라이브 무접촉 규율 그대로). 그래서 라이브
// 파일이 나중에 수정되거나 이 세 단위가 통째로 삭제되더라도, 이 시험은
// 그 사실을 알 도리가 없고 계속 초록으로 남는다 -- 라이브 드리프트 감시는
// 이 시험의 책임 밖이다(사람/ORCH의 patch-apply 절차 + 별도 sha256 드리프트
// 감시가 맡는다).
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
    "../../docs/control-room-patches/HYK-274-s19-screen-evidence.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-gate-criteria-2026-08-27-hyk274-s19-before.md.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-gate-criteria-2026-08-27-hyk274-s19-applied.md.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "adc735bfc0ddc22206fbac9bb321cb302db0586c04d24ae134fe15f2af74f7dd";
const EXPECTED_SHA256 =
  "b836bccc3492ef7ab44d9e01cb23332f94d685c2be2bad944d8804e6a2d7ea1c";

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

test("HYK-274-s19-screen-evidence.md declares exactly 3 control-room-patch-unit blocks, all mode: replace", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 3);
  const ids = parsed.units.map((u) => u.id).sort();
  assert.deepEqual(ids, [
    "hyk274-s19-c-not-screen-only",
    "hyk274-s19-checklist-column",
    "hyk274-s19-hyk272-annotation",
  ]);
  for (const u of parsed.units) {
    assert.equal(u.mode, "replace");
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
