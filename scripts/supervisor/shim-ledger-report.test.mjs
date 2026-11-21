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
// 시계 규율(HYK-389-shim-clock-1): 이 파일의 «지금» 은 두 종류다.
//  - NOW = 고정 값. 같은 프로세스 칸(runReachOnce · summarizeShimLedger)은 `now`/
//    `nowMs` 로 이 값을 «직접 주입» 하므로 실제 시계와 무관하다.
//  - CLI 자식 프로세스 칸(R7 · R10 · R11)은 자식이 «자기 실제 시계» 로 지난 24시간을
//    자른다(CLI 에 `--now` 같은 시각 주입 통로가 없다). 그래서 자식 칸은 원장 줄을
//    NOW 가 아니라 «실행 시점의 실제 시계(childClock)» 기준으로 심는다.
const NOW = Date.parse("2026-11-19T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SCHEMA = "orca-direct-ledger/1";
const HEADING = "## ORCH 좌석 직접 쓰기(shim 원장 · OBSERVER)";

// «base 시각 기준 msAgo 전» 줄을 만드는 묶음. 기본 묶음(boot · write)은 고정 NOW 를
// 쓰고, 자식 칸은 `ledgerAt(childClock(...))` 로 실제 시계 기준 묶음을 쓴다.
function ledgerAt(baseMs) {
  const iso = (msAgo) => new Date(baseMs - msAgo).toISOString();
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
  return { iso, boot, write };
}

const { iso, boot, write } = ledgerAt(NOW);

// 자식 프로세스의 «지금» = 실행 시점의 실제 시계(+ 흉내 낸 어긋남 shiftMs).
// shiftMs 가 0 이면 정직한 실제 시계다. 0 이 아니면 runReachCli 가 자식의 Date 를
// 그만큼 밀어, «실제 시계가 고정 값에서 며칠 뒤» 인 날을 오늘 흉내 낸다.
function childClock(shiftMs = 0) {
  return Date.now() + shiftMs;
}

// 자식의 Date.now()/new Date() 를 HYK389_CLOCK_SHIFT_MS 만큼 미는 preload(합성 임시
// 폴더 안 파일 · 제품 코드 무접촉). `node --require <파일> reach-report.mjs ...`.
const CLOCK_SHIFT_PRELOAD = `"use strict";
const shift = Number(process.env.HYK389_CLOCK_SHIFT_MS || 0);
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + shift);
    else super(...args);
  }
  static now() {
    return RealDate.now() + shift;
  }
}
globalThis.Date = ShiftedDate;
`;

// reach-report CLI 를 자식으로 돈다. 시각 주입 인자가 없으므로 자식 시계는 실제 시계(+shift).
function runReachCli(box, { shiftMs = 0 } = {}) {
  const cliArgs = [
    REACH_CLI,
    "--report",
    ...["--watch-log", box.watchLog],
    ...["--report-out", box.reportOut],
    ...["--state-path", box.statePath],
    ...["--notify-dir", box.notifyDir],
    ...["--shim-ledger", box.ledger],
  ];
  if (shiftMs === 0) {
    return spawnSync(process.execPath, cliArgs, { encoding: "utf8" });
  }
  const preload = path.join(box.root, "clock-shift-preload.cjs");
  writeFileSync(preload, CLOCK_SHIFT_PRELOAD, "utf8");
  return spawnSync(process.execPath, ["--require", preload, ...cliArgs], {
    encoding: "utf8",
    env: { ...process.env, HYK389_CLOCK_SHIFT_MS: String(shiftMs) },
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

// P2-4(HYK-389-orch-launch-2): 깨진 줄 1건이 관측 전체를 지우지 않는다 -- 깨진 줄은
// 건수로 따로 세어 줄 머리 «부분 관측» 표지에 적고, 나머지 줄은 집계한다(하한).
test("R3 깨진 줄 1 + 정상 줄 여럿 -> «부분 관측 · 깨진 줄 1건» 표지 + 집계 수 + 깨진 줄 수가 값으로 · 관측 불가로 지우지 않는다", () =>
  withRoot((box) => {
    writeLedger(box, [
      boot(5 * HOUR, "enabled"),
      boot(4 * HOUR, "disabled", "REAL_BIN_MISSING"),
      "{ this is not json",
      write(3 * HOUR, "terminal", "send"),
      write(2 * HOUR, "orchestration", "dispatch", { caller: DOOR }),
      write(1 * HOUR, "terminal", "close", { caller: "C:/tmp/adhoc.ps1" }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("[부분 관측 · 깨진 줄 1건]"), line);
    assert.ok(line.includes("ORCH 부팅 2(기록 켬 1 · 끔 1"), line);
    assert.ok(line.includes("설계된 문 밖 직접 쓰기 2건"), line);
    assert.ok(line.includes("문 안 1건"), line);
    assert.ok(line.includes("하한"), line);
    assert.ok(!line.includes("관측 불가"), line);
    assert.equal(result.shimLedger.status, "partial");
    assert.equal(result.shimLedger.brokenLines, 1);
    assert.equal(result.shimLedger.readLines, 5);
    assert.equal(result.shimLedger.orchWrites.outsideDoor, 2);
    assert.equal(result.shimLedger.boots.total, 2);
  }));

test("R3c 마지막 줄이 찢김(덧붙이다 끊긴 줄) + 앞 줄 정상 -> 부분 관측 · 깨진 줄 1건 · 앞 줄은 집계", () =>
  withRoot((box) => {
    const full = write(1 * HOUR, "terminal", "send");
    writeFileSync(
      box.ledger,
      `${boot(2 * HOUR, "enabled")}\n${full}\n${full.slice(0, full.length - 25)}`,
      "utf8",
    );
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("[부분 관측 · 깨진 줄 1건]"), line);
    assert.ok(line.includes("ORCH 부팅 1(기록 켬 1"), line);
    assert.ok(line.includes("설계된 문 밖 직접 쓰기 1건"), line);
    assert.equal(result.shimLedger.status, "partial");
  }));

test("R3b 읽을 수 없는 모양(알 수 없는 schema · ts 없음 · 부팅 줄의 shim 값 이상)도 깨진 줄이다 · 읽을 수 있는 줄 0 이면 «전체 관측 불가»", () =>
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
    assert.equal(result.shimLedger.readLines, 0);
    assert.equal(result.shimLedger.status, "unobservable");
    const line = shimLine(result.reportText);
    assert.ok(line.includes("관측 불가"), line);
    assert.ok(line.includes("읽을 수 있는 줄 0"), line);
    assert.ok(line.includes("깨진 줄 3건"), line);
    assert.ok(line.includes("0건이 아니다"), line);
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

// P2-4: «전체 관측 불가» 는 원장 없음(R2) 또는 읽을 수 있는 줄 0 일 때만이다. 빈 파일도
// 읽을 수 있는 줄이 0 이다 -> 관측 불가(1R 의 «빈 파일 = 관측된 0» 은 이 문면으로
// 대체: 0 줄은 «아무도 안 부팅했다» 와 «원장이 잘렸다» 를 가를 수 없다).
test("R5 원장 파일이 «있고 비어 있음»(읽을 수 있는 줄 0) -> «전체 관측 불가» · 0건으로 접지 않는다", () =>
  withRoot((box) => {
    writeLedger(box, []);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.includes("관측 불가"), line);
    assert.ok(line.includes("읽을 수 있는 줄 0"), line);
    assert.ok(line.includes("0건이 아니다"), line);
    assert.ok(!line.includes("설계된 문 밖 직접 쓰기 0건"), line);
    assert.equal(result.shimLedger.status, "unobservable");
  }));

test("R5b 줄은 있는데 보고 기간(24시간) 밖뿐 = 읽을 수 있는 줄이 있으니 «관측된 0»(부분도 불가도 아님)", () =>
  withRoot((box) => {
    writeLedger(box, [
      boot(40 * HOUR, "enabled"),
      write(30 * HOUR, "terminal", "send"),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.startsWith("ORCH 부팅 0(기록 켬 0 · 끔 0"), line);
    assert.ok(!line.includes("관측 불가"), line);
    assert.ok(!line.includes("부분 관측"), line);
    assert.equal(result.shimLedger.status, "ok");
    assert.equal(result.shimLedger.readLines, 2);
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
    // 자식은 실제 시계로 지난 24시간을 자른다 -> 줄을 «실제 시계» 기준으로 심는다.
    const at = ledgerAt(childClock());
    writeLedger(box, [
      at.boot(HOUR, "disabled", "CLI_MISSING"),
      at.write(HOUR, "orchestration", "task-update"),
    ]);
    const r = runReachCli(box);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(HEADING), r.stdout);
    assert.ok(r.stdout.includes("CLI_MISSING 1"), r.stdout);
    assert.ok(r.stdout.includes("orchestration task-update 1"), r.stdout);
  }));

// P2-1: «설계된 문» = 정본 경로의 스크립트(설계 §조각 4 행). caller_script 의 «정규화된
// 전체 경로» 를 정본 경로 목록과 대조한다 -- 이름만 같고 위치가 다르면 문 밖.
const ROOM = "D:/문서관리/하네스-관제실";

test("R8 이름은 같고 위치가 다른 호출자 -> «문 밖» (정본 경로가 아니면 이름이 같아도 문 안으로 세지 않는다)", () =>
  withRoot((box) => {
    writeLedger(box, [
      write(HOUR, "terminal", "send", { caller: "X:\\ROOM\\Memory-Gate.ps1" }),
      write(HOUR, "terminal", "create", {
        caller: "/x/orca-worktree-create.ps1",
      }),
      write(HOUR, "terminal", "send", {
        caller: "C:/x/dispatch-worker.ps1",
      }),
      write(HOUR, "terminal", "send", {
        caller: `${ROOM}/sub/dispatch-worker.ps1`,
      }),
      write(HOUR, "terminal", "send", {
        caller: `${ROOM}/dispatch-worker.ps1.bak`,
      }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    assert.equal(result.shimLedger.orchWrites.insideDoor, 0);
    assert.equal(result.shimLedger.orchWrites.outsideDoor, 5);
  }));

test("R8b 정본 경로 -> «문 안» (대소문자 · 구분자 · 중복 슬래시 · `.`/`..` 정규화 뒤 같으면 같은 경로)", () =>
  withRoot((box) => {
    writeLedger(box, [
      write(HOUR, "terminal", "send", { caller: DOOR }),
      write(HOUR, "terminal", "send", {
        caller: "d:\\문서관리\\하네스-관제실\\DISPATCH-WORKER.PS1",
      }),
      write(HOUR, "terminal", "send", {
        caller: `D://문서관리//하네스-관제실/./sub/../memory-gate.ps1`,
      }),
      write(HOUR, "terminal", "create", {
        caller: `${ROOM}/orca-worktree-create.ps1`,
      }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    assert.equal(result.shimLedger.orchWrites.insideDoor, 4);
    assert.equal(result.shimLedger.orchWrites.outsideDoor, 0);
  }));

test("R8c 증명할 수 없는 경로(8.3 짧은 이름 `~` · 상대 경로 · 이름만 · 빈 값)는 «문 밖» — 정본이라고 단정하지 않는다", () =>
  withRoot((box) => {
    writeLedger(box, [
      write(HOUR, "terminal", "send", {
        caller: "D:/문서관리/HARNES~1/dispatch-worker.ps1",
      }),
      write(HOUR, "terminal", "send", { caller: "~/dispatch-worker.ps1" }),
      write(HOUR, "terminal", "send", { caller: "dispatch-worker.ps1" }),
      write(HOUR, "terminal", "send", {
        caller: "../하네스-관제실/dispatch-worker.ps1",
      }),
      write(HOUR, "terminal", "send", { caller: "" }),
    ]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    assert.equal(result.shimLedger.orchWrites.insideDoor, 0);
    assert.equal(result.shimLedger.orchWrites.outsideDoor, 5);
  }));

test("R8d 보고 줄 한계 문구가 새 동작(정본 경로 기준)을 말한다 · 옛 «파일 이름 기준» 이 아니다", () =>
  withRoot((box) => {
    writeLedger(box, [boot(HOUR, "enabled")]);
    const result = runReport(box, { shimLedgerPath: box.ledger });
    const line = shimLine(result.reportText);
    assert.ok(line.includes("정본 경로"), line);
    assert.ok(!line.includes("파일 이름 기준"), line);
  }));

test("R9 정본 경로 목록은 «주입 가능» — 주입한 목록이 기본값을 대체하고 · 이름만 적힌 항목은 어떤 호출자도 문 안으로 만들지 못한다", async () => {
  const core = await import("./shim-ledger-report-core.mjs");
  const text = [
    write(HOUR, "terminal", "send", {
      caller: "z:\\CANON\\Dispatch-Worker.ps1",
    }),
    write(HOUR, "terminal", "send", { caller: DOOR }),
    write(HOUR, "terminal", "send", { caller: "Z:/other/dispatch-worker.ps1" }),
  ].join("\n");
  const injected = core.summarizeShimLedger({
    text,
    nowMs: NOW,
    designedDoors: ["Z:/canon/dispatch-worker.ps1"],
  });
  assert.equal(injected.orchWrites.insideDoor, 1);
  assert.equal(injected.orchWrites.outsideDoor, 2);
  const nameOnly = core.summarizeShimLedger({
    text,
    nowMs: NOW,
    designedDoors: ["dispatch-worker.ps1"],
  });
  assert.equal(nameOnly.orchWrites.insideDoor, 0);
  assert.equal(nameOnly.orchWrites.outsideDoor, 3);
  const byDefault = core.summarizeShimLedger({ text, nowMs: NOW });
  assert.equal(byDefault.orchWrites.insideDoor, 1);
  assert.ok(
    core.DEFAULT_DESIGNED_DOOR_PATHS.every((p) => /^[A-Za-z]:\//.test(p)),
    "기본 정본 경로 목록은 드라이브가 있는 «전체 경로» 여야 한다",
  );
});

test("R10 CLI 자식 프로세스: 깨진 줄 1 + 정상 줄 -> 화면 출력에 «[부분 관측 · 깨진 줄 1건]» 표지 · 이름만 같은 호출자는 문 밖으로 센다", () =>
  withRoot((box) => {
    // 자식은 실제 시계로 지난 24시간을 자른다 -> 줄을 «실제 시계» 기준으로 심는다.
    const at = ledgerAt(childClock());
    writeLedger(box, [
      at.boot(2 * HOUR, "enabled"),
      "{ torn",
      at.write(HOUR, "terminal", "send", { caller: DOOR }),
      at.write(HOUR, "terminal", "send", {
        caller: "C:/x/dispatch-worker.ps1",
      }),
    ]);
    const r = runReachCli(box);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("[부분 관측 · 깨진 줄 1건]"), r.stdout);
    assert.ok(r.stdout.includes("설계된 문 밖 직접 쓰기 1건"), r.stdout);
    assert.ok(r.stdout.includes("문 안 1건"), r.stdout);
  }));

// 시험 칸(HYK-389-shim-clock-1): 실제 시계가 고정 NOW 에서 «며칠 뒤» 여도 초록이다.
// 자식에 시각 주입 통로가 없으므로, 자식의 Date 를 +7일 밀어(preload · 제품 코드 무접촉)
// «고정 NOW 에서 며칠 뒤의 실제 시계» 를 오늘 흉내 낸다. 줄을 고정 NOW 기준으로 심으면
// (옛 R7 · R10 모양) 자식의 24시간 창 밖이라 이 칸이 빨강이 된다 -- 실제 시계 기준으로
// 심은 것 자체가 이 칸의 초록 근거다.
test("R11 CLI 자식 프로세스: 자식 시계가 고정 NOW 에서 며칠 뒤(+7일)여도 실제 시계 기준으로 심은 원장 · 깨진 줄 처리가 화면 출력에 실린다", () =>
  withRoot((box) => {
    const shiftMs = 7 * DAY;
    const at = ledgerAt(childClock(shiftMs));
    writeLedger(box, [
      at.boot(2 * HOUR, "disabled", "CLI_MISSING"),
      "{ torn",
      at.write(HOUR, "orchestration", "task-update"),
      at.write(HOUR, "terminal", "send", { caller: DOOR }),
    ]);
    const r = runReachCli(box, { shiftMs });
    assert.equal(r.status, 0, r.stderr);
    // preload 가 실제로 먹었는지: 보고 머리의 «기준» 시각이 (실제 시계 + 7일) 근처이고,
    // 고정 NOW 에서 7일 이상 뒤다.
    const stamped = /-- (\S+) 기준/.exec(r.stdout);
    assert.ok(stamped, r.stdout);
    const childNow = Date.parse(stamped[1]);
    assert.ok(
      Math.abs(childNow - (Date.now() + shiftMs)) < 5 * 60 * 1000,
      r.stdout,
    );
    assert.ok(
      childNow - NOW >= 7 * DAY,
      `${stamped[1]} 는 고정 NOW 에서 7일 이상 뒤여야 한다`,
    );
    // R7 · R10 과 같은 단언(약화 0): 원장이 실리고 · 깨진 줄은 부분 관측으로 센다.
    assert.ok(r.stdout.includes(HEADING), r.stdout);
    assert.ok(r.stdout.includes("[부분 관측 · 깨진 줄 1건]"), r.stdout);
    assert.ok(r.stdout.includes("CLI_MISSING 1"), r.stdout);
    assert.ok(r.stdout.includes("orchestration task-update 1"), r.stdout);
    assert.ok(r.stdout.includes("설계된 문 밖 직접 쓰기 1건"), r.stdout);
    assert.ok(r.stdout.includes("문 안 1건"), r.stdout);
  }));
