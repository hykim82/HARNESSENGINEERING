// HYK-285-wake-1 (coder-task.md §3-A) -- «워커가 끝났는데 조율자가 안
// 깨어난다»의 남은 절반: 미소비(unconsumed) 축이 연속으로 이상을 내면
// 좌석 밖 기계가 조율자를 깨워야 하는지 판정하는 순수 코어.
//
// 이 저장소의 코어 관례(unconsumed-core.mjs 헤더가 정본)를 그대로 따른다:
// - I/O 0 -- import 없음. `Date.now()`/인자 없는 `new Date()` 호출 0 --
//   현재 시각은 `nowMs` 인자로만 받는다.
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - 조용히 "정상"으로 접지 않는다 -- 관측이 부족하거나 모순이면
//   `UNDECIDABLE`이다(`HOLD`로 새지 않는다).
//
// 기본값 근거(§3-A 요구):
// - `sustainTicks = 2`: watch-run.mjs는 15분 주기로 돈다(coder-task.md
//   §1 실측). 연속 2 tick(최소 15분 지속)을 요구해, 단발성 오탐(한 tick
//   에서만 SUSPECTED_UNCONSUMED가 찍히고 다음 tick에서 바로 CONSUMED로
//   돌아오는 경우, hyk285-watch-sample-2026-08-18.log 표본에 반복 관측됨
//   -- §3-E 실측 참조)이 각성을 유발하지 않게 한다. 1이면 그 흔한 단발
//   진동에도 매번 깨우게 되고, 3 이상이면 진짜 미소비 사고를 45분 이상
//   늦게 잡는다(unconsumed-core.mjs의 임계 900초=15분과 겹치는 지연).
// - `cooldownMs = 3600000`(1시간): 각성 문안이 좌석에 반복 주입되는 것을
//   막는다 -- 미소비 상태가 몇 시간 지속돼도 매 15분마다 새 각성을 보내면
//   그 자체가 방치와 다를 바 없는 소음이 된다(§3-C 문안이 "권한 없음"을
//   못박은 것과 같은 이유 -- 반복이 지시처럼 오인될 위험을 줄인다).
// - `maxTickAgeMs = 2700000`(45분 = 15분 주기의 3배): 최신 tick이 이보다
//   오래됐다면 예약 감시 자체가 죽었다는 뜻이다 -- 그 경우 "미소비가 없다"
//   가 아니라 "판정 재료가 끊겼다"이므로 UNDECIDABLE이다(정상으로 잘못
//   접지 않는다).
//
// 어휘 신규 도입 선언: `WAKE_VERDICT`·`WAKE_REASON`·`DEFAULT_WAKE_CONFIG`
// 전부 이 파일이 새로 만든다.

export const WAKE_VERDICT = Object.freeze({
  WAKE: "WAKE",
  HOLD: "HOLD",
  UNDECIDABLE: "UNDECIDABLE",
});

export const WAKE_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  NOW_INVALID: "NOW_INVALID",
  CONFIG_INVALID: "CONFIG_INVALID",
  TICKS_INVALID: "TICKS_INVALID",
  TICK_MALFORMED: "TICK_MALFORMED",
  TICK_OUT_OF_ORDER: "TICK_OUT_OF_ORDER",
  TICK_IN_FUTURE: "TICK_IN_FUTURE",
  ACTIVE_ROUNDS_UNKNOWN: "ACTIVE_ROUNDS_UNKNOWN",
  ACTIVE_ROUNDS_INVALID: "ACTIVE_ROUNDS_INVALID",
  LAST_WAKE_INVALID: "LAST_WAKE_INVALID",
  LAST_WAKE_IN_FUTURE: "LAST_WAKE_IN_FUTURE",
  NO_TICKS: "NO_TICKS",
  STALE_WATCH: "STALE_WATCH",
  INSUFFICIENT_TICKS: "INSUFFICIENT_TICKS",
  HOLD_NOT_SUSTAINED: "HOLD_NOT_SUSTAINED",
  HOLD_NO_ACTIVE_ROUNDS: "HOLD_NO_ACTIVE_ROUNDS",
  HOLD_COOLDOWN: "HOLD_COOLDOWN",
  WAKE_SUSTAINED_UNCONSUMED: "WAKE_SUSTAINED_UNCONSUMED",
});

export const DEFAULT_WAKE_CONFIG = Object.freeze({
  sustainTicks: 2,
  cooldownMs: 3600000,
  maxTickAgeMs: 2700000,
});

const SUSPECTED_UNCONSUMED = "SUSPECTED_UNCONSUMED";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeInteger(v) {
  return Number.isInteger(v) && v >= 0;
}
function isPositiveInteger(v) {
  return Number.isInteger(v) && v > 0;
}
function isNonNegativeFiniteNumber(v) {
  return isFiniteNumber(v) && v >= 0;
}
function isPositiveFiniteNumber(v) {
  return isFiniteNumber(v) && v > 0;
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: WAKE_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}
function hold(reasonCode, details = null) {
  return { ok: true, verdict: WAKE_VERDICT.HOLD, reasonCode, details };
}

function isWellFormedTick(entry) {
  if (!isPlainObject(entry)) return false;
  if (!isFiniteNumber(entry.tsMs)) return false;
  if (
    entry.unconsumedStatus !== null &&
    typeof entry.unconsumedStatus !== "string"
  ) {
    return false;
  }
  if (
    entry.unconsumedVerdict !== null &&
    typeof entry.unconsumedVerdict !== "string"
  ) {
    return false;
  }
  return true;
}

// ticks(오래된 -> 최신) 배열의 구조·순서·미래시각을 검사한다. 문제가
// 있으면 사유 코드를, 전부 온전하면 `null`을 돌려준다(unconsumed-core.mjs
// firstSignalProblem과 동일 형태).
function firstTickProblem(ticks, nowMs) {
  if (!Array.isArray(ticks)) return WAKE_REASON.TICKS_INVALID;
  let prevTsMs = -Infinity;
  for (const entry of ticks) {
    if (!isWellFormedTick(entry)) return WAKE_REASON.TICK_MALFORMED;
    if (entry.tsMs > nowMs) return WAKE_REASON.TICK_IN_FUTURE;
    if (entry.tsMs < prevTsMs) return WAKE_REASON.TICK_OUT_OF_ORDER;
    prevTsMs = entry.tsMs;
  }
  return null;
}

function resolveConfig(config) {
  if (config === undefined || config === null) return DEFAULT_WAKE_CONFIG;
  return {
    sustainTicks:
      config.sustainTicks === undefined
        ? DEFAULT_WAKE_CONFIG.sustainTicks
        : config.sustainTicks,
    cooldownMs:
      config.cooldownMs === undefined
        ? DEFAULT_WAKE_CONFIG.cooldownMs
        : config.cooldownMs,
    maxTickAgeMs:
      config.maxTickAgeMs === undefined
        ? DEFAULT_WAKE_CONFIG.maxTickAgeMs
        : config.maxTickAgeMs,
  };
}

function isWellFormedConfig(c) {
  return (
    isPositiveInteger(c.sustainTicks) &&
    isNonNegativeFiniteNumber(c.cooldownMs) &&
    isPositiveFiniteNumber(c.maxTickAgeMs)
  );
}

// 구조 검사만 담당 -- 문제가 있으면 undecidable(reasonCode)를, 전부
// 온전하면 null을 돌려준다(decideWake의 앞단을 분리해 max-lines-per-
// function/complexity 상한을 지킨다, §6 eslint 요구).
function validateArgs(ticks, activeRoundCount, lastWakeAtMs, nowMs) {
  const tickProblem = firstTickProblem(ticks, nowMs);
  if (tickProblem) return undecidable(tickProblem);

  if (activeRoundCount === null) {
    return undecidable(WAKE_REASON.ACTIVE_ROUNDS_UNKNOWN);
  }
  if (!isNonNegativeInteger(activeRoundCount)) {
    return undecidable(WAKE_REASON.ACTIVE_ROUNDS_INVALID);
  }

  if (lastWakeAtMs !== null) {
    if (!isFiniteNumber(lastWakeAtMs)) {
      return undecidable(WAKE_REASON.LAST_WAKE_INVALID);
    }
    if (lastWakeAtMs > nowMs) {
      return undecidable(WAKE_REASON.LAST_WAKE_IN_FUTURE);
    }
  }
  return null;
}

// §3-A 판정 규칙 3조건(연속·활성 라운드·쿨다운) -- ticks가 이미 sustain
// 창을 채울 만큼 있고 신선하다고 검증된 뒤에만 불린다.
function applyWakeRules(ticks, activeRoundCount, lastWakeAtMs, nowMs, config) {
  const latest = ticks[ticks.length - 1];
  const window = ticks.slice(-config.sustainTicks);
  const sustained = window.every(
    (t) => t.unconsumedVerdict === SUSPECTED_UNCONSUMED,
  );
  if (!sustained) {
    return hold(WAKE_REASON.HOLD_NOT_SUSTAINED, {
      nowMs,
      latestVerdict: latest.unconsumedVerdict,
    });
  }
  if (activeRoundCount < 1) {
    return hold(WAKE_REASON.HOLD_NO_ACTIVE_ROUNDS, { nowMs, activeRoundCount });
  }
  if (lastWakeAtMs !== null && nowMs - lastWakeAtMs < config.cooldownMs) {
    return hold(WAKE_REASON.HOLD_COOLDOWN, {
      nowMs,
      lastWakeAtMs,
      cooldownMs: config.cooldownMs,
    });
  }
  return {
    ok: true,
    verdict: WAKE_VERDICT.WAKE,
    reasonCode: WAKE_REASON.WAKE_SUSTAINED_UNCONSUMED,
    details: { nowMs, sustainTicks: config.sustainTicks, activeRoundCount },
  };
}

// decideWake({ticks, activeRoundCount, lastWakeAtMs, nowMs, config}) ->
// {ok, verdict, reasonCode, details}
export function decideWake(args) {
  if (!isPlainObject(args)) {
    return undecidable(WAKE_REASON.ARGS_INVALID);
  }
  const { ticks, activeRoundCount, lastWakeAtMs, nowMs, config } = args;

  if (!isFiniteNumber(nowMs)) {
    return undecidable(WAKE_REASON.NOW_INVALID);
  }

  const resolvedConfig = resolveConfig(config);
  if (!isWellFormedConfig(resolvedConfig)) {
    return undecidable(WAKE_REASON.CONFIG_INVALID);
  }

  const argsProblem = validateArgs(
    ticks,
    activeRoundCount,
    lastWakeAtMs,
    nowMs,
  );
  if (argsProblem) return argsProblem;

  if (ticks.length === 0) {
    return undecidable(WAKE_REASON.NO_TICKS);
  }
  const latest = ticks[ticks.length - 1];
  if (nowMs - latest.tsMs > resolvedConfig.maxTickAgeMs) {
    return undecidable(WAKE_REASON.STALE_WATCH);
  }
  if (ticks.length < resolvedConfig.sustainTicks) {
    return undecidable(WAKE_REASON.INSUFFICIENT_TICKS);
  }

  return applyWakeRules(
    ticks,
    activeRoundCount,
    lastWakeAtMs,
    nowMs,
    resolvedConfig,
  );
}
