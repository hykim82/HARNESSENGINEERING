// HYK-271-marker-catalog-1 (2R widen) added "Enter to select" to
// MODAL_MARKERS as a STANDALONE substring to catch the two real selection-
// menu incidents cited below. HYK-271-marker-catalog-3 (2R repair) replaces
// that standalone entry with two mechanisms in dispatch-worker-modal-
// check.mjs: MODAL_TAIL_COMBO (a proximity-combo check) and
// stripSelfCatalogSourceQuotes (strips JS-source-literal quotes of the
// catalog's own strings before matching). Review proved the standalone form
// false-positived on ordinary prose (P1-1); building the required
// self-edit-screen regression sample (ⓒ3 below) additionally surfaced that
// the exact §1 screen also collides via "Allow command?" (an ORIGINAL 1R
// marker, unrelated to "Enter to select") when it appears in JS-literal
// form -- hence the second mechanism. This file measures both against the
// same positive/negative corpora, plus the adversarial false-positive
// samples each mechanism must reject.
//
// This file is deliberately separate from hyk271-axis-preview-marker-
// synthetic.test.mjs. That file's own header draws an explicit honesty line
// ("hand-authored strings ... NOT captured from a live seat ... NOT a
// citation of this repository's own prior incident transcript") -- mixing
// real incident text and real live-seat previews into that file would
// silently erase that line. This file exists precisely because that line no
// longer holds for the two real-incident samples below: they ARE real
// incident transcripts, cited by source.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePreview,
  previewContainsMarker,
} from "./adapters/orca-adapter.mjs";
import {
  MODAL_MARKERS,
  MODAL_TAIL_COMBO,
  previewMatchesTailCombo,
  stripSelfCatalogSourceQuotes,
} from "./dispatch-worker-modal-check.mjs";

// Mirrors runModalCheck's own three-stage check (strip self-catalog source
// quotes, then standalone markers, then the tail combo) without re-deriving
// any of it -- all primitives are imported unmodified. `markers`/`combo`/
// `skipStrip` are overridable for the mutation tests below, same test-seam
// shape as runModalCheck's opts.markers/opts.tailCombo/
// opts.skipSelfCatalogStrip.
function classify(
  preview,
  markers = MODAL_MARKERS,
  combo = MODAL_TAIL_COMBO,
  skipStrip = false,
) {
  const cleaned = skipStrip ? preview : stripSelfCatalogSourceQuotes(preview);
  return (
    markers.some((marker) => previewContainsMarker(cleaned, marker)) ||
    previewMatchesTailCombo(cleaned, combo)
  );
}

// ---------------------------------------------------------------------------
// Positive corpus -- the two real incident samples coder-task.md §1 cites
// (verbatim, not paraphrased). Both must classify MODAL under the combo.
// ---------------------------------------------------------------------------
export const REAL_INCIDENT_SAMPLES = [
  {
    label: "real-incident-A-founding-hyk271-issue-body",
    // Source: HYK-271 issue body, a transcript a human operator read
    // directly off a stuck seat on 2026-08-16 (coder-task.md §1, "양성 표본
    // A -- ★창립 표본"). This is the screen that opened this issue.
    preview:
      "Claude-in-chrome MCP Server\nStatus: connected\n1. View tools\n2. Reconnect\n3. Disable\n↑↓ to navigate · Enter to select · Esc to back",
  },
  {
    label: "real-incident-B-today-hyk415-worker-block",
    // Source: an HYK-415 worker seat, observed stuck for 20 minutes on
    // 2026-09-01 20:0x (coder-task.md §1, "양성 표본 B -- 오늘 표본"). This
    // is the same class of gap recurring in production, on the day the
    // widen round was scoped.
    preview:
      "npm test (전체 러너)가 백그라운드에서 아직 실행 중입니다(8분 타임아웃 초과).\n완료 알림을 기다릴까요, 아니면 지금 상태를 확인할까요?\n❯ 1. 완료 알림 기다리기 (권장)\n  2. 지금 중간 출력 확인\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  },
];

// ---------------------------------------------------------------------------
// Negative corpus -- all 14 live, non-stuck seat previews ORCH measured with
// `orca terminal list --json` on 2026-09-01 22:05 (coder-task.md §3 of the
// widen round), reproduced verbatim (including truncation, redraw noise,
// and mixed encoding). None of these seats were blocked; every one must
// classify NON_MODAL.
// ---------------------------------------------------------------------------
export const LIVE_SEAT_SAMPLES = [
  {
    label: "01-hyk415-canonical-sync-1",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-1>",
  },
  {
    label: "02-hyk415-canonical-sync-review",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-review>",
  },
  {
    label: "03-hyk415-canonical-sync-review-codex-status-bar",
    preview:
      " 86% lef…ng Stop ho•g Stop hoo\n─ Worked for 19m 00s ───────────────────────────────────────────────────────────────────────────────────────────────────  › Ask Codex to do anything   gpt-5.6-luna xhigh · ~\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-review · Context 8% used · 5h 86% lef…",
  },
  {
    label: "04-HARNESSENGINEERING-effecting",
    preview: "✽ Effecting…",
  },
  {
    label: "05-pm-lane-repeated-prompt",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane> PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane> PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane>PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\pm-lane>",
  },
  {
    label: "06-hyk389-send-boundary-1-coder-seat-banner",
    preview:
      "nstalled hooks (C:\\Users\\Administrator\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk389-send-boundary-1  pane=e2edb904-64b2-43ba-a40b-50ebbb6308d7:591d3382-7e00-440f-9776-b4329bf2ddce\n/rc",
  },
  {
    label: "07-hyk394-narrow-1",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk394-narrow-1>",
  },
  {
    label: "08-hyk394-narrow-1-npm-audit-tail",
    preview:
      "run `npm fund` for details\n1 high severity vulnerability\nTo address all issues, run:\nnpm audit fix\nRun `npm audit` for details.\nPS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk394-narrow-1>",
  },
  {
    label: "09-hyk394-narrow-1-coder-seat-banner-plus-clear-prompt",
    preview:
      "trator\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk394-narrow-1  pane=126b44f1-942d-4514-846f-275078864e48:ff58ccf2-766e-4188-b4f2-69d1d24dc06e\nnew task? /clear to save 230.6k tokensBBBB",
  },
  {
    label: "10-hyk412-stuck-retire-1",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-1>",
  },
  {
    label: "11-hyk412-stuck-retire-1-coder-seat-banner-plus-clear-prompt",
    preview:
      "ator\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-1  pane=1cfee20b-56b4-4a9a-b5d3-89ded07b83b5:c71e3b37-1f66-49d9-965e-398c30f2a389\nnew task? /clear to save 220.9k tokens",
  },
  {
    label: "12-hyk412-stuck-retire-review",
    preview:
      "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-review>",
  },
  {
    label: "13-hyk412-stuck-retire-review-codex-status-bar",
    preview:
      "p hookop hook•p hook hookookok\n─ Worked for 21m 32s ───────────────────────────────────────────────────────────────────────────────────────────────────  › Ask Codex to do anything   gpt-5.6-luna xhigh · ~\\orca\\workspaces\\HARNESSENGINEERING\\hyk412-stuck-retire-review · Context 79% used · 5h 90% left…",
  },
  {
    label:
      "14-hyk415-canonical-sync-1-coder-seat-banner-plus-clear-prompt (WARNING: contains '[CODER seat]' delivery banner -- if a marker matched this, every delivery would self-block)",
    preview:
      "or\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-1  pane=fdf2c90b-df3d-4750-ab1c-37ced862e214:0ea3f96c-103a-41fe-b612-f9dd64c077d0\nnew task? /clear to save 417.2k tokens",
  },
];

// ---------------------------------------------------------------------------
// New false-positive corpus (HYK-271-marker-catalog-3, review P1-1 + the §1
// self-edit observation). All three must classify NON_MODAL.
// ---------------------------------------------------------------------------
export const FALSE_POSITIVE_SAMPLES = [
  {
    label: "false-positive-ordinary-menu-prose",
    // A normal explanatory sentence about keyboard shortcuts -- exactly the
    // shape review P1-1 flagged the standalone "Enter to select" substring
    // as blocking. "Enter to select" and "to navigate" both appear, but far
    // apart (well beyond MODAL_TAIL_COMBO.maxGapChars=15), unlike a
    // rendered hint bar where they sit right next to each other.
    preview:
      "To use this interactive menu, press Enter to select the highlighted item. You can also use the arrow keys to navigate between the available options, or press Escape at any time to cancel.",
  },
  {
    label: "false-positive-ordinary-documentation-prose",
    // A README/help-doc style paragraph mentioning the phrase in passing,
    // not rendering an actual hint bar.
    preview:
      "## Keyboard shortcuts\n\nMost of this tool's interactive prompts follow the same convention: hit Enter to select whatever option is currently highlighted. Full documentation for all supported keybindings lives in docs/keybindings.md.",
  },
  {
    label: "false-positive-self-edit-screen (coder-task.md §1 exact quote)",
    // Source: coder-task.md §1 -- ORCH's direct observation of the CODER
    // seat's own screen while it was mid-diff editing MODAL_MARKERS in the
    // 2R widen round. This is the incident that forced this repair: a
    // marker that blocks the seat editing its own source is self-defeating.
    preview:
      '      237      "Allow command?",\n      238 +    "Enter to select",\n      239    ]);',
  },
];

// WHAT SHOULD TURN RED: if the combo stops matching either real incident
// sample (e.g. maxGapChars shrinks below the measured gap, or the primary/
// companion text drifts), this test turns red.
test("MODAL_TAIL_COMBO: both real incident samples (founding + today) classify MODAL", () => {
  const mismatches = REAL_INCIDENT_SAMPLES.filter((s) => !classify(s.preview));
  assert.deepEqual(
    mismatches.map((s) => s.label),
    [],
    `expected every real incident sample to classify MODAL, but these did not: ${JSON.stringify(mismatches.map((s) => s.label))}`,
  );
});

// WHAT SHOULD TURN RED: if a future change to the combo ever makes any of
// these 14 real, non-stuck live-seat previews classify MODAL, this test
// turns red (that would mean every delivery to that seat now
// false-positives).
test("MODAL_TAIL_COMBO: all 14 real live-seat previews (none blocked) classify NON_MODAL -- measured false positives, not asserted", () => {
  const falsePositives = LIVE_SEAT_SAMPLES.filter((s) => classify(s.preview));
  assert.deepEqual(
    falsePositives.map((s) => s.label),
    [],
    `expected zero false positives on the live-seat corpus, but these matched: ${JSON.stringify(falsePositives.map((s) => s.label))}`,
  );
});

// WHAT SHOULD TURN RED: this is the regression review P1-1 forced -- if the
// combo's proximity constraint is ever loosened back toward a standalone
// substring match, one or more of these three turns MODAL again.
test("MODAL_TAIL_COMBO: ordinary prose, documentation, and this file's own past self-edit screen all classify NON_MODAL (the false positives review P1-1 proved)", () => {
  const falsePositives = FALSE_POSITIVE_SAMPLES.filter((s) =>
    classify(s.preview),
  );
  assert.deepEqual(
    falsePositives.map((s) => s.label),
    [],
    `expected zero false positives on the adversarial corpus, but these matched: ${JSON.stringify(falsePositives.map((s) => s.label))}`,
  );
});

// ---------------------------------------------------------------------------
// Reversal mutation ⓐ (coder-task.md §2⑵ⓓ, "ⓒ가 다시 MODAL로 새는지"):
// simulate the OLD HYK-271-marker-catalog-2 (2R widen) rule -- "Enter to
// select" as a STANDALONE marker (presence anywhere, no proximity to a
// companion required) -- by adding it back to the markers list passed to
// classify(), and confirm the two prose/documentation false-positive
// samples leak back to MODAL. The self-edit-screen sample is deliberately
// excluded from this specific mutation's expectation: its false positive
// came from a DIFFERENT, unrelated marker ("Allow command?", see mutation
// ⓒ below), and the self-catalog-quote strip step still removes that
// marker's literal text here regardless of this mutation -- proving the two
// fixes are independent, not that this mutation failed to reproduce
// anything.
// ---------------------------------------------------------------------------
test("mutation ⓐ (되돌림 변이, regression reproduction): reverting 'Enter to select' to a standalone marker (old 2R-widen rule) makes the prose/documentation false positives MODAL again", () => {
  const oldStandaloneMarkers = [...MODAL_MARKERS, MODAL_TAIL_COMBO.primary];

  const withFix = FALSE_POSITIVE_SAMPLES.map((s) => classify(s.preview));
  assert.deepEqual(
    withFix,
    [false, false, false],
    "sanity: unmutated catalog must classify all three false-positive samples NON_MODAL",
  );

  const withoutFix = FALSE_POSITIVE_SAMPLES.map((s) =>
    classify(s.preview, oldStandaloneMarkers),
  );
  assert.deepEqual(
    withoutFix,
    [true, true, false],
    "reverting to a standalone 'Enter to select' marker must reproduce the 2R-widen false positive on the prose/documentation samples (the self-edit-screen sample stays NON_MODAL here because its cause -- 'Allow command?' quoted in source form -- is a separate mechanism, see mutation ⓒ)",
  );
});

// ---------------------------------------------------------------------------
// Reversal mutation ⓒ (coder-task.md §2⑵ⓓ, other half of "ⓒ가 다시 MODAL로
// 새는지"): disable the self-catalog-quote strip (opts.skipSelfCatalogStrip
// in runModalCheck, skipStrip here) and confirm the self-edit-screen sample
// leaks back to MODAL via "Allow command?" -- proving the strip step, not
// the combo, is what fixes that specific sample.
// ---------------------------------------------------------------------------
test("mutation ⓒ (되돌림 변이): disabling the self-catalog-quote strip makes the self-edit-screen sample MODAL again (via the unrelated pre-existing 'Allow command?' marker)", () => {
  const selfEditSample = FALSE_POSITIVE_SAMPLES.find((s) =>
    s.label.startsWith("false-positive-self-edit-screen"),
  );
  assert.ok(selfEditSample, "expected the self-edit-screen sample to exist");

  const withStrip = classify(selfEditSample.preview);
  assert.equal(
    withStrip,
    false,
    "sanity: unmutated (strip applied) must classify the self-edit-screen sample NON_MODAL",
  );

  const withoutStrip = classify(
    selfEditSample.preview,
    MODAL_MARKERS,
    MODAL_TAIL_COMBO,
    /* skipStrip */ true,
  );
  assert.equal(
    withoutStrip,
    true,
    "disabling the strip must reproduce the self-edit-screen false positive via the unrelated 'Allow command?' marker",
  );
});

// ---------------------------------------------------------------------------
// Reversal mutation ⓑ (coder-task.md §2⑵ⓓ, "ⓐ가 NON_MODAL로 새는지"):
// disable the tail combo entirely and confirm both real incident samples
// leak back to NON_MODAL. This proves the combo, not something else (e.g.
// one of the original 4 MODAL_MARKERS), is what catches them. This never
// edits the source file -- MODAL_TAIL_COMBO is asserted byte-identical
// before and after.
// ---------------------------------------------------------------------------
test("mutation ⓑ (되돌림 변이): disabling MODAL_TAIL_COMBO entirely lets BOTH real incident samples leak back to NON_MODAL -- proves the combo, not the original 4 markers, is what catches them", () => {
  const before = JSON.stringify(MODAL_TAIL_COMBO);

  const withCombo = REAL_INCIDENT_SAMPLES.map((s) => classify(s.preview));
  assert.deepEqual(
    withCombo,
    [true, true],
    "sanity: unmutated combo must classify both real incident samples MODAL",
  );

  const withoutCombo = REAL_INCIDENT_SAMPLES.map((s) =>
    classify(s.preview, MODAL_MARKERS, null),
  );
  assert.deepEqual(
    withoutCombo,
    [false, false],
    "disabling the tail combo must let both real incident samples leak back to NON_MODAL",
  );

  // byte-identical restoration check: this test never mutated the source
  // module's export, only passed a local override -- confirm that holds.
  assert.equal(
    JSON.stringify(MODAL_TAIL_COMBO),
    before,
    "MODAL_TAIL_COMBO must be byte-identical to what it was before this test ran",
  );
});

// Sanity check on normalizePreview against the two real samples specifically
// (both contain non-ASCII middle-dot separators and Korean text around the
// marker -- confirm whitespace normalization doesn't need to touch them for
// the marker match to work).
test("sanity: 'Enter to select' appears verbatim in both real incident samples even before normalization", () => {
  for (const s of REAL_INCIDENT_SAMPLES) {
    assert.ok(
      s.preview.includes("Enter to select"),
      `expected raw preview for "${s.label}" to already contain 'Enter to select' verbatim`,
    );
    assert.ok(
      normalizePreview(s.preview).includes("Enter to select"),
      `expected normalized preview for "${s.label}" to contain 'Enter to select'`,
    );
  }
});
