import { test } from "node:test";
import assert from "node:assert/strict";
import {
  teardownSeat,
  TEARDOWN_PHASE,
  TEARDOWN_GATE_REASON,
  buildTeardownWorktreeRemoveCommand,
  buildTaskUpdateFailedCommand,
} from "./adapters/orca-adapter.mjs";
import {
  OBSERVATION,
  ELIGIBILITY,
  EXECUTION,
  REASON as TEARDOWN_REASON,
} from "./teardown-core.mjs";
import { computeCanonicalPathDigest } from "./adapters/teardown-inventory-adapter.mjs";
import {
  VALID_WORKTREE,
  fakeExecFn,
  fakeGitFn,
  managedWorktreeStub,
  terminalListStub,
  terminalEntry,
  gitWorktreeListOutput,
  taskListDispatchedStub,
  eligibleTeardownCtx,
  staticEligibleOpts,
  togglingEligibleOpts,
  protectedPolicyFor,
  noDestructiveCalls,
} from "./hyk171-cycle4b1-fixtures.mjs";

// HYK-171 사이클4b-1 (coder-task.md §3) -- teardown 3층 판정코어 mutation
// 원장. #1~#11 + paired-good, 전부 **프로덕션 진입점 teardownSeat**을 직접
// 구동한다(테스트 helper 조립 금지). 개수뿐 아니라 계약 필드(phase/judged.
// eligibility/judged.reason/judged.evidence/before/after)의 내용까지
// 검사한다(3B #7 재발 방지).
//
// "최소 3건 실제 RED 재현" 절차는 결과 보고서(.harness/coder.md)에 별도
// 기록한다 -- 프로덕션 파일을 실제로 변조 -> 이 스위트 재실행 -> RED 확인
// -> 원복하는 수작업이라 이 파일 자체에는 담기지 않는다(git diff로 재현
// 가능, 로그는 결과 보고서 참조).

// ---------------------------------------------------------------------------
// #1 -- 보호목록 guard
// ---------------------------------------------------------------------------
test("mutation #1: protected target -- PROTECTED + zero destructive argv + evidence carries ruleId and the matching target digest", () => {
  const opts = staticEligibleOpts();
  const ctx = eligibleTeardownCtx({
    policy: protectedPolicyFor(VALID_WORKTREE),
  });
  const r = teardownSeat(ctx, opts);

  assert.equal(r.ok, false);
  assert.equal(r.phase, TEARDOWN_PHASE.GATE);
  assert.equal(r.judged.eligibility, ELIGIBILITY.PROTECTED);
  assert.equal(r.judged.evidence.ruleId, TEARDOWN_REASON.PROTECTED_TARGET);
  assert.equal(
    r.judged.evidence.protectedTargets.includes(
      r.before.target.canonicalPathDigest,
    ),
    true,
  );
  assert.equal(noDestructiveCalls(opts.execFn), true);
});

// ---------------------------------------------------------------------------
// #2 -- 표적 identity(worktreeId) 결속
// ---------------------------------------------------------------------------
test("mutation #2: same path, mismatched expected worktreeId -- blocked, that path never reaches any destructive argv, evidence has expected/observed", () => {
  const opts = staticEligibleOpts();
  const ctx = eligibleTeardownCtx({
    policy: {
      protectedTargets: [],
      expectedWorktreeId: "wt-stale-from-before",
    },
  });
  const r = teardownSeat(ctx, opts);

  assert.equal(r.ok, false);
  assert.equal(r.judged.reason, TEARDOWN_REASON.TARGET_IDENTITY_MISMATCH);
  assert.equal(r.judged.evidence.expectedWorktreeId, "wt-stale-from-before");
  assert.equal(r.judged.evidence.observedWorktreeId, "wt-0"); // managedWorktreeStub's assigned id
  assert.equal(noDestructiveCalls(opts.execFn), true);
});

// ---------------------------------------------------------------------------
// #3 -- 3층 split을 consistent로 접기
// ---------------------------------------------------------------------------
test("mutation #3: git present / orca absent / dir present -- SPLIT_STATE, sink 0, each of the three layer fields checked individually", () => {
  const execFn = fakeExecFn({
    list: { ok: true, result: { worktrees: [] } }, // orca: absent
    "terminal-list": terminalListStub([terminalEntry()]),
    "task-list": taskListDispatchedStub([]),
  });
  const gitFn = fakeGitFn({
    worktree: gitWorktreeListOutput([VALID_WORKTREE]), // git: present
    status: "",
  });
  const existsFn = () => true; // dir: present
  const r = teardownSeat(eligibleTeardownCtx(), {
    execFn,
    gitFn,
    existsFn,
    existingSeatHandle: "term_4b1",
  });

  assert.equal(r.ok, false);
  assert.equal(r.judged.observation, OBSERVATION.SPLIT_STATE);
  assert.equal(r.before.layers.git, "present");
  assert.equal(r.before.layers.orca, "absent");
  assert.equal(r.before.layers.dir, "present");
  assert.equal(noDestructiveCalls(execFn), true);
});

// ---------------------------------------------------------------------------
// #4 -- 활성참조 guard
// ---------------------------------------------------------------------------
// HYK-171 사이클4b-1 재작업(streak 1, REVIEW review-1 P1-1): 실 CLI에
// `activeDispatch` 필드가 없으므로(실측), 이 시험은 "대상 좌석 자신(소유권
// 증거로 제외됨) + 그 옆에 진짜로 연결된 *다른* 좌석 하나"로 활성참조를
// 만든다 -- 이게 실제로 관측 가능한 유일한 신호(connected 다중 좌석)다.
test("mutation #4: a second connected seat on the same worktree (not proven to be self) -- ACTIVE_REFERENCE, sink 0, the blocking reference's token is in evidence", () => {
  const self = terminalEntry();
  const other = terminalEntry({
    handle: "term_busy",
    tabId: "other-tab-uuid",
    leafId: "other-leaf-uuid",
  });
  const opts = staticEligibleOpts({
    terminalEntries: [self, other],
    existingSeatHandle: self.handle,
  });
  const r = teardownSeat(eligibleTeardownCtx(), opts);

  assert.equal(r.ok, false);
  assert.equal(r.judged.eligibility, ELIGIBILITY.ACTIVE_REFERENCE);
  assert.equal(r.before.activeReferences.count, 1);
  assert.equal(r.judged.evidence.activeReferenceTokens.length, 1);
  assert.deepEqual(
    r.judged.evidence.activeReferenceTokens,
    r.before.activeReferences.tokens,
  );
  assert.equal(
    /^[0-9a-f]{32}$/.test(r.judged.evidence.activeReferenceTokens[0]),
    true,
  );
  assert.equal(noDestructiveCalls(opts.execFn), true);
});

// ---------------------------------------------------------------------------
// #5 -- 관측 실패를 빈값/absent로 접기
// ---------------------------------------------------------------------------
test("mutation #5: gitFn missing (observation source failure) -- UNOBSERVABLE, sink 0, observationQuality names the failed sources", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub([VALID_WORKTREE]),
    "terminal-list": terminalListStub([terminalEntry()]),
  });
  const existsFn = () => true;
  // gitFn intentionally omitted
  const r = teardownSeat(eligibleTeardownCtx(), { execFn, existsFn });

  assert.equal(r.ok, false);
  assert.equal(r.judged.observation, OBSERVATION.UNOBSERVABLE);
  assert.equal(r.before.layers.git, "unobservable");
  assert.equal(r.before.observationQuality.git, "failed");
  assert.equal(r.before.observationQuality.workingTree, "failed");
  assert.equal(r.before.observationQuality.degraded.includes("git"), true);
  assert.equal(
    r.before.observationQuality.degraded.includes("workingTree"),
    true,
  );
  assert.equal(noDestructiveCalls(execFn), true);
});

// ---------------------------------------------------------------------------
// #6 -- dirty / unmerged / evidence-not-durable guard 각각 독립
// ---------------------------------------------------------------------------
test("mutation #6a: dirty working tree -- blocked with DIRTY_WORKING_TREE (independent reason), sink 0", () => {
  const opts = staticEligibleOpts({ gitStatusOutput: " M some-file.txt\n" });
  const r = teardownSeat(eligibleTeardownCtx(), opts);
  assert.equal(r.ok, false);
  assert.equal(r.judged.eligibility, ELIGIBILITY.DIRTY_OR_UNMERGED);
  assert.equal(r.judged.reason, TEARDOWN_REASON.DIRTY_WORKING_TREE);
  assert.equal(noDestructiveCalls(opts.execFn), true);
});

test("mutation #6b: unmerged working tree -- blocked with UNMERGED_WORKING_TREE (independent reason, distinct from dirty), sink 0", () => {
  const opts = staticEligibleOpts({ gitStatusOutput: "UU conflict.txt\n" });
  const r = teardownSeat(eligibleTeardownCtx(), opts);
  assert.equal(r.ok, false);
  assert.equal(r.judged.eligibility, ELIGIBILITY.DIRTY_OR_UNMERGED);
  assert.equal(r.judged.reason, TEARDOWN_REASON.UNMERGED_WORKING_TREE);
  assert.equal(noDestructiveCalls(opts.execFn), true);
});

test("mutation #6c: requireDurableEvidence policy + no corroborating orca worktreeId -- blocked with EVIDENCE_NOT_DURABLE (independent of dirty/unmerged), sink 0", () => {
  const execFn = fakeExecFn({
    // no `id` field on the entry -- observeOrcaLayer must yield worktreeId:null
    list: { ok: true, result: { worktrees: [{ path: VALID_WORKTREE }] } },
    "terminal-list": terminalListStub([terminalEntry()]),
    "task-list": taskListDispatchedStub([]),
  });
  const gitFn = fakeGitFn({
    worktree: gitWorktreeListOutput([VALID_WORKTREE]),
    status: "",
  });
  const existsFn = () => true;
  const ctx = eligibleTeardownCtx({
    policy: { protectedTargets: [], requireDurableEvidence: true },
  });
  const r = teardownSeat(ctx, {
    execFn,
    gitFn,
    existsFn,
    existingSeatHandle: "term_4b1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.judged.observation, OBSERVATION.CONSISTENT_PRESENT);
  assert.equal(r.judged.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.judged.reason, TEARDOWN_REASON.EVIDENCE_NOT_DURABLE);
  assert.equal(r.before.target.worktreeId, null);
  assert.equal(noDestructiveCalls(execFn), true);
});

// ---------------------------------------------------------------------------
// #7 -- armed 기본값 완화 저항
// ---------------------------------------------------------------------------
for (const [label, armedValue] of [
  ["omitted", undefined],
  ["string 'true'", "true"],
  ["number 1", 1],
]) {
  test(`mutation #7 (${label}): armed !== boolean-true strictly -- zero destructive argv, returned armed:false`, () => {
    const opts = staticEligibleOpts();
    const ctx = eligibleTeardownCtx({ armed: armedValue });
    if (armedValue === undefined) delete ctx.armed;
    const r = teardownSeat(ctx, opts);
    assert.equal(r.ok, false);
    assert.equal(r.armed, false);
    assert.equal(r.phase, TEARDOWN_PHASE.GATE);
    assert.equal(r.reason, TEARDOWN_GATE_REASON.NOT_ARMED);
    assert.equal(noDestructiveCalls(opts.execFn), true);
  });
}

// ---------------------------------------------------------------------------
// #8 -- --force 재삽입/실패 뒤 fallback 저항
// ---------------------------------------------------------------------------
test("mutation #8a: successful teardown -- rm argv never carries --force by default, rm called exactly once", () => {
  const opts = togglingEligibleOpts();
  const r = teardownSeat(eligibleTeardownCtx(), opts);
  assert.equal(r.ok, true);
  const rmCalls = opts.execFn.calls.filter(
    (a) => a[0] === "worktree" && a[1] === "rm",
  );
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].includes("--force"), false);
  assert.deepEqual(
    rmCalls[0],
    buildTeardownWorktreeRemoveCommand(VALID_WORKTREE, {}),
  );
});

test("mutation #8b: rm failure -- exactly one rm attempt, no automatic --force fallback retry", () => {
  const opts = togglingEligibleOpts({
    rmResponse: { ok: false, reason: "rm-boom" },
  });
  const r = teardownSeat(eligibleTeardownCtx(), opts);
  assert.equal(r.ok, false);
  assert.equal(r.phase, TEARDOWN_PHASE.REMOVE);
  const rmCalls = opts.execFn.calls.filter(
    (a) => a[0] === "worktree" && a[1] === "rm",
  );
  assert.equal(rmCalls.length, 1);
  assert.equal(
    rmCalls.every((a) => !a.includes("--force")),
    true,
  );
});

// ---------------------------------------------------------------------------
// #9 -- close 실패 뒤 rm 계속 저항
// ---------------------------------------------------------------------------
test("mutation #9: close failure -- rm and task-update are never called, phase CLOSE, original error preserved", () => {
  const opts = staticEligibleOpts({
    execStubs: { close: { ok: false, reason: "close-broke" } },
  });
  const r = teardownSeat(eligibleTeardownCtx(), opts);
  assert.equal(r.ok, false);
  assert.equal(r.phase, TEARDOWN_PHASE.CLOSE);
  assert.match(r.reason, /close-broke/);
  assert.equal(
    opts.execFn.calls.some((a) => a[0] === "worktree" && a[1] === "rm"),
    false,
  );
  assert.equal(
    opts.execFn.calls.some(
      (a) => a[0] === "orchestration" && a[1] === "task-update",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// #10 -- rm 실패 뒤 task-update 계속 저항
// ---------------------------------------------------------------------------
test("mutation #10: rm failure -- task-update is never called, before/after snapshots are both preserved on the result, phase REMOVE", () => {
  const opts = staticEligibleOpts({
    execStubs: { close: { ok: true }, rm: { ok: false, reason: "rm-broke" } },
  });
  const r = teardownSeat(eligibleTeardownCtx(), opts);
  assert.equal(r.ok, false);
  assert.equal(r.phase, TEARDOWN_PHASE.REMOVE);
  assert.ok(r.before);
  assert.ok(r.after);
  assert.equal(
    opts.execFn.calls.some(
      (a) => a[0] === "orchestration" && a[1] === "task-update",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// #11 -- CLI ok:true를 신뢰해 사후관측 생략 저항
// ---------------------------------------------------------------------------
test("mutation #11: rm reports ok:true but post-observe is split (git absent / orca present / dir present) -- FAILED_SPLIT, task-update 0, the three post layer fields are each checked (not just a final ok flag)", () => {
  const state = { removed: false };
  const execFn = fakeExecFn({
    list: managedWorktreeStub([VALID_WORKTREE]), // orca layer: stays present after rm
    "terminal-list": terminalListStub([terminalEntry()]),
    "task-list": taskListDispatchedStub([]),
    close: { ok: true },
    rm: () => {
      state.removed = true;
      return { ok: true, result: { removed: true } }; // cliOk true
    },
  });
  const gitFn = fakeGitFn({
    worktree: () =>
      state.removed ? "" : gitWorktreeListOutput([VALID_WORKTREE]),
    status: "",
  });
  const existsFn = () => true; // dir layer: stays present after rm
  const r = teardownSeat(eligibleTeardownCtx(), {
    execFn,
    gitFn,
    existsFn,
    existingSeatHandle: "term_4b1",
  });

  assert.equal(r.ok, false);
  assert.equal(r.phase, TEARDOWN_PHASE.REMOVE);
  assert.equal(r.execution, EXECUTION.FAILED_SPLIT);
  assert.equal(r.after.layers.git, "absent");
  assert.equal(r.after.layers.orca, "present");
  assert.equal(r.after.layers.dir, "present");
  assert.equal(
    execFn.calls.some(
      (a) => a[0] === "orchestration" && a[1] === "task-update",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// paired-good (양성 통제)
// ---------------------------------------------------------------------------
test("paired-good: armed + ELIGIBLE + post-observe all-absent -- close, rm(non-force), task-update exactly once each, in order, execution SUCCEEDED", () => {
  const opts = togglingEligibleOpts();
  const r = teardownSeat(eligibleTeardownCtx(), opts);

  assert.equal(r.ok, true);
  assert.equal(r.phase, TEARDOWN_PHASE.DONE);
  assert.equal(r.judged.allowSink, true);
  assert.equal(r.execution, EXECUTION.SUCCEEDED);

  const calls = opts.execFn.calls;
  const closeIdx = calls.findIndex(
    (a) => a[0] === "terminal" && a[1] === "close",
  );
  const rmIdx = calls.findIndex((a) => a[0] === "worktree" && a[1] === "rm");
  const taskUpdateIdx = calls.findIndex(
    (a) => a[0] === "orchestration" && a[1] === "task-update",
  );
  assert.ok(closeIdx >= 0);
  assert.ok(rmIdx > closeIdx);
  assert.ok(taskUpdateIdx > rmIdx);
  assert.equal(
    calls.filter((a) => a[0] === "terminal" && a[1] === "close").length,
    1,
  );
  assert.equal(
    calls.filter((a) => a[0] === "worktree" && a[1] === "rm").length,
    1,
  );
  assert.equal(
    calls.filter((a) => a[0] === "orchestration" && a[1] === "task-update")
      .length,
    1,
  );
  assert.deepEqual(
    calls[rmIdx],
    buildTeardownWorktreeRemoveCommand(VALID_WORKTREE, {}),
  );
  assert.deepEqual(
    calls[taskUpdateIdx],
    buildTaskUpdateFailedCommand("task_4b1"),
  );
});

// sanity: computeCanonicalPathDigest is exercised (not dead code) by
// protectedPolicyFor above -- direct assertion that it's deterministic.
test("sanity: computeCanonicalPathDigest is deterministic for the same path", () => {
  assert.equal(
    computeCanonicalPathDigest(VALID_WORKTREE),
    computeCanonicalPathDigest(VALID_WORKTREE),
  );
});
