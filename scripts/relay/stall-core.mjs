// HYK-171-cycle2a-1: pull stall 판정 순수 코어.
//
// 경계(PM 비평 반영, coder-task.md §명시적 비범위): 이 모듈은 정규화된
// 좌석 신호 스냅샷 하나를 받아 상태를 분류만 한다. orca/CLI 호출 0,
// 파일·네트워크 부작용 0, dispatch/PAUSED/hard-stop 적용 0. 원시
// orca preview/dispatch-show 문자열을 이 모듈이 직접 파싱하지 않는다
// (그 정규화는 2B 어댑터 몫 -- S6 봉인). actions는 항상 빈 배열이다:
// "조치"는 하류(사람/어댑터)의 몫이고 이 코어는 advisory만 낸다.

export const SEAT_STATE = Object.freeze({
  HEALTHY: "HEALTHY",
  SUSPECTED_STALL: "SUSPECTED_STALL",
  UNKNOWN: "UNKNOWN",
  UNOBSERVABLE: "UNOBSERVABLE",
});

// 사유 코드 -- 사람이 읽을 텍스트가 아니라 테스트/로그가 안정적으로 매칭할
// 수 있는 짧은 식별자. 실제 사람 대상 문구는 이 코드를 감싸는 상류(2B)의
// 몫이다.
export const REASON = Object.freeze({
  HANDSHAKE_DONE: "handshake-done",
  PROCESS_NOT_ALIVE: "process-not-alive",
  MULTI_SIGNAL_PROGRESS: "multi-signal-progress",
  INSUFFICIENT_SIGNALS: "insufficient-signals",
  LEASE_VIOLATED_NO_CORROBORATION: "lease-violated-no-corroboration",
  MISSING_REQUIRED_FIELDS: "missing-required-fields",
});

// 보수적 기본값(PM §5: 하드코딩 금지 -- config로 항상 덮어쓸 수 있어야
// 한다. 여기 상수는 config가 비었을 때만 쓰이는 최후 폴백이다).
const DEFAULT_MAX_NO_PROGRESS_S = 1800;
const DEFAULT_FRESH_OUTPUT_AGE_S = 300;
const DEFAULT_MIN_PROGRESS_SIGNALS = 2;

function isPositiveFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// S6 봉인: 입력은 정규화된 스냅샷 "타입"(plain object + 문서화된 필드)만
// 받는다. 원시 문자열/배열 등은 계약 위반이므로 관측 자체가 불가능한
// 것으로 취급한다(UNOBSERVABLE) -- 이 함수가 문자열을 파싱해 필드를
// 추출하려 시도하는 일은 절대 없다.
function hasRequiredFields(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  if (!isPositiveFiniteNumber(snapshot.mtimeAgeS)) return false;
  if (typeof snapshot.processAlive !== "boolean") return false;
  return true;
}

function resolveMaxNoProgressS(snapshot, config) {
  const fromLease = snapshot?.lease?.maxNoProgressS;
  if (isPositiveFiniteNumber(fromLease)) return fromLease;
  const fromConfig = config?.defaultMaxNoProgressS;
  if (isPositiveFiniteNumber(fromConfig)) return fromConfig;
  return DEFAULT_MAX_NO_PROGRESS_S;
}

function resolveFreshOutputAgeS(config) {
  const fromConfig = config?.freshOutputAgeS;
  return isPositiveFiniteNumber(fromConfig)
    ? fromConfig
    : DEFAULT_FRESH_OUTPUT_AGE_S;
}

function resolveMinProgressSignals(config) {
  const fromConfig = config?.minProgressSignals;
  return typeof fromConfig === "number" &&
    Number.isFinite(fromConfig) &&
    fromConfig >= 1
    ? fromConfig
    : DEFAULT_MIN_PROGRESS_SIGNALS;
}

function seatFingerprintId(snapshot) {
  return (
    (isPlainObject(snapshot) &&
      (snapshot.seatId ?? snapshot.role ?? undefined)) ||
    "unknown-seat"
  );
}

function makeFingerprint(seatId, reason) {
  return `${seatId}:${reason}`;
}

// false activity 방어(PM §3/§6, REVIEW HYK-171-cycle2a-review-1 결함 a):
// mtime touch와 terminal output 변화는 **둘 다 같은 부류의 얕은 활동
// 신호**다 -- 로그만 반복 찍으며 파일을 touch하는 hung 워커가 정확히
// 이 두 신호를 동시에 만든다(PM §3 "noisy-hung"). 그래서 이 둘을 서로
// 독립적인 증거로 이중계산하지 않는다: mtimeFresh/outputFresh는
// `shallowActivity` 한 버킷으로 합치고, pushSeen(워커가 능동적으로 낸
// push 신호 -- 얕은 activity와 질이 다르다)만 별도 버킷으로 센다.
// count는 이 두 버킷 중 참인 것의 개수(0~2)다 -- "신호 3개 중 몇 개"가
// 아니라 "질적으로 구분되는 증거 버킷 중 몇 개"를 센다.
function countProgressSignals(snapshot, maxNoProgressS, freshOutputAgeS) {
  const mtimeFresh = snapshot.mtimeAgeS < maxNoProgressS;
  const outputFresh =
    snapshot.lastOutputChanged === true &&
    isPositiveFiniteNumber(snapshot.lastOutputAgeS) &&
    snapshot.lastOutputAgeS < freshOutputAgeS;
  const pushSeen = snapshot.pushSeen === true;
  const shallowActivity = mtimeFresh || outputFresh;
  return {
    mtimeFresh,
    outputFresh,
    shallowActivity,
    pushSeen,
    count: [shallowActivity, pushSeen].filter(Boolean).length,
  };
}

// classifySeat: 순수 함수. 부작용 0, orca 호출 0, 항상 actions: [].
//
// input: { snapshot, prevState, config }
//   snapshot: 정규화된 좌석 신호(어댑터가 만듦). 필수: mtimeAgeS(number),
//     processAlive(boolean). 선택: handshake, lastOutputAgeS,
//     lastOutputChanged, runtimeStatus, pushSeen, lease.maxNoProgressS,
//     seatId/role(fingerprint용).
//   prevState: 이전 분류 결과(현재 이 코어의 상태-독립 규칙에서는 판정에
//     쓰지 않는다 -- 상태전이/재개 판단은 dedup(shouldEmit)과 상류의
//     몫이다. 시그니처에는 유지해 향후 어댑터가 자유롭게 넘길 수 있게
//     한다).
//   config: { defaultMaxNoProgressS, freshOutputAgeS, minProgressSignals }
//     (전부 선택, 미지정시 보수적 기본값)
//
// output: { state, reason, fingerprint, actions: [] }
export function classifySeat({ snapshot, prevState, config } = {}) {
  void prevState; // 현재 규칙은 상태-독립적 -- 의도적으로 미사용.

  const seatId = seatFingerprintId(snapshot);

  // 완료 우선(비타협): handshake==='done'이면 다른 신호와 무관하게 절대
  // stall이 아니다. 관측 결손 검사보다도 먼저 본다 -- done 자체가 이미
  // 충분한 직접 신호이기 때문.
  if (isPlainObject(snapshot) && snapshot.handshake === "done") {
    const reason = REASON.HANDSHAKE_DONE;
    return {
      state: SEAT_STATE.HEALTHY,
      reason,
      fingerprint: makeFingerprint(seatId, reason),
      actions: [],
    };
  }

  // 관측 결손: 판정에 필요한 최소 신호(mtimeAgeS, processAlive)가 없으면
  // stall/healthy를 단정하지 않는다.
  if (!hasRequiredFields(snapshot)) {
    const reason = REASON.MISSING_REQUIRED_FIELDS;
    return {
      state: SEAT_STATE.UNOBSERVABLE,
      reason,
      fingerprint: makeFingerprint(seatId, reason),
      actions: [],
    };
  }

  // 프로세스 사망은 그 자체로 결정적 신호(로그 하나만 있는 noisy 신호와
  // 질적으로 다르다) -- 복수신호 정합 검사 없이 바로 SUSPECTED_STALL.
  if (snapshot.processAlive === false) {
    const reason = REASON.PROCESS_NOT_ALIVE;
    return {
      state: SEAT_STATE.SUSPECTED_STALL,
      reason,
      fingerprint: makeFingerprint(seatId, reason),
      actions: [],
    };
  }

  const maxNoProgressS = resolveMaxNoProgressS(snapshot, config);
  const freshOutputAgeS = resolveFreshOutputAgeS(config);
  const minProgressSignals = resolveMinProgressSignals(config);
  const { count } = countProgressSignals(
    snapshot,
    maxNoProgressS,
    freshOutputAgeS,
  );

  if (count >= minProgressSignals) {
    const reason = REASON.MULTI_SIGNAL_PROGRESS;
    return {
      state: SEAT_STATE.HEALTHY,
      reason,
      fingerprint: makeFingerprint(seatId, reason),
      actions: [],
    };
  }

  // count === 0: shallowActivity는 count에 포함된 버킷이고
  // shallowActivity===false는 mtimeFresh===false를 함의하므로(둘 다
  // false여야 shallowActivity가 false), count===0이면 mtimeFresh는
  // 반드시 false, 즉 lease는 반드시 위반 상태다. 그 외(count>0인데
  // min에는 못 미치는 모든 경우, REVIEW HYK-171-cycle2a-review-1 결함
  // b: `count === 1` 하드코딩은 min>2일 때 "0 < count < min"인 나머지
  // 경우를 잘못 count===0 stall 분기로 흘렸다)는 min 상대적으로
  // UNKNOWN이다 -- 신호가 아예 없는 것과 부족하지만 있는 것을 같은
  // stall로 취급하지 않는다.
  if (count === 0) {
    const reason = REASON.LEASE_VIOLATED_NO_CORROBORATION;
    return {
      state: SEAT_STATE.SUSPECTED_STALL,
      reason,
      fingerprint: makeFingerprint(seatId, reason),
      actions: [],
    };
  }

  // 0 < count < minProgressSignals: false activity 방어 -- 증거
  // 버킷이 min에 못 미치면 HEALTHY로 인정하지 않되, 신호가 전혀 없는
  // 것도 아니므로 SUSPECTED_STALL 대신 UNKNOWN(애매)으로 접는다.
  const reason = REASON.INSUFFICIENT_SIGNALS;
  return {
    state: SEAT_STATE.UNKNOWN,
    reason,
    fingerprint: makeFingerprint(seatId, reason),
    actions: [],
  };
}

// shouldEmit: 최소 dedup. fingerprint(좌석/사유)당 열린 advisory 1개만
// 허용하고, 같은 fingerprint에서 state가 바뀔 때만 새로 emit한다.
// leader/claim/durable store는 여기 없다(cycle3/2B 몫) -- openAdvisories는
// 호출측이 들고 있는 현재 열린 advisory 목록을 그대로 넘긴다.
//
// input: { advisory: {fingerprint, state, ...}, openAdvisories: Array }
// output: boolean
export function shouldEmit({ advisory, openAdvisories } = {}) {
  const adv = isPlainObject(advisory) ? advisory : {};
  const list = Array.isArray(openAdvisories) ? openAdvisories : [];
  const match = list.find(
    (a) => isPlainObject(a) && a.fingerprint === adv.fingerprint,
  );
  if (!match) return true;
  return match.state !== adv.state;
}
