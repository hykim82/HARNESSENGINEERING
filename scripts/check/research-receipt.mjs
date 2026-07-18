import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// HYK-144: HYK-135's 6-consecutive-reject incident traced back to
// reinventing a well-known solution (file locks / atomic transactions) with
// no check for whether outside prior art was ever consulted. This module has
// two independent halves (design §3.5), deliberately kept on different trust
// tiers:
//   1) a PostToolUse(WebSearch|WebFetch) hook that appends a minimal,
//      append-only receipt to `.harness/research-log.json` every time ORCH
//      actually runs one of those tools -- a *recording* aid, Tier2
//      (Claude-only, can be skipped/crash silently, never blocks the tool
//      call itself).
//   2) an ORCH-direct gate, engine-neutral, that checks two independent
//      things at drop time: a confirmed streak>=2 issue has a research
//      receipt logged since its last reject (`RESEARCH_RECEIPT_REQUIRED`),
//      and a B0 target request block carries a non-empty prior-art field
//      (`PRIOR_ART_FIELD_REQUIRED`) -- two separate reasons because they are
//      two separate failure conditions (design's explicit "결손 2종은 분리
//      fixture").
//
// Honesty (S4, design §3.5): neither half judges research *quality* --
// whether the query was any good, whether the fetched page was actually
// read, whether the prior-art field's content is true. The hook only
// proves a tool call happened; the gate only proves a receipt/field exists
// in the right place. "Compliance claimed" never means "research was good."

const ISSUE_ID_RE = /^(HYK-\d+)/;
const TASK_ID_LINE_RE = /^task_id:\s*(\S+)/im;
const B0_REQUEST_HEADER_RE = /^##\s*B0\s*사전\s*비평\s*요청\s*$/m;
const PRIOR_ART_FIELD_RE = /^선행\s*사례\s*:\s*(.+?)\s*$/m;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
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

export function formatNowLocal(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} KST`;
}

// --- Half 1: PostToolUse receipt recording -------------------------------

// Only WebSearch/WebFetch calls produce a receipt -- everything else
// (Read, Edit, Bash, ...) is out of scope by construction, never logged.
export function buildReceiptEntry({ toolName, toolInput, now }) {
  if (toolName !== "WebSearch" && toolName !== "WebFetch") return null;
  const query = toolName === "WebSearch" ? toolInput?.query : toolInput?.url;
  return {
    tool: toolName,
    query: typeof query === "string" ? query : null,
    at: now,
  };
}

// Append-only: never rewrites or removes a prior entry, even if the file is
// malformed (a malformed file is replaced with a fresh array containing
// just this one entry -- recording *this* tool call must never be lost
// because an earlier entry got corrupted, but nothing here silently drops
// history that IS readable).
export function appendReceipt({
  logPath,
  entry,
  readFileFn = (p) => readFileSync(p, "utf8"),
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  let log = [];
  if (existsFn(logPath)) {
    try {
      const parsed = JSON.parse(readFileFn(logPath));
      if (Array.isArray(parsed)) log = parsed;
    } catch {
      log = [];
    }
  }
  log.push(entry);
  writeFileFn(logPath, JSON.stringify(log, null, 2) + "\n", "utf8");
  return log;
}

// --- Half 2: ORCH-direct gate ---------------------------------------------

function issueIdFrom(taskIdLike) {
  const m =
    typeof taskIdLike === "string" ? taskIdLike.match(ISSUE_ID_RE) : null;
  return m ? m[1] : null;
}

// HYK-160-coder-6 (review-4 결함 2): a plain lexical `>=` comparison on two
// UNVALIDATED strings approves nonsense -- REVIEW's exact repro found
// `'zzz' >= 'not-a-fixed-width-time'` reading as true, so a ledger/receipt
// timestamp that had drifted out of shape (or was simply garbage) produced
// a false PASS instead of surfacing the problem. Every timestamp this
// module compares must match this exact shape BEFORE any lexical
// comparison happens -- string comparison is still safe and Date-parse-free
// for values that do match it (fixed-width, zero-padded, big-endian), it is
// only unsafe for values nothing has confirmed match it at all.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? KST$/;
export function isValidTimestamp(ts) {
  return typeof ts === "string" && TIMESTAMP_RE.test(ts.trim());
}

// Strips the trailing ' KST' from an already-validated timestamp -- callers
// must run isValidTimestamp first; this performs no validation itself.
function stripKst(ts) {
  return ts.trim().replace(/\s*KST\s*$/i, "");
}

// Resolves the issue id a task file's header names, or an UNJUDGABLE reason
// if it can't -- extracted from checkResearchReceipt (quality-check: keeps
// checkResearchReceipt's own complexity under the repo's ESLint ceiling;
// pure refactor, same UNJUDGABLE reasons as before).
function resolveIssueId(taskText) {
  const text = normalizeNewlines(taskText);
  const taskIdMatch = text.match(TASK_ID_LINE_RE);
  if (!taskIdMatch) {
    return {
      ok: false,
      reason:
        "research-receipt: UNJUDGABLE -- task file has no task_id header, cannot resolve issue id (fail-open)",
    };
  }
  const issueId = issueIdFrom(taskIdMatch[1]);
  if (!issueId) {
    return {
      ok: false,
      reason: `research-receipt: UNJUDGABLE -- task_id '${taskIdMatch[1]}' does not start with HYK-<digits> (fail-open)`,
    };
  }
  return { ok: true, issueId };
}

// The most recent rejected verdict's timestamp in an issue's ledger history
// (stripped of ' KST'), or null if there's no rejected entry to anchor on --
// extracted from checkResearchReceipt for the same reason as resolveIssueId.
//
// A malformed `at` on that entry is `ok:false`, never silently treated as
// "no cutoff" (which would make every receipt count) or compared as-is
// (review-4's exact bug). Honesty note (why UNJUDGABLE, not fail-closed):
// a malformed ledger timestamp is assumed to be accidental corruption, not
// an adversarial bypass -- the same posture reject-streak.mjs's own
// corrupted-ledger handling already takes (loadLedger: UNJUDGABLE+fail-open,
// never silently treated as streak 0). Consistency with that existing
// contract, not a fresh policy choice, is why fail-closed was not picked here.
function findLastRejectCutoff(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.verdict === "rejected") {
      const at = history[i].at;
      if (!isValidTimestamp(at)) {
        return {
          ok: false,
          reason: `research-receipt: UNJUDGABLE -- ledger's most recent rejected verdict has a malformed 'at' timestamp: '${at}'`,
        };
      }
      return { ok: true, cutoff: stripKst(at) };
    }
  }
  return { ok: true, cutoff: null };
}

// Whether the log has a WebSearch/WebFetch entry at or after `cutoff` (no
// cutoff -- any receipt counts) -- extracted from checkResearchReceipt for
// the same reason as resolveIssueId. A qualifying-tool entry with a
// malformed `at` is `ok:false` for the same review-4 reason as
// findLastRejectCutoff above -- never silently skipped (which could hide a
// real receipt) or lexically compared as-is (which could approve garbage).
function evaluateReceiptsSince(log, cutoff) {
  const entries = Array.isArray(log) ? log : [];
  let hasReceipt = false;
  for (const e of entries) {
    if (e?.tool !== "WebSearch" && e?.tool !== "WebFetch") continue;
    if (!isValidTimestamp(e.at)) {
      return {
        ok: false,
        reason: `research-receipt: UNJUDGABLE -- a WebSearch/WebFetch log entry has a malformed 'at' timestamp: '${e.at}'`,
      };
    }
    if (!cutoff || stripKst(e.at) >= cutoff) hasReceipt = true;
  }
  return { ok: true, hasReceipt };
}

// Reads an issue's { streak, history } out of a reject-streak-shaped ledger,
// tolerating any missing piece -- extracted so checkResearchReceipt's own
// complexity stays under the repo's ESLint ceiling (each `?.`/`??` link
// counts as a branch); pure refactor, same {streak:0, history:[]} baseline
// as before for an issue absent from the ledger.
function ledgerEntryFor(ledger, issueId) {
  const entry = ledger?.issues?.[issueId];
  return { streak: entry?.streak ?? 0, history: entry?.history ?? [] };
}

// RESEARCH_RECEIPT_REQUIRED: for a confirmed streak>=2 issue, a WebSearch/
// WebFetch receipt must exist in the log with `at` on or after the issue's
// most recent rejected verdict (from the reject-streak ledger's own
// history) -- research done before that reject doesn't count for this
// round's escalation, only research done since. streak<2 or no ledger
// entry -> not required (same baseline reject-streak.mjs itself uses).
export function checkResearchReceipt({ taskText, ledger, log }) {
  const resolved = resolveIssueId(taskText);
  if (!resolved.ok) {
    return { status: "UNJUDGABLE", ok: true, reason: resolved.reason };
  }
  const { issueId } = resolved;
  const { streak, history } = ledgerEntryFor(ledger, issueId);

  if (streak < 2) {
    return {
      status: "PASS",
      ok: true,
      reason: `research-receipt: ${issueId} streak=${streak} (<2) -- receipt not required`,
    };
  }

  const cutoffResult = findLastRejectCutoff(history);
  if (!cutoffResult.ok) {
    return { status: "UNJUDGABLE", ok: true, reason: cutoffResult.reason };
  }

  const receiptResult = evaluateReceiptsSince(log, cutoffResult.cutoff);
  if (!receiptResult.ok) {
    return { status: "UNJUDGABLE", ok: true, reason: receiptResult.reason };
  }

  if (!receiptResult.hasReceipt) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `RESEARCH_RECEIPT_REQUIRED -- ${issueId} streak=${streak} has no WebSearch/WebFetch receipt since last reject${cutoffResult.cutoff ? ` (${cutoffResult.cutoff})` : ""}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `research-receipt: ${issueId} streak=${streak} has a receipt since last reject`,
  };
}

// PRIOR_ART_FIELD_REQUIRED: a B0 target request block must carry a non-empty
// '선행 사례:' field (relay-terminal-setup.md §2.15's "선행 사례 탐색"
// convention -- 결과(출처 포함) 또는 생략 사유). No B0 request block at all
// -> not this gate's concern (b0-gate.mjs already owns B0 classification).
export function checkPriorArtField(taskText) {
  const text = normalizeNewlines(taskText);
  const headerMatch = B0_REQUEST_HEADER_RE.exec(text);
  if (!headerMatch) {
    return {
      status: "PASS",
      ok: true,
      reason:
        "research-receipt: no B0 request block -- prior-art field not applicable",
    };
  }
  const rest = text.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderIdx = rest.search(/^##\s/m);
  const body = nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx);

  const fieldMatch = body.match(PRIOR_ART_FIELD_RE);
  if (!fieldMatch || !fieldMatch[1].trim()) {
    return {
      status: "BLOCK",
      ok: false,
      reason:
        "PRIOR_ART_FIELD_REQUIRED -- B0 request block missing '선행 사례:' field (결과+출처, 또는 생략 사유)",
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `research-receipt: prior-art field present (${fieldMatch[1].trim()})`,
  };
}

// Combined drop-time gate -- runs both independent checks, BLOCKs on the
// first failure (each has its own reason constant, so a caller/test can
// still isolate which one fired without needing two separate CLI calls).
export function checkResearchGate({ taskText, ledger, log }) {
  const receipt = checkResearchReceipt({ taskText, ledger, log });
  if (receipt.status === "BLOCK") return receipt;
  const priorArt = checkPriorArtField(taskText);
  if (priorArt.status === "BLOCK") return priorArt;
  return {
    status: "PASS",
    ok: true,
    reason: `${receipt.reason}; ${priorArt.reason}`,
  };
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ledger") out.ledger = args[++i];
    else if (args[i] === "--log") out.log = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/research-receipt.mjs");
if (invokedDirectly) {
  const root = repoRoot();
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (sub === "record") {
    // PostToolUse payload on stdin -- never blocks the tool call, exit 0 always.
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
      process.exit(0);
    }
    const entry = buildReceiptEntry({
      toolName: hookInput.tool_name,
      toolInput: hookInput.tool_input,
      now: formatNowLocal(),
    });
    if (!entry) process.exit(0); // not a WebSearch/WebFetch call -- nothing to record
    const logPath = args.log || join(root, ".harness", "research-log.json");
    try {
      appendReceipt({ logPath, entry });
    } catch (err) {
      console.error(
        `research-receipt record: failed to write '${logPath}' (${err.message}) -- fail-open, tool call unaffected.`,
      );
    }
    process.exit(0);
  }

  if (sub === "gate") {
    const taskPath = args._[0] || join(root, ".harness", "coder-task.md");
    const ledgerPath =
      args.ledger || join(root, ".harness", "reject-streak.json");
    const logPath = args.log || join(root, ".harness", "research-log.json");

    if (!existsSync(taskPath)) {
      console.error(`research-receipt gate: task file not found: ${taskPath}`);
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, "utf8");

    let ledger = { schema_version: 1, issues: {} };
    if (existsSync(ledgerPath)) {
      try {
        ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      } catch (err) {
        console.log(
          `research-receipt gate: UNJUDGABLE -- ledger '${ledgerPath}' unreadable (${err.message}) -- exit 0 (fail-open)`,
        );
        process.exit(0);
      }
    }

    let log = [];
    if (existsSync(logPath)) {
      try {
        const parsed = JSON.parse(readFileSync(logPath, "utf8"));
        if (Array.isArray(parsed)) log = parsed;
      } catch {
        log = [];
      }
    }

    const result = checkResearchGate({ taskText, ledger, log });
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  console.error("usage: node research-receipt.mjs record");
  console.error(
    "       node research-receipt.mjs gate [<task-path>] [--ledger <path>] [--log <path>]",
  );
  process.exit(1);
}
