// HYK-183: skip-review-usage.mjs is an observer, not a gate -- these tests
// confirm it counts real `skip-review:` trailers (docs/enforcement-v1.md D2
// Rule 2's audited escape hatch) accurately, distinguishes a measurement
// failure from a genuine zero, and never fails a build by exit code even
// when usage is nonzero (§3 of the HYK-183 task spec).
//
// Every fixture repo here is a synthetic `git init` inside `mkdtemp`, never
// this repo's own history -- the real worktree is only touched read-only
// (see the after() invariance check at the bottom, same pattern as
// nc-review-gate.test.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectSkipReviewUsage } from "./skip-review-usage.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "skip-review-usage-fixture-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "fixture@test.local"], dir);
  git(["config", "user.name", "Fixture"], dir);
  return dir;
}

function commitViaFile(dir, message) {
  const msgFile = join(dir, ".commit-msg-tmp");
  writeFileSync(msgFile, message, "utf8");
  git(["commit", "--allow-empty", "-F", msgFile], dir);
  rmSync(msgFile);
}

function withFixtureRepo(fn) {
  const dir = initFixtureRepo();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- (a) accurate count + verbatim reason string ---

test("skip-review-usage: counts real trailers and preserves the reason string verbatim", () => {
  withFixtureRepo((dir) => {
    commitViaFile(
      dir,
      "fix: urgent (HYK-9001)\n\nskip-review: because prod is down and reviewer unavailable\n",
    );
    const result = collectSkipReviewUsage({ cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(
      result.commits[0].reason,
      "because prod is down and reviewer unavailable",
      "reason string must be reported exactly as written -- it is the audit material",
    );
    assert.deepEqual(result.commits[0].issues, ["HYK-9001"]);
    assert.match(result.commits[0].sha, /^[0-9a-f]{40}$/);
  });
});

test("skip-review-usage: a repo with no skip-review trailers reports count 0, ok:true", () => {
  withFixtureRepo((dir) => {
    commitViaFile(dir, "feat: normal work (HYK-1)\n\nnothing special here\n");
    const result = collectSkipReviewUsage({ cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.commits, []);
  });
});

// --- (b) failure distinguished from zero ---

test("skip-review-usage: a non-git directory reports ok:false, not count:0", () => {
  const dir = mkdtempSync(join(tmpdir(), "skip-review-usage-nongit-"));
  try {
    const result = collectSkipReviewUsage({ cwd: dir });
    assert.equal(
      result.ok,
      false,
      "measurement failure must never present as a clean zero count",
    );
    assert.equal("count" in result, false);
    assert.match(result.error, /git log failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skip-review-usage CLI: measurement failure exits nonzero; a clean zero-count run exits 0", () => {
  const nonGitDir = mkdtempSync(
    join(tmpdir(), "skip-review-usage-cli-nongit-"),
  );
  const cleanRepo = initFixtureRepo();
  try {
    commitViaFile(cleanRepo, "feat: normal work (HYK-1)\n\nnothing special\n");

    let failExit = null;
    try {
      execFileSync(
        process.execPath,
        [
          join(ROOT, "scripts", "check", "skip-review-usage.mjs"),
          "--repo",
          nonGitDir,
        ],
        { encoding: "utf8" },
      );
    } catch (err) {
      failExit = err.status;
    }
    assert.equal(failExit, 1, "measurement failure must exit nonzero");

    const zeroOut = execFileSync(
      process.execPath,
      [
        join(ROOT, "scripts", "check", "skip-review-usage.mjs"),
        "--repo",
        cleanRepo,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const zeroResult = JSON.parse(zeroOut);
    assert.equal(zeroResult.ok, true);
    assert.equal(zeroResult.count, 0);
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
    rmSync(cleanRepo, { recursive: true, force: true });
  }
});

// --- (c) trailer-recognition criteria must match review-gate.mjs ---

test("skip-review-usage: a skip-review line entirely inside a code fence is not counted", () => {
  withFixtureRepo((dir) => {
    commitViaFile(
      dir,
      "docs: explain the gate (HYK-9001)\n\n```\nskip-review: example only, not real\n```\n",
    );
    const result = collectSkipReviewUsage({ cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(
      result.count,
      0,
      "a documentation example inside a fence must not be counted as usage",
    );
  });
});

test("skip-review-usage: 'skip-review:' appearing mid-sentence (not at line start) is not counted", () => {
  withFixtureRepo((dir) => {
    commitViaFile(
      dir,
      "note: pointer (HYK-2)\n\nplease see skip-review: docs for details\n",
    );
    const result = collectSkipReviewUsage({ cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(
      result.count,
      0,
      "a string that merely contains 'skip-review:' mid-line must not count as a trailer",
    );
  });
});

// --- (d) read-only ---

test("skip-review-usage: measuring the real repo leaves git status untouched", () => {
  const before = git(["status", "--porcelain"], ROOT);
  const result = collectSkipReviewUsage({ cwd: ROOT });
  assert.equal(result.ok, true);
  const afterStatus = git(["status", "--porcelain"], ROOT);
  assert.equal(
    afterStatus,
    before,
    "measurement must not write anything to the repo",
  );
});

// --- (e) never fails by exit code even with usage present ---

test("skip-review-usage CLI: nonzero usage still exits 0 (observer, not a gate)", () => {
  withFixtureRepo((dir) => {
    commitViaFile(dir, "fix: x (HYK-1)\n\nskip-review: reason one\n");
    commitViaFile(dir, "fix: y (HYK-2)\n\nskip-review: reason two\n");
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, "scripts", "check", "skip-review-usage.mjs"),
        "--repo",
        dir,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(out);
    assert.equal(result.ok, true);
    assert.equal(
      result.count,
      2,
      "exit 0 above already proves the process did not fail on nonzero usage",
    );
  });
});

// --- (f) mutation ledger: at least 3 mutations must turn RED ---
// Precedent: nc-review-gate.test.mjs, adapted (HYK-183 3R, REVIEW P2): the
// real script is read from the WORKING TREE (readFileSync), not `git show
// HEAD:...` -- review-gate.mjs already existed at HEAD when its NC test was
// written, but skip-review-usage.mjs is new in this same round, so an
// unconditional read from HEAD returns nothing until the file is committed
// and the mutation ledger sits permanently skipped pre-commit (exactly the
// gap REVIEW P2 caught: submit-time verification never actually ran).
// Reading the working-tree file makes the mutation run against whatever is
// about to be committed, every time, skip 0. The mutant is still written
// only into a mkdtemp dir outside the repo -- the real
// scripts/check/skip-review-usage.mjs is never opened for writing.
const SKIP_REVIEW_USAGE_PATH = join(
  ROOT,
  "scripts",
  "check",
  "skip-review-usage.mjs",
);
const SKIP_REVIEW_USAGE_SRC = readFileSync(SKIP_REVIEW_USAGE_PATH, "utf8");

// Pre-assert the mutation target matches the CURRENT source exactly once
// before mutating -- a vacuous mutation (pattern matches 0 times, .replace()
// silently becomes a no-op) would otherwise import an unmutated copy and the
// test could pass or fail for the wrong reason, masking real regex drift.
async function importMutatedCopy(pattern, replacement) {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const matches = SKIP_REVIEW_USAGE_SRC.match(globalPattern);
  assert.equal(
    matches ? matches.length : 0,
    1,
    `mutation target must match the current skip-review-usage.mjs source exactly once: ${pattern}`,
  );
  const dir = mkdtempSync(join(tmpdir(), "skip-review-usage-mutant-"));
  const mutated = SKIP_REVIEW_USAGE_SRC.replace(pattern, replacement);
  const filePath = join(dir, "skip-review-usage.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mutation/skip-review-usage #1: removing the code-fence strip -> RED (fenced examples get miscounted as real usage)", async () => {
  const mutant = await importMutatedCopy(
    /const withoutFences = message\.replace\(\/```\[\\s\\S\]\*\?```\/g, ""\);/,
    "const withoutFences = message;",
  );
  withFixtureRepo((dir) => {
    commitViaFile(
      dir,
      "docs: explain (HYK-9001)\n\n```\nskip-review: example only\n```\n",
    );
    const result = mutant.collectSkipReviewUsage({ cwd: dir });
    assert.equal(
      result.count,
      1,
      "mutant must miscount the fenced example as real usage (RED signal)",
    );
  });
});

test("mutation/skip-review-usage #2: removing the line-start anchor -> RED (mid-sentence text gets miscounted as a trailer)", async () => {
  const mutant = await importMutatedCopy(
    /const m = last\.match\(\/\^\[ \\t\]\*skip-review:\[ \\t\]\*\(\.\*\)\$\/im\);/,
    "const m = last.match(/skip-review:[ \\t]*(.*)$/im);",
  );
  withFixtureRepo((dir) => {
    commitViaFile(
      dir,
      "note: pointer (HYK-2)\n\nplease see skip-review: docs for details\n",
    );
    const result = mutant.collectSkipReviewUsage({ cwd: dir });
    assert.equal(
      result.count,
      1,
      "mutant must miscount a mid-sentence mention as a real trailer (RED signal)",
    );
  });
});

test("mutation/skip-review-usage #3: folding a git-log failure into ok:true/count:0 -> RED (failure indistinguishable from a clean zero)", async () => {
  const mutant = await importMutatedCopy(
    /return \{ ok: false, error: `git log failed: \$\{err\.message\}` \};/,
    "return { ok: true, count: 0, commits: [] };",
  );
  const nonGitDir = mkdtempSync(
    join(tmpdir(), "skip-review-usage-mutant-nongit-"),
  );
  try {
    const result = mutant.collectSkipReviewUsage({ cwd: nonGitDir });
    assert.equal(
      result.ok,
      true,
      "mutant must mask the measurement failure as a clean zero (RED signal)",
    );
    assert.equal(result.count, 0);
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "skip-review-usage.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "skip-review-usage.test.mjs changed the tracked-file diff state",
  );
});
