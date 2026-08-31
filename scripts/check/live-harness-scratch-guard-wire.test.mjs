// HYK-394-guard-wire-1 §2⓵ (유보 ⓐ) -- live-harness-scratch-guard.mjs
// existed since PR #229 but had zero callers besides itself and its own
// test (ORCH measured 2026-08-31 13:39: not referenced by any .mjs/.json/
// .yml in the repo or control room outside those two files). "장치는
// 있는데 아무도 안 부른다" is exactly the state that let the 2026-08-30
// live-.harness scratch-dir incidents slip past unblocked.
//
// This file locks in the fix: hooks/pre-commit's real, committed Step 4
// (added this round) now chains live-harness-scratch-guard.mjs the same
// way it already chains quality-check.mjs (HYK-148) and nul-byte-guard.mjs
// (HYK-183) -- WHO calls it: git's pre-commit hook (local) and
// .github/workflows/enforce.yml's CI mirror. WHEN: every `git commit`
// locally (on the staged diff) and every push/PR in CI (on the base-SHA
// diff), exactly the same trigger points quality-check/nul-byte-guard
// already use.
//
// HYK-394-guard-wire-2 (2R) rewrite -- review caught two real defects in
// the 1R version of this file (both retracted here, not just patched
// quietly):
//
// P1 (canonical suite was red): 1R's runPreCommit() called
// `spawnSync("sh", [join(dir, "hooks", "pre-commit")], ...)` directly --
// "sh" resolved via PATH. On a default Windows dev machine (no Git Bash on
// PATH) that spawn fails outright (ENOENT), so 3 of these tests -- and, in
// a chain reaction, HYK-359's canonical-suite sweep that watches for
// exactly this -- were RED on `npm test` run the plain way (no PATH
// edits). Adding Git Bash to PATH made the numbers go green, but the task
// this round is explicit: a fix that only works after a local PATH edit is
// not a fix, it's hiding the same defect behind an environment
// precondition the canonical suite is supposed to be free of. The fix
// here calls no shell at all -- `git commit` itself resolves and invokes
// the hook via git's own internal hook-execution machinery, the same way
// a real `git commit` on a real Windows dev machine does, with zero PATH
// dependency introduced by this test file.
//
// P2-1 (fixture didn't test the drift axis this device exists for): 1R
// wrote the hook to a fixture-local `hooks/pre-commit` path and executed
// that copy directly -- never `.git/hooks/pre-commit`, the actual
// installed location `git commit` reads from. That skipped the exact
// distinction this whole device is about (versioned hooks/ vs *installed*
// .git/hooks/, see hook-sync-check.mjs/seat-preflight.mjs's own reason for
// existing) -- a hook that's committed but never installed protects
// nobody, and 1R's fixture could not have told the difference. Fixed by
// installing the hook content into `.git/hooks/pre-commit` and only ever
// triggering it via a real `git commit`.
//
// P2-2 (retracted claim): 1R's coder.md asserted "이 결선 자체가 이
// 라운드의 실제 커밋(3acbd05)에서 이미 한 번 실전으로 돌았다" -- that is
// FALSE and is retracted in this round's coder.md. At the time of that
// commit there were zero installed-copy references anywhere (P2-1 above);
// the pre-commit hook that actually ran against that commit was whatever
// was already sitting in THIS worktree's own `.git/hooks/pre-commit` from
// some earlier install, not something this round's test suite verified.
// See coder.md §3 for the retraction and the accompanying operational-risk
// note (a repo's committed hooks/pre-commit changes protect nobody in a
// clone/worktree that never ran the install step).
//
// ⛔ Every fixture repo here is a disposable mkdtemp directory -- never the
// real checkout. The real hooks/pre-commit and live-harness-scratch-guard.mjs
// source files are only ever READ, never written, by this file (each test
// that mutates verifies byte-identity of the real file afterward).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const PRE_COMMIT_PATH = join(REPO_ROOT, "hooks", "pre-commit");
const ENFORCE_YML_PATH = join(REPO_ROOT, ".github", "workflows", "enforce.yml");

// Built via a split literal (HARNESS_DIR_NAME assembled at runtime, not
// written as the literal ".harness" next to "join(REPO_ROOT," in THIS
// file's own source) so this file's own source text does not itself match
// the guard's regex -- this file is not on SELF_EXCLUDED_FILES (deliberately
// narrow to the guard's own 2 files, see that list's header) and must not
// need to be: the calibration test (ⓒ in live-harness-scratch-guard.test.mjs)
// scans every .mjs under scripts/, this file included, and would otherwise
// flag this constant as a real violation of itself.
const HARNESS_DIR_NAME = [".", "harness"].join("");
const VIOLATING_CONTENT =
  'import { dirname, join } from "node:path";\n' +
  'import { fileURLToPath } from "node:url";\n' +
  "const HERE = dirname(fileURLToPath(import.meta.url));\n" +
  "const REPO_ROOT = dirname(dirname(HERE));\n" +
  `export const SCRATCH_ROOT = join(REPO_ROOT, ${JSON.stringify(HARNESS_DIR_NAME)}, "leak");\n`;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// Writes hook content to the REAL installed location -- `.git/hooks/
// pre-commit`, the path `git commit` actually reads (never a
// fixture-local `hooks/pre-commit` copy, which git never looks at on its
// own -- that distinction, versioned copy vs installed copy, is exactly
// P2-1's gap). chmod is best-effort (POSIX exec bit -- a harmless no-op on
// Windows, where Git for Windows' own hook runner does not consult it).
function installHook(dir, content) {
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, content, "utf8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // best-effort -- see header comment
  }
}

// quality-check.mjs's defaultRunTool spawns
// `node <cwd>/node_modules/eslint/bin/eslint.js <args>` (and prettier's
// equivalent) by literal path -- it never resolves through PATH. 1R
// junction-symlinked this checkout's own installed node_modules at that
// path, which works when this test file runs directly against a real
// checkout, but NOT when it runs the way `npm test` actually runs it: via
// isolated-suite-runner.mjs's `git clone` (HYK-208), where REPO_ROOT
// resolves to that ephemeral clone -- and `git clone` never carries
// node_modules (gitignored, untracked), so the junction pointed at nothing
// and every commit's quality-check step crashed with MODULE_NOT_FOUND.
// quality-check.test.mjs itself never spawns a real eslint/prettier
// binary for exactly this reason (it injects a fake `runTool`); this file
// takes the same approach at the process-spawn boundary instead: two
// trivial stub CLIs that always exit 0, so quality-check's own lint/format
// steps stay in the chain (still literally invoked, not skipped) while
// this file's actual target -- the NEW Step 4 -- is what a violating file
// gets caught by, deterministically and without any node_modules
// dependency at all.
const NOOP_TOOL_STUB = "process.exit(0);\n";

// Builds a disposable git repo that carries everything the REAL
// hooks/pre-commit needs to run to completion: gitleaks (found on PATH,
// same as a real dev machine), a real eslint.config.mjs, no-op eslint/
// prettier stubs (see NOOP_TOOL_STUB header), and the three check scripts
// pre-commit actually invokes. `preCommitContent` lets a mutation test
// install an edited copy while every other file (including the guard
// script itself) stays real. The hook is installed into
// `.git/hooks/pre-commit` BEFORE the base commit (not after) -- so even
// that first commit runs through the real, installed hook, exactly like a
// developer who installed the hook before ever touching the repo.
function buildFixtureRepo(dir, { preCommitContent } = {}) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "a@a"]);
  git(dir, ["config", "user.name", "a"]);
  mkdirSync(join(dir, "scripts", "check"), { recursive: true });
  for (const f of [
    "quality-check.mjs",
    "live-harness-scratch-guard.mjs",
    "nul-byte-guard.mjs",
  ]) {
    writeFileSync(
      join(dir, "scripts", "check", f),
      readFileSync(join(REPO_ROOT, "scripts", "check", f), "utf8"),
      "utf8",
    );
  }
  writeFileSync(
    join(dir, "eslint.config.mjs"),
    readFileSync(join(REPO_ROOT, "eslint.config.mjs"), "utf8"),
    "utf8",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
    "utf8",
  );
  mkdirSync(join(dir, "node_modules", "eslint", "bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "prettier", "bin"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "node_modules", "eslint", "bin", "eslint.js"),
    NOOP_TOOL_STUB,
    "utf8",
  );
  writeFileSync(
    join(dir, "node_modules", "prettier", "bin", "prettier.cjs"),
    NOOP_TOOL_STUB,
    "utf8",
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(dir, "base.mjs"), "export const base = 1;\n", "utf8");
  installHook(dir, preCommitContent ?? readFileSync(PRE_COMMIT_PATH, "utf8"));
  git(dir, [
    "add",
    ".gitignore",
    "base.mjs",
    "scripts",
    "eslint.config.mjs",
    "package.json",
  ]);
  const baseCommit = commitStaged(dir, "base");
  assert.equal(
    baseCommit.status,
    0,
    `fixture setup itself must not be blocked by the installed hook (base.mjs is clean): ${baseCommit.stderr}`,
  );
}

// A REAL `git commit` -- git resolves and spawns the installed
// `.git/hooks/pre-commit` itself via its own internal hook-execution path
// (git for Windows ships its own sh, invoked without any PATH lookup by
// this test). Nothing here calls "sh" or any shell directly -- that is the
// whole P1 fix.
function commitStaged(dir, message) {
  return spawnSync("git", ["commit", "-q", "-m", message], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
}

function withFixtureRepo(opts, fn) {
  const dir = mkdtempSync(join(tmpdir(), "lhg-wire-test-"));
  try {
    buildFixtureRepo(dir, opts);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// WHO/WHEN, real end-to-end: a REAL `git commit` against a REAL git repo
// whose `.git/hooks/pre-commit` is the REAL, unmodified, INSTALLED
// hooks/pre-commit -- no `sh` spawned directly by this test file, git does
// that internally. This is what distinguishes an installed hook from a
// merely-committed one (P2-1) without depending on a shell being on PATH
// (P1).
// ---------------------------------------------------------------------------

test("real installed .git/hooks/pre-commit BLOCKS a real `git commit` staging a HYK-394-test-leak-3-shaped violation (WHO=git pre-commit hook, WHEN=git commit time)", () => {
  withFixtureRepo({}, (dir) => {
    writeFileSync(join(dir, "leaky.test.mjs"), VIOLATING_CONTENT, "utf8");
    git(dir, ["add", "leaky.test.mjs"]);
    const r = commitStaged(dir, "add leaky.test.mjs");
    assert.notEqual(
      r.status,
      0,
      `expected the commit to be blocked, got exit ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /live-harness-scratch-guard:.*live-worktree-\.harness-scratch pattern\(s\) found/,
      "the guard's own reason string must appear -- not just 'something failed'",
    );
    assert.match(r.stderr, /leaky\.test\.mjs/);
    const log = git(dir, ["log", "--format=%s"]);
    assert.doesNotMatch(
      log,
      /add leaky\.test\.mjs/,
      "the blocked commit must never have actually landed",
    );
  });
});

test("real installed .git/hooks/pre-commit control: a real `git commit` with a clean staged .mjs file (no leak pattern) succeeds -- the new step introduces zero false positives", () => {
  withFixtureRepo({}, (dir) => {
    writeFileSync(
      join(dir, "clean.test.mjs"),
      "export const clean = 1;\n",
      "utf8",
    );
    git(dir, ["add", "clean.test.mjs"]);
    const r = commitStaged(dir, "add clean.test.mjs");
    assert.equal(
      r.status,
      0,
      `expected the commit to succeed, got exit ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`,
    );
    const log = git(dir, ["log", "--format=%s"]);
    assert.match(
      log,
      /add clean\.test\.mjs/,
      "the passing commit must actually land",
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation (필수): remove the wiring step -> the exact same violating input
// from the first test above must now slip through -- proving the wiring
// itself (not something else in the chain) is what caught it.
// ---------------------------------------------------------------------------

const STEP4_MARKER_START = "# --- Step 4 (HYK-394): live-harness-scratch-guard";
const STEP4_MARKER_END = 'exit "$status"';

test("mutation (필수): removing hooks/pre-commit's Step 4 block -> the same leak-shaped input that Step 4 caught now passes -- RED, proves this axis is load-bearing", () => {
  const src = readFileSync(PRE_COMMIT_PATH, "utf8");
  const startIdx = src.indexOf(STEP4_MARKER_START);
  const endIdx = src.lastIndexOf(STEP4_MARKER_END);
  assert.ok(
    startIdx !== -1 && endIdx !== -1 && startIdx < endIdx,
    "Step 4 block markers must both be present and ordered in the real file",
  );
  const mutated = src.slice(0, startIdx) + src.slice(endIdx);
  assert.notEqual(
    mutated,
    src,
    "the mutation must actually remove text (sanity check on the slice)",
  );
  assert.ok(
    !mutated.includes(
      'lhg_script="$root/scripts/check/live-harness-scratch-guard.mjs"',
    ),
    "the mutated hook must no longer invoke the guard script (its header mention above Step 1 may still remain -- only the invocation is removed)",
  );

  withFixtureRepo({ preCommitContent: mutated }, (dir) => {
    writeFileSync(join(dir, "leaky.test.mjs"), VIOLATING_CONTENT, "utf8");
    git(dir, ["add", "leaky.test.mjs"]);
    const r = commitStaged(dir, "add leaky.test.mjs (mutated hook)");
    assert.equal(
      r.status,
      0,
      `RED expected (mutated hook has no wiring left to block this): got exit ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`,
    );
    const log = git(dir, ["log", "--format=%s"]);
    assert.match(
      log,
      /add leaky\.test\.mjs \(mutated hook\)/,
      "RED: with Step 4 removed from the INSTALLED hook, the leak-shaped commit must actually land",
    );
  });

  const after = readFileSync(PRE_COMMIT_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원복 증명: the real hooks/pre-commit must be byte-identical before/after this test -- only an in-memory string and a tmp-dir copy were ever mutated",
  );
});

// ---------------------------------------------------------------------------
// CI mirror: static source proof that .github/workflows/enforce.yml also
// invokes the same guard (the second WHO/WHEN -- covers pushes/PRs where
// --no-verify skipped the local hook). Running the actual GitHub Actions
// job is out of reach from a unit test; this pins the exact invocation
// line the same way the manifest's other git-substrate entries do.
// ---------------------------------------------------------------------------

test("enforce.yml CI mirror: exactly one step invokes live-harness-scratch-guard.mjs --mode ci (mirrors the quality-check/nul-byte-guard CI steps already present)", () => {
  const yml = readFileSync(ENFORCE_YML_PATH, "utf8");
  const target =
    "node scripts/check/live-harness-scratch-guard.mjs --mode ci --base-sha";
  const count = yml.split(target).length - 1;
  assert.equal(
    count,
    1,
    `expected exactly one CI invocation of the guard in --mode ci (found ${count})`,
  );
});
