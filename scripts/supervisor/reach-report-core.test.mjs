// HYK-191-reach-1 (coder-task.md §7) -- reach-report-core.mjs 계약 시험.
// 이 스위트가 건드리는 파일시스템은 0(순수 함수 시험, 문자열 입출력만).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AXES,
  parseLogLine,
  parseWatchLog,
  computeOpenAnomalies,
  computeOpenMeasurementFailures,
  computeRecentSummary,
  formatDurationKo,
  formatMorningReport,
} from "./reach-report-core.mjs";

// eslint max-complexity(12) 상한 준수(HYK-198-capwire-2) -- 각 destructured
// 기본값(AssignmentPattern)이 그 자체로 분기 1개로 잡히므로(ESLint
// complexity.js 실측, watch-run.mjs의 동일 수리 참조), 기본값을 파라미터
// 목록이 아니라 상수 객체 하나로 옮겨 스프레드로 병합한다.
const LINE_DEFAULTS = {
  verdict: "PROGRESSING",
  reason: "OK",
  seatVerdict: "NONE",
  seatStatus: "SEAT_LIVENESS_NOT_APPLICABLE",
  idleVerdict: "NONE",
  idleStatus: "SEAT_IDLE_NOT_APPLICABLE",
  startVerdict: "NONE",
  startStatus: "DISPATCH_START_NOT_APPLICABLE",
  unconsumedVerdict: "NONE",
  unconsumedStatus: "UNCONSUMED_NOT_APPLICABLE",
  capStatus: "OK",
  capVerdict: "DECIDED",
  capValue: "2",
  capSource: "/x/concurrency-cap.json",
  escalationStatus: "ESCALATION_OK",
  escalationVerdict: "NONE",
  postcheckStatus: "OK",
  postcheckVerdict: "NONE",
  chainStatus: "JUDGED",
  chainVerdict: "NONE",
  bindingStatus: "JUDGED",
  bindingVerdict: "NONE",
};

// HYK-265-observe-split-3 (검토자 P1 수리) -- `report.split("## 헤더")[1]`은
// «헤더 뒤 끝까지 전부»를 돌려주므로 다음 절(예: "## 지난 24시간 요약")까지
// 딸려 들어온다. 그 다음 절이 같은 축 라벨을 담고 있으면(요약 절은 8축
// 라벨을 전부 나열) 분리를 깨는 변이도 이 라벨 때문에 시험이 통과해
// 버린다(검토자 실측 -- computeOpenMeasurementFailures의 술어를
// isAxisAnomalousVerdict로 바꿔도 RED가 안 됨). 이 헬퍼는 «헤더 다음 줄부터
// 다음 `## ` 헤더 직전까지»로 정확히 잘라, 뒤 절이 검사 범위에 새지 않게
// 한다.
function extractSection(report, headerPrefix) {
  const headerIdx = report.indexOf(headerPrefix);
  if (headerIdx === -1) return "";
  const afterHeader = report.slice(headerIdx + headerPrefix.length);
  const nextHeaderIdx = afterHeader.indexOf("\n## ");
  return nextHeaderIdx === -1
    ? afterHeader
    : afterHeader.slice(0, nextHeaderIdx);
}

function line(overrides) {
  const {
    ts,
    verdict,
    reason,
    seatVerdict,
    seatStatus,
    idleVerdict,
    idleStatus,
    startVerdict,
    startStatus,
    unconsumedVerdict,
    unconsumedStatus,
    capStatus,
    capVerdict,
    capValue,
    capSource,
    escalationStatus,
    escalationVerdict,
    postcheckStatus,
    postcheckVerdict,
    chainStatus,
    chainVerdict,
    bindingStatus,
    bindingVerdict,
  } = { ...LINE_DEFAULTS, ...overrides };
  return (
    `${ts} exit=0 verdict=${verdict} reason=${reason} ` +
    `seat_status=${seatStatus} seat_verdict=${seatVerdict} seat_worst_count=NONE seat_worktrees=4 ` +
    `idle_status=${idleStatus} idle_verdict=${idleVerdict} idle_worst_count=NONE idle_worktrees=4 ` +
    `start_status=${startStatus} start_verdict=${startVerdict} start_worst_count=NONE start_worktrees=4 ` +
    `unconsumed_status=${unconsumedStatus} unconsumed_verdict=${unconsumedVerdict} unconsumed_worst_count=NONE unconsumed_worktrees=4 ` +
    `cap_status=${capStatus} cap_verdict=${capVerdict} cap_value=${capValue} cap_source=${capSource} ` +
    `escalation_status=${escalationStatus} escalation_verdict=${escalationVerdict} escalation_worst_count=NONE escalation_worktrees=1 ` +
    `postcheck_status=${postcheckStatus} postcheck_verdict=${postcheckVerdict} postcheck_worst_count=NONE postcheck_worktrees=1 ` +
    `chain_status=${chainStatus} chain_verdict=${chainVerdict} chain_worst_count=NONE chain_worktrees=1 ` +
    `binding_status=${bindingStatus} binding_verdict=${bindingVerdict} binding_worst_count=NONE binding_worktrees=1`
  );
}

test("parseLogLine: a well-formed watch.log line round-trips all 4 axis fields (1/1)", () => {
  const parsed = parseLogLine(
    line({
      ts: "2026-08-05T05:06:00.000Z",
      idleStatus: "SEAT_IDLE_JUDGED",
      idleVerdict: "SUSPECTED_ABANDONED",
    }),
  );
  assert.equal(parsed.verdict, "PROGRESSING");
  assert.equal(parsed.axes.idle.status, "SEAT_IDLE_JUDGED");
  assert.equal(parsed.axes.idle.verdict, "SUSPECTED_ABANDONED");
  assert.equal(parsed.axes.seat.verdict, null); // "NONE" -> null
});

test("★실측 수리: a pre-seat-wire log line with NO axis segments at all (reason= is the last token, nothing trails) still parses (regression -- real watch.log had 47/278 such lines) (1/1)", () => {
  const parsed = parseLogLine(
    "2026-08-03T20:51:01.927Z exit=2 verdict=STALLED reason=STALLED_RESULT_NOT_CONSUMED",
  );
  assert.ok(parsed, "must parse, not return null");
  assert.equal(parsed.verdict, "STALLED");
  assert.equal(parsed.axes.seat.status, null);
  assert.equal(parsed.axes.idle.verdict, null);
});

// HYK-210-human-log-1 (coder-task.md §2-2 "기존 로그 소비자 회귀 0"): 이
// 라운드는 buildLogLine(watch-run.mjs)에 `seat_partial_failures=`/
// `seat_partial_failure_detail=`(그리고 start_* 대응) 새 토큰을 추가한다.
// parseFieldTokens는 `key=value` 토큰을 이름 기반으로만 뽑으므로(§2 axis
// 정의에 없는 새 키는 그냥 버려진다), 기존 4축 파싱이 이 새 토큰의 존재
// 여부와 무관하게 그대로 성립해야 한다 -- 이 시험이 그것을 고정한다.
test("HYK-210-human-log-1: parseLogLine ignores new seat_partial_failures*/start_partial_failures* tokens and still round-trips the 4 known axes unchanged (existing log consumer regression guard) (1/1)", () => {
  const withFailureTokens =
    line({
      ts: "2026-08-09T12:00:00.000Z",
      seatStatus: "SEAT_LIVENESS_JUDGED",
      seatVerdict: "SUSPECTED_UNRESPONSIVE",
      startStatus: "DISPATCH_START_JUDGED",
      startVerdict: "NOT_STARTED",
    }) +
    " seat_partial_failures=1 seat_partial_failure_detail=term_abc:terminal_show_query_threw" +
    " start_partial_failures=1 start_partial_failure_detail=term_abc:terminal_show_query_threw";
  const parsed = parseLogLine(withFailureTokens);
  assert.ok(parsed, "must still parse despite unknown trailing tokens");
  assert.equal(parsed.axes.seat.status, "SEAT_LIVENESS_JUDGED");
  assert.equal(parsed.axes.seat.verdict, "SUSPECTED_UNRESPONSIVE");
  assert.equal(parsed.axes.start.status, "DISPATCH_START_JUDGED");
  assert.equal(parsed.axes.start.verdict, "NOT_STARTED");
  assert.equal(parsed.axes.idle.status, "SEAT_IDLE_NOT_APPLICABLE");
});

test("parseLogLine: RUNNER_FAILURE lines and garbage lines are not thrown, just null (2/2)", () => {
  assert.equal(
    parseLogLine("2026-08-05T05:06:00.000Z RUNNER_FAILURE message=boom"),
    null,
  );
  assert.equal(parseLogLine("not a log line at all"), null);
});

test("parseWatchLog: blank lines are skipped silently, malformed lines are counted in `skipped` (1/1)", () => {
  const text = [
    line({ ts: "2026-08-05T05:06:00.000Z" }),
    "",
    "garbage",
    line({ ts: "2026-08-05T05:21:00.000Z" }),
  ].join("\n");
  const { entries, skipped } = parseWatchLog(text);
  assert.equal(entries.length, 2);
  assert.equal(skipped, 1);
});

test("★(c) 41.5h repro: an axis stuck at the SAME bad verdict across many samples reports one open anomaly since the FIRST bad sample, not the latest (1/1)", () => {
  // 2026-08-05 05:06 ~ 08-06 22:36 KST 실측 그대로 -- idle_verdict=SUSPECTED_ABANDONED
  // 가 15분 간격으로 계속 찍힌다(worst_count는 실측대로 흔들려도 verdict는
  // 고정-- coder-task.md §4가 지적한 바로 그 형태).
  const startMs = Date.parse("2026-08-04T20:06:00.000Z"); // 05:06 KST
  const endMs = Date.parse("2026-08-06T13:36:00.000Z"); // 22:36 KST (다음날)
  const entries = [];
  for (let t = startMs; t <= endMs; t += 15 * 60 * 1000) {
    entries.push(
      line({
        ts: new Date(t).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
    );
  }
  const parsed = parseWatchLog(entries.join("\n")).entries;
  const nowMs = endMs;
  const open = computeOpenAnomalies(parsed, nowMs);
  const idleAnomaly = open.find((a) => a.axisKey === "idle");
  assert.ok(idleAnomaly, "idle axis must be reported as an open anomaly");
  assert.equal(
    idleAnomaly.sinceMs,
    startMs,
    "since must be the FIRST bad sample, not the latest",
  );
  const expectedHours = (endMs - startMs) / 3_600_000;
  assert.ok(
    Math.abs(expectedHours - 41.5) < 0.1,
    `fixture sanity: expected ~41.5h span, got ${expectedHours}h`,
  );
  assert.match(formatDurationKo(idleAnomaly.openMs), /^41시간/);
});

test("★(c) an intervening OK sample resets the 'since' clock (interruption ends the streak) (1/1)", () => {
  const t0 = Date.parse("2026-08-05T00:00:00.000Z");
  const entries = parseWatchLog(
    [
      line({
        ts: new Date(t0).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
      line({
        ts: new Date(t0 + 15 * 60000).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "IDLE_OK",
      }),
      line({
        ts: new Date(t0 + 30 * 60000).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
    ].join("\n"),
  ).entries;
  const open = computeOpenAnomalies(entries, t0 + 30 * 60000);
  const idleAnomaly = open.find((a) => a.axisKey === "idle");
  assert.equal(
    idleAnomaly.sinceMs,
    t0 + 30 * 60000,
    "since must be the second run's start, not the first",
  );
});

test("(b) no open anomalies -> computeOpenAnomalies returns [] and formatMorningReport explicitly says '없음' (not blank output) (1/1)", () => {
  const entries = parseWatchLog(
    line({ ts: "2026-08-05T00:00:00.000Z" }),
  ).entries;
  const open = computeOpenAnomalies(
    entries,
    Date.parse("2026-08-05T00:00:00.000Z"),
  );
  assert.deepEqual(open, []);
  const report = formatMorningReport({
    entries,
    nowMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
  assert.match(report, /없음/);
  assert.ok(report.trim().length > 0, "report body must never be blank");
});

// HYK-173-push-wire 2R P2-1(coder-task.md §2-2) -- "적힌 수 != 실제 목록"
// 계열의 여섯 번째 재발을 막는 시험. formatMorningReport의 "없음" 문면이
// AXES.length를 그대로 실었는지(손으로 박은 숫자가 아닌지)를 직접
// 확인한다 -- AXES가 나중에 늘어나도(예: 일곱 번째 축 편입) 이 시험은
// AXES.length를 그대로 읽으므로 계속 통과해야 하고, 반대로 구현이 다시
// 손으로 박은 리터럴로 되돌아가면(변조) 이 단언이 그 리터럴과 실제
// AXES.length가 어긋나는 순간 RED가 된다.
test("HYK-173-push-wire 2R P2-1: the '없음' line's axis count is derived from AXES.length, not a hand-baked literal (1/1)", () => {
  const entries = parseWatchLog(
    line({ ts: "2026-08-05T00:00:00.000Z" }),
  ).entries;
  const report = formatMorningReport({
    entries,
    nowMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
  const expected = `없음 -- 열려 있는 이상이 없습니다(${AXES.length}축 전부 정상 또는 관측 대상 없음).`;
  assert.ok(
    report.includes(expected),
    `expected the machine-derived count (AXES.length=${AXES.length}) in: ${report}`,
  );
});

test("empty log (no entries at all) still produces a non-blank report saying so explicitly (1/1)", () => {
  const report = formatMorningReport({ entries: [], nowMs: Date.now() });
  assert.match(report, /없음/);
  assert.ok(report.trim().length > 0);
});

// HYK-265-observe-split-1 (coder-task.md §4 완료조건1·2) -- 이 라운드의
// 핵심 계약: (a) badVerdicts 축과 badStatuses 축이 formatMorningReport의
// 서로 다른 절("지금 열려 있는 이상" vs "측정 불가(수집 실패)")에 실린다
// (b) badStatuses 축의 사유 문자열(watch-run.mjs가 만드는 `*_reason_detail=`
// 로그 토큰, 이 시험은 그 토큰을 직접 실어 round-trip을 확인한다)이 그
// "측정 불가" 절에 실제로 찍힌다.
test("HYK-265-observe-split-1: badVerdicts axis -> '지금 열려 있는 이상' section; badStatuses axis -> separate '측정 불가(수집 실패)' section with its reason string shown (2/2)", () => {
  const t0 = Date.parse("2026-08-16T00:00:00.000Z");
  const withReasonDetail =
    line({
      ts: new Date(t0).toISOString(),
      idleStatus: "SEAT_IDLE_JUDGED",
      idleVerdict: "SUSPECTED_ABANDONED", // badVerdicts 축 -- "이상"
      seatStatus: "SEAT_LIVENESS_COLLECTION_FAILED", // badStatuses 축 -- "측정 불가"
    }) + " seat_reason_detail=AMBIGUOUS:orca_terminal_list_failed_timeout";
  const entries = parseWatchLog(withReasonDetail).entries;
  const report = formatMorningReport({ entries, nowMs: t0 });

  const anomalySection = extractSection(report, "## 지금 열려 있는 이상");
  const measurementSection = extractSection(report, "## 측정 불가");

  assert.match(
    anomalySection,
    /좌석 유휴 방치/,
    "the badVerdicts axis (idle) must appear under '지금 열려 있는 이상'",
  );
  assert.doesNotMatch(
    anomalySection,
    /좌석 무응답/,
    "the badStatuses axis (seat, COLLECTION_FAILED) must NOT appear under '지금 열려 있는 이상'",
  );
  assert.match(
    measurementSection,
    /좌석 무응답/,
    "the badStatuses axis (seat) must appear under '측정 불가(수집 실패)'",
  );
  assert.match(
    measurementSection,
    /AMBIGUOUS:orca_terminal_list_failed_timeout/,
    "the reason string must reach the human-facing report, not just the log",
  );
});

test("computeRecentSummary counts anomalous samples within the window, distinct from computeOpenAnomalies (1/1)", () => {
  const t0 = Date.parse("2026-08-05T00:00:00.000Z");
  const entries = parseWatchLog(
    [
      line({
        ts: new Date(t0).toISOString(),
        unconsumedStatus: "UNCONSUMED_JUDGED",
        unconsumedVerdict: "SUSPECTED_UNCONSUMED",
      }),
      line({ ts: new Date(t0 + 15 * 60000).toISOString() }), // recovers
    ].join("\n"),
  ).entries;
  const summary = computeRecentSummary(entries, t0 + 15 * 60000);
  assert.equal(summary.unconsumed.sampleCount, 2);
  assert.equal(summary.unconsumed.anomalousSamples, 1);
  // and it's NOT currently open (recovered on the latest sample)
  const open = computeOpenAnomalies(entries, t0 + 15 * 60000);
  assert.equal(
    open.find((a) => a.axisKey === "unconsumed"),
    undefined,
  );
});

// HYK-265-observe-split-1 (coder-task.md §3-1 항1) 갱신: cap 축은
// badVerdicts가 비어 있고(reach-report-core.mjs AXES 정의, cap_verdict는
// 정상일 때 항상 "DECIDED") CAP_READ_FAILED는 badStatuses 소속이다 --
// 즉 cap은 "이상"이 아니라 "측정 불가"로 갈라져야 한다(이 시험이 그
// 분리를 고정한다. 분리 전에는 두 절이 합쳐져 있어 cap이 computeOpenAnomalies
// 에도 나타났다).
// HYK-337-pledge-stall-1: `pledge` reads the line's own top-level
// `verdict=` field (see reach-report-core.mjs AXES comment) -- so this
// fixture must set `verdict: "STALLED"` for the new axis to also be
// among the "all N badVerdict axes" it asserts (8 -> 9 with pledge added).
test("all 9 badVerdict axes are independently tracked in computeOpenAnomalies (one axis bad does not mask another); cap(badStatuses-only) goes to computeOpenMeasurementFailures instead (2/2)", () => {
  const t0 = Date.parse("2026-08-05T00:00:00.000Z");
  const entries = parseWatchLog(
    line({
      ts: new Date(t0).toISOString(),
      verdict: "STALLED",
      seatStatus: "SEAT_LIVENESS_JUDGED",
      seatVerdict: "SUSPECTED_UNRESPONSIVE",
      idleStatus: "SEAT_IDLE_JUDGED",
      idleVerdict: "SUSPECTED_ABANDONED",
      startStatus: "DISPATCH_START_JUDGED",
      startVerdict: "NOT_STARTED",
      unconsumedStatus: "UNCONSUMED_JUDGED",
      unconsumedVerdict: "SUSPECTED_UNCONSUMED",
      capStatus: "CAP_READ_FAILED",
      capVerdict: "FILE_UNREADABLE",
      escalationStatus: "ESCALATION_OK",
      escalationVerdict: "NEEDS_INPUT",
      postcheckStatus: "OK",
      postcheckVerdict: "RECORD_MISSING",
      chainStatus: "JUDGED",
      chainVerdict: "TAMPER_DETECTED",
      bindingStatus: "JUDGED",
      bindingVerdict: "MISMATCH",
    }),
  ).entries;
  const open = computeOpenAnomalies(entries, t0);
  const keys = open.map((a) => a.axisKey).sort();
  const expectedAnomalyKeys = AXES.map((a) => a.key)
    .filter((k) => k !== "cap")
    .sort();
  assert.deepEqual(keys, expectedAnomalyKeys);

  const measurementFailures = computeOpenMeasurementFailures(entries, t0);
  const mfKeys = measurementFailures.map((a) => a.axisKey);
  assert.deepEqual(mfKeys, ["cap"]);
});

// HYK-321(A) (coder-task.md §1 갈래2): 「MAIN_REPO_PATH에 없어졌어야 할
// 좌석이 남았다」는 orch-stall-detect.mjs judgeEscalationForRepo가 이미
// escalation_status=ESCALATION_COLLECTION_FAILED로 fail-loud 표면화한다
// (orch-stall-detect.mjs resolveCoordinatorHandle, "expected exactly 1
// seat at MAIN_REPO_PATH, found 2" -- escalation-axis-wire.test.mjs가
// 그 수집층을 시험한다). 이 시험은 그 신호가 실제로 사람에게 "도달"하는
// 다음 단(reach-report-core.mjs의 AXES escalation 항목,
// badStatuses:["ESCALATION_COLLECTION_FAILED"])까지 이어짐을 직접
// 증명한다 -- watch.log의 escalation_status 필드 하나만 COLLECTION_FAILED
// 이고 그 외 7축은 전부 정상인 샘플에서 computeOpenMeasurementFailures가
// 그 한 줄을 집어내는가(reach path 확인, §2 완료조건3).
test("HYK-321(A): escalation_status=ESCALATION_COLLECTION_FAILED (revived MAIN_REPO_PATH seat) surfaces via computeOpenMeasurementFailures -- the reach-notify path a human sees (2/2)", () => {
  const t0 = Date.parse("2026-08-24T00:00:00.000Z");
  const entries = parseWatchLog(
    line({
      ts: new Date(t0).toISOString(),
      escalationStatus: "ESCALATION_COLLECTION_FAILED",
      escalationVerdict: "SUPERVISOR_FAULT",
    }),
  ).entries;
  const measurementFailures = computeOpenMeasurementFailures(entries, t0);
  const mfKeys = measurementFailures.map((a) => a.axisKey);
  assert.deepEqual(mfKeys, ["escalation"]);

  // 오탐 0 (§2 완료조건4): 정상(ESCALATION_OK, 아직 wake 없음) 샘플은
  // measurement-failure로도 anomaly로도 뜨지 않는다 -- 정상 정리/정상
  // 가동 중인 좌석(=이 축이 조용한) 상태를 발화시키지 않는다.
  const okEntries = parseWatchLog(
    line({
      ts: new Date(t0).toISOString(),
      escalationStatus: "ESCALATION_OK",
      escalationVerdict: "NONE",
    }),
  ).entries;
  assert.deepEqual(
    computeOpenMeasurementFailures(okEntries, t0).map((a) => a.axisKey),
    [],
  );
  assert.deepEqual(
    computeOpenAnomalies(okEntries, t0).map((a) => a.axisKey),
    [],
  );
});

test("formatDurationKo formats hours+minutes, and sub-hour durations without a '0시간' prefix (2/2)", () => {
  assert.equal(formatDurationKo(41.5 * 3_600_000), "41시간 30분");
  assert.equal(formatDurationKo(25 * 60000), "25분");
});
