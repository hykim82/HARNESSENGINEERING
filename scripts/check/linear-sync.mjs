import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// STATUS lives outside the repo (control room), same situation status-fresh.mjs
// documents -- there is no in-repo default that resolves to a real file, so the
// CLI default points straight at the real control room path.
const DEFAULT_STATUS_PATH = "D:\\문서관리\\하네스-관제실\\STATUS.md";

// Linear WorkflowState.type values that mean "not actually open" for this check's purposes.
// "duplicate" (e.g. team HYK's "Duplicate" state) is a closed state too, just not
// "completed"/"canceled" -- without it here, an issue §6 still lists open but Linear
// marked Duplicate would silently miss staleInStatus.
const DONE_TYPES = new Set(["completed", "canceled", "duplicate"]);

// Canonical open/closed state names this repo's Linear team (HYK) actually uses.
// Order doesn't matter for prefix matching here: "In Progress" and "In Review"
// diverge right after "In ", so neither can prefix-match the other's text.
const CANONICAL_STATES = [
  "In Progress",
  "In Review",
  "Todo",
  "Backlog",
  "Done",
  "Canceled",
  "Duplicate",
];

// Normalizes a §6-extracted state string (e.g. "Todo(루프 상설)") to one of
// CANONICAL_STATES by case-insensitive prefix match. Returns null when nothing
// matches -- callers must treat null as "can't judge", never as a drift.
export function normalizeStatusState(text) {
  if (typeof text !== "string") return null;
  const lower = text.trim().toLowerCase();
  for (const name of CANONICAL_STATES) {
    if (lower.startsWith(name.toLowerCase())) return name;
  }
  return null;
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

// Extracts `{ id, state }` entries from STATUS.md's "§6 열린 이슈" block, e.g.:
//   - **HYK-93** STATUS↔Linear 정합성(SoT 기계화) — *Todo, **High*** (...)
// Stops at the next `###` heading (so §7 "직전 완료" etc. never leak in) and
// skips the parenthetical rollup line ("- (HYK-97·100·101... = Done 처리됨...)"),
// which does not match the `- **HYK-<n>**` shape at all.
//
// HYK-235: this is now a thin wrapper over parseStatusOpenIssuesDetailed --
// kept as its own export (same name, same return shape: an array) so the
// pre-existing 20+ callers/tests that only care about the issue list are
// untouched. Callers that need to know *whether §6 was ever entered* or
// *how many lines were silently dropped* use the detailed function instead.
export function parseStatusOpenIssues(statusText) {
  return parseStatusOpenIssuesDetailed(statusText).issues;
}

// Same extraction as parseStatusOpenIssues, but also reports what the plain
// version used to hide (HYK-235 §0/§2-2 "형식 이탈 = 조용한 누락 금지" +
// §2-3 "§6 헤더 매칭 실패" -> UNJUDGABLE):
//   - headerFound: false means the §6 heading itself was never matched --
//     the caller must NOT read that as "0 open issues", it means the parse
//     never entered the block at all (a genuine 0-issue §6 has
//     headerFound: true, issues: []).
//   - skippedCount/skippedSamples: how many *content* lines inside the
//     block failed to match the expected bullet shape, plus up to 5 of
//     them verbatim (truncated) so a human can see what broke, not just a
//     bare number.
// Recognized-and-intentionally-excluded shapes are NOT counted as skipped:
// blank lines, whole-line `<!-- ... -->` comments, and the parenthetical
// Done-rollup line -- these are documented §6 conventions, not deviations.
export function parseStatusOpenIssuesDetailed(statusText) {
  const lines = statusText.split(/\r?\n/);
  const issues = [];
  const skipped = [];
  let inBlock = false;
  let headerFound = false;
  for (const line of lines) {
    if (/^#{2,3}\s*6\)|^#{2,3}.*열린\s*이슈/.test(line)) {
      inBlock = true;
      headerFound = true;
      continue;
    }
    if (inBlock && /^#{2,3}\s/.test(line)) break;
    if (!inBlock) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("<!--")) continue;
    if (/^-\s*\(HYK/.test(trimmed)) continue;
    const m = line.match(/^-\s*\*\*(HYK-\d+)\*\*.*?—\s*\*+([^,*]+)/);
    if (m) {
      issues.push({ id: m[1], state: m[2].trim() });
    } else {
      skipped.push(trimmed.slice(0, 80));
    }
  }
  return {
    issues,
    headerFound,
    skippedCount: skipped.length,
    skippedSamples: skipped.slice(0, 5),
  };
}

// §7 table shape (HYK-235, contract "B" -- read-only connectivity check):
//   | 등록 | 출처 | 내용 | 승격 대상 | 상태 |
//   |---|---|---|---|---|
//   | 2026-08-11 | ... | ... | **신규 이슈 후보** ... HYK-221 ... | 미처리 |
// This is a distinct parser from §6's bullet-list shape -- reusing the §6
// regex would never match a table row. Only rows whose "승격 대상" cell
// contains the literal "신규 이슈 후보" text are extracted as candidates;
// every `HYK-\d+` token mentioned in that row's 내용/승격 대상 cells is
// collected as a "referenced id" for the caller to check against Linear
// (existence check only -- this function makes no network call and has no
// way to).
const SEVEN_HEADER_RE = /^#{2,3}\s*7\)|^#{2,3}.*인수인계/;

function splitTableRow(trimmedLine) {
  let s = trimmedLine;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-+:?$/.test(c));
}

function isHeaderRow(cells) {
  return cells[0] === "등록";
}

// Classifies a single trimmed §7 line that starts with "|" (already
// filtered by the caller) into either a malformed-row sample, a candidate
// row, or neither (separator/header/non-candidate data row) -- pulled out
// of parseStatusSevenCandidates so that function's own branching stays
// under the lint complexity budget.
function classifySevenTableLine(trimmed) {
  if (!trimmed.startsWith("|")) return null; // prose outside the table (e.g. "부팅 규약" paragraph)
  const cells = splitTableRow(trimmed);
  if (isSeparatorRow(cells) || isHeaderRow(cells)) return null;
  if (cells.length !== 5) return { malformed: trimmed.slice(0, 80) };
  const [dateCol, sourceCol, contentCol, promotionCol] = cells;
  if (!/신규\s*이슈\s*후보/.test(promotionCol)) return null;
  const ids = new Set();
  for (const m of `${contentCol} ${promotionCol}`.matchAll(/HYK-\d+/g))
    ids.add(m[0]);
  return {
    candidate: {
      date: dateCol,
      source: sourceCol,
      promotionText: promotionCol,
      referencedIds: [...ids],
    },
  };
}

export function parseStatusSevenCandidates(statusText) {
  const lines = statusText.split(/\r?\n/);
  let inBlock = false;
  let headerFound = false;
  const candidates = [];
  const malformed = [];
  for (const line of lines) {
    if (SEVEN_HEADER_RE.test(line)) {
      inBlock = true;
      headerFound = true;
      continue;
    }
    if (inBlock && /^#{2,3}\s/.test(line)) break;
    if (!inBlock) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--")) continue;
    const outcome = classifySevenTableLine(trimmed);
    if (outcome?.malformed) malformed.push(outcome.malformed);
    if (outcome?.candidate) candidates.push(outcome.candidate);
  }
  return {
    candidates,
    headerFound,
    malformedRowCount: malformed.length,
    malformedRowSamples: malformed.slice(0, 5),
  };
}

// Read-only existence check for §7 candidates' referenced HYK-N ids against
// the *same* Linear issue list already fetched for the §6 diff -- no
// separate API call, so this can never itself perform a write (there is no
// mutation-capable call in this function's body at all, by construction).
// linearIssues: [{ id, ... }] as returned by fetchLinearIssues.
export function checkSevenCandidateReferences(candidates, linearIssues) {
  const linearIds = new Set(linearIssues.map((i) => i.id));
  const checked = [];
  for (const c of candidates) {
    for (const id of c.referencedIds) {
      checked.push({
        id,
        exists: linearIds.has(id),
        fromCandidateDate: c.date,
      });
    }
  }
  return { checked, missing: checked.filter((r) => !r.exists) };
}

// statusIssues: [{ id, state }] from parseStatusOpenIssues.
// linearIssues: [{ id, stateName, stateType }] from the live Linear query.
// staleInStatus: §6 says open, Linear says done/canceled -- the core drift this
//   issue exists to catch (the stale-nag incident, 2026-07-07).
// missingInStatus: Linear says open, §6 has no entry for it at all (reverse gap).
// stateDrift: both sides say the issue is open but disagree on *which* open state
// it's in (e.g. §6="Todo" vs Linear="In Progress"). Judged by stateName text
// comparison, not stateType -- team HYK's "In Progress" (started) and "In Review"
// (backlog) have different types, so type comparison can't tell them apart. This
// is a Tier2 (advisory, fail-open on API/network error -- see loadLinearApiKey)
// check: it never blocks on its own, it only flags for a human to reconcile.
function findStaleInStatus(statusIssues, linearById) {
  const staleInStatus = [];
  for (const s of statusIssues) {
    const li = linearById.get(s.id);
    if (li && DONE_TYPES.has(li.stateType)) {
      staleInStatus.push({
        id: s.id,
        statusState: s.state,
        linearState: li.stateName,
      });
    }
  }
  return staleInStatus;
}

function findMissingInStatus(linearIssues, statusIds) {
  const missingInStatus = [];
  for (const li of linearIssues) {
    if (!DONE_TYPES.has(li.stateType) && !statusIds.has(li.id)) {
      missingInStatus.push({ id: li.id, linearState: li.stateName });
    }
  }
  return missingInStatus;
}

function findStateDrift(statusIssues, linearById) {
  const stateDrift = [];
  for (const s of statusIssues) {
    const li = linearById.get(s.id);
    if (!li || DONE_TYPES.has(li.stateType)) continue;
    const normalized = normalizeStatusState(s.state);
    if (normalized === null) continue; // can't judge -- never a false positive
    if (normalized.toLowerCase() !== (li.stateName ?? "").toLowerCase()) {
      stateDrift.push({
        id: s.id,
        statusState: normalized,
        linearState: li.stateName,
      });
    }
  }
  return stateDrift;
}

export function diffSync(statusIssues, linearIssues) {
  const linearById = new Map(linearIssues.map((i) => [i.id, i]));
  const statusIds = new Set(statusIssues.map((i) => i.id));

  return {
    staleInStatus: findStaleInStatus(statusIssues, linearById),
    missingInStatus: findMissingInStatus(linearIssues, statusIds),
    stateDrift: findStateDrift(statusIssues, linearById),
  };
}

// Maps a diffSync result to this check's CLI exit code -- pulled out as a
// pure function (HYK-131) so the drift-vs-clean contract is unit-testable
// without a live Linear API call: clean is exit 0, any confirmed drift is
// exit 1 (advisory), never exit 2. Still used by resolveSyncVerdict below
// for the "was a real comparison confirmed clean or not" half of the
// question; the "could a comparison be made at all" half (previously a
// silent fail-open exit 0) is HYK-235's resolveSyncVerdict.
export function resolveSyncExitCode({
  staleInStatus,
  missingInStatus,
  stateDrift,
}) {
  const clean =
    staleInStatus.length === 0 &&
    missingInStatus.length === 0 &&
    stateDrift.length === 0;
  return clean ? 0 : 1;
}

// HYK-235 §2-3: closed 3-state judgment (reusing HYK-212's pattern) so
// "couldn't compare" is never silently folded into either "matches" or
// "drifts". Previously every one of the inputs below that made a real
// comparison impossible (no API key, missing STATUS file, network error,
// and -- the one gap this closes -- §6's own heading never matching, which
// used to read exactly like "STATUS has 0 open issues") exited 0 with only
// a stderr warning, i.e. it silently reported as if the check had run and
// found nothing wrong. UNJUDGABLE is a distinct exit code (3) so a
// consumer can no longer treat "couldn't judge" and "judged clean" the
// same way -- see linear-sync.mjs's own file-header note on why exit 2 is
// deliberately not used here (this check has never called
// scripts/check/stop-blocking.mjs's resolveStopBlock and is not wired into
// any Stop-hook-blocking path; exit 3 keeps that true by construction).
export const SYNC_VERDICT = Object.freeze({
  IN_SYNC: "IN_SYNC",
  DRIFT: "DRIFT",
  UNJUDGABLE: "UNJUDGABLE",
});
export const SYNC_VERDICT_EXIT_CODE = Object.freeze({
  IN_SYNC: 0,
  DRIFT: 1,
  UNJUDGABLE: 3,
});

export function resolveSyncVerdict({
  headerFound,
  apiJudgable,
  staleInStatus,
  missingInStatus,
  stateDrift,
}) {
  if (!headerFound || !apiJudgable) return SYNC_VERDICT.UNJUDGABLE;
  const clean =
    resolveSyncExitCode({ staleInStatus, missingInStatus, stateDrift }) === 0;
  return clean ? SYNC_VERDICT.IN_SYNC : SYNC_VERDICT.DRIFT;
}

function readEnvLocalValue(root, key) {
  const envLocalPath = join(root, ".env.local");
  if (!existsSync(envLocalPath)) return null;
  const text = readFileSync(envLocalPath, "utf8");
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m");
  const m = text.match(re);
  if (!m) return null;
  let value = m[1];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value || null;
}

// env: injection point for testability (default process.env). Fail-open path:
// no LINEAR_API_KEY in env and no readable .env.local (or no matching line in
// it) -> returns null, caller treats that as "skip the check", never as a crash.
// Never returns or logs anything about a *missing* key's would-be value.
export function loadLinearApiKey(root, env = process.env) {
  if (env.LINEAR_API_KEY) return { key: env.LINEAR_API_KEY, source: "env" };
  const value = readEnvLocalValue(root, "LINEAR_API_KEY");
  return value ? { key: value, source: ".env.local" } : null;
}

function loadLinearTeamId(root, env = process.env) {
  if (env.LINEAR_TEAM_ID) return env.LINEAR_TEAM_ID;
  return readEnvLocalValue(root, "LINEAR_TEAM_ID");
}

async function fetchLinearIssues(apiKey, teamId) {
  const query = teamId
    ? `query Issues($teamId: ID) {
        issues(filter: { team: { id: { eq: $teamId } } }, first: 250) {
          nodes { identifier state { name type } }
        }
      }`
    : `query Issues {
        issues(first: 250) {
          nodes { identifier state { name type } }
        }
      }`;
  const variables = teamId ? { teamId } : undefined;

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(
      `Linear API error: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const nodes = json.data?.issues?.nodes ?? [];
  return nodes
    .filter((n) => /^HYK-\d+$/.test(n.identifier))
    .map((n) => ({
      id: n.identifier,
      stateName: n.state?.name ?? "",
      stateType: n.state?.type ?? "",
    }));
}

function parseStatusPathArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status") return args[i + 1];
  }
  return undefined;
}

function reportSixWarnings(sixResult) {
  if (sixResult.skippedCount === 0) return;
  console.warn(
    `linear-sync: §6 format-deviation -- parsed ${sixResult.issues.length} line(s), skipped ${sixResult.skippedCount} line(s) that did not match the expected shape:`,
  );
  for (const s of sixResult.skippedSamples) console.warn(`  skipped: ${s}`);
}

function reportSevenMalformedWarnings(sevenResult) {
  if (sevenResult.malformedRowCount === 0) return;
  console.warn(
    `linear-sync: §7 format-deviation -- ${sevenResult.malformedRowCount} table row(s) did not match the expected 5-column shape:`,
  );
  for (const s of sevenResult.malformedRowSamples)
    console.warn(`  malformed: ${s}`);
}

// §7 is read-only connectivity checking only (HYK-234 gate-3 contract "B"):
// look up whether referenced HYK-N ids exist in the same Linear issue list
// already fetched for the §6 diff. No separate call, no write, ever.
function reportSevenReferenceCheck(sevenResult, linearIssues) {
  if (sevenResult.candidates.length === 0) return;
  const refCheck = checkSevenCandidateReferences(
    sevenResult.candidates,
    linearIssues,
  );
  console.log(
    `linear-sync: §7 candidates checked (read-only, 0 writes) -- ${sevenResult.candidates.length} candidate row(s), ${refCheck.checked.length} referenced id(s), ${refCheck.missing.length} not found in Linear.`,
  );
  for (const m of refCheck.missing) {
    console.warn(
      `  §7 reference not found in Linear: ${m.id} (from row dated ${m.fromCandidateDate})`,
    );
  }
}

function reportDriftDetails({ staleInStatus, missingInStatus, stateDrift }) {
  console.error(`linear-sync verdict: ${SYNC_VERDICT.DRIFT} detected:`);
  for (const s of staleInStatus) {
    console.error(
      `  staleInStatus: ${s.id} listed open in STATUS (state="${s.statusState}") but Linear state is ` +
        `'${s.linearState}' (done/canceled) -- STATUS §6 needs updating`,
    );
  }
  for (const m of missingInStatus) {
    console.error(
      `  missingInStatus: ${m.id} is open in Linear ('${m.linearState}') but has no entry in STATUS §6`,
    );
  }
  for (const d of stateDrift) {
    console.error(
      `  stateDrift: ${d.id} open in both but STATUS §6 says '${d.statusState}' while Linear is ` +
        `'${d.linearState}' -- §6 state needs updating`,
    );
  }
}

// Loads §6/§7 from STATUS.md and fetches Linear -- returns everything the
// verdict/reporting stage needs, or null if a precondition (API key, STATUS
// file) already forces UNJUDGABLE without ever reading STATUS.md.
async function gatherSyncInputs(root, statusPath) {
  const tokenInfo = loadLinearApiKey(root);
  if (!tokenInfo) {
    console.warn(
      "linear-sync: no LINEAR_API_KEY found (env or repo-root .env.local) -- UNJUDGABLE, cannot compare against Linear.",
    );
    console.log(
      `linear-sync verdict: ${SYNC_VERDICT.UNJUDGABLE} (reason: no_api_key)`,
    );
    return null;
  }
  if (!existsSync(statusPath)) {
    console.warn(
      `linear-sync: STATUS file not found at ${statusPath} -- UNJUDGABLE, cannot compare against Linear.`,
    );
    console.log(
      `linear-sync verdict: ${SYNC_VERDICT.UNJUDGABLE} (reason: status_file_missing)`,
    );
    return null;
  }

  const statusText = readFileSync(statusPath, "utf8");
  const sixResult = parseStatusOpenIssuesDetailed(statusText);
  const sevenResult = parseStatusSevenCandidates(statusText);
  reportSixWarnings(sixResult);
  reportSevenMalformedWarnings(sevenResult);

  let linearIssues = [];
  let apiJudgable = true;
  try {
    linearIssues = await fetchLinearIssues(
      tokenInfo.key,
      loadLinearTeamId(root),
    );
  } catch (err) {
    console.warn(
      `linear-sync: Linear API/network error -- UNJUDGABLE, cannot compare against Linear. (${err.message})`,
    );
    apiJudgable = false;
  }
  if (apiJudgable) reportSevenReferenceCheck(sevenResult, linearIssues);

  return { sixResult, apiJudgable, linearIssues };
}

function reportVerdictAndExit(
  verdict,
  { sixResult, staleInStatus, missingInStatus, stateDrift },
) {
  if (verdict === SYNC_VERDICT.UNJUDGABLE) {
    const reason = !sixResult.headerFound
      ? "section_6_header_not_found"
      : "api_error";
    if (!sixResult.headerFound) {
      console.warn(
        "linear-sync: STATUS §6 heading not found -- UNJUDGABLE, this is NOT the same as '0 open issues'.",
      );
    }
    console.log(
      `linear-sync verdict: ${SYNC_VERDICT.UNJUDGABLE} (reason: ${reason})`,
    );
  } else if (verdict === SYNC_VERDICT.IN_SYNC) {
    console.log(
      `linear-sync verdict: ${SYNC_VERDICT.IN_SYNC} -- ${sixResult.issues.length} open issue(s) in STATUS §6 match Linear.`,
    );
  } else {
    // HYK-131: advisory normalization. A confirmed drift is a signal for a
    // human/ORCH to reconcile against live Linear, not something ORCH can
    // always self-repair -- exit 1, never exit 2, matching status-fresh.mjs/
    // clear-safe-check.mjs/controlroom-fresh.mjs's own non-blocking severity.
    reportDriftDetails({ staleInStatus, missingInStatus, stateDrift });
  }
  process.exit(SYNC_VERDICT_EXIT_CODE[verdict]);
}

async function main() {
  const statusPathArg = parseStatusPathArg(process.argv.slice(2));
  const root = repoRoot();
  const statusPath = statusPathArg ?? DEFAULT_STATUS_PATH;

  const inputs = await gatherSyncInputs(root, statusPath);
  if (!inputs) {
    process.exit(SYNC_VERDICT_EXIT_CODE.UNJUDGABLE);
    return;
  }

  const { sixResult, apiJudgable, linearIssues } = inputs;
  const { staleInStatus, missingInStatus, stateDrift } = diffSync(
    sixResult.issues,
    linearIssues,
  );
  const verdict = resolveSyncVerdict({
    headerFound: sixResult.headerFound,
    apiJudgable,
    staleInStatus,
    missingInStatus,
    stateDrift,
  });
  reportVerdictAndExit(verdict, {
    sixResult,
    staleInStatus,
    missingInStatus,
    stateDrift,
  });
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/linear-sync.mjs");
if (invokedDirectly) {
  main();
}
