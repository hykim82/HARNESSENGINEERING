// HYK-257 ⓐ -- the ONE supported machine-clock producer for a task file's
// `dropped_at` header. Mirrors finalize-done.mjs's (HYK-186) contract
// exactly, reused for the drop-time field: it refuses any caller-supplied
// timestamp outright and always stamps the machine clock (Date.now()) at
// the moment it is called. This is the "B 원칙" (HYK-186) applied to the
// second of the two hand-typed timestamps named in coder-task.md §1 --
// `dropped_at` had been selfishly hand-typed by ORCH 4 times (08-12~08-14),
// producing an "estimate, not a reading" value that relay-handshake.mjs's
// future-skew check caught every time, at the cost of a lost round.
//
// ⚠️정직 한계 (§3 "절대 주장 금지"): this script does not and cannot stop a
// human or an AI from hand-typing `dropped_at: <any time>` directly into a
// task file (Edit tool, a text editor, ...) -- same filesystem, same OS
// permissions, unverifiable at this layer. What it guarantees is narrower:
// any value produced THROUGH this script is read from its own clock, never
// from an argument that asked it to write something else.
//
// ⚠️결선 한계 (coder-task.md §2 제약1 비타협): this round does not wire this
// script into 관제실 dispatch-worker.ps1 (그 파일은 이 라운드에서 수정
// 금지) -- the exact call the wrapper should make is documented in
// .harness/coder.md (결과 파일) for ORCH to review and wire separately.
//
// Engine independence (coder-task.md §2 제약5): plain Node CLI, invokable as
// `node scripts/relay/stamp-dropped-at.mjs` from any shell/cron/CI step --
// nothing here depends on a Claude Code hook or any Claude-specific runtime.

function pad(n) {
  return String(n).padStart(2, "0");
}

// KST has no DST -- a fixed +9h offset from UTC is exact and stable, unlike
// relying on the host machine's local timezone setting (same rationale as
// finalize-done.mjs's own formatKst). Minute precision, no seconds --
// dropped_at's registered formatPrecision (scripts/check/time-authority.mjs)
// and task-drop-core.mjs's DROPPED_AT_FORMAT_RE both expect exactly this
// shape ("YYYY-MM-DD HH:MM KST").
function formatKstMinute(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} KST`;
}

export const STAMP_DROPPED_AT_REASON = Object.freeze({
  CALLER_SUPPLIED_TIME_REJECTED: "CALLER_SUPPLIED_TIME_REJECTED",
  STAMPED: "STAMPED",
});

// stampDroppedAt({ callerSuppliedAt, nowFn }) -> { ok, reasonCode, reason?, value?, nowMs? }
//
// `callerSuppliedAt`: MUST be omitted (undefined). Passing anything else --
// a string, a Date, a number, even a value equal to what the machine clock
// would have produced anyway -- is refused outright, mirroring
// finalize-done.mjs's `callerSuppliedAt` contract exactly: this producer
// does not read a caller-supplied time argument at all.
export function stampDroppedAt({
  callerSuppliedAt,
  nowFn = () => Date.now(),
} = {}) {
  if (callerSuppliedAt !== undefined) {
    return {
      ok: false,
      reasonCode: STAMP_DROPPED_AT_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      reason:
        "stamp-dropped-at rejects caller-supplied timestamps -- this producer always records its own machine clock (Date.now()) at stamp time; do not pass callerSuppliedAt",
    };
  }
  const nowMs = nowFn();
  return {
    ok: true,
    reasonCode: STAMP_DROPPED_AT_REASON.STAMPED,
    value: formatKstMinute(nowMs),
    nowMs,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/stamp-dropped-at.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  // No `--at`/timestamp-shaped flag is recognized at all -- mirrors
  // finalize-done.mjs's CLI: refuses even the ATTEMPT to pass a time, on
  // sight, before anything else runs.
  const timeFlagAttempt = args.find(
    (a) => a === "--at" || a.startsWith("--at="),
  );
  if (timeFlagAttempt) {
    console.error(
      `stamp-dropped-at rejects caller-supplied timestamps: '${timeFlagAttempt}' is not a supported flag (this CLI never accepts a time argument)`,
    );
    process.exit(1);
  }
  const result = stampDroppedAt({});
  console.log(`DROPPED_AT: ${result.value}`);
  process.exit(0);
}
