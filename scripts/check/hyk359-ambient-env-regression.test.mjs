// HYK-359 §C 완료조건4: locks in "a floating ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH left set in the invoking shell
// produces the SAME result as running with those vars unset" as an
// automated, fail-red-on-regression check -- not a one-time human
// confirmation (coder-task.md §C-1: "사람이 한 번 확인하고 됐다로 닫지
// 마라 -- 어긋나면 빨간불이 켜져야 한다").
//
// Mechanism: spawn `node --test <file>` for each of the nine test files
// this round isolated from ambient admission-ledger env leakage (the
// files that import admission-ledger-env-isolation.mjs), with the three
// vars deliberately set in THIS regression test's OWN spawn to a path
// inside a throwaway mkdtemp dir this file owns and cleans up -- never a
// real repo path, never shared with any other test's fixture. If a future
// edit strips the isolation this round added from any one of those nine
// files, that file's own suite fails again under the floating var, and
// this test's child-exit-code assertion goes red for that file by name.
//
// This intentionally does NOT re-test admission-ledger-env-isolation.mjs
// in isolation (coder-task.md 급소: "helper를 시험하지 말고 실제 시험
// 파일들이 그 helper를 타는지를 검사하라") -- it drives the real,
// unmodified test files end-to-end instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The nine files coder-task.md's Phase A identified as sensitive to ANY
// ambient value (valid-path or empty-path alike) -- selfcheck-smoke.test.mjs
// is deliberately excluded (out of this round's scope, coder-task.md's
// §7 "닫지 못한 것" -- it is sensitive only to a valid-and-existing ledger
// path, not to a floating var's mere presence, and this round does not
// touch it).
const ISOLATED_FILES = [
  "hyk262-consumption-reject.test.mjs",
  "hyk262-not-blocked-trace.test.mjs",
  "hyk355-reject-streak-isolation.test.mjs",
  "hyk357-352-2r-consumption-block.test.mjs",
  "hyk357-352-2r-cross-issue-note.test.mjs",
  "nc-codex-lane-future-block.test.mjs",
  "reject-streak-auto-record.test.mjs",
  "relay-handshake.test.mjs",
  "dispatch-arg-contract-binding.test.mjs",
];

test("HYK-359 완료조건4: 아홉 개 시험 파일 각각이 떠도는 ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH 아래에서도 exit 0(off와 동일 결과)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk359-ambient-regression-"));
  try {
    // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (set by `node --test` on THIS
    // process, since this file is itself a test) must NOT leak into the
    // spawned children below -- inherited, they make each child's own
    // `node --test` detect "recursive test run" and silently skip running
    // any tests at all (exit 0 with zero tests executed), which would make
    // every one of these assertions pass vacuously regardless of whether
    // the file under test is actually isolated. 실사고: this exact bug hid a
    // genuine RED for a full debugging pass before being caught (실측,
    // node --test 내부에서 이 두 키가 존재함을 직접 확인).
    const parentEnvWithoutTestMarkers = { ...process.env };
    delete parentEnvWithoutTestMarkers.NODE_TEST_CONTEXT;
    delete parentEnvWithoutTestMarkers.NODE_TEST_WORKER_ID;
    const floatingEnv = {
      ...parentEnvWithoutTestMarkers,
      ADMISSION_LEDGER_PATH: join(dir, "floating-ledger.json"),
      ADMISSION_LOCK_PATH: join(dir, "floating-ledger.lock"),
      DISPATCH_RECEIPT_PATH: join(dir, "floating-dispatch-receipt.json"),
    };
    const failures = [];
    for (const file of ISOLATED_FILES) {
      const res = spawnSync(process.execPath, ["--test", join(HERE, file)], {
        encoding: "utf8",
        env: floatingEnv,
      });
      // ORCH review (msg_0465cc91dc7d): "exit 0" alone is the SAME failure
      // shape this file's own NODE_TEST_CONTEXT bug just produced -- a
      // child that silently runs zero tests also exits 0. Read the actual
      // executed-test count out of the child's own `ℹ tests <n>` summary
      // line (node:test's default reporter, stdout) and require it to be
      // positive, so a child that quietly ran nothing can never pass this
      // assertion by accident again.
      const testsRun = Number(
        (res.stdout ?? "").match(/^ℹ tests (\d+)/m)?.[1] ?? 0,
      );
      if (res.status !== 0 || testsRun < 1) {
        failures.push({
          file,
          status: res.status,
          testsRun,
          stderrTail: (res.stderr ?? "").slice(-2000),
        });
      }
    }
    assert.deepEqual(
      failures,
      [],
      `these files still fail (or silently ran zero tests) under a floating ambient ledger env -- isolation regressed: ${JSON.stringify(failures, null, 2)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
