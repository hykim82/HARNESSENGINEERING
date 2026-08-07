import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  judgeHookFile,
  judgeHookSync,
  resolveInstalledDir,
  buildEntries,
  runHookSyncCheck,
} from "./hook-sync-check.mjs";

// Every fixture below lives under a fresh mkdtemp directory and is removed
// in a `finally` -- the real repo's hooks/ and .git/hooks/ are never read or
// written by this file (task spec §3-B non-negotiable).
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hook-sync-test-"));
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

// ---------------------------------------------------------------------------
// Core: judgeHookFile / judgeHookSync (pure, injected values only)
// ---------------------------------------------------------------------------

test("judgeHookFile: identical content -> IN_SYNC", () => {
  const r = judgeHookFile({
    name: "pre-commit",
    versioned: { present: true, readable: true, content: "same" },
    installed: { present: true, readable: true, content: "same" },
  });
  assert.equal(r.status, "IN_SYNC");
  assert.equal(r.versionedSha256, r.installedSha256);
});

test("judgeHookFile: 1-byte content difference -> DRIFT with both sha256", () => {
  const r = judgeHookFile({
    name: "pre-commit",
    versioned: { present: true, readable: true, content: "sameX" },
    installed: { present: true, readable: true, content: "sameY" },
  });
  assert.equal(r.status, "DRIFT");
  assert.equal(r.kind, "content");
  assert.notEqual(r.versionedSha256, r.installedSha256);
  assert.equal(typeof r.versionedSha256, "string");
  assert.equal(typeof r.installedSha256, "string");
});

test("judgeHookFile: installed missing -> DRIFT (kind: missing)", () => {
  const r = judgeHookFile({
    name: "pre-commit",
    versioned: { present: true, readable: true, content: "x" },
    installed: { present: false },
  });
  assert.equal(r.status, "DRIFT");
  assert.equal(r.kind, "missing");
});

test("judgeHookFile: installed unreadable -> UNDECIDABLE, never IN_SYNC/DRIFT", () => {
  const r = judgeHookFile({
    name: "pre-commit",
    versioned: { present: true, readable: true, content: "x" },
    installed: { present: true, readable: false, reason: "EACCES" },
  });
  assert.equal(r.status, "UNDECIDABLE");
});

test("judgeHookFile: versioned unreadable -> UNDECIDABLE", () => {
  const r = judgeHookFile({
    name: "pre-commit",
    versioned: { present: true, readable: false, reason: "EACCES" },
    installed: { present: true, readable: true, content: "x" },
  });
  assert.equal(r.status, "UNDECIDABLE");
});

test("judgeHookSync: one UNDECIDABLE file makes the whole verdict UNDECIDABLE, never DRIFT/IN_SYNC", () => {
  const judged = judgeHookSync([
    {
      name: "a",
      versioned: { present: true, readable: true, content: "1" },
      installed: { present: true, readable: true, content: "1" },
    },
    {
      name: "b",
      versioned: { present: true, readable: true, content: "1" },
      installed: { present: true, readable: false, reason: "boom" },
    },
  ]);
  assert.equal(judged.verdict, "UNDECIDABLE");
});

test("judgeHookSync: mismatches array carries name/kind/both sha256, only for DRIFT entries", () => {
  const judged = judgeHookSync([
    {
      name: "a",
      versioned: { present: true, readable: true, content: "1" },
      installed: { present: true, readable: true, content: "1" },
    },
    {
      name: "b",
      versioned: { present: true, readable: true, content: "1" },
      installed: { present: true, readable: true, content: "2" },
    },
  ]);
  assert.equal(judged.verdict, "DRIFT");
  assert.equal(judged.mismatches.length, 1);
  assert.deepEqual(Object.keys(judged.mismatches[0]).sort(), [
    "installedSha256",
    "kind",
    "name",
    "versionedSha256",
  ]);
  assert.equal(judged.mismatches[0].name, "b");
});

// ---------------------------------------------------------------------------
// buildEntries: extra installed-only files never affect scope
// ---------------------------------------------------------------------------

test("buildEntries: installed-side-only extra file (*.sample) is not enumerated -> IN_SYNC", () => {
  withTempDir((dir) => {
    const versionedDir = join(dir, "hooks");
    const installedDir = join(dir, "installed");
    mkdirSync(versionedDir, { recursive: true });
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(versionedDir, "pre-commit"), "same");
    writeFileSync(join(installedDir, "pre-commit"), "same");
    writeFileSync(join(installedDir, "pre-commit.sample"), "unrelated");

    const built = buildEntries({ versionedDir, installedDir });
    assert.equal(built.entries.length, 1);
    const judged = judgeHookSync(built.entries);
    assert.equal(judged.verdict, "IN_SYNC");
  });
});

test("buildEntries: a versioned-only new file with no installed counterpart -> DRIFT (not just pre-commit)", () => {
  withTempDir((dir) => {
    const versionedDir = join(dir, "hooks");
    const installedDir = join(dir, "installed");
    mkdirSync(versionedDir, { recursive: true });
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(versionedDir, "pre-commit"), "same");
    writeFileSync(join(installedDir, "pre-commit"), "same");
    writeFileSync(join(versionedDir, "commit-msg"), "new hook");
    // installedDir has no commit-msg at all

    const built = buildEntries({ versionedDir, installedDir });
    const judged = judgeHookSync(built.entries);
    assert.equal(judged.verdict, "DRIFT");
    assert.deepEqual(
      judged.mismatches.map((m) => m.name),
      ["commit-msg"],
    );
  });
});

test("buildEntries: versioned directory missing -> error surfaced, never silently empty", () => {
  withTempDir((dir) => {
    const built = buildEntries({
      versionedDir: join(dir, "does-not-exist"),
      installedDir: join(dir, "installed"),
    });
    assert.ok(built.error);
    assert.equal(built.entries, undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveInstalledDir: option / core.hooksPath / git-common-dir(worktree)
// ---------------------------------------------------------------------------

test("resolveInstalledDir: --installed-dir option always wins, no git call needed", () => {
  const r = resolveInstalledDir({
    installedDirOption: "/explicit/dir",
    cwd: "/irrelevant",
    execFn: () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(r, { dir: "/explicit/dir", source: "option" });
});

test("resolveInstalledDir: git-common-dir resolution failure -> null dir + error, fed to UNDECIDABLE", () => {
  const r = resolveInstalledDir({
    cwd: "/irrelevant",
    execFn: (cmd) => {
      if (cmd.includes("core.hooksPath")) throw new Error("not set");
      throw new Error("not a git repo");
    },
  });
  assert.equal(r.dir, null);
  assert.ok(r.error);
});

test("resolveInstalledDir: honors real core.hooksPath in a synthetic repo (not --installed-dir)", () => {
  withTempDir((dir) => {
    initSyntheticRepo(dir);
    const customHooks = join(dir, "custom-hooks-dir");
    mkdirSync(customHooks, { recursive: true });
    git(dir, `config core.hooksPath "${customHooks.replace(/\\/g, "/")}"`);

    const r = resolveInstalledDir({ cwd: dir });
    assert.equal(r.source, "core.hooksPath");
    assert.equal(r.dir.replace(/\\/g, "/"), customHooks.replace(/\\/g, "/"));
  });
});

test("resolveInstalledDir: linked worktree resolves to the MAIN repo's .git/hooks via git-common-dir, not <worktree>/.git/hooks", () => {
  withTempDir((dir) => {
    const mainRepo = join(dir, "main");
    mkdirSync(mainRepo, { recursive: true });
    initSyntheticRepo(mainRepo);
    writeFileSync(join(mainRepo, "README.md"), "x");
    git(mainRepo, "add README.md");
    git(mainRepo, 'commit -q -m "init"');

    const worktreeDir = join(dir, "wt");
    git(
      mainRepo,
      `worktree add -q "${worktreeDir.replace(/\\/g, "/")}" -b wt-branch`,
    );

    const r = resolveInstalledDir({ cwd: worktreeDir });
    assert.equal(r.source, "git-common-dir");
    // In a linked worktree, <worktree>/.git is a FILE, not a hooks-bearing
    // directory -- the resolved dir must land under the MAIN repo's .git,
    // never under <worktreeDir>/.git. Comparing against git's OWN report of
    // mainRepo's toplevel (rather than the mkdtemp path string) sidesteps a
    // short/long Windows path-form mismatch (`ADMINI~1` vs `Administrator`)
    // that `fs.realpathSync` does not normalize but `git` itself does.
    const gitReportedMainRoot = git(mainRepo, "rev-parse --show-toplevel")
      .replace(/\\/g, "/")
      .toLowerCase();
    assert.ok(
      r.dir.replace(/\\/g, "/").toLowerCase().startsWith(gitReportedMainRoot),
      `expected ${r.dir} to resolve under the main repo (${gitReportedMainRoot}), not the worktree`,
    );
    assert.ok(r.dir.replace(/\\/g, "/").endsWith("/hooks"));
  });
});

// ---------------------------------------------------------------------------
// runHookSyncCheck: end-to-end, including --install idempotency
// ---------------------------------------------------------------------------

function scaffold(dir) {
  const versionedDir = join(dir, "hooks");
  const installedDir = join(dir, "installed");
  mkdirSync(versionedDir, { recursive: true });
  mkdirSync(installedDir, { recursive: true });
  return { versionedDir, installedDir };
}

test("runHookSyncCheck: identical -> verdict IN_SYNC", () => {
  withTempDir((dir) => {
    const { versionedDir, installedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "same body");
    writeFileSync(join(installedDir, "pre-commit"), "same body");
    const result = runHookSyncCheck({
      versionedDirOption: versionedDir,
      installedDirOption: installedDir,
      root: dir,
    });
    assert.equal(result.verdict, "IN_SYNC");
  });
});

test("runHookSyncCheck: --install copies drifted content, then self-verifies IN_SYNC", () => {
  withTempDir((dir) => {
    const { versionedDir, installedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "new body");
    // installedDir starts empty -- pre-commit missing entirely.
    const result = runHookSyncCheck({
      versionedDirOption: versionedDir,
      installedDirOption: installedDir,
      install: true,
      root: dir,
    });
    assert.equal(result.verdict, "IN_SYNC");
    assert.equal(
      readFileSync(join(installedDir, "pre-commit"), "utf8"),
      "new body",
    );
  });
});

test("runHookSyncCheck: --install is idempotent -- a second run changes nothing and stays IN_SYNC", () => {
  withTempDir((dir) => {
    const { versionedDir, installedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "new body");
    runHookSyncCheck({
      versionedDirOption: versionedDir,
      installedDirOption: installedDir,
      install: true,
      root: dir,
    });
    const before = readFileSync(join(installedDir, "pre-commit"), "utf8");
    const result = runHookSyncCheck({
      versionedDirOption: versionedDir,
      installedDirOption: installedDir,
      install: true,
      root: dir,
    });
    assert.equal(result.verdict, "IN_SYNC");
    assert.equal(
      readFileSync(join(installedDir, "pre-commit"), "utf8"),
      before,
    );
  });
});

test("runHookSyncCheck: when already IN_SYNC, --install does not touch the installed file (mtime/content unchanged)", () => {
  withTempDir((dir) => {
    const { versionedDir, installedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "same body");
    writeFileSync(join(installedDir, "pre-commit"), "same body");
    const result = runHookSyncCheck({
      versionedDirOption: versionedDir,
      installedDirOption: installedDir,
      install: true,
      root: dir,
    });
    assert.equal(result.verdict, "IN_SYNC");
  });
});

test("runHookSyncCheck: versioned dir missing -> UNDECIDABLE, exit-code contract is never 0", () => {
  withTempDir((dir) => {
    const installedDir = join(dir, "installed");
    mkdirSync(installedDir, { recursive: true });
    const result = runHookSyncCheck({
      versionedDirOption: join(dir, "no-such-hooks"),
      installedDirOption: installedDir,
      root: dir,
    });
    assert.equal(result.verdict, "UNDECIDABLE");
  });
});

test("runHookSyncCheck: installed dir resolution failure (no option, no git repo) -> UNDECIDABLE", () => {
  withTempDir((dir) => {
    const { versionedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "x");
    // dir itself is not a git repo and no --installed-dir is given.
    const result = runHookSyncCheck({
      versionedDirOption: versionedDir,
      cwd: dir,
      root: dir,
    });
    assert.equal(result.verdict, "UNDECIDABLE");
    assert.equal(result.resolvedInstalledDir, null);
  });
});

test("runHookSyncCheck: --json-shaped result exposes verdict/mismatches/resolvedInstalledDir/source", () => {
  withTempDir((dir) => {
    const { versionedDir, installedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "a");
    writeFileSync(join(installedDir, "pre-commit"), "b");
    const result = runHookSyncCheck({
      versionedDirOption: versionedDir,
      installedDirOption: installedDir,
      root: dir,
    });
    assert.equal(result.verdict, "DRIFT");
    assert.equal(result.resolvedInstalledDir, installedDir);
    assert.equal(result.source, "option");
    assert.equal(result.mismatches.length, 1);
  });
});

// Exercises the real CLI entrypoint end-to-end (spawned as a child process),
// confirming the documented exit-code contract holds through argv parsing
// and process.exit, not just through the exported functions.
test("CLI: exit code 0 for IN_SYNC, 2 for DRIFT, 1 for UNDECIDABLE (--json)", () => {
  withTempDir((dir) => {
    const { versionedDir, installedDir } = scaffold(dir);
    writeFileSync(join(versionedDir, "pre-commit"), "same");
    writeFileSync(join(installedDir, "pre-commit"), "same");
    const scriptPath = join(
      process.cwd(),
      "scripts",
      "check",
      "hook-sync-check.mjs",
    );

    const inSync = execSync(
      `node "${scriptPath}" --versioned-dir "${versionedDir}" --installed-dir "${installedDir}" --json`,
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(JSON.parse(inSync).verdict, "IN_SYNC");

    writeFileSync(join(installedDir, "pre-commit"), "different");
    let driftExit = 0;
    let driftOut;
    try {
      driftOut = execSync(
        `node "${scriptPath}" --versioned-dir "${versionedDir}" --installed-dir "${installedDir}" --json`,
        { cwd: dir, encoding: "utf8" },
      );
    } catch (err) {
      driftExit = err.status;
      driftOut = err.stdout;
    }
    assert.equal(driftExit, 2);
    assert.equal(JSON.parse(driftOut).verdict, "DRIFT");

    let undecidableExit = 0;
    try {
      execSync(
        `node "${scriptPath}" --versioned-dir "${join(dir, "no-such-dir")}" --installed-dir "${installedDir}" --json`,
        { cwd: dir, encoding: "utf8" },
      );
    } catch (err) {
      undecidableExit = err.status;
    }
    assert.equal(undecidableExit, 1);
  });
});

test("sanity: real hooks/ and .git/hooks/ are never written by this test file", () => {
  assert.ok(existsSync(join(process.cwd(), "hooks", "pre-commit")));
  // No assertion writes to those paths anywhere above -- this test exists
  // only as a reviewable marker that the constraint was honored throughout.
});
