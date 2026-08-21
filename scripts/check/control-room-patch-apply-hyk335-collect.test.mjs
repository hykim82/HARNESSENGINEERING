// HYK-335-rule-anchor-1 (coder-task.md §3-4) -- integration test: does
// docs/control-room-patches/HYK-335-ask-forbidden-3c.md ACTUALLY reproduce
// the committed "applied" fixture when run through control-room-patch-
// apply.mjs? Mirrors control-room-patch-apply-hyk330-collect.test.mjs's
// shape (same tool, same byte-identity contract) for a single-unit,
// insert_after document.
//
// If this test goes RED, the document (§3 of the patch doc) and the
// fixture have drifted apart -- see the patch doc's §4 for the SHA-256 the
// anchor was cut against.
//
// ⚠️HYK-335-rule-anchor-2 (검토 1R P2-1 수리) -- 정직 한계: 이 시험은
// 저장소에 커밋된 before/applied fixture만 읽는다. 관제실의 살아 있는
// worker-dispatch-rule.md는 어디서도 열지 않는다. 그래서 라이브 파일이
// 나중에 수정되거나 §3-c가 통째로 삭제되더라도, 이 시험은 그 사실을
// 알 도리가 없고 계속 초록으로 남는다 -- CI는 라이브 드리프트를 잡지
// 못한다(검토 1R이 관제실 live 파일만 바꾼 뒤 재실행해 5/5가 그대로
// 통과함을 재현했다). 이 시험이 실제로 막는 것은 "저장소 안"의 계약
// 문면 변경뿐이다: 패치 문서나 fixture에서 §3-c 계약 문장을 지우면
// 이 시험(및 -effect.test.mjs)이 빨간불을 낸다. 관제실 live 파일과
// 저장소 fixture를 계속 같은 값으로 유지하는 것은 이 시험의 책임 밖이며,
// 그 동기화는 사람/ORCH가 patch-apply 절차로 수행한다.
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
    "../../docs/control-room-patches/HYK-335-ask-forbidden-3c.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-before.md.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-applied.md.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "70cbb5d5b786679cf40cdc52374ae8e46dba57ab7cd4702965d8ad1d3e71125f";
const EXPECTED_SHA256 =
  "4c7a40ef9af954eb27d50404ae4ca2d62c3b5f66bbfc9f171076e148d57c57ac";

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

test("HYK-335-ask-forbidden-3c.md declares exactly 1 control-room-patch-unit block", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.units[0].id, "hyk335-ask-forbidden");
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

test("applying via applyPatchUnits directly (single-unit array, trivially order-independent) still reproduces the same fixture", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const expected = readFileSync(EXPECTED_PATH, "utf8");

  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  const outcome = applyPatchUnits(parsed.units, source);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result, expected);
});
