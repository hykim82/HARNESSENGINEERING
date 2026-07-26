// HYK-171 사이클4b-2b-2 (coder-task.md §2) -- 배정(dispatch)와 좌석 사이의
// 상관 증거 계약(순수 코어).
//
// 배경(coder-task.md §0): teardown-core.mjs의 checkDispatchCorrelationProven
// 은 policy.dispatchCorrelationProven === true를 요구하지만, 그 값을 만들어
// 주는 생산자가 이 사이클 전까지 없었다. 2026-07-26 실측으로 paneKey가
// "생성 응답 / 좌석 환경변수 / dispatch-show 배정 기록" 세 곳에서 같은
// 값임이 확인됐다 -- 이 파일은 그 세 값을 대조해 PROVEN/UNPROVEN/MISMATCH를
// 내는 판정 함수만 제공한다.
//
// 비타협(coder-task.md §2):
// - 채택 상태가 관측 불가면 무조건 UNPROVEN(추정 금지) -- observed.
//   adoptionObservable !== true인 입력은 그 시점에서 즉시 접는다.
// - 동일 세대의 tabId/leafId로 재구성한 `${tabId}:${leafId}`가 대장
//   paneKey/dispatch-show assigneePaneKey 둘 다와 일치해야 한다.
// - target dispatch/incarnation(taskId/dispatchId)이 대장·dispatch-show·
//   관측 셋 다에서 같아야 한다 -- 과거 세대의 일치 기록 재사용(stale
//   grant)을 막는다(PM Q5 반례).
// - handle/title/preview는 근거로 쓰지 않는다(시그니처에 아예 없다).
// - dispatchShow.ok !== true이거나 결손이면 UNPROVEN(fail-closed).
//
// S6 경계: 이 파일은 vendor CLI 이름·셸 이름·PID를 모른다. 입력은 이미
// 어댑터 층에서 정규화된 { paneKey, taskId, dispatchId, tabId, leafId,
// assigneePaneKey, adoptionObservable } 필드만 받는다 -- raw JSON 파싱은
// 호출자(어댑터) 몫이다.

export const CORRELATION = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVEN: "UNPROVEN",
  MISMATCH: "MISMATCH",
});

export const REASON = Object.freeze({
  ADOPTION_NOT_OBSERVABLE: "ADOPTION_NOT_OBSERVABLE",
  SEAT_RECORD_INCOMPLETE: "SEAT_RECORD_INCOMPLETE",
  DISPATCH_SHOW_NOT_OK: "DISPATCH_SHOW_NOT_OK",
  INCARNATION_MISMATCH: "INCARNATION_MISMATCH",
  REGISTRY_PANE_KEY_MISMATCH: "REGISTRY_PANE_KEY_MISMATCH",
  DISPATCH_PANE_KEY_MISMATCH: "DISPATCH_PANE_KEY_MISMATCH",
  CORRELATION_PROVEN: "CORRELATION_PROVEN",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function verdict(kind, reason, extra = {}) {
  return { verdict: kind, reason, ...extra };
}

// 관측 후보의 채택 상태(§1)를 확인한다 -- 이 값이 true가 아니면 tabId/
// leafId를 재구성 근거로 삼을 수 없으므로(추정 금지) 즉시 UNPROVEN이다.
function checkAdoptionObservable(observed) {
  if (observed.adoptionObservable !== true)
    return REASON.ADOPTION_NOT_OBSERVABLE;
  if (!isNonEmptyString(observed.tabId) || !isNonEmptyString(observed.leafId)) {
    return REASON.ADOPTION_NOT_OBSERVABLE;
  }
  return null;
}

// 대장(seatRecord)에 상관 판정에 필요한 필드가 전부 있는지(§2 결손 시
// UNPROVEN).
function hasCompleteSeatRecord(seat) {
  return (
    isNonEmptyString(seat.paneKey) &&
    isNonEmptyString(seat.taskId) &&
    isNonEmptyString(seat.dispatchId)
  );
}

// dispatch-show 응답이 신뢰 가능한지(§2 fail-closed: ok!==true거나 결손이면
// 전부 UNPROVEN).
function hasValidDispatchShow(ds) {
  return (
    ds.ok === true &&
    isNonEmptyString(ds.taskId) &&
    isNonEmptyString(ds.dispatchId) &&
    isNonEmptyString(ds.assigneePaneKey)
  );
}

// target incarnation(관측이 검증하려는 그 배정)이 대장·dispatch-show 셋
// 다에서 같은지(§2 stale grant 방지 -- 과거 세대 paneKey 일치 기록을
// 재사용하지 못하게 한다).
function incarnationMatches(seat, ds, observed) {
  if (
    !isNonEmptyString(observed.taskId) ||
    !isNonEmptyString(observed.dispatchId)
  ) {
    return false;
  }
  return (
    seat.taskId === observed.taskId &&
    seat.dispatchId === observed.dispatchId &&
    ds.taskId === observed.taskId &&
    ds.dispatchId === observed.dispatchId
  );
}

// judgeDispatchCorrelation({ seatRecord, dispatchShow, observed, policy })
// -> PROVEN / UNPROVEN / MISMATCH + reason.
//
// policy는 현재 판정 계약을 완화하는 어떤 입력도 받지 않는다(강도를 낮추는
// 파라미터를 열어두면 그 자체가 안전장치를 끄는 문이 된다 -- seat-identity-
// core.mjs의 minCorroboration clamp와 같은 원칙). 예약만 해 둔다.
export function judgeDispatchCorrelation({
  seatRecord,
  dispatchShow,
  observed,
} = {}) {
  const seat = isPlainObject(seatRecord) ? seatRecord : {};
  const ds = isPlainObject(dispatchShow) ? dispatchShow : {};
  const o = isPlainObject(observed) ? observed : {};

  const adoptionReason = checkAdoptionObservable(o);
  if (adoptionReason) return verdict(CORRELATION.UNPROVEN, adoptionReason);

  if (!hasCompleteSeatRecord(seat)) {
    return verdict(CORRELATION.UNPROVEN, REASON.SEAT_RECORD_INCOMPLETE);
  }

  if (!hasValidDispatchShow(ds)) {
    return verdict(CORRELATION.UNPROVEN, REASON.DISPATCH_SHOW_NOT_OK);
  }

  if (!incarnationMatches(seat, ds, o)) {
    return verdict(CORRELATION.MISMATCH, REASON.INCARNATION_MISMATCH);
  }

  const reconstructedPaneKey = `${o.tabId}:${o.leafId}`;
  if (reconstructedPaneKey !== seat.paneKey) {
    return verdict(CORRELATION.MISMATCH, REASON.REGISTRY_PANE_KEY_MISMATCH);
  }
  if (reconstructedPaneKey !== ds.assigneePaneKey) {
    return verdict(CORRELATION.MISMATCH, REASON.DISPATCH_PANE_KEY_MISMATCH);
  }

  return verdict(CORRELATION.PROVEN, REASON.CORRELATION_PROVEN);
}
