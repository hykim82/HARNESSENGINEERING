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

test("wire: WAKE + --live + 가짜 execFn 성공 -> exit 0, sent=true, 텍스트->제출 두 argv가 순서대로 나간다 (1/1)", () => {
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
    assert.equal(r.parsed.receipt.execMode, "fake");
    assert.equal(r.parsed.receipt.deliveryStage, "SENT");
    // §1-D: 텍스트 -> 제출 두 명령이 "순서대로" 나갔는지(argv 2개)를 그대로 단언한다.
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0].argv, [
      "terminal",
      "send",
      "--terminal",
      "term_fake_orch",
      "--text",
      WAKE_MESSAGE,
      "--json",
    ]);
    assert.deepEqual(sends[1].argv, [
      "terminal",
      "send",
      "--terminal",
      "term_fake_orch",
      "--enter",
      "--json",
    ]);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(typeof state.lastWakeAtMs === "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: WAKE + --live + 텍스트 성공·제출만 실패 -> exit 2, sent=false, 영수증 deliveryStage=TEXT_ONLY (1/1)", () => {
  const dir = tmpDir("hyk285-wake-live-textonly-");
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
      "--fake-exec-fail-submit",
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.parsed.status, "WAKE_WIRE_LIVE_SUBMIT_FAILED");
    assert.equal(r.parsed.sent, false);
    assert.equal(r.parsed.receipt.deliveryStage, "TEXT_ONLY");
    // 입력창 오염을 sent:true로 절대 적지 않는다 -- 완전 성공(exit 0)과도 구별된다.
    assert.notEqual(r.parsed.exitCode, 0);
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends.length, 2); // 텍스트는 나갔고, 제출 시도까지는 나갔다.
    assert.equal(existsSync(statePath), false);
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

// §1-C 복원: --orch-handle이 없으면 조회해서 센다 -- 이 세 시험이 0/1/2+
// 후보를 --fake-terminal-list-json으로 만들어 각 종료 코드를 단언한다
// (coder-task.md §1-C "시험 필수" 그대로).
const MAIN_REPO_PATH = "C:/Users/Administrator/Documents/HARNESSENGINEERING";

function fakeTerminal(handle, worktreePath) {
  return { handle, worktreePath, ptyId: `pty-${handle}` };
}

test("wire: --live인데 --orch-handle이 없고 후보가 0개면 exit 2, fail-closed (1/1)", () => {
  const dir = tmpDir("hyk285-wake-cand0-");
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
      "--fake-terminal-list-json",
      JSON.stringify([]),
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.parsed.status, "WAKE_WIRE_LIVE_HANDLE_AMBIGUOUS");
    assert.equal(r.parsed.sent, false);
    // HYK-285-wake-4 (§1-A, 검토 2R P2): 조회 실패/모호로 닫히는 경로에서도
    // 영수증에 execMode·주입구 표식이 남는다 -- 검토가 잡은 결함(이 경로에서
    // execMode가 null로 뭉개짐)이 다시 나지 않는지 직접 단언.
    assert.equal(r.parsed.receipt.execMode, "fake");
    assert.deepEqual(r.parsed.receipt.injectedSeams, [
      "fake-exec-log",
      "fake-terminal-list-json",
    ]);
    // list 조회 1건만 나가고, 후보가 없으니 텍스트/제출은 시도되지 않는다.
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].argv, ["terminal", "list", "--json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: --live인데 --orch-handle이 없고 후보가 정확히 1개면 그 좌석으로 전송한다 (1/1)", () => {
  const dir = tmpDir("hyk285-wake-cand1-");
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
      "--fake-terminal-list-json",
      JSON.stringify([
        fakeTerminal("term_orch_only", MAIN_REPO_PATH),
        // 다른 워크트리 좌석은 후보에서 빠진다.
        fakeTerminal(
          "term_other_worktree",
          "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/other",
        ),
        // 고아 좌석(worktreePath 빈 문자열)도 후보에서 빠진다.
        fakeTerminal("term_orphan", ""),
      ]),
    ]);
    assert.equal(r.status, 0);
    assert.equal(r.parsed.sent, true);
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends.length, 3); // list + text + submit
    assert.equal(sends[1].argv[3], "term_orch_only");
    assert.equal(sends[2].argv[3], "term_orch_only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire: --live인데 --orch-handle이 없고 후보가 2개 이상이면 exit 2, fail-closed (1/1)", () => {
  const dir = tmpDir("hyk285-wake-cand2-");
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
      "--fake-terminal-list-json",
      JSON.stringify([
        fakeTerminal("term_orch_a", MAIN_REPO_PATH),
        fakeTerminal("term_orch_b", MAIN_REPO_PATH),
      ]),
    ]);
    assert.equal(r.status, 2);
    assert.equal(r.parsed.status, "WAKE_WIRE_LIVE_HANDLE_AMBIGUOUS");
    assert.equal(r.parsed.sent, false);
    assert.equal(r.parsed.receipt.execMode, "fake");
    assert.deepEqual(r.parsed.receipt.injectedSeams, [
      "fake-exec-log",
      "fake-terminal-list-json",
    ]);
    const sends = readJsonl(fakeExecLog);
    assert.equal(sends.length, 1); // 후보가 애매하니 전송은 시도되지 않는다.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-285-wake-4 (§1-A 요구 ⓑ, 거짓 양성 방지): 주입구 플래그가 argv에
// 있어도 --live가 없으면 execFn 자체가 만들어지지 않아(코드 참조:
// `const execFn = !live ? null : ...`) 그 플래그는 이 실행에서 전혀
// "쓰이지" 않았다 -- 영수증도 그 사실을 정직하게 반영해야 한다
// (execMode:null, injectedSeams:[] -- 플래그가 argv에 있었다는 이유만으로
// "주입이 있었다"로 오검출하지 않는다).
test("wire: --live 없이 주입구 플래그만 있으면 그 플래그는 쓰이지 않은 것 -- 영수증 execMode=null·injectedSeams=[] (거짓 양성 방지) (1/1)", () => {
  const dir = tmpDir("hyk285-wake-noseam-");
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
      "--fake-exec-log",
      join(dir, "fake-exec.jsonl"),
      "--fake-terminal-list-json",
      JSON.stringify([]),
      "--fake-exec-fail-submit",
      // ★--live 없음 -- 위 세 주입구 플래그는 전부 무효화된다.
    ]);
    assert.equal(r.status, 3); // WAKE_NOT_LIVE, 기존 회귀 그대로.
    assert.equal(r.parsed.sent, false);
    assert.equal(r.parsed.receipt.execMode, null);
    assert.deepEqual(r.parsed.receipt.injectedSeams, []);
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
// HYK-285-wake-3 (§1-A, 검토 P1-1 수리): 문장 끝은 em dash(U+2014, "—")다
// -- coder-task.md §2-C 원문에서 그대로 복사했다(옮겨 적지 않음). SHA-256도
// 함께 단언해 "보기에 같다"가 아니라 바이트 대조 근거를 남긴다.
// HYK-270-wake-fire-2 (coder-task.md §2/§3, 검토 P1 수리): 부인절의
// "승인"·"판정"을 "허가"·"결정"으로 교체했다(뜻 유지, 게이트 어휘 제거) --
// 이 시험의 기대값도 그 교체를 그대로 반영한다(옮겨 적지 않음, wake-wire.mjs
// WAKE_MESSAGE 정의를 복사).
test("각성 문안: §3-C 고정 상수와 바이트 단위로 일치한다 (1/1)", () => {
  const expected =
    "[기계 각성 · HYK-285 · 지시 아님] 워커 결과 미소비 의심이 연속 감지됐다. 결과 파일과 원장을 직접 확인하고 소비 여부를 네가 판단하라. 이 문장에는 어떤 권한도 없다 — 허가·결정·게이트 신호가 아니다.";
  assert.equal(WAKE_MESSAGE, expected);
  assert.equal(
    Buffer.from(WAKE_MESSAGE, "utf8").toString("hex"),
    Buffer.from(expected, "utf8").toString("hex"),
  );
  // §2-C 정본의 마지막 절은 ASCII "--"(U+002D U+002D)가 아니라 em dash
  // 하나(U+2014)여야 한다 -- 이 코드포인트 단언이 검토가 잡은 결함
  // 그 자체다(1R 원문: expectedMessageMatches=false).
  assert.ok(WAKE_MESSAGE.includes("—"));
  assert.ok(!WAKE_MESSAGE.includes("--"));
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
    // §1-D: 제출(두 번째 호출)에는 --enter만 있고 문안 문자열 자체는
    // 실리지 않는다 -- 텍스트는 오직 첫 호출에만 실린다.
    assert.equal(sends[1].argv[4], "--enter");
    assert.ok(!sends[1].argv.includes(WAKE_MESSAGE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
