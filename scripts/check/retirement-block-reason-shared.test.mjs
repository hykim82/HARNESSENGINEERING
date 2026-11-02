// HYK-457 §3-C: regression coverage for the exact drift shape that caused
// the real production failure this round fixes -- a new reason gets added
// to retirement-record-core.mjs's MECHANICALLY_CONFIRMABLE_BLOCK_REASONS
// (closed set), but one of the two implementations of
// confirmRetirementBlockReason never grows a branch for it, so that
// implementation silently falls through to `return null` for that reason
// forever (2026-09-08 ORCH-63 isolated measurement: HYK-455 added
// RUNNER_GREEN_UNREACHABLE_AT_HEAD to the set and wired a branch in
// dispatch-gate-decision.mjs's copy only -- admission-completion-adapter.mjs's
// copy fail-closed every real retirement using that reason). Merging the two
// copies into retirement-block-reason-shared.mjs (this round) makes that
// SPECIFIC drift structurally impossible (there is only one implementation
// now) -- but a future round could still add a reason to the closed set
// without adding a branch to the shared confirm function, silently
// reintroducing the same fail-closed shape from a single copy. §3-C's
// counting-tests-are-forbidden instruction ("개수만 세는 시험은 금지") is
// honored here by requiring, per reason, an actual fixture that proves the
// branch executes and returns the correct boolean -- not just that the
// element is present in the Set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  RETIREMENT_BLOCK_REASON,
  MECHANICALLY_CONFIRMABLE_BLOCK_REASONS,
} from "./retirement-record-core.mjs";
import { confirmRetirementBlockReason } from "./retirement-block-reason-shared.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// HYK-412 §2: CONSUMPTION_REFUSED_RUNNER_CONTRACT 전용 픽스처 조립 --
// relay-handshake.mjs의 persistRunnerContractRefusalRecordIfApplicable이
// 실제로 쓰는 것과 같은 모양(label/role/blockReasonCode/
// resultFingerprintSha256/receipts[]/reason/recordedAt)의 거부 기록을
// harnessDir/receipts/ 아래 직접 조립한다(프로덕션 writer를 호출하지
// 않는다 -- 이 시험은 confirmRetirementBlockReason의 재확인 자체만
// 고정한다, writer 자신의 동작은 relay-handshake.mjs 쪽 시험이 고정).
function buildRunnerContractRefusalFixture({
  harnessDir,
  resultText,
  tamperSha256 = false,
  allGreen = false,
}) {
  mkdirSync(join(harnessDir, "receipts"), { recursive: true });
  const headCommit = "b".repeat(40);
  // allGreen: 거부 기록이 "거부당했다"고 주장하면서도 그 거부 기록이
  // 가리키는 실제 영수증 파일은 runner_exit:0(초록)이다 -- 위조/오기
  // 표본(ⓓ 위반, product_scope "전부 초록" 음성 케이스).
  const receiptBody = JSON.stringify({
    schema_version: 2,
    runner_exit: allGreen ? 0 : 1,
    runner_status: allGreen ? "OK" : "TESTS_FAILED",
    head_commit: headCommit,
    finished_at: "2026-11-02 12:29:50 KST",
  });
  writeFileSync(
    join(harnessDir, "runner-receipt-run4.json"),
    receiptBody,
    "utf8",
  );
  const trueSha256 = sha256Hex(Buffer.from(receiptBody, "utf8"));
  const refusalRecord = {
    label: "HYK-412-table-T",
    role: "CODER",
    blockReasonCode:
      RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
    resultFingerprintSha256: sha256Hex(Buffer.from(resultText, "utf8")),
    receipts: [
      {
        path: "runner-receipt-run4.json",
        sha256: tamperSha256 ? "f".repeat(64) : trueSha256,
        runner_exit: allGreen ? 0 : 1,
        head_commit: headCommit,
      },
    ],
    reason:
      "consecutive runner receipt gate (HYK-485): runner_exit=1 (test fixture)",
    recordedAt: "2026-11-02T12:30:00.000Z",
  };
  writeFileSync(
    join(harnessDir, "receipts", "coder-runner-contract-refused-test.json"),
    JSON.stringify(refusalRecord),
    "utf8",
  );
}

// Per-reason (fixture, expected-verdict) pairs. Each builder returns the
// exact (record, resultText, droppedAt, harnessDir) confirmRetirementBlockReason
// takes, plus the boolean it must return for THIS evidence shape. Adding a
// new reason to MECHANICALLY_CONFIRMABLE_BLOCK_REASONS without adding a
// matching entry here fails the "every reason has a builder" assertion
// below -- adding a builder here for a reason the shared function still
// doesn't branch on fails the "returns the expected boolean, not null"
// assertion. Both failure modes are the HYK-457 regression shape.
const FIXTURE_BUILDERS = {
  [RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE]: () => ({
    record: {
      blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE,
    },
    resultText: ">>> DONE: CODER @ not-a-real-timestamp\n",
    droppedAt: "2025-01-01 00:00:00 KST",
    harnessDir: tmpDir("hyk457-table-parseable-"),
    expected: true,
  }),
  [RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT]: () => ({
    record: {
      blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT,
    },
    resultText: ">>> DONE: CODER @ 2020-01-01 00:00:00 KST\n",
    droppedAt: "2025-01-01 00:00:00 KST",
    harnessDir: tmpDir("hyk457-table-predates-"),
    expected: true,
  }),
  [RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD]: () => {
    const harnessDir = tmpDir("hyk457-table-runnergreen-");
    const headCommit = "a".repeat(40);
    writeFileSync(
      join(harnessDir, "runner-receipt.json"),
      JSON.stringify({ head_commit: headCommit, runner_exit: 1 }),
      "utf8",
    );
    return {
      record: {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
        evidenceReceiptPath: "runner-receipt.json",
      },
      resultText: `head_commit: ${headCommit}\n`,
      droppedAt: null,
      harnessDir,
      expected: true,
    };
  },
  // HYK-478 §1-2: AUTHOR_SEAT_LOST_BEFORE_STAMP -- GREEN 표본은 ⓐ완료
  // 표지 0개(resultText에 `>>> DONE:` 줄이 아예 없음) + ⓑ admission
  // 원장에서 그 harnessTaskLabel의 예약이 SUSPECT(sweepAndRecover가 이미
  // liveSeatKeys 부재를 근거로 새겨 둔 상태)여야 둘 다 참이다.
  [RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP]: () => {
    const harnessDir = tmpDir("hyk478-table-seatlost-");
    const harnessTaskLabel = "HYK-478-table-seatlost-round";
    const ledgerPath = join(harnessDir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: "admission-ledger/v1",
        reservations: {
          [harnessTaskLabel]: {
            status: "SUSPECT",
            admitted_at: "2026-09-16T00:00:00.000Z",
            completed_at: null,
            suspect_at: "2026-09-16T00:10:01.000Z",
            role: "CODER",
            seat_key: "seat-that-died",
          },
        },
      }),
      "utf8",
    );
    return {
      record: {
        blockReasonCode: RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
        harnessTaskLabel,
      },
      resultText: `task_id: ${harnessTaskLabel}\n`,
      droppedAt: null,
      harnessDir,
      ledgerPath,
      expected: true,
    };
  },
  // HYK-412 §2: CONSUMPTION_REFUSED_RUNNER_CONTRACT -- GREEN 표본은 거부
  // 기록이 존재하고 결과 지문이 일치하고 그 기록이 나열한 영수증의
  // sha256이 지금도 일치하고 그 영수증의 runner_exit이 실제로 0이 아닐
  // 때 참이다(buildRunnerContractRefusalFixture 참조).
  [RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT]: () => {
    const harnessDir = tmpDir("hyk412-table-runnercontract-");
    const resultText = "task_id: HYK-412-table-T\n";
    buildRunnerContractRefusalFixture({ harnessDir, resultText });
    return {
      record: {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
        evidenceReceiptPath: "receipts/coder-runner-contract-refused-test.json",
      },
      resultText,
      droppedAt: null,
      harnessDir,
      expected: true,
    };
  },
};

test("HYK-457 §3-C (HYK-478 확대): MECHANICALLY_CONFIRMABLE_BLOCK_REASONS's known reasons still each have a FIXTURE_BUILDERS entry (sanity floor for the loop below)", () => {
  assert.deepEqual(
    new Set(Object.keys(FIXTURE_BUILDERS)),
    new Set([...MECHANICALLY_CONFIRMABLE_BLOCK_REASONS]),
    "FIXTURE_BUILDERS and the live MECHANICALLY_CONFIRMABLE_BLOCK_REASONS set have drifted -- add/remove a builder to match",
  );
});

test("HYK-457 §3-C: every MECHANICALLY_CONFIRMABLE_BLOCK_REASONS member reaches a real branch in confirmRetirementBlockReason and returns the correct boolean (table-driven; auto-walks the LIVE set so a new reason is covered the moment it's added to both)", () => {
  for (const reason of MECHANICALLY_CONFIRMABLE_BLOCK_REASONS) {
    const builder = FIXTURE_BUILDERS[reason];
    assert.ok(
      builder,
      `MECHANICALLY_CONFIRMABLE_BLOCK_REASONS grew a new reason ('${reason}') with no FIXTURE_BUILDERS entry in this regression test -- this IS the HYK-457 drift shape: a reason can be "in the closed set" while nothing confirms it. Add a builder here.`,
    );
    const { record, resultText, droppedAt, harnessDir, ledgerPath, expected } =
      builder();
    const actual = confirmRetirementBlockReason(
      record,
      resultText,
      droppedAt,
      harnessDir,
      ledgerPath,
    );
    assert.equal(
      typeof actual,
      "boolean",
      `confirmRetirementBlockReason returned ${JSON.stringify(actual)} (not a boolean) for mechanically-confirmable reason '${reason}' -- this is exactly the HYK-457 regression: a reason is in the closed set but no branch confirms it, so it falls through to null and retirement-record-core.mjs's checkRetirementRecord rejects with BLOCK_REASON_UNCONFIRMED forever.`,
    );
    assert.equal(
      actual,
      expected,
      `unexpected verdict for reason '${reason}' with its GREEN fixture`,
    );
  }
});

// Negative counterpart: prove the table isn't just asserting "always true".
// Same three reasons, evidence deliberately broken one axis each.
test("HYK-457 §3-C negative: the same three reasons return false (not null, not true) when their evidence is broken", () => {
  assert.equal(
    confirmRetirementBlockReason(
      { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE },
      ">>> DONE: CODER @ 2025-01-01 00:00:00 KST\n",
      "2025-01-02 00:00:00 KST",
      tmpDir("hyk457-table-neg-parseable-"),
    ),
    false,
  );
  assert.equal(
    confirmRetirementBlockReason(
      { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT },
      ">>> DONE: CODER @ 2030-01-01 00:00:00 KST\n",
      "2025-01-01 00:00:00 KST",
      tmpDir("hyk457-table-neg-predates-"),
    ),
    false,
  );
  const harnessDir = tmpDir("hyk457-table-neg-runnergreen-");
  const headCommit = "a".repeat(40);
  writeFileSync(
    join(harnessDir, "runner-receipt.json"),
    JSON.stringify({ head_commit: headCommit, runner_exit: 0 }),
    "utf8",
  );
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD,
        evidenceReceiptPath: "runner-receipt.json",
      },
      `head_commit: ${headCommit}\n`,
      null,
      harnessDir,
    ),
    false,
  );
  // HYK-478 §1-2 negative (ⓐ 위반): 완료 표지가 실제로 «있는»데(1개)
  // AUTHOR_SEAT_LOST_BEFORE_STAMP를 대는 경우 -- ⓑ(원장 SUSPECT)는 참이어도
  // 전체는 거짓이어야 한다(§2 완료조건2 "하나라도 거짓이면 거부").
  const seatLostHarnessTaskLabel = "HYK-478-table-neg-seatlost-round";
  const seatLostLedgerPath = join(
    tmpDir("hyk478-table-neg-seatlost-"),
    "admission-ledger.json",
  );
  writeFileSync(
    seatLostLedgerPath,
    JSON.stringify({
      schema_version: "admission-ledger/v1",
      reservations: {
        [seatLostHarnessTaskLabel]: {
          status: "SUSPECT",
          admitted_at: "2026-09-16T00:00:00.000Z",
          completed_at: null,
          suspect_at: "2026-09-16T00:10:01.000Z",
          role: "CODER",
          seat_key: "seat-that-died",
        },
      },
    }),
    "utf8",
  );
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode: RETIREMENT_BLOCK_REASON.AUTHOR_SEAT_LOST_BEFORE_STAMP,
        harnessTaskLabel: seatLostHarnessTaskLabel,
      },
      `task_id: ${seatLostHarnessTaskLabel}\n>>> DONE: CODER @ 2026-09-16 00:20:00 KST\n`,
      null,
      tmpDir("hyk478-table-neg-seatlost-harnessdir-"),
      seatLostLedgerPath,
    ),
    false,
  );
});

// HYK-412 §2 negative -- 위 §3-C negative와 같은 원칙(세 reason은 참, 증거만
// 한 축씩 깨짐)을 CONSUMPTION_REFUSED_RUNNER_CONTRACT에도 적용한다. 별도
// test()로 뽑은 것은 §3-C negative 자체를 건드리지 않고(§2 완료조건
// "기존 사유 5개 시험 무회귀") quality-check의 max-lines-per-function 상한을
// 지키기 위해서다(판정/표본은 조금도 바뀌지 않는다).
test("HYK-412 §2 negative: CONSUMPTION_REFUSED_RUNNER_CONTRACT는 ⓐ 기록 없음 · ⓒ sha256 위조 · ⓓ 전부 초록 세 축 각각에서 false를 돌려준다(not null, not true)", () => {
  // ⓒ 위반: 거부 기록이 나열한 영수증의 sha256을 «위조»한 경우(기록이
  // 주장하는 값과 지금 다시 읽은 파일의 sha256이 다르다) -- ⓓ(runner_exit
  // ≠0)는 실제로 참이어도 전체는 거짓이어야 한다.
  const tamperedHarnessDir = tmpDir(
    "hyk412-table-neg-runnercontract-tampered-",
  );
  const tamperedResultText = "task_id: HYK-412-table-neg-T\n";
  buildRunnerContractRefusalFixture({
    harnessDir: tamperedHarnessDir,
    resultText: tamperedResultText,
    tamperSha256: true,
  });
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
        evidenceReceiptPath: "receipts/coder-runner-contract-refused-test.json",
      },
      tamperedResultText,
      null,
      tamperedHarnessDir,
    ),
    false,
  );

  // ⓓ 위반(전부 초록): 거부 기록이 나열한 영수증을 지금 다시 읽어도
  // (sha256은 일치) 그 실제 내용이 runner_exit:0(초록)인 경우 -- "거부
  // 기록이 존재하고 지문·sha256도 맞지만, 실제로는 거부할 근거가 하나도
  // 없었다"는 위조/오기 표본.
  const allGreenHarnessDir = tmpDir(
    "hyk412-table-neg-runnercontract-allgreen-",
  );
  const allGreenResultText = "task_id: HYK-412-table-neg-allgreen-T\n";
  buildRunnerContractRefusalFixture({
    harnessDir: allGreenHarnessDir,
    resultText: allGreenResultText,
    allGreen: true,
  });
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
        evidenceReceiptPath: "receipts/coder-runner-contract-refused-test.json",
      },
      allGreenResultText,
      null,
      allGreenHarnessDir,
    ),
    false,
  );

  // ⓐ 위반(기록 없음): evidenceReceiptPath가 아예 설정되지 않은 경우.
  assert.equal(
    confirmRetirementBlockReason(
      {
        blockReasonCode:
          RETIREMENT_BLOCK_REASON.CONSUMPTION_REFUSED_RUNNER_CONTRACT,
      },
      "task_id: HYK-412-table-neg-norecord-T\n",
      null,
      tmpDir("hyk412-table-neg-runnercontract-norecord-"),
    ),
    false,
  );
});

test("confirmRetirementBlockReason returns null (not a fake boolean) for a contract-text-only reason it cannot mechanically confirm", () => {
  assert.equal(
    confirmRetirementBlockReason(
      { blockReasonCode: RETIREMENT_BLOCK_REASON.DONE_REWRITE_LOCKED },
      ">>> DONE: CODER @ 2025-01-01 00:00:00 KST\n",
      "2025-01-02 00:00:00 KST",
      tmpDir("hyk457-table-nonmech-"),
    ),
    null,
  );
});
