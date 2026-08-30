// HYK-394 (2026-08-30 00:31 범위 추가, 책임자 승인) -- Q7/Q8/Q9 조사 기록.
//
// ★결론 먼저: Q7이 제안한 완화("가장 높은 번호 사본 하나" -> "사본 중
// 하나라도 결속 6성분 전체와 일치하면 소비로 인정")를 실제로 구현해서
// dispatch-gate-decision.mjs에 넣어 봤고, Q8이 요구한 적대 표본으로
// 직접 검증했다. ★적대 표본이 통과했다(뚫렸다) -- 그래서 Q8 지시
// 원문("통과시키면 완화를 넣지 마라") 그대로, 그 완화는 반려하고
// dispatch-gate-decision.mjs를 원래 로직(findArchivedDroppedAt, 가장
// 높은 번호 사본 하나만 대조)으로 되돌렸다. 이 파일은 그 판단을 코드로
// 고정한 기록이다 -- 아래 두 시험 모두 지금(반려 후) 코드의 실제
// 동작을 단언한다.
//
// Q7 배경(실측, coder-task.md §1 원문): 보존 워크트리 2개는 같은 라벨의
// 보존 사본이 두 벌이고(예: `review-task-r2`=18:31 / `r3`=18:49), 실제
// 소비 영수증은 18:31에 결속됐는데, dispatch-gate-decision.mjs의
// findArchivedDroppedAt은 «가장 높은 번호 사본»(18:49)의 droppedAt만
// 보고 대조하므로 매번 불일치 -> REJECT -> 릴레이가 재가동되지 않는다.
// 시험 (a)는 이 상황을 그대로 재현한다 -- ★지금 코드는 여전히 REJECT
// 한다(알려진, 아직 풀지 않은 한계 -- 아래 이유 참조).
//
// Q8 ★★급소(왜 Q7의 완화를 넣지 않았는가): 시험 (b)가 만드는 적대
// 표본 -- 같은 task_id가 재드롭(재배달)되고, 재드롭된 새 라운드는 아직
// 결과를 전혀 안 낸(결과 파일이 «첫 드롭 라운드»의 낡은 내용 그대로)
// 상황 -- 은 데이터 모양이 (a)의 "재스탬프 버그로 같은 라운드가 중복
// 보존됨" 상황과 「같은 라벨의 보존 사본이 여러 벌, 그 중 하나의
// droppedAt이 옛 영수증과 일치」라는 점에서 구별 불가능하다. taskId/
// role/droppedAt/resultFingerprint/doneAt(재드롭도 같은 task_id를 쓰므로
// 전부 옛 라운드와 동일하게 재구성된다) 6성분만으로는 "이 사본들이
// 진짜로 같은 라운드의 중복 보존인지, 아니면 우연히 같은 task_id를
// 재사용한 서로 다른 라운드인지"를 원리적으로 가를 수 없다 -- 그래서
// Q7의 완화를 프로토타입해 실제로 실행해 보니 (a)는 ALLOW로 고쳐졌지만
// (b)도 함께 ALLOW로 새어(재드롭된, 진짜로는 미소비인 라운드가 소비됨
// 판정을 받음) 버렸다(실행 로그는 git 이력의 이 파일 이전 버전 커밋
// 참조 -- 완화를 넣었을 때의 실제 두 시험 출력을 그대로 남겼다).
// ⛔이 로직을 다시 완화하려면 먼저 "같은 task_id 재사용이 이 저장소에서
// 구조적으로 불가능하다"는 것을 별도로 증명하거나, 재사용을 막는 상위
// 계층 불변식(예: task_id 유일성 강제)을 함께 도입해야 한다(이 라운드
// 범위 밖 -- coder.md에 그대로 기재).
//
// Q9: 같은 fixture 계열로 "레거시 다중 사본 상황(legit) -> 여전히
// REJECT(알려진 한계)"와 "적대 재드롭 상황(adversarial) -> REJECT(안전,
// 완화를 넣지 않았기 때문)"를 둘 다 관측 가능한 형태로 고정한다 -- 두
// 시험 모두 REJECT를 기대하는 것 자체가 "이 라운드는 Q7을 배송하지
// 않았다"는 사실의 증거다.
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
  const dir = mkdtempSync(join(tmpdir(), "hyk394-q7q8-test-"));
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

function writeDispatchReceiptLine(
  path,
  { role, harnessTaskLabel, dispatchId },
) {
  const record = {
    recorded_at: "2026-08-01T00:00:00.000Z",
    runtime_task_id: "task_hyk394fixed0000",
    dispatch_id: dispatchId,
    assignee_pane_key: "test-pane-key",
    dispatch_timestamp_utc: "2026-08-01T00:00:00.000Z",
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: harnessTaskLabel,
  };
  writeFileSync(path, JSON.stringify(record) + "\n", "utf8");
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

// ---------------------------------------------------------------------------
// Q7/Q9 (a): 실사고 재현 -- 같은 라벨의 보존 사본이 재스탬프 버그로 2벌
// 생겼고(r1=진짜 droppedAt, r2=스퓨리어스/더 높은 번호 droppedAt), 영수증은
// r1의 droppedAt에 결속돼 있다. ★알려진 한계: 이 라운드는 Q7의 완화를
// 배송하지 않았으므로(위 헤더, Q8 실패 때문) 이 상황은 여전히 REJECT다
// -- 다음에 이 축을 다시 시도하려면 헤더의 ⛔조건을 먼저 만족해야 한다.
// ---------------------------------------------------------------------------
test("Q7/Q9(a) 실사고 재현 (알려진 한계, 아직 미수리): 같은 라벨 보존 사본 2벌(진짜 droppedAt=r1, 스퓨리어스 더 높은 번호 droppedAt=r2) + 영수증은 r1에 결속 -> 여전히 REJECT(가장 높은 번호 사본 r2만 대조하기 때문)", () => {
  withFixtureDir((dir) => {
    const role = "review";
    const taskId = "HYK-9401-q7-legit-1";
    const genuineDroppedAt = "2026-08-14 18:31:00 KST";
    const spuriousDroppedAt = "2026-08-14 18:49:00 KST"; // 재스탬프 버그가 만든 "더 높은 번호"의 가짜 droppedAt
    const doneAt = "2026-08-14 18:35:10 KST";

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

    const taskPath = join(dir, `${role}-task.md`);
    writeFileSync(
      taskPath,
      `task_id: HYK-9401-q7-legit-next\ndropped_at: 2026-08-14 19:00:00 KST\nhead_commit: ${"a".repeat(40)}\n${ONE_B_BLOCK}`,
      "utf8",
    );

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: role.toUpperCase(),
      harnessTaskLabel: taskId,
      dispatchId: "ctx_hyk394_q7_legit",
    });
    // 영수증은 «진짜»(r1) droppedAt에 결속되어 있다 -- «가장 높은 번호»(r2)와는 다르다.
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
      `알려진 한계: 지금 코드는 "가장 높은 번호 사본"(r2, 영수증과 다른 droppedAt)만 대조하므로 REJECT 기대 -- 실제 stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /일치하는 것이 없음/);
  });
});

// ---------------------------------------------------------------------------
// Q8 ★★급소 (지금 코드가 안전함을 증명): 같은 task_id가 재드롭되고, 그
// 재드롭된 새 라운드가 아직 결과를 전혀 안 낸(결과 파일이 «첫 드롭
// 라운드»의 낡은 내용 그대로) 상황에서도, 지금 코드(Q7 완화를 넣지 않은
// 원래 로직)는 옛 영수증과의 우연한 부분 데이터 일치로 속지 않고 REJECT
// 한다 -- «가장 높은 번호 사본»(재드롭 자신의 droppedAt)만 대조하므로,
// 재드롭 자신의 droppedAt이 옛 영수증의 droppedAt과 다른 한 자동으로
// 안전하다. 이것이 바로 Q7의 완화를 넣지 않기로 한 이유(위 헤더)다.
// ---------------------------------------------------------------------------
test("Q8 ★★적대 표본: 같은 task_id 재드롭 + 새 라운드 결과 미작성(낡은 결과 파일 그대로) -> REJECT(지금 코드는 완화를 넣지 않았으므로 안전)", () => {
  withFixtureDir((dir) => {
    const role = "review";
    const taskId = "HYK-9402-q8-redrop-1"; // 재드롭도 같은 task_id를 그대로 재사용(적대 시나리오 정의 그대로)
    const t1DroppedAt = "2026-08-20 10:00:00 KST";
    const t2DroppedAt = "2026-08-20 11:00:00 KST"; // 재드롭 시각(더 높은 번호)
    const doneAt = "2026-08-20 10:05:10 KST"; // T1 라운드가 남긴, 여전히 낡은 doneAt

    writeArchivedTaskCopy(dir, role, 1, { taskId, droppedAt: t1DroppedAt });
    writeArchivedTaskCopy(dir, role, 2, { taskId, droppedAt: t2DroppedAt });

    // review.md(결과 파일)는 재드롭된 새 라운드의 워커가 «아직 아무것도
    // 안 해서» T1 라운드가 남긴 내용 그대로다.
    const resultPath = join(dir, `${role}.md`);
    const resultContent = `task_id: ${taskId}\nverdict: approved\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(resultPath, resultContent, "utf8");

    const taskPath = join(dir, `${role}-task.md`);
    writeFileSync(
      taskPath,
      `task_id: HYK-9402-q8-redrop-followup\ndropped_at: 2026-08-20 12:00:00 KST\nhead_commit: ${"b".repeat(40)}\n${ONE_B_BLOCK}`,
      "utf8",
    );

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: role.toUpperCase(),
      harnessTaskLabel: taskId,
      dispatchId: "ctx_hyk394_q8_redrop",
    });
    // 옛 영수증은 T1(첫 드롭)에 결속되어 있다.
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
