import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
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
//
// HYK-342 2R P1-1: BLOCKED_TERMINATION_RELEASED now requires corroborating
// evidence (a live `<role>.md` result file whose task_id echo matches the
// reservationId and carries a well-formed `>>> BLOCKED:`/`>>> NEEDS_INPUT:`
// marker) -- this test seeds that file (mirroring what a genuine relay-
// handshake.mjs BLOCKED round leaves behind) so it still exercises the
// success path, not just the (separately tested) forgery-rejection path.
// HYK-342 3R §0/§2: the reviewer's 2R attack showed the worker CAN write
// its own task_id + BLOCKED marker (both are worker-writable) -- so this
// test also seeds a real dispatch-receipts.jsonl entry for this exact
// role+reservationId (the one thing a worker cannot fabricate) to still
// exercise the genuine success path under the tightened 3R contract.
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
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-342-blocked-1\n\n>>> BLOCKED: 시험용 정지\n",
      "utf8",
    );
    const receiptPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ role: "CODER", harness_task_label: "HYK-342-blocked-1", dispatch_id: "ctx_test" })}\n`,
      "utf8",
    );

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-blocked-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
      harnessDir: dir,
      role: "CODER",
      receiptPath,
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true, outcome.reason);

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

// HYK-342 3R §0/§2 (검토자가 2R에서 재현한 우회로의 재현): the worker
// writes its OWN result file with a made-up task_id + a well-formed
// BLOCKED marker (both are worker-writable, per the corrected §0 trust
// boundary) and admits a matching reservation under that same fake id --
// but NO dispatch receipt exists for it (nobody ever really dispatched
// this "round"). The 2R contract (task_id echo + BLOCKED marker only)
// would have accepted this; the 3R receipt check must refuse it.
test("HYK-342 3R §2: a worker-forged task_id + worker-forged BLOCKED marker with NO matching dispatch receipt is refused (reviewer's 2R bypass, now blocked)", () => {
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
      "HYK-342-fake-result-1",
      "--cap",
      "1",
    ]);
    // ⛔워커가 자기 결과 파일에 지어낸 task_id + 지어낸 BLOCKED 표지를
    // 직접 쓴다(검토자 2R §1 항1 실측 그대로 재현).
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-342-fake-result-1\n\n>>> BLOCKED: forged by worker\n",
      "utf8",
    );
    // ⛔dispatch-receipts.jsonl은 아예 만들지 않는다 -- 이 task_id로 배달된
    // 적이 정말 없다(워커가 지어낸 것이므로).

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-fake-result-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
      harnessDir: dir,
      role: "CODER",
      receiptPath: join(dir, "dispatch-receipts.jsonl"), // 존재하지 않는 파일
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "BLOCKED_TERMINATION_EVIDENCE_MISSING");

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-fake-result-1"].status,
      "ACTIVE",
      "워커 자작 이름표+표지만으로는 자리를 반납받지 못해야 한다",
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

// HYK-342 2R P1-1 (검토자가 재현한 공격의 재현): a caller that invokes the
// adapter directly with BLOCKED_TERMINATION_RELEASED but NO corroborating
// live BLOCKED result file must be refused -- the reservation stays ACTIVE.
test("HYK-342 2R P1-1: autoCompleteAdmission with reason=BLOCKED_TERMINATION_RELEASED but no live BLOCKED result file is refused (reviewer's direct-adapter-call attack, now blocked)", () => {
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
      "HYK-342-forged-1",
      "--cap",
      "1",
    ]);
    // ⛔결과 파일을 전혀 만들지 않는다 -- 검토자가 재현한 공격 그대로
    // (증거 없이 어댑터를 직접 실행).

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-342-forged-1",
      reason: "BLOCKED_TERMINATION_RELEASED",
      harnessDir: dir,
      role: "CODER",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "BLOCKED_TERMINATION_EVIDENCE_MISSING");

    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-forged-1"].status,
      "ACTIVE",
      "위조 시도는 예약 상태를 조금도 바꾸지 못해야 한다",
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

// HYK-342 2R P1-1: an unknown/arbitrary reason string (not in the closed
// COMPLETION_REASON set) is refused outright -- closes the "비어 있지 않은
// 임의 문자열" half of the finding, independent of the evidence check.
test("HYK-342 2R P1-1: an unknown completion reason string is refused (closed enum, not arbitrary)", () => {
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
      "HYK-342-unknown-reason",
      "--cap",
      "1",
    ]);
    const outcome = completeAdmissionReservation({
      reservationId: "HYK-342-unknown-reason",
      ledgerPath: ledger,
      lockPath: lock,
      reason: "TOTALLY_MADE_UP_REASON",
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "UNKNOWN_COMPLETION_REASON");
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(
      written.reservations["HYK-342-unknown-reason"].status,
      "ACTIVE",
    );
  } finally {
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

// HYK-344 §1 (본체, ORCH 실측 2026-08-24 08:40): the GoLabel/Task key-drift
// repro -- a reservation is admitted under one key ('HYK-344-real-1', mirrors
// dispatch-worker.ps1's `$GoLabel`) but completion is attempted under a
// DIFFERENT key ('HYK-344-drifted-1', mirrors relay-handshake.mjs's own
// task_id-file-resolved `$Task` fallback). Pins that the adapter surfaces
// this as the distinct RESERVATION_KEY_MISMATCH reasonCode (not the bare
// RESERVATION_NOT_FOUND a truly-never-admitted round would get), names the
// real key it found, and durably records both in the audit JSONL.
test("HYK-344: a key-drift completion (reservation exists under a DIFFERENT key) surfaces RESERVATION_KEY_MISMATCH with the real key named, both in the returned reason and the durable audit record", () => {
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
      "HYK-344-real-1",
      "--cap",
      "1",
    ]);

    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({
      reservationId: "HYK-344-drifted-1",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RESERVATION_KEY_MISMATCH");
    assert.match(outcome.reason, /HYK-344-real-1/);
    assert.equal(outcome.candidates.length, 1);
    assert.equal(outcome.candidates[0].reservationId, "HYK-344-real-1");

    // The mismatched-against reservation itself must stay untouched/ACTIVE
    // -- a mismatch is a rejection, never a guessed completion.
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    assert.equal(written.reservations["HYK-344-real-1"].status, "ACTIVE");

    const auditPath = `${ledger}.completion-failures.jsonl`;
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.reservationId, "HYK-344-drifted-1");
    assert.equal(record.reasonCode, "RESERVATION_KEY_MISMATCH");
    assert.equal(record.candidates.length, 1);
    assert.equal(record.candidates[0].reservationId, "HYK-344-real-1");
  } finally {
    if (savedLedger !== undefined)
      process.env.ADMISSION_LEDGER_PATH = savedLedger;
    else delete process.env.ADMISSION_LEDGER_PATH;
    if (savedLock !== undefined) process.env.ADMISSION_LOCK_PATH = savedLock;
    else delete process.env.ADMISSION_LOCK_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-344 §1-3 항2: the genuinely-never-admitted case (an empty ledger, no
// candidates anywhere) must stay RESERVATION_NOT_FOUND -- distinct from the
// key-mismatch case above -- with an EMPTY candidates array, not a missing
// field (a caller/monitoring script must be able to tell "checked, found
// none" apart from "field absent, meaning unclear").
test("HYK-344: completion against a genuinely empty ledger (no reservation ever admitted) stays RESERVATION_NOT_FOUND with an empty candidates list", () => {
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
    process.env.ADMISSION_LEDGER_PATH = ledger;
    process.env.ADMISSION_LOCK_PATH = lock;
    const outcome = autoCompleteAdmission({ reservationId: "HYK-344-ghost-1" });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "RESERVATION_NOT_FOUND");
    assert.deepEqual(outcome.candidates, []);
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
