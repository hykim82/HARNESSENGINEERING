import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPmOutputBudgetStatus } from "./pm-output-budget-core.mjs";

// ⓐ null -> 미설정 신호가 출력에 나온다 (coder-task.md §2 수리 1 시험 요건)
test("formatPmOutputBudgetStatus: null budget -> UNSET signal, not judged, no ok claim", () => {
  const result = formatPmOutputBudgetStatus({
    pmOutputBudgetBytes: null,
    bytes: 206688,
  });
  assert.equal(result.judged, false);
  assert.equal(result.ok, null);
  assert.equal(result.line, "PM_OUTPUT_BUDGET=UNSET (사람 승인 대기)");
});

// ⓑ 숫자가 들어오면 정상 판정으로 갈린다
test("formatPmOutputBudgetStatus: numeric budget + bytes within it -> judged true, ok:true", () => {
  const result = formatPmOutputBudgetStatus({
    pmOutputBudgetBytes: 65536,
    bytes: 1000,
  });
  assert.equal(result.judged, true);
  assert.equal(result.ok, true);
  assert.equal(result.line, "PM_OUTPUT_BUDGET=1000/65536 OK");
});

test("formatPmOutputBudgetStatus: numeric budget + bytes over it -> judged true, ok:false", () => {
  const result = formatPmOutputBudgetStatus({
    pmOutputBudgetBytes: 65536,
    bytes: 206688,
  });
  assert.equal(result.judged, true);
  assert.equal(result.ok, false);
  assert.equal(result.line, "PM_OUTPUT_BUDGET=206688/65536 초과");
});

test("formatPmOutputBudgetStatus: bytes exactly at the budget boundary -> ok (inclusive)", () => {
  const result = formatPmOutputBudgetStatus({
    pmOutputBudgetBytes: 65536,
    bytes: 65536,
  });
  assert.equal(result.ok, true);
});
