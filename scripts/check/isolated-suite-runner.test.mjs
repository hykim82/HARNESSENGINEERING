import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  TEST_DIRS,
  collectTestFiles,
  formatBanner,
  runIsolatedSuite,
} from "./isolated-suite-runner.mjs";

// HYK-301: these tests spawn the real CLI entry point as a child process --
// importing runIsolatedSuite()/collectTestFiles() directly would never
// exercise the `invokedDirectly` argv-parsing branch these tests exist to
// cover, and the bug this task closes (unknown args silently ignored) lives
// entirely in that branch.
const runnerPath = fileURLToPath(
  new URL("./isolated-suite-runner.mjs", import.meta.url),
);

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

test("collectTestFiles: lists *.test.mjs per dir, sorted, joined with the dir prefix", () => {
  const fakeTree = {
    "scripts/check": ["b.test.mjs", "a.test.mjs", "not-a-test.mjs"],
    "scripts/relay": ["r.test.mjs"],
    "scripts/relay/adapters": ["ad.test.mjs"],
    "scripts/supervisor": ["s.test.mjs"],
  };
  const readdir = (path) => {
    const key = path.replace(/\\/g, "/").replace(/^\/repo\//, "");
    if (!(key in fakeTree)) throw new Error(`ENOENT: ${path}`);
    return fakeTree[key];
  };
  const files = collectTestFiles("/repo", TEST_DIRS, { readdir }).map((f) =>
    f.replace(/\\/g, "/"),
  );
  assert.deepEqual(files, [
    "scripts/check/a.test.mjs",
    "scripts/check/b.test.mjs",
    "scripts/relay/r.test.mjs",
    "scripts/relay/adapters/ad.test.mjs",
    "scripts/supervisor/s.test.mjs",
  ]);
});

test("collectTestFiles: a directory that does not exist in the clone throws (fail-closed), never silently skipped", () => {
  const readdir = () => {
    throw new Error("ENOENT");
  };
  assert.throws(
    () => collectTestFiles("/repo", ["scripts/missing"], { readdir }),
    /required test directory unreadable.*scripts\/missing/,
  );
});

test("collectTestFiles: fail-closed applies per directory -- an earlier readable dir's files do not mask a later dir's read failure", () => {
  const readdir = (path) => {
    const key = path.replace(/\\/g, "/").replace(/^\/repo\//, "");
    if (key === "scripts/check") return ["a.test.mjs"];
    throw new Error("ENOENT");
  };
  assert.throws(
    () =>
      collectTestFiles("/repo", ["scripts/check", "scripts/missing"], {
        readdir,
      }),
    /scripts\/missing/,
  );
});

test("formatBanner: always names the tested commit and always states uncommitted content is excluded", () => {
  const clean = formatBanner({ sha: "abc123", dirty: false });
  assert.match(clean, /tested commit abc123/);
  assert.match(clean, /uncommitted changes are NOT included/);
  assert.doesNotMatch(clean, /NOTE:/);
});

test("formatBanner: a dirty source checkout gets an explicit extra NOTE line, not a silent omission", () => {
  const dirty = formatBanner({ sha: "def456", dirty: true });
  assert.match(dirty, /tested commit def456/);
  assert.match(dirty, /NOTE: the source checkout has uncommitted changes/);
});

test("runIsolatedSuite: clones from repoRoot (not cwd), runs node --test in the clone's cwd, and propagates the child's exit code", () => {
  const calls = [];
  const execFile = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
  let spawnCwd;
  const spawn = (cmd, args, opts) => {
    spawnCwd = opts.cwd;
    return { status: 7 };
  };
  const logs = [];
  const exitCode = runIsolatedSuite({
    execFile,
    spawn,
    log: (m) => logs.push(m),
    collectFiles: () => ["scripts/check/a.test.mjs"],
  });
  assert.equal(exitCode, 7);
  const cloneCall = calls.find((c) => c.args[0] === "clone");
  assert.equal(cloneCall.args[1], "--quiet");
  assert.equal(cloneCall.args[2], "/src");
  const cloneDir = cloneCall.args[3];
  assert.equal(spawnCwd, cloneDir);
  assert.ok(logs.some((l) => l.includes("deadbeef")));
});

test("runIsolatedSuite: a dirty source repo's uncommitted changes surface in the banner, not silently dropped", () => {
  const execFile = (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "cafef00d\n";
    if (args[0] === "status") return " M scripts/foo.mjs\n";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
  const spawn = () => ({ status: 0 });
  const logs = [];
  runIsolatedSuite({
    execFile,
    spawn,
    log: (m) => logs.push(m),
    collectFiles: () => [],
  });
  assert.ok(
    logs.some((l) =>
      l.includes("NOTE: the source checkout has uncommitted changes"),
    ),
  );
});

test("runIsolatedSuite: a fail-closed collectFiles throw propagates out (never swallowed into a green run), and cleanup still runs", () => {
  const execFile = (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
  let spawnCalled = false;
  const spawn = () => {
    spawnCalled = true;
    return { status: 0 };
  };
  assert.throws(
    () =>
      runIsolatedSuite({
        execFile,
        spawn,
        log: () => {},
        collectFiles: () => {
          throw new Error("required test directory unreadable: scripts/x");
        },
      }),
    /required test directory unreadable/,
  );
  assert.equal(
    spawnCalled,
    false,
    "the suite must never run once directory collection has failed closed",
  );
});

test("CLI: an unrecognized positional argument is rejected -- exit!=0, and the raw argument text is in the output (HYK-301 repro/fix)", () => {
  const result = runCli(["/some/positional/path"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
  assert.match(result.stderr, /\/some\/positional\/path/);
});

test("CLI: an unrecognized flag is rejected the same way as a bad positional (HYK-301 §4b)", () => {
  const result = runCli(["--nope"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
  assert.match(result.stderr, /--nope/);
});

test("CLI: zero-argument invocation (the CI-canonical call) still passes argv parsing -- no 'unrecognized argument' rejection (HYK-301 §2-1 / §4c)", () => {
  // A bogus, non-git cwd makes runIsolatedSuite's `git rev-parse
  // --show-toplevel` fail fast, so this test doesn't have to pay for a
  // full clone + suite run to prove the arg-parsing stage was passed --
  // it only needs to show the failure is NOT the "unrecognized argument"
  // rejection, i.e. zero args reached runIsolatedSuite() same as before.
  const notARepo = mkdtempSync(join(tmpdir(), "hyk301-not-a-repo-"));
  try {
    const result = runCli([], { cwd: notARepo });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /unrecognized argument/);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("CLI: --repo-root <path> is still recognized and its value consumed -- no 'unrecognized argument' rejection (HYK-301 §4d)", () => {
  // A bogus target path makes the downstream `git rev-parse HEAD` fail
  // fast once the CLI hands sourceRoot to runIsolatedSuite -- proving
  // --repo-root's value was consumed as a flag value, not flagged as an
  // unrecognized bare argument.
  const result = runCli(["--repo-root", "C:/definitely/not/a/repo/xyz"]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /unrecognized argument/);
});

test("CLI: --repo-root with no following value is rejected, not silently undefined->cwd fallback (HYK-301 §2-11)", () => {
  const result = runCli(["--repo-root"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
  assert.match(result.stderr, /--repo-root/);
});
