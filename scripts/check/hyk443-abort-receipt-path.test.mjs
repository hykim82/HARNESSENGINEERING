// HYK-443: spawnAdmissionAbortProcess(relay-handshake.mjs)가
// admission-completion-adapter.mjs를 스폰할 때 receiptPath(6번째 위치
// 인자)를 넘기지 않아, 그 어댑터의 resolveReceiptPathForVerification이
// `DISPATCH_RECEIPT_PATH` env로만 폴백하고(이 저장소의 자동 소비 경로는
// 그 env를 절대 세팅하지 않는다 -- 오직 사람이 손으로 돌리는 별도
// ORCH 터미널만 세팅한다) 그마저 없으면 null로 떨어져,
// BLOCKED_TERMINATION_RELEASED 자동 반납이 «항상» "(경로 미설정)"으로
// 실패하던 실사고(coder-task.md §1-2, 실물 재현
// `"abortReleased": false"`)를 고정한다.
//
// 수리: this file's own resolveDispatchLedgerPath(undefined, harnessDir)
// -- resolveDispatchRecordExistence가 이미 쓰는 그 포인터 파일 관례
// (`<harnessDir>/dispatch-receipt-path.txt`) -- 를 재사용해 6번째 인자로
// 넘긴다(새 관례 발명 0).
//
// 이 파일이 고정하는 것:
//   1. 포인터 파일만 있고 DISPATCH_RECEIPT_PATH env는 없어도 반납이
//      성공하고, completion_reason: BLOCKED_TERMINATION_RELEASED가 실제로
//      찍히며, 중단 기록의 abortReleased가 true가 된다.
//   2. §4 회귀(비타협): 배달 영수증에 없는 라벨(위조)로는 여전히 거부.
//   3. §4 회귀(비타협): 포인터 파일이 없을 때도 안전측 거부(자리 그대로).
//   4. §4 회귀(비타협): 포인터 파일이 깨졌을(빈 파일) 때도 안전측 거부.
//   5. 되돌림 변이(RED): receiptPath 인자 추가를 되돌리면(pre-fix 5-인자
//      호출로 복원) env 없이는 다시 실패함을 확인 -- 이 fix가 원인임을
//      증명. 실 소스는 바이트 동일 복원.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";
import {
  createEmptyLedger,
  admitReservation,
  countActive,
} from "../supervisor/admission-ledger-core.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");
const ADMISSION_COMPLETION_ADAPTER_PATH = join(
  CHECK_DIR,
  "admission-completion-adapter.mjs",
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk443-abort-receipt-test-"));
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

// HYK-443/HYK-359: DISPATCH_RECEIPT_PATH가 실행 환경(개발자 쉘·CI)에 이미
// 떠 있을 가능성을 항상 배제하고 시작한다 -- 이 축이 "env 없이도 성공"을
// 증명하려면 env가 진짜 없어야 한다.
function withoutAmbientReceiptEnv(fn) {
  const prev = process.env.DISPATCH_RECEIPT_PATH;
  delete process.env.DISPATCH_RECEIPT_PATH;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.DISPATCH_RECEIPT_PATH;
    else process.env.DISPATCH_RECEIPT_PATH = prev;
  }
}

// HYK-414 (time-judgment-now-injection ratchet): this file's fixtures embed
// absolute timestamps (setupLedgerAndTask's dropped_at) -- checkRelayHandshake
// must always be called with an explicit `now` fixed shortly after that
// value, never the real Date.now() default.
const FIXED_NOW = Date.parse("2026-09-05T12:05:00Z"); // 2026-09-05 21:05 KST

function setupLedgerAndTask(dir, { taskId = "HYK-1" } = {}) {
  writeTask(
    dir,
    "coder",
    `task_id: ${taskId}\ndropped_at: 2026-09-05 21:00 KST\n`,
  );
  writeResult(
    dir,
    "coder",
    `task_id: ${taskId}\n\n>>> BLOCKED: 포인터 파일 경로 시험\n`,
  );

  let ledger = createEmptyLedger("2026-09-05T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: taskId,
    cap: 1,
    now: "2026-09-05T00:00:00.000Z",
    role: "CODER",
    seatKey: "seat-x",
  });
  assert.equal(admit.decision, "ADMITTED");
  ledger = admit.ledger;
  assert.equal(countActive(ledger), 1);

  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
  return { ledgerPath, taskId };
}

test("HYK-443 (1) 포인터 파일만 있고 DISPATCH_RECEIPT_PATH env는 없어도 BLOCKED_TERMINATION_RELEASED 반납이 성공한다", () => {
  withoutAmbientReceiptEnv(() => {
    withFixtureDir((dir) => {
      const { ledgerPath, taskId } = setupLedgerAndTask(dir);

      // 배달 영수증은 harnessDir 밖(별도 위치)에 두고, harnessDir 안에는
      // 포인터 파일만 남긴다 -- 실제 관제실 배달기의 파일 배치를 그대로
      // 반영(coder-task.md §1-2/relay-handshake.mjs의 HYK-387 3R 주석).
      const receiptDir = mkdtempSync(join(tmpdir(), "hyk443-receipt-dir-"));
      try {
        const receiptPath = join(receiptDir, "dispatch-receipts.jsonl");
        writeFileSync(
          receiptPath,
          `${JSON.stringify({ role: "CODER", harness_task_label: taskId, dispatch_id: "ctx_test" })}\n`,
          "utf8",
        );
        writeFileSync(
          join(dir, "dispatch-receipt-path.txt"),
          receiptPath,
          "utf8",
        );

        const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
        process.env.ADMISSION_LEDGER_PATH = ledgerPath;
        try {
          checkRelayHandshake({
            role: "coder",
            harnessDir: dir,
            now: FIXED_NOW,
          });
        } finally {
          if (prevLedgerEnv === undefined)
            delete process.env.ADMISSION_LEDGER_PATH;
          else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
        }

        const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
        assert.equal(
          countActive(after),
          0,
          "포인터 파일 경로만으로도 자리가 반납돼야 한다",
        );
        assert.equal(
          after.reservations[taskId].completion_reason,
          "BLOCKED_TERMINATION_RELEASED",
        );

        const abortNames = readdirSync(join(dir, "aborts"));
        assert.equal(abortNames.length, 1);
        const record = JSON.parse(
          readFileSync(join(dir, "aborts", abortNames[0]), "utf8"),
        );
        assert.equal(
          record.evidence.abortReleased,
          true,
          "중단 기록의 abortReleased가 true여야 한다 -- HYK-419가 가리키던 '자동 반납은 항상 실패' 증상이 여기서 닫힌다",
        );
      } finally {
        rmSync(receiptDir, { recursive: true, force: true });
      }
    });
  });
});

test("HYK-443 (2) §4 회귀: 배달 영수증에 없는 라벨(위조)로는 여전히 거부된다 -- 자리는 그대로 ACTIVE", () => {
  withoutAmbientReceiptEnv(() => {
    withFixtureDir((dir) => {
      const { ledgerPath, taskId } = setupLedgerAndTask(dir, {
        taskId: "HYK-443-FORGED-1",
      });

      const receiptDir = mkdtempSync(join(tmpdir(), "hyk443-receipt-dir-"));
      try {
        const receiptPath = join(receiptDir, "dispatch-receipts.jsonl");
        // 다른 role/다른 task_id로만 배달된 것으로 -- 이 라운드 자신은
        // 실제로 배달된 적이 없다(위조 시나리오).
        writeFileSync(
          receiptPath,
          `${JSON.stringify({ role: "CODER", harness_task_label: "HYK-OTHER-1", dispatch_id: "ctx_other" })}\n`,
          "utf8",
        );
        writeFileSync(
          join(dir, "dispatch-receipt-path.txt"),
          receiptPath,
          "utf8",
        );

        const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
        process.env.ADMISSION_LEDGER_PATH = ledgerPath;
        try {
          checkRelayHandshake({
            role: "coder",
            harnessDir: dir,
            now: FIXED_NOW,
          });
        } finally {
          if (prevLedgerEnv === undefined)
            delete process.env.ADMISSION_LEDGER_PATH;
          else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
        }

        const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
        assert.equal(
          countActive(after),
          1,
          "배달된 적 없는 라벨로는 자리를 반납해선 안 된다(위조 방어 유지)",
        );
        assert.equal(after.reservations[taskId].completion_reason, undefined);
      } finally {
        rmSync(receiptDir, { recursive: true, force: true });
      }
    });
  });
});

test("HYK-443 (3) §4 회귀: 포인터 파일이 없을 때도 안전측 거부(자리 그대로) -- fail-closed 유지", () => {
  withoutAmbientReceiptEnv(() => {
    withFixtureDir((dir) => {
      const { ledgerPath, taskId } = setupLedgerAndTask(dir, {
        taskId: "HYK-443-NO-POINTER-1",
      });
      // 포인터 파일(dispatch-receipt-path.txt) 자체를 만들지 않는다.

      const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
      process.env.ADMISSION_LEDGER_PATH = ledgerPath;
      try {
        checkRelayHandshake({ role: "coder", harnessDir: dir, now: FIXED_NOW });
      } finally {
        if (prevLedgerEnv === undefined)
          delete process.env.ADMISSION_LEDGER_PATH;
        else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
      }

      const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
      assert.equal(
        countActive(after),
        1,
        "포인터 파일 부재 시 자리를 반납해선 안 된다",
      );
      assert.equal(after.reservations[taskId].completion_reason, undefined);
    });
  });
});

test("HYK-443 (4) §4 회귀: 포인터 파일이 깨졌을(빈 파일) 때도 안전측 거부", () => {
  withoutAmbientReceiptEnv(() => {
    withFixtureDir((dir) => {
      const { ledgerPath, taskId } = setupLedgerAndTask(dir, {
        taskId: "HYK-443-BROKEN-POINTER-1",
      });
      writeFileSync(join(dir, "dispatch-receipt-path.txt"), "", "utf8");

      const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
      process.env.ADMISSION_LEDGER_PATH = ledgerPath;
      try {
        checkRelayHandshake({ role: "coder", harnessDir: dir, now: FIXED_NOW });
      } finally {
        if (prevLedgerEnv === undefined)
          delete process.env.ADMISSION_LEDGER_PATH;
        else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
      }

      const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
      assert.equal(
        countActive(after),
        1,
        "빈 포인터 파일도 '경로 없음'과 동일하게 거부돼야 한다",
      );
      assert.equal(after.reservations[taskId].completion_reason, undefined);
    });
  });
});

// --- 되돌림 변이 (coder-task.md §4-5): spawnAdmissionAbortProcess의
// receiptPath 인자 추가를 되돌려(pre-fix 5-인자 호출로 복원) env 없이는
// 다시 실패함을 확인한다. 실 소스는 바이트 동일 복원.
// ---------------------------------------------------------------------------

function stageMinimalRelayHandshakeDeps(rootDir) {
  const checkDir = join(rootDir, "scripts", "check");
  mkdirSync(checkDir, { recursive: true });
  for (const name of RELAY_HANDSHAKE_STATIC_SIBLINGS) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  writeFileSync(
    join(checkDir, "admission-completion-adapter.mjs"),
    readFileSync(ADMISSION_COMPLETION_ADAPTER_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(checkDir, "retirement-record-core.mjs"),
    readFileSync(join(CHECK_DIR, "retirement-record-core.mjs"), "utf8"),
    "utf8",
  );
  writeFileSync(
    join(checkDir, "ledger-pointer-shared.mjs"),
    readFileSync(join(CHECK_DIR, "ledger-pointer-shared.mjs"), "utf8"),
    "utf8",
  );
  // spawnAbortRecordWriter (relay-handshake.mjs) also spawns this sibling as
  // a child process on the same BLOCKED-termination path -- staging it keeps
  // this RED fixture's console output clean of an unrelated
  // MODULE_NOT_FOUND (best-effort/non-fatal either way, but noisy).
  writeFileSync(
    join(checkDir, "abort-record-writer.mjs"),
    readFileSync(join(CHECK_DIR, "abort-record-writer.mjs"), "utf8"),
    "utf8",
  );
  const supervisorDir = join(rootDir, "scripts", "supervisor");
  mkdirSync(supervisorDir, { recursive: true });
  for (const name of [
    "admission-ledger-core.mjs",
    "admission-ledger-store.mjs",
  ]) {
    writeFileSync(
      join(supervisorDir, name),
      readFileSync(join(CHECK_DIR, "..", "supervisor", name), "utf8"),
      "utf8",
    );
  }
  return { checkDir };
}

async function withoutAmbientReceiptEnvAsync(fn) {
  const prev = process.env.DISPATCH_RECEIPT_PATH;
  delete process.env.DISPATCH_RECEIPT_PATH;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DISPATCH_RECEIPT_PATH;
    else process.env.DISPATCH_RECEIPT_PATH = prev;
  }
}

// max-lines-per-function 상한(ESLint, HYK-148) 회피용 추출 -- RED 시나리오
// 본체: mutated relay-handshake.mjs를 checkDir에 심고, 포인터 파일이 있는
// harnessDir을 만들어 env 없이 자식 프로세스로 실행한 뒤 원장이 여전히
// ACTIVE인지(반납 실패) 확인한다.
async function runRedMutationScenario(checkDir, harnessDir) {
  const { ledgerPath, taskId } = setupLedgerAndTask(harnessDir, {
    taskId: "HYK-443-RED-1",
  });
  const receiptDir = mkdtempSync(join(tmpdir(), "hyk443-red-receipt-dir-"));
  try {
    const receiptPath = join(receiptDir, "dispatch-receipts.jsonl");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ role: "CODER", harness_task_label: taskId, dispatch_id: "ctx_test" })}\n`,
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "dispatch-receipt-path.txt"),
      receiptPath,
      "utf8",
    );

    await withoutAmbientReceiptEnvAsync(async () => {
      const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
      process.env.ADMISSION_LEDGER_PATH = ledgerPath;
      try {
        const mod = await import(
          `file://${join(checkDir, "relay-handshake.mjs")}?t=${Date.now()}`
        );
        mod.checkRelayHandshake({ role: "coder", harnessDir, now: FIXED_NOW });
      } finally {
        if (prevLedgerEnv === undefined)
          delete process.env.ADMISSION_LEDGER_PATH;
        else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
      }
    });

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      countActive(after),
      1,
      "RED: receiptPath 인자 없이는(pre-fix) 포인터 파일이 있어도 env가 없으면 반납이 실패해야 한다 -- 이 fix가 원인임을 증명",
    );
  } finally {
    rmSync(receiptDir, { recursive: true, force: true });
  }
}

test("HYK-443 되돌림 변이: receiptPath 인자 추가를 되돌리면(pre-fix 5-인자 호출) env 없이는 반납이 다시 실패한다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target = `    const resolvedReceiptPath = resolveDispatchLedgerPath(
      undefined,
      harnessDir,
    );
    const args = harnessDir
      ? [
          adapterPath,
          taskId,
          harnessDir,
          "BLOCKED_TERMINATION_RELEASED",
          role,
          ...(resolvedReceiptPath !== undefined ? [resolvedReceiptPath] : []),
        ]
      : [adapterPath, taskId];`;
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (spawnAdmissionAbortProcess args construction) must appear exactly once in the current working-tree source (found ${count})`,
  );
  const preFixArgs = `    const args = harnessDir
      ? [adapterPath, taskId, harnessDir, "BLOCKED_TERMINATION_RELEASED", role]
      : [adapterPath, taskId];`;
  const mutated = src.replace(target, preFixArgs);
  assert.notEqual(mutated, src, "mutation must actually change the source");

  const rootDir = mkdtempSync(join(tmpdir(), "hyk443-mut-root-"));
  const harnessDir = mkdtempSync(join(tmpdir(), "hyk443-mut-harness-"));
  try {
    const { checkDir } = stageMinimalRelayHandshakeDeps(rootDir);
    writeFileSync(join(checkDir, "relay-handshake.mjs"), mutated, "utf8");
    await runRedMutationScenario(checkDir, harnessDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
    const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명 실패: 실제 relay-handshake.mjs가 이 시험 도중 바뀌었다",
    );
  }
});
