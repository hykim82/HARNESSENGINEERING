import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  extractPromptTaskId,
  checkGoTaskId,
  generateGoLine,
} from "./go-task-id-gate.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./go-task-id-gate.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "go-task-id-gate-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(input, env = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function runGenerate(taskPath) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, "--generate", taskPath], {
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// extractPromptTaskId
// ---------------------------------------------------------------------------

test("(1) extractPromptTaskId: 'go HYK-1-coder-1' -> HYK-1-coder-1", () => {
  assert.equal(extractPromptTaskId("go HYK-1-coder-1"), "HYK-1-coder-1");
});

test("(2) extractPromptTaskId: bare 'go' -> null", () => {
  assert.equal(extractPromptTaskId("go"), null);
});

test("(3) extractPromptTaskId: 'go   ' (only whitespace after) -> null", () => {
  assert.equal(extractPromptTaskId("go   "), null);
});

test("(4) extractPromptTaskId: non-go prompt -> null", () => {
  assert.equal(extractPromptTaskId("완료"), null);
});

// ---------------------------------------------------------------------------
// checkGoTaskId -- known-bad / paired-good matrix
// ---------------------------------------------------------------------------

test("(5) non-go prompt -> PASS (not this gate's concern)", () => {
  const result = checkGoTaskId({
    prompt: "지금 뭐 해야 돼?",
    taskContent: "task_id: HYK-1-coder-1\n",
  });
  assert.equal(result.status, "PASS");
});

test("(6) known-bad: bare 'go' (no task_id token) -> TASK_ID_REQUIRED", () => {
  const result = checkGoTaskId({
    prompt: "go",
    taskContent: "task_id: HYK-1-coder-1\n",
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^TASK_ID_REQUIRED/);
});

test("(7) known-bad: prompt task_id doesn't match task file's -> TASK_ID_MISMATCH (coder-11 stale re-run shape)", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-1-coder-2",
    taskContent: "task_id: HYK-1-coder-1\n",
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^TASK_ID_MISMATCH/);
  assert.match(result.reason, /'HYK-1-coder-2'/);
  assert.match(result.reason, /'HYK-1-coder-1'/);
});

test("(8) paired good: same file, prompt task_id corrected to match -> PASS", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-1-coder-1",
    taskContent: "task_id: HYK-1-coder-1\n",
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(9) UNJUDGABLE: task file missing/unreadable -> fail-open, never claims a match or a mismatch", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-1-coder-1",
    taskContent: null,
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(result.ok, true);
});

test("(10) UNJUDGABLE: task file has no task_id header -> fail-open", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-1-coder-1",
    taskContent: "no header here\n",
  });
  assert.equal(result.status, "UNJUDGABLE");
});

// ---------------------------------------------------------------------------
// generateGoLine (part B)
// ---------------------------------------------------------------------------

test("(11) generateGoLine: reads task_id, prints exact 'go <id>' line", () => {
  const result = generateGoLine(
    "task_id: HYK-1-coder-1\ndropped_at: 2026-07-18 10:00 KST\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.line, "go HYK-1-coder-1");
});

test("(12) known-bad: generateGoLine on a task file with no task_id -> fail-closed (no line)", () => {
  const result = generateGoLine("no header\n");
  assert.equal(result.ok, false);
});

test("(13) paired good: task_id header added back -> generateGoLine succeeds", () => {
  const bad = generateGoLine("no header\n");
  assert.equal(bad.ok, false);
  const good = generateGoLine("task_id: HYK-1-coder-1\n");
  assert.equal(good.ok, true);
  assert.equal(good.line, "go HYK-1-coder-1");
});

// ---------------------------------------------------------------------------
// CLI: --generate mode
// ---------------------------------------------------------------------------

test("(14) CLI --generate: prints go line, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-1-coder-1\ndropped_at: 2026-07-18 10:00 KST\n",
      "utf8",
    );
    const result = runGenerate(taskPath);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "go HYK-1-coder-1");
  });
});

test("(15) CLI --generate: known-bad task file (no task_id) -> exit 1, no stdout line", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "no task_id here\n", "utf8");
    const result = runGenerate(taskPath);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
  });
});

test("(16) CLI --generate: missing file -> exit 1", () => {
  withFixtureDir((dir) => {
    const result = runGenerate(join(dir, "does-not-exist.md"));
    assert.equal(result.status, 1);
  });
});

// ---------------------------------------------------------------------------
// CLI: hook mode (UserPromptSubmit payload on stdin)
// ---------------------------------------------------------------------------

test("(17) CLI hook: known-bad -- bare 'go' for a regulated role -> exit 2, TASK_ID_REQUIRED on stderr", () => {
  withFixtureDir((dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-1-coder-1\n",
      "utf8",
    );
    const result = runHook({ prompt: "go" }, { HARNESS_ROLE: "CODER" });
    // repoRoot() resolves to this repo (git rev-parse), not the fixture dir,
    // so this specific test only needs the BLOCK path (bare 'go' short-
    // circuits before the task file is even read).
    assert.equal(result.status, 2);
    assert.match(result.stderr, /TASK_ID_REQUIRED/);
  });
});

test("(18) CLI hook: non-go prompt -> exit 0, never blocks", () => {
  const result = runHook(
    { prompt: "지금 뭐 해야 돼?" },
    { HARNESS_ROLE: "CODER" },
  );
  assert.equal(result.status, 0);
});

test("(19) CLI hook: unregulated role -> exit 0 (not this gate's concern)", () => {
  const result = runHook(
    { prompt: "go HYK-1-coder-1" },
    { HARNESS_ROLE: "ORCH" },
  );
  assert.equal(result.status, 0);
});

test("(20) CLI hook: malformed JSON payload -> exit 0 (never blocks on a hook-framework problem)", () => {
  try {
    execFileSync("node", [SCRIPT_PATH], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, HARNESS_ROLE: "CODER" },
    });
    assert.ok(true);
  } catch (err) {
    assert.equal(err.status, 0);
  }
});
