import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). 과거 `/verdict:\s*approved/i.test(content)`는 존재 검사라
// 최신 판정이 rejected여도 옛 approved 줄이 남아 있으면 통과시켰다.
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;
const HYK_TAG_RE_GLOBAL = /HYK-\d+/g;
// A standalone digit token (not part of a longer word like "2x" or "3rd") chained
// by a comma onto a preceding HYK-<digits> tag is an abbreviated enumeration.
const ABBREVIATED_ENUMERATION_RE = /HYK-\d+(?:\s*,\s*\d+(?![A-Za-z0-9]))+/g;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
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

// Extracted from checkReviewGate (quality-check: keep checkReviewGate's own
// complexity under the repo's ESLint ceiling, same reason reject-streak.mjs
// extracts its own helpers) -- HYK-183: counts anchored `verdict:` lines and
// resolves whether the review is approved, or reports ambiguity when there
// is more than one.
function resolveVerdict(content) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const verdictMatches = [...normalizedContent.matchAll(VERDICT_LINE_RE_G)];
  if (verdictMatches.length > 1) {
    return { ambiguous: true, count: verdictMatches.length };
  }
  return {
    ambiguous: false,
    approved:
      verdictMatches.length === 1 &&
      verdictMatches[0][1].toLowerCase() === "approved",
  };
}

function findAbbreviatedEnumerations(subject) {
  const groups = [];
  for (const match of subject.matchAll(ABBREVIATED_ENUMERATION_RE)) {
    const text = match[0];
    const leadId = text.match(/^HYK-\d+/)[0];
    const bareIds = [...text.matchAll(/,\s*(\d+)(?![A-Za-z0-9])/g)].map(
      (m) => `HYK-${m[1]}`,
    );
    groups.push([leadId, ...bareIds]);
  }
  return groups;
}

export function checkReviewGate({
  message,
  reviewPath = join(repoRoot(), ".harness", "review.md"),
}) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";

  const abbreviatedGroups = findAbbreviatedEnumerations(subject);
  if (abbreviatedGroups.length > 0) {
    const suggestion = abbreviatedGroups
      .map((ids) => ids.join(", "))
      .join("; ");
    return {
      ok: false,
      reason: `abbreviated issue list in subject; write each id fully: ${suggestion}`,
    };
  }

  const tagMatches = subject.match(HYK_TAG_RE_GLOBAL);
  if (!tagMatches) {
    return { ok: true, reason: "no HYK-<id> tag in message; not issue work" };
  }
  const issueIds = [...new Set(tagMatches)];

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

  const missingIds = issueIds.filter(
    (issueId) => !new RegExp(`for:\\s*${issueId}\\b`).test(content),
  );
  if (missingIds.length > 0) {
    return {
      ok: false,
      reason: `missing review evidence for ${missingIds.join(", ")} in ${reviewPath} (need "for: <id>" + approved verdict for each)`,
    };
  }

  const verdict = resolveVerdict(content);
  if (verdict.ambiguous) {
    return {
      ok: false,
      reason: `review verdict ambiguous for ${issueIds.join(", ")}: ${verdict.count}개 'verdict:' 줄이 있어 어느 것이 최종인지 결정할 수 없다 (${reviewPath})`,
    };
  }
  if (!verdict.approved) {
    return {
      ok: false,
      reason: `review not approved for ${issueIds.join(", ")} (need verdict: approved)`,
    };
  }
  const hasIndependentReviewer = /role:\s*REVIEW/i.test(content);
  if (!hasIndependentReviewer) {
    return {
      ok: false,
      reason: `self-certification blocked: review evidence for ${issueIds.join(", ")} lacks an independent reviewer (need role: REVIEW-*)`,
    };
  }
  return {
    ok: true,
    reason: `independent review evidence found for ${issueIds.join(", ")}`,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/review-gate.mjs");
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
