// HYK-424-head-label-3 §2ⓐ (coder-task.md 책임자 판정 B-prime): 2R
// (head-label-2)가 "같은 라벨 + 새 dropped_at 재배달"이 배달 게이트의
// consumption-receipt 축(RECEIPT_MISSING)에 막힌다는 것을 합성 원장으로
// 실측했다(CODER-r2.md §2ⓑ). 이 라운드는 책임자 지시대로 두 가지 복구
// 경로를 "실 CLI dispatch-gate-decision.mjs 판정 + 수정 결과 프로덕션
// checkRelayHandshake 소비 결과" 양쪽으로 측정한다:
//   ⓐ 같은 워크트리 + 새 라벨(task_id)
//   ⓑ 새 워크트리(작성자 HEAD와 같은 커밋의 다른 harnessDir) + 새 라벨
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtemp 안에 새로 만든 합성
// git 저장소 + 합성 admission/receipt 파일이다. ⛔first-observation·배달
// 게이트·소비 영수증·원장·은퇴 코드는 건드리지 않는다 -- 이 파일은 그
// 코드를 "읽기 호출"로만 측정한다(product_scope ②).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { checkRelayHandshake, parseKstTimestamp } from "./relay-handshake.mjs";
import { writeLedger } from "./reject-streak.mjs";
import { withIsolatedAmbientLedgerEnv } from "./admission-ledger-env-isolation.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_CLI = join(HERE, "dispatch-gate-decision.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 진짜 git 저장소를 만들고 그 실제 HEAD(40-hex SHA)를 반환한다 --
// relay-handshake-base-copy.test.mjs의 동명 헬퍼와 동일 모양(이 파일은
// 독립 fixture 저장소이므로 그 파일을 import하지 않고 그대로 복제한다).
function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "author base"], {
    cwd: dir,
  });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function makeAnotherCommit(dir, msg) {
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], {
    cwd: dir,
  });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

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

function runGateCli(args) {
  const res = spawnSync(process.execPath, [GATE_CLI, ...args], {
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// (redispatch-b) 본문을 80줄 상한 안에 두려고 뽑았다(quality-check
// max-lines-per-function) -- 동작은 그대로다: admission 원장에 실 CLI로
// ACTIVE 예약을 만들고, 그 env를 일시 주입한 채로 프로덕션
// checkRelayHandshake를 호출한 뒤 env를 원복한다.
function completeWithRealAdmissionLedger(harnessDir, reservationId, nowMs) {
  const ledgerDir = mkdtempSync(
    join(tmpdir(), "hyk424-redispatch-b-admission-"),
  );
  try {
    const admissionLedger = join(ledgerDir, "l.json");
    const admissionLock = join(ledgerDir, "l.lock");
    initAndAdmit(admissionLedger, admissionLock, reservationId);

    const priorLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
    const priorLockEnv = process.env.ADMISSION_LOCK_PATH;
    process.env.ADMISSION_LEDGER_PATH = admissionLedger;
    process.env.ADMISSION_LOCK_PATH = admissionLock;
    try {
      // time-judgment-now-injection 비타협: 절대시각 픽스처를 쓰는 호출은
      // 반드시 now를 명시로 주입한다(실제 벽시계 Date.now() 기본값 금지) --
      // 그 DONE 줄 자신의 KST 시각 + 1분을 판정 시각으로 쓴다.
      return checkRelayHandshake({ role: "CODER", harnessDir, now: nowMs });
    } finally {
      if (priorLedgerEnv === undefined)
        delete process.env.ADMISSION_LEDGER_PATH;
      else process.env.ADMISSION_LEDGER_PATH = priorLedgerEnv;
      if (priorLockEnv === undefined) delete process.env.ADMISSION_LOCK_PATH;
      else process.env.ADMISSION_LOCK_PATH = priorLockEnv;
    }
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// ⓐ 같은 워크트리 + 새 라벨 -- 여전히 RECEIPT_MISSING으로 REJECT.
// ---------------------------------------------------------------------------
test("(redispatch-a) 같은 워크트리 + 새 라벨: base-copy로 거부된 직전 결과가 그대로 남아 있으면, 완전히 새로운(한 번도 배달된 적 없는) 라벨로 재배달해도 실 CLI가 RECEIPT_MISSING으로 REJECT한다", () => {
  withFixtureDir("hyk424-redispatch-a-", (dir) => {
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    const baseSha = ensureGitHeadCommit(harnessDir);
    makeAnotherCommit(harnessDir, "worker's own commit");
    const prevTaskId = "HYK-9424-redispatch-a-prev";

    // 1단계: 실물 생산 -- base-copy 거부를 손으로 합성하지 않고 실제
    // checkRelayHandshake로 만든다(1R/2R 실사고와 같은 모양).
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      `task_id: ${prevTaskId}\ndropped_at: 2026-11-04 06:00:00 KST\nbase_commit_of_this_round: ${baseSha}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "coder.md"),
      `task_id: ${prevTaskId}\nhead_commit: ${baseSha}\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    // time-judgment-now-injection 비타협: now를 명시로 주입한다(실제
    // 벽시계 기본값 금지) -- 그 DONE 줄 자신의 KST 시각 + 1분.
    const nowMs =
      parseKstTimestamp("2026-11-04 06:10:00 KST").getTime() + 60_000;
    const rejection = withIsolatedAmbientLedgerEnv(() =>
      checkRelayHandshake({ role: "CODER", harnessDir, now: nowMs }),
    );
    assert.equal(
      rejection.ok,
      false,
      "전제: base-copy 거부가 실제로 일어나야 한다",
    );
    assert.match(rejection.reason, /base를 베꼈다/);
    // 완료 부수효과(영수증 생산)는 전혀 돌지 않았다 -- 2R이 읽은
    // relay-handshake.mjs:4140 runCompletionSideEffects 앞에서 막힌다는
    // 사실의 직접 증거.
    assert.equal(
      existsSync(join(harnessDir, "receipts")),
      false,
      "base-copy 거부는 완료 부수효과(소비 영수증 생산) 앞에서 막혀야 한다",
    );

    // 2단계: 같은 워크트리(같은 harnessDir -- 직전 coder.md가 그대로
    // 남아 있다)에서, 한 번도 쓰인 적 없는 새 라벨로 재배달을 시도한다.
    const nextTaskId = "HYK-9424-redispatch-a-NEWLABEL";
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      `task_id: ${nextTaskId}\ndropped_at: 2026-11-04 07:00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(harnessDir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const dispatchReceiptPath = join(harnessDir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: prevTaskId,
      dispatchId: "ctx_test_redispatch_a",
    });

    const r = runGateCli([
      join(harnessDir, "coder-task.md"),
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      `같은 워크트리 + 새 라벨도 REJECT여야 한다(실측), stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /consumption-receipt:/);
    assert.match(r.stderr, /영수증 후보가 하나도 없음/);
    // 결속에 찍힌 taskId는 "다음" 라벨이 아니라 "직전"(실패한) 라벨의
    // 것이다 -- evaluateConsumptionDecision이 resultText(직전 결과 파일)
    // 자신의 task_id 에코에서 harnessTaskLabel을 뽑기 때문에, 다음 라운드
    // 가 무슨 라벨을 쓰든 이 판정은 바뀌지 않는다는 구조적 근거.
    assert.match(r.stderr, new RegExp(prevTaskId.replace(/[-]/g, "\\-")));
  });
});

// ---------------------------------------------------------------------------
// ⓑ 새 워크트리(작성자 HEAD와 같은 커밋의 다른 harnessDir) + 새 라벨 --
// 배달 게이트가 ALLOW하고, 프로덕션 checkRelayHandshake도 소비를 성공
// 시킨다(admission 예약·수신까지 전부 실물 경로).
// ---------------------------------------------------------------------------
test("(redispatch-b) 새 워크트리(작성자 HEAD) + 새 라벨: 직전 결과 파일이 없는 fresh harnessDir라면 실 CLI가 ALLOW하고, 이후 프로덕션 checkRelayHandshake도 소비를 성공시킨다", () => {
  withFixtureDir("hyk424-redispatch-b-", (dir) => {
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    // "작성자 HEAD"를 가진 새 워크트리 -- 이 fixture 자체가 그 단일
    // 커밋을 작성자 HEAD로 삼는다(합성 환경이므로 실제 저장소의 HEAD SHA
    // 값 자체는 무관하다, 측정 대상은 "결과 파일이 없는 새 harnessDir"
    // 라는 구조뿐이다).
    const authorHeadSha = ensureGitHeadCommit(harnessDir);
    const nextTaskId = "HYK-9424-redispatch-b-NEWLABEL";

    writeFileSync(
      join(harnessDir, "coder-task.md"),
      `task_id: ${nextTaskId}\ndropped_at: 2026-11-04 07:00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    // coder.md 없음 -- fresh harnessDir, 직전 라운드의 흔적이 전혀 없다.
    const ledgerPath = join(harnessDir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const dispatchReceiptPath = join(harnessDir, "dispatch-receipts.jsonl");
    writeFileSync(dispatchReceiptPath, "", "utf8"); // 확인 가능한, 비어 있는 영수증 로그.

    const gateResult = runGateCli([
      join(harnessDir, "coder-task.md"),
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.equal(
      gateResult.status,
      0,
      `새 워크트리 + 새 라벨은 ALLOW여야 한다(부트스트랩), stderr: ${gateResult.stderr}`,
    );
    assert.match(gateResult.stdout, /ALLOW/);

    // 게이트가 ALLOW했으니, 워커가 이 새 워크트리에서 실제로 작업을
    // 끝냈다고 가정하고 프로덕션 checkRelayHandshake로 소비까지 실측한다
    // (admission 원장도 실 CLI로 ACTIVE 예약을 만들어 완료 부수효과까지
    // 전부 실물 경로로 확인한다).
    const ownSha = makeAnotherCommit(harnessDir, "worker's real commit");
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      `task_id: ${nextTaskId}\ndropped_at: 2026-11-04 07:00:00 KST\nbase_commit_of_this_round: ${authorHeadSha}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "coder.md"),
      `task_id: ${nextTaskId}\nhead_commit: ${ownSha}\n\n>>> DONE: CODER @ 2026-11-04 07:30:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );

    const completion = completeWithRealAdmissionLedger(
      harnessDir,
      nextTaskId,
      parseKstTimestamp("2026-11-04 07:30:00 KST").getTime() + 60_000,
    );
    assert.equal(
      completion.ok,
      true,
      `실측으로 통과한 경로는 소비까지 성공해야 한다: ${completion.reason}`,
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(harnessDir, "receipts", "CODER-receipt-r1.json"),
          "utf8",
        ),
      ).effects,
      {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
      "admission 예약까지 ACTIVE로 갖춘 실물 경로는 필수 후속효과 전부가 성공해야 한다",
    );
  });
});
