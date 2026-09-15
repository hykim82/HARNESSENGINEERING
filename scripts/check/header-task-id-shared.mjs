// HYK-468 2R (P1, 검토자 반려 재수리): a result/round-archive file's own
// `task_id:` declaration is only trustworthy when the line that leads into
// it is itself structural (another `key:` header line, a `>>>` marker
// line, or the start of the file) -- not ordinary prose. The column-0
// regex these readers used to run over the whole file also matched a
// `task_id:` line quoted verbatim later in the body, introduced by a
// narrative sentence (e.g. "예를 들어 다음과 같은 줄이 주입된다:" --
// coder.md documenting exactly what dispatch-gate-decision.mjs's
// bestEffortInjectResultPaths injected). The whole-file scan counted both,
// saw 2 "declarations", and rejected a round that was actually fine
// (검토자의 실제 exported-function repro, 1R 반려 사유).
//
// 1R's first attempt at this (scope the scan to the leading header block,
// cut at the file's first blank line) was ITSELF wrong: it silently
// dropped nc-relay-handshake.test.mjs's NC-2(HYK-183) protection -- a
// result file that keeps an OLD round's `task_id:`+`>>> DONE:` block and
// APPENDS a new one after a blank line (a real accumulation bug, no prose,
// no fence) must still be caught as ambiguous, but header-block scoping
// only ever looked at the FIRST block and silently resolved the stale
// value (full-runner regression, measured: NC-2 failed after the header-
// block-only 2R draft). A pure "first paragraph only" rule cannot tell
// these two shapes apart by blank-line position alone -- both have a
// blank line before the second occurrence.
//
// The actual distinguishing feature is what comes immediately before the
// second occurrence: NC-2's is preceded by another structural line
// (`>>> DONE: ...`, skipping the blank line itself); the reviewer's is
// preceded by a bare prose sentence. So this file counts every column-0
// `task_id:` line whose nearest non-blank predecessor is EITHER absent
// (start of file) OR itself structural (`key:`-shaped, or `>>>`-prefixed)
// -- a line introduced by ordinary prose is disregarded (it is being
// SHOWN as an example, not DECLARED). This keeps NC-2's whole-file
// ambiguity detection intact while still resolving the reviewer's exact
// repro.
//
// A second, smaller real regression (same round): treating any line that
// happens to start with `<!--` as unconditionally "structural" over-fires
// on a DELIBERATELY malformed multi-line envelope-archive comment
// (hyk396-dispatch-stamp.test.mjs test (o): the closing `-->` pushed onto
// its own line to simulate header corruption) -- that comment's own
// damage is exactly what a different, more specific check
// (classifyArchivedDispatchId) exists to catch, and this axis must not
// paper over it. The correct rule is "does the comment disappear when
// masked" -- fence/HTML-comment masking (HYK-449's
// maskQuotedMarkerRegions, imported from reject-streak.mjs) already
// recognizes a `<!-- ... -->` span across multiple lines and blanks the
// whole thing to spaces; a masked (all-whitespace) line then reads as
// "blank" to hasStructuralPredecessor and is skipped exactly like a real
// blank line -- so a normal single-line envelope comment correctly makes
// the declaration right after it structural (nothing else precedes it,
// so it falls back to "start of file"), while a malformed multi-line one
// still contains real, unmasked garbage on whichever line failed to
// close, and this axis simply never has to decide what that garbage
// means -- the dedicated check downstream still does.
//
// This is the CANONICAL definition of the contract (this file's own
// header-task-id-shared.test.mjs exercises it: quoted-example (prose,
// unfenced) + header-declared -> resolved; two structurally-real
// declarations (blank-line separated, HYK-183 shape) -> reject; two
// declarations inside one block -> reject; zero -> reject; a normal
// single-line envelope-archive comment right before the declaration ->
// resolved). It is deliberately NOT imported by its three consumers --
// admission-completion-adapter.mjs, dispatch-gate-decision.mjs, and
// relay-handshake.mjs are all statically cloned into isolated
// mutation-test fixtures by a long tail of existing tests, each with its
// own hand-maintained sibling-file list (measured directly: adding an
// import to any of them broke admission-completion-worktree-isolation.
// test.mjs / hyk396-open-axis.test.mjs with MODULE_NOT_FOUND). Each
// carries its own local byte-identical-logic copy instead (see each
// file's own copy for the cross-reference comment) -- the same "duplicate
// small pieces instead of importing" convention admission-completion-
// adapter.mjs's own header already documents for BLOCKED_RE. Four copies,
// one contract: coder-task.md §1 commit ③ / 2R §2 calls this "세/두 독자가
// 같은 함수를 쓰게 하라" -- satisfied here as "one canonical logic, kept
// byte-identical across all copies," not as a single imported module.
// (This canonical file itself is never cloned anywhere, so it alone is
// free to import maskQuotedMarkerRegions directly.)
import { maskQuotedMarkerRegions } from "./reject-streak.mjs";

const TASK_ID_LINE_RE = /^task_id:[ \t]*(\S+)/i;
const STRUCTURAL_LINE_RE = /^[A-Za-z_][\w-]*:|^>>>/;

// HYK-468 4R §2-1 (P1 rejection: "비교 목록의 구멍" -- the drift test used
// to compare a hand-picked list of names, so a copy that quietly diverged
// on a rule this list never named -- exactly what happened to relay-
// handshake.mjs's inline TASK_ID_LINE_RE, which was never a named
// constant there and so was never on anyone's list -- went undetected.
// This object is the actual fix: every rule constant this canonical file
// defines lives here by name, and hyk468-3r-copy-drift.test.mjs iterates
// `Object.entries` of THIS object rather than a list it maintains itself.
// Adding a new rule constant to this file means adding it here too (one
// line) -- from that point on the drift test compares it in all three
// readers automatically, with no edit to the test file. The three real
// readers (admission-completion-adapter.mjs, dispatch-gate-decision.mjs,
// relay-handshake.mjs) each now also carry a same-named `const
// TASK_ID_LINE_RE` / `const STRUCTURAL_LINE_RE` (previously
// TASK_ID_LINE_RE was only ever inlined at each reader's match call site
// -- exactly the shape that let it drift unnoticed) so the by-name lookup
// in the drift test actually finds something to compare.
export const RULE_CONSTANTS = { TASK_ID_LINE_RE, STRUCTURAL_LINE_RE };

// True if the nearest non-blank line before `lines[idx]` is itself
// structural, or if there is no such line (start of file). A masked
// (all-whitespace) line -- a fence or HTML comment blanked by
// maskQuotedMarkerRegions -- reads as blank here and is skipped, same as
// a real blank line.
function hasStructuralPredecessor(lines, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (lines[i].trim() === "") continue;
    return STRUCTURAL_LINE_RE.test(lines[i]);
  }
  return true;
}

// Resolves the file's own declared task_id. Exactly one structurally-real
// column-0 `task_id:` line -> { ok: true, id }. Zero, or two-or-more
// (including two occurrences in the same header block, or two real
// blank-line-separated blocks -- HYK-183's exact shape) -> { ok: false,
// count }. A `task_id:` line introduced by prose, or quoted inside a
// fence/HTML comment, is never counted. Never guesses when the count
// isn't exactly one (same "don't silently pick one" contract as every
// other task_id resolver in this codebase, e.g. relay-handshake.mjs's own
// resolveResultTaskId).
export function resolveHeaderTaskId(content) {
  const lines = maskQuotedMarkerRegions(
    (content ?? "").replace(/\r\n/g, "\n"),
  ).split("\n");
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_ID_LINE_RE);
    if (!m) continue;
    if (!hasStructuralPredecessor(lines, i)) continue;
    candidates.push(m[1]);
  }
  if (candidates.length !== 1) return { ok: false, count: candidates.length };
  return { ok: true, id: candidates[0] };
}
