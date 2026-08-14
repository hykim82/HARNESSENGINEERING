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

// ㄱ 닫힌 일곱 유형. ⛔유일한 출처 = D:\문서관리\하네스-관제실\
// 북극성-좌표.md §1-C «ㄱ. 설계된 정지 -- 닫힌 목록»(91~103행, 2026-08-07
// 한용 확정). 분모 7은 이 배열 길이에서만 온다 -- 문자열로 "7"을 박지
// 않는다(목록이 한용 확정으로 바뀌면 분모도 기계로 따라간다).
export const GATE_TYPES = Object.freeze([
  Object.freeze({ number: 1, name: "다음 작업 선택" }),
  Object.freeze({ number: 2, name: "연속 반려 판정" }),
  Object.freeze({ number: 3, name: "북극성·큰 실행 승인" }),
  Object.freeze({ number: 4, name: "PR 승인·병합 / Linear Done" }),
  Object.freeze({ number: 5, name: "패킷 서명" }),
  Object.freeze({ number: 6, name: "하드스톱" }),
  Object.freeze({ number: 7, name: "상신 답변" }),
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
export const UNCOUNTED_EXAMPLES = Object.freeze({
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
// 없으면 반드시 «확인 0건»으로 쓴다. bare «0건»은 «ㄴ=0»(기간 내 총 0회)
// 으로 오독되므로 ⛔절대 내지 않는다.
export function renderConfirmedLnCount(count) {
  if (count === 0) return "확인 0건";
  return `${count}건`;
}

function buildGaSection(gate4, auxNote) {
  const lines = ["ㄱ 설계된 정지:"];
  if (gate4.known === true) {
    lines.push(`- 외부 독립 앵커로 확인: ${gate4.approved}건`);
    lines.push(
      `- ㄱ-4 후보 병합(측정 기간 내 origin/master): ${gate4.candidatesInWindow}건` +
        ` 중 조회 ${gate4.checked}건 · APPROVED ${gate4.approved} · NOT_APPROVED ${gate4.notApproved}` +
        ` · UNDECIDABLE ${gate4.undecidable} · 미조회(예산) ${gate4.uncheckedByBudget}건 — 미조회는 미계수다`,
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
  const covered = INDEPENDENT_ANCHOR_COVERED_GATE_NUMBERS;
  lines.push(
    `- 독립 앵커 유형 커버리지: ${covered.length}/${GATE_TYPES.length}`,
  );
  const uncovered = GATE_TYPES.filter((g) => !covered.includes(g.number));
  lines.push(
    `- 미커버 ㄱ 유형: ${uncovered.map((g) => `${g.number} ${g.name}`).join(" · ")}` +
      ` (4도 PR 승인·병합만 — Linear Done은 미커버)`,
  );
  return lines;
}

function buildLnSection(confirmedLnEvents, suspected) {
  const lines = ["ㄴ 계획 밖 개입:"];
  const confirmedCount = Array.isArray(confirmedLnEvents)
    ? confirmedLnEvents.length
    : 0;
  lines.push(
    `- 외부 독립 증거로 확인된 사건: ${renderConfirmedLnCount(confirmedCount)}`,
  );
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
    `- 알려진 미계수 예시: ${UNCOUNTED_EXAMPLES.items.length}개(${UNCOUNTED_EXAMPLES.version}) — ` +
      `${UNCOUNTED_EXAMPLES.items.join(" · ")}; 전체 유형의 분모가 아님`,
  );
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
  confirmedLnEvents = [],
  suspected,
  collectors = [],
  lastAliveMs = null,
  coverageGaps,
}) {
  const lines = [];
  lines.push("집계 성격: PARTIAL — 전수 아님");
  lines.push(`생성 시각: ${formatKst(generatedAtMs)}`);
  lines.push(
    `측정 기간: ${formatKst(windowStartMs)} ~ ${formatKst(windowEndMs)}`,
  );
  lines.push("1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가");
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
  lines.push(...buildGaSection(gate4, auxNote));
  lines.push("");
  lines.push(...buildLnSection(confirmedLnEvents, suspected));
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
