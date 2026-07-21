import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ensureSeat,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
  buildSeatCreateCommand,
  buildSeatSubmitCommand,
  buildSeatCloseCommand,
  buildNonBlockingCheckCommand,
  buildDispatchCleanupCommand,
  ENGINE_BY_ROLE,
} from "./orca-adapter.mjs";

// HYK-169-coder-1: 어댑터 단위 테스트 -- 전부 execFn/fs fake 주입, 실 orca
// 호출 0(비타협 제약). G10(fake 어댑터만으로 코어 전 경로 검증)은
// relay-core.test.mjs가 이 어댑터 자체를 fake로 대체해 별도로 증명한다;
// 여기서는 이 어댑터의 포트 각각(성공/실패/재시도/env 미사용)을 검증한다.

function fakeExecFn(responses) {
  const calls = [];
  function fn(argv) {
    calls.push(argv);
    const key = argv[0] === "orchestration" ? argv[1] : argv[0];
    const entry = responses[key];
    if (typeof entry === "function") return entry(argv, calls.length);
    if (entry === undefined) {
      throw new Error(
        `fakeExecFn: no stub for command '${key}' (argv=${JSON.stringify(argv)})`,
      );
    }
    return entry;
  }
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// ensureSeat
// ---------------------------------------------------------------------------
test("ensureSeat: reuse -- existingSeatHandle skips execFn entirely, no new seat created", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: "/wt" },
    { existingSeatHandle: "term_reused", execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.seatHandle, "term_reused");
  assert.equal(r.created, false);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: unknown role is rejected before any execFn call", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat({ role: "NOT_A_ROLE", worktreePath: "/wt" }, { execFn });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown role/);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: missing worktreePath is rejected", () => {
  const r = ensureSeat({ role: "CODER" }, { execFn: fakeExecFn({}) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /worktreePath/);
});

test("ensureSeat: A3 settings.local.json copied from mainRepoDir when missing at destination", () => {
  const exists = new Set(["/main/.claude/settings.local.json"]);
  const copied = [];
  const execFn = fakeExecFn({
    terminal: {
      ok: true,
      result: { handle: "term_new", paneKey: "pane:leaf" },
    },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: "/wt", mainRepoDir: "/main" },
    {
      execFn,
      existsFn: (p) => exists.has(p.replace(/\\/g, "/")),
      mkdirFn: () => {},
      copyFileFn: (src, dst) => copied.push([src, dst]),
      copyDirFn: () => {},
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.stepsPerformed.includes("settings-copied"), true);
  assert.equal(copied.length, 1);
});

test("ensureSeat: A3 copy skipped when destination already has settings.local.json (idempotent)", () => {
  const exists = new Set([
    "/main/.claude/settings.local.json",
    "/wt/.claude/settings.local.json",
  ]);
  const copied = [];
  const execFn = fakeExecFn({
    terminal: { ok: true, result: { handle: "term_new" } },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: "/wt", mainRepoDir: "/main" },
    {
      execFn,
      existsFn: (p) => exists.has(p.replace(/\\/g, "/")),
      copyFileFn: (src, dst) => copied.push([src, dst]),
      copyDirFn: () => {},
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.stepsPerformed.includes("settings-copied"), false);
  assert.equal(copied.length, 0);
});

test("ensureSeat: A5 node_modules copied from mainRepoDir when missing at destination", () => {
  const exists = new Set(["/main/node_modules"]);
  const copiedDirs = [];
  const execFn = fakeExecFn({
    terminal: { ok: true, result: { handle: "term_new" } },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: "/wt", mainRepoDir: "/main" },
    {
      execFn,
      existsFn: (p) => exists.has(p.replace(/\\/g, "/")),
      copyFileFn: () => {},
      copyDirFn: (src, dst) => copiedDirs.push([src, dst]),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.stepsPerformed.includes("node_modules-copied"), true);
  assert.equal(copiedDirs.length, 1);
});

test("ensureSeat: new seat creation reads handle/paneKey from response.result, both engines", () => {
  const execFn = fakeExecFn({
    terminal: { ok: true, result: { handle: "term_abc", paneKey: "tab:leaf" } },
  });
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: "/wt" },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, true);
  assert.equal(r.seatHandle, "term_abc");
  assert.equal(r.paneKey, "tab:leaf");
  assert.equal(r.created, true);
});

test("ensureSeat: seat creation failure (response.ok:false) is surfaced, not swallowed", () => {
  const execFn = fakeExecFn({
    terminal: { ok: false, reason: "Setup decision required" },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: "/wt" },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /Setup decision required/);
});

test("ensureSeat: seat creation with missing handle in response is a failure (not undefined handle)", () => {
  const execFn = fakeExecFn({ terminal: { ok: true, result: {} } });
  const r = ensureSeat(
    { role: "CODER", worktreePath: "/wt" },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /handle missing\/empty/);
});

// ---------------------------------------------------------------------------
// B2: env(ORCA_TERMINAL_HANDLE)를 읽지 않는다 -- 소스 자체를 정적 검사.
// ---------------------------------------------------------------------------
test("B2: orca-adapter.mjs source never reads ORCA_TERMINAL_HANDLE from env (handle must come from pane-key lookups only)", () => {
  const src = readFileSync(
    new URL("./orca-adapter.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(src.includes("ORCA_TERMINAL_HANDLE"), false);
  assert.equal(src.includes("process.env"), false);
});

// ---------------------------------------------------------------------------
// deliverTask
// ---------------------------------------------------------------------------
function taskCreateDispatchStubs(overrides = {}) {
  return {
    "task-create": {
      ok: true,
      result: { task: { id: "task_rt1", status: "ready" } },
    },
    dispatch: { ok: true, result: { id: "ctx_1" } },
    ...overrides,
  };
}

test("deliverTask: claude engine (CODER) needs no explicit submit -- auto, retries 0, single dispatch call", () => {
  const execFn = fakeExecFn(taskCreateDispatchStubs());
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "CODER", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.submitted, "auto");
  assert.equal(r.retries, 0);
  assert.equal(execFn.calls.length, 2); // task-create, dispatch -- no submit call
});

test("deliverTask: codex engine (REVIEW) requires an explicit submit call after dispatch (B3)", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.submitted, "explicit");
  assert.equal(r.retries, 0);
  assert.equal(execFn.calls.length, 3); // task-create, dispatch, submit
});

test("deliverTask: B11 -- confirmPastedFn is invoked before the submit call for codex", () => {
  let confirmedBeforeSubmit = false;
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: () => {
      assert.equal(
        confirmedBeforeSubmit,
        true,
        "submit fired before paste was confirmed",
      );
      return { ok: true };
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    {
      execFn,
      confirmPastedFn: () => {
        confirmedBeforeSubmit = true;
      },
    },
  );
  assert.equal(r.ok, true);
});

test("deliverTask: submit retry -- fails once then succeeds on the 1 allowed retry (retries:1)", () => {
  let submitCalls = 0;
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: () => {
      submitCalls++;
      return submitCalls === 1
        ? { ok: false, reason: "transient" }
        : { ok: true };
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.retries, 1);
  assert.equal(submitCalls, 2);
});

test("deliverTask: submit retry cap -- default maxRetries=1 means at most 2 attempts total, then fails (no infinite retry)", () => {
  let submitCalls = 0;
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: () => {
      submitCalls++;
      return { ok: false, reason: "always fails" };
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(submitCalls, 2); // 1 initial + 1 retry, never more
});

test("deliverTask: task-create failure short-circuits before dispatch/submit", () => {
  const execFn = fakeExecFn({
    "task-create": { ok: false, reason: "predispatch denied" },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "CODER", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /predispatch denied/);
  assert.equal(execFn.calls.length, 1);
});

test("deliverTask: dispatch failure short-circuits before submit", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs({
      dispatch: { ok: false, reason: "no such seat" },
    }),
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /no such seat/);
  assert.equal(execFn.calls.length, 2); // task-create, dispatch -- submit never attempted
});

test("deliverTask: invalid task_id (whitespace) is rejected before any execFn call (buildSpec reuse)", () => {
  const execFn = fakeExecFn({});
  const r = deliverTask(
    { taskId: "bad id", role: "CODER", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(execFn.calls.length, 0);
});

test("deliverTask: missing seatHandle is rejected", () => {
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "CODER" },
    { execFn: fakeExecFn({}) },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /seatHandle/);
});

// ---------------------------------------------------------------------------
// collectCompletionSignals -- advisory only, never fatal
// ---------------------------------------------------------------------------
test("collectCompletionSignals: returns messages array on a well-formed ok response", () => {
  const execFn = fakeExecFn({
    check: { ok: true, result: { messages: [{ type: "worker_done" }] } },
  });
  const r = collectCompletionSignals(
    { coordinatorHandle: "term_coord" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.signals.length, 1);
});

test("collectCompletionSignals: execFn throwing does not throw up -- returns ok:true with empty signals (advisory-only)", () => {
  const execFn = () => {
    throw new Error("orca down");
  };
  const r = collectCompletionSignals(
    { coordinatorHandle: "term_coord" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.signals, []);
  assert.match(r.note, /orca down/);
});

test("collectCompletionSignals: no execFn injected is not fatal, just skips the advisory query", () => {
  const r = collectCompletionSignals({ coordinatorHandle: "term_coord" }, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.signals, []);
});

test("collectCompletionSignals: never used as completion authority -- signature carries no 'done'/'complete' field", () => {
  const execFn = fakeExecFn({
    check: { ok: true, result: { messages: [{ type: "worker_done" }] } },
  });
  const r = collectCompletionSignals(
    { coordinatorHandle: "term_coord" },
    { execFn },
  );
  assert.equal("done" in r, false);
  assert.equal("complete" in r, false);
});

// ---------------------------------------------------------------------------
// teardownSeat
// ---------------------------------------------------------------------------
test("teardownSeat: closes seat and runs best-effort dispatch cleanup", () => {
  const execFn = fakeExecFn({
    terminal: { ok: true },
    "dispatch-cleanup": { ok: true, result: { cleaned: 1 } },
  });
  const r = teardownSeat({ seatHandle: "term_x" }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.cleanup.ok, true);
});

test("teardownSeat: close failure is reported but cleanup is still attempted", () => {
  let cleanupCalled = false;
  const execFn = (argv) => {
    if (argv[0] === "terminal") return { ok: false, reason: "already closed" };
    cleanupCalled = true;
    return { ok: true };
  };
  const r = teardownSeat({ seatHandle: "term_x" }, { execFn });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already closed/);
  assert.equal(cleanupCalled, true);
});

test("teardownSeat: missing seatHandle is rejected", () => {
  const r = teardownSeat({}, { execFn: fakeExecFn({}) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /seatHandle/);
});

// ---------------------------------------------------------------------------
// command builders -- pure shape checks (no execution)
// ---------------------------------------------------------------------------
test("command builders produce plain arrays with expected fixed tokens", () => {
  assert.ok(buildSeatCreateCommand("CODER", "/wt").includes("--setup"));
  assert.deepEqual(buildSeatSubmitCommand("term_x").slice(0, 2), [
    "terminal",
    "send",
  ]);
  assert.deepEqual(buildSeatCloseCommand("term_x").slice(0, 2), [
    "terminal",
    "close",
  ]);
  assert.deepEqual(buildNonBlockingCheckCommand("term_coord").slice(0, 2), [
    "orchestration",
    "check",
  ]);
  assert.equal(
    buildNonBlockingCheckCommand("term_coord").includes("--wait"),
    false,
  );
  assert.deepEqual(buildDispatchCleanupCommand("term_x").slice(0, 2), [
    "orchestration",
    "dispatch-cleanup",
  ]);
});

test("ENGINE_BY_ROLE: CODER/VERIFY are claude, REVIEW is codex (B9 single config point)", () => {
  assert.equal(ENGINE_BY_ROLE.CODER, "claude");
  assert.equal(ENGINE_BY_ROLE.VERIFY, "claude");
  assert.equal(ENGINE_BY_ROLE.REVIEW, "codex");
});
