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
  symlinkSync,
  rmSync,
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

// Builds a disposable git repo that carries everything the REAL
// hooks/pre-commit needs to run to completion (not a stub): gitleaks (found
// on PATH, same as a real dev machine), a real eslint.config.mjs + a
// node_modules JUNCTION into this checkout's own installed eslint/prettier
// (so quality-check.mjs's lint/format steps run for real instead of
// synthetically passing), and the three check scripts pre-commit actually
// invokes. `preCommitContent` lets a mutation test swap in an edited copy
// while every other file (including the guard script itself) stays real.
function buildFixtureRepo(dir, { preCommitContent } = {}) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "a@a"]);
  git(dir, ["config", "user.name", "a"]);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "scripts", "check"), { recursive: true });
  writeFileSync(
    join(dir, "hooks", "pre-commit"),
    preCommitContent ?? readFileSync(PRE_COMMIT_PATH, "utf8"),
    "utf8",
  );
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
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(dir, "base.mjs"), "export const base = 1;\n", "utf8");
  git(dir, [
    "add",
    ".gitignore",
    "base.mjs",
    "hooks",
    "scripts",
    "eslint.config.mjs",
    "package.json",
  ]);
  git(dir, ["commit", "-q", "-m", "base"]);
  // Junction, not a copy -- real eslint/prettier binaries, zero disk
  // duplication. .gitignore above keeps `git add` from ever walking into it.
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(dir, "node_modules"),
    "junction",
  );
}

function runPreCommit(dir) {
  return spawnSync("sh", [join(dir, "hooks", "pre-commit")], {
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
// WHO/WHEN, real end-to-end: `sh hooks/pre-commit` (git's actual local
// invocation shape) against the REAL, unmodified hooks/pre-commit and the
// REAL live-harness-scratch-guard.mjs.
// ---------------------------------------------------------------------------

test("real hooks/pre-commit BLOCKS a real staged HYK-394-test-leak-3-shaped violation (WHO=git pre-commit hook, WHEN=git commit time)", () => {
  withFixtureRepo({}, (dir) => {
    writeFileSync(join(dir, "leaky.test.mjs"), VIOLATING_CONTENT, "utf8");
    git(dir, ["add", "leaky.test.mjs"]);
    const r = runPreCommit(dir);
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
  });
});

test("real hooks/pre-commit control: a clean staged .mjs file (no leak pattern) passes -- the new step introduces zero false positives", () => {
  withFixtureRepo({}, (dir) => {
    writeFileSync(
      join(dir, "clean.test.mjs"),
      "export const clean = 1;\n",
      "utf8",
    );
    git(dir, ["add", "clean.test.mjs"]);
    const r = runPreCommit(dir);
    assert.equal(
      r.status,
      0,
      `expected the commit to pass, got exit ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`,
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
    const r = runPreCommit(dir);
    assert.equal(
      r.status,
      0,
      `RED expected (mutated hook has no wiring left to block this): got exit ${r.status}. stdout=${r.stdout} stderr=${r.stderr}`,
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
