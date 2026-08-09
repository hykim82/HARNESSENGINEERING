// HYK-186 완료조건2: finalize-done.mjs is the one supported machine-clock
// producer for a result file's '>>> DONE:' line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { finalizeDone, FINALIZE_DONE_REASON } from "./finalize-done.mjs";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "finalize-done.mjs",
);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "finalize-done-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
  });
  assert.equal(res.error, undefined);
  assert.notEqual(res.status, null);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("finalizeDone: callerSuppliedAt !== undefined is refused, regardless of value", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    for (const badValue of [
      "2020-01-01 00:00 KST",
      0,
      new Date(),
      null,
      false,
    ]) {
      const result = finalizeDone({
        role: "coder",
        harnessDir: dir,
        callerSuppliedAt: badValue,
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.reasonCode,
        FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      );
    }
  });
});

test("finalizeDone: normal call (no callerSuppliedAt) writes a DONE line stamped with the injected machine clock", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const fixedMs = Date.parse("2026-08-09T05:00:00Z"); // 2026-08-09 14:00 KST
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => fixedMs,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.FINALIZED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(content, />>> DONE: CODER @ 2026-08-09 14:00:00 KST/);
  });
});

test("finalizeDone: already has a DONE line -> refuses, never overwrites", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-01 00:00:00 KST\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.ALREADY_FINALIZED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /2026-08-01 00:00:00 KST/,
      "original line must survive untouched",
    );
  });
});

test("finalizeDone: result file missing -> refuses with a distinct reason", () => {
  withDir((dir) => {
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.RESULT_FILE_NOT_FOUND);
  });
});

test("CLI (non-Claude engine path, 완료조건7): plain `node finalize-done.mjs <role> <dir>` writes a machine-stamped DONE line", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0);
    assert.match(res.stdout, /^FINALIZED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      />>> DONE: CODER @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST/,
    );
  });
});

test("CLI: --at (or any --at=... form) is refused on sight, before any file is touched", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const res = runCli(["coder", dir, "--at", "2020-01-01 00:00 KST"]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /rejects caller-supplied timestamps/);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(
      content,
      />>> DONE/,
      "no DONE line should have been written",
    );

    const res2 = runCli(["coder", dir, "--at=2020-01-01 00:00 KST"]);
    assert.notEqual(res2.exit, 0);
    assert.match(res2.stderr, /rejects caller-supplied timestamps/);
  });
});
