import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractHardConstraints, isUsableCard } from "./context-inject.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./context-inject.mjs", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "context-inject-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, stdin) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      input: stdin ?? "",
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status };
  }
}

// --- extractHardConstraints (pure function) ---

test("(a) extracts the HARD CONSTRAINTS section body", () => {
  const text = "# Project\n\nsome prose\n\n## HARD CONSTRAINTS\n\n- never do X\n- always do Y\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, true);
  assert.match(result.text, /never do X/);
  assert.match(result.text, /always do Y/);
});

test("(b) stops at the next ## heading", () => {
  const text = "## HARD CONSTRAINTS\n\n- rule one\n\n## Other Section\n\nnot part of constraints\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, true);
  assert.match(result.text, /rule one/);
  assert.doesNotMatch(result.text, /not part of constraints/);
});

test("(c) no HARD CONSTRAINTS heading -> ok:false", () => {
  const text = "# Project\n\nno such section here\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no ## HARD CONSTRAINTS section/);
});

test("(d) HARD CONSTRAINTS section present but blank -> ok:false", () => {
  const text = "## HARD CONSTRAINTS\n\n   \n\n## Next\nmore\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/);
});

test("(e) case-insensitive heading with extra whitespace", () => {
  const text = "##   hard constraints   \nrule text here\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, true);
  assert.match(result.text, /rule text here/);
});

test("(f) heading with extra trailing words is not an exact match -> ok:false", () => {
  const text = "## HARD CONSTRAINTS (v1)\nrule text\n";
  const result = extractHardConstraints(text);
  assert.equal(result.ok, false);
});

// --- CLI integration ---

test("(g) session-start + file exists with constraints -> stdout JSON injects text, exit 0", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- never commit .harness/ to the team repo\n", "utf8");
    const { stdout, status } = runCli(
      ["--mode", "session-start", "--context", contextPath],
      JSON.stringify({ hook_event_name: "SessionStart", source: "clear", session_id: "x" }),
    );
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /never commit \.harness\//);
  });
});

test("(h) session-start + file missing -> exit 0, warning in additionalContext", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "does-not-exist.md");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /찾지 못함/);
  });
});

test("(i) session-start + file exists but no HARD CONSTRAINTS section -> exit 0, warning", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "# Project\n\nnothing relevant here\n", "utf8");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /HARD CONSTRAINTS를 사용할 수 없음/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /no ## HARD CONSTRAINTS section/);
  });
});

test("(j) user-prompt-submit + file exists -> exit 0, no output", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- rule\n", "utf8");
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "");
  });
});

test("(k) user-prompt-submit + file missing -> exit 2, block decision", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "does-not-exist.md");
    const { stdout, stderr, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 2);
    assert.match(stderr, /PROJECT-CONTEXT\.md/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, "block");
  });
});

test("(l) malformed stdin payload does not crash the CLI", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- rule\n", "utf8");
    const { status } = runCli(["--mode", "session-start", "--context", contextPath], "{ not valid json ][");
    assert.equal(status, 0);
  });
});

// --- isUsableCard (pure function) + HYK-96 scope A (form gate) ---

test("(m) isUsableCard: normal filled-in body -> ok", () => {
  const text = "## HARD CONSTRAINTS\n\n- never commit .harness/ to the team repo\n";
  const result = isUsableCard(text);
  assert.equal(result.ok, true);
});

test("(n) isUsableCard: empty section -> ok:false", () => {
  const text = "## HARD CONSTRAINTS\n\n   \n";
  const result = isUsableCard(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/);
});

test("(o) isUsableCard: unresolved placeholder token -> ok:false", () => {
  const text = "## HARD CONSTRAINTS\n\n- never commit harness tooling to <GITHUB_REPO>\n";
  const result = isUsableCard(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /<GITHUB_REPO>/);
});

test("(p) user-prompt-submit + empty HARD CONSTRAINTS -> exit 2, block", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n   \n", "utf8");
    const { stdout, stderr, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 2);
    assert.match(stderr, /사용할 수 없습니다/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, "block");
  });
});

test("(q) user-prompt-submit + unedited template (placeholder present) -> exit 2, block", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(
      contextPath,
      "## HARD CONSTRAINTS\n\n- Never commit or push harness tooling to <GITHUB_REPO>.\n- <this project's own hard constraint>\n",
      "utf8",
    );
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason, /<GITHUB_REPO>/);
  });
});

test("(r) user-prompt-submit + filled-in card -> exit 0, no output (regression)", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- never commit .harness/ to the team repo\n", "utf8");
    const { stdout, status } = runCli(["--mode", "user-prompt-submit", "--context", contextPath]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "");
  });
});

test("(s) session-start + placeholder card -> exit 0, warning (does not inject placeholder junk)", () => {
  withFixtureDir((dir) => {
    const contextPath = join(dir, "PROJECT-CONTEXT.md");
    writeFileSync(contextPath, "## HARD CONSTRAINTS\n\n- Never commit or push harness tooling to <GITHUB_REPO>.\n", "utf8");
    const { stdout, status } = runCli(["--mode", "session-start", "--context", contextPath]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /^프로젝트 하드 제약\(자동 주입\)/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /<GITHUB_REPO>/);
  });
});
