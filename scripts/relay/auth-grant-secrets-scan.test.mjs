import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// HYK-163 사이클 1 [G3 정적 검사]: 산출 코드(비-test)에 개인키/대칭 secret/
// bearer nonce 문자열이 리터럴로 박혀 있지 않은지 확인한다. 이 사이클이
// 만드는 모듈은 개인키를 워크스페이스에 들고 있으면 안 된다(패킷 §4) --
// 게이트 경로는 verify()가 공개키만 받는 타입 계약으로 이미 개인키를 배제
// 하지만, 이 테스트는 "그 계약을 어기는 리터럴이 소스에 붙는" 회귀를 잡는다.
//
// 죽이는 변이: 누군가 이 파일들 중 하나에 실 PEM 개인키 블록이나 하드코딩된
// bearer 토큰/대칭 비밀 문자열을 상수로 붙여넣으면 이 테스트가 즉시 실패한다.
// (테스트 파일 자체는 검사 대상에서 뺀다 -- ed25519 테스트가 임시 키쌍을
// `generateKeyPairSync`로 그 자리에서 만드는 것은 정당하고, "리터럴로 박힌
// 상수"가 아니다.)

const SOURCE_FILES = [
  "./auth-grant-canonical.mjs",
  "./auth-grant-ed25519.mjs",
  "./auth-grant-pin.mjs",
  "./auth-grant-gate.mjs",
];

function readSource(relPath) {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

const PRIVATE_KEY_PEM_RE =
  /-----BEGIN (?:EC |RSA |ENCRYPTED )?PRIVATE KEY-----/;
const BEARER_LITERAL_RE = /["']Bearer\s+[A-Za-z0-9._~+/=-]{8,}["']/;
const HARDCODED_SECRET_ASSIGNMENT_RE =
  /\b(secret|nonce|bearer[_-]?token|api[_-]?key)\s*[:=]\s*["'][^"']{6,}["']/i;

for (const file of SOURCE_FILES) {
  test(`G3 static scan: '${file}' has no literal private-key PEM block`, () => {
    const src = readSource(file);
    assert.equal(
      PRIVATE_KEY_PEM_RE.test(src),
      false,
      `${file} contains a literal PRIVATE KEY PEM block`,
    );
  });

  test(`G3 static scan: '${file}' has no hardcoded bearer-token literal`, () => {
    const src = readSource(file);
    assert.equal(
      BEARER_LITERAL_RE.test(src),
      false,
      `${file} contains a literal 'Bearer <token>' string`,
    );
  });

  test(`G3 static scan: '${file}' has no hardcoded secret/nonce/api-key assignment`, () => {
    const src = readSource(file);
    assert.equal(
      HARDCODED_SECRET_ASSIGNMENT_RE.test(src),
      false,
      `${file} contains a hardcoded secret-like literal assignment`,
    );
  });
}

test("G3 static scan: auth-grant-ed25519.mjs's verify() signature never types a privateKey parameter", () => {
  // 계약 확인(문서화 목적 회귀 방지): 게이트 경로 verify()는 공개키만 받는다는
  // 설계를 함수 시그니처 문자열 검사로 고정한다 -- 누군가 verify(data, sig,
  // publicKey, privateKey) 식으로 개인키 인자를 추가하면 이 테스트가 잡는다.
  const src = readSource("./auth-grant-ed25519.mjs");
  const verifyFnMatch = src.match(/export function verify\(([^)]*)\)/);
  assert.ok(verifyFnMatch, "could not locate verify() function signature");
  assert.doesNotMatch(verifyFnMatch[1], /privateKey/i);
});
