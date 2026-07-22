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
import { relayStep, STAGE, STATUS } from "./relay-core.mjs";

// HYK-169-coder-1: G10 -- fake 어댑터만으로 코어 전 경로(성공·좌석 실패·
// 태스크 파일 미드롭·배달 실패·핸드셰이크 대기/완료/config 오류)를 검증한다.
// 이 파일 어디에도 특정 오케스트레이션 CLI 이름이 등장하지 않는다(아래
// G9 자기 테스트가 이 파일 자신도 스캔한다) -- Orca가 완전히 꺼져 있어도
// green이어야 한다(G10). checkRelayHandshake는 실제 파일을 읽는 계약이라
// (fs 주입 지점이 없음, 재구현 금지 원칙상 새로 만들지 않음) 각 테스트는
// 임시 디렉터리에 진짜 task/result 파일을 만들어 판정 경로를 실측한다.

function fakeAdapter(overrides = {}) {
  return {
    ensureSeat:
      overrides.ensureSeat ??
      (() => ({ ok: true, seatHandle: "term_fake", created: true })),
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
  { taskId = "HYK-x", doneAt = "2026-07-22 08:00" } = {},
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
    const adapter = { ensureSeat: () => ({ ok: true, seatHandle: "term_x" }) };
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
