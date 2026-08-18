// HYK-298-abort-record-1 §3 -- 「이름표 없이 죽은 라운드」를 «중단 기록»
// (abort record)으로 소비 완료 인정하는 축이 실제 배달 게이트 진입점
// (dispatch-gate-decision.mjs)에 결선됐는지를 증명한다.
//
// ★공통 문장(coder-task.md): "검사를 건너뛰게 만드는 것은 수리가 아니다.
// 검사가 «만족»되어야 한다." -- 이 파일의 세 묶음(§A/§B/§C)이 각각 그
// 문장의 세 조각을 실행 출력으로 보인다:
//   §A 진짜 중단 -> 정식 통과(사람이 파일을 치우는 동작 0)
//   §B 위조 중단 기록(지문/dispatchId/회수표식 각각) -> 거부, 각각 따로
//   §C 내용 있는 미소비는 중단 기록을 붙이든 말든 여전히 차단
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { writeAbortRecord } from "./abort-record-writer.mjs";
import {
  createEmptyLedger,
  admitReservation,
  sweepAndRecover,
} from "../supervisor/admission-ledger-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");
const CORE_PATH = join(HERE, "dispatch-gate-decision-core.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const REJECT_STREAK_CHAIN_PATH = join(HERE, "reject-streak-chain.mjs");
const CONSUMPTION_RECEIPT_CORE_PATH = join(
  HERE,
  "consumption-receipt-core.mjs",
);
const DROPPED_AT_STAMP_CORE_PATH = join(HERE, "dropped-at-stamp-core.mjs");
const ABORT_RECORD_CORE_PATH = join(HERE, "abort-record-core.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-abort-test-"));
  try {
    // HYK-298-abort-record-2 §D: 반환값을 그대로 전달한다(기존 호출자들은
    // 무시했으니 회귀 없음) -- runBrokenLabelCase가 §D-4에서 gate 결과를
    // 이어서 단언하려면 이 값이 필요하다.
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(scriptPath, args) {
  const result = spawnSync("node", [scriptPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function computeFingerprint(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeDispatchReceiptLine(
  path,
  { role, harnessTaskLabel, dispatchId },
  append = false,
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
  const line = JSON.stringify(record) + "\n";
  if (append) {
    writeFileSync(
      path,
      (existsSafe(path) ? readFileSync(path, "utf8") : "") + line,
      "utf8",
    );
  } else {
    writeFileSync(path, line, "utf8");
  }
}

function existsSafe(path) {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

// 다음 라운드가 드롭돼 <role>-task.md만 덮어쓴 상태 -- 결과 파일
// (<role>.md)은 손대지 않는다(직전 라운드 것 그대로 남는다), 게이트가
// 실제로 도는 시점의 정확한 모양(dispatch-gate-consumption-wire.test.mjs
// 의 seedHandoff와 동일 원칙).
function writeNextTaskFile(dir, role, nextTaskId, nextDroppedAt) {
  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${nextTaskId}\ndropped_at: ${nextDroppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
  return taskPath;
}

// admission-ledger-core.mjs의 실물 함수(admitReservation ->
// sweepAndRecover ACTIVE->SUSPECT -> sweepAndRecover SUSPECT->COMPLETED)를
// 그대로 돌려 SUSPECT_TIMEOUT_RECOVERED 표식을 진짜로 만든다(합성 JSON을
// 손으로 짜지 않는다 -- HYK-244 2R-b3 §3가 반려된 이유(헛시험)와 같은
// 함정을 피한다). admission-completion-adapter.mjs 자신의 실증
// (spawnAdmissionCompletion(taskId), relay-handshake.mjs 1058-1064행)을
// 따라 reservationId = harnessTaskLabel로 admit한다.
function buildRealRecoveredLedger(harnessTaskLabel) {
  let ledger = createEmptyLedger("2026-08-18T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: harnessTaskLabel,
    cap: 1,
    now: "2026-08-18T00:00:00.000Z",
    role: "REVIEW",
    seatKey: "seat-that-died",
  });
  assert.equal(
    admit.decision,
    "ADMITTED",
    "픽스처 전제: 예약이 실제로 admit 돼야 한다",
  );
  ledger = admit.ledger;

  const staleAfterMs = 5 * 60 * 1000;
  const recoveryGraceMs = 10 * 60 * 1000;
  const toSuspect = sweepAndRecover(ledger, {
    now: "2026-08-18T00:10:01.000Z", // staleAfterMs 경과, seat-key가 liveSeatKeys에 없음
    liveSeatKeys: [],
    staleAfterMs,
    recoveryGraceMs,
  });
  assert.equal(toSuspect.ok, true);
  assert.equal(
    toSuspect.changed[0].to,
    "SUSPECT",
    "픽스처 전제: ACTIVE->SUSPECT 전이가 실제로 일어나야 한다",
  );
  ledger = toSuspect.ledger;

  const toCompleted = sweepAndRecover(ledger, {
    now: "2026-08-18T00:20:02.000Z", // recoveryGraceMs 경과, 여전히 안 살아남
    liveSeatKeys: [],
    staleAfterMs,
    recoveryGraceMs,
  });
  assert.equal(toCompleted.ok, true);
  assert.equal(
    toCompleted.ledger.reservations[harnessTaskLabel].completion_reason,
    "SUSPECT_TIMEOUT_RECOVERED",
    "픽스처 전제: 실물 sweepAndRecover가 진짜로 이 표식을 남겨야 한다",
  );
  return toCompleted.ledger;
}

// 이 파일 전체가 공유하는 "이름표 없이 죽은 라운드" 픽스처 구성 -- 실측
// 원문(coder-task.md §1)과 동일한 모양: 결과 파일에 task_id: 줄이 없다.
function buildDeadRoundFixture(dir) {
  const role = "review";
  const deadHarnessTaskLabel = "HYK-9200-abort-dead-round";
  const deadDispatchId = "ctx_test_abort_dead_1";
  const deadResultContent =
    "dispatch_verified: yes\ntask_id_from_dispatch: task_2b5c1ad861aa\npane_match: x == x ? 일치\n";
  writeFileSync(join(dir, `${role}.md`), deadResultContent, "utf8");

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: "REVIEW",
    harnessTaskLabel: deadHarnessTaskLabel,
    dispatchId: deadDispatchId,
  });

  const taskPath = writeNextTaskFile(
    dir,
    role,
    "HYK-9200-abort-dead-round-next",
    "2026-08-18 10:00:00 KST",
  );

  const ledgerPath = join(dir, "admission-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify(buildRealRecoveredLedger(deadHarnessTaskLabel)) + "\n",
    "utf8",
  );

  const streakLedgerPath = join(dir, "reject-streak.json");
  writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

  return {
    role,
    dir,
    taskPath,
    dispatchReceiptPath,
    ledgerPath,
    streakLedgerPath,
    deadHarnessTaskLabel,
    deadDispatchId,
    deadResultContent,
  };
}

function runGate(fixture, extraArgs = []) {
  return runCli(SCRIPT_PATH, [
    fixture.taskPath,
    "--ledger",
    fixture.streakLedgerPath,
    "--dispatch-receipt-path",
    fixture.dispatchReceiptPath,
    "--admission-ledger-path",
    fixture.ledgerPath,
    ...extraArgs,
  ]);
}

// ---------------------------------------------------------------------------
// §A -- 진짜 중단 -> 정식 통과. 사람이 결과 파일을 치우는 동작 0.
// ---------------------------------------------------------------------------

test("§A GREEN: 이름표 없이 죽은 라운드 + 검증 가능한 중단 기록(지문·dispatchId·회수표식 셋 다 실물) -> 다음 배달 ALLOW", () => {
  withFixtureDir((dir) => {
    const fixture = buildDeadRoundFixture(dir);
    // ⛔결과 파일(review.md)을 치우거나 손질하지 않는다 -- 있는 그대로 둔
    // 채 중단 기록만 별도로 남긴다(coder-task.md §3 항1: "사람이 파일을
    // 치우는 동작 0").
    const write = writeAbortRecord({
      role: "REVIEW",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.deadHarnessTaskLabel,
      dispatchId: fixture.deadDispatchId,
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.deadResultContent),
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: "sweep SUSPECT_TIMEOUT_RECOVERED (admission-ledger.json)",
    });
    assert.equal(
      write.ok,
      true,
      `중단 기록 작성 자체가 실패하면 전제가 무너진다: ${write.reason}`,
    );
    assert.deepEqual(readdirSync(join(dir, "aborts")), [
      "REVIEW-abort-r1.json",
    ]);

    const r = runGate(fixture);
    assert.equal(r.status, 0, `ALLOW 기대, 실제 stderr: ${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stderr,
      /abort-record:/,
      "이 축 고유의 사유가 stderr에 찍혀야 한다(조용한 통과 금지)",
    );
  });
});

test("§A 대조군(회귀 0): 중단 기록을 아예 안 남기면 원래 사고와 똑같이 REJECT(옛 경로 문구 그대로 보존)", () => {
  withFixtureDir((dir) => {
    const fixture = buildDeadRoundFixture(dir);
    // 중단 기록을 만들지 않는다 -- .harness/aborts/ 디렉터리 자체가 없다.
    const r = runGate(fixture);
    assert.notEqual(
      r.status,
      0,
      "중단 기록이 없으면 여전히 거부돼야 한다(원래 사고 그대로)",
    );
    assert.match(r.stderr, /consumption-receipt:/);
    assert.match(
      r.stderr,
      /배달 식별자\(dispatchId\)가 없거나 비어 있음/,
      "옛 경로의 정확한 사유 문구가 그대로 보존돼야 한다(회귀 0)",
    );
  });
});

// ---------------------------------------------------------------------------
// §B -- 위조 중단 기록 3종, 각각 따로 거부되는 것을 실행으로 보인다.
// ---------------------------------------------------------------------------

test("§B-1 위조(지문 불일치): 중단 기록의 leftoverFingerprint가 실제 live 결과 파일과 다름(위조 지문) -> REJECT", () => {
  withFixtureDir((dir) => {
    const fixture = buildDeadRoundFixture(dir);
    writeAbortRecord({
      role: "REVIEW",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.deadHarnessTaskLabel,
      dispatchId: fixture.deadDispatchId,
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(
        "이것은 실제 결과 파일 내용이 아니다(위조 지문)",
      ),
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: "위조 -- 지문 불일치 시험용",
    });

    const r = runGate(fixture);
    assert.notEqual(r.status, 0, "지문이 실제 파일과 다르면 REJECT여야 한다");
    assert.match(r.stderr, /abort-record:/);
    assert.match(r.stderr, /일치하는 중단 기록 후보가 하나도 없음/);
  });
});

test("§B-2 위조(dispatchId 불명): 중단 기록의 dispatchId가 배달 영수증(dispatch-receipts.jsonl)에 없음 -> REJECT", () => {
  withFixtureDir((dir) => {
    const fixture = buildDeadRoundFixture(dir);
    writeAbortRecord({
      role: "REVIEW",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.deadHarnessTaskLabel,
      dispatchId: "ctx_forged_never_dispatched",
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.deadResultContent),
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: "위조 -- dispatchId 불명 시험용",
    });

    const r = runGate(fixture);
    assert.notEqual(
      r.status,
      0,
      "dispatchId가 배달 영수증에 없으면 REJECT여야 한다",
    );
    assert.match(r.stderr, /abort-record:/);
    assert.match(r.stderr, /dispatchId가 배달 영수증.*확인되지 않음/);
  });
});

test("§B-3 위조(회수 표식 없음): dispatchId는 진짜지만 admission 원장에 SUSPECT_TIMEOUT_RECOVERED 표식이 없음(회수 사실 미확인) -> REJECT", () => {
  withFixtureDir((dir) => {
    const fixture = buildDeadRoundFixture(dir);
    // 원장을 "예약이 아예 없던" 빈 상태로 덮어쓴다(admin이 실제로 회수
    // 처리한 적이 없다는 것과 같은 모양) -- dispatchId 축은 통과하도록
    // 그대로 두고 이 축 하나만 격리한다.
    writeFileSync(
      fixture.ledgerPath,
      JSON.stringify({
        schema_version: "admission-ledger/v1",
        reservations: {},
      }) + "\n",
      "utf8",
    );
    writeAbortRecord({
      role: "REVIEW",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.deadHarnessTaskLabel,
      dispatchId: fixture.deadDispatchId,
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.deadResultContent),
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: "위조 -- 회수 표식 없음 시험용(ORCH가 «그렇다»고만 주장)",
    });

    const r = runGate(fixture);
    assert.notEqual(
      r.status,
      0,
      "회수 표식이 없으면 REJECT여야 한다 -- 사람 말만으로는 안 된다",
    );
    assert.match(r.stderr, /abort-record:/);
    assert.match(r.stderr, /회수 표식\(SUSPECT_TIMEOUT_RECOVERED\)이 없음/);
  });
});

// ---------------------------------------------------------------------------
// §C -- 내용 있는(판정이 적힌) 미소비 결과 파일은, 중단 기록을 붙이든
// 말든 여전히 REJECT.
// ---------------------------------------------------------------------------

test("§C 진짜 미소비 여전히 차단: task_id: 이름표가 있는(=내용 있는) 미소비 결과 파일에 지문·dispatchId·회수표식이 전부 «유효한» 중단 기록을 붙여도 REJECT 유지(이 축 자체가 적용되지 않는다)", () => {
  withFixtureDir((dir) => {
    const role = "coder";
    const prevTaskId = "HYK-9201-abort-content-bearing-prev";
    const nextTaskId = "HYK-9201-abort-content-bearing-next";
    const droppedAt = "2026-08-18 09:00:00 KST";
    const doneAt = "2026-08-18 09:10:05 KST";
    // ⛔이름표가 있다(task_id: 줄 존재) -- "죽은 라운드"가 아니라 정상
    // 완료처럼 보이지만 아직 소비(영수증)되지 않은 상태 그대로다.
    const liveResultContent = `task_id: ${prevTaskId}\nverdict: approved\n\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`;
    writeFileSync(join(dir, `${role}.md`), liveResultContent, "utf8");

    const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
    writeDispatchReceiptLine(dispatchReceiptPath, {
      role: "CODER",
      harnessTaskLabel: prevTaskId,
      dispatchId: "ctx_test_content_bearing",
    });

    const ledgerPath = join(dir, "admission-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify(buildRealRecoveredLedger(prevTaskId)) + "\n",
      "utf8",
    );

    // 지문·dispatchId·회수표식 셋 다 «진짜로» 검증 가능한 중단 기록을
    // 이 내용 있는 파일에 그대로 붙인다(공격/오조작 시나리오 재현).
    const write = writeAbortRecord({
      role: "CODER",
      harnessDir: dir,
      harnessTaskLabel: prevTaskId,
      dispatchId: "ctx_test_content_bearing",
      droppedAt,
      leftoverFingerprint: computeFingerprint(liveResultContent),
      leftoverPath: "coder.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: "§C 시험: 유효한 중단 기록을 내용 있는 파일에 붙임",
    });
    assert.equal(write.ok, true);

    const taskPath = writeNextTaskFile(
      dir,
      role,
      nextTaskId,
      "2026-08-18 10:00:00 KST",
    );
    const streakLedgerPath = join(dir, "reject-streak.json");
    writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      streakLedgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
      "--admission-ledger-path",
      ledgerPath,
    ]);
    assert.notEqual(
      r.status,
      0,
      "내용 있는 미소비는 유효한 중단 기록을 붙여도 여전히 REJECT여야 한다",
    );
    assert.match(r.stderr, /consumption-receipt:/);
    assert.match(r.stderr, /영수증 후보가 하나도 없음/);
    assert.doesNotMatch(
      r.stderr,
      /abort-record: 중단 기록.*허용/,
      "이 축 자체가 적용되지 않아야 한다(이름표가 있으므로 진입 조건 자체가 거짓)",
    );
  });
});

// ---------------------------------------------------------------------------
// §D -- HYK-298-abort-record-2(1R 반려 원문 대응) -> HYK-298-label-
// classify-3 §2-3(단락 순서 수리, 검토가 반려) -> HYK-298-key-narrow-4
// §2(열쇠 좁히기, 검토가 다시 반려) -> HYK-298-label-boundary-5 §2(경계
// 수리)로 갱신. 4R까지는 "줄머리 표지가 없으면 곧바로 MISSING"이라는
// 규칙이 남아 있었는데, 그 규칙 아래서는 `middle_of_line`("참고:
// task_id: HYK-…"처럼 줄 중간에만 표지가 있는 경우)이 "진짜 죽은
// 라운드"와 똑같이 취급돼 abort-record 축(중단 기록만으로 통과)을 탔다
// -- 4형태 중 그것만 `allow:true`로 남았다(4R 검토 실측). 이번 라운드는
// ★공통 문장을 다시 적용한다: "표지가 «아예 없는 것»과 «쓰려다 잘못
// 쓴 것»은 다르다." 줄머리 표지가 없을 때(`looseLines === 0`) 원시
// 출현(어디든 "task_id:"가 한 번이라도 등장하는지)을 한 번 더 물어 --
// 하나라도 있으면 `BROKEN`(쓰려다 잘못 씀, 차단), 전혀 없으면
// `MISSING`(진짜 죽음, 중단 기록으로 통과) -- 이제 4형태 전부(middle_of_
// line 포함) `kind === "BROKEN"`으로 통일된다. 그래서 아래는 4형태
// 전부 같은 기대치를 공유한다:
//   §D-a (record 있음): 4형태 전부 **REJECT**다(★5R 존재 이유 그 자체,
//     middle_of_line도 이제 포함) -- 중단 기록을 붙여도 그 축 자체가
//     시도되지 않는다(abort_axis 항상 false).
//   §D-b (record 없음, 진짜 미소비): 4형태 전부 REJECT 유지(회귀 0) --
//     abort-record 축 자체를 안 타므로 사유 문구는 옛
//     consumption-receipt 일반 사유("배달 식별자(dispatchId)가 없거나
//     비어 있음")다(BROKEN에게 특별 취급 없음, 4R부터 동일).
// ---------------------------------------------------------------------------

// 이름표는 깨졌지만(review.md), «완전히 유효한» 중단 기록(지문·dispatchId·
// 회수표식 셋 다 실물)을 붙인 상태를 만든다(§C와 동일한 정신 -- 헛시험이
// 아니려면 진짜로 검증 가능한 기록이어야 한다). `attachRecord=false`면
// 기록을 아예 안 남겨(aborts 디렉터리 자체가 없음) "진짜 미소비" 대조군을
// 만든다.
function buildBrokenLabelFixture(
  dir,
  caseName,
  brokenContent,
  { attachRecord = true } = {},
) {
  const role = "review";
  const harnessTaskLabel = `HYK-9300-broken-${caseName}`;
  const dispatchId = `ctx_test_broken_${caseName}`;
  writeFileSync(join(dir, `${role}.md`), brokenContent, "utf8");

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: "REVIEW",
    harnessTaskLabel,
    dispatchId,
  });

  const taskPath = writeNextTaskFile(
    dir,
    role,
    `${harnessTaskLabel}-next`,
    "2026-08-18 10:00:00 KST",
  );

  const ledgerPath = join(dir, "admission-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify(buildRealRecoveredLedger(harnessTaskLabel)) + "\n",
    "utf8",
  );

  const streakLedgerPath = join(dir, "reject-streak.json");
  writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

  if (attachRecord) {
    const write = writeAbortRecord({
      role: "REVIEW",
      harnessDir: dir,
      harnessTaskLabel,
      dispatchId,
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(brokenContent),
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: `§D 깨진 이름표 시험(${caseName}) -- 완전히 유효한 기록`,
    });
    assert.equal(write.ok, true, write.reason);
  }

  return {
    role,
    dir,
    taskPath,
    dispatchReceiptPath,
    ledgerPath,
    streakLedgerPath,
    harnessTaskLabel,
    dispatchId,
    brokenContent,
  };
}

// abort_axis: 중단 기록 축이 실제로 후보를 살펴봤다는 흔적(stderr에
// "중단 기록(" 문구)이 있는지. VERIFIED/NO_RECORD(후보 있음)/AMBIGUOUS/
// DISPATCH_ID_UNVERIFIED/RECOVERY_MARKER_MISSING 사유 전부 "중단 기록("
// 문구를 담는다(abort-record-core.mjs의 describeRecord 참조). 4R부터는
// kind===BROKEN이면 이 축 자체가 호출되지 않으므로(§2 열쇠 좁히기)
// attach_record 값과 무관하게 항상 false여야 한다 -- 그것이 "더 이상
// 열쇠가 아니다"의 실행 증거다.
function runBrokenLabelCase(caseName, brokenContent, { attachRecord }) {
  return withFixtureDir((dir) => {
    const fixture = buildBrokenLabelFixture(dir, caseName, brokenContent, {
      attachRecord,
    });
    const r = runGate(fixture);
    const abortAxisTouched = /중단 기록\(/.test(r.stderr);
    console.log(
      JSON.stringify({
        case: caseName,
        attach_record: attachRecord,
        result_status: r.status,
        allow: r.status === 0,
        abort_axis: abortAxisTouched,
      }),
    );
    return { r, abortAxisTouched };
  });
}

// HYK-298-label-boundary-5 §2 항ⓐ: middle_of_line은 이제 kind==="BROKEN"
// 이다(줄머리 표지는 없지만 원시 출현이 1건 있음 -- "표지가 아예 없는
// 것"과 "쓰려다 잘못 쓴 것"을 가르는 새 재질문이 여기서 갈라진다, 4R이
// 열어둔 구멍의 수리). 4형태 전부 이제 kind===BROKEN으로 통일됐으므로
// (looseLines===0이면서 원시 출현이 있는 middle_of_line도 포함) 더 이상
// kind별 분기가 필요 없다 -- 4형태 전부 같은 기대치를 공유한다.
const BROKEN_FORMS = [
  {
    name: "multiple",
    label: "복수(task_id: 줄이 2개)",
    content:
      "task_id: HYK-9300-broken-multiple\ntask_id: HYK-9300-broken-multiple-dup\n>>> DONE: REVIEW @ 2026-08-18 03:00:00 KST\n",
  },
  {
    name: "whitespace_eof",
    label: "공백/빈 값, EOF",
    content: "task_id:   \n",
  },
  {
    name: "middle_of_line",
    label:
      "줄 중간(줄머리 표지는 없지만 원시 출현 있음 -- ★5R부터 BROKEN, 쓰려다 잘못 쓴 것)",
    content:
      "참고: task_id: HYK-9300-broken-middle\n>>> DONE: REVIEW @ 2026-08-18 03:00:00 KST\n",
  },
  {
    name: "whitespace_crossline",
    label: "공백줄넘김 오인식",
    content: "task_id:\nverdict: approved\n",
  },
];

for (const form of BROKEN_FORMS) {
  test(`§D-a ${form.label} + 완전히 유효한 중단 기록 -> REJECT(★5R 존재 이유 포함: 중단 기록은 BROKEN의 열쇠가 아니다, middle_of_line도 이제 여기 포함)(case="${form.name}")`, () => {
    const { r, abortAxisTouched } = runBrokenLabelCase(
      form.name,
      form.content,
      { attachRecord: true },
    );
    assert.notEqual(
      r.status,
      0,
      `${form.label}은 완전히 유효한 중단 기록을 붙여도 REJECT여야 한다(★합격 기준 항1, 중단 기록은 BROKEN의 열쇠가 아니다): stderr=${r.stderr}`,
    );
    assert.equal(
      abortAxisTouched,
      false,
      "kind===BROKEN이면 중단 기록 축 자체가 호출되지 않아야 한다(더 이상 열쇠가 아니므로 후보를 읽지도 않는다)",
    );
  });

  test(`§D-b ${form.label} + 중단 기록 없음(진짜 미소비) -> REJECT 유지(case="${form.name}")`, () => {
    const { r, abortAxisTouched } = runBrokenLabelCase(
      form.name,
      form.content,
      { attachRecord: false },
    );
    assert.notEqual(
      r.status,
      0,
      `${form.label} + 기록 없음은 여전히 REJECT여야 한다(영수증 없는 진짜 미소비)`,
    );
    assert.equal(
      abortAxisTouched,
      false,
      "이 라운드를 가리키는 중단 기록 후보가 하나도 없으면(또는 애초에 그 축을 타지 않으면) 축이 로그를 남기지 않는다",
    );
    // 4R부터 BROKEN 3형태는 abort-record 축 자체를 타지 않으므로 3R의
    // "«없음»이 아니라 «깨짐»" 사유 대신 옛 consumption-receipt 일반
    // 사유로 떨어진다 -- kind와 무관하게 이제 «똑같은» 문구다(BROKEN에게
    // 더 이상 특별 취급이 없다는 뜻 그 자체, ⓐ의 실행 증거).
    assert.match(r.stderr, /consumption-receipt:/);
    assert.match(r.stderr, /배달 식별자\(dispatchId\)가 없거나 비어 있음/);
  });
}

test('§D-crossline 회귀 확인: "task_id:\\nverdict: approved\\n"는 기록 유무와 무관하게 다음 줄 값을 «집어오지 않는다»(label=verdict: 오추출 흔적 없음)', () => {
  const withRecord = runBrokenLabelCase(
    "whitespace_crossline",
    "task_id:\nverdict: approved\n",
    { attachRecord: true },
  );
  const withoutRecord = runBrokenLabelCase(
    "whitespace_crossline",
    "task_id:\nverdict: approved\n",
    { attachRecord: false },
  );
  // ⓒ 원인 수리 확인: 옛 버그는 이 표적에서 "verdict:"를 값으로 집어와
  // BINDING_MISMATCH/BROKEN 사유에 그 오추출값이 노출됐다(1R 반려 원문).
  // 수리 후에는 그 오추출 흔적 자체가 사라져야 한다 -- 기록 유무 둘 다.
  assert.doesNotMatch(withRecord.r.stderr, /label=verdict:/);
  assert.doesNotMatch(withoutRecord.r.stderr, /label=verdict:/);
});

test("§D-5 대조군(회귀 0): 1R §A(진짜 「이름표 없음」)는 이번 수정 이후에도 그대로 ALLOW", () => {
  withFixtureDir((dir) => {
    const fixture = buildDeadRoundFixture(dir);
    const write = writeAbortRecord({
      role: "REVIEW",
      harnessDir: fixture.dir,
      harnessTaskLabel: fixture.deadHarnessTaskLabel,
      dispatchId: fixture.deadDispatchId,
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: computeFingerprint(fixture.deadResultContent),
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 10:05:00 KST",
      evidence: "§D-5 회귀 대조군",
    });
    assert.equal(write.ok, true, write.reason);
    const r = runGate(fixture);
    console.log(
      JSON.stringify({
        case: "missing_real",
        result_status: r.status,
        allow: r.status === 0,
        abort_axis: /abort-record:/.test(r.stderr),
      }),
    );
    assert.equal(
      r.status,
      0,
      `ALLOW 기대(진짜 이름표 없음), 실제 stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// RED(변이, 필수, HYK-298-label-boundary-5 §2 ⓓ): looseLines===0일 때의
// 원시 출현 재질문을 제거하면(줄머리 없음 -> 곧바로 MISSING이던 4R
// 이전 동작으로 되돌리면), middle_of_line + 중단 기록이 다시 ALLOW로
// 새는지 확인하고 즉시 원복한다 -- 이 경계 수리가 실제로 결과를 바꾼다는
// 증거(4R이 반려된 바로 그 결함의 재현). ⛔변이는 격리 tmpdir에만
// 적용하고, 원본 파일은 시험 전후 바이트 동일함을 아래에서 직접 확인.
// ---------------------------------------------------------------------------

test("RED(변이, 필수, 5R §2 ⓓ): classifyTaskIdLabel의 looseLines===0 원시 출현 재질문을 제거하면(4R 이전 동작으로 되돌리면), middle_of_line + 완전히 유효한 중단 기록이 다시 ALLOW로 샌다", () => {
  const srcBefore = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    'function classifyTaskIdLabel(resultText) {\n  const looseLines = [...resultText.matchAll(TASK_ID_LOOSE_LINE_RE)].length;\n  if (looseLines === 0) {\n    const anyCount = [...resultText.matchAll(TASK_ID_ANY_RE)].length;\n    if (anyCount === 0) {\n      return { kind: "MISSING", looseLines: 0, strictCount: 0 };\n    }\n    return { kind: "BROKEN", looseLines: 0, strictCount: 0, anyCount };\n  }\n  const strictMatches = [...resultText.matchAll(CONSUMPTION_TASK_ID_RE_G)];';
  assertExactlyOneMatch(
    srcBefore,
    target,
    "classifyTaskIdLabel looseLines===0 원시 출현 재질문",
  );
  const mutated = srcBefore.replace(
    target,
    'function classifyTaskIdLabel(resultText) {\n  const looseLines = [...resultText.matchAll(TASK_ID_LOOSE_LINE_RE)].length;\n  if (looseLines === 0) {\n    return { kind: "MISSING", looseLines: 0, strictCount: 0 };\n  }\n  const strictMatches = [...resultText.matchAll(CONSUMPTION_TASK_ID_RE_G)];',
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-abort-boundary-mut-"),
    );
    try {
      const brokenContent =
        "참고: task_id: HYK-9302-red-middle\n>>> DONE: REVIEW @ 2026-08-18 03:00:00 KST\n";
      const fixture = buildBrokenLabelFixture(
        fixtureDir,
        "red-middle_of_line",
        brokenContent,
        { attachRecord: true },
      );
      const r = runCli(mutantPath, [
        fixture.taskPath,
        "--ledger",
        fixture.streakLedgerPath,
        "--dispatch-receipt-path",
        fixture.dispatchReceiptPath,
        "--admission-ledger-path",
        fixture.ledgerPath,
      ]);
      assert.equal(
        r.status,
        0,
        `RED: looseLines===0의 원시 출현 재질문을 제거하면 middle_of_line(완전히 유효한 기록 붙음)이 다시 ALLOW로 새야 한다 -- 4R이 반려된 결함의 재현: stderr=${r.stderr}`,
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  const srcAfter = readFileSync(SCRIPT_PATH, "utf8");
  assert.equal(
    srcAfter,
    srcBefore,
    "원본 dispatch-gate-decision.mjs는 이 시험 전후 바이트 동일해야 한다(변이는 격리 tmpdir 사본에만 적용됐다)",
  );
});

// ---------------------------------------------------------------------------
// RED(변이, 필수, HYK-298-key-narrow-4 §2 ⓓ): 열쇠 좁히기를 되돌려
// BROKEN도 다시 중단 기록 축을 타게 만들면, 완전히 유효한 중단 기록이
// 붙은 4형태(복수·공백/빈값·줄 중간·줄넘김 오인식)가 검토가 재현한 원문
// 그대로 다시 ALLOW로 새는지 확인하고 즉시 원복한다 -- 이 열쇠 좁히기가
// 실제로 결과를 바꾼다는 증거(3R이 반려된 바로 그 결함의 재현).
// ---------------------------------------------------------------------------

test("RED(변이, 필수, 4R §2 ⓓ): maybeResolveAbortRecordForMissingLabel이 BROKEN도 다시 중단 기록 축을 타게(3R 옛 동작으로) 되돌리면, 완전히 유효한 기록이 붙은 4형태가 검토 반려 원문 그대로 다시 ALLOW로 샌다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    'function maybeResolveAbortRecordForMissingLabel({\n  labelInfo,\n  role,\n  harnessDir,\n  resultText,\n  receiptPath,\n  args,\n  env,\n}) {\n  if (labelInfo.kind !== "MISSING") return { done: false };\n  return resolveAbortRecordOutcome({\n    role,\n    harnessDir,\n    resultText,\n    receiptPath,\n    admissionLedgerPath: resolveAdmissionLedgerPathForAbort(args, env),\n  });\n}';
  assertExactlyOneMatch(
    src,
    target,
    "maybeResolveAbortRecordForMissingLabel 열쇠 좁히기(kind !== MISSING)",
  );
  const mutated = src.replace(
    target,
    'function maybeResolveAbortRecordForMissingLabel({\n  labelInfo,\n  role,\n  harnessDir,\n  resultText,\n  receiptPath,\n  args,\n  env,\n}) {\n  if (labelInfo.kind === "VALID") return { done: false };\n  return resolveAbortRecordOutcome({\n    role,\n    harnessDir,\n    resultText,\n    receiptPath,\n    admissionLedgerPath: resolveAdmissionLedgerPathForAbort(args, env),\n  });\n}',
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    for (const form of BROKEN_FORMS) {
      const fixtureDir = mkdtempSync(
        join(tmpdir(), "dispatch-gate-abort-key-narrow-mut-"),
      );
      try {
        const fixture = buildBrokenLabelFixture(
          fixtureDir,
          `red-${form.name}`,
          form.content,
          { attachRecord: true },
        );
        const r = runCli(mutantPath, [
          fixture.taskPath,
          "--ledger",
          fixture.streakLedgerPath,
          "--dispatch-receipt-path",
          fixture.dispatchReceiptPath,
          "--admission-ledger-path",
          fixture.ledgerPath,
        ]);
        assert.equal(
          r.status,
          0,
          `RED: 열쇠 좁히기를 되돌리면 ${form.label}(완전히 유효한 중단 기록 붙음)이 다시 ALLOW로 새야 한다 -- 3R이 반려된 결함의 재현: stderr=${r.stderr}`,
        );
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 결선 제거 변이 -> §A의 진짜 중단 입력이 다시 (원래 사고처럼) 영원히
// REJECT로 남는가(RED 확인 -- 이 축이 load-bearing임을 증명).
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

test("RED(변이, 필수): abortOutcome.done 단락(ALLOW/REJECT 조기 반환)을 제거하면 §A의 진짜 중단 입력이 다시 영원히 REJECT로 새어 버린다(이 축이 실제로 결과를 바꾼다는 증거)", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target = "  if (abortOutcome.done) return abortOutcome.result;\n";
  assertExactlyOneMatch(src, target, "abortOutcome.done short-circuit");
  const mutated = src.replace(target, "");

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "dispatch-gate-abort-mut-fix-"),
    );
    try {
      const fixture = buildDeadRoundFixture(fixtureDir);
      writeAbortRecord({
        role: "REVIEW",
        harnessDir: fixture.dir,
        harnessTaskLabel: fixture.deadHarnessTaskLabel,
        dispatchId: fixture.deadDispatchId,
        droppedAt: "2026-08-18 00:00:00 KST",
        leftoverFingerprint: computeFingerprint(fixture.deadResultContent),
        leftoverPath: "review.md",
        recordedAt: "2026-08-18 10:05:00 KST",
        evidence: "RED 변이 시험용",
      });
      const r = runCli(mutantPath, [
        fixture.taskPath,
        "--ledger",
        fixture.streakLedgerPath,
        "--dispatch-receipt-path",
        fixture.dispatchReceiptPath,
        "--admission-ledger-path",
        fixture.ledgerPath,
      ]);
      assert.notEqual(
        r.status,
        0,
        "RED: 단락을 제거하면 §A의 ALLOW가 사라져야 한다 -- 이 축이 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
