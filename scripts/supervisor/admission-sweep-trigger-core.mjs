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
// - 탭/칸 재생성 -- 같은 물리 좌석이 탭을 닫았다 다시 열면 새 tabId/leafId
//   (paneKey)로 나타난다 -- 이 조회만으로는 "같은 좌석이 돌아왔다"를 알 수
//   없다(sweepAndRecover의 SUSPECT->ACTIVE 복구도 같은 seat_key 문자열
//   재등장에만 반응한다). HYK-317 수리(paneKey로 축 전환) 이후에도 이
//   한계 자체는 그대로다 -- handle 대신 paneKey를 쓴다고 재생성 문제가
//   사라지지는 않는다, 형식 불일치 버그만 없앤다.
// - 빈 셸 탭 -- `terminal list`가 되돌리는 paneKey가 실제로 일하는
//   좌석인지 빈 셸인지 이 조회만으로 구별할 수 없다(살아있다=paneKey가
//   목록에 있다는 것뿐).
// - 레거시 좌석(HYK-213/214) -- 이 조회 이전에 admit된 seat_key가 이
//   목록의 명명 규칙과 다를 수 있다(예: HYK-317 수리 전 handle로 admit된
//   레거시 예약).
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
// - "이 paneKey가 실제로 응답하는 살아있는 프로세스다"까지는 증명하지
//   않는다 -- 오직 "orca가 지금 이 paneKey를 목록에 올렸다"만 증명한다.
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
//   {ok:true, terminals:[{tabId, leafId, ...}, ...]}  -- 조회 성공
//   {ok:false, reason}                                 -- 조회 실패(무엇이든)
//
// ★HYK-317 수리: `liveSeatKeys`는 원장의 좌석 신분증과 **같은 축**(paneKey,
// `${tabId}:${leafId}`)으로 만든다. 이전 버전은 `entry.handle`(orca
// terminal handle, `term_...` 모양)을 그대로 썼는데, 원장(admission-
// ledger-core.mjs)의 `seat_key`는 dispatch-worker.ps1이 `$paneKey`(terminal
// show/dispatch-show의 `${tabId}:${leafId}`, docs/control-room-patches/
// HYK-256-dispatch-worker-receipt-path.md:145-147)로 심는다 -- 형식이
// 달라 sweepAndRecover의 `liveSet.has(entry.seat_key)`가 **영원히**
// false였다(모든 예약이 "좌석 부재"로 오판, coder-task.md §1 fail-open).
// `terminal list`가 돌려주는 각 항목은 `tabId`/`leafId`를 원시 필드로
// 이미 갖고 있다(hyk185-seat-multi 실측 샘플 참조) -- `terminal show`를
// 추가로 부르지 않고 그 자리에서 합성한다(2R이 반려한 "leafId 부재
// 상태에서 합성"과 다르다 -- 여기 tabId/leafId는 `terminal list` 응답
// 자체의 원시 필드다, 합성이 아니라 조합).
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
    if (!isNonEmptyString(entry.tabId) || !isNonEmptyString(entry.leafId)) {
      continue;
    }
    const paneKey = `${entry.tabId}:${entry.leafId}`;
    if (seen.has(paneKey)) continue;
    seen.add(paneKey);
    liveSeatKeys.push(paneKey);
  }
  return {
    verdict: SWEEP_TRIGGER_VERDICT.PROCEED,
    reasonCode: SWEEP_TRIGGER_REASON.OK,
    liveSeatKeys,
  };
}

// ⛔범위 밖 명시 (HYK-317 완료 조건 2, coder-task.md §2-3): "죽은 껍데기의
// 신분증(paneKey)이 `terminal list`에 여전히 남아 있어 sweep이 죽은
// 좌석을 산 것으로 오판"하는 **역방향**은 이 라운드가 고치지 않는다
// (HYK-294 축3 연계). 이 코어는 여전히 "orca가 지금 이 paneKey를
// 목록에 올렸다"만 증명하고, 그 좌석에서 실제로 프로세스가 응답하는지는
// 증명하지 않는다(위 헤더 §33-38 "이 코어가 증명하지 않는 것" 그대로,
// paneKey로 축을 바꿔도 그 한계 자체는 바뀌지 않는다).
