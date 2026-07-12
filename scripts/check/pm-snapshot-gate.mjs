import { readFileSync } from "node:fs";

// PM (codex) has no direct Linear read access by design -- ORCH's excerpt into
// the PM task file is the only input. Without a structured envelope, that
// excerpt is free text: no capture timestamp, no snapshot id, no declared
// "what I didn't check" -- so a stale or wrong excerpt has no independent
// verification path (HYK-128 F3). This gate enforces the envelope's
// *presence and shape*, not its truth -- see the honesty note on
// checkPmSnapshotEnvelope below.

// Case-insensitive, whitespace-tolerant: allows leading indentation before
// `type`, "TYPE"/"Type", space before the colon (`type :`), and a lowercase
// value (`b1`) -- all four were seen as real header variants review-3
// reproduced (coder-3 rejection).
const TYPE_RE = /^\s*type\s*:\s*(b[123])\b/im;
const LINEAR_EVIDENCE_NONE_RE = /^linear_evidence:\s*none\s*$/m;
const SNAPSHOT_BLOCK_RE = /<!--\s*pm-snapshot([\s\S]*?)-->/i;
const CAPTURED_AT_RE = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}\sKST$/;
const ISSUE_LINE_RE = /^issue\s+\S+:\s*state=/m;
const SNAPSHOT_ID_LINE_RE = /^snapshot_id:\s*(.*?)\s*$/m;

// Extracts the PM task type (B1/B2/B3) from a task file's `type:` header.
// Returns null when no such header exists (caller must not guess).
export function parsePmType(taskText) {
  const text = taskText ?? "";
  const match = text.match(TYPE_RE);
  return match ? match[1].toUpperCase() : null;
}

function fieldLines(blockBody, name) {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, "m");
  const match = blockBody.match(re);
  return match ? match[1] : null;
}

// G5: verifies a pm-snapshot envelope is present and structurally complete
// for PM task types that actually need one (B2/B3). B1 (pure Q&A) or a task
// that explicitly opts out via `linear_evidence: none` skip the requirement
// outright -- there is nothing to check.
//
// Honesty note (S4): this only checks that the envelope's fields *exist and
// are shaped correctly* (a real captured_at timestamp, at least one issue
// line, etc). It cannot and does not verify that the excerpted issue states
// are actually current or correct against live Linear -- that check is
// Tier2/soft by construction (PM and ORCH have no independently-verifiable
// channel to Linear here), same scope limits as the rest of this checker.
export function checkPmSnapshotEnvelope(taskText) {
  const text = taskText ?? "";
  const type = parsePmType(text);

  if (type === "B1" || LINEAR_EVIDENCE_NONE_RE.test(text)) {
    return {
      ok: true,
      reason: `pm-snapshot-gate: envelope not required (type=${type ?? "unknown"}${LINEAR_EVIDENCE_NONE_RE.test(text) ? ", linear_evidence: none" : ""}) -- skip`,
    };
  }

  const blockMatch = text.match(SNAPSHOT_BLOCK_RE);
  if (!blockMatch) {
    return {
      ok: false,
      reason: `pm-snapshot-gate: no pm-snapshot envelope block found (type=${type ?? "unknown"} requires one)`,
    };
  }
  const body = blockMatch[1];

  const missing = [];

  const snapshotId = fieldLines(body, "snapshot_id");
  if (!snapshotId) missing.push("snapshot_id");

  const capturedAt = fieldLines(body, "captured_at");
  if (!capturedAt) {
    missing.push("captured_at");
  } else if (!CAPTURED_AT_RE.test(capturedAt)) {
    return {
      ok: false,
      reason: `pm-snapshot-gate: captured_at has invalid format '${capturedAt}' (need 'YYYY-MM-DD HH:MM KST', no seconds)`,
    };
  }

  const issueIds = fieldLines(body, "issue_ids");
  if (!issueIds) missing.push("issue_ids");

  if (!ISSUE_LINE_RE.test(body)) missing.push("issue <ID>: state=... line");

  const omittedFields = fieldLines(body, "omitted_fields");
  if (!omittedFields) missing.push("omitted_fields");

  const unknown = fieldLines(body, "unknown");
  if (!unknown) missing.push("unknown");

  if (missing.length) {
    return {
      ok: false,
      reason: `pm-snapshot-gate: envelope missing required field(s): ${missing.join(", ")}`,
    };
  }

  return { ok: true, reason: `pm-snapshot-gate: envelope complete (snapshot_id=${snapshotId})` };
}

// G6: verifies the PM result file echoes back the exact snapshot_id the task
// gave it -- a literal string-identity check only. It never judges whether
// the result's *content* actually matches that snapshot (see honesty note
// above); it only confirms PM read and echoed the same envelope ORCH sent.
export function checkPmSnapshotEcho(taskText, resultText) {
  const taskIdMatch = (taskText ?? "").match(SNAPSHOT_ID_LINE_RE);
  if (!taskIdMatch) {
    return { ok: true, reason: "pm-snapshot-gate: task has no snapshot_id -- echo check skipped" };
  }
  const expected = taskIdMatch[1];

  const resultIdMatch = (resultText ?? "").match(SNAPSHOT_ID_LINE_RE);
  if (!resultIdMatch) {
    return {
      ok: false,
      reason: `pm-snapshot-gate: result is missing snapshot_id echo (expected '${expected}')`,
    };
  }
  const actual = resultIdMatch[1];

  if (actual !== expected) {
    return {
      ok: false,
      reason: `pm-snapshot-gate: snapshot_id mismatch (expected '${expected}', got '${actual}')`,
    };
  }

  return { ok: true, reason: `pm-snapshot-gate: snapshot_id echoed correctly (${expected})` };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/pm-snapshot-gate.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let taskPath;
  let resultPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task") taskPath = args[++i];
    if (args[i] === "--result") resultPath = args[++i];
  }

  if (!taskPath) {
    console.error("usage: node pm-snapshot-gate.mjs --task <path> [--result <path>]");
    process.exit(1);
  }

  let taskText;
  try {
    taskText = readFileSync(taskPath, "utf8");
  } catch (err) {
    console.error(`pm-snapshot-gate: failed to read task file: ${err.message}`);
    process.exit(1);
  }

  const envelopeResult = checkPmSnapshotEnvelope(taskText);
  if (!envelopeResult.ok) {
    console.error(envelopeResult.reason);
    process.exit(1);
  }
  console.log(envelopeResult.reason);

  if (resultPath) {
    let resultText;
    try {
      resultText = readFileSync(resultPath, "utf8");
    } catch (err) {
      console.error(`pm-snapshot-gate: failed to read result file: ${err.message}`);
      process.exit(1);
    }

    const echoResult = checkPmSnapshotEcho(taskText, resultText);
    if (!echoResult.ok) {
      console.error(echoResult.reason);
      process.exit(1);
    }
    console.log(echoResult.reason);
  }

  process.exit(0);
}
