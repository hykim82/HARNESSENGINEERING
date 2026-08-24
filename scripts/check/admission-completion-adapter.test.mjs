import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  autoCompleteAdmission,
  completeAdmissionReservation,
} from "./admission-completion-adapter.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-completion-adapter-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

// HYK-279: "ADMISSION_LEDGER_PATH is unset" must mean neither resolution
// source is present -- not just the env var. admission-completion-adapter.mjs
// (HYK-227 2R) also falls back to a persistent pointer file at
// `<mainRepoRoot>/.harness/admission-ledger-path.json`, resolved via
// `git rev-parse --git-common-dir` off `process.cwd()`. Before this fix, this
// test deleted only the env var and ran with cwd left at this worktree's real
// path -- whose mainRepoRoot IS the shared main HARNESSENGINEERING checkout,
// which (실측: confirmed present on disk) has that pointer file installed,
// pointing at the REAL control-room ledger. So the test's own premise
// (attempted:false) was false in this environment: the adapter actually
// attempted a completion for the literal fixture id "HYK-000-x-1" against the
// real ledger (RESERVATION_NOT_FOUND) and durably appended that failure to
// the real `*.completion-failures.jsonl` -- exactly the ORCH-measured leak
// (coder-task.md §1) and this repo's one pre-existing baseline test failure.
// Fix: chdir into a synthetic, pointer-file-less git repo for the duration of
// the assertion (same pattern as
// admission-completion-persistent-source.test.mjs's ⓒ test), so mainRepoRoot()
// has nothing real to resolve to regardless of which worktree/machine this
// runs on.
function buildSyntheticRepoWithoutPointer() {
  const dir = mkdtempSync(join(tmpdir(), "hyk279-adapter-noop-repo-"));
  execSync("git init -q", { cwd: dir });
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

test("autoCompleteAdmission is a documented no-op (attempted:false) when ADMISSION_LEDGER_PATH is unset (honesty limit, not silent success)", () => {
  const saved = process.env.ADMISSION_LEDGER_PATH;
  const savedCwd = process.cwd();
  const repoDir = buildSyntheticRepoWithoutPointer();
  delete process.env.ADMISSION_LEDGER_PATH;
  process.chdir(repoDir);
  try {
    const outcome = autoCompleteAdmission({ reservationId: "HYK-000-x-1" });
    assert.deepEqual(outcome, { attempted: false });
  } finally {
    process.chdir(savedCwd);
    if (saved !== undefined) process.env.ADMISSION_LEDGER_PATH = saved;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("autoCompleteAdmission releases a real reservation when the env var is set (integration path relay-handshake.mjs uses)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
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
      "HYK-224-cap-admission-1",
      "--cap",
      "1",
    ]);

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-224-cap-admission-1",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true);

    // Slot is free again -- a fresh admit for the same cap succeeds.
    const readmitExit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-224-cap-admission-2",
      "--cap",
      "1",
    ]);
    assert.equal(readmitExit, 0);
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-342/HYK-249: `reason` is a NEW, optional field threaded straight
// through to completeReservation's own `completion_reason` stamp -- this
// pins the integration path relay-handshake.mjs's BLOCKED-termination side
// effects use (spawnAdmissionAbortProcess -> this adapter's CLI -> here).
test("autoCompleteAdmission with `reason` stamps completion_reason on the released reservation (BLOCKED-termination integration path)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
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
      "HYK-342-blocked-1",
      "--cap",
      "1",
    ]);

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-blocked-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true);

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-blocked-1"].completion_reason,
      "BLOCKED_TERMINATION_RELEASED",
    );
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeAdmissionReservation without `reason` leaves completion_reason unset (byte-identical to the pre-HYK-342 ok:true path)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
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
      "HYK-342-normal-1",
      "--cap",
      "1",
    ]);
    const outcome = completeAdmissionReservation({
      reservationId: "HYK-342-normal-1",
      ledgerPath: ledger,
      lockPath: lock,
    });
    assert.equal(outcome.ok, true);
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      "completion_reason" in written.reservations["HYK-342-normal-1"],
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeAdmissionReservation fails closed (ok:false) when the ledger path does not exist", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    const outcome = completeAdmissionReservation({
      reservationId: "ghost",
      ledgerPath: ledger,
      lockPath: lock,
    });
    assert.equal(outcome.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §3 (REVIEW 2R 반려, 검토자 실측): "잘못된 ledger로 adapter가
// 실패해도 ... 세부 오류가 비어 있었다". This pins that the failure
// `reason` string now actually CONTAINS the underlying detail (e.g. the
// real ENOENT message), not just a bare reasonCode.
test("HYK-224-3R §3: a completion failure's reason string contains the actual underlying detail, not just a bare reasonCode", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    const outcome = completeAdmissionReservation({
      reservationId: "ghost",
      ledgerPath: ledger,
      lockPath: lock,
    });
    assert.equal(outcome.ok, false);
    // Must be more than just the reasonCode token -- must contain SOME
    // actual detail text (the real fs error message), not "(no detail
    // available)" for a case where a detail genuinely exists.
    assert.match(outcome.reason, /ENOENT|no such file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §3 -- "최소 감사 기록": a completion failure durably appends a
// JSON line to `${ledgerPath}.completion-failures.jsonl`, independent of
// whatever happens to stdout/stderr.
test("HYK-224-3R §3: a completion failure is durably audit-logged (JSONL file next to the ledger), not just printed", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
    // No init-cutover -- ledger genuinely missing, guarantees a failure.
    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({ reservationId: "HYK-AUDIT-1" });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);

    const auditPath = `${ledger}.completion-failures.jsonl`;
    assert.ok(existsSync(auditPath), `audit file must exist: ${auditPath}`);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.reservationId, "HYK-AUDIT-1");
    assert.ok(record.reasonCode, "audit record must carry a reasonCode");
    assert.ok(record.reason, "audit record must carry the full reason text");
    assert.ok(record.at, "audit record must carry a timestamp");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-224-3R §3: a SUCCESSFUL completion does NOT write an audit-failure record", () => {
  const { dir, ledger, lock } = tmpPaths();
  const savedLedger = process.env.ADMISSION_LEDGER_PATH;
  const savedLock = process.env.ADMISSION_LOCK_PATH;
  try {
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
      "HYK-AUDIT-2",
      "--cap",
      "1",
    ]);
    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({ reservationId: "HYK-AUDIT-2" });
    assert.equal(outcome.ok, true);
    assert.equal(existsSync(`${ledger}.completion-failures.jsonl`), false);
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
