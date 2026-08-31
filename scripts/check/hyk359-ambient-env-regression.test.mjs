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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// HYK-403: canonical-suite-entrypoint.test.mjs asserts a DIFFERENT
// invariant (was this sweep launched via a canonical entry point --
// npm test / full-sweep-local.mjs -- vs a hand-built `node --test <glob>`),
// unrelated to this file's ambient-ledger-env concern. This sweep's whole
// point is to raw-spawn `node --test` directly, bypassing both canonical
// entry points on purpose (see runProductionSweep/buildNestedSweepArgs
// below) -- that guard file would fail here every time, for a reason that
// has nothing to do with ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
// DISPATCH_RECEIPT_PATH isolation. Excluding it here does not weaken this
// file's own protection; a real ambient-env regression in any other file
// still goes red.
const EXCEPTIONS = new Set([
  "selfcheck-smoke.test.mjs",
  "canonical-suite-entrypoint.test.mjs",
]);
// HYK-371 2R (불변식 A): pin the MEMBER(S), not just the count -- bump this
// the SAME diff you add/remove/rename an EXCEPTIONS entry in. Swapping
// "selfcheck-smoke.test.mjs" for a different existing file name here (and
// nowhere else) is exactly the silent-swap this array must catch: same
// `.size`, different actual protected-set membership.
const EXPECTED_EXCEPTIONS = [
  "selfcheck-smoke.test.mjs",
  "canonical-suite-entrypoint.test.mjs",
];

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
//
// HYK-371 4R (검토자 3R-1, coder-task.md §2): `spawn` is injectable
// (defaults to the real `spawnSync`, same pattern isolated-suite-runner.mjs
// already uses for its own execFile/spawn) SOLELY so the layer-2 contract
// test below can capture the REAL argv this function passes to its
// executor -- without paying for a real ~280-file sweep just to read an
// array. `runProductionSweep` further down is the ONLY call site the
// actual CI-canonical safety-net test uses, and it hardcodes the real
// `spawnSync` with no way for any caller to override it -- see that
// function's own comment for why the injection capability here can't
// become a bypass for the real check.
// HYK-377 2R (검토자 실사고, coder-task.md §2 열거ⓓ, orch-evidence-REVIEW-r1.md):
// an EMPTY `swept` makes `buildNestedSweepArgs([])` produce `["--test",
// "--test-reporter=tap", "--test-concurrency=N"]` -- zero file arguments.
// 실측(이 기계, Node v26.2.0): `node --test` with no file arguments does
// NOT run nothing -- it silently falls back to its OWN file
// auto-discovery, globbing and executing whatever `*.test.*` files happen
// to exist under `cwd` (verified in a disposable scratch dir: 6 unrelated
// fixture files it had never been told about all ran). A genuinely empty
// intended sweep (e.g. every CI-canonical file got excluded by a bug) must
// never be silently replaced by Node's own guess at what to run instead --
// fail closed here, before spawn is ever reached, for BOTH the real
// production call and every test below (this is the one shared choke
// point both paths go through).
function assertNonEmptySwept(swept, root) {
  assert.ok(
    swept.length > 0,
    `runSweepAndAssert refuses to spawn 'node --test' with an EMPTY swept list against root ${JSON.stringify(root)} -- zero file arguments makes Node fall back to its own auto-discovery of whatever *.test.* files exist in cwd instead of failing loudly, which would silently run a completely different, uncontrolled set of files`,
  );
}

// HYK-377 2R (orch-evidence-REVIEW-r1.md P1) 고침: 1R의 `.marker`-기반
// 관측(대상의 자발적 산출물에 의존)을 Node의 TAP 서브테스트 **이름**
// 기반 관측으로 바꿨었다. HYK-377 3R (검토자 실사고, orch-evidence-REVIEW-
// r2.md P1, coder-task.md §1 원문): 그 이름 채널도 틀렸다 -- **TAP은
// 「시험」을 식별하지, 「파일」을 식별하지 않는다.** 검토자 실측: 같은
// `fixtureRoot` 안에 실재하는 `same-name-replacement.test.mjs`를 만들고
// 그 안에 `test("marker-0", () => {})`를 넣어 swept에서 원본
// `marker-0.test.mjs`를 이 파일로 «대체»하면, 실행된 서브테스트 이름
// 집합(`["marker-0","marker-1","marker-2"]`)과 개수가 원래와 완전히
// 같아 `tests 1 / pass 1 / fail 0`으로 통과 -- 서로 다른 두 파일이 같은
// 이름을 자칭하면 이름 기반 관측은 원리적으로 구별할 수 없다(2R 지시서
// 자체가 이 틀린 전제를 줬다는 것을 ORCH가 자인함, coder-task.md §1).
//
// 고침(불변식 B′, «신원 = 파일»): 관측을 자식의 TAP 출력(어떤 형태든)에서
// 완전히 떼어내, **부모가 자식에게 실제로 건넨 argv의 파일 목록** 자체를
// 본다 -- 이 저장소에 이미 있던 동시성 계약 «층 2 = 생산 경로 argv
// 관측» 자산(HYK-371 4R, 아래 `buildNestedSweepArgs` 참고)을 그대로
// 재사용한다: `runSweepAndAssert`(생산 경로가 실제로 쓰는 바로 그 함수,
// `runProductionSweep`은 그 위에 실행기만 하드코딩한 얇은 래퍼)를 실행기
// 주입 지점으로 REAL하게 구동하되, 그 실행기가 **진짜 spawnSync도 함께
// 호출**하도록 감싸(순수 캡처가 아니라 캡처-후-위임) argv를 붙잡는다.
// 파일 신원은 이제 그 파일이 **자기 자신에 대해 무엇을 보고하는지**가
// 아니라 **부모가 그 파일을 가리키려고 어떤 문자열을 골랐는지**로
// 결정된다 -- 자식 코드가 무엇을 하든(test() 이름을 무엇으로 짓든,
// 마커를 쓰든 안 쓰든, `process.exit(0)`을 부르든) 이 채널에 영향을
// 줄 수 없다.
function runSweepAndAssert({ root, swept, dir, spawn = spawnSync }) {
  assertNonEmptySwept(swept, root);
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
  const nestedArgs = buildNestedSweepArgs(swept);
  // HYK-377 5R (불변식 N, coder-task.md §2, 검토자 실사고
  // orch-evidence-REVIEW-r4.md P1): 4R까지의 생산 진입점 real-gate는
  // `.marker` 산출물(대상 파일의 자발적 협조)에 의존했다 -- 검토자가
  // 정확히 예견한 대로, «비마커 초과»(test() 0개, 아무것도 안 씀)와
  // «동일 마커 치환»(다른 파일이 marker-0.marker를 대신 생성)이 그 층에서
  // 각각 부활해 `tests 1 / pass 1 / fail 0`으로 통과했다. 4R이 "생산
  // 진입점에서 검사" × "새 주입 지점 금지"를 동시에 요구한 계약 자체가
  // 그 층에서 argv를 볼 수단을 없앤 것(책임자 자인, coder-task.md §1).
  //
  // 고침(★불변식 N, «관측 출구»): 생산 경로가 spawn에 실제로 넘기는 바로
  // 그 `nestedArgs`(입력이 아니라, 인자를 다 조립한 뒤의 결과)에서 파일
  // 목록을 뽑아 `dir` 옆에 **스스로** 적는다 -- 이건 «주입 지점»이
  // 아니다: 아무 매개변수도 새로 받지 않고, 어떤 caller도 이 값을 바꿀
  // 수 없으며, spawn을 실제로 부르기 전 계산된 값을 그대로 내보낼 뿐
  // 행동을 하나도 바꾸지 않는다(4R이 지킨 "spawn은 하드코딩된 real
  // spawnSync" 자산 그대로). 파일 신원(어떤 이름의 파일을 정말 spawn에
  // 넘겼는가)은 이제 대상 파일이 무엇을 하든(마커를 쓰든 안 쓰든, 다른
  // 파일의 마커 경로를 흉내 내든) 전혀 영향받지 않는다 -- manifest는
  // 대상의 산출물이 아니라 부모 자신의 기록이다.
  //
  // ★정직 한계(coder-task.md §2, 책임자 지시로 그대로 남김): manifest도
  // 결국 생산 코드가 스스로 쓰는 것이라, 생산 코드가 «자기 기록 자체를
  // 위조»하면(예: nestedArgs와 다른 값을 manifest에 적도록 몰래 바꾸면)
  // 이 검사는 못 잡는다. 다만 그건 "스윕이 자기 목록을 위조하는" 성격이
  // 다른 공격이지, 이 조각이 겨냥한 "래퍼가 (manifest를 건드리지 않고)
  // swept만 조용히 바꾼다"와는 층이 다르다 -- 위조하려면 manifest와 실제
  // spawn 인자를 동시에, 서로 다르게 속여야 하는데 이 함수는 둘 다 같은
  // `nestedArgs` 하나에서 파생시키므로 그런 이중 위조가 이 함수 내부
  // 자체에서는 성립하지 않는다(같은 소스에서 나온 두 관측이 항상 일치).
  writeFileSync(
    join(dir, "swept-manifest.json"),
    JSON.stringify(nestedArgs.slice(3)),
    "utf8",
  );
  const res = spawn(process.execPath, nestedArgs, {
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

// HYK-371 4R (coder-task.md §2, "주입 지점이 우회로가 되면 안 된다"): the
// single production-facing gateway (HYK-376's pattern, PR #218) -- this is
// the ONLY function the real CI-canonical safety-net test below calls, and
// it hardcodes `spawn: spawnSync` as a literal with no parameter through
// which a caller could inject anything else. The executor-injection
// capability on `runSweepAndAssert` exists ONLY for the layer-2 contract
// test further down, which never touches this wrapper -- it calls
// `runSweepAndAssert` directly with its own fake spawn. So even if
// `runSweepAndAssert`'s real production call (inside this wrapper) were
// mutated to pass a different concurrency to `buildNestedSweepArgs`, the
// real CI-canonical sweep below still always executes with a REAL
// `spawnSync` (this wrapper is never bypassed) -- the injection capability
// cannot turn into "skip the real check", it can only ever be used by code
// that explicitly calls the lower-level function instead of this one, which
// is a visible, reviewable choice at that call site, not something this
// wrapper's existence enables silently.
function runProductionSweep({ root, swept, dir }) {
  runSweepAndAssert({ root, swept, dir, spawn: spawnSync });
}

// HYK-371 5R (검토자 4R-1 P1, coder-task.md §2): 불변식을 «래퍼는 받은
// 것을 그대로 실행한다»는 «전체 입력»으로 넓힌다. `runProductionSweep`이
// 손댈 수 있는 입력은 정확히 셋 -- `root`·`swept`·`dir`(넷째로 보이는
// "동시성"은 이 함수의 매개변수가 아니다: `runSweepAndAssert` 안에서
// `buildNestedSweepArgs(swept)`가 상수로 만들어 내며, 그 경로는 이미 층
// 2(계약) 시험이 별도로 고정한다 -- 여기서 다시 다룰 필요가 없다).
// `spawn`은 넷째처럼 보이지만 이 래퍼 안에서 **리터럴로 하드코딩**돼
// 있어 애초에 "받는" 입력이 아니다(4R의 단일 관문 설계) -- 열거에서
// 뺀다.
//
// 검토자의 4R-1 재현(래퍼 내부 호출을 `swept: ["...dummy...test.mjs"]`
// 로 몰래 치환)은 `runProductionSweep`에 **가짜 실행기를 주입하지 않고**
// 이뤄졌다 -- 그러니 이 시험도 4R에서 막 세운 "진짜 관문은 실행기를
// 못 바꾼다"는 안전장치를 다시 허물지 않는다: 가짜 실행기 대신 **작고
// 진짜인** swept·root·dir 값으로 `runProductionSweep`을 실제로 구동한다
// (합성 픽스처가 작아 빠름 -- 288개가 아니라 3개).
//
// swept 원소마다 자기 이름을 딴 마커 파일을 스스로 남기게 해서, 호출
// 뒤 그 마커 전부가 존재하는지로 "호출자가 준 목록이 축소·치환 없이
// 그대로 실행됐는가"를 직접 관측한다 -- 래퍼가 목록을 줄이거나 다른
// 파일로 바꾸면 해당 마커가 나타나지 않아 즉시 RED. root 위조(다른
// 디렉터리)도 같은 메커니즘으로 잡힌다: swept의 상대 경로는 «그» root
// 안에만 존재하므로, 래퍼가 다른 root를 넘기면 파일을 못 찾아
// `runSweepAndAssert` 자신의 기존 `res.error`/`testsRun` 어서션이 이미
// loud하게 실패한다(4R까지 있던 방어를 그대로 재사용, 새로 만들 필요
// 없음). dir 위조는 그 dir 안에 남아야 할 stdout 로그가 없는 것으로
// 잡는다.
// HYK-377 2R: the test() description is now the fixture's own unique
// `name` (was the shared literal "marker" for every fixture) -- when
// pulling "what actually ran" from Node's own TAP subtest names (see
// extractTapSubtestNames below), three fixtures all describing themselves
// as "marker" would be indistinguishable duplicates in that output. This
// doesn't change the marker-file mechanism itself (still written, still
// usable as a belt-and-suspenders secondary signal), only how the
// subtest identifies itself in TAP.
function writeMarkerFixture(dir, name) {
  const markerPath = join(dir, `${name}.marker`);
  writeFileSync(
    join(dir, `${name}.test.mjs`),
    [
      `import { test } from "node:test";`,
      `import { writeFileSync } from "node:fs";`,
      `test(${JSON.stringify(name)}, () => {`,
      `  writeFileSync(${JSON.stringify(markerPath)}, "ran");`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { testFile: `${name}.test.mjs`, markerPath, name };
}

// HYK-377 2R: a real, cleanly-passing `.test.mjs` that registers ZERO
// test() calls of its own -- the exact shape the reviewer's 2R P1 repro
// used (`nonmarker-uninvited.test.mjs`). It writes nothing, asserts
// nothing, and cannot be told to "cooperate" -- as of 3R this no longer
// matters for identity (that's argv now, see runSweepAndAssert's own 3R
// comment), but it stays a useful "excess, zero content signal" probe for
// the argv channel too: still a real file, its own execution still
// contributes nothing to distinguish it EXCEPT the literal filename in
// swept/argv.
function writeSilentFixture(dir, name) {
  const testFile = `${name}.test.mjs`;
  writeFileSync(
    join(dir, testFile),
    [
      "// HYK-377 2R fixture: deliberately registers no test() of its own.",
      "// Node still spawns this file -- but as of HYK-377 3R, nothing in",
      "// this file relies on what Node reports ABOUT it (TAP name/count);",
      "// only the argv the parent handed to spawn matters (see",
      "// runSweepAndAssert's own HYK-377 3R comment).",
      "",
    ].join("\n"),
    "utf8",
  );
  return { testFile, name: testFile };
}

// HYK-377 3R (검토자 실사고, orch-evidence-REVIEW-r2.md P1): a REAL,
// cleanly-passing .test.mjs whose own basename does NOT match the fixture
// it's meant to impersonate -- e.g. `same-name-replacement.test.mjs`
// containing `test("marker-0", () => {})`. Substituting this file's own
// NAME (testFile) into `swept` in place of `marker-0.test.mjs` reproduces
// the reviewer's exact repro shape: same TAP subtest name, same count,
// different FILE.
function writeSameNameFixture(dir, ownName, impersonatedTestName) {
  const testFile = `${ownName}.test.mjs`;
  writeFileSync(
    join(dir, testFile),
    [
      `import { test } from "node:test";`,
      `test(${JSON.stringify(impersonatedTestName)}, () => {});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { testFile };
}

// HYK-377 5R (검토자 실사고, orch-evidence-REVIEW-r4.md P1, «동일 마커
// 치환»): a same-name impersonator that goes further than
// writeSameNameFixture -- it ALSO writes to the SPECIFIC marker path the
// file it's replacing would have written, so it defeats BOTH signals a
// marker-based check could have used (the TAP-visible test() description
// AND the marker artifact itself). Only the manifest (parent's own record
// of what it actually handed to spawn) is not fooled by this.
function writeSameNameFixtureWithMarker(
  dir,
  ownName,
  impersonatedTestName,
  impersonatedMarkerPath,
) {
  const testFile = `${ownName}.test.mjs`;
  writeFileSync(
    join(dir, testFile),
    [
      `import { test } from "node:test";`,
      `import { writeFileSync } from "node:fs";`,
      `test(${JSON.stringify(impersonatedTestName)}, () => {`,
      `  writeFileSync(${JSON.stringify(impersonatedMarkerPath)}, "ran");`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { testFile };
}

// HYK-371 5R (검토자 4R-1 P1) + HYK-377 1R (orch-evidence-REVIEW-r1.md P1,
// marker-only) + HYK-377 2R (orch-evidence-REVIEW-r1.md P1, TAP-name):
// both prior fixes read something the EXECUTED FILE chose to produce
// (a marker write, or -- Node's own fallback -- a subtest name/count).
// HYK-377 3R (검토자 실사고, orch-evidence-REVIEW-r2.md P1, coder-task.md
// §1 원문 "이 실패의 절반은 ORCH 지시다"): TAP identifies TESTS, not
// FILES -- a real `same-name-replacement.test.mjs` containing
// `test("marker-0", () => {})` can impersonate `marker-0.test.mjs`
// perfectly in every content-derived channel (마커든 TAP 이름이든) while
// being a completely different file. 검토자 실측: swept에서 원본을 이
// 파일로 바꿔치기 → `tests 1 / pass 1 / fail 0`.
//
// 고침(불변식 B′, «신원 = 파일», coder-task.md §2): 관측을 자식의 산출물
// 전부에서 떼어내 **부모가 자식에게 실제로 건넨 argv의 파일 목록** 자체를
// 본다 -- 이미 있던 동시성 계약 «층 2 = 생산 경로 argv 관측» 자산(HYK-371
// 4R)을 재사용: `runSweepAndAssert`를 실행기 주입 지점으로 구동하되, 그
// 실행기가 **진짜 spawnSync도 함께 호출**하도록 감싸(캡처 후 위임 -- 4R의
// 순수-합성 가짜 실행기와 달리 진짜로 실행도 한다) argv를 붙잡는다. 이
// 채널은 자식이 무엇을 하든(test() 이름을 무엇으로 짓든, 마커를 쓰든
// 안 쓰든) 영향을 받지 않는다 -- 붙잡히는 건 부모가 «고른 문자열»이지
// 자식이 «보고한 것»이 아니다. `runProductionSweep`은 실행기를
// 하드코딩한 것 말고는 이 호출을 그대로 위임하는 한 줄짜리 래퍼이므로
// (4R 설계, 아래 함수 자체 주석 참고), `runSweepAndAssert`를 직접 구동해도
// `swept`·`root`·`dir` 전달 충실성 검증 범위는 줄지 않는다 -- 4R이
// 지키려던 것은 «생산 경로가 가짜 실행기를 쓰지 못하게»이지 «이 파일
// 목록 시험이 runProductionSweep을 반드시 거쳐야 함»이 아니다.
test("HYK-377 3R 완료조건① (파일 신원 · 층 2 argv 관측 재사용): runSweepAndAssert가 생산 경로에서 실제로 spawn에 건네는 argv의 파일 목록이 호출자가 준 swept와 «파일 신원»(정확한 문자열, 순서·다중도 포함)으로 일치한다 -- 관측이 자식의 TAP 출력·산출물이 아니라 부모가 실제로 만든 argv 자체이므로, 같은 시험 이름을 자칭하는 다른 파일로 바꿔치기해도(파일명이 다르면) 즉시 드러난다", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "hyk377-3r-identity-root-"));
  const dir = mkdtempSync(join(tmpdir(), "hyk377-3r-identity-scratch-"));
  try {
    const FIXTURE_COUNT = 3;
    const fixtures = Array.from({ length: FIXTURE_COUNT }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    // Snapshot BEFORE `swept` is handed anywhere -- this, not `swept`
    // itself, is what every comparison below is measured against, so a
    // mutation applied to `swept` at the call site (exactly how every
    // attack axis in this round and 1R/2R was reproduced) is caught
    // against the untouched original, never against itself.
    const expectedFiles = fixtures.map((f) => f.testFile);
    const swept = [...expectedFiles];

    let capturedArgs;
    let capturedOpts;
    // Captures the REAL argv AND still runs the REAL spawnSync (unlike
    // HYK-371 4R's layer-2 test, which synthesizes a fake TAP result to
    // stay fast for a check that never needed real execution) -- file
    // identity is best proven by actually running the files and watching
    // them behave (fail 0, dir log written), with argv capture riding
    // alongside as a second, independent observation.
    const capturingRealSpawn = (cmd, args, opts) => {
      capturedArgs = args;
      capturedOpts = opts;
      return spawnSync(cmd, args, opts);
    };

    runSweepAndAssert({
      root: fixtureRoot,
      swept,
      dir,
      spawn: capturingRealSpawn,
    });

    assert.ok(
      capturedArgs,
      "capturingRealSpawn was never called -- runSweepAndAssert did not reach its executor at all",
    );
    // buildNestedSweepArgs's fixed 3-flag prefix (--test,
    // --test-reporter=tap, --test-concurrency=N) precedes the file list.
    const capturedFiles = capturedArgs.slice(3);
    assert.deepEqual(
      capturedFiles,
      expectedFiles,
      `argv's file list actually handed to spawn = ${JSON.stringify(capturedFiles)}, expected exactly ${JSON.stringify(expectedFiles)} (swept passed in = ${JSON.stringify(swept)}) -- identity is the literal argv string, not anything the named file reports about itself`,
    );
    assert.equal(
      capturedOpts.cwd,
      fixtureRoot,
      `root not forwarded faithfully into spawn's cwd -- captured cwd ${JSON.stringify(capturedOpts.cwd)}, expected ${JSON.stringify(fixtureRoot)}`,
    );
    assert.ok(
      existsSync(join(dir, "sweep-full-stdout.log")),
      `runSweepAndAssert did not write its stdout log into the caller-given dir (${dir}) -- dir was not forwarded faithfully`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-377 3R 완료조건③ 열거ⓐ (같은 basename, 다른 디렉터리): argv 비교가
// 파일의 basename이 아니라 swept가 넘긴 «문자열 그대로»(여기서는
// 상대경로, 서브디렉터리 포함)를 다룬다는 것을 직접 증명 -- 두 서로 다른
// 디렉터리에 같은 basename(`dup.test.mjs`)을 심고 둘 다 swept에 넣어,
// 둘 다 독립적으로 argv에 남고 서로를 가리거나 뭉개지 않음을 확인한다.
test("HYK-377 완료조건③ 열거ⓐ (같은 basename, 다른 디렉터리는 충돌하지 않는다): argv 비교는 basename이 아니라 swept가 넘긴 상대경로 «전체 문자열»을 다루므로 서로 다른 디렉터리의 동명 파일이 서로를 가리지 않는다", () => {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "hyk377-3r-samename-diffdir-root-"),
  );
  const dir = mkdtempSync(
    join(tmpdir(), "hyk377-3r-samename-diffdir-scratch-"),
  );
  const subDir = join(fixtureRoot, "sub");
  try {
    mkdirSync(subDir);
    writeMarkerFixture(fixtureRoot, "dup");
    writeMarkerFixture(subDir, "dup");
    const swept = ["dup.test.mjs", join("sub", "dup.test.mjs")];

    let capturedArgs;
    const capturingRealSpawn = (cmd, args, opts) => {
      capturedArgs = args;
      return spawnSync(cmd, args, opts);
    };
    runSweepAndAssert({
      root: fixtureRoot,
      swept,
      dir,
      spawn: capturingRealSpawn,
    });

    assert.deepEqual(
      capturedArgs.slice(3),
      swept,
      `argv's file list = ${JSON.stringify(capturedArgs.slice(3))}, expected exactly ${JSON.stringify(swept)} -- both same-basename entries must survive as DISTINCT argv strings`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-377 3R 완료조건③ 열거ⓕ (파일명에 공백): spawnSync는 배열 원소를
// 셸을 거치지 않고 자식에게 그대로 넘기므로(공백이 인자 경계를 깨지
// 않음) 공백이 든 파일명도 정확히 한 argv 원소로 남는다 -- 개행은 이
// 기계의 파일시스템(NTFS/Windows)에서 파일명에 아예 허용되지 않아
// 픽스처를 만들 수 없다(원리적으로 이 OS에서 해당 없음, 근거: 시도 시
// ENOENT/EINVAL로 파일 생성 자체가 실패).
test("HYK-377 완료조건③ 열거ⓕ (파일명에 공백): 공백이 든 실재 파일명도 셸 파싱 없이 argv 원소 하나로 정확히 전달된다", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "hyk377-3r-space-name-root-"));
  const dir = mkdtempSync(join(tmpdir(), "hyk377-3r-space-name-scratch-"));
  try {
    const { testFile } = writeMarkerFixture(fixtureRoot, "marker with space");
    const swept = [testFile];

    let capturedArgs;
    const capturingRealSpawn = (cmd, args, opts) => {
      capturedArgs = args;
      return spawnSync(cmd, args, opts);
    };
    runSweepAndAssert({
      root: fixtureRoot,
      swept,
      dir,
      spawn: capturingRealSpawn,
    });

    assert.deepEqual(
      capturedArgs.slice(3),
      swept,
      `argv's file list = ${JSON.stringify(capturedArgs.slice(3))}, expected exactly ${JSON.stringify(swept)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-377 3R 완료조건① (동일 이름 치환 RED, 검토자 원문 그대로 영구
// 회귀 시험): 검토자가 실측한 정확한 형태를 그대로 고정한다 --
// `same-name-replacement.test.mjs`가 실재하며, `test("marker-0", () =>
// {})`로 원본 `marker-0.test.mjs`가 자칭하는 이름을 그대로 흉내 낸다.
// swept에서 원본을 이 파일로 바꿔치기한 뒤 argv를 붙잡아, «파일 신원»
// 채널(문자열 자체 비교)이 이 치환을 여전히 다른 파일로 구별해 내는지
// (즉 원래 의도한 목록과 더 이상 같지 않은지) 직접 증명한다. 이 시험은
// 정상 실행(치환된 파일도 진짜로 통과하는 실재 파일이라 실행 자체는
// 성공한다 -- 검토자 재현대로 exit 0)과 신원 불일치를 동시에 보여준다.
test('HYK-377 3R 완료조건① (동일 이름 치환은 파일 신원 채널에서 여전히 구별된다): 검토자 재현 그대로 -- same-name-replacement.test.mjs 안의 test("marker-0") 가 원본 marker-0.test.mjs 를 swept 에서 대체해도, 실제로 실행된 것이 진짜 marker-0.test.mjs 가 아니므로 argv 파일 목록 비교가 그 차이를 드러낸다', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "hyk377-3r-same-name-root-"));
  const dir = mkdtempSync(join(tmpdir(), "hyk377-3r-same-name-scratch-"));
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    const expectedFiles = fixtures.map((f) => f.testFile);
    const impersonator = writeSameNameFixture(
      fixtureRoot,
      "same-name-replacement",
      "marker-0",
    );
    const tamperedSwept = [impersonator.testFile, ...expectedFiles.slice(1)];

    let capturedArgs;
    const capturingRealSpawn = (cmd, args, opts) => {
      capturedArgs = args;
      return spawnSync(cmd, args, opts);
    };
    // The impersonator is a real, cleanly-passing file -- this call
    // succeeds (matches the reviewer's own "exit 0" observation). The
    // point isn't that execution fails; it's that the FILE LIST captured
    // no longer matches what was originally intended.
    runSweepAndAssert({
      root: fixtureRoot,
      swept: tamperedSwept,
      dir,
      spawn: capturingRealSpawn,
    });

    assert.notDeepEqual(
      capturedArgs.slice(3),
      expectedFiles,
      `same-name substitution must be observable as a file-list mismatch -- captured argv files = ${JSON.stringify(capturedArgs.slice(3))} unexpectedly equals the original intended list ${JSON.stringify(expectedFiles)}, meaning the impersonator (${impersonator.testFile}, self-describing as "marker-0") was indistinguishable from the real marker-0.test.mjs`,
    );
    assert.ok(
      capturedArgs.slice(3).includes(impersonator.testFile),
      `expected the impersonator's own filename ("${impersonator.testFile}") to appear verbatim in the captured argv -- captured: ${JSON.stringify(capturedArgs.slice(3))}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-377 3R 완료조건② 무회귀 (2R 이 닫은 «비마커형 초과» 축, 영구
// 회귀 시험): 마커도 안 쓰고 test()도 등록하지 않는 실재 파일을 swept
// 밖에 심고 초과 삽입 -- 파일 신원 채널은 그 파일이 아무것도
// «보고»하지 않아도(2R의 문제였던 지점) 여전히 argv 문자열 자체로
// 잡는다.
test("HYK-377 3R 완료조건② 무회귀 (비마커형 초과, 파일 신원 채널로 재확인): 마커도 test() 도 없는 실재 파일이 swept 에 몰래 초과 삽입돼도 argv 파일 목록 비교가 잡는다", () => {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "hyk377-3r-silent-excess-root-"),
  );
  const dir = mkdtempSync(join(tmpdir(), "hyk377-3r-silent-excess-scratch-"));
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    const expectedFiles = fixtures.map((f) => f.testFile);
    const silent = writeSilentFixture(fixtureRoot, "silent-uninvited");
    const swept = [...expectedFiles, silent.testFile];

    let capturedArgs;
    const capturingRealSpawn = (cmd, args, opts) => {
      capturedArgs = args;
      return spawnSync(cmd, args, opts);
    };
    runSweepAndAssert({
      root: fixtureRoot,
      swept,
      dir,
      spawn: capturingRealSpawn,
    });

    assert.notDeepEqual(
      capturedArgs.slice(3),
      expectedFiles,
      `silent excess file must be observable as a file-list mismatch -- captured argv files = ${JSON.stringify(capturedArgs.slice(3))} unexpectedly equals the original intended list ${JSON.stringify(expectedFiles)}`,
    );
    assert.ok(
      capturedArgs.slice(3).includes(silent.testFile),
      `expected the silent extra file's own filename ("${silent.testFile}") to appear verbatim in the captured argv`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-377 4R (검토자 실사고, orch-evidence-REVIEW-r3.md P1) + HYK-377 5R
// (검토자 실사고, orch-evidence-REVIEW-r4.md P1, coder-task.md §2 불변식
// N): 4R은 생산 진입점의 real-gate 검사를 «독립 기대값과의 대조»로
// 옮겼지만, 그 대조 자체가 다시 `.marker`(대상의 자발적 산출물)에
// 의존했다 -- 1R에서 이미 뚫린 두 공격이 이 층에서 그대로 부활했다:
// 검토자 실측 ⓐ 비마커 초과(`silent-uninvited.test.mjs`, test() 0개·
// 산출물 0)를 swept에 끼워도 마커 집합이 그대로라 통과. ⓑ 동일 마커
// 치환(`same-name-replacement.test.mjs`가 `marker-0.marker`를 대신
// 생성하도록 하고 `swept[0]`을 이 파일로 바꿔치기)해도 마커 «집합»은
// 여전히 같아 통과. 둘 다 `tests 1 / pass 1 / fail 0`(검토자 재현).
//
// 책임자 자인(coder-task.md §1): 4R의 계약("생산 진입점에서 검사" ×
// "새 주입 지점 금지") 자체가 그 층에서 argv를 관측할 방법을 없앴다.
//
// 고침(★불변식 N, «관측 출구»): `runSweepAndAssert`(생산 진입점이
// 실행기만 하드코딩해 그대로 위임하는 바로 그 함수, 위 함수 정의 자체
// 참고)가 spawn을 실제로 부르기 «직전»에, 그 호출에 쓸 파일 목록을
// `dir` 옆에 `swept-manifest.json`으로 스스로 적는다 -- 이건 «주입
// 지점»이 아니라 «출구»다: 새 매개변수도, 새 분기도, caller가 바꿀 수
// 있는 것도 없다(4R이 지킨 "spawn은 하드코딩된 real spawnSync" 자산
// 그대로 유지). 이제 파일 신원은 대상 파일이 무엇을 하든(마커를 쓰든
// 안 쓰든, 다른 파일의 마커 경로를 흉내 내든) 전혀 영향받지 않는다 --
// manifest는 부모 자신의 기록이지 자식이 «보고»하는 것이 아니다.
//
// ★정직 한계(coder-task.md §2, 책임자 지시로 그대로 남김): manifest도
// 결국 생산 코드가 스스로 쓰는 것이라, 생산 코드가 «자기 기록 자체를
// 위조»하면(예: manifest에 nestedArgs와 다른 값을 적도록 그 한 줄만
// 몰래 바꾸면) 이 검사는 못 잡는다. 다만 그건 "스윕이 자기 목록을
// 위조하는" 다른 층의 공격이지, 이 조각이 겨냥한 "래퍼가 (manifest는
// 안 건드리고) swept만 조용히 바꾼다"와는 다르다 -- 위조하려면 manifest
// 문자열과 실제 spawn 인자를 서로 다르게 이중으로 속여야 하는데,
// `runSweepAndAssert`는 둘 다 같은 `nestedArgs` 변수 하나에서
// 파생시키므로(위 함수 정의 참고) 그런 이중 위조가 이 함수 «내부»에서는
// 구조적으로 성립하지 않는다.
test("HYK-377 5R 완료조건①②③ (real gate, 생산 진입점 «관측 출구» manifest 대조): runProductionSweep이 spawn 직전 스스로 적는 swept-manifest.json을, 호출 전에 스냅샷한 독립 기대 파일 목록과 대조한다 -- 대상의 산출물(마커) 없이 부모 자신의 기록만 보므로 비마커 초과·동일 마커 치환 둘 다 잡힌다", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "hyk377-5r-realgate-root-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "hyk377-5r-realgate-scratch-"));
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    // Snapshot BEFORE handing anything to runProductionSweep -- the
    // independent expected value completion condition③ requires:
    // comparison is against what THIS TEST intended, never against
    // whatever runProductionSweep's own (possibly-tampered) body decided
    // to forward.
    const expectedFiles = fixtures.map((f) => f.testFile);
    const swept = [...expectedFiles];

    runProductionSweep({ root: fixtureRoot, swept, dir: scratchDir });

    const manifestFiles = JSON.parse(
      readFileSync(join(scratchDir, "swept-manifest.json"), "utf8"),
    );
    assert.deepEqual(
      manifestFiles,
      expectedFiles,
      `swept-manifest.json (what runProductionSweep's spawn call actually received) = ${JSON.stringify(manifestFiles)}, expected exactly ${JSON.stringify(expectedFiles)} -- fewer than expected means the production entry point dropped/substituted a file (e.g. the reviewer's swept.slice(0,-1)), more than expected means an unrequested file got swept in`,
    );
    assert.ok(
      existsSync(join(scratchDir, "sweep-full-stdout.log")),
      `runProductionSweep did not write its stdout log into the caller-given dir (${scratchDir})`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// HYK-377 5R 완료조건① (생산 진입점 «비마커 초과» RED, 검토자 형태
// 그대로 영구 회귀 시험): test() 0개, 아무 산출물도 없는 실재 파일을
// swept에 초과 삽입 -- manifest는 그 파일의 협조 여부와 무관하게
// «부모가 실제로 무엇을 spawn에 넘겼는가»만 기록하므로 잡힌다.
test("HYK-377 5R 완료조건① (생산 진입점 비마커 초과 RED): silent-uninvited.test.mjs(test() 0개·산출물 0)를 swept에 몰래 끼워 넣어도 manifest가 그 실재 여부를 그대로 드러낸다", () => {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "hyk377-5r-realgate-nonmarker-root-"),
  );
  const scratchDir = mkdtempSync(
    join(tmpdir(), "hyk377-5r-realgate-nonmarker-scratch-"),
  );
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    const expectedFiles = fixtures.map((f) => f.testFile);
    const silent = writeSilentFixture(fixtureRoot, "silent-uninvited");
    const swept = [...expectedFiles, silent.testFile];

    runProductionSweep({ root: fixtureRoot, swept, dir: scratchDir });

    const manifestFiles = JSON.parse(
      readFileSync(join(scratchDir, "swept-manifest.json"), "utf8"),
    );
    assert.notDeepEqual(
      manifestFiles,
      expectedFiles,
      `non-marker excess must be observable via manifest -- captured manifest = ${JSON.stringify(manifestFiles)} unexpectedly equals the original intended list ${JSON.stringify(expectedFiles)}`,
    );
    assert.ok(
      manifestFiles.includes(silent.testFile),
      `expected the silent extra file's own filename ("${silent.testFile}") to appear verbatim in the manifest`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// HYK-377 5R 완료조건② (생산 진입점 «동일 마커 치환» RED, 검토자 형태
// 그대로 영구 회귀 시험): same-name-replacement.test.mjs가 marker-0을
// 자칭하는 test()를 등록하고(3R의 impersonation 픽스처와 같은 모양)
// «게다가» marker-0.marker 경로에 직접 마커까지 심어(4R까지의 마커
// 기반 검사를 완전히 흉내) swept[0]을 대체 -- manifest는 파일이 무엇을
// «자칭»하든 실제로 spawn에 넘어간 문자열 자체만 기록하므로 여전히
// 잡힌다.
test("HYK-377 5R 완료조건② (생산 진입점 동일 마커 치환 RED): same-name-replacement.test.mjs 가 marker-0 을 자칭하며 marker-0.marker 까지 대신 만들어도 manifest 는 진짜 파일명으로 그 차이를 드러낸다", () => {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "hyk377-5r-realgate-samename-root-"),
  );
  const scratchDir = mkdtempSync(
    join(tmpdir(), "hyk377-5r-realgate-samename-scratch-"),
  );
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    const expectedFiles = fixtures.map((f) => f.testFile);
    // Impersonates marker-0 AT BOTH signals a 4R-era check might have
    // used -- its own test() description AND the marker file marker-0
    // would have written -- to prove manifest doesn't care about either.
    const impersonatorMarkerPath = fixtures[0].markerPath;
    const impersonator = writeSameNameFixtureWithMarker(
      fixtureRoot,
      "same-name-replacement",
      "marker-0",
      impersonatorMarkerPath,
    );
    const tamperedSwept = [impersonator.testFile, ...expectedFiles.slice(1)];

    runProductionSweep({
      root: fixtureRoot,
      swept: tamperedSwept,
      dir: scratchDir,
    });

    const manifestFiles = JSON.parse(
      readFileSync(join(scratchDir, "swept-manifest.json"), "utf8"),
    );
    assert.notDeepEqual(
      manifestFiles,
      expectedFiles,
      `same-name substitution must be observable via manifest -- captured manifest = ${JSON.stringify(manifestFiles)} unexpectedly equals the original intended list ${JSON.stringify(expectedFiles)}`,
    );
    assert.ok(
      manifestFiles.includes(impersonator.testFile),
      `expected the impersonator's own filename ("${impersonator.testFile}") to appear verbatim in the manifest`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// HYK-377 4R 완료조건② (생산 진입점에서 root 위조도 RED) + HYK-377 5R
// P2 (검토자 실사고, orch-evidence-REVIEW-r4.md, coder-task.md §3-4):
// 4R의 이 시험은 `assert.throws`뿐이라 «무엇이든 던지면» 통과했다 --
// 검토자가 `runProductionSweep` 몸통을 `throw new Error("unrelated
// production failure")`로 바꿔도 같은 `1/1/0`으로 통과함을 실측했다.
// 예외가 «root 위조 때문에» 났다는 원인 자체는 아무도 확인하지 않았다.
//
// 고침: 던져진 에러의 메시지가 `runSweepAndAssert` 내부의 «TAP 요약
// 줄을 못 찾았다»(실측: root가 틀리면 swept의 상대경로가 그 cwd에
// 없어 node --test가 아무 TAP 출력도 못 남기고 요약 줄 파싱이
// 실패한다는 이 함수 고유의 실패 시그니처)와 일치하는지 직접 검사한다
// -- "unrelated production failure" 같은 무관한 예외는 이 정규식을
// 통과하지 못해 이 시험 자체가 fail 하게 된다(P2가 요구한 «원인
// 검증»).
test("HYK-377 4R 완료조건② + 5R P2 (생산 진입점 root 위조, 원인까지 검증): runProductionSweep을 엉뚱한 root로 부르면 그 root에 swept 파일이 없어 즉시 실패하고, 그 실패는 구체적으로 «TAP 요약 줄을 못 찾았다»는 root-위조 고유의 원인이어야 한다 -- 몸통을 무관한 예외로 바꾸는 변이는 이 시험 자체를 fail 시킨다", () => {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "hyk377-4r-realgate-root-forge-"),
  );
  const wrongRoot = mkdtempSync(
    join(tmpdir(), "hyk377-4r-realgate-wrong-root-"),
  );
  const scratchDir = mkdtempSync(
    join(tmpdir(), "hyk377-4r-realgate-root-forge-scratch-"),
  );
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    const swept = fixtures.map((f) => f.testFile);
    assert.throws(
      () => runProductionSweep({ root: wrongRoot, swept, dir: scratchDir }),
      (err) => {
        assert.ok(
          /could not find TAP's '# tests N' summary line/.test(err.message),
          `expected root-forgery's own failure signature (no TAP summary because none of swept's relative paths exist under the wrong root) -- got a DIFFERENT error, which means this test would also pass for an unrelated failure (the exact P2 gap): ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(wrongRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

// HYK-377 4R 완료조건② (생산 진입점에서 dir 도 진짜 매개변수임을 재확인):
// `dir`이 `runProductionSweep` 내부에서 무시되거나 고정 경로로
// 하드코딩되지 않고, 호출자가 준 그 값을 그대로 따른다는 것을 «양성»
// (준 dir 에 로그가 실제로 남는다) 과 «음성»(다른, 안 준 dir 에는 안
// 남는다) 둘 다로 증명한다 -- 어느 한쪽만 보면 "항상 같은 고정 경로에
// 쓰는" 버그를 놓칠 수 있다(양성만 볼 때) 혹은 "아무 데도 안 쓰는" 버그를
// 놓칠 수 있다(음성만 볼 때).
test("HYK-377 4R 완료조건② (생산 진입점 dir 이 진짜 매개변수): runProductionSweep(intended dir A) 과 runProductionSweep(intended dir B) 를 각각 부르면 로그가 각자 «자신의» dir 에만 남고 서로 섞이지 않는다", () => {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "hyk377-4r-realgate-dir-forge-root-"),
  );
  const dirA = mkdtempSync(join(tmpdir(), "hyk377-4r-realgate-dir-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "hyk377-4r-realgate-dir-b-"));
  try {
    const fixtures = Array.from({ length: 3 }, (_, i) =>
      writeMarkerFixture(fixtureRoot, `marker-${i}`),
    );
    const swept = fixtures.map((f) => f.testFile);
    runProductionSweep({ root: fixtureRoot, swept, dir: dirA });
    assert.ok(
      existsSync(join(dirA, "sweep-full-stdout.log")) &&
        !existsSync(join(dirB, "sweep-full-stdout.log")),
      "after calling with dir=A, the log must exist in A and NOT in B -- proves dir isn't hardcoded to some other fixed path",
    );
    runProductionSweep({ root: fixtureRoot, swept, dir: dirB });
    assert.ok(
      existsSync(join(dirB, "sweep-full-stdout.log")),
      "after calling with dir=B, the log must exist in B too -- proves dir genuinely follows whichever value is passed, not a value memoized from the first call",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// HYK-377 2R 완료조건⑤ 열거ⓓ: an empty `swept` must fail closed inside
// runSweepAndAssert (assertNonEmptySwept, defined above) rather than ever
// reaching spawn with zero file arguments -- see that function's own
// comment for the auto-discovery risk this guards against. Exercised here
// through the real production gateway (runProductionSweep), same small
// real fixtureRoot pattern as the fidelity test above -- no fake spawn.
test("HYK-377 완료조건⑤ 열거ⓓ (swept 빈 배열 무협조 방어): swept가 빈 배열이면 runProductionSweep이 spawn을 시도하기 전에 즉시 거부한다 -- 인자 없는 'node --test'가 Node 자신의 자동 발견으로 조용히 대체 실행되는 것을 막는다", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "hyk377-empty-swept-root-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "hyk377-empty-swept-scratch-"));
  try {
    assert.throws(
      () =>
        runProductionSweep({ root: fixtureRoot, swept: [], dir: scratchDir }),
      /refuses to spawn 'node --test' with an EMPTY swept list/,
      "runProductionSweep({ swept: [] }) must throw before ever invoking spawnSync with zero file arguments",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

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
  runProductionSweep({ root, swept, dir });
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

// HYK-371 4R (검토자 3R-1 P1, coder-task.md §2): 3R의 층 2는
// `buildNestedSweepArgs(["dummy.test.mjs"])`를 **별도로 다시 불러** 그
// 기본 반환값만 봤다 -- 실제 생산 호출부(`runSweepAndAssert` 안의
// `buildNestedSweepArgs(swept)` 호출)와는 **연결이 없어서**, 그 호출부
// 자체를 `buildNestedSweepArgs(swept, 24)`로 몰래 바꾸는 변이가 층 2를
// 완전히 비켜갔다(검토자 실측: exit 0, tests 3, pass 3, fail 0).
//
// 고침: 관측 지점을 «빌더의 기본 반환»에서 **«생산 경로가 실제로 실행한
// argv»**로 옮긴다. `runSweepAndAssert`(생산 호출부가 실제로 쓰는 바로 그
// 함수)를 가짜 실행기(fake spawn)로 직접 구동해, 그 함수가 자신의 내부
// 호출부에서 만들어 낸 argv를 **그대로** 붙잡는다 -- 이제 호출부 자체가
// 바뀌면(override 추가·다른 값 등) 이 시험이 곧바로 그 실제 argv를 본다.
// 가짜 실행기는 진짜 `node --test`를 돌리지 않고 통과 모양의 TAP 결과만
// 합성해 반환하므로(수 ms) 층 2는 여전히 실행 없는 관측만큼 빠르다 --
// 다만 그 대상이 이제 "생산 코드가 실제로 만든 argv"라는 점이 3R과 다르다.
test("HYK-371 4R 완료조건① (층 2·계약, 관측 지점 = 생산 경로): 생산 호출부(runSweepAndAssert)가 실제로 실행하는 argv에 --test-concurrency=<의도된 캡>이 있다 -- 빌더의 기본 반환이 아니라 그 호출부 자체를 가짜 실행기로 구동해 실제 argv를 붙잡는다, CPU 수와 무관", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk371-4r-contract-"));
  try {
    let capturedArgs;
    const captureSpawn = (cmd, args) => {
      capturedArgs = args;
      // Synthesize a passing TAP shape so runSweepAndAssert's OWN parsing/
      // assertions (which this test still exercises, unmodified) succeed
      // without a real node --test process ever running.
      return {
        status: 0,
        signal: null,
        error: undefined,
        stdout: "# tests 1\n# fail 0\n",
        stderr: "",
      };
    };

    // Same function, same call site logic the real CI-canonical sweep uses
    // (via runProductionSweep) -- only the executor differs.
    runSweepAndAssert({
      root: repoRoot(),
      swept: ["dummy.test.mjs"],
      dir,
      spawn: captureSpawn,
    });

    assert.ok(
      capturedArgs,
      "captureSpawn was never called -- runSweepAndAssert did not reach its executor at all, cannot verify the real argv",
    );
    assert.ok(
      capturedArgs.includes(`--test-concurrency=${NESTED_SWEEP_CONCURRENCY}`),
      `the argv runSweepAndAssert ACTUALLY executed does not contain "--test-concurrency=${NESTED_SWEEP_CONCURRENCY}" -- captured args: ${JSON.stringify(capturedArgs)}`,
    );
    assert.ok(
      NESTED_SWEEP_CONCURRENCY <= MAX_INTENDED_NESTED_SWEEP_CONCURRENCY,
      `NESTED_SWEEP_CONCURRENCY is ${NESTED_SWEEP_CONCURRENCY}, which exceeds the pinned ceiling ${MAX_INTENDED_NESTED_SWEEP_CONCURRENCY} -- this is what "reverted to effectively no cap" looks like on ANY machine (a plain numeric comparison, not an execution-based inference), regardless of what that machine's own default concurrency happens to be`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
