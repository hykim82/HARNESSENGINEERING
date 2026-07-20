import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  loadPinnedPublicKeys,
  findKeyById,
  sha256Pem,
} from "./auth-grant-pin.mjs";

// M1: 이 파일의 키쌍은 전부 테스트 시점에 생성되는 임시 Ed25519 키쌍이다 --
// 실 배포 pin·실 개인키를 절대 참조하지 않는다. fixture는 mkdtempSync로 만든
// 테스트 전용 임시 디렉터리 안에서만 쓰고 지운다(라이브 경로와 완전 격리).
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "auth-grant-pin-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ephemeralPublicPem() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}
function ephemeralPrivatePem() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

test("loadPinnedPublicKeys: loads a well-formed manifest with active + revoked entries", () => {
  withTempDir((dir) => {
    const pinPath = join(dir, "pin.json");
    const pem1 = ephemeralPublicPem();
    const pem2 = ephemeralPublicPem();
    writeFileSync(
      pinPath,
      JSON.stringify({
        trusted_keys: [
          { key_id: "k1", public_key_pem: pem1, status: "active" },
          { key_id: "k2", public_key_pem: pem2, status: "revoked" },
        ],
      }),
      "utf8",
    );
    const result = loadPinnedPublicKeys(pinPath);
    assert.equal(result.ok, true);
    assert.equal(result.keys.length, 2);
    const k1 = findKeyById(result.keys, "k1");
    const k2 = findKeyById(result.keys, "k2");
    assert.equal(k1.status, "active");
    assert.equal(k2.status, "revoked");
    assert.equal(k1.fingerprint, sha256Pem(pem1));
  });
});

test("loadPinnedPublicKeys: refuses a manifest missing 'trusted_keys'", () => {
  withTempDir((dir) => {
    const pinPath = join(dir, "pin.json");
    writeFileSync(pinPath, JSON.stringify({ not_the_right_field: [] }), "utf8");
    const result = loadPinnedPublicKeys(pinPath);
    assert.equal(result.ok, false);
    assert.match(result.reason, /trusted_keys/);
  });
});

test("loadPinnedPublicKeys: refuses invalid JSON", () => {
  withTempDir((dir) => {
    const pinPath = join(dir, "pin.json");
    writeFileSync(pinPath, "{not json", "utf8");
    const result = loadPinnedPublicKeys(pinPath);
    assert.equal(result.ok, false);
    assert.match(result.reason, /JSON/);
  });
});

test("loadPinnedPublicKeys: refuses unreadable path", () => {
  const result = loadPinnedPublicKeys(
    join(tmpdir(), "does-not-exist-pin.json"),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot read/);
});

test("loadPinnedPublicKeys: refuses an entry missing key_id/public_key_pem", () => {
  withTempDir((dir) => {
    const pinPath = join(dir, "pin.json");
    writeFileSync(
      pinPath,
      JSON.stringify({ trusted_keys: [{ key_id: "k1" }] }),
      "utf8",
    );
    const result = loadPinnedPublicKeys(pinPath);
    assert.equal(result.ok, false);
    assert.match(result.reason, /malformed/);
  });
});

// [G3 static check] G3 요구: 개인키/대칭 secret이 산출 코드·fixture로 흘러들면
// 로더 자체가 거부해야 한다 -- workspace(.harness/ 포함)엔 공개 자료만 허용.
test("loadPinnedPublicKeys: refuses an entry whose 'public_key_pem' is actually a PRIVATE key (G3)", () => {
  withTempDir((dir) => {
    const pinPath = join(dir, "pin.json");
    const privatePem = ephemeralPrivatePem();
    writeFileSync(
      pinPath,
      JSON.stringify({
        trusted_keys: [
          { key_id: "k1", public_key_pem: privatePem, status: "active" },
        ],
      }),
      "utf8",
    );
    const result = loadPinnedPublicKeys(pinPath);
    assert.equal(result.ok, false);
    assert.match(result.reason, /PRIVATE KEY/);
  });
});

test("findKeyById: returns null for unknown id / empty list", () => {
  assert.equal(findKeyById([], "k1"), null);
  assert.equal(findKeyById(null, "k1"), null);
  assert.equal(findKeyById([{ key_id: "k1" }], "k2"), null);
});
