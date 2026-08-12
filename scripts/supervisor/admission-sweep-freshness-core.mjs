// HYK-228 coder-r2 rejection-2 (review-r1.md §B, coder-task-2.md §2 항2) --
// "사이클은 도는데 수거만 죽었다"를 잡는 순수 판정 코어.
//
// 배경(검토자 실측, review-r1.md §B): sweep 원장이 사라져
// `SWEEP_TRIGGER_STATE_UNAVAILABLE`(`ok:false`)가 나도, 같은 watch-run
// 사이클은 정상 완료해 `last-run.json`을 남기므로 기존
// `judgeWatchFreshness`는 `ALIVE`로 남는다 -- `judgeWatchFreshness`는
// `lastRun.recordedAtMs`의 신선도만 보고, "그 사이클 안에서 하위 단계가
// 실패했는가"는 애초에 그 함수의 관심사가 아니다(설계상 옳다 -- 그 함수
// 자체는 이미 검증된 별도 코어).
//
// ★설계 제약(coder-r2 지시 그대로, 반드시 지킨다): `watch-freshness-core.
// mjs`의 계약(`judgeWatchFreshness`의 시그니처·의미)은 손대지 않는다.
// 이 파일은 그 위에 "합성"만 한다 -- 새 코어가 먼저 기존 함수를 그대로
// 부르고, 그 결과가 ALIVE일 때만 추가로 `lastRun.sweep`을 들여다본다.
//
// 판정 순서:
//   1. `judgeWatchFreshness(...)`를 있는 그대로 부른다. STALE/UNKNOWN이면
//      그 값을 그대로 돌려준다(사이클 자체가 죽은 경우는 이미 그 게이트가
//      잡는다 -- 1R에서 이미 시험됨, 이 코어가 새로 증명할 것 없음).
//   2. ALIVE(사이클은 최근에 돌았다)면 `lastRun.sweep`을 본다:
//      - `sweep.ran !== true` (미설정/opt-out, 기존 호출자 대다수) ->
//        ALIVE 그대로(무회귀, sweep을 안 쓰는 호출자는 영향 0).
//      - `sweep.ran === true && sweep.ok === false` -> RED. 이 코어가
//        새로 도입하는 `verdict: "SWEEP_FAILED"`를 돌려준다(기존
//        `WATCH_FRESHNESS_VERDICT.ALIVE`를 재사용하지 않는다 -- "사이클은
//        살아있지만 그 안의 한 단계가 죽었다"는 "전부 정상"과 다른
//        신호이므로, 호출자가 잘못 ALIVE로 오독할 여지를 원천적으로
//        없앤다. `STALE`도 재사용하지 않는다 -- "오래돼서 모른다"와
//        "방금 돌았는데 그 안에서 실패를 봤다"는 원인이 달라 사유 코드가
//        아니라 verdict 자체를 분리하는 편이 소비자가 로그만 보고도
//        구별하기 쉽다는 판단, coder-r2 §2 항2 "네 설계 선택, 근거를
//        대라"에 대한 답).
//      - `sweep.ran === true && sweep.ok === true` (changedCount:0 포함,
//        "조용히 할 일이 없었다") -> ALIVE 그대로. ★새로운 거짓 경보를
//        만들지 않는다(coder-r2 명시 경고) -- ok:true는 sweep 자신이
//        "성공"이라고 이미 선언한 것이므로 이 코어가 다시 의심하지
//        않는다.
//
// I/O 0 -- fs/child_process/네트워크 호출 0(watch-freshness-core.mjs와
// 동일한 비타협). throw로 판정을 대신하지 않는다 -- 인자가 무엇이든
// 예외 없이 `{verdict, reasonCode}`를 반환한다.

import {
  judgeWatchFreshness,
  WATCH_FRESHNESS_VERDICT,
  WATCH_FRESHNESS_REASON,
} from "./watch-freshness-core.mjs";

export const ADMISSION_SWEEP_FRESHNESS_VERDICT = Object.freeze({
  // 기존 세 값을 그대로 재수출한다(패스스루 케이스에서 그대로 쓰인다) --
  // 새 값은 SWEEP_FAILED 하나뿐이다.
  ALIVE: WATCH_FRESHNESS_VERDICT.ALIVE,
  STALE: WATCH_FRESHNESS_VERDICT.STALE,
  UNKNOWN: WATCH_FRESHNESS_VERDICT.UNKNOWN,
  SWEEP_FAILED: "SWEEP_FAILED",
});

export const ADMISSION_SWEEP_FRESHNESS_REASON = Object.freeze({
  // 패스스루 사유(기존 코어가 이미 낸 사유를 그대로 옮긴다).
  ...WATCH_FRESHNESS_REASON,
  // 이 코어가 새로 도입하는 사유 -- "사이클은 최근에 돌았지만, 그 안의
  // sweep 단계 자신이 ok:false를 냈다". 실제 sweep 실패 사유(예:
  // SWEEP_TRIGGER_STATE_UNAVAILABLE)는 별도 필드(underlyingStatus/
  // underlyingReasonCode)로 함께 실어 나른다(로그만 보고도 "무엇이
  // 죽었는지" 알 수 있게, 다른 *-core.mjs의 reasonCode 관례와 동일).
  SWEEP_STEP_FAILED: "SWEEP_STEP_FAILED",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// judgeAdmissionSweepFreshness({lastRun, now, staleAfterSeconds}) ->
// {verdict, reasonCode, underlyingStatus?, underlyingReasonCode?}
export function judgeAdmissionSweepFreshness(args) {
  // watch-freshness-core.mjs와 동일하게, 인자 형식 자체가 이상해도
  // judgeWatchFreshness가 이미 UNKNOWN으로 접는다 -- 여기서 다시
  // 검사하지 않고 그대로 위임한다(중복 로직 0, "판단은 한 곳" 원칙).
  const base = judgeWatchFreshness(args);
  if (base.verdict !== WATCH_FRESHNESS_VERDICT.ALIVE) {
    // STALE/UNKNOWN -- 사이클 자체가 죽었거나 판정 불가. 이미 있는
    // 게이트가 잡는 사건이라 그대로 통과시킨다(1R에서 이미 시험됨).
    return base;
  }
  const lastRun = isPlainObject(args) ? args.lastRun : undefined;
  const sweep = isPlainObject(lastRun) ? lastRun.sweep : undefined;
  if (!isPlainObject(sweep) || sweep.ran !== true) {
    // sweep이 아예 설정 안 됐거나(opt-out) 형식이 이상함 -- 기존
    // 호출자(대다수, sweep을 안 쓰는 watch-run)는 영향 0으로 ALIVE.
    return base;
  }
  if (sweep.ok === false) {
    // RED -- 사이클은 돌았지만 sweep 단계 자신이 실패했다.
    return {
      verdict: ADMISSION_SWEEP_FRESHNESS_VERDICT.SWEEP_FAILED,
      reasonCode: ADMISSION_SWEEP_FRESHNESS_REASON.SWEEP_STEP_FAILED,
      underlyingStatus: sweep.status ?? null,
      underlyingReasonCode: sweep.reasonCode ?? null,
    };
  }
  // sweep.ok === true (changedCount:0 포함) -- "조용히 할 일이 없었다".
  // 새로운 거짓 경보를 만들지 않는다 -- ALIVE 그대로.
  return base;
}
