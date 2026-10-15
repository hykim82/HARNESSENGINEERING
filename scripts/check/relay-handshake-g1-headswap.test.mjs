// HYK-434 H2 -- 책임자 판정(2026-10-14 11:4x §2, 2026-10-15 18:0x §3 ⓑ):
// "완료 조건 대조(1122)"가 요구한 합성 표본 -- 09-04 실사고 모양("새 배달
// G1 값 머리만 바뀌고 본문·DONE은 앞 라운드 것 그대로")이 한 픽스처에서
// 거부되고, 같은 픽스처의 "정상 새 라운드"는 통과함을 직접 구동한다.
// 이어서 그 거부를 지탱하는 시간축 판정(STALE_DONE_PREDATES_DROP ·
// DISPATCH_RECORD_LATE) 각각을 제자리로 꺼서 되돌림 변이로 고정한다
// (coder-task.md §2 point3·4, 헛시험 방지 -- hyk387-dispatch-record-
// required.test.mjs/relay-handshake-g1-dispatch-check.test.mjs와 동일
// 관용구: mkdtemp 격리 픽스처 + 실 CLI spawnSync + 제자리 변이 sha 복원).
import { test, after } from "node:test";
import assert from "node:assert/strict";
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
import { spawnSync } from "node:child_process";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

// HYK-434 2R: same per-process-unique-root fix as relay-handshake-g1-
// dispatch-check.test.mjs's own SCRATCH_ROOT (see its comment) -- a fixed
// literal name here would collide with itself the same way under any
// future nested/concurrent re-execution of this file's own bytes.
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "hyk434-headswap-scratch-"));

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

// relay-handshake-g1-dispatch-check.test.mjs와 동일한 상대-오프셋 관용구.
function formatKst(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

const NOW_MS = Date.now();
const RUNTIME_TASK_ID = "task_aaaaaaaaaaaa";
const PANE_KEY =
  "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";

function g1Block() {
  return `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`;
}

function writeCoderRound(
  dir,
  { taskId = "HYK-434-T", doneAtMs, droppedAtMs, g1 = g1Block() },
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${g1}\n>>> DONE: CODER @ ${formatKst(doneAtMs, {
      seconds: true,
    })}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

function validReceipt({
  taskId = "HYK-434-T",
  recordedAtMs,
  runtimeTaskId = RUNTIME_TASK_ID,
  paneKey = PANE_KEY,
} = {}) {
  return {
    recorded_at: new Date(recordedAtMs).toISOString(),
    runtime_task_id: runtimeTaskId,
    dispatch_id: "ctx_1",
    assignee_pane_key: paneKey,
    dispatch_timestamp_utc: new Date(recordedAtMs - 60 * 1000).toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role: "coder",
    harness_task_label: taskId,
  };
}

function withLedger(dir, records) {
  const ledgerPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(ledgerPath, records.map((r) => ledgerLine(r)).join(""), "utf8");
  return ledgerPath;
}

function runCli(args, { ledgerPath } = {}) {
  if (ledgerPath) {
    writeFileSync(
      join(args[1], "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );
  }
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageMutatedRelayHandshake(stageDir, mutateFn) {
  const nestedDir = join(stageDir, "scripts", "check");
  mkdirSync(nestedDir, { recursive: true });
  const original = readFileSync(CLI_PATH, "utf8");
  const mutated = mutateFn(original);
  assert.notEqual(
    mutated,
    original,
    "mutation must actually change the source",
  );
  writeFileSync(join(nestedDir, "relay-handshake.mjs"), mutated, "utf8");
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(nestedDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  return join(nestedDir, "relay-handshake.mjs");
}

function runMutatedCli(mutatedCliPath, args) {
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [mutatedCliPath, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ===========================================================================
// 머리만 교체 합성 1칸(책임자 판정 2026-10-15 18:0x §3 ⓑ 원문): 새 배달
// G1 3줄 값 + 앞 라운드 본문·DONE(옛 시각) 그대로 + task 파일의 새
// dropped_at -> 소비 거부(STALE_DONE_PREDATES_DROP, checkRewriteAndStaleness
// 가 G1/원장 대조보다 먼저 닿는다 -- checkRelayHandshake 호출 순서 실측,
// relay-handshake.mjs:3745 vs :3798). 같은 픽스처의 "정상 새 라운드"
// (dropped/done 둘 다 새 시각, 순서 정상)는 소비된다.
// ===========================================================================
test("(g1-headswap-stale)★ 머리만 교체 합성(09-04 실사고 모양): 새 배달 G1 값 + 앞 라운드 본문·DONE(옛 시각) + 새 dropped_at -> 거부(STALE_DONE_PREDATES_DROP), 같은 픽스처의 정상 새 라운드는 소비된다", () => {
  withFixtureDir("g1-headswap-", (dir) => {
    const newDroppedAtMs = Math.floor((NOW_MS - 5 * 60 * 1000) / 1000) * 1000;
    const staleDoneAtMs =
      Math.floor((NOW_MS - 2 * 60 * 60 * 1000) / 1000) * 1000;

    writeCoderRound(dir, {
      doneAtMs: staleDoneAtMs,
      droppedAtMs: newDroppedAtMs,
      g1: g1Block(),
    });
    const ledgerPath = withLedger(dir, [
      validReceipt({ recordedAtMs: newDroppedAtMs + 60 * 1000 }),
    ]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0, `기대: 거부. stderr: ${res.stderr}`);
    assert.match(
      res.stderr,
      /stale result: DONE \(.*\) predates task drop \(.*\)/,
      `사유는 STALE_DONE_PREDATES_DROP 이어야 한다(실제: ${res.stderr})`,
    );

    // 같은 픽스처의 "정상 새 라운드" -- dropped/done 둘 다 새 시각, 순서
    // 정상(배달 뒤 완료). 새 G1 값은 g1Block() 그대로(같은 ledger 기준).
    const freshDroppedAtMs =
      Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000;
    const freshDoneAtMs = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000;
    writeCoderRound(dir, {
      doneAtMs: freshDoneAtMs,
      droppedAtMs: freshDroppedAtMs,
      g1: g1Block(),
    });
    const freshLedgerPath = withLedger(dir, [
      validReceipt({ recordedAtMs: freshDroppedAtMs + 60 * 1000 }),
    ]);
    const freshRes = runCli(["coder", dir], { ledgerPath: freshLedgerPath });
    assert.equal(
      freshRes.exit,
      0,
      `같은 픽스처의 정상 새 라운드는 소비돼야 한다. stderr: ${freshRes.stderr}`,
    );
  });
});

// LATE 전용 픽스처(위 STALE과 독립): dropped/done 순서는 정상이지만
// 이 라운드에 매칭되는 유일한 원장 레코드가 doneAt "뒤"에 적혔다.
test("(g1-late-only)★ LATE 전용: dropped/done 순서는 정상이지만 원장 기록이 doneAt «뒤»에 적혔다 -> 거부(DISPATCH_RECORD_LATE)", () => {
  withFixtureDir("g1-late-", (dir) => {
    const droppedAtMs = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000;
    const doneAtMs = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000;
    writeCoderRound(dir, { doneAtMs, droppedAtMs, g1: g1Block() });
    const lateRecordedAtMs = doneAtMs + 60 * 1000; // doneAt 뒤에 기록됨
    const ledgerPath = withLedger(dir, [
      validReceipt({ recordedAtMs: lateRecordedAtMs }),
    ]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /DISPATCH_RECORD_LATE \(HYK-387 P2\)/);
  });
});

// ===========================================================================
// 시간축 되돌림 변이 -- 위 두 판정을 각각 제자리로 꺼서, 그 판정이
// 실제로 거부를 지탱하는지(load-bearing) 되돌림으로 고정한다
// (coder-task.md §2 point4).
// ===========================================================================

test("(g1-mut-stale)★ 되돌림 변이: STALE_DONE_PREDATES_DROP 판정(doneAt < droppedAt)을 꺼면 -- 머리-교체 합성(위 g1-headswap-stale) 표본이 다시 소비된다(RED)", () => {
  withFixtureDir("g1-mut-stale-", (dir) => {
    const target = "if (doneAt < droppedAt) {";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "STALE_DONE_PREDATES_DROP 조건");
    const replacement =
      "if (false && doneAt < droppedAt) { // HYK-434 되돌림 변이: STALE_DONE_PREDATES_DROP 끔";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const newDroppedAtMs = Math.floor((NOW_MS - 5 * 60 * 1000) / 1000) * 1000;
    const staleDoneAtMs =
      Math.floor((NOW_MS - 2 * 60 * 60 * 1000) / 1000) * 1000;
    writeCoderRound(roundDir, {
      doneAtMs: staleDoneAtMs,
      droppedAtMs: newDroppedAtMs,
      g1: g1Block(),
    });
    // ⛔LATE 축과 섞이지 않게: recordedAt을 staleDoneAtMs «이전»으로 둔다
    // (STALE 판정만 끄고 LATE는 그대로 둬도 이 표본이 LATE로도 거부되지
    // 않도록 격리한다 -- 두 축을 한 변이에서 같이 시험하지 않는다).
    const ledgerPath = withLedger(roundDir, [
      validReceipt({ recordedAtMs: staleDoneAtMs - 60 * 1000 }),
    ]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: STALE 판정이 꺼지면 머리-교체 합성 표본이 소비돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

test("(g1-mut-late)★ 되돌림 변이: DISPATCH_RECORD_LATE 판정(recordedAt < doneAtMs 요구)을 꺼면 -- LATE 전용(위 g1-late-only) 표본이 다시 소비된다(RED)", () => {
  withFixtureDir("g1-mut-late-", (dir) => {
    const target =
      'if (typeof doneAtMs === "number" && Number.isFinite(doneAtMs)) {';
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(
      original,
      target,
      "DISPATCH_RECORD_LATE 시간축 분기 진입 조건",
    );
    const replacement =
      'if (false && typeof doneAtMs === "number" && Number.isFinite(doneAtMs)) { // HYK-434 되돌림 변이: DISPATCH_RECORD_LATE 끔';

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const droppedAtMs = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000;
    const doneAtMs = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000;
    writeCoderRound(roundDir, { doneAtMs, droppedAtMs, g1: g1Block() });
    const lateRecordedAtMs = doneAtMs + 60 * 1000;
    const ledgerPath = withLedger(roundDir, [
      validReceipt({ recordedAtMs: lateRecordedAtMs }),
    ]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: LATE 판정이 꺼지면 LATE 전용 표본이 소비돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});
