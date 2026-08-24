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

// HYK-342 2R P1-3: 이 시험의 전제가 뒤집혔다 -- 이전에는 blockedTermination
// Scan을 안 주면 이 축 자체가 로그 줄에서 사라졌지만(1R, opt-in), 이제는
// "안 주면 repoRoot에서 harnessDir을 스스로 파생해 계속 돈다"가 올바른
// 동작이다(§3 요구: "평소 돌리는 방식 그대로" 실행했을 때 축이 돈다).
// 두 회차가 결정적으로 같은(같은 repoRoot·같은 now) 입력을 주면 로그 줄이
// 여전히 서로 같아야 한다는 "결정성" 자체는 유효하므로 그건 유지하되,
// "세그먼트가 없어야 한다"는 단언은 정반대(있어야 한다·NONE이어야 한다)로
// 고친다.
test("HYK-342 2R P1-3: blockedTerminationScan을 명시로 주지 않아도(기본 실행 그대로) 이 축은 repoRoot에서 harnessDir을 스스로 찾아 항상 돈다 -- 대상이 없으면 status=NONE으로 조용하다", () => {
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
    assert.equal(
      off.line,
      ref.line,
      "결정성: 같은 입력이면 여전히 같은 줄이 나와야 한다",
    );
    assert.match(
      off.line,
      /blocked_termination_status=NONE blocked_termination_count=0 blocked_termination_source=harness\/aborts/,
      "이제는 명시로 안 줘도(기본 실행) 이 축의 세그먼트가 항상 로그 줄에 있어야 한다(실 저장소 .harness/aborts에 정지-종결 기록이 없는 정상 상태 -- 조용하다=NONE이지 부재가 아니다)",
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
