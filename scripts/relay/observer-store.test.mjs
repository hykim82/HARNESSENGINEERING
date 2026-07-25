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
  deliveryLockPath,
  acquireDeliveryLock,
  releaseDeliveryLock,
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
// P1-3 재작업(REVIEW hyk171-cycle2b-review-1 결함 3 수리): claimForDelivery+
// saveStoreCAS만으로는 두 인스턴스 배타를 보장 못한다(check-then-act
// TOCTOU -- REVIEW의 interleaving probe가 claimA=true·claimB=true·
// savedA=true·savedB=true를 실제 재현했다). acquireDeliveryLock(O_EXCL 기반
// 원자적 파일 생성)이 이 배타를 대신 보장하는지 직접, 스케줄링에 기대지
// 않고 확정적으로 시험한다 -- Promise.all의 우연한 실행순서에 기대는 게
// 아니라, 같은 lockPath에 대한 두 번째 시도가 "항상" 실패함을 직접 호출로
// 검증한다.
// ---------------------------------------------------------------------------
test("P1-3(acquireDeliveryLock): 같은 lockPath 두 번째 시도는 항상 실패 -- 첫 시도가 놓은 뒤에만 재시도 가능(무한 잠김 아님)", () => {
  const locks = new Set();
  const fsOpts = {
    writeExclusiveFn: (path) => {
      if (locks.has(path)) {
        const err = new Error(`EEXIST: '${path}' already exists`);
        err.code = "EEXIST";
        throw err;
      }
      locks.add(path);
    },
    unlinkFn: (path) => {
      locks.delete(path);
    },
  };
  const lockPath = deliveryLockPath("/store.json", "CODER:some-reason");

  const first = acquireDeliveryLock(lockPath, fsOpts);
  assert.equal(first.ok, true);

  // 두 번째 "인스턴스"가 첫 인스턴스의 write와 release 사이 아무 시점에
  // 시도해도(REVIEW의 재진입 시나리오와 동형) 반드시 실패해야 한다 --
  // 이 실패는 store의 read-compare 결과와 무관하게 파일시스템 자체의
  // O_EXCL 보장에서 나온다(store 상태를 전혀 참조하지 않는다).
  const second = acquireDeliveryLock(lockPath, fsOpts);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already locked/);

  const released = releaseDeliveryLock(lockPath, fsOpts);
  assert.equal(released.ok, true);

  // 해제 후에는 재시도가 가능해야 한다 -- 전달 실패/크래시가 영구 잠김이
  // 되면 안 된다(claimForDelivery의 pending 복귀 원칙과 동형).
  const third = acquireDeliveryLock(lockPath, fsOpts);
  assert.equal(third.ok, true);
});

test("P1-3(deliveryLockPath): fingerprint가 달라지면 lockPath도 달라진다(서로 다른 알림이 서로를 잠그지 않음)", () => {
  const a = deliveryLockPath("/store.json", "CODER:reason-a");
  const b = deliveryLockPath("/store.json", "REVIEW:reason-b");
  assert.notEqual(a, b);
});
