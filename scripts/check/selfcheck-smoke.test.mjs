import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  smokeClearSafeCheck,
  smokeControlroomFresh,
  smokeStatusFresh,
  smokeRelayHandshake,
  smokePmSnapshotGate,
  smokeReviewGate,
  smokeLinearSync,
  captureGitStatus,
  runSmokeSuite,
  SMOKE_TOUCHED_PATHSPECS,
} from "./selfcheck-smoke.mjs";

// scripts/check/selfcheck-smoke.test.mjs -> repo root is two levels up.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const scriptOf = (id) => fileURLToPath(new URL(`./${id}.mjs`, import.meta.url));

// HYK-466 §3-ㄴ proof (b): the real repo's `git status --porcelain` must be
// byte-identical before this file's first test and after its last -- this
// is the same before()/after() idiom review-gate-auto-record.test.mjs and
// 15 sibling suites already use (captured at module load, compared in
// `after`), not a fresh invention. It proves the module-level fix (tests
// (11)-(13) below no longer touch REPO_ROOT at all) actually holds for this
// file's own run, independent of runSmokeSuite's own G8 check in test (10).
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "selfcheck-smoke.test.mjs must leave the real worktree exactly as it found it",
  );
});

// HYK-466 §3-ㄱ/ㄴ: tests (11)-(13) below simulate contamination/noise
// against SMOKE_TOUCHED_PATHSPECS ("scripts/check", "scripts/supervisor").
// They used to write their fixture files directly into the REAL repo at
// those relative paths, relying on a `finally { rmSync(...) }` for cleanup
// -- but node --test runs this file's tests concurrently with ~40 other
// suites that each snapshot the real repo's whole-tree git status, so a
// fixture file that exists only for a few milliseconds could still get
// caught mid-window by an unrelated suite's before/after snapshot (CI
// evidence, 2026-09-14: review-gate-auto-record.test.mjs's exactness
// assertion tripped on a leaked hyk466-preexisting-dirty-fixture.tmp).
// withTmpGitRepo gives each of these tests its own disposable git repo
// (mkdtemp + git init, mirroring the two touched-pathspec directories) so
// the contamination/noise fixtures never exist inside REPO_ROOT at all.
function withTmpGitRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "selfcheck-smoke-hyk466-"));
  try {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "smoke@example.com"', { cwd: dir });
    execSync('git config user.name "smoke"', { cwd: dir });
    mkdirSync(join(dir, "scripts", "check"), { recursive: true });
    mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
    writeFileSync(join(dir, "scripts", "check", ".gitkeep"), "", "utf8");
    writeFileSync(join(dir, "scripts", "supervisor", ".gitkeep"), "", "utf8");
    execSync("git add .", { cwd: dir });
    execSync("git commit -q -m init", { cwd: dir });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertBadGood(cases, id) {
  const bad = cases.find((c) => c.id === id && c.variant === "bad");
  const good = cases.find((c) => c.id === id && c.variant === "good");
  assert.ok(bad, `${id}: missing bad case`);
  assert.ok(good, `${id}: missing good case`);
  assert.equal(bad.pass, true, `${id} bad case: ${JSON.stringify(bad)}`);
  assert.equal(good.pass, true, `${id} good case: ${JSON.stringify(good)}`);
}

test("(1) smokeClearSafeCheck: real CLI, bad fixture -> exit 2, good fixture -> exit 0", () => {
  const cases = smokeClearSafeCheck({
    scriptPath: scriptOf("clear-safe-check"),
  });
  assertBadGood(cases, "clear-safe-check");
});

test("(2) smokeControlroomFresh: real CLI over a temp git repo, bad -> exit 2, good -> exit 0", () => {
  const cases = smokeControlroomFresh({
    scriptPath: scriptOf("controlroom-fresh"),
  });
  assertBadGood(cases, "controlroom-fresh");
});

test("(3) smokeStatusFresh: real CLI, bad (future work-file mtime) -> exit 1, good -> exit 0", () => {
  const cases = smokeStatusFresh({ scriptPath: scriptOf("status-fresh") });
  assertBadGood(cases, "status-fresh");
});

test("(4) smokeRelayHandshake: real CLI, DONE predating drop -> exit 1, DONE postdating drop -> exit 0", () => {
  const cases = smokeRelayHandshake({
    scriptPath: scriptOf("relay-handshake"),
  });
  assertBadGood(cases, "relay-handshake");
});

test("(5) smokePmSnapshotGate: real CLI, B2 missing envelope -> exit 1, B1 exempt -> exit 0", () => {
  const cases = smokePmSnapshotGate({
    scriptPath: scriptOf("pm-snapshot-gate"),
  });
  assertBadGood(cases, "pm-snapshot-gate");
});

test("(6) smokeReviewGate: real checkReviewGate over temp fixture, missing evidence -> ok:false, complete evidence -> ok:true", () => {
  const cases = smokeReviewGate();
  assertBadGood(cases, "review-gate");
});

test("(7) smokeLinearSync: real diffSync over synthetic §6, stateDrift -> flagged, clean -> not flagged", () => {
  const cases = smokeLinearSync();
  assertBadGood(cases, "linear-sync");
});

test("(8) captureGitStatus: returns a string (or null off a non-repo) without throwing", () => {
  const result = captureGitStatus(REPO_ROOT);
  assert.ok(result === null || typeof result === "string");
});

test("(9) captureGitStatus: a non-git directory -> null, never throws", () => {
  const result = captureGitStatus("C:/Users/Administrator/AppData/Local/Temp");
  assert.equal(result, null);
});

test("(10) runSmokeSuite: against the real repo -- all cases pass and repo diff is zero before/after (G8)", () => {
  const { cases, zeroDiff } = runSmokeSuite({ repoRoot: REPO_ROOT });
  const failed = cases.filter((c) => !c.pass);
  assert.deepEqual(
    failed,
    [],
    `unexpected smoke failures: ${JSON.stringify(failed)}`,
  );
  assert.equal(cases.length, 14);
  assert.equal(
    zeroDiff,
    true,
    "runSmokeSuite must never leave a diff in the real repo (G8)",
  );
});

// ===========================================================================
// HYK-466 (coder-task.md §3-ㄴ, L-7): the whole-repo zeroDiff check flipped
// on unrelated noise elsewhere in the repo (CI evidence: a dirty checkout,
// unconnected to this suite, tripped it twice today). §3-ㄱ narrows the
// comparison to SMOKE_TOUCHED_PATHSPECS (scripts/check, scripts/supervisor
// -- the directories this suite's own spawn/import graph actually reaches).
// L-7 requires BOTH directions demonstrated, not just "it doesn't break
// anymore": real contamination INSIDE scope must still go RED, and noise
// OUTSIDE scope must go GREEN -- and the GREEN case must be shown NOT to be
// vacuous (the same noise DOES flip the old unscoped comparison).
// ===========================================================================

test("(11) HYK-466 진짜 오염 -> RED: a new file inside SMOKE_TOUCHED_PATHSPECS flips the scoped status", () => {
  withTmpGitRepo((dir) => {
    const before = captureGitStatus(dir, SMOKE_TOUCHED_PATHSPECS);
    const contaminationPath = join(
      dir,
      "scripts",
      "check",
      "hyk466-contamination-fixture.tmp",
    );
    writeFileSync(contaminationPath, "contamination\n", "utf8");
    const after = captureGitStatus(dir, SMOKE_TOUCHED_PATHSPECS);
    assert.notEqual(
      before,
      after,
      "a new untracked file inside the scoped paths must flip the scoped status string (real contamination must still be caught)",
    );
  });
});

test("(12) HYK-466 무관한 잡음 -> GREEN (양방향 실증, 비어있지 않음): a new file OUTSIDE SMOKE_TOUCHED_PATHSPECS does not flip the scoped status, even though it DOES flip the old unscoped one", () => {
  withTmpGitRepo((dir) => {
    const beforeScoped = captureGitStatus(dir, SMOKE_TOUCHED_PATHSPECS);
    const beforeWhole = captureGitStatus(dir); // default pathspecs=["."] -- old unscoped behavior
    const noisePath = join(dir, "hyk466-unrelated-noise-fixture.tmp");
    writeFileSync(
      noisePath,
      "unrelated noise, not written by this suite\n",
      "utf8",
    );
    const afterScoped = captureGitStatus(dir, SMOKE_TOUCHED_PATHSPECS);
    const afterWhole = captureGitStatus(dir);
    assert.equal(
      beforeScoped,
      afterScoped,
      "noise outside the scoped paths must NOT flip the scoped status (this is the fix)",
    );
    assert.notEqual(
      beforeWhole,
      afterWhole,
      "sanity (not vacuous): the SAME noise file DOES flip the old whole-repo status -- proving the GREEN above comes from scoping, not from git status being blind to this file",
    );
  });
});

// HYK-466 §3-ㄷ: simulate the CI evidence directly -- a checkout that is
// already dirty OUTSIDE this suite's scope BEFORE the comparison window
// even opens. The scoped check must read zero-diff regardless, since
// nothing inside its own responsibility changed during the window.
test("(13) HYK-466 더러운 checkout 흉내: pre-existing noise outside scope at 'before' time still yields zero scoped diff", () => {
  withTmpGitRepo((dir) => {
    const dirtyPath = join(dir, "hyk466-preexisting-dirty-fixture.tmp");
    writeFileSync(
      dirtyPath,
      "simulates CI: checkout already dirty before this suite even starts\n",
      "utf8",
    );
    const before = captureGitStatus(dir, SMOKE_TOUCHED_PATHSPECS);
    const after = captureGitStatus(dir, SMOKE_TOUCHED_PATHSPECS);
    assert.equal(
      before,
      after,
      "a checkout already dirty outside scope before the run started must still read zero scoped diff",
    );
  });
});
