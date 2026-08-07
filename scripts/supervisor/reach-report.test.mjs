// HYK-191-reach-1 (coder-task.md §5, §7) -- reach-report.mjs wire 계약
// 시험. ★모든 경로는 이 시험이 만든 mkdtemp 격리 디렉터리다 -- 실
// 관제실(`D:/문서관리/하네스-관제실`)·실 받는함(`D:/문서관리/통역/받는함`)
// 미접촉(coder-task.md §5 비타협). 이 시험이 실제로 그 두 실경로를
// 건드리지 않는다는 것은 reach-report-realpath-invariance.test.mjs가
// 바이트 단위로 재확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReachOnce } from "./reach-report.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function watchLogLine({
  ts,
  idleVerdict = "NONE",
  idleStatus = "SEAT_IDLE_NOT_APPLICABLE",
}) {
  return (
    `${ts} exit=0 verdict=PROGRESSING reason=OK ` +
    `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
    `idle_status=${idleStatus} idle_verdict=${idleVerdict} idle_worst_count=NONE idle_worktrees=1 ` +
    `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
    `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`
  );
}

test("(a)(b) real repro paths: writes a non-blank report file + prints text with an explicit open anomaly and its duration (1/1)", () => {
  const root = tmpDir("nc-reach-wire-");
  try {
    const watchLogPath = join(root, "watch.log");
    const reportOutPath = join(root, "morning-report.md");
    const statePath = join(root, "state.json");
    const notifyDir = join(root, "받는함");
    const t0 = Date.parse("2026-08-05T00:00:00.000Z");
    fs.writeFileSync(
      watchLogPath,
      [
        watchLogLine({
          ts: new Date(t0).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
        watchLogLine({
          ts: new Date(t0 + 3_600_000).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
      ].join("\n"),
      "utf8",
    );
    const result = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0 + 3_600_000,
    });
    assert.match(result.reportText, /좌석 유휴 방치/);
    assert.match(result.reportText, /1시간 0분째/);
    const written = fs.readFileSync(reportOutPath, "utf8");
    assert.equal(written, result.reportText);
    assert.ok(written.trim().length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(c) transition writes a notice file into notifyDir on first open, second identical tick writes NO second notice file (2/2)", () => {
  const root = tmpDir("nc-reach-notify-");
  try {
    const watchLogPath = join(root, "watch.log");
    const reportOutPath = join(root, "morning-report.md");
    const statePath = join(root, "state.json");
    const notifyDir = join(root, "받는함");
    const t0 = Date.parse("2026-08-05T00:00:00.000Z");

    fs.writeFileSync(
      watchLogPath,
      watchLogLine({
        ts: new Date(t0).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
      "utf8",
    );
    const first = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0,
    });
    assert.equal(
      first.toNotify.length,
      1,
      "first tick: newly opened -> notified",
    );
    assert.ok(first.noticePath, "a notice file must have been written");
    assert.ok(fs.existsSync(first.noticePath));
    const filesAfterFirst = fs.readdirSync(notifyDir);
    assert.equal(filesAfterFirst.length, 1);

    // same anomaly, second tick 15 minutes later -- still SUSPECTED_ABANDONED
    fs.appendFileSync(
      watchLogPath,
      "\n" +
        watchLogLine({
          ts: new Date(t0 + 15 * 60000).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
    );
    const second = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0 + 15 * 60000,
    });
    assert.equal(
      second.toNotify.length,
      0,
      "(d) second tick: same ongoing anomaly -> no repeat notice",
    );
    const filesAfterSecond = fs.readdirSync(notifyDir);
    assert.equal(
      filesAfterSecond.length,
      1,
      "still exactly one notice file after the second tick",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(b) no anomalies at all -> report explicitly says 없음, and no notice file is written (2/2)", () => {
  const root = tmpDir("nc-reach-clean-");
  try {
    const watchLogPath = join(root, "watch.log");
    const reportOutPath = join(root, "morning-report.md");
    const statePath = join(root, "state.json");
    const notifyDir = join(root, "받는함");
    const t0 = Date.parse("2026-08-05T00:00:00.000Z");
    fs.writeFileSync(
      watchLogPath,
      watchLogLine({ ts: new Date(t0).toISOString() }),
      "utf8",
    );
    const result = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0,
    });
    assert.match(result.reportText, /없음/);
    assert.equal(result.toNotify.length, 0);
    assert.equal(result.noticePath, null);
    assert.equal(
      fs.existsSync(notifyDir),
      false,
      "notifyDir is not even created when there is nothing to notify",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing watch.log (not yet written) does not throw -- report still renders, explicitly says 없음 (1/1)", () => {
  const root = tmpDir("nc-reach-missing-");
  try {
    const result = runReachOnce({
      watchLogPath: join(root, "does-not-exist.log"),
      reportOutPath: join(root, "morning-report.md"),
      statePath: join(root, "state.json"),
      notifyDir: join(root, "받는함"),
      now: Date.now(),
    });
    assert.match(result.reportText, /없음/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
