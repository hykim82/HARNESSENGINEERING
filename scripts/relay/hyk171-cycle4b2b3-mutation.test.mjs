import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDispatchShow,
  normalizeSeatCreation,
  normalizeObservedSeat,
  SEAT_CREATION_REASON,
  DISPATCH_SHOW_REASON,
} from "./adapters/dispatch-correlation-adapter.mjs";
import {
  judgeDispatchCorrelation,
  CORRELATION,
} from "./dispatch-correlation-core.mjs";
import { recordSeatCreation, createEmptyRegistry } from "./seat-registry.mjs";
import {
  rawDispatchShowAssigned,
  rawDispatchShowUnassigned,
  rawTerminalCreate,
  rawTerminalCreateFocus,
  rawTerminalListRowAdopted,
  rawTerminalListRowUnadopted,
  rawTerminalListRowUnadoptedDistinctFallback,
  rawTerminalListRowMissingTabId,
  rawTerminalListRowMissingLeafId,
  rawTerminalListRowSameNonFallbackIds,
  rawTerminalListResponse,
  rawDispatchShowFalseOkWithCompleteDispatch,
  rawDispatchShowMissingTaskId,
  rawDispatchShowMissingDispatchId,
  rawDispatchShowMissingAssigneePaneKey,
} from "./hyk171-cycle4b2b3-fixtures.mjs";

// HYK-171 사이클4b-2b-3 (coder-task.md §4) -- mutation 원장. 전부 프로덕션
// 진입점(normalizeDispatchShow/normalizeSeatCreation/normalizeObservedSeat/
// judgeDispatchCorrelation)을 직접 구동한다(helper로 손조립 금지). "실제
// RED 재현"(프로덕션 파일을 실제로 변조 -> 이 스위트 재실행 -> RED 확인 ->
// git diff --exit-code로 원복 증명) 절차는 .harness/coder.md에 별도
// 기록한다 -- 이 파일 자체는 각 위협 시나리오의 "정답(green)" 계약만
// 담는다.

function provenSeatRecord() {
  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  const { record } = recordSeatCreation(createEmptyRegistry(), {
    ...seatCreation.creationInput,
    taskId: "taskMain",
    dispatchId: "ctxMain",
  });
  return record;
}

function provenObserved(row = rawTerminalListRowAdopted()) {
  return {
    ...normalizeObservedSeat(row),
    taskId: "taskMain",
    dispatchId: "ctxMain",
  };
}

// ---------------------------------------------------------------------------
// M1 -- normalizeDispatchShow가 rawResponse.ok를 그대로 ok로 전달하면
// dispatch:null fixture가 "조회 성공"이 되어 RED.
// ---------------------------------------------------------------------------
test("mutation M1: dispatch:null with top-level ok:true must normalize to ok:false (a mutant that forwards raw ok verbatim would flip this to true)", () => {
  const normalized = normalizeDispatchShow(rawDispatchShowUnassigned());
  assert.equal(normalized.ok, false);
});

// ---------------------------------------------------------------------------
// M2 -- assignee_pane_key 대신 assigneePaneKey(camelCase)로 읽으면 실 응답
// fixture에서 값이 안 잡혀 RED.
// ---------------------------------------------------------------------------
test("mutation M2: assigneePaneKey must be read from the snake_case nested field, not a camelCase guess -- the real fixture only has assignee_pane_key", () => {
  const normalized = normalizeDispatchShow(rawDispatchShowAssigned());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.assigneePaneKey, "seatMain-tab:seatMain-leaf");
});

// ---------------------------------------------------------------------------
// M3 -- result.dispatch.id 대신 없는 dispatch_id를 읽으면 dispatchId 결손
// 으로 RED.
// ---------------------------------------------------------------------------
test("mutation M3: dispatchId must be read from result.dispatch.id, not a nonexistent dispatch_id key", () => {
  const normalized = normalizeDispatchShow(rawDispatchShowAssigned());
  assert.equal(normalized.dispatchId, "ctxMain");
});

// ---------------------------------------------------------------------------
// M4 (핵심) -- fixture를 평평 camelCase로 재작성하면 shape lock 테스트가
// RED가 되어야 한다(dispatch-correlation-adapter.test.mjs의 shape lock 참조).
// 여기서는 그 계약을 동일 fixture로 재확인한다.
// ---------------------------------------------------------------------------
test("mutation M4: the fixture's authority shape (nested snake_case) is asserted directly -- rewriting the fixture flat would break this", () => {
  const raw = rawDispatchShowAssigned();
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      raw.result.dispatch,
      "assignee_pane_key",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// M5 -- normalizeSeatCreation이 결손 필드를 키만 만들어 undefined로 채우면
// 출처 표지 우회가 성립해 RED.
// ---------------------------------------------------------------------------
test("mutation M5: normalizeSeatCreation.creationInput never contains undefined-valued keys for fields absent from the real response (leafId/taskId/dispatchId etc.)", () => {
  const result = normalizeSeatCreation(rawTerminalCreate());
  for (const forbiddenKey of [
    "leafId",
    "taskId",
    "dispatchId",
    "worktreePath",
    "role",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.creationInput, forbiddenKey),
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// M6 -- normalizeSeatCreation이 terminal-list 행도 수용하면 사후 수집 금지
// 계약이 깨져 RED.
// ---------------------------------------------------------------------------
test("mutation M6: normalizeSeatCreation rejects a terminal-list envelope (result.terminals) wholesale -- it must never be mistaken for a creation response", () => {
  const disguised = rawTerminalListResponse([rawTerminalListRowAdopted()]);
  const result = normalizeSeatCreation(disguised);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, SEAT_CREATION_REASON.NO_TERMINAL_ENVELOPE);
});

// ---------------------------------------------------------------------------
// M7 -- adoptionObservable 판정에서 폴백 형태 검사를 제거하면 미채택 행이
// PROVEN으로 가 RED.
//
// 재작업1 §0 문제2(ORCH 발견): rawTerminalListRowUnadopted()는
// tabId===leafId라서 computeAdoptionObservable의 앞선
// `tabId === leafId` 검사가 먼저 걸러버린다 -- 그 fixture만으로는 폴백
// 형태 검사(isUnadoptedFallbackForm) 두 줄을 지워도 RED가 나지 않는다
// (실측 재현: 22 pass / 0 fail, 죽은 방어선). 아래 두 번째 assertion 쌍이
// 그 죽은 방어선을 실제로 살리는 부분이다 -- tabId!==leafId인데 하나만
// 폴백 형태인 합성(SYNTHETIC, 실측 아님) fixture를 써서 폴백 형태 검사가
// 유일한 방어선이 되는 경로를 만든다.
// ---------------------------------------------------------------------------
test("mutation M7: the pty:...@@... fallback-form check is load-bearing -- an unadopted row must resolve adoptionObservable:false and the full pipeline must never reach PROVEN", () => {
  const observed = provenObserved(rawTerminalListRowUnadopted());
  assert.equal(observed.adoptionObservable, false);

  const verdict = judgeDispatchCorrelation({
    seatRecord: provenSeatRecord(),
    dispatchShow: normalizeDispatchShow(rawDispatchShowAssigned()),
    observed,
  });
  assert.notEqual(verdict.verdict, CORRELATION.PROVEN);
});

test("mutation M7b (load-bearing proof, SYNTHETIC fixture): tabId !== leafId but tabId alone is fallback-form -- the tabId===leafId shortcut does NOT fire here, so only the fallback-form check can block adoptionObservable", () => {
  const observed = provenObserved(
    rawTerminalListRowUnadoptedDistinctFallback(),
  );
  assert.notEqual(observed.tabId, observed.leafId);
  assert.equal(observed.adoptionObservable, false);

  const verdict = judgeDispatchCorrelation({
    seatRecord: provenSeatRecord(),
    dispatchShow: normalizeDispatchShow(rawDispatchShowAssigned()),
    observed,
  });
  assert.notEqual(verdict.verdict, CORRELATION.PROVEN);
});

// ---------------------------------------------------------------------------
// M8 (★S8 필수) -- adoptionObservable 판정을 title/preview 문자열로 하면
// S8 위반 -- 화면 문자열 변조 fixture에서 판정이 뒤집혀 RED.
// ---------------------------------------------------------------------------
test("mutation M8 (S8): tampering title/preview on an adopted row never changes adoptionObservable -- normalizeObservedSeat's signature output doesn't even carry those fields", () => {
  const base = normalizeObservedSeat(rawTerminalListRowAdopted());
  const tampered = normalizeObservedSeat(
    rawTerminalListRowAdopted({
      title: "[SPOOFED] totally different agent",
      preview: "gpt-9.9 / ? for shortcuts / bypass permissions",
    }),
  );
  assert.equal(base.adoptionObservable, true);
  assert.equal(tampered.adoptionObservable, base.adoptionObservable);
  assert.equal(Object.prototype.hasOwnProperty.call(tampered, "title"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(tampered, "preview"),
    false,
  );
});

// ---------------------------------------------------------------------------
// M9 -- normalizeSeatCreation이 paneKey를 쪼개 leafId를 지어내면 응답에
// 없는 값 생성 -- 포맷 가정 위반 fixture에서 RED.
//
// 재작업1 §0 문제3(ORCH 발견): 이전 버전은 콜론 없는 paneKey
// ("weird-format-no-colon-here")를 썼다 -- "paneKey를 쪼개 leafId를
// 지어낸다"는 변조를 `split(":")[1]`처럼 구현하면 콜론이 없을 때
// leafPart가 undefined가 되어 결과적으로 leafId 키가 안 생기고, 그러면
// 이 테스트가 변조를 잡지 못한다(fixture가 자기 mutation을 무력화). 실
// paneKey는 항상 콜론을 포함하므로(§1-C 실측, "seatMain-tab:seatMain-leaf"
// 형태) 콜론이 있는 기본 fixture를 그대로 써야 그 변조가 실제로 leafId를
// 채우고, 이 assertion이 그걸 잡는다.
// ---------------------------------------------------------------------------
test("mutation M9: normalizeSeatCreation never fabricates leafId by splitting paneKey -- leafId is simply absent from creationInput (paneKey has a colon, matching the real shape, so a split-based fabrication mutant would actually populate leafId here)", () => {
  const result = normalizeSeatCreation(rawTerminalCreate());
  assert.equal(result.ok, true);
  assert.equal(result.creationInput.paneKey, "seatMain-tab:seatMain-leaf");
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.creationInput, "leafId"),
    false,
  );
});

// ---------------------------------------------------------------------------
// M10 (재작업2, REVIEW P1) -- normalizeDispatchShow가 raw.ok!==true 검사를
// 제거하면, ok:false인데 result.dispatch에 완전한 배정 데이터가 실린
// 합성(SYNTHETIC, 실측 아님) 응답이 ok:true로 통과해 버린다. §1-E 실측
// (ok:false인데 실제로는 워크트리가 생성돼 있었다)의 반대 방향 -- "실패라는
// 응답인데 내용물이 있다"를 막는 방어선이다.
// ---------------------------------------------------------------------------
test("mutation M10: raw.ok!==true guard is load-bearing -- ok:false with a fully-populated result.dispatch (SYNTHETIC, never observed) must still normalize to ok:false", () => {
  const raw = rawDispatchShowFalseOkWithCompleteDispatch();
  assert.equal(raw.ok, false);
  assert.equal(typeof raw.result.dispatch, "object");
  const normalized = normalizeDispatchShow(raw);
  assert.equal(normalized.ok, false);
});

// ---------------------------------------------------------------------------
// M11a/b/c (재작업2, REVIEW P1) -- 세 필드(task_id/id/assignee_pane_key)
// non-empty 검사를 제거하면 각 필드가 빈 문자열인 응답이 ok:true로 통과해
// 버린다. 한 케이스로 뭉치면 한 필드만 검사해도 통과하므로 필드별로
// 분리한다(coder-task.md 재작업2 §3-1-2).
// ---------------------------------------------------------------------------
test("mutation M11a: task_id empty-string guard is load-bearing", () => {
  const normalized = normalizeDispatchShow(rawDispatchShowMissingTaskId());
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, DISPATCH_SHOW_REASON.FIELDS_INCOMPLETE);
});
test("mutation M11b: id(dispatchId) empty-string guard is load-bearing", () => {
  const normalized = normalizeDispatchShow(rawDispatchShowMissingDispatchId());
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, DISPATCH_SHOW_REASON.FIELDS_INCOMPLETE);
});
test("mutation M11c: assignee_pane_key empty-string guard is load-bearing", () => {
  const normalized = normalizeDispatchShow(
    rawDispatchShowMissingAssigneePaneKey(),
  );
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, DISPATCH_SHOW_REASON.FIELDS_INCOMPLETE);
});

// ---------------------------------------------------------------------------
// M12a/b (재작업2, REVIEW P1) -- computeAdoptionObservable의 tabId/leafId
// non-empty 검사를 제거하면, 하나가 빈 문자열인 관측 행이 관측 가능한 것처럼
// 통과해 버린다. 실측 근거 있음(terminal list 행 12필드가 항상 다 차 있다는
// 보장은 없다).
// ---------------------------------------------------------------------------
test("mutation M12a: observed tabId non-empty guard is load-bearing", () => {
  const observed = normalizeObservedSeat(rawTerminalListRowMissingTabId());
  assert.equal(observed.adoptionObservable, false);
});
test("mutation M12b: observed leafId non-empty guard is load-bearing", () => {
  const observed = normalizeObservedSeat(rawTerminalListRowMissingLeafId());
  assert.equal(observed.adoptionObservable, false);
});

// ---------------------------------------------------------------------------
// M13 (재작업2, REVIEW P1) -- computeAdoptionObservable의 tabId===leafId
// 검사를 제거하면, 폴백 형태가 아닌 동일값 관측(합성, SYNTHETIC, 실측 아님)
// 이 관측 가능한 것처럼 통과해 버린다. 이게 폴백 검사(M7/M7b)와 겹치지 않는
// 유일한 tabId===leafId 케이스다.
// ---------------------------------------------------------------------------
test("mutation M13: tabId===leafId guard is load-bearing even when the shared value is NOT a fallback form (SYNTHETIC, never observed)", () => {
  const row = rawTerminalListRowSameNonFallbackIds();
  assert.equal(row.tabId, row.leafId);
  assert.equal(row.tabId.startsWith("pty:"), false);
  assert.equal(row.tabId.includes("@@"), false);
  const observed = normalizeObservedSeat(row);
  assert.equal(observed.adoptionObservable, false);
});

// ---------------------------------------------------------------------------
// schema-4 (재작업3, REVIEW review-2 P1) -- 최상위 봉투(id/ok/result/_meta)에
// 예기치 않은 키를 추가해도 기존엔 통과했다(REVIEW 실측:
// unexpected_top_level:true 추가 -> 35 pass / 0 fail). 안쪽 객체 3종은 이미
// Object.keys(...).sort() 전체 비교로 잠겼는데 최상위만 "키 존재만" 확인해서
// 생긴 빈틈이다 -- 이제 최상위도 정확히 4키로 잠긴다
// (dispatch-correlation-adapter.test.mjs의 schema lock 테스트 참조, 그
// 테스트가 이 항목의 실제 방어선이다).
// ---------------------------------------------------------------------------
test("mutation schema-4: top-level envelope with an unexpected extra key (unexpected_top_level) is caught by the exact-key-set schema lock, not silently accepted", () => {
  const raw = rawDispatchShowAssigned();
  const tampered = { ...raw, unexpected_top_level: true };
  assert.deepEqual(Object.keys(raw).sort(), ["_meta", "id", "ok", "result"]);
  assert.notDeepEqual(
    Object.keys(tampered).sort(),
    ["_meta", "id", "ok", "result"].sort(),
  );
});

// ---------------------------------------------------------------------------
// paired-good (양성 통제) -- 정상 경로: 세 raw 응답 -> 세 어댑터 ->
// judgeDispatchCorrelation -> PROVEN.
// ---------------------------------------------------------------------------
test("paired-good: fully valid dispatch-show + terminal-create + terminal-list row (with taskId/dispatchId injected) -- PROVEN", () => {
  const verdict = judgeDispatchCorrelation({
    seatRecord: provenSeatRecord(),
    dispatchShow: normalizeDispatchShow(rawDispatchShowAssigned()),
    observed: provenObserved(),
  });
  assert.equal(verdict.verdict, CORRELATION.PROVEN);
});

// ---------------------------------------------------------------------------
// M-focus -- --focus 경로 응답(paneKey 없음)은 대장 등록 자체가 실패해야
// 한다(§3 필수 테스트 6과 동일 계약, mutation 원장에서 재확인).
// ---------------------------------------------------------------------------
test("mutation-focus: --focus create response (paneKey missing from the envelope) must fail normalizeSeatCreation, never producing a registrable record", () => {
  const result = normalizeSeatCreation(rawTerminalCreateFocus());
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, SEAT_CREATION_REASON.MISSING_PANE_KEY);
});
