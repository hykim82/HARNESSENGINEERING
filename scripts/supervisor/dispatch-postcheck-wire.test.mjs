// HYK-212-postcheck-1 (coder-task.md) -- «배달 직후 재조회 사후검증»의
// 감시 시점 결선 계약 시험. 이 축은 orca를 다시 부르지 않는다(배달
// 시점의 재조회 결과가 워크트리 영수증(.harness/dispatch-postcheck.json)
// 파일로 이미 남아 있다 -- orca-adapter.test.mjs가 그 쪽을 시험한다) --
// 이 파일은 그 영수증을 읽어 AXES가 소비할 수 있는 status/verdict로
// 옮겨 적는 결선만 시험한다.
//
// §5(합격 기준) 요구대로 프로덕션 진입점(runOrchStallDetect)을 최소 1건
// 구동한다 -- helper만 부르는 시험은 "감지 절단" 변조를 못 잡는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  judgeDispatchPostcheckAcrossWorktrees,
  runOrchStallDetect,
  DISPATCH_POSTCHECK_WIRE_STATUS,
  DISPATCH_POSTCHECK_SCAN_FAILURE,
} from "./orch-stall-detect.mjs";
import { DISPATCH_POSTCHECK_VERDICT } from "../relay/adapters/dispatch-postcheck-core.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function initPlainGitRepo(dir) {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  ]);
}
function writeReceipt(dir, receipt) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, ".harness", "dispatch-postcheck.json"),
    JSON.stringify(receipt),
    "utf8",
  );
}
function writeCorruptReceipt(dir) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, ".harness", "dispatch-postcheck.json"),
    "{not valid json",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// judgeDispatchPostcheckAcrossWorktrees -- 단일 워크트리 시나리오
// ---------------------------------------------------------------------------
test("judgeDispatchPostcheckAcrossWorktrees: no receipt file (ENOENT) -> NOT_APPLICABLE, no false alarm", () => {
  withTempDir("hyk212-pc-", (dir) => {
    initPlainGitRepo(dir);
    const r = judgeDispatchPostcheckAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, DISPATCH_POSTCHECK_WIRE_STATUS.NOT_APPLICABLE);
    assert.equal(r.totalWorktrees, 1);
  });
});

test("judgeDispatchPostcheckAcrossWorktrees: receipt says RECORD_MISSING -> surfaces as JUDGED/RECORD_MISSING (the alarm), not folded to NOT_APPLICABLE/UNDECIDABLE", () => {
  withTempDir("hyk212-pc-", (dir) => {
    initPlainGitRepo(dir);
    writeReceipt(dir, {
      runtimeTaskId: "task_abc",
      harnessTaskId: "HYK-212-postcheck-1",
      checkedAtMs: 1000,
      status: "OK",
      verdict: DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
      reasonCode: "NO_DISPATCH",
    });
    const r = judgeDispatchPostcheckAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, DISPATCH_POSTCHECK_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING);
    assert.equal(r.runtimeTaskId, "task_abc");
    assert.equal(r.harnessTaskId, "HYK-212-postcheck-1");
  });
});

test("judgeDispatchPostcheckAcrossWorktrees: receipt says CONFIRMED (normal delivery) -> JUDGED/CONFIRMED, not the RECORD_MISSING alarm (§3-2 zero false positives)", () => {
  withTempDir("hyk212-pc-", (dir) => {
    initPlainGitRepo(dir);
    writeReceipt(dir, {
      runtimeTaskId: "task_abc",
      harnessTaskId: "HYK-212-postcheck-1",
      checkedAtMs: 1000,
      status: "OK",
      verdict: DISPATCH_POSTCHECK_VERDICT.CONFIRMED,
      reasonCode: "VALID",
    });
    const r = judgeDispatchPostcheckAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, DISPATCH_POSTCHECK_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, DISPATCH_POSTCHECK_VERDICT.CONFIRMED);
  });
});

test("judgeDispatchPostcheckAcrossWorktrees: receipt says QUERY_FAILED -- surfaces as its own status, never as JUDGED/RECORD_MISSING (§3-3 query failure != record missing)", () => {
  withTempDir("hyk212-pc-", (dir) => {
    initPlainGitRepo(dir);
    writeReceipt(dir, {
      runtimeTaskId: "task_abc",
      harnessTaskId: "HYK-212-postcheck-1",
      checkedAtMs: 1000,
      status: "QUERY_FAILED",
      verdict: null,
      reasonCode: "QUERY_THREW",
    });
    const r = judgeDispatchPostcheckAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, DISPATCH_POSTCHECK_WIRE_STATUS.QUERY_FAILED);
    assert.notEqual(r.verdict, DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING);
  });
});

test("judgeDispatchPostcheckAcrossWorktrees: corrupt receipt JSON -> RECEIPT_READ_FAILED (collection failure surfaced, not silently NOT_APPLICABLE)", () => {
  withTempDir("hyk212-pc-", (dir) => {
    initPlainGitRepo(dir);
    writeCorruptReceipt(dir);
    const r = judgeDispatchPostcheckAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, DISPATCH_POSTCHECK_SCAN_FAILURE.RECEIPT_READ_FAILED);
  });
});

test("judgeDispatchPostcheckAcrossWorktrees: git worktree list itself fails -> WORKTREE_LIST_FAILED, worktrees:[]", () => {
  const r = judgeDispatchPostcheckAcrossWorktrees(
    { repoRoot: "C:/does/not/exist" },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(r.status, DISPATCH_POSTCHECK_SCAN_FAILURE.WORKTREE_LIST_FAILED);
  assert.deepEqual(r.worktrees, []);
});

// ---------------------------------------------------------------------------
// runOrchStallDetect -- 프로덕션 진입점을 실제로 구동해 result.postcheck가
// 채워지는지 확인한다(§5 "helper가 아니라 진입점" 요구).
// ---------------------------------------------------------------------------
test("runOrchStallDetect: result.postcheck is populated end-to-end via the real CLI-callable entry point", () => {
  withTempDir("hyk212-pc-e2e-", (dir) => {
    initPlainGitRepo(dir);
    writeReceipt(dir, {
      runtimeTaskId: "task_abc",
      harnessTaskId: "HYK-212-postcheck-1",
      checkedAtMs: 1000,
      status: "OK",
      verdict: DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
      reasonCode: "NO_DISPATCH",
    });
    const { result } = runOrchStallDetect([
      "--repo-root",
      dir,
      "--now",
      "2026-08-09T10:00:00+09:00",
      "--json",
    ]);
    assert.equal(typeof result.postcheck, "object");
    assert.equal(
      result.postcheck.status,
      DISPATCH_POSTCHECK_WIRE_STATUS.JUDGED,
    );
    assert.equal(
      result.postcheck.verdict,
      DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
    );
  });
});

// ---------------------------------------------------------------------------
// static -- 이 축도 orca를 새로 부르지 않는다(G9 -- 영수증 파일만 읽는다).
// ---------------------------------------------------------------------------
test("static: judgeDispatchPostcheckAcrossWorktrees never touches opts.execFn (no orca re-call at watch time)", () => {
  withTempDir("hyk212-pc-static-", (dir) => {
    initPlainGitRepo(dir);
    writeReceipt(dir, {
      runtimeTaskId: "task_abc",
      harnessTaskId: "HYK-212-postcheck-1",
      checkedAtMs: 1000,
      status: "OK",
      verdict: DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
      reasonCode: "NO_DISPATCH",
    });
    const r = judgeDispatchPostcheckAcrossWorktrees(
      { repoRoot: dir },
      {
        execFn: () => {
          throw new Error(
            "must not be called -- this axis reads a receipt file, not orca",
          );
        },
      },
    );
    assert.equal(r.status, DISPATCH_POSTCHECK_WIRE_STATUS.JUDGED);
  });
});
