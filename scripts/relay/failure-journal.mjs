// HYK-171 사이클4b-2b-2 (coder-task.md §3) -- durable 실패 원장.
//
// observer-store.mjs/seat-registry.mjs 전례를 따르되 재사용이 아니라 별도
// store다(순수 상태 변환 + fs 조회/쓰기 주입). 이 모듈은 orca/dispatch/
// teardown/worker input 호출을 절대 하지 않는다 -- 프로덕션 호출자 0(결선
// 0, coder-task.md §1).
//
// 계약(coder-task.md §3):
// - failure fingerprint: 구성 필드를 명시(FINGERPRINT_FIELDS)하고, 필드가
//   하나라도 빠지면 fingerprint를 만들지 않는다(fail-closed).
// - requiresHumanAck: 사람 확인이 필요한 실패를 표시. ack 전에는 같은
//   fingerprint가 자동 재시도되지 않는다.
// - 같은 fingerprint 자동 재시도 0: attemptRecovery의 두 번째 호출에서
//   executeFn 실행 0이어야 한다(ack 전).
// - 기록 내용은 개수가 아니라 필드로 검증 가능해야 한다(3B #7 재발 방지) --
//   그래서 entry는 원시 필드(fields)·requiresHumanAck·ack 상태를 그대로
//   보존한다(카운터로 뭉개지 않는다).

export const SCHEMA_VERSION = 1;

// 구성 필드는 명시적이다 -- 이 목록에 없는 필드는 fingerprint에 반영되지
// 않고, 이 목록에 있는 필드가 하나라도 결손이면 fingerprint를 만들지
// 않는다(추정 금지).
export const FINGERPRINT_FIELDS = Object.freeze([
  "scope",
  "taskId",
  "dispatchId",
  "errorCode",
]);

export const ATTEMPT_REASON = Object.freeze({
  FINGERPRINT_MISSING: "FINGERPRINT_MISSING",
  EXECUTE_FN_REQUIRED: "EXECUTE_FN_REQUIRED",
  BLOCKED_PENDING_HUMAN_ACK: "BLOCKED_PENDING_HUMAN_ACK",
  EXECUTED: "EXECUTED",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export function createEmptyJournal() {
  return { schemaVersion: SCHEMA_VERSION, failures: {} };
}

// fields가 FINGERPRINT_FIELDS를 전부 non-empty string으로 갖출 때만
// fingerprint를 만든다 -- 하나라도 빠지면 ok:false(fail-closed, "만들지
// 않는다"를 문자 그대로 지킨다. 빈 문자열/undefined로 채워 넣지 않는다).
export function computeFailureFingerprint(fields) {
  const f = isPlainObject(fields) ? fields : {};
  const complete = FINGERPRINT_FIELDS.every((k) => isNonEmptyString(f[k]));
  if (!complete) {
    return { ok: false, reason: "fingerprint-fields-incomplete" };
  }
  return {
    ok: true,
    fingerprint: FINGERPRINT_FIELDS.map((k) => f[k]).join("::"),
  };
}

// recordFailure에서 분리(quality-check 복잡도 상한 준수) -- 다음 entry
// 조립만 담당하는 순수 함수.
function buildNextFailureEntry({
  fingerprint,
  fields,
  requiresHumanAck,
  observedAtMs,
  existing,
}) {
  return {
    fingerprint,
    fields: isPlainObject(fields) ? { ...fields } : (existing?.fields ?? null),
    requiresHumanAck: requiresHumanAck === true,
    ack: { status: "unacked", ackedAtMs: null },
    firstObservedAtMs: existing?.firstObservedAtMs ?? observedAtMs ?? null,
    lastObservedAtMs: observedAtMs ?? null,
    occurrences: (existing?.occurrences ?? 0) + 1,
  };
}

// 순수 append/갱신 -- fingerprint가 없으면 아무것도 기록하지 않는다
// (fail-closed). 매 기록마다 ack는 unacked로 초기화된다: 같은 실패가 다시
// 관측됐다는 것은 새 occurrence이므로, 과거 ack가 이번 occurrence의 자동
// 재시도까지 영구히 면제해 주지 않는다(재발마다 새 확인이 필요하다).
export function recordFailure(
  journal,
  { fingerprint, fields, requiresHumanAck, observedAtMs } = {},
) {
  const base = isPlainObject(journal) ? journal : createEmptyJournal();
  if (!isNonEmptyString(fingerprint)) {
    return { ok: false, journal: base, reason: "fingerprint-missing" };
  }
  const existing = base.failures?.[fingerprint];
  const entry = buildNextFailureEntry({
    fingerprint,
    fields,
    requiresHumanAck,
    observedAtMs,
    existing,
  });
  return {
    ok: true,
    journal: {
      ...base,
      schemaVersion: SCHEMA_VERSION,
      failures: { ...base.failures, [fingerprint]: entry },
    },
  };
}

// 사람의 확인 -- 존재하지 않는 fingerprint에 대한 ack는 안전하게 실패
// 반환(no-op, 원장 오염 방지).
export function ackFailure(journal, { fingerprint, ackedAtMs } = {}) {
  const base = isPlainObject(journal) ? journal : createEmptyJournal();
  const existing = base.failures?.[fingerprint];
  if (!existing) return { ok: false, journal: base, reason: "not-found" };
  const entry = {
    ...existing,
    ack: { status: "acked", ackedAtMs: ackedAtMs ?? null },
  };
  return {
    ok: true,
    journal: {
      ...base,
      failures: { ...base.failures, [fingerprint]: entry },
    },
  };
}

function isBlockedByHumanAck(entry) {
  return (
    isPlainObject(entry) &&
    entry.requiresHumanAck === true &&
    entry.ack?.status !== "acked"
  );
}

// 프로덕션 진입점: 같은 fingerprint의 실패가 requiresHumanAck로 원장에
// 남아 있고 아직 ack되지 않았으면 executeFn을 절대 호출하지 않는다(같은
// 실패 자동 재시도 0). executeFn 자체의 결과/실패 기록은 호출자가
// recordFailure로 별도로 남긴다(이 함수는 게이트만 담당 -- 실행 성공/실패
// 판정은 호출자 도메인).
export function attemptRecovery(journal, { fingerprint, executeFn } = {}) {
  const base = isPlainObject(journal) ? journal : createEmptyJournal();
  if (!isNonEmptyString(fingerprint)) {
    return {
      journal: base,
      executed: false,
      reason: ATTEMPT_REASON.FINGERPRINT_MISSING,
    };
  }
  if (typeof executeFn !== "function") {
    return {
      journal: base,
      executed: false,
      reason: ATTEMPT_REASON.EXECUTE_FN_REQUIRED,
    };
  }
  const existing = base.failures?.[fingerprint];
  if (isBlockedByHumanAck(existing)) {
    return {
      journal: base,
      executed: false,
      reason: ATTEMPT_REASON.BLOCKED_PENDING_HUMAN_ACK,
    };
  }
  executeFn();
  return { journal: base, executed: true, reason: ATTEMPT_REASON.EXECUTED };
}

// ---- fs 결속(observer-store.mjs/seat-registry.mjs 전례 계승) ----
// 손상(JSON.parse 실패)·스키마 불일치는 항상 ok:false -- 이 경우 호출자는
// 이번 tick에서 어떤 기록/ack/재시도 판단도 진행하지 않는다(fail-closed).
// 파일 부재는 손상이 아니라 "첫 실행"이므로 빈 journal로 정상 취급한다.
export function parseJournalText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "corrupt-json" };
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (!isPlainObject(parsed.failures)) {
    return { ok: false, reason: "schema-mismatch" };
  }
  return { ok: true, journal: parsed };
}

// opts: { existsFn, readFn } -- 둘 다 (path) => value 형태.
export function loadJournal(path, opts = {}) {
  const { existsFn, readFn } = opts;
  if (typeof existsFn !== "function" || typeof readFn !== "function") {
    return { ok: false, reason: "loadJournal: existsFn/readFn required" };
  }
  if (!existsFn(path)) {
    return { ok: true, journal: createEmptyJournal(), rawText: null };
  }
  let text;
  try {
    text = readFn(path);
  } catch (err) {
    return { ok: false, reason: `loadJournal: read threw (${err?.message})` };
  }
  const parsed = parseJournalText(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, journal: parsed.journal, rawText: text };
}

// opts: { writeFn, renameFn } -- tmp write + rename로 원자성 근사(둘 다 주입).
export function saveJournal(path, journal, opts = {}) {
  const { writeFn, renameFn } = opts;
  if (typeof writeFn !== "function" || typeof renameFn !== "function") {
    return { ok: false, reason: "saveJournal: writeFn/renameFn required" };
  }
  const tmpPath = `${path}.tmp`;
  const text = JSON.stringify(
    isPlainObject(journal) ? journal : createEmptyJournal(),
    null,
    2,
  );
  try {
    writeFn(tmpPath, text);
    renameFn(tmpPath, path);
  } catch (err) {
    return { ok: false, reason: `saveJournal: write threw (${err?.message})` };
  }
  return { ok: true, rawText: text };
}
