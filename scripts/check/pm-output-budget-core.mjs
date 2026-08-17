// HYK-292 2R 수리 1 (coder-task.md §2 수리 1 · review-r1.md 반려 사유 1) --
// docs-budget-config.json의 pm_output_budget_bytes는 사람 승인 숫자가
// 아직 없어 null이다(§3-2). 1R에서는 설정 어댑터가 null을 돌려주는
// 것으로 끝났고, 실행 출력에는 이 축 자체가 없었다 -- 검토자가 "미설정을
// 조용히 통과시킨다"고 반려했다. 이 코어는 그 축을 실행 출력에 "소리내어"
// 남기는 순수 판정 함수다. I/O 0 -- 바이트 수는 호출부가 넘긴다.
//
// 계약:
//   pmOutputBudgetBytes === null  -> judged:false, 미설정 신호(사람 승인
//     대기)만 내고 pass/fail을 만들어내지 않는다(숫자를 지어내지 않는다).
//   pmOutputBudgetBytes 가 양의 정수 -> judged:true, bytes와 비교해
//     정상 판정(ok true/false)으로 갈린다.
export function formatPmOutputBudgetStatus({ pmOutputBudgetBytes, bytes }) {
  if (pmOutputBudgetBytes === null) {
    return {
      judged: false,
      ok: null,
      line: "PM_OUTPUT_BUDGET=UNSET (사람 승인 대기)",
    };
  }
  const ok = bytes <= pmOutputBudgetBytes;
  return {
    judged: true,
    ok,
    line: `PM_OUTPUT_BUDGET=${bytes}/${pmOutputBudgetBytes} ${ok ? "OK" : "초과"}`,
  };
}
