// HYK-342/HYK-249 -- BLOCKED/NEEDS_INPUT 핸드셰이크의 «정지 종결
// (termination)» 후속효과를 checkRelayHandshake의 공개 계약(ok/state/
// reason) 수준에서 고정한다.
//
// coder-task.md §1 기전: relay-handshake.mjs는 BLOCKED/NEEDS_INPUT을
// ok:false로 되돌리고 거기서 멈췄다 -- 라운드를 닫는 후속효과(봉투 보관
// 2종·원장 자리 반납·중단 기록 작성)가 전부 빠져 있었다(HYK-249/HYK-342,
// 증상 둘·원인 하나). 이 파일이 고정하는 것:
//   1. BLOCKED/NEEDS_INPUT 라운드 -> 봉투 2종 보관 + 중단 기록 작성 (+
//      ADMISSION_LEDGER_PATH가 설정돼 있으면 원장 자리도 반납된다).
//   2. state가 정확히 BLOCKED/NEEDS_INPUT이 «아닌» 경우(AMBIGUOUS_BLOCKED/
//      MALFORMED_BLOCKED/PENDING류)는 이 후속효과가 전혀 실행되지 않는다
//      (§3 채택 설계 "BLOCKED/NEEDS_INPUT 가지" 그대로 -- 판정 자체가
//      불확실한 라운드의 원장 자리를 성급히 빼앗지 않는다).
//   3. 이 모든 후속효과는 best-effort -- checkRelayHandshake 자신의
//      ok:false/state/reason 반환값은 이 라운드 전과 byte-identical이다
//      (기존 relay-handshake-blocked-near-miss.test.mjs/relay-handshake.
//      test.mjs의 BLOCKED 계열 단언과 회귀 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
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
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-blocked-term-test-"));
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

const TASK_HEADER = "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n";

test("HYK-342 (1) BLOCKED 라운드 -> 봉투 2종이 보관되고 중단 기록이 남는다, ok:false/state/reason은 그대로", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: orca ask 가 계속 실패해 진행 불가\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });

    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.equal(
      result.reason,
      "worker reported BLOCKED: orca ask 가 계속 실패해 진행 불가",
      "반환값은 이 라운드 전과 byte-identical -- 부수효과가 판정 자체를 바꾸지 않는다",
    );

    assert.ok(
      existsSync(join(dir, "rounds", "coder-r1.md")),
      "결과 봉투가 보관돼야 한다",
    );
    assert.ok(
      existsSync(join(dir, "rounds", "coder-task-r1.md")),
      "task 파일 봉투가 보관돼야 한다",
    );

    const abortNames = readdirSync(join(dir, "aborts"));
    assert.equal(abortNames.length, 1);
    const record = JSON.parse(
      readFileSync(join(dir, "aborts", abortNames[0]), "utf8"),
    );
    assert.equal(record.role, "CODER");
    assert.equal(record.harnessTaskLabel, "HYK-1");
    assert.equal(record.evidence.source, "relay-handshake-blocked-termination");
    assert.equal(record.evidence.state, "BLOCKED");
    assert.equal(
      record.leftoverFingerprint,
      createHash("sha256")
        .update(
          "task_id: HYK-1\n\n>>> BLOCKED: orca ask 가 계속 실패해 진행 불가\n",
          "utf8",
        )
        .digest("hex"),
    );
  });
});

test("HYK-342 (2) NEEDS_INPUT 라운드도 BLOCKED와 동일한 종결 후속효과를 받는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> NEEDS_INPUT: 다음 단계 승인 필요\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "NEEDS_INPUT");

    assert.ok(existsSync(join(dir, "rounds", "coder-r1.md")));
    const abortNames = readdirSync(join(dir, "aborts"));
    assert.equal(abortNames.length, 1);
    const record = JSON.parse(
      readFileSync(join(dir, "aborts", abortNames[0]), "utf8"),
    );
    assert.equal(record.evidence.state, "NEEDS_INPUT");
  });
});

test("HYK-342 (3) MALFORMED_BLOCKED(>>> 없는 근접-미스)는 종결 후속효과를 받지 않는다 -- 판정 불확실 라운드의 자리를 성급히 빼앗지 않는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nBLOCKED: orca ask 가 계속 실패해 진행 불가\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.state, "MALFORMED_BLOCKED");
    assert.equal(
      existsSync(join(dir, "aborts")),
      false,
      "aborts/ 디렉터리 자체가 생기지 않아야 한다 -- 이 축이 전혀 실행되지 않았다는 뜻",
    );
    assert.equal(existsSync(join(dir, "rounds")), false);
  });
});

test("HYK-342 (4) PENDING(정지 표지 자체가 없음)도 종결 후속효과를 받지 않는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\n아직 작업 중\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.state, "PENDING");
    assert.equal(existsSync(join(dir, "aborts")), false);
  });
});

test("HYK-342/HYK-249 (5) ADMISSION_LEDGER_PATH가 설정돼 있으면 BLOCKED 라운드는 원장 자리를 즉시(완료가 아니라 «정지 회수» 사유로) 반납한다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: 원장 반납 시험\n",
    );

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
    assert.equal(countActive(ledger), 1);

    const ledgerPath = join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
    const prevEnv = process.env.ADMISSION_LEDGER_PATH;
    process.env.ADMISSION_LEDGER_PATH = ledgerPath;
    try {
      checkRelayHandshake({ role: "coder", harnessDir: dir });
    } finally {
      if (prevEnv === undefined) delete process.env.ADMISSION_LEDGER_PATH;
      else process.env.ADMISSION_LEDGER_PATH = prevEnv;
    }

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(countActive(after), 0, "자리가 반납돼야 한다");
    assert.equal(
      after.reservations["HYK-1"].completion_reason,
      "BLOCKED_TERMINATION_RELEASED",
      "«완료»가 아니라 «정지 회수» 사유로 반납돼야 한다",
    );
  });
});
