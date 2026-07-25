import { claimIntentTx, markIntentIssued } from "./stable-intent.mjs";
export {
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
  makeStableIntentFields,
  makeFakeDelegation,
  DELEGATION_TASK_HASH,
  DELEGATION_IN_WINDOW_NOW,
} from "./hyk171-cycle3a-fixtures.mjs";

// HYK-171 사이클3B -- launch-seam/running-receipt 테스트 공용 픽스처.
// 3A 픽스처(pull-admission 번들/gates/delegation)를 그대로 재수출해
// 재구현하지 않는다(위 re-export). 이 파일은 3B 고유(arm-state grant
// shape/sink spy/사람 receipt marker/ISSUED intent 준비)만 추가한다.
// S6 봉인: orca 모듈을 import하지 않고 CLI를 호출하지 않는다.

export const ARM_GRANT_ISSUED_AT = "2026-07-25T00:00:00.000Z";
export const ARM_GRANT_EXPIRES_AT = "2026-07-25T00:30:00.000Z";
export const ARM_GRANT_IN_WINDOW_NOW = Date.parse("2026-07-25T00:10:00.000Z");
export const ARM_GRANT_CYCLE_ID = "cycle-3b-1";

// makeArmGrant: arm-state.mjs의 validateGrant가 요구하는 shape 그대로
// (재구현 금지 -- launch-seam.mjs의 gate3가 그 함수를 직접 재사용한다).
export function makeArmGrant(overrides = {}) {
  return {
    arm_id: "arm-3b-1",
    cycle_id: ARM_GRANT_CYCLE_ID,
    human_approval_ref: "PKT-TEST-3B:승인:OK:2026-07-25",
    issued_at: ARM_GRANT_ISSUED_AT,
    expires_at: ARM_GRANT_EXPIRES_AT,
    allowed_lanes: ["CODER"],
    allowed_task_ids: ["HYK-171-cycle3b-1"],
    max_starts_total: 1,
    max_starts_per_lane: 1,
    max_rejections: 2,
    publish_allowed: false,
    question_policy: "pause",
    error_policy: "pause",
    ...overrides,
  };
}

// makeSinkSpy: 호출 횟수·인자를 계수하는 fake sink(§6 mutation 원장의
// exact-count 증명 -- 실 process spawn/orca dispatch는 0건).
export function makeSinkSpy(impl) {
  const calls = [];
  const sink = (arg) => {
    calls.push(arg);
    return typeof impl === "function" ? impl(arg) : { ok: true };
  };
  sink.calls = calls;
  return sink;
}

// makeHumanReceipt: 실 사람키 서명기가 아니다 -- 합성 테스트 전용 감사
// 참조 문자열(coder-task.md §4/§7 스코프 경계, 3A의 delegation
// human_approval_ref와 동일 원칙).
export function makeHumanReceipt(overrides) {
  return overrides ?? "human-receipt-3b-synthetic-ack";
}

// makeIssuedIntent: launch-seam 단위시험이 markIntentRunning(ISSUED->
// RUNNING)을 구동하려면 먼저 ISSUED 레코드가 디스크에 있어야 한다 --
// stable-intent.mjs의 claimIntentTx/markIntentIssued를 그대로 재사용해
// 그 전제를 만든다(재구현 0).
export function makeIssuedIntent(intentDir, stableIntentId, opts, at = "t0") {
  const claim = claimIntentTx(
    { intentDir, stableIntentId, winner: null, at },
    opts,
  );
  if (!claim.ok) {
    throw new Error(`fixture claimIntentTx failed: ${claim.reason}`);
  }
  const issued = markIntentIssued({ intentDir, stableIntentId, at }, opts);
  if (!issued.ok) {
    throw new Error(`fixture markIntentIssued failed: ${issued.reason}`);
  }
  return issued;
}

// makeSubGrantEnvelopeFields: launch-seam이 요구하는 envelope 결속 필드
// (stable_intent_id/task_hash/role)을 담은 최소 합성 envelope. 실
// issueSubGrant를 호출하는 end-to-end 테스트도 있지만(사이클3b 지시:
// "발급 성공 시 반환값을 seam 뒤에"), 순수 launch-seam 단위시험은 이
// 최소 shape로 충분하다.
export function makeSubGrantEnvelopeFields(stableIntentId, overrides = {}) {
  return {
    schema_version: 1,
    delegation_id: "delegation-3b-1",
    scope_issue_id: "HYK-171",
    role: "CODER",
    task_hash: "task-hash-3b-1",
    stable_intent_id: stableIntentId,
    issued_at: "2026-07-25T00:05:00.000Z",
    delegation_expires_at: "2026-07-25T00:30:00.000Z",
    max_start_budget_consumed: 1,
    signature: null,
    signature_note: "3B fake/test envelope -- no real human-key signer.",
    ...overrides,
  };
}
