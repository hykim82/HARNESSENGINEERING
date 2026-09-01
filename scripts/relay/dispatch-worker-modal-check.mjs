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
//
// HYK-271-marker-catalog-1 (2R widen): the four markers above are all
// command-approval-modal text and measurably miss the screen that actually
// opened this issue -- a numbered SELECTION MENU (claude-in-chrome tool
// menu / npm-test-background-wait menu), which never renders any of them.
// "Enter to select" is added below because it is the one substring both
// real incident samples share on their tail line, and it is measured
// (scripts/relay/hyk271-marker-catalog-real-corpus.test.mjs) against 14
// real live-seat previews with zero false positives. Broader candidates
// ("to navigate", "Esc to cancel"/"Esc to back", "❯") were considered and
// rejected -- see that file's header comment for why.
export const MODAL_MARKERS = Object.freeze([
  "Do you want to proceed?",
  "Yes, and don't ask again",
  "No, and tell Claude what to do differently",
  "Allow command?",
  "Enter to select",
]);

import { readFileSync } from "node:fs";
import {
  parseSeatPreview,
  previewContainsMarker,
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

  const markers = Array.isArray(opts.markers) ? opts.markers : MODAL_MARKERS;
  const matched = markers.find((marker) =>
    previewContainsMarker(preview, marker),
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
