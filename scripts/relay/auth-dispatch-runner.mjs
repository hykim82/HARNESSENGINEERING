import { createHash } from "node:crypto";
import { verifyAuthGrant } from "./auth-grant-gate.mjs";
import { canonicalStringify } from "./auth-grant-canonical.mjs";
import { judgeLiveness } from "./auth-grant-liveness.mjs";
import { claimJtiTx } from "./auth-grant-ledger.mjs";
import { verifySpec } from "./orca-predispatch.mjs";
import {
  claimTx,
  startTx,
  finishAttemptTx,
  cancelTx,
  recoverIncompleteClaimTx,
} from "./arm-state.mjs";

// HYK-163 사이클 2 (pm-2 §3.1, C2-1~C2-8): 발신측 결정적 게이트 -- "승인된
// 하네스 자동 go 발신 경로의 단일 PEP"(R1, 전역 주입 차단 아님). 실 Orca 호출은
// `adapter.dispatch(spec)` 이 파일 안의 **단 한 곳**에서만 일어난다(G8 seam
// 단일화 -- 이 호출 지점은 gate+liveness+jti claim+arm claim+2차 재대조를 전부
// 통과한 뒤에만 도달 가능하다).
//
// 순서(pm-2 §3.4 권고 그대로): 서명·expected 검증(1차) → liveness(1차) → spec
// 검증(1차) → jti 원자 claim(claimJtiTx, ledgerDir는 grant가 아닌 trusted
// config에서만 옴) → arm claimTx(ARMED->CLAIMED, 기존 arm/task lifecycle 재사용)
// → 서명·liveness·spec 2차 재대조 → startTx(CLAIMED->RUNNING, spawnFn=adapter.
// dispatch 단일 seam) → 성공 시 finishAttemptTx(outcome:"done")로 종결.
//
// 재사용(재발명 0): claimTx/startTx/finishAttemptTx/cancelTx/recoverIncompleteClaimTx는
// 전부 arm-state.mjs 그대로. verifySpec은 orca-predispatch.mjs 그대로(G9 exact
// `go <task_id>` 계약). 이 파일이 새로 더하는 것은 오케스트레이션 순서와 jti
// 원장 결합뿐이다.
//
// 정직 한계(G6-runtime/G9-TUI UNVERIFIED, pm-2 §4): 이 판정이 PASS해도 실
// Orca liveness/실제 TUI payload를 증명하지 않는다. `adapter`는 항상 합성
// fake다(실 orca 0). live enable 플래그는 이 모듈에 없다 -- 호출자가 이 모듈을
// 실 Orca adapter에 연결하는 배선 자체가 사이클3 이후 몫이다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object") {
      const m = err.message;
      if (typeof m === "string") return m;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

export const RUN_REASON = Object.freeze({
  INPUT_INVALID: "INPUT_INVALID",
  ADAPTER_INVALID: "ADAPTER_INVALID",
  GATE_DENIED: "GATE_DENIED",
  LIVENESS_DENIED: "LIVENESS_DENIED",
  SPEC_INVALID: "SPEC_INVALID",
  JTI_ALREADY_CLAIMED: "JTI_ALREADY_CLAIMED",
  JTI_CLAIM_FAILED: "JTI_CLAIM_FAILED",
  ARM_CLAIM_FAILED: "ARM_CLAIM_FAILED",
  PREFLIGHT_RECHECK_FAILED: "PREFLIGHT_RECHECK_FAILED",
  START_FAILED: "START_FAILED",
  DISPATCHED: "DISPATCHED",
});

function grantDigestOf(fields) {
  return createHash("sha256").update(canonicalStringify(fields), "utf8").digest("hex");
}

// gate + liveness + spec 3종을 한 번에 재확인하는 헬퍼 -- 1차·2차 재대조가
// 완전히 동일한 검증 로직을 타게 한다(2차만 느슨해지는 회귀 방지).
function preflight(inp, nowMs, observed, gateOpts, specDeps) {
  const gateResult = verifyAuthGrant(
    {
      grantRaw: inp.grantRaw,
      signature: inp.signature,
      pinnedPublicKeyPath: inp.pinnedPublicKeyPath,
      expected: inp.expected,
      nowMs,
    },
    gateOpts,
  );
  if (!gateResult.ok) return { ok: false, stage: "gate", reason: gateResult.reason, detail: gateResult.detail };
  const fields = gateResult.fields;

  const expected = isPlainObject(inp.expected) ? inp.expected : {};
  const livenessResult = judgeLiveness({
    signedTarget: fields.target,
    expectedWorktree: expected.worktree,
    observed,
    nowMs,
    maxSnapshotAgeMs: inp.liveness?.maxSnapshotAgeMs,
  });
  if (!livenessResult.ok) {
    return { ok: false, stage: "liveness", reason: livenessResult.reason, detail: livenessResult.detail };
  }

  const specResult = verifySpec(inp.spec, inp.taskFilePath, {
    ...(isPlainObject(specDeps) ? specDeps : {}),
    expectedContentHash: inp.expectedContentHash,
  });
  if (!specResult.ok) {
    return { ok: false, stage: "spec", reason: "SPEC_INVALID", detail: specResult.reason };
  }
  if (specResult.task_id !== fields.task_id) {
    return {
      ok: false,
      stage: "spec",
      reason: "SPEC_INVALID",
      detail: `spec task_id ${JSON.stringify(specResult.task_id)} != signed grant task_id ${JSON.stringify(fields.task_id)}`,
    };
  }

  return { ok: true, fields, specResult };
}

function runReasonForStage(stage) {
  if (stage === "gate") return RUN_REASON.GATE_DENIED;
  if (stage === "liveness") return RUN_REASON.LIVENESS_DENIED;
  return RUN_REASON.SPEC_INVALID;
}

function safeCancelTx(armDir, armId, at, reason, armDeps) {
  try {
    return cancelTx(armDir, armId, { at, reason, ...(isPlainObject(armDeps) ? armDeps : {}) });
  } catch (err) {
    return { ok: false, reason: `auth-dispatch-runner: cancelTx threw (${errText(err)})` };
  }
}

function terminalDeny(armDir, armId, reason, detail, at, armDeps) {
  const armTerminal = safeCancelTx(armDir, armId, at, `${reason}: ${detail ?? ""}`, armDeps);
  return { ok: false, dispatched: false, adapterCalled: false, reason, detail: detail ?? null, armTerminal };
}

function checkTrustedConfig(inp) {
  const required = ["armDir", "armId", "ledgerDir", "cycleId", "lane"];
  for (const name of required) {
    if (!isNonEmptyString(inp[name])) {
      return `'${name}' must be a non-empty string`;
    }
  }
  return null;
}

// 승인된 fake adapter 뒤에서만 정확히 1회 호출되는 side-effect seam을 만든다.
// adapter.dispatch가 무엇을 반환하든(throw 포함) "정상 ok:true가 아니면 throw"로
// 균일화해 arm-state.startTx/runSpawn의 기존 startup_failure 자동 disarm 경로를
// 그대로 타게 한다(이 파일이 실패 disarm 로직을 중복 구현하지 않는다).
function buildSpawnFn(adapter, spec, outcome) {
  return () => {
    outcome.called = true;
    let result;
    try {
      result = adapter.dispatch(spec);
    } catch (err) {
      outcome.threw = true;
      outcome.error = errText(err);
      throw err;
    }
    outcome.result = result;
    if (!result || result.ok !== true) {
      outcome.rejected = true;
      throw new Error(
        `auth-dispatch-runner: adapter reported ok!==true (${JSON.stringify(result)})`,
      );
    }
  };
}

// runAuthDispatch(input, opts)
//   input: { grantRaw, signature, pinnedPublicKeyPath, expected, nowMs, nowMs2,
//            liveness:{observed, observed2, maxSnapshotAgeMs}, spec, taskFilePath,
//            expectedContentHash, armDir, armId, cycleId, lane, attemptId,
//            ledgerDir, adapter:{dispatch(spec)->{ok,...}}, at }
//   opts:  { gatePinDeps, ledgerDeps, armDeps, specDeps }
export function runAuthDispatch(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const o = isPlainObject(opts) ? opts : {};
  const at = isNonEmptyString(inp.at) ? inp.at : null;
  const { armDir, armId, cycleId, lane, ledgerDir, adapter } = inp;

  const configProblem = checkTrustedConfig(inp);
  if (configProblem) {
    return terminalDeny(armDir, armId, RUN_REASON.INPUT_INVALID, configProblem, at, o.armDeps);
  }
  if (!isPlainObject(adapter) || typeof adapter.dispatch !== "function") {
    return terminalDeny(
      armDir,
      armId,
      RUN_REASON.ADAPTER_INVALID,
      "adapter.dispatch must be a function",
      at,
      o.armDeps,
    );
  }

  const gateOpts = { pinDeps: o.gatePinDeps };
  const pass1 = preflight(inp, inp.nowMs, inp.liveness?.observed, gateOpts, o.specDeps);
  if (!pass1.ok) {
    return terminalDeny(armDir, armId, runReasonForStage(pass1.stage), pass1.detail ?? pass1.reason, at, o.armDeps);
  }
  const { fields } = pass1;

  const grantDigest = grantDigestOf(fields);
  const keyId = isPlainObject(inp.grantRaw) ? inp.grantRaw.key_id : undefined;
  const jti = fields.jti;
  const attemptId = isNonEmptyString(inp.attemptId) ? inp.attemptId : jti;

  const ledgerResult = claimJtiTx({ ledgerDir, keyId, jti, grantDigest, at }, o.ledgerDeps);
  if (!ledgerResult.ok) {
    const reason = ledgerResult.duplicate ? RUN_REASON.JTI_ALREADY_CLAIMED : RUN_REASON.JTI_CLAIM_FAILED;
    return terminalDeny(armDir, armId, reason, ledgerResult.reason, at, o.armDeps);
  }

  const armClaim = claimTx(
    armDir,
    armId,
    {
      task_id: fields.task_id,
      cycle_id: cycleId,
      lane,
      attempt_id: attemptId,
      content_hash: pass1.specResult.content_hash,
      at,
    },
    o.armDeps,
  );
  if (!armClaim.ok || armClaim.spawnAllowed !== true) {
    // jti는 이미 소비됨 -- 환불 없음(pm-2 §3.4). arm 쪽만 별도로 terminal disarm.
    const armTerminal = safeCancelTx(armDir, armId, at, `${RUN_REASON.ARM_CLAIM_FAILED}: ${armClaim.reason}`, o.armDeps);
    return {
      ok: false,
      dispatched: false,
      adapterCalled: false,
      reason: RUN_REASON.ARM_CLAIM_FAILED,
      detail: armClaim.reason,
      jtiConsumed: true,
      armTerminal,
    };
  }

  // 2차 재대조(dispatch 직전) -- claim 뒤 실패해도 jti는 돌려주지 않는다.
  const nowMs2 = Number.isSafeInteger(inp.nowMs2) ? inp.nowMs2 : inp.nowMs;
  const observed2 = inp.liveness?.observed2 ?? inp.liveness?.observed;
  const pass2 = preflight(inp, nowMs2, observed2, gateOpts, o.specDeps);
  if (!pass2.ok) {
    const armTerminal = safeCancelTx(
      armDir,
      armId,
      at,
      `${RUN_REASON.PREFLIGHT_RECHECK_FAILED}: ${pass2.detail ?? pass2.reason}`,
      o.armDeps,
    );
    return {
      ok: false,
      dispatched: false,
      adapterCalled: false,
      reason: RUN_REASON.PREFLIGHT_RECHECK_FAILED,
      detail: pass2.detail ?? pass2.reason,
      jtiConsumed: true,
      armTerminal,
    };
  }

  const dispatchOutcome = { called: false };
  const spawnFn = buildSpawnFn(adapter, inp.spec, dispatchOutcome);
  const startResult = startTx(
    armDir,
    armId,
    { task_id: fields.task_id, attempt_id: attemptId, at },
    { ...(isPlainObject(o.armDeps) ? o.armDeps : {}), spawnFn },
  );

  if (startResult.spawned !== true) {
    // arm-state.startTx/runSpawn이 실패 경로를 자체적으로 이미 persisted DISARMED
    // 처리했다(startup_failure/illegal-transition) -- 여기서 다시 cancelTx하지
    // 않는다(중복 종결 시도 금지, 이미 terminal).
    return {
      ok: false,
      dispatched: false,
      adapterCalled: dispatchOutcome.called === true,
      reason: RUN_REASON.START_FAILED,
      detail: startResult.reason,
      jtiConsumed: true,
      dispatchOutcome,
    };
  }

  const finishResult = finishAttemptTx(
    armDir,
    armId,
    {
      task_id: fields.task_id,
      attempt_id: attemptId,
      at,
      outcome: "done",
      detail: { adapter_result: dispatchOutcome.result },
    },
    o.armDeps,
  );

  return {
    ok: true,
    dispatched: true,
    adapterCalled: true,
    reason: RUN_REASON.DISPATCHED,
    detail: null,
    jtiConsumed: true,
    finishResult,
  };
}

// crash 복구(C2-7): arm-state의 기존 no-respawn 의미론을 그대로 위임한다(재구현
// 없음) -- claim 후 crash·RUNNING 후 crash 양쪽 다 recoverIncompleteClaimTx가
// DISARMED/PAUSED로 끝내고 절대 재spawn하지 않는다.
export function recoverAuthDispatch(armDir, armId, sel, opts) {
  return recoverIncompleteClaimTx(armDir, armId, sel, opts);
}
