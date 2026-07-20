// HYK-163 사이클3 1단 (합성만, pm-3 §3.2/§3.3/§3.4/§4): 실 Orca 관측(2A/2B, 사람
// 북극성 게이트 뒤)이 나중에 채울 **receipt 스키마**와 그것을 소비하는 판정
// 로직만 지금 정의한다. 실 Orca 접촉 0 -- 이 파일의 모든 함수는 합성/fixture
// receipt 객체만 받는 순수 함수다.
//
// 이 파일이 만드는 것은 딱 셋:
//   1) validateReceiptShape/judgeReceipt -- receipt의 구조적 완전성 판정
//      (필수 필드 단일 결손/변조 시 전건 UNVERIFIED, positive_control 실패 시
//      FAIL, 전부 통과해야 PASS). "이 receipt를 신뢰할 수 있는가"만 본다 --
//      hook_result 자체의 값(HIT/MISS/UNJUDGABLE)은 그 값이 유효한 enum인지만
//      확인하고 판정에 가중치를 두지 않는다(비권위).
//   2) judgeLivenessFromReceipt (G6 fail-closed consumer) -- pm-3 §3.3의 6개
//      조건을 전부 만족해야만 observed.liveness=true로 변환한다. 이 중 하나라도
//      결손/불일치면 항상 false(unknown 취급). connected/writable/title/
//      preview/lastOutputAt/heartbeat/terminal fingerprint는 이 함수가 아예
//      읽지 않는다(단독 권위 금지, pm-2/pm-3 공통 원칙 재적용).
//   3) judgePayloadFromReceipt (G9 exact payload consumer) -- 캡처된 payload가
//      byte-complete하고 expected spec과 정확히 일치할 때만 PASS. preamble/
//      extra text/newline 등 추가 내용이 있으면(무해해도) FAIL. 캡처가
//      불완전하면 PASS도 FAIL도 아닌 UNVERIFIED.
//
// **live enable 스위치 없음** -- 이 파일 어디에도 "이 판정이 통과하면 live를
// true로 바꾼다"는 코드가 없다(그런 스위치 자체를 두지 않는 것이 계약, pm-3
// §4 "관측 결과의 계약 반영" 행 + coder-task 하드 제약).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export const HOOK_RESULT = Object.freeze({
  HIT: "HIT",
  MISS: "MISS",
  UNJUDGABLE: "UNJUDGABLE",
});
const HOOK_RESULT_VALUES = new Set(Object.values(HOOK_RESULT));

export const RECEIPT_VERDICT = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  UNVERIFIED: "UNVERIFIED",
});

export const PAYLOAD_VERDICT = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  UNVERIFIED: "UNVERIFIED",
});

// receipt 공통 필수 필드(pm-3 §4 "관측 receipt schema" 행 + coder-task 목록
// 그대로): canary/상관 ID·target(handle/worktree/agent_instance)·raw hash·
// byte length·Orca version·수집시각·명령 exit code·positive-control·hook 결과.
export const RECEIPT_REQUIRED_FIELDS = Object.freeze([
  "canary_id",
  "target",
  "raw_sha256",
  "byte_length",
  "orca_version",
  "collected_at",
  "exit_code",
  "positive_control",
  "hook_result",
]);

function targetProblem(t) {
  if (
    !isPlainObject(t) ||
    !isNonEmptyString(t.handle) ||
    !isNonEmptyString(t.worktree) ||
    !isNonEmptyString(t.agent_instance)
  ) {
    return "target must be {handle, worktree, agent_instance} non-empty strings";
  }
  return null;
}

// 검증을 두 그룹(식별/대상류·수집메타류)으로 나눠 각 헬퍼의 복잡도를 낮춘다
// (validateReceiptShape 자체는 오케스트레이션만 -- quality-check 래칫).
function collectIdentityProblems(receipt) {
  const problems = [];
  if (!isNonEmptyString(receipt.canary_id)) problems.push("canary_id");
  const tProblem = targetProblem(receipt.target);
  if (tProblem) problems.push(`target (${tProblem})`);
  if (
    !isNonEmptyString(receipt.raw_sha256) ||
    !/^[0-9a-f]{64}$/i.test(receipt.raw_sha256)
  ) {
    problems.push("raw_sha256");
  }
  if (!Number.isSafeInteger(receipt.byte_length) || receipt.byte_length < 0) {
    problems.push("byte_length");
  }
  return problems;
}

function collectCollectionMetaProblems(receipt) {
  const problems = [];
  if (!isNonEmptyString(receipt.orca_version)) problems.push("orca_version");
  if (
    !isNonEmptyString(receipt.collected_at) ||
    Number.isNaN(Date.parse(receipt.collected_at))
  ) {
    problems.push("collected_at");
  }
  if (!Number.isSafeInteger(receipt.exit_code)) problems.push("exit_code");
  if (typeof receipt.positive_control !== "boolean")
    problems.push("positive_control");
  if (!HOOK_RESULT_VALUES.has(receipt.hook_result))
    problems.push("hook_result");
  return problems;
}

// validateReceiptShape: 구조적 완전성만 검사(순수, I/O 0). 각 필드 개별
// 결손/오타입을 독립적으로 잡아 어느 필드가 문제인지 reason에 남긴다.
export function validateReceiptShape(receipt) {
  if (!isPlainObject(receipt)) {
    return { ok: false, reason: "receipt is not a plain object" };
  }
  const problems = [
    ...collectIdentityProblems(receipt),
    ...collectCollectionMetaProblems(receipt),
  ];
  if (problems.length > 0) {
    return {
      ok: false,
      reason: `receipt missing/malformed field(s): ${problems.join(", ")}`,
    };
  }
  return { ok: true };
}

// judgeReceipt: receipt 자체가 "쓸 만한 증거인가"만 판정한다. hook_result의
// 구체적 값(HIT/MISS/UNJUDGABLE)은 유효 enum인지만 보고, 그 값 자체로 PASS/
// FAIL을 가르지 않는다(비권위 -- hook_result를 HIT<->MISS로 뒤집어도 이
// 함수의 반환은 바뀌지 않아야 한다, 아래 테스트로 실증).
export function judgeReceipt(receipt) {
  const shape = validateReceiptShape(receipt);
  if (!shape.ok) {
    return {
      verdict: RECEIPT_VERDICT.UNVERIFIED,
      reason: `INVALID_RECEIPT: ${shape.reason}`,
    };
  }
  if (receipt.positive_control !== true) {
    return {
      verdict: RECEIPT_VERDICT.FAIL,
      reason:
        "positive_control did not pass -- hook logger armed-check failed, downstream hook_result is not trustworthy",
    };
  }
  return { verdict: RECEIPT_VERDICT.PASS, reason: null };
}

// ---- G6 fail-closed consumer (pm-3 §3.3) ----
// receipt에 G6 전용 필드(liveness_signal·observed_target·lifecycle_distinguished)가
// 실려온다고 가정한다 -- 이건 공통 RECEIPT_REQUIRED_FIELDS엔 없다(G6를 쓰는
// 관측만 필요하므로 이 함수 안에서 독립적으로 검사한다). 여섯 조건(pm-3
// §3.3) 중 하나라도 실패하면 무조건 liveness:false(unknown 취급, 재탐색 없음).
function checkG6ExtraFields(receipt) {
  if (typeof receipt.liveness_signal !== "boolean") {
    return "liveness_signal missing/not-boolean (null/unknown 취급 -- fail-closed)";
  }
  const tProblem = targetProblem(receipt.observed_target);
  if (tProblem) return `observed_target (${tProblem})`;
  if (typeof receipt.lifecycle_distinguished !== "boolean") {
    return "lifecycle_distinguished missing -- live/dead 또는 restart 전후 대조 증거 없음";
  }
  return null;
}

function targetsMatch(a, b) {
  return (
    a.handle === b.handle &&
    a.worktree === b.worktree &&
    a.agent_instance === b.agent_instance
  );
}

// pm-3 §3.3의 6개 조건을 독립 헬퍼로 분리한다(judgeLivenessFromReceipt 자체의
// 복잡도를 낮추기 위함 -- quality-check complexity 래칫). 각 헬퍼는 통과 시
// null, 실패 시 `{liveness:false, reason}`을 반환하는 동일 계약을 따른다.
function checkExpectedTargetShape(expectedTarget) {
  if (!isPlainObject(expectedTarget) || targetProblem(expectedTarget)) {
    return { liveness: false, reason: "expectedTarget missing/malformed" };
  }
  return null;
}

// 2) exact agent instance ID + terminal/worktree identity가 signed tuple과 결속.
function checkObservedTargetMatch(receipt, expectedTarget) {
  if (!targetsMatch(receipt.observed_target, expectedTarget)) {
    return {
      liveness: false,
      reason: `observed_target ${JSON.stringify(receipt.observed_target)} != signed expected ${JSON.stringify(expectedTarget)}`,
    };
  }
  return null;
}

// 3)+4) "지금 --inject 가능한 살아있는 instance"라는 의미 + live/dead 대조.
function checkLivenessAndLifecycle(receipt) {
  if (receipt.liveness_signal !== true) {
    return {
      liveness: false,
      reason: `liveness_signal=${JSON.stringify(receipt.liveness_signal)} (only exact true accepted)`,
    };
  }
  if (receipt.lifecycle_distinguished !== true) {
    return {
      liveness: false,
      reason: "no live/dead or restart-before/after contrast evidence",
    };
  }
  return null;
}

// 5) 관측시각/freshness -- null/누락/parse 실패/stale은 DENY.
function checkFreshness(receipt, nowMs, maxAgeMs) {
  const collectedMs = Date.parse(receipt.collected_at);
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 0 ||
    Number.isNaN(collectedMs)
  ) {
    return {
      liveness: false,
      reason: "nowMs/maxAgeMs/collected_at invalid for freshness check",
    };
  }
  if (nowMs < collectedMs || nowMs - collectedMs > maxAgeMs) {
    return {
      liveness: false,
      reason: `stale snapshot (age ${nowMs - collectedMs}ms > window ${maxAgeMs}ms)`,
    };
  }
  return null;
}

// 1) Orca read-only 원문에서 나온 값만(모델 문구/TUI 추론 아님) -- receipt
// 자체가 그 원문이라는 계약을 신뢰한다(생산자 신원 증명은 G13 영역, 이
// 소비자의 표면 밖).
export function judgeLivenessFromReceipt({
  receipt,
  expectedTarget,
  nowMs,
  maxAgeMs,
}) {
  const shape = validateReceiptShape(receipt);
  if (!shape.ok) {
    return { liveness: false, reason: `INVALID_RECEIPT: ${shape.reason}` };
  }
  const extraProblem = checkG6ExtraFields(receipt);
  if (extraProblem) return { liveness: false, reason: extraProblem };

  const denied =
    checkExpectedTargetShape(expectedTarget) ??
    checkObservedTargetMatch(receipt, expectedTarget) ??
    checkLivenessAndLifecycle(receipt) ??
    checkFreshness(receipt, nowMs, maxAgeMs);
  if (denied) return denied;

  return { liveness: true, reason: null };
}

// ---- G9 exact payload consumer (pm-3 §3.4) ----
// receipt에 G9 전용 필드(payload_complete·captured_payload)가 실려온다고
// 가정한다(RECEIPT_REQUIRED_FIELDS엔 없음, G9를 쓰는 관측만 필요).
export function judgePayloadFromReceipt({ receipt, expectedSpec }) {
  const shape = validateReceiptShape(receipt);
  if (!shape.ok) {
    return {
      verdict: PAYLOAD_VERDICT.UNVERIFIED,
      reason: `INVALID_RECEIPT: ${shape.reason}`,
    };
  }
  if (!isNonEmptyString(expectedSpec)) {
    return {
      verdict: PAYLOAD_VERDICT.UNVERIFIED,
      reason: "expectedSpec must be a non-empty string",
    };
  }
  if (receipt.payload_complete !== true) {
    return {
      verdict: PAYLOAD_VERDICT.UNVERIFIED,
      reason: `payload_complete=${JSON.stringify(receipt.payload_complete)} -- capture not proven byte-complete`,
    };
  }
  if (typeof receipt.captured_payload !== "string") {
    return {
      verdict: PAYLOAD_VERDICT.UNVERIFIED,
      reason: "captured_payload missing/not-a-string",
    };
  }
  if (receipt.captured_payload !== expectedSpec) {
    return {
      verdict: PAYLOAD_VERDICT.FAIL,
      reason: `captured payload ${JSON.stringify(receipt.captured_payload)} != exact expected ${JSON.stringify(expectedSpec)} (extra/missing content, e.g. preamble)`,
    };
  }
  return { verdict: PAYLOAD_VERDICT.PASS, reason: null };
}
