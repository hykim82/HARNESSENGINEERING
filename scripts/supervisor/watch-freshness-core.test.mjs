// HYK-185 gap#69 (coder-task.md §7, §3) -- watch-freshness-core.mjs 계약
// 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 이 스위트가 100% 통과해도 "실제 감시자가 실제로 살아있다"를 증명
//    하지 않는다 -- 이 코어는 주입된 `lastRun`만 판정한다(watch-run.mjs가
//    실제로 그 기록을 정확히 남기는지는 이 시험의 몫이 아니다).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeWatchFreshness,
  WATCH_FRESHNESS_VERDICT,
  WATCH_FRESHNESS_REASON,
} from "./watch-freshness-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const NOW_MS = Date.parse("2026-08-03T18:00:00+09:00");
const STALE_AFTER_S = 900;

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/fetch/Date.now are never invoked while judging freshness", () => {
  const fsWatched = [
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
    "existsSync",
    "statSync",
  ];
  const cpWatched = [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
  ];
  const fsMocks = fsWatched
    .filter((n) => typeof fs[n] === "function")
    .map((n) =>
      mock.method(fs, n, () => {
        throw new Error(`unexpected fs.${n} call from judgeWatchFreshness`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from judgeWatchFreshness`,
        );
      }),
    );
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from judgeWatchFreshness");
  });
  try {
    judgeWatchFreshness({
      lastRun: { recordedAtMs: NOW_MS - 60_000 },
      now: NOW_MS,
      staleAfterSeconds: STALE_AFTER_S,
    });
    for (const m of [...fsMocks, ...cpMocks])
      assert.equal(m.mock.calls.length, 0);
    assert.equal(dateNowMock.mock.calls.length, 0);
  } finally {
    for (const m of [...fsMocks, ...cpMocks]) m.mock.restore();
    dateNowMock.mock.restore();
  }
});

const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "watch-freshness-core.mjs"),
  "utf8",
);
test("static: watch-freshness-core.mjs has zero import statements (no I/O surface at all)", () => {
  const imports = [
    ...SRC_TEXT.matchAll(/^import[\s\S]*?from\s+["'](.+)["'];?\s*$/gm),
  ];
  assert.deepEqual(imports, []);
});

// ---------------------------------------------------------------------------
// 닫힌 3상태 -- 각 상태로 가는 경계 조건.
// ---------------------------------------------------------------------------
test("ALIVE: recorded well within the stale window (2/2: just now, at the exact boundary)", () => {
  const justNow = judgeWatchFreshness({
    lastRun: { recordedAtMs: NOW_MS },
    now: NOW_MS,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(justNow.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
  const atBoundary = judgeWatchFreshness({
    lastRun: { recordedAtMs: NOW_MS - STALE_AFTER_S * 1000 },
    now: NOW_MS,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(atBoundary.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
});

test("STALE: recorded just past the stale window (1/1)", () => {
  const result = judgeWatchFreshness({
    lastRun: { recordedAtMs: NOW_MS - STALE_AFTER_S * 1000 - 1000 },
    now: NOW_MS,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.STALE);
  assert.equal(result.reasonCode, WATCH_FRESHNESS_REASON.PAST_STALE_WINDOW);
});

test("UNKNOWN: missing/malformed/future record is never read as ALIVE (5/5: null, undefined, wrong shape, non-numeric, future)", () => {
  const cases = [
    null,
    undefined,
    "not-an-object",
    { recordedAtMs: "yesterday" },
    { recordedAtMs: NOW_MS + 60_000 },
  ];
  for (const lastRun of cases) {
    const result = judgeWatchFreshness({
      lastRun,
      now: NOW_MS,
      staleAfterSeconds: STALE_AFTER_S,
    });
    assert.equal(
      result.verdict,
      WATCH_FRESHNESS_VERDICT.UNKNOWN,
      `expected UNKNOWN for lastRun=${JSON.stringify(lastRun)}`,
    );
  }
});

test("fail-closed: invalid now/staleAfterSeconds -> UNKNOWN, never thrown (4/4)", () => {
  for (const bad of [NaN, "x", undefined, null]) {
    assert.doesNotThrow(() => {
      const result = judgeWatchFreshness({
        lastRun: { recordedAtMs: NOW_MS },
        now: bad,
        staleAfterSeconds: STALE_AFTER_S,
      });
      assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.UNKNOWN);
    });
  }
  for (const bad of [0, -1, NaN, "x"]) {
    const result = judgeWatchFreshness({
      lastRun: { recordedAtMs: NOW_MS },
      now: NOW_MS,
      staleAfterSeconds: bad,
    });
    assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.UNKNOWN);
  }
});

test("fail-closed: args not a plain object -> UNKNOWN, never thrown (2/2)", () => {
  for (const bad of [undefined, "not-an-object"]) {
    assert.doesNotThrow(() => {
      assert.equal(
        judgeWatchFreshness(bad).verdict,
        WATCH_FRESHNESS_VERDICT.UNKNOWN,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// (g) 판별력 자동화 -- copy-and-mutate. 신규 파일이라 아직 HEAD에 없으면
// 명시적 사유로 skip한다.
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/watch-freshness-core.mjs"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "watch-freshness-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-watch-freshness-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "watch-freshness-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/watch-freshness-core #4 (필수): 형식 위반 fail-closed 가드 제거 -> RED (기록 없음/형식 위반이 ALIVE로 샘)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function isValidLastRun(lastRun) {\n  if (!isPlainObject(lastRun)) return false;\n  return isFiniteNumber(lastRun.recordedAtMs);\n}",
        "function isValidLastRun(lastRun) {\n  return true;\n}",
      ),
    );
    const result = mutant.judgeWatchFreshness({
      lastRun: { recordedAtMs: "not-a-number" },
      now: NOW_MS,
      staleAfterSeconds: STALE_AFTER_S,
    });
    assert.notEqual(
      result.verdict,
      "UNKNOWN",
      "mutant must misjudge a malformed record (RED signal; proves the structural-validity gate is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #6).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "watch-freshness-core.test.mjs must leave the real worktree exactly as it found it",
  );
});
