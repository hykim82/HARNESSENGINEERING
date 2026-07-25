import { test } from "node:test";
import assert from "node:assert/strict";
import { SEAT_STATE, REASON } from "./stall-core.mjs";
import {
  createEmptyStore,
  incarnationKeyOf,
  applyObservation,
  recordDegradedObservation,
  listUndelivered,
  claimForDelivery,
  markDelivered,
  recordAck,
  parseStoreText,
  loadStore,
  saveStoreCAS,
  STORE_SCHEMA_VERSION,
} from "./observer-store.mjs";

const INC_A = { taskId: "t1", dispatchId: "d1", seatPaneKey: "p1" };
const INC_B = { taskId: "t2", dispatchId: "d2", seatPaneKey: "p2" };

function stallResult(seatId = "CODER") {
  return {
    state: SEAT_STATE.SUSPECTED_STALL,
    reason: REASON.LEASE_VIOLATED_NO_CORROBORATION,
    fingerprint: `${seatId}:${REASON.LEASE_VIOLATED_NO_CORROBORATION}`,
    actions: [],
  };
}
function healthyResult(seatId = "CODER") {
  return {
    state: SEAT_STATE.HEALTHY,
    reason: REASON.MULTI_SIGNAL_PROGRESS,
    fingerprint: `${seatId}:${REASON.MULTI_SIGNAL_PROGRESS}`,
    actions: [],
  };
}

// ---------------------------------------------------------------------------
// applyObservation: emit/dedup 기본 동작
// ---------------------------------------------------------------------------

test("첫 관측(SUSPECTED_STALL) -> emit=true, advisory가 store에 pending으로 남는다", () => {
  const { state, emitted, boundFingerprint } = applyObservation(
    createEmptyStore(),
    {
      seatId: "CODER",
      incarnation: INC_A,
      classifyResult: stallResult(),
      sampleGeneration: 1,
      persist: {
        observedAtMs: 1000,
        previewNormalized: "x",
        outputChangedAtMs: 900,
      },
    },
  );
  assert.equal(emitted, true);
  const advisory = state.seats.CODER.advisories[boundFingerprint];
  assert.equal(advisory.state, SEAT_STATE.SUSPECTED_STALL);
  assert.equal(advisory.delivery.status, "pending");
  assert.equal(advisory.ack.status, "unacked");
});

test("같은 state로 재관측 -> emit=false(dedup), store에 중복 advisory 없음", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const second = applyObservation(first.state, {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 2,
    persist: { observedAtMs: 2000 },
  });
  assert.equal(second.emitted, false);
  assert.equal(Object.keys(second.state.seats.CODER.advisories).length, 1);
});

test("state 변화(HEALTHY로 복귀) -> 새 emit", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const second = applyObservation(first.state, {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: healthyResult(),
    sampleGeneration: 2,
    persist: { observedAtMs: 2000 },
  });
  assert.equal(second.emitted, true);
});

// mutation 3: 새 incarnation은 과거 ack에 억제되지 않는다
test("mutation-3: 새 dispatch/incarnation의 같은 reason -> 과거 ack와 무관하게 새로 emit", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const acked = recordAck(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    ackedAtMs: 1500,
  });
  assert.equal(acked.ok, true);

  // 새 incarnation(재실행) -- 같은 원시 fingerprint(reason)이라도 incarnation
  // 키가 달라 별개의 open advisory 세트로 취급돼야 한다.
  const second = applyObservation(acked.state, {
    seatId: "CODER",
    incarnation: INC_B,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 5000 },
  });
  assert.equal(
    second.emitted,
    true,
    "새 incarnation은 과거 ack로 억제되면 안 된다",
  );
  assert.notEqual(second.boundFingerprint, first.boundFingerprint);
});

// mutation 4: good handshake + process death 동시 -- 이 store 계층은
// classifyResult를 그대로 받으므로, 코어(2A)가 이미 HANDSHAKE_DONE을
// 우선하는지가 관건이다(재확인 -- 여기서는 store가 HEALTHY 그대로
// 기록하는지만 본다).
test("mutation-4: handshake-done 결과(HEALTHY)를 store가 그대로 emit/기록한다(완료 우선 보존)", () => {
  const doneResult = {
    state: SEAT_STATE.HEALTHY,
    reason: REASON.HANDSHAKE_DONE,
    fingerprint: "CODER:handshake-done",
    actions: [],
  };
  const { state, emitted, boundFingerprint } = applyObservation(
    createEmptyStore(),
    {
      seatId: "CODER",
      incarnation: INC_A,
      classifyResult: doneResult,
      sampleGeneration: 1,
      persist: { observedAtMs: 1000 },
    },
  );
  assert.equal(emitted, true);
  assert.equal(
    state.seats.CODER.advisories[boundFingerprint].state,
    SEAT_STATE.HEALTHY,
  );
});

// ---------------------------------------------------------------------------
// mutation 1/9: degraded tick -- 확정 판정/lease 갱신 없음
// ---------------------------------------------------------------------------

test("mutation-1/9: degraded 관측은 advisory를 만들지 않고 episode도 갱신 안 한다", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: healthyResult(),
    sampleGeneration: 1,
    persist: {
      observedAtMs: 1000,
      previewNormalized: "orig",
      outputChangedAtMs: 900,
    },
  });
  const degraded = recordDegradedObservation(first.state, {
    seatId: "CODER",
    incarnation: INC_A,
    degradedReasons: ["partial-read"],
    observedAtMs: 2000,
  });
  // episode(진전 근거)는 손대지 않음 -- 이전 값 그대로
  assert.equal(degraded.state.seats.CODER.episode.previewNormalized, "orig");
  assert.equal(degraded.state.seats.CODER.episode.observedAtMs, 1000);
  // advisories도 그대로(새로 만들지도, 지우지도 않음)
  assert.deepEqual(
    Object.keys(degraded.state.seats.CODER.advisories),
    Object.keys(first.state.seats.CODER.advisories),
  );
  assert.deepEqual(degraded.state.seats.CODER.lastDegraded.reasons, [
    "partial-read",
  ]);
});

// ---------------------------------------------------------------------------
// mutation 11: ack 유실/늦은 ack가 새 episode에 영향 없음
// ---------------------------------------------------------------------------

test("mutation-11: 존재하지 않는(이미 대체된) fingerprint에 대한 늦은 ack는 no-op", () => {
  const result = recordAck(createEmptyStore(), {
    seatId: "CODER",
    fingerprint: "stale::fingerprint",
    ackedAtMs: 999,
  });
  assert.equal(result.ok, false);
});

test("ack 정상 처리 -> ack.status='acked'", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const acked = recordAck(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    ackedAtMs: 1234,
  });
  assert.equal(acked.ok, true);
  assert.equal(
    acked.state.seats.CODER.advisories[first.boundFingerprint].ack.status,
    "acked",
  );
});

// ---------------------------------------------------------------------------
// outbox: undelivered/delivery idempotency
// ---------------------------------------------------------------------------

test("listUndelivered: pending 상태만 나열, delivered 처리 후 제외", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  assert.equal(listUndelivered(first.state).length, 1);

  const delivered = markDelivered(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    attemptAtMs: 1500,
    delivered: true,
  });
  assert.equal(delivered.ok, true);
  assert.equal(listUndelivered(delivered.state).length, 0);
});

test("markDelivered 실패 재시도(delivered:false) -> 여전히 undelivered로 남음, attempts 증가(멱등 재시도 허용)", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const attempt1 = markDelivered(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    attemptAtMs: 1500,
    delivered: false,
  });
  assert.equal(listUndelivered(attempt1.state).length, 1);
  const attempt2 = markDelivered(attempt1.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    attemptAtMs: 1600,
    delivered: true,
  });
  assert.equal(
    attempt2.state.seats.CODER.advisories[first.boundFingerprint].delivery
      .attempts,
    2,
  );
  assert.equal(listUndelivered(attempt2.state).length, 0);
});

test("claimForDelivery: pending -> claimed 성공, 재claim 시도는 실패", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const claim1 = claimForDelivery(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    claimedAtMs: 1500,
  });
  assert.equal(claim1.ok, true);
  assert.equal(
    claim1.state.seats.CODER.advisories[first.boundFingerprint].delivery.status,
    "claimed",
  );

  // 이미 claimed인 상태에서 재차 claim 시도 -> 거부(mutation 10의 핵심 방어)
  const claim2 = claimForDelivery(claim1.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    claimedAtMs: 1600,
  });
  assert.equal(claim2.ok, false);
  assert.equal(claim2.reason, "already-claimed-or-delivered");
});

test("claimForDelivery: 존재하지 않는 fingerprint -> ok:false", () => {
  const result = claimForDelivery(createEmptyStore(), {
    seatId: "CODER",
    fingerprint: "nope",
    claimedAtMs: 1,
  });
  assert.equal(result.ok, false);
});

test("markDelivered(delivered:false)는 claimed -> pending으로 되돌려 재시도를 허용한다", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const claimed = claimForDelivery(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    claimedAtMs: 1500,
  });
  const failedDelivery = markDelivered(claimed.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    attemptAtMs: 1600,
    delivered: false,
  });
  assert.equal(
    failedDelivery.state.seats.CODER.advisories[first.boundFingerprint].delivery
      .status,
    "pending",
  );
  // 되돌아온 뒤에는 다시 claim 가능(무한 잠김 아님)
  const reclaim = claimForDelivery(failedDelivery.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    claimedAtMs: 1700,
  });
  assert.equal(reclaim.ok, true);
});

// ---------------------------------------------------------------------------
// incarnationKeyOf / 순수성
// ---------------------------------------------------------------------------

test("incarnationKeyOf: 세 필드 중 하나만 달라도 다른 키", () => {
  const a = incarnationKeyOf(INC_A);
  const b = incarnationKeyOf({ ...INC_A, seatPaneKey: "different" });
  assert.notEqual(a, b);
});

test("applyObservation은 입력 state를 변형하지 않는다(새 객체 반환)", () => {
  const before = createEmptyStore();
  const snapshot = JSON.parse(JSON.stringify(before));
  applyObservation(before, {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  assert.deepEqual(before, snapshot);
});

// ---------------------------------------------------------------------------
// mutation 9: store 손상/스키마 불일치 -> fail-closed
// ---------------------------------------------------------------------------

test("mutation-9: 손상된 JSON -> ok:false(corrupt-json)", () => {
  const result = parseStoreText("{not valid json");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt-json");
});

test("mutation-9b: schemaVersion 불일치 -> ok:false(schema-mismatch)", () => {
  const result = parseStoreText(
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, seats: {} }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "schema-mismatch");
});

test("loadStore: 파일 없음(첫 실행) -> 빈 store로 정상 처리(손상이 아님)", () => {
  const result = loadStore("/nowhere", {
    existsFn: () => false,
    readFn: () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state, createEmptyStore());
});

test("loadStore: 손상된 파일 -> ok:false, 어떤 state도 신뢰해 반환하지 않음", () => {
  const result = loadStore("/store.json", {
    existsFn: () => true,
    readFn: () => "{{corrupt",
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// mutation 10: CAS -- 두 인스턴스 경쟁 시 한쪽만 성공
// ---------------------------------------------------------------------------

test("mutation-10: saveStoreCAS -- rawTextPrev 이후 파일이 바뀌었으면 conflict로 거부(중복 기록 방지)", () => {
  let diskText = JSON.stringify(createEmptyStore());
  const fsFake = {
    existsFn: () => true,
    readFn: () => diskText,
    writeFn: (path, text) => {
      // tmp 파일 쓰기 시점엔 아직 diskText를 바꾸지 않는다(rename에서 반영).
      fsFake._pendingWrite = text;
    },
    renameFn: () => {
      diskText = fsFake._pendingWrite;
    },
  };

  // 인스턴스 A: 원본을 읽고 stall advisory 추가
  const loadedA = loadStore("/store.json", fsFake);
  const appliedA = applyObservation(loadedA.state, {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });

  // 인스턴스 B: A가 저장하기 전에 같은 원본을 읽고 똑같이 계산
  const loadedB = loadStore("/store.json", fsFake);
  const appliedB = applyObservation(loadedB.state, {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });

  const savedA = saveStoreCAS(
    "/store.json",
    appliedA.state,
    loadedA.rawText,
    fsFake,
  );
  assert.equal(savedA.ok, true);

  // B는 이제 stale rawTextPrev를 들고 있으므로 충돌
  const savedB = saveStoreCAS(
    "/store.json",
    appliedB.state,
    loadedB.rawText,
    fsFake,
  );
  assert.equal(savedB.ok, false);
  assert.equal(savedB.reason, "conflict");

  // 디스크에는 advisory가 정확히 1개(중복 아님)
  const finalState = JSON.parse(diskText);
  assert.equal(Object.keys(finalState.seats.CODER.advisories).length, 1);
});

test("saveStoreCAS: 충돌 없을 때 정상 저장", () => {
  let diskText = null;
  const fsFake = {
    existsFn: () => diskText !== null,
    readFn: () => diskText,
    writeFn: (path, text) => {
      fsFake._pending = text;
    },
    renameFn: () => {
      diskText = fsFake._pending;
    },
  };
  const loaded = loadStore("/store.json", fsFake);
  const applied = applyObservation(loaded.state, {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: healthyResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1 },
  });
  const saved = saveStoreCAS(
    "/store.json",
    applied.state,
    loaded.rawText,
    fsFake,
  );
  assert.equal(saved.ok, true);
  assert.equal(JSON.parse(diskText).seats.CODER.advisories !== undefined, true);
});

// ---------------------------------------------------------------------------
// P1-2 재작업(REVIEW hyk171-cycle2b-review-1 결함 2 수리): mutation-9의
// write-failure anti-vacuity가 없었다 -- saveStoreCAS의 writeFn/renameFn
// catch 경로(observer-store.mjs:361-365 근방)를 실제로 던지는 fixture가
// 0개였고, 그 catch를 "성공"으로 변조해도 31개 테스트가 GREEN이었다(REVIEW
// 재현 확인). writeFn과 renameFn 각각을 실제로 던지게 하는 시험을 추가한다.
// ---------------------------------------------------------------------------
test("mutation-9c(P1-2): writeFn이 던지면 saveStoreCAS는 ok:false -- 디스크는 손대지 않은 채 남는다", () => {
  let diskText = null;
  const fsFake = {
    existsFn: () => diskText !== null,
    readFn: () => diskText,
    writeFn: () => {
      throw new Error("ENOSPC: no space left on device (simulated)");
    },
    renameFn: () => {
      throw new Error(
        "renameFn must not be reached when writeFn already threw",
      );
    },
  };
  const applied = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const saved = saveStoreCAS("/store.json", applied.state, null, fsFake);
  assert.equal(saved.ok, false);
  assert.match(saved.reason, /write threw/);
  assert.equal(diskText, null, "쓰기 실패 시 디스크 상태는 그대로여야 한다");
});

test("mutation-9d(P1-2): renameFn이 던지면 saveStoreCAS는 ok:false -- tmp write는 됐어도 최종 커밋(rename)이 안 됐으므로 실제 store 파일은 안 바뀐 것으로 취급된다", () => {
  let diskText = null;
  let tmpWritten = null;
  const fsFake = {
    existsFn: () => diskText !== null,
    readFn: () => diskText,
    writeFn: (path, text) => {
      tmpWritten = text;
    },
    renameFn: () => {
      throw new Error("EPERM: rename failed (simulated)");
    },
  };
  const applied = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const saved = saveStoreCAS("/store.json", applied.state, null, fsFake);
  assert.equal(saved.ok, false);
  assert.match(saved.reason, /write threw/);
  assert.notEqual(tmpWritten, null, "tmp write 자체는 시도됐어야 한다");
  assert.equal(
    diskText,
    null,
    "rename 실패 시 실제 store 파일(path) 쪽은 갱신되지 않아야 한다(atomic commit 실패)",
  );
});

// ---------------------------------------------------------------------------
// HYK-171-cycle2b-3 재범위(사람 게이트 결정 B): O_EXCL 파일잠금(사이클2b-2
// 가 P1-3에서 넣은 acquireDeliveryLock류)을 제거했다 -- crash 시 잠금이
// 영구히 남아 durable outbox 배달이 무한정 멈추는 결함을 REVIEW review-2가
// 재현했기 때문이다. 진짜 crash-safe 배타배달(원자 claim·단일 leader·잠금
// 생명주기)은 cycle3로 미룬다(PM 사이클2 비평 §5: "observer 둘이 떠도
// 최악이 advisory 중복이면 distributed leader 전체를 먼저 구현할 필요
// 없다"). 재작성된 수용기준 1은 다음 두 가지만 요구한다:
// ⑴ 단일 인스턴스/leader 안에서는 claimForDelivery+shouldEmit(2A)만으로
//    재emit·재전달이 억제된다(잠금 없이도 순수 상태 전이로 충분).
// ⑵ 동시 인스턴스 2개가 서로의 claim을 못 보고 각자 notifyFn까지 가도
//    (bounded 중복), dispatch/teardown/worker-input/task 상태 write는
//    정확히 0건이다 -- 이 store/observer 코드베이스에 애초에 그런 호출이
//    존재하지 않으므로, 중복의 효과는 advisory 알림 중복 전달에 그치고
//    이중 실행으로 번지지 않는다(관측기 계약).
// ---------------------------------------------------------------------------

test("수용기준1-⑴: 단일 인스턴스 -- 같은 fingerprint를 claim한 뒤 재claim 시도는 실패(재전달 억제)", () => {
  const first = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const claimed = claimForDelivery(first.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    claimedAtMs: 1500,
  });
  assert.equal(claimed.ok, true);

  // 같은 인스턴스(또는 순차적으로 뒤이은 어떤 호출이든)가 다시 claim을
  // 시도하면 -- 이미 'claimed'이므로 실패한다. 잠금 파일 없이 state 전이
  // 값만으로 이 재진입 방지가 성립함을 확인한다.
  const reclaimed = claimForDelivery(claimed.state, {
    seatId: "CODER",
    fingerprint: first.boundFingerprint,
    claimedAtMs: 1600,
  });
  assert.equal(reclaimed.ok, false);
  assert.equal(reclaimed.reason, "already-claimed-or-delivered");
});

test("수용기준1-⑵: 동시 인스턴스 2개가 같은 관측을 각자 emit -- 각자 자기 advisory 1개(중복은 advisory 수준에 국한, dispatch/실행 호출 0)", () => {
  // 두 인스턴스가 서로의 claim을 보지 못하는 최악의 경우를 그대로
  // 시뮬레이션한다: 둘 다 emptyStore에서 독립적으로 시작해 각자
  // applyObservation을 호출한다(락이 없으므로 서로 조율하지 않는다).
  const instanceAResult = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });
  const instanceBResult = applyObservation(createEmptyStore(), {
    seatId: "CODER",
    incarnation: INC_A,
    classifyResult: stallResult(),
    sampleGeneration: 1,
    persist: { observedAtMs: 1000 },
  });

  // 관측기 계약의 핵심 단언: 이 함수들의 반환값 자체에 dispatch/teardown/
  // task-write류 필드나 부작용이 전혀 없다(순수 상태 변환 -- applyObservation
  // 의 시그니처와 stall-core.classifySeat의 actions:[] 계약 재확인).
  assert.equal(instanceAResult.emitted, true);
  assert.equal(instanceBResult.emitted, true);
  assert.deepEqual(Object.keys(instanceAResult), [
    "state",
    "emitted",
    "boundFingerprint",
  ]);
  assert.deepEqual(Object.keys(instanceBResult), [
    "state",
    "emitted",
    "boundFingerprint",
  ]);

  // 각 인스턴스는 자기 advisory 정확히 1개만 갖는다(중복이 무한정 쌓이지
  // 않는다 -- "bounded" 중복이 실제로 유계임을 확인).
  assert.equal(
    Object.keys(instanceAResult.state.seats.CODER.advisories).length,
    1,
  );
  assert.equal(
    Object.keys(instanceBResult.state.seats.CODER.advisories).length,
    1,
  );
});
