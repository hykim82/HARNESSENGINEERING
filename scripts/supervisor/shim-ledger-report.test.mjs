// shim-ledger-report.test.mjs -- HYK-389 조각 2 저장소 몫: 아침 보고 «ORCH 좌석 직접
// 쓰기» 한 줄 시험(기록 단계 · OBSERVER · 앵커 아님).
//
// 프로덕션 진입점을 구동한다: `runReachOnce`(watch-run.mjs 가 부르는 바로 그 함수) ·
// `node scripts/supervisor/reach-report.mjs --shim-ledger ...`(CLI 자식 프로세스).
// 합성 원장(mkdtemp) · 주입 시각만 쓴다 -- 실제 관제실 · watch 폴더 · 받는함 쓰기 0.
// 새 순수 모듈을 정적 import 하지 않는다(모듈이 없을 때 칸마다 빨강이 보이게).
//
// 시험 단언 규율: 출력 «전체» 동등 단언 0 -- 자기 토막만.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runReachOnce } from "./reach-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REACH_CLI = path.join(HERE, "reach-report.mjs");
const NOW = Date.parse("2026-11-19T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const SCHEMA = "orca-direct-ledger/1";
const HEADING = "## ORCH 좌석 직접 쓰기(shim 원장 · OBSERVER)";

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

function boot(msAgo, shim, reason = null) {
  return JSON.stringify({
    schema: SCHEMA,
    event: "orch_seat_boot",
    ts: iso(msAgo),
    shim,
    reason,
    reasons: reason === null ? [] : [reason],
    role: "ORCH",
    launcher_mark: "mark",
    cwd: "C:/synthetic",
  });
}

function write(msAgo, domain, verb, { actor = "orch", caller = null } = {}) {
  return JSON.stringify({
    schema: SCHEMA,
    ts: iso(msAgo),
    pane_key: "pane-synthetic",
    role: actor === "orch" ? "ORCH" : null,
    cwd: "C:/synthetic",
    domain,
    verb,
    target: "t1",
    caller_script: caller,
    text_len: 1,
    body_len: null,
    actor,
  });
}

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "hyk389-report-"));
  const watchDir = path.join(root, "watch");
  mkdirSync(watchDir);
  return {
    root,
    watchLog: path.join(watchDir, "watch.log"),
    reportOut: path.join(watchDir, "morning-report.md"),
    statePath: path.join(watchDir, "reach-notify-state.json"),
    notifyDir: path.join(root, "notify"),
    ledger: path.join(root, "orca-direct-ledger.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withRoot(fn) {
  const box = makeRoot();
  try {
    return fn(box);
  } finally {
    box.cleanup();
  }
}

function writeLedger(box, lines) {
  writeFileSync(
    box.ledger,
    lines.length ? `${lines.join("\n")}\n` : "",
    "utf8",
  );
}

function runReport(box, extra = {}) {
  return runReachOnce({
    watchLogPath: box.watchLog,
    reportOutPath: box.reportOut,
    statePath: box.statePath,
    notifyDir: box.notifyDir,
    now: NOW,
    ...extra,
  });
}

// 보고 본문에서 shim 절의 «한 줄» 을 꺼낸다(절 제목 바로 아래 줄).
function shimLine(reportText) {
  const lines = reportText.split("\n");
  const at = lines.indexOf(HEADING);
  assert.ok(at >= 0, `보고에 shim 절 제목이 있어야 한다: ${HEADING}`);
  return lines[at + 1];
}

const DOOR = "D:/문서관리/하네스-관제실/dispatch-worker.ps1";

test("R1 합성 원장(부팅 2 = 켬 1 · 끔 1 · ORCH 직접 쓰기 4 = 문 밖 3 · 스크립트 경유 1) -> 보고 한 줄 값 · 첫머리 = 결론", () =>
  withRoot((box) => {
    writeLedger(box, [
      boot(5 * HOUR, "enabled"),
      boot(3 * HOUR, "disabled", "REAL_BIN_MISSING"),
      write(4 * HOUR, "terminal", "send"),
      write(3 * HOUR, "terminal", "send", { caller: "C:/tmp/adhoc.ps1" }),
      write(2 * HOUR, "orchestration", "dispatch"),
      write(1 * HOUR, "terminal", "send", { caller: DOOR }),
      write(1 * HOUR, "terminal", "send", { actor: "unattributed" }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("ORCH 부팅 2(기록 켬 1 · 끔 1"), line);
    assert.ok(line.includes("REAL_BIN_MISSING 1"), line);
    assert.ok(line.includes("설계된 문 밖 직접 쓰기 3건"), line);
    assert.ok(line.includes("terminal send 2"), line);
    assert.ok(line.includes("orchestration dispatch 1"), line);
    assert.ok(line.includes("문 안 1건"), line);
    assert.ok(line.includes("귀속 불명 쓰기 1건"), line);
    assert.ok(line.includes("OBSERVER"), line);
    assert.equal(result.shimLedger.status, "ok");
    assert.equal(result.shimLedger.orchWrites.outsideDoor, 3);
    assert.equal(result.shimLedger.boots.disabled, 1);
  }));

test("R2 원장 없음 -> «관측 불가» (0건으로 접지 않는다)", () =>
  withRoot((box) => {
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.includes("관측 불가"), line);
    assert.ok(line.includes("0건이 아니다"), line);
    assert.ok(!line.includes("설계된 문 밖 직접 쓰기 0건"), line);
    assert.equal(result.shimLedger.status, "unobservable");
  }));

test("R3 깨진 줄 섞임 -> «관측 불가»(깨진 줄 N건) · 읽은 줄만 센 값은 하한으로만 · 0 으로 접지 않는다", () =>
  withRoot((box) => {
    writeLedger(box, [
      boot(2 * HOUR, "enabled"),
      "{ this is not json",
      write(1 * HOUR, "terminal", "send"),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.includes("관측 불가"), line);
    assert.ok(line.includes("깨진 줄 1건"), line);
    assert.ok(line.includes("하한"), line);
    assert.ok(line.includes("설계된 문 밖 직접 쓰기 1건"), line);
    assert.equal(result.shimLedger.status, "unobservable");
    assert.equal(result.shimLedger.brokenLines, 1);
  }));

test("R3b 읽을 수 없는 모양(알 수 없는 schema · ts 없음 · 부팅 줄의 shim 값 이상)도 깨진 줄이다", () =>
  withRoot((box) => {
    writeLedger(box, [
      JSON.stringify({
        schema: "other/9",
        ts: iso(HOUR),
        domain: "terminal",
        verb: "send",
        actor: "orch",
      }),
      JSON.stringify({
        schema: SCHEMA,
        domain: "terminal",
        verb: "send",
        actor: "orch",
      }),
      JSON.stringify({
        schema: SCHEMA,
        event: "orch_seat_boot",
        ts: iso(HOUR),
        shim: "maybe",
      }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    assert.equal(result.shimLedger.brokenLines, 3);
    assert.ok(shimLine(result.reportText).includes("관측 불가"));
  }));

test("R4 보고 기간(24시간) 밖 줄은 세지 않는다 · 읽은 줄이라 깨진 줄도 아니다", () =>
  withRoot((box) => {
    writeLedger(box, [
      boot(30 * HOUR, "disabled", "SHIM_MISSING"),
      write(30 * HOUR, "terminal", "send"),
      boot(1 * HOUR, "enabled"),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("ORCH 부팅 1(기록 켬 1 · 끔 0"), line);
    assert.ok(line.includes("설계된 문 밖 직접 쓰기 0건"), line);
    assert.equal(result.shimLedger.status, "ok");
  }));

test("R5 원장 파일이 «있고 비어 있음» = 관측된 0(관측 불가와 다른 문면)", () =>
  withRoot((box) => {
    writeLedger(box, []);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("ORCH 부팅 0(기록 켬 0 · 끔 0"), line);
    assert.ok(line.includes("설계된 문 밖 직접 쓰기 0건"), line);
    assert.ok(!line.includes("관측 불가"), line);
  }));

test("R6 shimLedgerPath 를 안 줘도(= watch-run 의 기존 호출 모양) 보고 파일 디렉터리의 위 디렉터리 원장을 읽는다", () =>
  withRoot((box) => {
    writeLedger(box, [boot(HOUR, "enabled"), write(HOUR, "terminal", "close")]);
    const result = runReport(box); // shimLedgerPath 없음
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("ORCH 부팅 1(기록 켬 1"), line);
    assert.ok(line.includes("terminal close 1"), line);
  }));

test("R7 CLI 자식 프로세스: --shim-ledger 로 주입한 원장이 화면 출력과 보고 파일에 실린다", () =>
  withRoot((box) => {
    writeLedger(box, [
      boot(HOUR, "disabled", "CLI_MISSING"),
      write(HOUR, "orchestration", "task-update"),
    ]);
    const r = spawnSync(
      process.execPath,
      [
        REACH_CLI,
        "--report",
        ...["--watch-log", box.watchLog],
        ...["--report-out", box.reportOut],
        ...["--state-path", box.statePath],
        ...["--notify-dir", box.notifyDir],
        ...["--shim-ledger", box.ledger],
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(HEADING), r.stdout);
    assert.ok(r.stdout.includes("CLI_MISSING 1"), r.stdout);
    assert.ok(r.stdout.includes("orchestration task-update 1"), r.stdout);
  }));

test("R8 문 목록은 파일 이름 기준(대소문자 · 경로 구분자 무관) · 이름이 목록에 없는 스크립트는 문 밖", () =>
  withRoot((box) => {
    writeLedger(box, [
      write(HOUR, "terminal", "send", { caller: "X:\\ROOM\\Memory-Gate.ps1" }),
      write(HOUR, "terminal", "create", {
        caller: "/x/orca-worktree-create.ps1",
      }),
      write(HOUR, "terminal", "send", {
        caller: "C:/x/dispatch-worker.ps1.bak",
      }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    assert.equal(result.shimLedger.orchWrites.insideDoor, 2);
    assert.equal(result.shimLedger.orchWrites.outsideDoor, 1);
  }));
