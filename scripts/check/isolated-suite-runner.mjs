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
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTapSummaryCounts,
  writeRunnerReceipt,
} from "./runner-receipt-writer.mjs";

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

// Fail-closed (HYK-208 2R, review finding): a directory this runner expects
// to exist in the clone (TEST_DIRS) that can't be read is NOT skipped --
// skipping would silently run fewer suites than the CI-canonical command
// and still report green. An unreadable expected directory means the clone
// is incomplete or the layout changed; either way this must be a loud
// failure, not a quiet one.
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
    } catch (err) {
      throw new Error(
        `isolated-suite-runner: required test directory unreadable in the clone: ${dir} (${err.message}) -- fail-closed, refusing to silently run fewer suites than the CI-canonical command`,
        { cause: err },
      );
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

// HYK-411 §2-1: the runner writes its OWN observed exit code to a receipt
// file -- a downstream pipe (`npm test | tail`) can rewrite what the shell
// sees as ITS exit code, but it cannot reach back into this process and
// change what this process writes to its own file. Deliberately
// unconditional on runnerExit === 0 (§2-1 "실패했다고 영수증을 안 쓰면
// 안 된다" -- a red run must leave a receipt too, or this fix only ever
// proves the case nobody needed proving). Never throws: a failure to read
// the tap summary or write the receipt must never be mistaken for -- and
// must never suppress -- the suite's own real exit code (same "never
// throws past this point" posture as consumption-receipt-writer.mjs's
// writeConsumptionReceipt).
function emitRunnerReceipt({
  root,
  sha,
  runnerExit,
  tapPath,
  readFile,
  writeReceipt,
  nowMs,
  log,
}) {
  let counts = { tests: null, pass: null, fail: null, skip: null };
  try {
    counts = parseTapSummaryCounts(readFile(tapPath, "utf8"));
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: could not read tap summary at ${tapPath} (${err.message}) -- receipt will carry null counts`,
    );
  }
  try {
    const { path } = writeReceipt({
      harnessDir: join(root, ".harness"),
      runnerExit,
      counts,
      headCommit: sha,
      finishedAtMs: nowMs(),
    });
    log(`[isolated-suite-runner] runner receipt written -> ${path}`);
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to write runner receipt (${err.message}) -- consumption-side fail-closed gate (relay-handshake.mjs) will treat this as a missing receipt`,
    );
  }
}

// Builds the argv for the in-clone `node --test` invocation. A second,
// machine-readable tap reporter destination rides alongside the human-facing
// spec reporter (HYK-411) -- `node --test` supports repeated
// --test-reporter/--test-reporter-destination pairs, so both fire from one
// process without disturbing the real-time inherited stdio a human watches.
function buildNodeTestArgs(files, tapPath) {
  return [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapPath}`,
    ...files,
  ];
}

// Runs the suite inside the already-prepared clone and returns its exit
// code. Isolated into its own function so runIsolatedSuite's own branching
// stays low (max-lines-per-function/complexity gate, coder-task.md quality
// bar) -- this is the only place `result.status`'s absence (signal-killed
// child) is normalized to a non-zero exit.
function spawnSuiteInClone({ spawn, cloneDir, files, tapPath }) {
  const result = spawn(process.execPath, buildNodeTestArgs(files, tapPath), {
    cwd: cloneDir,
    stdio: "inherit",
    // HYK-403: marks this run as having gone through a canonical entry
    // point, so canonical-suite-entrypoint.test.mjs (scripts/check, swept up
    // by any construction of the four-directory glob, including a
    // hand-built one) can tell a real `npm test` / CI run apart from someone
    // hand-typing `node --test <glob>` directly against a live checkout --
    // the exact shape that leaked into the control room on 2026-08-30.
    env: {
      ...process.env,
      HYK403_CANONICAL_SUITE_ENTRYPOINT: "isolated-suite-runner",
    },
  });
  return result.status ?? 1;
}

// Removes the two scratch directories this run made. Isolated so the
// `keep` branch doesn't count against runIsolatedSuite's own complexity.
function cleanupRunDirs({ keep, log, cloneDir, tapDir }) {
  rmSync(tapDir, { recursive: true, force: true });
  if (keep) {
    log(`[isolated-suite-runner] --keep set: leaving clone at ${cloneDir}`);
    return;
  }
  rmSync(cloneDir, { recursive: true, force: true });
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
  collectFiles = collectTestFiles,
  mkdtemp = mkdtempSync,
  readFile = readFileSync,
  writeReceipt = writeRunnerReceipt,
  nowMs = Date.now,
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
  // HYK-411: this tap destination lives OUTSIDE cloneDir on purpose --
  // writing it inside cloneDir would add an untracked file to the very
  // checkout the 34 git-status-porcelain safety-net tests (see this file's
  // own header) snapshot from inside, turning this runner's own
  // instrumentation into a false positive for those tests.
  const tapDir = mkdtemp(join(longFormTmpdir(), "hyk411-tap-"));
  const tapPath = join(tapDir, "runner-output.tap");
  try {
    execFile("git", ["clone", "--quiet", root, cloneDir], { encoding: "utf8" });
    const files = collectFiles(cloneDir);
    log(formatBanner({ sha, dirty }));
    log(
      `[isolated-suite-runner] clone: ${cloneDir} (${files.length} test file(s))`,
    );
    const runnerExit = spawnSuiteInClone({ spawn, cloneDir, files, tapPath });

    emitRunnerReceipt({
      root,
      sha,
      runnerExit,
      tapPath,
      readFile,
      writeReceipt,
      nowMs,
      log,
    });

    return runnerExit;
  } finally {
    cleanupRunDirs({ keep, log, cloneDir, tapDir });
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
  const unrecognized = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root") {
      if (i + 1 >= args.length) {
        unrecognized.push(args[i]);
      } else {
        sourceRoot = args[++i];
      }
    } else if (args[i] === "--keep") {
      keep = true;
    } else {
      unrecognized.push(args[i]);
    }
  }
  if (unrecognized.length > 0) {
    console.error(
      `[isolated-suite-runner] unrecognized argument(s): ${unrecognized.join(" ")} -- refusing to silently ignore unknown arguments and run against the wrong target`,
    );
    process.exit(1);
  }
  const exitCode = runIsolatedSuite({ sourceRoot, keep });
  process.exit(exitCode);
}
