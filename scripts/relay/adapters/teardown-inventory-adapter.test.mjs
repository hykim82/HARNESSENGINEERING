import { test } from "node:test";
import assert from "node:assert/strict";
import {
  observeTeardownInventory,
  computeCanonicalPathDigest,
  buildOrcaWorktreeListCommand,
  buildOrcaTerminalListCommand,
  buildGitWorktreeListCommand,
  buildGitStatusCommand,
} from "./teardown-inventory-adapter.mjs";
import { TEARDOWN_SCHEMA_VERSION } from "../teardown-core.mjs";

// HYK-171 사이클4b-1 -- teardown-inventory-adapter.mjs 단위시험. 전부 fake
// execFn/gitFn/existsFn 주입(실 orca/git 프로세스 호출 0, 파괴 argv 0).

const WT =
  "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk-test-fixture";

function orcaWorktreeListResponse(paths) {
  return {
    ok: true,
    result: { worktrees: paths.map((p, i) => ({ path: p, id: `wt-${i}` })) },
  };
}
function orcaTerminalListResponse(entries) {
  return { ok: true, result: { terminals: entries } };
}
function gitWorktreeListOutput(paths) {
  return (
    paths.map((p) => `worktree ${p}`).join("\n") + (paths.length ? "\n" : "")
  );
}
// HYK-171 사이클4b-1 재작업(streak 1, REVIEW review-1 P1-1): task-list/
// dispatch-show 응답 fixture -- 이 태스크 수행 중 라이브 읽기 조회로 실측한
// 그대로의 shape(`result.tasks[].id`, `result.dispatch.assignee_pane_key`).
function taskListDispatchedResponse(tasks) {
  return { ok: true, result: { tasks } };
}
function dispatchShowResponse(assigneePaneKey) {
  return {
    ok: true,
    result: { dispatch: { assignee_pane_key: assigneePaneKey ?? null } },
  };
}
const SELF_ENTRY = {
  handle: "term_self",
  worktreePath: WT,
  tabId: "self-tab-uuid",
  leafId: "self-leaf-uuid",
  connected: true,
};

function fullyPresentOpts(overrides = {}) {
  return {
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([]);
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([]);
      }
      throw new Error(`unexpected execFn argv ${JSON.stringify(argv)}`);
    },
    gitFn: (argv) => {
      if (argv[0] === "worktree") return gitWorktreeListOutput([WT]);
      if (argv[0] === "status") return "";
      throw new Error(`unexpected gitFn argv ${JSON.stringify(argv)}`);
    },
    existsFn: () => true,
    ...overrides,
  };
}

test("observeTeardownInventory: all sources healthy and the target present -- CONSISTENT_PRESENT-shaped envelope, schemaVersion set", () => {
  const inv = observeTeardownInventory(
    { worktreePath: WT },
    fullyPresentOpts(),
  );
  assert.equal(inv.schemaVersion, TEARDOWN_SCHEMA_VERSION);
  assert.deepEqual(inv.layers, {
    git: "present",
    orca: "present",
    dir: "present",
  });
  assert.equal(inv.activeReferences.observable, true);
  assert.equal(inv.activeReferences.count, 0);
  assert.equal(inv.workingTree.observable, true);
  assert.equal(inv.workingTree.dirty, false);
  assert.deepEqual(inv.observationQuality.degraded, []);
});

test("observeTeardownInventory: target absent from every source -- layers all 'absent'", () => {
  const opts = {
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([]);
      throw new Error("unexpected");
    },
    gitFn: (argv) => (argv[0] === "worktree" ? gitWorktreeListOutput([]) : ""),
    existsFn: () => false,
  };
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.deepEqual(inv.layers, {
    git: "absent",
    orca: "absent",
    dir: "absent",
  });
});

test("observeTeardownInventory: missing gitFn/existsFn -- those layers/sources are unobservable, not silently absent", () => {
  const inv = observeTeardownInventory(
    { worktreePath: WT },
    {
      execFn: (argv) =>
        argv[0] === "worktree"
          ? orcaWorktreeListResponse([WT])
          : orcaTerminalListResponse([]),
    },
  );
  assert.equal(inv.layers.git, "unobservable");
  assert.equal(inv.layers.dir, "unobservable");
  assert.equal(inv.workingTree.observable, false);
  // the sole execFn stub above returns a terminal-list-shaped response for
  // any non-"worktree" argv (including the new task-list query), so
  // task-list parsing also fails here -- activeReferences degrades too.
  assert.deepEqual(
    inv.observationQuality.degraded.sort(),
    ["activeReferences", "dir", "git", "workingTree"].sort(),
  );
});

test("observeTeardownInventory: execFn throwing degrades orca layer + activeReferences to unobservable, not absent/0", () => {
  const opts = fullyPresentOpts({
    execFn: () => {
      throw new Error("orca down");
    },
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.layers.orca, "unobservable");
  assert.equal(inv.activeReferences.observable, false);
  assert.ok(inv.observationQuality.degraded.includes("orca"));
  assert.ok(inv.observationQuality.degraded.includes("activeReferences"));
});

test("observeTeardownInventory: gitFn returning a non-string is treated as unobservable, not absent", () => {
  const opts = fullyPresentOpts({
    gitFn: () => ({ not: "a string" }),
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.layers.git, "unobservable");
  assert.equal(inv.workingTree.observable, false);
});

// HYK-171 사이클4b-1 재작업(streak 1, REVIEW review-1 P1-1 필수 테스트 #1):
// 실 CLI가 실제로 주는 필드만 쓴 입력(같은 워크트리 connected:true 좌석
// 1개, dispatch 정보 없음, 소유권 증거도 없음) -- 현행(수리 전) 코드는
// 이 fixture를 `observable:true, count:0`으로 접어 `allowSink:true`까지
// 냈다(REVIEW 재현). 수리 후에는 증거 없는 connected 좌석을 활성참조로
// 세야 한다(§P1-1 (B)).
test("P1-1 required#1: realistic single connected seat, no dispatch info, NO ownership evidence -- counted as an active reference (was fail-open before the fix)", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") {
        return orcaTerminalListResponse([SELF_ENTRY]);
      }
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([]);
      }
      throw new Error("unexpected");
    },
    // existingSeatHandle intentionally omitted -- no ownership evidence.
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.observable, true);
  assert.equal(inv.activeReferences.count, 1);
  assert.equal(inv.activeReferences.tokens.length, 1);
  assert.equal(/^[0-9a-f]{32}$/.test(inv.activeReferences.tokens[0]), true);
  assert.equal(JSON.stringify(inv).includes("term_self"), false);
});

// P1-1 필수 테스트 #2: task-list/dispatch-show 조회 실패 -> observable:false
// (fail-closed) -- "필드가 없으니 참조 0"으로 접지 않는다.
test("P1-1 required#2: task-list query failure -- activeReferences.observable false (fail-closed, not folded to 0)", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return { ok: false, reason: "orca down" };
      }
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.observable, false);
});

test("P1-1 required#2b: dispatch-show query failure for a dispatched task -- activeReferences.observable false (fail-closed)", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([{ id: "task_x" }]);
      }
      if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
        return { ok: false, reason: "not found" };
      }
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.observable, false);
});

// P1-1 필수 테스트 #3: 소유권 증거(existingSeatHandle)로 대상 좌석 자신만
// 존재 -- 그 좌석은 활성참조로 세지 않는다(paired-good 전제).
test("P1-1 required#3: single connected seat WITH ownership evidence (existingSeatHandle matches it) -- not counted as an active reference", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([]);
      }
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.observable, true);
  assert.equal(inv.activeReferences.count, 0);
});

test("observeTeardownInventory: a second connected seat (not proven to be self) on the same worktree counts as an active reference even when the self seat is excluded", () => {
  const other = {
    handle: "term_other",
    worktreePath: WT,
    tabId: "other-tab-uuid",
    leafId: "other-leaf-uuid",
    connected: true,
  };
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") {
        return orcaTerminalListResponse([SELF_ENTRY, other]);
      }
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([]);
      }
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.count, 1);
  assert.equal(JSON.stringify(inv).includes("term_other"), false);
});

test("observeTeardownInventory: (A) a dispatch-confirmed pane key on the target worktree counts as an active reference even for the self-excluded seat", () => {
  const selfPaneKey = `${SELF_ENTRY.tabId}:${SELF_ENTRY.leafId}`;
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([{ id: "task_x" }]);
      }
      if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
        return dispatchShowResponse(selfPaneKey);
      }
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  // self-exclusion(B) alone would have made this 0 -- (A)'s dispatch record
  // overrides it: this seat still has an unfinished dispatch attached.
  assert.equal(inv.activeReferences.count, 1);
});

test("observeTeardownInventory: workingTree flags -- dirty/untracked/unmerged parsed from git status --porcelain lines", () => {
  const opts = fullyPresentOpts({
    gitFn: (argv) => {
      if (argv[0] === "worktree") return gitWorktreeListOutput([WT]);
      if (argv[0] === "status")
        return " M tracked.txt\n?? new-file.txt\nUU conflict.txt\n";
      throw new Error("unexpected");
    },
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.workingTree.dirty, true);
  assert.equal(inv.workingTree.untracked, true);
  assert.equal(inv.workingTree.unmerged, true);
});

test("observeTeardownInventory: clean git status --porcelain (empty string) -- all workingTree flags false, still observable", () => {
  const inv = observeTeardownInventory(
    { worktreePath: WT },
    fullyPresentOpts(),
  );
  assert.equal(inv.workingTree.dirty, false);
  assert.equal(inv.workingTree.untracked, false);
  assert.equal(inv.workingTree.unmerged, false);
  assert.equal(inv.workingTree.observable, true);
});

test("observeTeardownInventory: target digest is stable across case/backslash/trailing-slash path variants", () => {
  const a = computeCanonicalPathDigest(WT);
  const b = computeCanonicalPathDigest(WT.toUpperCase());
  const c = computeCanonicalPathDigest(WT.replace(/\//g, "\\") + "\\");
  assert.equal(a, b);
  assert.equal(a, c);
});

test("observeTeardownInventory: never leaks a raw terminal handle or worktree path substring outside the tokenized activeReferences field", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") {
        return orcaTerminalListResponse([
          {
            handle: "term_super_secret_handle",
            worktreePath: WT,
            tabId: "secret-tab-uuid",
            leafId: "secret-leaf-uuid",
            connected: true,
          },
        ]);
      }
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return taskListDispatchedResponse([]);
      }
      throw new Error("unexpected");
    },
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(JSON.stringify(inv).includes("term_super_secret_handle"), false);
});

test("observeTeardownInventory: worktreeId is read from the matching orca worktree-list entry, null when absent", () => {
  const present = observeTeardownInventory(
    { worktreePath: WT },
    fullyPresentOpts(),
  );
  assert.equal(present.target.worktreeId, "wt-0");

  const absentOpts = {
    execFn: (argv) =>
      argv[0] === "worktree"
        ? orcaWorktreeListResponse([])
        : orcaTerminalListResponse([]),
    gitFn: () => "",
    existsFn: () => false,
  };
  const absent = observeTeardownInventory({ worktreePath: WT }, absentOpts);
  assert.equal(absent.target.worktreeId, null);
});

// ---- argv shape sanity (read-only, no destructive verb) ----
test("build*Command helpers -- all read-only 'list'/'status' verbs, never rm/close/create", () => {
  const orcaWorktree = buildOrcaWorktreeListCommand();
  const orcaTerminal = buildOrcaTerminalListCommand();
  const gitWorktree = buildGitWorktreeListCommand();
  const gitStatus = buildGitStatusCommand();
  assert.deepEqual(orcaWorktree, ["worktree", "list", "--json"]);
  assert.deepEqual(orcaTerminal, ["terminal", "list", "--json"]);
  assert.deepEqual(gitWorktree, ["worktree", "list", "--porcelain"]);
  assert.deepEqual(gitStatus, ["status", "--porcelain"]);
  for (const argv of [orcaWorktree, orcaTerminal, gitWorktree, gitStatus]) {
    assert.equal(argv.includes("rm"), false);
    assert.equal(argv.includes("close"), false);
    assert.equal(argv.includes("create"), false);
  }
});
