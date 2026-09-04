import { test } from "node:test";
import assert from "node:assert/strict";
import { observeSystemPressure } from "./system-pressure-adapter.mjs";

// HYK-431 1R -- 실제 os.freemem()을 구동한다(mock 없음, coder-task.md §4
// "프로덕션 export를 직접 구동"). 이 머신에서 항상 참이어야 하는 형태만
// 검사한다(구체 수치는 시험 대상이 아니다).
test("observeSystemPressure: 실행 중인 머신에서 observable:true + non-negative bytes", () => {
  const r = observeSystemPressure();
  assert.equal(r.observable, true);
  assert.equal(Number.isFinite(r.availableMemoryBytes), true);
  assert.equal(r.availableMemoryBytes >= 0, true);
});
