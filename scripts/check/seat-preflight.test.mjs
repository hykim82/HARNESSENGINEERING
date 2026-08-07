import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  admissionFor,
  evaluateSeatPreflight,
  formatReport,
  FIX_COMMAND,
} from "./seat-preflight.mjs";

// Same rationale as hook-sync-check.test.mjs (HYK-199): this test file's own
// location in the tree is a fixed structural fact, so deriving REPO_ROOT
// from import.meta.url (not process.cwd()) keeps this file's pass/fail
// independent of which directory `node --test` was invoked from.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check", "seat-preflight.mjs");

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-preflight-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8" }).trim();
}

function initSyntheticRepo(dir) {
  git(dir, "init -q");
  git(dir, 'config user.email "t@example.com"');
  git(dir, 'config user.name "t"');
}

// Builds a synthetic git repo with a versioned hooks/ dir + a matching (or
// caller-controlled) .git/hooks/ install dir -- the exact shape
// resolveInstalledDir's git-common-dir path resolves to for a MAIN checkout
// (source: "git-common-dir", same as this real repo). Everything here is
// synthetic (task §4 "합성 디렉터리에 주입"); the real repo's own hooks/ and
// .git/hooks/ are never read or written by this file.
function scaffoldRepo(dir, { installedContent } = {}) {
  initSyntheticRepo(dir);
  writeFileSync(join(dir, "README.md"), "x");
  git(dir, "add README.md");
  git(dir, 'commit -q -m "init"');
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-commit"), "versioned body");
  // hooks/pre-commit must be COMMITTED, not left untracked -- a
  // `git worktree add` checkout only materializes the tree at the checked-
  // out commit, so an untracked file here would silently be absent from any
  // worktree created from this repo (§4-5/§4-6 worktree tests need it
  // present there, matching the task's real premise that hooks/ is a
  // tracked mirror checked out identically in every worktree).
  git(dir, "add hooks/pre-commit");
  git(dir, 'commit -q -m "add hooks/pre-commit"');
  if (installedContent !== undefined) {
    const commonDir = git(dir, "rev-parse --git-common-dir");
    const installedHooksDir = join(dir, commonDir, "hooks");
    mkdirSync(installedHooksDir, { recursive: true });
    writeFileSync(join(installedHooksDir, "pre-commit"), installedContent);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// admissionFor: pure verdict -> {canLaunch, exitCode} mapping, no I/O.
// ---------------------------------------------------------------------------

test("admissionFor: IN_SYNC -> canLaunch true, exit 0", () => {
  assert.deepEqual(admissionFor("IN_SYNC"), { canLaunch: true, exitCode: 0 });
});

test("admissionFor: DRIFT -> canLaunch false, exit 2 (never 0)", () => {
  const r = admissionFor("DRIFT");
  assert.equal(r.canLaunch, false);
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.exitCode, 2);
});

test("admissionFor: UNDECIDABLE -> canLaunch false, exit 1 (never 0)", () => {
  const r = admissionFor("UNDECIDABLE");
  assert.equal(r.canLaunch, false);
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.exitCode, 1);
});

// ---------------------------------------------------------------------------
// evaluateSeatPreflight (behavioral): §4 test 1-4, synthetic state injected
// via a real (but throwaway) git repo -- proves the judgment moves when the
// underlying installed/versioned state moves, not a string-content check.
// ---------------------------------------------------------------------------

test("§4-1: versioned == installed -> IN_SYNC, canLaunch true, exit 0", () => {
  withTempDir((dir) => {
    scaffoldRepo(dir, { installedContent: "versioned body" });
    const result = evaluateSeatPreflight({ cwd: dir });
    assert.equal(result.verdict, "IN_SYNC");
    assert.equal(result.canLaunch, true);
    assert.equal(result.exitCode, 0);
  });
});

test("§4-2: 1-byte drift -> DRIFT, canLaunch false, exit != 0, report names the file and the fix command", () => {
  withTempDir((dir) => {
    scaffoldRepo(dir, { installedContent: "versioned bodY" });
    const result = evaluateSeatPreflight({ cwd: dir });
    assert.equal(result.verdict, "DRIFT");
    assert.equal(result.canLaunch, false);
    assert.notEqual(result.exitCode, 0);
    const report = formatReport(result);
    assert.match(report, /pre-commit/);
    assert.ok(
      report.includes(FIX_COMMAND),
      "DRIFT report must include the copy-pasteable fix command",
    );
  });
});

test("§4-3: installed hook missing entirely -> DRIFT (kind: missing), exit != 0", () => {
  withTempDir((dir) => {
    scaffoldRepo(dir); // no installedContent -- installed/hooks never created
    const result = evaluateSeatPreflight({ cwd: dir });
    assert.equal(result.verdict, "DRIFT");
    assert.equal(result.mismatches[0].kind, "missing");
    assert.notEqual(result.exitCode, 0);
  });
});

test("§4-4: judgment itself fails (versioned hooks/ dir absent) -> UNDECIDABLE, exit != 0 -- never 0", () => {
  withTempDir((dir) => {
    initSyntheticRepo(dir);
    writeFileSync(join(dir, "README.md"), "x");
    git(dir, "add README.md");
    git(dir, 'commit -q -m "init"');
    // Deliberately no hooks/ directory at all.
    const result = evaluateSeatPreflight({ cwd: dir });
    assert.equal(result.verdict, "UNDECIDABLE");
    assert.equal(result.canLaunch, false);
    assert.notEqual(result.exitCode, 0);
    const report = formatReport(result);
    assert.ok(
      !report.includes(FIX_COMMAND),
      "UNDECIDABLE has no known drift to fix -- report must not print the DRIFT fix command",
    );
  });
});

// ---------------------------------------------------------------------------
// §4-5: called from a linked worktree, still resolves the MAIN repo's
// installed .git/hooks (never <worktree>/.git/hooks -- .git there is a
// FILE, not a directory). Exercised through evaluateSeatPreflight AND, right
// below, through the real spawned CLI (§4-6).
// ---------------------------------------------------------------------------

test("§4-5: invoked with cwd = a linked worktree, still resolves to the MAIN repo's installed hooks/", () => {
  withTempDir((dir) => {
    const mainRepo = join(dir, "main");
    mkdirSync(mainRepo, { recursive: true });
    scaffoldRepo(mainRepo, { installedContent: "versioned body" });
    const worktreeDir = join(dir, "wt");
    git(
      mainRepo,
      `worktree add -q "${worktreeDir.replace(/\\/g, "/")}" -b wt-branch`,
    );
    const result = evaluateSeatPreflight({ cwd: worktreeDir });
    assert.equal(
      result.verdict,
      "IN_SYNC",
      "must find the main repo's installed hooks via git-common-dir, not report DRIFT/UNDECIDABLE from a wrong <worktree>/.git/hooks path",
    );
    assert.equal(result.source, "git-common-dir");
  });
});

// ---------------------------------------------------------------------------
// §4-6: the real production CLI entrypoint, spawned as an actual child
// process (not the exported helper) -- proves argv wiring + process.exit,
// not just the in-process functions.
// ---------------------------------------------------------------------------

test("§4-6 CLI: IN_SYNC -> exit 0, stdout says PASS", () => {
  withTempDir((dir) => {
    scaffoldRepo(dir, { installedContent: "versioned body" });
    const r = spawnSync("node", [SCRIPT_PATH], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PASS/);
  });
});

test("§4-6 CLI: DRIFT -> exit != 0 (2), stdout names the file + the fix command", () => {
  withTempDir((dir) => {
    scaffoldRepo(dir, { installedContent: "different body" });
    const r = spawnSync("node", [SCRIPT_PATH], { cwd: dir, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /pre-commit/);
    assert.ok(r.stdout.includes(FIX_COMMAND));
  });
});

test("§4-6 CLI: judgment failure (no hooks/ dir) -> exit != 0 (1), never 0", () => {
  withTempDir((dir) => {
    initSyntheticRepo(dir);
    writeFileSync(join(dir, "README.md"), "x");
    git(dir, "add README.md");
    git(dir, 'commit -q -m "init"');
    const r = spawnSync("node", [SCRIPT_PATH], { cwd: dir, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.status, 1);
  });
});

test("§4-6 CLI, from a linked worktree: still resolves the MAIN repo's installed hooks (real child process, real git worktree)", () => {
  withTempDir((dir) => {
    const mainRepo = join(dir, "main");
    mkdirSync(mainRepo, { recursive: true });
    scaffoldRepo(mainRepo, { installedContent: "versioned body" });
    const worktreeDir = join(dir, "wt");
    git(
      mainRepo,
      `worktree add -q "${worktreeDir.replace(/\\/g, "/")}" -b wt-branch`,
    );
    const r = spawnSync("node", [SCRIPT_PATH], {
      cwd: worktreeDir,
      encoding: "utf8",
    });
    assert.equal(
      r.status,
      0,
      `expected IN_SYNC (main repo's installed hooks found) but got exit ${r.status}: ${r.stdout}${r.stderr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// §4-7 / HYK-199 precedent: this test file itself must not depend on
// process.cwd() for its own path resolution, and any child `node --test` it
// spawns must fix the reporter explicitly (no environment default is safe to
// assume -- CI's Node defaults to "tap", this dev machine's to "spec").
// ---------------------------------------------------------------------------

function parseTapSummary(output) {
  const pass = output.match(/^# pass (\d+)/m);
  const fail = output.match(/^# fail (\d+)/m);
  return {
    pass: pass ? Number(pass[1]) : null,
    fail: fail ? Number(fail[1]) : null,
  };
}

test("regression (HYK-199 precedent): this test file passes identically whether invoked from the repo root or from scripts/ (no process.cwd() dependency)", () => {
  if (process.env.SEAT_PREFLIGHT_TEST_CHILD === "1") {
    return;
  }
  const testFileAbs = join(
    REPO_ROOT,
    "scripts",
    "check",
    "seat-preflight.test.mjs",
  );
  const env = { ...process.env, SEAT_PREFLIGHT_TEST_CHILD: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }

  const fromRoot = spawnSync(
    "node",
    ["--test", "--test-reporter=tap", testFileAbs],
    { cwd: REPO_ROOT, encoding: "utf8", env },
  );
  const fromScripts = spawnSync(
    "node",
    [
      "--test",
      "--test-reporter=tap",
      join("..", "scripts", "check", "seat-preflight.test.mjs"),
    ],
    { cwd: join(REPO_ROOT, "scripts"), encoding: "utf8", env },
  );

  const rootSummary = parseTapSummary(fromRoot.stdout + fromRoot.stderr);
  const scriptsSummary = parseTapSummary(
    fromScripts.stdout + fromScripts.stderr,
  );

  assert.ok(
    rootSummary.pass !== null && rootSummary.fail !== null,
    `could not parse TAP summary from root-cwd run:\n${fromRoot.stdout}\n${fromRoot.stderr}`,
  );
  assert.ok(
    scriptsSummary.pass !== null && scriptsSummary.fail !== null,
    `could not parse TAP summary from scripts-cwd run:\n${fromScripts.stdout}\n${fromScripts.stderr}`,
  );
  assert.equal(fromRoot.status, 0, "root-cwd run must exit 0");
  assert.equal(fromScripts.status, 0, "scripts-cwd run must exit 0");
  assert.equal(rootSummary.fail, 0);
  assert.equal(scriptsSummary.fail, 0);
  assert.equal(rootSummary.pass, scriptsSummary.pass);
});
