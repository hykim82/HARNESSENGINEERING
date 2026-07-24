// HYK-171-cycle2b-1: 최소 durable observer 상태(coder-task.md §durable=최소만).
// 포함: 마지막 관측 episode/sample 세대, 현재 advisory state, 열린 alert
// fingerprint+delivery/ack, 재시작 후 동일 episode 재발사 방지 근거,
// schema/config/version 결속.
// 비포함(cycle3 몫): dispatch claim, 시작예산, orphan task 재소유, 원자
// dispatch 권위, 강한 distributed leader -- 이 store는 자기 자신의 advisory
// outbox만 지킨다.
//
// 이 모듈은 orca/dispatch/teardown/worker input 호출을 절대 하지 않는다 --
// 순수 상태 변환(applyObservation류) + fs 조회/쓰기 주입(loadStore/saveStore)만
// 있다.

import { shouldEmit } from "./stall-core.mjs";

export const STORE_SCHEMA_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function createEmptyStore() {
  return { schemaVersion: STORE_SCHEMA_VERSION, seats: {} };
}

// incarnation 결속 키(coder-task.md §부분파일·stale·incarnation 결속) --
// task/dispatch/seat 세대가 하나라도 다르면 다른 키가 되므로, 이 키로
// 스코프된 openAdvisories 조회는 과거 세대의 ack가 새 세대를 억제하지
// 못하게 한다(mutation 3).
export function incarnationKeyOf(incarnation) {
  const i = isPlainObject(incarnation) ? incarnation : {};
  return `${i.taskId ?? ""}::${i.dispatchId ?? ""}::${i.seatPaneKey ?? ""}`;
}

function boundFingerprint(incarnationKey, rawFingerprint) {
  return `${incarnationKey}::${rawFingerprint}`;
}

function openAdvisoriesForIncarnation(seatRecord, incarnationKey) {
  if (!isPlainObject(seatRecord) || !isPlainObject(seatRecord.advisories)) {
    return [];
  }
  return Object.entries(seatRecord.advisories)
    .filter(([, a]) => isPlainObject(a) && a.incarnationKey === incarnationKey)
    .map(([fingerprint, a]) => ({ fingerprint, state: a.state }));
}

// applyObservation에서 분리(quality-check 복잡도 상한 준수) -- emit=true일
// 때만 advisory 레코드를 새로 만들거나 갱신한다.
function buildNextAdvisories({
  prevAdvisories,
  emit,
  fp,
  incarnationKey,
  classifyResult,
  persist,
}) {
  const nextAdvisories = { ...prevAdvisories };
  if (!emit) return nextAdvisories;
  const priorEntry = prevAdvisories[fp];
  nextAdvisories[fp] = {
    rawFingerprint: classifyResult?.fingerprint,
    incarnationKey,
    state: classifyResult?.state,
    reason: classifyResult?.reason,
    createdAtMs: priorEntry?.createdAtMs ?? persist?.observedAtMs ?? null,
    updatedAtMs: persist?.observedAtMs ?? null,
    delivery: { status: "pending", attempts: 0, lastAttemptAtMs: null },
    ack: { status: "unacked", ackedAtMs: null },
  };
  return nextAdvisories;
}

// applyObservation에서 분리 -- 최종 seatRecord 조립만 담당.
function buildNextSeatRecord({
  incarnationKey,
  sampleGeneration,
  persist,
  nextAdvisories,
  existing,
}) {
  return {
    incarnationKey,
    episode: {
      sampleGeneration: sampleGeneration ?? null,
      observedAtMs: persist?.observedAtMs ?? null,
      previewNormalized: persist?.previewNormalized ?? null,
      outputChangedAtMs: persist?.outputChangedAtMs ?? null,
    },
    advisories: nextAdvisories,
    lastDegraded: existing?.lastDegraded ?? null,
  };
}

// 순수 reducer: 정상(관측 가능) tick -- classifyResult는 stall-core.classifySeat
// 의 출력을 그대로 받는다(재구현 금지). 반환된 state는 새 객체(입력 state를
// 변형하지 않는다 -- 같은 durable state를 보는 observer 인스턴스 2개가
// 서로의 in-memory 사본을 오염시키지 않게 한다).
//
// input: state, { seatId, incarnation, classifyResult, sampleGeneration, persist }
// output: { state, emitted, boundFingerprint }
export function applyObservation(
  state,
  { seatId, incarnation, classifyResult, sampleGeneration, persist } = {},
) {
  const base = isPlainObject(state) ? state : createEmptyStore();
  const incarnationKey = incarnationKeyOf(incarnation);
  const existing = base.seats?.[seatId];
  const fp = boundFingerprint(incarnationKey, classifyResult?.fingerprint);

  const openList = openAdvisoriesForIncarnation(existing, incarnationKey);
  const emit = shouldEmit({
    advisory: { fingerprint: fp, state: classifyResult?.state },
    openAdvisories: openList,
  });

  const prevAdvisories = isPlainObject(existing?.advisories)
    ? existing.advisories
    : {};
  const nextAdvisories = buildNextAdvisories({
    prevAdvisories,
    emit,
    fp,
    incarnationKey,
    classifyResult,
    persist,
  });
  const nextSeatRecord = buildNextSeatRecord({
    incarnationKey,
    sampleGeneration,
    persist,
    nextAdvisories,
    existing,
  });

  return {
    state: {
      ...base,
      schemaVersion: STORE_SCHEMA_VERSION,
      seats: { ...base.seats, [seatId]: nextSeatRecord },
    },
    emitted: emit,
    boundFingerprint: fp,
  };
}

// mutation 1/9: degraded/unobservable tick -- advisory 확정 판정도 episode
// progress 갱신도 하지 않는다(불완전 관측을 healthy lease 갱신 근거로 쓰지
// 않는다). 오직 진단용 lastDegraded만 남긴다.
export function recordDegradedObservation(
  state,
  { seatId, incarnation, degradedReasons, observedAtMs } = {},
) {
  const base = isPlainObject(state) ? state : createEmptyStore();
  const existing = base.seats?.[seatId];
  const nextSeatRecord = {
    incarnationKey: existing?.incarnationKey ?? incarnationKeyOf(incarnation),
    episode: existing?.episode ?? {
      sampleGeneration: null,
      observedAtMs: null,
      previewNormalized: null,
      outputChangedAtMs: null,
    },
    advisories: existing?.advisories ?? {},
    lastDegraded: {
      reasons: Array.isArray(degradedReasons) ? degradedReasons : [],
      observedAtMs: observedAtMs ?? null,
    },
  };
  return {
    state: {
      ...base,
      schemaVersion: STORE_SCHEMA_VERSION,
      seats: { ...base.seats, [seatId]: nextSeatRecord },
    },
  };
}

// undelivered/pending outbox 항목 -- 전달은 idempotent 재시도 허용(worker
// 자동 retry 금지와는 다른 층위, coder-task.md §알림 outbox).
export function listUndelivered(state) {
  const base = isPlainObject(state) ? state : createEmptyStore();
  const out = [];
  for (const [seatId, seatRecord] of Object.entries(base.seats ?? {})) {
    for (const [fingerprint, a] of Object.entries(
      seatRecord?.advisories ?? {},
    )) {
      if (isPlainObject(a) && a.delivery?.status !== "delivered") {
        out.push({ seatId, fingerprint, advisory: a });
      }
    }
  }
  return out;
}

// mutation 10 근본 수리: "pending -> attempts++" 만으로는 두 인스턴스가
// 같은 tick 안에서 각자 CAS에 성공해버릴 수 있다(둘 다 자신이 방금 쓴
// 최신 state를 기준으로 삼기 때문 -- CAS는 "남이 바꾼 것과 충돌"만 잡지,
// "이미 누가 처리 중"이라는 의미적 잠금은 아니다). 그래서 전달 전에 반드시
// status를 'pending' -> 'claimed'로 배타 전이한다 -- 현재 상태가
// 'pending'이 아니면(이미 claimed/delivered) 실패를 반환해 호출자가
// notifyFn을 아예 부르지 않게 한다.
export function claimForDelivery(
  state,
  { seatId, fingerprint, claimedAtMs } = {},
) {
  const base = isPlainObject(state) ? state : createEmptyStore();
  const seatRecord = base.seats?.[seatId];
  const advisory = seatRecord?.advisories?.[fingerprint];
  if (!advisory) return { state: base, ok: false, reason: "not-found" };
  if (advisory.delivery?.status !== "pending") {
    return { state: base, ok: false, reason: "already-claimed-or-delivered" };
  }
  const nextAdvisory = {
    ...advisory,
    delivery: {
      status: "claimed",
      attempts: advisory.delivery?.attempts ?? 0,
      lastAttemptAtMs: claimedAtMs ?? null,
    },
  };
  return {
    ok: true,
    state: {
      ...base,
      seats: {
        ...base.seats,
        [seatId]: {
          ...seatRecord,
          advisories: { ...seatRecord.advisories, [fingerprint]: nextAdvisory },
        },
      },
    },
  };
}

// 전달 시도 기록(멱등 -- 여러 번 불러도 같은 fingerprint 레코드를 갱신할
// 뿐 새 advisory를 만들지 않는다). delivered:false는 'claimed'에서
// 'pending'으로 되돌려 다음 tick(같은 인스턴스든 다른 인스턴스든)이 다시
// claim을 시도할 수 있게 한다(전달 실패는 무한 잠김이 아니다).
export function markDelivered(
  state,
  { seatId, fingerprint, attemptAtMs, delivered = true } = {},
) {
  const base = isPlainObject(state) ? state : createEmptyStore();
  const seatRecord = base.seats?.[seatId];
  const advisory = seatRecord?.advisories?.[fingerprint];
  if (!advisory) return { state: base, ok: false };
  const nextAdvisory = {
    ...advisory,
    delivery: {
      status: delivered ? "delivered" : "pending",
      attempts: (advisory.delivery?.attempts ?? 0) + 1,
      lastAttemptAtMs: attemptAtMs ?? null,
    },
  };
  return {
    ok: true,
    state: {
      ...base,
      seats: {
        ...base.seats,
        [seatId]: {
          ...seatRecord,
          advisories: { ...seatRecord.advisories, [fingerprint]: nextAdvisory },
        },
      },
    },
  };
}

// ack -- 존재하지 않는(이미 다른 incarnation으로 대체된) fingerprint에
// 대한 ack는 안전하게 no-op(mutation 11: 늦은 ack가 새 episode에 영향을
// 못 미치게 한다).
export function recordAck(state, { seatId, fingerprint, ackedAtMs } = {}) {
  const base = isPlainObject(state) ? state : createEmptyStore();
  const seatRecord = base.seats?.[seatId];
  const advisory = seatRecord?.advisories?.[fingerprint];
  if (!advisory) return { state: base, ok: false };
  const nextAdvisory = {
    ...advisory,
    ack: { status: "acked", ackedAtMs: ackedAtMs ?? null },
  };
  return {
    ok: true,
    state: {
      ...base,
      seats: {
        ...base.seats,
        [seatId]: {
          ...seatRecord,
          advisories: { ...seatRecord.advisories, [fingerprint]: nextAdvisory },
        },
      },
    },
  };
}

// ---- fs 결속(fail-closed 로드/CAS 저장) ----
// 스키마 불일치·손상(JSON.parse 실패)은 항상 ok:false + degraded:true --
// 이 경우 호출자는 이번 tick에서 어떤 확정 판정/ack도 만들지 않는다
// (mutation 9). 파일 부재는 손상이 아니라 "첫 실행"이므로 빈 store로
// 정상 취급한다.
export function parseStoreText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "corrupt-json" };
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (!isPlainObject(parsed.seats)) {
    return { ok: false, reason: "schema-mismatch" };
  }
  return { ok: true, state: parsed };
}

// opts: { existsFn, readFn } -- 둘 다 (path) => value 형태.
export function loadStore(path, opts = {}) {
  const existsFn = opts.existsFn;
  const readFn = opts.readFn;
  if (typeof existsFn !== "function" || typeof readFn !== "function") {
    return { ok: false, reason: "loadStore: existsFn/readFn required" };
  }
  if (!existsFn(path)) {
    return { ok: true, state: createEmptyStore(), rawText: null };
  }
  let text;
  try {
    text = readFn(path);
  } catch (err) {
    return { ok: false, reason: `loadStore: read threw (${err?.message})` };
  }
  const parsed = parseStoreText(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, state: parsed.state, rawText: text };
}

// CAS 저장(mutation 10 대비): 쓰기 직전 다시 읽어 rawTextPrev와 다르면
// 충돌로 보고 쓰지 않는다(다른 인스턴스가 먼저 썼다는 뜻) -- 호출자는
// 충돌 시 재로드 후 재시도하거나(그 결과 이미 반영된 advisory라 자기
// emit이 no-op이 됨을 확인) 이번 tick을 건너뛴다. 원자성은 tmp write +
// rename(둘 다 주입)로 근사한다.
// opts: { existsFn, readFn, writeFn, renameFn }
export function saveStoreCAS(path, nextState, rawTextPrev, opts = {}) {
  const { existsFn, readFn, writeFn, renameFn } = opts;
  if (
    typeof writeFn !== "function" ||
    typeof renameFn !== "function" ||
    typeof existsFn !== "function" ||
    typeof readFn !== "function"
  ) {
    return { ok: false, reason: "saveStoreCAS: fs fns required" };
  }
  const currentRaw = existsFn(path) ? readFn(path) : null;
  if ((currentRaw ?? null) !== (rawTextPrev ?? null)) {
    return { ok: false, reason: "conflict" };
  }
  const tmpPath = `${path}.tmp`;
  const text = JSON.stringify(nextState, null, 2);
  try {
    writeFn(tmpPath, text);
    renameFn(tmpPath, path);
  } catch (err) {
    return { ok: false, reason: `saveStoreCAS: write threw (${err?.message})` };
  }
  return { ok: true, rawText: text };
}
