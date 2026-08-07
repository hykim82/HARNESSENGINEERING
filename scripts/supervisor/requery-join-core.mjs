// HYK-183 C-3 (coder-task.md §5, SV-8 후반부) -- "독립 재조회 join" 판정
// 코어.
//
// 배경(coder-task.md §1): SV-8 = "원시 생성 응답이 가공 전 형태로
// 보존되고, 소비 시 `terminal show`x`dispatch-show` 독립 재조회 join".
// C-2(raw-preserve-core.mjs)는 앞부분(원시 보존)만 맡았다. 이 코어는
// 뒷부분 -- 소비 시점에 두 관측(`terminal show`/`dispatch-show`)이 "각각
// 새로 조회된 것인가"만 판정한다.
//
// ★범위(ORCH가 착수 전 실측해 한용이 확정): pane 키 대조 자체는
// `dispatch-bound-seat-proof.mjs`의 `judgeDispatchBoundSeatProof`가 이미
// 한다. 이 코어는 그 판정을 재구현하지 않고 **주입받아** 쓴다. 이 코어가
// 새로 판정하는 것은 "두 관측이 같은 조회에서 나왔는가 / 이번 소비 회차의
// 것인가 / 채취 정보가 온전한가 / 같은 pane을 둘 이상이 주장하는가"뿐이다.
//
// 이 계약이 보장하지 않는 것 / 정하지 않는 것 (S11 필수, 문구 그대로):
// - "이 코어는 실제로 다시 조회했다는 «행위» 자체를 보장하지 않는다 --
//   주어진 두 관측이 «독립 재조회의 성질을 갖췄는가»만 판정한다. 그 결선은
//   A-5·A-6이며 승인 밖이다."
// - "이 판정 사슬은 아직 프로덕션 경로 어디에서도 호출되지 않는다(참조처가
//   계약·시험 파일뿐). 규칙이 준비된 것과 그 규칙이 실제로 도는 것은
//   다르다."
// - "채취 정보는 호출자가 준다 -- 결손·형식 위반은 잡지만 호출자가 성실히
//   두 번 조회했는지는 원리적으로 증명할 수 없다."
// - "`orca`를 호출하지 않는다 -- 명령 문자열 조립도 하지 않는다."
// - 좌석 생애(종료 전후 뒤섞임) 축은 이 코어가 판정하지 않는다 -- 아래
//   "좌석 생애 축" 절 참조. gap #56 참조.
//
// 어휘 처리(coder-task.md §3-d):
// 1. `seat-proof-contract-v1.mjs`가 고정한 `SEAT_PROOF`(PROVEN/UNPROVEN)
//    값 자체는 아래 `SEAT_PROOF_VERDICT_PROVEN`/`SEAT_PROOF_VERDICT_UNPROVEN`
//    로 재선언해 그대로 재사용한다(re-export 아님, C-2의
//    raw-preserve-core.test.mjs가 재선언한 것과 같은 이유 -- eslint
//    `no-restricted-imports`가 scripts/relay/* 밖에서 relay를 import하는
//    것을 전역으로 막는다(eslint.config.mjs 최상위 규칙, scripts/relay/**
//    만 off로 재활성화됨). scripts/supervisor는 그 예외에 없다). 판정
//    로직(`judgeDispatchBoundSeatProof`) 자체는 재구현하지 않고, 호출자가
//    그 함수의 출력을 그대로 주입한 `seatProof` 인자를 읽기만 한다.
// 2. 아래 `채취 정보`(`queryId`/`requeryRound`/`source`)는 이 계약에 없던
//    개념이라 이 조각이 새로 도입한다(신규 도입 -- C-2가
//    `RAW_PRESERVATION_REASON`에서 한 형태를 그대로 따름). 벤더 응답
//    필드가 아니라 호출자가 조회할 때마다 스스로 붙이는 기록이다.
//
// 채취 정보(`capture`) 최소 항목:
// - `queryId` -- 조회 1회마다 고유한 문자열. 두 관측의 `queryId`가 같으면
//   "한 번 조회해 둘로 나눠 씀"이므로 거부(SAME_QUERY_SHARED).
// - `requeryRound` -- 이번 소비 회차 번호(1 이상 정수, 시각이 아니라 순서
//   표식 -- coder-task.md §2-9). 두 관측의 `requeryRound`가 서로 같은지
//   대조한다(다르면 REQUERY_ROUND_MISMATCH -- 낡은 관측이 섞이면 호출자가
//   부여한 회차 번호가 어긋나며 여기서 걸린다). **§11 재작업 2R 정정**:
//   1R 헤더는 여기에 *"호출자가 기대한 회차와도 다르면 거부라는 §5 원문
//   요건은 이 순수 함수의 인자로는 표현되지 않는다"*고 적었다 -- **더 이상
//   사실이 아니다.** REVIEW가 `expectedRequeryRound: 99`를 줘도 양쪽
//   capture가 `1`로 서로 일치하면 통과하는 구멍을 실측했다(과거 회차
//   쌍이 통과). 그래서 이 코어는 이제 **`expectedRequeryRound`를 필수
//   입력으로 받는다** -- 양쪽 capture의 `requeryRound`가 **둘 다** 이
//   값과 정확히 일치할 때에만 통과시킨다(하나라도 다르면
//   EXPECTED_REQUERY_ROUND_MISMATCH). 결손·양의 정수 아님은
//   "괜찮음"으로 읽지 않고 fail-closed(EXPECTED_REQUERY_ROUND_INVALID).
//   기존 "두 capture 상호 일치" 검사(REQUERY_ROUND_MISMATCH)는 그대로
//   남긴다 -- 두 축은 다르다("서로 어긋남" vs "기대 회차와 어긋남").
// - `source` -- 어느 조회에서 왔는지. `terminal`은 반드시
//   `CAPTURE_SOURCE.TERMINAL_SHOW`, `dispatch`는 반드시
//   `CAPTURE_SOURCE.DISPATCH_SHOW`여야 한다(엇갈리면 SOURCE_MISMATCH).
//
// 좌석 생애 축(coder-task.md §2-8, §5 경고 셋 중 (3)과는 별개 항목 ·
// §10 재작업 1R로 갱신):
// "종료 전후 뒤섞임"을 판정하려면 좌석의 생애(incarnation/세대)를 구분할
// 근거가 필요하다. `terminal show`/`dispatch-show` 원시 응답 자체의 필드
// (normalizeTerminalShow/normalizeDispatchShow 출력)에는 세대 카운터가
// 없다 -- 그건 여전히 사실이다. **1R 정정(coder-task.md §10 ORCH 자인)**:
// 그러나 이 판정 근거는 벤더 응답이 아니라 **우리 쪽 registry 기록**
// (seatRecord)에 이미 존재한다 -- `scripts/relay/dispatch-correlation-
// core.mjs`의 `judgeDispatchCorrelation({seatRecord, dispatchShow,
// observed})`가 `incarnationMatches`로 taskId/dispatchId가 seatRecord·
// dispatchShow·observed 셋 다에서 일치하는지 판정하고, 불일치(과거 세대의
// 관측이 새 세대인 척 섞임)면 `MISMATCH/INCARNATION_MISMATCH`를 낸다(그
// 시험 계약은 `hyk171-cycle4b2b2-axisA-mutation.test.mjs` mutation A4가
// 명시: "낡은 배정이 PROVEN이 되면 안 된다"). 벤더 응답에 없는 필드를
// 지어내는 것이 아니다 -- 입력이 우리 쪽 기록이기 때문이다(§2-8 위반
// 아님, ORCH 실측). 그래서 이 코어는 이 축을 **재구현하지 않고 위임**한다
// -- 호출자가 `judgeDispatchCorrelation`을 미리 돌려 그 출력을 `correlation`
// 인자로 주입하면, 이 코어는 `verdict !== PROVEN`이면 그 즉시 NOT_JOINED로
// 접고 원래 `reason`을 `correlationReason`에 그대로 보존한다(§2-10, 같은
// 형태를 seatProofReason과 함께 유지). `correlation`이 없거나 형태가
// 아니면 "검사 못 함"이므로 fail-closed(CORRELATION_INVALID) -- 결손을
// 통과로 접지 않는다. **남는 정직 한계(gap #56 새 문구, 아래 헤더 절
// 참조)**: 이 위임이 보는 것은 여전히 우리 쪽 registry 기록의 내적
// 일관성일 뿐이며, 그 기록 자체가 진실인지·호출자가 실제로
// `judgeDispatchCorrelation`을 돌렸는지는 이 코어가 알 수 없다.
//
// 비타협(coder-task.md §2):
// - I/O 0 -- fs/child_process/네트워크 호출 전부 금지. import 없음(외부
//   모듈을 참조하지 않으므로 이 파일 자신이 구조적으로 I/O 표면이 없다).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, seatProofReason, correlationReason}`을
//   반환한다.
// - `judgeDispatchBoundSeatProof`/`judgeDispatchCorrelation` 둘 다
//   재호출/재구현하지 않는다 -- `seatProof`/`correlation` 인자는 그
//   함수들의 출력을 그대로 주입받은 것으로 신뢰하고 읽기만 한다. 실패였으면
//   그 사유(`reasonCode`/`reason`)를 각각 `seatProofReason`/
//   `correlationReason`에 그대로 보존한다(여러 사유를 하나로 접지 않는다).
// - 시간 비교 판정 0 -- `requeryRound`는 순서 표식이지 시각이 아니다. 이
//   파일은 `Date.now()`/시각 필드를 전혀 읽지 않는다.

export const REQUERY_JOIN_VERDICT = Object.freeze({
  JOINED: "JOINED",
  NOT_JOINED: "NOT_JOINED",
});

// 신규 도입(위 헤더 "채취 정보" 절 참조) -- 이 계약에 없던 채취 출처 표식.
export const CAPTURE_SOURCE = Object.freeze({
  TERMINAL_SHOW: "terminal-show",
  DISPATCH_SHOW: "dispatch-show",
});

// 신규 도입(위 헤더 "채취 정보" 절 참조) -- join 판정 사유 전량 열거.
// "좌석 증명 실패"는 별도 사유코드로 접지 않고, 그 세부 사유는
// `seatProofReason`에 그대로 보존한다(이 REASON 자체는 "좌석 증명이
// 실패했다"는 사실만 표시).
export const REQUERY_JOIN_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  TERMINAL_NORMALIZED_INVALID: "TERMINAL_NORMALIZED_INVALID",
  DISPATCH_NORMALIZED_INVALID: "DISPATCH_NORMALIZED_INVALID",
  CAPTURE_INCOMPLETE: "CAPTURE_INCOMPLETE",
  SOURCE_MISMATCH: "SOURCE_MISMATCH",
  OBSERVED_PANE_KEYS_MISSING: "OBSERVED_PANE_KEYS_MISSING",
  DUPLICATE_PANE: "DUPLICATE_PANE",
  SAME_QUERY_SHARED: "SAME_QUERY_SHARED",
  REQUERY_ROUND_MISMATCH: "REQUERY_ROUND_MISMATCH",
  SEAT_PROOF_INVALID: "SEAT_PROOF_INVALID",
  SEAT_PROOF_UNPROVEN: "SEAT_PROOF_UNPROVEN",
  // §10 재작업 1R 신규 -- 좌석 생애(종료 전후 뒤섞임) 축을 주입받은
  // `judgeDispatchCorrelation` 출력에 위임한 결과 사유(아래 "좌석 생애 축"
  // 헤더 절 참조). "결손"(CORRELATION_INVALID)과 "위임 판정이 PROVEN이
  // 아님"(CORRELATION_NOT_PROVEN)을 같은 사유로 접지 않는다.
  CORRELATION_INVALID: "CORRELATION_INVALID",
  CORRELATION_NOT_PROVEN: "CORRELATION_NOT_PROVEN",
  // §11 재작업 2R 신규 -- "이번 소비 회차"를 호출자가 명시적으로 밝힌
  // `expectedRequeryRound`와 대조한 결과 사유. 기존 REQUERY_ROUND_MISMATCH
  // (두 capture가 서로 다름)와는 별개 축이다 -- 접지 않는다.
  EXPECTED_REQUERY_ROUND_INVALID: "EXPECTED_REQUERY_ROUND_INVALID",
  EXPECTED_REQUERY_ROUND_MISMATCH: "EXPECTED_REQUERY_ROUND_MISMATCH",
  REQUERY_JOINED: "REQUERY_JOINED",
});

// 재선언(re-export 아님) -- seat-proof-contract-v1.mjs의 `SEAT_PROOF`와
// 값이 동일해야 한다(위 헤더 "어휘 처리" 1번 참조). 이 코어는
// `judgeDispatchBoundSeatProof`를 재구현하지 않으므로 판정 로직은 없고,
// 주입된 출력의 `verdict` 필드를 이 두 리터럴과만 대조한다.
const SEAT_PROOF_VERDICT_PROVEN = "PROVEN";
const SEAT_PROOF_VERDICT_UNPROVEN = "UNPROVEN";

// 재선언(re-export 아님, §10 재작업 1R 신규) -- dispatch-correlation-
// core.mjs의 `CORRELATION`과 값이 동일해야 한다. `seatProof`와 똑같은
// 주입 방식(import 금지, eslint no-restricted-imports 경계 -- 위 헤더
// "어휘 처리" 1번과 같은 이유). 이 코어는 `judgeDispatchCorrelation`을
// 재구현하지 않으므로 판정 로직은 없고, 주입된 출력의 `verdict` 필드를
// 이 세 리터럴과만 대조한다.
const CORRELATION_VERDICT_PROVEN = "PROVEN";
const CORRELATION_VERDICT_UNPROVEN = "UNPROVEN";
const CORRELATION_VERDICT_MISMATCH = "MISMATCH";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isPositiveInteger(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function notJoined(
  reasonCode,
  seatProofReason = null,
  correlationReason = null,
) {
  return {
    ok: true,
    verdict: REQUERY_JOIN_VERDICT.NOT_JOINED,
    reasonCode,
    seatProofReason,
    correlationReason,
  };
}

function invalidArguments() {
  return {
    ok: false,
    verdict: REQUERY_JOIN_VERDICT.NOT_JOINED,
    reasonCode: REQUERY_JOIN_REASON.INVALID_ARGUMENTS,
    seatProofReason: null,
    correlationReason: null,
  };
}

// terminal.normalized는 normalizeTerminalShow(ok:true)의 출력이어야 한다
// -- 이 코어가 실제로 읽는 것은 paneKeyFromShow(중복 pane 대조 대상) 뿐.
function hasValidNormalizedTerminal(normalized) {
  return normalized.ok === true && isNonEmptyString(normalized.paneKeyFromShow);
}

// dispatch.normalized는 normalizeDispatchShow(ok:true)의 출력이어야 한다.
function hasValidNormalizedDispatch(normalized) {
  return normalized.ok === true && isNonEmptyString(normalized.assigneePaneKey);
}

// 채취 정보의 구조적 완전성(queryId/requeryRound)만 확인한다. source
// 값의 정오는 별도 단계(§ SOURCE_MISMATCH)에서 확인한다 -- "결손"과
// "값이 틀림"을 같은 사유코드로 접지 않기 위해서다.
function hasCompleteCaptureFields(capture) {
  return (
    isNonEmptyString(capture.queryId) &&
    isPositiveInteger(capture.requeryRound) &&
    isNonEmptyString(capture.source)
  );
}

// seatProof는 judgeDispatchBoundSeatProof({...})의 출력을 그대로 주입받은
// 것으로 신뢰한다 -- 이 함수는 그 판정을 다시 계산하지 않고, 반환된
// verdict/reasonCode 필드를 읽기만 한다(재구현 금지, coder-task.md §2-2).
function readSeatProofResult(seatProof) {
  if (!isPlainObject(seatProof)) return null;
  const { verdict, reasonCode } = seatProof;
  if (
    verdict !== SEAT_PROOF_VERDICT_PROVEN &&
    verdict !== SEAT_PROOF_VERDICT_UNPROVEN
  ) {
    return null;
  }
  return {
    verdict,
    // §2-10 -- 원래 사유를 접지 마라: 값이 무엇이든(빈 문자열 포함) 있는
    // 그대로 보존한다. 결손(non-string)만 null로 명시한다.
    reasonCode: typeof reasonCode === "string" ? reasonCode : null,
  };
}

// correlation은 judgeDispatchCorrelation({...})의 출력을 그대로 주입받은
// 것으로 신뢰한다(§10 재작업 1R 신규) -- 이 함수는 그 판정을 다시
// 계산하지 않고, 반환된 verdict/reason 필드를 읽기만 한다(재구현 금지,
// coder-task.md §10-1). 필드명이 `reason`(seatProof의 `reasonCode`와
// 다름)인 것은 dispatch-correlation-core.mjs 자신의 어휘를 그대로
// 따른 것이다(재선언·재작명 금지 -- 원본 계약 그대로).
function readCorrelationResult(correlation) {
  if (!isPlainObject(correlation)) return null;
  const { verdict, reason } = correlation;
  if (
    verdict !== CORRELATION_VERDICT_PROVEN &&
    verdict !== CORRELATION_VERDICT_UNPROVEN &&
    verdict !== CORRELATION_VERDICT_MISMATCH
  ) {
    return null;
  }
  return {
    verdict,
    // §2-10 -- 원래 사유를 접지 마라(seatProofReason과 같은 원칙).
    reason: typeof reason === "string" ? reason : null,
  };
}

// §2 비타협 #6(복잡도 상한, HYK-148 Tier1 eslint complexity<=12)을 지키기
// 위해 구조적 전제조건 검사를 이 함수로 분리한다 -- dispatch-bound-seat-
// proof.mjs의 hasValidDispatchShow/hasValidTerminalShow와 같은 이유의
// 분리(로직을 완화하지 않는다, 판정 우선순위만 옮긴다).
function hasWellFormedShape(terminal, dispatch) {
  return (
    isPlainObject(terminal) &&
    isPlainObject(terminal.normalized) &&
    isPlainObject(terminal.capture) &&
    isPlainObject(dispatch) &&
    isPlainObject(dispatch.normalized) &&
    isPlainObject(dispatch.capture)
  );
}

// §2-B와 같은 표 형태(dispatch-bound-seat-proof.mjs의
// buildMismatchChecks/findMismatchReason 선례 -- 그 파일의 판정 개수는
// 이 파일과 다르니 혼동하지 말 것) -- 이 파일은 판정 6개를 표로 선언해
// 분기 복잡도를 낮춘다. 순서가 판정 우선순위다(첫 실패가 그대로 결과
// 사유가 된다). 어떤 비교도 생략·완화하지 않는다.
function buildStructuralFailureChecks(
  terminal,
  dispatch,
  observedPaneKeys,
  expectedRequeryRound,
) {
  return [
    [
      !hasValidNormalizedTerminal(terminal.normalized),
      REQUERY_JOIN_REASON.TERMINAL_NORMALIZED_INVALID,
    ],
    [
      !hasValidNormalizedDispatch(dispatch.normalized),
      REQUERY_JOIN_REASON.DISPATCH_NORMALIZED_INVALID,
    ],
    [
      !hasCompleteCaptureFields(terminal.capture) ||
        !hasCompleteCaptureFields(dispatch.capture),
      REQUERY_JOIN_REASON.CAPTURE_INCOMPLETE,
    ],
    [
      terminal.capture.source !== CAPTURE_SOURCE.TERMINAL_SHOW ||
        dispatch.capture.source !== CAPTURE_SOURCE.DISPATCH_SHOW,
      REQUERY_JOIN_REASON.SOURCE_MISMATCH,
    ],
    [
      !Array.isArray(observedPaneKeys),
      REQUERY_JOIN_REASON.OBSERVED_PANE_KEYS_MISSING,
    ],
    // §11 재작업 2R 신규 -- 결손·양의 정수 아님을 "괜찮음"으로 읽지
    // 않는다(coder-task.md §11 P1-1-3).
    [
      !isPositiveInteger(expectedRequeryRound),
      REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_INVALID,
    ],
  ];
}

function findStructuralFailureReason(
  terminal,
  dispatch,
  observedPaneKeys,
  expectedRequeryRound,
) {
  for (const [failed, reasonCode] of buildStructuralFailureChecks(
    terminal,
    dispatch,
    observedPaneKeys,
    expectedRequeryRound,
  )) {
    if (failed) return reasonCode;
  }
  return null;
}

// observedPaneKeys가 배열임과 expectedRequeryRound가 양의 정수임이 이미
// 확인된 뒤에만 호출된다(위 표의 검사가 먼저 통과해야 도달).
function findIndependenceFailureReason(
  terminal,
  dispatch,
  observedPaneKeys,
  expectedRequeryRound,
) {
  const targetPaneKey = terminal.normalized.paneKeyFromShow;
  const duplicateCount = observedPaneKeys.filter(
    (k) => k === targetPaneKey,
  ).length;
  if (duplicateCount > 1) return REQUERY_JOIN_REASON.DUPLICATE_PANE;
  if (terminal.capture.queryId === dispatch.capture.queryId) {
    return REQUERY_JOIN_REASON.SAME_QUERY_SHARED;
  }
  if (terminal.capture.requeryRound !== dispatch.capture.requeryRound) {
    return REQUERY_JOIN_REASON.REQUERY_ROUND_MISMATCH;
  }
  // §11 재작업 2R 신규 -- 두 capture가 서로 일치해도(위 검사 통과)
  // "이번 소비 회차"인지는 별개 축이다(coder-task.md §11 P1-1-2/4).
  // 둘 다 일치해야 하지만 위에서 이미 서로 같음이 확인됐으므로 한쪽만
  // 비교해도 동치다 -- 그래도 "둘 다 일치"라는 요건을 코드로도 명시하기
  // 위해 양쪽을 그대로 비교한다(가독성 우선, 판정 결과는 동일).
  if (
    terminal.capture.requeryRound !== expectedRequeryRound ||
    dispatch.capture.requeryRound !== expectedRequeryRound
  ) {
    return REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_MISMATCH;
  }
  return null;
}

// seatProof(PROVEN)까지 확인된 뒤에만 호출된다. correlation은
// judgeDispatchCorrelation(...)의 출력을 그대로 주입받아 좌석 생애(종료
// 전후 뒤섞임) 축을 위임 판정한다(§10 재작업 1R). 결손·형태 오류는
// CORRELATION_INVALID로 fail-closed, PROVEN이 아니면(UNPROVEN/MISMATCH
// 둘 다) CORRELATION_NOT_PROVEN + 원래 `reason` 보존.
function findCorrelationFailure(correlation) {
  const correlationResult = readCorrelationResult(correlation);
  if (correlationResult === null) {
    return {
      failed: true,
      reasonCode: REQUERY_JOIN_REASON.CORRELATION_INVALID,
      reason: null,
    };
  }
  if (correlationResult.verdict !== CORRELATION_VERDICT_PROVEN) {
    return {
      failed: true,
      reasonCode: REQUERY_JOIN_REASON.CORRELATION_NOT_PROVEN,
      reason: correlationResult.reason,
    };
  }
  return { failed: false, reason: correlationResult.reason };
}

// judgeIndependentRequeryJoin({ terminal, dispatch, seatProof, correlation,
// observedPaneKeys, expectedRequeryRound }) -> { ok, verdict, reasonCode,
// seatProofReason, correlationReason }
//
// - `terminal` = { normalized, capture } -- normalized는
//   normalizeTerminalShow(ok:true)의 출력, capture는 위 "채취 정보".
// - `dispatch` = { normalized, capture } -- normalized는
//   normalizeDispatchShow(ok:true)의 출력, capture는 위 "채취 정보".
// - `seatProof` = judgeDispatchBoundSeatProof(...)의 출력을 그대로 주입.
// - `correlation` = judgeDispatchCorrelation(...)의 출력을 그대로 주입
//   (§10 재작업 1R 신규 -- 좌석 생애 축 위임).
// - `observedPaneKeys` = 중복 pane 검출용 문자열 배열. 배열이 아니면
//   "검사 못 함"이므로 fail-closed(OBSERVED_PANE_KEYS_MISSING).
// - `expectedRequeryRound` = 호출자가 명시한 "이번 소비 회차" 번호(1 이상
//   정수, §11 재작업 2R 신규 필수 입력). 양쪽 capture의 `requeryRound`가
//   둘 다 이 값과 일치해야 통과 -- 결손이면 fail-closed
//   (EXPECTED_REQUERY_ROUND_INVALID).
//
// 판정 순서(우선순위 = 첫 실패가 그대로 결과): 인자 구조 -> 정규화 유효성
// -> 채취 정보 완전성 -> source 정합 -> observedPaneKeys 존재 ->
// expectedRequeryRound 유효성 -> 중복 pane -> 같은 조회 공유 -> 회차 불일치
// (상호) -> 회차 불일치(기대값 대비) -> 좌석 증명 -> 좌석 생애(correlation).
// 좌석 증명·좌석 생애를 마지막에 두는 이유는 그 판정들이 이미 다른
// 함수(judgeDispatchBoundSeatProof/judgeDispatchCorrelation)의 몫이라 이
// 코어 자신의 구조적 전제조건(정규화·채취정보·회차)이 먼저 온전해야
// "독립 재조회"라는 이 코어 고유의 주장을 결정할 수 있기 때문이다.
export function judgeIndependentRequeryJoin(args) {
  if (!isPlainObject(args)) return invalidArguments();
  const {
    terminal,
    dispatch,
    seatProof,
    correlation,
    observedPaneKeys,
    expectedRequeryRound,
  } = args;

  if (!hasWellFormedShape(terminal, dispatch)) return invalidArguments();

  const structuralReason = findStructuralFailureReason(
    terminal,
    dispatch,
    observedPaneKeys,
    expectedRequeryRound,
  );
  if (structuralReason !== null) {
    return notJoined(structuralReason);
  }

  const independenceReason = findIndependenceFailureReason(
    terminal,
    dispatch,
    observedPaneKeys,
    expectedRequeryRound,
  );
  if (independenceReason !== null) {
    return notJoined(independenceReason);
  }

  const seatProofResult = readSeatProofResult(seatProof);
  if (seatProofResult === null) {
    return notJoined(REQUERY_JOIN_REASON.SEAT_PROOF_INVALID);
  }
  if (seatProofResult.verdict !== SEAT_PROOF_VERDICT_PROVEN) {
    return notJoined(
      REQUERY_JOIN_REASON.SEAT_PROOF_UNPROVEN,
      seatProofResult.reasonCode,
    );
  }

  const correlationFailure = findCorrelationFailure(correlation);
  if (correlationFailure.failed) {
    return notJoined(
      correlationFailure.reasonCode,
      seatProofResult.reasonCode,
      correlationFailure.reason,
    );
  }

  return {
    ok: true,
    verdict: REQUERY_JOIN_VERDICT.JOINED,
    reasonCode: REQUERY_JOIN_REASON.REQUERY_JOINED,
    seatProofReason: seatProofResult.reasonCode,
    correlationReason: correlationFailure.reason,
  };
}
