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
  buildWorktreeRemoveCommand,
  buildWorktreeListCommand,
  checkWorktreeManaged,
  parseWorktreeList,
  WORKTREE_REASON,
  resolveSeatLocation,
  LOCATION_REASON,
  WORKSPACES_ROOT,
  MAIN_REPO_PATH,
  CONTROL_ROOM_PATH,
  ENGINE_BY_ROLE,
} from "./orca-adapter.mjs";

// HYK-169-coder-1/2: 어댑터 단위 테스트 -- 전부 execFn/fs fake 주입, 실 orca
// 호출 0(비타협 제약). G10(fake 어댑터만으로 코어 전 경로 검증)은
// relay-core.test.mjs가 이 어댑터 자체를 fake로 대체해 별도로 증명한다;
// 여기서는 이 어댑터의 포트 각각(성공/실패/재시도/env 미사용)을 검증한다.

// coder-2: ensureSeat이 이제 좌석 위치 정책(relay-terminal-setup.md §6)을
// 강제하므로, 위치 자체를 검증하지 않는 기존 ensureSeat 시험(설정/노드모듈
// 복사, 좌석 생성 응답 파싱 등)은 정책을 통과하는 실제 workspaces 경로를
// 써야 한다 -- 그래야 "이 시험이 검증하려는 것"과 "위치 정책"이 서로
// 간섭하지 않는다.
const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-test-fixture`;

function fakeExecFn(responses) {
  const calls = [];
  function fn(argv) {
    calls.push(argv);
    // "orchestration"/"worktree" both have a real subcommand as argv[1]
    // (list vs create need distinct stubs) -- "terminal" stays keyed on
    // argv[0] since its own subcommand (send/create/close) never overlaps.
    const key =
      argv[0] === "orchestration" || argv[0] === "worktree" ? argv[1] : argv[0];
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

// coder-4: ensureSeat now queries `worktree list` before creating a new
// seat -- every existing ensureSeat fixture that reaches seat creation
// needs a "list" stub reporting the target path as already managed
// (preserves each test's original intent: it's testing settings copy /
// seat-response parsing, not worktree registration).
function managedWorktreeStub(path = VALID_WORKTREE) {
  return { ok: true, result: { worktrees: [{ path }] } };
}

// ---------------------------------------------------------------------------
// ensureSeat
// ---------------------------------------------------------------------------
test("ensureSeat: reuse -- existingSeatHandle skips execFn entirely, no new seat created", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
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
    list: managedWorktreeStub(),
    terminal: {
      ok: true,
      result: { handle: "term_new", paneKey: "pane:leaf" },
    },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE, mainRepoDir: "/main" },
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
    `${VALID_WORKTREE}/.claude/settings.local.json`,
  ]);
  const copied = [];
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    terminal: { ok: true, result: { handle: "term_new" } },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE, mainRepoDir: "/main" },
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
    list: managedWorktreeStub(),
    terminal: { ok: true, result: { handle: "term_new" } },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE, mainRepoDir: "/main" },
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
    list: managedWorktreeStub(),
    terminal: { ok: true, result: { handle: "term_abc", paneKey: "tab:leaf" } },
  });
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: VALID_WORKTREE },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, true);
  assert.equal(r.seatHandle, "term_abc");
  assert.equal(r.paneKey, "tab:leaf");
  assert.equal(r.created, true);
});

test("ensureSeat: seat creation failure (response.ok:false) is surfaced, not swallowed", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    terminal: { ok: false, reason: "Setup decision required" },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /Setup decision required/);
});

test("ensureSeat: seat creation with missing handle in response is a failure (not undefined handle)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    terminal: { ok: true, result: {} },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
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
    { execFn, confirmPastedFn: () => true },
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
        return true;
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
    { execFn, confirmPastedFn: () => true },
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
    { execFn, confirmPastedFn: () => true },
  );
  assert.equal(r.ok, false);
  assert.equal(submitCalls, 2); // 1 initial + 1 retry, never more
});

// ---------------------------------------------------------------------------
// HYK-169-coder-3 (review-1 반려 결함 수리): confirmPastedFn의 반환값이
// 실제로 제출을 막는지 -- "호출됐는지"만 보던 헛시험(vacuous, review-1
// 지적)의 재발 방지. 모든 시험이 fake execFn의 호출 목록으로 `terminal`
// 계열(제출) 호출이 정확히 0건임을 인자까지 확인한다.
// ---------------------------------------------------------------------------
function noTerminalCalls(execFn) {
  return execFn.calls.every((argv) => argv[0] !== "terminal");
}

// 1. confirmPastedFn: () => false -> ok:false, 사유 코드 일치, submit 0건.
test("deliverTask: PASTE_UNCONFIRMED -- confirmPastedFn returning false refuses submit with zero 'terminal send' calls", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn, confirmPastedFn: () => false },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /PASTE_UNCONFIRMED/);
  assert.equal(execFn.calls.length, 2); // task-create, dispatch only
  assert.equal(noTerminalCalls(execFn), true);
});

// 2. confirmPastedFn: () => true -> 정상 제출 1회 (이미 위 B3/B11/retry 시험들이 커버).
test("deliverTask: PASTE_UNCONFIRMED -- confirmPastedFn returning true allows exactly one submit call", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn, confirmPastedFn: () => true },
  );
  assert.equal(r.ok, true);
  assert.equal(execFn.calls.filter((argv) => argv[0] === "terminal").length, 1);
});

// 3. confirmPastedFn이 throw -> 실패 처리, submit 0건(붙여넣기 여부를 모르는
// 예외 상황에서 Enter를 보내는 것보다 안전 실패가 항상 낫다).
test("deliverTask: PASTE_UNCONFIRMED -- confirmPastedFn throwing is treated as unconfirmed, zero submit calls", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    {
      execFn,
      confirmPastedFn: () => {
        throw new Error("paste-check crashed");
      },
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /PASTE_UNCONFIRMED/);
  assert.equal(noTerminalCalls(execFn), true);
});

// 4. confirmPastedFn 미주입 -> 보수적 기본값(false 취급)이 시험으로 고정.
test("deliverTask: PASTE_UNCONFIRMED -- omitting confirmPastedFn defaults to unconfirmed (conservative default), zero submit calls", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /PASTE_UNCONFIRMED/);
  assert.equal(execFn.calls.length, 2); // task-create, dispatch -- no submit
  assert.equal(noTerminalCalls(execFn), true);
});

// non-strict truthy return (e.g. a non-boolean truthy value) must NOT count
// as confirmed -- only strict `true` does (defensive against accidental
// truthy returns like an object or a non-empty string).
test("deliverTask: PASTE_UNCONFIRMED -- a truthy-but-not-true return value does not confirm (strict boolean check)", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    terminal: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn, confirmPastedFn: () => "yes" },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /PASTE_UNCONFIRMED/);
  assert.equal(noTerminalCalls(execFn), true);
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

// coder-2: 정리 규칙(relay-terminal-setup.md §6) -- 워크트리 제거 명령을
// 구성만 하고 실행하지 않는다(비타협 제약).
test("teardownSeat: builds a worktree-remove command (construction only, not executed) when worktreePath is given", () => {
  const execFn = fakeExecFn({
    terminal: { ok: true },
    "dispatch-cleanup": { ok: true },
  });
  const r = teardownSeat(
    { seatHandle: "term_x", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.worktreeRemoveCommand,
    buildWorktreeRemoveCommand(VALID_WORKTREE),
  );
  // never executed -- execFn was only called for terminal close + dispatch-cleanup (2 calls)
  assert.equal(execFn.calls.length, 2);
});

test("teardownSeat: worktreeRemoveCommand is null when no worktreePath is given (backward compatible)", () => {
  const execFn = fakeExecFn({
    terminal: { ok: true },
    "dispatch-cleanup": { ok: true },
  });
  const r = teardownSeat({ seatHandle: "term_x" }, { execFn });
  assert.equal(r.worktreeRemoveCommand, null);
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

// ---------------------------------------------------------------------------
// HYK-169-coder-2: 좌석 위치 정책 (resolveSeatLocation) -- relay-terminal-
// setup.md §6. 순수 판정, fs/orca 호출 없음. "거부를 증명하는 것이 핵심"
// (태스크 지시) -- known-bad가 다수, known-good은 최소.
// ---------------------------------------------------------------------------

// 1. 관제실 하위 경로 -> 거부, reason 구분됨.
test("resolveSeatLocation: BLOCK -- control-room subpath is rejected with CONTROL_ROOM_FORBIDDEN", () => {
  const r = resolveSeatLocation({
    role: "REVIEW",
    requestedPath: `${CONTROL_ROOM_PATH}\\PM\\relay\\wt`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.CONTROL_ROOM_FORBIDDEN);
});

test("resolveSeatLocation: BLOCK -- the control room root itself (no subpath) is rejected", () => {
  const r = resolveSeatLocation({
    role: "CODER",
    requestedPath: CONTROL_ROOM_PATH,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.CONTROL_ROOM_FORBIDDEN);
});

// 2. 메인 repo 경로 -> 워커 좌석으로는 거부.
test("resolveSeatLocation: BLOCK -- main repo path is rejected for a worker seat with MAIN_REPO_FORBIDDEN", () => {
  const r = resolveSeatLocation({
    role: "CODER",
    requestedPath: MAIN_REPO_PATH,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
});

test("resolveSeatLocation: BLOCK -- a subpath under the main repo is also rejected", () => {
  const r = resolveSeatLocation({
    role: "REVIEW",
    requestedPath: `${MAIN_REPO_PATH}/scripts`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
});

// 3. workspaces 밖 임의 경로 -> 거부.
test("resolveSeatLocation: BLOCK -- an arbitrary path outside workspaces is rejected with OUTSIDE_WORKSPACES", () => {
  const r = resolveSeatLocation({
    role: "CODER",
    requestedPath: "C:\\temp\\wt",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.OUTSIDE_WORKSPACES);
});

// 4. 정규화 우회 시도 -- 단순 접두어 비교라면 통과해버리는 케이스.
test("resolveSeatLocation: BLOCK -- '..' traversal that resolves back into the main repo is rejected (not fooled by prefix match)", () => {
  const r = resolveSeatLocation({
    role: "CODER",
    requestedPath: `${WORKSPACES_ROOT}\\..\\..\\Documents\\HARNESSENGINEERING`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
});

test("resolveSeatLocation: BLOCK -- mixed case + backslash + trailing slash variants of forbidden paths are still caught (normalization)", () => {
  const r1 = resolveSeatLocation({
    role: "CODER",
    requestedPath: "c:\\users\\administrator\\documents\\harnessengineering\\",
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);

  const r2 = resolveSeatLocation({
    role: "REVIEW",
    requestedPath: "D:/문서관리/하네스-관제실/PM/relay/",
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, LOCATION_REASON.CONTROL_ROOM_FORBIDDEN);
});

// 5. 정상 경로(CODER 이슈 워크트리 / REVIEW 검증 워크트리) -> 통과.
test("resolveSeatLocation: PASS -- a CODER issue worktree under workspaces is allowed", () => {
  const r = resolveSeatLocation({
    role: "CODER",
    requestedPath: `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk169-adapter`,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, LOCATION_REASON.ALLOW);
});

test("resolveSeatLocation: PASS -- a REVIEW verification worktree under workspaces is allowed", () => {
  const r = resolveSeatLocation({
    role: "REVIEW",
    requestedPath: `${WORKSPACES_ROOT}\\HARNESSENGINEERING\\review-verify-hyk169`,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, LOCATION_REASON.ALLOW);
});

test("resolveSeatLocation: role unknown / path missing produce distinct reasons", () => {
  assert.equal(
    resolveSeatLocation({ role: "NOT_A_ROLE", requestedPath: VALID_WORKTREE })
      .reason,
    LOCATION_REASON.ROLE_UNKNOWN,
  );
  assert.equal(
    resolveSeatLocation({ role: "CODER", requestedPath: "" }).reason,
    LOCATION_REASON.PATH_REQUIRED,
  );
});

// 6. ensureSeat이 거부 시 좌석 생성 호출 0회.
test("ensureSeat: rejects a control-room worktree path with zero execFn calls", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: `${CONTROL_ROOM_PATH}\\PM\\relay\\wt` },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.locationReason, LOCATION_REASON.CONTROL_ROOM_FORBIDDEN);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: rejects the main repo path with zero execFn calls", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: MAIN_REPO_PATH },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.locationReason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: rejects a path outside workspaces with zero execFn calls", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: "C:\\temp\\wt" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.locationReason, LOCATION_REASON.OUTSIDE_WORKSPACES);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: rejects a normalization-bypass traversal path with zero execFn calls", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    {
      role: "CODER",
      worktreePath: `${WORKSPACES_ROOT}\\..\\..\\Documents\\HARNESSENGINEERING`,
    },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.locationReason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
  assert.equal(execFn.calls.length, 0);
});

// existingSeatHandle 재사용 경로도 위치 정책을 통과해야 한다(방어 종심).
test("ensureSeat: location policy applies even to the existingSeatHandle reuse path", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: MAIN_REPO_PATH },
    { execFn, existingSeatHandle: "term_reused" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.locationReason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
  assert.equal(execFn.calls.length, 0);
});

// ---------------------------------------------------------------------------
// HYK-169-coder-4 (review-2 반려 결함 수리): 위치 정책의 절반(경로 문자열)만
// 검사하고 "이 폴더가 실제 Orca 관리 워크트리인가"는 확인하지 않던 결함.
// 실제 사고=B15(Orca가 모르는 워크트리에 붙은 좌석 = UI에서 안 보이는
// 유령 터미널). "거부를 증명하는 것이 1순위"(태스크 지시).
// ---------------------------------------------------------------------------

function terminalCallCount(execFn) {
  return execFn.calls.filter((argv) => argv[0] === "terminal").length;
}
function worktreeCreateCallCount(execFn) {
  return execFn.calls.filter(
    (argv) => argv[0] === "worktree" && argv[1] === "create",
  ).length;
}

// 1. 워크트리 최상위 루트 자체 -> 거부, 사유 코드 구분, fake 호출 0건.
test("resolveSeatLocation: BLOCK -- the workspaces root itself is not a worktree (WORKSPACES_ROOT_NOT_A_WORKTREE)", () => {
  const r = resolveSeatLocation({
    role: "REVIEW",
    requestedPath: WORKSPACES_ROOT,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.WORKSPACES_ROOT_NOT_A_WORKTREE);
});

test("ensureSeat: rejects the workspaces root itself with zero execFn calls (review-2 exact repro)", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: WORKSPACES_ROOT },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(
    r.locationReason,
    LOCATION_REASON.WORKSPACES_ROOT_NOT_A_WORKTREE,
  );
  assert.equal(execFn.calls.length, 0); // not even a worktree-list query
});

// checkWorktreeManaged unit tests (pure port, no ensureSeat wiring).
test("checkWorktreeManaged: PASS -- a path present in the managed list is reported managed", () => {
  const execFn = fakeExecFn({ list: managedWorktreeStub(VALID_WORKTREE) });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
  assert.equal(worktreeCreateCallCount(execFn), 0);
});

test("checkWorktreeManaged: PASS -- managed-list match is normalized (case/backslash-insensitive, coder-2 normalizeAbsolute reuse)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(
      VALID_WORKTREE.toUpperCase().replace(/\//g, "\\"),
    ),
  });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

// 2. 관리 목록에 없는 경로 -> 항상 거부, 좌석 생성 호출 0건.
test("checkWorktreeManaged: BLOCK -- an unregistered path is rejected (NOT_ORCA_MANAGED), no create call", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub("C:/some/other/worktree"),
  });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_REASON.NOT_ORCA_MANAGED);
  assert.equal(worktreeCreateCallCount(execFn), 0);
});

test("ensureSeat: rejects an unregistered worktree -- zero seat-creation calls (review-2 repro)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub("C:/some/other/worktree"),
  });
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.NOT_ORCA_MANAGED);
  assert.equal(terminalCallCount(execFn), 0); // no seat-creation call
  assert.equal(worktreeCreateCallCount(execFn), 0);
});

// coder-5 (review-3 반려, 사람 결정 2026-07-22): 생성 기능 v1 제거 --
// buildWorktreeCreateCommand는 더 이상 존재하지 않는다(실제 CLI는 --name
// 기반이고 실물 검증 전까지 argv를 만들지 않는다). 아래 3개 시험은 coder-4가
// 만든 "allowCreate:true로 생성까지 이어진다"는 known-good 시험을 **삭제
// 대신 "옵션을 넘겨도 무시되고 거부된다"는 known-bad로 전환**한 것이다
// (태스크 지시 §7 -- 무의미해진 시험을 조용히 지우지 않는다).
test("checkWorktreeManaged: passing an 'allowCreate'-named field is silently ignored -- still rejected, never calls worktree create (creation removed in v1)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub("C:/some/other/worktree"),
    create: { ok: true, result: { path: VALID_WORKTREE } }, // stubbed but must never fire
  });
  const r = checkWorktreeManaged(
    { requestedPath: VALID_WORKTREE, allowCreate: true },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_REASON.NOT_ORCA_MANAGED);
  assert.equal(worktreeCreateCallCount(execFn), 0);
});

test("ensureSeat: passing opts.allowCreate:true on an unregistered path is ignored -- still rejected, zero seat-creation calls (creation removed in v1)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub("C:/some/other/worktree"),
    create: { ok: true, result: { path: VALID_WORKTREE } }, // stubbed but must never fire
    terminal: { ok: true, result: { handle: "term_new" } }, // stubbed but must never fire
  });
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: VALID_WORKTREE },
    { execFn, allowCreate: true },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.NOT_ORCA_MANAGED);
  assert.equal(worktreeCreateCallCount(execFn), 0);
  assert.equal(terminalCallCount(execFn), 0);
});

test("WORKTREE_REASON no longer has a CREATE_FAILED entry (creation removed in v1)", () => {
  assert.equal("CREATE_FAILED" in WORKTREE_REASON, false);
});

// 4. 관리 목록에 있는 경로 -> worktree create 호출 0건, 좌석만 생성(재사용).
test("ensureSeat: a path already in the managed list skips worktree create entirely", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    terminal: { ok: true, result: { handle: "term_new" } },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(worktreeCreateCallCount(execFn), 0);
  assert.equal(terminalCallCount(execFn), 1);
});

// 5. 관리 목록 조회 자체가 실패 -> 보수적 실패, 좌석 생성 호출 0건.
test("checkWorktreeManaged: BLOCK -- execFn throwing on the list query is a conservative failure (LIST_QUERY_FAILED)", () => {
  const execFn = () => {
    throw new Error("orca down");
  };
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_REASON.LIST_QUERY_FAILED);
});

test("checkWorktreeManaged: BLOCK -- a malformed list response (no result.worktrees) is a conservative failure", () => {
  const execFn = fakeExecFn({ list: { ok: true, result: {} } });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_REASON.LIST_QUERY_FAILED);
});

test("ensureSeat: a failing worktree-list query is a conservative failure, zero seat-creation calls", () => {
  const execFn = fakeExecFn({
    list: { ok: false, reason: "orca unreachable" },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.LIST_QUERY_FAILED);
  assert.equal(terminalCallCount(execFn), 0);
});

// coder-5: no creation option exists at all anymore -- an unregistered path
// is unconditionally rejected with no way to opt into creation (conservative
// by construction, not by a default value -- coder-3 principle carried
// forward at the API-surface level).
test("checkWorktreeManaged: an unregistered path is unconditionally rejected -- there is no option to opt into creation", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub("C:/some/other/worktree"),
  });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_REASON.NOT_ORCA_MANAGED);
});

// ---------------------------------------------------------------------------
// HYK-169-coder-5 (review-3 반려 결함 수리): 등록 목록 대조가 후행 구분자
// (`/`, `\`)에서 실패해 실제 등록된 워크트리를 잘못 거부하던 결함.
// ---------------------------------------------------------------------------

// 1. 후행 `/`, 후행 `\`, 후행 없음 -- 셋 다 같은 등록 경로로 통과.
test("checkWorktreeManaged: trailing '/' on the registered entry does not break the match", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(`${VALID_WORKTREE}/`),
  });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

test("checkWorktreeManaged: trailing '\\' on the registered entry does not break the match", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(`${VALID_WORKTREE.replace(/\//g, "\\")}\\`),
  });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

test("checkWorktreeManaged: trailing separator on the *requested* path (not just the registered entry) also matches", () => {
  const execFn = fakeExecFn({ list: managedWorktreeStub(VALID_WORKTREE) });
  const r = checkWorktreeManaged(
    { requestedPath: `${VALID_WORKTREE}/` },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

// 2. 드라이브 루트(C:\)는 후행 제거로 망가지지 않는지(경계 케이스).
test("checkWorktreeManaged: a drive root ('C:/') registered entry is not mangled by trailing-separator stripping", () => {
  const execFn = fakeExecFn({ list: managedWorktreeStub("C:\\") });
  const r = checkWorktreeManaged({ requestedPath: "C:/" }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

// 3. 대소문자·역슬래시·`..` 조합 + 후행 구분자 동시 변형도 통과.
test("checkWorktreeManaged: combined case/backslash/'..'/trailing-separator variance still matches (all coder-2/coder-5 normalization together)", () => {
  const execFn = fakeExecFn({ list: managedWorktreeStub(VALID_WORKTREE) });
  const weird = `${WORKSPACES_ROOT.toUpperCase().replace(/\//g, "\\")}\\..\\${WORKSPACES_ROOT.split("/").pop().toUpperCase()}\\HARNESSENGINEERING\\hyk-test-fixture\\`;
  const r = checkWorktreeManaged({ requestedPath: weird }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

test("parseWorktreeList: pure parser -- extracts result.worktrees, null on any malformed shape", () => {
  assert.deepEqual(
    parseWorktreeList({ ok: true, result: { worktrees: [{ path: "/a" }] } }),
    [{ path: "/a" }],
  );
  assert.equal(
    parseWorktreeList({ ok: false, result: { worktrees: [] } }),
    null,
  );
  assert.equal(parseWorktreeList({ ok: true, result: {} }), null);
  assert.equal(parseWorktreeList(null), null);
});

test("buildWorktreeListCommand: exact argv shape", () => {
  assert.deepEqual(buildWorktreeListCommand(), ["worktree", "list", "--json"]);
});
