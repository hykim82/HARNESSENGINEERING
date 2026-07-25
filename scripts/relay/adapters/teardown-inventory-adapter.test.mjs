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

function fullyPresentOpts(overrides = {}) {
  return {
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([]);
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
  assert.deepEqual(
    inv.observationQuality.degraded.sort(),
    ["dir", "git", "workingTree"].sort(),
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

test("observeTeardownInventory: activeReferences only counts entries with activeDispatch===true for the matching worktree", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") {
        return orcaTerminalListResponse([
          { handle: "term_busy", worktreePath: WT, activeDispatch: true },
          { handle: "term_idle", worktreePath: WT, activeDispatch: false },
          {
            handle: "term_other_wt",
            worktreePath: "/some/other/wt",
            activeDispatch: true,
          },
        ]);
      }
      throw new Error("unexpected");
    },
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.count, 1);
  assert.equal(inv.activeReferences.tokens.length, 1);
  // no raw handle leaks -- token is a 32-char hex digest, never "term_busy"
  assert.equal(/^[0-9a-f]{32}$/.test(inv.activeReferences.tokens[0]), true);
  assert.equal(JSON.stringify(inv).includes("term_busy"), false);
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
            activeDispatch: true,
          },
        ]);
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
