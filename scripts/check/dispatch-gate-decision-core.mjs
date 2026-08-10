// HYK-217-dispatch-gate-1/2R (coder-task.md) -- «배달 도구가 스스로 게이트를
// 확인하고, 불통과면 배달을 거부한다」의 판단(코어).
//
// 실사고(1R coder-task.md §0): 연속 반려 진단 게이트가 exit 2(불통과)를
// 냈는데 배달 도구(관제실 `dispatch-worker.ps1`, CI 없음)가 게이트 검사와
// 배달을 한 명령에 묶어 실행해 불통과인데도 배달이 나갔다. 방어는 "ORCH가
// 검사 결과를 보고 나서 배달한다"는 사람의 약속뿐이었다 -- 기계 앵커가
// 0이었다. 이 모듈은 그 앵커다: `reject-streak.mjs gate|diagnostic-gate`의
// 종료코드 + 배달 도구 자신이 미리 확인한 전제조건(2R §2)을 받아 배달
// 허용/거부를 판정하는 순수 함수. I/O, 자식 프로세스 실행, 다른 모듈 참조
// 0(dispatch-postcheck-core.mjs와 동일 계약) -- 호출부
// (dispatch-gate-decision.mjs)가 실제로 게이트를 실행/파일을 읽어 얻은 값만
// 구조화된 형태로 넘긴다.
//
// ★S11 헤더 3항(2R §4-1 지적 대응):
// ①**주장 범위**: 이 모듈이 증명하는 것은 "주어진 exitCode/전제조건 사실을
//   ALLOW/REJECT로 정확히 매핑한다"는 판정 로직 하나뿐이다. `reject-streak.mjs`
//   자신의 판정(무엇이 BLOCK/PASS인지)이 옳은지는 이 모듈의 증명 범위 밖 --
//   그 로직은 이 트랙이 건드리지 않는다(2R §1/§6). 또한 이 모듈이 실제로
//   *호출됐는지*는 이 파일 밖(dispatch-gate-decision.mjs의 CLI 배선,
//   그리고 그걸 부르는 배달 도구 자신)의 책임이다 -- gap#96이 이미 기록한
//   대로, 호출되지 않으면 이 판정은 아예 일어나지 않는다.
// ②**표본 수와 조건**: 아래 decideFromGateExit/checkGatePreconditions 각각의
//   유닛 시험 + dispatch-gate-decision.test.mjs의 CLI 종단 시험 참조(2R §4-2
//   대조군 표: 정상 오탐 0/N, 거부-기대 표본 별도 M건, N·M과 각 조건
//   .harness/coder.md에 병기). 이 헤더 자체는 표를 반복하지 않는다 --
//   근거가 코드 밖(결과 파일)에서 갱신될 때 이 헤더가 거짓이 되는 것을
//   막기 위해서다.
// ③**이 검사가 통과해도 여전히 열려 있는 구멍**(정직 한계, "보장하지
//   않는 것: 없음"으로 도망가지 않는다): (a) `reject-streak.mjs`를 거치지
//   않는 직접 `orca dispatch --inject` 호출은 이 모듈 자체가 관측조차
//   못한다(gap#96). (b) 이 모듈이 fail-closed로 막는 전제조건은 "task_id
//   해석 불가/원장 부재·손상" 네 가지뿐이다 -- `reject-streak.mjs`가
//   내부적으로 UNJUDGABLE로 접는 다른 입력 형태(예: 이 네 가지 밖의 새로운
//   파싱 실패 유형)가 미래에 추가되면, 그 새 유형은 이 모듈의 전제조건
//   검사가 모르는 형태라 다시 열릴 수 있다 -- 이 코어는 `reject-streak.mjs`
//   내부 파싱 로직과 독립적으로 유지보수되므로 드리프트 위험이 있다.
//   (c) 원장 파일 부재를 거부로 처리하는 선택(2R §2)은 `reject-streak.mjs`
//   자신의 계약(원장 없음=streak 0, 정상)보다 엄격하다 -- 그 자체가
//   전이 비용이다(아래 checkGatePreconditions 헤더 참조).
//
// §2 실측 계약(1R coder-task.md): `reject-streak.mjs gate|diagnostic-gate`의
// 종료코드는 세 가지뿐이다 -- 0(통과)/2(차단)/1(운영 오류, 실측된 유일한
// 발생원은 "task file not found"). 이 세 값 밖(예: 시그널로 죽어 exitCode가
// null인 경우)도 실제로 벌어질 수 있으므로 네 번째 상태로 명시한다.
//
// §2 요구된 판단(운영 오류를 어떻게 다룰 것인가):
// - "조회 실패 = 신호 없음 = 정상"으로 접지 않는다 -- exit 1은 ALLOW로 가지
//   않는다(그러면 이 트랙이 막으려는 침묵을 스스로 재생산한다).
// - "운영 오류 = 차단"으로 단순 뭉뚱그리면 거짓 경보가 된다는 경고도
//   있었으나, 이 게이트는 *배달을 막을지 말지*를 결정하는 사전 게이트다
//   (HYK-212 postcheck처럼 이미 벌어진 일을 사후 관찰하는 게 아니다 --
//   배달은 되돌릴 수 없다). "판정할 수 없다"를 "허용"으로 처리하면 원본
//   사고가 막으려던 바로 그 실패모드(불통과인데 배달됨)를 정확히
//   재현하므로, 안전측(fail-closed)이 유일하게 방어 가능한 기본값이다.
//   대신 거짓 경보 우려는 (a) REJECT_BLOCKED와 다른 상태 코드로 구분해
//   "내용이 나빠서"가 아니라 "판정 자체가 안 됐다"는 것을 사람이 즉시
//   구분하게 하고, (b) 이유 문자열에 원인(대개 task-path 오배선)과 조치를
//   함께 실어 오탐이 방치되지 않게 한다 -- 로 완화한다(코드 4-51-4).
export const DISPATCH_GATE_STATE = Object.freeze({
  ALLOW: "ALLOW",
  REJECT_BLOCKED: "REJECT_BLOCKED",
  REJECT_OPERATIONAL_ERROR: "REJECT_OPERATIONAL_ERROR",
  REJECT_UNKNOWN_EXIT: "REJECT_UNKNOWN_EXIT",
  REJECT_TASK_ID_MISSING: "REJECT_TASK_ID_MISSING",
  REJECT_TASK_ID_MALFORMED: "REJECT_TASK_ID_MALFORMED",
  REJECT_LEDGER_MISSING: "REJECT_LEDGER_MISSING",
  REJECT_LEDGER_CORRUPT: "REJECT_LEDGER_CORRUPT",
});

function firstNonEmpty(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "(no output)";
}

// The one function this module exists to provide. Never throws, never
// returns a silent-allow state without a human-readable `reason` (coder-task
// §5-2 비타협: 허용이면 그 이유가 사람이 읽는 한 줄로 출력돼야 한다).
export function decideFromGateExit({ exitCode, stdout, stderr, label } = {}) {
  const tag = typeof label === "string" && label ? label : "dispatch gate";

  if (exitCode === 0) {
    return {
      state: DISPATCH_GATE_STATE.ALLOW,
      allow: true,
      reason: `${tag}: PASS(exit 0) -> 배달 허용 -- ${firstNonEmpty(stdout, stderr)}`,
    };
  }

  if (exitCode === 2) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_BLOCKED,
      allow: false,
      reason: `${tag}: BLOCK(exit 2) -> 배달 거부 -- ${firstNonEmpty(stderr, stdout)}`,
    };
  }

  if (exitCode === 1) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_OPERATIONAL_ERROR,
      allow: false,
      reason: `${tag}: 운영 오류(exit 1, 판정 불가) -> 배달 거부(안전측 기본값) -- 원인: ${firstNonEmpty(stderr, stdout)} -- 조치: task-path/ledger 배선을 확인하고 재시도하라`,
    };
  }

  return {
    state: DISPATCH_GATE_STATE.REJECT_UNKNOWN_EXIT,
    allow: false,
    reason: `${tag}: 알 수 없는 종료코드(${String(exitCode)}, 닫힌 상태 집합 {0,1,2} 밖) -> 배달 거부(안전측 기본값) -- stdout: ${firstNonEmpty(stdout)} / stderr: ${firstNonEmpty(stderr)}`,
  };
}

// 2R §2 (P1-B): fail-closed precondition check the CLI runs BEFORE ever
// spawning `reject-streak.mjs gate|diagnostic-gate` -- the sub-gate itself
// treats an unresolvable task_id or an unreadable ledger as UNJUDGABLE +
// fail-open (checkGate/checkDiagnosticGate/loadLedger, all left untouched
// per 2R §1/§6). Deleting the task_id line, or making the id malformed,
// made the sub-gate shrug and PASS -- exactly the bypass the reviewer
// demonstrated live (검토 원문, .harness/coder.md §P1-B). Since the sub-gate
// itself cannot change, this module blocks upstream of it instead, using
// only STRUCTURAL facts the caller already extracted (a regex match on the
// task file's OWN task_id line, and reject-streak.mjs's own loadLedger()
// boolean `.ok`/`.existed` fields) -- never by grepping the sub-gate's
// human-readable stdout/stderr for a word like "UNJUDGABLE" (2R §2
// 비타협 2, 상시 기준 S8: 식별 근거는 화면 문자열이 아니라 안정 식별자).
//
// Returns null when every precondition passes (caller should proceed to
// the real gate calls); returns a decision object (same {state, allow,
// reason} shape as decideFromGateExit) the moment the FIRST precondition
// fails -- checked in this fixed order so ⓐ/ⓑ/ⓒ/ⓓ never produce the same
// reason string for different root causes (2R §2 요구: "각각 거부될 때
// 사람이 읽는 사유가 서로 구별돼야 한다").
//
// Choosing REJECT_LEDGER_MISSING (not PASS) when the ledger file simply
// does not exist is STRICTER than reject-streak.mjs's own contract (there,
// "no ledger yet" == every issue at streak 0, a normal first-run state).
// This is a deliberate transition cost, not an oversight: a pre-delivery
// safety gate that cannot read the streak memory at all cannot distinguish
// "this repo has never had a rejection" from "something deleted the memory
// that would have required an envelope" -- and the latter is exactly the
// silent-bypass shape this whole track exists to close. In production this
// repo's own `.harness/reject-streak.json` already exists (git-tracked
// history proves at least one prior rejection), so this stricter stance
// costs nothing here; a brand-new repo with zero rejection history would
// need to seed an empty ledger once (see .harness/coder.md §3 전이 비용).
export function checkGatePreconditions({
  hasTaskIdLine,
  taskIdIssueFormatValid,
  ledgerExists,
  ledgerLoadOk,
  ledgerLoadReason,
} = {}) {
  if (!hasTaskIdLine) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_TASK_ID_MISSING,
      allow: false,
      reason:
        "dispatch-gate-decision precondition: task_id 헤더 없음 -> 배달 거부(안전측 기본값 -- reject-streak.mjs는 이 경우를 UNJUDGABLE/fail-open으로 접지만 사전 게이트가 그 앞에서 막는다). 조치: task 파일 첫 블록에 'task_id: HYK-<n>...' 줄을 추가하라",
    };
  }
  if (!taskIdIssueFormatValid) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_TASK_ID_MALFORMED,
      allow: false,
      reason:
        "dispatch-gate-decision precondition: task_id 값이 'HYK-<digits>' 형식으로 해석되지 않음 -> 배달 거부(안전측 기본값). 조치: task_id 값을 'HYK-<숫자>...' 형식으로 고쳐라",
    };
  }
  if (!ledgerExists) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_MISSING,
      allow: false,
      reason:
        "dispatch-gate-decision precondition: reject-streak 원장 파일이 존재하지 않음 -> 배달 거부(안전측 기본값 -- reject-streak.mjs 자신은 원장 부재를 streak=0으로 허용하지만 이 사전 게이트는 더 엄격하다: 원장이 사라지면 모든 이슈의 반려 이력 기억도 함께 사라져 envelope 요구가 조용히 무력화될 수 있다). 조치: 원장 경로(--ledger 또는 기본 .harness/reject-streak.json)를 확인하라",
    };
  }
  if (!ledgerLoadOk) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_CORRUPT,
      allow: false,
      reason: `dispatch-gate-decision precondition: reject-streak 원장을 읽거나 파싱할 수 없음 -> 배달 거부(안전측 기본값) -- 원인: ${ledgerLoadReason ?? "(no detail)"}. 조치: 원장 파일을 복구하거나 백업에서 되살린 뒤 재시도하라`,
    };
  }
  return null;
}

// Combines N independent gate decisions (e.g. `gate` + `diagnostic-gate`,
// which coder-task.md §2 confirms are independent and both apply) into one
// delivery verdict: ALLOW only if every decision ALLOWs. Reject reasons are
// never dropped -- every non-allow decision's reason is preserved in
// `reasons` so a human reading the CLI output sees exactly which gate(s)
// blocked and why, not just an aggregate boolean.
export function combineGateDecisions(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const allow = list.length > 0 && list.every((d) => d?.allow === true);
  return {
    allow,
    reasons: list.map((d) => d?.reason ?? "(missing decision)"),
    states: list.map((d) => d?.state ?? null),
  };
}
