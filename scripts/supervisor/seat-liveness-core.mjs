// HYK-185 seat-liveness-1 (coder-task.md) -- 워커 좌석 "무응답(갇힘)" 판정
// 코어.
//
// 배경(coder-task.md §1): CODER 좌석이 권한 승인 창에 약 28분 갇혔고
// 아무도 몰랐다. 배달 11:23 -> 좌석이 13분 일함 -> 무출력 시작 11:36 ->
// 발견 12:04(사람의 눈) -> 승인하자 즉시 재개. 그동안 ORCH는 "작업 중"으로
// 알고 대기했다. 갇힌 에이전트는 "막혔다"를 스스로 보고할 수 없다 --
// 워커의 질문 경로·결과 파일 기록·STATUS 자가보고는 전부 그 에이전트가
// 살아 움직여야 작동하므로, 갇히면 그 경로가 동시에 죽는다. 자기 신고
// 계열은 원리적으로 이 상태를 못 잡는다 -- 반드시 밖에서 봐야 한다.
//
// 이 코어가 증명한다 / 증명하지 않는다 (S11 필수, coder-task.md §3-g
// 그대로, 최소 4개):
// 1. ★**두 실제 표본이 각 1건뿐이라 임계 기본값의 근거가 약하다** --
//    아래 §DEFAULT_MAX_NO_OUTPUT_SECONDS 근거 참조. 15분(정상 침묵) <
//    기본 임계 < 28분(실제 사고) 구간에 있다는 것만 확인했을 뿐, 그
//    구간 안 어디가 "맞는" 값인지는 이 표본들만으로 알 수 없다.
// 2. ★**이 코어를 부르는 프로덕션 경로가 아직 없다** -- dispatch-start-
//    core.mjs(gap#74)와 동일한 처지다. 판정 함수만 있고, 실제 좌석 조회
//    ·주기 실행·재배달 신호 전송은 전부 이 코어 밖(A-5, 승인 밖)이며
//    아직 결선되지 않았다.
// 3. ★**화면 축의 한계 3가지**(coder-task.md §2-2) -- ①우리 규율이
//    "화면 문자열은 진행의 근거가 아니다"(2026-07-31 실사고) ②`terminal
//    read`가 정확히 필요한 순간에 0줄을 준 전례(2026-07-31) ③창 문구는
//    벤더가 바꾼다. 그래서 화면 문자열(`reasonHint`)은 오직 사람이 읽을
//    "사유 후보"로만 결과에 실릴 뿐, 판정에는 전혀 쓰이지 않는다.
// 4. ★**감시자 자신이 멈추면 이 축도 함께 멈춘다** -- 이 코어는 관측이
//    "주입"되어야만 판정한다. 관측을 수집해 이 코어를 부르는 프로세스가
//    죽거나 갇히면, 정확히 이 코어가 잡으려는 문제(무응답)를 그 감시
//    프로세스 자신이 똑같이 겪을 수 있고, 이 코어는 그것을 스스로 알
//    방법이 없다("전부 덮인다"고 말하지 않는다 -- coder-task.md §5-6).
//
// 비타협(coder-task.md §2):
// - I/O 0 -- `orca` 호출 0·fs·child_process·네트워크 0. import 없음(이
//   파일 자신이 구조적으로 I/O 표면이 없다, dispatch-start-core.mjs와
//   동일 형태). 현재 시각도 `now` 인자로만 받는다(`Date.now()` 호출 0).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - `verdict`는 항상 `RESPONSIVE`/`SUSPECTED_UNRESPONSIVE`/`UNDECIDABLE`
//   3상태 중 하나다 -- 제3의 값·`null`이 없다.
// - 관측 결손·형식위반·순서 역전(관측이 배달보다 이르다)·미래 시각은
//   전부 `UNDECIDABLE`로 닫히고 `SUSPECTED_UNRESPONSIVE`/`RESPONSIVE`로
//   새지 않는다.
//
// 판정 축(coder-task.md §2-2, §2-3 그대로): 판정의 권위 = 시간 축
// 하나뿐이다. 기준선(coder-task.md §2-3) = 배달(dispatch) 시각 --
// 좌석이 애초에 출력해야 하는 구간인지를 코어가 스스로 알 수 없으므로
// 배달 시각을 기준선으로 받는다. 배달 전 구간의 침묵은 정상이다.
// "마지막으로 알려진 활동 시각"은 `max(lastOutputAt, dispatchedAtMs)`다
// -- 배달 이전의 오래된 출력 하나만 있고 아직 새 출력이 없어도, 기준은
// 배달 시각으로 잡히므로 그 정상적인 초기 침묵을 무응답으로 오판하지
// 않는다(§3-d 반례가 요구하는 형태). `now`와 그 기준 사이의 경과가
// 임계를 넘으면 `SUSPECTED_UNRESPONSIVE`, 아니면 `RESPONSIVE`다.
// 화면 문자열(`reasonHint`)은 어느 쪽에도 관여하지 않고 `details`에
// 그대로 실릴 뿐이다(§2-2 비타협).
//
// 어휘 신규 도입 선언: `SEAT_LIVENESS_VERDICT`·`SEAT_LIVENESS_REASON`
// 둘 다 이 파일이 새로 만든다.
//
// 기본 임계값 근거(dispatch-start-core.mjs와 동일 형식): 오늘 실제로
// 관측된 두 표본 --
//   (b) 실제 사고: 무출력 시작 11:36, 발견 12:04 -> 약 28분(1680초).
//   (c) 정상 사례: codex 좌석이 정상 작업 중 약 15분(900초) 침묵.
// `DEFAULT_MAX_NO_OUTPUT_SECONDS`(1200초=20분)는 그 두 표본 사이(900초
// < 1200초 < 1680초)에 놓이도록 골랐다 -- 정상 침묵(15분)은 여전히
// 판정 보류 없이 RESPONSIVE로 통과시키면서, 실제 사고 형태(28분)는
// 사람이 발견하기(83분/28분) 전에 이미 SUSPECTED_UNRESPONSIVE로 걸린다.
// ★그러나 위 S11 한계 1에서 밝힌 대로, 이 값은 "두 표본 사이 어딘가"
// 라는 것만 보장할 뿐 그 자체의 운영 튜닝 근거는 약하다. 호출자는
// 언제든 다른 값을 넘겨 이 기본값을 무시할 수 있다(하드코딩이 아니라
// "생략 시 낙하값").

export const SEAT_LIVENESS_VERDICT = Object.freeze({
  RESPONSIVE: "RESPONSIVE",
  SUSPECTED_UNRESPONSIVE: "SUSPECTED_UNRESPONSIVE",
  UNDECIDABLE: "UNDECIDABLE",
});

export const SEAT_LIVENESS_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  DISPATCH_INVALID: "DISPATCH_INVALID",
  NOW_INVALID: "NOW_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  DISPATCH_IN_FUTURE: "DISPATCH_IN_FUTURE",
  OBSERVATION_INVALID: "OBSERVATION_INVALID",
  OBSERVATION_MALFORMED: "OBSERVATION_MALFORMED",
  OBSERVATION_BEFORE_DISPATCH: "OBSERVATION_BEFORE_DISPATCH",
  OBSERVATION_IN_FUTURE: "OBSERVATION_IN_FUTURE",
  NO_OUTPUT_PAST_THRESHOLD: "NO_OUTPUT_PAST_THRESHOLD",
  WITHIN_THRESHOLD: "WITHIN_THRESHOLD",
});

export const DEFAULT_MAX_NO_OUTPUT_SECONDS = 1200;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isPositiveFiniteNumber(v) {
  return isFiniteNumber(v) && v > 0;
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: SEAT_LIVENESS_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

function isWellFormedDispatch(dispatch) {
  if (!isPlainObject(dispatch)) return false;
  if (!isNonEmptyString(dispatch.dispatchId)) return false;
  return isFiniteNumber(dispatch.dispatchedAtMs);
}

// ⚠️판정에 쓰는 필드는 `observedAtMs`·`lastOutputAt` 둘뿐이다.
// `reasonHint`(화면 문자열 사유 후보)가 실려 와도 이 함수는 그 값을
// 읽어 구조를 검사하지 않는다 -- 존재 여부·형식 무관, 오직 통과시켜
// 호출부에서 details에 그대로 옮길 뿐이다(§2-2 비타협).
function isWellFormedObservation(entry) {
  if (!isPlainObject(entry)) return false;
  if (!isFiniteNumber(entry.observedAtMs)) return false;
  if (!isFiniteNumber(entry.lastOutputAt)) return false;
  // 출력 시각이 그 출력을 관측한 시각보다 나중일 수 없다(구조적 모순).
  return entry.lastOutputAt <= entry.observedAtMs;
}

// 관측 하나의 구조·순서·미래시각을 검사한다(dispatch-start-core.mjs의
// firstObservationProblem과 같은 형태로, 관측이 1건뿐이라는 점만 다르다).
// 문제가 있으면 그 사유 코드를, 전부 온전하면 `null`을 돌려준다.
function observationProblem(observation, dispatchedAtMs, now) {
  if (!isPlainObject(observation)) {
    return SEAT_LIVENESS_REASON.OBSERVATION_INVALID;
  }
  if (!isWellFormedObservation(observation)) {
    return SEAT_LIVENESS_REASON.OBSERVATION_MALFORMED;
  }
  if (observation.observedAtMs > now) {
    return SEAT_LIVENESS_REASON.OBSERVATION_IN_FUTURE;
  }
  // 관측 자체가 배달보다 이르면 이 배달을 근거로 판정할 수 없다(§2-3
  // 기준선 비타협) -- 배달 전 구간의 침묵을 이 코어에 들이지 않는다.
  if (observation.observedAtMs < dispatchedAtMs) {
    return SEAT_LIVENESS_REASON.OBSERVATION_BEFORE_DISPATCH;
  }
  return null;
}

// judgeSeatLiveness({dispatch, observation, now, thresholds}) ->
// {ok, verdict, reasonCode, details}
//
// - `dispatch` = 배달 사실 -- 최소 `dispatchId`(string)·`dispatchedAtMs`
//   (epoch ms number).
// - `observation` = 좌석의 가장 최근 관측 하나 -- 최소 `observedAtMs`·
//   `lastOutputAt`(둘 다 epoch ms number). `reasonHint`(선택, string)가
//   실려 오면 판정에는 쓰지 않고 `details.reasonHint`로만 되돌린다.
// - `now` = 판정 시각(epoch ms, 인자로만 받는다).
// - `thresholds.maxNoOutputSeconds` = 생략 시
//   `DEFAULT_MAX_NO_OUTPUT_SECONDS`.
export function judgeSeatLiveness(args) {
  if (!isPlainObject(args)) {
    return undecidable(SEAT_LIVENESS_REASON.ARGS_INVALID);
  }
  const { dispatch, observation, now, thresholds } = args;

  if (!isFiniteNumber(now)) {
    return undecidable(SEAT_LIVENESS_REASON.NOW_INVALID);
  }

  const maxNoOutputSeconds =
    thresholds === undefined || thresholds === null
      ? DEFAULT_MAX_NO_OUTPUT_SECONDS
      : thresholds.maxNoOutputSeconds;
  if (!isPositiveFiniteNumber(maxNoOutputSeconds)) {
    return undecidable(SEAT_LIVENESS_REASON.THRESHOLD_INVALID);
  }
  const thresholdMs = maxNoOutputSeconds * 1000;

  if (!isWellFormedDispatch(dispatch)) {
    return undecidable(SEAT_LIVENESS_REASON.DISPATCH_INVALID);
  }
  const { dispatchedAtMs } = dispatch;
  if (dispatchedAtMs > now) {
    return undecidable(SEAT_LIVENESS_REASON.DISPATCH_IN_FUTURE);
  }

  const problem = observationProblem(observation, dispatchedAtMs, now);
  if (problem) return undecidable(problem);
  const { lastOutputAt, reasonHint } = observation;

  // ★핵심 규칙(coder-task.md §2-3): "마지막으로 알려진 활동 시각" =
  // max(lastOutputAt, dispatchedAtMs). 배달 이전의 오래된 출력만 있고
  // 아직 새 출력이 없는 정상적인 초기 침묵을, 그 오래된 lastOutputAt
  // 때문에 무응답으로 오판하지 않기 위함이다.
  const referencePointMs = Math.max(lastOutputAt, dispatchedAtMs);
  const elapsedMs = now - referencePointMs;
  const pastThreshold = elapsedMs > thresholdMs;

  const details = {
    now,
    maxNoOutputSeconds,
    referencePointMs,
    elapsedMs,
    reasonHint: reasonHint === undefined ? null : reasonHint,
  };

  if (pastThreshold) {
    return {
      ok: true,
      verdict: SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE,
      reasonCode: SEAT_LIVENESS_REASON.NO_OUTPUT_PAST_THRESHOLD,
      details,
    };
  }

  return {
    ok: true,
    verdict: SEAT_LIVENESS_VERDICT.RESPONSIVE,
    reasonCode: SEAT_LIVENESS_REASON.WITHIN_THRESHOLD,
    details,
  };
}
