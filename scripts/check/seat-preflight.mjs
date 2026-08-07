// Seat launch admission check (HYK-200). Fail-closed gate meant to be
// invoked by the control-room seat launcher BEFORE a worker seat is started
// (coder-task.md §1: "0이 아니면 좌석을 아예 띄우지 않는다"). This device
// does not decide anything new -- it wraps the already-merged
// hook-sync-check.mjs (HYK-196) core/IO and turns its verdict into (a) a
// human-readable message a person reads on the seat screen and (b) an exit
// code the launcher branches on. Comparison logic itself is NOT
// reimplemented here (coder-task.md §3 "대조 로직을 새로 쓰지 마라") --
// judgeHookSync/buildEntries/resolveInstalledDir all live in
// hook-sync-check.mjs and are reused as-is via runHookSyncCheck.
import { runHookSyncCheck } from "./hook-sync-check.mjs";

// The one copy-pasteable line this device ever tells a human to run. Kept as
// a single exported constant so the CLI output and the test suite that
// asserts its presence can never drift from each other.
export const FIX_COMMAND = "node scripts/check/hook-sync-check.mjs --install";

// ---------------------------------------------------------------------------
// Judgment: verdict -> { canLaunch, exitCode }. Exit code contract
// (coder-task.md §3, documented here as the single source of truth):
//   0 = IN_SYNC      -- seat may launch
//   2 = DRIFT         -- seat launch BLOCKED, a fix command exists
//   1 = UNDECIDABLE   -- seat launch BLOCKED, judgment itself failed
// Neither non-IN_SYNC branch is ever allowed to collapse to 0 -- that is the
// fail-closed contract §2-1 states explicitly ("설계 = 차단. 관측·경고가
// 아니다").
// ---------------------------------------------------------------------------
export function admissionFor(verdict) {
  if (verdict === "IN_SYNC") return { canLaunch: true, exitCode: 0 };
  if (verdict === "DRIFT") return { canLaunch: false, exitCode: 2 };
  return { canLaunch: false, exitCode: 1 };
}

// Runs the reused hook-sync-check device and folds its result into this
// device's own admission decision. `cwd` is the seat's worktree (the
// launcher runs this FROM the worktree it is about to start a seat in) --
// left injectable so tests can point it at synthetic fixtures instead of
// this real repo's own hooks.
export function evaluateSeatPreflight({ cwd = process.cwd() } = {}) {
  const result = runHookSyncCheck({ cwd });
  const admission = admissionFor(result.verdict);
  return { ...result, ...admission };
}

// Human-readable report (coder-task.md §3 "출력 요건"): what drifted (file +
// kind), and the exact command that fixes it -- terse, meant for a seat
// screen, not a log dump.
export function formatReport(result) {
  if (result.verdict === "IN_SYNC") {
    return `seat-preflight: PASS -- installed hooks (${result.resolvedInstalledDir}) match versioned hooks/. 좌석 기동 가능.`;
  }
  if (result.verdict === "DRIFT") {
    const lines = result.mismatches.map((m) => `  DRIFT ${m.name} (${m.kind})`);
    return [
      "seat-preflight: BLOCK -- installed hooks drifted from versioned hooks/. 좌석 기동 금지.",
      ...lines,
      `고치는 명령: ${FIX_COMMAND}`,
    ].join("\n");
  }
  // UNDECIDABLE -- no fix command exists (the judgment itself failed, not a
  // known drift), so this branch intentionally never prints FIX_COMMAND.
  return [
    "seat-preflight: BLOCK -- 판정 불가(UNDECIDABLE). 좌석 기동 금지.",
    `  reason: ${result.reason ?? "unknown"}`,
  ].join("\n");
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-preflight.mjs");
if (invokedDirectly) {
  const result = evaluateSeatPreflight({});
  console.log(formatReport(result));
  process.exit(result.exitCode);
}
