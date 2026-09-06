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
// - `verdict`는 항상 `CONSUMED`/`SUSPECTED_UNCONSUMED`/`UNDECIDABLE`
//   /`MODIFIED_AFTER_CLOSURE` ★4상태 중 하나다(넷째는 HYK-448이 더했다 --
//   아래 «HYK-448» 절 참조. 3상태였던 문면을 그대로 두면 거짓이 되므로
//   여기서 함께 고친다).
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
//
// ═══════════════════════════════════════════════════════════════════════
// ★HYK-448 (coder-task.md §1): 「영수증이 있는가」에서 「원장이 닫았는가」로
// ═══════════════════════════════════════════════════════════════════════
// 위 «소비 흔적» 셋은 전부 **대리 지표**다 -- 「다음 라운드가 드롭됐다」·
// 「새 커밋이 생겼다」·「소비 영수증 파일이 있다」. 그런데 ORCH-60 이
// 어젯밤(2026-09-06 21:00~03:00) 각성 4회를 건별로 판정한 실측은, 그 대리
// 지표가 **두 가지 형태에서 구조적으로 거짓 경보**를 낸다는 것이었다:
//
//   형태 A(상시) -- 중단으로 끝난 라운드. 그 종결 경로는 **설계상 소비
//     영수증을 남기지 않는다**(중단 기록 aborts/<ROLE>-abort-r<N>.json만
//     남긴다). 다음 드롭도 새 커밋도 없이 워크트리가 보존되므로 세 신호가
//     전부 영원히 0이다 ⇒ **매 주기 발화**. ★「영수증 없음」은
//     「미소비」가 아니다 -- 이것이 이 라운드가 고치는 결함의 핵심 문장이다.
//   형태 B(진행 중) -- 라운드가 **아직 안 끝났다**. 결과 파일은 갱신되는데
//     세 소비 흔적은 **원리적으로 아직 있을 수 없다**(소비할 결과가 아직
//     없으므로) ⇒ 임계를 넘기면 발화. ★판별기가 지금 「종료 표지가 있는가」
//     를 아예 안 보기 때문에 이 형태가 갈리지 않았다.
//
// ⇒ 이 라운드는 판정 근거를 대리 지표에서 ★**원장 종결 상태**로 옮긴다.
//   원장(admission-ledger-core.mjs completeReservation)은 라운드를 닫을 때
//   `status:"COMPLETED"` + `completed_at` + (선택)`completion_reason`을
//   적는다 -- 중단 종결도 `BLOCKED_TERMINATION_RELEASED`로 **닫힌 것으로
//   기록된다**. 즉 원장은 영수증 파일이 답하지 못하는 질문에 답한다.
//
// ⛔★그런데 「원장이 닫았으면 침묵」으로 **단순 번역하면 안 된다** -- 같은
// 실측의 네 번째 발화가 **진짜**였고, 그 라운드는 ★**원장에서 닫힌
// 상태**였다(§1-4). 형태:
//   라운드가 정상 소비된 뒤(영수증 r10, 관측 로그 consumed:true), 워커가
//   그 **이미 소비된 결과 파일을 다시 고쳤다**(DONE 줄 뒤 절 추가 + 그 위의
//   head_commit 표지 변경). 각성이 그것을 물어온 덕분에 ORCH 가 「소비 후
//   편집」과 새 커밋을 처음 알았다.
//
// ★그래서 이 파일은 「닫혔다」를 **두 경우로 가른다** -- 가르는 기준은
//   ⓐ원장이 닫은 시각(`closedAtMs`)과 ⓑ결과 파일이 갱신된 시각의 **순서**다:
//
//   결과 파일 ≤ 닫힌 시각  ⇒ 정상. 원장이 그 결과를 보고 닫은 것이다.
//                            `CONSUMED`(CONSUMED_VIA_LEDGER_CLOSURE) = 침묵.
//                            **형태 A 가 여기서 조용해진다.**
//   결과 파일 >  닫힌 시각  ⇒ ★**닫힌 뒤에 결과가 바뀌었다.** 이것은
//                            「미소비」가 아니라 **다른 축**이므로 이름도
//                            다르게 준다: `MODIFIED_AFTER_CLOSURE`.
//                            **진짜 1건이 여기서 살아남는다.**
//
// ⇒ ★설계 선택(§1-4 답): **살린다. 단 「미소비」와 같은 이름으로 살리지
//   않는다.** 두 사실은 사람이 취할 조치가 다르다 -- 미소비는 「ORCH 가
//   멈췄나」이고, 종결 후 변경은 「이미 확정된 기록이 흔들렸다」다. 한
//   이름으로 묶으면 조치가 섞이고, 다른 이름으로 가르면 형태 A 를 침묵시켜도
//   진짜 1건은 그대로 발화한다. **버리지 않았으므로 「무엇을 잃는지」는
//   손실이 아니라 «남는 한계»로 coder.md 에 적는다.**
//
// 형태 B 는 세 번째 입력으로 가른다: `resultFile.terminalMarkerCount`
//   (종료 표지 개수). **0이면 그 라운드는 아직 끝나지 않았다** -- 끝나지
//   않은 라운드에는 소비할 결과 자체가 없으므로 「소비되지 않았다」고 말할
//   수 없다 ⇒ `UNDECIDABLE`(ROUND_NOT_FINISHED). ★이 파일의 기존 원칙
//   그대로 «판정할 수 없으면 조용히 정상으로도, 의심으로도 새지 않는다».
//
// ⚠️★**셋 다 «선택적 입력»이다** -- `roundClosure`/`terminalMarkerCount`를
//   안 넘기는 호출자는 **이 라운드 전과 바이트 단위로 같은 판정**을 받는다
//   (형태 A/B 가 계속 발화한다). 원장을 못 읽는 실 운용에서도 마찬가지다
//   ⇒ **모르면 침묵이 아니라 종전대로 발화**(안전측 기본값: 이 수리가
//   「원장을 못 읽었으니 조용히 넘어간다」로 새면 진짜 미소비를 잃는다).
// ═══════════════════════════════════════════════════════════════════════

export const UNCONSUMED_VERDICT = Object.freeze({
  CONSUMED: "CONSUMED",
  SUSPECTED_UNCONSUMED: "SUSPECTED_UNCONSUMED",
  UNDECIDABLE: "UNDECIDABLE",
  // ★HYK-448: 넷째 상태. 위 헤더 참조 -- 「미소비」가 아니라 「종결 후 결과
  // 파일 변경」이다. ⚠️이 파일 헤더의 «v1은 3상태» 문면(위 "비타협" 절)은
  // 이 상태 추가로 갱신됐다 -- 그 문장을 그대로 두면 거짓이 되므로 여기
  // 명시한다.
  MODIFIED_AFTER_CLOSURE: "MODIFIED_AFTER_CLOSURE",
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
  // ★HYK-448 (헤더 참조). 앞의 둘은 «침묵» 쪽, 셋째는 «발화» 쪽이다.
  CONSUMED_VIA_LEDGER_CLOSURE: "CONSUMED_VIA_LEDGER_CLOSURE",
  ROUND_NOT_FINISHED: "ROUND_NOT_FINISHED",
  RESULT_EDITED_AFTER_CLOSURE: "RESULT_EDITED_AFTER_CLOSURE",
  // 넘어온 종결 정보 자체가 형식 위반이면 조용히 무시하지 않는다 -- 무시하면
  // 「원장이 이상한데 아무 일 없었던 것처럼」 판정이 나간다(이 파일의 기존
  // SIGNAL_MALFORMED와 동일 취급).
  CLOSURE_MALFORMED: "CLOSURE_MALFORMED",
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

// ★HYK-448: 종료 표지 개수는 «선택적»이다 -- 안 넘기면(undefined/null)
// 「모른다」이고, 모르면 형태 B 판정을 하지 않는다(종전 동작 유지). 넘겼다면
// 0 이상의 정수여야 한다.
function isWellFormedTerminalMarkerCount(v) {
  if (v === undefined || v === null) return true;
  return isFiniteNumber(v) && v >= 0 && Number.isInteger(v);
}

// ★HYK-448: 원장 종결 정보도 «선택적»이다. 넘겼다면 다음 계약을 지켜야 한다.
//   `closed`      -- boolean(필수).
//   `closedAtMs`  -- `closed:true`면 유한수(필수). closed:false면 무시한다.
//   `completionReason` -- 문자열 또는 null/undefined(선택, 판정에 쓰지 않고
//     details 에 그대로 실어 사람이 「왜 닫혔는지」를 보게만 한다). ⛔특정
//     reason 값을 «허용 목록»으로 검사하지 않는다 -- 그렇게 하면 원장이 새
//     종결 사유를 도입할 때마다 이 파일이 조용히 오작동한다. 이 축이 묻는
//     것은 «닫혔는가»와 «언제 닫혔는가» 둘뿐이다.
function isWellFormedRoundClosure(closure) {
  if (!isPlainObject(closure)) return false;
  if (typeof closure.closed !== "boolean") return false;
  if (closure.closed && !isFiniteNumber(closure.closedAtMs)) return false;
  const { completionReason } = closure;
  if (
    completionReason !== undefined &&
    completionReason !== null &&
    typeof completionReason !== "string"
  ) {
    return false;
  }
  return true;
}

// 임계값 기본값 적용(원문 그대로 -- 위 판정 함수의 eslint complexity 상한을
// 지키려고 뽑아낸 것이지 규칙이 바뀐 것은 아니다).
function resolveMinUnconsumedSeconds(thresholds) {
  return thresholds === undefined || thresholds === null
    ? DEFAULT_MIN_UNCONSUMED_SECONDS
    : thresholds.minUnconsumedSeconds;
}

// 소비 흔적이 하나라도 있으면 즉시 CONSUMED -- 가장 이른 신호가 «언제 처음
// 소비됐는가»로 details에 남는다(원문 그대로, 위와 동일 사유로 분리).
function consumedBySignal(signals, base) {
  const first = earliestSignal(signals);
  return {
    ok: true,
    verdict: UNCONSUMED_VERDICT.CONSUMED,
    reasonCode: REASON_BY_SIGNAL_KIND[first.kind],
    details: { ...base, consumedAtMs: first.atMs },
  };
}

// ★HYK-448: 새로 더한 «선택적» 입력 둘의 형식 문제를 사유 코드 하나로
// 환원한다(온전하면 `null`). 둘 다 없는 것은 문제가 아니다 -- 이 라운드
// 전의 호출자가 정확히 그 모양이고, 그들에게는 종전 판정이 그대로 나가야
// 한다.
function firstNewInputProblem(resultFile, roundClosure) {
  if (!isWellFormedTerminalMarkerCount(resultFile.terminalMarkerCount)) {
    return UNCONSUMED_REASON.RESULT_FILE_INVALID;
  }
  if (
    roundClosure !== undefined &&
    roundClosure !== null &&
    !isWellFormedRoundClosure(roundClosure)
  ) {
    return UNCONSUMED_REASON.CLOSURE_MALFORMED;
  }
  return null;
}

// 신호가 하나도 없고 임계를 넘긴 상태 -- 이 라운드 전에는 여기가 무조건
// SUSPECTED_UNCONSUMED 였다. HYK-448 은 ★이 자리에서만★ 갈래를 넓힌다.
// ⛔다른 어떤 경로도 건드리지 않는다: 신호가 있으면 여전히 즉시 CONSUMED
// 이고, 임계 이내면 여전히 NO_SIGNAL_TOO_EARLY 다(회귀 0의 구조적 근거).
function judgeWithoutSignalsPastThreshold({
  updatedAtMs,
  now,
  minUnconsumedSeconds,
  roundClosure,
  terminalMarkerCount,
}) {
  const base = { now, minUnconsumedSeconds };

  // ⑴ 원장이 닫았다고 말하는 경우 -- «언제» 닫혔는지로 두 사실을 가른다.
  if (roundClosure && roundClosure.closed) {
    const { closedAtMs, completionReason = null } = roundClosure;
    if (updatedAtMs > closedAtMs) {
      // ★진짜 1건(§1-4)이 정확히 이 모양이다. 「미소비」가 아니라 「종결
      // 뒤에 결과가 바뀌었다」 -- 이름을 다르게 주어 살린다.
      return {
        ok: true,
        verdict: UNCONSUMED_VERDICT.MODIFIED_AFTER_CLOSURE,
        reasonCode: UNCONSUMED_REASON.RESULT_EDITED_AFTER_CLOSURE,
        details: {
          ...base,
          closedAtMs,
          completionReason,
          editedAfterClosureMs: updatedAtMs - closedAtMs,
        },
      };
    }
    // 원장이 그 결과를 보고 닫았다 -- 영수증 파일이 있든 없든 소비는 끝났다.
    // ★형태 A(중단 종결)가 여기서 조용해진다.
    return {
      ok: true,
      verdict: UNCONSUMED_VERDICT.CONSUMED,
      reasonCode: UNCONSUMED_REASON.CONSUMED_VIA_LEDGER_CLOSURE,
      details: { ...base, consumedAtMs: closedAtMs, completionReason },
    };
  }

  // ⑵ 아직 안 끝난 라운드 -- 종료 표지가 0개다. 소비할 결과가 아직 없으므로
  // 「소비되지 않았다」고 말할 수 없다(형태 B).
  if (terminalMarkerCount === 0) {
    return undecidable(UNCONSUMED_REASON.ROUND_NOT_FINISHED);
  }

  // ⑶ 그 밖은 전부 종전 그대로 -- ★진짜 미소비는 여전히 발화한다.
  return {
    ok: true,
    verdict: UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED,
    reasonCode: UNCONSUMED_REASON.NO_SIGNAL_PAST_THRESHOLD,
    details: base,
  };
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
// ★HYK-448이 더한 «선택적» 입력 둘(생략하면 이 라운드 전과 동일 판정):
// - `resultFile.terminalMarkerCount` = 결과 파일의 종료 표지 개수. `0`이면
//   라운드가 아직 안 끝났다는 뜻(형태 B). 생략/`null`이면 「모른다」.
// - `roundClosure` = 원장이 말하는 이 라운드의 종결 상태
//   `{closed: boolean, closedAtMs?: number, completionReason?: string|null}`.
//   생략/`null`이면 「모른다」 -- ⛔모르면 종전대로 발화한다(침묵 아님).
export function judgeUnconsumed(args) {
  if (!isPlainObject(args)) {
    return undecidable(UNCONSUMED_REASON.ARGS_INVALID);
  }
  const { resultFile, signals, now, thresholds, roundClosure } = args;

  if (!isFiniteNumber(now)) {
    return undecidable(UNCONSUMED_REASON.NOW_INVALID);
  }

  const minUnconsumedSeconds = resolveMinUnconsumedSeconds(thresholds);
  if (!isPositiveFiniteNumber(minUnconsumedSeconds)) {
    return undecidable(UNCONSUMED_REASON.THRESHOLD_INVALID);
  }
  const thresholdMs = minUnconsumedSeconds * 1000;

  if (!isWellFormedResultFile(resultFile)) {
    return undecidable(UNCONSUMED_REASON.RESULT_FILE_INVALID);
  }
  // ★HYK-448: 새 입력 둘의 형식 검사(위 firstSignalProblem과 동일 형태로
  // 뽑아 둔다 -- 이 함수의 eslint complexity 상한(12)을 지키기 위해서이기도
  // 하고, 「형식 문제는 한 곳에서 사유 코드로 환원한다」는 이 파일의 기존
  // 관용구와도 맞다).
  const newInputProblem = firstNewInputProblem(resultFile, roundClosure);
  if (newInputProblem) return undecidable(newInputProblem);
  const { updatedAtMs } = resultFile;
  if (updatedAtMs > now) {
    return undecidable(UNCONSUMED_REASON.RESULT_IN_FUTURE);
  }

  const signalProblem = firstSignalProblem(signals, updatedAtMs, now);
  if (signalProblem) return undecidable(signalProblem);

  if (signals.length > 0) {
    return consumedBySignal(signals, { now, minUnconsumedSeconds });
  }

  const pastThreshold = now - updatedAtMs > thresholdMs;
  if (!pastThreshold) {
    return undecidable(UNCONSUMED_REASON.NO_SIGNAL_TOO_EARLY);
  }

  return judgeWithoutSignalsPastThreshold({
    updatedAtMs,
    now,
    minUnconsumedSeconds,
    roundClosure,
    terminalMarkerCount: resultFile.terminalMarkerCount,
  });
}
