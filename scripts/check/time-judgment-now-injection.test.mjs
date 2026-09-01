// HYK-414 1R -- 재발 방지 탐지기(coder-task.md §2-3): «절대시각 픽스처 +
// 시간 판정 진입점을 now 없이 호출»이 새로 생기면 RED로 만든다.
//
// 원인이 된 실사고: scripts/check/relay-handshake-runner-receipt.test.mjs가
// checkRelayHandshake를 now 없이(=Date.now() 기본값, 진짜 시계) 불러
// 하루 중 한 창(코더-task.md §1 실측: 픽스처 06:00/06:10:00 +9h 부근인
// 14:50~15:20경)에서만 실패했다(코드 변경 0, 시계만 이동). 이 시험은
// 그 모양의 재발을 세 층으로 막는다:
//   (0) 닫힌 목록이 최신인지(REGISTERED_CHECK) -- now=Date.now() 기본값을
//       가진 export가 새로 생겼는데 TIME_JUDGMENT_ENTRY_POINTS에 없으면
//       그 자체로 미열거=위험(RED).
//   (1) baseline ratchet -- 현재 스캔 결과가 baseline(재발 방지 원장)을
//       초과하면(새 파일, 또는 기존 파일의 위험 호출 개수 증가) RED.
//   (2) 이 라운드가 고친 파일이 baseline에서 실제로 빠졌는지(회귀 고정).
//   (3) 되돌림 변이 -- 수리를 되돌리면(now 인자 제거) 탐지기가 그 파일을
//       실제로 다시 위험으로 잡는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TIME_JUDGMENT_ENTRY_POINTS,
  scanTestFileForRiskyCalls,
  findExportedNowDefaultFunctions,
} from "./time-judgment-now-injection.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE_PATH = join(HERE, "time-judgment-now-injection.baseline.json");

function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

// HYK-414 2R -- `fs.globSync` (used here in 1R) does not exist in Node 20,
// the version `.github/workflows/enforce.yml` pins CI to (this machine runs
// v26.2.0, which is why 1R was green everywhere except CI: importing a
// named export that a module doesn't provide is a module-load-time
// SyntaxError, so this whole file registered ZERO tests under CI's Node --
// exactly the "1 test(s) failed ... time-judgment-now-injection.test.mjs:1:1"
// shape hyk359-ambient-env-regression.test.mjs's CI-canonical sweep caught
// (coder-task.md §1). Not a floating-ambient-env-specific bug at all --
// `globSync` fails under Node 20 unconditionally; the sweep just happened to
// be the CI path that surfaced it (the outer canonical run hit the same
// failure independently, matching CI's reported "fail 2"). Fixed by
// replacing it with the SAME `readdirSync(dir, { recursive: true,
// withFileTypes: true })` pattern relay-handshake.test.mjs's HYK-344 3R
// `listMjsFilesRecursive` already uses -- that one is part of this same
// CI-canonical suite and passes under Node 20 today, so this pattern is
// proven on the pinned version, unlike `globSync`.
function listFilesRecursive(rootDir, filterFn) {
  const out = [];
  for (const entry of readdirSync(rootDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !filterFn(entry.name)) continue;
    // entry.parentPath (Node 20.12+) / entry.path (older) -- both give the
    // directory containing this entry; fall back defensively (same
    // reasoning as relay-handshake.test.mjs's listMjsFilesRecursive).
    const parentDir = entry.parentPath ?? entry.path ?? rootDir;
    const abs = join(parentDir, entry.name);
    out.push(relative(rootDir, abs).split(sep).join("/"));
  }
  return out;
}

// HYK-414 2R §2-2: whichever enumeration this scanner uses must never be
// able to fail silently into "found 0 files -> 0 risky calls -> pass" --
// that shape is exactly "격리에서 검사가 무력화되면 조용히 통과" the task
// forbids. A real `scripts/` checkout has ~300+ `.test.mjs` files (326 at
// HYK-414 1R) and ~150+ non-test `.mjs` files; a near-zero count means the
// walk itself is broken (wrong root, unreadable directory, wrong recursive
// option support), not that the repo genuinely shrank that much.
function assertNonTrivialFileCount(files, minCount, label) {
  assert.ok(
    files.length >= minCount,
    `sanity: recursive walk under scripts/ found only ${files.length} ${label} file(s), expected at least ${minCount} -- a near-zero count would let this scanner's checks pass vacuously instead of catching real risk (HYK-414 2R §2-2, "격리에서 검사가 무력화되면 조용히 통과 금지")`,
  );
}

function scanRepo() {
  const scriptsRoot = join(REPO_ROOT, "scripts");
  const files = listFilesRecursive(scriptsRoot, (name) =>
    name.endsWith(".test.mjs"),
  );
  assertNonTrivialFileCount(files, 100, ".test.mjs");
  const results = [];
  for (const relPath of files) {
    const posixPath = `scripts/${relPath}`;
    const abs = join(scriptsRoot, relPath);
    const src = readFileSync(abs, "utf8");
    results.push(...scanTestFileForRiskyCalls(posixPath, src));
  }
  return results;
}

function groupCounts(riskyList) {
  const byFileFn = new Map();
  for (const r of riskyList) {
    const key = `${r.file}::${r.fn}`;
    byFileFn.set(key, (byFileFn.get(key) || 0) + 1);
  }
  return byFileFn;
}

// ---------------------------------------------------------------------------
// (0) REGISTERED_CHECK: TIME_JUDGMENT_ENTRY_POINTS가 실제 코드베이스의
// `now = Date.now()` 기본값 export와 정확히 일치하는지 재확인한다. 이
// 목록이 낡으면(새 진입점이 등록 없이 생기면) 스캐너 전체가 fail-open
// 된다 -- 그래서 이 시험 자체가 §2-2의 "미열거의 기본값은 위험"을
// 강제한다.
// ---------------------------------------------------------------------------
test("(tj-0) REGISTERED_CHECK: TIME_JUDGMENT_ENTRY_POINTS가 실측(grep)과 정확히 일치한다 -- 새 now=Date.now() 진입점이 등록 없이 생기면 RED", () => {
  const scriptsRoot = join(REPO_ROOT, "scripts");
  const libFiles = listFilesRecursive(
    scriptsRoot,
    (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"),
  );
  assertNonTrivialFileCount(libFiles, 50, "non-test .mjs");
  const foundByFile = new Map(); // "relFile::fn" -> true
  for (const relPath of libFiles) {
    const abs = join(scriptsRoot, relPath);
    const src = readFileSync(abs, "utf8");
    const baseName = relPath
      .split(/[\\/]/)
      .pop()
      .replace(/\.mjs$/, "");
    for (const fn of findExportedNowDefaultFunctions(src)) {
      foundByFile.set(`${baseName}::${fn}`, true);
    }
  }
  const registered = new Set(
    TIME_JUDGMENT_ENTRY_POINTS.map((e) => `${e.file}::${e.fn}`),
  );
  const foundSet = new Set(foundByFile.keys());

  const unregistered = [...foundSet].filter((k) => !registered.has(k));
  const staleRegistrations = [...registered].filter((k) => !foundSet.has(k));

  assert.deepEqual(
    unregistered,
    [],
    `실측으로 발견됐지만 TIME_JUDGMENT_ENTRY_POINTS에 없는 now=Date.now() 진입점이 있다(미열거=위험 -- 이 목록에 추가하라): ${JSON.stringify(unregistered)}`,
  );
  assert.deepEqual(
    staleRegistrations,
    [],
    `TIME_JUDGMENT_ENTRY_POINTS에 등록돼 있지만 실제로는 now=Date.now() 기본값이 사라진 항목이 있다(목록이 낡았다 -- 제거하거나 코드를 확인하라): ${JSON.stringify(staleRegistrations)}`,
  );
});

// ---------------------------------------------------------------------------
// (1)+(2) baseline ratchet + 이 라운드의 회귀 고정.
// ---------------------------------------------------------------------------
test("(tj-1) baseline ratchet: scripts/**/*.test.mjs 전수 스캔 결과가 baseline(재발 방지 원장)을 넘지 않는다 -- 새 파일/새 호출 증가 = RED", () => {
  const baseline = loadBaseline();
  for (const entry of baseline.entries) {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.length > 0,
      `baseline 항목마다 사유가 있어야 한다(사유 없는 항목=RED): ${JSON.stringify(entry)}`,
    );
    assert.ok(
      baseline.reasons[entry.reason],
      `baseline 항목의 reason 키 '${entry.reason}'가 reasons 사전에 없다: ${JSON.stringify(entry)}`,
    );
  }
  const baselineMap = new Map(
    baseline.entries.map((e) => [`${e.file}::${e.fn}`, e.count]),
  );

  const current = groupCounts(scanRepo());
  const newlyIntroduced = [];
  const exceeded = [];
  for (const [key, count] of current) {
    if (!baselineMap.has(key)) {
      newlyIntroduced.push({ key, count });
      continue;
    }
    if (count > baselineMap.get(key)) {
      exceeded.push({ key, count, baseline: baselineMap.get(key) });
    }
  }

  assert.deepEqual(
    newlyIntroduced,
    [],
    `baseline에 없는 새 (파일,진입점) 위험 호출이 발견됐다 -- 절대시각 픽스처를 now 없이 시간 판정 진입점에 넘기는 새 시험이 추가된 것으로 보인다. now를 주입하거나(권장), 정말 안전하면 baseline에 사유와 함께 추가하라: ${JSON.stringify(newlyIntroduced, null, 2)}`,
  );
  assert.deepEqual(
    exceeded,
    [],
    `기존 파일에서 위험 호출 개수가 baseline보다 늘었다(같은 파일에 now 없는 호출이 새로 추가됨): ${JSON.stringify(exceeded, null, 2)}`,
  );
});

test("(tj-2) 회귀 고정: 이 라운드가 고친 relay-handshake-runner-receipt.test.mjs는 더 이상 위험 목록에 없다", () => {
  const current = scanRepo();
  const stillRisky = current.filter((r) =>
    r.file.endsWith("relay-handshake-runner-receipt.test.mjs"),
  );
  assert.deepEqual(
    stillRisky,
    [],
    `수리 대상 파일이 여전히 위험으로 잡힌다(now 주입이 빠졌거나 되돌아갔다): ${JSON.stringify(stillRisky)}`,
  );
});

// ---------------------------------------------------------------------------
// (tj-node20) HYK-414 2R 회귀 고정: `fs.globSync`(Node 22+ 전용, CI가 고정한
// Node 20에는 없다 -- coder-task.md §1)이 이 탐지기의 두 파일 중 어디에도
// 다시 들어오지 않는지 정적으로 고정한다.
//
// ★정직 한계(이 시험 자체의): 이건 "Node 20에서 실제로 통과하는지"를
// 증명하지 않는다(이 기계는 v26.2.0뿐이라 실제로 Node 20을 실행할 수
// 없다). 대신 그 실패로 이어지는 «원인»(globSync 참조 자체)의 재발을
// 막는다. 실제 되돌림 변이는 이 세션에서 수동으로 한 번 확인했다(결과
// 파일 §2-1에 기록): `node:fs`가 globSync를 안 내보내도록(Node 20을
// 흉내) 커스텀 ESM 로더 훅으로 만든 뒤, globSync를 쓰는 (되돌린) 버전은
// 정확히 CI가 본 것과 같은 모양(`tests 1/fail 1`, 위치 `:1:1`, 서브테스트
// 0개 등록)으로 깨졌고, 지금 커밋된 버전은 그 흉내낸 환경에서도
// 4/4 그대로 통과했다. 그 로더는 일회성 조사 도구라 커밋하지 않았다
// (실험적 module.register API에 CI 스위트 전체를 계속 의존시키고 싶지
// 않았다) -- 그래서 그 결과를 CI에서 매번 재확인하는 대신, 여기서는
// 훨씬 값싸고 안전한 정적 재발 방지로 대체한다: globSync 문자열 자체가
// 두 파일에 다시 나타나면 그 자체로 RED.
test("(tj-node20)★ 되돌림 변이 고정: globSync -- Node 20에 없음, HYK-414 2R 원인 -- 가 이 탐지기의 두 파일 중 어디에도 다시 쓰이지 않는다", () => {
  const libSrc = readFileSync(
    join(HERE, "time-judgment-now-injection.mjs"),
    "utf8",
  );
  const testSrc = readFileSync(
    join(HERE, "time-judgment-now-injection.test.mjs"),
    "utf8",
  );
  // ⚠️일부러 주석을 벗겨내지 않는다: relay-handshake.test.mjs류의
  // stripCommentsBestEffort(정규식 기반)를 이 파일 자기 자신에 적용하면,
  // 이 시험이 검사에 쓰는 정규식 리터럴 자체(`/\*...\*\//` 같은 문자
  // 나열)를 "블록 주석"으로 오인해 소스 중간을 잘라먹는다(직접 겪음 --
  // 그 상태로 실행하면 이 시험 자신의 코드 일부가 검사 대상 문자열에
  // 그대로 노출돼 자기 자신을 오탐으로 잡았다). 대신 아래 두 패턴은
  // «실제 참조 모양»(import 절 또는 호출 괄호)만 좁게 짚도록 만들어
  // 주석 벗기기 없이 원본 그대로 돌려도 이 파일 자신의 설명 산문과는
  // 절대 안 겹친다(코드로 checkRelayHandshake -- 산문에서는 "globSync"
  // 뒤에 괄호나 import 구문이 바로 오지 않는다).
  const referencesGlobSync = (src) =>
    /\bglobSync\s*\(/.test(src) ||
    /\{[^}]*\bglobSync\b[^}]*}\s*from\s*["']node:fs["']/.test(src);
  assert.equal(
    referencesGlobSync(libSrc),
    false,
    "time-judgment-now-injection.mjs가 globSync를 다시 참조한다 -- Node 20(CI 고정 버전)에 없는 API라 HYK-414 2R와 같은 모양으로 CI에서만 깨진다",
  );
  assert.equal(
    referencesGlobSync(testSrc),
    false,
    "time-judgment-now-injection.test.mjs가 globSync를 다시 참조한다 -- Node 20(CI 고정 버전)에 없는 API라 HYK-414 2R와 같은 모양으로 CI에서만 깨진다",
  );
});

// ---------------------------------------------------------------------------
// (3) 되돌림 변이: 수리를 (메모리에서만) 되돌리면 탐지기가 실제로 다시
// 잡는지 확인한다. relay-handshake-runner-receipt.test.mjs (0) 관례와
// 동일하게 파일을 건드리지 않고 문자열 치환으로만 재현한다.
// ---------------------------------------------------------------------------
test("(tj-3)★ 되돌림 변이: relay-handshake-runner-receipt.test.mjs에서 now 주입을 (메모리에서) 제거하면 스캐너가 다시 위험으로 잡는다(탐지기가 load-bearing함을 증명)", () => {
  const targetPath = join(HERE, "relay-handshake-runner-receipt.test.mjs");
  const src = readFileSync(targetPath, "utf8");

  assert.ok(
    /now:\s*FIXED_NOW_MS/.test(src),
    "전제: 이 파일이 실제로 now: FIXED_NOW_MS를 쓰고 있어야 되돌림 변이가 의미 있다",
  );

  // now 주입만 제거 -- 앞뒤 공백/줄바꿈/쉼표 모양(들여쓰기 4칸짜리
  // checkRelayHandshake 호출과 8칸짜리 mod.checkRelayHandshake 호출)을
  // 가리지 않고 `now: FIXED_NOW_MS,` 한 줄 전체를 지워 원래(HYK-414
  // 이전) 모양으로 되돌린다.
  const reverted = src.replace(/[ \t]*now:\s*FIXED_NOW_MS,\n/g, "");

  // 주석 안에서 이 상수를 설명 목적으로 언급하는 문구는 남을 수 있다
  // (예: 파일 머리의 "now: FIXED_NOW_MS`만 쓰고 있어" 설명) -- 여기서
  // 확인할 것은 «호출부 인자로서의» 등장(뒤에 쉼표가 오는 코드 모양)이
  // 전부 지워졌는지다.
  assert.ok(
    !/now:\s*FIXED_NOW_MS,/.test(reverted),
    "치환 후에도 now: FIXED_NOW_MS,(호출 인자 모양)가 남아있다 -- 변이 패턴이 실제 호출부 모양과 안 맞는다(수정 필요)",
  );

  const risky = scanTestFileForRiskyCalls(
    "scripts/check/relay-handshake-runner-receipt.test.mjs",
    reverted,
  );
  assert.ok(
    risky.some((r) => r.fn === "checkRelayHandshake"),
    `RED: now 주입을 제거했는데도 스캐너가 위험을 못 잡는다 -- 탐지기가 아무것도 안 지키고 있다: ${JSON.stringify(risky)}`,
  );

  // 파일은 건드리지 않았다(치환은 메모리 문자열에서만) -- coder-task.md
  // §2-3 ⓔ 관례 그대로 명시적으로 재확인.
  const after = readFileSync(targetPath, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake-runner-receipt.test.mjs는 한 바이트도 변경되지 않았다",
  );
});
