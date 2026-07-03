import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const HYK_TAG_RE = /HYK-\d+/;
const SKIP_REVIEW_RE = /\[skip-review:\s*([^\]]*)\]/;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

export function checkReviewGate({ message, reviewPath = join(repoRoot(), ".harness", "review.md") }) {
  const tagMatch = message.match(HYK_TAG_RE);
  if (!tagMatch) {
    return { ok: true, reason: "no HYK-<id> tag in message; not issue work" };
  }
  const issueId = tagMatch[0];

  const skipMatch = message.match(SKIP_REVIEW_RE);
  if (skipMatch) {
    const reasonText = skipMatch[1].trim();
    if (reasonText.length === 0) {
      return { ok: false, reason: "skip-review reason must not be empty" };
    }
    return { ok: true, reason: `skip-review audited: ${reasonText}` };
  }

  if (!existsSync(reviewPath)) {
    return { ok: false, reason: `review file not found: ${reviewPath}` };
  }
  const content = readFileSync(reviewPath, "utf8");
  const hasFor = new RegExp(`for:\\s*${issueId}\\b`).test(content);
  const hasVerdict = /verdict:\s*approved/.test(content) || /ready_for_review/.test(content);
  if (hasFor && hasVerdict) {
    return { ok: true, reason: `review evidence found for ${issueId}` };
  }
  return {
    ok: false,
    reason: `missing review evidence for ${issueId} in ${reviewPath} (need "for: ${issueId}" + approved verdict)`,
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/review-gate.mjs");
if (invokedDirectly) {
  const commitMsgFile = process.argv[2];
  if (!commitMsgFile) {
    console.error("usage: node review-gate.mjs <commit-msg-file>");
    process.exit(1);
  }
  const message = readFileSync(commitMsgFile, "utf8");
  const result = checkReviewGate({ message });
  if (result.ok) {
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
