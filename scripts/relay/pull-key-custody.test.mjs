import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// HYK-165 사이클 1 [P2 정적 검사]: pull 채널 산출 코드(비-test)에 개인키/
// 대칭 secret/bearer nonce 문자열이 리터럴로 박혀 있지 않은지 확인한다 --
// auth-grant-secrets-scan.test.mjs(HYK-163 G3)와 동일 원칙을 이번에 새로
// 만든 pull-*.mjs 3파일로 확장한다(재발명이 아니라 그 검사망을 새 파일에
// 적용). 게이트 경로(pull-admission.mjs)는 공개키만 인자로 받는
// auth-grant-ed25519.verify()를 그대로 재사용하므로, 개인키가 이 경로로
// 흘러들 수 있는 타입상 지점이 원천적으로 없다 -- 이 테스트는 "그 계약을
// 어기는 리터럴이 소스에 붙는" 회귀를 잡는다.

const SOURCE_FILES = [
  "./pull-grant-canonical.mjs",
  "./pull-authorization.mjs",
  "./pull-admission.mjs",
];

function readSource(relPath) {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

const PRIVATE_KEY_PEM_RE =
  /-----BEGIN (?:EC |RSA |ENCRYPTED )?PRIVATE KEY-----/;
const BEARER_LITERAL_RE = /["']Bearer\s+[A-Za-z0-9._~+/=-]{8,}["']/;
const HARDCODED_SECRET_ASSIGNMENT_RE =
  /\b(secret|nonce|bearer[_-]?token|api[_-]?key|private[_-]?key)\s*[:=]\s*["'][^"']{6,}["']/i;

for (const file of SOURCE_FILES) {
  test(`P2 static scan: '${file}' has no literal private-key PEM block`, () => {
    const src = readSource(file);
    assert.equal(
      PRIVATE_KEY_PEM_RE.test(src),
      false,
      `${file} contains a literal PRIVATE KEY PEM block`,
    );
  });

  test(`P2 static scan: '${file}' has no hardcoded bearer-token literal`, () => {
    const src = readSource(file);
    assert.equal(
      BEARER_LITERAL_RE.test(src),
      false,
      `${file} contains a literal 'Bearer <token>' string`,
    );
  });

  test(`P2 static scan: '${file}' has no hardcoded secret/nonce/api-key/private-key assignment`, () => {
    const src = readSource(file);
    assert.equal(
      HARDCODED_SECRET_ASSIGNMENT_RE.test(src),
      false,
      `${file} contains a hardcoded secret-like literal assignment`,
    );
  });

  test(`P2 static scan: '${file}' never imports node:crypto's createPrivateKey/generateKeyPairSync (no key-generation authority in the gate path)`, () => {
    const src = readSource(file);
    assert.doesNotMatch(
      src,
      /createPrivateKey|generateKeyPairSync|createSecretKey/,
      `${file} imports/uses a private-key-producing crypto primitive -- key custody must stay in auth-grant-seal.mjs only`,
    );
  });
}

test("P2 static scan: pull-admission.mjs's verify call path never types a privateKey parameter anywhere in its own function signatures", () => {
  const src = readSource("./pull-admission.mjs");
  const fnSignatures = [...src.matchAll(/function\s+\w+\(([^)]*)\)/g)];
  assert.ok(
    fnSignatures.length > 0,
    "could not locate any function signatures",
  );
  for (const [, params] of fnSignatures) {
    assert.doesNotMatch(
      params,
      /privateKey/i,
      `a function signature in pull-admission.mjs takes a privateKey parameter: (${params})`,
    );
  }
});

test("P2 static scan: pull-admission.mjs imports verify (not sign) from auth-grant-ed25519.mjs", () => {
  const src = readSource("./pull-admission.mjs");
  assert.match(
    src,
    /import\s*{\s*verify as ed25519Verify\s*}\s*from\s*"\.\/auth-grant-ed25519\.mjs"/,
  );
  assert.doesNotMatch(
    src,
    /import\s*{[^}]*\bsign\b[^}]*}\s*from\s*"\.\/auth-grant-ed25519\.mjs"/,
    "pull-admission.mjs must not import the signing function -- it only verifies",
  );
});
