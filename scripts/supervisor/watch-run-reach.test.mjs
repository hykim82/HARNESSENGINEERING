// HYK-191-reach-1 (coder-task.md §1 요건3, §7) -- watch-run.mjs가 매
// 예약 tick마다 reach 단계(reach-report.mjs)를 실제로 부르는지 확인하는
// 결선 시험. 기존 watch-run.test.mjs는 건드리지 않는다(회귀 0 -- 기존
// 시험은 notifyDir을 안 주므로 이 조각 추가 전후로 동작이 완전히 같다,
// watch-run.test.mjs 재실행으로 이미 확인됨). ★모든 경로는 mkdtemp.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runWatchOnce } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-08-05T00:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-reach-"));
}

function idleAbandonedExec() {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    seatIdle: {
      status: "SEAT_IDLE_JUDGED",
      verdict: "SUSPECTED_ABANDONED",
      worstCount: 1,
      totalWorktrees: 1,
    },
  });
}

test("notifyDir supplied: a run whose detector output is anomalous writes a notice file + a morning-report.md inside watchDir (2/2)", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = join(watchDir, "받는함-테스트");
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => idleAbandonedExec(),
      notifyDir,
    });
    assert.equal(result.reachResult.notRun, undefined);
    assert.equal(result.reachResult.failed, undefined);
    assert.ok(
      result.reachResult.noticePath,
      "a transition notice must be written on first anomalous run",
    );
    assert.ok(fs.existsSync(result.reachResult.noticePath));
    assert.ok(fs.existsSync(join(watchDir, "morning-report.md")));
    assert.match(
      fs.readFileSync(join(watchDir, "morning-report.md"), "utf8"),
      /좌석 유휴 방치/,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("notifyDir omitted (default): reach step is skipped entirely -- no morning-report.md, no notice dir created (2/2)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => idleAbandonedExec(),
    });
    assert.equal(result.reachResult.notRun, true);
    assert.equal(fs.existsSync(join(watchDir, "morning-report.md")), false);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("reach step failure (unwritable notifyDir) does not throw and does not stop the base watch-run contract (log+alive record still written) (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    // notifyDir points at a path that a bogus mkdirFn injection will reject.
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => idleAbandonedExec(),
      notifyDir: join(watchDir, "받는함-실패"),
      mkdirFn: (p, opts) => {
        if (String(p).includes("받는함-실패"))
          throw new Error("simulated EACCES");
        fs.mkdirSync(p, opts);
      },
    });
    assert.equal(result.reachResult.failed, true);
    assert.match(result.reachResult.message, /simulated EACCES/);
    assert.ok(
      fs.existsSync(result.logPath),
      "watch.log must still exist despite reach failure",
    );
    assert.ok(
      fs.existsSync(result.aliveRecordPath),
      "last-run.json must still exist despite reach failure",
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});
