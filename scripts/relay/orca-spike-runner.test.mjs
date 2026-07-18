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
  buildCheckWaitCommand,
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
const EXPECTED_ROLE = "CODER";

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
        "task_id: SPIKE-SYN-1\n>>> DONE: spike @ 2026-07-19 02:05 KST\n",
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
    timeoutS: 60,
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
  { ok: true },
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
    assert.deepEqual(execFn.calls[0].slice(0, 2), [
      "orchestration",
      "task-create",
    ]);
    assert.deepEqual(execFn.calls[1].slice(0, 3), [
      "orchestration",
      "dispatch",
      "--inject",
    ]);
    assert.deepEqual(execFn.calls[2].slice(0, 3), [
      "orchestration",
      "check",
      "--wait",
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
    buildDispatchCommand("SPIKE-SYN-1", EXPECTED_TARGET),
  );
  assert.equal(r.ok, true);
});
test("(3c) G2: task-create and check --wait shapes are allowed too", () => {
  assert.equal(
    assertAllowedOrcaCommand(
      buildTaskCreateCommand("go SPIKE-SYN-1", "SPIKE-SYN-1"),
    ).ok,
    true,
  );
  assert.equal(
    assertAllowedOrcaCommand(buildCheckWaitCommand("SPIKE-SYN-1", 60)).ok,
    true,
  );
});
test("(3d) G2: dispatch without --inject is rejected (not just any 'dispatch' token)", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "dispatch",
    "--agent",
    "x",
  ]);
  assert.equal(r.ok, false);
});

// review-3의 정확한 3개 반례를 known-bad로 박제 -- 이전 prefix 비교는 이 3개를
// 전부 {ok:true}로 통과시켰다(고정 토큰 뒤 임의 인자 추가). exact-shape는 각각을
// 거부해야 한다.
test("(3e) G2 review-3 repro #1: dispatch --inject with an extra --agent arg is rejected", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "dispatch",
    "--inject",
    "--agent",
    "attacker",
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(REASON.ORCA_COMMAND_NOT_ALLOWED));
});
test("(3f) G2 review-3 repro #2: task-create with an extra --run-hooks arg is rejected", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "task-create",
    "--run-hooks",
  ]);
  assert.equal(r.ok, false);
});
test("(3g) G2 review-3 repro #3: check --wait with an extra --linear arg is rejected", () => {
  const r = assertAllowedOrcaCommand([
    "orchestration",
    "check",
    "--wait",
    "--linear",
  ]);
  assert.equal(r.ok, false);
});
test("(3h) G2 known-good (paired with 3e-3g): the exact builder-produced shapes still pass", () => {
  assert.equal(
    assertAllowedOrcaCommand(
      buildDispatchCommand("SPIKE-SYN-1", EXPECTED_TARGET),
    ).ok,
    true,
  );
  assert.equal(
    assertAllowedOrcaCommand(
      buildTaskCreateCommand("go SPIKE-SYN-1", "SPIKE-SYN-1"),
    ).ok,
    true,
  );
  assert.equal(
    assertAllowedOrcaCommand(buildCheckWaitCommand("SPIKE-SYN-1", 60)).ok,
    true,
  );
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
    ["orchestration", "dispatch", "--inject", "--agent", "attacker"],
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
    buildDispatchCommand("SPIKE-SYN-1", EXPECTED_TARGET),
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
      { ok: true },
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
      { ok: true },
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
      { ok: true },
      { ok: false, reason: "orca: dispatch rejected" },
    ]);
    const result = runSpikeAttempt(baseInput(fx), { execFn, nowFn: () => "T" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DISPATCH_FAILED);
    assert.equal(execFn.calls.length, 2);
  });
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
