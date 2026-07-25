import { computeCanonicalPathDigest } from "./adapters/teardown-inventory-adapter.mjs";

// HYK-171 사이클4b-1 -- hyk171-cycle4b1-mutation.test.mjs 전용 공용 픽스처.
// 3B의 hyk171-cycle3b-fixtures.mjs와 동형 원칙: 실 orca/git 프로세스 호출
// 0, 전부 fake execFn/gitFn/existsFn 주입. S6 봉인 계승.

export const WORKSPACES_ROOT = "C:/Users/Administrator/orca/workspaces";
export const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-4b1-fixture`;
export const OTHER_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-4b1-other`;

export function fakeExecFn(responses) {
  const calls = [];
  function fn(argv) {
    calls.push(argv);
    const key =
      argv[0] === "terminal" && argv[1] === "list"
        ? "terminal-list"
        : argv[0] === "orchestration" ||
            argv[0] === "worktree" ||
            argv[0] === "terminal"
          ? argv[1]
          : argv[0];
    const entry = responses[key];
    if (typeof entry === "function") return entry(argv, calls.length);
    if (entry === undefined) {
      throw new Error(
        `fakeExecFn: no stub for '${key}' (argv=${JSON.stringify(argv)})`,
      );
    }
    return entry;
  }
  fn.calls = calls;
  return fn;
}

export function fakeGitFn(responses) {
  const calls = [];
  function fn(argv) {
    calls.push(argv);
    const key = argv[0];
    const entry = responses[key];
    if (typeof entry === "function") return entry(argv, calls.length);
    if (entry === undefined) {
      throw new Error(
        `fakeGitFn: no stub for '${key}' (argv=${JSON.stringify(argv)})`,
      );
    }
    return entry;
  }
  fn.calls = calls;
  return fn;
}

export function managedWorktreeStub(paths = [VALID_WORKTREE]) {
  return {
    ok: true,
    result: { worktrees: paths.map((p, i) => ({ path: p, id: `wt-${i}` })) },
  };
}
export function terminalListStub(entries) {
  return { ok: true, result: { terminals: entries } };
}
export function terminalEntry(overrides = {}) {
  return {
    handle: "term_4b1",
    worktreePath: VALID_WORKTREE,
    tabId: "11111111-2222-3333-4444-555555555555",
    title: "CODER",
    connected: true,
    writable: true,
    activeDispatch: false,
    lastOutputAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}
export function gitWorktreeListOutput(paths) {
  return (
    paths.map((p) => `worktree ${p}`).join("\n") + (paths.length ? "\n" : "")
  );
}

// 3층 전부 present + 활성참조 0 + working tree clean + policy가 빈 보호목록
// 인 최소 기준선(파괴가 허용되는 상태). 각 mutation 시험은 이 기준선에서
// 정확히 한 축만 어긋나게 만든다.
export function eligibleTeardownCtx(overrides = {}) {
  return {
    role: "CODER",
    worktreePath: VALID_WORKTREE,
    taskId: "task_4b1",
    armed: true,
    policy: { protectedTargets: [] },
    ...overrides,
  };
}

// list/terminal-list/gitFn/existsFn을 상태 토글 없이 고정(파괴 argv가
// 절대 나가지 않아야 하는 mutation 시험용 -- rm까지 도달하지 않으므로
// after-observe 토글이 필요 없다).
export function staticEligibleOpts({
  worktreePath = VALID_WORKTREE,
  execStubs = {},
  terminalEntries = [terminalEntry()],
  gitStatusOutput = "",
} = {}) {
  const execFn = fakeExecFn({
    list: managedWorktreeStub([worktreePath]),
    "terminal-list": terminalListStub(terminalEntries),
    ...execStubs,
  });
  const gitFn = fakeGitFn({
    worktree: gitWorktreeListOutput([worktreePath]),
    status: gitStatusOutput,
  });
  const existsFn = () => true;
  return { execFn, gitFn, existsFn };
}

// paired-good(양성 통제)에 쓰는 "rm이 실제로 대상을 지운 뒤 3층이 전부
// absent로 바뀌는" 상태-토글 opts.
export function togglingEligibleOpts({
  worktreePath = VALID_WORKTREE,
  terminalEntries = [terminalEntry()],
  closeResponse = { ok: true },
  rmResponse,
  taskUpdateResponse = { ok: true },
} = {}) {
  const state = { removed: false };
  const execFn = fakeExecFn({
    list: () =>
      state.removed
        ? { ok: true, result: { worktrees: [] } }
        : managedWorktreeStub([worktreePath]),
    "terminal-list": terminalListStub(terminalEntries),
    close: closeResponse,
    rm:
      rmResponse ??
      (() => {
        state.removed = true;
        return { ok: true, result: { removed: true } };
      }),
    "task-update": taskUpdateResponse,
  });
  const gitFn = fakeGitFn({
    worktree: () =>
      state.removed ? "" : gitWorktreeListOutput([worktreePath]),
    status: "",
  });
  const existsFn = (p) => p === worktreePath && !state.removed;
  return { execFn, gitFn, existsFn, state };
}

export function protectedPolicyFor(worktreePath) {
  return { protectedTargets: [computeCanonicalPathDigest(worktreePath)] };
}

export function noDestructiveCalls(execFn) {
  return execFn.calls.every(
    (argv) =>
      !(
        argv[0] === "terminal" &&
        (argv[1] === "close" || argv[1] === "send")
      ) &&
      !(argv[0] === "worktree" && argv[1] === "rm") &&
      !(argv[0] === "orchestration" && argv[1] === "task-update"),
  );
}

export function findsPathAnywhere(execFn, gitFn, needle) {
  const inExec = execFn.calls.some((argv) =>
    argv.some((a) => typeof a === "string" && a.includes(needle)),
  );
  const inGit = gitFn
    ? gitFn.calls.some((argv) => argv.includes(needle))
    : false;
  return inExec || inGit;
}
