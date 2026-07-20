// HYK-163 사이클 2 (C2-3/G6): liveness·stale target 판정층 — 판정 로직만.
//
// pm-2 §3.3 판정: "현재 증거에는 결정적 runtime liveness 수단이 없다." 이 모듈은
// 그 결정 로직(fail-closed 계약)만 구현한다 — 실 Orca 필드 배선은 0(사이클3
// read-only 관측 몫). 이 판정기가 PASS해도 "signed target이 지금 실제로 Orca가
// inject 가능한 살아있는 agent instance인가"를 증명하지 않는다(honesty, pm-2 §9).
//
// 권위 필드(allow를 좌우): observed.liveness===true(정확히 boolean true만) ·
// handle/fingerprint/worktree/agent_instance exact 일치 · snapshot 관측시각이
// freshness window 안.
// 보조 필드(allow 권위 아님, 기록만): connected/writable/title/preview/
// lastOutputAt/heartbeat — pm-2 §3.3 "이 필드만으로 G6 완료 주장 금지"를 코드로
// 강제하기 위해 judgeLiveness는 이 필드들을 아예 읽지 않는다(입력에 있어도 무시).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export const LIVENESS_REASON = Object.freeze({
  INPUT_INVALID: "INPUT_INVALID",
  SNAPSHOT_TIMESTAMP_INVALID: "SNAPSHOT_TIMESTAMP_INVALID",
  SNAPSHOT_STALE: "SNAPSHOT_STALE",
  LIVENESS_NOT_ALIVE: "LIVENESS_NOT_ALIVE",
  HANDLE_MISMATCH: "HANDLE_MISMATCH",
  FINGERPRINT_MISMATCH: "FINGERPRINT_MISMATCH",
  WORKTREE_MISMATCH: "WORKTREE_MISMATCH",
  AGENT_INSTANCE_MISMATCH: "AGENT_INSTANCE_MISMATCH",
  ALLOW: "ALLOW",
});

function deny(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

function checkInputShape(signedTarget, expectedWorktree, observed) {
  if (
    !isNonEmptyString(signedTarget.handle) ||
    !isNonEmptyString(signedTarget.fingerprint) ||
    !isNonEmptyString(signedTarget.agent_instance)
  ) {
    return deny(
      LIVENESS_REASON.INPUT_INVALID,
      "signedTarget must have non-empty handle/fingerprint/agent_instance",
    );
  }
  if (!isNonEmptyString(expectedWorktree)) {
    return deny(
      LIVENESS_REASON.INPUT_INVALID,
      "expectedWorktree must be a non-empty string",
    );
  }
  if (!isPlainObject(observed)) {
    return deny(
      LIVENESS_REASON.INPUT_INVALID,
      "observed must be a plain object",
    );
  }
  return null;
}

function toEpochMs(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v);
  return NaN;
}

function checkSnapshotFreshness(observed, nowMs, maxSnapshotAgeMs) {
  const snapMs = toEpochMs(observed.snapshot_at);
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(snapMs) ||
    !Number.isSafeInteger(maxSnapshotAgeMs) ||
    maxSnapshotAgeMs < 0
  ) {
    return deny(
      LIVENESS_REASON.SNAPSHOT_TIMESTAMP_INVALID,
      `nowMs=${JSON.stringify(nowMs)}, snapshot_at=${JSON.stringify(observed.snapshot_at)}, maxSnapshotAgeMs=${JSON.stringify(maxSnapshotAgeMs)}`,
    );
  }
  if (nowMs < snapMs || nowMs - snapMs > maxSnapshotAgeMs) {
    return deny(
      LIVENESS_REASON.SNAPSHOT_STALE,
      `snapshot_at=${snapMs}, nowMs=${nowMs}, window=${maxSnapshotAgeMs}ms`,
    );
  }
  return null;
}

// pm-2 §3.3: liveness는 정확히 boolean true만 통과 -- false·"unknown"·null·undefined·
// truthy-but-not-boolean(1, "true" 등) 전부 fail-closed 한 값으로 뭉뚱그린다.
function checkAliveness(observed) {
  if (observed.liveness !== true) {
    return deny(
      LIVENESS_REASON.LIVENESS_NOT_ALIVE,
      `observed.liveness=${JSON.stringify(observed.liveness)} (only exact boolean true is accepted)`,
    );
  }
  return null;
}

function checkHandle(observed, signedTarget) {
  if (
    !isNonEmptyString(observed.handle) ||
    observed.handle !== signedTarget.handle
  ) {
    return deny(
      LIVENESS_REASON.HANDLE_MISMATCH,
      `signed handle=${JSON.stringify(signedTarget.handle)}, observed=${JSON.stringify(observed.handle)}`,
    );
  }
  return null;
}

function checkFingerprint(observed, signedTarget) {
  if (
    !isNonEmptyString(observed.fingerprint) ||
    observed.fingerprint !== signedTarget.fingerprint
  ) {
    return deny(
      LIVENESS_REASON.FINGERPRINT_MISMATCH,
      `signed fingerprint=${JSON.stringify(signedTarget.fingerprint)}, observed=${JSON.stringify(observed.fingerprint)}`,
    );
  }
  return null;
}

function checkWorktree(observed, expectedWorktree) {
  if (
    !isNonEmptyString(observed.worktree) ||
    observed.worktree !== expectedWorktree
  ) {
    return deny(
      LIVENESS_REASON.WORKTREE_MISMATCH,
      `expected worktree=${JSON.stringify(expectedWorktree)}, observed=${JSON.stringify(observed.worktree)}`,
    );
  }
  return null;
}

function checkAgentInstance(observed, signedTarget) {
  if (
    !isNonEmptyString(observed.agent_instance) ||
    observed.agent_instance !== signedTarget.agent_instance
  ) {
    return deny(
      LIVENESS_REASON.AGENT_INSTANCE_MISMATCH,
      `signed agent_instance=${JSON.stringify(signedTarget.agent_instance)}, observed=${JSON.stringify(observed.agent_instance)}`,
    );
  }
  return null;
}

// judgeLiveness({ signedTarget, expectedWorktree, observed, nowMs, maxSnapshotAgeMs })
// -> { ok, reason, detail }. 자동 재탐색·handle 치환·pane/좌석 재매핑 없음(pm-2 §3.3) --
// 불일치는 전부 즉시 deny, 대체 후보를 찾지 않는다.
export function judgeLiveness(input) {
  const inp = isPlainObject(input) ? input : {};
  const signedTarget = isPlainObject(inp.signedTarget) ? inp.signedTarget : {};
  // observed는 shape 검사 전엔 기본값으로 대체하지 않는다 -- 미리 {}로 바꿔두면
  // "observed 자체가 잘못된 타입"인 경우도 항상 통과해 버려 INPUT_INVALID가
  // 죽은 코드가 된다(관측시각 체크가 대신 잡아 SNAPSHOT_TIMESTAMP_INVALID를
  // 반환하는 오분류로 이어짐).
  const shapeDenied = checkInputShape(
    signedTarget,
    inp.expectedWorktree,
    inp.observed,
  );
  if (shapeDenied) return shapeDenied;
  const observed = inp.observed;

  const denied =
    checkSnapshotFreshness(observed, inp.nowMs, inp.maxSnapshotAgeMs) ??
    checkAliveness(observed) ??
    checkHandle(observed, signedTarget) ??
    checkFingerprint(observed, signedTarget) ??
    checkWorktree(observed, inp.expectedWorktree) ??
    checkAgentInstance(observed, signedTarget);
  if (denied) return denied;

  return { ok: true, reason: LIVENESS_REASON.ALLOW, detail: null };
}
