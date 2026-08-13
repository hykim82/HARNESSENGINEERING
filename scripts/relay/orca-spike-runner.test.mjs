import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArmStore, armStorePath, hashContent } from "./arm-state.mjs";
import {
  runSpikeAttempt,
  assertAllowedOrcaCommand,
  runGuardedStep,
  buildTaskCreateCommand,
  buildDispatchCommand,
  buildDispatchCommandNoInject,
  buildCheckWaitCommand,
  parseRuntimeTaskId,
  writeReceiptLedger,
  REASON,
} from "./orca-spike-runner.mjs";

const GRANT = Object.freeze({
  arm_id: "arm-spike-1",
  cycle_id: "cycle-spike-1",
  human_approval_ref: "한용 2026-07-19 00:30",
  issued_at: "2026-07-19T00:30:00.000Z",
  expires_at: "2026-07-19T23:59:00.000Z",
  allowed_lanes: ["CODER"],
  allowed_task_ids: ["SPIKE-SYN-1"],
  max_starts_total: 1,
  max_starts_per_lane: 1,
  max_rejections: 3,
  publish_allowed: false,
  question_policy: "pause",
  error_policy: "pause",
});
const TASK_CONTENT = "task_id: SPIKE-SYN-1\nsynthetic echo-only spike target\n";
const IN_WINDOW_NOW = Date.parse("2026-07-19T12:00:00.000Z");
const EXPECTED_TARGET = "coder-terminal-main";
const EXPECTED_COORDINATOR = "orch-coordinator-main";
const EXPECTED_ROLE = "CODER";
const RUNTIME_TASK_ID = "task_80fa0dcac6c7";
function taskCreateResponse(id = RUNTIME_TASK_ID) {
  return { ok: true, result: { task: { id, status: "ready" } } };
}

// 합성 fixture: 서명 패킷 + arm store + task 파일 + handshake용 harnessDir(role-task.md/role.md).
// 실 .harness/*-task.md·실 arm 원장은 절대 건드리지 않는다(G13류).
function withFixture(
  { grant = GRANT, attemptsTotal = 0, signed = true, withResult = true } = {},
  fn,
) {
  const dir = mkdtempSync(join(tmpdir(), "orca-spike-runner-test-"));
  try {
    const packetPath = join(dir, "packet.md");
    writeFileSync(
      packetPath,
      signed
        ? "packet_id: PKT-1\n승인: OK 한용 2026-07-19 00:30\n"
        : "packet_id: PKT-1\n승인: ☐\n",
      "utf8",
    );

    const created = createArmStore(grant, { at: grant.issued_at });
    assert.equal(created.ok, true);
    const storeContent = { ...created.store, attempts_total: attemptsTotal };
    const storePath = armStorePath(dir, grant.arm_id);
    writeFileSync(storePath, JSON.stringify(storeContent), "utf8");

    const taskFilePath = join(dir, "coder-task.md");
    writeFileSync(taskFilePath, TASK_CONTENT, "utf8");

    const harnessDir = join(dir, "harness");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(
      join(harnessDir, "spike-task.md"),
      "task_id: SPIKE-SYN-1\ndropped_at: 2026-07-19 02:00 KST\n",
      "utf8",
    );
    if (withResult) {
      writeFileSync(
        join(harnessDir, "spike.md"),
        "task_id: SPIKE-SYN-1\n>>> DONE: spike @ 2026-07-19 02:05:00 KST\n",
        "utf8",
      );
    }

    fn({ dir, packetPath, storePath, taskFilePath, harnessDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function goodPredispatch(fx, overrides = {}) {
  return {
    packetPath: fx.packetPath,
    armDir: fx.dir,
    arm_id: GRANT.arm_id,
    taskFilePath: fx.taskFilePath,
    nowMs: IN_WINDOW_NOW,
    request: {
      human_approval_ref: GRANT.human_approval_ref,
      arm_id: GRANT.arm_id,
      cycle_id: GRANT.cycle_id,
      task_id: GRANT.allowed_task_ids[0],
      content_hash: hashContent(TASK_CONTENT),
      target: EXPECTED_TARGET,
      role: EXPECTED_ROLE,
    },
    expected: { target: EXPECTED_TARGET, role: EXPECTED_ROLE },
    ...overrides,
  };
}

function baseInput(fx, overrides = {}) {
  return {
    predispatch: goodPredispatch(fx, overrides.predispatch),
    task_id: GRANT.allowed_task_ids[0],
    terminalHandle: EXPECTED_TARGET,
    coordinatorHandle: EXPECTED_COORDINATOR,
    timeoutMs: 60000,
    handshake: {
      role: "spike",
      harnessDir: fx.harnessDir,
      ...overrides.handshake,
    },
  };
}

// fake execFn: 순서대로 task-create -> dispatch -> check-wait 응답을 큐에서 뽑아준다.
function fakeExecFn(responses) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    const next = responses[calls.length - 1];
    if (next && next.throw) throw next.throw;
    return next ?? { ok: true };
  };
  fn.calls = calls;
  return fn;
}

const GOOD_SEQUENCE = [
  taskCreateResponse(),
  { ok: true },
  { ok: true, outcome: "worker_done" },
];

test("(0) known-good: full spike path -> COMPLETE, exactly 3 orca calls in order", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, true);
    assert.equal(result.reason, REASON.COMPLETE);
    assert.equal(execFn.calls.length, 3);
    assert.deepEqual(execFn.calls[0], [
      "orchestration",
      "task-create",
      "--spec",
      "go SPIKE-SYN-1",
      "--json",
    ]);
    assert.deepEqual(execFn.calls[1], [
      "orchestration",
      "dispatch",
      "--task",
      RUNTIME_TASK_ID,
      "--to",
      EXPECTED_TARGET,
      "--inject",
      "--json",
    ]);
    assert.deepEqual(execFn.calls[2], [
      "orchestration",
      "check",
      "--terminal",
      EXPECTED_COORDINATOR,
      "--types",
      "worker_done,escalation",
      "--wait",
      "--timeout-ms",
      "60000",
      "--json",
    ]);
  });
});

test("(1) G1 known-bad: predispatch denied (unsigned packet) -> PREDISPATCH_DENIED, 0 orca calls", () => {
  withFixture({ signed: false }, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PREDISPATCH_DENIED);
    assert.equal(
      execFn.calls.length,
      0,
      "no orca command may be issued once predispatch denies",
    );
  });
});
test("(1b) G1 known-good (paired): signed packet -> predispatch allows, run proceeds", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, true);
  });
});

test("(2) 이중 실행(예산 소진): attempts_total already at max -> PREDISPATCH_DENIED before any orca call", () => {
  withFixture({ attemptsTotal: 1 }, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PREDISPATCH_DENIED);
    assert.match(result.detail, /BUDGET_EXHAUSTED/);
    assert.equal(execFn.calls.length, 0);
  });
});

test("(3) G2 known-bad: a disallowed command shape is rejected by the guard", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "terminal",
    "send",
    "hello",
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
});
test("(3b) G2 known-good (paired): the exact dispatch --inject shape is allowed", () => {
  const r = assertAllowedOrcaCommand(
    buildDispatchCommand(RUNTIME_TASK_ID, EXPECTED_TARGET),
  );
  assert.equal(r.ok, true);
});
test("(3c) G2: task-create and check --wait shapes are allowed too", () => {
  assert.equal(
    assertAllowedOrcaCommand(buildTaskCreateCommand("go SPIKE-SYN-1")).ok,
    true,
  );
  assert.equal(
    assertAllowedOrcaCommand(buildCheckWaitCommand(EXPECTED_COORDINATOR, 60000))
      .ok,
    true,
  );
});
// HYK-170 사이클2 ②-b coder-1 (D11): 이 정확한 무-inject 7-원소 shape는
// 이전엔 known-bad였으나, codex(REVIEW=codex/terra) 배달 프로필이 이
// 형태를 정당한 배정-기록-전용 dispatch로 요구한다(dispatch-worker.ps1
// 실측 그대로) -- 화이트리스트에 별도 exact shape로 추가됐으므로 이제
// 통과해야 한다. buildDispatchCommandNoInject의 builder 산출물과 정확히
// 일치함도 함께 확인(추측 조립 아님).
test("(3d) G2 D11: dispatch without --inject (exact 7-element shape) is now allowed -- codex profile's dedicated dispatch-no-inject shape", () => {
  const argv = [
    "orchestration",
    "dispatch",
    "--task",
    RUNTIME_TASK_ID,
    "--to",
    EXPECTED_TARGET,
    "--json",
  ];
  assert.deepEqual(
    argv,
    buildDispatchCommandNoInject(RUNTIME_TASK_ID, EXPECTED_TARGET),
  );
  const r = assertAllowedOrcaCommand(argv);
  assert.equal(r.ok, true);
});

// D11 회귀: 무-inject shape도 위치/길이가 정확해야 한다 -- 임의 인자 추가나
// --inject를 다시 붙인 8-원소 변형과 혼동해 통과시키면 안 된다.
test("(3d-2) G2 D11: dispatch-no-inject with an extra trailing arg is still rejected (exact length enforced)", () => {
  const r = assertAllowedOrcaCommand([
    ...buildDispatchCommandNoInject(RUNTIME_TASK_ID, EXPECTED_TARGET),
    "--agent",
  ]);
  assert.equal(r.ok, false);
});

test("(3d-3) G2 D11: dispatch-no-inject shape does not accidentally also match with --inject re-added (still exactly 2 distinct shapes)", () => {
  const withInject = [
    "orchestration",
    "dispatch",
    "--task",
    RUNTIME_TASK_ID,
    "--to",
    EXPECTED_TARGET,
    "--inject",
    "--json",
  ];
  assert.deepEqual(
    withInject,
    buildDispatchCommand(RUNTIME_TASK_ID, EXPECTED_TARGET),
  );
  assert.equal(assertAllowedOrcaCommand(withInject).ok, true);
});

// review-3의 정확한 3개 반례를 known-bad로 박제 -- 이전 prefix 비교는 이 3개를
// 전부 {ok:true}로 통과시켰다(고정 토큰 뒤 임의 인자 추가). exact-shape는 각각을
// 거부해야 한다.
test("(3e) G2 review-3 repro #1: dispatch --inject with an extra --agent arg is rejected", () => {
  const r = assertAllowedOrcaCommand([
    ...buildDispatchCommand(RUNTIME_TASK_ID, EXPECTED_TARGET),
    "--agent",
    "attacker",
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
});
test("(3f) G2 review-3 repro #2: task-create with an extra --run-hooks arg is rejected", () => {
  const r = assertAllowedOrcaCommand([
    ...buildTaskCreateCommand("go SPIKE-SYN-1"),
    "--run-hooks",
  ]);
  assert.equal(r.ok, false);
});
test("(3g) G2 review-3 repro #3: check --wait with an extra --linear arg is rejected", () => {
  const r = assertAllowedOrcaCommand([
    ...buildCheckWaitCommand(EXPECTED_COORDINATOR, 60000),
    "--linear",
  ]);
  assert.equal(r.ok, false);
});
test("(3h) G2 known-good (paired with 3e-3g): the exact builder-produced shapes still pass", () => {
  assert.equal(
    assertAllowedOrcaCommand(
      buildDispatchCommand(RUNTIME_TASK_ID, EXPECTED_TARGET),
    ).ok,
    true,
  );
  assert.equal(
    assertAllowedOrcaCommand(buildTaskCreateCommand("go SPIKE-SYN-1")).ok,
    true,
  );
  assert.equal(
    assertAllowedOrcaCommand(buildCheckWaitCommand(EXPECTED_COORDINATOR, 60000))
      .ok,
    true,
  );
});

// 사이클 2 회귀 박제: 사이클 1이 승인했던 구 3형은 실제 Orca CLI에 없는 플래그였다
// (ORCH 실측으로 확정). 새 화이트리스트가 구 형태로 "회귀"하면 이 known-bad가 RED로
// 잡아야 한다 -- 형태 교정이 조용히 풀리는 사고 방지.
test("(3k) regression known-bad: old (wrong) task-create shape `--task-id ... --spec ...` is rejected", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "task-create",
    "--task-id",
    "SPIKE-SYN-1",
    "--spec",
    "go SPIKE-SYN-1",
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
});
test("(3l) regression known-bad: old (wrong) dispatch shape `--inject --target ... --task-id ...` is rejected", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "dispatch",
    "--inject",
    "--target",
    EXPECTED_TARGET,
    "--task-id",
    "SPIKE-SYN-1",
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
});
test("(3m) regression known-bad: old (wrong) check shape `--wait --task-id ... --timeout ...` is rejected", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "check",
    "--wait",
    "--task-id",
    "SPIKE-SYN-1",
    "--timeout",
    "60",
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
});

// 배선 반사실(review-3 요구사항): assertAllowedOrcaCommand 함수 자체가 아니라
// runGuardedStep -- 실제 호출점이 쓰는 바로 그 함수 -- 을 직접 불러, forbidden
// argv에도 execFn이 호출되지 않음을 증명한다. 이 테스트가 없던 이전 버전은
// "호출점의 `const guard = assertAllowedOrcaCommand(argv)`를 `{ok:true}`로 교체"하는
// mutation에도 16/16 GREEN이었다(review-3 실측). 이 테스트는 그 정확한 mutation을
// 재현하면 RED가 되어야 한다 -- 자가 실증은 coder.md에 기록.
test("(3i) wiring counterfactual: runGuardedStep refuses a forbidden argv BEFORE calling execFn", () => {
  const calls = [];
  const execFn = (argv) => {
    calls.push(argv);
    return { ok: true };
  };
  const receipts = [];
  const result = runGuardedStep(
    [
      ...buildDispatchCommand(RUNTIME_TASK_ID, EXPECTED_TARGET),
      "--agent",
      "attacker",
    ],
    { execFn, nowFn: () => "T" },
    REASON.DISPATCH_FAILED,
    receipts,
    "dispatch",
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
  assert.equal(
    calls.length,
    0,
    "execFn must never be called for a forbidden argv",
  );
});
test("(3j) wiring counterfactual (paired good): runGuardedStep calls execFn for an allowed argv", () => {
  const calls = [];
  const execFn = (argv) => {
    calls.push(argv);
    return { ok: true };
  };
  const receipts = [];
  const result = runGuardedStep(
    buildDispatchCommand(RUNTIME_TASK_ID, EXPECTED_TARGET),
    { execFn, nowFn: () => "T" },
    REASON.DISPATCH_FAILED,
    receipts,
    "dispatch",
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("(4) G6/G8 known-bad: worker_done reported but handshake fails -> HANDSHAKE_FAILED, not success", () => {
  withFixture({ withResult: false }, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.HANDSHAKE_FAILED);
    assert.equal(
      execFn.calls.length,
      3,
      "check --wait still ran and reported worker_done as a transport receipt",
    );
    const worker_done_receipt = result.receipts.find(
      (r) => r.step === "check-wait",
    );
    assert.equal(worker_done_receipt.response.outcome, "worker_done");
  });
});
test("(4b) G6/G8 known-good (paired): worker_done + matching handshake -> COMPLETE", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, true);
  });
});

test("(5) G7 known-bad: check --wait times out -> CHECK_TIMEOUT, PAUSED (not retried)", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn([
      taskCreateResponse(),
      { ok: true },
      { ok: true, outcome: "timeout" },
    ]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.CHECK_TIMEOUT);
    assert.equal(execFn.calls.length, 3);
  });
});

test("(6) G7 known-bad: worker escalation -> CHECK_ESCALATION, PAUSED (human gate)", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn([
      taskCreateResponse(),
      { ok: true },
      { ok: true, outcome: "escalation" },
    ]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.CHECK_ESCALATION);
  });
});

test("(7) task-create step failure stops before dispatch/check (0 further calls)", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn([
      { ok: false, reason: "orca: task-create rejected" },
    ]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TASK_CREATE_FAILED);
    assert.equal(execFn.calls.length, 1);
  });
});

test("(8) dispatch step failure stops before check --wait (2 calls total)", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn([
      taskCreateResponse(),
      { ok: false, reason: "orca: dispatch rejected" },
    ]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DISPATCH_FAILED);
    assert.equal(execFn.calls.length, 2);
  });
});

test("(8b) G-a known-bad: task-create ok:true but response.result.task.id missing -> TASK_CREATE_FAILED before dispatch (1 call total)", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn([{ ok: true, result: { task: {} } }]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TASK_CREATE_FAILED);
    assert.match(result.detail, /result\.task\.id/);
    assert.equal(
      execFn.calls.length,
      1,
      "dispatch must never be attempted without a runtime task id",
    );
  });
});
test("(8c) G-a unit: parseRuntimeTaskId extracts result.task.id only from a well-formed ok:true response", () => {
  assert.equal(parseRuntimeTaskId(taskCreateResponse()), RUNTIME_TASK_ID);
  assert.equal(
    parseRuntimeTaskId({ ok: true, result: { task: { id: "" } } }),
    null,
  );
  assert.equal(parseRuntimeTaskId({ ok: true, result: {} }), null);
  assert.equal(
    parseRuntimeTaskId({ ok: false, result: { task: { id: "x" } } }),
    null,
  );
  assert.equal(parseRuntimeTaskId(null), null);
});

test("(9) execFn throwing is captured as a fail-closed stop, not an uncaught crash", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn([
      { throw: new Error("ENOENT: orca binary not found") },
    ]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TASK_CREATE_FAILED);
    assert.match(result.detail, /ENOENT/);
  });
});

test("(10) writeReceiptLedger writes the exact receipts array as JSON", () => {
  withFixture({}, (fx) => {
    const execFn = fakeExecFn(GOOD_SEQUENCE);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    const ledgerPath = join(fx.dir, "receipts.json");
    writeReceiptLedger(ledgerPath, result.receipts);
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.deepEqual(parsed, result.receipts);
  });
});
