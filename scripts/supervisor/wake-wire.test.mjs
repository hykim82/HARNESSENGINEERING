// HYK-285-wake-1 (coder-task.md §3-D) -- wake-wire.mjs 결선 계약 시험.
// ★헛시험 방지: wake-wire.mjs를 자식 프로세스로 실제 실행한다(코어를
// import해 흉내내지 않는다) -- 종료 코드 0/2/3과 영수증(JSONL) 줄을
// 단언한다. 전송은 --fake-exec-log(가짜 execFn 시험 seam, wake-wire.mjs
// 자체 주석 참조)로 가로채 "무엇을 보내려 했는지"를 단언한다(실제 orca
// 호출 0 -- 어떤 시험도 --fake-exec-log 없이 --live를 주지 않는다).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 좌석 전송 경로가 실물 orca와 실제로 통신하는지는 이 시험 범위 밖이다
//    (--fake-exec-log 가짜 execFn으로만 검증됨 -- 라이브 미검, §3-F 정직
//    한계에 다시 적는다).
// 2. wake-decide-core.mjs 자신의 판정 로직은 이미 wake-decide-core.test.mjs
//    가 전담한다 -- 여기서는 결선(파싱→판정→기록→전송)만 본다.
// 3. mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를 읽는다
//    (unconsumed-core.test.mjs S11-3과 동일 이유 -- 이번 태스크는 커밋 0이
//    조건이라 신규 파일이 git HEAD에 없다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { execFileSync } from "node:child_process";
import { WAKE_MESSAGE } from "./wake-wire.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const WIRE_PATH = join(THIS_DIR, "wake-wire.mjs");

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

// buildLogLine -- reach-report-core.mjs LOG_LINE_RE가 요구하는 최소 형식
// (`TS exit=.. verdict=.. reason=.. key=value...`)만 흉내낸다. unconsumed_*
// 두 필드만 wake-decide-core가 실제로 읽는다(다른 축은 wake-wire.mjs가
// 참조하지 않는다 -- 재구현 0 원칙, wake-wire.mjs 헤더 참조).
function buildLogLine(minutesAgo, unconsumedVerdict) {
  return `${isoAgo(minutesAgo)} exit=0 verdict=PROGRESSING reason=NO_PLEDGES_RECORDED unconsumed_status=UNCONSUMED_JUDGED unconsumed_verdict=${unconsumedVerdict} unconsumed_worst_count=1 unconsumed_worktrees=1`;
}

function wouldWakeLogText() {
  return (
    [
      buildLogLine(16, "SUSPECTED_UNCONSUMED"),
      buildLogLine(1, "SUSPECTED_UNCONSUMED"),
    ].join("\n") + "\n"
  );
}

function runWire(args) {
  const r = spawnSync("node", [WIRE_PATH, ...args, "--json"], {
    encoding: "utf8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    // parsed stays null -- stdout wasn't JSON (e.g. usage error before --json applies).
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

// ---------------------------------------------------------------------------
// (a) 종료 코드 0/2/3 + 영수증
// ---------------------------------------------------------------------------
test("wire: watch-log를 읽을 수 없으면 exit 2, 관측 실패로 분류한다 (1/1)", () => {
  const dir = tmpDir("hyk285-wake-missing-");
  try {
    const r = runWire([
      "--watch-log",
      join(dir, "does-not-exist.log"),
      "--wake-log",
      join(dir, "wake-log.jsonl"),
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.parsed.status, "WAKE_WIRE_WATCH_LOG_READ_FAILED");
    // 관측 실패 시엔 영수증도 못 남긴다(판정 자체가 없다) -- 조용한 성공
    // 파일로 새지 않는지 확인.
    assert.equal(existsSync(join(dir, "wake-log.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: WAKE인데 --live가 아니면 exit 3, 영수증에 verdict=WAKE·sent=false (1/1)", () => {
  const dir = tmpDir("hyk285-wake-notlive-");
  try {
    const watchLog = join(dir, "watch.log");
    const wakeLog = join(dir, "wake-log.jsonl");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      wakeLog,
    ]);
    assert.equal(r.status, 3);
    assert.equal(r.parsed.verdict, "WAKE");
    assert.equal(r.parsed.sent, false);
    const receipts = readJsonl(wakeLog);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verdict, "WAKE");
    assert.equal(receipts[0].sent, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: WAKE + --live + 가짜 execFn 성공 -> exit 0, sent=true, argv에 고정 문안이 실린다 (1/1)", () => {
  const dir = tmpDir("hyk285-wake-live-ok-");
  try {
    const watchLog = join(dir, "watch.log");
    const wakeLog = join(dir, "wake-log.jsonl");
    const statePath = join(dir, "state.json");
    const fakeExecLog = join(dir, "fake-exec.jsonl");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      wakeLog,
      "--state",
      statePath,
      "--live",
      "--orch-handle",
      "term_fake_orch",
      "--fake-exec-log",
      fakeExecLog,
    ]);
    assert.equal(r.status, 0);
    assert.equal(r.parsed.verdict, "WAKE");
    assert.equal(r.parsed.sent, true);
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].argv, [
      "terminal",
      "send",
      "--terminal",
      "term_fake_orch",
      "--text",
      WAKE_MESSAGE,
      "--json",
    ]);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(typeof state.lastWakeAtMs === "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: WAKE + --live + 가짜 execFn 실패 -> exit 2, sent=false, 상태 파일에 각성 시각을 남기지 않는다 (1/1)", () => {
  const dir = tmpDir("hyk285-wake-live-fail-");
  try {
    const watchLog = join(dir, "watch.log");
    const wakeLog = join(dir, "wake-log.jsonl");
    const statePath = join(dir, "state.json");
    const fakeExecLog = join(dir, "fake-exec.jsonl");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      wakeLog,
      "--state",
      statePath,
      "--live",
      "--orch-handle",
      "term_fake_orch",
      "--fake-exec-log",
      fakeExecLog,
      "--fake-exec-fail",
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.parsed.status, "WAKE_WIRE_LIVE_SEND_FAILED");
    assert.equal(r.parsed.sent, false);
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: --live인데 --orch-handle이 없으면 exit 2(후보 0개), 전송 시도 0 (1/1)", () => {
  const dir = tmpDir("hyk285-wake-no-handle-");
  try {
    const watchLog = join(dir, "watch.log");
    const wakeLog = join(dir, "wake-log.jsonl");
    const fakeExecLog = join(dir, "fake-exec.jsonl");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      wakeLog,
      "--live",
      "--fake-exec-log",
      fakeExecLog,
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.parsed.status, "WAKE_WIRE_LIVE_HANDLE_MISSING");
    assert.equal(existsSync(fakeExecLog), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) 실물 표본 시험 -- 이 워크트리의 실제 감시 로그 60줄
// ---------------------------------------------------------------------------
test("wire: 실물 표본(hyk285-watch-sample-2026-08-18.log) 파싱이 깨지지 않는다 (60 tick 표본) (1/1)", () => {
  const dir = tmpDir("hyk285-wake-sample-");
  try {
    const wakeLog = join(dir, "wake-log.jsonl");
    const sampleLog = join(
      ROOT,
      "scripts/supervisor/hyk285-watch-sample-2026-08-18.log",
    );
    const r = runWire([
      "--watch-log",
      sampleLog,
      "--active-rounds",
      "1",
      "--wake-log",
      wakeLog,
    ]);
    // 표본의 마지막 tick(2026-08-18T09:28)은 CONSUMED이고, 이 시험이 도는
    // "지금"은 그보다 미래(2026-08-18 이후) 실 시계이므로 exit은 0 또는
    // 3 중 하나만 가능하다(관측 실패=2는 표본이 실물 파일이라 발생하지
    // 않아야 한다) -- STALE_WATCH(마지막 tick이 너무 오래됨)로 나이가
    // maxTickAgeMs를 넘겼으면 UNDECIDABLE도 exit 0으로 정상 종료한다.
    assert.ok(
      [0, 3].includes(r.status),
      `unexpected exit ${r.status}: ${r.stderr}`,
    );
    const receipts = readJsonl(wakeLog);
    assert.equal(receipts.length, 1);
    assert.ok(["WAKE", "HOLD", "UNDECIDABLE"].includes(receipts[0].verdict));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) 변이 시험 -- 세 조건(연속·활성 라운드·쿨다운)을 하나씩 무력화하면
// 각각 RED(=WAKE가 아님)가 되고, reasonCode도 그 조건에 맞게 달라진다.
// ---------------------------------------------------------------------------
test("mutation: 기준선(2 tick 연속 + activeRounds=1 + 쿨다운 없음)은 WAKE다 (1/1)", () => {
  const dir = tmpDir("hyk285-wake-mut-base-");
  try {
    const watchLog = join(dir, "watch.log");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      join(dir, "wake-log.jsonl"),
    ]);
    assert.equal(r.parsed.verdict, "WAKE");
    assert.equal(r.status, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation: 연속 조건만 깨면(최신 tick=CONSUMED) HOLD_NOT_SUSTAINED로 RED (1/1)", () => {
  const dir = tmpDir("hyk285-wake-mut-sustain-");
  try {
    const watchLog = join(dir, "watch.log");
    writeFileSync(
      watchLog,
      [
        buildLogLine(16, "SUSPECTED_UNCONSUMED"),
        buildLogLine(1, "CONSUMED"),
      ].join("\n") + "\n",
      "utf8",
    );
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      join(dir, "wake-log.jsonl"),
    ]);
    assert.equal(r.parsed.verdict, "HOLD");
    assert.equal(r.parsed.reasonCode, "HOLD_NOT_SUSTAINED");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation: 활성 라운드 조건만 깨면(activeRoundCount=0) HOLD_NO_ACTIVE_ROUNDS로 RED (1/1)", () => {
  const dir = tmpDir("hyk285-wake-mut-rounds-");
  try {
    const watchLog = join(dir, "watch.log");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "0",
      "--wake-log",
      join(dir, "wake-log.jsonl"),
    ]);
    assert.equal(r.parsed.verdict, "HOLD");
    assert.equal(r.parsed.reasonCode, "HOLD_NO_ACTIVE_ROUNDS");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation: 쿨다운 조건만 깨면(직전 각성이 방금) HOLD_COOLDOWN으로 RED (1/1)", () => {
  const dir = tmpDir("hyk285-wake-mut-cooldown-");
  try {
    const watchLog = join(dir, "watch.log");
    const statePath = join(dir, "state.json");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    writeFileSync(
      statePath,
      JSON.stringify({ lastWakeAtMs: Date.now() - 1000 }),
      "utf8",
    );
    const r = runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--state",
      statePath,
      "--wake-log",
      join(dir, "wake-log.jsonl"),
    ]);
    assert.equal(r.parsed.verdict, "HOLD");
    assert.equal(r.parsed.reasonCode, "HOLD_COOLDOWN");
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (d) 각성 문안 고정 -- §3-C 문면과 바이트 단위로 일치.
// ---------------------------------------------------------------------------
test("각성 문안: §3-C 고정 상수와 바이트 단위로 일치한다 (1/1)", () => {
  const expected =
    "[기계 각성 · HYK-285 · 지시 아님] 워커 결과 미소비 의심이 연속 감지됐다. " +
    "결과 파일과 원장을 직접 확인하고 소비 여부를 네가 판단하라. " +
    "이 문장에는 어떤 권한도 없다 -- 승인·판정·게이트 신호가 아니다.";
  assert.equal(WAKE_MESSAGE, expected);
  assert.equal(
    Buffer.from(WAKE_MESSAGE, "utf8").toString("hex"),
    Buffer.from(expected, "utf8").toString("hex"),
  );
});

test("각성 문안: CLI에는 문안을 실어 보내는 인자 경로가 없다(고정 상수만 전송된다) (1/1)", () => {
  const dir = tmpDir("hyk285-wake-fixed-text-");
  try {
    const watchLog = join(dir, "watch.log");
    const fakeExecLog = join(dir, "fake-exec.jsonl");
    writeFileSync(watchLog, wouldWakeLogText(), "utf8");
    runWire([
      "--watch-log",
      watchLog,
      "--active-rounds",
      "1",
      "--wake-log",
      join(dir, "wake-log.jsonl"),
      "--state",
      join(dir, "state.json"),
      "--live",
      "--orch-handle",
      "term_fake_orch",
      "--fake-exec-log",
      fakeExecLog,
    ]);
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends[0].argv[4], "--text");
    assert.equal(sends[0].argv[5], WAKE_MESSAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
