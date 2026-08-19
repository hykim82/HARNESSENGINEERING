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
// The invocation line itself calls `& node $gateCliPath ...` -- the literal
// `dispatch-worker-seat-proof-gate.mjs` filename only appears earlier, in
// the `$gateCliPath = Join-Path ...` assignment, so matching on the literal
// filename would miss the actual call site entirely (verified against both
// real fixtures below: this cost a red herring on the first pass).
const GATE_CALL_RE = /&\s*node\s+\$gateCliPath\b/;
const CAPTURED_ASSIGNMENT_RE = /^\$[A-Za-z_]\w*\s*=/;
const RETURN_RE = /^return\s+(.+)$/;
const SIMPLE_VAR_RE = /^\$([A-Za-z_]\w*)$/;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// Locates `function Invoke-SeatProofGate(...) { ... }` and returns the text
// strictly between its opening and matching closing brace (brace-depth
// counted, so the nested `foreach (...) { ... }` block doesn't truncate it
// early). Returns null if the function header is missing or braces never
// balance -- both fold into fail-closed FUNCTION_NOT_FOUND at the caller.
function extractFunctionBody(text) {
  const headerRe = new RegExp(
    `function\\s+${FUNCTION_NAME}\\s*\\([^)]*\\)\\s*\\{`,
  );
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return null;

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
  if (depth !== 0) return null;
  return text.slice(start, i);
}

// Full-line `#`-comments and blank lines are dropped so a defect shape
// quoted inside a comment (test 4's requirement) is never mistaken for the
// live statement it describes. Only whole-line comments are recognized --
// this file's actual PowerShell style (control room + this repo's docs)
// never mixes code and comment on one line, so that's the shape worth
// trusting; a trailing `# ...` on a code line is not stripped.
function codeLinesOf(functionBody) {
  return functionBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
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

// Pure judge: given the wrapper script's full text, decides whether
// `Invoke-SeatProofGate` can only ever return a bare exit code, or whether
// it has a shape that can leak extra output into its return value (today's
// defect class) or return something that isn't traceably an exit code.
// I/O 0, global state 0, `process.platform` unused -- takes script text in,
// returns a verdict out, nothing else.
export function judgeSeatProofWrapperShape(scriptText) {
  const text = normalizeNewlines(scriptText);
  const body = extractFunctionBody(text);
  if (body === null) {
    return {
      verdict: "BROKEN",
      reasonCode: "FUNCTION_NOT_FOUND",
      detail: `function ${FUNCTION_NAME} not found (or braces unbalanced)`,
    };
  }

  const codeLines = codeLinesOf(body);

  // Shape ⓐ: the gate CLI is invoked without capturing its output into a
  // variable. In PowerShell, an uncaptured command's stdout joins the
  // enclosing function's own pipeline output -- exactly today's defect.
  for (const line of codeLines) {
    if (GATE_CALL_RE.test(line) && !CAPTURED_ASSIGNMENT_RE.test(line)) {
      return {
        verdict: "BROKEN",
        reasonCode: "UNCAPTURED_GATE_OUTPUT",
        detail: line,
      };
    }
  }

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
