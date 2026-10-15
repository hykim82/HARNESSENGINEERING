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
// below is the machine-checked net for exactly that class of gap: it
// stages a synthetic install target by directly copying the files named in
// the real lists (not a `--dry-run`, which never actually loads anything)
// and then LOADS (not fully runs -- see (b)'s own comment for why) the two
// newly-listed test files there.
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
import {
  ENFORCEMENT_CHECK_FILES,
  ENFORCEMENT_SUPERVISOR_FILES,
} from "./install.mjs";

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
const SUPERVISOR_SRC_DIR = path.join(REPO_ROOT, "scripts", "supervisor");

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

// ⓑ 고정 칸 (2R §2 요구 3, "가능하면"): --dry-run은 아무 파일도 쓰지
// 않으므로 아무것도 "로드"하지 않는다 -- (c)는 설치기가 설치 "대상"으로
// 이름을 대는지만 본다. 이 테스트는 그 대신 실제 파일을 날복사로
// 합성 대상 폴더에 깔아 둔다(목록의 세 축 중 check + supervisor; relay
// 축은 g1 시험·어댑터 시험 둘 다 끌어들이지 않으므로 뺀다 -- 설치기
// 로직 자체는 건드리지 않는다, 그냥 fs.copyFileSync다).
//
// "로드"만 재는 이유 (풀 테스트 실행이 아님, 의도적): relay-handshake-
// g1-dispatch-check.test.mjs의 일부 되돌림-변이 시험은 합성 대상이 실제
// git worktree인지 등 이 파일의 범위를 넘는 실행 맥락에 의존한다
// (측정 live: 합성 대상에 .git이 없을 때 그런 서브테스트 하나가
// 거짓맥락으로 실패했다 -- install 목록 결함이 아니라 이 파일이 재려는
// 축 밖의 일이다). 반면 검토 1R이 실제로 찾은 결함(orch-stall-detect
// .mjs의 module-top-level readFileSync ENOENT)은 import 시점에, 즉
// 어떤 테스트 바디가 돌기도 전에 터진다. 그래서 이 테스트는 `node --test`
// 로 전체를 돌리지 않고, 자식 프로세스에서 `import(그 파일)`만 해서
// "로드 실패 0"이라는 요구를 정확히, 그리고 테스트 바디 실행 여부와
// 무관하게 잰다(V1 변이로 직접 다시 확인했다: 이 probe는 두 정상 파일을
// 그대로 통과시키면서도, 그 되돌림-변이 서브테스트는 돌리지 않는다).
function stageSyntheticInstall(
  prefix,
  {
    checkList = ENFORCEMENT_CHECK_FILES,
    supervisorList = ENFORCEMENT_SUPERVISOR_FILES,
  } = {},
) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const checkDir = path.join(base, "check");
  const supervisorDir = path.join(base, "supervisor");
  mkdirSync(checkDir, { recursive: true });
  mkdirSync(supervisorDir, { recursive: true });
  for (const name of checkList) {
    const src = path.join(CHECK_SRC_DIR, name);
    if (existsSync(src)) copyFileSync(src, path.join(checkDir, name));
  }
  for (const name of supervisorList) {
    const src = path.join(SUPERVISOR_SRC_DIR, name);
    if (existsSync(src)) copyFileSync(src, path.join(supervisorDir, name));
  }
  return { base, checkDir, supervisorDir };
}

// HYK-359's admission-ledger-env-isolation.mjs's own AMBIENT_LEDGER_ENV_KEYS
// -- duplicated here by name (not imported: that file lives under
// scripts/check/, this test under templates/harness-init/, and importing
// across that boundary just to strip three well-known keys is not worth
// the coupling) so a floating ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
// DISPATCH_RECEIPT_PATH in the invoking shell cannot leak into the staged
// child process's import probe.
function ledgerIsolatedEnv() {
  const env = { ...process.env };
  delete env.ADMISSION_LEDGER_PATH;
  delete env.ADMISSION_LOCK_PATH;
  delete env.DISPATCH_RECEIPT_PATH;
  return env;
}

// `node -e "import('./<name>').then(load ok).catch(load error)"` -- runs
// the staged file's module top level (where the ENOENT in review 1R P1-1
// actually happens) without letting node:test's own deferred runner
// execute any test body (process.exit() fires inside the settled
// import()'s own callback, before that scheduling point).
function probeLoad(dir, name, timeoutMs = 15000) {
  const script = `import(${JSON.stringify("./" + name)}).then(() => { process.exit(0); }).catch((e) => { console.error("LOAD_ERROR: " + (e && e.stack ? e.stack : e)); process.exit(1); });`;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: dir,
    encoding: "utf8",
    env: ledgerIsolatedEnv(),
    timeout: timeoutMs,
  });
}

test("(b) staged synthetic install target (direct file copy, not --dry-run) loads both newly-listed test files with 0 load failures", () => {
  const { base, checkDir } = stageSyntheticInstall("hyk209-g1-adapter-stage-");
  try {
    for (const name of [
      "relay-handshake-g1-dispatch-check.test.mjs",
      "admission-completion-adapter.test.mjs",
    ]) {
      const result = probeLoad(checkDir, name);
      assert.equal(
        result.status,
        0,
        `expected ${name} to load with 0 failures in the staged target; stderr:\n${result.stderr}`,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ⓑ 음성 대조 (2R §2 요구 3의 "되돌림에서 RED 가 되는지"): 메모리상
// 목록에 ledger-pointer-shared.test.mjs를 다시 넣고 같은 방식으로
// 합성 대상을 깔면, 그 파일만 로드 실패(ENOENT)로 떨어져야 한다 --
// 검토 1R이 에디터 사본에서 1회성으로 손으로 잰 것과 같은 모양을
// 영구 회귀 그물로 만든 것이다. orch-stall-detect.mjs는 일부러 복사하지
// 않는다(어떤 축에도 없는 그 상태 자체가 결함의 조건이다).
test('(b-negative) re-adding "ledger-pointer-shared.test.mjs" to the (in-memory) list makes a staged synthetic install fail to load it (ENOENT on orch-stall-detect.mjs)', () => {
  const augmentedCheckList = [
    ...ENFORCEMENT_CHECK_FILES,
    "ledger-pointer-shared.test.mjs",
  ];
  assert.ok(
    !ENFORCEMENT_CHECK_FILES.includes("ledger-pointer-shared.test.mjs"),
    "ledger-pointer-shared.test.mjs must actually be absent from the real list for this control to mean anything",
  );
  const { base, checkDir } = stageSyntheticInstall("hyk209-g1-ledger-revert-", {
    checkList: augmentedCheckList,
  });
  try {
    const result = probeLoad(checkDir, "ledger-pointer-shared.test.mjs");
    assert.notEqual(
      result.status,
      0,
      "expected re-adding ledger-pointer-shared.test.mjs to the list to make the staged target fail to load it (it reads an uninstalled supervisor file at module top level)",
    );
    assert.match(
      result.stderr,
      /ENOENT/,
      `expected a module-top-level ENOENT reading orch-stall-detect.mjs; got stderr:\n${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /orch-stall-detect\.mjs/,
      `expected the ENOENT to name orch-stall-detect.mjs specifically; got stderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
