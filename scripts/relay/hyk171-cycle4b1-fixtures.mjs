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
// HYK-171 사이클4b-1 재작업(streak 1): `activeDispatch` 필드 삭제(실
// `orca terminal list --json`에 존재하지 않는다, REVIEW review-1 P1-1
// 실측). `leafId` 추가(tabId와 함께 pane key `${tabId}:${leafId}`를
// 구성한다 -- 이 태스크 수행 중 라이브 조회로 실측 확인).
export function terminalEntry(overrides = {}) {
  return {
    handle: "term_4b1",
    worktreePath: VALID_WORKTREE,
    tabId: "11111111-2222-3333-4444-555555555555",
    leafId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    title: "CODER",
    connected: true,
    writable: true,
    lastOutputAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}
export function gitWorktreeListOutput(paths) {
  return (
    paths.map((p) => `worktree ${p}`).join("\n") + (paths.length ? "\n" : "")
  );
}
// task-list --status dispatched 응답 fixture -- 기본값(빈 목록)은 "지금
// 시스템 전체에 미완료 dispatch가 없다"는 가장 흔한 baseline이다.
export function taskListDispatchedStub(tasks = []) {
  return { ok: true, result: { tasks } };
}
export function dispatchShowStub(assigneePaneKey) {
  return {
    ok: true,
    result: {
      dispatch: {
        assignee_pane_key: assigneePaneKey ?? null,
      },
    },
  };
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

// HYK-171 사이클4b-1 재작업(streak 1, §P1-1): 활성참조가 이제 (A) 미완료
// dispatch(task-list+dispatch-show) 관측과 (B) 소유권 증거(existingSeatHandle)
// 둘 다에 결속되므로, "기준선"은 그 둘도 함께 정의해야 한다 -- 기본값은
// "시스템에 미완료 dispatch 0개"(task-list 빈 배열) + "대상 워크트리의
// 유일한 좌석이 곧 대상 좌석 자신"(existingSeatHandle = terminalEntries[0]
// 의 handle, 소유권 증거 제공)이다. 좌석이 여럿이거나 증거를 일부러 빼는
// 시험은 각자 override한다.

// list/terminal-list/gitFn/existsFn을 상태 토글 없이 고정(파괴 argv가
// 절대 나가지 않아야 하는 mutation 시험용 -- rm까지 도달하지 않으므로
// after-observe 토글이 필요 없다).
export function staticEligibleOpts({
  worktreePath = VALID_WORKTREE,
  execStubs = {},
  terminalEntries = [terminalEntry()],
  gitStatusOutput = "",
  existingSeatHandle = terminalEntries[0]?.handle,
} = {}) {
  const execFn = fakeExecFn({
    list: managedWorktreeStub([worktreePath]),
    "terminal-list": terminalListStub(terminalEntries),
    "task-list": taskListDispatchedStub([]),
    ...execStubs,
  });
  const gitFn = fakeGitFn({
    worktree: gitWorktreeListOutput([worktreePath]),
    status: gitStatusOutput,
  });
  const existsFn = () => true;
  return { execFn, gitFn, existsFn, existingSeatHandle };
}

// paired-good(양성 통제)에 쓰는 "rm이 실제로 대상을 지운 뒤 3층이 전부
// absent로 바뀌는" 상태-토글 opts.
export function togglingEligibleOpts({
  worktreePath = VALID_WORKTREE,
  terminalEntries = [terminalEntry()],
  closeResponse = { ok: true },
  rmResponse,
  taskUpdateResponse = { ok: true },
  existingSeatHandle = terminalEntries[0]?.handle,
} = {}) {
  const state = { removed: false };
  const execFn = fakeExecFn({
    list: () =>
      state.removed
        ? { ok: true, result: { worktrees: [] } }
        : managedWorktreeStub([worktreePath]),
    "terminal-list": terminalListStub(terminalEntries),
    "task-list": taskListDispatchedStub([]),
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
  return { execFn, gitFn, existsFn, existingSeatHandle, state };
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
