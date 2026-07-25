// HYK-171 사이클4b-2b-1 (coder-task.md §2-B) -- strict-provenance 소유권
// 판정(순수 코어).
//
// 비타협:
// - ptyId 문자열 일치 + 같은 worktreeId가 성립할 때만 OWNED 후보다.
// - handle/제목/화면 미리보기/tabId/leafId는 소유권 근거로 절대 쓰지
//   않는다(4b-1 REVIEW 지시 유효 -- 관측값 추정 금지). 그런 값은 이 파일
//   시그니처에 아예 등장하지 않는다(로그/진단은 호출자 몫).
// - 대장에 없는 ptyId는 절대 OWNED가 아니다(사후 수집 금지 -- 이 코어는
//   registry를 읽기만 하고 채우지 않는다).
// - 대장 레코드의 필수 필드(ptyId/worktreeId/capturedAt)가 하나라도
//   결손이면 UNPROVEN(fail-closed).
// - 후보 2개 이상이 독립적으로 OWNED로 풀리면 AMBIGUOUS(자동 선택 금지).
// - S6 경계: 이 파일은 특정 벤더 CLI 이름·셸 이름·화면 좌표 개념·프로세스
//   식별자를 모른다 -- 그런 문자열/정규식 리터럴을 갖지 않는다. 입력은
//   이미 정규화된 {ptyId, worktreeId, paneKey} 구조체만 받는다.
// - REVIEW review-1 P1-1 (재확인, 2026-07-26): 위 첫 번째 비타협("ptyId +
//   같은 worktreeId일 때만 OWNED 후보")은 corroboration 총점 계산과 별개로
//   강제된다 -- observed가 worktreeId를 밝히지 않으면 다른 축이 아무리
//   맞아도 OWNED가 아니다. `policy.minCorroboration`도 정책 입력으로 2
//   미만으로 낮출 수 없다(안전장치를 정책 파라미터로 끌 수 없다).

export const OWNERSHIP = Object.freeze({
  OWNED: "OWNED",
  NOT_OWNED: "NOT_OWNED",
  AMBIGUOUS: "AMBIGUOUS",
  UNPROVEN: "UNPROVEN",
});

export const REASON = Object.freeze({
  SEAT_OWNED: "SEAT_OWNED",
  SEAT_NOT_IN_REGISTRY: "SEAT_NOT_IN_REGISTRY",
  SEAT_PROVENANCE_INCOMPLETE: "SEAT_PROVENANCE_INCOMPLETE",
  SEAT_CORROBORATION_INSUFFICIENT: "SEAT_CORROBORATION_INSUFFICIENT",
  SEAT_AMBIGUOUS_CANDIDATES: "SEAT_AMBIGUOUS_CANDIDATES",
  SEAT_REGISTRY_CONFLICT: "SEAT_REGISTRY_CONFLICT",
});

const REQUIRED_RECORD_FIELDS = ["ptyId", "worktreeId", "capturedAt"];
export const DEFAULT_MIN_CORROBORATION = 2;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function hasCompleteProvenance(record) {
  return REQUIRED_RECORD_FIELDS.every((f) => isNonEmptyString(record?.[f]));
}

// 독립 축 3개(ptyId/worktreeId/paneKey) 각각에서 관측 후보와 대장 레코드가
// 일치했는지 센다. 후보가 그 축의 값을 아예 제공하지 않으면(비교 불능)
// 일치로 치지 않는다 -- "모른다"를 "일치한다"로 슬쩍 넘기지 않는다.
function computeCorroboration(record, candidate) {
  let count = 0;
  if (isNonEmptyString(candidate.ptyId) && candidate.ptyId === record.ptyId) {
    count += 1;
  }
  if (
    isNonEmptyString(candidate.worktreeId) &&
    candidate.worktreeId === record.worktreeId
  ) {
    count += 1;
  }
  if (
    isNonEmptyString(candidate.paneKey) &&
    isNonEmptyString(record.paneKey) &&
    candidate.paneKey === record.paneKey
  ) {
    count += 1;
  }
  return count;
}

// 후보 1개를 대장과 대조(judgeSeatOwnership에서 분리 -- quality-check
// 복잡도 상한 준수). registry 오염(같은 ptyId 2건 이상)은 여기서 즉시
// SEAT_REGISTRY_CONFLICT로 fail-closed 처리한다.
function judgeSingleCandidate(registry, candidate, minCorroboration) {
  const seats = Array.isArray(registry?.seats) ? registry.seats : [];
  const ptyId = candidate.ptyId;
  if (!isNonEmptyString(ptyId)) {
    return {
      verdict: OWNERSHIP.NOT_OWNED,
      reason: REASON.SEAT_NOT_IN_REGISTRY,
      corroboration: 0,
    };
  }

  const matches = seats.filter((r) => isPlainObject(r) && r.ptyId === ptyId);
  if (matches.length === 0) {
    return {
      verdict: OWNERSHIP.NOT_OWNED,
      reason: REASON.SEAT_NOT_IN_REGISTRY,
      corroboration: 0,
    };
  }
  if (matches.length > 1) {
    return {
      verdict: OWNERSHIP.AMBIGUOUS,
      reason: REASON.SEAT_REGISTRY_CONFLICT,
      corroboration: 0,
    };
  }

  const record = matches[0];
  if (!hasCompleteProvenance(record)) {
    return {
      verdict: OWNERSHIP.UNPROVEN,
      reason: REASON.SEAT_PROVENANCE_INCOMPLETE,
      corroboration: 0,
    };
  }

  // 관측 후보가 worktreeId를 밝혔는데 대장 레코드와 다르면 -- 이건 "축이
  // 부족하다"가 아니라 "다른 워크트리"라는 확정 신호다. NOT_OWNED로 즉시
  // 접는다(corroboration 계산으로 흐리지 않는다).
  if (
    isNonEmptyString(candidate.worktreeId) &&
    candidate.worktreeId !== record.worktreeId
  ) {
    return {
      verdict: OWNERSHIP.NOT_OWNED,
      reason: REASON.SEAT_NOT_IN_REGISTRY,
      corroboration: 0,
    };
  }

  // ptyId 일치는 이미 위에서 확인됐다 -- 여기서는 "같은 worktreeId"가
  // 확실히 성립했는지(관측이 밝혔고, 대장과 같았는지)만 별도로 기록한다.
  const worktreeIdConfirmed =
    isNonEmptyString(candidate.worktreeId) &&
    candidate.worktreeId === record.worktreeId;

  const corroboration = computeCorroboration(record, candidate);

  // REVIEW review-1 P1-1: "ptyId 일치 + 같은 worktreeId"는 OWNED의 별도
  // 필수조건이다 -- corroboration 총점과 독립적으로 강제한다. 그렇지 않으면
  // (예: 후보가 worktreeId를 밝히지 않고 paneKey만 우연히 일치해도)
  // ptyId+paneKey 두 축만으로 corroboration이 minCorroboration을 채워
  // worktreeId 확인 없이 OWNED가 나올 수 있다 -- 그건 이 코어의 비타협을
  // 어긴다.
  if (!worktreeIdConfirmed) {
    return {
      verdict: OWNERSHIP.UNPROVEN,
      reason: REASON.SEAT_CORROBORATION_INSUFFICIENT,
      corroboration,
    };
  }

  if (corroboration < minCorroboration) {
    return {
      verdict: OWNERSHIP.UNPROVEN,
      reason: REASON.SEAT_CORROBORATION_INSUFFICIENT,
      corroboration,
    };
  }

  return {
    verdict: OWNERSHIP.OWNED,
    reason: REASON.SEAT_OWNED,
    corroboration,
    record,
  };
}

// judgeSeatOwnership({ registry, observed, policy }) -> OWNED/NOT_OWNED/
// AMBIGUOUS/UNPROVEN.
//
// observed: 단일 후보 객체({ptyId, worktreeId, paneKey}) 또는 그 배열. 배열일
// 때는 각 후보를 독립적으로 대장과 대조한다 -- 그중 2개 이상이 각자 OWNED로
// 풀리면(예: 죽지 않은 좌석이 여러 개 관측된 상황) 자동으로 첫 번째를
// 고르지 않고 AMBIGUOUS를 낸다(fail-closed, coder-task.md §B 비타협).
//
// policy.minCorroboration 기본 2(§C) -- 미만이면 UNPROVEN. REVIEW review-1
// P1-1: 이 값은 정책 입력으로 안전장치를 끄는 문이 되어서는 안 된다 -- 2
// 미만(1·0·음수)·비정수·비숫자는 전부 거부하고 기본값 2로 되돌린다(더
// 엄격하게 3 이상으로 올리는 것만 허용).
//
// 이 함수를 export하는 이유(정직 기록): ptyId+worktreeId 확인이 이미 위의
// 별도 필수조건(worktreeIdConfirmed)으로 강제되므로, 그 조건을 통과한
// 경로에서 corroboration은 항상 최소 2(ptyId축+worktreeId축)다 -- 즉
// 이 하한 clamp 하나만 없앤다고 해서 judgeSeatOwnership의 최종 verdict가
// 바뀌는 입력은 (현재 구조상) 존재하지 않는다(수학적으로 확인함, mutation
// #10 재현 기록 참조). 그래서 mutation #10은 judgeSeatOwnership을 통한
// end-to-end 시나리오가 아니라 이 함수 자체의 clamp 계약을 직접 단위
// 시험한다 -- 두 안전장치(별도 worktreeId 필수조건 + 하한 clamp)는 의도적
// 다중 방어(defense-in-depth)이지, 서로를 대체하지 않는다.
function resolveMinCorroboration(rawValue) {
  if (
    typeof rawValue === "number" &&
    Number.isInteger(rawValue) &&
    rawValue >= DEFAULT_MIN_CORROBORATION
  ) {
    return rawValue;
  }
  return DEFAULT_MIN_CORROBORATION;
}
export { resolveMinCorroboration };

export function judgeSeatOwnership({ registry, observed, policy } = {}) {
  const p = isPlainObject(policy) ? policy : {};
  const minCorroboration = resolveMinCorroboration(p.minCorroboration);
  const candidates = Array.isArray(observed) ? observed : [observed];

  const results = candidates.map((c) =>
    judgeSingleCandidate(registry, isPlainObject(c) ? c : {}, minCorroboration),
  );

  const owned = results.filter((r) => r.verdict === OWNERSHIP.OWNED);
  if (owned.length > 1) {
    return {
      verdict: OWNERSHIP.AMBIGUOUS,
      reason: REASON.SEAT_AMBIGUOUS_CANDIDATES,
      corroboration: 0,
      candidateCount: owned.length,
    };
  }
  if (owned.length === 1) return owned[0];

  const conflict = results.find(
    (r) => r.reason === REASON.SEAT_REGISTRY_CONFLICT,
  );
  if (conflict) return conflict;

  const unproven = results.find((r) => r.verdict === OWNERSHIP.UNPROVEN);
  if (unproven) return unproven;

  return (
    results[0] ?? {
      verdict: OWNERSHIP.NOT_OWNED,
      reason: REASON.SEAT_NOT_IN_REGISTRY,
      corroboration: 0,
    }
  );
}
