import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptRunningReceipt,
  hasRunningReceipt,
  runningReceiptPath,
  REASON,
} from "./running-receipt.mjs";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk171-cycle3b-receipt-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("acceptRunningReceipt: first call for a stable intent creates the receipt exactly once", () => {
  const dir = freshDir();
  try {
    const result = acceptRunningReceipt({
      receiptDir: dir,
      stableIntentId: "intent-1",
      subGrantEnvelope: { task_hash: "th-1", role: "CODER" },
      at: "t1",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.path, runningReceiptPath(dir, "intent-1"));
    const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(onDisk.stable_intent_id, "intent-1");
    assert.equal(onDisk.sub_grant_task_hash, "th-1");
    assert.equal(onDisk.sub_grant_role, "CODER");
    assert.equal(onDisk.event, "launch_acceptance");
  } finally {
    cleanup(dir);
  }
});

test("acceptRunningReceipt: second call for the SAME stable intent is denied (uniqueness, no dup sink source)", () => {
  const dir = freshDir();
  try {
    const first = acceptRunningReceipt({
      receiptDir: dir,
      stableIntentId: "intent-dup",
      subGrantEnvelope: { task_hash: "th-1", role: "CODER" },
      at: "t1",
    });
    assert.equal(first.ok, true);
    const second = acceptRunningReceipt({
      receiptDir: dir,
      stableIntentId: "intent-dup",
      subGrantEnvelope: { task_hash: "th-1", role: "CODER" },
      at: "t2",
    });
    assert.equal(second.ok, false);
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.reason, REASON.ALREADY_RUNNING);
  } finally {
    cleanup(dir);
  }
});

test("acceptRunningReceipt: different stable intents each get exactly one receipt (no cross-intent interference)", () => {
  const dir = freshDir();
  try {
    const a = acceptRunningReceipt({
      receiptDir: dir,
      stableIntentId: "intent-a",
      subGrantEnvelope: { task_hash: "th-a", role: "CODER" },
      at: "t1",
    });
    const b = acceptRunningReceipt({
      receiptDir: dir,
      stableIntentId: "intent-b",
      subGrantEnvelope: { task_hash: "th-b", role: "REVIEW" },
      at: "t1",
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.path, b.path);
  } finally {
    cleanup(dir);
  }
});

test("acceptRunningReceipt: fail-closed on a write that throws (not silently accepted)", () => {
  const dir = freshDir();
  try {
    const result = acceptRunningReceipt(
      {
        receiptDir: dir,
        stableIntentId: "intent-write-fail",
        subGrantEnvelope: { task_hash: "th-1", role: "CODER" },
        at: "t1",
      },
      {
        writeFn: (path, content) => {
          // mutex lock file itself must still be writable -- only fail the
          // receipt record write (path contains the receipt filename, not
          // the mutex lock filename).
          if (path.includes("running-receipt-")) {
            throw new Error("injected disk failure");
          }
          writeFileSync(path, content, { flag: "wx" });
        },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /RUNNING_RECEIPT_WRITE_FAILED/);
  } finally {
    cleanup(dir);
  }
});

test("hasRunningReceipt: reflects existence without side effects", () => {
  const dir = freshDir();
  try {
    assert.equal(hasRunningReceipt(dir, "intent-check"), false);
    acceptRunningReceipt({
      receiptDir: dir,
      stableIntentId: "intent-check",
      subGrantEnvelope: { task_hash: "th-1", role: "CODER" },
      at: "t1",
    });
    assert.equal(hasRunningReceipt(dir, "intent-check"), true);
  } finally {
    cleanup(dir);
  }
});

test("acceptRunningReceipt: rejects missing receiptDir/stableIntentId (fail-closed input validation)", () => {
  const result = acceptRunningReceipt({
    receiptDir: "",
    stableIntentId: "intent-1",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /RUNNING_RECEIPT_INVALID_INPUT/);
});
