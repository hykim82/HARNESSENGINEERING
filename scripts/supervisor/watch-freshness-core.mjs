// HYK-185 gap#69 (coder-task.md §5-B) -- 생존 기록 신선도 판정 순수 함수
// 코어.
//
// 배경: "자기 생존을 알리지 못하는 감시자는 감시자가 아니다"(한용 문장,
// coder-task.md §5-E). watch-run.mjs가 실행마다 남기는 생존 기록
// (`last-run.json`)을 사람이 "이 감시자가 죽었는가"로 해석할 수 있게
// 닫힌 3상태(ALIVE/STALE/UNKNOWN)로 판정한다.
//
// S11 필수(coder-task.md §5-E 5가지 중 4번째 문단 그대로):
// "자기 생존을 알리지 못하는 감시자는 감시자가 아니다" -- 그래서 생존
// 기록과 이 판정(및 schedule-wire.mjs status)이 있다. 단 **"감시자의
// 감시자" 문제는 남는다**(이 코어를 부르는 프로세스 자체가 죽으면 이
// 판정도 실행되지 않는다 -- gap#63과 동일 축, 이 조각의 범위 밖).
//
// 비타협(coder-task.md §2, §3-d):
// - I/O 0 -- fs·child_process·네트워크 호출 0. 기록은 `lastRun` 인자로,
//   현재 시각은 `now` 인자로만 받는다.
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{verdict, reasonCode}`를 반환한다.
// - **기록 없음·형식 위반·미래 시각 = `UNKNOWN`**(§3-d, 직전 사이클
//   pledge-derive-core P1과 같은 축 -- "확인 못 함"을 "괜찮음"(ALIVE)으로
//   접지 않는다).
//
// 어휘 신규 도입 선언: `WATCH_FRESHNESS_VERDICT`·`WATCH_FRESHNESS_REASON`
// 둘 다 이 파일이 새로 만든다.

export const WATCH_FRESHNESS_VERDICT = Object.freeze({
  ALIVE: "ALIVE",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",
});

export const WATCH_FRESHNESS_REASON = Object.freeze({
  NOW_INVALID: "NOW_INVALID",
  STALE_AFTER_SECONDS_INVALID: "STALE_AFTER_SECONDS_INVALID",
  NO_RECORD: "NO_RECORD",
  RECORD_MALFORMED: "RECORD_MALFORMED",
  RECORDED_IN_FUTURE: "RECORDED_IN_FUTURE",
  WITHIN_STALE_WINDOW: "WITHIN_STALE_WINDOW",
  PAST_STALE_WINDOW: "PAST_STALE_WINDOW",
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function unknown(reasonCode) {
  return { verdict: WATCH_FRESHNESS_VERDICT.UNKNOWN, reasonCode };
}

// `lastRun`이 구조적으로 온전한지 -- `{ recordedAtMs: <finite number> }`
// 형태만 인정한다. 그 밖(문자열·null·필드 결손·타입 불일치)은 전부
// "형식 위반"으로 접는다(★mutation #4 표적 -- 이 검사를 제거하면 형식이
// 깨진 기록도 그대로 신선도 계산으로 새어나간다).
function isValidLastRun(lastRun) {
  if (!isPlainObject(lastRun)) return false;
  return isFiniteNumber(lastRun.recordedAtMs);
}

// judgeWatchFreshness({lastRun, now, staleAfterSeconds}) ->
// {verdict, reasonCode} -- ALIVE/STALE/UNKNOWN 닫힌 3상태.
export function judgeWatchFreshness(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return unknown(WATCH_FRESHNESS_REASON.RECORD_MALFORMED);
  }
  const { lastRun, now, staleAfterSeconds } = args;
  if (!isFiniteNumber(now)) return unknown(WATCH_FRESHNESS_REASON.NOW_INVALID);
  if (!isFiniteNumber(staleAfterSeconds) || staleAfterSeconds <= 0) {
    return unknown(WATCH_FRESHNESS_REASON.STALE_AFTER_SECONDS_INVALID);
  }
  if (lastRun === null || lastRun === undefined) {
    return unknown(WATCH_FRESHNESS_REASON.NO_RECORD);
  }
  if (!isValidLastRun(lastRun)) {
    return unknown(WATCH_FRESHNESS_REASON.RECORD_MALFORMED);
  }
  if (lastRun.recordedAtMs > now) {
    return unknown(WATCH_FRESHNESS_REASON.RECORDED_IN_FUTURE);
  }
  const ageSeconds = (now - lastRun.recordedAtMs) / 1000;
  if (ageSeconds <= staleAfterSeconds) {
    return {
      verdict: WATCH_FRESHNESS_VERDICT.ALIVE,
      reasonCode: WATCH_FRESHNESS_REASON.WITHIN_STALE_WINDOW,
    };
  }
  return {
    verdict: WATCH_FRESHNESS_VERDICT.STALE,
    reasonCode: WATCH_FRESHNESS_REASON.PAST_STALE_WINDOW,
  };
}
