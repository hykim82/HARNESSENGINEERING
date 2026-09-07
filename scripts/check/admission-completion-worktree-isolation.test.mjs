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
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- carry the marker so
    // this shared fixture keeps exercising the admission-completion
    // worktree-isolation wiring under test, not this promotion's rejection.
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
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

// HYK-398 §2-⑶: quality-check max-lines-per-function 상한을 지키려고 이
// 시험 몸통에서 뽑았다(HYK-244-receipt-core-1b 선례와 동일한 이유, 시험
// 대상/단언은 조금도 바뀌지 않는다) -- admission-completion-adapter.mjs가
// 정적 import하는 형제 파일(admission-ledger-core.mjs·admission-ledger-
// store.mjs·ledger-pointer-shared.mjs·retirement-record-core.mjs)을
// 격리 픽스처 안에 그대로 복사한다.
function stageAdapterSiblingDeps(checkDir, supervisorDir) {
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
  // HYK-302/355 §2-A dedup / HYK-398 §2-⑶: the adapter now also statically
  // imports these two.
  for (const name of [
    "ledger-pointer-shared.mjs",
    "retirement-record-core.mjs",
  ]) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
}

// HYK-437 §2⑵ 갱신: 이 시험은 이 라운드 이전에는 harnessDir 자체가
// mainRepoRoot() 해석에 전혀 관여하지 않았으므로(스폰 cwd=repoDir가 항상
// 이겼다), scratchHarness에 포인터 파일이 없어도 게이트만 지우면 repoDir의
// 포인터로 새는 것으로 충분히 재현됐다. HYK-437이 그 ambient-cwd 경로
// 자체를 막았으므로(resolvePersistentLedgerPaths가 이제 harnessDir을
// 앵커로 삼는다), 같은 변이(게이트 제거)로 ⓐ가 다시 새려면 scratchHarness
// «자신»이 (2026-08-19 사고의 실제 모양 -- `.harness` 통째 복사본이 우연히
// 예전 포인터 파일까지 함께 담고 있던 경우처럼) 자기 포인터 파일을 갖고
// 있어야 한다. 이 갱신은 게이트가 여전히 독자적으로 부담을 지는(load-
// bearing) 시나리오를 정확히 다시 만든다 -- 게이트 없이는 그 카피 안의
// 포인터가 카피 자신의 ledger를 새로 가리키는 경우까지 막을 길이 없다.
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
    stageAdapterSiblingDeps(checkDir, supervisorDir);
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-312-RED-MUTANT");
    writePointerFile(repoDir, ledger, lock);
    // HYK-437 §2⑵: scratchHarness now also carries its OWN copy of the
    // pointer file (mirrors the 2026-08-19 incident's actual shape -- a
    // wholesale `.harness` copy) so that, once the anchor fix resolves
    // mainRepoRoot() off harnessDir itself, this copy is what the isolation
    // gate alone still has to block.
    mkdirSync(join(scratchHarness, ".harness"), { recursive: true });
    writePointerFile(scratchHarness, ledger, lock);
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

// ---------------------------------------------------------------------------
// ⓔ HYK-437 §2⑴/⑵ -- «검사는 B를 보고 쓰기는 A로 간다». harnessDir이 (ⓐ와
// 달리) 진짜 git worktree일 때도 새는 잔존 축: `isInsideGitWorktree(harnessDir)`
// 는 harnessDir 자체가 어떤 worktree인지만 확인하고, 그 뒤
// resolvePersistentLedgerPaths()가 실제로 어느 저장소의 포인터 파일을
// 읽는지는 확인하지 않았다 -- HYK-437 이전에는 `mainRepoRoot()`가 인자
// 없이 이 프로세스 자신의(=스폰 호출부의 ambient cwd) 저장소로 풀렸다.
// 독립 재현: 서로 다른 두 합성 `git init` 저장소 A(스폰 cwd)·B(harnessDir),
// 각자 자기 포인터 파일 + 자기 원장(같은 reservationId 로 admit)을 가진다.
// ---------------------------------------------------------------------------

test("ⓔ HYK-437: two independent git worktrees (A=spawn cwd, B=harnessDir) each with their own pointer+ledger -- completion must land in B's ledger (the one actually consumed), A's must stay byte-identical", () => {
  const repoA = buildSyntheticRepo("hyk437-e-repoA-");
  const repoB = buildSyntheticRepo("hyk437-e-repoB-");
  const ledgerDirA = tmpDir("hyk437-e-ledgerA-");
  const ledgerDirB = tmpDir("hyk437-e-ledgerB-");
  try {
    const ledgerA = join(ledgerDirA, "l.json");
    const lockA = join(ledgerDirA, "l.lock");
    const ledgerB = join(ledgerDirB, "l.json");
    const lockB = join(ledgerDirB, "l.lock");
    // Same reservationId admitted in BOTH ledgers -- this is what makes a
    // silent wrong-ledger write undetectable by exit code/stdout alone: both
    // releases "succeed", only the WHICH ledger changed differs.
    initAndAdmit(ledgerA, lockA, "HYK-437-E-CROSS");
    initAndAdmit(ledgerB, lockB, "HYK-437-E-CROSS");
    writePointerFile(repoA, ledgerA, lockA);
    writePointerFile(repoB, ledgerB, lockB);
    const beforeA = readFileSync(ledgerA, "utf8");

    const { exit, stdout } = runAdapterCli(["HYK-437-E-CROSS", repoB], {
      cwd: repoA,
      env: envWithoutNodeTestContext(),
    });

    assert.equal(exit, 0, `release should succeed: ${stdout}`);
    assert.match(stdout, /released/);
    assert.equal(
      readStatus(ledgerB, "HYK-437-E-CROSS"),
      "COMPLETED",
      "B's ledger (the harnessDir actually consumed) must be the one released",
    );
    assert.equal(
      readStatus(ledgerA, "HYK-437-E-CROSS"),
      "ACTIVE",
      "A's ledger (an unrelated worktree that merely happened to be the spawn cwd) must stay untouched",
    );
    assert.equal(
      readFileSync(ledgerA, "utf8"),
      beforeA,
      "byte-identical -- zero mutation of the unrelated worktree's ledger",
    );
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    rmSync(ledgerDirA, { recursive: true, force: true });
    rmSync(ledgerDirB, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓔ-2 HYK-437 §3 완료조건4 -- 정상 경로가 산다: 진짜 linked worktree
// (`git worktree add`)의 정당한 admission 기록은, 스폰 프로세스의 ambient
// cwd가 그 worktree와 무관한(포인터도 없는) 별개 디렉터리여도 여전히
// main 저장소의 중앙 원장에 남는다 -- mainRepoRoot(harnessDir)가
// `git rev-parse --git-common-dir`로 linked worktree에서도 올바른 main
// 저장소를 찾아내는지 확인한다(단순 `--show-toplevel`이었다면 linked
// worktree 자신의 디렉터리를 잘못 반환했을 것).
// ---------------------------------------------------------------------------

test("ⓔ-2 HYK-437: a real linked worktree's admission release still reaches the MAIN repo's pointer/ledger, even when the spawn process's own ambient cwd is a plain unrelated directory", () => {
  const mainRepo = buildSyntheticRepo("hyk437-e2-main-");
  const ledgerDir = tmpDir("hyk437-e2-ledger-");
  const unrelatedCwd = tmpDir("hyk437-e2-unrelated-cwd-");
  let linkedDir;
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-437-E2-LINKED");
    writePointerFile(mainRepo, ledger, lock);

    const branch = `hyk437-e2-${process.pid}-${Date.now()}`;
    linkedDir = tmpDir("hyk437-e2-linked-");
    rmSync(linkedDir, { recursive: true, force: true });
    execSync(`git worktree add -q -b ${branch} "${linkedDir}"`, {
      cwd: mainRepo,
    });
    mkdirSync(join(linkedDir, ".harness"), { recursive: true });

    // `unrelatedCwd` is a PLAIN (non-git) directory -- proves resolution is
    // anchored at harnessDir (the linked worktree), never at the spawning
    // process's own ambient cwd.
    const { exit, stdout } = runAdapterCli(["HYK-437-E2-LINKED", linkedDir], {
      cwd: unrelatedCwd,
      env: envWithoutNodeTestContext(),
    });

    assert.equal(exit, 0, `release should succeed: ${stdout}`);
    assert.equal(
      readStatus(ledger, "HYK-437-E2-LINKED"),
      "COMPLETED",
      "a genuine linked worktree must still reach the main repo's central ledger via its pointer file",
    );
  } finally {
    if (linkedDir) {
      try {
        execSync(`git worktree remove --force "${linkedDir}"`, {
          cwd: mainRepo,
        });
      } catch {
        rmSync(linkedDir, { recursive: true, force: true });
      }
    }
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓔ-RED HYK-437 -- ⓔ가 실제로 이 라운드의 수정에 걸려 있음을 소스 치환
// 변이로 증명한다: `resolvePersistentLedgerPaths(harnessDir)` 호출부를
// 무인자 호출로 되돌리면 ⓔ의 관측(정확히 B가 풀린다)이 다시 A로 샌다.
// 원복 증명은 실제 파일이 시험 전후 바이트 동일한지로 한다(이 파일의
// 앞선 RED 시험과 동일한 방식).
// ---------------------------------------------------------------------------

test("ⓔ-RED HYK-437: reverting the resolvePersistentLedgerPaths(harnessDir) call site to the no-arg form makes ⓔ's observation go RED (release lands back in A, the ambient-cwd repo, not B), and the real source is provably untouched", () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const target =
    "    const persistent = resolvePersistentLedgerPaths(harnessDir);";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "resolvePersistentLedgerPaths(harnessDir) call site" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(
    target,
    "    const persistent = resolvePersistentLedgerPaths();",
  );

  const repoA = buildSyntheticRepo("hyk437-ered-repoA-");
  const repoB = buildSyntheticRepo("hyk437-ered-repoB-");
  const ledgerDirA = tmpDir("hyk437-ered-ledgerA-");
  const ledgerDirB = tmpDir("hyk437-ered-ledgerB-");
  const checkDir = join(repoA, "scripts", "check");
  const supervisorDir = join(repoA, "scripts", "supervisor");
  const mutatedFilePath = join(checkDir, "admission-completion-adapter.mjs");
  try {
    stageAdapterSiblingDeps(checkDir, supervisorDir);
    const ledgerA = join(ledgerDirA, "l.json");
    const lockA = join(ledgerDirA, "l.lock");
    const ledgerB = join(ledgerDirB, "l.json");
    const lockB = join(ledgerDirB, "l.lock");
    initAndAdmit(ledgerA, lockA, "HYK-437-ERED-CROSS");
    initAndAdmit(ledgerB, lockB, "HYK-437-ERED-CROSS");
    writePointerFile(repoA, ledgerA, lockA);
    writePointerFile(repoB, ledgerB, lockB);
    writeFileSync(mutatedFilePath, mutated, "utf8");

    const { exit, stdout } = runChild(
      mutatedFilePath,
      ["HYK-437-ERED-CROSS", repoB],
      { cwd: repoA, env: envWithoutNodeTestContext() },
    );

    assert.equal(exit, 0, `release should succeed: ${stdout}`);
    assert.equal(
      readStatus(ledgerA, "HYK-437-ERED-CROSS"),
      "COMPLETED",
      "RED: with the harnessDir anchor reverted, the mutant resolves off the spawn process's ambient cwd (repoA) again -- the exact 2026-09-04 regression this obligation must catch",
    );
    assert.equal(
      readStatus(ledgerB, "HYK-437-ERED-CROSS"),
      "ACTIVE",
      "RED corroboration: B's ledger (the harnessDir actually consumed) never gets released",
    );
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    rmSync(ledgerDirA, { recursive: true, force: true });
    rmSync(ledgerDirB, { recursive: true, force: true });
    const after = readFileSync(ADAPTER_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명: the real admission-completion-adapter.mjs must be byte-identical before/after this test",
    );
  }
});
