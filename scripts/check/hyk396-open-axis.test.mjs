// HYK-396-open-axis-1 (coder-task.md, ★«여는 축») -- 오늘 릴레이 병목의
// 정면 수리를 CLI 전체 배선으로 직접 실행해 증명한다.
//
// §1 무엇을 여는가: 소비 판정은 직전 라운드가 소비됐는지를 «보존 사본의
// dropped_at»으로 대조하는데, 같은 라벨 사본이 여러 벌이면(배달이
// 반려되어 재시도할 때마다 dropped_at을 다시 찍고 사본을 한 벌 더
// 보존하기 때문 -- Q1이 이 사실 자체를 실측으로 확인한다) 옛 코드는
// «가장 높은 번호 하나»만 봤다. 오늘 실측(같은 review 라벨 사본 5벌
// 18:40·19:13·19:36·19:37·19:45, 영수증은 19:13에 결속)처럼 그 하나가
// «진짜»가 아니면 이미 소비된 라운드가 «미소비»로 오판돼 배달이 막힌다.
//
// §2 이 축이 여는 것(dispatch-gate-decision.mjs의 tryDispatchIdArchiveSelection):
// «가장 높은 번호» 1차 대조가 실패했을 때만(tryArchiveFallback과 동일한
// "정상 경로 실패 시에만 재시도" 형태), «이 라운드 자신의 dispatch_id로
// 각인된 사본»을 다시 찾아 그 사본의 dropped_at으로 한 번 더 시도한다 --
// 이 재시도는 이 라벨의 dispatch-receipts.jsonl 이력이 정확히 실배달
// 1건뿐일 때만 켜진다(재드롭=실배달 2건 이상이면 꺼진다, countDistinctDispatchIdsForLabel
// 참조) -- 그래서 HYK-394 2R/Q8이 실증으로 반증했던 "dispatch_id로 결속
// 대조를 넓히면 재드롭이 뚫린다"는 구멍을 다시 열지 않는다.
//
// ⛔합성 fixture만 쓴다 -- 실제 `.harness`는 절대 건드리지 않는다
// (hyk396-dispatch-stamp.test.mjs/hyk394-dispatch-id-bind.test.mjs와 동일
// 계약, mkdtemp 격리 하나로 지킨다). Q4(되돌림 변이)만 소스를 문자열
// 치환으로 임시 사본에 적용한다(hyk241-oneb-gate-mutation.test.mjs 선례,
// 원본 파일은 절대 건드리지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node --test scripts/check/hyk396-open-axis.test.mjs\n1b_shown: 사본이 여러 벌 쌓여도 «그 배달의 것»이 있으면 정당한 라운드가 통과하고, 재드롭·위조는 그대로 막힌다\n1b_reach_path: 사람이 그 한 줄을 돌려 초록을 보고, 결과 파일의 «적대 표본표»에서 정당은 ALLOW·나머지는 REJECT 임을 확인한다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk396-open-axis-test-"));
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
// 않는다(옛 사본/미스탬프 상태 재현). 문자열이면 실물
// stampDispatchIdOnLatestArchivedTaskFile이 만드는 것과 동일한 헤더
// 모양을 그대로 재현한다(hyk396-dispatch-stamp.test.mjs의 writeArchivedTaskCopy
// 그대로 복제 -- 그 파일을 import하지 않는 이유는 그 파일이 시험 파일
// 자신이라 production 계약이 아니기 때문).
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

// ===========================================================================
// ⓐ 오염 -- 같은 라벨 사본 2벌(진짜=각인 O, 스퓨리어스=더 높은 번호,
// 미각인) + 영수증은 진짜에 결속 -> ★ALLOW(이게 «여는» 것이다).
// ===========================================================================
test("ⓐ 오염: 같은 라벨 사본 2벌(진짜=각인 O·낮은 번호 / 스퓨리어스=더 높은 번호·미각인) + 영수증은 진짜에 결속 -> ALLOW", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9700-open-axis-contam-1";
    const genuineDroppedAt = "2026-08-30 19:13:00 KST";
    const spuriousDroppedAt = "2026-08-30 19:45:00 KST";
    const doneAt = "2026-08-30 19:15:10 KST";
    const dispatchId = "ctx_hyk396_open_axis_contam_d1";

    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt: genuineDroppedAt,
      dispatchId,
    });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId,
      droppedAt: spuriousDroppedAt,
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
        recordedAt: "2026-08-30T10:00:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt: genuineDroppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9700-open-axis-contam-next",
      droppedAt: "2026-08-30 20:00:00 KST",
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
      `기대: ALLOW(오늘 실측 그대로 -- 가장 높은 번호는 스퓨리어스지만, 이 라운드 자신의 dispatch_id로 각인된 진짜 사본을 찾아 재시도해야 한다). 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stderr, /DISPATCH_ID_ARCHIVE_SELECT/);
  });
});

// ===========================================================================
// ⓑ 재드롭 -- 같은 라벨 재드롭(사본마다 실제 dispatch_id 각인) · 새 라운드
// 결과 미작성 -> ⛔REJECT.
// ===========================================================================
test("ⓑ 재드롭: 같은 라벨 재드롭(사본마다 실제 dispatch_id 각인, 실배달 2건) · 새 라운드 결과 미작성 -> REJECT", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9701-open-axis-redrop-1";
    const t1DroppedAt = "2026-08-30 10:00:00 KST";
    const t2DroppedAt = "2026-08-30 11:00:00 KST";
    const doneAt = "2026-08-30 10:05:10 KST";
    const d1 = "ctx_hyk396_open_axis_redrop_d1";
    const d2 = "ctx_hyk396_open_axis_redrop_d2";

    // r1 = 첫 드롭 자신의 사본(실제 진짜 dispatch_id d1). r2 = 재드롭이
    // 만든 사본(실제 진짜 dispatch_id d2, 서로 다른 진짜 배달).
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
    // 재드롭 자신의 결과는 아직 없다 -- live 결과는 여전히 첫 드롭 자신의
    // 것 그대로다(재드롭 워커가 아직 덮어쓰지 않았다).
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: d1,
        recordedAt: "2026-08-30T00:30:00.000Z", // doneAt 이전 -- 첫 드롭 자신의 실배달.
      },
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: d2,
        recordedAt: "2026-08-30T02:00:00.000Z", // doneAt 이후 -- 재드롭 자신의 실배달.
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
      taskId: "HYK-9701-open-axis-redrop-followup",
      droppedAt: "2026-08-30 12:00:00 KST",
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
      `기대: REJECT(이 라벨의 실배달이 2건이라 여는 축 자체가 꺼진다 -- countDistinctDispatchIdsForLabel!==1). 실제 stdout=${r.stdout}`,
    );
    assert.doesNotMatch(r.stderr, /DISPATCH_ID_ARCHIVE_SELECT/);
  });
});

// ===========================================================================
// ⓒ 위조 -- 사본 각인만 원장과 다름 -> ⛔REJECT.
// ===========================================================================
test("ⓒ 위조: 6성분은 전부 진짜로 일치(옛 로직이면 ALLOW)하지만 보존 사본에 각인된 dispatch_id가 원장의 실제 값과 다름 -> REJECT", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9702-open-axis-forged-1";
    const droppedAt = "2026-08-30 09:00:00 KST";
    const doneAt = "2026-08-30 09:05:10 KST";
    const realDispatchId = "ctx_hyk396_open_axis_forged_real";
    const forgedDispatchId = "ctx_hyk396_open_axis_forged_FAKE";

    // 사본 각인은 위조값 -- droppedAt은 영수증과 정확히 일치(6성분 자체는
    // 통과한다는 것을 증명하기 위해).
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
        recordedAt: "2026-08-30T00:00:00.000Z",
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
      taskId: "HYK-9702-open-axis-forged-next",
      droppedAt: "2026-08-30 12:00:00 KST",
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
      `기대: REJECT(위조 각인이 원장 실값과 다름). 실제 stdout=${r.stdout}`,
    );
    assert.match(r.stderr, /위조 또는 다른 배달의 사본/);
  });
});

// ===========================================================================
// ⓓ 경계값 -- 두 사본이 같은 배달 id로 각인 -> 명시 결정(REJECT, ⛔애매
// 통과 금지).
// ===========================================================================
test("ⓓ 경계값: 두 사본이 «같은» 배달 id로 각인 -> REJECT(AMBIGUOUS, 조용히 하나를 고르지 않는다)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9703-open-axis-boundary-1";
    const t1 = "2026-08-30 18:00:00 KST"; // r1
    const t2 = "2026-08-30 19:00:00 KST"; // r2 -- r1과 같은 dispatch_id
    const t3 = "2026-08-30 20:00:00 KST"; // r3 -- 가장 높은 번호, 미각인(1차 대조를 실패시켜 재시도를 유도)
    const doneAt = "2026-08-30 18:05:10 KST";
    const dispatchId = "ctx_hyk396_open_axis_boundary_d1";

    writeArchivedTaskCopy(dir, role, 1, { taskId, droppedAt: t1, dispatchId });
    writeArchivedTaskCopy(dir, role, 2, { taskId, droppedAt: t2, dispatchId });
    writeArchivedTaskCopy(dir, role, 3, {
      taskId,
      droppedAt: t3,
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
        recordedAt: "2026-08-30T09:00:00.000Z",
      },
    ]);

    // 영수증은 두 ambiguous 사본 중 더 높은 번호(r2, t2)의 droppedAt에
    // 결속한다 -- findArchivedRoundMeta의 AMBIGUOUS 선택이 idMatches 중
    // 더 높은 roundNum을 대표값으로 싣는 것과 정확히 맞물려야 재시도가
    // 결속까지는 성공하고(그래야 veto가 AMBIGUOUS 사유로 명시 거부한다).
    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt: t2,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9703-open-axis-boundary-next",
      droppedAt: "2026-08-30 21:00:00 KST",
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
    assert.notEqual(
      r.status,
      0,
      `기대: REJECT(같은 dispatch_id로 각인된 사본이 2벌이라 어느 것이 진짜인지 결정할 수 없다). 실제 stdout=${r.stdout}`,
    );
    assert.match(r.stderr, /결정할 수 없다/);
  });
});

// ===========================================================================
// ⓔ ABSENT 조합 -- 진짜 사본이 미각인 + 스퓨리어스가 더 높음 -> 명시 결정
// (REJECT, 3R 계약과 정합 -- 이 여는 축의 idMatches가 0개라 새 선택축
// 자체가 발동하지 않는다, HYK-394 (a)가 이미 기재한 "아직 안 풀린 한계"와
// 동일한 모양).
// ===========================================================================
test("ⓔ ABSENT 조합: 진짜 사본이 미각인 + 스퓨리어스가 더 높음(둘 다 미각인) -> REJECT(여는 축 idMatches=0, 3R 계약과 정합)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9704-open-axis-absent-1";
    const genuineDroppedAt = "2026-08-30 08:00:00 KST";
    const spuriousDroppedAt = "2026-08-30 08:30:00 KST";
    const doneAt = "2026-08-30 08:05:10 KST";
    const dispatchId = "ctx_hyk396_open_axis_absent_d1";

    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt: genuineDroppedAt,
      dispatchId: undefined,
    });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId,
      droppedAt: spuriousDroppedAt,
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
        recordedAt: "2026-08-30T00:00:00.000Z",
      },
    ]);

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt: genuineDroppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9704-open-axis-absent-next",
      droppedAt: "2026-08-30 12:00:00 KST",
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
    assert.notEqual(
      r.status,
      0,
      `기대: REJECT(각인된 사본이 하나도 없어 여는 축 자체가 발동하지 않는다 -- 3R까지의 알려진 한계, HYK-394 (a) 참조). 실제 stdout=${r.stdout}`,
    );
  });
});

// ===========================================================================
// ⓕ 회귀 -- 각인 이전 옛 사본만 있는 경우 -> ★ALLOW(릴레이 정지 방지).
// ===========================================================================
test("ⓕ 회귀: 각인 이전 옛 사본만 있는 경우(dispatch_id 필드 자체가 없음) -> ALLOW", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskId = "HYK-9705-open-axis-legacy-1";
    const droppedAt = "2026-08-01 10:00:00 KST";
    const doneAt = "2026-08-01 10:05:10 KST";

    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt,
      dispatchId: undefined,
    });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    // dispatch-receipts.jsonl 자체가 없다(이행 기간 이전 -- 옛 라운드는
    // 이 파일이 생기기도 전이다). --dispatch-receipt-path를 아예 넘기지
    // 않는다 -- lookupDispatchId가 PATH_UNSET으로 물러난다(지어내지 않음).

    writeConsumptionReceipt(
      dir,
      role,
      {
        taskId,
        role: role.toUpperCase(),
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
        // dispatchId 필드 없음 -- 옛 영수증도 이 축이 생기기 전이라 없다.
      },
      BASE_EFFECTS,
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9705-open-axis-legacy-next",
      droppedAt: "2026-08-01 12:00:00 KST",
      headCommit: "f".repeat(40),
    });

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(
      r.status,
      0,
      `기대: ALLOW(각인 이전 옛 사본 -- 여는 축은 발동하지 않고 기존 6성분 결속만으로 판정, 회귀 0). 실제 stdout=${r.stdout} stderr=${r.stderr}`,
    );
  });
});

// ===========================================================================
// Q1 실측 확인용 부가 시험: "배달 재시도마다 사본이 한 벌 늘어난다"는 ORCH
// 해석이 사실인지 -- REJECT로 끝나는 배달 시도조차 dropped_at을 다시
// 찍고 사본을 한 벌 더 보존하는지 CLI를 두 번 연속 돌려 직접 관찰한다
// (coder.md Q1 답의 실행 증거, dispatch-gate-decision.mjs의
// bestEffortStampDroppedAt 호출이 그 어떤 게이트 판정보다도 먼저 무조건
// 실행된다는 배선 자체를 실증 -- runDispatchGateDecision 안에서
// checkGatePreconditions/게이트 스폰보다 앞선 자리).
// ===========================================================================
// HYK-257-done-stamp-2 §2/HYK-307-order-1 §1의 실물 배선(dropped-at-stamp-core.mjs
// formatKstMinute)은 «분» 단위 정밀도다 -- 같은 초 안에서 두 번 CLI를
// 돌리면(이 시험처럼) 두 stamp가 같은 분에 찍혀 rewritten===original(값
// 불변)이 되고, bestEffortSnapshotRoundTaskFile은 그래도 부르지만
// archiveRoundTaskFileIfNew의 동일-내용 중복 방지가 두 번째 호출을
// 조용히 skip한다 -- 그래서 "매 CLI 호출마다 사본이 늘어난다"가 아니라
// "매 호출마다 dropped_at을 다시 찍고(그 결과가 이전과 다르면) 사본을
// 한 벌 더 보존한다"가 정확한 사실이다(오늘 실측 5벌도 각각 다른 분
// 18:40/19:13/19:36/19:37/19:45에 찍혔다 -- 실제 ORCH 재시도는 초 단위가
// 아니라 분 단위 이상 간격이라 이 조건이 항상 성립한다). 이 시험은 그
// 정확한 사실을 단일 호출로, 시각 흐름에 기대지 않고 증명한다: REJECT로
// 끝나는 호출 «전에도» dropped_at 재계산·재보존이 일어나는지 관찰한다.
test("Q1 실측: precondition 단계에서 즉시 REJECT되는 요청(task_id 줄이 없음)도, 배달 거부 여부와 무관하게 dropped_at을 기계로 다시 찍고 rounds/ 사본을 보존한다", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const taskPath = join(dir, `${role}-task.md`);
    const staleDroppedAt = "2026-01-01 00:00 KST"; // 실제 지금과 절대 같은 분일 수 없는, 먼 과거 값.
    // ⛔task_id: 줄이 없다 -- checkGatePreconditions(dispatch-gate-decision-core.mjs)가
    // taskIdMatchCount!==1이면 곧바로 REJECT하는, 게이트가 하나도 스폰되지
    // 않는 가장 얕은 실패 사례를 고른다(다른 축의 개입 최소화). dropped_at:
    // 줄만 있으면 bestEffortStampDroppedAt(task_id 유무와 무관하게 동작,
    // runDispatchGateDecision 안에서 그 어떤 게이트 판정보다도 먼저 호출됨)이
    // 이 실패보다 먼저 무조건 돈다.
    writeFileSync(
      taskPath,
      `dropped_at: ${staleDroppedAt}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r1 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.notEqual(r1.status, 0, "REJECT(task_id 줄 없음) -- 배달은 막힌다");

    const rewritten = readFileSync(taskPath, "utf8");
    assert.doesNotMatch(
      rewritten,
      new RegExp(
        `dropped_at:\\s*${staleDroppedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
      "Q1: REJECT로 끝난 호출도 taskPath 자신의 dropped_at을 기계로 다시 찍어야 한다(옛 값이 남아 있으면 안 됨)",
    );
    assert.match(
      rewritten,
      /^dropped_at:\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\s*$/m,
      "Q1: 새로 찍힌 dropped_at도 여전히 '분 단위 KST' 모양이어야 한다",
    );

    const roundsDir = join(dir, "rounds");
    const preserved = readdirSync(roundsDir).filter((n) =>
      /^CODER-task-r\d+\.md$/i.test(n),
    );
    assert.equal(
      preserved.length,
      1,
      `Q1: REJECT로 끝난 호출도 그 순간의(재스탬프된) task 파일 원문을 rounds/에 한 벌 보존해야 한다(실제: ${preserved.join(", ")})`,
    );
    const archivedBody = readFileSync(join(roundsDir, preserved[0]), "utf8");
    assert.match(
      archivedBody,
      /dropped_at=\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST/,
      "Q1: 보존된 사본의 헤더도 새로 찍힌(옛 값이 아닌) dropped_at을 담고 있어야 한다 -- 매 호출(성공/거부 무관)마다 그 순간의 dropped_at이 그대로 보존된다는 증거(원인=dispatch-gate-decision.mjs의 runDispatchGateDecision이 게이트/전제조건 판정보다 먼저 bestEffortStampDroppedAt을 무조건 호출)",
    );
  });
});

// ===========================================================================
// Q4 되돌림 변이 -- 여는 축(tryDispatchIdArchiveSelection 호출)을
// 되돌리면 ⓐ가 다시 REJECT되는지 확인한다(=이 수리가 실제로 여는지).
// hyk241-oneb-gate-mutation.test.mjs 선례와 동일한 형태: 실제
// dispatch-gate-decision.mjs 소스를 문자열 치환으로 임시 사본에만
// 적용하고, 그 사본만 별도 tmpdir에서 CLI로 실행한다 -- 원본 파일은
// 절대 건드리지 않는다.
// ===========================================================================
const DISPATCH_GATE_DECISION_SRC_PATH = SCRIPT_PATH;
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

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "dispatch-gate-decision.mjs": readFileSync(
      DISPATCH_GATE_DECISION_SRC_PATH,
      "utf8",
    ),
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

function runMutatedCli(scriptsCheckDir, args) {
  try {
    const stdout = execFileSync(
      "node",
      [join(scriptsCheckDir, "dispatch-gate-decision.mjs"), ...args],
      { encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ⓐ와 완전히 동일한 fixture를 만드는 헬퍼(위 test ⓐ 본문과 바이트
// 단위로 같은 모양 -- 되돌림 전/후 비교가 fixture 차이 때문이 아니라
// 오직 코드 변이 때문임을 보장한다).
function writeContaminationFixture(dir) {
  const role = "coder";
  const taskId = "HYK-9700-open-axis-contam-mut-1";
  const genuineDroppedAt = "2026-08-30 19:13:00 KST";
  const spuriousDroppedAt = "2026-08-30 19:45:00 KST";
  const doneAt = "2026-08-30 19:15:10 KST";
  const dispatchId = "ctx_hyk396_open_axis_contam_mut_d1";

  writeArchivedTaskCopy(dir, role, 1, {
    taskId,
    droppedAt: genuineDroppedAt,
    dispatchId,
  });
  writeArchivedTaskCopy(dir, role, 2, {
    taskId,
    droppedAt: spuriousDroppedAt,
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
      recordedAt: "2026-08-30T10:00:00.000Z",
    },
  ]);

  writeConsumptionReceipt(
    dir,
    role,
    {
      taskId,
      role: role.toUpperCase(),
      droppedAt: genuineDroppedAt,
      resultFingerprint: computeFingerprint(resultContent),
      doneAt,
    },
    BASE_EFFECTS,
    1,
  );

  const taskPath = writeNextTaskFile(dir, role, {
    taskId: "HYK-9700-open-axis-contam-mut-next",
    droppedAt: "2026-08-30 20:00:00 KST",
    headCommit: "a".repeat(40),
  });

  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });

  return { taskPath, ledgerPath, dispatchReceiptPath };
}

test("Q4 되돌림 변이: tryDispatchIdArchiveSelection 호출을 되돌리면(null로 고정) ⓐ가 다시 REJECT된다 -> 이 수리가 실제로 여는지 확인", () => {
  const src = readFileSync(DISPATCH_GATE_DECISION_SRC_PATH, "utf8");
  const target =
    "  const idSelection = tryDispatchIdArchiveSelection({\n" +
    "    role,\n" +
    "    currentBinding,\n" +
    "    candidates,\n" +
    "    harnessDir,\n" +
    "    harnessTaskLabel,\n" +
    "    receiptPath,\n" +
    "  });\n";
  assertExactlyOneMatch(src, target, "tryDispatchIdArchiveSelection call site");
  const mutated = src.replace(
    target,
    "  const idSelection = null; // HYK-396 여는 축 되돌림(Q4 변이 시험)\n",
  );

  withFixtureDir((fixtureDir) => {
    const { taskPath, ledgerPath, dispatchReceiptPath } =
      writeContaminationFixture(fixtureDir);

    withFixtureDir((stagingDir) => {
      const scriptsCheckDir = stageScriptsCheckDir(stagingDir, {
        "dispatch-gate-decision.mjs": mutated,
      });
      const r = runMutatedCli(scriptsCheckDir, [
        taskPath,
        "--ledger",
        ledgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
      ]);
      assert.notEqual(
        r.status,
        0,
        `되돌림(RED 확인): 여는 축을 껐으면 ⓐ(오염)가 다시 REJECT돼야 한다(수리가 실제로 이 사례를 여는 것이었다는 증거). 실제 stdout=${r.stdout}`,
      );
      assert.match(r.stderr, /일치하는 것이 없음/);
    });
  });
});

test("Q4 대조: 원본(되돌리지 않은) 소스를 그대로 스테이징해도 ⓐ는 여전히 ALLOW(스테이징 메커니즘 자체가 원인이 아님을 확인)", () => {
  withFixtureDir((fixtureDir) => {
    const { taskPath, ledgerPath, dispatchReceiptPath } =
      writeContaminationFixture(fixtureDir);

    withFixtureDir((stagingDir) => {
      const scriptsCheckDir = stageScriptsCheckDir(stagingDir, {});
      const r = runMutatedCli(scriptsCheckDir, [
        taskPath,
        "--ledger",
        ledgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
      ]);
      assert.equal(
        r.status,
        0,
        `대조(GREEN 확인): 되돌리지 않은 원본 소스를 스테이징하면 ⓐ는 그대로 ALLOW여야 한다. 실제 stdout=${r.stdout} stderr=${r.stderr}`,
      );
    });
  });
});
