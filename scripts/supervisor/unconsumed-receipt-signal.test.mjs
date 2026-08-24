// HYK-340-vanished-unresolved (coder-task.md §3) -- «세 번째 소비 흔적
// (소비 완료 영수증)» 결선 계약 시험.
//
// §0 M1 재현: 「마지막 라운드」(결과 파일이 가장 최신 + 그 뒤 새
// task 파일도 새 커밋도 없음)에서, 영수증(.harness/receipts/<role>-
// receipt-r<N>.json)이 있고 그 내용이 워커가 못 쓰는 두 자리(배달
// 영수증·admission 원장)로 독립 대조까지 되면 SUSPECTED_UNCONSUMED가
// 아니라 CONSUMED(reasonCode=CONSUMED_VIA_RECEIPT)여야 한다.
//
// ★HYK-340 2R P1-1(검토 1R 반려 수리, coder-task.md §1): 1R은 이
// 파일의 helper가 `{binding:{}, effects:{}}`라는 임의 JSON만으로
// CONSUMED를 확인하는 헛시험이었다 -- 워크트리 안 파일 존재만으로
// 통과했다는 뜻이다. 이 2R은 그 헛시험을 제거하고, ⑴ 위조(워크트리
// 안 파일만)로는 이제 CONSUMED가 안 나오는 것 ⑵ 정당한 소비(배달
// 영수증+원장 둘 다 대조 통과)는 여전히 CONSUMED인 것 ⑶ 대조 자료를
// 못 읽으면(fail-closed) CONSUMED로 접지 않는 것을 각각 별도 시험으로
// 고정한다.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. judgeUnconsumed 코어 자신의 3신호/임계 판정 로직은 unconsumed-
//    core.test.mjs가 전담한다 -- 여기는 "영수증 파일 + 독립 대조 ->
//    세 번째 신호" 결선만 본다.
// 2. consumption-receipt-writer.mjs가 실제로 그 파일을 올바른 모양으로
//    쓰는지는 그 파일 자신의 시험(consumption-receipt-writer.test.mjs)이
//    전담한다 -- 여기는 "파일 하나가 그 자리에 있고 mtime이 새것이면"만
//    가정한다.
// 3. dispatch-receipts.jsonl/admission-ledger.json 실물 파일의 정확한
//    생산 경로(dispatch-receipt-cli.mjs/admission-cli.mjs)는 그 파일들
//    자신의 시험이 전담한다 -- 여기는 그 모양을 흉내낸 합성 파일만 쓴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  judgeUnconsumedForRepo,
  collectUnconsumedCandidates,
  UNCONSUMED_WIRE_STATUS,
} from "./orch-stall-detect.mjs";
import { UNCONSUMED_VERDICT, UNCONSUMED_REASON } from "./unconsumed-core.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}
// unconsumed-wire.test.mjs와 동일 이유(기준 커밋을 표본 시각보다 훨씬
// 이전으로 고정 -- 실행 시각의 "지금"이 기준 커밋 신호로 오인되지 않게).
const BASE_COMMIT_DATE = "2020-01-01T00:00:00+09:00";
function initPlainGitRepo(dir) {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(
    dir,
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-m",
      "base",
      "--quiet",
    ],
    { GIT_AUTHOR_DATE: BASE_COMMIT_DATE, GIT_COMMITTER_DATE: BASE_COMMIT_DATE },
  );
}
function writeTaskFile(dir, { name = "coder-task.md", taskId, mtimeIso }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  writeFileSync(p, `task_id: ${taskId}\n\n본문\n`, "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}
// ★2R: `taskId`가 주어지면 결과 파일도 그 라벨을 `task_id:`로 에코한다
// (resolveEchoedRoundLabel이 읽는 바로 그 줄 -- HYK-183 anti-forgery와
// 동일 관례). 생략하면(기존 호출부 다수) 에코 없이 본문만 -- 1R까지의
// 파일과 byte-identical한 시험도 여전히 돌 수 있게 한다.
function writeResultFileAt(dir, { name = "coder.md", updatedAtIso, taskId }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  const p = join(dir, ".harness", name);
  const taskIdLine = taskId ? `task_id: ${taskId}\n` : "";
  writeFileSync(p, `${taskIdLine}결과 본문\n>>> DONE: CODER @ test\n`, "utf8");
  const t = new Date(updatedAtIso);
  utimesSync(p, t, t);
}
function writeReceiptAt(dir, { role, round = 1, mtimeIso }) {
  const receiptsDir = join(dir, ".harness", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const p = join(receiptsDir, `${role}-receipt-r${round}.json`);
  writeFileSync(p, JSON.stringify({ binding: {}, effects: {} }), "utf8");
  const t = new Date(mtimeIso);
  utimesSync(p, t, t);
}
// ★2R -- 워커가 못 쓰는 두 자리를 흉내낸 합성 파일. 실물 모양(admission-
// completion-adapter.mjs의 hasDispatchReceiptForRound가 읽는 필드,
// admission-ledger-core.mjs의 reservations[id].status)만 재현한다.
function writeDispatchReceiptsJsonl(dir, records) {
  const p = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(
    p,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  return p;
}
function writeAdmissionLedger(dir, reservations) {
  const p = join(dir, "admission-ledger.json");
  writeFileSync(
    p,
    JSON.stringify({
      schema_version: "admission-ledger/v1",
      epoch: "2020-01-01T00:00:00Z",
      reservations,
    }),
    "utf8",
  );
  return p;
}
function judgeFor(dir, now, opts = {}) {
  const evidence = collectUnconsumedCandidates(dir);
  assert.equal(evidence.failed, false, "candidate collection must not fail");
  return judgeUnconsumedForRepo(
    { repoRoot: dir, taskFileCandidates: evidence.items, now },
    opts,
  );
}

// ---------------------------------------------------------------------------
// (1) §0 M1 재현, 정당한 소비: 마지막 라운드 + 영수증이 결과 파일보다
// 새것 + 배달 영수증·admission 원장 둘 다 이 라운드를 실제로 확인 ->
// CONSUMED via CONSUMED_VIA_RECEIPT (요구1 대조군 -- 요구2 오탐0).
// ---------------------------------------------------------------------------
test("HYK-340 2R: 정당한 소비(영수증+배달영수증+원장 COMPLETED 셋 다 일치) -- SUSPECTED_UNCONSUMED가 아니라 CONSUMED/CONSUMED_VIA_RECEIPT (1/1)", () => {
  withTempDir("hyk340-verified-consumed-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-verified-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "COMPLETED" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime(); // 임계(900초) 훌쩍 초과
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
    assert.equal(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT);
  });
});

// ---------------------------------------------------------------------------
// (1b) §1 요구: 검토자가 재현한 위조를 그대로 재현 -- 워크트리 안에
// 같은 이름의 새 파일(영수증)을 만드는 것만으로는(배달 영수증도
// 원장 경로도 전혀 없음) 더 이상 CONSUMED가 안 나온다.
// ---------------------------------------------------------------------------
test("HYK-340 2R P1-1: 위조 재현 -- 워크트리 안 영수증 파일만 있고(배달 영수증·원장 대조 자료 없음) -- CONSUMED가 나오지 않는다(여전히 SUSPECTED_UNCONSUMED) (1/1)", () => {
  withTempDir("hyk340-forged-receipt-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-forged-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    // 검토자가 재현한 정확한 형태: 워커가 워크트리 안에 직접 만들 수
    // 있는 영수증 파일 하나 -- 대조할 배달 영수증/원장은 아무것도 없다
    // (opts에 dispatchReceiptPath/admissionLedgerPath를 아예 안 준다 ==
    // 실 운용에서 env도 안 설정된 상태와 동형).
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {});
    assert.equal(
      result.verdict,
      UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
      "a workspace-only forged receipt must not produce CONSUMED",
    );
    assert.notEqual(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT);
  });
});

// ---------------------------------------------------------------------------
// (1c) fail-closed: 배달 영수증은 있는데 admission 원장을 못 읽으면(경로
// 미설정) -- CONSUMED로 접지 않는다(요구3).
// ---------------------------------------------------------------------------
test("HYK-340 2R P1-1 fail-closed: 배달 영수증은 일치하지만 admission 원장 경로가 없으면 -- CONSUMED로 접지 않는다 (1/1)", () => {
  withTempDir("hyk340-ledger-unreadable-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-noledger-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      // admissionLedgerPath 생략 + env에도 없음(테스트 프로세스 env에
      // ADMISSION_LEDGER_PATH가 실제로 안 잡혀 있다고 가정할 수 없으므로
      // 명시적으로 env를 빈 객체로 주입해 결정적으로 재현한다).
      env: {},
    });
    assert.notEqual(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (1d) fail-closed: 원장은 있지만 이 라운드 예약이 COMPLETED가 아니다
// (ACTIVE로 아직 진행 중, 또는 아예 없음) -- CONSUMED로 접지 않는다.
// ---------------------------------------------------------------------------
test("HYK-340 2R P1-1 fail-closed: 원장이 이 예약을 ACTIVE로 알면(아직 안 끝남) -- CONSUMED로 접지 않는다 (1/1)", () => {
  withTempDir("hyk340-ledger-active-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-active-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "ACTIVE" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.notEqual(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (1e) fail-closed: 원장은 COMPLETED로 알지만 배달 영수증이 이 라벨로는
// 없다(다른 라벨/역할) -- CONSUMED로 접지 않는다(둘 다 필요).
// ---------------------------------------------------------------------------
test("HYK-340 2R P1-1 fail-closed: 원장은 COMPLETED지만 배달 영수증에 이 라벨의 기록이 없으면 -- CONSUMED로 접지 않는다 (1/1)", () => {
  withTempDir("hyk340-no-receipt-match-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-nomatch-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      {
        role: "CODER",
        harness_task_label: "HYK-340-other-round",
        dispatchId: "ctx_9",
      },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "COMPLETED" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.notEqual(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (1f) fail-closed: 결과 파일이 라운드 라벨을 아예(또는 둘 이상) 에코하지
// 않으면 대조할 라벨 자체가 없어 CONSUMED로 접지 않는다.
// ---------------------------------------------------------------------------
test("HYK-340 2R P1-1 fail-closed: 결과 파일이 task_id를 에코하지 않으면 -- 대조할 라벨이 없어 CONSUMED로 접지 않는다 (1/1)", () => {
  withTempDir("hyk340-no-echo-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-noecho-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    // taskId를 안 줘서 결과 파일이 라벨을 에코하지 않는다.
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "COMPLETED" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.notEqual(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (1h) §0 검토자 2R probe 재현: 현재 라운드가 요구하는 라벨과 결과 파일이
// 에코한 라벨이 다르다(워커가 과거에 실제로 COMPLETED였던 다른 라벨을
// 그대로 복사해 넣은 형태) -- dispatch 영수증·원장은 그 "복사된" 옛
// 라벨로는 전부 진짜로 일치하지만, 그 라벨은 지금 이 라운드가 요구하는
// 라벨이 아니므로 CONSUMED가 나오면 안 된다(3R P1-1 요구1).
// ---------------------------------------------------------------------------
test("HYK-340 3R P1-1: 검토자 probe 재현 -- taskLabel(현재 요구)과 echoedResultLabel(결과 파일 주장)이 다르면(옛 완료 라벨 복사) CONSUMED가 안 나온다 (1/1)", () => {
  withTempDir("hyk340-label-mismatch-", (dir) => {
    initPlainGitRepo(dir);
    const currentLabel = "HYK-341-current-round";
    const previousLabel = "HYK-341-previous-completed";
    // 현재 라운드가 실제로 요구하는 라벨.
    writeTaskFile(dir, {
      taskId: currentLabel,
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    // 결과 파일은 그 이전에 진짜로 끝났던 라벨을 그대로 베껴 에코한다.
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: previousLabel,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    // 배달 영수증·원장은 그 옛 라벨로는 전부 진짜로 일치한다(검토자
    // probe와 동일 -- 위조가 아니라 "정말 예전에 끝난" 증거를 재사용).
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      {
        role: "CODER",
        harness_task_label: previousLabel,
        dispatchId: "ctx_old",
      },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [previousLabel]: { status: "COMPLETED" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.notEqual(
      result.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
      "copying a genuinely-completed past label must not hide the current round's non-consumption",
    );
  });
});

// ---------------------------------------------------------------------------
// (1i) §1 오탐 경계 확인: 같은 role의 다음 라운드 task 파일이 이미
// 드롭돼(현재 요구 라벨이 새 라벨로 바뀜) 결과 파일은 아직 방금 끝난
// 옛 라벨을 담고 있는 구간 -- 라벨 대조로는 receipt 신호가 안 서지만,
// 그 시점엔 이미 task 파일 자신의 mtime이 결과 파일보다 나중이므로
// TASK_FILE_DROPPED_AFTER 신호가 대신 선다 -- 여전히 CONSUMED(오탐 아님).
// ---------------------------------------------------------------------------
test("HYK-340 3R §1 오탐경계: 다음 라운드 task 파일이 이미 드롭된 구간(라벨이 바뀜) -- receipt 신호는 안 서도 TASK_FILE_DROPPED_AFTER로 여전히 CONSUMED (1/1)", () => {
  withTempDir("hyk340-label-boundary-", (dir) => {
    initPlainGitRepo(dir);
    const oldLabel = "HYK-340-boundary-old";
    const newLabel = "HYK-340-boundary-new";
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: oldLabel,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: oldLabel, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [oldLabel]: { status: "COMPLETED" },
    });
    // 다음 라운드 task 파일이 결과 파일보다 나중에 드롭된다 -- 현재
    // 요구 라벨은 이제 newLabel이다(옛 라벨과 다름).
    writeTaskFile(dir, {
      taskId: newLabel,
      mtimeIso: "2026-08-24T00:20:00Z",
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(
      result.verdict,
      UNCONSUMED_VERDICT.CONSUMED,
      "the next round's task-file drop must still consume the prior round even though the receipt-label check no longer applies",
    );
    assert.equal(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_TASK_DROP);
  });
});

// ---------------------------------------------------------------------------
// (1j) fail-closed: 현재 task 파일 자체를 못 읽으면(권한 등) 요구 라벨을
// 못 뽑으므로 CONSUMED로 접지 않는다.
// ---------------------------------------------------------------------------
test("HYK-340 3R P1-1 fail-closed: 현재 task 파일 내용을 못 읽으면(권한 등) -- 요구 라벨을 못 뽑아 CONSUMED로 접지 않는다 (1/1)", () => {
  withTempDir("hyk340-taskfile-unreadable-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-unreadable-task-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "COMPLETED" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
      taskFileContentReadFn: (p, ...rest) => {
        if (String(p).endsWith("coder-task.md")) {
          throw new Error("simulated read failure");
        }
        return readFileSync(p, ...rest);
      },
    });
    assert.notEqual(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (1g) 영속 포인터 경로: 실 운용에서는 env(ADMISSION_LEDGER_PATH)도
// --admission-ledger-path도 없는 것이 보통이다(admission-completion-
// adapter.mjs 자신의 헤더: "관제실은 이 env를 설정한 적이 없다") -- 그래도
// 이 축이 원장을 찾도록, 설치기가 남기는 포인터 파일(mainRepoRoot()/
// .harness/admission-ledger-path.json)을 그대로 재사용한다. gitCommonDirExecFn
// 을 주입해 "이 워크트리의 공통 git 디렉터리"를 결정적으로 재현한다.
// ---------------------------------------------------------------------------
test("HYK-340 2R P1-1: env/명시 인자 둘 다 없어도 -- 영속 포인터 파일(.harness/admission-ledger-path.json)로 원장을 찾아 CONSUMED가 나온다 (1/1)", () => {
  withTempDir("hyk340-persistent-pointer-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-pointer-1";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "COMPLETED" },
    });
    mkdirSync(join(dir, ".harness"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "admission-ledger-path.json"),
      JSON.stringify({ ledgerPath }),
      "utf8",
    );
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      env: {}, // ADMISSION_LEDGER_PATH도 명시 인자도 둘 다 없음.
      gitCommonDirExecFn: (cwd) =>
        // mkdtemp 워크트리 자신이 "메인"이므로, 그 자신의 .git 디렉터리를
        // 공통 디렉터리로 돌려준다(실 링크드 워크트리 대조는 이 시험
        // 범위 밖 -- resolvePersistentLedgerPathForUnconsumed 자신의
        // 경로 조립 로직만 결정적으로 재현한다).
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd,
          encoding: "utf8",
        }),
    });
    assert.equal(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
    assert.equal(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT);
  });
});

// ---------------------------------------------------------------------------
// (2) 340 회귀: 영수증이 없는 진짜 미소비는 여전히 SUSPECTED_UNCONSUMED
// (요구2 -- 오탐 반대 방향인 위양성 방지가 아니라, 새 신호가 없다고
// 기존 판정을 조용히 CONSUMED로 낙관하지 않는지 확인).
// ---------------------------------------------------------------------------
test("HYK-340 회귀: 영수증도 다른 소비 흔적도 전혀 없으면 -- 임계 초과 후 여전히 SUSPECTED_UNCONSUMED (1/1)", () => {
  withTempDir("hyk340-no-evidence-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t2",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (3) 영수증이 결과 파일보다 "이전"(정상적인 이전 라운드 잔재)이면 신호가
// 아니다 -- 여전히 SUSPECTED_UNCONSUMED(§2 unconsumed-core.mjs의 기존
// SIGNAL_BEFORE_RESULT 원칙과 동형). 이 경우 후보 자체가 없으므로(mtime
// 조건에서 이미 걸러짐) 독립 대조는 아예 시도되지 않는다.
// ---------------------------------------------------------------------------
test("HYK-340: 영수증이 결과 파일보다 이전(이전 라운드 잔재)이면 신호로 인정되지 않는다 -- SUSPECTED_UNCONSUMED 그대로 (1/1)", () => {
  withTempDir("hyk340-stale-receipt-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t3",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeReceiptAt(dir, { role: "coder", mtimeIso: "2026-08-24T00:05:00Z" });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (4) 다른 role의 영수증은 무시된다(예: review-receipt-r1.json이 새것이어도
// coder 결과를 소비한 증거로 오인하지 않는다).
// ---------------------------------------------------------------------------
test("HYK-340: 다른 role의 영수증(review-receipt-r1.json)은 coder 결과의 소비 흔적으로 인정되지 않는다 (1/1)", () => {
  withTempDir("hyk340-wrong-role-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t4",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    writeReceiptAt(dir, { role: "review", mtimeIso: "2026-08-24T00:15:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED);
  });
});

// ---------------------------------------------------------------------------
// (5) 대소문자 무관 매칭 + 정당한 소비: consumption-receipt-writer.mjs는
// role을 호출자 표기 그대로 파일명에 쓴다(binding.role만 대문자로 정규화,
// 파일명 자체는 안 바뀐다) -- 실 운용에서 "CODER-receipt-r1.json"(대문자)
// 가 생길 수 있으므로, task 파일 이름 관례의 소문자 role("coder")과도
// 대소문자 무관으로 매칭돼야 한다(consumption-receipt-writer.mjs의
// nextReceiptFileName과 동일 계약). 2R부터는 이 경로도 독립 대조를
// 통과해야 CONSUMED가 난다.
// ---------------------------------------------------------------------------
test("HYK-340 2R: 대문자 CODER-receipt-r1.json + 독립 대조 통과 -- role='coder' task 파일의 소비 흔적으로 인정된다(대소문자 무관) (1/1)", () => {
  withTempDir("hyk340-case-insensitive-", (dir) => {
    initPlainGitRepo(dir);
    const label = "HYK-340-t5";
    writeTaskFile(dir, { taskId: label, mtimeIso: "2026-08-24T00:00:00Z" });
    writeResultFileAt(dir, {
      updatedAtIso: "2026-08-24T00:10:00Z",
      taskId: label,
    });
    writeReceiptAt(dir, { role: "CODER", mtimeIso: "2026-08-24T00:15:00Z" });
    const receiptPath = writeDispatchReceiptsJsonl(dir, [
      { role: "CODER", harness_task_label: label, dispatchId: "ctx_1" },
    ]);
    const ledgerPath = writeAdmissionLedger(dir, {
      [label]: { status: "COMPLETED" },
    });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const result = judgeFor(dir, now, {
      dispatchReceiptPath: receiptPath,
      admissionLedgerPath: ledgerPath,
    });
    assert.equal(result.verdict, UNCONSUMED_VERDICT.CONSUMED);
    assert.equal(result.reasonCode, UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT);
  });
});

// ---------------------------------------------------------------------------
// (6) receipts 디렉터리 자체가 아직 없음(정상 -- 첫 라운드) -> 판정불가로
// 닫히지 않고 그냥 "영수증 신호 없음"으로 계속 판정한다.
// ---------------------------------------------------------------------------
test("HYK-340: .harness/receipts 디렉터리가 아예 없어도(정상, 첫 라운드) 판정불가(COLLECTION_FAILED)로 닫히지 않는다 (1/1)", () => {
  withTempDir("hyk340-no-receipts-dir-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t6",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T00:20:00Z").getTime(); // 임계 이내
    const result = judgeFor(dir, now);
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.JUDGED);
    assert.equal(result.verdict, UNCONSUMED_VERDICT.UNDECIDABLE);
  });
});

// ---------------------------------------------------------------------------
// (7) receipts 디렉터리 읽기 자체가 실패(ENOENT 아닌 다른 오류)하면
// 판정불가(COLLECTION_FAILED)로 닫힌다 -- "영수증 없음"으로 뭉개지 않는다
// (§3 코어 헤더 "판정할 수 없으면 조용히 정상으로 접지 않는다"와 동형).
// ---------------------------------------------------------------------------
test("HYK-340: receipts 디렉터리 조회 자체가 실패(EACCES 등)하면 -- '영수증 없음'으로 뭉개지 않고 COLLECTION_FAILED로 닫힌다 (1/1)", () => {
  withTempDir("hyk340-receipts-read-fail-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-340-t7",
      mtimeIso: "2026-08-24T00:00:00Z",
    });
    writeResultFileAt(dir, { updatedAtIso: "2026-08-24T00:10:00Z" });
    const now = new Date("2026-08-24T01:00:00Z").getTime();
    const evidence = collectUnconsumedCandidates(dir);
    const result = judgeUnconsumedForRepo(
      { repoRoot: dir, taskFileCandidates: evidence.items, now },
      {
        receiptsReaddirFn: () => {
          const err = new Error("permission denied");
          err.code = "EACCES";
          throw err;
        },
      },
    );
    assert.equal(result.status, UNCONSUMED_WIRE_STATUS.COLLECTION_FAILED);
    assert.match(result.reason, /receipts/);
  });
});
