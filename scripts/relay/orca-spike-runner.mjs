import { writeFileSync } from "node:fs";
import { checkPreDispatch, buildSpec } from "./orca-predispatch.mjs";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";

// HYK-162 사이클 2 (C 절충 스파이크, PKT-20260719-HYK162-ORCA-HYBRID-SPIKE §4): 사이클 1이
// 동결한 "시작 자격" 관문(orca-predispatch.mjs, 수정 금지·재사용만)을 실사용하는 스파이크
// 러너. **이 파일 안에서 orca 바이너리를 라이브로 호출하는 코드는 없다** -- 전부
// `execFn` 주입 계약 뒤로 미뤄진다(claude-adapter.mjs의 spawnSyncFn 주입 전례와 동형).
// 실 orca CLI 결선은 CLI 엔트리(맨 아래)에서만 일어나고, 그 실행 자체는 S7 REVIEW 승인
// 후 ORCH+사람 참관 하 1회로 한정된다(이 사이클 테스트는 전부 fake execFn).
//
// honesty (패킷 §7 인용): 이 러너는 "orca CLI 직접 호출을 실역 밖에서 기계 차단한다"는
// 주장이 아니다 -- 이 러너는 유일 허용 통로가 아니라 유일 **검증된** 통로일 뿐이다.
//
// S6 선언: 기반=B(Node 러너, 엔진 무관 -- Claude 훅 아님).

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

export const REASON = Object.freeze({
  PREDISPATCH_DENIED: "PREDISPATCH_DENIED",
  ORCA_COMMAND_NOT_ALLOWED: "ORCA_COMMAND_NOT_ALLOWED",
  TASK_CREATE_FAILED: "TASK_CREATE_FAILED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
  CHECK_TIMEOUT: "CHECK_TIMEOUT",
  CHECK_ESCALATION: "CHECK_ESCALATION",
  CHECK_UNKNOWN_OUTCOME: "CHECK_UNKNOWN_OUTCOME",
  HANDSHAKE_FAILED: "HANDSHAKE_FAILED",
  COMPLETE: "COMPLETE",
});

// ---- G2: 패킷 §4-2 허용 4종만(task-create 1회 · dispatch --inject 1회 ·
// coordinator check --wait/list/show · worker pane의 worker_done/heartbeat/escalation은
// check --wait의 *응답*으로만 관찰되고 러너가 직접 호출하는 명령이 아니다). 그 외 문자열
// 조합(terminal send, dispatch --agent/--setup/--run-hooks, orchestration run,
// automations, linear 등)은 이 러너의 코드 경로에 없고, 이 가드가 방어적으로도 거부한다.
export const ORCA_ALLOWED_COMMANDS = Object.freeze([
  ["orchestration", "task-create"],
  ["orchestration", "dispatch", "--inject"],
  ["orchestration", "check", "--wait"],
]);

export function assertAllowedOrcaCommand(argv) {
  const cmd = Array.isArray(argv) ? argv : [];
  const matches = ORCA_ALLOWED_COMMANDS.some(
    (allowed) =>
      allowed.length <= cmd.length && allowed.every((tok, i) => cmd[i] === tok),
  );
  if (!matches) {
    return {
      ok: false,
      reason: `orca-spike-runner: ${REASON.ORCA_COMMAND_NOT_ALLOWED} -- ${JSON.stringify(cmd)} is not one of the whitelisted §4-2 command shapes`,
    };
  }
  return { ok: true };
}

function stop(reason, detail, receipts) {
  return { ok: false, allow: false, reason, detail: detail ?? null, receipts };
}

function pushReceipt(receipts, entry, nowFn) {
  receipts.push({ at: nowFn(), ...entry });
}

// ---- 명령 빌더(순수, 인자 3~4개만 -- 동적 문자열 조합 없음) ----
export function buildTaskCreateCommand(spec, task_id) {
  return ["orchestration", "task-create", "--task-id", task_id, "--spec", spec];
}
export function buildDispatchCommand(task_id, terminalHandle) {
  return [
    "orchestration",
    "dispatch",
    "--inject",
    "--target",
    terminalHandle,
    "--task-id",
    task_id,
  ];
}
export function buildCheckWaitCommand(task_id, timeoutS) {
  return [
    "orchestration",
    "check",
    "--wait",
    "--task-id",
    task_id,
    "--timeout",
    String(timeoutS),
  ];
}

// 화이트리스트 통과 + execFn 호출 + 예외/비-ok 응답을 지정된 reason으로 통일.
function runGuardedStep(argv, opts, failReason, receipts, stepName) {
  const guard = assertAllowedOrcaCommand(argv);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  let response;
  try {
    response = opts.execFn(argv);
  } catch (err) {
    pushReceipt(
      receipts,
      { step: stepName, command: argv, error: errText(err) },
      opts.nowFn,
    );
    return {
      ok: false,
      reason: `orca-spike-runner: ${failReason} -- execFn threw (${errText(err)})`,
    };
  }
  pushReceipt(
    receipts,
    { step: stepName, command: argv, response },
    opts.nowFn,
  );
  if (!isPlainObject(response) || response.ok !== true) {
    return {
      ok: false,
      reason: `orca-spike-runner: ${failReason} -- ${isPlainObject(response) && isNonEmptyString(response.reason) ? response.reason : "response.ok !== true"}`,
    };
  }
  return { ok: true, response };
}

// check --wait 응답의 outcome을 fail-closed로 분류. worker_done은 여기서는 *운반
// 영수증*일 뿐이다 -- 완료 권위는 이어지는 checkRelayHandshake만이 준다(G6/G8).
function classifyCheckOutcome(response) {
  const outcome = isPlainObject(response) ? response.outcome : undefined;
  if (outcome === "worker_done") return { ok: true };
  if (outcome === "escalation") {
    return {
      ok: false,
      reason: `orca-spike-runner: ${REASON.CHECK_ESCALATION} -- worker escalated, human gate required`,
    };
  }
  if (outcome === "timeout") {
    return {
      ok: false,
      reason: `orca-spike-runner: ${REASON.CHECK_TIMEOUT} -- check --wait timed out`,
    };
  }
  return {
    ok: false,
    reason: `orca-spike-runner: ${REASON.CHECK_UNKNOWN_OUTCOME} -- unrecognized outcome ${JSON.stringify(outcome)}`,
  };
}

// ① 사이클 1 판정기(재사용, 재구현 금지) -- ALLOW 아니면 orca 호출 0.
function runPreDispatchStage(inp, o, deps, receipts) {
  const pd = checkPreDispatch(inp.predispatch, o);
  pushReceipt(
    receipts,
    { step: "predispatch", allow: pd.allow, reason: pd.reason },
    deps.nowFn,
  );
  if (!pd.allow) return stop(REASON.PREDISPATCH_DENIED, pd.reason, receipts);
  if (typeof deps.execFn !== "function") {
    return stop(
      REASON.TASK_CREATE_FAILED,
      "orca-spike-runner: opts.execFn is required past predispatch",
      receipts,
    );
  }
  return null;
}

// ②③④: task-create -> dispatch --inject -> check --wait (전부 execFn 뒤 -- 실 orca 호출 0).
function runOrcaStages(inp, deps, receipts) {
  const specResult = buildSpec(inp.task_id);
  if (!specResult.ok)
    return stop(REASON.TASK_CREATE_FAILED, specResult.reason, receipts);

  const created = runGuardedStep(
    buildTaskCreateCommand(specResult.spec, inp.task_id),
    deps,
    REASON.TASK_CREATE_FAILED,
    receipts,
    "task-create",
  );
  if (!created.ok)
    return stop(REASON.TASK_CREATE_FAILED, created.reason, receipts);

  const dispatched = runGuardedStep(
    buildDispatchCommand(inp.task_id, inp.terminalHandle),
    deps,
    REASON.DISPATCH_FAILED,
    receipts,
    "dispatch",
  );
  if (!dispatched.ok)
    return stop(REASON.DISPATCH_FAILED, dispatched.reason, receipts);

  const checked = runGuardedStep(
    buildCheckWaitCommand(inp.task_id, inp.timeoutS),
    deps,
    REASON.CHECK_UNKNOWN_OUTCOME,
    receipts,
    "check-wait",
  );
  if (!checked.ok)
    return stop(REASON.CHECK_UNKNOWN_OUTCOME, checked.reason, receipts);

  const outcomeCheck = classifyCheckOutcome(checked.response);
  if (!outcomeCheck.ok) {
    const reason = outcomeCheck.reason.includes(REASON.CHECK_ESCALATION)
      ? REASON.CHECK_ESCALATION
      : outcomeCheck.reason.includes(REASON.CHECK_TIMEOUT)
        ? REASON.CHECK_TIMEOUT
        : REASON.CHECK_UNKNOWN_OUTCOME;
    return stop(reason, outcomeCheck.reason, receipts);
  }
  return null;
}

// ⑤ 완료 권위 = 기존 handshake(재사용, 재구현 금지). worker_done은 위에서 운반
// 영수증으로만 기록됐고, 성공 선언은 오직 이 handshake가 ok일 때만(G6/G8).
function runHandshakeStage(inp, receipts, nowFn) {
  const handshake = checkRelayHandshake(
    isPlainObject(inp.handshake) ? inp.handshake : {},
  );
  pushReceipt(
    receipts,
    { step: "handshake", ok: handshake.ok, reason: handshake.reason },
    nowFn,
  );
  if (!handshake.ok)
    return stop(REASON.HANDSHAKE_FAILED, handshake.reason, receipts);
  return null;
}

// ---- 스파이크 1회 시도 (fail-closed, 자동 재시도 0) ----
// input: {
//   predispatch: checkPreDispatch(input, opts)에 그대로 넘길 payload
//   task_id, terminalHandle, timeoutS
//   handshake: { role, harnessDir } -- checkRelayHandshake({role, harnessDir})에 그대로 전달
// }
// opts: { execFn, nowFn }
export function runSpikeAttempt(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const o = isPlainObject(opts) ? opts : {};
  const deps = {
    execFn: typeof o.execFn === "function" ? o.execFn : null,
    nowFn:
      typeof o.nowFn === "function" ? o.nowFn : () => new Date().toISOString(),
  };
  const receipts = [];

  const predispatchStop = runPreDispatchStage(inp, o, deps, receipts);
  if (predispatchStop) return predispatchStop;

  const orcaStop = runOrcaStages(inp, deps, receipts);
  if (orcaStop) return orcaStop;

  const handshakeStop = runHandshakeStage(inp, receipts, deps.nowFn);
  if (handshakeStop) return handshakeStop;

  return {
    ok: true,
    allow: true,
    reason: REASON.COMPLETE,
    detail: null,
    receipts,
  };
}

// ---- CLI (orca 라이브 호출 결선은 여기뿐 -- 이 사이클에서 호출되지 않음) ----
const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/orca-spike-runner.mjs");
if (invokedDirectly) {
  console.error(
    "orca-spike-runner: CLI 라이브 결선은 이 사이클에 없다 -- 실 실행은 S7 REVIEW 승인 후 ORCH+사람 참관 하 1회로 한정된다 (패킷 PKT-20260719-HYK162-ORCA-HYBRID-SPIKE §4).",
  );
  process.exit(1);
}

// receipt 원장을 JSON 파일로 남기는 얇은 헬퍼(CLI가 필요 시 사용 -- 이 사이클에서는 미결선).
export function writeReceiptLedger(path, receipts) {
  writeFileSync(path, JSON.stringify(receipts, null, 2), "utf8");
}
