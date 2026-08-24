// HYK-342/HYK-249 §3/§4 -- 「이름표는 VALID인데(정지 라운드는 task_id를
// 정상적으로 쓴다) doneAt이 없어 정상 소비 경로로는 절대 통과할 수 없는
// 라운드」를 중단 기록 축으로 소비 완료 인정하는 결선(evaluateConsumptionDecision
// 의 maybeResolveAbortRecordForValidLabel 호출)과, 「직전 결과 파일이 없으면
// 무조건 부트스트랩으로 접던」옆문(R4)의 수리를 배달 게이트 진입점
// (dispatch-gate-decision.mjs)에서 증명한다.
//
// dispatch-gate-abort-wire.test.mjs와 같은 구조(§A GREEN/§B 위조 3형태/RED
// 변이)를 따르되, 그 파일이 이미 고정한 MISSING-label 축은 건드리지 않는다
// -- 여기는 VALID-label 축(§3 신설)과 R4(§4 요구6)만 다룬다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import { writeAbortRecord } from "./abort-record-writer.mjs";
import {
  createEmptyLedger,
  admitReservation,
  completeReservation,
} from "../supervisor/admission-ledger-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");
const CORE_PATH = join(HERE, "dispatch-gate-decision-core.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const REJECT_STREAK_CHAIN_PATH = join(HERE, "reject-streak-chain.mjs");
const CONSUMPTION_RECEIPT_CORE_PATH = join(
  HERE,
  "consumption-receipt-core.mjs",
);
const DROPPED_AT_STAMP_CORE_PATH = join(HERE, "dropped-at-stamp-core.mjs");
const ABORT_RECORD_CORE_PATH = join(HERE, "abort-record-core.mjs");
const RETIREMENT_RECORD_CORE_PATH = join(HERE, "retirement-record-core.mjs");
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-blocked-term-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(scriptPath, args) {
  const result = spawnSync("node", [scriptPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function computeFingerprint(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeDispatchReceiptLine(
  path,
  { role, harnessTaskLabel, dispatchId },
) {
  const record = {
    recorded_at: new Date().toISOString(),
    runtime_task_id: `task_${Math.random().toString(16).slice(2, 14)}`,
    dispatch_id: dispatchId,
    role,
    harness_task_label: harnessTaskLabel,
  };
  writeFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

function writeNextTaskFile(dir, role, nextTaskId, nextDroppedAt) {
  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${nextTaskId}\ndropped_at: ${nextDroppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
  return taskPath;
}

// admission-ledger-core.mjs의 실물 함수(admitReservation ->
// completeReservation with reason)를 그대로 돌려 BLOCKED_TERMINATION_RELEASED
// 표식을 진짜로 만든다(합성 JSON을 손으로 짜지 않는다 -- dispatch-gate-
// abort-wire.test.mjs의 buildRealRecoveredLedger와 동일 원칙, 다만 이 축은
// sweep 타임아웃이 아니라 relay-handshake.mjs의 즉시 명시적 release다).
function buildRealBlockedTerminationLedger(harnessTaskLabel, role) {
  let ledger = createEmptyLedger("2026-08-24T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: harnessTaskLabel,
    cap: 1,
    now: "2026-08-24T00:00:00.000Z",
    role,
    seatKey: "seat-blocked",
  });
  assert.equal(admit.decision, "ADMITTED");
  ledger = admit.ledger;
  const completed = completeReservation(ledger, {
    reservationId: harnessTaskLabel,
    now: "2026-08-24T00:00:05.000Z",
    reason: "BLOCKED_TERMINATION_RELEASED",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.changed, true);
  return completed.ledger;
}

// VALID-label BLOCKED-termination 라운드 픽스처: task_id 줄은 정상(VALID),
// >>> DONE 줄은 없다(정상 소비 경로로는 doneAt 결손으로 영원히 REJECT).
function buildValidLabelBlockedFixture(dir) {
  const role = "coder";
  const harnessTaskLabel = "HYK-9300-blocked-term-round";
  const dispatchId = "ctx_test_blocked_term_1";
  const resultContent = `task_id: ${harnessTaskLabel}\n\n>>> BLOCKED: 합성 시험 -- 전제 미성립으로 중단\n`;
  writeFileSync(join(dir, `${role}.md`), resultContent, "utf8");

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: "CODER",
    harnessTaskLabel,
    dispatchId,
  });

  const taskPath = writeNextTaskFile(
    dir,
    role,
    "HYK-9300-blocked-term-round-next",
    "2026-08-24 10:00:00 KST",
  );

  const ledgerPath = join(dir, "admission-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify(
      buildRealBlockedTerminationLedger(harnessTaskLabel, "CODER"),
    ) + "\n",
    "utf8",
  );

  const streakLedgerPath = join(dir, "reject-streak.json");
  writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

  return {
    role,
    dir,
    taskPath,
    dispatchReceiptPath,
    ledgerPath,
    streakLedgerPath,
    harnessTaskLabel,
    dispatchId,
    resultContent,
  };
}

function runGate(fixture, extraArgs = []) {
  return runCli(SCRIPT_PATH, [
    fixture.taskPath,
    "--ledger",
    fixture.streakLedgerPath,
    "--dispatch-receipt-path",
    fixture.dispatchReceiptPath,
    "--admission-ledger-path",
    fixture.ledgerPath,
    ...extraArgs,
  ]);
}

// ---------------------------------------------------------------------------
// §A -- GREEN: VALID 라벨 + 검증 가능한 중단 기록(지문·dispatchId·회수표식
// 셋 다 실물) -> 다음 배달 ALLOW. doneAt은 여전히 비어 있다(완화하지
// 않는다, §4 요구1).
// ---------------------------------------------------------------------------

test("§A GREEN: VALID 라벨 BLOCKED-termination 라운드 + 검증 가능한 중단 기록 -> 다음 배달 ALLOW, doneAt은 여전히 없다", () => {
  withFixtureDir((dir) => {
    const fixture = buildValidLabelBlockedFixture(dir);
    const write = writeAbortRecord({
      role: "CODER",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      dispatchId: fixture.dispatchId,
      droppedAt: "2026-08-24 09:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.resultContent),
      leftoverPath: "coder.md",
      recordedAt: "2026-08-24 10:00:05 KST",
      evidence: {
        source: "relay-handshake-blocked-termination",
        state: "BLOCKED",
      },
    });
    assert.equal(write.ok, true);

    const r = runGate(fixture);
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout + r.stderr, /ALLOW/);

    // ★시험이 결과 파일을 되읽어 doneAt이 없음을 직접 단언한다(§4 요구1).
    const liveResult = readFileSync(join(fixture.dir, "coder.md"), "utf8");
    assert.equal(/^>>>\s*DONE:/im.test(liveResult), false);
  });
});

// ---------------------------------------------------------------------------
// §B -- 위조 3형태, 각각 단독으로도 여전히 거부.
// ---------------------------------------------------------------------------

test("§B-1 REJECT: 지문이 라이브 결과 파일과 다른 중단 기록 -> NO_RECORD로 물러나 원래 REJECT 유지", () => {
  withFixtureDir((dir) => {
    const fixture = buildValidLabelBlockedFixture(dir);
    writeAbortRecord({
      role: "CODER",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      dispatchId: fixture.dispatchId,
      droppedAt: "2026-08-24 09:00:00 KST",
      leftoverFingerprint: "0".repeat(64),
      leftoverPath: "coder.md",
      recordedAt: "2026-08-24 10:00:05 KST",
      evidence: {},
    });
    const r = runGate(fixture);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /REJECT/);
  });
});

test("§B-2 REJECT: dispatchId가 배달 영수증과 다른(위조) 중단 기록 -> DISPATCH_ID_UNVERIFIED로 거부", () => {
  withFixtureDir((dir) => {
    const fixture = buildValidLabelBlockedFixture(dir);
    writeAbortRecord({
      role: "CODER",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      dispatchId: "ctx_forged_not_in_receipts",
      droppedAt: "2026-08-24 09:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.resultContent),
      leftoverPath: "coder.md",
      recordedAt: "2026-08-24 10:00:05 KST",
      evidence: {},
    });
    const r = runGate(fixture);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /DISPATCH_ID_UNVERIFIED|REJECT/);
  });
});

test("§B-3 REJECT: 원장에 회수 표식이 없는(아직 ACTIVE인) 중단 기록 -> RECOVERY_MARKER_MISSING으로 거부", () => {
  withFixtureDir((dir) => {
    const fixture = buildValidLabelBlockedFixture(dir);
    // ACTIVE 상태 그대로인 원장으로 덮어쓴다(회수 표식 없음).
    let ledger = createEmptyLedger("2026-08-24T00:00:00.000Z");
    const admit = admitReservation(ledger, {
      reservationId: fixture.harnessTaskLabel,
      cap: 1,
      now: "2026-08-24T00:00:00.000Z",
      role: "CODER",
      seatKey: "seat-still-active",
    });
    writeFileSync(
      fixture.ledgerPath,
      JSON.stringify(admit.ledger) + "\n",
      "utf8",
    );

    writeAbortRecord({
      role: "CODER",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      dispatchId: fixture.dispatchId,
      droppedAt: "2026-08-24 09:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.resultContent),
      leftoverPath: "coder.md",
      recordedAt: "2026-08-24 10:00:05 KST",
      evidence: {},
    });
    const r = runGate(fixture);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /RECOVERY_MARKER_MISSING|REJECT/);
  });
});

// ---------------------------------------------------------------------------
// §C -- HYK-342 §4 요구6(1R) -> 2R P1-2 -> 3R §0/§3: 결과 파일 없음을
// "진짜 첫 배달" · "정당한 재배달/재시도" · "증거가 사라진 것" 셋으로
// 가른다. 3R부터는 워크트리 안(`.harness/rounds/`)을 더 이상 증거로 쓰지
// 않는다(§0 신뢰 경계 -- 워커가 쓸 수 있는 자리다) -- 오직 배달 영수증
// (dispatch-receipts.jsonl)과 admission 원장(ACTIVE 여부)만 본다. 3R §3
// "합격 기준에 반드시 포함할 경우들" 4건을 그대로 시험 이름에 매핑한다.
// ---------------------------------------------------------------------------

// admission-ledger-core.mjs의 실물 함수(admitReservation)를 그대로 돌려
// ACTIVE 원장을 만든다 -- 합성 JSON을 손으로 짜지 않는다(이 파일의 §A
// buildRealBlockedTerminationLedger와 동일 원칙).
function buildActiveLedger(taskId, role) {
  const ledger = createEmptyLedger("2026-08-24T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: taskId,
    cap: 1,
    now: "2026-08-24T00:00:00.000Z",
    role,
    seatKey: "seat-in-flight",
  });
  assert.equal(admit.decision, "ADMITTED");
  return admit.ledger;
}

// 위 ACTIVE 원장을 completeReservation(정상 완료 경로, reason 없음)으로
// 한 번 더 진행시켜 COMPLETED 원장을 만든다 -- "라운드가 끝났고 자리도
// 반납됐는데 결과 파일만 사라진" 시나리오의 실물 재현.
function buildCompletedLedger(taskId, role) {
  const active = buildActiveLedger(taskId, role);
  const completed = completeReservation(active, {
    reservationId: taskId,
    now: "2026-08-24T00:05:00.000Z",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.changed, true);
  return completed.ledger;
}

test("§C-1 ALLOW (3R §3 요구1 -- 진짜 첫 배달): 영수증도 원장 항목도 전혀 없으면 부트스트랩으로 통과한다", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskPath = writeNextTaskFile(
      dir,
      role,
      "HYK-9302-genuine-bootstrap",
      "2026-08-24 08:00:00 KST",
    );
    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    const r = runCli(SCRIPT_PATH, [taskPath, "--ledger", streakLedgerPath]);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout + r.stderr, /ALLOW/);
  });
});

test("§C-2 ALLOW (3R §3 요구2 -- 정당한 재배달/재시도): 영수증은 있고 결과는 없지만 원장이 아직 ACTIVE로 안다", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9303-retry-in-flight";
    const taskPath = writeNextTaskFile(
      dir,
      role,
      taskId,
      "2026-08-24 08:00:00 KST",
    );
    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: taskId,
      dispatchId: "ctx_retry",
    });
    const ledgerPath = join(dir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify(buildActiveLedger(taskId, "CODER")) + "\n",
      "utf8",
    );
    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      streakLedgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
      "--admission-ledger-path",
      ledgerPath,
    ]);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout + r.stderr, /ALLOW/);
  });
});

test("§C-3 REJECT (3R §3 요구3 -- 증거 삭제): 영수증은 있는데 원장이 COMPLETED(더 이상 ACTIVE 아님)이고 결과가 없다", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9304-evidence-deleted";
    const taskPath = writeNextTaskFile(
      dir,
      role,
      taskId,
      "2026-08-24 08:00:00 KST",
    );
    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: taskId,
      dispatchId: "ctx_deleted",
    });
    const ledgerPath = join(dir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify(buildCompletedLedger(taskId, "CODER")) + "\n",
      "utf8",
    );
    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      streakLedgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
      "--admission-ledger-path",
      ledgerPath,
    ]);
    assert.notEqual(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(
      r.stdout + r.stderr,
      /REJECT_RESULT_EVIDENCE_MISSING|증거가 사라진/,
    );
  });
});

test("§C-4 ALLOW (3R §3 요구4 -- 여러 라운드가 오간 뒤의 정당한 재배달): 워크트리에 과거 아카이브가 쌓여 있어도, 이번 taskId의 영수증+ACTIVE 원장만으로 통과한다", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    // 과거에 이 role이 이미 여러 번 완료된 흔적(워크트리 «안», 3R부터는
    // 이 판정에 관여하지 않아야 한다는 것 자체를 증명하는 자리).
    mkdirSync(join(dir, "rounds"), { recursive: true });
    writeFileSync(
      join(dir, "rounds", `${role}-r1.md`),
      "task_id: HYK-9305-old-1\n>>> DONE: CODER @ 2026-08-24 06:00:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "rounds", `${role}-r2.md`),
      "task_id: HYK-9305-old-2\n>>> DONE: CODER @ 2026-08-24 07:00:00 KST\n",
      "utf8",
    );
    const taskId = "HYK-9305-new-redelivery";
    const taskPath = writeNextTaskFile(
      dir,
      role,
      taskId,
      "2026-08-24 08:00:00 KST",
    );
    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: taskId,
      dispatchId: "ctx_redelivery",
    });
    const ledgerPath = join(dir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify(buildActiveLedger(taskId, "CODER")) + "\n",
      "utf8",
    );
    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      streakLedgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
      "--admission-ledger-path",
      ledgerPath,
    ]);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout + r.stderr, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// RED(변이, 필수, §5) -- 새로 넣은 분기를 일부러 뒤집어 GREEN 입력이 다시
// 원래 결함(영구 REJECT / 옆문 재개방)으로 새는지 확인하고 즉시 원복.
// ---------------------------------------------------------------------------

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
}

function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "dispatch-gate-decision.mjs": readFileSync(SCRIPT_PATH, "utf8"),
    "dispatch-gate-decision-core.mjs": readFileSync(CORE_PATH, "utf8"),
    "reject-streak.mjs": readFileSync(REJECT_STREAK_PATH, "utf8"),
    "reject-streak-chain.mjs": readFileSync(REJECT_STREAK_CHAIN_PATH, "utf8"),
    "consumption-receipt-core.mjs": readFileSync(
      CONSUMPTION_RECEIPT_CORE_PATH,
      "utf8",
    ),
    "dropped-at-stamp-core.mjs": readFileSync(
      DROPPED_AT_STAMP_CORE_PATH,
      "utf8",
    ),
    "abort-record-core.mjs": readFileSync(ABORT_RECORD_CORE_PATH, "utf8"),
    "retirement-record-core.mjs": readFileSync(
      RETIREMENT_RECORD_CORE_PATH,
      "utf8",
    ),
    "envelope-archive.mjs": readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

test("RED(변이, 필수): validAbortOutcome.done 단락을 제거하면 §A의 GREEN 입력이 다시 영원히 REJECT로 샌다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "  if (validAbortOutcome.done) return validAbortOutcome.result;\n";
  assertExactlyOneMatch(src, target, "validAbortOutcome.done short-circuit");
  const mutated = src.replace(target, "");

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-blocked-term-mut-a-"),
    );
    try {
      const fixture = buildValidLabelBlockedFixture(fixtureDir);
      writeAbortRecord({
        role: "CODER",
        harnessDir: fixture.dir,
        harnessTaskLabel: fixture.harnessTaskLabel,
        dispatchId: fixture.dispatchId,
        droppedAt: "2026-08-24 09:00:00 KST",
        leftoverFingerprint: computeFingerprint(fixture.resultContent),
        leftoverPath: "coder.md",
        recordedAt: "2026-08-24 10:00:05 KST",
        evidence: {},
      });
      const r = runCli(mutantPath, [
        fixture.taskPath,
        "--ledger",
        fixture.streakLedgerPath,
        "--dispatch-receipt-path",
        fixture.dispatchReceiptPath,
        "--admission-ledger-path",
        fixture.ledgerPath,
      ]);
      assert.notEqual(
        r.status,
        0,
        "RED: 단락을 제거하면 §A의 ALLOW가 사라져야 한다 -- 이 축이 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  const srcAfter = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(
    srcAfter,
    src,
    "원본 dispatch-gate-decision.mjs는 이 시험 전후 바이트 동일해야 한다(변이는 격리 tmpdir 사본에만 적용됐다)",
  );
});

test("RED(변이, 필수, HYK-342 3R §3): isReservationActiveForRound을 항상 true로 되돌리면(원장을 안 본 척하면) §C-3(증거 삭제)이 다시 조용히 ALLOW된다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    '  return ledger?.reservations?.[taskId]?.status === "ACTIVE";\n}';
  assertExactlyOneMatch(src, target, "isReservationActiveForRound 판정 줄");
  const mutated = src.replace(
    target,
    "  return true; // MUTATED: 원장을 안 본 척 -- 항상 ACTIVE로 취급\n}",
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-blocked-term-mut-c3-"),
    );
    try {
      const role = "coder";
      const taskId = "HYK-9306-mut-c3";
      const taskPath = writeNextTaskFile(
        fixtureDir,
        role,
        taskId,
        "2026-08-24 08:00:00 KST",
      );
      const dispatchReceiptPath = join(fixtureDir, "dispatch-receipts.jsonl");
      writeDispatchReceiptLine(dispatchReceiptPath, {
        role: "CODER",
        harnessTaskLabel: taskId,
        dispatchId: "ctx_mut_c3",
      });
      const ledgerPath = join(fixtureDir, "admission-ledger.json");
      writeFileSync(
        ledgerPath,
        JSON.stringify(buildCompletedLedger(taskId, "CODER")) + "\n",
        "utf8",
      );
      const streakLedgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

      // ⛔결과 파일을 만들지 않는다 -- 원장은 COMPLETED인데(진짜 증거
      // 삭제) 변이가 "항상 ACTIVE"로 거짓 보고하면 다시 통과해야 RED다.
      const r = runCli(mutantPath, [
        taskPath,
        "--ledger",
        streakLedgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
        "--admission-ledger-path",
        ledgerPath,
      ]);
      assert.equal(
        r.status,
        0,
        "RED: 원장 ACTIVE 판별을 무시하면 증거 삭제(COMPLETED)도 다시 ALLOW로 새야 한다 -- 이 판별이 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  const srcAfter = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(
    srcAfter,
    src,
    "원본 dispatch-gate-decision.mjs는 이 시험 전후 바이트 동일해야 한다",
  );
});

// ---------------------------------------------------------------------------
// RED(변이, 필수, HYK-342 2R P1-2 -> 3R §3): 검토자가 재현한 «결과 파일 +
// (당시 rounds/) 함께 삭제» 공격이 dispatch-receipts.jsonl 앵커(hasReceipt)
// 없이는 다시 뚫리는 것을 확인한다 -- 영수증 존재 판별 자체를 빼면(항상
// "영수증 없음"으로 취급하면) 진짜 첫 배달과 증거-삭제를 더 이상 구분하지
// 못해 §C-3(증거 삭제)이 조용히 ALLOW로 샌다(부트스트랩 분기로 잘못
// 떨어진다).
// ---------------------------------------------------------------------------

test("RED(변이, 필수, HYK-342 2R P1-2 -> 3R §3): hasReceipt 판별을 빼면(항상 false) 증거 삭제도 부트스트랩으로 오인돼 다시 ALLOW로 샌다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target = "  if (!hasReceipt) {\n";
  assertExactlyOneMatch(src, target, "hasReceipt 부트스트랩 분기 진입");
  const mutated = src.replace(
    target,
    "  if (!hasReceipt || true) {\n    // MUTATED: hasReceipt 판별 무력화(항상 부트스트랩으로 접음)\n",
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-blocked-term-mut-p12-"),
    );
    try {
      const role = "coder";
      const taskId = "HYK-9304-p12-mut";
      const taskPath = writeNextTaskFile(
        fixtureDir,
        role,
        taskId,
        "2026-08-24 08:00:00 KST",
      );
      const dispatchReceiptPath = join(fixtureDir, "dispatch-receipts.jsonl");
      writeDispatchReceiptLine(dispatchReceiptPath, {
        role: "CODER",
        harnessTaskLabel: taskId,
        dispatchId: "ctx_p12_mut",
      });
      const ledgerPath = join(fixtureDir, "admission-ledger.json");
      writeFileSync(
        ledgerPath,
        JSON.stringify(buildCompletedLedger(taskId, "CODER")) + "\n",
        "utf8",
      );
      const streakLedgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

      // ⛔결과 파일을 만들지 않는다 -- 영수증+COMPLETED 원장은 "증거 삭제"
      // 여야 하는데, hasReceipt가 무력화되면 부트스트랩으로 오인해
      // ALLOW로 새야 RED다.
      const r = runCli(mutantPath, [
        taskPath,
        "--ledger",
        streakLedgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
        "--admission-ledger-path",
        ledgerPath,
      ]);
      assert.equal(
        r.status,
        0,
        "RED: hasReceipt 판별이 무력화되면 증거 삭제도 부트스트랩으로 오인해 ALLOW로 새야 한다 -- 이 판별이 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  const srcAfter = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(
    srcAfter,
    src,
    "원본 dispatch-gate-decision.mjs는 이 시험 전후 바이트 동일해야 한다",
  );
});
