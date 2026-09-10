import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  const before = captureGitStatus(REPO_ROOT, SMOKE_TOUCHED_PATHSPECS);
  const contaminationPath = join(
    REPO_ROOT,
    "scripts",
    "check",
    "hyk466-contamination-fixture.tmp",
  );
  writeFileSync(contaminationPath, "contamination\n", "utf8");
  try {
    const after = captureGitStatus(REPO_ROOT, SMOKE_TOUCHED_PATHSPECS);
    assert.notEqual(
      before,
      after,
      "a new untracked file inside the scoped paths must flip the scoped status string (real contamination must still be caught)",
    );
  } finally {
    rmSync(contaminationPath, { force: true });
  }
});

test("(12) HYK-466 무관한 잡음 -> GREEN (양방향 실증, 비어있지 않음): a new file OUTSIDE SMOKE_TOUCHED_PATHSPECS does not flip the scoped status, even though it DOES flip the old unscoped one", () => {
  const beforeScoped = captureGitStatus(REPO_ROOT, SMOKE_TOUCHED_PATHSPECS);
  const beforeWhole = captureGitStatus(REPO_ROOT); // default pathspecs=["."] -- old unscoped behavior
  const noisePath = join(REPO_ROOT, "hyk466-unrelated-noise-fixture.tmp");
  writeFileSync(
    noisePath,
    "unrelated noise, not written by this suite\n",
    "utf8",
  );
  try {
    const afterScoped = captureGitStatus(REPO_ROOT, SMOKE_TOUCHED_PATHSPECS);
    const afterWhole = captureGitStatus(REPO_ROOT);
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
  } finally {
    rmSync(noisePath, { force: true });
  }
});

// HYK-466 §3-ㄷ: simulate the CI evidence directly -- a checkout that is
// already dirty OUTSIDE this suite's scope BEFORE the comparison window
// even opens. The scoped check must read zero-diff regardless, since
// nothing inside its own responsibility changed during the window.
test("(13) HYK-466 더러운 checkout 흉내: pre-existing noise outside scope at 'before' time still yields zero scoped diff", () => {
  const dirtyPath = join(REPO_ROOT, "hyk466-preexisting-dirty-fixture.tmp");
  writeFileSync(
    dirtyPath,
    "simulates CI: checkout already dirty before this suite even starts\n",
    "utf8",
  );
  try {
    const before = captureGitStatus(REPO_ROOT, SMOKE_TOUCHED_PATHSPECS);
    const after = captureGitStatus(REPO_ROOT, SMOKE_TOUCHED_PATHSPECS);
    assert.equal(
      before,
      after,
      "a checkout already dirty outside scope before the run started must still read zero scoped diff",
    );
  } finally {
    rmSync(dirtyPath, { force: true });
  }
});
