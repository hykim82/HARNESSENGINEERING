// NC-1 negative-control: pre-commit-gitleaks (git hooks/pre-commit step 1).
//
// Unlike review-gate/quality-check, there is no exported JS module here --
// the defense is the real `gitleaks` binary run against a real (but
// throwaway) git repository. Per §2 non-negotiable #1, every repo used below
// is created with `mkdtemp` + `git init` and deleted in a `finally` block;
// the real workspace repo is never touched, and the dummy secret values are
// obvious placeholders (sequential-alphabet fill), never a real-looking
// leaked credential.
//
// `gitleaks` itself is invoked directly (a real external binary), which is
// distinct from "injecting into a module" -- there is no module to inject
// into. This is the closest this device gets to layer-1 (nothing in the
// synthetic repo pretends to be the real repo's history or hooks).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

// Hotfix 3R (2026-07-30, REVIEW P1 -- one un-normalized site left over from
// the 1R sweep, which only touched nc-githook-install.test.mjs and missed
// this file's own git-common-dir use at what was then line 203). Same
// pattern-level defect as 1R: `git rev-parse --git-common-dir` can return a
// RELATIVE path, and that value is only meaningful relative to the `cwd`
// the git command itself was invoked with -- never relative to
// process.cwd() at some later point when the value is consumed by
// join()/readFileSync(). ORCH reproduced this concretely: invoking the git
// command with cwd=ROOT returns ".git", but with cwd=ROOT/scripts returns
// "../.git" -- both relative, both correct FOR THAT cwd, but wrong the
// instant they're joined as if they were already absolute. The old code at
// nc-gitleaks.test.mjs:203-207 did exactly that: `join(commonDir, "hooks",
// "pre-commit")` on the raw ".git"/"../.git" value, which only happened to
// resolve correctly when node's own process.cwd() coincidentally matched
// the cwd the git call used -- not guaranteed, and ORCH's repro (running
// from a subdirectory) broke it: the installed hook genuinely exists, but
// the environment-conditional corroboration test skipped anyway (a silent
// missed measurement, exactly the failure mode this whole track exists to
// catch). Fix: resolve the raw value against the SAME cwd the git call
// used, once, right where it's read -- exactly the same
// absoluteRealPath(cwd, rawPath) = realpathSync(resolve(cwd, rawPath))
// pattern nc-githook-install.test.mjs already uses, kept identical here on
// purpose so the same defect pattern is closed the same way everywhere.
function absoluteRealPath(cwd, rawPath) {
  return realpathSync(resolve(cwd, rawPath));
}

const ROOT = absoluteRealPath(process.cwd(), repoRoot());
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
// this assertion actually verifies). What this suite can honestly promise
// is INVARIANCE: whatever diff existed before this suite ran still exists,
// byte-for-byte, after it ran. Captured here, compared in after() below.
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

function which(bin) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}
const GITLEAKS_ON_PATH = which("gitleaks") || which("gitleaks.exe");
const GITLEAKS_BIN = which("gitleaks") ? "gitleaks" : "gitleaks.exe";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function withSyntheticRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-gitleaks-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function runGitleaks(dir, args) {
  try {
    const output = execFileSync(GITLEAKS_BIN, args, {
      cwd: dir,
      encoding: "utf8",
    });
    return { exitCode: 0, output };
  } catch (err) {
    return {
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// Obvious dummy -- sequential alphabet fill, not derived from any real
// credential, but shaped enough (prefix + length) to match gitleaks' AWS
// access-key-id rule so the detector actually fires.
//
// Assembled at runtime, not written as a literal: a literal AKIA... string
// sitting in this file's own bytes gets caught by our OWN gitleaks defenses
// -- both the local pre-commit hook and CI's `gitleaks detect --source .`
// scan every byte ever committed, and this file itself is a normal tracked
// commit target. That is not hypothetical: on 2026-07-30 the literal form
// of this constant actually blocked a real NC-1 commit attempt (see the gap
// table's "차단 실적 있음(live)" entry and the mutation ledger). ORCH's
// ruling was explicit: no `.gitleaksignore`, no `--no-verify` -- carving an
// exception into the very device this track exists to test would
// permanently weaken it. Assembling the string only when the test actually
// writes it into a throwaway synthetic repo keeps detection power
// unchanged (gitleaks still sees the complete, real-looking string once it
// hits that repo's bytes) while removing the literal from this file's own
// bytes.
const DUMMY_AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");

test(
  "NC-1 gitleaks/attack: a synthetic dummy secret staged for commit -> BLOCKED (protect --staged, local hook's real invocation)",
  { skip: !GITLEAKS_ON_PATH && "gitleaks not on PATH in this environment" },
  () => {
    withSyntheticRepo((dir) => {
      writeFileSync(
        join(dir, "config.mjs"),
        `export const AWS_ACCESS_KEY_ID = "${DUMMY_AWS_KEY}";\n`,
        "utf8",
      );
      git(dir, ["add", "-A"]);
      const result = runGitleaks(dir, ["protect", "--staged", "--redact"]);
      assert.notEqual(
        result.exitCode,
        0,
        "gitleaks must exit non-zero when a staged secret is present",
      );
    });
  },
);

test(
  "NC-1 gitleaks/attack: no secret staged -> passes cleanly (no false positive on ordinary code)",
  { skip: !GITLEAKS_ON_PATH && "gitleaks not on PATH in this environment" },
  () => {
    withSyntheticRepo((dir) => {
      writeFileSync(
        join(dir, "clean.mjs"),
        "export const answer = 42;\n",
        "utf8",
      );
      git(dir, ["add", "-A"]);
      const result = runGitleaks(dir, ["protect", "--staged", "--redact"]);
      assert.equal(
        result.exitCode,
        0,
        "ordinary code with no secrets must not be flagged",
      );
    });
  },
);

// 5R fix (한용 게이트 2, 2026-07-30): this test's purpose is purely textual
// -- "does the hook SCRIPT'S TEXT document the fail-open branch" -- which
// has nothing to do with whether a hook happens to be installed on this
// particular machine. The pre-5R version read the INSTALLED copy
// (`.git/hooks/pre-commit`, via git-common-dir), which does not exist in a
// fresh single-checkout clone or in CI (confirmed: `enforce.yml` never
// installs hooks) -> ENOENT there (ORCH measured: nc-* 37 tests, pass 33,
// fail 1, skip 3 -- this was the one failure). Reads the TRACKED mirror
// `hooks/pre-commit` instead: it is a plain file every checkout (including
// CI) has, and CI's own `sh -n hooks/pre-commit` step already syntax-checks
// that exact file, so verifying its *text* against that same file is both
// more true to the test's stated purpose and checkout-count-safe.
const TRACKED_PRE_COMMIT = join(ROOT, "hooks", "pre-commit");

test("NC-1 gitleaks/gap: 'gitleaks not installed' fail-open branch -- verified by reading the TRACKED hooks/pre-commit script's text, not by tampering with PATH -> KNOWN GAP (documented as intentional)", () => {
  // §2 non-negotiable #4 explicitly forbids simulating "gitleaks missing"
  // by manipulating PATH. Instead this verifies, by reading the real hook
  // file (read-only -- never written to), that the fail-open branch and its
  // "fail-open by design" comment actually exist in the shipped hook.
  //
  // CI 성립 근거: 추적본을 읽는다 -- 목적은 스크립트 텍스트 확인이고, 추적본은
  // 모든 체크아웃(CI 포함)에 항상 존재하며 CI가 이미 `sh -n`으로 문법
  // 검사하는 바로 그 파일이다. 설치본이 아니라 추적본을 검사 대상으로
  // 삼는 편이 "텍스트에 문서화됐는가"라는 이 시험의 목적에 더 맞는다.
  const hookText = readFileSync(TRACKED_PRE_COMMIT, "utf8");
  assert.match(
    hookText,
    /gitleaks not found on PATH.*skipping local secret scan/,
    "the tracked pre-commit hook must contain the fail-open branch this gap describes",
  );
  assert.match(
    hookText,
    /fail-open by design/i,
    "the fail-open branch must be documented in the hook's own text as intentional",
  );
  // Registered in docs/enforcement-known-gaps.md as KNOWN GAP, not a defect:
  // the hook's own comment states this posture is deliberate and that CI's
  // `gitleaks detect --source .` (unconditional, no fail-open branch) is the
  // authoritative scan. This test would go RED the moment that comment or
  // branch is removed from the shipped hook, which is the intended alarm.
});

// Additional, environment-conditional corroboration: when this checkout
// actually has the hook installed, confirm the installed copy carries the
// same fail-open text too (not required for the KNOWN GAP classification --
// gap #9/#7 already cover installed-vs-tracked byte drift in general; this
// just corroborates that the specific text this gap cares about survives
// whatever drift exists). Skips cleanly when no installed hook is present
// (CI, or a fresh single-checkout clone).
function installedPreCommitPath(cwd = ROOT) {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
    }).trim();
    return join(absoluteRealPath(cwd, commonDir), "hooks", "pre-commit");
  } catch {
    return null;
  }
}
const INSTALLED_PRE_COMMIT = installedPreCommitPath();
const INSTALLED_PRE_COMMIT_PRESENT =
  INSTALLED_PRE_COMMIT !== null &&
  (() => {
    try {
      readFileSync(INSTALLED_PRE_COMMIT, "utf8");
      return true;
    } catch {
      return false;
    }
  })();

test(
  "NC-1 gitleaks/measurement (environment-conditional): the INSTALLED pre-commit copy (when present) also documents the fail-open branch",
  {
    skip:
      !INSTALLED_PRE_COMMIT_PRESENT &&
      "no installed .git/hooks/pre-commit in this checkout -- CI and any fresh single clone never install it, so this corroborating measurement skips instead of asserting anything there",
  },
  () => {
    // CI 성립 근거: 이건 "설치본" 측정값이라 CI/단일 클론에서는 항상
    // skip된다 -- 위 계약 시험(추적본 기준)이 항상 성립하므로 이 시험은
    // 부가 확인일 뿐이다.
    const installedText = readFileSync(INSTALLED_PRE_COMMIT, "utf8");
    assert.match(
      installedText,
      /gitleaks not found on PATH.*skipping local secret scan/,
    );
    assert.match(installedText, /fail-open by design/i);
  },
);

// Regression guard (3R, required by REVIEW's P1): a synthetic repo with a
// subdirectory reproduces ORCH's exact repro (cwd=repo root -> ".git",
// cwd=repo root/scripts -> "../.git" -- both relative, different strings,
// same real directory) without depending on this actual repo's own layout.
// If `installedPreCommitPath()`'s normalization is ever removed or broken
// again, this goes RED: the two cwds would resolve to different paths.
test("NC-1 gitleaks/defect: git-common-dir resolution must be cwd-invariant once normalized -- regression guard for the 3R fix (installedPreCommitPath resolved from the repo root vs. a subdirectory must agree)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-gitleaks-cwd-invariance-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    writeFileSync(join(dir, "base.mjs"), "export const base = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    mkdirSync(join(dir, "scripts"));

    // Sanity: confirm this synthetic repo actually reproduces the raw,
    // differently-relative git-common-dir values ORCH measured (otherwise
    // this "regression guard" would trivially pass for the wrong reason).
    const rawFromRoot = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const rawFromSubdir = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: join(dir, "scripts"), encoding: "utf8" },
    ).trim();
    assert.notEqual(
      rawFromRoot,
      rawFromSubdir,
      "fixture setup check: the raw (un-normalized) git-common-dir strings must actually differ by cwd depth, or this test isn't reproducing the 3R bug condition",
    );

    // The actual regression guard: once resolved through
    // installedPreCommitPath (which now normalizes via absoluteRealPath),
    // both cwds must agree on the exact same real path.
    const pathFromRoot = installedPreCommitPath(dir);
    const pathFromSubdir = installedPreCommitPath(join(dir, "scripts"));
    assert.equal(
      pathFromSubdir,
      pathFromRoot,
      "installedPreCommitPath() must resolve to the identical path regardless of which cwd git was invoked with -- this is the exact 3R regression (a subdirectory cwd silently resolved to a nonexistent path and caused a false skip)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "NC-1 gitleaks/gap: local `--staged` scope misses a secret that exists only in prior history (CI's `--source .` scope catches it) -> KNOWN GAP",
  { skip: !GITLEAKS_ON_PATH && "gitleaks not on PATH in this environment" },
  () => {
    withSyntheticRepo((dir) => {
      // Commit a dummy secret, then "fix" it in a later commit -- the classic
      // "I noticed and removed it" pattern that leaves the secret sitting in
      // history forever.
      writeFileSync(
        join(dir, "config.mjs"),
        `export const AWS_ACCESS_KEY_ID = "${DUMMY_AWS_KEY}";\n`,
        "utf8",
      );
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "oops, added a key"]);
      writeFileSync(
        join(dir, "config.mjs"),
        "export const clean = 1;\n",
        "utf8",
      );
      git(dir, ["add", "-A"]);

      // This is the exact local pre-commit invocation (`protect --staged`):
      // the working tree is now clean, so the local hook sees nothing.
      const local = runGitleaks(dir, ["protect", "--staged", "--redact"]);
      assert.equal(
        local.exitCode,
        0,
        "local --staged scope must miss a secret that only exists in prior history (this IS the gap)",
      );

      // This is the CI invocation (`detect --source .`), which scans full
      // history and does catch it.
      const ci = runGitleaks(dir, ["detect", "--source", ".", "--redact"]);
      assert.notEqual(
        ci.exitCode,
        0,
        "CI's --source . scope must catch the same secret the local hook missed",
      );
    });
    // Registered as KNOWN GAP: a commit-then-fix sequence passes the local
    // hook every time regardless of what was in the fixed commit, and the only
    // backstop is CI running after push -- i.e. after the secret has already
    // left the machine and entered shared history. See docs/enforcement-known-gaps.md.
  },
);

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-gitleaks.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-gitleaks.test.mjs changed the tracked-file diff state -- the suite must leave whatever diff existed before it ran untouched, not force it to empty",
  );
});
