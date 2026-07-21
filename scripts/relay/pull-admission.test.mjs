import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { judgePullAdmission, REASON } from "./pull-admission.mjs";
import { canonicalizePullGrant } from "./pull-grant-canonical.mjs";
import { canonicalizeAuthorization } from "./pull-authorization.mjs";
import { sign } from "./auth-grant-ed25519.mjs";

// M1(비타협): 이 파일의 모든 키쌍·grant·authorization·arm-state·pin manifest는
// 테스트 시점에 생성되는 합성(synthetic) fixture다. 전부 mkdtempSync 임시
// 디렉터리 안에서만 만들고 지운다(disposable/ephemeral만, 실 정본·
// `C:\...\.harness\pull-delivery\v1\` 미접촉 -- coder-task.md M1 격리).

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pull-admission-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ISSUED_AT = "2026-07-21T00:00:00.000Z";
const EXPIRES_AT = "2026-07-21T00:20:00.000Z";
const IN_WINDOW_NOW = Date.parse("2026-07-21T00:10:00.000Z");

const ARM_ID = "arm-test-1";
const JTI = "jti-test-1";

const TASK_HEADER_SHA256 = sha256("synthetic-task-file-content");
const LAUNCH_PROFILE_SHA256 = sha256("synthetic-launch-profile");
const WORKER_CONFIG_SHA256 = sha256("synthetic-worker-config");

const AUTHORIZATION_FIELDS = Object.freeze({
  schema_version: 1,
  arm_id: ARM_ID,
  cycle_id: "cycle-test-1",
  task_id: "HYK-999-coder-1",
  resolved_task_path: "C:\\fake\\.harness\\coder-task.md",
  task_header_id: "HYK-999-coder-1",
  task_header_sha256: TASK_HEADER_SHA256,
  lane: "CODER",
  cwd: "C:\\fake\\repo",
  worktree: "C:\\fake\\repo",
  launch_profile_sha256: LAUNCH_PROFILE_SHA256,
  worker_config_sha256: WORKER_CONFIG_SHA256,
  person_approval_ref: "PKT-TEST-1:승인:OK:2026-07-21",
  publish_allowed: false,
  retry_allowed: false,
  on_question: "pause",
  on_error: "pause",
});

function authorizationSha256() {
  const canon = canonicalizeAuthorization(AUTHORIZATION_FIELDS);
  assert.equal(canon.ok, true, canon.reason);
  return canon.sha256;
}

const GRANT_FIELDS = Object.freeze({
  schema_version: 2,
  policy_version: 1,
  packet_sha256: sha256("synthetic-packet"),
  addendum_sha256: sha256("synthetic-addendum"),
  authorization_sha256: authorizationSha256(),
  task_sha256: TASK_HEADER_SHA256,
  task_id: "HYK-999-coder-1",
  target: Object.freeze({
    handle: "test-terminal",
    fingerprint: "test-fingerprint",
    agent_instance: "test-agent-instance",
    launch_profile_sha256: LAUNCH_PROFILE_SHA256,
  }),
  audience: "CODER",
  channel: "harness-signed-pull-v1",
  arm_id: ARM_ID,
  cycle_id: "cycle-test-1",
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
  budget: Object.freeze({ max_starts_total: 1 }),
  jti: JTI,
});

const ARM_STATE_FIELDS = Object.freeze({
  arm_id: ARM_ID,
  cycle_id: GRANT_FIELDS.cycle_id,
  task_id: GRANT_FIELDS.task_id,
  lane: AUTHORIZATION_FIELDS.lane,
  expires_at: EXPIRES_AT,
  budget: { max_starts_total: 1 },
});

const GOOD_SIGNER = generateKeyPairSync("ed25519");
const GOOD_SIGNER_FINGERPRINT = sha256(pem(GOOD_SIGNER.publicKey, "public"));

const EXPECTED = Object.freeze({
  schema_version: GRANT_FIELDS.schema_version,
  policy_version: GRANT_FIELDS.policy_version,
  task_id: GRANT_FIELDS.task_id,
  arm_id: GRANT_FIELDS.arm_id,
  cycle_id: GRANT_FIELDS.cycle_id,
  target: Object.freeze({ ...GRANT_FIELDS.target }),
  audience: GRANT_FIELDS.audience,
  channel: GRANT_FIELDS.channel,
  pinned_key_fingerprint: GOOD_SIGNER_FINGERPRINT,
  resolved_task_path: AUTHORIZATION_FIELDS.resolved_task_path,
  task_header_id: AUTHORIZATION_FIELDS.task_header_id,
  lane: AUTHORIZATION_FIELDS.lane,
  cwd: AUTHORIZATION_FIELDS.cwd,
  worktree: AUTHORIZATION_FIELDS.worktree,
  worker_config_sha256: AUTHORIZATION_FIELDS.worker_config_sha256,
  packet_sha256: GRANT_FIELDS.packet_sha256,
});

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

// bundleDir에 signed-grant/authorization/arm-state 3파일을 표준 이름으로
// 쓴다(P10 §3.2 파일 분리 계약). overrides로 각 파일 내용을 개별 변조할 수
// 있다(반사실 테스트용).
function writeBundle(dir, overrides = {}) {
  const grantFields = { ...GRANT_FIELDS, ...(overrides.grantFields ?? {}) };
  const authFields = {
    ...AUTHORIZATION_FIELDS,
    ...(overrides.authFields ?? {}),
  };
  const armFields = { ...ARM_STATE_FIELDS, ...(overrides.armFields ?? {}) };
  const armId = overrides.filenameArmId ?? ARM_ID;
  const jti = overrides.filenameJti ?? JTI;

  const pinPath = writePin(dir, [
    {
      key_id: "k-good",
      public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
      status: "active",
    },
  ]);
  const env = grantEnvelope(grantFields, GOOD_SIGNER.privateKey, "k-good");
  writeJson(join(dir, `signed-grant-${armId}-${jti}.json`), env);
  writeJson(join(dir, `authorization-${armId}.json`), authFields);
  writeJson(join(dir, `arm-${armId}.json`), armFields);
  return { pinPath };
}

function baseInput(dir, pinPath, overrides = {}) {
  return {
    bundleDir: dir,
    armId: ARM_ID,
    jti: JTI,
    pinnedPublicKeyPath: pinPath,
    expected: EXPECTED,
    nowMs: IN_WINDOW_NOW,
    ...overrides,
  };
}

// ---- causal control: valid bundle -> ALLOW ----
test("judgePullAdmission: known-good bundle -> ALLOW (causal control)", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.reason, REASON.ALLOW);
    assert.ok(result.fields);
    assert.ok(result.authorization);
    assert.ok(result.armState);
  });
});

// ---- P1: schema/서명 negative matrix ----
test("judgePullAdmission: issued_at missing (canonical rejects) -> DENY CANONICAL_INVALID", () => {
  withTempDir((dir) => {
    const grantFields = { ...GRANT_FIELDS };
    delete grantFields.issued_at;
    const env = grantEnvelope(
      { ...GRANT_FIELDS, issued_at: "2026-07-21T00:00:00.000Z" },
      GOOD_SIGNER.privateKey,
      "k-good",
    );
    // 서명은 유효 grant로 만들되, 파일에는 issued_at을 지운 raw JSON을
    // 직접 쓴다(공격자가 canonicalize 전 단계 JSON을 손으로 변조하는
    // 시나리오와 동형 -- 서명 검증 전에 CANONICAL_INVALID로 걸려야 한다).
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
        status: "active",
      },
    ]);
    const tampered = { ...env.grantRaw };
    delete tampered.issued_at;
    writeJson(join(dir, `signed-grant-${ARM_ID}-${JTI}.json`), {
      grantRaw: tampered,
      signature: env.signature,
    });
    writeJson(join(dir, `authorization-${ARM_ID}.json`), AUTHORIZATION_FIELDS);
    writeJson(join(dir, `arm-${ARM_ID}.json`), ARM_STATE_FIELDS);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.CANONICAL_INVALID);
  });
});

test("judgePullAdmission: issued_at in the future (vs nowMs) -> DENY ISSUED_AT_FUTURE", () => {
  withTempDir((dir) => {
    const futureIssued = "2026-07-21T00:15:00.000Z"; // still < expires_at, but > nowMs (00:10)
    const { pinPath } = writeBundle(dir, {
      grantFields: { issued_at: futureIssued },
    });
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ISSUED_AT_FUTURE);
  });
});

test("judgePullAdmission: nowMs past expires_at -> DENY EXPIRED", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const afterExpiry = Date.parse(EXPIRES_AT) + 1;
    const result = judgePullAdmission(
      baseInput(dir, pinPath, { nowMs: afterExpiry }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.EXPIRED);
  });
});

// TTL>30분 grant는 canonicalize 단계에서부터 구성 불가능하다(fail-closed by
// construction -- pull-grant-canonical.test.mjs가 그 구조 검증을 직접 커버).
// 여기서는 "그런 grant는 애초에 bundle에 실릴 수 없다"는 통합 경계만 재확인한다.
test("judgePullAdmission: TTL>30min grant cannot even be constructed for the bundle (fail-closed by construction)", () => {
  const canon = canonicalizePullGrant({
    ...GRANT_FIELDS,
    issued_at: "2026-07-21T00:00:00.000Z",
    expires_at: "2026-07-21T00:31:00.000Z",
  });
  assert.equal(canon.ok, false);
  assert.match(canon.reason, /30 minutes/);
});

test("judgePullAdmission: signature tampered -> DENY SIGNATURE_INVALID", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const grantPath = join(dir, `signed-grant-${ARM_ID}-${JTI}.json`);
    const env = JSON.parse(readFileSync(grantPath, "utf8"));
    env.grantRaw.task_id = "HYK-MUTATED";
    writeJson(grantPath, env);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.SIGNATURE_INVALID);
  });
});

// ---- P2: key custody negative matrix ----
test("judgePullAdmission: wrong pin (attacker key registered under same key_id) -> DENY PIN_MISMATCH", () => {
  withTempDir((dir) => {
    const attackerSigner = generateKeyPairSync("ed25519");
    const genuineFingerprint = GOOD_SIGNER_FINGERPRINT;
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(attackerSigner.publicKey, "public"),
        status: "active",
      },
    ]);
    const env = grantEnvelope(
      GRANT_FIELDS,
      attackerSigner.privateKey,
      "k-good",
    );
    writeJson(join(dir, `signed-grant-${ARM_ID}-${JTI}.json`), env);
    writeJson(join(dir, `authorization-${ARM_ID}.json`), AUTHORIZATION_FIELDS);
    writeJson(join(dir, `arm-${ARM_ID}.json`), ARM_STATE_FIELDS);
    const result = judgePullAdmission(
      baseInput(dir, pinPath, {
        expected: { ...EXPECTED, pinned_key_fingerprint: genuineFingerprint },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PIN_MISMATCH);
  });
});

test("judgePullAdmission: missing pin file -> DENY PIN_UNAVAILABLE (fail-closed)", () => {
  withTempDir((dir) => {
    writeBundle(dir);
    const result = judgePullAdmission(
      baseInput(dir, join(dir, "does-not-exist.json")),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PIN_UNAVAILABLE);
  });
});

test("judgePullAdmission: revoked key -> DENY KEY_REVOKED", () => {
  withTempDir((dir) => {
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
        status: "revoked",
      },
    ]);
    const env = grantEnvelope(GRANT_FIELDS, GOOD_SIGNER.privateKey, "k-good");
    writeJson(join(dir, `signed-grant-${ARM_ID}-${JTI}.json`), env);
    writeJson(join(dir, `authorization-${ARM_ID}.json`), AUTHORIZATION_FIELDS);
    writeJson(join(dir, `arm-${ARM_ID}.json`), ARM_STATE_FIELDS);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.KEY_REVOKED);
  });
});

test("judgePullAdmission: key_id not present in pin manifest -> DENY KEY_UNKNOWN", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const grantPath = join(dir, `signed-grant-${ARM_ID}-${JTI}.json`);
    const env = JSON.parse(readFileSync(grantPath, "utf8"));
    env.grantRaw = { ...env.grantRaw, key_id: "k-does-not-exist" };
    writeJson(grantPath, env);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.KEY_UNKNOWN);
  });
});

// ---- P10: bundle 결속 negative matrix ----
// authorization 파일을 직접 변조하면 authorization_sha256(grant에 서명된 값)과
// 불일치해 AUTHORIZATION_HASH_MISMATCH로 걸린다(내용 위조 탐지 1차 방어선) --
// 단 arm_id는 파일명↔내용 결속 검사(BUNDLE_IDENTITY_MISMATCH)가 해시 검사보다
// 먼저 도달하므로 reason이 다르다(둘 다 DENY, 원인 특정이 다를 뿐).
const BUNDLE_MUTATIONS = [
  [
    "authorization arm_id",
    { authFields: { arm_id: "arm-other" } },
    "BUNDLE_IDENTITY_MISMATCH",
  ],
  [
    "authorization task_header_sha256",
    { authFields: { task_header_sha256: sha256("mutated") } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
  [
    "authorization launch_profile_sha256",
    { authFields: { launch_profile_sha256: sha256("mutated-lp") } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
  [
    "authorization resolved_task_path",
    { authFields: { resolved_task_path: "C:\\other\\path.md" } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
  [
    "authorization lane",
    { authFields: { lane: "REVIEW" } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
  [
    "authorization cwd",
    { authFields: { cwd: "C:\\other\\cwd" } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
  [
    "authorization worktree",
    { authFields: { worktree: "C:\\other\\worktree" } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
  // HYK-165 사이클2 REVIEW-A 반려 수리(coder-3): worker_config_sha256 결속의
  // 1차 방어선 -- 이 필드가 authorization canonical schema에 없으면(반려
  // 재발) 이 mutation이 해시를 안 바꿔 여기서 통과해 버려 실패한다.
  [
    "authorization worker_config_sha256",
    { authFields: { worker_config_sha256: sha256("mutated-worker-config") } },
    "AUTHORIZATION_HASH_MISMATCH",
  ],
];
for (const [label, override, expectedReasonName] of BUNDLE_MUTATIONS) {
  test(`judgePullAdmission: ${label} mutated -> DENY ${expectedReasonName}`, () => {
    withTempDir((dir) => {
      const { pinPath } = writeBundle(dir, override);
      const result = judgePullAdmission(baseInput(dir, pinPath));
      assert.equal(result.ok, false, label);
      assert.equal(result.reason, REASON[expectedReasonName], label);
    });
  });
}

// 2차 방어선 실증: authorization 파일을 "그 자체로 내부 정합"하게 다시
// 서명(=재계산된 authorization_sha256으로 grant를 재서명)해도, expected와
// 다르면 여전히 걸린다 -- 즉 hash 일치만으로 admission이 속지 않는다는 것.
test("judgePullAdmission: authorization internally-consistent but task path differs from expected -> DENY AUTHORIZATION_CONTEXT_MISMATCH", () => {
  withTempDir((dir) => {
    const mutatedAuth = {
      ...AUTHORIZATION_FIELDS,
      resolved_task_path: "C:\\other\\path.md",
    };
    const authCanon = canonicalizeAuthorization(mutatedAuth);
    assert.equal(authCanon.ok, true);
    const grantFields = {
      ...GRANT_FIELDS,
      authorization_sha256: authCanon.sha256,
    };
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
        status: "active",
      },
    ]);
    const env = grantEnvelope(grantFields, GOOD_SIGNER.privateKey, "k-good");
    writeJson(join(dir, `signed-grant-${ARM_ID}-${JTI}.json`), env);
    writeJson(join(dir, `authorization-${ARM_ID}.json`), mutatedAuth);
    writeJson(join(dir, `arm-${ARM_ID}.json`), ARM_STATE_FIELDS);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.AUTHORIZATION_CONTEXT_MISMATCH);
  });
});

// HYK-165 사이클2 REVIEW-A 반려 수리(coder-3): config의 2차 방어선 -- 위
// resolved_task_path 테스트와 동형으로, worker_config_sha256도 authorization
// 파일 안에서는 내부 정합(재서명)하지만 supervisor의 trusted expected와
// 다르면 여전히 걸려야 한다. 이 테스트가 죽이는 변이: checkAuthorizationContext()
// expected 대조 목록에 worker_config_sha256을 빠뜨리면(반려 재발) 여기서
// ALLOW가 나와 버려 실패한다.
test("judgePullAdmission: authorization internally-consistent but worker_config_sha256 differs from expected -> DENY AUTHORIZATION_CONTEXT_MISMATCH", () => {
  withTempDir((dir) => {
    const mutatedAuth = {
      ...AUTHORIZATION_FIELDS,
      worker_config_sha256: sha256("attacker-worker-config"),
    };
    const authCanon = canonicalizeAuthorization(mutatedAuth);
    assert.equal(authCanon.ok, true);
    const grantFields = {
      ...GRANT_FIELDS,
      authorization_sha256: authCanon.sha256,
    };
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
        status: "active",
      },
    ]);
    const env = grantEnvelope(grantFields, GOOD_SIGNER.privateKey, "k-good");
    writeJson(join(dir, `signed-grant-${ARM_ID}-${JTI}.json`), env);
    writeJson(join(dir, `authorization-${ARM_ID}.json`), mutatedAuth);
    writeJson(join(dir, `arm-${ARM_ID}.json`), ARM_STATE_FIELDS);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.AUTHORIZATION_CONTEXT_MISMATCH);
  });
});

// ---- packet_sha256 expected 대조 negative matrix (반려 사유 2) ----
// (a) grant값 mutation -- 새 값으로 유효하게 재서명됐지만 expected(고정
// trusted config)와 다르면 DENY. "expected 어느 경로로든 DENY"의 grant축.
test("judgePullAdmission: grant packet_sha256 signed with a value that differs from expected -> DENY PACKET_HASH_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir, {
      grantFields: { packet_sha256: sha256("mutated-packet") },
    });
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PACKET_HASH_MISMATCH);
  });
});

// (b) 서명 후 raw 파일만 변조(재서명 없음) -- "signature 경로로든 DENY"의
// 실증. 기존 "signature tampered" 테스트(task_id 변조)와 동일 패턴을
// packet_sha256 축으로 재현.
test("judgePullAdmission: grant packet_sha256 tampered post-signing (no resign) -> DENY SIGNATURE_INVALID", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const grantPath = join(dir, `signed-grant-${ARM_ID}-${JTI}.json`);
    const env = JSON.parse(readFileSync(grantPath, "utf8"));
    env.grantRaw.packet_sha256 = sha256("post-signing-tamper");
    writeJson(grantPath, env);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.SIGNATURE_INVALID);
  });
});

// ---- channel per-변수 증인 보강(반려 사유 3) ----
// 기존 "expected task_id/arm_id/.../channel mismatch" 테스트는 expected쪽
// channel을 바꾸는 경우만 커버한다(CHANNEL_MISMATCH). 여기서는 grant쪽
// channel을 서명 후 직접 변조(재서명 없음)해 signature 경로로도 claim 0이
// 됨을 별도로 실증한다 -- "grant channel 변조(→ signature fail 경로라도
// claim 0)와 기존 expected-channel DENY 둘 다 유지·명시" 요구사항.
test("judgePullAdmission: grant channel tampered post-signing (no resign) -> DENY SIGNATURE_INVALID", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const grantPath = join(dir, `signed-grant-${ARM_ID}-${JTI}.json`);
    const env = JSON.parse(readFileSync(grantPath, "utf8"));
    env.grantRaw.channel = "attacker-channel";
    writeJson(grantPath, env);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.SIGNATURE_INVALID);
  });
});

test("judgePullAdmission: arm-state subset (lane) diverges from authorization -> DENY ARM_STATE_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir, { armFields: { lane: "REVIEW" } });
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ARM_STATE_MISMATCH);
  });
});

test("judgePullAdmission: arm-state subset (expires_at) diverges from grant -> DENY ARM_STATE_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir, {
      armFields: { expires_at: "2026-07-21T00:19:00.000Z" },
    });
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ARM_STATE_MISMATCH);
  });
});

test("judgePullAdmission: arm-state subset (budget) diverges -> DENY ARM_STATE_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir, {
      armFields: { budget: { max_starts_total: 2 } },
    });
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ARM_STATE_MISMATCH);
  });
});

// bundle 파일 overwrite/copy -> 불변부 불일치 claim 0: authorization 파일의
// *파일명*은 그대로(arm_id=ARM_ID) 둔 채 *내용*을 다른 arm의 authorization로
// 덮어쓰는 시나리오(파일명/내용 불일치 -- 복사 사고와 동형).
test("judgePullAdmission: authorization file content copied from a different arm (filename says ARM_ID, content says other) -> DENY BUNDLE_IDENTITY_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const otherArmAuth = { ...AUTHORIZATION_FIELDS, arm_id: "arm-other" };
    writeJson(join(dir, `authorization-${ARM_ID}.json`), otherArmAuth);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.BUNDLE_IDENTITY_MISMATCH);
  });
});

test("judgePullAdmission: arm-state file content copied from a different arm -> DENY BUNDLE_IDENTITY_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const otherArmState = { ...ARM_STATE_FIELDS, arm_id: "arm-other" };
    writeJson(join(dir, `arm-${ARM_ID}.json`), otherArmState);
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.BUNDLE_IDENTITY_MISMATCH);
  });
});

test("judgePullAdmission: signed-grant file content copied from a different arm/jti -> DENY BUNDLE_IDENTITY_MISMATCH", () => {
  withTempDir((dir) => {
    writeBundle(dir);
    // 다른 arm/jti용으로 서명된(그러나 유효한) grant를 이 파일명 자리에 복사.
    const otherFields = {
      ...GRANT_FIELDS,
      arm_id: "arm-other",
      jti: "jti-other",
    };
    const env = grantEnvelope(otherFields, GOOD_SIGNER.privateKey, "k-good");
    writeJson(join(dir, `signed-grant-${ARM_ID}-${JTI}.json`), env);
    const pinPath = join(dir, "pin.json");
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.BUNDLE_IDENTITY_MISMATCH);
  });
});

test("judgePullAdmission: missing bundle file -> DENY BUNDLE_READ_ERROR", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    unlinkSync(join(dir, `arm-${ARM_ID}.json`));
    const result = judgePullAdmission(baseInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.BUNDLE_READ_ERROR);
  });
});

test("judgePullAdmission: malformed JSON bundle file -> DENY BUNDLE_READ_ERROR (never throws)", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    writeFileSync(
      join(dir, `authorization-${ARM_ID}.json`),
      "{not valid json",
      "utf8",
    );
    assert.doesNotThrow(() => {
      const result = judgePullAdmission(baseInput(dir, pinPath));
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.BUNDLE_READ_ERROR);
    });
  });
});

// ---- 결속 필드 expected 불일치(replay-into-wrong-context) ----
test("judgePullAdmission: expected task_id/arm_id/cycle_id/audience/channel mismatch -> DENY", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const cases = [
      [{ task_id: "HYK-OTHER" }, REASON.TASK_ID_MISMATCH],
      [{ arm_id: "arm-other" }, REASON.ARM_ID_MISMATCH],
      [{ cycle_id: "cycle-other" }, REASON.CYCLE_ID_MISMATCH],
      [{ audience: "OTHER" }, REASON.AUDIENCE_MISMATCH],
      [{ channel: "other-channel" }, REASON.CHANNEL_MISMATCH],
      // HYK-165 사이클2 REVIEW-A 반려 수리(coder-3): packet_sha256 expected축
      // -- grant는 그대로, expected만 바뀐 경우도 PACKET_HASH_MISMATCH여야
      // 한다("expected≠grant mutation" 요구사항).
      [{ packet_sha256: sha256("other-packet") }, REASON.PACKET_HASH_MISMATCH],
    ];
    for (const [override, expectedReason] of cases) {
      const result = judgePullAdmission(
        baseInput(dir, pinPath, { expected: { ...EXPECTED, ...override } }),
      );
      assert.equal(result.ok, false, JSON.stringify(override));
      assert.equal(result.reason, expectedReason, JSON.stringify(override));
    }
  });
});

test("judgePullAdmission: expected target mismatch -> DENY TARGET_MISMATCH/AGENT_INSTANCE_MISMATCH/LAUNCH_PROFILE_MISMATCH", () => {
  withTempDir((dir) => {
    const { pinPath } = writeBundle(dir);
    const cases = [
      [
        { target: { ...EXPECTED.target, handle: "other" } },
        REASON.TARGET_MISMATCH,
      ],
      [
        { target: { ...EXPECTED.target, fingerprint: "other" } },
        REASON.TARGET_MISMATCH,
      ],
      [
        { target: { ...EXPECTED.target, agent_instance: "other" } },
        REASON.AGENT_INSTANCE_MISMATCH,
      ],
      [
        {
          target: {
            ...EXPECTED.target,
            launch_profile_sha256: sha256("other"),
          },
        },
        REASON.LAUNCH_PROFILE_MISMATCH,
      ],
    ];
    for (const [override, expectedReason] of cases) {
      const result = judgePullAdmission(
        baseInput(dir, pinPath, { expected: { ...EXPECTED, ...override } }),
      );
      assert.equal(result.ok, false, JSON.stringify(override));
      assert.equal(result.reason, expectedReason, JSON.stringify(override));
    }
  });
});

test("judgePullAdmission: never throws on malformed input", () => {
  for (const bad of [null, undefined, {}, "not-an-object", 42]) {
    assert.doesNotThrow(() => {
      const result = judgePullAdmission(bad);
      assert.equal(result.ok, false);
    });
  }
});
