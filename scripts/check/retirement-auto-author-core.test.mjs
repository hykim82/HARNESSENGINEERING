// HYK-419-retire-author-1 -- tests for retirement-auto-author-core.mjs's
// evaluateAutoAuthorAuthorization.
//
// Things this file must prove (coder-task.md §3 완료 조건):
//   1. hyk412 게이트(evaluateNeverConsumedRetirement)가 재사용되고 있음을
//      직접 증명한다 -- 게이트가 닫힌 facts는 이 코어도 반드시 닫는다
//      (GATE_CLOSED, 게이트의 실제 state를 그대로 실어 나른다).
//   2. 게이트가 열려도 기계 앵커(경로/지문/기록시각) 세 필드가 다 있어야만
//      AUTHORIZED_DRAFT가 나온다 -- 하나라도 비거나 타입이 틀리면 거부.
//   3. blockReasonCode는 호출자가 무엇을 넘기든 항상 null로 남는다(호출자가
//      "이미 유효한 사유 코드다"라고 위조해도 무시된다) -- 구조적으로 닫힌
//      표면임을 직접 증명한다.
//   4. 이 코어가 만든 초안(draftRecord)을 실제 retirement-record-core.mjs의
//      checkRetirementRecord에 넣으면 INVALID_REASON_CODE로 거부된다는
//      "강제 함수" 주장을 통합 시험으로 고정한다.
//   5. 되돌림 변이 3건(§5) -- 게이트-닫힘 검사를 끊으면 CLOSED facts도
//      AUTHORIZED_DRAFT로 열리고, 앵커 검사를 끊으면 빈 앵커도
//      AUTHORIZED_DRAFT로 열리고, blockReasonCode를 facts에서 읽도록
//      바꾸면 위조된 사유 코드가 draftRecord로 새어 나간다(RED) -- 각각
//      원본 소스 파일은 바이트 동일 복원.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  evaluateAutoAuthorAuthorization,
  AUTO_AUTHOR_STATE,
  HUMAN_REQUIRED_FIELDS,
} from "./retirement-auto-author-core.mjs";
import { NEVER_CONSUMED_RETIRE_STATE } from "./hyk412-never-consumed-retire-core.mjs";
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
} from "./retirement-record-core.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(CHECK_DIR, "retirement-auto-author-core.mjs");

test("retirement-auto-author-core.mjs imports only the hyk412 gate core (no fs/child_process, S8 예외 하나만 명시적으로 허용)", () => {
  const text = readFileSync(CORE_PATH, "utf8");
  const importStatements = [
    ...text.matchAll(/^import\s+\{[^}]*\}\s+from\s+"([^"]+)";/gm),
  ].map((m) => m[1]);
  assert.equal(importStatements.length, 1, importStatements.join(" | "));
  assert.match(importStatements[0], /hyk412-never-consumed-retire-core\.mjs/);
});

// openFacts는 hyk412-never-consumed-retire-core.test.mjs의 것과 형태가
// 같다(§2⑶ "같은 관문" 요구 -- 표본까지 같은 모양이어야 재사용 주장이
// 공허하지 않다) + 이 코어가 추가로 요구하는 세 앵커 필드.
function openFacts(overrides = {}) {
  return {
    role: "CODER",
    harnessTaskLabel: "HYK-999-never-touched-1",
    ledgerReservation: {
      exists: true,
      harnessTaskLabel: "HYK-999-never-touched-1",
      status: "ACTIVE",
      completedAt: null,
    },
    dispatchReceiptMatchCount: 1,
    resultArchiveExists: false,
    ownTaskArchiveExists: true,
    hasLaterRoundArchive: false,
    staleEnoughSinceAdmission: true,
    successorLabelForRecord: "HYK-999-never-touched-2",
    ownTaskArchivePath: "rounds/coder-task-r1.md",
    ownTaskArchiveFingerprint: "fp-abc123",
    recordedAt: "2026-09-02 16:00:00 KST",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 게이트 재사용 -- 게이트가 닫히면 이 코어도 닫힌다, 게이트 state가
//    그대로 실려 나온다.
// ---------------------------------------------------------------------------

test("CLOSED: hyk412 게이트가 LEDGER_RECORD_MISSING이면 -> GATE_CLOSED, gateState 그대로 전달", () => {
  const r = evaluateAutoAuthorAuthorization(
    openFacts({ ledgerReservation: { exists: false } }),
  );
  assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
  assert.equal(r.ok, false);
  assert.equal(r.gateState, NEVER_CONSUMED_RETIRE_STATE.LEDGER_RECORD_MISSING);
  assert.match(r.reason, /hyk412 게이트가 OPEN이 아님/);
});

test("CLOSED: hyk412 게이트가 SUCCESSOR_ROUND_EXISTS(case B)이면 -> GATE_CLOSED", () => {
  const r = evaluateAutoAuthorAuthorization(
    openFacts({ hasLaterRoundArchive: true }),
  );
  assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
  assert.equal(r.gateState, NEVER_CONSUMED_RETIRE_STATE.SUCCESSOR_ROUND_EXISTS);
});

test("CLOSED: hyk412 게이트가 타입 위조(진짜 3R 수리 대상)로 UNJUDGABLE이면 -> GATE_CLOSED (이 코어가 게이트를 다시 구현하지 않았다는 직접 증거)", () => {
  const r = evaluateAutoAuthorAuthorization(
    openFacts({ resultArchiveExists: "UNKNOWN_FAILURE_CODE" }),
  );
  assert.equal(r.state, AUTO_AUTHOR_STATE.GATE_CLOSED);
  assert.equal(
    r.gateState,
    NEVER_CONSUMED_RETIRE_STATE.RESULT_ARCHIVE_UNJUDGABLE,
  );
});

// ---------------------------------------------------------------------------
// 2. 기계 앵커 세 필드
// ---------------------------------------------------------------------------

test("GREEN: 게이트 OPEN + 앵커 세 필드 모두 있음 -> AUTHORIZED_DRAFT", () => {
  const r = evaluateAutoAuthorAuthorization(openFacts());
  assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
  assert.equal(r.ok, true);
  assert.equal(r.draftRecord.role, "CODER");
  assert.equal(r.draftRecord.harnessTaskLabel, "HYK-999-never-touched-1");
  assert.equal(r.draftRecord.archivePath, "rounds/coder-task-r1.md");
  assert.equal(r.draftRecord.archiveFingerprintClaimed, "fp-abc123");
  assert.equal(r.draftRecord.successorLabel, "HYK-999-never-touched-2");
  assert.equal(r.draftRecord.recordedAt, "2026-09-02 16:00:00 KST");
  assert.equal(r.draftRecord.blockReasonCode, null);
  assert.deepEqual(r.humanRequiredFields, HUMAN_REQUIRED_FIELDS);
  assert.deepEqual([...r.humanRequiredFields], ["blockReasonCode"]);
});

for (const missingField of [
  "ownTaskArchivePath",
  "ownTaskArchiveFingerprint",
  "recordedAt",
]) {
  test(`CLOSED: 앵커 필드 ${missingField}가 빈 문자열이면 -> MACHINE_ANCHOR_INCOMPLETE`, () => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts({ [missingField]: "" }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.MACHINE_ANCHOR_INCOMPLETE);
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(missingField));
  });

  test(`CLOSED: 앵커 필드 ${missingField}가 undefined면 -> MACHINE_ANCHOR_INCOMPLETE (truthy-fold 없음)`, () => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts({ [missingField]: undefined }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.MACHINE_ANCHOR_INCOMPLETE);
  });

  test(`CLOSED: 앵커 필드 ${missingField}가 숫자(타입 위조)면 -> MACHINE_ANCHOR_INCOMPLETE`, () => {
    const r = evaluateAutoAuthorAuthorization(
      openFacts({ [missingField]: 12345 }),
    );
    assert.equal(r.state, AUTO_AUTHOR_STATE.MACHINE_ANCHOR_INCOMPLETE);
  });
}

test("CLOSED: 앵커 세 필드가 전부 없으면 -> reason에 세 필드 이름이 모두 나열됨", () => {
  const r = evaluateAutoAuthorAuthorization(
    openFacts({
      ownTaskArchivePath: undefined,
      ownTaskArchiveFingerprint: undefined,
      recordedAt: undefined,
    }),
  );
  assert.equal(r.state, AUTO_AUTHOR_STATE.MACHINE_ANCHOR_INCOMPLETE);
  assert.match(r.reason, /ownTaskArchivePath/);
  assert.match(r.reason, /ownTaskArchiveFingerprint/);
  assert.match(r.reason, /recordedAt/);
});

// ---------------------------------------------------------------------------
// 3. blockReasonCode 구조적 닫힘 -- 호출자가 뭘 넘기든 무시된다.
// ---------------------------------------------------------------------------

test("GREEN: facts에 blockReasonCode를 위조해 넣어도(유효한 값처럼 보이는 문자열) draftRecord.blockReasonCode는 항상 null", () => {
  const r = evaluateAutoAuthorAuthorization(
    openFacts({ blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE" }),
  );
  assert.equal(r.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);
  assert.equal(r.draftRecord.blockReasonCode, null);
});

// ---------------------------------------------------------------------------
// 4. 통합: 이 코어의 초안은 retirement-record-core.mjs의 판정기를 통과하지
//    못한다(강제 함수 주장의 직접 증거) -- blockReasonCode가 사람 손으로
//    채워지기 전까지.
// ---------------------------------------------------------------------------

test("통합: AUTHORIZED_DRAFT의 draftRecord를 checkRetirementRecord에 넣으면 INVALID_REASON_CODE로 거부됨 (사람 손이 빠지면 구조적으로 완성 안 됨)", () => {
  const auto = evaluateAutoAuthorAuthorization(openFacts());
  assert.equal(auto.state, AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT);

  const verdict = checkRetirementRecord({
    role: auto.draftRecord.role,
    harnessTaskLabel: auto.draftRecord.harnessTaskLabel,
    candidates: [
      {
        record: auto.draftRecord,
        archiveExists: true,
        archiveFingerprintMatches: true,
        liveFingerprintMatches: null,
        blockReasonConfirmed: null,
      },
    ],
  });
  assert.equal(verdict.state, RETIREMENT_RECORD_STATE.INVALID_REASON_CODE);
  assert.equal(verdict.ok, false);
});

test("통합: 사람이 blockReasonCode를 닫힌 집합의 실제 값으로 채우면 -- 그 값이 사실과 맞는지는 여전히 사람 책임이지만 -- 구조적으로는 RETIRED까지 통과할 수 있다", () => {
  const auto = evaluateAutoAuthorAuthorization(openFacts());
  const humanFilled = {
    ...auto.draftRecord,
    blockReasonCode: "DONE_REWRITE_LOCKED",
  };
  const verdict = checkRetirementRecord({
    role: humanFilled.role,
    harnessTaskLabel: humanFilled.harnessTaskLabel,
    candidates: [
      {
        record: humanFilled,
        archiveExists: true,
        archiveFingerprintMatches: true,
        liveFingerprintMatches: true,
        blockReasonConfirmed: null,
      },
    ],
  });
  assert.equal(verdict.state, RETIREMENT_RECORD_STATE.RETIRED);
});

// ---------------------------------------------------------------------------
// 5. 되돌림 변이(mutation) -- 문서 숫자(3)와 일치. 소스 파일은 메모리에서만
//    읽고 고쳐서 임시 파일로 임포트한다 -- 원본은 한 번도 쓰기 대상이
//    아니므로 바이트 동일 복원이 by-construction이다(relay-handshake-
//    retirement-mutation.test.mjs 선례와 동일 규율).
// ---------------------------------------------------------------------------

function tmpMutantDir() {
  return mkdtempSync(join(tmpdir(), "hyk419-auto-author-mut-"));
}

async function importMutant(mutatedSource, dir) {
  // 게이트 코어를 나란히 복사해 상대 import가 그대로 풀리게 한다.
  writeFileSync(
    join(dir, "hyk412-never-consumed-retire-core.mjs"),
    readFileSync(
      join(CHECK_DIR, "hyk412-never-consumed-retire-core.mjs"),
      "utf8",
    ),
    "utf8",
  );
  const dest = join(dir, "retirement-auto-author-core.mjs");
  writeFileSync(dest, mutatedSource, "utf8");
  return import(`file://${dest}?t=${Date.now()}-${Math.random()}`);
}

test("되돌림 변이 1/3: 게이트-닫힘 검사(gate.state !== OPEN 조기 반환)를 제거하면 -> CLOSED facts도 AUTHORIZED_DRAFT로 잘못 열린다(RED), 원본 바이트 동일 복원", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  if (gate.state !== NEVER_CONSUMED_RETIRE_STATE.OPEN) {
    return {
      state: AUTO_AUTHOR_STATE.GATE_CLOSED,
      ok: false,
      gateState: gate.state,
      reason: \`retirement-auto-author: hyk412 게이트가 OPEN이 아님(\${gate.state}) -> 자동 작성 자격 없음, 거부(안전측 기본값). 게이트 사유: \${gate.reason}\`,
    };
  }
`;
  const count = src.split(target).length - 1;
  assert.equal(count, 1, "mutation target 1 must appear exactly once");
  const mutated = src.replace(target, "");

  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = mod.evaluateAutoAuthorAuthorization(
      openFacts({ ledgerReservation: { exists: false } }),
    );
    assert.equal(
      r.state,
      "AUTHORIZED_DRAFT",
      "RED: 게이트-닫힘 검사를 지우면 닫힌 facts도 열린다 -- 그 검사가 실제 원인임을 증명",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(
      readFileSync(CORE_PATH, "utf8"),
      src,
      "원복 증명 실패: 실제 retirement-auto-author-core.mjs가 시험 도중 바뀌었다",
    );
  }
});

test("되돌림 변이 2/3: 앵커-미완성 검사(anchorFailure 조기 반환)를 제거하면 -> 앵커가 텅 빈 facts도 AUTHORIZED_DRAFT로 잘못 열린다(RED), 원본 바이트 동일 복원", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = `  const anchorFailure = checkMachineAnchorFacts({
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  });
  if (anchorFailure) return anchorFailure;
`;
  const count = src.split(target).length - 1;
  assert.equal(count, 1, "mutation target 2 must appear exactly once");
  const mutated = src.replace(target, "");

  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = mod.evaluateAutoAuthorAuthorization(
      openFacts({
        ownTaskArchivePath: undefined,
        ownTaskArchiveFingerprint: undefined,
        recordedAt: undefined,
      }),
    );
    assert.equal(
      r.state,
      "AUTHORIZED_DRAFT",
      "RED: 앵커-미완성 검사를 지우면 텅 빈 앵커도 열린다 -- 그 검사가 실제 원인임을 증명",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(readFileSync(CORE_PATH, "utf8"), src, "원복 증명 실패");
  }
});

test("되돌림 변이 3/3: blockReasonCode를 하드코딩 null 대신 facts에서 읽도록 바꾸면 -> 위조된 사유 코드가 draftRecord로 새어 나간다(RED), 원본 바이트 동일 복원", async () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = "      blockReasonCode: null,";
  const count = src.split(target).length - 1;
  assert.equal(count, 1, "mutation target 3 must appear exactly once");
  const mutated = src.replace(
    target,
    "      blockReasonCode: facts.blockReasonCode ?? null,",
  );

  const dir = tmpMutantDir();
  try {
    const mod = await importMutant(mutated, dir);
    const r = mod.evaluateAutoAuthorAuthorization(
      openFacts({ blockReasonCode: "FORGED_REASON_CODE" }),
    );
    assert.equal(r.state, "AUTHORIZED_DRAFT");
    assert.equal(
      r.draftRecord.blockReasonCode,
      "FORGED_REASON_CODE",
      "RED: 하드코딩을 걷어내면 호출자가 넘긴 어떤 문자열도 draftRecord로 새어 나간다 -- 원래 코드가 이를 막고 있었다는 증명",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(readFileSync(CORE_PATH, "utf8"), src, "원복 증명 실패");
  }
});
