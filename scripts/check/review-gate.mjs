import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const HYK_TAG_RE = /HYK-\d+/;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function extractSkipReview(message) {
  // 1) Strip code fences — docs/examples that describe the gate must not be
  //    mistaken for a skip directive.
  const withoutFences = message.replace(/```[\s\S]*?```/g, "");
  // 2) The trailer block is the last paragraph (block after the last blank-line split).
  const paragraphs = withoutFences.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  // 3) Only a line-start `skip-review:` inside that trailer block counts.
  const m = last.match(/^[ \t]*skip-review:[ \t]*(.*)$/im);
  return m ? m[1].trim() : null; // null = not a skip directive
}

export function checkReviewGate({ message, reviewPath = join(repoRoot(), ".harness", "review.md") }) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  const tagMatch = subject.match(HYK_TAG_RE);
  if (!tagMatch) {
    return { ok: true, reason: "no HYK-<id> tag in message; not issue work" };
  }
  const issueId = tagMatch[0];

  const skipReason = extractSkipReview(message);
  if (skipReason !== null) {
    if (skipReason.length === 0) {
      return { ok: false, reason: "skip-review reason must not be empty" };
    }
    return { ok: true, reason: `skip-review audited: ${skipReason}` };
  }

  if (!existsSync(reviewPath)) {
    return { ok: false, reason: `review file not found: ${reviewPath}` };
  }
  const content = readFileSync(reviewPath, "utf8");
  const hasFor = new RegExp(`for:\\s*${issueId}\\b`).test(content);
  if (!hasFor) {
    return {
      ok: false,
      reason: `missing review evidence for ${issueId} in ${reviewPath} (need "for: ${issueId}" + approved verdict)`,
    };
  }
  const hasApproved = /verdict:\s*approved/i.test(content);
  if (!hasApproved) {
    return { ok: false, reason: `review not approved for ${issueId} (need verdict: approved)` };
  }
  const hasIndependentReviewer = /role:\s*REVIEW/i.test(content);
  if (!hasIndependentReviewer) {
    return {
      ok: false,
      reason: `self-certification blocked: review evidence for ${issueId} lacks an independent reviewer (need role: REVIEW-*)`,
    };
  }
  return { ok: true, reason: `independent review evidence found for ${issueId}` };
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
