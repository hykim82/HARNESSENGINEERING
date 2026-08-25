// HYK-186 §5 변조 6건 -- mutation coverage for every mechanism this task
// adds/depends on. Follows hyk183-ledger-fix-mutation.test.mjs's convention
// (NOT reject-streak-auto-record.test.mjs's `git show HEAD:...` convention):
// this task's fix is uncommitted working-tree source (§1 "커밋은 하되
// push·PR 금지" -- but commit happens AFTER verification), so every mutant
// below reads the CURRENT WORKING TREE directly via readFileSync, or these
// tests would silently skip/pass against the pre-fix HEAD and report a false
// green (coder-task.md §2 비타협 "조용히 하나를 고르지 않는다"의 정신을
// 시험 인프라 자체에도 적용).
//
// 매핑 (coder-task.md §5):
//   변조1 registry 행 제거            -> mutation("registry row removal")
//   변조2 미래 상한 제거              -> mutation("future upper bound removal")
//   변조3 caller-supplied 시각 수용   -> mutation("finalize-done caller-supplied time")
//   변조4 과거 DONE 재사용 차단 제거  -> mutation("stale-DONE reuse guard removal")
//   변조5 watch-result 사유 결선 제거 -> mutation("watch-result future wiring removal")
//   변조6 기존 회귀 0                 -> covered by the full suite run (§7), not this file
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = join(CHECK_DIR, "..", "relay");

const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");
const TIME_AUTHORITY_PATH = join(CHECK_DIR, "time-authority.mjs");
const REJECT_STREAK_PATH = join(CHECK_DIR, "reject-streak.mjs");
const ENVELOPE_ARCHIVE_PATH = join(CHECK_DIR, "envelope-archive.mjs");
// HYK-353 2R §1 (P1-2): finalize-done.mjs now statically imports
// first-observation.mjs (the active-observation gate) -- this fixed sidecar
// list must grow to match finalize-done.mjs's own real dependency list, or
// mutation 3 below (which stages finalize-done.mjs) fails to even load
// (ERR_MODULE_NOT_FOUND) regardless of the mutation itself.
const FIRST_OBSERVATION_PATH = join(CHECK_DIR, "first-observation.mjs");
const WATCH_RESULT_PATH = join(RELAY_DIR, "watch-result.mjs");
const FINALIZE_DONE_PATH = join(RELAY_DIR, "finalize-done.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function runCli(scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}
function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

// Builds a fresh scripts/check + scripts/relay tree in a tmpdir so relative
// imports between the mutant and its (real, unmutated unless specified)
// siblings resolve, mirroring writeMutantCli's approach in
// relay-handshake.test.mjs.
function stageTree({ checkOverrides = {}, relayOverrides = {} } = {}) {
  const root = tmpDir("hyk186-mut-");
  const checkDir = join(root, "scripts", "check");
  const relayDir = join(root, "scripts", "relay");
  mkdirSync(checkDir, { recursive: true });
  mkdirSync(relayDir, { recursive: true });

  const checkFiles = {
    "relay-handshake.mjs": RELAY_HANDSHAKE_PATH,
    "time-authority.mjs": TIME_AUTHORITY_PATH,
    "reject-streak.mjs": REJECT_STREAK_PATH,
    "envelope-archive.mjs": ENVELOPE_ARCHIVE_PATH,
    "first-observation.mjs": FIRST_OBSERVATION_PATH,
  };
  for (const [name, srcPath] of Object.entries(checkFiles)) {
    const content = checkOverrides[name] ?? readFileSync(srcPath, "utf8");
    writeFileSync(join(checkDir, name), content, "utf8");
  }

  const relayFiles = {
    "watch-result.mjs": WATCH_RESULT_PATH,
    "finalize-done.mjs": FINALIZE_DONE_PATH,
  };
  for (const [name, srcPath] of Object.entries(relayFiles)) {
    const content = relayOverrides[name] ?? readFileSync(srcPath, "utf8");
    writeFileSync(join(relayDir, name), content, "utf8");
  }

  return {
    root,
    relayHandshakePath: join(checkDir, "relay-handshake.mjs"),
    watchResultPath: join(relayDir, "watch-result.mjs"),
    finalizeDonePath: join(relayDir, "finalize-done.mjs"),
  };
}

// ---------------------------------------------------------------------------
// 변조1 (필수): registry row removal -> a normal, valid, past-dated DONE
// wrongly gets blocked (fail-closed on the missing row) -- proves the row is
// actually load-bearing, not decorative.
// ---------------------------------------------------------------------------
test("mutation 1 (필수): time-authority.mjs's RESULT_DONE_AT registry row removed -> a normal valid DONE is wrongly rejected -> RED", () => {
  const src = readFileSync(TIME_AUTHORITY_PATH, "utf8");
  const target = "  Object.freeze({\n    field: TIME_FIELD.RESULT_DONE_AT,";
  assertExactlyOneMatch(src, target, "RESULT_DONE_AT row open");
  // Remove the whole second row object literal (from its opening brace to
  // its matching closing "}),\n]);") by cutting the array back down to one
  // element.
  const arrayStart = src.indexOf("export const TIME_AUTHORITY_REGISTRY");
  const arrayEnd = src.indexOf("]);", arrayStart) + "]);".length;
  assert.ok(
    arrayStart > -1 && arrayEnd > arrayStart,
    "registry array literal must be found",
  );
  const firstRowEnd = src.indexOf("  }),\n", arrayStart) + "  }),\n".length;
  const mutatedRegistry =
    `export const TIME_AUTHORITY_REGISTRY = Object.freeze([\n` +
    src.slice(src.indexOf("  Object.freeze({", arrayStart), firstRowEnd) +
    `]);`;
  const mutated =
    src.slice(0, arrayStart) + mutatedRegistry + src.slice(arrayEnd);
  assert.ok(
    !mutated.includes("TIME_FIELD.RESULT_DONE_AT,\n    consumer"),
    "mutant must no longer register a row for RESULT_DONE_AT",
  );

  const { relayHandshakePath } = stageTree({
    checkOverrides: { "time-authority.mjs": mutated },
  });

  withTempDir("hyk186-mut1-fixture-", (dir) => {
    // Ordinary, valid, well-past-dated result -- previously ok:true.
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:00 KST\n",
    );
    const res = runCli(relayHandshakePath, ["coder", dir]);
    assert.notEqual(
      res.exit,
      0,
      "RED: with the registry row removed, checkFutureSkew fail-closes on EVERY DONE (including normal past ones), wrongly rejecting a genuinely valid, non-future result",
    );
    assert.match(res.stderr, /no row for/);
  });
});

// ---------------------------------------------------------------------------
// 변조2 (필수, ★PM 실측 재현 대상): future upper bound removed -> the exact
// PM-measured bug returns (DONE @ 2099-01-01 passes).
// ---------------------------------------------------------------------------
test("mutation 2 (필수, ★PM 실측): DONE-side future-skew check call removed from relay-handshake.mjs -> DONE @ 2099-01-01 passes again -> RED", () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  const doneFuture = checkFutureSkew({\n    candidateDate: doneAt,\n    rawText: doneMatch[1],\n    field: TIME_FIELD.RESULT_DONE_AT,\n    now,\n  });\n  if (doneFuture) return doneFuture;\n";
  assertExactlyOneMatch(src, target, "doneFuture checkFutureSkew call site");
  const mutated = src.replace(target, "");

  const { relayHandshakePath } = stageTree({
    checkOverrides: { "relay-handshake.mjs": mutated },
  });

  withTempDir("hyk186-mut2-fixture-", (dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: FUTURE-1\ndropped_at: 2026-07-31 03:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: FUTURE-1\n\n>>> DONE: CODER @ 2099-01-01 00:00:00 KST\n",
    );
    const res = runCli(relayHandshakePath, ["coder", dir]);
    assert.equal(
      res.exit,
      0,
      "RED: exactly the ★PM 실측(2026-07-31) shape -- with the future check removed, a DONE dated 2099-01-01 passes silently again",
    );
  });
});

// ---------------------------------------------------------------------------
// 변조3 (필수): finalize-done.mjs's caller-supplied-time rejection removed ->
// a caller-chosen timestamp is silently accepted, defeating 완료조건2.
// ---------------------------------------------------------------------------
test("mutation 3 (필수): finalize-done.mjs's callerSuppliedAt rejection removed -> a caller-chosen (backdated) DONE line is accepted -> RED", async () => {
  const src = readFileSync(FINALIZE_DONE_PATH, "utf8");
  const target =
    '  if (callerSuppliedAt !== undefined) {\n    return {\n      ok: false,\n      reasonCode: FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED,\n      reason:\n        "finalize-done rejects caller-supplied timestamps -- this producer always records its own machine clock (Date.now()) at finalization time; do not pass callerSuppliedAt",\n    };\n  }\n';
  assertExactlyOneMatch(src, target, "callerSuppliedAt rejection guard");
  const mutated = src.replace(target, "");

  const { finalizeDonePath } = stageTree({
    relayOverrides: { "finalize-done.mjs": mutated },
  });

  const dir = tmpDir("hyk186-mut3-fixture-");
  try {
    writeResult(dir, "coder", "task_id: HYK-1\n\nbody\n");
    // Import the mutant module directly (in-process) so we can pass a
    // callerSuppliedAt argument -- the CLI itself never exposes one, this
    // probes the exported function's own contract, which is what the real
    // production caller (a future finalize-done consumer) would call.
    const mod = await import(`file://${finalizeDonePath.replace(/\\/g, "/")}`);
    const result = mod.finalizeDone({
      role: "coder",
      harnessDir: dir,
      callerSuppliedAt: "2020-01-01 00:00 KST",
    });
    assert.equal(
      result.ok,
      true,
      "RED: with the guard removed, a caller-supplied timestamp argument is silently accepted instead of refused",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 변조4 (필수): stale-DONE reuse guard removed -> a DONE predating the drop
// (완료조건3의 뿌리 -- 과거 결과 재사용) passes.
// ---------------------------------------------------------------------------
test("mutation 4 (필수): stale-result (doneAt < droppedAt) guard removed from relay-handshake.mjs -> a DONE predating the drop passes -> RED", () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  if (doneAt < droppedAt) {\n    return {\n      ok: false,\n      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,\n    };\n  }\n\n";
  assertExactlyOneMatch(src, target, "stale-result doneAt < droppedAt guard");
  const mutated = src.replace(target, "");

  const { relayHandshakePath } = stageTree({
    checkOverrides: { "relay-handshake.mjs": mutated },
  });

  withTempDir("hyk186-mut4-fixture-", (dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 05:00:00 KST\n",
    );
    const res = runCli(relayHandshakePath, ["coder", dir]);
    assert.equal(
      res.exit,
      0,
      "RED: with the guard removed, an old DONE from BEFORE this drop (a stale/reused result) is wrongly accepted as fresh completion",
    );
  });
});

// ---------------------------------------------------------------------------
// 변조5 (필수): watch-result.mjs's future-state wiring removed -> a
// future-rejected result falls through to UNJUDGABLE instead of its own
// distinct status/exit (§3 "새 사유를 결선하지 않으면 UNJUDGABLE로만
// 끝난다").
// ---------------------------------------------------------------------------
test("mutation 5 (필수): watch-result.mjs's isFutureRejectedState wiring removed -> a future-dated DONE falls to WATCH_UNJUDGABLE instead of WATCH_FUTURE_REJECTED -> RED", () => {
  const src = readFileSync(WATCH_RESULT_PATH, "utf8");
  const target =
    '  // HYK-186: checked before the blocked-family/reason-string classification\n  // below -- a future-rejected state is a stronger, structured signal (an\n  // authority-clock verdict on a parsed timestamp) than either the worker-\n  // signaled blocked family or the plain reason-string patterns, and must\n  // report its own distinct status/exit rather than being folded into either.\n  if (isFutureRejectedState(result.state)) {\n    return {\n      status: "future_rejected",\n      state: result.state,\n      reason: `WATCH_FUTURE_REJECTED: ${result.state}: ${result.reason}`,\n      elapsedS,\n    };\n  }\n';
  assertExactlyOneMatch(src, target, "isFutureRejectedState wiring block");
  const mutated = src.replace(target, "");

  const { watchResultPath } = stageTree({
    relayOverrides: { "watch-result.mjs": mutated },
  });

  withTempDir("hyk186-mut5-fixture-", (dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2099-01-01 00:00 KST\n",
    );
    const res = runCli(watchResultPath, [
      "--role",
      "coder",
      "--harness-dir",
      dir,
      "--max-wait-s",
      "1",
    ]);
    assert.equal(
      res.exit,
      5, // EXIT_UNJUDGABLE
      "RED: without the wiring, a future-rejected state's reason text doesn't match any classifyWatchFailure pattern either, so it falls to the catch-all unjudgable bucket (exit 5) instead of the dedicated future_rejected exit (7)",
    );
    assert.match(res.stderr, /WATCH_UNJUDGABLE/);
  });
});
