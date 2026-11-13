// HYK-255-partial-counter-1 (coder-task.md) -- «부분 계수 보고기» 순수 코어.
//
// §0 왜 이 모양인가(설계 정본 = D:\문서관리\하네스-관제실\PM\relay\pm.md
// 판정 3 «표기 규격» 코드블록 · 한용 확정 2026-08-14 15:44): 1-C 정직
// 한계 원문이 요구하는 것은 «많이 세는 것»이 아니라 **«거짓 0을 낼 수
// 없는 것»**이다. 그래서 이 코어의 모든 렌더링 규칙은 한 방향으로만
// 기운다 -- 관측 없음·조회 실패·수집기 부재는 절대 0으로 접지 않고
// `UNKNOWN(사유)`/`미계수`로 내며, ㄴ(계획 밖 개입)의 확인 건수가 0이면
// 반드시 «확인 0건»으로 쓰고 «ㄴ=0»이라는 주장(bare 0)은 어떤 경로로도
// 만들지 않는다.
//
// §1 새 감지기 0(PM 권고 그대로): 이 파일은 아무것도 스스로 감지하지
// 않는다. 무진행-재개 의심 구간은 reach-report-core.mjs의 AXES(기존
// 관측기 orch-stall-detect.mjs가 watch.log에 이미 남긴 verdict 문자열의
// 닫힌 분류)를 그대로 재사용해 «닫힌 구간»으로 집계만 하고, 설계된 사람
// 게이트 대기는 orch-progress-core.mjs의 ORCH_PROGRESS_VERDICT.
// WAITING_HUMAN_GATE 상수(재구현 금지)로 제외한다. ⛔이 의심 구간은
// 진단 칸이며 ㄴ 분자에 절대 산입하지 않는다(PM 판정 2 기각: 무진행·
// 재개만으로는 자동 재시도·스케줄러 재기동·네트워크 회복을 배제할 수
// 없다 -- «ㄴ ≥ M»은 셀 수 있는 척이다).
//
// §2 I/O 0(S8 원칙, reach-report-core.mjs와 동일): 파일·네트워크·시계를
// 읽지 않는다. 수집은 wire(partial-count-report.mjs)의 몫이다.
import { AXES, formatDurationKo } from "./reach-report-core.mjs";
import { ORCH_PROGRESS_VERDICT } from "./orch-progress-core.mjs";

// ---------------------------------------------------------------------------
// 닫힌 목록 상수 -- 출처를 벗어난 항목을 코드가 지어내지 않게 한 곳에 둔다.
// ---------------------------------------------------------------------------

// ㄱ 닫힌 여섯 유형(번호 1~4 · 6 · 7). ⛔유일한 출처 = D:\문서관리\
// 하네스-관제실\북극성-좌표.md §1-C «ㄱ. 설계된 정지 -- 닫힌 목록»(2026-08-07
// 한용 확정 · 2026-11-12 19:1x 책임자 판정으로 게이트 5 폐지 반영 -- 원문
// 일곱은 취소선으로 보존). 분모는 이 배열 길이에서만 온다 -- 문자열로
// 숫자를 박지 않는다(목록이 한용 확정으로 바뀌면 분모도 기계로 따라간다).
// 폐지된 5 는 아래 ABOLISHED_GATE_TYPES 에 번호만 남아 표기된다.
export const GATE_TYPES = Object.freeze([
  Object.freeze({ number: 1, name: "다음 작업 선택" }),
  Object.freeze({ number: 2, name: "연속 반려 판정" }),
  Object.freeze({ number: 3, name: "북극성·큰 실행 승인" }),
  Object.freeze({ number: 4, name: "PR 승인·병합 / Linear Done" }),
  Object.freeze({ number: 6, name: "하드스톱" }),
  Object.freeze({ number: 7, name: "상신 답변" }),
]);

// HYK-255-ln-github-anchor-1 커밋 2 -- 폐지된 ㄱ 유형(분모 밖, 표기만).
// 게이트 5 «패킷 서명»은 한용 «B» 확정 2026-09-03 05:55(sign.sh 서명 폐지,
// 정본 = 통역 CLAUDE.md B-11)로 폐지됐고, 북극성-좌표.md §1-C 는
// 2026-11-12 19:1x 에 «다음 여섯뿐 · 게이트 5 취소선 · 번호는 유지»로
// 갱신됐다. 번호는 유지하되 분모(GATE_TYPES)에서만 뺀다.
export const ABOLISHED_GATE_TYPES = Object.freeze([
  Object.freeze({
    number: 5,
    name: "패킷 서명",
    abolishedOn: "2026-09-03",
    basis: "B-11",
  }),
]);

// 이 라운드에 독립 앵커(= ORCH가 만들거나 사람 actor로 가장할 수 없음이
// 증명된 기록, PM 판정 1)가 결선된 ㄱ 유형. GitHub 사람 승인·병합
// (approval-authority-adapter.mjs, 무인증·fail-closed)이 덮는 것은 게이트
// 4의 «PR 승인·병합» 절반뿐이다 -- Linear Done은 독립 앵커가 아니어서
// (ORCH 좌석에 쓰기 표면 노출·비쓰기성 미증명, PM 판정 1 보정) 이
// 라운드는 수집 자체를 하지 않는다.
export const INDEPENDENT_ANCHOR_COVERED_GATE_NUMBERS = Object.freeze([4]);

// «알려진 미계수 예시» 목록 -- PM 판정 3 규칙: ㄴ은 열린 집합이므로
// «X/Y 유형 커버리지» 같은 전수 비율을 만들지 않고, **버전이 붙은** 예시
// 목록의 건수·항목을 그대로 낸다(이 개수는 전체 유형의 분모가 아니다).
// 항목 출처 = 북극성-좌표.md §1-C ㄴ 예시 + 관제실 2026-08-14-HYK255-
// 계수기-리서치.md §2(채팅 개입은 어떤 기계 기록에도 안 남는다는 실측).
//
// HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓐ) -- v1(8항목)/v2(7항목)
// «조건부» 공존. 1R은 v2를 상수로 고정했었는데, REVIEW-r1 P2-1이 실제
// 예약 감시(OrchStallWatch)에 `--outbox-dir`가 없어 그 실행에서는 8번
// 항목(«통역 보내는함 문서(ORCH-writeable -- 보조 칸에서도 제외)»)의
// 전제가 여전히 참이라고 지적했다 -- 전제가 참인 실행에서 그 항목을
// 빼면 거짓 축소다. 그래서 선택은 ㄴ 분자처럼 **실행마다** 갈린다: wire
// (partial-count-report.mjs)가 보내는함 수집기를 결선했을 때(outboxDir이
// 주어져 collectOutboxHeaderCounts를 실제로 불렀을 때, 성공/실패 무관)
// 만 v2를 쓰고, 미결선 실행은 v1을 그대로 쓴다 -- 이 파일은 I/O 0(§2
// 원칙)이라 "결선 여부"를 스스로 알 수 없고, 어느 쪽을 쓸지는 호출자가
// buildPartialCountReport의 uncountedExamples 인자로 고른다(기본값 =
// v1 -- "인자를 안 준 호출자"는 "미결선"과 같은 뜻이라야 회귀 0).
export const UNCOUNTED_EXAMPLES_V1 = Object.freeze({
  version: "uncounted-examples/v1",
  items: Object.freeze([
    "채팅으로 온 판정·교정·지시(기계 기록 0)",
    "권한 확인창에 답해 주기",
    "미제출 배달을 빈 Enter로 밀어 주기",
    "멈춘 좌석을 사람이 알아채고 깨우기",
    "끝난 배달 기록을 손으로 닫기",
    "로그에만 뜬 경보를 사람이 발견해 알려 주기",
    "Linear 상태 전환(독립 앵커 비증명 -- 이 라운드 수집 제외)",
    "통역 보내는함 문서(ORCH-writeable -- 보조 칸에서도 제외)",
  ]),
});

// v2 -- v1에서 8번(통역 보내는함 문서) 하나만 뺀 판. ⛔1번 «채팅으로 온
// 판정·교정·지시(기계 기록 0)»은 그대로 둔다 -- 이 보조 칸이 세는 것은
// «파일로 남은» 보내는함 문서뿐이고, 채팅으로만 오가고 어떤 파일에도
// 안 남는 판정·교정·지시는 여전히 전부 미계수다(1번이 덮는 범위가
// 8번보다 넓다 -- 보조 관측이 센 것과 여전히 미계수인 것은 겹치지 않는다).
export const UNCOUNTED_EXAMPLES_V2 = Object.freeze({
  version: "uncounted-examples/v2",
  items: Object.freeze(
    UNCOUNTED_EXAMPLES_V1.items.filter(
      (item) => !item.includes("통역 보내는함 문서"),
    ),
  ),
});

// v3 -- HYK-255-relay-aux-1(coder-task.md product_scope ⓑ · PM 설계
// §(d)) -- v2(7)에서 개수는 그대로 두고 문면만 좁힌다. 1번은 "전달
// 파일·S1·S2 대조로도 못 잡는 채팅 지시"로 좁히고(그 대조에 남는 몫은
// collectRelayLedger의 ORCH-writeable 보조 관측으로 이미 옮겨졌으므로),
// 4·5·6번은 "한용이 전달 파일에 남긴 몫은 보조 관측으로 이동했다"는
// 단서를 덧붙인다(설계 §(d): "전달 기록분 = 보조 관측" 단서). ⛔개수를
// 줄였다고 쓸 근거는 없다(설계 §(d) 그대로 7개 유지) -- v2와 마찬가지로
// "통역 보내는함 문서" 항목은 넣지 않는다.
export const UNCOUNTED_EXAMPLES_V3 = Object.freeze({
  version: "uncounted-examples/v3",
  items: Object.freeze([
    "전달 파일·대조 출처(S1·S2) 어디에도 없는 채팅 지시(전달 머리줄·보내는함·받는함에 남은 몫은 보조 관측으로 이동)",
    "권한 확인창에 답해 주기",
    "미제출 배달을 빈 Enter로 밀어 주기",
    "멈춘 좌석을 사람이 알아채고 깨우기 — 전달 기록분은 보조 관측으로 이동",
    "끝난 배달 기록을 손으로 닫기 — 전달 기록분은 보조 관측으로 이동",
    "로그에만 뜬 경보를 사람이 발견해 알려 주기 — 전달 기록분은 보조 관측으로 이동",
    "Linear 상태 전환(독립 앵커 비증명 -- 이 라운드 수집 제외)",
  ]),
});

// 무진행-재개 의심 구간에 쓰는 축 -- reach-report-core.mjs AXES 중 «무진행»
// 성격의 넷만(PM이 재사용을 지정한 orch-stall-detect/dispatch-start-core/
// unconsumed-core 계열의 verdict가 흐르는 축). cap/chain/binding/postcheck/
// escalation은 무진행이 아니라 무결성·전달 축이라 제외한다.
export const STALL_AXIS_KEYS = Object.freeze([
  "seat",
  "idle",
  "start",
  "unconsumed",
]);

const STALL_AXES = Object.freeze(
  AXES.filter((axis) => STALL_AXIS_KEYS.includes(axis.key)),
);

// ---------------------------------------------------------------------------
// 시간 유틸 -- KST(UTC+9 고정) 문자열 <-> epoch ms.
// ---------------------------------------------------------------------------

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function formatKst(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} KST`
  );
}

// «2026-08-14 06:04:39 KST» / «2026-08-14 15:46 KST»(초 없음) -> epoch ms.
// 소비 영수증 binding.doneAt / task 파일 dropped_at이 이 형식이다
// (relay-handshake.mjs parseKstTimestamp 계열과 동일 문면). 파싱 불가 =
// null(호출자가 «시각 불명»으로 별도 계수 -- 0으로 접지 않는다).
const KST_TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))? KST$/;

export function parseKstTimestampMs(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(KST_TS_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return (
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? "0"),
    ) - KST_OFFSET_MS
  );
}

// ---------------------------------------------------------------------------
// 무진행-재개 의심 구간 -- watch.log(parseWatchLog 결과)에서 «기존 관측기
// verdict가 무진행이었다가 다시 정상으로 돌아온 닫힌 구간»만 센다.
// ---------------------------------------------------------------------------

function isStallSample(entry, axis) {
  // 설계된 사람 게이트 대기는 무진행이 아니다(ㄱ 대기) -- orch-progress-
  // core.mjs가 이미 분리해 둔 verdict 문자열을 그대로 쓴다(재구현 금지).
  if (entry.verdict === ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE) return false;
  const axisEntry = entry.axes ? entry.axes[axis.key] : null;
  if (!axisEntry || !axisEntry.verdict) return false;
  return axis.badVerdicts.includes(axisEntry.verdict);
}

// entries(parseWatchLog의 시간순 배열) + 측정 창 -> {closed, open}.
// closed = 무진행 표본 연속 구간 뒤에 «비무진행 표본»이 실제로 관측된
// 구간(재개 확인). open = 창 끝까지 재개가 관측되지 않은 구간 -- 재개
// 미확인이므로 «무진행-재개»로 세지 않고 별도 표기만 한다.
export function computeSuspectedStallResumeIntervals({
  entries,
  windowStartMs,
  windowEndMs,
}) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e.tsMs >= windowStartMs && e.tsMs <= windowEndMs,
  );
  const closed = [];
  const open = [];
  for (const axis of STALL_AXES) {
    let runStartMs = null;
    for (const entry of list) {
      if (isStallSample(entry, axis)) {
        if (runStartMs === null) runStartMs = entry.tsMs;
      } else if (runStartMs !== null) {
        closed.push({
          axisKey: axis.key,
          fromMs: runStartMs,
          toMs: entry.tsMs,
        });
        runStartMs = null;
      }
    }
    if (runStartMs !== null) {
      open.push({ axisKey: axis.key, sinceMs: runStartMs });
    }
  }
  return { closed, open };
}

// ---------------------------------------------------------------------------
// 관측 공백(coverage gap) -- 비타협 5: 관측기 생존이 확인 안 된 기간을
// 정상 측정 기간에 조용히 넣지 않는다. watch.log 표본 사이 간격이
// 임계(기본 45분 = 실측 감시 주기 약 15분의 3배)를 넘는 구간 + 창 경계
// ~ 첫/마지막 표본 사이를 공백으로 센다. 표본이 하나도 없으면 창 전체가
// 공백 1구간이다.
// ---------------------------------------------------------------------------

export const DEFAULT_COVERAGE_GAP_THRESHOLD_MS = 45 * 60 * 1000;

export function computeCoverageGaps({
  entries,
  windowStartMs,
  windowEndMs,
  gapThresholdMs = DEFAULT_COVERAGE_GAP_THRESHOLD_MS,
}) {
  const inWindow = (Array.isArray(entries) ? entries : []).filter(
    (e) => e.tsMs >= windowStartMs && e.tsMs <= windowEndMs,
  );
  const gaps = [];
  const boundaries = [
    windowStartMs,
    ...inWindow.map((e) => e.tsMs),
    windowEndMs,
  ];
  for (let i = 1; i < boundaries.length; i++) {
    const span = boundaries[i] - boundaries[i - 1];
    if (span > gapThresholdMs) {
      gaps.push({ fromMs: boundaries[i - 1], toMs: boundaries[i] });
    }
  }
  const totalMs = gaps.reduce((acc, g) => acc + (g.toMs - g.fromMs), 0);
  return { gaps, totalMs };
}

// ---------------------------------------------------------------------------
// 렌더링 -- PM 판정 3 «표기 규격» 코드블록이 정본. 필드 문면을 임의로
// 줄이지 않는다. 추가된 줄(생성 시각·ㄱ-4 조회 내역·관측 공백)은 각각
// 아침 보고 신선도 판정·미조회의 정직 표기·비타협 5 때문에 필요한
// 것으로, 정본 문면을 대체하지 않고 곁에 더한 것이다.
// ---------------------------------------------------------------------------

// 계수 값 공용 shape: {known:true, count} | {known:false, reason}.
// ⛔비타협 2: known:false를 0으로 렌더링하는 경로는 없다.
function renderCount(value) {
  if (value && value.known === true) return `${value.count}`;
  const reason = value && value.reason ? value.reason : "사유 미상";
  return `UNKNOWN(${reason})`;
}

// ㄴ 확인 건수 렌더링 -- 필수 문면 3(한용 확정): 독립 증거로 확인된 것이
// 없으면 반드시 «확인 0건»으로 쓴다. bare «0건»은 «ㄴ=0»(기간 내 총 0건이 아니라
// «확인된 것 0»)으로 오독되므로 ⛔절대 내지 않는다. HYK-255-ln-update-branch-1 --
// 확인분이 있어도 같은 모양(«확인 N건»)이다(한용 확정 2026-11-13 15:3x: GitHub 웹
// Update branch 클릭 = ㄴ · 그 회차 REST 응답으로 확인된 건수가 분자).
//
// HYK-255-ln-update-branch-1 커밋 3 (책임자 교정 1904 ④) -- 하한 표기. D1 후보 중 이 회차에
// 확인하지 못한 것(미조회: 예산 · rate limit · 조회 실패)이 K ≥ 1 이면 분자 N 은 «이 회차에 확인된
// 것만»이라 실제보다 작을 수 있다 -- 그래서 «확인 N건 이상 · 미조회 K» 로 쓴다(분자가 하한임이
// 그 줄에서 읽힌다 · N = 0 도 «확인 0건 이상»). 미조회 0 이면 표기 0(옛 «확인 N건» 그대로).
//
// HYK-255-p5a-perm-1 -- 셋째 인자 gapPieces(문자열 배열 · 기본 []): 권한 확인창 답 수집기(ㄴ 유형 4)가 «센 값이
// 실제보다 작을 수 있다» 고 알리는 토막(판정 불가 K · 필드 없는 세션 S · 읽기 실패 · 수집 실패). 하나라도 있으면 «이상»
// 표기를 켜고 토막을 «미조회» 뒤에 잇는다. 빈 배열이면 옛 문면 그대로(두 인자 호출자 회귀 0).
export function renderConfirmedLnCount(
  count,
  uncheckedCount = 0,
  gapPieces = [],
) {
  const pieces = [];
  if (Number.isInteger(uncheckedCount) && uncheckedCount > 0) {
    pieces.push(`미조회 ${uncheckedCount}`);
  }
  pieces.push(...(Array.isArray(gapPieces) ? gapPieces : []));
  if (pieces.length > 0) return `확인 ${count}건 이상 · ${pieces.join(" · ")}`;
  return `확인 ${count}건`;
}

// 보내는함(통역) 머리줄 보조 관측 렌더링(HYK-255-outbox-aux-1) -- wire
// (partial-count-report.mjs의 collectOutboxHeaderCounts)의 산출물을
// buildGaSection의 «ORCH-writeable 보조 관측» 줄 문면으로 바꾸는 순수
// 함수(I/O 0, §2 원칙 그대로 -- 수집은 wire의 몫). 호출자가 outboxResult를
// 안 주면(= outboxDir 미지정) buildPartialCountReport의 기본 auxNote
// ("미계수(이 라운드 결선된 보조 수집기 없음)")가 그대로 쓰인다 -- 이
// 함수는 outboxResult가 있을 때만 호출된다.
//
// HYK-255-relay-aux-1 (coder-task.md product_scope ②) -- 꼬리 "독립
// 계수에 미산입"을 여기서 더 붙이지 않는다. buildGaSection(:301)이 이
// 함수의 반환값에 그 꼬리를 "한 번" 붙인다 -- 여기서도 붙이면 08:43
// 보고서에 실제로 찍혔던 "— 독립 계수에 미산입 — 독립 계수에 미산입"
// 중복이 재현된다(근거-부록 E: core:280 · :301이 같은 말을 두 번
// 붙인다). 이 함수는 "ORCH-writeable"까지만 내고, 꼬리는 호출자(:301)의
// 몫으로 남긴다.
export function renderOutboxAuxNote(outboxResult) {
  if (!outboxResult || outboxResult.known !== true) {
    const reason =
      outboxResult && outboxResult.reason ? outboxResult.reason : "사유 미상";
    return `UNKNOWN(${reason})`;
  }
  const failSuffix =
    outboxResult.readFailures > 0
      ? ` · 읽기 실패 ${outboxResult.readFailures}건`
      : "";
  return (
    `보내는함 머리줄: 책임자 경유 ${outboxResult.responsible}건 · ` +
    `한용 확정 ${outboxResult.hanyongConfirmed}건 · ` +
    `분류 불가 ${outboxResult.unclassified}건` +
    ` — ORCH-writeable${failSuffix}`
  );
}

// HYK-255-g-aux-render-1 커밋 1 (PM 진단 §(d) D2) -- ㄱ «보조 관측(독립 아님)»
// 한 줄. wire(partial-count-report.mjs 의 collectGateAuxObservations)의 산출물
// {gate1, gate2, gate6, gate7} 각 칸 = {known:true, count[, readFailures,
// undated]} | {known:false, reason}. ⛔못 읽은 칸은 bare 0 이 아니라 «ㄱ-N 수집
// 실패(사유)» -- 읽을 수 있었던 진짜 0 과 구별된다. ⛔이 값은 «독립 앵커 유형
// 커버리지» 분자 · 분모 어디에도 들어가지 않는다(buildGaSection 의 커버리지
// 줄은 INDEPENDENT_ANCHOR_COVERED_GATE_NUMBERS 와 GATE_TYPES 만 읽는다).
// 입력이 없으면(미결선 호출자) 줄 0개.
function renderGateAuxCell(label, cell) {
  if (!cell || cell.known !== true || !Number.isInteger(cell.count)) {
    const reason = cell && cell.reason ? cell.reason : "사유 미상";
    return `${label} 수집 실패(${reason})`;
  }
  const notes = [];
  if (cell.readFailures > 0) notes.push(`읽기 실패 ${cell.readFailures}건`);
  if (cell.undated > 0) notes.push(`시각 불명 ${cell.undated}건`);
  return `${label} ${cell.count}${notes.length > 0 ? `(${notes.join(" · ")})` : ""}`;
}

export function renderGateAuxObservationLine(gateAux) {
  if (!gateAux) return null;
  return (
    "- 보조 관측(독립 아님): " +
    [
      renderGateAuxCell("ㄱ-1", gateAux.gate1),
      renderGateAuxCell("ㄱ-2", gateAux.gate2),
      renderGateAuxCell("ㄱ-6", gateAux.gate6),
      renderGateAuxCell("ㄱ-7", gateAux.gate7),
    ].join(" · ")
  );
}

// HYK-255-g-aux-render-1 커밋 2 (D3 ⑵) -- ㄱ-4 «UNDECIDABLE N» 에 사유 분포를
// 붙인다: «UNDECIDABLE 2(사유: HTTP_FAILED 1 · RATE_LIMITED 1)». 사유는 wire 가
// 이미 받은 판정(gate4.undecidableReasons = {사유 코드: 건수})에서 전달한다 --
// 건수 많은 순 · 같으면 이름순. N 이 0 이면 붙이지 않는다(기존 문면 무변). N>0 인데
// 사유가 전달되지 않았으면 «사유 미상» 으로 낸다(조용한 생략 금지).
function renderUndecidableWithReasons(gate4) {
  if (!(gate4.undecidable > 0)) return `UNDECIDABLE ${gate4.undecidable}`;
  const entries = Object.entries(gate4.undecidableReasons ?? {}).sort(
    ([nameA, countA], [nameB, countB]) =>
      countB - countA || nameA.localeCompare(nameB),
  );
  if (entries.length === 0)
    return `UNDECIDABLE ${gate4.undecidable}(사유 미상)`;
  const dist = entries.map(([name, count]) => `${name} ${count}`).join(" · ");
  return `UNDECIDABLE ${gate4.undecidable}(사유: ${dist})`;
}

function buildGaSection(gate4, auxNote, gateAux) {
  const lines = ["ㄱ 설계된 정지:"];
  if (gate4.known === true) {
    lines.push(`- 외부 독립 앵커로 확인: ${gate4.approved}건`);
    lines.push(
      `- ㄱ-4 후보 병합(측정 기간 내 origin/master): ${gate4.candidatesInWindow}건` +
        ` 중 조회 ${gate4.checked}건 · APPROVED ${gate4.approved} · NOT_APPROVED ${gate4.notApproved}` +
        ` · ${renderUndecidableWithReasons(gate4)} · 미조회(예산) ${gate4.uncheckedByBudget}건 — 미조회는 미계수다`,
    );
    for (const ev of gate4.approvedEvents ?? []) {
      lines.push(
        `  · 확인 사건: ${ev.sha.slice(0, 7)} PR#${ev.pullNumber} 승인자 ${ev.reviewerLogin} (승인+병합 결속 1사건)`,
      );
    }
  } else {
    lines.push(`- 외부 독립 앵커로 확인: UNKNOWN(${gate4.reason})`);
  }
  lines.push(`- ORCH-writeable 보조 관측: ${auxNote} — 독립 계수에 미산입`);
  const gateAuxLine = renderGateAuxObservationLine(gateAux);
  if (gateAuxLine) lines.push(gateAuxLine);
  const covered = INDEPENDENT_ANCHOR_COVERED_GATE_NUMBERS;
  lines.push(
    `- 독립 앵커 유형 커버리지: ${covered.length}/${GATE_TYPES.length}`,
  );
  const uncovered = GATE_TYPES.filter((g) => !covered.includes(g.number));
  lines.push(
    `- 미커버 ㄱ 유형: ${uncovered.map((g) => `${g.number} ${g.name}`).join(" · ")}` +
      ` (4도 PR 승인·병합만 — Linear Done은 미커버)`,
  );
  for (const g of ABOLISHED_GATE_TYPES) {
    lines.push(
      `- 폐지된 ㄱ 유형(분모 밖): ${g.number} ${g.name} — 폐지(${g.abolishedOn} ${g.basis})`,
    );
  }
  return lines;
}

// 전달 파일(통역 「기록\전달-*.md」) 대조 보조 관측 렌더링(HYK-255-
// relay-aux-1, PM 설계 §(c) 출력 칸 문면) -- wire
// (partial-count-report.mjs의 collectRelayLedger)의 산출물을 ㄴ 절 두
// 줄 문면으로 바꾸는 순수 함수(I/O 0 -- 수집은 wire의 몫). 호출자가
// relayLedgerResult를 안 주면(= --relay-glob 미지정) 줄 자체를 내지
// 않는다(outbox 보조 칸과 동일한 "미결선 = 줄 0개" 관례 -- §2 ⓐ 회귀
// 0). 결선됐지만 known:false(전달 폴더 없음·읽기 실패)면 ⛔0으로 접지
// 않고 UNKNOWN(사유) 한 줄만 낸다(비타협 2).
export function renderRelayLedgerAuxLines(relayLedgerResult) {
  if (!relayLedgerResult) return [];
  if (relayLedgerResult.known !== true) {
    const reason = relayLedgerResult.reason ?? "사유 미상";
    return [
      `- ORCH-writeable 보조 관측(전달 파일 대조): UNKNOWN(${reason}) — 독립 계수에 미산입`,
    ];
  }
  const r = relayLedgerResult;
  // P2-1(이 라운드 변이⑤의 표적) -- 전달 파일 "개별" 읽기 실패는
  // readRelayFiles가 조용히 0으로 접지 않고 relayReadFailures 배열에
  // 담아 올려주는데, 이 줄이 그 값을 안 보이면 다시 조용한 접음이
  // 된다(보내는함 보조 칸 collectOutboxHeaderCounts의 readFailures
  // 표기 관례와 동일, :1339 꼴). 읽기 실패가 1건이라도 있으면 "대응 없음(ㄴ
  // 후보)" 수치를 확정으로 보이지 않게 괄호 문구를 붙인다 -- 형식
  // 머리줄이 든 파일 하나가 실패하면 유효 항목이 적게 보여 K가 과다
  // 또는 과소하게 나올 수 있다(검토 1R P2-1).
  const readFailureCount = Array.isArray(r.relayReadFailures)
    ? r.relayReadFailures.length
    : 0;
  const candidateNote =
    readFailureCount > 0 ? "(전달 파일 읽기 실패로 불확실)" : "";
  const readFailureNote =
    readFailureCount > 0 ? ` · 읽기 실패 ${readFailureCount}건` : "";
  // P2-1(2R) ⓘⓘ(HYK-255-relay-aux-4) -- 짝 없는 `전달 #번호`("없는
  // 번호를 가리킴")는 ㄴ 후보 수치에는 이미 포함되지만, 그 사유 자체가
  // 보이지 않는다는 지적이었다(검토 2R P2-1) -- 0건이 아닐 때만 사유를
  // 덧붙인다(조용한 과시 금지, 다른 보조 칸과 같은 관례).
  const numberMismatchNote =
    typeof r.numberMismatchCandidateCount === "number" &&
    r.numberMismatchCandidateCount > 0
      ? ` · 없는 번호를 가리킴 ${r.numberMismatchCandidateCount}건`
      : "";
  // 게이트 2 판정 A(HYK-255-relay-aux-4) -- 줄 안 토큰도 파일 이름
  // 날짜도 없는 정규식 밖 줄("시각 미정")은 형식 이전에 섞여 들어가되
  // 그 건수도 별도로 보인다(판정 원문 "형식 이전 + 별도 칸").
  const undeterminedNote =
    typeof r.undeterminedCount === "number" && r.undeterminedCount > 0
      ? ` · 시각 미정 ${r.undeterminedCount}건`
      : "";
  const line1 =
    `- ORCH-writeable 보조 관측(전달 파일 대조): 출처 한용 발화 ${r.sourceUtteranceCount}건 · ` +
    `전달 항목 대응 ${r.matchedCount}건 · ` +
    `대응 없음(ㄴ 후보) ${r.candidateCount}건${candidateNote}${numberMismatchNote} · ` +
    `형식 오류 ${r.formatErrorCount}건 · ㄱ-7 기록 누락 ${r.gate7MissingCount}건 · ` +
    `형식 이전 구간 미계수 ${r.beforeFormatCount}건${readFailureNote}${undeterminedNote} — 독립 계수에 미산입`;
  return [line1, renderRelayClassificationLine(r.classificationTally)];
}

// HYK-255-g-aux-render-1 커밋 2 (D3 ⑴ · ⑶) -- 전달 항목 분류 줄.
// ⑴ 유효 항목이 0개(= 전달 머리줄 형식이 아직 시작되지 않음)면 «ㄴ 0» 을 포함한 모든
//   0 이 bare 로 찍혀 «ㄴ=0» 으로 오독될 수 있다 -- 숫자 대신 «형식 미시작 — 분류
//   없음». 항목이 1개라도 있으면 기존 숫자 표기 그대로.
// ⑶ 자기 분류 라벨 ㄱ-5 는 폐지된 게이트(ABOLISHED_GATE_TYPES · 번호 유지)라 «ㄱ-5(폐지)»
//   로 적는다(1-C 문면 정합 -- 분모 6 인 줄 옆에서 현행 유형처럼 읽히지 않게).
const ABOLISHED_TALLY_LABELS = new Set(
  ABOLISHED_GATE_TYPES.map((g) => `ㄱ-${g.number}`),
);

function renderRelayClassificationLine(classificationTally) {
  const entries = Object.entries(classificationTally);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const body =
    total === 0
      ? "형식 미시작 — 분류 없음"
      : entries
          .map(
            ([key, count]) =>
              `${ABOLISHED_TALLY_LABELS.has(key) ? `${key}(폐지)` : key} ${count}`,
          )
          .join(" · ");
  return `- 전달 항목 분류: ${body}(자기 분류 — 독립 아님)`;
}

// HYK-255-ln-github-anchor-1 (판정 2026-11-12 19:1x 1ⓑ) -- ㄴ 독립 수집기
// 1호(GitHub 웹 «Update branch» 병합 커밋 후보)의 ㄴ 절 새 줄. 이 줄의
// 확인 N 은 «후보 중 그 회차 REST 응답으로 서명·작성자가 확인된 건수»다.
// HYK-255-ln-update-branch-1 (한용 확정 2026-11-13 15:3x) -- 분류가 확정됐다:
// Update branch 클릭 = ㄴ. 그래서 이 확인 N 은 위 «외부 독립 증거로 확인된 사건»
// 줄(ㄴ 분자 = confirmedLnEvents 길이)로 들어가고(wire 가 채운다 -- 이 렌더는
// 두 입력을 별개로 받는다), 이 줄은 분자에 «반영된다» 는 문면(옛 «분류 대기»
// 대신)을 박는다. 미조회 · 불일치 · 스테일 직전 값은 분자 밖이다. 입력이 없으면
// (미결선 호출자) 줄 0개. 수집 실패는 bare 숫자 0 이 아니라 «수집 실패(사유)»다.
const EXTERNAL_EVIDENCE_LINE_PREFIX = "- 외부 독립 증거 후보: ";
const EXTERNAL_EVIDENCE_NUMERATOR_NOTE = "ㄴ 분자 반영";

//
// HYK-255-g7-key-stale-1 (커밋 3) -- 스테일 표기. 그 회차에 미조회(예산 · rate limit ·
// 조회 실패)로 확인을 못 한 후보가 있어 «확인 N» 이 직전보다 낮게 나오면 줄 끝에
// 「스테일 표시(확인 아님): 직전 확인 M · 마지막 확인 HH:MM KST」 를 «덧붙인다».
// ⛔앞의 «확인 N · 미조회 U» 는 그 회차 REST 응답으로만 센 값 그대로다 -- 직전 값은
// 표시일 뿐 확인으로 세지 않고(ㄴ 분자에 들어가지 않는다 · 캐시는 승인 권위 아님) 이 줄의
// 파서도 앞의 두 숫자만 읽는다. 입력 externalEvidence.stalePrevious =
// {confirmed, atMs|null, nowMs} (wire 가 감시 상태 파일에서 읽어 넣는다 -- 이 렌더는
// I/O 0). 마지막 확인이 보고서 생성일과 다른 날이면 «MM-DD HH:MM», 시각을 모르면
// «시각 미상» -- 스테일이 오늘 값처럼 읽히지 않게 한다.
function formatStaleLastConfirmed({ atMs, nowMs }) {
  if (!Number.isFinite(atMs)) return "시각 미상";
  const at = formatKst(atMs);
  const hhmm = `${at.slice(11, 16)} KST`;
  const sameDay =
    Number.isFinite(nowMs) && formatKst(nowMs).slice(0, 10) === at.slice(0, 10);
  return sameDay ? hhmm : `${at.slice(5, 10)} ${hhmm}`;
}

function renderExternalEvidenceStaleSuffix(stalePrevious) {
  if (!stalePrevious || !Number.isInteger(stalePrevious.confirmed)) return "";
  if (stalePrevious.confirmed <= 0) return "";
  return (
    ` · 스테일 표시(확인 아님): 직전 확인 ${stalePrevious.confirmed}` +
    ` · 마지막 확인 ${formatStaleLastConfirmed(stalePrevious)}`
  );
}

export function renderExternalEvidenceCandidateLine(externalEvidence) {
  if (!externalEvidence) return null;
  if (externalEvidence.known !== true) {
    const reason = externalEvidence.reason ?? "사유 미상";
    return `${EXTERNAL_EVIDENCE_LINE_PREFIX}수집 실패(${reason})`;
  }
  return (
    `${EXTERNAL_EVIDENCE_LINE_PREFIX}확인 ${externalEvidence.confirmed} · ` +
    `미조회 ${externalEvidence.unchecked} · ${EXTERNAL_EVIDENCE_NUMERATOR_NOTE}` +
    renderExternalEvidenceStaleSuffix(externalEvidence.stalePrevious)
  );
}

// 파서는 옛 문면 «분류 대기» 도 읽는다 -- 새 버전 첫 회차에 reach-report 가 «옛 버전이 쓴
// 보고서 파일» 을 읽어도 직전 N 기억이 «줄 없음» 으로 끊기지 않게 하는 호환(렌더는 새 문면만).
const EXTERNAL_EVIDENCE_COUNT_RE =
  /^- 외부 독립 증거 후보: 확인 (\d+) · 미조회 (\d+) · (?:ㄴ 분자 반영|분류 대기)(?: · 스테일 표시\(확인 아님\): .*)?$/m;
const EXTERNAL_EVIDENCE_FAILED_RE =
  /^- 외부 독립 증거 후보: 수집 실패\((.*)\)$/m;

// 보고서 «텍스트»에서 위 줄을 다시 읽는다 -- reach-report.mjs 가 (수집기를
// 다시 돌리지 않고) 이미 쓰인 partial-count-report.md 를 읽어 N 이 바뀌었는지
// 판정할 때 쓴다. 줄 문면의 정본이 이 파일 한 곳이라 렌더와 파서가 어긋나지
// 않는다. {state: "count"|"failed"|"absent"}.
export function parseExternalEvidenceCandidateLine(reportText) {
  const text = typeof reportText === "string" ? reportText : "";
  const count = text.match(EXTERNAL_EVIDENCE_COUNT_RE);
  if (count) {
    return {
      state: "count",
      confirmed: Number(count[1]),
      unchecked: Number(count[2]),
    };
  }
  const failed = text.match(EXTERNAL_EVIDENCE_FAILED_RE);
  if (failed) return { state: "failed", reason: failed[1] };
  return { state: "absent" };
}

function buildLnSection(
  confirmedLnEvents,
  suspected,
  uncountedExamples,
  relayLedgerResult,
  externalEvidence,
  permissionAnswers,
) {
  const lines = ["ㄴ 계획 밖 개입:"];
  const confirmedCount =
    (Array.isArray(confirmedLnEvents) ? confirmedLnEvents.length : 0) +
    permissionHumanTotal(permissionAnswers);
  // 하한 표기: 수집이 성공했고(known) 미조회가 있는 회차에만. 입력 없음 · 수집 실패는 표기 0.
  const uncheckedForLowerBound =
    externalEvidence?.known === true ? externalEvidence.unchecked : 0;
  // HYK-255-p5a-perm-1 -- ㄴ 분자 = D1 확인분 + 권한 확인창 사람 답(N+W+U · 통역 포함). 판정 불가 K · 필드 없는 세션 ·
  // 읽기 실패 · 수집 실패는 «이상» 토막으로 하한을 알린다(permissionAnswers 없음 = 미결선 = 옛 문면 그대로).
  lines.push(
    `- 외부 독립 증거로 확인된 사건: ${renderConfirmedLnCount(confirmedCount, uncheckedForLowerBound, permissionGapPieces(permissionAnswers))}`,
  );
  const externalEvidenceLine =
    renderExternalEvidenceCandidateLine(externalEvidence);
  if (externalEvidenceLine) lines.push(externalEvidenceLine);
  const permissionLine = renderPermissionAnswersLine(permissionAnswers);
  if (permissionLine) lines.push(permissionLine);
  if (suspected.known === true) {
    const openNote =
      suspected.openCount > 0
        ? ` (재개 미확인 진행 중 ${suspected.openCount}축 별도 — 역시 미산입)`
        : "";
    lines.push(
      `- 무진행-재개 의심 구간: ${suspected.closedCount}건 — ㄴ 분자에 미산입${openNote}`,
    );
  } else {
    lines.push(
      `- 무진행-재개 의심 구간: UNKNOWN(${suspected.reason}) — ㄴ 분자에 미산입`,
    );
  }
  lines.push("- 상한: 알 수 없음");
  lines.push(
    `- 알려진 미계수 예시: ${uncountedExamples.items.length}개(${uncountedExamples.version}) — ` +
      `${uncountedExamples.items.join(" · ")}; 전체 유형의 분모가 아님`,
  );
  lines.push(...renderRelayLedgerAuxLines(relayLedgerResult));
  return lines;
}

function buildHealthSection({ collectors, lastAliveMs, coverageGaps }) {
  const lines = ["관측 건강:"];
  const parts = (collectors ?? []).map((c) => {
    // 성공이라도 부분 실패(파싱 스킵 등) detail은 삼키지 않고 병기한다.
    if (c.ok) return c.detail ? `${c.name} OK(${c.detail})` : `${c.name} OK`;
    return `${c.name} FAIL(${c.detail ?? "사유 미상"})`;
  });
  lines.push(
    `- 수집 성공/실패: ${parts.length > 0 ? parts.join(" · ") : "UNKNOWN(수집기 목록 없음)"}`,
  );
  lines.push(
    `- 마지막 생존 영수증: ${typeof lastAliveMs === "number" ? formatKst(lastAliveMs) : "UNKNOWN"}`,
  );
  if (coverageGaps.known === true) {
    const warn =
      coverageGaps.count > 0 ? " — 이 구간은 정상 측정 기간이 아니다" : "";
    lines.push(
      `- 관측 공백(coverage gap): ${coverageGaps.count}구간 · 합계 ${formatDurationKo(coverageGaps.totalMs)}${warn}`,
    );
  } else {
    lines.push(`- 관측 공백(coverage gap): UNKNOWN(${coverageGaps.reason})`);
  }
  return lines;
}

// buildPartialCountReport(input) -> 보고문 텍스트. 첫 줄 = PARTIAL 배너
// (필수 문면 1 -- 이 위에 아무것도 오지 않는다).
export function buildPartialCountReport({
  generatedAtMs,
  windowStartMs,
  windowEndMs,
  delivered,
  consumed,
  missingReceipts,
  gate4,
  auxNote = "미계수(이 라운드 결선된 보조 수집기 없음)",
  // HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓐ) -- 기본값 = v1(8).
  // "인자를 안 준 호출자"는 auxNote 기본값과 같은 뜻으로 "미결선"이라야
  // 하므로, 미계수 예시 쪽 기본값도 반드시 v1과 짝을 맞춘다(짝이
  // 어긋나면 미결선 실행에서 v2가 섞여 나오는 거짓 축소가 생긴다).
  uncountedExamples = UNCOUNTED_EXAMPLES_V1,
  confirmedLnEvents = [],
  suspected,
  collectors = [],
  lastAliveMs = null,
  coverageGaps,
  // HYK-255-relay-aux-1 (product_scope ②) -- 기본값 = undefined ->
  // renderRelayLedgerAuxLines([]) 그대로 -> 줄 0개(미결선, 회귀 0).
  relayLedgerResult,
  // HYK-255-ln-github-anchor-1 -- 기본값 undefined -> ㄴ 절 새 줄 0개
  // (미결선 호출자 회귀 0). confirmedLnEvents 와 «별개 입력»이다.
  externalEvidence,
  // HYK-255-g-aux-render-1 커밋 1 -- 기본값 undefined -> ㄱ 절 새 줄 0개(미결선
  // 호출자 회귀 0). 독립 앵커 입력(gate4)과 «별개 입력»이다.
  gateAuxObservation,
  // HYK-255-p1-daily-1 -- 기본값 undefined -> 새 줄 0개(미결선 호출자 회귀 0). 값은 watch-run 의 일별
  // 단계가 일별 줄 파일에서 읽어 만든 «연속 확인-0 일수» 한 줄(renderConfirmedZeroStreakLine). 문턱 판정 0.
  confirmedZeroStreakLine,
  // HYK-255-p5a-perm-1 -- 기본값 undefined -> ㄴ 절 새 줄 0개 · 분자 합산 0(미결선 호출자 회귀 0). 값 =
  // summarizePermissionRecords 결과 + 수집 부가 칸(wire 의 collectPermissionAnswers) 또는 {known:false, reason}.
  permissionAnswers,
}) {
  const lines = [];
  lines.push("집계 성격: PARTIAL — 전수 아님");
  lines.push(`생성 시각: ${formatKst(generatedAtMs)}`);
  lines.push(
    `측정 기간: ${formatKst(windowStartMs)} ~ ${formatKst(windowEndMs)}`,
  );
  lines.push("1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가");
  if (
    typeof confirmedZeroStreakLine === "string" &&
    confirmedZeroStreakLine !== ""
  ) {
    lines.push(confirmedZeroStreakLine);
  }
  lines.push("");
  lines.push(
    `라운드 분모: 배달 ${renderCount(delivered)} / 소비 ${renderCount(consumed)} / 영수증 결손 ${renderCount(missingReceipts)}`,
  );
  // HYK-255 2R 검토 반려 1 수리 -- 세 수치의 기준 단위가 서로 다르다
  // (배달·소비 = 영수증 «레코드» 수 · 결손 = 영수증 없는 «고유 라벨» 수).
  // 단위를 숨기면 독자가 «배달−소비=결손» 산식으로 오독한다. ⛔PM 표기
  // 규격의 분모 줄 자체는 그대로 두고 바로 다음 줄에 곁들인다.
  lines.push(
    "(기준 단위: 배달·소비 = 레코드 수 · 영수증 결손 = 영수증 없는 고유 라벨 수 — 단위가 달라 «배달−소비=결손»이 성립하지 않음)",
  );
  lines.push("");
  lines.push(...buildGaSection(gate4, auxNote, gateAuxObservation));
  lines.push("");
  lines.push(
    ...buildLnSection(
      confirmedLnEvents,
      suspected,
      uncountedExamples,
      relayLedgerResult,
      externalEvidence,
      permissionAnswers,
    ),
  );
  lines.push("");
  lines.push(...buildHealthSection({ collectors, lastAliveMs, coverageGaps }));
  lines.push("");
  lines.push(
    "금지 해석: «확인된 N건»은 «기간 내 총 N회» 또는 «ㄴ=0»을 뜻하지 않음",
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 아침 보고 편입 -- reach-report.mjs(runReachOnce)가 이 함수를 불러
// morning-report.md 끝에 부분 계수 절을 붙인다(1-B 요건 3: 한 줄 실행과
// 아침 보고 «양쪽» 도달). 파일이 없거나 오래됐으면 조용히 생략하지 않고
// UNKNOWN을 명시한다 -- «로그에만 적히고 사람이 못 보는 것» 금지의
// 역방향(보고가 없는데 있는 척)도 똑같이 금지다.
// ---------------------------------------------------------------------------

export const DEFAULT_PARTIAL_COUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const GENERATED_AT_RE = /^생성 시각: (.+ KST)$/m;

export function formatPartialCountSection({
  fileText,
  sourceLabel = "",
  nowMs,
  maxAgeMs = DEFAULT_PARTIAL_COUNT_MAX_AGE_MS,
}) {
  const lines = ["## 부분 계수 보고 (HYK-255)"];
  if (typeof fileText !== "string" || fileText.trim() === "") {
    lines.push(
      `UNKNOWN — 부분 계수 보고 파일 없음(${sourceLabel || "경로 미상"}).`,
    );
    lines.push(
      "생성하려면: node scripts/supervisor/partial-count-report.mjs --report-out <위 경로>",
    );
    return lines;
  }
  const m = fileText.match(GENERATED_AT_RE);
  const generatedMs = m ? parseKstTimestampMs(m[1]) : null;
  if (generatedMs === null) {
    lines.push(
      `⚠️ 생성 시각 UNKNOWN — 신선도 판정 불가(${sourceLabel}). 아래 내용의 시점을 신뢰하지 마라.`,
    );
  } else if (nowMs - generatedMs > maxAgeMs) {
    lines.push(
      `⚠️ 오래됨 — ${formatKst(generatedMs)} 생성(${formatDurationKo(nowMs - generatedMs)} 경과) — UNKNOWN 취급.`,
    );
  } else {
    lines.push(
      `생성 ${formatKst(generatedMs)} (${formatDurationKo(nowMs - generatedMs)} 전)`,
    );
  }
  lines.push("");
  lines.push(fileText.trimEnd());
  return lines;
}

// ---------------------------------------------------------------------------
// HYK-255-p1-daily-1 (판정 2205 ④ · 2305 ②③) -- 일별 마감 줄 · 연속 확인-0 일수.
//
// 이 절은 «적기만» 한다. 며칠 · 몇 트랙 같은 문턱 판정(P2 몫) · 자격 있음/없음 · 위의 «1-C 판정
// 자격» 줄은 만들지도 바꾸지도 않는다. I/O 0(§2 원칙) -- 파일 읽기·쓰기는 watch-run 의 몫이다.
//
//   일별 상태(partial-count-daily-state.json) = 오늘 값 하나, 회차마다 덮어쓴다.
//   일별 줄(partial-count-daily.jsonl)         = 지나간 날 줄만, 덧붙이기 전용 · 한 번 쓴 줄은 고치지 않는다.
//   날 경계 = KST 자정(formatKst 와 같은 UTC+9 고정).
//   관측 공백 = 같은 날 안에서 연속한 두 회차 간격이 20분 초과, 또는 00:00 -> 그날 첫 회차가 20분 초과,
//              또는 그날 마지막 회차 -> 24:00 이 20분 초과(마감 때 판정). 근거(ORCH 실측 wake-receipts
//              최근 14일 1,173 회차): 15분 회차 + 5분 여유를 넘으면 누락.
//   그날 줄의 값 = 그날 «마지막 회차»의 값(확인 · 미조회 · 수집 실패) -- 재조회 0 · REST 무증가.
//   ⛔캐시는 승인 권위가 아니다 -- 일별 줄은 «그 회차에 이미 센 값의 기록»이지 다음 회차 확인의 근거가 아니다.
// ---------------------------------------------------------------------------

export const DAILY_SCHEMA = "partial-count-daily/v1";
export const DAILY_STATE_SCHEMA = "partial-count-daily-state/v1";
export const DAILY_COVERAGE_GAP_MS = 20 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function kstDayOf(ms) {
  return formatKst(ms).slice(0, 10);
}

export function kstDayStartMs(day) {
  return parseKstTimestampMs(`${day} 00:00 KST`);
}

function addKstDays(day, n) {
  return kstDayOf(kstDayStartMs(day) + n * DAY_MS);
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

// HYK-255-p1fix-1 (판정 0206 ④ 가) -- 예시 식별자. 일별 줄의 이 칸은 «알려진 미계수 예시가 몇 개였나» 를 적는다.
// 값 = «V<판본>-<순번>»(예 V3-2). 1-C 설계의 U-id(U1 = 열린 집합 …)와 문자열이 겹치지 않도록 접두를 판본으로 둔다.
// 판본을 못 읽으면 접두 VX(U 와 겹치지 않는 쪽).
function exampleIdPrefix(version) {
  const m = /(?:^|\/)v(\d+)$/i.exec(typeof version === "string" ? version : "");
  return m ? `V${m[1]}` : "VX";
}

function exampleIdsOf(count, version) {
  const prefix = exampleIdPrefix(version);
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

// 읽는 쪽 -- 새 칸 이름(uncountedExampleIds)이 있으면 그것, 없으면 «옛 칸 이름»(uncountedRanges · U1..) 줄 · 상태 ·
// 회차 값도 읽는다(옛 칸 이름은 개수만 믿고 V 꼴로 옮긴다). 둘 다 없으면 null.
function readUncountedExampleIds(source) {
  if (Array.isArray(source?.uncountedExampleIds)) {
    return source.uncountedExampleIds.map(String);
  }
  if (Array.isArray(source?.uncountedRanges)) {
    return exampleIdsOf(source.uncountedRanges.length, source.uncountedVersion);
  }
  return null;
}

// 그 회차 값 -> 일별 칸 값. 못 센 값은 null(0 으로 접지 않는다) -- 읽는 쪽이 null 을 끊김으로 본다.
export function buildDailyTickValues({
  externalEvidence,
  collectors,
  delivered,
  uncountedExamples,
  // HYK-255-p5a-perm-1 -- 없으면(미결선) 새 두 칸을 «싣지 않는다»(옛 회차 값 모양 그대로).
  permissionAnswers,
}) {
  const items = Array.isArray(uncountedExamples?.items)
    ? uncountedExamples.items
    : [];
  return {
    ...pickExternalEvidenceCounts(externalEvidence),
    ...pickPermissionColumns(permissionAnswers),
    collectorFails: failedCollectorNames(collectors),
    delivered:
      delivered?.known === true && isCount(delivered.count)
        ? delivered.count
        : null,
    uncountedExampleIds: exampleIdsOf(items.length, uncountedExamples?.version),
    uncountedVersion: uncountedExamples?.version ?? null,
  };
}

// ㄴ 분자(확인) · 미조회 -- 수집이 known 일 때만 센다. 수집 실패 · 미결선은 null(0 이 아니다).
function pickExternalEvidenceCounts(externalEvidence) {
  const known = externalEvidence?.known === true;
  const shas =
    known && Array.isArray(externalEvidence.confirmedShas)
      ? externalEvidence.confirmedShas
      : null;
  return {
    lnConfirmed: shas ? shas.length : null,
    lnUnchecked:
      known && isCount(externalEvidence.unchecked)
        ? externalEvidence.unchecked
        : null,
  };
}

// FAIL 인 수집기 이름(괄호 뒤 가변 꼬리 제거 · 중복 제거).
function failedCollectorNames(collectors) {
  const names = (Array.isArray(collectors) ? collectors : [])
    .filter((c) => c && c.ok !== true)
    .map((c) => String(c.name ?? "이름 미상").replace(/\(.*$/s, ""));
  return [...new Set(names)];
}

// 단계가 던졌거나 결과에 값이 없는 회차 -- «회차가 돌았다» 는 사실은 남기되 그날을 0 으로 세지 않는다.
export function dailyFailureTick(reason) {
  return {
    lnConfirmed: null,
    lnUnchecked: null,
    collectorFails: [reason],
    delivered: null,
    uncountedExampleIds: [],
    uncountedVersion: null,
  };
}

// 주입·옛 수집기의 결과 모양을 믿지 않는다 -- 모양이 틀리면 «값 없음» 실패 회차로 접는다.
export function normalizeDailyTick(tick) {
  if (!tick || typeof tick !== "object" || Array.isArray(tick)) {
    return dailyFailureTick("일별 회차 값 없음");
  }
  const fails = Array.isArray(tick.collectorFails)
    ? tick.collectorFails.map(String)
    : ["수집 실패 목록 모양 오류"];
  return {
    lnConfirmed: isCount(tick.lnConfirmed) ? tick.lnConfirmed : null,
    lnUnchecked: isCount(tick.lnUnchecked) ? tick.lnUnchecked : null,
    ...normalizePermissionColumns(tick),
    collectorFails: fails,
    delivered: isCount(tick.delivered) ? tick.delivered : null,
    uncountedExampleIds: readUncountedExampleIds(tick) ?? [],
    uncountedVersion:
      typeof tick.uncountedVersion === "string" ? tick.uncountedVersion : null,
  };
}

function freshDailyState(day) {
  return {
    schema: DAILY_STATE_SCHEMA,
    day,
    firstTickAtMs: null,
    lastTickAtMs: null,
    ticks: 0,
    gapCount: 0,
    gapTotalMs: 0,
    lnConfirmed: null,
    lnUnchecked: null,
    collectorFails: [],
    concurrentTracksMax: null,
    delivered: null,
    uncountedExampleIds: [],
    uncountedVersion: null,
  };
}

export function isValidDailyState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  if (state.schema !== DAILY_STATE_SCHEMA) return false;
  if (typeof state.day !== "string" || !DAY_RE.test(state.day)) return false;
  if (!isCount(state.ticks) || !isCount(state.gapCount)) return false;
  if (!Number.isFinite(state.gapTotalMs) || state.gapTotalMs < 0) return false;
  return state.ticks === 0 || hasTickTimes(state);
}

function hasTickTimes(state) {
  return (
    Number.isFinite(state.firstTickAtMs) && Number.isFinite(state.lastTickAtMs)
  );
}

// HYK-255-p1fix-1 (판정 0206 ④ 나) -- 날을 건너는 회차 간격(직전 회차 -> 이번 회차)을 «한 번만» 잰다.
// 20분 초과면 공백이고, 그 간격이 KST 자정을 걸쳤으면 두 날 각각에 공백 1 을 준다 -- 각 날의 몫 = 그 날 안에 든 길이
// (전날 = 마지막 회차 -> 24:00 · 새 날 = 00:00 -> 이번 회차). 양쪽을 따로 20분과 견주지 않는다(23:41 -> 00:20 = 39분 =
// 몫 19 · 20 이라 따로 보면 어느 날도 공백 0 이 되는 거짓 0 방향 결함이었다). 20분 기준 자체는 무변(초과만 공백).
function measureDayCrossingInterval({ prevTickAtMs, nowMs }) {
  const prevDayEndMs = kstDayStartMs(kstDayOf(prevTickAtMs)) + DAY_MS;
  return {
    gap: nowMs - prevTickAtMs > DAILY_COVERAGE_GAP_MS,
    prevDayShareMs: prevDayEndMs - prevTickAtMs,
    nowDayShareMs: nowMs - kstDayStartMs(kstDayOf(nowMs)),
  };
}

// HYK-255-p1fix-1 (판정 0206 ④ 다) -- 마감 줄의 창 시작 = 직전 일별 줄(같은 파일의 마지막 줄 · 읽기만)의 창 끝 -- 날 사이
// 틈 0. 직전 줄이 «어제» 줄이 아니면(첫 날 · 여러 날 건너뜀 뒤 첫 줄) = 그날 첫 회차의 창 시작(첫 회차 - 24h).
// 직전 줄의 창 끝이 이 날 첫 회차보다 뒤로 어긋나 있으면(값이 틀린 줄) 믿지 않고 같은 대체값을 쓴다.
// 직전 줄은 «창 경계» 로만 읽는다 -- 확인 값의 근거로 쓰지 않는다(판정 1910).
function closedWindowStartMs(state, previousDailyLine) {
  const prev = previousDailyLine;
  const adjacent =
    prev?.schema === DAILY_SCHEMA &&
    prev.day === addKstDays(state.day, -1) &&
    Number.isFinite(prev.windowEndMs) &&
    prev.windowEndMs <= state.firstTickAtMs;
  return adjacent ? prev.windowEndMs : state.firstTickAtMs - DAY_MS;
}

// 마감 줄 = 그날 상태 + 날을 건넌 회차 간격의 전날 몫. 값은 그날 마지막 회차의 값 그대로.
function buildClosedDailyLine({
  state,
  closedAtMs,
  interval,
  previousDailyLine,
}) {
  const tailGap = interval.gap;
  const tailMs = interval.prevDayShareMs;
  return {
    schema: DAILY_SCHEMA,
    day: state.day,
    windowStartMs: closedWindowStartMs(state, previousDailyLine),
    windowEndMs: state.lastTickAtMs,
    closedAtMs,
    firstTickAtMs: state.firstTickAtMs,
    lastTickAtMs: state.lastTickAtMs,
    ticks: state.ticks,
    lnConfirmed: state.lnConfirmed,
    lnUnchecked: state.lnUnchecked,
    ...normalizePermissionColumns(state),
    collectorFails: state.collectorFails,
    coverageGaps: {
      count: state.gapCount + (tailGap ? 1 : 0),
      totalMs: state.gapTotalMs + (tailGap ? tailMs : 0),
    },
    concurrentTracksMax: state.concurrentTracksMax,
    delivered: state.delivered,
    uncountedExampleIds: readUncountedExampleIds(state) ?? [],
    uncountedVersion: state.uncountedVersion,
  };
}

// 날이 바뀐 첫 회차 -- 전날 상태가 유효하고(회차 ≥ 1) 그 날 줄이 아직 없으면 줄 1개를 돌려준다.
// closedDays = 일별 파일에 이미 있는 날 집합(재실행이 같은 날 줄을 또 쓰지 않게 -- 덧붙이기 전용).
// 상태가 없거나 깨졌으면 줄을 지어내지 않는다(그 날은 줄 없음 = 끊김).
// previousDailyLine = 같은 파일의 마지막 일별 줄(창 시작을 이어 붙일 때만 읽는다 · 없으면 null).
// 직전 회차를 아는 새 날은 간격을 여기서 «한 번» 재어 그 날 몫을 상태에 미리 적는다(openingGapSettled).
export function rolloverDailyState({
  state,
  nowMs,
  closedDays,
  previousDailyLine = null,
}) {
  const today = kstDayOf(nowMs);
  const valid = isValidDailyState(state);
  if (valid && state.day === today) return { state, closedLine: null };
  const crossing = valid && state.day < today && state.ticks > 0;
  const interval = crossing
    ? measureDayCrossingInterval({
        prevTickAtMs: state.lastTickAtMs,
        nowMs,
      })
    : null;
  const closable =
    crossing && !(closedDays instanceof Set && closedDays.has(state.day));
  return {
    state: openDailyState(today, interval),
    closedLine: closable
      ? buildClosedDailyLine({
          state,
          closedAtMs: nowMs,
          interval,
          previousDailyLine,
        })
      : null,
  };
}

function openDailyState(today, interval) {
  const opened = freshDailyState(today);
  if (!interval) return opened;
  return {
    ...opened,
    gapCount: interval.gap ? 1 : 0,
    gapTotalMs: interval.gap ? interval.nowDayShareMs : 0,
    openingGapSettled: true,
  };
}

function maxNullable(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

// 이 회차를 오늘 상태에 적는다 -- 값은 덮어쓰고(마지막 회차 값) 동시 배달은 최대, 공백은 누적.
// 간격 기준점 = 오늘 첫 회차면 00:00, 아니면 직전 회차. 초과(> 20분)만 공백(정확히 20분은 아님).
export function recordDailyTick({ state, nowMs, tick, concurrentActive }) {
  const today = kstDayOf(nowMs);
  const base =
    isValidDailyState(state) && state.day === today
      ? state
      : freshDailyState(today);
  const prevMs = base.ticks > 0 ? base.lastTickAtMs : kstDayStartMs(today);
  const spanMs = nowMs - prevMs;
  // 날을 건넌 첫 회차의 간격은 rolloverDailyState 가 이미 한 번 쟀다(openingGapSettled) -- 여기서 00:00 기준으로 또 재지 않는다.
  const settled = base.ticks === 0 && base.openingGapSettled === true;
  const gap = !settled && spanMs > DAILY_COVERAGE_GAP_MS;
  const t = normalizeDailyTick(tick);
  // 권한 두 칸은 «마지막 회차 값» 규칙대로 덮어쓴다 -- 이번 회차 값에 칸이 없으면(미결선) 앞 회차 값도 남기지 않는다.
  // 옛 칸 이름 상태(uncountedRanges)는 새 칸 이름으로 덮고 옛 칸은 남기지 않는다.
  const carried = { ...base };
  delete carried.permissionHumanAnswers;
  delete carried.permissionUndecidable;
  delete carried.uncountedRanges;
  delete carried.openingGapSettled;
  return {
    ...carried,
    ...normalizePermissionColumns(t),
    firstTickAtMs: base.ticks > 0 ? base.firstTickAtMs : nowMs,
    lastTickAtMs: nowMs,
    ticks: base.ticks + 1,
    gapCount: base.gapCount + (gap ? 1 : 0),
    gapTotalMs: base.gapTotalMs + (gap ? spanMs : 0),
    lnConfirmed: t.lnConfirmed,
    lnUnchecked: t.lnUnchecked,
    collectorFails: t.collectorFails,
    delivered: t.delivered,
    uncountedExampleIds: t.uncountedExampleIds,
    uncountedVersion: t.uncountedVersion,
    concurrentTracksMax: maxNullable(
      base.concurrentTracksMax,
      isCount(concurrentActive) ? concurrentActive : null,
    ),
  };
}

// 일별 파일 텍스트 -> 줄 객체들. 깨진 줄은 건너뛰되 개수를 센다(그 날은 줄 없음으로 끊김).
export function parseDailyLines(text) {
  const lines = [];
  let malformed = 0;
  for (const raw of String(text ?? "").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lines.push(parsed);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { lines, malformed };
}

// 그날을 «0 으로 이어진 날» 로 세지 못하게 하는 사유들. 하나라도 있으면 끊김.
// 값 모름(null · 모양 오류)은 0 이 아니라 사유다(UNKNOWN 을 0 으로 접지 않는다 · Q-5 잠정).
function dailyBreakReasons(line) {
  const reasons = [];
  if (line.lnUnchecked !== 0) {
    reasons.push(
      isCount(line.lnUnchecked)
        ? `미조회 ${line.lnUnchecked}`
        : "미조회 UNKNOWN",
    );
  }
  if (line.lnConfirmed !== 0) {
    reasons.push(
      isCount(line.lnConfirmed) ? `확인 ${line.lnConfirmed}` : "확인 UNKNOWN",
    );
  }
  if (!Array.isArray(line.collectorFails)) {
    reasons.push("수집 실패 UNKNOWN");
  } else if (line.collectorFails.length > 0) {
    reasons.push(`수집 실패(${line.collectorFails.join("·")})`);
  }
  const gaps = line.coverageGaps;
  if (!gaps || typeof gaps !== "object" || !isCount(gaps.count)) {
    reasons.push("관측 공백 UNKNOWN");
  } else if (gaps.count > 0) {
    reasons.push(`관측 공백 ${gaps.count}구간`);
  }
  reasons.push(...permissionBreakReasons(line));
  return reasons;
}

function groupDailyLinesByDay(lines) {
  const byDay = new Map();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || l.schema !== DAILY_SCHEMA || !DAY_RE.test(String(l.day))) {
      continue;
    }
    byDay.set(l.day, [...(byDay.get(l.day) ?? []), l]);
  }
  return byDay;
}

// 그날 줄들 -> 끊김 사유(없으면 []). 줄 없는 날 · 같은 날 줄이 둘 = 끊김.
function breakReasonsForDay(entries) {
  if (!entries) return ["줄 없음"];
  if (entries.length > 1) return [`줄 중복 ${entries.length}`];
  return dailyBreakReasons(entries[0]);
}

// 연속 확인-0 일수(읽는 쪽 · 순수 함수 · 문턱 0). 어제부터 거꾸로, 날마다
//   미조회 0 ∧ 확인 0 ∧ 수집 실패 [] ∧ 관측 공백 0 인 날만 센다.
// 줄 없는 날 · 같은 날 줄이 둘인 날 = 끊김. 오늘(미마감)은 세지 않는다(어제부터 시작).
export function computeConfirmedZeroStreak({ lines, nowMs }) {
  const byDay = groupDailyLinesByDay(lines);
  let day = addKstDays(kstDayOf(nowMs), -1);
  let days = 0;
  let uncountedRangeCount = null;
  for (;;) {
    const entries = byDay.get(day);
    const reasons = breakReasonsForDay(entries);
    if (reasons.length > 0) {
      return {
        known: true,
        days,
        lastBreak: { day, reasons },
        uncountedRangeCount,
      };
    }
    if (days === 0) {
      // 읽는 쪽은 옛 칸 이름(uncountedRanges)과 새 칸 이름(uncountedExampleIds) 둘 다 받는다(덧붙이기 전용이라 옛 줄이 남는다).
      const ids = readUncountedExampleIds(entries[0]);
      uncountedRangeCount = ids ? ids.length : null;
    }
    days += 1;
    day = addKstDays(day, -1);
  }
}

// 보고 줄 -- «ㄴ=0 N일» 문면은 쓰지 않는다(표기 규율). 0 일이어도 끊긴 날짜·사유를 적는다.
export function renderConfirmedZeroStreakLine(streak) {
  const prefix = "연속 확인-0 일수: ";
  if (!streak || streak.known !== true) {
    return `${prefix}UNKNOWN(${streak?.reason ?? "사유 미상"})`;
  }
  const range =
    streak.days > 0 && Number.isInteger(streak.uncountedRangeCount)
      ? ` 미계수 범위 ${streak.uncountedRangeCount}개 동반 ·`
      : "";
  const brk = streak.lastBreak;
  return (
    `${prefix}${streak.days}일(부분 —${range} ` +
    `마지막 끊김 ${brk.day} ${brk.reasons.join(", ")})`
  );
}

// ---------------------------------------------------------------------------
// HYK-255-p5a-perm-1 (판정 2026-11-14 0105 ④ · P5 설계 (가)(다) P5a 행) -- ㄴ 유형 4 «권한 확인창 답» 분류 · 합산 ·
// 렌더 · 일별 새 칸 2. I/O 0(§2 원칙) -- 세션 jsonl 을 읽는 것은 wire(partial-count-report.mjs
// collectPermissionAnswers)의 몫이고, 이 절은 그 wire 가 «쓰는 칸만» 뽑아 넘긴 레코드를 센다.
//
// ⛔본문 무접촉: 이 절의 입력 레코드에는 대화 본문 칸(메시지 text · content · input · toolUseResult 값)이 없다 --
// {sessionKey, uid, toolUseId, atMs, cwd, rootName, entrypoint, version, hasDecision, decision{decision, source},
// toolName}. 출력(요약 · 렌더 · 일별 칸)도 건수 · 시각 · 도구 이름 · 판정 값 이름뿐이다.
//
// 분류 정본(설계 (가) 표 · 벤더 CLI 2.1.322 내장 설명): source ∈ {config, classifier, hook} = 자동 M ·
// {user_temporary, user_permanent, user_reject, user_abort} = 사람 답 N · {invalid_input,
// permission_updated_input_invalid, server_fallback_tombstone} = 기계 종료 W · 그 밖 모든 것(모르는 source ·
// source 없음 · 문자열 아님 · decision 이 accept/reject/cancelled 밖) = 모르는 값 U. N · W · U 가 ㄴ 분자다
// («애매하면 ㄴ» · 한용 확정 문면). 판정 칸 자체가 없는 tool_result = 판정 불가 K(하한). 판정 칸이 없는 세션 =
// 필드 없는 세션 S(수집 실패 · 그날 끊김).
// ---------------------------------------------------------------------------

// 판정 칸이 처음 생긴 Claude Code CLI 판(설계 §E2 · §E4). 이보다 낮거나 모르는 판의 «판정 없는 tool_result» 는
// K(하한)가 아니라 «측정 불가» 라 세션 단위 수집 실패(S)로 센다.
export const PERMISSION_MIN_VERSION = "2.1.322";

export const PERMISSION_CLASS = Object.freeze({
  AUTO: "M",
  HUMAN: "N",
  MACHINE_END: "W",
  UNKNOWN: "U",
});

const PERMISSION_AUTO_SOURCES = new Set(["config", "classifier", "hook"]);
const PERMISSION_HUMAN_SOURCES = new Set([
  "user_temporary",
  "user_permanent",
  "user_reject",
  "user_abort",
]);
const PERMISSION_MACHINE_END_SOURCES = new Set([
  "invalid_input",
  "permission_updated_input_invalid",
  "server_fallback_tombstone",
]);
const PERMISSION_DECISIONS = new Set(["accept", "reject", "cancelled"]);

// 판정 칸 {decision, source} -> M | N | W | U. 칸 모양이 틀리면 U(분자 쪽 -- 애매하면 ㄴ).
export function classifyPermissionDecision(permissionDecision) {
  const pd = permissionDecision;
  if (!pd || typeof pd !== "object" || Array.isArray(pd)) {
    return PERMISSION_CLASS.UNKNOWN;
  }
  if (typeof pd.source !== "string" || !PERMISSION_DECISIONS.has(pd.decision)) {
    return PERMISSION_CLASS.UNKNOWN;
  }
  if (PERMISSION_AUTO_SOURCES.has(pd.source)) return PERMISSION_CLASS.AUTO;
  if (PERMISSION_HUMAN_SOURCES.has(pd.source)) return PERMISSION_CLASS.HUMAN;
  if (PERMISSION_MACHINE_END_SOURCES.has(pd.source)) {
    return PERMISSION_CLASS.MACHINE_END;
  }
  return PERMISSION_CLASS.UNKNOWN;
}

function parseVersionTuple(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(
    typeof version === "string" ? version : "",
  );
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// «이 판의 CLI 는 tool_result 에 판정 칸을 적는다» -- 모르는 판 · 파싱 불가 판 = false(측정 불가 쪽).
export function isPermissionFieldVersion(version) {
  const have = parseVersionTuple(version);
  const min = parseVersionTuple(PERMISSION_MIN_VERSION);
  if (have === null || min === null) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== min[i]) return have[i] > min[i];
  }
  return true;
}

// ---- 좌석 범위 -- 가르는 열쇠 = 판정 줄의 cwd (폴더 이름은 한글이 «-» 로 뭉개져 못 쓴다 · 설계 §E5) ----

// 세션 뿌리의 «종류» -- 엔진 이름이 아니라 엔진 프로필(scripts/check/engine-profiles.json)의 칸 이름을 따른다:
// HOME = homeDirName 뿌리(대화형 본체 좌석 · ORCH · 통역이 앉는 곳) · TEAM = teamDirName 뿌리(워커 좌석).
// 이 파일에 엔진 이름 문자열을 새로 적지 않는다(engine-name-literal 기준선 · HYK-153).
export const PERMISSION_ROOT_KIND = Object.freeze({
  HOME: "home",
  TEAM: "team",
});

export const PERMISSION_SEAT = Object.freeze({
  ORCH: "ORCH",
  WORKER_HARNESS: "워커H",
  WORKER_OTHER: "워커E",
  WORKER_MAIN: "워커본체",
  INTERPRETER: "통역",
  UNCLASSIFIED: "미분류",
  OUT_OF_LANE: "레인밖",
});

const PERMISSION_LANE_SEATS = Object.freeze([
  PERMISSION_SEAT.ORCH,
  PERMISSION_SEAT.WORKER_HARNESS,
  PERMISSION_SEAT.WORKER_OTHER,
  PERMISSION_SEAT.WORKER_MAIN,
  PERMISSION_SEAT.INTERPRETER,
  PERMISSION_SEAT.UNCLASSIFIED,
]);

// 경로 비교용 정규형 -- 슬래시 통일 · 끝 슬래시 제거 · 소문자. 못 쓰는 값 = null.
export function normalizeSessionPath(p) {
  if (typeof p !== "string") return null;
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n === "" ? null : n;
}

// 부모 폴더(정규형). 통역 폴더 = 이미 있는 --outbox-dir 값의 부모 -- 새 CLI 인자 0 (설계 (다)).
export function parentDirOf(p) {
  const n = normalizeSessionPath(p);
  if (n === null) return null;
  const cut = n.lastIndexOf("/");
  return cut > 0 ? n.slice(0, cut) : null;
}

function isUnderPath(cwd, base) {
  return base !== null && (cwd === base || cwd.startsWith(`${base}/`));
}

// 좌석 경로 뿌리 -- 전부 홈 폴더에서 «파생» 한다(관제실 절대 경로 박기 0 · 설계 (가) 좌석 범위 표).
//   ORCH 자리 = <홈>/Documents/HARNESSENGINEERING (orca-adapter.mjs MAIN_REPO_PATH 와 같은 값 -- 시험이 대조한다)
//   워커 = <홈>/orca/workspaces/... (HARNESSENGINEERING 아래 = 하네스 워커 · 그 밖 = 다른 제품 워커)
//   통역 = outboxDir 의 부모 폴더(호출자가 넘긴 interpreterRoot)
export function deriveSeatRoots({ homeDir, interpreterRoot }) {
  const home = normalizeSessionPath(homeDir);
  return {
    main: home === null ? null : `${home}/documents/harnessengineering`,
    workspaces: home === null ? null : `${home}/orca/workspaces`,
    harnessWorkspaces:
      home === null ? null : `${home}/orca/workspaces/harnessengineering`,
    interpreter: normalizeSessionPath(interpreterRoot),
  };
}

// cwd + 어느 뿌리(.claude / .claude-team)의 세션인가 -> 좌석 종류. cwd 없음 = 미분류(애매하면 ㄴ · 제외 아님).
// 레인 밖은 «.claude 쪽에서 어디에도 안 맞는 cwd» 뿐이다 -- .claude-team 의 안 맞는 cwd 는 미분류(포함).
export function classifySessionSeat({ cwd, rootName, roots }) {
  const c = normalizeSessionPath(cwd);
  if (c === null) return PERMISSION_SEAT.UNCLASSIFIED;
  if (isUnderPath(c, roots.interpreter)) return PERMISSION_SEAT.INTERPRETER;
  if (isUnderPath(c, roots.main)) {
    return rootName === PERMISSION_ROOT_KIND.HOME
      ? PERMISSION_SEAT.ORCH
      : PERMISSION_SEAT.WORKER_MAIN;
  }
  if (isUnderPath(c, roots.harnessWorkspaces)) {
    return PERMISSION_SEAT.WORKER_HARNESS;
  }
  if (isUnderPath(c, roots.workspaces)) return PERMISSION_SEAT.WORKER_OTHER;
  return rootName === PERMISSION_ROOT_KIND.TEAM
    ? PERMISSION_SEAT.UNCLASSIFIED
    : PERMISSION_SEAT.OUT_OF_LANE;
}

// ---- 요약 -- 레코드(쓰는 칸만) -> 건수 --------------------------------------------------

// 값 이름 칸(source · 도구 이름)에 «이름처럼 생긴 것» 만 싣는다 -- 형식 밖 문자열은 그대로 옮기지 않는다(본문 유입 차단).
function safeNameToken(value) {
  if (typeof value !== "string" || value === "") return "(없음)";
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "(형식 밖)";
}

function newPermissionAccumulator() {
  return {
    human: 0,
    machineEnd: 0,
    unknownValue: 0,
    auto: 0,
    sdkAnswers: 0,
    duplicates: 0,
    undated: 0,
    sessions: new Map(),
    excludedSessions: new Set(),
    excludedHuman: 0,
    bySeat: Object.fromEntries(
      PERMISSION_LANE_SEATS.map((seat) => [seat, { human: 0, auto: 0 }]),
    ),
    byKstDay: {},
    humanEvents: [],
  };
}

const PERMISSION_HUMAN_FIELD = Object.freeze({
  [PERMISSION_CLASS.HUMAN]: "human",
  [PERMISSION_CLASS.MACHINE_END]: "machineEnd",
  [PERMISSION_CLASS.UNKNOWN]: "unknownValue",
});

// 판정 칸이 있는 레코드 1건을 센다(레인 안).
function addPermissionDecision(acc, record, seat, cls) {
  if (cls === PERMISSION_CLASS.AUTO) {
    acc.auto += 1;
    acc.bySeat[seat].auto += 1;
    return;
  }
  acc[PERMISSION_HUMAN_FIELD[cls]] += 1;
  acc.bySeat[seat].human += 1;
  if (record.entrypoint !== "cli") acc.sdkAnswers += 1;
  const day = kstDayOf(record.atMs);
  acc.byKstDay[day] = (acc.byKstDay[day] ?? 0) + 1;
  acc.humanEvents.push({
    atMs: record.atMs,
    seat,
    source: safeNameToken(record.decision?.source),
    toolName: safeNameToken(record.toolName),
  });
}

function addPermissionLaneRecord(acc, record, seat) {
  const key =
    typeof record.sessionKey === "string" ? record.sessionKey : "(세션 미상)";
  const session = acc.sessions.get(key) ?? {
    withDecision: 0,
    noDecisionNew: 0,
    noDecisionOld: 0,
  };
  acc.sessions.set(key, session);
  if (record.hasDecision === true) {
    session.withDecision += 1;
    addPermissionDecision(
      acc,
      record,
      seat,
      classifyPermissionDecision(record.decision),
    );
    return;
  }
  if (isPermissionFieldVersion(record.version)) session.noDecisionNew += 1;
  else session.noDecisionOld += 1;
}

function addPermissionExcludedRecord(acc, record) {
  acc.excludedSessions.add(
    typeof record.sessionKey === "string" ? record.sessionKey : "(세션 미상)",
  );
  if (
    record.hasDecision === true &&
    classifyPermissionDecision(record.decision) !== PERMISSION_CLASS.AUTO
  ) {
    acc.excludedHuman += 1;
  }
}

// 이어받기(resume)는 앞 대화 줄을 새 파일에 다시 적을 수 있다 -- 줄 uuid + tool_use_id 가 같으면 한 건이다.
function isDuplicatePermissionRecord(seen, record) {
  if (typeof record.uid !== "string" || record.uid === "") return false;
  const key = `${record.uid}|${record.toolUseId ?? ""}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

// 세션 단위 마감 -- 판정 칸이 한 줄도 없는 세션 · 판정 칸 없던 구판 줄이 섞인 세션 = S(수집 실패), 그 밖 세션의
// 판정 없는 tool_result = K(하한).
function finalizePermissionSessions(acc) {
  let fieldMissingSessions = 0;
  let undecided = 0;
  for (const s of acc.sessions.values()) {
    if (s.noDecisionOld > 0 || s.withDecision === 0) fieldMissingSessions += 1;
    else undecided += s.noDecisionNew;
  }
  return { fieldMissingSessions, undecided };
}

export function summarizePermissionRecords({
  records,
  windowStartMs,
  windowEndMs,
  roots,
}) {
  const acc = newPermissionAccumulator();
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !Number.isFinite(record.atMs)) {
      acc.undated += 1;
      continue;
    }
    if (record.atMs < windowStartMs || record.atMs > windowEndMs) continue;
    if (isDuplicatePermissionRecord(seen, record)) {
      acc.duplicates += 1;
      continue;
    }
    const seat = classifySessionSeat({
      cwd: record.cwd,
      rootName: record.rootName,
      roots,
    });
    if (seat === PERMISSION_SEAT.OUT_OF_LANE) {
      addPermissionExcludedRecord(acc, record);
    } else {
      addPermissionLaneRecord(acc, record, seat);
    }
  }
  const { fieldMissingSessions, undecided } = finalizePermissionSessions(acc);
  return {
    known: true,
    sessions: acc.sessions.size,
    human: acc.human,
    machineEnd: acc.machineEnd,
    unknownValue: acc.unknownValue,
    humanTotal: acc.human + acc.machineEnd + acc.unknownValue,
    auto: acc.auto,
    undecided,
    fieldMissingSessions,
    sdkAnswers: acc.sdkAnswers,
    interpreterAnswers: acc.bySeat[PERMISSION_SEAT.INTERPRETER].human,
    bySeat: acc.bySeat,
    excluded: {
      sessions: acc.excludedSessions.size,
      human: acc.excludedHuman,
    },
    duplicates: acc.duplicates,
    undated: acc.undated,
    byKstDay: acc.byKstDay,
    humanEvents: acc.humanEvents.sort((a, b) => a.atMs - b.atMs),
  };
}

// ---- 합산 · 렌더 · 일별 칸 ------------------------------------------------------------

// ㄴ 분자에 더해지는 사람 답(N+W+U · 통역 · SDK 포함). 수집 실패 · 미결선 = 0(더하지 않는다 -- 실패는 gapPieces 가 알린다).
export function permissionHumanTotal(permissionAnswers) {
  return permissionAnswers?.known === true &&
    isCount(permissionAnswers.humanTotal)
    ? permissionAnswers.humanTotal
    : 0;
}

const readCount = (value) => (isCount(value) ? value : 0);

// 센 값이 실제보다 작을 수 있는 사유 토막(= 분자 «이상» 표기를 켜는 것). 미결선 = [].
export function permissionGapPieces(permissionAnswers) {
  if (permissionAnswers === undefined || permissionAnswers === null) return [];
  if (permissionAnswers.known !== true) return ["권한기록 수집 실패"];
  const p = permissionAnswers;
  const pieces = [];
  if (readCount(p.undecided) > 0) pieces.push(`판정 불가 ${p.undecided}`);
  if (readCount(p.fieldMissingSessions) > 0) {
    pieces.push(`권한기록 필드 없는 세션 ${p.fieldMissingSessions}`);
  }
  if (readCount(p.readFailures) > 0) {
    pieces.push(`권한기록 읽기 실패 ${p.readFailures}파일`);
  }
  return pieces;
}

const PERMISSION_LINE_PREFIX = "- 권한 확인창 사람 답(B · 세션 기록): ";

function seatHumanTotal(bySeat, seats) {
  return seats.reduce((sum, seat) => sum + readCount(bySeat?.[seat]?.human), 0);
}

// ㄴ 절 B 줄 -- «확인 N건[ 이상](통역 · SDK · 판정 불가 · 레인 밖 제외)» + 좌석별 + 자동 건수. 미결선 = null.
// 수집 실패는 bare 0 이 아니라 «수집 실패(사유)».
export function renderPermissionAnswersLine(permissionAnswers) {
  if (permissionAnswers === undefined || permissionAnswers === null) {
    return null;
  }
  const p = permissionAnswers;
  if (p.known !== true) {
    return `${PERMISSION_LINE_PREFIX}수집 실패(${p.reason ?? "사유 미상"}) — ㄴ 확인 건수에 미반영`;
  }
  const lower = permissionGapPieces(p).length > 0 ? " 이상" : "";
  const inner = [
    `통역 ${readCount(p.interpreterAnswers)}`,
    `SDK ${readCount(p.sdkAnswers)}`,
    `판정 불가 ${readCount(p.undecided)}`,
    `레인 밖 제외 ${readCount(p.excluded?.sessions)}(사람 답 ${readCount(p.excluded?.human)})`,
  ];
  if (readCount(p.fieldMissingSessions) > 0) {
    inner.push(`필드 없는 세션 ${p.fieldMissingSessions}`);
  }
  if (readCount(p.readFailures) > 0) {
    inner.push(`읽기 실패 ${p.readFailures}파일`);
  }
  const workers = seatHumanTotal(p.bySeat, [
    PERMISSION_SEAT.WORKER_HARNESS,
    PERMISSION_SEAT.WORKER_OTHER,
    PERMISSION_SEAT.WORKER_MAIN,
  ]);
  return (
    `${PERMISSION_LINE_PREFIX}확인 ${readCount(p.humanTotal)}건${lower}(${inner.join(" · ")})` +
    ` · ORCH ${seatHumanTotal(p.bySeat, [PERMISSION_SEAT.ORCH])} · 워커 ${workers}` +
    ` · 미분류 ${seatHumanTotal(p.bySeat, [PERMISSION_SEAT.UNCLASSIFIED])} · 자동 ${readCount(p.auto)}` +
    " — ㄴ 확인 건수에 포함 · 세션 기록 한정(다른 엔진 좌석 미포함)"
  );
}

const PERMISSION_EVENT_LIST_MAX = 5;

// «0 이면 안 적는» 보조 칸들(필드 없는 세션 · 읽기 실패 · 줄 파싱 실패 · 시각 불명 · 중복).
function permissionDetailExtraParts(p) {
  const extras = [
    ["fieldMissingSessions", (n) => `필드 없는 세션 ${n}`],
    ["readFailures", (n) => `읽기 실패 ${n}파일`],
    ["parseFailures", (n) => `줄 파싱 실패 ${n}줄`],
    ["undated", (n) => `시각 불명 ${n}줄`],
    ["duplicates", (n) => `중복 ${n}건 제외`],
  ];
  return extras
    .filter(([key]) => readCount(p[key]) > 0)
    .map(([key, render]) => render(p[key]));
}

// KST 일별 사람 답 + 사람 답 시각 · 도구 이름(최대 5건). 없으면 [].
function permissionDetailEventParts(p) {
  const parts = [];
  const days = Object.entries(p.byKstDay ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (days.length > 0) {
    parts.push(
      `KST 일별 사람 답 ${days.map(([day, n]) => `${day} ${n}`).join(" · ")}`,
    );
  }
  const events = Array.isArray(p.humanEvents) ? p.humanEvents : [];
  if (events.length > 0) {
    const shown = events
      .slice(0, PERMISSION_EVENT_LIST_MAX)
      .map(
        (e) => `${formatKst(e.atMs)} ${e.toolName}(${e.seat} · ${e.source})`,
      );
    const more =
      events.length > PERMISSION_EVENT_LIST_MAX
        ? ` 외 ${events.length - PERMISSION_EVENT_LIST_MAX}건`
        : "";
    parts.push(`사람 답 시각·도구 ${shown.join(" · ")}${more}`);
  }
  return parts;
}

// 관측 건강 «진단 줄» 문면 -- 건수 · KST 일별 · 사람 답 시각 · 도구 이름뿐(본문 0).
export function renderPermissionCollectorDetail(permissionAnswers) {
  const p = permissionAnswers;
  if (p?.known !== true) return p?.reason ?? "사유 미상";
  return [
    `세션 ${readCount(p.sessions)} · 파일 ${readCount(p.filesScanned)}`,
    `사람 답 ${readCount(p.humanTotal)}(사용자 ${readCount(p.human)} · 기계 종료 ${readCount(p.machineEnd)} · 모르는 값 ${readCount(p.unknownValue)})`,
    `자동 ${readCount(p.auto)} · 판정 불가 ${readCount(p.undecided)}`,
    ...permissionDetailExtraParts(p),
    ...permissionDetailEventParts(p),
  ].join(" · ");
}

// 일별 회차 값의 새 칸 2 -- permissionHumanAnswers(N+W+U · 통역 포함) · permissionUndecidable(K).
// 미결선(permissionAnswers 없음) = 칸을 «싣지 않는다»(옛 회차 값 모양). 수집 실패 = null 2개(0 이 아니다).
function pickPermissionColumns(permissionAnswers) {
  if (permissionAnswers === undefined || permissionAnswers === null) return {};
  if (permissionAnswers.known !== true) {
    return { permissionHumanAnswers: null, permissionUndecidable: null };
  }
  return {
    permissionHumanAnswers: isCount(permissionAnswers.humanTotal)
      ? permissionAnswers.humanTotal
      : null,
    permissionUndecidable: isCount(permissionAnswers.undecided)
      ? permissionAnswers.undecided
      : null,
  };
}

const PERMISSION_DAILY_KEYS = Object.freeze([
  "permissionHumanAnswers",
  "permissionUndecidable",
]);

// 칸이 «있는» 객체(회차 값 · 상태)에서만 새 칸 2를 뽑는다 -- 있되 모양이 틀리면 null(값 모름), 없으면 싣지 않는다.
function normalizePermissionColumns(source) {
  const out = {};
  for (const key of PERMISSION_DAILY_KEYS) {
    if (Object.hasOwn(source, key)) {
      out[key] = isCount(source[key]) ? source[key] : null;
    }
  }
  return out;
}

// 연속 확인-0 끊김 사유(읽는 쪽) -- 새 칸이 «있는» 줄만 본다. 칸 없는 줄 = 이 수집기 이전(또는 미결선)에 마감된 날 =
// 옛 규칙 그대로(P1 줄 해석 무변). 칸이 있는데 값을 모르면(null · 모양 오류) 0 이 아니라 사유다.
function permissionBreakReasons(line) {
  const reasons = [];
  const labels = {
    permissionHumanAnswers: "권한 확인창 사람 답",
    permissionUndecidable: "권한 판정 불가",
  };
  for (const key of PERMISSION_DAILY_KEYS) {
    if (!Object.hasOwn(line, key)) continue;
    if (!isCount(line[key])) reasons.push(`${labels[key]} UNKNOWN`);
    else if (line[key] > 0) reasons.push(`${labels[key]} ${line[key]}`);
  }
  return reasons;
}
