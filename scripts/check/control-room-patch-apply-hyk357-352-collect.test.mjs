// HYK-357-352-rule-anchor-1 (coder-task.md §2-C) -- integration test: does
// docs/control-room-patches/HYK-357-352-marker-value-spec.md ACTUALLY
// reproduce the committed "applied" fixture when run through
// control-room-patch-apply.mjs? Mirrors control-room-patch-apply-hyk335-
// collect.test.mjs's shape (same tool, same byte-identity contract), but
// this document declares TWO `replace`-mode units instead of HYK-335's one
// `insert_after` unit.
//
// If this test goes RED, the document (its two control-room-patch-unit
// blocks) and the fixture have drifted apart -- see the patch doc's header
// for the SHA-256 the anchors were cut against.
//
// ⚠️정직 한계 (HYK-335 선례와 동일 형태): 이 시험은 저장소에 커밋된
// before/applied fixture만 읽는다. 관제실의 살아 있는
// worker-dispatch-rule.md는 어디서도 열지 않는다. 그래서 라이브 파일이
// 나중에 수정되거나 이 두 단위가 통째로 삭제되더라도, 이 시험은 그
// 사실을 알 도리가 없고 계속 초록으로 남는다 -- CI는 라이브 드리프트를
// 잡지 못한다. 이 시험이 실제로 막는 것은 "저장소 안"의 계약 문면
// 변경뿐이다: 패치 문서나 fixture에서 두 단위의 앵커/내용을 지우거나
// 어긋나게 바꾸면 이 시험(및 -effect.test.mjs)이 빨간불을 낸다. 관제실
// live 파일과 저장소 fixture를 계속 같은 값으로 유지하는 것은 이 시험의
// 책임 밖이며, 그 동기화는 사람/ORCH가 patch-apply 절차로 수행한다
// (scripts/check/fixtures/control-room-live-baseline/README.md의 규율).
// 이 축은 selfcheck의 sha256 드리프트 감시(enforcement-inventory.json의
// control-room-live-baseline 항목)가 별도로 맡는다 -- 이 시험과 그 감시를
// 합쳐야 "문서↔코드 일치"가 성립한다.
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
    "../../docs/control-room-patches/HYK-357-352-marker-value-spec.md",
    import.meta.url,
  ),
);
const SOURCE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-26-hyk357-352-before.md.txt",
    import.meta.url,
  ),
);
const EXPECTED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-26-hyk357-352-applied.md.txt",
    import.meta.url,
  ),
);
const SOURCE_SHA256 =
  "7f55ec9ae08b1babc12b93d114ddfdaba3cebd75c54882ac2ba41a4485efc6a7";
const EXPECTED_SHA256 =
  "cebe0384094395396ee9bc31ad4b3470f988dc42ef51655a496751eacab02ec6";

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

test("HYK-357-352-marker-value-spec.md declares exactly 2 control-room-patch-unit blocks, both mode: replace", () => {
  const docText = readFileSync(DOC_PATH, "utf8");
  const parsed = parsePatchDocument(docText);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.units.length, 2);
  const ids = parsed.units.map((u) => u.id).sort();
  assert.deepEqual(ids, [
    "hyk352-done-seconds-precision",
    "hyk357-marker-value-spec",
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
