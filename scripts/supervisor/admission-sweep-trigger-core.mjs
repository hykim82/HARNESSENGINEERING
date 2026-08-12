// HYK-228 (coder-task.md §2 항1) -- "발동 주체"가 admission sweep을 실제로
// 부르기 전, "지금 살아있는 좌석이 누구인가"의 권위 출처(coder-task §4
// "좌석 목록의 권위 출처를 먼저 정하라")를 판정하는 순수 코어.
//
// 권위 출처 선언(§4 요구): `orca terminal list --json`(orca-adapter.mjs
// buildTerminalListCommand/parseTerminalList, seat-liveness-wire가 이미
// 쓰는 동일 조회)이 "지금 살아있는 좌석"의 유일한 근거다. 이 코어 자신은
// 그 조회를 하지 않는다(I/O 0) -- 호출자가 조회 *결과*(성공/실패 포함)를
// `terminalList`로 주입한다(seat-liveness-core.mjs와 동일한 "관측 주입"
// 원칙).
//
// ★이 출처의 한계(§4 요구, 지어내지 않는다):
// - 핸들 회전(orca-adapter.mjs 헤더 "handle 회전 면역 좌석 참조") -- 같은
//   좌석이 다른 handle로 다시 나타나면 이 조회만으로는 "같은 좌석이
//   돌아왔다"를 알 수 없다(sweepAndRecover의 SUSPECT->ACTIVE 복구도 같은
//   seat_key 문자열 재등장에만 반응한다).
// - 빈 셸 탭 -- `terminal list`가 되돌리는 handle이 실제로 일하는 좌석인지
//   빈 셸인지 이 조회만으로 구별할 수 없다(살아있다=handle이 목록에
//   있다는 것뿐).
// - 레거시 좌석(HYK-213/214) -- 이 조회 이전에 admit된 seat_key가 이
//   목록의 명명 규칙과 다를 수 있다(예: 재작명·구 handle 포맷).
// ⛔"좌석 목록이 곧 진실"로 가정하지 않는다(§4) -- 그래서 sweepAndRecover
// 자체가 staleAfterMs만큼의 유예(즉시 SUSPECT 처리 아님)와 recoveryGraceMs
// 복구 창을 두고 있고(admission-ledger-core.mjs), 이 코어는 그 위에 "조회
// 자체가 실패했다"는 한 겹 더 이른 fail-closed 판단만 얹는다.
//
// ★비타협(coder-task §4 그대로): "조회 실패 = 살아있는 좌석 0건 = 전부
// 회수"로 접히면 이 트랙이 막으려는 것을 스스로 재생산한다. 그래서 조회
// 실패는 `liveSeatKeys: []`가 아니라 `ABSTAIN`(sweep 자체를 시도하지 않음)
// 이다 -- 호출자(admission-sweep-wire.mjs)는 이 판정이 ABSTAIN이면
// sweepAndRecover를 아예 부르지 않는다.
//
// 이 코어가 증명하지 않는 것(S11):
// - "이 handle이 실제로 응답하는 살아있는 프로세스다"까지는 증명하지
//   않는다 -- 오직 "orca가 지금 이 handle을 목록에 올렸다"만 증명한다.
// - 이 코어를 부르는 프로세스 자신이 죽으면 이 판정도 실행되지 않는다
//   ("감시자의 감시자" 문제, watch-freshness-core.mjs와 동일 축, 이
//   조각의 범위 밖).

export const SWEEP_TRIGGER_VERDICT = Object.freeze({
  PROCEED: "PROCEED",
  ABSTAIN: "ABSTAIN",
});

export const SWEEP_TRIGGER_REASON = Object.freeze({
  OK: "OK",
  ARGS_INVALID: "ARGS_INVALID",
  SEAT_QUERY_FAILED: "SEAT_QUERY_FAILED",
  SEAT_LIST_MALFORMED: "SEAT_LIST_MALFORMED",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function abstain(reasonCode) {
  return {
    verdict: SWEEP_TRIGGER_VERDICT.ABSTAIN,
    reasonCode,
    liveSeatKeys: null,
  };
}

// judgeSweepTrigger({terminalList}) -> {verdict, reasonCode, liveSeatKeys}
//
// `terminalList` is the adapter-shaped observation of "orca terminal list
// --json" (★mutation 표적: `terminalList.ok !== true`가 이 함수의 핵심
// fail-closed 가드다 -- 이 검사를 제거하면 조회 실패가 "좌석 0건"으로
// 새어나가 sweep이 전부를 회수해버린다):
//   {ok:true, terminals:[{handle, ...}, ...]}  -- 조회 성공
//   {ok:false, reason}                          -- 조회 실패(무엇이든)
export function judgeSweepTrigger({ terminalList } = {}) {
  if (!isPlainObject(terminalList)) {
    return abstain(SWEEP_TRIGGER_REASON.ARGS_INVALID);
  }
  if (terminalList.ok !== true) {
    return abstain(SWEEP_TRIGGER_REASON.SEAT_QUERY_FAILED);
  }
  if (!Array.isArray(terminalList.terminals)) {
    return abstain(SWEEP_TRIGGER_REASON.SEAT_LIST_MALFORMED);
  }
  const seen = new Set();
  const liveSeatKeys = [];
  for (const entry of terminalList.terminals) {
    if (!isPlainObject(entry)) continue;
    if (!isNonEmptyString(entry.handle)) continue;
    if (seen.has(entry.handle)) continue;
    seen.add(entry.handle);
    liveSeatKeys.push(entry.handle);
  }
  return {
    verdict: SWEEP_TRIGGER_VERDICT.PROCEED,
    reasonCode: SWEEP_TRIGGER_REASON.OK,
    liveSeatKeys,
  };
}
