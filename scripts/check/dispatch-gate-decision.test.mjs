import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-decision-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// (1) normal state, no streak history -> ALLOW, exit 0 (no false positive)
// ---------------------------------------------------------------------------
test("(1) streak 0 (no ledger entry), fresh task file -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9001-fresh-1\nsome body\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    // no ledger file at all -- loadLedger's documented "no ledger yet" case
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(2) streak 1 (below envelope threshold) -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9002-streak1-1\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9002": {
          streak: 1,
          history: [
            { task_id: "HYK-9002-coder-1", verdict: "rejected", at: "x" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(3) streak 2 with a complete envelope -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9003-streak2-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9003": {
          streak: 2,
          history: [
            { task_id: "HYK-9003-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9003-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

// N=3 normal-state samples above (fresh/streak-1/streak-2-with-envelope),
// each independently ALLOW -- 0/3 false positives (coder-task §3-1).

// ---------------------------------------------------------------------------
// real incident reproduction: gate BLOCK -> CLI must reject, machine-enforced
// ---------------------------------------------------------------------------
test("(4) streak 2, NO envelope -> reject-streak gate BLOCKs -> CLI REJECT, exit 1", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9004-streak2-noenv-1\nno envelope here\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9004": {
          streak: 2,
          history: [
            { task_id: "HYK-9004-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9004-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT_BLOCKED|BLOCK\(exit 2\)/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(5) streak 4 (hard-stop), ordinary envelope but no diagnostic evidence pointer -> diagnostic-gate BLOCKs -> CLI REJECT", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9005-hardstop-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9005": {
          streak: 4,
          history: [
            { task_id: "HYK-9005-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9005-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9005-coder-3", verdict: "rejected", at: "c" },
            { task_id: "HYK-9005-coder-4", verdict: "rejected", at: "d" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /diagnostic-gate/);
    assert.match(r.stderr, /REJECT --/);
  });
});

// ---------------------------------------------------------------------------
// operational error -- exit 1 never folds to a silent ALLOW
// ---------------------------------------------------------------------------
test("(6) task file missing -> REJECT_OPERATIONAL_ERROR, exit 1, reason visible", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "does-not-exist.md");
    const r = runCli([taskPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /운영 오류/);
    assert.match(r.stderr, /task file not found/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(7) no task-path argument at all -> usage error, exit 1 (not a silent allow)", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
});
