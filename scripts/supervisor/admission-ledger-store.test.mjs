import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withLedgerLock,
  readLedgerUnlocked,
  STORE_REASON,
} from "./admission-ledger-store.mjs";
import {
  createEmptyLedger,
  admitReservation,
} from "./admission-ledger-core.mjs";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-ledger-store-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

test("readLedgerUnlocked fails closed with LEDGER_MISSING when the file does not exist (RED-c: not 0-active)", () => {
  const { dir, ledger } = tmpPaths();
  try {
    const result = readLedgerUnlocked(ledger);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, STORE_REASON.LEDGER_MISSING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedgerUnlocked fails closed with LEDGER_MALFORMED_JSON on corrupt content", () => {
  const { dir, ledger } = tmpPaths();
  try {
    writeFileSync(ledger, "{not json");
    const result = readLedgerUnlocked(ledger);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, STORE_REASON.LEDGER_MALFORMED_JSON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock writes the ledger atomically (rename, no partial file left behind) and releases the lock", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    const outcome = withLedgerLock(ledger, lock, () => {
      return {
        result: { ok: true },
        nextLedger: createEmptyLedger("2026-08-11T00:00:00.000Z"),
      };
    });
    assert.equal(outcome.ok, true);
    assert.equal(existsSync(ledger), true);
    assert.equal(existsSync(lock), false);
    const read = readLedgerUnlocked(ledger);
    assert.equal(read.ok, true);
    assert.equal(read.ledger.epoch, "2026-08-11T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock passes the MISSING read result through to transition instead of hiding it (init-cutover needs to see this)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    let seenReasonCode = null;
    withLedgerLock(ledger, lock, (readResult) => {
      seenReasonCode = readResult.ok ? null : readResult.reasonCode;
      return { result: {}, nextLedger: null };
    });
    assert.equal(seenReasonCode, STORE_REASON.LEDGER_MISSING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §1 (REVIEW 2R 반려, 재현됨): 2R force-cleared a pid-less lock
// purely by mtime age -- that fallback was itself a TOCTOU hole (module
// header explains the exact mechanism). 한용 확정: "폴백 제거". This test
// replaces the old "reclaims a stale lock file" test (which asserted
// EXACTLY the behavior 3R removes) -- a pid-less lock, however old its
// mtime, is now NEVER auto-reclaimed; it fails closed with a DISTINCT
// reasonCode and a message naming the exact file + remedy (coder-task §1:
// "사람이 그 상황을 알아채고 풀 수 있는 경로").
// RED ⓔ: removing this fail-closed behavior (i.e. restoring the mtime
// fallback) flips this test red -- see admission-cli.test.mjs's RED-ⓔ
// mutation reproduction for the full round-trip proof.
test("HYK-224-3R §1: a pid-less lock is NEVER reclaimed, however old -- fails closed with an actionable manual-release message", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    writeFileSync(lock, ""); // pid-less content (legacy/corrupted shape)
    const past = new Date(Date.now() - 5000);
    utimesSync(lock, past, past); // far older than staleLockMs below
    const outcome = withLedgerLock(
      ledger,
      lock,
      () => ({
        result: { ok: true },
        nextLedger: createEmptyLedger("2026-08-11T00:00:00.000Z"),
      }),
      { lockTimeoutMs: 200, staleLockMs: 1000, pollMs: 10 },
    );
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.reasonCode,
      STORE_REASON.LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED,
    );
    assert.match(
      outcome.detail,
      new RegExp(lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(outcome.detail, /delete it to release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock times out with the generic LOCK_TIMEOUT reason when the lock is held by a confirmed-ALIVE owner (this process's own pid)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    // A lock recording THIS test process's own (genuinely alive) pid --
    // distinguishes "ordinary contention against a live holder" from the
    // pid-less case above, which now gets a different reasonCode entirely.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
    );
    const outcome = withLedgerLock(
      ledger,
      lock,
      () => ({ result: { ok: true }, nextLedger: null }),
      { lockTimeoutMs: 100, staleLockMs: 60_000, pollMs: 10 },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, STORE_REASON.LOCK_TIMEOUT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transition that returns nextLedger:null never writes (BLOCKED decisions leave the ledger untouched)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    withLedgerLock(ledger, lock, () => ({
      result: {},
      nextLedger: createEmptyLedger("2026-08-11T00:00:00.000Z"),
    }));
    const before = readLedgerUnlocked(ledger).ledger;
    withLedgerLock(ledger, lock, (readResult) => {
      const admit = admitReservation(readResult.ledger, {
        reservationId: "r1",
        cap: 0,
        now: "2026-08-11T00:00:01.000Z",
      });
      return {
        result: { decision: admit.decision },
        nextLedger: admit.decision === "BLOCKED" ? null : admit.ledger,
      };
    });
    const after = readLedgerUnlocked(ledger).ledger;
    assert.deepEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
