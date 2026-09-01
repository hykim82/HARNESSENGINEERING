// HYK-271-wire-1 (coder-task.md §2⑴) -- sidecar modal-preflight checker.
//
// Design doc (정본, 이 파일보다 상세): docs/control-room-patches/HYK-271-preflight-preview-marker.md §2-a.
// The axis itself was already chosen and merged (PR #237) -- this file wires
// it into a callable gate, it does not re-derive the axis.
//
// Input: `--terminal-show <path>` -- the file the delivery pipeline has
// ALREADY captured ($tsShowPath in dispatch-worker.ps1). This file makes
// ZERO `orca` calls of its own (it never imports orca-spike-runner.mjs) --
// coder-task.md §2⑴ "추가 orca 조회 0".
//
// Detection logic (parseSeatPreview/normalizePreview/previewContainsMarker)
// is imported unmodified from orca-adapter.mjs -- 재구현 금지
// (coder-task.md §2⑴, design doc §2-a "재사용, 재구현 안 함").
//
// MODAL_MARKERS lives here (this is the one production module that owns
// it) -- hyk271-axis-preview-marker-synthetic.test.mjs (the 1R proof that
// measured this catalog against synthetic samples, PR #237) imports it back
// from here rather than each file keeping its own copy, so the marker text
// itself has exactly one source (design doc §1-b: the catalog is a
// hand-authored, unverified-against-real-modals literal list -- carrying it
// in two places would risk them silently drifting apart).
export const MODAL_MARKERS = Object.freeze([
  "Do you want to proceed?",
  "Yes, and don't ask again",
  "No, and tell Claude what to do differently",
  "Allow command?",
]);

// HYK-271-marker-catalog-3 (2R repair): HYK-271-marker-catalog-2 (2R widen)
// added "Enter to select" to MODAL_MARKERS above as a STANDALONE substring
// to catch the selection-menu screens that opened this issue (a numbered
// claude-in-chrome tool menu / an npm-test-background-wait menu). Review
// proved that standalone substring is a false-positive: it fires on
// ordinary prose that merely discusses menu usage (review P1-1), and --
// worse, ORCH directly observed it firing on THIS FILE'S OWN diff while a
// seat was editing it (coder-task.md §1: the line `"Enter to select",`
// alone, mid-diff, with no companion text) -- a marker that blocks the seat
// editing its own source is self-defeating.
//
// Fix: "Enter to select" is no longer sufficient alone. Both real incident
// tail lines render it PROXIMATE to one of a small set of companion hint
// fragments ("to navigate" / "Esc to cancel" / "Esc to back"), separated by
// a middle-dot " · " and/or arrow glyphs -- a rendering convention ordinary
// prose does not reproduce compactly. Measured gap between "Enter to
// select" and the nearest companion, after normalizePreview (only \s+
// collapsed, "·"/arrows survive): founding sample = 3 chars either
// direction; today's sample = 7 chars to "to navigate" (21 chars to "Esc to
// cancel", not relied on). MODAL_TAIL_COMBO.maxGapChars=15 comfortably
// covers both measured cases while staying far tighter than a written
// sentence that mentions two hint names ("press Enter to select, and use
// the arrow keys to navigate between options" -- gap far exceeds 15).
//
// Residual risk (documented, not hidden -- coder-task.md §3-4): a document
// that quotes a real tail line VERBATIM, with its original " · " spacing,
// still matches -- this fix narrows the false-positive surface, it does
// not eliminate every way to construct one. See
// scripts/relay/hyk271-marker-catalog-real-corpus.test.mjs for the measured
// false-positive samples (ordinary prose, documentation, and this file's
// own diff) this fix was built against.
export const MODAL_TAIL_COMBO = Object.freeze({
  primary: "Enter to select",
  companions: Object.freeze(["to navigate", "Esc to cancel", "Esc to back"]),
  maxGapChars: 15,
});

// Only the FIRST occurrence of `primary` and each companion is checked
// (indexOf, not a global scan) -- a deliberate simplification, not a
// re-derivation of the axis: neither real incident sample repeats either
// phrase, so this is sufficient for what this round measured. A preview
// with multiple copies of these phrases at different distances is outside
// this round's measured scope.
export function previewMatchesTailCombo(preview, combo) {
  if (!combo) return false;
  const normalized = normalizePreview(preview);
  const primaryIndex = normalized.indexOf(combo.primary);
  if (primaryIndex === -1) return false;
  const primaryEnd = primaryIndex + combo.primary.length;
  return combo.companions.some((companion) => {
    const companionIndex = normalized.indexOf(companion);
    if (companionIndex === -1) return false;
    const companionEnd = companionIndex + companion.length;
    const gap =
      companionIndex >= primaryEnd
        ? companionIndex - primaryEnd
        : primaryIndex - companionEnd;
    return gap >= 0 && gap <= combo.maxGapChars;
  });
}

// HYK-271-marker-catalog-3 (2R repair, found while building the ⓒ3
// self-edit-screen regression sample required by coder-task.md §2⑵): the
// self-blocking risk in coder-task.md §1 is not unique to "Enter to
// select". The exact screen §1 quotes --
//   `      237      "Allow command?",`
//   `      238 +    "Enter to select",`
// -- also contains `"Allow command?",`, one of the ORIGINAL four 1R
// markers, as unchanged diff context. A real rendered modal never wraps its
// own prompt text in an escaped double-quote immediately followed by a
// comma -- that exact shape is JS array-literal syntax, i.e. THIS FILE's
// own source (or a diff of it). So: before matching anything, strip every
// exact `"<catalog literal>",` occurrence, for every string this catalog
// currently owns (both MODAL_MARKERS and the tail combo's primary/
// companions), so a source-code quote of the catalog can never be mistaken
// for the catalog's own target text. This generalizes the §1 fix to all
// current and future catalog entries, not just "Enter to select" -- the
// same class of self-edit collision would otherwise resurface the next
// time any marker is added or edited here.
//
// Residual risk (documented, not hidden -- coder-task.md §3-4): this only
// strips the EXACT `"<literal>",` shape (double-quote, then the literal
// text unchanged, then a comma) -- a diff/editor rendering the same literal
// with single quotes, backticks, a different trailing character (e.g. the
// array's closing entry, which has no trailing comma), or with the literal
// text itself edited mid-keystroke, would not be stripped and could still
// self-block. This narrows the specific collision §1 observed; it does not
// make every rendering of this file's own source immune.
const SELF_CATALOG_LITERALS = [
  ...MODAL_MARKERS,
  MODAL_TAIL_COMBO.primary,
  ...MODAL_TAIL_COMBO.companions,
];
function escapeRegExpLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function stripSelfCatalogSourceQuotes(preview) {
  if (typeof preview !== "string") return preview;
  return SELF_CATALOG_LITERALS.reduce((text, literal) => {
    const pattern = new RegExp(`"${escapeRegExpLiteral(literal)}",`, "g");
    return text.replace(pattern, "");
  }, preview);
}

import { readFileSync } from "node:fs";
import {
  parseSeatPreview,
  previewContainsMarker,
  normalizePreview,
} from "./adapters/orca-adapter.mjs";

// 이 검사기는 modal/non-modal 2분류만 반환한다(design doc §2-a "modal/
// non-modal 2분류만 반환"). VERDICT.MODAL is also what a missing/unreadable
// file folds into (fail-closed) -- there is no third "undecidable" verdict.
export const VERDICT = Object.freeze({
  MODAL: "MODAL",
  NON_MODAL: "NON_MODAL",
});

export const CHECK_REASON = Object.freeze({
  ARGS_MISSING: "MODAL_CHECK_ARGS_MISSING",
  ARGS_UNRECOGNIZED: "MODAL_CHECK_ARGS_UNRECOGNIZED",
  FILE_UNREADABLE: "MODAL_CHECK_FILE_UNREADABLE",
  MARKER_MATCH: "MODAL_CHECK_MARKER_MATCH",
  CLEAN: "MODAL_CHECK_CLEAN",
});

// argv 파싱만(순수 함수) -- dispatch-worker-seat-proof-gate.mjs의
// parseGateArgs와 동일한 모양.
export function parseCheckArgs(argv) {
  const rest = Array.isArray(argv) ? argv.slice() : [];
  let terminalShowPath = null;
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag !== "--terminal-show") {
      return {
        ok: false,
        reasonCode: CHECK_REASON.ARGS_UNRECOGNIZED,
        detail: `unrecognized argument '${flag}'`,
      };
    }
    const value = rest.shift();
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        reasonCode: CHECK_REASON.ARGS_MISSING,
        detail: "'--terminal-show' requires a value",
      };
    }
    terminalShowPath = value;
  }
  if (terminalShowPath === null) {
    return {
      ok: false,
      reasonCode: CHECK_REASON.ARGS_MISSING,
      detail: "missing required argument '--terminal-show'",
    };
  }
  return { ok: true, terminalShowPath };
}

// 파일 읽기 -> JSON 파싱 -> parseSeatPreview(재사용, 재구현 아님)까지만
// 담당(복잡도 분산). 세 실패(파일 없음/읽기 실패/파싱 실패/모양이 안
// 맞음) 전부 같은 null로 접는다 -- 호출자가 이걸 "새 분기"로 쪼개지
// 않도록(coder-task.md §2⑴ "새 분기를 만들지 마라").
function readPreviewOrNull(terminalShowPath, opts) {
  const readFileFn =
    typeof opts.readFileFn === "function"
      ? opts.readFileFn
      : (p) => readFileSync(p, "utf8");
  let raw;
  try {
    raw = readFileFn(terminalShowPath);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseSeatPreview(parsed);
}

// ctx: argv. opts: { readFileFn, markers }. opts.markers is a TEST SEAM ONLY
// (default MODAL_MARKERS) -- production callers never pass it; it exists so
// a test can prove marker-matching is load-bearing by neutralizing the
// catalog and observing a modal sample stop being rejected (되돌림 변이,
// coder-task.md §2⑵ⓓ). Passing it does not add a new exit code or branch --
// the two-way MODAL/NON_MODAL split and the 0/2 exit codes are unchanged
// either way.
export function runModalCheck(argv, opts = {}) {
  const parsedArgs = parseCheckArgs(argv);
  if (!parsedArgs.ok) {
    return {
      ok: false,
      exitCode: 2,
      verdict: VERDICT.MODAL,
      reasonCode: parsedArgs.reasonCode,
      detail: parsedArgs.detail,
    };
  }

  const preview = readPreviewOrNull(parsedArgs.terminalShowPath, opts);
  if (preview === null) {
    return {
      ok: false,
      exitCode: 2,
      verdict: VERDICT.MODAL,
      reasonCode: CHECK_REASON.FILE_UNREADABLE,
      detail: `dispatch-worker-modal-check: '${parsedArgs.terminalShowPath}' is missing, unreadable, or does not carry a usable terminal.preview (fail-closed)`,
    };
  }

  // opts.skipSelfCatalogStrip is a TEST SEAM ONLY (default: strip applied)
  // -- lets the ⓐ mutation test reproduce the self-edit-screen false
  // positive by disabling this step, same pattern as opts.markers/
  // opts.tailCombo below.
  const cleanedPreview = opts.skipSelfCatalogStrip
    ? preview
    : stripSelfCatalogSourceQuotes(preview);

  const markers = Array.isArray(opts.markers) ? opts.markers : MODAL_MARKERS;
  const matched = markers.find((marker) =>
    previewContainsMarker(cleanedPreview, marker),
  );
  if (matched) {
    return {
      ok: false,
      exitCode: 2,
      verdict: VERDICT.MODAL,
      reasonCode: CHECK_REASON.MARKER_MATCH,
      detail: matched,
    };
  }

  // opts.tailCombo is a TEST SEAM ONLY (default MODAL_TAIL_COMBO) -- same
  // reason as opts.markers above (되돌림 변이, coder-task.md §2⑵ⓓ). Passing
  // `null` disables the combo check entirely without adding a new branch or
  // exit code.
  const tailCombo = "tailCombo" in opts ? opts.tailCombo : MODAL_TAIL_COMBO;
  if (previewMatchesTailCombo(cleanedPreview, tailCombo)) {
    return {
      ok: false,
      exitCode: 2,
      verdict: VERDICT.MODAL,
      reasonCode: CHECK_REASON.MARKER_MATCH,
      detail: `${tailCombo.primary} (tail combo)`,
    };
  }

  return {
    ok: true,
    exitCode: 0,
    verdict: VERDICT.NON_MODAL,
    reasonCode: CHECK_REASON.CLEAN,
    detail: null,
  };
}

export function formatModalCheckResult(result) {
  if (result.verdict === VERDICT.MODAL) {
    return `dispatch-worker-modal-check: MODAL (${result.reasonCode}) -- ${result.detail}`;
  }
  return "dispatch-worker-modal-check: NON_MODAL -- preview shows no MODAL_MARKERS match.";
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/dispatch-worker-modal-check.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const result = runModalCheck(argv);
  if (result.verdict === VERDICT.MODAL) {
    process.stderr.write(formatModalCheckResult(result) + "\n");
  } else {
    console.log(formatModalCheckResult(result));
  }
  process.exit(result.exitCode);
}
