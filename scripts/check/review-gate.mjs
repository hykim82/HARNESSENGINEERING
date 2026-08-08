import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { recordRejectStreakFromResultText } from "./reject-streak.mjs";
import { mainRepoRoot } from "./relay-handshake.mjs";
import { archiveRoundEnvelope } from "./envelope-archive.mjs";

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

// HYK-183-ledger-fix (축 B): checkReviewGate가 `ok:true`를 낸 이유가 진짜
// "for:/verdict: approved/role: REVIEW-* 증거를 확인했다"인지, 아니면
// "HYK 태그가 없다"/"skip-review"처럼 review.md를 아예 읽지 않은 조기
// 통과인지를 CLI 쪽에서 독립적으로 재판단한다(checkReviewGate 자체의
// 반환 모양은 손대지 않는다 -- 기존 20여 개 순수 함수 시험이 그 모양을
// 그대로 단언하므로, 회귀 없이 부작용만 CLI 블록에 얹는다). 뒤의 두
// 경로에서 review.md를 무조건 읽어 기록하면, 이 커밋과 무관한(다른
// 이슈의) 남은 review.md 내용을 이 커밋의 승인으로 잘못 붙일 수 있다.
function isGenuineReviewApproval(message, reviewPath) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  if (!subject.match(HYK_TAG_RE_GLOBAL)) return false;
  if (extractSkipReview(message) !== null) return false;
  return existsSync(reviewPath);
}

// HYK-183-ledger-fix (축 B): 승인이 커밋으로 이어지는 유일하게 «보장된»
// 관문(commit-msg 훅)에 원장 기록을 함께 건다. 기존 설계(37d68a1)는
// "반려 라운드는 커밋 자체가 없어 커밋 훅으로 못 본다"는 근거로 커밋 훅
// 결선을 통째로 기각했으나, 그 근거는 승인에는 적용되지 않는다 -- 승인은
// 반드시 커밋을 만들고, 이 훅은 그 커밋마다 반드시 실행된다.
// checkRelayHandshake 쪽 자동 기록(HYK-183 §2)은 ORCH가 "다음 라운드"를
// 위해 handshake를 다시 확인할 때 걸리는 부작용이라, 승인처럼 다음
// 라운드가 없는 종결 상태에서는 그 계기 자체가 생기지 않는다 -- 실측:
// 2026-08-05 오늘 승인 3건이 원장에 없다(§1 축 B). 이 훅은 반대로
// "커밋이 있으면 반드시 실행된다"를 보장하므로 승인 쪽의 정본 기록
// 지점으로 삼는다. `recordRejectStreakFromResultText`를 그대로 재사용해
// 판정/멱등성 로직을 재구현하지 않는다(role: "review"만 넘기면 축 A의
// done_at 포함 중복 판정까지 그대로 적용된다).
function recordApprovalToLedger(reviewPath) {
  const reviewText = readFileSync(reviewPath, "utf8");
  const ledgerPath = join(mainRepoRoot(), ".harness", "reject-streak.json");
  const outcome = recordRejectStreakFromResultText({
    role: "review",
    resultText: reviewText,
    ledgerPath,
  });
  if (!outcome.attempted) return;
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
}

// HYK-204: an APPROVED review round never triggers relay-handshake's own
// archive wiring (see recordApprovalToLedger's header just above -- an
// approval is a terminal state, so nothing ever re-checks that handshake
// for a "next round"). This commit-msg hook is the one choke point
// guaranteed to run on every approved commit, so it is also the archive
// site for the WINNING round's review.md -- otherwise exactly the round
// that decided the outcome would be the one round never preserved.
function archiveApprovedRound(reviewPath) {
  const reviewText = readFileSync(reviewPath, "utf8");
  const outcome = archiveRoundEnvelope({
    role: "review",
    resultContent: reviewText,
    harnessDir: dirname(reviewPath),
  });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
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
  const reviewPath = join(repoRoot(), ".harness", "review.md");
  const result = checkReviewGate({ message, reviewPath });
  if (result.ok) {
    if (isGenuineReviewApproval(message, reviewPath)) {
      recordApprovalToLedger(reviewPath);
      archiveApprovedRound(reviewPath);
    }
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
