import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { verifyAuthGrant, REASON } from "./auth-grant-gate.mjs";
import { canonicalizeGrant } from "./auth-grant-canonical.mjs";
import { sign } from "./auth-grant-ed25519.mjs";

// M1(비타협): 이 파일의 모든 키쌍·grant·pin manifest는 테스트 시점에 생성되는
// 합성(synthetic) fixture다 -- 실 개인키·실 배포 pin·실 자격 경로를 전혀
// 참조하지 않는다. 전부 mkdtempSync 임시 디렉터리 안에서만 만들고 지운다
// (coder-7/8 반려 교훈: 자기 생성 자격으로 자기대조 금지 -- 여기서의 "자기대조"는
// 게이트 자체 코드가 아니라 이 fixture가 실 발사/게이트 경로 배선에 흘러들지
// 않는다는 뜻이며, 그 배선은 이 사이클 범위 밖이라 아예 존재하지 않는다).

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-grant-gate-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_FIELDS = Object.freeze({
  schema_version: 1,
  policy_version: 1,
  packet_sha256: sha256("synthetic-packet"),
  addendum_sha256: sha256("synthetic-addendum"),
  authorization_sha256: sha256("synthetic-authorization"),
  task_sha256: sha256("synthetic-task"),
  task_id: "HYK-999-coder-1",
  target: Object.freeze({
    handle: "test-terminal",
    fingerprint: "test-fingerprint",
    agent_instance: "test-agent-instance",
  }),
  audience: "CODER",
  channel: "orca-dispatch",
  arm_id: "arm-test-1",
  cycle_id: "cycle-test-1",
  expires_at: "2026-07-20T23:59:00.000Z",
  budget: Object.freeze({ max_starts_total: 1 }),
  jti: "jti-test-1",
});

const IN_WINDOW_NOW = Date.parse("2026-07-20T12:00:00.000Z");

// 사이클2 (pm-2 §3.5): expected.pinned_key_fingerprint가 필수화됐으므로, 대부분의
// 테스트가 공유하는 "good" key는 모듈 로드 시점(=테스트 시점)에 한 번 생성하는
// 임시 키쌍으로 고정한다(M1 -- 실 배포키 아님). 이 지문을 EXPECTED에 실어
// goodFixture()가 만드는 pin manifest와 항상 정합시킨다.
const GOOD_SIGNER = generateKeyPairSync("ed25519");
const GOOD_SIGNER_FINGERPRINT = sha256(pem(GOOD_SIGNER.publicKey, "public"));

const EXPECTED = Object.freeze({
  schema_version: 1,
  policy_version: 1,
  task_id: GOOD_FIELDS.task_id,
  arm_id: GOOD_FIELDS.arm_id,
  cycle_id: GOOD_FIELDS.cycle_id,
  target: Object.freeze({
    handle: GOOD_FIELDS.target.handle,
    fingerprint: GOOD_FIELDS.target.fingerprint,
    agent_instance: GOOD_FIELDS.target.agent_instance,
  }),
  audience: GOOD_FIELDS.audience,
  channel: GOOD_FIELDS.channel,
  pinned_key_fingerprint: GOOD_SIGNER_FINGERPRINT,
});

function writePin(dir, entries) {
  const pinPath = join(dir, "pin.json");
  writeFileSync(pinPath, JSON.stringify({ trusted_keys: entries }), "utf8");
  return pinPath;
}

function signedEnvelope(fields, signerPrivateKey, keyId) {
  const canon = canonicalizeGrant(fields);
  assert.equal(
    canon.ok,
    true,
    `fixture canonicalizeGrant failed: ${canon.reason}`,
  );
  const sig = sign(canon.canonicalBytes, signerPrivateKey);
  return {
    grantRaw: { ...fields, key_id: keyId },
    signature: sig.toString("base64"),
  };
}

// 표준 known-good fixture: 공유 GOOD_SIGNER를 pin에 유일 active 키로 등록해
// EXPECTED.pinned_key_fingerprint와 항상 정합하는 상태를 만든다.
function goodFixture(dir, fieldOverrides = {}) {
  const pinPath = writePin(dir, [
    {
      key_id: "k-good",
      public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
      status: "active",
    },
  ]);
  const fields = { ...GOOD_FIELDS, ...fieldOverrides };
  const env = signedEnvelope(fields, GOOD_SIGNER.privateKey, "k-good");
  return { pinPath, signer: GOOD_SIGNER, ...env };
}

test("verifyAuthGrant: known-good grant -> ALLOW", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: EXPECTED,
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, REASON.ALLOW);
  });
});

test("verifyAuthGrant: signature made with a different (wrong) key -> DENY SIGNATURE_INVALID", () => {
  withTempDir((dir) => {
    const genuineSigner = generateKeyPairSync("ed25519");
    const wrongSigner = generateKeyPairSync("ed25519");
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(genuineSigner.publicKey, "public"),
        status: "active",
      },
    ]);
    // 공격자가 k-good을 자처하지만 실제로는 다른(등록되지 않은) 개인키로 서명.
    const env = signedEnvelope(GOOD_FIELDS, wrongSigner.privateKey, "k-good");
    const result = verifyAuthGrant({
      ...env,
      pinnedPublicKeyPath: pinPath,
      // pin manifest에 실제 등록된 키(genuineSigner)의 지문을 앵커로 써야
      // PINNED_FINGERPRINT 단계를 통과하고 서명 검증까지 도달한다 -- 이 테스트의
      // 목적은 신호 자체(SIGNATURE_INVALID)이지 앵커 불일치가 아니다.
      expected: {
        ...EXPECTED,
        pinned_key_fingerprint: sha256(pem(genuineSigner.publicKey, "public")),
      },
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.SIGNATURE_INVALID);
  });
});

test("verifyAuthGrant: key_id not present in pin manifest -> DENY KEY_UNKNOWN", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const result = verifyAuthGrant({
      grantRaw: { ...grantRaw, key_id: "k-does-not-exist" },
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: EXPECTED,
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.KEY_UNKNOWN);
  });
});

test("verifyAuthGrant: key_id resolves to a revoked key -> DENY KEY_REVOKED", () => {
  withTempDir((dir) => {
    const signer = generateKeyPairSync("ed25519");
    const pinPath = writePin(dir, [
      {
        key_id: "k-revoked",
        public_key_pem: pem(signer.publicKey, "public"),
        status: "revoked",
      },
    ]);
    const env = signedEnvelope(GOOD_FIELDS, signer.privateKey, "k-revoked");
    const result = verifyAuthGrant({
      ...env,
      pinnedPublicKeyPath: pinPath,
      expected: EXPECTED,
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.KEY_REVOKED);
  });
});

test("verifyAuthGrant: pin manifest key swapped for different material under same key_id -> DENY PIN_MISMATCH", () => {
  withTempDir((dir) => {
    // "진짜" 앵커 지문(예: 런처 설정에 하드코딩된 값)은 genuineSigner의 것인데,
    // 누군가 workspace의 pin.json 파일 자체를 다른 키(attacker)로 바꿔치기한
    // 시나리오. attacker는 자기 개인키로 서명하므로 서명 검증 자체는 통과하지만,
    // "pin 자체가 바뀌었다"는 사실은 서명 검증만으로는 못 잡는다 -- 별도 앵커
    // 비교(PIN_MISMATCH)가 이걸 잡는다.
    const genuineSigner = generateKeyPairSync("ed25519");
    const attackerSigner = generateKeyPairSync("ed25519");
    const genuineFingerprint = sha256(pem(genuineSigner.publicKey, "public"));
    const pinPath = writePin(dir, [
      {
        key_id: "k-good",
        public_key_pem: pem(attackerSigner.publicKey, "public"),
        status: "active",
      },
    ]);
    const env = signedEnvelope(
      GOOD_FIELDS,
      attackerSigner.privateKey,
      "k-good",
    );
    const result = verifyAuthGrant({
      ...env,
      pinnedPublicKeyPath: pinPath,
      expected: { ...EXPECTED, pinned_key_fingerprint: genuineFingerprint },
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PIN_MISMATCH);
  });
});

test("verifyAuthGrant: signature missing/empty -> DENY SIGNATURE_MISSING", () => {
  withTempDir((dir) => {
    const { grantRaw, pinPath } = goodFixture(dir);
    for (const signature of [undefined, null, "", "   "]) {
      const result = verifyAuthGrant({
        grantRaw,
        signature,
        pinnedPublicKeyPath: pinPath,
        expected: EXPECTED,
        nowMs: IN_WINDOW_NOW,
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.reason,
        REASON.SIGNATURE_MISSING,
        `signature=${JSON.stringify(signature)}`,
      );
    }
  });
});

test("verifyAuthGrant: nowMs past expires_at -> DENY EXPIRED", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const afterExpiry = Date.parse(GOOD_FIELDS.expires_at) + 1;
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: EXPECTED,
      nowMs: afterExpiry,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.EXPIRED);
  });
});

test("verifyAuthGrant: schema_version mismatch vs expected -> DENY SCHEMA_VERSION_MISMATCH", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: { ...EXPECTED, schema_version: 999 },
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.SCHEMA_VERSION_MISMATCH);
  });
});

test("verifyAuthGrant: policy_version mismatch vs expected -> DENY POLICY_VERSION_MISMATCH", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: { ...EXPECTED, policy_version: 999 },
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.POLICY_VERSION_MISMATCH);
  });
});

test("verifyAuthGrant: expected task_id/arm_id/cycle_id/target/audience/channel mismatch -> DENY (replay-into-wrong-context)", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const cases = [
      [{ task_id: "HYK-OTHER" }, REASON.TASK_ID_MISMATCH],
      [{ arm_id: "arm-other" }, REASON.ARM_ID_MISMATCH],
      [{ cycle_id: "cycle-other" }, REASON.CYCLE_ID_MISMATCH],
      [
        {
          target: {
            handle: "other-terminal",
            fingerprint: EXPECTED.target.fingerprint,
            agent_instance: EXPECTED.target.agent_instance,
          },
        },
        REASON.TARGET_MISMATCH,
      ],
      [
        {
          target: {
            handle: EXPECTED.target.handle,
            fingerprint: EXPECTED.target.fingerprint,
            agent_instance: "other-agent-instance",
          },
        },
        REASON.AGENT_INSTANCE_MISMATCH,
      ],
      [
        {
          target: {
            handle: EXPECTED.target.handle,
            fingerprint: EXPECTED.target.fingerprint,
          },
        },
        REASON.AGENT_INSTANCE_MISMATCH,
      ],
      [{ audience: "OTHER" }, REASON.AUDIENCE_MISMATCH],
      [{ channel: "other-channel" }, REASON.CHANNEL_MISMATCH],
    ];
    for (const [override, expectedReason] of cases) {
      const result = verifyAuthGrant({
        grantRaw,
        signature,
        pinnedPublicKeyPath: pinPath,
        expected: { ...EXPECTED, ...override },
        nowMs: IN_WINDOW_NOW,
      });
      assert.equal(result.ok, false, JSON.stringify(override));
      assert.equal(result.reason, expectedReason, JSON.stringify(override));
    }
  });
});

// [G2 canonical 각 필드 단일 변조 전건 DENY] -- 서명 이후 grant의 필드 하나만
// 바꿔서(서명은 원본 그대로) 게이트에 넣는다. 죽이는 변이: canonicalizeGrant나
// canonicalStringify가 이 필드를 signed 바이트에서 빠뜨리면(예: 리팩터링 실수로
// 필드 하나를 canonical 객체 구성에서 누락) 서명이 여전히 유효하다고 오판(ALLOW)
// -- 이 테스트가 그 회귀를 잡는다. schema_version/policy_version은 canonical
// 결속 외에 expected 비교로도 독립적으로 걸리고, budget은 canonicalizeGrant
// 구조 검증 단계에서 먼저 걸린다(둘 다 DENY이므로 계약 위반 아님, reason만 다름).
const FIELD_MUTATIONS = [
  [
    "schema_version",
    (f) => ({ ...f, schema_version: 2 }),
    REASON.SCHEMA_VERSION_MISMATCH,
  ],
  [
    "policy_version",
    (f) => ({ ...f, policy_version: 2 }),
    REASON.POLICY_VERSION_MISMATCH,
  ],
  [
    "packet_sha256",
    (f) => ({ ...f, packet_sha256: sha256("mutated-packet") }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "addendum_sha256",
    (f) => ({ ...f, addendum_sha256: sha256("mutated-addendum") }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "authorization_sha256",
    (f) => ({ ...f, authorization_sha256: sha256("mutated-authorization") }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "task_sha256",
    (f) => ({ ...f, task_sha256: sha256("mutated-task") }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "task_id",
    (f) => ({ ...f, task_id: "HYK-999-coder-1-mutated" }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "target.handle",
    (f) => ({ ...f, target: { ...f.target, handle: "mutated-terminal" } }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "target.fingerprint",
    (f) => ({
      ...f,
      target: { ...f.target, fingerprint: "mutated-fingerprint" },
    }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "target.agent_instance",
    (f) => ({ ...f, target: { ...f.target, agent_instance: "mutated-agent" } }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "audience",
    (f) => ({ ...f, audience: "MUTATED" }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "channel",
    (f) => ({ ...f, channel: "mutated-channel" }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "arm_id",
    (f) => ({ ...f, arm_id: "arm-mutated" }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "cycle_id",
    (f) => ({ ...f, cycle_id: "cycle-mutated" }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "expires_at",
    (f) => ({ ...f, expires_at: "2026-07-21T00:00:00.000Z" }),
    REASON.SIGNATURE_INVALID,
  ],
  [
    "budget.max_starts_total",
    (f) => ({ ...f, budget: { max_starts_total: 2 } }),
    REASON.CANONICAL_INVALID,
  ],
  ["jti", (f) => ({ ...f, jti: "jti-mutated" }), REASON.SIGNATURE_INVALID],
];

for (const [label, mutate, expectedReason] of FIELD_MUTATIONS) {
  test(`verifyAuthGrant: canonical field '${label}' tampered post-signing -> DENY ${expectedReason}`, () => {
    withTempDir((dir) => {
      const pinPath = writePin(dir, [
        {
          key_id: "k-good",
          public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
          status: "active",
        },
      ]);
      const env = signedEnvelope(GOOD_FIELDS, GOOD_SIGNER.privateKey, "k-good");
      const tamperedGrantRaw = mutate(env.grantRaw);
      const result = verifyAuthGrant({
        grantRaw: tamperedGrantRaw,
        signature: env.signature,
        pinnedPublicKeyPath: pinPath,
        expected: EXPECTED,
        nowMs: IN_WINDOW_NOW,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, expectedReason);
    });
  });
}

test("verifyAuthGrant: expected.pinned_key_fingerprint missing -> DENY PINNED_FINGERPRINT_REQUIRED (no TOFU on workspace manifest)", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const { pinned_key_fingerprint, ...expectedWithoutAnchor } = EXPECTED;
    void pinned_key_fingerprint;
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: expectedWithoutAnchor,
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PINNED_FINGERPRINT_REQUIRED);
  });
});

test("verifyAuthGrant: expected.pinned_key_fingerprint empty string -> DENY PINNED_FINGERPRINT_REQUIRED", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: { ...EXPECTED, pinned_key_fingerprint: "" },
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PINNED_FINGERPRINT_REQUIRED);
  });
});

test("verifyAuthGrant: grantRaw.key_id missing -> DENY KEY_ID_MISSING", () => {
  withTempDir((dir) => {
    const { grantRaw, signature, pinPath } = goodFixture(dir);
    const withoutKeyId = { ...grantRaw };
    delete withoutKeyId.key_id;
    const result = verifyAuthGrant({
      grantRaw: withoutKeyId,
      signature,
      pinnedPublicKeyPath: pinPath,
      expected: EXPECTED,
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.KEY_ID_MISSING);
  });
});

test("verifyAuthGrant: pin manifest path unreadable -> DENY PIN_UNAVAILABLE (fail-closed)", () => {
  withTempDir((dir) => {
    const { grantRaw, signature } = goodFixture(dir);
    const result = verifyAuthGrant({
      grantRaw,
      signature,
      pinnedPublicKeyPath: join(dir, "does-not-exist.json"),
      expected: EXPECTED,
      nowMs: IN_WINDOW_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PIN_UNAVAILABLE);
  });
});

test("verifyAuthGrant: malformed grantRaw -> DENY CANONICAL_INVALID (never throws)", () => {
  withTempDir((dir) => {
    const { signature, pinPath } = goodFixture(dir);
    for (const bad of [null, undefined, {}, "not-an-object", 42]) {
      assert.doesNotThrow(() => {
        const result = verifyAuthGrant({
          grantRaw: bad,
          signature,
          pinnedPublicKeyPath: pinPath,
          expected: EXPECTED,
          nowMs: IN_WINDOW_NOW,
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, REASON.CANONICAL_INVALID);
      });
    }
  });
});
