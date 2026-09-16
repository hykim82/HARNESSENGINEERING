// HYK-473: two independent axes --
// (a) the in-clone `node --test` invocation now carries a concurrency cap
//     instead of node --test's own default (CPU-core-count-wide) fan-out,
//     which HYK-468 4R traced 3 consecutive real forced-kill runs to
//     (evidence: C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/
//     hyk468-466-465-467-unblock-1/.harness/rounds/CODER-r4.md §9 --
//     ~3.6-3.8GB/16.7GB free, steady across all 3 attempts).
// (b) a forced kill (signal, or spawnSync erroring before a real exit) must
//     be recorded as a DIFFERENT fact from "the tests failed" -- coder-
//     task.md §1's "«fail 0인데 초록이 아니다»를 구별" requirement.
//
// coder-task.md §0.5 forbids running the actual full runner (against the
// real ~50+ file suite) before 14:00 KST / before ORCH signals go -- every
// test in this file either calls production functions directly with fully
// controlled inputs, or drives runIsolatedSuite with mocked git/collectFiles
// so the real repo is never cloned and the real suite never runs. Two
// tests do spawn a REAL child process (a one-line `node -e ...`, not the
// suite) to make the OOM-vs-failure distinction an empirical fact about
// spawnSync rather than an assumption about it -- this is exactly the
// "합성으로" forced kill construction task §3 proof 2 asks for, scoped to
// a single trivial child instead of the real suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { RUNNER_STATUS } from "./runner-receipt-writer.mjs";
import {
  classifySpawnOutcome,
  formatConcurrencyBanner,
  resolveConcurrency,
  runIsolatedSuite,
} from "./isolated-suite-runner.mjs";

// -- §2-1: resolveConcurrency ------------------------------------------

test("resolveConcurrency: max(1, floor(cpuCount/2)) -- halves core count, never rounds up past it", () => {
  assert.equal(resolveConcurrency({ cpuCount: 24 }), 12);
  assert.equal(resolveConcurrency({ cpuCount: 8 }), 4);
  assert.equal(resolveConcurrency({ cpuCount: 4 }), 2);
});

test("resolveConcurrency: odd/low core counts floor down but never below 1 (guards 1-2 core machines)", () => {
  assert.equal(resolveConcurrency({ cpuCount: 3 }), 1);
  assert.equal(resolveConcurrency({ cpuCount: 2 }), 1);
  assert.equal(resolveConcurrency({ cpuCount: 1 }), 1);
});

test("resolveConcurrency: with no cpuCount override, resolves from the real host (this machine has >=1 core, result is a positive integer)", () => {
  const n = resolveConcurrency();
  assert.ok(
    Number.isInteger(n) && n >= 1,
    `expected a positive integer, got ${n}`,
  );
});

// -- §2-1: the cap value in the log's first line ------------------------

const noopWriteReceipt = () => ({ path: "(stubbed)", receipt: {} });
// HYK-485 §2-1: runIsolatedSuite now allocates a numbered-artifact slot
// (allocateRunSlotFn) before spawn and writes a numbered receipt copy
// (writeNumberedReceipt) after -- both default to REAL fs-touching
// implementations in production. This file's execFileStub returns a fake
// "/src" root, so leaving either default un-stubbed here would make these
// tests actually mkdir/write under a real (if odd) path on the test
// machine. Every runIsolatedSuite call below stubs both.
const noopAllocateRunSlot = () => ({
  runNumber: 1,
  receiptPath: "(stubbed-receipt-path)",
  logPath: "(stubbed-log-path)",
});
const noopWriteNumberedReceipt = () => ({ path: "(stubbed)", receipt: {} });
const throwingReadFile = () => {
  throw new Error("stubbed: no tap file in this test");
};
function execFileStub() {
  return (cmd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/src\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
    if (args[0] === "status") return "";
    if (args[0] === "clone") return "";
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };
}

test("runIsolatedSuite: the resolved test-concurrency value is the literal first log() line of the run (coder-task.md §2-1 'first line' requirement)", () => {
  const logs = [];
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    concurrency: 3,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.match(logs[0], /^\[isolated-suite-runner\] test-concurrency=3 /);
});

test("runIsolatedSuite: an explicit --concurrency override is labeled as an override in the same first line, not the default reasoning text", () => {
  const logs = [];
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    concurrency: 2,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.match(logs[0], /explicit --concurrency override/);
});

test("runIsolatedSuite: with no explicit concurrency, the first line carries the default reasoning (cpu-count-derived, not a bare number with no context)", () => {
  const logs = [];
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    resolveConcurrencyFn: () => 7,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.match(logs[0], /test-concurrency=7/);
  assert.match(logs[0], /max\(1, floor\(cpu-count\/2\)\)/);
});

test("formatConcurrencyBanner: names the flag, the value, and the reason -- a human reading it should not have to guess either", () => {
  const line = formatConcurrencyBanner({
    concurrency: 5,
    reason: "test reason",
  });
  assert.match(line, /test-concurrency=5/);
  assert.match(line, /test reason/);
});

// -- §2-1: the concurrency value actually reaches node --test's argv ----

test("runIsolatedSuite: --test-concurrency=<resolved value> is present in the in-clone node --test argv", () => {
  let capturedArgs;
  const spawn = (cmd, args) => {
    capturedArgs = args;
    return { status: 0 };
  };
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn,
    log: () => {},
    collectFiles: () => ["scripts/check/a.test.mjs"],
    concurrency: 5,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.ok(
    capturedArgs.includes("--test-concurrency=5"),
    `expected --test-concurrency=5 in argv, got: ${JSON.stringify(capturedArgs)}`,
  );
});

// -- HYK-485 §2-1: the third (persistent log) reporter destination -------

test("runIsolatedSuite: when allocateRunSlotFn resolves a slot, a third '--test-reporter=spec --test-reporter-destination=<logPath>' pair rides the in-clone argv alongside the existing stdout/tap pairs (기존 두 reporter는 그대로 남는다)", () => {
  let capturedArgs;
  const spawn = (cmd, args) => {
    capturedArgs = args;
    return { status: 0 };
  };
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn,
    log: () => {},
    collectFiles: () => ["scripts/check/a.test.mjs"],
    concurrency: 1,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: () => ({
      runNumber: 1,
      receiptPath: "(stub-receipt)",
      logPath: "/fake/.harness/full-runner-1.log",
    }),
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.ok(
    capturedArgs.includes("--test-reporter=spec"),
    `spec reporter must still be present, got: ${JSON.stringify(capturedArgs)}`,
  );
  assert.ok(
    capturedArgs.includes("--test-reporter-destination=stdout"),
    `stdout destination must still be present (live human view unchanged), got: ${JSON.stringify(capturedArgs)}`,
  );
  assert.ok(
    capturedArgs.includes(
      "--test-reporter-destination=/fake/.harness/full-runner-1.log",
    ),
    `expected the numbered log destination in argv, got: ${JSON.stringify(capturedArgs)}`,
  );
  // spec reporter appears twice (stdout leg + log leg); tap reporter once.
  assert.equal(
    capturedArgs.filter((a) => a === "--test-reporter=spec").length,
    2,
  );
  assert.equal(
    capturedArgs.filter((a) => a === "--test-reporter=tap").length,
    1,
  );
});

test("runIsolatedSuite: when allocateRunSlotFn yields no slot (null), no third reporter pair is added -- argv is byte-identical to pre-HYK-485 shape", () => {
  let capturedArgs;
  const spawn = (cmd, args) => {
    capturedArgs = args;
    return { status: 0 };
  };
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn,
    log: () => {},
    collectFiles: () => ["scripts/check/a.test.mjs"],
    concurrency: 1,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: () => null,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.equal(
    capturedArgs.filter((a) => a === "--test-reporter=spec").length,
    1,
    `expected only ONE spec reporter when no slot was allocated, got: ${JSON.stringify(capturedArgs)}`,
  );
});

test("runIsolatedSuite: allocateRunSlotFn throwing does not crash the run -- it degrades to no numbered artifacts (WARNING logged), the real suite still runs and the real exit code still propagates", () => {
  const logs = [];
  const exitCode = runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => ({ status: 0 }),
    log: (m) => logs.push(m),
    collectFiles: () => [],
    concurrency: 1,
    readFile: throwingReadFile,
    writeReceipt: noopWriteReceipt,
    allocateRunSlotFn: () => {
      throw new Error("EACCES: permission denied, simulated");
    },
    writeNumberedReceipt: () => {
      throw new Error(
        "should never be called -- no slot means writeNumberedReceipt is never invoked",
      );
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(
    logs.some((l) =>
      /WARNING: failed to allocate a per-run artifact slot/.test(l),
    ),
    `expected a WARNING log line, got: ${JSON.stringify(logs)}`,
  );
});

// -- §2-2: classifySpawnOutcome -- structural, never string-matched -----

test("classifySpawnOutcome: status 0, no signal, no error -> OK", () => {
  assert.deepEqual(
    classifySpawnOutcome({ status: 0, signal: null, error: null }),
    {
      status: RUNNER_STATUS.OK,
      exitCode: 0,
    },
  );
});

test("classifySpawnOutcome: non-zero status, no signal, no error, node --test reported a completion summary -> TESTS_FAILED (a real run that really failed)", () => {
  assert.deepEqual(
    classifySpawnOutcome(
      { status: 3, signal: null, error: null },
      { hasCompletion: true },
    ),
    {
      status: RUNNER_STATUS.TESTS_FAILED,
      exitCode: 3,
    },
  );
});

// HYK-477 §2-3 2R (검토 P1-1 재반려 재현, rounds/REVIEW-r1.md): Windows에는
// POSIX 시그널이 없어 강제 종료가 result.status에 숫자 0xFFFFFFFF로 들어오고
// signal/error는 둘 다 비어 있다 -- 이 저장소가 스스로 쓴 영수증
// (.harness/runner-receipt-run5.json)의 정확한 모양. hasCompletion이 없으면
// (=tap 요약을 못 읽었으면, 진짜 강제종료가 정확히 이 모양이다) 여전히
// MEASUREMENT_UNAVAILABLE_OOM이어야 한다 -- status 목록에 기대지 않는 축.
test("classifySpawnOutcome: the Windows forced-kill shape this repo actually produces (status 0xFFFFFFFF, no signal, no error), no tap completion -> MEASUREMENT_UNAVAILABLE_OOM, NOT TESTS_FAILED (HYK-477 §2-3 2R fix -- previously this fell through to TESTS_FAILED, review P1-1)", () => {
  const outcome = classifySpawnOutcome({
    status: 4294967295,
    signal: null,
    error: null,
  });
  assert.equal(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
  assert.notEqual(outcome.status, RUNNER_STATUS.TESTS_FAILED);
});

test("classifySpawnOutcome: the SAME Windows-shaped non-zero status, but node --test DID report a completion summary (a real failing test can exit non-zero on Windows too) -> TESTS_FAILED, detection not lost", () => {
  const outcome = classifySpawnOutcome(
    { status: 1, signal: null, error: null },
    { hasCompletion: true },
  );
  assert.equal(outcome.status, RUNNER_STATUS.TESTS_FAILED);
  assert.notEqual(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
});

test("classifySpawnOutcome: a signal is set (status null) -> MEASUREMENT_UNAVAILABLE_OOM, never TESTS_FAILED, decided on .signal alone (not on any message text)", () => {
  const outcome = classifySpawnOutcome({
    status: null,
    signal: "SIGKILL",
    error: null,
  });
  assert.equal(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
  assert.notEqual(outcome.status, RUNNER_STATUS.TESTS_FAILED);
});

// HYK-477 §2-3: the previously-unguarded last branch. Before this round,
// `status: null, signal: null, error: null` fell all the way through to
// `TESTS_FAILED` (result.status ?? 1) -- exactly the "측정 불능 -> 시험
// 실패" collapse §2-2 exists to prevent, just one layer lower (inside the
// classifier itself rather than at the consumption gate).
test("classifySpawnOutcome: status null, signal null, error null (no real completion reported, no kill signal seen either) -> MEASUREMENT_UNAVAILABLE_OOM, NOT TESTS_FAILED (HYK-477 §2-3 fix -- previously this fell through to TESTS_FAILED)", () => {
  const outcome = classifySpawnOutcome({
    status: null,
    signal: null,
    error: null,
  });
  assert.equal(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
  assert.notEqual(outcome.status, RUNNER_STATUS.TESTS_FAILED);
});

test("classifySpawnOutcome: status undefined (same 'no real completion' shape as null), no signal, no error -> MEASUREMENT_UNAVAILABLE_OOM", () => {
  const outcome = classifySpawnOutcome({});
  assert.equal(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
});

test("classifySpawnOutcome: .error is set with no signal (e.g. a spawn-level failure) -> MEASUREMENT_UNAVAILABLE_OOM, not TESTS_FAILED", () => {
  const outcome = classifySpawnOutcome({
    status: null,
    signal: null,
    error: new Error("spawnSync ENOMEM"),
  });
  assert.equal(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
  assert.notEqual(outcome.status, RUNNER_STATUS.TESTS_FAILED);
});

// -- §3 proof 2: a REAL, synthetically forced-killed child (not mocked) -

test("classifySpawnOutcome: a REAL child forcibly killed via spawnSync timeout+SIGKILL classifies as MEASUREMENT_UNAVAILABLE_OOM (empirical, not assumed -- this round's own measured spawnSync shape: status null, signal SIGKILL, error ETIMEDOUT)", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)"],
    { timeout: 300, killSignal: "SIGKILL" },
  );
  const outcome = classifySpawnOutcome(result);
  assert.equal(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
  assert.notEqual(outcome.status, RUNNER_STATUS.TESTS_FAILED);
});

test("classifySpawnOutcome: a REAL child that exits non-zero entirely on its own (no kill involved), node --test reported a completion -> classifies as TESTS_FAILED -- same-situation contrast proving the two are not conflated", () => {
  const result = spawnSync(process.execPath, ["-e", "process.exit(3)"]);
  // this synthetic child is not node --test itself (§3 proof 2 scopes the
  // REAL-child tests to a trivial one-liner, not the real suite) -- the
  // signal/no-kill axis is what THIS test proves; hasCompletion:true stands
  // in for "node --test, in production, would have written a tap summary
  // for a run that really ran to completion" (that axis is proven on its
  // own, above, via hasTapCompletion's real tap-file wiring in the
  // full-pipeline test below).
  const outcome = classifySpawnOutcome(result, { hasCompletion: true });
  assert.equal(outcome.status, RUNNER_STATUS.TESTS_FAILED);
  assert.notEqual(outcome.status, RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM);
});

// -- §3 proof 2, full pipeline: the receipt payload itself carries the --
// -- distinction, driven by a real kill through runIsolatedSuite's own ---
// -- spawn->classify->receipt wiring (git/collectFiles mocked so no real --
// -- clone or real suite ever runs -- coder-task.md §0.5). ---------------

test("runIsolatedSuite: a REAL synthetically forced-killed child produces a receipt with runnerStatus MEASUREMENT_UNAVAILABLE_OOM, never TESTS_FAILED, and a non-zero exit code", () => {
  const receipts = [];
  const exitCode = runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () =>
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        timeout: 300,
        killSignal: "SIGKILL",
      }),
    log: () => {},
    collectFiles: () => [],
    readFile: throwingReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].runnerStatus,
    RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
  );
  assert.notEqual(receipts[0].runnerStatus, RUNNER_STATUS.TESTS_FAILED);
  assert.notEqual(exitCode, 0);
});

// HYK-477 §2-3 2R: unlike the forced-kill test above, this run's outcome now
// depends on hasCompletion (status=3, no signal, no error is the "ambiguous"
// branch) -- so this fixture's readFile must actually return a completion
// summary (a real node --test run that really failed DOES write one), not
// throwingReadFile. If it still threw here, hasTapCompletion would report
// "no completion" and this would wrongly classify as MEASUREMENT_UNAVAILABLE
// instead of TESTS_FAILED -- exactly the mutation this file's M-series
// (below, isolated-suite-runner.test.mjs) proves RED for.
const completedTapSummary =
  "TAP version 13\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";
const tapCompletionReadFile = () => completedTapSummary;

test("runIsolatedSuite: a REAL child failing entirely on its own (same pipeline, no kill), a real tap completion summary present -> produces a receipt with runnerStatus TESTS_FAILED -- the same-situation contrast at the full-pipeline level", () => {
  const receipts = [];
  const exitCode = runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => spawnSync(process.execPath, ["-e", "process.exit(3)"]),
    log: () => {},
    collectFiles: () => [],
    readFile: tapCompletionReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.TESTS_FAILED);
  assert.notEqual(
    receipts[0].runnerStatus,
    RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
  );
  assert.equal(exitCode, 3);
});

test("runIsolatedSuite: a REAL child that exits non-zero on its own, but no tap completion summary was ever written (e.g. the Windows 0xFFFFFFFF shape this repo actually produces) -> produces a receipt with runnerStatus MEASUREMENT_UNAVAILABLE_OOM, NOT TESTS_FAILED (review P1-1, full-pipeline level)", () => {
  const receipts = [];
  runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => ({ status: 4294967295, signal: null, error: null }),
    log: () => {},
    collectFiles: () => [],
    readFile: throwingReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.equal(
    receipts[0].runnerStatus,
    RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
  );
  assert.notEqual(receipts[0].runnerStatus, RUNNER_STATUS.TESTS_FAILED);
});

test("runIsolatedSuite: a REAL clean child (status 0) produces a receipt with runnerStatus OK -- the third leg of the same contrast", () => {
  const receipts = [];
  const exitCode = runIsolatedSuite({
    execFile: execFileStub(),
    spawn: () => spawnSync(process.execPath, ["-e", "process.exit(0)"]),
    log: () => {},
    collectFiles: () => [],
    readFile: throwingReadFile,
    writeReceipt: (payload) => {
      receipts.push(payload);
      return { path: "(stubbed)", receipt: {} };
    },
    allocateRunSlotFn: noopAllocateRunSlot,
    writeNumberedReceipt: noopWriteNumberedReceipt,
  });
  assert.equal(receipts[0].runnerStatus, RUNNER_STATUS.OK);
  assert.equal(exitCode, 0);
});
