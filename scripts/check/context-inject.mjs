import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

const HEADING_RE = /^##\s+(.+?)\s*$/;

// Extracts the body of the "## HARD CONSTRAINTS" heading (exact title,
// case-insensitive) up to the next "##" heading or end of file. Pure
// text-in/struct-out so it is trivially unit-testable without touching the
// filesystem; file loading is the CLI's job.
export function extractHardConstraints(contextText) {
  const lines = (contextText ?? "").split(/\r?\n/);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].trim().toLowerCase() === "hard constraints") {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    return { ok: false, reason: "no ## HARD CONSTRAINTS section" };
  }
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }
  const text = lines.slice(startIdx + 1, endIdx).join("\n").trim();
  if (!text) {
    return { ok: false, reason: "HARD CONSTRAINTS section is empty" };
  }
  return { ok: true, text };
}

function fileExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function resolveContextPath(explicitPath) {
  return explicitPath || process.env.HARNESS_CONTEXT_PATH || join(repoRoot(), ".harness", "PROJECT-CONTEXT.md");
}

function sessionStartOutput(contextPath) {
  let additionalContext;
  if (!fileExists(contextPath)) {
    additionalContext =
      `⚠️ PROJECT-CONTEXT.md를 ${contextPath}에서 찾지 못함 — ` +
      "이 프로젝트의 하드 제약이 주입되지 않았습니다. 진행 전 맥락 카드를 만드세요.";
  } else {
    try {
      const text = readFileSync(contextPath, "utf8");
      const extracted = extractHardConstraints(text);
      if (extracted.ok) {
        additionalContext = `프로젝트 하드 제약(자동 주입):\n${extracted.text}`;
      } else {
        additionalContext =
          `⚠️ ${contextPath}에 ## HARD CONSTRAINTS 섹션을 찾지 못함(${extracted.reason}) — ` +
          "이 프로젝트의 하드 제약이 주입되지 않았습니다. 맥락 카드를 보완하세요.";
      }
    } catch (err) {
      additionalContext =
        `⚠️ ${contextPath}를 읽는 중 오류(${err.message}) — ` +
        "이 프로젝트의 하드 제약이 주입되지 않았습니다.";
    }
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/context-inject.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let mode;
  let contextPathArg;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") mode = args[++i];
    else if (args[i] === "--context") contextPathArg = args[++i];
  }
  const contextPath = resolveContextPath(contextPathArg);

  if (mode === "session-start") {
    // SessionStart cannot block (exit 2 is ignored by the hook contract), so
    // any failure path here still exits 0 -- a warning injected into context
    // is the strongest signal this hook type can give.
    let output;
    try {
      output = sessionStartOutput(contextPath);
    } catch (err) {
      output = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `⚠️ context-inject internal error (${err.message}) — hard constraints not injected.`,
        },
      };
    }
    console.log(JSON.stringify(output));
    process.exit(0);
  } else if (mode === "user-prompt-submit") {
    // Blocking is reserved for the one condition this task specifies: the
    // context file is confirmed absent. Any other failure (permission
    // error, unexpected exception) must not block a prompt -- fail open.
    try {
      if (fileExists(contextPath)) {
        process.exit(0);
      }
      const reason =
        `PROJECT-CONTEXT.md가 ${contextPath}에 없습니다. ` +
        "이 프로젝트의 하드 제약 카드를 먼저 만드세요(진행 차단).";
      console.error(reason);
      console.log(JSON.stringify({ decision: "block", reason }));
      process.exit(2);
    } catch {
      process.exit(0);
    }
  } else {
    console.error("usage: node context-inject.mjs --mode <session-start|user-prompt-submit> [--context <path>]");
    process.exit(1);
  }
}
