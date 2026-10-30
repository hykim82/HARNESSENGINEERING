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
import {
  execFileSync,
  spawn as spawnAsync,
  spawnSync,
} from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { cpus, freemem, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNNER_STATUS,
  allocateRunSlot,
  hasGenuineTapCompletion,
  parseGenuineTapSummaryCounts,
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
// five directories, each non-recursive (scripts/relay/*.test.mjs excludes
// scripts/relay/adapters/ -- that's why adapters gets its own entry).
// templates/harness-init (HYK-209 runner-testdirs-1): the installer's own
// suites were outside the CI-canonical run until this entry; it holds a
// single *.test.mjs, so the non-recursive rule needs no further entry.
export const TEST_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/relay/adapters",
  "scripts/supervisor",
  "templates/harness-init",
];

// Fail-closed (HYK-208 2R, review finding): a directory this runner expects
// to exist in the clone (TEST_DIRS) that can't be read is NOT silently
// absorbed into a smaller (but still green) run. HYK-439 §2 ⓐ/ⓑ (installed
// targets, e.g. an editor repo, never carry every TEST_DIRS folder -- an
// install only copies ENFORCEMENT_CHECK_FILES-listed files, and a folder
// with none of those in it is simply never created) splits this into two
// cases, discriminated on the THROWN error's own `.code`, never on message
// text (HYK-262: a one-character wording change must not silently flip a
// judgment):
//   - ENOENT (the folder itself is absent): loudly SKIPPED -- one fixed,
//     greppable log line (mirrors splitSerialFamily's own
//     "not present in this checkout, skipped" phrasing) and this directory
//     contributes zero files, never a thrown error. This is the one case
//     this round makes non-fatal.
//   - anything else (e.g. EACCES/a permission failure): still fail-closed,
//     byte-for-byte the prior throw -- an expected directory that exists
//     but can't be read means the clone is broken/incomplete, not a normal
//     installed-target fact, so this must stay a loud failure.
// A SECOND fail-closed guard below covers the case no single per-directory
// check can: every TEST_DIRS folder absent (presentCount === 0) would
// otherwise collect zero files and report an empty, green run -- exactly
// the "silently run fewer suites... and still report green" failure mode
// this function's fail-closed posture exists to prevent in the first
// place, just triggered by ALL folders being absent instead of one being
// unreadable.
export function collectTestFiles(
  root,
  dirs = TEST_DIRS,
  { readdir = readdirSync, log = () => {} } = {},
) {
  const files = [];
  let presentCount = 0;
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdir(join(root, dir));
    } catch (err) {
      if (err.code === "ENOENT") {
        log(
          `[isolated-suite-runner] required test directory "${dir}" is not present in this checkout, skipped`,
        );
        continue;
      }
      throw new Error(
        `isolated-suite-runner: required test directory unreadable in the clone: ${dir} (${err.message}) -- fail-closed, refusing to silently run fewer suites than the CI-canonical command`,
        { cause: err },
      );
    }
    presentCount += 1;
    for (const name of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
      files.push(join(dir, name));
    }
  }
  if (dirs.length > 0 && presentCount === 0) {
    throw new Error(
      `isolated-suite-runner: none of the ${dirs.length} TEST_DIRS folder(s) are present in this checkout (${dirs.join(", ")}) -- fail-closed, refusing to silently run zero suites and still report green`,
    );
  }
  return files;
}

// HYK-439 §2 ⓐ (2R, replaces 1R's runner-serial-family.json): the
// install-target child-spawnSync test family (memory-heavy, real
// `node --test` grandchildren) runs in a SEPARATE, serial
// (--test-concurrency=1) pass so it never overlaps the main pass's own
// concurrent children. 1R shipped this list as a sibling JSON data file,
// read via a `readFileSync` that is fail-closed on anything short of a
// valid, non-empty array -- but an installed target only gets this .mjs
// file (templates/harness-init/install.mjs's ENFORCEMENT_CHECK_FILES never
// listed the JSON), so every installed `npm test` ENOENT-crashed before a
// single test ran (HYK-439 1R coder.md §3-1, the NEEDS_INPUT this round
// resolves). A hardcoded module constant has no load step and therefore no
// load-failure path at all -- the two names below are the exact pair 1R's
// standalone free-memory measurement empirically confirmed (coder.md §1-4:
// install-net-closure.test.mjs -63.4MB, install-g1-adapter-list.test.mjs
// -546.7MB; install-copylist-closure.test.mjs's -12.7MB drop is pure
// static-import analysis with zero real child spawnSync, so it stays out
// of the family). Runtime membership is now an intersection against this
// run's own discovered files (splitSerialFamily below) -- a name here that
// this checkout never collected (exactly what happens on every installed
// target, which has no templates/harness-init/*.test.mjs at all) is logged
// and skipped, never fail-closed; staleness of this list AGAINST THIS
// REPO's own files is instead asserted once, in isolated-suite-runner.test
// .mjs (§2 ⓓ), where a CI run can catch a renamed/removed family file.
export const SERIAL_FAMILY_LIST = [
  "templates/harness-init/install-net-closure.test.mjs",
  "templates/harness-init/install-g1-adapter-list.test.mjs",
];

// `path.join` on Windows emits backslashes for the directory-prefix
// boundary (verified this round) even though TEST_DIRS/the list above both
// use forward slashes -- every comparison between a collected file path and
// a list entry normalizes through this first, or a real family file would
// silently fail to match on Windows (the file this round primarily targets).
function normalizeRelPath(p) {
  return p.replace(/\\/g, "/");
}

// §2 ⓒ "기계 검사 칸": every file this run actually collected must end up in
// EXACTLY ONE of the two passes -- never both (a silent double-run) and
// never neither (a silent drop, the exact failure mode collectTestFiles's
// own fail-closed readdir guard one level up exists to prevent). Takes the
// three arrays as plain data (not computed internally) so a test can feed a
// deliberately broken partition and watch this throw, independent of
// whether splitSerialFamily's own partition logic below could ever actually
// produce one -- defense in depth, not a redundant no-op.
export function assertSerialFamilyPartition({
  allFiles,
  mainFiles,
  familyFiles,
}) {
  const normAll = allFiles.map(normalizeRelPath);
  const allSet = new Set(normAll);
  const counts = new Map();
  for (const f of [...mainFiles, ...familyFiles].map(normalizeRelPath)) {
    counts.set(f, (counts.get(f) ?? 0) + 1);
    if (!allSet.has(f)) {
      throw new Error(
        `isolated-suite-runner: serial-family split references "${f}" which is not one of this run's collected test files -- fail-closed`,
      );
    }
  }
  for (const f of normAll) {
    const count = counts.get(f) ?? 0;
    if (count === 0) {
      throw new Error(
        `isolated-suite-runner: test file "${f}" is missing from BOTH passes after serial-family split -- fail-closed, refusing to silently run fewer suites than collected`,
      );
    }
    if (count > 1) {
      throw new Error(
        `isolated-suite-runner: test file "${f}" appears in BOTH passes after serial-family split (${count}x) -- fail-closed, refusing a double-run`,
      );
    }
  }
}

// Splits `files` (this run's real collected file list) into the main pass
// and the serial-family pass per `familyList`, intersected against what
// this run actually collected (HYK-439 §2 ⓑ, 2R). `familyList` is now a
// hardcoded, this-repo-shaped constant (SERIAL_FAMILY_LIST) applied
// UNCONDITIONALLY to every run, including ones against an installed
// target's checkout that never has templates/harness-init/*.test.mjs at
// all -- so a list entry absent from `files` is no longer fail-closed (1R's
// bug: that path crashed the entire runner on every installed target). It
// is logged once, via `logFn`, with a fixed, greppable phrase so a run's
// log never silently shrinks the family with no trace -- then skipped. A
// DUPLICATE entry (a typo'd edit to the constant itself, not a checkout
// difference) stays fail-closed: that is this module's own bug, not a
// per-checkout fact. The resulting `familyFiles` is always a sub-sequence
// of `files` and `mainFiles` is exactly its complement, so
// assertSerialFamilyPartition below can never actually fire from THIS
// function's own construction -- it stays wired in as defense in depth
// (§2 ⓒ, its own header) so a mutation here is still caught mechanically.
// HYK-439 §2 ⓕ row 3 (2R): assertPartitionFn is injectable (default = the
// real assertSerialFamilyPartition) purely so a test can SPY on this call
// and prove it still fires -- the wiring the comment above calls "defense
// in depth" is otherwise unreachable-by-construction from this function's
// own normal data flow (every other test here can never make it throw),
// so without an injectable seam, deleting this call outright would pass
// every existing test silently. A real caller never overrides this.
export function splitSerialFamily({
  files,
  familyList,
  logFn = () => {},
  assertPartitionFn = assertSerialFamilyPartition,
}) {
  const fileSet = new Set(files.map(normalizeRelPath));
  const seen = new Set();
  const matched = new Set();
  for (const entry of familyList) {
    const norm = normalizeRelPath(entry);
    if (seen.has(norm)) {
      throw new Error(
        `isolated-suite-runner: serial-family list entry "${entry}" is listed more than once -- fail-closed`,
      );
    }
    seen.add(norm);
    if (!fileSet.has(norm)) {
      logFn(
        `[isolated-suite-runner] serial-family entry "${entry}" is not present in this checkout, skipped`,
      );
      continue;
    }
    matched.add(norm);
  }
  // Both partitions are filtered from `files` directly (not rebuilt from
  // familyList) so their relative order is always this run's own collected
  // order, never the (unrelated) order the family constant happens to list
  // its entries in.
  const mainFiles = files.filter((f) => !matched.has(normalizeRelPath(f)));
  const familyFiles = files.filter((f) => matched.has(normalizeRelPath(f)));
  assertPartitionFn({ allFiles: files, mainFiles, familyFiles });
  return { mainFiles, familyFiles };
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

// HYK-439 §2 ⓐ (1R, 1주 시험 임시 규칙 2026-10-29 19:47 책임자 판정):
// resolveConcurrency above (cpu-count/2) is kept exactly as-is -- existing
// callers/tests of it (hyk473-runner-cap.test.mjs) are untouched by this
// round -- but the REAL default path a CLI invocation takes no longer uses
// it (runIsolatedSuite's useAutoConcurrency flag below, set unconditionally
// by this file's own CLI entry point). This function replaces it there:
// it resolves 1 vs 2 from TWO free-memory samples, `intervalMs` apart
// (default 30s, real wall clock), never the old cpu-count default -- a
// measurement failure of ANY kind (freememFn throws, returns a
// non-finite value, sleepFn throws) resolves to 1 -- the conservative
// side, never 2 -- with a reason string saying why (coder-task.md §2 ⓐ
// "측정 실패 = 2 가 아니라 «1 + 사유»").
//
// Stays fully synchronous (no async/await) -- this file's whole call graph
// (execFileSync/spawnSync) already is, and keeping it that way means
// runIsolatedSuite's return type/the ~15 existing tests that call it
// without overriding this seam need no changes at all (see sleepFn below:
// defaultSleepSync blocks via Atomics.wait, never a real setTimeout the
// event loop would need to be alive for).
export const AUTO_CONCURRENCY_LOW_MEM_THRESHOLD_MB = 3000;
export const AUTO_CONCURRENCY_SAMPLE_INTERVAL_MS = 30_000;
export const AUTO_CONCURRENCY_SAMPLE_COUNT = 2;

function bytesToMb(bytes) {
  return bytes / (1024 * 1024);
}

function roundTo1Decimal(n) {
  return Math.round(n * 10) / 10;
}

// A synchronous blocking sleep with no subprocess/timer dependency --
// Atomics.wait on a throwaway SharedArrayBuffer blocks the calling thread
// for real wall-clock `ms` (verified this round on this Node/platform),
// which is exactly what "30초 간격 2회" (real time between the two samples)
// needs without turning this file's synchronous call graph async.
function defaultSleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, Math.max(0, Number(ms) || 0));
}

export function resolveAutoConcurrency({
  freememFn = freemem,
  sleepFn = defaultSleepSync,
  sampleCount = AUTO_CONCURRENCY_SAMPLE_COUNT,
  intervalMs = AUTO_CONCURRENCY_SAMPLE_INTERVAL_MS,
  lowMemThresholdMb = AUTO_CONCURRENCY_LOW_MEM_THRESHOLD_MB,
} = {}) {
  let samples;
  try {
    samples = [];
    for (let i = 0; i < sampleCount; i++) {
      if (i > 0) sleepFn(intervalMs);
      const mb = bytesToMb(freememFn());
      if (!Number.isFinite(mb)) {
        throw new Error(`freememFn returned a non-finite value: ${mb}`);
      }
      samples.push(mb);
    }
  } catch (err) {
    return {
      concurrency: 1,
      startFreeMb: [],
      reason: `auto-select: free-memory sampling failed (${err.message}) -- measurement failure resolves to 1 (conservative), never the old cpu-count default`,
    };
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const concurrency = avg < lowMemThresholdMb ? 1 : 2;
  const roundedSamples = samples.map(roundTo1Decimal);
  return {
    concurrency,
    startFreeMb: roundedSamples,
    reason: `auto-select: start free avg ${roundTo1Decimal(avg)}MB across ${samples.length} sample(s) ${JSON.stringify(roundedSamples)} (threshold ${lowMemThresholdMb}MB) -> concurrency ${concurrency}`,
  };
}

// §2 ⓑ: the serial-family pass always runs at this concurrency, regardless
// of what the main pass's --concurrency resolved to.
export const SERIAL_FAMILY_CONCURRENCY = 1;

// HYK-477 §1-1: this runner's own `--test-concurrency` cap only bounds the
// ONE layer of `node --test` children it spawns directly. ORCH's real
// observation (coder-task.md §0): some of those files spawn ANOTHER
// `node --test` from inside themselves (a nested self-sweep,
// hyk359-ambient-env-regression.test.mjs's runProductionSweep chief among
// them) -- that grandchild inherits process.env but NOT this runner's
// `--concurrency` CLI flag, so it fell back to its own hardcoded/default
// concurrency regardless of how low the outer cap was set, undermining the
// whole point of lowering it. Exporting the resolved cap as an env var lets
// any such nested spawn point read it back and clamp itself, without this
// runner needing to know those spawn points exist.
export const NESTED_CONCURRENCY_ENV_VAR = "HARNESS_TEST_CONCURRENCY";

// A nested spawn point calls this with the concurrency IT would otherwise
// use (`desired`) and gets back `desired`, unless an ambient
// HARNESS_TEST_CONCURRENCY is both a valid positive integer AND smaller --
// min, never max, so a nested caller can never use this mechanism to raise
// its own concurrency above what it already intended (coder-task.md §1-1
// "상한을 올리는 방향으로는 쓰이지 않게 하라"). A missing/empty/invalid env
// value is silently ignored (falls back to `desired`) rather than thrown --
// this function runs at the START of a spawn call a real test suite depends
// on, so a malformed ambient env var must degrade to "no cap propagated",
// never abort the run.
export function resolveNestedConcurrency(desired, { env = process.env } = {}) {
  const raw = env[NESTED_CONCURRENCY_ENV_VAR];
  if (raw == null || raw === "") return desired;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return desired;
  return Math.min(desired, n);
}

// §2-1 "상한 값이 러너 로그 첫 줄에 값으로 찍히게 하라": this text is the
// run's literal first log() line in the match/UNKNOWN case (no node-version
// warning to report). HYK-464 2R P2-6 (책임자 판정 2026-10-16 16:4x §1,
// 원문 "A"): a real MISMATCH is REPORTABLE, never a block, and §2-1's
// "첫 줄" contract from HYK-473 must also hold for a mismatched run -- so
// rather than a mismatch warning getting its OWN separate log() call ahead
// of this banner (1R's shape, which pushed the banner to the SECOND line,
// contradicting HYK-473 3칸's "literal first line"), `formatFirstRunnerLine`
// below appends the warning to the END of THIS SAME banner text -- one
// log() call, one line, both facts. This function's own text never
// changes; only whether a caller appends a suffix to it does.
export function formatConcurrencyBanner({ concurrency, reason }) {
  return `[isolated-suite-runner] test-concurrency=${concurrency} (${reason})`;
}

// HYK-464 2R P2-6: the single first-line formatter. A match/UNKNOWN warning
// (null, or a string that does not start with "MISMATCH") appends nothing
// -- the banner alone is the first line, exactly HYK-473's prior contract,
// unchanged for every existing caller that never has a real mismatch. A
// real MISMATCH appends " -- WARNING: NODE_VERSION_MISMATCH: <detail>" to
// the SAME string (책임자 판정 원문 토큰 "WARNING: NODE_VERSION_MISMATCH" --
// 1R이 쓴 "WARNING: MISMATCH:" 모양을 이 토큰으로 맞춘다). The receipt's
// own `node_version_warning` field is NOT re-worded here (still "MISMATCH:
// ..." as resolveNodeVersionWarning returns it) -- only the human-facing
// log LINE's token changes; this keeps old receipt consumers/relay-
// handshake-runner-receipt.test.mjs's fixed-shape assertions unaffected
// (coder-task.md §2 ⓓ leaves that choice to this round's judgment).
function formatFirstRunnerLine({ concurrency, reason, nodeVersionWarning }) {
  const banner = formatConcurrencyBanner({ concurrency, reason });
  if (!nodeVersionWarning?.startsWith("MISMATCH")) return banner;
  const detail = nodeVersionWarning.replace(
    /^MISMATCH:/,
    "NODE_VERSION_MISMATCH:",
  );
  return `${banner} -- WARNING: ${detail}`;
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
// HYK-477 §2-3 2R (검토 P1-1 재반려, 2026-09-16, rounds/REVIEW-r1.md): 이
// 저장소가 실제로 겪는 강제 종료는 위 `result.status == null` 분기로 잡히지
// 않는다 -- Windows에는 POSIX 시그널이 없어 spawnSync가 강제 종료를
// result.signal이 아니라 result.status에 숫자(0xFFFFFFFF 등)로 채워
// 돌려주기 때문이다(같은 커밋이 스스로 쓴 영수증이 증거:
// .harness/runner-receipt-run5.json -- runner_exit 4294967295 ·
// runner_status TESTS_FAILED · tests/pass/fail/skip 전부 null, 짝 로그
// full-runner-5.log는 요약 줄 없이 끊김). 그래서 "status가 null/undefined
// 인가"만 보던 분류기는 이 플랫폼의 진짜 강제종료를 하나도 못 잡고
// TESTS_FAILED로 접었다.
//
// 검토 권고 ⓐ(가장 강한 축, 종료코드 목록에 기대지 않는다)로 바꾼다:
// signal/error도 없고 status도 0이 아닌 경우, "node --test 자신이 tap
// reporter에 완료 요약 줄(`# tests N`)을 남겼는가"(hasCompletion, 호출자가
// 실제 tap 파일을 읽어 판단해 넘긴다 -- 아래 hasTapCompletion)로 가른다.
// 진짜 시험 실패는 개별 테스트가 실패해도 node --test 프로세스 자체는
// 끝까지 돌아 요약까지 쓰므로(관찰 사실), 이 신호는 "정말 실패했다"와
// "완료 결과 자체가 없다"를 종료코드의 플랫폼별 모양과 무관하게 가른다 --
// Windows의 0xFFFFFFFF든 다른 어떤 비정상 코드든 목록을 만들 필요가 없다.
export function classifySpawnOutcome(result, { hasCompletion = false } = {}) {
  if (result.signal) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  if (result.error) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  if (result.status === 0) {
    return { status: RUNNER_STATUS.OK, exitCode: 0 };
  }
  if (!hasCompletion) {
    return { status: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM, exitCode: 1 };
  }
  return { status: RUNNER_STATUS.TESTS_FAILED, exitCode: result.status ?? 1 };
}

// HYK-439 §2 ⓑ: combines the main pass's and the serial-family pass's
// classified outcomes (each a classifySpawnOutcome result) into ONE
// judgement for this run -- the WORSE status wins (never the optimistic
// one: a measurement-unavailable or a real failure in EITHER pass must not
// be hidden by the other pass's green), and the combined exit code is 0
// ONLY when both passes exited 0.
const RUNNER_STATUS_SEVERITY = {
  [RUNNER_STATUS.OK]: 0,
  [RUNNER_STATUS.TESTS_FAILED]: 1,
  [RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM]: 2,
};

function combinePassOutcomes(mainOutcome, familyOutcome) {
  const bothOk = mainOutcome.exitCode === 0 && familyOutcome.exitCode === 0;
  const worse =
    RUNNER_STATUS_SEVERITY[familyOutcome.status] >
    RUNNER_STATUS_SEVERITY[mainOutcome.status]
      ? familyOutcome
      : mainOutcome;
  return {
    status: worse.status,
    exitCode: bothOk
      ? 0
      : mainOutcome.exitCode !== 0
        ? mainOutcome.exitCode
        : familyOutcome.exitCode,
  };
}

// HYK-477 §2-3 2R: the input classifySpawnOutcome's hasCompletion needs --
// isolated into its own function so a tap-read failure (no file, unreadable,
// no summary line) degrades to "no completion" rather than throwing and
// losing the real spawn outcome.
//
// HYK-209 §2 ⓐ: delegates to hasGenuineTapCompletion (runner-receipt-
// writer.mjs), not a bare "did parseTapSummaryCounts find a complete
// block" check -- a complete block that sits inside a subtest's own
// never-closed `# Subtest:` section (R7c: the parent died before ever
// writing its own summary) must NOT read as "completed" here, or a forced
// kill gets misclassified as TESTS_FAILED with the leaked block's fake
// counts (see hasGenuineTapCompletion's own header for the structural
// reasoning and evidence). emitRunnerReceipt below applies the same gate
// to the counts it records, so both call sites agree on what "a completion
// summary" looks like, exactly as before this round.
function hasTapCompletion({ tapPath, readFile, elapsedMs }) {
  try {
    return hasGenuineTapCompletion(readFile(tapPath, "utf8"), { elapsedMs });
  } catch {
    return false;
  }
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

// Isolated purely to keep runIsolatedSuite's own line-count gate happy (same
// reasoning as the other small extractions in this file) -- no behavior
// change from the two inline execFile calls this replaces.
function resolveHeadShaAndDirty({ root, execFile }) {
  const sha = execFile("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const porcelain = execFile("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  return { sha, dirty: porcelain.trim().length > 0 };
}

// HYK-464 2R P2-4 (책임자 판정 2026-10-16 16:4x §1): `engines.node`가 단일
// 고정 major가 아니라 "범위식"(`>=20`, `^20 || ^22`, `20 - 22`,
// `>=20 <21` 등)이면 그 범위가 가리키는 major가 하나로 정해지지 않으므로,
// 문자열에서 아무 숫자나 하나 뽑아 "그 major"로 삼는 비교는 의미가 없다
// -- 그 비교 자체를 "판정 불가"로 접는다(경고 없음, 영수증 UNKNOWN).
// 허용하는 "단일 버전" 모양: 선택적 `^`/`~` 접두 + 숫자 + (`.` 숫자|`.x`)를
// 최대 두 번까지(`20` · `20.x` · `20.11` · `20.11.0` · `^20` · `~20.1`) --
// 공백·`||`·비교 연산자(`<`/`>`)·`-` 구분자가 하나라도 있으면 범위식으로
// 본다. 단일 버전 안의 `^`/`~`는 "그 major 하나"를 가리키는 호환 표기일
// 뿐이라 범위식으로 보지 않는다(기존 "20.x" 취급과 동일 선상).
const SINGLE_VERSION_ENGINES_RE = /^[\^~]?\d+(?:\.(?:\d+|x)){0,2}$/i;

// HYK-464 §2 ⓐ-2: compares the Node major version this run's `node --test`
// child actually ran under (see buildNodeTestArgs's caller -- it is spawned
// via `process.execPath`, i.e. this runner's OWN binary, so `nodeVersion`
// here is always that same binary's `process.version`) against
// package.json's declared `engines.node` major. A genuine mismatch is
// prefixed "MISMATCH" (the caller below uses that prefix to decide whether
// this belongs on the run's loud first line -- a mismatch is reportable,
// never a block: exit code and pass/fail judgement are both untouched).
// Anything that makes the comparison itself impossible (process.version
// doesn't parse, engines.node is undeclared/unparseable, OR (HYK-464 2R
// P2-4) engines.node is a range expression rather than a single pinned
// major) is prefixed "UNKNOWN", never collapsed into "no warning" --
// coder-task.md §2 ⓐ-2 "engines를 못 읽으면 «판정 불가」를 경고 값으로
// (조용히 0 금지)". `null` is returned ONLY when the two majors actually
// agree.
export function resolveNodeVersionWarning({ nodeVersion, enginesNode }) {
  const nodeMajorMatch = /^v?(\d+)/.exec(nodeVersion ?? "");
  if (!nodeMajorMatch) {
    return `UNKNOWN: could not parse a major version out of this run's own process.version (${JSON.stringify(nodeVersion)}) -- 판정 불가`;
  }
  const nodeMajor = Number(nodeMajorMatch[1]);
  if (typeof enginesNode !== "string" || enginesNode.trim() === "") {
    return `UNKNOWN: package.json's engines.node could not be read/is not declared -- cannot compare against this run's Node ${nodeVersion}, 판정 불가`;
  }
  const trimmedEngines = enginesNode.trim();
  const enginesMajorMatch = /(\d+)/.exec(trimmedEngines);
  if (!enginesMajorMatch) {
    return `UNKNOWN: package.json engines.node value ${JSON.stringify(enginesNode)} has no parseable major version -- cannot compare against this run's Node ${nodeVersion}, 판정 불가`;
  }
  if (!SINGLE_VERSION_ENGINES_RE.test(trimmedEngines)) {
    return `UNKNOWN: package.json engines.node value ${JSON.stringify(enginesNode)} is a range expression, not a single pinned major -- HYK-464 2R P2-4: comparing a single running Node major against a range is not well-defined, 판정 불가`;
  }
  const enginesMajor = Number(enginesMajorMatch[1]);
  if (nodeMajor === enginesMajor) return null;
  return `MISMATCH: this run's node --test child ran under ${nodeVersion} (major ${nodeMajor}), but package.json declares engines.node ${JSON.stringify(enginesNode)} (major ${enginesMajor}) -- report only, exit code/judgement unaffected`;
}

// HYK-464 §2 ⓐ-2: reads `engines.node` off the SOURCE repo's package.json
// (not the clone's -- the clone is disposable and this is a property of
// the committed repo state, not of any one run's artifacts). Never throws:
// an unreadable/malformed package.json degrades to `null`, which
// resolveNodeVersionWarning above turns into an honest "UNKNOWN/판정 불가"
// rather than a crash or a silently-skipped comparison.
function resolveEnginesNode({ root, readPackageJsonFn }) {
  try {
    const pkg = readPackageJsonFn(join(root, "package.json"));
    return typeof pkg?.engines?.node === "string" ? pkg.engines.node : null;
  } catch {
    return null;
  }
}

function defaultReadPackageJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// HYK-464 §2 ⓐ-2: isolated into its own function so runIsolatedSuite's own
// complexity/line-count gate doesn't absorb this -- both the two default
// parameter values (`nodeVersion`/`readPackageJsonFn`, each a branch under
// this repo's `complexity` rule) live here. Returns the RESOLVED
// `nodeVersion` (not the possibly-undefined input) alongside the warning,
// so the caller's receipt records the version this function actually
// compared -- production callers never pass `nodeVersion` explicitly, so
// without this, the receipt would wrongly carry `null` instead of the real
// `process.version`.
//
// HYK-464 2R P2-6: this function no longer logs anything itself (renamed
// from resolveAndLogNodeVersionWarning) -- 1R's own log() call here, made
// BEFORE the concurrency banner's log() call in runIsolatedSuite, is
// exactly what pushed the banner to the SECOND line on a real mismatch
// (검토 1R 실측). The caller now merges this result into the ONE first-line
// log() call via formatFirstRunnerLine above.
function resolveNodeVersionWarningInfo({
  root,
  nodeVersion = process.version,
  readPackageJsonFn = defaultReadPackageJson,
}) {
  const warning = resolveNodeVersionWarning({
    nodeVersion,
    enginesNode: resolveEnginesNode({ root, readPackageJsonFn }),
  });
  return { nodeVersion, warning };
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
// Isolated so emitRunnerReceipt can read ONE tap path's counts the exact
// same way it always has (byte-for-byte the same try/catch + log message as
// before this round) for both the main pass and, when a serial-family pass
// ran, that pass's own separate tap file -- no behavior change for any
// existing (single-pass) caller.
function parseCountsFromTapWithWarning({ tapPath, readFile, elapsedMs, log }) {
  try {
    // HYK-209 §2 ⓐ-1: the same genuineness gate hasTapCompletion uses --
    // a receipt must not carry a leaked subtest's fake counts (coder-
    // task.md §2 ⓐ-1 "영수증이 ... fail 0 이 되지 않게").
    return parseGenuineTapSummaryCounts(readFile(tapPath, "utf8"), {
      elapsedMs,
    });
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: could not read tap summary at ${tapPath} (${err.message}) -- receipt will carry null counts`,
    );
    return { tests: null, pass: null, fail: null, skip: null };
  }
}

// HYK-439 §2 ⓑ/ⓓ: field-by-field sum of the main pass's and the serial-
// family pass's counts -- a null in EITHER side makes that combined field
// null too (never a real number summed with "unknown"), same "don't guess"
// posture as parseGenuineTapSummaryCounts itself.
function mergeCounts(a, b) {
  const merged = {};
  for (const key of ["tests", "pass", "fail", "skip"]) {
    merged[key] = a[key] == null || b[key] == null ? null : a[key] + b[key];
  }
  return merged;
}

// Isolated so emitRunnerReceipt's own two write call sites (the "latest"
// file and the run-scoped numbered copy) share ONE construction of the
// common payload fields instead of repeating all of them twice -- no
// behavior change, this is byte-for-byte the same fields both call sites
// always passed, just named once.
function buildReceiptPayload({
  runnerExit,
  runnerStatus,
  counts,
  sha,
  finishedAtMs,
  maxConcurrentNode,
  nodeVersion,
  nodeVersionWarning,
  startFreeMb,
  minFreeMbSampled,
  concurrency,
  serialFamilyConcurrency,
  mainStartFreeMb,
  mainMinFreeMb,
  familyStartFreeMb,
  familyMinFreeMb,
}) {
  return {
    runnerExit,
    runnerStatus,
    counts,
    headCommit: sha,
    finishedAtMs,
    maxConcurrentNode,
    nodeVersion,
    nodeVersionWarning,
    startFreeMb,
    minFreeMbSampled,
    concurrency,
    serialFamilyConcurrency,
    // HYK-439 §2 ⓕ-2 (2R): per-pass start/min free-memory readings, kept
    // separate from the whole-run startFreeMb/minFreeMbSampled above
    // (those two fields are unchanged -- this is purely additive). null on
    // either family field means no family pass ran this round (familyFiles
    // was empty, e.g. every SERIAL_FAMILY_LIST entry was skipped as absent
    // from this checkout) -- not a measurement failure.
    mainStartFreeMb,
    mainMinFreeMb,
    familyStartFreeMb,
    familyMinFreeMb,
  };
}

// Pulled out of emitRunnerReceipt below purely to keep its own ESLint
// complexity/line-count gate happy (same reasoning as every other small
// extraction in this file) -- byte-for-byte the same tap-merge logic
// inlined before this extraction.
function mergeMainAndFamilyCounts({
  tapPath,
  familyTapPath,
  elapsedMs,
  familyElapsedMs,
  readFile,
  log,
}) {
  const counts = parseCountsFromTapWithWarning({
    tapPath,
    readFile,
    elapsedMs,
    log,
  });
  if (!familyTapPath) return counts;
  const familyCounts = parseCountsFromTapWithWarning({
    tapPath: familyTapPath,
    readFile,
    elapsedMs: familyElapsedMs,
    log,
  });
  return mergeCounts(counts, familyCounts);
}

// Pulled out of emitRunnerReceipt below -- the "latest" and "numbered"
// receipt writes are the same try/write/log-or-warn shape, previously
// inlined twice; this is byte-for-byte that same shape, named once (same
// "keeps the complexity gate happy" reasoning as every other extraction in
// this file).
function writeReceiptSafely({ writeFn, args, log, okLabel, failMessage }) {
  try {
    const { path } = writeFn(args);
    log(`[isolated-suite-runner] ${okLabel} -> ${path}`);
  } catch (err) {
    log(`[isolated-suite-runner] WARNING: ${failMessage(err)}`);
  }
}

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
  maxConcurrentNode,
  nodeVersion,
  nodeVersionWarning,
  elapsedMs,
  // HYK-439 §2 ⓑ/ⓓ: all optional, default = no serial-family pass ran this
  // round (byte-for-byte the prior single-pass behavior).
  familyTapPath = null,
  familyElapsedMs = null,
  startFreeMb = null,
  minFreeMbSampled = null,
  concurrency = null,
  serialFamilyConcurrency = null,
  // HYK-439 §2 ⓕ-2: no `= null` default here (unlike the params above) --
  // ESLint's complexity rule counts each default as its own branch, and
  // these four are unconditionally forwarded to buildReceiptPayload ->
  // perPassFreeMemFields, which already does `?? null` on every one of
  // them, so an omitted/undefined value here resolves to null there just
  // the same (no behavior difference, purely a complexity-gate fix).
  mainStartFreeMb,
  mainMinFreeMb,
  familyStartFreeMb,
  familyMinFreeMb,
}) {
  const counts = mergeMainAndFamilyCounts({
    tapPath,
    familyTapPath,
    elapsedMs,
    familyElapsedMs,
    readFile,
    log,
  });
  const payload = buildReceiptPayload({
    runnerExit,
    runnerStatus,
    counts,
    sha,
    finishedAtMs: nowMs(),
    maxConcurrentNode,
    nodeVersion,
    nodeVersionWarning,
    startFreeMb,
    minFreeMbSampled,
    concurrency,
    serialFamilyConcurrency,
    mainStartFreeMb,
    mainMinFreeMb,
    familyStartFreeMb,
    familyMinFreeMb,
  });
  writeReceiptSafely({
    writeFn: (args) => writeReceipt(args),
    args: { harnessDir: join(root, ".harness"), ...payload },
    log,
    okLabel: "runner receipt written",
    failMessage: (err) =>
      `failed to write runner receipt (${err.message}) -- consumption-side fail-closed gate (relay-handshake.mjs) will treat this as a missing receipt`,
  });
  if (!runSlot.receiptPath) return;
  writeReceiptSafely({
    writeFn: (args) => writeNumberedReceipt(args),
    args: { receiptPath: runSlot.receiptPath, ...payload },
    log,
    okLabel: "per-run numbered receipt written",
    failMessage: (err) =>
      `failed to write numbered receipt run${runSlot.runNumber} (${err.message}) -- HYK-485 §2-2's per-round comparison will see this run's evidence as missing, i.e. measurement-unavailable, not as a fabricated pass`,
  });
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
  readFile,
  nowMs = Date.now,
}) {
  // HYK-209 §2 ⓐ: the real wall-clock time THIS spawn call actually took --
  // the duration-plausibility cross-check in hasGenuineTapCompletion
  // compares a tap block's own self-reported `# duration_ms` against this.
  // Measured here (around the one real child-process call), not derived
  // from any tap text, so it cannot be spoofed by anything a test file
  // prints.
  const startedAtMs = nowMs();
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
        // HYK-477 §1-1: propagates the resolved cap to any nested spawn
        // point this in-clone `node --test` process (or a test file it
        // runs) creates -- see resolveNestedConcurrency's own comment.
        [NESTED_CONCURRENCY_ENV_VAR]: String(concurrency),
      },
    },
  );
  const elapsedMs = nowMs() - startedAtMs;
  return {
    ...classifySpawnOutcome(result, {
      hasCompletion: hasTapCompletion({ tapPath, readFile, elapsedMs }),
    }),
    elapsedMs,
  };
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

// Resolves the concurrency cap (pure, no log -- HYK-464 2R P2-6: this no
// longer logs itself, see runIsolatedSuite's own call site for why).
// Isolated so its branching doesn't count against runIsolatedSuite's own
// complexity gate.
//
// HYK-439 §2 ⓐ: `useAutoConcurrency` is a new, OFF-by-default switch -- an
// explicit `concurrency` always wins regardless of it (never even calls
// resolveAutoConcurrencyFn, so "명시 인자 우선" costs zero measurement time);
// when it's off (every existing caller/test, none of which pass this flag),
// resolution is BYTE-FOR-BYTE the prior behavior (resolveConcurrencyFn ??
// resolveConcurrency, i.e. the cpu-count default). Only this file's own CLI
// entry point turns it on unconditionally -- so the cpu-count default is
// "removed" from the real default flow (coder-task.md §2 ⓐ "기본값 12로
// 떨어지는 경로 제거") without changing this function's behavior for any
// caller that doesn't opt in, and without needing to touch any of the ~15
// existing runIsolatedSuite call sites in this file's own test suite.
function resolveConcurrencyValue({
  concurrency,
  resolveConcurrencyFn,
  useAutoConcurrency,
  resolveAutoConcurrencyFn = resolveAutoConcurrency,
}) {
  if (concurrency != null) {
    return {
      resolvedConcurrency: concurrency,
      reason: OVERRIDE_CONCURRENCY_REASON,
      startFreeMb: null,
    };
  }
  if (useAutoConcurrency) {
    const {
      concurrency: resolvedConcurrency,
      reason,
      startFreeMb,
    } = resolveAutoConcurrencyFn();
    return { resolvedConcurrency, reason, startFreeMb };
  }
  const resolveFn = resolveConcurrencyFn ?? resolveConcurrency;
  return {
    resolvedConcurrency: resolveFn(),
    reason: DEFAULT_CONCURRENCY_REASON,
    startFreeMb: null,
  };
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

// HYK-477 §1-3: the sampler script's path, resolved once at module load
// (mirrors how the rest of this file locates its own sibling modules via
// static import -- this one is spawned, not imported, so it needs its own
// file path instead).
const CONCURRENCY_SAMPLER_PATH = fileURLToPath(
  new URL("./node-concurrency-sampler.mjs", import.meta.url),
);

// Starts the background sampler process (see node-concurrency-sampler.mjs's
// own header for why it must be a SEPARATE process, not an in-process
// timer). Never throws: a failure to start sampling must not affect the
// suite run itself -- same "infra failure degrades gracefully" posture as
// resolveRunSlot above. Returns `null` on failure so stopConcurrencySampler
// can treat "never started" and "failed to stop" uniformly (both -> no
// measurement).
function startConcurrencySampler({
  spawnFn = spawnAsync,
  samplerPath = CONCURRENCY_SAMPLER_PATH,
  outPath,
  intervalMs = 250,
  log,
}) {
  try {
    const child = spawnFn(
      process.execPath,
      [samplerPath, "--interval-ms", String(intervalMs), "--out", outPath],
      { stdio: "ignore" },
    );
    child.unref?.();
    return child;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to start node-concurrency sampler (${err.message}) -- receipt's max_concurrent_node will be null`,
    );
    return null;
  }
}

// Kills the sampler and reads back the max it observed. `child.kill()` on
// Windows is a forced TerminateProcess with no graceful shutdown -- the
// sampler mitigates that by persisting its running max on every tick, not
// only at exit (see its own module header), so this can still read a very
// recent value even though the process is already gone by the time this
// function's readFileFn runs.
function stopConcurrencySampler({
  child,
  outPath,
  readFileFn = readFileSync,
  log,
}) {
  if (!child) return null;
  try {
    child.kill();
  } catch {
    // best-effort -- a failure to kill an already-dead process must not
    // affect the run's own result.
  }
  try {
    const data = JSON.parse(readFileFn(outPath, "utf8"));
    return Number.isInteger(data.max) ? data.max : null;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: could not read node-concurrency sampler output at ${outPath} (${err.message}) -- max_concurrent_node will be null`,
    );
    return null;
  }
}

// HYK-439 §2 ⓓ min_free_mb_sampled: same "separate process, not an
// in-process timer" reasoning as node-concurrency-sampler.mjs's own header
// (this run's event loop is blocked synchronously inside spawnSync for the
// whole suite -- no in-process timer could fire meanwhile). That file
// itself is OUT of this round's product_scope (only isolated-suite-
// runner.mjs/runner-receipt-writer.mjs/one new list file are in scope), so
// rather than extending it, this is a SECOND, independent sampler this file
// spawns directly via `node -e` -- a plain string, not a new file on disk.
// Never throws (same posture as startConcurrencySampler above): a failed
// sample just contributes no data point, `null` propagates as "measurement
// unavailable" if every sample fails or the sampler never started.
const FREE_MEM_SAMPLER_SCRIPT = [
  "const os=require('node:os');",
  "const fs=require('node:fs');",
  "const outPath=process.argv[1];",
  "const intervalMs=Number(process.argv[2]);",
  "let min=null;let samples=0;",
  "function tick(){",
  "const mb=os.freemem()/(1024*1024);",
  "samples+=1;",
  "if(min==null||mb<min)min=mb;",
  "try{fs.writeFileSync(outPath, JSON.stringify({min,samples,lastSampleAtMs:Date.now()}));}catch(e){}",
  "}",
  "tick();",
  "setInterval(tick, intervalMs);",
].join("\n");

function startFreeMemSampler({
  spawnFn = spawnAsync,
  outPath,
  intervalMs = 250,
  log,
}) {
  try {
    const child = spawnFn(
      process.execPath,
      ["-e", FREE_MEM_SAMPLER_SCRIPT, "--", outPath, String(intervalMs)],
      { stdio: "ignore" },
    );
    child.unref?.();
    return child;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: failed to start free-memory sampler (${err.message}) -- receipt's min_free_mb_sampled will be null`,
    );
    return null;
  }
}

// Mirrors stopConcurrencySampler's own "best-effort kill, then read the
// last persisted value" shape (same Windows TerminateProcess caveat --
// mitigated the same way, persisting on every tick rather than only at
// exit).
function stopFreeMemSampler({
  child,
  outPath,
  readFileFn = readFileSync,
  log,
}) {
  if (!child) return null;
  try {
    child.kill();
  } catch {
    // best-effort -- see stopConcurrencySampler's own comment.
  }
  try {
    const data = JSON.parse(readFileFn(outPath, "utf8"));
    return Number.isFinite(data.min) ? data.min : null;
  } catch (err) {
    log(
      `[isolated-suite-runner] WARNING: could not read free-memory sampler output at ${outPath} (${err.message}) -- min_free_mb_sampled will be null`,
    );
    return null;
  }
}

// HYK-439 §2 ⓕ-2: pulled out of runMainAndFamilySuite below -- the
// "single freememFn start-reading, start a free-mem sampler, run the pass,
// stop the sampler" shape is identical for the main pass and the family
// pass, previously inlined twice. `runPassFn` is a thunk so this stays
// agnostic to which pass it is wrapping (byte-for-byte the same sequence
// either call site had inline before this extraction) -- same "keeps the
// complexity/line-count gate happy" reasoning as every other extraction in
// this file.
function runPassWithFreeMemSampler({
  tapDir,
  outPathName,
  freememFn,
  startFreeMemSamplerFn,
  stopFreeMemSamplerFn,
  log,
  runPassFn,
}) {
  const startFreeMb = roundTo1Decimal(bytesToMb(freememFn()));
  const outPath = join(tapDir, outPathName);
  const child = startFreeMemSamplerFn({ outPath, log });
  const outcome = runPassFn();
  const minFreeMb = stopFreeMemSamplerFn({ child, outPath, log });
  return { startFreeMb, minFreeMb, outcome };
}

// HYK-439 §2 ⓑ: orchestrates the (possibly two-pass) suite run -- splitting
// `files` per `serialFamilyList` when one is given (fail-closed via
// splitSerialFamily, before anything spawns), sampling concurrent `node`
// process count across BOTH passes together (one sampler window spanning
// the whole run, not just the main pass -- an honest max over everything
// this run actually did, not a partial one), and combining their outcomes
// when a family pass ran. Isolated into its own function purely to keep
// runIsolatedSuite's own complexity/line-count gate happy (same reasoning
// as every other small extraction in this file) -- for a run with no
// serialFamilyList, this is byte-for-byte the prior single-pass
// spawnSuiteWithSampler behavior it replaces.
// HYK-439 §2 ⓕ-2 (2R, judgment 2026-10-30 03:30 §2): the pre-existing
// free-memory sampler (started one level up, in runSuiteWithFreeMemSampler)
// spans the WHOLE run (both passes combined) and stays byte-for-byte as-is
// -- this adds a SECOND, independent pair of sampler windows, one scoped to
// just the main pass and one scoped to just the family pass (only when one
// actually runs), each with its own single-sample "start free" reading
// taken right before that pass's spawn. Two sampler child processes can run
// concurrently with no interaction (each is its own `node -e` loop writing
// to its own outPath), so nesting them inside the already-running whole-run
// sampler is safe.
// Pulled out of runMainAndFamilySuite below -- the "if there are any
// family files, run the serial-family pass and combine its outcome" block,
// named once so that function's own ESLint line-count/complexity gate
// stays happy (same reasoning as every other extraction in this file).
// Returns combinedOutcome === mainOutcome and every family-* field null
// when familyFiles is empty -- byte-for-byte the no-family-pass shape
// runMainAndFamilySuite's own inline version produced before this
// extraction.
function runFamilyPassIfAny({
  familyFiles,
  mainOutcome,
  spawn,
  cloneDir,
  tapDir,
  mainLogPath,
  readFile,
  nowMs,
  freememFn,
  startFreeMemSamplerFn,
  stopFreeMemSamplerFn,
  log,
}) {
  if (familyFiles.length === 0) {
    return {
      combinedOutcome: mainOutcome,
      familyTapPath: null,
      familyElapsedMs: null,
      serialFamilyConcurrency: null,
      familyStartFreeMb: null,
      familyMinFreeMb: null,
    };
  }
  const familyTapPath = join(tapDir, "runner-output-serial.tap");
  const familyLogPath = mainLogPath
    ? mainLogPath.replace(/\.log$/, "-serial.log")
    : null;
  const familyPass = runPassWithFreeMemSampler({
    tapDir,
    outPathName: "free-mem-sampler-family.json",
    freememFn,
    startFreeMemSamplerFn,
    stopFreeMemSamplerFn,
    log,
    runPassFn: () =>
      spawnSerialFamilyPass({
        spawn,
        cloneDir,
        familyFiles,
        tapPath: familyTapPath,
        logPath: familyLogPath,
        readFile,
        nowMs,
      }),
  });
  return {
    combinedOutcome: combinePassOutcomes(mainOutcome, familyPass.outcome),
    familyTapPath,
    familyElapsedMs: familyPass.outcome.elapsedMs,
    serialFamilyConcurrency: SERIAL_FAMILY_CONCURRENCY,
    familyStartFreeMb: familyPass.startFreeMb,
    familyMinFreeMb: familyPass.minFreeMb,
  };
}

// Pulled out of runMainAndFamilySuite below -- the main pass's own
// split-and-run-with-sampler wiring, named once for the same line-count
// reason as runFamilyPassIfAny above. Returns the same
// {outcome, startFreeMb, minFreeMb} shape runPassWithFreeMemSampler does.
function runMainPass({
  serialFamilyList,
  files,
  spawn,
  cloneDir,
  tapPath,
  mainConcurrency,
  mainLogPath,
  readFile,
  nowMs,
  tapDir,
  freememFn,
  startFreeMemSamplerFn,
  stopFreeMemSamplerFn,
  log,
}) {
  let mainFiles = files;
  let familyFiles = [];
  if (serialFamilyList) {
    const split = splitSerialFamily({
      files,
      familyList: serialFamilyList,
      logFn: log,
    });
    mainFiles = split.mainFiles;
    familyFiles = split.familyFiles;
  }
  const mainPass = runPassWithFreeMemSampler({
    tapDir,
    outPathName: "free-mem-sampler-main.json",
    freememFn,
    startFreeMemSamplerFn,
    stopFreeMemSamplerFn,
    log,
    runPassFn: () =>
      spawnSuiteInClone({
        spawn,
        cloneDir,
        files: mainFiles,
        tapPath,
        concurrency: mainConcurrency,
        logPath: mainLogPath,
        readFile,
        nowMs,
      }),
  });
  return { ...mainPass, familyFiles };
}

function runMainAndFamilySuite({
  spawn,
  cloneDir,
  files,
  serialFamilyList,
  mainConcurrency,
  tapPath,
  tapDir,
  mainLogPath,
  samplerOutPath,
  readFile,
  startSampler = startConcurrencySampler,
  stopSampler = stopConcurrencySampler,
  freememFn = freemem,
  startFreeMemSamplerFn = startFreeMemSampler,
  stopFreeMemSamplerFn = stopFreeMemSampler,
  log,
  nowMs,
}) {
  const samplerChild = startSampler({ outPath: samplerOutPath, log });
  const mainPass = runMainPass({
    serialFamilyList,
    files,
    spawn,
    cloneDir,
    tapPath,
    mainConcurrency,
    mainLogPath,
    readFile,
    nowMs,
    tapDir,
    freememFn,
    startFreeMemSamplerFn,
    stopFreeMemSamplerFn,
    log,
  });
  const mainOutcome = mainPass.outcome;
  const {
    combinedOutcome,
    familyTapPath,
    familyElapsedMs,
    serialFamilyConcurrency,
    familyStartFreeMb,
    familyMinFreeMb,
  } = runFamilyPassIfAny({
    familyFiles: mainPass.familyFiles,
    mainOutcome,
    spawn,
    cloneDir,
    tapDir,
    mainLogPath,
    readFile,
    nowMs,
    freememFn,
    startFreeMemSamplerFn,
    stopFreeMemSamplerFn,
    log,
  });
  const maxConcurrentNode = stopSampler({
    child: samplerChild,
    outPath: samplerOutPath,
    log,
  });
  return {
    mainOutcome,
    combinedOutcome,
    familyTapPath,
    familyElapsedMs,
    serialFamilyConcurrency,
    maxConcurrentNode,
    mainStartFreeMb: mainPass.startFreeMb,
    mainMinFreeMb: mainPass.minFreeMb,
    familyStartFreeMb,
    familyMinFreeMb,
  };
}

// HYK-464 2R P2-6 (책임자 판정 2026-10-16 16:4x §1, 원문 "A"): the run's
// first log() line must carry BOTH the concurrency banner (HYK-473 §2-1's
// still-binding "literal first line" contract) AND, on a real node-major
// mismatch, the warning -- on the SAME line, never a separate second line.
// Merging requires knowing the warning BEFORE the single log() call, which
// requires `root` (resolveNodeVersionWarningInfo reads package.json off
// it) -- but `root` resolution itself can throw (a non-git cwd). 1R's
// order (`repoRootOf` first, nothing logged at all if it throws) is
// corrected here: concurrency is resolved (pure, no log) BEFORE the
// throwable root resolution, and if root resolution throws, the banner
// (the one piece that never depended on root) is still logged before the
// error propagates -- "배너가 먼저" (검토 ⓒ 지적, "repoRootOf가 배너보다
// 먼저 불리는 순서"를 바로잡는다) now holds even on this failure path, not
// only on the success path. Isolated into its own function so
// runIsolatedSuite's own complexity/line-count gate doesn't absorb this
// (same "keeps runIsolatedSuite's own complexity gate happy" reasoning as
// every other small extraction in this file).
// HYK-439 §2 ⓐ: used ONLY on a failure path below (root resolution, or
// head-sha resolution, throws) -- deliberately NEVER calls
// resolveAutoConcurrencyFn, even when useAutoConcurrency is on, because a
// run that is about to abort before spawning anything would otherwise pay
// auto-select's real (up to 30s wall-clock) measurement cost for a decision
// that will never be used. Explicit --concurrency still wins if given
// (zero behavior change on that path); otherwise this logs a cheap,
// honestly-labeled placeholder rather than a real measurement.
function resolveFailureBannerConcurrency({
  concurrency,
  resolveConcurrencyFn,
  useAutoConcurrency,
}) {
  if (concurrency != null) {
    return {
      resolvedConcurrency: concurrency,
      reason: OVERRIDE_CONCURRENCY_REASON,
    };
  }
  if (useAutoConcurrency) {
    return {
      resolvedConcurrency: 1,
      reason:
        "auto-select: skipped -- this run is aborting before a measurement would ever be used",
    };
  }
  const resolveFn = resolveConcurrencyFn ?? resolveConcurrency;
  return {
    resolvedConcurrency: resolveFn(),
    reason: DEFAULT_CONCURRENCY_REASON,
  };
}

function logFailureBanner({
  concurrency,
  resolveConcurrencyFn,
  useAutoConcurrency,
  log,
}) {
  const { resolvedConcurrency, reason } = resolveFailureBannerConcurrency({
    concurrency,
    resolveConcurrencyFn,
    useAutoConcurrency,
  });
  log(formatConcurrencyBanner({ concurrency: resolvedConcurrency, reason }));
}

// HYK-439 §2 ⓐ: root AND head-sha resolution now both happen BEFORE
// concurrency is resolved (reversed from the prior order -- see
// resolveFailureBannerConcurrency's own header for why): a bad root or a
// root with no resolvable HEAD means this run aborts before spawning
// anything, and auto-select's real measurement cost must not be paid on
// that path. HYK-464 2R P2-6's own "banner logged before the throw, never
// silently dropped" contract still holds on EITHER failure point, via
// logFailureBanner above -- only the concurrency VALUE shown on a failure
// path changes (never a real auto-select measurement); every caller that
// doesn't use useAutoConcurrency (the ~15 existing tests, explicit-
// concurrency callers) sees byte-for-byte the same banner text as before,
// since resolveConcurrencyFn ?? resolveConcurrency is exactly as cheap/
// instant on this path as it already was.
function resolveRootAndFirstLine({
  sourceRoot,
  execFile,
  concurrency,
  resolveConcurrencyFn,
  useAutoConcurrency,
  resolveAutoConcurrencyFn,
  nodeVersion,
  readPackageJsonFn,
  log,
}) {
  let root;
  try {
    root = sourceRoot ?? repoRootOf(process.cwd(), execFile);
  } catch (err) {
    logFailureBanner({
      concurrency,
      resolveConcurrencyFn,
      useAutoConcurrency,
      log,
    });
    throw err;
  }
  let headInfo;
  try {
    headInfo = resolveHeadShaAndDirty({ root, execFile });
  } catch (err) {
    logFailureBanner({
      concurrency,
      resolveConcurrencyFn,
      useAutoConcurrency,
      log,
    });
    throw err;
  }
  const { resolvedConcurrency, reason, startFreeMb } = resolveConcurrencyValue({
    concurrency,
    resolveConcurrencyFn,
    useAutoConcurrency,
    resolveAutoConcurrencyFn,
  });
  // The "UNKNOWN/판정 불가" case deliberately contributes no suffix (see
  // formatFirstRunnerLine) -- every existing caller that mocks a non-real
  // `root` (no readable package.json) falls into that case, and §2-1's
  // prior contract (hyk473-runner-cap.test.mjs) must not regress for any
  // of them: the first line stays banner-only, byte-for-byte as before.
  const { nodeVersion: resolvedNodeVersion, warning: nodeVersionWarning } =
    resolveNodeVersionWarningInfo({ root, nodeVersion, readPackageJsonFn });
  log(
    formatFirstRunnerLine({
      concurrency: resolvedConcurrency,
      reason,
      nodeVersionWarning,
    }),
  );
  return {
    root,
    sha: headInfo.sha,
    dirty: headInfo.dirty,
    resolvedConcurrency,
    resolvedNodeVersion,
    nodeVersionWarning,
    startFreeMb,
  };
}

// HYK-439 §2 ⓑ: runs the serial-family pass (always --test-concurrency=1,
// regardless of the main pass's own resolved concurrency) and returns its
// classified outcome plus the elapsed time emitRunnerReceipt needs for its
// own tap-plausibility check. Isolated so runIsolatedSuite's own
// complexity/line-count gate doesn't absorb this (same reasoning as every
// other small extraction in this file) -- only called when a serial-family
// list was given AND the split actually produced family files.
function spawnSerialFamilyPass({
  spawn,
  cloneDir,
  familyFiles,
  tapPath,
  logPath,
  readFile,
  nowMs,
}) {
  return spawnSuiteInClone({
    spawn,
    cloneDir,
    files: familyFiles,
    tapPath,
    concurrency: SERIAL_FAMILY_CONCURRENCY,
    logPath,
    readFile,
    nowMs,
  });
}

// Isolated purely to keep runIsolatedSuite's own line-count gate happy (same
// reasoning as every other small extraction in this file) -- no behavior
// change from the five inline statements this replaces.
function setupRunDirs({ root, mkdtemp, allocateRunSlotFn, log }) {
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
  return { cloneDir, tapDir, tapPath, runSlot };
}

// Isolated purely to keep runIsolatedSuite's own line-count gate happy (same
// reasoning as every other small extraction in this file) -- no behavior
// change from the four inline statements this replaces.
function cloneAndCollectFiles({
  execFile,
  root,
  cloneDir,
  collectFiles,
  sha,
  dirty,
  log,
}) {
  execFile("git", ["clone", "--quiet", root, cloneDir], { encoding: "utf8" });
  // HYK-439 §2 ⓐ: forwards this run's real log() so collectTestFiles' own
  // ENOENT-skip line (an absent TEST_DIRS folder, the normal installed-
  // target shape) actually reaches the run's log/stdout, instead of
  // silently going nowhere via collectTestFiles' own default no-op log.
  const files = collectFiles(cloneDir, undefined, { log });
  log(formatBanner({ sha, dirty }));
  log(
    `[isolated-suite-runner] clone: ${cloneDir} (${files.length} test file(s))`,
  );
  return files;
}

// HYK-439 §2 ⓑ/ⓓ: the (possibly two-pass) run -> receipt sequence, isolated
// into its own function so runIsolatedSuite's own complexity/line-count
// gate doesn't absorb it (same reasoning as every other small extraction in
// this file -- this one simply got large enough this round that the prior
// inline shape no longer fit). Pure sequencing, almost no branching of its
// own: all the actual decisions (auto-select, serial-family split, pass-
// outcome combining) live in the functions it calls.
// HYK-439 §2 ⓑ/ⓓ: wraps the free-memory sampler around runMainAndFamily
// Suite's own node-count-sampled run (start -> run -> stop), then folds
// minFreeMbSampled into whatever that call already returns. `...rest`
// forwards every other seam (spawn/startSampler/stopSampler/nowMs/etc.)
// through untouched, without this function needing to name each one just
// to pass it along one level -- isolated purely to keep runCloneAndEmit
// Receipt's own line-count gate happy (same reasoning as every other small
// extraction in this file).
function runSuiteWithFreeMemSampler({
  tapDir,
  startFreeMemSamplerFn = startFreeMemSampler,
  stopFreeMemSamplerFn = stopFreeMemSampler,
  log,
  ...rest
}) {
  const freeMemOutPath = join(tapDir, "free-mem-sampler.json");
  const freeMemSamplerChild = startFreeMemSamplerFn({
    outPath: freeMemOutPath,
    log,
  });
  // HYK-439 §2 ⓕ-2 (2R): startFreeMemSamplerFn/stopFreeMemSamplerFn are
  // passed down EXPLICITLY here too (not left to runMainAndFamilySuite's
  // own defaults) -- a caller that mocks these to disable the real
  // sampler child process (every existing fast unit test does, via
  // `() => null`) must disable it for the new per-pass windows as well,
  // or those tests would start spawning real `node -e` subprocesses this
  // round never asked them to.
  const result = runMainAndFamilySuite({
    tapDir,
    log,
    startFreeMemSamplerFn,
    stopFreeMemSamplerFn,
    ...rest,
  });
  const minFreeMbSampled = stopFreeMemSamplerFn({
    child: freeMemSamplerChild,
    outPath: freeMemOutPath,
    log,
  });
  return { ...result, minFreeMbSampled };
}

function runCloneAndEmitReceipt({
  root,
  sha,
  files,
  cloneDir,
  tapDir,
  tapPath,
  serialFamilyList,
  resolvedConcurrency,
  runSlot,
  readFile,
  writeReceipt,
  writeNumberedReceipt,
  nowMs,
  log,
  resolvedNodeVersion,
  nodeVersionWarning,
  startFreeMb,
  ...samplerOpts
}) {
  // HYK-439 §2 ⓑ/ⓒ: serialFamilyList is OFF by default (byte-for-byte the
  // prior single-pass behavior) -- only this file's own CLI entry point
  // supplies a real one unconditionally. See runMainAndFamilySuite's own
  // header for the split/sampler/combine details; `...samplerOpts` is
  // spawn/startSampler/stopSampler/startFreeMemSamplerFn/stopFreeMemSampler
  // Fn, forwarded untouched (see runSuiteWithFreeMemSampler's own header).
  const {
    mainOutcome,
    combinedOutcome,
    familyTapPath,
    familyElapsedMs,
    serialFamilyConcurrency,
    maxConcurrentNode,
    minFreeMbSampled,
    mainStartFreeMb,
    mainMinFreeMb,
    familyStartFreeMb,
    familyMinFreeMb,
  } = runSuiteWithFreeMemSampler({
    ...samplerOpts,
    cloneDir,
    files,
    serialFamilyList,
    mainConcurrency: resolvedConcurrency,
    tapPath,
    tapDir,
    mainLogPath: runSlot.logPath,
    samplerOutPath: join(tapDir, "node-concurrency-sampler.json"),
    readFile,
    log,
    nowMs,
  });

  return reportRunOutcome({
    root,
    sha,
    tapPath,
    runSlot,
    readFile,
    writeReceipt,
    writeNumberedReceipt,
    nowMs,
    log,
    maxConcurrentNode,
    resolvedNodeVersion,
    nodeVersionWarning,
    startFreeMb,
    minFreeMbSampled,
    resolvedConcurrency,
    mainOutcome,
    combinedOutcome,
    familyTapPath,
    familyElapsedMs,
    serialFamilyConcurrency,
    mainStartFreeMb,
    mainMinFreeMb,
    familyStartFreeMb,
    familyMinFreeMb,
  });
}

// Isolated purely to keep runCloneAndEmitReceipt's own line-count gate happy
// (same reasoning as every other small extraction in this file) -- no
// behavior change from the inline emitRunnerReceipt call + return this
// replaces.
function reportRunOutcome({
  root,
  sha,
  tapPath,
  runSlot,
  readFile,
  writeReceipt,
  writeNumberedReceipt,
  nowMs,
  log,
  maxConcurrentNode,
  resolvedNodeVersion,
  nodeVersionWarning,
  startFreeMb,
  minFreeMbSampled,
  resolvedConcurrency,
  mainOutcome,
  combinedOutcome,
  familyTapPath,
  familyElapsedMs,
  serialFamilyConcurrency,
  mainStartFreeMb,
  mainMinFreeMb,
  familyStartFreeMb,
  familyMinFreeMb,
}) {
  emitRunnerReceipt({
    root,
    sha,
    runnerExit: combinedOutcome.exitCode,
    runnerStatus: combinedOutcome.status,
    tapPath,
    runSlot,
    readFile,
    writeReceipt,
    writeNumberedReceipt,
    nowMs,
    log,
    maxConcurrentNode,
    elapsedMs: mainOutcome.elapsedMs,
    nodeVersion: resolvedNodeVersion,
    nodeVersionWarning,
    familyTapPath,
    familyElapsedMs,
    startFreeMb,
    minFreeMbSampled,
    concurrency: resolvedConcurrency,
    serialFamilyConcurrency,
    mainStartFreeMb,
    mainMinFreeMb,
    familyStartFreeMb,
    familyMinFreeMb,
  });
  return combinedOutcome.exitCode;
}

// Orchestrates one full run: clone committed HEAD -> run the suite in the
// clone -> report -> always clean up (unless `keep`). Returns the child
// process's exit code so the CLI entry point can propagate it verbatim.
// HYK-439 §2 ⓑ/ⓓ: `...passthrough` below is writeNumberedReceipt/
// serialFamilyList/startSampler/stopSampler/startFreeMemSamplerFn/
// stopFreeMemSamplerFn -- the six params this function never reads itself,
// only forwards verbatim to runCloneAndEmitReceipt's final call. None of
// the six has a default HERE (each downstream function that actually uses
// one applies its own, e.g. runMainAndFamilySuite's startSampler =
// startConcurrencySampler), so capturing them via rest instead of naming
// each individually changes nothing about what a caller that omits them
// gets -- purely a line-count reduction (keeps this function's own gate
// happy, same reasoning as every other small extraction in this file).
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
  nowMs = Date.now,
  resolveConcurrencyFn,
  useAutoConcurrency,
  resolveAutoConcurrencyFn,
  nodeVersion,
  readPackageJsonFn,
  ...passthrough
} = {}) {
  // HYK-464 2R P2-6: see resolveRootAndFirstLine's own header for why this
  // single call replaces 1R's separate repoRootOf + resolveAndLogNodeVersion
  // Warning + resolveAndLogConcurrency sequence. HYK-439 §2 ⓐ: it now also
  // resolves sha/dirty (resolveHeadShaAndDirty moved inside it) -- see its
  // own header for why (auto-select must never run on a path that aborts
  // before spawning anything).
  const {
    root,
    sha,
    dirty,
    resolvedConcurrency,
    resolvedNodeVersion,
    nodeVersionWarning,
    startFreeMb,
  } = resolveRootAndFirstLine({
    sourceRoot,
    execFile,
    concurrency,
    resolveConcurrencyFn,
    useAutoConcurrency,
    resolveAutoConcurrencyFn,
    nodeVersion,
    readPackageJsonFn,
    log,
  });

  const { cloneDir, tapDir, tapPath, runSlot } = setupRunDirs({
    root,
    mkdtemp,
    allocateRunSlotFn,
    log,
  });
  try {
    const files = cloneAndCollectFiles({
      execFile,
      root,
      cloneDir,
      collectFiles,
      sha,
      dirty,
      log,
    });
    return runCloneAndEmitReceipt({
      ...passthrough,
      root,
      sha,
      files,
      cloneDir,
      tapDir,
      tapPath,
      spawn,
      readFile,
      resolvedConcurrency,
      runSlot,
      writeReceipt,
      nowMs,
      log,
      resolvedNodeVersion,
      nodeVersionWarning,
      startFreeMb,
    });
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
  // HYK-439 §2 ⓐ/ⓑ (2R): the real CLI invocation always turns on auto-select
  // (a no-op whenever --concurrency was given above, per resolveConcurrency
  // Value's own "explicit wins" check) and always applies SERIAL_FAMILY_LIST
  // -- a hardcoded module constant now, not a file read, so there is no
  // load-failure path left to be fail-closed about. Membership is resolved
  // at runtime against this run's own collected files (splitSerialFamily);
  // an installed target that never collects any family-named file (e.g. no
  // templates/harness-init/*.test.mjs at all) simply logs two skip lines
  // and runs a single-pass suite, instead of 1R's ENOENT crash.
  const exitCode = runIsolatedSuite({
    sourceRoot,
    keep,
    concurrency,
    useAutoConcurrency: true,
    serialFamilyList: SERIAL_FAMILY_LIST,
  });
  process.exit(exitCode);
}
