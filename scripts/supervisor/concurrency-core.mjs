// HYK-183 A-2 (coder-task.md §5-2) -- 동시 실행 판정 코어(SV-5).
//
// 배경(coder-task.md §1): A-1의 judgeExecutionPlan은 "이미 처리됐는가·
// 진행 중인가"를 판단하지 않는다(그 파일 헤더에 명시). 이 파일이 그
// 진행 커서다 -- executor-core가 고른 후보(들)를 실제로 시작해도 되는지
// 동시 실행 관점에서만 판정한다.
//
// HYK-193 1R (coder-task.md §1~§3) -- 서명 패킷
// `PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1` S-5 개정: "상한은
// 고정 숫자가 아니라 한용이 정한 현재 값이며, supervisor는 그 값을
// 읽어서 쓴다(스스로 정하지 않는다). 상한을 코드에 상수로 박아 두면 이
// 게이트는 미충족(값의 출처가 한용이어야 한다)." 그래서 전역 상한은 더
// 이상 이 파일 안의 상수가 아니라 호출자가 매 호출마다 주입하는
// `globalCap` 인자다 -- 값을 어디서 읽는지(커밋된 값 파일 +
// `concurrency-cap-adapter.mjs`)는 이 파일 밖의 일이다(아래 §I/O 0
// 참조). ⛔`globalCap`이 주입되지 않거나 형태가 이상하면 이 코어는
// 아무 값으로도 대신 판정하지 않는다(예: 2로 폴백) -- `INVALID_ARGUMENTS`로
// 거부한다. 그 폴백 자체가 되살아난 코드 상수이기 때문이다(한용
// 14:47 확정, coder-task.md §2).
//
// 이 계약이 보장하지 않는 것 / 정하지 않는 것 (S11 필수):
// - 이 코어는 «진행 중인지»를 관측하지 않는다. 주입받은 값을 믿는다 --
//   `inFlight`가 실제 실행 상태를 정확히 반영하는지는 호출자 책임이고,
//   이 코어는 그 배열의 구조적 온전성(배열인지, null/undefined 원소가
//   없는지)만 확인한 뒤 길이만 센다.
// - 실행 상태 장부의 위치·형식은 미정이며 이 코어는 그것을 정하지 않는다
//   -- `inFlight`를 어디서(파일·DB·메모리) 어떻게 수집했는지는 이 파일
//   밖의 문제다(coder-task.md §2-3 (가), 아직 한용이 정하지 않음).
// - 항목 «완료» 판정은 이 조각에 없다 -- `inFlight`에 무엇이 남아 있고
//   무엇이 빠졌는지(어떤 항목이 "끝났다"고 셀지)는 호출자가 이미 결정한
//   뒤 이 함수에 넘긴다(coder-task.md §2-3 (나), 아직 한용이 정하지 않음).
//   이 코어는 그 목록을 다시 판정하지 않고 길이만 쓴다.
// - `globalCap`이 «현재 유효한 상한값과 같은지»는 이 코어가 검증하지
//   않는다 -- 그 값이 값 파일에서 정확히 읽혔는지는 어댑터/호출자의
//   책임이고, 이 코어는 주입된 숫자의 구조적 유효성(음이 아닌 정수)만
//   본다.
//
// 비타협(coder-task.md §2):
// - I/O 0 -- fs·child_process·네트워크 호출 전부 금지. import는 없다
//   (외부 모듈을 참조하지 않으므로 이 파일 자신이 구조적으로 I/O 표면이
//   없다). ⇒ 전역 상한 값을 이 파일 안에서 읽지 않는다(파일 읽기는
//   코어 밖, `concurrency-cap-adapter.mjs`의 몫).
// - throw로 판정을 대신하지 않는다 -- 인자가 이상하면 예외가 아니라
//   `{ok:false, decisions:[], reasonCode:"INVALID_ARGUMENTS"}`류를
//   반환한다.
// - `ok:false`면 `decisions`는 항상 빈 배열(부분 판정 금지, executor-core의
//   "ok:false면 plan은 항상 null" 관례를 그대로 따른다).
// - `queue_epoch`를 다루지 않는다 -- 이 코어는 큐 항목이 아니라 "지금
//   시작해도 되는가"만 본다.

export const CONCURRENCY_REASON = Object.freeze({
  DECIDED: "DECIDED",
  IN_FLIGHT_UNREADABLE: "IN_FLIGHT_UNREADABLE",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
});

export const CONCURRENCY_DECISION = Object.freeze({
  START: "START",
  WAIT: "WAIT",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeInteger(v) {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function invalid() {
  return {
    ok: false,
    decisions: [],
    reasonCode: CONCURRENCY_REASON.INVALID_ARGUMENTS,
  };
}

function unreadable() {
  return {
    ok: false,
    decisions: [],
    reasonCode: CONCURRENCY_REASON.IN_FLIGHT_UNREADABLE,
  };
}

function isWellFormedCandidate(item) {
  return isPlainObject(item) && isNonEmptyString(item.issueId);
}

// inFlight는 "판정 불가"(구조가 이상함)와 "판정 가능하지만 비어 있음"을
// 구분해야 한다 -- 전자를 후자로 접으면("모름"을 "비어 있음"으로 해석)
// 진행 중인 작업이 있어도 새 시작을 허용하게 된다(coder-task.md §5-2).
function isWellFormedInFlight(inFlight) {
  if (!Array.isArray(inFlight)) return false;
  for (const item of inFlight) {
    if (item === null || item === undefined) return false;
  }
  return true;
}

// judgeConcurrency({requested, inFlight, policy, globalCap}) -> {ok, decisions, reasonCode}
//
// requested = 시작 후보 목록(A-1 judgeExecutionPlan이 만든 plan 객체들,
// 최소 {issueId} 형태로 취급 -- 배열 순서가 우선순위다, 호출자가 이미
// ordinal 오름차순 등으로 정렬해 넘긴다고 가정한다).
// inFlight = 현재 진행 중이라고 "관측된" 것(이 코어는 그것을 읽지 않고
// 주입받는다).
// policy = {maxConcurrent} -- 이번 판정 라운드에서 허용할 동시 실행 수
// (v1 호출자는 1을 넘긴다).
// globalCap = 호출자가 주입하는 «그때 유효한» 전역 상한(HYK-193 S-5) --
// 이 코어 자신은 항상 이 값으로 policy.maxConcurrent를 한 번 더
// clamp한다(policy가 그보다 큰 값을 요청해도 넘지 않는다). 이 값의
// 출처는 이 코어의 관심사가 아니다(코어 밖 어댑터가 커밋된 값 파일에서
// 읽어 주입한다) -- 다만 **주입 자체가 없거나 형태가 이상하면**(음이
// 아닌 정수가 아니면) 이 코어는 어떤 숫자로도 대신하지 않고
// `INVALID_ARGUMENTS`로 거부한다(§주입 없음 = 판정 불가, 헤더 참조).
export function judgeConcurrency(args) {
  if (!isPlainObject(args)) return invalid();
  const { requested, inFlight, policy, globalCap } = args;

  if (!Array.isArray(requested)) return invalid();
  if (!requested.every(isWellFormedCandidate)) return invalid();
  if (!isPlainObject(policy)) return invalid();
  if (!isNonNegativeInteger(policy.maxConcurrent)) return invalid();
  if (!isNonNegativeInteger(globalCap)) return invalid();

  if (!isWellFormedInFlight(inFlight)) return unreadable();

  const effectiveCap = Math.min(policy.maxConcurrent, globalCap);
  const availableSlots = Math.max(0, effectiveCap - inFlight.length);
  const startsAllowed = Math.min(availableSlots, requested.length);

  const decisions = requested.map((item, index) => ({
    issueId: item.issueId,
    decision:
      index < startsAllowed
        ? CONCURRENCY_DECISION.START
        : CONCURRENCY_DECISION.WAIT,
  }));

  return {
    ok: true,
    decisions,
    reasonCode: CONCURRENCY_REASON.DECIDED,
  };
}
