import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORRELATION,
  REASON,
  judgeDispatchCorrelation,
} from "./dispatch-correlation-core.mjs";
import {
  seatRecord,
  dispatchShow,
  observed,
} from "./hyk171-cycle4b2b2-axisA-fixtures.mjs";

// HYK-171 사이클4b-2b-2 (coder-task.md §4 축A) -- 배정 상관 판정 mutation
// 원장. 6건, 전부 프로덕션 진입점(judgeDispatchCorrelation)을 직접 구동한다
// (helper 조립 금지). "실제 RED 재현"(프로덕션 파일을 실제로 변조 -> 이
// 스위트 재실행 -> RED 확인 -> `git diff --exit-code`로 원복 증명)은
// 결과 보고서(.harness/coder.md)에 별도 기록한다 -- 이 파일 자체는 각
// 위협 시나리오의 "정답(green)" 계약만 담는다.

// ---------------------------------------------------------------------------
// A1 -- 채택 상태 관측 불가일 때 PROVEN을 허용하면 안 된다.
// ---------------------------------------------------------------------------
test("mutation A1: adoption state not observable -- UNPROVEN, never PROVEN (no guessing)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow(),
    observed: observed({ adoptionObservable: false }),
  });
  assert.equal(r.verdict, CORRELATION.UNPROVEN);
  assert.equal(r.reason, REASON.ADOPTION_NOT_OBSERVABLE);
});

// ---------------------------------------------------------------------------
// A2 -- 대장 paneKey 대조가 빠지면 다른 좌석의 배정이 PROVEN이 되어버린다.
// ---------------------------------------------------------------------------
test("mutation A2: reconstructed tabId:leafId disagrees with the registry paneKey -- MISMATCH, never PROVEN (a different seat's assignment must not resolve)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ paneKey: "seatOther-tab:seatOther-leaf" }),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.MISMATCH);
  assert.equal(r.reason, REASON.REGISTRY_PANE_KEY_MISMATCH);
});

// ---------------------------------------------------------------------------
// A3 -- dispatch-show assigneePaneKey 대조가 빠지면 배정 없는 좌석도
// PROVEN이 되어버린다.
// ---------------------------------------------------------------------------
test("mutation A3: reconstructed tabId:leafId disagrees with dispatch-show assigneePaneKey -- MISMATCH, never PROVEN (an unassigned seat must not resolve)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow({
      assigneePaneKey: "seatOther-tab:seatOther-leaf",
    }),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.MISMATCH);
  assert.equal(r.reason, REASON.DISPATCH_PANE_KEY_MISMATCH);
});

// ---------------------------------------------------------------------------
// A4 -- 세대(incarnation) 일치 검사가 빠지면, 과거 배정을 기록한 대장이
// (paneKey 값 자체는 여전히 같은 좌석이라) 새 배정에 대해서도 PROVEN을
// 내주는 stale grant가 발생한다.
// ---------------------------------------------------------------------------
test("mutation A4: registry record still carries a PAST task/dispatch id while dispatch-show/observed point at a NEW one (paneKey literal happens to match) -- MISMATCH via INCARNATION_MISMATCH, a stale grant must not become PROVEN", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ taskId: "taskOld", dispatchId: "dispatchOld" }),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.MISMATCH);
  assert.equal(r.reason, REASON.INCARNATION_MISMATCH);
});

// ---------------------------------------------------------------------------
// A5 -- dispatchShow.ok !== true를 통과시키면 fail-closed 기대가 깨진다.
// ---------------------------------------------------------------------------
test("mutation A5: dispatchShow.ok is false -- UNPROVEN, fail-closed, never PROVEN", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow({ ok: false }),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.UNPROVEN);
  assert.equal(r.reason, REASON.DISPATCH_SHOW_NOT_OK);
});

// ---------------------------------------------------------------------------
// A6 -- 상관 근거에 handle을 추가하면 handle 회전 fixture에서 판정이
// 흔들려야 한다(정답 구현은 handle을 아예 근거로 쓰지 않으므로 회전에도
// PROVEN을 유지한다 -- RED는 "handle이 근거로 쓰였다"는 뜻).
// ---------------------------------------------------------------------------
test("mutation A6 (handle-rotation fixture): seat created under one handle, observed under a rotated handle -- verdict must stay PROVEN (a handle-keyed judge would flip this to non-PROVEN)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ handle: "term_created_seat" }),
    dispatchShow: dispatchShow(),
    observed: { ...observed(), handle: "term_rotated_seat" },
  });
  assert.equal(r.verdict, CORRELATION.PROVEN);
  assert.equal(r.reason, REASON.CORRELATION_PROVEN);
});

// ---------------------------------------------------------------------------
// paired-good -- 정상 경로: 채택 관측 가능 + 동일 세대 + paneKey 3처 일치.
// ---------------------------------------------------------------------------
test("paired-good: same-generation tabId/leafId reconstruction matches both registry paneKey and dispatch-show assigneePaneKey, incarnation matches -- PROVEN", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.PROVEN);
  assert.equal(r.reason, REASON.CORRELATION_PROVEN);
});
