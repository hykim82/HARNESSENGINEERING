// HYK-330-pm-guard-prefix-1 (coder-task.md §3-3) -- does the applied
// control-room settings.local.json fixture actually make the PM-guard
// pipeline catch mcp__claude_ai_Linear__save_issue, without a false
// positive on the read-only mcp__claude_ai_Linear__get_issue?
//
// ⛔This never calls a real Linear MCP tool (coder-task.md §0 비타협7) --
// everything below is string/regex matching against tool-name literals and
// the exported checkPmGuard() function.
//
// Two layers, deliberately kept separate (see the patch document's §6
// honesty note and pm-guard.mjs's own header comment):
//   1. The settings.local.json `matcher` string is the coarse PreToolUse
//      TRIGGER -- it decides whether the pm-guard.mjs hook process runs at
//      all for a given tool name. It is intentionally broad
//      (`mcp__claude_ai_Linear__.*`, mirroring the pre-existing
//      `mcp__linear-server__.*` shape already in this same file) -- it
//      fires for BOTH write and read tools in that connector, same as the
//      repo's already-committed inventory matcher does.
//   2. Inside the hook process, checkPmGuard()'s own LINEAR_WRITE_TOOL_RE
//      is the fine-grained DECISION -- it only blocks names with a
//      save_/create_/delete_ verb after the connector prefix. That is
//      where "no false positive on a read tool" (HYK-330 완료조건 2) is
//      actually enforced; it is unaffected by this patch (unchanged code,
//      already fixed under HYK-273/HYK-267).
//
// This test fixes both layers together so a future change to either one
// (matcher string or LINEAR_WRITE_TOOL_RE) that reopens a hole shows up
// here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkPmGuard } from "./pm-guard.mjs";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-settings-2026-08-20-hyk330-applied.json.txt",
    import.meta.url,
  ),
);

function loadAppliedMatcher() {
  const settings = JSON.parse(readFileSync(APPLIED_PATH, "utf8"));
  return settings.hooks.PreToolUse[0].matcher;
}

test("applied fixture's PreToolUse matcher string is exactly the repo inventory's already-committed shape", () => {
  const matcher = loadAppliedMatcher();
  assert.equal(
    matcher,
    "Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*|mcp__claude_ai_Linear__.*",
  );
});

test("layer 1 (trigger): applied matcher fires for mcp__claude_ai_Linear__save_issue", () => {
  const matcher = loadAppliedMatcher();
  const triggerRe = new RegExp(`^(?:${matcher})$`);
  assert.equal(triggerRe.test("mcp__claude_ai_Linear__save_issue"), true);
});

test("layer 1 (trigger) is coarse by design -- it also fires for the read tool mcp__claude_ai_Linear__get_issue (same shape as the pre-existing mcp__linear-server__.* half of this matcher); the actual read/write decision is layer 2 below", () => {
  const matcher = loadAppliedMatcher();
  const triggerRe = new RegExp(`^(?:${matcher})$`);
  assert.equal(triggerRe.test("mcp__claude_ai_Linear__get_issue"), true);
});

test("layer 2 (decision, HYK-330 완료조건 2): checkPmGuard blocks the write tool for a PM session", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__save_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /mcp__claude_ai_Linear__save_issue/);
});

test("layer 2 (decision, HYK-330 완료조건 2, 오탐 0): checkPmGuard does NOT block the read tool for a PM session", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__get_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, true);
});
