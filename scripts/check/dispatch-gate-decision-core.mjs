// HYK-217-dispatch-gate-1 (coder-task.md) -- «배달 도구가 스스로 게이트를
// 확인하고, 불통과면 배달을 거부한다」의 판단(코어).
//
// 실사고(coder-task.md §0): 연속 반려 진단 게이트가 exit 2(불통과)를 냈는데
// 배달 도구(관제실 `dispatch-worker.ps1`, CI 없음)가 게이트 검사와 배달을
// 한 명령에 묶어 실행해 불통과인데도 배달이 나갔다. 방어는 "ORCH가 검사
// 결과를 보고 나서 배달한다"는 사람의 약속뿐이었다 -- 기계 앵커가 0이었다.
// 이 모듈은 그 앵커다: `reject-streak.mjs gate|diagnostic-gate`의 종료코드를
// 받아 배달 허용/거부를 판정하는 순수 함수. I/O, 자식 프로세스 실행, 다른
// 모듈 참조 0(dispatch-postcheck-core.mjs와 동일 계약) -- 호출부
// (dispatch-gate-decision.mjs)가 실제로 게이트를 실행해 얻은
// {exitCode, stdout, stderr}만 넘긴다.
//
// §2 실측 계약(coder-task.md): `reject-streak.mjs gate|diagnostic-gate`의
// 종료코드는 세 가지뿐이다 -- 0(통과)/2(차단)/1(운영 오류, 실측된 유일한
// 발생원은 "task file not found"). 이 세 값 밖(예: 시그널로 죽어 exitCode가
// null인 경우)도 실제로 벌어질 수 있으므로 네 번째 상태로 명시한다.
//
// §2 요구된 판단(운영 오류를 어떻게 다룰 것인가):
// - "조회 실패 = 신호 없음 = 정상"으로 접지 않는다 -- exit 1은 ALLOW로 가지
//   않는다(그러면 이 트랙이 막으려는 침묵을 스스로 재생산한다).
// - "운영 오류 = 차단"으로 단순 뭉뚱그리면 거짓 경보가 된다는 경고도
//   있었으나, 이 게이트는 *배달을 막을지 말지*를 결정하는 사전 게이트다
//   (HYK-212 postcheck처럼 이미 벌어진 일을 사후 관찰하는 게 아니다 --
//   배달은 되돌릴 수 없다). "판정할 수 없다"를 "허용"으로 처리하면 원본
//   사고가 막으려던 바로 그 실패모드(불통과인데 배달됨)를 정확히
//   재현하므로, 안전측(fail-closed)이 유일하게 방어 가능한 기본값이다.
//   대신 거짓 경보 우려는 (a) REJECT_BLOCKED와 다른 상태 코드로 구분해
//   "내용이 나빠서"가 아니라 "판정 자체가 안 됐다"는 것을 사람이 즉시
//   구분하게 하고, (b) 이유 문자열에 원인(대개 task-path 오배선)과 조치를
//   함께 실어 오탐이 방치되지 않게 한다 -- 로 완화한다(코드 4-51-4).
export const DISPATCH_GATE_STATE = Object.freeze({
  ALLOW: "ALLOW",
  REJECT_BLOCKED: "REJECT_BLOCKED",
  REJECT_OPERATIONAL_ERROR: "REJECT_OPERATIONAL_ERROR",
  REJECT_UNKNOWN_EXIT: "REJECT_UNKNOWN_EXIT",
});

function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "(no output)";
}

// The one function this module exists to provide. Never throws, never
// returns a silent-allow state without a human-readable `reason` (coder-task
// §5-2 비타협: 허용이면 그 이유가 사람이 읽는 한 줄로 출력돼야 한다).
export function decideFromGateExit({ exitCode, stdout, stderr, label } = {}) {
  const tag = typeof label === "string" && label ? label : "dispatch gate";

  if (exitCode === 0) {
    return {
      state: DISPATCH_GATE_STATE.ALLOW,
      allow: true,
      reason: `${tag}: PASS(exit 0) -> 배달 허용 -- ${firstNonEmpty(stdout, stderr)}`,
    };
  }

  if (exitCode === 2) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_BLOCKED,
      allow: false,
      reason: `${tag}: BLOCK(exit 2) -> 배달 거부 -- ${firstNonEmpty(stderr, stdout)}`,
    };
  }

  if (exitCode === 1) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_OPERATIONAL_ERROR,
      allow: false,
      reason: `${tag}: 운영 오류(exit 1, 판정 불가) -> 배달 거부(안전측 기본값) -- 원인: ${firstNonEmpty(stderr, stdout)} -- 조치: task-path/ledger 배선을 확인하고 재시도하라`,
    };
  }

  return {
    state: DISPATCH_GATE_STATE.REJECT_UNKNOWN_EXIT,
    allow: false,
    reason: `${tag}: 알 수 없는 종료코드(${String(exitCode)}, 닫힌 상태 집합 {0,1,2} 밖) -> 배달 거부(안전측 기본값) -- stdout: ${firstNonEmpty(stdout)} / stderr: ${firstNonEmpty(stderr)}`,
  };
}

// Combines N independent gate decisions (e.g. `gate` + `diagnostic-gate`,
// which coder-task.md §2 confirms are independent and both apply) into one
// delivery verdict: ALLOW only if every decision ALLOWs. Reject reasons are
// never dropped -- every non-allow decision's reason is preserved in
// `reasons` so a human reading the CLI output sees exactly which gate(s)
// blocked and why, not just an aggregate boolean.
export function combineGateDecisions(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const allow = list.length > 0 && list.every((d) => d?.allow === true);
  return {
    allow,
    reasons: list.map((d) => d?.reason ?? "(missing decision)"),
    states: list.map((d) => d?.state ?? null),
  };
}
