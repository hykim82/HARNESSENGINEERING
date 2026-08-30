// HYK-396-dispatch-stamp-1 (coder-task.md §3 Q4) -- 적대 표본 4종. §1이
// 완성한 축(배달 시점에 dispatch_id를 보존 사본 헤더에 «박아 두는» 것,
// envelope-archive.mjs의 stampDispatchIdOnLatestArchivedTaskFile +
// dispatch-gate-decision.mjs의 checkArchivedDispatchIdBinding)이 실제로
// 안전한지 이 CLI를 spawn해서 직접 실행으로 확인한다(단위 함수 직접
// 호출이 아니다 -- HYK-394 선례와 동일한 이유: 이 축의 전제는 CLI 전체
// 배선(파일 읽기·경로 해석까지)이라 함수 단위 시험만으로는 배선 누락을
// 못 잡는다).
//
// ⛔합성 fixture만 쓴다 -- 실제 `.harness`는 절대 건드리지 않는다
// (dispatch-gate-live-path-guard.test.mjs가 이미 고정한 계약과 동일,
// §0 급소 "네 시험·변이가 라이브 .harness/를 건드리면 안 된다"도 이 시험이
// mkdtemp 격리 하나로 지킨다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/hyk396-dispatch-stamp.test.mjs\n1b_shown: 보존 사본에 «어느 배달의 것인가»가 배달 시점에 박혀 있어, 사본이 여러 벌이어도 정당한 라운드와 재드롭이 갈린다\n1b_reach_path: 사람이 그 한 줄을 돌려 초록을 보고, 결과 파일의 «적대 표본표»에서 재드롭이 거부되는 것을 확인한다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk396-dispatch-stamp-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  const result = spawnSync("node", [SCRIPT_PATH, ...args], {
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

// dispatchId === undefined -> 헤더에 dispatch_id 필드 자체를 아예 쓰지
// 않는다(ⓓ "옛 사본" 재현 -- 이행 기간 이전 형태, envelope-archive.mjs가
// 이 필드를 추가하기 전 실물 사본과 바이트 모양이 같다). dispatchId가
// 문자열이면 실물 stampDispatchIdOnLatestArchivedTaskFile이 만드는 것과
// 동일한 헤더 모양(`... dropped_at=X dispatch_id=Y -->`)을 그대로 재현한다.
function writeArchivedTaskCopy(
  dir,
  role,
  round,
  { taskId, droppedAt, dispatchId },
) {
  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  const upperRole = role.toUpperCase();
  const header =
    dispatchId === undefined
      ? `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${droppedAt} -->\n`
      : `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${droppedAt} dispatch_id=${dispatchId} -->\n`;
  writeFileSync(
    join(roundsDir, `${upperRole}-task-r${round}.md`),
    `${header}task_id: ${taskId}\ndropped_at: ${droppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
}

function writeDispatchReceiptsLog(path, entries) {
  const lines = entries.map(
    ({ role, harnessTaskLabel, dispatchId, recordedAt }) =>
      JSON.stringify({
        recorded_at: recordedAt,
        runtime_task_id: `task_${Math.random().toString(16).slice(2, 14)}`,
        dispatch_id: dispatchId,
        assignee_pane_key: "test-pane-key",
        dispatch_timestamp_utc: recordedAt,
        dispatch_timestamp_source: "response.dispatched_at",
        role,
        harness_task_label: harnessTaskLabel,
      }),
  );
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function writeConsumptionReceipt(
  dir,
  role,
  binding,
  effects,
  verdictLineCount,
) {
  const receiptsDir = join(dir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(
    join(receiptsDir, `${role}-receipt-r1.json`),
    JSON.stringify({ binding, effects, verdictLineCount }, null, 2) + "\n",
    "utf8",
  );
}

// HYK-396 2R §2 Q1 -- tryArchiveFallback(ARCHIVE_MATCH)이 참조하는 «결과
// 봉투» 보존 사본(envelope-archive.mjs의 archiveRoundEnvelope가 만드는
// 것과 동일한 헤더 모양, `.harness/rounds/<ROLE>-r<N>.md`) -- 위
// writeArchivedTaskCopy(`<ROLE>-task-r<N>.md`, dispatch_id 각인 대상)와는
// 별개 파일·별개 네임스페이스다.
function writeArchivedResultEnvelope(
  dir,
  role,
  round,
  { resultContent, doneAt },
) {
  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  const upperRole = role.toUpperCase();
  const header = `<!-- envelope-archive: role=${upperRole} archived_at=${doneAt} -->\n`;
  writeFileSync(
    join(roundsDir, `${upperRole}-r${round}.md`),
    header + resultContent,
    "utf8",
  );
}

function writeNextTaskFile(dir, role, { taskId, droppedAt, headCommit }) {
  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n${headCommit ? `head_commit: ${headCommit}\n` : ""}${ONE_B_BLOCK}`,
    "utf8",
  );
  return taskPath;
}

const BASE_EFFECTS = Object.freeze({
  envelopeArchived: true,
  taskArchived: true,
  admissionReturned: true,
  ledgerRecorded: true,
});

// ---------------------------------------------------------------------------
// ⓐ 정당(사본 2벌) -> ALLOW: 대상 라벨의 사본 하나(dispatch_id 실값, 원장과
// 일치) + 전혀 무관한 다른 라벨의 사본 하나(같은 rounds/ 디렉터리에 공존).
// findArchivedRoundMeta가 task_id로 먼저 거르므로 무관한 사본이 섞여
// 있어도 판정이 흔들리지 않음을 증명한다.
// ---------------------------------------------------------------------------
test("(a) 정당: 대상 라벨 사본 1개(dispatch_id 원장과 일치) + 무관한 라벨 사본 1개 공존 -> ALLOW", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9601-legit-1";
    const droppedAt = "2026-08-25 10:00:00 KST";
    const doneAt = "2026-08-25 10:05:10 KST";
    const dispatchId = "ctx_hyk396_legit_d1";

    writeArchivedTaskCopy(dir, role, 1, { taskId, droppedAt, dispatchId });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId: "HYK-9601-unrelated-other",
      droppedAt: "2026-08-25 09:00:00 KST",
      dispatchId: "ctx_hyk396_unrelated_x",
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId,
        recordedAt: "2026-08-25T00:30:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9601-legit-next",
      droppedAt: "2026-08-25 12:00:00 KST",
      headCommit: "a".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `기대: ALLOW. 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// ⓑ 재드롭 거부 -> REJECT: 같은 task_id 재드롭(서로 다른 실제 dispatch_id
// 2건, 각 사본 헤더에 그 배달 자신의 dispatch_id가 정확히 각인돼 있음) +
// 새 라운드 결과 미작성. "가장 높은 번호 사본"(재드롭 자신의 droppedAt)만
// 대조하므로, droppedAt 자체가 옛 영수증과 달라 REJECT -- 이 축(§0
// checkArchivedDispatchIdBinding)에 도달하기도 전에 기존 6성분 비교가
// 이미 막는다(§0 "판정 로직 자체는 바꾸지 않는다" 그대로, 새 축은 이
// 케이스를 대신 막지 않고 기존 방어선이 여전히 1차 방어선임을 확인한다).
// ---------------------------------------------------------------------------
test("(b) ★재드롭 거부: 같은 task_id 재드롭(사본마다 실제 dispatch_id 정확히 각인) + 새 라운드 결과 미작성 -> REJECT(droppedAt 불일치가 여전히 1차 방어선)", () => {
  withFixtureDir((dir) => {
    const role = "review";
    const taskId = "HYK-9602-redrop-1";
    const t1DroppedAt = "2026-08-25 10:00:00 KST";
    const t2DroppedAt = "2026-08-25 11:00:00 KST";
    const doneAt = "2026-08-25 10:05:10 KST";
    const d1 = "ctx_hyk396_redrop_d1";
    const d2 = "ctx_hyk396_redrop_d2";

    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt: t1DroppedAt,
      dispatchId: d1,
    });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId,
      droppedAt: t2DroppedAt,
      dispatchId: d2,
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: d1,
        recordedAt: "2026-08-25T00:30:00.000Z", // BEFORE doneAt -- round1's real dispatch
      },
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: d2,
        recordedAt: "2026-08-25T02:00:00.000Z", // AFTER doneAt -- the redrop's real dispatch
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt: t1DroppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9602-redrop-followup",
      droppedAt: "2026-08-25 12:00:00 KST",
      headCommit: "b".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      `재드롭된(아직 소비되지 않은) 새 라운드가 ALLOW되면 안 된다 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /일치하는 것이 없음/);
  });
});

// ---------------------------------------------------------------------------
// ⓒ ★★dispatch_id 위조 거부 -> REJECT: 6성분(taskId/role/droppedAt/
// resultFingerprint/doneAt, dispatchId는 원장에서 정상 조회됨)이 전부
// 진짜로 일치해 기존 로직이라면 ALLOW로 확정됐을 상황인데, 보존 사본
// 헤더에 각인된 dispatch_id만 원장의 실제 값과 다르다(위조/손상된 각인).
// 이 시험이 §2의 새 축(checkArchivedDispatchIdBinding)이 실제로
// 존재하고 동작함을 증명하는 유일한 자리다 -- ⓑ는 기존 축만으로도
// 막히므로 이 새 축의 존재를 증명하지 못한다.
// ---------------------------------------------------------------------------
test("(c) ★★dispatch_id 위조 거부: 6성분은 전부 진짜로 일치(기존 로직이면 ALLOW)하지만 보존 사본에 각인된 dispatch_id가 원장의 실제 값과 다름 -> REJECT(HYK-396 신규 축)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9603-forged-1";
    const droppedAt = "2026-08-25 11:00:00 KST";
    const doneAt = "2026-08-25 11:05:10 KST";
    const realDispatchId = "ctx_hyk396_forged_real";
    const forgedDispatchId = "ctx_hyk396_forged_TAMPERED";

    // 보존 사본 헤더에는 «위조된» dispatch_id가 각인돼 있다 -- 원장의
    // 실제 값(realDispatchId)과 다르다.
    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt,
      dispatchId: forgedDispatchId,
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: realDispatchId,
        recordedAt: "2026-08-25T01:30:00.000Z", // BEFORE doneAt -- 이 라운드의 «진짜» 배달
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9603-forged-next",
      droppedAt: "2026-08-25 12:00:00 KST",
      headCommit: "c".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      `보존 사본의 dispatch_id가 원장과 다른데도(위조) ALLOW되면 새 축이 죽은 코드다 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /위조 또는 다른 배달의 사본/);
  });
});

// ---------------------------------------------------------------------------
// ⓓ 값 부재(옛 사본, 이행 기간) -> ALLOW: 보존 사본 헤더에 dispatch_id
// 필드 자체가 없다(이 라운드 이전에 만들어진 실물 사본과 동일한 모양).
// §2 Q2 "값이 없으면 없다고 기록" -- 이 축은 스킵되고, 기존 6성분 결속
// (여기서는 전부 진짜로 일치)만으로 판정한다 -- 회귀 0을 증명한다.
// ---------------------------------------------------------------------------
test("(d) 값 부재(옛 사본, dispatch_id 필드 없음) -> ALLOW: 새 축은 스킵되고 기존 6성분 결속만으로 판정(회귀 0)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9604-legacy-1";
    const droppedAt = "2026-08-25 13:00:00 KST";
    const doneAt = "2026-08-25 13:05:10 KST";
    const dispatchId = "ctx_hyk396_legacy_d1";

    // dispatchId를 undefined로 넘겨 헤더에 필드 자체를 안 쓴다(옛 형태).
    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt,
      dispatchId: undefined,
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId,
        recordedAt: "2026-08-25T03:30:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9604-legacy-next",
      droppedAt: "2026-08-25 14:00:00 KST",
      headCommit: "d".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `기대: ALLOW(값 부재는 스킵). 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// ⓔ ★★★HYK-396 2R §2 Q1 -- 검토자가 실제로 실행해 반증한 fallback 우회
// (before: status=0 ALLOW ARCHIVE_MATCH). live 결과 파일이 소비 후
// 손질돼(verdict만 바뀜, DONE 줄은 그대로라 doneAt/dispatchId 앵커는
// 안 흔들림) 기존 6성분 결속이 resultFingerprint 하나 때문에 실패하고,
// tryArchiveFallback이 보존된 «원본» 결과 봉투 지문으로 재시도해 ALLOW를
// 낸다 -- 그 통로가 dispatch_id veto를 거치지 않았다(1R 결함). 같은
// 라운드의 보존 TASK 사본 헤더에는 검토자 표본과 똑같은 이름의 위조
// dispatch_id가 각인돼 있다.
// ---------------------------------------------------------------------------
test("(e) ★★★fallback 경로 위조 거부(검토자 실증 재현): live 결과 손질 -> ARCHIVE_MATCH로 재시도 성공하지만 보존 TASK 사본의 dispatch_id가 원장과 다름 -> REJECT(2R 신규 결선)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9605-fallback-forge-1";
    const droppedAt = "2026-08-25 14:00:00 KST";
    const doneAt = "2026-08-25 14:05:10 KST";
    const realDispatchId = "ctx_hyk396_fallback_real";
    const forgedDispatchId = "ctx_hyk396_fallback_forged";

    // 보존 TASK 사본 -- 검토자 표본과 동일한 이름의 위조 dispatch_id.
    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt,
      dispatchId: forgedDispatchId,
    });

    // «원본»(실제로 소비된) 결과 -- 이 지문이 영수증에 결속된 목표 지문.
    const originalResultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const originalFingerprint = computeFingerprint(originalResultContent);
    writeArchivedResultEnvelope(dir, role, 1, {
      resultContent: originalResultContent,
      doneAt,
    });

    // live 결과는 소비 후 손질됨(verdict만 다름, DONE 줄은 그대로 -- doneAt/
    // dispatchId 앵커는 안 흔들린다) -- resultFingerprint만 달라진다.
    const tamperedResultContent = `task_id: ${taskId}\nverdict: rejected\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const resultPath = join(dir, `${role}.md`);
    writeFileSync(resultPath, tamperedResultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: realDispatchId,
        recordedAt: "2026-08-25T04:30:00.000Z",
      },
    ]);

    // 영수증 자신의 결속은 «원본» 지문을 가리킨다(실제로 소비된 것).
    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: originalFingerprint,
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9605-fallback-forge-next",
      droppedAt: "2026-08-25 15:00:00 KST",
      headCommit: "e".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.match(
      r.stderr,
      /ARCHIVE_MATCH/,
      `사전 조건 확인 실패 -- fallback 경로 자체가 안 탔다(다른 이유로 REJECT됐을 수 있음). stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.notEqual(
      r.status,
      0,
      `검토자가 실증한 우회(fallback ALLOW가 dispatch_id veto를 안 거침)가 재발함 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /위조 또는 다른 배달의 사본/);
  });
});

// ---------------------------------------------------------------------------
// ⓕ/ⓖ/ⓗ ★HYK-396 2R §2 Q2 -- 각인 «모양» 엄격화. 셋 다 6성분은 정상적으로
// 일치하도록 구성(모양만 손상) -- «모양이 잘못됐다는 사실 하나만으로»
// 거부되는지를 증명한다(값이 우연히 맞아도 소용없다는 것까지 ⓗ가 보여준다).
// ---------------------------------------------------------------------------
function runShapeCase(
  dir,
  { taskId, droppedAt, doneAt, dispatchIdRaw, ledgerDispatchId },
) {
  const role = "coder";
  writeArchivedTaskCopy(dir, role, 1, {
    taskId,
    droppedAt,
    dispatchId: dispatchIdRaw,
  });
  const resultPath = join(dir, `${role}.md`);
  const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
  writeFileSync(resultPath, resultContent, "utf8");

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptsLog(dispatchReceiptPath, [
    {
      role: role.toUpperCase(),
      harnessTaskLabel: taskId,
      dispatchId: ledgerDispatchId,
      recordedAt: "2026-08-25T05:30:00.000Z",
    },
  ]);
  writeConsumptionReceipt(
    dir,
    role,
    {
      taskId,
      role: role.toUpperCase(),
      droppedAt,
      resultFingerprint: computeFingerprint(resultContent),
      doneAt,
    },
    BASE_EFFECTS,
    1,
  );
  const taskPath = writeNextTaskFile(dir, role, {
    taskId: `${taskId}-next`,
    droppedAt: "2026-08-25 16:00:00 KST",
    headCommit: "f".repeat(40),
  });
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });
  return runCli([
    taskPath,
    "--ledger",
    ledgerPath,
    "--dispatch-receipt-path",
    dispatchReceiptPath,
  ]);
}

test("(f) ★모양 손상 — 빈 값(dispatch_id=<nothing>): 6성분은 정상 일치하지만 각인 값이 빈 문자열 -> REJECT(부재가 아니라 손상)", () => {
  withFixtureDir((dir) => {
    const r = runShapeCase(dir, {
      taskId: "HYK-9606-empty-shape-1",
      droppedAt: "2026-08-25 17:00:00 KST",
      doneAt: "2026-08-25 17:05:10 KST",
      dispatchIdRaw: "",
      ledgerDispatchId: "ctx_hyk396_shape_real_f",
    });
    assert.notEqual(r.status, 0, `실제 stdout: ${r.stdout}`);
    assert.match(r.stderr, /손상/);
  });
});

test("(g) ★모양 손상 — 공백만(dispatch_id=<whitespace>): 6성분은 정상 일치하지만 각인 값이 공백뿐 -> REJECT(부재가 아니라 손상)", () => {
  withFixtureDir((dir) => {
    const r = runShapeCase(dir, {
      taskId: "HYK-9607-whitespace-shape-1",
      droppedAt: "2026-08-25 18:00:00 KST",
      doneAt: "2026-08-25 18:05:10 KST",
      dispatchIdRaw: "   ",
      ledgerDispatchId: "ctx_hyk396_shape_real_g",
    });
    assert.notEqual(r.status, 0, `실제 stdout: ${r.stdout}`);
    assert.match(r.stderr, /손상/);
  });
});

test("(h) ★모양 손상 — 앞 공백 변형(dispatch_id=< >실값): 트림하면 원장 실값과 «우연히» 같아도 -> REJECT(값이 맞아도 모양이 틀리면 소용없다)", () => {
  withFixtureDir((dir) => {
    const realId = "ctx_hyk396_shape_real_h";
    const r = runShapeCase(dir, {
      taskId: "HYK-9608-leading-space-shape-1",
      droppedAt: "2026-08-25 19:00:00 KST",
      doneAt: "2026-08-25 19:05:10 KST",
      dispatchIdRaw: ` ${realId}`,
      ledgerDispatchId: realId,
    });
    assert.notEqual(
      r.status,
      0,
      `트림하면 값이 일치하지만(우연) 모양 자체가 손상이므로 REJECT 기대 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /손상/);
  });
});

// ---------------------------------------------------------------------------
// ⓘ ★★HYK-396 3R §1 Q1⑴ (2R의 «명시적 정의»가 검토 rejected로 뒤집힌
// 자리 -- 2R은 "가장 높은 사본만 본다"는 원칙을 지키려고 이 시나리오를
// ALLOW로 고정했으나, 검토자가 정확히 이 모양(낮은 사본 위조 + 높은
// 사본 미각인)을 실제로 실행해 반증했다. 3R은 "가장 높은 사본이
// ABSENT면 낮은 사본까지 검사한다"로 원칙 자체를 좁혔다 -- 이 표본은
// 이제 REJECT가 정답이다(normal 경로 변형 -- fallback 경로 변형은 ⓔ).
// ---------------------------------------------------------------------------
test("(i) ★★같은 라벨 사본 2개 중 낮은 사본(r1)이 위조, 더 높은 사본(r2, 판정 대상)은 미각인 -> REJECT(HYK-396 3R Q1⑴, normal 경로 -- 2R의 ALLOW 정의가 뒤집힌 자리)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9609-higher-unstamped-1";
    const olderDroppedAt = "2026-08-25 08:00:00 KST"; // r1 -- 위조 각인
    const droppedAt = "2026-08-25 20:00:00 KST"; // r2 -- 이번 판정 대상, 미각인
    const doneAt = "2026-08-25 20:05:10 KST";
    const dispatchId = "ctx_hyk396_higher_unstamped_d1";

    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt: olderDroppedAt,
      dispatchId: "ctx_hyk396_should_never_be_used",
    });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId,
      droppedAt,
      dispatchId: undefined,
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId,
        recordedAt: "2026-08-25T06:30:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9609-higher-unstamped-next",
      droppedAt: "2026-08-25 21:00:00 KST",
      headCommit: "i".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      `기대: REJECT(낮은 사본까지 검사). 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stderr, /위조 의심/);
  });
});

// ---------------------------------------------------------------------------
// ⓙ HYK-396 3R §2 Q2 -- 대조 표의 "ABSENT + 낮은 사본 전부 무해" × normal
// 셀. ⓘ와 대칭: 낮은 사본이 있어도 그 값이 원장과 «일치»하면(무해한
// 증거) 여전히 ALLOW다 -- Q1⑴은 "낮은 사본을 무시하지 마라"는 것이지
// "낮은 사본이 있으면 무조건 거부"가 아님을 증명한다.
// ---------------------------------------------------------------------------
test("(j) ABSENT + 낮은 사본이 있지만 원장과 일치(무해) × normal -> ALLOW(낮은 사본 존재 자체가 아니라 «위조 증거»만 거부 사유)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9610-lower-harmless-1";
    const olderDroppedAt = "2026-08-25 08:00:00 KST";
    const droppedAt = "2026-08-25 22:00:00 KST";
    const doneAt = "2026-08-25 22:05:10 KST";
    const dispatchId = "ctx_hyk396_lower_harmless_d1";

    // r1: 낮은 사본이지만 dispatch_id가 이 라운드 원장 값과 «우연히»
    // 같다(예: 같은 값을 재사용한 합성 표본 -- 실전에서 흔치 않지만,
    // "낮은 사본 존재 = 자동 거부"가 아님을 보이는 데 필요한 유일한
    // 조합이다).
    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt: olderDroppedAt,
      dispatchId,
    });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId,
      droppedAt,
      dispatchId: undefined,
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId,
        recordedAt: "2026-08-25T07:30:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9610-lower-harmless-next",
      droppedAt: "2026-08-25 23:00:00 KST",
      headCommit: "j".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `기대: ALLOW(낮은 사본이 무해하면 거부 사유가 아니다). 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// ⓚ ★★HYK-396 3R §1 Q1⑵ (신규 축) -- fallback 경로에서는 ABSENT를
// 허용하지 않는다. 낮은 사본조차 전혀 없는(진짜 옛 사본 하나뿐인) 순수
// ABSENT라도, fallback(ARCHIVE_MATCH) 경로에서는 REJECT다 -- ⓓ(normal
// 경로 ABSENT -> ALLOW)와 정확히 대칭·대조되는 표본.
// ---------------------------------------------------------------------------
test("(k) ★★ABSENT(증거 전혀 없음, 단일 사본) × fallback -> REJECT(HYK-396 3R Q1⑵, 이행 허용은 정상 경로에만)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9611-fallback-absent-1";
    const droppedAt = "2026-08-26 08:00:00 KST";
    const doneAt = "2026-08-26 08:05:10 KST";
    const dispatchId = "ctx_hyk396_fallback_absent_real";

    // 사본은 단 하나, dispatch_id 필드 자체가 없다(진짜 옛 형태).
    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt,
      dispatchId: undefined,
    });

    const originalResultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const originalFingerprint = computeFingerprint(originalResultContent);
    writeArchivedResultEnvelope(dir, role, 1, {
      resultContent: originalResultContent,
      doneAt,
    });

    // live 결과가 소비 후 손질됨(verdict만 다름) -- fallback을 강제로 태운다.
    const tamperedResultContent = `task_id: ${taskId}\nverdict: rejected\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const resultPath = join(dir, `${role}.md`);
    writeFileSync(resultPath, tamperedResultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId,
        recordedAt: "2026-08-25T20:00:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: originalFingerprint,
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9611-fallback-absent-next",
      droppedAt: "2026-08-26 09:00:00 KST",
      headCommit: "k".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.match(
      r.stderr,
      /ARCHIVE_MATCH/,
      `사전 조건 확인 실패 -- fallback 경로 자체가 안 탔다. stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.notEqual(
      r.status,
      0,
      `기대: REJECT(fallback + ABSENT). 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /이행 허용은 정상 경로에만/);
  });
});

// ---------------------------------------------------------------------------
// ⓛ HYK-396 3R §2 Q2 -- 대조 표의 MATCH × fallback 셀. fallback 경로라도
// 각인이 실제로 있고 원장과 «일치»하면 정상적으로 ALLOW다(ⓚ와 대조 --
// fallback이 무조건 거부하는 건 ABSENT뿐, 진짜 확인된 값은 그대로
// 신뢰한다).
// ---------------------------------------------------------------------------
test("(l) MATCH(원장과 일치) × fallback -> ALLOW(fallback이 거부하는 건 ABSENT뿐, 확인된 값은 신뢰)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9612-fallback-match-1";
    const droppedAt = "2026-08-26 10:00:00 KST";
    const doneAt = "2026-08-26 10:05:10 KST";
    const dispatchId = "ctx_hyk396_fallback_match_real";

    writeArchivedTaskCopy(dir, role, 1, { taskId, droppedAt, dispatchId });

    const originalResultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const originalFingerprint = computeFingerprint(originalResultContent);
    writeArchivedResultEnvelope(dir, role, 1, {
      resultContent: originalResultContent,
      doneAt,
    });

    const tamperedResultContent = `task_id: ${taskId}\nverdict: rejected\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const resultPath = join(dir, `${role}.md`);
    writeFileSync(resultPath, tamperedResultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId,
        recordedAt: "2026-08-25T22:00:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: originalFingerprint,
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9612-fallback-match-next",
      droppedAt: "2026-08-26 11:00:00 KST",
      headCommit: "l".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.match(
      r.stderr,
      /ARCHIVE_MATCH/,
      `사전 조건 확인 실패 -- fallback 경로 자체가 안 탔다. stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.equal(
      r.status,
      0,
      `기대: ALLOW(fallback + MATCH). 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// ⓞ ★★HYK-396 3R §1 Q1⑶ -- 검토자의 두 번째 실증 재현: 각인 값 «뒤에»
// 개행을 심으면 헤더 한 줄 정규식이 통째로 매치를 못 해 옛 코드는 이를
// ABSENT(=스킵, ALLOW)로 접었다. 이 표본은 6성분이 전부 정상 일치하는
// 상황에서 그 헤더 손상 «하나»만으로 REJECT가 되는지를 증명한다(부재가
// 아니라 손상 -- classifyArchivedDispatchId가 접두사 존재로 갈랐는지
// 직접 CLI로 확인).
// ---------------------------------------------------------------------------
test("(o) ★★모양 손상 — 각인 값 뒤 개행 삽입(헤더 파싱 실패): 6성분은 정상 일치하지만 헤더가 깨짐 -> REJECT(부재가 아니라 손상, 검토자 실증 재현)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9613-newline-shape-1";
    const droppedAt = "2026-08-26 12:00:00 KST";
    const doneAt = "2026-08-26 12:05:10 KST";
    const ledgerDispatchId = "ctx_hyk396_newline_real";

    // writeArchivedTaskCopy 헬퍼로는 개행을 헤더 «안에» 심을 수 없으므로
    // (그 헬퍼는 정상 한 줄 헤더만 만든다) 여기서는 직접 파일을 쓴다 --
    // 검토자 실증 그대로: dispatch_id 값 뒤, 닫는 `-->` 앞에 개행 삽입.
    const roundsDir = join(dir, "rounds");
    mkdirSync(roundsDir, { recursive: true });
    const brokenHeader = `<!-- envelope-archive: role=CODER kind=task dropped_at=${droppedAt} dispatch_id=${ledgerDispatchId}\n -->\n`;
    writeFileSync(
      join(roundsDir, "CODER-task-r1.md"),
      `${brokenHeader}task_id: ${taskId}\ndropped_at: ${droppedAt}\n${ONE_B_BLOCK}`,
      "utf8",
    );

    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    const resultPath = join(dir, `${role}.md`);
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: ledgerDispatchId,
        recordedAt: "2026-08-26T02:30:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9613-newline-shape-next",
      droppedAt: "2026-08-26 13:00:00 KST",
      headCommit: "o".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      `개행으로 헤더를 깨서 ABSENT로 새면 위조가 통과한다 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /손상/);
  });
});
