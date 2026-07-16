import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

// Extensions this gate actually inspects. Lint (ESLint) only understands
// ESM .mjs (the only JS flavor this repo has -- no .js/.cjs/.ts exist
// outside node_modules). Format (Prettier) additionally covers .js/.json/.md
// since those exist and Prettier can format all of them.
const LINT_EXT_RE = /\.mjs$/;
const FMT_EXT_RE = /\.(mjs|js|json|md)$/;

// A push event's `before` SHA is all zeros on the very first push of a new
// branch (no prior commit to diff against) -- GitHub's documented sentinel
// for "there is no base," not a real SHA. Treating it as usable would
// silently diff against a nonexistent commit; treating it as "no changes"
// would silently pass a first-push full-repo state. Fail-closed instead.
const NULL_SHA_RE = /^0+$/;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function parseNameStatus(out) {
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      // Plain add/modify: "M\tpath". Rename/copy: "R100\told\tnew" -- the
      // new path is what should be linted, so take the last field either way.
      return fields[fields.length - 1];
    });
}

// Resolves the set of changed files this gate must inspect. `mode: "ci"`
// diffs a required, externally-supplied base SHA against HEAD (the base is
// never inferred locally -- CI must inject it, see enforce.yml). `mode:
// "staged"` diffs the index against HEAD (the local pre-commit path).
// `--diff-filter=ACMR` deliberately excludes deletions: a deleted file has
// nothing left to lint, and D-only "changes" must not count toward scope.
export function resolveChangedFiles({ cwd, mode, baseSha, gitDiff } = {}) {
  const diff =
    gitDiff ??
    ((args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim());

  if (mode === "ci") {
    if (!baseSha || NULL_SHA_RE.test(baseSha)) {
      return {
        ok: false,
        reason:
          `quality-check: CI base SHA missing or null (got ${JSON.stringify(baseSha)}) -- ` +
          `fail-closed. A misconfigured workflow must not silently pass by treating ` +
          `"no base" as "no changes."`,
      };
    }
    try {
      const out = diff([
        "diff",
        "--name-status",
        "--diff-filter=ACMR",
        `${baseSha}...HEAD`,
      ]);
      return { ok: true, files: parseNameStatus(out) };
    } catch (err) {
      return {
        ok: false,
        reason: `quality-check: git diff against base SHA ${baseSha} failed -- fail-closed (${err.message})`,
      };
    }
  }

  if (mode === "staged") {
    try {
      const out = diff([
        "diff",
        "--cached",
        "--name-status",
        "--diff-filter=ACMR",
      ]);
      return { ok: true, files: parseNameStatus(out) };
    } catch (err) {
      return {
        ok: false,
        reason: `quality-check: git diff --cached failed -- fail-closed (${err.message})`,
      };
    }
  }

  return {
    ok: false,
    reason: `quality-check: unknown mode ${JSON.stringify(mode)} (expected "staged" or "ci")`,
  };
}

function defaultRunTool(tool, args, cwd) {
  const binPath =
    tool === "eslint"
      ? join(cwd, "node_modules", "eslint", "bin", "eslint.js")
      : join(cwd, "node_modules", "prettier", "bin", "prettier.cjs");
  try {
    const output = execFileSync(process.execPath, [binPath, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { exitCode: 0, output };
  } catch (err) {
    return {
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// The gate itself: changed-files-only lint + format check ("축소안" /
// changed-files-green ratchet, HYK-148 coder-2 measurement -> coder-3
// wiring). Files untouched by the change under test are never inspected --
// that is the intended amnesty for this repo's pre-existing violations
// (coder-2 baseline: 41 lint errors, 78/113 unformatted files). Only files
// that appear in the changed set are held to a zero-violation bar.
export function runQualityCheck({
  cwd,
  mode,
  baseSha,
  runTool = defaultRunTool,
  gitDiff,
} = {}) {
  const changed = resolveChangedFiles({ cwd, mode, baseSha, gitDiff });
  if (!changed.ok) return changed;

  const existing = changed.files.filter((f) => existsSync(join(cwd, f)));
  const lintTargets = existing.filter((f) => LINT_EXT_RE.test(f));
  const fmtTargets = existing.filter((f) => FMT_EXT_RE.test(f));

  if (lintTargets.length === 0 && fmtTargets.length === 0) {
    return {
      ok: true,
      reason:
        "quality-check: no changed files in scope (.mjs/.js/.json/.md) -- vacuously green",
    };
  }

  const results = [];
  if (lintTargets.length > 0) {
    results.push({
      tool: "eslint",
      targets: lintTargets,
      ...runTool("eslint", lintTargets, cwd),
    });
  }
  if (fmtTargets.length > 0) {
    results.push({
      tool: "prettier",
      targets: fmtTargets,
      ...runTool("prettier", ["--check", ...fmtTargets], cwd),
    });
  }

  const failed = results.filter((r) => r.exitCode !== 0);
  if (failed.length > 0) {
    return {
      ok: false,
      reason:
        `quality-check: ${failed.map((f) => f.tool).join(", ")} failed on changed file(s) -- ` +
        failed.map((f) => `[${f.tool}] ${f.output}`.trim()).join(" | "),
    };
  }

  return {
    ok: true,
    reason: `quality-check: ${lintTargets.length} file(s) linted, ${fmtTargets.length} file(s) format-checked -- all clean`,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/quality-check.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let mode = "staged";
  let baseSha = process.env.QUALITY_BASE_SHA;
  let cwd = repoRoot();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--base-sha") baseSha = args[++i];
    else if (args[i] === "--cwd") cwd = args[++i];
  }
  const result = runQualityCheck({ cwd, mode, baseSha });
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
