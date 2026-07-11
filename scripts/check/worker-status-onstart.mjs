import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// HYK-110: the go-time "작업중" (in-progress) transition in STATUS.md §1 had
// no mechanical writer at all -- a worker that forgot the self-report Edit
// right after "go" left the board stale until it finished, which is exactly
// what produced the coder-11 stale-task incident. This hook does not check
// and block a missing update (that's what status-fresh.mjs's own Stop-hook
// check does for the *completion* transition); it performs the go-time
// update itself, on the UserPromptSubmit event, removing the convention
// entirely rather than trying to enforce it after the fact.

export const GO_RE = /^\s*go\b/i;
export const REGULATED_ROLES = ["CODER", "REVIEW", "VERIFY", "PM"];

export function isGoPrompt(prompt) {
  return typeof prompt === "string" && GO_RE.test(prompt);
}

// Extracts `task_id:` from a dropped task file's header (same pattern as
// relay-handshake.mjs's own task_id extraction).
export function extractTaskId(taskContent) {
  if (typeof taskContent !== "string") return null;
  const m = taskContent.match(/^task_id:\s*(\S+)/im);
  return m ? m[1] : null;
}

// PM's STATUS phrasing differs from the other three roles by design (the
// PM boot block's own Mode-B procedure already uses "📝 기획중" for its
// go-time self-report) -- this hook mirrors that instead of inventing a
// fourth label.
export function buildStatusLabel(role, taskId) {
  const verb = role === "PM" ? "📝 기획중" : "🔨 작업중";
  return `${verb}: ${taskId}`;
}

// A §1 heading line, e.g. "### 1) 다음 행동 (...)" -- matched immediately
// after the leading `#`s and whitespace so a differently-numbered heading
// ("### 10) 고정 방향") can never be mistaken for it (the digit right after
// the heading markers must be exactly "1)", not "10)" or "21)").
const SECTION1_HEADING_RE = /^#{1,6}\s*1\)[^\n]*$/m;
// Any heading line at all -- used to find where §1's body ends (the next
// heading of any level/number closes the section).
const ANY_HEADING_RE = /^#{1,6}\s/m;

// Finds the character range of STATUS §1's *body* (everything after the
// "1)" heading line, up to the next heading line or end of file). Returns
// null if no §1 heading exists at all.
export function findSection1Bounds(statusText) {
  const headingMatch = SECTION1_HEADING_RE.exec(statusText);
  if (!headingMatch) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const rest = statusText.slice(bodyStart);
  const nextHeadingMatch = ANY_HEADING_RE.exec(rest);
  const bodyEnd = nextHeadingMatch ? bodyStart + nextHeadingMatch.index : statusText.length;
  return { bodyStart, bodyEnd };
}

// Replaces exactly one STATUS §1 table row -- the row whose first cell is
// this role, matched by the pipe-delimited cell boundary (`\|\s*ROLE\s*\|`)
// so a role name appearing inside another row's free-text cell can never be
// mistaken for the row itself. Round 1 of this function searched the whole
// file for that row shape, which meant a same-shaped `| ROLE | ... | ... |`
// line sitting in a *different* section (e.g. free-text data inside §5/§6
// that happens to look like a table row) could be mis-replaced whenever §1
// itself had no row for that role -- a real bug an independent review
// reproduced directly. The fix: first bound the search to §1's own body
// (`findSection1Bounds`), then search for the role's row only inside that
// range. A same-shaped row anywhere outside §1 is structurally unreachable
// by this function now, not just unlikely to match. No §1 heading, or no
// matching row within its bounds, both fail open (`ok:false`) with the
// input completely unmodified -- every other row and every other section
// of the file stays byte-for-byte untouched (single targeted string splice
// within the located range, never a rewrite).
export function applyStatusUpdate({ statusText, role, label, nowStr }) {
  if (typeof statusText !== "string") {
    return { ok: false, reason: "worker-status-onstart: STATUS content is not a string" };
  }
  const bounds = findSection1Bounds(statusText);
  if (!bounds) {
    return { ok: false, reason: "worker-status-onstart: no STATUS §1 heading found (expected a heading line like '### 1) ...')" };
  }
  const sectionBody = statusText.slice(bounds.bodyStart, bounds.bodyEnd);
  // Trailing whitespace before `$` is deliberately horizontal-only
  // (`[^\S\r\n]*`), never `\s*`. `\s*` includes newlines, and greedy
  // backtracking only stops at the *first* position satisfying `$` --
  // for an internal row, that is naturally right before the row's own
  // line terminator (more sectionBody content follows), but for
  // whichever row happens to be *last* inside §1's body, `sectionBody`
  // itself ends right there (bounds.bodyEnd is the next heading's start,
  // so the row's trailing newline(s) are the literal end of the search
  // string) -- `\s*` could then legally consume all of them via the
  // end-of-string form of `$`, with no internal `\n` left to force an
  // earlier stop. The splice then dropped every newline between that row
  // and the next heading, gluing them together (`| NOW |### 2) ...`) --
  // an independent review reproduced this directly. Restricting the
  // trailing whitespace class to non-newline characters removes the
  // newline from what `\s*` could ever consume in the first place, so
  // this asymmetry between "last row in §1" and every other row cannot
  // recur regardless of how many blank lines separate the row from the
  // next heading.
  const rowRe = new RegExp(String.raw`^\|\s*${role}\s*\|[^|]*\|[^|]*\|[^\S\r\n]*$`, "m");
  const match = rowRe.exec(sectionBody);
  if (!match) {
    return { ok: false, reason: `worker-status-onstart: no STATUS §1 row found for role '${role}'` };
  }
  const absoluteIndex = bounds.bodyStart + match.index;
  const newLine = `| ${role} | ${label} | ${nowStr} |`;
  const updatedText = statusText.slice(0, absoluteIndex) + newLine + statusText.slice(absoluteIndex + match[0].length);
  return { ok: true, updatedText };
}

// Pure orchestration: given the prompt, role, the raw task-file text, and
// the raw STATUS text (plus an already-formatted "now" string), decides
// what should happen -- without touching a filesystem. This is what makes
// the whole go-time decision testable without any temp-directory fixtures;
// only the CLI wrapper below does real I/O.
export function computeUpdate({ prompt, role, taskContent, statusText, nowStr }) {
  if (!isGoPrompt(prompt)) {
    return { action: "noop", reason: "not a go-prompt" };
  }
  if (!REGULATED_ROLES.includes(role)) {
    return { action: "noop", reason: `role '${role ?? ""}' is not regulated by this hook` };
  }
  const taskId = extractTaskId(taskContent);
  if (!taskId) {
    return { action: "warn", reason: "task file missing/unreadable, or no task_id header in it" };
  }
  const label = buildStatusLabel(role, taskId);
  const result = applyStatusUpdate({ statusText, role, label, nowStr });
  if (!result.ok) {
    return { action: "warn", reason: result.reason };
  }
  return { action: "write", updatedText: result.updatedText, taskId, label };
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Local-clock formatting, not a KST-string parse -- this harness's own
// convention is "read the machine's local clock directly" (the operating
// machine's local time already is KST), same posture status-fresh.mjs and
// relay-handshake.mjs's own dropped_at/DONE lines rely on elsewhere.
function formatNow(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/worker-status-onstart.mjs");
if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    // No/malformed UserPromptSubmit payload -- this hook is a doer, not a
    // gate, so an unreadable payload is never a reason to interrupt the
    // worker's own prompt.
    process.exit(0);
  }

  const prompt = hookInput.prompt;
  if (!isGoPrompt(prompt)) {
    process.exit(0);
  }

  const role = process.env.HARNESS_ROLE;
  if (!REGULATED_ROLES.includes(role)) {
    process.exit(0);
  }

  let taskPath;
  if (role === "PM") {
    const relayDir = process.env.HARNESS_PM_RELAY_DIR;
    if (!relayDir) {
      console.error("worker-status-onstart: PM role but HARNESS_PM_RELAY_DIR is not set -- skipping (no hardcoded control-room path).");
      process.exit(0);
    }
    taskPath = join(relayDir, "pm-task.md");
  } else {
    taskPath = join(repoRoot(), ".harness", `${role.toLowerCase()}-task.md`);
  }

  let taskContent = null;
  try {
    taskContent = readFileSync(taskPath, "utf8");
  } catch (err) {
    console.error(`worker-status-onstart: could not read task file '${taskPath}' (${err.message}) -- fail-open, skipping.`);
    process.exit(0);
  }

  const statusPath = process.env.HARNESS_STATUS_PATH;
  if (!statusPath) {
    console.error("worker-status-onstart: HARNESS_STATUS_PATH is not set -- skipping (no hardcoded STATUS path).");
    process.exit(0);
  }

  let statusText = null;
  try {
    statusText = readFileSync(statusPath, "utf8");
  } catch (err) {
    console.error(`worker-status-onstart: could not read STATUS file '${statusPath}' (${err.message}) -- fail-open, skipping.`);
    process.exit(0);
  }

  const decision = computeUpdate({ prompt, role, taskContent, statusText, nowStr: formatNow(new Date()) });

  if (decision.action !== "write") {
    console.error(`worker-status-onstart: ${decision.reason} -- fail-open, skipping.`);
    process.exit(0);
  }

  try {
    writeFileSync(statusPath, decision.updatedText, "utf8");
  } catch (err) {
    console.error(`worker-status-onstart: could not write STATUS file '${statusPath}' (${err.message}) -- fail-open.`);
    process.exit(0);
  }

  process.exit(0);
}
