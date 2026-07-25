import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SEAT_STATE, REASON } from "./stall-core.mjs";
import {
  reduceTick,
  runObserverTick,
  ackAdvisory,
  groupForPresentation,
  OBSERVER_STATE,
} from "./stall-observer.mjs";
import { createEmptyStore } from "./observer-store.mjs";
import { normalizeSeatObservation } from "./adapters/seat-signal-adapter.mjs";

const INC_A = { taskId: "t1", dispatchId: "d1", seatPaneKey: "p1" };

// ---------------------------------------------------------------------------
// S6: 이 파일은 orca를 실제로 spawn하지 않는다(static G9 -- 이 소스에 literal
// "orca" spawn 패턴 없음) + runtime(G10) -- poisoned execFn으로 실 호출
// 시도가 있으면 즉시 실패하도록 아래 전 시나리오에서 execFn을 명시 주입한다.
// ---------------------------------------------------------------------------
function poisonedExecFn() {
  throw new Error(
    "S6 violation: real orca CLI invoked from observer-only path",
  );
}

test("S6 static: 이 테스트 파일 자신을 포함해 stall-observer.mjs 소스에 orca spawn 리터럴 없음", () => {
  const here = fileURLToPath(import.meta.url);
  const observerSrc = readFileSync(
    here.replace(/\.test\.mjs$/, ".mjs"),
    "utf8",
  );
  const EXEC_CALL_RE =
    /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["'`]orca["'`]/;
  assert.equal(EXEC_CALL_RE.test(observerSrc), false);
});

// 순수 fake-adapter 관측 빌더 -- collectSeatObservation(impure, execFn 필요)을
// 전혀 거치지 않고 normalizeSeatObservation(순수)만으로 관측을 조립한다.
// orca-adapter.mjs의 execFn 팩토리는 이 경로에서 단 한 번도 호출되지 않는다.
function fakeHealthyObservation(now = 1000) {
  return normalizeSeatObservation({
    now,
    seatId: "CODER",
    expectedIncarnation: INC_A,
    resultStat: { mtimeMs: now - 5000, size: 1 },
    handshakeResult: { ok: false, reason: "result file not found" },
    dispatchShow: {
      ok: true,
      result: {
        dispatch: {
          status: "dispatched",
          assignee_pane_key: "p1",
          task_id: "t1",
          id: "d1",
        },
      },
    },
    terminalShow: {
      ok: true,
      result: { terminal: { preview: "progress line" } },
    },
    terminalListResponse: {
      ok: true,
      result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
    },
    seatSelector: { handle: "h1" },
    pushEvents: [{ type: "heartbeat", taskId: "t1", dispatchId: "d1" }],
    prevPreviewNormalized: "different previous line",
    prevOutputChangedAtMs: now - 1000,
    prevObservedAtMs: now - 60_000,
  });
}

function fakeStalledObservation(now = 10_000_000) {
  // now/mtimeMs/outputChangedAtMs는 모두 ms 단위(어댑터가 /1000으로 초를
  // 구한다) -- 9999초 정체를 표현하려면 ms로 9999*1000을 빼야 한다.
  return normalizeSeatObservation({
    now,
    seatId: "CODER",
    expectedIncarnation: INC_A,
    resultStat: { mtimeMs: now - 9999 * 1000, size: 1 },
    handshakeResult: { ok: false, reason: "result file not found" },
    dispatchShow: {
      ok: true,
      result: {
        dispatch: {
          status: "dispatched",
          assignee_pane_key: "p1",
          task_id: "t1",
          id: "d1",
        },
      },
    },
    terminalShow: { ok: true, result: { terminal: { preview: "same" } } },
    terminalListResponse: {
      ok: true,
      result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
    },
    seatSelector: { handle: "h1" },
    pushEvents: [],
    prevPreviewNormalized: "same",
    prevOutputChangedAtMs: now - 9999 * 1000,
    prevObservedAtMs: now - 60_000,
  });
}

// ---------------------------------------------------------------------------
// reduceTick: 결선 -- classify -> store 반영
// ---------------------------------------------------------------------------

test("reduceTick: 관측 가능 + healthy -> HEALTHY, emitted=true(첫 관측)", () => {
  const observation = fakeHealthyObservation();
  const { nextState, emitted, result } = reduceTick({
    state: createEmptyStore(),
    seatId: "CODER",
    incarnation: INC_A,
    observation,
    sampleGeneration: 1,
  });
  assert.equal(result.kind, SEAT_STATE.HEALTHY);
  assert.equal(emitted, true);
  assert.equal(Object.keys(nextState.seats.CODER.advisories).length, 1);
});

test("reduceTick: 관측 불가(quality.observable=false) -> ADAPTER_DEGRADED, advisory 생성 없음", () => {
  const observation = {
    snapshot: { seatId: "CODER" },
    quality: {
      observable: false,
      degradedReasons: ["control-plane-query-failed"],
      sourceFailureDomain: "control-plane",
    },
    persist: { observedAtMs: 1000 },
  };
  const { nextState, emitted, result } = reduceTick({
    state: createEmptyStore(),
    seatId: "CODER",
    incarnation: INC_A,
    observation,
  });
  assert.equal(result.kind, OBSERVER_STATE.ADAPTER_DEGRADED);
  assert.equal(emitted, false);
  assert.deepEqual(nextState.seats.CODER.advisories, {});
});

test("reduceTick: stalled 관측 -> SUSPECTED_STALL, emitted=true", () => {
  const observation = fakeStalledObservation();
  const { result, emitted } = reduceTick({
    state: createEmptyStore(),
    seatId: "CODER",
    incarnation: INC_A,
    observation,
  });
  assert.equal(result.kind, SEAT_STATE.SUSPECTED_STALL);
  assert.equal(emitted, true);
});

test("reduceTick: 연속 같은 stall -> 두번째부터 emitted=false(dedup, mutation 없음 -- cycle2a shouldEmit 재사용 확인)", () => {
  const first = reduceTick({
    state: createEmptyStore(),
    seatId: "CODER",
    incarnation: INC_A,
    observation: fakeStalledObservation(1000),
  });
  const second = reduceTick({
    state: first.nextState,
    seatId: "CODER",
    incarnation: INC_A,
    observation: fakeStalledObservation(2000),
  });
  assert.equal(second.emitted, false);
});

// ---------------------------------------------------------------------------
// P1-1 재작업(REVIEW hyk171-cycle2b-review-1 결함 1 수리): mutation-4 시험이
// vacuous였다 -- observer-store.test.mjs의 기존 mutation-4 테스트는 이미
// 완성된 HEALTHY classifyResult를 store에 주입만 해서, stall-core.mjs의
// 완료우선(handshake==='done') guard를 실제로 제거해도 GREEN이었다(REVIEW
// 재현 확인). 여기서는 진짜 결선(normalizeSeatObservation -> reduceTick이
// 내부에서 부르는 실제 classifySeat import) 전체를 태워 anti-vacuity를
// 채운다 -- 이 테스트가 실행하는 classifySeat은 손으로 만든 결과가 아니라
// stall-core.mjs에서 그 자리에서 계산된 값이다.
// ---------------------------------------------------------------------------
test("mutation-4 anti-vacuity(P1-1): adapter->classifySeat->store 실결선 -- good handshake + process death 동시에도 HEALTHY(completion precedence, stall 아님)", () => {
  const observation = normalizeSeatObservation({
    now: 100_000,
    seatId: "CODER",
    expectedIncarnation: INC_A,
    // handshake done: 실제 checkRelayHandshake 성공 shape을 그대로 흉내.
    handshakeResult: { ok: true, reason: "relay handshake ok for HYK-171" },
    // process death: deriveProcessAlive의 override 경로로 명시적 false.
    terminalConnectedOverride: false,
    // mtimeAgeS를 실제로 채워 -- guard가 없을 때 UNOBSERVABLE(필드결손)이
    // 아니라 정확히 PROCESS_NOT_ALIVE/SUSPECTED_STALL로 떨어지게 한다
    // (그래야 이 시험이 정확히 완료우선 guard 하나만을 저격한다).
    resultStat: { mtimeMs: 0, size: 1 },
  });
  assert.equal(
    observation.quality.observable,
    true,
    "이 시험 전제: 관측 자체는 가능해야 한다(그래야 classifySeat까지 실제로 탄다)",
  );
  assert.equal(observation.snapshot.handshake, "done");
  assert.equal(observation.snapshot.processAlive, false);

  const { nextState, result } = reduceTick({
    state: createEmptyStore(),
    seatId: "CODER",
    incarnation: INC_A,
    observation,
  });

  assert.equal(result.kind, SEAT_STATE.HEALTHY);
  assert.equal(result.reason, REASON.HANDSHAKE_DONE);
  const advisories = nextState.seats.CODER.advisories;
  const entry = Object.values(advisories)[0];
  assert.equal(entry.state, SEAT_STATE.HEALTHY);
});

// ---------------------------------------------------------------------------
// runObserverTick: fs/execFn 전부 fake 주입 -- dispatch/teardown/task write 0
// ---------------------------------------------------------------------------

// writeExclusiveFn은 실 `fs.writeFileSync(path, data, {flag:'wx'})`의 계약을
// 흉내낸다 -- 이미 존재하는 키에 대한 두 번째 호출은 반드시 던진다. Set
// 멤버십 확인+추가가 이 fake 안에서 단일 동기 호출로 일어나므로, 실제
// OS의 O_EXCL 원자성과 동형인 배타 보장을 테스트에서도 재현한다.
function makeFsFake(initialText = null) {
  let diskText = initialText;
  let pending = null;
  const locks = new Set();
  return {
    fs: {
      existsFn: () => diskText !== null,
      readFn: () => diskText,
      writeFn: (path, text) => {
        pending = text;
      },
      renameFn: () => {
        diskText = pending;
      },
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
    },
    getText: () => diskText,
  };
}

test("runObserverTick: 정상 tick -- HEALTHY 산출, store에 정확히 1개 advisory, orca 호출은 읽기전용뿐", async () => {
  const { fs, getText } = makeFsFake();
  const calls = [];
  const execFn = (argv) => {
    calls.push(argv);
    if (argv[1] === "dispatch-show") {
      return {
        ok: true,
        result: {
          dispatch: {
            status: "dispatched",
            assignee_pane_key: "p1",
            task_id: "t1",
            id: "d1",
          },
        },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      return { ok: true, result: { terminal: { preview: "hi there" } } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
      };
    }
    if (argv[1] === "check") {
      return {
        ok: true,
        result: {
          messages: [{ type: "heartbeat", taskId: "t1", dispatchId: "d1" }],
        },
      };
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  };

  const delivered = [];
  const result = await runObserverTick(
    {
      seatId: "CODER",
      harnessRole: "coder",
      taskId: "t1",
      coordinatorHandle: "term_coord",
      seatSelector: { handle: "h1" },
      expectedIncarnation: INC_A,
      storePath: "/store.json",
      sampleGeneration: 1,
    },
    {
      execFn,
      statFn: () => ({ mtimeMs: 0, size: 1 }),
      nowFn: () => 100_000,
      checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
      fs,
      notifyFn: (item) => {
        delivered.push(item);
        return true;
      },
    },
  );

  assert.equal(result.ok, true);
  const FORBIDDEN = /^(dispatch$|task-create$|task-update$|close$)/;
  for (const argv of calls) {
    assert.ok(!argv.some((t) => typeof t === "string" && FORBIDDEN.test(t)));
  }
  const stored = JSON.parse(getText());
  assert.equal(Object.keys(stored.seats.CODER.advisories).length, 1);
});

test("runObserverTick: store 손상 -> ADAPTER_DEGRADED로 fail-closed, execFn 조회 자체가 발생하지 않음(호출 0)", async () => {
  const fs = {
    existsFn: () => true,
    readFn: () => "{{corrupt",
  };
  const calls = [];
  const result = await runObserverTick(
    { seatId: "CODER", storePath: "/broken.json" },
    {
      execFn: (argv) => {
        calls.push(argv);
        return poisonedExecFn();
      },
      fs,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, OBSERVER_STATE.ADAPTER_DEGRADED);
  assert.equal(
    calls.length,
    0,
    "손상된 store에서는 관측 수집 자체를 시도하지 않는다",
  );
});

// P1-2 재작업(REVIEW 결함 2): saveStoreCAS의 tmp write/rename 실패가
// runObserverTick 레벨에서도 확정판정 0·notifyFn 호출 0으로 fail-closed
// 되는지 확인(단위시험은 observer-store.test.mjs의 mutation-9c/9d).
test("P1-2: runObserverTick -- writeFn 실패 시 ok:false, notifyFn 호출 0, emitted 표시 없음(fail-closed)", async () => {
  const fs = {
    existsFn: () => false,
    readFn: () => null,
    writeFn: () => {
      throw new Error("EIO: simulated disk write failure");
    },
    renameFn: () => {
      throw new Error("must not be reached");
    },
  };
  const execFn = (argv) => {
    if (argv[1] === "dispatch-show") {
      return {
        ok: true,
        result: {
          dispatch: {
            status: "dispatched",
            assignee_pane_key: "p1",
            task_id: "t1",
            id: "d1",
          },
        },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      return { ok: true, result: { terminal: { preview: "hi" } } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
      };
    }
    if (argv[1] === "check") return { ok: true, result: { messages: [] } };
    throw new Error("unexpected");
  };
  let notifyCalls = 0;
  const result = await runObserverTick(
    {
      seatId: "CODER",
      harnessRole: "coder",
      taskId: "t1",
      seatSelector: { handle: "h1" },
      expectedIncarnation: INC_A,
      storePath: "/store.json",
    },
    {
      execFn,
      statFn: () => ({ mtimeMs: 0, size: 1 }),
      nowFn: () => 100_000,
      checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
      fs,
      notifyFn: () => {
        notifyCalls += 1;
        return true;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.notEqual(result.reason, "conflict");
  assert.match(result.reason, /write threw/);
  assert.equal(
    notifyCalls,
    0,
    "store 저장이 실패했으니 notifyFn은 절대 불려선 안 된다",
  );
  assert.deepEqual(result.delivered, []);
});

// mutation 10: 두 인스턴스가 동시에 같은 관측으로 emit을 시도하면 정확히
// 하나의 알림만 전달된다.
test("mutation-10: 두 runObserverTick 인스턴스 경쟁 -- 전달되는 알림은 1개", async () => {
  const { fs } = makeFsFake();
  const execFn = (argv) => {
    if (argv[1] === "dispatch-show")
      return {
        ok: true,
        result: {
          dispatch: {
            status: "dispatched",
            assignee_pane_key: "p1",
            task_id: "t1",
            id: "d1",
          },
        },
      };
    if (argv[0] === "terminal" && argv[1] === "show")
      return { ok: true, result: { terminal: { preview: "same" } } };
    if (argv[0] === "terminal" && argv[1] === "list")
      return {
        ok: true,
        result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
      };
    if (argv[1] === "check") return { ok: true, result: { messages: [] } };
    throw new Error("unexpected");
  };
  const ctx = {
    seatId: "CODER",
    harnessRole: "coder",
    taskId: "t1",
    seatSelector: { handle: "h1" },
    expectedIncarnation: INC_A,
    storePath: "/store.json",
  };
  const deliveredA = [];
  const deliveredB = [];
  const optsBase = {
    execFn,
    statFn: () => ({ mtimeMs: 0, size: 1 }), // stale -> lease violated -> SUSPECTED_STALL
    nowFn: () => 10_000_000,
    checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
    fs,
  };
  const [resA, resB] = await Promise.all([
    runObserverTick(ctx, {
      ...optsBase,
      notifyFn: (i) => {
        deliveredA.push(i);
        return true;
      },
    }),
    runObserverTick(ctx, {
      ...optsBase,
      notifyFn: (i) => {
        deliveredB.push(i);
        return true;
      },
    }),
  ]);
  assert.ok(resA.ok);
  assert.ok(resB.ok);
  assert.equal(deliveredA.length + deliveredB.length, 1);
});

// ---------------------------------------------------------------------------
// P1-4 재작업(REVIEW hyk171-cycle2b-review-1 결함 4 수리): S6 pane key
// 유출 -- stall-observer.mjs가 ctx.expectedIncarnation(raw pane key 포함)을
// 그대로 store로 넘겨 durable state(incarnationKey 직렬화 문자열)에 원문
// pane key가 그대로 박혔다(REVIEW의 S6_RAW_PANE_PROBE 재현). 어댑터
// 경계(seat-signal-adapter.mjs의 tokenizeIncarnation)에서 해시로 바뀐
// 토큰만 store에 도달해야 한다 -- probe 문자열이 최종 직렬화 결과 어디에도
// 나타나지 않아야 한다.
// ---------------------------------------------------------------------------
test("P1-4: raw pane key(S6_RAW_PANE_PROBE)가 durable store에 도달하지 않는다", async () => {
  const RAW_PANE_PROBE = "S6_RAW_PANE_PROBE";
  const { fs, getText } = makeFsFake();
  const execFn = (argv) => {
    if (argv[1] === "dispatch-show") {
      return {
        ok: true,
        result: {
          dispatch: {
            status: "dispatched",
            assignee_pane_key: RAW_PANE_PROBE,
            task_id: "t1",
            id: "d1",
          },
        },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      return { ok: true, result: { terminal: { preview: "hi" } } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
      };
    }
    if (argv[1] === "check") return { ok: true, result: { messages: [] } };
    throw new Error("unexpected");
  };

  const result = await runObserverTick(
    {
      seatId: "CODER",
      harnessRole: "coder",
      taskId: "t1",
      seatSelector: { handle: "h1" },
      expectedIncarnation: {
        taskId: "t1",
        dispatchId: "d1",
        seatPaneKey: RAW_PANE_PROBE,
      },
      storePath: "/store.json",
    },
    {
      execFn,
      statFn: () => ({ mtimeMs: 0, size: 1 }),
      nowFn: () => 100_000,
      checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
      fs,
    },
  );
  assert.equal(result.ok, true);

  const storedText = getText();
  assert.ok(
    !storedText.includes(RAW_PANE_PROBE),
    "raw pane key 문자열이 durable store 직렬화 결과에 나타나면 안 된다(S6 유출)",
  );

  const stored = JSON.parse(storedText);
  const seatRecord = stored.seats.CODER;
  assert.ok(
    !seatRecord.incarnationKey.includes(RAW_PANE_PROBE),
    "incarnationKey에도 raw probe가 없어야 한다",
  );
  // 정직 대조: task/dispatch id 자체는 어댑터가 계속 통과시킨다(pane key만
  // 토큰화 대상 -- REVIEW가 지목한 유출은 pane key였다).
  assert.ok(seatRecord.incarnationKey.includes("t1"));
  assert.ok(seatRecord.incarnationKey.includes("d1"));
});

// ---------------------------------------------------------------------------
// ackAdvisory / groupForPresentation
// ---------------------------------------------------------------------------

test("ackAdvisory: 존재하는 fingerprint ack -> ok, 없으면 ok:false", async () => {
  const { fs, getText } = makeFsFake();
  const execFn = (argv) => {
    if (argv[1] === "dispatch-show")
      return {
        ok: true,
        result: {
          dispatch: {
            status: "dispatched",
            assignee_pane_key: "p1",
            task_id: "t1",
            id: "d1",
          },
        },
      };
    if (argv[0] === "terminal" && argv[1] === "show")
      return { ok: true, result: { terminal: { preview: "same" } } };
    if (argv[0] === "terminal" && argv[1] === "list")
      return {
        ok: true,
        result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
      };
    if (argv[1] === "check") return { ok: true, result: { messages: [] } };
    throw new Error("unexpected");
  };
  await runObserverTick(
    {
      seatId: "CODER",
      harnessRole: "coder",
      taskId: "t1",
      seatSelector: { handle: "h1" },
      expectedIncarnation: INC_A,
      storePath: "/store.json",
    },
    {
      execFn,
      statFn: () => ({ mtimeMs: 0, size: 1 }),
      nowFn: () => 999_999,
      checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
      fs,
    },
  );
  const stored = JSON.parse(getText());
  const fingerprint = Object.keys(stored.seats.CODER.advisories)[0];

  const ok = ackAdvisory(
    { storePath: "/store.json", seatId: "CODER", fingerprint, ackedAtMs: 1 },
    { fs },
  );
  assert.equal(ok.ok, true);

  const missing = ackAdvisory(
    {
      storePath: "/store.json",
      seatId: "CODER",
      fingerprint: "nope",
      ackedAtMs: 1,
    },
    { fs },
  );
  assert.equal(missing.ok, false);
});

test("groupForPresentation: 다좌석 같은 reason 집계는 presentation에만 -- 원본 items는 그대로 보존", () => {
  const items = [
    {
      seatId: "CODER",
      fingerprint: "a",
      advisory: { reason: REASON.PROCESS_NOT_ALIVE },
    },
    {
      seatId: "REVIEW",
      fingerprint: "b",
      advisory: { reason: REASON.PROCESS_NOT_ALIVE },
    },
    {
      seatId: "VERIFY",
      fingerprint: "c",
      advisory: { reason: REASON.LEASE_VIOLATED_NO_CORROBORATION },
    },
  ];
  const grouped = groupForPresentation(items);
  const processDeath = grouped.find(
    (g) => g.reason === REASON.PROCESS_NOT_ALIVE,
  );
  assert.equal(processDeath.count, 2);
  assert.deepEqual(processDeath.seatIds.sort(), ["CODER", "REVIEW"]);
  // 원본 items는 변형되지 않음(판정 영수증은 좌석별 보존)
  assert.equal(items[0].fingerprint, "a");
});
