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
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(b) task_id mismatch -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-2\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /handshake mismatch/);
  });
});

test("(c) result missing task_id echo -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "no id line here\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id echo/);
  });
});

test("(d) task missing task_id header -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "dropped_at: 2026-07-05 06:00 KST\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id header/);
  });
});

test("(e) result file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /result file not found/);
  });
});

test("(f) task file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task file not found/);
  });
});

test("(g) stale: DONE timestamp predates dropped_at -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:10 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:00 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

test("(h) id matches but result has no DONE line -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body, no DONE line\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing ">>> DONE/);
  });
});

test("(i) id matches but task is missing dropped_at -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing dropped_at/);
  });
});

test("(j) id matches but dropped_at is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: yesterday\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});

test("(k) id matches but DONE timestamp is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /DONE timestamp not parseable/);
  });
});

// --- HYK-142 6A: DONE parser `HH:MM(:SS)?` contract frozen --
// dropped_at/DONE timestamps observed in real STATUS/task files sometimes
// carry seconds (e.g. hooks that stamp `HH:MM:SS`) and sometimes don't --
// both forms must parse identically; anything else must still fail-closed.

test("(l) frozen: dropped_at with HH:MM:SS form -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00:15 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(m) frozen: DONE with HH:MM:SS form -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:45 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(n) frozen: both dropped_at and DONE carry HH:MM:SS -> ok, and seconds are honored for staleness ordering", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:10:30 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:29 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

// --- HYK-180 사이클1: mid-line task_id echo distinguished from genuine
// absence (사이클0 증거 -- REVIEW's `for: X / task_id: Y / role: Z` shape
// previously fell through to "missing echo", pending forever) --------

test("(p) known-bad: actual review.md shape -- G1 header + mid-line 'for: X / task_id: Y / role: Z' echo + DONE -> distinct reason, NOT 'missing task_id echo'", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "review",
      "task_id: HYK-167\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "review",
      "dispatch_verified: yes\ntask_id_from_dispatch: HYK-167-review-2\npane_match: 일치\n\nfor: HYK-167 / task_id: HYK-167-review-2 / role: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task_id echo not at line start/);
    assert.doesNotMatch(result.reason, /^result missing task_id echo/);
  });
});

test("(q) paired good: same content, task_id moved to a standalone column-0 line -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "review",
      "task_id: HYK-167-review-2\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "review",
      "dispatch_verified: yes\ntask_id_from_dispatch: HYK-167-review-2\npane_match: 일치\ntask_id: HYK-167-review-2\n\nfor: HYK-167 / role: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(r) genuine absence: no task_id token anywhere -> still 'missing task_id echo', unchanged from (c)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "no id token in this file at all\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^result missing task_id echo/);
  });
});

test("(o) frozen: malformed seconds (single digit) still rejected", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00:5 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});
