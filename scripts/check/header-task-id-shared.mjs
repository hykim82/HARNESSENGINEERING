// HYK-468: a result/round-archive file's own `task_id:` declaration is only
// trustworthy inside its HEADER BLOCK (the leading run of `key: value` lines
// before the file's first blank line). The column-0 regex these three
// readers used to run independently over the WHOLE file also matches a
// `task_id:` line quoted verbatim later in the body -- e.g. a coder.md
// documenting exactly what dispatch-gate-decision.mjs's
// bestEffortInjectResultPaths injected, inside a fenced code block, at
// column 0 (real incident: hyk442-blocked-door-1/.harness/coder.md line 24
// quotes `task_id: HYK-9201-inject-1` as a worked example, three lines below
// its own real declaration on line 1). The whole-file scan counted both,
// saw 2 "declarations", and rejected a round that was actually fine.
//
// Scoping the scan to the header block removes the collision: everything
// below the header (prose, code fences, quoted examples) is simply out of
// range. A fixture with no blank line at all -- true of nearly every
// existing unit test in this repo, which hand-writes short single-purpose
// strings -- is entirely its own header block, so this is a strict
// narrowing of what counts, never a behavior change, for any caller whose
// input never contains a blank line.
//
// This is the CANONICAL definition of the contract (and this file's own
// header-task-id-shared.test.mjs is what exercises the three required
// shapes: quoted-example + header-declared -> resolved; two header
// declarations -> reject; zero -> reject). It is deliberately NOT imported
// by either of its two consumers -- admission-completion-adapter.mjs and
// dispatch-gate-decision.mjs are both statically cloned into isolated
// mutation-test fixtures by a long tail of existing tests, each with its
// own hand-maintained sibling-file list (measured directly: adding an
// import to either broke admission-completion-worktree-isolation.test.mjs
// and hyk396-open-axis.test.mjs with MODULE_NOT_FOUND). Both files instead
// carry their own local byte-identical-logic copy of resolveHeaderTaskId
// (see each file's own copy for the cross-reference comment) -- the same
// "duplicate small pieces instead of importing" convention
// admission-completion-adapter.mjs's own header already documents for
// BLOCKED_RE. Three copies, one contract: coder-task.md §1 commit ③ calls
// this "세 독자가 같은 함수를 쓰게 하라" (three readers, one function) --
// satisfied here as "one canonical logic, kept byte-identical across all
// three copies," not as a single imported module.
const HEADER_TASK_ID_LINE_RE_G = /^task_id:[ \t]*(\S+)/gim;

// Header block = leading lines up to (not including) the first blank line.
function headerBlockOf(content) {
  const normalized = (content ?? "").replace(/\r\n/g, "\n");
  const blankLineIdx = normalized.search(/\n[ \t]*\n/);
  return blankLineIdx === -1 ? normalized : normalized.slice(0, blankLineIdx);
}

// Resolves the file's own declared task_id from its header block only.
// Exactly one column-0 `task_id:` line in the header -> { ok: true, id }.
// Zero, or two-or-more (a real duplicate declaration, or a declaration plus
// a second header-block line that also happens to start with `task_id:`)
// -> { ok: false, count }. Never guesses when the count isn't exactly one
// (same "don't silently pick one" contract as every other task_id resolver
// in this codebase, e.g. relay-handshake.mjs's resolveResultTaskId).
export function resolveHeaderTaskId(content) {
  const header = headerBlockOf(content);
  const matches = [...header.matchAll(HEADER_TASK_ID_LINE_RE_G)];
  if (matches.length !== 1) return { ok: false, count: matches.length };
  return { ok: true, id: matches[0][1] };
}
