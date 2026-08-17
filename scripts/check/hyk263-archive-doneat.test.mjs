// HYK-263 2R §1-① (검토 반려 수리): 1R에서 dispatch-gate-consumption-wire.test.mjs
// 안에 얹었던 HYK-263 전용 시험(보관함 구제 장치를 doneAt 제외 4성분으로
// 넓힌 축)과 그 전용 fixture를 이 새 파일로 옮긴다. 기존 시험 파일을 고친
// 것이 "불가피하지 않았다"는 검토자 지적을 그대로 받아들여
// dispatch-gate-consumption-wire.test.mjs는 master 판본으로 바이트 동일
// 원복했다(coder.md SHA-256 대조 참조). fixture 헬퍼(withFixtureDir/runCli/
// seedHandoff/writeDispatchReceiptLine/writeConsumptionReceipt/
// stageScriptsCheckDir/assertExactlyOneMatch/buildArchiveMatchFixture)는
// dispatch-gate-consumption-wire.test.mjs의 것을 그대로 복제했다(검토자가
// "fixture 복제는 허용된다"고 명시했다 -- coder-task.md §1 축 A).
//
// HYK-263 2R §1-② (검토 반려 수리): 1R은 "dispatchId를 OTHER_BINDING_FIELDS
// 에서 빼도 재시도가 1R 코어(consumption-receipt-core.mjs, 수정 금지)에서
// 다시 막혀 최종 게이트 레벨에서는 RED가 안 된다"고 정직 보고했다. 검토자는
// "1R 코어가 뒤에서 재검증한다는 설명은 안전성 근거일 수 있지만, 지침은 이
// 변이가 빨간불이 되는 시험을 요구한다"며 갈래 «가»(선별 단계 자체를 직접
// 시험)를 요구했다. 그래서 dispatch-gate-decision.mjs의 findTargetFingerprint
// 를 export하고(그 파일의 유일한 추가 export, 동작 불변), 여기서 그 함수를
// "게이트 CLI를 통하지 않고" 직접 호출해 계약을 단위로 고정한다: dispatchId
// 가 다른 후보는 원본에서 선택되지 않고(undefined), OTHER_BINDING_FIELDS
// 에서 dispatchId를 빼는 변이를 적용한 사본에서는 같은 입력이 선택된다
// (fingerprint가 채워진 객체를 반환) -- 이게 그 변이의 진짜 RED다(게이트
// 최종 판정이 아니라 선별 함수 계약 자체가 새는 것을 직접 관측한다).
//
// HYK-263 3R (검토 반려 수리, 축 F): 2R 검토는 6축 중 5축 PASS, 1축(F)만
// FAIL이었다 -- 그 FAIL의 절반은 ORCH의 지시서 문면 오류였다("절대 시각
// 리터럴이 있으면 반려"라는 과잉 문면), 나머지 절반은 실제 결함(fixture
// 생성에 new Date()/Math.random()이 섞여 있어 같은 입력으로 두 번 돌려도
// 다른 바이트가 나왔다)이었다. 이 라운드는 그 실제 결함만 고친다:
//   1) 비결정 요소 제거 -- 아래 FIXTURE_FIXED_TIMESTAMP_UTC/
//      FIXTURE_FIXED_RUNTIME_TASK_ID로 대체(§4 결정성 증명 참조).
//   2) 절대 시각 리터럴(doneAt/droppedAt 등, 예: "2026-08-14 09:10:05
//      KST")은 그대로 둔다 -- ⛔이것들은 결속 "데이터 값"일 뿐이고,
//      이 파일의 어떤 단언도 그 값을 현재 시계나 "지난 24시간" 같은
//      상대 창과 비교하지 않는다(=시각·환경 "의존" 단언이 아니다,
//      coder-task.md §2 정정된 상설 항목 그대로). 이 사실은 아래
//      개별 시험/헬퍼 옆에도 반복해서 명시한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import { findTargetFingerprint } from "./dispatch-gate-decision.mjs";

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
// scripts/check/dropped-at-stamp-core.mjs (moved from
// scripts/relay/stamp-dropped-at.mjs to fix a scripts/check ->
// scripts/relay ESLint import-direction violation) -- this isolated
// fixture's staged tree must include it at the SAME relative path (`./`
// from scripts/check/) or the mutant module fails to load
// (MODULE_NOT_FOUND), same reasoning as CONSUMPTION_RECEIPT_CORE_PATH
// above.
const DROPPED_AT_STAMP_CORE_PATH = join(HERE, "dropped-at-stamp-core.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

// --- fixture 헬퍼(복제, dispatch-gate-consumption-wire.test.mjs와 동일) ---

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk263-archive-doneat-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

// HYK-263 3R §1 점1: recorded_at/dispatch_timestamp_utc/runtime_task_id는
// 고정 리터럴이다(new Date()/Math.random() 제거) -- 이 fixture는 결정적
// 이어야 같은 시험을 두 번 돌려도 같은 바이트가 나온다(§4 결정성 증명).
// 세 필드 모두 게이트 판정 코드(dispatch-gate-decision.mjs)가 전혀
// 읽지 않는 장식용 메타데이터라서(조회 키는 role+harness_task_label
// 뿐 -- `grep runtime_task_id scripts/check/dispatch-gate-decision.mjs`
// 로 실측 확인, 매치 0건), 고정값으로 바꿔도 시험 의미는 조금도
// 바뀌지 않는다. ⛔이 값들은 «현재 시계와 대조»되지 않는 결속
// 데이터일 뿐이다(coder-task.md §2 정정된 상설 항목 그대로 -- 아래
// buildArchiveMatchFixture의 doneAt/droppedAt 리터럴과 같은 성격).
const FIXTURE_FIXED_TIMESTAMP_UTC = "2026-08-14T00:00:00.000Z";
const FIXTURE_FIXED_RUNTIME_TASK_ID = "task_fixture0000dead";

function writeDispatchReceiptLine(
  path,
  { role, harnessTaskLabel, dispatchId },
) {
  const record = {
    recorded_at: FIXTURE_FIXED_TIMESTAMP_UTC,
    runtime_task_id: FIXTURE_FIXED_RUNTIME_TASK_ID,
    dispatch_id: dispatchId,
    assignee_pane_key: "test-pane-key",
    dispatch_timestamp_utc: FIXTURE_FIXED_TIMESTAMP_UTC,
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

function writeSiblingReceiptFile(dir, role, filename, binding) {
  const receiptsDir = join(dir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(
    join(receiptsDir, filename),
    JSON.stringify(
      {
        binding,
        effects: {
          envelopeArchived: true,
          taskArchived: true,
          admissionReturned: true,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

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
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

// HYK-263 전용: live 결과 파일의 `>>> DONE:` 시각을 영수증/보존 사본과
// 다르게 만들 수 있는 `liveDoneAt` 매개변수가 추가된 버전(기본값 =
// doneAt이라 안 넘기면 옛 동작과 동일하다).
// ⛔비대조 명시(3R §1 점2): 이 함수의 doneAt/droppedAt/nextDroppedAt/
// liveDoneAt 인자는 전부 호출부가 넘기는 고정 리터럴 문자열이다 -- 이
// 함수도, 이 함수가 채우는 게이트 판정 경로도 그 값을 현재 시계나
// "최근 N시간" 같은 상대 창과 비교하지 않는다. 게이트가 실제로 하는
// 비교는 "영수증의 doneAt 문자열 === 다른 후보의 doneAt 문자열"(4성분
// 매칭에서는 오히려 doneAt을 아예 빼고 비교한다, HYK-263 1R) 같은
// 순수 문자열 동치뿐이다 -- 리터럴이 «과거/미래처럼 보이는지»는 판정에
// 전혀 영향을 주지 않는다.
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
    liveDoneAt = doneAt,
  },
) {
  const upperRole = role.toUpperCase();
  const originalResultContent = `task_id: ${prevTaskId}\n\n>>> DONE: ${upperRole} @ ${doneAt}\n`;

  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  writeFileSync(
    join(roundsDir, `${upperRole}-task-r1.md`),
    `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${droppedAt} -->\ntask_id: ${prevTaskId}\ndropped_at: ${droppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );
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
    },
    { envelopeArchived: true, taskArchived: true, admissionReturned: true },
  );

  const liveResultContent = tamperLive
    ? `task_id: ${prevTaskId}\n\n>>> DONE: ${upperRole} @ ${liveDoneAt}\n<!-- 소비 후 손질(가정) -->\n`
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

// ---------------------------------------------------------------------------
// §1 GREEN: 어제 사고 재현 -- taskId/role/droppedAt/dispatchId는 같고 live
// `>>> DONE:` 시각(doneAt)만 영수증과 달라도 ARCHIVE_MATCH로 ALLOW.
// ---------------------------------------------------------------------------

test("§1 GREEN(리터럴=결속 데이터, 현재 시계와 비대조): 어제 사고 재현 -- doneAt만 영수증과 달라도 ARCHIVE_MATCH로 ALLOW + '무엇을 완화했는지' 관측이 stderr에 찍힌다", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const doneAt = "2026-08-14 09:10:05 KST";
    const tamperedDoneAt = "2026-08-14 20:07:11 KST";
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9117-consumption-doneat-widen-prev",
        nextTaskId: "HYK-9117-consumption-doneat-widen-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt,
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_doneat_widen",
        tamperLive: true,
        liveDoneAt: tamperedDoneAt,
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
      `ALLOW 기대(doneAt 제외 4성분 대조), 실제 stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /ALLOW/);
    assert.match(r.stderr, /ARCHIVE_MATCH/);
    assert.match(
      r.stderr,
      /doneAt 성분 제외 후보 인정/,
      "doneAt이 달라서 대조 성분을 좁혔다는 사실 자체가 관측에 남아야 한다",
    );
    assert.match(
      r.stderr,
      new RegExp(
        `live doneAt=${tamperedDoneAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    assert.match(
      r.stderr,
      new RegExp(
        `영수증 doneAt=${doneAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// §2 RED 4종: 유일 후보 원칙 · resultFingerprint 완전 일치 · dispatchId
// 비교가 조금도 느슨해지지 않았다.
// ---------------------------------------------------------------------------

test("§2 RED-1(리터럴=결속 데이터, 현재 시계와 비대조)(후보 0개): 영수증이 아예 없으면 doneAt 제외 확장이 있어도 여전히 REJECT", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9118-consumption-doneat-red0-prev",
        nextTaskId: "HYK-9118-consumption-doneat-red0-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_doneat_red0",
        tamperLive: true,
        liveDoneAt: "2026-08-14 20:07:11 KST",
      },
    );
    rmSync(join(dir, "receipts", "coder-receipt-r1.json"));

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(r.status, 0, "후보 0개는 여전히 거부돼야 한다");
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
  });
});

test("§2 RED-2(리터럴=결속 데이터, 현재 시계와 비대조)(후보 2개 이상): 4성분은 같고 doneAt만 다른 영수증이 둘이면 여전히 REJECT(아무거나 하나 고르지 않는다)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const prevTaskId = "HYK-9119-consumption-doneat-red2-prev";
    const droppedAt = "2026-08-14 09:00:00 KST";
    const doneAt = "2026-08-14 09:10:05 KST";
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId,
        nextTaskId: "HYK-9119-consumption-doneat-red2-next",
        droppedAt,
        doneAt,
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_doneat_red2",
        tamperLive: true,
        liveDoneAt: "2026-08-14 20:07:11 KST",
      },
    );
    writeSiblingReceiptFile(dir, "coder", "coder-receipt-r2.json", {
      taskId: prevTaskId,
      role: "CODER",
      droppedAt,
      resultFingerprint: "unrelated-fingerprint-r2",
      doneAt: "2026-08-14 11:00:00 KST",
    });

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
      "후보 2개 이상(doneAt만 다름)은 여전히 거부돼야 한다",
    );
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
    assert.match(r.stderr, /보관함 대조 판정 불가/);
    assert.match(r.stderr, /확정할 수 없다/);
  });
});

test("§2 RED-3(리터럴=결속 데이터, 현재 시계와 비대조)(보관 사본 지문 다름): 후보를 정확히 하나 찾아도 보존 사본 지문이 목표와 다르면 여전히 REJECT", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9120-consumption-doneat-red3-prev",
        nextTaskId: "HYK-9120-consumption-doneat-red3-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_doneat_red3",
        tamperLive: true,
        liveDoneAt: "2026-08-14 20:07:11 KST",
        tamperArchiveToo: true,
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
      "보존 사본 지문이 목표와 다르면 여전히 거부돼야 한다",
    );
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
  });
});

test("§2 RED-4(리터럴=결속 데이터, 현재 시계와 비대조)(dispatchId 불일치): 나머지 3성분+doneAt은 같아도 dispatchId가 다르면 여전히 REJECT(게이트 최종 판정 레벨)", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
      dir,
      "coder",
      {
        prevTaskId: "HYK-9121-consumption-doneat-red4-prev",
        nextTaskId: "HYK-9121-consumption-doneat-red4-next",
        droppedAt: "2026-08-14 09:00:00 KST",
        doneAt: "2026-08-14 09:10:05 KST",
        nextDroppedAt: "2026-08-14 10:00:00 KST",
        dispatchId: "ctx_test_doneat_red4_actual",
        tamperLive: true,
        liveDoneAt: "2026-08-14 20:07:11 KST",
      },
    );
    const receiptPath = join(dir, "receipts", "coder-receipt-r1.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.binding.dispatchId = "ctx_test_doneat_red4_wrong";
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");

    const r = runCli(SCRIPT_PATH, [
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      dispatchReceiptPath,
    ]);
    assert.notEqual(r.status, 0, "dispatchId 불일치는 여전히 거부돼야 한다");
    assert.doesNotMatch(r.stderr, /ARCHIVE_MATCH/);
  });
});

// ---------------------------------------------------------------------------
// §3 변이ⓐ: 게이트 CLI 레벨 -- 후보 2개 이상일 때 첫 번째를 고르게 바꾸면
// RED-2 입력이 ALLOW로 샌다(기존 방식 그대로 유지).
// ---------------------------------------------------------------------------

test("§3 변이ⓐ(필수)(리터럴=결속 데이터, 현재 시계와 비대조): 후보 2개 이상일 때 첫 번째를 고르게 바꾸면 RED-2 입력이 ALLOW로 새 버린다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "  if (matches.length !== 1) return undefined;\n  const matched = matches[0];\n";
  assertExactlyOneMatch(src, target, "정확히 하나 아니면 undefined 가드");
  const mutated = src.replace(
    target,
    "  if (matches.length === 0) return undefined;\n  const matched = matches[0];\n",
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    const fixtureDir = mkdtempSync(
      join(tmpdir(), "hyk263-archive-doneat-mut-a-"),
    );
    try {
      const ledgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const prevTaskId = "HYK-9122-consumption-doneat-muta-prev";
      const droppedAt = "2026-08-14 09:00:00 KST";
      const doneAt = "2026-08-14 09:10:05 KST";
      const { taskPath, dispatchReceiptPath } = buildArchiveMatchFixture(
        fixtureDir,
        "coder",
        {
          prevTaskId,
          nextTaskId: "HYK-9122-consumption-doneat-muta-next",
          droppedAt,
          doneAt,
          nextDroppedAt: "2026-08-14 10:00:00 KST",
          dispatchId: "ctx_test_doneat_muta",
          tamperLive: true,
          liveDoneAt: "2026-08-14 20:07:11 KST",
        },
      );
      writeSiblingReceiptFile(fixtureDir, "coder", "coder-receipt-r2.json", {
        taskId: prevTaskId,
        role: "CODER",
        droppedAt,
        resultFingerprint: "unrelated-fingerprint-r2",
        doneAt: "2026-08-14 11:00:00 KST",
      });

      const r = runCli(mutantPath, [
        taskPath,
        "--ledger",
        ledgerPath,
        "--dispatch-receipt-path",
        dispatchReceiptPath,
      ]);
      assert.equal(
        r.status,
        0,
        "RED: 후보 2개 이상일 때 첫 번째를 고르게 바꾸면 RED-2 입력이 ALLOW로 새 버려야 한다 -- '정확히 하나' 원칙이 실제로 결과를 바꾼다는 증거",
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §4 변이ⓑ(2R 재작성 -- 검토 반려 ②/갈래 «가»): findTargetFingerprint 선별
// 함수 자체를 게이트 CLI를 거치지 않고 직접 단위로 시험한다.
// ---------------------------------------------------------------------------

// 원본(현재 dispatch-gate-decision.mjs)에서 dispatchId가 다른 후보는
// 선택되지 않는다는 계약을 먼저 고정한다(대조군 -- 이게 안 되면 아래
// 변이 시험 자체가 의미 없다).
test("§4 선별 계약(대조군)(리터럴=결속 데이터, 현재 시계와 비대조): findTargetFingerprint는 dispatchId가 다른 유일 후보를 선택하지 않는다(undefined)", () => {
  const currentBinding = {
    taskId: "HYK-9200-selection-contract",
    role: "CODER",
    droppedAt: "2026-08-14 09:00:00 KST",
    dispatchId: "ctx_actual",
    doneAt: "2026-08-14 20:07:11 KST",
    resultFingerprint: "live-fp-irrelevant",
  };
  const candidates = [
    {
      binding: {
        taskId: "HYK-9200-selection-contract",
        role: "CODER",
        droppedAt: "2026-08-14 09:00:00 KST",
        dispatchId: "ctx_wrong",
        doneAt: "2026-08-14 09:10:05 KST",
        resultFingerprint: "archived-fp",
      },
    },
  ];
  const result = findTargetFingerprint(currentBinding, candidates);
  assert.equal(
    result,
    undefined,
    "dispatchId가 다르면(taskId/role/droppedAt만 같아도) 선별 함수 자체가 후보를 찾지 못해야 한다",
  );
});

test("§4 변이ⓑ(필수, 선별 함수 단위 RED)(리터럴=결속 데이터, 현재 시계와 비대조): OTHER_BINDING_FIELDS에서 dispatchId를 빼면 방금 선택되지 않던 dispatchId 불일치 후보가 findTargetFingerprint 자체에서 선택돼 버린다", async () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    'const OTHER_BINDING_FIELDS = ["taskId", "role", "droppedAt", "dispatchId"];\n';
  assertExactlyOneMatch(src, target, "OTHER_BINDING_FIELDS 4성분 목록");
  const mutated = src.replace(
    target,
    'const OTHER_BINDING_FIELDS = ["taskId", "role", "droppedAt"];\n',
  );

  const fixtureDir = mkdtempSync(
    join(tmpdir(), "hyk263-archive-doneat-mut-b-"),
  );
  try {
    const scriptsCheckDir = stageScriptsCheckDir(fixtureDir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");
    // 게이트 CLI(runCli)가 아니라 이 모듈을 직접 동적 import해서
    // findTargetFingerprint(변이본)를 그대로 호출한다 -- invokedDirectly
    // 가드는 process.argv[1]로 판단하므로(파일 경로 기준이 아니다) 동적
    // import는 CLI를 부팅하지 않고 export만 가져온다.
    const mutatedModule = await import(pathToFileURL(mutantPath).href);

    // 위 대조군과 완전히 같은 입력.
    const currentBinding = {
      taskId: "HYK-9200-selection-contract",
      role: "CODER",
      droppedAt: "2026-08-14 09:00:00 KST",
      dispatchId: "ctx_actual",
      doneAt: "2026-08-14 20:07:11 KST",
      resultFingerprint: "live-fp-irrelevant",
    };
    const candidates = [
      {
        binding: {
          taskId: "HYK-9200-selection-contract",
          role: "CODER",
          droppedAt: "2026-08-14 09:00:00 KST",
          dispatchId: "ctx_wrong",
          doneAt: "2026-08-14 09:10:05 KST",
          resultFingerprint: "archived-fp",
        },
      },
    ];
    const mutatedResult = mutatedModule.findTargetFingerprint(
      currentBinding,
      candidates,
    );
    assert.notEqual(
      mutatedResult,
      undefined,
      "RED: dispatchId를 OTHER_BINDING_FIELDS에서 빼면 방금 대조군에서 undefined였던 같은 입력이 이제 후보를 찾아 버려야 한다(선별 함수 계약이 실제로 깨졌다는 직접 증거)",
    );
    assert.equal(
      mutatedResult.fingerprint,
      "archived-fp",
      "선택된 후보가 실제로 dispatchId만 다른 그 후보임을 확인(우연한 undefined 회피가 아니다)",
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
