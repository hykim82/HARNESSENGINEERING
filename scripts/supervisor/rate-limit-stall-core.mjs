// HYK-270 (coder-task.md §5) -- 한도(rate limit)로 멈춘 좌석의 "회복 예정
// 시각"을 기계 기록으로 남기기 위한 순수 판정 코어.
//
// 배경(coder-task.md §1): 2026-08-16 좌석이 한도로 멈췄다가 회복됐는데도
// 아무도 깨우지 않아 11시간 + 3시간20분이 낭비됐다. 좌석 상태줄의 한도
// 수치는 "마지막 요청 시점" 값이라 낡는다(coder-task.md §5 실측) --
// 화면만 봐서는 회복을 알 수 없다.
//
// 이 코어가 증명한다 / 증명하지 않는다:
// - **관측은 호출자가 준다** -- 이 코어는 세션 로그를 읽지 않는다. 실제
//   jsonl 스캔은 rate-limit-stall-adapter.mjs(이 코어 밖, I/O 인접)가
//   한다.
// - **회복 시각은 추정값이다** -- `estimatedRecoveryAtMs`는 알려진 한도
//   창(`DEFAULT_LIMIT_WINDOW_MS`)을 `hitAtMs`에 더한 값일 뿐, 실제 계정
//   한도 창을 정확히 반영한다고 보장하지 않는다(§5 "권위 있는 잔량 표면
//   부재" 확정 사실, budget-core.mjs와 동일 한계). 호출자는 이 추정값이
//   추정임을 사람이 읽는 출력에 명시해야 한다.
// - **자동 재개를 만들지 않는다** -- 이 코어의 반환값에는 재개 신호가
//   없다. 판정만 한다(coder-task.md §5 비타협 "자동 재개 발송 0").
//
// 비타협(coder-task.md §2 계열 관례 재사용):
// - I/O 0 -- import 없음. 현재 시각도 `now` 인자로만 받는다.
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - "판정 불가"를 "정상"으로 접지 않는다 -- 관측 결손·형식위반·미래
//   시각은 전부 UNDECIDABLE로 닫히고 NOT_APPLICABLE/RECOVERED로 새지
//   않는다.

export const RATE_LIMIT_STALL_VERDICT = Object.freeze({
  // 한도에 걸린 흔적 자체가 없다(정상).
  NOT_APPLICABLE: "NOT_APPLICABLE",
  // 한도에 걸렸지만 그 뒤 활동(성공 응답)이 관측됐다 -- 이미 회복됨.
  RECOVERED: "RECOVERED",
  // 한도에 걸렸고 그 뒤 활동이 전혀 관측되지 않았다 -- 지금 정지 상태.
  STALLED_ON_LIMIT: "STALLED_ON_LIMIT",
  UNDECIDABLE: "UNDECIDABLE",
});

export const RATE_LIMIT_STALL_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  OBSERVATION_INVALID: "OBSERVATION_INVALID",
  NOW_INVALID: "NOW_INVALID",
  HIT_IN_FUTURE: "HIT_IN_FUTURE",
  RECOVERED_BEFORE_HIT: "RECOVERED_BEFORE_HIT",
  NO_HIT_OBSERVED: "NO_HIT_OBSERVED",
  RECOVERY_OBSERVED: "RECOVERY_OBSERVED",
  NO_RECOVERY_OBSERVED: "NO_RECOVERY_OBSERVED",
});

// 근거(§5 최소안 주석과 동일 형식 "기본값을 둘 거면 헤더에 근거를
// 적어라"): Claude 계정의 일반적인 롤링 한도 창은 5시간이다(공개 문서
// 관례). 권위 있는 값이 아니므로 호출자는 이 상수를 다른 값으로 언제든
// 덮어쓸 수 있다(하드코딩이 아니라 "생략 시 낙하값").
export const DEFAULT_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: RATE_LIMIT_STALL_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

// hitAtMs가 확정된 뒤 회복 관측 하나를 판정한다(judgeRateLimitStall에서
// 분리 -- eslint complexity 상한 준수, 로직은 그대로).
function judgeRecovery({ hitAtMs, recoveredAtMs, now }) {
  if (!isFiniteNumber(recoveredAtMs) || recoveredAtMs > now) {
    return undecidable(RATE_LIMIT_STALL_REASON.OBSERVATION_INVALID);
  }
  if (recoveredAtMs < hitAtMs) {
    return undecidable(RATE_LIMIT_STALL_REASON.RECOVERED_BEFORE_HIT);
  }
  return {
    ok: true,
    verdict: RATE_LIMIT_STALL_VERDICT.RECOVERED,
    reasonCode: RATE_LIMIT_STALL_REASON.RECOVERY_OBSERVED,
    details: { hitAtMs, recoveredAtMs },
  };
}

function stalled(hitAtMs, windowMs) {
  return {
    ok: true,
    verdict: RATE_LIMIT_STALL_VERDICT.STALLED_ON_LIMIT,
    reasonCode: RATE_LIMIT_STALL_REASON.NO_RECOVERY_OBSERVED,
    details: {
      hitAtMs,
      estimatedRecoveryAtMs: hitAtMs + windowMs,
      limitWindowMs: windowMs,
    },
  };
}

// hitAtMs가 유효하다고 확인된 뒤의 나머지 판정(회복 유무 분기)을 모은다.
function judgeAfterHitValidated({ hitAtMs, recoveredAtMs, now, windowMs }) {
  const hasRecovery = recoveredAtMs !== null && recoveredAtMs !== undefined;
  if (!hasRecovery) return stalled(hitAtMs, windowMs);
  return judgeRecovery({ hitAtMs, recoveredAtMs, now });
}

// judgeRateLimitStall({observation, now, limitWindowMs}) ->
// {ok, verdict, reasonCode, details}
//
// - `observation.hitAtMs` -- 가장 최근 한도-도달 이벤트의 epoch ms.
//   `null`/`undefined`면 "한도에 걸린 흔적 없음"(NOT_APPLICABLE).
// - `observation.recoveredAtMs` -- `hitAtMs` 이후 관측된 첫 정상 활동의
//   epoch ms. 아직 없으면 `null`/`undefined`.
// - `limitWindowMs` -- 생략 시 `DEFAULT_LIMIT_WINDOW_MS`.
export function judgeRateLimitStall(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      verdict: RATE_LIMIT_STALL_VERDICT.UNDECIDABLE,
      reasonCode: RATE_LIMIT_STALL_REASON.ARGS_INVALID,
      details: null,
    };
  }
  const { observation, now, limitWindowMs } = args;
  if (!isFiniteNumber(now)) {
    return undecidable(RATE_LIMIT_STALL_REASON.NOW_INVALID);
  }
  const windowMs =
    limitWindowMs === undefined || limitWindowMs === null
      ? DEFAULT_LIMIT_WINDOW_MS
      : limitWindowMs;
  if (!isFiniteNumber(windowMs) || windowMs <= 0) {
    return undecidable(RATE_LIMIT_STALL_REASON.OBSERVATION_INVALID);
  }
  if (!isPlainObject(observation)) {
    return undecidable(RATE_LIMIT_STALL_REASON.OBSERVATION_INVALID);
  }

  const { hitAtMs, recoveredAtMs } = observation;

  if (hitAtMs === null || hitAtMs === undefined) {
    return {
      ok: true,
      verdict: RATE_LIMIT_STALL_VERDICT.NOT_APPLICABLE,
      reasonCode: RATE_LIMIT_STALL_REASON.NO_HIT_OBSERVED,
      details: null,
    };
  }
  if (!isFiniteNumber(hitAtMs)) {
    return undecidable(RATE_LIMIT_STALL_REASON.OBSERVATION_INVALID);
  }
  if (hitAtMs > now) {
    return undecidable(RATE_LIMIT_STALL_REASON.HIT_IN_FUTURE);
  }

  return judgeAfterHitValidated({ hitAtMs, recoveredAtMs, now, windowMs });
}
