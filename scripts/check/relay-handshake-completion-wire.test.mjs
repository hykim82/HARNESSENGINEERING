// HYK-227 §3 -- "모든 검증된 결과 소비자가 입장 예약 완료 결선을 의무적으로
// 소비한다"는 계약을 직접 고정한다. 이 파일 이전까지 존재하던 커버리지
// (admission-completion-spawn.test.mjs)는 relay-handshake.mjs의 CLI
// `invokedDirectly` 경로만 실행했다 -- 5개의 in-process 호출자(relay-
// core.mjs / watch-result.mjs / seat-signal-adapter.mjs / orca-spike-
// live.mjs / orca-spike-runner.mjs)가 checkRelayHandshake를 직접 import해
// 호출하는 경로는 단 한 건도 이 결선을 실측하지 않았다 -- 정확히 이
// 이슈가 닫는 gap이다. 아래 ⓐⓑⓒⓓ는 그 gap을 직접 겨눈다.
//
// ⛔ 실제 관제실 정본 원장에는 절대 쓰지 않는다 -- 모든 원장은 mkdtemp
// 합성 픽스처다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFixture(harnessDir, role, taskId, droppedAt, doneAt) {
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

function readStatus(ledger, reservationId) {
  return JSON.parse(readFileSync(ledger, "utf8")).reservations[reservationId]
    .status;
}

// withEnv: temporarily sets process.env keys for the duration of `fn`,
// restoring the exact prior values (including "was unset") afterward --
// needed because ⓐ/ⓑ's in-process half calls checkRelayHandshake() directly
// (no child process, no injectable env), so ADMISSION_LEDGER_PATH must be
// set on THIS process's own env for autoCompleteAdmission to see it.
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

// ---------------------------------------------------------------------------
// ⓐ 자동 반납: synthetic ledger의 ACTIVE 예약이, in-process checkRelayHandshake
// 호출(=검증된 결과 소비) 한 번으로 사람 손 0으로 COMPLETED가 되는지.
// ---------------------------------------------------------------------------

test("ⓐ 자동 반납: in-process checkRelayHandshake() call releases a synthetic ACTIVE reservation with 0 human touch", () => {
  const harnessDir = tmpDir("hyk227-a-harness-");
  const ledgerDir = tmpDir("hyk227-a-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskId = "HYK-227-A-1";
    initAndAdmit(ledger, lock, taskId);
    assert.equal(
      readStatus(ledger, taskId),
      "ACTIVE",
      "precondition: reservation starts ACTIVE",
    );
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-11 06:00 KST",
      "2026-08-11 06:10 KST",
    );

    const result = withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () => checkRelayHandshake({ role: "coder", harnessDir }),
    );

    assert.equal(result.ok, true, "handshake itself must pass");
    assert.equal(
      readStatus(ledger, taskId),
      "COMPLETED",
      "the ACTIVE reservation must be released with no human action beyond the in-process call itself",
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓑ 경로 동등성: CLI 경로(spawn)와 in-process 경로가 같은 최종 상태를
// 만드는지 -- 한쪽만 되면 실패.
// ---------------------------------------------------------------------------

// assertBothPathsCompletedAndEqual -- extracted from the ⓑ test body
// (quality-check: keeps that test's own line count under the repo's ESLint
// max-lines-per-function ceiling after prettier's reformat pushed it 1 line
// over -- pure extraction, no assertion added/removed/reordered).
function assertBothPathsCompletedAndEqual(ledger, taskIdCli, taskIdInProc) {
  const cliStatus = readStatus(ledger, taskIdCli);
  const inProcStatus = readStatus(ledger, taskIdInProc);
  assert.equal(cliStatus, "COMPLETED", "CLI path must release its reservation");
  assert.equal(
    inProcStatus,
    "COMPLETED",
    "in-process path must release its reservation too -- this is the exact gap HYK-227 closes",
  );
  assert.equal(
    cliStatus,
    inProcStatus,
    "both paths must land on the identical final status",
  );
}

test("ⓑ 경로 동등성: CLI-spawned path and in-process path both drive their reservation to COMPLETED, same shape", () => {
  const harnessDirCli = tmpDir("hyk227-b-harness-cli-");
  const harnessDirInProc = tmpDir("hyk227-b-harness-inproc-");
  const ledgerDir = tmpDir("hyk227-b-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const taskIdCli = "HYK-227-B-CLI";
    const taskIdInProc = "HYK-227-B-INPROC";
    initAndAdmit(ledger, lock, taskIdCli);
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      taskIdInProc,
      "--cap",
      "2",
    ]);

    writeFixture(
      harnessDirCli,
      "coder",
      taskIdCli,
      "2026-08-11 06:00 KST",
      "2026-08-11 06:10 KST",
    );
    writeFixture(
      harnessDirInProc,
      "coder",
      taskIdInProc,
      "2026-08-11 06:00 KST",
      "2026-08-11 06:10 KST",
    );

    // CLI path: real subprocess spawn, exactly what a human/relay watcher
    // actually invokes (§4 "칠 명령").
    const cliRes = spawnSync(
      process.execPath,
      [RELAY_HANDSHAKE_PATH, "coder", harnessDirCli],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ADMISSION_LEDGER_PATH: ledger,
          ADMISSION_LOCK_PATH: lock,
        },
      },
    );
    assert.equal(
      cliRes.status,
      0,
      `CLI handshake should pass: ${cliRes.stderr}`,
    );

    // in-process path: the exact shape relay-core.mjs/watch-result.mjs/
    // seat-signal-adapter.mjs/orca-spike-live.mjs/orca-spike-runner.mjs use
    // -- a direct function call, never a spawn.
    const inProcRes = withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () =>
        checkRelayHandshake({ role: "coder", harnessDir: harnessDirInProc }),
    );
    assert.equal(inProcRes.ok, true, "in-process handshake should pass");

    assertBothPathsCompletedAndEqual(ledger, taskIdCli, taskIdInProc);
  } finally {
    rmSync(harnessDirCli, { recursive: true, force: true });
    rmSync(harnessDirInProc, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ 의무성 (변이 시험): checkRelayHandshake의 ok:true 분기에서
// spawnAdmissionCompletion(taskId) 호출을 제거하면, 핸드셰이크 자체는 여전히
// 통과하면서 예약은 ACTIVE로 남아야 한다(=RED). 원복 증명: 실제 소스
// 파일은 이 시험 내내 한 번도 쓰기 대상이 아니었다는 것을
// `git diff --exit-code`로 직접 확인한다.
// ---------------------------------------------------------------------------

// stageIsolatedRelayHandshakeDeps -- extracted from the ⓒ test body
// (quality-check: keeps that test's own line count under the repo's
// ESLint max-lines-per-function ceiling after prettier's reformat pushed
// it 1 line over -- pure extraction, no assertion/behavior change).
// Mirrors admission-completion-spawn.test.mjs's own isolated-fixture
// dependency closure (time-authority/reject-streak/envelope-archive +
// the admission adapter's own supervisor siblings).
function stageIsolatedRelayHandshakeDeps(rootDir) {
  const checkDir = join(rootDir, "scripts", "check");
  const supervisorDir = join(rootDir, "scripts", "supervisor");
  mkdirSync(checkDir, { recursive: true });
  mkdirSync(supervisorDir, { recursive: true });
  for (const name of [
    "time-authority.mjs",
    "reject-streak.mjs",
    "envelope-archive.mjs",
    "admission-completion-adapter.mjs",
  ]) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  for (const name of [
    "admission-ledger-core.mjs",
    "admission-ledger-store.mjs",
  ]) {
    writeFileSync(
      join(supervisorDir, name),
      readFileSync(join(CHECK_DIR, "..", "supervisor", name), "utf8"),
      "utf8",
    );
  }
  return { checkDir, supervisorDir };
}

test("ⓒ 의무성: removing spawnAdmissionCompletion(taskId) from checkRelayHandshake's ok:true branch -> handshake still passes but reservation stays ACTIVE -> RED, and the real source file is provably untouched", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target = "  spawnAdmissionCompletion(taskId);\n";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "spawnAdmissionCompletion(taskId) call" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, "");

  const rootDir = tmpDir("hyk227-c-root-");
  const harnessDir = tmpDir("hyk227-c-harness-");
  const ledgerDir = tmpDir("hyk227-c-ledger-");
  const ledger = join(ledgerDir, "l.json");
  const lock = join(ledgerDir, "l.lock");
  try {
    const { checkDir } = stageIsolatedRelayHandshakeDeps(rootDir);
    writeFileSync(join(checkDir, "relay-handshake.mjs"), mutated, "utf8");

    const taskId = "HYK-227-C-1";
    initAndAdmit(ledger, lock, taskId);
    writeFixture(
      harnessDir,
      "coder",
      taskId,
      "2026-08-11 06:00 KST",
      "2026-08-11 06:10 KST",
    );

    const mod = await import(
      `file://${join(checkDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = await withEnv(
      { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
      () => mod.checkRelayHandshake({ role: "coder", harnessDir }),
    );

    assert.equal(
      result.ok,
      true,
      "mutation must not touch the handshake decision itself -- only the completion side effect",
    );
    assert.equal(
      readStatus(ledger, taskId),
      "ACTIVE",
      "RED: with the call site removed, a passing handshake no longer releases the reservation -- the exact regression this obligation must catch",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    // 원복 증명: 실제 저장소 파일은 메모리에서 읽기만 했을 뿐 한 번도
    // 쓰기 대상이 아니었다 -- 이 시험 실행 전후로 바이트 단위 동일해야
    // 한다. (git HEAD와의 diff는 쓰지 않는다: 이 라운드 자체가 아직
    // 커밋되지 않은 §2 결선 수정을 이미 갖고 있어 HEAD 비교는 그 정당한
    // 수정까지 "오염"으로 오판한다 -- 실측 대상은 "이 시험이 건드렸는가"
    // 이지 "커밋 전인가"가 아니다.)
    const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test -- it only ever mutated an in-memory string and a tmp-dir copy",
    );
  }
});

// ---------------------------------------------------------------------------
// ⓓ 오탐 분모: 정상 흐름(=핸드셰이크가 ok:false로 끝나는) 표본 최소 3개가
// ACTIVE 예약을 잘못 반납하지 않는지. 조건이 서로 다른 3가지 실패 사유를
// 쓴다 -- 1건으로 일반화하지 않는다(HYK-225-5R §1-1이 이미 pin한 mismatch
// 사례와 겹치지 않는 두 사례를 추가).
// ---------------------------------------------------------------------------

test("ⓓ 오탐 분모 (N=3): three distinct ok:false handshake shapes never release the ACTIVE reservation", () => {
  const samples = [
    {
      label: "task_id mismatch",
      write: (dir, taskId) => {
        writeFileSync(
          join(dir, "coder-task.md"),
          `task_id: ${taskId}\ndropped_at: 2026-08-11 06:00 KST\n`,
          "utf8",
        );
        writeFileSync(
          join(dir, "coder.md"),
          `task_id: WRONG-ID\n\n>>> DONE: CODER @ 2026-08-11 06:10 KST\n`,
          "utf8",
        );
      },
    },
    {
      label: "no DONE line yet (still pending)",
      write: (dir, taskId) => {
        writeFileSync(
          join(dir, "coder-task.md"),
          `task_id: ${taskId}\ndropped_at: 2026-08-11 06:00 KST\n`,
          "utf8",
        );
        writeFileSync(
          join(dir, "coder.md"),
          `task_id: ${taskId}\n\nstill working\n`,
          "utf8",
        );
      },
    },
    {
      label: "stale: DONE predates dropped_at",
      write: (dir, taskId) => {
        writeFileSync(
          join(dir, "coder-task.md"),
          `task_id: ${taskId}\ndropped_at: 2026-08-11 10:00 KST\n`,
          "utf8",
        );
        writeFileSync(
          join(dir, "coder.md"),
          `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-11 06:10 KST\n`,
          "utf8",
        );
      },
    },
  ];

  for (const sample of samples) {
    const harnessDir = tmpDir("hyk227-d-harness-");
    const ledgerDir = tmpDir("hyk227-d-ledger-");
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    try {
      const taskId = `HYK-227-D-${sample.label.slice(0, 4)}`;
      initAndAdmit(ledger, lock, taskId);
      sample.write(harnessDir, taskId);

      const result = withEnv(
        { ADMISSION_LEDGER_PATH: ledger, ADMISSION_LOCK_PATH: lock },
        () => checkRelayHandshake({ role: "coder", harnessDir }),
      );
      assert.equal(
        result.ok,
        false,
        `sample "${sample.label}" must be a genuine ok:false shape`,
      );
      assert.equal(
        readStatus(ledger, taskId),
        "ACTIVE",
        `false-positive: sample "${sample.label}" must NOT release the reservation`,
      );
    } finally {
      rmSync(harnessDir, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  }
});
