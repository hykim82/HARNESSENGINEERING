// HYK-311-retire-1 (coder-task.md) -- «은퇴 기록»(retirement record) 판정
// 코어.
//
// §1 왜 이걸 만드는가: abort-record-core.mjs(HYK-298)가 연 문은 "이름표
// (`task_id:`) 없이 죽은 라운드"만 구제한다(classifyTaskIdLabel의 kind
// === "MISSING" 한정, HYK-298-key-narrow-4 §2가 확정한 경계 -- 그 경계는
// 건드리지 않는다, 이 파일이 그 코어를 import조차 하지 않는 이유).
// 그런데 실제로는 "이름표는 멀쩡한데(VALID) 영원히 소비될 수 없는" 라운드도
// 생긴다 -- 예: 직전 좌석이 `>>> DONE:` 줄의 타임스탬프를 사람이 읽을 수
// 없는 형식으로 남기고 죽었거나(기계로 파싱 불가), 이후 재작성이 금지된
// 상태이거나, 그 라운드의 태스크 계약 자체가 "이 결과를 고쳐 쓰지 말라"고
// 못박아서 다음 라운드가 그 결과를 정상 소비 영수증 체인으로 절대 만들 수
// 없는 경우다. 이런 라운드는 abort-record 축을 타지 않는다(이름표가
// VALID이므로 evaluateConsumptionDecision이 애초에 그 축을 시도조차
// 안 한다, dispatch-gate-decision.mjs의 maybeResolveAbortRecordForMissingLabel
// 참조) -- 그리고 이제껏 이 상태에서 빠져나가는 설계된 문이 없었다.
//
// 이 모듈이 만드는 문(은퇴, retirement): ORCH가 "이 라운드는 영구히
// 막혔고, 다음 라운드(successorLabel)로 넘어간다"를 증거와 함께 기록
// (`.harness/retirements/<role>-retire-r<N>.json`)하면, 그 기록이 아래
// §3의 독립 검증을 전부 통과할 때만 "소비된 것으로 인정"한다. abort-record
// 축과 동일한 원칙(★공통 문장 재확인) -- 검사를 건너뛰게 만드는 것이
// 아니라, 검사를 통과할 새로운(그러나 여전히 엄격한) 경로를 추가하는
// 것뿐이다. VALID 이름표 라운드의 «정상» 통로(소비 영수증 체인,
// consumption-receipt-core.mjs)는 조금도 바뀌지 않는다 -- 이 축은 그
// 통로가 이미 실패했을 때만 시도되는 별도의, 병렬 경로다(어댑터 쪽 배선
// 참조, dispatch-gate-decision.mjs의 evaluateConsumptionDecision).
//
// §2 S8 원칙(zero-import 코어 계약): abort-record-core.mjs와 동일하게 이
// 코어는 파일을 스스로 읽지 않는다. 호출자(dispatch-gate-decision.mjs의
// 어댑터)가 이미 실제 파일(은퇴 기록 JSON · `.harness/rounds/` 보존
// 사본 · 직전 라운드의 live 결과 파일)을 읽어 구조적으로 추출한 사실만
// 인자로 받는다.
//
// §3 anti-forgery anchor 설계(요구서가 "당신이 정하고 이유를 문서화하라"
// 라고 위임한 부분, 아래는 그 결정과 근거):
//
//   3-1. 아카이브 존재 + 지문(fingerprint) 대조, "아카이브 쪽에서도" --
//        은퇴 기록이 가리키는 아카이브 사본이 실제로 존재해야 하고
//        (archiveExists), 그 사본의 SHA-256이 기록이 주장하는 값
//        (archiveFingerprintClaimed)과 정확히 같아야 한다
//        (archiveFingerprintMatches). ⛔재구현 금지 원칙에 따라 아카이브
//        위치·관례는 새로 만들지 않는다 -- dispatch-gate-decision.mjs가
//        이미 소비 축(tryArchiveFallback)에서 쓰는 `.harness/rounds/
//        <role>-r<N>.md` 보존 사본 관례를 그대로 재사용한다(어댑터 쪽
//        resolveRetirementArchiveCandidate 참조). live 결과 파일이 아직
//        남아 있으면(이 축이 실제로 불려지는 지점 -- 어댑터의
//        evaluateConsumptionDecision -- 은 항상 그 시점에 live 결과
//        파일의 존재를 이미 전제로 하므로, 실무상 "아직 있다" 분기가
//        상시 참이다, 아래 §5 정직 한계 참조) 그 live 지문도 독립적으로
//        같은 값과 대조한다(liveFingerprintMatches) -- 아카이브 사본과
//        live 사본 «둘 다» 같은 값을 가리켜야 위조 여지가 줄어든다(하나만
//        위조해서는 통과 못 한다). liveFingerprintMatches가 null이면
//        "이 시점에 대조할 live 사본이 없었다"는 뜻으로, 그 경우 아카이브
//        쪽 대조 결과 하나로만 판단한다(§5에 그 분기가 왜 현재 배선에서는
//        도달 불가능한지 기록).
//
//   3-2. 닫힌 사유 코드 집합(RETIREMENT_BLOCK_REASON) -- 임의 문자열을
//        사유로 받지 않는다. 집합 밖 값은 무조건 INVALID_REASON_CODE로
//        거부한다(아래 §4).
//
//   3-3. 필수 후속 이름표(successorLabel) -- 없으면 SUCCESSOR_LABEL_MISSING
//        으로 거부한다. 은퇴는 "이 라운드는 끝, 다음은 저 라벨로 간다"는
//        선언이므로 그 다음이 명시되지 않은 은퇴는 애초에 불완전하다.
//
//   3-4. 기계로 확인 가능한 사유는 독립 재확인, 나머지는 정직하게 한계로
//        남긴다 -- MECHANICALLY_CONFIRMABLE_BLOCK_REASONS(아래)에 속한
//        사유(현재는 DONE_TIMESTAMP_NOT_PARSEABLE 하나)만 어댑터가 live
//        결과 파일에서 그 사실 자체(«실제로» `>>> DONE:` 타임스탬프가
//        파싱 불가능한가)를 다시 유도해 blockReasonConfirmed로 넘긴다 --
//        이 코어는 그 사유일 때 blockReasonConfirmed !== true면
//        BLOCK_REASON_UNCONFIRMED로 거부한다("ORCH가 그렇다고 했다"만으로는
//        통과 못 한다, abort-record 축의 §3 검증3과 동일 원칙). 나머지
//        사유(DONE_REWRITE_LOCKED · TASK_CONTRACT_PROHIBITS_REPAIR)는
//        본질적으로 "그 라운드의 태스크 계약 문서/재작성 정책이 실제로
//        그렇게 말하는가"라는, 이 코드베이스가 기계로 재현할 수 없는
//        질문이다 -- 이 코어는 그 사유에 대해 가짜 기계 확인을 만들지
//        않는다(요구서 §3-4 "재현 금지" 그대로). 그 대신 그 비대칭을
//        아래 §5에 정직하게 남긴다.
//
// §4 닫힌 상태 집합(abort-record-core.mjs §4의 선례와 동일한 형태 --
// "판정 불가를 정상으로 접지 않는다"):
//
// | 상태 | 뜻 |
// |---|---|
// | RETIRED | 유일 후보가 아카이브 존재·지문 대조·사유 코드 유효성·(필요시) 기계 재확인·후속 이름표 다섯 관문을 전부 통과 |
// | NO_RECORD | role+harnessTaskLabel이 일치하는 후보가 0개 |
// | AMBIGUOUS | role+harnessTaskLabel이 일치하는 후보가 2개 이상(조용히 하나를 고르지 않는다) |
// | ARCHIVE_MISSING | 유일 후보는 있으나 그 후보가 가리키는 아카이브 사본 자체가 없음 |
// | FINGERPRINT_MISMATCH | 아카이브 사본은 있으나 지문이 기록의 주장과 다르거나(또는 live 사본과 대조했을 때 불일치) |
// | INVALID_REASON_CODE | 블록 사유 코드가 닫힌 집합 밖 |
// | BLOCK_REASON_UNCONFIRMED | 기계로 확인 가능한 사유인데 어댑터가 독립적으로 재확인하지 못함 |
// | SUCCESSOR_LABEL_MISSING | 후속 이름표(successorLabel)가 비어 있음 |
//
// RETIRED는 이 표의 단 하나의 행에서만 나온다.
//
// §5 정직 한계(coder-task §4-5 요구와 동일한 정직성 기준):
//   (a) 이 코어는 "은퇴 기록 후보들이 주어졌을 때 그것을 RETIRED/거부로
//       정확히 매핑한다"는 판정 로직 하나만 증명한다. 후보를 실제 파일
//       (`.harness/retirements/*.json`)에서 읽어내는 일, 아카이브 사본을
//       찾아 지문을 계산하는 일, live 결과 파일에서 DONE 타임스탬프
//       파싱가능성을 재확인하는 일은 이 코어의 범위 밖이며
//       dispatch-gate-decision.mjs 쪽 어댑터(evaluateRetirementDecision)의
//       몫이다.
//   (b) DONE_REWRITE_LOCKED · TASK_CONTRACT_PROHIBITS_REPAIR 두 사유는
//       "정말로 재작성이 잠겨 있었는지" · "그 태스크의 계약 문서가 정말로
//       수리를 금지했는지"를 이 코드베이스가 기계로 독립 검증할 방법이
//       없다 -- 이 두 사유를 쓰는 은퇴 기록은 ORCH(또는 그 대리인)의
//       «주장»을 그대로 신뢰한다(아카이브/지문/후속이름표 네 관문은 여전히
//       통과해야 하지만, "그 사유가 사실인가" 자체는 검증되지 않는다).
//       이것은 위조 표면이 완전히 닫히지 않았다는 뜻이다 -- 아카이브 사본과
//       지문 위조가 (b·c 두 계층 모두) 함께 필요하다는 점이 진입장벽을
//       높이지만, "그 사유가 사실이다"까지 증명하지는 않는다.
//   (c) 3-1의 liveFingerprintMatches===null 분기(아카이브 사본 대조만으로
//       판단)는 «현재 배선»에서는 도달 불가능하다 -- 어댑터의 진입점
//       (evaluateConsumptionDecision)이 이 축을 시도하는 시점은 항상
//       직전 라운드의 live 결과 파일이 이미 존재를 확인받은 뒤이기
//       때문이다(그 파일이 없으면 함수 자체가 그보다 먼저 null을 반환해
//       부트스트랩으로 물러난다). 이 코어와 어댑터는 그 분기를 방어적으로
//       지원하지만(미래에 호출 지점이 달라질 경우를 대비), 오늘의 실제
//       호출 경로는 그 분기를 결코 밟지 않는다 -- 이 사실을 숨기지 않고
//       여기 명시한다.
//   (d) 이 판정이 사람이 실제로 위조하려 시도하는 모든 방법(예: 어댑터
//       자체를 몰래 패치, 또는 `.harness/rounds/` 보존 사본 자체를 직접
//       조작)까지 막지는 못한다 -- 이 코어가 보장하는 것은 "주어진 사실이
//       정직하게 구조화됐다면 판정이 안전측"이라는 것뿐이다(abort-record-
//       core.mjs §5-b와 동일한 한계).

// HYK-398 §2-⑵: DONE_PREDATES_DROPPED_AT 추가 -- "DONE이 파싱은 되는데
// dropped_at보다 과거"(=relay-handshake.mjs의 기존 stale 거부 사유와
// 동일한 사실)인 라운드도 영구히 소비 불가하다는 점은
// DONE_TIMESTAMP_NOT_PARSEABLE과 같다(둘 다 "정상 소비 경로가 절대 다시
// 통과할 수 없는, 기계로 재확인 가능한 사실"). 임의 문자열이 아니라 이
// 닫힌 집합에 값을 하나 더하는 형태를 유지한다(§3-2 요구 그대로).
export const RETIREMENT_BLOCK_REASON = Object.freeze({
  DONE_TIMESTAMP_NOT_PARSEABLE: "DONE_TIMESTAMP_NOT_PARSEABLE",
  DONE_PREDATES_DROPPED_AT: "DONE_PREDATES_DROPPED_AT",
  DONE_REWRITE_LOCKED: "DONE_REWRITE_LOCKED",
  TASK_CONTRACT_PROHIBITS_REPAIR: "TASK_CONTRACT_PROHIBITS_REPAIR",
});

// §3-4 -- 이 부분집합만 어댑터가 live 파일에서 독립 재확인한다.
// HYK-398: DONE_PREDATES_DROPPED_AT도 기계로 독립 재확인 가능하다(어댑터가
// live 결과 파일의 DONE과 live task 파일의 dropped_at을 각각 다시 읽어
// 재파싱하고 doneAt < droppedAt을 스스로 다시 유도한다) -- 그래서
// DONE_TIMESTAMP_NOT_PARSEABLE과 같은 집합에 넣는다(§3-4 원칙 그대로,
// "ORCH가 그렇다고 했다"만으로는 통과 못 한다).
export const MECHANICALLY_CONFIRMABLE_BLOCK_REASONS = Object.freeze(
  new Set([
    RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE,
    RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT,
  ]),
);

export const RETIREMENT_RECORD_STATE = Object.freeze({
  RETIRED: "RETIRED",
  NO_RECORD: "NO_RECORD",
  AMBIGUOUS: "AMBIGUOUS",
  ARCHIVE_MISSING: "ARCHIVE_MISSING",
  FINGERPRINT_MISMATCH: "FINGERPRINT_MISMATCH",
  INVALID_REASON_CODE: "INVALID_REASON_CODE",
  BLOCK_REASON_UNCONFIRMED: "BLOCK_REASON_UNCONFIRMED",
  SUCCESSOR_LABEL_MISSING: "SUCCESSOR_LABEL_MISSING",
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// eslint complexity 상한 회피 -- 필드 목록을 순회하는 형태로 써서 6개의
// `??` 연쇄(abort-record-core.mjs의 describeRecord보다 한 필드 더 많다)가
// 분기 복잡도로 잡히지 않게 한다. 동작은 이전과 동일(각 필드가 없으면
// null로 채워 넣는다).
const DESCRIBE_FIELDS = [
  "role",
  "harnessTaskLabel",
  "blockReasonCode",
  "successorLabel",
  "archivePath",
  "recordedAt",
];

function describeRecord(record) {
  const out = {};
  for (const field of DESCRIBE_FIELDS) {
    out[field] = record?.[field] ?? null;
  }
  return JSON.stringify(out);
}

// role/harnessTaskLabel «둘 다» 갖춘 구조적으로 유효한 후보만 매칭 대상
//으로 삼는다(abort-record-core.mjs의 isStructurallyValid와 동일한 빈 값
// 새는 구멍 차단 -- 위조자가 필드를 비워 undefined===undefined로 우연히
// 매치되는 경로를 원천 차단). blockReasonCode/successorLabel은 여기서
// 걸러내지 않는다 -- 그 둘의 부재/오류는 이후 단계에서 각각 구별되는
// 상태(INVALID_REASON_CODE/SUCCESSOR_LABEL_MISSING)로 드러나야 하므로,
// 매칭 단계에서 조용히 NO_RECORD로 뭉개면 안 된다(§4 요구: 세 위조 변종이
// 서로 다른 사유로 거부돼야 한다).
function isMatchable(record) {
  return (
    isNonEmptyString(record?.role) && isNonEmptyString(record?.harnessTaskLabel)
  );
}

function resolveMatchingRetirementCandidate(
  candidates,
  role,
  harnessTaskLabel,
) {
  const list = Array.isArray(candidates) ? candidates : [];
  const matches = list.filter(
    (c) =>
      isMatchable(c?.record) &&
      c.record.role === role &&
      c.record.harnessTaskLabel === harnessTaskLabel,
  );
  if (matches.length === 0) {
    const seen = list
      .filter((c) => isMatchable(c?.record))
      .map((c) => describeRecord(c.record))
      .join(" / ");
    return {
      ok: false,
      result: {
        state: RETIREMENT_RECORD_STATE.NO_RECORD,
        ok: false,
        reason: `retirement-record: role=${role} label=${harnessTaskLabel}과 일치하는 은퇴 기록 후보가 하나도 없음 -> 은퇴 기록으로 인정하지 않음, 거부(안전측 기본값). 발견된 후보: ${seen || "(없음)"}`,
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      result: {
        state: RETIREMENT_RECORD_STATE.AMBIGUOUS,
        ok: false,
        reason: `retirement-record: role=${role} label=${harnessTaskLabel}과 일치하는 은퇴 기록 후보가 ${matches.length}개 -- 어느 것이 이 라운드의 것인지 결정할 수 없다(ambiguous) -> 조용히 하나를 고르지 않고 거부(안전측 기본값)`,
      },
    };
  }
  return { ok: true, candidate: matches[0] };
}

// eslint complexity 상한 회피(§ checkRetirementRecord 자신의 분기 수를
// 줄이려고 뽑았다, HYK-244-receipt-core-1b 선례와 동일한 이유 -- 판정/
// 문구는 조금도 바뀌지 않는다, 몸통만 쪼갠다). 아카이브 존재·지문 두
// 관문을 하나로 묶어 확인한다. 통과하면 null, 실패하면 그 사유의
// {state, ok:false, reason}.
function checkArchiveFacts(candidate, record) {
  if (candidate.archiveExists !== true) {
    return {
      state: RETIREMENT_RECORD_STATE.ARCHIVE_MISSING,
      ok: false,
      reason: `retirement-record: 은퇴 기록(${describeRecord(record)})이 가리키는 아카이브 사본(.harness/rounds/)이 존재하지 않음 -> 거부(안전측 기본값)`,
    };
  }
  if (
    candidate.archiveFingerprintMatches !== true ||
    candidate.liveFingerprintMatches === false
  ) {
    return {
      state: RETIREMENT_RECORD_STATE.FINGERPRINT_MISMATCH,
      ok: false,
      reason: `retirement-record: 은퇴 기록(${describeRecord(record)})의 지문 대조 실패(아카이브 사본 지문 일치=${candidate.archiveFingerprintMatches === true} / live 사본 지문 일치=${candidate.liveFingerprintMatches}) -> 거부(안전측 기본값, 위조 또는 다른 라운드를 가리킴)`,
    };
  }
  return null;
}

// 같은 이유로 뽑았다 -- 사유 코드 유효성·기계 재확인·후속 이름표 세
// 관문을 하나로 묶는다. 통과하면 null, 실패하면 그 사유의
// {state, ok:false, reason}.
function checkReasonAndSuccessorFacts(candidate, record) {
  if (
    !Object.values(RETIREMENT_BLOCK_REASON).includes(record.blockReasonCode)
  ) {
    return {
      state: RETIREMENT_RECORD_STATE.INVALID_REASON_CODE,
      ok: false,
      reason: `retirement-record: 은퇴 기록(${describeRecord(record)})의 blockReasonCode('${record?.blockReasonCode}')가 닫힌 사유 코드 집합 밖 -> 거부(임의 문자열을 사유로 받지 않는다)`,
    };
  }
  if (
    MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(record.blockReasonCode) &&
    candidate.blockReasonConfirmed !== true
  ) {
    return {
      state: RETIREMENT_RECORD_STATE.BLOCK_REASON_UNCONFIRMED,
      ok: false,
      reason: `retirement-record: 은퇴 기록(${describeRecord(record)})의 사유(${record.blockReasonCode})는 기계로 확인 가능한 사유인데, 그 사실이 live 결과 파일에서 독립적으로 재확인되지 않음 -> "ORCH가 그렇다고 했다"만으로는 인정하지 않음, 거부(안전측 기본값)`,
    };
  }
  if (!isNonEmptyString(record.successorLabel)) {
    return {
      state: RETIREMENT_RECORD_STATE.SUCCESSOR_LABEL_MISSING,
      ok: false,
      reason: `retirement-record: 은퇴 기록(${describeRecord(record)})에 후속 이름표(successorLabel)가 없음 -> 거부(은퇴는 "다음은 저 라벨로 간다"는 선언을 반드시 포함해야 한다)`,
    };
  }
  return null;
}

// The one function this module exists to provide (mirrors abort-record-
// core.mjs's checkAbortRecord contract). Never throws, never returns
// RETIRED without every required fact checked, never returns a
// non-RETIRED state without a human-readable `reason`.
//
// facts:
//   role                -- 이 축을 적용하는 라운드의 role(대문자 정규화는
//                          호출자 책임, abort-record 축과 동일 관례).
//   harnessTaskLabel    -- 직전 라운드 결과 파일에서 뽑힌, VALID로
//                          분류된 task_id 이름표(호출자가 이미 classify
//                          -- kind==="VALID" -- 를 마친 값).
//   candidates          -- 호출자가 이미 구조적으로 추출한 은퇴 기록
//                          후보 배열. 각 원소:
//                          { record: { role, harnessTaskLabel,
//                                      archivePath, archiveFingerprintClaimed,
//                                      blockReasonCode, successorLabel,
//                                      recordedAt, evidence },
//                            archiveExists: boolean,
//                            archiveFingerprintMatches: boolean,
//                            liveFingerprintMatches: boolean | null,
//                            blockReasonConfirmed: boolean | null }
export function checkRetirementRecord({
  role,
  harnessTaskLabel,
  candidates,
} = {}) {
  if (!isNonEmptyString(role) || !isNonEmptyString(harnessTaskLabel)) {
    return {
      state: RETIREMENT_RECORD_STATE.NO_RECORD,
      ok: false,
      reason:
        "retirement-record: role 또는 harnessTaskLabel이 없음 -> 이 축을 적용할 대상을 확정할 수 없음, 거부(안전측 기본값)",
    };
  }

  const resolved = resolveMatchingRetirementCandidate(
    candidates,
    role,
    harnessTaskLabel,
  );
  if (!resolved.ok) return resolved.result;
  const { candidate } = resolved;
  const record = candidate.record;

  const archiveFailure = checkArchiveFacts(candidate, record);
  if (archiveFailure) return archiveFailure;

  const reasonFailure = checkReasonAndSuccessorFacts(candidate, record);
  if (reasonFailure) return reasonFailure;

  return {
    state: RETIREMENT_RECORD_STATE.RETIRED,
    ok: true,
    reason: `retirement-record: 은퇴 기록(${describeRecord(record)}) 아카이브 존재+지문 일치 + 사유 코드 유효(${record.blockReasonCode}) + (필요시) 기계 재확인 + 후속 이름표(${record.successorLabel}) 확인 -> 영구히 막힌 라운드를 은퇴 처리, 소비 완료로 인정, 허용`,
  };
}

// §2-B 게이트 축 어댑터: dispatch-gate-decision-core.mjs의
// combineGateDecisions가 받는 개별 decision 모양(통과면 null, 아니면
// { state, allow:false, reason })으로 그대로 내놓는다 -- abort-record-
// core.mjs의 toAbortRecordGateDecision과 동일한 관례.
export function toRetirementGateDecision(facts) {
  const verdict = checkRetirementRecord(facts);
  if (verdict.state === RETIREMENT_RECORD_STATE.RETIRED) return null;
  return {
    state: verdict.state,
    allow: false,
    reason: verdict.reason,
  };
}
