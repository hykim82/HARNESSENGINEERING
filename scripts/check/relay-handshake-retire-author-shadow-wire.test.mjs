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
import { spawnSync, execFileSync } from "node:child_process";
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
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- carry the marker so
    // this shared fixture keeps exercising the retire-author-shadow wiring
    // under test, not this promotion's rejection.
    `task_id: ${taskId}\n\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\ndone_stamped_by: finalize-done\n`,
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

// HYK-419-wire-2 §3-2 -- "정확히 한 줄"은 console.log 호출 횟수가 아니라
// «물리적 개행 개수»로 잰다(한 번의 console.log(다중행문자열) 호출도
// 실제 터미널에는 여러 줄로 찍힌다 -- P1-2가 지적한 결함이 바로 이
// 모양이었다). 개행 문자가 하나도 없어야 "1줄"이다.
function countPhysicalLines(str) {
  return String(str).split(/\r\n|\r|\n/).length;
}

function writeSlowChildScript(dir, delayMs, tailLine) {
  const p = join(dir, "slow-child.mjs");
  writeFileSync(
    p,
    `await new Promise((r) => setTimeout(r, ${delayMs}));\nconsole.log(${JSON.stringify(tailLine)});\n`,
    "utf8",
  );
  return p;
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
    // HYK-419-wire-2 §3-2: 파일 부재 경우도 "정확히 한 줄"이어야 한다 --
    // 프로덕션 배선 그대로(정적 import 0) 실제로 잰다.
    const shadowLines = res.stdout
      .split(/\r\n|\r|\n/)
      .filter((l) => l.startsWith("retire-author-shadow: "));
    assert.equal(
      shadowLines.length,
      1,
      `파일 부재 경우도 정확히 한 줄이어야 한다, 실제 stdout: ${JSON.stringify(res.stdout)}`,
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

// ---------------------------------------------------------------------------
// HYK-419-wire-2 (2R 수리, 검토 P1-1/P1-2) -- 완료조건 §3-1/§3-2가 요구하는
// «다섯 경우 전부»(비정상 종료·stderr 폭주·파일 부재·지연·예외)에서
// (a) 소비 동작·종료코드 불변 (b) retire-author-shadow: 가 정확히 1줄임을
// 각각 직접 고정한다.
// ---------------------------------------------------------------------------

// (E) 지연(시간 초과) -- ★실제 지연 자식(진짜 child_process)을 진짜
// timeout(테스트에서는 200ms로 짧게)으로 죽인다. 되돌림 변이 ⓐ(2R)의
// 대상: execFileFn 호출의 timeout 옵션을 지우면 이 시험이 빨개진다(느린
// 자식이 끝까지 실행돼 elapsed 단언과 state=TIMEOUT 단언 둘 다 깨진다).
//
// HYK-430 2R(검토 반려 P1-2 수리) -- 1R은 이 자리에 `elapsedMs < 2500`
// 이라는 «고정 임계»를 남겼고, 재시도(1회)가 실제 스폰/kill 오버헤드를
// 만나 총 2572ms까지 늘어나며 그 자체가 깨졌다(REVIEW 실측). 같은 형태
// (「재시도로 늘어난 실측 시간」 vs 「독립적으로 고른 작은 절대값」)를
// 다시 만들지 않기 위해 두 가지로 바꾼다:
//   (1) 정밀도가 필요한 부분(정확히 재시도 1회가 일어났는가)은
//       ★결정적인 호출 횟수 스파이로 증명한다(벽시계 무관, 부하 무관).
//   (2) 벽시계 검사는 «정밀 타이밍 계약»이 아니라 «자식의 전체 지연을
//       다 기다리지 않았다»는 느슨한 안전망으로만 남긴다 -- 그 기준을
//       느슨한 절대값(2500) 대신 ★이 시험 자신이 설계한 자식 지연
//       (SLOW_CHILD_DELAY_MS)에서 직접 파생시킨다: 자식 지연을 넉넉히
//       크게(15000ms) 잡아, 실측 스폰/kill 오버헤드가 REVIEW가 관측한
//       값(2572ms)의 5배까지 늘어나도 여전히 자식 지연에는 한참
//       못 미치게 한다. ⛔이건 "숫자를 키운" 것이 아니다 -- 비교
//       기준값 자체(2500)를 올린 게 아니라, "무엇과 비교하는가"를
//       독립 상수에서 이 시험이 스스로 설계한 자식 지연으로 바꾼
//       것이다(그 지연은 얼마든지 늘려도 시험 속도에 영향이 없다 --
//       자식은 어차피 timeout에 죽으므로 실제로 그 시간만큼 기다리지
//       않는다).
const SLOW_CHILD_DELAY_MS = 15000;

test("(E)★ 실제 지연 자식을 진짜 timeout(200ms)으로 죽여도 소비는 멈추지 않고 정확히 한 줄, state=TIMEOUT, 재시도 정확히 1회(호출 횟수로 결정적 증명)", () => {
  const dir = tmpDir("hyk419-shadow-wire-e-");
  try {
    const slowPath = writeSlowChildScript(
      dir,
      SLOW_CHILD_DELAY_MS,
      "retire-author-shadow: JUDGED reason=SHOULD_NOT_ARRIVE label=late (shadow -- 아무것도 차단하지 않음)",
    );
    const lines = [];
    let spawnCalls = 0;
    const startedAt = Date.now();
    assert.doesNotThrow(() => {
      runRetireAuthorShadowObservation({
        role: "coder",
        harnessDir: "unused",
        taskId: "HYK-419-SHADOW-E-1",
        doneAt: "x",
        timeoutMs: 200,
        execFileFn: (_cmd, _args, opts) => {
          spawnCalls += 1;
          return execFileSync(process.execPath, [slowPath], opts);
        },
        logFn: (line) => lines.push(line),
      });
    });
    const elapsedMs = Date.now() - startedAt;
    // 결정적 증명(부하 무관) -- 정본 정책이 로드된 정상 경로이므로
    // 재시도 1회가 있어야 한다: 총 시도 = 2.
    assert.equal(
      spawnCalls,
      2,
      `무응답 자식은 재시도 1회를 포함해 정확히 2번 스폰돼야 한다 -- 실측: ${spawnCalls}`,
    );
    // 느슨한 안전망(부하에 영향받되, 실패 방향은 "타임아웃 메커니즘
    // 자체가 사라졌다"는 회귀만 잡는다) -- 독립 절대값이 아니라 이
    // 시험이 설계한 자식 지연에서 직접 파생.
    assert.ok(
      elapsedMs < SLOW_CHILD_DELAY_MS,
      `자식의 전체 지연(${SLOW_CHILD_DELAY_MS}ms)을 다 기다리면 안 된다(타임아웃 메커니즘 소실 회귀) -- 실측: ${elapsedMs}ms`,
    );
    assert.equal(
      lines.length,
      1,
      `logFn 호출은 정확히 1번, 실제: ${JSON.stringify(lines)}`,
    );
    assert.equal(
      countPhysicalLines(lines[0]),
      1,
      `물리적으로 정확히 한 줄이어야 한다: ${JSON.stringify(lines[0])}`,
    );
    assert.match(lines[0], /^retire-author-shadow: TIMEOUT /);
    assert.match(lines[0], /label=HYK-419-SHADOW-E-1/);
    assert.match(lines[0], /\(shadow -- 아무것도 차단하지 않음\)$/);
    assert.doesNotMatch(
      lines[0],
      /SHOULD_NOT_ARRIVE/,
      "느린 자식의 늦은 출력이 새어 나오면 안 된다 -- 죽은 뒤의 값이다",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (F-1) 비정상 종료 -- 짧은 stderr 한 줄 + nonzero exit.
test("(F-1) 비정상 종료(짧은 stderr, nonzero exit)에도 정확히 한 줄, state=OBSERVATION_ERROR", () => {
  const lines = [];
  runRetireAuthorShadowObservation({
    role: "coder",
    harnessDir: "unused",
    taskId: "HYK-419-SHADOW-F1-1",
    doneAt: "x",
    execFileFn: () => {
      const err = new Error("Command failed");
      err.status = 1;
      err.stderr = "boom: something went wrong\n";
      throw err;
    },
    logFn: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.equal(countPhysicalLines(lines[0]), 1);
  assert.match(lines[0], /^retire-author-shadow: OBSERVATION_ERROR /);
  assert.match(lines[0], /\(shadow -- 아무것도 차단하지 않음\)$/);
});

// (F-2) stderr 폭주 -- 되돌림 변이 ⓑ(2R)의 대상: normalizeChildStdout/
// shadowLine의 개행 정규화(toOneLine)를 지우면 이 시험이 빨개진다(원문
// stderr의 개행이 그대로 살아남아 물리적으로 여러 줄이 된다, P1-2가
// 실측한 결함 그대로).
test("(F-2)★ stderr 폭주(50줄)에도 정확히 한 줄(개행 전부 제거), 길이 상한 안", () => {
  const lines = [];
  const floodedStderr =
    Array.from(
      { length: 50 },
      (_, i) => `line ${i}: some diagnostic noise here`,
    ).join("\n") + "\n";
  runRetireAuthorShadowObservation({
    role: "coder",
    harnessDir: "unused",
    taskId: "HYK-419-SHADOW-F2-1",
    doneAt: "x",
    execFileFn: () => {
      const err = new Error("Command failed");
      err.status = 1;
      err.stderr = floodedStderr;
      throw err;
    },
    logFn: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.equal(
    countPhysicalLines(lines[0]),
    1,
    `stderr 50줄이 원문 그대로 삽입되면 이 단언이 깨진다: 실제 물리행수=${countPhysicalLines(lines[0])}`,
  );
  assert.match(lines[0], /^retire-author-shadow: OBSERVATION_ERROR /);
  assert.ok(
    lines[0].length < 500,
    `길이 상한이 걸려야 한다(50줄 원문을 그대로 넣으면 1500자를 넘는다), 실제 길이: ${lines[0].length}`,
  );
});

// (G) 파일 부재 -- 진짜 존재하지 않는 경로에 진짜 execFileSync를 건다
// (ENOENT/MODULE_NOT_FOUND 실물 에러 형태, 흉내가 아니다). (B-2)는 실
// 프로덕션 배선(정적 import 0)을 증명하고, 이 시험은 그 파일-부재 경우도
// "정확히 한 줄"임을 직접 잰다.
test("(G) 파일 부재(진짜 존재하지 않는 경로)에도 정확히 한 줄, state=OBSERVATION_ERROR", () => {
  const lines = [];
  runRetireAuthorShadowObservation({
    role: "coder",
    harnessDir: "unused",
    taskId: "HYK-419-SHADOW-G-1",
    doneAt: "x",
    execFileFn: (_cmd, _args, opts) =>
      execFileSync(
        process.execPath,
        ["C:/definitely/not/a/real/shadow-cli-path.mjs"],
        opts,
      ),
    logFn: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.equal(countPhysicalLines(lines[0]), 1);
  assert.match(lines[0], /^retire-author-shadow: OBSERVATION_ERROR /);
  assert.match(lines[0], /label=HYK-419-SHADOW-G-1/);
});

// (H) 예외 -- (C)를 "정확히 한 줄" 관점에서 다시 고정(개행 없는 단순
// Error.message도 물리적으로 정확히 1줄임을 명시 단언).
test("(H) execFileFn이 강제로 던지는 예외에도 물리적으로 정확히 한 줄", () => {
  const lines = [];
  runRetireAuthorShadowObservation({
    role: "coder",
    harnessDir: "unused",
    taskId: "HYK-419-SHADOW-H-1",
    doneAt: "x",
    execFileFn: () => {
      throw new TypeError("forced exception (test injection)");
    },
    logFn: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.equal(countPhysicalLines(lines[0]), 1);
  assert.match(lines[0], /^retire-author-shadow: OBSERVATION_ERROR /);
});

// (I) 자식이 exit 0인데 stdout이 비어 있음(P1-2 실측 재현) -- 부모가 직접
// 한 줄을 만들어 남긴다.
test("(I) 자식이 exit 0인데 stdout이 비어 있어도 줄이 0개가 되지 않는다(부모가 대신 만든다)", () => {
  const lines = [];
  runRetireAuthorShadowObservation({
    role: "coder",
    harnessDir: "unused",
    taskId: "HYK-419-SHADOW-I-1",
    doneAt: "x",
    execFileFn: () => "",
    logFn: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.equal(countPhysicalLines(lines[0]), 1);
  assert.match(lines[0], /^retire-author-shadow: MALFORMED_OUTPUT /);
  assert.match(lines[0], /\(shadow -- 아무것도 차단하지 않음\)$/);
});
