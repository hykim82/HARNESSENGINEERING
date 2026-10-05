// installer-external-path-callers.mjs -- HYK-209-installer-mismatch-report-1 ⓐ (축 A).
//
// Closes the gap that the installer's presence-requirement list (install.mjs,
// the one constant that guarded it) left open: a file the control-room dispatch
// pipeline (dispatch-worker.ps1,
// OUTSIDE this repo) invokes BY PATH, while nothing in this repo imports it, so
// the import-closure check (install-copylist-closure.test.mjs) cannot see its
// absence from the installer copy list.
//
// This module does NOT depend on that constant. It reads the in-repo control-room
// patch documents (docs/control-room-patches/*.md) -- the place this repo records
// the exact by-path call sites the control-room script contains -- extracts every
// repo-relative `scripts/<check|relay|supervisor>/<name>.mjs` path that such a
// document shows being called, and requires each one's file name to be present in
// the matching installer copy list (imported from install.mjs, not regex-scraped).
//
// Definition of a call site (the "문면" this axis accepts as a call):
//   Join-Path $Worktree "scripts/<dir>/<name>.mjs"
// i.e. the control-room script builds the path from the worktree root and runs it.
// Any other wording (a bare path in prose, a mention in a comment) is NOT a call.
//
// Fail-closed: zero extracted call sites is a VIOLATION, not a pass -- if the
// docs disappear or the wording drifts, the axis must not go silently green.
//
// Honest limits (also in the result file):
//  - It sees only what the docs write. A control-room script call whose wording
//    is not in the docs is invisible to this axis. The fail-closed branch only
//    catches the case where the WHOLE extraction goes empty.
//  - Exceptions are named and reasoned here, never wildcarded.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENFORCEMENT_CHECK_FILES,
  ENFORCEMENT_RELAY_FILES,
  ENFORCEMENT_SUPERVISOR_FILES,
} from "../../templates/harness-init/install.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const CONTROL_PATCH_DOCS_DIR = path.join(
  REPO_ROOT,
  "docs",
  "control-room-patches",
);

// Call-site wording this axis treats as a by-path call (see header).
export const CALL_SITE_PATTERN =
  /Join-Path\s+\$Worktree\s+"(scripts\/(check|relay|supervisor)\/[A-Za-z0-9._-]+\.mjs)"/g;

// The installer copy list each directory must be covered by.
export const COPY_LIST_BY_DIR = {
  check: ENFORCEMENT_CHECK_FILES,
  relay: ENFORCEMENT_RELAY_FILES,
  supervisor: ENFORCEMENT_SUPERVISOR_FILES,
};

// Named, reasoned exceptions. Keyed by repo-relative path. An exception is
// honored only when its reason is non-empty (checked by the test).
// HYK-209-installer-admission-closure-1: the admission-cli.mjs entry was
// removed here once the scope decision landed and the file (with its three
// relative imports) joined ENFORCEMENT_SUPERVISOR_FILES. Empty on purpose:
// an empty exception map must not behave as a wildcard (see the test that
// pins this).
export const KNOWN_EXCEPTIONS = {};

// Returns [{ rel, file, line }] for every by-path call site in the docs.
export function extractExternalPathCallers(docsDir = CONTROL_PATCH_DOCS_DIR) {
  const out = [];
  const docNames = readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const name of docNames) {
    const lines = readFileSync(path.join(docsDir, name), "utf8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const match of line.matchAll(CALL_SITE_PATTERN)) {
        out.push({ rel: match[1], file: name, line: idx + 1 });
      }
    });
  }
  return out;
}

// Returns violations as [{ kind, rel, sites }], one per distinct path.
// kind: "NO_CALLERS_EXTRACTED" (fail-closed) | "NOT_IN_COPY_LIST" | "UNKNOWN_DIR".
export function findCallerViolations(
  callers,
  lists = COPY_LIST_BY_DIR,
  exceptions = KNOWN_EXCEPTIONS,
) {
  if (callers.length === 0) {
    return [{ kind: "NO_CALLERS_EXTRACTED", rel: "(none)", sites: [] }];
  }
  const byRel = new Map();
  for (const c of callers) {
    if (!byRel.has(c.rel)) byRel.set(c.rel, []);
    byRel.get(c.rel).push(`${c.file}:${c.line}`);
  }
  const violations = [];
  for (const [rel, sites] of byRel) {
    const [, dir, base] = rel.split("/");
    if (exceptions[rel]) continue;
    if (!lists[dir]) {
      violations.push({ kind: "UNKNOWN_DIR", rel, sites });
    } else if (!lists[dir].includes(base)) {
      violations.push({ kind: "NOT_IN_COPY_LIST", rel, sites });
    }
  }
  return violations;
}

function main() {
  const callers = extractExternalPathCallers();
  const violations = findCallerViolations(callers);
  console.log(
    `by-path callers: ${callers.length} site(s), ${new Set(callers.map((c) => c.rel)).size} distinct path(s)`,
  );
  for (const v of violations) {
    console.log(`VIOLATION ${v.kind}: ${v.rel} <- ${v.sites.join(", ")}`);
  }
  console.log(violations.length === 0 ? "ALL_OK" : "FAIL");
  process.exit(violations.length === 0 ? 0 : 1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
