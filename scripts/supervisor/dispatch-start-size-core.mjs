// HYK-272/HYK-270-stall-visible-2 (coder-task.md §3, §4) -- 배달 후 "착수"
// 판정 순수 코어. §3(HYK-274 선행 조사) 실측 결론을 그대로 근거로 쓴다:
//
// - `orca terminal read`(화면 스냅샷)는 이 좌석 자신이 연속으로 작업 중일
//   때(§3-1 조건 ⓒ) 특정 출력이 **76초가 지나도록도 반영되지 않는** 경우를
//   이번 조각에서 직접 실측했다(자기 마커 프로브, coder.md §관측 지연
//   실측 참조) -- 즉 화면은 "몇 초 지연" 수준이 아니라 **무한정 지연될 수
//   있다.** ⇒ 화면 문자열을 이 축의 판정 근거로 쓰지 않는다.
// - ORCH의 2026-08-16 21:18 실측: 세션 기록 파일은 **크기는 계속 느는데
//   `mtime`은 갱신 안 되는 구간**이 있었다(214KB→5.1MB, mtime 은 그대로).
//   ⇒ **mtime이 아니라 "크기"** 를 진행 신호로 쓴다.
// - ORCH가 21시 승인창 정지 사고에서 **실제로 이 방법(크기 1분마다 재서
//   3분 무증가 = 멈춤)으로 잡아냈다** -- 화면 밖 근거 중 이미 실전에서
//   검증된 것을 그대로 택했다.
//
// 이 코어는 "두 관측 사이에 세션 기록 파일 총 바이트 수가 늘었는가"만
// 본다 -- dispatch-start-core.mjs(터미널 lastOutputAt 축)와 판정 형태는
// 비슷하지만 관측의 출처가 다르므로(화면이 아니라 파일 크기) 별도 파일로
// 둔다(그 파일의 헤더 주석이 "좌석 lastOutputAt"에 강하게 결부돼 있어
// 필드 이름만 바꿔 재사용하면 그 문서화가 거짓이 된다).
//
// 비타협: I/O 0, throw 0 -- 이 코어는 관측 배열을 받기만 한다. 실제 파일
// 크기 수집은 dispatch-start-size-adapter.mjs(이 코어 밖)가 한다.

export const DISPATCH_START_SIZE_VERDICT = Object.freeze({
  STARTED: "STARTED",
  NOT_STARTED: "NOT_STARTED",
  UNDECIDABLE: "UNDECIDABLE",
});

export const DISPATCH_START_SIZE_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  NOW_INVALID: "NOW_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  OBSERVATIONS_INVALID: "OBSERVATIONS_INVALID",
  OBSERVATION_MALFORMED: "OBSERVATION_MALFORMED",
  OBSERVATION_IN_FUTURE: "OBSERVATION_IN_FUTURE",
  TOO_FEW_OBSERVATIONS: "TOO_FEW_OBSERVATIONS",
  GREW: "GREW",
  NO_GROWTH_PAST_TIMEOUT: "NO_GROWTH_PAST_TIMEOUT",
});

// 근거: §4-2 사례2에서 ORCH가 실전에 쓴 값 그대로(1분 간격 폴링, 3분
// 무증가 = 멈춤). 호출자가 언제든 다른 값으로 덮어쓸 수 있다.
export const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeInt(v) {
  return isFiniteNumber(v) && v >= 0 && Number.isInteger(v);
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: DISPATCH_START_SIZE_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

function isWellFormedObservation(entry) {
  if (!isPlainObject(entry)) return false;
  if (!isFiniteNumber(entry.observedAtMs)) return false;
  return isNonNegativeInt(entry.totalBytes);
}

// judgeDispatchStartBySize({observations, dispatchedAtMs, now, timeoutMs}) ->
// {ok, verdict, reasonCode, details}
//
// - `observations` = [{observedAtMs, totalBytes}], 시간순 무관(정렬함).
// - 서로 다른 두 관측 사이에 `totalBytes`가 늘면 STARTED(관측 순서는
//   `observedAtMs` 기준으로 정렬 -- dispatch-start-core.mjs의 진행 판정과
//   동일한 원칙: "감소만 있고 증가가 없으면 진행 아님").
// - `now - dispatchedAtMs > timeoutMs`인데 증가가 한 번도 없으면
//   NOT_STARTED. 아직 타임아웃 전이면(정상적으로 아직 이를 수 있음)
//   UNDECIDABLE(성급하게 NOT_STARTED로 단정하지 않는다).
// 관측 배열 자체 + 각 항목의 구조·미래시각을 검사한다(judgeDispatchStartBySize
// 에서 분리 -- eslint complexity 상한 준수, 로직은 그대로). 문제가 있으면
// 그 사유 코드를, 전부 온전하면 `null`을 돌려준다.
function firstObservationProblem(observations, now) {
  if (!Array.isArray(observations)) {
    return DISPATCH_START_SIZE_REASON.OBSERVATIONS_INVALID;
  }
  for (const entry of observations) {
    if (!isWellFormedObservation(entry)) {
      return DISPATCH_START_SIZE_REASON.OBSERVATION_MALFORMED;
    }
    if (entry.observedAtMs > now) {
      return DISPATCH_START_SIZE_REASON.OBSERVATION_IN_FUTURE;
    }
  }
  return null;
}

// 서로 다른 두 관측 사이에 `totalBytes`가 늘었는가(dispatch-start-core.mjs
// 의 detectProgression과 동일 원칙 -- 정렬 후 지금까지의 최소값보다 큰
// 값이 한 번이라도 나오면 전진).
function detectSizeGrowth(sortedObservations) {
  if (sortedObservations.length < 2) return false;
  let runningMin = sortedObservations[0].totalBytes;
  for (let i = 1; i < sortedObservations.length; i++) {
    if (sortedObservations[i].totalBytes > runningMin) return true;
    if (sortedObservations[i].totalBytes < runningMin) {
      runningMin = sortedObservations[i].totalBytes;
    }
  }
  return false;
}

function resolveTimeout(timeoutMs) {
  return timeoutMs === undefined || timeoutMs === null
    ? DEFAULT_TIMEOUT_MS
    : timeoutMs;
}

export function judgeDispatchStartBySize(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      verdict: DISPATCH_START_SIZE_VERDICT.UNDECIDABLE,
      reasonCode: DISPATCH_START_SIZE_REASON.ARGS_INVALID,
      details: null,
    };
  }
  const { observations, dispatchedAtMs, now, timeoutMs } = args;
  if (!isFiniteNumber(now))
    return undecidable(DISPATCH_START_SIZE_REASON.NOW_INVALID);
  if (!isFiniteNumber(dispatchedAtMs))
    return undecidable(DISPATCH_START_SIZE_REASON.ARGS_INVALID);
  const timeout = resolveTimeout(timeoutMs);
  if (!isFiniteNumber(timeout) || timeout <= 0) {
    return undecidable(DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
  }
  const observationProblem = firstObservationProblem(observations, now);
  if (observationProblem) return undecidable(observationProblem);

  const sorted = [...observations].sort(
    (a, b) => a.observedAtMs - b.observedAtMs,
  );
  if (detectSizeGrowth(sorted)) {
    return {
      ok: true,
      verdict: DISPATCH_START_SIZE_VERDICT.STARTED,
      reasonCode: DISPATCH_START_SIZE_REASON.GREW,
      details: { observationCount: sorted.length },
    };
  }

  const pastTimeout = now - dispatchedAtMs > timeout;
  if (!pastTimeout) {
    return undecidable(DISPATCH_START_SIZE_REASON.TOO_FEW_OBSERVATIONS);
  }
  return {
    ok: true,
    verdict: DISPATCH_START_SIZE_VERDICT.NOT_STARTED,
    reasonCode: DISPATCH_START_SIZE_REASON.NO_GROWTH_PAST_TIMEOUT,
    details: { observationCount: sorted.length, timeoutMs: timeout },
  };
}
