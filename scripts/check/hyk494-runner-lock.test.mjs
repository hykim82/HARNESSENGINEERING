// HYK-494: tests for runner-lock.mjs (machine-wide runner mutual-exclusion
// lock) and its wiring into isolated-suite-runner.mjs's runIsolatedSuite.
//
// ⛔Synthetic lock paths only (dispatch task): every test below either
// drives the production acquireRunnerLock/releaseRunnerLock functions
// against a disposable mkdtemp'd lock PATH, or stubs the lock entirely via
// NOOP_LOCK_SEAMS -- none ever touches runner-lock.mjs's real,
// machine-wide default (os.tmpdir()-based) lock file.
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
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCK_POLL_INTERVAL_MS,
  LOCK_WAIT_TIMEOUT_MS,
  NESTED_LOCK_BYPASS_ENV_VAR,
  acquireRunnerLock,
  defaultRunnerLockPath,
  installLockReleaseOnSignal,
  releaseRunnerLock,
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

test("defaultRunnerLockPath: lives under os.tmpdir() with the fixed filename, never a per-worktree path", () => {
  const p1 = defaultRunnerLockPath({ tmpdirFn: () => "/fake/tmp" });
  const p2 = defaultRunnerLockPath({ tmpdirFn: () => "/fake/tmp" });
  assert.equal(p1, p2, "same tmpdir must always resolve to the same path");
  assert.match(p1, /harness-isolated-suite-runner\.lock$/);
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
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.deepEqual(content, {
      pid: 4242,
      startedAtMs: 1000,
      worktree: "/src",
      head: "deadbeef",
    });
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

test("acquireRunnerLock: NESTED_LOCK_BYPASS_ENV_VAR set -> immediate bypass (nested:true, zero wait), the lock file is never touched", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: 1,
        worktree: null,
        head: null,
      }),
    );
    const before = readFileSync(lockPath, "utf8");
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 50, // short -- if the bypass didn't fire, this would time out
      pollIntervalMs: 5,
      env: { [NESTED_LOCK_BYPASS_ENV_VAR]: "99999" },
    });
    assert.equal(r.acquired, true);
    assert.equal(r.nested, true);
    assert.equal(r.waitMs, 0);
    assert.equal(r.pollCount, 0);
    assert.equal(
      readFileSync(lockPath, "utf8"),
      before,
      "nested bypass must never write/read-modify the file",
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

test("runIsolatedSuite: a real (non-nested) acquisition marks NESTED_LOCK_BYPASS_ENV_VAR in `env` during the run and clears it afterward", () => {
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
    }),
    releaseLockFn: () => ({ released: true, reason: null }),
    installSignalHandlersFn: () => () => {},
    env,
  });
  assert.ok(
    sawDuringSpawn,
    "the marker must be set in env BEFORE spawn (so a child spreading ...process.env inherits it)",
  );
  assert.equal(
    env[NESTED_LOCK_BYPASS_ENV_VAR],
    undefined,
    "the marker must be cleared once this run releases its lock",
  );
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
