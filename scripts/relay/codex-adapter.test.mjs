import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mod from "./codex-adapter.mjs";
import { createArmStore, saveStoreAtomic, loadStore, armStorePath, STATE, DISARM_CAUSE } from "./arm-state.mjs";
import { runSupervisedAttempt } from "./go-wait-supervisor.mjs";

// Gate refs = 패킷-초안.md §4 그룹5(5B). claude-adapter.test.mjs가 detectQuestionPacket/
// classifyExecResult/no-shell/no-ambient-env/합성 조합 전 범위를 실측했다(동일 구조,
// codex-adapter.mjs도 문자 그대로 같은 함수 형태) -- 여기서는 codex 고유 구성(`exec`
// 기본 인자)과 전체 조합 1회를 실증해 중복 없이 커버리지를 닫는다.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "codex-adapter-test-"));
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
const FAKE_QUESTION = `console.log('question_packet:');\nconsole.log('  question_id: "Q-20260714-02"');\nprocess.exit(0);\n`;

test("createCodexAdapterFn: default baseArgs is ['exec'] (리서치 §1 'codex exec' 정론), shell:false, explicit-only env", () => {
  let captured = null;
  const spawnSyncFn = (command, args, options) => { captured = { command, args, options }; return { status: 0, signal: null, stdout: "", stderr: "" }; };
  const adapterFn = mod.createCodexAdapterFn({ spawnSyncFn });
  adapterFn({ task_id: "T-1", attempt_id: "A-1", cwd: "C:/work" });
  assert.equal(captured.command, "codex");
  assert.equal(captured.args[0], "exec");
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.options.env, {});
});

test("classifyExecResult/detectQuestionPacket: same contract as claude-adapter (question priority, no silent loss)", () => {
  assert.deepEqual(mod.classifyExecResult({ status: 0, signal: null, stdout: "", stderr: "" }), { exitCode: 0, signal: null });
  assert.deepEqual(mod.detectQuestionPacket('question_packet:\n  question_id: "Q-2"\n'), { question_id: "Q-2" });
  assert.equal(mod.detectQuestionPacket("no marker here"), null);
});

test("createCodexAdapterFn: a spawnSyncFn error with no signal/status (ENOENT-shape) throws", () => {
  const spawnSyncFn = () => ({ error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) });
  const adapterFn = mod.createCodexAdapterFn({ spawnSyncFn });
  assert.throws(() => adapterFn({ task_id: "T", attempt_id: "A" }), /ENOENT/);
});

test("createCodexAdapterFn: a spawnSyncFn error that also carries a signal (timeout-kill shape) does not throw -- classified with the signal", () => {
  const spawnSyncFn = () => ({ error: new Error("timeout"), status: null, signal: "SIGTERM", stdout: "", stderr: "" });
  const adapterFn = mod.createCodexAdapterFn({ spawnSyncFn });
  const r = adapterFn({ task_id: "T", attempt_id: "A" });
  assert.equal(r.signal, "SIGTERM");
});

function makeGrant(overrides = {}) {
  return {
    arm_id: "arm-e2e-codex",
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
  const created = createArmStore(makeGrant({ arm_id, ...grantOverrides }), { at: "t0" });
  assert.equal(created.ok, true);
  const saved = saveStoreAtomic(armStorePath(dir, arm_id), created.store);
  assert.equal(saved.ok, true);
}
function makeScope(dir) {
  return { lane: "coder", cwd: dir, config: "coder-profile.json", allowedTaskIds: ["HYK-141-coder-2"] };
}
function makeE2ETask(dir) {
  return { task_id: "HYK-141-coder-2", lane: "coder", cycle_id: "cycle-1", attempt_id: "attempt-1", content_hash: "h", at: "t1", cwd: dir, config: "coder-profile.json" };
}
const NOW_OK = () => Date.parse("2026-07-14T21:30:00.000Z");

test("SYNTH-E2E-codex-done: full arm lifecycle with a real fake-engine process via codex-adapter", () => {
  const dir = freshDir();
  const arm_id = "arm-e2e-codex-done";
  try {
    seedArm(dir, arm_id);
    const script = writeFakeScript(dir, "fake-done.mjs", FAKE_DONE);
    const adapterFn = mod.createCodexAdapterFn({ command: process.execPath, baseArgs: [script] });
    const r = runSupervisedAttempt(dir, arm_id, makeScope(dir), makeE2ETask(dir), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.ok, true, `E2E must succeed: ${JSON.stringify(r)}`);
    assert.equal(r.outcome, "done");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.COMPLETE);
  } finally {
    cleanup(dir);
  }
});

test("SYNTH-E2E-codex-question: question outcome via codex-adapter disarms immediately, no auto-resume", () => {
  const dir = freshDir();
  const arm_id = "arm-e2e-codex-question";
  try {
    seedArm(dir, arm_id);
    const script = writeFakeScript(dir, "fake-question.mjs", FAKE_QUESTION);
    const adapterFn = mod.createCodexAdapterFn({ command: process.execPath, baseArgs: [script] });
    const r = runSupervisedAttempt(dir, arm_id, makeScope(dir), makeE2ETask(dir), { nowFn: NOW_OK, adapterFn });
    assert.equal(r.outcome, "question");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.QUESTION);
    assert.equal(disk.store.receipts.find((x) => x.event === "question").detail.question_id, "Q-20260714-02");
  } finally {
    cleanup(dir);
  }
});

test("G10: codex-adapter source contains no human-gate call sites", () => {
  const src = readFileSync(fileURLToPath(new URL("./codex-adapter.mjs", import.meta.url)), "utf8");
  for (const bad of ["execSync", "sign.sh", "bot-push-pr", "git push", "gh pr"]) {
    assert.equal(src.includes(bad), false, `source must not contain '${bad}'`);
  }
  assert.equal(/\bgit\s+push\b/.test(src), false);
  assert.equal(/\bgh\s+pr\b/.test(src), false);
});

// ---------------------------------------------------------------------------
// review-2 regression (coder-3, RED->GREEN): same block-boundary false-positive
// fix as claude-adapter.mjs -- codex-adapter.mjs has its own local detectQuestionPacket
// (no shared module per task's RG1 boundary), so it needs its own regression pin.
// ---------------------------------------------------------------------------

test("G-FP-1 (review-2 regression): a prose sentence mentioning 'question_packet:' plus an unrelated question_id elsewhere is NOT detected", () => {
  const prose = 'I reviewed the question_packet: template documentation.\nSome other content.\nquestion_id: "not-a-packet"\n';
  assert.equal(mod.detectQuestionPacket(prose), null);
});

test("G-FP-2: a real question_packet: block still detects correctly after the fix", () => {
  const real = 'question_packet:\n  issue: "HYK-141"\n  question_id: "Q-20260714-10"\n';
  assert.deepEqual(mod.detectQuestionPacket(real), { question_id: "Q-20260714-10" });
});

test("G-FP-3: question_id at the same/shallower indent as the marker (sibling, not child) is out of the block", () => {
  assert.equal(mod.detectQuestionPacket("question_packet:\nquestion_id: \"sibling-not-child\"\n"), null);
});

test("G-FP-4: a blank line breaks the block", () => {
  assert.equal(mod.detectQuestionPacket("question_packet:\n\n  question_id: \"after-blank-line\"\n"), null);
});
