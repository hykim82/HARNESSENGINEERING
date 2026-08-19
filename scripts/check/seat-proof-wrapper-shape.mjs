// HYK-323 (wrapper-shape-1): the seat-proof gate's repo-side units
// (dispatch-worker-seat-proof-gate.mjs / seat-proof-cli.mjs) were tested
// exhaustively, but the control-room PowerShell wrapper layer around them
// (`Invoke-SeatProofGate` in dispatch-worker.ps1) had zero tests checking
// whether it could ever return a *passing* verdict at all. 2026-08-19: that
// wrapper leaked the gate CLI's stdout into its own PowerShell return value
// alongside `return $LASTEXITCODE`, so callers received a 2-element array
// and `-ne 0` read PROVEN (exit 0) as a failure too -- every delivery was
// rejected, with no passing path. This module mechanizes a shape check for
// that specific class of defect so it cannot silently return.
//
// HYK-323 (wrapper-shape-2, review r1 rejection, P1 x3): review r1 found
// three notations that all read as OK from the wrapper-shape-1 checker but
// are semantically the same defect class or worse:
//   1. capture the gate call's stdout into a variable, then leak that
//      variable back out via `Write-Output`/bare-expression anyway;
//   2. declare a second, uncaptured `Invoke-SeatProofGate` after a fixed
//      one -- PowerShell keeps only the LAST definition, but the old judge
//      only ever inspected the first;
//   3. invoke the gate CLI via array splatting (`& node @nodeArgs`) --
//      the old call-recognition regex required the literal
//      `& node $gateCliPath` token sequence and missed this entirely.
// All three are fixed below. Fail-closed principle (kept from round 1,
// restated per review's explicit ask in §2-3): a form this checker does not
// specifically recognize as safe is BROKEN, never silently OK. This applies
// to unrecognized invocation notations (shape ⓐ) and to any function text
// where more than one definition of the same name exists (shape ⓓ) --
// finding it un-parseable or ambiguous is itself a fail-closed BROKEN, not
// a pass.
//
// Honesty limits (§2-3, keep in both this header and the result file):
// - CI cannot see the control room (`D:\문서관리\하네스-관제실\`) -- this
//   checker inspects the real wrapper only when run locally by a human/ORCH
//   with that path. What CI runs is this module's OWN unit tests, never a
//   check of the live wrapper. Do not claim "CI prevents recurrence."
// - This checker inspects *shape* only -- it never executes the wrapper to
//   confirm exit 0 is actually read as a pass (that needs PowerShell, which
//   CI does not have).
// - Wiring this checker into the control room's delivery path itself
//   (dispatch-worker.ps1 calling this CLI before trusting the seat-proof
//   gate) is proposed only, in docs/control-room-patches/
//   HYK-323-seat-proof-wrapper-shape-check.md -- not applied by this round.

const FUNCTION_NAME = "Invoke-SeatProofGate";
// Call recognition is anchored on the call operator + command name
// (`& node ...` / `& $node ...`), NOT on the argument notation that
// follows it. Review r1 broke the wrapper-shape-1 version of this regex
// (which required the literal token sequence `& node $gateCliPath`) simply
// by splatting the same arguments through an array (`& node @nodeArgs`).
// Argument notation will keep growing new forms; the call-operator anchor
// does not need to.
const GATE_CALL_RE = /&\s*(node\b|\$node\b)/;
const CAPTURED_ASSIGNMENT_RE = /^\$[A-Za-z_]\w*\s*=/;
const CAPTURED_VAR_NAME_RE = /^\$([A-Za-z_]\w*)\s*=/;
// A call piped straight to `Out-Null` discards its output without ever
// needing a capturing variable at all -- an explicit, safe alternative to
// `$var = ...`, not a defect.
const SAFE_DISCARD_SUFFIX_RE = /\|\s*Out-Null\s*$/i;
const RETURN_RE = /^return\s+(.+)$/;
const SIMPLE_VAR_RE = /^\$([A-Za-z_]\w*)$/;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// Locates every `function Invoke-SeatProofGate(...) { ... }` in the text
// (PowerShell allows redefining a function; only the LAST definition is
// live at runtime) and returns each one's text strictly between its
// opening and matching closing brace (brace-depth counted, so a nested
// `foreach (...) { ... }` block doesn't truncate it early). An empty
// array means the header was never found; a `null` entry means a header
// was found but its braces never balanced -- both fold into fail-closed
// FUNCTION_NOT_FOUND at the caller.
function extractAllFunctionBodies(text) {
  const headerRe = new RegExp(
    `function\\s+${FUNCTION_NAME}\\s*\\([^)]*\\)\\s*\\{`,
    "g",
  );
  const bodies = [];
  let headerMatch;
  while ((headerMatch = headerRe.exec(text)) !== null) {
    const start = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      bodies.push(null);
      break;
    }
    bodies.push(text.slice(start, i));
    headerRe.lastIndex = i;
  }
  return bodies;
}

// Splits a function body into logical code lines: backtick (`) line
// continuations are joined into one logical line first (so a call split
// across lines is still seen whole by GATE_CALL_RE), then full-line
// `#`-comments and blank lines are dropped so a defect shape quoted inside
// a comment (test 4's requirement) is never mistaken for the live
// statement it describes. Only whole-line comments are recognized -- this
// file's actual PowerShell style (control room + this repo's docs) never
// mixes code and comment on one line, so that's the shape worth trusting;
// a trailing `# ...` on a code line is not stripped.
function codeLinesOf(functionBody) {
  const rawLines = functionBody.split("\n").map((line) => line.trim());
  const logicalLines = [];
  let pending = "";
  for (const line of rawLines) {
    if (line.endsWith("`")) {
      pending += (pending ? " " : "") + line.slice(0, -1).trimEnd();
      continue;
    }
    pending += (pending ? " " : "") + line;
    logicalLines.push(pending.trim());
    pending = "";
  }
  if (pending) logicalLines.push(pending.trim());
  return logicalLines.filter((line) => line !== "" && !line.startsWith("#"));
}

// Walks backward from `fromIndex` for the nearest `$varName = <rhs>`
// assignment and returns its trimmed right-hand side, or null if none.
function lastAssignmentRhs(codeLines, varName, fromIndex) {
  const assignRe = new RegExp(`^\\$${varName}\\s*=\\s*(.+)$`);
  for (let i = fromIndex; i >= 0; i--) {
    const m = assignRe.exec(codeLines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

// Shape ⓐ: the gate CLI is invoked without capturing its output into a
// variable. In PowerShell, an uncaptured command's stdout joins the
// enclosing function's own pipeline output -- wrapper-shape-1's original
// defect. Returns `{ broken, capturedVar }`: `broken` is a verdict object if
// an uncaptured call was found (fail-closed), else null; `capturedVar` is
// the name (if any) of the variable that captured the gate call's output,
// for shape ⓒ below.
function findUncapturedGateCall(codeLines) {
  let capturedVar = null;
  for (const line of codeLines) {
    if (!GATE_CALL_RE.test(line)) continue;
    if (CAPTURED_ASSIGNMENT_RE.test(line)) {
      const varMatch = CAPTURED_VAR_NAME_RE.exec(line);
      if (varMatch) capturedVar = varMatch[1];
      continue;
    }
    if (SAFE_DISCARD_SUFFIX_RE.test(line)) continue;
    return {
      broken: {
        verdict: "BROKEN",
        reasonCode: "UNCAPTURED_GATE_OUTPUT",
        detail: line,
      },
      capturedVar,
    };
  }
  return { broken: null, capturedVar };
}

// Shape ⓒ (review r1 P1-1): the variable that captured the gate call's
// stdout gets leaked back out as the function's own output anyway --
// either explicitly (`Write-Output`/its alias `echo`) or implicitly (the
// variable alone on its own line is itself a PowerShell output statement).
// `Write-Host` (writes to the host, not the pipeline), `$null = ...`, and
// `| Out-Null` are void/discarding forms and stay OK. Returns a BROKEN
// verdict if a leak is found, else null.
function findLeakedCapturedOutput(codeLines, capturedVar) {
  if (!capturedVar) return null;
  const leakWriteRe = new RegExp(
    `^(Write-Output|echo)\\s+\\$${capturedVar}\\b`,
    "i",
  );
  const bareVarRe = new RegExp(`^\\$${capturedVar}$`);
  for (const line of codeLines) {
    if (leakWriteRe.test(line) || bareVarRe.test(line)) {
      return {
        verdict: "BROKEN",
        reasonCode: "LEAKED_CAPTURED_OUTPUT",
        detail: line,
      };
    }
  }
  return null;
}

// Judges a single function body's code lines. Never sees whether other
// definitions of the same function exist -- that's the caller's job.
function judgeFunctionBody(codeLines) {
  const { broken: uncapturedBroken, capturedVar } =
    findUncapturedGateCall(codeLines);
  if (uncapturedBroken) return uncapturedBroken;

  const leakBroken = findLeakedCapturedOutput(codeLines, capturedVar);
  if (leakBroken) return leakBroken;

  // Shape ⓑ: the function must end in a `return <expr>` whose value is
  // traceably an exit code -- either `$LASTEXITCODE` directly, or a
  // variable whose last assignment before the return is exactly
  // `$LASTEXITCODE`. Anything else means the function's return value isn't
  // provably a bare exit code (fail-closed: unknown shape -> BROKEN).
  const last = codeLines[codeLines.length - 1];
  const returnMatch = last ? RETURN_RE.exec(last) : null;
  if (!returnMatch) {
    return {
      verdict: "BROKEN",
      reasonCode: "RETURN_NOT_EXIT_CODE",
      detail: last ?? "(empty function body)",
    };
  }

  const returnExpr = returnMatch[1].trim();
  if (returnExpr === "$LASTEXITCODE") {
    return { verdict: "OK" };
  }

  const varMatch = SIMPLE_VAR_RE.exec(returnExpr);
  if (!varMatch) {
    return {
      verdict: "BROKEN",
      reasonCode: "RETURN_NOT_EXIT_CODE",
      detail: last,
    };
  }

  const rhs = lastAssignmentRhs(codeLines, varMatch[1], codeLines.length - 2);
  if (rhs !== "$LASTEXITCODE") {
    return {
      verdict: "BROKEN",
      reasonCode: "RETURN_NOT_EXIT_CODE",
      detail: last,
    };
  }

  return { verdict: "OK" };
}

// Pure judge: given the wrapper script's full text, decides whether
// `Invoke-SeatProofGate` can only ever return a bare exit code, or whether
// it has a shape that can leak extra output into its return value, return
// something that isn't traceably an exit code, or exist as more than one
// definition (PowerShell keeps only the LAST one live -- a judge that only
// inspected the first would be blind to exactly review r1's P1-2 case).
// I/O 0, global state 0, `process.platform` unused -- takes script text in,
// returns a verdict out, nothing else.
export function judgeSeatProofWrapperShape(scriptText) {
  const text = normalizeNewlines(scriptText);
  const bodies = extractAllFunctionBodies(text);
  if (bodies.length === 0) {
    return {
      verdict: "BROKEN",
      reasonCode: "FUNCTION_NOT_FOUND",
      detail: `function ${FUNCTION_NAME} not found (or braces unbalanced)`,
    };
  }

  const judgments = bodies.map((body) =>
    body === null
      ? {
          verdict: "BROKEN",
          reasonCode: "FUNCTION_NOT_FOUND",
          detail: "braces unbalanced",
        }
      : judgeFunctionBody(codeLinesOf(body)),
  );

  // Shape ⓓ (review r1 P1-2): more than one definition exists. Fail-closed
  // regardless of whether every individual body judges OK -- ambiguity
  // about which definition is actually live at runtime is itself the
  // defect, not something a per-body pass can clear.
  if (bodies.length > 1) {
    const firstBroken = judgments.find((j) => j.verdict === "BROKEN");
    const baseDetail = firstBroken
      ? firstBroken.detail
      : `all ${bodies.length} definitions individually judged OK`;
    return {
      verdict: "BROKEN",
      reasonCode: firstBroken ? firstBroken.reasonCode : "MULTIPLE_DEFINITIONS",
      detail: `${baseDetail} (MULTIPLE_DEFINITIONS: ${bodies.length} definitions of ${FUNCTION_NAME} found)`,
    };
  }

  return judgments[0];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--script") out.script = argv[++i];
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-proof-wrapper-shape.mjs");
if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const args = parseArgs(process.argv.slice(2));
  if (!args.script) {
    console.error(
      "usage: node seat-proof-wrapper-shape.mjs --script <path-to-dispatch-worker.ps1>",
    );
    process.exit(2);
  }

  let scriptText;
  try {
    scriptText = readFileSync(args.script, "utf8");
  } catch (err) {
    console.error(
      `seat-proof-wrapper-shape: failed to read --script file: ${err.message}`,
    );
    process.exit(2);
  }

  const result = judgeSeatProofWrapperShape(scriptText);
  if (result.verdict === "OK") {
    console.log("WRAPPER_SHAPE: OK");
    process.exit(0);
  }
  console.log(`WRAPPER_SHAPE: BROKEN reason=${result.reasonCode}`);
  if (result.detail) console.error(`  detail: ${result.detail}`);
  process.exit(2);
}
