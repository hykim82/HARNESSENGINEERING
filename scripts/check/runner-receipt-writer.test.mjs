import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNNER_RECEIPT_FILENAME,
  RUNNER_RECEIPT_SCHEMA_VERSION,
  RUNNER_STATUS,
  buildRunnerReceipt,
  formatKst,
  parseTapSummaryCounts,
  writeRunnerReceipt,
} from "./runner-receipt-writer.mjs";

test("formatKst: fixed +9h offset, zero-padded, always ends in ' KST' -- never UTC (coder-task.md §0-A)", () => {
  // 2026-01-01T00:00:00.000Z UTC == 2026-01-01 09:00:00 KST.
  const s = formatKst(Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(s, "2026-01-01 09:00:00 KST");
});

test("formatKst: a UTC instant just before midnight rolls the KST date forward (proves it's not just re-labeling the UTC clock)", () => {
  // 2026-06-30T15:30:05.000Z UTC == 2026-07-01 00:30:05 KST.
  const s = formatKst(Date.parse("2026-06-30T15:30:05.000Z"));
  assert.equal(s, "2026-07-01 00:30:05 KST");
});

test("parseTapSummaryCounts: reads node --test's tap-reporter summary lines ('# tests/pass/fail/skipped N')", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - a",
    "not ok 2 - b",
    "1..2",
    "# tests 2",
    "# suites 0",
    "# pass 1",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 12.3",
  ].join("\n");
  assert.deepEqual(parseTapSummaryCounts(tap), {
    tests: 2,
    pass: 1,
    fail: 1,
    skip: 0,
  });
});

test("parseTapSummaryCounts: a field that isn't present comes back null, never a fabricated 0 (honesty over completeness)", () => {
  assert.deepEqual(parseTapSummaryCounts("garbage, no summary here"), {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

test("parseTapSummaryCounts: does not confuse the default reporter's 'ℹ pass N' lines with the tap destination's '# pass N' -- only '#' counts", () => {
  const specStyle = "ℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n";
  assert.deepEqual(parseTapSummaryCounts(specStyle), {
    tests: null,
    pass: null,
    fail: null,
    skip: null,
  });
});

test("buildRunnerReceipt: shape has all §2-1-required fields, schema_version pinned, finished_at is KST text (not epoch, not UTC)", () => {
  const receipt = buildRunnerReceipt({
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 5, pass: 5, fail: 0, skip: 0 },
    headCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    finishedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(receipt, {
    schema_version: RUNNER_RECEIPT_SCHEMA_VERSION,
    runner_exit: 0,
    runner_status: RUNNER_STATUS.OK,
    tests: 5,
    pass: 5,
    fail: 0,
    skip: 0,
    head_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".slice(
      0,
      40,
    ),
    finished_at: "2026-01-01 09:00:00 KST",
  });
});

test("buildRunnerReceipt: a non-zero runner_exit is preserved verbatim, not clamped/normalized to 1 -- the exact observed code matters", () => {
  const receipt = buildRunnerReceipt({
    runnerExit: 7,
    runnerStatus: RUNNER_STATUS.TESTS_FAILED,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(receipt.runner_exit, 7);
  assert.deepEqual(
    {
      tests: receipt.tests,
      pass: receipt.pass,
      fail: receipt.fail,
      skip: receipt.skip,
    },
    { tests: null, pass: null, fail: null, skip: null },
  );
});

// HYK-473 §2-2: when a caller doesn't classify the spawn outcome itself
// (schema v1 callers, this file's own pre-HYK-473 call shape), a zero exit
// still reads as OK and any non-zero exit still reads as TESTS_FAILED --
// the old behavior is a default, not silently dropped.
test("buildRunnerReceipt: runnerStatus omitted -> derived from runnerExit (0 -> OK, non-zero -> TESTS_FAILED), never MEASUREMENT_UNAVAILABLE_OOM by default", () => {
  const ok = buildRunnerReceipt({
    runnerExit: 0,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(ok.runner_status, RUNNER_STATUS.OK);
  const failed = buildRunnerReceipt({
    runnerExit: 1,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(failed.runner_status, RUNNER_STATUS.TESTS_FAILED);
});

test("buildRunnerReceipt: an explicit MEASUREMENT_UNAVAILABLE_OOM runnerStatus is preserved verbatim, not overridden by the runnerExit-derived default", () => {
  const receipt = buildRunnerReceipt({
    runnerExit: 1,
    runnerStatus: RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
    counts: null,
    headCommit: "abc",
    finishedAtMs: 0,
  });
  assert.equal(
    receipt.runner_status,
    RUNNER_STATUS.MEASUREMENT_UNAVAILABLE_OOM,
  );
  assert.notEqual(receipt.runner_status, RUNNER_STATUS.TESTS_FAILED);
});

test("writeRunnerReceipt: creates harnessDir if missing, writes valid JSON matching buildRunnerReceipt, and returns the path written", () => {
  let mkdirArgs;
  let writeArgs;
  const { path, receipt } = writeRunnerReceipt({
    harnessDir: "/fake/.harness",
    runnerExit: 0,
    runnerStatus: RUNNER_STATUS.OK,
    counts: { tests: 1, pass: 1, fail: 0, skip: 0 },
    headCommit: "cafef00d",
    finishedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    mkdirFn: (...args) => {
      mkdirArgs = args;
    },
    writeFileFn: (...args) => {
      writeArgs = args;
    },
  });
  assert.deepEqual(mkdirArgs, ["/fake/.harness", { recursive: true }]);
  assert.equal(path, writeArgs[0]);
  assert.equal(
    path.replace(/\\/g, "/"),
    `/fake/.harness/${RUNNER_RECEIPT_FILENAME}`,
  );
  const written = JSON.parse(writeArgs[1]);
  assert.deepEqual(written, receipt);
  assert.equal(written.runner_exit, 0);
  assert.equal(written.runner_status, RUNNER_STATUS.OK);
  assert.equal(written.head_commit, "cafef00d");
  assert.equal(writeArgs[2], "utf8");
});
