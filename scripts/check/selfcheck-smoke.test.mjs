import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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
  const cases = smokeClearSafeCheck({ scriptPath: scriptOf("clear-safe-check") });
  assertBadGood(cases, "clear-safe-check");
});

test("(2) smokeControlroomFresh: real CLI over a temp git repo, bad -> exit 2, good -> exit 0", () => {
  const cases = smokeControlroomFresh({ scriptPath: scriptOf("controlroom-fresh") });
  assertBadGood(cases, "controlroom-fresh");
});

test("(3) smokeStatusFresh: real CLI, bad (future work-file mtime) -> exit 1, good -> exit 0", () => {
  const cases = smokeStatusFresh({ scriptPath: scriptOf("status-fresh") });
  assertBadGood(cases, "status-fresh");
});

test("(4) smokeRelayHandshake: real CLI, DONE predating drop -> exit 1, DONE postdating drop -> exit 0", () => {
  const cases = smokeRelayHandshake({ scriptPath: scriptOf("relay-handshake") });
  assertBadGood(cases, "relay-handshake");
});

test("(5) smokePmSnapshotGate: real CLI, B2 missing envelope -> exit 1, B1 exempt -> exit 0", () => {
  const cases = smokePmSnapshotGate({ scriptPath: scriptOf("pm-snapshot-gate") });
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
  assert.deepEqual(failed, [], `unexpected smoke failures: ${JSON.stringify(failed)}`);
  assert.equal(cases.length, 14);
  assert.equal(zeroDiff, true, "runSmokeSuite must never leave a diff in the real repo (G8)");
});
