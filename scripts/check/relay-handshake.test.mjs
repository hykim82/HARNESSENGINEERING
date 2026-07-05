import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

test("(a) task_id matches + DONE after dropped_at -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\nsome report body\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(b) task_id mismatch -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n");
    writeResult(dir, "coder", "task_id: HYK-2\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /handshake mismatch/);
  });
});

test("(c) result missing task_id echo -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n");
    writeResult(dir, "coder", "no id line here\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id echo/);
  });
});

test("(d) task missing task_id header -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "dropped_at: 2026-07-05 06:00 KST\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id header/);
  });
});

test("(e) result file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /result file not found/);
  });
});

test("(f) task file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task file not found/);
  });
});

test("(g) stale: DONE timestamp predates dropped_at -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:10 KST\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:00 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

test("(h) id matches but result has no DONE line -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\nsome report body, no DONE line\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing ">>> DONE/);
  });
});

test("(i) id matches but task is missing dropped_at -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing dropped_at/);
  });
});

test("(j) id matches but dropped_at is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: yesterday\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});

test("(k) id matches but DONE timestamp is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /DONE timestamp not parseable/);
  });
});
