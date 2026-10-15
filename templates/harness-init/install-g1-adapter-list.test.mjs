// install-g1-adapter-list.test.mjs -- HYK-209-install-list-g1-adapter-1.
//
// Reproduced fact (coder.md §1, ORCH-73's editor-reinstall-4 review P2-1/
// P2-2): relay-handshake-g1-dispatch-check.test.mjs (the §1 "result file
// top 3 lines" G1 dispatch-verification machine check) and admission-
// completion-adapter.mjs (the retirement-completion adapter relay-
// handshake.mjs spawns by path) were both entirely absent from
// ENFORCEMENT_CHECK_FILES -- an installed target repo's own CI had no
// regression net for either axis. install-copylist-closure.test.mjs's
// generic, list-wide import-closure check already covers requirement (b)
// (the two files' own static import closure) once the two names -- and
// admission-completion-adapter.mjs's own previously-missing dependency,
// ledger-pointer-shared.mjs -- are in the list (proven green by that file's
// existing "ⓐ' install copy-list closure" test; this file does not
// duplicate that proof). What that generic test does NOT cover is (a)
// whether these two SPECIFIC names remain in the list at all and (c)
// whether an actual installed target's dry-run output names them as
// install targets (the closure test never shells out to the installer).
//
// 2R (review 1R P1-1): the generic closure test being green does NOT mean
// an installed copy actually LOADS -- it only follows static `import`/
// `export ... from` specifiers. ledger-pointer-shared.test.mjs (added to
// the list by 1R, now deliberately kept OUT, see install.mjs's own
// ENFORCEMENT_CHECK_FILES comment) does a module-top-level `readFileSync`
// of "../supervisor/orch-stall-detect.mjs" -- a plain fs read, invisible to
// that regex-based closure walk -- and orch-stall-detect.mjs is not on any
// copy-list axis, so an installed copy of that one test file dies at
// import time (ENOENT) even though the closure test stayed green. (b)
// below is the machine-checked net for exactly that class of gap: it uses
// the REAL installer (`install.mjs`, not a `--dry-run`, which never
// actually loads anything) to install into a real `git init` target
// outside this worktree, and then actually RUNS (via a child `node --test`
// against the installed copy, not just an import()/load probe -- see (b)'s
// own comment for the H2 history of that change) the two newly-listed test
// files there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENFORCEMENT_CHECK_FILES } from "./install.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALLER_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);
const CHECK_SRC_DIR = path.join(REPO_ROOT, "scripts", "check");

const NAMES = [
  "relay-handshake-g1-dispatch-check.test.mjs",
  "admission-completion-adapter.mjs",
];

// (a) 두 이름이 목록에 있다. 보조 함수로 뽑아 둔다 -- 아래 V1/V2 음성
// 대조가 "이름과 다르게 (a) 단언을 줄인 목록에 다시 돌리지 않는다"(검토
// 1R P2-1)던 지적을 고치려면, 대조 쪽이 바로 이 함수를 다시 불러야 한다.
function assertNamePresent(list, name) {
  assert.ok(
    list.includes(name),
    `expected ENFORCEMENT_CHECK_FILES to include ${name}`,
  );
}

test("(a) ENFORCEMENT_CHECK_FILES contains both relay-handshake-g1-dispatch-check.test.mjs and admission-completion-adapter.mjs", () => {
  for (const name of NAMES) {
    assertNamePresent(ENFORCEMENT_CHECK_FILES, name);
  }
});

// 2R P2-1 수리: V1/V2 음성 대조는 "이름이 빠졌는지"를 배열 멤버십으로
// 직접 다시 확인하는 동어반복이었다(검토 1R 지적) -- (a)가 쓰는 단언
// 함수 자체를 줄인 목록에 다시 돌려 그 단언이 실제로 RED(throw)가 되는지
// 본다. neither name is imported by anything ELSE already in
// ENFORCEMENT_CHECK_FILES with ONE exception, measured live via `grep
// -rn`: nothing anywhere imports relay-handshake-g1-dispatch-check
// .test.mjs back (only a comment-text mention in hyk387-dispatch-record-
// required.test.mjs) -- V1 relies on this file's own (a) assertion as its
// ONLY regression net. admission-completion-adapter.mjs is different: its
// OWN pair test, admission-completion-adapter.test.mjs (already in this
// same list, this round), statically imports it back
// (`import { autoCompleteAdmission, completeAdmissionReservation } from
// "./admission-completion-adapter.mjs"`) -- so install-copylist-closure
// .test.mjs's generic, list-wide closure check ALSO catches V2 on its own
// (2R P3-2 correction of coder.md 1R's "어댑터는 아무것도 되돌려 import
// 하지 않는다", which was wrong about this specific name; three OTHER
// files outside this list -- hyk209-mask-readers.test.mjs, hyk461-archive-
// evidence.test.mjs, hyk468-3r-three-readers.test.mjs -- also import it
// but are invisible to that generic check since they are not list members
// themselves). V2's control below still has teeth of its own regardless:
// it is a second, independent net for the same name.
for (const removedName of NAMES) {
  test(`V1/V2 negative control: removing "${removedName}" from the (in-memory) list fails the (a) presence assertion`, () => {
    const reduced = ENFORCEMENT_CHECK_FILES.filter((n) => n !== removedName);
    assert.ok(
      reduced.length === ENFORCEMENT_CHECK_FILES.length - 1,
      `${removedName} must actually be present in the real list for this control to mean anything`,
    );
    assert.throws(
      () => assertNamePresent(reduced, removedName),
      /expected ENFORCEMENT_CHECK_FILES to include/,
      `(a)의 존재 단언을 "${removedName}"이 빠진 목록에 다시 돌렸는데도 RED가 나지 않았다 -- 대조가 이빨이 없다는 뜻`,
    );
  });
}

// 고정 칸 ⓐ (2R §2 요구 2): ledger-pointer-shared.test.mjs는 "짝 시험
// 동반" 관례의 의도적 예외다 -- install.mjs의 ENFORCEMENT_CHECK_FILES
// 자신의 주석(바로 그 이름 줄 위)이 이유를 적고 있다: 이 시험은 설치되지
// 않는 scripts/supervisor/orch-stall-detect.mjs를 모듈 최상위에서
// readFileSync하므로, 설치 대상에 이 시험 파일만 올리면 로드 단계에서
// ENOENT로 죽는다(검토 1R P1-1, 이 파일의 (b)가 아래에서 실측으로
// 재현한다). 본체 ledger-pointer-shared.mjs는 그대로 목록에 있다
// (admission-completion-adapter.mjs의 폐쇄상 필수, install-copylist-
// closure.test.mjs의 PAST_INCIDENTS가 이미 그 이빨을 증명한다).
test("(a2) ENFORCEMENT_CHECK_FILES deliberately excludes ledger-pointer-shared.test.mjs (the paired-test convention's documented exception, review 1R P1-1) while keeping ledger-pointer-shared.mjs itself", () => {
  assert.ok(
    !ENFORCEMENT_CHECK_FILES.includes("ledger-pointer-shared.test.mjs"),
    "ledger-pointer-shared.test.mjs must stay OUT of the list -- installing it reads a never-installed supervisor file at module top level and ENOENTs (see (b) below)",
  );
  assertNamePresent(ENFORCEMENT_CHECK_FILES, "ledger-pointer-shared.mjs");
});

function makeSyntheticTarget(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const targetRepo = path.join(base, "target-repo");
  mkdirSync(targetRepo, { recursive: true });
  execFileSync("git", ["-C", targetRepo, "init", "-q"]);
  return { base, targetRepo };
}

function runInstallDryRun(args) {
  return execFileSync("node", [INSTALLER_PATH, ...args, "--dry-run"], {
    encoding: "utf8",
  });
}

// (c) 합성 대상 dry-run 출력에 두 파일이 "설치 대상"으로 나온다.
test("(c) solo-full synthetic dry-run names both files as would-install targets", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-g1-adapter-dry-");
  try {
    const out = runInstallDryRun([
      "--profile",
      "solo-full",
      "--repo-path",
      targetRepo,
      "--control-room-path",
      path.join(base, "fake-control-room"),
      "--github-repo",
      "someorg/somerepo",
      "--bot-account",
      "bot-x",
      "--verify-cmd",
      "npm test",
      "--notify-dir",
      path.join(base, "notify"),
      "--approver-login",
      "approver-x",
      "--approver-id",
      "1",
      "--workspaces-root",
      path.join(base, "workspaces"),
      "--main-repo-path",
      path.join(base, "main-repo"),
    ]);
    for (const name of NAMES) {
      assert.match(
        out,
        new RegExp(
          `\\[dry-run\\] would install:.*scripts[\\\\/]check[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
        `expected dry-run output to name scripts/check/${name} as a would-install target`,
      );
    }
    // ledger-pointer-shared.test.mjs must NOT be a would-install target --
    // a direct dry-run-level restatement of (a2) above.
    assert.doesNotMatch(
      out,
      /\[dry-run\] would install:.*scripts[\\/]check[\\/]ledger-pointer-shared\.test\.mjs/,
      "expected dry-run output to NOT name scripts/check/ledger-pointer-shared.test.mjs as a would-install target",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ⓑ 고정 칸 -- HYK-434 H2(책임자 판정 2026-10-15 15:39 §3, H3 검토 2R
// P2-1/P3-1/P3-2 수리): 이전 판(2R)은 "평평한 날복사 + import() 프로브"
// 였다 -- 그 방식은 설치기(install.mjs) 자신의 복사 로직을 전혀 거치지
// 않고 이 시험 파일이 직접 재구현한 별도 경로였다(목록이 진짜로
// 설치되는지가 아니라, 이 시험이 스스로 흉내 낸 로직이 맞는지만
// 증명했다). 이제 **실제 설치기**(`install.mjs`, `--dry-run` 없이)로
// 워크트리 밖 빈 `git init` 대상에 실제로 설치하고, 새로 실리는 두
// `.test.mjs`(g1 시험·어댑터 짝 시험)를 그 설치된 자리에서 `node --test`
// 로 **실제 실행**해 실패 0을 본다(ⓒ가 이미 쓰는 것과 같은 CLI 인자
// 모양을 그대로 재사용한다 -- 로직을 새로 발명하지 않는다).
function installerArgsFor(base, targetRepoPath) {
  return [
    "--profile",
    "solo-full",
    "--repo-path",
    targetRepoPath,
    "--control-room-path",
    path.join(base, "fake-control-room"),
    "--github-repo",
    "someorg/somerepo",
    "--bot-account",
    "bot-x",
    "--verify-cmd",
    "npm test",
    "--notify-dir",
    path.join(base, "notify"),
    "--approver-login",
    "approver-x",
    "--approver-id",
    "1",
    "--workspaces-root",
    path.join(base, "workspaces"),
    "--main-repo-path",
    path.join(base, "main-repo"),
  ];
}

function runRealInstall(base, targetRepoPath) {
  return execFileSync(
    "node",
    [INSTALLER_PATH, ...installerArgsFor(base, targetRepoPath)],
    { encoding: "utf8" },
  );
}

// HYK-359's admission-ledger-env-isolation.mjs's own AMBIENT_LEDGER_ENV_KEYS
// -- duplicated here by name (not imported: that file lives under
// scripts/check/, this test under templates/harness-init/, and importing
// across that boundary just to strip three well-known keys is not worth
// the coupling) so a floating ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
// DISPATCH_RECEIPT_PATH in the invoking shell cannot leak into the child
// `node --test` process this file now actually runs against the installed
// target.
function ledgerIsolatedEnv() {
  const env = { ...process.env };
  delete env.ADMISSION_LEDGER_PATH;
  delete env.ADMISSION_LOCK_PATH;
  delete env.DISPATCH_RECEIPT_PATH;
  // 측정 live(HYK-434 H2): 이 시험 파일 자신이 `node --test`로 돌 때 node
  // 자신이 NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID를 이미 환경에 심어 둔다
  // -- 이걸 그대로 물려주면 아래에서 설치된 대상에 또 거는 "자식"
  // `node --test`가 "run()이 같은 테스트 파일 안에서 재귀 호출됐다"고
  // 오인해 파일을 «돌리지도 않고» 조용히 exit 0(tests 0/pass 0)으로
  // 접는다 -- 실패 0이 아니라 "실행 자체가 0"이 되는 거짓 초록이었다.
  // 지우지 않으면 (b)/(b-negative) 둘 다 즉시 통과하는 헛시험이 된다.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

// HYK-434 H2 3R (책임자 판정 §2, 선례 scripts/check/hyk359-ambient-env-
// regression.test.mjs 머리 주석 60~90행과 그 파일의 runSweepAndAssert):
// 로컬(Node 26)과 CI가 고정하는 Node 20은 `node --test`의 기본 리포터를
// 다르게 고른다 -- Node 26은 파이프 출력이라도 무조건 spec(`ℹ tests N`)을
// 내고, Node 20은 TTY가 아닌 파이프에서 tap(`# tests N`)을 낸다(이 PC에서
// 직접 대조: 위 두 reporter 모양, `--test-reporter` 없이 파이프로 받으면
// 이 PC는 늘 `ℹ tests N`). PR #317 CI run 751/752가 그 차이로 결정론적
// 빨강이었다(1b_shown). 고침: 자식 리포터를 `tap`으로 명시해 Node 버전과
// 무관하게 출력 형식을 고정한다. `maxBuffer`도 HYK-359 4R의 같은 교훈(기본
// 1MB로는 조용히 잘려 "0건"으로 오독될 수 있다)을 그대로 적용해 넉넉히
// 올린다.
function runInstalledNodeTest(installedCheckDir, names, timeoutMs = 300000) {
  return spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...names],
    {
      cwd: installedCheckDir,
      encoding: "utf8",
      env: ledgerIsolatedEnv(),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

// 요약 판독을 이름 있는 함수로 뺀다(책임자 판정 §2 요구 2) -- `# tests N`/
// `# fail N`(TAP, 위에서 명시 고정한 그 형식) 한 가지만 읽는다. 옛 `ℹ`
// 정규식과 겸용하지 않는다(두 형식을 동시에 봐주면 "실제로 어느 쪽이
// 작동했는지"가 다시 애매해진다 -- 이 라운드가 고치는 바로 그 애매함).
// `fail`의 정규식이 `[1-9]\d*`(1 이상만)인 것은 판정 §2 요구 2 원문 그대로
// 다 -- `# fail 0` 줄은 이 정규식으로는 "못 찾음"이 되므로, 매치가 없으면
// fail을 0으로 채워 돌려준다(호출부의 "fail 0" 단언에는 차이가 없다).
// 요약 줄 자체를 전혀 못 찾으면(`# tests N`이 없음 -- 리포터가 TAP이
// 아니거나 출력이 잘렸다는 뜻) null을 돌려준다.
function parseTapSummary(text) {
  const testsMatch = (text ?? "").match(/^# tests (\d+)/m);
  if (!testsMatch) return null;
  const failMatch = (text ?? "").match(/^# fail ([1-9]\d*)/m);
  return {
    tests: Number(testsMatch[1]),
    fail: failMatch ? Number(failMatch[1]) : 0,
  };
}

// HYK-434 H2 3R 요구 3: 판독 함수 자체를 Node 20 TAP 출력 모양을 문자열로
// 박은 합성 표본으로 단위 시험한다 -- (b)/(b-negative)는 실제 설치·실행을
// 거치므로 "이 PC(Node 26)가 실제로 내는 TAP"만 증명하고, "Node 20이 내는
// 모양을 이 함수가 제대로 읽는지"는 이 PC에서 Node 20을 못 돌리므로 직접
// 재현할 수 없다(책임자 판정 §2 요구 3 원문: "Node 20 실행은 이 PC에서 못
// 한다면 «못 쟀다»"). 대신 Node 20 TAP reporter의 공개된 요약 줄 모양을
// 문자열로 고정해 넣어 판독만 단위로 본다.
//
// 표본 출처 〔전사〕: 요약 줄 모양(`# tests N` / `# pass N` / `# fail N` /
// `# cancelled N` / `# skipped N` / `# todo N` / `# duration_ms N`)은 이
// PC의 Node 26에서 `--test-reporter=tap`으로 작은 시험을 돌려 직접 본
// 원문(위 함수 도입 전 측정, 이 코멘트 작성 시점 재확인: `node --test
// --test-reporter=tap`을 임시 파일 하나에 돌려 그대로 복사)과 같은 줄
// 모양이다. 앞의 `TAP version 13`/`# Subtest:`/`ok`/`not ok`/YAML 블록도
// 실제 TAP 출력에서 그대로 가져왔다. 〔못쟀다〕: 이 PC에 Node 20이 없어
// "Node 20 자신이 정말 이 모양을 내는지"는 직접 대조하지 못했다 -- 공개된
// TAP reporter 계약과 이 PC의 Node 26 `--test-reporter=tap` 출력이 같은
// 모양이라는 점으로 대신한다(coder.md 한계 문단에 그대로 적는다).
const NODE20_TAP_PASS_SAMPLE = `TAP version 13
# Subtest: some test
ok 1 - some test
  ---
  duration_ms: 1.234
  type: 'test'
  ...
1..1
# tests 123
# suites 0
# pass 123
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 456.789
`;

const NODE20_TAP_FAIL_SAMPLE = `TAP version 13
# Subtest: a failing test
not ok 1 - a failing test
  ---
  duration_ms: 2.5
  type: 'test'
  ...
# tests 10
# suites 0
# pass 8
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50.0
`;

const NODE_SPEC_SAMPLE = `ℹ tests 123
ℹ suites 0
ℹ pass 123
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 456.789
`;

test("parseTapSummary reads Node 20 TAP's '# tests N'/'# fail N' summary lines (pass sample, fail 0)", () => {
  assert.deepEqual(parseTapSummary(NODE20_TAP_PASS_SAMPLE), {
    tests: 123,
    fail: 0,
  });
});

test("parseTapSummary reads Node 20 TAP's '# tests N'/'# fail N' summary lines (fail sample, fail 2)", () => {
  assert.deepEqual(parseTapSummary(NODE20_TAP_FAIL_SAMPLE), {
    tests: 10,
    fail: 2,
  });
});

test("parseTapSummary returns null on the spec-reporter shape (ℹ tests N) -- 두 형식을 겸용하지 않는다, Node 버전과 무관하게 한 형식만 신뢰한다", () => {
  assert.equal(parseTapSummary(NODE_SPEC_SAMPLE), null);
});

test("(b) real installer (not --dry-run) installs into a git-init target outside this worktree, and `node --test` on the two newly-listed test files there has 0 failures", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-g1-adapter-real-");
  try {
    runRealInstall(base, targetRepo);
    const installedCheckDir = path.join(targetRepo, "scripts", "check");
    for (const name of [
      "relay-handshake-g1-dispatch-check.test.mjs",
      "admission-completion-adapter.test.mjs",
    ]) {
      assert.ok(
        existsSync(path.join(installedCheckDir, name)),
        `expected the real installer to have copied ${name} into the target`,
      );
    }
    const result = runInstalledNodeTest(installedCheckDir, [
      "relay-handshake-g1-dispatch-check.test.mjs",
      "admission-completion-adapter.test.mjs",
    ]);
    // HYK-434 H2 3R (책임자 판정 §2 요구 1, HYK-359 4R ①의 같은 교훈):
    // spawnSync 자체의 실패(예: maxBuffer를 넘겨 Node가 자식을 죽이면
    // result.error.code === 'ENOBUFS')는 그 자체로 요란하게 실패해야
    // 한다 -- 아래 "0건 실행" 판정으로 재해석되면 안 된다.
    assert.equal(
      result.error,
      undefined,
      `spawnSync itself failed (child may have been killed mid-run, e.g. exceeding maxBuffer) -- error: ${result.error?.message} (code: ${result.error?.code}), signal: ${result.signal}, status: ${result.status}, stdout captured so far: ${(result.stdout ?? "").length} byte(s)`,
    );
    assert.equal(
      result.status,
      0,
      `expected 0 test failures running the installed files via a real install; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const summary = parseTapSummary(result.stdout + result.stderr);
    assert.ok(
      summary,
      `could not find TAP's '# tests N' summary line in the child's output at all -- --test-reporter=tap may not have taken effect, or the output was cut off before the summary. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(
      summary.fail,
      0,
      `expected fail 0 in the node --test TAP summary; stdout:\n${result.stdout}`,
    );
    // ★헛시험 방지(HYK-434 H2 측정 live): "실패 0"은 "실행 자체가 0건"
    // 이어도 참이 된다 -- node:test가 NODE_TEST_CONTEXT를 물려받아
    // "재귀 호출"로 오인해 파일을 돌리지도 않고 tests 0/pass 0으로
    // 조용히 접는 실제 사고를 이 라운드가 겪었다(ledgerIsolatedEnv가
    // 그 축을 지운다). 적어도 100건 이상 실제로 돌았음을 값으로 본다
    // (설치된 두 파일의 실제 시험 수는 100건을 훨씬 넘는다).
    assert.ok(
      summary.tests >= 100,
      `expected at least 100 actually-run tests (not a silent 0-test false-green); stdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ⓑ 음성 대조 -- 같은 경로(실제 설치기 + 실제 git 대상)로 재구성한다.
// 설치기(install.mjs) 자신의 ENFORCEMENT_CHECK_FILES는 이 조각의 범위
// 밖(product_scope: install.mjs는 주석 줄만)이라 소스를 고쳐 재설치할
// 수 없다 -- 대신 "메모리상 목록에 ledger-pointer-shared.test.mjs를
// 다시 넣은 판"을 그 목록이 실제로 하는 것과 똑같은 동작(install.mjs
// 자신의 installEnforcementScripts가 ENFORCEMENT_CHECK_FILES의 각
// 항목에 대해 하는 것과 바이트 단위로 같은 `copyFileSync(REPO_ROOT/
// scripts/check/<name>, targetRepo/scripts/check/<name>)` 한 호출)으로
// 재현한다 -- 설치 로직을 다시 구현하는 게 아니라 "그 목록에 있었다면
// 설치기가 했을 바로 그 복사 한 번"을 추가할 뿐이다. orch-stall-
// detect.mjs는 일부러 복사하지 않는다(어떤 축에도 없는 그 상태 자체가
// 결함의 조건이다, 검토 1R P1-1).
test('(b-negative) real installer + one extra copy reproducing "ledger-pointer-shared.test.mjs re-added to the list" fails to load it via `node --test` (ENOENT on orch-stall-detect.mjs)', () => {
  assert.ok(
    !ENFORCEMENT_CHECK_FILES.includes("ledger-pointer-shared.test.mjs"),
    "ledger-pointer-shared.test.mjs must actually be absent from the real list for this control to mean anything",
  );
  const { base, targetRepo } = makeSyntheticTarget(
    "hyk209-g1-ledger-revert-real-",
  );
  try {
    runRealInstall(base, targetRepo);
    const installedCheckDir = path.join(targetRepo, "scripts", "check");
    const name = "ledger-pointer-shared.test.mjs";
    assert.ok(
      !existsSync(path.join(installedCheckDir, name)),
      "expected the real (unaugmented) install to NOT have installed ledger-pointer-shared.test.mjs",
    );
    // install.mjs installEnforcementScripts의 for-loop 본문과 바이트
    // 단위로 같은 한 번의 copyFileSync -- "이 이름이 목록에 있었다면"을
    // 재현하는 것이지, 설치 로직을 다시 만드는 것이 아니다.
    copyFileSync(
      path.join(CHECK_SRC_DIR, name),
      path.join(installedCheckDir, name),
    );

    const result = runInstalledNodeTest(installedCheckDir, [name]);
    assert.notEqual(
      result.status,
      0,
      "expected re-adding ledger-pointer-shared.test.mjs to the list to make a real install fail to load it (it reads an uninstalled supervisor file at module top level)",
    );
    assert.match(
      result.stdout + result.stderr,
      /ENOENT/,
      `expected a module-top-level ENOENT reading orch-stall-detect.mjs; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(
      result.stdout + result.stderr,
      /orch-stall-detect\.mjs/,
      `expected the ENOENT to name orch-stall-detect.mjs specifically; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
