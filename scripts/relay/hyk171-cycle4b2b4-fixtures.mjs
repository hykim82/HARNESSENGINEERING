// HYK-171 사이클4b-2b-4 -- coder-task.md §1의 raw shape union(dispatch/
// dispatch-show)과 recordSeatDispatch 4상태 전이 시험에 쓰는 fixture.
//
// dispatch-show 응답 모양은 4b-2b-3의 rawDispatchShowAssigned와 동일 실측
// 근거(§8 실측 대조)를 쓴다 -- 여기서는 `orca orchestration dispatch --json`
// 쪽(§1-D: result.{dispatch(11키), injected(boolean)})을 추가한다. injected는
// 이번 사이클의 ORCH-소비결론.md §3-3 서술(claude=--inject 항상 사용,
// codex=--inject 안 씀)에 근거한 합성(SYNTHETIC) 값이다 -- dispatch --json
// 원문 라이브 캡처는 아직 없다(정직 경계, coder-task.md 어디에도 injected
// 값의 실측 캡처 근거는 없다).

export function rawDispatchInjected(dispatchOverrides = {}, injected = true) {
  return {
    id: "reqDispatch",
    ok: true,
    result: {
      dispatch: {
        id: "ctxDispatch",
        task_id: "task_runtime",
        assignee_handle: "termMain",
        assignee_pane_key: "seatMain-tab:seatMain-leaf",
        status: "dispatched",
        failure_count: 0,
        last_failure: null,
        dispatched_at: "2026-07-27 00:00:00",
        completed_at: null,
        created_at: "2026-07-27 00:00:00",
        last_heartbeat_at: null,
        ...dispatchOverrides,
      },
      injected,
    },
    _meta: { runtimeId: "runtimeMain" },
  };
}

export function rawDispatchNotInjected(dispatchOverrides = {}) {
  return rawDispatchInjected(dispatchOverrides, false);
}

// stale-recovery 재시도 성공 응답 -- 재시도의 dispatchId는 첫 실패 시도와
//달라야 한다(재시도가 새 배정을 만든다는 실측 계약, D14-B). 재시도가
// 첫 실패 raw를 재사용하는 변조(M2)를 잡으려면 이 값이 첫 값과 달라야 한다.
export function rawDispatchRetrySuccess(dispatchOverrides = {}) {
  return rawDispatchInjected({ id: "ctxRetry", ...dispatchOverrides }, true);
}

// D14-B stale 실패 응답 형태(orca-adapter.mjs STALE_DISPATCH_RE 실측 정규식
// 그대로 -- "already has an active dispatch ... for task task_xxx").
export function rawDispatchStaleFailure(staleRuntimeTaskId = "task_runtime") {
  return {
    ok: false,
    reason: `orca-adapter: DISPATCH_FAILED -- already has an active dispatch (ctxOld) for task ${staleRuntimeTaskId}`,
  };
}

export function rawTaskUpdateCompletedOk() {
  return {
    id: "reqComplete",
    ok: true,
    result: { task: { status: "completed" } },
  };
}

// dispatch-show 형태(injected 없음, result 키 1개) -- normalizeDispatchRawUnion
// 의 union 판정 대상.
export function rawDispatchShowForUnion(dispatchOverrides = {}) {
  return {
    id: "reqShow",
    ok: true,
    result: {
      dispatch: {
        id: "ctxDispatch",
        task_id: "task_runtime",
        assignee_handle: "termMain",
        assignee_pane_key: "seatMain-tab:seatMain-leaf",
        status: "dispatched",
        failure_count: 0,
        last_failure: null,
        dispatched_at: "2026-07-27 00:00:00",
        completed_at: null,
        created_at: "2026-07-27 00:00:00",
        last_heartbeat_at: null,
        ...dispatchOverrides,
      },
    },
    _meta: { runtimeId: "runtimeMain" },
  };
}

// ---- seat-registry recordSeatDispatch 시험용 안정 레코드 ----
// worktreePath/paneKey가 이미 채워진 "안정 레코드"(대장 등록 완료 상태를
// 가정 -- §0 정직 표기: 프로덕션에서 이 레코드를 만드는 생산자는 이번
// 사이클에도 없다. 시험 전용 사전조건이다).
export function stableSeatRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    ptyId: "ptyMain",
    handle: "termMain",
    tabId: "seatMain-tab",
    leafId: "seatMain-leaf",
    paneKey: "seatMain-tab:seatMain-leaf",
    worktreeId: "wtMain",
    worktreePath: "C:/seatMain/path",
    role: "CODER",
    taskId: null,
    dispatchId: null,
    capturedAt: "2026-07-27T00:00:00Z",
    dispatch: null,
    ...overrides,
  };
}

export function registryWith(...records) {
  return { schemaVersion: 1, seats: records };
}
