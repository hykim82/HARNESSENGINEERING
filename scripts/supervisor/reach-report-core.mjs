// HYK-191-reach-1 (coder-task.md) -- 예약 감시 4축(watch-run.mjs가 이미
// 만드는 watch.log)이 "이미 잡는" 신호를 사람이 읽을 수 있는 보고문으로
// 바꾸는 순수 코어. I/O는 0(파일 읽기·쓰기는 이 파일을 부르는 wire쪽,
// reach-report.mjs가 한다) -- watch-freshness-core.mjs/orch-progress-
// core.mjs와 같은 "코어는 순수, 수집/출력은 wire" 원칙을 재사용한다.
//
// ★새 감지 축 금지(coder-task.md §3, HYK-191): 이 파일은 seat-liveness/
// seat-idle/dispatch-start/unconsumed 네 축이 이미 내놓은 verdict/status
// 문자열을 "열려 있는 이상인가"로 분류할 뿐, 그 네 축의 판정 로직 자체를
// 재구현하지 않는다 -- watch.log 한 줄(buildLogLine, watch-run.mjs)의
// 문자열 형식만 파싱한다. ★HYK-198-capwire-2(한용 20:12 확정 «가»)로
// 이 원칙에 **딱 한 항목**의 예외가 생겼다: `cap` 축(watch-run.mjs의
// `cap_*` 필드, HYK-198-capwire-1이 이미 관측만 하고 있던 것)을 이
// AXES에 편입한다 -- 이것도 "새 감지 축"이 아니라 watch-run.mjs가 이미
// 내놓은 `cap_status`/`cap_verdict` 문자열을 그대로 분류할 뿐이다(같은
// 원칙의 다섯 번째 적용).
// ★HYK-173-push-wire(coder-task.md §4 요건3, §5-F "주장-구현 일치")로
// **두 번째** 예외가 생겼다: `escalation` 축(watch-run.mjs의
// `escalation_*` 필드, orch-stall-detect.mjs의 judgeEscalationForRepo가
// escalation-state.mjs의 reduceCoordinatorState/shouldWakeHuman을 실호출해
// 만든 것)을 AXES에 편입한다. ★이 항목은 cap과 이유가 다르다 -- cap은
// "이미 관측만 하던 것을 편입"이었지만, escalation은 §4 요건3 자체가
// 강제한다: `AXES`는 닫힌 배열이고 여기 등록된 축의 verdict/status만
// "열린 이상"으로 분류돼 받는함(reach-notify-*.md)에 도달한다 -- 로그
// 필드만 추가하고 여기 등록하지 않으면 "로그에만 적히고 사람이 못 보는
// 것"(1-B가 금지하는 실패 형태)이 된다. 이 예외 밖의 새 축 추가는
// 여전히 금지다(escalation-axis-wire.test.mjs가 이 두 예외 밖의 세 번째
// 항목이 조용히 늘어나지 않음을 고정한다).
//
// 왜 "지금 열려 있는 이상"이 사람이 직접 읽는 값 위에 있어야 하는가
// (coder-task.md §4, 실측): 2026-08-05 05:06 ~ 08-06 22:36 KST 사이
// 좌석 방치 경보가 104회·약 41.5시간 울렸다. 신호는 그 41.5시간 내내
// **같은 값**이었으므로 "전이"는 맨 처음 1번뿐이었다 -- 그 1번을 놓치면
// 41시간 침묵한다. 그래서 이 파일은 매번 전체 로그를 다시 훑어 "지금도
// 여전히 열려 있다면 언제부터인지"를 매번 처음부터 다시 계산한다(전이
// 통지 1건에 기대지 않는다).

// HYK-173-push-wire (coder-task.md §4 요건3) -- escalation 축의 badVerdicts
// 재료는 escalation-state.mjs가 정본으로 갖고 있는 상태 이름을 그대로
// 쓴다(재구현 금지 -- 이 파일이 "wake" 문자열을 새로 만들지 않는다).
import { COORD_STATE, HUMAN_WAKE_STATES } from "../relay/escalation-state.mjs";

// ---- 축 정의 ----
// prefix: watch.log 한 줄의 필드 접두사(watch-run.mjs의 axisLogSegment와
// 동일한 이름 -- seat_/idle_/start_/unconsumed_).
// badVerdicts: 이 axis의 verdict 필드가 이 값이면 "열려 있는 이상"이다.
// badStatuses: verdict 필드와 별개로, status 자체가 "관측 수집 실패"류면
// 그것도 이상이다(§2-3 "판정 불가를 조용함으로 접지 않는다"의 확장 --
// 사람에게도 "관측이 실패하고 있다"는 알려야 한다).
export const AXES = Object.freeze([
  Object.freeze({
    key: "seat",
    prefix: "seat",
    label: "좌석 무응답",
    badVerdicts: Object.freeze(["SUSPECTED_UNRESPONSIVE"]),
    badStatuses: Object.freeze([
      "SEAT_LIVENESS_COLLECTION_FAILED",
      "SEAT_LIVENESS_SCAN_WORKTREE_LIST_FAILED",
      "SEAT_LIVENESS_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  Object.freeze({
    key: "idle",
    prefix: "idle",
    label: "좌석 유휴 방치",
    badVerdicts: Object.freeze(["SUSPECTED_ABANDONED"]),
    badStatuses: Object.freeze([
      "SEAT_IDLE_COLLECTION_FAILED",
      "SEAT_IDLE_SCAN_WORKTREE_LIST_FAILED",
      "SEAT_IDLE_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  Object.freeze({
    key: "start",
    prefix: "start",
    label: "배달 후 미착수",
    badVerdicts: Object.freeze(["NOT_STARTED"]),
    badStatuses: Object.freeze([
      "DISPATCH_START_COLLECTION_FAILED",
      "DISPATCH_START_SCAN_WORKTREE_LIST_FAILED",
      "DISPATCH_START_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  Object.freeze({
    key: "unconsumed",
    prefix: "unconsumed",
    label: "워커 결과 미소비",
    badVerdicts: Object.freeze(["SUSPECTED_UNCONSUMED"]),
    badStatuses: Object.freeze([
      "UNCONSUMED_COLLECTION_FAILED",
      "UNCONSUMED_SCAN_WORKTREE_LIST_FAILED",
      "UNCONSUMED_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  // HYK-198-capwire-2 §2 -- watch-run.mjs의 cap_* 필드(HYK-198-capwire-1이
  // 관측만 하던 것)를 편입. ★모양이 다르다(위 네 축은 status/verdict/
  // worstCount/worktrees, cap은 status/verdict/value/source): worstCount/
  // worktrees는 "몇 개 워크트리가 나쁜가"라는 개수 개념인데 cap에는
  // 대응 개념이 없다(값 파일은 저장소당 1개). 억지로 끼워 맞추지 않고
  // ★cap 전용 취급을 택했다 -- buildAxesFromFields(아래)는 이미
  // axis.prefix 기반으로 완전히 제네릭이라 코드 변경 없이 그대로
  // 동작하고(존재하지 않는 cap_worst_count/cap_worktrees는 그냥
  // null이 된다), 그 두 필드는 computeOpenAnomalies/computeRecentSummary
  // 어느 쪽도 읽지 않으므로(실측: 아래 두 함수 확인) null이어도 해가
  // 없다 -- value/source를 억지로 그 틀에 밀어 넣는 별도 코드를 새로
  // 짜지 않았다("필요한 만큼만").
  //
  // ★이상(anomaly) 기준: **값을 읽지 못한 상태**(status가 OK가 아님 --
  // 파일 부재·손상 JSON·schema 불일치·코어가 거부함)만 이상이다. 값
  // 자체(0이든 9든)는 이상이 아니다 -- 한용이 정한 값이고 이 저장소는
  // 그 값을 "옳다"고 판단할 근거가 없다(그 값이 이상한지는 사람 몫).
  // ORCH 소견을 그대로 채택했다 -- 그 순간 "판정 자체가 불가능하다"는
  // 점에서 다른 네 축의 COLLECTION_FAILED류와 같은 급의 신호이기
  // 때문이다. `badVerdicts`는 비워 둔다 -- cap_verdict는 정상일 때
  // 항상 "DECIDED"이고(judgeConcurrency는 ok:true면 언제나 DECIDED만
  // 낸다, concurrency-core.mjs 확인) 그 자체는 이상이 아니다.
  //
  // ★cap_verdict="DECIDED"가 사람에게 "판정한 것처럼" 오인되는 문제
  // (검토자 지적, §2-4): status가 "OK"인 한 badStatuses에 없으므로
  // isAxisAnomalous가 항상 false다 -- 즉 cap이 정상일 때는
  // "열려 있는 이상" 목록에 **아예 나타나지 않는다**(다른 정상 축과
  // 동일). formatMorningReport의 "지난 24시간 요약"도 verdict 문자열
  // 자체는 찍지 않고 표본/이상 건수만 찍는다. 결론: "DECIDED"라는
  // 문자열은 사람이 보는 아침 보고 어디에도 나타나지 않는다(구조적으로
  // 보장 -- 별도 문구 은폐 코드를 추가하지 않았다, 아래 시험으로 고정).
  Object.freeze({
    key: "cap",
    prefix: "cap",
    label: "동시 실행 상한 읽기 실패",
    badVerdicts: Object.freeze([]),
    badStatuses: Object.freeze([
      "CAP_READ_FAILED",
      "CAP_STEP_FAILURE",
      "CORE_REJECTED",
    ]),
  }),
  // HYK-173-push-wire (coder-task.md §4 요건3) -- escalation 축. 위 헤더
  // 두 번째 예외 참조. badVerdicts = escalation-state.mjs가 실제로
  // 산출하는 "wake" 상태 문자열 그대로(HUMAN_WAKE_STATES 셋 + 이 축이
  // 실제로 내는 NEEDS_INPUT -- orch-stall-detect.mjs judgeEscalationForRepo
  // 는 escalation 메시지의 reason을 분류하지 않고 전부 사람 게이트7로
  // 승격하므로[coder-task.md §5-C 4항], 이 축이 내는 NEEDS_INPUT은
  // 언제나 wake다). badStatuses = 조회/handle 대조 실패(§5-A/§5-B, "조용한
  // 0건"으로 새지 않도록 표면화한 상태).
  Object.freeze({
    key: "escalation",
    prefix: "escalation",
    label: "워커 escalation(중단 신호)",
    badVerdicts: Object.freeze([...HUMAN_WAKE_STATES, COORD_STATE.NEEDS_INPUT]),
    badStatuses: Object.freeze(["ESCALATION_COLLECTION_FAILED"]),
  }),
  // HYK-212-postcheck-1 (coder-task.md §2/§4 요건3) -- «배달 직후 재조회
  // 사후검증» 축. §4 요건3과 동일 이유로 세 번째 예외가 생긴다: 이
  // AXES는 닫힌 배열이고 여기 등록된 축의 verdict/status만 "열린
  // 이상"으로 분류돼 받는함(reach-notify-*.md)에 도달한다 -- 등록하지
  // 않으면 watch.log(postcheck_*)까지만 가고 사람에게 안 간다(1-B가
  // 금지하는 "로그에만" 실패 형태 그 자체). badVerdicts = RECORD_MISSING
  // (배달 시점 재조회로 이미 확인된 "레코드 없음", dispatch-postcheck-
  // core.mjs DISPATCH_POSTCHECK_VERDICT). badStatuses = 이 축 자신의
  // 조회 실패(§3-3: 이건 RECORD_MISSING과 다른 값이라 badVerdicts에
  // 넣지 않는다 -- 정직 요구) + watch 시점 수집 실패(영수증 파일
  // 손상·워크트리 열거 실패).
  Object.freeze({
    key: "postcheck",
    prefix: "postcheck",
    label: "배달 레코드 미생성",
    badVerdicts: Object.freeze(["RECORD_MISSING"]),
    badStatuses: Object.freeze([
      "DISPATCH_POSTCHECK_QUERY_FAILED",
      "DISPATCH_POSTCHECK_SCAN_WORKTREE_LIST_FAILED",
      "DISPATCH_POSTCHECK_SCAN_RECEIPT_READ_FAILED",
    ]),
  }),
  // HYK-239-chain-wire-2 (coder-task.md §1, 검토 1R 반려 수리) -- «원장
  // 해시체인 위조 탐지» 축. §4 요건3과 동일 이유로 네 번째 예외가 생긴다:
  // 이 AXES는 닫힌 배열이고 여기 등록된 축의 verdict/status만 "열린
  // 이상"으로 분류돼 받는함(reach-notify-*.md)에 도달한다 -- 등록하지
  // 않으면 watch.log(chain_*)까지만 가고 사람에게 안 간다(1-B가 금지하는
  // "로그에만" 실패 형태 그 자체, 이번 라운드가 정확히 그 반려를 닫는다).
  // badVerdicts = TAMPER_DETECTED(orch-stall-detect.mjs의
  // judgeChainIntegrityAcrossWorktrees가 reject-streak-chain.mjs
  // verify-all을 실호출해 얻은 exit 2). badStatuses = 이 축 자신의
  // 판정 불가(CHAIN_QUERY_FAILED -- 원장/사이드카 판독 실패, §1-5 "판정
  // 불가를 위조로 보고하지 마라"의 정반대 실수 방지: 판정 불가도
  // 조용함으로 접지 않고 표면화는 하되 TAMPER_DETECTED와 다른 사유
  // 문자열로 구별한다) + 워크트리 열거 실패.
  Object.freeze({
    key: "chain",
    prefix: "chain",
    label: "원장 위조 탐지(해시체인)",
    badVerdicts: Object.freeze(["TAMPER_DETECTED"]),
    badStatuses: Object.freeze([
      "CHAIN_QUERY_FAILED",
      "CHAIN_SCAN_WORKTREE_LIST_FAILED",
    ]),
  }),
  // HYK-240 요건3 (coder-task.md §3) -- 승인<->코드지문 결속 위반 축.
  // badVerdicts = MISMATCH(orch-stall-detect.mjs의
  // judgeApprovalBindingAcrossWorktrees가 각 워크트리 자기 자신의
  // review-approval-binding.mjs --explain을 실행해 얻은 "3) 판정: 불일치"
  // 판독). badStatuses = 이 축 자신의 판정 불가(BINDING_QUERY_FAILED --
  // 스폰/파싱 실패) + 워크트리 열거 실패. ⛔정직 한계: review.md는
  // 있지만 binding-fingerprint 줄이 없는 "결속 없음" 상태는 이 축에서
  // 열린 이상으로 잡지 않는다(judgeApprovalBindingForWorktree의 헤더
  // 주석 참조 -- 그 상태의 강제는 커밋 게이트 자신의 몫).
  Object.freeze({
    key: "binding",
    prefix: "binding",
    label: "승인<->코드지문 결속 위반",
    badVerdicts: Object.freeze(["MISMATCH"]),
    badStatuses: Object.freeze([
      "BINDING_QUERY_FAILED",
      "BINDING_SCAN_WORKTREE_LIST_FAILED",
    ]),
  }),
]);

// HYK-191-reach-1 실측 수리: 4축 필드(seat_*/idle_*/start_*/unconsumed_*)가
// 아직 없던 구세대 watch.log 줄(reason= 뒤에 아무것도 없이 줄이 끝남,
// 실물 D:/문서관리/하네스-관제실/watch/watch.log 278줄 중 47줄이 이
// 형태였다 -- gap#69 도입 직후~seat-wire 이전 구간)도 파싱돼야 한다.
// 뒤쪽 축 세그먼트를 통째로 옵셔널로 둔다(없으면 axes 전부 null/이상
// 아님으로 처리 -- fields가 그냥 비게 된다).
const LOG_LINE_RE =
  /^(\S+)\s+exit=(\S+)\s+verdict=(\S+)\s+reason=(\S+)(?:\s+(.*))?$/;

function parseFieldTokens(rest) {
  const fields = {};
  for (const tok of rest.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return fields;
}

function numOrNull(raw) {
  return raw && raw !== "NONE" ? Number(raw) : null;
}

function buildAxesFromFields(fields) {
  const axes = {};
  for (const axis of AXES) {
    const status = fields[`${axis.prefix}_status`] ?? null;
    const verdictField = fields[`${axis.prefix}_verdict`] ?? null;
    axes[axis.key] = {
      status: status === "NONE" ? null : status,
      verdict: verdictField === "NONE" ? null : verdictField,
      worstCount: numOrNull(fields[`${axis.prefix}_worst_count`]),
      worktrees: numOrNull(fields[`${axis.prefix}_worktrees`]),
      // HYK-265-observe-split-1 (coder-task.md §3-1 항2): watch-run.mjs가
      // COLLECTION_FAILED류 status일 때만 싣는 "왜"(observationReason:reason
      // 을 합친 사람이 읽는 문자열, reasonDetailSegment 참조). 없으면 null
      // -- 축 전부가 이 필드를 갖는 것은 아니다(seat/idle/start/unconsumed
      // 넷뿐, §3-1 범위).
      reasonDetail: fields[`${axis.prefix}_reason_detail`] ?? null,
    };
  }
  return axes;
}

// watch.log 한 줄 -> {tsMs, verdict, reasonCode, axes:{seat:{status,verdict,
// worstCount,worktrees}, ...}} | null(파싱 불가 -- RUNNER_FAILURE 줄, 빈
// 줄, 미래 형식 변경 등). 판단 불가는 그냥 건너뛴다(호출부가 배열에서
// null을 걸러낸다) -- 사람이 읽는 보고문에서 "이 줄은 못 읽었다"를 굳이
// 조용히 삼키지 않도록 parseWatchLog(아래)가 스킵 건수를 따로 센다.
export function parseLogLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = trimmed.match(LOG_LINE_RE);
  if (!m) return null;
  const [, tsRaw, , verdict, reasonCode, restRaw] = m;
  const tsMs = Date.parse(tsRaw);
  if (Number.isNaN(tsMs)) return null;
  const fields = parseFieldTokens(restRaw ?? "");
  return { tsMs, verdict, reasonCode, axes: buildAxesFromFields(fields) };
}

// watch.log 전체 텍스트 -> {entries, skipped}. entries는 시간순(오름차순,
// 로그 append 순서 그대로) 배열이다.
export function parseWatchLog(text) {
  const lines = typeof text === "string" ? text.split(/\r?\n/) : [];
  const entries = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseLogLine(line);
    if (parsed) entries.push(parsed);
    else skipped += 1;
  }
  return { entries, skipped };
}

// HYK-265-observe-split-1 (coder-task.md §1 상설 문장 · §3-1 항1): «열려
// 있는 이상»(badVerdicts -- 대상이 실제로 이상하다)과 «측정 불가»
// (badStatuses -- 우리가 못 읽었다)는 원인이 다른 별개 신호다(§2 분류
// 규칙 원문 그대로 -- badStatuses를 없애지 않는다, «판정 불가를 조용함
// 으로 접지 않는다»는 기존 설계 의도 유지). 아래 두 술어로 갈라
// computeOpenAnomalies(badVerdicts만)와 computeOpenMeasurementFailures
// (badStatuses만)가 서로 다른 목록을 낸다 -- 실측(watch-run.mjs
// buildLogLine/axisLogSegment)상 COLLECTION_FAILED류 status일 때
// verdict는 항상 null이므로(그 축의 judge*ForRepo가 status만 채우고
// 반환한다, orch-stall-detect.mjs 참조) 두 술어가 동시에 참이 되는
// entry는 없다 -- 한 axis, 한 entry가 두 목록에 동시에 오르지 않는다.
function isAxisAnomalousVerdict(axisEntry, axis) {
  if (!axisEntry) return false;
  return Boolean(
    axisEntry.verdict && axis.badVerdicts.includes(axisEntry.verdict),
  );
}

function isAxisMeasurementFailure(axisEntry, axis) {
  if (!axisEntry) return false;
  return Boolean(
    axisEntry.status && axis.badStatuses.includes(axisEntry.status),
  );
}

// computeRecentSummary(아래)는 이 라운드 범위 밖(§3-2 "감시 항목 추가·삭제
// 0", 이 요약 절은 손대지 않는다) -- «이상»과 «측정 불가»를 합쳐 세던
// 기존 동작(회귀 0)을 그대로 유지하기 위한 결합 술어.
function isAxisAnomalousOrMeasurementFailure(axisEntry, axis) {
  return (
    isAxisAnomalousVerdict(axisEntry, axis) ||
    isAxisMeasurementFailure(axisEntry, axis)
  );
}

// computeOpenAnomalies/computeOpenMeasurementFailures가 공유하는 "지금까지
// 연속으로 predicate가 참이었던 구간" 계산(§(c) 41.5h 원칙 -- 매번 로그
// 전체를 다시 훑어 "언제부터"를 계산한다, 전이 통지 1건에 기대지 않는다).
function computeOpenByPredicate(entries, nowMs, predicate, kind) {
  const list = Array.isArray(entries) ? entries : [];
  const open = [];
  if (list.length === 0) return open;
  const latest = list[list.length - 1];
  for (const axis of AXES) {
    const latestAxisEntry = latest.axes[axis.key];
    if (!predicate(latestAxisEntry, axis)) continue;
    let sinceMs = latest.tsMs;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!predicate(e.axes[axis.key], axis)) break;
      sinceMs = e.tsMs;
    }
    const openMs = Math.max(
      0,
      (typeof nowMs === "number" ? nowMs : latest.tsMs) - sinceMs,
    );
    open.push({
      axisKey: axis.key,
      label: axis.label,
      verdict: latestAxisEntry.verdict,
      status: latestAxisEntry.status,
      reasonDetail: latestAxisEntry.reasonDetail ?? null,
      // HYK-265-observe-split-1 (coder-task.md §4 완료조건1): 통지
      // (reach-notify-core.mjs buildNoticeText)도 이 둘을 다른 절로
      // 갈라야 하므로, 각 원소가 자기 출처를 스스로 밝힌다(호출부가
      // 두 배열을 합쳐도 구별이 사라지지 않도록).
      kind,
      sinceMs,
      openMs,
    });
  }
  return open;
}

// entries(시간순) + nowMs -> 현재 "열려 있는 이상"(badVerdicts, 대상 자체가
// 이상함) 배열. §(c) 41.5h 원칙(주석은 computeOpenByPredicate 참조).
export function computeOpenAnomalies(entries, nowMs) {
  return computeOpenByPredicate(
    entries,
    nowMs,
    isAxisAnomalousVerdict,
    "anomaly",
  );
}

// HYK-265-observe-split-1 (coder-task.md §3-1 항1·§4 완료조건1): entries +
// nowMs -> 현재 "측정 불가"(badStatuses, 우리가 못 읽었다) 배열. 모양은
// computeOpenAnomalies와 동일(axisKey/label/verdict/status/sinceMs/openMs)
// + reasonDetail(있으면 "왜"를 사람이 읽는 문자열로).
export function computeOpenMeasurementFailures(entries, nowMs) {
  return computeOpenByPredicate(
    entries,
    nowMs,
    isAxisMeasurementFailure,
    "measurement_failure",
  );
}

// 지난 windowMs(기본 24시간) 동안 각 axis가 이상 상태로 관측된 샘플 수 --
// "지난 24시간 요약"용. 열려 있는 이상(computeOpenAnomalies)과는 별개
// 절이다(coder-task.md §4 "지난 24시간 요약과 지금 열려 있는 이상은
// 다르다").
export const DEFAULT_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function computeRecentSummary(
  entries,
  nowMs,
  windowMs = DEFAULT_SUMMARY_WINDOW_MS,
) {
  const list = Array.isArray(entries) ? entries : [];
  const cutoff = (typeof nowMs === "number" ? nowMs : 0) - windowMs;
  const inWindow = list.filter((e) => e.tsMs >= cutoff);
  const summary = {};
  for (const axis of AXES) {
    let anomalousSamples = 0;
    for (const e of inWindow) {
      if (isAxisAnomalousOrMeasurementFailure(e.axes[axis.key], axis)) {
        anomalousSamples += 1;
      }
    }
    summary[axis.key] = {
      label: axis.label,
      sampleCount: inWindow.length,
      anomalousSamples,
    };
  }
  return summary;
}

// N시간 M분 형식(coder-task.md §4 "몇 시간째"가 결정적 정보라는 실측
// 근거를 그대로 반영 -- 분 단위까지 보여 "방금 넘겼다"와 "한참 됐다"를
// 구별시킨다).
export function formatDurationKo(ms) {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}분`;
  return `${hours}시간 ${minutes}분`;
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

// formatMorningReport에서 분리(§6 eslint max-complexity 상한 준수 --
// HYK-265-observe-split-1이 「측정 불가」절을 추가하며 상한을 넘겼다).
// "지금 열려 있는 이상" 절 -- 비어 있어도 "없음"을 명시적으로 찍는다.
function formatOpenAnomaliesSection(openAnomalies) {
  const lines = ["## 지금 열려 있는 이상"];
  if (openAnomalies.length === 0) {
    // HYK-173-push-wire 2R P2-1 -- 축 수를 문면에 손으로 박지 않는다
    // (coder-task.md §2-2 "적힌 수 != 실제 목록", 이 계열 재발 5회째).
    // AXES.length에서 기계로 유도해 AXES가 늘어나면 이 문면도 그대로
    // 따라간다(escalation-axis-wire.test.mjs가 이 동기화를 시험으로
    // 고정한다).
    lines.push(
      `없음 -- 열려 있는 이상이 없습니다(${AXES.length}축 전부 정상 또는 관측 대상 없음).`,
    );
    return lines;
  }
  for (const a of openAnomalies) {
    lines.push(
      `- **${a.label}** (${a.verdict ?? a.status}) -- ${formatKstIsh(a.sinceMs)}부터, ${formatDurationKo(a.openMs)}째`,
    );
  }
  return lines;
}

// HYK-265-observe-split-1 (coder-task.md §4 완료조건1·2) -- «측정 불가
// (수집 실패)» 절. 사유(reasonDetail, 있으면)를 함께 찍는다 -- ⛔조용히
// 만들지 않는다(§2 실측 배경 "판정 불가를 조용함으로 접지 않는다"의
// 설계 의도 유지).
function formatOpenMeasurementFailuresSection(openMeasurementFailures) {
  const lines = ["## 측정 불가(수집 실패)"];
  if (openMeasurementFailures.length === 0) {
    lines.push("없음 -- 지금 측정 불가 상태인 축이 없습니다.");
    return lines;
  }
  for (const a of openMeasurementFailures) {
    const why = a.reasonDetail ? ` -- 사유: ${a.reasonDetail}` : "";
    lines.push(
      `- **${a.label}** (${a.verdict ?? a.status}) -- ${formatKstIsh(a.sinceMs)}부터, ${formatDurationKo(a.openMs)}째${why}`,
    );
  }
  return lines;
}

function formatRecentSummarySection(entries, summary) {
  const lines = ["## 지난 24시간 요약"];
  if (entries.length === 0) {
    lines.push(
      "없음 -- 지난 24시간 내 로그 항목이 없습니다(watch.log 비어있음 또는 감시 미실행).",
    );
    return lines;
  }
  for (const axis of AXES) {
    const s = summary[axis.key];
    lines.push(
      `- ${s.label}: 표본 ${s.sampleCount}건 중 이상 ${s.anomalousSamples}건`,
    );
  }
  return lines;
}

// 사람이 읽는 보고문 본문(요건 2). 맨 위에 "지금 열려 있는 이상"(비어
// 있어도 "없음"을 명시적으로 찍는다 -- 빈 출력 금지), 그 아래 "측정 불가
// (수집 실패)"(HYK-265-observe-split-1), 그 아래 "지난 24시간 요약".
export function formatMorningReport({
  entries,
  nowMs,
  skipped = 0,
  sourceLabel = "",
}) {
  const openAnomalies = computeOpenAnomalies(entries, nowMs);
  // HYK-265-observe-split-1 (coder-task.md §3-1 항1·§4 완료조건1): «측정
  // 불가»(수집 실패)는 «이상»과 «다른 절»로 싣는다 -- badStatuses가
  // badVerdicts와 같은 절에 합류하면 대상이 실제로 이상한 것인지 우리가
  // 못 읽은 것인지 사람이 매번 손으로 대조해야 한다(§2 실측 배경).
  const openMeasurementFailures = computeOpenMeasurementFailures(
    entries,
    nowMs,
  );
  const summary = computeRecentSummary(entries, nowMs);
  const lines = [];
  lines.push(`# 예약 감시 아침 보고 -- ${formatKstIsh(nowMs)} 기준`);
  if (sourceLabel) lines.push(`source: ${sourceLabel}`);
  lines.push("");
  lines.push(...formatOpenAnomaliesSection(openAnomalies));
  lines.push("");
  lines.push(...formatOpenMeasurementFailuresSection(openMeasurementFailures));
  lines.push("");
  lines.push(...formatRecentSummarySection(entries, summary));
  if (skipped > 0) {
    lines.push("");
    lines.push(`(참고: 파싱 못한 로그 줄 ${skipped}개는 이 보고에서 제외됨)`);
  }
  return lines.join("\n") + "\n";
}
