// NC-1 negative-control: git-hook install/wiring confirmation.
//
// Every assertion here reads real files (either the tracked `hooks/*`
// mirror, or -- only when present -- the installed `.git/hooks/*` copy) --
// never writes to them, never copies them anywhere. This is the "does the
// wiring even exist" check underneath the review-gate/quality-check/
// gitleaks device tests: a device can be proven BLOCKED in isolation and
// still do nothing in practice if the hook that's supposed to call it was
// never installed, or core.hooksPath points somewhere else.
//
// 4R rewrite (한용 게이트 2, 2026-07-30, 원인 = 설계 결함 again -- ORCH's §10
// instructions scoped "apply the CI-checkout-scope lesson" to only the
// tests added/fixed in that round, leaving 1R's original tests unreviewed
// against the same lesson). ORCH measured, by cloning this repo into a
// fresh mkdtemp single checkout (approximating CI -- confirmed by reading
// .github/workflows/enforce.yml end to end: no step installs anything into
// .git/hooks, and package.json has no prepare/postinstall script either),
// that 6 of this file's 10 tests fail there: every test that assumed
// .git/hooks/{commit-msg,pre-commit} exist. CI has exactly that condition
// (a fresh checkout, zero installed hooks), so as of 3R this file would
// have turned CI red. §11's contract: make the WHOLE file CI-portable --
// state-of-the-installed-hook tests become environment-conditional (skip
// cleanly when not installed), and anything that must ALWAYS hold moves to
// either the tracked `hooks/*` mirror (checked out in every clone,
// including CI) or a fully synthetic fixture. Every test below carries a
// one-line "CI 성립 근거" comment explaining why it holds under CI's exact
// checkout condition (single checkout, zero installed hooks).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkNativeGitHook } from "./selfcheck-inventory.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
function commonDir(cwd) {
  return execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// Hotfix (2026-07-30, regression found post-merge in the MAIN repo checkout,
// never in this linked worktree): `git rev-parse --git-common-dir` returns
// a RELATIVE path (".git") when run from the main checkout, but an ABSOLUTE
// path when run from a linked worktree -- both refer to the exact same
// directory. The pre-hotfix code took that raw value and later compared it
// against ROOT (always absolute, from --show-toplevel) with `!==` as bare
// strings: "." !== "C:/.../HARNESSENGINEERING" is true even though they are
// the same folder, so the main repo checkout was wrongly judged to have
// "two different real checkouts" and the environment-conditional
// corroboration test asserted two identical results must differ -- which
// they don't, so it failed. `join(".git", "..")` also only resolves
// correctly if the CURRENT PROCESS's cwd happens to equal ROOT (true when
// `node --test` is invoked from the repo root, accidentally, not
// guaranteed) -- an environment-dependent coincidence, not something this
// file should rely on. Fix: resolve every git-common-dir/repo-root value to
// an absolute path ONCE, right after reading it, explicit about which base
// directory a relative result is relative to (the `cwd` the git command
// itself ran with, not process.cwd() -- those can differ). realpathSync is
// then applied on top: Windows drive-letter case and 8.3/symlink aliasing
// can make two paths that are byte-different but filesystem-identical, and
// a bare string `!==` would still misjudge those as "different checkouts."
// realpathSync requires the path to exist, which .git-common-dir and the
// repo root both always do.
function absoluteRealPath(cwd, rawPath) {
  return realpathSync(resolve(cwd, rawPath));
}

const ROOT = absoluteRealPath(process.cwd(), repoRoot());
const COMMON_DIR = absoluteRealPath(ROOT, commonDir(ROOT));
const HOOKS_DIR = join(COMMON_DIR, "hooks");
const COMMIT_MSG_HOOK = join(HOOKS_DIR, "commit-msg"); // installed copy (may not exist -- see INSTALLED_HOOKS_PRESENT)
const PRE_COMMIT_HOOK = join(HOOKS_DIR, "pre-commit"); // installed copy (may not exist -- see INSTALLED_HOOKS_PRESENT)
const TRACKED_COMMIT_MSG = join(ROOT, "hooks", "commit-msg"); // tracked mirror -- always present in any clone/CI
const TRACKED_PRE_COMMIT = join(ROOT, "hooks", "pre-commit"); // tracked mirror -- always present in any clone/CI

// Whether THIS checkout has actually had the hooks installed into
// .git/hooks (a local, developer-machine-only step -- CI never does this,
// confirmed by reading .github/workflows/enforce.yml). Every test that
// measures installed-hook *state* (as opposed to the tracked mirror's
// *contract*) gates on this and skips cleanly when false.
const INSTALLED_HOOKS_PRESENT =
  existsSync(COMMIT_MSG_HOOK) && existsSync(PRE_COMMIT_HOOK);
const NOT_INSTALLED_SKIP_REASON =
  "no installed .git/hooks/{commit-msg,pre-commit} in this checkout -- CI and any fresh single clone never install them (no prepare/postinstall script, no CI step does it), so this environment-conditional measurement skips instead of asserting anything there";

// 2R P1 fix: this file was the only one of the four nc-*.test.mjs suites
// missing the layer-3 recovery assertion entirely (measured pre-fix:
// after()=0, porcelain-assertion=0, "diff HEAD"-assertion=0 -- the other
// three already had both from round 1). Every test here is read-only, but
// the suite-level assertion is what makes an accidental future write in
// this file (or a change to checkNativeGitHook that starts writing) fail
// loudly instead of silently leaving drift in the real worktree.
// CI 성립 근거: `git status --porcelain`/`git diff HEAD --stat`는 어떤
// 체크아웃에서도 항상 실행 가능하다 -- 체크아웃 개수·설치 상태와 무관.
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
// Hotfix 2R (2026-07-30, ORCH requirement correction -- this was ORCH's own
// mistake, not a coder error): requiring `git diff HEAD --stat` to be
// EMPTY always fails while there is uncommitted, in-progress work on
// tracked files -- it doesn't test "this suite left the repo clean," it
// tests "there is nothing checked out that isn't committed yet," which is
// a different and much stronger claim. NC-1's original round happened to
// pass only because every changed file was untracked-new (empty diff
// against HEAD is a coincidence of that specific situation, not something
// this assertion actually verifies) -- the very hotfix that touches this
// tracked file is what exposed it (ORCH measured L1/L2/L3 all fail 4).
// What this suite can honestly promise is INVARIANCE: whatever diff
// existed before this suite ran still exists, byte-for-byte, after it ran.
// Captured here, compared in after() below.
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// --- Contract tests: the TRACKED mirror is what every clone (including
// CI) actually has, so these always run and never skip. ---

test("NC-1 install/contract: tracked hooks/commit-msg and hooks/pre-commit exist with a sane, non-stub size (read-only, always present in any checkout)", () => {
  // CI 성립 근거: `hooks/*`는 git이 추적하는 일반 파일이라 어떤 체크아웃
  // (CI 포함)에도 항상 존재한다 -- 설치 여부와 무관.
  assert.ok(
    existsSync(TRACKED_COMMIT_MSG),
    `tracked commit-msg hook must exist at ${TRACKED_COMMIT_MSG}`,
  );
  assert.ok(
    existsSync(TRACKED_PRE_COMMIT),
    `tracked pre-commit hook must exist at ${TRACKED_PRE_COMMIT}`,
  );
  const commitMsgSize = statSync(TRACKED_COMMIT_MSG).size;
  const preCommitSize = statSync(TRACKED_PRE_COMMIT).size;
  // Sanity range around ORCH's measured baseline (commit-msg 2,625B,
  // pre-commit 3,262B) -- not an exact-byte pin, since comment edits would
  // otherwise make this test brittle for no security reason. A hook that
  // shrank to near-zero (stubbed out) is the actual attack this range
  // guards against.
  assert.ok(
    commitMsgSize > 500,
    `tracked commit-msg hook (${commitMsgSize}B) looks truncated/stubbed relative to baseline 2,625B`,
  );
  assert.ok(
    preCommitSize > 500,
    `tracked pre-commit hook (${preCommitSize}B) looks truncated/stubbed relative to baseline 3,262B`,
  );
});

test(
  "NC-1 install/measurement (environment-conditional): installed .git/hooks/* also exist with a sane size, when this checkout has them installed",
  {
    skip: !INSTALLED_HOOKS_PRESENT && NOT_INSTALLED_SKIP_REASON,
  },
  () => {
    // CI 성립 근거: 이 시험은 "설치된 상태"라는 측정값을 재는 것이지 계약이
    // 아니다 -- 설치본이 없는 CI/단일 클론에서는 항상 skip되어 아무것도
    // 단언하지 않는다.
    const commitMsgSize = statSync(COMMIT_MSG_HOOK).size;
    const preCommitSize = statSync(PRE_COMMIT_HOOK).size;
    assert.ok(
      commitMsgSize > 500,
      `installed commit-msg hook (${commitMsgSize}B) looks truncated/stubbed relative to baseline 2,625B`,
    );
    assert.ok(
      preCommitSize > 500,
      `installed pre-commit hook (${preCommitSize}B) looks truncated/stubbed relative to baseline 3,262B`,
    );
  },
);

test("NC-1 install/contract: tracked hooks/commit-msg actually invokes review-gate.mjs (checked against the tracked mirror, not the installed copy)", () => {
  // CI 성립 근거: 추적본(hooks/commit-msg)은 모든 체크아웃에 항상 존재하므로,
  // "훅이 review-gate.mjs를 부르는가"라는 계약을 추적본에 대해 검사하면
  // 설치 상태와 무관하게 항상 성립·실행된다.
  const text = readFileSync(TRACKED_COMMIT_MSG, "utf8");
  assert.match(
    text,
    /review-gate\.mjs/,
    "tracked commit-msg hook must reference review-gate.mjs, or the gate is dead wiring",
  );
});

test("NC-1 install/contract: tracked hooks/pre-commit actually invokes quality-check.mjs (checked against the tracked mirror, not the installed copy)", () => {
  // CI 성립 근거: 위와 동일 -- 추적본 기준 검사라 항상 실행된다.
  const text = readFileSync(TRACKED_PRE_COMMIT, "utf8");
  assert.match(
    text,
    /quality-check\.mjs/,
    "tracked pre-commit hook must reference quality-check.mjs, or the gate is dead wiring",
  );
});

test("NC-1 install/contract: tracked hooks/pre-commit actually invokes gitleaks (checked against the tracked mirror, not the installed copy)", () => {
  // CI 성립 근거: 위와 동일 -- 추적본 기준 검사라 항상 실행된다.
  const text = readFileSync(TRACKED_PRE_COMMIT, "utf8");
  assert.match(
    text,
    /gitleaks/,
    "tracked pre-commit hook must reference gitleaks, or the scan is dead wiring",
  );
});

test(
  "NC-1 install/measurement (environment-conditional): the INSTALLED copies (when present) reference the same modules as the tracked mirror",
  {
    skip: !INSTALLED_HOOKS_PRESENT && NOT_INSTALLED_SKIP_REASON,
  },
  () => {
    // CI 성립 근거: 이건 "설치본이 추적본과 같은 모듈을 부르는가"라는
    // 설치-상태 측정값이라 CI/단일 클론에서는 skip된다 -- 계약 자체(위 세
    // "install/contract" 시험들)는 이미 추적본으로 항상 성립한다.
    const installedCommitMsg = readFileSync(COMMIT_MSG_HOOK, "utf8");
    const installedPreCommit = readFileSync(PRE_COMMIT_HOOK, "utf8");
    assert.match(installedCommitMsg, /review-gate\.mjs/);
    assert.match(installedPreCommit, /quality-check\.mjs/);
    assert.match(installedPreCommit, /gitleaks/);
  },
);

test("NC-1 install/attack: core.hooksPath is unset in this repo -- if it were set, hooks above could be silently bypassed by pointing elsewhere -> BLOCKED (current state) / would be a block signal if ever found set", () => {
  // CI 성립 근거: `git config --get core.hooksPath`는 어떤 체크아웃에서도
  // 실행 가능하고, 이 저장소는 그 값을 설정하지 않으므로 CI에서도 항상
  // UNSET이어야 한다 -- 설치 상태와 무관.
  let hooksPath;
  try {
    hooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    // `git config --get` exits 1 when the key is unset -- that is the
    // expected/desired state, not a test infrastructure failure.
    hooksPath = null;
  }
  assert.equal(
    hooksPath,
    null,
    "core.hooksPath must be unset; if set, git would run hooks from that path instead of .git/hooks, silently disabling everything tested above",
  );
});

test("NC-1 install/gap: the INSTALLED copy at .git/hooks/* is not itself a tracked path (the tracked mirror at hooks/* is a separate file CI only syntax-checks) -> KNOWN GAP, corrected from an initially wrong assumption", () => {
  // CI 성립 근거: `git ls-files`는 트래킹 여부만 묻는 조회이며 설치 상태와
  // 무관하게 어떤 체크아웃에서도 같은 결과를 낸다.
  //
  // Initial hypothesis going into this cycle (from the design doc) was
  // "'.git/hooks' is never committed -> CI can't see this layer at all."
  // That was checked here and found to be imprecise: a *tracked* mirror
  // directory `hooks/` DOES exist in this repo (`git ls-files -- hooks`
  // below is non-empty) and .github/workflows/enforce.yml does run
  // `sh -n hooks/commit-msg` / `sh -n hooks/pre-commit` against it. What
  // remains true, and is the corrected KNOWN GAP: CI only syntax-checks the
  // *tracked mirror*, never the *installed* .git/hooks/* copy that actually
  // fires on a real commit -- so a hook that was hand-edited in place (drift
  // between hooks/* and .git/hooks/*) is invisible to CI either way.
  const trackedMirror = execFileSync("git", ["ls-files", "--", "hooks"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  assert.notEqual(
    trackedMirror,
    "",
    "expected a tracked hooks/ mirror to exist (correcting the initial hypothesis)",
  );
  const trackedInstalledHooksDir = execFileSync(
    "git",
    ["ls-files", "--", ".git/hooks"],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedInstalledHooksDir,
    "",
    "the INSTALLED .git/hooks/* copy itself must not be a tracked path",
  );
});

// --- selfcheck-inventory NEW DEFECT: rewritten fully synthetic in 4R -----
// 3R/earlier reproduced this live against this actual worktree (a real
// linked worktree, where `.git` really is a file). That worked here but is
// not guaranteed anywhere else: a fresh CI checkout via actions/checkout is
// the MAIN checkout, not a linked worktree, so `.git` there is a real
// directory and the installed hook doesn't exist either way -- both the
// "wrong" and "correct" resolutions collapse to the same NOT_INSTALLED,
// which is not what this defect is about and would assert nothing
// meaningful (or fail, as ORCH measured). The defect's actual mechanism is
// pure path-construction logic: `join(root, ".git", "hooks", name)` can
// never resolve when `root/.git` is a FILE rather than a directory --
// exactly what `git worktree add` produces, and something we can fabricate
// with mkdtemp without any real git worktree at all.
test("NC-1 install/defect: selfcheck-inventory's checkNativeGitHook resolves installed_path by joining root+'.git'+hooks, which can never work when '.git' is a FILE (as in any linked worktree) -> NEW DEFECT, reproduced synthetically (no real worktree needed)", () => {
  // CI 성립 근거: 전부 mkdtemp 합성 파일/디렉터리만 쓰고 git 명령·실제
  // 워크트리에 의존하지 않으므로, 체크아웃 개수·연결 워크트리 존재
  // 여부와 무관하게 항상 같은 결과로 실행된다.
  const dir = mkdtempSync(join(tmpdir(), "nc-githook-install-worktree-"));
  try {
    // Fabricate the essential shape of a linked worktree: a `.git` path
    // component that is a FILE, not a directory (real `git worktree add`
    // writes "gitdir: <path>" into it; the exact contents don't matter for
    // this defect -- only that it is a file, so any join(root, ".git", ...)
    // beneath it can never resolve).
    writeFileSync(
      join(dir, ".git"),
      "gitdir: /some/common/dir/worktrees/synthetic\n",
      "utf8",
    );
    const trackedPath = join(dir, "hooks-tracked-commit-msg");
    writeFileSync(trackedPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");

    // The manifest's hard-coded pattern: installed_path relative to the
    // worktree root via ".git/hooks/<name>".
    const wrongInstalledPath = join(dir, ".git", "hooks", "commit-msg");
    assert.equal(
      existsSync(wrongInstalledPath),
      false,
      "confirms the fabrication: a path built through a '.git' FILE component can never exist, exactly like a real linked worktree",
    );
    const wrong = checkNativeGitHook({
      versionedPath: trackedPath,
      installedPath: wrongInstalledPath,
    });
    assert.equal(
      wrong.status,
      "NOT_INSTALLED",
      "reproduces the false-negative: the manifest's own path construction can never find an installed hook from a linked worktree",
    );

    // The correct resolution (a separate, flat file standing in for the
    // real git-common-dir's hooks/commit-msg -- exactly what
    // `git rev-parse --git-common-dir` would actually resolve to instead of
    // the broken `root/.git/...` join):
    const correctInstalledPath = join(dir, "common-dir-hooks-commit-msg");
    writeFileSync(correctInstalledPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    const correct = checkNativeGitHook({
      versionedPath: trackedPath,
      installedPath: correctInstalledPath,
    });
    assert.notEqual(
      correct.status,
      "NOT_INSTALLED",
      "with a correctly-resolved (non-'.git'-relative) installed path, the same hook is found",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- gap #9: NEW DEFECT classification/diagnosis unchanged from 2R/3R ----
// Round-1 framed this as "installed vs. tracked byte drift, likely
// autocrlf." REVIEW and ORCH independently re-measured and found a sharper,
// previously-undocumented fact: the DRIFT is not a property of "this
// machine" as a whole -- it is a property of *which checkout* you compare
// from, and it means CI's `sh -n hooks/*` never inspects the bytes that
// actually execute on a real commit anywhere in this repo's history.
//
// ORCH's read-only real-world measurement: index/HEAD blob and this NC-1
// worktree's checkout are both LF (bcec25f0...); the main-repo worktree's
// checkout and the installed .git/hooks/* copy (copied from it) are both
// CRLF (31b25f88...), violating this repo's own `.gitattributes` (`* text=
// auto eol=lf`). So CI's `sh -n hooks/commit-msg` step checks out and
// syntax-checks the LF blob (CI's own clean clone honors .gitattributes),
// while the hook that actually fires on every real commit on this
// developer's machine is the CRLF copy -- CI has never once syntax-checked
// the exact bytes that execute here. No prior record of this specific claim
// was found anywhere in this repo, as distinct from the milder round-1
// framing. Classified NEW DEFECT, not KNOWN GAP, on that basis (§5's rule:
// no prior record -> NEW DEFECT) -- **unchanged through 2R/3R/4R**; only
// the tests' portability changed each round.
test("NC-1 install/defect: the checkNativeGitHook comparison mechanism is checkout-dependent by construction (synthetic fixtures, no real second checkout needed) -> NEW DEFECT (CI's sh -n can never check the bytes that actually execute, because syntax-checking one checkout's tracked file says nothing about what a DIFFERENT checkout installed)", () => {
  // CI 성립 근거: mkdtemp 합성 파일만 사용하고 git 연산·저장소 상대 경로가
  // 전혀 없어 체크아웃 개수·설치 훅 유무와 무관하게 항상 통과한다.
  const dir = mkdtempSync(join(tmpdir(), "nc-githook-install-synth-"));
  try {
    // A single script body, written out with different line endings to
    // stand in for "the installed hook" and "two different checkouts'
    // tracked copies" -- exactly the shape ORCH measured in the real repo
    // (LF tracked-in-CI vs. CRLF tracked-in-a-different-checkout vs. CRLF
    // installed), but entirely synthetic.
    const scriptBody = [
      "#!/usr/bin/env sh",
      'echo "commit-msg stub"',
      "exit 0",
      "",
    ].join("\n");
    const installedPath = join(dir, "installed-hook");
    const trackedLfPath = join(dir, "tracked-checkout-a-lf");
    const trackedCrlfPath = join(dir, "tracked-checkout-b-crlf");
    // "Installed" and "checkout B" both get CRLF (as if checkout B's
    // working tree were the source the installed copy was copied from).
    writeFileSync(installedPath, scriptBody.replace(/\n/g, "\r\n"), "utf8");
    writeFileSync(trackedCrlfPath, scriptBody.replace(/\n/g, "\r\n"), "utf8");
    // "Checkout A" (stands in for CI's own clean checkout) gets LF, matching
    // what .gitattributes' `eol=lf` would actually produce.
    writeFileSync(trackedLfPath, scriptBody, "utf8");

    const fromCheckoutA = checkNativeGitHook({
      versionedPath: trackedLfPath,
      installedPath,
    });
    const fromCheckoutB = checkNativeGitHook({
      versionedPath: trackedCrlfPath,
      installedPath,
    });

    assert.notEqual(
      fromCheckoutA.status,
      fromCheckoutB.status,
      "the SAME installed hook must compare differently depending on which checkout's tracked copy it's measured against -- this is the location-dependency mechanism behind gap #9",
    );
    assert.equal(
      fromCheckoutA.status,
      "DRIFT",
      "LF tracked copy (what CI's own checkout would produce) must NOT byte-match a CRLF installed hook",
    );
    assert.equal(
      fromCheckoutB.status,
      "ALIVE",
      "CRLF tracked copy (the checkout the installed hook was actually copied from) must byte-match it",
    );

    // Content-only comparison (CRLF normalized to LF via an injected
    // readFileFn -- exercising the same injection port used above, still no
    // real file touched) proves the DRIFT above is a pure line-ending
    // artifact, not a hidden content divergence.
    const stripCR = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    const normalized = checkNativeGitHook({
      versionedPath: trackedLfPath,
      installedPath,
      readFileFn: stripCR,
    });
    assert.equal(
      normalized.status,
      "ALIVE",
      "once CRLF is normalized to LF, the LF-tracked copy and the installed hook must be byte-identical -- proving the DRIFT is a line-ending artifact, not a content divergence",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Additional, environment-conditional real-world corroboration -------
// The synthetic test above is the load-bearing proof (CI-safe, always
// runs). This one re-measures the SAME mechanism against the two real
// checkouts on THIS machine, purely as corroborating evidence -- it is not
// required for the NEW DEFECT classification and is skipped whenever its
// preconditions aren't met: requires BOTH (a) MAIN_ROOT resolves to a
// directory that is NOT this worktree's own root, and (b) the installed
// hook file itself actually exists at COMMON_DIR -- i.e. two genuinely
// different checkouts AND a real installed copy to compare against.
//
// Hotfix: `join(COMMON_DIR, "..")` is pure string math and, since COMMON_DIR
// is now already absolute+realpath'd (see absoluteRealPath above), this
// candidate is already an absolute path -- but it is run through
// absoluteRealPath once more (guarded by existsSync, since a bare parent
// directory always exists once its child hooks/commit-msg does) purely so
// EVERY value that ever gets compared with `!==` against ROOT in this file
// went through the exact same normalization step. This is what actually
// fixes the regression: in the main repo checkout, this now resolves to the
// same real path as ROOT, so `MAIN_ROOT !== ROOT` correctly comes out
// false (same checkout, not "two different real checkouts") instead of the
// pre-hotfix "." !== "C:/.../HARNESSENGINEERING" string mismatch.
const MAIN_ROOT = (() => {
  const candidate = join(COMMON_DIR, "..");
  if (!existsSync(join(candidate, "hooks", "commit-msg"))) return null;
  return absoluteRealPath(candidate, ".");
})();
// 2026-08-08 (HYK-200 2R): ORCH normalized the INSTALLED commit-msg hook
// (CRLF -> LF, with 한용's approval) to match this repo's own tracked
// versioned copy, which as a side effect made the tracked `hooks/commit-msg`
// in every real checkout on this machine -- main repo AND every linked
// worktree, including this one -- byte-identical. That equality is now the
// CORRECT, intended state (closing exactly the kind of drift gap#91 exists
// to describe), so a checkout pair whose tracked copies already match is not
// a case where "compares differently depending on which checkout" can be
// demonstrated -- asserting a divergence that no longer exists would be
// enforcing a stale fact, not a real regression guard. The fully synthetic
// proof above (fabricated CRLF/LF fixtures, never real files) remains the
// load-bearing demonstration that the mechanism CAN diverge; this
// corroborating measurement only adds value when real files still happen to
// diverge, so it now skips whenever they don't.
const MAIN_COMMIT_MSG = MAIN_ROOT
  ? join(MAIN_ROOT, "hooks", "commit-msg")
  : null;
const CHECKOUTS_DIVERGE =
  MAIN_COMMIT_MSG !== null &&
  !readFileSync(TRACKED_COMMIT_MSG).equals(readFileSync(MAIN_COMMIT_MSG));
const TWO_REAL_CHECKOUTS_AVAILABLE =
  MAIN_ROOT !== null &&
  MAIN_ROOT !== ROOT &&
  INSTALLED_HOOKS_PRESENT &&
  CHECKOUTS_DIVERGE;

test(
  "NC-1 install/measurement (additional, environment-conditional): the same location-dependent mechanism reproduces against this machine's two REAL checkouts -- corroborates, does not replace, the synthetic proof above",
  {
    skip:
      !TWO_REAL_CHECKOUTS_AVAILABLE &&
      "requires a second real checkout (MAIN_ROOT !== this worktree's ROOT), an installed hook to actually exist, AND the two checkouts' tracked hooks/commit-msg to actually diverge -- all three are false in a CI checkout or a bare single-checkout clone, and the third is now false on any machine where the installed hook has been normalized (HYK-200 2R) so the checkouts agree -- this corroborating measurement is skipped rather than asserting a divergence that no longer exists",
  },
  () => {
    // CI 성립 근거: 가드가 CI(단일 체크아웃·설치 훅 없음)에서 항상 거짓이
    // 되므로 이 시험은 CI에서 아무것도 단언하지 않고 항상 skip된다. 이
    // 저장소가 정규화된 이후에는 실제 두 체크아웃이 일치할 때도(CHECKOUTS_
    // DIVERGE=false) 같은 이유로 skip된다 -- 어느 경우든 CI/정상화된
    // 로컬 환경에서 이 시험이 실행되어 실패하는 경로는 없다.
    const fromNc1 = checkNativeGitHook({
      versionedPath: TRACKED_COMMIT_MSG,
      installedPath: COMMIT_MSG_HOOK,
    });
    const fromMain = checkNativeGitHook({
      versionedPath: join(MAIN_ROOT, "hooks", "commit-msg"),
      installedPath: COMMIT_MSG_HOOK,
    });
    assert.notEqual(
      fromNc1.status,
      fromMain.status,
      "on this machine, the same installed hook must still compare differently depending on which real checkout's tracked copy it's measured against",
    );
  },
);

after(() => {
  // CI 성립 근거: 읽기 전용 스위트이므로 어떤 체크아웃에서도 시작 전/후
  // 상태가 동일해야 한다 -- 설치 상태와 무관.
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-githook-install.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-githook-install.test.mjs changed the tracked-file diff state -- the suite must leave whatever diff existed before it ran untouched, not force it to empty",
  );
});
