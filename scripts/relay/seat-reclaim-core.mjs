// HYK-431 1R (coder-task.md §2) -- "끝난 레인의 좌석" 회수 판정 순수 코어.
// 부작용 0 · 시각/랜덤/fs/network 0(teardown-core.mjs와 동일 원칙, G9와
// 동형: 이 파일은 `orca` 문자열도 pane key/PID 원문도 모른다 -- 그런 것은
// 호출자가 만드는 inventory 봉투 안 값일 뿐이다). 이 파일이 내는 판정은
// "지금 이 좌석을 회수 대상으로 볼 수 있는가"뿐이다. 파괴(`terminal
// close`) 자체는 이 파일이 절대 실행하지 않는다(§4 답 참조, coder-task.md
// §2⑷ 비타협: 실행 호출은 이 라운드에서 만들지도 부르지도 않는다).
//
// ---- §2⑴ 회수 대상의 "정의" (사례 나열이 아니라 규칙) ----
//
// 좌석은 다음 네 조건을 **모두** 만족할 때만 RECLAIM_ELIGIBLE이다:
//   1) 그 좌석에 배정된 배차(dispatch)의 `completedAt`이 null이 아니다
//      (= 배차가 끝났다는 구조적 신호. "status 문자열이 무엇이든" 상관
//      없다 -- 아래 §2⑵에서 이 선택의 이유를 설명한다).
//   2) 그 좌석이 `policy.protectedSeats`에 정확히(exact match) 나열돼
//      있지 않다.
//   3) 배차 관측과 활동(activity) 관측이 둘 다 `observable:true`다.
//   4) 배차가 끝난 뒤 흐른 시간(`activity.idleMs`)이
//      `policy.minIdleMs` 이상이다(유예 구간 -- §2⑸에서 이유 설명).
// 위 네 조건 중 하나라도 거짓이면 결과는 RECLAIM_ELIGIBLE이 **아니다**
// (실패 방향은 언제나 "회수하지 않는다" 쪽 -- coder-task.md §1-2
// fail-closed 비타협).
//
// ---- §2⑵ 이 정의가 "전수"임을 무엇으로 보증하는가 ----
//
// 이 코어는 배차 상태를 **문자열 목록으로 열거하지 않는다**(예:
// "succeeded"|"failed"|"cancelled"|... 를 나열하고 그 목록에 있으면
// 끝난 것으로 치는 방식은 채택하지 않았다). 문자열 목록은 새 상태값이
// 벤더 쪽에서 추가되는 순간 조용히 구멍이 난다 -- 그 구멍은 "표본을
// 더 많이 모은다"고 메워지지 않는다(정의상 아직 안 본 미래 값이므로).
//
// 대신 이 코어가 보는 축은 `dispatch.completedAt`이라는 **nullable
// 타임스탬프 하나**뿐이다. 이 필드의 가능한 형태는 논리적으로 정확히
// 두 가지뿐이다 -- "null"(아직 안 끝났다) 또는 "non-null 문자열"(끝났다,
// 그 값이 무엇이든). 이건 상태 문자열의 open set이 아니라 **닫힌
// 이분(binary) 축**이다: 코드는 `!== null` 하나만 검사하고, 그 분기가
// 아닌 모든 입력(null, undefined, 스키마 결손, 관측 실패)은 전부
// DISPATCH_ACTIVE 아니면 UNOBSERVABLE로 떨어진다(else 분기가 없다 --
// `isValidSeatInventoryShape`가 거르지 못한 값은 아래 판정 사슬의 마지막
// guard까지 전부 통과해야만 ELIGIBLE에 닿는다). 즉 "전수"의 근거는
// 표본 수가 아니라 **분기 구조 자체가 닫혀 있다는 것**이다 -- 새 배차
// 상태 문자열이 미래에 추가돼도 completedAt의 null/non-null 이분법은
// 바뀌지 않으므로 이 코어를 고칠 필요가 없다.
//
// 이 보증이 못 덮는 것(정직하게): `completedAt`을 채우는 쪽(호출자/
// 어댑터)이 실제로 배차가 끝났을 때만 그 필드를 채운다는 **상위 계약**은
// 이 코어가 강제할 수 없다 -- 그 계약이 깨지면(예: 아직 안 끝난 배차에
// 실수로 completedAt이 채워짐) 이 코어는 정직하게 속는다. 그 계약은
// 어댑터/§4 실행 경계의 책임이다.
//
// ---- §2⑶ 회수 "누락"이 이상으로 열리는가 ----
// judgeReclaimAnomaly가 별도 축을 낸다(아래) -- 좌석 "개수" 단독 임계는
// 폐기(coder-task.md §2⑶ 비타협): count>0인데 가용 메모리가 바닥이 아니면
// WATCH(가시성만)에서 멈추고 ANOMALY로 올리지 않는다. ANOMALY는 반드시
// "회수 못 한 좌석이 있다" AND "가용 메모리가 바닥"(또는 메모리 자체를
// 관측 못 함 -- 아래 이유) 둘 다일 때만 뜬다.
//
// ---- §2⑷ 실행은 누가 하는가 ----
// 이 파일은 판정까지다. `terminal close`류 실행 호출은 이 저장소의 다른
// 어떤 스크립트도 이 라운드에서 만들지 않는다(§0 합성 표적 규율) --
// 그 호출은 이 저장소 밖 관제실(control room)의 "실행 한 줄"만 맡는다
// (coder-task.md §3, 판정/시험은 저장소 안, 실행 호출만 관제실). 관제실
// 코드는 이 파일의 judgeSeatReclaim만 부르고, 반환된 reclaimEligible이
// true인 좌석에 한해서만 자신의 실행 한 줄을 돌려야 한다 -- 그 결선
// 자체는 이 저장소가 검사할 수 없으므로(CI 앵커가 이 저장소 밖에 없다),
// 이 코어가 보증하는 것은 "판정이 맞다"까지이지 "관제실이 그 판정을
// 실제로 따랐다"까지가 아니다(정직 한계).

export const SEAT_RECLAIM_SCHEMA_VERSION = 1;

export const SEAT_ELIGIBILITY = Object.freeze({
  PROTECTED: "PROTECTED",
  UNOBSERVABLE: "UNOBSERVABLE",
  DISPATCH_ACTIVE: "DISPATCH_ACTIVE",
  WITHIN_GRACE_PERIOD: "WITHIN_GRACE_PERIOD",
  RECLAIM_ELIGIBLE: "RECLAIM_ELIGIBLE",
});

export const SEAT_REASON = Object.freeze({
  SCHEMA_INVALID: "SEAT_RECLAIM_SCHEMA_INVALID",
  PROTECTED_SEAT: "SEAT_RECLAIM_PROTECTED_SEAT",
  DISPATCH_UNOBSERVABLE: "SEAT_RECLAIM_DISPATCH_UNOBSERVABLE",
  DISPATCH_ACTIVE: "SEAT_RECLAIM_DISPATCH_ACTIVE",
  ACTIVITY_UNOBSERVABLE: "SEAT_RECLAIM_ACTIVITY_UNOBSERVABLE",
  WITHIN_GRACE_PERIOD: "SEAT_RECLAIM_WITHIN_GRACE_PERIOD",
  ELIGIBLE: "SEAT_RECLAIM_ELIGIBLE",
});

export const ANOMALY_STATUS = Object.freeze({
  OK: "OK",
  WATCH: "WATCH",
  ANOMALY: "ANOMALY",
});

export const ANOMALY_REASON = Object.freeze({
  INPUT_INVALID: "SEAT_RECLAIM_ANOMALY_INPUT_INVALID",
  NO_BACKLOG: "SEAT_RECLAIM_ANOMALY_NO_BACKLOG",
  BACKLOG_MEMORY_OK: "SEAT_RECLAIM_ANOMALY_BACKLOG_MEMORY_OK",
  BACKLOG_MEMORY_UNOBSERVABLE:
    "SEAT_RECLAIM_ANOMALY_BACKLOG_MEMORY_UNOBSERVABLE",
  BACKLOG_MEMORY_BELOW_FLOOR: "SEAT_RECLAIM_ANOMALY_BACKLOG_MEMORY_BELOW_FLOOR",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isNullableString(v) {
  return v === null || isNonEmptyString(v);
}

function isValidSeatField(seat) {
  return isPlainObject(seat) && isNullableString(seat.paneKey);
}
function isValidDispatchField(dispatch) {
  return (
    isPlainObject(dispatch) &&
    isNullableString(dispatch.completedAt) &&
    typeof dispatch.observable === "boolean"
  );
}
function isValidActivityField(activity) {
  return (
    isPlainObject(activity) &&
    (activity.idleMs === null ||
      (Number.isFinite(activity.idleMs) && activity.idleMs >= 0)) &&
    typeof activity.observable === "boolean"
  );
}

// 스키마 결손/타입 오류를 여기서 전부 잡는다(fail-closed 진입점) -- 이
// 함수가 false를 내면 judgeSeatReclaim은 나머지 로직을 평가하지 않고
// 곧장 UNOBSERVABLE을 반환한다(teardown-core.mjs의 isValidInventoryShape와
// 동형 원칙).
function isValidSeatInventoryShape(inventory) {
  if (!isPlainObject(inventory)) return false;
  if (inventory.schemaVersion !== SEAT_RECLAIM_SCHEMA_VERSION) return false;
  if (!isValidSeatField(inventory.seat)) return false;
  if (!isValidDispatchField(inventory.dispatch)) return false;
  if (!isValidActivityField(inventory.activity)) return false;
  return true;
}

function isProtectedSeat(inventory, policy) {
  const list = Array.isArray(policy.protectedSeats)
    ? policy.protectedSeats
    : [];
  // exact 대조만(부분일치·정규식 금지 -- teardown-core.mjs isProtectedTarget과
  // 동일 정책, coder-task.md §2⑸: 부분일치를 허용하면 "살아 있어야 할
  // 좌석"이 잘못 걸릴 대가가 새로 생긴다).
  return isNonEmptyString(inventory.seat.paneKey)
    ? list.includes(inventory.seat.paneKey)
    : false;
}

function buildSeatEvidence(inventory, ruleId, extra = {}) {
  return {
    ruleId,
    dispatch: inventory.dispatch,
    activity: inventory.activity,
    ...extra,
  };
}

// classifySeatEligibility -- judgeSeatReclaim에서 분리(quality-check
// 복잡도 상한 12 준수, teardown-core.mjs의 classifyEligibility와 동형
// 분리 원칙). 스키마 검사는 호출자(judgeSeatReclaim)가 이미 통과시킨
// 뒤에만 이 함수가 불린다 -- 여기서는 inventory 필드 존재를 가정한다.
function classifySeatEligibility(inventory, p) {
  if (isProtectedSeat(inventory, p)) {
    return {
      eligibility: SEAT_ELIGIBILITY.PROTECTED,
      reason: SEAT_REASON.PROTECTED_SEAT,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.PROTECTED_SEAT, {
        protectedSeats: p.protectedSeats ?? [],
      }),
    };
  }

  if (inventory.dispatch.observable !== true) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reason: SEAT_REASON.DISPATCH_UNOBSERVABLE,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.DISPATCH_UNOBSERVABLE),
    };
  }

  // §2⑵ 이분 축: completedAt이 null이면 "아직 안 끝났다" -- 그 값이 무엇
  // 이든(어떤 상태 문자열이든) 전부 이 분기 하나로 접힌다.
  if (inventory.dispatch.completedAt === null) {
    return {
      eligibility: SEAT_ELIGIBILITY.DISPATCH_ACTIVE,
      reason: SEAT_REASON.DISPATCH_ACTIVE,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.DISPATCH_ACTIVE),
    };
  }

  if (inventory.activity.observable !== true) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reason: SEAT_REASON.ACTIVITY_UNOBSERVABLE,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.ACTIVITY_UNOBSERVABLE),
    };
  }

  // 유예 구간(§2⑸): worker_done 뒤에도 사용자가 이 터미널에 직접 새 일을
  // 시킬 수 있다(이 좌석 자신의 시스템 프롬프트 "AFTER YOU SEND
  // worker_done" 절 참조) -- 배차가 끝났다는 사실만으로 곧장 회수하면 그
  // 진행 중인 사용자-지시 작업을 죽인다. minIdleMs가 숫자가 아니면(정책
  // 결손) 유예를 무한으로 취급한다 -- fail-closed(회수 금지 쪽으로 접는다).
  const minIdleMs =
    Number.isFinite(p.minIdleMs) && p.minIdleMs >= 0 ? p.minIdleMs : Infinity;
  if (inventory.activity.idleMs < minIdleMs) {
    return {
      eligibility: SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD,
      reason: SEAT_REASON.WITHIN_GRACE_PERIOD,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.WITHIN_GRACE_PERIOD, {
        minIdleMs: p.minIdleMs,
      }),
    };
  }

  return {
    eligibility: SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE,
    reason: SEAT_REASON.ELIGIBLE,
    evidence: buildSeatEvidence(inventory, SEAT_REASON.ELIGIBLE),
  };
}

// judgeSeatReclaim({ inventory, policy }) -- policy: { protectedSeats:
// string[], minIdleMs: number }. 순수 판정, 부작용 0. 반환:
// { eligibility, reclaimEligible, reason, evidence }.
export function judgeSeatReclaim({ inventory, policy } = {}) {
  const p = isPlainObject(policy) ? policy : {};

  if (!isValidSeatInventoryShape(inventory)) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reclaimEligible: false,
      reason: SEAT_REASON.SCHEMA_INVALID,
      evidence: {
        ruleId: SEAT_REASON.SCHEMA_INVALID,
        inventory: inventory ?? null,
      },
    };
  }

  const { eligibility, reason, evidence } = classifySeatEligibility(
    inventory,
    p,
  );
  return {
    eligibility,
    reclaimEligible: eligibility === SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE,
    reason,
    evidence,
  };
}

function isValidAnomalyInput(eligibleUnreclaimedCount, systemPressure, policy) {
  if (
    !Number.isInteger(eligibleUnreclaimedCount) ||
    eligibleUnreclaimedCount < 0
  )
    return false;
  if (!isPlainObject(systemPressure)) return false;
  if (typeof systemPressure.observable !== "boolean") return false;
  if (
    systemPressure.availableMemoryBytes !== null &&
    !(
      Number.isFinite(systemPressure.availableMemoryBytes) &&
      systemPressure.availableMemoryBytes >= 0
    )
  )
    return false;
  if (!isPlainObject(policy)) return false;
  if (!Number.isFinite(policy.memoryFloorBytes) || policy.memoryFloorBytes < 0)
    return false;
  return true;
}

// judgeReclaimAnomaly({ eligibleUnreclaimedCount, systemPressure }, policy)
// -- coder-task.md §2⑶: "회수 누락이 이상으로 열리는가"의 관측 축.
// policy: { memoryFloorBytes: number }. 순수 판정, 부작용 0.
//
// 좌석 "개수" 단독으로는 절대 ANOMALY까지 올라가지 않는다(비타협, §2⑶) --
// count>0은 최대 WATCH까지만 올린다. ANOMALY는 반드시 가용 메모리 축이
// 관여해야 뜬다(바닥 이하, 또는 관측 자체가 안 됨).
//
// 입력이 무효하거나(스키마 결손) 메모리를 관측할 수 없는 상태에서
// count>0이면 **ANOMALY 쪽으로 접는다**(fail-open, judgeSeatReclaim의
// fail-closed와 방향이 다르다 -- 의도적 비대칭, coder-task.md §2⑸에서
// 근거 설명: 이 축의 유일한 산출물은 "사람에게 보이는 신호"이지 파괴
// 행위가 아니다. 잘못 띄운 ANOMALY의 대가는 사람이 30초 들여다보고
// 마는 것이고, 조용히 숨긴 ANOMALY의 대가는 §1 실측 그대로 -- 밤새 러너
// 46% 빨강·1.5시간 손실이다. 두 대가가 비대칭이므로 관측 실패는 침묵이
// 아니라 신호 쪽으로 접는다).
export function judgeReclaimAnomaly(
  { eligibleUnreclaimedCount, systemPressure } = {},
  policy = {},
) {
  const p = isPlainObject(policy) ? policy : {};
  if (!isValidAnomalyInput(eligibleUnreclaimedCount, systemPressure, p)) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.INPUT_INVALID,
      evidence: {
        ruleId: ANOMALY_REASON.INPUT_INVALID,
        eligibleUnreclaimedCount: eligibleUnreclaimedCount ?? null,
        systemPressure: systemPressure ?? null,
      },
    };
  }

  if (eligibleUnreclaimedCount === 0) {
    return {
      status: ANOMALY_STATUS.OK,
      reason: ANOMALY_REASON.NO_BACKLOG,
      evidence: { ruleId: ANOMALY_REASON.NO_BACKLOG, eligibleUnreclaimedCount },
    };
  }

  if (systemPressure.observable !== true) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.BACKLOG_MEMORY_UNOBSERVABLE,
      evidence: {
        ruleId: ANOMALY_REASON.BACKLOG_MEMORY_UNOBSERVABLE,
        eligibleUnreclaimedCount,
      },
    };
  }

  if (systemPressure.availableMemoryBytes < p.memoryFloorBytes) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR,
      evidence: {
        ruleId: ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR,
        eligibleUnreclaimedCount,
        availableMemoryBytes: systemPressure.availableMemoryBytes,
        memoryFloorBytes: p.memoryFloorBytes,
      },
    };
  }

  return {
    status: ANOMALY_STATUS.WATCH,
    reason: ANOMALY_REASON.BACKLOG_MEMORY_OK,
    evidence: {
      ruleId: ANOMALY_REASON.BACKLOG_MEMORY_OK,
      eligibleUnreclaimedCount,
      availableMemoryBytes: systemPressure.availableMemoryBytes,
      memoryFloorBytes: p.memoryFloorBytes,
    },
  };
}
