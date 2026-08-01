// HYK-183 A-3 (coder-task.md §5, SV-6) -- 한도 "모르면 정지" 판정 코어.
//
// 배경(coder-task.md §1): 워커는 Claude 계정 한도를 소모한다. 2026-07-28에
// "선제 잔량 감시는 권위 표면 부재로 불가"가 확정됐고, 그래서 한도는
// "반응형 대기"로 다루기로 했다. 이 코어는 그 반응형 대기의 판정부다.
//
// 이 계약이 보장하지 않는 것 / 정하지 않는 것 (S11 필수):
// - 이 코어는 한도를 측정하지 않는다. 주입받은 관측(`observation`)을
//   판정만 한다 -- 그 관측이 실제 Claude 계정 한도를 정확히 반영하는지는
//   호출자 책임이고, 이 코어는 관측의 구조적 형태만 확인한다.
// - 권위 있는 잔량 표면이 없다는 것이 2026-07-28 확정 사실이며, 이 코어는
//   그 부재를 대기로 번역할 뿐 해결하지 않는다 -- 관측 수단 자체를
//   발명하지 않는다(API 호출·프로세스 실행·파일 읽기 0).
// - 대기 시간·재시도 정책은 이 조각에 없다 -- WAIT_BUDGET을 받은 뒤 얼마나
//   기다릴지, 언제 재시도할지는 이 코어 밖의 문제다(coder-task.md §2-3,
//   한용이 아직 정하지 않음).
//
// 비타협(coder-task.md §2):
// - I/O 0 -- fs·child_process·네트워크 호출 전부 금지. import는 없다(외부
//   모듈을 참조하지 않으므로 이 파일 자신이 구조적으로 I/O 표면이 없다).
// - throw로 판정을 대신하지 않는다 -- 인자가 이상하면 예외가 아니라
//   `{ok:false, decision:"WAIT_BUDGET", reasonCode:"INVALID_ARGUMENTS"}`를
//   반환한다.
// - "모른다"를 "충분하다"로 해석하지 않는다 -- 관측이 판정 불가·형식
//   이상·예외·소진·부재 중 하나라도 해당하면 전부 WAIT_BUDGET이다.
//   PROCEED는 "여유 있음이 명시적으로 관측된 경우"에만 나온다.

export const BUDGET_REASON = Object.freeze({
  BUDGET_OK: "BUDGET_OK",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  BUDGET_UNAVAILABLE: "BUDGET_UNAVAILABLE",
  BUDGET_MALFORMED: "BUDGET_MALFORMED",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
});

export const BUDGET_DECISION = Object.freeze({
  PROCEED: "PROCEED",
  WAIT_BUDGET: "WAIT_BUDGET",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function invalid() {
  return {
    ok: false,
    decision: BUDGET_DECISION.WAIT_BUDGET,
    reasonCode: BUDGET_REASON.INVALID_ARGUMENTS,
  };
}

function waitFor(reasonCode) {
  return {
    ok: true,
    decision: BUDGET_DECISION.WAIT_BUDGET,
    reasonCode,
  };
}

// judgeBudget({observation, now}) -> {ok, decision, reasonCode}
//
// observation = 주입받은 한도 관측(형태는 호출자가 만든다. 이 코어가
// 신뢰하는 최소 형태는 {status: "OK"|"EXHAUSTED"|"UNAVAILABLE"}). 이
// 형태를 벗어나면(null·undefined·문자열·빈 객체·알 수 없는 status·status
// 읽기 중 예외를 던지는 형태 등) 전부 BUDGET_MALFORMED 또는
// BUDGET_UNAVAILABLE로 WAIT_BUDGET이다 -- "모름"이 "충분함"으로 접히지
// 않는다.
export function judgeBudget(args) {
  if (!isPlainObject(args)) return invalid();
  const { observation, now } = args;
  if (!isFiniteNumber(now)) return invalid();

  let status;
  try {
    if (!isPlainObject(observation)) {
      return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);
    }
    status = observation.status;
  } catch {
    // observation이 getter에서 예외를 던지는 형태일 수 있다 -- 관측
    // 자체를 읽을 수 없으므로 "판정 불가"로 취급한다.
    return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);
  }

  if (status === "UNAVAILABLE") {
    return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);
  }
  if (status === "EXHAUSTED") {
    return waitFor(BUDGET_REASON.BUDGET_EXHAUSTED);
  }
  if (status === "OK") {
    return {
      ok: true,
      decision: BUDGET_DECISION.PROCEED,
      reasonCode: BUDGET_REASON.BUDGET_OK,
    };
  }
  // status가 KNOWN_STATUS 3종(OK/EXHAUSTED/UNAVAILABLE) 밖의 값이면
  // 형식 이상 -- 오탈자·미지의 값·누락(undefined)을 전부 여기서 막는다.
  return waitFor(BUDGET_REASON.BUDGET_MALFORMED);
}
