// HYK-185-seat-idle-1 (coder-task.md) -- «배달이 없는데 오래 남아 있는
// 좌석»(유휴 방치) 판정 코어.
//
// 배경(coder-task.md §1): 좌석 무응답(seat-liveness, gap#76~#78) 축은
// «배달이 진행 중인 좌석»만 본다. 그런데 오늘 실측된 사고는 정반대다 --
// 배달이 이미 끝난(또는 애초에 없던) 좌석이 그대로 살아 남는 형태다.
// 메인 워크트리 좌석이 13.75시간, pm-lane 좌석이 5.33시간 방치됐는데도
// seat-liveness 축은 "판정 대상이 아니다"(NOT_APPLICABLE)만 냈다 --
// 기계 신호 0건, 발견은 사람의 눈이었다.
//
// 이 코어가 증명한다 / 증명하지 않는다 (S11 필수, coder-task.md §3-g
// 그대로, 최소 4개):
// 1. ★★**임계 기본값의 근거가 약하다** -- 방치로 확인된 실제 표본은
//    2건(5.33h·13.75h)뿐이고, 정상 라운드 간 유휴는 "분~1시간 단위"로만
//    관측됐다(정확한 상한 표본 없음). `DEFAULT_MAX_ABANDONED_SECONDS`는
//    그 두 표본 사이에 놓이도록 고른 값일 뿐, 그 구간 안 어디가 "맞는"
//    값인지는 이 표본들만으로 알 수 없다 -- gap#76 검토자 P2가 이미 지적한
//    "표본 2건은 임계의 독립 근거가 되지 못한다"와 동일한 한계.
// 2. ★**이 코어를 부르는 프로덕션 경로는 orch-stall-detect.mjs 결선
//    시점까지는 존재하지 않았다** -- 판정 함수만 있고 실제 좌석 조회·
//    주기 실행은 이 코어 밖(결선은 이 태스크의 §2-1-2에서 별도로 한다).
// 3. ★**화면 축의 한계** -- seat-liveness-core.mjs와 동일 원칙(coder-
//    task.md §2-3-2 비타협: "화면 문자열·컨텍스트 %로 판정하지 마라").
//    판정 축은 시간 하나뿐이다. 좌석 제목(title)으로 "누구 좌석인가"를
//    고르지 않는다 -- 좌석 마커 필터가 이미 하루 2회 오탐을 낸 전례가
//    있다(coder-task.md §2-3-2).
// 4. ★**감시자 자신이 멈추면 이 축도 함께 멈춘다** -- seat-liveness-
//    core.mjs와 동형의 한계(관측이 "주입"되어야만 판정한다).
//
// 비타협(coder-task.md §2-1-1, §2-3):
// - I/O 0 -- `orca` 호출 0·fs·child_process·네트워크 0. import 없음(이
//   파일 자신이 구조적으로 I/O 표면이 없다, seat-liveness-core.mjs와
//   동일 형태). 현재 시각도 `now` 인자로만 받는다(`Date.now()` 호출 0).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - `verdict`는 항상 `IDLE_OK`/`SUSPECTED_ABANDONED`/`UNDECIDABLE` 3상태
//   중 하나다 -- 제3의 값·`null`이 없다.
// - 관측 결손·형식위반·미래 시각은 전부 `UNDECIDABLE`로 닫히고
//   `SUSPECTED_ABANDONED`/`IDLE_OK`로 새지 않는다(§2-3 비타협 (a)).
//
// 판정 축: seat-liveness 축과 달리 이 코어는 **배달 기준선을 받지
// 않는다** -- "활성 배달이 있는지"는 이 코어의 관심사가 아니라 호출부
// (orch-stall-detect.mjs)의 몫이다(coder-task.md §2-3 (b) "두 축이 같은
// 좌석을 두 번 세지 않음"). 이 코어는 "이 좌석을 지금 판정해도 되는가"를
// 이미 전제로 받고, 오직 "좌석의 마지막 관측 출력 시각(lastOutputAt)이
// now로부터 얼마나 지났는가"만 본다. ORCH 자기 좌석도 이 축에서 제외하지
// 않는다(§2-3-2 (b) 그대로 -- 활성 배달이 없는 좌석은 누구의 좌석이든
// 동일하게 판정 대상이다).
//
// 어휘 신규 도입 선언(coder-task.md §2-1-1 "기존 SEAT_LIVENESS_* 어휘를
// 재사용해 뜻을 겹치게 만들지 마라"): `SEAT_IDLE_VERDICT`·
// `SEAT_IDLE_REASON` 둘 다 이 파일이 새로 만든다. seat-liveness 축은
// "배달 중인 좌석이 응답하는가"를 재고, 이 축은 "배달이 없는 좌석이
// 방치됐는가"를 잰다 -- 서로 다른 것을 재므로 어휘를 겹치지 않는다.
//
// 기본 임계값 근거(coder-task.md §2-2, dispatch-start-core.mjs/seat-
// liveness-core.mjs와 동일 형식): 오늘 실제로 관측된 두 표본 --
//   (a) 방치 표본 1: pm-lane 좌석, 약 5.33시간(19,188초).
//   (b) 방치 표본 2: 메인 워크트리 좌석, 약 13.75시간(49,500초).
//   (c) 정상 표본: 같은 사이클 동안 정상 라운드 간 유휴는 "분~1시간
//       단위"로 관측됐다(예: CODER 완료 18:56 -> REVIEW 완료 19:02, 6분).
// `DEFAULT_MAX_ABANDONED_SECONDS`(14400초=4시간)는 정상 표본 상한(1시간)과
// 방치 표본 하한(5.33시간) 사이에 놓이도록 골랐다. ★그러나 위 S11 한계 1
// 에서 밝힌 대로, 이 값은 "두 표본 사이 어딘가"라는 것만 보장할 뿐 그
// 자체의 운영 튜닝 근거는 약하다(정상 유휴의 실측 상한이 "1시간"이라는
// 것도 관측 표본 수가 많지 않다). 호출자는 언제든 다른 값을 넘겨 이
// 기본값을 무시할 수 있다(하드코딩이 아니라 "생략 시 낙하값").

export const SEAT_IDLE_VERDICT = Object.freeze({
  IDLE_OK: "IDLE_OK",
  SUSPECTED_ABANDONED: "SUSPECTED_ABANDONED",
  UNDECIDABLE: "UNDECIDABLE",
});

export const SEAT_IDLE_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  NOW_INVALID: "NOW_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  OBSERVATION_INVALID: "OBSERVATION_INVALID",
  OBSERVATION_MALFORMED: "OBSERVATION_MALFORMED",
  OBSERVATION_IN_FUTURE: "OBSERVATION_IN_FUTURE",
  NO_OUTPUT_PAST_THRESHOLD: "NO_OUTPUT_PAST_THRESHOLD",
  WITHIN_THRESHOLD: "WITHIN_THRESHOLD",
});

export const DEFAULT_MAX_ABANDONED_SECONDS = 14400; // 4시간, 근거는 위 헤더 주석.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isPositiveFiniteNumber(v) {
  return isFiniteNumber(v) && v > 0;
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: SEAT_IDLE_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

// ⚠️판정에 쓰는 필드는 `observedAtMs`·`lastOutputAt` 둘뿐이다.
// `reasonHint`(화면 문자열 사유 후보)가 실려 와도 이 함수는 그 값을
// 읽어 구조를 검사하지 않는다 -- 존재 여부·형식 무관, 오직 통과시켜
// 호출부에서 details에 그대로 옮길 뿐이다(seat-liveness-core.mjs와
// 동일 원칙).
function isWellFormedObservation(entry) {
  if (!isPlainObject(entry)) return false;
  if (!isFiniteNumber(entry.observedAtMs)) return false;
  if (!isFiniteNumber(entry.lastOutputAt)) return false;
  // 출력 시각이 그 출력을 관측한 시각보다 나중일 수 없다(구조적 모순).
  return entry.lastOutputAt <= entry.observedAtMs;
}

function observationProblem(observation, now) {
  if (!isPlainObject(observation)) {
    return SEAT_IDLE_REASON.OBSERVATION_INVALID;
  }
  if (!isWellFormedObservation(observation)) {
    return SEAT_IDLE_REASON.OBSERVATION_MALFORMED;
  }
  if (observation.observedAtMs > now) {
    return SEAT_IDLE_REASON.OBSERVATION_IN_FUTURE;
  }
  return null;
}

// judgeSeatIdle({observation, now, thresholds}) ->
// {ok, verdict, reasonCode, details}
//
// - `observation` = 좌석의 가장 최근 관측 하나 -- 최소 `observedAtMs`·
//   `lastOutputAt`(둘 다 epoch ms number). `reasonHint`(선택, string)가
//   실려 오면 판정에는 쓰지 않고 `details.reasonHint`로만 되돌린다.
// - `now` = 판정 시각(epoch ms, 인자로만 받는다).
// - `thresholds.maxAbandonedSeconds` = 생략 시
//   `DEFAULT_MAX_ABANDONED_SECONDS`.
//
// ★이 코어는 "활성 배달이 있는지"를 모른다 -- 호출부가 그 판정(§2-3
// (b))을 이미 마치고 "이 좌석은 이 축의 대상이다"라는 것을 전제로 이
// 함수를 부른다.
export function judgeSeatIdle(args) {
  if (!isPlainObject(args)) {
    return undecidable(SEAT_IDLE_REASON.ARGS_INVALID);
  }
  const { observation, now, thresholds } = args;

  if (!isFiniteNumber(now)) {
    return undecidable(SEAT_IDLE_REASON.NOW_INVALID);
  }

  const maxAbandonedSeconds =
    thresholds === undefined || thresholds === null
      ? DEFAULT_MAX_ABANDONED_SECONDS
      : thresholds.maxAbandonedSeconds;
  if (!isPositiveFiniteNumber(maxAbandonedSeconds)) {
    return undecidable(SEAT_IDLE_REASON.THRESHOLD_INVALID);
  }
  const thresholdMs = maxAbandonedSeconds * 1000;

  const problem = observationProblem(observation, now);
  if (problem) return undecidable(problem);
  const { lastOutputAt, reasonHint } = observation;

  const elapsedMs = now - lastOutputAt;
  const pastThreshold = elapsedMs > thresholdMs;

  const details = {
    now,
    maxAbandonedSeconds,
    referencePointMs: lastOutputAt,
    elapsedMs,
    reasonHint: reasonHint === undefined ? null : reasonHint,
  };

  if (pastThreshold) {
    return {
      ok: true,
      verdict: SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED,
      reasonCode: SEAT_IDLE_REASON.NO_OUTPUT_PAST_THRESHOLD,
      details,
    };
  }

  return {
    ok: true,
    verdict: SEAT_IDLE_VERDICT.IDLE_OK,
    reasonCode: SEAT_IDLE_REASON.WITHIN_THRESHOLD,
    details,
  };
}
