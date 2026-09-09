// HYK-457 (coder-task.md §2/§3-A -- HYK-350 "정의 두 벌 드리프트" 교훈,
// ledger-pointer-shared.mjs가 세운 것과 같은 관례): single source of truth
// for `confirmRetirementBlockReason` -- the "재확인 가능한 은퇴 사유가
// live 파일에서 실제로 사실인가" 판정 -- which was independently
// duplicated in dispatch-gate-decision.mjs (:2208, 사유 3개 대응) and
// admission-completion-adapter.mjs (:648, `...ForAdapter`, 사유 2개
// 대응 -- HYK-455가 세 번째 사유(RUNNER_GREEN_UNREACHABLE_AT_HEAD)를
// 추가하며 이 사본을 갱신하지 않아 발생한 fail-closed 회귀, 2026-09-08
// ORCH-63 격리 실측). 이 파일은 두 사본의 "합집합"이다: doneAt 추출은
// 다른 지점(정본은 CONSUMPTION_DONE_RE_G, 어댑터는 인라인 리터럴)이었지만
// 정규식 리터럴이 바이트 동일했으므로 이 파일이 그 하나를 그대로 쓴다;
// runner-green 가지는 정본에만 있었으므로(어댑터는 애초에 없었다) 그대로
// 옮긴다.
//
// admission-completion-adapter.mjs의 파일 헤더(HYK-398 §2-⑶)가 명시한
// 원칙 -- "무겁게 참조되는 모듈(dispatch-gate-decision.mjs 등)을 끌어들이지
// 않는다" -- 을 이 파일도 지킨다: import는 node 내장(node:fs, node:path)과
// retirement-record-core.mjs(그 자신도 zero-import 코어) 뿐이다.
// dispatch-gate-decision.mjs를 이 파일이 참조하는 일은 없다(방향이
// 반대면 그 파일의 전체 의존성 트리를 다시 끌어들이게 된다).
//
// ⚠️ this file is now a sibling every isolated/mutation fixture that stages
// a synthetic copy of admission-completion-adapter.mjs must also stage
// (mirrors the existing ledger-pointer-shared.mjs/retirement-record-core.mjs
// sibling pattern those fixtures already carry) -- this round updated every
// such site it found (see coder.md for the full list). dispatch-gate-
// decision.mjs is never copied into an isolated fixture (every test that
// touches it spawns the real file at its real repo path instead, see that
// file's own header) so this file needs no sibling-list update on that side.

import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import {
  RETIREMENT_BLOCK_REASON,
  MECHANICALLY_CONFIRMABLE_BLOCK_REASONS,
} from "./retirement-record-core.mjs";

const CONSUMPTION_DONE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;
// HYK-455 §2 -- RUNNER_GREEN_UNREACHABLE_AT_HEAD 재확인 전용: 이 라운드
// 자신의 결과 파일이 주장하는 head_commit(그 러너가 실제로 돈 커밋)을
// 뽑는다. `head_commit:` 소문자 표지만 인정한다 -- 값은 40자 hex(sha)로
// 고정해 위조 문자열이 아무 값이나 채워 넣지 못하게 한다.
const CONSUMPTION_HEAD_COMMIT_RE_G =
  /^head_commit:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gm;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// "유일한 매치 하나만 채택, 0개·2개 이상이면 지어내지 않고 undefined로
// 물러난다" 규칙 (dispatch-gate-decision.mjs의 extractSoleMatch와 동일).
function extractSoleMatch(text, reG) {
  const matches = [...text.matchAll(reG)];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
}

function parseKstToMs(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

// harnessDir 밖을 가리키는 evidenceReceiptPath(경로 탈출)를 거부한다 --
// resolveEvidenceReceiptPathWithinHarnessDir (dispatch-gate-decision.mjs의
// 옛 사본과 동일한 계약).
function resolveEvidenceReceiptPathWithinHarnessDir(
  harnessDir,
  evidenceReceiptPath,
) {
  if (!isNonEmptyString(evidenceReceiptPath)) return null;
  const resolvedHarnessDir = resolve(harnessDir);
  const resolvedPath = resolve(harnessDir, evidenceReceiptPath);
  const rel = relative(resolvedHarnessDir, resolvedPath);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  ) {
    return null;
  }
  if (isAbsolute(rel)) return null;
  return resolvedPath;
}

// record.evidenceReceiptPath(§설계 조건 2)가 가리키는 러너 영수증
// (runner-receipt-writer.mjs 스키마, HYK-411)을 harnessDir 기준으로 실제로
// 다시 읽어, 그 안의 head_commit이 이 라운드 결과 파일 자신의 head_commit:
// 줄과 같고 runner_exit이 0이 아님을 독립적으로 재유도한다. 경로가
// 없거나·harnessDir을 벗어나거나·파일을 못 읽거나·JSON이 아니거나·
// head_commit이 다르거나·runner_exit이 0(=그 커밋에서 실제로는 초록)이면
// false -- "ORCH가 그렇다고 했다"만으로는 통과하지 못한다.
function confirmRunnerGreenUnreachableAtHead(record, harnessDir, resultText) {
  const resultHeadCommit = extractSoleMatch(
    resultText,
    CONSUMPTION_HEAD_COMMIT_RE_G,
  );
  if (!isNonEmptyString(resultHeadCommit)) return false;
  const resolvedPath = resolveEvidenceReceiptPathWithinHarnessDir(
    harnessDir,
    record?.evidenceReceiptPath,
  );
  if (resolvedPath === null) return false;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    return false;
  }
  return (
    receipt?.head_commit === resultHeadCommit &&
    typeof receipt?.runner_exit === "number" &&
    receipt.runner_exit !== 0
  );
}

// §3-4 (retirement-record-core.mjs 헤더): 기계로 확인 가능한 사유(현재
// 셋 -- DONE_TIMESTAMP_NOT_PARSEABLE · DONE_PREDATES_DROPPED_AT ·
// RUNNER_GREEN_UNREACHABLE_AT_HEAD)만 독립 재확인한다. 나머지 사유
// (DONE_REWRITE_LOCKED · TASK_CONTRACT_PROHIBITS_REPAIR)는 이 코드베이스가
// 기계로 재현할 수 없는 계약 텍스트 질문이므로 null을 돌려준다(가짜
// 확인을 만들지 않는다 -- null은 코어가 "이 사유는 이 축에서 재확인
// 대상이 아니다"로 이미 처리한다, MECHANICALLY_CONFIRMABLE_BLOCK_REASONS
// 확인).
//
// harnessDir은 필수다: RUNNER_GREEN_UNREACHABLE_AT_HEAD 가지가 러너
// 영수증을 harnessDir 기준 상대 경로로 다시 읽어야 하기 때문이다(위
// confirmRunnerGreenUnreachableAtHead 참조) -- 이 인자가 없던 옛
// admission-completion-adapter.mjs 사본이 정확히 이 가지를 결선하지
// 못해 fail-closed로 떨어졌던 결함(HYK-457 §2)이다.
export function confirmRetirementBlockReason(
  record,
  resultText,
  droppedAt,
  harnessDir,
) {
  if (!MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(record?.blockReasonCode)) {
    return null;
  }
  if (
    record.blockReasonCode ===
    RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE
  ) {
    const doneAt = extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G);
    return isNonEmptyString(doneAt) && parseKstToMs(doneAt) === null;
  }
  if (
    record.blockReasonCode === RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT
  ) {
    const doneAt = extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G);
    const doneAtMs = parseKstToMs(doneAt);
    const droppedAtMs = parseKstToMs(droppedAt);
    return doneAtMs !== null && droppedAtMs !== null && doneAtMs < droppedAtMs;
  }
  if (
    record.blockReasonCode ===
    RETIREMENT_BLOCK_REASON.RUNNER_GREEN_UNREACHABLE_AT_HEAD
  ) {
    return confirmRunnerGreenUnreachableAtHead(record, harnessDir, resultText);
  }
  return null;
}
