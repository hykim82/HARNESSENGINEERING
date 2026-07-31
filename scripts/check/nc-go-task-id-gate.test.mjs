// NC-2 negative-control: go-task-id-gate (UserPromptSubmit "go <task_id>"
// mismatch/omission gate).
//
// Every case calls checkGoTaskId({prompt, taskContent}) directly -- both
// exported as pure functions (design §2-2, go-task-id-gate.mjs:33/:48/:91)
// -- no real .harness/*-task.md is ever read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  extractPromptTaskId,
  checkGoTaskId,
  generateGoLine,
} from "./go-task-id-gate.mjs";

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

const TASK_OK = "task_id: HYK-183-nc2-relay-lane-negative-control-1\n";

test("NC-2 go-task-id-gate/attack: 'go <different task_id>' vs the dropped task file -> BLOCKED", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-9999-completely-different",
    taskContent: TASK_OK,
  });
  assert.equal(result.status, "BLOCK");
  assert.equal(result.ok, false);
  assert.match(result.reason, /TASK_ID_MISMATCH/);
});

test("NC-2 go-task-id-gate/attack: bare 'go' with no task_id at all -> BLOCKED (the safety pin's own purpose)", () => {
  const result = checkGoTaskId({ prompt: "go", taskContent: TASK_OK });
  assert.equal(result.status, "BLOCK");
  assert.equal(result.ok, false);
  assert.match(result.reason, /TASK_ID_REQUIRED/);
});

test("NC-2 go-task-id-gate/attack: 'go   ' (trailing whitespace only, no id) -> BLOCKED", () => {
  const result = checkGoTaskId({ prompt: "go   ", taskContent: TASK_OK });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /TASK_ID_REQUIRED/);
});

test("NC-2 go-task-id-gate/gap: taskContent is null (unreadable task file) -> UNJUDGABLE + fail-open (documented in source comment) -> KNOWN GAP", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-183-nc2-relay-lane-negative-control-1",
    taskContent: null,
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(
    result.ok,
    true,
    "current behavior: an unreadable/missing task file never blocks the prompt, it is treated as unverifiable and passed through",
  );
});

test("NC-2 go-task-id-gate/gap: taskContent has no task_id header -> UNJUDGABLE + fail-open -> KNOWN GAP", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-183-nc2-relay-lane-negative-control-1",
    taskContent: "no header here, just prose\n",
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(result.ok, true);
});

test("NC-2 go-task-id-gate/attack: 'go' appears mid-sentence, not at the start of the prompt -> not recognized as a go-prompt at all -> PASS (never reaches the id check)", () => {
  const result = checkGoTaskId({
    prompt: "please go HYK-183-nc2-relay-lane-negative-control-1 now",
    taskContent: TASK_OK,
  });
  assert.equal(result.status, "PASS");
  assert.match(result.reason, /not a go-prompt/);
  // isGoPrompt (worker-status-onstart.mjs) anchors GO_RE at the start of
  // the string (^\s*go\b); a mid-sentence "go" never matches, so this
  // gate never even engages -- confirmed by direct source inspection, not
  // a bypass of the id check (the check simply never runs on this input,
  // same as any other non-go prompt).
});

test("NC-2 go-task-id-gate/measurement: 'go' inside a code fence, but at the start of the (fenced) prompt text -> still recognized and checked (GO_RE only looks at prompt start, has no fence-awareness)", () => {
  const result = checkGoTaskId({
    prompt: "```\ngo HYK-9999-wrong\n```",
    taskContent: TASK_OK,
  });
  // The literal string starts with a backtick fence, not "go", so
  // GO_RE (^\s*go\b) does not match here either -- documenting the
  // actual boundary: it is purely "does the raw prompt string start with
  // go", with no markdown/fence awareness in either direction.
  assert.equal(result.status, "PASS");
  assert.match(result.reason, /not a go-prompt/);
});

test("NC-2 go-task-id-gate/attack: case variants 'GO <id>' and 'Go <id>' (uppercase/mixed) with a MISMATCHED id -> still recognized as go-prompts and BLOCKED", () => {
  const upper = checkGoTaskId({
    prompt: "GO HYK-9999-wrong",
    taskContent: TASK_OK,
  });
  assert.equal(
    upper.status,
    "BLOCK",
    "GO_RE is case-insensitive ('i' flag), so 'GO' is recognized as a go-prompt just like 'go'",
  );
  const mixed = checkGoTaskId({
    prompt: "Go HYK-9999-wrong",
    taskContent: TASK_OK,
  });
  assert.equal(mixed.status, "BLOCK");
});

test("NC-2 go-task-id-gate/attack: id with an extra suffix appended ('go <task_id>-extra') -> BLOCKED (exact-match comparison, not prefix/substring) -- proven, not a gap", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-183-nc2-relay-lane-negative-control-1-extra",
    taskContent: TASK_OK,
  });
  // extractPromptTaskId captures the WHOLE \S+ token after 'go ', so the
  // appended suffix becomes part of the captured id and the subsequent
  // strict === comparison against the file's task_id fails -- this is a
  // proven exact-match defense, not a partial-match bypass.
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /TASK_ID_MISMATCH/);
});

test("NC-2 go-task-id-gate/attack: id with a prefix prepended ('go x-<task_id>') -> BLOCKED (exact match, not suffix match)", () => {
  const result = checkGoTaskId({
    prompt: "go x-HYK-183-nc2-relay-lane-negative-control-1",
    taskContent: TASK_OK,
  });
  assert.equal(result.status, "BLOCK");
});

test("NC-2 go-task-id-gate/attack: prompt is not a string (number) -> ok:true/PASS via isGoPrompt's type guard, no exception", () => {
  const result = checkGoTaskId({ prompt: 12345, taskContent: TASK_OK });
  assert.equal(result.status, "PASS");
  assert.match(result.reason, /not a go-prompt/);
});

test("NC-2 go-task-id-gate/attack: prompt is null -> ok:true/PASS, no exception", () => {
  const result = checkGoTaskId({ prompt: null, taskContent: TASK_OK });
  assert.equal(result.status, "PASS");
});

test("NC-2 go-task-id-gate/attack: prompt is an object -> ok:true/PASS, no exception", () => {
  const result = checkGoTaskId({
    prompt: { toString: () => "go x" },
    taskContent: TASK_OK,
  });
  assert.equal(result.status, "PASS");
});

test("NC-2 go-task-id-gate/attack: exact matching id -> PASS (proven: legitimate go-drops are not blocked)", () => {
  const result = checkGoTaskId({
    prompt: "go HYK-183-nc2-relay-lane-negative-control-1",
    taskContent: TASK_OK,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.ok, true);
});

// --- generateGoLine (Part B: deterministic go-line generator) ---
test("NC-2 go-task-id-gate/attack: generateGoLine on a task file with no task_id header -> ok:false, no partial/guessed line, no exception", () => {
  const result = generateGoLine("no header\n");
  assert.equal(result.ok, false);
  assert.equal(result.line, undefined);
});

test("NC-2 go-task-id-gate/attack: generateGoLine on a well-formed task file -> exact 'go <task_id>' line, and checkGoTaskId(that exact line) round-trips to PASS", () => {
  const gen = generateGoLine(TASK_OK);
  assert.equal(gen.ok, true);
  assert.equal(gen.line, "go HYK-183-nc2-relay-lane-negative-control-1");
  const check = checkGoTaskId({ prompt: gen.line, taskContent: TASK_OK });
  assert.equal(check.status, "PASS");
});

// extractPromptTaskId direct coverage (used above indirectly; a couple of
// direct edge assertions for the token-boundary rule).
test("NC-2 go-task-id-gate/measurement: extractPromptTaskId returns null for bare 'go' and the exact token for 'go <id>'", () => {
  assert.equal(extractPromptTaskId("go"), null);
  assert.equal(extractPromptTaskId("go   "), null);
  assert.equal(extractPromptTaskId("go HYK-1-a"), "HYK-1-a");
  assert.equal(
    extractPromptTaskId(42),
    null,
    "non-string prompt -> null, no exception",
  );
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-go-task-id-gate.test.mjs must leave the real worktree exactly as it found it (before/after invariance, not empty)",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-go-task-id-gate.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
