// HYK-185 startcheck (coder-task.md §1) -- 배달 직후 "시작됐는가" 순수 판정
// 코어.
//
// 배경(coder-task.md §1): `dispatch --inject`가 `injected:true`를 반환해도
// 워커가 시작되지 않고 입력창에 붙여넣기만 된 채 제출(Enter)이 안 되는
// 사고가 오늘 하루에만 7회 났다. 가장 비쌌던 사례(2026-08-02) -- 배달
// 11:56:32에 `injected:true` -> 좌석 마지막 출력이 11:56:33에서 멈춘 채
// 83분 무진행. `watch-result`는 결과 파일만 보므로 구조적으로 못 잡았고
// 발견은 매번 사람의 눈이었다. 이 파일은 그 "시작됐는가"를 기계가 판정
// 하게 만든다.
//
// 이 코어가 증명한다 / 증명하지 않는다 (S11 필수, coder-task.md §3-h
// 그대로):
// - **관측은 호출자가 준다** -- 이 코어는 좌석을 조회하지 않는다. 실제
//   조회·재배달·제출 신호 전송은 이 코어 밖이며 A-5(승인 밖)다
//   (coder-task.md §2-4).
// - **응답값(`injected:true`)은 시작의 근거가 아니다** -- `dispatch`
//   객체에 그런 필드가 실려 와도(예: `dispatch.injected`) 이 코어는 그
//   필드를 읽지도 판정에 쓰지도 않는다. 판정 근거는 오직 `dispatchedAtMs`
//   (배달 시각)와 `observations`(좌석 관측 배열)뿐이다. "배달 이후에
//   출력이 있었다"만 보면 83분 사고를 놓친다 -- 붙여넣기 메아리가 배달
//   1초 뒤에 찍히고 그대로 멈췄기 때문이다. 그래서 `lastOutputAt`을
//   `dispatchedAtMs`와 비교하지 않는다 -- 오직 **서로 다른 두 관측 사이의
//   `lastOutputAt` 전진**만 본다.
// - **화면 문자열·컨텍스트 %를 쓰지 않는다** -- 관측 항목에 그런 필드가
//   실려 와도(예: `preview`/`title`) 이 코어는 읽지 않는다. 판정 근거는
//   안정 값(시각·식별자)뿐이다.
// - ★gap 표 등재는 이번 사이클에서 하지 않았다 -- 동시 2개 금지 규칙
//   때문이며(gap#73/PR #93 병합 대기), #93 병합 후 별도.
//
// 비타협(coder-task.md §2):
// - I/O 0 -- `orca` 호출 0(명령 문자열 조립도 0)·네트워크 0·파일 접근 0.
//   import 없음(이 파일 자신이 구조적으로 I/O 표면이 없다). 현재 시각도
//   `now` 인자로만 받는다(`Date.now()`/`new Date()`(인자 없이) 호출 0).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - `verdict`는 항상 `STARTED`/`NOT_STARTED`/`UNDECIDABLE` 3상태 중
//   하나다 -- 제3의 값·`null`이 없다.
// - 관측 결손·형식위반·순서 역전(관측이 배달보다 이르다)·미래 시각은
//   전부 `UNDECIDABLE`로 닫히고 `STARTED`로 새지 않는다.
//
// 실측 필드 표(coder-task.md §6-1, 저장소에 실재하는 관례만 채택 --
// 이 표에 없는 필드는 계약에 넣지 않는다):
// - `dispatch.dispatchId` -- `orca orchestration dispatch-show --json`
//   raw `result.dispatch.id`(string) 정규화(seat-proof-contract-v1.mjs
//   DISPATCH_SHOW_RAW_FIELD_TYPES.id, dispatch-correlation-adapter.mjs
//   `dispatch.id` 실측). 이 코어는 raw JSON을 직접 안 보고, 호출자가
//   이미 뽑아 넘긴 문자열만 받는다.
// - `dispatch.dispatchedAtMs` -- 같은 raw 응답의 `dispatched_at`(string,
//   ISO)을 호출자가 epoch ms로 파싱해 넘긴 값(이 코어는 날짜 문자열을
//   파싱하지 않는다 -- 파싱은 I/O 인접 어댑터 몫, S6 경계).
// - `observations[].observedAtMs` -- 그 관측을 호출자가 수행한 시각
//   (observer-store.mjs의 `observedAtMs` 관례 재사용, epoch ms).
// - `observations[].lastOutputAt` -- `orca terminal show --json`
//   `result.terminal.lastOutputAt`(number, epoch ms -- seat-proof-
//   contract-v1.mjs TERMINAL_SHOW_RAW_FIELD_TYPES.lastOutputAt 실측)을
//   그대로 옮긴 값. ⚠️`preview`/`title`은 이 표에 없다 -- 의도적으로
//   빠져 있다(§2-2, terminal-show-adapter.mjs S8과 동일 근거).
// - `thresholds.minNoProgressSeconds` -- 하드코딩 금지(§2 비타협),
//   생략 시 `DEFAULT_MIN_NO_PROGRESS_SECONDS`(아래 근거).
//
// 어휘 신규 도입 선언: `DISPATCH_START_VERDICT`·`DISPATCH_START_REASON`
// 둘 다 이 파일이 새로 만든다.
//
// 기본 임계값 근거(§5-B 관례와 동일 형식 "기본값을 둘 거면 헤더에 근거를
// 적어라"): 붙여넣기 메아리는 배달 1초 뒤에 찍히므로 그 직후 짧은 구간은
// 정상적으로 아직 진행 신호가 없을 수 있다(모델 기동·도구 초기화 지연).
// `DEFAULT_MIN_NO_PROGRESS_SECONDS`(120초=2분)는 그 정상 지연을 판정
// 보류(UNDECIDABLE)로 흡수하면서도, 오늘 실제 사고(83분)보다는 훨씬
// 짧게 잡아 그 사고 형태를 놓치지 않는다. 호출자는 언제든 다른 값을
// 넘겨 이 기본값을 무시할 수 있다(하드코딩이 아니라 "생략 시 낙하값").
// 이 값 자체의 운영 튜닝(실제로 몇 초가 맞는지)은 이 조각의 범위 밖이다
// (판정만 하고 아직 아무도 이 코어를 주기적으로 부르지 않는다, §4).

export const DISPATCH_START_VERDICT = Object.freeze({
  STARTED: "STARTED",
  NOT_STARTED: "NOT_STARTED",
  UNDECIDABLE: "UNDECIDABLE",
});

export const DISPATCH_START_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  DISPATCH_INVALID: "DISPATCH_INVALID",
  NOW_INVALID: "NOW_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  DISPATCH_IN_FUTURE: "DISPATCH_IN_FUTURE",
  OBSERVATIONS_INVALID: "OBSERVATIONS_INVALID",
  OBSERVATION_MALFORMED: "OBSERVATION_MALFORMED",
  OBSERVATION_BEFORE_DISPATCH: "OBSERVATION_BEFORE_DISPATCH",
  OBSERVATION_IN_FUTURE: "OBSERVATION_IN_FUTURE",
  NO_OBSERVATIONS_TOO_EARLY: "NO_OBSERVATIONS_TOO_EARLY",
  NO_OBSERVATIONS_PAST_THRESHOLD: "NO_OBSERVATIONS_PAST_THRESHOLD",
  SINGLE_OBSERVATION_TOO_EARLY: "SINGLE_OBSERVATION_TOO_EARLY",
  SINGLE_OBSERVATION_PAST_THRESHOLD: "SINGLE_OBSERVATION_PAST_THRESHOLD",
  PROGRESSED_BETWEEN_OBSERVATIONS: "PROGRESSED_BETWEEN_OBSERVATIONS",
  NO_PROGRESS_TOO_EARLY: "NO_PROGRESS_TOO_EARLY",
  NO_PROGRESS_PAST_THRESHOLD: "NO_PROGRESS_PAST_THRESHOLD",
});

export const DEFAULT_MIN_NO_PROGRESS_SECONDS = 120;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
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
    verdict: DISPATCH_START_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

function isWellFormedDispatch(dispatch) {
  if (!isPlainObject(dispatch)) return false;
  if (!isNonEmptyString(dispatch.dispatchId)) return false;
  return isFiniteNumber(dispatch.dispatchedAtMs);
}

// 관측 항목 구조 검사. ⚠️`preview`/`title`처럼 이 계약에 없는 필드가
// 실려 와도 읽지 않는다(§2-2) -- 여기서 보는 것은 오직 두 필드다.
function isWellFormedObservation(entry) {
  if (!isPlainObject(entry)) return false;
  if (!isFiniteNumber(entry.observedAtMs)) return false;
  if (!isFiniteNumber(entry.lastOutputAt)) return false;
  // 출력 시각이 그 출력을 관측한 시각보다 나중일 수 없다(구조적 모순).
  return entry.lastOutputAt <= entry.observedAtMs;
}

// 관측 배열 자체 + 각 항목의 구조·순서·미래시각을 검사한다. 문제가
// 있으면 그 사유 코드를, 전부 온전하면 `null`을 돌려준다(§3-e fail-closed
// -- 하나라도 어긋나면 전체 판정이 UNDECIDABLE로 닫힌다, 부분 필터링
// 없음).
function firstObservationProblem(observations, dispatchedAtMs, now) {
  if (!Array.isArray(observations)) {
    return DISPATCH_START_REASON.OBSERVATIONS_INVALID;
  }
  for (const entry of observations) {
    if (!isWellFormedObservation(entry)) {
      return DISPATCH_START_REASON.OBSERVATION_MALFORMED;
    }
    if (entry.observedAtMs > now) {
      return DISPATCH_START_REASON.OBSERVATION_IN_FUTURE;
    }
    if (entry.observedAtMs < dispatchedAtMs) {
      return DISPATCH_START_REASON.OBSERVATION_BEFORE_DISPATCH;
    }
  }
  return null;
}

// ★핵심 판정 규칙(coder-task.md §5 그대로): 서로 다른 두 관측 사이에
// "마지막 출력 시각"이 전진했는가(오름차순 정렬 후 지금까지의 최소값보다
// 큰 값이 한 번이라도 나오면 전진). 배달 직후 한 번 튄 출력(붙여넣기
// 메아리)만으로는 이 비교 자체가 성립하지 않는다 -- 관측이 하나뿐이면
// 비교할 두 번째 점이 없다.
function detectProgression(observations) {
  const sorted = [...observations].sort(
    (a, b) => a.observedAtMs - b.observedAtMs,
  );
  if (sorted.length < 2) return { comparable: false, progressed: false };
  let runningMin = sorted[0].lastOutputAt;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].lastOutputAt > runningMin) {
      return { comparable: true, progressed: true };
    }
    if (sorted[i].lastOutputAt < runningMin) {
      runningMin = sorted[i].lastOutputAt;
    }
  }
  return { comparable: true, progressed: false };
}

function tooFewObservationsReason(count, pastThreshold) {
  if (count === 0) {
    return pastThreshold
      ? DISPATCH_START_REASON.NO_OBSERVATIONS_PAST_THRESHOLD
      : DISPATCH_START_REASON.NO_OBSERVATIONS_TOO_EARLY;
  }
  return pastThreshold
    ? DISPATCH_START_REASON.SINGLE_OBSERVATION_PAST_THRESHOLD
    : DISPATCH_START_REASON.SINGLE_OBSERVATION_TOO_EARLY;
}

// judgeDispatchStart({dispatch, observations, now, thresholds}) ->
// {ok, verdict, reasonCode, details}
//
// - `dispatch` = 배달 사실 -- 최소 `dispatchId`(string)·`dispatchedAtMs`
//   (epoch ms number). 그 밖 필드(예: `injected`)가 실려 와도 기록용일
//   뿐 판정에 쓰지 않는다.
// - `observations` = 좌석 관측 배열. 각 항목 최소 `observedAtMs`·
//   `lastOutputAt`(둘 다 epoch ms number).
// - `now` = 판정 시각(epoch ms, 인자로만 받는다).
// - `thresholds.minNoProgressSeconds` = 생략 시
//   `DEFAULT_MIN_NO_PROGRESS_SECONDS`.
// - `details.perObservation`은 없다 -- 이 판정은 약속별 집계가 아니라
//   좌석 하나의 단일 판정이다(orch-progress-core.mjs와 다른 형태,
//   문제 자체가 다르다: 여기는 "이 배달이 시작됐는가" 하나뿐).
export function judgeDispatchStart(args) {
  if (!isPlainObject(args)) {
    return undecidable(DISPATCH_START_REASON.ARGS_INVALID);
  }
  const { dispatch, observations, now, thresholds } = args;

  if (!isFiniteNumber(now)) {
    return undecidable(DISPATCH_START_REASON.NOW_INVALID);
  }

  const minNoProgressSeconds =
    thresholds === undefined || thresholds === null
      ? DEFAULT_MIN_NO_PROGRESS_SECONDS
      : thresholds.minNoProgressSeconds;
  if (!isPositiveFiniteNumber(minNoProgressSeconds)) {
    return undecidable(DISPATCH_START_REASON.THRESHOLD_INVALID);
  }
  const thresholdMs = minNoProgressSeconds * 1000;

  if (!isWellFormedDispatch(dispatch)) {
    return undecidable(DISPATCH_START_REASON.DISPATCH_INVALID);
  }
  const { dispatchedAtMs } = dispatch;
  if (dispatchedAtMs > now) {
    return undecidable(DISPATCH_START_REASON.DISPATCH_IN_FUTURE);
  }

  const observationProblem = firstObservationProblem(
    observations,
    dispatchedAtMs,
    now,
  );
  if (observationProblem) return undecidable(observationProblem);

  const pastThreshold = now - dispatchedAtMs > thresholdMs;
  const { comparable, progressed } = detectProgression(observations);

  if (!comparable) {
    return undecidable(
      tooFewObservationsReason(observations.length, pastThreshold),
    );
  }

  if (progressed) {
    return {
      ok: true,
      verdict: DISPATCH_START_VERDICT.STARTED,
      reasonCode: DISPATCH_START_REASON.PROGRESSED_BETWEEN_OBSERVATIONS,
      details: { now, minNoProgressSeconds },
    };
  }

  // 전진이 없다. 임계 이내(아직 이른 관측)면 NOT_STARTED로 단정하지
  // 않고 판정을 보류한다(coder-task.md §3-f) -- 정상적으로 막 시작된
  // 좌석을 오탐하지 않기 위해서다.
  if (!pastThreshold) {
    return undecidable(DISPATCH_START_REASON.NO_PROGRESS_TOO_EARLY);
  }

  return {
    ok: true,
    verdict: DISPATCH_START_VERDICT.NOT_STARTED,
    reasonCode: DISPATCH_START_REASON.NO_PROGRESS_PAST_THRESHOLD,
    details: { now, minNoProgressSeconds },
  };
}
