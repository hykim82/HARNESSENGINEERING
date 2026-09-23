// HYK-280 H1(coder-task.md §H1) -- 상시 가드: `withTempDir(prefix, fn)`가
// 이 저장소 곳곳에 독립적으로 복제돼 있는데(전수 실측, 아래 참조), 그중
// «비동기 콜백과 함께 쓰이면서도» fn(dir)이 돌려준 thenable을 기다리지
// 않고 finally에서 곧바로 rmSync하는 조합(HYK-460 4R 검토 P2-2가 8파일에서
// 실제로 찾은 그 조합)은 CI에서만 드러나는 비결정적 ENOENT/미처리 거부를
// 만든다(임시 폴더가 비동기 작업이 끝나기 전에 지워지거나, 최악의 경우
// 콜백 안의 assertion 실패가 "시험 실패"가 아니라 "시험 종료 후
// unhandledRejection"으로만 잡혀 그 시험이 실질적으로 아무것도 게이트하지
// 못하게 된다 -- HYK-460 라운드7 결과 파일이 정확히 이 실패 형태를
// 기록했다).
//
// ★이 가드가 «안» 잡는 것(의도적, 다른 이슈의 코드를 지나가다 고치지
// 않는다는 원칙 -- coder-task.md §6 항5): withTempDir를 오직 동기 콜백
// 으로만 쓰는 파일. 그런 파일은 이 헬퍼가 옛(버그) 모양을 그대로 갖고
// 있어도 fn(dir)이 애초에 thenable을 돌려주지 않으므로 이 버그 자체가
// 발현하지 않는다. HYK-280 실측(2026-09-24): 이 저장소 scripts/ 아래
// *.test.mjs 전수에서 withTempDir(...) 호출에 async 콜백을 실제로 쓰는
// 파일은 정확히 9개뿐이었다(dispatch-start-confirm-cli.test.mjs ·
// unconsumed-wire.test.mjs · seat-liveness-wire.test.mjs ·
// dispatch-start-wire.test.mjs · seat-idle-wire.test.mjs ·
// scripts/relay/auth-grant-seal.test.mjs ·
// scripts/check/envelope-archive-mutation.test.mjs ·
// scripts/check/hyk241-task-archive-mutation.test.mjs ·
// scripts/check/hyk460-seat-origin-warn.test.mjs) -- 이 가드는 그 9개가
// 전부 안전 패턴임을 고정하고, 새 파일이 같은 위험한 조합(비동기 콜백 +
// 안전하지 않은 정의)을 들이면 잡는다. 동기 전용 나머지 파일들(수십
// 개)은 건드리지 않는다 -- 이 라운드 범위 밖이다.
//
// 안전 패턴 두 가지(둘 다 이 저장소에 실재한다 -- 아래 SAFE_KIND 주석):
// (A) thenable-검사형 -- fn(dir) 결과가 thenable이면 정착 뒤에만 정리하고
//     아니면 즉시 정리한다(scripts/check/hyk460-seat-origin-warn.test.mjs
//     원안, 동기 호출부가 섞여 있어도 안전).
// (B) 전수-await형 -- `async function withTempDir`가 내부에서 `await
//     fn(dir)`로 정착을 기다린다. 이 패턴은 ⛔"호출부가 반드시 매번
//     await(또는 return)해야" 안전하다(안 그러면 동기 콜백의 동기 throw가
//     미처리 프로미스 거부로 바뀌어 시험이 조용히 통과한 것처럼 보일 수
//     있다) -- 그래서 이 가드는 (B)를 고를 경우 파일 안의 모든 호출부가
//     `await`/`return`으로 그 반환값을 실제로 잇는지까지 함께 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);
// ★이 가드 자신은 스캔 대상에서 제외한다 -- 아래 대조 시험들이 합성
// 텍스트(문자열 리터럴)로 "옛(버그) 정의 + async 콜백" 모양을 그대로
// 담고 있어, 자기 자신을 스캔하면 그 문자열 리터럴을 실제 정의/호출로
// 오인한다(node-api-gap-guard.mjs가 자기 서술 문장을 call-form 매칭으로
// 피하는 것과 같은 문제 -- 여기서는 전체 파일 스킵으로 해결한다).
const SELF_PATH = fileURLToPath(import.meta.url);

function isTestFileName(name) {
  return extname(name) === ".mjs" && name.endsWith(".test.mjs");
}

// visitEntry(...) -- one directory entry's contribution to the walk
// (listTestFiles에서 분리 -- eslint complexity 상한 준수, 로직은 그대로).
function visitEntry({ dir, name, stat, stack, out }) {
  const full = join(dir, name);
  let info;
  try {
    info = stat(full);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    if (!SKIP_DIR_NAMES.has(name)) stack.push(full);
  } else if (info.isFile() && isTestFileName(name)) {
    out.push(full);
  }
}

export function listTestFiles(
  root,
  { readdir = readdirSync, stat = statSync } = {},
) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) visitEntry({ dir, name, stat, stack, out });
  }
  return out;
}

// extractFunctionBody(text, openBraceIndex) -- text[openBraceIndex] must be
// "{". Returns the substring from that "{" to its matching "}" (inclusive),
// via plain brace counting (these withTempDir bodies are simple -- no nested
// template-literal braces -- so this narrow scan is sufficient; it is not a
// general JS parser).
export function extractFunctionBody(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  return text.slice(openBraceIndex);
}

// findWithTempDirDefs(text) -> [{ isAsync, body }] -- one entry per local
// `withTempDir` function definition found in the file.
export function findWithTempDirDefs(text) {
  const defs = [];
  const re = /(async\s+)?function\s+withTempDir\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openBraceIndex = m.index + m[0].length - 1;
    const body = extractFunctionBody(text, openBraceIndex);
    defs.push({ isAsync: Boolean(m[1]), body });
  }
  return defs;
}

// hasAsyncCallbackUsage(text) -- true if some `withTempDir(...)` CALL (not
// the definition itself) in this file passes an async callback. Existence
// check only (see module header -- this is what scopes the guard to files
// where the bug can actually manifest).
export function hasAsyncCallbackUsage(text) {
  return /withTempDir\s*\([^)]*async\b/.test(text);
}

// allCallSitesAreAwaitedOrReturned(text) -- for pattern (B) safety: every
// `withTempDir(` occurrence that is NOT part of its own `function
// withTempDir(` / `async function withTempDir(` definition header must be
// immediately preceded (ignoring whitespace) by `await` or `return`.
export function allCallSitesAreAwaitedOrReturned(text) {
  const callRe = /withTempDir\s*\(/g;
  let m;
  while ((m = callRe.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    if (/(?:async\s+)?function\s*$/.test(before)) continue; // this is the definition header, not a call.
    const precedingToken = before.match(/(\bawait|\breturn)\s*$/);
    if (!precedingToken) return false;
  }
  return true;
}

// evaluateFile(text) -> { needsCheck, safe, reason }
export function evaluateFile(text) {
  if (!hasAsyncCallbackUsage(text)) {
    return {
      needsCheck: false,
      safe: true,
      reason: "동기 콜백만 사용 -- 이 버그가 발현할 수 없다(범위 밖)",
    };
  }
  const defs = findWithTempDirDefs(text);
  if (defs.length === 0) {
    return {
      needsCheck: true,
      safe: true,
      reason:
        "로컬 withTempDir 정의 없음(공유 헬퍼 등 다른 출처로 추정) -- 이 가드의 탐지 범위 밖",
    };
  }
  for (const def of defs) {
    const thenableChecked = /\.then\s*\(/.test(def.body);
    if (thenableChecked) continue; // 패턴 (A) -- 안전.
    const awaitsFnDirectly = /await\s+fn\s*\(/.test(def.body);
    if (def.isAsync && awaitsFnDirectly) {
      if (allCallSitesAreAwaitedOrReturned(text)) continue; // 패턴 (B) -- 안전.
      return {
        needsCheck: true,
        safe: false,
        reason:
          "async withTempDir(내부 await fn())인데 호출부 중 일부가 await/return 없이 호출된다 -- 동기 콜백의 동기 throw가 미처리 프로미스 거부로 새 나갈 수 있다",
      };
    }
    return {
      needsCheck: true,
      safe: false,
      reason:
        "withTempDir가 fn(dir)의 thenable을 기다리지 않고 finally에서 즉시 정리한다 -- async 콜백과 함께 쓰이면 임시 폴더가 비동기 작업 도중 지워질 수 있다(HYK-460 4R P2-2 원 결함과 동형)",
    };
  }
  return { needsCheck: true, safe: true, reason: "안전 패턴 확인됨" };
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function scanScriptsForUnsafeWithTempDir(root) {
  const scriptsDir = join(root, "scripts");
  const files = listTestFiles(scriptsDir).filter((p) => p !== SELF_PATH);
  const violations = [];
  const checkedSafe = [];
  for (const absPath of files) {
    let text;
    try {
      text = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(root, absPath).replace(/\\/g, "/");
    const evaluated = evaluateFile(text);
    if (!evaluated.needsCheck) continue;
    if (evaluated.safe) {
      checkedSafe.push(relPath);
    } else {
      violations.push({ file: relPath, reason: evaluated.reason });
    }
  }
  return { violations, checkedSafe, scanned: files.length };
}

test("with-temp-dir-thenable-guard: withTempDir + async 콜백 조합이 있는 모든 파일이 안전 패턴(thenable-검사형 또는 전수-await형)이다", () => {
  const { violations, checkedSafe, scanned } =
    scanScriptsForUnsafeWithTempDir(repoRoot());
  assert.equal(
    violations.length,
    0,
    `withTempDir + async 콜백 조합에서 안전하지 않은 정의를 찾았다:\n` +
      violations.map((v) => `  - ${v.file}: ${v.reason}`).join("\n"),
  );
  // ★HYK-280 실측 고정(위 헤더 주석) -- async 콜백과 함께 withTempDir를
  // 쓰는 파일이 정확히 9개라는 사실 자체가 값이다. 이 수가 갑자기
  // 0이 되면(예: 스캔 경로가 깨짐) 이 가드가 아무것도 검사하지 않고
  // 조용히 통과하는 거짓 GREEN이 될 수 있으므로, 최소 1개는 실제로
  // 검사했다는 것을 스스로 확인한다.
  assert.ok(
    checkedSafe.length >= 1,
    `이 가드가 실제로 검사한 파일이 0개다(스캔 경로가 깨졌을 가능성) -- scanned=${scanned}`,
  );
});

// 되돌리면 RED(coder-task.md §1 항3): 합성 텍스트로 위 옛(버그) 패턴 +
// async 콜백 조합을 직접 만들어 evaluateFile이 실제로 안전하지 않다고
// 판정하는지 고정한다 -- 저장소 실물 상태와 무관하게 이 판정 로직 자체를
// 되돌려도 잡히는지 보장한다.
test("변이 RED: 옛(버그) withTempDir 정의 + async 콜백 조합을 합성 텍스트로 주면 evaluateFile이 안전하지 않다고 판정한다", () => {
  const buggySource = `
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("x", async () => {
  await withTempDir("p-", async (dir) => {
    await doSomethingAsync(dir);
  });
});
`;
  const result = evaluateFile(buggySource);
  assert.equal(result.needsCheck, true);
  assert.equal(result.safe, false);
});

test("대조: thenable-검사형(패턴 A)은 안전으로 판정된다", () => {
  const safeSourceA = `
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => { cleanup(); return value; },
      (err) => { cleanup(); throw err; },
    );
  }
  cleanup();
  return result;
}
test("x", async () => {
  await withTempDir("p-", async (dir) => { await doSomethingAsync(dir); });
});
`;
  assert.equal(evaluateFile(safeSourceA).safe, true);
});

test("대조: 전수-await형(패턴 B, 호출부 전부 await)은 안전으로 판정되지만 호출부 중 하나라도 빠지면 불안전으로 판정된다", () => {
  const safeSourceB = `
async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("x", async () => {
  await withTempDir("p-", async (dir) => { await doSomethingAsync(dir); });
});
`;
  assert.equal(evaluateFile(safeSourceB).safe, true);

  const unsafeSourceB = safeSourceB.replace(
    'await withTempDir("p-"',
    'withTempDir("p-"', // ★한 호출부에서 await를 빼먹은 회귀 시나리오.
  );
  const result = evaluateFile(unsafeSourceB);
  assert.equal(result.needsCheck, true);
  assert.equal(result.safe, false);
});

test("대조: withTempDir를 동기 콜백으로만 쓰는 파일은 옛(버그) 정의를 갖고 있어도 검사 대상이 아니다(범위 밖)", () => {
  const syncOnlySource = `
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("x", () => {
  withTempDir("p-", (dir) => { doSyncThing(dir); });
});
`;
  const result = evaluateFile(syncOnlySource);
  assert.equal(result.needsCheck, false);
  assert.equal(result.safe, true);
});
