// HYK-186 2R §4 -- 신뢰 경계 (B)(사람·통역 라우팅·감사용 구조화 시각:
// 받는함 파일명·헤더) 판정 코어. (A)(relay-handshake.mjs가 읽는
// dropped_at/>>> DONE)와 ⛔같은 "차단" 완료조건을 적용하지 않는다(이슈
// 원문 명시) -- 이 코어는 절대 exit을 비0으로 만들거나 릴레이를 멈추지
// 않는다. 산출은 오직 "감사 판정 + 사람이 읽는 사유"뿐이다. 판정 자체는
// 순수 함수(관측은 호출자가 준다, header-time-projection-core.mjs와 같은
// "코어는 순수, 수집은 wire" 원칙 재사용) -- 이 파일에 fs/git import가
// 없다.
//
// ★mtime 함정(이슈가 실측해 둔 반례 2건, coder-task.md §4-3):
//   - `0104` 파일: 본문 01:04, 실제 CreationTime 01:58:35 (55분 오기) --
//     본문이 틀린 진짜 사례. creationTime이 header와 크게 벌어지면
//     MISMATCH다.
//   - `0303` 파일: 본문 03:03, CreationTime 03:03:57(정상)인데
//     LastWriteTime만 26분 늦다(처리됨\ 폴더로 이동) -- 본문은 정상.
//     creationTime이 header와 가까우면, LastWriteTime이 아무리 벌어져도
//     NORMAL이어야 한다.
// ⇒ 판정식은 항상 headerTime vs creationTime(1차 증거, 필요하면 filename
// 시각으로 대체 가능한 2차 증거)만 비교한다. lastWriteTime/mtime은 details
// 에 참고용으로만 실리고, verdict 계산에는 어떤 경로로도 들어가지 않는다
// (mtime 단독 판정 금지 -- coder-task.md §4-2 ②).

export const INBOX_AUDIT_VERDICT = Object.freeze({
  NORMAL: "NORMAL",
  MISMATCH: "MISMATCH",
  UNDECIDABLE: "UNDECIDABLE",
});

export const INBOX_AUDIT_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  HEADER_TIME_MS_INVALID: "HEADER_TIME_MS_INVALID",
  NO_CORROBORATING_EVIDENCE: "NO_CORROBORATING_EVIDENCE",
  HEADER_CREATION_AGREE: "HEADER_CREATION_AGREE",
  HEADER_CREATION_DISAGREE: "HEADER_CREATION_DISAGREE",
  HEADER_FILENAME_AGREE: "HEADER_FILENAME_AGREE",
  HEADER_FILENAME_DISAGREE: "HEADER_FILENAME_DISAGREE",
});

// 2분: 본문 헤더가 초 단위를 안 적는 경우가 흔하고(예: "01:04"), creation
// 시각은 초 단위까지 있다(01:58:35) -- 반올림/버림 손실을 정상으로 흡수하는
// 폭. §1의 것(±0)과 달리 이건 "무해한 손실"을 위한 관용폭이지 skew 허용이
// 아니다(§1의 MAX_FUTURE_SKEW_MS와는 목적이 다르므로 상수를 공유하지
// 않는다 -- 신뢰 경계 (A)/(B)를 같은 상수로 묶으면 §3의 "둘에 같은 기준을
// 적용하지 마라"를 코드 차원에서 어기게 된다).
export const DEFAULT_TOLERANCE_MS = 2 * 60 * 1000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteMs(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function withinTolerance(a, b, toleranceMs) {
  return Math.abs(a - b) <= toleranceMs;
}

function undecidable(reasonCode, details = null) {
  return {
    ok: true,
    verdict: INBOX_AUDIT_VERDICT.UNDECIDABLE,
    reasonCode,
    details,
  };
}

// judgeInboxTimeAudit({headerTimeMs, creationTimeMs, lastWriteTimeMs,
//   filenameTimeMs, toleranceMs}) -> {ok, verdict, reasonCode, details}
//
// - `headerTimeMs`: 파일 본문이 스스로 주장하는 시각(필수).
// - `creationTimeMs`: 실제 파일 CreationTime(1차 증거, 있으면 이것만 본다).
// - `filenameTimeMs`: 파일명이 인코딩하는 시각(2차 증거 -- creationTimeMs가
//   없거나 신뢰 불가(UNDECIDABLE 취급 대상)일 때만 대신 쓴다).
// - `lastWriteTimeMs`: mtime류. **verdict 계산에 절대 들어가지 않는다** --
//   details에만 참고 델타로 실린다.
// - `toleranceMs`: 기본 DEFAULT_TOLERANCE_MS.
export function judgeInboxTimeAudit(args) {
  if (!isPlainObject(args)) {
    return undecidable(INBOX_AUDIT_REASON.ARGS_INVALID);
  }
  const {
    headerTimeMs,
    creationTimeMs,
    lastWriteTimeMs,
    filenameTimeMs,
    toleranceMs = DEFAULT_TOLERANCE_MS,
  } = args;

  if (!isFiniteMs(headerTimeMs)) {
    return undecidable(INBOX_AUDIT_REASON.HEADER_TIME_MS_INVALID);
  }

  const lastWriteDeltaMs = isFiniteMs(lastWriteTimeMs)
    ? lastWriteTimeMs - headerTimeMs
    : null;

  if (isFiniteMs(creationTimeMs)) {
    const agree = withinTolerance(headerTimeMs, creationTimeMs, toleranceMs);
    return {
      ok: true,
      verdict: agree
        ? INBOX_AUDIT_VERDICT.NORMAL
        : INBOX_AUDIT_VERDICT.MISMATCH,
      reasonCode: agree
        ? INBOX_AUDIT_REASON.HEADER_CREATION_AGREE
        : INBOX_AUDIT_REASON.HEADER_CREATION_DISAGREE,
      details: {
        evidence: "creationTime",
        headerTimeMs,
        creationTimeMs,
        deltaMs: creationTimeMs - headerTimeMs,
        lastWriteDeltaMs,
      },
    };
  }

  // creationTime이 없다(혹은 신뢰 불가로 호출자가 건너뛰었다) -- 2차 증거인
  // filename 시각으로만 판정한다. lastWriteTime은 여기서도 여전히 verdict에
  // 안 쓴다(mtime 단독 판정 금지는 1차/2차 증거 모두 없을 때의 fallback
  // 경로에도 예외 없이 적용된다).
  if (isFiniteMs(filenameTimeMs)) {
    const agree = withinTolerance(headerTimeMs, filenameTimeMs, toleranceMs);
    return {
      ok: true,
      verdict: agree
        ? INBOX_AUDIT_VERDICT.NORMAL
        : INBOX_AUDIT_VERDICT.MISMATCH,
      reasonCode: agree
        ? INBOX_AUDIT_REASON.HEADER_FILENAME_AGREE
        : INBOX_AUDIT_REASON.HEADER_FILENAME_DISAGREE,
      details: {
        evidence: "filenameTime",
        headerTimeMs,
        filenameTimeMs,
        deltaMs: filenameTimeMs - headerTimeMs,
        lastWriteDeltaMs,
      },
    };
  }

  // 1차·2차 증거 둘 다 없다 -- mtime만 있어도 그것만으로 판정하지 않는다
  // (요구사항의 핵심 비타협). 판정 불가로 fail-closed.
  return undecidable(INBOX_AUDIT_REASON.NO_CORROBORATING_EVIDENCE, {
    lastWriteDeltaMs,
  });
}

// ---------------------------------------------------------------------------
// finalization 후 변경 정책 (coder-task.md §4-2 ④) -- ★무효화(INVALIDATED)를
// 선택했다: (B)는 감사 기록이다. 본문이 바뀐 뒤 조용히 새 시각으로
// 재finalize하면 "언제 바뀌었는지"가 감사 흔적에서 사라진다 -- 감사의
// 목적 자체(변경을 드러내는 것)를 재finalize가 지워버린다. 그래서 이
// 판정은 "다시 감사가 필요하다"는 사실만 반환하고, 새 시각을 스스로
// 만들어내지 않는다(그 결정은 호출자가 §1의 machine-clock 원칙을 따라
// 별도로 한다).
// ---------------------------------------------------------------------------
export const AUDIT_VALIDITY = Object.freeze({
  VALID: "VALID",
  INVALIDATED: "INVALIDATED",
});

export function judgeAuditValidityAfterChange(args) {
  if (!isPlainObject(args)) {
    return { ok: false, reason: "judgeAuditValidityAfterChange: args must be an object" };
  }
  const { auditedAtMs, contentChangedAtMs } = args;
  if (!isFiniteMs(auditedAtMs) || !isFiniteMs(contentChangedAtMs)) {
    return {
      ok: false,
      reason:
        "judgeAuditValidityAfterChange: auditedAtMs/contentChangedAtMs must both be finite numbers",
    };
  }
  const invalidated = contentChangedAtMs > auditedAtMs;
  return {
    ok: true,
    validity: invalidated
      ? AUDIT_VALIDITY.INVALIDATED
      : AUDIT_VALIDITY.VALID,
    reason: invalidated
      ? `content changed at ${contentChangedAtMs} after audit stamp ${auditedAtMs} -- prior audit result is invalidated, re-audit required (not silently re-stamped)`
      : `content unchanged since audit stamp ${auditedAtMs} -- prior audit result still valid`,
  };
}

// ---------------------------------------------------------------------------
// 동일 분 파일명 충돌 정책 (coder-task.md §4-2 ⑤) -- ★유일성 판정은
// "분(minute) 단위 파일명"이 아니라 "파일 자신"이다. 이 함수는 절대
// 병합/대표선정을 하지 않는다 -- 같은 분에 파일이 둘이면 그룹 안에 둘 다
// 남는다. (B)가 감사용이라는 성격상, 하나를 "대표"로 골라 나머지를
// 버리면 그 버려진 파일의 감사 결과가 영영 사라진다 -- 이 정책이 막는
// 것은 정확히 그 소실이다.
// ---------------------------------------------------------------------------
export function groupByFilenameMinute(entries) {
  if (!Array.isArray(entries)) return new Map();
  const groups = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.minuteKey !== "string") {
      continue;
    }
    const bucket = groups.get(entry.minuteKey) ?? [];
    bucket.push(entry);
    groups.set(entry.minuteKey, bucket);
  }
  return groups;
}
