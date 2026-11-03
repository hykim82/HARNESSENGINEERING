// HYK-412 2R P1-1 -- dispatch-gate-retirement-wire.test.mjs §A/§A3 proved
// CONSUMPTION_REFUSED_RUNNER_CONTRACT wiring by spawning the real
// dispatch-gate-decision.mjs CLI for the other three mechanically-confirmable
// reasons, but 1R never added an equivalent fixture for this fifth reason --
// its result table's "⑵" row claimed PASS for "배달 게이트 소비 판정" while
// actually only exercising admission-completion-adapter.mjs (a different
// production entry point, see docs/HYK-412-stuck-retire-design.md §11 for
// the corrected table). This file closes that gap: it spawns the real CLI
// (child process, not a direct function call -- same principle as
// dispatch-gate-retirement-wire.test.mjs's own header) with a hand-assembled
// runner-contract refusal record (the exact shape
// relay-handshake.mjs's persistRunnerContractRefusalRecordIfApplicable
// writes under .harness/receipts/ -- that writer's own behavior is already
// pinned by relay-handshake-runner-contract-refusal-retirement.test.mjs, so
// this file only needs to assemble the same shape by hand, the same
// division of labor retirement-block-reason-shared.test.mjs's
// buildRunnerContractRefusalFixture already uses for the non-CLI axis).
//
// ⛔실물 admission ledger에 쓰지 않는다 -- 모든 시험이 mkdtemp 안의
// ledger/lock 경로만 쓴다(HYK-312 사고 재발 방지 원칙 그대로).
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
import { writeRetirementRecord } from "./retirement-record-writer.mjs";
import { createEmptyLedger } from "../supervisor/admission-ledger-core.mjs";
import { RETIREMENT_BLOCK_REASON } from "./retirement-record-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-runner-contract-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(scriptPath, args) {
  const result = spawnSync("node", [scriptPath, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function computeFingerprint(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
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

function writeArchivedRoundCopy(dir, role, content) {
  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  writeFileSync(
    join(roundsDir, `${role.toUpperCase()}-r1.md`),
    content,
    "utf8",
  );
}

function runGate(fixture, extraArgs = []) {
  return runCli(SCRIPT_PATH, [
    fixture.taskPath,
    "--ledger",
    fixture.ledgerPath,
    "--admission-ledger-path",
    fixture.admissionLedgerPath,
    ...extraArgs,
  ]);
}

// relay-handshake.mjs의 persistRunnerContractRefusalRecordIfApplicable이
// 실제로 .harness/receipts/<role>-runner-contract-refused-<label>.json에
// 남기는 것과 같은 모양(label/role/blockReasonCode/resultFingerprintSha256/
// receipts[{path,sha256,runner_exit,head_commit}]/reason/recordedAt)을
// harnessDir 바로 아래(entry.path가 harnessDir 기준 상대경로이므로)에 직접
// 조립한다 -- 그 writer 자신의 동작은 relay-handshake.mjs 쪽 시험이 고정
//한다(위 파일 헤더 참조), 이 시험은 배달 게이트(dispatch-gate-decision.mjs)
// 가 그 기록을 실제로 소비해 ALLOW/REJECT를 내리는지만 고정한다.
// buildRunnerContractGateFixture를 80줄 상한(max-lines-per-function) 밑으로
// 가르는 추출일 뿐, 판정은 조금도 바뀌지 않는다 -- 거부 1줄 지속 기록(및
// 그 기록이 가리키는 영수증 파일)을 harnessDir 바로 아래 조립해서 그
// evidenceReceiptPath를 돌려준다.
function writeRunnerContractRefusalRecordFixture(
  dir,
  { harnessTaskLabel, resultContent, tamperReceiptByte },
) {
  const headCommit = "b".repeat(40);
  const receiptBody = JSON.stringify({
    schema_version: 2,
    runner_exit: 1,
    runner_status: "TESTS_FAILED",
    head_commit: headCommit,
    finished_at: "2026-11-03 09:55:00 KST",
  });
  writeFileSync(join(dir, "runner-receipt-run4.json"), receiptBody, "utf8");
  // 변조는 "기록된 사유를 바이트로 다시 실측"한 뒤 -- sha256 재대조가
  // 실제로 어긋나게 만드는 최소 변이(1바이트)다(M5와는 다른 축: 여기는
  // 데이터 변조, M5는 게이트 쪽 비교 로직 변이).
  if (tamperReceiptByte) {
    const tampered = receiptBody.slice(0, -2) + "9" + receiptBody.slice(-1);
    writeFileSync(join(dir, "runner-receipt-run4.json"), tampered, "utf8");
  }
  const trueSha256 = createHash("sha256")
    .update(receiptBody, "utf8")
    .digest("hex");

  mkdirSync(join(dir, "receipts"), { recursive: true });
  const refusalRecord = {
    label: harnessTaskLabel,
    role: "CODER",
    blockReasonCode:
      RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
    resultFingerprintSha256: computeFingerprint(resultContent),
    receipts: [
      {
        path: "runner-receipt-run4.json",
        sha256: trueSha256,
        runner_exit: 1,
        head_commit: headCommit,
      },
    ],
    reason:
      "consecutive runner receipt gate (HYK-485): runner-receipt-run4.json reports runner_exit=1 (non-zero) -- refusing to consume a claimed 2-consecutive-green result when one of the two runs was not green",
    recordedAt: "2026-11-03T01:00:00.000Z",
  };
  const evidenceReceiptPath =
    "receipts/coder-runner-contract-refused-test.json";
  writeFileSync(
    join(dir, evidenceReceiptPath),
    JSON.stringify(refusalRecord, null, 2) + "\n",
    "utf8",
  );
  return evidenceReceiptPath;
}

function buildRunnerContractGateFixture(
  dir,
  { tamperReceiptByte = false } = {},
) {
  const role = "coder";
  const harnessTaskLabel = "HYK-9412-retire-runner-contract-round";
  const resultContent = `task_id: ${harnessTaskLabel}\n>>> DONE: CODER @ 2026-11-03 10:00:00 KST\n`;
  writeFileSync(join(dir, `${role}.md`), resultContent, "utf8");
  writeArchivedRoundCopy(dir, role, resultContent);

  const evidenceReceiptPath = writeRunnerContractRefusalRecordFixture(dir, {
    harnessTaskLabel,
    resultContent,
    tamperReceiptByte,
  });

  const taskPath = writeNextTaskFile(
    dir,
    role,
    `${harnessTaskLabel}-next`,
    "2026-11-03 10:05:00 KST",
  );

  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });

  const admissionLedgerPath = join(dir, "admission-ledger.json");
  writeFileSync(
    admissionLedgerPath,
    JSON.stringify(createEmptyLedger("2026-11-03T00:00:00.000Z")) + "\n",
    "utf8",
  );

  const write = writeRetirementRecord({
    role: role.toUpperCase(),
    harnessDir: dir,
    harnessTaskLabel,
    archivePath: "rounds/CODER-r1.md",
    archiveFingerprintClaimed: computeFingerprint(resultContent),
    blockReasonCode:
      RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
    successorLabel: `${harnessTaskLabel}-next`,
    recordedAt: "2026-11-03 10:02:00 KST",
    evidence:
      "HYK-485 연속 영수증 게이트가 runner_exit!=0으로 구조적으로 영구 거부",
    evidenceReceiptPath,
  });
  assert.equal(
    write.ok,
    true,
    `은퇴 기록 작성 자체가 실패하면 전제가 무너진다: ${write.reason}`,
  );

  return {
    role,
    dir,
    taskPath,
    harnessTaskLabel,
    resultContent,
    ledgerPath,
    admissionLedgerPath,
  };
}

test("§G (HYK-412 P1-1) GREEN: CONSUMPTION_REFUSED_RUNNER_CONTRACT 은퇴 기록 + 유효한 거부 기록(지문 일치·영수증 sha256 일치·live runner_exit!=0) -> 프로덕션 배달 게이트 CLI(dispatch-gate-decision.mjs) 실 spawn -> 다음 배달 ALLOW(RETIRED)", () => {
  withFixtureDir((dir) => {
    const fixture = buildRunnerContractGateFixture(dir);
    const r = runGate(fixture);
    assert.equal(r.status, 0, `ALLOW 기대, 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stderr,
      /retirement-record:/,
      "이 축 고유의 사유가 stderr에 찍혀야 한다(조용한 통과 금지)",
    );
    assert.match(r.stderr, /RETIRED|은퇴 처리/);
  });
});

test("§G-a (HYK-412 P1-1) RED: 같은 은퇴 기록이 가리키는 영수증 파일을 1바이트 변조(거부 기록이 주장하는 sha256과 지금 다시 읽은 바이트가 어긋남) -> 프로덕션 배달 게이트 CLI 실 spawn -> REJECT(BLOCK_REASON_UNCONFIRMED)", () => {
  withFixtureDir((dir) => {
    const fixture = buildRunnerContractGateFixture(dir, {
      tamperReceiptByte: true,
    });
    const r = runGate(fixture);
    assert.notEqual(r.status, 0, `REJECT 기대, 실제 stdout: ${r.stdout}`);
    assert.match(
      r.stderr,
      /독립적으로 재확인되지 않음/,
      "기계로 확인 가능한 사유가 재확인 실패했다는 사유가 찍혀야 한다(BLOCK_REASON_UNCONFIRMED)",
    );
  });
});

test("§G sanity: 1바이트 변조 표본의 영수증 파일 바이트가 실제로 원본과 다르다(변이가 진짜 벌어졌음을 직접 확인, 조용한 무변이 방지)", () => {
  withFixtureDir((dir) => {
    const clean = buildRunnerContractGateFixture(dir);
    const cleanBytes = readFileSync(
      join(dir, "runner-receipt-run4.json"),
      "utf8",
    );
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tampered = buildRunnerContractGateFixture(dir, {
      tamperReceiptByte: true,
    });
    const tamperedBytes = readFileSync(
      join(dir, "runner-receipt-run4.json"),
      "utf8",
    );
    assert.notEqual(tamperedBytes, cleanBytes);
    assert.equal(tampered.harnessTaskLabel, clean.harnessTaskLabel);
  });
});
