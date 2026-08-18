// HYK-244-receipt-wire-2b2/2b3 §4 -- 소비 완료 영수증 축이 실제로 배달 게이트
// 진입점(dispatch-gate-decision.mjs)에 결선됐는지를 증명한다.
// PM 원문(2R 완료조건): "함수가 존재한다"/"테스트에서 직접 불렀다"는 증거가
// 아니다 -- 이 파일은 실제 CLI를 spawn해서 exit code와 stdout/stderr을
// 관측한다(직접 함수 호출이 아니다). 실제 배달(dispatch-worker.ps1)은
// 여기서 하지 않는다(§4 금지 그대로) -- ORCH가 검토 승인 후 별도로 한다.
//
// HYK-244-receipt-wire-2b3 갱신(2026-08-14): 2b2가 제출한 8/8 GREEN은
// "실제 생산 경로가 만들어내지 않는 모양"의 합성 입력이었다(ORCH 실측,
// coder-task.md §3 원문) -- 실물 생산기(relay-handshake.mjs)는 결코
// dispatchId를 스스로 채우지 않고 역할을 대문자로 쓰는데, 옛 시험은 둘 다
// 손으로 갖춘 입력을 넣어 헛시험(vacuous pass)이 됐다. 이 개정은 (1) 모든
// 합성 픽스처를 "게이트가 실제로 도는 시점의 정확한 모양"(task 파일은
// 이미 다음 라운드로 덮여 있고, 결과 파일만 직전 라운드 것)으로
// 바꾸고, (2) §4-2-real 시험 하나를 추가해 실제 checkRelayHandshake가
// 만든, 손대지 않은 영수증으로 ALLOW를 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");
const CORE_PATH = join(HERE, "dispatch-gate-decision-core.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const REJECT_STREAK_CHAIN_PATH = join(HERE, "reject-streak-chain.mjs");
const CONSUMPTION_RECEIPT_CORE_PATH = join(
  HERE,
  "consumption-receipt-core.mjs",
);
// HYK-257-done-stamp-2 §2 범위2 / HYK-257-done-stamp-lint-1 (경로 수정):
// dispatch-gate-decision.mjs now statically imports
// scripts/check/dropped-at-stamp-core.mjs's stampDroppedAt (moved from
// scripts/relay/stamp-dropped-at.mjs to fix a scripts/check ->
// scripts/relay ESLint import-direction violation) -- this isolated
// fixture's staged tree must include it at the SAME relative path (`./`
// from scripts/check/) or the mutant module fails to load
// (MODULE_NOT_FOUND), same reasoning as CONSUMPTION_RECEIPT_CORE_PATH
// above.
const DROPPED_AT_STAMP_CORE_PATH = join(HERE, "dropped-at-stamp-core.mjs");
// HYK-298-abort-record-1 §2-2: same reasoning as
// CONSUMPTION_RECEIPT_CORE_PATH/DROPPED_AT_STAMP_CORE_PATH above --
// dispatch-gate-decision.mjs now statically imports the new abort-record
// core too.
const ABORT_RECORD_CORE_PATH = join(HERE, "abort-record-core.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-consumption-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// HYK-244 2R-b4: spawnSync를 쓴다(execFileSync가 아니다) -- execFileSync는
// 성공(exit 0) 시 stdout만 반환하고 stderr는 버린다(실패 시에만
// err.stderr로 접근 가능). PREDATES_RECEIPTS의 "조용한 통과 금지"(한용
// 확정 §2-2)를 증명하려면 exit 0인데도 stderr에 사유가 찍혔는지 확인해야
// 하므로, 성공/실패 무관하게 항상 stdout/stderr를 둘 다 반환하는
// spawnSync로 바꿨다(동작 동일, 관측 범위만 넓어짐).
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

// HYK-244 2R-b3 결함1 재현 방지: 게이트가 실제로 도는 시점엔 taskPath(
// `<role>-task.md`)가 이미 "다음에 보낼" 새 라운드로 덮여 있고, resultPath
// (`<role>.md`)만 아직 직전 라운드의 것이다 -- 이 두 라운드가 서로 다른
// task_id/dropped_at을 갖는 것이 실제 운영의 정확한 모양이다(같은 라운드로
// 합성하면 결함1이 절대 드러나지 않는다). archivePrev가 true면
// envelope-archive.mjs가 직전 라운드 완료 시 실제로 남기는 `.harness/
// rounds/<ROLE>-task-r1.md` 사본(헤더+원문)도 함께 만들어 findArchivedDroppedAt
// 이 그 droppedAt을 찾을 수 있게 한다.
function seedHandoff(dir, role, prev, next, { archivePrev = true } = {}) {
  const resultPath = join(dir, `${role}.md`);
  const resultContent = `task_id: ${prev.taskId}\n${prev.extra ?? ""}\n>>> DONE: ${role.toUpperCase()} @ ${prev.doneAt}\n`;
  writeFileSync(resultPath, resultContent, "utf8");

  if (archivePrev) {
    const roundsDir = join(dir, "rounds");
    mkdirSync(roundsDir, { recursive: true });
    const upperRole = role.toUpperCase();
    const header = `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${prev.droppedAt} -->\n`;
    writeFileSync(
      join(roundsDir, `${upperRole}-task-r1.md`),
      `${header}task_id: ${prev.taskId}\ndropped_at: ${prev.droppedAt}\n${ONE_B_BLOCK}`,
      "utf8",
    );
  }

  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${next.taskId}\ndropped_at: ${next.droppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
  return { taskPath, resultPath, resultContent };
}

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

// HYK-244 2R-b3 결함2 재현 방지: 실물 생산기(relay-handshake.mjs)는
// 완료 시점에 자기 dispatchId를 알 방법이 없어 만든 영수증에 그 키가
// 아예 없다(ORCH 실측 원문) -- 이 헬퍼가 만드는 합성 영수증도 일부러
// dispatchId를 생략해서, 게이트 쪽의 enrichCandidateDispatchId 보강
// 경로(defect2 수리분) 자체를 시험이 실제로 거치게 한다.
function buildConsumedFixture(
  dir,
  role,
  { prevTaskId, nextTaskId, droppedAt, doneAt, nextDroppedAt, dispatchId },
) {
  const { resultContent } = seedHandoff(
    dir,
    role,
    { taskId: prevTaskId, droppedAt, doneAt },
    { taskId: nextTaskId, droppedAt: nextDroppedAt },
  );
  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: role.toUpperCase(),
    harnessTaskLabel: prevTaskId,
    dispatchId,
  });
  writeConsumptionReceipt(
    dir,
    role,
    {
      taskId: prevTaskId,
      role: role.toUpperCase(),
      droppedAt,
      resultFingerprint: computeFingerprint(resultContent),
      doneAt,
      // dispatchId 의도적으로 생략(위 함수 헤더 참조).
    },
    { envelopeArchived: true, taskArchived: true, admissionReturned: true },
  );
  return { taskPath: join(dir, `${role}-task.md`), dispatchReceiptPath };
}

// ---------------------------------------------------------------------------
// §4-1: 미소비 상태 -> 비0 + 새 축 고유 사유.
// ---------------------------------------------------------------------------

test("§4-1 미소비 상태: 직전 라운드가 끝났는데 영수증이 하나도 없음 -> REJECT, dispatch-gate-decision 고유 축 사유(consumption-receipt)가 stderr에 나온다", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const prevTaskId = "HYK-9101-consumption-unconsumed-prev";
    const { taskPath } = seedHandoff(
      dir,
      "coder",
      {
        taskId: prevTaskId,
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
      },
      {
        taskId: "HYK-9101-consumption-unconsumed-next",
        droppedAt: "2026-08-14 10:00:00 KST",
      },
    );
    // dispatchId 조회는 "정말 없음"이 아니라 "정확히 성공"하게 만들어서
    // -- 이 표적이 격리하려는 원인이 dispatchId 미확정이 아니라
    // "영수증 후보가 하나도 없다"는 것 그 자체임을 분명히 한다.
    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: prevTaskId,
      dispatchId: "ctx_test_unconsumed",
    });
    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(r.status, 0, "미소비 상태는 배달을 거부해야 한다");
    assert.match(
      r.stderr,
      /consumption-receipt:/,
      "새 축(1R 코어)의 고유 사유 문자열이 stderr에 그대로 나와야 한다",
    );
    assert.match(r.stderr, /영수증 후보가 하나도 없음/);
  });
});

test("§4-1b dispatchId 조회 자체가 실패한 경우도 별개 사유로 거부(주 열쇠 미확정) -- 지어내지 않는다는 증거", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath } = seedHandoff(
      dir,
      "coder",
      {
        taskId: "HYK-9101b-consumption-no-receipt-path-prev",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
      },
      {
        taskId: "HYK-9101b-consumption-no-receipt-path-next",
        droppedAt: "2026-08-14 10:00:00 KST",
      },
    );
    // --dispatch-receipt-path도, env DISPATCH_RECEIPT_PATH도 없다.
    const r = runCli(SCRIPT_PATH, [taskPath, "--ledger", ledgerPath]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /consumption-receipt:/);
    assert.match(r.stderr, /배달 식별자\(dispatchId\)가 없거나 비어 있음/);
  });
});

// ---------------------------------------------------------------------------
// §4-2: 소비 완료 상태(유효 영수증 존재) -> ALLOW(exit 0), 오탐 0.
// ---------------------------------------------------------------------------

test("§4-2 소비 완료 상태: 유효한 영수증 + 배달 영수증에서 조회된 dispatchId -> ALLOW, exit 0(오탐 0)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildConsumedFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9102-consumption-consumed-prev",
        nextTaskId: "HYK-9102-consumption-consumed-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_consumed_1",
      },
    );

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(r.status, 0, `ALLOW 기대, 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// §4-2-real (HYK-244 2R-b3 §3 한용 확정 요구): 합성이 아니라 «실물 생산
// 경로»(checkRelayHandshake -> consumption-receipt-writer.mjs)가 실제로
// 만든 영수증을, 손대지 않고 그대로 게이트에 먹여서 ALLOW를 증명한다.
// ⛔ 이 시험 안에서 영수증 JSON을 손으로 만들지 않는다 -- 그것이 2b2가
// 반려된 이유(헛시험)다.
// ---------------------------------------------------------------------------

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

// §4-2-real 픽스처 구성만 분리(quality-check: eslint max-lines-per-function
// 유지 목적, 동작/단언 변경 없음) -- prev 라운드의 task/result를 실제
// 형태로 써 두고 이 저장소의 진짜 checkRelayHandshake를 그대로 불러
// envelope-archive/consumption-receipt-writer CLI가 실제로 만든
// receipts/CODER-receipt-r1.json을 손대지 않고 남긴다.
function produceRealReceiptForPriorRound(dir, prevTaskId) {
  const ledgerDir = mkdtempSync(
    join(tmpdir(), "dispatch-gate-consumption-real-ledger-"),
  );
  const admissionLedger = join(ledgerDir, "l.json");
  const admissionLock = join(ledgerDir, "l.lock");
  initAndAdmit(admissionLedger, admissionLock, prevTaskId);
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${prevTaskId}\ndropped_at: 2026-08-14 09:00:00 KST\n${ONE_B_BLOCK}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    // HYK-244 2R-b4: 제도 시행 시점(2026-08-14 08:50:27 KST) 이후로
    // 맞춘다 -- 아니면 이 시험이 실물 소비 완료(ALLOW)가 아니라
    // PREDATES_RECEIPTS 면제(다른 사유의 ALLOW)로 우연히 통과해 버려
    // 헛시험이 된다.
    `task_id: ${prevTaskId}\n\n>>> DONE: CODER @ 2026-08-14 09:10:05 KST\n`,
    "utf8",
  );
  try {
    // 관제실이 실제로 넘기는 그대로 대문자("CODER")로 부른다(ORCH가
    // 확인한 실물 영수증도 role: "CODER" -- 결함3 원문). 파일 경로는
    // Windows에서 대소문자 무관하므로 소문자로 만든 task/result 파일도
    // 그대로 찾는다(관제실이 실제로 그렇게 동작하는 것과 동일).
    return withEnv(
      {
        ADMISSION_LEDGER_PATH: admissionLedger,
        ADMISSION_LOCK_PATH: admissionLock,
      },
      () => checkRelayHandshake({ role: "CODER", harnessDir: dir }),
    );
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

test("§4-2-real 실물 생산 경로: checkRelayHandshake가 실제로 만든(손대지 않은) 영수증을 게이트가 그대로 먹으면 ALLOW", () => {
  withFixtureDir((dir) => {
    const prevTaskId = "HYK-9110-consumption-real-prev";
    const nextTaskId = "HYK-9110-consumption-real-next";

    // 1. 실물 생산 -- 합성 아님.
    const handshake = produceRealReceiptForPriorRound(dir, prevTaskId);
    assert.equal(
      handshake.ok,
      true,
      `실물 생산 경로 자체가 실패하면 이 시험의 전제가 무너진다: ${handshake.reason}`,
    );
    assert.deepEqual(
      readdirSync(join(dir, "receipts")),
      ["CODER-receipt-r1.json"],
      "실제로 영수증 파일이 생성됐다(합성 아님)",
    );
    const producedReceipt = JSON.parse(
      readFileSync(join(dir, "receipts", "CODER-receipt-r1.json"), "utf8"),
    );
    assert.equal(
      Object.hasOwn(producedReceipt.binding, "dispatchId"),
      false,
      "실물 생산기는 완료 시점에 자기 dispatchId를 모른다(§2 결함2 원문) -- 여기 없는 것이 정상이다",
    );

    // 2. prev 라운드 자신이 배달될 때 관제실이 이미 남겼을 배달
    //    영수증(HYK-219) -- 그 라운드 자신의 dispatch_id.
    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: prevTaskId,
      dispatchId: "ctx_test_real_prev",
    });

    // 3. 다음 라운드가 드롭돼 coder-task.md를 덮어썼다(결함1이 겨냥한
    //    바로 그 시점) -- coder.md/receipts/rounds는 1단계가 실제로
    //    만든 그대로 손대지 않는다.
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${nextTaskId}\ndropped_at: 2026-08-14 10:00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );

    // 4. 게이트를 실제 CLI로 돌린다 -- 1단계 산출물을 «손대지 않고
    //    그대로» 먹인다.
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli(SCRIPT_PATH, [
      join(dir, "coder-task.md"),
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(실물 생산 경로 산출물), 실제 stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);

    // 5. §3 point 3 그대로: 같은 실물 산출물에서 영수증만 «치워서»
    //    REJECT로 뒤집히는지 확인한다(별도로 합성한 미소비 표적이
    //    아니라, 방금 ALLOW를 만든 바로 그 영수증을 지운 것).
    rmSync(join(dir, "receipts", "CODER-receipt-r1.json"));
    const rAfterRemoval = runCli(SCRIPT_PATH, [
      join(dir, "coder-task.md"),
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      rAfterRemoval.status,
      0,
      "실물 영수증을 치우면 같은 표적이 REJECT로 뒤집혀야 한다",
    );
    assert.match(rAfterRemoval.stderr, /consumption-receipt:/);
    assert.match(rAfterRemoval.stderr, /영수증 후보가 하나도 없음/);
  });
});

// ---------------------------------------------------------------------------
// HYK-269 §3 오늘의 실물 사고 fixture: ORCH가 소비 명령을 소문자 인자
// (`relay-handshake.mjs coder .harness`)로 친 것과 정확히 같은 입력을
// 실물 checkRelayHandshake에 태운다. 정규화 이전이었다면 이 영수증의
// binding.role이 "coder"로 남아, 대문자로 굳는 currentBinding.role
// ("CODER")과 6성분 중 role 하나만 달라 다음 배달이 BINDING_MISMATCH로
// REJECT됐다(오늘 실측 원문 그대로). 이 시험은 정규화 이후 그 REJECT가
// 사라짐을 실물 게이트 CLI로 증명한다.
// ---------------------------------------------------------------------------
test("HYK-269 §3 실물 사고 fixture: 소문자 role 인자('coder')로 소비해도 영수증 role은 CODER로 남고, 다음 배달은 ALLOW(정규화 이전에는 이 표적이 REJECT였다)", () => {
  withFixtureDir((dir) => {
    const prevTaskId = "HYK-9111-lowercase-incident-prev";
    const nextTaskId = "HYK-9111-lowercase-incident-next";

    const ledgerDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-consumption-lowercase-ledger-"),
    );
    const admissionLedger = join(ledgerDir, "l.json");
    const admissionLock = join(ledgerDir, "l.lock");
    initAndAdmit(admissionLedger, admissionLock, prevTaskId);
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${prevTaskId}\ndropped_at: 2026-08-16 09:00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: ${prevTaskId}\n\n>>> DONE: CODER @ 2026-08-16 09:10:05 KST\n`,
      "utf8",
    );

    // ⛔오늘 실물 사고 그대로: 소문자 인자로 소비.
    let handshake;
    try {
      handshake = withEnv(
        {
          ADMISSION_LEDGER_PATH: admissionLedger,
          ADMISSION_LOCK_PATH: admissionLock,
        },
        () => checkRelayHandshake({ role: "coder", harnessDir: dir }),
      );
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
    assert.equal(handshake.ok, true);

    const receiptFiles = readdirSync(join(dir, "receipts"));
    assert.deepEqual(
      receiptFiles,
      ["coder-receipt-r1.json"],
      "영수증 파일명 관례는 소문자 그대로(변경 금지 대상)",
    );
    const producedReceipt = JSON.parse(
      readFileSync(join(dir, "receipts", "coder-receipt-r1.json"), "utf8"),
    );
    assert.equal(
      producedReceipt.binding.role,
      "CODER",
      "binding.role은 소문자 인자로 소비해도 정본 대문자로 굳어야 한다(HYK-269 정규화)",
    );

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: prevTaskId,
      dispatchId: "ctx_test_lowercase_incident",
    });

    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${nextTaskId}\ndropped_at: 2026-08-16 10:00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );

    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli(SCRIPT_PATH, [
      join(dir, "coder-task.md"),
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(소문자 소비도 정규화로 결속이 일치해야 한다), 실제 stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
  });
});

// §4-2 오탐 0 대조군의 픽스처 구성만 분리(quality-check: eslint
// max-lines-per-function 유지 목적, 동작/단언 변경 없음) -- 과거
// 라운드(다른 droppedAt/dispatchId) 영수증이 섞여 있어도 현재 라운드가
// 정확히 구별되는지 보려는 표적을 그대로 만든다.
function seedMixedReceiptsFixture(
  dir,
  { prevTaskId, droppedAt, doneAt, resultContent },
) {
  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(
    dispatchReceiptPath,
    [
      JSON.stringify({
        recorded_at: new Date().toISOString(),
        runtime_task_id: "task_stale",
        dispatch_id: "ctx_stale_prior",
        assignee_pane_key: "x",
        dispatch_timestamp_utc: new Date().toISOString(),
        dispatch_timestamp_source: "response.dispatched_at",
        role: "CODER",
        harness_task_label: `${prevTaskId}-STALE`,
      }),
      JSON.stringify({
        recorded_at: new Date().toISOString(),
        runtime_task_id: "task_current",
        dispatch_id: "ctx_test_mixed_current",
        assignee_pane_key: "x",
        dispatch_timestamp_utc: new Date().toISOString(),
        dispatch_timestamp_source: "response.dispatched_at",
        role: "CODER",
        harness_task_label: prevTaskId,
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const receiptsDir = join(dir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  // 과거 라운드(다른 droppedAt/dispatchId) 영수증 -- 절대 매치돼선 안 됨.
  writeFileSync(
    join(receiptsDir, "coder-receipt-r1.json"),
    JSON.stringify({
      binding: {
        taskId: prevTaskId,
        role: "CODER",
        droppedAt: "2026-07-31 09:00 KST",
        resultFingerprint: "stale-fp",
        dispatchId: "ctx_stale_prior",
        doneAt: "2026-07-31 09:10:00 KST",
      },
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    }) + "\n",
    "utf8",
  );
  // 현재 라운드 영수증(dispatchId는 실물처럼 의도적으로 생략).
  writeFileSync(
    join(receiptsDir, "coder-receipt-r2.json"),
    JSON.stringify({
      binding: {
        taskId: prevTaskId,
        role: "CODER",
        droppedAt,
        resultFingerprint: computeFingerprint(resultContent),
        doneAt,
      },
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    }) + "\n",
    "utf8",
  );
  return dispatchReceiptPath;
}

test("§4-2 오탐 0 대조군: 과거 라운드(다른 결속)의 영수증이 섞여 있어도 현재 라운드는 정확히 구별되어 ALLOW", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const prevTaskId = "HYK-9103-consumption-mixed-prev";
    const droppedAt = "2026-08-14 09:00:00 KST";
    const doneAt = "2026-08-14 09:10:05 KST";
    const { taskPath, resultContent } = seedHandoff(
      dir,
      "coder",
      { taskId: prevTaskId, droppedAt, doneAt },
      {
        taskId: "HYK-9103-consumption-mixed-next",
        droppedAt: "2026-08-14 10:00:00 KST",
      },
    );
    seedMixedReceiptsFixture(dir, {
      prevTaskId,
      droppedAt,
      doneAt,
      resultContent,
    });

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      join(dir, "dispatch-receipts.jsonl"),
    ]);
    assert.equal(r.status, 0, `ALLOW 기대, 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// §4-3: 결선 제거 변이 -> §4-1의 미소비 입력이 통과해 버리는가(RED 확인).
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
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

test("§4-3 mutation (필수): consumptionDecision push 제거 -> §4-1의 미소비 입력이 다시 ALLOW로 새어 버림 -> RED (이 축이 load-bearing임을 증명)", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "        if (consumptionDecision) decisions.push(consumptionDecision);\n";
  assertExactlyOneMatch(src, target, "consumptionDecision push call site");
  const mutated = src.replace(target, "");

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-consumption-mut-fix-"),
    );
    try {
      const ledgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const prevTaskId = "HYK-9104-consumption-mutation-prev";
      const { taskPath } = seedHandoff(
        fixtureDir,
        "coder",
        {
          taskId: prevTaskId,
          droppedAt: "2026-08-14 09:00:00 KST",
          doneAt: "2026-08-14 09:10:05 KST",
        },
        {
          taskId: "HYK-9104-consumption-mutation-next",
          droppedAt: "2026-08-14 10:00:00 KST",
        },
      );
      // §4-1과 동일한 미소비 입력(영수증 후보 0건) -- 결선이 살아있으면
      // REJECT, 제거되면 ALLOW로 샌다.
      const r = runCli(mutantPath, [taskPath, "--ledger", ledgerPath]);
      assert.equal(
        r.status,
        0,
        "RED: consumptionDecision push를 제거하면 미소비 입력이 ALLOW로 새어 버려야 한다 -- 이 축이 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HYK-244 2R-b4 §4-4: PREDATES_RECEIPTS 이행 장치 -- 실물(합성 아님) GREEN
// + 면제 분기를 무르게 바꾸는 RED 변이. 결함1~3의 §4-3 "결선 제거" RED와는
// 별개다: 여기서는 새 축 호출 자체가 아니라 "면제 판정의 경계선"이
// 무너지는지를 확인한다.
// ---------------------------------------------------------------------------

test("§4-4 PREDATES_RECEIPTS GREEN(실물): 직전 라운드의 doneAt이 제도 시행 시점보다 이전이면 영수증이 하나도 없어도(실제 과거 라운드의 정확한 디스크 모양) ALLOW + 사유가 stderr에 찍힌다", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const prevTaskId = "HYK-9108-consumption-predates-prev";
    // ⛔ 합성 영수증을 만들지 않는다 -- 제도 시행 이전 라운드는 애초에
    // 영수증 생산 코드 자체가 없었으므로, receipts/ 디렉터리가 통째로
    // 없는 것이 그 시대 라운드의 «실물과 정확히 같은» 디스크 모양이다.
    const { taskPath } = seedHandoff(
      dir,
      "coder",
      {
        taskId: prevTaskId,
        droppedAt: "2026-08-10 07:00:00 KST",
        doneAt: "2026-08-10 07:10:05 KST", // 제도 시행(2026-08-14 08:50:27 KST)보다 이전.
      },
      {
        taskId: "HYK-9108-consumption-predates-next",
        droppedAt: "2026-08-14 10:00:00 KST",
      },
    );
    // dispatchId 조회조차 필요 없음을 보이기 위해 배달 영수증도 일부러
    // 주지 않는다(면제는 dispatchId 유무와 무관하게 doneAt만으로 결정).
    const r = runCli(SCRIPT_PATH, [taskPath, "--ledger", ledgerPath]);
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(제도 이전 면제), 실제 stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /PREDATES_RECEIPTS/,
      "조용한 통과 금지(한용 확정) -- 고유 상태 이름이 찍혀야 한다",
    );
    assert.match(
      r.stderr,
      new RegExp(prevTaskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(r.stderr, /doneAt=2026-08-10 07:10:05 KST/);
    assert.match(r.stderr, /판정 대상 아님/);
  });
});

test("§4-4 PREDATES_RECEIPTS RED(변이, 필수): 면제 판정의 경계선(>=)을 제거하면 제도 «이후» 미소비 라운드도 잘못 면제돼 ALLOW로 새어 버린다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "  if (doneAtMs >= eraStartMs || droppedAtMs >= eraStartMs) return false;\n";
  assertExactlyOneMatch(src, target, "PREDATES_RECEIPTS era-boundary guard");
  const mutated = src.replace(target, "");

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-consumption-predates-mut-fix-"),
    );
    try {
      const ledgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      // §4-1과 동일한 "제도 이후, 미소비" 표적 -- 경계선이 살아있으면
      // 이 입력은 면제 대상이 아니라서 REJECT다.
      const { taskPath } = seedHandoff(
        fixtureDir,
        "coder",
        {
          taskId: "HYK-9109-consumption-predates-mutation-prev",
          droppedAt: "2026-08-14 09:00:00 KST",
          doneAt: "2026-08-14 09:10:05 KST",
        },
        {
          taskId: "HYK-9109-consumption-predates-mutation-next",
          droppedAt: "2026-08-14 10:00:00 KST",
        },
      );
      const r = runCli(mutantPath, [taskPath, "--ledger", ledgerPath]);
      assert.equal(
        r.status,
        0,
        "RED: 경계선(>=)을 제거하면 제도 이후의 미소비 입력도 무조건 면제되어 ALLOW로 새야 한다 -- 면제가 «앞으로도 통하는 구멍»이 아니라는 것의 반증",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §4-4: 기존 축 회귀 0 -- reject-streak gate/diagnostic-gate/chain/1-B가
// 새 축과 함께 있어도 그대로 동작한다(전부 통과 + 하나라도 실패 시
// 여전히 거부됨을 조합 시나리오로 확인). 개별 축 각각의 세부 계약은
// dispatch-gate-decision.test.mjs/dispatch-gate-decision-core.test.mjs의
// 기존 시험이 이미 덮는다(이번 라운드에서 재실행해 전건 통과 확인,
// coder.md 참조) -- 여기서는 "새 축이 추가된 상태에서 기존 4축+새 축
// 전부가 함께 정상 작동"만 조합으로 재확인한다.
// ---------------------------------------------------------------------------

test("§4-4 회귀 0 (조합): streak=1(gate 축) + 1-B 선언(1-B 축) + 소비 완료 영수증(새 축) 전부 갖춘 표적 -> ALLOW", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9105": { streak: 1, history: [] },
      },
    });
    const { taskPath, dispatchReceiptPath } = buildConsumedFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9105-consumption-combo-prev",
        nextTaskId: "HYK-9105-consumption-combo-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_combo",
      },
    );

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(r.status, 0, `ALLOW 기대, 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("§4-4 회귀 0 (조합, 대조군): 기존 축(streak>=2)이 거부하면 새 축이 소비 완료여도 여전히 REJECT", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9106": { streak: 2, history: [] },
      },
    });
    const { taskPath, dispatchReceiptPath } = buildConsumedFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9106-consumption-combo-blocked-prev",
        nextTaskId: "HYK-9106-consumption-combo-blocked-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_combo_blocked",
      },
    );

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      "streak>=2인데 새 축(소비 완료)이 이를 뒤집어 ALLOW로 만들면 안 된다",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-244 2R-ci-1 §C/§E: 보관함(rounds/) 지문 대조 -- live 결과 파일이
// 소비 *후* 손질돼도, 보존 사본(envelope-archive.mjs가 남긴 원문)의
// 지문이 영수증과 일치하면 여전히 소비 완료로 인정한다.
// ---------------------------------------------------------------------------

// prev 라운드가 "실제로 소비됐고"(영수증 존재, 그 영수증의 지문 =
// 원본 결과 내용의 지문), 그 원본이 보존 사본(rounds/<ROLE>-r1.md,
// envelope-archive.mjs와 바이트 동일한 헤더 형식)에 그대로 남아 있는
// 상태를 만든다. tamperLive:true(기본)면 live 결과 파일만 그 뒤에
// 손질해 원본과 달라지게 한다(§B가 실측한 실제 사고 모양 그대로).
function buildArchiveMatchFixture(
  dir,
  role,
  {
    prevTaskId,
    nextTaskId,
    droppedAt,
    doneAt,
    nextDroppedAt,
    dispatchId,
    tamperLive = true,
    tamperArchiveToo = false,
  },
) {
  const upperRole = role.toUpperCase();
  const originalResultContent = `task_id: ${prevTaskId}\n\n>>> DONE: ${upperRole} @ ${doneAt}\n`;

  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  // 보존 TASK 사본(droppedAt 조회용, seedHandoff와 동일 헤더 관례).
  writeFileSync(
    join(roundsDir, `${upperRole}-task-r1.md`),
    `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${droppedAt} -->\ntask_id: ${prevTaskId}\ndropped_at: ${droppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
  // 보존 RESULT 사본 -- envelope-archive.mjs 193행과 바이트 동일한 헤더
  // 형식(`<!-- envelope-archive: role=<ROLE> archived_at=<시각> -->\n`).
  const archiveResultContent = tamperArchiveToo
    ? originalResultContent.replace(">>> DONE:", ">>> DONE(위조):")
    : originalResultContent;
  writeFileSync(
    join(roundsDir, `${upperRole}-r1.md`),
    `<!-- envelope-archive: role=${upperRole} archived_at=${doneAt} -->\n${archiveResultContent}`,
    "utf8",
  );

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: upperRole,
    harnessTaskLabel: prevTaskId,
    dispatchId,
  });
  writeConsumptionReceipt(
    dir,
    role,
    {
      taskId: prevTaskId,
      role: upperRole,
      droppedAt,
      resultFingerprint: computeFingerprint(originalResultContent),
      doneAt,
      // dispatchId 의도적으로 생략(실물 생산기 관례, buildConsumedFixture와 동일 이유).
    },
    { envelopeArchived: true, taskArchived: true, admissionReturned: true },
  );

  // live 결과 파일 -- tamperLive면 소비 *후* 손질된 모양(서식만 다름).
  const liveResultContent = tamperLive
    ? `task_id: ${prevTaskId}\n\n>>> DONE: ${upperRole} @ ${doneAt}\n<!-- 소비 후 손질(가정) -->\n`
    : originalResultContent;
  writeFileSync(join(dir, `${role}.md`), liveResultContent, "utf8");

  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${nextTaskId}\ndropped_at: ${nextDroppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
  return { taskPath, dispatchReceiptPath };
}

test("§E-1/2 ARCHIVE_MATCH: live 지문이 안 맞아도 보존 사본 지문이 영수증과 일치하면 ALLOW + 사유(ARCHIVE_MATCH)와 live≠보관함 불일치 관측이 둘 다 stderr에 찍힌다", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9111-consumption-archive-match-prev",
        nextTaskId: "HYK-9111-consumption-archive-match-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_archive_match",
        tamperLive: true,
      },
    );

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(보관함 대조), 실제 stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stderr,
      /ARCHIVE_MATCH/,
      "조용한 통과 금지(조건①) -- 보관함 대조로 인정됐다는 사유가 찍혀야 한다",
    );
    assert.match(
      r.stderr,
      /live≠보관함 지문 불일치 관측/,
      "뒷손질 관측(조건②) -- live와 보관함이 다르다는 사실 자체가 찍혀야 한다",
    );
  });
});

test("§E-3 여전히 엄격: live도 보관함도 둘 다 안 맞으면(보존 사본까지 어긋나면) 여전히 REJECT", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9112-consumption-archive-both-bad-prev",
        nextTaskId: "HYK-9112-consumption-archive-both-bad-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_archive_both_bad",
        tamperLive: true,
        tamperArchiveToo: true, // 보존 사본까지 어긋낸다.
      },
    );

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      "면제가 새 구멍이 되면 안 된다 -- live·보관함 둘 다 안 맞으면 여전히 REJECT",
    );
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
  });
});

test("§C 어느 사본이 그 라운드 것인지: 같은 라벨의 보존 사본이 2개면 조용히 하나를 고르지 않고 판정 불가로 거부한다(REJECT, ARCHIVE_MATCH 아님)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9113-consumption-archive-ambiguous-prev",
        nextTaskId: "HYK-9113-consumption-archive-ambiguous-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_archive_ambiguous",
        tamperLive: true,
      },
    );
    // 같은 라벨(prevTaskId)을 가리키는 두 번째 보존 사본을 추가한다 --
    // 어느 쪽이 진짜인지 이 축 스스로는 결정할 수 없어야 한다.
    const raw = readFileSync(join(dir, "rounds", "CODER-r1.md"), "utf8");
    writeFileSync(join(dir, "rounds", "CODER-r2.md"), raw, "utf8");

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      "중복 라벨은 조용히 하나를 고르지 않고 거부해야 한다",
    );
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
    assert.match(r.stderr, /보관함 대조 판정 불가/);
    assert.match(r.stderr, /결정할 수 없다/);
  });
});

// ---------------------------------------------------------------------------
// HYK-244 gate-unblock-1 §1 조각3 (한용 «가» 확정): 정밀화 -- 후보가 여럿
// 이어도, 그중 «영수증 결속의 resultFingerprint와 정확히 일치»하는 후보가
// «정확히 하나»면 그것으로 인정한다. §0의 실사고(REVIEW-r8.md=진짜,
// REVIEW-r1.md=대소문자 충돌 버그가 남긴 손상 잔재, 같은 라벨) 모양을
// 그대로 재현한다.
// ---------------------------------------------------------------------------

test("§1 조각3 ⓐ 정밀화 GREEN: 같은 라벨의 후보 2건 중 목표 지문과 «정확히 일치»하는 것이 1건뿐이면 그것으로 인정해 ALLOW(나머지 1건은 지문이 달라도 무시)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9114-consumption-archive-precision-prev",
        nextTaskId: "HYK-9114-consumption-archive-precision-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_archive_precision",
        tamperLive: true, // live만 손질됨 -- rounds/CODER-r1.md는 원본(=목표 지문과 일치).
      },
    );
    // 같은 라벨을 가리키지만 «내용이 다른»(=지문이 다른) 손상된 잔재
    // 사본을 하나 더 추가한다(§0 REVIEW-r1.md와 같은 모양 -- 라벨은
    // 같은데 실제 내용은 다른 라운드/손질된 것).
    writeFileSync(
      join(dir, "rounds", "CODER-r2.md"),
      `<!-- envelope-archive: role=CODER archived_at=2026-08-14 09:10:05 KST -->\ntask_id: HYK-9114-consumption-archive-precision-prev\n\n>>> DONE: CODER @ 2026-08-14 09:10:05 KST\n<!-- 손상된 잔재(§0 REVIEW-r1.md와 같은 모양) -->\n`,
      "utf8",
    );

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(후보 2건 중 목표 지문 일치 1건), 실제 stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
    assert.match(r.stderr, /ARCHIVE_MATCH/);
    assert.match(
      r.stderr,
      /같은 라벨 후보 2건 중 일치 1건/,
      "몇 건 중 몇 건이 일치했는지가 사유에 찍혀야 한다(§1 점4)",
    );
  });
});

test("§1 조각3 ⓑ 정밀화 대조군: 같은 라벨의 후보가 있어도 목표 지문과 «하나도» 일치하지 않으면 여전히 REJECT(면제가 새 구멍이 되지 않는다)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9115-consumption-archive-zero-match-prev",
        nextTaskId: "HYK-9115-consumption-archive-zero-match-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_archive_zero_match",
        tamperLive: true,
        tamperArchiveToo: true, // 유일한 보존 사본(r1)도 목표 지문과 어긋나게 한다.
      },
    );
    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      "일치하는 보존 사본이 0건이면 여전히 REJECT여야 한다",
    );
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
  });
});

test("§1 조각3 ⓓ RED(변이, 필수): 정밀화(목표 지문 일치 필터)를 되돌리면 ⓐ의 «후보 2건 중 1건만 일치» 입력이 다시 판정 불가(REJECT)로 새어 버린다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "  const exactMatches = labelMatches.filter(\n    (m) => m.fingerprint === targetFingerprint,\n  );\n  if (exactMatches.length === 0) return { ok: true, fingerprint: null };\n  if (exactMatches.length > 1) {";
  assertExactlyOneMatch(src, target, "정밀화 필터(exactMatches) 블록");
  // 정밀화 이전 규칙을 그대로 재현: 목표 지문과 무관하게 "라벨만 같은
  // 후보가 2개 이상이면 무조건 판정 불가"로 되돌린다.
  const mutated = src.replace(
    target,
    "  const exactMatches = labelMatches;\n  if (exactMatches.length === 0) return { ok: true, fingerprint: null };\n  if (exactMatches.length > 1) {",
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-consumption-precision-mut-fix-"),
    );
    try {
      const ledgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
        fixtureDir,
        "coder",
        {
          prevTaskId: "HYK-9116-consumption-archive-precision-red-prev",
          nextTaskId: "HYK-9116-consumption-archive-precision-red-next",
          droppedAt: "2026-08-14 09:00:00 KST",
          doneAt: "2026-08-14 09:10:05 KST",
          nextDroppedAt: "2026-08-14 10:00:00 KST",
          dispatchId: "ctx_test_archive_precision_red",
          tamperLive: true,
        },
      );
      writeFileSync(
        join(fixtureDir, "rounds", "CODER-r2.md"),
        `<!-- envelope-archive: role=CODER archived_at=2026-08-14 09:10:05 KST -->\ntask_id: HYK-9116-consumption-archive-precision-red-prev\n\n>>> DONE: CODER @ 2026-08-14 09:10:05 KST\n<!-- 손상된 잔재 -->\n`,
        "utf8",
      );
      const r = runCli(mutantPath, [
        taskPath,
        "--ledger",
        ledgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
      ]);
      assert.notEqual(
        r.status,
        0,
        "RED: 정밀화를 되돌리면 후보 2건 중 1건만 일치하는 입력도 다시 무조건 판정 불가(REJECT)로 새야 한다 -- 이 정밀화가 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 부트스트랩: 직전 라운드의 결과 파일 자체가 없으면(첫 배달) 새 축이
// 적용 대상이 없다고 판단해 ALLOW를 막지 않는다.
// ---------------------------------------------------------------------------

test("부트스트랩: 형제 결과 파일(<role>.md)이 아예 없으면 새 축은 적용되지 않는다(ALLOW를 막지 않는다)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9107-consumption-bootstrap\ndropped_at: 2026-08-01 13:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    // coder.md(형제 결과 파일)를 의도적으로 만들지 않는다.
    const r = runCli(SCRIPT_PATH, [taskPath, "--ledger", ledgerPath]);
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(부트스트랩), 실제 stderr: ${r.stderr}`,
    );
  });
});
