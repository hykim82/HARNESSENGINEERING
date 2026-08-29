// HYK-256-receiptpath-1 §5 -- 관제실 dispatch-worker.ps1 154~224행의
// 결함(§3: 게이트 호출에 --dispatch-receipt-path가 없다, $ReceiptPath는
// 그 호출보다 뒤에서야 정해진다)이 의존하는 저장소 쪽 계약을
// «프로덕션 진입점(dispatch-gate-decision.mjs)을 자식 프로세스로 실제
// 실행»해서 못 박는다. 이웃 파일(dispatch-gate-consumption-wire.test.mjs)
// 과 같은 house style(합성 .harness + spawnSync + stdout/stderr 내용
// 단언, 함수 직접 호출 아님)을 따르되, 표적은 다르다 -- 그 이웃 파일은
// "소비 완료 영수증 축 자체"의 판정을 못 박고, 이 파일은 오직
// "--dispatch-receipt-path/DISPATCH_RECEIPT_PATH가 실제로 그 축에
// 결선됐는가"만 좁혀서 본다(⛔dispatch-gate-decision-core.mjs·
// consumption-receipt-core.mjs 무변경, §5 비타협).
//
// ⛔이 파일은 dispatch-gate-decision.mjs·consumption-receipt-core.mjs를
// 고치지 않는다(§5 비타협: "이미 있는 동작을 못 박는 것" -- 세 시험
// 모두 GREEN이었고 변경은 필요 없었다).
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

// 이웃 파일의 ONE_B_BLOCK과 동일 -- checkOneBPrecondition을 통과시키는
// 최소 형태(이 축의 표적이 아니다, 부트스트랩 걸림돌만 치운다).
const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(
    join(tmpdir(), "dispatch-gate-receipt-path-wire-test-"),
  );
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function computeFingerprint(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// HYK-394-dispatch-id-bind-2 §2 (P1): `recordedAt` defaults to a fixed
// instant well before every fixture's `doneAt` in this file -- dispatch-
// gate-decision.mjs's dispatch_id lookup is now anchored to "strictly
// before this round's own doneAt" (findLatestReceiptMatch's own header),
// so real wall-clock "now" (this file's old default) falls AFTER any of
// these historical doneAt fixtures and is silently excluded.
function writeDispatchReceiptLine(
  path,
  {
    role,
    harnessTaskLabel,
    dispatchId,
    recordedAt = "2020-01-01T00:00:00.000Z",
  },
) {
  const record = {
    recorded_at: recordedAt,
    runtime_task_id: `task_${Math.random().toString(16).slice(2, 14)}`,
    dispatch_id: dispatchId,
    assignee_pane_key: "test-pane-key",
    dispatch_timestamp_utc: recordedAt,
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: harnessTaskLabel,
  };
  writeFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

// prev 라운드(이미 DONE + rounds 아카이브 + 소비 영수증)와 다음 라운드
// task 파일 -- 게이트가 실제로 도는 시점의 정확한 모양(HYK-244 2R-b3
// 결함1 재현 방지, 이웃 파일과 동일 원칙: taskPath는 이미 다음 라운드로
// 덮여 있고 resultPath만 직전 라운드 것). 세 시험 모두 이 하나의
// 픽스처 모양을 공유해서 "--dispatch-receipt-path 인자/환경 유무"
// 하나만 바뀐 최소대조가 되게 한다.
function buildFixture(dir, { prevTaskId, nextTaskId, dispatchId }) {
  const droppedAt = "2026-08-14 09:00:00 KST";
  const doneAt = "2026-08-14 09:10:05 KST";
  const nextDroppedAt = "2026-08-14 10:00:00 KST";

  const resultContent = `task_id: ${prevTaskId}\n\n>>> DONE: CODER @ ${doneAt}\n`;
  writeFileSync(join(dir, "coder.md"), resultContent, "utf8");

  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  writeFileSync(
    join(roundsDir, "CODER-task-r1.md"),
    `<!-- envelope-archive: role=CODER kind=task dropped_at=${droppedAt} -->\ntask_id: ${prevTaskId}\ndropped_at: ${droppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );

  const taskPath = join(dir, "coder-task.md");
  writeFileSync(
    taskPath,
    `task_id: ${nextTaskId}\ndropped_at: ${nextDroppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: "CODER",
    harnessTaskLabel: prevTaskId,
    dispatchId,
  });

  const receiptsDir = join(dir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(
    join(receiptsDir, "coder-receipt-r1.json"),
    JSON.stringify(
      {
        binding: {
          taskId: prevTaskId,
          role: "CODER",
          droppedAt,
          resultFingerprint: computeFingerprint(resultContent),
          dispatchId,
          doneAt,
        },
        effects: {
          envelopeArchived: true,
          taskArchived: true,
          admissionReturned: true,
        },
        verdictLineCount: 0,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return { taskPath, dispatchReceiptPath };
}

function runCli(args, env) {
  const result = spawnSync("node", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ⛔실물 원장 무접촉(§6-2): dispatch-gate-decision.mjs 자신은 VALID
// 이름표 라운드(이 파일의 모든 픽스처가 그 모양이다)에서 admission
// ledger를 전혀 읽지 않는다 -- resolveAdmissionLedgerPathForAbort는
// abort-record 축(maybeResolveAbortRecordForMissingLabel) 안에서만
// 쓰이고, 그 축 자체가 labelInfo.kind !== "MISSING"이면 파일 I/O 없이
// {done:false}로 즉시 물러난다(위 원문 실측, 결과 파일에 근거 인용).
// 그래도 부모 프로세스 env에 실물 관제실 포인터가 상속돼 있을 가능성을
// 원천 차단하기 위해, 모든 호출에 워크트리 안 임시 ADMISSION_LEDGER_PATH
// /ADMISSION_LOCK_PATH를 명시로 얹는다(방어적, 이 축의 표적이 그
// 경로를 실제로 열지 않아도 마찬가지로 안전).
function withCleanEnv(dir, overrides) {
  const admissionDir = join(dir, "admission-guard");
  mkdirSync(admissionDir, { recursive: true });
  const env = { ...process.env };
  delete env.DISPATCH_RECEIPT_PATH;
  env.ADMISSION_LEDGER_PATH = join(admissionDir, "ledger.json");
  env.ADMISSION_LOCK_PATH = join(admissionDir, "ledger.lock");
  Object.assign(env, overrides ?? {});
  return env;
}

test("§5-ⓐ GREEN: --dispatch-receipt-path 를 주면 소비 축이 그 dispatchId 를 실제로 찾아 ALLOW, 같은 인자라도 그 영수증 파일을 지우면 REJECT로 뒤집힌다(인과 증명)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildFixture(dir, {
      prevTaskId: "HYK-9256-a-prev",
      nextTaskId: "HYK-9256-a-next",
      dispatchId: "ctx_test_hyk256_green",
    });

    const args = [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ];
    const green = runCli(args, withCleanEnv(dir));
    assert.equal(green.status, 0, `ALLOW 기대, 실제 stderr: ${green.stderr}`);
    assert.match(green.stdout, /dispatch-gate-decision: ALLOW/);

    // 인과 증명: --dispatch-receipt-path 로 넘긴 «바로 그 파일»을
    // 지우면 -- 다른 아무것도 바꾸지 않고 같은 인자로 재호출해도 --
    // REJECT로 뒤집혀야 한다. 그래야 위 ALLOW가 이 인자 자체의 효과임이
    // 증명된다(다른 축이 우연히 통과시킨 게 아니다). dispatchId가 그
    // 파일에서 «실제로 찾아졌다»는 것은 이 인과관계(있으면 ALLOW,
    // 지우면 REJECT)로 증명한다 -- ALLOW 성공 경로 자체는
    // (consumption-receipt-core.mjs의 PASS -> null 어댑터 계약,
    // toConsumptionGateDecision) dispatchId 문자열을 표준출력에 echo하지
    // 않는다(정직 한계, 결과 파일 ⓖ에 기록).
    rmSync(dispatchReceiptPath);
    const afterRemoval = runCli(args, withCleanEnv(dir));
    assert.notEqual(
      afterRemoval.status,
      0,
      "같은 --dispatch-receipt-path 인자라도 그 파일이 없어지면 거부돼야 한다",
    );
    assert.match(afterRemoval.stderr, /consumption-receipt:/);
    assert.match(afterRemoval.stderr, /dispatch receipt 파일을 읽을 수 없음/);
  });
});

test("§5-ⓑ 회귀(가장 중요): --dispatch-receipt-path 도 없고 DISPATCH_RECEIPT_PATH env 도 비면, 소비 영수증이 정상인 같은 입력이라도 «경로 없음» 사유로 거부된다(fail-closed 무회귀, HYK-256 §3 결함 재현)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath } = buildFixture(dir, {
      prevTaskId: "HYK-9256-b-prev",
      nextTaskId: "HYK-9256-b-next",
      dispatchId: "ctx_test_hyk256_regress",
    });

    // ⛔이 라운드가 못 박는 결함(§3) 그대로 재현: 소비 영수증
    // (receipts/)도, 유효한 dispatch-receipts.jsonl도 디스크에 멀쩡히
    // 있다 -- 다만 게이트 호출에 --dispatch-receipt-path가 없고 env도
    // 비어서 그 존재를 CLI 스스로는 알 방법이 없다(관제실 154~224행
    // 원문 결함 그대로: 게이트 호출이 $ReceiptPath 확정보다 앞에 있다).
    const r = runCli([taskPath, "--ledger", ledgerPath], withCleanEnv(dir));
    assert.notEqual(r.status, 0, "경로가 전혀 안 넘어오면 거부돼야 한다");
    assert.match(r.stderr, /consumption-receipt:/);
    assert.match(r.stderr, /dispatch_id 조회 실패\(안 지어냄\)/);
    assert.match(
      r.stderr,
      /dispatch receipt path 없음\(--dispatch-receipt-path\/DISPATCH_RECEIPT_PATH 둘 다 미설정\)/,
      "새 축 고유의 «경로 없음» 사유 문자열이 그대로 나와야 한다(사유 지어내기 금지)",
    );
  });
});

test("§5-ⓒ env 폴백: 인자는 없고 DISPATCH_RECEIPT_PATH env 만 주면 ⓐ와 같은 ALLOW(인자→env 우선순위가 살아 있음)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildFixture(dir, {
      prevTaskId: "HYK-9256-c-prev",
      nextTaskId: "HYK-9256-c-next",
      dispatchId: "ctx_test_hyk256_envfallback",
    });

    const r = runCli(
      [taskPath, "--ledger", ledgerPath],
      withCleanEnv(dir, { DISPATCH_RECEIPT_PATH: dispatchReceiptPath }),
    );
    assert.equal(r.status, 0, `ALLOW 기대(env 폴백), 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /dispatch-gate-decision: ALLOW/);
  });
});
