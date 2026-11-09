// HYK-494-runner-lock-3: a standalone CLI probe for comparing runner-lock.mjs
// race behavior ACROSS module versions (old vs new) using REAL child
// processes -- the PM design doc's own §(f) "칠 명령" mechanism:
//   git show e4691d9:scripts/check/runner-lock.mjs > <tmp>/rl-2r.mjs
//   node scripts/check/runner-lock-race-probe.mjs --lock-module <tmp>/rl-2r.mjs --cells orphan-dead:3:30
// then again with no --lock-module (defaults to THIS repo's own current
// runner-lock.mjs) to prove the fix closes every cell to zero.
//
// §2 범위: this file only drives whatever module --lock-module points at,
// via its own public acquireRunnerLock/releaseRunnerLock exports and a
// `wx`-created critical-section marker (clock-independent violation proof,
// same technique as hyk494-runner-lock.test.mjs's own spawnReclaimRaceChild)
// -- it never assumes internals specific to either module version.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = { lockModule: null, cells: "all", jsonOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lock-module") out.lockModule = argv[++i];
    else if (a === "--cells") out.cells = argv[++i];
    else if (a === "--json-out") out.jsonOut = argv[++i];
    else throw new Error(`runner-lock-race-probe: unrecognized arg ${a}`);
  }
  return out;
}

const DEFAULT_LOCK_MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "runner-lock.mjs",
);

// All named cells this probe knows how to run. Each is `{entrants, trials}`
// driven by one shared child script template -- the only thing that varies
// per cell is how the lock is seeded before the race and how long each
// child holds the critical section.
const CELL_DEFS = {
  "cold-start": {
    seed: "none",
    holdMs: 20,
    pollIntervalMs: 5,
    timeoutMs: 5000,
  },
  "orphan-dead": {
    seed: "orphan",
    holdMs: 30,
    pollIntervalMs: 10,
    timeoutMs: 5000,
  },
  // PM table (e) "오래 기다린 뒤 잡기" cell, scaled N=100ms/M=600ms per that
  // same table -- two real entrants, no pre-existing lock: 甲 claims a cold
  // lock but reports a BACKDATED startedAtMs (simulatedWaitMs), exactly
  // mirroring isolated-suite-runner.mjs's own real call shape (`startedAtMs:
  // nowMs()` captured BEFORE the wait/poll loop even starts, HYK-494 2R
  // acquireLockForRun) -- so content.aliveAtMs is already "stale" the
  // instant 甲 claims, before 甲's own heartbeat sidecar's first tick. 丙
  // enters a few ms later (well inside one heartbeatIntervalMs) and polls
  // fast, trying to catch 甲 in that pre-first-tick window.
  "long-wait": {
    seed: "none",
    holdMs: 400,
    pollIntervalMs: 5,
    timeoutMs: 5000,
    heartbeatIntervalMs: 100,
    heartbeatStaleMs: 600,
    simulatedWaitMs: 2000,
    entrantDelaysMs: [0, 30],
  },
  // HYK-494 후속 P2-4: entrant 0이 잠금을 쥔 "뒤" 자기 L을 직접(외부 침입을
  //흉내) 다른 lockId로 덮어써서 releaseRunnerLock이 lockLost:true를
  // 돌리게 만든다 -- 이 칸의 목적은 "lost"가 상수가 아니라 실제로 잰 값
  // (releaseRunnerLock의 반환값)임을 증명하는 것뿐이다, 상호 배제 자체를
  // 주장하지 않는다(외부가 L을 직접 덮어쓰면 상호 배제가 성립하지 않는
  // 것이 당연하다 -- design doc §9-2).
  "lock-lost": {
    seed: "none",
    holdMs: 20,
    pollIntervalMs: 5,
    timeoutMs: 5000,
    forceLockLossMs: 10,
  },
};

function childScript() {
  return `
import { acquireRunnerLock, releaseRunnerLock, startLockHeartbeat } from ${JSON.stringify(
    pathToFileURL(globalThis.__PROBE_LOCK_MODULE__).href,
  )};
import { writeFileSync, unlinkSync } from "node:fs";
const [lockPath, csPath, outPath, holdMs, pollIntervalMs, timeoutMs, heartbeatIntervalMs, heartbeatStaleMs, delayBeforeMs, simulatedWaitMs, forceLockLossMs] = process.argv.slice(2);
await new Promise((res) => setTimeout(res, Number(delayBeforeMs) || 0));
const opts = { lockPath, pollIntervalMs: Number(pollIntervalMs), timeoutMs: Number(timeoutMs), env: {} };
if (Number(heartbeatStaleMs) > 0) opts.heartbeatStaleMs = Number(heartbeatStaleMs);
if (Number(simulatedWaitMs) > 0) opts.startedAtMs = Date.now() - Number(simulatedWaitMs);
const r = acquireRunnerLock(opts);
let violation = false;
let csCreated = false;
let hb = null;
let lockLost = false;
if (r.acquired) {
  if (Number(heartbeatIntervalMs) > 0 && typeof startLockHeartbeat === "function" && r.lockId) {
    try {
      hb = startLockHeartbeat({ lockPath, token: r.lockId, pid: process.pid, intervalMs: Number(heartbeatIntervalMs) });
    } catch {}
  }
  try { writeFileSync(csPath, String(process.pid), { flag: "wx" }); csCreated = true; }
  catch (e) { violation = true; }
  if (Number(forceLockLossMs) > 0) {
    // HYK-494 후속 P2-4: self-inflicted intrusion -- overwrite our OWN L
    // with a different lockId while we still hold it, so releaseRunnerLock
    // below genuinely returns lockLost:true (not a hardcoded probe value).
    await new Promise((res) => setTimeout(res, Number(forceLockLossMs)));
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAtMs: 1, worktree: null, head: null, lockId: "INTRUDER-" + Date.now() }));
    } catch {}
  }
  await new Promise((res) => setTimeout(res, Number(holdMs)));
  if (csCreated) { try { unlinkSync(csPath); } catch {} }
  if (hb) { try { hb.stop(); } catch {} }
  if (typeof releaseRunnerLock === "function") {
    try {
      const rel = releaseRunnerLock({ lockPath, pid: process.pid, lockId: r.lockId });
      lockLost = !!(rel && rel.lockLost);
    } catch {}
  }
}
writeFileSync(outPath, JSON.stringify({
  pid: process.pid,
  acquired: r.acquired,
  reclaimedOrphan: r.reclaimedOrphan,
  reclaimReason: r.reclaimReason ?? null,
  timedOut: r.timedOut,
  violation,
  lockLost,
}));
`;
}

function seedLock({ lockPath, seed }) {
  if (seed === "none") return;
  if (seed === "orphan" || seed === "long-wait") {
    // A genuinely dead pid (spawnSync blocks until it has already exited).
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: `seed-${seed}`,
        aliveAtMs: 1,
      }),
    );
  }
}

function runChildReal({ scriptPath, args }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: "ignore",
      env: {},
    });
    child.on("exit", () => resolve());
  });
}

// One trial of a cell -- pulled out of runCell below purely to keep that
// function's own ESLint complexity gate happy (no behavior change: this is
// byte-for-byte the same per-trial body, just named).
async function runTrial({ name, def, entrants, scriptPath, dir, trialIdx }) {
  const lockPath = join(dir, `${name}-${trialIdx}.lock`);
  const csPath = join(dir, `${name}-${trialIdx}.cs`);
  seedLock({ lockPath, seed: def.seed });
  const outs = [];
  const promises = [];
  for (let i = 0; i < entrants; i++) {
    const outPath = join(dir, `${name}-${trialIdx}-${i}.json`);
    outs.push(outPath);
    const delayBefore = (def.entrantDelaysMs || [])[i] ?? 0;
    // simulatedWaitMs/forceLockLossMs only apply to entrant 0 -- the one
    // whose backdated startedAtMs reproduces the P1-B window, or (for
    // lock-lost) the one that self-inflicts the intrusion; later entrants
    // use their own real, unmodified path.
    const simulatedWaitMs = i === 0 ? def.simulatedWaitMs || 0 : 0;
    const forceLockLossMs = i === 0 ? def.forceLockLossMs || 0 : 0;
    promises.push(
      runChildReal({
        scriptPath,
        args: [
          lockPath,
          csPath,
          outPath,
          String(def.holdMs),
          String(def.pollIntervalMs),
          String(def.timeoutMs),
          String(def.heartbeatIntervalMs || 0),
          String(def.heartbeatStaleMs || 0),
          String(delayBefore),
          String(simulatedWaitMs),
          String(forceLockLossMs),
        ],
      }),
    );
  }
  await Promise.all(promises);
  const results = outs.map((p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return { acquired: false, violation: false };
    }
  });
  return { results, lockLeftAfter: existsSync(lockPath) };
}

// Folds one trial's results into the running totals -- pulled out of
// runCell below for the same reason runTrial was (ESLint complexity gate).
function foldTrialIntoTotals(totals, { results, lockLeftAfter }) {
  const violated = results.some((r) => r.violation);
  if (violated) {
    totals.overlapTrials += 1;
    totals.exclusionFailures += results.filter((r) => r.violation).length;
  }
  totals.ownersMax = Math.max(
    totals.ownersMax,
    results.filter((r) => r.acquired).length,
  );
  for (const r of results) {
    if (r.reclaimReason) {
      totals.reclaimReasons[r.reclaimReason] =
        (totals.reclaimReasons[r.reclaimReason] || 0) + 1;
    }
    if (r.timedOut) totals.timedOutCount += 1;
    // HYK-494 후속 P2-4: measured from releaseRunnerLock's own return value
    // (childScript above), never a constant.
    if (r.lockLost) totals.lostCount += 1;
  }
  if (lockLeftAfter) totals.lockLeftCount += 1;
}

async function runCell(name, def, { lockModule, dir }) {
  const [entrantsStr, trialsStr] = (CELL_ARGS[name] || "").split(":");
  const entrants = Number(entrantsStr) || 3;
  const trials = Number(trialsStr) || 10;
  const scriptPath = join(dir, `child-${name}.mjs`);
  globalThis.__PROBE_LOCK_MODULE__ = lockModule;
  writeFileSync(scriptPath, childScript());
  const totals = {
    overlapTrials: 0,
    exclusionFailures: 0,
    ownersMax: 0,
    lockLeftCount: 0,
    reclaimReasons: {},
    timedOutCount: 0,
    lostCount: 0,
  };
  for (let t = 0; t < trials; t++) {
    const trialOutcome = await runTrial({
      name,
      def,
      entrants,
      scriptPath,
      dir,
      trialIdx: t,
    });
    foldTrialIntoTotals(totals, trialOutcome);
  }
  return {
    cell: name,
    entrants,
    trials,
    overlap_trials: totals.overlapTrials,
    exclusion_failures: totals.exclusionFailures,
    owners_max: totals.ownersMax,
    lock_left: totals.lockLeftCount,
    reclaim_reasons: totals.reclaimReasons,
    lost: totals.lostCount,
    timedOut: totals.timedOutCount,
  };
}

const CELL_ARGS = {};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolvedLockModule = args.lockModule
    ? isAbsolute(args.lockModule)
      ? args.lockModule
      : join(process.cwd(), args.lockModule)
    : DEFAULT_LOCK_MODULE_PATH;

  const cellNames =
    args.cells === "all"
      ? Object.keys(CELL_DEFS)
      : args.cells.split(",").map((c) => c.trim());
  for (const spec of cellNames) {
    const [name, entrants, trials] = spec.split(":");
    CELL_ARGS[name] = `${entrants || 3}:${trials || 10}`;
  }

  const dir = mkdtempSync(join(tmpdir(), "hyk494-probe-"));
  const results = [];
  try {
    for (const spec of cellNames) {
      const [name] = spec.split(":");
      const def = CELL_DEFS[name];
      if (!def) throw new Error(`unknown cell: ${name}`);
      const result = await runCell(name, def, {
        lockModule: resolvedLockModule,
        dir,
      });
      results.push(result);
      console.log(
        `cell=${result.cell} entrants=${result.entrants} trials=${result.trials} ` +
          `overlap_trials=${result.overlap_trials} exclusion_failures=${result.exclusion_failures} ` +
          `owners_max=${result.owners_max} lock_left=${result.lock_left} ` +
          `reclaim_reasons=${JSON.stringify(result.reclaim_reasons)} lost=${result.lost} timedOut=${result.timedOut}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (args.jsonOut) {
    writeFileSync(
      args.jsonOut,
      JSON.stringify({ lockModule: resolvedLockModule, results }, null, 2),
    );
  }
}

await main();
