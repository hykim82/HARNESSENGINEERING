import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRoleWrite } from "./role-guard.mjs";

const repoRoot = "/repo";

test("(1) ORCH may drop a task file", () => {
  const result = checkRoleWrite({ role: "ORCH", filePath: ".harness/coder-task.md", repoRoot });
  assert.equal(result.ok, true);
});

test("(2) ORCH may not edit a source file", () => {
  const result = checkRoleWrite({ role: "ORCH", filePath: "scripts/check/review-gate.mjs", repoRoot });
  assert.equal(result.ok, false);
});

test("(3) ORCH may not write a worker result file", () => {
  const result = checkRoleWrite({ role: "ORCH", filePath: ".harness/coder.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(4) ORCH is unrestricted outside the repo root (control room)", () => {
  const result = checkRoleWrite({ role: "ORCH", filePath: "/other/control-room/STATUS.md", repoRoot });
  assert.equal(result.ok, true);
});

test("(5) CODER may edit a source file", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: "scripts/check/foo.mjs", repoRoot });
  assert.equal(result.ok, true);
});

test("(6) CODER may not write review.md", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/review.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(7) CODER may not write verify.md", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/verify.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(8) CODER may not write a task file", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/coder-task.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(9) CODER may write its own result file", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/coder.md", repoRoot });
  assert.equal(result.ok, true);
});

test("(10) REVIEW may write review.md", () => {
  const result = checkRoleWrite({ role: "REVIEW", filePath: ".harness/review.md", repoRoot });
  assert.equal(result.ok, true);
});

test("(11) REVIEW may not edit a source file", () => {
  const result = checkRoleWrite({ role: "REVIEW", filePath: "scripts/check/review-gate.mjs", repoRoot });
  assert.equal(result.ok, false);
});

test("(12) REVIEW may not write verify.md", () => {
  const result = checkRoleWrite({ role: "REVIEW", filePath: ".harness/verify.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(13) VERIFY may write verify.md", () => {
  const result = checkRoleWrite({ role: "VERIFY", filePath: ".harness/verify.md", repoRoot });
  assert.equal(result.ok, true);
});

test("(14) VERIFY may not edit a source file", () => {
  const result = checkRoleWrite({ role: "VERIFY", filePath: "docs/enforcement-v1.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(15) VERIFY may not write review.md", () => {
  const result = checkRoleWrite({ role: "VERIFY", filePath: ".harness/review.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(16) unset role allows the write but flags a warning", () => {
  const result = checkRoleWrite({ role: undefined, filePath: "scripts/check/foo.mjs", repoRoot });
  assert.equal(result.ok, true);
  assert.equal(result.warn, true);
});

test("(17) unknown role string allows the write but flags a warning", () => {
  const result = checkRoleWrite({ role: "SOMETHING-ELSE", filePath: "scripts/check/foo.mjs", repoRoot });
  assert.equal(result.ok, true);
  assert.equal(result.warn, true);
});

test("(18) backslash path is normalized before matching", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: "scripts\\check\\foo.mjs", repoRoot });
  assert.equal(result.ok, true);
});

test("(19) absolute in-repo path resolves the same as a relative one", () => {
  const result = checkRoleWrite({ role: "ORCH", filePath: `${repoRoot}/.harness/coder-task.md`, repoRoot });
  assert.equal(result.ok, true);
});

test("(20) absolute path on a different drive is treated as outside the repo", () => {
  const result = checkRoleWrite({
    role: "REVIEW",
    filePath: "D:/other/file.md",
    repoRoot: "C:/repo",
  });
  assert.equal(result.ok, true);
});

// --- round 2: REVIEW-CODEX found two path-normalization bypasses (both closed here) ---

test("(21) CODER traversal '.harness/foo/../review.md' resolves to review.md -> deny", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/foo/../review.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(22) CODER traversal '.harness/foo/../verify.md' resolves to verify.md -> deny", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/foo/../verify.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(23) CODER traversal '.harness/foo/../coder-task.md' resolves to a task file -> deny", () => {
  const result = checkRoleWrite({ role: "CODER", filePath: ".harness/foo/../coder-task.md", repoRoot });
  assert.equal(result.ok, false);
});

test("(24) ORCH traversal '.harness/../scripts/...' escapes .harness -> deny", () => {
  const result = checkRoleWrite({ role: "ORCH", filePath: ".harness/../scripts/check/foo.mjs", repoRoot });
  assert.equal(result.ok, false);
});

test("(25) ORCH: WSL-style absolute path for an in-repo file is recognized as inside the repo -> deny", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "/mnt/c/Users/Administrator/Documents/HARNESSENGINEERING/scripts/check/review-gate.mjs",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, false);
});

test("(26) ORCH: WSL-style path for the same repo's task file is still allowed", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "/mnt/c/Users/Administrator/Documents/HARNESSENGINEERING/.harness/coder-task.md",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, true);
});

test("(27) WSL-style path on a genuinely different drive stays outside the repo -> allow", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "/mnt/d/other/place/file.md",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, true);
});

test("(28) Windows-drive path on a genuinely different drive stays outside the repo -> allow", () => {
  const winRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const result = checkRoleWrite({
    role: "ORCH",
    filePath: "D:/other/place/file.md",
    repoRoot: winRoot,
  });
  assert.equal(result.ok, true);
});
