import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunStepArgs, runStepCli } from "./run-step.mjs";
import { WORKSPACES_ROOT } from "./adapters/orca-adapter.mjs";

// HYK-169-coder-1/2: run-step.mjs is written but never executed in this task
// (비타협 제약: 실 orca 호출 0) -- these tests only exercise the pure argv
// parser and the wiring path with an injected fake execFn, never the real
// default createOrcaExecFn (which would spawn a real "orca" process).

// coder-2: ensureSeat now enforces the seat location policy, so the one test
// below that goes through the real ensureSeat (not just the argv parser)
// needs a worktree path that actually passes it.
const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-run-step-fixture`;

test("parseRunStepArgs: happy path parses role/worktree/task-id", () => {
  const r = parseRunStepArgs([
    "--role",
    "CODER",
    "--worktree",
    "/wt",
    "--task-id",
    "HYK-169-coder-1",
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.role, "CODER");
  assert.equal(r.worktreePath, "/wt");
  assert.equal(r.taskId, "HYK-169-coder-1");
});

test("parseRunStepArgs: missing required flag is rejected", () => {
  const r = parseRunStepArgs(["--role", "CODER", "--worktree", "/wt"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /usage/);
});

test("parseRunStepArgs: unrecognized flag is rejected", () => {
  const r = parseRunStepArgs(["--bogus", "x"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unrecognized flag/);
});

test("parseRunStepArgs: '--flag=value' shape is rejected (space-separated only, matches watch-result.mjs convention)", () => {
  const r = parseRunStepArgs(["--role=CODER"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported/);
});

// coder-2 (review-3 결함1 수리 후속): relay-core의 D8 배치가 이제 항상
// mainRepoDir을 요구하므로(존재-only 폴백 제거), 이 CLI 배선 시험도
// --main-repo-dir와 그 안의 원본(.harness/coder-task.md)을 함께 준비한다.
test("runStepCli: with an injected fake execFn (never the real default), wires through to relayStep and never spawns a real process", async () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "hyk169-run-step-"));
  const mainRepoDir = mkdtempSync(join(tmpdir(), "hyk170-run-step-main-"));
  try {
    mkdirSync(join(mainRepoDir, ".harness"), { recursive: true });
    writeFileSync(
      join(mainRepoDir, ".harness", "coder-task.md"),
      "task_id: HYK-x\ndropped_at: 2026-07-22 07:05 KST\n\nbody\n",
      "utf8",
    );
    let execFnCalled = false;
    // HYK-171-cycle4a2-1: ORCA_ADAPTER now also carries observeSeatCandidates
    // (the readiness gate, wired between seat and deliver) -- it queries
    // `terminal list`/`terminal show` before deliverTask's `task-create`, so
    // this fake must answer those two shapes too, plus supply a classify
    // capability (opt-in only, never auto-applied) so the one observed
    // candidate normalizes to a dispatchable idle-or-ready pool of exactly 1.
    const fakeExecFn = (argv) => {
      execFnCalled = true;
      if (argv[0] === "terminal" && argv[1] === "list") {
        return {
          ok: true,
          result: {
            terminals: [
              {
                handle: "term_fake",
                worktreePath: VALID_WORKTREE,
                tabId: "tab-1",
              },
            ],
          },
        };
      }
      if (argv[0] === "terminal" && argv[1] === "show") {
        return { ok: true, result: { terminal: { preview: "IDLE" } } };
      }
      return { ok: true, result: { task: { id: "task_fake" } } };
    };
    const r = await runStepCli(
      [
        "--role",
        "CODER",
        "--worktree",
        VALID_WORKTREE,
        "--task-id",
        "HYK-x",
        "--harness-dir",
        harnessDir,
        "--main-repo-dir",
        mainRepoDir,
      ],
      {
        execFn: fakeExecFn,
        existingSeatHandle: "term_fake",
        capabilities: { classify: (tail) => (tail === "IDLE" ? "idle" : null) },
      },
    );
    assert.equal(r.ok, true);
    // ensureSeat reused an existing handle (no execFn call needed there);
    // the readiness gate's terminal list/show + deliverTask's task-create
    // call are what exercise the fake execFn.
    assert.equal(execFnCalled, true);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("runStepCli: invalid argv never reaches the adapter/execFn at all", async () => {
  let called = false;
  const r = await runStepCli(["--role", "CODER"], {
    execFn: () => {
      called = true;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});
