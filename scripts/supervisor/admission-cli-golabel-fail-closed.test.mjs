import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdmissionCli, validateHarnessLabel } from "./admission-cli.mjs";

// HYK-306 (coder-task.md §4-3): 2026-08-18 관제실이 `-GoLabel`을 빠뜨리자
// dispatch-worker.ps1이 조용히 런타임 id를 하네스 이름표 자리에 채워 넣은
// 실사고의 정확한 형태를 여기서 실행으로 재현·차단 증명한다. `admit`의
// `--reservation-id`는 관제실이 하네스 이름표를 넘기는 첫 CLI 호출
// (`orca orchestration dispatch` 이전)이므로 이 지점이 최초 방어선이다.

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-cli-golabel-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

function captureConsole() {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg) => lines.push(String(msg));
  console.error = (msg) => lines.push(String(msg));
  return {
    lines,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function cutover(ledger, lock) {
  const cap = captureConsole();
  try {
    const exit = runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    assert.equal(exit, 0, "cutover fixture setup must succeed");
  } finally {
    cap.restore();
  }
}

test("RED(empty label): admit with no --reservation-id is rejected, nonzero exit, reason printed (HYK-306 §4-3 항1)", () => {
  const { dir, ledger, lock } = tmpPaths();
  cutover(ledger, lock);
  const cap = captureConsole();
  try {
    const exit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--cap",
      "2",
    ]);
    cap.restore();
    assert.notEqual(exit, 0);
    assert.ok(
      cap.lines.some(
        (l) =>
          l.includes("admit:") && l.includes("--reservation-id is required"),
      ),
      `expected a specific empty-label reason, got: ${JSON.stringify(cap.lines)}`,
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RED(runtime-id shape): admit with --reservation-id task_ac822047b14d is rejected, nonzero exit (HYK-306 §4-3 항2 -- 2026-08-18 실사고의 정확한 형태)", () => {
  const { dir, ledger, lock } = tmpPaths();
  cutover(ledger, lock);
  const cap = captureConsole();
  try {
    const exit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "task_ac822047b14d",
      "--cap",
      "2",
    ]);
    cap.restore();
    assert.notEqual(exit, 0);
    assert.ok(
      cap.lines.some(
        (l) =>
          l.includes("admit:") &&
          l.includes("looks like an orca runtime task id"),
      ),
      `expected a specific runtime-id-shape reason, got: ${JSON.stringify(cap.lines)}`,
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GREEN(normal label): admit with --reservation-id HYK-306-label-1 passes through unaffected (HYK-306 §4-3 항3)", () => {
  const { dir, ledger, lock } = tmpPaths();
  cutover(ledger, lock);
  const cap = captureConsole();
  try {
    const exit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-306-label-1",
      "--cap",
      "2",
    ]);
    cap.restore();
    assert.equal(exit, 0);
    assert.ok(
      cap.lines.some((l) =>
        l.startsWith("CAP_ADMITTED reservation=HYK-306-label-1"),
      ),
      `expected normal admission to succeed, got: ${JSON.stringify(cap.lines)}`,
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateHarnessLabel unit: empty/null/runtime-id-shaped rejected, harness labels accepted", () => {
  assert.equal(validateHarnessLabel("").ok, false);
  assert.equal(validateHarnessLabel(undefined).ok, false);
  assert.equal(validateHarnessLabel("task_ac822047b14d").ok, false);
  assert.equal(validateHarnessLabel("task_5b27a35f9989").ok, false);
  assert.equal(validateHarnessLabel("TASK_AC822047B14D").ok, false);
  assert.equal(validateHarnessLabel("HYK-306-label-1").ok, true);
  assert.equal(validateHarnessLabel("HYK-285-wake-1").ok, true);
  // "task" appearing mid-string (not the runtime-id shape) must not be
  // caught by an over-broad substring check.
  assert.equal(validateHarnessLabel("HYK-306-task-review-1").ok, true);
});
