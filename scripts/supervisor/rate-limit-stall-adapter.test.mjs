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

// 실측(2026-08-16 P1 조사, 세션 jsonl 다건 대조): 진짜 성공 응답은
// `message.model`이 `"<synthetic>"`이 아닌 실제 모델명이고
// `message.usage.output_tokens > 0`이다(표본 12,360여 건 전수 -- 예외
// 0건). 429/합성 메시지는 항상 `model:"<synthetic>"` + `output_tokens:0`.
function genuineSuccessEntry(timestamp) {
  return {
    type: "assistant",
    timestamp,
    message: {
      model: "claude-fable-5",
      usage: { output_tokens: 42 },
    },
  };
}

test("429 히트 뒤 «진짜» 성공 응답(모델명 실재 + output_tokens>0)이 있으면 recoveredAtMs가 채워진다", () => {
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
      JSON.stringify(genuineSuccessEntry("2026-08-16T07:10:00.000Z")),
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

// ★P1 수리(검토자 실측 그대로 재현, coder-task.md §2): 429 한 건 뒤에
// `type:"user"`(사용자 입력·tool_result 제출 포함) 항목만 있는 경우 --
// 사용자 입력은 모델이 실제로 응답했다는 증거가 아니므로 회복으로 치지
// 않는다(recoveredAtMs는 여전히 null, hitAtMs는 그대로 유지 -- STALLED
// 통지가 억제되지 않아야 한다).
test("★P1: 429 뒤 type:user 입력만 있으면 회복으로 치지 않는다(recoveredAtMs 계속 null)", () => {
  withTempDir("rl-p1-user-only-", (home) => {
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
        type: "user",
        timestamp: "2026-08-16T02:05:00.000Z",
        message: { role: "user", content: "다시 시도해줘" },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-16T02:06:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "..." }],
        },
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
    assert.equal(r.observation.hitAtMs, Date.parse("2026-08-16T02:00:00.000Z"));
    assert.equal(r.observation.recoveredAtMs, null);
  });
});

// 대조: 합성 메시지(model:"<synthetic>", 실측상 항상 output_tokens:0)는
// 성공 증거가 아니다 -- 429 에러 메시지 자신도 이 형태를 갖지만
// isRateLimitHitEntry가 먼저 가로챈다. 여기서는 그 밖의 합성 메시지
// (예: 다른 하위 오류)가 회복으로 새지 않는지 별도로 고정한다.
test("합성 메시지(model:<synthetic>, output_tokens:0)는 429 히트 신호가 아니어도 회복으로 치지 않는다", () => {
  withTempDir("rl-synthetic-only-", (home) => {
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
        timestamp: "2026-08-16T02:30:00.000Z",
        message: { model: "<synthetic>", usage: { output_tokens: 0 } },
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
    assert.equal(r.observation.recoveredAtMs, null);
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
