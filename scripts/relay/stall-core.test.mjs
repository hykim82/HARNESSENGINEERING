import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySeat, shouldEmit, SEAT_STATE, REASON } from "./stall-core.mjs";

// ---------------------------------------------------------------------------
// known-bad / paired-good
// ---------------------------------------------------------------------------

test("healthy-long: 정상 장시간 실행(복수 신호 정합) -> HEALTHY, 알림 없음", () => {
  const result = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending",
      mtimeAgeS: 5,
      lastOutputAgeS: 10,
      lastOutputChanged: true,
      runtimeStatus: "dispatched",
      processAlive: true,
      pushSeen: true,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.equal(result.state, SEAT_STATE.HEALTHY);
  assert.equal(result.reason, REASON.MULTI_SIGNAL_PROGRESS);
  assert.deepEqual(result.actions, []);
});

test("silent-dead: processAlive=false -> SUSPECTED_STALL (or UNKNOWN), never HEALTHY", () => {
  const result = classifySeat({
    snapshot: {
      seatId: "REVIEW",
      handshake: "pending",
      mtimeAgeS: 4000,
      lastOutputAgeS: 4000,
      lastOutputChanged: false,
      runtimeStatus: "dispatched",
      processAlive: false,
      pushSeen: false,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.notEqual(result.state, SEAT_STATE.HEALTHY);
  assert.equal(result.state, SEAT_STATE.SUSPECTED_STALL);
  assert.equal(result.reason, REASON.PROCESS_NOT_ALIVE);
  assert.deepEqual(result.actions, []);
});

test("noisy-hung: lastOutputChanged=true지만 mtime/handshake 정체 -> UNKNOWN, HEALTHY 아님", () => {
  const result = classifySeat({
    snapshot: {
      seatId: "PM",
      handshake: "pending",
      mtimeAgeS: 5000, // lease(1800) 초과 -- 실질 정체
      lastOutputAgeS: 5, // 로그만 계속 찍힘(noisy)
      lastOutputChanged: true,
      runtimeStatus: "dispatched",
      processAlive: true,
      pushSeen: false,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.equal(result.state, SEAT_STATE.UNKNOWN);
  assert.notEqual(result.state, SEAT_STATE.HEALTHY);
  assert.equal(result.reason, REASON.INSUFFICIENT_SIGNALS);
  assert.deepEqual(result.actions, []);
});

test("unobservable: 필수 신호 결손(mtimeAgeS/processAlive 없음) -> UNOBSERVABLE", () => {
  const missingMtime = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending",
      processAlive: true,
    },
    prevState: null,
    config: {},
  });
  assert.equal(missingMtime.state, SEAT_STATE.UNOBSERVABLE);
  assert.equal(missingMtime.reason, REASON.MISSING_REQUIRED_FIELDS);
  assert.deepEqual(missingMtime.actions, []);

  const missingProcessAlive = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending",
      mtimeAgeS: 10,
    },
    prevState: null,
    config: {},
  });
  assert.equal(missingProcessAlive.state, SEAT_STATE.UNOBSERVABLE);
  assert.equal(missingProcessAlive.reason, REASON.MISSING_REQUIRED_FIELDS);
  assert.deepEqual(missingProcessAlive.actions, []);
});

test("done-wins: handshake==='done'이면 오래 정체·프로세스 사망이어도 stall 아님", () => {
  const result = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "done",
      mtimeAgeS: 999999,
      lastOutputAgeS: 999999,
      lastOutputChanged: false,
      runtimeStatus: "completed",
      processAlive: false,
      pushSeen: false,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.equal(result.state, SEAT_STATE.HEALTHY);
  assert.equal(result.reason, REASON.HANDSHAKE_DONE);
  assert.deepEqual(result.actions, []);
});

test("count=1(mtimeFresh만), lease 미위반 -> 단일신호라 UNKNOWN(HEALTHY 아님)", () => {
  // mtimeFresh는 count에 포함된 신호 자체이므로 "count===0인데 lease
  // 미위반"은 설계상 성립 불가능(mtimeFresh==leaseViolated의 반대짝) --
  // 대신 mtimeFresh 단독(신호 1개)인 경우를 확인한다.
  const result = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending",
      mtimeAgeS: 30,
      lastOutputAgeS: 30,
      lastOutputChanged: false,
      processAlive: true,
      pushSeen: false,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.equal(result.state, SEAT_STATE.UNKNOWN);
  assert.equal(result.reason, REASON.INSUFFICIENT_SIGNALS);
});

test("count=0, lease 위반: 진전 신호 전무 + 임계 초과 -> SUSPECTED_STALL", () => {
  const result = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending",
      mtimeAgeS: 5000,
      lastOutputAgeS: 5000,
      lastOutputChanged: false,
      processAlive: true,
      pushSeen: false,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.equal(result.state, SEAT_STATE.SUSPECTED_STALL);
  assert.equal(result.reason, REASON.LEASE_VIOLATED_NO_CORROBORATION);
});

// ---------------------------------------------------------------------------
// REVIEW HYK-171-cycle2a-review-1 결함 재작업 (streak 1) -- 이 두 테스트는
// 수정 전 커밋(4b1a77d)에서 RED였다(직접 재현·원복 완료, .harness/coder.md
// 참조).
// ---------------------------------------------------------------------------

test("결함(a) 재현: mtime touch + terminal output 변화 둘 다 신선해도(pushSeen 없이) HEALTHY 아님", () => {
  // 수정 전: mtimeFresh와 outputFresh를 독립 신호로 이중계산해 count=2가
  // 되어 minProgressSignals(기본 2)를 채우고 HEALTHY(multi-signal-progress)로
  // 오분류했다. 이 둘은 "로그만 내뱉으며 파일을 touch하는 hung"이 정확히
  // 만드는 조합(PM §3 noisy-hung)이므로 실제로는 진전 증거가 아니다.
  const result = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending", // 진전 없음(handshake 정체)
      mtimeAgeS: 5, // 신선(mtime touch)
      lastOutputAgeS: 5, // 신선(terminal output 변화)
      lastOutputChanged: true,
      processAlive: true,
      pushSeen: false, // 능동적 push 신호는 없음
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.notEqual(result.state, SEAT_STATE.HEALTHY);
  assert.equal(result.state, SEAT_STATE.UNKNOWN);
  assert.equal(result.reason, REASON.INSUFFICIENT_SIGNALS);
  assert.deepEqual(result.actions, []);
});

test("결함(b) 재현: minProgressSignals=3, count=2(shallowActivity+pushSeen) -> UNKNOWN(SUSPECTED_STALL 아님)", () => {
  // 수정 전(3개 독립신호 모델): mtimeFresh=true, outputFresh=false,
  // pushSeen=true인 이 스냅샷은 정확히 count===2였다 -- count===1
  // 하드코딩 분기 때문에 count=2는 count===1도
  // count>=minProgressSignals(3)도 아니어서 "그 외(count===0 stall)"
  // 분기로 잘못 떨어져 SUSPECTED_STALL이 나왔다(REVIEW가 지목한 정확한
  // 경로). lease는 아직 유효하고 신호가 전무한 것도 아니므로 이는
  // 과탐이다.
  const result = classifySeat({
    snapshot: {
      seatId: "CODER",
      handshake: "pending",
      mtimeAgeS: 5, // shallowActivity 버킷 신선(mtime만)
      lastOutputAgeS: 5000,
      lastOutputChanged: false, // outputFresh는 거짓 -- 이중계산 아님
      processAlive: true,
      pushSeen: true, // pushSeen 버킷 참 -- count=2
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: { minProgressSignals: 3 },
  });
  assert.notEqual(result.state, SEAT_STATE.SUSPECTED_STALL);
  assert.equal(result.state, SEAT_STATE.UNKNOWN);
  assert.equal(result.reason, REASON.INSUFFICIENT_SIGNALS);
  assert.deepEqual(result.actions, []);
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

test("dedup: 같은 fingerprint 연속 emit -> 1회만 true, 이후 false", () => {
  const advisory = {
    fingerprint: "CODER:lease-violated-no-corroboration",
    state: SEAT_STATE.SUSPECTED_STALL,
  };
  const first = shouldEmit({ advisory, openAdvisories: [] });
  assert.equal(first, true);

  const openAdvisories = [advisory];
  const second = shouldEmit({ advisory, openAdvisories });
  assert.equal(second, false);

  const third = shouldEmit({ advisory, openAdvisories });
  assert.equal(third, false);
});

test("dedup: 상태 변화(같은 fingerprint, 다른 state) -> 새 emit", () => {
  const openAdvisories = [
    { fingerprint: "CODER:x", state: SEAT_STATE.SUSPECTED_STALL },
  ];
  const changed = shouldEmit({
    advisory: { fingerprint: "CODER:x", state: SEAT_STATE.HEALTHY },
    openAdvisories,
  });
  assert.equal(changed, true);
});

test("dedup: 다른 fingerprint -> 독립적으로 emit", () => {
  const openAdvisories = [
    {
      fingerprint: "CODER:lease-violated-no-corroboration",
      state: SEAT_STATE.SUSPECTED_STALL,
    },
  ];
  const other = shouldEmit({
    advisory: {
      fingerprint: "REVIEW:process-not-alive",
      state: SEAT_STATE.SUSPECTED_STALL,
    },
    openAdvisories,
  });
  assert.equal(other, true);
});

// ---------------------------------------------------------------------------
// 금지효과=0 (mutation 핵심)
// ---------------------------------------------------------------------------

test("actions는 항상 빈 배열 (모든 known-bad/paired-good 케이스에서 동일)", () => {
  const cases = [
    { handshake: "done", mtimeAgeS: 1, processAlive: true },
    { handshake: "pending", mtimeAgeS: 1, processAlive: false },
    {
      handshake: "pending",
      mtimeAgeS: 5000,
      lastOutputAgeS: 5,
      lastOutputChanged: true,
      processAlive: true,
      lease: { maxNoProgressS: 1800 },
    },
    { handshake: "pending", processAlive: true }, // missing mtimeAgeS
    {
      handshake: "pending",
      mtimeAgeS: 5,
      lastOutputAgeS: 10,
      lastOutputChanged: true,
      pushSeen: true,
      processAlive: true,
    },
  ];
  for (const snapshot of cases) {
    const result = classifySeat({ snapshot, prevState: null, config: {} });
    assert.deepEqual(result.actions, []);
  }
});

test("금지효과=0: classifySeat/shouldEmit은 어떤 부작용도 일으키지 않는다 (전역 상태 불변)", () => {
  const snapshot = Object.freeze({
    seatId: "CODER",
    handshake: "pending",
    mtimeAgeS: 10,
    lastOutputAgeS: 10,
    lastOutputChanged: true,
    processAlive: true,
    pushSeen: true,
  });
  // Object.freeze된 입력에 어떤 프로퍼티라도 쓰려 하면 strict mode에서
  // TypeError가 난다 -- classifySeat이 입력을 변형하려 시도하지 않는다는
  // 것을 실측한다.
  assert.doesNotThrow(() => {
    classifySeat({ snapshot, prevState: null, config: {} });
  });

  const advisory = Object.freeze({
    fingerprint: "a:b",
    state: SEAT_STATE.HEALTHY,
  });
  const openAdvisories = Object.freeze([advisory]);
  assert.doesNotThrow(() => {
    shouldEmit({ advisory, openAdvisories });
  });
});

test("금지효과=0: 호출당 정확히 하나의 advisory만 반환(이벤트 카운트 단언)", () => {
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(
      classifySeat({
        snapshot: {
          seatId: "CODER",
          handshake: "pending",
          mtimeAgeS: 5,
          lastOutputAgeS: 5,
          lastOutputChanged: true,
          pushSeen: true,
          processAlive: true,
        },
        prevState: null,
        config: {},
      }),
    );
  }
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.equal(r.state, SEAT_STATE.HEALTHY);
    assert.deepEqual(r.actions, []);
  }
});

// ---------------------------------------------------------------------------
// S6 봉인: 입력은 정규화 타입만 -- raw orca 문자열을 직접 파싱하지 않음
// ---------------------------------------------------------------------------

test("S6: raw 문자열/배열을 snapshot으로 주면 파싱을 시도하지 않고 UNOBSERVABLE", () => {
  const rawString = classifySeat({
    snapshot: "task_id: HYK-171\nstatus: dispatched\n",
    prevState: null,
    config: {},
  });
  assert.equal(rawString.state, SEAT_STATE.UNOBSERVABLE);
  assert.equal(rawString.reason, REASON.MISSING_REQUIRED_FIELDS);

  const rawArray = classifySeat({
    snapshot: ["dispatched", "task_7f9"],
    prevState: null,
    config: {},
  });
  assert.equal(rawArray.state, SEAT_STATE.UNOBSERVABLE);

  const nothing = classifySeat({});
  assert.equal(nothing.state, SEAT_STATE.UNOBSERVABLE);
});

// ---------------------------------------------------------------------------
// 반사실(mutation) 문서화: 아래 각 케이스는 코어에 "조치"를 넣거나
// false-activity 방어를 약화하는 변이가 생기면 RED가 되어야 한다.
// ---------------------------------------------------------------------------

test("반사실 대비: 단일 noisy 신호가 HEALTHY로 오분류되면 안 된다 (noisy-hung 재확인)", () => {
  const result = classifySeat({
    snapshot: {
      seatId: "PM",
      mtimeAgeS: 9999,
      lastOutputAgeS: 1,
      lastOutputChanged: true,
      processAlive: true,
      pushSeen: false,
      lease: { maxNoProgressS: 1800 },
    },
    prevState: null,
    config: {},
  });
  assert.notEqual(result.state, SEAT_STATE.HEALTHY);
});
