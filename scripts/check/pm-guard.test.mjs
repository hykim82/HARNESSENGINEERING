import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPmGuard } from "./pm-guard.mjs";

const CONTROL_ROOM = "D:/문서관리/하네스-관제실/STATUS.md";
const SCRATCHPAD =
  "C:/Users/ADMINI~1/AppData/Local/Temp/claude/some-project/scratch.md";

test("(1) PM writing inside a repo is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath:
      "C:/Users/Administrator/Documents/HARNESSENGINEERING/.harness/coder-task.md",
  });
  assert.equal(result.ok, false);
});

test("(2) PM writing the control room is allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Edit",
    filePath: CONTROL_ROOM,
  });
  assert.equal(result.ok, true);
});

test("(3) PM writing the scratchpad is allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: SCRATCHPAD,
  });
  assert.equal(result.ok, true);
});

test("(4) non-PM role is not regulated by pm-guard", () => {
  const result = checkPmGuard({
    role: "CODER",
    toolName: "Write",
    filePath:
      "C:/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/foo.mjs",
  });
  assert.equal(result.ok, true);
});

test("(5) unset role is not regulated by pm-guard", () => {
  const result = checkPmGuard({
    role: undefined,
    toolName: "Write",
    filePath: "C:/anywhere/file.md",
  });
  assert.equal(result.ok, true);
});

test("(6) PM calling a Linear write MCP tool (save_) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__save_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(7) PM calling a Linear write MCP tool (create_) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__create_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(8) PM calling a Linear write MCP tool (delete_) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__delete_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9) PM calling a Linear read MCP tool is not blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__linear-server__list_issues",
    filePath: undefined,
  });
  assert.equal(result.ok, true);
});

// HYK-273: the `claude_ai_Linear` connector exposes the same save_/create_/
// delete_ write surface as `linear-server` under a different mcp__ prefix.
// The old regex (mcp__linear-server__ only) let this connector's writes
// through unblocked -- these three cases pin that gap shut and go RED again
// if the second prefix is ever dropped from LINEAR_WRITE_TOOL_RE.
test("(9b) PM calling the claude_ai_Linear connector's save_ tool is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__save_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9c) PM calling the claude_ai_Linear connector's create_ tool is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__create_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9d) PM calling the claude_ai_Linear connector's delete_ tool is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__delete_issue",
    filePath: undefined,
  });
  assert.equal(result.ok, false);
});

test("(9e) PM calling the claude_ai_Linear connector's read tool is not blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "mcp__claude_ai_Linear__list_issues",
    filePath: undefined,
  });
  assert.equal(result.ok, true);
});

test("(10) PM calling a non-write tool (Read) is not regulated", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Read",
    filePath: "C:/anywhere/file.md",
  });
  assert.equal(result.ok, true);
});

test("(11) WSL-style path into the control room is recognized and allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: "/mnt/d/문서관리/하네스-관제실/STATUS.md",
  });
  assert.equal(result.ok, true);
});

test("(12) Git-Bash-style path into the control room is recognized and allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: "/d/문서관리/하네스-관제실/STATUS.md",
  });
  assert.equal(result.ok, true);
});

test("(13) backslash-form control room path is recognized and allowed", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Edit",
    filePath: "D:\\문서관리\\하네스-관제실\\PM\\relay\\pm-task.md",
  });
  assert.equal(result.ok, true);
});

test("(14) WSL-style path into a repo (not control room) is blocked", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath:
      "/mnt/c/Users/Administrator/Documents/HARNESSENGINEERING/.harness/coder-task.md",
  });
  assert.equal(result.ok, false);
});

test("(15) a path that merely starts with the control room name as a sibling dir is not fooled into passing", () => {
  const result = checkPmGuard({
    role: "PM",
    toolName: "Write",
    filePath: "D:/문서관리/하네스-관제실-아닌곳/file.md",
  });
  assert.equal(result.ok, false);
});
