// HYK-337-pledge-stall-1 (coder-task.md §2 불변식2/3, §5 "정지 의심과
// 판정 불가를 같은 코드로 접지 않는다") -- reach-report-core.mjs의
// `pledge` axis(AXES 마지막 항목) 전용 계약 시험.
//
// 왜 별도 파일인가: reach-report-core.test.mjs는 이미 크고(15개 시험),
// 그 파일의 8축 fixture(`line()` 헬퍼)를 건드리지 않고도 이 축만 골라
// 최소 입력(top-level `verdict=`/`reason=`만 있는 줄, 다른 8축은 세그먼트
// 자체가 없는 "pre-seat-wire" 형태 -- parseLogLine이 이미 그 형태를
// 지원함을 reach-report-core.test.mjs가 증명해 뒀다)으로 이 축의 계약을
// 좁혀서 증명할 수 있다. I/O는 0(순수 함수 시험, 문자열 입출력만) --
// 파일시스템을 건드리는 end-to-end 증명(받는함 도달)은 별도로
// `.harness/coder.md`의 "발화 실적" 절에서 실제 mkdtemp로 캡처한다(이
// 파일은 그 실적의 로직 근거만 순수 함수 수준에서 고정한다).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AXES,
  parseWatchLog,
  computeOpenAnomalies,
} from "./reach-report-core.mjs";

// 최소 줄: 다른 8축 세그먼트를 아예 생략한다(pre-seat-wire 호환 형태,
// reach-report-core.test.mjs의 동일 이름 시험이 이미 이 형태가 정상
// 파싱됨을 증명했다) -- 이 축이 top-level 필드만으로 스스로 완결됨을
// 보이는 것이 목적이므로 다른 축의 fixture와 섞지 않는다.
function minimalLine({ ts, verdict, reason }) {
  return `${ts} exit=0 verdict=${verdict} reason=${reason}`;
}

test("pledge axis is registered in AXES (the closed, reach-notify-eligible list)", () => {
  assert.ok(AXES.some((a) => a.key === "pledge"));
});

test("STALLED verdict -> pledge axis is an open anomaly (불변식2: 감지가 울리면 도달 경로에 실린다)", () => {
  const t0 = Date.parse("2026-08-28T05:00:00.000Z");
  const { entries } = parseWatchLog(
    minimalLine({
      ts: new Date(t0).toISOString(),
      verdict: "STALLED",
      reason: "STALLED_RESULT_FILE_MISSING",
    }),
  );
  const open = computeOpenAnomalies(entries, t0);
  const pledge = open.find((a) => a.axisKey === "pledge");
  assert.ok(pledge, "expected pledge axis to appear in open anomalies");
  assert.equal(pledge.verdict, "STALLED");
  assert.equal(pledge.reasonDetail, "STALLED_RESULT_FILE_MISSING");
});

test("UNDECIDABLE verdict -> pledge axis is an open anomaly (판정 불가를 괜찮음으로 접지 않는다)", () => {
  const t0 = Date.parse("2026-08-28T05:00:00.000Z");
  const { entries } = parseWatchLog(
    minimalLine({
      ts: new Date(t0).toISOString(),
      verdict: "UNDECIDABLE",
      reason: "OBSERVATION_MISSING_FOR_PLEDGE",
    }),
  );
  const open = computeOpenAnomalies(entries, t0);
  assert.ok(open.some((a) => a.axisKey === "pledge"));
});

test("불변식3(오탐 0): WAITING_HUMAN_GATE (사유 등록된 정당한 대기) does NOT open the pledge anomaly", () => {
  const t0 = Date.parse("2026-08-28T05:00:00.000Z");
  const { entries } = parseWatchLog(
    minimalLine({
      ts: new Date(t0).toISOString(),
      verdict: "WAITING_HUMAN_GATE",
      reason: "HUMAN_GATE_REGISTERED",
    }),
  );
  const open = computeOpenAnomalies(entries, t0);
  assert.equal(
    open.find((a) => a.axisKey === "pledge"),
    undefined,
  );
});

test("불변식3(오탐 0): PROGRESSING (정상 진행 -- 약속 없음 포함, NO_PLEDGES_RECORDED) does NOT open the pledge anomaly", () => {
  const t0 = Date.parse("2026-08-28T05:00:00.000Z");
  const { entries } = parseWatchLog(
    minimalLine({
      ts: new Date(t0).toISOString(),
      verdict: "PROGRESSING",
      reason: "NO_PLEDGES_RECORDED",
    }),
  );
  const open = computeOpenAnomalies(entries, t0);
  assert.equal(
    open.find((a) => a.axisKey === "pledge"),
    undefined,
  );
});

test("recovery: a STALLED->PROGRESSING transition closes the pledge anomaly on the latest sample (same '(c) 41.5h' semantics as the other 8 axes)", () => {
  const t0 = Date.parse("2026-08-28T05:00:00.000Z");
  const { entries } = parseWatchLog(
    [
      minimalLine({
        ts: new Date(t0).toISOString(),
        verdict: "STALLED",
        reason: "STALLED_RESULT_NOT_CONSUMED",
      }),
      minimalLine({
        ts: new Date(t0 + 15 * 60000).toISOString(),
        verdict: "PROGRESSING",
        reason: "WITHIN_THRESHOLD",
      }),
    ].join("\n"),
  );
  const open = computeOpenAnomalies(entries, t0 + 15 * 60000);
  assert.equal(
    open.find((a) => a.axisKey === "pledge"),
    undefined,
  );
});
