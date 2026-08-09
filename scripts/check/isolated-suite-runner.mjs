// HYK-208: runs the CI-canonical test suite inside a fresh, per-run clone of
// the committed repo state, instead of against whatever checkout invoked it.
// Rationale (docs/hyk206-parallel-test-isolation-findings-2026-08-08.md):
// 34 test files snapshot `git status --porcelain` before/after and assert
// zero diff, on the assumption that nothing else touches that checkout
// while they run. That assumption is false whenever another actor (a
// person, ORCH, a tool) runs `git status`/edits a tracked file/creates an
// untracked file in the SAME checkout during the run -- the snapshot window
// catches it and the test fails for a reason that has nothing to do with
// the code under test. Running the suite in a disposable clone gives each
// run true exclusive ownership of the checkout those 34 files snapshot, so
// external interference to the source repo can no longer be observed by
// them -- while a test that dirties ITS OWN (cloned) checkout and fails to
// clean up still trips the same safety nets, because those nets test
// `git rev-parse --show-toplevel` of the process's own cwd, which is the
// clone once `node --test` is spawned with `cwd: <clone>`.
//
// Approved tradeoff (task HYK-208 §2): only committed content is tested --
// `git clone` never carries uncommitted changes. This is intentional, not a
// bug; §3-4 requires this runner to say so on every run, plus which commit
// it tested, so nobody is left wondering why an uncommitted fix "didn't
// show up."
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows can hand back an 8.3 short-name form of %TEMP% (e.g.
// "ADMINI~1"). At least one existing test (hyk171-cycle3a-mutation.test.mjs
// S6) builds a path from `new URL(...).pathname` without decoding it, so a
// literal "~" in the clone path turns into a literal "%7E" and the read
// 404s -- not a bug this task's scope covers (that file is admission-core-
// adjacent and off limits, see coder-task.md §0), so the isolated clone
// must simply not live under a short-name path in the first place.
function longFormTmpdir() {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    return tmpdir();
  }
}

// Mirrors .github/workflows/enforce.yml's canonical check command exactly:
// four directories, each non-recursive (scripts/relay/*.test.mjs excludes
// scripts/relay/adapters/ -- that's why adapters gets its own entry).
export const TEST_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/relay/adapters",
  "scripts/supervisor",
];

export function collectTestFiles(
  root,
  dirs = TEST_DIRS,
  { readdir = readdirSync } = {},
) {
  const files = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const name of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
      files.push(join(dir, name));
    }
  }
  return files;
}

// The one-line disclosure required by task §3-4: which commit was tested,
// and an explicit statement that uncommitted content was not.
export function formatBanner({ sha, dirty }) {
  const base = `[isolated-suite-runner] tested commit ${sha} -- ran against an isolated clone of committed HEAD only, uncommitted changes are NOT included in this run`;
  if (!dirty) return base;
  return `${base}\n[isolated-suite-runner] NOTE: the source checkout has uncommitted changes -- they were excluded from this run`;
}

function repoRootOf(cwd, execFile) {
  return execFile("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// Orchestrates one full run: clone committed HEAD -> run the suite in the
// clone -> report -> always clean up (unless `keep`). Returns the child
// process's exit code so the CLI entry point can propagate it verbatim.
export function runIsolatedSuite({
  sourceRoot,
  keep = false,
  execFile = execFileSync,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const root = sourceRoot ?? repoRootOf(process.cwd(), execFile);
  const sha = execFile("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const porcelain = execFile("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const dirty = porcelain.trim().length > 0;

  const cloneDir = mkdtempSync(join(longFormTmpdir(), "hyk208-isolated-"));
  try {
    execFile("git", ["clone", "--quiet", root, cloneDir], { encoding: "utf8" });
    const files = collectTestFiles(cloneDir);
    log(formatBanner({ sha, dirty }));
    log(
      `[isolated-suite-runner] clone: ${cloneDir} (${files.length} test file(s))`,
    );
    const result = spawn(process.execPath, ["--test", ...files], {
      cwd: cloneDir,
      stdio: "inherit",
    });
    return result.status ?? 1;
  } finally {
    if (keep) {
      log(`[isolated-suite-runner] --keep set: leaving clone at ${cloneDir}`);
    } else {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/isolated-suite-runner.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let sourceRoot;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root") sourceRoot = args[++i];
    else if (args[i] === "--keep") keep = true;
  }
  const exitCode = runIsolatedSuite({ sourceRoot, keep });
  process.exit(exitCode);
}
