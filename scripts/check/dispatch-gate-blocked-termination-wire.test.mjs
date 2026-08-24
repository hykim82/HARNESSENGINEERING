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
// §C -- HYK-342 §4 요구6 (옆문 R4): 결과 파일 없음 = 부트스트랩이 아니라
// "증거가 사라진 것"과 "진짜 첫 라운드"를 구별한다.
// ---------------------------------------------------------------------------

test("§C-1 REJECT: 이 role의 결과 봉투 아카이브(rounds/<role>-r<N>.md)가 이미 있는데 결과 파일이 없으면 -- 부트스트랩이 아니라 증거 사라짐으로 거부", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    mkdirSync(join(dir, "rounds"), { recursive: true });
    writeFileSync(
      join(dir, "rounds", `${role}-r1.md`),
      "task_id: HYK-9301-prior\n>>> DONE: CODER @ 2026-08-24 07:00:00 KST\n",
      "utf8",
    );
    const taskPath = writeNextTaskFile(
      dir,
      role,
      "HYK-9301-r4-fix",
      "2026-08-24 08:00:00 KST",
    );
    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    const r = runCli(SCRIPT_PATH, [taskPath, "--ledger", streakLedgerPath]);
    assert.notEqual(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(
      r.stdout + r.stderr,
      /REJECT_RESULT_EVIDENCE_MISSING|증거가 사라진/,
    );
  });
});

test("§C-2 ALLOW (오탐 0): 이 role의 rounds/ 아카이브가 전혀 없으면(진짜 첫 라운드) 정당한 부트스트랩은 여전히 통과한다", () => {
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

test("RED(변이, 필수): R4 부트스트랩 판별을 되돌리면(항상 null) §C-1의 옆문이 다시 열려 증거 사라짐도 조용히 ALLOW된다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "  if (existsSync(resultPath)) return { shortCircuit: false };\n  const hasLocalArchive = hasAnyArchivedRoundForRole(harnessDir, role);\n";
  assertExactlyOneMatch(
    src,
    target,
    "resolveMissingResultFileOutcome R4 guard entry",
  );
  // 옆문을 원상(HYK-342 1R 이전)으로 되돌리는 변이: 어떤 증거 판별도 없이
  // 결과 파일이 없으면 항상 부트스트랩(null)으로 접는다.
  const mutated = src.replace(
    target,
    "  if (existsSync(resultPath)) return { shortCircuit: false };\n  return { shortCircuit: true, result: null }; // MUTATED: 옛 무조건 부트스트랩\n  const hasLocalArchive = hasAnyArchivedRoundForRole(harnessDir, role);\n",
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-blocked-term-mut-c-"),
    );
    try {
      const role = "coder";
      mkdirSync(join(fixtureDir, "rounds"), { recursive: true });
      writeFileSync(
        join(fixtureDir, "rounds", `${role}-r1.md`),
        "task_id: HYK-9303-prior\n>>> DONE: CODER @ 2026-08-24 07:00:00 KST\n",
        "utf8",
      );
      const taskPath = writeNextTaskFile(
        fixtureDir,
        role,
        "HYK-9303-r4-mut",
        "2026-08-24 08:00:00 KST",
      );
      const streakLedgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

      const r = runCli(mutantPath, [taskPath, "--ledger", streakLedgerPath]);
      assert.equal(
        r.status,
        0,
        "RED: 옆문을 원상복구하면 증거 사라짐도 다시 조용히 ALLOW돼야 한다 -- 이 판별이 실제로 결과를 바꾼다는 증거",
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
// RED(변이, 필수, HYK-342 2R P1-2): 검토자가 재현한 «결과 파일 + rounds/
// 함께 삭제» 공격이 dispatch-receipts.jsonl 앵커(hasReceipt) 없이는
// 다시 뚫리는 것을 확인한다 -- 로컬 아카이브 판별(hasLocalArchive)만
// 남기고 영수증 판별을 빼면, 둘 다 지운 공격이 다시 조용히 ALLOW된다.
// ---------------------------------------------------------------------------

test("RED(변이, 필수, HYK-342 2R P1-2): hasReceipt 판별을 빼면(로컬 아카이브만 남으면) 결과 파일+rounds/를 함께 지운 공격이 다시 ALLOW로 샌다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target = "if (hasLocalArchive || hasReceipt) {";
  assertExactlyOneMatch(src, target, "P1-2 combined evidence check");
  const mutated = src.replace(
    target,
    "if (hasLocalArchive /* MUTATED: || hasReceipt 제거 */) {",
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
      const taskPath = writeNextTaskFile(
        fixtureDir,
        role,
        "HYK-9304-p12-mut",
        "2026-08-24 08:00:00 KST",
      );
      const dispatchReceiptPath = join(fixtureDir, "dispatch-receipts.jsonl");
      writeDispatchReceiptLine(dispatchReceiptPath, {
        role: "CODER",
        harnessTaskLabel: "HYK-9304-p12-mut",
        dispatchId: "ctx_p12_mut",
      });
      const streakLedgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

      // ⛔결과 파일도 rounds/도 만들지 않는다(검토자 재현 그대로) -- 유일한
      // 남은 증거는 dispatch-receipts.jsonl뿐이다.
      const r = runCli(mutantPath, [
        taskPath,
        "--ledger",
        streakLedgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
      ]);
      assert.equal(
        r.status,
        0,
        "RED: hasReceipt 판별이 빠지면 «둘 다 지운» 공격이 다시 ALLOW로 새야 한다 -- 이 판별이 실제로 결과를 바꾼다는 증거",
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
