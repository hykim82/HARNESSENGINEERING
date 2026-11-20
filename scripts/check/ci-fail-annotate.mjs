// HYK-459-ci-fail-annot-1: CI failure summary -> GitHub check-run annotations.
//
// WHY: when enforce.yml's `check test suites` step goes red, its only
// annotation is "Process completed with exit code 1"; the failing test names
// sit in a step log that needs a GitHub login to read. This script reads the
// per-run logs the test runner (isolated-suite-runner.mjs, via `npm test`)
// ALREADY writes inside the checkout -- `.harness/full-runner-<N>.log` (spec
// reporter) and, when the serial family ran, `.harness/full-runner-<N>-serial
// .log` -- and prints `::error` workflow commands, which GitHub turns into
// check-run annotations that are readable anonymously. The test step is not
// touched at all (no pipe, no tee), so its exit code is unchanged by
// construction (owner-side ruling, ORCH answer to msg_31dac022b293).
//
// WHAT IT IS NOT: an OBSERVER, not a gate. It runs only from a step guarded by
// `if: failure()`, it ALWAYS exits 0 (runCli below), and it never decides
// whether the job passed -- the job result is the test step's own exit code.
//
// WHAT AN ANNOTATION MAY CARRY: a test file path, a test name and counts --
// nothing else. Names are scrubbed (VAR=value, token shapes, long opaque
// strings, and the values of sensitive-named process env vars) because a
// test name is free text. Error bodies and stack traces are never printed.
//
// INPUT SHAPES (extractFailures), in ranking order:
//   1. the runner's own sweep message: `Failing test(s) (file:line -- name):`
//      followed by `<loc> -- <name>` lines (hyk359-ambient-env-regression)
//   2. node --test spec reporter, the end-of-run `✖ failing tests:` block:
//      `test at <loc>:L:C` then `✖ <name> (<ms>ms)`
//   3. TAP `not ok N - <name>` + `location: '<loc>'`
//   4. last resort: bare `✖ <name> (<ms>ms)` stream lines (no file) -- the
//      only thing a timeout-cut output can still contain.
// HONEST LIMIT: these shapes were captured on Node v26 (this author's
// machine); CI pins Node 20 and its spec reporter was not run here. A shape
// change degrades to the "could not extract" annotation (never a silent 0).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ANNOTATIONS = 10;
// Mirrors runner-receipt-writer.mjs's RUNNER_LOG_PREFIX and the `-serial.log`
// suffix isolated-suite-runner.mjs derives (kept as local copies so this file
// stays dependency-free; ci-fail-annotate.test.mjs pins both against the
// producers so a rename there cannot silently blind this reader).
export const RUNNER_LOG_PREFIX = "full-runner-";
export const DEFAULT_LOG_DIR = ".harness";
const MAIN_LOG_RE = new RegExp(`^${RUNNER_LOG_PREFIX}(\\d+)\\.log$`);
const MAX_NAME_LEN = 200;
const FILTERED = "[filtered]";
const TITLE_ITEM = "failed test";
const TITLE_UNPARSED = "failed tests not extracted";

// eslint-disable-next-line no-control-regex -- stripping terminal escapes
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// every C0 control except \t \n \r (handled separately below)
// eslint-disable-next-line no-control-regex -- stripping control bytes
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const SENSITIVE_ENV_NAME_RE =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|(?:^|_)KEY$|(?:^|_)PAT$)/i;

// Order matters: specific shapes first so the generic ones see what is left.
const SECRET_SHAPES = [
  /\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+\S+/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Z][A-Z0-9_]{2,}=\S*/g,
];
// a long unbroken letters+digits run (hex digest, base64-ish token); plain
// words and paths (they carry `/`, `-`, `.`) are not touched
const OPAQUE_RUN_RE = /[A-Za-z0-9]{32,}/g;

function scrubEnvValues(text, env) {
  let out = text;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!SENSITIVE_ENV_NAME_RE.test(key)) continue;
    out = out.split(value).join(FILTERED);
  }
  return out;
}

export function scrubName(raw, env = {}) {
  let s = String(raw ?? "")
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\t/g, " ");
  s = scrubEnvValues(s, env);
  for (const re of SECRET_SHAPES) s = s.replace(re, FILTERED);
  s = s.replace(OPAQUE_RUN_RE, (run) =>
    /[0-9]/.test(run) && /[A-Za-z]/.test(run) ? FILTERED : run,
  );
  // never let a name open a second workflow command on the same line
  s = s.replace(/::/g, ": :");
  if (s.length > MAX_NAME_LEN) s = `${s.slice(0, MAX_NAME_LEN - 1)}…`;
  return s.trim();
}

// GitHub workflow-command escaping (actions/toolkit command.ts rules).
function escapeData(s) {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}
function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// `<loc>` is a path, optionally `file://`-prefixed, optionally Windows-shaped,
// optionally followed by `:line` or `:line:col`. Returns a repo-relative,
// slash-separated path plus the line, or null when it is not a source path.
export function normalizeTestPath(loc) {
  if (typeof loc !== "string") return null;
  let s = loc
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:(?=\/)/, "");
  const m = /^(.*?\.[cm]?[jt]sx?)(?::(\d+))?(?::\d+)?$/.exec(s);
  if (!m) return null;
  s = m[1];
  const anchored = /(?:^|\/)((?:scripts|templates|hooks)\/.+)$/.exec(s);
  let file;
  if (anchored) file = anchored[1];
  else if (s.startsWith("/")) file = s.slice(s.lastIndexOf("/") + 1);
  else file = s;
  file = file.replace(/\/{2,}/g, "/");
  if (file === "" || file.split("/").includes("..")) return null;
  return { file, line: m[2] ? Number(m[2]) : null };
}

const SPEC_FAIL_RE = /^(\s*)✖ (.+?) \((\d+(?:\.\d+)?)ms\)\s*$/;
const SPEC_AT_RE = /^test at (.+?):(\d+):(\d+)\s*$/;
const SWEEP_HEADER_RE = /Failing test\(s\) \(file:line -- name\):\s*$/;
const SWEEP_ITEM_RE = /^\s*(.+?\.[cm]?[jt]sx?:\d+(?::\d+)?) -- (.+?)\s*$/;
const TAP_FAIL_RE = /^\s*not ok \d+ - (.+?)\s*$/;
const TAP_ANY_RE = /^\s*(?:not )?ok \d+ |^\s*# Subtest:/;
const TAP_LOC_RE = /^\s*location: '(.*)'\s*$/;

function fromLoc(loc, name) {
  const p = normalizeTestPath(loc);
  return { file: p?.file ?? null, line: p?.line ?? null, name };
}

function collectSweepItems(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SWEEP_HEADER_RE.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = SWEEP_ITEM_RE.exec(lines[j]);
      if (!m) break;
      out.push(fromLoc(m[1], m[2]));
    }
  }
  return out;
}

function collectSpecBlockItems(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const at = SPEC_AT_RE.exec(lines[i]);
    if (!at) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const fail = j < lines.length ? SPEC_FAIL_RE.exec(lines[j]) : null;
    if (fail) out.push(fromLoc(`${at[1]}:${at[2]}`, fail[2]));
  }
  return out;
}

function collectTapItems(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TAP_FAIL_RE.exec(lines[i]);
    if (!m) continue;
    let loc = null;
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      if (TAP_ANY_RE.test(lines[j])) break;
      const lm = TAP_LOC_RE.exec(lines[j]);
      if (lm) {
        loc = lm[1];
        break;
      }
    }
    out.push(loc ? fromLoc(loc, m[1]) : { file: null, line: null, name: m[1] });
  }
  return out;
}

function collectStreamItems(lines) {
  const out = [];
  for (const line of lines) {
    const m = SPEC_FAIL_RE.exec(line);
    if (!m) continue;
    const name = m[2];
    // a file-level failure prints the file itself as the name
    const p = /\.[cm]?[jt]sx?$/.test(name) ? normalizeTestPath(name) : null;
    out.push(
      p && p.file.includes("/")
        ? { file: p.file, line: null, name }
        : { file: null, line: null, name },
    );
  }
  return out;
}

function lastNumber(text, re) {
  const all = [...text.matchAll(re)];
  return all.length > 0 ? Number(all[all.length - 1][1]) : null;
}

// "last match" on purpose: a nested child run (a test that itself runs
// `node --test`) can print an earlier, fake summary.
function readSummary(text) {
  const tests =
    lastNumber(text, /^ℹ tests (\d+)\s*$/gm) ??
    lastNumber(text, /^# tests (\d+)\s*$/gm);
  if (tests === null) return null;
  const fail =
    lastNumber(text, /^ℹ fail (\d+)\s*$/gm) ??
    lastNumber(text, /^# fail (\d+)\s*$/gm);
  return { tests, fail };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.file}|${it.line}|${it.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// Pure: output text -> { items, summary, cut, empty }. `items` is the whole
// deduplicated list (uncapped); buildAnnotations applies the cap.
export function extractFailures(text) {
  const raw = typeof text === "string" ? text : "";
  const clean = raw.replace(ANSI_RE, "");
  const lines = clean.split(/\r?\n/);
  const located = dedupe([
    ...collectSweepItems(lines),
    ...collectSpecBlockItems(lines),
    ...collectTapItems(lines),
  ]);
  const items =
    located.length > 0 ? located : dedupe(collectStreamItems(lines));
  const summary = readSummary(clean);
  return {
    items,
    summary,
    cut: summary === null,
    empty: raw.trim() === "",
  };
}

// Pure over directory entry names: the highest-numbered full-runner-<N>.log
// wins (the runner allocates N upward; consumers already treat the largest N
// as the latest run) together with its -serial.log twin when present.
export function pickLatestRunnerLogs(names) {
  let best = null;
  for (const name of names ?? []) {
    const m = MAIN_LOG_RE.exec(name);
    if (m && (best === null || Number(m[1]) > best)) best = Number(m[1]);
  }
  if (best === null) return null;
  const main = `${RUNNER_LOG_PREFIX}${best}.log`;
  const serial = `${RUNNER_LOG_PREFIX}${best}-serial.log`;
  return {
    n: best,
    main,
    serial: (names ?? []).includes(serial) ? serial : null,
  };
}

// Merges the per-log extractions of ONE run (main pass + serial family pass).
export function mergeExtractions(parts) {
  const items = dedupe(parts.flatMap((p) => p.items));
  const summaries = parts.map((p) => p.summary).filter((s) => s !== null);
  const fails = summaries.map((s) => s.fail).filter((n) => n !== null);
  return {
    items,
    summary:
      summaries.length === 0
        ? null
        : {
            tests: summaries.reduce((a, s) => a + s.tests, 0),
            fail: fails.length === 0 ? null : fails.reduce((a, n) => a + n, 0),
          },
    cut: parts.some((p) => p.cut),
    empty: parts.every((p) => p.empty),
  };
}

// Reads + extracts the latest runner logs under `dir`. Never throws: a
// missing directory / no log / unreadable log is a flagged empty result that
// buildAnnotations turns into the single "could not extract" annotation.
export function extractFromLogDir(
  dir,
  { readdir = readdirSync, readFile = readFileSync } = {},
) {
  let names;
  try {
    names = readdir(dir);
  } catch {
    return { items: [], summary: null, cut: false, unreadable: true };
  }
  const pick = pickLatestRunnerLogs(names);
  if (pick === null) {
    return { items: [], summary: null, cut: false, noLogs: true };
  }
  const parts = [];
  for (const name of [pick.main, pick.serial]) {
    if (name === null) continue;
    try {
      parts.push(extractFailures(readFile(join(dir, name), "utf8")));
    } catch {
      return { items: [], summary: null, cut: false, unreadable: true };
    }
  }
  return { ...mergeExtractions(parts), runNumber: pick.n };
}

function unparsedReason(result) {
  if (result.unreadable)
    return "the runner log directory or log file is missing or unreadable (the test step may have died before the runner started)";
  if (result.noLogs)
    return "no full-runner-<N>.log was found under the runner log directory (the runner may have failed before allocating its log)";
  if (result.empty) return "the runner log is empty";
  if (result.cut)
    return "the runner log has no test summary line (cut off by a timeout or a kill?) and no failed-test line";
  if (result.summary.fail === 0)
    return "the runner log reports fail 0 but the step failed (not a failed-test case)";
  return `the runner log reports ${result.summary.fail ?? "an unknown number of"} failed test(s) but no failed-test line could be parsed`;
}

function itemLine(item, env) {
  const name = scrubName(item.name, env) || FILTERED;
  const props = [];
  if (item.file) {
    props.push(`file=${escapeProperty(item.file)}`);
    if (item.line) props.push(`line=${item.line}`);
  }
  props.push(`title=${TITLE_ITEM}`);
  return `::error ${props.join(",")}::${escapeData(name)}`;
}

// Pure: extraction result -> annotation lines. At most `max` item lines, then
// ONE count line for the rest; zero extracted items while the step failed is
// ONE "could not extract" error (never a silent zero).
export function buildAnnotations(
  result,
  { max = MAX_ANNOTATIONS, stepFailed = true, env = process.env } = {},
) {
  const items = result.items ?? [];
  const lines = items.slice(0, max).map((it) => itemLine(it, env));
  if (items.length > max) {
    const rest = items.length - max;
    lines.push(
      `::warning title=more failed tests::${rest} more failed test(s) not shown (${items.length} failed in total, ${max} shown) -- open the step log for the rest`,
    );
  }
  if (items.length > 0 && result.cut) {
    lines.push(
      "::warning title=output cut off::the runner log has no test summary line -- the failed-test list above may be incomplete",
    );
  }
  if (items.length === 0 && stepFailed) {
    lines.push(
      `::error title=${TITLE_UNPARSED}::could not extract failed test names: ${escapeData(unparsedReason(result))}. Open the step log.`,
    );
  }
  return lines;
}

export function annotateOutput(text, options = {}) {
  return buildAnnotations(extractFailures(text), options);
}

// CLI body. ALWAYS returns 0: this runs inside an `if: failure()` step and
// must never change the job result. Every failure path becomes an annotation.
export function runCli(
  argv,
  {
    readdir = readdirSync,
    readFile = readFileSync,
    write = (s) => process.stdout.write(s),
    env = process.env,
  } = {},
) {
  let lines;
  try {
    const dir = argv[0] || DEFAULT_LOG_DIR;
    const result = extractFromLogDir(dir, { readdir, readFile });
    lines = buildAnnotations(result, { stepFailed: true, env });
  } catch (err) {
    lines = [
      `::error title=${TITLE_UNPARSED}::the annotate script failed internally (${escapeData(String(err?.name ?? "Error"))}). Open the step log.`,
    ];
  }
  try {
    write(`${lines.join("\n")}\n`);
  } catch {
    // stdout closed: nothing left to report to, and the exit code stays 0
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
    process.argv[1].replace(/\\/g, "/");
if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
