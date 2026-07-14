import { claimTx, startTx, finishAttemptTx, recoverIncompleteClaimTx, needsRestartRecovery, loadStore, armStorePath } from "./arm-state.mjs";

// HYK-135 사이클5(coder-1, 그룹5 5A): 레인별 얇은 supervisor(설계확정-v1.md §1) --
// 자기 lane/cwd/config/task만 소비하고, agent 1회 실행을 그룹1~4가 이미 승인한
// arm-state Tx(claimTx/startTx/finishAttemptTx/recoverIncompleteClaimTx)에 전적으로
// 위임한다. 이 모듈은 **상태·권한을 창설하지 않는다** -- 판정은 전부 arm-state 소유,
// 여기서는 순서(재시작 복구 확인 -> 자기 소비 확인 -> STATUS 선보고 -> claim -> adapter
// 1회 호출 -> exit code/question 분류 -> finish)만 배선한다.
//
// 엔진 어댑터(Claude/codex 실제 CLI 호출)는 그룹5B 몫이다 -- 여기서는 `opts.adapterFn`
// 주입 인터페이스로만 정의하고, 이 파일 자체는 실제 서브프로세스를 기동하는 코드가 0이다.
// 사람 게이트(publish/서명/push/PR) 호출 경로도 이 파일엔 존재하지 않는다(G10) --
// go-wait-supervisor.test.mjs가 소스 텍스트를 직접 스캔해 이 사실을 감시한다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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

// ---- G5: 자기 것만 소비. arm-state를 전혀 건드리기 전에 판정(불일치 시 0 authority). ----
export function ownConsumptionProblems(scope, task) {
  const s = isPlainObject(scope) ? scope : {};
  const t = isPlainObject(task) ? task : {};
  const problems = [];
  if (typeof s.lane !== "string" || s.lane.length === 0) problems.push("scope.lane must be a non-empty string");
  else if (t.lane !== s.lane) problems.push(`lane mismatch (supervisor='${s.lane}', task='${t.lane}')`);
  if (typeof s.cwd !== "string" || s.cwd.length === 0) problems.push("scope.cwd must be a non-empty string");
  else if (t.cwd !== s.cwd) problems.push(`cwd mismatch (supervisor='${s.cwd}', task='${t.cwd}')`);
  if (typeof s.config !== "string" || s.config.length === 0) problems.push("scope.config must be a non-empty string");
  else if (t.config !== s.config) problems.push(`config mismatch (supervisor='${s.config}', task='${t.config}')`);
  if (!Array.isArray(s.allowedTaskIds) || s.allowedTaskIds.length === 0) {
    problems.push("scope.allowedTaskIds must be a non-empty array");
  } else {
    let found = false;
    for (let i = 0; i < s.allowedTaskIds.length; i++) {
      if (s.allowedTaskIds[i] === t.task_id) { found = true; break; }
    }
    if (!found) problems.push(`task_id '${t.task_id}' is not in this supervisor's allowed set`);
  }
  return problems;
}

// ---- G11: STATUS self-report. 실패(throw 포함)하면 fail-closed -- 이번 턴 claim/spawn 0. ----
function tryReport(reportStatusFn, payload) {
  try {
    const r = reportStatusFn(payload);
    if (isPlainObject(r) && r.ok === false) return { ok: false, reason: typeof r.reason === "string" ? r.reason : "arm-state: STATUS self-report reported failure" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `arm-state: STATUS self-report threw (${errText(e)})` };
  }
}

// ---- G7/G8: 종료 코드/신호 -> outcome 선언 데이터 테이블(그룹4 전이표와 동형 스타일).
// EXPECTED_EXIT_CODES 밖이거나 signal이 실리면 abnormal 계열. question은 exit code보다
// 우선(어댑터가 관찰한 question_packet은 프로세스 자체가 정상 종료했어도 우선 분류).
// silent 유실 0: 분류 불능(캡처 자체가 비었음)도 fail-closed로 abnormal 처리한다. ----
export const EXPECTED_EXIT_CODES = Object.freeze([0]);

function isExpectedExitCode(code) {
  for (let i = 0; i < EXPECTED_EXIT_CODES.length; i++) {
    if (EXPECTED_EXIT_CODES[i] === code) return true;
  }
  return false;
}

export function classifyAttemptResult(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const exitCode = typeof r.exitCode === "number" ? r.exitCode : null;
  const signal = typeof r.signal === "string" && r.signal.length > 0 ? r.signal : null;
  if (isPlainObject(r.question) && typeof r.question.question_id === "string" && r.question.question_id.length > 0) {
    return { outcome: "question", detail: { question_id: r.question.question_id, exitCode, signal } };
  }
  if (signal !== null) return { outcome: "cli_abnormal_exit", detail: { exitCode, signal } };
  if (!isExpectedExitCode(exitCode)) return { outcome: "cli_abnormal_exit", detail: { exitCode, signal } };
  return { outcome: "done", detail: { exitCode, signal } };
}

// ---- 진입점: 이 arm에 대해 정확히 1회의 감독 시도. 다중 lane 연속·자동 retry는 이
// 함수 밖(그룹5 표면 밖) -- 호출자가 매 시도마다 이 함수를 1회씩 부른다. ----
export function runSupervisedAttempt(dir, arm_id, scope, task, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const reportStatusFn = typeof o.reportStatusFn === "function" ? o.reportStatusFn : () => ({ ok: true });
  const adapterFn = typeof o.adapterFn === "function" ? o.adapterFn : null;

  if (typeof dir !== "string" || dir.length === 0 || typeof arm_id !== "string" || arm_id.length === 0) {
    return { phase: "input", ok: false, reason: "arm-state: runSupervisedAttempt requires non-empty dir/arm_id" };
  }

  // G5 먼저 -- 불일치면 arm-state 호출 0(claim 시도조차 하지 않음, 소비 자격 창설 0).
  const ownProblems = ownConsumptionProblems(scope, task);
  if (ownProblems.length) {
    return { phase: "own_consumption", ok: false, reason: `arm-state 미소비(supervisor scope mismatch) -- ${ownProblems.join("; ")}` };
  }

  // 설계확정-v1.md §1 supervisor 재시작 bullet: 이 arm이 CLAIMED/RUNNING인 채 재시작됐다면
  // 자동 재실행 금지 -- 그룹4 recoverIncompleteClaimTx로 탐지·표시만(재구현 0). 이번 턴은
  // claim을 시도하지 않는다.
  const storePath = armStorePath(dir, arm_id);
  const loaded = loadStore(storePath, o);
  if (loaded.ok && loaded.existed && needsRestartRecovery(loaded.store)) {
    const recovered = recoverIncompleteClaimTx(dir, arm_id, { task_id: task?.task_id, attempt_id: task?.attempt_id, at: task?.at, resultPath: o.resultPath }, o);
    return { phase: "restart_recovery", ok: recovered.ok === true, recover: recovered };
  }

  // G11 -- STATUS 선보고 실패 시 claim 자체를 시도하지 않는다.
  const preReport = tryReport(reportStatusFn, { phase: "claim_attempt", task_id: task?.task_id, attempt_id: task?.attempt_id, at: task?.at });
  if (!preReport.ok) {
    return { phase: "status_report", ok: false, reason: preReport.reason };
  }

  const claimed = claimTx(dir, arm_id, task, o);
  if (!claimed.spawnAllowed) {
    return { phase: "claim", ok: false, claim: claimed };
  }

  if (adapterFn === null) {
    return { phase: "adapter_missing", ok: false, reason: "arm-state: runSupervisedAttempt requires opts.adapterFn (stub in 5A -- real Claude/codex adapters are group 5B)" };
  }

  // I2: adapter 호출은 오직 startTx의 spawnFn 경유로만 -- startTx가 RUNNING을 먼저
  // 디스크에 저장한 후에만 이 클로저가 실행된다(그룹3 보장, 재구현 0). 정확히 1회:
  // startTx가 spawnFn을 두 번 부르지 않으며, 이 함수 자체도 startTx를 1회만 호출한다.
  let captured = null;
  const spawnFn = () => {
    captured = adapterFn({ task_id: task.task_id, attempt_id: task.attempt_id, lane: scope.lane, cwd: scope.cwd, config: scope.config, at: task.at });
  };

  const started = startTx(dir, arm_id, { task_id: task.task_id, attempt_id: task.attempt_id, at: task.at }, { ...o, spawnFn });
  if (!started.spawned) {
    // adapterFn이 throw했다면 startTx/runSpawn이 이미 startup_failure를 disarm·저장까지
    // 완료한 상태(그룹3/4A 승인 경로) -- 여기서 재분류·재저장하지 않는다.
    return { phase: "start", ok: started.ok === true, start: started };
  }

  // G8: 캡처가 비어 있어도(어댑터 계약 위반) silent 유실 0 -- classify가 fail-closed로
  // abnormal 처리하고, 그 원시값을 detail에 그대로 남긴다.
  const classified = classifyAttemptResult(captured);
  const finished = finishAttemptTx(dir, arm_id, { task_id: task.task_id, attempt_id: task.attempt_id, at: task.at, outcome: classified.outcome, detail: classified.detail }, o);

  const postReport = tryReport(reportStatusFn, { phase: "finished", task_id: task.task_id, attempt_id: task.attempt_id, outcome: classified.outcome, at: task.at });

  return {
    phase: "finished",
    ok: finished.ok === true,
    outcome: classified.outcome,
    finish: finished,
    statusReportAfterFinishFailed: postReport.ok === false,
    statusReportReason: postReport.ok === false ? postReport.reason : null,
  };
}
