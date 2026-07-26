// HYK-171 사이클4b-2b-2 -- 축A(배정 상관 증거 계약) mutation 원장(coder-task.md
// §4) 공용 fixture. 저엔트로피 리터럴만 사용한다(G9 -- 4b-2b-1에서 고엔트로피
// placeholder가 gitleaks CI를 2회 실패시킨 재발 방지).

export function seatRecord(overrides = {}) {
  return {
    paneKey: "seatMain-tab:seatMain-leaf",
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    ...overrides,
  };
}

export function dispatchShow(overrides = {}) {
  return {
    ok: true,
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    ...overrides,
  };
}

export function observed(overrides = {}) {
  return {
    adoptionObservable: true,
    tabId: "seatMain-tab",
    leafId: "seatMain-leaf",
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    ...overrides,
  };
}
