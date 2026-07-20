import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { sealAuthGrant, sha256Hex } from "./auth-grant-seal.mjs";
import { verifyAuthGrant } from "./auth-grant-gate.mjs";

// M1(비타협): 이 파일은 **실 서명을 실행하지 않는다는 사이클 지침**을 지키면서도
// sealAuthGrant() 자체를 검증해야 하므로, 테스트 시점에 생성하는 임시(ephemeral)
// Ed25519 키쌍만 쓴다 -- 실 개인키·실 protected grant store·실 pin 배포는 전혀
// 참조하지 않는다. 전부 mkdtempSync 임시 디렉터리 안에서만 만들고 지운다.

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}
// sealAuthGrant는 비동기(사람 확인 readlineFn을 await)이므로, 여기서도
// fn(dir)의 Promise를 **await**해야 한다 -- 그냥 return만 하면 fn이 아직 disk
// I/O 중인데 finally의 rmSync가 먼저 실행돼 임시 디렉터리를 지워버린다
// (fn의 async 작업이 절반쯤 끝난 상태에서 경로가 사라지는 race).
async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-grant-seal-test-"));
  try {
    return await fn(dir);
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
  arm_id: "arm-seal-test-1",
  cycle_id: "cycle-seal-test-1",
  expires_at: "2026-07-20T23:59:00.000Z",
  budget: Object.freeze({ max_starts_total: 1 }),
  jti: "jti-seal-test-1",
});

function fixedReadline(answer) {
  return async () => answer;
}

test("sealAuthGrant: known-good ceremony -> ARMED envelope written, re-readable, gate accepts it", async () => {
  await withTempDir(async (dir) => {
    const keyPair = generateKeyPairSync("ed25519");
    const privateKeyPath = join(dir, "signer.key.pem");
    writeFileSync(privateKeyPath, pem(keyPair.privateKey, "private"), "utf8");
    const fingerprint = sha256(pem(keyPair.publicKey, "public"));
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });

    const result = await sealAuthGrant({
      fields: GOOD_FIELDS,
      keyId: "k-seal-1",
      privateKeyPath,
      expectedPinnedKeyFingerprint: fingerprint,
      outDir,
      deps: {
        readlineFn: fixedReadline(
          `SEAL ${GOOD_FIELDS.arm_id} ${GOOD_FIELDS.task_id} ${GOOD_FIELDS.jti}`,
        ),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(existsSync(result.envelopePath), true);
    const envelope = JSON.parse(readFileSync(result.envelopePath, "utf8"));
    assert.equal(envelope.grantRaw.key_id, "k-seal-1");
    assert.equal(typeof envelope.signature, "string");
    assert.equal(envelope.canonical_sha256, result.canonicalHash);

    // 게이트가 실제로 이 envelope을 ALLOW하는지까지 확인(세리모니 산출물이
    // 진짜로 소비 가능한지 종단 확인).
    const pinPath = join(dir, "pin.json");
    writeFileSync(
      pinPath,
      JSON.stringify({
        trusted_keys: [
          {
            key_id: "k-seal-1",
            public_key_pem: pem(keyPair.publicKey, "public"),
            status: "active",
          },
        ],
      }),
      "utf8",
    );
    const gateResult = verifyAuthGrant({
      grantRaw: envelope.grantRaw,
      signature: envelope.signature,
      pinnedPublicKeyPath: pinPath,
      expected: {
        schema_version: 1,
        policy_version: 1,
        task_id: GOOD_FIELDS.task_id,
        arm_id: GOOD_FIELDS.arm_id,
        cycle_id: GOOD_FIELDS.cycle_id,
        target: GOOD_FIELDS.target,
        audience: GOOD_FIELDS.audience,
        channel: GOOD_FIELDS.channel,
        pinned_key_fingerprint: fingerprint,
      },
      nowMs: Date.parse("2026-07-20T12:00:00.000Z"),
    });
    assert.equal(gateResult.ok, true);
  });
});

test("sealAuthGrant: missing expectedPinnedKeyFingerprint -> DENY before ever reading the private key (no TOFU)", async () => {
  await withTempDir(async (dir) => {
    let privateKeyReadAttempted = false;
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });
    const result = await sealAuthGrant({
      fields: GOOD_FIELDS,
      keyId: "k-seal-1",
      privateKeyPath: join(dir, "does-not-matter.key.pem"),
      expectedPinnedKeyFingerprint: "",
      outDir,
      deps: {
        readFileFn: (p) => {
          privateKeyReadAttempted = true;
          return readFileSync(p, "utf8");
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /expectedPinnedKeyFingerprint/);
    assert.equal(
      privateKeyReadAttempted,
      false,
      "private key must never be read when the anchor is missing",
    );
  });
});

test("sealAuthGrant: private key does not match expectedPinnedKeyFingerprint -> DENY, refuses to sign with the wrong key", async () => {
  await withTempDir(async (dir) => {
    const wrongKeyPair = generateKeyPairSync("ed25519");
    const otherKeyPair = generateKeyPairSync("ed25519");
    const privateKeyPath = join(dir, "signer.key.pem");
    writeFileSync(
      privateKeyPath,
      pem(wrongKeyPair.privateKey, "private"),
      "utf8",
    );
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });

    const result = await sealAuthGrant({
      fields: GOOD_FIELDS,
      keyId: "k-seal-1",
      privateKeyPath,
      expectedPinnedKeyFingerprint: sha256(
        pem(otherKeyPair.publicKey, "public"),
      ),
      outDir,
      deps: {
        readlineFn: fixedReadline(
          `SEAL ${GOOD_FIELDS.arm_id} ${GOOD_FIELDS.task_id} ${GOOD_FIELDS.jti}`,
        ),
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not match expectedPinnedKeyFingerprint/);
    assert.equal(
      existsSync(
        join(
          outDir,
          `signed-grant-${GOOD_FIELDS.arm_id}-${GOOD_FIELDS.jti}.json`,
        ),
      ),
      false,
    );
  });
});

test("sealAuthGrant: human confirmation mismatch -> DENY, no envelope written (no partial success)", async () => {
  await withTempDir(async (dir) => {
    const keyPair = generateKeyPairSync("ed25519");
    const privateKeyPath = join(dir, "signer.key.pem");
    writeFileSync(privateKeyPath, pem(keyPair.privateKey, "private"), "utf8");
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });

    const result = await sealAuthGrant({
      fields: GOOD_FIELDS,
      keyId: "k-seal-1",
      privateKeyPath,
      expectedPinnedKeyFingerprint: sha256(pem(keyPair.publicKey, "public")),
      outDir,
      deps: { readlineFn: fixedReadline("WRONG PHRASE") },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /confirmation mismatch/);
    assert.equal(
      existsSync(
        join(
          outDir,
          `signed-grant-${GOOD_FIELDS.arm_id}-${GOOD_FIELDS.jti}.json`,
        ),
      ),
      false,
    );
  });
});

test("sealAuthGrant: refuses to overwrite an existing sealed envelope for the same arm_id/jti", async () => {
  await withTempDir(async (dir) => {
    const keyPair = generateKeyPairSync("ed25519");
    const privateKeyPath = join(dir, "signer.key.pem");
    writeFileSync(privateKeyPath, pem(keyPair.privateKey, "private"), "utf8");
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });
    const fingerprint = sha256(pem(keyPair.publicKey, "public"));
    const args = {
      fields: GOOD_FIELDS,
      keyId: "k-seal-1",
      privateKeyPath,
      expectedPinnedKeyFingerprint: fingerprint,
      outDir,
      deps: {
        readlineFn: fixedReadline(
          `SEAL ${GOOD_FIELDS.arm_id} ${GOOD_FIELDS.task_id} ${GOOD_FIELDS.jti}`,
        ),
      },
    };
    const first = await sealAuthGrant(args);
    assert.equal(first.ok, true);
    const second = await sealAuthGrant(args);
    assert.equal(second.ok, false);
    assert.match(second.reason, /refusing to overwrite/);
  });
});

test("sealAuthGrant: invalid candidate fields (fails canonicalizeGrant) -> DENY before touching the private key", async () => {
  await withTempDir(async (dir) => {
    let privateKeyReadAttempted = false;
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });
    const result = await sealAuthGrant({
      fields: { ...GOOD_FIELDS, budget: { max_starts_total: 2 } },
      keyId: "k-seal-1",
      privateKeyPath: join(dir, "does-not-matter.key.pem"),
      expectedPinnedKeyFingerprint: "some-fingerprint",
      outDir,
      deps: {
        readFileFn: (p) => {
          privateKeyReadAttempted = true;
          return readFileSync(p, "utf8");
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /candidate grant fields invalid/);
    assert.equal(privateKeyReadAttempted, false);
  });
});

test("sealAuthGrant: result object never contains the private key material or raw signature bytes as a Buffer", async () => {
  await withTempDir(async (dir) => {
    const keyPair = generateKeyPairSync("ed25519");
    const privateKeyPath = join(dir, "signer.key.pem");
    const privatePem = pem(keyPair.privateKey, "private");
    writeFileSync(privateKeyPath, privatePem, "utf8");
    const outDir = join(dir, "protected-store");
    mkdirSync(outDir, { recursive: true });

    const result = await sealAuthGrant({
      fields: GOOD_FIELDS,
      keyId: "k-seal-1",
      privateKeyPath,
      expectedPinnedKeyFingerprint: sha256(pem(keyPair.publicKey, "public")),
      outDir,
      deps: {
        readlineFn: fixedReadline(
          `SEAL ${GOOD_FIELDS.arm_id} ${GOOD_FIELDS.task_id} ${GOOD_FIELDS.jti}`,
        ),
      },
    });
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(privatePem), false);
    assert.equal(serialized.includes("PRIVATE KEY"), false);
  });
});

test("sha256Hex: rejects non-string input", () => {
  assert.throws(() => sha256Hex(42), TypeError);
});

test("G3 static scan: auth-grant-seal.mjs never logs the private key PEM or raw signature to stdout on the success path", () => {
  const src = readFileSync(
    new URL("./auth-grant-seal.mjs", import.meta.url),
    "utf8",
  );
  // 성공 경로의 console.log(...) 호출 인자 블록 전체(prettier가 여러 줄로
  // 감쌀 수 있으므로 괄호 균형을 맞춰 블록 단위로 추출)에 privateKey/signature
  // 변수가 들어가지 않는지 확인.
  const callStart = src.indexOf("console.log(");
  assert.ok(callStart >= 0, "expected to find a console.log( call");
  let depth = 0;
  let end = callStart;
  for (let i = callStart + "console.log".length; i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const successLogBlock = src.slice(callStart, end);
  assert.match(successLogBlock, /ok: true/);
  assert.doesNotMatch(successLogBlock, /privateKey/i);
  assert.doesNotMatch(successLogBlock, /\bsignature\b/i);
});

// self-verify 실패 반사실: ed25519Verify가 항상 서명을 통과시키게 만들면(예:
// 리팩터링 실수로 selfVerified 검사를 빼먹으면) 이 테스트가 검증하는 "서명
// 직후 자기검증"이 죽은 코드가 된다 -- 소스에 그 호출이 실제로 있는지 고정.
test("G3 static scan: sealAuthGrant self-verifies the freshly-produced signature before writing (mutation-kill anchor)", () => {
  const src = readFileSync(
    new URL("./auth-grant-seal.mjs", import.meta.url),
    "utf8",
  );
  // prettier가 인자를 여러 줄로 감쌀 수 있으므로 공백/개행을 제거한 뒤 검사.
  const collapsed = src.replace(/\s+/g, " ");
  assert.match(
    collapsed,
    /ed25519Verify\(\s*canon\.canonicalBytes,\s*signature,\s*keyCheck\.publicKeyPem,?\s*\)/,
  );
});
