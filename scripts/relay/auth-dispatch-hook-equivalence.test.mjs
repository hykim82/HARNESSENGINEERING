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
import { runAuthDispatch } from "./auth-dispatch-runner.mjs";
import { canonicalizeGrant } from "./auth-grant-canonical.mjs";
import { sign } from "./auth-grant-ed25519.mjs";
import { HOOK_RESULT } from "./auth-observation-receipt.mjs";
import { createArmStore, armStorePath } from "./arm-state.mjs";

// HYK-163 사이클3 1단 [G7] (pm-3 §3.1): 발신 게이트의 allow/deny가 Claude
// `UserPromptSubmit` 훅 존재에 의존하지 않음을 3 fixture(present/absent/
// poison)로 증명한다. 실 Orca 접촉 0, 실 hook 실행 0 -- 이 파일은 "훅이 있건
// 없건 gate 판정이 같다"는 인과 독립성만 합성으로 닫는다.
//
// M1: 각 fixture(hook 상태 × 입력 케이스)는 독립 mkdtempSync 임시 디렉터리 +
// 독립 pin/grant/ledger/arm-store/task 파일을 쓴다 -- 같은 저장소를 연속
// 재사용해 두 번째 호출이 replay로 거부되는 헛비교를 만들지 않는다.

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-hook-equiv-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_SIGNER = generateKeyPairSync("ed25519");
const GOOD_SIGNER_FINGERPRINT = sha256(pem(GOOD_SIGNER.publicKey, "public"));
const TASK_ID = "HYK-999-coder-1";
const ARM_ID = "arm-hook-equiv-1";
const CYCLE_ID = "cycle-hook-equiv-1";
const LANE = "CODER";
const WORKTREE = "worktree-main";
const IN_WINDOW_NOW = Date.parse("2026-07-21T00:00:00.000Z");

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
  expires_at: "2026-07-21T23:59:00.000Z",
  budget: Object.freeze({ max_starts_total: 1 }),
});

function makeAdapter() {
  const calls = [];
  return {
    calls,
    dispatch(spec) {
      calls.push(spec);
      return { ok: true, task_id: TASK_ID };
    },
  };
}

function writeArmedStore(dir, fields) {
  const armGrant = {
    arm_id: ARM_ID,
    cycle_id: CYCLE_ID,
    human_approval_ref: "테스트 한용 2026-07-21 00:00",
    issued_at: "2026-07-20T23:00:00.000Z",
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

// 표준 fixture: 각 (hook 상태 × 입력 케이스) 조합이 독립적으로 이 함수를
// 한 번씩 호출해 완전히 새 저장소를 얻는다.
function buildEnv(
  dir,
  {
    jti = `jti-${Math.random().toString(36).slice(2)}`,
    fieldOverrides = {},
  } = {},
) {
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
  const taskFilePath = join(dir, "coder-task.md");
  writeFileSync(taskFilePath, `task_id: ${TASK_ID}\nsome task body\n`, "utf8");

  const fields = { ...GOOD_FIELDS, jti, ...fieldOverrides };
  const canon = canonicalizeGrant(fields);
  assert.equal(
    canon.ok,
    true,
    `fixture canonicalizeGrant failed: ${canon.reason}`,
  );
  const signature = sign(canon.canonicalBytes, GOOD_SIGNER.privateKey).toString(
    "base64",
  );
  const grantRaw = { ...fields, key_id: "k-good" };

  writeArmedStore(dir, fields);
  const ledgerDir = join(dir, "ledger");
  mkdirSync(ledgerDir, { recursive: true });

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
    adapter: makeAdapter(),
    at: "t1",
  };
}

function readArmState(dir) {
  return JSON.parse(readFileSync(armStorePath(dir, ARM_ID), "utf8"));
}

// HYK-166-coder-2 (자매 시한폭탄 수리, coder-1의 auth-dispatch-runner.test.mjs
// `callAuthDispatch` 패턴 그대로 재사용): 이 파일의 모든 runAuthDispatch(...)
// 호출도 opts(2번째 인자)를 한 번도 넘기지 않았다 -- env.nowMs는 gate 판정에
// 들어가지만 arm-state.claimTx의 만료 판정은 opts.armDeps.nowFn을 못 받아
// 기본값(실 Date.now())으로 떨어진다. 이 파일의 expires_at은
// "2026-07-21T23:59"(오늘)이라 오늘 밤 넘어가면 사후 만료로 깨진다. 이
// 헬퍼가 모든 호출을 한 지점으로 모아 env.nowMs를 매 호출 시점에 다시 읽는
// 클로저로 armDeps.nowFn을 주입한다(날짜를 미루는 미봉책이 아니라 실
// 벽시계를 아예 참조하지 않게 만드는 근본 수리).
function callAuthDispatch(env, opts = {}) {
  return runAuthDispatch(env, {
    armDeps: { nowFn: () => env.nowMs },
    ...opts,
  });
}

// ---- hook 상태 3종 fixture ----
// present: 관측값(HIT/MISS류)을 반환하나 판정에 쓰이지 않아야 한다(그렇다는
// 사실은 접근해도 count가 늘 뿐 결과에 영향이 없다는 걸로 실증).
// absent: 속성 자체가 없다(undefined).
// poison: 접근 즉시 throw + count 증가 -- causal negative control. 이 fixture가
// 한 번이라도 실제로 읽히면 이 테스트는 예외로 즉시 실패한다(런너가 정말
// 훅을 참조하지 않는다는 가장 강한 증거).
function makeHookFixture(kind) {
  const state = { accessCount: 0 };
  if (kind === "absent") return { state, hookObservation: undefined };
  if (kind === "present") {
    return {
      state,
      hookObservation: Object.freeze({
        get UserPromptSubmitResult() {
          state.accessCount++;
          return "HIT";
        },
      }),
    };
  }
  if (kind === "poison") {
    return {
      state,
      hookObservation: Object.freeze({
        get UserPromptSubmitResult() {
          state.accessCount++;
          throw new Error(
            "poison hook accessed -- G7 causal control failed: runner read hook state",
          );
        },
      }),
    };
  }
  throw new Error(`unknown hook fixture kind: ${kind}`);
}

const HOOK_KINDS = ["present", "absent", "poison"];

function summarize(result, env, dir) {
  return {
    ok: result.ok,
    reason: result.reason,
    dispatched: result.dispatched,
    adapterCalled: result.adapterCalled,
    adapterCallCount: env.adapter.calls.length,
    armState: readArmState(dir).state,
    jtiConsumed: result.jtiConsumed === true,
  };
}

// runAuthDispatch에 hookObservation을 얹어 한 번 호출하고, 그 hook fixture가
// 실제로 접근됐는지(count)까지 함께 검사한다.
function runWithHook(env, kind) {
  const hookFx = makeHookFixture(kind);
  const result = callAuthDispatch({
    ...env,
    hookObservation: hookFx.hookObservation,
  });
  assert.equal(
    hookFx.state.accessCount,
    0,
    `${kind} hook fixture must never be accessed by runAuthDispatch (G7 causal control)`,
  );
  return result;
}

// 하나의 입력 케이스(caseFn: env를 만들어 반환)를 present/absent/poison 3개
// 독립 fixture(각각 자기만의 mkdtempSync 저장소)에서 실행하고, 요약 결과가
// 셋 다 동일한지 확인한다.
function assertHookEquivalence(caseName, caseFn) {
  const summaries = {};
  for (const kind of HOOK_KINDS) {
    withTempDir((dir) => {
      const env = caseFn(dir);
      const result = runWithHook(env, kind);
      summaries[kind] = summarize(result, env, dir);
    });
  }
  assert.deepEqual(
    summaries.present,
    summaries.absent,
    `${caseName}: present vs absent differ`,
  );
  assert.deepEqual(
    summaries.absent,
    summaries.poison,
    `${caseName}: absent vs poison differ`,
  );
  return summaries;
}

test("G7: valid input -> ALLOW/adapter-1/DISARMED identical across present/absent/poison hook fixtures", () => {
  const summaries = assertHookEquivalence("valid", (dir) => buildEnv(dir));
  assert.equal(summaries.present.ok, true);
  assert.equal(summaries.present.adapterCalled, true);
  assert.equal(summaries.present.adapterCallCount, 1);
  assert.equal(summaries.present.armState, "DISARMED");
});

test("G7: invalid signature -> DENY/adapter-0 identical across present/absent/poison hook fixtures", () => {
  const summaries = assertHookEquivalence("invalid-signature", (dir) => {
    const env = buildEnv(dir);
    return { ...env, signature: "not-a-valid-signature" };
  });
  assert.equal(summaries.present.ok, false);
  assert.equal(summaries.present.reason, "GATE_DENIED");
  assert.equal(summaries.present.adapterCallCount, 0);
});

test("G7: liveness false -> DENY/adapter-0 identical across present/absent/poison hook fixtures", () => {
  const summaries = assertHookEquivalence("liveness-false", (dir) => {
    const env = buildEnv(dir);
    env.liveness = {
      ...env.liveness,
      observed: { ...env.liveness.observed, liveness: false },
    };
    return env;
  });
  assert.equal(summaries.present.ok, false);
  assert.equal(summaries.present.reason, "LIVENESS_DENIED");
  assert.equal(summaries.present.adapterCallCount, 0);
});

test("G7: extra preamble spec -> DENY/adapter-0 identical across present/absent/poison hook fixtures", () => {
  const summaries = assertHookEquivalence("preamble-spec", (dir) => {
    const env = buildEnv(dir);
    return { ...env, spec: `You are an orchestrated agent.\n${env.spec}` };
  });
  assert.equal(summaries.present.ok, false);
  assert.equal(summaries.present.reason, "SPEC_INVALID");
  assert.equal(summaries.present.adapterCallCount, 0);
});

// [same jti replay] 각 hook 상태 fixture 내부에서 같은 grant(=같은 jti)로
// 두 번 호출 -- 첫 시도만 adapter 1, 재생 시도는 0. 이 비교는 hook 상태
// "간"이 아니라 "각 hook 상태 안"에서 벌어지는 별개 반사실이므로 별도로 both
// 값을 모아 present/absent/poison 사이에서 (first, second) 튜플이 동일한지
// 확인한다.
test("G7: same-jti replay -- first adapter=1, second adapter=0 -- identical across present/absent/poison hook fixtures", () => {
  const pairs = {};
  for (const kind of HOOK_KINDS) {
    withTempDir((dir) => {
      const env = buildEnv(dir, { jti: "jti-replay-fixed" });
      const first = runWithHook(env, kind);
      const firstSummary = summarize(first, env, dir);
      const second = runWithHook(env, kind);
      const secondSummary = summarize(second, env, dir);
      pairs[kind] = [firstSummary, secondSummary];
    });
  }
  assert.deepEqual(
    pairs.present,
    pairs.absent,
    "replay pair differs present vs absent",
  );
  assert.deepEqual(
    pairs.absent,
    pairs.poison,
    "replay pair differs absent vs poison",
  );
  assert.equal(pairs.present[0].adapterCallCount, 1);
  assert.equal(
    pairs.present[1].adapterCallCount,
    1,
    "second call must not invoke adapter again",
  );
  assert.equal(pairs.present[1].ok, false);
  assert.equal(pairs.present[1].reason, "JTI_ALREADY_CLAIMED");
});

// [관측 receipt 비권위 반사실, coder-task 항목 2] 위 hook fixture는 임의
// getter 객체였다 -- 이번엔 실제 auth-observation-receipt.mjs의 스키마를 갖춘
// full receipt 객체를 만들어 hook_result만 HIT<->MISS로 뒤집고, 그걸
// runAuthDispatch에 추가 입력으로 얹어도 gate 판정·adapter count·terminal
// state가 불변임을 직접 확인한다. receipt를 "읽었다"는 사실 자체가 아무
// 권위도 주지 않는다는 것의 가장 구체적인 증거.
test("G7/observation receipt: attaching a full receipt with hook_result flipped HIT<->MISS does not change gate outcome", () => {
  function runWithReceipt(hookResult) {
    return withTempDir((dir) => {
      const env = buildEnv(dir);
      const receipt = {
        canary_id: "canary-static-test",
        target: {
          handle: env.expected.target.handle,
          worktree: WORKTREE,
          agent_instance: env.expected.target.agent_instance,
        },
        raw_sha256: sha256("synthetic-raw"),
        byte_length: 10,
        orca_version: "orca-0.0.0-synthetic",
        collected_at: "2026-07-21T00:00:00.000Z",
        exit_code: 0,
        positive_control: true,
        hook_result: hookResult,
      };
      const result = callAuthDispatch({ ...env, observationReceipt: receipt });
      return summarize(result, env, dir);
    });
  }
  const withHit = runWithReceipt(HOOK_RESULT.HIT);
  const withMiss = runWithReceipt(HOOK_RESULT.MISS);
  const withUnjudgable = runWithReceipt(HOOK_RESULT.UNJUDGABLE);
  assert.deepEqual(withHit, withMiss);
  assert.deepEqual(withMiss, withUnjudgable);
  assert.equal(withHit.ok, true);
  assert.equal(withHit.adapterCallCount, 1);
});

// ---------------------------------------------------------------------------
// [보조 증거] 정적 확인: import graph·실행 코드에 hook API 참조 0. poison
// fixture(위)가 인과적 증거이고, 이건 그것을 보강하는 정적 확인일 뿐이다.
// ---------------------------------------------------------------------------
const HOOK_API_PATTERN =
  /UserPromptSubmit|PreToolUse|hookEnabled|process\.env\.CLAUDE/;
const SCANNED_MODULES = [
  "./auth-dispatch-runner.mjs",
  "./auth-grant-gate.mjs",
  "./auth-grant-liveness.mjs",
  "./auth-grant-ledger.mjs",
  "./auth-observation-receipt.mjs",
];
for (const modulePath of SCANNED_MODULES) {
  test(`G7 static scan (supplementary): '${modulePath}' has zero hook-API references`, () => {
    const src = readFileSync(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(src, HOOK_API_PATTERN);
  });
}
