import { checkRelayHandshake } from "../check/relay-handshake.mjs";

// Single declarations (C.7): every default and every exit code this module
// hands out traces back to exactly one of these, never a repeated literal.
export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_KEEPALIVE_S = 240;
export const EXIT_DONE = 0;
export const EXIT_TICK = 3;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// role/harnessDir: passed straight through to checkFn (default
// checkRelayHandshake -- role is the file-prefix form, e.g. "coder",
// matching `<role>-task.md`/`<role>.md`; harnessDir omitted lets
// checkRelayHandshake fall back to its own repo-root-relative default).
//
// intervalS: seconds between polls. maxWaitS: keep-alive tick threshold in
// seconds; 0 disables it entirely ("plain mode" -- poll indefinitely until
// done, meant for an unattended/away session with no ORCH turn to wake up).
//
// checkFn/sleepFn/nowFn: injection points, same rationale as every other
// check script's testability parameters (status-fresh.mjs's `headTime`,
// controlroom-fresh.mjs's `isGitRepoFn`/etc) -- a test drives the loop with
// a fake clock and a no-op sleep instead of waiting on real timers.
// checkFn throwing is treated the same as an `ok: false` result (a
// transient error mid-poll is "not done yet", not a crash) -- distinguishing
// error causes is left to whatever reads the loop's final report, not this
// loop itself.
export async function watchResult({
  role,
  harnessDir,
  intervalS = DEFAULT_INTERVAL_S,
  maxWaitS = DEFAULT_KEEPALIVE_S,
  checkFn = checkRelayHandshake,
  sleepFn = defaultSleep,
  nowFn = () => Date.now(),
} = {}) {
  const startedAt = nowFn();

  function runCheck() {
    try {
      return checkFn({ role, harnessDir });
    } catch (err) {
      return { ok: false, reason: `checkFn threw (treated as not done): ${err.message}` };
    }
  }

  // Immediate check before any sleep: a worker that was already done when
  // this loop started should exit on the spot, not wait a full interval
  // for no reason.
  let result = runCheck();
  if (result.ok) {
    return { status: "done", reason: result.reason, elapsedS: 0 };
  }

  for (;;) {
    await sleepFn(intervalS * 1000);
    const elapsedS = Math.round((nowFn() - startedAt) / 1000);

    result = runCheck();
    if (result.ok) {
      return { status: "done", reason: result.reason, elapsedS };
    }

    if (maxWaitS > 0 && elapsedS >= maxWaitS) {
      return { status: "tick", reason: `${role} not done after ${elapsedS}s (keep-alive tick)`, elapsedS };
    }
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/relay/watch-result.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let role;
  let intervalS = DEFAULT_INTERVAL_S;
  let maxWaitS = DEFAULT_KEEPALIVE_S;
  let harnessDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--role") role = args[++i];
    else if (args[i] === "--interval-s") intervalS = Number(args[++i]);
    else if (args[i] === "--max-wait-s") maxWaitS = Number(args[++i]);
    else if (args[i] === "--harness-dir") harnessDir = args[++i];
  }

  if (!role) {
    console.error("usage: node watch-result.mjs --role <coder|review|verify> [--interval-s <n>] [--max-wait-s <n>] [--harness-dir <path>]");
    process.exit(1);
  }

  const result = await watchResult({ role, harnessDir, intervalS, maxWaitS });
  if (result.status === "done") {
    console.log(`RESULT: ${role} done (${result.reason})`);
    process.exit(EXIT_DONE);
  } else {
    console.log(`TICK: ${result.reason}`);
    process.exit(EXIT_TICK);
  }
}
