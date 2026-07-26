import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliverTask,
  createDispatchReceiptRecorder,
} from "./adapters/orca-adapter.mjs";
import {
  normalizeSeatCreation,
  normalizeDispatchRawUnion,
  judgeInjectedProfile,
  DISPATCH_SHAPE,
  INJECTED_PROFILE_REASON,
} from "./adapters/dispatch-correlation-adapter.mjs";
import {
  judgeDispatchCorrelation,
  CORRELATION,
} from "./dispatch-correlation-core.mjs";
import {
  createEmptyRegistry,
  recordSeatCreation,
  recordSeatDispatch,
  SEAT_DISPATCH_REASON,
  SEAT_DISPATCH_TRANSITION,
} from "./seat-registry.mjs";
import { rawTerminalCreate } from "./hyk171-cycle4b2b3-fixtures.mjs";
import {
  rawDispatchInjected,
  rawDispatchNotInjected,
  rawDispatchRetrySuccess,
  rawDispatchStaleFailure,
  rawTaskUpdateCompletedOk,
  stableSeatRecord,
  registryWith,
} from "./hyk171-cycle4b2b4-fixtures.mjs";

// HYK-171 사이클4b-2b-4 (coder-task.md §3) -- mutation 원장 M1~M14. 전부
// 프로덕션 진입점(deliverTask/recordSeatDispatch/normalizeDispatchRawUnion/
// judgeInjectedProfile/judgeDispatchCorrelation)을 직접 구동한다(helper로
// 손조립 금지). "실제 RED 재현"(프로덕션 파일을 실제로 변조 -> 이 스위트
// 재실행 -> RED 확인 -> git diff --exit-code로 원복 증명) 절차는
// .harness/coder.md에 별도 기록한다.

function claudeExecFnFactory({ dispatchResponses, taskCreateOk = true } = {}) {
  const calls = [];
  let dispatchCallIndex = 0;
  const execFn = (argv) => {
    calls.push(argv);
    if (argv[1] === "task-create") {
      return taskCreateOk
        ? {
            ok: true,
            result: { task: { id: "task_runtime", status: "ready" } },
          }
        : { ok: false, reason: "boom" };
    }
    if (argv[1] === "dispatch") {
      const resp = dispatchResponses[dispatchCallIndex];
      dispatchCallIndex += 1;
      return resp;
    }
    if (argv[1] === "task-update") {
      return rawTaskUpdateCompletedOk();
    }
    throw new Error(`unexpected argv in fake execFn: ${argv.join(" ")}`);
  };
  return { execFn, calls };
}

const BASE_CTX = Object.freeze({
  role: "CODER",
  worktreePath: "C:/seatMain/path",
  taskId: "HYK-171-cycle4b2b4-9",
});

// ---------------------------------------------------------------------------
// M1 -- 첫 dispatch 성공에서 raw 응답 전달/기록 호출을 제거하면, deliverTask
// 관통 시험에서 recordDispatchReceipt가 한 번도 호출되지 않는다(exact
// runtime task/dispatch/seat 세대가 기록 seam에 도달하지 못함을 검출).
// ---------------------------------------------------------------------------
test("mutation M1: deliverTask (claude profile) drives dispatchWithStaleRecovery's first-success path through to recordDispatchReceipt exactly once, bound to the real dispatch response", () => {
  const receiptCalls = [];
  const { execFn } = claudeExecFnFactory({
    dispatchResponses: [rawDispatchInjected()],
  });
  const result = deliverTask(
    { ...BASE_CTX },
    {
      execFn,
      existingSeatHandle: "termMain",
      recordDispatchReceipt: (ctx) => {
        receiptCalls.push(ctx);
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(receiptCalls.length, 1);
  assert.equal(receiptCalls[0].phase, "first");
  assert.equal(receiptCalls[0].rawResponse.result.dispatch.id, "ctxDispatch");
  assert.equal(receiptCalls[0].expect.runtimeTaskId, "task_runtime");
  assert.equal(receiptCalls[0].expect.harnessTaskId, BASE_CTX.taskId);
  assert.equal(receiptCalls[0].expect.role, "CODER");
});

// ---------------------------------------------------------------------------
// M2 -- stale-recovery 재시도 성공 응답을 버리거나 첫 실패 응답을 기록하면,
// 재시도 dispatchId(ctxRetry)가 아니라 다른 값(또는 무기록)이 나와 RED.
// ---------------------------------------------------------------------------
test("mutation M2: stale-recovery retry success is recorded exactly once, bound to the RETRIED response's dispatchId (not the first failed attempt, which never produced a raw response to record)", () => {
  const receiptCalls = [];
  const { execFn } = claudeExecFnFactory({
    dispatchResponses: [
      rawDispatchStaleFailure("task_runtime"),
      rawDispatchRetrySuccess(),
    ],
  });
  const result = deliverTask(
    { ...BASE_CTX },
    {
      execFn,
      existingSeatHandle: "termMain",
      consumedReceipt: {
        runtimeTaskId: "task_runtime",
        harnessTaskId: BASE_CTX.taskId,
        role: "CODER",
        worktreePath: BASE_CTX.worktreePath,
      },
      recordDispatchReceipt: (ctx) => {
        receiptCalls.push(ctx);
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(receiptCalls.length, 1);
  assert.equal(receiptCalls[0].phase, "stale-retry");
  assert.equal(receiptCalls[0].rawResponse.result.dispatch.id, "ctxRetry");
});

// ---------------------------------------------------------------------------
// M3 -- 좌석 provenance 생산(recordSeatCreation) 호출을 건너뛰면(레지스트리를
// 빈 채로 두면), recordSeatDispatch가 exactly-1 대상을 찾지 못해 무기록이어야
// 한다. "준비된 record 주입 금지" -- 성공 경로는 반드시 실 생산 파이프라인
// (normalizeSeatCreation -> recordSeatCreation)을 거쳐 만든 레지스트리로만
// 검증한다(손으로 지어낸 stableSeatRecord가 아니다).
// ---------------------------------------------------------------------------
test("mutation M3: recordSeatDispatch succeeds only when the stable record was actually produced via the real normalizeSeatCreation->recordSeatCreation pipeline; skipping that producer leaves 0 matches (fail-closed)", () => {
  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  assert.equal(seatCreation.ok, true);
  const { registry: produced } = recordSeatCreation(createEmptyRegistry(), {
    ...seatCreation.creationInput,
    worktreePath: BASE_CTX.worktreePath,
  });

  const bound = recordSeatDispatch(produced, {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.transition, SEAT_DISPATCH_TRANSITION.BOUND);

  // RED-equivalent: skip the producer entirely -- empty registry never has a
  // matching stable record, so binding must fail closed.
  const skippedProducer = recordSeatDispatch(createEmptyRegistry(), {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(skippedProducer.ok, false);
  assert.equal(skippedProducer.reason, SEAT_DISPATCH_REASON.NO_TARGET);
});

// ---------------------------------------------------------------------------
// M4 -- 응답 runtimeTaskId 확인을 제거하면, 기대와 다른 유효한 응답도 기록
// 대상이 되어 RED. createDispatchReceiptRecorder(실 fs 결선)를 fake fs로
// 직접 구동한다.
// ---------------------------------------------------------------------------
test("mutation M4: createDispatchReceiptRecorder refuses to record a response whose runtimeTaskId differs from the expected dispatch target -- zero fs writes (a stable target record already exists, so without the cross-check this would otherwise succeed and write)", () => {
  const writes = [];
  let registryOnDisk = JSON.stringify(registryWith(stableSeatRecord()));
  const recorder = createDispatchReceiptRecorder({
    registryPath: "fake/registry.json",
    fs: {
      existsFn: () => true,
      readFn: () => registryOnDisk,
      writeFn: (p, t) => {
        writes.push([p, t]);
        registryOnDisk = t;
      },
      renameFn: () => {},
    },
  });
  const result = recorder({
    rawResponse: rawDispatchInjected({ task_id: "task_other" }),
    expect: {
      runtimeTaskId: "task_runtime",
      harnessTaskId: BASE_CTX.taskId,
      role: "CODER",
      worktreePath: BASE_CTX.worktreePath,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(writes.length, 0);
});

// ---------------------------------------------------------------------------
// M5 -- pane key를 단독 lookup 키로 쓰면, worktreePath로 seat A를 고정해도
// 응답 pane key가 seat B의 값이면 B가 갱신되어 RED. 정답은 A/B 둘 다 무기록.
// ---------------------------------------------------------------------------
test("mutation M5: pane key is a comparison-only value, never a lookup key -- targeting seat A by worktreePath but supplying seat B's paneKey must leave BOTH seats unbound", () => {
  const seatA = stableSeatRecord({
    ptyId: "ptyA",
    worktreeId: "wtA",
    worktreePath: "C:/seatA/path",
    paneKey: "seatA-tab:seatA-leaf",
  });
  const seatB = stableSeatRecord({
    ptyId: "ptyB",
    worktreeId: "wtB",
    worktreePath: "C:/seatB/path",
    paneKey: "seatB-tab:seatB-leaf",
  });
  const registry = registryWith(seatA, seatB);

  const result = recordSeatDispatch(registry, {
    worktreePath: "C:/seatA/path",
    assigneePaneKey: "seatB-tab:seatB-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SEAT_DISPATCH_REASON.PANE_KEY_MISMATCH);
  assert.equal(registry.seats[0].dispatch, null);
  assert.equal(registry.seats[1].dispatch, null);
});

// ---------------------------------------------------------------------------
// M6 -- 0-match / 2+-match fail-closed을 제거하면, 스키마를 전부 통과한
// raw로 0건/중복 2건 각각에서 기록이 성공해 RED.
// ---------------------------------------------------------------------------
test("mutation M6a: zero matching stable records -> NO_TARGET, no write", () => {
  const result = recordSeatDispatch(registryWith(), {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SEAT_DISPATCH_REASON.NO_TARGET);
});

test("mutation M6b: two matching stable records for the same worktreePath -> AMBIGUOUS_TARGET, no write", () => {
  const registry = registryWith(
    stableSeatRecord({ ptyId: "pty1", handle: "term1" }),
    stableSeatRecord({ ptyId: "pty2", handle: "term2" }),
  );
  const result = recordSeatDispatch(registry, {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SEAT_DISPATCH_REASON.AMBIGUOUS_TARGET);
});

// ---------------------------------------------------------------------------
// M7 -- active 이전 dispatch의 conflict guard를 제거하면, 다른 incarnation이
// active 레코드를 덮어써 RED. 정상 재배정 왕복(어제 ORCH 5연속 재배정)은
// status:"completed"에서만 허용되므로 여기서는 반드시 거부되고 레코드
// 불변이어야 한다.
// ---------------------------------------------------------------------------
test("mutation M7: a different incarnation targeting a seat whose previous dispatch is still active -> INCARNATION_CONFLICT, record left untouched", () => {
  const oldDispatch = {
    harnessTaskId: "HYK-171-old",
    runtimeTaskId: "task_old",
    dispatchId: "ctxOld",
    status: "active",
    version: 1,
  };
  const registry = registryWith(stableSeatRecord({ dispatch: oldDispatch }));
  const result = recordSeatDispatch(registry, {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SEAT_DISPATCH_REASON.INCARNATION_CONFLICT);
  assert.deepEqual(registry.seats[0].dispatch, oldDispatch);
});

// ---------------------------------------------------------------------------
// M8 -- 정상 completed->새 세대 갱신 허용을 제거(무조건 conflict)하면, 이전
// 종료 증명 + exact ID/CAS 일치가 갖춰져도 실패해 RED. 정답은 정확히 1회
// 갱신(버전 증가).
// ---------------------------------------------------------------------------
test("mutation M8: a terminated (status:completed) prior generation, with authority match and matching CAS version, is upgraded to a NEW_GENERATION exactly once (version increments 1 -> 2)", () => {
  const oldDispatch = {
    harnessTaskId: "HYK-171-old",
    runtimeTaskId: "task_old",
    dispatchId: "ctxOld",
    status: "completed",
    version: 1,
  };
  const registry = registryWith(stableSeatRecord({ dispatch: oldDispatch }));
  const result = recordSeatDispatch(
    registry,
    {
      worktreePath: BASE_CTX.worktreePath,
      assigneePaneKey: "seatMain-tab:seatMain-leaf",
      harnessTaskId: BASE_CTX.taskId,
      runtimeTaskId: "task_runtime",
      dispatchId: "ctxDispatch",
    },
    { priorGenerationAuthorityMatch: true, expectedVersion: 1 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.transition, SEAT_DISPATCH_TRANSITION.NEW_GENERATION);
  assert.equal(result.record.dispatch.version, 2);
  assert.equal(result.record.dispatch.runtimeTaskId, "task_runtime");
  // original registry object passed in stays untouched (pure function).
  assert.deepEqual(registry.seats[0].dispatch, oldDispatch);
});

// ---------------------------------------------------------------------------
// M9 -- 이전 세대 exact-ID/CAS 확인을 제거하면, 권위 조회 불일치나 버전 변경
// 상태에서도 갱신이 통과해 RED.
// ---------------------------------------------------------------------------
test("mutation M9a: prior-generation authority match missing (false) -> PRIOR_GENERATION_UNVERIFIED, no write even though status is completed", () => {
  const oldDispatch = {
    harnessTaskId: "HYK-171-old",
    runtimeTaskId: "task_old",
    dispatchId: "ctxOld",
    status: "completed",
    version: 1,
  };
  const registry = registryWith(stableSeatRecord({ dispatch: oldDispatch }));
  const result = recordSeatDispatch(
    registry,
    {
      worktreePath: BASE_CTX.worktreePath,
      assigneePaneKey: "seatMain-tab:seatMain-leaf",
      harnessTaskId: BASE_CTX.taskId,
      runtimeTaskId: "task_runtime",
      dispatchId: "ctxDispatch",
    },
    { priorGenerationAuthorityMatch: false, expectedVersion: 1 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, SEAT_DISPATCH_REASON.PRIOR_GENERATION_UNVERIFIED);
  assert.deepEqual(registry.seats[0].dispatch, oldDispatch);
});

test("mutation M9b: CAS version mismatch (caller's expectedVersion stale) -> CAS_VERSION_MISMATCH, no write even with authority match", () => {
  const oldDispatch = {
    harnessTaskId: "HYK-171-old",
    runtimeTaskId: "task_old",
    dispatchId: "ctxOld",
    status: "completed",
    version: 2,
  };
  const registry = registryWith(stableSeatRecord({ dispatch: oldDispatch }));
  const result = recordSeatDispatch(
    registry,
    {
      worktreePath: BASE_CTX.worktreePath,
      assigneePaneKey: "seatMain-tab:seatMain-leaf",
      harnessTaskId: BASE_CTX.taskId,
      runtimeTaskId: "task_runtime",
      dispatchId: "ctxDispatch",
    },
    { priorGenerationAuthorityMatch: true, expectedVersion: 1 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, SEAT_DISPATCH_REASON.CAS_VERSION_MISMATCH);
  assert.deepEqual(registry.seats[0].dispatch, oldDispatch);
});

// ---------------------------------------------------------------------------
// M10 -- 동일 task/dispatch 재수신 멱등을 제거하면, 두 번째 수신이 버전을
// 또 올리거나 레코드를 추가해 RED.
// ---------------------------------------------------------------------------
test("mutation M10: receiving the identical (runtimeTaskId, dispatchId) twice never has more than a single-receipt effect -- second call is an idempotent no-op", () => {
  const registry = registryWith(stableSeatRecord());
  const ctx = {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  };
  const first = recordSeatDispatch(registry, ctx);
  assert.equal(first.ok, true);
  assert.equal(first.transition, SEAT_DISPATCH_TRANSITION.BOUND);
  assert.equal(first.record.dispatch.version, 1);

  const second = recordSeatDispatch(first.registry, ctx);
  assert.equal(second.ok, true);
  assert.equal(second.transition, SEAT_DISPATCH_TRANSITION.IDEMPOTENT_NOOP);
  assert.equal(second.record.dispatch.version, 1);
  assert.equal(second.registry, first.registry);
  assert.equal(second.registry.seats.length, 1);
});

// ---------------------------------------------------------------------------
// M11 -- 프로필별 injected 검증을 제거하면, claude의 injected:false가 codex와
// 똑같이 "정상"으로 통과해 RED("배정됨"과 "본문 주입됨" 혼동).
// ---------------------------------------------------------------------------
test("mutation M11a: claude profile with injected:false is NOT a normal outcome -- CLAUDE_INJECT_MISSING", () => {
  const envelope = normalizeDispatchRawUnion(rawDispatchNotInjected());
  assert.equal(envelope.ok, true);
  assert.equal(envelope.shape, DISPATCH_SHAPE.DISPATCH);
  assert.equal(envelope.injected, false);
  const profile = judgeInjectedProfile({
    engine: "claude",
    shape: envelope.shape,
    injected: envelope.injected,
  });
  assert.equal(profile.ok, false);
  assert.equal(
    profile.reasonCode,
    INJECTED_PROFILE_REASON.CLAUDE_INJECT_MISSING,
  );
});

test("mutation M11b: codex profile with injected:false IS normal -- the two false values must not be treated the same as a claude success/failure", () => {
  const envelope = normalizeDispatchRawUnion(rawDispatchNotInjected());
  assert.equal(envelope.injected, false);
  const profile = judgeInjectedProfile({
    engine: "codex",
    shape: envelope.shape,
    injected: envelope.injected,
  });
  assert.equal(profile.ok, true);
  assert.equal(profile.reasonCode, INJECTED_PROFILE_REASON.OK);
});

// ---------------------------------------------------------------------------
// M12 -- (a) 기록 실패를 배달 실패로 승격 또는 (b) dispatch 실패 시에도 기록을
// 시도하면, 배달 판정 계약과 대장 불변 계약이 각각 깨져 RED.
// ---------------------------------------------------------------------------
test("mutation M12a: a recordDispatchReceipt failure (throw) never demotes a successful delivery -- dispatch already happened, delivery stays ok:true", () => {
  const { execFn } = claudeExecFnFactory({
    dispatchResponses: [rawDispatchInjected()],
  });
  const result = deliverTask(
    { ...BASE_CTX },
    {
      execFn,
      existingSeatHandle: "termMain",
      recordDispatchReceipt: () => {
        throw new Error("registry save failed (disk full)");
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.recordResult.ok, false);
});

test("mutation M12b: dispatch failure (no stale match) never calls recordDispatchReceipt -- the registry stays untouched on a failed side effect", () => {
  const receiptCalls = [];
  const { execFn } = claudeExecFnFactory({
    dispatchResponses: [{ ok: false, reason: "some unrelated failure" }],
  });
  const result = deliverTask(
    { ...BASE_CTX },
    {
      execFn,
      existingSeatHandle: "termMain",
      recordDispatchReceipt: (ctx) => {
        receiptCalls.push(ctx);
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(receiptCalls.length, 0);
});

// ---------------------------------------------------------------------------
// M13 -- B-1의 observed 다리(dispatch-correlation-core.mjs의
// adoptionObservable===true 요구, 코어 파일 수정 금지)를 제거하거나
// truthy로 완화하면, 완전한 두 레코드가 있어도 미채택 폴백 row가 PROVEN이
// 되어 RED. 이 사이클이 코어를 건드리지 않았음을 registry 결속 경로로
// 다시 확인한다(회귀 방지).
// ---------------------------------------------------------------------------
test("mutation M13: even when every OTHER check would pass (matching seat record, dispatch-show, and reconstructed pane key), an observation explicitly marked adoptionObservable:false never reaches PROVEN -- isolates the core's own gate from the downstream pane-key reconstruction check (an unadopted fallback row would also fail on pane-key mismatch alone, which would mask this defense)", () => {
  const registry = registryWith(stableSeatRecord());
  const bound = recordSeatDispatch(registry, {
    worktreePath: BASE_CTX.worktreePath,
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    harnessTaskId: BASE_CTX.taskId,
    runtimeTaskId: "task_runtime",
    dispatchId: "ctxDispatch",
  });
  assert.equal(bound.ok, true);

  // tabId/leafId reconstruct to EXACTLY the bound record's paneKey -- every
  // check downstream of adoptionObservable would pass. Only
  // adoptionObservable:false stands between this input and PROVEN.
  const observed = {
    adoptionObservable: false,
    tabId: "seatMain-tab",
    leafId: "seatMain-leaf",
    taskId: "task_runtime",
    dispatchId: "ctxDispatch",
  };

  const verdict = judgeDispatchCorrelation({
    seatRecord: {
      paneKey: bound.record.paneKey,
      taskId: bound.record.dispatch.runtimeTaskId,
      dispatchId: bound.record.dispatch.dispatchId,
    },
    dispatchShow: {
      ok: true,
      taskId: "task_runtime",
      dispatchId: "ctxDispatch",
      assigneePaneKey: "seatMain-tab:seatMain-leaf",
    },
    observed,
  });
  assert.notEqual(verdict.verdict, CORRELATION.PROVEN);
});

// ---------------------------------------------------------------------------
// M14 -- production wiring 제거(또는 teardown sink 연결)를 감지한다. fake
// execFn으로 deliverTask 프로덕션 진입점을 관통시켜, 영수증 기록이 실제
// fs 결선(createDispatchReceiptRecorder)을 통해 exactly 1회 일어나고,
// close/rm/파괴 task-update 호출이 exactly 0회임을 동시에 단언한다.
// ---------------------------------------------------------------------------
test("mutation M14: deliverTask, wired to a real createDispatchReceiptRecorder over fake fs, produces exactly one registry write and zero destructive argv (terminal close / worktree rm / task-update --status failed)", () => {
  const seatCreation = normalizeSeatCreation(rawTerminalCreate());
  const { registry: seeded } = recordSeatCreation(createEmptyRegistry(), {
    ...seatCreation.creationInput,
    worktreePath: BASE_CTX.worktreePath,
  });

  let registryOnDisk = JSON.stringify(seeded);
  const writes = [];
  const recorder = createDispatchReceiptRecorder({
    registryPath: "fake/registry.json",
    fs: {
      existsFn: () => true,
      readFn: () => registryOnDisk,
      writeFn: (p, text) => {
        writes.push([p, text]);
        registryOnDisk = text;
      },
      renameFn: () => {},
    },
  });

  const { execFn, calls } = claudeExecFnFactory({
    dispatchResponses: [rawDispatchInjected()],
  });

  const result = deliverTask(
    { ...BASE_CTX },
    { execFn, existingSeatHandle: "termMain", recordDispatchReceipt: recorder },
  );

  assert.equal(result.ok, true);
  assert.equal(result.recordResult.ok, true);
  assert.equal(result.recordResult.transition, "BOUND");
  assert.equal(writes.length, 1);

  const destructive = calls.filter(
    (argv) =>
      (argv[0] === "terminal" && argv[1] === "close") ||
      (argv[0] === "worktree" && argv[1] === "rm") ||
      (argv[1] === "task-update" && argv.includes("failed")),
  );
  assert.equal(destructive.length, 0);
});
