// HYK-239-chain-wire-2 (coder-task.md §1, 검토 1R 반려 수리) -- «원장
// 해시체인 위조 탐지» 축이 실제로 받는함(D:/문서관리/통역/받는함과 같은
// 자리, notifyDir)에 reach-notify-*.md 파일을 만드는지 end-to-end로
// 고정한다. dispatch-postcheck-axis-wire.test.mjs의 동형 시험과 대칭 --
// AXES 등록이 빠지면 이 시험이 RED가 되어야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runWatchOnce } from "./watch-run.mjs";
import { AXES, parseLogLine } from "./reach-report-core.mjs";
import { CHAIN_VERDICT } from "./orch-stall-detect.mjs";

test("static: 'chain' is registered in reach-report-core.mjs AXES (closed array)", () => {
  assert.ok(AXES.some((a) => a.key === "chain"));
});

test("§1 end-to-end: runWatchOnce with a TAMPER_DETECTED chain axis actually writes a reach-notify-*.md file into notifyDir, and the file names the tampered issue", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk239-watch-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk239-notify-"));
  try {
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        chain: {
          status: "JUDGED",
          verdict: CHAIN_VERDICT.TAMPER_DETECTED,
          worstCount: 1,
          totalWorktrees: 1,
          issueId: "HYK-9301",
          reason:
            "reject-streak append-only: HYK-9301 -- primary ledger history[1] no longer matches checkpoint",
          worktreePath: "C:/wt/hyk239",
        },
      });
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-12T12:00:00.000Z"),
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
    assert.match(noticeText, new RegExp(CHAIN_VERDICT.TAMPER_DETECTED));
    // §1 요건2: 사람이 읽는 상세(어느 이슈·무슨 사유)는 watch.log의
    // chain_detail=에 실린다(postcheck_detail과 동일 원칙 -- notifyDir의
    // 요약문 자체는 AXES 공통 형식이라 label/verdict만 담는다).
    const watchLog = fs.readFileSync(path.join(watchDir, "watch.log"), "utf8");
    assert.match(watchLog, /chain_verdict=TAMPER_DETECTED/);
    assert.match(watchLog, /chain_detail=HYK-9301@C:\/wt\/hyk239:/);
    const noticeFiles = fs
      .readdirSync(notifyDir)
      .filter((f) => f.startsWith("reach-notify-"));
    assert.equal(noticeFiles.length, 1);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("§4 설계 제약 4 거짓 경보 0: runWatchOnce with a CLEAN chain axis (normal, no tamper) writes NO notice file", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk239-watch-ok-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk239-notify-ok-"));
  try {
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        chain: {
          status: "JUDGED",
          verdict: CHAIN_VERDICT.CLEAN,
          worstCount: 0,
          totalWorktrees: 1,
        },
      });
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-12T12:00:00.000Z"),
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

test("§1 설계 제약 5 판정 불가를 위조로 보고하지 않는다: CHAIN_QUERY_FAILED status alone (no TAMPER_DETECTED verdict) still opens an anomaly (badStatuses) but is never worded as TAMPER_DETECTED", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk239-watch-qf-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk239-notify-qf-"));
  try {
    const execFn = () =>
      JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        chain: {
          status: "CHAIN_QUERY_FAILED",
          verdict: null,
          worstCount: 1,
          totalWorktrees: 1,
        },
      });
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-12T12:00:00.000Z"),
      notifyDir,
    });
    assert.ok(
      result.reachResult.noticePath,
      "a query-failed chain axis must still surface as an open anomaly (not silently treated as normal)",
    );
    const noticeText = fs.readFileSync(result.reachResult.noticePath, "utf8");
    assert.match(noticeText, /CHAIN_QUERY_FAILED/);
    assert.doesNotMatch(
      noticeText,
      new RegExp(CHAIN_VERDICT.TAMPER_DETECTED),
      "a query failure must never be worded/matched as the TAMPER_DETECTED alarm",
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("§7-7 기존 축 회귀 0: adding chain_* fields at the end does not change how postcheck/escalation/cap fields parse", () => {
  const line =
    "2026-08-12T12:00:00.000Z exit=0 verdict=PROGRESSING reason=OK " +
    "seat_status=NONE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=NONE " +
    "idle_status=NONE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=NONE " +
    "start_status=NONE start_verdict=NONE start_worst_count=NONE start_worktrees=NONE " +
    "unconsumed_status=NONE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=NONE " +
    "cap_status=OK cap_verdict=DECIDED cap_value=2 cap_source=/x " +
    "escalation_status=ESCALATION_OK escalation_verdict=NONE escalation_worst_count=NONE escalation_worktrees=NONE " +
    "postcheck_status=OK postcheck_verdict=RECORD_MISSING postcheck_worst_count=1 postcheck_worktrees=1 " +
    "chain_status=JUDGED chain_verdict=TAMPER_DETECTED chain_worst_count=1 chain_worktrees=1";
  const parsed = parseLogLine(line);
  assert.equal(parsed.axes.postcheck.verdict, "RECORD_MISSING");
  assert.equal(parsed.axes.escalation.status, "ESCALATION_OK");
  assert.equal(parsed.axes.cap.verdict, "DECIDED");
  assert.equal(parsed.axes.chain.status, "JUDGED");
  assert.equal(parsed.axes.chain.verdict, "TAMPER_DETECTED");
  assert.equal(parsed.axes.chain.worstCount, 1);
  assert.equal(parsed.axes.chain.worktrees, 1);
});
