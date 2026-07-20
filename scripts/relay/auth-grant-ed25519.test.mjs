import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair, sign, verify } from "./auth-grant-ed25519.mjs";

// M1(비타협): 이 파일이 만드는 키쌍은 테스트 시점에 생성되는 임시(ephemeral)
// Ed25519 키쌍뿐이다 -- 실 개인키·실 자격 경로를 절대 참조하지 않는다.
function keypair() {
  return generateEd25519KeyPair();
}

test("sign/verify: round-trip with the matching public key verifies", () => {
  const { privateKey, publicKey } = keypair();
  const data = Buffer.from("synthetic canonical payload", "utf8");
  const sig = sign(data, privateKey);
  assert.equal(verify(data, sig, publicKey), true);
});

test("verify: fails (does not throw) when signed with a different private key", () => {
  // 죽이는 변이: verify()가 canonicalBytes만 보고 서명자를 확인하지 않는다면
  // (예: 항상 true를 반환하는 스텁으로 퇴화) 이 테스트가 실패한다.
  const signer = keypair();
  const other = keypair();
  const data = Buffer.from("synthetic canonical payload", "utf8");
  const sig = sign(data, signer.privateKey);
  assert.equal(verify(data, sig, other.publicKey), false);
});

test("verify: fails when the signed bytes are tampered after signing", () => {
  const { privateKey, publicKey } = keypair();
  const data = Buffer.from("synthetic canonical payload", "utf8");
  const sig = sign(data, privateKey);
  const tampered = Buffer.from("synthetic canonical PAYLOAD", "utf8");
  assert.equal(verify(tampered, sig, publicKey), false);
});

test("verify: fails-closed (no throw) on malformed signature buffer", () => {
  const { publicKey } = keypair();
  const data = Buffer.from("x", "utf8");
  assert.doesNotThrow(() => {
    assert.equal(verify(data, Buffer.alloc(0), publicKey), false);
    assert.equal(
      verify(data, Buffer.from("not-a-real-signature"), publicKey),
      false,
    );
  });
});

test("verify: fails-closed (no throw) on malformed public key", () => {
  const { privateKey, publicKey } = keypair();
  const data = Buffer.from("x", "utf8");
  const sig = sign(data, privateKey);
  assert.doesNotThrow(() => {
    assert.equal(verify(data, sig, "not-a-key"), false);
    assert.equal(verify(data, sig, null), false);
  });
  // sanity: 진짜 키로는 여전히 통과(위 malformed 검사가 verify 자체를 깨지 않았는지 확인)
  assert.equal(verify(data, sig, publicKey), true);
});

test("verify: fails-closed on non-Buffer canonicalBytes input", () => {
  const { privateKey, publicKey } = keypair();
  const sig = sign(Buffer.from("x"), privateKey);
  assert.equal(verify("x", sig, publicKey), false);
  assert.equal(verify(null, sig, publicKey), false);
});

test("sign: rejects non-Buffer canonicalBytes", () => {
  const { privateKey } = keypair();
  assert.throws(() => sign("not-a-buffer", privateKey), TypeError);
});
