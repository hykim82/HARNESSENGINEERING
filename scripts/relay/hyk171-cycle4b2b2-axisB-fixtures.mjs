// HYK-171 사이클4b-2b-2 -- 축B(durable 실패 원장) mutation 원장(coder-task.md
// §4) 공용 fixture. 저엔트로피 리터럴만 사용한다(G9).

export function fields(overrides = {}) {
  return {
    scope: "teardown",
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    errorCode: "EVIDENCE_NOT_DURABLE",
    ...overrides,
  };
}
