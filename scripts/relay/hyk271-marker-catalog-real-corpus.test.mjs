// HYK-271-marker-catalog-1 (2R widen): proof that the widened MODAL_MARKERS
// catalog (dispatch-worker-modal-check.mjs) closes the gap that opened this
// issue -- the 1R catalog (4 command-approval markers) measurably let both
// real incident samples below through as NON_MODAL, because neither is a
// command-approval modal; both are numbered SELECTION MENUS.
//
// This file is deliberately separate from hyk271-axis-preview-marker-
// synthetic.test.mjs. That file's own header draws an explicit honesty line
// ("hand-authored strings ... NOT captured from a live seat ... NOT a
// citation of this repository's own prior incident transcript") -- mixing
// real incident text and real live-seat previews into that file would
// silently erase that line. This file exists precisely because that line no
// longer holds for the two samples below: they ARE real incident
// transcripts, cited by source.
//
// Marker choice and why narrower candidates were rejected (coder-task.md §2
// ⑴ "표지 선택은 네가 정하고 근거를 대라"):
//   - "Enter to select" is the one substring present, verbatim, on the tail
//     line of BOTH real incident samples (A and B below) -- see each
//     sample's citation for the exact source line.
//   - "❯" was rejected: it is also how Claude Code renders its OWN input
//     prompt (coder-task.md §2⑴ ORCH observation, 2026-09-01 22:01 seat
//     render), so using it as a marker risks blocking a normal, non-modal
//     seat. Not measured further here because the risk is structural, not
//     something a false-positive count would catch (a normal seat's prompt
//     line is exactly the failure mode, and this corpus's 14 live previews
//     happen not to include one -- that would prove nothing either way).
//   - "to navigate" was rejected without measurement: it is prose-shaped
//     enough that an adversarial non-modal sample (e.g. text instructing a
//     user how to navigate a menu) could plausibly contain it, and it adds
//     no coverage beyond "Enter to select" for the two samples this round
//     must catch (both already match on "Enter to select" alone).
//   - "Esc to cancel" / "Esc to back" were rejected as redundant: both are
//     already implied whenever "Enter to select" fires on these two
//     samples' menu tail lines, so adding them widens surface area (more
//     substrings that could someday false-positive) without closing any
//     additional gap this round's completion criteria require.
// A single, narrowly-justified marker keeps the catalog's total
// false-positive surface as small as the completion criteria allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePreview,
  previewContainsMarker,
} from "./adapters/orca-adapter.mjs";
import { MODAL_MARKERS } from "./dispatch-worker-modal-check.mjs";

function classify(preview, markers = MODAL_MARKERS) {
  return markers.some((marker) => previewContainsMarker(preview, marker));
}

// ---------------------------------------------------------------------------
// Positive corpus -- the two real incident samples coder-task.md §1 cites
// (verbatim, not paraphrased). Both must classify MODAL under the widened
// catalog.
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
    // is the same class of gap recurring in production, on the day this
    // round was scoped.
    preview:
      "npm test (전체 러너)가 백그라운드에서 아직 실행 중입니다(8분 타임아웃 초과).\n완료 알림을 기다릴까요, 아니면 지금 상태를 확인할까요?\n❯ 1. 완료 알림 기다리기 (권장)\n  2. 지금 중간 출력 확인\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  },
];

// ---------------------------------------------------------------------------
// Negative corpus -- all 14 live, non-stuck seat previews ORCH measured with
// `orca terminal list --json` on 2026-09-01 22:05 (coder-task.md §3),
// reproduced verbatim (including truncation, redraw noise, and mixed
// encoding -- coder-task.md §3 "요약·정리 금지, 재그림 잡음과 잘린 앞머리가
// 이 표본의 값이다"). None of these seats were blocked; every one must
// classify NON_MODAL under the widened catalog.
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
      "14-hyk415-canonical-sync-1-coder-seat-banner-plus-clear-prompt (WARNING: contains '[CODER seat]' delivery banner, see coder-task.md §3 -- if a marker matched this, every delivery would self-block)",
    preview:
      "or\\Documents\\HARNESSENGINEERING\\.git\\hooks) match versioned hooks/. 좌석 기동 가능.\n[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk415-canonical-sync-1  pane=fdf2c90b-df3d-4750-ab1c-37ced862e214:0ea3f96c-103a-41fe-b612-f9dd64c077d0\nnew task? /clear to save 417.2k tokens",
  },
];

// WHAT SHOULD TURN RED: if the widened catalog stops matching either real
// incident sample (e.g. someone edits "Enter to select" out of
// MODAL_MARKERS, or its text drifts), this test turns red.
test("widened MODAL_MARKERS: both real incident samples (founding + today) classify MODAL", () => {
  const mismatches = REAL_INCIDENT_SAMPLES.filter((s) => !classify(s.preview));
  assert.deepEqual(
    mismatches.map((s) => s.label),
    [],
    `expected every real incident sample to classify MODAL, but these did not: ${JSON.stringify(mismatches.map((s) => s.label))}`,
  );
});

// WHAT SHOULD TURN RED: if a future marker addition ever makes any of these
// 14 real, non-stuck live-seat previews classify MODAL, this test turns red
// (that would mean every delivery to that seat now false-positives).
test("widened MODAL_MARKERS: all 14 real live-seat previews (none blocked) classify NON_MODAL -- measured false positives, not asserted", () => {
  const falsePositives = LIVE_SEAT_SAMPLES.filter((s) => classify(s.preview));
  assert.deepEqual(
    falsePositives.map((s) => s.label),
    [],
    `expected zero false positives on the live-seat corpus, but these matched: ${JSON.stringify(falsePositives.map((s) => s.label))}`,
  );
});

// ---------------------------------------------------------------------------
// Reversal mutation (coder-task.md §2⑶): prove "Enter to select" is
// load-bearing for BOTH real incident samples by removing only that entry
// (via the opts.markers test seam -- same pattern as
// dispatch-worker-modal-check.test.mjs's existing ⓓ mutation test) and
// confirming both samples leak back to NON_MODAL. This never edits the
// source file, so there is nothing to restore -- MODAL_MARKERS itself is
// asserted unchanged before and after.
// ---------------------------------------------------------------------------
test("mutation (되돌림 변이): removing 'Enter to select' from the catalog lets BOTH real incident samples leak back to NON_MODAL -- proves the new marker, not something else, is what catches them", () => {
  const before = MODAL_MARKERS.slice();

  const withCatalog = REAL_INCIDENT_SAMPLES.map((s) => classify(s.preview));
  assert.deepEqual(
    withCatalog,
    [true, true],
    "sanity: unmutated catalog must classify both real incident samples MODAL",
  );

  const withoutNewMarker = MODAL_MARKERS.filter((m) => m !== "Enter to select");
  assert.equal(
    withoutNewMarker.length,
    MODAL_MARKERS.length - 1,
    "sanity: the filter must remove exactly one entry",
  );
  const withoutMarker = REAL_INCIDENT_SAMPLES.map((s) =>
    classify(s.preview, withoutNewMarker),
  );
  assert.deepEqual(
    withoutMarker,
    [false, false],
    "removing 'Enter to select' must let both real incident samples leak back to NON_MODAL",
  );

  // byte-identical restoration check: this test never mutated the source
  // module's export, only a local filtered copy -- confirm that holds.
  assert.deepEqual(
    MODAL_MARKERS.slice(),
    before,
    "MODAL_MARKERS must be byte-identical to what it was before this test ran",
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
