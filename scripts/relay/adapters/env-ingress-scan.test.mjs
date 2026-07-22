import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanEnvHandleIngress,
  stripJsComments,
  KNOWN_LIMITATIONS,
} from "./env-ingress-scan.mjs";

// HYK-170 사이클2 coder-1 (A-3): 스캐너 자체의 단위 시험 -- 태스크 지시
// (§4) known-bad 6종을 개별로 BLOCK하고, G8 사유 주석·문서 mention은 PASS
// 시킨다. 문자열 검색 단독으로 되돌아가지 않도록, 실행 가능한 코드 경로만
// 걸리는지(주석/문자열 컨텍스트가 아니라) 매 케이스마다 확인한다.

test("scanEnvHandleIngress: BLOCK -- process.env dot access", () => {
  const v = scanEnvHandleIngress(`const h = process.env.ORCA_TERMINAL_HANDLE;`);
  assert.ok(v.some((x) => x.pattern === "ENV_DOT_ACCESS"));
});

test("scanEnvHandleIngress: BLOCK -- process['env'] bracket access", () => {
  const v = scanEnvHandleIngress(
    `const e = process["env"]; const h = e.ORCA_TERMINAL_HANDLE;`,
  );
  assert.ok(v.some((x) => x.pattern === "ENV_BRACKET_ACCESS"));
});

test("scanEnvHandleIngress: BLOCK -- destructure { env } = process", () => {
  const v = scanEnvHandleIngress(
    `const { env } = process; const h = env.ORCA_TERMINAL_HANDLE;`,
  );
  assert.ok(v.some((x) => x.pattern === "ENV_DESTRUCTURE"));
});

test("scanEnvHandleIngress: BLOCK -- destructure alias { ORCA_TERMINAL_HANDLE } = process.env", () => {
  const v = scanEnvHandleIngress(
    `const { ORCA_TERMINAL_HANDLE } = process.env;`,
  );
  assert.ok(v.some((x) => x.pattern === "ENV_DESTRUCTURE_FROM_ENV"));
});

test("scanEnvHandleIngress: BLOCK -- computed key via string literal concatenation", () => {
  const v = scanEnvHandleIngress(
    `const key = "ORCA_" + "TERMINAL_HANDLE"; const h = process.env[key];`,
  );
  assert.ok(v.some((x) => x.pattern === "COMPUTED_KEY_CONCAT"));
});

test("scanEnvHandleIngress: BLOCK -- helper function imported with 'env' in its binding name", () => {
  const v = scanEnvHandleIngress(
    `import { readEnvHandle } from "./somewhere.mjs";`,
  );
  assert.ok(v.some((x) => x.pattern === "HELPER_ENV_IMPORT"));
});

test("scanEnvHandleIngress: BLOCK -- re-export from a module whose specifier mentions env", () => {
  const v = scanEnvHandleIngress(`export * from "./env-reader.mjs";`);
  assert.ok(v.some((x) => x.pattern === "REEXPORT_ENV"));
});

test("scanEnvHandleIngress: PASS -- a G8-style reason comment mentioning ORCA_TERMINAL_HANDLE and process.env is not flagged (comments are stripped first)", () => {
  const src = `
// this adapter deliberately never reads process.env.ORCA_TERMINAL_HANDLE --
// see HYK-170 §D2 for why (comment-only mention, not executable code).
export function noop() { return 1; }
`;
  assert.deepEqual(scanEnvHandleIngress(src), []);
});

test("scanEnvHandleIngress: PASS -- a block comment mentioning the same strings is also not flagged", () => {
  const src = `
/* process.env.ORCA_TERMINAL_HANDLE is intentionally never read here (G8) */
export function noop() { return 1; }
`;
  assert.deepEqual(scanEnvHandleIngress(src), []);
});

test("scanEnvHandleIngress: PASS -- clean source with no env-handle ingress at all", () => {
  assert.deepEqual(
    scanEnvHandleIngress(`export function add(a, b) { return a + b; }`),
    [],
  );
});

// 변이 죽이기(§5 요구): 스캐너를 "항상 빈 배열 반환"으로 바꾸면 위 BLOCK
// 시험들이 전부 RED가 되어야 한다 -- 그 사실 자체를 직접 실행해 확인하고
// 결과 파일에 적는다(코드 자체에는 그 변이를 남기지 않는다, 이 파일은
// 정상 구현을 시험한다).

test("stripJsComments: strips // line comments but preserves code and newlines", () => {
  const src = `const a = 1; // a comment mentioning process.env\nconst b = 2;`;
  const stripped = stripJsComments(src);
  assert.equal(stripped.includes("process.env"), false);
  assert.equal(stripped.includes("const b = 2;"), true);
});

test("stripJsComments: strips /* block */ comments across multiple lines, preserving line count", () => {
  const src = `const a = 1;\n/* process.env.X\n   more comment */\nconst b = 2;`;
  const stripped = stripJsComments(src);
  assert.equal(stripped.includes("process.env"), false);
  assert.equal(src.split("\n").length, stripped.split("\n").length);
});

test("stripJsComments: does not strip '//' or '/*' that appear inside string literals", () => {
  const src = `const url = "http://example.com"; const b = process.env.ORCA_TERMINAL_HANDLE;`;
  const stripped = stripJsComments(src);
  assert.equal(stripped.includes("http://example.com"), true);
  assert.equal(stripped.includes("process.env"), true);
});

// A-3 §5 정직 요구: 스캐너가 못 잡는 구문·범위를 코드가 스스로 출력한다.
test("KNOWN_LIMITATIONS: honestly documents at least the variable-concat and cross-file helper gaps", () => {
  assert.ok(Array.isArray(KNOWN_LIMITATIONS));
  assert.ok(KNOWN_LIMITATIONS.length > 0);
  assert.ok(KNOWN_LIMITATIONS.some((s) => /variable/i.test(s)));
  assert.ok(KNOWN_LIMITATIONS.some((s) => /helper/i.test(s)));
});
