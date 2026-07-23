// HYK-173-coder-1: 워커 중단 에스컬레이션 -- 순수 로직 계층.
//
// 이 모듈은 두 순수 함수만 담는다: classifyStopTransition (QA -- 워커가
// 통제된 중단 상태로 전이할 때 무엇을 emit해야 하는지) 와
// reduceCoordinatorState (QB -- 코디네이터/supervisor가 관측한 여러
// 입력을 하나의 상태로 합치는 reducer). 정직 한계(§3 coder-task.md,
// PM 보고서 §5): 실 orca 호출 0, check/gate/send 어댑터 배선 0,
// supervisor 프로세스 설치 0, live 스위치 0. `PUSH_CODEX` 미지원,
// `SILENT_DETECTION`(HYK-171 pull)은 미구현, `COORDINATOR_AUTO_WAKE`는
// UNVERIFIED, `LIVE_UNATTENDED_ALL_STALLS` = false. 이 모듈은 그 갭을
// 메우지 않는다 -- 판단 계층만 제공하고 배선은 후속 leg의 몫이다.

// ---------------------------------------------------------------------------
// (A) QA -- classifyStopTransition
// ---------------------------------------------------------------------------

export const STOP_KIND = Object.freeze({
  RUNNING: "RUNNING",
  DONE: "DONE",
  NEEDS_INPUT: "NEEDS_INPUT",
  DECISION_REQUIRED: "DECISION_REQUIRED",
  BLOCKED: "BLOCKED",
  REFUSED: "REFUSED",
});

export const EMIT_PRIMITIVE = Object.freeze({
  GATE: "gate",
  ESCALATION: "escalation",
  NONE: "none",
});

// PM 보고서 §2 QA: "통제된 중단 전이만 대상"이다. crash·kill·rate-limit·
// codex 침묵처럼 워커 스스로 emit을 낼 수 없는 중단은 이 함수의 입력
// 계약 밖이다 -- 그런 kind는 호출측이 애초에 이 함수에 넣지 않고
// PUSH_UNOBSERVABLE로 표시해 pull 경로(HYK-171)로 넘겨야 한다. 이 함수가
// 알 수 없는 kind를 받으면 조용히 'none'으로 접지 않고 명시적으로 거부해
// 호출측이 "emit PASS로 세지 않음"을 강제로 인지하게 한다(문서화된 통제
// 전이 6종 밖은 unobservable 취급 -- 헛통과 금지).
const CONTROLLED_KINDS = new Set(Object.values(STOP_KIND));

const NONE_KINDS = new Set([STOP_KIND.RUNNING, STOP_KIND.DONE]);
const GATE_KINDS = new Set([STOP_KIND.DECISION_REQUIRED]);
const ESCALATION_KINDS = new Set([
  STOP_KIND.NEEDS_INPUT,
  STOP_KIND.BLOCKED,
  STOP_KIND.REFUSED,
]);

export function classifyStopTransition(transition) {
  const kind =
    transition && typeof transition === "object" ? transition.kind : undefined;

  if (typeof kind !== "string" || !CONTROLLED_KINDS.has(kind)) {
    return {
      ok: false,
      reason: `escalation-state: '${String(
        kind,
      )}' is not a controlled stop kind (PUSH_UNOBSERVABLE -- route to pull, do not count as emit PASS)`,
    };
  }

  if (NONE_KINDS.has(kind)) return { ok: true, primitive: EMIT_PRIMITIVE.NONE };
  if (GATE_KINDS.has(kind)) return { ok: true, primitive: EMIT_PRIMITIVE.GATE };
  if (ESCALATION_KINDS.has(kind))
    return { ok: true, primitive: EMIT_PRIMITIVE.ESCALATION };

  // Unreachable given CONTROLLED_KINDS === union of the three sets above,
  // but fail closed rather than silently returning 'none' if that
  // invariant is ever broken by a future edit.
  return {
    ok: false,
    reason: `escalation-state: controlled kind '${kind}' has no primitive mapping (bug -- update NONE/GATE/ESCALATION_KINDS together)`,
  };
}

// ---------------------------------------------------------------------------
// (B) QB -- reduceCoordinatorState
// ---------------------------------------------------------------------------

export const COORD_STATE = Object.freeze({
  DONE_CONFIRMED: "DONE_CONFIRMED",
  DONE_PENDING_HANDSHAKE: "DONE_PENDING_HANDSHAKE",
  NEEDS_INPUT: "NEEDS_INPUT",
  PUSH_TIMEOUT: "PUSH_TIMEOUT",
  SILENT_STALL: "SILENT_STALL",
  INCONSISTENT: "INCONSISTENT",
  SUPERVISOR_FAULT: "SUPERVISOR_FAULT",
});

export const AUTO_ACTION = Object.freeze({
  ORCH_CONSUME_QUEUE: "orch-consume-queue",
  DEDUPE_WAIT: "dedupe-wait",
  ORCH_QUEUE: "orch-queue",
  HUMAN_GATE_WAIT: "human-gate-wait",
  DEFER_TO_PULL: "defer-to-pull",
  NONE: "none",
});

function inScope(scope, item) {
  if (!item || typeof item !== "object") return false;
  return item.taskId === scope.taskId && item.dispatchId === scope.dispatchId;
}

function scopedMessages(scope, events) {
  const messages = Array.isArray(events.orchestrationMessages)
    ? events.orchestrationMessages
    : [];
  return messages.filter((m) => inScope(scope, m));
}

function scopedGates(scope, events) {
  const gates = Array.isArray(events.unresolvedGates)
    ? events.unresolvedGates
    : [];
  return gates.filter((g) => inScope(scope, g));
}

function hasScopedWorkerDone(scope, events) {
  return scopedMessages(scope, events).some((m) => m.type === "worker_done");
}

function hasScopedEscalationOrGate(scope, events) {
  const hasEscalationMsg = scopedMessages(scope, events).some(
    (m) => m.type === "escalation",
  );
  const hasUnresolvedGate = scopedGates(scope, events).length > 0;
  return hasEscalationMsg || hasUnresolvedGate;
}

function hasPullStallSignal(events) {
  const signals = Array.isArray(events.pullSignals) ? events.pullSignals : [];
  return signals.some(
    (s) => s && (s.type === "SILENT_STALL" || s.type === "SEAT_LOST"),
  );
}

// dedupeKey 조립은 여기서 하지 않는다 (transitionId는 reduce 입력이 아니라
// 호출측의 event 식별자다) -- QD의 shouldNotify()가 그 조합을 맡는다.
// reduce 자체는 그 key에 필요한 state만 내놓는다.
function buildDedupeKey(scope, state) {
  return `${scope.taskId}:${scope.dispatchId}:${state}`;
}

function normalizeScope(scope) {
  return scope && typeof scope === "object"
    ? scope
    : { taskId: undefined, dispatchId: undefined, role: undefined };
}

function normalizeHandshake(events) {
  return events.resultHandshake && typeof events.resultHandshake === "object"
    ? events.resultHandshake
    : { status: "absent" };
}

// One row per COORD_STATE outcome, in the exact priority order PM 보고서
// §2 QB / coder-task.md §1-B rules 1~8 specify. `test` receives the
// pre-computed facts object (not raw events) so each row stays a single
// boolean expression -- this keeps reduceCoordinatorState itself a plain
// find-first-match loop instead of a branching tree (quality-check
// complexity ceiling). Order matters: rule 3 (contradiction) sits before
// rule 8 (done confirmed) so a first-seen DONE can never shadow a
// simultaneous gate/bad-handshake (W3).
const STATE_RULES = [
  {
    // Rule 5: supervisorFault trumps every other observation channel --
    // the watcher can't trust its own read/persist path here.
    test: (f) => f.supervisorFault,
    state: COORD_STATE.SUPERVISOR_FAULT,
    autoAction: AUTO_ACTION.NONE,
    wakeHuman: true,
  },
  {
    // Rule 3: contradiction check BEFORE done confirmation (W3).
    test: (f) => (f.isDoneValid && f.scopedNeedsInput) || f.isBadHandshake,
    state: COORD_STATE.INCONSISTENT,
    autoAction: AUTO_ACTION.NONE,
    wakeHuman: true,
  },
  {
    // Rule 4: scoped unresolved gate/escalation with no valid DONE.
    test: (f) => f.scopedNeedsInput,
    state: COORD_STATE.NEEDS_INPUT,
    autoAction: AUTO_ACTION.ORCH_QUEUE,
    wakeHuman: false,
  },
  {
    // Rule 6: pull-sourced stall/seat-loss signal.
    test: (f) => f.pullStall,
    state: COORD_STATE.SILENT_STALL,
    autoAction: AUTO_ACTION.NONE,
    wakeHuman: true,
  },
  {
    // Rule 8: valid DONE, no contradiction, no scoped needs-input above.
    test: (f) => f.isDoneValid,
    state: COORD_STATE.DONE_CONFIRMED,
    autoAction: AUTO_ACTION.ORCH_CONSUME_QUEUE,
    wakeHuman: false,
  },
  {
    // Rule 2: worker_done is advisory only -- never promotes to
    // DONE_CONFIRMED by itself (W2).
    test: (f) => f.scopedWorkerDone,
    state: COORD_STATE.DONE_PENDING_HANDSHAKE,
    autoAction: AUTO_ACTION.DEDUPE_WAIT,
    wakeHuman: false,
  },
  {
    // Rule 7: expected event/DONE absent past deadline for a
    // rule-capable worker -- hand off to pull evaluation.
    test: (f) => f.timeout,
    state: COORD_STATE.PUSH_TIMEOUT,
    autoAction: AUTO_ACTION.DEFER_TO_PULL,
    wakeHuman: false,
  },
  {
    // No signal at all yet (still running, nothing to report): same
    // "wait, don't wake" leg as an unconfirmed pending handshake --
    // expected during normal in-flight work, not an error. Always
    // matches (fallback row), so it must stay last.
    test: () => true,
    state: COORD_STATE.DONE_PENDING_HANDSHAKE,
    autoAction: AUTO_ACTION.DEDUPE_WAIT,
    wakeHuman: false,
  },
];

export function reduceCoordinatorState({ scope, events } = {}) {
  const safeScope = normalizeScope(scope);
  const safeEvents = events && typeof events === "object" ? events : {};
  const handshake = normalizeHandshake(safeEvents);

  const facts = {
    isDoneValid: handshake.status === "done_valid",
    isBadHandshake: handshake.status === "bad",
    scopedWorkerDone: hasScopedWorkerDone(safeScope, safeEvents),
    scopedNeedsInput: hasScopedEscalationOrGate(safeScope, safeEvents),
    pullStall: hasPullStallSignal(safeEvents),
    supervisorFault: safeEvents.supervisorFault === true,
    timeout: safeEvents.timeout === true,
  };

  const rule = STATE_RULES.find((r) => r.test(facts));
  return {
    state: rule.state,
    autoAction: rule.autoAction,
    wakeHuman: rule.wakeHuman,
    dedupeKey: buildDedupeKey(safeScope, rule.state),
  };
}

// ---------------------------------------------------------------------------
// (C) QD -- 2단 승격 + dedupe
// ---------------------------------------------------------------------------

// 사람 게이트 6개(이슈경계·reject 2연속·되돌리기 비용 큰 실행·PR/Done·패킷
// 서명·하드스톱)는 이 모듈 안에서 자동 resolve하지 않는다 -- 이 함수는
// 그 6개에 해당하는 NEEDS_INPUT을 wake로만 승격하고, resolve 호출은 아예
// 만들지 않는다(그 호출 자체가 이 모듈 밖 어댑터의 몫이며, 여기 없다는
// 사실 자체가 R2의 capability 경계다).
export const HUMAN_WAKE_STATES = Object.freeze(
  new Set([
    COORD_STATE.SILENT_STALL,
    COORD_STATE.SUPERVISOR_FAULT,
    COORD_STATE.INCONSISTENT,
  ]),
);

// isHumanGateNeedsInput: NEEDS_INPUT 자체는 상태만으로 사람게이트 6개
// 해당 여부를 알 수 없다(그건 gate/escalation의 reason 분류 몫) -- 호출측이
// 그 판정을 payload로 넘긴다. 이 함수는 순수하게 두 입력(state, 사람게이트
// 해당 여부)을 wake 여부로 접는다.
export function shouldWakeHuman(state, isHumanGateNeedsInput = false) {
  if (HUMAN_WAKE_STATES.has(state)) return true;
  if (state === COORD_STATE.NEEDS_INPUT && isHumanGateNeedsInput === true)
    return true;
  return false;
}

// shouldNotify: 순수 dedupe reduce. priorNotified = 이미 알림을 보낸
// dedupeKey의 집합(Set 또는 Set-like: has(key) 지원). 같은 key는 알림
// 1회, 새 transitionId가 섞인 key(=recover 후 재-stall)는 새 알림
// (N1) -- transitionId를 key 조합에서 빼면 recover 후 재-stall이 억제되는
// 변이가 RED가 되도록 이 함수 자체가 transitionId를 요구한다.
export function shouldNotify(dedupeKey, transitionId, priorNotified) {
  if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
    return { notify: false, key: null };
  }
  const key = `${dedupeKey}:${String(transitionId)}`;
  const already =
    priorNotified && typeof priorNotified.has === "function"
      ? priorNotified.has(key)
      : false;
  return { notify: !already, key };
}
