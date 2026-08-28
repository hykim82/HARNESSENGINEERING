import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTotalSessionBytes } from "./dispatch-start-size-adapter.mjs";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collectTotalSessionBytes: 디렉터리 없음 -> 정상(totalBytes:0), 결손 아님", () => {
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir: "C:\\nope-zzz" },
    {
      readdirFn: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    },
  );
  assert.deepEqual(r, { ok: true, totalBytes: 0, fileCount: 0 });
});

test("collectTotalSessionBytes: ENOENT 아닌 열거 실패 -> ok:false(조용함으로 접지 않는다)", () => {
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir: "C:\\home" },
    {
      readdirFn: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    },
  );
  assert.equal(r.ok, false);
});

test("collectTotalSessionBytes: 여러 jsonl 파일의 크기를 더한다", () => {
  withTempDir("dss-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "a.jsonl"), "x".repeat(10), "utf8");
    writeFileSync(join(projectDir, "b.jsonl"), "x".repeat(25), "utf8");
    writeFileSync(join(projectDir, "not-jsonl.txt"), "x".repeat(999), "utf8");

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 35);
    assert.equal(r.fileCount, 2);
  });
});

test("collectTotalSessionBytes: stat 실패는 ok:false(STAT_FAILED)", () => {
  const r = collectTotalSessionBytes(
    { repoRoot: "C:\\wt", claudeHomeDir: "C:\\home" },
    {
      readdirFn: () => ["a.jsonl"],
      statFn: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// ★HYK-378 사례1 재구성(coder.md §1 첨부 원문
// orch-evidence-sample1-HYK337-1.md의 실사고를 낳은 «실제 디스크 레이아웃»
// 그대로 -- 발췌 아님, 오늘 실측으로 직접 확인한 경로 구조를 그대로 씀):
//   <projectDir>/84260e74-....jsonl               <- 본 세션(정체됨)
//   <projectDir>/84260e74-.../subagents/agent-*.jsonl <- 하위 에이전트(계속 자람)
// 고치기 전에는 두 번째 파일이 전혀 안 세졌다(프로젝트 디렉터리 "바로
// 아래"만 훑었으므로) -- 그래서 하위 에이전트가 아무리 활발해도 본
// 세션은 "안 자란 것처럼" 보였다.
test("★HYK-378 사례1 재구성: <세션UUID>/subagents/*.jsonl(하위 에이전트 전사록)도 총합에 포함된다", () => {
  withTempDir("dss-subagent-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt\\hyk337-pledge-stall"),
    );
    const sessionUuid = "84260e74-7b3c-4ea1-b981-d062debece4a";
    const subagentsDir = join(projectDir, sessionUuid, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    // 본 세션 jsonl -- 실사고 당시 정체돼 있던 파일.
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(395579),
      "utf8",
    );
    // 하위 에이전트 전사록 -- 실사고 당시 계속 자라고 있던 파일(★고치기
    // 전에는 이 바이트가 총합에서 통째로 빠졌다).
    writeFileSync(
      join(subagentsDir, "agent-a6bfcf6dd9c3cf211.jsonl"),
      "x".repeat(956214),
      "utf8",
    );
    writeFileSync(
      join(subagentsDir, "agent-a6bfcf6dd9c3cf211.meta.json"),
      "x".repeat(173),
      "utf8", // .jsonl이 아니므로 제외돼야 한다.
    );

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt\\hyk337-pledge-stall", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 395579 + 956214);
    assert.equal(r.fileCount, 2);
  });
});

test("collectTotalSessionBytes: 세션 디렉터리에 subagents 폴더가 없으면(하위 에이전트 미가동) 조용히 건너뛴다(결손 아님)", () => {
  withTempDir("dss-no-subagent-", (home) => {
    const projectDir = join(
      home,
      "projects",
      deriveClaudeProjectDirName("C:\\wt"),
    );
    const sessionUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(join(projectDir, sessionUuid), { recursive: true }); // subagents 폴더 없음.
    writeFileSync(
      join(projectDir, `${sessionUuid}.jsonl`),
      "x".repeat(100),
      "utf8",
    );

    const r = collectTotalSessionBytes(
      { repoRoot: "C:\\wt", claudeHomeDir: home },
      { readdirFn: (p) => readdirSync(p) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.totalBytes, 100);
    assert.equal(r.fileCount, 1);
  });
});
