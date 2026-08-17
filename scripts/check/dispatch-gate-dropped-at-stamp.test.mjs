// HYK-257-done-stamp-2 §2 범위2 ⓑ -- dispatch-gate-decision.mjs's new
// best-effort dropped_at machine-stamp step.
//
// 실재 앵커(관제실 dispatch-worker.ps1, 읽기 전용 실측 원문): 배달 직전
// 항상 `node scripts/check/dispatch-gate-decision.mjs <roleTaskFile>
// --expect-repo-root <worktree>`를 부른다 -- 그 첫 인자가 이 파일이 새로
// 손대는 대상이다. 이 시험은 (a) 이미 있는 dropped_at: 줄이 새 기계
// 스탬프로 덮어써지고 그 외 내용은 바이트 동일하게 남는지, (b) 이 CLI의
// 기존 게이트/exit-code 계약이 전혀 바뀌지 않는지를 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-stamp-test-"));
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

const DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;

test("(a) existing dropped_at: line is rewritten to a fresh machine-stamped value, rest of file byte-identical", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `task_id: HYK-9101-stamp-1\ndropped_at: 2020-01-01 00:00 KST\nrole: CODER\nsome body line\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const before = Date.now();
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    const after = Date.now();

    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);

    const rewritten = readFileSync(taskPath, "utf8");
    assert.notEqual(
      rewritten,
      original,
      "dropped_at line must have been rewritten",
    );

    const match = rewritten.match(DROPPED_AT_RE);
    assert.ok(match, "dropped_at: line must still be present");
    assert.notEqual(match[1].trim(), "2020-01-01 00:00 KST");

    // The stamped value must be a real machine-clock reading taken during
    // this CLI invocation (KST, minute precision) -- not an arbitrary
    // string. Parse it back and confirm it falls within [before, after].
    const stampedMatch = match[1]
      .trim()
      .match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) KST$/);
    assert.ok(
      stampedMatch,
      `stamped value must match KST minute format: '${match[1]}'`,
    );
    const stampedMs = new Date(
      `${stampedMatch[1]}T${stampedMatch[2]}:00+09:00`,
    ).getTime();
    // Minute-precision rounds down -- allow a 60s window on both sides.
    assert.ok(
      stampedMs >= before - 60_000 && stampedMs <= after + 60_000,
      `stamped value ${match[1]} must be within the CLI invocation window`,
    );

    // Everything OUTSIDE the dropped_at line must be byte-identical.
    const expectedRewritten = original.replace(
      DROPPED_AT_RE,
      `dropped_at: ${match[1].trim()}`,
    );
    assert.equal(rewritten, expectedRewritten);
  });
});

test("(b) no dropped_at: line present -- stamp step is a no-op, file untouched, ALLOW unaffected", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `task_id: HYK-9102-nodropped-1\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
    const after = readFileSync(taskPath, "utf8");
    assert.equal(
      after,
      original,
      "file must be byte-identical when no dropped_at: line exists",
    );
  });
});

test("(c) pre-existing REJECT fixture shape (streak 2, no envelope) still REJECTs -- stamping does not weaken the gate", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9103-reject-1\ndropped_at: 2020-01-01 00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9103": {
          streak: 2,
          history: [
            { task_id: "HYK-9103-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9103-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT/);
    // Even though the CLI still rejects, the best-effort stamp step must
    // still have run (it runs before the gates, unconditionally once the
    // file exists) -- dropped_at should still have been overwritten.
    const rewritten = readFileSync(taskPath, "utf8");
    const match = rewritten.match(DROPPED_AT_RE);
    assert.ok(match);
    assert.notEqual(match[1].trim(), "2020-01-01 00:00 KST");
  });
});
