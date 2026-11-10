// HYK-153 engine-split-1 (coder-task.md §2 (b)-1) -- pins the current
// engine-name string-literal and branch-literal count in scripts/**/*.mjs
// (tests and fixtures excluded) against an allowlist, so any *new*
// hardcoded engine name (or any drift in the allowlist itself) turns this
// test -- and CI -- red. This round only freezes today's baseline; it does
// not reduce the hardcoding (that is HYK-153 piece B).
//
// Tokenizer: strips `//` and `/* */` comments, then extracts string and
// template literals (handling backslash escapes and `${}` interpolation,
// whose expression body is scanned as code, not literal text). The anchor
// pattern is tested against extracted literal text only, never against
// comments or bare identifiers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");
const ALLOWLIST_PATH = path.join(HERE, "engine-name-literal-allowlist.json");

export const ANCHOR_PATTERN =
  /claude|codex|sonnet|opus|haiku|fable|gpt-|anthropic|openai/i;
export const BRANCH_LITERAL_PATTERN =
  /[=!]==\s*["'`](claude|codex|sonnet|opus|haiku|fable|gpt-|anthropic|openai)/gi;

// ---- tokenizer: comments stripped, string/template literals extracted ----

function consumeQuotedString(source, startIndex, quoteChar) {
  let i = startIndex + 1;
  let raw = quoteChar;
  let text = "";
  let lineDelta = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1] ?? "";
      raw += ch + next;
      text += ch + next;
      if (next === "\n") lineDelta += 1;
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      raw += ch;
      i += 1;
      break;
    }
    if (ch === "\n") lineDelta += 1;
    raw += ch;
    text += ch;
    i += 1;
  }
  return { endIndex: i, raw, text, lineDelta };
}

// A `/` is a regex-literal start (not division) unless the previous
// significant character looks like the end of a value (identifier, number,
// `)`, `]`, or a closed string/template/regex) -- standard JS-lexer
// heuristic. Needed so that a regex body containing a backtick or quote
// (e.g. `` /`/ `` or `/["']/`) is skipped as one token instead of being
// misread as the start of a string/template literal, which would otherwise
// swallow the rest of the file into one bogus "literal".
function isRegexAllowed(prevIsValue) {
  return !prevIsValue;
}

function classifyCodeChar(ch) {
  if (/[A-Za-z0-9_$]/.test(ch)) return "value";
  if (ch === ")" || ch === "]") return "value";
  return "operator";
}

// Consumes a regex literal starting at source[startIndex] === "/" (caller
// has already confirmed regex context). Returns the end index (just past
// the trailing flags) and the raw text consumed (pushed to `decommented`
// verbatim so branch-literal scanning still sees the same byte span).
function consumeRegexLiteral(source, startIndex) {
  const n = source.length;
  let i = startIndex + 1;
  let inCharClass = false;
  while (i < n) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") break; // unterminated regex (shouldn't happen in valid JS) -- bail out
    if (ch === "[") inCharClass = true;
    else if (ch === "]") inCharClass = false;
    else if (ch === "/" && !inCharClass) {
      i += 1;
      break;
    }
    i += 1;
  }
  // trailing flags
  while (i < n && /[a-z]/i.test(source[i])) i += 1;
  return { endIndex: i, raw: source.slice(startIndex, i) };
}

function currentFrame(state) {
  return state.frames[state.frames.length - 1];
}

// `//` and `/* */` comments. Returns true if it consumed one.
function stepComment(state) {
  const { source, n, i } = state;
  if (source[i] === "/" && source[i + 1] === "/") {
    let j = i;
    while (j < n && source[j] !== "\n") j += 1;
    state.decommented.push(" ");
    state.i = j;
    return true;
  }
  if (source[i] === "/" && source[i + 1] === "*") {
    let j = i + 2;
    while (j < n && !(source[j] === "*" && source[j + 1] === "/")) {
      if (source[j] === "\n") state.line += 1;
      j += 1;
    }
    j += 2;
    state.decommented.push(" ");
    state.i = j;
    state.prevIsValue = false;
    return true;
  }
  return false;
}

// A `"`/`'` quoted string. Returns true if it consumed one.
function stepQuote(state) {
  const ch = state.source[state.i];
  if (ch !== '"' && ch !== "'") return false;
  const { endIndex, raw, text, lineDelta } = consumeQuotedString(
    state.source,
    state.i,
    ch,
  );
  state.literals.push({ text, line: state.line });
  state.decommented.push(raw);
  state.line += lineDelta;
  state.i = endIndex;
  state.prevIsValue = true;
  return true;
}

// Opens a template-literal frame on a backtick. Returns true if it fired.
function stepTemplateOpen(state) {
  if (state.source[state.i] !== "`") return false;
  state.frames.push({ type: "template", buf: "", startLine: state.line });
  state.decommented.push("`");
  state.i += 1;
  return true;
}

// A regex literal (only when division is not grammatically possible here).
// Returns true if it consumed one.
function stepRegex(state) {
  if (state.source[state.i] !== "/" || !isRegexAllowed(state.prevIsValue))
    return false;
  const { endIndex, raw } = consumeRegexLiteral(state.source, state.i);
  state.decommented.push(raw);
  state.i = endIndex;
  state.prevIsValue = true;
  return true;
}

// `{`/`}` depth tracking, only meaningful inside a `${...}` template
// expression frame (tells us when the expression ends and template text
// resumes). Returns true if it consumed a brace.
function stepTemplateExprBrace(state) {
  const frame = currentFrame(state);
  if (frame.type !== "templateExpr") return false;
  const ch = state.source[state.i];
  if (ch === "{") {
    frame.depth += 1;
    state.decommented.push(ch);
    state.prevIsValue = false;
    state.i += 1;
    return true;
  }
  if (ch === "}") {
    frame.depth -= 1;
    state.decommented.push(ch);
    state.i += 1;
    if (frame.depth === 0) state.frames.pop();
    else state.prevIsValue = true;
    return true;
  }
  return false;
}

function stepNewline(state) {
  if (state.source[state.i] !== "\n") return false;
  state.line += 1;
  state.decommented.push("\n");
  state.i += 1;
  return true;
}

function stepDefaultChar(state) {
  const ch = state.source[state.i];
  state.decommented.push(ch);
  if (ch.trim().length > 0)
    state.prevIsValue = classifyCodeChar(ch) === "value";
  state.i += 1;
}

// One step while the current frame is plain code ("top" or inside a
// template's `${...}` expression -- everything except literal template
// text, which stepTemplateText below handles).
function stepPlainCode(state) {
  if (stepComment(state)) return;
  if (stepQuote(state)) return;
  if (stepTemplateOpen(state)) return;
  if (stepRegex(state)) return;
  if (stepTemplateExprBrace(state)) return;
  if (stepNewline(state)) return;
  stepDefaultChar(state);
}

// One step while the current frame is template-literal text (outside any
// `${...}` expression it may contain).
function stepTemplateText(state) {
  const frame = currentFrame(state);
  const ch = state.source[state.i];
  if (ch === "\\") {
    const next = state.source[state.i + 1] ?? "";
    state.decommented.push(ch, next);
    frame.buf += ch + next;
    if (next === "\n") state.line += 1;
    state.i += 2;
    return;
  }
  if (ch === "`") {
    state.literals.push({ text: frame.buf, line: frame.startLine });
    state.decommented.push(ch);
    state.frames.pop();
    state.prevIsValue = true;
    state.i += 1;
    return;
  }
  if (ch === "$" && state.source[state.i + 1] === "{") {
    state.literals.push({ text: frame.buf, line: frame.startLine });
    frame.buf = "";
    frame.startLine = state.line;
    state.decommented.push("$", "{");
    state.frames.push({ type: "templateExpr", depth: 1 });
    state.i += 2;
    return;
  }
  if (ch === "\n") state.line += 1;
  state.decommented.push(ch);
  frame.buf += ch;
  state.i += 1;
}

// Returns { decommented, literals }. `decommented` is the source with
// comments blanked out (same literal content, used for branch-literal
// scanning). `literals` is a flat list of { text, line } -- one entry per
// quoted string, and one entry per template-literal text chunk (the parts
// outside `${}`).
export function tokenize(source) {
  const state = {
    source,
    n: source.length,
    i: 0,
    line: 1,
    decommented: [],
    literals: [],
    frames: [{ type: "top" }],
    // Regex/division disambiguation, tracked across plain-code frames
    // ("top" and "templateExpr" -- not inside strings/templates/comments).
    prevIsValue: false,
  };
  while (state.i < state.n) {
    if (currentFrame(state).type === "template") {
      stepTemplateText(state);
    } else {
      stepPlainCode(state);
    }
  }
  return { decommented: state.decommented.join(""), literals: state.literals };
}

export function findAnchorHits(source, anchorPattern = ANCHOR_PATTERN) {
  const { literals } = tokenize(source);
  return literals
    .filter((l) => anchorPattern.test(l.text))
    .map((l) => ({ text: l.text, line: l.line }));
}

export function findBranchLiterals(
  source,
  branchPattern = BRANCH_LITERAL_PATTERN,
) {
  const { decommented } = tokenize(source);
  const re = new RegExp(
    branchPattern.source,
    branchPattern.flags.includes("g")
      ? branchPattern.flags
      : `${branchPattern.flags}g`,
  );
  const hits = [];
  let m;
  while ((m = re.exec(decommented))) {
    hits.push(m[0]);
  }
  return hits;
}

// ---- repo-wide scan (production export, not a copy) ----

function walkMjsFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "fixtures") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkMjsFiles(p, out);
    } else if (
      ent.isFile() &&
      ent.name.endsWith(".mjs") &&
      !ent.name.endsWith(".test.mjs")
    ) {
      out.push(p);
    }
  }
}

export function listScanTargets(repoRoot = REPO_ROOT) {
  const files = [];
  walkMjsFiles(path.join(repoRoot, "scripts"), files);
  return files.sort();
}

export function scanRepo(repoRoot = REPO_ROOT) {
  const files = listScanTargets(repoRoot);
  const literalHits = [];
  const branchHits = [];
  for (const abs of files) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
    const source = fs.readFileSync(abs, "utf8");
    for (const hit of findAnchorHits(source)) {
      literalHits.push({ file: rel, literal: hit.text, line: hit.line });
    }
    for (const hit of findBranchLiterals(source)) {
      branchHits.push({ file: rel, match: hit });
    }
  }
  return { literalHits, branchHits, fileCount: files.length };
}

function literalKey(h) {
  return `${h.file}\u0000${h.literal}`;
}
function branchKey(h) {
  return `${h.file}\u0000${h.match}`;
}

function setDiff(actualKeys, expectedKeys) {
  const newOnes = [...actualKeys].filter((k) => !expectedKeys.has(k));
  const stale = [...expectedKeys].filter((k) => !actualKeys.has(k));
  return { newOnes, stale };
}

function loadAllowlist() {
  const text = fs.readFileSync(ALLOWLIST_PATH, "utf8");
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  const parsed = JSON.parse(text);
  return { parsed, sha256, text };
}

// Pinned by byte at commit time (see §3 of coder-task.md -- "허용 목록
// sha256 을 시험 안에 고정"). If the allowlist changes, this constant must
// be updated in the same commit, so widening it is visible in the diff.
const EXPECTED_ALLOWLIST_SHA256 =
  "ed0695a5a68c9330eccd7ad96404140245b775ea3583682b25c68b57d3d0ee87";

test("allowlist file hash is pinned (widening the allowlist must show in the diff)", () => {
  const { sha256 } = loadAllowlist();
  assert.equal(sha256, EXPECTED_ALLOWLIST_SHA256);
});

test("allowlist schema: every literal exception has a recognized category", () => {
  const { parsed } = loadAllowlist();
  const validCategories = new Set(["E1", "E2", "E3", "E5", "B2-TODO"]);
  assert.ok(Array.isArray(parsed.literalExceptions));
  for (const row of parsed.literalExceptions) {
    assert.ok(
      validCategories.has(row.category),
      `unrecognized category in ${JSON.stringify(row)}`,
    );
    assert.ok(typeof row.file === "string" && row.file.length > 0);
    assert.ok(typeof row.literal === "string" && row.literal.length > 0);
  }
});

test("repo-wide anchor-literal scan two-way exact matches the allowlist", () => {
  const { parsed } = loadAllowlist();
  const { literalHits } = scanRepo();

  const actualKeys = new Set(literalHits.map(literalKey));
  const expectedKeys = new Set(parsed.literalExceptions.map(literalKey));
  const { newOnes, stale } = setDiff(actualKeys, expectedKeys);

  assert.deepEqual(
    newOnes,
    [],
    `new engine-name literal(s) not in allowlist: ${JSON.stringify(newOnes)}`,
  );
  assert.deepEqual(
    stale,
    [],
    `stale allowlist entries no longer present in scripts/: ${JSON.stringify(stale)}`,
  );
});

test("repo-wide branch-literal scan two-way exact matches the pinned baseline", () => {
  const { parsed } = loadAllowlist();
  const { branchHits } = scanRepo();

  const actualKeys = new Set(branchHits.map(branchKey));
  const expectedKeys = new Set(parsed.branchLiteralBaseline.map(branchKey));
  const { newOnes, stale } = setDiff(actualKeys, expectedKeys);

  assert.deepEqual(
    newOnes,
    [],
    `new engine-name branch literal(s) not in the pinned baseline: ${JSON.stringify(newOnes)}`,
  );
  assert.deepEqual(
    stale,
    [],
    `branch-literal baseline entries no longer present in scripts/ (baseline is pinned, not "<=''): ${JSON.stringify(stale)}`,
  );
});

// ---- tokenizer unit coverage: comments/quotes, escapes, template ${} ----

test("tokenizer: a quote character inside a // comment does not start a string", () => {
  const src =
    '// this "quote in a comment" mentions claude but is not code\nconst x = 1;\n';
  const hits = findAnchorHits(src);
  assert.deepEqual(hits, []);
});

test("tokenizer: a quote character inside a /* */ block comment does not start a string", () => {
  const src =
    '/* "codex" appears only in this block comment */\nconst x = 1;\n';
  const hits = findAnchorHits(src);
  assert.deepEqual(hits, []);
});

test("tokenizer: an escaped quote inside a string does not terminate it early", () => {
  const src =
    'const s = "it\\"s not codex-ending-here, the real content is codex";\n';
  const hits = findAnchorHits(src);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes("codex"));
  assert.ok(hits[0].text.startsWith('it\\"s'));
});

test("tokenizer: template literal ${} expression code is not scanned as literal text", () => {
  // `claudeHelper` is a bare identifier inside the ${} expression, not a
  // quoted literal -- the tokenizer must not mistake expression code for
  // template literal text just because it sits between backticks.
  const src = "const s = `model-${claudeHelper(x)}-suffix`;\n";
  const hits = findAnchorHits(src);
  assert.ok(!hits.some((h) => h.text.includes("claudeHelper")));
  // A *quoted* literal nested inside the ${} expression is still a real
  // string literal and must still be caught.
  const nested = 'const s = `model-${getEngineName("codex")}-suffix`;\n';
  const nestedHits = findAnchorHits(nested);
  assert.ok(nestedHits.some((h) => h.text === "codex"));
});

test("tokenizer: template literal text chunks outside ${} are scanned as literals", () => {
  const src = "const s = `engine=claude-${suffix}`;\n";
  const hits = findAnchorHits(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "engine=claude-");
});

test("branch-literal: comparison against a string literal is detected", () => {
  const src = 'if (engine === "codex") { doThing(); }\n';
  const hits = findBranchLiterals(src);
  assert.equal(hits.length, 1);
});

test("branch-literal: the anchor word appearing only as a bare identifier is not a branch literal", () => {
  const src = "const codex = loadCodexConfig();\n";
  const hits = findBranchLiterals(src);
  assert.deepEqual(hits, []);
});

// ---- mkdtemp-copy mutation regression (synthetic sample content, not a
// copy of production logic -- these exercise the *real* exported scanner
// functions above against deliberately mutated synthetic source text, per
// coder-task.md §2 ⓘⓘ "시험 안 mkdtemp 사본 변이 3종") ----

function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "engine-name-literal-mut-"),
  );
  const file = path.join(dir, "sample.mjs");
  fs.writeFileSync(file, content, "utf8");
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("mutation ①: injecting an engine literal into clean sample source turns the anchor scan red", () => {
  const clean = "export function f(x) { return x + 1; }\n";
  withTempFile(clean, (file) => {
    const before = findAnchorHits(fs.readFileSync(file, "utf8"));
    assert.deepEqual(before, []);
  });

  const mutated = 'export function f(x) { const e = "codex"; return x + 1; }\n';
  withTempFile(mutated, (file) => {
    const after = findAnchorHits(fs.readFileSync(file, "utf8"));
    assert.ok(
      after.length >= 1,
      "expected the injected literal to be flagged RED",
    );
  });
});

test("mutation ②: injecting an engine-name branch comparison turns the branch-literal assertion red", () => {
  const clean = "export function f(engine) { return engine.length; }\n";
  withTempFile(clean, (file) => {
    const before = findBranchLiterals(fs.readFileSync(file, "utf8"));
    assert.deepEqual(before, []);
  });

  const mutated =
    'export function f(engine) { if (engine === "claude") return 1; return 0; }\n';
  withTempFile(mutated, (file) => {
    const after = findBranchLiterals(fs.readFileSync(file, "utf8"));
    assert.ok(
      after.length >= 1,
      "expected the injected branch literal to be flagged RED",
    );
  });
});

test("mutation ③: deleting one allowlist row makes the repo-wide scan report a new (unlisted) hit", () => {
  const { parsed } = loadAllowlist();
  assert.ok(
    parsed.literalExceptions.length > 0,
    "allowlist must be non-empty for this mutation to be meaningful",
  );
  const removed = parsed.literalExceptions[0];
  const shrunk = {
    ...parsed,
    literalExceptions: parsed.literalExceptions.slice(1),
  };
  const { literalHits } = scanRepo();
  const actualKeys = new Set(literalHits.map(literalKey));
  const expectedKeys = new Set(shrunk.literalExceptions.map(literalKey));
  const { newOnes } = setDiff(actualKeys, expectedKeys);
  assert.ok(
    newOnes.includes(literalKey(removed)),
    `expected removing ${JSON.stringify(removed)} from the allowlist to surface it as an unlisted hit`,
  );
});
