// HYK-244-receipt-wire-2a §4 -- checkRelayHandshake의 ok:true 분기가 실제로
// 소비 완료 영수증을 "생산"하는지(§2 조각2), 그리고 필수 후속효과가 하나라도
// 실패하면 «성공 영수증»을 만들지 않는지(§2 조각2 비타협)를 실제 wiring을
// 통해 확인한다. relay-handshake-completion-wire.test.mjs의 admission-ledger
// 픽스처 패턴(ⓐⓑⓒⓓ)을 그대로 재사용한다 -- 같은 admissionReturned 신호가
// 이 영수증 축의 필수 효과 중 하나이기도 하기 때문이다.
//
// ⛔ 실제 관제실 정본 원장에는 절대 쓰지 않는다 -- 모든 원장은 mkdtemp
// 합성 픽스처다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import {
  checkConsumptionReceipt,
  CONSUMPTION_RECEIPT_STATE,
} from "./consumption-receipt-core.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFixture(
  harnessDir,
  role,
  taskId,
  droppedAt,
  doneAt,
  extraTask = "",
) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n${extraTask}`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- this file's own
    // subject is the consumption-receipt wiring, not the marker gate, so
    // carry the marker to reach that axis unmasked.
    `task_id: ${taskId}\n\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function initAndAdmit(ledger, lock, reservationId) {
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
    reservationId,
    "--cap",
    "1",
  ]);
}

function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

function receiptsIn(harnessDir) {
  try {
    return readdirSync(join(harnessDir, "receipts"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// §4-3: 소비 성공 시 영수증이 실제로 생성되고, 필드가 전부 들어 있다.
// §4-5: 그 영수증이 1R 코어에 그대로 먹혀 PASS가 나온다.
// ---------------------------------------------------------------------------

test("§4-3/§4-5: checkRelayHandshake ok:true (모든 후속효과 성공) -> 실제로 receipts/coder-receipt-r1.json이 생성되고, 그 파일이 1R 코어에서 PASS로 판정된다", () => {
  const harnessDir = tmpDir("hyk244-wire-a-harness-");
  const ledgerDir = tmpDir("hyk244-wire-a-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-244-WIRE-A-1";
    initAndAdmit(ledger, lock, taskId);
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-01 07:00 KST",
      "2026-08-01 07:10:05 KST",
    );

    const result = withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () =>
        checkRelayHandshake({
          role: "coder",
          harnessDir,
          dispatchId: "ctx_hyk244_wire_a",
        }),
    );
    assert.equal(result.ok, true, "precondition: handshake itself succeeded");

    const files = receiptsIn(harnessDir);
    assert.deepEqual(files, ["coder-receipt-r1.json"]);

    const candidate = JSON.parse(
      readFileSync(
        join(harnessDir, "receipts", "coder-receipt-r1.json"),
        "utf8",
      ),
    );
    assert.equal(candidate.binding.taskId, taskId);
    // HYK-269: binding.role은 정본 대문자로 굳는다(dispatch-gate-decision의
    // currentBinding.role과 정확히 같은 정규화) -- 파일명(coder-receipt-
    // r1.json)은 소문자 그대로다(위 files 단언 참조), 결속 기록만 대문자.
    assert.equal(candidate.binding.role, "CODER");
    assert.equal(candidate.binding.droppedAt, "2026-08-01 07:00 KST");
    assert.equal(candidate.binding.doneAt, "2026-08-01 07:10:05 KST");
    assert.equal(candidate.binding.dispatchId, "ctx_hyk244_wire_a");
    assert.equal(typeof candidate.binding.resultFingerprint, "string");
    assert.equal(
      candidate.binding.resultFingerprint.length,
      64,
      "sha256 hex is 64 chars",
    );
    assert.deepEqual(candidate.effects, {
      envelopeArchived: true,
      taskArchived: true,
      admissionReturned: true,
    });

    // §4-5: 실제로 코어에 넣어 PASS가 나오는 것으로 증명한다.
    const verdict = checkConsumptionReceipt({
      role: "coder",
      currentBinding: candidate.binding,
      candidates: [candidate],
    });
    assert.equal(verdict.state, CONSUMPTION_RECEIPT_STATE.PASS);
    assert.equal(verdict.ok, true);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §4-4 비타협: 후속효과 하나라도 실패하면 성공 영수증이 생기지 않는다.
// 표적 1 -- admissionReturned 실패(ADMISSION_LEDGER_PATH 미설정, 실제
// 생산 관례에서 가장 흔한 미설정 형태를 그대로 재현).
// ---------------------------------------------------------------------------

// HYK-279: "ADMISSION_LEDGER_PATH가 없으면" must mean neither resolution
// source is present. checkRelayHandshake spawns admission-completion-adapter.mjs
// as a child process that inherits process.env AND process.cwd() -- deleting
// only the env var, with cwd left at this worktree's real path, lets that
// child's mainRepoRoot() resolve the shared main repo's real, installed
// `.harness/admission-ledger-path.json` (실측: confirmed present on disk,
// pointing at the real control-room ledger), so the "미설정" premise this
// test's name asserts was false in this environment -- the adapter actually
// attempted (and failed: RESERVATION_NOT_FOUND) against the REAL ledger,
// exactly contradicting this file's own header ("실제 관제실 정본 원장에는
// 절대 쓰지 않는다") and matching the ORCH-measured leak (coder-task.md §1).
// Fix: chdir into a synthetic, pointer-file-less git repo for the duration
// of the call (same pattern as
// admission-completion-persistent-source.test.mjs's ⓒ test) so the spawned
// child's mainRepoRoot() has nothing real to resolve to.
function buildSyntheticRepoWithoutPointer() {
  const dir = mkdtempSync(join(tmpdir(), "hyk279-receipt-wire-b-repo-"));
  execSync("git init -q", { cwd: dir });
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

test("§4-4 (표적: admissionReturned 실패): ADMISSION_LEDGER_PATH가 없으면 handshake는 여전히 ok:true지만 영수증은 생성되지 않는다", () => {
  const harnessDir = tmpDir("hyk244-wire-b-harness-");
  const repoDir = buildSyntheticRepoWithoutPointer();
  try {
    const taskId = "HYK-244-WIRE-B-1";
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-01 07:00 KST",
      "2026-08-01 07:10:05 KST",
    );

    const savedLedger = process.env.ADMISSION_LEDGER_PATH;
    const savedCwd = process.cwd();
    delete process.env.ADMISSION_LEDGER_PATH;
    process.chdir(repoDir);
    let result;
    try {
      result = checkRelayHandshake({ role: "coder", harnessDir });
    } finally {
      process.chdir(savedCwd);
      if (savedLedger !== undefined)
        process.env.ADMISSION_LEDGER_PATH = savedLedger;
    }

    assert.equal(
      result.ok,
      true,
      "핸드셰이크 자신의 판정(ok:true)은 §3 금지 그대로 변경되지 않는다 -- 이 시험이 증명하는 것은 영수증 축뿐이다",
    );
    assert.deepEqual(
      receiptsIn(harnessDir),
      [],
      "admissionReturned가 실패했으므로 «성공 영수증»은 만들어지지 않는다",
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §4-4 표적 2 -- REVIEW 계열에서 ledgerRecorded 실패(판정 줄이 없어
// recordRejectStreakFromResultText가 attempted:true인데 ok:false가 되는
// 경우, isReviewFamilyRole만 true이고 실제 기록은 실패하는 시나리오).
// ---------------------------------------------------------------------------

test("§4-4 (표적: REVIEW ledgerRecorded 실패): verdict 줄이 없는 REVIEW 결과는 handshake ok:true라도 영수증이 생성되지 않는다", () => {
  const harnessDir = tmpDir("hyk244-wire-c-harness-");
  const ledgerDir = tmpDir("hyk244-wire-c-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-244-WIRE-C-1";
    initAndAdmit(ledger, lock, taskId);
    mkdirSync(harnessDir, { recursive: true });
    // HYK-383: REVIEW 계열 소비는 head_commit: 축(축 ⓐ+ⓑ)도 통과해야 한다
    // -- 축 ⓑ가 harnessDir에서 `git rev-parse HEAD`를 직접 읽으므로,
    // harnessDir 자신을 진짜 git 저장소로 만들고 그 실제 HEAD를 양쪽
    // 표지에 적어 넣는다.
    execSync("git init -q", { cwd: harnessDir });
    execSync('git config user.email "test@example.invalid"', {
      cwd: harnessDir,
    });
    execSync('git config user.name "test"', { cwd: harnessDir });
    execSync('git commit -q --allow-empty -m "wire-c fixture"', {
      cwd: harnessDir,
    });
    const headCommit = execSync("git rev-parse HEAD", {
      cwd: harnessDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(harnessDir, "review-task.md"),
      `task_id: ${taskId}\ndropped_at: 2026-08-01 09:00 KST\nhead_commit: ${headCommit}\n`,
      "utf8",
    );
    // ⛔ verdict: 줄이 의도적으로 없다 -- recordRejectStreakFromResultText가
    // attempted:true, ok:false로 떨어지는 REVIEW 계열 입력.
    writeFileSync(
      join(harnessDir, "review.md"),
      `task_id: ${taskId}\nhead_commit: ${headCommit}\n\nno verdict line here\n\n>>> DONE: REVIEW @ 2026-08-01 09:12:41 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );

    const result = withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () => checkRelayHandshake({ role: "review", harnessDir }),
    );
    assert.equal(
      result.ok,
      true,
      "precondition: handshake itself still succeeded",
    );
    assert.deepEqual(
      receiptsIn(harnessDir),
      [],
      "ledgerRecorded가 REVIEW 계열의 필수 효과인데 실패했으므로 영수증이 생기지 않는다",
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// dispatchId ⛔호출자가 명시적으로 넘긴 값만 쓴다 -- 넘어오지 않으면
// 지어내지 않고 그 사실이 영수증에 드러난다.
// ---------------------------------------------------------------------------

test("dispatchId 미전달: 넘어오지 않으면 binding에 그대로 없다 (지어내지 않는다, JSON 직렬화에서 undefined 키는 생략됨)", () => {
  const harnessDir = tmpDir("hyk244-wire-d-harness-");
  const ledgerDir = tmpDir("hyk244-wire-d-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-244-WIRE-D-1";
    initAndAdmit(ledger, lock, taskId);
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-01 07:00 KST",
      "2026-08-01 07:10:05 KST",
    );

    const result = withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () => checkRelayHandshake({ role: "coder", harnessDir }), // dispatchId 생략
    );
    assert.equal(result.ok, true);

    const candidate = JSON.parse(
      readFileSync(
        join(harnessDir, "receipts", "coder-receipt-r1.json"),
        "utf8",
      ),
    );
    assert.equal(
      Object.hasOwn(candidate.binding, "dispatchId"),
      false,
      "dispatchId가 안 넘어왔으면 지어내지 않는다 -- JSON에 키 자체가 없다(undefined)",
    );

    // 이 영수증은 dispatchId가 없어 1R 코어의 checkBindingPreconditions에서
    // «주 열쇠 미확정»으로 거부된다 -- 2R-b가 결선하기 전까지는 PASS가 나올
    // 수 없다는 것을 다시 확인한다(정직 한계 그대로).
    const verdict = checkConsumptionReceipt({
      role: "coder",
      currentBinding: candidate.binding,
      candidates: [candidate],
    });
    assert.equal(verdict.state, CONSUMPTION_RECEIPT_STATE.BINDING_MISMATCH);
    assert.match(verdict.reason, /배달 식별자/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
