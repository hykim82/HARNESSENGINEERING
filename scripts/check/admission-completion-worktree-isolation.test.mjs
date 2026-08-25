// HYK-312 §1 -- pins the fix for the 2026-08-19 오전 실사고: ORCH ran the
// production CLI entry point (`relay-handshake.mjs CODER <scratch-copy-of-
// .harness>`) from inside the real repo checkout. The admission-completion
// adapter's persistent-pointer fallback resolves `mainRepoRoot()` off THIS
// PROCESS'S cwd, not off the round directory actually being consumed -- so
// it found the real repo's pointer file and mutated the REAL global ledger,
// even though the `.harness` being consumed was a plain filesystem copy
// outside any git worktree.
//
// admission-completion-adapter.mjs's `autoCompleteAdmission` now accepts an
// optional `harnessDir` and refuses (exit != 0 + reason, not a silent
// no-op) the persistent-pointer fallback whenever harnessDir is given and is
// NOT itself inside a registered git worktree (`isInsideGitWorktree`, see
// that file's own header for the full rationale + honesty limit: a
// deliberate separate git clone still passes this gate).
//
// ⛔ 실제 관제실 원장(admission-ledger.json) 무접촉 -- every ledger below is
// a mkdtemp synthetic fixture. Every test spawns the REAL production CLI
// entry points (`relay-handshake.mjs`, `admission-completion-adapter.mjs`)
// as child processes (coder-task.md §4 요구: "코어 함수 import 흉내는 이
// 라운드의 결선을 안 태운다") -- never a copy, never an import-level stand-in
// for the wiring itself.
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
import { execSync, spawnSync } from "node:child_process";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = join(CHECK_DIR, "admission-completion-adapter.mjs");
const RELAY_CLI_PATH = join(CHECK_DIR, "relay-handshake.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// buildSyntheticRepo -- a real (mkdtemp + `git init`) git repo standing in
// for "the real HARNESSENGINEERING checkout ORCH ran the command from",
// never the genuine repo or its genuine `.harness/`.
function buildSyntheticRepo(prefix) {
  const dir = tmpDir(prefix);
  execSync("git init -q", { cwd: dir });
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

function writePointerFile(repoDir, ledgerPath, lockPath) {
  writeFileSync(
    join(repoDir, ".harness", "admission-ledger-path.json"),
    JSON.stringify({ ledgerPath, lockPath }),
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

function writeCoderFixture(harnessDir, taskId) {
  writeFileSync(
    join(harnessDir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: 2026-08-19 06:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 06:10:00 KST\n`,
    "utf8",
  );
}

// buildEnv -- shallow-copies process.env then applies overrides; a value of
// `undefined` deletes the key outright (spawnSync rejects literal
// `undefined` env values, so this is not just a convenience).
function buildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// envWithoutNodeTestContext -- simulates a genuine production/experiment
// invocation (never under `node --test`), which is exactly the shape the
// 2026-08-19 incident took. Always strips ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH too unless the test explicitly re-supplies them, so no
// ambient env from the outer `node --test` run can leak in.
function envWithoutNodeTestContext(overrides = {}) {
  return buildEnv({
    NODE_TEST_CONTEXT: undefined,
    ADMISSION_LEDGER_PATH: undefined,
    ADMISSION_LOCK_PATH: undefined,
    ...overrides,
  });
}

function runChild(scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
  if (res.error) {
    assert.fail(
      `child process failed to spawn (infra failure, not a contract signal): ${res.error.message}`,
    );
  }
  if (res.status === null) {
    assert.fail(
      `child process terminated by signal ${res.signal} (infra failure, not a contract signal)`,
    );
  }
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runAdapterCli(args, opts = {}) {
  return runChild(ADAPTER_PATH, args, opts);
}

function runRelayCli(args, opts = {}) {
  return runChild(RELAY_CLI_PATH, args, opts);
}

// ---------------------------------------------------------------------------
// ⓐ 재현 시험 (직접 어댑터 CLI) -- 오늘 사고의 핵심 결함을 가장 좁게 잡는다:
// 저장소 밖(비-git) harnessDir + 격리 env 없음 -> 거부(exit != 0) + 실물
// 대역 원장(포인터가 가리키는 합성 ledger) 무변동.
// ---------------------------------------------------------------------------

test("ⓐ HYK-312: unisolated harnessDir (plain, non-git scratch copy) -> adapter REJECTS (exit != 0, reason on stderr), pointer-file ledger untouched", () => {
  const repoDir = buildSyntheticRepo("hyk312-a-repo-");
  const ledgerDir = tmpDir("hyk312-a-ledger-");
  const scratchHarness = tmpDir("hyk312-a-scratch-harness-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-ISO-A");
    writePointerFile(repoDir, ledger, lock);
    const before = readFileSync(ledger, "utf8");

    const { exit, stderr } = runAdapterCli(["HYK-312-ISO-A", scratchHarness], {
      cwd: repoDir,
      env: envWithoutNodeTestContext(),
    });

    assert.notEqual(
      exit,
      0,
      "must exit nonzero -- a refusal (거부), not the pre-existing silent no-op",
    );
    assert.match(
      stderr,
      /not inside a registered git worktree/,
      "the reason must name the actual gate that fired",
    );
    assert.equal(
      readStatus(ledger, "HYK-312-ISO-A"),
      "ACTIVE",
      "the real-repo pointer's ledger must be untouched",
    );
    assert.equal(
      readFileSync(ledger, "utf8"),
      before,
      "byte-identical before/after -- zero mutation, not merely 'same status'",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(scratchHarness, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓐ-2 재현 시험 (전체 결선, relay-handshake.mjs CLI) -- ORCH의 실제 사고
// 명령형을 그대로: `node relay-handshake.mjs CODER <scratch-copy>`, cwd=
// (합성) 실제 저장소. 라운드 자체(handshake)는 정상이므로 exit 0으로
// 완료돼야 하지만(§3-1 비타협), 부수효과(admission 반납)는 거부되고 그
// 이유가 stderr에 드러나야 한다.
// ---------------------------------------------------------------------------

// HYK-344 2R/3R 갱신: 이 시험의 원래 이름/기대값은 "round still completes"
// (exit 0)였다. 그 판단(라운드 자체는 원장 인프라 도달성과 무관하게
// 완료해야 한다)은 지금도 유효하다 -- 다만 그 완료 «직후» admission
// 완료가 실제로 시도됐다가 거부됐다는 사실(이 경우 UNISOLATED_HARNESS_DIR
// 안전핀 발동)은 이제 exit 3으로 구별 가능하게 표면화된다(HYK-344 2R,
// review-r1-verbatim.md §A P1 반려 -> 3R 채택). 라운드 판정(task_id
// 결속·staleness) 자체가 실패한 게 아니므로 exit 1은 아니고, 원장
// 반납이 안전핀에 의해 거부된 채로 조용히 exit 0을 내지도 않는다 --
// 정확히 이 시험이 검증하려는 "안전핀이 실제로 발동했다"는 사실 자체가
// 이제 exit code에도 반영된다.
test("ⓐ-2 HYK-312: relay-handshake.mjs CLI consuming a scratch (non-worktree) harnessDir -- round's own binding is valid but admission side-effect refuses (HYK-344 2R/3R: now surfaced as exit 3, not silently 0), ledger untouched", () => {
  const repoDir = buildSyntheticRepo("hyk312-a2-repo-");
  const ledgerDir = tmpDir("hyk312-a2-ledger-");
  const scratchHarness = tmpDir("hyk312-a2-scratch-harness-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-WIRE-A");
    writePointerFile(repoDir, ledger, lock);
    writeCoderFixture(scratchHarness, "HYK-312-WIRE-A");
    const before = readFileSync(ledger, "utf8");

    const { exit, stderr } = runRelayCli(["coder", scratchHarness], {
      cwd: repoDir,
      env: envWithoutNodeTestContext(),
    });

    assert.equal(
      exit,
      3,
      "HYK-344 2R/3R: the round's own task_id/staleness handshake is valid (not exit 1), but the admission side-effect was genuinely attempted and refused by the HYK-312 safety pin -- that is now surfaced as exit 3, distinct from a clean exit 0",
    );
    assert.match(
      stderr,
      /not inside a registered git worktree/,
      "the admission spawn's refusal reason must surface on stderr (non-fatal to the handshake's own exit code, by design)",
    );
    assert.equal(
      readStatus(ledger, "HYK-312-WIRE-A"),
      "ACTIVE",
      "HYK-312 §1 invariant: a scratch-copy consumption must never mutate the real-repo pointer's ledger",
    );
    assert.equal(
      readFileSync(ledger, "utf8"),
      before,
      "byte-identical -- zero mutation",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(scratchHarness, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓑ 정상 프로덕션 회귀 -- 진짜 워크트리 형태(harnessDir가 그 저장소 안)의
// 정상 소비는 예약 해제가 여전히 동작해야 한다(§3-1).
// ---------------------------------------------------------------------------

test("ⓑ HYK-312: production regression -- a real worktree's .harness still releases the reservation via the persistent pointer", () => {
  const repoDir = buildSyntheticRepo("hyk312-b-repo-");
  const ledgerDir = tmpDir("hyk312-b-ledger-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-PROD-B");
    writePointerFile(repoDir, ledger, lock);
    const harnessDir = join(repoDir, ".harness");
    writeCoderFixture(harnessDir, "HYK-312-PROD-B");

    const { exit, stdout } = runRelayCli(["coder", harnessDir], {
      cwd: repoDir,
      env: envWithoutNodeTestContext(),
    });

    assert.equal(exit, 0, `round must complete: ${stdout}`);
    assert.equal(
      readStatus(ledger, "HYK-312-PROD-B"),
      "COMPLETED",
      "a real worktree's .harness must still reach the persistent-pointer release path",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ 명시 격리를 준 경우 -- ADMISSION_LEDGER_PATH가 있으면 harnessDir이
// 비-워크트리여도 막히면 안 된다(그게 "설계된 문", coder-task §4 ⓒ).
// ---------------------------------------------------------------------------

test("ⓒ HYK-312: explicit ADMISSION_LEDGER_PATH always wins, even for a scratch (non-worktree) harnessDir", () => {
  const ledgerDir = tmpDir("hyk312-c-ledger-");
  const scratchHarness = tmpDir("hyk312-c-scratch-harness-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-ENV-C");

    const { exit, stdout } = runAdapterCli(["HYK-312-ENV-C", scratchHarness], {
      env: envWithoutNodeTestContext({
        ADMISSION_LEDGER_PATH: ledger,
        ADMISSION_LOCK_PATH: lock,
      }),
    });

    assert.equal(exit, 0, `explicit env must never be blocked: ${stdout}`);
    assert.match(stdout, /released/);
    assert.equal(readStatus(ledger, "HYK-312-ENV-C"), "COMPLETED");
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(scratchHarness, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓓ NODE_TEST_CONTEXT 회귀 -- 기존에 막히던 경로(§3-2)는 harnessDir 격리
// 여부와 무관하게 여전히 «조용한 no-op»(attempted:false, exit 0)이어야
// 한다. 이 새 게이트가 그 기존 문면/exit code를 바꾸면 반려감이다.
// ---------------------------------------------------------------------------

test("ⓓ HYK-312: NODE_TEST_CONTEXT still blocks the persistent fallback the exact pre-existing way, regardless of harnessDir isolation", () => {
  const repoDir = buildSyntheticRepo("hyk312-d-repo-");
  const ledgerDir = tmpDir("hyk312-d-ledger-");
  const scratchHarness = tmpDir("hyk312-d-scratch-harness-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-NTC-D");
    writePointerFile(repoDir, ledger, lock);

    const { exit, stdout } = runAdapterCli(["HYK-312-NTC-D", scratchHarness], {
      cwd: repoDir,
      env: envWithoutNodeTestContext({ NODE_TEST_CONTEXT: "1" }),
    });

    assert.equal(
      exit,
      0,
      "pre-existing NODE_TEST_CONTEXT no-op must stay exit 0",
    );
    assert.match(
      stdout,
      /admission-completion-adapter: not attempted \(ADMISSION_LEDGER_PATH unset\)/,
      "must be the exact pre-existing message, byte-for-byte (§3-2)",
    );
    assert.equal(
      readStatus(ledger, "HYK-312-NTC-D"),
      "ACTIVE",
      "untouched, exactly as before this round",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(scratchHarness, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (선택) RED 변이 -- harnessDir 격리 게이트 한 줄을 지우면 ⓐ가 다시 새는지.
// admission-completion-persistent-source.test.mjs ⓓ와 동일한 방식(소스
// 문자열 치환 + 동적 import), 원복 증명 포함.
// ---------------------------------------------------------------------------

test("RED 변이: removing the harnessDir isolation gate from autoCompleteAdmission -> ⓐ's blocked case goes RED (mutates the real global ledger's synthetic stand-in), and the real source is provably untouched", async () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const target = `  if (
    !ledgerPath &&
    harnessDir &&
    persistentFallbackAllowed() &&
    !isInsideGitWorktree(harnessDir)
  ) {
    return {
      attempted: false,
      blocked: true,
      reasonCode: "UNISOLATED_HARNESS_DIR",
      reason: \`admission-completion-adapter: refusing persistent-pointer fallback -- harnessDir '\${harnessDir}' is not inside a registered git worktree (test/experiment consumption context without an explicit ADMISSION_LEDGER_PATH) -- see HYK-312\`,
    };
  }
`;
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "harnessDir isolation gate" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, "");

  const repoDir = buildSyntheticRepo("hyk312-red-repo-");
  const ledgerDir = tmpDir("hyk312-red-ledger-");
  const scratchHarness = tmpDir("hyk312-red-scratch-harness-");
  const checkDir = join(repoDir, "scripts", "check");
  const supervisorDir = join(repoDir, "scripts", "supervisor");
  const mutatedFilePath = join(checkDir, "admission-completion-adapter.mjs");
  try {
    mkdirSync(checkDir, { recursive: true });
    mkdirSync(supervisorDir, { recursive: true });
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
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-RED-MUTANT");
    writePointerFile(repoDir, ledger, lock);
    writeFileSync(mutatedFilePath, mutated, "utf8");

    const { exit, stdout } = runChild(
      mutatedFilePath,
      ["HYK-312-RED-MUTANT", scratchHarness],
      { cwd: repoDir, env: envWithoutNodeTestContext() },
    );

    assert.equal(
      exit,
      0,
      "RED: with the isolation gate removed, the mutant no longer refuses a scratch (non-worktree) harnessDir -- it proceeds to the persistent pointer",
    );
    assert.match(stdout, /released/);
    assert.equal(
      readStatus(ledger, "HYK-312-RED-MUTANT"),
      "COMPLETED",
      "RED corroboration: without the gate, the exact scratch-copy shape from the 2026-08-19 incident mutates the pointer's ledger again",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(scratchHarness, { recursive: true, force: true });
    const after = readFileSync(ADAPTER_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명: the real admission-completion-adapter.mjs must be byte-identical before/after this test",
    );
  }
});
