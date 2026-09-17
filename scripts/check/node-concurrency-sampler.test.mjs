// HYK-477 §1-3/§1-4: node-concurrency-sampler.mjs's pure, injectable pieces
// -- countNodeProcesses{Windows,Posix,''} and sampleOnce. The real CLI loop
// (setInterval against the real OS process list) is exercised end-to-end by
// isolated-suite-runner.test.mjs's own sampler-wiring tests instead of here,
// so this file stays fast and platform-independent (no real `tasklist`/`ps`
// spawned).
import assert from "node:assert/strict";
import test from "node:test";
import {
  countNodeProcesses,
  countNodeProcessesPosix,
  countNodeProcessesWindows,
  sampleOnce,
} from "./node-concurrency-sampler.mjs";

test("countNodeProcessesWindows: counts one line per tasklist CSV row", () => {
  const exec = () =>
    '"node.exe","1234","Console","1","50,000 K"\r\n"node.exe","5678","Console","1","48,000 K"\r\n';
  assert.equal(countNodeProcessesWindows({ exec }), 2);
});

test("countNodeProcessesWindows: tasklist's 'no tasks' message reads as 0, not 1", () => {
  const exec = () =>
    "INFO: No tasks are running which match the specified criteria.\r\n";
  assert.equal(countNodeProcessesWindows({ exec }), 0);
});

test("countNodeProcessesPosix: counts lines exactly equal to 'node', ignoring blanks and near-miss names", () => {
  const exec = () => "node\nbash\nnode-gyp\nnode\n\n";
  assert.equal(countNodeProcessesPosix({ exec }), 2);
});

test("countNodeProcesses: dispatches on platform (win32 -> tasklist parser, else -> ps parser)", () => {
  const winExec = () => '"node.exe","1","Console","1","1 K"\r\n';
  assert.equal(countNodeProcesses({ platform: "win32", exec: winExec }), 1);
  const posixExec = () => "node\nnode\nnode\n";
  assert.equal(countNodeProcesses({ platform: "linux", exec: posixExec }), 3);
});

test("countNodeProcesses: a failing exec (command missing/errors) degrades to null, never throws -- §측정 불능 is a distinct fact, not a crash", () => {
  const throwingExec = () => {
    throw new Error("ENOENT: tasklist not found");
  };
  assert.equal(
    countNodeProcesses({ platform: "win32", exec: throwingExec }),
    null,
  );
});

test("sampleOnce: folds each sample into a running MAX, never an average/last-seen", () => {
  const state = { max: null, samples: 0 };
  const written = [];
  const writeFileFn = (path, data) => written.push(JSON.parse(data));
  const counts = [3, 7, 2, 5];
  let i = 0;
  const countFn = () => counts[i++];
  for (let k = 0; k < counts.length; k++) {
    sampleOnce({ state, outPath: "(unused)", countFn, writeFileFn });
  }
  assert.equal(state.max, 7);
  assert.equal(state.samples, 4);
  assert.equal(written.at(-1).max, 7);
  assert.equal(written.at(-1).samples, 4);
});

test("sampleOnce: a null-returning countFn (failed sample) does not corrupt the running max or count", () => {
  const state = { max: 4, samples: 2 };
  const writeFileFn = () => {};
  sampleOnce({ state, outPath: "(unused)", countFn: () => null, writeFileFn });
  assert.equal(
    state.max,
    4,
    "a failed sample must not overwrite a real prior max with null",
  );
  assert.equal(
    state.samples,
    2,
    "a failed sample must not be counted as an observation",
  );
});

test("sampleOnce: a write failure (e.g. disk full, path gone) is swallowed -- sampling must survive a bad tick", () => {
  const state = { max: null, samples: 0 };
  const writeFileFn = () => {
    throw new Error("ENOSPC");
  };
  assert.doesNotThrow(() =>
    sampleOnce({ state, outPath: "(unused)", countFn: () => 5, writeFileFn }),
  );
  assert.equal(
    state.max,
    5,
    "the in-memory max is still updated even when persisting it fails",
  );
});
