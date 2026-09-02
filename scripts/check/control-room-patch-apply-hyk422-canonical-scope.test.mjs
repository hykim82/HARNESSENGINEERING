// HYK-422-dispatch-run-1 (coder-task.md §2⑶) -- machine verification of the
// "모양 고정(shape-lock) 조사" claim in docs/control-room-patches/HYK-422-
// dispatch-run-boundary.md's §모양 고정 section: the function this patch
// edits (Invoke-Dispatch, D14's stale-cleanup call) is OUTSIDE the one
// pinned-function axis this repo has (control-room-patch-canonical-sync.mjs
// / seat-proof-wrapper-shape.mjs / seat-proof-wrapper-canonical.json, all
// hard-coded to "Invoke-SeatProofGate" only -- see that module's own header
// comment). Because this patch doc's prose CITES that other module's source
// (quoting the literal string "Invoke-SeatProofGate" as evidence), the doc
// itself trips checkControlRoomPatchCanonicalSync's two independent checks:
//   1. doc-vs-copies (judgeDocAgainstPinnedFunction): does the patch, when
//      applied, change Invoke-SeatProofGate's body? It must not (this patch
//      only touches Invoke-Dispatch) -- expected reasonCode OK_UNCHANGED.
//   2. mention-registry ratchet (checkMentionRegistry): any git-tracked file
//      mentioning "Invoke-SeatProofGate" must be classified in
//      MENTION_BASELINE. This doc is now registered there (role:
//      "reference") -- this test proves that registration actually holds,
//      not just that it was typed once.
//
// ⚠️정직 한계: this test imports the SAME registry/baseline the real CLI
// uses and runs against the REAL repo tree (repoRoot via `git
// rev-parse --show-toplevel`), so it is NOT a synthetic-only test -- it
// reads the actual committed doc/fixture files. If a future round edits
// this doc's --source line or deletes the MENTION_BASELINE entry, this test
// (and the real `npm test` run) goes RED, which is the point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  REASON,
  MENTION_BASELINE,
  checkControlRoomPatchCanonicalSync,
} from "./control-room-patch-canonical-sync.mjs";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const DOC_REL_PATH =
  "docs/control-room-patches/HYK-422-dispatch-run-boundary.md";

test("HYK-422 patch doc is registered in MENTION_BASELINE as role=reference (not role=copy -- it does not embed a body copy of Invoke-SeatProofGate)", () => {
  const entry = MENTION_BASELINE.find((e) => e.relPath === DOC_REL_PATH);
  assert.ok(
    entry,
    "expected a MENTION_BASELINE entry for the HYK-422 patch doc",
  );
  assert.equal(entry.role, "reference");
  assert.ok(entry.reason && entry.reason.trim().length > 0);
});

test("★real-repo sweep: judgeDocAgainstPinnedFunction resolves the HYK-422 doc to OK_UNCHANGED for Invoke-SeatProofGate (this patch does not touch that function's body)", async () => {
  const result = await checkControlRoomPatchCanonicalSync({ repoRoot });
  const finding = result.findings.find(
    (f) => f.doc === DOC_REL_PATH && f.functionName === "Invoke-SeatProofGate",
  );
  assert.ok(
    finding,
    "expected the sweep to have judged the HYK-422 doc against the Invoke-SeatProofGate registry entry",
  );
  assert.equal(finding.reasonCode, REASON.OK_UNCHANGED);
});

test("★real-repo sweep: full checkControlRoomPatchCanonicalSync stays OK (0 red findings) with the HYK-422 doc present -- proves the doc does not require a canonical.json update first", async () => {
  const result = await checkControlRoomPatchCanonicalSync({ repoRoot });
  assert.equal(
    result.ok,
    true,
    `expected 0 red findings, got: ${JSON.stringify(result.redFindings, null, 2)}`,
  );
});

// ---- ★되돌림 변이 (canonical-scope 축): removing the MENTION_BASELINE ----
// ---- entry must flip the mention-registry ratchet RED for this doc ----

test("★되돌림 변이 (canonical-scope): removing the HYK-422 MENTION_BASELINE entry (in-memory override, real file untouched) flips checkMentionRegistry RED naming this doc -- proves the registration test above is not vacuous", () => {
  // Import the lower-level checker separately so this test can pass a
  // mutated baseline without touching the real committed array (mirrors
  // control-room-patch-canonical-sync.test.mjs's own per-copy revert
  // pattern: in-memory override for the ONE thing under test, everything
  // else resolves against real repo state).
  const withoutEntry = MENTION_BASELINE.filter(
    (e) => e.relPath !== DOC_REL_PATH,
  );
  assert.notEqual(withoutEntry.length, MENTION_BASELINE.length);

  // checkMentionRegistry itself is imported fresh to use the mutated baseline.
  return import("./control-room-patch-canonical-sync.mjs").then(
    ({ checkMentionRegistry }) => {
      const result = checkMentionRegistry({
        repoRoot,
        baseline: withoutEntry,
      });
      assert.equal(result.ok, false);
      const finding = result.findings.find((f) => f.relPath === DOC_REL_PATH);
      assert.ok(
        finding,
        "expected checkMentionRegistry to flag the HYK-422 doc once its baseline entry is removed",
      );
      assert.equal(finding.reasonCode, REASON.UNREGISTERED_MENTION);
    },
  );
});
