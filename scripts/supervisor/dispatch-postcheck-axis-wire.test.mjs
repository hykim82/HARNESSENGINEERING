// HYK-212-postcheck-1 (coder-task.md §4 요건3) -- «배달 레코드 미생성»
// 축이 실제로 받는함(D:/문서관리/통역/받는함과 같은 자리, notifyDir)에
// reach-notify-*.md 파일을 만드는지 end-to-end로 고정한다.
// escalation-axis-wire.test.mjs의 "§4 요건3 end-to-end" 시험과 동형 --
// AXES 등록이 빠지면(§5 변조③) 이 시험이 RED가 되어야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runWatchOnce } from "./watch-run.mjs";
import { AXES } from "./reach-report-core.mjs";
import { DISPATCH_POSTCHECK_VERDICT } from "../relay/adapters/dispatch-postcheck-core.mjs";

test("static: 'postcheck' is registered in reach-report-core.mjs AXES (closed array)", () => {
  assert.ok(AXES.some((a) => a.key === "postcheck"));
});

test("§4 요건3 end-to-end: runWatchOnce with a RECORD_MISSING postcheck axis actually writes a reach-notify-*.md file into notifyDir, and the file names the harness task", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk212-watch-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk212-notify-"));
  try {
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        postcheck: {
          status: "JUDGED",
          verdict: DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
          worstCount: 1,
          totalWorktrees: 1,
          runtimeTaskId: "task_b7c8a24f9edb",
          harnessTaskId: "HYK-212-postcheck-1",
          worktreePath: "C:/wt/hyk212",
        },
      });
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-09T12:00:00.000Z"),
      notifyDir,
    });
    assert.ok(
      result.reachResult.noticePath,
      "a notice file path must be returned",
    );
    assert.ok(
      fs.existsSync(result.reachResult.noticePath),
      "the reach-notify-*.md file must actually exist on disk",
    );
    const noticeText = fs.readFileSync(result.reachResult.noticePath, "utf8");
    assert.match(
      noticeText,
      new RegExp(DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING),
    );
    // §4 요건2: 사람이 읽는 로그 상세에는 어느 태스크·어느 워크트리인지가
    // 실려야 한다(postcheck_detail=, watch.log 쪽 -- notifyDir의 요약문
    // 자체는 AXES 공통 형식이라 label/verdict만 담는다). watch.log를
    // 직접 읽어 그 상세가 실제로 남았는지 확인한다.
    const watchLog = fs.readFileSync(path.join(watchDir, "watch.log"), "utf8");
    assert.match(watchLog, /postcheck_verdict=RECORD_MISSING/);
    assert.match(
      watchLog,
      /postcheck_detail=HYK-212-postcheck-1\/task_b7c8a24f9edb@C:\/wt\/hyk212/,
    );
    const noticeFiles = fs
      .readdirSync(notifyDir)
      .filter((f) => f.startsWith("reach-notify-"));
    assert.equal(noticeFiles.length, 1);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("§3-2 zero false positives: runWatchOnce with a CONFIRMED postcheck axis (normal delivery) writes NO notice file", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk212-watch-ok-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk212-notify-ok-"));
  try {
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        postcheck: {
          status: "JUDGED",
          verdict: DISPATCH_POSTCHECK_VERDICT.CONFIRMED,
          worstCount: 0,
          totalWorktrees: 1,
        },
      });
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-09T12:00:00.000Z"),
      notifyDir,
    });
    assert.equal(result.reachResult.noticePath, null);
    const noticeFiles = fs
      .readdirSync(notifyDir)
      .filter((f) => f.startsWith("reach-notify-"));
    assert.equal(noticeFiles.length, 0);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("§3-3 query failure is not silently treated as normal: DISPATCH_POSTCHECK_QUERY_FAILED status alone (no RECORD_MISSING verdict) still opens an anomaly (badStatuses)", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk212-watch-qf-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk212-notify-qf-"));
  try {
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        postcheck: {
          status: "DISPATCH_POSTCHECK_QUERY_FAILED",
          verdict: null,
          worstCount: 1,
          totalWorktrees: 1,
        },
      });
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-09T12:00:00.000Z"),
      notifyDir,
    });
    assert.ok(
      result.reachResult.noticePath,
      "a query-failed postcheck must still surface as an open anomaly (not silently treated as normal)",
    );
    const noticeText = fs.readFileSync(result.reachResult.noticePath, "utf8");
    assert.match(noticeText, /DISPATCH_POSTCHECK_QUERY_FAILED/);
    assert.doesNotMatch(
      noticeText,
      new RegExp(DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING),
      "a query failure must never be worded/matched as the RECORD_MISSING alarm",
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});
