// HYK-270 (coder-task.md §2, §5) -- rate-limit-stall-adapter.mjs 결선 시험.
// 실 `~/.claude`를 건드리지 않는다 -- 전부 mkdtemp 합성 `claudeHomeDir`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRateLimitObservation,
  deriveClaudeProjectDirName,
} from "./rate-limit-stall-adapter.mjs";

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deriveClaudeProjectDirName: 경로 구분자·콜론을 각각 '-'로(병합 없음) -- 실측 관례와 대조", () => {
  assert.equal(
    deriveClaudeProjectDirName("C:\\Users\\A\\orca\\workspaces\\H\\hyk270"),
    "C--Users-A-orca-workspaces-H-hyk270",
  );
});

test("collectRateLimitObservation: 세션 로그 디렉터리 자체가 없으면 정상(hitAtMs:null) -- 결손 아님", () => {
  withTempDir("rl-nodir-", (home) => {
    const r = collectRateLimitObservation(
      { repoRoot: "C:\\wt", now: 100000, claudeHomeDir: home },
      {
        readdirFn: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        readFileFn: () => "",
      },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.observation, { hitAtMs: null, recoveredAtMs: null });
  });
});

test("collectRateLimitObservation: 디렉터리 열거가 ENOENT 아닌 이유로 실패하면 ok:false(조용함으로 접지 않는다)", () => {
  const r = collectRateLimitObservation(
    { repoRoot: "C:\\wt", now: 100000, claudeHomeDir: "C:\\home" },
    {
      readdirFn: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      readFileFn: () => "",
    },
  );
  assert.equal(r.ok, false);
});

test("★HYK-270 핵심: 429 히트만 있고 그 뒤 정상 활동 0 -> hitAtMs 채워지고 recoveredAtMs는 null", () => {
  withTempDir("rl-stalled-", (home) => {
    const projectDirName = deriveClaudeProjectDirName("C:\\wt");
    const projectDir = join(home, "projects", projectDirName);
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-16T02:00:00.000Z",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
      }),
    ].join("\n");
    writeFileSync(join(projectDir, "s1.jsonl"), lines, "utf8");

    const r = collectRateLimitObservation(
      {
        repoRoot: "C:\\wt",
        now: Date.parse("2026-08-16T05:00:00.000Z"),
        claudeHomeDir: home,
      },
      {
        readdirFn: (p) => readdirSync(p),
        readFileFn: (p, enc) => readFileSync(p, enc),
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.observation.hitAtMs, Date.parse("2026-08-16T02:00:00.000Z"));
    assert.equal(r.observation.recoveredAtMs, null);
  });
});

test("429 히트 뒤 정상 활동(에러 아닌 항목)이 있으면 recoveredAtMs가 채워진다", () => {
  withTempDir("rl-recovered-", (home) => {
    const projectDirName = deriveClaudeProjectDirName("C:\\wt");
    const projectDir = join(home, "projects", projectDirName);
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-16T02:00:00.000Z",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-16T07:10:00.000Z",
      }),
    ].join("\n");
    writeFileSync(join(projectDir, "s1.jsonl"), lines, "utf8");

    const r = collectRateLimitObservation(
      {
        repoRoot: "C:\\wt",
        now: Date.parse("2026-08-16T08:00:00.000Z"),
        claudeHomeDir: home,
      },
      {
        readdirFn: (p) => readdirSync(p),
        readFileFn: (p, enc) => readFileSync(p, enc),
      },
    );
    assert.equal(r.observation.hitAtMs, Date.parse("2026-08-16T02:00:00.000Z"));
    assert.equal(
      r.observation.recoveredAtMs,
      Date.parse("2026-08-16T07:10:00.000Z"),
    );
  });
});

test("손상된 줄 1개는 건너뛰고 나머지는 정상 파싱한다(append-only 로그의 미완성 마지막 줄 방어)", () => {
  withTempDir("rl-corrupt-", (home) => {
    const projectDirName = deriveClaudeProjectDirName("C:\\wt");
    const projectDir = join(home, "projects", projectDirName);
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-16T02:00:00.000Z",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
      }),
      '{"broken json',
    ].join("\n");
    writeFileSync(join(projectDir, "s1.jsonl"), lines, "utf8");

    const r = collectRateLimitObservation(
      {
        repoRoot: "C:\\wt",
        now: Date.parse("2026-08-16T05:00:00.000Z"),
        claudeHomeDir: home,
      },
      {
        readdirFn: (p) => readdirSync(p),
        readFileFn: (p, enc) => readFileSync(p, enc),
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.observation.hitAtMs, Date.parse("2026-08-16T02:00:00.000Z"));
  });
});
