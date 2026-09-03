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
import { fileURLToPath } from "node:url";

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
