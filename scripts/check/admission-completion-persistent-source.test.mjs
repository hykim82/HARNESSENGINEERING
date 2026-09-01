// HYK-227 2R §4 -- pins the "env-priority + persistent fallback" 2-tier
// resolution `admission-completion-adapter.mjs`'s `autoCompleteAdmission`
// now does (see that file's own header for the full rationale + §2-4's
// honesty limit: this is NOT "env got injected", it is a second, distinct
// resolution source layered underneath the unchanged env-priority path).
//
// ⛔ 실제 관제실 원장(admission-ledger.json) 무접촉 -- 모든 원장은 mkdtemp
// 합성 픽스처다. ★resolvePersistentLedgerPaths()는 mainRepoRoot()를 통해
// "현재 git 저장소"를 읽으므로, 매 시험은 process.cwd()를 합성 git 저장소
// 안으로 임시 이동시킨다(finally에서 반드시 원복).
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

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// buildSyntheticRepo -- a real (mkdtemp) git repo with a `.harness/` dir,
// so mainRepoRoot() (git rev-parse --show-toplevel / --git-common-dir) has
// something real to resolve to when process.cwd() is inside it. Never the
// real HARNESSENGINEERING repo, never the real control room.
function buildSyntheticRepo(prefix) {
  const dir = tmpDir(prefix);
  execSync("git init -q", { cwd: dir });
  // A repo-local identity is not needed here (no commits made), only a
  // valid `.git` directory for rev-parse to find.
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

function writePointerFile(repoDir, ledgerPath, lockPath) {
  const body = { ledgerPath };
  if (lockPath !== undefined) body.lockPath = lockPath;
  writeFileSync(
    join(repoDir, ".harness", "admission-ledger-path.json"),
    JSON.stringify(body),
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

// withSyntheticRepoCwd -- runs `fn` with process.cwd() pointed at a
// synthetic git repo (so mainRepoRoot()'s ambient git calls resolve there,
// not the real HARNESSENGINEERING checkout), restoring the real cwd
// afterward no matter what fn does.
async function withSyntheticRepoCwd(repoDir, fn) {
  const realCwd = process.cwd();
  process.chdir(repoDir);
  try {
    return await fn();
  } finally {
    process.chdir(realCwd);
  }
}

function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  Object.assign(process.env, overrides);
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const key of Object.keys(overrides)) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  })();
}

// withoutNodeTestContext -- HYK-289: admission-completion-adapter.mjs's
// autoCompleteAdmission now gates the persistent-pointer branch behind
// `!process.env.NODE_TEST_CONTEXT` (that file's own persistentFallbackAllowed,
// see its header comment for the full leak this closes). `node --test`
// itself sets NODE_TEST_CONTEXT on this very process (confirmed empirically:
// a plain `node foo.mjs` never has it), so every test below that wants to
// exercise the genuine "persistent pointer resolves" contract (ⓑ/ⓑ-2/ⓓ, and
// two of ⓔ's samples) must delete it for the duration of that one call --
// otherwise this file's own `node --test` runner would make the branch
// under test unreachable, which is a test-harness artifact, not the
// production behavior being pinned (a real in-process caller like
// checkRelayHandshake, imported by scripts/relay/watch-result.mjs etc.,
// never runs under `node --test`, so it never has this var either).
async function withoutNodeTestContext(fn) {
  const prior = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    if (prior !== undefined) process.env.NODE_TEST_CONTEXT = prior;
  }
}

async function importFreshAdapter(pathOverride = ADAPTER_PATH) {
  return import(`file://${pathOverride}?t=${Math.random()}`);
}

// ---------------------------------------------------------------------------
// ⓐ env 있음 -> env 경로 사용 (우선순위 증명: 영속값이 있어도 env 가 이긴다)
// ---------------------------------------------------------------------------

test("ⓐ env present + persistent also present -> env path wins (priority proof)", async () => {
  const repoDir = buildSyntheticRepo("hyk227-2r-a-repo-");
  const envLedgerDir = tmpDir("hyk227-2r-a-env-ledger-");
  const persistentLedgerDir = tmpDir("hyk227-2r-a-persist-ledger-");
  try {
    const envLedger = join(envLedgerDir, "l.json");
    const envLock = join(envLedgerDir, "l.lock");
    const persistLedger = join(persistentLedgerDir, "l.json");
    const persistLock = join(persistentLedgerDir, "l.lock");

    initAndAdmit(envLedger, envLock, "HYK-227-A-ENV");
    initAndAdmit(persistLedger, persistLock, "HYK-227-A-ENV"); // same id, different ledger
    writePointerFile(repoDir, persistLedger, persistLock);

    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, () =>
      withEnv(
        { ADMISSION_LEDGER_PATH: envLedger, ADMISSION_LOCK_PATH: envLock },
        () => autoCompleteAdmission({ reservationId: "HYK-227-A-ENV" }),
      ),
    );

    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true);
    assert.equal(
      readStatus(envLedger, "HYK-227-A-ENV"),
      "COMPLETED",
      "env ledger must be the one that got released",
    );
    assert.equal(
      readStatus(persistLedger, "HYK-227-A-ENV"),
      "ACTIVE",
      "the persistent-pointer ledger must be UNTOUCHED -- env must win outright, not merge",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(envLedgerDir, { recursive: true, force: true });
    rmSync(persistentLedgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓑ env 없음 + 영속값 있음 -> 영속값 사용 (★이번 라운드의 핵심)
// ---------------------------------------------------------------------------

test("ⓑ env absent + persistent pointer present -> persistent path is used (this round's core case)", async () => {
  const repoDir = buildSyntheticRepo("hyk227-2r-b-repo-");
  const ledgerDir = tmpDir("hyk227-2r-b-ledger-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-227-B-PERSIST");
    writePointerFile(repoDir, ledger, lock);

    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, () =>
      withoutNodeTestContext(async () => {
        delete process.env.ADMISSION_LEDGER_PATH;
        delete process.env.ADMISSION_LOCK_PATH;
        return autoCompleteAdmission({ reservationId: "HYK-227-B-PERSIST" });
      }),
    );

    assert.equal(
      outcome.attempted,
      true,
      "must actually attempt via the persistent pointer",
    );
    assert.equal(outcome.ok, true, `release should succeed: ${outcome.reason}`);
    assert.equal(readStatus(ledger, "HYK-227-B-PERSIST"), "COMPLETED");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("ⓑ-2: persistent pointer's own lockPath is honored when env supplies neither", async () => {
  const repoDir = buildSyntheticRepo("hyk227-2r-b2-repo-");
  const ledgerDir = tmpDir("hyk227-2r-b2-ledger-");
  try {
    // Lock path deliberately does NOT follow the `${ledgerPath}.lock`
    // convention -- proves the pointer file's own lockPath field is read,
    // not just derived from ledgerPath.
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "custom-lock-name.lock");
    initAndAdmit(ledger, lock, "HYK-227-B2-PERSIST");
    writePointerFile(repoDir, ledger, lock);

    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, () =>
      withoutNodeTestContext(async () => {
        delete process.env.ADMISSION_LEDGER_PATH;
        delete process.env.ADMISSION_LOCK_PATH;
        return autoCompleteAdmission({ reservationId: "HYK-227-B2-PERSIST" });
      }),
    );

    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true, `release should succeed: ${outcome.reason}`);
    assert.equal(readStatus(ledger, "HYK-227-B2-PERSIST"), "COMPLETED");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ 둘 다 없음 -> 기존 no-op 문면 그대로 (회귀 방지)
// ---------------------------------------------------------------------------

test("ⓒ neither env nor persistent pointer present -> the exact pre-existing no-op ({attempted:false}), unchanged", async () => {
  const repoDir = buildSyntheticRepo("hyk227-2r-c-repo-");
  try {
    // Deliberately no writePointerFile() call -- .harness/ exists but has
    // no admission-ledger-path.json.
    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, async () => {
      delete process.env.ADMISSION_LEDGER_PATH;
      delete process.env.ADMISSION_LOCK_PATH;
      return autoCompleteAdmission({ reservationId: "HYK-227-C-NOOP" });
    });
    assert.deepEqual(
      outcome,
      { attempted: false },
      "must be byte-for-byte the same shape 1R always returned -- no new keys, no new state",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("ⓒ-2: a malformed pointer file (invalid JSON) degrades to the same no-op, not a thrown error", async () => {
  const repoDir = buildSyntheticRepo("hyk227-2r-c2-repo-");
  try {
    writeFileSync(
      join(repoDir, ".harness", "admission-ledger-path.json"),
      "{ not valid json",
      "utf8",
    );
    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, async () => {
      delete process.env.ADMISSION_LEDGER_PATH;
      delete process.env.ADMISSION_LOCK_PATH;
      return autoCompleteAdmission({ reservationId: "HYK-227-C2-MALFORMED" });
    });
    assert.deepEqual(outcome, { attempted: false });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("ⓒ-3: a pointer file missing/blank ledgerPath degrades to the same no-op", async () => {
  const repoDir = buildSyntheticRepo("hyk227-2r-c3-repo-");
  try {
    writeFileSync(
      join(repoDir, ".harness", "admission-ledger-path.json"),
      JSON.stringify({ ledgerPath: "" }),
      "utf8",
    );
    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, async () => {
      delete process.env.ADMISSION_LEDGER_PATH;
      delete process.env.ADMISSION_LOCK_PATH;
      return autoCompleteAdmission({ reservationId: "HYK-227-C3-BLANK" });
    });
    assert.deepEqual(outcome, { attempted: false });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⓒ-4 HYK-302/355 §2-C («최소 요구»): ⓒ와 정확히 같은 입력(neither env nor
// persistent pointer present)이지만 NODE_TEST_CONTEXT까지 벗겨 "진짜 실
// 운영/실험 호출"을 흉내낸다 -- ⓒ 자신은 `node --test` 아래에서 도는 한
// NODE_TEST_CONTEXT가 항상 설정돼 있어 이 새 분기(persistentFallbackAllowed()
// ===true일 때만 발화)에 절대 닿지 않는다(§0 회귀 0: ⓒ는 그래서 여전히
// {attempted:false} 그대로 통과한다 -- 위 시험이 이미 그걸 증명한다). 이
// 시험이 바로 그 "닿는" 경우다.
// ---------------------------------------------------------------------------

test("ⓒ-4 HYK-302/355 §2-C: neither env nor persistent pointer present, AND not under node --test (real production/experiment shape) -> loud refusal (blocked:true), not the silent no-op", async () => {
  const repoDir = buildSyntheticRepo("hyk302-355-c4-repo-");
  try {
    // Deliberately no writePointerFile() call -- same premise as ⓒ.
    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, () =>
      withoutNodeTestContext(async () => {
        delete process.env.ADMISSION_LEDGER_PATH;
        delete process.env.ADMISSION_LOCK_PATH;
        return autoCompleteAdmission({ reservationId: "HYK-302-355-C4-LOUD" });
      }),
    );
    assert.equal(outcome.attempted, false);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reasonCode, "LEDGER_PATH_UNCONFIGURED");
    assert.match(outcome.reason, /^admission-completion-adapter: /);
    assert.match(
      outcome.reason,
      /ADMISSION_LEDGER_PATH/,
      "reason must name what to set -- '막다른 길 금지' (coder-task.md §2-C)",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("ⓒ-5 HYK-302/355 §2-C: the CLI entry point surfaces ⓒ-4's shape as exit 1 with the reason on stderr (mirrors HYK-312's own UNISOLATED_HARNESS_DIR blocked shape, an already-established channel)", () => {
  const repoDir = buildSyntheticRepo("hyk302-355-c5-repo-");
  try {
    const env = { ...process.env };
    delete env.ADMISSION_LEDGER_PATH;
    delete env.ADMISSION_LOCK_PATH;
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(
      process.execPath,
      [ADAPTER_PATH, "HYK-302-355-C5-LOUD"],
      { cwd: repoDir, env, encoding: "utf8" },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^admission-completion-adapter: /);
    assert.match(res.stderr, /ADMISSION_LEDGER_PATH/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("ⓒ-6 변이 RED: removing the persistentFallbackAllowed() guard from unconfiguredLedgerOutcome() makes ⓒ (node --test, no config) go RED (loud refusal fires even under node --test), and the real source is provably untouched", async () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const target = `function unconfiguredLedgerOutcome() {
  if (!persistentFallbackAllowed()) {
    return { attempted: false };
  }
  return {`;
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "§2-C persistentFallbackAllowed() guard" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(
    target,
    `function unconfiguredLedgerOutcome() {\n  return {`,
  );

  const repoDir = buildSyntheticRepo("hyk302-355-c6-repo-");
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
    writeFileSync(
      join(checkDir, "ledger-pointer-shared.mjs"),
      readFileSync(join(CHECK_DIR, "ledger-pointer-shared.mjs"), "utf8"),
      "utf8",
    );
    // HYK-398 §2-⑶: the adapter now also statically imports
    // "./retirement-record-core.mjs" (a zero-import core) -- same sibling
    // requirement as above.
    writeFileSync(
      join(checkDir, "retirement-record-core.mjs"),
      readFileSync(join(CHECK_DIR, "retirement-record-core.mjs"), "utf8"),
      "utf8",
    );
    writeFileSync(mutatedFilePath, mutated, "utf8");

    const mod = await import(`file://${mutatedFilePath}?t=${Math.random()}`);
    const outcome = await withSyntheticRepoCwd(repoDir, async () => {
      delete process.env.ADMISSION_LEDGER_PATH;
      delete process.env.ADMISSION_LOCK_PATH;
      return mod.autoCompleteAdmission({
        reservationId: "HYK-302-355-C6-MUTANT",
      });
    });

    assert.equal(
      outcome.blocked,
      true,
      "RED: with the guard removed, the loud refusal now fires even under node --test -- exactly the regression ⓒ/ⓒ-2/ⓒ-3 must catch",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    const after = readFileSync(ADAPTER_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명: the real admission-completion-adapter.mjs must be byte-identical before/after this test -- only an in-memory string and a tmp-dir copy were ever mutated",
    );
  }
});

// ---------------------------------------------------------------------------
// ⓓ 변이 RED -- 영속값 읽기를 지우면 ⓑ 가 RED. 원복 증명은 시험 실행 전후
// 실제 소스가 바이트 동일한지로 한다(1R의 ⓒ와 동일한 방식 -- 이 라운드
// 자체가 아직 커밋되지 않은 §3 수정을 이미 갖고 있어 `git diff` HEAD 비교는
// 그 정당한 수정까지 오염으로 오판하기 때문. 관련 근거는
// relay-handshake-completion-wire.test.mjs의 ⓒ 시험 주석 참고).
// ---------------------------------------------------------------------------

test("ⓓ 변이 RED: removing the persistent-fallback branch from autoCompleteAdmission -> ⓑ's case goes RED, and the real source is provably untouched", async () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const target = `  let persistentLockPath = null;
  if (!ledgerPath && persistentFallbackAllowed()) {
    const persistent = resolvePersistentLedgerPaths();
    if (persistent) {
      ledgerPath = persistent.ledgerPath;
      persistentLockPath = persistent.lockPath;
    }
  }
`;
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "persistent-fallback branch" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, "  const persistentLockPath = null;\n");

  const repoDir = buildSyntheticRepo("hyk227-2r-d-repo-");
  const ledgerDir = tmpDir("hyk227-2r-d-ledger-");
  // The adapter statically imports "../supervisor/admission-ledger-core.mjs",
  // "../supervisor/admission-ledger-store.mjs", and (HYK-302/355 §2-A dedup)
  // "./ledger-pointer-shared.mjs" -- the mutated copy needs those same
  // siblings at the same relative location to load at all.
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
    writeFileSync(
      join(checkDir, "ledger-pointer-shared.mjs"),
      readFileSync(join(CHECK_DIR, "ledger-pointer-shared.mjs"), "utf8"),
      "utf8",
    );
    // HYK-398 §2-⑶: the adapter now also statically imports
    // "./retirement-record-core.mjs" (a zero-import core) -- same sibling
    // requirement as above.
    writeFileSync(
      join(checkDir, "retirement-record-core.mjs"),
      readFileSync(join(CHECK_DIR, "retirement-record-core.mjs"), "utf8"),
      "utf8",
    );
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-227-D-MUTANT");
    writePointerFile(repoDir, ledger, lock);
    writeFileSync(mutatedFilePath, mutated, "utf8");

    const mod = await import(`file://${mutatedFilePath}?t=${Math.random()}`);
    const outcome = await withSyntheticRepoCwd(repoDir, async () => {
      delete process.env.ADMISSION_LEDGER_PATH;
      delete process.env.ADMISSION_LOCK_PATH;
      return mod.autoCompleteAdmission({ reservationId: "HYK-227-D-MUTANT" });
    });

    assert.deepEqual(
      outcome,
      { attempted: false },
      "RED: with the persistent-fallback branch removed, a pointer file that WOULD have worked is silently ignored again -- the exact 1R-era regression this obligation must catch",
    );
    assert.equal(
      readStatus(ledger, "HYK-227-D-MUTANT"),
      "ACTIVE",
      "RED corroboration: the reservation the pointer file names never gets released",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    const after = readFileSync(ADAPTER_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명: the real admission-completion-adapter.mjs must be byte-identical before/after this test -- only an in-memory string and a tmp-dir copy were ever mutated",
    );
  }
});

// ---------------------------------------------------------------------------
// ⓔ 오탐 분모 N>=3 -- 서로 다른 3사유로 «정상인데 안 걸리는지» 확인.
// ---------------------------------------------------------------------------

test("ⓔ 오탐 분모 (N=3): three distinct normal-flow shapes never wrongly release an unrelated ACTIVE reservation", async () => {
  const samples = [
    {
      label:
        "pointer file names a DIFFERENT reservation id than the one completing",
      run: async (repoDir, ledger, lock) => {
        initAndAdmit(ledger, lock, "HYK-227-E1-REAL");
        writePointerFile(repoDir, ledger, lock);
        const { autoCompleteAdmission } = await importFreshAdapter();
        return withSyntheticRepoCwd(repoDir, () =>
          withoutNodeTestContext(async () => {
            delete process.env.ADMISSION_LEDGER_PATH;
            delete process.env.ADMISSION_LOCK_PATH;
            // completing a DIFFERENT id than the one actually admitted --
            // must fail closed, never touch HYK-227-E1-REAL.
            return autoCompleteAdmission({
              reservationId: "HYK-227-E1-UNRELATED",
            });
          }),
        );
      },
      assertReal: (ledger) =>
        assert.equal(readStatus(ledger, "HYK-227-E1-REAL"), "ACTIVE"),
    },
    {
      label:
        "env set but points at a ledger with no init-cutover (genuinely missing)",
      run: async (repoDir, ledger, lock) => {
        initAndAdmit(ledger, lock, "HYK-227-E2-REAL");
        writePointerFile(repoDir, ledger, lock); // persistent points at the REAL one
        const brokenLedger = `${ledger}.does-not-exist`;
        const { autoCompleteAdmission } = await importFreshAdapter();
        return withSyntheticRepoCwd(repoDir, () =>
          withEnv({ ADMISSION_LEDGER_PATH: brokenLedger }, () =>
            autoCompleteAdmission({ reservationId: "HYK-227-E2-REAL" }),
          ),
        );
      },
      assertReal: (ledger) =>
        assert.equal(readStatus(ledger, "HYK-227-E2-REAL"), "ACTIVE"),
    },
    {
      label:
        "pointer file's ledgerPath field is a non-string (type-shape violation)",
      run: async (repoDir, ledger, lock) => {
        initAndAdmit(ledger, lock, "HYK-227-E3-REAL");
        writeFileSync(
          join(repoDir, ".harness", "admission-ledger-path.json"),
          JSON.stringify({ ledgerPath: 12345 }),
          "utf8",
        );
        const { autoCompleteAdmission } = await importFreshAdapter();
        return withSyntheticRepoCwd(repoDir, () =>
          withoutNodeTestContext(async () => {
            delete process.env.ADMISSION_LEDGER_PATH;
            delete process.env.ADMISSION_LOCK_PATH;
            return autoCompleteAdmission({ reservationId: "HYK-227-E3-REAL" });
          }),
        );
      },
      assertReal: (ledger) =>
        assert.equal(readStatus(ledger, "HYK-227-E3-REAL"), "ACTIVE"),
    },
  ];

  for (const sample of samples) {
    const repoDir = buildSyntheticRepo("hyk227-2r-e-repo-");
    const ledgerDir = tmpDir("hyk227-2r-e-ledger-");
    try {
      const ledger = join(ledgerDir, "l.json");
      const lock = join(ledgerDir, "l.lock");
      await sample.run(repoDir, ledger, lock);
      sample.assertReal(ledger);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// ⓕ HYK-289 2R -- 경계 계약 고정: 프로덕션 진입점(NODE_TEST_CONTEXT 없음)은
// persistent-pointer 폴백을 «계속» 쓴다. 이건 결함이 아니라 HYK-227이
// 의도적으로 만든 장치다(그 파일이 "설치기가 써 두는 것"으로 설명한
// 그대로) -- 관제실 스크립트는 `ADMISSION_LEDGER_PATH`를 절대 주지 않으므로
// (ORCH 전수 grep 0건), 이 폴백을 막으면 예약 해제/감시가 조용히 죽는다.
// 더 강한 계약(전면 거부 + 명시 opt-in)은 HYK-302로 별도 트랙됐고 이
// 라운드 범위가 아니다 -- 이 시험의 존재 이유는 정확히 그 실수를 막는
// 것: 누군가 `persistentFallbackAllowed()`를 "언제나 거부"로 바꾸면(=
// HYK-302를 이 어댑터에 성급하게 앞당겨 적용하면) 이 시험이 즉시
// RED여야 한다.
// ---------------------------------------------------------------------------

test("ⓕ HYK-289 2R: production entry points (no NODE_TEST_CONTEXT) keep using the persistent-pointer fallback -- this is the intended HYK-227 contract, not a gap HYK-302 needs to close here", async () => {
  const repoDir = buildSyntheticRepo("hyk289-2r-f-repo-");
  const ledgerDir = tmpDir("hyk289-2r-f-ledger-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-289-2R-F-PROD");
    writePointerFile(repoDir, ledger, lock);

    const { autoCompleteAdmission } = await importFreshAdapter();
    const outcome = await withSyntheticRepoCwd(repoDir, () =>
      withoutNodeTestContext(async () => {
        delete process.env.ADMISSION_LEDGER_PATH;
        delete process.env.ADMISSION_LOCK_PATH;
        return autoCompleteAdmission({ reservationId: "HYK-289-2R-F-PROD" });
      }),
    );

    assert.equal(
      outcome.attempted,
      true,
      "a production caller (no NODE_TEST_CONTEXT) must still reach the persistent pointer",
    );
    assert.equal(outcome.ok, true, `release should succeed: ${outcome.reason}`);
    assert.equal(readStatus(ledger, "HYK-289-2R-F-PROD"), "COMPLETED");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("ⓕ 변이 RED: narrowing persistentFallbackAllowed() to 'always reject' (HYK-302's stronger contract, applied here prematurely) makes ⓕ's production case go RED -- proves the test is load-bearing, then restores the real source byte-for-byte", async () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const target =
    "function persistentFallbackAllowed() {\n  return !process.env.NODE_TEST_CONTEXT;\n}";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "persistentFallbackAllowed() body" must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(
    target,
    "function persistentFallbackAllowed() {\n  return false;\n}",
  );

  const repoDir = buildSyntheticRepo("hyk289-2r-f-mutant-repo-");
  const ledgerDir = tmpDir("hyk289-2r-f-mutant-ledger-");
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
    writeFileSync(
      join(checkDir, "ledger-pointer-shared.mjs"),
      readFileSync(join(CHECK_DIR, "ledger-pointer-shared.mjs"), "utf8"),
      "utf8",
    );
    // HYK-398 §2-⑶: the adapter now also statically imports
    // "./retirement-record-core.mjs" (a zero-import core) -- same sibling
    // requirement as above.
    writeFileSync(
      join(checkDir, "retirement-record-core.mjs"),
      readFileSync(join(CHECK_DIR, "retirement-record-core.mjs"), "utf8"),
      "utf8",
    );
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-289-2R-F-MUTANT");
    writePointerFile(repoDir, ledger, lock);
    writeFileSync(mutatedFilePath, mutated, "utf8");

    const mod = await import(`file://${mutatedFilePath}?t=${Math.random()}`);
    const outcome = await withSyntheticRepoCwd(repoDir, () =>
      withoutNodeTestContext(async () => {
        delete process.env.ADMISSION_LEDGER_PATH;
        delete process.env.ADMISSION_LOCK_PATH;
        return mod.autoCompleteAdmission({
          reservationId: "HYK-289-2R-F-MUTANT",
        });
      }),
    );

    assert.deepEqual(
      outcome,
      { attempted: false },
      "RED: with persistentFallbackAllowed() narrowed to 'always reject', a production caller (no NODE_TEST_CONTEXT) that WOULD have released the reservation is now silently blocked -- exactly the premature HYK-302 regression this test must catch",
    );
    assert.equal(
      readStatus(ledger, "HYK-289-2R-F-MUTANT"),
      "ACTIVE",
      "RED corroboration: the reservation the pointer file names never gets released",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    const after = readFileSync(ADAPTER_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명: the real admission-completion-adapter.mjs must be byte-identical before/after this test -- only an in-memory string and a tmp-dir copy were ever mutated",
    );
  }
});
