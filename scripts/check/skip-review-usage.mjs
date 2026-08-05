// HYK-183: observer (not a gate). Enumerates commits whose message carries a
// real `skip-review:` trailer -- the audited escape hatch review-gate.mjs
// allows (docs/enforcement-v1.md D2 Rule 2) -- so the reason strings that
// hatch is supposed to leave in git history actually get counted and read
// somewhere, instead of sitting unaudited forever.
//
// Read-only: no git write, no network, no `orca` call. Never fails a build
// by exit code -- a nonzero count is not "bad," it is the audit trail doing
// its job. The only thing this script fails on is being UNABLE to measure
// (not a repo, git error): that must never collapse into "0 usages," or a
// broken counter reads as a clean history (see docs/enforcement-known-gaps.md
// gap#61/#75/#77 -- "don't fold failure into zero" is the repeat lesson).
//
// The trailer-recognition regexes below are intentionally a byte-for-byte
// copy of review-gate.mjs's extractSkipReview(). review-gate.mjs must not be
// imported or edited for this track (HYK-183 task scope), so this is a
// deliberate duplication, not drift -- if review-gate.mjs's trailer rule
// ever changes, this copy must be updated by hand to match, or the counts
// this script reports silently stop matching what actually bypassed review.
import { execFileSync } from "node:child_process";

const HYK_TAG_RE_GLOBAL = /HYK-\d+/g;
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

// Copied from review-gate.mjs's extractSkipReview -- see file header note.
function extractSkipReview(message) {
  const withoutFences = message.replace(/```[\s\S]*?```/g, "");
  const paragraphs = withoutFences.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const m = last.match(/^[ \t]*skip-review:[ \t]*(.*)$/im);
  return m ? m[1].trim() : null; // null = not a skip directive
}

function parseGitLog(raw) {
  return raw
    .split(RECORD_SEP)
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const firstSep = rec.indexOf(FIELD_SEP);
      const secondSep = rec.indexOf(FIELD_SEP, firstSep + 1);
      return {
        sha: rec.slice(0, firstSep),
        date: rec.slice(firstSep + 1, secondSep),
        message: rec.slice(secondSep + 1),
      };
    });
}

/**
 * Enumerate `skip-review:` trailer usage across a repo's commit history.
 * Returns {ok:true, count, commits:[{sha, date, reason, issues}]} on
 * success, or {ok:false, error} when the measurement itself could not be
 * taken (not a git repo, git failure, etc) -- callers must not treat the
 * latter as zero usages.
 */
export function collectSkipReviewUsage({
  cwd = process.cwd(),
  ref = "HEAD",
} = {}) {
  const format = `%H${FIELD_SEP}%aI${FIELD_SEP}%B${RECORD_SEP}`;
  let raw;
  try {
    raw = execFileSync("git", ["log", ref, `--format=${format}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    return { ok: false, error: `git log failed: ${err.message}` };
  }

  const commits = [];
  for (const { sha, date, message } of parseGitLog(raw)) {
    const reason = extractSkipReview(message);
    if (reason === null) continue;
    const issueMatches = message.match(HYK_TAG_RE_GLOBAL);
    const issues = issueMatches ? [...new Set(issueMatches)] : [];
    commits.push({ sha, date, reason, issues });
  }
  return { ok: true, count: commits.length, commits };
}

function parseArgs(argv) {
  const args = { json: false, ref: "HEAD", repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
  }
  return args;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/skip-review-usage.mjs");
if (invokedDirectly) {
  const { json, ref, repo } = parseArgs(process.argv.slice(2));
  const result = collectSkipReviewUsage({ cwd: repo, ref });

  if (!result.ok) {
    // Measurement failure: distinct exit code from the "0 usages, measured
    // fine" case (exit 0 below), and the JSON shape carries ok:false so a
    // machine reader cannot mistake this for a clean count either.
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`skip-review-usage: measurement failed -- ${result.error}`);
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`skip-review usage: ${result.count} commit(s)`);
    for (const c of result.commits) {
      console.log(
        `  ${c.sha.slice(0, 8)}  ${c.date}  [${c.issues.join(", ") || "no-issue-tag"}]  reason: ${c.reason}`,
      );
    }
  }
  // Observer, not a gate: a nonzero count is a fact to report, never a
  // reason to fail the build (§2 of the HYK-183 task spec).
  process.exit(0);
}
