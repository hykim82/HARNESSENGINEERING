// HYK-311-retire-1 §3 -- 「이름표는 VALID이지만 영구히 막힌 라운드」를
// «은퇴 기록»(retirement record)으로 소비 완료 인정하는 축이 실제 배달
// 게이트 진입점(dispatch-gate-decision.mjs)에 결선됐는지를 증명한다.
//
// 이 파일은 실제 CLI를 spawn해서 exit code와 stdout/stderr을 관측한다
// (직접 함수 호출이 아니다) -- dispatch-gate-abort-wire.test.mjs와 동일한
// 원칙(coder-task.md §5 "실제 CLI를 자식 프로세스로 돌려라"). 다섯 묶음:
//   §A GREEN -- 진짜 영구 차단 + 유효한 은퇴 기록 -> 다음 배달 ALLOW
//   §B REGRESSION -- 정상 회수 가능 미소비(은퇴 기록 없음) -> 여전히 REJECT
//   §C 위조 은퇴 기록 3종(아카이브 없음/지문 불일치/후속 라벨 없음) -> 각각
//      구별되는 사유로 REJECT
//   §D abort-record 축(MISSING 이름표 전용) 회귀 확인 -- 이 축을 추가해도
//      그 축이 여전히 정상 동작한다.
//
// ⛔실물 admission ledger에 쓰지 않는다 -- 모든 테스트가 임시 tmpdir 안의
// ledger/lock 경로만 쓴다(HYK-312 사고 재발 방지, coder-task.md §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import { writeRetirementRecord } from "./retirement-record-writer.mjs";
import { writeAbortRecord } from "./abort-record-writer.mjs";
import {
  createEmptyLedger,
  admitReservation,
  sweepAndRecover,
} from "../supervisor/admission-ledger-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-retirement-test-"));
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

// HYK-383 2R §2: this file's role is always "review" -- the new
// head_commit precondition axis (dispatch-gate-decision.mjs's
// checkHeadCommitPrecondition) now also gates every review-task.md
// delivery, so every fixture built here needs a valid cover line or the
// gate REJECTs before ever reaching the retirement-record axis this file
// actually targets.
const HEAD_COMMIT_LINE = `head_commit: ${"c".repeat(40)}\n`;

function writeNextTaskFile(dir, role, nextTaskId, nextDroppedAt) {
  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${nextTaskId}\ndropped_at: ${nextDroppedAt}\n${HEAD_COMMIT_LINE}${ONE_B_BLOCK}`,
    "utf8",
  );
  return taskPath;
}

// 직전 라운드가 VALID 이름표(task_id: 줄 정확히 하나)를 남기고 끝났지만,
// 정상 소비 영수증 체인으로는 영원히 소비될 수 없는 상태(영수증 파일
// 자체가 없음, dispatch-receipts.jsonl도 없음) -- "영구히 막힌" 라운드의
// 최소 재현. DONE 타임스탬프는 일부러 기계로 파싱 불가능한 형태로 남긴다
// (§A/§C가 DONE_TIMESTAMP_NOT_PARSEABLE 사유를 쓰기 때문 -- 어댑터의
// confirmRetirementBlockReason이 이 사실을 live 파일에서 독립 재확인해야
// §A가 통과한다).
function buildBlockedValidLabelFixture(dir) {
  const role = "coder";
  const harnessTaskLabel = "HYK-9311-retire-blocked-round";
  const resultContent = `task_id: ${harnessTaskLabel}\n>>> DONE: CODER @ 이것은-파싱될-수-없는-시각\n`;
  writeFileSync(join(dir, `${role}.md`), resultContent, "utf8");

  const taskPath = writeNextTaskFile(
    dir,
    role,
    "HYK-9311-retire-blocked-round-next",
    "2026-08-19 10:00:00 KST",
  );

  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });

  const admissionLedgerPath = join(dir, "admission-ledger.json");
  writeFileSync(
    admissionLedgerPath,
    JSON.stringify(createEmptyLedger("2026-08-19T00:00:00.000Z")) + "\n",
    "utf8",
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

// §3-1(어댑터 resolveRetirementArchiveCandidate)이 재사용하는 바로 그
// `.harness/rounds/<ROLE>-r<N>.md` 관례로 아카이브 사본을 심는다.
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

// ---------------------------------------------------------------------------
// §A -- 진짜 영구 차단 + 유효한 은퇴 기록 -> 정식 통과.
// ---------------------------------------------------------------------------

test("§A GREEN: VALID 이름표 + 영구 차단(정상 소비 불가) + 검증 가능한 은퇴 기록(아카이브 실물·지문 일치·기계 재확인·후속 라벨) -> 다음 배달 ALLOW", () => {
  withFixtureDir((dir) => {
    const fixture = buildBlockedValidLabelFixture(dir);
    writeArchivedRoundCopy(dir, fixture.role, fixture.resultContent);

    const write = writeRetirementRecord({
      role: fixture.role.toUpperCase(),
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      archivePath: "rounds/CODER-r1.md",
      archiveFingerprintClaimed: computeFingerprint(fixture.resultContent),
      blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      successorLabel: "HYK-9311-retire-blocked-round-next",
      recordedAt: "2026-08-19 10:05:00 KST",
      evidence: "DONE 타임스탬프가 기계로 파싱 불가능한 형태로 남음",
    });
    assert.equal(
      write.ok,
      true,
      `은퇴 기록 작성 자체가 실패하면 전제가 무너진다: ${write.reason}`,
    );
    assert.deepEqual(readdirSync(join(dir, "retirements")), [
      "CODER-retire-r1.json",
    ]);

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

// ---------------------------------------------------------------------------
// §B -- REGRESSION(가장 중요): 정상 회수 가능 미소비는 은퇴 기록이 없으면
// 여전히 REJECT돼야 한다(기존 소비 게이트를 이 축이 조금도 약화시키지
// 않는다는 증거).
// ---------------------------------------------------------------------------

test("§B REGRESSION: VALID 이름표 + 정상 회수 가능 미소비(영수증 없음) + 은퇴 기록 없음 -> 여전히 REJECT(기존 소비 게이트 그대로)", () => {
  withFixtureDir((dir) => {
    const fixture = buildBlockedValidLabelFixture(dir);
    // .harness/retirements/ 디렉터리 자체가 없다 -- 은퇴 기록을 아예
    // 시도조차 안 한다.
    const r = runGate(fixture);
    assert.notEqual(
      r.status,
      0,
      "은퇴 기록이 없으면 VALID 이름표라도 여전히 거부돼야 한다",
    );
    assert.match(
      r.stderr,
      /consumption-receipt:/,
      "옛 경로(정상 소비 게이트)의 사유가 그대로 보존돼야 한다(회귀 0)",
    );
  });
});

// ---------------------------------------------------------------------------
// §C -- 위조 은퇴 기록 3종, 각각 따로(구별되는 사유로) 거부되는 것을
// 실행으로 보인다.
// ---------------------------------------------------------------------------

test("§C-1 위조(아카이브 없음): 은퇴 기록이 가리키는 .harness/rounds/ 아카이브 사본이 아예 없음 -> REJECT(ARCHIVE_MISSING)", () => {
  withFixtureDir((dir) => {
    const fixture = buildBlockedValidLabelFixture(dir);
    // ⛔writeArchivedRoundCopy를 호출하지 않는다 -- rounds/ 디렉터리 자체가
    // 없다.
    const write = writeRetirementRecord({
      role: fixture.role.toUpperCase(),
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      archivePath: "rounds/CODER-r1.md",
      archiveFingerprintClaimed: computeFingerprint(fixture.resultContent),
      blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      successorLabel: "HYK-9311-retire-blocked-round-next",
      recordedAt: "2026-08-19 10:05:00 KST",
      evidence: "아카이브 없이 위조 시도",
    });
    assert.equal(write.ok, true);

    const r = runGate(fixture);
    assert.notEqual(r.status, 0, "아카이브 없는 은퇴 기록은 거부돼야 한다");
    assert.match(r.stderr, /retirement-record:/);
    assert.match(r.stderr, /ARCHIVE_MISSING|아카이브 사본.*존재하지 않음/);
  });
});

test("§C-2 위조(지문 불일치): 아카이브 사본은 존재하나 지문이 은퇴 기록의 주장과 다름(위조 지문) -> REJECT(FINGERPRINT_MISMATCH)", () => {
  withFixtureDir((dir) => {
    const fixture = buildBlockedValidLabelFixture(dir);
    // 아카이브 사본은 심지만, live 결과 파일과 다른 내용(다른 지문)으로
    // 심는다 -- 같은 harnessTaskLabel을 에코하되 본문이 다르다.
    const forgedArchiveContent = `task_id: ${fixture.harnessTaskLabel}\n>>> DONE: CODER @ 다른-내용-위조\n`;
    writeArchivedRoundCopy(dir, fixture.role, forgedArchiveContent);

    const write = writeRetirementRecord({
      role: fixture.role.toUpperCase(),
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      archivePath: "rounds/CODER-r1.md",
      // ⛔claimed 값은 live(원본) 결과 파일의 지문 -- 위조자가 "이게 그
      // 지문이다"라고 주장은 하지만, 실제 아카이브 사본(forgedArchiveContent)
      // 은 그 값을 만들어내지 않는다.
      archiveFingerprintClaimed: computeFingerprint(fixture.resultContent),
      blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      successorLabel: "HYK-9311-retire-blocked-round-next",
      recordedAt: "2026-08-19 10:05:00 KST",
      evidence: "지문 위조 시도",
    });
    assert.equal(write.ok, true);

    const r = runGate(fixture);
    assert.notEqual(r.status, 0, "지문이 다른 은퇴 기록은 거부돼야 한다");
    assert.match(r.stderr, /retirement-record:/);
    assert.match(r.stderr, /FINGERPRINT_MISMATCH|지문 대조 실패/);
  });
});

test("§C-3 위조(후속 라벨 없음): 은퇴 기록에 successorLabel이 없음 -> REJECT(SUCCESSOR_LABEL_MISSING)", () => {
  withFixtureDir((dir) => {
    const fixture = buildBlockedValidLabelFixture(dir);
    writeArchivedRoundCopy(dir, fixture.role, fixture.resultContent);

    const write = writeRetirementRecord({
      role: fixture.role.toUpperCase(),
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.harnessTaskLabel,
      archivePath: "rounds/CODER-r1.md",
      archiveFingerprintClaimed: computeFingerprint(fixture.resultContent),
      blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      // ⛔successorLabel 자체를 아예 안 넘긴다(undefined).
      recordedAt: "2026-08-19 10:05:00 KST",
      evidence: "후속 라벨 없이 위조 시도",
    });
    assert.equal(write.ok, true);

    const r = runGate(fixture);
    assert.notEqual(r.status, 0, "후속 라벨 없는 은퇴 기록은 거부돼야 한다");
    assert.match(r.stderr, /retirement-record:/);
    assert.match(r.stderr, /SUCCESSOR_LABEL_MISSING|후속 이름표.*없음/);
  });
});

// ---------------------------------------------------------------------------
// §D -- abort-record 축(MISSING 이름표 전용) 회귀 확인: 이 축을 새로
// 결선해도 그 축은 조금도 바뀌지 않았다.
// ---------------------------------------------------------------------------

function writeDispatchReceiptLine(
  path,
  { role, harnessTaskLabel, dispatchId },
) {
  const record = {
    recorded_at: new Date().toISOString(),
    runtime_task_id: `task_${Math.random().toString(16).slice(2, 14)}`,
    dispatch_id: dispatchId,
    assignee_pane_key: "test-pane-key",
    dispatch_timestamp_utc: new Date().toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: harnessTaskLabel,
  };
  writeFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

// abort-record-core.mjs의 §A GREEN 픽스처(dispatch-gate-abort-wire.test.mjs)
// 를 그대로 재구성한 것 -- 실물 admission-ledger-core.mjs 함수(admit ->
// sweepAndRecover ACTIVE->SUSPECT -> sweepAndRecover SUSPECT->COMPLETED)를
// 그대로 돌려 SUSPECT_TIMEOUT_RECOVERED 표식을 진짜로 만든다(합성 JSON을
// 손으로 짜지 않는다, 저 파일 헤더와 동일 이유).
function buildRealRecoveredLedger(harnessTaskLabel) {
  let ledger = createEmptyLedger("2026-08-19T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: harnessTaskLabel,
    cap: 1,
    now: "2026-08-19T00:00:00.000Z",
    role: "REVIEW",
    seatKey: "seat-that-died",
  });
  assert.equal(admit.decision, "ADMITTED");
  ledger = admit.ledger;

  const staleAfterMs = 5 * 60 * 1000;
  const recoveryGraceMs = 10 * 60 * 1000;
  const toSuspect = sweepAndRecover(ledger, {
    now: "2026-08-19T00:10:01.000Z",
    liveSeatKeys: [],
    staleAfterMs,
    recoveryGraceMs,
  });
  assert.equal(toSuspect.ok, true);
  ledger = toSuspect.ledger;

  const toCompleted = sweepAndRecover(ledger, {
    now: "2026-08-19T00:20:02.000Z",
    liveSeatKeys: [],
    staleAfterMs,
    recoveryGraceMs,
  });
  assert.equal(toCompleted.ok, true);
  assert.equal(
    toCompleted.ledger.reservations[harnessTaskLabel].completion_reason,
    "SUSPECT_TIMEOUT_RECOVERED",
  );
  return toCompleted.ledger;
}

test("§D 회귀: 이름표 없이 죽은 라운드(abort-record 축, MISSING 전용)는 은퇴 축 추가 후에도 그대로 ALLOW", () => {
  withFixtureDir((dir) => {
    const role = "review";
    const deadHarnessTaskLabel = "HYK-9311-retire-abort-regress";
    const deadDispatchId = "ctx_test_retire_abort_regress";
    const deadResultContent =
      "dispatch_verified: yes\ntask_id_from_dispatch: task_2b5c1ad861aa\npane_match: x == x ? 일치\n";
    writeFileSync(join(dir, `${role}.md`), deadResultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "REVIEW",
      harnessTaskLabel: deadHarnessTaskLabel,
      dispatchId: deadDispatchId,
    });

    const taskPath = writeNextTaskFile(
      dir,
      role,
      "HYK-9311-retire-abort-regress-next",
      "2026-08-19 10:00:00 KST",
    );

    const ledgerPath = join(dir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify(buildRealRecoveredLedger(deadHarnessTaskLabel)) + "\n",
      "utf8",
    );

    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    writeAbortRecord({
      role: "REVIEW",
      harnessDir: dir,
      harnessTaskLabel: deadHarnessTaskLabel,
      dispatchId: deadDispatchId,
      droppedAt: "2026-08-19 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(deadResultContent),
      leftoverPath: "review.md",
      recordedAt: "2026-08-19 10:05:00 KST",
      evidence: "sweep SUSPECT_TIMEOUT_RECOVERED (admission-ledger.json)",
    });

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      streakLedgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
      "--admission-ledger-path",
      ledgerPath,
    ]);
    assert.equal(r.status, 0, `ALLOW 기대, 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
    assert.match(r.stderr, /abort-record:/);
  });
});
