// HYK-183 A-1 (coder-task.md §5, ORCH §10 판정 2026-08-01 22:08 KST) --
// 실행부 진입점 골격. queue-manifest-core.mjs의 판정(SV-3/SV-4)을 «실행
// 경로의 입구»에 놓되, 이 파일 자신은 아무것도 실행하지 않는다.
//
// 이 코어가 증명하는 것 / 증명하지 않는 것 (S11 필수):
// - **증명하지 않는다**: 이 코어는 "계획이 옳다"를 증명하지 않는다.
//   "잘못된 큐에서는 계획이 나오지 않는다"만 증명한다 -- queueEvaluation이
//   진짜 evaluateQueueManifest(observation)의 반환값인지는 호출자 책임이고,
//   이 코어는 그 형태(verdict/reason/entries)만 신뢰성 있게 소비한다.
// - **증명한다**: (1) 부작용 0(파일 쓰기·프로세스 생성·`orca` 호출·네트워크
//   전부 0 -- import가 queue-manifest-core.mjs 하나뿐이고 그 파일도 I/O가
//   0이므로 이 모듈 자체가 구조적으로 I/O 표면이 없다) (2) queueEvaluation이
//   START_ALLOWED가 아니면(또는 형태가 이상하면) 계획을 만들지 않는다
//   (fail-closed) (3) 정상 큐에서 ordinal이 가장 작은 활성 항목 하나로만
//   계획을 만든다.
// - 표본·조건: 전부 executor-core.test.mjs의 손으로 조립한 SYNTHETIC
//   queueEvaluation 객체(실제 evaluateQueueManifest 호출 없음). 실제 git
//   저장소를 거친 관측이 이 형태와 일치하는지는 여기서 증명하지 않는다.
// - **이 조각이 아직 막지 못하는 것(통과해도 열려 있는 구멍)**:
//   1. 드롭·기동·정리는 이 조각에 없다(A-4·A-5·A-6, 아직 승인되지 않음) --
//      `plan`에는 "무엇을 할 것인가"만 있고 실행 수단(핸들·경로·argv·명령
//      문자열)은 전혀 없다.
//   2. 판단부(SV-1·SV-2)는 미확정이며 이 코어는 그것을 대신하지 않는다.
//   3. "이미 처리됐는가"는 이 조각이 모른다 -- 이 코어는 «다음에 할 것»을
//      고르지 않는다. «큐가 신뢰할 수 있을 때 첫 활성 항목»을 지목할
//      뿐이며, 이미 처리된 항목인지·동시 실행 중인지는 판단하지 않는다
//      (동시 실행 1개 제한은 A-2 범위, ORCH §10 확정3).
//
// 비타협(coder-task.md §2):
// - fs·child_process·네트워크·`orca` 호출 0 -- 이 파일은 아무것도 import
//   하지 않는다(queue-manifest-core.mjs 제외, 그 파일도 I/O 0).
// - throw로 판정을 대신하지 않는다 -- 인자가 이상하면 예외가 아니라
//   `{ok:false, plan:null, reasonCode:"INVALID_ARGUMENTS"}`를 반환한다.
// - `ok:false`면 `plan`은 항상 `null`(부분 계획 금지).

export const EXECUTION_REASON = Object.freeze({
  PLAN_READY: "PLAN_READY",
  QUEUE_START_BLOCKED: "QUEUE_START_BLOCKED",
  NO_READY_ITEM: "NO_READY_ITEM",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
});

const QUEUE_EVALUATION_VERDICTS = Object.freeze([
  "START_ALLOWED",
  "START_BLOCKED",
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isBoolean(v) {
  return typeof v === "boolean";
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeInteger(v) {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function invalid() {
  return {
    ok: false,
    plan: null,
    reasonCode: EXECUTION_REASON.INVALID_ARGUMENTS,
    queueReason: null,
  };
}

function blockedByQueue(reason) {
  return {
    ok: false,
    plan: null,
    reasonCode: EXECUTION_REASON.QUEUE_START_BLOCKED,
    queueReason: reason,
  };
}

function noReadyItem(reason) {
  return {
    ok: false,
    plan: null,
    reasonCode: EXECUTION_REASON.NO_READY_ITEM,
    queueReason: reason,
  };
}

// queueEvaluation은 evaluateQueueManifest(observation)의 반환값 그대로여야
// 한다({verdict, reason, entries}) -- 최상위 형태 + verdict/reason의 상호
// 일관성(START_ALLOWED <=> reason==="OK", START_BLOCKED에서 entries는 항상
// 빈 배열)까지 확인한다. 하나라도 어긋나면 이 queueEvaluation 자체를
// 신뢰하지 않는다(위조·변조된 값을 그대로 실행 입구에 놓지 않기 위해).
function isTrustworthyQueueEvaluation(qe) {
  if (!isPlainObject(qe)) return false;
  if (!QUEUE_EVALUATION_VERDICTS.includes(qe.verdict)) return false;
  if (!isNonEmptyString(qe.reason)) return false;
  if (!Array.isArray(qe.entries)) return false;
  if (qe.verdict === "START_ALLOWED" && qe.reason !== "OK") return false;
  if (qe.verdict === "START_BLOCKED" && qe.reason === "OK") return false;
  if (qe.verdict === "START_BLOCKED" && qe.entries.length !== 0) return false;
  return true;
}

function isWellFormedEntry(entry) {
  return (
    isPlainObject(entry) &&
    isNonEmptyString(entry.issue_id) &&
    isNonNegativeInteger(entry.ordinal) &&
    isNonEmptyString(entry.approved_merge_commit) &&
    isBoolean(entry.enabled)
  );
}

// enabled===true인 항목 중 ordinal이 가장 작은 것 하나(ORCH §10 확정3).
// entries가 이미 evaluateQueueManifest에서 enabled 필터 + ordinal 오름차순
// 정렬을 거쳤더라도, 이 함수는 그 가정에 기대지 않고 다시 최솟값을 찾는다
// (queueEvaluation은 신뢰 경계 밖에서 온 값일 수 있다).
function selectReadyEntry(entries) {
  let ready = null;
  for (const entry of entries) {
    if (entry.enabled !== true) continue;
    if (ready === null || entry.ordinal < ready.ordinal) ready = entry;
  }
  return ready;
}

// judgeExecutionPlan({queueEvaluation, now}) -> {ok, plan|null, reasonCode, queueReason}
//
// ORCH §10 확정1 -- queue-manifest-core.mjs의 판정을 재사용한다(재구현
// 금지). queueEvaluation은 evaluateQueueManifest(observation) 또는
// collectAndEvaluateQueue(deps)가 반환한 객체 그대로 받는다.
export function judgeExecutionPlan(args) {
  if (!isPlainObject(args)) return invalid();
  const { queueEvaluation, now } = args;
  if (!isFiniteNumber(now)) return invalid();
  if (!isTrustworthyQueueEvaluation(queueEvaluation)) return invalid();

  if (queueEvaluation.verdict !== "START_ALLOWED") {
    return blockedByQueue(queueEvaluation.reason);
  }

  const entries = queueEvaluation.entries;
  if (!entries.every(isWellFormedEntry)) return invalid();

  const ready = selectReadyEntry(entries);
  if (!ready) return noReadyItem(queueEvaluation.reason);

  return {
    ok: true,
    plan: {
      intent: "RUN_ISSUE_CYCLE",
      issueId: ready.issue_id,
      ordinal: ready.ordinal,
      approvedMergeCommit: ready.approved_merge_commit,
      decidedAt: now,
    },
    reasonCode: EXECUTION_REASON.PLAN_READY,
    queueReason: queueEvaluation.reason,
  };
}
