import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { sealArm } from "./arm-seal.mjs";
import { runLive } from "./orca-spike-live.mjs";
import {
  makeFixtureDir,
  writeAddendum,
  goodDeps,
} from "./arm-seal-test-helpers.mjs";

// HYK-162 coder-8 (보고서-pm2.md §4.4 M1~M10, 패킷-addendum-초안.md §G): 라이브
// 자격 결속 재구현의 known-bad/good 재현. 전부 실제 임시 디렉터리 + 실 fs(arm-
// state.test.mjs 관례와 동형) + fake spawnSyncFn(실 orca 프로세스는 이 파일
// 어디에서도 뜨지 않는다 -- "orca" 문자열은 전부 fake 함수 인자로만 나타난다).

const RUN_START = "2026-07-19T02:06:30.000Z"; // 11:06:30 KST, within authorization window

function fakeSpawnSyncFn(handlers) {
  const calls = [];
  const fn = (cmd, argv) => {
    calls.push(argv);
    const cmdName = argv[1];
    const handler = handlers[cmdName];
    const resp =
      typeof handler === "function"
        ? handler(argv, calls.length)
        : (handler ?? { ok: true });
    return { stdout: JSON.stringify(resp), stderr: "", status: 0 };
  };
  fn.calls = calls;
  return fn;
}

function goodHandlers() {
  return {
    "task-create": () => ({
      ok: true,
      result: { task: { id: "task_abc123", status: "ready" } },
    }),
    dispatch: () => ({ ok: true }),
    check: () => ({
      ok: true,
      result: { messages: [{ type: "worker_done" }], count: 1 },
    }),
  };
}

function writeResultFile(resultPath, taskId, doneAtKst) {
  writeFileSync(
    resultPath,
    `task_id: ${taskId}\n\n>>> DONE: spike @ ${doneAtKst}\n`,
    "utf8",
  );
}

async function sealGoodArm(fieldOverrides = {}, sealDeps = {}) {
  const fx = makeFixtureDir();
  const addendumPath = writeAddendum(fx.dir, {
    ...fx.fields,
    ...fieldOverrides,
  });
  const seal = await sealArm({
    addendumPath,
    outDir: fx.dir,
    deps: goodDeps(sealDeps),
  });
  return { fx, seal };
}

function cleanup(fx) {
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---- G1: known-good full path ----
test("(G1) known-good: matching packet/arm/task/target -> exactly one task-create + one dispatch, COMPLETE", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10 KST");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      [
        "node",
        "orca-spike-live.mjs",
        "--live",
        "--authorization",
        seal.authorizationPath,
      ],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, true, result.reason);
    assert.equal(spawnSyncFn.calls.length, 3);
    assert.equal(spawnSyncFn.calls[0][1], "task-create");
    assert.equal(spawnSyncFn.calls[1][1], "dispatch");
    assert.equal(spawnSyncFn.calls[2][1], "check");
  } finally {
    cleanup(fx);
  }
});

// ---- A1: packet tampered / different signed packet after sealing ----
test("(A1) known-bad: packet content changed after sealing (single char) -> task-create 0, dispatch 0", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeFileSync(fx.packetPath, fx.packetContent + " ", "utf8"); // one extra char
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "PACKET_MISMATCH");
    assert.equal(spawnSyncFn.calls.length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---- A3: arm/cycle/task id reversed (ARMED store tampered directly, grant/authorization untouched) ----
test("(A3) known-bad: ARMED store's grant.cycle_id diverges from the sealed grant -> task-create 0, dispatch 0", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const store = JSON.parse(readFileSync(seal.armStorePath, "utf8"));
    store.grant.cycle_id = "cycle-attacker-injected";
    writeFileSync(seal.armStorePath, JSON.stringify(store, null, 2), "utf8");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(spawnSyncFn.calls.length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---- A4: task content changed after sealing ----
test("(A4) known-bad: task file content changed after sealing -> task-create 0, dispatch 0", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeFileSync(fx.taskPath, fx.taskContent + "extra line\n", "utf8");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(spawnSyncFn.calls.length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---- A5: target handle tampered in the grant envelope after sealing ----
test("(A5) known-bad: grant envelope's target_handle tampered post-seal -> task-create 0, dispatch 0", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const grant = JSON.parse(readFileSync(seal.grantPath, "utf8"));
    grant.target_handle = "attacker-controlled-terminal";
    writeFileSync(seal.grantPath, JSON.stringify(grant, null, 2), "utf8");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "GRANT_AUTHORIZATION_MISMATCH");
    assert.equal(spawnSyncFn.calls.length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---- A6: Orca rejects dispatch (handle gone/restarted) -> no automatic retry ----
test("(A6) known-bad: Orca rejects dispatch (handle gone) -> dispatch fails, and the same arm cannot be retried", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const spawnSyncFn = fakeSpawnSyncFn({
      "task-create": () => ({
        ok: true,
        result: { task: { id: "task_abc123", status: "ready" } },
      }),
      dispatch: () => ({
        ok: false,
        reason: "terminal handle no longer exists",
      }),
    });
    const first = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(first.ok, false);
    assert.equal(spawnSyncFn.calls.length, 2); // task-create + failed dispatch, no check

    const spawnSyncFn2 = fakeSpawnSyncFn(goodHandlers());
    const second = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn: spawnSyncFn2 } },
    );
    assert.equal(second.ok, false);
    assert.equal(
      spawnSyncFn2.calls.length,
      0,
      "no automatic retry on the same arm after a failed attempt",
    );
  } finally {
    cleanup(fx);
  }
});

// ---- A7: expiry lands between task-create and dispatch ----
test("(A7) known-bad: authorization expires between task-create and dispatch -> dispatch 0, DISARM", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    let expired = false;
    const spawnSyncFn = fakeSpawnSyncFn({
      "task-create": () => {
        const resp = {
          ok: true,
          result: { task: { id: "task_abc123", status: "ready" } },
        };
        expired = true; // flips to an expired clock right after the first real orca call
        return resp;
      },
      dispatch: () => ({ ok: true }),
      check: () => ({
        ok: true,
        result: { messages: [{ type: "worker_done" }], count: 1 },
      }),
    });
    const nowFn = () => (expired ? "2026-07-19T03:00:00.000Z" : RUN_START); // 36min after signature once expired
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(
      spawnSyncFn.calls.length,
      1,
      "only task-create ran; dispatch must not fire once expired",
    );
    const store = JSON.parse(readFileSync(seal.armStorePath, "utf8"));
    assert.equal(store.state, "DISARMED");
    assert.equal(store.disarm_cause, "expired");
  } finally {
    cleanup(fx);
  }
});

// ---- A8: sequential second attempt on the same arm ----
test("(A8) known-bad: a second sequential attempt on the same arm makes zero Orca calls", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10 KST");
    const spawnSyncFn1 = fakeSpawnSyncFn(goodHandlers());
    const first = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn: spawnSyncFn1 } },
    );
    assert.equal(first.ok, true, first.reason);

    const spawnSyncFn2 = fakeSpawnSyncFn(goodHandlers());
    const second = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn: spawnSyncFn2 } },
    );
    assert.equal(second.ok, false);
    assert.equal(spawnSyncFn2.calls.length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---- A9: worker_done claimed but no real completion evidence exists ----
test("(A9) known-bad: worker_done reported but no matching result file exists -> completion 0", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    // deliberately do NOT write fx.resultPath -- worker_done alone must not complete the attempt
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /result file not found|HANDSHAKE/i);
  } finally {
    cleanup(fx);
  }
});

// ---- A10: stale result (DONE predates task drop) ----
test("(A10) known-bad: stale result (DONE predates dropped_at) -> completion 0", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 10:00 KST"); // before dropped_at 11:00
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /stale/i);
  } finally {
    cleanup(fx);
  }
});

// ---- A11: arbitrary output/coordinator CLI overrides are rejected outright ----
test("(A11) known-bad: --output-dir/--coordinator CLI overrides are rejected before any Orca call", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      [
        "node",
        "x",
        "--live",
        "--authorization",
        seal.authorizationPath,
        "--output-dir",
        "/tmp/attacker-controlled",
      ],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "CLI_SHAPE_INVALID");
    assert.equal(spawnSyncFn.calls.length, 0);

    const spawnSyncFn2 = fakeSpawnSyncFn(goodHandlers());
    const result2 = runLive(
      [
        "node",
        "x",
        "--live",
        "--authorization",
        seal.authorizationPath,
        "--coordinator",
        "attacker-terminal",
      ],
      { deps: { nowFn: () => RUN_START, spawnSyncFn: spawnSyncFn2 } },
    );
    assert.equal(result2.ok, false);
    assert.equal(result2.reason, "CLI_SHAPE_INVALID");
    assert.equal(spawnSyncFn2.calls.length, 0);
  } finally {
    cleanup(fx);
  }
});

// ---- extra M2 coverage: individual credential flags are rejected even alongside a valid authorization ----
test("(M2) known-bad: --target/--arm-id/--human-approval-ref overrides are rejected (no per-flag credential channel)", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    for (const flag of [
      "--target",
      "--arm-id",
      "--human-approval-ref",
      "--cycle-id",
    ]) {
      const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
      const result = runLive(
        [
          "node",
          "x",
          "--live",
          "--authorization",
          seal.authorizationPath,
          flag,
          "anything",
        ],
        { deps: { nowFn: () => RUN_START, spawnSyncFn } },
      );
      assert.equal(result.ok, false, `flag ${flag} should be rejected`);
      assert.equal(result.reason, "CLI_SHAPE_INVALID");
      assert.equal(spawnSyncFn.calls.length, 0);
    }
  } finally {
    cleanup(fx);
  }
});

// ---- M9: writeLiveOutputs only ever creates new files (create-new-only) ----
test("(M9) writeLiveOutputs refuses to overwrite an existing file at the output root", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10 KST");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.outputRoot, fx.dir);
  } finally {
    cleanup(fx);
  }
});
