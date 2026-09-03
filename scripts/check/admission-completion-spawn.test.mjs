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
import { spawnSync, execFileSync } from "node:child_process";
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
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- carry the marker so
    // this shared fixture keeps exercising the admission-completion spawn
    // wiring under test, not this promotion's rejection.
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-11 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
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
// init-cutover, ledger missing).
//
// ⚠️HYK-344 2R/3R 갱신 (review-r1-verbatim.md §A P1 반려 -> 3R 채택):
// 이 시험의 원래 이름/문면은 "exit code still 0"이었다 -- 그 판단
// (round success != bookkeeping success) 자체는 3R 에서도 뒤집지 않았다
// (0/1의 의미는 그대로다), 하지만 검토자가 지적한 대로 그 결론을 실어
// 나르던 두 통로(stderr + 감사 JSONL) 중 감사 JSONL을 읽는 프로덕션
// 소비자가 0건이라 "자동 호출자가 성공으로 오인한다"는 핵심 결함이
// 남아 있었다. HYK-344 2R가 세 번째 값(exit 3)을 신설해 이 정확한
// 시나리오(완료가 실제로 시도됐는데 실패)를 0/1과 겹치지 않게 구별
// 가능한 값으로 만들었으므로, 이 시험의 기대값도 그 새 계약에 맞춰
// 갱신한다(⛔조용히 넘어가지 않는다 -- exit 0을 기대하는 옛 시험을
// 그대로 두면 정확히 이 회귀가 재발한다, HYK-344 3R §2-1 재현 실측).
test("HYK-224-3R §3 -> HYK-344 2R/3R: a completion failure surfaces its real detail on relay-handshake's stderr (not empty), exit code is now 3 (distinct from 0/1, not silently 0 anymore)", () => {
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
      3,
      "HYK-344 2R/3R: a genuinely-attempted-and-failed completion now exits 3 (distinct from 0=full success), not silently 0 -- round pass/fail (0/1) semantics themselves are unchanged",
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

// HYK-279: "ADMISSION_LEDGER_PATH is unset" must mean neither resolution
// source is present. relay-handshake.mjs's spawnAdmissionCompletion spawns
// admission-completion-adapter.mjs as ITS OWN child, which inherits this
// test's spawnSync `cwd` (defaulted here to the current process's cwd, i.e.
// this worktree) -- so admission-completion-adapter.mjs's mainRepoRoot()
// resolves the shared main HARNESSENGINEERING checkout, whose installed
// `.harness/admission-ledger-path.json` (실측: confirmed present on disk)
// points at the REAL control-room ledger. Deleting only the two env vars
// left that persistent-pointer fallback fully reachable -- this test's own
// "no-op baseline" fixture id ("HYK-SPAWN-3") was actually attempted (and
// failed: RESERVATION_NOT_FOUND) against the real ledger and durably
// appended to the real `*.completion-failures.jsonl` (실측: HYK-279 §1
// fingerprint check caught this exact leak on a full local sweep run).
// Fix: run the CLI with `cwd` pinned at a synthetic, pointer-file-less git
// repo (same pattern as admission-completion-persistent-source.test.mjs's
// buildSyntheticRepo/ⓒ test) so the grandchild's mainRepoRoot() has nothing
// real to resolve to, regardless of which worktree/machine runs this.
function buildSyntheticRepoWithoutPointer() {
  const dir = mkdtempSync(join(tmpdir(), "hyk279-spawn-noop-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

test("relay-handshake CLI exits 0 normally when ADMISSION_LEDGER_PATH is unset (no-op baseline, unchanged behavior)", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "admission-spawn-harness3-"));
  const repoDir = buildSyntheticRepoWithoutPointer();
  try {
    writeFixture(harnessDir, "HYK-SPAWN-3");
    const env = { ...process.env };
    delete env.ADMISSION_LEDGER_PATH;
    delete env.ADMISSION_LOCK_PATH;
    const res = spawnSync(
      process.execPath,
      [RELAY_HANDSHAKE_PATH, "coder", harnessDir],
      { encoding: "utf8", env, cwd: repoDir },
    );
    assert.equal(res.status, 0);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
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
