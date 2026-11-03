// HYK-426: single-source-of-truth test for the "done-stamp marker
// presence" predicate -- before this round, relay-handshake.mjs's consumer
// judged presence at column 0 (DONE_STAMPED_BY_MARKER_RE) while finalize-
// done.mjs's own hasFinalizeDoneMarker judged it with a looser
// rawLine.trim() compare, so a marker with leading whitespace was "absent"
// on one side and "present" on the other -- a dead end (see finalize-
// done.test.mjs's own HYK-426 production-entry-point test for the round-
// trip proof, and relay-handshake-marker-promotion.test.mjs for the
// consumer-side no-loosening proof). This file locks the parity table
// coder-task.md §2ⓒ⑷ asks for: across every marker-spacing/case/prefix
// variant, the exported predicate's verdict must equal finalize-done's own
// (now predicate-backed) already-marked determination -- by construction,
// since both read the same function, but this is the regression lock that
// catches a future re-divergence (e.g. someone adding a second, local
// check back into finalize-done.mjs).
//
// This file lives in scripts/relay/ (not scripts/check/) on purpose: it
// imports from BOTH relay-handshake.mjs (check/) and finalize-done.mjs
// (relay/), and scripts/check/* must never import scripts/relay/*
// (no-restricted-imports, HYK-148 A3 inventory) -- the only direction that
// is never restricted is relay -> check, so a file needing both sides has
// to live on the relay side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasDoneStampedByMarker } from "../check/relay-handshake.mjs";
import { finalizeDone, FINALIZE_DONE_REASON } from "./finalize-done.mjs";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk426-parity-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DONE_LINE = ">>> DONE: CODER @ 2026-08-19 05:10:00 KST";

// Each sample is a marker-line variant (or null = no marker line at all)
// appended after a single well-formed DONE line. `markedByPredicate` is
// the expected hasDoneStampedByMarker() verdict for that exact content --
// the independently-reasoned expectation this table pins against both
// call sites.
const SAMPLES = [
  {
    name: "column-0 (well-formed)",
    markerLine: "done_stamped_by: finalize-done",
    markedByPredicate: true,
  },
  {
    name: "leading space",
    markerLine: " done_stamped_by: finalize-done",
    markedByPredicate: false,
  },
  {
    name: "leading tab",
    markerLine: "\tdone_stamped_by: finalize-done",
    markedByPredicate: false,
  },
  {
    name: "trailing spaces (existing \\s*$ allowance)",
    markerLine: "done_stamped_by: finalize-done   ",
    markedByPredicate: true,
  },
  {
    name: "different case (regex is case-insensitive)",
    markerLine: "DONE_STAMPED_BY: FINALIZE-DONE",
    markedByPredicate: true,
  },
  {
    name: "wrong prefix on the same line",
    markerLine: "xdone_stamped_by: finalize-done",
    markedByPredicate: false,
  },
  { name: "no marker line at all", markerLine: null, markedByPredicate: false },
];

function buildContent(markerLine) {
  const body = `task_id: HYK-1\n\n${DONE_LINE}\n`;
  return markerLine === null ? body : `${body}${markerLine}\n`;
}

test("HYK-426 두 판독 일치 (parity table): hasDoneStampedByMarker(content) agrees with finalizeDone's own already-marked determination for every marker-spacing/case/prefix sample", () => {
  const rows = [];
  for (const sample of SAMPLES) {
    const content = buildContent(sample.markerLine);
    const predicateSaysMarked = hasDoneStampedByMarker(content);
    assert.equal(
      predicateSaysMarked,
      sample.markedByPredicate,
      `sample '${sample.name}': hasDoneStampedByMarker mismatch`,
    );

    withDir((dir) => {
      writeFileSync(
        join(dir, "coder-task.md"),
        "task_id: HYK-1\ndropped_at: 2026-08-19 05:00 KST\n",
        "utf8",
      );
      writeFileSync(join(dir, "coder.md"), content, "utf8");
      const result = finalizeDone({ role: "coder", harnessDir: dir });
      const toolSaysMarked =
        result.reasonCode === FINALIZE_DONE_REASON.ALREADY_FINALIZED;
      const toolSaysUnmarkedReplaceable =
        result.reasonCode === FINALIZE_DONE_REASON.REPLACED_UNMARKED;
      assert.ok(
        toolSaysMarked || toolSaysUnmarkedReplaceable,
        `sample '${sample.name}': finalizeDone gave an unexpected reasonCode '${result.reasonCode}'`,
      );
      assert.equal(
        toolSaysMarked,
        predicateSaysMarked,
        `sample '${sample.name}': finalizeDone's already-marked determination disagrees with hasDoneStampedByMarker`,
      );
      rows.push({
        name: sample.name,
        predicate: predicateSaysMarked,
        tool: toolSaysMarked,
        agree: predicateSaysMarked === toolSaysMarked,
      });
    });
  }
  assert.equal(rows.length, SAMPLES.length);
  assert.ok(
    rows.every((r) => r.agree),
    `parity table had a disagreement: ${JSON.stringify(rows)}`,
  );
  console.log("HYK-426 parity table:", JSON.stringify(rows, null, 2));
});

test("HYK-426: the escape path actually replaces the marker line (not just refuses less) -- a leading-space sample, run through finalizeDone, ends up with a REAL column-0 marker that re-passes the predicate", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-1\ndropped_at: 2026-08-19 05:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      buildContent(" done_stamped_by: finalize-done"),
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_UNMARKED);
    const after = readFileSync(join(dir, "coder.md"), "utf8");
    assert.equal(hasDoneStampedByMarker(after), true);
  });
});
