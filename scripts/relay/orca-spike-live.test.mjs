import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkPreDispatch } from "./orca-predispatch.mjs";
import {
  createLiveExecFn,
  mapCheckResponse,
  writeRawDump,
  shouldRunLive,
} from "./orca-spike-live.mjs";
import {
  buildSyntheticFixture,
  DEFAULT_TASK_ID,
} from "./orca-spike-fixtures.mjs";

const GOOD_OPTS = Object.freeze({
  human_approval_ref: "한용 2026-07-19 10:54",
  arm_id: "arm-spike-live-1",
  cycle_id: "cycle-spike-live-1",
  issued_at: "2026-07-19T01:54:00.000Z",
  expires_at: "2026-07-19T02:54:00.000Z",
  target: "coder-terminal-live",
  nowMs: Date.parse("2026-07-19T01:54:30.000Z"),
});

function withFixture(overrides, fn) {
  const fixture = buildSyntheticFixture({ ...GOOD_OPTS, ...overrides });
  assert.equal(fixture.ok, true, fixture.reason);
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

// ---- 합성 입력 구성 정확성 ----
test("(1) known-good: buildSyntheticFixture output makes checkPreDispatch ALLOW", () => {
  withFixture({}, (fixture) => {
    const result = checkPreDispatch(fixture.predispatch, {});
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.allow, true);
    assert.equal(fixture.task_id, DEFAULT_TASK_ID);
  });
});

test("(2) known-bad: content_hash mismatch (task file mutated after hash computed) -> deny", () => {
  withFixture({}, (fixture) => {
    const tampered = {
      ...fixture.predispatch,
      request: { ...fixture.predispatch.request, content_hash: "0".repeat(64) },
    };
    const result = checkPreDispatch(tampered, {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /CONTENT_HASH_MISMATCH|TASK_ID_MISMATCH/);
  });
});

test("(3) known-bad: target mismatch (request.target != expected.target) -> deny", () => {
  withFixture({}, (fixture) => {
    const tampered = {
      ...fixture.predispatch,
      request: {
        ...fixture.predispatch.request,
        target: "some-other-terminal",
      },
    };
    const result = checkPreDispatch(tampered, {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /TARGET_MISMATCH/);
  });
});

test("(4) buildSyntheticFixture refuses missing required opts (fail-closed, no partial fixture)", () => {
  const result = buildSyntheticFixture({ ...GOOD_OPTS, arm_id: undefined });
  assert.equal(result.ok, false);
  assert.match(result.reason, /arm_id/);
});

// ---- 실 orca execFn 어댑터: argv passthrough + JSON 파싱 ----
function fakeSpawnSyncFn(responses) {
  const calls = [];
  const fn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const next = responses[calls.length - 1];
    return next ?? { stdout: "{}", stderr: "", status: 0 };
  };
  fn.calls = calls;
  return fn;
}

test("(5) argv passthrough: execFn calls spawnSyncFn with 'orca' + exact argv, shell:false", () => {
  const spawnSyncFn = fakeSpawnSyncFn([
    { stdout: '{"ok":true}', stderr: "", status: 0 },
  ]);
  const execFn = createLiveExecFn({ spawnSyncFn });
  const argv = ["orchestration", "task-create", "--spec", "go X", "--json"];
  execFn(argv);
  assert.equal(spawnSyncFn.calls.length, 1);
  assert.equal(spawnSyncFn.calls[0].cmd, "orca");
  assert.deepEqual(spawnSyncFn.calls[0].argv, argv);
  assert.equal(spawnSyncFn.calls[0].opts.shell, false);
  assert.equal(spawnSyncFn.calls[0].opts.encoding, "utf8");
});

test("(6) task-create/dispatch responses pass through stdout JSON verbatim", () => {
  const parsed = {
    ok: true,
    result: { task: { id: "task_abc123", status: "ready" } },
  };
  const spawnSyncFn = fakeSpawnSyncFn([
    { stdout: JSON.stringify(parsed), stderr: "", status: 0 },
  ]);
  const execFn = createLiveExecFn({ spawnSyncFn });
  const response = execFn([
    "orchestration",
    "task-create",
    "--spec",
    "go X",
    "--json",
  ]);
  assert.deepEqual(response, parsed);
});

test("(7) known-bad: invalid JSON on stdout -> fail-closed {ok:false}, not a thrown parse error", () => {
  const spawnSyncFn = fakeSpawnSyncFn([
    { stdout: "not json {{{", stderr: "", status: 0 },
  ]);
  const execFn = createLiveExecFn({ spawnSyncFn });
  const response = execFn([
    "orchestration",
    "dispatch",
    "--task",
    "x",
    "--to",
    "y",
    "--inject",
    "--json",
  ]);
  assert.equal(response.ok, false);
  assert.match(response.reason, /not valid JSON/);
});

test("(8) known-bad: orca process never starts (ENOENT-style spawnSync error) -> fail-closed, no throw", () => {
  const spawnSyncFn = () => ({
    error: new Error("ENOENT: orca not found"),
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
  });
  const execFn = createLiveExecFn({ spawnSyncFn });
  const response = execFn([
    "orchestration",
    "check",
    "--terminal",
    "x",
    "--types",
    "worker_done,escalation",
    "--wait",
    "--timeout-ms",
    "1000",
    "--json",
  ]);
  assert.equal(response.ok, false);
  assert.match(response.reason, /never started/);
});

// ---- check 응답 매핑 ----
test("(9) mapCheckResponse: a worker_done-typed message maps to outcome worker_done", () => {
  const r = mapCheckResponse({
    ok: true,
    result: { messages: [{ type: "worker_done", payload: {} }], count: 1 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "worker_done");
  assert.equal(r.raw.result.messages[0].type, "worker_done");
});
test("(10) mapCheckResponse: an escalation-typed message maps to outcome escalation", () => {
  const r = mapCheckResponse({
    ok: true,
    result: { messages: [{ type: "escalation" }], count: 1 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "escalation");
});
test("(11) mapCheckResponse: empty messages array maps to outcome timeout", () => {
  const r = mapCheckResponse({ ok: true, result: { messages: [], count: 0 } });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "timeout");
});
test("(11b) mapCheckResponse: messages present but none worker_done/escalation also maps to timeout", () => {
  const r = mapCheckResponse({
    ok: true,
    result: { messages: [{ type: "keepalive" }], count: 1 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "timeout");
});
test("(12) mapCheckResponse: check response ok:false is rejected, not coerced into an outcome", () => {
  const r = mapCheckResponse({ ok: false, reason: "orca: check rejected" });
  assert.equal(r.ok, false);
});

// end-to-end through the check step of createLiveExecFn (mapping applied only to `check`)
test("(13) createLiveExecFn applies mapCheckResponse only to the check step, not task-create/dispatch", () => {
  const checkRaw = {
    ok: true,
    result: { messages: [{ type: "worker_done" }], count: 1 },
  };
  const spawnSyncFn = fakeSpawnSyncFn([
    { stdout: JSON.stringify(checkRaw), stderr: "", status: 0 },
  ]);
  const execFn = createLiveExecFn({ spawnSyncFn });
  const response = execFn([
    "orchestration",
    "check",
    "--terminal",
    "x",
    "--types",
    "worker_done,escalation",
    "--wait",
    "--timeout-ms",
    "1000",
    "--json",
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.outcome, "worker_done");
  assert.deepEqual(response.raw, checkRaw);
});

// ---- 원형 덤프: 손실 없음, 매핑 성공 여부와 무관 ----
test("(14) dumps capture every step verbatim (including a failed one), independent of mapping outcome", () => {
  const spawnSyncFn = fakeSpawnSyncFn([
    {
      stdout: '{"ok":true,"result":{"task":{"id":"task_x"}}}',
      stderr: "",
      status: 0,
    },
    { stdout: "garbage", stderr: "warn: something", status: 0 },
  ]);
  const execFn = createLiveExecFn({ spawnSyncFn });
  execFn(["orchestration", "task-create", "--spec", "go X", "--json"]);
  execFn([
    "orchestration",
    "dispatch",
    "--task",
    "task_x",
    "--to",
    "y",
    "--inject",
    "--json",
  ]);
  assert.equal(execFn.dumps.length, 2);
  assert.equal(execFn.dumps[0].parsed.result.task.id, "task_x");
  assert.equal(execFn.dumps[1].parseError !== null, true);
  assert.equal(execFn.dumps[1].stdout, "garbage");
  assert.equal(execFn.dumps[1].stderr, "warn: something");
});

test("(15) writeRawDump persists the exact dumps array losslessly", () => {
  withFixture({}, (fixture) => {
    const spawnSyncFn = fakeSpawnSyncFn([
      { stdout: '{"ok":true}', stderr: "", status: 0 },
    ]);
    const execFn = createLiveExecFn({ spawnSyncFn });
    execFn(["orchestration", "task-create", "--spec", "go X", "--json"]);
    const dumpPath = join(fixture.dir, "dump.json");
    writeRawDump(dumpPath, execFn.dumps);
    const parsed = JSON.parse(readFileSync(dumpPath, "utf8"));
    assert.deepEqual(parsed, execFn.dumps);
  });
});

// ---- CLI 오발사 방지: --live 없으면 실행 안 함(guard 단위 테스트, invokedDirectly 블록은
// 이 테스트 파일 경로가 다르므로 애초에 트리거되지 않는다 -- 이 테스트는 shouldRunLive만 검증) ----
test("(16) shouldRunLive is false without --live (no accidental live firing)", () => {
  assert.equal(shouldRunLive(["node", "orca-spike-live.mjs"]), false);
  assert.equal(shouldRunLive([]), false);
  assert.equal(shouldRunLive(null), false);
});
test("(17) shouldRunLive is true only when --live is explicitly present", () => {
  assert.equal(shouldRunLive(["node", "orca-spike-live.mjs", "--live"]), true);
});
