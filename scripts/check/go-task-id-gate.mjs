import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  isGoPrompt,
  extractTaskId,
  REGULATED_ROLES,
} from "./worker-status-onstart.mjs";

// HYK-151: closes the gap a stale-task-id re-run (coder-11) and an ORCH
// hand-typed "bare go" both fell through -- a `go` prompt with no task_id at
// all, or one that doesn't match the task file actually dropped, currently
// reaches the model unchallenged. Two halves (design §3.6):
//   A) a UserPromptSubmit hook (this file's CLI) that blocks BEFORE the
//      model ever processes the prompt.
//   B) a go-line generator (`--generate`, same file) so ORCH never
//      hand-assembles the string in the first place -- same sign.sh
//      precedent (관제실 sign.sh: read the source of truth, print exactly
//      one deterministic line, fail closed on anything missing).
//
// C2-0 (HYK-160-coder-4) confirmed BOTH blocking shapes (exit 2+stderr,
// exit 0+JSON decision:block) actually stop the model from seeing the
// prompt -- this module adopts the simpler one, exit 2+stderr, because it
// is a single failure surface (one process exit code) matching every other
// blocking hook already in this repo (role-guard, pm-guard, packet-gate),
// rather than a second JSON-shaped contract only this hook would use.

// Extracts the task_id token immediately after "go" in a prompt -- null if
// the prompt is bare "go" (or "go" followed only by whitespace) with
// nothing after it. Deliberately independent of extractTaskId (which reads
// a *file's* `task_id:` header) -- this reads the *prompt's* inline token.
const GO_WITH_ID_RE = /^\s*go\s+(\S+)/i;
export function extractPromptTaskId(prompt) {
  if (typeof prompt !== "string") return null;
  const m = prompt.match(GO_WITH_ID_RE);
  return m ? m[1] : null;
}

// The gate decision itself: given the raw prompt and the dropped task
// file's content, decide whether the model should ever see this prompt.
// Honesty (S4, design §3.6): this only confirms the prompt's task_id token
// matches the task file's own header -- it does not confirm the task file
// itself is fresh, un-stale, or the right one for this issue (that remains
// relay-handshake.mjs's job at consume time, a different check with a
// different scope). A task file that can't be read/parsed at all is
// UNJUDGABLE+fail-open here, not a block -- "I can't verify" is never
// itself treated as "verified wrong."
export function checkGoTaskId({ prompt, taskContent }) {
  if (!isGoPrompt(prompt)) {
    return {
      status: "PASS",
      ok: true,
      reason: "go-task-id-gate: not a go-prompt",
    };
  }
  const promptTaskId = extractPromptTaskId(prompt);
  if (!promptTaskId) {
    return {
      status: "BLOCK",
      ok: false,
      reason:
        "TASK_ID_REQUIRED -- 'go' prompt has no task_id (need 'go <task_id>')",
    };
  }
  const fileTaskId = extractTaskId(taskContent);
  if (!fileTaskId) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason:
        "go-task-id-gate: UNJUDGABLE -- task file missing/unreadable or no task_id header, cannot verify (fail-open)",
    };
  }
  if (promptTaskId !== fileTaskId) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `TASK_ID_MISMATCH -- prompt gave '${promptTaskId}' but task file's task_id is '${fileTaskId}'`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `go-task-id-gate: task_id '${promptTaskId}' matches`,
  };
}

// Part B: the deterministic generator. Given a task file's content, returns
// the exact `go <task_id>` line, or a failure reason -- never a guessed or
// partial line (fail-closed, sign.sh precedent).
export function generateGoLine(taskContent) {
  const taskId = extractTaskId(taskContent);
  if (!taskId) {
    return {
      ok: false,
      reason:
        "go-task-id-gate: cannot generate -- task file missing/unreadable or no task_id header",
    };
  }
  return { ok: true, line: `go ${taskId}` };
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function resolveTaskPath(role) {
  if (role === "PM") {
    const relayDir = process.env.HARNESS_PM_RELAY_DIR;
    return relayDir ? join(relayDir, "pm-task.md") : null;
  }
  return join(repoRoot(), ".harness", `${role.toLowerCase()}-task.md`);
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/go-task-id-gate.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const generateIdx = args.indexOf("--generate");

  if (generateIdx !== -1) {
    const taskPath = args[generateIdx + 1];
    if (!taskPath) {
      console.error(
        "usage: node go-task-id-gate.mjs --generate <task-file-path>",
      );
      process.exit(1);
    }
    let taskContent;
    try {
      taskContent = readFileSync(taskPath, "utf8");
    } catch (err) {
      console.error(
        `go-task-id-gate: failed to read '${taskPath}' (${err.message})`,
      );
      process.exit(1);
    }
    const result = generateGoLine(taskContent);
    if (!result.ok) {
      console.error(result.reason);
      process.exit(1);
    }
    console.log(result.line);
    process.exit(0);
  }

  // Hook mode: UserPromptSubmit payload on stdin.
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    process.exit(0); // unreadable payload -- never block on a hook-framework problem
  }

  const prompt = hookInput.prompt;
  if (!isGoPrompt(prompt)) {
    process.exit(0);
  }

  const role = process.env.HARNESS_ROLE;
  if (!REGULATED_ROLES.includes(role)) {
    process.exit(0);
  }

  const taskPath = resolveTaskPath(role);
  if (!taskPath) {
    console.error(
      "go-task-id-gate: PM role but HARNESS_PM_RELAY_DIR is not set -- skipping (fail-open, no hardcoded control-room path).",
    );
    process.exit(0);
  }

  let taskContent;
  try {
    taskContent = readFileSync(taskPath, "utf8");
  } catch {
    taskContent = null; // fed to checkGoTaskId, which treats this as UNJUDGABLE
  }

  const result = checkGoTaskId({ prompt, taskContent });
  if (result.status === "BLOCK") {
    console.error(result.reason);
    process.exit(2);
  }
  process.exit(0);
}
