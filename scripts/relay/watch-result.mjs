import { checkRelayHandshake } from "../check/relay-handshake.mjs";

// Single declarations (C.7): every default and every exit code this module
// hands out traces back to exactly one of these, never a repeated literal.
export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_KEEPALIVE_S = 240;
export const EXIT_DONE = 0;
export const EXIT_TICK = 3;
// HYK-136: distinct from EXIT_DONE(0)/EXIT_TICK(3) -- a confirmed config
// error must never be reported the same way as either "done" or "still
// waiting," or a caller script branching on exit code alone (the 07-14/17
// incident: PM DONE went undetected because a malformed --harness-dir
// silently fell back to the wrong directory and just kept ticking forever).
export const EXIT_CONFIG_INVALID = 4;
// HYK-160-coder-2 (review-1 결함 1 수리): a reason outside the fixed
// CONFIG/PENDING pattern lists means this module genuinely does not know
// whether waiting helps -- design §3.1 requires that state to be reported
// as UNJUDGABLE and NOT retried forever. coder-1 silently folded
// "unjudgable" into the same "keep polling" bucket as "pending," so a
// checkRelayHandshake reason string this module's fixtures don't cover
// (e.g. a future parser change) polled indefinitely with no exit path at
// all in plain mode (maxWaitS=0) -- exactly the review-1 repro
// (`watchResult({maxWaitS:1, checkFn:() => ({ok:false,
// reason:'unexpected handshake parser shape'})})` never terminated).
export const EXIT_UNJUDGABLE = 5;

// checkRelayHandshake's `ok:false` reasons fall into three families this
// module must never confuse (HYK-136/HYK-160-coder-2 게이트 계약): a CONFIG
// reason means the inputs themselves are wrong -- no amount of waiting
// fixes a task file that doesn't exist or has no task_id header, so
// polling on it forever is a silent hang, not patience. A PENDING reason
// means the inputs are fine and the worker just hasn't finished yet -- the
// normal, expected wait state, safe to keep polling. Anything not matching
// either list is UNJUDGABLE (honesty: this module does not claim to
// classify every possible checkRelayHandshake failure string, only the
// ones its own known-bad/good fixtures cover) and MUST terminate the loop
// with its own distinct status/exit rather than being silently treated as
// either safe-to-retry pending or a confirmed config error.
const CONFIG_REASON_PATTERNS = [
  /^task file not found/,
  /^task file missing task_id header/,
  /^task file missing dropped_at header/,
  /^task dropped_at not parseable/,
];
const PENDING_REASON_PATTERNS = [
  /^result file not found/,
  /^handshake mismatch/,
  /^result missing ">>> DONE/,
  /^stale result/,
];

export function classifyWatchFailure(reason) {
  if (typeof reason !== "string") return "unjudgable";
  if (CONFIG_REASON_PATTERNS.some((re) => re.test(reason))) return "config";
  if (PENDING_REASON_PATTERNS.some((re) => re.test(reason))) return "pending";
  return "unjudgable";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One checkFn result -> either a terminal loop outcome (done/config/
// unjudgable) or null ("keep polling" -- only for a genuinely transient
// checkFn throw or a classified-pending reason). Extracted from
// watchResult's own loop body (quality-check: keeps watchResult's own
// complexity under the repo's ESLint ceiling).
//
// `result.threw` (set only by runCheck's catch branch below) is the one
// case that bypasses classification entirely: a thrown error is a
// transient read failure, not a reason string at all, and this module's
// existing contract ("checkFn throwing is treated the same as an `ok:
// false` result... a transient error mid-poll is not done yet, not a
// crash") must keep polling through it -- never terminate on a throw the
// way a classified-unjudgable *reason* now does (review-1 결함 1's fix
// does not change throw-handling, only clean ok:false reasons).
function resolveCheckOutcome(result, elapsedS) {
  if (result.ok) {
    return { status: "done", reason: result.reason, elapsedS };
  }
  if (result.threw) {
    return null;
  }
  const classification = classifyWatchFailure(result.reason);
  if (classification === "config") {
    return {
      status: "config",
      reason: `WATCH_CONFIG_INVALID: ${result.reason}`,
      elapsedS,
    };
  }
  if (classification === "unjudgable") {
    return {
      status: "unjudgable",
      reason: `WATCH_UNJUDGABLE: ${result.reason}`,
      elapsedS,
    };
  }
  return null;
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
      return {
        ok: false,
        reason: `checkFn threw (treated as not done): ${err.message}`,
        threw: true,
      };
    }
  }

  // Immediate check before any sleep: a worker that was already done when
  // this loop started should exit on the spot, not wait a full interval
  // for no reason. Same immediacy applies to a confirmed config error --
  // fail-fast, never wait a tick to report a problem waiting can't solve.
  let outcome = resolveCheckOutcome(runCheck(), 0);
  if (outcome) return outcome;

  for (;;) {
    await sleepFn(intervalS * 1000);
    const elapsedS = Math.round((nowFn() - startedAt) / 1000);

    outcome = resolveCheckOutcome(runCheck(), elapsedS);
    if (outcome) return outcome;

    if (maxWaitS > 0 && elapsedS >= maxWaitS) {
      return {
        status: "tick",
        reason: `${role} not done after ${elapsedS}s (keep-alive tick)`,
        elapsedS,
      };
    }
  }
}

// Recognized space-separated flags only -- an `--flag=value` token (the
// 07-14/17 incident's actual shape: `--harness-dir=/some/path`) matches none
// of the `===` comparisons below and was previously silently ignored,
// leaving harnessDir undefined and the watcher pointed at the wrong default
// directory with no error at all. Detecting the unsupported shape up front
// and refusing immediately closes that hole; a caller must switch to the
// supported space-separated form (`--harness-dir /some/path`) instead.
const KNOWN_FLAGS = new Set([
  "--role",
  "--interval-s",
  "--max-wait-s",
  "--harness-dir",
]);

// Pure parse function (exported for tests, same testability convention as
// watchResult's injected checkFn/sleepFn/nowFn): never touches process.argv
// or process.exit itself, just turns argv into either a parsed options
// object or a config error.
export function parseWatchArgs(args) {
  let role;
  let intervalS = DEFAULT_INTERVAL_S;
  let maxWaitS = DEFAULT_KEEPALIVE_S;
  let harnessDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      const flagName = arg.slice(0, arg.indexOf("="));
      return {
        ok: false,
        reason: `unsupported '${flagName}=value' syntax ('${arg}') -- use '${flagName} value' (space-separated) instead`,
      };
    }
    if (arg.startsWith("--") && !KNOWN_FLAGS.has(arg)) {
      return { ok: false, reason: `unrecognized flag '${arg}'` };
    }
    if (arg === "--role") role = args[++i];
    else if (arg === "--interval-s") intervalS = Number(args[++i]);
    else if (arg === "--max-wait-s") maxWaitS = Number(args[++i]);
    else if (arg === "--harness-dir") harnessDir = args[++i];
  }
  return { ok: true, role, intervalS, maxWaitS, harnessDir };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/watch-result.mjs");
if (invokedDirectly) {
  const parsed = parseWatchArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`WATCH_CONFIG_INVALID: ${parsed.reason}`);
    process.exit(EXIT_CONFIG_INVALID);
  }
  const { role, intervalS, maxWaitS, harnessDir } = parsed;

  if (!role) {
    console.error(
      "usage: node watch-result.mjs --role <coder|review|verify> [--interval-s <n>] [--max-wait-s <n>] [--harness-dir <path>]",
    );
    process.exit(1);
  }

  const result = await watchResult({ role, harnessDir, intervalS, maxWaitS });
  if (result.status === "done") {
    console.log(`RESULT: ${role} done (${result.reason})`);
    process.exit(EXIT_DONE);
  } else if (result.status === "config") {
    console.error(result.reason);
    process.exit(EXIT_CONFIG_INVALID);
  } else if (result.status === "unjudgable") {
    console.error(result.reason);
    process.exit(EXIT_UNJUDGABLE);
  } else {
    console.log(`TICK: ${result.reason}`);
    process.exit(EXIT_TICK);
  }
}
