// HYK-494: tests for runner-lock.mjs (machine-wide runner mutual-exclusion
// lock) and its wiring into isolated-suite-runner.mjs's runIsolatedSuite.
//
// ⛔Synthetic lock paths only (dispatch task): every test below either
// drives the production acquireRunnerLock/releaseRunnerLock functions
// against a disposable mkdtemp'd lock PATH, or stubs the lock entirely via
// NOOP_LOCK_SEAMS -- none ever touches runner-lock.mjs's real,
// machine-wide default (os.homedir()-based, HYK-494 2R P2-4 fix) lock file.
//
// §ⓒ⑴'s real-child-process proof (RED before any lock, serialized after)
// is the one scenario a pure in-process unit test cannot honestly make:
// two REAL `node` child processes, started together, racing for the SAME
// file. It drives the production module directly (no copy -- the two
// children import this repo's own scripts/check/runner-lock.mjs by its
// real file:// URL), via a short inline ESM script string (same technique
// isolated-suite-runner.mjs's own FREE_MEM_SAMPLER_SCRIPT uses for its
// synthetic child, not a new file on disk -- product_scope names exactly
// which new files this round may add, and a fixture .mjs isn't one of
// them).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  LOCK_POLL_INTERVAL_MS,
  LOCK_WAIT_TIMEOUT_MS,
  NESTED_LOCK_BYPASS_ENV_VAR,
  acquireRunnerLock,
  defaultRunnerLockPath,
  installLockReleaseOnSignal,
  releaseRunnerLock,
  startLockHeartbeat,
} from "./runner-lock.mjs";
import { RUNNER_STATUS } from "./runner-receipt-writer.mjs";
import { runIsolatedSuite } from "./isolated-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_LOCK_URL = pathToFileURL(join(HERE, "runner-lock.mjs")).href;

function freshLockDir(prefix = "hyk494-lock-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// HYK-494 live finding (this round's own full-runner run 1, §3 완료 조건 3
// evidence): this test FILE can itself run nested inside a real
// isolated-suite-runner.mjs invocation that already holds the real lock --
// that outer process marks NESTED_LOCK_BYPASS_ENV_VAR on its own
// process.env BEFORE spawning the main `node --test` pass (the exact
// mechanism §8 of the design doc describes), and that marker is still
// present in THIS process's ambient process.env when these tests run. Every
// test below that means to exercise NON-nested behavior must explicitly
// strip it, or it silently bypasses the lock it is trying to test (found
// live: all 5 non-nested acquireRunnerLock(...) call sites below, plus the
// GREEN race test's spawned children, failed this exact way on this
// round's own first full-runner run -- same class of fix as hyk473-runner-
// cap.test.mjs's own NESTED_CONCURRENCY_ENV_VAR "save/strip/restore"
// comment).
function cleanEnv() {
  const env = { ...process.env };
  delete env[NESTED_LOCK_BYPASS_ENV_VAR];
  return env;
}

// -- §1: defaultRunnerLockPath -----------------------------------------

// HYK-494 2R (fixture sync, ORCH70 §33 ⓒ -- this is a real behavior change,
// not a weakening): review P2-4 found os.tmpdir() follows the process's own
// TEMP/TMP, so different seats with different TEMP never actually shared
// one lock file. The fix (coder-task dispatch: "default lock path under
// os.homedir (not TEMP)") moves the default to os.homedir() -- this test
// now proves THAT, not the old (broken) tmpdir claim.
test("defaultRunnerLockPath: lives under os.homedir() with the fixed filename, never TEMP/TMP, never a per-worktree path", () => {
  const p1 = defaultRunnerLockPath({ homedirFn: () => "/fake/home" });
  const p2 = defaultRunnerLockPath({ homedirFn: () => "/fake/home" });
  assert.equal(p1, p2, "same homedir must always resolve to the same path");
  assert.match(p1, /harness-isolated-suite-runner\.lock$/);
  assert.equal(
    p1,
    join("/fake/home", "harness-isolated-suite-runner.lock"),
    "must be joined onto the injected homedirFn() result, not some other base",
  );
});

// HYK-494 2R: the REAL (no-override) default specifically -- proves the
// production call site (no test ever exercises this path, every other test
// here injects homedirFn) resolves under os.homedir(), never os.tmpdir()
// (mutation target: swapping the `homedirFn = homedir` default back to
// `tmpdir` would make this the ONLY test that catches it -- every other
// test overrides the seam and would stay green).
test("defaultRunnerLockPath: the REAL default (no override) resolves under the REAL os.homedir(), not os.tmpdir()", () => {
  const real = defaultRunnerLockPath();
  assert.equal(real, join(homedir(), "harness-isolated-suite-runner.lock"));
  assert.notEqual(
    real,
    join(tmpdir(), "harness-isolated-suite-runner.lock"),
    "homedir() and tmpdir() must not coincide on this machine, or this assertion is vacuous",
  );
});

// -- §2: acquireRunnerLock basic acquire/release -------------------------

test("acquireRunnerLock: uncontended acquisition is immediate (waitMs 0, pollCount 0), writes pid/startedAtMs/worktree/head", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const r = acquireRunnerLock({
      lockPath,
      pid: 4242,
      startedAtMs: 1000,
      worktree: "/src",
      head: "deadbeef",
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.nested, false);
    // HYK-494: NOT asserted === 0 -- two back-to-back real Date.now() calls
    // (waitStartMs, then this return's nowMs() - waitStartMs) can legitimately
    // differ by 1ms if a millisecond boundary falls between them, even with
    // zero actual polling/waiting (found flaky empirically: ~30% of separate
    // `node --test` process invocations under this exact assertion). What
    // actually proves "uncontended, no polling" is pollCount === 0 below.
    assert.ok(
      r.waitMs <= 5,
      `waitMs (${r.waitMs}) must be near-zero with no contention`,
    );
    assert.equal(r.pollCount, 0);
    assert.equal(r.reclaimedOrphan, false);
    assert.equal(r.timedOut, false);
    // HYK-494 2R fixture sync (ORCH70 §33 ⓒ, additive-only content shape):
    // the written lock content gained two new fields this round --
    // `lockId` (P2-1's nested-bypass token) and `aliveAtMs` (§12 heartbeat
    // staleness baseline, initialized to startedAtMs at claim time). Both
    // asserted structurally rather than deepEqual-pinned to the whole
    // object, since lockId is a fresh random UUID every call.
    assert.equal(r.lockId, JSON.parse(readFileSync(lockPath, "utf8")).lockId);
    assert.ok(
      typeof r.lockId === "string" && r.lockId.length > 0,
      "acquired result must carry the lockId this call wrote",
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.pid, 4242);
    assert.equal(content.startedAtMs, 1000);
    assert.equal(content.worktree, "/src");
    assert.equal(content.head, "deadbeef");
    assert.equal(
      content.aliveAtMs,
      1000,
      "aliveAtMs must be initialized to startedAtMs at claim time",
    );
    assert.equal(
      Object.keys(content).sort().join(","),
      "aliveAtMs,head,lockId,pid,startedAtMs,worktree",
      "no untracked extra fields -- the content shape is exactly these six",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseRunnerLock: releases our own lock (pid matches) -- file removed", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      env: cleanEnv(),
    });
    assert.ok(existsSync(lockPath));
    const result = releaseRunnerLock({ lockPath, pid: process.pid });
    assert.equal(result.released, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §3: release only our own lock (product_scope ⓘⓘⓘⓘⓘ) ---------------

test("releaseRunnerLock: a lock file owned by a DIFFERENT pid is left untouched -- never deletes another process's lock", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        startedAtMs: 1,
        worktree: null,
        head: null,
      }),
    );
    const result = releaseRunnerLock({ lockPath, pid: process.pid });
    assert.equal(result.released, false);
    assert.equal(
      existsSync(lockPath),
      true,
      "the other process's lock must survive",
    );
    const stillThere = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(stillThere.pid, 999999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseRunnerLock: a missing/unreadable lock file is reported as not-released, never throws", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "never-created.lock");
  try {
    const result = releaseRunnerLock({ lockPath, pid: process.pid });
    assert.equal(result.released, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4: orphan (dead pid) reclaim ----------------------------------------

test("acquireRunnerLock: a lock held by a DEAD pid is reclaimed (reclaimedOrphan true), then acquired under our own pid", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    // A real, guaranteed-dead pid: spawnSync blocks until this child has
    // already exited, so by the time we read its pid back it cannot still
    // be alive on this machine.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    assert.ok(Number.isInteger(deadPid), "spawnSync must report a real pid");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        startedAtMs: 1,
        worktree: null,
        head: null,
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 2,
      timeoutMs: 5000,
      pollIntervalMs: 5,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.reclaimedOrphan, true);
    assert.equal(r.priorOwner.pid, deadPid);
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(
      content.pid,
      process.pid,
      "the reclaimed lock must now be ours",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4b: HYK-494 2R P1-1 fix -- a read failure is "busy", never "orphan" --
//
// A scripted readFileFn fails exactly once (simulating the review's exact
// repro class: ENOENT raced with another process's release/claim, a
// mid-write empty/partial file) -- the OLD code (`!content -> true` inside
// isOrphan) would have treated that failure itself as proof of an orphan
// and called unlinkSync on whatever is really at lockPath (review §2 ⓑ⑵/
// ⑶: a live, different owner's FRESH lock, 3/50). The new code must never
// even reach the orphan/reclaim branch on a read failure -- proven here by
// a spy unlinkFn that must never be called while that failure is live.

test("acquireRunnerLock: a readFileFn failure never calls unlinkFn (read failure != orphan, the exact P1-1 2nd-finding fix) -- recovers and times out against the real (live) owner once reads succeed again", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // genuinely alive -- this test's own process
        startedAtMs: 1,
        worktree: null,
        head: null,
      }),
    );
    let readCalls = 0;
    let unlinkCalls = 0;
    const realReadFileFn = (p, enc) => readFileSync(p, enc);
    const readFileFn = (p, enc) => {
      readCalls += 1;
      if (readCalls <= 3) {
        throw new Error("simulated transient read failure (ENOENT-shaped)");
      }
      return realReadFileFn(p, enc);
    };
    const unlinkFn = (p) => {
      unlinkCalls += 1;
      return unlinkSync(p);
    };
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 80,
      pollIntervalMs: 10,
      readFileFn,
      unlinkFn,
      env: cleanEnv(),
    });
    assert.equal(
      unlinkCalls,
      0,
      "a read failure must never trigger an unlink -- it is not evidence of an orphan",
    );
    assert.ok(readCalls > 3, "must have retried past the simulated failures");
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(
      r.reclaimedOrphan,
      false,
      "the real owner is alive -- nothing was ever reclaimed",
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(
      content.pid,
      process.pid,
      "the live owner's lock must survive untouched",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4c: HYK-494 2R 선택 ① heartbeat -- pid-alive-but-stale is orphan too --
//
// Pure, deterministic unit coverage of the staleness AXIS of isOrphan,
// independent of any real heartbeat sidecar process (that gets its own
// dedicated real-child-process coverage in §12 below) -- a fake nowMs
// clock makes this bounded and fast instead of a real ~90s wall-clock wait.

test("acquireRunnerLock: a lock whose owner pid is genuinely ALIVE but whose heartbeat (aliveAtMs) is older than HEARTBEAT_STALE_MS is still reclaimed (pid reuse / signal death, P2-2's own gap)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const FAR_FUTURE = 10 * HEARTBEAT_STALE_MS;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // genuinely alive (this test's own process) --
        // proves staleness alone can override a passing pid-alive check.
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: "stale-owner-token",
        aliveAtMs: 1,
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: FAR_FUTURE,
      timeoutMs: 5000,
      pollIntervalMs: 5,
      nowMs: () => FAR_FUTURE,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(
      r.reclaimedOrphan,
      true,
      "stale heartbeat must trigger reclaim despite a live-looking pid",
    );
    assert.equal(r.priorOwner.lockId, "stale-owner-token");
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.pid, process.pid + 1, "now ours");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: a lock whose heartbeat (aliveAtMs) is FRESH is never reclaimed even though the owner pid differs from the caller -- waits normally and times out (no false-positive staleness)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    // HYK-494 2R (bug found live while writing this very round, "sync
    // fake clock never advances -> timeout check never fires -> real
    // hang"): a REAL, advancing wall clock (the default nowMs=Date.now) is
    // required here -- unlike the stale-reclaim test above (which returns
    // on its FIRST loop iteration via a successful reclaim, a fixed fake
    // `now` never gets asked to show elapsed time), this test's lock is
    // genuinely NOT stale, so it must fall through to the elapsed-time
    // timeout check on every iteration -- a `nowMs` that always returns the
    // same constant makes `elapsed` permanently 0 and the loop never ends.
    const realNow = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: realNow - 10,
        worktree: null,
        head: null,
        lockId: "fresh-owner-token",
        aliveAtMs: realNow - 10, // well within HEARTBEAT_STALE_MS of now
      }),
    );
    const start = Date.now();
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: realNow,
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    const elapsedWall = Date.now() - start;
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.reclaimedOrphan, false);
    assert.ok(
      elapsedWall < 5000,
      `must stay bounded (real wall time ${elapsedWall}ms) -- a hang would mean staleness false-positived`,
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.lockId, "fresh-owner-token", "untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4d: HYK-494 2R P1-1 fix -- compare-and-delete never deletes a
// DIFFERENT (mismatched) lock it finds after the atomic rename-steal, and
// restores it instead -- a deterministic, white-box drive of
// tryReclaimOrphan's mismatch branch (the real-process, timing-based proof
// of the same safety property lives in §12's concurrent-reclaim test; this
// one pins the exact mechanism byte-for-byte without relying on timing).

test("acquireRunnerLock: if the content moved by the atomic rename-steal does NOT match what was read as orphan, it is restored (never deleted) -- proves the rename-then-COMPARE step actually gates the delete", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    const diskContent = {
      pid: deadPid,
      startedAtMs: 1,
      worktree: null,
      head: null,
      lockId: "dead-owner-token",
      aliveAtMs: 1,
    };
    writeFileSync(lockPath, JSON.stringify(diskContent));
    // The main loop's OWN read (over lockPath) sees the dead-pid content and
    // decides "orphan". tryReclaimOrphan's read (over the tempPath the
    // rename just created) is made to see a DIFFERENT lockId -- simulating
    // "a live owner's content was actually there at rename time" without
    // needing a second real process to win a real race.
    const readFileFn = (p) => {
      if (p === lockPath) return JSON.stringify(diskContent);
      return JSON.stringify({ ...diskContent, lockId: "a-different-owner" });
    };
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 2,
      timeoutMs: 80,
      pollIntervalMs: 10,
      readFileFn,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(
      r.reclaimedOrphan,
      false,
      "a mismatch must never be reported as a successful reclaim",
    );
    // The REAL on-disk bytes (never stubbed) must be exactly what was
    // originally there -- restored via linkSync, not clobbered.
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), diskContent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §5: upper-bound timeout -- bounded, deterministic, no real long wait --

test("acquireRunnerLock: a lock held by a live pid past the upper bound times out -- acquired:false, timedOut:true, no reclaim attempted", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    // Our OWN process's pid is, by construction, alive for the entire
    // duration of this test -- no mocked isPidAliveFn needed, this is a
    // real liveness fact, not a simulated one.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: 1,
        worktree: null,
        head: null,
      }),
    );
    const start = Date.now();
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1, // a different "caller" than the lock's own owner
      startedAtMs: 2,
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    const elapsedWall = Date.now() - start;
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.reclaimedOrphan, false);
    assert.ok(
      r.waitMs >= 60,
      `waitMs (${r.waitMs}) must reach the 60ms upper bound`,
    );
    assert.ok(
      elapsedWall < 5000,
      `this test must stay bounded (real wall time ${elapsedWall}ms) -- a real hang would mean the upper bound stopped working`,
    );
    // the lock file must be untouched -- a timeout never claims it.
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §6: nested bypass (중첩 실행 교착 금지) -------------------------------
//
// isolated-suite-runner.test.mjs's own `runCli` helper (that file's line
// ~33) spawns the real CLI entry point as a child process -- when THAT
// spawn happens from inside a `node --test` run that is itself running
// inside an outer isolated-suite-runner.mjs invocation's clone (i.e. this
// repo's own full runner, which includes isolated-suite-runner.test.mjs in
// its own suite), the outer process is synchronously blocked (spawnSync)
// waiting for that exact child -- if the child tried to acquire the SAME
// lock the outer process already holds, neither side could ever finish.
// NESTED_LOCK_BYPASS_ENV_VAR is the only mechanism that breaks that cycle.

// HYK-494 2R P2-1 fix (fixture sync, ORCH70 §33 ⓒ -- a real behavior
// change, not a weakening): 1R trusted ANY non-empty env value unconditionally
// (review repro: an outer shell setting an arbitrary value bypassed a lock a
// LIVE, different owner held). 2R only bypasses when the env value equals
// the CURRENT lock file's own `lockId` token -- this test now proves that
// correct (matching-token) path; the next test proves the REJECTION path
// the old test's "any value" premise no longer holds for.
test("acquireRunnerLock: NESTED_LOCK_BYPASS_ENV_VAR set to the lock file's OWN lockId -> immediate bypass (nested:true, zero wait), the lock file is never touched", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const realLockId = "real-lock-token-abc";
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: realLockId,
        aliveAtMs: 1,
      }),
    );
    const before = readFileSync(lockPath, "utf8");
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 50, // short -- if the bypass didn't fire, this would time out
      pollIntervalMs: 5,
      env: { [NESTED_LOCK_BYPASS_ENV_VAR]: realLockId },
    });
    assert.equal(r.acquired, true);
    assert.equal(r.nested, true);
    assert.equal(r.waitMs, 0);
    assert.equal(r.pollCount, 0);
    assert.equal(r.nestedBypassRejected, false);
    assert.equal(
      readFileSync(lockPath, "utf8"),
      before,
      "nested bypass must never write/read-modify the file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-494 2R P2-1 fix: this is the review's exact repro shape (an env value
// present, but NOT the current lock's own token) -- it must now be rejected
// and fall through to a normal, bounded wait against the real (live, this
// test process's own pid) owner, timing out exactly as if the env var had
// never been set, with `nestedBypassRejected:true` recorded (product_scope
// P2-1 "영수증에 «우회 거부» 기록").
test("acquireRunnerLock: NESTED_LOCK_BYPASS_ENV_VAR set to a value that does NOT match the lock file's lockId -> rejected, waits normally against the live owner, times out (nestedBypassRejected:true)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    // aliveAtMs must be a REAL, fresh Date.now()-based value here (not a
    // tiny fake like `1`) -- this test uses the default real nowMs
    // (Date.now), and a stale-looking aliveAtMs would trigger the
    // heartbeat-staleness orphan branch (§4c) instead of the rejection path
    // this test exists to prove (found live while writing this round: a
    // mismatched fake-vs-real clock made this test accidentally RECLAIM the
    // "live" owner instead of waiting/timing out).
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // genuinely alive -- this test's own process
        startedAtMs: Date.now(),
        worktree: null,
        head: null,
        lockId: "the-real-token",
        aliveAtMs: Date.now(),
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: Date.now(),
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: { [NESTED_LOCK_BYPASS_ENV_VAR]: "a-forged-or-stale-token" },
    });
    assert.equal(r.acquired, false);
    assert.equal(r.nested, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.nestedBypassRejected, true);
    assert.ok(
      r.waitMs >= 60,
      `a rejected bypass must wait the real upper bound, not skip it (waitMs=${r.waitMs})`,
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(
      content.lockId,
      "the-real-token",
      "the file must be untouched -- a rejected bypass never claims/reclaims",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §7: write failures propagate (never silently "acquired") ------------

test("acquireRunnerLock: a non-EEXIST write failure (e.g. missing lock directory) propagates -- never silently treated as acquired", () => {
  const writeFileFn = () => {
    const err = new Error("ENOENT: no such directory");
    err.code = "ENOENT";
    throw err;
  };
  assert.throws(
    () =>
      acquireRunnerLock({
        lockPath: "/does/not/exist/r.lock",
        writeFileFn,
        env: cleanEnv(),
      }),
    /ENOENT/,
  );
});

// -- §8: named constants exist with sane values ---------------------------

test("LOCK_POLL_INTERVAL_MS/LOCK_WAIT_TIMEOUT_MS: named, positive, poll interval well below the upper bound", () => {
  assert.ok(
    Number.isInteger(LOCK_POLL_INTERVAL_MS) && LOCK_POLL_INTERVAL_MS > 0,
  );
  assert.ok(Number.isInteger(LOCK_WAIT_TIMEOUT_MS) && LOCK_WAIT_TIMEOUT_MS > 0);
  assert.ok(LOCK_POLL_INTERVAL_MS < LOCK_WAIT_TIMEOUT_MS);
});

// HYK-494 2R 선택 ① heartbeat: same "named, positive, sane relative to each
// other" bar as the pair above -- product_scope ⓘⓘⓘⓘ's own named-constant
// requirement ("간격·기한 근거 1줄").
test("HEARTBEAT_INTERVAL_MS/HEARTBEAT_STALE_MS: named, positive, interval well below the staleness limit, and both well below LOCK_WAIT_TIMEOUT_MS", () => {
  assert.ok(
    Number.isInteger(HEARTBEAT_INTERVAL_MS) && HEARTBEAT_INTERVAL_MS > 0,
  );
  assert.ok(Number.isInteger(HEARTBEAT_STALE_MS) && HEARTBEAT_STALE_MS > 0);
  assert.ok(
    HEARTBEAT_INTERVAL_MS < HEARTBEAT_STALE_MS,
    "a single missed tick must not immediately look stale",
  );
  assert.ok(
    HEARTBEAT_STALE_MS < LOCK_WAIT_TIMEOUT_MS,
    "a pid-reuse/signal-death orphan must be reclaimable well before the full 20-minute upper bound",
  );
});

// -- §9: installLockReleaseOnSignal --------------------------------------
//
// A fake EventEmitter stands in for `process` -- this never installs a
// REAL process-level signal handler and never sends a real signal to this
// test's own process (which would be unsafe/flaky in a shared test run).

test("installLockReleaseOnSignal: emitting SIGINT on the (fake) process calls release() then exits with a non-zero code", () => {
  const fakeProcess = new EventEmitter();
  let exitCode = null;
  fakeProcess.exit = (code) => {
    exitCode = code;
  };
  let released = false;
  const uninstall = installLockReleaseOnSignal({
    processRef: fakeProcess,
    release: () => {
      released = true;
    },
  });
  fakeProcess.emit("SIGINT");
  assert.equal(released, true);
  assert.equal(exitCode, 1);
  uninstall();
  assert.equal(
    fakeProcess.listenerCount("SIGINT"),
    0,
    "uninstall must remove the handler",
  );
});

test("installLockReleaseOnSignal: release() throwing still exits (best-effort -- a cleanup failure must not hang the process)", () => {
  const fakeProcess = new EventEmitter();
  let exitCode = null;
  fakeProcess.exit = (code) => {
    exitCode = code;
  };
  installLockReleaseOnSignal({
    processRef: fakeProcess,
    release: () => {
      throw new Error("release blew up");
    },
  });
  assert.doesNotThrow(() => fakeProcess.emit("SIGTERM"));
  assert.equal(exitCode, 1);
});

// -- §10: real-child-process proof (ⓒ⑴) ----------------------------------
//
// One inline ESM script (a literal string, not a new fixture file --
// product_scope lists exactly which new files this round may add) drives
// the REAL runner-lock.mjs by its real file:// URL. `--no-lock` makes a
// child skip acquireRunnerLock entirely, to produce the honest "before any
// lock exists" baseline this task's RED-first requirement asks for.
function lockRaceChildScript() {
  return [
    `import { acquireRunnerLock, releaseRunnerLock } from ${JSON.stringify(RUNNER_LOCK_URL)};`,
    `import { writeFileSync, appendFileSync } from "node:fs";`,
    `const lockPath = process.argv[1];`,
    `const holdMs = Number(process.argv[2]);`,
    `const outPath = process.argv[3];`,
    `const noLock = process.argv[4] === "1";`,
    `let r = { waitMs: 0, pollCount: 0, reclaimedOrphan: false, nested: false };`,
    `if (!noLock) r = acquireRunnerLock({ lockPath, pollIntervalMs: 15, timeoutMs: 15000 });`,
    `const acquiredAtMs = Date.now();`,
    `writeFileSync(outPath, JSON.stringify({ pid: process.pid, acquiredAtMs, r }) + "\\n");`,
    `await new Promise((res) => setTimeout(res, holdMs));`,
    `const releasedAtMs = Date.now();`,
    `if (!noLock) releaseRunnerLock({ lockPath });`,
    `appendFileSync(outPath, JSON.stringify({ releasedAtMs }) + "\\n");`,
  ].join("\n");
}

function spawnRaceChild({ lockPath, holdMs, outPath, noLock }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        lockRaceChildScript(),
        "--",
        lockPath,
        String(holdMs),
        outPath,
        noLock ? "1" : "0",
      ],
      // cleanEnv(): this child's own acquireRunnerLock call (inside
      // lockRaceChildScript) relies on its own default `env: process.env`
      // -- without stripping NESTED_LOCK_BYPASS_ENV_VAR here, a child
      // spawned while this test file itself runs nested inside a real
      // locked full-runner invocation would silently bypass the very lock
      // this test exists to prove serializes (see cleanEnv's own header).
      { stdio: "ignore", env: cleanEnv() },
    );
    child.on("exit", (code) => resolve(code));
  });
}

function readRaceOutput(outPath) {
  const [first, second] = readFileSync(outPath, "utf8").trim().split("\n");
  return { ...JSON.parse(first), ...JSON.parse(second) };
}

test("RED baseline (no lock at all): two real child processes started together overlap -- this is the exact race HYK-494 was opened to close", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "race.lock");
  const out1 = join(dir, "out1.json");
  const out2 = join(dir, "out2.json");
  try {
    const codes = await Promise.all([
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out1, noLock: true }),
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out2, noLock: true }),
    ]);
    assert.deepEqual(codes, [0, 0]);
    const a = readRaceOutput(out1);
    const b = readRaceOutput(out2);
    const overlap =
      Math.min(a.releasedAtMs, b.releasedAtMs) -
      Math.max(a.acquiredAtMs, b.acquiredAtMs);
    assert.ok(
      overlap > 0,
      `RED baseline must overlap (got overlap=${overlap}ms, a=${JSON.stringify(a)}, b=${JSON.stringify(b)}) -- without the lock, two started-together processes' hold windows intersect`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GREEN (locked): two real child processes started together on the SAME lock path never overlap -- one waits for the other", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "race.lock");
  const out1 = join(dir, "out1.json");
  const out2 = join(dir, "out2.json");
  try {
    const t0 = Date.now();
    const codes = await Promise.all([
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out1, noLock: false }),
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out2, noLock: false }),
    ]);
    const wallMs = Date.now() - t0;
    assert.deepEqual(codes, [0, 0]);
    const a = readRaceOutput(out1);
    const b = readRaceOutput(out2);
    const overlap =
      Math.min(a.releasedAtMs, b.releasedAtMs) -
      Math.max(a.acquiredAtMs, b.acquiredAtMs);
    assert.ok(
      overlap <= 0,
      `locked run must NOT overlap (got overlap=${overlap}ms, a=${JSON.stringify(a)}, b=${JSON.stringify(b)})`,
    );
    assert.ok(
      wallMs >= 450,
      `serialized total wall time (${wallMs}ms) should be close to holdMs*2=500ms, never ~250ms (parallel)`,
    );
    const waiter = a.r.waitMs > b.r.waitMs ? a : b;
    assert.ok(
      waiter.r.waitMs > 0,
      "exactly one child must have recorded a real wait",
    );
    assert.equal(
      existsSync(lockPath),
      false,
      "both children released -- nothing left behind",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §10b: HYK-494 2R P1-1 fix -- real-process proof, clock-independent --
//
// review §2 ⓑ⑶'s own method (critical-section marker file, "시계
// 무관 확인"): timing-based overlap detection (§10 above) found false
// negatives on this exact bug in 1R (it never showed the 10/30/50-trial
// violations the review's dedicated marker-file method did) -- a marker
// file created with `wx` exclusive-create right after acquiring, deleted
// right before releasing, makes "two children both inside the critical
// section at once" a hard EEXIST fact, never a clock comparison.
function reclaimRaceChildScript() {
  return [
    `import { acquireRunnerLock, releaseRunnerLock } from ${JSON.stringify(RUNNER_LOCK_URL)};`,
    `import { writeFileSync, unlinkSync } from "node:fs";`,
    `const lockPath = process.argv[1];`,
    `const csPath = process.argv[2];`,
    `const outPath = process.argv[3];`,
    `const holdMs = Number(process.argv[4]);`,
    `const pollIntervalMs = Number(process.argv[5]);`,
    `const timeoutMs = Number(process.argv[6]);`,
    `const r = acquireRunnerLock({ lockPath, pollIntervalMs, timeoutMs });`,
    `let violation = false;`,
    `let csCreated = false;`,
    `if (r.acquired) {`,
    `  try { writeFileSync(csPath, String(process.pid), { flag: "wx" }); csCreated = true; }`,
    `  catch (e) { violation = true; }`,
    `  await new Promise((res) => setTimeout(res, holdMs));`,
    `  if (csCreated) { try { unlinkSync(csPath); } catch (e) {} }`,
    `  releaseRunnerLock({ lockPath });`,
    `}`,
    `writeFileSync(outPath, JSON.stringify({ pid: process.pid, acquired: r.acquired, reclaimedOrphan: r.reclaimedOrphan, timedOut: r.timedOut, violation }));`,
  ].join("\n");
}

function spawnReclaimRaceChild({
  lockPath,
  csPath,
  outPath,
  holdMs,
  pollIntervalMs,
  timeoutMs,
}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        reclaimRaceChildScript(),
        "--",
        lockPath,
        csPath,
        outPath,
        String(holdMs),
        String(pollIntervalMs),
        String(timeoutMs),
      ],
      { stdio: "ignore", env: cleanEnv() }, // cleanEnv(): see spawnRaceChild's own header.
    );
    child.on("exit", () => resolve(JSON.parse(readFileSync(outPath, "utf8"))));
  });
}

// product_scope 1b_exec_line ⑴ "고아 동시 회수 반복(검토 모양·N≥10)=겹침
// 발생 → 수리 뒤 0": N=2 real children race on a lock PRE-SEEDED with a
// dead pid's content (a genuine orphan) every trial -- 1R's "read -> judge
// -> unconditionally unlink" let both see the same orphan and both "win"
// (review's own repro: 7/10 complete overlaps). The fix (tryReclaimOrphan's
// rename-steal-then-compare, runner-lock.mjs) must make this impossible.
const RECLAIM_TRIALS = 10;

test(`GREEN (compare-and-delete reclaim): ${RECLAIM_TRIALS} trials of 2 real children racing a lock pre-seeded with a DEAD pid's orphan content -- zero critical-section violations (clock-independent marker proof, the exact P1-1 repro shape)`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    let bothAcquiredCount = 0;
    for (let trial = 0; trial < RECLAIM_TRIALS; trial += 1) {
      const lockPath = join(dir, `race-${trial}.lock`);
      const csPath = join(dir, `cs-${trial}.marker`);
      const out1 = join(dir, `out-${trial}-1.json`);
      const out2 = join(dir, `out-${trial}-2.json`);
      const deadPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          startedAtMs: 1,
          worktree: null,
          head: null,
          lockId: `dead-${trial}`,
          aliveAtMs: 1,
        }),
      );
      const [a, b] = await Promise.all([
        spawnReclaimRaceChild({
          lockPath,
          csPath,
          outPath: out1,
          holdMs: 40,
          pollIntervalMs: 10,
          timeoutMs: 5000,
        }),
        spawnReclaimRaceChild({
          lockPath,
          csPath,
          outPath: out2,
          holdMs: 40,
          pollIntervalMs: 10,
          timeoutMs: 5000,
        }),
      ]);
      if (a.violation || b.violation) violations += 1;
      if (a.acquired && b.acquired) bothAcquiredCount += 1;
      assert.ok(
        a.acquired && b.acquired,
        `trial ${trial}: both children must eventually acquire (serialized), got a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
      );
      assert.equal(
        existsSync(lockPath),
        false,
        `trial ${trial}: both released -- nothing left behind`,
      );
      assert.equal(
        existsSync(csPath),
        false,
        `trial ${trial}: the critical-section marker must not survive either`,
      );
    }
    assert.equal(
      violations,
      0,
      `${violations}/${RECLAIM_TRIALS} trials saw a critical-section violation (review's 1R repro: 7/10) -- 〔직접〕 finite sample, this machine, this run`,
    );
    assert.equal(bothAcquiredCount, RECLAIM_TRIALS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// product_scope ⓑ⑶ "고아 없음 N=3: 50회 중 0회 … 3: 50회 중 3회" (3자
// 경합): N=3 real children race a COLD-START (no pre-existing file) lock
// across TRIALS trials -- the exact shape that found a 3/50 violation
// rate under 1R's "읽기 실패=고아" bug (a read racing a release/claim
// window misread as orphan, unlinking a brand-new owner's lock). Trial
// count kept modest here (⛔finite sample, 〔직접〕 this machine/run only,
// universal_claim_discipline) relative to review's 50 -- real child-process
// spawn cost scales with trials*children.
const THREE_WAY_TRIALS = 15;

test(`GREEN (3-way cold-start contention): ${THREE_WAY_TRIALS} trials of 3 real children racing a lock with NO pre-existing file -- zero critical-section violations (the exact "read failure misread as orphan" repro shape)`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < THREE_WAY_TRIALS; trial += 1) {
      const lockPath = join(dir, `cold-${trial}.lock`);
      const csPath = join(dir, `cold-cs-${trial}.marker`);
      const outs = [0, 1, 2].map((i) =>
        join(dir, `cold-out-${trial}-${i}.json`),
      );
      const results = await Promise.all(
        outs.map((outPath) =>
          spawnReclaimRaceChild({
            lockPath,
            csPath,
            outPath,
            holdMs: 20,
            pollIntervalMs: 5,
            timeoutMs: 5000,
          }),
        ),
      );
      if (results.some((r) => r.violation)) violations += 1;
      assert.ok(
        results.every((r) => r.acquired),
        `trial ${trial}: all 3 must eventually acquire, got ${JSON.stringify(results)}`,
      );
      assert.equal(
        existsSync(lockPath),
        false,
        `trial ${trial}: nothing left behind`,
      );
    }
    assert.equal(
      violations,
      0,
      `${violations}/${THREE_WAY_TRIALS} trials saw a critical-section violation (review's 1R repro: 3/50) -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §12: HYK-494 2R 선택 ① heartbeat sidecar (real child process) -------

test("startLockHeartbeat: the real sidecar keeps refreshing a lock file's aliveAtMs on a named interval while the token matches and the owner pid is alive, and stop() ends further updates", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const initial = {
      pid: process.pid,
      startedAtMs: Date.now(),
      worktree: null,
      head: null,
      lockId: "heartbeat-token",
      aliveAtMs: 1, // deliberately stale -- proves the SIDECAR (not us) refreshes it
    };
    writeFileSync(lockPath, JSON.stringify(initial));
    const heartbeat = startLockHeartbeat({
      lockPath,
      token: "heartbeat-token",
      pid: process.pid,
      intervalMs: 30,
    });
    try {
      await new Promise((res) => setTimeout(res, 140));
      const afterRunning = JSON.parse(readFileSync(lockPath, "utf8"));
      assert.ok(
        afterRunning.aliveAtMs > 1,
        `sidecar must have refreshed aliveAtMs at least once (got ${afterRunning.aliveAtMs})`,
      );
      heartbeat.stop();
      // a brief settle window for the kill signal to actually land before
      // asserting "no further ticks" -- the sidecar's own setInterval tick
      // (30ms) is well inside this.
      await new Promise((res) => setTimeout(res, 60));
      const afterStop = JSON.parse(readFileSync(lockPath, "utf8"));
      await new Promise((res) => setTimeout(res, 100));
      const afterMore = JSON.parse(readFileSync(lockPath, "utf8"));
      assert.equal(
        afterStop.aliveAtMs,
        afterMore.aliveAtMs,
        "no tick after stop() -- the sidecar must actually be dead, not merely asked to stop",
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startLockHeartbeat: the sidecar stops refreshing once the owner pid is dead (never refreshes a lock whose real owner already exited)", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    const initial = {
      pid: deadPid,
      startedAtMs: 1,
      worktree: null,
      head: null,
      lockId: "dead-owner-heartbeat-token",
      aliveAtMs: 1,
    };
    writeFileSync(lockPath, JSON.stringify(initial));
    const heartbeat = startLockHeartbeat({
      lockPath,
      token: "dead-owner-heartbeat-token",
      pid: deadPid,
      intervalMs: 20,
    });
    try {
      await new Promise((res) => setTimeout(res, 120));
      const after = JSON.parse(readFileSync(lockPath, "utf8"));
      assert.equal(
        after.aliveAtMs,
        1,
        "a dead owner's lock must never be refreshed by the sidecar",
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startLockHeartbeat: the sidecar stops refreshing once the lock file's lockId no longer matches its own token (lock already released/reclaimed by someone else)", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: Date.now(),
        worktree: null,
        head: null,
        lockId: "original-token",
        aliveAtMs: 1,
      }),
    );
    const heartbeat = startLockHeartbeat({
      lockPath,
      token: "original-token",
      pid: process.pid,
      intervalMs: 20,
    });
    try {
      // simulate someone else having released and re-claimed this lock
      // under a NEW identity, between this sidecar's ticks.
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          startedAtMs: Date.now(),
          worktree: null,
          head: null,
          lockId: "a-different-owners-token",
          aliveAtMs: 2,
        }),
      );
      await new Promise((res) => setTimeout(res, 100));
      const after = JSON.parse(readFileSync(lockPath, "utf8"));
      assert.equal(
        after.aliveAtMs,
        2,
        "a token mismatch must stop the sidecar from touching a lock it no longer owns",
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startLockHeartbeat: a spawnHeartbeatFn failure degrades gracefully to a no-op stop() (never throws, mirrors startConcurrencySampler/startFreeMemSampler's own posture)", () => {
  const heartbeat = startLockHeartbeat({
    lockPath: "/fake/lock",
    token: "x",
    pid: 1,
    spawnHeartbeatFn: () => {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => heartbeat.stop());
});

// -- §11: wiring into runIsolatedSuite ------------------------------------

const NOOP_LOCK_SEAMS = {
  acquireLockFn: () => ({
    acquired: true,
    nested: false,
    lockPath: null,
    waitMs: 0,
    pollCount: 0,
    reclaimedOrphan: false,
    priorOwner: null,
    timedOut: false,
  }),
  releaseLockFn: () => ({ released: true, reason: null }),
  installSignalHandlersFn: () => () => {},
  env: {},
};

function execFileForWiringTests() {
  return (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "cafef00d\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
}

test("runIsolatedSuite: acquireLockFn is called BEFORE any spawn (lock-before-measurement), and its result's lock fields ride the receipt", () => {
  const calls = [];
  const receipts = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => {
      calls.push("spawn");
      return { status: 0 };
    },
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    acquireLockFn: (opts) => {
      calls.push("acquireLock");
      assert.equal(opts.worktree, "/src");
      assert.equal(opts.head, "cafef00d");
      return {
        acquired: true,
        nested: false,
        lockPath: "/fake/lock",
        waitMs: 1234,
        pollCount: 3,
        reclaimedOrphan: true,
        priorOwner: { pid: 1 },
        timedOut: false,
      };
    },
    releaseLockFn: () => {
      calls.push("releaseLock");
      return { released: true, reason: null };
    },
    installSignalHandlersFn: () => () => {},
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["acquireLock", "spawn", "releaseLock"]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].lockInfo.waitMs, 1234);
  assert.equal(receipts[0].lockInfo.pollCount, 3);
  assert.equal(receipts[0].lockInfo.reclaimedOrphan, true);
  assert.equal(receipts[0].lockInfo.nested, false);
  assert.equal(receipts[0].lockInfo.timedOut, false);
});

test("runIsolatedSuite: lock timeout -- never clones/spawns, returns a non-zero exit code, writes a LOCK_TIMEOUT receipt (never folds green)", () => {
  const receipts = [];
  let spawnCalled = false;
  let cloneCalled = false;
  const exitCode = runIsolatedSuite({
    execFile: (cmd, args) => {
      if (args[0] === "clone") cloneCalled = true;
      return execFileForWiringTests()(cmd, args);
    },
    spawn: () => {
      spawnCalled = true;
      return { status: 0 };
    },
    log: () => {},
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nowMs: () => 42,
    acquireLockFn: () => ({
      acquired: false,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 999999,
      pollCount: 50,
      reclaimedOrphan: false,
      priorOwner: {
        pid: 777,
        startedAtMs: 1,
        worktree: "/other",
        head: "feedface",
      },
      timedOut: true,
    }),
    releaseLockFn: () => {
      throw new Error("must never be called -- the lock was never acquired");
    },
    installSignalHandlersFn: () => {
      throw new Error(
        "must never be called -- no lock, no signal guard needed",
      );
    },
    env: {},
  });
  assert.notEqual(
    exitCode,
    0,
    "a lock timeout must never return a green (0) exit code",
  );
  assert.equal(cloneCalled, false, "must never clone the repo");
  assert.equal(
    spawnCalled,
    false,
    "must never spawn node --test (시험을 돌리지 않고)",
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerExit, exitCode);
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.LOCK_TIMEOUT);
  assert.equal(receipts[0].headCommit, "cafef00d");
  assert.deepEqual(receipts[0].counts, {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
  assert.equal(receipts[0].lockInfo.timedOut, true);
  assert.equal(receipts[0].lockInfo.waitMs, 999999);
});

test("runIsolatedSuite: nested bypass (NESTED_LOCK_BYPASS_ENV_VAR already set) -- acquireLockFn still runs, but release/signal-guard installation is skipped (nothing of ours to release)", () => {
  let installCalled = false;
  let releaseCalled = false;
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: true,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
    }),
    releaseLockFn: () => {
      releaseCalled = true;
      return { released: true, reason: null };
    },
    installSignalHandlersFn: () => {
      installCalled = true;
      return () => {};
    },
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(
    installCalled,
    false,
    "nested run must not install a signal guard for a lock it never owns",
  );
  assert.equal(
    releaseCalled,
    false,
    "nested run must not release a lock it never acquired",
  );
});

test("runIsolatedSuite: a real (non-nested) acquisition marks NESTED_LOCK_BYPASS_ENV_VAR to the ACQUIRED lock's own lockId (not a bare pid, HYK-494 2R P2-1 fix) during the run, and clears it afterward", () => {
  const env = {};
  let sawDuringSpawn;
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => {
      sawDuringSpawn = env[NESTED_LOCK_BYPASS_ENV_VAR];
      return { status: 0 };
    },
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "this-runs-own-lock-token",
    }),
    releaseLockFn: () => ({ released: true, reason: null }),
    installSignalHandlersFn: () => () => {},
    startHeartbeatFn: () => ({ stop: () => {} }),
    env,
  });
  assert.equal(
    sawDuringSpawn,
    "this-runs-own-lock-token",
    "the marker must be set to this run's OWN lockId (not a pid) BEFORE spawn, so a child spreading ...process.env inherits the exact token",
  );
  assert.equal(
    env[NESTED_LOCK_BYPASS_ENV_VAR],
    undefined,
    "the marker must be cleared once this run releases its lock",
  );
});

// -- §11b: HYK-494 2R 선택 ① heartbeat wiring -----------------------------

test("runIsolatedSuite: a real (non-nested) acquisition starts the heartbeat sidecar with this run's own lockId as `token`, and stops it on release", () => {
  const calls = [];
  const exitCode = runIsolatedSuite({
    // resolvedLockPath (acquireLockForRun) comes from THIS top-level
    // option, never from acquireLockFn's own returned `lockPath` field
    // (that field only rides the receipt's lock_path verbatim) -- must be
    // set here for startHeartbeatFn's `lockPath` arg to match.
    lockPath: "/fake/lock",
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "the-heartbeat-token",
    }),
    releaseLockFn: () => ({ released: true, reason: null }),
    installSignalHandlersFn: () => () => {},
    startHeartbeatFn: (opts) => {
      calls.push({ event: "start", opts });
      return {
        stop: () => calls.push({ event: "stop" }),
      };
    },
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].event, "start");
  assert.equal(calls[0].opts.token, "the-heartbeat-token");
  assert.equal(calls[0].opts.lockPath, "/fake/lock");
  assert.equal(calls[1].event, "stop");
});

test("runIsolatedSuite: a nested acquisition never starts the heartbeat sidecar (nothing of ours to keep alive)", () => {
  let startHeartbeatCalled = false;
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: true,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
    }),
    startHeartbeatFn: () => {
      startHeartbeatCalled = true;
      return { stop: () => {} };
    },
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(
    startHeartbeatCalled,
    false,
    "a nested run owns nothing to heartbeat",
  );
});

test("runIsolatedSuite: RUN_ISOLATED_SUITE_DEFAULTS' own startHeartbeatFn default is a no-op -- every existing/other caller that never mentions heartbeat spawns nothing real", () => {
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "whatever",
    }),
    // startHeartbeatFn deliberately omitted -- this must not throw/hang/
    // spawn a real process.
  });
  assert.equal(exitCode, 0);
});

test("runIsolatedSuite: the lock is released even when the run throws (clone/spawn failure) -- exception path releases too", () => {
  let releaseCalled = false;
  assert.throws(() => {
    runIsolatedSuite({
      execFile: (cmd, args) => {
        if (args[0] === "clone") throw new Error("boom: clone failed");
        return execFileForWiringTests()(cmd, args);
      },
      spawn: () => ({ status: 0 }),
      log: () => {},
      acquireLockFn: () => ({
        acquired: true,
        nested: false,
        lockPath: "/fake/lock",
        waitMs: 0,
        pollCount: 0,
        reclaimedOrphan: false,
        priorOwner: null,
        timedOut: false,
      }),
      releaseLockFn: () => {
        releaseCalled = true;
        return { released: true, reason: null };
      },
      installSignalHandlersFn: () => () => {},
      env: {},
    });
  }, /boom: clone failed/);
  assert.equal(
    releaseCalled,
    true,
    "a thrown exception must still release the lock (finally)",
  );
});

test("runIsolatedSuite: a real lock acquired via a synthetic lockPath is actually removed from disk after a normal run (end-to-end, no stubbed acquire/release)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "real.lock");
  try {
    const exitCode = runIsolatedSuite({
      lockPath,
      startSampler: () => null,
      stopSampler: () => null,
      startFreeMemSamplerFn: () => null,
      stopFreeMemSamplerFn: () => null,
      installSignalHandlersFn: () => () => {},
      env: {},
      execFile: execFileForWiringTests(),
      spawn: () => ({ status: 0 }),
      log: () => {},
      collectFiles: () => [],
      readFile: () => {
        throw new Error("no tap");
      },
      writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    });
    assert.equal(exitCode, 0);
    assert.equal(
      existsSync(lockPath),
      false,
      "the real lock file must be gone after a normal run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
