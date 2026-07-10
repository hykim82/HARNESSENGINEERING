import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkControlRoomFresh, DEFAULT_DIRTY_THRESHOLD_MS, DEFAULT_HANDOFF_THRESHOLD_MS } from "./controlroom-fresh.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "controlroom-fresh-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T0 = new Date("2026-07-10T00:00:00+09:00").getTime();
function touch(path, content, mtime) {
  writeFileSync(path, content, "utf8");
  utimesSync(path, mtime, mtime);
}

test("(1) dirty tree + last commit older than threshold -> warning", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => " M STATUS.md\n",
      lastCommitTimeFn: () => new Date(T0 - (DEFAULT_DIRTY_THRESHOLD_MS + 3600000)),
    });
    assert.equal(result.ok, false);
    assert.match(result.warnings.join(" "), /working tree is dirty/);
  });
});

test("(1b) dirty tree + unresolvable commit time (null, e.g. unborn repo/git log failure) -> no warning, ok", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => " M STATUS.md\n",
      lastCommitTimeFn: () => null,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
  });
});

test("(2) dirty tree but recent commit -> ok", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => " M STATUS.md\n",
      lastCommitTimeFn: () => new Date(T0 - 60000),
    });
    assert.equal(result.ok, true);
  });
});

test("(3) clean tree -> ok regardless of commit age", () => {
  withFixtureDir((dir) => {
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => "",
      lastCommitTimeFn: () => new Date(T0 - DEFAULT_DIRTY_THRESHOLD_MS * 10),
    });
    assert.equal(result.ok, true);
  });
});

test("(4) STATUS.md <-> PHASE-HANDOFF.md mtime gap beyond threshold -> warning", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    const handoffPath = join(dir, "PHASE-HANDOFF.md");
    touch(statusPath, "status\n", new Date(T0));
    touch(handoffPath, "handoff\n", new Date(T0 - (DEFAULT_HANDOFF_THRESHOLD_MS + 3600000)));
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => "",
      lastCommitTimeFn: () => new Date(T0),
      statusPath,
      handoffPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.warnings.join(" "), /handoff may be stale/);
  });
});

test("(5) control room path absent or not a git repo -> vacuously ok", () => {
  withFixtureDir((dir) => {
    const missing = join(dir, "does-not-exist");
    const result = checkControlRoomFresh({ controlRoomPath: missing, isGitRepoFn: () => false });
    assert.equal(result.ok, true);
    assert.match(result.reason, /vacuously ok/);
  });
});

test("(6) no controlRoomPath given at all -> vacuously ok", () => {
  const result = checkControlRoomFresh({});
  assert.equal(result.ok, true);
});

test("(7) mtime gap within threshold -> ok, not a false positive", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    const handoffPath = join(dir, "PHASE-HANDOFF.md");
    touch(statusPath, "status\n", new Date(T0));
    touch(handoffPath, "handoff\n", new Date(T0 - 3600000));
    const result = checkControlRoomFresh({
      controlRoomPath: dir,
      now: T0,
      isGitRepoFn: () => true,
      gitStatusFn: () => "",
      lastCommitTimeFn: () => new Date(T0),
      statusPath,
      handoffPath,
    });
    assert.equal(result.ok, true);
  });
});
