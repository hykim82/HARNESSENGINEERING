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
