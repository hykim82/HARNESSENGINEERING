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
// HYK-171 사이클4b-1 재작업3(사람 게이트 결정): `tabId`/`leafId`는 이제
// 어떤 판정에도 쓰이지 않는다(pane key 조립 삭제, coder-task.md §0/§1) --
// 그래도 필드 자체는 실 CLI가 실제로 주는 값이라 fixture에 남겨둔다(테스트
// #2가 pty 문자열형 tabId/leafId를 가진 좌석에서도 handle 불일치만으로
// 올바르게 판정되는지 확인한다).
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

// 3층 전부 present + 활성참조 0 + working tree clean + policy가 빈
// 보호목록인 최소 기준선(파괴가 허용되는 상태). 각 mutation 시험은 이
// 기준선에서 정확히 한 축만 어긋나게 만든다.
//
// HYK-171 사이클4b-1 재작업3(사람 게이트 결정, coder-task.md §2-B):
// `dispatchCorrelationProven:true`를 기준선 policy에 기본 포함한다 --
// 이 값이 없으면(프로덕션 기본) 모든 teardown이 이 새 전제조건에서
// 막히므로, "다른 축을 독립적으로 시험"하려는 기존 mutation들이 전부
// 이 축에서 먼저 막혀버린다. 이 값을 일부러 빼거나 다른 값을 주는 시험은
// 각자 override한다(required test #4가 그렇게 한다).
export function eligibleTeardownCtx(overrides = {}) {
  return {
    role: "CODER",
    worktreePath: VALID_WORKTREE,
    taskId: "task_4b1",
    armed: true,
    // HYK-431 8R: 「파괴해도 된다」는 판정은 그것이 기대는 축마다 근거가
    // 주어졌을 때만 나온다(teardown-core.mjs ELIGIBILITY_PREMISES) --
    // 부재는 통과가 아니라 판정 불가다. 이 기준선은 「적격한 흐름」을 재는
    // 픽스처이므로 그 근거를 모두 갖춘 완전 정책을 쓴다.
    // `expectedWorktreeId`는 managedWorktreeStub이 첫 경로에 붙이는 id다.
    policy: {
      protectedTargets: [],
      expectedWorktreeId: "wt-0",
      requireDurableEvidence: false,
      dispatchCorrelationProven: true,
    },
    ...overrides,
  };
}

// HYK-171 사이클4b-1 재작업3: 활성참조는 이제 (§2-A) connected + handle
// 소유권 증거(existingSeatHandle)만 본다 -- task-list/dispatch-show 관측이
// 삭제됐으므로 그 stub도 함께 뺐다. 기준선은 "대상 워크트리의 유일한
// 좌석이 곧 대상 좌석 자신"(existingSeatHandle = terminalEntries[0]의
// handle, 소유권 증거 제공)이다.

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
