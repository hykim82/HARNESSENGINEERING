// HYK-390 + HYK-392: 어댑터의 Orca «진위 조회» (createDispatchAuthLookup) 와
// createOrcaExecFn 의 시한 옵션. 전부 주입 stub -- 실 `orca` 실행 0.
// 마지막 시험은 어댑터 조회를 relay-handshake 소비 경로(그림자)에 결선해 «어댑터를
// 통한 조회 → 그림자 기록 → 소비 무변»을 프로덕션 진입점으로 이어 본다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDispatchAuthLookup,
  createOrcaExecFn,
  DISPATCH_AUTH_LOOKUP_TIMEOUT_MS,
} from "./orca-adapter.mjs";
import {
  checkRelayHandshake,
  configureAuthShadowDefaults,
} from "../../check/relay-handshake.mjs";

const SCRATCH = mkdtempSync(join(tmpdir(), "hyk390-adapter-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const showResponse = (dispatch) => ({ ok: true, result: { dispatch } });
const DISPATCH = {
  id: "ctx_1",
  task_id: "task_aaaaaaaaaaaa",
  assignee_pane_key: "p1:p2",
  status: "dispatched",
  assignee_handle: "term_secret_handle",
};

test("조회는 dispatch-show --task <id> --json 한 번만 부른다(읽기 전용 argv)", () => {
  const calls = [];
  const lookup = createDispatchAuthLookup({
    execFn: (argv) => {
      calls.push(argv);
      return showResponse(DISPATCH);
    },
  });
  const out = lookup({ runtimeTaskId: "task_aaaaaaaaaaaa" });
  assert.deepEqual(calls, [
    ["orchestration", "dispatch-show", "--task", "task_aaaaaaaaaaaa", "--json"],
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.found, true);
  assert.deepEqual(Object.keys(out.dispatch).sort(), [
    "assignee_pane_key",
    "id",
    "status",
    "task_id",
  ]);
  assert.equal(
    JSON.stringify(out).includes("term_secret_handle"),
    false,
    "handle 은 싣지 않는다",
  );
});

test("result.dispatch === null 은 «Orca 에 없다»(found:false) · 응답 불량은 «모른다»(ok:false)", () => {
  const nullOne = createDispatchAuthLookup({
    execFn: () => showResponse(null),
  });
  assert.deepEqual(nullOne({ runtimeTaskId: "task_x" }), {
    ok: true,
    found: false,
  });
  for (const bad of [
    { ok: false, reason: "x" },
    "garbage",
    null,
    { ok: true, result: {} },
    { ok: true, result: { dispatch: "str" } },
  ]) {
    const out = createDispatchAuthLookup({ execFn: () => bad })({
      runtimeTaskId: "task_x",
    });
    assert.equal(out.ok, false, `불량 응답 ${JSON.stringify(bad)} 는 ok:false`);
    assert.equal(out.found, undefined);
  }
  assert.equal(
    createDispatchAuthLookup({ execFn: () => showResponse(DISPATCH) })({}).ok,
    false,
  );
});

test("조회 중 던져진 예외는 ok:false · ETIMEDOUT 은 timedOut:true", () => {
  const boom = createDispatchAuthLookup({
    execFn: () => {
      throw new Error("spawn orca ENOENT");
    },
  })({ runtimeTaskId: "task_x" });
  assert.equal(boom.ok, false);
  assert.equal(boom.timedOut, undefined);
  const slow = createDispatchAuthLookup({
    execFn: () => {
      const e = new Error("ETIMEDOUT");
      e.code = "ETIMEDOUT";
      throw e;
    },
  })({ runtimeTaskId: "task_x" });
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
});

test("createOrcaExecFn: 시한을 주면 spawnSync 시한 옵션이 실리고 ETIMEDOUT 은 던져진다 · 안 주면 옛 옵션 모양 그대로", () => {
  const seen = [];
  const timeoutErr = Object.assign(new Error("spawnSync orca ETIMEDOUT"), {
    code: "ETIMEDOUT",
  });
  const withTimeout = createOrcaExecFn({
    timeoutMs: 1234,
    spawnSyncFn: (cmd, argv, opts) => {
      seen.push({ cmd, argv, opts });
      return { error: timeoutErr, signal: "SIGTERM", status: null, stdout: "" };
    },
  });
  assert.throws(() => withTimeout(["orchestration", "dispatch-show"]), {
    code: "ETIMEDOUT",
  });
  assert.deepEqual(seen[0].opts, {
    shell: false,
    encoding: "utf8",
    timeout: 1234,
  });
  const legacy = [];
  const noTimeout = createOrcaExecFn({
    spawnSyncFn: (cmd, argv, opts) => {
      legacy.push(opts);
      return { status: 0, stdout: JSON.stringify({ ok: true }) };
    },
  });
  assert.deepEqual(noTimeout(["x"]), { ok: true });
  assert.deepEqual(legacy[0], { shell: false, encoding: "utf8" });
  assert.equal(DISPATCH_AUTH_LOOKUP_TIMEOUT_MS, 10_000);
});

// 합성 라운드 + 위조 영수증 1줄(Orca 에 없는 dispatch)을 mkdtemp 아래에 만든다.
function makeForgedWorld() {
  const root = mkdtempSync(join(SCRATCH, "e2e-"));
  const harnessDir = join(root, "wt", ".harness");
  const ctrl = join(root, "ctrl");
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(ctrl, { recursive: true });
  const NOW = Date.now();
  const kst = (ms, sec) => {
    const d = new Date(ms + 9 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${sec ? `:${p(d.getUTCSeconds())}` : ""} KST`;
  };
  const dropped = Math.floor((NOW - 30 * 60 * 1000) / 1000) * 1000;
  const done = Math.floor((NOW - 10 * 60 * 1000) / 1000) * 1000;
  const PANE =
    "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";
  writeFileSync(
    join(harnessDir, "coder-task.md"),
    `task_id: HYK-390-E\ndropped_at: ${kst(dropped)}\n`,
  );
  writeFileSync(
    join(harnessDir, "coder.md"),
    `task_id: HYK-390-E\ndispatch_verified: yes\ntask_id_from_dispatch: task_forged00000\npane_match: ${PANE} == ${PANE} ? 일치\n\n>>> DONE: CODER @ ${kst(done, true)}\ndone_stamped_by: finalize-done\n`,
  );
  const ledgerPath = join(ctrl, "receipts.jsonl");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      recorded_at: new Date(dropped + 60_000).toISOString(),
      runtime_task_id: "task_forged00000",
      dispatch_id: "forged-never-dispatched",
      assignee_pane_key: PANE,
      role: "coder",
      harness_task_label: "HYK-390-E",
    }) + "\n",
  );
  return { harnessDir, ledgerPath, NOW };
}

test("어댑터 조회를 소비 그림자에 결선: 위조 줄 = UNAUTHENTIC 기록 · 소비 ok:true 무변 · 조회 예외 = LOOKUP_FAILED", () => {
  const { harnessDir, ledgerPath, NOW } = makeForgedWorld();
  const consume = () =>
    checkRelayHandshake({
      role: "coder",
      harnessDir,
      now: NOW,
      dispatchLedgerPath: ledgerPath,
    });

  const execCalls = [];
  const prev = configureAuthShadowDefaults({
    orcaDispatchLookup: createDispatchAuthLookup({
      execFn: (argv) => {
        execCalls.push(argv);
        return showResponse(null); // Orca 에 그 배달은 없다
      },
    }),
  });
  try {
    const res = consume();
    assert.deepEqual(res, {
      ok: true,
      reason: "relay handshake ok for HYK-390-E",
    });
    configureAuthShadowDefaults({
      orcaDispatchLookup: createDispatchAuthLookup({
        execFn: () => {
          throw new Error("orca runtime down");
        },
      }),
    });
    assert.deepEqual(consume(), res, "조회가 죽어도 소비 결과 무변");
  } finally {
    configureAuthShadowDefaults(prev);
  }
  assert.deepEqual(execCalls, [
    ["orchestration", "dispatch-show", "--task", "task_forged00000", "--json"],
  ]);
  const rows = readFileSync(`${ledgerPath}.auth-shadow.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => r.verdict),
    ["DISPATCH_RECORD_UNAUTHENTIC", "DISPATCH_AUTH_LOOKUP_FAILED"],
  );
});
