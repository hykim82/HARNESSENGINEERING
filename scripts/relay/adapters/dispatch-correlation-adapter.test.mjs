import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDispatchShow,
  normalizeSeatCreation,
  normalizeObservedSeat,
  DISPATCH_SHOW_REASON,
  SEAT_CREATION_REASON,
} from "./dispatch-correlation-adapter.mjs";
import {
  judgeDispatchCorrelation,
  CORRELATION,
} from "../dispatch-correlation-core.mjs";
import { recordSeatCreation, createEmptyRegistry } from "../seat-registry.mjs";
import {
  rawDispatchShowAssigned,
  rawDispatchShowUnassigned,
  rawTerminalCreate,
  rawTerminalCreateFocus,
  rawTerminalListRowAdopted,
  rawTerminalListRowUnadopted,
  rawTerminalListResponse,
} from "../hyk171-cycle4b2b3-fixtures.mjs";

// HYK-171 사이클4b-2b-3 (coder-task.md §3) -- 어댑터 계약 테스트. 4b-2b-2가
// REVIEW P2로 남긴 결함(fixture가 실 CLI 응답 모양을 검사하지 않는다)을
// 메우는 것이 이 파일의 존재 이유다.

// ---------------------------------------------------------------------------
// §3-1 형태 고정(shape lock) -- fixture가 result.dispatch.assignee_pane_key
// (중첩·snake_case)를 갖는지 직접 단언한다. 누군가 fixture를 평평
// camelCase로 고쳐 쓰면 이 테스트가 RED가 되어야 한다(M4).
// ---------------------------------------------------------------------------
test("shape lock: rawDispatchShowAssigned preserves the real CLI's nested snake_case shape (result.dispatch.assignee_pane_key), not a flattened camelCase guess", () => {
  const raw = rawDispatchShowAssigned();
  assert.equal(typeof raw.result, "object");
  assert.equal(typeof raw.result.dispatch, "object");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      raw.result.dispatch,
      "assignee_pane_key",
    ),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(raw, "assigneePaneKey"),
    false,
    "top-level flattened camelCase key must NOT exist on the raw fixture",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      raw.result.dispatch,
      "assigneePaneKey",
    ),
    false,
    "nested flattened camelCase key must NOT exist either",
  );
  assert.equal(
    raw.result.dispatch.assignee_pane_key,
    "seatMain-tab:seatMain-leaf",
  );
});

test("shape lock: rawTerminalCreate nests fields under result.terminal (singular), matching the real create-response envelope", () => {
  const raw = rawTerminalCreate();
  assert.equal(typeof raw.result.terminal, "object");
  assert.equal(raw.result.terminal.paneKey, "seatMain-tab:seatMain-leaf");
  assert.equal(
    Object.prototype.hasOwnProperty.call(raw.result, "terminals"),
    false,
  );
});

// ---------------------------------------------------------------------------
// §3-7 (재작업2, REVIEW P1: R1) -- 전체 키 집합·타입·null 여부를 고정한다.
// 기존 shape lock(위)은 assignee_pane_key 키 하나·camelCase 부재만 봐서
// `last_heartbeat_at: null`을 fixture에서 지워도 green이었다(REVIEW 재현
// 확인). 아래는 `Object.keys(...).sort()` 전체 비교로 키를 하나 지워도/
// 더해도/타입을 바꿔도 RED가 나게 고정한다.
//
// ⚠️ 이건 "실 응답이 지금 이렇게 생겼다"를 못 박는 계약이다 -- 미래에
// Orca가 응답 스키마를 바꾸면 이 테스트가 깨지는 게 정상이고 의도된
// 동작이다(그때 사람이 실 응답을 다시 포획해 이 fixture와 이 테스트를
// 함께 갱신한다). 스키마가 바뀌었는데 이 테스트가 계속 green이라면 그게
// 오히려 결함이다.
// ---------------------------------------------------------------------------
test("schema lock: dispatch-show(assigned) result.dispatch has exactly the 11 real keys, with the three null-valued fields actually null and failure_count a number", () => {
  const raw = rawDispatchShowAssigned();
  const dispatch = raw.result.dispatch;
  assert.deepEqual(
    Object.keys(dispatch).sort(),
    [
      "assignee_handle",
      "assignee_pane_key",
      "completed_at",
      "created_at",
      "dispatched_at",
      "failure_count",
      "id",
      "last_failure",
      "last_heartbeat_at",
      "status",
      "task_id",
    ].sort(),
  );
  assert.equal(dispatch.last_failure, null);
  assert.equal(dispatch.completed_at, null);
  assert.equal(dispatch.last_heartbeat_at, null);
  assert.equal(typeof dispatch.failure_count, "number");
});

test("schema lock: dispatch-show(unassigned) result has exactly the key 'dispatch', whose value is null (not absent)", () => {
  const raw = rawDispatchShowUnassigned();
  assert.deepEqual(Object.keys(raw.result).sort(), ["dispatch"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(raw.result, "dispatch"),
    true,
  );
  assert.equal(raw.result.dispatch, null);
});

test("schema lock: terminal-create result.terminal has exactly the 7 real keys", () => {
  const raw = rawTerminalCreate();
  assert.deepEqual(
    Object.keys(raw.result.terminal).sort(),
    [
      "handle",
      "paneKey",
      "ptyId",
      "surface",
      "tabId",
      "title",
      "worktreeId",
    ].sort(),
  );
});

test("schema lock: terminal-list row has exactly the 12 real keys, and paneKey is absent (it only appears on the one-time creation response, never on list rows)", () => {
  const row = rawTerminalListRowAdopted();
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "branch",
      "connected",
      "handle",
      "lastOutputAt",
      "leafId",
      "preview",
      "ptyId",
      "tabId",
      "title",
      "worktreePath",
      "worktreeId",
      "writable",
    ].sort(),
  );
  assert.equal(Object.prototype.hasOwnProperty.call(row, "paneKey"), false);
});

// 재작업3(coder-task.md §1, REVIEW review-2 P1): 안쪽 객체 3종은 이미
// Object.keys(...).sort() 전체 비교로 잠겼는데 최상위 봉투는 "키 존재만"
// 확인해서, unexpected_top_level 같은 예기치 않은 키를 추가해도 35 pass였다
// (REVIEW 실측). 안쪽과 똑같은 전체 비교 방식으로 최상위도 잠근다 -- 키를
// 더해도/빼도 RED가 나야 한다.
test("schema lock: top-level envelope has EXACTLY id/ok/result/_meta -- no more, no less -- on dispatch-show(assigned/unassigned), terminal-create, and terminal-list responses", () => {
  for (const raw of [
    rawDispatchShowAssigned(),
    rawDispatchShowUnassigned(),
    rawTerminalCreate(),
    rawTerminalListResponse([rawTerminalListRowAdopted()]),
  ]) {
    assert.deepEqual(
      Object.keys(raw).sort(),
      ["_meta", "id", "ok", "result"].sort(),
    );
  }
});

// ---------------------------------------------------------------------------
// §3-2 관통 테스트 -- 원시 응답 3종을 각 어댑터에 통과시켜 얻은 값으로
// judgeDispatchCorrelation을 직접 구동한다(helper로 손조립하지 않는다).
// taskId/dispatchId는 생성 응답에 없으므로(§1-C) 이 테스트에서 명시적으로
// 주입한 지점을 표시한다.
// ---------------------------------------------------------------------------
test("end-to-end: dispatch-show + terminal-create + terminal-list-row through the three adapters, with taskId/dispatchId explicitly injected by the caller, drives judgeDispatchCorrelation to PROVEN", () => {
  const dispatchShow = normalizeDispatchShow(rawDispatchShowAssigned());
  assert.equal(dispatchShow.ok, true);

  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  assert.equal(seatCreation.ok, true);
  const { record: seatRecord } = recordSeatCreation(
    createEmptyRegistry(),
    // §1-C KNOWN_GAP: taskId/dispatchId는 생성 응답에 없다 -- 여기서
    // 호출자가 명시적으로 주입한다(배정이 생성 뒤에 일어나므로, 실제
    // 프로덕션에서는 이 두 값을 별도의 배정 응답에서 받아와야 한다는 뜻).
    {
      ...seatCreation.creationInput,
      taskId: "taskMain",
      dispatchId: "ctxMain",
    },
  );

  const observed = {
    ...normalizeObservedSeat(rawTerminalListRowAdopted()),
    // 위와 동일한 주입 지점 -- terminal-list 행에는 taskId/dispatchId가
    // 없다(§2-C 비타협3).
    taskId: "taskMain",
    dispatchId: "ctxMain",
  };

  const verdict = judgeDispatchCorrelation({
    seatRecord,
    dispatchShow,
    observed,
  });
  assert.equal(verdict.verdict, CORRELATION.PROVEN);
});

test("end-to-end: same three raw responses WITHOUT the taskId/dispatchId injection -- UNPROVEN, never PROVEN by accident", () => {
  const dispatchShow = normalizeDispatchShow(rawDispatchShowAssigned());
  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  const { record: seatRecord } = recordSeatCreation(
    createEmptyRegistry(),
    seatCreation.creationInput,
  );
  const observed = normalizeObservedSeat(rawTerminalListRowAdopted());

  const verdict = judgeDispatchCorrelation({
    seatRecord,
    dispatchShow,
    observed,
  });
  assert.equal(verdict.verdict, CORRELATION.UNPROVEN);
});

// ---------------------------------------------------------------------------
// §3-3 dispatch:null -> 절대 PROVEN 아님(미배정·존재하지 않는 id 둘 다 같은
// fixture로 대표된다, coder-task.md §1-B).
// ---------------------------------------------------------------------------
test("dispatch:null (unassigned task OR typo'd nonexistent task id -- indistinguishable per §1-B) never yields PROVEN, even with a fully valid seat record and observation", () => {
  const dispatchShow = normalizeDispatchShow(rawDispatchShowUnassigned());
  assert.equal(dispatchShow.ok, false);
  assert.equal(dispatchShow.reasonCode, DISPATCH_SHOW_REASON.NO_DISPATCH);

  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  const { record: seatRecord } = recordSeatCreation(createEmptyRegistry(), {
    ...seatCreation.creationInput,
    taskId: "taskMain",
    dispatchId: "ctxMain",
  });
  const observed = {
    ...normalizeObservedSeat(rawTerminalListRowAdopted()),
    taskId: "taskMain",
    dispatchId: "ctxMain",
  };

  const verdict = judgeDispatchCorrelation({
    seatRecord,
    dispatchShow,
    observed,
  });
  assert.notEqual(verdict.verdict, CORRELATION.PROVEN);
});

// ---------------------------------------------------------------------------
// §3-4 미채택 행(tabId === leafId === "pty:...@@...") -> 절대 PROVEN 아님.
// ---------------------------------------------------------------------------
test("unadopted seat fallback row (tabId === leafId === pty:...@@...) never yields PROVEN", () => {
  const dispatchShow = normalizeDispatchShow(rawDispatchShowAssigned());
  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  const { record: seatRecord } = recordSeatCreation(createEmptyRegistry(), {
    ...seatCreation.creationInput,
    taskId: "taskMain",
    dispatchId: "ctxMain",
  });
  const observed = {
    ...normalizeObservedSeat(rawTerminalListRowUnadopted()),
    taskId: "taskMain",
    dispatchId: "ctxMain",
  };
  assert.equal(observed.adoptionObservable, false);

  const verdict = judgeDispatchCorrelation({
    seatRecord,
    dispatchShow,
    observed,
  });
  assert.notEqual(verdict.verdict, CORRELATION.PROVEN);
});

// ---------------------------------------------------------------------------
// §3-5 terminal-list 행을 생성 응답으로 위장 -> 대장 등록 실패.
// ---------------------------------------------------------------------------
test("a terminal-list row passed as if it were a creation response is rejected by normalizeSeatCreation (structurally distinct envelope: result.terminals vs result.terminal)", () => {
  const disguisedAsCreation = rawTerminalListResponse([
    rawTerminalListRowAdopted(),
  ]);
  const result = normalizeSeatCreation(disguisedAsCreation);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, SEAT_CREATION_REASON.NO_TERMINAL_ENVELOPE);

  // 단일 행 자체(배열이 아닌 plain object)를 그대로 넘겨도 마찬가지로
  // 거부된다(result.terminal 봉투가 없다).
  const rawRow = rawTerminalListRowAdopted();
  const resultRow = normalizeSeatCreation(rawRow);
  assert.equal(resultRow.ok, false);
  assert.equal(resultRow.reasonCode, SEAT_CREATION_REASON.NO_TERMINAL_ENVELOPE);
});

// ---------------------------------------------------------------------------
// §3-6 `--focus` 경로 응답(paneKey 없음) -> 대장 등록 실패.
// ---------------------------------------------------------------------------
test("--focus create response (no paneKey in the envelope) is rejected by normalizeSeatCreation, never reaches normalizeSeatRecord as a usable record", () => {
  const result = normalizeSeatCreation(rawTerminalCreateFocus());
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, SEAT_CREATION_REASON.MISSING_PANE_KEY);
});

// ---------------------------------------------------------------------------
// 개별 함수 단위 계약 -- normalizeDispatchShow가 최상위 ok를 그대로
// 전달하지 않음을 직접 단언(M1 방지선).
// ---------------------------------------------------------------------------
test("normalizeDispatchShow: top-level ok:true with result.dispatch:null does NOT become dispatchShow.ok:true (the core defect this cycle exists to fix)", () => {
  const raw = rawDispatchShowUnassigned();
  assert.equal(raw.ok, true);
  const normalized = normalizeDispatchShow(raw);
  assert.equal(normalized.ok, false);
});

test("normalizeSeatCreation: only the 5 real fields are copied; no undefined-valued keys are fabricated for missing fields", () => {
  const result = normalizeSeatCreation(rawTerminalCreate());
  assert.equal(result.ok, true);
  const keys = Object.keys(result.creationInput).sort();
  assert.deepEqual(keys, ["handle", "paneKey", "ptyId", "tabId", "worktreeId"]);
  for (const k of keys) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.creationInput, k) &&
        result.creationInput[k] !== undefined,
      true,
    );
  }
});

test("normalizeObservedSeat: does not fabricate leafId from splitting paneKey, and does not read title/preview", () => {
  const row = rawTerminalListRowAdopted({
    title: "[SPOOFED]",
    preview: "gpt-9.9",
  });
  const observed = normalizeObservedSeat(row);
  assert.equal(observed.tabId, "seatMain-tab");
  assert.equal(observed.leafId, "seatMain-leaf");
  assert.equal(observed.adoptionObservable, true);
  assert.equal(Object.prototype.hasOwnProperty.call(observed, "title"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(observed, "preview"),
    false,
  );
});
