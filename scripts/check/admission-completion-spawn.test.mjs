// HYK-224-2R §3 옵션3 -- integration coverage for the CLI-only, best-effort
// spawn wired into relay-handshake.mjs's `invokedDirectly` block (see that
// file's spawnAdmissionCompletion + admission-completion-adapter.mjs's own
// CLI entrypoint). Two properties this file exists to pin:
//   1. when ADMISSION_LEDGER_PATH is set and the adapter file is present,
//      a successful handshake actually releases the matching reservation.
//   2. when the adapter file is ABSENT (the exact isolated-fixture shape
//      1R's static import broke -- relay-handshake.mjs copied alone, no
//      siblings), the handshake still exits 0 -- the spawn failure is
//      swallowed, never propagated to the handshake's own exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");

function runRelayHandshakeCli(harnessDir, env) {
  const res = spawnSync(
    process.execPath,
    [RELAY_HANDSHAKE_PATH, "coder", harnessDir],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  if (res.error) assert.fail(`spawn failed: ${res.error.message}`);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function writeFixture(dir, taskId) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: 2026-08-11 06:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-11 06:10:00 KST\n`,
    "utf8",
  );
}

test("relay-handshake CLI spawn releases the matching admission reservation when ADMISSION_LEDGER_PATH is set", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "admission-spawn-harness-"));
  const ledgerDir = mkdtempSync(join(tmpdir(), "admission-spawn-ledger-"));
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-SPAWN-1";
    writeFixture(harnessDir, taskId);
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      taskId,
      "--cap",
      "1",
    ]);

    const result = runRelayHandshakeCli(harnessDir, {
      ADMISSION_LEDGER_PATH: ledger,
      ADMISSION_LOCK_PATH: lock,
    });
    assert.equal(result.exit, 0, `handshake should pass: ${result.stderr}`);

    const ledgerContent = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(ledgerContent.reservations[taskId].status, "COMPLETED");
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("relay-handshake CLI still exits 0 when the admission-completion-adapter.mjs sibling file is ABSENT (isolated-fixture shape)", () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "admission-spawn-isolated-"));
  const isolatedCheckDir = join(isolatedDir, "scripts", "check");
  const harnessDir = mkdtempSync(join(tmpdir(), "admission-spawn-harness2-"));
  try {
    mkdirSync(isolatedCheckDir, { recursive: true });
    // Mirror the EXACT dependency closure the pre-existing mutation test
    // fixtures use (time-authority/reject-streak/envelope-archive) --
    // deliberately WITHOUT admission-completion-adapter.mjs, reproducing
    // the isolation shape that broke under the 1R static-import attempt.
    for (const name of [
      "relay-handshake.mjs",
      "time-authority.mjs",
      "reject-streak.mjs",
      "envelope-archive.mjs",
    ]) {
      writeFileSync(
        join(isolatedCheckDir, name),
        readFileSync(join(CHECK_DIR, name), "utf8"),
        "utf8",
      );
    }
    const isolatedRelayHandshakePath = join(
      isolatedCheckDir,
      "relay-handshake.mjs",
    );
    writeFixture(harnessDir, "HYK-SPAWN-2");

    const res = spawnSync(
      process.execPath,
      [isolatedRelayHandshakePath, "coder", harnessDir],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ADMISSION_LEDGER_PATH: join(isolatedDir, "nonexistent-ledger.json"),
        },
      },
    );
    assert.equal(
      res.status,
      0,
      `handshake should still pass even though the adapter file is missing: ${res.stderr}`,
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// HYK-224-3R §3 (REVIEW 2R 반려, 검토자 실측 정확히 재현): ADMISSION_LEDGER_PATH
// set to a path that will make the completion step genuinely fail (no
// init-cutover, ledger missing). Handshake itself must still exit 0 (§3
// 판단: round success != bookkeeping success), but stderr must now carry
// the REAL detail (not be empty) -- this is the exact defect the reviewer
// found ("handshake CLI는 exit 0이고 ... 세부 오류가 비어 있었다").
test("HYK-224-3R §3: a completion failure surfaces its real detail on relay-handshake's stderr (not empty), exit code still 0", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "admission-spawn-harness4-"));
  const ledgerDir = mkdtempSync(join(tmpdir(), "admission-spawn-ledger4-"));
  const ledger = join(ledgerDir, "nonexistent-ledger.json");
  try {
    writeFixture(harnessDir, "HYK-SPAWN-4");
    const result = runRelayHandshakeCli(harnessDir, {
      ADMISSION_LEDGER_PATH: ledger,
      ADMISSION_LOCK_PATH: join(ledgerDir, "l.lock"),
    });
    assert.equal(
      result.exit,
      0,
      "round success must not depend on completion bookkeeping",
    );
    assert.notEqual(
      result.stderr.trim(),
      "",
      "stderr must not be empty on a completion failure",
    );
    assert.match(result.stderr, /ENOENT|no such file|LEDGER_MISSING/i);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("relay-handshake CLI exits 0 normally when ADMISSION_LEDGER_PATH is unset (no-op baseline, unchanged behavior)", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "admission-spawn-harness3-"));
  try {
    writeFixture(harnessDir, "HYK-SPAWN-3");
    const env = { ...process.env };
    delete env.ADMISSION_LEDGER_PATH;
    delete env.ADMISSION_LOCK_PATH;
    const res = spawnSync(
      process.execPath,
      [RELAY_HANDSHAKE_PATH, "coder", harnessDir],
      { encoding: "utf8", env },
    );
    assert.equal(res.status, 0);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// HYK-225-5R §1 항 1 (REVIEW 반려: "result.ok=false일 때 스폰하지 않음"은
// 여태 직접 단언된 적이 없다 -- 위 4건은 전부 성공 경로만 다룬다). This
// pins relay-handshake.mjs:535-538's gate directly: `okTaskId` is computed
// from `result.ok ? match : undefined`, so when checkRelayHandshake returns
// ok:false (here: task file's task_id != result file's echoed task_id --
// the HYK-183 anti-forgery mismatch), spawnAdmissionCompletion must never
// run. Asserted OBSERVABLY (not by exit code alone, which is what the
// reviewer flagged as insufficient): the ledger already holds an ACTIVE
// reservation for the task's real id; if the spawn gate were broken (e.g.
// `if (okTaskId)` regressed to always-spawn), that reservation would flip
// to COMPLETED even though the handshake itself failed. It must stay
// ACTIVE.
test("HYK-225-5R §1-1: relay-handshake CLI does NOT spawn admission completion when result.ok=false (task_id mismatch), reservation stays ACTIVE", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "admission-spawn-harness5-"));
  const ledgerDir = mkdtempSync(join(tmpdir(), "admission-spawn-ledger5-"));
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const realTaskId = "HYK-SPAWN-5";
    // Task file declares realTaskId, but the result file echoes a
    // DIFFERENT task_id -- this is exactly the HYK-183 mismatch branch
    // (relay-handshake.mjs:420-425), which returns ok:false BEFORE the
    // function ever reaches its single ok:true return (line 465). No
    // legitimate "relay handshake ok for ..." reason is ever produced.
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      `task_id: ${realTaskId}\ndropped_at: 2026-08-11 06:00 KST\n`,
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "coder.md"),
      `task_id: HYK-SPAWN-WRONG\n\n>>> DONE: CODER @ 2026-08-11 06:10 KST\n`,
      "utf8",
    );

    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      realTaskId,
      "--cap",
      "1",
    ]);

    const result = runRelayHandshakeCli(harnessDir, {
      ADMISSION_LEDGER_PATH: ledger,
      ADMISSION_LOCK_PATH: lock,
    });
    assert.equal(
      result.exit,
      1,
      `handshake should fail on task_id mismatch: ${result.stderr}`,
    );
    assert.match(result.stderr, /handshake mismatch/);

    const ledgerContent = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      ledgerContent.reservations[realTaskId].status,
      "ACTIVE",
      "reservation must remain ACTIVE -- completion spawn must not have run when result.ok=false",
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// HYK-225-5R §1 항 2 -- checked and NOT added (검토자 반려 원문에 대한
// 정직한 응답, 억지 프로덕션 변경 금지 지침 준수):
// relay-handshake.mjs:535-538's second gate is
//   const okTaskId = result.ok
//     ? (result.reason.match(/relay handshake ok for (\S+)/) ?? [])[1]
//     : undefined;
// checkRelayHandshake has exactly ONE ok:true return site (line 465):
//   return { ok: true, reason: `relay handshake ok for ${taskId}` };
// where `taskId` itself was captured by TASK_ID_RE's `(\S+)` group (line
// 20/408) -- i.e. it is ALREADY guaranteed whitespace-free by construction.
// Interpolating a whitespace-free token into "relay handshake ok for X"
// and then re-extracting it with /relay handshake ok for (\S+)/ always
// matches and always yields back that exact same taskId. There is no
// legitimate task-file/result-file input that reaches the ok:true branch
// with a `reason` string the regex fails to parse -- the two are the same
// string by construction, not independently producible. Forcing this path
// would require either mutating relay-handshake.mjs's own ok:true return
// (production code -- out of §1's scope, coder-task.md §6 forbids it) or
// fabricating a `result.reason` the real function can never emit (which
// would test a fiction, not this code). Documented here instead of
// silently omitted, per coder-task.md §1 항 2's explicit "만들 수 없으면
// 사유를 대라" allowance.
