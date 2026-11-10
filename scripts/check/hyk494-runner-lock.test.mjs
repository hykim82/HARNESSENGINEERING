// HYK-494-runner-lock-3: tests for runner-lock.mjs (machine-wide runner
// mutual-exclusion lock, PM design (d) 재구현 -- 세대 번호 회수권 + 잡는
// 순간 heartbeat + "낡음은 신원 질의의 방아쇠일 뿐" judge, 되돌림 0) and
// its wiring into isolated-suite-runner.mjs's runIsolatedSuite.
//
// ⛔Synthetic lock paths only (dispatch task): every test below either
// drives the production acquireRunnerLock/releaseRunnerLock functions
// against a disposable mkdtemp'd lock PATH, or stubs the lock entirely via
// NOOP_LOCK_SEAMS -- none ever touches runner-lock.mjs's real,
// machine-wide default (os.homedir()-based) lock file.
//
// §ⓒ⑴/ⓓ's real-child-process races are the one scenario a pure in-process
// unit test cannot honestly make: REAL `node` child processes, started
// together, racing for the SAME file. They drive the production module
// directly (no copy -- the children import this repo's own runner-lock.mjs
// by its real file:// URL), via a short inline ESM script string (same
// technique isolated-suite-runner.mjs's own FREE_MEM_SAMPLER_SCRIPT uses).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUSY_RETRY_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_SCRIPT,
  HEARTBEAT_STALE_MS,
  LOCK_POLL_INTERVAL_MS,
  LOCK_WAIT_TIMEOUT_MS,
  NESTED_LOCK_BYPASS_ENV_VAR,
  acquireRunnerLock,
  defaultGetStartIdentity,
  defaultRunnerLockPath,
  installLockReleaseOnSignal,
  releaseRunnerLock,
  startLockHeartbeat,
} from "./runner-lock.mjs";
import { RUNNER_STATUS } from "./runner-receipt-writer.mjs";
import { runIsolatedSuite } from "./isolated-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_LOCK_URL = pathToFileURL(join(HERE, "runner-lock.mjs")).href;

function freshLockDir(prefix = "hyk494-lock-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// HYK-498 §2 ⓘⓘⓘ(정보 1~2): 자식별 고정 클럭으로 "결국 완료"를 판정하던
// 세 자리(waitForFileToExist의 5초, P1-1 칸의 자식별 "6000", §10의
// lockRaceChildScript timeoutMs:15000) 전부가 §2 ⓘⓘ 2-way/5-way 칸과
// 같은 모양(부하에서 굶은 쪽이 시험 자신의 짧은 시계에 걸려 알고리즘
// 결함처럼 보이는 가짜 RED)이다 -- 그래서 이 라운드가 그 세 자리에도
// 같은 처방(GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS, 5R이 고른 20_000ms)을
// 쓴다. 정의를 파일 앞쪽(이 세 자리가 실제로 쓰는 위치보다 앞)으로
// 옮겼다 -- #358/HYK-498 1R이 쓰던 자리(아래 §10b 앞, RECLAIM_TRIALS
// 바로 위)는 이제 이 선언을 참조만 한다. "결국 완료" 판정에서 시계
// 의존을 완전히 제거하지 않고(폴링 루프가 무한 대기가 되면
// busyRetryTimeoutMs 기본값과의 상호작용이 복잡해진다, 5R과 같은 근거)
// 상한만 넉넉히 늘리는 선택도 그대로다 -- 전원 획득·순서·배제 단언은
// 전부 무변(단언 약화 아님).
const GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS = 20_000;

// HYK-494 2R live finding (still true in 3R -- the mechanism, NESTED_LOCK_
// BYPASS_ENV_VAR, is unchanged): this test FILE can itself run nested
// inside a real isolated-suite-runner.mjs invocation that already holds
// the real lock. Every test below that means to exercise NON-nested
// behavior must explicitly strip it.
function cleanEnv() {
  const env = { ...process.env };
  delete env[NESTED_LOCK_BYPASS_ENV_VAR];
  return env;
}

// -- §1: defaultRunnerLockPath (unchanged from 2R -- this calculation is
// not part of the (d) redesign, product_scope names it unchanged) --------

test("defaultRunnerLockPath: lives under os.homedir() with the fixed filename, never TEMP/TMP, never a per-worktree path", () => {
  const p1 = defaultRunnerLockPath({ homedirFn: () => "/fake/home" });
  const p2 = defaultRunnerLockPath({ homedirFn: () => "/fake/home" });
  assert.equal(p1, p2, "same homedir must always resolve to the same path");
  assert.match(p1, /harness-isolated-suite-runner\.lock$/);
  assert.equal(
    p1,
    join("/fake/home", "harness-isolated-suite-runner.lock"),
    "must be joined onto the injected homedirFn() result, not some other base",
  );
});

test("defaultRunnerLockPath: the REAL default (no override) resolves under the REAL os.homedir(), not os.tmpdir()", () => {
  const real = defaultRunnerLockPath();
  assert.equal(real, join(homedir(), "harness-isolated-suite-runner.lock"));
  assert.notEqual(
    real,
    join(tmpdir(), "harness-isolated-suite-runner.lock"),
    "homedir() and tmpdir() must not coincide on this machine, or this assertion is vacuous",
  );
});

// -- §2: acquireRunnerLock basic acquire/release -------------------------

test("acquireRunnerLock: uncontended acquisition is immediate (waitMs 0, pollCount 0), writes pid/startedAtMs/worktree/head/lockId/procStart", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const r = acquireRunnerLock({
      lockPath,
      pid: 4242,
      startedAtMs: 1000,
      worktree: "/src",
      head: "deadbeef",
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.nested, false);
    assert.ok(
      r.waitMs <= 5,
      `waitMs (${r.waitMs}) must be near-zero with no contention`,
    );
    assert.equal(r.pollCount, 0);
    assert.equal(r.reclaimedOrphan, false);
    assert.equal(r.reclaimReason, null);
    assert.equal(r.timedOut, false);
    assert.equal(r.lockId, JSON.parse(readFileSync(lockPath, "utf8")).lockId);
    assert.ok(
      typeof r.lockId === "string" && r.lockId.length > 0,
      "acquired result must carry the lockId this call wrote",
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.pid, 4242);
    assert.equal(content.startedAtMs, 1000);
    assert.equal(content.worktree, "/src");
    assert.equal(content.head, "deadbeef");
    // HYK-494 3R content shape change (fixture sync, ORCH70 §33 ⓒ -- real
    // behavior change, PM design (d) "me = {v:3,pid,procStart,lockId,...}"):
    // aliveAtMs is GONE from the lock content entirely -- heartbeat now
    // lives in a separate L.alive.<lockId> file (F8 fix), never inside L
    // itself. `procStart` (this process's own start identity) replaces it.
    assert.equal(
      Object.keys(content).sort().join(","),
      "head,lockId,pid,procStart,startedAtMs,worktree",
      "no untracked extra fields, and no aliveAtMs inside L itself (F8)",
    );
    // ③ 잡는 순간 heartbeat: the alive file must exist the instant we claim.
    const aliveContent = JSON.parse(
      readFileSync(`${lockPath}.alive.${r.lockId}`, "utf8"),
    );
    assert.ok(
      Number.isFinite(aliveContent.aliveAtMs),
      "L.alive.<lockId> must be written at claim time",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseRunnerLock: releases our own lock (lockId matches) -- file removed, lockLost false", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const acquired = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      env: cleanEnv(),
    });
    assert.ok(existsSync(lockPath));
    const result = releaseRunnerLock({ lockPath, lockId: acquired.lockId });
    assert.equal(result.released, true);
    assert.equal(result.lockLost, false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-494-runner-lock-3-fix1 (live finding, this round's own full-runner
// run 1): a normal release must ALSO clean up our own L.alive.<lockId>
// heartbeat file -- a leftover was found in the real homedir after the
// first full-runner pass (§(d) "unlink L.alive.<me>", missed in the first
// implementation).
test("releaseRunnerLock: a normal release ALSO removes our own L.alive.<lockId> heartbeat file (no leftover)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const acquired = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      env: cleanEnv(),
    });
    assert.ok(
      existsSync(`${lockPath}.alive.${acquired.lockId}`),
      "the alive file must exist right after claiming (sanity check)",
    );
    releaseRunnerLock({ lockPath, lockId: acquired.lockId });
    assert.equal(
      existsSync(`${lockPath}.alive.${acquired.lockId}`),
      false,
      "the alive file must be gone after release -- no leftover in the home directory",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseRunnerLock: even a LOST lock (lockId mismatch) still cleans up OUR OWN alive file (it is our bookkeeping, not the new owner's)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      `${lockPath}.alive.my-own-token`,
      JSON.stringify({ aliveAtMs: Date.now() }),
    );
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, lockId: "someone-elses-token" }),
    );
    const result = releaseRunnerLock({ lockPath, lockId: "my-own-token" });
    assert.equal(result.lockLost, true);
    assert.equal(
      existsSync(`${lockPath}.alive.my-own-token`),
      false,
      "our own stale alive file must still be cleaned up even when we lost the lock",
    );
    assert.equal(
      existsSync(lockPath),
      true,
      "the OTHER owner's lock itself must survive untouched",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §3: release by lockId only (HYK-494 3R, F11 수리: pid 대조에서 교체) --

test("releaseRunnerLock: a lock file owned by a DIFFERENT lockId is left untouched -- never deletes another instance's lock, reports lockLost true", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: "someone-elses-lock-id",
      }),
    );
    const result = releaseRunnerLock({ lockPath, lockId: "my-lock-id" });
    assert.equal(result.released, false);
    assert.equal(
      result.lockLost,
      true,
      "the lock is no longer ours -- LOCK_LOST territory",
    );
    assert.equal(
      existsSync(lockPath),
      true,
      "the other instance's lock must survive",
    );
    const stillThere = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(stillThere.lockId, "someone-elses-lock-id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseRunnerLock: a missing/unreadable lock file is reported as not-released and lockLost true, never throws", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "never-created.lock");
  try {
    const result = releaseRunnerLock({ lockPath, lockId: "whatever" });
    assert.equal(result.released, false);
    assert.equal(result.lockLost, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseRunnerLock: calling with no lockId at all never matches anything (never a false release)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: 1, lockId: undefined }));
    const result = releaseRunnerLock({ lockPath });
    assert.equal(result.released, false);
    assert.equal(result.lockLost, true);
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4: orphan (dead pid) reclaim -- generation-numbered reclaim ticket --

test("acquireRunnerLock: a lock held by a DEAD pid is reclaimed (reclaimedOrphan true, reclaimReason pid-dead), then acquired under our own pid", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    assert.ok(Number.isInteger(deadPid), "spawnSync must report a real pid");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: "dead-owner-token",
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 2,
      timeoutMs: 5000,
      pollIntervalMs: 5,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.reclaimedOrphan, true);
    assert.equal(r.reclaimReason, "pid-dead");
    assert.equal(r.priorOwner.pid, deadPid);
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(
      content.pid,
      process.pid,
      "the reclaimed lock must now be ours",
    );
    // best-effort cleanup (product_scope §(d) "L 삭제 뒤" 청소): the dead
    // owner's own alive file and reclaim tickets must not linger forever.
    assert.equal(existsSync(`${lockPath}.alive.dead-owner-token`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4b: a read failure is "busy", never "orphan" (2R P1-1 fix, unchanged
// axis in 3R) --------------------------------------------------------------

test("acquireRunnerLock: a readFileFn failure never triggers a reclaim (read failure != orphan) -- recovers and times out against the real (live) owner once reads succeed again", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // genuinely alive -- this test's own process
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: "live-owner",
      }),
    );
    let readCalls = 0;
    const realReadFileFn = (p, enc) => readFileSync(p, enc);
    const readFileFn = (p, enc) => {
      readCalls += 1;
      if (readCalls <= 3 && p === lockPath) {
        throw new Error("simulated transient read failure (ENOENT-shaped)");
      }
      return realReadFileFn(p, enc);
    };
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 80,
      pollIntervalMs: 10,
      readFileFn,
      env: cleanEnv(),
    });
    assert.ok(readCalls > 3, "must have retried past the simulated failures");
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(
      r.reclaimedOrphan,
      false,
      "the real owner is alive -- nothing was ever reclaimed",
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(
      content.pid,
      process.pid,
      "the live owner's lock must survive untouched",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4b-2: HYK-494 후속 P2-2 -- a reclaim TICKET read failure is also
// "busy", never "orphan" (the 2R F3 principle, applied to the reclaim
// ticket, not just L itself) --------------------------------------------

test("acquireRunnerLock: a reclaim ticket read failure (non-ENOENT, e.g. a sharing violation) must NOT skip past the ticket's possibly-alive holder -- retries bounded, then throws, never creating ticket k+1 or deleting L (P2-2)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, lockId: "O-busy-token", procStart: null }),
    );
    // Ticket #1, held by a genuinely ALIVE pid (this test process itself).
    const ticket1Path = `${lockPath}.reclaim.O-busy-token.1`;
    const tmp1 = `${ticket1Path}.tmp`;
    writeFileSync(tmp1, JSON.stringify({ pid: process.pid, procStart: null }));
    linkSync(tmp1, ticket1Path);
    unlinkSync(tmp1);

    const realReadFileFn = (p, enc) => readFileSync(p, enc);
    const readFileFn = (p, enc) => {
      if (p === ticket1Path) {
        const err = new Error("simulated sharing violation");
        err.code = "EBUSY";
        throw err;
      }
      return realReadFileFn(p, enc);
    };

    assert.throws(
      () =>
        acquireRunnerLock({
          lockPath,
          pid: process.pid + 1,
          startedAtMs: 1,
          timeoutMs: 5000,
          pollIntervalMs: 5,
          busyRetryTimeoutMs: 40,
          readFileFn,
          env: cleanEnv(),
        }),
      /reclaim ticket/i,
      "a persistent non-ENOENT ticket read failure must throw, not silently skip to k+1",
    );
    assert.equal(
      existsSync(lockPath),
      true,
      "L must remain untouched -- the alive ticket holder must not be bypassed",
    );
    assert.equal(
      existsSync(`${lockPath}.reclaim.O-busy-token.2`),
      false,
      "must never create ticket k+1 while ticket k's read keeps failing (not confirmed dead)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: a reclaim ticket that is ENOENT (gone by read time, though the directory listing just saw it) is NOT a busy failure -- proceeds straight to k+1 without waiting (the holder already finished and cleaned up) (P2-2 boundary)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        lockId: "O-enoent-token",
        procStart: null,
      }),
    );
    const ticket1Path = `${lockPath}.reclaim.O-enoent-token.1`;
    const tmp1 = `${ticket1Path}.tmp`;
    writeFileSync(tmp1, JSON.stringify({ pid: deadPid, procStart: null }));
    linkSync(tmp1, ticket1Path);
    unlinkSync(tmp1);

    const realReadFileFn = (p, enc) => readFileSync(p, enc);
    const readFileFn = (p, enc) => {
      if (p === ticket1Path) {
        const err = new Error("no such file");
        err.code = "ENOENT";
        throw err;
      }
      return realReadFileFn(p, enc);
    };

    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      timeoutMs: 2000,
      pollIntervalMs: 5,
      busyRetryTimeoutMs: 40,
      readFileFn,
      env: cleanEnv(),
    });
    assert.equal(
      r.acquired,
      true,
      "ENOENT on the ticket read must not be treated as busy -- must proceed to claim-again",
    );
    assert.equal(r.reclaimedOrphan, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4b-3: HYK-494 후속 P2-3 -- cleanup only follows a CONFIRMED read of L,
// never merely an attempt (design (d) "청소 = L 삭제 뒤") --------------------

// HYK-494 후속(followup-3) P1-1: 검토 1R이 교착으로 판정한 바로 그 시험
// (base 787b95e에서 `git show`로 뜬 원문 대비 직접 재현: 고친 전 코드로는
// `acquired:false timedOut:true` + 회수권 생존 그대로였다). 기대값을
// 바꾼다 -- "청소 0"을 "영원히 청소 안 함"이 아니라 "재확인(=L 삭제)이
// 확정되기 「전」에는 청소 호출이 0회"로 읽는다(근거 1줄: "영원히 청소
// 0 + 결국 획득"은 모순이다 -- L이 끝내 안 지워지면 createExclusive가
// 영원히 EEXIST라 획득 자체가 성립할 수 없다). 그 전제 위에서 "결국
// 획득(교착 0)"을 새 기대값으로 삼는다 -- 다음 라운드가 "자기 자신의"
// 살아 있는 회수권 k를 재확인·삭제 재시도의 트리거로 쓰기 때문이다(P1-1
// 수리, resolveContendedStep의 isSelf 분기).
test("acquireRunnerLock: when the post-ticket reread of L fails once (transient, non-ENOENT), cleanup is skipped for THAT attempt (confirmed L-delete required, P2-3 unchanged) -- but the next round retries the recheck/delete on the SAME (now self-held) reclaim ticket and the lock is eventually acquired, no deadlock (P1-1 fix, HYK-494 followup-3; previously this exact shape timed out, reproduced directly against base 787b95e)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    const originalContent = JSON.stringify({
      pid: deadPid,
      lockId: "O-reread-token",
      procStart: null,
    });
    writeFileSync(lockPath, originalContent);
    let lockReadCount = 0;
    const realReadFileFn = (p, enc) => readFileSync(p, enc);
    const readFileFn = (p, enc) => {
      if (p === lockPath) {
        lockReadCount += 1;
        if (lockReadCount === 2) {
          throw new Error("simulated transient reread failure");
        }
      }
      return realReadFileFn(p, enc);
    };
    // P2-3 불변식을 "최종 상태"가 아니라 "호출 순서"로 직접 관측한다 --
    // L 자체의 unlink(=재확인 성공 확정)보다 「먼저」 alive/reclaim-ticket
    // 청소가 일어나면 위반이다. createExclusive 자신의 tmp 파일 뒷정리
    // (`.tmp.` 접미)는 이 불변식과 무관하므로 제외한다.
    const lockDirPrefix = `${lockPath}.`;
    const cleanupCallsBeforeReconfirm = [];
    let reconfirmed = false;
    const unlinkFn = (p) => {
      const isCleanupTarget =
        p.startsWith(lockDirPrefix) && !p.includes(".tmp.");
      if (isCleanupTarget && !reconfirmed) cleanupCallsBeforeReconfirm.push(p);
      if (p === lockPath) reconfirmed = true;
      return unlinkSync(p);
    };
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      timeoutMs: 2000,
      pollIntervalMs: 10,
      readFileFn,
      unlinkFn,
      env: cleanEnv(),
    });
    // product_scope ⓥ(P2-a, 검토 2R §3): :545-547의 "청소 전 호출" 필터는
    // `${lockPath}.` 로 시작하는 모든 non-tmp unlink를 세므로, 우리 자신의
    // 포기/정리 경로에서 나오는 자기 alive 파일 삭제(`r.lock.alive.
    // <자기 lockId>`, P2-7 수리)까지 "청소"로 잡는다. 그래서 실제 결함이
    // 교착(timedOut)인 변이(M1 등)에서도 「먼저」 걸리는 단언이 엉뚱한
    // "P2-3 위반" 문구가 되어 오진을 유발한다(RED 자체는 맞지만 원인
    // 표시가 틀린다). acquired/timedOut을 먼저 확인하는 순서로 바꿔
    // 진짜 결함이 먼저, 더 정확한 문구로 드러나게 한다(필터 자체를
    // O의 lockId 접두로 좁히는 대신 이 방법을 택한다 -- review 문면이
    // 둘 중 하나로 허용).
    assert.equal(
      r.acquired,
      true,
      "HYK-494 followup-3 P1-1: must eventually acquire, not deadlock on our own live reclaim ticket (previously timedOut:true against this exact shape)",
    );
    assert.equal(r.timedOut, false);
    assert.deepEqual(
      cleanupCallsBeforeReconfirm,
      [],
      `P2-3 위반: L 삭제(재확인 성공)보다 먼저 청소가 일어났다 -- ${JSON.stringify(cleanupCallsBeforeReconfirm)}`,
    );
    assert.equal(
      existsSync(`${lockPath}.reclaim.O-reread-token.1`),
      false,
      "the reclaim ticket is eventually cleaned up once the recheck/delete retry succeeds -- it cannot survive forever and still have let us acquire",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-494 후속(followup-3) P2-3(참고 칸 정리): claim-again이 state.
// reclaimedOrphan=true를 세운 뒤, 그 사이 「정말로 살아 있는」 새 주인이
// L을 먼저 잡아 우리가 결국 시간 초과로 포기하는 경우 -- 영수증에
// `reclaimedOrphan:true`와 `timedOut:true`가 함께 남으면 오독 소지다
// (검토 1R §3 P2-3). linkFn을 가로채 "우리의 두 번째 createExclusive(L)
// 시도"에서 결정론적으로 새 ALIVE 소유자를 L에 심어, 이후 매 폴 verdict가
// ALIVE로 떨어지게 만든다(getStartIdentityFn을 null-고정해 신원 질의
// 자체의 느림/비결정성을 제거).
test("acquireRunnerLock: a timed-out result never reports reclaimedOrphan:true, even if an earlier poll round DID claim-again before a genuinely alive new owner beat us to L (P2-3 receipt-honesty, HYK-494 followup-3)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, lockId: "O-race-token", procStart: null }),
    );
    const realLinkFn = (src, dest) => linkSync(src, dest);
    let lockLinkAttempts = 0;
    const linkFn = (src, dest) => {
      if (dest === lockPath) {
        lockLinkAttempts += 1;
        if (lockLinkAttempts === 2) {
          // "누가 먼저 잡았다" 흉내 -- 우리가 claim-again한 바로 다음
          // 라운드에, 우리가 아닌 실제 ALIVE 소유자(이 테스트 프로세스
          // 자신의 pid, 하지만 전혀 다른 lockId)가 L을 이미 채워 둔
          // 것처럼 만든다. createExclusive는 그 뒤 실제 link를 시도해
          // EEXIST로 자연히 실패한다.
          writeFileSync(
            lockPath,
            JSON.stringify({
              pid: process.pid,
              lockId: "O-newowner-token",
              procStart: null,
            }),
          );
        }
      }
      return realLinkFn(src, dest);
    };
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1000, // 우리 자신과 겹치지 않는 가짜 "요청자" pid.
      startedAtMs: 1,
      timeoutMs: 60,
      pollIntervalMs: 5,
      linkFn,
      getStartIdentityFn: () => null, // 신원 모름 -> judge가 "낡음이어도 ALIVE".
      env: cleanEnv(),
    });
    assert.equal(
      r.timedOut,
      true,
      "the genuinely-alive new owner must win -- we time out",
    );
    assert.equal(r.acquired, false);
    assert.equal(
      r.reclaimedOrphan,
      false,
      "a timed-out result must never carry reclaimedOrphan:true, even though an earlier round DID claim-again before losing the race",
    );
    assert.equal(r.reclaimReason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-494 후속(followup-3) P1-1: 다른 대기자 1명을 둔 「실제 프로세스」
// 칸(product_scope 명시) -- C1이 자기 회수권을 만든 직후 L의 재확인
// 읽기에서 1회 실패(주입, 검토 1R의 실제 PowerShell EBUSY와 같은 자리를
// 겨눈다 -- 오류 코드도 EBUSY로 맞춘다. 〔직접〕이 아니라 주입임을 그대로
// 적는다: 이 칸은 "실제 OS 공유 위반"이 아니라 "실제 두 프로세스 경합+
// 그 자리의 주입된 비-ENOENT 실패"다, universal_claim_discipline) --
// C2는 아무 주입도 없는 평범한 두 번째 대기자다. 수리 전(base 787b95e)
// 이면 둘 다 LOCK_WAIT_TIMEOUT_MS까지 멈춘다(교착) -- 수리 후에는 둘 다
// 결국 획득해야 한다.
// product_scope ⓥⓘ(P2-b, 검토 2R §3): ":722에서 C2를 15ms 뒤에 띄우고,
// 주입은 'C1의 2번째 L 읽기'에 건다. C2가 먼저 #1을 잡는 회차에서는
// C1의 주입이 다른 자리(경합 중 L 읽기)에 떨어진다 -- 그래도 둘 다
// 획득하므로 그 회차는 '자기 분기(C1이 자기 회수권을 먼저 잡은 뒤
// 그 재확인에서 주입이 떨어지는 자리)'를 타지 않고도 통과한다." 이
// 수리는 주입 순간(lockReadCount===2) C1 자신의 이름으로 된 reclaim
// ticket이 이미 존재하는지(=자기 회수권을 먼저 잡았는지)를 직접
// 디렉터리에서 확인해 `selfBranchHit`으로 싣는다 -- 자기 분기를 탄
// 회차 수를 아래 시험이 ≥1로 단언한다(오진 아님, 헛시험 아님을 수로
// 증명).
//
// HYK-498 §2 ⓘⓘⓘ(P2-1, 검토 3R §3 "P2-1" 그대로): 위 "C2를 15ms 뒤에
// 띄운다"는 타이밍 의존이었다 -- C1이 느리게 스케줄되면(부하 등) C2가
// ticket #1을 먼저 잡아 C1의 selfBranchHit이 구조적으로 false가 될 수
// 있다(검토 3R 제자리 계측: trials 3→30, hit 83/90 -- 로컬 기준 3회
// 모두 빗나갈 확률 ~0.05%이지만 0은 아니다). 수리(검토 3R 수리 예 그대로
// "C1의 회수권 생성을 확인한 뒤 C2를 띄운다") -- 단, ticket #1 파일
// 자체를 바깥(부모) 프로세스가 폴링하는 방식은 못 썼다: 주입이 없을 때
// 실측(〔직접〕, 이 라운드)하면 ticket 생성 -> 재확인읽기 -> 삭제가 전부
// 같은 동기 호출 안에서 ~6ms 안에 끝나(waitMs:6), 그보다 거친 외부 폴
// (IPC/프로세스 간 10ms 간격)로는 그 창을 거의 항상 놓친다(5초를 돌려도
// "ticket never appeared" -- 창이 폴 간격보다 훨씬 짧다는 뜻). 대신 C1
// 자신의 readFileFn 주입 지점(lockReadCount===2, 즉 자기 ticket #1을
// "막" 만든 바로 다음 줄)에서 지워지지 않는 전용 신호 파일(signalPath)을
// 쓴다 -- 이 파일은 알고리즘이 건드리는 이름이 아니라 이 시험만 보는
// 새 이름이라, 누구도 지우지 않고 그대로 남는다. C2는 이 신호가 나타난
// 뒤에야 뜬다 -- 그 시점에 C1은 이미 ticket #1을 "링크까지" 끝낸 뒤이므로
// (신호를 쓰는 코드 자리 자체가 그 다음 줄), C2가 존재하지도 않는 동안
// C1이 ticket #1을 독점한다(경쟁 기회 자체가 없다, 순서 결정화). 단언
// 약화 아님: 아래 `selfBranchTrials` 단언은 ">=1"에서 "모든 회차"로
// 강화됐다.
// HYK-498 §2 ⓘⓘⓘ(정보 1): 500×10ms=5초 고정 상한은 2-way/5-way 칸과
// 같은 모양의 가짜 RED를 만들 수 있다(C1이 부하로 늦게 스케줄되면 신호
// 파일이 5초 안에 못 나타난다 -- 알고리즘 결함이 아니라 시험 자신의
// 짧은 시계). attempts를 늘려 전체 상한을
// `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`(20초)로 맞춘다 -- delayMs(폴
// 간격)는 무변, `c1SignalReady` 단언 자체도 무변(단언 약화 아님).
async function waitForFileToExist(
  path,
  { attempts = GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS / 10, delayMs = 10 } = {},
) {
  for (let i = 0; i < attempts; i += 1) {
    if (existsSync(path)) return true;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return false;
}
function p1SelfReclaimDeadlockChildScript() {
  return [
    `import { acquireRunnerLock, releaseRunnerLock } from ${JSON.stringify(RUNNER_LOCK_URL)};`,
    `import { readFileSync, readdirSync, writeFileSync } from "node:fs";`,
    `import { basename, dirname } from "node:path";`,
    `const [lockPath, outPath, timeoutMs, pollIntervalMs, injectFailure, signalPath] = process.argv.slice(2);`,
    `const realReadFileFn = (p, enc) => readFileSync(p, enc);`,
    `let lockReadCount = 0;`,
    `let selfBranchHit = false;`,
    `const readFileFn = injectFailure !== "1" ? realReadFileFn : (p, enc) => {`,
    `  if (p === lockPath) {`,
    `    lockReadCount += 1;`,
    `    if (lockReadCount === 2) {`,
    `      try {`,
    `        const dir = dirname(lockPath);`,
    `        const ticketPrefix = \`\${basename(lockPath)}.reclaim.\`;`,
    `        for (const name of readdirSync(dir)) {`,
    `          if (!name.startsWith(ticketPrefix)) continue;`,
    `          try {`,
    `            const ticket = JSON.parse(realReadFileFn(\`\${dir}/\${name}\`, "utf8"));`,
    `            if (ticket.pid === process.pid) { selfBranchHit = true; break; }`,
    `          } catch (e) {}`,
    `        }`,
    `      } catch (e) {}`,
    // HYK-498 P2-1: a durable sentinel (never cleaned up by the lock
    // algorithm, unlike the ephemeral reclaim ticket itself) right at the
    // point we've already confirmed our own ticket #1 exists -- the test
    // waits on THIS file, not the ticket file, before starting C2.
    `      if (signalPath) { try { writeFileSync(signalPath, "1"); } catch (e) {} }`,
    `      const err = new Error("HYK-494 followup-3 real-process repro: injected transient EBUSY on L reread");`,
    `      err.code = "EBUSY";`,
    `      throw err;`,
    `    }`,
    `  }`,
    `  return realReadFileFn(p, enc);`,
    `};`,
    `const r = acquireRunnerLock({ lockPath, pid: process.pid, startedAtMs: Date.now(), timeoutMs: Number(timeoutMs), pollIntervalMs: Number(pollIntervalMs), readFileFn, env: {} });`,
    `if (r.acquired) releaseRunnerLock({ lockPath, lockId: r.lockId });`,
    `writeFileSync(outPath, JSON.stringify({ pid: process.pid, acquired: r.acquired, timedOut: r.timedOut, reclaimedOrphan: r.reclaimedOrphan, selfBranchHit }));`,
  ].join("\n");
}

function spawnP1Child({ scriptPath, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: "ignore",
      env: cleanEnv(),
    });
    child.on("exit", () => {
      readJsonWithRetry(args[1]).then(resolve, reject);
    });
  });
}

const P1_DEADLOCK_TRIALS = 3;

test(`GREEN (P1-1 교착 재현, 다른 대기자 1명을 둔 실제 프로세스): ${P1_DEADLOCK_TRIALS} trials -- C1 hits an injected transient (non-ENOENT) reread failure right after claiming its own reclaim ticket, C2 is a plain second waiter racing the same dead-owner orphan -- both must eventually acquire, zero deadlocks (P1-1 fix, HYK-494 followup-3)`, async () => {
  const dir = freshLockDir();
  try {
    const scriptPath = join(dir, "p1-child.mjs");
    writeFileSync(scriptPath, p1SelfReclaimDeadlockChildScript());
    let deadlocks = 0;
    let selfBranchTrials = 0;
    for (let trial = 0; trial < P1_DEADLOCK_TRIALS; trial += 1) {
      const lockPath = join(dir, `p1-${trial}.lock`);
      const deadPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          lockId: `O-p1-${trial}`,
          procStart: null,
        }),
      );
      const out1 = join(dir, `p1-out-${trial}-1.json`);
      const out2 = join(dir, `p1-out-${trial}-2.json`);
      const c1SignalPath = join(dir, `p1-signal-${trial}.flag`);
      const c1 = spawnP1Child({
        scriptPath,
        // HYK-498 §2 ⓘⓘⓘ(정보 2): 고정 "6000" -> GENEROUS_EVENTUAL_
        // ACQUIRE_TIMEOUT_MS(20초) -- 부하에서 굶은 자식도 결국 획득할
        // 여유를 준다(acquireRunnerLock 자신의 timeoutMs, 단언 무변).
        args: [
          lockPath,
          out1,
          String(GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS),
          "20",
          "1",
          c1SignalPath,
        ],
      });
      // HYK-498 P2-1: wait for C1's durable signal (written right after C1
      // has already confirmed its own ticket #1 -- see the header comment
      // above) before starting C2 -- deterministic order, replaces the old
      // fixed-15ms race.
      const c1SignalReady = await waitForFileToExist(c1SignalPath);
      assert.ok(
        c1SignalReady,
        `trial ${trial}: C1 must signal (${c1SignalPath}) that it has already claimed its own reclaim ticket #1 before C2 starts`,
      );
      const c2 = spawnP1Child({
        scriptPath,
        args: [
          lockPath,
          out2,
          String(GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS),
          "20",
          "0",
          "",
        ],
      });
      const [a, b] = await Promise.all([c1, c2]);
      if (!a.acquired || !b.acquired || a.timedOut || b.timedOut) {
        deadlocks += 1;
      }
      if (a.selfBranchHit) selfBranchTrials += 1;
      assert.ok(
        a.acquired && b.acquired,
        `trial ${trial}: both C1(${JSON.stringify(a)}) and C2(${JSON.stringify(b)}) must eventually acquire -- no deadlock`,
      );
      assert.equal(
        existsSync(lockPath),
        false,
        `trial ${trial}: whichever finished last must leave L released`,
      );
    }
    assert.equal(
      deadlocks,
      0,
      `${deadlocks}/${P1_DEADLOCK_TRIALS} trials deadlocked -- 〔직접〕 finite sample, this machine, this run, injected (not real-OS) EBUSY`,
    );
    // HYK-498 P2-1: with C2 deterministically started only after C1's own
    // ticket #1 already exists (above), C1 can never lose that race to
    // C2 -- selfBranchHit must be true EVERY trial now, not just >=1
    // (strengthened from the P2-b original, not weakened: 검토 3R §3 P2-1).
    assert.equal(
      selfBranchTrials,
      P1_DEADLOCK_TRIALS,
      `P2-1: only ${selfBranchTrials}/${P1_DEADLOCK_TRIALS} trials took the self-reclaim-ticket branch -- with C2 gated on C1's own ticket existing first, every trial must take it (검토 3R §3 P2-1 fix)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4b-4: HYK-494 후속 P2-7 -- a waiter that gives up (timeout OR a
// bounded-busy throw) removes its OWN heartbeat file (best-effort) --------

test("acquireRunnerLock: when a waiter gives up on timeout, it removes its OWN L.alive.<lockId> heartbeat file (best-effort) -- a losing poller must not leak a file per timeout (P2-7)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const realNow = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // genuinely alive the whole time
        startedAtMs: realNow - 10,
        procStart: null,
        worktree: null,
        head: null,
        lockId: "p27-owner-token",
      }),
    );
    writeFileSync(
      `${lockPath}.alive.p27-owner-token`,
      JSON.stringify({ aliveAtMs: realNow }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: realNow,
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    const leftoverAliveFiles = readdirSync(dir).filter(
      (name) =>
        name.startsWith("r.lock.alive.") &&
        name !== "r.lock.alive.p27-owner-token",
    );
    assert.deepEqual(
      leftoverAliveFiles,
      [],
      `a timed-out waiter must not leave its own heartbeat file behind, found: ${JSON.stringify(leftoverAliveFiles)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: when the loop throws (bounded busy retry exceeded), it STILL removes its own L.alive.<lockId> heartbeat file before propagating the error (P2-7, the busy-throw branch)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const linkFn = () => {
      const err = new Error("simulated persistent EPERM");
      err.code = "EPERM";
      throw err;
    };
    assert.throws(() =>
      acquireRunnerLock({
        lockPath,
        pid: process.pid,
        startedAtMs: 1,
        timeoutMs: 5000,
        pollIntervalMs: 5,
        busyRetryTimeoutMs: 30,
        linkFn,
        env: cleanEnv(),
      }),
    );
    const leftoverAliveFiles = readdirSync(dir).filter((name) =>
      name.startsWith("r.lock.alive."),
    );
    assert.deepEqual(
      leftoverAliveFiles,
      [],
      `a thrown (bounded-busy) acquire attempt must not leave its own heartbeat file behind, found: ${JSON.stringify(leftoverAliveFiles)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4b-5: HYK-494 후속 P2-1 -- heartbeat-stale ALIVE verdicts log exactly
// once per transition (design (d) "대기자 로그에 1줄", flood 금지) ----------

test("acquireRunnerLock: a live, same-identity owner whose heartbeat has gone stale logs exactly ONE 'alive-heartbeat-stale' line via logFn across many polls -- no reclaim, no flood (P2-1)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const myProcStart = defaultGetStartIdentity(process.pid);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: 1,
        procStart: myProcStart,
        worktree: null,
        head: null,
        lockId: "p21-same-identity-token",
      }),
    );
    const logs = [];
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 80,
      pollIntervalMs: 5,
      heartbeatStaleMs: 1,
      // A cheap stub -- the REAL default spawns PowerShell per query on
      // Windows (seconds, not ms), which would starve this test of more
      // than 1 poll inside a short timeoutMs. Same identity every time
      // (genuinely matches, never reclaimed) -- only the query COST is
      // stubbed, not the verdict logic under test.
      getStartIdentityFn: () => myProcStart,
      logFn: (line) => logs.push(line),
      env: cleanEnv(),
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.reclaimedOrphan, false);
    assert.ok(
      r.pollCount > 1,
      `must have polled more than once (got ${r.pollCount})`,
    );
    const staleLines = logs.filter((l) => l.includes("alive-heartbeat-stale"));
    assert.equal(
      staleLines.length,
      1,
      `must log exactly once across many polls, got ${staleLines.length}: ${JSON.stringify(logs)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: logFn is optional, defaulting to a no-op -- every existing/other caller that never mentions it stays silent and unaffected", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        lockId: "no-logfn-token",
        procStart: null,
      }),
    );
    assert.doesNotThrow(() =>
      acquireRunnerLock({
        lockPath,
        pid: process.pid,
        startedAtMs: 1,
        timeoutMs: 5000,
        pollIntervalMs: 10,
        env: cleanEnv(),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4c: HYK-494 3R core behavior change -- heartbeat staleness is a
// TRIGGER for an identity check, never a reclaim verdict by itself
// (judgment 23:5x §1 ⑴, 이탈 1 승인) --------------------------------------

test("acquireRunnerLock: a lock whose owner pid is ALIVE and whose startIdentity MATCHES is never reclaimed, even with a stale/missing heartbeat (false-orphan bait closed)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const myProcStart = defaultGetStartIdentity(process.pid);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // genuinely alive -- this test's own process,
        // the WHOLE time (not reused) -- must never be mistaken for a
        // pid-reuse orphan just because its heartbeat looks stale.
        startedAtMs: 1,
        procStart: myProcStart,
        worktree: null,
        head: null,
        lockId: "same-identity-token",
      }),
    );
    // No L.alive.<lockId> file at all -- readAliveAgeMs resolves to
    // Infinity, i.e. maximally "stale" -- the strongest possible bait.
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 100,
      pollIntervalMs: 10,
      heartbeatStaleMs: 1,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(
      r.reclaimedOrphan,
      false,
      "staleness alone must NEVER reclaim a live, same-identity owner",
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.lockId, "same-identity-token", "untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: a lock whose pid is alive but whose startIdentity MISMATCHES (pid reuse) IS reclaimed once the heartbeat looks stale -- reclaimReason pid-reused", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // alive, but under a DIFFERENT identity now
        startedAtMs: 1,
        procStart: "a-start-identity-that-is-not-this-process's",
        worktree: null,
        head: null,
        lockId: "reused-pid-token",
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 5000,
      pollIntervalMs: 10,
      heartbeatStaleMs: 1,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.reclaimedOrphan, true);
    assert.equal(r.reclaimReason, "pid-reused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: a lock whose heartbeat (L.alive.<lockId>) is FRESH is never reclaimed even though startIdentity is unknown -- waits normally and times out (cheap path short-circuits the identity query)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const realNow = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: realNow - 10,
        procStart: null, // unknown identity -- must not matter on the fresh path
        worktree: null,
        head: null,
        lockId: "fresh-owner-token",
      }),
    );
    writeFileSync(
      `${lockPath}.alive.fresh-owner-token`,
      JSON.stringify({ aliveAtMs: realNow - 10 }),
    );
    const start = Date.now();
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: realNow,
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    const elapsedWall = Date.now() - start;
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.reclaimedOrphan, false);
    assert.ok(
      elapsedWall < 5000,
      `must stay bounded (real wall time ${elapsedWall}ms) -- a hang would mean staleness false-positived`,
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.lockId, "fresh-owner-token", "untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4d: generation-numbered reclaim tickets -- exactly one concurrent
// reclaimer, an existing LIVE ticket holder blocks a second ticket --------

test("acquireRunnerLock: when a reclaim ticket for this orphan already exists and its holder is still ALIVE, a second caller does NOT create ticket k+1 -- it waits instead (single-reclaimer invariant)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, lockId: "O-token", procStart: null }),
    );
    // Pre-seed reclaim ticket k=1, held by a genuinely ALIVE pid (this
    // test's own process) -- simulates "someone else is already mid-reclaim".
    const tmp1 = `${lockPath}.reclaim.O-token.1.tmp`;
    writeFileSync(tmp1, JSON.stringify({ pid: process.pid, procStart: null }));
    linkSync(tmp1, `${lockPath}.reclaim.O-token.1`);
    unlinkSync(tmp1);

    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 1,
      timeoutMs: 100,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, false, "must not steal from an active reclaimer");
    assert.equal(r.timedOut, true);
    assert.equal(
      existsSync(`${lockPath}.reclaim.O-token.2`),
      false,
      "must never create ticket k+1 while ticket k's holder is alive",
    );
    assert.equal(
      existsSync(lockPath),
      true,
      "O's lock entry is untouched -- only ticket 1's (still-alive) holder may act on it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: when a reclaim ticket's holder is DEAD, the next caller creates ticket k+1 and proceeds (generation chain advances, no deadlock)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid1 = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    const deadPid2 = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid1, lockId: "O-token-2", procStart: null }),
    );
    writeFileSync(
      `${lockPath}.reclaim.O-token-2.1`,
      JSON.stringify({ pid: deadPid2, procStart: null }), // ticket 1's holder ALSO dead
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      timeoutMs: 5000,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true, "must advance past a dead ticket holder");
    assert.equal(r.reclaimedOrphan, true);
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: NEVER a rename/link-restore step anywhere on the reclaim path -- the function signature accepts no renameFn seam at all (되돌림 0, PM 설계 (d))", () => {
  // A white-box, source-level proof this round's own design promise holds:
  // 2R's acquireRunnerLock accepted a `renameFn` option used by the
  // reclaim path (tryReclaimOrphan). 3R's reclaim path (resolveContended
  // Step/createExclusive) never calls rename at all -- passing a renameFn
  // that throws if ever invoked must have NO effect on a successful
  // orphan reclaim.
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        lockId: "no-rename-token",
        procStart: null,
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      timeoutMs: 5000,
      pollIntervalMs: 10,
      renameFn: () => {
        throw new Error("renameFn must never be called -- 되돌림 0");
      },
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.equal(r.reclaimedOrphan, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §4e: createExclusive busy (EPERM/EBUSY/EACCES) handling --------------

test("acquireRunnerLock: a busy (EPERM) linkFn error is retried, not immediately thrown, and succeeds once the transient condition clears", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    let calls = 0;
    const linkFn = (src, dst) => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error("simulated transient EPERM");
        err.code = "EPERM";
        throw err;
      }
      return linkSync(src, dst);
    };
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: 1,
      timeoutMs: 5000,
      pollIntervalMs: 10,
      linkFn,
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true);
    assert.ok(calls >= 3, "must have retried past the simulated EPERM");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: a busy linkFn error that NEVER clears throws after the bounded retry window, instead of waiting forever", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const linkFn = () => {
      const err = new Error("permanently busy");
      err.code = "EBUSY";
      throw err;
    };
    assert.throws(
      () =>
        acquireRunnerLock({
          lockPath,
          pid: process.pid,
          startedAtMs: 1,
          timeoutMs: 5_000_000, // large -- must throw from busyRetryTimeoutMs, not this.
          pollIntervalMs: 5,
          busyRetryTimeoutMs: 40,
          linkFn,
          env: cleanEnv(),
        }),
      /busy \(EBUSY\) for over/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BUSY_RETRY_TIMEOUT_MS: named, positive, well below LOCK_WAIT_TIMEOUT_MS", () => {
  assert.ok(
    Number.isInteger(BUSY_RETRY_TIMEOUT_MS) && BUSY_RETRY_TIMEOUT_MS > 0,
  );
  assert.ok(BUSY_RETRY_TIMEOUT_MS < LOCK_WAIT_TIMEOUT_MS);
});

// -- §5: upper-bound timeout -----------------------------------------------

test("acquireRunnerLock: a lock held by a live, same-identity pid past the upper bound times out -- acquired:false, timedOut:true, no reclaim attempted", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: 1,
        procStart: defaultGetStartIdentity(process.pid),
        worktree: null,
        head: null,
        lockId: "live-same-identity",
      }),
    );
    const start = Date.now();
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: cleanEnv(),
    });
    const elapsedWall = Date.now() - start;
    assert.equal(r.acquired, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.reclaimedOrphan, false);
    assert.ok(
      r.waitMs >= 60,
      `waitMs (${r.waitMs}) must reach the 60ms upper bound`,
    );
    assert.ok(
      elapsedWall < 5000,
      `this test must stay bounded (real wall time ${elapsedWall}ms) -- a real hang would mean the upper bound stopped working`,
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(content.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §6: nested bypass (중첩 실행 교착 금지, unchanged mechanism) ---------

test("acquireRunnerLock: NESTED_LOCK_BYPASS_ENV_VAR set to the lock file's OWN lockId -> immediate bypass (nested:true, zero wait), the lock file is never touched", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const realLockId = "real-lock-token-abc";
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: 1,
        worktree: null,
        head: null,
        lockId: realLockId,
      }),
    );
    const before = readFileSync(lockPath, "utf8");
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: 2,
      timeoutMs: 50,
      pollIntervalMs: 5,
      env: { [NESTED_LOCK_BYPASS_ENV_VAR]: realLockId },
    });
    assert.equal(r.acquired, true);
    assert.equal(r.nested, true);
    assert.equal(r.waitMs, 0);
    assert.equal(r.pollCount, 0);
    assert.equal(r.nestedBypassRejected, false);
    assert.equal(
      readFileSync(lockPath, "utf8"),
      before,
      "nested bypass must never write/read-modify the file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock: NESTED_LOCK_BYPASS_ENV_VAR set to a value that does NOT match the lock file's lockId -> rejected, waits normally against the live owner, times out (nestedBypassRejected:true)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAtMs: Date.now(),
        procStart: defaultGetStartIdentity(process.pid),
        worktree: null,
        head: null,
        lockId: "the-real-token",
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid + 1,
      startedAtMs: Date.now(),
      timeoutMs: 60,
      pollIntervalMs: 10,
      env: { [NESTED_LOCK_BYPASS_ENV_VAR]: "a-forged-or-stale-token" },
    });
    assert.equal(r.acquired, false);
    assert.equal(r.nested, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.nestedBypassRejected, true);
    assert.ok(
      r.waitMs >= 60,
      `a rejected bypass must wait the real upper bound, not skip it (waitMs=${r.waitMs})`,
    );
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(
      content.lockId,
      "the-real-token",
      "the file must be untouched -- a rejected bypass never claims/reclaims",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §7: write failures propagate (never silently "acquired") ------------

test("acquireRunnerLock: a non-EEXIST, non-busy write failure (e.g. missing lock directory) propagates -- never silently treated as acquired", () => {
  const writeFileFn = () => {
    const err = new Error("ENOENT: no such directory");
    err.code = "ENOENT";
    throw err;
  };
  assert.throws(
    () =>
      acquireRunnerLock({
        lockPath: "/does/not/exist/r.lock",
        writeFileFn,
        env: cleanEnv(),
      }),
    /ENOENT/,
  );
});

// -- §8: named constants ---------------------------------------------------

test("LOCK_POLL_INTERVAL_MS/LOCK_WAIT_TIMEOUT_MS: named, positive, poll interval well below the upper bound", () => {
  assert.ok(
    Number.isInteger(LOCK_POLL_INTERVAL_MS) && LOCK_POLL_INTERVAL_MS > 0,
  );
  assert.ok(Number.isInteger(LOCK_WAIT_TIMEOUT_MS) && LOCK_WAIT_TIMEOUT_MS > 0);
  assert.ok(LOCK_POLL_INTERVAL_MS < LOCK_WAIT_TIMEOUT_MS);
});

// HYK-494 3R (judgment 23:5x §1 ⑴ "N=10초, M=3분 -- 판정 제안과 같다",
// values changed from 2R's 30s/90s -- fixture sync, real behavior change).
test("HEARTBEAT_INTERVAL_MS/HEARTBEAT_STALE_MS: 10s/3min (judgment §1 ⑴), named, positive, interval well below the staleness limit, and both well below LOCK_WAIT_TIMEOUT_MS", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 10 * 1000);
  assert.equal(HEARTBEAT_STALE_MS, 3 * 60 * 1000);
  assert.ok(
    Number.isInteger(HEARTBEAT_INTERVAL_MS) && HEARTBEAT_INTERVAL_MS > 0,
  );
  assert.ok(Number.isInteger(HEARTBEAT_STALE_MS) && HEARTBEAT_STALE_MS > 0);
  assert.ok(
    HEARTBEAT_INTERVAL_MS < HEARTBEAT_STALE_MS,
    "a single missed tick must not immediately look stale",
  );
  assert.ok(
    HEARTBEAT_STALE_MS < LOCK_WAIT_TIMEOUT_MS,
    "a pid-reuse orphan must be reclaimable well before the full 20-minute upper bound",
  );
});

// -- §9: installLockReleaseOnSignal (unchanged) ---------------------------

test("installLockReleaseOnSignal: emitting SIGINT on the (fake) process calls release() then exits with a non-zero code", () => {
  const fakeProcess = new EventEmitter();
  let exitCode = null;
  fakeProcess.exit = (code) => {
    exitCode = code;
  };
  let released = false;
  const uninstall = installLockReleaseOnSignal({
    processRef: fakeProcess,
    release: () => {
      released = true;
    },
  });
  fakeProcess.emit("SIGINT");
  assert.equal(released, true);
  assert.equal(exitCode, 1);
  uninstall();
  assert.equal(
    fakeProcess.listenerCount("SIGINT"),
    0,
    "uninstall must remove the handler",
  );
});

test("installLockReleaseOnSignal: release() throwing still exits (best-effort -- a cleanup failure must not hang the process)", () => {
  const fakeProcess = new EventEmitter();
  let exitCode = null;
  fakeProcess.exit = (code) => {
    exitCode = code;
  };
  installLockReleaseOnSignal({
    processRef: fakeProcess,
    release: () => {
      throw new Error("release blew up");
    },
  });
  assert.doesNotThrow(() => fakeProcess.emit("SIGTERM"));
  assert.equal(exitCode, 1);
});

// -- §10: real-child-process proof (ⓒ⑴) ----------------------------------

// HYK-498 §2 ⓘⓘⓘ(정보 2): 고정 15000ms -> GENEROUS_EVENTUAL_ACQUIRE_
// TIMEOUT_MS(20초, 2-way/5-way와 같은 상수) -- 자식 스크립트는 문자열로
// 생성돼 별도 프로세스에서 돈다, 부모의 JS 변수를 직접 참조할 수 없어
// 생성 시점에 `${}`로 값을 박아 넣는다(이 파일의 다른 모든 자식 스크립트
// 생성자와 같은 기법, 예: RUNNER_LOCK_URL). GREEN 칸의 wallMs>=450 단언은
// holdMs(250ms×2)만으로 성립하므로(:1611 부근) 이 상한 증가로 깨지지
// 않는다 -- 상한은 "굶었을 때만" 소진된다.
function lockRaceChildScript() {
  return [
    `import { acquireRunnerLock, releaseRunnerLock } from ${JSON.stringify(RUNNER_LOCK_URL)};`,
    `import { writeFileSync, appendFileSync } from "node:fs";`,
    `const lockPath = process.argv[1];`,
    `const holdMs = Number(process.argv[2]);`,
    `const outPath = process.argv[3];`,
    `const noLock = process.argv[4] === "1";`,
    `let r = { waitMs: 0, pollCount: 0, reclaimedOrphan: false, nested: false, lockId: null };`,
    `if (!noLock) r = acquireRunnerLock({ lockPath, pollIntervalMs: 15, timeoutMs: ${GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS} });`,
    `const acquiredAtMs = Date.now();`,
    `writeFileSync(outPath, JSON.stringify({ pid: process.pid, acquiredAtMs, r }) + "\\n");`,
    `await new Promise((res) => setTimeout(res, holdMs));`,
    `const releasedAtMs = Date.now();`,
    `if (!noLock) releaseRunnerLock({ lockPath, lockId: r.lockId });`,
    `appendFileSync(outPath, JSON.stringify({ releasedAtMs }) + "\\n");`,
  ].join("\n");
}

function spawnRaceChild({ lockPath, holdMs, outPath, noLock }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        lockRaceChildScript(),
        "--",
        lockPath,
        String(holdMs),
        outPath,
        noLock ? "1" : "0",
      ],
      { stdio: "ignore", env: cleanEnv() },
    );
    child.on("exit", (code) => resolve(code));
  });
}

function readRaceOutput(outPath) {
  const [first, second] = readFileSync(outPath, "utf8").trim().split("\n");
  return { ...JSON.parse(first), ...JSON.parse(second) };
}

test("RED baseline (no lock at all): two real child processes started together overlap -- this is the exact race HYK-494 was opened to close", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "race.lock");
  const out1 = join(dir, "out1.json");
  const out2 = join(dir, "out2.json");
  try {
    const codes = await Promise.all([
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out1, noLock: true }),
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out2, noLock: true }),
    ]);
    assert.deepEqual(codes, [0, 0]);
    const a = readRaceOutput(out1);
    const b = readRaceOutput(out2);
    const overlap =
      Math.min(a.releasedAtMs, b.releasedAtMs) -
      Math.max(a.acquiredAtMs, b.acquiredAtMs);
    assert.ok(
      overlap > 0,
      `RED baseline must overlap (got overlap=${overlap}ms) -- without the lock, two started-together processes' hold windows intersect`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GREEN (locked): two real child processes started together on the SAME lock path never overlap -- one waits for the other", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "race.lock");
  const out1 = join(dir, "out1.json");
  const out2 = join(dir, "out2.json");
  try {
    const t0 = Date.now();
    const codes = await Promise.all([
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out1, noLock: false }),
      spawnRaceChild({ lockPath, holdMs: 250, outPath: out2, noLock: false }),
    ]);
    const wallMs = Date.now() - t0;
    assert.deepEqual(codes, [0, 0]);
    const a = readRaceOutput(out1);
    const b = readRaceOutput(out2);
    const overlap =
      Math.min(a.releasedAtMs, b.releasedAtMs) -
      Math.max(a.acquiredAtMs, b.acquiredAtMs);
    assert.ok(overlap <= 0, `locked run must NOT overlap (got ${overlap}ms)`);
    assert.ok(
      wallMs >= 450,
      `serialized total wall time (${wallMs}ms) should be close to holdMs*2=500ms, never ~250ms (parallel)`,
    );
    const waiter = a.r.waitMs > b.r.waitMs ? a : b;
    assert.ok(
      waiter.r.waitMs > 0,
      "exactly one child must have recorded a real wait",
    );
    assert.equal(
      existsSync(lockPath),
      false,
      "both children released -- nothing left behind",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §10b: clock-independent, critical-section-marker real-process proofs
// (review's own method -- a `wx` marker makes "two in the critical section
// at once" an EEXIST fact, never a timing comparison) --------------------

function reclaimRaceChildScript() {
  return [
    `import { acquireRunnerLock, releaseRunnerLock } from ${JSON.stringify(RUNNER_LOCK_URL)};`,
    `import { writeFileSync, unlinkSync } from "node:fs";`,
    `const lockPath = process.argv[1];`,
    `const csPath = process.argv[2];`,
    `const outPath = process.argv[3];`,
    `const holdMs = Number(process.argv[4]);`,
    `const pollIntervalMs = Number(process.argv[5]);`,
    `const timeoutMs = Number(process.argv[6]);`,
    `const r = acquireRunnerLock({ lockPath, pollIntervalMs, timeoutMs });`,
    `let violation = false;`,
    `let csCreated = false;`,
    `if (r.acquired) {`,
    `  try { writeFileSync(csPath, String(process.pid), { flag: "wx" }); csCreated = true; }`,
    `  catch (e) { violation = true; }`,
    `  await new Promise((res) => setTimeout(res, holdMs));`,
    `  if (csCreated) { try { unlinkSync(csPath); } catch (e) {} }`,
    `  releaseRunnerLock({ lockPath, lockId: r.lockId });`,
    `}`,
    `writeFileSync(outPath, JSON.stringify({ pid: process.pid, acquired: r.acquired, reclaimedOrphan: r.reclaimedOrphan, reclaimReason: r.reclaimReason ?? null, timedOut: r.timedOut, violation }));`,
  ].join("\n");
}

// product_scope ⓘⓘ (CI-② 원인 후보 2, 검토 2R §2 ⓓ): 수리 전에는
// `stdio: "ignore"`라 자식 stderr가 버려지고 `error` 이벤트 처리도 없었다
// -- 자식이 비정상 종료하면(메모리 압박 · spawn 실패 · 모듈 로드 실패)
// `exit` 처리기의 `JSON.parse(readFileSync(outPath, ...))`가 ENOENT를
// 그대로 던져(RED-first 확인: 2026-11-09 abnormal-exit seam 재현, 아래
// §0 답 참고) "어느 자식이 왜"가 CI 로그에 안 남았다. 이제 stderr를
// 파이프로 받고 `error` 이벤트를 흡수하고, 출력 파일 읽기 자체가 실패해도
// 던지지 않고 "결과"로 수집한다(`missingOutput:true` + exitCode/signal/
// spawnErrorMessage/readErrorMessage) -- 모든 호출자(§10b/§10b-2의 모든
// 칸)가 자동으로 이 혜택을 받는다. `elapsedMs`/`stderrTail`은 성공·실패
// 모두에 실어, 실패 단언 메시지가 회차별 3자 결과 JSON·경과 ms·stderr
// 꼬리를 그대로 보여주게 한다(product_scope ⓘⓘ 문면 그대로).
//
// HYK-498 §2 ⓘⓘⓘⓘ(P2-2, 검토 3R §3 "P2-2" 그대로): `exit`는 Node 문서상
// 자식의 stdio 스트림이 아직 열려 있는 상태에서도 먼저 올 수 있다 --
// 사망 직전 stderr 줄이 그 사이 늦게 도착하면 `stderrTail`이 비거나
// 잘린 채로 확정된다(검토 3R: 로컬 5/5는 전문이 실렸지만 Linux CI는
// 〔못쟀다〕). `close`는 모든 stdio 스트림이 닫힌 "뒤"에만 온다(Node
// 문서) -- stderrTail을 그 시점에 확정하면 이 창이 구조적으로 없어진다.
const STDERR_TAIL_CHARS = 2000;

function spawnReclaimRaceChild({
  lockPath,
  csPath,
  outPath,
  holdMs,
  pollIntervalMs,
  timeoutMs,
}) {
  const startMs = Date.now();
  return new Promise((resolve) => {
    let stderrChunks = "";
    let spawnErrorMessage = null;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        reclaimRaceChildScript(),
        "--",
        lockPath,
        csPath,
        outPath,
        String(holdMs),
        String(pollIntervalMs),
        String(timeoutMs),
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: cleanEnv() },
    );
    child.stderr.on("data", (chunk) => {
      stderrChunks += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      spawnErrorMessage = err?.message ?? String(err);
    });
    // HYK-498 P2-2: `close` (not `exit`) -- see STDERR_TAIL_CHARS header
    // above. `close`'s own callback signature is the same (code, signal).
    child.on("close", (exitCode, signal) => {
      const elapsedMs = Date.now() - startMs;
      const stderrTail = stderrChunks.slice(-STDERR_TAIL_CHARS);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(outPath, "utf8"));
      } catch (readErr) {
        resolve({
          acquired: false,
          violation: false,
          missingOutput: true,
          exitCode,
          signal,
          spawnErrorMessage,
          readErrorMessage: readErr?.message ?? String(readErr),
          elapsedMs,
          stderrTail,
        });
        return;
      }
      resolve({ ...parsed, exitCode, signal, elapsedMs, stderrTail });
    });
  });
}

// HYK-498 §2 ⓘⓘ: 자식별 고정 클럭으로 "결국 획득"을 판정하는 칸은 이
// 2-way 칸 · 5개 3-way 칸(THREE_WAY_*, 아래) · 5-way 칸(FIVE_WAY_TRIALS,
// 아래) 7개 모두 같은 모양이다. #358(HYK-494 후속 5R)은 5개 3-way 칸만
// 5000ms/8000ms -> `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`(20_000ms)로
// 올리고 이 2-way 칸과 5-way 칸은 명시적으로 범위 밖(deviation_rule,
// "3-way 칸" 문면)으로 남겼다(검토 3R "정보" 항목, :1683-1684 옛 주석).
// 이 라운드(product_scope ⓘⓘ)가 그 둘에도 같은 처방을 준다 -- "결국
// 획득" 판정에서 시계 의존을 완전히 제거하는 대신(폴링 루프 자체가
// 무한 대기가 되면 busyRetryTimeoutMs 기본값과의 상호작용이 복잡해진다,
// 5R과 같은 근거) 상한만 넉넉히 늘린다(5R이 고른 옵션과 동일). `wx`
// 배제 위반 0 단언과 전원 획득 단언은 그대로 유지한다(단언 약화 아님).
// `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS` 정의는 이 라운드가 파일 앞쪽
// (freshLockDir 바로 아래)으로 옮겼다 -- waitForFileToExist/P1-1/§10도
// 같은 상수를 쓴다(아래 §0 답, 정보 1~2).

const RECLAIM_TRIALS = 10;

test(`GREEN (compare-and-delete reclaim): ${RECLAIM_TRIALS} trials of 2 real children racing a lock pre-seeded with a DEAD pid's orphan content -- zero critical-section violations`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < RECLAIM_TRIALS; trial += 1) {
      const lockPath = join(dir, `race-${trial}.lock`);
      const csPath = join(dir, `cs-${trial}.marker`);
      const out1 = join(dir, `out-${trial}-1.json`);
      const out2 = join(dir, `out-${trial}-2.json`);
      const deadPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          startedAtMs: 1,
          worktree: null,
          head: null,
          lockId: `dead-${trial}`,
        }),
      );
      const [a, b] = await Promise.all([
        spawnReclaimRaceChild({
          lockPath,
          csPath,
          outPath: out1,
          holdMs: 40,
          pollIntervalMs: 10,
          timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
        }),
        spawnReclaimRaceChild({
          lockPath,
          csPath,
          outPath: out2,
          holdMs: 40,
          pollIntervalMs: 10,
          timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
        }),
      ]);
      if (a.violation || b.violation) violations += 1;
      assert.ok(
        a.acquired && b.acquired,
        // HYK-498 §2 ⓘ(P2-A): 3-way 칸과 같은 모양으로 자식별 결과(stderr
        // 꼬리 · exitCode · 경과 ms, spawnReclaimRaceChild가 이미 싣는
        // 필드 그대로)를 메시지에 실어, 빨간 CI 로그에 "어느 자식이 왜"가
        // 남게 한다(product_scope ⓘ 그대로).
        `trial ${trial}: both children must eventually acquire (serialized) -- ${JSON.stringify({ a, b })}`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: released`);
      assert.equal(existsSync(csPath), false, `trial ${trial}: marker gone`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${RECLAIM_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// product_scope ⓘ (CI-② 원인 후보 1, 검토 2R §2 ⓓ): 자식별 고정
// 5초(또는 8초) 시계로 "결국 획득"을 판정하면, CI 중첩 스윕의 CPU
// 과포화에서 굶은 자식이 그 안에 못 잡는다 -- 알고리즘 결함이 아니라
// 시험 자신의 시계 상한이 짧은 것이다(RED-first 2026-11-09 확인: 실제
// 홀더가 6000ms 를 쥐고 있을 때 고정 5000ms 획득자는 결정적으로
// timedOut:true 였고, 20000ms 로 올리자 같은 조건에서 acquired:true 로
// 뒤집혔다 -- 아래 §0 답 참고). 칸 전체 시간 상한(파일 단독 ≤150초)은
// 보통 경로(이 머신, 굶음 없음)에서 각 trial이 즉시 끝나므로 영향받지
// 않는다 -- 이 상한이 실제로 소진되는 경우는 정말로 20초 가까이 굶는
// trial이 여러 번 겹칠 때뿐이고, 그건 시험의 시계가 아니라 알고리즘
// 자체의 문제라 별도 신호다. 같은 모양(자식별 고정 클럭 + "결국 획득"
// 판정)의 3-way 칸을 재검색해 cold-start(:1707 아래) · 이 칸(orphan) ·
// dead-ticket(:1811 아래) · staggered-alive(:1907 아래) · pid-reuse
// (:1973 아래) 5개에 모두 적용한다. `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`
// 는 위(2-way RECLAIM_TRIALS 바로 앞)에서 이미 정의했다 -- HYK-498이
// 2-way·5-way 칸까지 같은 상수로 넓혔다(위 주석 참고, 더는 "3-way만"이
// 아니다).
const THREE_WAY_TRIALS = 15;

test(`GREEN (3-way cold-start contention): ${THREE_WAY_TRIALS} trials of 3 real children racing a lock with NO pre-existing file -- zero critical-section violations`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < THREE_WAY_TRIALS; trial += 1) {
      const lockPath = join(dir, `cold-${trial}.lock`);
      const csPath = join(dir, `cold-cs-${trial}.marker`);
      const outs = [0, 1, 2].map((i) =>
        join(dir, `cold-out-${trial}-${i}.json`),
      );
      const results = await Promise.all(
        outs.map((outPath) =>
          spawnReclaimRaceChild({
            lockPath,
            csPath,
            outPath,
            holdMs: 20,
            pollIntervalMs: 5,
            timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
          }),
        ),
      );
      if (results.some((r) => r.violation)) violations += 1;
      assert.ok(
        results.every((r) => r.acquired),
        `trial ${trial}: all 3 must eventually acquire -- ${JSON.stringify(results)}`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: no leftover`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${THREE_WAY_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// product_scope 1b_exec_line ⑴ "3 × 고아 30" -- the exact P1-A repro shape
// (review-2 §2 ⓐ: 고아 + 3자, 30 trials, 15/30 violations on 2R) -- NEW this
// round, required by the dispatch task explicitly (the old suite only had
// 2-way orphan and 3-way COLD-START, never 3-way ORPHAN).
const THREE_WAY_ORPHAN_TRIALS = 30;

test(`GREEN (3-way orphan contention, the exact P1-A repro shape): ${THREE_WAY_ORPHAN_TRIALS} trials of 3 real children racing a lock PRE-SEEDED with a DEAD pid's orphan content -- zero critical-section violations (2R's own repro: 15/30)`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    let owners = new Set();
    for (let trial = 0; trial < THREE_WAY_ORPHAN_TRIALS; trial += 1) {
      const lockPath = join(dir, `orph-${trial}.lock`);
      const csPath = join(dir, `orph-cs-${trial}.marker`);
      const outs = [0, 1, 2].map((i) =>
        join(dir, `orph-out-${trial}-${i}.json`),
      );
      const deadPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          lockId: `orph-${trial}`,
          // product_scope ⓘⓘⓘ(원인 후보 3, 검토 2R §2 ⓓ): procStart를
          // 안 실으면(= undefined, `!= null` 비교에서 null과 동치),
          // CI 중첩 스윕에서 deadPid가 다른 살아있는 프로세스로 재사용될
          // 경우 judgeOwner/identityIsDead(runner-lock.mjs:268-282)가
          // "낡음/신원 모름 -> ALIVE"로 오판해 아무도 회수하지 않고
          // 3자 모두 시계 상한까지 간다. 죽은 프로세스의 "진짜" 시작
          // 신원은 죽은 뒤 다시 구할 수 없으므로(Windows: `Get-Process`가
          // ESRCH로 실패), 재사용자의 실제 신원과 결코 같을 수 없는
          // 비-null 자리표시자를 심어 "신원 불일치 -> pid-reused"(dead)
          // 가지로 떨어지게 한다 -- pid가 재사용되지 않은(이 머신의
          // 보통 경우) isPidAliveFn이 그보다 먼저 false를 돌려
          // "pid-dead"로 즉시 판정하므로(:306) 이 자리표시자는 그 경로엔
          // 영향이 없다(fixture 현실화, pid-reuse-simulated 칸의
          // "not-this-process's-real-identity" 자리표시자와 같은 기법).
          procStart: `dead-orphan-seed-${trial}`,
        }),
      );
      const results = await Promise.all(
        outs.map((outPath) =>
          spawnReclaimRaceChild({
            lockPath,
            csPath,
            outPath,
            holdMs: 30,
            pollIntervalMs: 10,
            timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
          }),
        ),
      );
      if (results.some((r) => r.violation)) violations += 1;
      for (const r of results) if (r.reclaimReason) owners.add(r.reclaimReason);
      assert.ok(
        results.every((r) => r.acquired),
        `trial ${trial}: all 3 must eventually acquire -- ${JSON.stringify(results)}`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: no leftover`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${THREE_WAY_ORPHAN_TRIALS} trials saw a critical-section violation (2R's own repro: 15/30) -- 〔직접〕 finite sample, this machine, this run`,
    );
    assert.ok(owners.has("pid-dead"), "at least one reclaim must be pid-dead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §10b-2: HYK-494 후속 P2-5 -- the 4 missing real-process rows REVIEW
// flagged (실제 프로세스 "3 + 죽은 회수권" · "5 진입" · "3 · 살아 있는 주인
// 짧게 쥠" · "3 · 재사용 흉내") -- all 4 were already measured 0/N in
// REVIEW's own ad-hoc driver (〔직접〕), this closes the regression-net gap
// by committing them as real-child-process tests reusing the SAME
// spawnReclaimRaceChild/reclaimRaceChildScript helpers as §10b above ------

const DEAD_TICKET_THREE_WAY_TRIALS = 10;

test(`GREEN (3-way orphan contention WITH a pre-existing DEAD reclaim ticket #1): ${DEAD_TICKET_THREE_WAY_TRIALS} trials of 3 real children racing a lock pre-seeded with a DEAD pid's orphan content AND a dead ticket #1 -- the generation chain must advance past the dead ticket, zero critical-section violations (P2-5, 실제 프로세스 "3 + 죽은 회수권")`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < DEAD_TICKET_THREE_WAY_TRIALS; trial += 1) {
      const lockPath = join(dir, `dt-${trial}.lock`);
      const csPath = join(dir, `dt-cs-${trial}.marker`);
      const outs = [0, 1, 2].map((i) => join(dir, `dt-out-${trial}-${i}.json`));
      const deadOwnerPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      const deadTicketPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadOwnerPid,
          lockId: `dt-owner-${trial}`,
          // 같은 모양 (ⓘⓘⓘ) -- 이 칸도 같은 수리를 받는다 (ⓘⓘⓘⓘ).
          procStart: `dead-dt-owner-seed-${trial}`,
        }),
      );
      writeFileSync(
        `${lockPath}.reclaim.dt-owner-${trial}.1`,
        JSON.stringify({
          pid: deadTicketPid,
          procStart: `dead-dt-ticket-seed-${trial}`,
        }),
      );
      const results = await Promise.all(
        outs.map((outPath) =>
          spawnReclaimRaceChild({
            lockPath,
            csPath,
            outPath,
            holdMs: 20,
            pollIntervalMs: 5,
            timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
          }),
        ),
      );
      if (results.some((r) => r.violation)) violations += 1;
      assert.ok(
        results.every((r) => r.acquired),
        `trial ${trial}: all 3 must eventually acquire -- ${JSON.stringify(results)}`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: released`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${DEAD_TICKET_THREE_WAY_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-498 §2 ⓘⓘ: 5-way도 같은 클럭-의존 모양이다 -- #358(5R)은 "3-way
// 칸"으로 범위를 적어(deviation_rule) 이 칸을 명시적으로 뺐지만(검토 3R
// "정보" 항목, 5-way가 3-way보다 굶기 쉬운 모양이라는 추론과 함께), 이
// 라운드가 그 범위를 2-way·5-way까지 넓힌다(위 RECLAIM_TRIALS 앞 주석
// 참고) -- 같은 `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`를 쓴다.
const FIVE_WAY_TRIALS = 10;

test(`GREEN (5-way cold-start contention): ${FIVE_WAY_TRIALS} trials of 5 real children racing a lock with NO pre-existing file -- zero critical-section violations (P2-5, 실제 프로세스 "5 진입")`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < FIVE_WAY_TRIALS; trial += 1) {
      const lockPath = join(dir, `five-${trial}.lock`);
      const csPath = join(dir, `five-cs-${trial}.marker`);
      const outs = [0, 1, 2, 3, 4].map((i) =>
        join(dir, `five-out-${trial}-${i}.json`),
      );
      const results = await Promise.all(
        outs.map((outPath) =>
          spawnReclaimRaceChild({
            lockPath,
            csPath,
            outPath,
            holdMs: 15,
            pollIntervalMs: 5,
            timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
          }),
        ),
      );
      if (results.some((r) => r.violation)) violations += 1;
      assert.ok(
        results.every((r) => r.acquired),
        // HYK-498 §2 ⓘ(P2-A): 3-way 칸과 같은 모양(:1857 부근 `${JSON.
        // stringify(results)}`) -- results 배열이 이미 자식별 stderr
        // 꼬리 · exitCode · 경과 ms를 싣는다.
        `trial ${trial}: all 5 must eventually acquire -- ${JSON.stringify(results)}`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: released`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${FIVE_WAY_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STAGGERED_ALIVE_TRIALS = 10;

test(`GREEN (staggered start, ALIVE owner held briefly then 2 late entrants): ${STAGGERED_ALIVE_TRIALS} trials -- an owner acquires and holds BRIEFLY before 2 more real children start, all 3 eventually acquire, zero critical-section violations (P2-5, 실제 프로세스 "3 · 살아 있는 주인 짧게 쥠")`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < STAGGERED_ALIVE_TRIALS; trial += 1) {
      const lockPath = join(dir, `stag-${trial}.lock`);
      const csPath = join(dir, `stag-cs-${trial}.marker`);
      const outOwner = join(dir, `stag-owner-${trial}.json`);
      const out2 = join(dir, `stag-2-${trial}.json`);
      const out3 = join(dir, `stag-3-${trial}.json`);
      const ownerPromise = spawnReclaimRaceChild({
        lockPath,
        csPath,
        outPath: outOwner,
        holdMs: 80,
        pollIntervalMs: 5,
        timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
      });
      // Give the owner time to genuinely acquire before the late entrants
      // even start -- this is the "살아 있는 주인 짧게 쥠" shape, distinct
      // from the all-start-simultaneously cold-start cell above.
      await new Promise((res) => setTimeout(res, 25));
      const [ownerResult, r2, r3] = await Promise.all([
        ownerPromise,
        spawnReclaimRaceChild({
          lockPath,
          csPath,
          outPath: out2,
          holdMs: 20,
          pollIntervalMs: 5,
          timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
        }),
        spawnReclaimRaceChild({
          lockPath,
          csPath,
          outPath: out3,
          holdMs: 20,
          pollIntervalMs: 5,
          timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
        }),
      ]);
      const all = [ownerResult, r2, r3];
      if (all.some((r) => r.violation)) violations += 1;
      assert.ok(
        all.every((r) => r.acquired),
        `trial ${trial}: all 3 must eventually acquire -- ${JSON.stringify(all)}`,
      );
      assert.equal(
        ownerResult.reclaimedOrphan,
        false,
        `trial ${trial}: a genuinely alive owner must never be the reclaim target`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: released`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${STAGGERED_ALIVE_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PID_REUSE_THREE_WAY_TRIALS = 10;

test(`GREEN (3-way pid-reuse-simulated contention): ${PID_REUSE_THREE_WAY_TRIALS} trials of 3 real children racing a lock pre-seeded with a genuinely ALIVE pid but a MISMATCHED startIdentity (pid-reuse shape) -- reclaimed via reclaimReason pid-reused, zero critical-section violations (P2-5, 실제 프로세스 "3 · 재사용 흉내")`, async () => {
  const dir = freshLockDir();
  try {
    let violations = 0;
    for (let trial = 0; trial < PID_REUSE_THREE_WAY_TRIALS; trial += 1) {
      const lockPath = join(dir, `reuse-${trial}.lock`);
      const csPath = join(dir, `reuse-cs-${trial}.marker`);
      const outs = [0, 1, 2].map((i) =>
        join(dir, `reuse-out-${trial}-${i}.json`),
      );
      const aliveHolder = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 4000)"],
        { stdio: "ignore" },
      );
      await new Promise((res) => setTimeout(res, 15)); // let it really start.
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: aliveHolder.pid,
          startedAtMs: 1,
          procStart: "not-this-process's-real-identity",
          worktree: null,
          head: null,
          lockId: `reuse-${trial}`,
        }),
      );
      const results = await Promise.all(
        outs.map((outPath) =>
          spawnReclaimRaceChild({
            lockPath,
            csPath,
            outPath,
            holdMs: 20,
            pollIntervalMs: 10,
            timeoutMs: GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS,
          }),
        ),
      );
      aliveHolder.kill();
      if (results.some((r) => r.violation)) violations += 1;
      assert.ok(
        results.every((r) => r.acquired),
        `trial ${trial}: all 3 must eventually acquire -- ${JSON.stringify(results)}`,
      );
      assert.ok(
        results.some((r) => r.reclaimReason === "pid-reused"),
        `trial ${trial}: at least one child must reclaim via pid-reused`,
      );
      assert.equal(existsSync(lockPath), false, `trial ${trial}: released`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${PID_REUSE_THREE_WAY_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §10c: T0 -- the platform premise design doc §3-1 ① measured once by
// hand, now a repeatable regression test: link() onto an EXISTING name
// never overwrites it -----------------------------------------------------

test("T0: linkSync on THIS machine's filesystem never overwrites an existing destination name -- EEXIST, original bytes untouched (design doc §3-1 ①, 판단 유보 전제 재확인)", () => {
  const dir = freshLockDir();
  const target = join(dir, "t0.lock");
  const original = "ORIGINAL-CONTENT";
  writeFileSync(target, original);
  const tmp = join(dir, "t0.tmp");
  writeFileSync(tmp, "NEW-CONTENT-THAT-MUST-NEVER-LAND");
  try {
    assert.throws(
      () => linkSync(tmp, target),
      (err) => err.code === "EEXIST",
      "link onto an existing name must fail EEXIST, never silently succeed",
    );
    assert.equal(
      readFileSync(target, "utf8"),
      original,
      "the existing destination's bytes must be byte-for-byte unchanged after the failed link",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §10d: HYK-494 후속 P2-5 -- D2, a BOUNDED cross-insertion enumeration
// (PM design (e) D2's own method, scoped down -- 〔직접〕 3 insertion points
// × this round's current reclaim sequence, NOT the "수백 경우" full
// combinatorial sweep D2 originally named; universal_claim_discipline: this
// is a reduced, honestly-scoped approximation, not the full enumeration).
// Each insertion point runs a FULL competing actor B (real acquire+release,
// same in-process synchronous seams) to completion in the middle of actor
// A's own reclaim sequence, then lets A resume with whatever A's own
// earlier reads already captured -- exactly the "stale assumption after B
// fully ran" shape P2-2/P2-3 fix. Invariant checked every time: "concurrent
// owners ≤ 1" never breaks (operationalized here as: B never corrupts A's
// own eventual, correct outcome, and the lock ends up released by whichever
// of A/B finishes last) ----------------------------------------------------

function runActorBOnce({ lockPath, timeoutMs = 300, pollIntervalMs = 5 }) {
  const r = acquireRunnerLock({
    lockPath,
    pid: process.pid,
    startedAtMs: Date.now(),
    timeoutMs,
    pollIntervalMs,
    env: cleanEnv(),
  });
  if (r.acquired) {
    releaseRunnerLock({ lockPath, lockId: r.lockId });
  }
  return r;
}

// HYK-498 §13-9 수리 확인(〔직접〕, production acquireRunnerLock 진입점 그대로
// 구동): a third insertion point ("before-ticket-link", B fires AFTER A's
// tmp write but BEFORE A's own linkFn) surfaces the EXACT narrow race 검토
// 3R의 probe-prefix-gap.mjs가 결정적으로 재현한 것과 같은 모양이다--
// cleanupAfterReclaim의 접두 매칭(수리 전)이 다른 회수권자의 in-flight
// `reclaim.<lockId>.<k>.tmp.<suffix>` 파일까지 지워 그 쪽의 linkSync를
// ENOENT로 실패시킨다. **base(#358/6d7bed1) 위에서는 이 세 번째 삽입점이
// RED였다**(결과 파일의 RED-first 원문 참고) -- B가 전체 획득+해제를
// 끝내며 cleanupAfterReclaim(lockId="d2-dead-owner")을 부르면, A가 막
// 쓴(아직 link 전) ticket tmp가 그 접두 스캔에 걸려 지워지고, 재개된
// A의 realLinkFn 호출이 ENOENT로 throw한다(uncaught -- 시험 자체가
// 크래시). **HYK-498 수리 뒤에는 GREEN이다**: cleanupAfterReclaim이
// 완성된(숫자만인 suffix) 티켓 이름만 지우므로 A의 tmp는 살아남고,
// A의 링크가 성공한 뒤(ticket #1을 다시 만들 자리가 비어 있으면 그
// 자리를 그대로 쓴다) A는 정상적으로 이어간다 -- 아래처럼 3개 삽입점
// 전부 돈다(기존 2개 + 이 세 번째, 단언 약화 0).
test("D2: 3 insertion points -- a FULL competing actor B runs to completion in the middle of actor A's own reclaim sequence (between ticket-create and reread / between reread and unlink / between A's own tmp write and A's own link) -- the single-reclaimer invariant survives every insertion, A still ends up correctly acquiring+releasing (HYK-498 §13-9 fix, production acquireRunnerLock)", () => {
  const insertionPoints = [
    "before-reread",
    "before-unlink",
    "before-ticket-link",
  ];
  for (const point of insertionPoints) {
    const dir = freshLockDir();
    const lockPath = join(dir, "r.lock");
    try {
      const deadPid = spawnSync(process.execPath, [
        "-e",
        "process.exit(0)",
      ]).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          lockId: "d2-dead-owner",
          procStart: null,
        }),
      );
      let fired = false;
      const bResults = [];
      const fireB = () => {
        if (fired) return;
        fired = true;
        bResults.push(runActorBOnce({ lockPath }));
      };
      const realReadFileFn = (p, enc) => readFileSync(p, enc);
      let lockReadCount = 0;
      const readFileFn = (p, enc) => {
        if (point === "before-reread" && p === lockPath) {
          lockReadCount += 1;
          if (lockReadCount === 2) fireB(); // the reread call, before it runs.
        }
        return realReadFileFn(p, enc);
      };
      const realUnlinkFn = unlinkSync;
      const unlinkFn = (p) => {
        if (point === "before-unlink" && p === lockPath) fireB();
        return realUnlinkFn(p);
      };
      // HYK-498 §13-9: fires B right after A's createExclusive has written
      // its OWN reclaim-ticket tmp file but before A's own linkFn runs --
      // the exact window cleanupAfterReclaim's prefix-match bug could land
      // in (destPath here is the ticket's FINAL name, never lockPath itself,
      // since A's reclaim-ticket createExclusive always runs after A's own
      // lockPath createExclusive has already failed EEXIST).
      const realLinkFn = linkSync;
      const linkFn = (tmpPath, destPath) => {
        if (point === "before-ticket-link" && destPath.includes(".reclaim.")) {
          fireB();
        }
        return realLinkFn(tmpPath, destPath);
      };
      const a = acquireRunnerLock({
        lockPath,
        pid: process.pid,
        startedAtMs: 1,
        timeoutMs: 5000,
        pollIntervalMs: 5,
        readFileFn,
        unlinkFn,
        linkFn,
        env: cleanEnv(),
      });
      if (a.acquired) releaseRunnerLock({ lockPath, lockId: a.lockId });
      assert.ok(
        a.acquired || bResults.some((r) => r.acquired),
        `[${point}]: at least one of A/B must have acquired -- the lock must never vanish for everyone`,
      );
      assert.equal(
        existsSync(lockPath),
        false,
        `[${point}]: whichever of A/B finished last must leave L released -- 동시 주인 ≤1 held`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// HYK-498 §2 ⓘⓘ(P2-B, docs/HYK-494-runner-lock-design.md §15-2 그대로): a
// reclaimer that died between its own ticket tmp write and its own link
// leaves `<L>.reclaim.<O>.<k>.tmp.<suffix>` behind forever under the §13-9
// fix ALONE (that fix intentionally skips EVERY `.tmp.` name -- it never
// tells "dead" from "live" apart, it just never touches any of them, to
// never delete a LIVE reclaimer's in-flight write). The next two tests
// drive the production acquireRunnerLock entry point (no copy) through
// two real scenarios against the SAME shape of dead owner O (split into
// two `test()`s purely for the max-lines-per-function lint gate -- same
// reasoning as every other extraction in this file): ⑴ a DEAD reclaimer's
// own orphaned tmp (its pid already exited before it could link) -- must
// be swept once some later caller's own cleanupAfterReclaim(lockId=O) runs
// ⑵ a LIVE (self) reclaimer's in-flight tmp -- must survive untouched (the
// exact §13-9 invariant, now operationalized via identityIsDead instead of
// a bare prefix match -- never delete another live reclaimer's in-flight
// tmp).
const P2B_PROC_START = defaultGetStartIdentity(process.pid);
// Same cost-stub reasoning as :995 above -- the REAL default spawns
// PowerShell per query on Windows; only the query COST is stubbed, the
// verdict logic under test (identityIsDead) runs for real.
function p2bGetStartIdentityFn(pid) {
  return pid === process.pid ? P2B_PROC_START : null;
}

test("acquireRunnerLock (P2-B ⑴): cleanupAfterReclaim sweeps a DEAD reclaimer's orphaned ticket tmp (write-then-crash-before-link)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadOwnerPid = spawnSync(process.execPath, [
      "-e",
      "process.exit(0)",
    ]).pid;
    const deadReclaimerPid = spawnSync(process.execPath, [
      "-e",
      "process.exit(0)",
    ]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadOwnerPid,
        lockId: "p2b-dead-owner",
        procStart: "dead-p2b-owner-seed",
      }),
    );
    const orphanedTmpPath = `${lockPath}.reclaim.p2b-dead-owner.1.tmp.deadleftover`;
    writeFileSync(
      orphanedTmpPath,
      JSON.stringify({
        pid: deadReclaimerPid,
        procStart: "dead-p2b-reclaimer-seed",
      }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: Date.now(),
      timeoutMs: 5000,
      pollIntervalMs: 10,
      getStartIdentityFn: p2bGetStartIdentityFn,
      env: cleanEnv(),
    });
    assert.equal(
      r.acquired,
      true,
      `must still acquire -- ${JSON.stringify(r)}`,
    );
    assert.equal(
      existsSync(orphanedTmpPath),
      false,
      "a DEAD reclaimer's orphaned ticket tmp must be swept (P2-B)",
    );
    releaseRunnerLock({ lockPath, lockId: r.lockId });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunnerLock (P2-B ⑵): cleanupAfterReclaim leaves a LIVE reclaimer's in-flight ticket tmp for the same dead owner untouched (§13-9 invariant, not reintroduced)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const deadOwnerPid = spawnSync(process.execPath, [
      "-e",
      "process.exit(0)",
    ]).pid;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadOwnerPid,
        lockId: "p2b-dead-owner-2",
        procStart: "dead-p2b-owner-seed-2",
      }),
    );
    const liveTmpPath = `${lockPath}.reclaim.p2b-dead-owner-2.1.tmp.liveinflight`;
    writeFileSync(
      liveTmpPath,
      JSON.stringify({ pid: process.pid, procStart: P2B_PROC_START }),
    );
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: Date.now(),
      timeoutMs: 5000,
      pollIntervalMs: 10,
      getStartIdentityFn: p2bGetStartIdentityFn,
      env: cleanEnv(),
    });
    assert.equal(
      r.acquired,
      true,
      `must still acquire -- ${JSON.stringify(r)}`,
    );
    assert.equal(
      existsSync(liveTmpPath),
      true,
      "a LIVE reclaimer's in-flight ticket tmp must NEVER be deleted by another reclaimer's cleanup (§13-9 invariant)",
    );
    releaseRunnerLock({ lockPath, lockId: r.lockId });
    rmSync(liveTmpPath, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// product_scope 1b_exec_line ⑴ "오래 기다린 뒤 잡기" (P1-B repro shape),
// scaled N/M: a long-waiting entrant's own startedAtMs is backdated (same
// shape as isolated-suite-runner.mjs's real call site: `startedAtMs:
// nowMs()` captured BEFORE the wait loop) -- 2R's bug let this reclaim a
// genuinely-fresh, just-claimed owner within the first heartbeat interval.
function longWaitChildScript() {
  return [
    `import { acquireRunnerLock, releaseRunnerLock, startLockHeartbeat } from ${JSON.stringify(RUNNER_LOCK_URL)};`,
    `import { writeFileSync, unlinkSync } from "node:fs";`,
    `const [lockPath, csPath, outPath, holdMs, pollIntervalMs, timeoutMs, heartbeatIntervalMs, heartbeatStaleMs, simulatedWaitMs] = process.argv.slice(2);`,
    `const opts = { lockPath, pollIntervalMs: Number(pollIntervalMs), timeoutMs: Number(timeoutMs), heartbeatStaleMs: Number(heartbeatStaleMs) };`,
    `if (Number(simulatedWaitMs) > 0) opts.startedAtMs = Date.now() - Number(simulatedWaitMs);`,
    `const r = acquireRunnerLock(opts);`,
    `let violation = false, csCreated = false, hb = null;`,
    `if (r.acquired) {`,
    `  if (r.lockId) { try { hb = startLockHeartbeat({ lockPath, token: r.lockId, pid: process.pid, intervalMs: Number(heartbeatIntervalMs) }); } catch (e) {} }`,
    `  try { writeFileSync(csPath, String(process.pid), { flag: "wx" }); csCreated = true; } catch (e) { violation = true; }`,
    `  await new Promise((res) => setTimeout(res, Number(holdMs)));`,
    `  if (csCreated) { try { unlinkSync(csPath); } catch (e) {} }`,
    `  if (hb) { try { hb.stop(); } catch (e) {} }`,
    `  releaseRunnerLock({ lockPath, lockId: r.lockId });`,
    `}`,
    `writeFileSync(outPath, JSON.stringify({ pid: process.pid, acquired: r.acquired, reclaimedOrphan: r.reclaimedOrphan, violation }));`,
  ].join("\n");
}

// A handful of retries with a short settle delay -- this machine's
// antivirus/indexer occasionally holds a just-written temp file briefly
// unreadable right after the writing process exits (same class of transient
// condition runner-lock.mjs's own BUSY_RETRY_TIMEOUT_MS exists to absorb on
// the lock file itself, product_scope (b) 영향 2-3). Never masks a GENUINE
// missing file forever -- it still throws after the bounded retry window.
async function readJsonWithRetry(path, { attempts = 20, delayMs = 25 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastErr;
}

// HYK-494 3R live finding (this round's own test-writing): a `-e`/
// `--input-type=module` inline child combined with a REAL detached
// heartbeat grandchild (startLockHeartbeat's own spawn+unref) was observed
// to occasionally exit WITHOUT its final writeFileSync landing on disk, on
// this machine -- the SAME child script written to a real temp .mjs file
// (mkdtemp'd, ephemeral, never committed -- not a new fixture under
// product_scope's named file list) and spawned by path never showed this,
// matching runner-lock-race-probe.mjs's own (separately verified-reliable)
// technique. Written once per test run, reused across trials.
function writeLongWaitChildScript(dir) {
  const scriptPath = join(dir, "lw-child.mjs");
  writeFileSync(scriptPath, longWaitChildScript());
  return scriptPath;
}

function spawnLongWaitChild({ scriptPath, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: "ignore",
      env: cleanEnv(),
    });
    child.on("exit", () => {
      readJsonWithRetry(args[2]).then(resolve, reject);
    });
  });
}

const LONG_WAIT_TRIALS = 10;

test(`GREEN (long-wait-then-claim, the exact P1-B repro shape, scaled N=100ms/M=600ms): ${LONG_WAIT_TRIALS} trials -- a backdated-startedAtMs owner is never reclaimed by a fast-polling second entrant within the pre-first-heartbeat-tick window (2R's own repro: real overlap every time this shape fires)`, async () => {
  const dir = freshLockDir();
  try {
    const scriptPath = writeLongWaitChildScript(dir);
    let violations = 0;
    for (let trial = 0; trial < LONG_WAIT_TRIALS; trial += 1) {
      const lockPath = join(dir, `lw-${trial}.lock`);
      const csPath = join(dir, `lw-cs-${trial}.marker`);
      const out1 = join(dir, `lw-out-${trial}-1.json`);
      const out2 = join(dir, `lw-out-${trial}-2.json`);
      const p1 = spawnLongWaitChild({
        scriptPath,
        args: [
          lockPath,
          csPath,
          out1,
          "400",
          "5",
          "5000",
          "100",
          "600",
          "2000",
        ],
      });
      await new Promise((res) => setTimeout(res, 30));
      const p2 = spawnLongWaitChild({
        scriptPath,
        args: [lockPath, csPath, out2, "400", "5", "5000", "100", "600", "0"],
      });
      const [a, b] = await Promise.all([p1, p2]);
      if (a.violation || b.violation) violations += 1;
      assert.ok(a.acquired && b.acquired, `trial ${trial}: both must acquire`);
      assert.equal(existsSync(lockPath), false, `trial ${trial}: no leftover`);
    }
    assert.equal(
      violations,
      0,
      `${violations}/${LONG_WAIT_TRIALS} trials saw a critical-section violation -- 〔직접〕 finite sample, this machine, this run`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §11: F8 check -- the heartbeat sidecar never opens/writes L itself --

test("startLockHeartbeat: the sidecar NEVER touches the lock file L itself -- only L.alive.<token> changes while L's own bytes stay byte-for-byte identical (F8 fix, real sidecar process)", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const initial = JSON.stringify({
      pid: process.pid,
      startedAtMs: Date.now(),
      worktree: null,
      head: null,
      lockId: "f8-token",
    });
    writeFileSync(lockPath, initial);
    const heartbeat = startLockHeartbeat({
      lockPath,
      token: "f8-token",
      pid: process.pid,
      intervalMs: 20,
    });
    try {
      await new Promise((res) => setTimeout(res, 120));
      assert.equal(
        readFileSync(lockPath, "utf8"),
        initial,
        "L itself must be byte-for-byte unchanged -- the sidecar only ever writes L.alive.<token>",
      );
      const aliveContent = JSON.parse(
        readFileSync(`${lockPath}.alive.f8-token`, "utf8"),
      );
      assert.ok(
        Number.isFinite(aliveContent.aliveAtMs),
        "the sidecar must still be doing its job, just on the separate alive file",
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- HYK-494 후속(followup-3) CI-1: 결정적 회귀 그물(문자열 anchor,
// 타이밍 무관) -- 검토 1R §2 ⓒ·§3 P2-2가 권한 "사이드카 스크립트 문자열에
// rename 관용구가 있는지" 그대로. 실제 사이드카 자식을 띄우는 F8/heartbeat
// 시험들은 타이밍에 기대지만, 이 칸은 되돌림 변이(④)를 스위트 안에서
// 100% 결정론적으로 RED로 만든다.
test("HYK-494 followup-3 CI-1 regression (deterministic anchor): the sidecar heartbeat script writes the alive file via tmp-write-then-rename, never a direct in-place write -- guards the atomic-write fix without depending on real OS timing (P2-2)", () => {
  assert.match(
    HEARTBEAT_SCRIPT,
    /fs\.renameSync\(tmp,\s*alivePath\)/,
    "the sidecar must rename a fully-written tmp file onto alivePath (atomic replace)",
  );
  assert.doesNotMatch(
    HEARTBEAT_SCRIPT,
    /fs\.writeFileSync\(alivePath,/,
    "the sidecar must never write the alive file in place (non-atomic -- this is the exact CI-1 regression shape, master CI 541bc95 enforce red)",
  );
});

// -- HYK-494 후속(followup-3) P2-1: real-process tmp-leak-on-rename-failure
// regression -- 검토 1R §2 ⓒ 실측(1ms/20ms 간격 50회 중 각 2108/425개 tmp
// 잔존)과 같은 자리, 실제 PowerShell로 real Windows 공유 위반을 일으킨다.
function findPsExeForSidecarTest() {
  for (const exe of ["powershell", "pwsh"]) {
    try {
      const r = spawnSync(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", "1"],
        {
          timeout: 5000,
        },
      );
      if (!r.error && r.status === 0) return exe;
    } catch {
      // try next candidate.
    }
  }
  return null;
}

// 정직 한계(이 라운드 실측, 〔직접〕): best-effort unlink는 "0 보장"이
// 아니다 -- 이 머신에서 수리 뒤에도 드물게 1개가 남는 회차를 봤다(예:
// write 성공 뒤 rename 「전」 killed-mid-tick 류가 아니라, 이 실제 자식
// 프로세스가 로그 한 줄도 못 남긴 채 사라진 자리 -- 원인 불명, 설계
// 문서 §12 "best-effort" 문구 그대로, 이 PR이 "완전 봉쇄"를 주장하지
// 않는다). 반면 수리를 되돌리면(catch에서 unlink를 빼면) 같은 조건에서
// 80개 넘게 남는다(이 라운드 실측, 5회 중 81~83개). 그래서 "정확히 0"이
// 아니라 "압도적으로 적다"는 문턱으로 수리 유무를 가른다 -- 되돌림
// 변이는 여전히 이 문턱에서 100% RED다.
test("startLockHeartbeat: a real sidecar racing a real Windows sharing-violation on its own alive-file rename leaks almost no tmp files (P2-1 fix, HYK-494 followup-3 -- 검토 1R 실측: 수리 전 1ms/20ms 간격 50회 중 각 2108/425개 잔존; 이 라운드 실측: 수리 되돌림이면 같은 조건에서 80개+ 잔존, 수리 뒤는 0~1개)", async (t) => {
  const psExe = findPsExeForSidecarTest();
  if (!psExe) {
    t.skip(
      "no powershell/pwsh executable on PATH -- cannot induce a real sharing violation, 〔못쟀다〕",
    );
    return;
  }
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  const aliveBasename = "r.lock.alive.p21-token";
  const alivePath = join(dir, aliveBasename);
  const holdScriptPath = join(dir, "hold.ps1");
  writeFileSync(
    holdScriptPath,
    [
      "$path = $args[0]",
      "$iterations = [int]$args[1]",
      "$holdMs = [int]$args[2]",
      "$gapMs = [int]$args[3]",
      "for ($i = 0; $i -lt $iterations; $i++) {",
      "  try {",
      "    $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'None')",
      "    Start-Sleep -Milliseconds $holdMs",
      "    $fs.Close()",
      "  } catch {}",
      "  Start-Sleep -Milliseconds $gapMs",
      "}",
    ].join("\n"),
  );
  writeFileSync(alivePath, JSON.stringify({ aliveAtMs: 0 }));
  const holder = spawn(
    psExe,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      holdScriptPath,
      alivePath,
      "40",
      "15",
      "5",
    ],
    { stdio: "ignore" },
  );
  const heartbeat = startLockHeartbeat({
    lockPath,
    token: "p21-token",
    pid: process.pid,
    intervalMs: 10,
  });
  // holder가 "자기 iteration 수만큼" 끝낼 때까지 기다린 뒤(고정 시간이
  // 아니라 실제 종료 이벤트로), 몇 번의 "깨끗한"(충돌 없는) 틱이 더
  // 지나가게 짧게 버퍼를 둔다 -- 그 다음에야 스캔한다. heartbeat.stop()
  // (= child.kill())은 스캔 「뒤」에만 부른다 -- kill이 틱 중간을 끊는
  // 것은 이 수리(rename 실패 뒤 unlink)와 무관한 별개의, 더 희귀한
  // 경합이라 섞지 않는다(근거: kill 전에 스캔해도 이 머신에서 드물게
  // 1개가 남는 것을 관찰했다 -- 아래 문턱이 그 한계를 반영한다).
  await new Promise((resolve) => {
    holder.on("exit", resolve);
    holder.on("error", resolve);
  });
  await new Promise((res) => setTimeout(res, 150));
  const leftoverTmp = readdirSync(dir).filter((name) =>
    name.startsWith(`${aliveBasename}.tmp.`),
  );
  heartbeat.stop();
  try {
    assert.ok(
      leftoverTmp.length <= 3,
      `P2-1 위반(또는 수리 되돌림): rename 실패 뒤 tmp 파일이 너무 많이 남았다(${leftoverTmp.length}개, 문턱 3) -- ${JSON.stringify(leftoverTmp)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// product_scope ⓥⓘⓘ(P2-c, 검토 2R §3 참고): 사이드카 stop()의
// child.kill()이 HEARTBEAT_SCRIPT의 write(tmp)·rename(alivePath) 사이를
// 끊으면(SIGTERM은 그 스크립트의 catch를 거치지 않고 프로세스를 바로
// 끝낸다) `${alivePath}.tmp.*`가 남는다. 실제 kill-타이밍 경합(review의
// 1ms 간격 50회 측정, 9/50)은 순수한 운(OS 스케줄링)에 좌우돼 RED-first
// 확인에 그대로 쓸 수 없다 -- 대신 그 결과물(=kill에 끊긴 사이드카가
// 남기는 정확히 그 모양의 tmp 파일)을 직접 심어(주입, 〔직접〕 아님,
// universal_claim_discipline) releaseRunnerLock()의 해제 경로가 "자기
// token"만 쓸어 담고 "남의 것"은 무접촉인지를 결정론적으로 확인한다.
test("releaseRunnerLock: the release path best-effort-sweeps our OWN leftover heartbeat tmp file(s) left by a killed sidecar (write/rename interrupted), but never touches a DIFFERENT token's tmp leftover (P2-c fix, HYK-494 followup-5)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  try {
    const r = acquireRunnerLock({
      lockPath,
      pid: process.pid,
      startedAtMs: Date.now(),
      env: cleanEnv(),
    });
    assert.equal(r.acquired, true, "setup: must actually hold the lock");
    const ownAlivePath = `${lockPath}.alive.${r.lockId}`;
    // Simulates exactly what HEARTBEAT_SCRIPT's own tmp naming produces
    // (`alivePath+'.tmp.'+pid+'.'+Date.now()+'.'+rand`, :1296) when
    // child.kill() lands between the write and the rename.
    const ownLeftoverTmp = `${ownAlivePath}.tmp.99999.1.abcdef`;
    writeFileSync(ownLeftoverTmp, JSON.stringify({ aliveAtMs: 1 }));
    // A DIFFERENT token's own leftover tmp in the SAME directory -- must
    // stay untouched ("자기 token만 · 남의 것 무접촉").
    const otherAlivePath = `${lockPath}.alive.some-other-lockId`;
    const otherLeftoverTmp = `${otherAlivePath}.tmp.88888.2.ghijkl`;
    writeFileSync(otherLeftoverTmp, JSON.stringify({ aliveAtMs: 1 }));

    const rel = releaseRunnerLock({ lockPath, lockId: r.lockId });

    assert.equal(rel.released, true);
    assert.equal(
      existsSync(ownLeftoverTmp),
      false,
      "P2-c: our own leftover heartbeat tmp file must be swept by the release path",
    );
    assert.equal(
      existsSync(otherLeftoverTmp),
      true,
      "P2-c: a DIFFERENT token's tmp leftover must be left untouched (own-token-only)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startLockHeartbeat: the real sidecar keeps refreshing L.alive.<token> on a named interval while the token's owner pid is alive, and stop() ends further updates", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  const alivePath = `${lockPath}.alive.heartbeat-token`;
  try {
    writeFileSync(alivePath, JSON.stringify({ aliveAtMs: 1 }));
    const heartbeat = startLockHeartbeat({
      lockPath,
      token: "heartbeat-token",
      pid: process.pid,
      intervalMs: 30,
    });
    try {
      await new Promise((res) => setTimeout(res, 140));
      const afterRunning = JSON.parse(readFileSync(alivePath, "utf8"));
      assert.ok(
        afterRunning.aliveAtMs > 1,
        `sidecar must have refreshed aliveAtMs at least once (got ${afterRunning.aliveAtMs})`,
      );
      heartbeat.stop();
      await new Promise((res) => setTimeout(res, 60));
      const afterStop = JSON.parse(readFileSync(alivePath, "utf8"));
      await new Promise((res) => setTimeout(res, 100));
      const afterMore = JSON.parse(readFileSync(alivePath, "utf8"));
      assert.equal(
        afterStop.aliveAtMs,
        afterMore.aliveAtMs,
        "no tick after stop() -- the sidecar must actually be dead, not merely asked to stop",
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startLockHeartbeat: the sidecar stops refreshing once the owner pid is dead (never refreshes a lock whose real owner already exited)", async () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "r.lock");
  const alivePath = `${lockPath}.alive.dead-owner-heartbeat-token`;
  try {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    writeFileSync(alivePath, JSON.stringify({ aliveAtMs: 1 }));
    const heartbeat = startLockHeartbeat({
      lockPath,
      token: "dead-owner-heartbeat-token",
      pid: deadPid,
      intervalMs: 20,
    });
    try {
      await new Promise((res) => setTimeout(res, 120));
      const after = JSON.parse(readFileSync(alivePath, "utf8"));
      assert.equal(
        after.aliveAtMs,
        1,
        "a dead owner's lock must never be refreshed by the sidecar",
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startLockHeartbeat: a spawnHeartbeatFn failure degrades gracefully to a no-op stop() (never throws, mirrors startConcurrencySampler/startFreeMemSampler's own posture)", () => {
  const heartbeat = startLockHeartbeat({
    lockPath: "/fake/lock",
    token: "x",
    pid: 1,
    spawnHeartbeatFn: () => {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => heartbeat.stop());
});

// -- §12: startIdentity (Linux /proc parsing + Windows PowerShell, both
// injected seams -- Linux branch 〔못쟀다〕 실물, parsing logic only) --------

test("defaultGetStartIdentity: Linux branch parses /proc/<pid>/stat's 22nd field (starttime), tolerating a comm field with spaces/parens", () => {
  // A synthetic /proc/<pid>/stat line -- comm field "(my (weird) proc)" has
  // nested parens, proving the parser anchors on the LAST ")" not the first.
  const fakeStat =
    "1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 10 2 0 0 20 0 1 0 999888777 ...";
  const readFileFn = (p) => {
    assert.equal(p, "/proc/1234/stat");
    return fakeStat;
  };
  const id = defaultGetStartIdentity(1234, { platform: "linux", readFileFn });
  assert.equal(id, "999888777");
});

test("defaultGetStartIdentity: Linux branch returns null on read failure (no throw)", () => {
  const id = defaultGetStartIdentity(1234, {
    platform: "linux",
    readFileFn: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(id, null);
});

test("defaultGetStartIdentity: Windows branch calls PowerShell Get-Process StartTime and returns its trimmed output", () => {
  const id = defaultGetStartIdentity(4321, {
    platform: "win32",
    execFileSyncFn: (cmd, args) => {
      assert.equal(cmd, "powershell");
      assert.ok(args.some((a) => a.includes("4321")));
      return "133700000000000000\n";
    },
  });
  assert.equal(id, "133700000000000000");
});

test("defaultGetStartIdentity: Windows branch returns null on PowerShell failure (no throw) and never calls it for a non-integer pid", () => {
  const id1 = defaultGetStartIdentity(4321, {
    platform: "win32",
    execFileSyncFn: () => {
      throw new Error("powershell not found");
    },
  });
  assert.equal(id1, null);
  let called = false;
  const id2 = defaultGetStartIdentity(NaN, {
    platform: "win32",
    execFileSyncFn: () => {
      called = true;
      return "x";
    },
  });
  assert.equal(id2, null);
  assert.equal(called, false);
});

test("defaultGetStartIdentity: an unrecognized platform returns null (§(g) 정직 한계 1 -- 신원 모름 -> ALIVE)", () => {
  const id = defaultGetStartIdentity(1, { platform: "sunos" });
  assert.equal(id, null);
});

test("defaultGetStartIdentity: the REAL (no override) default actually resolves something for THIS process on this machine (comparison is always string equality)", () => {
  const id = defaultGetStartIdentity(process.pid);
  // 〔직접〕 this machine (Windows): must be a non-empty numeric string.
  // 〔못쟀다〕 Linux CI -- not exercised here, only the injected-seam parsing
  // logic above is (universal_claim_discipline).
  assert.ok(typeof id === "string" && id.length > 0);
  assert.equal(
    id,
    defaultGetStartIdentity(process.pid),
    "stable within one run",
  );
});

// -- §13: wiring into runIsolatedSuite ------------------------------------

const NOOP_LOCK_SEAMS = {
  acquireLockFn: () => ({
    acquired: true,
    nested: false,
    lockPath: null,
    waitMs: 0,
    pollCount: 0,
    reclaimedOrphan: false,
    reclaimReason: null,
    priorOwner: null,
    timedOut: false,
  }),
  releaseLockFn: () => ({ released: true, lockLost: false, reason: null }),
  installSignalHandlersFn: () => () => {},
  env: {},
};

function execFileForWiringTests() {
  return (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "cafef00d\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
}

test("runIsolatedSuite: acquireLockFn is called BEFORE any spawn (lock-before-measurement), releaseLockFn is called exactly ONCE (memoized -- reportRunOutcome's own release() call and the outer finally's both resolve to the same real call), and lock fields ride the receipt", () => {
  const calls = [];
  const receipts = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => {
      calls.push("spawn");
      return { status: 0 };
    },
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    acquireLockFn: (opts) => {
      calls.push("acquireLock");
      assert.equal(opts.worktree, "/src");
      assert.equal(opts.head, "cafef00d");
      assert.equal(
        typeof opts.logFn,
        "function",
        "HYK-494 후속 P2-1 wiring: isolated-suite-runner must pass its own log fn through to acquireLockFn",
      );
      return {
        acquired: true,
        nested: false,
        lockPath: "/fake/lock",
        waitMs: 1234,
        pollCount: 3,
        reclaimedOrphan: true,
        reclaimReason: "pid-dead",
        priorOwner: { pid: 1 },
        timedOut: false,
        lockId: "the-lock-id",
      };
    },
    releaseLockFn: (relOpts) => {
      calls.push("releaseLock");
      assert.equal(relOpts.lockId, "the-lock-id");
      return { released: true, lockLost: false, reason: null };
    },
    installSignalHandlersFn: () => () => {},
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(
    calls,
    ["acquireLock", "spawn", "releaseLock"],
    "the real releaseLockFn fires exactly once -- guardLockForRun's release() memoizes, so the outer finally's own second call reuses the cached result instead of touching the filesystem again",
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].lockInfo.waitMs, 1234);
  assert.equal(receipts[0].lockInfo.pollCount, 3);
  assert.equal(receipts[0].lockInfo.reclaimedOrphan, true);
  assert.equal(receipts[0].lockInfo.reclaimReason, "pid-dead");
  assert.equal(receipts[0].lockInfo.nested, false);
  assert.equal(receipts[0].lockInfo.timedOut, false);
  assert.equal(receipts[0].lockInfo.lockLost, false);
});

test("runIsolatedSuite: lock timeout -- never clones/spawns, returns a non-zero exit code, writes a LOCK_TIMEOUT receipt (never folds green)", () => {
  const receipts = [];
  let spawnCalled = false;
  let cloneCalled = false;
  const exitCode = runIsolatedSuite({
    execFile: (cmd, args) => {
      if (args[0] === "clone") cloneCalled = true;
      return execFileForWiringTests()(cmd, args);
    },
    spawn: () => {
      spawnCalled = true;
      return { status: 0 };
    },
    log: () => {},
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    nowMs: () => 42,
    acquireLockFn: () => ({
      acquired: false,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 999999,
      pollCount: 50,
      reclaimedOrphan: false,
      priorOwner: {
        pid: 777,
        startedAtMs: 1,
        worktree: "/other",
        head: "feedface",
      },
      timedOut: true,
    }),
    releaseLockFn: () => {
      throw new Error("must never be called -- the lock was never acquired");
    },
    installSignalHandlersFn: () => {
      throw new Error(
        "must never be called -- no lock, no signal guard needed",
      );
    },
    env: {},
  });
  assert.notEqual(
    exitCode,
    0,
    "a lock timeout must never return a green (0) exit code",
  );
  assert.equal(cloneCalled, false, "must never clone the repo");
  assert.equal(spawnCalled, false, "시험을 돌리지 않고");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerExit, exitCode);
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.LOCK_TIMEOUT);
  assert.equal(receipts[0].headCommit, "cafef00d");
  assert.deepEqual(receipts[0].counts, {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
  assert.equal(receipts[0].lockInfo.timedOut, true);
  assert.equal(receipts[0].lockInfo.waitMs, 999999);
  assert.equal(receipts[0].lockInfo.lockLost, null);
});

test("runIsolatedSuite: nested bypass (NESTED_LOCK_BYPASS_ENV_VAR already set) -- acquireLockFn still runs, but release/signal-guard installation is skipped (nothing of ours to release), release() still returns a stable no-op result", () => {
  let installCalled = false;
  let releaseCalled = false;
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: true,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
    }),
    releaseLockFn: () => {
      releaseCalled = true;
      return { released: true, lockLost: false, reason: null };
    },
    installSignalHandlersFn: () => {
      installCalled = true;
      return () => {};
    },
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(
    installCalled,
    false,
    "nested run must not install a signal guard for a lock it never owns",
  );
  assert.equal(
    releaseCalled,
    false,
    "nested run must not call the real releaseLockFn -- there is nothing of ours to release",
  );
});

test("runIsolatedSuite: a real (non-nested) acquisition marks NESTED_LOCK_BYPASS_ENV_VAR to the ACQUIRED lock's own lockId during the run, and clears it afterward", () => {
  const env = {};
  let sawDuringSpawn;
  runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => {
      sawDuringSpawn = env[NESTED_LOCK_BYPASS_ENV_VAR];
      return { status: 0 };
    },
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "this-runs-own-lock-token",
    }),
    releaseLockFn: () => ({ released: true, lockLost: false, reason: null }),
    installSignalHandlersFn: () => () => {},
    startHeartbeatFn: () => ({ stop: () => {} }),
    env,
  });
  assert.equal(
    sawDuringSpawn,
    "this-runs-own-lock-token",
    "the marker must be set to this run's OWN lockId BEFORE spawn",
  );
  assert.equal(
    env[NESTED_LOCK_BYPASS_ENV_VAR],
    undefined,
    "the marker must be cleared once this run releases its lock",
  );
});

// -- §13b: heartbeat wiring (unchanged mechanism) -------------------------

test("runIsolatedSuite: a real (non-nested) acquisition starts the heartbeat sidecar with this run's own lockId as `token`, and stops it on release", () => {
  const calls = [];
  const exitCode = runIsolatedSuite({
    lockPath: "/fake/lock",
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "the-heartbeat-token",
    }),
    releaseLockFn: () => ({ released: true, lockLost: false, reason: null }),
    installSignalHandlersFn: () => () => {},
    startHeartbeatFn: (opts) => {
      calls.push({ event: "start", opts });
      return {
        stop: () => calls.push({ event: "stop" }),
      };
    },
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].event, "start");
  assert.equal(calls[0].opts.token, "the-heartbeat-token");
  assert.equal(calls[0].opts.lockPath, "/fake/lock");
  assert.equal(calls[1].event, "stop");
});

test("runIsolatedSuite: a nested acquisition never starts the heartbeat sidecar (nothing of ours to keep alive)", () => {
  let startHeartbeatCalled = false;
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: true,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
    }),
    startHeartbeatFn: () => {
      startHeartbeatCalled = true;
      return { stop: () => {} };
    },
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(
    startHeartbeatCalled,
    false,
    "a nested run owns nothing to heartbeat",
  );
});

test("runIsolatedSuite: RUN_ISOLATED_SUITE_DEFAULTS' own startHeartbeatFn default is a no-op -- every existing/other caller that never mentions heartbeat spawns nothing real", () => {
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "whatever",
    }),
    releaseLockFn: () => ({ released: true, lockLost: false, reason: null }),
    // startHeartbeatFn deliberately omitted -- this must not throw/hang/
    // spawn a real process.
  });
  assert.equal(exitCode, 0);
});

test("runIsolatedSuite: the lock is released even when the run throws (clone/spawn failure) -- exception path releases too", () => {
  let releaseCalled = false;
  assert.throws(() => {
    runIsolatedSuite({
      execFile: (cmd, args) => {
        if (args[0] === "clone") throw new Error("boom: clone failed");
        return execFileForWiringTests()(cmd, args);
      },
      spawn: () => ({ status: 0 }),
      log: () => {},
      acquireLockFn: () => ({
        acquired: true,
        nested: false,
        lockPath: "/fake/lock",
        waitMs: 0,
        pollCount: 0,
        reclaimedOrphan: false,
        priorOwner: null,
        timedOut: false,
      }),
      releaseLockFn: () => {
        releaseCalled = true;
        return { released: true, lockLost: false, reason: null };
      },
      installSignalHandlersFn: () => () => {},
      env: {},
    });
  }, /boom: clone failed/);
  assert.equal(
    releaseCalled,
    true,
    "a thrown exception must still release the lock (finally)",
  );
});

test("runIsolatedSuite: a real lock acquired via a synthetic lockPath is actually removed from disk after a normal run (end-to-end, no stubbed acquire/release)", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "real.lock");
  try {
    const exitCode = runIsolatedSuite({
      lockPath,
      startSampler: () => null,
      stopSampler: () => null,
      startFreeMemSamplerFn: () => null,
      stopFreeMemSamplerFn: () => null,
      installSignalHandlersFn: () => () => {},
      env: {},
      execFile: execFileForWiringTests(),
      spawn: () => ({ status: 0 }),
      log: () => {},
      collectFiles: () => [],
      readFile: () => {
        throw new Error("no tap");
      },
      writeReceipt: () => ({ path: "(stubbed)", receipt: {} }),
    });
    assert.equal(exitCode, 0);
    assert.equal(
      existsSync(lockPath),
      false,
      "the real lock file must be gone after a normal run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- §14: LOCK_LOST wiring (HYK-494 3R new behavior) -----------------------

test("runIsolatedSuite: when release() reports lockLost, the final exit code becomes 1 and the receipt's runner_status becomes LOCK_LOST, overriding whatever the test run itself returned (조용한 겹침보다 보이는 빨강)", () => {
  const receipts = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }), // the test run ITSELF was green
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "lost-token",
    }),
    releaseLockFn: () => ({
      released: false,
      lockLost: true,
      reason: "not-our-lock-or-missing",
    }),
    installSignalHandlersFn: () => () => {},
    env: {},
  });
  assert.equal(exitCode, 1, "LOCK_LOST must never fold green");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runnerExit, 1);
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.LOCK_LOST);
  assert.equal(receipts[0].lockInfo.lockLost, true);
});

test("runIsolatedSuite: when release() reports NOT lockLost, the receipt's lockLost field is explicitly false (never left null/undefined for a run that actually released)", () => {
  const receipts = [];
  const exitCode = runIsolatedSuite({
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    acquireLockFn: () => ({
      acquired: true,
      nested: false,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
      lockId: "kept-token",
    }),
    releaseLockFn: () => ({ released: true, lockLost: false, reason: null }),
    installSignalHandlersFn: () => () => {},
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.OK);
  assert.equal(receipts[0].lockInfo.lockLost, false);
});

test("runIsolatedSuite: a nested run's release() is a stable no-op ({released:false, lockLost:false}) -- never reported as LOCK_LOST (nothing of ours was ever at risk)", () => {
  const receipts = [];
  const exitCode = runIsolatedSuite({
    ...NOOP_LOCK_SEAMS,
    startSampler: () => null,
    stopSampler: () => null,
    startFreeMemSamplerFn: () => null,
    stopFreeMemSamplerFn: () => null,
    execFile: execFileForWiringTests(),
    spawn: () => ({ status: 0 }),
    log: () => {},
    collectFiles: () => [],
    readFile: () => {
      throw new Error("no tap");
    },
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    acquireLockFn: () => ({
      acquired: true,
      nested: true,
      lockPath: "/fake/lock",
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
    }),
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.OK);
  assert.equal(receipts[0].lockInfo.lockLost, false);
});

test("runIsolatedSuite: an end-to-end LOCK_LOST via REAL releaseRunnerLock (no stub) -- another process's lockId already occupies the path by the time this run tries to release", () => {
  const dir = freshLockDir();
  const lockPath = join(dir, "real.lock");
  const receipts = [];
  try {
    const exitCode = runIsolatedSuite({
      lockPath,
      startSampler: () => null,
      stopSampler: () => null,
      startFreeMemSamplerFn: () => null,
      stopFreeMemSamplerFn: () => null,
      installSignalHandlersFn: () => () => {},
      env: {},
      execFile: execFileForWiringTests(),
      spawn: () => {
        // simulate "someone else reclaimed and re-claimed under a NEW
        // lockId" happening WHILE this run's own test pass is executing.
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: 999999, lockId: "a-different-owner-now" }),
        );
        return { status: 0 };
      },
      log: () => {},
      collectFiles: () => [],
      readFile: () => {
        throw new Error("no tap");
      },
      writeReceipt: (payload) => {
        receipts.push(payload);
        return { path: "(stubbed)", receipt: {} };
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.LOCK_LOST);
    assert.equal(receipts[0].lockInfo.lockLost, true);
    // the OTHER owner's lock must survive -- this run's release must never
    // delete a lockId it doesn't recognize.
    const stillThere = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(stillThere.lockId, "a-different-owner-now");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
