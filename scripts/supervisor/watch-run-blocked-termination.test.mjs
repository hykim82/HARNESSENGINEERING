// HYK-342/HYK-249 §4 요구7 (coder-task.md 머리말 1b_reach_path) -- BLOCKED-
// termination 가시성 축(scanBlockedTerminationRecords/
// blockedTerminationLogSegment) 시험.
//
// 이 스위트가 증명하는 것:
// 1. relay-handshake.mjs가 남기는 중단 기록(evidence.source ===
//    "relay-handshake-blocked-termination")을 스캔해 개수/상태를 뽑는다.
// 2. 그 소스가 아닌(다른 축이 남긴) 중단 기록은 세지 않는다.
// 3. `blockedTerminationScan`을 opt-in으로 주지 않은 기존 `runWatchOnce`
//    호출자는 로그 줄이 한 글자도 달라지지 않는다(회귀 0).
// 4. opt-in으로 주면 실제 프로덕션 진입점(runWatchOnce)을 통해서도
//    `blocked_termination_status=`/`blocked_termination_count=` 세그먼트가
//    로그 줄에 남는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runWatchOnce,
  buildLogLine,
  scanBlockedTerminationRecords,
} from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-08-24T09:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-blocked-term-"));
}

function progressingExec() {
  return JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" });
}

function writeAbortJson(abortsDir, name, content) {
  fs.mkdirSync(abortsDir, { recursive: true });
  fs.writeFileSync(join(abortsDir, name), JSON.stringify(content), "utf8");
}

test("scanBlockedTerminationRecords: aborts/ 디렉터리가 없으면 status=NONE, count=0 (진짜 흔한 경우)", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-scan-bt-"));
  const result = scanBlockedTerminationRecords({ harnessDir: dir });
  assert.deepEqual(result, { status: "NONE", count: 0, records: [] });
});

test("scanBlockedTerminationRecords: evidence.source가 relay-handshake-blocked-termination인 기록만 센다", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-scan-bt-"));
  const abortsDir = join(dir, "aborts");
  writeAbortJson(abortsDir, "CODER-abort-r1.json", {
    role: "CODER",
    harnessTaskLabel: "HYK-1",
    evidence: {
      source: "relay-handshake-blocked-termination",
      state: "BLOCKED",
    },
    recordedAt: "2026-08-24T00:00:00.000Z",
  });
  // 다른 출처(예: 사람이 손으로 만든 HYK-298 MISSING-label 중단 기록)는
  // 세지 않는다 -- 이 축은 오직 relay-handshake.mjs의 termination 경로만
  // 표면화한다.
  writeAbortJson(abortsDir, "REVIEW-abort-r1.json", {
    role: "REVIEW",
    harnessTaskLabel: "HYK-2",
    evidence: "사람이 직접 기록함",
    recordedAt: "2026-08-24T00:00:01.000Z",
  });
  const result = scanBlockedTerminationRecords({ harnessDir: dir });
  assert.equal(result.status, "FOUND");
  assert.equal(result.count, 1);
  assert.equal(result.records[0].role, "CODER");
  assert.equal(result.records[0].taskId, "HYK-1");
  assert.equal(result.records[0].state, "BLOCKED");
});

test("scanBlockedTerminationRecords: 손상된(파싱 불가) 기록 파일은 그 파일만 건너뛴다", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-scan-bt-"));
  const abortsDir = join(dir, "aborts");
  fs.mkdirSync(abortsDir, { recursive: true });
  fs.writeFileSync(join(abortsDir, "CODER-abort-r1.json"), "{not json", "utf8");
  writeAbortJson(abortsDir, "CODER-abort-r2.json", {
    role: "CODER",
    harnessTaskLabel: "HYK-3",
    evidence: {
      source: "relay-handshake-blocked-termination",
      state: "NEEDS_INPUT",
    },
  });
  const result = scanBlockedTerminationRecords({ harnessDir: dir });
  assert.equal(result.count, 1);
  assert.equal(result.records[0].taskId, "HYK-3");
});

test("회귀 0: blockedTerminationScan을 주지 않으면(기존 호출자) 로그 줄이 한 글자도 달라지지 않는다", () => {
  const watchDirOff = tmpWatchDir();
  const watchDirRef = tmpWatchDir();
  try {
    const off = runWatchOnce({
      repoRoot: ROOT,
      watchDir: watchDirOff,
      now: NOW_MS,
      execFn: () => progressingExec(),
    });
    const ref = runWatchOnce({
      repoRoot: ROOT,
      watchDir: watchDirRef,
      now: NOW_MS,
      execFn: () => progressingExec(),
    });
    assert.equal(off.line, ref.line);
    assert.equal(
      off.line.includes("blocked_termination"),
      false,
      "opt-in 하지 않으면 이 축의 세그먼트 자체가 로그 줄에 없어야 한다",
    );
  } finally {
    fs.rmSync(watchDirOff, { recursive: true, force: true });
    fs.rmSync(watchDirRef, { recursive: true, force: true });
  }
});

test("opt-in: blockedTerminationScan을 주면 실제 runWatchOnce 진입점을 통해서도 로그 줄에 이 축이 표면화된다", () => {
  const watchDir = tmpWatchDir();
  const harnessDir = fs.mkdtempSync(join(tmpdir(), "nc-watch-run-bt-harness-"));
  try {
    writeAbortJson(join(harnessDir, "aborts"), "CODER-abort-r1.json", {
      role: "CODER",
      harnessTaskLabel: "HYK-9400",
      evidence: {
        source: "relay-handshake-blocked-termination",
        state: "BLOCKED",
      },
      recordedAt: "2026-08-24T00:00:00.000Z",
    });
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      blockedTerminationScan: { harnessDir },
    });
    assert.match(result.line, /blocked_termination_status=FOUND/);
    assert.match(result.line, /blocked_termination_count=1/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("buildLogLine: blockedTerminationResult가 없으면 세그먼트 없이 기존과 동일한 모양(filter(Boolean) 확인)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-24T00:00:00.000Z",
    detectorResult: { exitCode: 0, verdict: "PROGRESSING", reasonCode: "OK" },
    capResult: {},
    escalationDedupe: {},
  });
  assert.equal(line.includes("blocked_termination"), false);
});
