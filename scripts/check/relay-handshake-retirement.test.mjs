// HYK-398 -- "은퇴가 인정되면 자리는 그대로 남는다"(관제실 지시서 §1 결정적
// 결함 ⓶)를 닫는다: relay-handshake.mjs가 STALE_DONE_PREDATES_DROP(=기존
// "stale result: DONE predates task drop" 거부, HYK-186 이후 계속 있던
// 사유)을 만날 때, 이미 있는 은퇴 축(retirement-record-core.mjs, HYK-311)의
// 검증을 admission-completion-adapter.mjs의 verifyRetirementEvidence로
// 다시 태워 원장 슬롯을 실제로 반납한다. 이 파일이 고정하는 것:
//   1. 은퇴 기록이 아직 없을 때(가장 흔한 첫 폴링) -- STALE 거부는
//      byte-identical, 원장 슬롯은 그대로 ACTIVE(성급히 빼앗지 않음).
//   2. 유효한 은퇴 기록이 나중에 생기면(같은 라운드를 다시 폴링) -- STALE
//      거부는 여전히 byte-identical(§4 완료조건: 소비 판정 자체는 바뀌지
//      않는다)이지만, 원장 슬롯은 실제로 반납되고 completion_reason이
//      RETIREMENT_RELEASED(SUSPECT_TIMEOUT_RECOVERED/BLOCKED_TERMINATION_
//      RELEASED와 구별)로 찍힌다.
//   3. 위조/불완전 은퇴 기록(사유 미확인 등)은 슬롯을 반납하지 못한다.
//   4. 모든 시험은 mkdtemp 격리 원장 -- 실물 .harness 접촉 0.
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import {
  createEmptyLedger,
  admitReservation,
  countActive,
} from "../supervisor/admission-ledger-core.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-retirement-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

function fingerprintOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const TASK_HEADER = "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n";
const STALE_RESULT =
  "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-08 20:00:00 KST\ndone_stamped_by: finalize-done\n";

function setupLedger(dir) {
  let ledger = createEmptyLedger("2026-08-08T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: "HYK-1",
    cap: 1,
    now: "2026-08-08T00:00:00.000Z",
    role: "CODER",
    seatKey: "seat-x",
  });
  assert.equal(admit.decision, "ADMITTED");
  ledger = admit.ledger;
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
  return ledgerPath;
}

function withLedgerEnv(ledgerPath, fn) {
  const prevEnv = process.env.ADMISSION_LEDGER_PATH;
  process.env.ADMISSION_LEDGER_PATH = ledgerPath;
  try {
    fn();
  } finally {
    if (prevEnv === undefined) delete process.env.ADMISSION_LEDGER_PATH;
    else process.env.ADMISSION_LEDGER_PATH = prevEnv;
  }
}

test("HYK-398 (1) STALE 라운드는 은퇴 기록이 없으면 거부만 하고 원장 슬롯은 손대지 않는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", STALE_RESULT);
    const ledgerPath = setupLedger(dir);

    let result;
    withLedgerEnv(ledgerPath, () => {
      result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, "STALE_DONE_PREDATES_DROP");
    assert.match(result.reason, /stale result/);

    // 이 폴링에서 봉투는 보관됐어야 한다(은퇴 기록의 아카이브 요구를
    // 나중에 만족시킬 수 있도록) -- 하지만 원장은 그대로다.
    assert.ok(existsSync(join(dir, "rounds", "coder-r1.md")));
    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      countActive(after),
      1,
      "은퇴 기록이 없으면 자리를 빼앗지 않는다",
    );
  });
});

test("HYK-398 (2) 유효한 은퇴 기록이 있으면 STALE 라운드도 원장 슬롯을 실제로 반납한다(RETIREMENT_RELEASED, SUSPECT_TIMEOUT_RECOVERED/BLOCKED_TERMINATION_RELEASED와 구별)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", STALE_RESULT);
    const ledgerPath = setupLedger(dir);

    // 1차 폴링: 봉투를 보관시킨다(은퇴 기록이 가리킬 아카이브 사본을 만든다).
    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({ role: "coder", harnessDir: dir });
    });
    const archivePath = join(dir, "rounds", "coder-r1.md");
    assert.ok(existsSync(archivePath));
    // 지문은 봉투 헤더를 벗긴 원문 기준(resolveRetirementArchiveCandidate
    // ForAdapter가 stripRetirementArchiveEnvelopeHeader로 벗긴 뒤 계산하는
    // 것과 동일) -- 원본 결과 파일 내용 자체와 같다(STALE_RESULT는 이
    // 라운드 전체에서 바뀌지 않는다).
    const archivedFingerprint = fingerprintOf(STALE_RESULT);

    // ORCH가 유효한 은퇴 기록을 남긴다(다섯 관문 전부를 만족하도록).
    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      JSON.stringify({
        role: "CODER",
        harnessTaskLabel: "HYK-1",
        archivePath: "rounds/coder-r1.md",
        archiveFingerprintClaimed: archivedFingerprint,
        blockReasonCode: "DONE_PREDATES_DROPPED_AT",
        successorLabel: "HYK-2",
        recordedAt: "2026-08-08 22:00:00 KST",
        evidence: { source: "test" },
      }),
      "utf8",
    );

    // 2차 폴링: 이제 은퇴가 재확인돼 자리가 반납돼야 한다.
    let result;
    withLedgerEnv(ledgerPath, () => {
      result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    });

    // 소비 판정 자체는 byte-identical -- 은퇴는 완료가 아니다.
    assert.equal(result.ok, false);
    assert.equal(result.state, "STALE_DONE_PREDATES_DROP");
    assert.match(result.reason, /stale result/);

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(countActive(after), 0, "자리가 실제로 반납돼야 한다");
    assert.equal(
      after.reservations["HYK-1"].completion_reason,
      "RETIREMENT_RELEASED",
      "«완료»도 «정지 회수»도 아닌 «은퇴 반납» 사유로 구별돼 찍혀야 한다",
    );
  });
});

test("HYK-398 (3) 은퇴 기록의 사유가 재확인되지 않으면(위조/오기) 자리를 반납하지 못한다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", STALE_RESULT);
    const ledgerPath = setupLedger(dir);

    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({ role: "coder", harnessDir: dir });
    });
    const archivePath = join(dir, "rounds", "coder-r1.md");
    assert.ok(existsSync(archivePath));
    const archivedFingerprint = fingerprintOf(STALE_RESULT);

    // ⛔사유는 DONE_TIMESTAMP_NOT_PARSEABLE이라고 «거짓으로» 주장한다 --
    // 이 라운드의 DONE은 실제로는 파싱 가능하다(단지 dropped_at보다 과거일
    // 뿐) -- 어댑터가 live 파일을 다시 읽어 재확인하면 이 주장은 거짓으로
    // 드러나야 한다.
    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      JSON.stringify({
        role: "CODER",
        harnessTaskLabel: "HYK-1",
        archivePath: "rounds/coder-r1.md",
        archiveFingerprintClaimed: archivedFingerprint,
        blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
        successorLabel: "HYK-2",
        recordedAt: "2026-08-08 22:00:00 KST",
        evidence: { source: "test" },
      }),
      "utf8",
    );

    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({ role: "coder", harnessDir: dir });
    });

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      countActive(after),
      1,
      "재확인에 실패하는 은퇴 기록은 자리를 반납하지 못해야 한다",
    );
  });
});
