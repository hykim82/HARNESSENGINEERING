import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TASK_ID_RE = /^task_id:\s*(\S+)/im;
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

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity under the repo's ESLint ceiling) -- resolves the result
// file's task_id echo into either a match or one of two distinct
// diagnoses for the anchored-miss case (see TASK_ID_ANYWHERE_RE above).
function resolveResultTaskId(resultContent) {
  const resultIdMatch = resultContent.match(TASK_ID_RE);
  if (resultIdMatch) {
    return { ok: true, id: resultIdMatch[1] };
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

  const doneMatches = [...resultContent.matchAll(DONE_RE)];
  const doneMatch = doneMatches[doneMatches.length - 1];
  if (!doneMatch) {
    return {
      ok: false,
      reason: 'result missing ">>> DONE: ... @ <time KST>" line (required)',
    };
  }
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
