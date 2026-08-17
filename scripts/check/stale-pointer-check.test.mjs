// HYK-292 I3 -- stale-pointer-check.mjs CLI 계약 시험. mkdtemp 픽스처만
// 사용한다(coder-task.md §3-1 요건 6) -- 실물 관제실(D 드라이브)에
// 의존하지 않으므로 CI에서도 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "stale-pointer-check.mjs",
);

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-stale-pointer-cli-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  const env = { ...process.env };
  delete env.HARNESS_STALE_POINTER_FILES;
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// 되돌리면 RED -- 있음/없음 양쪽을 모두 보인다.
// ---------------------------------------------------------------------------
test("stale-pointer-check CLI: clean files -> exit 0, stale_pointer_hits=0", () => {
  withFixture((dir) => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "clean content", "utf8");
    writeFileSync(b, "also clean", "utf8");
    const result = runCli(["--files", `${a},${b}`]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^stale_pointer_hits=0\s*$/);
  });
});

test("stale-pointer-check CLI: one file has a known stale pointer -> exit 1, hit line + count on stderr", () => {
  withFixture((dir) => {
    const a = join(dir, "policy.md");
    writeFileSync(a, "규칙 참조: STATUS §8", "utf8");
    const result = runCli(["--files", a]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /policy\.md:1: STATUS §8/);
    assert.match(result.stderr, /stale_pointer_hits=1/);
  });
});

test("stale-pointer-check CLI: fail-closed -- a listed file does not exist -> exit 2", () => {
  withFixture((dir) => {
    const result = runCli(["--files", join(dir, "nope.md")]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /file not found/);
  });
});

test("stale-pointer-check CLI: missing --files -> exit 2, usage line", () => {
  const result = runCli([]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /usage:/);
});

test("stale-pointer-check CLI: --files resolves to empty list -> exit 2, refuses to vacuously pass", () => {
  const result = runCli(["--files", "  , ,"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /empty list/);
});
