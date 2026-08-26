// HYK-365 라′: pins the workflow-step ORDER/FLAG shape the gitleaks-order
// fix (enforce.yml) depends on, so a future edit that silently reverts the
// order or drops a flag goes red instead of quietly resurrecting the 3
// nc-gitleaks.test.mjs skips this fix closed.
//
// This does NOT hardcode a list of known step names to walk (coder-task.md
// §2⑶'s explicit warning: "list traversal" guards have blind spots outside
// their own list -- the exact P1 shape that hit skip-inventory-contract's
// 1R three times in two days). Instead it structurally parses the workflow
// YAML's `jobs.<job>.steps:` sequence into a real step array (by indentation,
// the same way a YAML list actually nests) and locates each of the three
// steps this fix cares about by what its `run:` text actually DOES (a
// content match against gitleaks' documented install/scan commands and,
// for the suite step, selfcheck-inventory.mjs's own exact-invocation
// recognizer) -- never by iterating a fixed name list. A brand-new,
// unrelated step anywhere in the file is invisible to every check here,
// by construction: nothing here enumerates "the known steps", everything
// here asks "where, structurally, are these three particular steps now."
//
// No YAML parser dependency added (coder-task.md §2⑶'s explicit ask): this
// reuses decodeYamlScalar from selfcheck-inventory.mjs (the repo's existing,
// tested line-scanner for a run: step's inline/block-scalar text) and adds
// only the indentation-based step-boundary walk that file didn't need for
// its own (non-order-sensitive) purpose. Honest limit: this is a line
// scanner, not a real YAML parser -- it assumes GitHub Actions' own
// convention that a job's `steps:` key is followed by a `- `-prefixed list
// at a fixed, consistent indent (true of every real Actions workflow,
// including this repo's), and that each step's own keys sit two spaces
// deeper than that list marker. A step whose mapping keys are reindented
// inconsistently, or a `steps:` block using YAML flow-sequence syntax
// (`steps: [...]`), would defeat it silently -- neither shape appears
// anywhere in this repo's workflows today.
import {
  decodeYamlScalar,
  matchesExactRunnerInvocation,
} from "./selfcheck-inventory.mjs";

// Parses a GitHub Actions workflow's FIRST `jobs.<job>.steps:` sequence into
// an ordered array of { name, run, continueOnError }, by walking indentation
// -- not by searching for any step's name or content. The step array's
// ORDER is exactly the YAML document's order (array index === document
// position), which is what every assertion below actually needs.
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
  let continueOnError = false;
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
    if (key === "continue-on-error") continueOnError = value === "true";
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

  return { name, run: runChunks.join("\n"), continueOnError };
}

const GITLEAKS_INSTALL_MARKER = "/usr/local/bin/gitleaks";
const GITLEAKS_SCAN_RE = /^gitleaks\s+detect\b/;
const RUNNER_SCRIPT_REL_PATH = "scripts/check/isolated-suite-runner.mjs";

function findStepIndex(steps, predicate) {
  return steps.findIndex((s) => predicate(s.run ?? ""));
}

// Locates the three steps this fix cares about by what their `run:` text
// actually does, and judges the three invariants ⓐⓑⓒ (coder-task.md §2⑶).
// Returns { ok, reasons } -- reasons is always populated with either the
// pass description or the exact violated invariant, never a bare boolean.
export function judgeGitleaksOrder(workflowText) {
  const steps = parseWorkflowSteps(workflowText);
  const installIdx = findStepIndex(steps, (run) =>
    run.includes(GITLEAKS_INSTALL_MARKER),
  );
  const scanIdx = findStepIndex(steps, (run) =>
    GITLEAKS_SCAN_RE.test(run.trim()),
  );
  const suiteIdx = findStepIndex(steps, (run) =>
    matchesExactRunnerInvocation(run, RUNNER_SCRIPT_REL_PATH),
  );

  const reasons = [];
  if (installIdx === -1)
    reasons.push("no step's run: text installs to /usr/local/bin/gitleaks");
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
  if (installIdx !== -1 && !steps[installIdx].continueOnError) {
    reasons.push(
      `gitleaks-install step (index ${installIdx}) is missing continue-on-error: true (ⓑ) -- an install failure would now hard-fail the job at the SUITE step instead of only at the later scan step, widening blast radius`,
    );
  }
  if (scanIdx !== -1 && steps[scanIdx].continueOnError) {
    reasons.push(
      `gitleaks scan step (index ${scanIdx}) has continue-on-error set (ⓒ forbids this) -- the gate would no longer fail the job when gitleaks is absent from PATH, silently weakening enforcement`,
    );
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    reasons: [
      `install(${installIdx}) < suite(${suiteIdx}); install.continue-on-error=true; scan(${scanIdx}).continue-on-error=false`,
    ],
  };
}
