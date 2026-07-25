// HYK-171-cycle2b-1: 결선 -- adapter(seat-signal-adapter.mjs) ->
// classifySeat(stall-core.mjs, 2A, 재구현 금지) -> shouldEmit(2A, durable
// store가 openAdvisories를 제공) -> advisory outbox. observer-only
// 오케스트레이션(coder-task.md §대상 파일 3).
//
// 경계(비타협): 이 모듈도 dispatch/teardown/worker input/task 상태 write를
// 절대 호출하지 않는다. live=true를 세우지 않는다. 한 tick의 전체 흐름을
// runObserverTick으로 노출한다 -- 실 orca 호출은 seat-signal-adapter의
// collectSeatObservation(opts.execFn)에게 위임한다(이 파일 자신은 orca
// 문자열을 다루지 않는다).

import { classifySeat, SEAT_STATE } from "./stall-core.mjs";
import {
  collectSeatObservation,
  normalizeSeatObservation,
} from "./adapters/seat-signal-adapter.mjs";
import {
  applyObservation,
  recordDegradedObservation,
  loadStore,
  saveStoreCAS,
  listUndelivered,
  claimForDelivery,
  markDelivered,
  recordAck,
  incarnationKeyOf,
} from "./observer-store.mjs";

export const OBSERVER_STATE = Object.freeze({
  ...SEAT_STATE,
  ADAPTER_DEGRADED: "ADAPTER_DEGRADED",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 한 seat의 한 tick: observation(이미 수집된 것 -- normalizeSeatObservation
// 출력 형태) -> classify(관측 가능할 때만) -> store 갱신(CAS). 순수 함수 --
// 부작용은 store 값 자체를 반환하는 형태로만 나타난다(호출자가 저장한다).
//
// input: { state, seatId, incarnation, observation: {snapshot, quality, persist},
//   prevState (직전 tick의 classify 결과, config, sampleGeneration }
// output: { nextState, result: {kind, ...}, emitted }
export function reduceTick({
  state,
  seatId,
  incarnation,
  observation,
  prevState = null,
  config,
  sampleGeneration,
} = {}) {
  const obs = isPlainObject(observation) ? observation : {};
  const quality = isPlainObject(obs.quality)
    ? obs.quality
    : { observable: false };

  if (!quality.observable) {
    const degraded = recordDegradedObservation(state, {
      seatId,
      incarnation,
      degradedReasons: quality.degradedReasons,
      observedAtMs: obs.persist?.observedAtMs,
    });
    return {
      nextState: degraded.state,
      emitted: false,
      result: {
        kind: OBSERVER_STATE.ADAPTER_DEGRADED,
        degradedReasons: quality.degradedReasons ?? [],
        sourceFailureDomain: quality.sourceFailureDomain ?? null,
      },
    };
  }

  const classifyResult = classifySeat({
    snapshot: obs.snapshot,
    prevState,
    config,
  });

  const applied = applyObservation(state, {
    seatId,
    incarnation,
    classifyResult,
    sampleGeneration,
    persist: obs.persist,
  });

  return {
    nextState: applied.state,
    emitted: applied.emitted,
    result: {
      kind: classifyResult.state,
      reason: classifyResult.reason,
      fingerprint: applied.boundFingerprint,
    },
  };
}

// ---- fs/orca 결속 오케스트레이션 (opts에 전부 주입 -- 테스트는 fake로) ----
// ctx: { seatId, harnessRole, harnessDir, taskId, coordinatorHandle,
//   seatSelector, expectedIncarnation, lease, capabilities, maxClockJumpS,
//   storePath, sampleGeneration, prevState, config }
// opts: { execFn, statFn, nowFn, checkHandshakeFn, prevObservation,
//   fs: {existsFn, readFn, writeFn, renameFn}, notifyFn }
//
// notifyFn(item) -> boolean(delivered) | Promise<boolean>. undelivered 항목은
// store에 남아 다음 호출에서 다시 시도된다(idempotent 재시도 허용, worker
// 자동 retry 금지와는 다른 층위).
// runObserverTick에서 분리(quality-check 복잡도 상한 준수) -- claim ->
// notifyFn -> markDelivered의 한 항목 처리를 담당. 반환값은 다음 항목이
// CAS 기준으로 삼을 최신 {state, text}와, 실제 전달됐다면 그 item.
//
// HYK-171-cycle2b-3 재범위(사람 게이트 결정 B): 사이클2b-2가 여기 넣었던
// O_EXCL 파일잠금(acquireDeliveryLock 등)을 제거했다 -- crash 시 잠금이
// 영구히 남아 durable outbox 배달이 무한정 멈추는 결함을 REVIEW review-2가
// 재현했고, 진짜 crash-safe 배타배달(원자 claim·단일 leader·잠금
// 생명주기)은 cycle3 몫으로 명시적으로 미룬다(PM 사이클2 비평 §5, 자세한
// 사유는 observer-store.mjs의 claimForDelivery 위 주석 참조). 지금은
// `claimForDelivery`(state 기반 pending->claimed 전이)+`saveStoreCAS`
// (CAS)만으로 **단일 인스턴스/leader 안에서의 재emit·재전달 억제**를
// 보장한다. 동시에 도는 인스턴스 2개가 서로의 claim을 못 보고 각자
// notifyFn까지 가는 것(bounded 중복)은 의도적으로 허용한다 -- 이 관측기는
// dispatch/teardown/worker input/task 상태 write를 전혀 하지 않으므로
// (observer-only 경계), 그 중복의 최악 효과는 advisory 알림 중복 전달일
// 뿐 이중 실행이 아니다.
async function deliverOne({
  item,
  storePath,
  currentState,
  currentText,
  fsOpts,
  notifyFn,
  nowForDeliveryMs,
}) {
  const claim = claimForDelivery(currentState, {
    seatId: item.seatId,
    fingerprint: item.fingerprint,
    claimedAtMs: nowForDeliveryMs,
  });
  if (!claim.ok) {
    return { state: currentState, text: currentText, delivered: null };
  }
  const claimSaved = saveStoreCAS(storePath, claim.state, currentText, fsOpts);
  if (!claimSaved.ok) {
    return { state: currentState, text: currentText, delivered: null };
  }

  let ok;
  try {
    ok = await notifyFn(item);
  } catch {
    ok = false;
  }
  const marked = markDelivered(claim.state, {
    seatId: item.seatId,
    fingerprint: item.fingerprint,
    attemptAtMs: nowForDeliveryMs,
    delivered: ok === true,
  });
  if (!marked.ok) {
    return {
      state: claim.state,
      text: claimSaved.rawText,
      delivered: ok === true ? item : null,
    };
  }
  const finalSaved = saveStoreCAS(
    storePath,
    marked.state,
    claimSaved.rawText,
    fsOpts,
  );
  return {
    state: finalSaved.ok ? marked.state : claim.state,
    text: finalSaved.ok ? finalSaved.rawText : claimSaved.rawText,
    delivered: ok === true ? item : null,
  };
}

async function runDeliveryPass({
  seatId,
  storePath,
  nextState,
  rawText,
  fsOpts,
  notifyFn,
  nowForDeliveryMs,
}) {
  const delivered = [];
  let currentState = nextState;
  let currentText = rawText;
  for (const item of listUndelivered(currentState)) {
    if (item.seatId !== seatId) continue;
    const result = await deliverOne({
      item,
      storePath,
      currentState,
      currentText,
      fsOpts,
      notifyFn,
      nowForDeliveryMs,
    });
    currentState = result.state;
    currentText = result.text;
    if (result.delivered) delivered.push(result.delivered);
  }
  return delivered;
}

// runObserverTick에서 분리(quality-check 복잡도 상한 준수) -- 관측 수집 +
// reduceTick 호출을 담당. P1-4 재작업(REVIEW 결함 4 수리): store로 넘기는
// incarnation은 반드시 어댑터가 이미 토큰화한 observation.quality.incarnation
// 을 써야 한다 -- ctx.expectedIncarnation(호출자가 준 원본, raw pane key
// 포함)을 여기서 직접 쓰면 어댑터 경계를 우회해 raw 문자열이 그대로
// durable store로 샌다(REVIEW의 S6_RAW_PANE_PROBE 재현 지점).
function collectAndReduce(c, opts, loaded) {
  const observation = collectSeatObservation(
    {
      seatId: c.seatId,
      harnessRole: c.harnessRole,
      harnessDir: c.harnessDir,
      taskId: c.taskId,
      coordinatorHandle: c.coordinatorHandle,
      seatSelector: c.seatSelector,
      expectedIncarnation: c.expectedIncarnation,
      lease: c.lease,
      capabilities: c.capabilities,
      maxClockJumpS: c.maxClockJumpS,
    },
    {
      execFn: opts.execFn,
      statFn: opts.statFn,
      nowFn: opts.nowFn,
      checkHandshakeFn: opts.checkHandshakeFn,
      prevObservation:
        opts.prevObservation ?? loaded.state.seats?.[c.seatId]?.episode ?? {},
    },
  );

  return reduceTick({
    state: loaded.state,
    seatId: c.seatId,
    incarnation: observation.quality?.incarnation,
    observation,
    prevState: c.prevState,
    config: c.config,
    sampleGeneration: c.sampleGeneration,
  });
}

export async function runObserverTick(ctx = {}, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const fsOpts = isPlainObject(opts.fs) ? opts.fs : {};

  const loaded = loadStore(c.storePath, fsOpts);
  if (!loaded.ok) {
    // mutation 9: store 자체가 손상/스키마 불일치면 이번 tick은 어떤
    // 확정 판정도 만들지 않는다 -- fail-closed로 그대로 보고한다.
    return {
      ok: false,
      reason: loaded.reason,
      kind: OBSERVER_STATE.ADAPTER_DEGRADED,
      delivered: [],
    };
  }

  const tick = collectAndReduce(c, opts, loaded);

  const saved = saveStoreCAS(
    c.storePath,
    tick.nextState,
    loaded.rawText,
    fsOpts,
  );
  if (!saved.ok) {
    // mutation 10: 충돌(다른 인스턴스가 먼저 씀) -- 이번 프로세스는 자신의
    // emit을 포기한다(중복 알림 방지). 손상 아닌 conflict는 그 자체로
    // "다른 인스턴스가 이미 처리했다"는 정상 신호다.
    return {
      ok: saved.reason === "conflict",
      reason: saved.reason,
      kind: tick.result.kind,
      emitted: false,
      delivered: [],
    };
  }

  const delivered =
    typeof opts.notifyFn === "function"
      ? await runDeliveryPass({
          seatId: c.seatId,
          storePath: c.storePath,
          nextState: tick.nextState,
          rawText: saved.rawText,
          fsOpts,
          notifyFn: opts.notifyFn,
          nowForDeliveryMs: c.nowForDeliveryMs,
        })
      : [];

  return {
    ok: true,
    kind: tick.result.kind,
    reason: tick.result.reason,
    fingerprint: tick.result.fingerprint,
    emitted: tick.emitted,
    delivered,
  };
}

// 사람/ORCH 대상 ack 소비 -- store write 자체(0/1 확정)만 담당, dispatch나
// task 상태 변경은 절대 하지 않는다.
export function ackAdvisory(
  { storePath, seatId, fingerprint, ackedAtMs },
  opts = {},
) {
  const fsOpts = isPlainObject(opts.fs) ? opts.fs : {};
  const loaded = loadStore(storePath, fsOpts);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const acked = recordAck(loaded.state, { seatId, fingerprint, ackedAtMs });
  if (!acked.ok) return { ok: false, reason: "fingerprint-not-found" };
  const saved = saveStoreCAS(storePath, acked.state, loaded.rawText, fsOpts);
  return saved.ok ? { ok: true } : { ok: false, reason: saved.reason };
}

// 다좌석 공통원인 집계(coder-task.md §알림 outbox: "presentation에만" -- 판정
// 영수증은 좌석별 그대로 보존, 이 함수는 어떤 store도 변형하지 않는다).
// items: [{seatId, fingerprint, advisory}] (여러 좌석의 listUndelivered 결과 합)
export function groupForPresentation(items) {
  const list = Array.isArray(items) ? items : [];
  const byReason = new Map();
  for (const item of list) {
    const reason = item?.advisory?.reason ?? "unknown";
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(item);
  }
  return [...byReason.entries()].map(([reason, group]) => ({
    reason,
    seatIds: group.map((g) => g.seatId),
    count: group.length,
    items: group,
  }));
}

export { incarnationKeyOf, normalizeSeatObservation };
