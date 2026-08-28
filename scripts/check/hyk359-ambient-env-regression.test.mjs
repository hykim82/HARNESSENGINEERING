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

// HYK-371 2R (불변식 B): the ONE place that builds the nested sweep's
// `node --test` argv -- both the real CI-canonical sweep below AND the
// synthetic throttling-observation test further down call this SAME
// function, so a mutation here (deleting the concurrency flag, or
// reverting NESTED_SWEEP_CONCURRENCY to Node's default) is exercised by
// both. Extracted specifically so the observation test can drive it
// against a small, fast synthetic fixture instead of paying for a second
// ~280-file sweep just to prove the flag survived.
function buildNestedSweepArgs(files) {
  return [
    "--test",
    "--test-reporter=tap",
    `--test-concurrency=${NESTED_SWEEP_CONCURRENCY}`,
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

// HYK-371 2R (불변식 B, coder-task.md §3): 완료조건 ⑶("줄인 뒤 같은 보장이
// 유지된다를 시험으로 고정")은 "동시성 캡이 살아 있다"도 포함한다 -- 1R은
// argv에 `--test-concurrency=4`를 추가만 했을 뿐, 그걸 지우거나 기본값으로
// 되돌려도 초록인 채였다(검토자 P1-2).
//
// 이상적으로는 "실제 최고 동시 프로세스 수"를 재는 것이지만, coder-task.md
// §3이 지적한 대로 그건 비싸고(전체 스윕 재실행) 기계 부하에 흔들린다
// (1R 실측: 같은 커밋도 실행마다 수십 초·수십 개 차이). 그렇다고 "argv에
// 그 문자열이 있는가"만 보는 건 이 하네스가 여러 번 물린 형태 검사다.
//
// 채택한 절충 -- **작은 합성 픽스처로 실제 스로틀링을 관측**: 8개의 합성
// `.test.mjs`(각각 500ms 슬립)를 만들어 `buildNestedSweepArgs`(실제
// 스윕이 쓰는 바로 그 함수)로 돌리고 총 소요시간을 잰다. concurrency=4면
// 8개가 2묶음(≥2*500ms)으로 나뉘어 도니 소요시간이 눈에 띄게 길고,
// concurrency가 지워지거나 기본값(이 기계 CPU 24 → 기본 23)으로 돌아가면
// 8개가 한 묶음(~500ms+오버헤드)으로 끝나 짧다. 실측 보정(이 기계, 같은
// 조건 3회): 캡 있음 1237~1272ms / 캡 없음 677~691ms -- 여유 있게 갈리므로
// 임계값 900ms로 판정.
//
// ★이 시험이 증명하는 것: `buildNestedSweepArgs`가 만드는 argv가 "지금 이
// 순간 이 기계에서" 실제로 동시성을 묶는다는 것(순수 argv 형태 검사보다
// 강함 -- 실행 결과를 관측한다).
// ★이 시험이 증명하지 «않는» 것: ⓐ 실제 288개 파일 CI-canonical 스윕이
// 이 픽스처와 같은 배치 패턴을 보인다는 것(파일마다 소요시간이 다르고
// I/O·CPU 경합도 다르다) ⓑ 최고 «OS 프로세스 수»가 정확히 얼마인지(여기선
// 벽시계로 스로틀링을 «추론»할 뿐, 프로세스를 세지 않는다) ⓒ `4`가 최적값
// 이라는 것(1R coder.md·2R coder.md에 정직하게 남긴 미결 사항).
test("HYK-371 2R 완료조건⑶ (불변식 B): 중첩 스윕의 동시성 캡이 실제로 스로틀한다 -- 캡 인자를 지우거나 기본 동시성으로 되돌리면 합성 픽스처의 소요시간이 짧아져 RED", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk371-concurrency-throttle-"));
  try {
    const SLEEP_MS = 500;
    const FIXTURE_COUNT = 8;
    const fixtureFiles = Array.from(
      { length: FIXTURE_COUNT },
      (_, i) => `sleep-${i}.test.mjs`,
    );
    for (const name of fixtureFiles) {
      writeFileSync(
        join(dir, name),
        `import { test } from "node:test";\ntest("sleep", async () => { await new Promise((r) => setTimeout(r, ${SLEEP_MS})); });\n`,
        "utf8",
      );
    }

    const t0 = Date.now();
    const res = spawnSync(
      process.execPath,
      buildNestedSweepArgs(fixtureFiles),
      { cwd: dir, encoding: "utf8", env: envWithoutTestMarkers() },
    );
    const elapsedMs = Date.now() - t0;

    assert.equal(
      res.status,
      0,
      `synthetic throttling fixture itself failed to run cleanly (status=${res.status}, signal=${res.signal}) -- stderr: ${(res.stderr ?? "").slice(-2000)}`,
    );
    // 실측 보정치(위 주석): 캡 있음 ~1.24s / 캡 없음 ~0.68s. 900ms는 그
    // 사이 여유 구간 -- 캡이 지워지거나(인자 삭제) 기본 동시성으로
    // 되돌아가면(NESTED_SWEEP_CONCURRENCY를 큰 값으로 변경) 8개가 한
    // 묶음으로 끝나 이 임계값 아래로 떨어져 RED가 된다.
    const THROTTLE_EVIDENCE_THRESHOLD_MS = 900;
    assert.ok(
      elapsedMs >= THROTTLE_EVIDENCE_THRESHOLD_MS,
      `${FIXTURE_COUNT} synthetic ${SLEEP_MS}ms-sleep test files finished in ${elapsedMs}ms (< ${THROTTLE_EVIDENCE_THRESHOLD_MS}ms) -- looks like they ran in a single unthrottled batch, meaning the nested sweep's concurrency cap (NESTED_SWEEP_CONCURRENCY=${NESTED_SWEEP_CONCURRENCY}, via buildNestedSweepArgs) is not actually limiting concurrency anymore`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
