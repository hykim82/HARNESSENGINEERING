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
//
// HYK-443 4R: 검토 1R이 «좌석 혼동 fail-open»을 P1으로 재현했다 -- 검증이
// role과 harness_task_label «만» 보고 영수증의 `assignee_pane_key`를 현재
// 좌석과 대조하지 않아, 같은 라벨로 «다른 좌석»에 배달된 영수증 한 줄로도
// 자리가 반납됐다(`other-seat-same-label`). 4R은 네 번째 조건(좌석 신원
// 대조)을 걸고, 대조할 값이 없으면 «거부»한다(fail-closed). 근거 원문은
// admission-completion-adapter.mjs의 hasDispatchReceiptForRound 헤더.
// 이 파일이 4R에서 추가로 고정하는 것:
//   6(4R). 검토자의 5개 라벨 시나리오 -- other-seat-same-label «만» 거부로
//      바뀌고 나머지 4개는 그대로.
//   7(4R). ORCA_PANE_KEY 미설정 -> 거부(통과 아님).
//   8(4R). 영수증 줄에 assignee_pane_key가 없는 구 형식 -> 거부.
//   9(4R). 되돌림 변이 ②: 좌석 대조를 빼면 다른 좌석 영수증으로 다시
//      반납된다(RED), 같은 픽스처가 미변이 소스에서는 거부됨(대조군).
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

// HYK-443 4R (검토 1R P1-ⓑ): 반납 검증은 이제 «지금 이 좌석»의 pane key
// (`ORCA_PANE_KEY`)와 영수증 줄의 `assignee_pane_key`를 대조한다. 이 시험은
// 그 env를 언제나 명시적으로 세우거나(성공 축) 명시적으로 지운다(fail-
// closed 축) -- 실행 환경에 우연히 떠 있는 값에 기대지 않는다(HYK-359와
// 같은 이유, 바로 위 withoutAmbientReceiptEnv 참조).
const CURRENT_SEAT_PANE = "tab-current:leaf-current";
const FOREIGN_SEAT_PANE = "tab-foreign:leaf-foreign";

function withSeatPaneKey(value, fn) {
  const prev = process.env.ORCA_PANE_KEY;
  // null/undefined = "이 좌석은 pane key를 모른다" (fail-closed 축 시험용).
  if (value === undefined || value === null) delete process.env.ORCA_PANE_KEY;
  else process.env.ORCA_PANE_KEY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ORCA_PANE_KEY;
    else process.env.ORCA_PANE_KEY = prev;
  }
}

// 배달 영수증 한 줄(dispatch-receipt-cli.mjs의 buildReceiptRecord 형태 --
// 이 시험이 쓰는 4필드만).
function receiptLine({ role = "CODER", label, pane, dispatchId = "ctx_test" }) {
  return `${JSON.stringify({
    role,
    harness_task_label: label,
    dispatch_id: dispatchId,
    assignee_pane_key: pane,
  })}\n`;
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
          receiptLine({ label: taskId, pane: CURRENT_SEAT_PANE }),
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
          withSeatPaneKey(CURRENT_SEAT_PANE, () =>
            checkRelayHandshake({
              role: "coder",
              harnessDir: dir,
              now: FIXED_NOW,
            }),
          );
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
          receiptLine({
            label: "HYK-OTHER-1",
            pane: CURRENT_SEAT_PANE,
            dispatchId: "ctx_other",
          }),
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
          withSeatPaneKey(CURRENT_SEAT_PANE, () =>
            checkRelayHandshake({
              role: "coder",
              harnessDir: dir,
              now: FIXED_NOW,
            }),
          );
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

// --- HYK-443 4R: 검토 1R P1-ⓑ(좌석 혼동 fail-open) -------------------------
// 검토자가 격리 원장·격리 영수증으로 돌린 5개 라벨 시나리오를 그대로
// 재현한다. 기대: `other-seat-same-label` «하나만» 반납됨 -> 거부로 바뀌고
// 나머지 4개는 그대로.
// ---------------------------------------------------------------------------

function runReleaseScenario({
  taskId,
  receiptRecords = [],
  writePointer = true,
  seatPane = CURRENT_SEAT_PANE,
}) {
  const dir = mkdtempSync(join(tmpdir(), "hyk443-seat-scn-"));
  const receiptDir = mkdtempSync(join(tmpdir(), "hyk443-seat-rcpt-"));
  const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
  try {
    const { ledgerPath } = setupLedgerAndTask(dir, { taskId });
    if (writePointer) {
      const receiptPath = join(receiptDir, "dispatch-receipts.jsonl");
      writeFileSync(receiptPath, receiptRecords.join(""), "utf8");
      writeFileSync(
        join(dir, "dispatch-receipt-path.txt"),
        receiptPath,
        "utf8",
      );
    }
    process.env.ADMISSION_LEDGER_PATH = ledgerPath;
    withoutAmbientReceiptEnv(() =>
      withSeatPaneKey(seatPane, () =>
        checkRelayHandshake({ role: "coder", harnessDir: dir, now: FIXED_NOW }),
      ),
    );
    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    return {
      activeReservations: countActive(after),
      completionReason: after.reservations[taskId].completion_reason ?? null,
    };
  } finally {
    if (prevLedgerEnv === undefined) delete process.env.ADMISSION_LEDGER_PATH;
    else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
    rmSync(dir, { recursive: true, force: true });
    rmSync(receiptDir, { recursive: true, force: true });
  }
}

const SEAT_SCENARIOS = [
  // ⓵ 포인터 파일 자체가 없다 -- 조회 경로를 모른다.
  { label: "pointer-absent", taskId: "HYK-443-SEAT-1", writePointer: false },
  // ⓶ 이 좌석에 배달됐지만 «다른 라운드» 라벨이다.
  {
    label: "other-round",
    taskId: "HYK-443-SEAT-2",
    records: [{ label: "HYK-443-SEAT-OTHER-ROUND", pane: FOREIGN_SEAT_PANE }],
  },
  // ⓷ 같은 라벨이지만 role이 다르다.
  {
    label: "wrong-role-same-label",
    taskId: "HYK-443-SEAT-3",
    records: [
      { role: "REVIEW", label: "HYK-443-SEAT-3", pane: FOREIGN_SEAT_PANE },
    ],
  },
  // ⓸ ★P1: role도 라벨도 같은데 «다른 좌석»에 배달된 영수증이다.
  {
    label: "other-seat-same-label",
    taskId: "HYK-443-SEAT-4",
    records: [{ label: "HYK-443-SEAT-4", pane: FOREIGN_SEAT_PANE }],
  },
  // ⓹ role·라벨·좌석이 전부 이 좌석의 것 -- 정상 반납(살아 있어야 한다).
  {
    label: "matching-role-and-label",
    taskId: "HYK-443-SEAT-5",
    records: [{ label: "HYK-443-SEAT-5", pane: CURRENT_SEAT_PANE }],
  },
];

test("HYK-443 4R: 검토자의 5개 라벨 시나리오 -- other-seat-same-label «만» 반납됨 -> 거부로 바뀌고 나머지 4개는 그대로", () => {
  const observed = SEAT_SCENARIOS.map((scenario) => ({
    label: scenario.label,
    ...runReleaseScenario({
      taskId: scenario.taskId,
      writePointer: scenario.writePointer !== false,
      receiptRecords: (scenario.records ?? []).map((r) => receiptLine(r)),
    }),
  }));
  // 관측 원문을 그대로 남긴다(결과 파일에 붙일 근거).
  for (const row of observed) console.log(JSON.stringify(row));

  assert.deepEqual(observed, [
    {
      label: "pointer-absent",
      activeReservations: 1,
      completionReason: null,
    },
    { label: "other-round", activeReservations: 1, completionReason: null },
    {
      label: "wrong-role-same-label",
      activeReservations: 1,
      completionReason: null,
    },
    {
      label: "other-seat-same-label",
      activeReservations: 1,
      completionReason: null,
    },
    {
      label: "matching-role-and-label",
      activeReservations: 0,
      completionReason: "BLOCKED_TERMINATION_RELEASED",
    },
  ]);
});

test("HYK-443 4R: 대조할 좌석 값이 없으면(ORCA_PANE_KEY 미설정) «통과»가 아니라 «거부»다(fail-closed)", () => {
  const outcome = runReleaseScenario({
    taskId: "HYK-443-SEAT-NOENV-1",
    receiptRecords: [
      receiptLine({ label: "HYK-443-SEAT-NOENV-1", pane: CURRENT_SEAT_PANE }),
    ],
    seatPane: null,
  });
  assert.deepEqual(outcome, { activeReservations: 1, completionReason: null });
});

test('HYK-443 4R: 영수증 줄에 assignee_pane_key가 아예 없으면(구 형식) 거부 -- "확인 못 함"은 "확인됨"이 아니다', () => {
  const outcome = runReleaseScenario({
    taskId: "HYK-443-SEAT-NOFIELD-1",
    receiptRecords: [
      `${JSON.stringify({ role: "CODER", harness_task_label: "HYK-443-SEAT-NOFIELD-1", dispatch_id: "ctx_legacy" })}\n`,
    ],
  });
  assert.deepEqual(outcome, { activeReservations: 1, completionReason: null });
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
      receiptLine({ label: taskId, pane: CURRENT_SEAT_PANE }),
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
        // HYK-443 4R: 좌석 축은 정상으로 세워 둔다 -- 이 RED가 오직
        // receiptPath 인자 되돌림 «하나»에서 나온 것임을 고정한다.
        withSeatPaneKey(CURRENT_SEAT_PANE, () =>
          mod.checkRelayHandshake({
            role: "coder",
            harnessDir,
            now: FIXED_NOW,
          }),
        );
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

// --- HYK-443 4R 되돌림 변이 ②: 좌석 대조를 빼면 «다른 좌석의 영수증»으로
// 다시 반납된다(검토 1R P1-ⓑ 재현). 변이는 격리 픽스처에 심은 복사본에만
// 가하고, 실 소스는 읽기만 한다(바이트 동일 확인).
// ---------------------------------------------------------------------------

const SEAT_CHECK_TARGET = `  if (!isNonEmptyString(rec.assignee_pane_key)) return false;
  return rec.assignee_pane_key === currentSeatPaneKey;`;

// 격리 checkDir에 심긴 어댑터를 직접 불러 «다른 좌석 영수증»으로 반납을
// 시도하고, 남은 ACTIVE 수를 돌려준다.
async function releaseWithForeignReceipt(checkDir, tag) {
  const harnessDir = mkdtempSync(join(tmpdir(), `hyk443-seatmut-${tag}-`));
  const receiptDir = mkdtempSync(join(tmpdir(), `hyk443-seatmut-r-${tag}-`));
  const prevLedgerEnv = process.env.ADMISSION_LEDGER_PATH;
  try {
    const taskId = `HYK-443-SEATMUT-${tag}`;
    const { ledgerPath } = setupLedgerAndTask(harnessDir, { taskId });
    const receiptPath = join(receiptDir, "dispatch-receipts.jsonl");
    writeFileSync(
      receiptPath,
      receiptLine({ label: taskId, pane: FOREIGN_SEAT_PANE }),
      "utf8",
    );
    process.env.ADMISSION_LEDGER_PATH = ledgerPath;
    const mod = await import(
      `file://${join(checkDir, "admission-completion-adapter.mjs")}?t=${Date.now()}-${tag}`
    );
    withSeatPaneKey(CURRENT_SEAT_PANE, () =>
      mod.autoCompleteAdmission({
        reservationId: taskId,
        harnessDir,
        reason: "BLOCKED_TERMINATION_RELEASED",
        role: "CODER",
        receiptPath,
      }),
    );
    return countActive(JSON.parse(readFileSync(ledgerPath, "utf8")));
  } finally {
    if (prevLedgerEnv === undefined) delete process.env.ADMISSION_LEDGER_PATH;
    else process.env.ADMISSION_LEDGER_PATH = prevLedgerEnv;
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(receiptDir, { recursive: true, force: true });
  }
}

test("HYK-443 4R 되돌림 변이 ②: 좌석 대조 두 줄을 빼면 다른 좌석의 영수증으로 다시 반납된다(RED) -- 같은 픽스처가 미변이 소스에서는 거부됨(대조군), 실 소스는 바이트 동일", async () => {
  const src = readFileSync(ADMISSION_COMPLETION_ADAPTER_PATH, "utf8");
  const count = src.split(SEAT_CHECK_TARGET).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (hasDispatchReceiptForRound seat comparison) must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(SEAT_CHECK_TARGET, "  return true;");

  const rootDir = mkdtempSync(join(tmpdir(), "hyk443-seatmut-root-"));
  try {
    const { checkDir } = stageMinimalRelayHandshakeDeps(rootDir);
    // 대조군: 방금 스테이징된 «있는 그대로»의 어댑터.
    assert.equal(
      await releaseWithForeignReceipt(checkDir, "control"),
      1,
      "대조군: 현재 소스에서는 다른 좌석 영수증으로 반납되지 않는다",
    );
    writeFileSync(
      join(checkDir, "admission-completion-adapter.mjs"),
      mutated,
      "utf8",
    );
    assert.equal(
      await releaseWithForeignReceipt(checkDir, "red"),
      0,
      "RED: 좌석 대조가 없으면 라벨·role만 같아도 남의 영수증으로 자리가 반납된다(검토 1R other-seat-same-label) -- 이 두 줄이 원인임을 증명",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(ADMISSION_COMPLETION_ADAPTER_PATH, "utf8"),
      src,
      "원복 증명 실패: 실제 admission-completion-adapter.mjs가 이 시험 도중 바뀌었다",
    );
  }
});
