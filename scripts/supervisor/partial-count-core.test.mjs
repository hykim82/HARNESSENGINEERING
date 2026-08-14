// HYK-255-partial-counter-1 (coder-task.md §3) -- 부분 계수 보고기 코어
// 계약 시험. ⛔공허 시험 금지: 모든 시험이 프로덕션 export
// (buildPartialCountReport / computeSuspectedStallResumeIntervals /
// computeCoverageGaps / parseKstTimestampMs / formatPartialCountSection)를
// 직접 구동하고, 개수·최종상태가 아니라 계약 «필드 문면»(PARTIAL 배너 ·
// 1-C 판정 자격 · «확인 0건» · 의심 구간 미산입 · UNKNOWN)을 검사한다.
// watch.log 표본은 실제 로그 형식 문자열을 만들어 프로덕션 파서
// (reach-report-core.mjs parseWatchLog)로 통과시킨다 -- 파서를 우회한
// 가짜 entries 배열을 손으로 만들지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWatchLog } from "./reach-report-core.mjs";
import {
  buildPartialCountReport,
  computeSuspectedStallResumeIntervals,
  computeCoverageGaps,
  parseKstTimestampMs,
  formatKst,
  renderConfirmedLnCount,
  formatPartialCountSection,
  GATE_TYPES,
  UNCOUNTED_EXAMPLES,
} from "./partial-count-core.mjs";

// 실물 watch.log 한 줄과 같은 형식(reach-report.test.mjs의 관례 재사용).
// verdict 인자로 최상위 판정(PROGRESSING/WAITING_HUMAN_GATE)을 바꾼다.
function watchLogLine({
  ts,
  verdict = "PROGRESSING",
  idleVerdict = "NONE",
  idleStatus = "SEAT_IDLE_NOT_APPLICABLE",
}) {
  return (
    `${ts} exit=0 verdict=${verdict} reason=OK ` +
    `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
    `idle_status=${idleStatus} idle_verdict=${idleVerdict} idle_worst_count=NONE idle_worktrees=1 ` +
    `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
    `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`
  );
}

const T0 = Date.parse("2026-08-14T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function baseInput(overrides = {}) {
  return {
    generatedAtMs: T0 + 24 * HOUR,
    windowStartMs: T0,
    windowEndMs: T0 + 24 * HOUR,
    delivered: { known: true, count: 5 },
    consumed: { known: true, count: 3 },
    missingReceipts: { known: true, count: 2 },
    gate4: {
      known: true,
      candidatesInWindow: 1,
      checked: 1,
      approved: 1,
      notApproved: 0,
      undecidable: 0,
      uncheckedByBudget: 0,
      approvedEvents: [
        { sha: "a".repeat(40), pullNumber: 152, reviewerLogin: "hykim82" },
      ],
    },
    confirmedLnEvents: [],
    suspected: { known: true, closedCount: 3, openCount: 0 },
    collectors: [{ name: "배달영수증", ok: true }],
    lastAliveMs: T0 + 23 * HOUR,
    coverageGaps: { known: true, count: 1, totalMs: 2 * HOUR },
    ...overrides,
  };
}

test("필수 문면 ⓐⓑ: 첫 줄이 정확히 PARTIAL 배너이고 1-C 판정 자격 없음이 명시된다", () => {
  const text = buildPartialCountReport(baseInput());
  const lines = text.split("\n");
  assert.equal(lines[0], "집계 성격: PARTIAL — 전수 아님");
  assert.ok(
    text.includes(
      "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가",
    ),
  );
  // 금지 해석 줄(PM 규격 마지막 줄)도 문면 그대로.
  assert.ok(
    text.includes(
      "금지 해석: «확인된 N건»은 «기간 내 총 N회» 또는 «ㄴ=0»을 뜻하지 않음",
    ),
  );
});

test("필수 문면 ⓒ: ㄴ 확인 0이면 «확인 0건»으로만 나오고 bare «0건»으로 나오지 않는다", () => {
  const text = buildPartialCountReport(baseInput());
  assert.ok(text.includes("- 외부 독립 증거로 확인된 사건: 확인 0건"));
  // bare 0(«확인» 없는 0건)이 그 필드에 나오면 «ㄴ=0» 오독을 만든다 --
  // 절대 금지(한용 확정 문면 3).
  assert.ok(!text.includes("외부 독립 증거로 확인된 사건: 0건"));
  // «ㄴ=0»이라는 주장 문면은 금지 해석 줄의 «뜻하지 않음» 인용 외엔 없다.
  for (const line of text.split("\n")) {
    if (line.includes("ㄴ=0")) {
      assert.ok(
        line.includes("판정 불가") || line.includes("뜻하지 않음"),
        `«ㄴ=0»이 부정 문맥 밖에서 나왔다: ${line}`,
      );
    }
  }
});

test("필수 문면 ⓓ: 의심 구간이 있어도 ㄴ 분자에 섞이지 않고 «미산입» 문면이 붙는다", () => {
  const text = buildPartialCountReport(
    baseInput({ suspected: { known: true, closedCount: 3, openCount: 1 } }),
  );
  // 의심 구간 3건이 있는데도 확인 사건은 여전히 «확인 0건»이어야 한다.
  assert.ok(text.includes("- 외부 독립 증거로 확인된 사건: 확인 0건"));
  assert.ok(text.includes("- 무진행-재개 의심 구간: 3건 — ㄴ 분자에 미산입"));
  assert.ok(text.includes("재개 미확인 진행 중 1축 별도"));
  assert.ok(text.includes("- 상한: 알 수 없음"));
});

test("독립 증거 사건이 실제로 있으면 그 개수만 분자에 오른다", () => {
  const text = buildPartialCountReport(
    baseInput({
      confirmedLnEvents: [
        { source: "독립앵커X", ref: "evt-1" },
        { source: "독립앵커X", ref: "evt-2" },
      ],
    }),
  );
  assert.ok(text.includes("- 외부 독립 증거로 확인된 사건: 2건"));
  assert.equal(renderConfirmedLnCount(0), "확인 0건");
  assert.equal(renderConfirmedLnCount(2), "2건");
});

test("필수 문면 ⓔ: 조회 실패·관측 없음은 0이 아니라 UNKNOWN(사유)로 나온다", () => {
  const text = buildPartialCountReport(
    baseInput({
      delivered: { known: false, reason: "dispatch-receipts 읽기 실패" },
      gate4: { known: false, reason: "병합 후보 조회 실패: no origin" },
      suspected: { known: false, reason: "watch.log 읽기 실패" },
      coverageGaps: { known: false, reason: "watch.log 읽기 실패" },
      lastAliveMs: null,
    }),
  );
  assert.ok(
    text.includes("라운드 분모: 배달 UNKNOWN(dispatch-receipts 읽기 실패)"),
  );
  assert.ok(!text.includes("배달 0 /"), "읽기 실패가 0으로 접혔다");
  assert.ok(
    text.includes(
      "- 외부 독립 앵커로 확인: UNKNOWN(병합 후보 조회 실패: no origin)",
    ),
  );
  assert.ok(
    text.includes(
      "- 무진행-재개 의심 구간: UNKNOWN(watch.log 읽기 실패) — ㄴ 분자에 미산입",
    ),
  );
  assert.ok(text.includes("- 마지막 생존 영수증: UNKNOWN"));
  assert.ok(
    text.includes("- 관측 공백(coverage gap): UNKNOWN(watch.log 읽기 실패)"),
  );
});

test("필수 문면 4·5: ㄱ/ㄴ/보조 칸 분리 · 분모 · 커버리지 1/7 · 미계수 예시 목록이 문면대로 나온다", () => {
  const text = buildPartialCountReport(baseInput());
  assert.ok(text.includes("라운드 분모: 배달 5 / 소비 3 / 영수증 결손 2"));
  // 2R 반려 1 수리 고정: 분모 «바로 다음 줄»에 기준 단위가 명시된다
  // (배달·소비=레코드 · 결손=고유 라벨 -- 인접성까지 \n 연결로 고정).
  assert.ok(
    text.includes(
      "라운드 분모: 배달 5 / 소비 3 / 영수증 결손 2\n(기준 단위: 배달·소비 = 레코드 수 · 영수증 결손 = 영수증 없는 고유 라벨 수 — 단위가 달라 «배달−소비=결손»이 성립하지 않음)",
    ),
  );
  assert.ok(text.includes("ㄱ 설계된 정지:"));
  assert.ok(text.includes("ㄴ 계획 밖 개입:"));
  assert.ok(
    text.includes(
      "- ORCH-writeable 보조 관측: 미계수(이 라운드 결선된 보조 수집기 없음) — 독립 계수에 미산입",
    ),
  );
  // 분모 7은 북극성 닫힌 목록 배열 길이에서 기계로 온다.
  assert.equal(GATE_TYPES.length, 7);
  assert.ok(text.includes(`- 독립 앵커 유형 커버리지: 1/${GATE_TYPES.length}`));
  assert.ok(text.includes("- 미커버 ㄱ 유형: 1 다음 작업 선택"));
  assert.ok(text.includes("Linear Done은 미커버"));
  // ㄴ은 열린 집합 -- 전수 비율 대신 버전 붙은 예시 목록 개수.
  assert.ok(
    text.includes(
      `- 알려진 미계수 예시: ${UNCOUNTED_EXAMPLES.items.length}개(${UNCOUNTED_EXAMPLES.version})`,
    ),
  );
  assert.ok(text.includes("전체 유형의 분모가 아님"));
  // ㄱ-4 확인 사건에는 결속 근거(PR·승인자)가 붙는다.
  assert.ok(text.includes("PR#152 승인자 hykim82"));
  // 관측 공백은 «정상 측정 기간이 아니다» 경고와 함께(비타협 5) --
  // 공백 0이면 그 경고 문면이 붙지 않는다.
  assert.ok(
    text.includes(
      "- 관측 공백(coverage gap): 1구간 · 합계 2시간 0분 — 이 구간은 정상 측정 기간이 아니다",
    ),
  );
  const noGaps = buildPartialCountReport(
    baseInput({ coverageGaps: { known: true, count: 0, totalMs: 0 } }),
  );
  assert.ok(noGaps.includes("- 관측 공백(coverage gap): 0구간 · 합계 0분\n"));
  assert.ok(
    !noGaps.includes("0구간 · 합계 0분 — 이 구간은 정상 측정 기간이 아니다"),
  );
});

test("computeSuspectedStallResumeIntervals: 재개가 관측된 닫힌 구간만 세고, 열린 구간·설계된 게이트 대기는 제외한다", () => {
  const anomaly = (ts) =>
    watchLogLine({
      ts,
      idleStatus: "SEAT_IDLE_JUDGED",
      idleVerdict: "SUSPECTED_ABANDONED",
    });
  const normal = (ts) => watchLogLine({ ts });
  const iso = (ms) => new Date(ms).toISOString();

  // (1) 닫힌 구간 1개: 무진행 2표본 뒤 정상 표본 = 재개 확인.
  const closedLog = [
    normal(iso(T0)),
    anomaly(iso(T0 + HOUR)),
    anomaly(iso(T0 + 2 * HOUR)),
    normal(iso(T0 + 3 * HOUR)),
  ].join("\n");
  const closed = computeSuspectedStallResumeIntervals({
    entries: parseWatchLog(closedLog).entries,
    windowStartMs: T0,
    windowEndMs: T0 + 24 * HOUR,
  });
  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0].axisKey, "idle");
  assert.equal(closed.closed[0].fromMs, T0 + HOUR);
  assert.equal(closed.closed[0].toMs, T0 + 3 * HOUR);
  assert.equal(closed.open.length, 0);

  // (2) 창 끝까지 무진행 = 재개 미확인 -> closed 0 · open 1.
  const openLog = [normal(iso(T0)), anomaly(iso(T0 + HOUR))].join("\n");
  const open = computeSuspectedStallResumeIntervals({
    entries: parseWatchLog(openLog).entries,
    windowStartMs: T0,
    windowEndMs: T0 + 24 * HOUR,
  });
  assert.equal(open.closed.length, 0);
  assert.equal(open.open.length, 1);

  // (3) 설계된 사람 게이트 대기(WAITING_HUMAN_GATE)는 축 verdict가
  // 나빠도 무진행 표본이 아니다(ㄱ 대기 -- orch-progress-core의 분리
  // 재사용). 구간이 아예 만들어지지 않는다.
  const gatedLog = [
    watchLogLine({
      ts: iso(T0 + HOUR),
      verdict: "WAITING_HUMAN_GATE",
      idleStatus: "SEAT_IDLE_JUDGED",
      idleVerdict: "SUSPECTED_ABANDONED",
    }),
    normal(iso(T0 + 2 * HOUR)),
  ].join("\n");
  const gated = computeSuspectedStallResumeIntervals({
    entries: parseWatchLog(gatedLog).entries,
    windowStartMs: T0,
    windowEndMs: T0 + 24 * HOUR,
  });
  assert.equal(gated.closed.length, 0);
  assert.equal(gated.open.length, 0);

  // (4) 창 밖 표본은 계수되지 않는다.
  const outside = computeSuspectedStallResumeIntervals({
    entries: parseWatchLog(closedLog).entries,
    windowStartMs: T0 + 10 * HOUR,
    windowEndMs: T0 + 24 * HOUR,
  });
  assert.equal(outside.closed.length, 0);
});

test("computeCoverageGaps: 표본 없음 = 창 전체가 공백 1구간 · 촘촘한 표본 = 공백 0 · 구멍은 그대로 나온다", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const windowStartMs = T0;
  const windowEndMs = T0 + 6 * HOUR;

  const none = computeCoverageGaps({ entries: [], windowStartMs, windowEndMs });
  assert.equal(none.gaps.length, 1);
  assert.equal(none.totalMs, 6 * HOUR);

  const denseLog = [];
  for (let ms = T0; ms <= windowEndMs; ms += 15 * 60 * 1000) {
    denseLog.push(watchLogLine({ ts: iso(ms) }));
  }
  const dense = computeCoverageGaps({
    entries: parseWatchLog(denseLog.join("\n")).entries,
    windowStartMs,
    windowEndMs,
  });
  assert.equal(dense.gaps.length, 0);

  // 가운데 2시간 구멍(다른 표본 간격은 임계 45분 미만인 30분).
  const HALF = 30 * 60 * 1000;
  const holeyLog = [
    watchLogLine({ ts: iso(T0) }),
    watchLogLine({ ts: iso(T0 + HALF) }),
    watchLogLine({ ts: iso(T0 + HALF + 2 * HOUR) }),
    watchLogLine({ ts: iso(T0 + 2 * HALF + 2 * HOUR) }),
  ].join("\n");
  const holey = computeCoverageGaps({
    entries: parseWatchLog(holeyLog).entries,
    windowStartMs: T0,
    windowEndMs: T0 + 3 * HALF + 2 * HOUR,
  });
  assert.equal(holey.gaps.length, 1);
  assert.equal(holey.totalMs, 2 * HOUR);
});

test("parseKstTimestampMs/formatKst: KST(UTC+9) 왕복이 맞고 파싱 불가는 null이다", () => {
  const ms = parseKstTimestampMs("2026-08-14 06:04:39 KST");
  assert.equal(ms, Date.UTC(2026, 7, 13, 21, 4, 39));
  assert.equal(formatKst(ms), "2026-08-14 06:04:39 KST");
  // 분 단위(초 없음, task 파일 dropped_at 형식)도 파싱된다.
  assert.equal(
    parseKstTimestampMs("2026-08-14 15:46 KST"),
    Date.UTC(2026, 7, 14, 6, 46, 0),
  );
  assert.equal(parseKstTimestampMs("2026-08-14T06:04:39Z"), null);
  assert.equal(parseKstTimestampMs(null), null);
});

test("formatPartialCountSection: 파일 없음/신선/오래됨/생성시각 불명이 각각 명시적으로 갈린다", () => {
  const nowMs = Date.UTC(2026, 7, 14, 12, 0, 0);
  // (1) 파일 없음 -> UNKNOWN + 생성 방법 한 줄(조용한 생략 금지).
  const missing = formatPartialCountSection({
    fileText: null,
    sourceLabel: "X:/watch/partial-count-report.md",
    nowMs,
  }).join("\n");
  assert.ok(missing.includes("## 부분 계수 보고 (HYK-255)"));
  assert.ok(
    missing.includes(
      "UNKNOWN — 부분 계수 보고 파일 없음(X:/watch/partial-count-report.md)",
    ),
  );
  assert.ok(missing.includes("partial-count-report.mjs"));

  // (2) 신선(1시간 전 생성) -> 내용이 그대로 실린다.
  const fresh = formatPartialCountSection({
    fileText: `집계 성격: PARTIAL — 전수 아님\n생성 시각: ${formatKst(nowMs - HOUR)}\n본문`,
    sourceLabel: "p",
    nowMs,
  }).join("\n");
  assert.ok(fresh.includes("집계 성격: PARTIAL — 전수 아님"));
  assert.ok(fresh.includes("(1시간 0분 전)"));
  assert.ok(!fresh.includes("오래됨"));

  // (3) 오래됨(25시간 전) -> UNKNOWN 취급 경고가 내용 위에 붙는다.
  const stale = formatPartialCountSection({
    fileText: `집계 성격: PARTIAL — 전수 아님\n생성 시각: ${formatKst(nowMs - 25 * HOUR)}\n본문`,
    sourceLabel: "p",
    nowMs,
  }).join("\n");
  assert.ok(stale.includes("⚠️ 오래됨"));
  assert.ok(stale.includes("UNKNOWN 취급"));

  // (4) 생성 시각 줄이 없으면 신선도 판정 불가를 명시한다.
  const noStamp = formatPartialCountSection({
    fileText: "집계 성격: PARTIAL — 전수 아님\n본문",
    sourceLabel: "p",
    nowMs,
  }).join("\n");
  assert.ok(noStamp.includes("생성 시각 UNKNOWN — 신선도 판정 불가"));
});
