// HYK-394-dispatch-id-bind-2 -- Q1~Q4/Q9 실증 (최종: P2 완화 재반려 후 상태).
//
// ★결론 먼저: P1(dispatch_id를 "판정 시점 재계산"이 아니라 "이 라운드
// 자신의 완료 시각(doneAt)보다 엄격히 이전에 기록된 항목"에 고정하는 anchor
// -- dispatch-gate-decision.mjs의 findLatestReceiptMatch/lookupDispatchId/
// enrichCandidateDispatchId/evaluateConsumptionDecision)는 그대로 남겼다 --
// HYK-394 1R이 실측한 "재계산은 stale해서 아무것도 못 막는다"는 결함을
// 실제로 닫는, 독립적으로 안전한 개선이다. P2(1R이 안전하지 않아 되돌렸던
// "가장 높은 번호 사본 하나만 보지 않고 사본 중 하나라도 일치하면 소비
// 인정" 완화)는 이 라운드에서 dispatch_id anchor와 함께 다시 넣어 직접
// 실행해 봤지만(시험 (b)), ★여전히 뚫렸다 -- 그래서 Q8 지시 원문
// ("통과시키면 넣지 마라") 그대로 다시 반려했다. 아래 두 시험은 그 최종
// (P2 반려 후) 코드의 실제 동작을 단언한다.
//
// P1 근거: dispatch_id 조회를 "이 라운드 자신의 완료 시각(doneAt)보다
// «엄격히 이전»에 기록된 항목 중 최신"으로 고정한다 -- relay-handshake.mjs의
// resolveDispatchRecordExistence가 이미 같은 "<" 경계·같은 필드
// (`recorded_at`)로 검증해 둔 관례를 그대로 재사용한다(새 설계 아님). 이
// anchor는 currentBinding 쪽(resultText 자신의 doneAt)과 candidate 쪽(그
// 영수증 자신의 binding.doneAt) 양쪽 모두에 독립적으로 적용된다 -- "지금이
// 언제인지"와 무관하게 항상 같은 답을 낸다(진짜 "박아 둔 값" 읽기).
//
// P2/Q8 ★★급소 -- 왜 여전히 반려하는가: 시험 (b)가 만드는 적대 표본(같은
// task_id 재드롭 + 재드롭이 아직 결과를 전혀 안 낸 상황)에서, dispatchId
// anchor는 재드롭 자신의(더 나중에 기록된) dispatch_id를 정확히 걸러내지만,
// "가장 높은 번호가 아닌" droppedAt 트라이얼(=첫 드롭 자신의 droppedAt)은
// 옛 영수증과 «진짜로» 결속 6성분 전체가 일치한다 -- dispatchId조차 양쪽
// 다 올바르게 "첫 드롭 자신의 dispatch_id"로 정확히 고정되기 때문이다. 이
// 트라이얼이 참인 이유는 "재계산 버그"가 아니라 "resultText가 실제로 첫
// 드롭 라운드 그대로이고, 그 라운드는 실제로 소비됐다"는 사실 그 자체다 --
// dispatch_id 결속으로는 원리적으로 닫을 수 없는 구멍이다. 그래서 P2는
// 반려하고 findArchivedDroppedAt("가장 높은 번호 사본 하나만 대조",
// 무변경)만 유일한 조회로 남긴다 -- 그 "가장 높은 번호만" 제약 자체가
// fixture (b)를 막아 준다(droppedAt 자체가 불일치로 떨어진다). 대가:
// fixture (a)(1R의 원래 재스탬프-중복 실사고)는 이 라운드에서도 여전히
// REJECT다(1R과 동일한, 아직 풀지 않은 한계 -- coder.md §8/§10에 기재).
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
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk394-dispatch-id-bind-test-"));
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

function writeArchivedTaskCopy(dir, role, round, { taskId, droppedAt }) {
  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  const upperRole = role.toUpperCase();
  const header = `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${droppedAt} -->\n`;
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

// ---------------------------------------------------------------------------
// (a) Q3-ⓐ/Q9 (알려진 한계, P1 단독으로는 아직 안 풀림): 같은 라벨의 보존
// 사본 2벌(진짜 droppedAt=r1, 재스탬프 버그가 만든 스퓨리어스/더 높은
// 번호 droppedAt=r2), 영수증은 r1에 결속, 배달 영수증에는 실제 배달 1건
// (dispatch_id 1개)뿐이다. P2(사본 중 하나라도 일치하면 인정)를 반려했으므로
// "가장 높은 번호"(r2)만 대조하는 지금 코드는 여전히 REJECT다.
// ---------------------------------------------------------------------------
test("(a) Q3-ⓐ/Q9 (알려진 한계, 아직 미수리): 같은 라벨 보존 사본 2벌(재스탬프 중복) + 단일 실배달 -> 여전히 REJECT(가장 높은 번호 사본만 대조하기 때문, P2 반려)", () => {
  withFixtureDir((dir) => {
    const role = "review";
    const taskId = "HYK-9501-legit-duplicate-1";
    const genuineDroppedAt = "2026-08-14 18:31:00 KST";
    const spuriousDroppedAt = "2026-08-14 18:49:00 KST";
    const doneAt = "2026-08-14 18:35:10 KST";
    const dispatchId = "ctx_hyk394_2r_legit_d1";

    writeArchivedTaskCopy(dir, role, 1, {
      taskId,
      droppedAt: genuineDroppedAt,
    });
    writeArchivedTaskCopy(dir, role, 2, {
      taskId,
      droppedAt: spuriousDroppedAt,
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
        recordedAt: "2026-08-14T09:00:00.000Z",
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
      {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
        ledgerRecorded: true,
      },
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9501-legit-duplicate-next",
      droppedAt: "2026-08-14 19:00:00 KST",
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
    assert.notEqual(
      r.status,
      0,
      `알려진 한계: P2를 반려했으므로 "가장 높은 번호 사본"(r2, 영수증과 다른 droppedAt)만 대조 -- REJECT 기대. 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /일치하는 것이 없음/);
  });
});

// ---------------------------------------------------------------------------
// (b) ★★Q8 급소 (지금 코드가 안전함을 증명): 같은 task_id 재드롭(서로 다른
// 실제 dispatch_id 2건, D2는 doneAt 이후에 기록됨) + 새 라운드 결과
// 미작성. "가장 높은 번호 사본"(재드롭 자신의 droppedAt)만 대조하므로,
// 재드롭 자신의 droppedAt이 옛 영수증의 droppedAt과 다른 한 REJECT --
// dispatch_id anchor가 있든 없든 이 축(droppedAt 불일치)이 안전망이다.
// ---------------------------------------------------------------------------
test("(b) ★★Q8 적대 표본: 같은 task_id 재드롭(서로 다른 실제 dispatch_id 2건) + 새 라운드 결과 미작성 -> REJECT(P2를 넣지 않았으므로 안전)", () => {
  withFixtureDir((dir) => {
    const role = "review";
    const taskId = "HYK-9502-redrop-1";
    const t1DroppedAt = "2026-08-20 10:00:00 KST";
    const t2DroppedAt = "2026-08-20 11:00:00 KST";
    const doneAt = "2026-08-20 10:05:10 KST";
    const d1 = "ctx_hyk394_2r_redrop_d1";
    const d2 = "ctx_hyk394_2r_redrop_d2";

    writeArchivedTaskCopy(dir, role, 1, { taskId, droppedAt: t1DroppedAt });
    writeArchivedTaskCopy(dir, role, 2, { taskId, droppedAt: t2DroppedAt });

    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptsLog(dispatchReceiptPath, [
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: d1,
        recordedAt: "2026-08-20T00:30:00.000Z", // BEFORE doneAt -- round1's real dispatch
      },
      {
        role: role.toUpperCase(),
        harnessTaskLabel: taskId,
        dispatchId: d2,
        recordedAt: "2026-08-20T02:00:00.000Z", // AFTER doneAt -- the redrop's real dispatch
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
      {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
        ledgerRecorded: true,
      },
      1,
    );

    const taskPath = writeNextTaskFile(dir, role, {
      taskId: "HYK-9502-redrop-followup",
      droppedAt: "2026-08-20 12:00:00 KST",
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
      `Q8: 재드롭된(아직 소비되지 않은) 새 라운드가 옛 영수증과의 우연한 전체 일치로 ALLOW되면 안 된다 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /일치하는 것이 없음/);
  });
});
