// NC-1 negative-control: quality-check (pre-commit hook step 2 + CI mirror).
//
// resolveChangedFiles/runQualityCheck both accept {cwd, gitDiff} injection
// ports (design doc layer 1), so every attack below runs without a real git
// repo or a real workspace file edit -- the `gitDiff` port stands in for
// `git diff` output entirely. No mkdtemp git repo is required for the
// injection cases; the two cases that need a real (throwaway) repo use
// mkdtemp + `git init` exactly like the existing quality-check.test.mjs
// fixture helper.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveChangedFiles, runQualityCheck } from "./quality-check.mjs";

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

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function withFixtureRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-quality-check-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NC-1 quality-check/gap: empty change set (gitDiff returns nothing) -> vacuously green -> KNOWN GAP (vacuous pass is not proof of a clean change)", () => {
  const result = runQualityCheck({
    cwd: "/nonexistent/does-not-matter",
    mode: "staged",
    gitDiff: () => "",
  });
  assert.equal(
    result.ok,
    true,
    "current behavior: zero changed files always passes",
  );
  assert.match(result.reason, /vacuously green/);
  // Registered as KNOWN GAP, not BLOCKED: "vacuously green" means the gate
  // ran zero checks, which is trivially different from "the gate verified
  // there were no violations." A caller who reads {ok:true} without reading
  // `reason` cannot tell the two apart. ORCH measured this exact trap twice
  // before this cycle (task spec §3-2).
});

test("NC-1 quality-check/attack: a changed .mjs file with a real lint violation -> BLOCKED", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-quality-check-scope-"));
  try {
    writeFileSync(join(dir, "bad.mjs"), "const unused = 1;\n", "utf8");
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      gitDiff: () => "M\tbad.mjs\n",
      runTool: (tool) =>
        tool === "eslint"
          ? { exitCode: 1, output: "no-unused-vars" }
          : { exitCode: 0, output: "" },
    });
    assert.equal(
      result.ok,
      false,
      "an injected lint failure must fail the gate",
    );
    assert.match(result.reason, /eslint/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-1 quality-check/attack: a changed .md file with a real format violation -> BLOCKED", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-quality-check-scope-"));
  try {
    writeFileSync(join(dir, "README.md"), "# hi\n", "utf8");
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      gitDiff: () => "M\tREADME.md\n",
      runTool: (tool) =>
        tool === "prettier"
          ? { exitCode: 1, output: "not formatted" }
          : { exitCode: 0, output: "" },
    });
    assert.equal(
      result.ok,
      false,
      "an injected prettier failure must fail the gate",
    );
    assert.match(result.reason, /prettier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-1 quality-check/attack: --base-sha pointing at a SHA that does not exist -> BLOCKED (fail-closed, not a silent pass)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "base.mjs"), "export const b = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    assert.equal(
      result.ok,
      false,
      "a nonexistent base SHA must fail closed, not be treated as 'no changes'",
    );
    assert.match(result.reason, /git diff against base SHA/);
  });
});

test("NC-1 quality-check/attack: changed set is entirely out-of-scope extensions (.png) -> scope 0, vacuously green, tool never invoked", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-quality-check-scope-"));
  try {
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let called = false;
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      gitDiff: () => "A\tlogo.png\n",
      runTool: () => {
        called = true;
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(
      called,
      false,
      "an out-of-scope-only change set must not invoke eslint/prettier at all",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-1 quality-check/attack: gitDiff port throws -> exception is caught and surfaced as fail-closed, not leaked", () => {
  const staged = runQualityCheck({
    cwd: "/nonexistent/does-not-matter",
    mode: "staged",
    gitDiff: () => {
      throw new Error("synthetic git failure");
    },
  });
  assert.equal(
    staged.ok,
    false,
    "staged mode must fail closed when the diff port throws",
  );
  assert.match(staged.reason, /fail-closed/);

  const ci = runQualityCheck({
    cwd: "/nonexistent/does-not-matter",
    mode: "ci",
    baseSha: "a".repeat(40),
    gitDiff: () => {
      throw new Error("synthetic git failure");
    },
  });
  assert.equal(
    ci.ok,
    false,
    "ci mode must fail closed when the diff port throws",
  );
  assert.match(ci.reason, /fail-closed/);
});

// --- Layer 2 (copy-and-mutate) mutations: real source-copy mutants, same
// technique as nc-review-gate.test.mjs. The real scripts/check/quality-check.mjs
// is only ever read (via `git show HEAD:...`), never opened for writing.
const QUALITY_CHECK_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/quality-check.mjs"],
  {
    cwd: ROOT,
    encoding: "utf8",
  },
);

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-quality-check-mutant-"));
  const mutated = mutate(QUALITY_CHECK_SRC);
  const filePath = join(dir, "quality-check.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NC-1 mutation/quality-check #1: removing the null/all-zero base-SHA guard -> RED (fail-closed becomes silent pass)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      /if \(!baseSha \|\| NULL_SHA_RE\.test\(baseSha\)\) \{[\s\S]*?\n\s*\}\n/,
      "",
    ),
  );
  let gitDiffCalled = false;
  const result = mutant.resolveChangedFiles({
    cwd: "/nonexistent/does-not-matter",
    mode: "ci",
    baseSha: "0".repeat(40),
    gitDiff: () => {
      gitDiffCalled = true;
      return "M\tfile.mjs\n";
    },
  });
  assert.equal(
    gitDiffCalled,
    true,
    "mutant must fall through to gitDiff on the all-zero sentinel (RED signal)",
  );
  assert.equal(
    result.ok,
    true,
    "mutant treats the all-zero SHA as a normal diff instead of failing closed",
  );
});

test("NC-1 mutation/quality-check #2: forcing resolveChangedFiles to always report ok:true -> RED (scope silently collapses to nothing-to-check)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      "export function resolveChangedFiles({ cwd, mode, baseSha, gitDiff } = {}) {",
      "export function resolveChangedFiles() { return { ok: true, files: [] }; } function _unused_resolveChangedFiles({ cwd, mode, baseSha, gitDiff } = {}) {",
    ),
  );
  const result = mutant.runQualityCheck({
    cwd: "/nonexistent/does-not-matter",
    mode: "ci",
    baseSha: undefined,
    runTool: () => ({ exitCode: 1, output: "should never be reached" }),
  });
  assert.equal(
    result.ok,
    true,
    "mutant swallows a missing base SHA into an empty, always-green change set (RED signal)",
  );
});

test("NC-1 mutation/quality-check #3: removing the deleted-file filter (existsSync check) -> RED (lints paths that no longer exist)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      "const existing = changed.files.filter((f) => existsSync(join(cwd, f)));",
      "const existing = changed.files;",
    ),
  );
  const seenTargets = [];
  const result = mutant.runQualityCheck({
    cwd: "/nonexistent/does-not-matter",
    mode: "staged",
    gitDiff: () => "D\tremoved.mjs\n",
    runTool: (tool, targets) => {
      seenTargets.push(...targets);
      return { exitCode: 0, output: "" };
    },
  });
  assert.ok(
    seenTargets.includes("removed.mjs"),
    "mutant passes a deleted, nonexistent file straight to eslint (RED signal -- real code filters it via existsSync)",
  );
  assert.equal(result.ok, true);
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-quality-check.test.mjs must leave the real worktree exactly as it found it",
  );
  const diffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    diffStat.trim(),
    "",
    "nc-quality-check.test.mjs must not leave any tracked-file diff against HEAD",
  );
});
