import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayStep, STAGE, STATUS, READINESS_STATUS } from "./relay-core.mjs";
import {
  ensureSeat,
  deliverTask,
  WORKSPACES_ROOT,
} from "./adapters/orca-adapter.mjs";
import { observeSeatCandidates } from "./adapters/seat-candidate-adapter.mjs";

// HYK-169-coder-1: G10 -- fake 어댑터만으로 코어 전 경로(성공·좌석 실패·
// 태스크 파일 미드롭·배달 실패·핸드셰이크 대기/완료/config 오류)를 검증한다.
// 이 파일 어디에도 특정 오케스트레이션 CLI 이름이 등장하지 않는다(아래
// G9 자기 테스트가 이 파일 자신도 스캔한다) -- Orca가 완전히 꺼져 있어도
// green이어야 한다(G10). checkRelayHandshake는 실제 파일을 읽는 계약이라
// (fs 주입 지점이 없음, 재구현 금지 원칙상 새로 만들지 않음) 각 테스트는
// 임시 디렉터리에 진짜 task/result 파일을 만들어 판정 경로를 실측한다.

// HYK-171-cycle4a2-1: 정규화 후보 shape(seat-candidate-adapter.mjs
// normalizeSeatCandidate 출력)을 그대로 흉내낸다 -- 이 파일이 직접
// classify/capabilities를 재구현하지 않는다(4a-1 코어는 이 shape만 소비).
function readyCandidate(handle = "term_fake") {
  return {
    schemaVersion: 1,
    handle,
    state: "idle-or-ready",
    occupied: false,
    observable: true,
  };
}
// 기본 fake는 항상 READY 후보 1개를 관측한 것으로 응답한다 -- 그래야 4a-2
// 이전부터 있던(seat/deliver 경로만 검증하는) 기존 시험들이 새 readiness
// 게이트에 가로막히지 않고 회귀 0을 유지한다. 게이트 자체를 검증하는
// 시험은 overrides.observeSeatCandidates로 다른 관측을 주입한다.
function fakeAdapter(overrides = {}) {
  return {
    ensureSeat:
      overrides.ensureSeat ??
      (() => ({ ok: true, seatHandle: "term_fake", created: true })),
    observeSeatCandidates:
      overrides.observeSeatCandidates ?? (() => [readyCandidate()]),
    deliverTask:
      overrides.deliverTask ??
      (() => ({ ok: true, runtimeTaskId: "task_fake" })),
    collectCompletionSignals:
      overrides.collectCompletionSignals ?? (() => ({ ok: true, signals: [] })),
    teardownSeat: overrides.teardownSeat ?? (() => ({ ok: true })),
  };
}

function makeHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk169-relay-core-"));
}

// HYK-170 사이클2 ②-a coder-1 (D8): mainRepoDir 역할의 별도 임시 디렉터리 --
// harnessDir(대상 워크트리 쪽)와 물리적으로 분리된 원본 위치를 흉내낸다.
function makeMainRepoDir() {
  return mkdtempSync(join(tmpdir(), "hyk170-relay-core-main-"));
}

// D8 반사실: 원본(source) 빌더는 dropTaskFile과 **의도적으로 별개**다 --
// 같은 함수로 원본과 기대값을 둘 다 만들면 자기대조 헛통과가 된다(pm-2
// §S2Δ "같은 fixture builder로 원본/기대 생성 금지").
function writeSourceTaskFile(mainRepoDir, rolePrefix, body) {
  mkdirSync(join(mainRepoDir, ".harness"), { recursive: true });
  writeFileSync(
    join(mainRepoDir, ".harness", `${rolePrefix}-task.md`),
    body,
    "utf8",
  );
}

// coder-2 (review-3 결함1 수리): mainRepoDir가 이제 모든 경로에 필요하다
// (존재-only 폴백 제거) -- G10 파이프라인 시험은 D8 자기대조 반사실의
// 대상이 아니므로(그건 위 D8 전용 시험만 해당), dropTaskFile과 같은
// 포맷으로 마련해도 무방하다. 반환된 mainRepoDir는 호출자가 harnessDir와
// 함께 정리해야 한다.
function makeTaskFileSource(
  rolePrefix,
  { taskId = "HYK-x", droppedAt = "2026-07-22 07:05" } = {},
) {
  const mainRepoDir = makeMainRepoDir();
  writeSourceTaskFile(
    mainRepoDir,
    rolePrefix,
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n\nbody\n`,
  );
  return mainRepoDir;
}

function dropTaskFile(
  harnessDir,
  rolePrefix,
  { taskId = "HYK-x", droppedAt = "2026-07-22 07:05" } = {},
) {
  writeFileSync(
    join(harnessDir, `${rolePrefix}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n\nbody\n`,
    "utf8",
  );
}

function dropResultFile(
  harnessDir,
  rolePrefix,
  { taskId = "HYK-x", doneAt = "2026-07-22 08:00:00" } = {},
) {
  writeFileSync(
    join(harnessDir, `${rolePrefix}.md`),
    `task_id: ${taskId}\n\nsummary\n\n>>> DONE: CODER @ ${doneAt} KST\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// G10: fake 어댑터 전 경로.
// ---------------------------------------------------------------------------
test("G10: already-done short-circuit -- handshake already ok on entry skips seat/deliver entirely (idempotent)", () => {
  const harnessDir = makeHarnessDir();
  try {
    dropTaskFile(harnessDir, "coder");
    dropResultFile(harnessDir, "coder");
    let seatCalled = false;
    let deliverCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true, seatHandle: "term_fake" };
      },
      deliverTask: () => {
        deliverCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.ALREADY_DONE);
    assert.equal(seatCalled, false);
    assert.equal(deliverCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: full success path -- seat ok, task file present, deliver ok, handshake completes after delivery -> already-done", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const adapter = fakeAdapter({
      deliverTask: () => {
        // simulate the worker finishing synchronously with the delivery call
        dropResultFile(harnessDir, "coder");
        return { ok: true, runtimeTaskId: "task_fake" };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.ALREADY_DONE);
    assert.equal(r.handshake.ok, true);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("HYK-171 사이클4b-2a §2-D: relayStep never calls adapter.teardownSeat -- production 결선 0 회귀 고정 (teardownSeat 호출 시 즉시 throw하는 fake로 감시)", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const adapter = fakeAdapter({
      deliverTask: () => {
        dropResultFile(harnessDir, "coder");
        return { ok: true, runtimeTaskId: "task_fake" };
      },
      teardownSeat: () => {
        throw new Error(
          "relayStep must never call adapter.teardownSeat (production 결선 0)",
        );
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.ALREADY_DONE);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("G10: delivered-pending -- deliver succeeds but the worker hasn't produced a result file yet", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const adapter = fakeAdapter();
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.DELIVERED_PENDING);
    assert.equal(r.handshake.ok, false);
    assert.match(r.handshake.reason, /result file not found/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// HYK-170 사이클2 ②-a coder-1 (D8): task-file 배치·재검증이 이제 seat
// 단계보다 먼저 실행되므로(pm-2 §S2Δ -- "seat launch/delivery가 진행되게
// 한다"), 이 시험은 seat 실패가 STAGE.SEAT로 표면화되는 것을 확인하려면
// task-file 단계를 먼저 통과시켜야 한다(파일을 미리 드롭).
test("G10: adapter.ensureSeat failure stops before any deliver check (task file already placed)", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    let deliverCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => ({ ok: false, reason: "seat create failed" }),
      deliverTask: () => {
        deliverCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.SEAT);
    assert.equal(deliverCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("G10: task file not dropped stops before deliver is called (real fs, file genuinely absent)", () => {
  const harnessDir = makeHarnessDir();
  try {
    let deliverCalled = false;
    const adapter = fakeAdapter({
      deliverTask: () => {
        deliverCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.TASK_FILE);
    assert.equal(deliverCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: deliverTask failure is surfaced as a deliver-stage failure", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const adapter = fakeAdapter({
      deliverTask: () => ({
        ok: false,
        reason: "dispatch failed: no such seat",
      }),
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.DELIVER);
    assert.match(r.reason, /dispatch failed/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("G10: dropped_at missing (config error) classifies as delivered-config-error, not pending", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeMainRepoDir();
  try {
    // Both files must exist and echo matching task_id -- checkRelayHandshake
    // only reaches the dropped_at check after the result-file-exists and
    // task_id-echo checks pass, so a missing result file would (correctly)
    // classify as pending first, masking the config error this test targets.
    // Written as the *source* (mainRepoDir) so D8's placement copies it
    // verbatim into harnessDir -- placeAndVerifyTaskFile itself only checks
    // task_id, not dropped_at (that belongs to checkRelayHandshake, later).
    writeSourceTaskFile(
      mainRepoDir,
      "coder",
      "task_id: HYK-x\n\nno dropped_at header\n",
    );
    dropResultFile(harnessDir, "coder");
    const adapter = fakeAdapter();
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.DELIVERED_CONFIG_ERROR);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("G10: role prefix is lowercased consistently with checkRelayHandshake's <role>-task.md convention (REVIEW)", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("review");
  try {
    const adapter = fakeAdapter();
    const r = relayStep(
      {
        role: "REVIEW",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.DELIVERED_PENDING);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("G10: missing adapter.ensureSeat is a config-shape failure, not a crash (task file already placed)", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      {},
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.SEAT);
    assert.match(r.reason, /ensureSeat/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// HYK-170 사이클2 A-2: 코어가 deliverTask에 넘기는 ctx에 seatHandle이 없다
// -- worktreePath만 있다(어댑터가 그 자리에서 A-1로 스스로 해석한다).
test("A2: relay-core -- the ctx handed to adapter.deliverTask carries worktreePath, never seatHandle", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    let capturedCtx = null;
    const adapter = fakeAdapter({
      deliverTask: (ctx) => {
        capturedCtx = ctx;
        return { ok: true };
      },
    });
    relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.ok(capturedCtx);
    assert.equal("seatHandle" in capturedCtx, false);
    assert.equal(capturedCtx.worktreePath, "/wt");
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// HYK-170 사이클2 coder-2 (review-1 실결함 수리): 코어는 어댑터가 A-2를
// 지키는지에 기대지 않고 자기 공개 반환 봉투에서 handle류 필드를 스스로
// 제거해야 한다. 이 시험은 **비협조(non-conforming) fake ensureSeat**
// (seatHandle을 strip하지 않고 그대로 반환)를 주입해도 relayStep의 공개
// 반환 전체에 seatHandle/handle류 값이 없는지 재귀적으로 확인한다 --
// REVIEW가 review-1에서 실측한 바로 그 반사실을 시험으로 고정한다.
function containsHandleLeak(value, needle) {
  if (value == null) return false;
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value))
    return value.some((v) => containsHandleLeak(v, needle));
  if (typeof value === "object") {
    return Object.entries(value).some(
      ([key, v]) => /handle/i.test(key) || containsHandleLeak(v, needle),
    );
  }
  return false;
}

test("A2 (coder-2): relayStep's public return never leaks seatHandle even when adapter.ensureSeat is non-conforming (does not strip it itself)", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const nonConformingAdapter = fakeAdapter({
      ensureSeat: () => ({ ok: true, seatHandle: "term_probe", created: true }),
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      nonConformingAdapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(
      containsHandleLeak(r, "term_probe"),
      false,
      "relayStep's public return must not leak seatHandle/handle-like fields regardless of adapter conformance",
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("G10: missing adapter.deliverTask after a successful seat is a config-shape failure, not a crash", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const adapter = {
      ensureSeat: () => ({ ok: true, seatHandle: "term_x" }),
      observeSeatCandidates: () => [readyCandidate()],
    };
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.DELIVER);
    assert.match(r.reason, /deliverTask/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D8 (HYK-170 사이클2 ②-a coder-1, pm-2 §S2Δ): task_id+내용 결속 배치·재검증.
// "목적 파일 존재"만 확인하던 이전 검사를 대체한다 -- mainRepoDir가 주어지면
// 원본 task_id 결속 확인 -> 대상 워크트리로 복사 -> 복사본 재검증까지 코드가
// 직접 확인한 뒤에만 seat/deliver로 진행한다.
// ---------------------------------------------------------------------------
test("D8: mainRepoDir given -- source task file is placed into the worktree harnessDir byte-for-byte, and seat runs only after that", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeMainRepoDir();
  try {
    writeSourceTaskFile(
      mainRepoDir,
      "coder",
      "task_id: HYK-170-coder-1\ndropped_at: 2026-07-23 04:55 KST\n\nbody text here\n",
    );
    let seatCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true, seatHandle: "term_fake" };
      },
    });
    relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-170-coder-1",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(seatCalled, true);
    assert.equal(
      readFileSync(join(harnessDir, "coder-task.md"), "utf8"),
      readFileSync(join(mainRepoDir, ".harness", "coder-task.md"), "utf8"),
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("D8: source missing -- TASK_FILE stage fails, seat never runs (side effect 0)", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeMainRepoDir(); // .harness never created -- no source at all
  try {
    let seatCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-170-coder-1",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.TASK_FILE);
    assert.equal(seatCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("D8: source task_id mismatch (stale/wrong file) -- TASK_FILE stage fails, no copy attempted, seat never runs", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeMainRepoDir();
  try {
    writeSourceTaskFile(
      mainRepoDir,
      "coder",
      "task_id: HYK-OTHER-1\ndropped_at: 2026-07-23 04:55 KST\n\nbody\n",
    );
    let seatCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-170-coder-1",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.TASK_FILE);
    assert.match(r.reason, /task_id mismatch/);
    assert.equal(seatCalled, false);
    assert.equal(existsSync(join(harnessDir, "coder-task.md")), false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// mutation-kill: "복사 후 존재만 확인"(sourceContent를 신뢰하고 destContent를
// 다시 읽지 않는 구현)으로 되돌리면 이 시험은 RED여야 한다 -- copyFileFn을
// 오염시켜 destContent가 실제로 sourceContent와 달라지게 만든다.
test("D8: mutation-kill -- a corrupted copy (copyFileFn writes different bytes than the source) is caught by re-reading the destination, not by trusting the in-memory source content", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeMainRepoDir();
  try {
    writeSourceTaskFile(
      mainRepoDir,
      "coder",
      "task_id: HYK-170-coder-1\ndropped_at: 2026-07-23 04:55 KST\n\noriginal body\n",
    );
    let seatCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-170-coder-1",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {
        copyFileFn: (_src, dst) =>
          writeFileSync(dst, "task_id: HYK-170-coder-1\n\ncorrupted\n", "utf8"),
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.TASK_FILE);
    assert.match(r.reason, /content mismatch/);
    assert.equal(seatCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// mutation-kill: destination task_id가 복사 과정에서 뒤바뀌었는데도(예:
// 다른 task의 잔여 파일이 남아 있다가 부분적으로만 덮어써진 경우) content
// 비교만으로 못 잡는 변형까지 task_id 재검증이 잡는지 확인한다.
test("D8: mutation-kill -- destination task_id no longer matches expected after copy is caught, not just 'destination file exists'", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeMainRepoDir();
  try {
    writeSourceTaskFile(
      mainRepoDir,
      "coder",
      "task_id: HYK-170-coder-1\ndropped_at: 2026-07-23 04:55 KST\n\nbody\n",
    );
    let seatCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-170-coder-1",
        harnessDir,
        mainRepoDir,
      },
      adapter,
      {
        copyFileFn: (src, dst) => {
          const content = readFileSync(src, "utf8");
          writeFileSync(
            dst,
            content.replace("HYK-170-coder-1", "HYK-170-coder-9"),
            "utf8",
          );
        },
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.TASK_FILE);
    assert.equal(seatCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// HYK-170 사이클2 ②-a coder-2 (review-3 실결함1 수리): 이전엔 mainRepoDir
// 미제공 시 "존재만 확인하고 통과"하는 호환 경로가 있어, destPath에 이미
// 잘못된 task_id·오염된 본문이 있어도(review-3의 정확한 재현) 그대로
// seat/deliver로 진행시켰다. 이제는 원본을 특정할 수 없으면(=바이트 단위
// 재검증이 애초에 불가능하면) 무조건 fail-closed다 -- destPath에 뭐가
//있든 상관없다.
test("D8 coder-2 (review-3 결함1 수리): mainRepoDir not provided -- fail-closed even though the destination already has a wrong task_id + corrupted body (existence-only compatibility path removed)", () => {
  const harnessDir = makeHarnessDir();
  try {
    // exact review-3 repro: a stale/wrong file already sitting at the
    // destination, no mainRepoDir to verify it against.
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      "task_id: HYK-WRONG\ndropped_at: 2026-07-22 07:05 KST\n\ncorrupted body\n",
      "utf8",
    );
    let seatCalled = false;
    let deliverCalled = false;
    const adapter = fakeAdapter({
      ensureSeat: () => {
        seatCalled = true;
        return { ok: true };
      },
      deliverTask: () => {
        deliverCalled = true;
        return { ok: true };
      },
    });
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: "/wt",
        taskId: "HYK-170-coder-2",
        harnessDir,
      },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.TASK_FILE);
    assert.equal(seatCalled, false);
    assert.equal(deliverCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-171-cycle4a2-1: readiness 게이트 -- §5 mutation 원장. 위 G10 시험과
// 달리 fake 어댑터가 아니라 **프로덕션 결선**(run-step.mjs의 ORCA_ADAPTER와
// 동형: 실 ensureSeat/observeSeatCandidates/deliverTask, fake execFn만
// 주입)으로 relayStep을 구동한다 -- 게이트가 실 sink의 인과 경로에 실제로
// 걸리는지(helper-only 아님) 증명하려면 fake 어댑터의 "그렇다고 치자"가
// 아니라 진짜 배달 함수가 필요하다(coder-task.md §2 fixtures 지시).
// ---------------------------------------------------------------------------
const READINESS_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-relay-core-readiness-fixture`;
const READINESS_ADAPTER = { ensureSeat, observeSeatCandidates, deliverTask };

// 최소 classify capability -- 실 vendor 마커가 아니라 이 시험 전용 합성
// tail 문자열(IDLE/BUSY/SHELL/STARTING)만 인식한다(reference detector는
// 여전히 opt-in 미검증이라 여기서 재사용하지 않는다, seat-candidate-adapter
// 헤더 주석 계승).
function classifyReadinessTail(tail) {
  if (tail === "IDLE") return "idle";
  if (tail === "BUSY") return "busy";
  if (tail === "SHELL") return "shell";
  if (tail === "STARTING") return "starting";
  return null;
}
const READINESS_CAPS = { classify: classifyReadinessTail };

// orca-adapter.test.mjs의 fakeExecFn(argv[1] 키 기반 stub lookup)과 동형이지만
// 이 파일은 그 파일의 내부 헬퍼를 import하지 않는다(각 테스트 파일 자기완결
// 관행 계승) -- 이 readiness 시험 범위(terminal list/show, task-create,
// dispatch 4종)만 다루는 축소판이다.
function readinessFakeExecFn(responses) {
  const calls = [];
  function fn(argv) {
    calls.push(argv);
    const key = argv[1];
    const entry = responses[key];
    if (typeof entry === "function") return entry(argv, calls.length);
    if (entry === undefined) {
      throw new Error(
        `readinessFakeExecFn: no stub for '${key}' (argv=${JSON.stringify(argv)})`,
      );
    }
    return entry;
  }
  fn.calls = calls;
  return fn;
}

function staticListResponse(handles) {
  return {
    ok: true,
    result: {
      terminals: handles.map((h) => ({
        handle: h,
        worktreePath: READINESS_WORKTREE,
        tabId: `tab-${h}`,
      })),
    },
  };
}

function showByHandle(previewByHandle) {
  return (argv) => {
    const handle = argv[argv.indexOf("--terminal") + 1];
    return {
      ok: true,
      result: { terminal: { preview: previewByHandle[handle] ?? "" } },
    };
  };
}

function callsMatching(execFn, predicate) {
  return execFn.calls.filter(predicate);
}
function sinkCallCounts(execFn) {
  return {
    taskCreate: callsMatching(execFn, (a) => a[1] === "task-create").length,
    dispatch: callsMatching(execFn, (a) => a[1] === "dispatch").length,
    text: callsMatching(execFn, (a) => a.includes("--text")).length,
    enter: callsMatching(execFn, (a) => a.includes("--enter")).length,
  };
}

function runReadinessRelayStep(execFn, opts = {}) {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("coder");
  try {
    const r = relayStep(
      {
        role: "CODER",
        worktreePath: READINESS_WORKTREE,
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      READINESS_ADAPTER,
      {
        execFn,
        capabilities: READINESS_CAPS,
        // ensureSeat/deliverTask's own handle resolution is a separate,
        // already-tested concern (orca-adapter.test.mjs) -- default-bypass
        // it here via the documented test-only override so these fixtures
        // only need to stub terminal list/show + task-create/dispatch, not
        // also `worktree list` (checkWorktreeManaged). Individual tests
        // override this value when the override itself is what's under test
        // (§5-8).
        existingSeatHandle: "term_seat_reuse",
        ...opts,
      },
    );
    return r;
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
}

// mutation 1 (가장 중요): 게이트 통과조건을 완화(READY≠)해 NOT_READY에서도
// deliverTask가 불리면 이 시험은 sink 호출 > 0을 잡아 RED가 된다.
test("§5-1/2: NOT_READY (no idle candidates, all shell) -- deliverTask/task-create/dispatch/text/Enter are exactly 0", () => {
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_dead"]),
    show: showByHandle({ term_dead: "SHELL" }),
  });
  const r = runReadinessRelayStep(execFn);
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.READINESS);
  assert.equal(r.readinessStatus, READINESS_STATUS.NOT_READY);
  const counts = sinkCallCounts(execFn);
  assert.deepEqual(counts, { taskCreate: 0, dispatch: 0, text: 0, enter: 0 });
});

// mutation 3: AMBIGUOUS(2개 idle)/UNOBSERVABLE(분류 불가 후보) 둘 다
// fail-open 없이 sink 0.
test("§5-3: AMBIGUOUS (2 idle candidates) -- deliverTask is never called", () => {
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_a", "term_b"]),
    show: showByHandle({ term_a: "IDLE", term_b: "IDLE" }),
  });
  const r = runReadinessRelayStep(execFn);
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.READINESS);
  assert.equal(r.readinessStatus, READINESS_STATUS.AMBIGUOUS);
  assert.equal(sinkCallCounts(execFn).taskCreate, 0);
  assert.equal(sinkCallCounts(execFn).dispatch, 0);
});

test("§5-3: UNOBSERVABLE (candidate classify returns unrecognized tail) -- deliverTask is never called", () => {
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_weird"]),
    show: showByHandle({ term_weird: "???" }),
  });
  const r = runReadinessRelayStep(execFn);
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.READINESS);
  assert.equal(r.readinessStatus, READINESS_STATUS.UNOBSERVABLE);
  assert.equal(sinkCallCounts(execFn).taskCreate, 0);
  assert.equal(sinkCallCounts(execFn).dispatch, 0);
});

// mutation 4: paired-good -- 정확히 1개(exact-count, 상회/하회 둘 다 RED).
test("§5-4: READY (exactly one idle candidate, paired-good) -- deliverTask(sink) is called exactly once", () => {
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_ready"]),
    show: showByHandle({ term_ready: "IDLE" }),
    "task-create": { ok: true, result: { task: { id: "task_rt" } } },
    dispatch: { ok: true },
  });
  const r = runReadinessRelayStep(execFn, { existingSeatHandle: "term_ready" });
  assert.equal(r.ok, true);
  const counts = sinkCallCounts(execFn);
  assert.equal(counts.taskCreate, 1);
  assert.equal(counts.dispatch, 1);
});

// mutation 5 (vacuity 봉인 핵심): 위 §5-1 NOT_READY 픽스처의 sink 호출 0이
// "게이트가 막아서"가 아니라 "deliverTask가 어차피 실패해서" 우연히
// 그런 건 아닌지 반증한다 -- 같은 execFn/opts로 deliverTask를 **직접**
// 불러 실제로 성공(sink 실행)함을 보인다. 이게 성립해야 위 시험의 sink=0이
// 게이트의 실제 인과 효과라고 주장할 수 있다(relayStep에서 게이트 stage를
// 빼거나 결과를 무시하면 이 시험 세트 전체가 sink>0으로 뒤집힌다).
test("§5-5: the NOT_READY fixture's deliverTask would succeed if actually invoked -- proves the zero-sink result above is real gating, not an incidental deliverTask failure", () => {
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_dead"]),
    show: showByHandle({ term_dead: "SHELL" }),
    "task-create": { ok: true, result: { task: { id: "task_rt" } } },
    dispatch: { ok: true },
  });
  const gated = runReadinessRelayStep(execFn, {
    existingSeatHandle: "term_ready",
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.stage, STAGE.READINESS);
  assert.equal(sinkCallCounts(execFn).taskCreate, 0);

  const direct = deliverTask(
    { taskId: "HYK-x", role: "CODER", worktreePath: READINESS_WORKTREE },
    { execFn, existingSeatHandle: "term_ready" },
  );
  assert.equal(direct.ok, true);
  assert.equal(sinkCallCounts(execFn).taskCreate, 1);
});

// HYK-376-paste-hook-seam-1 (완료 조건 1 -- runDeliverStage 경로 실증):
// runDeliverStage(relay-core.mjs)는 relayStep의 세 번째 인자 opts를
// **그대로** `adapter.deliverTask(ctx, opts)`에 넘긴다(필터링 0) --
// 그래서 이 경로의 안전은 전적으로 `adapter.deliverTask`가 REVIEW_ADAPTER
// 위에서 바로 그 production export(orca-adapter.mjs의 `deliverTask`, 위
// §5-5가 이미 "fake가 아니라 진짜"임을 증명한 그 결선)라는 데서 나온다.
// 이 시험은 role: "REVIEW"(codex 엔진)로 relayStep을 직접 구동해 --
// 화면에 마커가 없고 화면 밖 축도 성립하지 않는 픽스처 위에서 --
// `opts.confirmPastedFn: () => true`를 얹어도 여전히 배달이
// PASTE_UNCONFIRMED로 거부됨을 본다. ★되돌림 변이(runDeliverStage가
// confirmPastedFn 자리를 다시 살리거나, orca-adapter.mjs의
// stripConfirmPastedFn 호출이 빠지면) 이 시험은 ok:true·Enter 1회를
// 관측해 즉시 빨간불이 된다.
test("HYK-376: relayStep -> runDeliverStage -> production deliverTask (REVIEW/codex) -- a caller-supplied opts.confirmPastedFn is structurally unreachable; no screen marker + no off-screen match still yields PASTE_UNCONFIRMED, zero Enter calls", () => {
  const harnessDir = makeHarnessDir();
  const mainRepoDir = makeTaskFileSource("review");
  try {
    const execFn = readinessFakeExecFn({
      list: staticListResponse(["term_ready"]),
      // Same static preview services both readiness classification (tail)
      // and confirmCodexStagingViaTerminalShow's marker check -- "IDLE"
      // satisfies the former and (deliberately) contains no task marker,
      // so the screen axis alone would already refuse without the hook.
      show: showByHandle({ term_ready: "IDLE" }),
      "task-create": { ok: true, result: { task: { id: "task_rt" } } },
      dispatch: { ok: true },
      send: { ok: true }, // no result.send -> off-screen axis FIELD_ABSENT (fail-closed)
    });
    const r = relayStep(
      {
        role: "REVIEW",
        worktreePath: READINESS_WORKTREE,
        taskId: "HYK-x",
        harnessDir,
        mainRepoDir,
      },
      READINESS_ADAPTER,
      {
        execFn,
        capabilities: READINESS_CAPS,
        existingSeatHandle: "term_ready",
        confirmPastedFn: () => true,
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.DELIVER);
    assert.match(r.reason, /PASTE_UNCONFIRMED/);
    assert.equal(sinkCallCounts(execFn).enter, 0);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

// mutation 6 (TOCTOU, PM Q2): READY 관측 직후 deliver 직전 재관측에서 후보
// 세대가 바뀌면(새 후보 등장 -> AMBIGUOUS) 이전 READY를 폐기하고 sink 0.
test("§5-6: TOCTOU -- readiness flips from READY to AMBIGUOUS between the initial observation and the pre-deliver recheck -- previous READY is discarded, sink 0", () => {
  let listCalls = 0;
  const execFn = readinessFakeExecFn({
    list: () => {
      listCalls += 1;
      return listCalls === 1
        ? staticListResponse(["term_ready"])
        : staticListResponse(["term_ready", "term_new"]);
    },
    show: showByHandle({ term_ready: "IDLE", term_new: "IDLE" }),
    "task-create": { ok: true, result: { task: { id: "task_rt" } } },
    dispatch: { ok: true },
  });
  const r = runReadinessRelayStep(execFn, { existingSeatHandle: "term_ready" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.READINESS);
  assert.equal(r.readinessStatus, READINESS_STATUS.AMBIGUOUS);
  assert.equal(
    listCalls,
    2,
    "expected exactly one initial observation + one TOCTOU recheck",
  );
  assert.equal(sinkCallCounts(execFn).taskCreate, 0);
  assert.equal(sinkCallCounts(execFn).dispatch, 0);
});

// mutation 7 (bounded poll): starting -> ready 세대는 poll로 잡히면 sink 1,
// deadline까지 starting을 못 벗어나면 NOT_READY_TIMEOUT·sink 0(무한 재시도
// 금지 -- waitFn 호출 횟수로 시도 수도 함께 확인).
test("§5-7: bounded poll -- starting resolves to ready within the attempt budget -> deliverTask(sink) called exactly once", () => {
  const waits = [];
  // show reacts to *when* it's called: starting on the first observation,
  // idle from the second call onward (poll retry + the TOCTOU recheck both
  // see idle -- a real "starting -> ready" seat generation).
  let showCalls = 0;
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_boot"]),
    show: () => {
      showCalls += 1;
      return {
        ok: true,
        result: {
          terminal: { preview: showCalls === 1 ? "STARTING" : "IDLE" },
        },
      };
    },
    "task-create": { ok: true, result: { task: { id: "task_rt" } } },
    dispatch: { ok: true },
  });
  const r = runReadinessRelayStep(execFn, {
    existingSeatHandle: "term_boot",
    readinessMaxAttempts: 3,
    readinessWaitFn: (attempt) => waits.push(attempt),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(waits, [1]);
  assert.equal(sinkCallCounts(execFn).taskCreate, 1);
  assert.equal(sinkCallCounts(execFn).dispatch, 1);
});

test("§5-7: bounded poll -- starting never resolves within the attempt budget -> NOT_READY_TIMEOUT, sink 0, no unbounded retry", () => {
  const waits = [];
  const execFn = readinessFakeExecFn({
    list: staticListResponse(["term_boot"]),
    show: () => ({ ok: true, result: { terminal: { preview: "STARTING" } } }),
  });
  const r = runReadinessRelayStep(execFn, {
    existingSeatHandle: "term_boot",
    readinessMaxAttempts: 3,
    readinessWaitFn: (attempt) => waits.push(attempt),
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.READINESS);
  assert.equal(r.readinessStatus, READINESS_STATUS.NOT_READY_TIMEOUT);
  assert.deepEqual(waits, [1, 2]);
  assert.equal(sinkCallCounts(execFn).taskCreate, 0);
});

// mutation 8: opts.existingSeatHandle(테스트/override 전용 경로)이 실
// 후보 목록에 없는 stale handle이어도, readiness 게이트 자신은 그 override를
// 절대 참조하지 않고 매번 현재 후보를 재관측한다 -- 우회 불가.
test("§5-8: a stale existingSeatHandle override cannot bypass the readiness gate -- the gate always re-observes real candidates", () => {
  const execFn = readinessFakeExecFn({
    list: staticListResponse([]),
    show: () => {
      throw new Error("show should not be called -- no candidates to show");
    },
  });
  const r = runReadinessRelayStep(execFn, {
    existingSeatHandle: "term_stale_dead",
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.READINESS);
  assert.equal(r.readinessStatus, READINESS_STATUS.UNOBSERVABLE);
  assert.equal(sinkCallCounts(execFn).taskCreate, 0);
});

// ---------------------------------------------------------------------------
// G9: 특정 오케스트레이션 CLI 이름/문자열이 이 파일(relay-core.mjs)과 이
// 테스트 파일 자신 어디에도 없다(주석 포함) -- relay-core는 어댑터 포트만
// 호출하는 완전 엔진-무관 코어라는 설계 계약의 자기 검증.
// ---------------------------------------------------------------------------
test("G9: relay-core.mjs source contains no 'orca' substring anywhere (comments included)", () => {
  const src = readFileSync(
    new URL("./relay-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    /orca/i.test(src),
    false,
    "relay-core.mjs must not reference the orchestration CLI by name -- it only calls adapter ports",
  );
});
