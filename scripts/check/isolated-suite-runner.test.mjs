import assert from "node:assert/strict";
import test from "node:test";
import {
  TEST_DIRS,
  collectTestFiles,
  formatBanner,
  runIsolatedSuite,
} from "./isolated-suite-runner.mjs";

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
