// HYK-412 §2 -- HYK-485 연속 영수증 게이트가 "runner_exit≠0인 영수증"
// 사유로 거부하는 그 갈래에 상태 이름(CONSUMPTION_REFUSED_RUNNER_CONTRACT)
// 을 부여하고, HYK-398의 은퇴 부수효과(봉투 보관 + 원장 반납 시도) 축을
// 그 상태에도 확장하고, `.harness/receipts/` 아래 "거부 1줄 지속 기록"을
// best-effort로 남기는 세 조각을 프로덕션 진입점(checkRelayHandshake)을
// 직접 구동해 고정한다.
//
// 합성 표본 모양은 관제실 아카이브 HYK-433 2R 봉투 사본과 같다(run3=0 /
// run4=1 / run5=0, canonical runner-receipt.json = 최신 초록 사본) --
// 1b_exec_line 원문 그대로. 모든 원장은 mkdtemp 격리(실물 .harness/
// 관제실 접촉 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  checkRelayHandshake,
  RUNNER_RECEIPT_REJECT_REASON,
  RUNNER_RECEIPT_RUN_PREFIX,
  parseKstTimestamp,
} from "./relay-handshake.mjs";
import {
  createEmptyLedger,
  admitReservation,
  countActive,
} from "../supervisor/admission-ledger-core.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
// time-judgment-now-injection.test.mjs(tj-1) 선례와 같은 이유 -- 절대시각
// 픽스처(doneAt/droppedAt)를 now 없이 시간 판정 진입점에 넘기면 하루 중
// 특정 창에서만 깨지는 실시계 의존이 생긴다. 모든 checkRelayHandshake 호출에
// 이 고정값을 명시로 주입한다(relay-handshake-runner-contract.test.mjs의
// FIXED_NOW_MS 관례 그대로).
const FIXED_NOW_MS = parseKstTimestamp("2026-11-02 09:00:00 KST").getTime();

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withFixtureDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "hyk412 runner-contract-refusal test fixture",
    ],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
}

function fingerprintOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeCoderRound(dir, { taskId, droppedAt, doneAt, contractLine }) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n${contractLine}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ ${doneAt}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function baseReceipt(headCommit, overrides = {}) {
  return {
    schema_version: 2,
    runner_exit: 0,
    runner_status: "OK",
    tests: 10,
    pass: 10,
    fail: 0,
    skip: 0,
    head_commit: headCommit,
    finished_at: "2026-11-02 06:09:00 KST",
    ...overrides,
  };
}

function writeReceipt(dir, receipt) {
  writeFileSync(
    join(dir, "runner-receipt.json"),
    JSON.stringify(receipt, null, 2),
    "utf8",
  );
}

function writeNumberedReceipt(dir, n, receipt) {
  writeFileSync(
    join(dir, `${RUNNER_RECEIPT_RUN_PREFIX}${n}.json`),
    JSON.stringify(receipt, null, 2),
    "utf8",
  );
}

// 관제실 HYK-433 2R 봉투 사본과 같은 모양 -- run3=0/run4=1/run5=0,
// canonical = 최신(run5)의 그대로 복사.
function writeHyk433StyleSample(dir, taskId, sha) {
  writeCoderRound(dir, {
    taskId,
    droppedAt: "2026-11-02 05:00 KST",
    doneAt: "2026-11-02 07:00:00 KST",
    contractLine: "runner_contract: full-2x\n",
  });
  const run3 = baseReceipt(sha, { finished_at: "2026-11-02 06:03:42 KST" });
  const run4 = baseReceipt(sha, {
    runner_exit: 1,
    runner_status: "TESTS_FAILED",
    fail: 1,
    pass: 9,
    finished_at: "2026-11-02 06:29:50 KST",
  });
  const run5 = baseReceipt(sha, { finished_at: "2026-11-02 06:53:03 KST" });
  writeNumberedReceipt(dir, 3, run3);
  writeNumberedReceipt(dir, 4, run4);
  writeNumberedReceipt(dir, 5, run5);
  writeReceipt(dir, run5); // canonical = latest green copy, real-production shape
}

function setupLedger(dir, taskId) {
  let ledger = createEmptyLedger("2026-11-02T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: taskId,
    cap: 1,
    now: "2026-11-02T00:00:00.000Z",
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
    return fn();
  } finally {
    if (prevEnv === undefined) delete process.env.ADMISSION_LEDGER_PATH;
    else process.env.ADMISSION_LEDGER_PATH = prevEnv;
  }
}

function findRefusalRecordPath(dir) {
  const receiptsDir = join(dir, "receipts");
  if (!existsSync(receiptsDir)) return null;
  const names = readdirSync(receiptsDir).filter((n) =>
    n.startsWith("coder-runner-contract-refused-"),
  );
  if (names.length !== 1) return { names, receiptsDir };
  return join(receiptsDir, names[0]);
}

// ===========================================================================
// (1) 프로덕션 구동 -- HYK-433 2R 모양 합성 표본, RED 거부 + state 부여 +
// 봉투 아카이브 1 + 거부 기록 1.
// ===========================================================================
test("(hyk412-1)★ 합성 HYK-433 2R 모양 표본(run3=0/run4=1/run5=0) -> checkRelayHandshake가 RED 거부 + state=CONSUMPTION_REFUSED_RUNNER_CONTRACT(사유 문자열은 HYK-485 기존 문구와 바이트 동일, 새 필드만 추가) + 봉투 아카이브 1 + 거부 기록 1", () => {
  withFixtureDir("hyk412-1-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-412-RC-1";
    writeHyk433StyleSample(dir, taskId, sha);
    const ledgerPath = setupLedger(dir, taskId);

    let result;
    withLedgerEnv(ledgerPath, () => {
      result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
    assert.equal(result.state, "CONSUMPTION_REFUSED_RUNNER_CONTRACT");
    assert.match(
      result.reason,
      /consecutive runner receipt gate \(HYK-485\): .*runner-receipt-run4\.json reports runner_exit=1 \(non-zero\) -- refusing to consume a claimed 2-consecutive-green result when one of the two runs was not green/,
    );

    // 봉투 1 (HYK-398과 동일 자리).
    assert.ok(existsSync(join(dir, "rounds", "coder-r1.md")));

    // 거부 1줄 지속 기록 (HYK-412 신규).
    const recordPath = findRefusalRecordPath(dir);
    assert.ok(
      typeof recordPath === "string",
      `refusal record not found or ambiguous: ${JSON.stringify(recordPath)}`,
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.label, taskId);
    assert.equal(record.blockReasonCode, "CONSUMPTION_REFUSED_RUNNER_CONTRACT");
    assert.equal(
      record.resultFingerprintSha256,
      fingerprintOf(readFileSync(join(dir, "coder.md"), "utf8")),
    );
    assert.equal(record.receipts.length, 2);
    const byPath = Object.fromEntries(record.receipts.map((r) => [r.path, r]));
    assert.equal(byPath["runner-receipt-run4.json"].runner_exit, 1);
    assert.equal(byPath["runner-receipt-run4.json"].head_commit, sha);
    assert.equal(
      byPath["runner-receipt-run4.json"].sha256,
      sha256OfFile(join(dir, "runner-receipt-run4.json")),
    );
    assert.equal(byPath["runner-receipt-run5.json"].runner_exit, 0);
    assert.equal(
      byPath["runner-receipt-run5.json"].sha256,
      sha256OfFile(join(dir, "runner-receipt-run5.json")),
    );

    // 은퇴 기록이 아직 없으므로 원장 자리는 그대로 ACTIVE여야 한다
    // (HYK-398 (1)과 같은 원칙).
    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(countActive(after), 1);
  });
});

// ===========================================================================
// (2) 반복 폴링 -- 같은 라벨 + 같은 결과 지문이면 1개만(중복 0).
// ===========================================================================
test("(hyk412-2) 반복 폴링: 같은 라벨+같은 결과 지문이면 거부 기록이 다시 쓰이지 않는다(바이트 동일, 반복 폴링 중복 0)", () => {
  withFixtureDir("hyk412-2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-412-RC-2";
    writeHyk433StyleSample(dir, taskId, sha);
    const ledgerPath = setupLedger(dir, taskId);

    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });
    const firstPath = findRefusalRecordPath(dir);
    const firstContent = readFileSync(firstPath, "utf8");

    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });
    const secondPath = findRefusalRecordPath(dir);
    const secondContent = readFileSync(secondPath, "utf8");

    assert.equal(secondPath, firstPath);
    assert.equal(
      secondContent,
      firstContent,
      "같은 라벨+같은 결과 지문인데 두 번째 폴링에서 내용이 바뀌었다 -- 중복/재작성이 일어난 것",
    );
  });
});

// ===========================================================================
// (3) 과적용 금지 -- HYK-485 게이트의 다른 거부 사유(MEASUREMENT_UNAVAILABLE,
// 회차 영수증 1개뿐)는 state 없음 + 봉투/거부 기록 0.
// ===========================================================================
test("(hyk412-3) 과적용 금지: 같은 게이트의 다른 거부 사유(entries.length<2 -> MEASUREMENT_UNAVAILABLE)는 state 없음, 봉투·거부 기록 0", () => {
  withFixtureDir("hyk412-3-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-412-RC-3";
    writeCoderRound(dir, {
      taskId,
      droppedAt: "2026-11-02 05:00 KST",
      doneAt: "2026-11-02 07:00:00 KST",
      contractLine: "runner_contract: full-2x\n",
    });
    writeReceipt(dir, baseReceipt(sha));
    writeNumberedReceipt(dir, 1, baseReceipt(sha));
    const ledgerPath = setupLedger(dir, taskId);

    let result;
    withLedgerEnv(ledgerPath, () => {
      result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE,
    );
    assert.equal(result.state, undefined);
    assert.ok(!existsSync(join(dir, "rounds")));
    const recordPath = findRefusalRecordPath(dir);
    assert.equal(recordPath, null);
  });
});

// ===========================================================================
// (4)/(5)/(6) 은퇴 부수효과 결선 -- HYK-398과 같은 3단 구조.
// ===========================================================================
test("(hyk412-4) 은퇴 기록이 없으면 거부만 하고 원장 슬롯은 손대지 않는다(HYK-398 (1)과 동일 원칙)", () => {
  withFixtureDir("hyk412-4-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-412-RC-4";
    writeHyk433StyleSample(dir, taskId, sha);
    const ledgerPath = setupLedger(dir, taskId);

    let result;
    withLedgerEnv(ledgerPath, () => {
      result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });
    assert.equal(result.state, "CONSUMPTION_REFUSED_RUNNER_CONTRACT");

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      countActive(after),
      1,
      "은퇴 기록이 없으면 자리를 빼앗지 않는다",
    );
  });
});

test("(hyk412-5)★ 유효한 은퇴 기록이 있으면 원장 슬롯을 실제로 반납한다(RETIREMENT_RELEASED), 소비 판정 자체는 byte-identical", () => {
  withFixtureDir("hyk412-5-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-412-RC-5";
    writeHyk433StyleSample(dir, taskId, sha);
    const ledgerPath = setupLedger(dir, taskId);

    let firstResult;
    withLedgerEnv(ledgerPath, () => {
      firstResult = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });

    const archivePath = join(dir, "rounds", "coder-r1.md");
    assert.ok(existsSync(archivePath));
    const resultContent = readFileSync(join(dir, "coder.md"), "utf8");
    const archivedFingerprint = fingerprintOf(resultContent);
    const refusalRecordPath = findRefusalRecordPath(dir);

    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      JSON.stringify({
        role: "CODER",
        harnessTaskLabel: taskId,
        archivePath: "rounds/coder-r1.md",
        archiveFingerprintClaimed: archivedFingerprint,
        blockReasonCode: "CONSUMPTION_REFUSED_RUNNER_CONTRACT",
        evidenceReceiptPath: `receipts/${refusalRecordPath.split(/[\\/]/).pop()}`,
        successorLabel: `${taskId}-next`,
        recordedAt: "2026-11-02 08:00:00 KST",
        evidence: { source: "test" },
      }),
      "utf8",
    );

    let secondResult;
    withLedgerEnv(ledgerPath, () => {
      secondResult = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });

    assert.equal(secondResult.ok, false);
    assert.equal(secondResult.state, "CONSUMPTION_REFUSED_RUNNER_CONTRACT");
    assert.equal(secondResult.reason, firstResult.reason);

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(countActive(after), 0, "자리가 실제로 반납돼야 한다");
    assert.equal(
      after.reservations[taskId].completion_reason,
      "RETIREMENT_RELEASED",
    );
  });
});

test("(hyk412-6) 거부 기록의 영수증 sha256을 위조하면 재확인에 실패해 자리를 반납하지 못한다", () => {
  withFixtureDir("hyk412-6-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-412-RC-6";
    writeHyk433StyleSample(dir, taskId, sha);
    const ledgerPath = setupLedger(dir, taskId);

    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });

    const resultContent = readFileSync(join(dir, "coder.md"), "utf8");
    const archivedFingerprint = fingerprintOf(resultContent);
    const refusalRecordPath = findRefusalRecordPath(dir);

    // ⛔위조: 거부 기록이 나열한 영수증의 sha256을 손으로 바꿔친다 --
    // 실제 영수증 파일(runner-receipt-run4.json)은 그대로 둔다.
    const refusalRecord = JSON.parse(readFileSync(refusalRecordPath, "utf8"));
    refusalRecord.receipts[0].sha256 = "f".repeat(64);
    writeFileSync(refusalRecordPath, JSON.stringify(refusalRecord), "utf8");

    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      JSON.stringify({
        role: "CODER",
        harnessTaskLabel: taskId,
        archivePath: "rounds/coder-r1.md",
        archiveFingerprintClaimed: archivedFingerprint,
        blockReasonCode: "CONSUMPTION_REFUSED_RUNNER_CONTRACT",
        evidenceReceiptPath: `receipts/${refusalRecordPath.split(/[\\/]/).pop()}`,
        successorLabel: `${taskId}-next`,
        recordedAt: "2026-11-02 08:00:00 KST",
        evidence: { source: "test" },
      }),
      "utf8",
    );

    withLedgerEnv(ledgerPath, () => {
      checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
    });

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      countActive(after),
      1,
      "위조된(sha256 불일치) 거부 기록은 자리를 반납하지 못해야 한다",
    );
  });
});

// ===========================================================================
// (7) 되돌림 변이 -- RETIREMENT_SIDE_EFFECT_STATES에서
// CONSUMPTION_REFUSED_RUNNER_CONTRACT를 빼면, 증거를 갖춘 표본도 자리를
// 반납받지 못한다(RED) -- relay-handshake-retirement-mutation.test.mjs의
// 동일 원칙(isolated staged copy, 실 파일은 메모리에서 읽기만).
// ===========================================================================
// relay-handshake-retirement-mutation.test.mjs의 stageIsolatedRelayHandshakeDeps
// 와 같은 원칙(§7의 isolated staged copy) -- 이 축이 참조하는 형제 파일
// 전체를 격리 디렉터리에 복사하고, relay-handshake.mjs 자신만 변이본으로
// 바꿔 써 넣는다.
function stageMutatedRelayHandshakeDeps(rootDir, mutatedSrc) {
  const checkDir = join(rootDir, "scripts", "check");
  const supervisorDir = join(rootDir, "scripts", "supervisor");
  mkdirSync(checkDir, { recursive: true });
  mkdirSync(supervisorDir, { recursive: true });
  for (const name of [
    ...RELAY_HANDSHAKE_STATIC_SIBLINGS,
    "admission-completion-adapter.mjs",
    "ledger-pointer-shared.mjs",
    "retirement-record-core.mjs",
    "retirement-block-reason-shared.mjs",
  ]) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(HERE, name), "utf8"),
      "utf8",
    );
  }
  for (const name of [
    "admission-ledger-core.mjs",
    "admission-ledger-store.mjs",
  ]) {
    writeFileSync(
      join(supervisorDir, name),
      readFileSync(join(HERE, "..", "supervisor", name), "utf8"),
      "utf8",
    );
  }
  writeFileSync(join(checkDir, "relay-handshake.mjs"), mutatedSrc, "utf8");
  return { checkDir };
}

// (hyk412-5)/(hyk412-7)과 같은 모양의 "증거를 갖춘 표본"을 harnessDir에
// 직접 조립한다(이 라운드가 쓰는 프로덕션 writer를 거치지 않고, 그 writer가
// 실제로 쓰는 것과 같은 필드 모양을 손으로 조립 -- 이 시험이 고정하는 것은
// 그 결과를 "은퇴 축이 읽었을 때" 벌어지는 일이다).
function writeEvidencedRunnerContractRefusalSample(harnessDir, taskId, sha) {
  writeHyk433StyleSample(harnessDir, taskId, sha);
  mkdirSync(join(harnessDir, "rounds"), { recursive: true });
  const resultContent = readFileSync(join(harnessDir, "coder.md"), "utf8");
  writeFileSync(
    join(harnessDir, "rounds", "coder-r1.md"),
    resultContent,
    "utf8",
  );
  const resultFingerprint = fingerprintOf(resultContent);
  mkdirSync(join(harnessDir, "receipts"), { recursive: true });
  const refusalRecord = {
    label: taskId,
    role: "coder",
    blockReasonCode: "CONSUMPTION_REFUSED_RUNNER_CONTRACT",
    resultFingerprintSha256: resultFingerprint,
    receipts: [
      {
        path: "runner-receipt-run4.json",
        sha256: sha256OfFile(join(harnessDir, "runner-receipt-run4.json")),
        runner_exit: 1,
        head_commit: sha,
      },
      {
        path: "runner-receipt-run5.json",
        sha256: sha256OfFile(join(harnessDir, "runner-receipt-run5.json")),
        runner_exit: 0,
        head_commit: sha,
      },
    ],
    reason: "mutation fixture",
    recordedAt: "2026-11-02T08:00:00.000Z",
  };
  writeFileSync(
    join(harnessDir, "receipts", "coder-runner-contract-refused-mut.json"),
    JSON.stringify(refusalRecord),
    "utf8",
  );
  mkdirSync(join(harnessDir, "retirements"), { recursive: true });
  writeFileSync(
    join(harnessDir, "retirements", "coder-retire-r1.json"),
    JSON.stringify({
      role: "CODER",
      harnessTaskLabel: taskId,
      archivePath: "rounds/coder-r1.md",
      archiveFingerprintClaimed: resultFingerprint,
      blockReasonCode: "CONSUMPTION_REFUSED_RUNNER_CONTRACT",
      evidenceReceiptPath: "receipts/coder-runner-contract-refused-mut.json",
      successorLabel: `${taskId}-next`,
      recordedAt: "2026-11-02 08:00:00 KST",
      evidence: { source: "mutation-test" },
    }),
    "utf8",
  );
}

test("(hyk412-7)★ 되돌림 변이: RETIREMENT_SIDE_EFFECT_STATES에서 CONSUMPTION_REFUSED_RUNNER_CONTRACT를 빼면 -> 증거를 갖춘 표본도 자리를 못 돌려받는다(RED), 실 소스 파일은 원복 증명(바이트 동일)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target = `const RETIREMENT_SIDE_EFFECT_STATES = new Set([
  "STALE_DONE_PREDATES_DROP",
  "CONSUMPTION_REFUSED_RUNNER_CONTRACT",
]);`;
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "RETIREMENT_SIDE_EFFECT_STATES" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(
    target,
    `const RETIREMENT_SIDE_EFFECT_STATES = new Set([
  "STALE_DONE_PREDATES_DROP",
  // HYK-412 되돌림 변이: CONSUMPTION_REFUSED_RUNNER_CONTRACT를 뺀다
]);`,
  );

  const rootDir = tmpDir("hyk412-mut-root-");
  const harnessDir = tmpDir("hyk412-mut-harness-");
  try {
    const { checkDir } = stageMutatedRelayHandshakeDeps(rootDir, mutated);

    const sha = ensureGitHeadCommit(harnessDir);
    const taskId = "HYK-412-MUT-1";
    writeEvidencedRunnerContractRefusalSample(harnessDir, taskId, sha);
    const ledgerPath = setupLedger(harnessDir, taskId);

    const mod = await import(
      `file://${join(checkDir, "relay-handshake.mjs").replace(/\\/g, "/")}?t=${Date.now()}`
    );
    withLedgerEnv(ledgerPath, () => {
      mod.checkRelayHandshake({
        role: "coder",
        harnessDir,
        now: FIXED_NOW_MS,
      });
    });

    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      countActive(after),
      1,
      "RED: 집합에서 상태를 빼면 증거를 갖춘 표본도 자리를 반납받지 못한다 -- 이 결선이 실제로 원인임을 증명",
    );
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
