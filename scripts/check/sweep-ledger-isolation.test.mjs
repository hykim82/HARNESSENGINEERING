// HYK-279: pins sweep-ledger-isolation.mjs's two obligations --
// (a) when ADMISSION_LEDGER_PATH is unset, importing it defaults to an
//     isolated, sweep-scoped tmp path (never the real control-room ledger).
// (b) RED-on-revert (coder-task.md §2 항4): reproduced entirely with a
//     SYNTHETIC "would-be persistent pointer" repo (never the real
//     HARNESSENGINEERING checkout, never the real control room) --
//     without the preload, a spawned child that inherits an ambient
//     persistent pointer DOES complete against it (proves the leak
//     mechanism is real); with the preload, the same child does NOT
//     (proves the fix actually closes it). Reverting sweep-ledger-
//     isolation.mjs's guard turns the second half of this test RED.
//
// ⛔ never touches the real HARNESSENGINEERING repo or the real control
// room -- every repo/ledger here is a mkdtemp fixture, one level of
// indirection further than admission-completion-persistent-source.test.mjs
// (that file proves the adapter's own priority rule in-process; this file
// proves the *sweep preload* actually engages that rule for a spawned
// child, which is the exact shape of the real leak: relay-handshake.mjs's
// spawnAdmissionCompletion spawns admission-completion-adapter.mjs as a
// child, not an in-process call).
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = join(HERE, "admission-completion-adapter.mjs");
const ISOLATION_PRELOAD = join(HERE, "sweep-ledger-isolation.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Mirrors admission-completion-persistent-source.test.mjs's buildSyntheticRepo
// exactly (same reason: mainRepoRoot() needs a real `.git` to resolve to).
function buildSyntheticRepo(prefix) {
  const dir = tmpDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: dir });
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

function readStatus(ledger, reservationId) {
  return JSON.parse(readFileSync(ledger, "utf8")).reservations[reservationId]
    .status;
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

// Spawns a child `node` process that (optionally) preloads
// sweep-ledger-isolation.mjs, then calls autoCompleteAdmission for
// `reservationId`, with cwd pinned at `repoDir` and ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH stripped from the child's env -- mirrors exactly how
// relay-handshake.mjs's spawnAdmissionCompletion spawns the real adapter
// (execFileSync, env inherited except what we explicitly strip here to
// simulate "genuinely unset").
// HYK-289: admission-completion-adapter.mjs now also gates the
// persistent-pointer branch behind `!process.env.NODE_TEST_CONTEXT` (a
// Node.js-builtin var `node --test` sets on ITS OWN process -- see that
// file's persistentFallbackAllowed). Since this whole test file runs under
// `node --test`, `childEnv = {...process.env}` below inherits that var into
// every spawned child BY DEFAULT now, even a plain `node run.mjs` with no
// `--test`/`--import` of its own -- closing the leak one layer earlier than
// this file originally measured. `stripNodeTestContext` lets the ⓐ
// "unisolated" branch simulate the one remaining ambiguous shape this
// adapter-level guard cannot see (a check/smoke entry point invoked
// completely outside `node --test`, e.g. `node
// scripts/check/selfcheck-smoke.mjs` run by hand -- selfcheck-smoke.mjs
// itself is separately fixed by self-importing this preload, coder.md's
// 정직 한계 documents why that residual gap can't be closed from inside the
// adapter alone).
function runChildCompletion({
  repoDir,
  reservationId,
  preload,
  stripNodeTestContext = false,
}) {
  const runnerSrc = `
import { autoCompleteAdmission } from ${JSON.stringify(`file://${ADAPTER_PATH.replace(/\\/g, "/")}`)};
const outcome = autoCompleteAdmission({ reservationId: ${JSON.stringify(reservationId)} });
process.stdout.write(JSON.stringify(outcome));
`;
  const runnerDir = tmpDir("hyk279-sweep-isolation-child-");
  const runnerPath = join(runnerDir, "run.mjs");
  writeFileSync(runnerPath, runnerSrc, "utf8");
  try {
    const childEnv = { ...process.env };
    delete childEnv.ADMISSION_LEDGER_PATH;
    delete childEnv.ADMISSION_LOCK_PATH;
    if (stripNodeTestContext) delete childEnv.NODE_TEST_CONTEXT;
    const args = preload
      ? [`--import=${pathToFileURL(ISOLATION_PRELOAD).href}`, runnerPath]
      : [runnerPath];
    const out = execFileSync(process.execPath, args, {
      cwd: repoDir,
      env: childEnv,
      encoding: "utf8",
    });
    return JSON.parse(out.trim().split("\n").pop());
  } finally {
    rmSync(runnerDir, { recursive: true, force: true });
  }
}

test("sweep-ledger-isolation: importing it with ADMISSION_LEDGER_PATH unset defaults to an isolated tmp path, never a real one", () => {
  const runnerDir = tmpDir("hyk279-sweep-isolation-probe-");
  const runnerPath = join(runnerDir, "probe.mjs");
  writeFileSync(
    runnerPath,
    `import ${JSON.stringify(`file://${ISOLATION_PRELOAD.replace(/\\/g, "/")}`)};\nprocess.stdout.write(JSON.stringify({ ledger: process.env.ADMISSION_LEDGER_PATH, lock: process.env.ADMISSION_LOCK_PATH }));\n`,
    "utf8",
  );
  try {
    const childEnv = { ...process.env };
    delete childEnv.ADMISSION_LEDGER_PATH;
    delete childEnv.ADMISSION_LOCK_PATH;
    const out = execFileSync(process.execPath, [runnerPath], {
      env: childEnv,
      encoding: "utf8",
    });
    const { ledger, lock } = JSON.parse(out.trim());
    assert.ok(ledger, "ADMISSION_LEDGER_PATH must be set after the preload");
    assert.ok(lock, "ADMISSION_LOCK_PATH must be set after the preload");
    const normalizedTmp = tmpdir().replace(/\\/g, "/").toLowerCase();
    assert.ok(
      ledger.replace(/\\/g, "/").toLowerCase().startsWith(normalizedTmp),
      `defaulted ledger path must live under the OS tmp dir, got: ${ledger}`,
    );
    assert.doesNotMatch(
      ledger,
      /하네스-관제실|admission-ledger\.json$/,
      "must never coincide with the real control-room ledger path/name",
    );
  } finally {
    rmSync(runnerDir, { recursive: true, force: true });
  }
});

test("RED-on-revert (synthetic only): without the sweep-ledger-isolation preload, a spawned completion falls through to a synthetic persistent pointer and mutates it; with the preload, it does not", () => {
  const repoDir = buildSyntheticRepo("hyk279-sweep-isolation-red-repo-");
  const ledgerDir = tmpDir("hyk279-sweep-isolation-red-ledger-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-279-RED-1");
    writePointerFile(repoDir, ledger, lock);

    // ⓐ isolation NOT engaged, NODE_TEST_CONTEXT also stripped (the one
    // shape HYK-289's adapter-level guard cannot see -- a check/smoke entry
    // point run completely outside `node --test`, ambiguous by
    // construction). Proves the leak mechanism is still real for that
    // residual case: the synthetic "persistent" reservation actually gets
    // completed by a spawned child that never opted in to any isolation,
    // exactly like the pre-fix relay-handshake.mjs call sites this round
    // found (and exactly like selfcheck-smoke.mjs's own pre-HYK-289 shape).
    const unisolated = runChildCompletion({
      repoDir,
      reservationId: "HYK-279-RED-1",
      preload: false,
      stripNodeTestContext: true,
    });
    assert.equal(unisolated.attempted, true);
    assert.equal(unisolated.ok, true, `expected success: ${unisolated.reason}`);
    assert.equal(
      readStatus(ledger, "HYK-279-RED-1"),
      "COMPLETED",
      "RED corroboration: without isolation, the synthetic persistent-pointer ledger DOES get mutated",
    );

    // ⓑ isolation engaged -- re-admit the same id (undo ⓐ's completion so
    // this half starts from a clean ACTIVE state), then run the identical
    // spawn WITH the preload. The persistent-pointer ledger must come out
    // untouched this time -- the preload's env default routes the child to
    // its own disposable ledger instead.
    runAdmissionCli([
      "admit",
      "--ledger",
      ledger,
      "--lock",
      lock,
      "--reservation-id",
      "HYK-279-RED-1",
      "--cap",
      "1",
    ]);
    const isolated = runChildCompletion({
      repoDir,
      reservationId: "HYK-279-RED-1",
      preload: true,
    });
    assert.equal(
      readStatus(ledger, "HYK-279-RED-1"),
      "ACTIVE",
      "with isolation engaged, the synthetic persistent-pointer ledger must stay untouched -- this is what would go RED if sweep-ledger-isolation.mjs's env-default guard were removed",
    );
    // The isolated child still "attempted" (against its own disposable
    // ledger, which was never init-cutover'd) -- attempted:true, ok:false
    // is the expected, harmless shape; the point is WHICH ledger it hit.
    assert.equal(isolated.attempted, true);
    assert.notEqual(
      isolated.ok,
      true,
      "the isolated child must not report success against a reservation id it never actually released",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

// HYK-289: bonus defense-in-depth this round's adapter change adds -- a
// spawned child that inherits NODE_TEST_CONTEXT naturally (this test file's
// own `node --test` process env, no explicit preload, no explicit env
// override at all) is now ALSO protected, one layer earlier than
// sweep-ledger-isolation.mjs's own `--import` preload. This is not a
// replacement for that preload (a plain `node foo.mjs` run outside
// `node --test` still has no NODE_TEST_CONTEXT -- see the ⓐ branch above),
// but it closes the gap for the common case of a check/test file spawning
// relay-handshake.mjs's CLI from inside a `node --test` run without
// remembering the preload.
test("HYK-289 bonus: a child that merely inherits NODE_TEST_CONTEXT (no preload, no explicit env) never reaches the synthetic persistent pointer", () => {
  const repoDir = buildSyntheticRepo("hyk289-node-test-context-repo-");
  const ledgerDir = tmpDir("hyk289-node-test-context-ledger-");
  try {
    const ledger = join(ledgerDir, "l.json");
    const lock = join(ledgerDir, "l.lock");
    initAndAdmit(ledger, lock, "HYK-289-NTC-1");
    writePointerFile(repoDir, ledger, lock);

    const outcome = runChildCompletion({
      repoDir,
      reservationId: "HYK-289-NTC-1",
      preload: false,
    });

    assert.deepEqual(
      outcome,
      { attempted: false },
      "NODE_TEST_CONTEXT alone (inherited, no preload) must already fail closed",
    );
    assert.equal(
      readStatus(ledger, "HYK-289-NTC-1"),
      "ACTIVE",
      "the synthetic persistent-pointer ledger must stay untouched",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
