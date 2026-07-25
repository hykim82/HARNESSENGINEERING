// HYK-171 사이클4b-2b-1 -- mutation 원장(coder-task.md §3) 공용 fixture.
// 실측 근거(coder-task.md §0): 회전 fixture는 "생성 시 handle != 관측 시
// handle"을 재현해 ptyId 기반 판정이 handle 회전에 흔들리지 않음을
// 증명하는 데 쓴다.

export function fullRecord(overrides = {}) {
  return {
    ptyId: "pty-cycle4b2b1",
    worktreeId: "wt-cycle4b2b1",
    paneKey: "seatMain",
    capturedAt: "2026-07-26T03:07:00Z",
    // 진단용(판정 근거 아님) -- handle은 생성 시점 값으로 기록된다.
    handle: "term_created_at_seat_stand_up",
    ...overrides,
  };
}

export function ownedObservation(overrides = {}) {
  return {
    ptyId: "pty-cycle4b2b1",
    worktreeId: "wt-cycle4b2b1",
    paneKey: "seatMain",
    ...overrides,
  };
}

export function registryWith(records) {
  return { schemaVersion: 1, seats: records };
}
