// HYK-309: counts, rather than eyeballs, whether a synthetic install
// carries THIS machine's own control-room path into a target repo.
//
// Reproduced fact (coder.md §1): templates/harness-init/install.mjs used
// to `copyRawFile` scripts/check/pm-guard.mjs byte-for-byte into every
// install, so a target on a different machine (or a different
// controlRoomPath on this one) silently inherited this repo's own live
// `CONTROL_ROOM_ROOT` value instead of its own. Every install target here
// is a synthetic, independently `git init`-ed fixture under `tmpdir()` --
// never a real project, never this repo's own checkout, and never derived
// from it via clone/worktree (a sibling round hit a real incident from
// exactly that shortcut: a "isolated" fixture that was actually a worktree
// of the live repo wrote into a real, shared file). See §0 of coder.md for
// the isolation rule this file follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALLER_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);

// The exact fact this round is about: this repo's OWN live control-room
// literal, read from the currently checked-out source (not re-hardcoded
// here a third time) -- whatever this file finds is what must never
// survive, byte-for-byte, into a target that was given a different (or no)
// control-room path.
function readOwnControlRoomRoot() {
  const src = readFileSync(
    path.join(REPO_ROOT, "scripts", "check", "pm-guard.mjs"),
    "utf8",
  );
  // Deliberately lenient on the `export` keyword (unlike install.mjs's own
  // stricter PM_GUARD_CONTROL_ROOM_LINE_RE) -- this only needs to find the
  // literal to prove it doesn't leak, and must still find it pre-fix (when
  // the declaration wasn't exported yet) so this test fails for the actual
  // reason (a residual literal) rather than a setup error.
  const m = /^(?:export )?const CONTROL_ROOM_ROOT = "([^"]*)";$/m.exec(src);
  assert.ok(
    m,
    "scripts/check/pm-guard.mjs: CONTROL_ROOM_ROOT declaration not found " +
      "at its expected shape -- this test cannot determine the literal it " +
      "must prove doesn't leak (fix the regex here or the source together)",
  );
  return m[1];
}

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

// Walks every file under `root` except `.git`, returns [{path, content}].
function walkFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      let content;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue; // binary/unreadable -- can't contain the text literal
      }
      out.push({ path: full, content });
    }
  }
  return out;
}

function countResidualOccurrences(root, literal) {
  const hits = [];
  for (const { path: p, content } of walkFiles(root)) {
    if (content.includes(literal)) hits.push(p);
  }
  return hits;
}

function makeSyntheticTarget(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const targetRepo = path.join(base, "target-repo");
  mkdirSync(targetRepo, { recursive: true });
  execFileSync("git", ["-C", targetRepo, "init", "-q"]);
  return { base, targetRepo };
}

function runInstall(args) {
  execFileSync("node", [INSTALLER_PATH, ...args], { stdio: "pipe" });
}

test("(1) synthetic solo-full install carries zero occurrences of this machine's own control-room path", () => {
  const ownLiteral = readOwnControlRoomRoot();
  const { base, targetRepo } = makeSyntheticTarget("hyk309-portability-solo-");
  try {
    const fakeControlRoom = path.join(base, "fake-control-room");
    mkdirSync(fakeControlRoom, { recursive: true });
    runInstall([
      "--profile",
      "solo-full",
      "--repo-path",
      targetRepo,
      "--control-room-path",
      fakeControlRoom,
      "--github-repo",
      "someorg/somerepo",
      "--bot-account",
      "bot-x",
      "--verify-cmd",
      "npm test",
      "--notify-dir",
      path.join(base, "notify"),
      "--approver-login",
      "approver-x",
      "--approver-id",
      "1",
      "--workspaces-root",
      path.join(base, "workspaces"),
      "--main-repo-path",
      path.join(base, "main-repo"),
    ]);

    const residual = countResidualOccurrences(targetRepo, ownLiteral);
    assert.deepEqual(
      residual,
      [],
      `expected 0 residual occurrences of this machine's control-room path, found in: ${residual.join(", ")}`,
    );

    const pmGuardContent = readFileSync(
      path.join(targetRepo, "scripts", "check", "pm-guard.mjs"),
      "utf8",
    );
    assert.match(
      pmGuardContent,
      new RegExp(
        `^export const CONTROL_ROOM_ROOT = "${toPosix(fakeControlRoom).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";$`,
        "m",
      ),
      "installed pm-guard.mjs must carry the TARGET's own control-room path, not this machine's",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("(2) synthetic team-local install carries zero occurrences of this machine's own control-room path", () => {
  const ownLiteral = readOwnControlRoomRoot();
  const { base, targetRepo } = makeSyntheticTarget("hyk309-portability-team-");
  try {
    runInstall([
      "--profile",
      "team-local",
      "--repo-path",
      targetRepo,
      "--github-repo",
      "someorg/somerepo2",
      "--verify-cmd",
      "npm test",
    ]);

    const residual = countResidualOccurrences(targetRepo, ownLiteral);
    assert.deepEqual(
      residual,
      [],
      `expected 0 residual occurrences of this machine's control-room path, found in: ${residual.join(", ")}`,
    );

    const pmGuardContent = readFileSync(
      path.join(targetRepo, "scripts", "check", "pm-guard.mjs"),
      "utf8",
    );
    // team-local has no control room at all -- must not fall back to
    // this repo's own path, and must not become "" (isControlRoomPath's
    // own `.startsWith("")` would then match every path).
    assert.match(
      pmGuardContent,
      /^export const CONTROL_ROOM_ROOT = "<NO_CONTROL_ROOM_TEAM_LOCAL_PROFILE>";$/m,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("(3) installed pm-guard.test.mjs actually passes against the installed pm-guard.mjs (not just byte-identical)", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk309-portability-run-");
  try {
    const fakeControlRoom = path.join(base, "fake-control-room");
    mkdirSync(fakeControlRoom, { recursive: true });
    runInstall([
      "--profile",
      "solo-full",
      "--repo-path",
      targetRepo,
      "--control-room-path",
      fakeControlRoom,
      "--github-repo",
      "someorg/somerepo",
      "--bot-account",
      "bot-x",
      "--verify-cmd",
      "npm test",
      "--notify-dir",
      path.join(base, "notify"),
      "--approver-login",
      "approver-x",
      "--approver-id",
      "1",
      "--workspaces-root",
      path.join(base, "workspaces"),
      "--main-repo-path",
      path.join(base, "main-repo"),
    ]);

    // node --test's own exit code is the pass/fail signal here.
    execFileSync(
      "node",
      [
        "--test",
        path.join(targetRepo, "scripts", "check", "pm-guard.test.mjs"),
      ],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-309 2R (REVIEW P1): install.mjs:803 re-embedded the substitution value
// via a template-string `.replace(regex, string)` call, whose replacement
// argument is itself re-scanned by String.replace for $$, $&, $<n>, $`, $'
// -- a controlRoomPath containing e.g. "$&" spliced the WHOLE MATCHED LINE
// into the installed declaration instead of the literal two characters
// (reviewer's exact repro). Fixed by switching to a replacer FUNCTION
// (whose return value is never re-scanned) and JSON.stringify for the
// string-literal body (handles the structurally worse case: a literal `"`
// in the value terminating the string early and splicing arbitrary trailing
// text in as JS source -- a real injection shape, not just a display bug).
//
// Risk-character enumeration (this round's own, not just the reviewer's
// single "$&" sample) and why each is tested:
//   - "$&", "$$", "$1", "$`", "$'"  -- String.replace's own special
//     replacement-pattern syntax; "$&" is the reviewer's repro, the other
//     four are the rest of that same syntax family (untested would leave
//     the bug class only partially closed).
//   - '"'                            -- breaks out of the JS string literal
//     the value is embedded in; the most severe category (can splice
//     arbitrary trailing bytes in as source, not just corrupt the path).
//   - "\n"                           -- a raw newline inside a plain
//     (non-template) JS string literal is a SyntaxError; must come out
//     escaped or the installed file doesn't even parse.
// Backslash is deliberately NOT in this battery: toPosixPath() converts
// every backslash to "/" before the value ever reaches substitution (see
// installPmGuard), so a raw backslash structurally cannot reach the
// insertion step through this call path -- a synthetic-install test for it
// would only prove toPosixPath still runs first, not anything about this
// fix. (JSON.stringify would still escape one correctly if some future
// change ever let a backslash through -- that's a JS-language guarantee,
// not this round's code, so it isn't asserted here either.)
const RISKY_VALUE_CASES = [
  { label: "dollar-amp (reviewer repro)", suffix: "$&" },
  { label: "double-dollar", suffix: "$$" },
  { label: "dollar-digit", suffix: "$1" },
  { label: "dollar-backtick", suffix: "$`" },
  { label: "dollar-quote", suffix: "$'" },
  { label: "double-quote", suffix: '"' },
  { label: "embedded-newline", suffix: "\n" },
];

test("(4) special characters in --control-room-path survive into the installed pm-guard.mjs literally (RED->GREEN battery)", async () => {
  const { base, targetRepo } = makeSyntheticTarget(
    "hyk309-portability-special-",
  );
  try {
    for (const { label, suffix } of RISKY_VALUE_CASES) {
      const rawControlRoom = `${path.join(base, "control-room")}-${suffix}-tail`;
      const subTarget = path.join(
        targetRepo,
        `t-${label.replace(/[^a-z0-9]+/gi, "-")}`,
      );
      mkdirSync(subTarget, { recursive: true });
      execFileSync("git", ["-C", subTarget, "init", "-q"]);

      runInstall([
        "--profile",
        "solo-full",
        "--repo-path",
        subTarget,
        "--control-room-path",
        rawControlRoom,
        "--github-repo",
        "someorg/somerepo",
        "--bot-account",
        "bot-x",
        "--verify-cmd",
        "npm test",
        "--notify-dir",
        path.join(base, "notify"),
        "--approver-login",
        "approver-x",
        "--approver-id",
        "1",
        "--workspaces-root",
        path.join(base, "workspaces"),
        "--main-repo-path",
        path.join(base, "main-repo"),
      ]);

      const installedPath = path.join(
        subTarget,
        "scripts",
        "check",
        "pm-guard.mjs",
      );
      const expected = toPosix(rawControlRoom);

      // Text-level: exactly one declaration line, and it round-trips via
      // JSON.parse of the quoted literal -- proves no reinterpretation
      // happened without requiring the file to even be syntactically loadable
      // yet (a $&-reinterpreted line would fail this JSON.parse outright,
      // since it would no longer look like `"..."`).
      const content = readFileSync(installedPath, "utf8");
      const m = /^export const CONTROL_ROOM_ROOT = (".*");$/m.exec(content);
      assert.ok(m, `[${label}] declaration line not found or not on one line`);
      assert.equal(
        JSON.parse(m[1]),
        expected,
        `[${label}] installed value does not round-trip to the exact input`,
      );

      // Module-level: the installed file must actually be valid, loadable
      // JS whose export equals the same value -- catches any escaping bug
      // that corrupts syntax without necessarily breaking the regex above.
      const mod = await import(
        `${pathToFileURL(installedPath).href}?case=${encodeURIComponent(label)}`
      );
      assert.equal(
        mod.CONTROL_ROOM_ROOT,
        expected,
        `[${label}] installed module's live export does not match the input value`,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
