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
const CANONICAL_STATES = ["In Progress", "In Review", "Todo", "Backlog", "Done", "Canceled", "Duplicate"];

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
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// Extracts `{ id, state }` entries from STATUS.md's "§6 열린 이슈" block, e.g.:
//   - **HYK-93** STATUS↔Linear 정합성(SoT 기계화) — *Todo, **High*** (...)
// Stops at the next `###` heading (so §7 "직전 완료" etc. never leak in) and
// skips the parenthetical rollup line ("- (HYK-97·100·101... = Done 처리됨...)"),
// which does not match the `- **HYK-<n>**` shape at all.
export function parseStatusOpenIssues(statusText) {
  const lines = statusText.split(/\r?\n/);
  const issues = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^#{2,3}\s*6\)|^#{2,3}.*열린\s*이슈/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^#{2,3}\s/.test(line)) break;
    if (!inBlock) continue;
    const m = line.match(/^-\s*\*\*(HYK-\d+)\*\*.*?—\s*\*+([^,*]+)/);
    if (m) {
      issues.push({ id: m[1], state: m[2].trim() });
    }
  }
  return issues;
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
export function diffSync(statusIssues, linearIssues) {
  const linearById = new Map(linearIssues.map((i) => [i.id, i]));
  const statusIds = new Set(statusIssues.map((i) => i.id));

  const staleInStatus = [];
  for (const s of statusIssues) {
    const li = linearById.get(s.id);
    if (li && DONE_TYPES.has(li.stateType)) {
      staleInStatus.push({ id: s.id, statusState: s.state, linearState: li.stateName });
    }
  }

  const missingInStatus = [];
  for (const li of linearIssues) {
    if (!DONE_TYPES.has(li.stateType) && !statusIds.has(li.id)) {
      missingInStatus.push({ id: li.id, linearState: li.stateName });
    }
  }

  const stateDrift = [];
  for (const s of statusIssues) {
    const li = linearById.get(s.id);
    if (!li || DONE_TYPES.has(li.stateType)) continue;
    const normalized = normalizeStatusState(s.state);
    if (normalized === null) continue; // can't judge -- never a false positive
    if (normalized.toLowerCase() !== (li.stateName ?? "").toLowerCase()) {
      stateDrift.push({ id: s.id, statusState: normalized, linearState: li.stateName });
    }
  }

  return { staleInStatus, missingInStatus, stateDrift };
}

// Maps a diffSync result to this check's CLI exit code -- pulled out as a
// pure function (HYK-131) so the drift-vs-clean contract is unit-testable
// without a live Linear API call: clean is exit 0, any confirmed drift is
// exit 1 (advisory), never exit 2 -- the fail-open paths (missing key,
// missing STATUS file, network error) exit 0 directly before this is ever
// reached and are untouched by this function.
export function resolveSyncExitCode({ staleInStatus, missingInStatus, stateDrift }) {
  const clean = staleInStatus.length === 0 && missingInStatus.length === 0 && stateDrift.length === 0;
  return clean ? 0 : 1;
}

function readEnvLocalValue(root, key) {
  const envLocalPath = join(root, ".env.local");
  if (!existsSync(envLocalPath)) return null;
  const text = readFileSync(envLocalPath, "utf8");
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m");
  const m = text.match(re);
  if (!m) return null;
  let value = m[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
    throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const nodes = json.data?.issues?.nodes ?? [];
  return nodes
    .filter((n) => /^HYK-\d+$/.test(n.identifier))
    .map((n) => ({ id: n.identifier, stateName: n.state?.name ?? "", stateType: n.state?.type ?? "" }));
}

async function main() {
  const args = process.argv.slice(2);
  let statusPathArg;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status") statusPathArg = args[++i];
  }
  const root = repoRoot();
  const statusPath = statusPathArg ?? DEFAULT_STATUS_PATH;

  const tokenInfo = loadLinearApiKey(root);
  if (!tokenInfo) {
    console.warn(
      "linear-sync: no LINEAR_API_KEY found (env or repo-root .env.local) -- fail-open, skipping check.",
    );
    process.exit(0);
    return;
  }

  if (!existsSync(statusPath)) {
    console.warn(`linear-sync: STATUS file not found at ${statusPath} -- fail-open, skipping check.`);
    process.exit(0);
    return;
  }

  const statusText = readFileSync(statusPath, "utf8");
  const statusIssues = parseStatusOpenIssues(statusText);
  const teamId = loadLinearTeamId(root);

  let linearIssues;
  try {
    linearIssues = await fetchLinearIssues(tokenInfo.key, teamId);
  } catch (err) {
    console.warn(`linear-sync: Linear API/network error -- fail-open, skipping check. (${err.message})`);
    process.exit(0);
    return;
  }

  const { staleInStatus, missingInStatus, stateDrift } = diffSync(statusIssues, linearIssues);

  if (resolveSyncExitCode({ staleInStatus, missingInStatus, stateDrift }) === 0) {
    console.log(`linear-sync ok: ${statusIssues.length} open issue(s) in STATUS §6 match Linear.`);
    process.exit(0);
    return;
  }

  console.error("linear-sync drift detected:");
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
  // HYK-131: advisory normalization. A confirmed drift is a signal for a
  // human/ORCH to reconcile against live Linear, not something ORCH can
  // always self-repair (the drift may mean STATUS is wrong, or it may mean
  // Linear is) -- exit 1, never exit 2, matching status-fresh.mjs/
  // clear-safe-check.mjs/controlroom-fresh.mjs's own non-blocking severity.
  // This corrects a contract drift: this file previously exited 2 here while
  // docs/enforcement-v1.md and this harness's own advisory classification
  // already documented it as Tier 2/advisory.
  process.exit(resolveSyncExitCode({ staleInStatus, missingInStatus, stateDrift }));
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/linear-sync.mjs");
if (invokedDirectly) {
  main();
}
