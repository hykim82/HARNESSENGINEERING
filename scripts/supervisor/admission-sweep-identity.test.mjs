// HYK-317 (coder-task.md §3/§5) -- admission sweep의 "살아있는 좌석" 신분증이
// 원장과 같은 형식(paneKey, `${tabId}:${leafId}`)인지 확인하는 실행 시험.
//
// 완료 조건 1·3만 다룬다(완료 조건 2 "죽은 껍데기 역방향"은 범위 밖,
// coder-task §2-3 -- admission-sweep-trigger-core.mjs 하단 주석 참조).
//
// 이 시험이 보장하지 않는 것(S11):
// - "orca terminal list가 실제로 정확하다"를 증명하지 않는다 -- 주입된
//   terminalList/liveSeatKeys만 판정한다.
// - 표본 수는 각 test 이름에 명시한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdmissionCli } from "./admission-cli.mjs";
import {
  sweepAndRecover,
  admitReservation,
  createEmptyLedger,
} from "./admission-ledger-core.mjs";
import { judgeSweepTrigger } from "./admission-sweep-trigger-core.mjs";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-sweep-identity-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

function captureConsole() {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg) => lines.push(String(msg));
  console.error = (msg) => lines.push(String(msg));
  return {
    lines,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function cutover(ledger, lock) {
  const cap = captureConsole();
  try {
    const exit = runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    assert.equal(exit, 0, "cutover fixture setup must succeed");
  } finally {
    cap.restore();
  }
}

const REAL_PANE_KEY =
  "b7011967-041a-45e4-843c-0cf8e2ccd418:ecdf87c2-a552-4370-9ecf-98d455404f0a";

// HYK-326 (coder-task.md §2-1): admitted_at을 "충분히 과거"로 고정해
// 발급->회수 간 벽시계 간격(수 ms)이 결과를 흔들지 못하게 한다. ageMs=0
// (같은 밀리초)이면 회수 안 함이 제품의 의도된 경계(admission-ledger-
// core.mjs:452, `ageMs <= staleAfterMs`)이므로, 그 경계를 우연에 맡기지
// 않고 픽스처 시각을 고정해 회피한다. CLI(admit/sweep) 경로는 그대로 두고
// 그 사이 임시 원장 파일의 admitted_at 필드만 직접 되돌린다.
const FAR_PAST_ADMITTED_AT = "2020-01-01T00:00:00.000Z";

function rewindAdmittedAt(ledgerPath, reservationId, isoPast) {
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  ledger.reservations[reservationId].admitted_at = isoPast;
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// ---------------------------------------------------------------------------
// 시험 1: 살아있는 좌석(원장 신분증과 같은 paneKey)이 목록에 있으면 회수
// 되지 않는다.
// ---------------------------------------------------------------------------
test("HYK-317 §3-1: a live seat (paneKey matches the ledger's seat_key) is NOT recovered by sweep", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    cutover(ledger, lock);
    const cap = captureConsole();
    let admitExit;
    try {
      admitExit = runAdmissionCli([
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        "HYK-317-live-1",
        "--cap",
        "2",
        "--seat-key",
        REAL_PANE_KEY,
      ]);
    } finally {
      cap.restore();
    }
    assert.equal(admitExit, 0);
    // HYK-326: admitted_at을 과거로 고정해 ageMs가 확실히 staleAfterMs(0)를
    // 넘게 만든다 -- 그래야 아래 "회수되지 않음"이 "나이가 0이라서"가 아니라
    // "좌석이 살아있어서"임이 확실해진다(vacuous pass 방지, coder-task §2-2).
    rewindAdmittedAt(ledger, "HYK-317-live-1", FAR_PAST_ADMITTED_AT);

    const sweepCap = captureConsole();
    let sweepExit;
    try {
      sweepExit = runAdmissionCli([
        "sweep",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        JSON.stringify([REAL_PANE_KEY]),
        "--stale-after-ms",
        "0",
        "--recovery-grace-ms",
        "999999999",
      ]);
    } finally {
      sweepCap.restore();
    }
    assert.equal(sweepExit, 0);
    assert.doesNotMatch(
      sweepCap.lines.join("\n"),
      /"reservationId":"HYK-317-live-1"/,
      `the live reservation must not appear in sweep's changed list: ${sweepCap.lines.join("\n")}`,
    );

    const statusCap = captureConsole();
    try {
      runAdmissionCli(["status", "--ledger", ledger]);
    } finally {
      statusCap.restore();
    }
    assert.match(statusCap.lines.join("\n"), /CAP_STATUS active=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 시험 2: 진짜 부재 좌석은 여전히 정상 회수된다(회귀 0).
// ---------------------------------------------------------------------------
test("HYK-317 §3-2: a genuinely absent seat is still recovered (no regression)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    cutover(ledger, lock);
    const admitCap = captureConsole();
    try {
      runAdmissionCli([
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        "HYK-317-dead-1",
        "--cap",
        "2",
        "--seat-key",
        REAL_PANE_KEY,
      ]);
    } finally {
      admitCap.restore();
    }
    // HYK-326: admitted_at을 과거로 고정 -- 발급->회수 간격이 0ms여도(같은
    // 밀리초여도) ageMs가 크게 양수이므로 회수가 시각 운에 좌우되지 않는다.
    rewindAdmittedAt(ledger, "HYK-317-dead-1", FAR_PAST_ADMITTED_AT);

    const sweepCap = captureConsole();
    let sweepExit;
    try {
      sweepExit = runAdmissionCli([
        "sweep",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        "[]",
        "--stale-after-ms",
        "0",
        "--recovery-grace-ms",
        "999999999",
      ]);
    } finally {
      sweepCap.restore();
    }
    assert.equal(sweepExit, 0);
    assert.match(
      sweepCap.lines.join("\n"),
      /\{"reservationId":"HYK-317-dead-1","from":"ACTIVE","to":"SUSPECT"\}/,
      `a genuinely absent seat must still be swept to SUSPECT: ${sweepCap.lines.join("\n")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 시험 3: handle 모양(`term_...`)이 섞인 --live-seats 목록은 거부된다
// (fail-closed, exit≠0 + 구체 사유). 오늘 밤 실사고(coder-task §1)의
// 정확한 입력 모양.
// ---------------------------------------------------------------------------
test("HYK-317 §3-3: --live-seats with a handle-shaped entry (term_...) is rejected, nonzero exit, reason printed", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    cutover(ledger, lock);
    const cap = captureConsole();
    let exit;
    try {
      exit = runAdmissionCli([
        "sweep",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        JSON.stringify([
          REAL_PANE_KEY,
          "term_c25c9441-8c69-4a8e-bb34-8566b7f85fe9",
        ]),
      ]);
    } finally {
      cap.restore();
    }
    assert.notEqual(exit, 0);
    assert.ok(
      cap.lines.some(
        (l) => l.includes("sweep:") && l.includes("handle-shaped entry"),
      ),
      `expected a specific handle-shape rejection reason, got: ${JSON.stringify(cap.lines)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 시험 4: 빈 목록·잘못된 JSON은 기존 동작을 그대로 유지한다(회귀 0).
// ---------------------------------------------------------------------------
test("HYK-317 §3-4: empty --live-seats and malformed JSON keep pre-existing behavior (no regression, 2/2)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    cutover(ledger, lock);

    const emptyCap = captureConsole();
    let emptyExit;
    try {
      emptyExit = runAdmissionCli([
        "sweep",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        "[]",
      ]);
    } finally {
      emptyCap.restore();
    }
    assert.equal(emptyExit, 0, "empty --live-seats must still succeed");
    assert.match(emptyCap.lines.join("\n"), /CAP_SWEPT/);

    const badJsonCap = captureConsole();
    let badJsonExit;
    try {
      badJsonExit = runAdmissionCli([
        "sweep",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        "not-json",
      ]);
    } finally {
      badJsonCap.restore();
    }
    assert.notEqual(badJsonExit, 0);
    assert.ok(
      badJsonCap.lines.some((l) =>
        l.includes("must be a JSON array of strings"),
      ),
      `malformed JSON must keep its pre-existing rejection reason: ${JSON.stringify(badJsonCap.lines)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 시험 5 (결함 재현 고정): 수리 전 방식(entry.handle 목록)으로 판정하면
// 살아있는 좌석이 SUSPECT로 오판된다는 것을 고정한다 -- judgeSweepTrigger가
// 다시 handle을 내보내도록 되돌려지면 이 시험의 첫 단언이 RED가 된다.
// ---------------------------------------------------------------------------
test("HYK-317 §3-5 (defect pin): judgeSweepTrigger's real (fixed) liveSeatKeys keep a live seat ACTIVE; the pre-fix handle-based list would have wrongly SUSPECTed it", () => {
  const terminalList = {
    ok: true,
    terminals: [
      {
        handle: "term_3321e179-357c-4de9-b9f9-f72e38d2d8fc",
        tabId: "b7011967-041a-45e4-843c-0cf8e2ccd418",
        leafId: "ecdf87c2-a552-4370-9ecf-98d455404f0a",
      },
    ],
  };
  const judged = judgeSweepTrigger({ terminalList });
  // ★수리 확증: 오늘의 judgeSweepTrigger는 paneKey를 낸다, handle이 아니다.
  assert.deepEqual(judged.liveSeatKeys, [REAL_PANE_KEY]);

  const admittedAt = "2026-08-20T00:00:00.000Z";
  const sweepNow = "2026-08-20T00:30:00.000Z"; // > admittedAt so ageMs > staleAfterMs=0
  let ledger = createEmptyLedger(admittedAt);
  const admitted = admitReservation(ledger, {
    reservationId: "HYK-317-defect-pin",
    cap: 1,
    now: admittedAt,
    role: "CODER",
    seatKey: REAL_PANE_KEY,
  });
  assert.equal(admitted.decision, "ADMITTED");
  ledger = admitted.ledger;

  // 수리된(오늘의) 판정: paneKey 목록을 쓰면 살아있는 좌석은 ACTIVE로 남는다.
  const sweptFixed = sweepAndRecover(ledger, {
    now: sweepNow,
    liveSeatKeys: judged.liveSeatKeys,
    staleAfterMs: 0,
    recoveryGraceMs: 999999999,
  });
  assert.equal(
    sweptFixed.changed.length,
    0,
    "fixed path: live seat stays ACTIVE (not swept)",
  );

  // 결함 재현: 수리 전 코드가 냈을 handle 목록을 손으로 만들어 같은 원장에
  // 먹이면(entry.handle 그대로) 원장의 paneKey seat_key와 형식이 달라
  // 절대 일치하지 않는다 -- 살아있는 좌석이 SUSPECT로 오판된다.
  const preFixHandleList = terminalList.terminals.map((t) => t.handle);
  const sweptPreFix = sweepAndRecover(ledger, {
    now: sweepNow,
    liveSeatKeys: preFixHandleList,
    staleAfterMs: 0,
    recoveryGraceMs: 999999999,
  });
  assert.deepEqual(sweptPreFix.changed, [
    { reservationId: "HYK-317-defect-pin", from: "ACTIVE", to: "SUSPECT" },
  ]);
});

// ---------------------------------------------------------------------------
// 시험 6 (HYK-326 coder-task §2-3): sweepActiveEntry의 `ageMs <= staleAfterMs`
// 경계를 코어 함수에 `now`를 직접 주어 못박는다 -- 경계값(ageMs==staleAfterMs)
// 은 회수 안 함, 경계+1(ageMs==staleAfterMs+1)은 SUSPECT. 나중에 누가 이
// 부등호를 바꾸면(C안) 조용히 통과하지 않고 RED가 나야 한다.
// ---------------------------------------------------------------------------
test("HYK-326 §2-3 (boundary pin): ageMs == staleAfterMs is NOT swept, ageMs == staleAfterMs + 1 IS swept", () => {
  const STALE_AFTER_MS = 5000;
  const ADMITTED_AT_MS = Date.parse("2023-01-01T00:00:00.000Z");
  const admittedAt = new Date(ADMITTED_AT_MS).toISOString();

  function buildLedgerWithOneActiveSeat(reservationId) {
    let ledger = createEmptyLedger(admittedAt);
    const admitted = admitReservation(ledger, {
      reservationId,
      cap: 1,
      now: admittedAt,
      role: "CODER",
      seatKey: REAL_PANE_KEY,
    });
    assert.equal(admitted.decision, "ADMITTED");
    return admitted.ledger;
  }

  // 경계값: ageMs === staleAfterMs -> 회수 안 함
  {
    const ledger = buildLedgerWithOneActiveSeat("HYK-326-boundary-eq");
    const nowAtBoundary = new Date(
      ADMITTED_AT_MS + STALE_AFTER_MS,
    ).toISOString();
    const swept = sweepAndRecover(ledger, {
      now: nowAtBoundary,
      liveSeatKeys: [],
      staleAfterMs: STALE_AFTER_MS,
      recoveryGraceMs: 999999999,
    });
    assert.equal(
      swept.changed.length,
      0,
      "ageMs == staleAfterMs must NOT be swept (product-intended boundary)",
    );
  }

  // 경계+1: ageMs === staleAfterMs + 1 -> SUSPECT로 회수
  {
    const ledger = buildLedgerWithOneActiveSeat("HYK-326-boundary-plus1");
    const nowPastBoundary = new Date(
      ADMITTED_AT_MS + STALE_AFTER_MS + 1,
    ).toISOString();
    const swept = sweepAndRecover(ledger, {
      now: nowPastBoundary,
      liveSeatKeys: [],
      staleAfterMs: STALE_AFTER_MS,
      recoveryGraceMs: 999999999,
    });
    assert.deepEqual(swept.changed, [
      {
        reservationId: "HYK-326-boundary-plus1",
        from: "ACTIVE",
        to: "SUSPECT",
      },
    ]);
  }
});
