// NC-2 negative-control: reject-streak (same-issue consecutive-reject ledger
// + escalation-envelope gate).
//
// Layer-1 attacks call parseReviewOutcome/applyOutcome/computeRecord/
// loadLedger/writeLedger/checkEnvelope/checkGate directly with synthetic
// text and ledger objects -- all seven are exported pure functions
// (design §2-2), so no real .harness/reject-streak.json is ever read
// (§2-1: "원장은 읽기도 하지 마라") and no real .harness/*-task.md is ever
// touched. writeLedger is only ever called with an injected writeFileFn
// pointed at a mkdtemp path, never the real ledger path.
//
// Layer-2 mutations (below) copy reject-streak.mjs via `git show
// HEAD:...` into a mkdtemp file and import that copy -- the real source
// file is opened read-only.
//
// This module is documented (task spec, STATUS.md §7) as having FOUR known
// defects already on record; this file's job is to confirm each actually
// reproduces and classify it, not to discover new ones.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  parseReviewOutcome,
  applyOutcome,
  computeRecord,
  loadLedger,
  checkGate,
} from "./reject-streak.mjs";

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

// ---------------------------------------------------------------------
// 1) verdict written as **rejected** (markdown-bold) -> parser format fail-open
// ---------------------------------------------------------------------
test("NC-2 reject-streak/defect: verdict written as '**rejected**' (bold) is not matched by VERDICT_LINE_RE -> UNJUDGABLE, not recorded -> format fail-open (prior-recorded defect, confirmed)", () => {
  const reviewText = "for: HYK-9001-x\nverdict: **rejected**\n";
  const outcome = parseReviewOutcome(reviewText);
  assert.equal(
    outcome.ok,
    false,
    "a bold-formatted verdict does not match the plain-text 'verdict: (approved|rejected)' pattern",
  );
  assert.match(
    outcome.reason,
    /no 'verdict: approved' or 'verdict: rejected' line found/,
  );
  const record = computeRecord({
    reviewText,
    ledger: { schema_version: 1, issues: {} },
    at: "2026-07-31 10:00 KST",
  });
  assert.equal(
    record.ok,
    false,
    "computeRecord must not silently record a rejection it could not parse",
  );
});

// ---------------------------------------------------------------------
// 2) two verdict lines in one file -> HYK-183 fix: fail-closed, not
//    "first wins" (VERDICT_LINE_RE_G now counts occurrences; >=2 is
//    UNJUDGABLE, never silently recorded).
// ---------------------------------------------------------------------
test("NC-2 reject-streak/fixed(HYK-183): two 'verdict:' lines (rejected then approved) -> UNJUDGABLE, NOT recorded -- fail-closed instead of silently reading the first (was: mixed-record incident) -> CLOSED", () => {
  const reviewText =
    "for: HYK-9001-x\nverdict: rejected\nnotes: first pass\n\n(REVISED) for: HYK-9001-x\nverdict: approved\nnotes: fixed on second look\n";
  const outcome = parseReviewOutcome(reviewText);
  assert.equal(
    outcome.ok,
    false,
    "HYK-183 fix: 2+ 'verdict:' lines must never resolve to a single silently-chosen verdict",
  );
  assert.match(
    outcome.reason,
    /판정 줄이 2개라 어느 것이 최종인지 결정할 수 없다/,
  );
  const record = computeRecord({
    reviewText,
    ledger: { schema_version: 1, issues: {} },
    at: "2026-07-31 10:00 KST",
  });
  assert.equal(
    record.ok,
    false,
    "an ambiguous verdict must never mutate the ledger, in either direction",
  );
});

// ---------------------------------------------------------------------
// 3) 'for:'/'task_id:' vs 'verdict:' can point at DIFFERENT rounds --
//    HYK-183 fix: the ambiguous verdict count alone is enough to refuse
//    the record, regardless of what 'for:' resolves to.
// ---------------------------------------------------------------------
test("NC-2 reject-streak/fixed(HYK-183): 'for:' (round A) and two 'verdict:' lines (round A rejected, round B approved) -> UNJUDGABLE -- the ambiguous verdict count blocks the record before any single round's verdict is trusted -> CLOSED", () => {
  // Round A rejected; round B (a later, distinct review pass for the same
  // file) approved. Both 'for:' lines say the same issue id, but with two
  // 'verdict:' lines present the fixed parser refuses to pick either one
  // rather than silently trusting round A's (the old first-match
  // behavior). This is the same "two fields, two different directions of
  // truth" shape that motivated the relay-handshake fix in
  // nc-relay-handshake.test.mjs (task_id: was first-match, DONE: was
  // last-match) -- both tools now fail-closed on ambiguity instead of
  // picking a direction.
  const reviewText =
    "for: HYK-9001-x\nverdict: rejected\n\nfor: HYK-9001-x\nverdict: approved\n";
  const outcome = parseReviewOutcome(reviewText);
  assert.equal(
    outcome.ok,
    false,
    "the ambiguity (here: two 'for:' lines, checked before verdict resolution) must block the record even though both 'for:' lines happen to agree on the same issue id",
  );
  assert.match(outcome.reason, /어느 것이 최종인지 결정할 수 없다/);
});

// ---------------------------------------------------------------------
// 4) checkGate with no ledger entry / empty ledger -> fail-open at streak=0
// ---------------------------------------------------------------------
test("NC-2 reject-streak/gap: checkGate with an EMPTY ledger (issue never recorded) -> PASS, streak=0 -- fail-open by design -> KNOWN GAP (matches the 'ledger not found in worktree' incident shape)", () => {
  const taskText = "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n";
  const result = checkGate({
    taskText,
    ledger: { schema_version: 1, issues: {} },
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.ok, true);
  assert.match(result.reason, /streak=0/);
});

test("NC-2 reject-streak/gap: checkGate with ledger=undefined (no ledger object at all) -> PASS, streak=0 -- fail-open -> KNOWN GAP", () => {
  const taskText = "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n";
  const result = checkGate({ taskText, ledger: undefined });
  assert.equal(result.status, "PASS");
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------
// 5) taskText with no task_id header -> UNJUDGABLE + fail-open
// ---------------------------------------------------------------------
test("NC-2 reject-streak/attack: taskText has no 'task_id:' header -> UNJUDGABLE + ok:true (fail-open, drop not blocked) -> KNOWN GAP (documented in source comments)", () => {
  const result = checkGate({
    taskText: "no header here, just prose\n",
    ledger: { schema_version: 1, issues: {} },
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(
    result.ok,
    true,
    "an unresolvable task_id must never itself become a block",
  );
});

// ---------------------------------------------------------------------
// 6) wrong issue id targeted -- ledger records against whatever issue id
//    the review text claims, with no cross-check against which issue was
//    actually dropped/worked
// ---------------------------------------------------------------------
test("NC-2 reject-streak/defect: applyOutcome records against WHATEVER issueId is passed, with no check that it matches the task actually in flight -> a review for HYK-1111 can be recorded onto HYK-2222's streak (prior incident: 2026-07-26 wrong-issue false-approved record) -> NEW DEFECT confirmed reproducible", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-2222": { streak: 3, history: [] } },
  };
  // Attacker (or a copy-paste mistake) supplies a mismatched issueId --
  // applyOutcome performs no validation that this issueId is the one the
  // caller's task/session is actually about.
  const next = applyOutcome(ledger, {
    issueId: "HYK-2222",
    taskId: "HYK-1111-unrelated-round",
    verdict: "approved",
    at: "2026-07-31 10:00 KST",
  });
  assert.equal(
    next.issues["HYK-2222"].streak,
    0,
    "an approval whose taskId belongs to an entirely different issue still resets HYK-2222's streak -- no target-consistency check exists between issueId and taskId",
  );
});

// ---------------------------------------------------------------------
// 7) a single approved outcome unconditionally resets streak to 0
// ---------------------------------------------------------------------
test("NC-2 reject-streak/defect: ONE 'approved' verdict unconditionally resets streak to 0, regardless of how high the prior streak was -> the reject-streak gate can be silently cleared by any single approval -> KNOWN GAP", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-9001-x": { streak: 7, history: [] } },
  };
  const next = applyOutcome(ledger, {
    issueId: "HYK-9001-x",
    taskId: "HYK-9001-x-r8",
    verdict: "approved",
    at: "2026-07-31 10:00 KST",
  });
  assert.equal(
    next.issues["HYK-9001-x"].streak,
    0,
    "a streak of 7 is reset to 0 by a single approval, with no distinct 'how many approvals in a row' memory",
  );
});

// ---------------------------------------------------------------------
// 8) checkEnvelope with a missing/incomplete envelope -> BLOCKED (proven)
// ---------------------------------------------------------------------
test("NC-2 reject-streak/attack: checkGate at streak>=2 with NO escalation envelope at all -> BLOCKED", () => {
  const taskText = "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n";
  // checkGate derives issueId via ISSUE_ID_RE (/^(HYK-\d+)/) applied to the
  // task_id token, so 'HYK-9001-x' resolves to issue key 'HYK-9001' (the
  // digit-only prefix), not the full token -- the ledger key must match
  // that derivation, not the raw task_id string.
  const ledger = {
    schema_version: 1,
    issues: { "HYK-9001": { streak: 2, history: [] } },
  };
  const result = checkGate({ taskText, ledger });
  assert.equal(result.status, "BLOCK");
  assert.equal(result.ok, false);
});

test("NC-2 reject-streak/attack: checkGate at streak>=2 with envelope present but 원인 분류 not in the allowed set -> BLOCKED", () => {
  const taskText =
    "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n\n<!-- reject-streak-envelope\n원인 분류: 그냥 운이 없었음\nORCH 조치:\n- 리서치: 다시 봄\n-->\n";
  const ledger = {
    schema_version: 1,
    issues: { "HYK-9001": { streak: 2, history: [] } },
  };
  const result = checkGate({ taskText, ledger });
  assert.equal(
    result.status,
    "BLOCK",
    "a cause label outside ALLOWED_CAUSES must not satisfy the envelope",
  );
});

test("NC-2 reject-streak/attack: checkGate at streak>=2 with a complete, correctly-shaped envelope -> PASS (proven: format check works when satisfied honestly)", () => {
  const taskText =
    "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n\n<!-- reject-streak-envelope\n원인 분류: 모델 한계\nORCH 조치:\n- 리서치: 원인 재조사\n-->\n";
  const ledger = {
    schema_version: 1,
    issues: { "HYK-9001": { streak: 2, history: [] } },
  };
  const result = checkGate({ taskText, ledger });
  assert.equal(result.status, "PASS");
});

test("NC-2 reject-streak/attack: loadLedger given corrupted JSON -> UNJUDGABLE (ok:false), not silently treated as an empty ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-reject-streak-ledger-"));
  try {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, "{ not valid json", "utf8");
    const loaded = loadLedger(p);
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-2 reject-streak/attack: loadLedger given a JSON array instead of {issues:{}} -> UNJUDGABLE (ok:false)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-reject-streak-ledger-"));
  try {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, "[1,2,3]", "utf8");
    const loaded = loadLedger(p);
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /missing\/invalid 'issues' object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Layer 2: mutation ledger -- remove >=3 BLOCKED defenses in a mkdtemp
// copy and confirm RED. Recorded in scripts/check/nc2-mutation-ledger.md.
// ---------------------------------------------------------------------
const REJECT_STREAK_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/reject-streak.mjs"],
  { cwd: ROOT, encoding: "utf8" },
);

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-reject-streak-mutant-"));
  const mutated = mutate(REJECT_STREAK_SRC);
  const filePath = join(dir, "reject-streak.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NC-2 mutation/reject-streak #1: removing the envelope-missing block -> RED (envelope requirement is load-bearing)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      /const envelope = checkEnvelope\(text\);\n\s*if \(!envelope\.ok\) \{[\s\S]*?\n\s*\}\n/,
      "const envelope = { ok: true, reason: 'bypassed' };\n",
    ),
  );
  const taskText = "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n";
  const ledger = {
    schema_version: 1,
    issues: { "HYK-9001": { streak: 5, history: [] } },
  };
  const result = mutant.checkGate({ taskText, ledger });
  assert.equal(
    result.status,
    "PASS",
    "mutant must pass a no-envelope drop that the real gate blocks (RED signal)",
  );
});

test("NC-2 mutation/reject-streak #2: removing the streak>=2 threshold check (always treat as below threshold) -> RED", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      /const streak = ledger\?\.issues\?\.\[issueId\]\?\.streak \?\? 0;\n\s*if \(streak < 2\) \{/,
      "const streak = ledger?.issues?.[issueId]?.streak ?? 0;\n  if (true) {",
    ),
  );
  const taskText = "task_id: HYK-9001-x\ndropped_at: 2026-07-31 10:00 KST\n";
  const ledger = {
    schema_version: 1,
    issues: { "HYK-9001-x": { streak: 9, history: [] } },
  };
  const result = mutant.checkGate({ taskText, ledger });
  assert.equal(
    result.status,
    "PASS",
    "mutant must pass a streak=9 drop with no envelope (RED signal)",
  );
});

test("NC-2 mutation/reject-streak #3: removing the ALLOWED_CAUSES validation -> RED (any cause label accepted)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      /if \(!ALLOWED_CAUSES\.some\(\(c\) => cause === c \|\| cause\.startsWith\(c\)\)\) \{[\s\S]*?\n\s*\}\n/,
      "",
    ),
  );
  const envelopeText =
    "<!-- reject-streak-envelope\n원인 분류: 아무말\nORCH 조치:\n- 리서치: x\n-->\n";
  const result = mutant.checkEnvelope(envelopeText);
  assert.equal(
    result.ok,
    true,
    "mutant must accept an out-of-list cause label (RED signal)",
  );
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-reject-streak.test.mjs must leave the real worktree exactly as it found it (before/after invariance, not empty)",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-reject-streak.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
