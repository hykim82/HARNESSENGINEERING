// HYK-418 §2: promotes relay-handshake.mjs's finalize-done marker check
// from a console-only warning (HYK-325 §2-3) to a fail-closed rejection,
// and closes the deadlock that promotion alone would create (finalize-done
// used to treat ANY format-valid '>>> DONE:' line as ALREADY_FINALIZED --
// see finalize-done.mjs's REPLACED_UNMARKED reason code, HYK-418 §2-3).
//
// This file locks down exactly the four completion conditions coder-
// task.md §3 names for this round:
//   1. unmarked well-formed DONE -> rejected, reason names the literal
//      recovery command.
//   2. that rejection does NOT record a first-observation entry -- reuses
//      the SAME axis (early return before spawnObserveDoneLine) the
//      malformed/minute-precision checks already use, not a new one.
//   3. finalize-done's one-time REPLACED_UNMARKED recovery actually clears
//      the rejection (round-trip, not just unit-tested in isolation).
//   4. removing the new reject branch (mutation) restores the old
//      accept-everything behavior -- proving this branch is the cause --
//      and the real source file is provably untouched (byte-identical,
//      only ever read in this file).
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
import { checkRelayHandshake } from "./relay-handshake.mjs";
import { findFirstObservation } from "./first-observation.mjs";
// HYK-148 A3 inventory (no-restricted-imports): scripts/check/* must never
// import scripts/relay/* -- real dependency direction is relay -> check
// only. The round-trip (finalize-done CLI actually clearing this
// rejection) is tested from the relay side instead --
// scripts/relay/finalize-done.test.mjs's own HYK-418 §2-3 tests, which
// already spawn BOTH CLIs as child processes (production entry point
// convention, HYK-324/HYK-325 r2 §3 시험5).

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk418-marker-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

test("HYK-418 §2-1: well-formed but UNMARKED DONE line -> rejected, reason names the literal recovery command", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-03 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-03 06:10:00 KST\n",
    );
    // HYK-414 §2-3 (time-judgment-now-injection ratchet): never call
    // checkRelayHandshake with the real Date.now() default -- inject a
    // fixed `now` shortly after the fixture's own DONE value.
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: Date.parse("2026-08-02T21:10:05Z"), // 2026-08-03 06:10:05 KST
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /done_stamped_by: finalize-done.*marker/);
    assert.match(
      result.reason,
      /node scripts\/relay\/finalize-done\.mjs coder/,
      "the rejection must name the exact recovery command, not just say 'run finalize-done'",
    );
  });
});

test("HYK-418 §2-1: marked (finalize-done's own marker line, hand-assembled here since this file must not import scripts/relay/*) well-formed DONE line -> ok:true, marker gate never fires when the marker is present", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-03 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-03 06:10:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: Date.parse("2026-08-02T21:10:05Z"), // 2026-08-03 06:10:05 KST
    });
    assert.equal(result.ok, true);
  });
});

test("HYK-418 §2-2 (완료조건2 -- 첫 관측을 박지 않는다): the unmarked-DONE rejection never records a first-observation entry -- reuses the malformed-DONE-skip axis, not a new one", () => {
  withFixtureDir((dir) => {
    const taskId = "HYK-418-MARKER-1";
    const droppedAt = "2026-08-03 06:00 KST";
    writeTask(dir, "coder", `task_id: ${taskId}\ndropped_at: ${droppedAt}\n`);
    writeResult(
      dir,
      "coder",
      `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-03 06:10:00 KST\n`,
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: Date.parse("2026-08-02T21:10:05Z"), // 2026-08-03 06:10:05 KST
    });
    assert.equal(result.ok, false);

    const observation = findFirstObservation({
      taskId,
      droppedAt,
      role: "coder",
      harnessDir: dir,
    });
    assert.equal(
      observation,
      null,
      "a value this function is about to reject must never be recorded as 'first observed' -- same guarantee HYK-324 §2-2 already gives the malformed/minute-precision checks",
    );
  });
});

// HYK-418 §2-3's round-trip (relay-handshake CLI rejects an unmarked DONE
// -> finalize-done CLI REPLACED_UNMARKED -> relay-handshake CLI now
// accepts the SAME round) is tested from scripts/relay/finalize-done.test.mjs
// instead (see that file's own HYK-418 §2-3 tests) -- this file must not
// import scripts/relay/* (no-restricted-imports, HYK-148 A3 inventory).

// --- 되돌림 변이 (coder-task.md §2⑹): remove the new reject branch from an
// ISOLATED in-memory copy (the real file on disk is only ever read, never
// written -- mirrors relay-handshake-retirement-mutation.test.mjs's own
// house style) and confirm the old accept-everything behavior returns.
// ---------------------------------------------------------------------------

function stageMinimalRelayHandshakeDeps(rootDir) {
  const checkDir = join(rootDir, "scripts", "check");
  mkdirSync(checkDir, { recursive: true });
  for (const name of [
    "time-authority.mjs",
    "reject-streak.mjs",
    "envelope-archive.mjs",
  ]) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  return { checkDir };
}

test("HYK-418 되돌림 변이: removing the marker fail-closed block restores the old accept-unmarked-DONE behavior (RED without the block), and the real source file is byte-identical after (원복 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target = `  if (!DONE_STAMPED_BY_MARKER_RE.test(resultContent)) {
    console.error(
      \`relay-handshake: first-observation skipped: DONE line has no finalize-done marker (likely hand-typed, HYK-325) -- 복구: node scripts/relay/finalize-done.mjs \${role}\`,
    );
    return {
      ok: false,
      reason: \`result '>>> DONE:' line has no 'done_stamped_by: finalize-done' marker -- likely hand-typed (HYK-325), not accepted. Recovery: node scripts/relay/finalize-done.mjs \${role}\`,
    };
  }

`;
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (marker fail-closed block) must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, "");

  const rootDir = mkdtempSync(join(tmpdir(), "hyk418-mut-root-"));
  const harnessDir = mkdtempSync(join(tmpdir(), "hyk418-mut-harness-"));
  try {
    const { checkDir } = stageMinimalRelayHandshakeDeps(rootDir);
    writeFileSync(join(checkDir, "relay-handshake.mjs"), mutated, "utf8");

    writeFileSync(
      join(harnessDir, "coder-task.md"),
      "task_id: HYK-1\ndropped_at: 2026-08-03 06:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "coder.md"),
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-03 06:10:00 KST\n",
      "utf8",
    );

    const mod = await import(
      `file://${join(checkDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = mod.checkRelayHandshake({
      role: "coder",
      harnessDir,
      now: Date.parse("2026-08-02T21:10:05Z"), // 2026-08-03 06:10:05 KST
    });

    assert.equal(
      result.ok,
      true,
      "RED: without the marker fail-closed block, an unmarked hand-typed DONE is accepted again -- proves this block is what rejects it in the unmutated source",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
    const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명 실패: 실제 relay-handshake.mjs가 이 시험 도중 바뀌었다",
    );
  }
});
