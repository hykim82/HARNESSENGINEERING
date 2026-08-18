// HYK-285-always-1 (coder-task.md §2-E) -- 어제 병합된 각성 배선
// (wake-wire.mjs)이 이 기존 주기(watch-run.mjs)에 실제로 결선됐는지의
// 계약 시험.
//
// ★헛시험 방지: 프로덕션 진입점(watch-run.mjs)을 자식 프로세스로 실제
// 실행한다(코어 import 흉내 금지) -- admission-sweep-wire.test.mjs/
// wake-wire.test.mjs와 동일한 방식.
//
// 전송은 --wake-fake-exec-log(wake-wire.mjs가 이미 내보내는
// buildFakeExecFn을 그대로 재사용하는 시험 seam)로 가로챈다 -- 실 orca
// 호출 0. `--admission-sweep-ledger`만 주고 `--admission-sweep-lock`은
// 주지 않는다 -- runSweepStep 자신의 가드가 lockPath 없이는 sweep
// 트리거(실 orca 조회를 만드는 경로)를 아예 돌리지 않으므로, 이 시험이
// wake의 activeRoundCount 읽기만 켜고 sweep은 끈 채로 유지한다(watch-
// run.mjs §admissionSweep 게이트 완화 주석 참조).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 좌석 전송이 실물 orca와 실제로 통신하는지는 이 시험 범위 밖이다
//    (--wake-fake-exec-log로만 검증 -- 라이브 왕복은 ORCH 몫).
// 2. wake-decide-core.mjs 자신의 판정 규칙(sustainTicks/cooldownMs/
//    maxTickAgeMs 각각의 경계값)은 wake-decide-core.test.mjs가 전담한다.
//    여기서는 "watch-run 주기에 결선됐는가"(opt-in·같은 줄 필드·쿨다운
//    영속·원장 fail-closed)만 본다.
// 3. 이 시험은 실제 detector(orch-stall-detect.mjs)를 이 저장소
//    (ROOT)를 대상으로 진짜로 돌린다 -- wake의 판정 재료(watch.log)는
//    "이번 tick이 append되기 *전*" 상태만 읽으므로(watch-run.mjs
//    runWakeStep 헤더 주석 참조) 실 detector의 결과와 무관하게
//    결정적이다. 쿨다운 연속성 시험(ⓒ)은 두 실행 사이에 watch.log를
//    같은 내용으로 재시딩해 "무엇이 영속하는가"를 wake-state.json 하나로
//    좁힌다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const WATCH_RUN_PATH = join(THIS_DIR, "watch-run.mjs");

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function isoAgo(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// wake-wire.mjs가 실제로 --live 좌석 후보를 조회하는 지점(§1-C)의
// 시험 seam과 동일한 모양(--wake-fake-terminal-list-json) -- 정확히
// 1개 후보(ORCH 전용 위치 MAIN_REPO_PATH)만 주면 fail-closed 없이
// 그 좌석으로 전송을 시도한다(wake-wire.test.mjs와 동일 픽스처, 재구현
// 0 -- 이 파일도 그 상수·모양을 그대로 복사한다).
const MAIN_REPO_PATH = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
function fakeTerminalListJson() {
  return JSON.stringify([
    { handle: "term_fake_orch", worktreePath: MAIN_REPO_PATH, ptyId: "pty-1" },
  ]);
}

// wake-decide-core가 실제로 읽는 두 필드(unconsumed_status/verdict)만
// 채운다 -- reach-report-core.mjs LOG_LINE_RE가 요구하는 최소 형식
// (wake-wire.test.mjs buildLogLine과 동일한 축소 형태, 재구현 0).
function seedLine(minutesAgo, unconsumedVerdict) {
  return `${isoAgo(minutesAgo)} exit=0 verdict=PROGRESSING reason=NO_PLEDGES_RECORDED unconsumed_status=UNCONSUMED_JUDGED unconsumed_verdict=${unconsumedVerdict} unconsumed_worst_count=1 unconsumed_worktrees=1`;
}

function sustainedWatchLogText() {
  return (
    [
      seedLine(20, "SUSPECTED_UNCONSUMED"),
      seedLine(5, "SUSPECTED_UNCONSUMED"),
    ].join("\n") + "\n"
  );
}

function ledgerWithOneActive() {
  return JSON.stringify({
    schema_version: "admission-ledger/v1",
    epoch: isoAgo(60),
    reservations: {
      "r-1": {
        status: "ACTIVE",
        admitted_at: isoAgo(10),
        completed_at: null,
        suspect_at: null,
        role: "CODER",
        seat_key: "seat-1",
      },
    },
  });
}

function runWatchRun(args) {
  return spawnSync("node", [WATCH_RUN_PATH, ...args], { encoding: "utf8" });
}

function lastWatchLogLine(watchDir) {
  const text = readFileSync(join(watchDir, "watch.log"), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1];
}

function parseWakeTokens(line) {
  const m = /wake_status=(\S+) wake_verdict=(\S+) wake_sent=(\S+)/.exec(line);
  return m ? { status: m[1], verdict: m[2], sent: m[3] } : null;
}

// ---------------------------------------------------------------------------
// ⓐ opt-in 안 주면 -- 전송 0, wake_* 파일 0, 기존 로그 형식 불변
// ---------------------------------------------------------------------------
test("wake opt-in 안 주면: watch-run.mjs는 wake 단계를 아예 돌리지 않는다 (wake_* 필드 0, wake-state/wake-receipts 파일 0) (1/1)", () => {
  const watchDir = tmpDir("hyk285-always-noopt-");
  try {
    const r = runWatchRun([
      "--repo-root",
      ROOT,
      "--watch-dir",
      watchDir,
      "--no-reach",
      "--no-partial-count",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const line = lastWatchLogLine(watchDir);
    assert.equal(
      line.includes("wake_"),
      false,
      `wake_* token leaked into watch.log without opt-in: ${line}`,
    );
    assert.equal(existsSync(join(watchDir, "wake-state.json")), false);
    assert.equal(existsSync(join(watchDir, "wake-receipts.jsonl")), false);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓑ opt-in 주고 WAKE 조건 충족 -> wake_sent=true, 영수증에 execMode/
//    injectedSeams, 가짜 exec 로그에 텍스트->제출 두 argv
// ---------------------------------------------------------------------------
test("wake opt-in + --wake-live + 가짜 execFn: 연속 2 tick SUSPECTED_UNCONSUMED + 활성 라운드 1 -> wake_sent=true, 영수증에 execMode=fake/injectedSeams, 가짜 exec 로그에 텍스트->제출 두 argv (1/1)", () => {
  const watchDir = tmpDir("hyk285-always-wake-");
  try {
    writeFileSync(join(watchDir, "watch.log"), sustainedWatchLogText(), "utf8");
    const ledgerPath = join(watchDir, "ledger.json");
    writeFileSync(ledgerPath, ledgerWithOneActive(), "utf8");
    const statePath = join(watchDir, "wake-state.json");
    const wakeLogPath = join(watchDir, "wake-receipts.jsonl");
    const fakeExecLog = join(watchDir, "fake-exec.jsonl");
    const r = runWatchRun([
      "--repo-root",
      ROOT,
      "--watch-dir",
      watchDir,
      "--no-reach",
      "--no-partial-count",
      "--admission-sweep-ledger",
      ledgerPath,
      "--wake",
      "--wake-state",
      statePath,
      "--wake-log",
      wakeLogPath,
      "--wake-live",
      "--wake-fake-exec-log",
      fakeExecLog,
      "--wake-fake-terminal-list-json",
      fakeTerminalListJson(),
    ]);
    assert.equal(r.status, 0, r.stderr);
    const line = lastWatchLogLine(watchDir);
    const tokens = parseWakeTokens(line);
    assert.ok(tokens, `wake_* tokens missing from watch.log line: ${line}`);
    assert.equal(tokens.verdict, "WAKE");
    assert.equal(tokens.sent, "true");
    assert.equal(existsSync(statePath), true);
    const receipts = readJsonl(wakeLogPath);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verdict, "WAKE");
    assert.equal(receipts[0].sent, true);
    assert.equal(receipts[0].execMode, "fake");
    assert.deepEqual(receipts[0].injectedSeams, [
      "fake-exec-log",
      "fake-terminal-list-json",
    ]);
    // 조회(terminal list) -> 텍스트 -> 제출(--enter) 세 argv가 순서대로
    // 나간다(wake-wire.mjs sendTextThenSubmit -- 재구현 0, 결과만 확인).
    const execCalls = readJsonl(fakeExecLog);
    assert.equal(execCalls.length, 3);
    assert.deepEqual(execCalls[0].argv, ["terminal", "list", "--json"]);
    assert.equal(execCalls[2].argv.includes("--enter"), true);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ 쿨다운 상태 파일이 «주기 실행 사이»에 유지된다: 두 번 연속 실행하면
//    두 번째는 쿨다운으로 HOLD(sent=false).
// ---------------------------------------------------------------------------
test("wake 쿨다운 영속: 같은 --wake-state로 두 번 연속 실행하면 두 번째는 HOLD_COOLDOWN(sent=false) -- 상태 파일이 프로세스 경계를 넘어 유지된다 (1/1)", () => {
  const watchDir = tmpDir("hyk285-always-cooldown-");
  try {
    const ledgerPath = join(watchDir, "ledger.json");
    writeFileSync(ledgerPath, ledgerWithOneActive(), "utf8");
    const statePath = join(watchDir, "wake-state.json");
    const wakeLogPath = join(watchDir, "wake-receipts.jsonl");
    const commonArgs = (fakeExecLog) => [
      "--repo-root",
      ROOT,
      "--watch-dir",
      watchDir,
      "--no-reach",
      "--no-partial-count",
      "--admission-sweep-ledger",
      ledgerPath,
      "--wake",
      "--wake-state",
      statePath,
      "--wake-log",
      wakeLogPath,
      "--wake-live",
      "--wake-fake-exec-log",
      fakeExecLog,
      "--wake-fake-terminal-list-json",
      fakeTerminalListJson(),
    ];

    writeFileSync(join(watchDir, "watch.log"), sustainedWatchLogText(), "utf8");
    const fakeExecLog1 = join(watchDir, "fake-exec-1.jsonl");
    const r1 = runWatchRun(commonArgs(fakeExecLog1));
    assert.equal(r1.status, 0, r1.stderr);
    const tokens1 = parseWakeTokens(lastWatchLogLine(watchDir));
    assert.equal(tokens1.verdict, "WAKE");
    assert.equal(tokens1.sent, "true");
    assert.equal(existsSync(statePath), true);

    // watch.log를 run1 이전과 동일한 (연속 2 tick sustained) 내용으로
    // 다시 심는다 -- run1의 실 detector가 자기 tick을 더했으므로, 이
    // 시험이 "판정 재료(sustained 여부)"가 아니라 "쿨다운 상태 파일의
    // 영속" 하나만 가려서 확인하기 위함이다(헤더 정직 한계 3 참조).
    writeFileSync(join(watchDir, "watch.log"), sustainedWatchLogText(), "utf8");
    const fakeExecLog2 = join(watchDir, "fake-exec-2.jsonl");
    const r2 = runWatchRun(commonArgs(fakeExecLog2));
    assert.equal(r2.status, 0, r2.stderr);
    const tokens2 = parseWakeTokens(lastWatchLogLine(watchDir));
    assert.equal(tokens2.verdict, "HOLD");
    assert.equal(tokens2.sent, "false");
    const receipts = readJsonl(wakeLogPath);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[1].reasonCode, "HOLD_COOLDOWN");
    // 쿨다운이 실제로 전송을 막았다는 증거 -- 두 번째 실행의 가짜 exec
    // 로그는 비어 있다(텍스트/제출 argv가 하나도 안 나갔다).
    assert.equal(existsSync(fakeExecLog2), false);
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓓ 원장을 못 읽을 때(원장 경로 미설정) -> UNDECIDABLE로 접힌다(조용히
//    "활성 라운드 0"으로 접지 않는다).
// ---------------------------------------------------------------------------
test("wake 원장 미설정: --admission-sweep-ledger 없이 --wake만 주면 activeRoundCount를 읽을 수 없어 UNDECIDABLE로 접힌다(0으로 조용히 접지 않는다) (1/1)", () => {
  const watchDir = tmpDir("hyk285-always-undecidable-");
  try {
    writeFileSync(join(watchDir, "watch.log"), sustainedWatchLogText(), "utf8");
    const statePath = join(watchDir, "wake-state.json");
    const wakeLogPath = join(watchDir, "wake-receipts.jsonl");
    const r = runWatchRun([
      "--repo-root",
      ROOT,
      "--watch-dir",
      watchDir,
      "--no-reach",
      "--no-partial-count",
      "--wake",
      "--wake-state",
      statePath,
      "--wake-log",
      wakeLogPath,
      // --wake-live 없음 -- 판정만 확인한다(전송 게이트는 별도 계약).
    ]);
    assert.equal(r.status, 0, r.stderr);
    const tokens = parseWakeTokens(lastWatchLogLine(watchDir));
    assert.equal(tokens.verdict, "UNDECIDABLE");
    assert.equal(tokens.sent, "false");
    const receipts = readJsonl(wakeLogPath);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].reasonCode, "ACTIVE_ROUNDS_UNKNOWN");
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// admissionSweep 게이트 완화 회귀 -- ledger만 주고 lock을 안 주면
// runSweepStep은 여전히 notRun(실 orca 호출 0, watch-run.mjs 주석 참조).
// ---------------------------------------------------------------------------
test("admission-sweep-ledger만 주고 admission-sweep-lock을 안 주면: sweep 세그먼트는 로그에 없다(sweep 트리거가 돌지 않는다 -- 실 orca 호출 0 유지) (1/1)", () => {
  const watchDir = tmpDir("hyk285-always-sweepgate-");
  try {
    const ledgerPath = join(watchDir, "ledger.json");
    writeFileSync(ledgerPath, ledgerWithOneActive(), "utf8");
    const r = runWatchRun([
      "--repo-root",
      ROOT,
      "--watch-dir",
      watchDir,
      "--no-reach",
      "--no-partial-count",
      "--admission-sweep-ledger",
      ledgerPath,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const line = lastWatchLogLine(watchDir);
    assert.equal(
      line.includes("sweep_status="),
      false,
      `sweep segment leaked into watch.log with ledger-only (no lock) config: ${line}`,
    );
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});
