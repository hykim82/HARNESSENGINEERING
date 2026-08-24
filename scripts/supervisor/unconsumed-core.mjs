// HYK-185-unconsumed-1 (coder-task.md §1-§2) -- «워커 결과가 갱신됐는데
// 총괄이 소비하지 않았다» 순수 판정 코어.
//
// 배경(coder-task.md §1, 한용 확정): 오늘(2026-08-06) ORCH 정지가 세 번
// 있었고 셋 다 같은 형태였다 -- 워커가 결과 파일을 갱신했는데 ORCH가
// 수십 분~수시간 동안 그것을 집지 않았다. 기존 예약 감시의 무진행 판정은
// «약속(pledge)»을 근거로 하는데, 그 약속은 ORCH가 적어야 생긴다 -- ORCH가
// 멈추면 약속도 안 적힌다. 그래서 **자기 신고에 기대지 않는다**: 이 코어의
// 입력은 오직 «결과 파일이 언제 갱신됐는가»·«그 뒤 소비 흔적이 있는가»·
// «지금 시각»뿐이다. 전부 파일/git으로 관측 가능한 사실이다.
//
// «소비 흔적»의 정의(§2-2, 근거를 여기 적는다 -- 후보 전부를 쓰지 않고
// 골랐다): 이 코어가 인정하는 신호는 정확히 둘뿐이다.
// - TASK_FILE_DROPPED_AFTER: 결과 파일보다 나중에 (같은 워크트리의) 어떤
//   `.harness/*-task.md`가 갱신됐다 -- 다음 라운드가 실제로 드롭됐다는
//   뜻이므로 ORCH가 결과를 읽고 다음 지시를 냈다는 가장 직접적인 흔적.
//   ★오늘 실측 표본(coder-task.md §3, 13:44 계열)이 정확히 이 형태다:
//   `coder.md` 13:19:21 → `review-task.md` 13:50:02(다음 라운드 드롭).
// - NEW_COMMIT_AFTER: 결과 파일보다 나중에 그 저장소에 새 커밋이 생겼다 --
//   ORCH가 결과를 반영해 커밋했다는 흔적. ★오늘 실측 표본(§3, 14:11 계열)이
//   이 형태다: `review.md` 13:54:38 → 커밋 `2bffdcd` 14:13:05(재계산 실측,
//   task 파일의 손으로 적은 "14:0x"는 근사값이었다 -- 이 코어는 그 근사값을
//   쓰지 않고 호출자가 `git show -s --format=%cI`로 다시 잰 값을 받는다).
// 다른 후보(예: ORCH가 "소비했다"고 스스로 적는 기록)는 **의도적으로
// 제외한다** -- 자기 신고를 흔적으로 삼지 말라는 한용 지시(§2-2 비타협)와
// 정면으로 충돌한다.
//
// 이 코어가 증명한다 / 증명하지 않는다 (S11 필수):
// - **관측은 호출자가 준다** -- 이 코어는 파일도 git도 읽지 않는다. 결과
//   파일의 실제 mtime 조회, task 파일 스캔, git 커밋 조회는 이 코어 밖
//   (호출자, orch-stall-detect.mjs)이 한다.
// - **판정할 수 없으면 조용히 "정상"으로 접지 않는다** -- 신호가 구조적으로
//   이상하면(순서 역전·미래 시각·형식 위반) 언제나 `UNDECIDABLE`이다.
//   신호가 없고 임계를 넘지 않았으면(정상적으로 아직 이른 상태) 역시
//   `UNDECIDABLE`이다 -- `CONSUMED`로도 `SUSPECTED_UNCONSUMED`로도 새지
//   않는다.
// - **v1은 판정만 한다** -- 알림·차단·좌석 종료·종료 코드 관여는 이 코어
//   범위 밖이다(호출자도 로그에만 싣는다, watch-run.mjs 참조).
//
// 비타협(dispatch-start-core.mjs와 동일 원칙 재사용):
// - I/O 0 -- import 없음(이 파일 자신이 구조적으로 I/O 표면이 없다).
//   `Date.now()`/`new Date()`(인자 없이) 호출 0 -- 현재 시각은 `now`
//   인자로만 받는다.
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - `verdict`는 항상 `CONSUMED`/`SUSPECTED_UNCONSUMED`/`UNDECIDABLE` 3상태
//   중 하나다.
//
// 기본 임계값 근거(dispatch-start-core.mjs와 동일 형식 "기본값을 둘 거면
// 헤더에 근거를 적어라"): 오늘 실측된 두 사고 구간은 각각 약 30.7분
// (coder.md → review-task.md)과 약 18.5분(review.md → 커밋, 재계산값)
// 미소비였다. `DEFAULT_MIN_UNCONSUMED_SECONDS`(900초=15분)는 그 둘보다
// 짧게 잡아 두 실제 사고 형태를 모두 놓치지 않으면서, 정상적인 검토
// 왕복(결과 → 다음 드롭이 몇 분 안에 일어나는 통상 사례)을 "아직 이름"
// (UNDECIDABLE)으로 흡수한다. 다만 신호(TASK_FILE_DROPPED_AFTER/
// NEW_COMMIT_AFTER)가 하나라도 있으면 임계와 무관하게 즉시 `CONSUMED`다
// -- 정상 소비 구간에서는 경과 시간이 얼마든 발화하지 않는다(오탐 0,
// coder-task.md §5-b).
//
// 어휘 신규 도입 선언: `UNCONSUMED_VERDICT`·`UNCONSUMED_REASON`·
// `UNCONSUMED_SIGNAL_KIND` 전부 이 파일이 새로 만든다.

export const UNCONSUMED_VERDICT = Object.freeze({
  CONSUMED: "CONSUMED",
  SUSPECTED_UNCONSUMED: "SUSPECTED_UNCONSUMED",
  UNDECIDABLE: "UNDECIDABLE",
});

// HYK-340-vanished-unresolved (coder-task.md §3) -- 세 번째 소비 흔적.
// 「마지막 라운드」(결과 파일 갱신 이후 다음 task 파일도, 새 커밋도 아직
// 없는 상태)에서도 소비가 실제로는 이미 끝났을 수 있다 -- 소비
// 핸드셰이크(relay-handshake.mjs) 자신이 성공할 때마다 워크트리 안
// `.harness/receipts/<role>-receipt-r<N>.json`에 영수증을 남기기 때문
// (consumption-receipt-writer.mjs). 그 영수증이 결과 파일보다 새것이면
// 세 번째 소비 흔적으로 인정한다 -- 신뢰 경계 판단(coder-task.md §3 ⓐ/ⓑ)은
// 호출자(orch-stall-detect.mjs)가 지고, 이 코어는 새 kind 하나만 안다.
export const UNCONSUMED_SIGNAL_KIND = Object.freeze({
  TASK_FILE_DROPPED_AFTER: "TASK_FILE_DROPPED_AFTER",
  NEW_COMMIT_AFTER: "NEW_COMMIT_AFTER",
  CONSUMPTION_RECEIPT_AFTER: "CONSUMPTION_RECEIPT_AFTER",
});

export const UNCONSUMED_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  RESULT_FILE_INVALID: "RESULT_FILE_INVALID",
  NOW_INVALID: "NOW_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  RESULT_IN_FUTURE: "RESULT_IN_FUTURE",
  SIGNALS_INVALID: "SIGNALS_INVALID",
  SIGNAL_MALFORMED: "SIGNAL_MALFORMED",
  SIGNAL_BEFORE_RESULT: "SIGNAL_BEFORE_RESULT",
  SIGNAL_IN_FUTURE: "SIGNAL_IN_FUTURE",
  CONSUMED_VIA_TASK_DROP: "CONSUMED_VIA_TASK_DROP",
  CONSUMED_VIA_NEW_COMMIT: "CONSUMED_VIA_NEW_COMMIT",
  CONSUMED_VIA_RECEIPT: "CONSUMED_VIA_RECEIPT",
  NO_SIGNAL_TOO_EARLY: "NO_SIGNAL_TOO_EARLY",
  NO_SIGNAL_PAST_THRESHOLD: "NO_SIGNAL_PAST_THRESHOLD",
});

export const DEFAULT_MIN_UNCONSUMED_SECONDS = 900;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isPositiveFiniteNumber(v) {
  return isFiniteNumber(v) && v > 0;
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: UNCONSUMED_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

function isWellFormedResultFile(resultFile) {
  if (!isPlainObject(resultFile)) return false;
  return isFiniteNumber(resultFile.updatedAtMs);
}

const KNOWN_SIGNAL_KINDS = new Set(Object.values(UNCONSUMED_SIGNAL_KIND));

function isWellFormedSignal(entry) {
  if (!isPlainObject(entry)) return false;
  if (!KNOWN_SIGNAL_KINDS.has(entry.kind)) return false;
  return isFiniteNumber(entry.atMs);
}

// 신호 배열 자체 + 각 항목의 구조·순서·미래시각을 검사한다. 문제가 있으면
// 그 사유 코드를, 전부 온전하면 `null`을 돌려준다(dispatch-start-core.mjs
// firstObservationProblem과 동일 형태 -- 하나라도 어긋나면 전체 판정이
// UNDECIDABLE로 닫힌다, 부분 필터링 없음).
function firstSignalProblem(signals, resultUpdatedAtMs, now) {
  if (!Array.isArray(signals)) {
    return UNCONSUMED_REASON.SIGNALS_INVALID;
  }
  for (const entry of signals) {
    if (!isWellFormedSignal(entry)) {
      return UNCONSUMED_REASON.SIGNAL_MALFORMED;
    }
    if (entry.atMs > now) {
      return UNCONSUMED_REASON.SIGNAL_IN_FUTURE;
    }
    if (entry.atMs <= resultUpdatedAtMs) {
      return UNCONSUMED_REASON.SIGNAL_BEFORE_RESULT;
    }
  }
  return null;
}

const REASON_BY_SIGNAL_KIND = Object.freeze({
  [UNCONSUMED_SIGNAL_KIND.TASK_FILE_DROPPED_AFTER]:
    UNCONSUMED_REASON.CONSUMED_VIA_TASK_DROP,
  [UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER]:
    UNCONSUMED_REASON.CONSUMED_VIA_NEW_COMMIT,
  [UNCONSUMED_SIGNAL_KIND.CONSUMPTION_RECEIPT_AFTER]:
    UNCONSUMED_REASON.CONSUMED_VIA_RECEIPT,
});

// 가장 이른(=가장 먼저 소비를 증명한) 신호를 고른다 -- 여러 신호가 동시에
// 있어도 "언제 처음 소비됐는가"가 details에 남도록.
function earliestSignal(signals) {
  return [...signals].sort((a, b) => a.atMs - b.atMs)[0];
}

// judgeUnconsumed({resultFile, signals, now, thresholds}) ->
// {ok, verdict, reasonCode, details}
//
// - `resultFile.updatedAtMs` = 결과 파일이 갱신된 시각(epoch ms).
// - `signals` = 소비 흔적 후보 배열. 각 항목
//   `{kind: TASK_FILE_DROPPED_AFTER|NEW_COMMIT_AFTER, atMs: epoch ms}`.
//   빈 배열 = 관측된 소비 흔적이 없음(정상 -- 아직 안 왔을 수도, 진짜로
//   없을 수도).
// - `now` = 판정 시각(epoch ms, 인자로만 받는다).
// - `thresholds.minUnconsumedSeconds` = 생략 시
//   `DEFAULT_MIN_UNCONSUMED_SECONDS`.
export function judgeUnconsumed(args) {
  if (!isPlainObject(args)) {
    return undecidable(UNCONSUMED_REASON.ARGS_INVALID);
  }
  const { resultFile, signals, now, thresholds } = args;

  if (!isFiniteNumber(now)) {
    return undecidable(UNCONSUMED_REASON.NOW_INVALID);
  }

  const minUnconsumedSeconds =
    thresholds === undefined || thresholds === null
      ? DEFAULT_MIN_UNCONSUMED_SECONDS
      : thresholds.minUnconsumedSeconds;
  if (!isPositiveFiniteNumber(minUnconsumedSeconds)) {
    return undecidable(UNCONSUMED_REASON.THRESHOLD_INVALID);
  }
  const thresholdMs = minUnconsumedSeconds * 1000;

  if (!isWellFormedResultFile(resultFile)) {
    return undecidable(UNCONSUMED_REASON.RESULT_FILE_INVALID);
  }
  const { updatedAtMs } = resultFile;
  if (updatedAtMs > now) {
    return undecidable(UNCONSUMED_REASON.RESULT_IN_FUTURE);
  }

  const signalProblem = firstSignalProblem(signals, updatedAtMs, now);
  if (signalProblem) return undecidable(signalProblem);

  if (signals.length > 0) {
    const first = earliestSignal(signals);
    return {
      ok: true,
      verdict: UNCONSUMED_VERDICT.CONSUMED,
      reasonCode: REASON_BY_SIGNAL_KIND[first.kind],
      details: { now, minUnconsumedSeconds, consumedAtMs: first.atMs },
    };
  }

  const pastThreshold = now - updatedAtMs > thresholdMs;
  if (!pastThreshold) {
    return undecidable(UNCONSUMED_REASON.NO_SIGNAL_TOO_EARLY);
  }

  return {
    ok: true,
    verdict: UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    reasonCode: UNCONSUMED_REASON.NO_SIGNAL_PAST_THRESHOLD,
    details: { now, minUnconsumedSeconds },
  };
}
