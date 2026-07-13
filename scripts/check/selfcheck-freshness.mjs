import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// Same 8-day window selfcheck-inventory.mjs's own canary-receipt staleness
// check uses (DEFAULT_CANARY_MAX_AGE_MS) -- one number, one place, matching
// the PM design report §6's own "8일 초과 시 부팅 알림" bootstrap mitigation.
export const DEFAULT_FRESHNESS_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

const CAPTURED_AT_RE = /^captured_at:\s*(.+)$/m;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// Pure function: text/time in, verdict out -- same shape as every other
// checker in this repo. `fresh: false` covers three distinct causes (report
// absent, captured_at missing/unparseable, or older than maxAgeMs); `reason`
// always says which, so a human/ORCH reading the warning knows what to do
// next (run selfcheck.mjs at all, vs. re-run it because it's stale).
export function checkSelfcheckFreshness({
  reportPath,
  now = Date.now(),
  maxAgeMs = DEFAULT_FRESHNESS_MAX_AGE_MS,
  readFileFn = (p) => readFileSync(p, "utf8"),
  existsFn = existsSync,
}) {
  if (!existsFn(reportPath)) {
    return { fresh: false, reason: `no selfcheck report found at '${reportPath}' -- selfcheck.mjs has never been run (or its output was moved/deleted)`, capturedAt: null };
  }

  let text;
  try {
    text = readFileFn(reportPath);
  } catch (err) {
    // Unreadable is uncertain, not confirmed-stale -- but this check is
    // advisory-only either way (never blocks), so treat it the same as
    // "warn, fail open on the crash risk, never throw."
    return { fresh: false, reason: `selfcheck report '${reportPath}' could not be read (${err.message})`, capturedAt: null };
  }

  const match = text.match(CAPTURED_AT_RE);
  if (!match) {
    return { fresh: false, reason: `selfcheck report '${reportPath}' has no captured_at field -- malformed report`, capturedAt: null };
  }

  const capturedAt = match[1].trim();
  const capturedAtMs = Date.parse(capturedAt);
  if (Number.isNaN(capturedAtMs)) {
    return { fresh: false, reason: `selfcheck report's captured_at ('${capturedAt}') is not a parseable timestamp`, capturedAt };
  }

  const ageMs = now - capturedAtMs;
  // review-5 caught this omission: a future captured_at (clock skew, a
  // hand-edited/corrupt report, or a bug in whatever wrote it) previously
  // computed a *negative* age, which is always <= maxAgeMs and so read as
  // "fresh" -- letting a bad report suppress the 8-day warning forever
  // rather than triggering it. Any captured_at after `now` at all (even by
  // 1ms) is treated as suspect, not "impossibly fresh."
  if (ageMs < 0) {
    return {
      fresh: false,
      reason: `selfcheck report's captured_at (${capturedAt}) is in the future -- report clock suspect, re-run selfcheck`,
      capturedAt,
    };
  }
  if (ageMs > maxAgeMs) {
    return {
      fresh: false,
      reason: `selfcheck last ran ${Math.round(ageMs / 86400000)}d ago (captured_at=${capturedAt}, max ${Math.round(maxAgeMs / 86400000)}d) -- re-run node scripts/check/selfcheck.mjs`,
      capturedAt,
    };
  }

  return { fresh: true, reason: `selfcheck fresh (captured_at=${capturedAt}, ${Math.round(ageMs / 86400000)}d ago)`, capturedAt };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/selfcheck-freshness.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let reportPath = process.env.HARNESS_SELFCHECK_REPORT_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--report") reportPath = args[++i];
  }
  reportPath = reportPath || join(repoRoot(), ".harness", "selfcheck-report.md");

  const result = checkSelfcheckFreshness({ reportPath });

  // Advisory only, always exit 0 -- a stale/missing selfcheck report must
  // never block session start (this is a reminder, not a gate; the same
  // severity posture as status-fresh.mjs's own Stop-hook contract).
  if (!result.fresh) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `⚠️ selfcheck-freshness: ${result.reason} -- 주간 점검 실행 권장(HYK-129).`,
        },
      }),
    );
  } else {
    console.log(`selfcheck-freshness: ${result.reason}`);
  }
  process.exit(0);
}
