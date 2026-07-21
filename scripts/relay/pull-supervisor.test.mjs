import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  runPullSupervisedAttempt,
  runOneShotPullWaiter,
  checkWorkerEnvAllowlist,
  pullBundleGrantPath,
  REASON,
} from "./pull-supervisor.mjs";
import { canonicalizePullGrant } from "./pull-grant-canonical.mjs";
import { canonicalizeAuthorization } from "./pull-authorization.mjs";
import { sign } from "./auth-grant-ed25519.mjs";
import { createArmStore, saveStoreAtomic, armStorePath } from "./arm-state.mjs";
import { createClaudeAdapterFn } from "./claude-adapter.mjs";
import { createCodexAdapterFn } from "./codex-adapter.mjs";

// HYK-165 사이클2(합성만, P3/P4/P5/P6/P7/P8/P9/P15): pull-supervisor.mjs 접합부
// 검증. M1(비타협): 모든 키쌍·grant·authorization·arm-state·pin manifest·
// task-file은 이 테스트가 mkdtempSync 임시 디렉터리 안에서 직접 만들고
// 지우는 합성 fixture다. 실 worker·실 Orca·실 개인키·실 정본
// `C:\...\.harness\pull-delivery\v1\`·`D:\` 관제실은 어디에도 등장하지 않는다.
// adapterFn은 항상 주입 fake(직접 counter 함수 또는 fake spawnSyncFn을 물린
// claude-adapter.mjs/codex-adapter.mjs 실 코드).

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pull-supervisor-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_SIGNER = generateKeyPairSync("ed25519");
const GOOD_SIGNER_FINGERPRINT = sha256(pem(GOOD_SIGNER.publicKey, "public"));
const ARM_ID = "arm-pull-sup-1";
const JTI = "jti-pull-sup-1";
const TASK_ID = "HYK-999-pull-sup-1";
const CYCLE_ID = "cycle-pull-sup-1";
const LANE = "CODER";
const CONFIG_PATH = "pull-sup-coder-profile.json";
const ISSUED_AT = "2026-07-21T00:00:00.000Z";
const EXPIRES_AT = "2026-07-21T00:20:00.000Z";
const IN_WINDOW_NOW = Date.parse("2026-07-21T00:10:00.000Z");
const LAUNCH_PROFILE_SHA256 = sha256("synthetic-pull-sup-launch-profile");
const WORKER_CONFIG_SHA256 = sha256("synthetic-pull-sup-worker-config");
const TASK_FILE_CONTENT = `task_id: ${TASK_ID}\nsome pull-supervisor synthetic task body\n`;

function writePin(dir, entries) {
  const pinPath = join(dir, "pin.json");
  writeFileSync(pinPath, JSON.stringify({ trusted_keys: entries }), "utf8");
  return pinPath;
}
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function grantEnvelope(fields, signerPrivateKey, keyId) {
  const canon = canonicalizePullGrant(fields);
  assert.equal(
    canon.ok,
    true,
    `fixture canonicalizePullGrant failed: ${canon.reason}`,
  );
  const sig = sign(canon.canonicalBytes, signerPrivateKey);
  return {
    grantRaw: { ...fields, key_id: keyId },
    signature: sig.toString("base64"),
  };
}

function buildAuthFields(dir, armId, taskFilePath, taskSha256, overrides) {
  return {
    schema_version: 1,
    arm_id: armId,
    cycle_id: CYCLE_ID,
    task_id: TASK_ID,
    resolved_task_path: taskFilePath,
    task_header_id: TASK_ID,
    task_header_sha256: taskSha256,
    lane: LANE,
    cwd: dir,
    worktree: dir,
    launch_profile_sha256: LAUNCH_PROFILE_SHA256,
    worker_config_sha256: WORKER_CONFIG_SHA256,
    person_approval_ref: "PKT-TEST-PULL-SUP-1:승인:OK:2026-07-21",
    publish_allowed: false,
    retry_allowed: false,
    on_question: "pause",
    on_error: "pause",
    ...(overrides.authFieldsOverride ?? {}),
  };
}

function buildGrantFields(
  armId,
  jti,
  taskSha256,
  authorizationSha256,
  overrides,
) {
  return {
    schema_version: 1,
    policy_version: 1,
    packet_sha256: sha256("synthetic-packet"),
    addendum_sha256: sha256("synthetic-addendum"),
    authorization_sha256: authorizationSha256,
    task_sha256: taskSha256,
    task_id: TASK_ID,
    target: {
      handle: "pull-sup-terminal",
      fingerprint: "pull-sup-fingerprint",
      agent_instance: "pull-sup-agent",
      launch_profile_sha256: LAUNCH_PROFILE_SHA256,
    },
    audience: LANE,
    channel: "harness-signed-pull-v1",
    arm_id: armId,
    cycle_id: CYCLE_ID,
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    budget: { max_starts_total: 1 },
    jti,
    ...(overrides.grantFieldsOverride ?? {}),
  };
}

// bundleDir(inbox)에 signed-grant/authorization/arm-state snapshot 3파일과
// pin manifest를 표준 이름으로 쓴다(P10 §3.2 파일 분리 계약 재사용).
function writeBundleFiles(
  dir,
  bundleDir,
  armId,
  jti,
  authFields,
  grantFields,
  overrides,
) {
  const armSnapshotFields = {
    arm_id: armId,
    cycle_id: CYCLE_ID,
    task_id: TASK_ID,
    lane: LANE,
    expires_at: EXPIRES_AT,
    budget: { max_starts_total: 1 },
    ...(overrides.armSnapshotOverride ?? {}),
  };
  const pinPath = writePin(dir, [
    {
      key_id: "k-good",
      public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
      status: "active",
    },
  ]);
  const envelope = grantEnvelope(grantFields, GOOD_SIGNER.privateKey, "k-good");
  writeJson(join(bundleDir, `signed-grant-${armId}-${jti}.json`), envelope);
  writeJson(join(bundleDir, `authorization-${armId}.json`), authFields);
  writeJson(join(bundleDir, `arm-${armId}.json`), armSnapshotFields);
  return pinPath;
}

// stateDir에 live arm-state Tx store(ARMED)를 만든다 -- signed bundle과는
// 별개 신뢰원(§3.2: "arm 생성"은 supervisor claim 이전의 독립 준비 단계).
function createLiveArmStore(stateDir, armId, overrides) {
  const liveGrant = {
    arm_id: armId,
    cycle_id: CYCLE_ID,
    human_approval_ref: "pull-sup-test-approval",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    allowed_lanes: [LANE],
    allowed_task_ids: [TASK_ID],
    max_starts_total: overrides.liveMaxStartsTotal ?? 1,
    max_starts_per_lane: 1,
    max_rejections: 0,
    publish_allowed: false,
    question_policy: "pause",
    error_policy: "pause",
  };
  const created = createArmStore(liveGrant, { at: ISSUED_AT });
  assert.equal(created.ok, true);
  const saved = saveStoreAtomic(armStorePath(stateDir, armId), created.store);
  assert.equal(saved.ok, true);
}

function buildExpectedAndScope(dir, armId, taskFilePath, grantFields) {
  const expected = {
    schema_version: grantFields.schema_version,
    policy_version: grantFields.policy_version,
    task_id: TASK_ID,
    arm_id: armId,
    cycle_id: CYCLE_ID,
    target: { ...grantFields.target },
    audience: LANE,
    channel: grantFields.channel,
    pinned_key_fingerprint: GOOD_SIGNER_FINGERPRINT,
    resolved_task_path: taskFilePath,
    task_header_id: TASK_ID,
    lane: LANE,
    cwd: dir,
    worktree: dir,
    worker_config_sha256: WORKER_CONFIG_SHA256,
    packet_sha256: grantFields.packet_sha256,
  };
  const expectedTask = {
    task_id: TASK_ID,
    cycle_id: CYCLE_ID,
    lane: LANE,
    cwd: dir,
    config: CONFIG_PATH,
  };
  const scope = {
    lane: LANE,
    cwd: dir,
    config: CONFIG_PATH,
    allowedTaskIds: [TASK_ID],
  };
  return { expected, expectedTask, scope };
}

// 표준 fixture: bundleDir(inbox)/stateDir(live arm-state Tx store)/ledgerDir을
// 분리하고(§3.2 production root 계층과 동형), task-file/authorization/grant/
// arm-state snapshot/pin/실 arm store 전부를 이 함수 안에서 만든다(각 조각은
// 위 helper로 분리 -- quality-check 함수당 라인 상한 준수).
function buildFixture(dir, overrides = {}) {
  const bundleDir = join(dir, "inbox");
  const stateDir = join(dir, "state");
  const ledgerDir = join(dir, "ledger");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });

  const armId = overrides.armId ?? ARM_ID;
  const jti = overrides.jti ?? JTI;
  const taskFileContent = overrides.taskFileContent ?? TASK_FILE_CONTENT;
  const taskFilePath = join(dir, "coder-task.md");
  writeFileSync(taskFilePath, taskFileContent, "utf8");
  const taskSha256 = sha256(taskFileContent);

  const authFields = buildAuthFields(
    dir,
    armId,
    taskFilePath,
    taskSha256,
    overrides,
  );
  const authCanon = canonicalizeAuthorization(authFields);
  assert.equal(
    authCanon.ok,
    true,
    `fixture canonicalizeAuthorization failed: ${authCanon.reason}`,
  );

  const grantFields = buildGrantFields(
    armId,
    jti,
    taskSha256,
    authCanon.sha256,
    overrides,
  );
  const pinPath = writeBundleFiles(
    dir,
    bundleDir,
    armId,
    jti,
    authFields,
    grantFields,
    overrides,
  );
  createLiveArmStore(stateDir, armId, overrides);
  const { expected, expectedTask, scope } = buildExpectedAndScope(
    dir,
    armId,
    taskFilePath,
    grantFields,
  );

  return {
    dir,
    bundleDir,
    stateDir,
    ledgerDir,
    pinPath,
    taskFilePath,
    armId,
    jti,
    expected,
    expectedTask,
    scope,
  };
}

function baseInput(fx, overrides = {}) {
  return {
    dir: fx.stateDir,
    armId: fx.armId,
    bundleDir: fx.bundleDir,
    jti: fx.jti,
    pinnedPublicKeyPath: fx.pinPath,
    ledgerDir: fx.ledgerDir,
    taskFilePath: fx.taskFilePath,
    scope: fx.scope,
    expectedTask: fx.expectedTask,
    expected: fx.expected,
    nowMs: IN_WINDOW_NOW,
    nowMs2: IN_WINDOW_NOW,
    attemptId: "attempt-1",
    at: "t1",
    workerEnv: { PATH: "C:/fake/path" },
    ...overrides,
  };
}

function makeAdapter(resultOrFn) {
  const calls = [];
  const fn = (ctx) => {
    calls.push(ctx);
    if (typeof resultOrFn === "function") return resultOrFn(ctx);
    return resultOrFn ?? { exitCode: 0, signal: null };
  };
  fn.calls = calls;
  return fn;
}
// arm-state.mjs의 claim()은 grant.expires_at 대조에 deps.nowFn()(기본
// Date.now())을 직접 쓴다 -- pull-admission의 nowMs와는 별개 시계다. fixture의
// 고정 시각(IN_WINDOW_NOW)과 어긋나지 않도록 armDeps.nowFn을 기본으로 주입한다
// (실 벽시계에 우연히 걸리는 flaky 테스트 방지).
function baseOpts(overrides = {}) {
  return {
    reportStatusFn: () => ({ ok: true }),
    adapterFn: makeAdapter(),
    armDeps: { nowFn: () => IN_WINDOW_NOW },
    ...overrides,
  };
}

function readArmState(stateDir, armId) {
  return JSON.parse(readFileSync(armStorePath(stateDir, armId), "utf8"));
}
function ledgerFileCount(ledgerDir) {
  try {
    return readdirSync(ledgerDir).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// causal control -- valid bundle + 정상 순서 -> fresh adapter 정확히 1회(fake) + ALLOW
// ---------------------------------------------------------------------------
test("causal control: valid bundle -> adapter exactly 1, arm DISARMED(complete), ledger claimed", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.phase, "finished");
    assert.equal(result.outcome, "done");
    assert.equal(result.adapterCallCount, 1);
    assert.equal(opts.adapterFn.calls.length, 1);
    const store = readArmState(fx.stateDir, fx.armId);
    assert.equal(store.state, "DISARMED");
    assert.equal(store.disarm_cause, "complete");
    assert.equal(ledgerFileCount(fx.ledgerDir), 1);
  });
});

// ---------------------------------------------------------------------------
// P3: 각 preflight(0~4) 실패 fixture별 STATUS/jti/arm claim/adapter count=0
// ---------------------------------------------------------------------------
test("P3/step0-1: own-consumption lane mismatch -> arm-state untouched, adapter 0, ledger 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const before = readFileSync(armStorePath(fx.stateDir, fx.armId), "utf8");
    const opts = baseOpts();
    const input = baseInput(fx, { scope: { ...fx.scope, lane: "REVIEW" } });
    const result = runPullSupervisedAttempt(input, opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "own_consumption");
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
    assert.equal(
      readFileSync(armStorePath(fx.stateDir, fx.armId), "utf8"),
      before,
    );
  });
});

test("P3/step3: admission-denied (bad signature) -> jti claim 0, arm still ARMED, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    // signed-grant 파일을 직접 열어 signature를 깨뜨린다(canonical fields는 그대로 --
    // 서명 검증 단계에서만 걸리는 반사실).
    const grantPath = pullBundleGrantPath(fx.bundleDir, fx.armId, fx.jti);
    const envelope = JSON.parse(readFileSync(grantPath, "utf8"));
    writeJson(grantPath, { ...envelope, signature: "bm90LWEtdmFsaWQtc2ln" });
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight_1");
    assert.equal(result.stage, "admission");
    assert.equal(result.reason, REASON.ADMISSION_DENIED);
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
    assert.equal(readArmState(fx.stateDir, fx.armId).state, "ARMED");
  });
});

test("P3/step3: admission-denied (expired) -> jti claim 0, arm still ARMED, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts();
    const afterExpiry = Date.parse("2026-07-21T01:00:00.000Z");
    const result = runPullSupervisedAttempt(
      baseInput(fx, { nowMs: afterExpiry, nowMs2: afterExpiry }),
      opts,
    );
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight_1");
    assert.equal(result.stage, "admission");
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
    assert.equal(readArmState(fx.stateDir, fx.armId).state, "ARMED");
  });
});

test("P3/step3: admission-denied (wrong channel expectation) -> jti claim 0, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts();
    const input = baseInput(fx, {
      expected: { ...fx.expected, channel: "some-other-channel" },
    });
    const result = runPullSupervisedAttempt(input, opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight_1");
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
  });
});

// ---------------------------------------------------------------------------
// P4: trusted task-file 직접 결속(내용/경로/task_id) -- 실패 시 claim 0
// ---------------------------------------------------------------------------
test("P4: real task-file content hash differs from signed grant task_sha256 -> claim 0, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    // 서명은 원본 내용 그대로 유지한 채, 실제 디스크의 task-file만 사후 변조한다
    // (admission은 bundle 3파일끼리의 내부 정합만 보므로 이 변조를 못 잡는다 --
    // 오직 supervisor의 step4 task-file 재대조만 이걸 잡아야 한다).
    writeFileSync(
      fx.taskFilePath,
      `task_id: ${TASK_ID}\nTAMPERED BODY\n`,
      "utf8",
    );
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight_1");
    assert.equal(result.stage, "task_file");
    assert.equal(result.reason, REASON.TASK_FILE_MISMATCH);
    assert.match(result.detail, /sha256/);
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
    assert.equal(readArmState(fx.stateDir, fx.armId).state, "ARMED");
  });
});

test("P4: real task-file task_id header differs -> claim 0, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir, {
      taskFileContent: `task_id: HYK-000-other\nbody\n`,
    });
    // authorization/grant는 fixture가 이미 이 내용의 해시로 서명됐으므로 sha256은
    // 일치한다 -- 오직 task_id 헤더 불일치만 반사실로 검증.
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "task_file");
    assert.equal(result.reason, REASON.TASK_FILE_MISMATCH);
    assert.match(result.detail, /task_id/);
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
  });
});

test("P4: unreadable task-file -> claim 0, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const input = baseInput(fx, {
      taskFilePath: join(fx.dir, "does-not-exist.md"),
    });
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(input, opts);
    assert.equal(result.ok, false);
    // expected.resolved_task_path(원래 taskFilePath) != authorization.resolved_task_path
    // 대조가 먼저 걸리거나 admission 자체가 대조 실패로 걸린다 -- 어느 쪽이든 claim 0.
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
  });
});

// ---------------------------------------------------------------------------
// P4/순서: STATUS 실패 -> jti/arm claim 0. jti claim 성공 뒤 arm claim 실패 ->
// adapter 0·jti는 소진(환불 없음).
// ---------------------------------------------------------------------------
test("order: STATUS pre-report failure -> jti/arm claim 0, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts({
      reportStatusFn: () => ({ ok: false, reason: "STATUS boom" }),
    });
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "status_report");
    assert.equal(result.jtiConsumed, false);
    assert.equal(result.armClaimed, false);
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
    assert.equal(readArmState(fx.stateDir, fx.armId).state, "ARMED");
  });
});

test("order: jti claim succeeds then arm claim fails (budget exhausted) -> adapter 0, jti stays consumed (no refund)", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir, { liveMaxStartsTotal: 0 });
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "arm_claim");
    assert.equal(result.reason, REASON.ARM_CLAIM_FAILED);
    assert.equal(
      result.jtiConsumed,
      true,
      "jti must already be consumed by the time arm claim runs",
    );
    assert.equal(result.armClaimed, false);
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(
      ledgerFileCount(fx.ledgerDir),
      1,
      "ledger keeps the jti record even though arm claim failed",
    );
    assert.equal(readArmState(fx.stateDir, fx.armId).state, "DISARMED");
    // 같은 jti로 재시도해도 이미 소진 -- 예산을 늘려도 jti는 되살아나지 않는다.
    const secondTry = runPullSupervisedAttempt(baseInput(fx), baseOpts());
    assert.equal(secondTry.ok, false);
    assert.equal(secondTry.phase, "jti_claim");
    assert.equal(secondTry.reason, REASON.JTI_ALREADY_CLAIMED);
  });
});

// ---------------------------------------------------------------------------
// P4/TOCTOU: 2차 재대조에서만 변이가 나타나면 -- arm DISARM·adapter 0, 그러나
// jti/arm claim은 되돌리지 않는다(1차 실패의 "claim 0"과 다른 정책, 반드시
// 서로 다른 테스트로 구분 실증).
// ---------------------------------------------------------------------------
function makeTocTouReadFileFn(targetPath, tamperedContent, revealAfterCount) {
  let count = 0;
  return (p) => {
    if (p === targetPath) {
      count++;
      if (count > revealAfterCount) return tamperedContent;
    }
    return readFileSync(p, "utf8");
  };
}

test("TOCTOU: signed-grant file swapped between 1st and 2nd preflight -> arm DISARMED, adapter 0, jti/arm claim NOT rolled back", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const grantPath = pullBundleGrantPath(fx.bundleDir, fx.armId, fx.jti);
    // 1차 preflight의 grant 읽기(1회) + jti claim 전 key_id 재조회(1회) = 2회는
    // 원본을 그대로 보여주고, 그 다음(2차 preflight)부터는 서명이 깨진 다른 내용을
    // 반환한다 -- "claim 뒤·spawn 전 사이 bundle 파일이 바뀌는" TOCTOU 창을
    // 결정론적으로 재현.
    const tampered = JSON.stringify({
      grantRaw: JSON.parse(readFileSync(grantPath, "utf8")).grantRaw,
      signature: "dGFtcGVyZWQtc2lnbmF0dXJl",
    });
    const readFileFn = makeTocTouReadFileFn(grantPath, tampered, 2);
    const opts = baseOpts({ readFileFn });
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight_2");
    assert.equal(result.reason, REASON.PREFLIGHT_RECHECK_FAILED);
    assert.equal(
      result.jtiConsumed,
      true,
      "1차 admission이 이미 통과했으므로 jti는 소비된 채로 남는다",
    );
    assert.equal(
      result.armClaimed,
      true,
      "arm claim도 이미 성공했으므로 되돌리지 않는다",
    );
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 1);
    const store = readArmState(fx.stateDir, fx.armId);
    assert.equal(store.state, "DISARMED");
    assert.equal(store.disarm_cause, "cancelled");
  });
});

// ---------------------------------------------------------------------------
// P5: 고정 ledger root replay matrix -- adapter 총 호출 <=1, 같은 jti 2번째 DENY
// ---------------------------------------------------------------------------
test("P5: same-jti sequential replay -- first adapter=1, second DENY adapter=0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const first = runPullSupervisedAttempt(baseInput(fx), baseOpts());
    assert.equal(first.ok, true);
    const opts2 = baseOpts();
    const second = runPullSupervisedAttempt(baseInput(fx), opts2);
    assert.equal(second.ok, false);
    assert.equal(second.reason, REASON.JTI_ALREADY_CLAIMED);
    assert.equal(opts2.adapterFn.calls.length, 0);
    assert.equal(
      ledgerFileCount(fx.ledgerDir),
      1,
      "replay must not create a second ledger record",
    );
  });
});

test("P5: same signed bundle copied into a different inbox/state dir, but shared fixed ledger root -> second copy DENY", () => {
  withTempDir((dirA) => {
    withTempDir((dirB) => {
      const fxA = buildFixture(dirA);
      const bundleDirB = join(dirB, "inbox");
      const stateDirB = join(dirB, "state");
      mkdirSync(bundleDirB, { recursive: true });
      mkdirSync(stateDirB, { recursive: true });
      // 정확히 같은 bundle bytes를 다른 디렉터리 트리로 그대로 복사한다(공격자가
      // signed bundle 파일을 다른 inbox/state 경로로 옮겨 심는 시나리오 -- grant
      // 내용이 조금이라도 다르면 grant_digest가 달라져 별개 취급되므로, "복사"를
      // 실제로 검증하려면 authorization/cwd/worktree까지 byte-identical해야 한다).
      for (const name of [
        `signed-grant-${fxA.armId}-${fxA.jti}.json`,
        `authorization-${fxA.armId}.json`,
        `arm-${fxA.armId}.json`,
      ]) {
        writeFileSync(
          join(bundleDirB, name),
          readFileSync(join(fxA.bundleDir, name)),
        );
      }
      writeFileSync(
        armStorePath(stateDirB, fxA.armId),
        readFileSync(armStorePath(fxA.stateDir, fxA.armId)),
      );
      // taskFilePath/expected/scope는 fxA 그대로 재사용 -- 복사된 bundle이 여전히
      // 같은 trusted task-file을 가리키므로(내용도 동일), 물리적으로 다른
      // bundleDir/stateDir에서 실행되는 점만 다르다.
      const fxB = { ...fxA, bundleDir: bundleDirB, stateDir: stateDirB };

      // 고정 ledger root를 강제로 공유(운영 root와 동형 -- ledgerDir은 trusted
      // config가 고정하지 grant/bundleDir에서 유도하지 않는다).
      const sharedLedgerDir = fxA.ledgerDir;
      const firstOpts = baseOpts();
      const first = runPullSupervisedAttempt(
        baseInput(fxA, { ledgerDir: sharedLedgerDir }),
        firstOpts,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(firstOpts.adapterFn.calls.length, 1);

      const secondOpts = baseOpts();
      const second = runPullSupervisedAttempt(
        baseInput(fxB, { ledgerDir: sharedLedgerDir }),
        secondOpts,
      );
      assert.equal(second.ok, false);
      assert.equal(
        second.reason,
        REASON.JTI_ALREADY_CLAIMED,
        JSON.stringify(second),
      );
      assert.equal(
        secondOpts.adapterFn.calls.length,
        0,
        "a different bundleDir/stateDir must not bypass the fixed ledger root",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// P6: bounded one-shot waiter
// ---------------------------------------------------------------------------
test("P6 waiter: file never appears -> timeout, waiter never attempts, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir, { jti: "jti-not-sealed-yet" });
    // fixture가 이미 signed-grant 파일을 쓰므로, 다른 jti를 waiter에게 준다 --
    // waiter가 감시하는 정확한 파일 자체가 존재하지 않는 시나리오.
    const opts = baseOpts();
    const input = baseInput(fx, {
      jti: "jti-still-unsealed",
      maxTicks: 3,
      tickIntervalMs: 0,
    });
    const result = runOneShotPullWaiter(input, opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "waiter_timeout");
    assert.equal(result.attempted, false);
    assert.equal(opts.adapterFn.calls.length, 0);
  });
});

test("P6 waiter: unrelated file present (not the exact expected name) -> still times out, no directory scan", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir, { jti: "jti-real-target" });
    writeFileSync(
      join(fx.bundleDir, "signed-grant-unrelated-other.json"),
      "{}",
      "utf8",
    );
    const opts = baseOpts();
    const input = baseInput(fx, {
      jti: "jti-real-target-but-waiter-watches-different",
      maxTicks: 2,
      tickIntervalMs: 0,
    });
    const result = runOneShotPullWaiter(
      { ...input, jti: "jti-does-not-exist" },
      opts,
    );
    assert.equal(result.ok, false);
    assert.equal(result.phase, "waiter_timeout");
    assert.equal(opts.adapterFn.calls.length, 0);
  });
});

test("P6 waiter: valid exact bundle appears -> exactly 1 attempt, adapter 1", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts();
    const input = baseInput(fx, { maxTicks: 2, tickIntervalMs: 0 });
    const result = runOneShotPullWaiter(input, opts);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.attempted, true);
    assert.equal(
      result.watchedPath,
      pullBundleGrantPath(fx.bundleDir, fx.armId, fx.jti),
    );
    assert.equal(opts.adapterFn.calls.length, 1);
  });
});

test("P6 waiter: malformed exact bundle -> waiter still attempts exactly once, admission denies, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    writeFileSync(
      pullBundleGrantPath(fx.bundleDir, fx.armId, fx.jti),
      "not json at all",
      "utf8",
    );
    const opts = baseOpts();
    const result = runOneShotPullWaiter(baseInput(fx, { maxTicks: 1 }), opts);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.equal(result.attempt.phase, "preflight_1");
    assert.equal(opts.adapterFn.calls.length, 0);
  });
});

test("P6 waiter: after completion, a new file appearing does not trigger a second run (no auto-retry/rescan)", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const firstOpts = baseOpts();
    const first = runOneShotPullWaiter(
      baseInput(fx, { maxTicks: 1 }),
      firstOpts,
    );
    assert.equal(first.ok, true);
    assert.equal(firstOpts.adapterFn.calls.length, 1);
    // 같은 jti로 "새 파일이 나타난 척" 다시 waiter를 호출해도(캐리어의 실수 호출을
    // 가정) 이미 소진된 jti라 두 번째 attempt는 반드시 DENY, adapter는 늘지 않는다.
    const secondOpts = baseOpts();
    const second = runOneShotPullWaiter(
      baseInput(fx, { maxTicks: 1 }),
      secondOpts,
    );
    assert.equal(second.attempted, true);
    assert.equal(second.ok, false);
    assert.equal(second.attempt.reason, REASON.JTI_ALREADY_CLAIMED);
    assert.equal(secondOpts.adapterFn.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// P7: adapter sink capture -- argv/stdin/env에 grant·signature·개인키·task 본문 0
// ---------------------------------------------------------------------------
test("P7: adapterFn ctx carries only {task_id,attempt_id,lane,cwd,config,at} -- no signature/grant/task-body leakage", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts();
    const result = runPullSupervisedAttempt(baseInput(fx), opts);
    assert.equal(result.ok, true);
    assert.equal(opts.adapterFn.calls.length, 1);
    const ctx = opts.adapterFn.calls[0];
    assert.deepEqual(Object.keys(ctx).sort(), [
      "at",
      "attempt_id",
      "config",
      "cwd",
      "lane",
      "task_id",
    ]);
    const serialized = JSON.stringify(ctx);
    assert.doesNotMatch(serialized, /BEGIN (RSA |EC )?PRIVATE KEY/);
    assert.doesNotMatch(serialized, /signature/i);
    assert.doesNotMatch(serialized, /some pull-supervisor synthetic task body/);
    assert.doesNotMatch(serialized, new RegExp(fx.jti));
  });
});

// ---------------------------------------------------------------------------
// P8: Claude·Codex 두 adapter 경로 cold-start receipt shape 동일 + hook 등가행렬(S6)
// ---------------------------------------------------------------------------
test("P8: real claude-adapter.mjs and codex-adapter.mjs factories both produce identical done/adapter=1 shape via pull-supervisor", () => {
  withTempDir((dirClaude) => {
    withTempDir((dirCodex) => {
      const fxClaude = buildFixture(dirClaude);
      const fxCodex = buildFixture(dirCodex);
      const spawnSyncCalls = [];
      const spawnSyncFn = (...args) => {
        spawnSyncCalls.push(args);
        return { status: 0, signal: null, stdout: "", stderr: "" };
      };
      const claudeAdapter = createClaudeAdapterFn({
        command: "fake-claude",
        env: { PATH: "x" },
        spawnSyncFn,
      });
      const codexAdapter = createCodexAdapterFn({
        command: "fake-codex",
        env: { PATH: "x" },
        spawnSyncFn,
      });

      const rClaude = runPullSupervisedAttempt(
        baseInput(fxClaude),
        baseOpts({ adapterFn: claudeAdapter }),
      );
      const rCodex = runPullSupervisedAttempt(
        baseInput(fxCodex),
        baseOpts({ adapterFn: codexAdapter }),
      );

      assert.equal(rClaude.ok, true);
      assert.equal(rCodex.ok, true);
      assert.equal(rClaude.outcome, "done");
      assert.equal(rCodex.outcome, "done");
      assert.equal(rClaude.adapterCallCount, 1);
      assert.equal(rCodex.adapterCallCount, 1);
      assert.equal(spawnSyncCalls.length, 2);
      for (const [, , spawnOpts] of spawnSyncCalls) {
        assert.equal(spawnOpts.shell, false);
        assert.deepEqual(spawnOpts.env, { PATH: "x" });
      }
    });
  });
});

// S6 causal control: pull-supervisor.mjs never reads any hook/observation field --
// present/absent/poison getter object attached as extraneous input carries zero
// authority over the outcome, and a poison getter (throw-on-access) is never
// touched (인과 증거, HYK-163 G7과 동형).
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
            "poison hook accessed -- pull-supervisor read hook state (S6 violation)",
          );
        },
      }),
    };
  }
  throw new Error(`unknown hook fixture kind: ${kind}`);
}

const HOOK_KINDS = ["present", "absent", "poison"];

test("S6/P8: Claude hook present/absent/poison -> allow/deny, claim count, spawn count all identical", () => {
  const summaries = {};
  for (const kind of HOOK_KINDS) {
    withTempDir((dir) => {
      const fx = buildFixture(dir);
      const hookFx = makeHookFixture(kind);
      const opts = baseOpts();
      const input = {
        ...baseInput(fx),
        hookObservation: hookFx.hookObservation,
      };
      const result = runPullSupervisedAttempt(input, opts);
      assert.equal(
        hookFx.state.accessCount,
        0,
        `${kind}: pull-supervisor must never access hookObservation`,
      );
      summaries[kind] = {
        ok: result.ok,
        outcome: result.outcome,
        adapterCallCount: opts.adapterFn.calls.length,
      };
    });
  }
  assert.deepEqual(summaries.present, summaries.absent);
  assert.deepEqual(summaries.absent, summaries.poison);
  assert.equal(summaries.present.ok, true);
  assert.equal(summaries.present.adapterCallCount, 1);
});

// ---------------------------------------------------------------------------
// P9: capability 경계 -- child env allowlist, reserved-action sink 0
// ---------------------------------------------------------------------------
test("checkWorkerEnvAllowlist: default allowlist accepts PATH-only env", () => {
  const result = checkWorkerEnvAllowlist({ PATH: "x" });
  assert.equal(result.ok, true);
});

test("checkWorkerEnvAllowlist: credential-like extra key is rejected", () => {
  const result = checkWorkerEnvAllowlist({
    PATH: "x",
    AWS_SECRET_ACCESS_KEY: "leak",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ["AWS_SECRET_ACCESS_KEY"]);
});

test("P9: workerEnv with a disallowed key -> DENY before STATUS/jti/arm claim, adapter 0", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const opts = baseOpts();
    const input = baseInput(fx, {
      workerEnv: { PATH: "x", CLAUDE_ROLE_OVERRIDE: "north-star-bypass" },
    });
    const result = runPullSupervisedAttempt(input, opts);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "env_allowlist");
    assert.equal(result.reason, REASON.ENV_ALLOWLIST_VIOLATION);
    assert.equal(result.jtiConsumed, false);
    assert.equal(result.armClaimed, false);
    assert.equal(opts.adapterFn.calls.length, 0);
    assert.equal(ledgerFileCount(fx.ledgerDir), 0);
    assert.equal(readArmState(fx.stateDir, fx.armId).state, "ARMED");
  });
});

// static scan (보조 증거 -- causal fixture가 위에서 이미 실증) -- 실제 호출부
// 패턴만 찾는다(주석 속 "Linear"/"PR"/"Orca" 같은 정직 서술 단어 자체는
// 오탐 대상이 아니게 call-site 문법에 결속된 패턴만 사용).
const FORBIDDEN_CALL_PATTERNS = [
  /require\(\s*["']child_process["']\s*\)/,
  /from\s+["']node:child_process["']/,
  /\bspawnSync\s*\(/,
  /\bspawn\s*\(/,
  /\bexecSync?\s*\(/,
  /\bfetch\s*\(/,
  /https?\.request\s*\(/,
  /octokit/i,
  /createPullRequest/i,
  /gh\s+pr\s+create/i,
  /\.dispatch\s*\(/,
  /UserPromptSubmit/,
  /PreToolUse/,
  /process\.env\.CLAUDE/,
  /--inject\b/,
];
test("P9/P15 static scan: pull-supervisor.mjs source has zero direct-effect side-channel call sites (publish/PR/Linear/spawn/orca-inject)", () => {
  const src = readFileSync(
    new URL("./pull-supervisor.mjs", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  for (const pattern of FORBIDDEN_CALL_PATTERNS) {
    assert.doesNotMatch(src, pattern, `forbidden pattern matched: ${pattern}`);
  }
});

// ---------------------------------------------------------------------------
// P15: live enable=false 유지 -- session reuse/inject로 자동 완화 0, config diff 0
// ---------------------------------------------------------------------------
test("P15: module exports contain no live-enable toggle / session-reuse escape hatch", () => {
  return import("./pull-supervisor.mjs").then((mod) => {
    const exportNames = Object.keys(mod);
    for (const name of exportNames) {
      assert.doesNotMatch(
        name,
        /live.?enable/i,
        `unexpected live-enable export: ${name}`,
      );
      assert.doesNotMatch(
        name,
        /session.?reuse/i,
        `unexpected session-reuse export: ${name}`,
      );
    }
  });
});

test("P15: every fail/UNVERIFIED path returns adapterCalled!==true (terminal policy stays fail-closed, no silent auto-mitigation)", () => {
  withTempDir((dir) => {
    const fx = buildFixture(dir);
    const denials = [];
    // own-consumption
    denials.push(
      runPullSupervisedAttempt(
        baseInput(fx, { scope: { ...fx.scope, lane: "REVIEW" } }),
        baseOpts(),
      ),
    );
    // admission (expired)
    const afterExpiry = Date.parse("2026-07-21T01:00:00.000Z");
    denials.push(
      runPullSupervisedAttempt(
        baseInput(fx, { nowMs: afterExpiry, nowMs2: afterExpiry }),
        baseOpts(),
      ),
    );
    // env allowlist
    denials.push(
      runPullSupervisedAttempt(
        baseInput(fx, { workerEnv: { PATH: "x", SECRET: "y" } }),
        baseOpts(),
      ),
    );
    for (const d of denials) {
      assert.notEqual(d.ok, true);
      assert.notEqual(d.adapterCalled, true);
    }
  });
});
