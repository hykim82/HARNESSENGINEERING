import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  observeTeardownInventory,
  observeArchiveInventory,
  computeCanonicalPathDigest,
  buildOrcaWorktreeListCommand,
  buildOrcaTerminalListCommand,
  buildGitWorktreeListCommand,
  buildGitStatusCommand,
  buildGitRevParseHeadCommand,
  buildGitLsRemoteMasterCommand,
} from "./teardown-inventory-adapter.mjs";
import { TEARDOWN_SCHEMA_VERSION } from "../teardown-core.mjs";

// HYK-171 사이클4b-1 -- teardown-inventory-adapter.mjs 단위시험. 전부 fake
// execFn/gitFn/existsFn 주입(실 orca/git 프로세스 호출 0, 파괴 argv 0).
//
// HYK-171 사이클4b-1 재작업3(사람 게이트 결정, coder-task.md §0/§1): 이전
// (스트릭2)에 있던 `task-list`/`dispatch-show` 관측 관련 시험(P1-1
// required#2/#2b, "(A) a dispatch-confirmed pane key ...")을 전부
// 삭제했다 -- ORCH 실측으로 그 상관 기제 자체가 증명 불가임이 확인돼
// 프로덕션 코드에서 통째로 제거됐고(teardown-inventory-adapter.mjs 헤더
// 주석 참조), 그 코드를 시험하던 테스트도 함께 소멸한다(조용한 삭제
// 방지를 위해 이 주석에 사유를 남긴다). 활성참조 시험은 이제 connected+
// handle 소유권 증거만 다룬다.

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
  assert.equal(inv.activeReferences.observable, true); // execFn still answers terminal-list
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

// HYK-171 사이클4b-1 재작업3(사람 게이트 결정, coder-task.md §3 required#3):
// 실 CLI가 실제로 주는 필드만 쓴 입력(같은 워크트리 connected:true 좌석
// 1개, 소유권 증거 없음) -- 증거 없는 connected 좌석은 활성참조로 세야
// 한다(§2-A).
test("required#3: realistic single connected seat, NO ownership evidence -- counted as an active reference", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
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

test("observeTeardownInventory: terminal-list query failure -- activeReferences.observable false (fail-closed, not folded to 0)", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return { ok: false, reason: "orca down" };
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.observable, false);
});

// 소유권 증거(existingSeatHandle)로 대상 좌석 자신만 존재 -- 그 좌석은
// 활성참조로 세지 않는다(paired-good 전제).
test("required#3b: single connected seat WITH ownership evidence (existingSeatHandle matches it) -- not counted as an active reference", () => {
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
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
      throw new Error("unexpected");
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.count, 1);
  assert.equal(JSON.stringify(inv).includes("term_other"), false);
});

// required#2 (coder-task.md §3): pty 문자열형 tabId/leafId(실측값 형태,
// 둘이 동일값)를 가진 실형식 좌석이라도 handle 불일치면 활성참조로 센다
// -- tabId/leafId는 판정에 전혀 관여하지 않는다는 것을 고정한다(pane key
// 조립이 되살아나면 이 시험이 깨진다).
test("required#2: pty-string tabId/leafId (identical values) never influence the verdict -- only handle identity matters", () => {
  const ptyString =
    "pty:e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/some/worktree@@027e1972";
  const self = { ...SELF_ENTRY, tabId: ptyString, leafId: ptyString };
  const other = {
    handle: "term_other",
    worktreePath: WT,
    tabId: ptyString,
    leafId: ptyString,
    connected: true,
  };
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal")
        return orcaTerminalListResponse([self, other]);
      throw new Error("unexpected");
    },
    existingSeatHandle: self.handle,
  });
  const inv = observeTeardownInventory({ worktreePath: WT }, opts);
  assert.equal(inv.activeReferences.count, 1); // "other" only, despite identical tabId/leafId
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

// required#1 (coder-task.md §3): argv 부재 단언 -- observeTeardownInventory
// 는 어떤 입력에서도 `orchestration task-list`/`dispatch-show` argv를
// 만들지 않는다(그 명령을 만드는 코드 자체가 삭제됐다). fullyPresentOpts의
// execFn은 "worktree"/"terminal" 이외의 argv[0]에 대해 즉시 throw하므로,
// 이 시험이 통과한다는 것 자체가 이미 그 부재를 증명하지만, 명시적으로도
// 한 번 더 고정한다(호출 목록 전수 검사).
test("required#1: observeTeardownInventory never issues orchestration task-list/dispatch-show argv", () => {
  const calls = [];
  const opts = fullyPresentOpts({
    execFn: (argv) => {
      calls.push(argv);
      if (argv[0] === "worktree") return orcaWorktreeListResponse([WT]);
      if (argv[0] === "terminal") return orcaTerminalListResponse([SELF_ENTRY]);
      throw new Error(`unexpected execFn argv ${JSON.stringify(argv)}`);
    },
    existingSeatHandle: SELF_ENTRY.handle,
  });
  observeTeardownInventory({ worktreePath: WT }, opts);
  const forbidden = calls.filter(
    (a) =>
      a[0] === "orchestration" &&
      (a[1] === "task-list" || a[1] === "dispatch-show"),
  );
  assert.deepEqual(forbidden, []);
});

// ═══════════════════════════════════════════════════════════════════════
// HYK-464-teardown-shadow-1 -- observeArchiveInventory(ⓐⓒⓓ 관측, 읽기
// 전용). ⓑ(미소비)는 이 파일이 만들지 않는다(호출자가 채운다, 위
// teardown-core.test.mjs의 judgeArchiveEligibility 시험이 그 축을 이미
// 다룬다) -- 여기서는 ⓐⓒⓓ만 다룬다.
// ═══════════════════════════════════════════════════════════════════════

const SHA_HEAD = "a".repeat(40);
const SHA_REMOTE = "b".repeat(40);

function fullyEligibleArchiveOpts(overrides = {}) {
  return {
    gitFn: (argv) => {
      assert.deepEqual(argv, buildGitRevParseHeadCommand());
      return `${SHA_HEAD}\n`;
    },
    lsRemoteFn: (argv) => {
      assert.deepEqual(argv, buildGitLsRemoteMasterCommand());
      return `${SHA_REMOTE}\trefs/heads/master\n`;
    },
    isAncestorFn: (headSha, remoteSha) => {
      assert.equal(headSha, SHA_HEAD);
      assert.equal(remoteSha, SHA_REMOTE);
      return true;
    },
    existsFn: () => false,
    readFileFn: () => {
      throw new Error(
        "readFileFn should not be called when keep-reason.md absent",
      );
    },
    listHarnessFilesFn: () => [".harness/coder.md"],
    readFileBufferFn: () => Buffer.from("hello"),
    ...overrides,
  };
}

test("HYK-464-teardown-shadow-1 observeArchiveInventory: 전부 관측 가능하고 병합 완료 + keep-reason 없음 -> observable 전부 true", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts(),
  );
  assert.deepEqual(inv.mergeStatus, {
    observable: true,
    isAncestorOfRemoteMaster: true,
    headSha: SHA_HEAD,
    remoteMasterSha: SHA_REMOTE,
  });
  assert.deepEqual(inv.keepReason, {
    observable: true,
    present: false,
    firstLine: null,
  });
  assert.equal(inv.archiveManifest.observable, true);
  assert.equal(
    inv.archiveManifest.files[0].sha256,
    createHash("sha256").update(Buffer.from("hello")).digest("hex"),
  );
  assert.equal(inv.archiveManifest.files[0].bytes, 5);
  assert.equal(inv.archiveManifest.files[0].path, ".harness/coder.md");
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: 병합 안 됨(is-ancestor false) -> mergeStatus.isAncestorOfRemoteMaster=false", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({ isAncestorFn: () => false }),
  );
  assert.equal(inv.mergeStatus.observable, true);
  assert.equal(inv.mergeStatus.isAncestorOfRemoteMaster, false);
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: lsRemoteFn이 없으면 mergeStatus는 UNOBSERVABLE(지어내지 않는다)", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({ lsRemoteFn: undefined }),
  );
  assert.deepEqual(inv.mergeStatus, { observable: false });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: isAncestorFn이 던지면(진짜 오류, 예: unknown revision) mergeStatus는 UNOBSERVABLE", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({
      isAncestorFn: () => {
        throw new Error("fatal: Not a valid object name");
      },
    }),
  );
  assert.deepEqual(inv.mergeStatus, { observable: false });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: ls-remote 응답이 40자 sha가 아니면(이상 출력) UNOBSERVABLE", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({ lsRemoteFn: () => "not-a-sha\n" }),
  );
  assert.deepEqual(inv.mergeStatus, { observable: false });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: keep-reason.md 존재 -> present:true + 첫 줄", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({
      existsFn: () => true,
      readFileFn: () => "\n보존 사유 첫 줄\n둘째 줄은 안 쓴다\n",
    }),
  );
  assert.deepEqual(inv.keepReason, {
    observable: true,
    present: true,
    firstLine: "보존 사유 첫 줄",
  });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: keep-reason.md 있는데 못 읽으면(권한 등) UNOBSERVABLE(없다로 접지 않는다)", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({
      existsFn: () => true,
      readFileFn: () => {
        throw new Error("EACCES");
      },
    }),
  );
  assert.deepEqual(inv.keepReason, { observable: false });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: listHarnessFilesFn이 없으면 archiveManifest는 UNOBSERVABLE", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({ listHarnessFilesFn: undefined }),
  );
  assert.deepEqual(inv.archiveManifest, { observable: false });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: readFileBufferFn이 던지면(파일 하나라도 읽기 실패) archiveManifest 전체가 UNOBSERVABLE", () => {
  const inv = observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({
      listHarnessFilesFn: () => [".harness/coder.md", ".harness/review.md"],
      readFileBufferFn: (relPath) => {
        if (relPath === ".harness/review.md") throw new Error("ENOENT");
        return Buffer.from("x");
      },
    }),
  );
  assert.deepEqual(inv.archiveManifest, { observable: false });
});

test("HYK-464-teardown-shadow-1 observeArchiveInventory: 파괴 argv 0 -- gitFn/lsRemoteFn에는 조회성 argv만 간다", () => {
  const calls = [];
  observeArchiveInventory(
    { worktreePath: WT },
    fullyEligibleArchiveOpts({
      gitFn: (argv) => {
        calls.push(argv);
        return `${SHA_HEAD}\n`;
      },
      lsRemoteFn: (argv) => {
        calls.push(argv);
        return `${SHA_REMOTE}\trefs/heads/master\n`;
      },
    }),
  );
  for (const argv of calls) {
    assert.equal(argv.includes("rm"), false);
    assert.equal(argv.includes("close"), false);
    assert.equal(argv.includes("push"), false);
    assert.equal(argv.includes("-f"), false);
    assert.equal(argv.includes("--force"), false);
  }
});
