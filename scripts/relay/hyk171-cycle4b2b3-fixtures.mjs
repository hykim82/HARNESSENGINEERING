// HYK-171 사이클4b-2b-3 -- coder-task.md §1의 실측 원시 응답을 정본으로
// 삼아 만든 녹화 fixture. 값은 §5 G9 규칙에 따라 저엔트로피 리터럴로
// 바꿨지만, 구조(키 이름·중첩·타입·null 여부)는 실측 그대로다 -- 이 파일을
// 평평 camelCase로 고쳐 쓰면 dispatch-correlation-adapter.test.mjs의 shape
// lock 테스트가 RED가 되어야 한다(그게 이 사이클의 존재 이유).

// ---- 1-A/1-B: dispatch-show ----

export function rawDispatchShowAssigned(dispatchOverrides = {}) {
  return {
    id: "reqMain",
    ok: true,
    result: {
      dispatch: {
        id: "ctxMain",
        task_id: "taskMain",
        assignee_handle: "termMain",
        assignee_pane_key: "seatMain-tab:seatMain-leaf",
        status: "dispatched",
        failure_count: 0,
        last_failure: null,
        dispatched_at: "2026-07-26 00:00:00",
        completed_at: null,
        created_at: "2026-07-26 00:00:00",
        last_heartbeat_at: null,
        ...dispatchOverrides,
      },
    },
    _meta: { runtimeId: "runtimeMain" },
  };
}

// 미배정 태스크. coder-task.md §1-B: 오타 난 존재하지 않는 태스크 id도
// 완전히 동일한 응답을 낸다 -- 그래서 이 fixture가 두 케이스를 동시에
// 대표한다(응답에 구별 근거가 없다).
export function rawDispatchShowUnassigned() {
  return {
    id: "reqGap",
    ok: true,
    result: { dispatch: null },
    _meta: { runtimeId: "runtimeMain" },
  };
}

// ⚠️ 합성(SYNTHETIC) fixture -- 실측 아님(coder-task.md 재작업2 §3-1-1).
// 실 CLI가 `ok:false`이면서 `result.dispatch`에 완전한 배정 데이터를
// 담아 주는 사례는 관측된 적 없다. 그러나 §1-E 실측(`worktree create`가
// `ok:false`인데 실제로는 워크트리가 생성돼 있었다)의 반대 방향 --
// "실패라고 답했는데 내용물이 있다"를 정직하게 방어하려면 이 경로를 막는
// 방어선(`raw.ok !== true`)이 fixture 없이도 원래는 옳다. 이 합성 입력은
// 그 방어선이 실제로 load-bearing인지 시험한다.
export function rawDispatchShowFalseOkWithCompleteDispatch() {
  return {
    id: "reqFalseOk",
    ok: false,
    result: {
      dispatch: {
        id: "ctxMain",
        task_id: "taskMain",
        assignee_handle: "termMain",
        assignee_pane_key: "seatMain-tab:seatMain-leaf",
        status: "dispatched",
        failure_count: 0,
        last_failure: null,
        dispatched_at: "2026-07-26 00:00:00",
        completed_at: null,
        created_at: "2026-07-26 00:00:00",
        last_heartbeat_at: null,
      },
    },
    _meta: { runtimeId: "runtimeMain" },
  };
}

// ⚠️ 합성(SYNTHETIC) fixture 3종 -- 실측 아님(coder-task.md 재작업2
// §3-1-2). 세 필드(`task_id`/`id`/`assignee_pane_key`) 각각 하나씩 빈
// 문자열로 만든다 -- 한 케이스로 뭉치면 한 필드만 검사해도 통과해 버리므로
// 필드별로 분리한다.
export function rawDispatchShowMissingTaskId() {
  return rawDispatchShowAssigned({ task_id: "" });
}
export function rawDispatchShowMissingDispatchId() {
  return rawDispatchShowAssigned({ id: "" });
}
export function rawDispatchShowMissingAssigneePaneKey() {
  return rawDispatchShowAssigned({ assignee_pane_key: "" });
}

// ---- 1-C: terminal create ----

export function rawTerminalCreate(terminalOverrides = {}) {
  return {
    id: "reqCreate",
    ok: true,
    result: {
      terminal: {
        handle: "termMain",
        tabId: "seatMain-tab",
        paneKey: "seatMain-tab:seatMain-leaf",
        ptyId: "ptyMain",
        worktreeId: "wtMain",
        title: "CODER-cycle4b2b3",
        surface: "visible",
        ...terminalOverrides,
      },
    },
    _meta: { runtimeId: "runtimeMain" },
  };
}

// `--focus` 경로 실측: paneKey/ptyId 자체가 응답에 없다(키 결손, undefined
// 아님).
export function rawTerminalCreateFocus() {
  return {
    id: "reqFocus",
    ok: true,
    result: {
      terminal: {
        handle: "termMain",
        tabId: "seatMain-tab",
        title: "CODER-cycle4b2b3",
        surface: "visible",
      },
    },
    _meta: { runtimeId: "runtimeMain" },
  };
}

// ---- 1-D: terminal list 행 ----

export function rawTerminalListRowAdopted(rowOverrides = {}) {
  return {
    handle: "termMain",
    ptyId: "ptyMain",
    worktreeId: "wtMain",
    worktreePath: "C:/seatMain/path",
    branch: "seatMain-branch",
    tabId: "seatMain-tab",
    leafId: "seatMain-leaf",
    title: "CODER-cycle4b2b3",
    connected: true,
    writable: true,
    lastOutputAt: "2026-07-26T00:00:00Z",
    preview: "seatMain preview text",
    ...rowOverrides,
  };
}

// 미채택 좌석 폴백: tabId === leafId === "pty:<worktreeId>@@<hash>".
export function rawTerminalListRowUnadopted(rowOverrides = {}) {
  const fallback = "pty:wtMain@@hashMain";
  return {
    handle: "termFallback",
    ptyId: "ptyFallback",
    worktreeId: "wtMain",
    worktreePath: "C:/seatMain/path",
    branch: "seatMain-branch",
    tabId: fallback,
    leafId: fallback,
    title: "shell",
    connected: true,
    writable: true,
    lastOutputAt: "2026-07-26T00:00:00Z",
    preview: "PS C:\\seatMain> ",
    ...rowOverrides,
  };
}

// 실측 근거 있음(coder-task.md 재작업2 §3-1-3): `terminal list` 행 12필드가
// 항상 다 차 있다는 보장은 없다. tabId/leafId가 결손이거나 빈 문자열인
// 경우 관측 불가능(adoptionObservable:false)이어야 한다.
export function rawTerminalListRowMissingTabId(rowOverrides = {}) {
  return rawTerminalListRowAdopted({ tabId: "", ...rowOverrides });
}
export function rawTerminalListRowMissingLeafId(rowOverrides = {}) {
  return rawTerminalListRowAdopted({ leafId: "", ...rowOverrides });
}

// ⚠️ 합성(SYNTHETIC) fixture -- 실측 아님(coder-task.md 재작업2 §3-1-4).
// tabId===leafId이면서 폴백 형태가 **아닌** 경우(예: 같은 UUID를 두 번
// 관측) -- 폴백 형태 검사와 겹치지 않는 유일한 tabId===leafId 케이스다.
// 07-25/07-26 실측에서는 tabId===leafId가 항상 폴백 형태였다(미채택
// 좌석) -- 폴백이 아닌 동일값 관측은 관측된 적 없다.
export function rawTerminalListRowSameNonFallbackIds(rowOverrides = {}) {
  return rawTerminalListRowAdopted({
    tabId: "seatMain-shared-id",
    leafId: "seatMain-shared-id",
    ...rowOverrides,
  });
}

// ⚠️ 합성(SYNTHETIC) fixture -- 실측 아님(coder-task.md 재작업1 §1-1).
// 07-25/07-26 실측에서 확인된 미채택 형태는 tabId===leafId===
// "pty:...@@..." 하나뿐이다. 이 fixture는 그 실측 사례가 아니라, "폴백
// 형태 검사(isUnadoptedFallbackForm)가 tabId!==leafId 검사와 독립적으로
// load-bearing인가"를 시험하기 위해 만든 합성 입력이다 -- tabId와 leafId를
// 일부러 다르게 두고 그중 하나만 폴백 형태로 만들어, 앞선
// `tabId === leafId` 검사가 걸러내지 못하는 경로를 강제로 만든다(재작업1
// §0 문제2: 기존 rawTerminalListRowUnadopted()는 tabId===leafId라서 그
// 앞선 검사가 먼저 걸러버려 폴백 형태 검사가 한 번도 실행되지 않는 죽은
// 방어선이었다).
export function rawTerminalListRowUnadoptedDistinctFallback(rowOverrides = {}) {
  return {
    handle: "termFallback",
    ptyId: "ptyFallback",
    worktreeId: "wtMain",
    worktreePath: "C:/seatMain/path",
    branch: "seatMain-branch",
    tabId: "pty:wtMain@@hashDistinct",
    leafId: "seatMain-leaf-distinct",
    title: "shell",
    connected: true,
    writable: true,
    lastOutputAt: "2026-07-26T00:00:00Z",
    preview: "PS C:\\seatMain> ",
    ...rowOverrides,
  };
}

// terminal-list 전체 응답 봉투(§1-D: result.terminals, 복수 배열 -- 위
// 단수 result.terminal 봉투와 구조가 다르다).
export function rawTerminalListResponse(rows) {
  return {
    id: "reqList",
    ok: true,
    result: { terminals: rows },
    _meta: { runtimeId: "runtimeMain" },
  };
}
