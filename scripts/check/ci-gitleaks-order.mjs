// HYK-365 3R (책임자 판정 2026-08-27, 갈래 ⓐ 승인 -- 연속반려 2 게이트 해제):
// pins ONLY the workflow-step ORDER shape the gitleaks-order fix
// (enforce.yml) depends on -- the install step comes before the suite step
// -- so a future edit that silently reverts the order goes red instead of
// quietly resurrecting the 3 nc-gitleaks.test.mjs skips this fix closed.
//
// 3R change from 2R: 2R also carried a second invariant, REALNESS (does the
// install step's run: text actually EXECUTE the install, not just mention
// the target path in a comment -- fixed there via Bash word-tokenization to
// close review-1's P1-2 false-GREEN). review-2 then found REALNESS itself
// has a deeper, structural limitation: any static-text approach to proving
// "this shell script really executes X" is a losing chase -- comments were
// only the first bypass; the SAME question re-opens for the marker sitting
// inside a quoted string, a shell variable, a heredoc, or an `eval` argument
// that never actually runs, and closing each of those only invites the next
// one ($(...) command substitution, a sourced function, ...). The
// responsible party's ruling: proving real execution by reading TEXT is
// fighting a losing whack-a-mole against an interpreter this file would
// have to keep re-implementing -- the honest way to know installation
// happened is to observe the OUTCOME (did the 3 nc-gitleaks.test.mjs cases
// actually run, unskipped, in CI) rather than parse the RECIPE. That
// observation-based check is a different LAYER (reads CI results, not
// workflow source text) and is deliberately NOT this file's job -- it is
// tracked separately as **HYK-368** (observation-based contract: did the
// gitleaks-gated cases actually run in CI, read from CI's own output).
//
// This is a removal, not a silent shrink: REALNESS is gone from THIS
// file's assertions on purpose, moved to a different, more honest
// verification layer under a tracked issue -- not abandoned. Proof this
// isn't quietly losing coverage: review-1's original repro (the install
// command replaced by `echo install-skipped`, target path surviving only in
// a trailing `# ...` comment) is now GREEN here (see ci-gitleaks-order.test.mjs
// §4-3) -- intentionally, because this file no longer claims to know
// whether the install is real, only where the step claiming to install
// sits relative to the suite step.
//
// ⇒ This file's ONE remaining, OWNED concern is ORDER. It does not, and no
// longer tries to, verify that the install step's contents are genuine.
//
// No YAML parser dependency (parseWorkflowSteps below, unchanged approach
// since 1R): a step array is built by walking `steps:` list indentation
// structurally, never by iterating a fixed list of known step names -- see
// that function's own comment for the documented line-scanner limitation.
import {
  decodeYamlScalar,
  matchesExactRunnerInvocation,
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

// LOCATES (does not verify) the step that claims to install gitleaks, by a
// plain substring match on the install target path -- deliberately the
// naive 1R shape, not 2R's Bash-word-tokenized "is this really executed
// code" check (that check is what got separated out this round, see module
// header). This function answers only "which step is the order-relevant
// install step", never "does that step actually perform a real install" --
// a step whose run: text merely MENTIONS the path (a comment, a variable, a
// heredoc, ...) is found here just the same as one that executes it, and
// that is intentional now: order is all this file owns.
//
// P2-1 (review-2, carried forward as an accepted, undocumented-further
// limitation per coder-task.md 3R §3ⓑ -- do not make this "smarter"): an
// install step using a method that never spells out this exact path (e.g.
// `apt-get install -y gitleaks`, which installs to whatever location the
// package manager chooses) is NOT found by this substring match either, and
// so still can't be order-checked -- the same shared anchor this file uses
// to find the step in the first place is the limitation, not something 3R's
// removal of REALNESS fixes on its own. When that happens the step is
// simply not found, which surfaces as the loud (not silent) "no step's
// run: text..." reason below -- never a silent pass.
function installMarkerMentioned(runText) {
  return runText.includes(GITLEAKS_INSTALL_MARKER);
}

// Locates the steps this fix cares about and judges the ONE invariant this
// file still owns -- ⓐ ORDER (install before suite). See module header for
// why REALNESS (does the install step really install) and continue-on-error
// (owned by nc-ci-enforce.test.mjs:145) are both, deliberately, not checked
// here. Returns { ok, reasons } -- reasons is always populated with either
// the pass description or the exact violated invariant, never a bare
// boolean.
export function judgeGitleaksOrder(workflowText) {
  const steps = parseWorkflowSteps(workflowText);
  const installIdx = findStepIndex(steps, installMarkerMentioned);
  const scanIdx = findStepIndex(steps, (run) =>
    GITLEAKS_SCAN_RE.test(run.trim()),
  );
  const suiteIdx = findStepIndex(steps, (run) =>
    matchesExactRunnerInvocation(run, RUNNER_SCRIPT_REL_PATH),
  );

  const reasons = [];
  if (installIdx === -1)
    reasons.push(
      `no step's run: text mentions the gitleaks install target path ${GITLEAKS_INSTALL_MARKER} -- this contract only orders that step against the suite step (ⓐ); it does not verify the install is real (that is HYK-368's concern, an observation-based layer, not this file)`,
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
