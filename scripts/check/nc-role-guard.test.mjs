// NC-2 negative-control: role-guard (Claude PreToolUse write-boundary hook).
//
// Every case calls checkRoleWrite({role, filePath, repoRoot, toolInput})
// directly with a synthetic `repoRoot` (mkdtemp fixture path, never
// resolved on disk -- checkRoleWrite does pure string comparison, it never
// stats the path) -- design §2-2: repoRoot is an injectable argument at
// role-guard.mjs:66, so no real workspace/settings file is ever touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkRoleWrite } from "./role-guard.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// A synthetic repo root -- never created on disk. checkRoleWrite's whole
// decision is string-normalization + prefix comparison (path-normalize.mjs),
// no fs access, so this is safe to use without mkdirSync.
const FAKE_ROOT = "C:/fake-repo-root-nc2";

test("NC-2 role-guard/attack: ORCH writes .harness/coder-task.md -> PASS (allowed lane)", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: `${FAKE_ROOT}/.harness/coder-task.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, true);
});

test("NC-2 role-guard/attack: ORCH writes scripts/check/whatever.mjs -> BLOCKED", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: `${FAKE_ROOT}/scripts/check/whatever.mjs`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ORCH may only write/);
});

test("NC-2 role-guard/attack: ORCH writes docs/enforcement-known-gaps.md -> BLOCKED", () => {
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: `${FAKE_ROOT}/docs/enforcement-known-gaps.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ORCH may only write/);
});

test("NC-2 role-guard/attack: CODER writes .harness/review.md (self-approval forgery) -> BLOCKED", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}/.harness/review.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /owned by another role/);
});

test("NC-2 role-guard/attack: CODER writes .harness/verify.md -> BLOCKED", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}/.harness/verify.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
});

test("NC-2 role-guard/attack: CODER writes .harness/coder-task.md (task file, ORCH-owned) -> BLOCKED", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}/.harness/coder-task.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
});

test("NC-2 role-guard/attack: REVIEW writes anything other than .harness/review.md -> BLOCKED", () => {
  const result = checkRoleWrite({
    role: "REVIEW",
    filePath: `${FAKE_ROOT}/src/app.mjs`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
});

test("NC-2 role-guard/attack: PM writes anything inside the repo -> BLOCKED (PM lane = control room only)", () => {
  const result = checkRoleWrite({
    role: "PM",
    filePath: `${FAKE_ROOT}/.harness/coder-task.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PM may not write inside the repo/);
});

// --- KNOWN GAP: outside-repo paths are entirely unregulated by design ---
test("NC-2 role-guard/gap: a path outside the repo root (control-room doc) -> PASS = 'not regulated' -- designed scope, not a bug -> KNOWN GAP (docs/enforcement-v1.md)", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath:
      "D:/\uBB38\uC11C\uAD00\uB9AC/\uD558\uB124\uC2A4-\uAD00\uC81C\uC2E4/STATUS.md",
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(
    result.ok,
    true,
    "current behavior: role-guard only regulates paths inside repoRoot; any out-of-repo write (e.g. the control room) passes through unchecked -- this is the documented, designed scope boundary, not a bypass of an intended check",
  );
  assert.match(result.reason, /outside the repo root/);
});

// --- path-form robustness (must all resolve to the SAME regulated path) ---
test("NC-2 role-guard/attack: relative '..' escape attempt back into the same review.md -> normalized and still BLOCKED for CODER", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}/.harness/../.harness/review.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(
    result.ok,
    false,
    "'..' segments are normalized away by path-normalize.mjs before the role check runs, so this does not slip past as a different-looking path",
  );
});

test("NC-2 role-guard/attack: case-varied path ('.HARNESS/Review.MD') -> normalized case-insensitively, still BLOCKED for CODER", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}/.HARNESS/Review.MD`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(
    result.ok,
    false,
    "path-normalize.mjs lower-cases both sides of the repo-relative comparison, so case variation alone does not evade the role match",
  );
});

test("NC-2 role-guard/attack: backslash-form path ('.harness\\\\review.md') -> normalized to forward slashes, still BLOCKED for CODER", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}\\.harness\\review.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
});

test("NC-2 role-guard/measurement: URL-encoded path ('.harness/revi%65w.md') is NOT percent-decoded -- treated as a literal, different filename, so it does not match the review.md rule at all (passes as an ordinary CODER write, not a bypass of a decoded match)", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: `${FAKE_ROOT}/.harness/revi%65w.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  // normalizeToRepoRelative performs no percent-decoding, so this resolves
  // to the literal relative path '.harness/revi%65w.md', which does not
  // equal '.harness/review.md' -- the TASK_FILE_RE/isReviewFile checks
  // simply don't match, and it falls through to the generic CODER-write
  // allow rule. Confirmed here so the distinction from a real decode-bypass
  // is on record precisely (this is inert, not a hole -- an attacker cannot
  // use this to write review.md itself; they can only create an oddly-named
  // *different* file, which the generic CODER write rule already permits).
  assert.equal(
    result.ok,
    true,
    "current behavior: percent-encoded path segments are compared literally, not decoded, so they simply miss the review.md/verify.md/task-file patterns rather than defeating them",
  );
});

// --- malformed inputs: no exception leakage ---
test("NC-2 role-guard/attack: filePath is null -> ok:false with a reason string, no exception", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: null,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no file path provided/);
});

test("NC-2 role-guard/attack: filePath is an object -> ok:false with a reason string, no exception", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: {},
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no file path provided/);
});

test("NC-2 role-guard/attack: filePath is an empty string -> ok:false with a reason string, no exception", () => {
  const result = checkRoleWrite({
    role: "CODER",
    filePath: "",
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no file path provided/);
});

// --- role unspecified / unknown -> fail-open (HYK-156 prior-recorded debt) ---
test("NC-2 role-guard/gap: role is undefined -> fail-open (ok:true, warn:true), no restriction applied -> KNOWN GAP (HYK-156 role-guard fail-open debt)", () => {
  const result = checkRoleWrite({
    role: undefined,
    filePath: `${FAKE_ROOT}/.harness/review.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(
    result.ok,
    true,
    "current behavior: an unset HARNESS_ROLE fails open, letting an otherwise-forbidden write (CODER forging review.md) through unchecked",
  );
  assert.equal(result.warn, true);
});

test("NC-2 role-guard/gap: role is an unrecognized string ('ADMIN') -> fail-open (ok:true, warn:true) -> KNOWN GAP (same HYK-156 family)", () => {
  const result = checkRoleWrite({
    role: "ADMIN",
    filePath: `${FAKE_ROOT}/.harness/review.md`,
    repoRoot: FAKE_ROOT,
    toolInput: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.warn, true);
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-role-guard.test.mjs must leave the real worktree exactly as it found it (before/after invariance, not empty)",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-role-guard.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
