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

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// HYK-324/HYK-325 §2-1: reuse relay-handshake.mjs's own "well-formed DONE
// line" contract (DONE_RE + hasDoneSecondsPrecision) instead of inventing a
// second copy that could silently drift -- coder-task.md §2-1's explicit
// instruction. relay-handshake.mjs already exports both for this reason.
import { DONE_RE, hasDoneSecondsPrecision } from "../check/relay-handshake.mjs";

const DONE_LINE_RE = /^>>>\s*DONE:/im;
// HYK-325 §2-1 (2회째 교체 금지): once finalizeDone has replaced one
// malformed stamp, this marker is what stops it from doing so a second
// time -- see the ALREADY_REPLACED branch below.
const SUPERSEDED_DONE_RE = /^superseded_done:/im;
// HYK-325 §2-3: appended on the line right after every '>>> DONE:' line
// this producer writes (both the normal path and the malformed-replace
// path) -- a non-column-0 meta line, so it is never mistaken for the
// '>>> DONE:' line itself by any parser (DONE_LINE_RE/DONE_RE both anchor
// on '>>>' at column 0). relay-handshake.mjs's warnIfMissingFinalizeDoneMarker
// reads this same literal text -- keep the two in sync.
export const FINALIZE_DONE_MARKER_LINE = "done_stamped_by: finalize-done";

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
  // HYK-324/HYK-325 §2-1: a single malformed (e.g. minute-precision)
  // '>>> DONE:' line was found and replaced, exactly once.
  REPLACED_MALFORMED: "REPLACED_MALFORMED",
  // HYK-325 §2-1: a malformed line was already replaced once before --
  // refuses to replace again (no infinite re-issue).
  ALREADY_REPLACED: "ALREADY_REPLACED",
});

// Extracted from finalizeDone (ESLint max-lines-per-function/complexity
// ceiling, HYK-148 house rule) -- decides what to do with a result file
// that ALREADY has a '>>> DONE:' line: replace it once (malformed, not yet
// replaced), refuse a second replace (ALREADY_REPLACED), or refuse outright
// (ALREADY_FINALIZED, the pre-HYK-324/325 behavior, unchanged for a
// format-valid stamp). Returns the finalizeDone-shaped result object;
// finalizeDone below only decides WHETHER to call this (does a DONE line
// exist at all) and performs the actual write.
//
// HYK-324/HYK-325 §2-1: a '>>> DONE:' line already exists -- decide
// whether it's format-valid (reuse relay-handshake.mjs's own seconds-
// precision contract, per coder-task.md §2-1's explicit "don't invent a
// new criterion" instruction) or eligible for a ONE-TIME replace. Only the
// exact shape this repo actually hits (exactly one DONE_RE match, missing
// seconds precision) is treated as malformed-and-replaceable; anything
// else (zero matches despite the loose DONE_LINE_RE test, or more than one
// DONE_RE match/ambiguous) falls back to the existing, conservative
// ALREADY_FINALIZED refusal -- this producer never guesses which line to
// touch when it can't tell.
function resolveExistingDoneLine({ existing, resultPath, role, nowFn }) {
  // Checked BEFORE the malformed/valid split below: a file that already
  // underwent one replace must never be replaced again, regardless of
  // whether its CURRENT '>>> DONE:' line happens to look valid or
  // malformed -- the marker alone is what "already replaced" means.
  if (SUPERSEDED_DONE_RE.test(existing)) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ALREADY_REPLACED,
      reason: `result file's malformed '>>> DONE:' line was already replaced once -- finalize-done only replaces a malformed stamp a single time (${resultPath})`,
    };
  }

  const doneMatches = [...existing.matchAll(DONE_RE)];
  const malformedSingle =
    doneMatches.length === 1 && !hasDoneSecondsPrecision(doneMatches[0][1]);

  if (!malformedSingle) {
    return {
      ok: false,
      reasonCode: FINALIZE_DONE_REASON.ALREADY_FINALIZED,
      reason: `result file already has a '>>> DONE:' line -- finalize-done never overwrites (${resultPath})`,
    };
  }

  const supersededLine = doneMatches[0][0];
  const nowMs = nowFn();
  const line = `>>> DONE: ${role.toUpperCase()} @ ${formatKst(nowMs)}`;
  // Preserve the original malformed line verbatim as a non-column-0
  // `superseded_done:` body line (never counted as a '>>> DONE:' cover
  // line by any parser -- DONE_LINE_RE/DONE_RE both anchor on '>>>' at
  // column 0, and this replacement text starts with 'superseded_done:')
  // then append the machine-stamped replacement, same as the normal path.
  const withSuperseded = existing.replace(
    supersededLine,
    `superseded_done: ${supersededLine}`,
  );
  const separator = withSuperseded.endsWith("\n") ? "" : "\n";
  writeFileSync(
    resultPath,
    `${withSuperseded}${separator}${line}\n${FINALIZE_DONE_MARKER_LINE}\n`,
    "utf8",
  );

  return {
    ok: true,
    reasonCode: FINALIZE_DONE_REASON.REPLACED_MALFORMED,
    reason: `replaced malformed '>>> DONE:' line ('${supersededLine}') with machine-stamped '${line}' in ${resultPath} (original preserved as 'superseded_done:')`,
    line,
    supersededLine,
    nowMs,
  };
}

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
    return resolveExistingDoneLine({ existing, resultPath, role, nowFn });
  }

  const nowMs = nowFn();
  const separator = existing.endsWith("\n") ? "" : "\n";
  const line = `>>> DONE: ${role.toUpperCase()} @ ${formatKst(nowMs)}`;
  appendFileSync(
    resultPath,
    `${separator}${line}\n${FINALIZE_DONE_MARKER_LINE}\n`,
    "utf8",
  );

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
    // HYK-324/HYK-325 §2-1: distinguish "replaced a malformed stamp" from
    // a plain first-time finalize on stdout, so a caller/operator watching
    // the log can tell a replace happened without inspecting the file.
    if (result.reasonCode === FINALIZE_DONE_REASON.REPLACED_MALFORMED) {
      console.log(
        `REPLACED_MALFORMED: ${result.line} (superseded: ${result.supersededLine})`,
      );
    } else {
      console.log(`FINALIZED: ${result.line}`);
    }
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(1);
}
