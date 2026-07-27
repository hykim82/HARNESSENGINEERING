// HYK-171 사이클4b-2c (coder-task.md §2-B) -- 배정 결속 좌석 증명
// (dispatch-bound seat proof) 순수 판정.
//
// ★ 증명 범위(§0 비타협, 설계게이트 결선): 이것은 "우리가 이 좌석을
// 만들었다"의 증명이 **아니다**. 증명하는 것은 "Orca가 이 task/dispatch를
// 이 좌석에 배정했고, 그 좌석의 pty/worktree가 이것이다"뿐이다. 이 파일과
// 관련 산출물에 "생성 영수증(creation receipt)"이라는 이름을 쓰지 않는다.
// 기존 `creationResponse`/`recordSeatCreation` 레코드에 끼워넣지 않는다.
//
// 결속점(§1 실측, ORCH가 착수 전 직접 포획): `dispatch-show`의
// `assignee_pane_key`가 `terminal show`의 `${tabId}:${leafId}`
// (paneKeyFromShow)와 문자 완전 일치한다. 이 파일은 그 일치와, 대상
// task/dispatch/worktree가 호출자가 기대한 것과 같은지를 대조할 뿐이다.
//
// 비타협:
// - `policy` 완화 입력을 받지 않는다(`minCorroboration` 류의 안전장치를
//   끄는 매개변수 금지 -- 4b-2b-1 사고 재발 방지).
// - `terminal list` 행을 입력으로 받지 않는다 -- terminalShow는 반드시
//   terminal-show-adapter.mjs의 `normalizeTerminalShow` 출력(ok:true)이어야
//   한다(list 폴백 형태는 그 어댑터에서 이미 거부된다).
// - 시간 비교 판정 0(§1 UTC 함정 -- `dispatched_at`은 로컬 시계와 비교하지
//   않는다. 이 함수는 시각 필드를 아예 읽지 않는다).
// - `expected.*`가 하나라도 결손이면 판정 불가(`UNPROVEN`) -- 기본값으로
//   통과시키지 않는다.
//
// 순수 함수: I/O 없음, `orca` CLI를 실행하지 않는다, 전역 상태를 읽지
// 않는다.

export const SEAT_PROOF = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVEN: "UNPROVEN",
});

export const SEAT_PROOF_REASON = Object.freeze({
  DISPATCH_SHOW_INVALID: "DISPATCH_SHOW_INVALID",
  TERMINAL_SHOW_INVALID: "TERMINAL_SHOW_INVALID",
  EXPECTED_FIELDS_MISSING: "EXPECTED_FIELDS_MISSING",
  PANE_KEY_MISMATCH: "PANE_KEY_MISMATCH",
  HANDLE_MISMATCH: "HANDLE_MISMATCH",
  TASK_ID_MISMATCH: "TASK_ID_MISMATCH",
  DISPATCH_ID_MISMATCH: "DISPATCH_ID_MISMATCH",
  WORKTREE_MISMATCH: "WORKTREE_MISMATCH",
  PROVEN: "PROVEN",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function verdict(kind, reasonCode) {
  return { verdict: kind, reasonCode };
}

// dispatch-correlation-adapter.mjs의 normalizeDispatchShow 출력 계약
// (재사용 -- 그 파일은 수정하지 않는다). assigneeHandle은 그 어댑터에서
// 옵션 필드(§2-A 주석: "handle은 회전한다")이므로, 여기서는 값이 있을 때만
// §4 handle 비교를 수행한다 -- 결손을 기본 통과로 두지 않고, 결손 자체를
// HANDLE_MISMATCH로 접는다(아래 judgeDispatchBoundSeatProof 참조).
function hasValidDispatchShow(ds) {
  return (
    ds.ok === true &&
    isNonEmptyString(ds.taskId) &&
    isNonEmptyString(ds.dispatchId) &&
    isNonEmptyString(ds.assigneePaneKey)
  );
}

// terminal-show-adapter.mjs의 normalizeTerminalShow 출력 계약(ok:true인
// 것만 통과 -- fallback-form/필드결손은 그 어댑터가 이미 거른다).
function hasValidTerminalShow(ts) {
  return (
    ts.ok === true &&
    isNonEmptyString(ts.handle) &&
    isNonEmptyString(ts.paneKeyFromShow) &&
    isNonEmptyString(ts.worktreeId) &&
    isNonEmptyString(ts.worktreePath)
  );
}

// §2-B5: harnessTaskId/runtimeTaskId/dispatchId/worktreeId/worktreePath
// 다섯 필드가 전부 non-empty string이어야 판정 대상이 된다. harnessTaskId는
// dispatchShow/terminalShow 어느 쪽에도 대응 필드가 없다(둘 다 Orca 런타임
// task id만 안다) -- 그래도 호출자가 "이 판정이 어느 하네스 작업에 대한
// 것인지" 명시하도록 강제한다(미제공 시 판정 불가), 단 대조 대상이 없으므로
// 값 자체를 다른 무엇과 비교하지는 않는다.
function hasCompleteExpected(expected) {
  return (
    isNonEmptyString(expected.harnessTaskId) &&
    isNonEmptyString(expected.runtimeTaskId) &&
    isNonEmptyString(expected.dispatchId) &&
    isNonEmptyString(expected.worktreeId) &&
    isNonEmptyString(expected.worktreePath)
  );
}

// §2-B3~6의 exact-match 비교 다섯 개를 표로 선언한다(각 행 = [실패조건,
// 사유코드]). 순서가 판정 우선순위다(첫 실패가 그대로 결과 사유가 된다).
// 이 표 형태는 judgeDispatchBoundSeatProof 자체의 분기 복잡도를 낮추려는
// 것일 뿐 -- 어떤 비교도 생략하거나 완화하지 않는다(비교 다섯 개 전부
// 그대로 남아 있다).
function buildMismatchChecks(ds, ts, exp) {
  return [
    // §1 결속점: assignee_pane_key === `${tabId}:${leafId}` 문자 완전 일치.
    [
      ds.assigneePaneKey !== ts.paneKeyFromShow,
      SEAT_PROOF_REASON.PANE_KEY_MISMATCH,
    ],
    // §2-B4: assigneeHandle 결손(옵션 필드가 안 채워짐)도 handle 불일치와
    // 동일하게 취급한다 -- 기본 통과 금지.
    [
      !isNonEmptyString(ds.assigneeHandle) || ds.assigneeHandle !== ts.handle,
      SEAT_PROOF_REASON.HANDLE_MISMATCH,
    ],
    [exp.runtimeTaskId !== ds.taskId, SEAT_PROOF_REASON.TASK_ID_MISMATCH],
    [exp.dispatchId !== ds.dispatchId, SEAT_PROOF_REASON.DISPATCH_ID_MISMATCH],
    [
      exp.worktreeId !== ts.worktreeId || exp.worktreePath !== ts.worktreePath,
      SEAT_PROOF_REASON.WORKTREE_MISMATCH,
    ],
  ];
}

function findMismatchReason(ds, ts, exp) {
  for (const [failed, reasonCode] of buildMismatchChecks(ds, ts, exp)) {
    if (failed) return reasonCode;
  }
  return null;
}

// judgeDispatchBoundSeatProof({ dispatchShow, terminalShow, expected })
// -> { verdict: PROVEN|UNPROVEN, reasonCode }.
//
// PROVEN은 §2-B1~6 전부가 성립할 때만:
// 1. dispatchShow 정규화 성공
// 2. terminalShow 정규화 성공
// 3. assigneePaneKey === paneKeyFromShow(문자 완전 일치)
// 4. assigneeHandle === terminalShow.handle
// 5. expected.harnessTaskId/runtimeTaskId/dispatchId 전부 제공 및
//    runtimeTaskId/dispatchId는 dispatchShow와 exact 일치
// 6. expected.worktreeId/worktreePath가 terminalShow와 exact 일치
export function judgeDispatchBoundSeatProof({
  dispatchShow,
  terminalShow,
  expected,
} = {}) {
  const ds = isPlainObject(dispatchShow) ? dispatchShow : {};
  const ts = isPlainObject(terminalShow) ? terminalShow : {};
  const exp = isPlainObject(expected) ? expected : {};

  if (!hasValidDispatchShow(ds)) {
    return verdict(
      SEAT_PROOF.UNPROVEN,
      SEAT_PROOF_REASON.DISPATCH_SHOW_INVALID,
    );
  }

  if (!hasValidTerminalShow(ts)) {
    return verdict(
      SEAT_PROOF.UNPROVEN,
      SEAT_PROOF_REASON.TERMINAL_SHOW_INVALID,
    );
  }

  if (!hasCompleteExpected(exp)) {
    return verdict(
      SEAT_PROOF.UNPROVEN,
      SEAT_PROOF_REASON.EXPECTED_FIELDS_MISSING,
    );
  }

  const mismatchReason = findMismatchReason(ds, ts, exp);
  if (mismatchReason) {
    return verdict(SEAT_PROOF.UNPROVEN, mismatchReason);
  }

  return verdict(SEAT_PROOF.PROVEN, SEAT_PROOF_REASON.PROVEN);
}
