import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { runAdmissionCli } from "./admission-cli.mjs";

const execFileAsync = promisify(execFile);
const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "admission-cli.mjs",
);

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-cli-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

function captureConsole() {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg) => lines.push(String(msg));
  console.error = (msg) => lines.push(String(msg));
  return {
    lines,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

test("status on an uninitialized ledger is CAP_STATE_UNAVAILABLE, nonzero, never 0-active (RED-c: fail-closed)", () => {
  const { dir, ledger } = tmpPaths();
  const cap = captureConsole();
  try {
    const exit = runAdmissionCli(["status", "--ledger", ledger]);
    cap.restore();
    assert.equal(exit, 4);
    assert.ok(
      cap.lines.some((l) =>
        l.startsWith("CAP_STATE_UNAVAILABLE reason=LEDGER_MISSING"),
      ),
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init-cutover with 0 live seats matches today's ground truth (0 running) then admit succeeds", () => {
  const { dir, ledger, lock } = tmpPaths();
  const cap = captureConsole();
  try {
    const cutoverExit = runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    assert.equal(cutoverExit, 0);
    assert.ok(
      cap.lines.some(
        (l) => l.startsWith("CAP_CUTOVER_DONE") && l.includes("active=0"),
      ),
    );

    const admitExit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r1",
      "--cap",
      "2",
      "--role",
      "CODER",
      "--seat-key",
      "seat-1",
    ]);
    assert.equal(admitExit, 0);
    assert.ok(
      cap.lines.some((l) =>
        l.startsWith("CAP_ADMITTED reservation=r1 active_before=0 cap=2"),
      ),
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// This is the §3 table's middle row, verbatim: CAP_BLOCKED + nonzero exit,
// and the caller (dispatch-worker.ps1) must never proceed to `orca
// orchestration dispatch` past this. §5 항 2's "dispatch가 생성되지 않음"
// evidence is the exit code itself here -- a synthetic caller loop below
// proves no dispatch line is ever printed when this exit is nonzero.
test("admit at cap prints CAP_BLOCKED and a nonzero exit (RED-b: block branch)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const cap = captureConsole();
  try {
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const first = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r1",
      "--cap",
      "1",
    ]);
    assert.equal(first, 0);
    const second = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r2",
      "--cap",
      "1",
    ]);
    assert.equal(second, 3);
    assert.ok(
      cap.lines.some((l) => l.startsWith("CAP_BLOCKED active=1 cap=1")),
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete releases the slot for a subsequent admit", () => {
  const { dir, ledger, lock } = tmpPaths();
  const cap = captureConsole();
  try {
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
      "r1",
      "--cap",
      "1",
    ]);
    const blocked = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r2",
      "--cap",
      "1",
    ]);
    assert.equal(blocked, 3);

    const completeExit = runAdmissionCli([
      "complete",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r1",
    ]);
    assert.equal(completeExit, 0);

    const admitted = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r2",
      "--cap",
      "1",
    ]);
    assert.equal(admitted, 0);
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reflects active count after admissions and completions", () => {
  const { dir, ledger, lock } = tmpPaths();
  const cap = captureConsole();
  try {
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
      "r1",
      "--cap",
      "2",
    ]);
    cap.lines.length = 0;
    runAdmissionCli(["status", "--ledger", ledger]);
    assert.ok(cap.lines.some((l) => l.startsWith("CAP_STATUS active=1")));
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ★§5 항 1 -- 원자성 실증 (합성, 실제 배달 없음): two REAL, concurrent OS
// processes race to admit against the SAME ledger+lock with cap=1. This is
// exactly PM 항 4's TOCTOU scenario ("두 요청이 같은 빈 슬롯을 보고 둘 다
// 통과") reproduced with genuine process-level concurrency, not two
// sequential in-process calls (which would trivially never race). Runs the
// race N times to make a single lucky interleaving implausible as an
// explanation for a pass.
// runOneRaceRound -- one round's body, extracted to keep the test callback
// itself under the repo's ESLint max-lines-per-function ceiling
// (quality-check); no behavior change from the inline version.
async function runOneRaceRound(round) {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await execFileAsync("node", [
      CLI_PATH,
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);

    const runAdmit = (reservationId) =>
      execFileAsync("node", [
        CLI_PATH,
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        reservationId,
        "--cap",
        "1",
      ]).then(
        (r) => ({ code: 0, stdout: r.stdout }),
        (err) => ({ code: err.code, stdout: err.stdout ?? "" }),
      );

    const [a, b] = await Promise.all([runAdmit("race-a"), runAdmit("race-b")]);
    const codes = [a.code, b.code].sort();
    // Exactly one ADMITTED(0), exactly one BLOCKED(3) -- never [0,0].
    assert.deepEqual(
      codes,
      [0, 3],
      `round ${round}: got codes ${JSON.stringify(codes)} stdout=${JSON.stringify([a.stdout, b.stdout])}`,
    );

    const admittedCount = [a, b].filter((r) => r.code === 0).length;
    assert.equal(
      admittedCount,
      1,
      `round ${round}: expected exactly 1 ADMITTED, got ${admittedCount}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CONCURRENT admit race: exactly one of two simultaneous processes wins cap=1 (real subprocess race, repeated)", async () => {
  const ROUNDS = 8;
  for (let round = 0; round < ROUNDS; round++) {
    await runOneRaceRound(round);
  }
});

// RED ⓐ: 원자 예약 -- a deterministic variant of the race above. Plain
// process-spawn timing (the test above) essentially NEVER hits the race
// window in practice (Node startup latency dwarfs the read-write critical
// section), so it alone cannot serve as reliable RED evidence for "the lock
// is load-bearing" -- a run with the lock ripped out could still pass by
// sheer luck (verified: 40 unlocked rounds without --debug-delay-ms never
// once produced a double-admit). `--debug-delay-ms` (admission-ledger-
// store.mjs's criticalSectionDelayMs, test-support only) forces genuine
// overlap by holding process A inside its lock between read and write long
// enough for process B to unmistakably be blocked on (or bypass, if the
// lock is removed) the SAME window.
test("CONCURRENT admit race with forced overlap (--debug-delay-ms): still exactly one winner (RED-a: atomic reservation)", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await execFileAsync("node", [
      CLI_PATH,
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const runAdmit = (reservationId, delayMs) =>
      execFileAsync("node", [
        CLI_PATH,
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        reservationId,
        "--cap",
        "1",
        "--debug-delay-ms",
        String(delayMs),
      ]).then(
        (r) => ({ code: 0, stdout: r.stdout }),
        (err) => ({ code: err.code, stdout: err.stdout ?? "" }),
      );
    // A holds its critical section open for 300ms; B is launched 50ms later
    // so it is guaranteed to attempt admit WHILE A is still inside its lock.
    const aPromise = runAdmit("race-a", 300);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bPromise = runAdmit("race-b", 0);
    const [a, b] = await Promise.all([aPromise, bPromise]);
    const codes = [a.code, b.code].sort();
    assert.deepEqual(
      codes,
      [0, 3],
      `forced-overlap race: got codes ${JSON.stringify(codes)} stdout=${JSON.stringify([a.stdout, b.stdout])}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-2R §1 -- 검토자 재현 조건 그대로 고정한 시험(REVIEW 1R 반려
// 원문): staleLockMs를 짧게(100ms), 첫 프로세스의 임계구역을 그보다 길게
// (300ms) 만들면, 소유자 확인이 없던 1R 코드에서는 두 프로세스 모두
// `ADMITTED activeBefore=0`이 되고 최종 원장에는 늦게 쓴 쪽만 남아 먼저
// admit된 예약이 소실됐다(검토자 실측). 이 시험은 정확히 그 조건에서
// ⓐ두 프로세스가 동시에 ADMITTED되지 않고 ⓑ먼저 admit된 예약이 소실되지
// 않음을 확인한다 -- RED ⓓ(소유자 확인 제거)의 GREEN 대조이기도 하다.
test("HYK-224-2R §1: reviewer's exact repro (short staleLockMs + long critical section) -- no double-admit, no lost reservation", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await execFileAsync("node", [
      CLI_PATH,
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const runAdmit = (reservationId) =>
      execFileAsync("node", [
        CLI_PATH,
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        reservationId,
        "--cap",
        "2",
        "--debug-delay-ms",
        "300",
        "--stale-lock-ms",
        "100",
        "--lock-timeout-ms",
        "5000",
      ]).then(
        (r) => ({ code: 0, stdout: r.stdout }),
        (err) => ({ code: err.code, stdout: err.stdout ?? "" }),
      );
    const aPromise = runAdmit("stale-a");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bPromise = runAdmit("stale-b");
    const [a, b] = await Promise.all([aPromise, bPromise]);
    assert.equal(a.code, 0, `stale-a should admit: ${a.stdout}`);
    assert.equal(
      b.code,
      0,
      `stale-b should admit (cap=2, sequential): ${b.stdout}`,
    );

    const status = await execFileAsync("node", [
      CLI_PATH,
      "status",
      "--ledger",
      ledger,
    ]);
    // Both reservations must be present in the final ledger -- neither one
    // clobbered by the other's write (the exact loss the reviewer found).
    assert.match(
      status.stdout,
      /CAP_STATUS active=2/,
      `both reservations must survive: ${status.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-2R §1 -- "둘 다 만족" 요구의 나머지 절반: 진짜로 죽은 프로세스가
// 쥔 락은 여전히 회수되어야 한다(그렇지 않으면 소유자 확인 자체가 새로운
// 영구 정지 원인이 된다). 실제 자식 프로세스를 띄워 임계구역 안에서
// SIGKILL로 죽이고(락 파일에 그 pid가 남는다), 이후 admit 이 그 pid가
// 죽었음을 확인해 staleLockMs를 기다리지 않고 즉시 회수하는지 측정한다.
test("HYK-224-2R §1: a genuinely dead process's lock IS reclaimed (not wedged forever)", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await execFileAsync("node", [
      CLI_PATH,
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const doomed = spawn("node", [
      CLI_PATH,
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "doomed",
      "--cap",
      "1",
      "--debug-delay-ms",
      "60000",
      "--stale-lock-ms",
      "1000000",
    ]);
    // Give it time to actually acquire the lock (write its pid into the
    // lock file) before killing it mid-critical-section.
    await new Promise((resolve) => setTimeout(resolve, 200));
    doomed.kill("SIGKILL");
    await new Promise((resolve) => doomed.on("exit", resolve));

    const before = Date.now();
    const result = await execFileAsync("node", [
      CLI_PATH,
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "recovered",
      "--cap",
      "1",
      "--stale-lock-ms",
      "1000000",
      "--lock-timeout-ms",
      "5000",
    ]);
    const elapsedMs = Date.now() - before;
    assert.match(
      result.stdout,
      /CAP_ADMITTED/,
      `dead process's lock should be reclaimed: ${result.stdout}`,
    );
    // Reclaim was via confirmed death, not the (deliberately huge)
    // staleLockMs age fallback -- must complete quickly, not after a long
    // age-based wait.
    assert.ok(
      elapsedMs < 4000,
      `reclaim should be fast (pid-death-based, not age-based): took ${elapsedMs}ms`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §1 -- 검토자 재현 조건 그대로 고정(REVIEW 2R 반려 원문): a
// PRE-EXISTING pid-less (legacy/no-pid content) lock file, already older
// than staleLockMs when both contenders start. Under 2R's mtime fallback,
// BOTH `pidless-a`/`pidless-b` could independently judge it stale and race
// to reclaim it, producing exactly the double-admit/lost-reservation shape
// 1R had. Under 3R's fail-closed rule NEITHER may auto-reclaim it -- so the
// correct outcome here is that BOTH admits fail (CAP_STATE_UNAVAILABLE,
// nonzero), never a double-ADMITTED and never a silent reservation loss.
test("HYK-224-3R §1: reviewer's pidless-* repro -- neither contender auto-reclaims a pre-existing pid-less lock (0 double-admit, 0 loss)", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await execFileAsync("node", [
      CLI_PATH,
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    // Pre-seed a legacy/no-pid lock file, backdated well past any
    // staleLockMs the contenders below will use.
    writeFileSync(lock, "");
    const past = new Date(Date.now() - 10_000);
    utimesSync(lock, past, past);

    const runAdmit = (reservationId) =>
      execFileAsync("node", [
        CLI_PATH,
        "admit",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--reservation-id",
        reservationId,
        "--cap",
        "2",
        "--stale-lock-ms",
        "100",
        "--lock-timeout-ms",
        "300",
      ]).then(
        (r) => ({ code: 0, stdout: r.stdout, stderr: "" }),
        (err) => ({
          code: err.code,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        }),
      );

    const [a, b] = await Promise.all([
      runAdmit("pidless-a"),
      runAdmit("pidless-b"),
    ]);
    // Neither one may succeed -- the pre-existing pid-less lock is never
    // auto-reclaimed, so both time out waiting for a lock nobody will ever
    // release (fail-closed, not a silent 0-admitted either).
    assert.notEqual(a.code, 0, `pidless-a must NOT auto-admit: ${a.stdout}`);
    assert.notEqual(b.code, 0, `pidless-b must NOT auto-admit: ${b.stdout}`);
    assert.match(
      a.stdout,
      /CAP_STATE_UNAVAILABLE reason=LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED/,
    );
    assert.match(
      b.stdout,
      /CAP_STATE_UNAVAILABLE reason=LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED/,
    );

    // Manually clear the stuck lock (the documented remedy) and confirm a
    // normal admit works again afterward -- proves this is "blocked until a
    // human intervenes," not a structural dead end.
    rmSync(lock, { force: true });
    const recovered = await execFileAsync("node", [
      CLI_PATH,
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "pidless-recovered",
      "--cap",
      "2",
    ]);
    assert.match(recovered.stdout, /CAP_ADMITTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// §5 항 2 -- "dispatch가 생성되지 않음"을 호출 로그로 증명: a synthetic
// caller (playing dispatch-worker.ps1's role) that only calls a fake
// `orca dispatch` stub when admit's exit code is 0. Never touches the real
// `orca` binary (coder-task §6: 실제 배달 금지).
test("synthetic caller never invokes the dispatch stub when admit is BLOCKED", () => {
  const { dir, ledger, lock } = tmpPaths();
  const cap = captureConsole();
  let dispatchStubCalls = 0;
  const fakeOrcaDispatchStub = () => {
    dispatchStubCalls++;
  };
  try {
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
      "r1",
      "--cap",
      "1",
    ]);
    const secondExit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r2",
      "--cap",
      "1",
    ]);
    if (secondExit === 0) fakeOrcaDispatchStub();
    assert.equal(secondExit, 3);
    assert.equal(dispatchStubCalls, 0);
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admit --cap-path reads the committed concurrency-cap.json (production wiring, not a hand-typed --cap)", () => {
  const { dir, ledger, lock } = tmpPaths();
  const capPath = join(dir, "concurrency-cap.json");
  const cap = captureConsole();
  try {
    writeFileSync(
      capPath,
      JSON.stringify({
        schema_version: "concurrency-cap/v1",
        global_hard_cap: 2,
      }),
    );
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const exit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r1",
      "--cap-path",
      capPath,
    ]);
    assert.equal(exit, 0);
    assert.ok(
      cap.lines.some(
        (l) => l.startsWith("CAP_ADMITTED") && l.includes("cap=2"),
      ),
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admit --cap-path fails closed (STATE_UNAVAILABLE) on a malformed cap file, never falls back to a code default", () => {
  const { dir, ledger, lock } = tmpPaths();
  const capPath = join(dir, "concurrency-cap.json");
  const cap = captureConsole();
  try {
    writeFileSync(
      capPath,
      JSON.stringify({ schema_version: "wrong-version", global_hard_cap: 2 }),
    );
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const exit = runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r1",
      "--cap-path",
      capPath,
    ]);
    assert.equal(exit, 4);
    assert.ok(
      cap.lines.some((l) =>
        l.startsWith("CAP_STATE_UNAVAILABLE reason=CAP_VALUE_SCHEMA_MISMATCH"),
      ),
    );
  } finally {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// runCli -- thin execFileAsync wrapper, extracted to keep the sweep/recover
// round-trip test below under the repo's ESLint max-lines-per-function
// ceiling; no behavior change from the inline execFileAsync calls it
// replaces.
function runCli(argv) {
  return execFileAsync("node", [CLI_PATH, ...argv]);
}

// HYK-224-2R §2 (updated by 3R §2): dispatch-worker.ps1 passes --seat-key
// into every real admit call instead of leaving it null. This proves the
// OTHER half of that fix -- a reservation admitted WITH a seat_key becomes
// a sweep LIVENESS judgment target (transitions to SUSPECT when its seat
// isn't live), in contrast to a seat_key:null reservation, which 3R's own
// contract (admission-ledger-core.test.mjs) never guesses liveness for --
// it gets a distinct "flagged unjudgeable" transition instead of SUSPECT.
test("HYK-224-2R/3R §2: a reservation admitted WITH --seat-key becomes a LIVENESS judgment target (SUSPECT); one admitted WITHOUT one is only ever flagged UNJUDGEABLE, never SUSPECT", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await runCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    await runCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "with-seat",
      "--cap",
      "2",
      "--seat-key",
      "c:/worktrees/example",
    ]);
    await runCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "without-seat",
      "--cap",
      "2",
    ]);
    const swept = await runCli([
      "sweep",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
      "--stale-after-ms",
      "0",
      "--recovery-grace-ms",
      "999999999",
    ]);
    // The seat-keyed reservation flips to SUSPECT (liveness judged, and
    // found dead) -- the seat_key:null one is flagged UNJUDGEABLE (visible,
    // but never guessed at) and, critically, never SUSPECT.
    assert.match(
      swept.stdout,
      /\{"reservationId":"with-seat","from":"ACTIVE","to":"SUSPECT"\}/,
    );
    assert.match(
      swept.stdout,
      /\{"reservationId":"without-seat","from":"ACTIVE","to":"ACTIVE","flag":"UNJUDGEABLE_NO_SEAT_KEY"\}/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §2 -- 검토자 재현 조건 그대로 고정(REVIEW 2R 반려 원문): CODER
// and REVIEW seats that share the SAME worktree (2R's seat_key value) but
// are different panes (different orca `tabId:leafId`). Under 2R's
// worktree-path seat_key, both reservations would carry the IDENTICAL
// seat_key -- if either pane's liveSeatKeys probe found ANY seat at that
// worktree alive, BOTH reservations (including a truly dead one) would
// read as "live," never getting swept. Pane-key-shaped seat_key (3R §2 --
// `${tabId}:${leafId}`, unique per pane, unlike the shared worktree path)
// fixes this: this test seeds two reservations with DISTINCT pane-key
// seat_keys (mimicking CODER+REVIEW in the same worktree), puts only ONE
// of those two pane keys in `liveSeatKeys`, and confirms the dead one is
// correctly judged dead (SUSPECT) while the live one is correctly left
// ACTIVE -- no cross-role misattribution.
test("HYK-224-3R §2: same-worktree, two-role seats with distinct pane-key seat_keys -- a dead reservation is never misjudged live via the other role's liveness", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await runCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    const sharedWorktree =
      "c:/users/administrator/orca/workspaces/harnessengineering/hyk224-cap-admission";
    const coderPaneKey = `${sharedWorktree}#tab-aaaa:leaf-1111`;
    const reviewPaneKey = `${sharedWorktree}#tab-bbbb:leaf-2222`;
    await runCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "coder-round",
      "--cap",
      "2",
      "--role",
      "CODER",
      "--seat-key",
      coderPaneKey,
    ]);
    await runCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "review-round",
      "--cap",
      "2",
      "--role",
      "REVIEW",
      "--seat-key",
      reviewPaneKey,
    ]);

    // Only the REVIEW pane is (still) live -- the CODER round's pane is
    // gone (e.g. that worker's round ended) even though the WORKTREE itself
    // is still occupied by the live REVIEW pane.
    const swept = await runCli([
      "sweep",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      JSON.stringify([reviewPaneKey]),
      "--stale-after-ms",
      "0",
      "--recovery-grace-ms",
      "999999999",
    ]);
    assert.match(
      swept.stdout,
      /\{"reservationId":"coder-round","from":"ACTIVE","to":"SUSPECT"\}/,
      `dead coder-round must be judged dead despite sharing a worktree with the live review-round: ${swept.stdout}`,
    );
    assert.doesNotMatch(
      swept.stdout,
      /"reservationId":"review-round"/,
      `live review-round must NOT be touched: ${swept.stdout}`,
    );

    const status = await runCli(["status", "--ledger", ledger]);
    // review-round still ACTIVE (1), coder-round now SUSPECT (excluded from
    // active count) -- active drops from 2 to 1.
    assert.match(status.stdout, /CAP_STATUS active=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep + recover CLI round trip (reboot simulation: no live seats, past grace period frees the slot)", async () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    await runCli([
      "init-cutover",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
    ]);
    await runCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r1",
      "--cap",
      "1",
      "--seat-key",
      "seat-dead",
    ]);
    // stale-after/recovery-grace of 0ms so this synchronous test doesn't
    // need to sleep in wall-clock time -- the age computed against `now`
    // (captured at sweep-call time) is always >= 0ms.
    const sweepArgs = [
      "sweep",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--live-seats",
      "[]",
      "--stale-after-ms",
      "0",
      "--recovery-grace-ms",
      "0",
    ];
    const sweep1 = await runCli(sweepArgs);
    assert.match(sweep1.stdout, /CAP_SWEPT/);

    const status = await runCli(["status", "--ledger", ledger]);
    // First sweep only moves ACTIVE->SUSPECT (still 0 active); a second
    // sweep call (simulating the next periodic run) then frees it because
    // recoveryGraceMs is also 0.
    assert.match(status.stdout, /CAP_STATUS active=0/);

    const sweep2 = await runCli(sweepArgs);
    assert.match(sweep2.stdout, /CAP_SWEPT/);

    // The slot is free again -- a fresh reservation for cap=1 succeeds.
    const readmit = await runCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "r2",
      "--cap",
      "1",
    ]);
    assert.match(readmit.stdout, /CAP_ADMITTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
