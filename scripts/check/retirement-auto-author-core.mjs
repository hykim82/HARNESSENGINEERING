// HYK-419-retire-author-1 (coder-task.md) -- "누가 은퇴 기록을 자동으로
// 쓸 수 있는가"의 판정/자동화 코어. zero-import 원칙(S8, retirement-record-
// core.mjs·hyk412-never-consumed-retire-core.mjs와 동일 계약)은 딱 한 곳만
// 예외다: 이 파일은 hyk412-never-consumed-retire-core.mjs의
// evaluateNeverConsumedRetirement를 **그대로 재사용**한다(coder-task.md
// §2⑶ "새 판정 축을 만들지 마라" 요구 그 자체) -- 그 외에는 파일을 스스로
// 읽지 않고, fs/child_process 등 어떤 I/O 모듈도 import하지 않는다.
//
// ⛔이 모듈은 어떤 배달 게이트·라이브 원장에도 결선되지 않는다
// (retirement-record-writer.mjs와 동일한 원칙, docs/HYK-412-stuck-retire-
// design.md §3-1 "저자 경계"를 그대로 물려받는다) -- 사람(또는 대리인
// ORCH)이 이 함수의 결과를 손으로 확인하고, 그 다음 손으로
// retirement-record-writer.mjs를 호출해야만 실제 기록이 생긴다. 이 라운드는
// 그 두 단계를 자동으로 잇는 접착 코드조차 만들지 않는다(coder-task.md §0
// "라이브 결선 금지" · 이 라운드 note: HYK-413이 옮긴 seat 결선 검증용
// 첫 실물 점검이므로 범위를 최대한 좁게 지킨다).
//
// 자세한 설계 근거(§1 "누가 쓰는가", §2 필드별 기계-유도 가능성, §4 위조
// 표면, §5 되돌림 변이, §6 정직 한계)는 docs/HYK-419-retire-author-design.md
// 참조 -- 이 헤더는 코드 옆의 요약만 남긴다.
//
// §A 이 코어가 답하는 질문: "hyk412 게이트가 이미 OPEN이라고 판정한
// 라운드에 대해, «사람 서술 없이 기계 기록만으로» 완전한 은퇴 기록 초안을
// 조립할 수 있는가?" 답은 "거의, 그러나 정확히 한 필드는 못 한다"이다 --
// blockReasonCode. retirement-record-core.mjs의 RETIREMENT_BLOCK_REASON
// 닫힌 집합에는 "이 라운드는 소비 시도조차 된 적 없이 방치됐다"를 뜻하는
// 값이 아직 없다(그 집합의 네 값은 전부 "DONE 타임스탬프/재작성 정책"
// 계열이다, retirement-record-core.mjs 헤더 §3-2 참조). 그 값을 새로
// 추가하는 것은 기존 소비 축(checkArchiveFacts/checkReasonAndSuccessorFacts)
// 의 검증 로직을 넓히는 결선이라 이 라운드 범위 밖이다(docs/HYK-412-stuck-
// retire-design.md §3-2·§6이 이미 그렇게 판단했다 -- 이 라운드는 그 판단을
// 뒤집지 않는다). 그래서 이 코어는 blockReasonCode를 **절대로 채우지
// 않는다**(호출자가 그 필드를 넘겨도 무시한다, 아래 §C) -- 그 자리를
// "사람 손이 남는 자리"로 명시적으로 비워 둔다.
import {
  evaluateNeverConsumedRetirement,
  NEVER_CONSUMED_RETIRE_STATE,
} from "./hyk412-never-consumed-retire-core.mjs";

export const AUTO_AUTHOR_STATE = Object.freeze({
  AUTHORIZED_DRAFT: "AUTHORIZED_DRAFT",
  GATE_CLOSED: "GATE_CLOSED",
  MACHINE_ANCHOR_INCOMPLETE: "MACHINE_ANCHOR_INCOMPLETE",
});

// 이 코어가 조립하는 초안에서 사람 결정이 반드시 남는 필드(§A). 배열
// 자체를 얼려서(freeze) 호출자가 목록을 조작해 "다 채워졌다"고 우기지
// 못하게 한다(호출자가 이 상수를 읽기만 하지 이 코어가 그 값을 신뢰하지도
// 않는다 -- draftRecord.blockReasonCode는 항상 하드코딩된 null이다).
export const HUMAN_REQUIRED_FIELDS = Object.freeze(["blockReasonCode"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// §B 기계 앵커 세 필드(ownTaskArchivePath/ownTaskArchiveFingerprint/
// recordedAt) -- 셋 다 "호출자가 이미 관측한 기계 사실"이어야 한다(파일
// 경로 문자열, SHA-256 지문 문자열, 시계 판독 문자열). 이 코어는 그 값을
// 스스로 계산하지 않는다(S8 zero-import 계약, hyk412 코어의 staleEnough
// SinceAdmission과 동일한 "어댑터가 계산해 넘긴다" 원칙) -- 셋 중 하나라도
// 비어 있거나 문자열이 아니면 "기계 근거가 아직 다 안 모였다"로 안전측
// 거부한다(빈 문자열/undefined/숫자 등 어떤 타입이 와도 truthy-fold 없이
// 거부 -- hyk412 3R의 checkExplicitNegativeFact와 같은 정신, 다만 여기는
// "부재 확인"이 아니라 "존재 확인"이므로 훨씬 단순한 술어 하나로 충분하다).
function checkMachineAnchorFacts({
  ownTaskArchivePath,
  ownTaskArchiveFingerprint,
  recordedAt,
}) {
  const missing = [];
  if (!isNonEmptyString(ownTaskArchivePath)) missing.push("ownTaskArchivePath");
  if (!isNonEmptyString(ownTaskArchiveFingerprint))
    missing.push("ownTaskArchiveFingerprint");
  if (!isNonEmptyString(recordedAt)) missing.push("recordedAt");
  if (missing.length === 0) return null;
  return {
    state: AUTO_AUTHOR_STATE.MACHINE_ANCHOR_INCOMPLETE,
    ok: false,
    reason: `retirement-auto-author: 기계 앵커 필드 누락(${missing.join(", ")}) -> 은퇴 기록 초안을 조립할 기계 근거가 아직 다 모이지 않음, 거부(안전측 기본값)`,
  };
}

// The one function this module exists to provide.
//
// facts: hyk412-never-consumed-retire-core.mjs의 evaluateNeverConsumedRetirement
// 가 받는 것과 정확히 같은 필드 전부(role/harnessTaskLabel/ledgerReservation/
// dispatchReceiptMatchCount/resultArchiveExists/ownTaskArchiveExists/
// hasLaterRoundArchive/staleEnoughSinceAdmission/successorLabelForRecord)
// **그대로 위임**한다(§2⑶ "새 판정 축 금지") + 이 코어가 추가로 요구하는
// 세 기계 앵커 필드(ownTaskArchivePath/ownTaskArchiveFingerprint/
// recordedAt, §B).
//
// ⛔blockReasonCode를 facts에 넣어도 무시한다 -- 이 함수의 시그니처 자체가
// 그 값을 읽지 않는다(구조적으로 닫힌 표면, §C 아래 참조).
export function evaluateAutoAuthorAuthorization(facts = {}) {
  const {
    role,
    harnessTaskLabel,
    ledgerReservation,
    dispatchReceiptMatchCount,
    resultArchiveExists,
    ownTaskArchiveExists,
    hasLaterRoundArchive,
    staleEnoughSinceAdmission,
    successorLabelForRecord,
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  } = facts;

  const gate = evaluateNeverConsumedRetirement({
    role,
    harnessTaskLabel,
    ledgerReservation,
    dispatchReceiptMatchCount,
    resultArchiveExists,
    ownTaskArchiveExists,
    hasLaterRoundArchive,
    staleEnoughSinceAdmission,
    successorLabelForRecord,
  });

  if (gate.state !== NEVER_CONSUMED_RETIRE_STATE.OPEN) {
    return {
      state: AUTO_AUTHOR_STATE.GATE_CLOSED,
      ok: false,
      gateState: gate.state,
      reason: `retirement-auto-author: hyk412 게이트가 OPEN이 아님(${gate.state}) -> 자동 작성 자격 없음, 거부(안전측 기본값). 게이트 사유: ${gate.reason}`,
    };
  }

  const anchorFailure = checkMachineAnchorFacts({
    ownTaskArchivePath,
    ownTaskArchiveFingerprint,
    recordedAt,
  });
  if (anchorFailure) return anchorFailure;

  // §C blockReasonCode는 항상 null로 하드코딩한다 -- facts.blockReasonCode를
  // 읽는 코드 자체가 이 함수 안에 없다(위조하려면 이 파일의 소스 자체를
  // 고쳐야 한다, 캐치 불가능한 "그냥 안 읽는다"가 가장 강한 닫힘이다).
  return {
    state: AUTO_AUTHOR_STATE.AUTHORIZED_DRAFT,
    ok: true,
    draftRecord: {
      role,
      harnessTaskLabel,
      archivePath: ownTaskArchivePath,
      archiveFingerprintClaimed: ownTaskArchiveFingerprint,
      blockReasonCode: null,
      successorLabel: successorLabelForRecord,
      recordedAt,
      evidence: { source: "hyk412-never-consumed", gateState: gate.state },
    },
    humanRequiredFields: HUMAN_REQUIRED_FIELDS,
    reason: `retirement-auto-author: hyk412 게이트 OPEN + 아카이브 경로/지문/기록시각 세 기계 앵커 확보 -> 은퇴 기록 초안 조립 가능. blockReasonCode는 닫힌 사유 집합(retirement-record-core.mjs의 RETIREMENT_BLOCK_REASON)에 "미소비 방치"를 뜻하는 값이 아직 없어 기계로 못 채움 -> null로 남김(사람 결정 필요, docs/HYK-419-retire-author-design.md §2 참조). 이 초안은 blockReasonCode가 채워지기 전에는 retirement-record-core.mjs의 checkRetirementRecord를 통과하지 못한다(INVALID_REASON_CODE로 거부됨 -- 사람 손이 빠지면 구조적으로 완성되지 않는다).`,
  };
}
