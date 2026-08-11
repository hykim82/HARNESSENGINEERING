// HYK-224 (coder-task.md §1/§3, PM 항 4 TOCTOU) -- the I/O half of the
// durable slot ledger. admission-ledger-core.mjs computes deterministic
// transitions from a single snapshot; this module is what makes
// "read snapshot -> compute -> write result" atomic ACROSS PROCESSES, so two
// concurrent admit calls can never both observe the same empty slot and both
// win (the exact failure PM 항 4 names: "두 요청이 같은 빈 슬롯을 보고 둘
// 다 통과한다").
//
// Mechanism: a plain exclusive-create lock file (`fs.openSync(lockPath,
// "wx")`), same primitive Node itself has no portable flock for. A second
// process's "wx" open fails with EEXIST while the first holds the lock;
// it retries with backoff until the lock is free or its own timeout expires
// (STATE_UNAVAILABLE, never silently proceeds without the lock -- fail-
// closed per coder-task §5-6).
//
// HYK-224-2R §1 (REVIEW 1R 반려, 재현됨): the ORIGINAL reclaim rule judged a
// lock "abandoned" purely by mtime age (`staleLockMs`) -- with a short
// staleLockMs and a critical section that legitimately runs longer than it
// (slow disk, large ledger, process scheduling, or simply a debug-delayed
// test), a SECOND process would see the first's still-live lock as "stale"
// and steal it mid-critical-section: both processes then admitted off the
// same empty slot, and the loser's own write got clobbered by the winner's
// later write (a reservation silently vanished). Fix: the lock file's
// content now records its owner's PID
// (`{pid, acquired_at}`, written atomically inside the same `wx`-opened
// fd). A contending process NEVER reclaims a lock whose recorded owner PID
// is confirmed alive (`process.kill(pid, 0)` -- ESRCH means dead, EPERM
// means alive-but-unsignalable, any other outcome is "unknown") --
// regardless of how old the lock file's mtime is. It reclaims IMMEDIATELY
// (no staleLockMs wait at all) once the owner PID is confirmed dead, so a
// genuinely crashed holder still cannot wedge admission forever -- the "no
// permanent leak" property is preserved, just gated on positive proof of
// death instead of a age guess.
//
// HYK-224-3R §1 (REVIEW 2R 반려, 재현됨): 2R kept an mtime-age FALLBACK for
// locks with no usable pid (pre-2R lock files, or corruption). That fallback
// reintroduced the EXACT 1R vulnerability through a side door: judging
// "stale" (age-based) and actually reclaiming (unlink) are two separate,
// non-atomic steps -- nothing re-verifies, between them, that the file being
// deleted is still the SAME one that was judged stale. Two contenders can
// each independently read the same old pid-less lock, each independently
// conclude (from that one shared snapshot) "it's stale," and each then
// unlink+recreate in an interleaving that lets both proceed into their
// critical sections concurrently (검토자 재현: `pidless-b` admitted, but
// `pidless-a`'s reservation was silently overwritten in the final ledger).
// 한용 확정 문면(3R): "pid-less 낡은 락은 fail-closed(폴백 제거)". Fix: a
// pid-less lock is now NEVER auto-reclaimed, at any age -- shouldReclaim
// returns false unconditionally for that case (see below). The tradeoff this
// creates -- a genuinely abandoned pre-3R/corrupted lock now wedges that
// ledger's admission path until a human intervenes -- is deliberate (한용
// 확정, "폴백 제거") and is made non-silent by acquireLock's timeout branch:
// when the lock a caller has been waiting on the whole timeout window turns
// out to be pid-less, the STATE_UNAVAILABLE detail names the exact file path
// and the exact remedy (verify manually, then delete it) instead of a
// generic "lock held" message -- coder-task §1's "사람이 그 상황을 알아채고
// 풀 수 있는 경로" requirement.
//
// Every public function here returns a structured `{ok:false, reasonCode}`
// on any I/O failure -- never throws past its own boundary (S11, same
// contract as concurrency-cap-adapter.mjs). `reasonCode` values below map
// 1:1 onto admission-cli.mjs's `CAP_STATE_UNAVAILABLE reason=<code>` output
// (coder-task §3 1-B table: "0으로 접지 않는다").
import {
  readFileSync,
  writeFileSync,
  writeSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

export const STORE_REASON = Object.freeze({
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
  LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED: "LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED",
  LEDGER_MISSING: "LEDGER_MISSING",
  LEDGER_UNREADABLE: "LEDGER_UNREADABLE",
  LEDGER_MALFORMED_JSON: "LEDGER_MALFORMED_JSON",
  LEDGER_SCHEMA_INVALID: "LEDGER_SCHEMA_INVALID",
  WRITE_FAILED: "WRITE_FAILED",
  DIR_UNAVAILABLE: "DIR_UNAVAILABLE",
});

function sleepSync(ms) {
  const target = Date.now() + ms;
  // Deliberate busy-wait, not setTimeout -- this store's public functions
  // are synchronous by contract (mirrors readConcurrencyCap/readFileSync
  // style call sites: dispatch-worker.ps1 shells out to a short-lived node
  // process per call, there is no event loop to yield to that matters).
  while (Date.now() < target) {
    // no-op
  }
}

// isProcessAlive -- true/false only when we have positive evidence either
// way; null means "couldn't tell" (caller must fall back, never treat null
// as either answer). ESRCH = no such process (dead). EPERM = the process
// exists but we lack permission to signal it (still alive -- seen for
// processes owned by a different user; conservatively alive, never
// reclaimed on that basis alone).
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true;
    return null;
  }
}

// readLockOwner -- `{exists:false}` if the lock file is simply gone (the
// common "already released" case, next wx attempt will just succeed).
// `{exists:true, pid, mtimeMs}` otherwise -- `pid` is null when the content
// is missing/unreadable/malformed (pre-2R lock files, or corruption), which
// signals "no owner identity available, fall back to age" to the caller.
function readLockOwner(lockPath) {
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return { exists: false };
  }
  let pid = null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      pid = parsed.pid;
    }
  } catch {
    // Malformed content -- pid stays null, age-based fallback below.
  }
  return { exists: true, pid, mtimeMs };
}

// shouldReclaim -- the load-bearing decision both 2R and 3R fix. A pid we
// can positively confirm alive is NEVER reclaimed no matter how old the lock
// file's mtime is (2R fix: closes the reviewer's repro of a short
// staleLockMs racing a critical section that legitimately outlives it). A
// pid we can positively confirm dead is reclaimed immediately, without
// waiting out staleLockMs at all -- positive proof of death is stronger
// evidence than any age heuristic. When there is no usable pid at all, OR
// its liveness is genuinely undeterminable, this NEVER reclaims (3R fix,
// 한용 확정 "폴백 제거") -- see the module header for why the age-based
// fallback this replaced was itself a TOCTOU hole, not just a weaker
// heuristic.
function shouldReclaim(owner) {
  if (!owner.exists) return false;
  if (owner.pid !== null) {
    const alive = isProcessAlive(owner.pid);
    if (alive === true) return false;
    if (alive === false) return true;
    // alive === null: unknown -- falls through to "never reclaim" below,
    // same as the no-pid case (S11: an undeterminable owner is not treated
    // as an absent one).
  }
  return false;
}

// tryClaimLock -- the exclusive-create step. Writes `{pid, acquired_at}`
// into the SAME fd the "wx" open just exclusively created, before closing
// it -- so no other process can observe an empty/uninitialized lock file
// between creation and content being written (they are strictly serialized
// by "wx" itself: only the process that wins the create ever writes).
function tryClaimLock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, contended: true };
    return {
      ok: false,
      contended: false,
      reasonCode: STORE_REASON.LOCK_TIMEOUT,
      detail: err.message,
    };
  }
  try {
    writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
    );
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

// timeoutDecision -- what acquireLock reports once its deadline passes,
// extracted so the "was the lock we gave up waiting on pid-less" branch (3R
// §1's actionable-failure requirement) has its own single, testable home.
// A pid-less/undeterminable owner gets a DISTINCT reasonCode and a message
// that names the exact file and the exact remedy -- coder-task §1's "사람이
// 그 상황을 알아채고 풀 수 있는 경로" -- instead of the generic contention
// timeout text, which would read as "just retry" and hide that this one
// will NEVER resolve on its own.
function timeoutDecision(owner, lockPath, timeoutMs) {
  if (owner.exists && owner.pid === null) {
    return {
      ok: false,
      reasonCode: STORE_REASON.LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED,
      detail: `lock file has no recorded owner pid (legacy pre-3R format, corrupted content, or an owner whose liveness could not be determined) -- HYK-224-3R §1 fail-closed: this lock is NEVER auto-reclaimed, so it will not resolve by waiting longer. Manually verify no process is actually using it, then delete it to release: ${lockPath}`,
    };
  }
  return {
    ok: false,
    reasonCode: STORE_REASON.LOCK_TIMEOUT,
    detail: `lock held by another process past ${timeoutMs}ms: ${lockPath}`,
  };
}

// acquireLock -- returns {ok:true} once this process holds the lock, or
// {ok:false, reasonCode} after `timeoutMs` of contention (LOCK_TIMEOUT for
// an ordinary live/undeterminable contender, LOCK_PIDLESS_MANUAL_RELEASE_
// REQUIRED when the lock this process gave up waiting on has no pid at all).
// `staleLockMs` remains an accepted withLedgerLock/CLI option (API/CLI flag
// backward compatibility -- existing callers, including this repo's own
// tests, still pass it) but is no longer read here: HYK-224-3R §1 removed
// the age-based reclaim path entirely (module header), so age never again
// factors into a reclaim decision -- only `shouldReclaim`'s pid-liveness
// check does.
function acquireLock(lockPath, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const claimed = tryClaimLock(lockPath);
    if (claimed.ok) return { ok: true };
    if (!claimed.contended) {
      return {
        ok: false,
        reasonCode: claimed.reasonCode,
        detail: claimed.detail,
      };
    }
    const owner = readLockOwner(lockPath);
    if (shouldReclaim(owner)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another waiter already cleared it -- loop and retry wx.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      return timeoutDecision(owner, lockPath, timeoutMs);
    }
    sleepSync(pollMs);
  }
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone (e.g. force-cleared by a waiter that judged it stale
    // while we were mid-write) -- not this process's problem to report,
    // the ledger write itself already happened under exclusive hold.
  }
}

// readLedgerRaw -- distinguishes the three ways "can't get a trustworthy
// ledger" happens, so a caller can tell "nothing here yet" (LEDGER_MISSING,
// expected before the first cutover) from real corruption (fail-closed,
// coder-task §5-6: 0건으로 접지 않는다).
function readLedgerRaw(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        ok: false,
        reasonCode: STORE_REASON.LEDGER_MISSING,
        detail: err.message,
      };
    }
    return {
      ok: false,
      reasonCode: STORE_REASON.LEDGER_UNREADABLE,
      detail: err.message,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reasonCode: STORE_REASON.LEDGER_MALFORMED_JSON,
      detail: err.message,
    };
  }
  return { ok: true, ledger: parsed };
}

function writeLedgerAtomic(ledgerPath, ledger) {
  const dir = dirname(ledgerPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reasonCode: STORE_REASON.DIR_UNAVAILABLE,
      detail: err.message,
    };
  }
  const tmpPath = `${ledgerPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(ledger, null, 2));
    renameSync(tmpPath, ledgerPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return {
      ok: false,
      reasonCode: STORE_REASON.WRITE_FAILED,
      detail: err.message,
    };
  }
  return { ok: true };
}

// withLedgerLock -- the ONE cross-process atomic unit. `transition(ledgerOrMissing)`
// is a caller-supplied pure function (typically one of admission-ledger-
// core.mjs's exports) that receives `{ok, ledger, reasonCode}` exactly as
// readLedgerRaw produced it (so a MISSING ledger is visible to `transition`,
// letting init-cutover be the one caller that tolerates it) and must return
// `{result, nextLedger}` where `nextLedger` is either the new ledger to
// persist or `null`/`undefined` to persist nothing (e.g. a rejected/blocked
// decision that still needs its `result` returned to the caller without any
// write). The write only happens while this process still holds the lock;
// the lock is released in a `finally` so a throwing `transition` can never
// leave a lock file behind past this call.
export function withLedgerLock(
  ledgerPath,
  lockPath,
  transition,
  {
    lockTimeoutMs = 10_000,
    staleLockMs = 30_000,
    pollMs = 25,
    // Test-support only (coder-task §5 항 1, atomicity proof): widens the
    // window between this process's read and its write so a concurrent
    // second process is deterministically forced to overlap it, instead of
    // relying on incidental OS-scheduling luck to ever exercise the race.
    // Zero in every real caller (dispatch-worker.ps1 never sets this) --
    // this delay happens INSIDE the lock hold, so it only ever slows this
    // process down, never weakens the mutual exclusion itself.
    criticalSectionDelayMs = 0,
  } = {},
) {
  const lockResult = acquireLock(lockPath, {
    timeoutMs: lockTimeoutMs,
    staleLockMs,
    pollMs,
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      reasonCode: lockResult.reasonCode,
      detail: lockResult.detail,
    };
  }
  try {
    const readResult = readLedgerRaw(ledgerPath);
    if (criticalSectionDelayMs > 0) sleepSync(criticalSectionDelayMs);
    const { result, nextLedger } = transition(readResult);
    if (nextLedger !== null && nextLedger !== undefined) {
      const writeResult = writeLedgerAtomic(ledgerPath, nextLedger);
      if (!writeResult.ok) {
        return {
          ok: false,
          reasonCode: writeResult.reasonCode,
          detail: writeResult.detail,
        };
      }
    }
    return { ok: true, result };
  } finally {
    releaseLock(lockPath);
  }
}

// readLedgerUnlocked -- read-only status queries (CLI `status` subcommand)
// that do not need the mutual-exclusion lock; still fail-closed identically
// to the locked read path.
export function readLedgerUnlocked(ledgerPath) {
  return readLedgerRaw(ledgerPath);
}
