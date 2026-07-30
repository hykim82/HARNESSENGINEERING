import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync as realSpawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as mod from "./claude-adapter.mjs";
import {
  createArmStore,
  saveStoreAtomic,
  loadStore,
  armStorePath,
  STATE,
  DISARM_CAUSE,
} from "./arm-state.mjs";
import { runSupervisedAttempt } from "./go-wait-supervisor.mjs";

// Gate refs = 패킷-초안.md §4 그룹5(5B: 어댑터 2 + 합성 E2E). arm-state.mjs·
// go-wait-supervisor.mjs는 import만 -- 여기서는 claude-adapter가 5A의 adapterFn 계약을
// 옳게 구현하는지, 그리고 supervisor+adapter(fake 엔진) 실조합이 옳게 동작하는지만 본다.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "claude-adapter-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeFakeScript(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

const FAKE_DONE = `process.exit(0);\n`;
const FAKE_ABNORMAL = `process.exit(7);\n`;
const FAKE_QUESTION = `console.log('question_packet:');\nconsole.log('  question_id: "Q-20260714-01"');\nprocess.exit(0);\n`;
const FAKE_SILENT = `process.exit(0);\n`;
const FAKE_HANG = `setInterval(() => {}, 1000);\n`; // never exits on its own -- used with a spawnSync timeout

// ---------------------------------------------------------------------------
// pure: question_packet 감지 + exec-result 분류
// ---------------------------------------------------------------------------

test("detectQuestionPacket: recognizes the template's question_packet: block + question_id", () => {
  const text =
    'noise\nquestion_packet:\n  question_id: "Q-20260714-07"\n  from_role: Coder\n';
  const q = mod.detectQuestionPacket(text);
  assert.deepEqual(q, { question_id: "Q-20260714-07" });
});

test("detectQuestionPacket: no marker -> null; marker without question_id -> null (fail-closed, not a guess)", () => {
  assert.equal(mod.detectQuestionPacket("plain output, nothing special"), null);
  assert.equal(
    mod.detectQuestionPacket("question_packet:\n  from_role: Coder\n"),
    null,
  );
  assert.equal(mod.detectQuestionPacket(undefined), null);
  assert.equal(mod.detectQuestionPacket(null), null);
});

test("classifyExecResult: exit 0 with no question -> {exitCode:0, signal:null}, no 'question' key", () => {
  const r = mod.classifyExecResult({
    status: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
  });
  assert.deepEqual(r, { exitCode: 0, signal: null });
  assert.equal("question" in r, false);
});

test("classifyExecResult: signal present is preserved verbatim (no silent loss)", () => {
  const r = mod.classifyExecResult({
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  });
  assert.equal(r.signal, "SIGTERM");
});

test("classifyExecResult: question_packet in stdout takes priority, exitCode/signal still attached", () => {
  const r = mod.classifyExecResult({
    status: 0,
    signal: null,
    stdout: 'question_packet:\n  question_id: "Q-1"\n',
    stderr: "",
  });
  assert.deepEqual(r, {
    exitCode: 0,
    signal: null,
    question: { question_id: "Q-1" },
  });
});

test("classifyExecResult: malformed raw (undefined/null) is fail-closed to null exitCode, never throws", () => {
  assert.doesNotThrow(() => mod.classifyExecResult(undefined));
  assert.deepEqual(mod.classifyExecResult(undefined), {
    exitCode: null,
    signal: null,
  });
  assert.doesNotThrow(() => mod.classifyExecResult(null));
});

// ---------------------------------------------------------------------------
// no-shell + explicit-args + no-ambient-env: injected spy captures the exact spawnSync call.
// ---------------------------------------------------------------------------

test("createClaudeAdapterFn: invokes spawnSyncFn with shell:false, array args, explicit-only env (no process.env passthrough)", () => {
  let captured = null;
  const spawnSyncFn = (command, args, options) => {
    captured = { command, args, options };
    return { status: 0, signal: null, stdout: "", stderr: "" };
  };
  const adapterFn = mod.createClaudeAdapterFn({
    command: "claude",
    spawnSyncFn,
  });
  const r = adapterFn({
    task_id: "T-1",
    attempt_id: "A-1",
    cwd: "C:/work",
    lane: "coder",
    config: "p.json",
    at: "t",
  });
  assert.equal(r.exitCode, 0);
  assert.equal(captured.command, "claude");
  assert.ok(
    Array.isArray(captured.args),
    "args must be a plain array (no shell string concatenation)",
  );
  assert.ok(captured.args.includes("T-1"));
  assert.ok(captured.args.includes("A-1"));
  assert.equal(
    captured.options.shell,
    false,
    "shell must be explicitly false -- no shell interpretation of args",
  );
  assert.equal(captured.options.cwd, "C:/work");
  assert.deepEqual(
    captured.options.env,
    {},
    "no config.env supplied -> child gets an explicit empty env, never process.env",
  );
});

test("createClaudeAdapterFn: env is explicit-only -- only keys passed via config.env reach the child (no ambient secret leakage)", () => {
  let captured = null;
  const spawnSyncFn = (command, args, options) => {
    captured = options;
    return { status: 0, signal: null, stdout: "", stderr: "" };
  };
  const adapterFn = mod.createClaudeAdapterFn({
    spawnSyncFn,
    env: { SAFE_FLAG: "1" },
  });
  adapterFn({ task_id: "T", attempt_id: "A", cwd: "C:/work" });
  assert.deepEqual(captured.env, { SAFE_FLAG: "1" });
});

test("createClaudeAdapterFn: a spawnSyncFn 'error' result (e.g. ENOENT) throws -- absorbed by existing startup_failure path, not re-handled here", () => {
  const spawnSyncFn = () => ({
    error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
  });
  const adapterFn = mod.createClaudeAdapterFn({ spawnSyncFn });
  assert.throws(() => adapterFn({ task_id: "T", attempt_id: "A" }), /ENOENT/);
});

// ---------------------------------------------------------------------------
// 합성 E2E: 실제 spawnSync + 폐기 가능한 fake node 스크립트(실 Claude 바이너리 0).
// ---------------------------------------------------------------------------

test("E2E-real-process: a real spawnSync against a fake exit-0 script yields {exitCode:0, signal:null}", () => {
  const dir = freshDir();
  try {
    const script = writeFakeScript(dir, "fake-done.mjs", FAKE_DONE);
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
    });
    const r = adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: dir });
    assert.deepEqual(r, { exitCode: 0, signal: null });
  } finally {
    cleanup(dir);
  }
});

test("E2E-real-process: a fake abnormal-exit script yields the real exit code, no loss", () => {
  const dir = freshDir();
  try {
    const script = writeFakeScript(dir, "fake-abnormal.mjs", FAKE_ABNORMAL);
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
    });
    const r = adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: dir });
    assert.deepEqual(r, { exitCode: 7, signal: null });
  } finally {
    cleanup(dir);
  }
});

test("E2E-real-process: a fake script emitting a question_packet: block is detected with the right question_id", () => {
  const dir = freshDir();
  try {
    const script = writeFakeScript(dir, "fake-question.mjs", FAKE_QUESTION);
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
    });
    const r = adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: dir });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.question, { question_id: "Q-20260714-01" });
  } finally {
    cleanup(dir);
  }
});

test("E2E-real-process: a silent (no-output) clean exit is classified purely by exit code, no question", () => {
  const dir = freshDir();
  try {
    const script = writeFakeScript(dir, "fake-silent.mjs", FAKE_SILENT);
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
    });
    const r = adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: dir });
    assert.deepEqual(r, { exitCode: 0, signal: null });
  } finally {
    cleanup(dir);
  }
});

test("E2E-real-process: an unreachable command (ENOENT) throws through the real spawnSync path (no fake stub)", () => {
  const dir = freshDir();
  try {
    const adapterFn = mod.createClaudeAdapterFn({
      command: join(dir, "definitely-does-not-exist-binary"),
    });
    assert.throws(() =>
      adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: dir }),
    );
  } finally {
    cleanup(dir);
  }
});

test("E2E-real-process: a hung script is killed deterministically via spawnSync timeout, signal observed (join 결정론)", () => {
  const dir = freshDir();
  try {
    const script = writeFakeScript(dir, "fake-hang.mjs", FAKE_HANG);
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
      spawnSyncFn: (cmd, args, opts) => {
        return realSpawnSync(cmd, args, { ...opts, timeout: 500 });
      },
    });
    const r = adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: dir });
    assert.notEqual(
      r.signal,
      null,
      "a timeout-killed process must report a non-null signal, not silently vanish (it ran -- not a startup_failure)",
    );
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 합성 E2E(전체 조합): supervisor(5A, arm-state 경유) + claude-adapter(fake 엔진)
// -- arm 발급→claim→선저장→기동 1회→종료→receipt 디스크 왕복. oracle: adapter 추가
// 기동 0 · 게이트 호출 0(런타임 감시, review-1 관찰 ⓐ 반영) · uncaught throw 0.
// ---------------------------------------------------------------------------

function makeGrant(overrides = {}) {
  return {
    arm_id: "arm-e2e",
    cycle_id: "cycle-1",
    human_approval_ref: "sign-1",
    issued_at: "2026-07-14T21:00:00.000Z",
    expires_at: "2026-07-14T23:00:00.000Z",
    allowed_lanes: ["coder"],
    allowed_task_ids: ["HYK-141-coder-2"],
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
  const created = createArmStore(makeGrant({ arm_id, ...grantOverrides }), {
    at: "t0",
  });
  assert.equal(created.ok, true);
  const saved = saveStoreAtomic(armStorePath(dir, arm_id), created.store);
  assert.equal(saved.ok, true);
}
function makeScope(dir) {
  return {
    lane: "coder",
    cwd: dir,
    config: "coder-profile.json",
    allowedTaskIds: ["HYK-141-coder-2"],
  };
}
function makeE2ETask(dir) {
  return {
    task_id: "HYK-141-coder-2",
    lane: "coder",
    cycle_id: "cycle-1",
    attempt_id: "attempt-1",
    content_hash: "h",
    at: "t1",
    cwd: dir,
    config: "coder-profile.json",
  };
}
const NOW_OK = () => Date.parse("2026-07-14T21:30:00.000Z");

// wraps a real spawnSyncFn (or the module default) with a runtime call-log canary --
// review-1 관찰 ⓐ: 정적 소스 스캔 외에, 실제로 무엇이 실행됐는지 실측 로그로도 감시한다.
function canarySpawnSync() {
  const log = [];
  const fn = (command, args, options) => {
    log.push({ command, args: [...args] });
    return realSpawnSync(command, args, options);
  };
  fn.log = log;
  return fn;
}

test("SYNTH-E2E-1: full arm lifecycle with a real fake-engine process -- done outcome, exactly one process spawned, no gate commands observed", () => {
  const dir = freshDir();
  const arm_id = "arm-e2e-done";
  try {
    seedArm(dir, arm_id);
    const script = writeFakeScript(dir, "fake-done.mjs", FAKE_DONE);
    const spawnSyncFn = canarySpawnSync();
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
      spawnSyncFn,
    });
    const task = makeE2ETask(dir);

    const r = runSupervisedAttempt(dir, arm_id, makeScope(dir), task, {
      nowFn: NOW_OK,
      adapterFn,
    });
    assert.equal(r.ok, true, `E2E must succeed: ${JSON.stringify(r)}`);
    assert.equal(r.outcome, "done");

    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.COMPLETE);

    assert.equal(
      spawnSyncFn.log.length,
      1,
      "the real engine process must be spawned exactly once (G7)",
    );
    const forbidden = ["push", "gh", "sign.sh", "bot-push-pr"];
    for (const entry of spawnSyncFn.log) {
      const joined = `${entry.command} ${entry.args.join(" ")}`.toLowerCase();
      for (const bad of forbidden) {
        assert.equal(
          joined.includes(bad),
          false,
          `runtime-observed spawn call must not reference '${bad}' (G10 runtime canary): ${joined}`,
        );
      }
    }
  } finally {
    cleanup(dir);
  }
});

test("SYNTH-E2E-2: question outcome -- disarmed immediately, no auto-resume, exactly one spawn", () => {
  const dir = freshDir();
  const arm_id = "arm-e2e-question";
  try {
    seedArm(dir, arm_id);
    const script = writeFakeScript(dir, "fake-question.mjs", FAKE_QUESTION);
    const spawnSyncFn = canarySpawnSync();
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
      spawnSyncFn,
    });
    const task = makeE2ETask(dir);

    const r = runSupervisedAttempt(dir, arm_id, makeScope(dir), task, {
      nowFn: NOW_OK,
      adapterFn,
    });
    assert.equal(r.outcome, "question");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.QUESTION);
    assert.equal(
      disk.store.receipts.find((x) => x.event === "question").detail
        .question_id,
      "Q-20260714-01",
    );
    assert.equal(
      spawnSyncFn.log.length,
      1,
      "one question observation must not trigger any further spawn",
    );
  } finally {
    cleanup(dir);
  }
});

test("SYNTH-E2E-3: abnormal-exit outcome -- exit code preserved end-to-end from real process to disk receipt", () => {
  const dir = freshDir();
  const arm_id = "arm-e2e-abnormal";
  try {
    seedArm(dir, arm_id);
    const script = writeFakeScript(dir, "fake-abnormal.mjs", FAKE_ABNORMAL);
    const spawnSyncFn = canarySpawnSync();
    const adapterFn = mod.createClaudeAdapterFn({
      command: process.execPath,
      baseArgs: [script],
      spawnSyncFn,
    });
    const task = makeE2ETask(dir);

    const r = runSupervisedAttempt(dir, arm_id, makeScope(dir), task, {
      nowFn: NOW_OK,
      adapterFn,
    });
    assert.equal(r.outcome, "cli_abnormal_exit");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(
      disk.store.receipts.find((x) => x.event === "cli_abnormal_exit").detail
        .exitCode,
      7,
    );
    assert.equal(spawnSyncFn.log.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("SYNTH-E2E-4: an ENOENT engine binary is classified startup_failure by existing group-3/4 machinery, no uncaught throw escapes runSupervisedAttempt", () => {
  const dir = freshDir();
  const arm_id = "arm-e2e-enoent";
  try {
    seedArm(dir, arm_id);
    const adapterFn = mod.createClaudeAdapterFn({
      command: join(dir, "no-such-binary"),
    });
    const task = makeE2ETask(dir);

    let result;
    assert.doesNotThrow(() => {
      result = runSupervisedAttempt(dir, arm_id, makeScope(dir), task, {
        nowFn: NOW_OK,
        adapterFn,
      });
    }, "I4: an adapter throw must never escape as an uncaught exception");
    assert.equal(result.phase, "start");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.ERROR);
  } finally {
    cleanup(dir);
  }
});

test("G10: claude-adapter source contains no human-gate call sites (static scan, complements the runtime canary above)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./claude-adapter.mjs", import.meta.url)),
    "utf8",
  );
  for (const bad of [
    "execSync",
    "sign.sh",
    "bot-push-pr",
    "git push",
    "gh pr",
  ]) {
    assert.equal(src.includes(bad), false, `source must not contain '${bad}'`);
  }
  assert.equal(/\bgit\s+push\b/.test(src), false);
  assert.equal(/\bgh\s+pr\b/.test(src), false);
});

// ---------------------------------------------------------------------------
// review-2 regression (coder-3, RED->GREEN): block-boundary false-positive.
// question_id must belong to the SAME question_packet: block (a deeper-indented,
// contiguous run right after the marker line) -- not merely co-occur anywhere in
// the document. Fixes the exact review-2 direct reproduction.
// ---------------------------------------------------------------------------

test("G-FP-1 (review-2 regression): a prose sentence mentioning 'question_packet:' plus an unrelated question_id elsewhere is NOT detected", () => {
  const prose =
    'I reviewed the question_packet: template documentation.\nSome other content.\nquestion_id: "not-a-packet"\n';
  assert.equal(
    mod.detectQuestionPacket(prose),
    null,
    "marker embedded mid-sentence + unrelated question_id must not false-positive",
  );
});

test("G-FP-2: a real question_packet: block still detects correctly after the fix (no regression on the true-positive path)", () => {
  const real =
    'question_packet:\n  issue: "HYK-141"\n  question_id: "Q-20260714-09"\n  from_role: "Coder"\n';
  assert.deepEqual(mod.detectQuestionPacket(real), {
    question_id: "Q-20260714-09",
  });
});

test("G-FP-3: marker line alone (no indented children at all) does not detect", () => {
  assert.equal(mod.detectQuestionPacket("question_packet:\n"), null);
  assert.equal(
    mod.detectQuestionPacket(
      'question_packet:\nnext line has no indent\nquestion_id: "x"\n',
    ),
    null,
  );
});

test("G-FP-4: question_id at the SAME or SHALLOWER indent as the marker (a sibling key, not a child) is out of the block", () => {
  const sibling = 'question_packet:\nquestion_id: "sibling-not-child"\n'; // 0 indent for both -> sibling
  assert.equal(mod.detectQuestionPacket(sibling), null);
});

test("G-FP-5: a blank line breaks the block -- question_id after a blank line following the marker is out of scope", () => {
  const broken = 'question_packet:\n\n  question_id: "after-blank-line"\n';
  assert.equal(mod.detectQuestionPacket(broken), null);
});

test("G-FP-6: an indented marker (nested under something else) still scopes its own deeper-indented block correctly", () => {
  const nested = 'notes:\n  question_packet:\n    question_id: "Q-nested-1"\n';
  assert.deepEqual(mod.detectQuestionPacket(nested), {
    question_id: "Q-nested-1",
  });
});

test("G-FP-7: two markers in one document -- an unrelated marker earlier with no valid child must not suppress a later real block", () => {
  const doc =
    'question_packet:\nno child here\n\nquestion_packet:\n  question_id: "Q-second-block"\n';
  assert.deepEqual(mod.detectQuestionPacket(doc), {
    question_id: "Q-second-block",
  });
});
