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
