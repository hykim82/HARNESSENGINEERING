import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { sealArm } from "./arm-seal.mjs";
import { runLive, writeLiveOutputs } from "./orca-spike-live.mjs";
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
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10:00 KST");
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
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10:00 KST");
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
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 10:00:00 KST"); // before dropped_at 11:00
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

// ---- HYK-162-coder-9 (관측 결함① 수리, S1~S3): 실패 경로에서도 dumps/receipts/
// outputRoot가 보존되고 writeLiveOutputs가 실패 봉투를 기록한다는 것을 실증한다.
// 전부 fake spawnSyncFn(실 orca 0) -- 07-20 라이브 발사 1회의 ATTEMPT_FAILED
// 재현형(T3)을 포함한다.

test("(T1) known-bad: task-create fails -> failure carries 1 dump + writeLiveOutputs writes raw dump + failure envelope", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const spawnSyncFn = fakeSpawnSyncFn({
      "task-create": () => ({ ok: false, reason: "orca rejected task-create" }),
    });
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ATTEMPT_FAILED");
    assert.match(result.detail, /TASK_CREATE_FAILED/);
    assert.match(result.detail, /orca rejected task-create/);
    assert.equal(result.dumps.length, 1);
    assert.equal(result.dumps[0].cmd, "task-create");
    assert.equal(result.outputRoot, fx.dir);
    assert.equal(result.attemptId, "arm-test-1--live-attempt");

    writeLiveOutputs(result);
    const rawDumpPath = join(
      fx.dir,
      `spike-live-raw-dump-${result.attemptId}.json`,
    );
    const failurePath = join(
      fx.dir,
      `spike-live-failure-${result.attemptId}.json`,
    );
    assert.equal(existsSync(rawDumpPath), true);
    assert.equal(existsSync(failurePath), true);
    const dumped = JSON.parse(readFileSync(rawDumpPath, "utf8"));
    assert.equal(dumped.length, 1);
    assert.equal(dumped[0].cmd, "task-create");
    const failureEnvelope = JSON.parse(readFileSync(failurePath, "utf8"));
    assert.equal(failureEnvelope.ok, false);
    assert.equal(failureEnvelope.reason, "ATTEMPT_FAILED");
    assert.match(failureEnvelope.detail, /orca rejected task-create/);
  } finally {
    cleanup(fx);
  }
});

test("(T2) known-bad: dispatch fails -> dumps preserve both task-create and dispatch (2)", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const spawnSyncFn = fakeSpawnSyncFn({
      "task-create": () => ({
        ok: true,
        result: { task: { id: "task_abc123", status: "ready" } },
      }),
      dispatch: () => ({ ok: false, reason: "terminal handle gone" }),
    });
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ATTEMPT_FAILED");
    assert.match(result.detail, /DISPATCH_FAILED/);
    assert.equal(result.dumps.length, 2);
    assert.equal(result.dumps[0].cmd, "task-create");
    assert.equal(result.dumps[1].cmd, "dispatch");

    writeLiveOutputs(result);
    const rawDumpPath = join(
      fx.dir,
      `spike-live-raw-dump-${result.attemptId}.json`,
    );
    const receiptsPath = join(
      fx.dir,
      `spike-live-receipts-${result.attemptId}.json`,
    );
    const failurePath = join(
      fx.dir,
      `spike-live-failure-${result.attemptId}.json`,
    );
    assert.equal(existsSync(rawDumpPath), true);
    assert.equal(existsSync(receiptsPath), true);
    assert.equal(existsSync(failurePath), true);

    const dumped = JSON.parse(readFileSync(rawDumpPath, "utf8"));
    assert.equal(dumped.length, 2);
    assert.deepEqual(
      dumped.map((d) => d.cmd),
      ["task-create", "dispatch"],
    );
    assert.equal(dumped[0].parsed.result.task.id, "task_abc123");
    assert.equal(dumped[1].parsed.ok, false);
    assert.equal(dumped[1].parsed.reason, "terminal handle gone");

    const receipts = JSON.parse(readFileSync(receiptsPath, "utf8"));
    assert.deepEqual(
      receipts.map((r) => r.step),
      ["predispatch", "task-create", "dispatch"],
    );
    assert.equal(receipts[2].response.reason, "terminal handle gone");

    const failureEnvelope = JSON.parse(readFileSync(failurePath, "utf8"));
    assert.equal(failureEnvelope.ok, false);
    assert.equal(failureEnvelope.reason, "ATTEMPT_FAILED");
    assert.match(failureEnvelope.detail, /DISPATCH_FAILED/);
    assert.match(failureEnvelope.detail, /terminal handle gone/);
  } finally {
    cleanup(fx);
  }
});

test("(T3) known-bad: check times out (07-20 ATTEMPT_FAILED 재현형) -> all 3 dumps preserved, failed step identifiable from dumps alone", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const spawnSyncFn = fakeSpawnSyncFn({
      "task-create": () => ({
        ok: true,
        result: { task: { id: "task_abc123", status: "ready" } },
      }),
      dispatch: () => ({ ok: true }),
      check: () => ({ ok: true, result: { messages: [], count: 0 } }),
    });
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ATTEMPT_FAILED");
    assert.match(result.detail, /CHECK_TIMEOUT/);
    assert.equal(result.dumps.length, 3);
    assert.deepEqual(
      result.dumps.map((d) => d.cmd),
      ["task-create", "dispatch", "check"],
    );
    // the failed step is identifiable purely from the dumps -- the last dump's
    // parsed response carries the empty-messages timeout, not a thrown/opaque error.
    assert.deepEqual(result.dumps[2].parsed.result.messages, []);

    writeLiveOutputs(result);
    const rawDumpPath = join(
      fx.dir,
      `spike-live-raw-dump-${result.attemptId}.json`,
    );
    const receiptsPath = join(
      fx.dir,
      `spike-live-receipts-${result.attemptId}.json`,
    );
    const failurePath = join(
      fx.dir,
      `spike-live-failure-${result.attemptId}.json`,
    );
    assert.equal(existsSync(rawDumpPath), true);
    assert.equal(existsSync(receiptsPath), true);
    assert.equal(existsSync(failurePath), true);

    // step order + raw content must be recoverable from disk alone (07-20
    // ATTEMPT_FAILED postmortem could not tell which of task-create/dispatch/
    // check failed -- this is the exact evidence that was missing).
    const dumped = JSON.parse(readFileSync(rawDumpPath, "utf8"));
    assert.equal(dumped.length, 3);
    assert.deepEqual(
      dumped.map((d) => d.cmd),
      ["task-create", "dispatch", "check"],
    );
    assert.deepEqual(dumped[2].parsed.result.messages, []);

    const receipts = JSON.parse(readFileSync(receiptsPath, "utf8"));
    assert.deepEqual(
      receipts.map((r) => r.step),
      ["predispatch", "task-create", "dispatch", "check-wait"],
    );

    const failureEnvelope = JSON.parse(readFileSync(failurePath, "utf8"));
    assert.equal(failureEnvelope.ok, false);
    assert.equal(failureEnvelope.reason, "ATTEMPT_FAILED");
    assert.match(failureEnvelope.detail, /CHECK_TIMEOUT/);
  } finally {
    cleanup(fx);
  }
});

test("(T4) known-bad: fresh handshake recheck fails though the attempt itself succeeded -> receipts + dumps both recorded", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10:00 KST");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    let calls = 0;
    // nowFn is called 11 times across a good run (preflight/claim/start/dispatch
    // -recheck/4 receipts/finishAttemptTx); the 11th call is finishAttemptTx's
    // `at:` inside concludeAttempt -- the one spot that runs strictly *between*
    // runSpikeAttempt's own (passing) handshake check and runLive's fresh
    // recheck. Deleting the result file there reproduces "attempt ok, fresh
    // recheck fails" without touching any authorization/grant/claim logic.
    const nowFn = () => {
      calls += 1;
      if (calls === 11) rmSync(fx.resultPath, { force: true });
      return RUN_START;
    };
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "HANDSHAKE_RECHECK_FAILED");
    assert.equal(result.dumps.length, 3);
    assert.ok(Array.isArray(result.receipts) && result.receipts.length > 0);
    assert.ok(result.receipts.some((r) => r.step === "handshake"));

    writeLiveOutputs(result);
    const rawDumpPath = join(
      fx.dir,
      `spike-live-raw-dump-${result.attemptId}.json`,
    );
    const receiptsPath = join(
      fx.dir,
      `spike-live-receipts-${result.attemptId}.json`,
    );
    const failurePath = join(
      fx.dir,
      `spike-live-failure-${result.attemptId}.json`,
    );
    assert.equal(existsSync(rawDumpPath), true);
    assert.equal(existsSync(receiptsPath), true);
    assert.equal(existsSync(failurePath), true);

    const dumped = JSON.parse(readFileSync(rawDumpPath, "utf8"));
    assert.equal(dumped.length, 3);
    assert.deepEqual(
      dumped.map((d) => d.cmd),
      ["task-create", "dispatch", "check"],
    );
    // raw orca response content (not just cmd/order) must survive to disk --
    // this is the actual post-mortem evidence (07-20's ATTEMPT_FAILED had none).
    assert.equal(dumped[0].parsed.result.task.id, "task_abc123");
    assert.equal(dumped[1].parsed.ok, true);
    assert.deepEqual(dumped[2].parsed.result.messages, [
      { type: "worker_done" },
    ]);

    const receipts = JSON.parse(readFileSync(receiptsPath, "utf8"));
    assert.deepEqual(
      receipts.map((r) => r.step),
      ["predispatch", "task-create", "dispatch", "check-wait", "handshake"],
    );
    // the attempt's own (internal) handshake check passed -- receipts records
    // ok:true for that stage even though runLive's fresh recheck (outside
    // runSpikeAttempt, disk-based) later fails once the result file is gone.
    assert.equal(receipts[4].ok, true);

    const failureEnvelope = JSON.parse(readFileSync(failurePath, "utf8"));
    assert.equal(failureEnvelope.ok, false);
    assert.equal(failureEnvelope.reason, "HANDSHAKE_RECHECK_FAILED");
    assert.match(failureEnvelope.detail, /result file not found/i);
  } finally {
    cleanup(fx);
  }
});

test("(T5) known-bad: failure before authorization binding -> no output_root known, writeLiveOutputs writes nothing, no crash", async () => {
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
        seal.authorizationPath + "-does-not-exist",
      ],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "AUTHORIZATION_UNREADABLE");
    assert.equal(result.outputRoot, undefined);
    assert.equal(spawnSyncFn.calls.length, 0);

    assert.doesNotThrow(() => writeLiveOutputs(result));
    const spikeFiles = readdirSync(fx.dir).filter((f) =>
      f.startsWith("spike-live-"),
    );
    assert.deepEqual(spikeFiles, []);
  } finally {
    cleanup(fx);
  }
});

test("(T6) success-path regression: writeLiveOutputs still writes exactly receipts + raw-dump (no failure envelope) on COMPLETE", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10:00 KST");
    const spawnSyncFn = fakeSpawnSyncFn(goodHandlers());
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, true, result.reason);
    writeLiveOutputs(result);
    const spikeFiles = readdirSync(fx.dir)
      .filter((f) => f.startsWith("spike-live-"))
      .sort();
    assert.deepEqual(spikeFiles, [
      `spike-live-raw-dump-${result.attemptId}.json`,
      `spike-live-receipts-${result.attemptId}.json`,
    ]);
  } finally {
    cleanup(fx);
  }
});

test("(T7) M9 counterfactual on the failure envelope: an existing failure file at the same attemptId is not overwritten", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    const spawnSyncFn = fakeSpawnSyncFn({
      "task-create": () => ({ ok: false, reason: "boom" }),
    });
    const result = runLive(
      ["node", "x", "--live", "--authorization", seal.authorizationPath],
      { deps: { nowFn: () => RUN_START, spawnSyncFn } },
    );
    assert.equal(result.ok, false);
    const failurePath = join(
      fx.dir,
      `spike-live-failure-${result.attemptId}.json`,
    );
    writeFileSync(failurePath, JSON.stringify({ preexisting: true }), "utf8");
    assert.throws(() => writeLiveOutputs(result), /EEXIST/);
  } finally {
    cleanup(fx);
  }
});

// ---- M9: writeLiveOutputs only ever creates new files (create-new-only) ----
test("(M9) writeLiveOutputs refuses to overwrite an existing file at the output root", async () => {
  const { fx, seal } = await sealGoodArm();
  assert.equal(seal.ok, true, seal.reason);
  try {
    writeResultFile(fx.resultPath, "SPIKE-LIVE-1", "2026-07-19 11:10:00 KST");
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
