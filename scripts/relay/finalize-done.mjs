// HYK-186 §2 완료조건2 -- the ONE supported normal producer for a result
// file's '>>> DONE:' line. Its whole contract is negative: it refuses any
// caller-supplied timestamp outright and always records the machine clock
// (Date.now()) at the moment it writes.
//
// ⚠️정직 한계 (§3 "절대 주장 금지"): this script does not and cannot prevent
// a human or an AI worker from hand-editing `<role>.md` and typing a
// '>>> DONE: ... @ <any time>' line directly (Edit tool, a text editor, `echo
// >>`, ...) -- same filesystem, same OS permissions, unverifiable at this
// layer. What this script DOES guarantee: any completion recorded THROUGH
// this supported path carries a timestamp this process itself read from its
// own clock, never one an argument asked it to write. It is the "명시 사유로
// 차단" half of §2's contract -- callerSuppliedAt !== undefined is refused
// with FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED, not silently
// accepted or silently ignored.
//
// Engine independence (§3 완료조건7): this is a plain Node CLI, invokable as
// `node scripts/relay/finalize-done.mjs <role> [harnessDir]` from any shell,
// cron job, or CI step -- nothing here depends on a Claude Code hook or any
// Claude-specific runtime. finalize-done.test.mjs's CLI-spawn tests exercise
// exactly this non-Claude path.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DONE_LINE_RE = /^>>>\s*DONE:/im;

function pad(n) {
  return String(n).padStart(2, "0");
}

// KST has no DST -- a fixed +9h offset from UTC is exact and stable, unlike
// relying on the host machine's local timezone setting.
function formatKst(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(
    kst.getUTCSeconds(),
  )} KST`;
}

export const FINALIZE_DONE_REASON = Object.freeze({
  CALLER_SUPPLIED_TIME_REJECTED: "CALLER_SUPPLIED_TIME_REJECTED",
  ROLE_INVALID: "ROLE_INVALID",
  HARNESS_DIR_INVALID: "HARNESS_DIR_INVALID",
  RESULT_FILE_NOT_FOUND: "RESULT_FILE_NOT_FOUND",
  ALREADY_FINALIZED: "ALREADY_FINALIZED",
  FINALIZED: "FINALIZED",
});

// finalizeDone({ role, harnessDir, callerSuppliedAt, nowFn }) ->
// { ok, reasonCode, reason, line?, nowMs? }
//
// `callerSuppliedAt`: MUST be omitted (undefined). Passing anything else --
// a string, a Date, a number, even a value equal to what the machine clock
// would have produced anyway -- is refused outright. There is no "accept if
// it matches now" leniency: the contract is "this producer does not read a
// caller-supplied time argument at all", not "this producer validates a
// caller-supplied time argument".
export function finalizeDone({
  role,
  harnessDir,
  callerSuppliedAt,
  nowFn = () => Date.now(),
} = {}) {
  if (callerSuppliedAt !== undefined) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      reason:
        "finalize-done rejects caller-supplied timestamps -- this producer always records its own machine clock (Date.now()) at finalization time; do not pass callerSuppliedAt",
    };
  }
  if (typeof role !== "string" || role.length === 0) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ROLE_INVALID,
      reason: "role must be a non-empty string",
    };
  }
  if (typeof harnessDir !== "string" || harnessDir.length === 0) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.HARNESS_DIR_INVALID,
      reason: "harnessDir must be a non-empty string",
    };
  }

  const resultPath = join(harnessDir, `${role}.md`);
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.RESULT_FILE_NOT_FOUND,
      reason: `result file not found: ${resultPath}`,
    };
  }

  const existing = readFileSync(resultPath, "utf8");
  if (DONE_LINE_RE.test(existing)) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ALREADY_FINALIZED,
      reason: `result file already has a '>>> DONE:' line -- finalize-done never overwrites (${resultPath})`,
    };
  }

  const nowMs = nowFn();
  const separator = existing.endsWith("\n") ? "" : "\n";
  const line = `>>> DONE: ${role.toUpperCase()} @ ${formatKst(nowMs)}`;
  appendFileSync(resultPath, `${separator}${line}\n`, "utf8");

  return {
    ok: true,
    reasonCode: FINALIZE_DONE_REASON.FINALIZED,
    reason: `wrote '${line}' to ${resultPath}`,
    line,
    nowMs,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/finalize-done.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  // No `--at`/timestamp-shaped flag is recognized at all -- unlike
  // watch-result.mjs's KNOWN_FLAGS allowlist (which accepts and validates
  // known flags), this CLI refuses even the ATTEMPT to pass a time, on sight.
  const timeFlagAttempt = args.find(
    (a) => a === "--at" || a.startsWith("--at="),
  );
  if (timeFlagAttempt) {
    console.error(
      `finalize-done rejects caller-supplied timestamps: '${timeFlagAttempt}' is not a supported flag (this CLI never accepts a time argument)`,
    );
    process.exit(1);
  }
  const [role, harnessDirArg] = args;
  if (!role) {
    console.error("usage: node finalize-done.mjs <role> [harnessDir]");
    process.exit(1);
  }
  const harnessDir = harnessDirArg ?? join(process.cwd(), ".harness");
  const result = finalizeDone({ role, harnessDir });
  if (result.ok) {
    console.log(`FINALIZED: ${result.line}`);
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(1);
}
