// HYK-398 §4 "되돌림 변이 필수" -- 새로 배선한 은퇴 자리-반납 호출
// (relay-handshake.mjs's runRetirementSideEffectsIfApplicable ->
// spawnAdmissionRetirementReleaseProcess) 자체가 이 라운드가 «실제로»
// 원장 자리를 반납시키는 원인임을, 그 호출 한 줄을 제거한 변이(mutant)로
// 증명한다: 증거를 갖춘 표본(유효한 은퇴 기록 + 아카이브 지문 일치)에서도
// 그 호출이 없으면 자리가 반납되지 않아야 한다(RED) -- relay-handshake-
// completion-wire.test.mjs의 ⓒ와 정확히 같은 형태(같은 stageIsolated
// RelayHandshakeDeps 원칙, 같은 "원복 증명" 규율).
//
// ⛔ 실제 관제실 정본 원장에는 절대 쓰지 않는다 -- 모든 원장은 mkdtemp
// 합성 픽스처다.
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
import { createHash } from "node:crypto";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fingerprintOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
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

function readStatus(ledger, reservationId) {
  return JSON.parse(readFileSync(ledger, "utf8")).reservations[reservationId]
    .status;
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

// relay-handshake-completion-wire.test.mjs의 stageIsolatedRelayHandshakeDeps
// 원칙을 그대로 따른다 -- 이 라운드가 admission-completion-adapter.mjs에
// 새로 추가한 정적 import(retirement-record-core.mjs)까지 사이드카로
// 포함한다.
function stageIsolatedRelayHandshakeDeps(rootDir) {
  const checkDir = join(rootDir, "scripts", "check");
  const supervisorDir = join(rootDir, "scripts", "supervisor");
  mkdirSync(checkDir, { recursive: true });
  mkdirSync(supervisorDir, { recursive: true });
  for (const name of [
    "time-authority.mjs",
    "reject-streak.mjs",
    "envelope-archive.mjs",
    "admission-completion-adapter.mjs",
    "ledger-pointer-shared.mjs",
    "retirement-record-core.mjs",
  ]) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  for (const name of [
    "admission-ledger-core.mjs",
    "admission-ledger-store.mjs",
  ]) {
    writeFileSync(
      join(supervisorDir, name),
      readFileSync(join(CHECK_DIR, "..", "supervisor", name), "utf8"),
      "utf8",
    );
  }
  return { checkDir, supervisorDir };
}

function writeEvidencedRetirementSample(harnessDir, taskId, droppedAt, doneAt) {
  const taskContent = `task_id: ${taskId}\ndropped_at: ${droppedAt}\n`;
  const resultContent = `task_id: ${taskId}\n\n>>> DONE: CODER @ ${doneAt}\ndone_stamped_by: finalize-done\n`;
  writeFileSync(join(harnessDir, "coder-task.md"), taskContent, "utf8");
  writeFileSync(join(harnessDir, "coder.md"), resultContent, "utf8");
  mkdirSync(join(harnessDir, "rounds"), { recursive: true });
  writeFileSync(
    join(harnessDir, "rounds", "coder-r1.md"),
    resultContent,
    "utf8",
  );
  mkdirSync(join(harnessDir, "retirements"), { recursive: true });
  writeFileSync(
    join(harnessDir, "retirements", "coder-retire-r1.json"),
    JSON.stringify({
      role: "CODER",
      harnessTaskLabel: taskId,
      archivePath: "rounds/coder-r1.md",
      archiveFingerprintClaimed: fingerprintOf(resultContent),
      blockReasonCode: "DONE_PREDATES_DROPPED_AT",
      successorLabel: `${taskId}-next`,
      recordedAt: droppedAt,
      evidence: { source: "mutation-test" },
    }),
    "utf8",
  );
}

test("HYK-398 되돌림 변이: runRetirementSideEffectsIfApplicable의 spawnAdmissionRetirementReleaseProcess(taskId, harnessDir, role) 호출을 제거하면 -> 증거를 갖춘 은퇴 표본도 자리를 못 돌려받는다(RED), 실 소스 파일은 원복 증명(바이트 동일)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  spawnAdmissionRetirementReleaseProcess(taskId, harnessDir, role);";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "spawnAdmissionRetirementReleaseProcess call" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, "");

  const rootDir = tmpDir("hyk398-mut-root-");
  const harnessDir = tmpDir("hyk398-mut-harness-");
  const ledgerDir = tmpDir("hyk398-mut-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const { checkDir } = stageIsolatedRelayHandshakeDeps(rootDir);
    writeFileSync(join(checkDir, "relay-handshake.mjs"), mutated, "utf8");

    const taskId = "HYK-398-MUT-1";
    initAndAdmit(ledger, lock, taskId);
    writeEvidencedRetirementSample(
      harnessDir,
      taskId,
      "2026-08-19 09:00:00 KST",
      "2026-08-19 08:00:00 KST",
    );

    const mod = await import(
      `file://${join(checkDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = await withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () => mod.checkRelayHandshake({ role: "coder", harnessDir }),
    );

    // 변이는 소비 판정 자체를 건드리지 않는다 -- STALE 거부는 그대로다.
    assert.equal(result.ok, false);
    assert.equal(result.state, "STALE_DONE_PREDATES_DROP");

    assert.equal(
      readStatus(ledger, taskId),
      "ACTIVE",
      "RED: 호출을 제거하면 증거를 갖춘 은퇴 표본도 자리를 반납받지 못한다 -- 이 결선이 실제로 원인임을 증명",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    // 원복 증명: 실제 저장소 파일은 메모리에서 읽기만 했을 뿐 한 번도
    // 쓰기 대상이 아니었다 -- 이 시험 실행 전후로 바이트 단위 동일해야
    // 한다.
    const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명 실패: 실제 relay-handshake.mjs가 이 시험 도중 바뀌었다",
    );
  }
});
