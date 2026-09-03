// HYK-185 gap#69 (coder-task.md §7, §3) -- watch-run.mjs 계약 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 이 스위트가 100% 통과해도 "실제 스케줄러가 이 러너를 실제로 부른다"를
//    증명하지 않는다 -- 등록은 사람 손이며(schedule-wire.mjs register),
//    이 시험은 실제 스케줄러·실제 orch-stall-detect.mjs 서브프로세스를
//    건드리지 않는다(execFn을 주입해 대체).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
// 3. 로그/생존 기록 파일은 이 시험이 만든 `mkdtemp` 격리 디렉터리에만
//    쓴다(coder-task.md §2-7) -- 실제 관제실 `watch\` 폴더 미접촉.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWatchOnce, buildLogLine, MAX_LOG_LINES } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const NOW_MS = Date.parse("2026-08-03T18:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-"));
}

function progressingExec() {
  return JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" });
}
function stalledExec() {
  return JSON.stringify({ verdict: "STALLED", reasonCode: "DEADLINE_PASSED" });
}

test("happy path: PROGRESSING run appends one log line and writes an alive record via rename (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const renameCalls = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      renameFn: (from, to) => {
        renameCalls.push([from, to]);
        fs.renameSync(from, to);
      },
    });
    assert.equal(
      renameCalls.length,
      1,
      "alive record must be written via rename (atomic)",
    );
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.equal(logText.trim().split("\n").length, 1);
    assert.match(logText, /verdict=PROGRESSING reason=OK/);
    const record = JSON.parse(fs.readFileSync(result.aliveRecordPath, "utf8"));
    assert.equal(record.recordedAtMs, NOW_MS);
    assert.equal(record.verdict, "PROGRESSING");
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("§3-e no-alert-on-false-positive: STALLED verdict produces only one log line, no network/process side effects (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => stalledExec(),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.equal(logText.trim().split("\n").length, 1);
    assert.match(logText, /verdict=STALLED reason=DEADLINE_PASSED/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("runner failure (spawn itself fails) is distinguished from a detector-reported verdict (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => {
        throw new Error("ENOENT: node binary not found");
      },
    });
    assert.equal(result.detectorResult.runnerFailure, true);
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(logText, /RUNNER_FAILURE/);
    const record = JSON.parse(fs.readFileSync(result.aliveRecordPath, "utf8"));
    assert.equal(record.runnerFailure, true);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("detector exit code (execFileSync-style thrown error with .status) is captured, not swallowed as runner failure (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const err = new Error("Command failed");
    err.status = 2;
    err.stdout = JSON.stringify({ verdict: "STALLED", reasonCode: "X" });
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => {
        throw err;
      },
    });
    assert.equal(result.detectorResult.runnerFailure, false);
    assert.equal(result.detectorResult.exitCode, 2);
    assert.equal(result.detectorResult.verdict, "STALLED");
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("log rotation: a log pre-seeded at MAX_LOG_LINES stays capped after one more run, dropping the oldest line (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    const logPath = join(watchDir, "watch.log");
    const seeded =
      Array.from({ length: MAX_LOG_LINES }, (_, i) => `SEED_LINE_${i}`).join(
        "\n",
      ) + "\n";
    fs.writeFileSync(logPath, seeded, "utf8");
    const last = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
    });
    const logText = fs.readFileSync(last.logPath, "utf8");
    const lines = logText.trim().split("\n");
    assert.equal(
      lines.length,
      MAX_LOG_LINES,
      `expected exactly ${MAX_LOG_LINES}, got ${lines.length}`,
    );
    assert.equal(
      lines[0],
      "SEED_LINE_1",
      "oldest line (SEED_LINE_0) must have been dropped",
    );
    assert.match(lines[lines.length - 1], /verdict=PROGRESSING/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// HYK-228 5R (coder-task.md §1 항2, review-r3.md 반려 재현 고정) --
// resolveWatchOnceFsFns가 fs 기본값을 `??`로 해석했을 때 관측 가능한
// 차이가 생겼던 그 경로를 회귀 시험으로 고정한다: `readFn: null`을 명시
// 주입하면(기존 기본 파라미터와 동형으로) `null`은 기본값으로 치환되지
// 않고 그대로 appendLogWithRotation에 전달돼 예외 -> catch에서 기존
// 로그를 빈 값으로 처리한다(2R 원본 동작). `??`로 되돌아가면 `readFn`이
// `readFileSync`로 치환돼 기존 로그가 보존되므로, 이 시험은 그 회귀를
// 곧바로 잡는다.
test("HYK-228 5R regression: readFn:null on an existing on-disk log is NOT defaulted (matches pre-refactor behavior -- null is swallowed by appendLogWithRotation's catch, old line is not preserved) (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    const logPath = join(watchDir, "watch.log");
    fs.writeFileSync(logPath, "old-line\n", "utf8");
    const last = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: null,
    });
    const logText = fs.readFileSync(last.logPath, "utf8");
    assert.doesNotMatch(
      logText,
      /old-line/,
      "readFn:null must not be silently defaulted to readFileSync (?? semantics) -- the pre-existing log line must be lost, exactly like the pre-HYK-228-4R behavior",
    );
    const lines = logText.trim().split("\n");
    assert.equal(
      lines.length,
      1,
      "only the new line should be present -- the old on-disk line was never read back in",
    );
    assert.match(lines[0], /verdict=PROGRESSING/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("buildLogLine: runner failure and detector result produce distinguishable single-line formats (2/2)", () => {
  const failLine = buildLogLine({
    nowIso: "2026-08-03T18:00:00.000Z",
    detectorResult: { runnerFailure: true, message: "boom" },
  });
  assert.match(
    failLine,
    /^2026-08-03T18:00:00\.000Z RUNNER_FAILURE message=boom$/,
  );
  const okLine = buildLogLine({
    nowIso: "2026-08-03T18:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
    },
  });
  assert.match(failLine === okLine ? "same" : "different", /different/);
  assert.match(okLine, /verdict=PROGRESSING/);
});

// ---------------------------------------------------------------------------
// HYK-185-seat-idle-1 (coder-task.md §2-1-3) -- 새 «유휴 방치 좌석» 필드가
// 기존 seat_* 필드와 구별되는 이름(`idle_*`)으로 로그 줄에 실린다.
// ---------------------------------------------------------------------------
test("HYK-185-seat-idle-1: seatIdle fields from detector stdout are logged with distinct idle_* names (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: { status: "SEAT_LIVENESS_NOT_APPLICABLE" },
          seatIdle: {
            status: "SEAT_IDLE_JUDGED",
            verdict: "SUSPECTED_ABANDONED",
            worstCount: 1,
            totalWorktrees: 2,
          },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /idle_status=SEAT_IDLE_JUDGED idle_verdict=SUSPECTED_ABANDONED idle_worst_count=1 idle_worktrees=2/,
    );
    assert.match(logText, /seat_status=SEAT_LIVENESS_NOT_APPLICABLE/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-185-startcheck-wire (coder-task.md §2-1-3, §3-c): dispatchStart 축도
// 로그 줄에 옮겨 적힌다 -- 기존 seat_*/idle_*와 구별되는 start_* 접두.
// ---------------------------------------------------------------------------
test("HYK-185-startcheck-wire: dispatchStart fields from detector stdout are logged with distinct start_* names (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: { status: "SEAT_LIVENESS_NOT_APPLICABLE" },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: {
            status: "DISPATCH_START_JUDGED",
            verdict: "NOT_STARTED",
            worstCount: 1,
            totalWorktrees: 2,
          },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /start_status=DISPATCH_START_JUDGED start_verdict=NOT_STARTED start_worst_count=1 start_worktrees=2/,
    );
    assert.match(logText, /seat_status=SEAT_LIVENESS_NOT_APPLICABLE/);
    assert.match(logText, /idle_status=SEAT_IDLE_NOT_APPLICABLE/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-185-unconsumed-1 (coder-task.md §2-3, §3-c): unconsumed 축도 로그
// 줄에 옮겨 적힌다 -- 기존 세 축(seat_*/idle_*/start_*)과 구별되는
// unconsumed_* 접두.
// ---------------------------------------------------------------------------
test("HYK-185-unconsumed-1: unconsumed fields from detector stdout are logged with distinct unconsumed_* names (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: { status: "SEAT_LIVENESS_NOT_APPLICABLE" },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: { status: "DISPATCH_START_NOT_APPLICABLE" },
          unconsumed: {
            status: "UNCONSUMED_JUDGED",
            verdict: "SUSPECTED_UNCONSUMED",
            worstCount: 1,
            totalWorktrees: 2,
          },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /unconsumed_status=UNCONSUMED_JUDGED unconsumed_verdict=SUSPECTED_UNCONSUMED unconsumed_worst_count=1 unconsumed_worktrees=2/,
    );
    assert.match(logText, /seat_status=SEAT_LIVENESS_NOT_APPLICABLE/);
    assert.match(logText, /idle_status=SEAT_IDLE_NOT_APPLICABLE/);
    assert.match(logText, /start_status=DISPATCH_START_NOT_APPLICABLE/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// HYK-265-observe-split-1 (coder-task.md §3-1 항2·§4 완료조건2): 수집
// 실패(COLLECTION_FAILED)일 때 observationReason/reason이 로그 줄까지
// 닿는지 직접 확인한다(seat -- observationReason 있음, unconsumed --
// observationReason 없이 reason만).
test("HYK-265-observe-split-1: seatLiveness COLLECTION_FAILED with observationReason+reason -> seat_reason_detail= token in watch.log (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: {
            status: "SEAT_LIVENESS_COLLECTION_FAILED",
            observationReason: "AMBIGUOUS",
            reason: "orca terminal list failed: multiple candidates",
          },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: { status: "DISPATCH_START_NOT_APPLICABLE" },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(logText, /seat_status=SEAT_LIVENESS_COLLECTION_FAILED/);
    assert.match(
      logText,
      /seat_reason_detail=AMBIGUOUS:orca_terminal_list_failed:_multiple_candidates/,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-265-observe-split-1: unconsumed COLLECTION_FAILED with reason only (no observationReason) -> unconsumed_reason_detail= token, and normal statuses produce NO *_reason_detail= tokens (regression -- noise stays 0 in the common case) (2/2)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: { status: "SEAT_LIVENESS_NOT_APPLICABLE" },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: { status: "DISPATCH_START_NOT_APPLICABLE" },
          unconsumed: {
            status: "UNCONSUMED_COLLECTION_FAILED",
            reason: "unconsumed: git log failed",
          },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /unconsumed_reason_detail=unconsumed:_git_log_failed/,
    );
    assert.doesNotMatch(logText, /seat_reason_detail=/);
    assert.doesNotMatch(logText, /idle_reason_detail=/);
    assert.doesNotMatch(logText, /start_reason_detail=/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-185-unconsumed-1: missing unconsumed field in detector stdout logs unconsumed_status=NONE (regression guard: old detector payloads without this axis still parse) (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(logText, /unconsumed_status=NONE/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-210-human-log-1 (coder-task.md §1-§2) -- HYK-207이 좌석별 조회
// 실패를 판정 객체(seatLiveness/dispatchStart의 correlation.
// partialFailures)까지 보존하는데, 그 사유가 사람이 읽는 한 줄 로그에는
// 아직 안 실린다는 «마지막 한 조각». buildLogLine을 직접 호출해(§3
// "도달 경로") 합성 detectorResult로 고정한다.
// ---------------------------------------------------------------------------
test("HYK-210-human-log-1: buildLogLine renders per-seat partial-failure reasons as a human-readable seat_partial_failure_detail token (direct call, synthetic detectorResult) (1/1)", () => {
  const okLine = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatLivenessStatus: "SEAT_LIVENESS_JUDGED",
      seatLivenessVerdict: "SUSPECTED_UNRESPONSIVE",
      seatLivenessWorstCount: 1,
      seatLivenessTotalWorktrees: 2,
      seatLivenessPartialFailures: [
        {
          handle: "term_review-seat",
          reason:
            "orca-adapter: resolveDeliveredSeat -- terminal show query threw for candidate 'term_review-seat' (ETIMEDOUT)",
        },
      ],
    },
  });
  assert.match(okLine, /seat_partial_failures=1/);
  // 사유 원문(공백->밑줄)은 MAX_PARTIAL_FAILURE_REASON_CHARS(60자)에서
  // "..."로 잘린다(§2 "줄을 폭발시키지 마라") -- 뒤쪽(ETIMEDOUT)은 잘려
  // 나가지만 앞부분만으로도 사람이 "뭐가 실패했는지" 알아볼 수 있다.
  assert.match(
    okLine,
    /seat_partial_failure_detail=term_review-seat:orca-adapter:_resolveDeliveredSeat_--_terminal_show_query_th\.\.\./,
  );
  assert.doesNotMatch(okLine, /\[object Object\]/);
  assert.equal(okLine.includes("\n"), false, "must stay a single line");
});

test("HYK-210-human-log-1: buildLogLine caps items shown and marks the remainder with a count, does not explode the line (2 failures -> both items + no '+N_more' since both fit within the cap) (1/1)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      startStatus: "DISPATCH_START_JUDGED",
      startVerdict: "NOT_STARTED",
      startWorstCount: 1,
      startTotalWorktrees: 2,
      startPartialFailures: [
        { handle: "term_a", reason: "one" },
        { handle: "term_b", reason: "two" },
        { handle: "term_c", reason: "three" },
      ],
    },
  });
  assert.match(line, /start_partial_failures=3/);
  assert.match(
    line,
    /start_partial_failure_detail=term_a:one\|term_b:two\|\+1_more/,
  );
  // 한 줄 로그다 -- 개행이 섞여 들면 "한 줄"이라는 계약 자체가 깨진다.
  assert.equal(line.includes("\n"), false);
});

test("HYK-210-human-log-1: buildLogLine falls back to a readable placeholder (not '[object Object]') when a failure's reason/handle is not a string (malformed input guard) (1/1)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatLivenessPartialFailures: [
        { handle: { nested: "object" }, reason: { also: "an object" } },
      ],
    },
  });
  assert.doesNotMatch(line, /\[object Object\]/);
  assert.match(
    line,
    /seat_partial_failure_detail=unknown_handle:reason_unavailable/,
  );
});

test("HYK-210-human-log-1/HYK-212-postcheck-1/HYK-239-chain-wire-2/HYK-240: no partial failures -> log line is byte-identical to the pre-HYK-210 format up through the cap segment, plus the HYK-173-push-wire escalation segment, the HYK-212-postcheck-1 postcheck segment, the HYK-239-chain-wire-2 chain segment, and now the HYK-240 binding segment appended at the very end (existing consumer regression guard, coder-task.md §7-7/§6 '기존 축 회귀 0') (1/1)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
    },
  });
  assert.equal(
    line,
    "2026-08-09T12:00:00.000Z exit=0 verdict=PROGRESSING reason=OK " +
      "seat_status=NONE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=NONE " +
      "idle_status=NONE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=NONE " +
      "start_status=NONE start_verdict=NONE start_worst_count=NONE start_worktrees=NONE " +
      "unconsumed_status=NONE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=NONE " +
      "cap_status=NONE cap_verdict=NONE cap_value=NONE cap_source=NONE " +
      "escalation_status=NONE escalation_verdict=NONE escalation_worst_count=NONE escalation_worktrees=NONE " +
      "postcheck_status=NONE postcheck_verdict=NONE postcheck_worst_count=NONE postcheck_worktrees=NONE " +
      "chain_status=NONE chain_verdict=NONE chain_worst_count=NONE chain_worktrees=NONE " +
      "binding_status=NONE binding_verdict=NONE binding_worst_count=NONE binding_worktrees=NONE",
  );
});

// ---------------------------------------------------------------------------
// 다좌석 상황 합성(coder-task.md §3 "볼 것" ⓐ) -- 실물 orch-stall-detect.mjs
// 를 부르지 않고 그 stdout 모양(seatLiveness.worktrees[].correlation.
// partialFailures, 실측 orch-stall-detect.mjs judgeSeatLivenessAcrossWorktrees/
// resolveObservationWithDeliveredSeatFallback 참조)만 흉내 낸 execFn을 주입해
// runWatchOnce 전체 결선(파싱 -> buildLogLine -> 파일 append)이 실제로
// 사유를 로그 줄에 싣는지를 못 박는다. ★이 결선(추출부)을 지우면 RED가
// 된다 -- §4 변조 ⓐ가 이 시험이다.
// ---------------------------------------------------------------------------
test("HYK-210-human-log-1: runWatchOnce with a synthetic multi-seat detector stdout writes the per-seat failure reason into watch.log end-to-end (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: {
            status: "SEAT_LIVENESS_JUDGED",
            verdict: "RESPONSIVE",
            worstCount: 0,
            totalWorktrees: 2,
            worktrees: [
              {
                worktreePath: "/repo/main",
                status: "SEAT_LIVENESS_JUDGED",
                verdict: "RESPONSIVE",
                correlation: {
                  attempted: true,
                  ok: true,
                  handle: "term_matched-seat",
                  partialFailures: [
                    {
                      handle: "term_review-seat",
                      reason:
                        "orca-adapter: resolveDeliveredSeat -- terminal show query threw for candidate 'term_review-seat' (transient orca CLI failure)",
                    },
                  ],
                },
              },
              {
                worktreePath: "/repo/hyk210",
                status: "SEAT_LIVENESS_NOT_APPLICABLE",
              },
            ],
          },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: { status: "DISPATCH_START_NOT_APPLICABLE" },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(logText, /seat_partial_failures=1/);
    assert.match(
      logText,
      /seat_partial_failure_detail=term_review-seat:orca-adapter:_resolveDeliveredSeat_--_terminal_show_query_th\.\.\./,
    );
    assert.doesNotMatch(logText, /\[object Object\]/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-421 1R (결함 2, coder-task.md §5 완료조건5 "결선 확인") -- 위 시험과
// 동일 형태로, orch-stall-detect.mjs stdout 모양에 liveDispatchJudgedCount/
// liveDispatchVerdict가 실려 오면 buildLogLine이 실제로 watch.log 끝에
// seat_live_* 토큰을 싣는지 결선 그 자체를 증명한다(헛시험 방지 -- 이
// 시험은 시험 helper가 아니라 runWatchOnce의 실 경로를 그대로 탄다).
// ---------------------------------------------------------------------------
test("HYK-421 1R ⑵: runWatchOnce -- detector stdout의 seatLiveness.liveDispatchJudgedCount/liveDispatchVerdict가 watch.log 끝에 seat_live_judged_count=/seat_live_verdict= 토큰으로 실제로 실린다 (결선 증명)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: {
            status: "SEAT_LIVENESS_NOT_APPLICABLE", // 대표는 무대상이어도(동률),
            worstCount: 1,
            totalWorktrees: 2,
            worktrees: [],
            liveDispatchJudgedCount: 1, // 실제로는 정상 판정된 배달이 있었다.
            liveDispatchVerdict: "RESPONSIVE",
          },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: { status: "DISPATCH_START_NOT_APPLICABLE" },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /seat_live_judged_count=1 seat_live_verdict=RESPONSIVE/,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-421 1R ⑵: detector stdout에 liveDispatchJudgedCount 필드가 아예 없으면(옛 stdout 모양) seat_live_* 토큰이 로그 줄에 전혀 붙지 않는다 (byte-identical 회귀 0 -- filter(Boolean) 경로 증명)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: { status: "SEAT_LIVENESS_NOT_APPLICABLE" },
          seatIdle: { status: "SEAT_IDLE_NOT_APPLICABLE" },
          dispatchStart: { status: "DISPATCH_START_NOT_APPLICABLE" },
        }),
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.doesNotMatch(logText, /seat_live_judged_count=/);
    assert.doesNotMatch(logText, /seat_live_verdict=/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #6·#7) -- mkdtemp만 썼다.
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "watch-run.test.mjs must leave the real worktree exactly as it found it",
  );
});
