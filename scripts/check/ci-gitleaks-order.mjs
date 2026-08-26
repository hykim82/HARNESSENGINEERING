// HYK-365 2R (설계 하향 라, 1R review-1 rejection): pins the workflow-step
// ORDER shape the gitleaks-order fix (enforce.yml) depends on, plus that the
// install step genuinely PERFORMS the install (not just mentions the target
// path in a comment) -- so a future edit that silently reverts the order or
// hollows out the install step goes red instead of quietly resurrecting the
// 3 nc-gitleaks.test.mjs skips this fix closed.
//
// 2R change from 1R's `judgeGitleaksOrder`: 1R's ⓑ/ⓒ both asserted
// `continue-on-error` presence/absence -- review-1 P1-1 found that
// contradicts nc-ci-enforce.test.mjs:145's existing, workflow-wide
// `hasContinueOnError(text) === false` contract (that file owns "no
// continue-on-error anywhere in this workflow, full stop" already; this file
// duplicating it in the install-step-only direction is what conflicted).
// The responsible party downgraded the design from 라′ to 라: the install
// step no longer carries continue-on-error at all, so nc-ci-enforce's
// existing contract and this file's are no longer in tension, and this file
// drops the continue-on-error checks entirely rather than re-deriving a
// second copy of a check the other file already owns (coder-task.md 2R §3ⓑ:
// "같은 것을 두 번 검사하지 마라").
//
// This file's OWN remaining unique concerns are exactly two:
//   ⓐ ORDER -- the install step comes before the suite step. Nothing else
//     in the repo checks step ORDER; nc-ci-enforce checks step CONTENTS
//     workflow-wide but is order-blind.
//   ⓑ REALNESS -- the install step's run: text actually references the
//     gitleaks install target path as EXECUTED CODE, not merely as text
//     inside a shell comment. review-1 P1-2 found the 1R version's
//     `run.includes(marker)` matched a mutation where the real `sudo mv`
//     command was replaced by `echo install-skipped` and the marker only
//     survived in a trailing `# intended install path: ...` comment -- a
//     silent false-GREEN. Fixed here by tokenizing run: text into Bash
//     WORDS (via selfcheck-inventory.mjs's own bashWords, reused rather
//     than re-invented -- it already drops shell `#`-comments at word
//     boundaries, tested by that file's own (28ag) case) and requiring the
//     marker to appear as/inside an actual WORD, not merely as a substring
//     of the raw text. A full-line or trailing `#`-comment mentioning the
//     path no longer counts, by construction -- not by matching a list of
//     known install-command names (coder-task.md 2R §3ⓒ's explicit warning
//     against that shape, the same one HYK-367 was rejected for the same
//     day). An install step using a different real command (`install -m`,
//     `cp`, `apt-get install` to a different path, ...) is judged the same
//     way every other unrecognized shape in this file is: loudly reported
//     as "marker not found in executed code", never silently passed --
//     which is honest under-recognition, not false acceptance.
//
// Still no YAML parser dependency (parseWorkflowSteps below, unchanged
// approach from 1R): a step array is built by walking `steps:` list
// indentation structurally, never by iterating a fixed list of known step
// names -- see that function's own comment for the documented line-scanner
// limitation.
import {
  decodeYamlScalar,
  matchesExactRunnerInvocation,
  bashWords,
} from "./selfcheck-inventory.mjs";

// Parses a GitHub Actions workflow's FIRST `jobs.<job>.steps:` sequence into
// an ordered array of { name, run }, by walking indentation -- not by
// searching for any step's name or content. The step array's ORDER is
// exactly the YAML document's order (array index === document position),
// which is what the ⓐ order assertion below actually needs.
//
// Honest limit (unchanged from 1R): this is a line scanner, not a real YAML
// parser -- it assumes GitHub Actions' own convention that a job's `steps:`
// key is followed by a `- `-prefixed list at a fixed, consistent indent
// (true of every real workflow in this repo today), and that each step's
// own keys sit two spaces deeper than that list marker. A `steps: [...]`
// flow-sequence or inconsistently-reindented step keys would defeat it
// silently -- review-1 confirmed both shapes go loudly UNJUDGABLE (RED, not
// silent GREEN) against the real detectors below, which is the honest
// fallback this file relies on rather than claiming full YAML coverage.
export function parseWorkflowSteps(workflowText) {
  const lines = workflowText.split(/\r?\n/).map((l) => l.replace(/\r$/, ""));
  const stepsLineIdx = lines.findIndex((l) => /^(\s*)steps:\s*$/.test(l));
  if (stepsLineIdx === -1) return [];
  const stepsIndent = lines[stepsLineIdx].match(/^(\s*)/)[1].length;
  const itemIndent = stepsIndent + 2;

  const blocks = [];
  let current = null;
  for (let i = stepsLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (current) current.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < itemIndent) break; // dedented out of the steps: sequence
    if (indent === itemIndent && line.slice(indent).startsWith("- ")) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);

  return blocks.map((block) => parseStepBlock(block, itemIndent));
}

// Reads a YAML block scalar's body (the indented lines following a `run: |`
// or `run: >` key) starting at `lines[startIdx]`, dedenting to the block's
// own minimum indent. Returns { text, nextIdx } -- nextIdx is the first
// line index NOT part of this block, so the caller can resume its own scan
// there.
function readBlockScalar(lines, startIdx, keyIndent) {
  const blockLines = [];
  let j = startIdx;
  for (; j < lines.length; j++) {
    const raw = lines[j];
    if (raw.trim() === "") {
      blockLines.push("");
      continue;
    }
    const rawIndent = raw.length - raw.trimStart().length;
    if (rawIndent <= keyIndent) break;
    blockLines.push(raw);
  }
  const nonBlankIndents = blockLines
    .filter((l) => l.trim() !== "")
    .map((l) => l.length - l.trimStart().length);
  const minIndent = nonBlankIndents.length ? Math.min(...nonBlankIndents) : 0;
  return {
    text: blockLines.map((l) => l.slice(minIndent)).join("\n"),
    nextIdx: j,
  };
}

function parseStepBlock(rawLines, itemIndent) {
  const keyIndent = itemIndent + 2;
  // First line is "<itemIndent spaces>- key: value" -- reindent it to
  // keyIndent so every step-level key (including the first) lines up at
  // the same column for the scan below.
  const first = `${" ".repeat(keyIndent)}${rawLines[0].slice(itemIndent + 2)}`;
  const lines = [first, ...rawLines.slice(1)];

  let name = null;
  const runChunks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent !== keyIndent) continue; // nested under some other key; not our concern here
    const m = /^([A-Za-z][\w-]*):(.*)$/.exec(line.slice(keyIndent));
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    if (key === "name") name = value;
    if (key !== "run") continue;
    const isBlockScalar = /^[|>][+-]?\d*\s*(?:#.*)?$/.test(value);
    if (!isBlockScalar) {
      runChunks.push(decodeYamlScalar(value));
      continue;
    }
    const { text, nextIdx } = readBlockScalar(lines, i + 1, keyIndent);
    runChunks.push(text);
    i = nextIdx - 1;
  }

  return { name, run: runChunks.join("\n") };
}

const GITLEAKS_INSTALL_MARKER = "/usr/local/bin/gitleaks";
const GITLEAKS_SCAN_RE = /^gitleaks\s+detect\b/;
const RUNNER_SCRIPT_REL_PATH = "scripts/check/isolated-suite-runner.mjs";

function findStepIndex(steps, predicate) {
  return steps.findIndex((s) => predicate(s.run ?? ""));
}

// ⓑ REALNESS: true iff the install target path appears in an actually
// EXECUTED Bash word of `runText` -- i.e. survives comment-stripping. Reuses
// bashWords (selfcheck-inventory.mjs), which already drops everything from
// an unquoted `#` to end-of-line at a word boundary (the exact Bash comment
// rule), so `# intended install path: /usr/local/bin/gitleaks` tokenizes to
// zero words and can never satisfy this -- review-1's exact P1-2 repro.
// Checking substring-within-a-word (not exact word equality) still covers
// the real form `sudo mv gitleaks /usr/local/bin/gitleaks` (the path is its
// own word) without requiring any particular command name.
function installMarkerInExecutedCode(runText) {
  return bashWords(runText).some((w) =>
    w.literal.includes(GITLEAKS_INSTALL_MARKER),
  );
}

// Locates the two steps this fix cares about and judges the two invariants
// ⓐ (order) and ⓑ (install realness) -- see module header for why
// continue-on-error is no longer this file's concern (2R downgrade, owned
// by nc-ci-enforce.test.mjs:145 workflow-wide). Returns { ok, reasons } --
// reasons is always populated with either the pass description or the
// exact violated invariant, never a bare boolean.
export function judgeGitleaksOrder(workflowText) {
  const steps = parseWorkflowSteps(workflowText);
  const installIdx = findStepIndex(steps, installMarkerInExecutedCode);
  const scanIdx = findStepIndex(steps, (run) =>
    GITLEAKS_SCAN_RE.test(run.trim()),
  );
  const suiteIdx = findStepIndex(steps, (run) =>
    matchesExactRunnerInvocation(run, RUNNER_SCRIPT_REL_PATH),
  );

  const reasons = [];
  if (installIdx === -1)
    reasons.push(
      `no step's run: text installs to ${GITLEAKS_INSTALL_MARKER} as executed code (ⓑ) -- a comment mentioning the path, or a different real install method, does not count; either the install is missing or it uses a shape this contract doesn't yet recognize (loudly, not silently)`,
    );
  if (scanIdx === -1)
    reasons.push("no step's run: text is a 'gitleaks detect ...' invocation");
  if (suiteIdx === -1)
    reasons.push(
      `no step's run: text is the one recognized invocation of ${RUNNER_SCRIPT_REL_PATH}`,
    );
  if (installIdx !== -1 && suiteIdx !== -1 && !(installIdx < suiteIdx)) {
    reasons.push(
      `gitleaks-install step is at index ${installIdx} but the test-suite step is at index ${suiteIdx} -- install must come BEFORE the suite (ⓐ), or gitleaks is absent from PATH when the suite's nc-gitleaks.test.mjs cases run and they silently skip again`,
    );
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    reasons: [`install(${installIdx}) < suite(${suiteIdx}); scan(${scanIdx})`],
  };
}
