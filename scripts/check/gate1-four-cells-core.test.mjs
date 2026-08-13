import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCandidateBlocks,
  checkCandidateCells,
  checkGate1FourCells,
} from "./gate1-four-cells-core.mjs";

function candidateBlock(fields) {
  return [
    "## 후보: 테스트 후보",
    fields.q1 !== undefined ? `질문1: ${fields.q1}` : null,
    fields.q2 !== undefined ? `질문2: ${fields.q2}` : null,
    fields.quadrant !== undefined ? `사분면: ${fields.quadrant}` : null,
    fields.linear !== undefined ? `Linear: ${fields.linear}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// parseCandidateBlocks
// ---------------------------------------------------------------------------

test("parseCandidateBlocks: no heading at all -> zero blocks", () => {
  assert.deepEqual(parseCandidateBlocks("아무 내용도 없는 문서\n"), []);
});

test("parseCandidateBlocks: two candidates -> two blocks, each carrying only its own text", () => {
  const doc = ["## 후보: A안", "질문1: a1", "## 후보: B안", "질문1: b1"].join(
    "\n",
  );
  const blocks = parseCandidateBlocks(doc);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, "A안");
  assert.match(blocks[0].body, /a1/);
  assert.doesNotMatch(blocks[0].body, /b1/);
  assert.equal(blocks[1].title, "B안");
  assert.match(blocks[1].body, /b1/);
});

test("parseCandidateBlocks: level-3 heading ('### 후보:') also recognized", () => {
  const blocks = parseCandidateBlocks("### 후보: C안\n질문1: x\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, "C안");
});

// ---------------------------------------------------------------------------
// checkCandidateCells: ALL_GOOD + each of the four cells missing/invalid
// ---------------------------------------------------------------------------

test("checkCandidateCells: all four cells present and valid -> ok:true", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({
      q1: "북극성에 심각함",
      q2: "지금 고치는 값과 나중 값이 다름",
      quadrant: "1",
      linear: "HYK-241",
    }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missingCells, []);
  assert.deepEqual(r.invalidCells, []);
});

test("checkCandidateCells: Linear cell accepts '미등재' note instead of an issue ref", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({
      q1: "a",
      q2: "b",
      quadrant: "4",
      linear: "미등재 · 등재 요청",
    }),
  );
  assert.equal(checkCandidateCells(block).ok, true);
});

test("checkCandidateCells: 질문1 missing -> missingCells includes '질문1', ok:false", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({ q2: "b", quadrant: "1", linear: "HYK-1" }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, false);
  assert.ok(r.missingCells.includes("질문1"));
});

test("checkCandidateCells: 질문2 missing -> missingCells includes '질문2'", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({ q1: "a", quadrant: "1", linear: "HYK-1" }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, false);
  assert.ok(r.missingCells.includes("질문2"));
});

test("checkCandidateCells: 사분면 missing -> missingCells includes '사분면'", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({ q1: "a", q2: "b", linear: "HYK-1" }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, false);
  assert.ok(r.missingCells.includes("사분면"));
});

test("checkCandidateCells: 사분면 value outside {1,2,3,4} (e.g. '5') -> invalidCells, NOT missingCells (the line exists, the value doesn't)", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({ q1: "a", q2: "b", quadrant: "5", linear: "HYK-1" }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, false);
  assert.equal(r.missingCells.includes("사분면"), false);
  assert.ok(r.invalidCells.some((c) => c.startsWith("사분면")));
});

test("checkCandidateCells: Linear missing entirely -> missingCells includes 'Linear'", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({ q1: "a", q2: "b", quadrant: "1" }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, false);
  assert.ok(r.missingCells.includes("Linear"));
});

test("checkCandidateCells: Linear present but neither an issue ref nor an unregistered note -> invalidCells (⛔아무 문구나 통과 금지)", () => {
  const [block] = parseCandidateBlocks(
    candidateBlock({ q1: "a", q2: "b", quadrant: "1", linear: "나중에 정함" }),
  );
  const r = checkCandidateCells(block);
  assert.equal(r.ok, false);
  assert.ok(r.invalidCells.some((c) => c.startsWith("Linear")));
});

// ---------------------------------------------------------------------------
// checkGate1FourCells: whole-document judgment
// ---------------------------------------------------------------------------

test("checkGate1FourCells: zero candidates found -> ok:false, fail-closed (empty doc never silently passes)", () => {
  const r = checkGate1FourCells("아무 후보도 없는 문서\n");
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 0);
  assert.match(r.reasons[0], /하나도 찾지 못함/);
});

test("checkGate1FourCells: two candidates, one complete + one missing 질문2 -> ok:false, names ONLY the bad candidate", () => {
  const doc = [
    "## 후보: 완비안",
    "질문1: a",
    "질문2: b",
    "사분면: 1",
    "Linear: HYK-1",
    "## 후보: 결손안",
    "질문1: a",
    "사분면: 2",
    "Linear: HYK-2",
  ].join("\n");
  const r = checkGate1FourCells(doc);
  assert.equal(r.ok, false);
  assert.equal(r.candidates.find((c) => c.title === "완비안").ok, true);
  assert.equal(r.candidates.find((c) => c.title === "결손안").ok, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /결손안/);
  assert.match(r.reasons[0], /질문2/);
});

test("checkGate1FourCells: every candidate complete -> ok:true, zero reasons", () => {
  const doc = [
    "## 후보: A",
    "질문1: a",
    "질문2: b",
    "사분면: 3",
    "Linear: HYK-9",
    "### 후보: B",
    "질문1: a2",
    "질문2: b2",
    "사분면: 4",
    "Linear: 미등재",
  ].join("\n");
  const r = checkGate1FourCells(doc);
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});
