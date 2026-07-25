import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSeatObservation,
  collectSeatObservation,
  buildDispatchShowCommand,
  parseDispatchShow,
  buildPushPeekCommand,
  parsePushPeek,
  tokenizeIncarnation,
  SOURCE_FAILURE_DOMAIN,
  CAPABILITY_STATUS,
} from "./seat-signal-adapter.mjs";

// 이 파일은 orca를 실제로 spawn하지 않는다(G9: spawnSync/exec 계열 첫
// 인자가 문자열 리터럴 "orca"인 패턴이 이 파일에 없다). collectSeatObservation
// 호출 시 execFn을 항상 fake로 주입한다 -- 실행 시(runtime, G10) 아무
// execFn도 안 넘기면 orca-adapter.mjs의 createOrcaExecFn(실 spawn)이
// 기본값이 되므로, 테스트는 반드시 opts.execFn을 명시한다.
function poisonedExecFn() {
  throw new Error(
    "poisoned execFn: real orca CLI must never be invoked in tests",
  );
}

// ---------------------------------------------------------------------------
// normalizeSeatObservation: 순수 함수 단위 시험
// ---------------------------------------------------------------------------

test("정상 경로: 완결 raw -> observable, HEALTHY류 snapshot 필드 산출", () => {
  const { snapshot, quality, persist } = normalizeSeatObservation({
    now: 1_000_000,
    seatId: "CODER",
    expectedIncarnation: { taskId: "t1", dispatchId: "d1", seatPaneKey: "p1" },
    resultStat: { mtimeMs: 999_000, size: 10 },
    resultReadError: false,
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
      result: { terminal: { preview: "hello world" } },
    },
    terminalListResponse: {
      ok: true,
      result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
    },
    pushEvents: [{ type: "heartbeat" }],
    pushPeekFailed: false,
    seatSelector: { handle: "h1" },
    prevPreviewNormalized: "hello there",
    prevOutputChangedAtMs: 500_000,
    prevObservedAtMs: 999_500,
    lease: { maxNoProgressS: 1800 },
    capabilities: {},
    maxClockJumpS: 86400,
  });

  assert.equal(quality.observable, true);
  assert.deepEqual(quality.degradedReasons, []);
  assert.equal(snapshot.handshake, "pending");
  assert.equal(snapshot.processAlive, true);
  assert.equal(snapshot.pushSeen, true);
  assert.equal(snapshot.lastOutputChanged, true); // preview differs from prev
  assert.equal(persist.previewNormalized, "hello world");
  assert.equal(
    quality.capabilityStatus.promptDetector,
    CAPABILITY_STATUS.UNKNOWN,
  );
  assert.equal(
    quality.capabilityStatus.rateLimitDetector,
    CAPABILITY_STATUS.UNKNOWN,
  );
});

test("handshake done -> snapshot.handshake === 'done' (core의 완료우선 분기로 그대로 흘러간다)", () => {
  const { snapshot } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    handshakeResult: { ok: true, reason: "relay handshake ok for X" },
  });
  assert.equal(snapshot.handshake, "done");
});

// mutation 1: 부분 write / 읽는 중 변경
test("mutation-1 부분파일: resultReadError=true -> observable=false, sourceFailureDomain=file", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    resultReadError: true,
  });
  assert.equal(quality.observable, false);
  assert.equal(quality.sourceFailureDomain, SOURCE_FAILURE_DOMAIN.FILE);
  assert.ok(quality.degradedReasons.includes("partial-read"));
});

test("mutation-1b 읽기 전/후 stat 경쟁: mtimeMs/size 불일치 -> observable=false", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    resultStatRace: {
      before: { mtimeMs: 1, size: 5 },
      after: { mtimeMs: 2, size: 6 },
    },
  });
  assert.equal(quality.observable, false);
  assert.ok(quality.degradedReasons.includes("partial-read"));
});

// mutation 3: incarnation mismatch (stale/replay/새 dispatch)
test("mutation-3 incarnation mismatch: dispatch-show taskId가 기대와 다르면 observable=false", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    expectedIncarnation: {
      taskId: "t-new",
      dispatchId: "d-new",
      seatPaneKey: "p-new",
    },
    dispatchShow: {
      ok: true,
      result: {
        dispatch: {
          status: "dispatched",
          assignee_pane_key: "p-old",
          task_id: "t-old",
          id: "d-old",
        },
      },
    },
  });
  assert.equal(quality.observable, false);
  assert.ok(quality.degradedReasons.includes("incarnation-mismatch"));
});

test("incarnation 일치: 같은 taskId/dispatchId/paneKey -> mismatch 없음", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    expectedIncarnation: { taskId: "t1", dispatchId: "d1", seatPaneKey: "p1" },
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
    resultStat: { mtimeMs: 0, size: 1 },
  });
  assert.ok(!quality.degradedReasons.includes("incarnation-mismatch"));
});

// mutation 5: orca adapter outage (control-plane 실패) vs worker stall
test("mutation-5 control-plane 실패: dispatch-show ok:false -> observable=false, sourceFailureDomain=control-plane", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    dispatchShow: { ok: false, error: { message: "boom" } },
  });
  assert.equal(quality.observable, false);
  assert.equal(
    quality.sourceFailureDomain,
    SOURCE_FAILURE_DOMAIN.CONTROL_PLANE,
  );
});

test("terminal show 실패도 control-plane 취급", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    terminalShow: { ok: false },
  });
  assert.equal(quality.observable, false);
  assert.equal(
    quality.sourceFailureDomain,
    SOURCE_FAILURE_DOMAIN.CONTROL_PLANE,
  );
});

// mutation 6: capability 없음 -> UNKNOWN (자동 PAUSE류로 위장하지 않음)
test("mutation-6/12 capability declaration: 명시적으로 true 아니면 항상 UNKNOWN", () => {
  const { quality } = normalizeSeatObservation({ now: 1, seatId: "CODER" });
  assert.equal(
    quality.capabilityStatus.promptDetector,
    CAPABILITY_STATUS.UNKNOWN,
  );
  assert.equal(
    quality.capabilityStatus.rateLimitDetector,
    CAPABILITY_STATUS.UNKNOWN,
  );

  const { quality: q2 } = normalizeSeatObservation({
    now: 1,
    seatId: "CODER",
    capabilities: { promptDetector: true, rateLimitDetector: true },
  });
  assert.equal(q2.capabilityStatus.promptDetector, "PRESENT");
  assert.equal(q2.capabilityStatus.rateLimitDetector, "PRESENT");
});

// mutation 7: terminal output 변화 + result touch(mtime fresh) 두 noisy 신호
// 동시 -- 어댑터가 이걸 "두 개의 독립 증거"로 코어에 넘기지 않는지 확인
// (실제 이중계산 방어는 stall-core의 countProgressSignals가 하지만, 이
// 어댑터가 lastOutputChanged를 "raw가 주장하는 changed 불리언"이 아니라
// 직접 비교로 산출한다는 계약을 여기서 확인한다).
test("mutation-7 noisy-hung 재료: preview가 실제로 달라졌을 때만 lastOutputChanged=true (raw 주장 무시)", () => {
  const { snapshot: unchanged } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    terminalShow: {
      ok: true,
      result: { terminal: { preview: "same   text" } },
    },
    prevPreviewNormalized: "same text",
    prevOutputChangedAtMs: 50,
  });
  assert.equal(unchanged.lastOutputChanged, true); // 이전에 변경 기록이 있었으므로 그 근거의 나이는 여전히 유효(50 기준)
  assert.equal(unchanged.lastOutputAgeS, (100 - 50) / 1000);

  const { snapshot: firstEver } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    terminalShow: { ok: true, result: { terminal: { preview: "anything" } } },
    prevPreviewNormalized: null,
    prevOutputChangedAtMs: null,
  });
  assert.equal(firstEver.lastOutputChanged, false); // 비교 대상 없음 -- 진전으로 단정하지 않음
});

// mutation 8: clock rollback / 큰 jump
test("mutation-8 clock rollback: now < prevObservedAtMs -> observable=false", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    prevObservedAtMs: 5000,
  });
  assert.equal(quality.observable, false);
  assert.ok(quality.degradedReasons.includes("clock-rollback"));
});

test("mutation-8b clock 큰 jump: maxClockJumpS 초과 -> observable=false", () => {
  const { quality } = normalizeSeatObservation({
    now: 1_000_000,
    seatId: "CODER",
    prevObservedAtMs: 10,
    maxClockJumpS: 100,
  });
  assert.equal(quality.observable, false);
  assert.ok(quality.degradedReasons.includes("clock-jump"));
});

test("정상 경과 시간(작은 jump)은 clock anomaly 아님", () => {
  const { quality } = normalizeSeatObservation({
    now: 1000,
    seatId: "CODER",
    prevObservedAtMs: 900,
    maxClockJumpS: 100,
    resultStat: { mtimeMs: 0, size: 1 },
  });
  assert.ok(!quality.degradedReasons.some((r) => r.startsWith("clock-")));
});

// mtimeAgeS 결손 -> hasRequiredFields가 코어에서 UNOBSERVABLE 처리하도록
// undefined로 남긴다(값을 지어내지 않는다).
test("resultStat 없음 -> mtimeAgeS undefined (코어가 MISSING_REQUIRED_FIELDS로 판정하게 둔다)", () => {
  const { snapshot } = normalizeSeatObservation({ now: 100, seatId: "CODER" });
  assert.equal(snapshot.mtimeAgeS, undefined);
});

test("processAlive 결손: terminal list에 없거나 selector 없음 -> undefined", () => {
  const { snapshot } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    terminalListResponse: { ok: true, result: { terminals: [] } },
    seatSelector: { handle: "missing" },
  });
  assert.equal(snapshot.processAlive, undefined);
});

// mutation 2: stale/replayed push(다른 incarnation의 heartbeat/worker_done)가
// pushSeen을 오염시키지 않는다 -- --peek은 읽음 처리를 안 하므로 이전
// dispatch의 이벤트가 여러 tick에 계속 보일 수 있다.
test("mutation-2 stale push: 다른 taskId/dispatchId의 heartbeat/worker_done은 pushSeen에 반영 안 됨", () => {
  const { snapshot } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    expectedIncarnation: {
      taskId: "t-current",
      dispatchId: "d-current",
      seatPaneKey: "p1",
    },
    pushEvents: [{ type: "worker_done", taskId: "t-old", dispatchId: "d-old" }],
  });
  assert.equal(snapshot.pushSeen, false);
});

test("현재 incarnation과 일치하는 push는 정상 반영", () => {
  const { snapshot } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    expectedIncarnation: {
      taskId: "t-current",
      dispatchId: "d-current",
      seatPaneKey: "p1",
    },
    pushEvents: [
      { type: "heartbeat", taskId: "t-current", dispatchId: "d-current" },
    ],
  });
  assert.equal(snapshot.pushSeen, true);
});

// ---------------------------------------------------------------------------
// P1-4 재작업(REVIEW hyk171-cycle2b-review-1 결함 4 수리): tokenizeIncarnation
// -- pane key는 어댑터 경계에서 비가역 해시로 바뀌어야 store로 나간다.
// ---------------------------------------------------------------------------

test("tokenizeIncarnation: seatPaneKey는 해시로 바뀌고, taskId/dispatchId는 그대로 통과한다", () => {
  const raw = {
    taskId: "t1",
    dispatchId: "d1",
    seatPaneKey: "S6_RAW_PANE_PROBE",
  };
  const token = tokenizeIncarnation(raw);
  assert.equal(token.taskId, "t1");
  assert.equal(token.dispatchId, "d1");
  assert.notEqual(token.seatPaneKey, "S6_RAW_PANE_PROBE");
  assert.equal(typeof token.seatPaneKey, "string");
  assert.ok(token.seatPaneKey.length > 0);
});

test("tokenizeIncarnation: 같은 pane key -> 같은 토큰(결정적), 다른 pane key -> 다른 토큰", () => {
  const a = tokenizeIncarnation({ seatPaneKey: "pane-a" });
  const b = tokenizeIncarnation({ seatPaneKey: "pane-a" });
  const c = tokenizeIncarnation({ seatPaneKey: "pane-b" });
  assert.equal(a.seatPaneKey, b.seatPaneKey);
  assert.notEqual(a.seatPaneKey, c.seatPaneKey);
});

test("tokenizeIncarnation: 입력이 객체가 아니면 null", () => {
  assert.equal(tokenizeIncarnation(null), null);
  assert.equal(tokenizeIncarnation("not-an-object"), null);
});

test("normalizeSeatObservation: quality.incarnation은 tokenizeIncarnation을 거친 값이다(raw pane key 유출 없음)", () => {
  const { quality } = normalizeSeatObservation({
    now: 100,
    seatId: "CODER",
    expectedIncarnation: {
      taskId: "t1",
      dispatchId: "d1",
      seatPaneKey: "S6_RAW_PANE_PROBE",
    },
  });
  assert.notEqual(quality.incarnation.seatPaneKey, "S6_RAW_PANE_PROBE");
  assert.equal(quality.incarnation.taskId, "t1");
});

// ---------------------------------------------------------------------------
// 커맨드 빌더/파서 순수 단위 시험 (raw 문자열은 이 파일 안에만 -- S6)
// ---------------------------------------------------------------------------

test("buildDispatchShowCommand: argv shape", () => {
  assert.deepEqual(buildDispatchShowCommand("task_1"), [
    "orchestration",
    "dispatch-show",
    "--task",
    "task_1",
    "--json",
  ]);
});

test("parseDispatchShow: ok:false/malformed -> null", () => {
  assert.equal(parseDispatchShow({ ok: false }), null);
  assert.equal(parseDispatchShow({ ok: true, result: {} }), null);
  assert.equal(parseDispatchShow("not-an-object"), null);
});

test("buildPushPeekCommand/parsePushPeek", () => {
  assert.deepEqual(buildPushPeekCommand("term_x"), [
    "orchestration",
    "check",
    "--terminal",
    "term_x",
    "--types",
    "heartbeat,worker_done",
    "--peek",
    "--json",
  ]);
  assert.deepEqual(
    parsePushPeek({ ok: true, result: { messages: [{ type: "heartbeat" }] } }),
    [{ type: "heartbeat", taskId: null, dispatchId: null }],
  );
  assert.equal(parsePushPeek({ ok: false }), null);
});

// ---------------------------------------------------------------------------
// collectSeatObservation: execFn 주입 -- 읽기 전용 호출만 나가는지 확인
// ---------------------------------------------------------------------------

test("collectSeatObservation: 읽기전용 호출만 발생(dispatch/teardown/worker input 호출 0)", () => {
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
      return { ok: true, result: { terminal: { preview: "hi" } } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: { terminals: [{ handle: "h1", worktreePath: "C:/wt" }] },
      };
    }
    if (argv[1] === "check") {
      return { ok: true, result: { messages: [] } };
    }
    throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
  };

  const result = collectSeatObservation(
    {
      seatId: "CODER",
      harnessRole: "coder",
      taskId: "t1",
      coordinatorHandle: "term_coord",
      seatSelector: { handle: "h1" },
      expectedIncarnation: {
        taskId: "t1",
        dispatchId: "d1",
        seatPaneKey: "p1",
      },
    },
    {
      execFn,
      statFn: () => ({ mtimeMs: 0, size: 1 }),
      nowFn: () => 1000,
      checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
    },
  );

  assert.equal(result.quality.observable, true);
  const FORBIDDEN = /^(dispatch$|task-create$|task-update$|close$)/;
  for (const argv of calls) {
    assert.ok(
      !argv.some((tok) => typeof tok === "string" && FORBIDDEN.test(tok)),
      `forbidden mutating token found in argv: ${JSON.stringify(argv)}`,
    );
  }
  assert.ok(calls.some((argv) => argv[1] === "dispatch-show"));
});

test("collectSeatObservation: execFn 호출이 던져도(제어면 장애) 죽지 않고 control-plane 실패로 흡수한다", () => {
  const result = collectSeatObservation(
    { seatId: "CODER", taskId: "t1" },
    {
      execFn: poisonedExecFn,
      statFn: () => null,
      nowFn: () => 1,
      checkHandshakeFn: () => ({ ok: false, reason: "result file not found" }),
    },
  );
  assert.equal(result.quality.observable, false);
  assert.equal(
    result.quality.sourceFailureDomain,
    SOURCE_FAILURE_DOMAIN.CONTROL_PLANE,
  );
});
