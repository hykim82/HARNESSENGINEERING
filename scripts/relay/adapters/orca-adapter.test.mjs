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
  buildTaskUpdateFailedCommand,
  buildWorktreeRemoveCommand,
  buildWorktreeListCommand,
  buildWorktreeCreateCommand,
  parseWorktreeCreateResponse,
  createManagedWorktree,
  checkWorktreeManaged,
  parseWorktreeList,
  isOrphanSeat,
  isGhostTab,
  buildSeatShowCommand,
  parseSeatPreview,
  normalizePreview,
  previewContainsMarker,
  previewShowsBusySignal,
  WORKTREE_REASON,
  resolveSeatLocation,
  LOCATION_REASON,
  WORKSPACES_ROOT,
  MAIN_REPO_PATH,
  CONTROL_ROOM_PATH,
  ENGINE_BY_ROLE,
} from "./orca-adapter.mjs";

// HYK-170 coder-1: 어댑터 단위 테스트 -- 전부 execFn/fs fake 주입, 실 orca
// 호출 0(비타협 제약). fixture는 관제실 산출물
// `2026-07-22-hyk170-어댑터Bv2/실CLI-argv-검증-{1,2}단-*.md`의 실측 JSON을
// 그대로 옮긴 것이다(지어낸 값 0) -- 헛시험 재발 방지(이 태스크의 존재
// 이유): argv 문자열만 비교하는 시험이 아니라, "실측 fixture 응답을 먹였을
// 때 함수가 올바른 값을 뽑아내는가"를 단언한다.

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-test-fixture`;

// ---------------------------------------------------------------------------
// 실측 fixture (2단-라이브프로브.md §1~§5 그대로)
// ---------------------------------------------------------------------------
const FIXTURE_WORKTREE_CREATE_RESPONSE = {
  ok: true,
  result: {
    worktree: {
      id: "repoId::C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk170-probe",
      path: `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk170-probe`,
      branch: "refs/heads/hykim82/hyk170-probe",
      head: "dfdd971...",
      baseRef: "refs/remotes/origin/master",
      isMainWorktree: false,
      displayName: "hyk170-probe",
    },
    lineage: null,
    workspaceLineage: null,
    warnings: [],
  },
};

const FIXTURE_TERMINAL_CREATE_RESPONSE = {
  ok: true,
  result: {
    terminal: {
      handle: "term_45d41401-0000-0000-0000-000000000000",
      tabId: "11111111-2222-3333-4444-555555555555",
      paneKey: "11111111-2222-3333-4444-555555555555:leaf1",
      ptyId: "repoId::path@@short",
      worktreeId: "repoId::path",
      title: "HYK170-PROBE",
      surface: "visible",
    },
  },
};

const FIXTURE_TAB_NOT_FOUND_RESPONSE = {
  ok: false,
  error: { code: "runtime_error", message: "tab_not_found" },
};

const FIXTURE_WORKTREE_RM_RESPONSE = { ok: true, result: { removed: true } };

// preview redraw artifact -- 실측 원문(2단 §3): 셸 예측입력으로 문자 단위
// 재그림이 섞인다. 완전 일치가 아니라 정규화 후 마커 부분 일치로만 확인.
const FIXTURE_PREVIEW_REDRAW =
  "eecho HYK170_ARecho HYK170_ARR  echo HYK170_ARRIVAL_MARK\nHYK170_ARRIVAL_MARK\n";

function fakeExecFn(responses) {
  const calls = [];
  function fn(argv) {
    calls.push(argv);
    // "orchestration"/"worktree" both have a real subcommand as argv[1]
    // (list vs create/rm, check vs task-update need distinct stubs) --
    // "terminal" is keyed on argv[1] too (create/send/close/show never overlap).
    const key =
      argv[0] === "orchestration" ||
      argv[0] === "worktree" ||
      argv[0] === "terminal"
        ? argv[1]
        : argv[0];
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

function managedWorktreeStub(path = VALID_WORKTREE) {
  return { ok: true, result: { worktrees: [{ path }] } };
}

// ---------------------------------------------------------------------------
// A1: buildSeatCreateCommand -- exact argv shape (실측 §8-1)
// ---------------------------------------------------------------------------
test("buildSeatCreateCommand: uses --worktree/--command/--title, no --shell/--setup (A1 fix)", () => {
  const argv = buildSeatCreateCommand("CODER", "/wt/path");
  assert.deepEqual(argv.slice(0, 4), [
    "terminal",
    "create",
    "--worktree",
    "path:/wt/path",
  ]);
  assert.equal(argv.includes("--command"), true);
  assert.deepEqual(argv.slice(-3), ["--title", "CODER", "--json"]);
  assert.equal(argv.includes("--shell"), false);
  assert.equal(argv.includes("--setup"), false);
});

// ---------------------------------------------------------------------------
// A2/A3: --terminal not --handle (실측 §8-2/§8-3), no --tab on close
// ---------------------------------------------------------------------------
test("buildSeatSubmitCommand: --terminal not --handle (A2 fix)", () => {
  assert.deepEqual(buildSeatSubmitCommand("term_x"), [
    "terminal",
    "send",
    "--terminal",
    "term_x",
    "--enter",
    "--json",
  ]);
});

test("buildSeatCloseCommand: --terminal not --handle, and never --tab (A3 fix)", () => {
  const argv = buildSeatCloseCommand("term_x");
  assert.deepEqual(argv, [
    "terminal",
    "close",
    "--terminal",
    "term_x",
    "--json",
  ]);
  assert.equal(argv.includes("--tab"), false);
});

// ---------------------------------------------------------------------------
// A4: --peek added to the advisory check (실측 §8-4 / 1단 §5)
// ---------------------------------------------------------------------------
test("buildNonBlockingCheckCommand: includes --peek, never --wait", () => {
  const argv = buildNonBlockingCheckCommand("term_coord");
  assert.equal(argv.includes("--peek"), true);
  assert.equal(argv.includes("--wait"), false);
  assert.deepEqual(argv.slice(0, 2), ["orchestration", "check"]);
});

// ---------------------------------------------------------------------------
// A5: worktree rm --force (실측 §8-5), replaces the git-command construction
// ---------------------------------------------------------------------------
test("buildWorktreeRemoveCommand: real orca 'worktree rm --force --json' (A5 fix, not a git command)", () => {
  assert.deepEqual(buildWorktreeRemoveCommand(VALID_WORKTREE), [
    "worktree",
    "rm",
    "--worktree",
    `path:${VALID_WORKTREE}`,
    "--force",
    "--json",
  ]);
});

// ---------------------------------------------------------------------------
// A6: task-update --status failed replaces the nonexistent dispatch-cleanup
// (실측 §8-6)
// ---------------------------------------------------------------------------
test("buildTaskUpdateFailedCommand: 'orchestration task-update --id <taskId> --status failed' (A6 fix)", () => {
  assert.deepEqual(buildTaskUpdateFailedCommand("task_rt1"), [
    "orchestration",
    "task-update",
    "--id",
    "task_rt1",
    "--status",
    "failed",
    "--json",
  ]);
});

// ---------------------------------------------------------------------------
// B: worktree create (restored) -- argv + response parsing against the
// fixture. Mutation-killing: reading path/branch from the request instead of
// the response must go RED.
// ---------------------------------------------------------------------------
test("buildWorktreeCreateCommand: exact argv shape, no --path (option does not exist)", () => {
  const argv = buildWorktreeCreateCommand({
    name: "hyk170-probe",
    repoId: "repoId",
    baseBranch: "master",
  });
  assert.deepEqual(argv, [
    "worktree",
    "create",
    "--name",
    "hyk170-probe",
    "--repo",
    "id:repoId",
    "--setup",
    "skip",
    "--no-parent",
    "--base-branch",
    "master",
    "--json",
  ]);
  assert.equal(argv.includes("--path"), false);
});

// review-1 C1 반려 결함 수리: baseBranch 미제공 시 --base-branch 플래그
// 자체를 생략한다(이전엔 항상 붙었고 null/undefined가 그대로 argv에
// 실려 깨진 인자가 됐다 -- ORCH 재현: `"--base-branch", null`).
test("buildWorktreeCreateCommand: baseBranch omitted -- no --base-branch flag in argv at all (C1 fix)", () => {
  const argv = buildWorktreeCreateCommand({ name: "x", repoId: "repoId" });
  assert.equal(argv.includes("--base-branch"), false);
  assert.deepEqual(argv, [
    "worktree",
    "create",
    "--name",
    "x",
    "--repo",
    "id:repoId",
    "--setup",
    "skip",
    "--no-parent",
    "--json",
  ]);
});

test("buildWorktreeCreateCommand: baseBranch null/'' also omit the flag (not just undefined)", () => {
  assert.equal(
    buildWorktreeCreateCommand({
      name: "x",
      repoId: "r",
      baseBranch: null,
    }).includes("--base-branch"),
    false,
  );
  assert.equal(
    buildWorktreeCreateCommand({
      name: "x",
      repoId: "r",
      baseBranch: "",
    }).includes("--base-branch"),
    false,
  );
});

test("buildWorktreeCreateCommand: baseBranch provided -- --base-branch flag present with the value", () => {
  const argv = buildWorktreeCreateCommand({
    name: "x",
    repoId: "r",
    baseBranch: "master",
  });
  const idx = argv.indexOf("--base-branch");
  assert.notEqual(idx, -1);
  assert.equal(argv[idx + 1], "master");
});

test("parseWorktreeCreateResponse: reads path/branch from the fixture response, not the request (mutation-kill)", () => {
  const parsed = parseWorktreeCreateResponse(FIXTURE_WORKTREE_CREATE_RESPONSE);
  assert.equal(
    parsed.path,
    `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk170-probe`,
  );
  // branch has the runtime-added <github-user>/ prefix -- must come from the
  // response, never assembled from the requested --name value.
  assert.equal(parsed.branch, "refs/heads/hykim82/hyk170-probe");
  assert.deepEqual(parsed.warnings, []);
});

test("parseWorktreeCreateResponse: malformed response (missing worktree.path) returns null", () => {
  assert.equal(parseWorktreeCreateResponse({ ok: true, result: {} }), null);
  assert.equal(parseWorktreeCreateResponse({ ok: false }), null);
});

test("createManagedWorktree: happy path -- create -> location check -> managed check, using response path throughout", () => {
  const execFn = fakeExecFn({
    create: FIXTURE_WORKTREE_CREATE_RESPONSE,
    list: managedWorktreeStub(
      `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk170-probe`,
    ),
  });
  const r = createManagedWorktree(
    {
      role: "CODER",
      name: "hyk170-probe",
      repoId: "repoId",
      baseBranch: "master",
    },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.path, `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk170-probe`);
  assert.equal(r.branch, "refs/heads/hykim82/hyk170-probe");
  assert.equal(execFn.calls.length, 2); // create, list -- no rm
});

test("createManagedWorktree: non-empty warnings are recorded in steps", () => {
  const withWarnings = {
    ...FIXTURE_WORKTREE_CREATE_RESPONSE,
    result: {
      ...FIXTURE_WORKTREE_CREATE_RESPONSE.result,
      warnings: ["setup skipped"],
    },
  };
  const execFn = fakeExecFn({
    create: withWarnings,
    list: managedWorktreeStub(
      `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk170-probe`,
    ),
  });
  const r = createManagedWorktree(
    { role: "CODER", name: "hyk170-probe", repoId: "repoId" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(
    r.steps.some((s) => s.includes("worktree-create-warnings")),
    true,
  );
});

test("createManagedWorktree: location rejection rolls back the created worktree (fail-closed)", () => {
  const mainRepoResponse = {
    ok: true,
    result: {
      worktree: { path: MAIN_REPO_PATH, branch: "refs/heads/hykim82/x" },
    },
  };
  const execFn = fakeExecFn({
    create: mainRepoResponse,
    rm: FIXTURE_WORKTREE_RM_RESPONSE,
  });
  const r = createManagedWorktree(
    { role: "CODER", name: "x", repoId: "repoId" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.CREATE_LOCATION_REJECTED);
  assert.equal(r.locationReason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
  assert.equal(r.steps.includes("worktree-rollback-ok"), true);
  const rmCall = execFn.calls.find(
    (argv) => argv[0] === "worktree" && argv[1] === "rm",
  );
  assert.deepEqual(rmCall, buildWorktreeRemoveCommand(MAIN_REPO_PATH));
});

test("createManagedWorktree: not-managed-after-create rolls back too, and a rollback failure is recorded (not swallowed)", () => {
  const execFn = fakeExecFn({
    create: FIXTURE_WORKTREE_CREATE_RESPONSE,
    list: managedWorktreeStub("C:/some/other/path"), // created path not actually in the list
    rm: { ok: false, reason: "orca down" },
  });
  const r = createManagedWorktree(
    { role: "CODER", name: "hyk170-probe", repoId: "repoId" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(
    r.worktreeReason,
    WORKTREE_REASON.CREATE_NOT_MANAGED_AFTER_CREATE,
  );
  assert.equal(
    r.steps.some((s) => s.startsWith("worktree-rollback-failed")),
    true,
  );
});

// review-1 C1 반려 결함 수리 (ORCH 재현 그대로): worktree create가 ok:true
// 인데 branch가 빈 값이라 parseWorktreeCreateResponse가 실패하는 경우 --
// 이전엔 여기서 rollback을 호출하지 않아 실제로 만들어진 워크트리가
// 누출됐다(재현: rm 호출 0건). 이제는 path가 응답에 있으므로 rollback해야
// 한다.
test("createManagedWorktree: C1 exact repro -- response parse failure (empty branch) still rolls back using the response path (mutation-kill: removing the rollback call must go RED)", () => {
  const leakedResponse = {
    ok: true,
    result: { worktree: { path: "/some/leaked-worktree", branch: "" } },
  };
  const execFn = fakeExecFn({
    create: leakedResponse,
    rm: FIXTURE_WORKTREE_RM_RESPONSE,
  });
  const r = createManagedWorktree(
    { role: "CODER", name: "hyk170-probe", repoId: "repoId" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.CREATE_FAILED);
  assert.match(r.reason, /missing\/empty/);
  const rmCall = execFn.calls.find(
    (argv) => argv[0] === "worktree" && argv[1] === "rm",
  );
  assert.deepEqual(rmCall, buildWorktreeRemoveCommand("/some/leaked-worktree"));
  assert.equal(r.steps.includes("worktree-rollback-ok"), true);
});

test("createManagedWorktree: response parse failure with NO path at all -- rollback is not attempted, and that fact is recorded (not silently swallowed)", () => {
  const noPathResponse = { ok: true, result: { worktree: {} } };
  const execFn = fakeExecFn({ create: noPathResponse });
  const r = createManagedWorktree(
    { role: "CODER", name: "x", repoId: "repoId" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.CREATE_FAILED);
  const rmCallCount = execFn.calls.filter(
    (argv) => argv[0] === "worktree" && argv[1] === "rm",
  ).length;
  assert.equal(rmCallCount, 0);
  assert.equal(
    r.steps.some((s) => s.startsWith("worktree-rollback-not-possible")),
    true,
  );
});

// 실패 지점 4곳 각각에서 rollback이 발생하는지 표 형태로 확인 (태스크 지시:
// "실패 지점을 4곳 각각에 대해 rollback 발생을 단언").
test("createManagedWorktree: rollback fires at all 4 post-create failure points", () => {
  const points = [
    {
      label: "response parse failure",
      response: {
        ok: true,
        result: { worktree: { path: "/wt/a", branch: "" } },
      },
    },
    {
      label: "location rejection",
      response: {
        ok: true,
        result: {
          worktree: { path: MAIN_REPO_PATH, branch: "refs/heads/x/y" },
        },
      },
    },
  ];
  for (const point of points) {
    const execFn = fakeExecFn({
      create: point.response,
      rm: FIXTURE_WORKTREE_RM_RESPONSE,
    });
    const r = createManagedWorktree(
      { role: "CODER", name: "x", repoId: "repoId" },
      { execFn },
    );
    assert.equal(r.ok, false, point.label);
    const rmCall = execFn.calls.find(
      (argv) => argv[0] === "worktree" && argv[1] === "rm",
    );
    assert.ok(rmCall, `${point.label}: expected a worktree rm rollback call`);
  }
  // 3rd point: managed-check rejection (needs a 'list' stub too)
  {
    const execFn = fakeExecFn({
      create: FIXTURE_WORKTREE_CREATE_RESPONSE,
      list: managedWorktreeStub("C:/some/other/path"),
      rm: FIXTURE_WORKTREE_RM_RESPONSE,
    });
    const r = createManagedWorktree(
      { role: "CODER", name: "hyk170-probe", repoId: "repoId" },
      { execFn },
    );
    assert.equal(r.ok, false);
    const rmCall = execFn.calls.find(
      (argv) => argv[0] === "worktree" && argv[1] === "rm",
    );
    assert.ok(
      rmCall,
      "managed-check rejection: expected a worktree rm rollback call",
    );
  }
  // 4th point: worktree-create call itself fails -- rollback must NOT fire
  // (nothing was created, there is nothing to remove).
  {
    const execFn = fakeExecFn({ create: { ok: false, reason: "boom" } });
    const r = createManagedWorktree(
      { role: "CODER", name: "x", repoId: "repoId" },
      { execFn },
    );
    assert.equal(r.ok, false);
    const rmCallCount = execFn.calls.filter(
      (argv) => argv[0] === "worktree" && argv[1] === "rm",
    ).length;
    assert.equal(rmCallCount, 0);
  }
});

test("createManagedWorktree: worktree-create call failure short-circuits before any location/managed check", () => {
  const execFn = fakeExecFn({
    create: { ok: false, reason: "Setup decision required" },
  });
  const r = createManagedWorktree(
    { role: "CODER", name: "x", repoId: "repoId" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.worktreeReason, WORKTREE_REASON.CREATE_FAILED);
  assert.equal(execFn.calls.length, 1);
});

// ---------------------------------------------------------------------------
// D: orphan seat detection (실측 2단 §5)
// ---------------------------------------------------------------------------
test("isOrphanSeat: worktreePath:'' is orphan regardless of connected/writable (2단 §5 exact repro)", () => {
  assert.equal(isOrphanSeat({ worktreePath: "" }), true);
});

test("isOrphanSeat: a non-empty worktreePath is not orphan (mutation-kill: must not always return true)", () => {
  assert.equal(isOrphanSeat({ worktreePath: VALID_WORKTREE }), false);
});

test("isGhostTab: tabId starting with 'pty:' is UI-unadopted (2단 §7 실측)", () => {
  assert.equal(isGhostTab("pty:abcdef"), true);
  assert.equal(isGhostTab("11111111-2222-3333-4444-555555555555"), false);
  assert.equal(isGhostTab(undefined), false);
});

// ---------------------------------------------------------------------------
// C: arrival confirmation helpers (실측 2단 §3 -- preview redraw artifacts)
// ---------------------------------------------------------------------------
test("buildSeatShowCommand: exact argv shape", () => {
  assert.deepEqual(buildSeatShowCommand("term_x"), [
    "terminal",
    "show",
    "--terminal",
    "term_x",
    "--json",
  ]);
});

test("parseSeatPreview: extracts result.terminal.preview", () => {
  const preview = parseSeatPreview({
    ok: true,
    result: { terminal: { preview: "some text" } },
  });
  assert.equal(preview, "some text");
});

test("previewContainsMarker: finds the marker inside a redraw-mangled preview (2단 §3 exact fixture) -- no exact-match assertion", () => {
  assert.equal(
    previewContainsMarker(FIXTURE_PREVIEW_REDRAW, "HYK170_ARRIVAL_MARK"),
    true,
  );
  // the raw fixture is NOT equal to the marker alone -- proves this is a
  // partial/normalized match, not accidental exact equality.
  assert.notEqual(FIXTURE_PREVIEW_REDRAW, "HYK170_ARRIVAL_MARK");
});

test("previewContainsMarker: absent marker returns false", () => {
  assert.equal(
    previewContainsMarker(FIXTURE_PREVIEW_REDRAW, "NOT_PRESENT"),
    false,
  );
});

test("normalizePreview: collapses whitespace runs", () => {
  assert.equal(normalizePreview("a   b\n\nc"), "a b c");
  assert.equal(normalizePreview(123), "");
});

// ---------------------------------------------------------------------------
// ensureSeat -- reuse path
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

// D wiring into ensureSeat reuse -- mutation-kill: treating an orphan seat as
// alive must go RED.
test("ensureSeat: reuse -- an orphan existing seat (worktreePath:'') is rejected, still zero execFn calls", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { existingSeatHandle: "term_orphan", existingSeatWorktreePath: "", execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /orphan/);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: reuse -- a seat with a real worktreePath is accepted (not orphan)", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    {
      existingSeatHandle: "term_ok",
      existingSeatWorktreePath: VALID_WORKTREE,
      execFn,
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.seatHandle, "term_ok");
});

test("ensureSeat: unknown role is rejected before any execFn call", () => {
  const execFn = fakeExecFn({});
  const r = ensureSeat({ role: "NOT_A_ROLE", worktreePath: "/wt" }, { execFn });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown role/);
  assert.equal(execFn.calls.length, 0);
});

test("ensureSeat: missing worktreePath and missing create is rejected", () => {
  const r = ensureSeat({ role: "CODER" }, { execFn: fakeExecFn({}) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /worktreePath or a valid create/);
});

// ---------------------------------------------------------------------------
// ensureSeat -- existing/managed path (settings/node_modules copy, response
// parsing) -- now using the realistic nested fixture shape
// (result.terminal.{handle,paneKey,surface}).
// ---------------------------------------------------------------------------
test("ensureSeat: A3 settings.local.json copied from mainRepoDir when missing at destination", () => {
  const exists = new Set(["/main/.claude/settings.local.json"]);
  const copied = [];
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    create: FIXTURE_TERMINAL_CREATE_RESPONSE,
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
    create: FIXTURE_TERMINAL_CREATE_RESPONSE,
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
    create: FIXTURE_TERMINAL_CREATE_RESPONSE,
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

test("ensureSeat: new seat creation reads handle/paneKey from the fixture response.result.terminal, both engines", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    create: FIXTURE_TERMINAL_CREATE_RESPONSE,
  });
  const r = ensureSeat(
    { role: "REVIEW", worktreePath: VALID_WORKTREE },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, true);
  assert.equal(
    r.seatHandle,
    FIXTURE_TERMINAL_CREATE_RESPONSE.result.terminal.handle,
  );
  assert.equal(
    r.paneKey,
    FIXTURE_TERMINAL_CREATE_RESPONSE.result.terminal.paneKey,
  );
  assert.equal(r.created, true);
});

test("ensureSeat: seat creation failure (response.ok:false) is surfaced, not swallowed", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    create: { ok: false, reason: "Setup decision required" },
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
    create: { ok: true, result: { terminal: {} } },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /handle missing\/empty/);
});

// surface !== "visible" -- fail-closed (2단 §2 실측: UI 미채택 = 유령 터미널)
test("ensureSeat: seat creation response with surface !== 'visible' is a failure (ghost-terminal guard, mutation-kill)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(),
    create: {
      ok: true,
      result: {
        terminal: {
          ...FIXTURE_TERMINAL_CREATE_RESPONSE.result.terminal,
          surface: "background",
        },
      },
    },
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /surface/);
});

// ---------------------------------------------------------------------------
// ensureSeat -- §B creation path wiring (worktreePath omitted, create given)
// ---------------------------------------------------------------------------
test("ensureSeat: creation path -- no worktreePath, valid create{} builds the worktree then the seat, using the response path throughout", () => {
  const execFn = fakeExecFn({
    create: (argv) =>
      argv[0] === "worktree"
        ? FIXTURE_WORKTREE_CREATE_RESPONSE
        : FIXTURE_TERMINAL_CREATE_RESPONSE,
    list: managedWorktreeStub(
      `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk170-probe`,
    ),
  });
  const r = ensureSeat(
    {
      role: "CODER",
      create: { name: "hyk170-probe", repoId: "repoId", baseBranch: "master" },
    },
    { execFn, existsFn: () => true },
  );
  assert.equal(r.ok, true);
  assert.equal(
    r.seatHandle,
    FIXTURE_TERMINAL_CREATE_RESPONSE.result.terminal.handle,
  );
  assert.equal(r.stepsPerformed.includes("worktree-created"), true);
  assert.equal(r.stepsPerformed.includes("seat-created"), true);
  // worktree create -> worktree list (managed check) -> terminal create
  const worktreeCreateCalls = execFn.calls.filter(
    (a) => a[0] === "worktree" && a[1] === "create",
  );
  assert.equal(worktreeCreateCalls.length, 1);
});

test("ensureSeat: creation path -- location rejection after create returns failure with rollback recorded in steps, no seat created", () => {
  const mainRepoResponse = {
    ok: true,
    result: {
      worktree: { path: MAIN_REPO_PATH, branch: "refs/heads/hykim82/x" },
    },
  };
  const execFn = fakeExecFn({
    create: mainRepoResponse,
    rm: FIXTURE_WORKTREE_RM_RESPONSE,
  });
  const r = ensureSeat(
    { role: "CODER", create: { name: "x", repoId: "repoId" } },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.locationReason, LOCATION_REASON.MAIN_REPO_FORBIDDEN);
  assert.equal(r.stepsPerformed.includes("worktree-rollback-ok"), true);
  const terminalCreateCalls = execFn.calls.filter(
    (a) => a[0] === "terminal" && a[1] === "create",
  );
  assert.equal(terminalCreateCalls.length, 0);
});

test("ensureSeat: creation path is not entered when worktreePath is given, even if create is also present (worktreePath wins, no implicit switch)", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    create: FIXTURE_TERMINAL_CREATE_RESPONSE,
  });
  const r = ensureSeat(
    {
      role: "CODER",
      worktreePath: VALID_WORKTREE,
      create: { name: "should-not-be-used", repoId: "repoId" },
    },
    { execFn },
  );
  assert.equal(r.ok, true);
  const worktreeCreateCalls = execFn.calls.filter(
    (a) => a[0] === "worktree" && a[1] === "create",
  );
  assert.equal(worktreeCreateCalls.length, 0);
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
    send: { ok: true },
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
    send: () => {
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
    send: () => {
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
    send: () => {
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
// HYK-169-coder-3 (review-1 반려 결함 수리, 계승): confirmPastedFn의 반환값이
// 실제로 제출을 막는지 -- 모든 시험이 fake execFn의 호출 목록으로 `terminal`
// 계열(제출) 호출이 정확히 0건임을 인자까지 확인한다.
// ---------------------------------------------------------------------------
function noTerminalCalls(execFn) {
  return execFn.calls.every((argv) => argv[0] !== "terminal");
}

test("deliverTask: PASTE_UNCONFIRMED -- confirmPastedFn returning false refuses submit with zero 'terminal send' calls", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
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

test("deliverTask: PASTE_UNCONFIRMED -- confirmPastedFn returning true allows exactly one submit call", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn, confirmPastedFn: () => true },
  );
  assert.equal(r.ok, true);
  assert.equal(execFn.calls.filter((argv) => argv[0] === "terminal").length, 1);
});

test("deliverTask: PASTE_UNCONFIRMED -- confirmPastedFn throwing is treated as unconfirmed, zero submit calls", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
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

// review-1 C2 반려 결함 수리: confirmPastedFn 미주입 시 이전엔 무조건
// 미확인(false)이었다 -- 이제 어댑터가 스스로 `terminal show`로 확인한다.
// 아래 4개 테스트가 그 default 경로를 다룬다.
test("deliverTask: C2 default confirm path -- omitting confirmPastedFn calls terminal show, and neither marker nor busy signal present -> PASTE_UNCONFIRMED, zero submit calls", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
    show: {
      ok: true,
      result: { terminal: { preview: "just a normal shell prompt" } },
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /PASTE_UNCONFIRMED/);
  const submitCalls = execFn.calls.filter(
    (a) => a[0] === "terminal" && a[1] === "send",
  );
  assert.equal(submitCalls.length, 0);
  // task-create, dispatch, terminal show (the self-check) -- no submit.
  assert.equal(execFn.calls.length, 3);
});

test("deliverTask: C2 default confirm path -- marker (taskId) alone in the preview confirms and allows exactly one submit call", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
    show: {
      ok: true,
      result: { terminal: { preview: "go HYK-169-coder-1\nrunning..." } },
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
  const submitCalls = execFn.calls.filter(
    (a) => a[0] === "terminal" && a[1] === "send",
  );
  assert.equal(submitCalls.length, 1);
});

// 실측 원문 fixture(2단 §3): 완전 일치로는 못 잡고 정규화 부분 일치로만
// 잡히는지 -- 이 fixture 자체가 마커와 동일하지 않다는 것으로 "완전 일치가
// 아니라 부분 일치를 쓴다"를 증명한다.
test("deliverTask: C2 default confirm path -- exact real-world redraw-mangled preview fixture (2단 §3) confirms via partial match, not exact match", () => {
  const marker = "HYK170_ARRIVAL_MARK";
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
    show: {
      ok: true,
      result: { terminal: { preview: FIXTURE_PREVIEW_REDRAW } },
    },
  });
  const r = deliverTask(
    { taskId: marker, role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.notEqual(FIXTURE_PREVIEW_REDRAW, marker); // proves it's not exact-match luck
});

// (b) busy signal (큐 대기/codex Pasted-Content 대기) -- 마커가 안 보여도
// 확인으로 인정한다(영수증 §9 "거짓 실패" 방지).
test("deliverTask: C2 default confirm path -- a busy signal alone (no marker) also confirms (queued-message fixture)", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
    show: {
      ok: true,
      result: {
        terminal: { preview: "Press up to edit queued messages" },
      },
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
});

test("deliverTask: C2 default confirm path -- codex '[Pasted Content NNNN chars]' busy fixture also confirms", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
    show: {
      ok: true,
      result: { terminal: { preview: "[Pasted Content 4467 chars]" } },
    },
  });
  const r = deliverTask(
    { taskId: "HYK-169-coder-1", role: "REVIEW", seatHandle: "term_x" },
    { execFn },
  );
  assert.equal(r.ok, true);
});

// previewShowsBusySignal 단위 시험 + 변이 죽이기: 분기를 제거하면 RED.
test("previewShowsBusySignal: unit -- recognizes both known busy signals, rejects unrelated text", () => {
  assert.equal(
    previewShowsBusySignal("Press up to edit queued messages"),
    true,
  );
  assert.equal(previewShowsBusySignal("[Pasted Content 123 chars]"), true);
  assert.equal(previewShowsBusySignal("plain prompt"), false);
});

test("deliverTask: PASTE_UNCONFIRMED -- a truthy-but-not-true return value does not confirm (strict boolean check)", () => {
  const execFn = fakeExecFn({
    ...taskCreateDispatchStubs(),
    send: { ok: true },
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
test("collectCompletionSignals: returns messages array on a well-formed ok response, using --peek argv", () => {
  const execFn = fakeExecFn({
    check: { ok: true, result: { messages: [{ type: "worker_done" }] } },
  });
  const r = collectCompletionSignals(
    { coordinatorHandle: "term_coord" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.signals.length, 1);
  assert.equal(execFn.calls[0].includes("--peek"), true);
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
// teardownSeat -- A3 (--terminal, tab_not_found absorbed), A5 (real
// execution), A6 (task-update, keyed by taskId not seatHandle)
// ---------------------------------------------------------------------------
test("teardownSeat: closes seat, removes the worktree for real, and runs best-effort task-update(failed)", () => {
  const execFn = fakeExecFn({
    close: { ok: true },
    rm: FIXTURE_WORKTREE_RM_RESPONSE,
    "task-update": { ok: true },
  });
  const r = teardownSeat(
    { seatHandle: "term_x", worktreePath: VALID_WORKTREE, taskId: "task_rt1" },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.cleanup.ok, true);
  assert.equal(r.worktreeRemove.ok, true);
  // close, worktree rm, task-update -- all 3 actually executed (v1 only
  // executed close; A5's rm was construction-only).
  assert.equal(execFn.calls.length, 3);
  const rmCall = execFn.calls.find((a) => a[0] === "worktree" && a[1] === "rm");
  assert.deepEqual(rmCall, buildWorktreeRemoveCommand(VALID_WORKTREE));
  const taskUpdateCall = execFn.calls.find(
    (a) => a[0] === "orchestration" && a[1] === "task-update",
  );
  assert.deepEqual(taskUpdateCall, buildTaskUpdateFailedCommand("task_rt1"));
});

test("teardownSeat: a tab_not_found close failure is absorbed as already-closed, not a teardown failure", () => {
  const execFn = fakeExecFn({
    close: FIXTURE_TAB_NOT_FOUND_RESPONSE,
    rm: FIXTURE_WORKTREE_RM_RESPONSE,
  });
  const r = teardownSeat(
    { seatHandle: "term_x", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
});

test("teardownSeat: a real (non-tab_not_found) close failure is reported, worktree rm still attempted", () => {
  const execFn = fakeExecFn({
    close: { ok: false, reason: "some other failure" },
    rm: FIXTURE_WORKTREE_RM_RESPONSE,
  });
  const r = teardownSeat(
    { seatHandle: "term_x", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /some other failure/);
  const rmCall = execFn.calls.find((a) => a[0] === "worktree" && a[1] === "rm");
  assert.ok(rmCall);
});

test("teardownSeat: missing seatHandle is rejected", () => {
  const r = teardownSeat({}, { execFn: fakeExecFn({}) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /seatHandle/);
});

test("teardownSeat: worktreeRemove is null and rm is never called when no worktreePath is given", () => {
  const execFn = fakeExecFn({ close: { ok: true } });
  const r = teardownSeat({ seatHandle: "term_x" }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.worktreeRemove, null);
  assert.equal(execFn.calls.length, 1); // close only
});

test("teardownSeat: cleanup is null and task-update is never called when no taskId is given", () => {
  const execFn = fakeExecFn({ close: { ok: true } });
  const r = teardownSeat({ seatHandle: "term_x" }, { execFn });
  assert.equal(r.cleanup, null);
});

test("teardownSeat: worktree rm failure makes the overall result fail even if close succeeded", () => {
  const execFn = fakeExecFn({
    close: { ok: true },
    rm: { ok: false, reason: "orca down" },
  });
  const r = teardownSeat(
    { seatHandle: "term_x", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /orca down/);
});

// ---------------------------------------------------------------------------
// ENGINE_BY_ROLE
// ---------------------------------------------------------------------------
test("ENGINE_BY_ROLE: CODER/VERIFY are claude, REVIEW is codex (B9 single config point)", () => {
  assert.equal(ENGINE_BY_ROLE.CODER, "claude");
  assert.equal(ENGINE_BY_ROLE.VERIFY, "claude");
  assert.equal(ENGINE_BY_ROLE.REVIEW, "codex");
});

// ---------------------------------------------------------------------------
// HYK-169-coder-2: 좌석 위치 정책 (resolveSeatLocation) -- 계승, 무변경.
// ---------------------------------------------------------------------------
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

test("resolveSeatLocation: BLOCK -- an arbitrary path outside workspaces is rejected with OUTSIDE_WORKSPACES", () => {
  const r = resolveSeatLocation({
    role: "CODER",
    requestedPath: "C:\\temp\\wt",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOCATION_REASON.OUTSIDE_WORKSPACES);
});

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
// HYK-169-coder-4 (review-2 반려 결함 수리, 계승): Orca 관리 워크트리 확인.
// ---------------------------------------------------------------------------
function terminalCallCount(execFn) {
  return execFn.calls.filter((argv) => argv[0] === "terminal").length;
}
function worktreeCreateCallCount(execFn) {
  return execFn.calls.filter(
    (argv) => argv[0] === "worktree" && argv[1] === "create",
  ).length;
}

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

test("checkWorktreeManaged: BLOCK -- an unregistered path is rejected (NOT_ORCA_MANAGED), no create call", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub("C:/some/other/worktree"),
  });
  const r = checkWorktreeManaged({ requestedPath: VALID_WORKTREE }, { execFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_REASON.NOT_ORCA_MANAGED);
  assert.equal(worktreeCreateCallCount(execFn), 0);
});

test("ensureSeat: given an existing (non-create) worktreePath that is unregistered, rejects -- zero seat-creation calls, and does NOT fall back to §B creation", () => {
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

test("ensureSeat: a path already in the managed list skips worktree create entirely", () => {
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    create: FIXTURE_TERMINAL_CREATE_RESPONSE,
  });
  const r = ensureSeat(
    { role: "CODER", worktreePath: VALID_WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, true);
  assert.equal(worktreeCreateCallCount(execFn), 0);
  assert.equal(terminalCallCount(execFn), 1);
});

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

// ---------------------------------------------------------------------------
// HYK-169-coder-5 (review-3 반려 결함 수리, 계승): 등록 목록 대조가 후행
// 구분자(`/`, `\`)에서 실패해 실제 등록된 워크트리를 잘못 거부하던 결함.
// ---------------------------------------------------------------------------
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

test("checkWorktreeManaged: a drive root ('C:/') registered entry is not mangled by trailing-separator stripping", () => {
  const execFn = fakeExecFn({ list: managedWorktreeStub("C:\\") });
  const r = checkWorktreeManaged({ requestedPath: "C:/" }, { execFn });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
});

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
