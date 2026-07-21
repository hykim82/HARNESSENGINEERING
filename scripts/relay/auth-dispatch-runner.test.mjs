import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  runAuthDispatch,
  recoverAuthDispatch,
  RUN_REASON,
} from "./auth-dispatch-runner.mjs";
import { canonicalizeGrant } from "./auth-grant-canonical.mjs";
import { sign } from "./auth-grant-ed25519.mjs";
import {
  createArmStore,
  armStorePath,
  claimTx,
  startTx,
} from "./arm-state.mjs";

// M1(비타협): 이 파일의 키쌍·grant·pin manifest·arm store·task 파일은 전부 이
// 테스트 실행 시점에 mkdtempSync 임시 디렉터리 안에서 합성 생성된다. 실
// 개인키·실 pin 배포·실 발사 경로 참조는 0이다(실 orca 0 -- adapter는 항상
// in-memory fake). live enable 플래그는 이 러너에 아예 존재하지 않는다.

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-dispatch-runner-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_SIGNER = generateKeyPairSync("ed25519");
const GOOD_SIGNER_FINGERPRINT = sha256(pem(GOOD_SIGNER.publicKey, "public"));

const TASK_ID = "HYK-999-coder-1";
const ARM_ID = "arm-runner-test-1";
const CYCLE_ID = "cycle-runner-test-1";
const LANE = "CODER";
const WORKTREE = "worktree-main";

const GOOD_FIELDS = Object.freeze({
  schema_version: 1,
  policy_version: 1,
  packet_sha256: sha256("synthetic-packet"),
  addendum_sha256: sha256("synthetic-addendum"),
  authorization_sha256: sha256("synthetic-authorization"),
  task_sha256: sha256("synthetic-task"),
  task_id: TASK_ID,
  target: Object.freeze({
    handle: "test-terminal",
    fingerprint: "test-fingerprint",
    agent_instance: "test-agent-instance",
  }),
  audience: LANE,
  channel: "orca-dispatch",
  arm_id: ARM_ID,
  cycle_id: CYCLE_ID,
  expires_at: "2026-07-20T23:59:00.000Z",
  budget: Object.freeze({ max_starts_total: 1 }),
});

const IN_WINDOW_NOW = Date.parse("2026-07-20T12:00:00.000Z");

function makeAdapter(behavior = "ok") {
  const calls = [];
  return {
    calls,
    dispatch(spec) {
      calls.push(spec);
      if (behavior === "ok") return { ok: true, task_id: TASK_ID };
      if (behavior === "reject")
        return { ok: false, reason: "worker rejected" };
      if (behavior === "throw") throw new Error("injected dispatch throw");
      return { ok: true };
    },
  };
}

// buildEnv()의 각 조각을 헬퍼로 분리한다(quality-check max-lines-per-function
// 래칫 -- buildEnv 자체는 오케스트레이션만).
function writePinManifest(dir) {
  const pinPath = join(dir, "pin.json");
  writeFileSync(
    pinPath,
    JSON.stringify({
      trusted_keys: [
        {
          key_id: "k-good",
          public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
          status: "active",
        },
      ],
    }),
    "utf8",
  );
  return pinPath;
}

function writeTaskFile(dir) {
  const taskFilePath = join(dir, "coder-task.md");
  writeFileSync(taskFilePath, `task_id: ${TASK_ID}\nsome task body\n`, "utf8");
  return taskFilePath;
}

function buildSignedGrant(fields) {
  const canon = canonicalizeGrant(fields);
  assert.equal(
    canon.ok,
    true,
    `fixture canonicalizeGrant failed: ${canon.reason}`,
  );
  const signature = sign(canon.canonicalBytes, GOOD_SIGNER.privateKey).toString(
    "base64",
  );
  return { grantRaw: { ...fields, key_id: "k-good" }, signature };
}

function writeArmedStore(dir, fields) {
  const armGrant = {
    arm_id: ARM_ID,
    cycle_id: CYCLE_ID,
    human_approval_ref: "테스트 한용 2026-07-20 12:00",
    issued_at: "2026-07-20T11:00:00.000Z",
    expires_at: fields.expires_at,
    allowed_lanes: [LANE],
    allowed_task_ids: [TASK_ID],
    max_starts_total: 1,
    max_starts_per_lane: 1,
    max_rejections: 3,
    publish_allowed: false,
    question_policy: "pause",
    error_policy: "pause",
  };
  const created = createArmStore(armGrant, { at: armGrant.issued_at });
  assert.equal(created.ok, true);
  writeFileSync(
    armStorePath(dir, ARM_ID),
    JSON.stringify(created.store),
    "utf8",
  );
}

function buildExpectedAndObserved(fields) {
  const expected = {
    schema_version: 1,
    policy_version: 1,
    task_id: TASK_ID,
    arm_id: ARM_ID,
    cycle_id: CYCLE_ID,
    target: {
      handle: fields.target.handle,
      fingerprint: fields.target.fingerprint,
      agent_instance: fields.target.agent_instance,
    },
    audience: LANE,
    channel: fields.channel,
    pinned_key_fingerprint: GOOD_SIGNER_FINGERPRINT,
    worktree: WORKTREE,
  };
  const observed = {
    handle: fields.target.handle,
    fingerprint: fields.target.fingerprint,
    agent_instance: fields.target.agent_instance,
    worktree: WORKTREE,
    liveness: true,
    snapshot_at: IN_WINDOW_NOW - 1000,
  };
  return { expected, observed };
}

// 표준 fixture: signed grant + pin + arm store(ARMED) + task 파일 + expected +
// liveness observed + fake adapter를 한 번에 만든다. jti는 매 호출마다 새로
// 발급(같은 dir을 여러 시나리오에서 재사용해도 jti 충돌이 안 나게).
function buildEnv(
  dir,
  {
    jti = `jti-${Math.random().toString(36).slice(2)}`,
    fieldOverrides = {},
    adapterBehavior = "ok",
  } = {},
) {
  const pinPath = writePinManifest(dir);
  const taskFilePath = writeTaskFile(dir);
  const fields = { ...GOOD_FIELDS, jti, ...fieldOverrides };
  const { grantRaw, signature } = buildSignedGrant(fields);
  writeArmedStore(dir, fields);

  const ledgerDir = join(dir, "ledger");
  mkdirSync(ledgerDir, { recursive: true });

  const { expected, observed } = buildExpectedAndObserved(fields);

  return {
    grantRaw,
    signature,
    pinnedPublicKeyPath: pinPath,
    expected,
    nowMs: IN_WINDOW_NOW,
    liveness: { observed, maxSnapshotAgeMs: 30_000 },
    spec: `go ${TASK_ID}`,
    taskFilePath,
    armDir: dir,
    armId: ARM_ID,
    cycleId: CYCLE_ID,
    lane: LANE,
    ledgerDir,
    adapter: makeAdapter(adapterBehavior),
    at: "t1",
  };
}

function readArmState(dir) {
  return JSON.parse(readFileSync(armStorePath(dir, ARM_ID), "utf8"));
}

// HYK-166-coder-1 (시한폭탄 수리): runAuthDispatch(input, opts)의 opts(2번째
// 인자)는 이 파일의 모든 호출부에서 한 번도 전달되지 않았다 -- 그래서
// claimTx/arm-state의 만료 판정이 opts.armDeps.nowFn을 못 받고 기본값(실
// Date.now())으로 떨어졌다. env.nowMs(gate 판정)는 이미 fixture가 고정한
// 시각을 쓰는데, arm-state 쪽만 실 벽시계를 봐서 날짜가 지나면(2026-07-20
// 이후) 하드코딩 expires_at을 실제로 넘겨버려 사후 만료 fail이 났다(9건).
// 이 헬퍼가 모든 호출을 한 지점으로 모아 armDeps.nowFn을 **env.nowMs를 매
// 호출 시점에 다시 읽는 클로저**로 주입한다 -- env.nowMs를 나중에 mutate하는
// 테스트(예: "expired grant")도 gate와 arm-state가 항상 같은 시점을 보게
// 된다(값을 한 번 복사해두는 게 아니라 참조를 유지 -- 일관성이 구조적으로
// 보장됨). 날짜를 미래로 미루는 미봉책이 아니라, 애초에 실 벽시계를 전혀
// 참조하지 않게 만드는 근본 수리(HYK-165 coder-2의 pull-supervisor.test.mjs
// armDeps.nowFn 패턴과 동일).
function callAuthDispatch(env, opts = {}) {
  return runAuthDispatch(env, {
    armDeps: { nowFn: () => env.nowMs },
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// known-good end-to-end
// ---------------------------------------------------------------------------
test("runAuthDispatch: known-good flow -> DISPATCHED, adapter called exactly once, terminal DISARMED", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    const result = callAuthDispatch(env);
    assert.equal(result.ok, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.adapterCalled, true);
    assert.equal(result.reason, RUN_REASON.DISPATCHED);
    assert.deepEqual(env.adapter.calls, [`go ${TASK_ID}`]);
    assert.equal(readArmState(dir).state, "DISARMED");
  });
});

// ---------------------------------------------------------------------------
// C2-2/G5: jti exactly-once through the full runner (not just the ledger unit)
// ---------------------------------------------------------------------------
test("runAuthDispatch: replaying the SAME signed grant (same jti) a second time -> JTI_ALREADY_CLAIMED, adapter NOT called again", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    const first = callAuthDispatch(env);
    assert.equal(first.ok, true);
    assert.equal(env.adapter.calls.length, 1);

    const second = callAuthDispatch(env);
    assert.equal(second.ok, false);
    assert.equal(second.reason, RUN_REASON.JTI_ALREADY_CLAIMED);
    assert.equal(second.adapterCalled, false);
    assert.equal(
      env.adapter.calls.length,
      1,
      "adapter must not be invoked a second time",
    );
  });
});

// ---------------------------------------------------------------------------
// C2-4/G8: invalid grant / internal-bypass negative control -- exec spy 0
// ---------------------------------------------------------------------------
test("runAuthDispatch: invalid signature (G8 negative control) -> GATE_DENIED, adapter spy count 0", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    const tampered = { ...env, signature: "not-a-valid-signature-at-all" };
    const result = callAuthDispatch(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUN_REASON.GATE_DENIED);
    assert.equal(result.adapterCalled, false);
    assert.equal(env.adapter.calls.length, 0);
    assert.equal(readArmState(dir).state, "DISARMED");
  });
});

test("runAuthDispatch: single side-effect seam -- source calls adapter.dispatch exactly once (outside comments, LF and CRLF alike)", () => {
  const src = readFileSync(
    new URL("./auth-dispatch-runner.mjs", import.meta.url),
    "utf8",
  );
  // review-2 반려분 수리(coder-4): git checkout이 CRLF로 변환하면(이 repo의
  // .gitattributes 기본 동작) 각 split 라인이 `\r`로 끝난다. `/\/\/.*$/`는
  // `.`가 라인종료문자(\r 포함)를 매칭하지 않으므로 그 `$`가 trailing `\r`
  // 뒤(진짜 문자열 끝)에서만 성립해 매치 자체가 실패 -- 주석이 안 지워진 채
  // 남아 CRLF 체크아웃(=CI)에서만 위양성 카운트 2가 나왔다(LF 작업트리에선
  // 은폐됨). `\r\n`을 먼저 `\n`으로 정규화해 line-ending에 완전히 무관하게
  // 만든다 -- G8 단일 seam 자체의 검증 강도는 그대로, 위양성만 제거.
  const normalized = src.replace(/\r\n/g, "\n");
  const codeOnly = normalized
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const matches = codeOnly.match(/adapter\.dispatch\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    "exactly one call site to adapter.dispatch() proves there is no separate raw-dispatch bypass seam",
  );
});

// [line-ending 반사실] 같은 소스를 CRLF로 강제 변환해도 여전히 정확히 1이어야
// 한다 -- 위 정규화가 실제로 CRLF를 처리하는지 이 테스트 파일 자체의 로컬
// checkout 상태와 무관하게 직접 실증한다(review-2가 요구한 "CRLF에서도 견고"
// 를 워킹트리 line-ending에 의존하지 않고 자체 재현).
test("runAuthDispatch: single side-effect seam count is line-ending-agnostic (explicit CRLF injection reproduces review-2's failure mode)", () => {
  const src = readFileSync(
    new URL("./auth-dispatch-runner.mjs", import.meta.url),
    "utf8",
  );
  const forcedCrlf = src.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const normalized = forcedCrlf.replace(/\r\n/g, "\n");
  const codeOnly = normalized
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const matches = codeOnly.match(/adapter\.dispatch\(/g) ?? [];
  assert.equal(
    matches.length,
    1,
    "forced-CRLF source must still count exactly one call site after normalization",
  );

  // mutation-kill anchor: 정규화를 빼면(review-2가 실제로 만난 결함 그대로)
  // 이 강제-CRLF 입력에서 카운트가 2로 오염됨을 직접 재현해, "정규화가 실제로
  // 이 결함을 죽인다"는 근거를 테스트 자체에 남긴다.
  const withoutNormalization = forcedCrlf
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const unnormalizedMatches =
    withoutNormalization.match(/adapter\.dispatch\(/g) ?? [];
  assert.equal(
    unnormalizedMatches.length,
    2,
    "sanity check: without \\r\\n normalization, forced-CRLF reproduces review-2's exact failure (count=2)",
  );
});

// ---------------------------------------------------------------------------
// C2-3/G6: liveness denial blocks dispatch entirely
// ---------------------------------------------------------------------------
test("runAuthDispatch: liveness=false -> LIVENESS_DENIED, adapter not called, arm terminal DISARMED", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    env.liveness.observed = { ...env.liveness.observed, liveness: false };
    const result = callAuthDispatch(env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUN_REASON.LIVENESS_DENIED);
    assert.equal(result.adapterCalled, false);
    assert.equal(env.adapter.calls.length, 0);
    assert.equal(readArmState(dir).state, "DISARMED");
  });
});

test("runAuthDispatch: agent_instance changed between signed target and observed -> LIVENESS_DENIED", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    env.liveness.observed = {
      ...env.liveness.observed,
      agent_instance: "different-agent",
    };
    const result = callAuthDispatch(env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUN_REASON.LIVENESS_DENIED);
    assert.equal(env.adapter.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// C2-5/G9: caller spec must be exact `go <task_id>`, one line, no extras
// ---------------------------------------------------------------------------
const BAD_SPECS = [
  ["trailing whitespace", `go ${TASK_ID} `],
  ["leading whitespace", ` go ${TASK_ID}`],
  ["trailing newline", `go ${TASK_ID}\n`],
  ["extra permission phrase", `go ${TASK_ID} --grant-all`],
  ["preamble prefixed", `You are an orchestrated agent.\ngo ${TASK_ID}`],
  ["wrong task id", `go HYK-000-coder-9`],
  ["multi-line", `go\n${TASK_ID}`],
];

for (const [label, spec] of BAD_SPECS) {
  test(`runAuthDispatch: malformed spec (${label}) -> SPEC_INVALID, adapter not called`, () => {
    withTempDir((dir) => {
      const env = buildEnv(dir);
      env.spec = spec;
      const result = callAuthDispatch(env);
      assert.equal(result.ok, false, label);
      assert.equal(result.reason, RUN_REASON.SPEC_INVALID, label);
      assert.equal(env.adapter.calls.length, 0, label);
    });
  });
}

// [valid count = 1] pm-2 §3.6/G11: 1차 검증(서명·liveness·spec 포함) 실패는
// **그 arm을 영구 소진**한다(안전 우선, 재시도 0) -- 같은 arm에 말만 다른
// spec을 계속 던져볼 수는 없다(각 시도는 독립 fresh 환경이어야 한다). 그래서
// "valid count 1"은 후보 spec들을 각각 **별도** 환경에서 1회씩 시도해, 정확히
// exact-format 후보만 dispatch되는지로 확인한다.
test("runAuthDispatch: valid count = 1 -- among independent single-shot attempts, only the exact spec dispatches", () => {
  const candidates = [...BAD_SPECS.map(([, spec]) => spec), `go ${TASK_ID}`];
  const outcomes = candidates.map((spec) =>
    withTempDir((dir) => {
      const env = buildEnv(dir);
      env.spec = spec;
      return callAuthDispatch(env).ok === true;
    }),
  );
  const successCount = outcomes.filter(Boolean).length;
  assert.equal(
    successCount,
    1,
    `expected exactly 1 success, got ${successCount} (${JSON.stringify(outcomes)})`,
  );
  assert.equal(
    outcomes[outcomes.length - 1],
    true,
    "the exact `go <task_id>` candidate must be the one that succeeds",
  );
});

// ---------------------------------------------------------------------------
// C2-6/G11: every terminal path ends in persisted DISARMED, no auto-retry
// ---------------------------------------------------------------------------
test("runAuthDispatch: adapter rejects (ok:false) -> START_FAILED via arm-state's own startup_failure disarm, terminal DISARMED", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir, { adapterBehavior: "reject" });
    const result = callAuthDispatch(env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUN_REASON.START_FAILED);
    assert.equal(result.adapterCalled, true);
    assert.equal(env.adapter.calls.length, 1);
    assert.equal(readArmState(dir).state, "DISARMED");
    // no auto-retry: replaying the same grant must not call the adapter again.
    const retry = callAuthDispatch(env);
    assert.equal(retry.ok, false);
    assert.equal(
      env.adapter.calls.length,
      1,
      "no automatic retry after a terminal failure",
    );
  });
});

test("runAuthDispatch: adapter throws -> START_FAILED via arm-state's own startup_failure disarm, terminal DISARMED", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir, { adapterBehavior: "throw" });
    const result = callAuthDispatch(env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUN_REASON.START_FAILED);
    assert.equal(env.adapter.calls.length, 1);
    assert.equal(readArmState(dir).state, "DISARMED");
  });
});

test("runAuthDispatch: expired grant -> GATE_DENIED, terminal DISARMED, no dispatch", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    env.nowMs = Date.parse(GOOD_FIELDS.expires_at) + 1;
    const result = callAuthDispatch(env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUN_REASON.GATE_DENIED);
    assert.equal(env.adapter.calls.length, 0);
    assert.equal(readArmState(dir).state, "DISARMED");
  });
});

// ---------------------------------------------------------------------------
// C2-7/crash: claim-then-crash and RUNNING-then-crash both recover no-respawn
// ---------------------------------------------------------------------------
test("runAuthDispatch/recoverAuthDispatch: claim-then-crash recovers to DISARMED with no respawn, and the jti stays consumed", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    // 러너를 거치지 않고 직접 claimTx만 호출해 "claim 후 crash"를 재현한다
    // (startTx는 절대 호출하지 않음 -- 프로세스가 여기서 죽었다고 가정).
    const armClaim = claimTx(
      dir,
      ARM_ID,
      {
        task_id: TASK_ID,
        cycle_id: CYCLE_ID,
        lane: LANE,
        attempt_id: "attempt-crash-1",
        content_hash: sha256("body"),
        at: "t1",
      },
      { nowFn: () => env.nowMs },
    );
    assert.equal(armClaim.ok, true);
    writeFileSync(
      armStorePath(dir, ARM_ID),
      JSON.stringify(armClaim.store),
      "utf8",
    );
    assert.equal(readArmState(dir).state, "CLAIMED");

    const recovered = recoverAuthDispatch(dir, ARM_ID, {
      task_id: TASK_ID,
      attempt_id: "attempt-crash-1",
      at: "t2",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.store.state, "DISARMED");
    assert.equal(recovered.store.needs_human_ack, true);
    writeFileSync(
      armStorePath(dir, ARM_ID),
      JSON.stringify(recovered.store),
      "utf8",
    );

    // 재실행 시도(같은 grant, 즉 같은 jti)는 여전히 실패해야 한다 -- consumed 유지.
    const retry = callAuthDispatch(env);
    assert.equal(retry.ok, false);
    assert.equal(
      env.adapter.calls.length,
      0,
      "no respawn after crash recovery",
    );
  });
});

test("runAuthDispatch/recoverAuthDispatch: RUNNING-then-crash recovers to DISARMED with no respawn (spawnFn never called during recovery)", () => {
  withTempDir((dir) => {
    buildEnv(dir); // ARMED arm store만 필요 -- 반환값은 이 테스트에서 쓰지 않는다(buildEnv는 항상 nowMs=IN_WINDOW_NOW로 arm을 만든다).
    const armClaim = claimTx(
      dir,
      ARM_ID,
      {
        task_id: TASK_ID,
        cycle_id: CYCLE_ID,
        lane: LANE,
        attempt_id: "attempt-crash-2",
        content_hash: sha256("body"),
        at: "t1",
      },
      { nowFn: () => IN_WINDOW_NOW },
    );
    assert.equal(armClaim.ok, true);
    writeFileSync(
      armStorePath(dir, ARM_ID),
      JSON.stringify(armClaim.store),
      "utf8",
    );

    // startTx로 RUNNING까지만 만들고(spawn 성공), finishAttemptTx는 호출하지
    // 않는다 -- "RUNNING 선저장 이후, 종결 기록 이전" 크래시를 재현.
    const started = startTx(
      dir,
      ARM_ID,
      { task_id: TASK_ID, attempt_id: "attempt-crash-2", at: "t2" },
      {
        spawnFn: () => {},
      },
    );
    assert.equal(started.spawned, true);
    writeFileSync(
      armStorePath(dir, ARM_ID),
      JSON.stringify(started.store),
      "utf8",
    );
    assert.equal(readArmState(dir).state, "RUNNING");

    let recoverySpawnCalled = false;
    const recovered = recoverAuthDispatch(
      dir,
      ARM_ID,
      { task_id: TASK_ID, attempt_id: "attempt-crash-2", at: "t3" },
      {
        spawnFn: () => {
          recoverySpawnCalled = true;
        },
      },
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.store.state, "DISARMED");
    assert.equal(recoverySpawnCalled, false, "recovery must never spawn");
  });
});

// ---------------------------------------------------------------------------
// C2-8/secrecy: grant/signature/private-key material never reaches the spec,
// the fake TUI payload, or the receipt.
// ---------------------------------------------------------------------------
test("runAuthDispatch: dispatched spec (fake TUI payload) contains no grant/signature/private-key material", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    const result = callAuthDispatch(env);
    assert.equal(result.ok, true);
    const payload = env.adapter.calls[0];
    assert.equal(payload, `go ${TASK_ID}`);
    for (const secretish of [
      env.signature,
      env.grantRaw.jti,
      env.grantRaw.packet_sha256,
    ]) {
      assert.equal(payload.includes(secretish), false);
    }
  });
});

test("runAuthDispatch: finishResult receipt does not embed the raw signature string", () => {
  withTempDir((dir) => {
    const env = buildEnv(dir);
    const result = callAuthDispatch(env);
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result.finishResult);
    assert.equal(serialized.includes(env.signature), false);
  });
});

test("G3 static scan: auth-dispatch-runner.mjs has no literal private-key PEM block and no privateKey parameter", () => {
  const src = readFileSync(
    new URL("./auth-dispatch-runner.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    src,
    /-----BEGIN (?:EC |RSA |ENCRYPTED )?PRIVATE KEY-----/,
  );
  assert.doesNotMatch(src, /\bprivateKey\b/);
});
