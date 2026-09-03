// node-api-gap-guard: static check for Node built-in APIs used in this
// repo's source that do not exist on the CI-pinned Node major version
// (node-target-version.mjs's checkNodeVersionDrift is the single source of
// truth for which major that is; this file defaults to reading it, but
// accepts an explicit `targetMajor` for tests).
//
// Motivation (HYK-417 §2, real incident, PR #242 1R): a detector used
// `fs.globSync` (added in Node 22) at MODULE LOAD TIME. The author's and
// every reviewer's local machine ran Node 26, where that call succeeds, so
// the file loaded fine and its tests ran green everywhere locally. CI runs
// Node 20, where `fs.globSync` does not exist -- the `import` line itself
// threw, the module never finished loading, and NONE of that file's test
// cases ever registered or ran. This is categorically worse than a failing
// test: it is invisible everywhere except CI, because "does this API exist
// on Node 20" cannot be observed by running Node 26 and reading the result.
//
// What this guard IS: a hand-curated denylist of specific Node-builtin API
// call/import shapes that were added in a Node major version newer than the
// declared target, matched against this repo's own .mjs/.js/.cjs source
// with narrow regexes (call-form or import-form, not bare identifier
// matches -- see BANNED_APIS comments for why bare-word matching was
// rejected).
//
// What this guard is NOT (see runNodeApiGapGuard's return `notes` and
// coder.md's "못 잡는 계열" section for the full list): it is not a Node
// version emulator, it does not execute code, and its list is manually
// curated -- an API added in a newer Node major that isn't in BANNED_APIS
// below will NOT be caught. This file does not claim "complete detection."
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, extname } from "node:path";
import { checkNodeVersionDrift } from "./node-target-version.mjs";

// Each entry's `pattern` intentionally matches a CALL or IMPORT shape, never
// a bare identifier. Rationale, proven necessary by this repo's own prior
// art (scripts/check/time-judgment-now-injection.test.mjs's `(tj-node20)`
// test, HYK-414 2R): that file's regression test and this guard's own test
// file both discuss `fs.globSync` in prose, Korean commentary, and as a
// quoted regex literal -- a bare `\bglobSync\b` match would flag every one
// of those lines as a false positive and this guard would never be green
// against its own repo (coder-task.md §4 completion condition 7 requires
// it to be). Call-form -- the identifier immediately followed by real
// whitespace then an opening paren, not an escaped paren inside someone
// else's regex literal -- and import-form (a destructured specifier
// actually `from "node:fs"`, contiguous) do not overlap with prose
// mentions.
export const BANNED_APIS = [
  {
    id: "fs.globSync",
    minNode: 22,
    patterns: [
      /\bfs\.globSync\s*\(/,
      /\bglobSync\s*\(/,
      /\{[^}]*\bglobSync\b[^}]*\}\s*from\s*["']node:fs["']/,
    ],
    note: "fs.globSync -- added Node 22.0.0. PR #242 1R incident cause (HYK-417 §2).",
  },
  {
    id: "fs.glob",
    minNode: 22,
    patterns: [/\bfs\.glob\s*\(/, /\bfs\.promises\.glob\s*\(/],
    // Deliberately narrower than the previous entry: no bare
    // destructured-import form is matched here (a plain "glob" pulled out
    // of node:fs by name), because "glob" alone is too common an
    // identifier name (this repo and many others have local
    // variables/params called plain "glob") to match without a real
    // false-positive risk. This is a known, accepted gap -- see coder.md's
    // "못 잡는 계열" list.
    note: "fs.glob / fs.promises.glob -- added Node 22.0.0, same family as the previous entry.",
  },
  {
    id: "Object.groupBy",
    minNode: 21,
    patterns: [/\bObject\.groupBy\s*\(/],
    note: "Object.groupBy -- added Node 21.0.0.",
  },
  {
    id: "Map.groupBy",
    minNode: 21,
    patterns: [/\bMap\.groupBy\s*\(/],
    note: "Map.groupBy -- added Node 21.0.0.",
  },
  {
    id: "Array.fromAsync",
    minNode: 22,
    patterns: [/\bArray\.fromAsync\s*\(/],
    note: "Array.fromAsync -- added Node 22.0.0.",
  },
  {
    id: "process.getBuiltinModule",
    minNode: 22,
    patterns: [/\bprocess\.getBuiltinModule\s*\(/],
    note: "process.getBuiltinModule -- added Node 22.3.0.",
  },
  {
    id: "node:sqlite",
    minNode: 22,
    patterns: [
      /from\s*["']node:sqlite["']/,
      /require\(\s*["']node:sqlite["']\s*\)/,
    ],
    note: "node:sqlite -- added Node 22.5.0 (experimental).",
  },
  {
    id: "crypto.hash",
    minNode: 21,
    patterns: [/\bcrypto\.hash\s*\(/],
    note: "crypto.hash -- one-shot digest helper added Node 21.7.0.",
  },
];

const SOURCE_EXT = new Set([".mjs", ".js", ".cjs"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

// Recursively lists source files under `root`, skipping SKIP_DIR_NAMES.
// Uses plain readdirSync + manual recursion (not the `{ recursive: true }`
// option) so this file's own file-walking works identically on every Node
// major back to well below the target -- keeping the guard's own
// implementation free of the exact kind of version assumption it exists to
// catch elsewhere is deliberate, not an oversight.
export function listSourceFiles(
  root,
  { readdir = readdirSync, stat = statSync } = {},
) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let info;
      try {
        info = stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        stack.push(full);
      } else if (info.isFile() && SOURCE_EXT.has(extname(name))) {
        out.push(full);
      }
    }
  }
  return out;
}

// Scans one file's TEXT for every banned API whose `minNode` is strictly
// greater than `targetMajor`. Returns one violation entry per (api, first
// matching pattern) hit, each carrying the 1-indexed line number of the
// first match for that pattern, so a human reading the guard's output can
// jump straight to the offending line.
export function scanTextForBannedApis(
  text,
  { file, targetMajor, banned = BANNED_APIS } = {},
) {
  const violations = [];
  for (const api of banned) {
    if (api.minNode <= targetMajor) continue;
    for (const pattern of api.patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const upTo = text.slice(0, match.index);
      const line = upTo.split("\n").length;
      violations.push({
        file,
        id: api.id,
        minNode: api.minNode,
        targetMajor,
        line,
        note: api.note,
      });
      break; // one hit per api id is enough to flag the file; avoid duplicate noise from sibling patterns
    }
  }
  return violations;
}

// Orchestrates a full-repo (or full-subtree) scan. `targetMajor` defaults to
// whatever node-target-version.mjs's checkNodeVersionDrift resolves from
// package.json -- callers (tests, isolated fixtures) can override it
// directly so they don't need a real package.json/workflow pair on disk.
export function runNodeApiGapGuard({
  cwd,
  targetMajor,
  listFiles = listSourceFiles,
  readFile = readFileSync,
  banned = BANNED_APIS,
} = {}) {
  let resolvedMajor = targetMajor;
  if (resolvedMajor === undefined) {
    const drift = checkNodeVersionDrift({ cwd });
    if (!drift.ok || drift.enginesMajor === null) {
      return {
        ok: false,
        reason: `node-api-gap-guard: cannot resolve a target Node major version (${drift.reason}) -- fail-closed, refusing to scan without a known target`,
        violations: [],
      };
    }
    resolvedMajor = drift.enginesMajor;
  }

  const files = listFiles(cwd);
  const violations = [];
  for (const absPath of files) {
    let text;
    try {
      text = readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(cwd, absPath).replace(/\\/g, "/");
    violations.push(
      ...scanTextForBannedApis(text, {
        file: relPath,
        targetMajor: resolvedMajor,
        banned,
      }),
    );
  }

  if (violations.length > 0) {
    return {
      ok: false,
      reason:
        `node-api-gap-guard: ${violations.length} Node-${resolvedMajor}-unavailable API use(s) found -- ` +
        violations
          .map((v) => `${v.file}:${v.line} (${v.id}, needs Node ${v.minNode}+)`)
          .join(", "),
      violations,
      targetMajor: resolvedMajor,
      scanned: files.length,
    };
  }

  return {
    ok: true,
    reason: `node-api-gap-guard: ${files.length} file(s) scanned, target Node ${resolvedMajor} -- no banned API use found`,
    violations: [],
    targetMajor: resolvedMajor,
    scanned: files.length,
  };
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

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/node-api-gap-guard.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let cwd = repoRoot();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") cwd = args[++i];
  }
  const result = runNodeApiGapGuard({ cwd });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
