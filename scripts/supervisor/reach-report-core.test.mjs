// HYK-191-reach-1 (coder-task.md §7) -- reach-report-core.mjs 계약 시험.
// 이 스위트가 건드리는 파일시스템은 0(순수 함수 시험, 문자열 입출력만).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AXES,
  parseLogLine,
  parseWatchLog,
  computeOpenAnomalies,
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
};

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
  } = { ...LINE_DEFAULTS, ...overrides };
  return (
    `${ts} exit=0 verdict=${verdict} reason=${reason} ` +
    `seat_status=${seatStatus} seat_verdict=${seatVerdict} seat_worst_count=NONE seat_worktrees=4 ` +
    `idle_status=${idleStatus} idle_verdict=${idleVerdict} idle_worst_count=NONE idle_worktrees=4 ` +
    `start_status=${startStatus} start_verdict=${startVerdict} start_worst_count=NONE start_worktrees=4 ` +
    `unconsumed_status=${unconsumedStatus} unconsumed_verdict=${unconsumedVerdict} unconsumed_worst_count=NONE unconsumed_worktrees=4 ` +
    `cap_status=${capStatus} cap_verdict=${capVerdict} cap_value=${capValue} cap_source=${capSource}`
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

test("empty log (no entries at all) still produces a non-blank report saying so explicitly (1/1)", () => {
  const report = formatMorningReport({ entries: [], nowMs: Date.now() });
  assert.match(report, /없음/);
  assert.ok(report.trim().length > 0);
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

test("all 5 axes are independently tracked (one axis bad does not mask another) (1/1)", () => {
  const t0 = Date.parse("2026-08-05T00:00:00.000Z");
  const entries = parseWatchLog(
    line({
      ts: new Date(t0).toISOString(),
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
    }),
  ).entries;
  const open = computeOpenAnomalies(entries, t0);
  const keys = open.map((a) => a.axisKey).sort();
  assert.deepEqual(keys, AXES.map((a) => a.key).sort());
});

test("formatDurationKo formats hours+minutes, and sub-hour durations without a '0시간' prefix (2/2)", () => {
  assert.equal(formatDurationKo(41.5 * 3_600_000), "41시간 30분");
  assert.equal(formatDurationKo(25 * 60000), "25분");
});
