import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { judgePullAdmission } from "./pull-admission.mjs";
import { canonicalStringify } from "./auth-grant-canonical.mjs";
import {
  ownConsumptionProblems,
  classifyAttemptResult,
} from "./go-wait-supervisor.mjs";
import { claimJtiTx } from "./auth-grant-ledger.mjs";
import { extractTaskId } from "../check/worker-status-onstart.mjs";
import {
  claimTx,
  startTx,
  finishAttemptTx,
  cancelTx,
  recoverIncompleteClaimTx,
  needsRestartRecovery,
  loadStore,
  armStorePath,
  hashContent,
} from "./arm-state.mjs";

// HYK-165 사이클2(합성, P3/P4/P5/P6/P7/P8/P9/P15): 보고서-pm1.md §3.1 10단계
// 순서 정본을 HYK-135 supervisor(go-wait-supervisor.mjs/arm-state.mjs)와
// HYK-165 사이클1 pull-admission.mjs에 배선하는 접합부다. 판정 로직은 전부
// 재사용(재구현 0) -- 이 파일이 새로 더하는 것은 "어느 순서로 어느 실패가
// 얼마나 태운 권위를 남기는가"뿐이다.
//
// 실제 코드 순서(보고서-pm1.md §3.1 표 그대로, 아래 주석 번호는 표의 순서):
//   0/1 own-consumption(자기 소비) -> 2 restart recovery -> 3 1차 admission
//   (pull-admission.judgePullAdmission) -> 4 task-file 결속(trusted task-file을
//   직접 읽어 authorization/grant와 재대조) -> [worker env allowlist, P9 --
//   STATUS/jti/arm 어떤 권위도 태우기 전에 정적 설정 오류를 fail-closed] ->
//   5 STATUS 선보고 -> 6 jti 원자 claim(auth-grant-ledger) -> 7 claimTx
//   ARMED->CLAIMED -> 8 2차 재대조(3/4와 동일 로직, preflight() 재사용) ->
//   9 startTx가 RUNNING 선저장 후 fresh adapter 정확히 1회 -> 10 finishAttemptTx.
// 각 단계는 helper(checkXStage)로 쪼개져 있다(quality-check 함수당 라인/복잡도
// 상한 준수 -- 순서·계약 자체는 그대로, 오케스트레이션만 분리).
//
// TOCTOU 정직 구분(보고서 §3.1 하단): 1차(3/4) 실패는 jti/arm claim 0(권위
// 자체를 만들지 않음). 2차(8) 실패는 이미 태운 jti/arm 권위를 되돌리지
// 않는다 -- cancelTx로 arm만 DISARM하고 jti 환불은 없다(HYK-163
// auth-dispatch-runner.mjs의 승인된 전례와 동일 정책, 재발명 0).
//
// 실 worker·실 Orca 접촉 0: adapterFn은 항상 opts로 주입되는 fake다. 이
// 파일은 publish/sign/PR/Done/Linear/north-star API를 어디에서도 호출하지
// 않는다(정적 스캔으로 감시 -- pull-supervisor.test.mjs).

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
  INPUT_INVALID: "INPUT_INVALID",
  OWN_CONSUMPTION_MISMATCH: "OWN_CONSUMPTION_MISMATCH",
  ADMISSION_DENIED: "ADMISSION_DENIED",
  TASK_FILE_MISMATCH: "TASK_FILE_MISMATCH",
  ENV_ALLOWLIST_VIOLATION: "ENV_ALLOWLIST_VIOLATION",
  STATUS_REPORT_FAILED: "STATUS_REPORT_FAILED",
  JTI_ALREADY_CLAIMED: "JTI_ALREADY_CLAIMED",
  JTI_CLAIM_FAILED: "JTI_CLAIM_FAILED",
  ARM_CLAIM_FAILED: "ARM_CLAIM_FAILED",
  PREFLIGHT_RECHECK_FAILED: "PREFLIGHT_RECHECK_FAILED",
  ADAPTER_MISSING: "ADAPTER_MISSING",
  START_FAILED: "START_FAILED",
});

// 공통 denial 모양: 어떤 단계에서 거부됐든 jtiConsumed/armClaimed/adapterCalled
// 3개 플래그가 항상 실려 있어야 호출자가 "이 실패가 얼마나 권위를 태웠는가"를
// 셋 다 명시적으로 읽을 수 있다(기본은 아직 아무것도 안 태운 최솟값, 늦은
// 단계일수록 extra로 override).
function denyResult(phase, reason, extra = {}) {
  return {
    phase,
    ok: false,
    reason,
    jtiConsumed: false,
    armClaimed: false,
    adapterCalled: false,
    ...extra,
  };
}

// pull-admission.mjs의 bundlePaths()(비공개)와 동일한 파일명 규약(P10 §3.2)을
// 그대로 따르는 1줄짜리 경로 구성 -- 판정 로직 재구현이 아니라 "이미 admission이
// 검증한 그 파일"을 supervisor가 (key_id 추출/waiter 존재확인 용도로) 다시
// 가리키기 위한 경로 계산일 뿐이다.
export function pullBundleGrantPath(bundleDir, armId, jti) {
  return join(bundleDir, `signed-grant-${armId}-${jti}.json`);
}

function readGrantKeyId(bundleDir, armId, jti, readFileFn) {
  try {
    const envelope = JSON.parse(
      readFileFn(pullBundleGrantPath(bundleDir, armId, jti)),
    );
    return isPlainObject(envelope) && isPlainObject(envelope.grantRaw)
      ? envelope.grantRaw.key_id
      : undefined;
  } catch {
    return undefined;
  }
}

function grantDigestOf(fields) {
  return hashContent(canonicalStringify(fields));
}

// ---- P9: worker subprocess env allowlist. supervisor가 fresh adapter에 넘길
// env가 이 목록 밖의 키를 담으면 -- STATUS/jti/arm 어떤 권위도 만들기 전에
// fail-closed(어떤 claim도 0). 목록은 trusted config가 override할 수 있으나
// 기본은 최소 실행에 필요한 OS 표준 변수만 담는다(worker role 권한을 넓히는
// credential/flag는 여기 없다).
export const DEFAULT_WORKER_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "Path",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ComSpec",
]);

export function checkWorkerEnvAllowlist(env, allowlist) {
  const e = isPlainObject(env) ? env : {};
  const list =
    Array.isArray(allowlist) && allowlist.length > 0
      ? allowlist
      : DEFAULT_WORKER_ENV_ALLOWLIST;
  const allowedSet = new Set(list);
  const violations = [];
  for (const key of Object.keys(e)) {
    if (!allowedSet.has(key)) violations.push(key);
  }
  return violations.length === 0
    ? { ok: true, violations: [] }
    : { ok: false, violations };
}

// ---- G11 STATUS self-report (go-wait-supervisor.mjs tryReport와 동일 계약,
// 그 함수는 비공개 export라 import 불가 -- 접합부 자체 재구현이 아니라 같은
// "실패=fail-closed" 규율의 얇은 재적용). ----
function tryReport(reportStatusFn, payload) {
  try {
    const r = reportStatusFn(payload);
    if (isPlainObject(r) && r.ok === false) {
      return {
        ok: false,
        reason:
          typeof r.reason === "string"
            ? r.reason
            : "pull-supervisor: STATUS self-report reported failure",
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `pull-supervisor: STATUS self-report threw (${errText(e)})`,
    };
  }
}

function safeCancelTx(dir, armId, at, reason, armDeps) {
  try {
    return cancelTx(dir, armId, {
      at,
      reason,
      ...(isPlainObject(armDeps) ? armDeps : {}),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `pull-supervisor: cancelTx threw (${errText(err)})`,
    };
  }
}

// ---- step4: trusted task-file을 직접 읽어 authorization/signed grant와 재대조.
// pull-admission.mjs는 bundle 3파일끼리의 내부 정합만 본다(디스크의 실제
// task-file은 건드리지 않는다) -- 이 함수가 그 바깥쪽 결속을 닫는다:
//   (a) 파일 내용 sha256 == signed grant task_sha256
//   (b) authorization.resolved_task_path == 호출자가 준 trusted taskFilePath
//       (둘 다 이미 expected와 대조됐지만, 여기서 직접 등치까지 확인 -- 방어적)
//   (c) 파일의 task_id 헤더 == signed grant task_id
function checkTaskFile(fields, authFields, taskFilePath, readFileFn) {
  let content;
  try {
    content = readFileFn(taskFilePath);
  } catch (err) {
    return {
      denied: {
        reason: REASON.TASK_FILE_MISMATCH,
        detail: `cannot read trusted task file '${taskFilePath}' (${errText(err)})`,
      },
    };
  }
  const contentHash = hashContent(content);
  if (contentHash !== fields.task_sha256) {
    return {
      denied: {
        reason: REASON.TASK_FILE_MISMATCH,
        detail: `task file sha256=${contentHash} != signed grant task_sha256=${fields.task_sha256}`,
      },
    };
  }
  if (authFields.resolved_task_path !== taskFilePath) {
    return {
      denied: {
        reason: REASON.TASK_FILE_MISMATCH,
        detail: `authorization resolved_task_path=${JSON.stringify(authFields.resolved_task_path)} != trusted taskFilePath=${JSON.stringify(taskFilePath)}`,
      },
    };
  }
  const fileTaskId = extractTaskId(content);
  if (fileTaskId !== fields.task_id) {
    return {
      denied: {
        reason: REASON.TASK_FILE_MISMATCH,
        detail: `task file task_id=${JSON.stringify(fileTaskId)} != signed grant task_id=${JSON.stringify(fields.task_id)}`,
      },
    };
  }
  return { contentHash, fileTaskId };
}

// preflight(): 1차(step 3+4)와 2차(step 8)가 완전히 동일한 검증을 타게 하는
// 단일 헬퍼(HYK-163 auth-dispatch-runner.mjs의 preflight()와 동형 -- 2차만
// 느슨해지는 회귀를 원천 방지).
function preflight(inp, nowMs, readFileFn) {
  const admission = judgePullAdmission(
    {
      bundleDir: inp.bundleDir,
      armId: inp.armId,
      jti: inp.jti,
      pinnedPublicKeyPath: inp.pinnedPublicKeyPath,
      expected: inp.expected,
      nowMs,
    },
    { readFileFn, pinDeps: inp.pinDeps },
  );
  if (!admission.ok) {
    return {
      ok: false,
      stage: "admission",
      reason: REASON.ADMISSION_DENIED,
      detail: `${admission.reason}: ${admission.detail ?? ""}`,
    };
  }
  const taskCheck = checkTaskFile(
    admission.fields,
    admission.authorization,
    inp.taskFilePath,
    readFileFn,
  );
  if (taskCheck.denied) {
    return {
      ok: false,
      stage: "task_file",
      reason: taskCheck.denied.reason,
      detail: taskCheck.denied.detail,
    };
  }
  return {
    ok: true,
    fields: admission.fields,
    authorization: admission.authorization,
    armState: admission.armState,
    taskCheck,
  };
}

// ---- step-helper 분해(각 단계 하나씩 -- 오케스트레이션 함수 자체의 라인/복잡도를
// quality-check 상한 아래로 낮추기 위한 분리일 뿐, 순서·계약은 표 그대로다). ----

function checkPreconditions(inp) {
  const REQUIRED_STRINGS = [
    "dir",
    "armId",
    "bundleDir",
    "jti",
    "pinnedPublicKeyPath",
    "ledgerDir",
    "taskFilePath",
  ];
  for (const f of REQUIRED_STRINGS) {
    if (!isNonEmptyString(inp[f])) {
      return `pull-supervisor: '${f}' must be a non-empty string`;
    }
  }
  return null;
}

function checkOwnConsumptionStage(scope, expectedTask) {
  const ownProblems = ownConsumptionProblems(scope, expectedTask);
  if (!ownProblems.length) return null;
  return denyResult(
    "own_consumption",
    `pull-supervisor: 자기 소비 아님(scope mismatch) -- ${ownProblems.join("; ")}`,
  );
}

function checkRestartRecoveryStage(inp, expectedTask, at, armDeps) {
  const loaded = loadStore(armStorePath(inp.dir, inp.armId), armDeps);
  if (!(loaded.ok && loaded.existed && needsRestartRecovery(loaded.store)))
    return null;
  const recovered = recoverIncompleteClaimTx(
    inp.dir,
    inp.armId,
    {
      task_id: expectedTask.task_id,
      attempt_id: inp.attemptId,
      at,
      resultPath: inp.resultPath,
    },
    armDeps,
  );
  return {
    phase: "restart_recovery",
    ok: recovered.ok === true,
    recover: recovered,
    jtiConsumed: false,
    armClaimed: false,
    adapterCalled: false,
  };
}

function runPreflight1Stage(inp, readFileFn) {
  const pass1 = preflight(inp, inp.nowMs, readFileFn);
  if (!pass1.ok) {
    return {
      denied: denyResult("preflight_1", pass1.reason, {
        stage: pass1.stage,
        detail: pass1.detail,
      }),
    };
  }
  return { pass1 };
}

function checkEnvAllowlistStage(inp) {
  const envCheck = checkWorkerEnvAllowlist(
    inp.workerEnv,
    inp.workerEnvAllowlist,
  );
  if (envCheck.ok) return null;
  return denyResult("env_allowlist", REASON.ENV_ALLOWLIST_VIOLATION, {
    detail: `disallowed worker env keys: ${envCheck.violations.join(", ")}`,
  });
}

function reportStatusStage(reportStatusFn, fields, inp, at) {
  const preReport = tryReport(reportStatusFn, {
    phase: "claim_attempt",
    task_id: fields.task_id,
    arm_id: inp.armId,
    jti: fields.jti,
    at,
  });
  if (preReport.ok) return null;
  return denyResult("status_report", REASON.STATUS_REPORT_FAILED, {
    detail: preReport.reason,
  });
}

function claimJtiStage(inp, fields, at, readFileFn, ledgerDeps) {
  const keyId = readGrantKeyId(
    inp.bundleDir,
    inp.armId,
    fields.jti,
    readFileFn,
  );
  const grantDigest = grantDigestOf(fields);
  const ledgerResult = claimJtiTx(
    { ledgerDir: inp.ledgerDir, keyId, jti: fields.jti, grantDigest, at },
    ledgerDeps,
  );
  if (ledgerResult.ok) return {};
  const reason = ledgerResult.duplicate
    ? REASON.JTI_ALREADY_CLAIMED
    : REASON.JTI_CLAIM_FAILED;
  return {
    denied: denyResult("jti_claim", reason, { detail: ledgerResult.reason }),
  };
}

function claimArmStage(
  inp,
  fields,
  authFields,
  contentHash,
  attemptId,
  at,
  armDeps,
) {
  const armTask = {
    task_id: fields.task_id,
    cycle_id: fields.cycle_id,
    lane: authFields.lane,
    attempt_id: attemptId,
    content_hash: contentHash,
    at,
  };
  const armClaim = claimTx(inp.dir, inp.armId, armTask, armDeps);
  if (armClaim.ok && armClaim.spawnAllowed === true) return {};
  // jti는 이미 소비됨 -- 환불 없음(HYK-163 전례 재사용). arm 쪽만 별도 terminal disarm.
  const armTerminal = safeCancelTx(
    inp.dir,
    inp.armId,
    at,
    `${REASON.ARM_CLAIM_FAILED}: ${armClaim.reason}`,
    armDeps,
  );
  return {
    denied: denyResult("arm_claim", REASON.ARM_CLAIM_FAILED, {
      detail: armClaim.reason,
      jtiConsumed: true,
      armTerminal,
    }),
  };
}

// step8: 2차 재대조(3/4와 동일 로직) -- 변이면 arm DISARM, spawn 0. jti/arm
// claim은 되돌리지 않는다(TOCTOU 정직 구분, 보고서 §3.1 하단).
function recheckStage(inp, at, readFileFn, armDeps) {
  const nowMs2 = Number.isSafeInteger(inp.nowMs2) ? inp.nowMs2 : inp.nowMs;
  const pass2 = preflight(inp, nowMs2, readFileFn);
  if (pass2.ok) return {};
  const armTerminal = safeCancelTx(
    inp.dir,
    inp.armId,
    at,
    `${REASON.PREFLIGHT_RECHECK_FAILED}: ${pass2.detail ?? pass2.reason}`,
    armDeps,
  );
  return {
    denied: denyResult("preflight_2", REASON.PREFLIGHT_RECHECK_FAILED, {
      stage: pass2.stage,
      detail: pass2.detail ?? pass2.reason,
      jtiConsumed: true,
      armClaimed: true,
      armTerminal,
    }),
  };
}

function finishStage(
  inp,
  fields,
  attemptId,
  at,
  dispatchOutcome,
  armDeps,
  reportStatusFn,
) {
  const classified = classifyAttemptResult(dispatchOutcome.captured);
  const finished = finishAttemptTx(
    inp.dir,
    inp.armId,
    {
      task_id: fields.task_id,
      attempt_id: attemptId,
      at,
      outcome: classified.outcome,
      detail: classified.detail,
    },
    armDeps,
  );
  const postReport = tryReport(reportStatusFn, {
    phase: "finished",
    task_id: fields.task_id,
    attempt_id: attemptId,
    outcome: classified.outcome,
    at,
  });
  return {
    phase: "finished",
    ok: finished.ok === true,
    outcome: classified.outcome,
    finish: finished,
    jtiConsumed: true,
    armClaimed: true,
    adapterCalled: true,
    adapterCallCount: 1,
    statusReportAfterFinishFailed: postReport.ok === false,
    statusReportReason: postReport.ok === false ? postReport.reason : null,
  };
}

// step9: startTx가 RUNNING 선저장 후 fresh adapter 정확히 1회. I2(arm-state.mjs):
// adapter 호출은 오직 startTx의 spawnFn 경유로만 -- startTx가 RUNNING을 먼저
// 디스크에 저장한 후에만 이 클로저가 실행된다. step10(finishStage)까지 이어간다.
function startAndFinishStage(
  inp,
  fields,
  authFields,
  attemptId,
  at,
  adapterFn,
  armDeps,
  scope,
  reportStatusFn,
) {
  if (adapterFn === null) {
    const armTerminal = safeCancelTx(
      inp.dir,
      inp.armId,
      at,
      REASON.ADAPTER_MISSING,
      armDeps,
    );
    return denyResult("adapter_missing", REASON.ADAPTER_MISSING, {
      detail:
        "pull-supervisor: opts.adapterFn is required (inject fake -- real Claude/codex CLI is cycle3 scope)",
      jtiConsumed: true,
      armClaimed: true,
      armTerminal,
    });
  }
  const dispatchOutcome = { called: false, captured: null };
  const spawnFn = () => {
    dispatchOutcome.called = true;
    dispatchOutcome.captured = adapterFn({
      task_id: fields.task_id,
      attempt_id: attemptId,
      lane: authFields.lane,
      cwd: authFields.cwd,
      config: scope.config,
      at,
    });
  };
  const started = startTx(
    inp.dir,
    inp.armId,
    { task_id: fields.task_id, attempt_id: attemptId, at },
    { ...(isPlainObject(armDeps) ? armDeps : {}), spawnFn },
  );
  if (!started.spawned) {
    // adapterFn이 throw했다면 startTx/runSpawn이 이미 startup_failure를 disarm·저장까지
    // 완료한 상태(그룹3/4A 승인 경로) -- 여기서 재분류·재저장하지 않는다.
    return {
      phase: "start",
      ok: started.ok === true,
      reason: REASON.START_FAILED,
      start: started,
      jtiConsumed: true,
      armClaimed: true,
      adapterCalled: dispatchOutcome.called === true,
      adapterCallCount: dispatchOutcome.called === true ? 1 : 0,
    };
  }
  return finishStage(
    inp,
    fields,
    attemptId,
    at,
    dispatchOutcome,
    armDeps,
    reportStatusFn,
  );
}

// runPullSupervisedAttempt(input, opts): 이 arm에 대해 정확히 1회의 감독
// 시도(go-wait-supervisor.runSupervisedAttempt와 동형 -- 다중 lane 연속·자동
// retry는 이 함수 밖). 호출자(waiter 또는 사람이 직접)가 매 시도마다 1회씩
// 부른다.
//
//   input: { dir, armId, bundleDir, jti, pinnedPublicKeyPath, ledgerDir,
//            taskFilePath, scope:{lane,cwd,config,allowedTaskIds},
//            expectedTask:{task_id,cycle_id,lane,cwd,config} (step0/1 자기
//            소비 판정용, expected와 별개 -- expected는 암호 결속용),
//            expected:{...pull-admission expected 구조...}, nowMs, nowMs2,
//            attemptId?, at, workerEnv?, workerEnvAllowlist?, pinDeps?,
//            resultPath? }
//   opts:  { readFileFn, reportStatusFn, adapterFn, armDeps, ledgerDeps }
//
// normalizeRunInputs(): input/opts 정규화(기본값 채우기)만 모아 두는 헬퍼 --
// 오케스트레이션 함수 자체의 분기 수를 낮추기 위한 분리일 뿐, 계약은 그대로다.
function normalizeRunInputs(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const o = isPlainObject(opts) ? opts : {};
  const readFileFn =
    typeof o.readFileFn === "function"
      ? o.readFileFn
      : (p) => readFileSync(p, "utf8");
  const reportStatusFn =
    typeof o.reportStatusFn === "function"
      ? o.reportStatusFn
      : () => ({ ok: true });
  const adapterFn = typeof o.adapterFn === "function" ? o.adapterFn : null;
  return {
    inp,
    o,
    readFileFn,
    reportStatusFn,
    adapterFn,
    armDeps: o.armDeps,
    at: isNonEmptyString(inp.at) ? inp.at : null,
    scope: isPlainObject(inp.scope) ? inp.scope : {},
    expectedTask: isPlainObject(inp.expectedTask) ? inp.expectedTask : {},
  };
}

export function runPullSupervisedAttempt(input, opts) {
  const {
    inp,
    o,
    readFileFn,
    reportStatusFn,
    adapterFn,
    armDeps,
    at,
    scope,
    expectedTask,
  } = normalizeRunInputs(input, opts);

  const preconditionProblem = checkPreconditions(inp);
  if (preconditionProblem) return denyResult("input", preconditionProblem);

  const ownDenied = checkOwnConsumptionStage(scope, expectedTask);
  if (ownDenied) return ownDenied;

  const recovery = checkRestartRecoveryStage(inp, expectedTask, at, armDeps);
  if (recovery) return recovery;

  const pre1 = runPreflight1Stage(inp, readFileFn);
  if (pre1.denied) return pre1.denied;
  const { fields, authorization: authFields, taskCheck } = pre1.pass1;

  const envDenied = checkEnvAllowlistStage(inp);
  if (envDenied) return envDenied;

  const attemptId = isNonEmptyString(inp.attemptId)
    ? inp.attemptId
    : fields.jti;

  const statusDenied = reportStatusStage(reportStatusFn, fields, inp, at);
  if (statusDenied) return statusDenied;

  const jtiStage = claimJtiStage(inp, fields, at, readFileFn, o.ledgerDeps);
  if (jtiStage.denied) return jtiStage.denied;

  const armStage = claimArmStage(
    inp,
    fields,
    authFields,
    taskCheck.contentHash,
    attemptId,
    at,
    armDeps,
  );
  if (armStage.denied) return armStage.denied;

  const recheck = recheckStage(inp, at, readFileFn, armDeps);
  if (recheck.denied) return recheck.denied;

  return startAndFinishStage(
    inp,
    fields,
    authFields,
    attemptId,
    at,
    adapterFn,
    armDeps,
    scope,
    reportStatusFn,
  );
}

// ---- P6: bounded one-shot waiter (보고서 §3.3) ----
function waitForBundleFile(
  watchedPath,
  maxTicks,
  tickIntervalMs,
  existsFn,
  sleepFn,
) {
  for (let tick = 0; tick < maxTicks; tick++) {
    let exists;
    try {
      exists = existsFn(watchedPath);
    } catch {
      exists = false;
    }
    if (exists) return true;
    if (tick < maxTicks - 1) sleepFn(tickIntervalMs);
  }
  return false;
}

// exact lane/task/arm_id·jti가 고정된 supervisor를 "한 배치에 한 번"만
// 대기시킨다. 확인하는 경로는 정확히 하나(signed-grant-<armId>-<jti>.json) --
// bundleDir 전체 스캔·임의 task 선택 0. valid든 invalid든 admission이
// 판단하게 두고(이 함수는 "파일이 존재하는가"만 본다), 그 결과가 무엇이든
// waiter는 정확히 1회 시도 후 끝난다(자동 retry·재기동·polling 0).
//
//   input: runPullSupervisedAttempt와 동일 input + { maxTicks?, tickIntervalMs? }
//   opts:  runPullSupervisedAttempt와 동일 opts + { existsFn?, sleepFn? }
export function runOneShotPullWaiter(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const o = isPlainObject(opts) ? opts : {};
  const existsFn = typeof o.existsFn === "function" ? o.existsFn : existsSync;
  const sleepFn = typeof o.sleepFn === "function" ? o.sleepFn : () => {};
  const maxTicks =
    Number.isSafeInteger(inp.maxTicks) && inp.maxTicks > 0 ? inp.maxTicks : 1;

  if (
    !isNonEmptyString(inp.bundleDir) ||
    !isNonEmptyString(inp.armId) ||
    !isNonEmptyString(inp.jti)
  ) {
    return {
      phase: "waiter_input",
      ok: false,
      reason: "pull-supervisor: bundleDir/armId/jti must be non-empty strings",
      attempted: false,
    };
  }
  const watchedPath = pullBundleGrantPath(inp.bundleDir, inp.armId, inp.jti);
  const found = waitForBundleFile(
    watchedPath,
    maxTicks,
    inp.tickIntervalMs ?? 0,
    existsFn,
    sleepFn,
  );
  if (!found) {
    return {
      phase: "waiter_timeout",
      ok: false,
      reason:
        "pull-supervisor: waiter timed out -- exact expected signed bundle never appeared",
      attempted: false,
      watchedPath,
    };
  }

  const attempt = runPullSupervisedAttempt(input, opts);
  return {
    phase: "waiter_attempted",
    ok: attempt.ok === true,
    attempted: true,
    watchedPath,
    attempt,
  };
}
