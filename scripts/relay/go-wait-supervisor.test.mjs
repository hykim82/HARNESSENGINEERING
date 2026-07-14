import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mod from "./go-wait-supervisor.mjs";
import { createArmStore, saveStoreAtomic, loadStore, armStorePath, claimTx, startTx, STATE, DISARM_CAUSE } from "./arm-state.mjs";

// Gate refs = 패킷-초안.md §4 그룹5(5A: supervisor만, 어댑터는 stub 주입). arm-state.mjs는
// import만 -- 이 파일은 그 승인된 Tx 배선이 옳게 조합되는지만 검증한다(상태기계 재구현 0).

function freshDir() {
  return mkdtempSync(join(tmpdir(), "go-wait-supervisor-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function counter() {
  let calls = [];
  const fn = (...args) => { calls.push(args); return fn.impl ? fn.impl(...args) : undefined; };
  fn.calls = () => calls;
  fn.count = () => calls.length;
  return fn;
}

const NOW_OK = () => Date.parse("2026-07-14T21:30:00.000Z");

function makeGrant(overrides = {}) {
  return {
    arm_id: "arm-sup",
    cycle_id: "cycle-1",
    human_approval_ref: "sign-1",
    issued_at: "2026-07-14T21:00:00.000Z",
    expires_at: "2026-07-14T22:00:00.000Z",
    allowed_lanes: ["coder"],
    allowed_task_ids: ["HYK-141-coder-1"],
    max_starts_total: 5,
    max_starts_per_lane: 5,
    max_rejections: 0,
    question_policy: "pause",
    error_policy: "pause",
    publish_allowed: false,
    ...overrides,
  };
}

function seedArm(dir, arm_id, grantOverrides = {}) {
  const created = createArmStore(makeGrant({ arm_id, ...grantOverrides }), { at: "t0" });
  assert.equal(created.ok, true);
  const path = armStorePath(dir, arm_id);
  const saved = saveStoreAtomic(path, created.store);
  assert.equal(saved.ok, true);
  return path;
}

const SCOPE = { lane: "coder", cwd: "C:/work/repo", config: "coder-profile.json", allowedTaskIds: ["HYK-141-coder-1"] };
function makeTask(overrides = {}) {
  return {
    task_id: "HYK-141-coder-1",
    lane: "coder",
    cycle_id: "cycle-1",
    attempt_id: "attempt-1",
    content_hash: "hash-a",
    at: "2026-07-14 21:30 KST",
    cwd: "C:/work/repo",
    config: "coder-profile.json",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// G5: 자기 것만 소비 -- 불일치는 arm-state를 전혀 건드리지 않는다(claim marker/store 무변경).
// ---------------------------------------------------------------------------

test("G5-1: lane mismatch is refused before any arm-state call (no claim, disk untouched)", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-lane";
  try {
    const path = seedArm(dir, arm_id);
    const before = readFileSync(path, "utf8");
    const adapterFn = counter();
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask({ lane: "review" }), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "own_consumption");
    assert.match(r.reason, /lane mismatch/);
    assert.equal(adapterFn.count(), 0, "adapter must never be invoked on a scope mismatch");
    assert.equal(readFileSync(path, "utf8"), before, "arm store must be untouched by a refused own-consumption check");
  } finally {
    cleanup(dir);
  }
});

test("G5-2: task_id outside the supervisor's allowed set is refused", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-taskid";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask({ task_id: "HYK-999-coder-9" }), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "own_consumption");
    assert.equal(adapterFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

test("G5-3: cwd/config mismatch is refused (own scope, not just task_id)", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-cwd";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask({ cwd: "C:/other/repo" }), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "own_consumption");
    assert.match(r.reason, /cwd mismatch/);
    assert.equal(adapterFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// G11: STATUS self-report 실패 -> claim/adapter 호출 0.
// ---------------------------------------------------------------------------

test("G11-1: a throwing status report refuses before claim -- no claim marker, adapter never called", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-status";
  try {
    const path = seedArm(dir, arm_id);
    const before = readFileSync(path, "utf8");
    const adapterFn = counter();
    const reportStatusFn = () => { throw new Error("STATUS.md locked by another writer"); };
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn, reportStatusFn });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "status_report");
    assert.match(r.reason, /STATUS self-report threw/);
    assert.equal(adapterFn.count(), 0, "adapter must never run if the pre-claim STATUS report fails");
    assert.equal(readFileSync(path, "utf8"), before, "a refused status report must not touch the arm store (no claim attempted)");
  } finally {
    cleanup(dir);
  }
});

test("G11-2: a status report returning {ok:false} refuses before claim", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-status2";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    const reportStatusFn = () => ({ ok: false, reason: "disk full" });
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn, reportStatusFn });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "status_report");
    assert.match(r.reason, /disk full/);
    assert.equal(adapterFn.count(), 0);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// I2 + G7/G8: happy path -- 정확히 1회 adapter 호출, 선저장 후에만 호출, exit code 분류,
// 종료 신호가 receipt에 실측 기록.
// ---------------------------------------------------------------------------

test("HP-1: exitCode 0 -> outcome done, disk DISARMED+complete, adapter called exactly once", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-happy";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: null });
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, true, `must succeed: ${JSON.stringify(r)}`);
    assert.equal(r.outcome, "done");
    assert.equal(adapterFn.count(), 1, "adapter must be invoked exactly once");

    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.ok, true);
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.COMPLETE);
    const doneReceipt = disk.store.receipts.find((rec) => rec.event === "done");
    assert.ok(doneReceipt, "a 'done' receipt with exit detail must be on disk");
    assert.equal(doneReceipt.detail.exitCode, 0);
    assert.equal(doneReceipt.detail.signal, null);
  } finally {
    cleanup(dir);
  }
});

test("HP-2: adapter reports a question -> outcome question, disk DISARMED+question, no auto-resume/downstream", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-question";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: null, question: { question_id: "q1" } });
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "question");
    assert.equal(adapterFn.count(), 1);

    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.state, STATE.DISARMED, "question must disarm immediately -- no lingering RUNNING/auto-resume");
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.QUESTION);
    const qReceipt = disk.store.receipts.find((rec) => rec.event === "question");
    assert.equal(qReceipt.detail.question_id, "q1");

    // downstream 0: calling again on the same arm must not be silently accepted (single-track,
    // arm is DISARMED -- a second attempt needs a brand-new arm per contract 4).
    const again = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask({ attempt_id: "attempt-2" }), { nowFn: NOW_OK, adapterFn });
    assert.equal(again.ok, false);
    assert.equal(adapterFn.count(), 1, "no automatic re-invocation of the adapter on a disarmed arm");
  } finally {
    cleanup(dir);
  }
});

test("HP-3: an unexpected non-zero exit code classifies as cli_abnormal_exit, exit code preserved on disk (no silent loss)", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-abnormal";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 17, signal: null });
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "cli_abnormal_exit");

    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.ERROR);
    const rec = disk.store.receipts.find((x) => x.event === "cli_abnormal_exit");
    assert.equal(rec.detail.exitCode, 17);
  } finally {
    cleanup(dir);
  }
});

test("HP-4: a signal (e.g. killed) classifies as cli_abnormal_exit even with exitCode 0, signal recorded", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-signal";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: "SIGKILL" });
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.outcome, "cli_abnormal_exit");
    const disk = loadStore(armStorePath(dir, arm_id));
    const rec = disk.store.receipts.find((x) => x.event === "cli_abnormal_exit");
    assert.equal(rec.detail.signal, "SIGKILL");
  } finally {
    cleanup(dir);
  }
});

test("HP-5: an empty/malformed adapter capture (no exitCode) is fail-closed abnormal, not silently dropped", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-empty-capture";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => undefined; // adapter contract violation -- nothing captured
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.outcome, "cli_abnormal_exit", "an empty capture must fail closed, never silently classify as done");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// I2 proof: adapter is invoked strictly after RUNNING is persisted, and a save failure
// prevents the adapter from ever running (mirrors R6-1 at the supervisor composition layer).
// ---------------------------------------------------------------------------

test("I2-1: adapter observes RUNNING already on disk when it runs (save-before-call)", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-i2";
  try {
    seedArm(dir, arm_id);
    let diskStateWhenCalled = null;
    const adapterFn = () => {
      diskStateWhenCalled = loadStore(armStorePath(dir, arm_id)).store.state;
      return { exitCode: 0, signal: null };
    };
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, true);
    assert.equal(diskStateWhenCalled, STATE.RUNNING, "RUNNING must be on disk strictly before the adapter is invoked");
  } finally {
    cleanup(dir);
  }
});

test("I2-2: a failing store save prevents the adapter from ever being invoked (fail-closed, no phantom call)", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-i2-fail";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    // claimTx's own save must succeed (so the run actually reaches the start phase) --
    // only the *second* store save (startTx persisting RUNNING) is made to fail.
    let storeWrites = 0;
    const failWrite = (p, c) => {
      if (String(p).includes(".store.json")) {
        storeWrites++;
        if (storeWrites >= 2) throw new Error("simulated disk full on RUNNING save");
      }
      return writeFileSync(p, c, "utf8");
    };
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn, writeFileFn: failWrite });
    assert.equal(r.phase, "start");
    assert.equal(r.ok, false);
    assert.equal(adapterFn.count(), 0, "the adapter must never be called if RUNNING could not be persisted first");
  } finally {
    cleanup(dir);
  }
});

test("I2-3 (mirrors R6-1e): adapterFn throwing is classified as startup_failure by existing group-3/4 machinery, exactly once", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-i2-throw";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => { throw new Error("spawn ENOENT: engine binary not found"); };
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.phase, "start");
    assert.equal(adapterFn.count(), 1, "adapter is invoked exactly once even when it throws -- no retry");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.ERROR);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 재시작 복구(설계확정-v1.md §1): CLAIMED/RUNNING인 채 재시작 발견 시 자동 재실행 0,
// PAUSED로 표시만 -- claim/adapter 호출 자체가 발생하지 않는다.
// ---------------------------------------------------------------------------

test("RESTART-1: a pre-existing RUNNING arm is recovered (PAUSED), no claim/adapter attempted this turn", () => {
  const dir = freshDir();
  const arm_id = "arm-sup-restart";
  try {
    seedArm(dir, arm_id);
    // simulate a supervisor crash mid-attempt: drive a genuine claim+start through the real
    // group-1/3 Tx machinery (so the on-disk claim marker exists, like real production state)
    // and stop there -- this invocation is the "restarted supervisor" finding it RUNNING.
    const path = armStorePath(dir, arm_id);
    const claimed = claimTx(dir, arm_id, makeTask(), { nowFn: NOW_OK });
    assert.equal(claimed.ok, true, "setup: claim must succeed");
    const started = startTx(dir, arm_id, { task_id: "HYK-141-coder-1", attempt_id: "attempt-1", at: "t1" }, { nowFn: NOW_OK, spawnFn: () => {} });
    assert.equal(started.ok, true, "setup: start must succeed");
    assert.equal(loadStore(path).store.state, STATE.RUNNING, "setup: arm must be genuinely RUNNING on disk before the 'restart'");

    const adapterFn = counter();
    const r = mod.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.phase, "restart_recovery");
    assert.equal(r.ok, true);
    assert.equal(adapterFn.count(), 0, "restart recovery must never invoke the adapter");

    const disk = loadStore(path);
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART);
    assert.equal(disk.store.needs_human_ack, true);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// G10: 사람 게이트(publish/서명/push/PR) 호출 경로 감시 -- 소스 텍스트 직접 스캔.
// child_process(실제 프로세스 기동)도 이 모듈엔 있으면 안 된다(어댑터는 5B 몫, 여기는
// 주입 인터페이스만).
// ---------------------------------------------------------------------------

test("G10: source contains no human-gate call sites and no process-spawning of its own", () => {
  const src = readFileSync(fileURLToPath(new URL("./go-wait-supervisor.mjs", import.meta.url)), "utf8");
  const forbidden = [
    "child_process",
    "execSync",
    "spawnSync",
    /\bexeca?\(/,
    "sign.sh",
    "bot-push-pr",
    /git\s+push/,
    /gh\s+pr/,
    "git push",
  ];
  for (const pattern of forbidden) {
    if (pattern instanceof RegExp) {
      assert.equal(pattern.test(src), false, `source must not match ${pattern}`);
    } else {
      assert.equal(src.includes(pattern), false, `source must not contain '${pattern}'`);
    }
  }
});

// ---------------------------------------------------------------------------
// 입력 경계: malformed 입력에도 throw 없이 fail-closed.
// ---------------------------------------------------------------------------

test("input-boundary: exported functions never throw on malformed input", () => {
  const dir = freshDir();
  try {
    assert.doesNotThrow(() => mod.ownConsumptionProblems(undefined, undefined));
    assert.ok(mod.ownConsumptionProblems(undefined, undefined).length > 0);
    assert.doesNotThrow(() => mod.ownConsumptionProblems(null, null));
    assert.doesNotThrow(() => mod.classifyAttemptResult(undefined));
    assert.equal(mod.classifyAttemptResult(undefined).outcome, "cli_abnormal_exit");
    assert.doesNotThrow(() => mod.classifyAttemptResult(null));
    assert.doesNotThrow(() => mod.runSupervisedAttempt(undefined, undefined, undefined, undefined, undefined));
    assert.equal(mod.runSupervisedAttempt(undefined, undefined, undefined, undefined, {}).ok, false);
    assert.doesNotThrow(() => mod.runSupervisedAttempt(dir, "arm-nostore", SCOPE, makeTask(), { nowFn: NOW_OK }));
    const noStore = mod.runSupervisedAttempt(dir, "arm-nostore", SCOPE, makeTask(), { nowFn: NOW_OK, adapterFn: () => ({ exitCode: 0 }) });
    assert.equal(noStore.ok, false);
  } finally {
    cleanup(dir);
  }
});

test("EXPECTED_EXIT_CODES is a fixed frozen array (single declaration, no silent drift)", () => {
  assert.deepEqual(mod.EXPECTED_EXIT_CODES, [0]);
  assert.equal(Object.isFrozen(mod.EXPECTED_EXIT_CODES), true);
});
