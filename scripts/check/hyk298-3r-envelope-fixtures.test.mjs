// HYK-298-label-classify-3 §3-1 -- 오늘 실제로 막힌 봉투 2개(2R
// `coder.md`/1R `review.md`)를 합성이 아니라 실물로 고정한다. 원본은
// `hyk298-abort-record-r1-2` 워크트리(무접촉 보존 대상)에 있고, 이
// 시험이 쓰는 사본은 `hyk298-3r-envelope-fixtures.mjs`에 동결돼 있다.
//
// §1 이 시험이 증명하는 것 3가지:
//   1. 동결본이 실제로 실물과 바이트 단위로 같다(지시서가 준 SHA-256과
//      대조, "절대경로를 시험 코드에 박지 마라" 요구를 지키면서도).
//   2. 두 봉투는 이제 (§2-1/§2-2 수리 후) `dispatch-gate-decision.mjs`
//      로 완전한 소비 영수증 체인을 갖췄을 때 ALLOW된다 -- "오늘 실제로
//      막힌 봉투 2개가 통과한다"(합격 기준 §3-1)의 실행 증거.
//   3. 영수증 체인이 없어도(=아직 소비되지 않은 상태) 최소한 더 이상
//      TASK_ID_LABEL_BROKEN(«없음»이 아니라 «깨짐») 사유로 걸리지는
//      않는다 -- 카운팅 수리 자체가 격리된 증거(§2-1/§2-2).
// RED 변이(§5 요구)는 classifyTaskIdLabel을 2R의 옛 anyCount 비교로
// 되돌려 오늘의 차단이 실제로 재현되는지 확인하고 즉시 원복한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import {
  CODER_2R_ENVELOPE_CONTENT,
  CODER_2R_ENVELOPE_SHA256,
  REVIEW_1R_ENVELOPE_CONTENT,
  REVIEW_1R_ENVELOPE_SHA256,
} from "./hyk298-3r-envelope-fixtures.mjs";

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
// HYK-311-retire-1 §2: dispatch-gate-decision.mjs now ALSO statically
// imports scripts/check/retirement-record-core.mjs (the new, separate
// zero-import retirement-record core) -- same MODULE_NOT_FOUND reasoning as
// ABORT_RECORD_CORE_PATH immediately above.
const RETIREMENT_RECORD_CORE_PATH = join(HERE, "retirement-record-core.mjs");
// HYK-307-order-1 §1: dispatch-gate-decision.mjs now statically imports
// scripts/check/envelope-archive.mjs (the delivery-time round-task
// snapshot, archiveRoundTaskFileIfNew) -- same MODULE_NOT_FOUND reasoning
// as the other *_PATH additions above.
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk298-3r-envelope-fixture-"));
  try {
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

// resultText 자신의 `>>> DONE: ROLE @ <시각>` 원문에서 doneAt을 뽑는다
// (dispatch-gate-decision.mjs의 CONSUMPTION_DONE_RE_G와 동일한 모양의
// 정규식을 이 시험 파일도 zero-import 원칙과 무관하게 그대로 복제해 쓴다
// -- 이 파일은 판정 코어가 아니라 픽스처 조립용 시험 헬퍼이므로 복제가
// 문제되지 않는다, dispatch-gate-abort-wire.test.mjs의 다른 헬퍼들과
// 같은 성격).
function extractDoneAt(resultText) {
  const matches = [...resultText.matchAll(/^>>>\s*DONE:.*@\s*(.+?)\s*$/gim)];
  assert.equal(matches.length, 1, "동결 봉투는 DONE 줄이 정확히 1개여야 한다");
  return matches[0][1].trim();
}

// 실물 봉투(동결본)를 직전 라운드의 결과 파일로 심고, 그 라운드가 이미
// 정상 소비됐다는 완전한 영수증 체인(배달 영수증·보관 사본·소비
// 영수증)을 갖춘다 -- §C/§D가 이미 쓰는 것과 같은 실물 검증 원칙
// (buildConsumedFixture, dispatch-gate-consumption-wire.test.mjs 선례).
function buildConsumedEnvelopeFixture(
  dir,
  { role, content, harnessTaskLabel, droppedAt, dispatchId, isReviewFamily },
) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");

  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  const upperRole = role.toUpperCase();
  writeFileSync(
    join(roundsDir, `${upperRole}-task-r1.md`),
    `<!-- envelope-archive: role=${upperRole} kind=task dropped_at=${droppedAt} -->\ntask_id: ${harnessTaskLabel}\ndropped_at: ${droppedAt}\n${ONE_B_BLOCK}`,
    "utf8",
  );

  const dispatchReceiptPath = join(dir, "dispatch-receipts.jsonl");
  writeDispatchReceiptLine(dispatchReceiptPath, {
    role: upperRole,
    harnessTaskLabel,
    dispatchId,
  });

  writeConsumptionReceipt(
    dir,
    role,
    {
      taskId: harnessTaskLabel,
      role: upperRole,
      droppedAt,
      resultFingerprint: computeFingerprint(content),
      doneAt: extractDoneAt(content),
      // dispatchId는 일부러 생략한다(enrichCandidateDispatchId가 위
      // dispatch-receipts.jsonl에서 채운다 -- buildConsumedFixture 선례
      // 그대로, dispatch-gate-consumption-wire.test.mjs).
    },
    {
      envelopeArchived: true,
      taskArchived: true,
      admissionReturned: true,
      ...(isReviewFamily ? { ledgerRecorded: true } : {}),
    },
    isReviewFamily ? 1 : undefined,
  );

  // HYK-383 2R §2: the new head_commit precondition axis now also gates
  // every REVIEW-family delivery -- a valid cover line is required here or
  // the gate REJECTs before ever reaching the consumption axis this file
  // actually targets (harmless no-op for CODER, isReviewFamily:false).
  const headCommitLine = isReviewFamily
    ? `head_commit: ${"d".repeat(40)}\n`
    : "";
  const taskPath = join(dir, `${role}-task.md`);
  writeFileSync(
    taskPath,
    `task_id: ${harnessTaskLabel}-next\ndropped_at: 2026-08-18 20:00:00 KST\n${headCommitLine}${ONE_B_BLOCK}`,
    "utf8",
  );

  const streakLedgerPath = join(dir, "reject-streak.json");
  writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

  return { taskPath, dispatchReceiptPath, streakLedgerPath };
}

const ENVELOPES = [
  {
    key: "coder",
    role: "coder",
    content: CODER_2R_ENVELOPE_CONTENT,
    sha256: CODER_2R_ENVELOPE_SHA256,
    harnessTaskLabel: "HYK-298-abort-record-2",
    droppedAt: "2026-08-18 12:00:00 KST",
    dispatchId: "ctx_test_3r_coder_env",
    isReviewFamily: false,
  },
  {
    key: "review",
    role: "review",
    content: REVIEW_1R_ENVELOPE_CONTENT,
    sha256: REVIEW_1R_ENVELOPE_SHA256,
    harnessTaskLabel: "HYK-298-abort-record-review-1",
    droppedAt: "2026-08-18 11:00:00 KST",
    dispatchId: "ctx_test_3r_review_env",
    isReviewFamily: true,
  },
];

// ---------------------------------------------------------------------------
// §1 -- 동결본이 실물과 바이트 단위로 같다(지시서가 준 SHA-256과 대조).
// ---------------------------------------------------------------------------

for (const env of ENVELOPES) {
  test(`§1 동결본 무결성: ${env.key}.md 동결 사본의 SHA-256이 지시서가 준 값과 일치한다`, () => {
    const actual = computeFingerprint(env.content);
    assert.equal(
      actual,
      env.sha256,
      `${env.key}.md 동결 사본이 실물과 바이트 단위로 다르다(지문 불일치)`,
    );
  });
}

// ---------------------------------------------------------------------------
// §2 -- 완전한 소비 영수증 체인을 갖추면 ALLOW(합격 기준 §3-1 실행 증거).
// ---------------------------------------------------------------------------

for (const env of ENVELOPES) {
  test(`§2 오늘 실제로 막힌 봉투 통과: ${env.key}.md(실물, 동결본) + 완전한 소비 영수증 체인 -> ALLOW`, () => {
    withFixtureDir((dir) => {
      const fixture = buildConsumedEnvelopeFixture(dir, env);
      const r = runCli(SCRIPT_PATH, [
        fixture.taskPath,
        "--ledger",
        fixture.streakLedgerPath,
        "--dispatch-receipt-path",
        fixture.dispatchReceiptPath,
      ]);
      assert.equal(
        r.status,
        0,
        `${env.key}.md는 정상 소비됐으므로 ALLOW여야 한다: stdout=${r.stdout} stderr=${r.stderr}`,
      );
      assert.match(r.stdout, /ALLOW/);
      assert.doesNotMatch(
        r.stderr,
        /«없음»이 아니라 «깨짐»/,
        "더 이상 BROKEN으로 오분류되면 안 된다",
      );
    });
  });
}

// ---------------------------------------------------------------------------
// §3 -- 영수증 체인이 아직 없어도(=진짜 미소비 상태 그대로) 최소한 더
// 이상 TASK_ID_LABEL_BROKEN으로 걸리지는 않는다(카운팅 수리 자체의
// 격리된 증거 -- ALLOW/REJECT 최종 판정은 소비 영수증 유무에 달렸으므로
// 이 시험은 그 최종 판정을 주장하지 않는다, BROKEN 오분류 여부만 본다).
// ---------------------------------------------------------------------------

for (const env of ENVELOPES) {
  test(`§3 카운팅 수리 격리 증거: ${env.key}.md(실물, 동결본)는 영수증 없이도 더 이상 BROKEN으로 오분류되지 않는다`, () => {
    withFixtureDir((dir) => {
      writeFileSync(join(dir, `${env.role}.md`), env.content, "utf8");
      const taskPath = join(dir, `${env.role}-task.md`);
      writeFileSync(
        taskPath,
        `task_id: ${env.harnessTaskLabel}-next\ndropped_at: 2026-08-18 20:00:00 KST\n${ONE_B_BLOCK}`,
        "utf8",
      );
      const streakLedgerPath = join(dir, "reject-streak.json");
      writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

      const r = runCli(SCRIPT_PATH, [taskPath, "--ledger", streakLedgerPath]);
      assert.doesNotMatch(
        r.stderr,
        /«없음»이 아니라 «깨짐»/,
        `${env.key}.md는 줄머리 표지가 정확히 1개인 VALID 라운드다 -- 원시 산문 출현 때문에 BROKEN으로 오분류되면 안 된다`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// RED(변이, 필수, HYK-298-label-classify-3 §2-1/2-2): classifyTaskIdLabel을
// 2R의 옛 anyCount 비교(어디든 등장 vs 줄머리 등장을 비교)로 되돌리면,
// 오늘 실제로 막힌 두 봉투가 다시 BROKEN으로 오분류돼 차단이 재현된다 --
// 이 카운팅 규칙이 실제로 결과를 바꾼다는 증거(재현 후 즉시 원복, 실제
// 파일은 한 번도 변이되지 않는다 -- 격리 tmpdir에만 적용).
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

test("RED(변이, 필수, 3R §2-1/2-2): classifyTaskIdLabel을 2R의 옛 anyCount 비교(줄머리 전체를 anyCount와 비교)로 되돌리면 오늘 실제로 막힌 두 봉투가 다시 BROKEN으로 새어 차단이 재현된다", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    'const TASK_ID_LOOSE_LINE_RE = /^task_id:.*$/gim;\nconst TASK_ID_ANY_RE = /task_id:/gi;\n\nfunction classifyTaskIdLabel(resultText) {\n  const looseLines = [...resultText.matchAll(TASK_ID_LOOSE_LINE_RE)].length;\n  if (looseLines === 0) {\n    const anyCount = [...resultText.matchAll(TASK_ID_ANY_RE)].length;\n    if (anyCount === 0) {\n      return { kind: "MISSING", looseLines: 0, strictCount: 0 };\n    }\n    return { kind: "BROKEN", looseLines: 0, strictCount: 0, anyCount };\n  }\n  const strictMatches = [...resultText.matchAll(CONSUMPTION_TASK_ID_RE_G)];\n  const strictCount = strictMatches.length;\n  if (looseLines === 1 && strictCount === 1) {\n    return {\n      kind: "VALID",\n      value: strictMatches[0][1].trim(),\n      looseLines,\n      strictCount,\n    };\n  }\n  return { kind: "BROKEN", looseLines, strictCount };\n}';
  assertExactlyOneMatch(
    src,
    target,
    "classifyTaskIdLabel 줄머리 전용 판정 + 5R 경계 재질문",
  );

  // 5R 이전(2R)의 버그: looseLines===0일 때만이 아니라 VALID 판정
  // 자체를 anyCount===looseLines 비교로 가로막는다 -- 오늘 실물 2봉투
  // (줄머리 1 + 원시 3·11)가 이 비교에서 다시 BROKEN으로 떨어진다.
  const mutated = src.replace(
    target,
    'const TASK_ID_LOOSE_LINE_RE = /^task_id:.*$/gim;\nconst TASK_ID_ANY_RE = /task_id:/gi;\n\nfunction classifyTaskIdLabel(resultText) {\n  const anyCount = [...resultText.matchAll(TASK_ID_ANY_RE)].length;\n  if (anyCount === 0) {\n    return { kind: "MISSING", looseLines: 0, strictCount: 0 };\n  }\n  const looseLines = [...resultText.matchAll(TASK_ID_LOOSE_LINE_RE)].length;\n  const strictMatches = [...resultText.matchAll(CONSUMPTION_TASK_ID_RE_G)];\n  const strictCount = strictMatches.length;\n  if (anyCount === looseLines && looseLines === 1 && strictCount === 1) {\n    return {\n      kind: "VALID",\n      value: strictMatches[0][1].trim(),\n      looseLines,\n      strictCount,\n    };\n  }\n  return { kind: "BROKEN", looseLines, strictCount };\n}',
  );

  withFixtureDir((dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const mutantPath = join(scriptsCheckDir, "dispatch-gate-decision.mjs");

    for (const env of ENVELOPES) {
      const fixtureDir = mkdtempSync(join(tmpdir(), "hyk298-3r-envelope-red-"));
      try {
        writeFileSync(join(fixtureDir, `${env.role}.md`), env.content, "utf8");
        const taskPath = join(fixtureDir, `${env.role}-task.md`);
        writeFileSync(
          taskPath,
          `task_id: ${env.harnessTaskLabel}-next\ndropped_at: 2026-08-18 20:00:00 KST\n${ONE_B_BLOCK}`,
          "utf8",
        );
        const streakLedgerPath = join(fixtureDir, "reject-streak.json");
        writeLedger(streakLedgerPath, { schema_version: 1, issues: {} });

        const r = runCli(mutantPath, [taskPath, "--ledger", streakLedgerPath]);
        // 4R부터 BROKEN은 더 이상 별도의 "«없음»이 아니라 «깨짐»" 사유를
        // 내지 않는다(그 하드 리젝트 분기 자체가 §2 열쇠 좁히기로
        // 제거됐다) -- BROKEN으로 잘못 떨어지면 그냥 옛 consumption-
        // receipt 경로의 일반 사유("영수증 없음/dispatchId 없음")로
        // REJECT된다. 그래도 REJECT라는 사실 자체가 오늘 차단의 재현이다
        // (ALLOW가 아니라는 것이 핵심 -- 두 봉투는 원래 VALID로 분류돼
        // 소비 영수증 체인으로 ALLOW돼야 하는데, 옛 anyCount 비교로
        // 되돌리면 BROKEN으로 떨어져 그 경로 자체가 막힌다).
        assert.notEqual(
          r.status,
          0,
          `RED: 옛 anyCount 비교로 되돌리면 ${env.key}.md가 다시 BROKEN으로 새어(VALID이던 것이 아니게 되어) REJECT로 떨어져야 한다(오늘 차단의 재현) -- stderr=${r.stderr}`,
        );
        assert.match(
          r.stderr,
          /배달 식별자\(dispatchId\)가 없거나 비어 있음|영수증 후보가 하나도 없음/,
          `RED: BROKEN으로 오분류되면 harnessTaskLabel을 못 뽑아 dispatchId 조회 자체가 안 되므로 이 사유로 떨어져야 한다 -- stderr=${r.stderr}`,
        );
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    }
  });
});
