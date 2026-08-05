import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { recordRejectStreakFromResultText } from "./reject-streak.mjs";

// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). TASK_ID_RE(과거: 첫 매치 채택)와 DONE_RE(과거: 마지막 매치
// 채택)가 서로 반대 방향을 조용히 골랐던 것이 이 수리의 대상이다.
const TASK_ID_RE = /^task_id:\s*(\S+)/im;
const TASK_ID_RE_G = /^task_id:\s*(\S+)/gim;
// HYK-180 사이클1: the anchored TASK_ID_RE only matches a standalone
// `task_id: <id>` line at column 0. When it fails to match, this
// unanchored variant tells apart two very different failure shapes: no
// `task_id:` token anywhere (genuinely absent, worker still writing --
// pending) vs a `task_id:` token that exists but isn't a standalone line
// (e.g. `for: X / task_id: Y / role: Z` -- a structural violation that no
// amount of waiting fixes). Never used to accept a match; only to produce
// a distinct diagnosis for the latter case.
const TASK_ID_ANYWHERE_RE = /task_id:\s*(\S+)/i;
const DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
const DONE_RE = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

// HYK-183 §2 R2: the reject-streak ledger must live in ONE place -- the
// main repo -- no matter which worktree relay-handshake.mjs happens to run
// from (a per-worktree ledger silently reads streak=0 forever, per
// reject-streak.mjs's own module header on the 2026-07-26 실측). Mirrors
// hooks/commit-msg's own worktree -> main-clone resolution idiom rather
// than inventing a new one: resolve this cwd's own toplevel, then ask git
// for `--git-common-dir` (absolute when cwd is a linked worktree, relative
// "`.git`" when cwd already IS the main worktree) and strip the trailing
// "/.git" to land back on the main clone's root.
// HYK-183-ledger-fix (축 B): exported so review-gate.mjs (the commit-msg
// hook's script) can resolve the SAME centralized ledger location when it
// records an approval -- see that module's own header for why the approval
// path needs this at all.
export function mainRepoRoot() {
  const root = repoRoot();
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf8",
      cwd: root,
    }).trim();
    const absCommonDir = /^([A-Za-z]:[\\/]|\/)/.test(commonDir)
      ? commonDir
      : join(root, commonDir);
    return absCommonDir.replace(/[\\/]\.git$/, "");
  } catch {
    return root;
  }
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity under the repo's ESLint ceiling) -- resolves the result
// file's task_id echo into either a match or one of two distinct
// diagnoses for the anchored-miss case (see TASK_ID_ANYWHERE_RE above).
function resolveResultTaskId(resultContent) {
  const resultIdMatches = [...resultContent.matchAll(TASK_ID_RE_G)];
  if (resultIdMatches.length > 1) {
    return {
      ok: false,
      reason: `result has ${resultIdMatches.length} standalone 'task_id:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (resultIdMatches.length === 1) {
    return { ok: true, id: resultIdMatches[0][1] };
  }
  if (TASK_ID_ANYWHERE_RE.test(resultContent)) {
    return {
      ok: false,
      reason:
        "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
    };
  }
  return {
    ok: false,
    reason: "result missing task_id echo (need a `task_id: <id>` line)",
  };
}

// Extracted from checkRelayHandshake (keeps its complexity under the
// repo's ESLint ceiling) -- mirrors resolveResultTaskId's shape: resolves
// the result file's '>>> DONE:' line into either a single match or an
// explicit ambiguity/absence reason, never a silently-chosen one.
function resolveResultDoneMatch(resultContent) {
  const doneMatches = [...resultContent.matchAll(DONE_RE)];
  if (doneMatches.length > 1) {
    return {
      ok: false,
      reason: `result has ${doneMatches.length} '>>> DONE:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (doneMatches.length === 1) {
    return { ok: true, match: doneMatches[0] };
  }
  return {
    ok: false,
    reason: 'result missing ">>> DONE: ... @ <time KST>" line (required)',
  };
}

// Extracted from checkRelayHandshake (keeps its complexity under the
// repo's ESLint ceiling) -- surfaces recordRejectStreakFromResultText's
// outcome via console.log/console.error rather than swallowing it (§2-1
// R4). Never touched by tests that assert on checkRelayHandshake's return
// value; this is purely the side-effect wiring described at its call site.
function autoRecordRejectStreak({ role, resultContent }) {
  const autoRecord = recordRejectStreakFromResultText({
    role,
    resultText: resultContent,
    ledgerPath: join(mainRepoRoot(), ".harness", "reject-streak.json"),
  });
  if (!autoRecord.attempted) return;
  if (autoRecord.ok) {
    console.log(autoRecord.reason);
  } else {
    console.error(autoRecord.reason);
  }
}

function parseKstTimestamp(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function checkRelayHandshake({
  role,
  harnessDir = join(repoRoot(), ".harness"),
}) {
  const taskPath = join(harnessDir, `${role}-task.md`);
  const resultPath = join(harnessDir, `${role}.md`);

  if (!existsSync(taskPath)) {
    return { ok: false, reason: `task file not found: ${taskPath}` };
  }
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      reason: `result file not found (worker not done?): ${resultPath}`,
    };
  }

  const taskContent = readFileSync(taskPath, "utf8");
  const resultContent = readFileSync(resultPath, "utf8");

  const taskIdMatch = taskContent.match(TASK_ID_RE);
  if (!taskIdMatch) {
    return { ok: false, reason: "task file missing task_id header" };
  }
  const taskId = taskIdMatch[1];

  const resultTaskId = resolveResultTaskId(resultContent);
  if (!resultTaskId.ok) {
    return { ok: false, reason: resultTaskId.reason };
  }
  const resultId = resultTaskId.id;

  if (taskId !== resultId) {
    return {
      ok: false,
      reason: `handshake mismatch: task dropped '${taskId}' but result echoes '${resultId}' (stale or wrong task)`,
    };
  }

  const droppedMatch = taskContent.match(DROPPED_AT_RE);
  if (!droppedMatch) {
    return {
      ok: false,
      reason:
        "task file missing dropped_at header (required for staleness check)",
    };
  }
  const droppedAt = parseKstTimestamp(droppedMatch[1]);
  if (!droppedAt) {
    return {
      ok: false,
      reason: `task dropped_at not parseable: '${droppedMatch[1].trim()}' (need YYYY-MM-DD HH:MM KST)`,
    };
  }

  const resultDone = resolveResultDoneMatch(resultContent);
  if (!resultDone.ok) {
    return { ok: false, reason: resultDone.reason };
  }
  const doneMatch = resultDone.match;
  const doneAt = parseKstTimestamp(doneMatch[1]);
  if (!doneAt) {
    return {
      ok: false,
      reason: `result DONE timestamp not parseable: '${doneMatch[1].trim()}'`,
    };
  }

  if (doneAt < droppedAt) {
    return {
      ok: false,
      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,
    };
  }

  // HYK-183 §2: the moment this function confirms a REVIEW-family result
  // file is COMPLETE (every prior check above already passed) is the one
  // moment the reject-streak ledger should be updated -- record's whole
  // job (reject-streak.mjs) is "did the LATEST, non-stale round on this
  // issue get rejected or approved", and everything above this line is
  // exactly the staleness/ambiguity resolution that answers that. Wired
  // here (inside the shared decision function, not only the CLI block) so
  // every caller -- the CLI AND in-process callers like relay-core.mjs --
  // gets it; §1's original gap was that NOTHING called `record` anywhere.
  // Never mutates this function's own return value or the CLI's exit code
  // (§2-1 R5) -- purely a side effect layered on top of an already-decided
  // PASS. Failure/duplicate/skip are never swallowed (§2-1 R4) --
  // autoRecordRejectStreak surfaces every branch via console.log/error.
  autoRecordRejectStreak({ role, resultContent });

  return { ok: true, reason: `relay handshake ok for ${taskId}` };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/relay-handshake.mjs");
if (invokedDirectly) {
  const role = process.argv[2];
  if (!role) {
    console.error("usage: node relay-handshake.mjs <role> [harnessDir]");
    process.exit(1);
  }
  const harnessDirArg = process.argv[3];
  const result = harnessDirArg
    ? checkRelayHandshake({ role, harnessDir: harnessDirArg })
    : checkRelayHandshake({ role });
  if (result.ok) {
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
