// HYK-185-unconsumed-3 (coder-task.md §R3) -- header-time-projection-core.mjs
// 계약 시험.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 이 스위트가 100% 통과해도 "실제 헤더가 실제로 위조/오기됐다"를
//    증명하지 않는다 -- 이 코어는 주입된 `headerFloorMs`/`taskFileMtimeMs`
//    만 판정한다(실제 수집은 이 코어 밖).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
// 3. mutation 시험은 디스크의 현재 소스를 읽는다(이번 태스크는 커밋 0이
//    조건이라 신규 파일이 git HEAD에 없다 -- HEAD 기준이면 항상 skip돼
//    "skip 0" 요구를 못 지킨다).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import child_process from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  judgeHeaderTimeProjection,
  HEADER_TIME_PROJECTION_VERDICT,
  HEADER_TIME_PROJECTION_REASON,
} from "./header-time-projection-core.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process are never invoked while judging header time projection (1/1)", () => {
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
        throw new Error(
          `unexpected fs.${n} call from judgeHeaderTimeProjection`,
        );
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from judgeHeaderTimeProjection`,
        );
      }),
    );
  try {
    judgeHeaderTimeProjection({ headerFloorMs: 1000, taskFileMtimeMs: 2000 });
  } finally {
    for (const m of [...fsMocks, ...cpMocks]) m.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// (b) counter-example matrix -- 전부 UNDECIDABLE(fail-closed), 예외 0.
// ---------------------------------------------------------------------------
test("(a) counter-example matrix: args가 plain object 아님 -> ARGS_INVALID (4/4)", () => {
  for (const bad of [null, undefined, "x", [1, 2]]) {
    const r = judgeHeaderTimeProjection(bad);
    assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.UNDECIDABLE);
    assert.equal(r.reasonCode, HEADER_TIME_PROJECTION_REASON.ARGS_INVALID);
  }
});

test("(a) counter-example matrix: headerFloorMs 형식 위반 -> HEADER_FLOOR_MS_INVALID (4/4)", () => {
  for (const bad of [NaN, Infinity, "1000", undefined]) {
    const r = judgeHeaderTimeProjection({
      headerFloorMs: bad,
      taskFileMtimeMs: 2000,
    });
    assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.UNDECIDABLE);
    assert.equal(
      r.reasonCode,
      HEADER_TIME_PROJECTION_REASON.HEADER_FLOOR_MS_INVALID,
    );
  }
});

test("(a) counter-example matrix: taskFileMtimeMs 형식 위반 -> TASK_FILE_MTIME_MS_INVALID (4/4)", () => {
  for (const bad of [NaN, Infinity, "2000", undefined]) {
    const r = judgeHeaderTimeProjection({
      headerFloorMs: 1000,
      taskFileMtimeMs: bad,
    });
    assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.UNDECIDABLE);
    assert.equal(
      r.reasonCode,
      HEADER_TIME_PROJECTION_REASON.TASK_FILE_MTIME_MS_INVALID,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) 방향 비대칭 -- 실측 근거(+68·+118·+103초)를 그대로 표본으로 쓴다.
// mtime이 헤더보다 «늦은» 쪽은 크기와 무관하게 항상 NORMAL(위쪽 무제한).
// ---------------------------------------------------------------------------
test("실측 편차(+68/+103/+118초, REVIEW 3R P1-3 그대로) -- mtime이 헤더보다 늦어도 크기 무관하게 NORMAL (3/3)", () => {
  const headerFloorMs = Date.parse("2026-08-06T13:50:00+09:00");
  for (const deltaSeconds of [68, 103, 118]) {
    const r = judgeHeaderTimeProjection({
      headerFloorMs,
      taskFileMtimeMs: headerFloorMs + deltaSeconds * 1000,
    });
    assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.NORMAL);
    assert.equal(
      r.reasonCode,
      HEADER_TIME_PROJECTION_REASON.MTIME_AT_OR_AFTER_HEADER,
    );
  }
});

test("mtime이 헤더보다 훨씬 늦어도(1시간 뒤) 위쪽 상한이 없으므로 여전히 NORMAL (1/1)", () => {
  const headerFloorMs = Date.parse("2026-08-06T13:50:00+09:00");
  const r = judgeHeaderTimeProjection({
    headerFloorMs,
    taskFileMtimeMs: headerFloorMs + 3600_000,
  });
  assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.NORMAL);
});

test("mtime === headerFloorMs(경계, 초 절삭 오차 0) -> NORMAL (1/1)", () => {
  const headerFloorMs = Date.parse("2026-08-06T13:50:00+09:00");
  const r = judgeHeaderTimeProjection({
    headerFloorMs,
    taskFileMtimeMs: headerFloorMs,
  });
  assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.NORMAL);
});

test("mtime이 headerFloorMs보다 1ms라도 이르면 -> PROJECTED_FUTURE (1/1)", () => {
  const headerFloorMs = Date.parse("2026-08-06T13:50:00+09:00");
  const r = judgeHeaderTimeProjection({
    headerFloorMs,
    taskFileMtimeMs: headerFloorMs - 1,
  });
  assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.PROJECTED_FUTURE);
  assert.equal(r.reasonCode, HEADER_TIME_PROJECTION_REASON.MTIME_BEFORE_HEADER);
});

test("mtime이 headerFloorMs보다 크게 이르면(수 분 전) -> PROJECTED_FUTURE (1/1)", () => {
  const headerFloorMs = Date.parse("2026-08-06T13:50:00+09:00");
  const r = judgeHeaderTimeProjection({
    headerFloorMs,
    taskFileMtimeMs: headerFloorMs - 5 * 60_000,
  });
  assert.equal(r.verdict, HEADER_TIME_PROJECTION_VERDICT.PROJECTED_FUTURE);
});

// ---------------------------------------------------------------------------
// (d) 판별력 자동화 -- copy-and-mutate. 디스크의 현재 소스를 읽는다(헤더
// S11-3 참조).
// ---------------------------------------------------------------------------
const CORE_PATH = join(THIS_DIR, "header-time-projection-core.mjs");
const CORE_SRC = fs.readFileSync(CORE_PATH, "utf8");

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- either the target string is stale (doesn't match the real implementation) or it's ambiguous (matches more than one spot)`,
  );
  return src.replace(find, replacement);
}

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(
    join(tmpdir(), "nc-header-time-projection-core-mutant-"),
  );
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "header-time-projection-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("NC mutation/header-time-projection-core #1 (필수): 방향 부등호 반전(< 를 > 로) -> RED (정상적으로 늦은 mtime이 PROJECTED_FUTURE로 오판된다)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      "  if (taskFileMtimeMs < headerFloorMs) {",
      "  if (taskFileMtimeMs > headerFloorMs) {",
    ),
  );
  const headerFloorMs = 1_000_000;
  const result = mutant.judgeHeaderTimeProjection({
    headerFloorMs,
    taskFileMtimeMs: headerFloorMs + 68_000, // 실측 근거와 같은 정상 지연.
  });
  assert.equal(
    result.verdict,
    "PROJECTED_FUTURE",
    "mutant must misjudge a normal (late) mtime as PROJECTED_FUTURE (RED signal; proves the comparison direction is load-bearing -- exactly REVIEW's P1-3 root cause direction)",
  );
});

test("NC mutation/header-time-projection-core #2 (필수): 형식 검사 제거(항상 유한수로 침) -> RED (형식 위반 입력이 판정 불가로 안 닫힌다)", async () => {
  const mutant = await importMutatedCopy((src) =>
    applyMutation(
      src,
      'function isFiniteNumber(v) {\n  return typeof v === "number" && Number.isFinite(v);\n}',
      "function isFiniteNumber() {\n  return true;\n}",
    ),
  );
  const result = mutant.judgeHeaderTimeProjection({
    headerFloorMs: "not-a-number",
    taskFileMtimeMs: "also-not-a-number",
  });
  assert.notEqual(
    result.verdict,
    "UNDECIDABLE",
    "mutant must let structurally malformed input through instead of closing to UNDECIDABLE (RED signal; proves the shape gate is load-bearing)",
  );
});
