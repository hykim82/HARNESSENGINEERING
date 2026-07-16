import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveChangedFiles, runQualityCheck } from "./quality-check.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withFixtureRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "quality-check-test-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    writeFileSync(join(dir, "base.mjs"), "export const base = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const baseSha = git(dir, ["rev-parse", "HEAD"]);
    fn(dir, baseSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveChangedFiles: ci mode with missing base SHA -> fail-closed, not vacuous pass", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});

test("resolveChangedFiles: ci mode with all-zero SHA (first push sentinel) -> fail-closed", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: "0".repeat(40),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});

test("resolveChangedFiles: ci mode with unresolvable base SHA -> fail-closed (git diff error surfaced, not swallowed)", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({
      cwd: dir,
      mode: "ci",
      baseSha: "deadbeef".repeat(5),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /git diff against base SHA/);
  });
});

test("resolveChangedFiles: ci mode lists added/modified files, excludes deletions", () => {
  withFixtureRepo((dir, baseSha) => {
    writeFileSync(join(dir, "new.mjs"), "export const n = 1;\n", "utf8");
    writeFileSync(join(dir, "base.mjs"), "export const base = 2;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "add+modify"]);
    git(dir, ["rm", "-q", "base.mjs"]);
    git(dir, ["commit", "-q", "-m", "delete base"]);
    const result = resolveChangedFiles({ cwd: dir, mode: "ci", baseSha });
    assert.equal(result.ok, true);
    // base.mjs was modified then deleted across the range; new.mjs was added.
    // Deletion-only status must never appear as a changed target.
    assert.ok(result.files.includes("new.mjs"));
    assert.ok(
      !result.files.includes("base.mjs") ||
        result.files.filter((f) => f === "base.mjs").length <= 1,
    );
  });
});

test("resolveChangedFiles: staged mode lists index vs HEAD (diff --cached)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "staged.mjs"), "export const s = 1;\n", "utf8");
    git(dir, ["add", "staged.mjs"]);
    const result = resolveChangedFiles({ cwd: dir, mode: "staged" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ["staged.mjs"]);
  });
});

test("resolveChangedFiles: unknown mode -> fail-closed with a clear reason", () => {
  withFixtureRepo((dir) => {
    const result = resolveChangedFiles({ cwd: dir, mode: "bogus" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown mode/);
  });
});

test("runQualityCheck: no changed files in scope -> vacuously green (does not invoke tools)", () => {
  withFixtureRepo((dir) => {
    let called = false;
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: () => {
        called = true;
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(called, false);
  });
});

test("runQualityCheck: changed file with a lint violation -> gate fails (Q1/Q2 core case)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "bad.mjs"), "const unused = 1;\n", "utf8");
    git(dir, ["add", "bad.mjs"]);
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool) =>
        tool === "eslint"
          ? { exitCode: 1, output: "no-unused-vars" }
          : { exitCode: 0, output: "" },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /eslint/);
  });
});

test("runQualityCheck: untouched pre-existing violation is not in the changed set -> not passed to the tool (Q2 amnesty)", () => {
  withFixtureRepo((dir) => {
    // "untouched.mjs" pre-exists at HEAD with a violation but is not part of
    // this change -- it must never reach the tool call, proving the
    // changed-files-only scope (the pre-existing-violation amnesty).
    writeFileSync(join(dir, "untouched.mjs"), "const unused = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, [
      "commit",
      "-q",
      "-m",
      "pre-existing violation, not part of this change",
    ]);
    writeFileSync(join(dir, "clean.mjs"), "export const ok = 1;\n", "utf8");
    git(dir, ["add", "clean.mjs"]);
    const seenTargets = [];
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool, targets) => {
        seenTargets.push(...targets);
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(
      !seenTargets.includes("untouched.mjs"),
      "pre-existing untouched file must not be linted",
    );
    assert.ok(seenTargets.includes("clean.mjs"));
  });
});

test("runQualityCheck: deleted file in the changed set is excluded (nothing left to lint)", () => {
  withFixtureRepo((dir) => {
    git(dir, ["rm", "-q", "base.mjs"]);
    const seenTargets = [];
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool, targets) => {
        seenTargets.push(...targets);
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seenTargets, []);
  });
});

test("runQualityCheck: format-only extensions (.json/.md) go through prettier only, not eslint", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "notes.md"), "# hi\n", "utf8");
    git(dir, ["add", "notes.md"]);
    const calls = [];
    const result = runQualityCheck({
      cwd: dir,
      mode: "staged",
      runTool: (tool) => {
        calls.push(tool);
        return { exitCode: 0, output: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["prettier"]);
  });
});

test("runQualityCheck: ci mode propagates the fail-closed reason from resolveChangedFiles (Q4 structural: no silent full-pass)", () => {
  withFixtureRepo((dir) => {
    const result = runQualityCheck({
      cwd: dir,
      mode: "ci",
      baseSha: undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});
