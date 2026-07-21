import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

test("runStepCli: with an injected fake execFn (never the real default), wires through to relayStep and never spawns a real process", async () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "hyk169-run-step-"));
  try {
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      "task_id: HYK-x\ndropped_at: 2026-07-22 07:05 KST\n\nbody\n",
      "utf8",
    );
    let execFnCalled = false;
    const fakeExecFn = () => {
      execFnCalled = true;
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
      ],
      { execFn: fakeExecFn, existingSeatHandle: "term_fake" },
    );
    assert.equal(r.ok, true);
    // ensureSeat reused an existing handle (no execFn call needed there);
    // deliverTask's task-create call is what exercises the fake execFn.
    assert.equal(execFnCalled, true);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
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
