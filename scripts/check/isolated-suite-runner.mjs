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
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_STATUS,
  allocateRunSlot,
  parseTapSummaryCounts,
  writeNumberedRunnerReceipt,
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

// HYK-473 §2-1: `node --test` with no `--test-concurrency` defaults to one
// worker per CPU core (this file previously passed zero concurrency flags
// at all -- 0 hits on `--test-concurrency` grep, confirmed before this
// round). Each worker is its own child process with its own V8 heap, so on
// a machine already under memory pressure from unrelated processes,
// core-count-wide concurrency is exactly the shape HYK-468 4R traced its 3
// consecutive forced-kill runs to (dropped_at evidence: ~3.6-3.8GB/16.7GB
// free, steady across all 3 attempts -- not a spike this runner caused).
// Halving the core count keeps real parallelism (this suite has ~50+ test
// files; concurrency 1 would serialize all of them) while roughly halving
// the peak number of concurrent heaps; max(1, floor(...)) keeps 1-2 core
// machines from resolving to a 0 or negative concurrency.
export function resolveConcurrency({ cpuCount = cpus().length } = {}) {
  return Math.max(1, Math.floor(cpuCount / 2));
}

// §2-1 "상한 값이 러너 로그 첫 줄에 값으로 찍히게 하라": this is logged
// before formatBanner's line in runIsolatedSuite, making it the literal
// first line a human watching the run sees.
export function formatConcurrencyBanner({ concurrency, reason }) {
  return `[isolated-suite-runner] test-concurrency=${concurrency} (${reason})`;
}

const DEFAULT_CONCURRENCY_REASON =
  "default: max(1, floor(cpu-count/2)) -- bounds peak concurrent node --test child heaps after HYK-468 4R's 3 consecutive OOM kills, traced to unbounded (core-count-wide) concurrency";
const OVERRIDE_CONCURRENCY_REASON = "explicit --concurrency override";

// HYK-473 §2-2: distinguishes "the suite ran to completion and node --test
// itself reported a result" from "no result was ever produced" -- the
// latter must never be recorded as TESTS_FAILED, because that is a
// different fact (§1 of coder-task.md: a downstream reader must be able to
// tell "fail 0 but not green" apart from a real red run). Decided
// structurally on spawnSync's own signal/status/error fields, in that
// order -- never by matching any message/log text (HYK-262: a one-
// character wording change must not silently flip a judgment). Empirically
// verified (this round, Windows, node -- spawnSync with timeout+SIGKILL):
// a forced kill sets result.signal (e.g. "SIGKILL") and usually also
// result.error (e.g. ETIMEDOUT) with result.status left null; a real
// non-zero exit sets only result.status, leaving signal/error null/absent.
//
// HYK-477 §2-3 (검토자 지적, 2026-09-16): 마지막 분기가 원래
// `result.status ?? 1`로 TESTS_FAILED를 내고 있었다 -- 그런데
// `result.status === null`이면서 signal/error도 둘 다 falsy인 경우(위
// 실측 주석의 "usually" -- 강제 종료가 signal/error 없이 status만 null로
// 남는 드문 조합)는 node --test가 애초에 실제 완료 결과를 낸 적이
// 없다는 뜻이다. 그걸 "실제로 어떤 코드로 실패했다"(TESTS_FAILED)로
// 접으면 §2-2가 없애려는 바로 그 사실 왜곡(측정 불능 -> 시험 실패)이
// 이 분류기 안에서 재발한다. status가 null/undefined인 경우만 따로
// MEASUREMENT_UNAVAILABLE_OOM으로 분리하고, 진짜 숫자 status(0이 아닌
// 실제 종료 코드)만 TESTS_FAILED로 남긴다 -- exitCode도 이제
// `result.status`를 그대로 쓴다(그 시점에는 null일 수 없으므로 `?? 1`
// 폴백이 더 이상 필요 없다, 의미 없는 폴백을 남겨두면 "왜 1인가"를
// 다시 헷갈리게 한다).
export function classifySpawnOutcome(result) {
  if (result.signal) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  if (result.error) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  if (result.status === 0) {
    return { status: RUNNER_STATUS.OK, exitCode: 0 };
  }
  if (result.status == null) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  return { status: RUNNER_STATUS.TESTS_FAILED, exitCode: result.status };
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
//
// HYK-485 §2-1: also writes a run-scoped numbered copy (allocateRunSlot's
// receiptPath, computed BEFORE spawn so its sibling logPath can ride node
// --test's own argv -- see runIsolatedSuite/spawnSuiteInClone) alongside
// the unconditionally-preserved "latest" write above. Both writes share the
// SAME counts/finishedAtMs (computed once here) so the numbered copy is a
// byte-for-byte-except-path snapshot of the same run, not two independently
// timed observations of it. Guarded in its OWN try/catch, separate from the
// latest-file write above: a numbered-copy failure must not affect (and
// must not be masked by) the latest write's own success/failure, and
// neither may ever affect the suite's real exit code.
function emitRunnerReceipt({
  root,
  sha,
  runnerExit,
  runnerStatus,
  tapPath,
  runSlot,
  readFile,
  writeReceipt,
  writeNumberedReceipt = writeNumberedRunnerReceipt,
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
  const finishedAtMs = nowMs();
  try {
    const { path } = writeReceipt({
      harnessDir: join(root, ".harness"),
      runnerExit,
      runnerStatus,
      counts,
      headCommit: sha,
      finishedAtMs,
    });
    log(`[isolated-suite-runner] runner receipt written -> ${path}`);
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to write runner receipt (${err.message}) -- consumption-side fail-closed gate (relay-handshake.mjs) will treat this as a missing receipt`,
    );
  }
  if (!runSlot.receiptPath) return;
  try {
    const { path } = writeNumberedReceipt({
      receiptPath: runSlot.receiptPath,
      runnerExit,
      runnerStatus,
      counts,
      headCommit: sha,
      finishedAtMs,
    });
    log(`[isolated-suite-runner] per-run numbered receipt written -> ${path}`);
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to write numbered receipt run${runSlot.runNumber} (${err.message}) -- HYK-485 §2-2's per-round comparison will see this run's evidence as missing, i.e. measurement-unavailable, not as a fabricated pass`,
    );
  }
}

// Builds the argv for the in-clone `node --test` invocation. A second,
// machine-readable tap reporter destination rides alongside the human-facing
// spec reporter (HYK-411) -- `node --test` supports repeated
// --test-reporter/--test-reporter-destination pairs, so both fire from one
// process without disturbing the real-time inherited stdio a human watches.
//
// HYK-485 §2-1: a THIRD reporter pair (spec -> logPath, when logPath is
// given) rides the same mechanism to produce the persistent "러너 stdout
// 로그" (full-runner-<N>.log) -- same format as what the human sees live on
// stdout, written directly by node --test itself to a durable file. This
// was chosen deliberately over capturing/teeing the child's stdio in this
// process: switching spawnSuiteInClone's stdio away from "inherit" (e.g. to
// "pipe" + manual re-emit) would buffer output until the child exits,
// losing the real-time view a human watches during a run that can take
// minutes -- a regression this task's scope does not ask for and §5 does
// not authorize. Adding a reporter destination changes nothing about
// stdio/spawn semantics at all: node --test writes it as a plain side
// effect of its own three-reporter fan-out, `stdio: "inherit"` below is
// completely untouched.
function buildNodeTestArgs(files, tapPath, concurrency, logPath) {
  const args = [
    "--test",
    `--test-concurrency=${concurrency}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapPath}`,
  ];
  if (logPath) {
    args.push("--test-reporter=spec", `--test-reporter-destination=${logPath}`);
  }
  args.push(...files);
  return args;
}

// Runs the suite inside the already-prepared clone and returns its
// classified outcome (§2-2: {status, exitCode}, never a bare exit code --
// see classifySpawnOutcome). Isolated into its own function so
// runIsolatedSuite's own branching stays low (max-lines-per-function/
// complexity gate, coder-task.md quality bar).
function spawnSuiteInClone({
  spawn,
  cloneDir,
  files,
  tapPath,
  concurrency,
  logPath,
}) {
  const result = spawn(
    process.execPath,
    buildNodeTestArgs(files, tapPath, concurrency, logPath),
    {
      cwd: cloneDir,
      stdio: "inherit",
      // HYK-403: marks this run as having gone through a canonical entry
      // point, so canonical-suite-entrypoint.test.mjs (scripts/check, swept
      // up by any construction of the four-directory glob, including a
      // hand-built one) can tell a real `npm test` / CI run apart from
      // someone hand-typing `node --test <glob>` directly against a live
      // checkout -- the exact shape that leaked into the control room on
      // 2026-08-30.
      env: {
        ...process.env,
        HYK403_CANONICAL_SUITE_ENTRYPOINT: "isolated-suite-runner",
      },
    },
  );
  return classifySpawnOutcome(result);
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

// Resolves the concurrency cap and logs it as the run's first line (§2-1
// "첫 줄"). Isolated so its branching doesn't count against
// runIsolatedSuite's own complexity gate.
function resolveAndLogConcurrency({ concurrency, resolveConcurrencyFn, log }) {
  const resolveFn = resolveConcurrencyFn ?? resolveConcurrency;
  const resolvedConcurrency = concurrency ?? resolveFn();
  const reason =
    concurrency != null
      ? OVERRIDE_CONCURRENCY_REASON
      : DEFAULT_CONCURRENCY_REASON;
  log(formatConcurrencyBanner({ concurrency: resolvedConcurrency, reason }));
  return resolvedConcurrency;
}

// No numbered artifacts this run (allocation failed, or nothing asked for
// them) -- a real object with null fields rather than a bare `null` so
// call sites read `runSlot.logPath`/`runSlot.receiptPath` directly instead
// of needing optional-chaining at every use (keeps runIsolatedSuite's own
// branch count down; each `?.` is itself a branch for the complexity gate).
const NO_RUN_SLOT = Object.freeze({
  runNumber: null,
  receiptPath: null,
  logPath: null,
});

// HYK-485 §2-1: allocates this run's numbered-artifact slot BEFORE spawn
// (its logPath must ride node --test's own argv, see buildNodeTestArgs) --
// isolated into its own function so a failure here degrades gracefully
// instead of crashing the whole run before the real suite ever starts.
// Never throws: allocation infra (mkdir/exclusive-create) is not the thing
// this runner exists to prove green or red -- a failure here just means
// this run won't have numbered artifacts (the "latest" runner-receipt.json
// is written separately, unaffected either way).
function resolveRunSlot({
  harnessDir,
  allocateRunSlotFn = allocateRunSlot,
  log,
}) {
  try {
    // a stub/test double is allowed to signal "no slot" with a bare
    // `null`/`undefined` return -- normalize it to the real sentinel so
    // every downstream reader can rely on `runSlot.logPath` existing.
    return allocateRunSlotFn({ harnessDir }) ?? NO_RUN_SLOT;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to allocate a per-run artifact slot (${err.message}) -- this run will not produce numbered runner-receipt-run<N>.json/full-runner-<N>.log artifacts; the latest runner-receipt.json is unaffected`,
    );
    return NO_RUN_SLOT;
  }
}

// Orchestrates one full run: clone committed HEAD -> run the suite in the
// clone -> report -> always clean up (unless `keep`). Returns the child
// process's exit code so the CLI entry point can propagate it verbatim.
export function runIsolatedSuite({
  sourceRoot,
  keep = false,
  concurrency,
  execFile = execFileSync,
  spawn = spawnSync,
  log = console.log,
  collectFiles = collectTestFiles,
  mkdtemp = mkdtempSync,
  readFile = readFileSync,
  writeReceipt = writeRunnerReceipt,
  allocateRunSlotFn,
  writeNumberedReceipt,
  nowMs = Date.now,
  resolveConcurrencyFn,
} = {}) {
  const resolvedConcurrency = resolveAndLogConcurrency({
    concurrency,
    resolveConcurrencyFn,
    log,
  });
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
  const harnessDir = join(root, ".harness");
  const runSlot = resolveRunSlot({ harnessDir, allocateRunSlotFn, log });
  try {
    execFile("git", ["clone", "--quiet", root, cloneDir], { encoding: "utf8" });
    const files = collectFiles(cloneDir);
    log(formatBanner({ sha, dirty }));
    log(
      `[isolated-suite-runner] clone: ${cloneDir} (${files.length} test file(s))`,
    );
    const outcome = spawnSuiteInClone({
      spawn,
      cloneDir,
      files,
      tapPath,
      concurrency: resolvedConcurrency,
      logPath: runSlot.logPath,
    });

    emitRunnerReceipt({
      root,
      sha,
      runnerExit: outcome.exitCode,
      runnerStatus: outcome.status,
      tapPath,
      runSlot,
      readFile,
      writeReceipt,
      writeNumberedReceipt,
      nowMs,
      log,
    });

    return outcome.exitCode;
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
  let concurrency;
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
    } else if (args[i] === "--concurrency") {
      if (i + 1 >= args.length) {
        unrecognized.push(args[i]);
      } else {
        const raw = args[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          console.error(
            `[isolated-suite-runner] --concurrency must be a positive integer, got: ${raw} -- refusing to silently fall back to a default that could mask an operator's intended cap`,
          );
          process.exit(1);
        }
        concurrency = n;
      }
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
  const exitCode = runIsolatedSuite({ sourceRoot, keep, concurrency });
  process.exit(exitCode);
}
