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

function runInstalledNodeTest(installedCheckDir, names, timeoutMs = 300000) {
  return spawnSync(process.execPath, ["--test", ...names], {
    cwd: installedCheckDir,
    encoding: "utf8",
    env: ledgerIsolatedEnv(),
    timeout: timeoutMs,
  });
}

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
    assert.equal(
      result.status,
      0,
      `expected 0 test failures running the installed files via a real install; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /ℹ fail [1-9]/,
      `expected fail 0 in the node --test summary; stdout:\n${result.stdout}`,
    );
    // ★헛시험 방지(HYK-434 H2 측정 live): "실패 0"은 "실행 자체가 0건"
    // 이어도 참이 된다 -- node:test가 NODE_TEST_CONTEXT를 물려받아
    // "재귀 호출"로 오인해 파일을 돌리지도 않고 tests 0/pass 0으로
    // 조용히 접는 실제 사고를 이 라운드가 겪었다(ledgerIsolatedEnv가
    // 그 축을 지운다). 적어도 100건 이상 실제로 돌았음을 값으로 본다
    // (설치된 두 파일의 실제 시험 수는 100건을 훨씬 넘는다).
    const testsMatch = (result.stdout + result.stderr).match(/ℹ tests (\d+)/);
    assert.ok(
      testsMatch && Number(testsMatch[1]) >= 100,
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
