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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestFiles } from "./isolated-suite-runner.mjs";

// HYK-371 2R P1-1 (검토자 실사고, coder-task.md §2 불변식 A): 1R은
// `EXCEPTIONS`(어떤 파일이 예외인지)와 `EXPECTED_EXCEPTIONS_SIZE`(개수만)를
// 따로 뒀다 -- `selfcheck-smoke.test.mjs` 항목을 다른 실재하는
// `.test.mjs` 이름으로 «교체»하고 개수를 1로 유지하면, 개수 동등성은
// 그대로 통과하면서 실제로 보호에서 빠지는 파일은 조용히 바뀐다("커버리지
// 불변"이 개수가 아니라 «어느 파일이 대상인가»로 증명돼야 하는 이유).
// 고침: 개수가 아니라 **원소 자체**를 고정값과 정확히 비교(deepEqual) --
// 항목을 교체하면 개수는 같아도 정렬된 배열 내용이 달라져 즉시 RED.

// HYK-371 (측정: 08-27 기준선, 이 기계 CPU 24, Node v26.2.0): `node --test`
// 는 파일 하나당 프로세스 하나를 띄우고 기본 동시성은 CPU 코어 수 - 1이라,
// 이 아래 nested spawnSync가 예외 없이 기본 동시성으로 돌면 이미 밖에서
// 도는 중인 CI-canonical 스윕(그 자체로 동시 node.exe 최고 23) 위에
// 똑같은 크기의 두 번째 트리(최고 23)가 얹혀 순간 최고 동시 node.exe를
// 밀어올린다(기준선: 최고 82, 그중 46이 이 두 트리). 이 상수는 스윕
// «대상»(swept 파일 목록·통과 기준)은 그대로 두고 그 트리의 «동시성»만
// 낮춰 피크 기여를 줄인다 -- 도는 파일 수·fail 0 기준 어느 쪽도 건드리지
// 않으므로 커버리지 손실 없이 가시적 피크만 낮춘다(HYK-371 §6 실패조건
// ⓑ 회피).
const NESTED_SWEEP_CONCURRENCY = 4;
// HYK-371 3R (계약, coder-task.md §2 층 2): pinned SEPARATELY from the
// constant above so a mutation that raises NESTED_SWEEP_CONCURRENCY back up
// toward "no real cap" is caught by a plain, machine-independent numeric
// comparison -- no execution, no timing, works identically whether this
// runs on a 2-core CI box or a 24-core workstation. A deliberate cap-value
// change (coder-task.md §4 P2-2, still unexplored) updates this constant in
// the SAME diff, same pattern as EXPECTED_EXCEPTIONS above.
const MAX_INTENDED_NESTED_SWEEP_CONCURRENCY = 8;

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
// HYK-371 2R (불변식 A): pin the MEMBER(S), not just the count -- bump this
// the SAME diff you add/remove/rename an EXCEPTIONS entry in. Swapping
// "selfcheck-smoke.test.mjs" for a different existing file name here (and
// nowhere else) is exactly the silent-swap this array must catch: same
// `.size`, different actual protected-set membership.
const EXPECTED_EXCEPTIONS = ["selfcheck-smoke.test.mjs"];

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: HERE,
    encoding: "utf8",
  }).trim();
}

// HYK-371 2R (불변식 B) / 3R (층 1·층 2 공용): the ONE place that builds
// the nested sweep's `node --test` argv -- the real CI-canonical sweep
// below AND both layer tests further down call this SAME function, so a
// mutation here (deleting the concurrency flag entirely) is exercised by
// all three. `concurrency` defaults to the production value
// (NESTED_SWEEP_CONCURRENCY) but the layer-1 mechanism test below passes
// its OWN explicit value -- that test isn't about whether production picked
// 4, it's about whether the `--test-concurrency=N` flag genuinely caps
// concurrent execution AT ALL, for an N the test controls itself.
function buildNestedSweepArgs(files, concurrency = NESTED_SWEEP_CONCURRENCY) {
  return [
    "--test",
    "--test-reporter=tap",
    `--test-concurrency=${concurrency}`,
    ...files,
  ];
}

// NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (set by `node --test` on THIS
// process, since this file is itself a test) must NOT leak into a spawned
// nested `node --test` child -- inherited, it makes the child detect
// "recursive test run" and silently skip running any tests at all (exit 0,
// zero tests executed), which would make an assertion on the child's
// output pass vacuously. 실사고(1R): this exact bug hid a genuine RED for a
// full debugging pass before being caught. Shared by both spawn sites
// below (the real CI-canonical sweep and the synthetic throttling probe).
function envWithoutTestMarkers() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

// runSweepAndAssert -- spawns the nested `node --test` sweep, parses its
// TAP output, and asserts on it. Extracted out of the test() callback
// itself purely to keep that callback under this repo's ESLint
// max-lines-per-function ceiling; the assertions here ARE the test.
function runSweepAndAssert({ root, swept, dir }) {
  const floatingEnv = {
    ...envWithoutTestMarkers(),
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
  const res = spawnSync(process.execPath, buildNestedSweepArgs(swept), {
    cwd: root,
    encoding: "utf8",
    env: floatingEnv,
    maxBuffer: 1024 * 1024 * 200,
  });
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

  // HYK-371 2R P1-1 (불변식 A): compare the SORTED MEMBER LIST, not the
  // size -- a size-only check (3R's `EXCEPTIONS.size === EXPECTED_
  // EXCEPTIONS_SIZE`) passes unchanged if an entry is swapped for a
  // different existing file name (same size, different actual protected
  // set). deepEqual on the sorted array fails the moment membership
  // diverges from the pinned list, regardless of size.
  assert.deepEqual(
    [...EXCEPTIONS].sort(),
    [...EXPECTED_EXCEPTIONS].sort(),
    `EXCEPTIONS = ${JSON.stringify([...EXCEPTIONS].sort())}, expected exactly ${JSON.stringify([...EXPECTED_EXCEPTIONS].sort())} -- if this change is deliberate, update EXPECTED_EXCEPTIONS in the SAME diff; if not, an entry was silently added, removed, or swapped for a different file`,
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
  // (HYK-371 2R: this count check catches "one MORE/FEWER file swept" but
  // NOT "the same count, different membership" -- that's what the
  // deepEqual above is for. The two checks are complementary, neither
  // subsumes the other.)
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

// HYK-371 3R (검토자 2R-3 P1, coder-task.md §2): 2R의 "불변식 B" 시험은
// 8개×500ms 픽스처의 총 소요시간이 900ms를 넘는지로 캡 삭제를 판정했다 --
// 이 기계(CPU 24, 기본 동시성 23)에서는 안전했지만, 검토자가 4-way CI를
// `--test-concurrency=3`으로 직접 모델링해 같은 픽스처가 1817ms(>900ms)로
// 나오는 것을 실측했다: **캡이 삭제됐는데도 GREEN**(거짓 통과) -- 벽시계
// 임계값은 "이 기계의 기본 동시성이 캡보다 큰가"에 우연히 의존했다.
//
// 3R 완료조건③(coder-task.md): 시간 임계 시험은 걷어내고(대체이지 추가가
// 아니다) 기계-무관 불변식으로 바꾼다. 채택한 설계(ORCH 분석, coder-task.md
// §2 층 1·층 2 -- 검증해 그대로 채택, 반박 못 찾음):
//
// ★층 1(기전, 이 아래) -- `--test-concurrency=N` 인자가 실제로 최대 동시
// 실행 수를 N 이하로 묶는다는 것을, 벽시계 임계값 없이 증명한다. 각 합성
// 픽스처가 스스로 시작·종료 시각(epoch ms)을 파일에 남기고, 부모가 그
// 구간들의 최대 동시 겹침 수를 스윕라인으로 센다 -- "얼마나 걸렸는가"가
// 아니라 "몇 개가 동시에 떠 있었는가"만 보므로 기계 속도와 무관하다. 캡을
// 시험이 직접 지정(2)하므로 생산 코드의 NESTED_SWEEP_CONCURRENCY 값과도
// 무관 -- 이건 "N을 지정하면 Node가 실제로 N을 지킨다"는 기전 자체를
// 증명하는 시험이다.
// ★층 2(계약, 더 아래) -- 생산 코드가 실제로 그 인자를 넘긴다는 것을,
// 실행 없이 순수 문자열/숫자 비교로 증명한다. 인자가 삭제되면 문자열이
// 없어 RED, 상수가 "사실상 무제한"으로 되돌아가면(MAX_INTENDED_
// NESTED_SWEEP_CONCURRENCY 초과) 숫자 비교로 RED -- 실행이 없으므로 CI의
// CPU 수와 무관하게 항상 같은 결과.
// ★층 1만으로는 "생산 코드가 실제로 그 인자를 넘기는가"를 못 잡고(기전은
// 검증하지만 호출 여부는 안 봄), 층 2만으로는 "입력의 모양" 검사라 그
// 값이 정말 동시성을 묶는지는 안 본다 -- **둘이 함께여야** "캡이 사라지면
// 어느 기계에서도 RED"라는 불변식이 선다.
function computeMaxOverlap(intervals) {
  // Sweep-line over epoch-ms start/end events. Ties are processed
  // end-before-start (delta -1 sorts before +1 at the same timestamp) --
  // a conservative choice that never OVERcounts overlap from millisecond
  // rounding, only ever undercounts it, so it can't produce a false RED on
  // the "capped" assertion below.
  const events = intervals.flatMap(({ start, end }) => [
    [start, 1],
    [end, -1],
  ]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
}

// Generates one synthetic `.test.mjs` that sleeps `sleepMs`, then writes
// its own {start, end} (epoch ms) to `<name>.times.json` in the same dir --
// each child reports its own wall-clock interval, so the parent can later
// reconstruct exactly how many ran concurrently without polling processes
// or trusting anything about the parent's own view of timing.
function writeIntervalFixture(dir, name, sleepMs) {
  const timesPath = join(dir, `${name}.times.json`);
  writeFileSync(
    join(dir, `${name}.test.mjs`),
    [
      `import { test } from "node:test";`,
      `import { writeFileSync } from "node:fs";`,
      `test("interval", async () => {`,
      `  const start = Date.now();`,
      `  await new Promise((r) => setTimeout(r, ${sleepMs}));`,
      `  const end = Date.now();`,
      `  writeFileSync(${JSON.stringify(timesPath)}, JSON.stringify({ start, end }));`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { testFile: `${name}.test.mjs`, timesPath };
}

test("HYK-371 3R 완료조건② (층 1·기전): --test-concurrency=N 인자가 최대 동시 실행 수를 실제로 N 이하로 묶는다 -- 벽시계 임계값 없이, 자식이 스스로 남긴 시작·종료 시각의 최대 겹침으로 결정론적 관측(기계 무관)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk371-3r-mechanism-"));
  try {
    const SLEEP_MS = 300;
    const CAP = 2;
    // A second, larger explicit concurrency (not "no flag") to prove this
    // fixture is CAPABLE of overlapping beyond CAP when allowed to -- sleep
    // is non-CPU-bound (an idle timer), so even a low-core-count machine
    // can run many sleeping children "concurrently" (nothing is competing
    // for CPU while they wait). Without this comparison run, a fixture that
    // happened to never overlap at all would make the CAP assertion below
    // vacuously true regardless of whether the flag does anything.
    const HIGH_CONCURRENCY = 8;
    const FIXTURE_COUNT = 8;

    const capped = Array.from({ length: FIXTURE_COUNT }, (_, i) =>
      writeIntervalFixture(dir, `capped-${i}`, SLEEP_MS),
    );
    const cappedRes = spawnSync(
      process.execPath,
      buildNestedSweepArgs(
        capped.map((f) => f.testFile),
        CAP,
      ),
      { cwd: dir, encoding: "utf8", env: envWithoutTestMarkers() },
    );
    assert.equal(
      cappedRes.status,
      0,
      `capped mechanism fixture failed to run cleanly (status=${cappedRes.status}) -- stderr: ${(cappedRes.stderr ?? "").slice(-2000)}`,
    );
    const cappedOverlap = computeMaxOverlap(
      capped.map((f) => JSON.parse(readFileSync(f.timesPath, "utf8"))),
    );
    assert.ok(
      cappedOverlap <= CAP,
      `--test-concurrency=${CAP} produced a max observed overlap of ${cappedOverlap} (> ${CAP}) -- the flag is not actually limiting concurrent execution`,
    );

    const uncapped = Array.from({ length: FIXTURE_COUNT }, (_, i) =>
      writeIntervalFixture(dir, `uncapped-${i}`, SLEEP_MS),
    );
    const uncappedRes = spawnSync(
      process.execPath,
      buildNestedSweepArgs(
        uncapped.map((f) => f.testFile),
        HIGH_CONCURRENCY,
      ),
      { cwd: dir, encoding: "utf8", env: envWithoutTestMarkers() },
    );
    assert.equal(
      uncappedRes.status,
      0,
      `high-concurrency comparison fixture failed to run cleanly (status=${uncappedRes.status}) -- stderr: ${(uncappedRes.stderr ?? "").slice(-2000)}`,
    );
    const uncappedOverlap = computeMaxOverlap(
      uncapped.map((f) => JSON.parse(readFileSync(f.timesPath, "utf8"))),
    );
    assert.ok(
      uncappedOverlap > CAP,
      `with --test-concurrency=${HIGH_CONCURRENCY}, max observed overlap was only ${uncappedOverlap} (expected > ${CAP}) -- this fixture doesn't demonstrate real concurrency at all on this machine, so the capped assertion above would be vacuous (not evidence the flag does anything)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HYK-371 3R 완료조건① (층 2·계약): 생산 argv가 항상 --test-concurrency=<의도된 캡>을 포함한다 -- 실행 없이 순수 문자열/숫자 비교이므로 CPU 수와 무관하게 캡 삭제·완화가 항상 RED", () => {
  const args = buildNestedSweepArgs(["dummy.test.mjs"]);
  assert.ok(
    args.includes(`--test-concurrency=${NESTED_SWEEP_CONCURRENCY}`),
    `production argv (via buildNestedSweepArgs's default concurrency) does not contain "--test-concurrency=${NESTED_SWEEP_CONCURRENCY}" -- args: ${JSON.stringify(args)}`,
  );
  assert.ok(
    NESTED_SWEEP_CONCURRENCY <= MAX_INTENDED_NESTED_SWEEP_CONCURRENCY,
    `NESTED_SWEEP_CONCURRENCY is ${NESTED_SWEEP_CONCURRENCY}, which exceeds the pinned ceiling ${MAX_INTENDED_NESTED_SWEEP_CONCURRENCY} -- this is what "reverted to effectively no cap" looks like on ANY machine (a plain numeric comparison, not an execution-based inference), regardless of what that machine's own default concurrency happens to be`,
  );
});
