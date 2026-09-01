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
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, dirname } from "node:path";
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

function scanRepo() {
  const files = globSync("scripts/**/*.test.mjs", { cwd: REPO_ROOT });
  const results = [];
  for (const relPath of files) {
    const abs = join(REPO_ROOT, relPath);
    const src = readFileSync(abs, "utf8");
    const posixPath = relPath.replace(/\\/g, "/");
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
  const libFiles = globSync("scripts/**/*.mjs", { cwd: REPO_ROOT }).filter(
    (f) => !f.endsWith(".test.mjs"),
  );
  const foundByFile = new Map(); // "relFile::fn" -> true
  for (const relPath of libFiles) {
    const abs = join(REPO_ROOT, relPath);
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
