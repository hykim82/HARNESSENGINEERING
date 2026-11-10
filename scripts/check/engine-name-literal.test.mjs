// HYK-153 engine-split-2 (coder-task.md §2, rework of engine-split-1) --
// pins the current engine-name string-literal, template-literal,
// regex-literal and branch-literal *occurrence count* in scripts/**/*.mjs
// (tests and fixtures excluded) against an allowlist, so any *new* hardcoded
// engine name -- or any *additional occurrence* of an already-allowed one,
// or any drift in the allowlist itself -- turns this test, and CI, red.
// This round only freezes today's baseline; it does not reduce the
// hardcoding (that is HYK-153 piece B).
//
// Tokenizer: strips `//` and `/* */` comments, then extracts string and
// template literals (handling backslash escapes and `${}` interpolation,
// whose expression body is scanned as code, not literal text) *and* the
// body text of regex literals (review 1R P2-3: a regex literal such as
// `/codex/i` previously fell into neither the literal axis nor the branch
// axis). The anchor pattern is tested against extracted literal text only,
// never against comments or bare identifiers.
//
// Comparison axis (review 1R P1-1 fix): a (file, literal) or (file, branch
// match) key is compared as a *multiset* -- the allowlist pins how many
// times each key occurs, not just whether it occurs at all. Previously two
// Sets were diffed, so adding a second `engine === "codex"` branch (or a
// second `"claude"` literal) to a file that already had one was invisible
// to this test. See the "already-allowed key, one more occurrence" copy
// tests below for the regression this closes.

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
// review 1R P2-7: the old pattern matched any literal that merely *starts*
// with an anchor word plus a quote char, so `"claude-settings"` (a distinct
// identifier, not an engine-name comparison) was counted as a branch
// literal on `"claude"`. Fixed by requiring the literal's content to be
// *exactly* the anchor word (lookahead on the same quote char closing it
// immediately) -- except for the `gpt-` anchor, which is deliberately a
// prefix (model names like `gpt-5.6` legitimately continue after it).
export const BRANCH_LITERAL_PATTERN =
  /[=!]==\s*(["'`])(claude|codex|sonnet|opus|haiku|fable|anthropic|openai)(?=\1)|[=!]==\s*["'`](gpt-)/gi;

// ---- tokenizer: comments stripped, string/template/regex literals extracted ----

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
// the trailing flags), the raw text consumed (pushed to `decommented`
// verbatim so branch-literal scanning still sees the same byte span), and
// `body` -- the text strictly between the delimiting slashes (review 1R
// P2-3: now scanned as a literal, same as a quoted string). An unterminated
// regex (shouldn't happen in valid JS; bails out at the line break) reports
// body "" rather than guessing.
function consumeRegexLiteral(source, startIndex) {
  const n = source.length;
  let i = startIndex + 1;
  let inCharClass = false;
  let closed = false;
  while (i < n) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") break; // unterminated regex -- bail out
    if (ch === "[") inCharClass = true;
    else if (ch === "]") inCharClass = false;
    else if (ch === "/" && !inCharClass) {
      closed = true;
      i += 1;
      break;
    }
    i += 1;
  }
  const bodyEnd = closed ? i - 1 : i;
  const body = closed ? source.slice(startIndex + 1, bodyEnd) : "";
  // trailing flags
  while (i < n && /[a-z]/i.test(source[i])) i += 1;
  return { endIndex: i, raw: source.slice(startIndex, i), body };
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
  const { endIndex, raw, body } = consumeRegexLiteral(state.source, state.i);
  if (body.length > 0) {
    state.literals.push({ text: body, line: state.line });
  }
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
// quoted string, one per template-literal text chunk (the parts outside
// `${}`), and one per non-empty regex-literal body.
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

export function literalKey(h) {
  return `${h.file}\u0000${h.literal}`;
}
export function branchKey(h) {
  return `${h.file}\u0000${h.match}`;
}

// ---- multiset comparison (review 1R P1-1 fix) ----
//
// A plain Set diff (old behavior) only asks "does this key exist at all,
// in the actual scan vs. the allowlist?" -- so once a (file, literal) or
// (file, branch-match) key was allowed once, any *further* occurrence of
// the exact same key in the exact same file was invisible: both sides'
// Sets already contained the key, so no diff. These three helpers instead
// compare *occurrence counts* per key.

// hits: literalHits or branchHits. keyFn: literalKey or branchKey.
export function countByKey(hits, keyFn) {
  const counts = new Map();
  for (const h of hits) {
    const k = keyFn(h);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// allowlistRows: literalExceptions or branchLiteralBaseline rows, each
// carrying an explicit `count` (defaults to 1 if the row omits it, for
// backward-compatible schemas). Rows that repeat the same key have their
// counts summed, so either "one row per key with a count" or "one row per
// occurrence" is a valid allowlist shape.
export function expectedCountByKey(allowlistRows, keyFn) {
  const counts = new Map();
  for (const row of allowlistRows) {
    const k = keyFn(row);
    const c = typeof row.count === "number" ? row.count : 1;
    counts.set(k, (counts.get(k) ?? 0) + c);
  }
  return counts;
}

// Returns { newOnes, stale } -- each entry is `"<key> (actual A > expected
// E)"` / `"<key> (actual A < expected E)"` so a widened-but-undeclared
// occurrence count is distinguishable from a brand-new key (E=0) or a
// stale allowlist row (A=0) in the assertion failure message.
export function multisetDiff(actualCounts, expectedCounts) {
  const keys = new Set([...actualCounts.keys(), ...expectedCounts.keys()]);
  const newOnes = [];
  const stale = [];
  for (const k of keys) {
    const a = actualCounts.get(k) ?? 0;
    const e = expectedCounts.get(k) ?? 0;
    if (a > e) newOnes.push(`${k} (actual ${a} > expected ${e})`);
    if (a < e) stale.push(`${k} (actual ${a} < expected ${e})`);
  }
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
  "3e39e367e6d2eb588cab8225db3b119a652296e67ea463efe2c7377995d48579";

test("allowlist file hash is pinned (widening the allowlist must show in the diff)", () => {
  const { sha256 } = loadAllowlist();
  assert.equal(sha256, EXPECTED_ALLOWLIST_SHA256);
});

test("allowlist schema: every literal/branch row has a recognized category (literals only) and a positive integer count", () => {
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
    assert.ok(
      Number.isInteger(row.count) && row.count >= 1,
      `count must be a positive integer in ${JSON.stringify(row)}`,
    );
  }
  assert.ok(Array.isArray(parsed.branchLiteralBaseline));
  for (const row of parsed.branchLiteralBaseline) {
    assert.ok(typeof row.file === "string" && row.file.length > 0);
    assert.ok(typeof row.match === "string" && row.match.length > 0);
    assert.ok(
      Number.isInteger(row.count) && row.count >= 1,
      `count must be a positive integer in ${JSON.stringify(row)}`,
    );
  }
});

test("repo-wide anchor-literal scan: per-key occurrence count exactly matches the allowlist (multiset)", () => {
  const { parsed } = loadAllowlist();
  const { literalHits } = scanRepo();

  const actual = countByKey(literalHits, literalKey);
  const expected = expectedCountByKey(parsed.literalExceptions, literalKey);
  const { newOnes, stale } = multisetDiff(actual, expected);

  assert.deepEqual(
    newOnes,
    [],
    `new engine-name literal(s), or more occurrences of an already-allowed one, not matching the allowlist count: ${JSON.stringify(newOnes)}`,
  );
  assert.deepEqual(
    stale,
    [],
    `stale allowlist entries/counts no longer present in scripts/: ${JSON.stringify(stale)}`,
  );
});

test("repo-wide branch-literal scan: per-key occurrence count exactly matches the pinned baseline (multiset)", () => {
  const { parsed } = loadAllowlist();
  const { branchHits } = scanRepo();

  const actual = countByKey(branchHits, branchKey);
  const expected = expectedCountByKey(parsed.branchLiteralBaseline, branchKey);
  const { newOnes, stale } = multisetDiff(actual, expected);

  assert.deepEqual(
    newOnes,
    [],
    `new engine-name branch literal(s), or more occurrences of an already-pinned one, not matching the baseline count: ${JSON.stringify(newOnes)}`,
  );
  assert.deepEqual(
    stale,
    [],
    `branch-literal baseline entries/counts no longer present in scripts/ (baseline is pinned, not "<=''): ${JSON.stringify(stale)}`,
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

// ---- tokenizer: regex-literal body is now scanned (review 1R P2-3) ----

test("tokenizer: a regex literal's body is scanned as a literal (previously a blind spot)", () => {
  const src = "const isEngine = /codex|claude/i.test(name);\n";
  const hits = findAnchorHits(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "codex|claude");
});

test("tokenizer: regex-literal vs. division disambiguation is unaffected by anchor scanning", () => {
  // `a / b` after an identifier is division, not a regex literal -- the
  // literal/regex content "codex" here must NOT be read as a literal at
  // all (there is no literal here; this just guards against a regression
  // where regex detection starts misreading division as a regex start).
  const src = "const codex = a / b / c;\n";
  const hits = findAnchorHits(src);
  assert.deepEqual(hits, []);
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

// ---- branch-literal: prefix-match false positive (review 1R P2-7) ----

test("branch-literal: a longer identifier that merely starts with the anchor word is not a branch literal", () => {
  // "claude-settings" is a distinct identifier, not an engine-name
  // comparison -- the old pattern matched on the `["'`]claude` prefix alone
  // and counted this as a branch literal on "claude".
  const src = 'if (target.kind === "claude-settings") { return 1; }\n';
  const hits = findBranchLiterals(src);
  assert.deepEqual(hits, []);
});

test("branch-literal: the gpt- anchor is still deliberately a prefix match (model names continue after it)", () => {
  const src = 'if (model === "gpt-5.6") { return 1; }\n';
  const hits = findBranchLiterals(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0], '=== "gpt-');
});

// ---- mkdtemp-copy mutation regression (synthetic sample content, not a
// copy of production logic -- these exercise the *real* exported scanner
// functions above against deliberately mutated synthetic source text, per
// coder-task.md §2 ⓘⓘ "시험 안 mkdtemp 사본 변이") ----

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

test("mutation ③: deleting one allowlist row's count surfaces its occurrence(s) as a new (unlisted) hit", () => {
  const { parsed } = loadAllowlist();
  assert.ok(
    parsed.literalExceptions.length > 0,
    "allowlist must be non-empty for this mutation to be meaningful",
  );
  const removed = parsed.literalExceptions[0];
  const shrunk = parsed.literalExceptions.slice(1);
  const { literalHits } = scanRepo();
  const actual = countByKey(literalHits, literalKey);
  const expected = expectedCountByKey(shrunk, literalKey);
  const { newOnes } = multisetDiff(actual, expected);
  assert.ok(
    newOnes.some((entry) => entry.startsWith(`${literalKey(removed)} (`)),
    `expected removing ${JSON.stringify(removed)} from the allowlist to surface it as an unlisted hit: ${JSON.stringify(newOnes)}`,
  );
});

// ---- PM 설계 §b ⑴: layered-file *copy* mutations that go all the way
// through the allowlist comparison (keyCount + multisetDiff), not just the
// bare findAnchorHits/findBranchLiterals calls -- review 1R flagged that a
// copy-mutation test which stops at the bare detector functions is not
// evidence the allowlist-comparison step itself would turn red (mutation
// ①② above are exactly that weaker shape; these four are the stronger
// one). Each builds a throwaway `<tmp>/scripts/...` tree via scanRepo's own
// repoRoot parameter -- a real directory walk, not a copy-import of
// production code -- and a synthetic allowlist sized to the *clean*
// version of the sample, then mutates the file on disk and re-scans. ----

function withCopyRepo(relPath, content, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-copy-repo-"));
  const abs = path.join(root, "scripts", relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  try {
    return fn(root, abs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("copy-mutation (literal, via allowlist comparison): injecting a new literal into a layered-file copy is RED", () => {
  const clean = "export function f(x) { return x + 1; }\n";
  withCopyRepo("relay/adapters/sample-adapter.mjs", clean, (root) => {
    const { literalHits } = scanRepo(root);
    const expected = expectedCountByKey([], literalKey);
    const before = multisetDiff(countByKey(literalHits, literalKey), expected);
    assert.deepEqual(before.newOnes, []);

    fs.writeFileSync(
      path.join(root, "scripts", "relay/adapters/sample-adapter.mjs"),
      'export function f(x) { const e = "codex"; return x + 1; }\n',
      "utf8",
    );
    const { literalHits: afterHits } = scanRepo(root);
    const after = multisetDiff(countByKey(afterHits, literalKey), expected);
    assert.ok(
      after.newOnes.length >= 1,
      "expected the injected literal to turn the allowlist comparison RED",
    );
  });
});

test("copy-mutation (branch, via allowlist comparison): injecting a new engine-name branch into a layered-file copy is RED", () => {
  const clean = "export function f(engine) { return engine.length; }\n";
  withCopyRepo("relay/adapters/sample-adapter.mjs", clean, (root) => {
    const { branchHits } = scanRepo(root);
    const expected = expectedCountByKey([], branchKey);
    const before = multisetDiff(countByKey(branchHits, branchKey), expected);
    assert.deepEqual(before.newOnes, []);

    fs.writeFileSync(
      path.join(root, "scripts", "relay/adapters/sample-adapter.mjs"),
      'export function f(engine) { if (engine === "claude") return 1; return 0; }\n',
      "utf8",
    );
    const { branchHits: afterHits } = scanRepo(root);
    const after = multisetDiff(countByKey(afterHits, branchKey), expected);
    assert.ok(
      after.newOnes.length >= 1,
      "expected the injected branch comparison to turn the allowlist comparison RED",
    );
  });
});

test("copy-mutation (P1-1 regression): one MORE occurrence of an already-allowed key, via allowlist comparison, is RED", () => {
  // This is the exact shape review 1R's M5 found live on orca-adapter.mjs:
  // a file that already has an allowed `engine === "codex"` branch and an
  // allowed "claude" literal gets a *second* occurrence of each -- a plain
  // Set-membership comparison stays green because the key already existed;
  // the multiset comparison must go RED because the count changed.
  const clean =
    'export function f(engine) { if (engine === "codex") { return "claude"; } return 0; }\n';
  withCopyRepo("relay/adapters/sample-adapter.mjs", clean, (root) => {
    const relFile = "scripts/relay/adapters/sample-adapter.mjs";
    const { literalHits, branchHits } = scanRepo(root);
    const expectedLiteral = expectedCountByKey(
      [
        { file: relFile, literal: "claude", count: 1 },
        { file: relFile, literal: "codex", count: 1 },
      ],
      literalKey,
    );
    const expectedBranch = expectedCountByKey(
      [{ file: relFile, match: '=== "codex', count: 1 }],
      branchKey,
    );
    const beforeLiteral = multisetDiff(
      countByKey(literalHits, literalKey),
      expectedLiteral,
    );
    const beforeBranch = multisetDiff(
      countByKey(branchHits, branchKey),
      expectedBranch,
    );
    assert.deepEqual(beforeLiteral.newOnes, []);
    assert.deepEqual(beforeLiteral.stale, []);
    assert.deepEqual(beforeBranch.newOnes, []);
    assert.deepEqual(beforeBranch.stale, []);

    // Inject one MORE occurrence of the exact same already-allowed key on
    // both axes -- nothing new in the Set sense, but the count changes.
    fs.writeFileSync(
      path.join(root, relFile.replace(/^scripts\//, "scripts/")),
      'export function f(engine) { if (engine === "codex") { return "claude"; } if (engine === "codex") { return "claude"; } return 0; }\n',
      "utf8",
    );
    const { literalHits: afterLit, branchHits: afterBranch } = scanRepo(root);
    const afterLiteralDiff = multisetDiff(
      countByKey(afterLit, literalKey),
      expectedLiteral,
    );
    const afterBranchDiff = multisetDiff(
      countByKey(afterBranch, branchKey),
      expectedBranch,
    );
    assert.ok(
      afterLiteralDiff.newOnes.some((e) =>
        e.startsWith(`${relFile}\u0000claude (`),
      ),
      `expected the second "claude" occurrence to be RED: ${JSON.stringify(afterLiteralDiff.newOnes)}`,
    );
    assert.ok(
      afterBranchDiff.newOnes.some((e) =>
        e.startsWith(`${relFile}\u0000=== "codex (`),
      ),
      `expected the second === "codex" occurrence to be RED: ${JSON.stringify(afterBranchDiff.newOnes)}`,
    );
  });
});

test("copy-mutation (regex-literal, via allowlist comparison): an engine name hidden in a new regex literal is RED", () => {
  const clean = "export function f(name) { return name.length; }\n";
  withCopyRepo("check/sample-detect.mjs", clean, (root) => {
    const { literalHits } = scanRepo(root);
    const expected = expectedCountByKey([], literalKey);
    const before = multisetDiff(countByKey(literalHits, literalKey), expected);
    assert.deepEqual(before.newOnes, []);

    fs.writeFileSync(
      path.join(root, "scripts", "check/sample-detect.mjs"),
      "export function f(name) { const isEngine = /codex|claude/i.test(name); return isEngine; }\n",
      "utf8",
    );
    const { literalHits: afterHits } = scanRepo(root);
    const after = multisetDiff(countByKey(afterHits, literalKey), expected);
    assert.ok(
      after.newOnes.length >= 1,
      "expected the engine name hidden in a new regex literal to turn the allowlist comparison RED",
    );
  });
});
