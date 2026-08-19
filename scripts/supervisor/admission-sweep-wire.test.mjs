// HYK-228 (coder-task.md §5) -- admission-sweep-wire.mjs 결선 시험.
//
// ⛔실 관제실 원장 무접촉(coder-task §3/§7) -- 이 스위트가 만지는 모든
// 원장·락 파일은 `mkdtemp` 격리 디렉터리 안에만 있다(admission-cli.test.mjs
// tmpPaths와 동일 패턴).
//
// 이 시험이 보장하지 않는 것(S11):
// 1. "orca terminal list가 실제로 정확하다"를 증명하지 않는다 -- execFn을
//    항상 주입해 실 orca/실 fs를 건드리지 않는다.
// 2. 표본 수 -- 각 test 이름에 분모를 명시한다(ⓑ는 1건 표본, 일반화하지
//    않는다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAdmissionSweepTrigger,
  queryTerminalList,
} from "./admission-sweep-wire.mjs";
import { runWatchOnce } from "./watch-run.mjs";
import {
  judgeWatchFreshness,
  WATCH_FRESHNESS_VERDICT,
  WATCH_FRESHNESS_REASON,
} from "./watch-freshness-core.mjs";
import { ADMISSION_SCHEMA_VERSION } from "./admission-ledger-core.mjs";
import {
  judgeAdmissionSweepFreshness,
  ADMISSION_SWEEP_FRESHNESS_VERDICT,
} from "./admission-sweep-freshness-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});

function tmpPaths(prefix = "admission-sweep-wire-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

function seedLedger(ledgerPath, reservations) {
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: ADMISSION_SCHEMA_VERSION,
      epoch: "2026-08-01T00:00:00.000Z",
      reservations,
    }),
    "utf8",
  );
}

function activeReservation({ seatKey, admittedAt }) {
  return {
    status: "ACTIVE",
    role: "CODER",
    seat_key: seatKey,
    admitted_at: admittedAt,
    completed_at: null,
    suspect_at: null,
    flagged_unjudgeable_at: null,
    source: "admission",
  };
}

// ---------------------------------------------------------------------------
// ⓐ 양성 -- 죽은 좌석의 잔존 예약이 회수된다(admitted -> SUSPECT -> COMPLETED,
// 두 번의 sweep 사이클 -- coder-task §1의 실물 회수 경로 그대로).
// ---------------------------------------------------------------------------
test("(a) POSITIVE: a dead seat's leftover ACTIVE reservation is recovered to COMPLETED across two sweep cycles (1/1 reservation)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    seedLedger(ledger, {
      r1: activeReservation({
        seatKey: "dead-seat",
        admittedAt: "2026-08-01T00:00:00.000Z",
      }),
    });
    const cycle1 = runAdmissionSweepTrigger({
      ledgerPath: ledger,
      lockPath: lock,
      staleAfterMs: 0,
      recoveryGraceMs: 0,
      now: "2026-08-01T02:00:00.000Z",
      terminalListOverride: { ok: true, terminals: [] }, // no seats alive at all
    });
    assert.equal(cycle1.ok, true);
    assert.equal(cycle1.changed.length, 1);
    assert.equal(cycle1.changed[0].to, "SUSPECT");
    const midLedger = JSON.parse(fs.readFileSync(ledger, "utf8"));
    assert.equal(midLedger.reservations.r1.status, "SUSPECT");

    const cycle2 = runAdmissionSweepTrigger({
      ledgerPath: ledger,
      lockPath: lock,
      staleAfterMs: 0,
      recoveryGraceMs: 0,
      now: "2026-08-01T02:00:01.000Z",
      terminalListOverride: { ok: true, terminals: [] },
    });
    assert.equal(cycle2.ok, true);
    assert.equal(cycle2.changed.length, 1);
    assert.equal(cycle2.changed[0].to, "COMPLETED");
    const finalLedger = JSON.parse(fs.readFileSync(ledger, "utf8"));
    assert.equal(finalLedger.reservations.r1.status, "COMPLETED");
    assert.equal(
      finalLedger.reservations.r1.completion_reason,
      "SUSPECT_TIMEOUT_RECOVERED",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓑ 음성(오탐 0) -- 살아있는 좌석의 진행 중 예약은 회수되지 않는다.
// ★분모 선언: 이 fixture 세트는 살아있는 좌석 1건뿐이다(1/1) -- 이 결과를
// "모든 살아있는 좌석에 대해 오탐 0"으로 일반화하지 않는다. sweepAndRecover
// 자체의 전건 판정은 admission-ledger-core.test.mjs가 맡는다(이 시험은
// "발동 주체(wire)가 그 판정을 있는 그대로 통과시키는가"만 본다).
// ---------------------------------------------------------------------------
test("(b) NEGATIVE (false-positive=0, 1/1 live-seat fixture): a live seat's in-progress reservation is untouched", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    // HYK-317: seat_key와 terminals 항목은 같은 축(paneKey, `${tabId}:
    // ${leafId}`)이어야 한다 -- handle이 아니다.
    seedLedger(ledger, {
      r1: activeReservation({
        seatKey: "tab-live:leaf-live",
        admittedAt: "2026-08-01T00:00:00.000Z",
      }),
    });
    const result = runAdmissionSweepTrigger({
      ledgerPath: ledger,
      lockPath: lock,
      staleAfterMs: 0,
      recoveryGraceMs: 0,
      now: "2026-08-01T02:00:00.000Z",
      terminalListOverride: {
        ok: true,
        terminals: [
          { handle: "term_live", tabId: "tab-live", leafId: "leaf-live" },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, []);
    const finalLedger = JSON.parse(fs.readFileSync(ledger, "utf8"));
    assert.equal(finalLedger.reservations.r1.status, "ACTIVE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ fail-closed -- 좌석 조회 실패 주입 시 회수 0 + 시끄러운 실패(조용한
// 0건과 구별돼 보여야 한다, coder-task §4/§5-ⓒ).
// ---------------------------------------------------------------------------
test("(c) FAIL-CLOSED: seat-query failure -> 0 recovered AND loud failure, distinguishable from a genuine silent-0 success", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    // HYK-317: seat_key는 paneKey 축(`${tabId}:${leafId}`)이다 -- "dead"/
    // "seat" 두 필드가 이 값으로 합성된다(아래 genuinelyZero의 terminals
    // 항목 참조).
    seedLedger(ledger, {
      r1: activeReservation({
        seatKey: "dead:seat",
        admittedAt: "2026-08-01T00:00:00.000Z",
      }),
    });

    // 조회 실패 주입.
    const failed = runAdmissionSweepTrigger({
      ledgerPath: ledger,
      lockPath: lock,
      staleAfterMs: 0,
      recoveryGraceMs: 0,
      now: "2026-08-01T02:00:00.000Z",
      terminalListOverride: {
        ok: false,
        reason: "orca terminal list timed out",
      },
    });
    assert.equal(
      failed.ok,
      false,
      "query failure must surface as ok:false, not a quiet success with changed:[]",
    );
    assert.equal(failed.status, "SWEEP_TRIGGER_ABSTAIN");
    assert.equal(failed.reasonCode, "SEAT_QUERY_FAILED");
    assert.equal(failed.changed, null);
    const untouchedLedger = JSON.parse(fs.readFileSync(ledger, "utf8"));
    assert.equal(
      untouchedLedger.reservations.r1.status,
      "ACTIVE",
      "a failed seat query must never mutate the ledger (0 recovered, not '0 because everyone looked dead')",
    );

    // 대조군: 진짜 «조용히 0건» -- 조회는 성공했고 마침 회수 대상이 없다.
    // terminals의 tabId:leafId("dead:seat")가 원장의 seat_key와 같은
    // paneKey로 조합돼 "살아있다"로 관측되므로 회수 대상이 없다.
    const genuinelyZero = runAdmissionSweepTrigger({
      ledgerPath: ledger,
      lockPath: lock,
      staleAfterMs: 0,
      recoveryGraceMs: 0,
      now: "2026-08-01T02:00:00.000Z",
      terminalListOverride: {
        ok: true,
        terminals: [{ handle: "term_dead", tabId: "dead", leafId: "seat" }],
      },
    });
    assert.equal(
      genuinelyZero.ok,
      true,
      "a successful query with nothing to recover must be a loud ok:true, not confused with the failure branch above",
    );
    assert.equal(genuinelyZero.status, "SWEEP_TRIGGER_SWEPT");
    assert.deepEqual(genuinelyZero.changed, []);

    assert.notEqual(
      failed.ok,
      genuinelyZero.ok,
      "'query failed' and 'query succeeded, 0 recovered' must be visibly distinct outcomes (coder-task §4/§5-ⓒ)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓓ 생존 보증 RED -- 수거기가 죽으면(스케줄러 만료/NextRunTime 공백과
// 동형인 "다음 주기가 안 돌았다") freshness 게이트가 RED로 잡는가.
//
// 설계: sweep은 새 스케줄 인프라가 아니라 watch-run.mjs의 기존 주기
// 사이클에 얹혀 있다(admission-sweep-wire.mjs 헤더) -- 그래서 "수거기가
// 죽었다"는 정확히 "watch-run 사이클이 안 돌았다"와 같은 사건이고, 이미
// 있는 last-run.json/judgeWatchFreshness/schedule-wire.mjs status 게이트가
// 별도 장치 없이 그 사건을 그대로 잡는다 -- 이 시험이 그 사슬을 실측으로
// 증명한다(스케줄러 만료로 last-run.json이 갱신되지 않는 상황을 "그 회차가
// 아예 안 돎"으로 모사).
// ---------------------------------------------------------------------------
test("(d) SURVIVAL-GUARANTEE RED: a watch-run cycle that carries the sweep step records freshness, and a missed cycle (simulated scheduler expiry) goes STALE", () => {
  const watchDir = mkdtempSync(join(tmpdir(), "admission-sweep-wire-watch-"));
  const { dir: ledgerDir, ledger, lock } = tmpPaths();
  try {
    seedLedger(ledger, {});
    const T0 = Date.parse("2026-08-12T09:00:00+09:00");
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: T0,
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
      admissionSweep: { ledgerPath: ledger, lockPath: lock },
      sweepExecFn: () => ({ ok: true, result: { terminals: [] } }),
    });
    assert.equal(result.sweepResult.notRun, false);
    assert.equal(result.sweepResult.ok, true);
    assert.match(result.line, /sweep_status=SWEEP_TRIGGER_SWEPT/);

    const record = JSON.parse(fs.readFileSync(result.aliveRecordPath, "utf8"));
    assert.equal(record.recordedAtMs, T0);

    // ALIVE at T0 (this is exactly what schedule-wire.mjs `status` would
    // report right after this cycle ran).
    const aliveAtT0 = judgeWatchFreshness({
      lastRun: record,
      now: T0,
      staleAfterSeconds: 900,
    });
    assert.equal(aliveAtT0.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);

    // ★스케줄러 만료/NextRunTime 공백 주입 -- 다음 회차가 전혀 돌지
    // 않았다고 가정하고(coder-task §1 실측 사고와 동형: last-run.json이
    // 그대로 멎어 있다) 7시간 뒤(§1 실측 "7시간 무관측"과 동일 스케일)에
    // 판정하면 STALE(RED)이어야 한다.
    const sevenHoursLater = T0 + 7 * 60 * 60 * 1000;
    const staleVerdict = judgeWatchFreshness({
      lastRun: record,
      now: sevenHoursLater,
      staleAfterSeconds: 900,
    });
    assert.equal(
      staleVerdict.verdict,
      WATCH_FRESHNESS_VERDICT.STALE,
      "RED: a dead sweep-carrying watch-run cycle must be visible as STALE, not silently read as ALIVE",
    );
    assert.equal(
      staleVerdict.reasonCode,
      WATCH_FRESHNESS_REASON.PAST_STALE_WINDOW,
    );
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓔ 생존 보증 RED #2 (coder-r2 rejection-2, review-r1.md §B의 정확한 재현)
// -- "사이클은 도는데 수거만 죽었다". (d)는 "사이클 자체가 안 돎"을
// 잡지만, 검토자가 실측한 반려 사유는 "사이클은 정상 완료했는데 sweep
// 원장이 사라져 ok:false가 났고, 그런데도 freshness는 ALIVE"였다. 이
// 시험은 실제 `runWatchOnce`를 진짜 mkdtemp 원장 경로(존재하지 않는
// 파일 -- ENOENT -> LEDGER_MISSING -> SWEEP_TRIGGER_STATE_UNAVAILABLE)로
// 1회 돌려 그 상황을 그대로 재현하고, 새로 만든
// `judgeAdmissionSweepFreshness`가 최종 판정을 RED(SWEEP_FAILED)로
// 뒤집는지 실측으로 증명한다. 같은 시험 안에 "진짜 조용한 0건"
// 대조군도 함께 넣어 대비가 보이게 한다(coder-r2 지시 그대로 -- 두
// 경우를 한 곳에서 대조).
// ---------------------------------------------------------------------------
// (e)의 "사이클은 도는데 수거만 죽었다" 절반 -- 원장 누락(review-r1.md
// §B 재현)으로 sweep이 실패한 사이클을 실제로 돌려, 기존 judgeWatchFreshness
// 는 여전히 ALIVE인데(계약 불변) 새 합성 판정은 RED로 뒤집는지 실측한다.
// HYK-228 4R(coder-task.md §1 항2) -- max-lines-per-function 수리를 위해
// (e) 시험 본문에서 추출(동일 단언문 그대로, 호출 순서만 옮김).
function assertBrokenSweepCycleTurnsRed(T0) {
  const watchDir = mkdtempSync(join(tmpdir(), "admission-sweep-wire-watch2-"));
  const ledgerDir = mkdtempSync(
    join(tmpdir(), "admission-sweep-wire-missing-ledger-"),
  );
  try {
    // 원장 파일을 절대 만들지 않는다(디렉터리만 mkdtemp) -- 검토자
    // 실측과 동형인 "원장 누락" 상태(readLedgerRaw -> ENOENT ->
    // LEDGER_MISSING -> withLedgerLock 안에서 state_unavailable).
    const missingLedger = join(ledgerDir, "does-not-exist-ledger.json");
    const missingLock = join(ledgerDir, "does-not-exist-ledger.lock");

    const brokenCycle = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: T0,
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
      admissionSweep: { ledgerPath: missingLedger, lockPath: missingLock },
      sweepExecFn: () => ({ ok: true, result: { terminals: [] } }),
    });
    // 실측: 사이클 자체는 정상 완료(러너가 던지지 않음), sweep은 실패.
    assert.equal(brokenCycle.sweepResult.notRun, false);
    assert.equal(
      brokenCycle.sweepResult.ok,
      false,
      "review-r1.md §B repro: missing ledger must surface as sweep ok:false",
    );
    assert.equal(
      brokenCycle.sweepResult.status,
      "SWEEP_TRIGGER_STATE_UNAVAILABLE",
    );

    const brokenRecord = JSON.parse(
      fs.readFileSync(brokenCycle.aliveRecordPath, "utf8"),
    );
    assert.equal(brokenRecord.recordedAtMs, T0);
    assert.equal(brokenRecord.sweep.ran, true);
    assert.equal(brokenRecord.sweep.ok, false);

    // 검토자가 실측한 결함: 기존 judgeWatchFreshness는 여전히 ALIVE다
    // (이 코어의 계약은 바꾸지 않았다 -- 실측 확인, 회귀 0).
    const oldVerdict = judgeWatchFreshness({
      lastRun: brokenRecord,
      now: T0 + 1000,
      staleAfterSeconds: 900,
    });
    assert.equal(
      oldVerdict.verdict,
      WATCH_FRESHNESS_VERDICT.ALIVE,
      "judgeWatchFreshness's existing contract is untouched -- it still can't see the sweep sub-failure by itself (that's exactly why the new composed function exists)",
    );

    // 새 합성 판정은 RED로 뒤집는다.
    const composedVerdict = judgeAdmissionSweepFreshness({
      lastRun: brokenRecord,
      now: T0 + 1000,
      staleAfterSeconds: 900,
    });
    assert.equal(
      composedVerdict.verdict,
      ADMISSION_SWEEP_FRESHNESS_VERDICT.SWEEP_FAILED,
      "RED: cycle-alive-but-sweep-failed must not be reported ALIVE by the composed gate",
    );
    assert.notEqual(composedVerdict.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

// (e)의 대조군 절반 -- 진짜 조용한 0건(원장은 있고, 회수할 것이 없다)은
// 새 합성 판정에서도 거짓경보 없이 ALIVE로 남는지 실측한다. 추출 사유는
// assertBrokenSweepCycleTurnsRed와 동일(HYK-228 4R, 동일 단언문 그대로).
function assertHealthySweepCycleStaysAlive(T0) {
  const {
    dir: healthyDir,
    ledger: healthyLedger,
    lock: healthyLock,
  } = tmpPaths("admission-sweep-wire-healthy-ledger-");
  seedLedger(healthyLedger, {});
  const healthyWatchDir = mkdtempSync(
    join(tmpdir(), "admission-sweep-wire-watch2-healthy-"),
  );
  try {
    const healthyCycle = runWatchOnce({
      repoRoot: ROOT,
      watchDir: healthyWatchDir,
      now: T0,
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
      admissionSweep: { ledgerPath: healthyLedger, lockPath: healthyLock },
      sweepExecFn: () => ({ ok: true, result: { terminals: [] } }),
    });
    assert.equal(healthyCycle.sweepResult.ok, true);
    assert.deepEqual(healthyCycle.sweepResult.changed, []);

    const healthyRecord = JSON.parse(
      fs.readFileSync(healthyCycle.aliveRecordPath, "utf8"),
    );
    assert.equal(healthyRecord.sweep.ok, true);
    assert.equal(healthyRecord.sweep.changedCount, 0);

    const healthyVerdict = judgeAdmissionSweepFreshness({
      lastRun: healthyRecord,
      now: T0 + 1000,
      staleAfterSeconds: 900,
    });
    assert.equal(
      healthyVerdict.verdict,
      WATCH_FRESHNESS_VERDICT.ALIVE,
      "no new false alarm: a genuinely empty sweep (ok:true, changed:[]) on an otherwise-healthy cycle must stay ALIVE",
    );
  } finally {
    rmSync(healthyDir, { recursive: true, force: true });
    rmSync(healthyWatchDir, { recursive: true, force: true });
  }
}

test("(e) SURVIVAL-GUARANTEE RED #2: a watch-run cycle that completes fine but whose sweep sub-step fails (missing ledger, review-r1.md §B repro) now judges RED via judgeAdmissionSweepFreshness -- while the SAME cycle's genuinely-empty sweep (ok:true, changed:[]) stays ALIVE (no new false alarm)", () => {
  const T0 = Date.parse("2026-08-12T09:00:00+09:00");
  assertBrokenSweepCycleTurnsRed(T0);
  assertHealthySweepCycleStaysAlive(T0);
});

// ---------------------------------------------------------------------------
// §2 항3 periodic <-> event 상호 복구 -- runAdmissionSweepTrigger는 순수
// 함수 조합(주입된 execFn/ledgerPath/lockPath 밖의 어떤 상태도 읽지 않음)
// 이라 "주기 호출자(watch-run 사이클)"와 "이벤트/즉시 호출자(CLI 직접
// 실행)"가 서로의 존재를 몰라도 동일한 결과를 낸다는 것을 직접 확증한다
// -- 한쪽 호출자가 죽어도 다른 쪽이 정확히 같은 판단·부작용으로 회수를
// 완수할 수 있다는 근거.
// ---------------------------------------------------------------------------
test("§mutual-recovery: calling runAdmissionSweepTrigger directly (event path) yields the same recovery as calling it from inside runWatchOnce (periodic path), same ledger (1/1 fixture)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const watchDir = mkdtempSync(join(tmpdir(), "admission-sweep-wire-mutual-"));
  try {
    seedLedger(ledger, {
      r1: activeReservation({
        seatKey: "dead-seat",
        admittedAt: "2026-08-01T00:00:00.000Z",
      }),
    });
    // "이벤트" 경로: watch-run을 전혀 거치지 않고 직접 호출.
    const direct = runAdmissionSweepTrigger({
      ledgerPath: ledger,
      lockPath: lock,
      staleAfterMs: 0,
      recoveryGraceMs: 0,
      now: "2026-08-01T02:00:00.000Z",
      terminalListOverride: { ok: true, terminals: [] },
    });
    assert.equal(direct.ok, true);
    assert.equal(direct.changed[0].to, "SUSPECT");

    // "주기" 경로: 같은 함수를, watch-run.mjs의 사이클 안에서 다시 호출
    // (별도 프로세스/상태 없이도 같은 원장에 같은 판정이 적용됨을 보인다).
    const viaWatchRun = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: Date.parse("2026-08-01T02:00:01.000Z"),
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
      admissionSweep: {
        ledgerPath: ledger,
        lockPath: lock,
        staleAfterMs: 0,
        recoveryGraceMs: 0,
      },
      sweepExecFn: () => ({ ok: true, result: { terminals: [] } }),
    });
    assert.equal(viaWatchRun.sweepResult.ok, true);
    assert.equal(viaWatchRun.sweepResult.changed[0].to, "COMPLETED");

    const finalLedger = JSON.parse(fs.readFileSync(ledger, "utf8"));
    assert.equal(finalLedger.reservations.r1.status, "COMPLETED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(watchDir, { recursive: true, force: true });
  }
});

test("queryTerminalList: execFn throwing is surfaced as ok:false (1/1), never lets an exception escape", () => {
  const result = queryTerminalList(() => {
    throw new Error("spawn failed");
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /spawn failed/);
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "admission-sweep-wire.test.mjs must leave the real worktree exactly as it found it",
  );
});
