// HYK-419-wire-1 (coder-task.md §2⑵/§2⑷) -- retire-author-shadow 결선
// 시험. 세 층을 증명한다:
//   (A) checkRelayHandshake의 실제 소비 성공 경로가 매번
//       `retire-author-shadow:` 한 줄을 표준출력에 찍는다(조립 성공/
//       실패 어느 쪽이든).
//   (B) ★차단 0(§2⑷) -- 그림자 관측이 실패(조립 실패)하든 스폰 자체가
//       실패하든(CLI 형제 파일 부재, 정확히 admission-completion-
//       spawn.test.mjs가 이미 고정한 격리 픽스처 모양), handshake 자신의
//       ok:true/영수증 생성 등 기존 동작은 한 글자도 바뀌지 않는다.
//   (C) runRetireAuthorShadowObservation 자신의 바깥 방어선(spawn 자체가
//       강제로 던져도 예외가 새지 않는다).
//
// ⛔ 실 관제실 원장에는 절대 쓰지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";
import {
  checkRelayHandshake,
  runRetireAuthorShadowObservation,
  parseKstTimestamp,
} from "./relay-handshake.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
// HYK-414 1R (time-judgment-now-injection.test.mjs) -- checkRelayHandshake를
// 절대시각 픽스처(아래 doneAt)와 함께 부를 때는 `now`를 벽시계(기본값
// Date.now())에 맡기지 않는다(relay-handshake-runner-receipt.test.mjs의
// 실사고 재발 방지 관례를 그대로 따른다: 픽스처+9h 부근 시간대에서만
// 실패하는 TZ 오라벨 오탐을 코드 변경 0으로 재현했던 바로 그 결함).
// doneAt("2026-08-01 07:10:05 KST") 몇 분 뒤로 고정한다.
const FIXED_NOW_MS = parseKstTimestamp("2026-08-01 07:15:00 KST").getTime();

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFixture(harnessDir, role, taskId, droppedAt, doneAt) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`,
    "utf8",
  );
}

function initAndAdmit(ledger, lock, reservationId) {
  runAdmissionCli([
    "init-cutover",
    "--ledger",
    ledger,
    "--lock",
    lock,
    "--live-seats",
    "[]",
  ]);
  runAdmissionCli([
    "admit",
    "--ledger",
    ledger,
    "--lock",
    lock,
    "--reservation-id",
    reservationId,
    "--cap",
    "1",
  ]);
}

function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

function withoutEnv(keys, fn) {
  const prior = {};
  for (const key of keys) {
    prior[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prior[key] !== undefined) process.env[key] = prior[key];
    }
  }
}

function captureConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function receiptsIn(harnessDir) {
  try {
    return readdirSync(join(harnessDir, "receipts"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// (A) 되돌림 변이 ⓐ의 대상: 이 시험은 이 호출 한 줄이 살아 있어야만
// 통과한다 -- runCompletionSideEffects의 그 호출을 지우면 이 시험이
// 빨개진다.
// ---------------------------------------------------------------------------

test("(A) 소비 성공 시 표준출력에 retire-author-shadow: 한 줄이 항상 찍힌다(조립 실패라도)", () => {
  const harnessDir = tmpDir("hyk419-shadow-wire-a-harness-");
  const ledgerDir = tmpDir("hyk419-shadow-wire-a-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-419-SHADOW-A-1";
    initAndAdmit(ledger, lock, taskId);
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-01 07:00 KST",
      "2026-08-01 07:10:05 KST",
    );

    let lines;
    withoutEnv(["DISPATCH_RECEIPT_PATH"], () => {
      withEnv(
        { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
        () => {
          lines = captureConsoleLog(() => {
            const r = checkRelayHandshake({
              role: "coder",
              harnessDir,
              now: FIXED_NOW_MS,
            });
            assert.equal(r.ok, true, "precondition: handshake succeeded");
          });
        },
      );
    });

    const shadowLines = lines.filter((l) =>
      l.startsWith("retire-author-shadow: "),
    );
    assert.equal(
      shadowLines.length,
      1,
      `정확히 한 줄이 찍혀야 한다, 실제: ${JSON.stringify(lines)}`,
    );
    assert.match(shadowLines[0], /label=HYK-419-SHADOW-A-1/);
    assert.match(shadowLines[0], /\(shadow -- 아무것도 차단하지 않음\)$/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (B) ★차단 0 -- 실제 조립 실패(DISPATCH_RECEIPT_PATH 미설정)가 발생한
// 상태에서도 기존 소비 효과(ok:true, 영수증 생성)는 조금도 달라지지
// 않는다.
// ---------------------------------------------------------------------------

test("(B) 차단 0: 그림자 조립이 실제로 실패해도(DISPATCH_RECEIPT_PATH 미설정) handshake의 ok:true·영수증 생성은 그대로다", () => {
  const harnessDir = tmpDir("hyk419-shadow-wire-b-harness-");
  const ledgerDir = tmpDir("hyk419-shadow-wire-b-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-419-SHADOW-B-1";
    initAndAdmit(ledger, lock, taskId);
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-01 07:00 KST",
      "2026-08-01 07:10:05 KST",
    );

    let result;
    withoutEnv(["DISPATCH_RECEIPT_PATH"], () => {
      withEnv(
        { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
        () => {
          result = checkRelayHandshake({
            role: "coder",
            harnessDir,
            now: FIXED_NOW_MS,
          });
        },
      );
    });

    assert.equal(result.ok, true, "handshake 자신의 판정은 바뀌지 않는다");
    assert.deepEqual(
      receiptsIn(harnessDir),
      ["coder-receipt-r1.json"],
      "필수 후속효과(영수증)는 그림자 관측과 무관하게 정상 생성된다",
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (B-2) ★차단 0의 핵심 회귀 방지 -- retirement-auto-author-shadow-cli.mjs
// (와 그 의존 파일들)가 격리 픽스처에 아예 없어도(admission-completion-
// spawn.test.mjs가 이미 고정한 것과 정확히 같은 "relay-handshake.mjs +
// time-authority/reject-streak/envelope-archive만" 모양) handshake는
// 여전히 exit 0이다. 이 시험이 바로 이 라운드가 처음에 놓쳤던 것 --
// retirement-auto-author-facts.mjs/-core.mjs를 relay-handshake.mjs에
// 정적 import했다가 이 정확한 격리 픽스처 24개가 MODULE_NOT_FOUND로
// 깨졌었다(실측, 1차 시도). 스폰 방식으로 바꾼 뒤 이 시험이 그 회귀를
// 고정한다.
// ---------------------------------------------------------------------------

test("(B-2) 회귀 고정: retirement-auto-author-shadow-cli.mjs 등 그림자 결선 형제 파일이 격리 픽스처에 없어도 relay-handshake CLI는 exit 0이다", () => {
  const isolatedDir = tmpDir("hyk419-shadow-wire-b2-isolated-");
  const isolatedCheckDir = join(isolatedDir, "scripts", "check");
  const harnessDir = tmpDir("hyk419-shadow-wire-b2-harness-");
  try {
    mkdirSync(isolatedCheckDir, { recursive: true });
    // admission-completion-spawn.test.mjs와 정확히 같은 4개 형제 파일만
    // 복사한다(의도적으로 retirement-auto-author-*.mjs 없음).
    for (const name of [
      "relay-handshake.mjs",
      "time-authority.mjs",
      "reject-streak.mjs",
      "envelope-archive.mjs",
    ]) {
      writeFileSync(
        join(isolatedCheckDir, name),
        readFileSync(join(CHECK_DIR, name), "utf8"),
        "utf8",
      );
    }
    const isolatedRelayHandshakePath = join(
      isolatedCheckDir,
      "relay-handshake.mjs",
    );
    writeFixture(
      harnessDir,
      "coder",
      "HYK-419-SHADOW-B2-1",
      "2026-08-11 06:00 KST",
      "2026-08-11 06:10:00 KST",
    );

    const res = spawnSync(
      process.execPath,
      [isolatedRelayHandshakePath, "coder", harnessDir],
      { encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(
      res.status,
      0,
      `isolated CLI should still exit 0: stdout=${res.stdout} stderr=${res.stderr}`,
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (C) ★차단 0 직접 증명 -- execFileFn(스폰) 자신이 강제로 던져도
// runRetireAuthorShadowObservation은 예외를 절대 밖으로 새지 않는다
// (되돌림 변이 ⓒ의 대상: 이 함수의 try/catch를 지우면 이 시험이 빨개진다).
// ---------------------------------------------------------------------------

test("(C) execFileFn이 강제로 던져도 runRetireAuthorShadowObservation은 예외를 던지지 않고 로그를 남긴다", () => {
  const lines = [];
  assert.doesNotThrow(() => {
    runRetireAuthorShadowObservation({
      role: "coder",
      harnessDir: "unused",
      taskId: "HYK-419-SHADOW-C-1",
      doneAt: "2026-08-01 07:10:05 KST",
      execFileFn: () => {
        throw new Error("forced spawn failure (test injection)");
      },
      logFn: (line) => lines.push(line),
    });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^retire-author-shadow: OBSERVATION_ERROR /);
  assert.match(lines[0], /label=HYK-419-SHADOW-C-1/);
  assert.match(lines[0], /\(shadow -- 아무것도 차단하지 않음\)$/);
});

test("(D) execFileFn이 성공하면 그 stdout을 그대로 로그로 넘긴다(트림 포함)", () => {
  const lines = [];
  runRetireAuthorShadowObservation({
    role: "coder",
    harnessDir: "unused",
    taskId: "HYK-419-SHADOW-D-1",
    doneAt: "x",
    execFileFn: () =>
      "retire-author-shadow: JUDGED reason=GATE_CLOSED label=HYK-419-SHADOW-D-1 (shadow -- 아무것도 차단하지 않음)\n",
    logFn: (line) => lines.push(line),
  });
  assert.equal(
    lines[0],
    "retire-author-shadow: JUDGED reason=GATE_CLOSED label=HYK-419-SHADOW-D-1 (shadow -- 아무것도 차단하지 않음)",
  );
});
