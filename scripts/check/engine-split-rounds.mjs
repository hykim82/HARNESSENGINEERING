// HYK-153 engine-split-2 (coder-task.md §2, rework of engine-split-1) --
// read-only aggregation CLI.
//
// Joins the admission ledger's reservations (admission-ledger-core.mjs
// RESERVATION_STATUS entries, keyed by harness_label) with the seat launch
// registry (paneKey -> model) to count review rounds whose author seat ran
// a Sonnet-family model and whose review seat ran an Opus-family model,
// both sides consumed (status COMPLETED). This module performs no writes;
// it only reads the two files passed on argv and prints a summary.
//
// Pairing rule (PM design 1R, 엔진무관-증명-설계.md §a; review 1R P2-2 fix):
// a review-labeled reservation key matches /^(.*)-review-(\d+)$/, where
// capture group 2 is the review round number N. The real author
// reservation to pair with is `${group1}-r${N}` when that key exists in
// the ledger (a rework/CODER-retry round, labelled e.g. "X-1-r2" for the
// round that review-2 reviewed) -- otherwise it falls back to `group1`
// verbatim (round 1, which carries no "-rN" suffix). The live admission
// ledger confirms this: e.g. "HYK-480-checklist-inject-2-review-2" pairs
// with "HYK-480-checklist-inject-2-r2" (not the bare, round-1 reservation),
// while "...-review-1" pairs with the bare label. Review labels whose
// resolved author key has no matching reservation are not paired (they are
// not counted in strict or loose; this undercounts older rounds whose
// labelling convention differs, which is a known, documented limitation).

import fs from "node:fs";
import path from "node:path";

export const REVIEW_LABEL_PATTERN = /^(.*)-review-(\d+)$/;
export const ISSUE_PATTERN = /^(HYK-\d+)/;
export const SONNET_FAMILY_PATTERN = /sonnet/i;
export const OPUS_FAMILY_PATTERN = /opus/i;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// ---- ledger / registry parsing (pure, no fs) ----

export function parseLedgerText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: `parseLedgerText: JSON.parse failed (${err?.message})`,
    };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.reservations)) {
    return {
      ok: false,
      reason: "parseLedgerText: missing or malformed reservations object",
    };
  }
  return { ok: true, reservations: parsed.reservations };
}

// Returns a Map<paneKey, record> where record = the full registry line
// (paneKey, role, engine, model, effort, worktree, launchedAt, ...).
// Malformed lines (bad JSON, missing/empty paneKey) are skipped -- this is
// a read-only reporting tool, not a validator of the registry file, so it
// fails soft on individual bad lines rather than aborting the whole run.
export function parseRegistryJsonl(text) {
  const byPaneKey = new Map();
  const skippedLines = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      skippedLines.push(i + 1);
      continue;
    }
    if (!isPlainObject(rec) || !isNonEmptyString(rec.paneKey)) {
      skippedLines.push(i + 1);
      continue;
    }
    byPaneKey.set(rec.paneKey, rec);
  }
  return { byPaneKey, skippedLines };
}

function modelForSeatKey(byPaneKey, seatKey) {
  if (!isNonEmptyString(seatKey)) return null;
  const rec = byPaneKey.get(seatKey);
  if (!rec) return null;
  return typeof rec.model === "string" ? rec.model : "";
}

// ---- classification ----

// A review-labeled reservation + its paired author reservation (by label,
// see module header) -> a classified row, or null if there is no author
// reservation to pair with (unpaired review labels are not counted).
function isSonnetOpusFamily(authorModel, reviewModel) {
  if (typeof authorModel !== "string" || typeof reviewModel !== "string")
    return false;
  return (
    SONNET_FAMILY_PATTERN.test(authorModel) &&
    OPUS_FAMILY_PATTERN.test(reviewModel)
  );
}

function isBothCompleted(authorEntry, reviewEntry) {
  return (
    authorEntry.status === "COMPLETED" && reviewEntry.status === "COMPLETED"
  );
}

// completion_reason set (SUSPECT_TIMEOUT_RECOVERED / BLOCKED_TERMINATION_RELEASED
// / RETIREMENT_RELEASED, admission-ledger-core.mjs) means the reservation was
// closed, not consumed by a round -- strict excludes those; loose allows them.
function hasNoCompletionReason(authorEntry, reviewEntry) {
  return !authorEntry.completion_reason && !reviewEntry.completion_reason;
}

export function classifyPair(
  reviewLabel,
  reviewEntry,
  authorLabel,
  authorEntry,
  byPaneKey,
) {
  if (!isPlainObject(authorEntry) || !isPlainObject(reviewEntry)) return null;

  const authorModel = modelForSeatKey(byPaneKey, authorEntry.seat_key);
  const reviewModel = modelForSeatKey(byPaneKey, reviewEntry.seat_key);

  const loose =
    isSonnetOpusFamily(authorModel, reviewModel) &&
    isBothCompleted(authorEntry, reviewEntry);
  const strict = loose && hasNoCompletionReason(authorEntry, reviewEntry);

  const issueMatch = ISSUE_PATTERN.exec(authorLabel);

  return {
    reviewLabel,
    authorLabel,
    authorModel,
    reviewModel,
    authorSeatKey: authorEntry.seat_key ?? null,
    reviewSeatKey: reviewEntry.seat_key ?? null,
    strict,
    loose,
    issue: issueMatch ? issueMatch[1] : null,
    admittedAt:
      typeof reviewEntry.admitted_at === "string"
        ? reviewEntry.admitted_at
        : null,
  };
}

// Resolves a review label's author key (see module header P2-2 note): a
// rework round `${base}-r${n}` takes priority over the bare `${base}` when
// both the regex captured an N and that rework reservation actually exists.
export function resolveAuthorLabel(base, reviewRoundNumber, reservations) {
  const reworkLabel = `${base}-r${reviewRoundNumber}`;
  if (Object.prototype.hasOwnProperty.call(reservations, reworkLabel)) {
    return reworkLabel;
  }
  return base;
}

export function joinRounds(reservations, byPaneKey) {
  const rows = [];
  for (const [label, entry] of Object.entries(reservations)) {
    const m = REVIEW_LABEL_PATTERN.exec(label);
    if (!m) continue;
    const base = m[1];
    const reviewRoundNumber = m[2];
    const authorLabel = resolveAuthorLabel(
      base,
      reviewRoundNumber,
      reservations,
    );
    const authorEntry = reservations[authorLabel];
    const row = classifyPair(label, entry, authorLabel, authorEntry, byPaneKey);
    if (row) rows.push(row);
  }
  // Stable, deterministic ordering (label text) -- Object.entries order is
  // insertion order in practice but is not a contract the aggregation CLI
  // should depend on.
  rows.sort((a, b) => a.reviewLabel.localeCompare(b.reviewLabel));
  return rows;
}

function tally(rows) {
  const n = rows.length;
  const distinctAuthorRounds = new Set(rows.map((r) => r.authorLabel)).size;
  const issueCounts = new Map();
  for (const r of rows) {
    if (r.issue === null) continue;
    issueCounts.set(r.issue, (issueCounts.get(r.issue) ?? 0) + 1);
  }
  const distinctIssues = issueCounts.size;
  let topIssue = null;
  let topIssueCount = 0;
  for (const [issue, count] of issueCounts) {
    if (count > topIssueCount) {
      topIssue = issue;
      topIssueCount = count;
    }
  }
  const reviewModelDistribution = {};
  const authorModelDistribution = {};
  for (const r of rows) {
    const rm = r.reviewModel ?? "(unknown)";
    const am = r.authorModel ?? "(unknown)";
    reviewModelDistribution[rm] = (reviewModelDistribution[rm] ?? 0) + 1;
    authorModelDistribution[am] = (authorModelDistribution[am] ?? 0) + 1;
  }
  return {
    n,
    distinctAuthorRounds,
    distinctIssues,
    topIssue,
    topIssueCount,
    nExcludingTopIssue: n - topIssueCount,
    reviewModelDistribution,
    authorModelDistribution,
  };
}

// review 1R P2-6 fix: firstPair/lastPair are now the chronologically first
// and last reviewed rounds (by the review reservation's admitted_at), not
// the label text's localeCompare order -- "first pair" previously meant
// "alphabetically first label" (e.g. "HYK-129-..." sorts before
// "HYK-209-..." regardless of when either was actually reviewed). Rows
// with a missing/unparseable admitted_at are excluded from this ordering
// (documented limitation -- they still count in n/strict/loose).
function chronologicalFirstLast(rows) {
  const withTime = rows
    .map((r) => ({
      r,
      t: typeof r.admittedAt === "string" ? Date.parse(r.admittedAt) : NaN,
    }))
    .filter((x) => Number.isFinite(x.t));
  if (withTime.length === 0) return { firstPair: null, lastPair: null };
  withTime.sort((a, b) => a.t - b.t);
  return {
    firstPair: withTime[0].r.reviewLabel,
    lastPair: withTime[withTime.length - 1].r.reviewLabel,
  };
}

export function summarize(rows) {
  const strictRows = rows.filter((r) => r.strict);
  const looseRows = rows.filter((r) => r.loose);
  const { firstPair, lastPair } = chronologicalFirstLast(rows);
  return {
    strict: tally(strictRows),
    loose: tally(looseRows),
    firstPair,
    lastPair,
    sampleRows: rows.slice(0, 3),
  };
}

// ---- optional transcript cross-check (session-record model confirmation) ----
//
// PM design §a: transcript folders live at
// `<transcripts-root>/<worktree-path-with-non-alnum-replaced-by-"-">/*.jsonl`
// and each line that carries a "model" field is a session turn. This is a
// best-effort, worktree-level (not round-level) corroboration signal -- a
// worktree can host more than one round's sessions, so a "mixed" verdict
// here is conservative evidence, not proof that a specific round's models
// were mixed (documented limitation, see docs/HYK-153-engine-agnostic.md).

export function deriveTranscriptFolderName(worktreePath) {
  if (!isNonEmptyString(worktreePath)) return null;
  return worktreePath.replace(/[^A-Za-z0-9]/g, "-");
}

// review 1R P2-1: a real Claude Code session-transcript jsonl line carries
// the model name at `message.model` -- the top-level `model` field used by
// this module's own pre-fix synthetic fixtures never appears in a real
// transcript (confirmed: 0 top-level `model` lines vs. 101 `message.model`
// lines in one sampled transcript folder), so reading only `rec.model` left
// --transcripts permanently at checked=0 against real data. Both shapes are
// read (message.model preferred) so a line carrying either still
// corroborates.
function modelFromTranscriptLine(line) {
  if (line.trim().length === 0) return null;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(rec)) return null;
  if (isNonEmptyString(rec.message?.model)) return rec.message.model;
  if (isNonEmptyString(rec.model)) return rec.model;
  return null;
}

function scanTranscriptModels(transcriptsRoot, folderName, fsOps) {
  const dir = path.join(transcriptsRoot, folderName);
  if (!fsOps.existsSync(dir)) return [];
  let entries;
  try {
    entries = fsOps.readdirSync(dir);
  } catch {
    return [];
  }
  const models = new Set();
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    let text;
    try {
      text = fsOps.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const model = modelFromTranscriptLine(line);
      if (model !== null) models.add(model);
    }
  }
  return [...models];
}

function transcriptFolderFor(byPaneKey, seatKey) {
  const rec = isNonEmptyString(seatKey) ? byPaneKey.get(seatKey) : null;
  return rec ? deriveTranscriptFolderName(rec.worktree) : null;
}

// Looks up one row's transcript models on both sides. Returns null when
// there isn't enough data to corroborate (missing folder or no models
// found on either side) -- such rows are simply not "checked".
function checkRowAgainstTranscripts(r, byPaneKey, transcriptsRoot, fsOps) {
  const authorFolder = transcriptFolderFor(byPaneKey, r.authorSeatKey);
  const reviewFolder = transcriptFolderFor(byPaneKey, r.reviewSeatKey);
  if (!authorFolder || !reviewFolder) return null;

  const authorModels = scanTranscriptModels(
    transcriptsRoot,
    authorFolder,
    fsOps,
  );
  const reviewModels = scanTranscriptModels(
    transcriptsRoot,
    reviewFolder,
    fsOps,
  );
  if (authorModels.length === 0 || reviewModels.length === 0) return null;

  const authorAllSonnet = authorModels.every((m) =>
    SONNET_FAMILY_PATTERN.test(m),
  );
  const reviewAllOpus = reviewModels.every((m) => OPUS_FAMILY_PATTERN.test(m));
  return {
    confirmed: authorAllSonnet && reviewAllOpus,
    authorModels,
    reviewModels,
  };
}

// rows: strict rows to corroborate. byPaneKey: full registry records (for
// `.worktree`). Returns { checked, confirmed, mixed, mixedDetails } -- see
// checkRowAgainstTranscripts for what "checked" requires.
export function crossCheckSessions(
  rows,
  byPaneKey,
  transcriptsRoot,
  fsOps = fs,
) {
  let checked = 0;
  let confirmed = 0;
  let mixed = 0;
  const mixedDetails = [];
  for (const r of rows) {
    const outcome = checkRowAgainstTranscripts(
      r,
      byPaneKey,
      transcriptsRoot,
      fsOps,
    );
    if (outcome === null) continue;
    checked += 1;
    if (outcome.confirmed) {
      confirmed += 1;
    } else {
      mixed += 1;
      mixedDetails.push({
        reviewLabel: r.reviewLabel,
        authorModels: outcome.authorModels,
        reviewModels: outcome.reviewModels,
      });
    }
  }
  return { checked, confirmed, mixed, mixedDetails };
}

// ---- CLI ----

const NUMERIC_FLAGS = {
  "--min-strict": "minStrict",
  "--min-strict-excl-top": "minStrictExclTop",
  "--min-authors": "minAuthors",
  "--min-issues": "minIssues",
  "--min-confirmed": "minConfirmed",
};

// review 1R P2-4 fix: `Number(argv[++i])` on a missing or non-numeric value
// (e.g. `--min-strict abc`, or `--min-strict` as the last argv with no
// value) produced NaN, and every NaN threshold comparison (`n < NaN`) is
// false -- so the threshold silently never failed (exit 0, "thresholds:
// OK") instead of rejecting the bad input. parseArgs now records which
// flags got a non-finite value; runCli refuses to run rather than silently
// opening every threshold.
function parseArgs(argv) {
  const out = {
    ledger: null,
    registry: null,
    transcripts: null,
    json: false,
    minStrict: 30,
    minStrictExclTop: 30,
    minAuthors: 20,
    minIssues: 10,
    minConfirmed: 20,
  };
  const invalidFlags = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ledger") out.ledger = argv[++i];
    else if (a === "--registry") out.registry = argv[++i];
    else if (a === "--transcripts") out.transcripts = argv[++i];
    else if (a === "--json") out.json = true;
    else if (Object.prototype.hasOwnProperty.call(NUMERIC_FLAGS, a)) {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        invalidFlags.push(`${a} (got ${JSON.stringify(raw ?? null)})`);
      } else {
        out[NUMERIC_FLAGS[a]] = n;
      }
    }
  }
  return { ...out, invalidFlags };
}

function buildThresholdFailures(summary, sessionCheck, args) {
  const failures = [];
  if (summary.strict.n < args.minStrict) {
    failures.push(
      `strict N ${summary.strict.n} < --min-strict ${args.minStrict}`,
    );
  }
  if (summary.strict.nExcludingTopIssue < args.minStrictExclTop) {
    failures.push(
      `strict N excluding top issue ${summary.strict.nExcludingTopIssue} < --min-strict-excl-top ${args.minStrictExclTop}`,
    );
  }
  if (summary.strict.distinctAuthorRounds < args.minAuthors) {
    failures.push(
      `distinct author rounds ${summary.strict.distinctAuthorRounds} < --min-authors ${args.minAuthors}`,
    );
  }
  if (summary.strict.distinctIssues < args.minIssues) {
    failures.push(
      `distinct issues ${summary.strict.distinctIssues} < --min-issues ${args.minIssues}`,
    );
  }
  if (
    isNonEmptyString(args.transcripts) &&
    sessionCheck.checked < args.minConfirmed
  ) {
    failures.push(
      `session-confirmed ${sessionCheck.checked} < --min-confirmed ${args.minConfirmed}`,
    );
  }
  if (sessionCheck.mixed > 0) {
    failures.push(`mixed-family pairs ${sessionCheck.mixed} > 0`);
  }
  return failures;
}

function buildResult(summary, sessionCheck, skippedLines, args) {
  const failures = buildThresholdFailures(summary, sessionCheck, args);
  return {
    strict: summary.strict,
    loose: summary.loose,
    firstPair: summary.firstPair,
    lastPair: summary.lastPair,
    sampleRows: summary.sampleRows,
    sessionCheck,
    registrySkippedLines: skippedLines,
    thresholds: {
      minStrict: args.minStrict,
      minStrictExclTop: args.minStrictExclTop,
      minAuthors: args.minAuthors,
      minIssues: args.minIssues,
      minConfirmed: args.minConfirmed,
    },
    failures,
    ok: failures.length === 0,
  };
}

function formatHumanReadable(summary, sessionCheck, failures) {
  return [
    `STRICT review-rounds=${summary.strict.n} distinct-coder=${summary.strict.distinctAuthorRounds} distinct-issues=${summary.strict.distinctIssues} excl-top-issue=${summary.strict.nExcludingTopIssue} (top=${summary.strict.topIssue ?? "none"} x${summary.strict.topIssueCount})`,
    `LOOSE  review-rounds=${summary.loose.n} distinct-coder=${summary.loose.distinctAuthorRounds} distinct-issues=${summary.loose.distinctIssues}`,
    `session-check: checked=${sessionCheck.checked} confirmed=${sessionCheck.confirmed} mixed=${sessionCheck.mixed}`,
    `first-pair=${summary.firstPair ?? "none"} last-pair=${summary.lastPair ?? "none"}`,
    failures.length === 0
      ? "thresholds: OK"
      : `thresholds: FAIL -- ${failures.join("; ")}`,
  ].join("\n");
}

function loadInputsOrError(args, fsOps) {
  if (!isNonEmptyString(args.ledger) || !isNonEmptyString(args.registry)) {
    return {
      ok: false,
      output:
        "engine-split-rounds: --ledger <path> and --registry <path> are required",
    };
  }
  const ledgerParsed = parseLedgerText(fsOps.readFileSync(args.ledger, "utf8"));
  if (!ledgerParsed.ok) {
    return { ok: false, output: `engine-split-rounds: ${ledgerParsed.reason}` };
  }
  const { byPaneKey, skippedLines } = parseRegistryJsonl(
    fsOps.readFileSync(args.registry, "utf8"),
  );
  return {
    ok: true,
    reservations: ledgerParsed.reservations,
    byPaneKey,
    skippedLines,
  };
}

function runSessionCheck(rows, byPaneKey, args, fsOps) {
  if (!isNonEmptyString(args.transcripts)) {
    return { checked: 0, confirmed: 0, mixed: 0, mixedDetails: [] };
  }
  return crossCheckSessions(
    rows.filter((r) => r.strict),
    byPaneKey,
    args.transcripts,
    fsOps,
  );
}

export function runCli(argv, fsOps = fs) {
  const args = parseArgs(argv);
  if (args.invalidFlags.length > 0) {
    return {
      rc: 1,
      output: `engine-split-rounds: invalid numeric value for ${args.invalidFlags.join(", ")}`,
    };
  }
  const inputs = loadInputsOrError(args, fsOps);
  if (!inputs.ok) return { rc: 1, output: inputs.output };

  const rows = joinRounds(inputs.reservations, inputs.byPaneKey);
  const summary = summarize(rows);
  const sessionCheck = runSessionCheck(rows, inputs.byPaneKey, args, fsOps);
  const result = buildResult(summary, sessionCheck, inputs.skippedLines, args);
  const rc = result.ok ? 0 : 1;

  if (args.json) return { rc, output: JSON.stringify(result, null, 2) };
  return {
    rc,
    output: formatHumanReadable(summary, sessionCheck, result.failures),
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/engine-split-rounds.mjs");
if (invokedDirectly) {
  const { rc, output } = runCli(process.argv.slice(2));
  console.log(output);
  process.exit(rc);
}
