// NC-2 negative-control: relay-handshake (worker-completion freshness gate).
//
// Every case calls checkRelayHandshake({role, harnessDir}) directly with a
// synthetic `harnessDir` (mkdtemp fixture) -- the real .harness/ directory
// of this or any other worktree is never read or written (design §2-1/§2-2:
// harnessDir is an injectable argument at relay-handshake.mjs:61-64, so no
// source copy is needed to attack this device).
//
// Classification key: BLOCKED = attack was actually stopped (asserted here
// as ok:false). KNOWN GAP = the attack goes through and this is an
// already-recorded, not-yet-implemented limitation (asserted here as
// current behavior -- closing the gap turns this test RED and forces a doc
// update). See docs/enforcement-known-gaps.md for the authoritative table.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkRelayHandshake } from "./relay-handshake.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

function withHarnessDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-relay-handshake-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${role}-task.md`), body, "utf8");
}
function writeResult(dir, role, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${role}.md`), body, "utf8");
}

const TASK_OK = "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n";

// --- proven defense: stale DONE (predates the drop) -> BLOCKED ---
test("NC-2 relay-handshake/attack: DONE timestamp predates dropped_at (stale result) -> BLOCKED", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: stale replay @ 2026-07-31 09:59 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "a DONE that predates the drop must be blocked",
    );
    assert.match(result.reason, /stale/);
  });
});

// --- HYK-186 fix: DONE timestamp in the far future -> BLOCKED (was: passed, no upper bound) ---
// ★PM 실측(2026-07-31)의 정확한 재현: production checker에
// `dropped_at=2026-07-31 03:00`/`DONE=2099-01-01 00:00`을 넣으면
// `{"ok":true,"reason":"relay handshake ok for FUTURE-1"}`이 나왔다(§1). 이
// 시험은 그 동일한 형태(임의로 먼 미래의 DONE)를 재현하고, 수리 후 이제
// ok:false + state:'FUTURE_DONE'으로 막히는지 고정한다 -- "GAP"에서
// "CLOSED"로 승격.
test("NC-2 relay-handshake/fixed(HYK-186): DONE timestamp 10 years in the future -> BLOCKED (state=FUTURE_DONE) -> CLOSED", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: future replay @ 2036-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "HYK-186 fix: an arbitrarily-future DONE must now be rejected by an authority-clock upper bound",
    );
    assert.equal(result.state, "FUTURE_DONE");
    assert.match(result.reason, /ahead of authority now/);
  });
});

// --- HYK-183 fix: ambiguous task_id (2+ occurrences) is now fail-closed,
//     not "first wins" ---
test("NC-2 relay-handshake/fixed(HYK-183): result file with TWO 'task_id:' lines (old round kept, new appended) -> ok:false with an explicit ambiguity reason, NOT a silently-resolved 'handshake mismatch' -> CLOSED", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    // Old round's task_id kept at top, current round's appended below --
    // simulates a result file that preserved a prior round's block instead
    // of being fully replaced.
    writeResult(
      dir,
      "coder",
      "task_id: HYK-0000-stale-round\n>>> DONE: old round @ 2026-07-30 09:00 KST\n\ntask_id: HYK-9001-x\n>>> DONE: new round @ 2026-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "HYK-183 fix: 2+ standalone task_id: lines must block with an ambiguity reason instead of silently reading either the first or the current one",
    );
    assert.match(result.reason, /2 standalone 'task_id:' lines/);
    assert.match(result.reason, /어느 것이 최종인지 결정할 수 없다/);
    assert.doesNotMatch(result.reason, /handshake mismatch/);
  });
});

// --- HYK-183 fix: ambiguous DONE (2+ occurrences) is now fail-closed,
//     not "last wins" (previously the opposite direction from task_id) ---
test("NC-2 relay-handshake/fixed(HYK-183): result file with TWO '>>> DONE:' lines (old one appears AFTER the new one) -> ok:false with an explicit ambiguity reason, NOT a silently-resolved stale-block -> CLOSED", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    // Current round's real DONE comes first; a stale/leftover DONE line
    // (e.g. from a botched re-work convention) is appended after it.
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: current round @ 2026-07-31 10:05 KST\n\n(과거 기록 · 최종 완료 줄 아님) leftover text\n>>> DONE: stale leftover @ 2026-07-25 09:00 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "HYK-183 fix: 2+ '>>> DONE:' lines must block with an ambiguity reason instead of silently trusting the last one",
    );
    assert.match(result.reason, /2 '>>> DONE:' lines/);
    assert.match(result.reason, /어느 것이 최종인지 결정할 수 없다/);
    assert.doesNotMatch(result.reason, /stale result:/);
    // §2-10's operating rule (newest round always on top, exactly one
    // '>>> DONE:' survives, old ones de-labelled to '(과거 기록 ...) DONE:')
    // is still the correct operating discipline -- this fix only changes
    // what happens when that discipline is violated: loud refusal instead
    // of a silently-resolved (and possibly wrong) verdict.
  });
});

// --- task file fields not at column 0 (bulleted / backticked) -> rejected, not silently accepted ---
test("NC-2 relay-handshake/attack: task file's task_id is not a standalone column-0 line (bulleted) -> BLOCKED (anchor rejects, does not silently pass a wrong id)", () => {
  withHarnessDir((dir) => {
    writeTask(
      dir,
      "coder",
      "- task_id: HYK-9001-x\n- dropped_at: 2026-07-31 10:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: x @ 2026-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "a bulleted task_id line must not satisfy the anchored header check",
    );
    assert.match(result.reason, /task file missing task_id header/);
  });
});

test("NC-2 relay-handshake/attack: task file's task_id wrapped in backticks (`task_id: X`) -> BLOCKED", () => {
  withHarnessDir((dir) => {
    writeTask(
      dir,
      "coder",
      "`task_id: HYK-9001-x`\ndropped_at: 2026-07-31 10:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: x @ 2026-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "a backtick-wrapped task_id line must not satisfy the anchored header check",
    );
    assert.match(result.reason, /task file missing task_id header/);
  });
});

// --- absence cases: no exception leakage ---
test("NC-2 relay-handshake/attack: task file absent -> ok:false with a reason string, no exception", () => {
  withHarnessDir((dir) => {
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: x @ 2026-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task file not found/);
  });
});

test("NC-2 relay-handshake/attack: result file absent (worker not done) -> ok:false with a reason string, no exception", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /result file not found/);
  });
});

// --- labeled DONE line ("DONE(3R):") -> detection failure reproduced ---
test("NC-2 relay-handshake/gap: '>>> DONE(3R): ...' (labeled DONE) is NOT recognized as a DONE line -- reproduces the 2026-07-30 11-minute non-detection incident -> KNOWN GAP", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE(3R): finished but labeled @ 2026-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    // DONE_RE requires the literal token "DONE:" immediately after ">>> ";
    // any label inserted between "DONE" and ":" (e.g. "(3R)") breaks the
    // match entirely, so a worker that actually finished is reported as
    // "result missing DONE line" -- a false negative, not a false accept.
    // Prior record: STATUS.md §7 인수인계 큐 documents this exact incident
    // (11-minute non-detection of a labeled DONE line, 2026-07-30/31).
    assert.equal(
      result.ok,
      false,
      "current behavior: a labeled DONE line is invisible to DONE_RE and the handshake reports the result as missing entirely",
    );
    assert.match(result.reason, /missing.*DONE/);
  });
});

// --- no mtime cross-check against the self-reported timestamp ---
test("NC-2 relay-handshake/gap: self-reported DONE time is never cross-checked against the result file's own mtime -> KNOWN GAP", () => {
  withHarnessDir((dir) => {
    writeTask(dir, "coder", TASK_OK);
    // The file is written (and thus has a real, current mtime) but its
    // *content* claims a DONE time far in the past relative to that mtime.
    // checkRelayHandshake only ever compares droppedAt vs the self-reported
    // DONE string -- it never calls statSync on the result file, so this
    // mismatch is invisible to it. Confirmed by direct source inspection
    // (scripts/check/relay-handshake.mjs has no fs.stat call anywhere).
    writeResult(
      dir,
      "coder",
      "task_id: HYK-9001-x\n>>> DONE: backdated but freshly written @ 2026-07-31 10:05 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      true,
      "current behavior: only the self-reported DONE string is trusted; no mtime cross-check exists",
    );
  });
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-relay-handshake.test.mjs must leave the real worktree exactly as it found it (before/after invariance, not empty)",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-relay-handshake.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
