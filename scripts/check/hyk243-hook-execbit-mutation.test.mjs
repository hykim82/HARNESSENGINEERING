// HYK-243 §2-1: regression test for the hook exec-bit fix. Two axes:
// (A) real repo -- hooks/commit-msg and hooks/pre-commit must carry mode
//     100755 in git's own record (index/tree), never fs.stat (Windows has
//     no exec bit, so an fs-based check is always-green or always-red
//     noise on this platform -- coder-task.md §2-1 비타협 1).
// (B)/(C) synthetic fixture -- a throwaway git repo proves the checker
//     itself discriminates: a hook committed at 100644 -> RED, the same
//     hook at 100755 -> GREEN. Destructive probing of the real hooks/
//     directory (toggling its bit and back) is off limits (관제실 규약,
//     coder-task.md §2-1 비타협 3) -- only this synthetic repo is ever
//     mutated.
//
// Axis (A) reads git's CURRENTLY RECORDED mode for hooks/ via
// `git ls-files -s` (index), not `git show HEAD:`/`git ls-tree HEAD`, and
// HARD ASSERTS 100755 -- no skip path, conditional or otherwise (HYK-243
// 2R: an earlier revision skipped whenever mode != 100755, which is
// exactly the state a real regression produces -- skip condition ==
// detection target is a device that silently turns itself off the moment
// it's needed, the one failure shape this repo keeps re-learning not to
// ship). Concretely:
//  - run directly against this checkout (`node --test scripts/check/...`),
//    it reads whatever is in the index right now.
//  - run through isolated-suite-runner.mjs (the CI-canonical path), this
//    test executes inside a fresh `git clone`, and a clone's index is
//    populated straight from committed HEAD -- "git clone never carries
//    uncommitted changes" (isolated-suite-runner.mjs's own header
//    comment). So until this task's chmod fix is actually committed, that
//    clone still shows 644 and axis (A) FAILS there -- correctly: the
//    committed HEAD really doesn't have the fix yet. That pre-commit red
//    is not a defect in this test, it's live proof the assertion is wired
//    to something real; it's expected to go green in the commit round
//    that lands the chmod fix on HEAD (out of this round's scope).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_RELPATHS = ["hooks/commit-msg", "hooks/pre-commit"];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repoRoot() {
  return git(HERE, ["rev-parse", "--show-toplevel"]).trim();
}

// Parses `git ls-files -s <path> ...` output
// ("100644 <sha> 0\t<path>") into a { path -> mode } map. A path git
// doesn't know about is simply absent -- callers decide what that means.
function readIndexModes(repoDir, relPaths) {
  const out = git(repoDir, ["ls-files", "-s", ...relPaths]);
  const modes = {};
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [meta, path] = line.split("\t");
    modes[path] = meta.trim().split(/\s+/)[0];
  }
  return modes;
}

// The checker under test: RED (ok:false) if any hook is missing the exec
// bit (mode !== "100755"), GREEN (ok:true) only if every hook is 100755.
// Deliberately git-mode-based, never fs.stat -- see header comment.
function checkHooksExecutable(repoDir, relPaths) {
  const modes = readIndexModes(repoDir, relPaths);
  const details = relPaths.map((path) => ({
    path,
    mode: modes[path] ?? "MISSING",
  }));
  const ok = details.every((d) => d.mode === "100755");
  return { ok, details };
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Builds a disposable git repo with the two hook paths committed at a
// chosen mode. `git add` alone doesn't reliably produce a given exec bit
// cross-platform (Windows has no fs exec bit to read in the first place),
// so the mode is forced explicitly with `update-index --chmod` -- the
// same mechanism this task's own real fix uses.
function initHookFixture(dir, { executable }) {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  for (const rel of HOOK_RELPATHS) {
    writeFileSync(join(dir, rel), "#!/bin/sh\nexit 0\n", "utf8");
  }
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["add", ...HOOK_RELPATHS]);
  git(dir, [
    "update-index",
    `--chmod=${executable ? "+x" : "-x"}`,
    ...HOOK_RELPATHS,
  ]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "fixture",
    "--quiet",
  ]);
}

test("(A) real repo axis: hooks/commit-msg + hooks/pre-commit carry mode 100755 in git's own record", () => {
  const root = repoRoot();
  const { ok, details } = checkHooksExecutable(root, HOOK_RELPATHS);
  assert.ok(
    ok,
    `hooks/ exec bit missing in git's record: ${JSON.stringify(details)} -- ` +
      `fix with: git update-index --chmod=+x hooks/commit-msg hooks/pre-commit`,
  );
  assert.deepEqual(
    details,
    HOOK_RELPATHS.map((path) => ({ path, mode: "100755" })),
  );
});

test("(B) synthetic fixture: RED when a hook is committed without the exec bit", () => {
  withTempDir("hyk243-execbit-red-", (dir) => {
    initHookFixture(dir, { executable: false });
    const result = checkHooksExecutable(dir, HOOK_RELPATHS);
    assert.equal(
      result.ok,
      false,
      `expected RED, got ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.details.every((d) => d.mode === "100644"),
      `expected both hooks at 100644, got ${JSON.stringify(result.details)}`,
    );
  });
});

test("(C) synthetic fixture: GREEN when both hooks are committed with the exec bit (zero false positives)", () => {
  withTempDir("hyk243-execbit-green-", (dir) => {
    initHookFixture(dir, { executable: true });
    const result = checkHooksExecutable(dir, HOOK_RELPATHS);
    assert.equal(
      result.ok,
      true,
      `expected GREEN, got ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.details.every((d) => d.mode === "100755"),
      `expected both hooks at 100755, got ${JSON.stringify(result.details)}`,
    );
  });
});
