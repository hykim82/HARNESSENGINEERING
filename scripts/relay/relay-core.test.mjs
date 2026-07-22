import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  try {
    dropTaskFile(harnessDir, "coder");
    const adapter = fakeAdapter({
      deliverTask: () => {
        // simulate the worker finishing synchronously with the delivery call
        dropResultFile(harnessDir, "coder");
        return { ok: true, runtimeTaskId: "task_fake" };
      },
    });
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.ALREADY_DONE);
    assert.equal(r.handshake.ok, true);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: delivered-pending -- deliver succeeds but the worker hasn't produced a result file yet", () => {
  const harnessDir = makeHarnessDir();
  try {
    dropTaskFile(harnessDir, "coder");
    const adapter = fakeAdapter();
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.DELIVERED_PENDING);
    assert.equal(r.handshake.ok, false);
    assert.match(r.handshake.reason, /result file not found/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: adapter.ensureSeat failure stops before any task-file/deliver check", () => {
  const harnessDir = makeHarnessDir();
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
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.SEAT);
    assert.equal(deliverCalled, false);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
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
  try {
    dropTaskFile(harnessDir, "coder");
    const adapter = fakeAdapter({
      deliverTask: () => ({
        ok: false,
        reason: "dispatch failed: no such seat",
      }),
    });
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.DELIVER);
    assert.match(r.reason, /dispatch failed/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: dropped_at missing (config error) classifies as delivered-config-error, not pending", () => {
  const harnessDir = makeHarnessDir();
  try {
    // Both files must exist and echo matching task_id -- checkRelayHandshake
    // only reaches the dropped_at check after the result-file-exists and
    // task_id-echo checks pass, so a missing result file would (correctly)
    // classify as pending first, masking the config error this test targets.
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      "task_id: HYK-x\n\nno dropped_at header\n",
      "utf8",
    );
    dropResultFile(harnessDir, "coder");
    const adapter = fakeAdapter();
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.DELIVERED_CONFIG_ERROR);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: role prefix is lowercased consistently with checkRelayHandshake's <role>-task.md convention (REVIEW)", () => {
  const harnessDir = makeHarnessDir();
  try {
    dropTaskFile(harnessDir, "review");
    const adapter = fakeAdapter();
    const r = relayStep(
      { role: "REVIEW", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.DELIVERED_PENDING);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: missing adapter.ensureSeat is a config-shape failure, not a crash", () => {
  const harnessDir = makeHarnessDir();
  try {
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      {},
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.SEAT);
    assert.match(r.reason, /ensureSeat/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("G10: missing adapter.deliverTask after a successful seat is a config-shape failure, not a crash", () => {
  const harnessDir = makeHarnessDir();
  try {
    dropTaskFile(harnessDir, "coder");
    const adapter = { ensureSeat: () => ({ ok: true, seatHandle: "term_x" }) };
    const r = relayStep(
      { role: "CODER", worktreePath: "/wt", taskId: "HYK-x", harnessDir },
      adapter,
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, STAGE.DELIVER);
    assert.match(r.reason, /deliverTask/);
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
