// HYK-359 §C 완료조건4: locks in "a floating ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH left set in the invoking shell
// produces the SAME result as running with those vars unset" as an
// automated, fail-red-on-regression check -- not a one-time human
// confirmation (coder-task.md §C-1: "사람이 한 번 확인하고 됐다로 닫지
// 마라 -- 어긋나면 빨간불이 켜져야 한다").
//
// HYK-359 2R P1-1 (검토자 실사고, 원문 coder-task.md §2): 1R hand-maintained
// an `ISOLATED_FILES` array naming the nine protected files. The reviewer
// deleted a file's array entry AND that file's own helper import/call in
// the SAME commit (a temp clone, `reject-streak-auto-record.test.mjs`) and
// re-ran this test directly -- it stayed green (`ℹ tests 1 / ℹ pass 1 /
// ℹ fail 0`) because the loop simply never looked at the now-unlisted file
// again. A hand-maintained "protected files" list is not a safety net if it
// can be deleted in the same commit as the protection it names.
//
// Fix (ORCH's own hint, coder-task.md §2 P1-1): stop naming files by hand.
// Enumerate the CI-canonical test directories at RUN TIME (the same
// TEST_DIRS/collectTestFiles isolated-suite-runner.mjs uses for the actual
// CI-canonical command) and sweep every `.test.mjs` file found there under
// a floating ambient value, requiring zero failures. A file's own isolation
// fix can no longer be deleted "silently" -- as long as the .test.mjs file
// itself still exists on disk (which it did in the reviewer's repro), this
// sweep discovers it every time regardless of any list, and it goes red the
// moment its protection is missing.
//
// HYK-359 3R P1+P2 (검토자 실사고, coder-task.md §2 원문, 책임자 승인
// «그 한 곳»): 2R's version guarded EXCEPTIONS/swept.length with a loose
// floor (`swept.length > 200`, `testsRun > 200`) -- a floor catches "way too
// few files" but not "one MORE excluded file" (P1: silently add an entry to
// EXCEPTIONS -- the loop still finds >200 files, still green) nor "trim the
// swept list after building it correctly" (P2: `swept.slice(0, 210)` still
// clears the >200 floor). A floor is the wrong shape for either direction.
//
// Fix: replace both floors with an EXACT equality, each recomputed from
// PRIMARY sources (`allFiles.length`, `EXCEPTIONS.size`) rather than trusted
// from `swept`/`testsRun` themselves -- so a mutation applied AFTER the
// correct computation (adding to EXCEPTIONS, slicing `swept`, truncating the
// spawned test count) diverges from the independently-recomputed expected
// value and goes red, in EITHER direction (add exception -> red, trim
// list -> red).
//
// Balance ("정당한 증가는 안 깨지고 몰래 빼기만 깨진다", coder-task.md §2):
// `allFiles.length` is read from disk every run, so a genuinely new
// `.test.mjs` file landing in any TEST_DIRS directory changes `allFiles`,
// `swept`, and `expectedSweptCount` TOGETHER (all three derive from the same
// fresh read) -- the equality still holds, no manual edit to this file
// needed, no red. Only `EXCEPTIONS` is pinned to an exact SIZE
// (`EXPECTED_EXCEPTIONS_SIZE` below): that set is a small, deliberately
// curated allowlist (currently one entry, `selfcheck-smoke.test.mjs`,
// coder-task.md §7's own out-of-scope call) where ANY change -- adding OR
// removing an entry -- should already be a visible, reviewed one-line diff
// to this file (bumping the pinned number), not a silent side effect of an
// unrelated commit. That is the intended, narrow place where a real
// exception-list change requires touching this test -- it is not "noise",
// it is the one knob this file exists to guard.
//
// HYK-359 4R (PR #213 CI 실사고, coder-task.md §2 원문): this file itself
// passed on every local (Windows) run across 1R-3R, but CI (Linux, Node 20
// pinned by enforce.yml) failed with the spawned sweep reporting "0 tests"
// and the child exiting 7, stderr empty. Diagnosed (원문 `.harness/
// phase-a-ci-diagnosis.md`) by reproducing the EXACT symptom in a disposable
// Linux clone outside this worktree -- two INDEPENDENT bugs, both in this
// file, neither in the swept test files themselves:
//
// ① `spawnSync` below had no `maxBuffer` override -- Node's default is 1MB,
// and the full CI-canonical sweep's TAP output is >1.6MB. Exceeding it
// makes Node kill the child and set `res.error.code === 'ENOBUFS'` -- which
// this file never checked, so a truncated/killed child silently read as
// "0 tests" instead of the real, loud buffer-overflow error it was.
//
// ② Even with maxBuffer fixed, the regex here (`/^ℹ tests (\d+)/m`) still
// found nothing, because Node's default `--test` reporter is
// `process.stdout.isTTY ? 'spec' : 'tap'` in the Node version CI pins (20.x,
// confirmed via that tag's own source) -- spawnSync's captured stdout is
// ALWAYS a pipe, never a TTY, so the child ALWAYS emits `tap` format
// (`# tests N`), never the `ℹ tests N` this regex expected. 실측(원문
// phase-a-ci-diagnosis.md): every human/worker who tested this locally ran
// a Node version >=24, where `kDefaultReporter` was changed to an
// unconditional `'spec'` (no TTY check at all) -- so local runs got `ℹ
// tests N` regardless of piping, while CI's pinned Node 20 never could.
// This was a NODE-VERSION difference wearing an OS-difference costume, not
// an OS difference itself.
//
// Fix for ②: stop depending on whichever reporter Node defaults to for a
// given version. Pin `--test-reporter=tap` explicitly on the spawned child
// so the output shape is deterministic across every Node version this
// repo's tooling might run under, then parse ONLY that pinned shape.
// Fix for ①: raise `maxBuffer` generously AND treat `res.error` as its own,
// distinct, loud failure -- never silently reinterpreted as "0 tests ran".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestFiles } from "./isolated-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE_BASENAME = basename(fileURLToPath(import.meta.url));

// The ONLY file this round leaves deliberately unprotected --
// selfcheck-smoke.test.mjs is sensitive to a *valid, existing* ledger path
// specifically (not to a floating var's mere presence), a different bug
// with a different fix, out of this round's scope (coder-task.md §5
// "⛔selfcheck-smoke 손대기 0(별건)"). Shrinking this list (removing an
// entry) only makes the sweep below stricter -- never a way to hide a
// regression.
const EXCEPTIONS = new Set(["selfcheck-smoke.test.mjs"]);
// Pinned deliberately (HYK-359 3R P1) -- bump this the SAME diff you add or
// remove an EXCEPTIONS entry in. Left stale, it turns a silent addition
// into a loud, exact-count mismatch instead of a floor that never notices.
const EXPECTED_EXCEPTIONS_SIZE = 1;

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: HERE,
    encoding: "utf8",
  }).trim();
}

// runSweepAndAssert -- spawns the nested `node --test` sweep, parses its
// TAP output, and asserts on it. Extracted out of the test() callback
// itself purely to keep that callback under this repo's ESLint
// max-lines-per-function ceiling; the assertions here ARE the test.
function runSweepAndAssert({ root, swept, dir }) {
  // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (set by `node --test` on THIS
  // process, since this file is itself a test) must NOT leak into the
  // spawned child below -- inherited, it makes the child's own
  // `node --test` detect "recursive test run" and silently skip running
  // any tests at all (exit 0 with zero tests executed), which would make
  // this assertion pass vacuously regardless of whether the swept files
  // are actually isolated. 실사고(1R): this exact bug hid a genuine RED
  // for a full debugging pass before being caught.
  const parentEnvWithoutTestMarkers = { ...process.env };
  delete parentEnvWithoutTestMarkers.NODE_TEST_CONTEXT;
  delete parentEnvWithoutTestMarkers.NODE_TEST_WORKER_ID;
  const floatingEnv = {
    ...parentEnvWithoutTestMarkers,
    ADMISSION_LEDGER_PATH: join(dir, "floating-ledger.json"),
    ADMISSION_LOCK_PATH: join(dir, "floating-ledger.lock"),
    DISPATCH_RECEIPT_PATH: join(dir, "floating-dispatch-receipt.json"),
  };
  // Relative paths + cwd:root, not absolute paths -- 286 absolute paths
  // (~37.5KB of argv) trip Windows's ~32KB CreateProcess command-line
  // limit (ENAMETOOLONG, 실측). Relative paths cut every entry by
  // `root.length` bytes, comfortably inside the limit.
  //
  // `--test-reporter=tap`: pin the reporter explicitly (HYK-359 4R ②, see
  // module header) -- the parsing below depends on TAP's exact summary
  // shape (`# tests N`), not whatever a given Node version defaults to.
  // `maxBuffer`: generous fixed ceiling (HYK-359 4R ①) -- 실측 CI-canonical
  // sweep output was ~1.6MB; 200MB leaves headroom for years of legitimate
  // growth without silently truncating again.
  const res = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...swept],
    {
      cwd: root,
      encoding: "utf8",
      env: floatingEnv,
      maxBuffer: 1024 * 1024 * 200,
    },
  );
  // HYK-359 4R ①: `res.error` (e.g. ENOBUFS from exceeding even this
  // generous maxBuffer, or a spawn failure) must fail LOUDLY with its own
  // distinct message -- never silently fall through to the "0 tests"
  // parsing below, which is exactly how CI's real ENOBUFS got misread as
  // "the sweep found nothing wrong" instead of "the sweep never finished
  // reporting at all".
  assert.equal(
    res.error,
    undefined,
    `spawnSync itself failed (child may have been killed mid-run, e.g. exceeding maxBuffer) -- error: ${res.error?.message} (code: ${res.error?.code}), signal: ${res.signal}, status: ${res.status}, stdout captured so far: ${(res.stdout ?? "").length} byte(s), stderr: ${(res.stderr ?? "").slice(-2000)}`,
  );

  const stdout = res.stdout ?? "";
  // HYK-359 4R (ORCH 실사고 지적, 세 번째 같은 부류): a 4000-char tail slice
  // loses the actual failing test's own name/location when the sweep is
  // large -- the summary line survives (it's always last) but WHICH of
  // ~5000 subtests failed does not. Always persist the FULL raw stdout to
  // a file inside this test's own mkdtemp dir (never the real repo, never
  // outside it) so a human can inspect it after the fact regardless of
  // whether parsing below succeeds.
  const fullStdoutLogPath = join(dir, "sweep-full-stdout.log");
  writeFileSync(fullStdoutLogPath, stdout);
  // Pull every failing subtest's name + source location straight out of
  // TAP's own per-failure YAML block (`not ok N - <name>` followed by a
  // `location: '<file>:<line>:<col>'` field) -- this is what actually
  // names "which of the 284 swept files" broke, instead of a byte-offset
  // tail that may not even contain the failure at all.
  const failingSubtests = [
    ...stdout.matchAll(
      /^not ok \d+ - (.+?)\r?\n(?:.*\r?\n)*?\s*location: '([^']*)'/gm,
    ),
  ].map(([, name, location]) => `${location} -- ${name}`);
  const testsMatch = stdout.match(/^# tests (\d+)$/m);
  const failMatch = stdout.match(/^# fail (\d+)$/m);
  // HYK-359 4R ③ (ORCH 요구): "파싱 실패"(요약 줄 자체를 못 찾음 -- 리포터
  // 형식이 또 바뀌었거나 출력이 잘렸다는 뜻)와 "0건 실행"(요약 줄은 찾았고
  // 그 값이 정말 0)을 같은 메시지로 접지 않는다 -- 원인이 다르면 사람이
  // 다음에 뭘 봐야 하는지도 다르다.
  assert.ok(
    testsMatch,
    `could not find TAP's '# tests N' summary line in the child's stdout at all -- --test-reporter=tap may not have taken effect, or the output was cut off before the summary. status=${res.status}, signal=${res.signal}, stdout length=${stdout.length}, stdout tail: ${stdout.slice(-3000)}\nstderr tail: ${(res.stderr ?? "").slice(-2000)}`,
  );
  assert.ok(
    failMatch,
    `found '# tests N' but not '# fail N' in the child's stdout -- malformed/truncated TAP summary. status=${res.status}, stdout tail: ${stdout.slice(-3000)}`,
  );
  const testsRun = Number(testsMatch[1]);
  const failCount = Number(failMatch[1]);
  // Same defense as 1R's per-file version: a child that genuinely reports
  // "# tests 0" (as opposed to no summary line at all, caught above) is
  // still a silent-skip shape -- require a real count that scales with the
  // swept file count itself (`>= swept.length`, not a fixed magic number)
  // so this stays meaningful as the repo grows.
  assert.ok(
    testsRun >= swept.length,
    `child's TAP summary reports only ${testsRun} tests across ${swept.length} swept files -- looks like a silent skip, not a real sweep. status=${res.status}, signal=${res.signal}, stderr tail: ${(res.stderr ?? "").slice(-2000)}`,
  );
  assert.equal(
    failCount,
    0,
    `${failCount} test(s) failed under a floating ambient ledger env across the swept CI-canonical set -- isolation regressed. Failing test(s) (file:line -- name):\n${failingSubtests.length > 0 ? failingSubtests.join("\n") : "  (none extracted by the location-block parser -- see the full raw log)"}\nfull raw stdout preserved at: ${fullStdoutLogPath}\nstatus=${res.status}`,
  );
  assert.equal(
    res.status,
    0,
    `child exited ${res.status} (signal=${res.signal}) even though the parsed TAP summary showed fail 0 -- unexpected, investigate. full raw stdout preserved at: ${fullStdoutLogPath}, stderr tail: ${(res.stderr ?? "").slice(-2000)}`,
  );
}

test("HYK-359 완료조건4 (3R): CI-canonical 시험 디렉토리 전체(예외 목록 제외, 정확한 개수)가 떠도는 ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH 아래에서도 fail 0 -- 보호 대상이 목록 없이 디스크에서 직접 발견되고, 예외 더하기·목록 잘라내기 어느 쪽도 조용히 통과하지 못한다", () => {
  const root = repoRoot();
  const allFiles = collectTestFiles(root); // relative paths, e.g. "scripts/check/foo.test.mjs"

  // HYK-359 3R P1: pinned exact size, not a floor -- see module header.
  assert.equal(
    EXCEPTIONS.size,
    EXPECTED_EXCEPTIONS_SIZE,
    `EXCEPTIONS has ${EXCEPTIONS.size} entries, expected exactly ${EXPECTED_EXCEPTIONS_SIZE} (${JSON.stringify([...EXCEPTIONS])}) -- if this change is deliberate, update EXPECTED_EXCEPTIONS_SIZE in the SAME diff; if not, something silently widened the exception list`,
  );

  const swept = allFiles.filter((relPath) => {
    const name = basename(relPath);
    return name !== THIS_FILE_BASENAME && !EXCEPTIONS.has(name);
  });

  // HYK-359 3R P2: exact equality recomputed from PRIMARY sources
  // (allFiles.length, EXCEPTIONS.size), not trusted from `swept.length`
  // itself -- a mutation applied to `swept` AFTER this point (e.g. a
  // trailing `.slice(0, N)`) diverges from this independently-derived
  // expectation and goes red, whichever direction it moves. Legitimate
  // growth (a new .test.mjs file anywhere in TEST_DIRS) changes
  // `allFiles.length` and `swept.length` together on the same fresh
  // `collectTestFiles` read, so the equality still holds with no edit here.
  const expectedSweptCount = allFiles.length - 1 - EXCEPTIONS.size;
  assert.equal(
    swept.length,
    expectedSweptCount,
    `swept ${swept.length} file(s), expected exactly ${expectedSweptCount} (= ${allFiles.length} CI-canonical files - 1 self - ${EXCEPTIONS.size} exception(s)) -- the swept set was trimmed or padded after being built correctly`,
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk359-ambient-regression-"));
  // HYK-359 4R (ORCH 실사고): deliberately NOT wrapped in try/finally --
  // if runSweepAndAssert throws, `dir` (and the sweep-full-stdout.log it
  // wrote inside itself) is left on disk on purpose, so a human can open
  // it after the fact. A `finally { rmSync(dir, ...) }` here would delete
  // the only place the failing subtest's full context survived, exactly
  // the mistake this round is fixing. Only a genuine pass reaches the
  // cleanup below.
  runSweepAndAssert({ root, swept, dir });
  rmSync(dir, { recursive: true, force: true });
});
