// HYK-396 1R -- unit-level coverage for the two new envelope-archive.mjs
// capabilities this track adds (separate from hyk396-dispatch-stamp.test.mjs's
// end-to-end CLI adversarial samples, which exercise the wiring but not
// every internal edge case of these two functions directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveRoundTaskFile,
  stampDispatchIdOnLatestArchivedTaskFile,
  extractArchivedDispatchId,
} from "./envelope-archive.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk396-stamp-unit-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("archiveRoundTaskFile without dispatchId writes the literal 'unknown' placeholder (gate-time snapshot, real value not yet known)", () => {
  withFixtureDir((dir) => {
    const outcome = archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\n",
      harnessDir: dir,
    });
    assert.equal(outcome.ok, true);
    const written = readFileSync(outcome.path, "utf8");
    assert.match(written, /dispatch_id=unknown/);
    assert.equal(extractArchivedDispatchId(written), undefined);
  });
});

test("archiveRoundTaskFile WITH dispatchId bakes the real value into the header immediately", () => {
  withFixtureDir((dir) => {
    const outcome = archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\n",
      harnessDir: dir,
      dispatchId: "ctx_real_value",
    });
    assert.equal(outcome.ok, true);
    const written = readFileSync(outcome.path, "utf8");
    assert.match(written, /dispatch_id=ctx_real_value/);
    assert.equal(extractArchivedDispatchId(written), "ctx_real_value");
  });
});

test("stampDispatchIdOnLatestArchivedTaskFile: finds the highest-round snapshot for the role and stamps 'unknown' -> real value, body untouched", () => {
  withFixtureDir((dir) => {
    archiveRoundTaskFile({
      role: "coder",
      taskContent:
        "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\nbody text\n",
      harnessDir: dir,
    });
    const outcome = stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_after_dispatch",
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.skipped, false);
    const written = readFileSync(outcome.path, "utf8");
    assert.match(written, /dispatch_id=ctx_after_dispatch/);
    assert.match(written, /body text/);
    assert.equal(extractArchivedDispatchId(written), "ctx_after_dispatch");
  });
});

test("stampDispatchIdOnLatestArchivedTaskFile: only touches the HIGHEST round number for the role -- an earlier round's stamp is untouched", () => {
  withFixtureDir((dir) => {
    archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\n",
      harnessDir: dir,
      dispatchId: "ctx_round1",
    });
    archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-2\ndropped_at: 2026-08-30 11:00 KST\n",
      harnessDir: dir,
    });
    const outcome = stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_round2",
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.path, /coder-task-r2\.md$/);
    const r1 = readFileSync(join(dir, "rounds", "coder-task-r1.md"), "utf8");
    assert.match(
      r1,
      /dispatch_id=ctx_round1/,
      "round 1's real stamp must survive untouched",
    );
  });
});

test("stampDispatchIdOnLatestArchivedTaskFile: idempotent retry with the SAME dispatchId -> ok:true, skipped:true, no-op", () => {
  withFixtureDir((dir) => {
    archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\n",
      harnessDir: dir,
    });
    stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_x",
    });
    const outcome = stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_x",
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.skipped, true);
  });
});

test("★one-shot safety: a second call with a DIFFERENT dispatchId than what's already stamped is REFUSED (ok:false), never silently overwritten", () => {
  withFixtureDir((dir) => {
    archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\n",
      harnessDir: dir,
    });
    stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_first",
    });
    const outcome = stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_second_different",
    });
    assert.equal(outcome.ok, false);
    const stillStamped = readFileSync(
      join(dir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    assert.match(
      stillStamped,
      /dispatch_id=ctx_first/,
      "refusing must leave the original real value untouched",
    );
  });
});

test("stampDispatchIdOnLatestArchivedTaskFile: no snapshot exists yet -> ok:false, never throws", () => {
  withFixtureDir((dir) => {
    mkdirSync(join(dir, "rounds"), { recursive: true });
    const outcome = stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "ctx_x",
    });
    assert.equal(outcome.ok, false);
  });
});

test("stampDispatchIdOnLatestArchivedTaskFile: missing dispatchId -> ok:false (손기입 대체값 금지, never invents a value)", () => {
  withFixtureDir((dir) => {
    archiveRoundTaskFile({
      role: "coder",
      taskContent: "task_id: HYK-1\ndropped_at: 2026-08-30 10:00 KST\n",
      harnessDir: dir,
    });
    const outcome = stampDispatchIdOnLatestArchivedTaskFile({
      role: "coder",
      harnessDir: dir,
      dispatchId: "",
    });
    assert.equal(outcome.ok, false);
  });
});

test("extractArchivedDispatchId: no header line at all -> undefined (not a file this module produced)", () => {
  assert.equal(
    extractArchivedDispatchId("task_id: HYK-1\nno header here\n"),
    undefined,
  );
});

test("extractArchivedDispatchId: header present but no dispatch_id field (pre-migration shape) -> undefined", () => {
  const content =
    "<!-- envelope-archive: role=CODER kind=task dropped_at=2026-08-30 10:00 KST -->\ntask_id: HYK-1\n";
  assert.equal(extractArchivedDispatchId(content), undefined);
});

test("extractArchivedDispatchId: literal 'unknown' placeholder -> undefined (absence, not a real value)", () => {
  const content =
    "<!-- envelope-archive: role=CODER kind=task dropped_at=2026-08-30 10:00 KST dispatch_id=unknown -->\ntask_id: HYK-1\n";
  assert.equal(extractArchivedDispatchId(content), undefined);
});
