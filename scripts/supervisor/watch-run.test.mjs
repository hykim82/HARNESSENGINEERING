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
