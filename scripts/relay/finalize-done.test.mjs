// HYK-186 완료조건2: finalize-done.mjs is the one supported machine-clock
// producer for a result file's '>>> DONE:' line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { finalizeDone, FINALIZE_DONE_REASON } from "./finalize-done.mjs";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "finalize-done.mjs",
);
// HYK-324/HYK-325 r2 §3 시험5: the sibling production CLI entry point
// (relay-handshake.mjs), spawned as its own child process -- not imported --
// same reasoning as CLI_PATH above (완료조건7, engine independence).
const HANDSHAKE_CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "check",
  "relay-handshake.mjs",
);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "finalize-done-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
  });
  assert.equal(res.error, undefined);
  assert.notEqual(res.status, null);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("finalizeDone: callerSuppliedAt !== undefined is refused, regardless of value", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    for (const badValue of [
      "2020-01-01 00:00 KST",
      0,
      new Date(),
      null,
      false,
    ]) {
      const result = finalizeDone({
        role: "coder",
        harnessDir: dir,
        callerSuppliedAt: badValue,
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.reasonCode,
        FINALIZE_DONE_REASON.CALLER_SUPPLIED_TIME_REJECTED,
      );
    }
  });
});

test("finalizeDone: normal call (no callerSuppliedAt) writes a DONE line stamped with the injected machine clock", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const fixedMs = Date.parse("2026-08-09T05:00:00Z"); // 2026-08-09 14:00 KST
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => fixedMs,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.FINALIZED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(content, />>> DONE: CODER @ 2026-08-09 14:00:00 KST/);
  });
});

test("finalizeDone: already has a DONE line -> refuses, never overwrites", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-01 00:00:00 KST\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.ALREADY_FINALIZED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /2026-08-01 00:00:00 KST/,
      "original line must survive untouched",
    );
  });
});

test("finalizeDone: result file missing -> refuses with a distinct reason", () => {
  withDir((dir) => {
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.RESULT_FILE_NOT_FOUND);
  });
});

// HYK-332 §3 시험1: task_id: missing -> DONE is not stamped, reasonCode
// names exactly what's missing, no '>>> DONE:' line is written.
test("finalizeDone: task_id: header missing -> refuses, no DONE stamped", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "no header here\n\nbody\n", "utf8");
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      FINALIZE_DONE_REASON.HEADER_TASK_ID_MISSING,
    );
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

test("finalizeDone: task_id: header ambiguous (2+ standalone lines) -> refuses", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\ntask_id: HYK-2\n\nbody\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      FINALIZE_DONE_REASON.HEADER_TASK_ID_AMBIGUOUS,
    );
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

// HYK-332 §3 시험2: REVIEW-family result file missing 'for:' -> refused the
// same way, even though its 'task_id:' header is present and well-formed.
test("finalizeDone: REVIEW-family result missing 'for:' header -> refuses, no DONE stamped", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "review.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const result = finalizeDone({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.HEADER_FOR_MISSING);
    const content = readFileSync(join(dir, "review.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

test("finalizeDone: REVIEW-family result with 2+ 'for:' lines -> refuses ambiguous", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "review.md"),
      "task_id: HYK-1\nfor: HYK-1-coder-1\nfor: HYK-1-coder-2\n\nbody\n",
      "utf8",
    );
    const result = finalizeDone({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.HEADER_FOR_AMBIGUOUS);
  });
});

// HYK-332 §3 시험3: regression -- a well-formed REVIEW result (task_id: +
// for: both present, exactly once each) still gets DONE stamped normally.
test("finalizeDone: REVIEW-family result with well-formed task_id: + for: -> still finalizes normally", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "review.md"),
      "task_id: HYK-1\nfor: HYK-1-coder-1\n\nbody\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "review",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-09T05:00:00Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.FINALIZED);
    const content = readFileSync(join(dir, "review.md"), "utf8");
    assert.match(content, />>> DONE: REVIEW @ 2026-08-09 14:00:00 KST/);
  });
});

// HYK-332 §3 시험4 (프로덕션 진입점 -- CLI): the same gate fires through the
// CLI path, not just the exported function.
test("CLI: task_id: header missing -> non-zero exit, reason names what's missing, no DONE stamped", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "no header here\n\nbody\n", "utf8");
    const res = runCli(["coder", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing task_id echo/);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(content, />>> DONE/);
  });
});

test("CLI (non-Claude engine path, 완료조건7): plain `node finalize-done.mjs <role> <dir>` writes a machine-stamped DONE line", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0);
    assert.match(res.stdout, /^FINALIZED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      />>> DONE: CODER @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST/,
    );
  });
});

test("finalizeDone: normal FINALIZED write also stamps the finalize-done marker line", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-09T05:00:00Z"),
    });
    assert.equal(result.ok, true);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(content, /^done_stamped_by: finalize-done$/m);
  });
});

// HYK-324/HYK-325 §2-1 · §3 시험3: today's actual malformed text
// (minute-precision, 사고 A의 실제 문면) -> replaced exactly once.
test("finalizeDone: malformed (minute-precision) DONE line -> replaced once, original preserved as superseded_done:", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-19T10:01:11Z"), // 2026-08-19 19:01:11 KST
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_MALFORMED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-08-19 18:56 KST$/m,
      "original malformed line must survive verbatim, non-column-0",
    );
    assert.match(content, /^done_stamped_by: finalize-done$/m);
    // §3 시험5: exactly one '>>> DONE:' cover line survives (parser 계약).
    const doneLineMatches = [...content.matchAll(/^>>>\s*DONE:/gim)];
    assert.equal(doneLineMatches.length, 1);
    assert.match(
      content,
      />>> DONE: CODER @ 2026-08-19 19:01:11 KST/,
      "replacement must carry the machine clock, not any caller value",
    );
  });
});

// HYK-324/HYK-325 r2 §3 시험1 (검토 반려 P1 수리, 검토자가 쓴 입력 그대로):
// a DONE line that HAS seconds-shaped text but is NOT actually parseable
// (out-of-range month/day) -- r1's malformedSingle only checked
// hasDoneSecondsPrecision (text-shape), never parseability, so this exact
// value fell into neither "malformed, replace" nor "valid, refuse": it
// slipped through as ALREADY_FINALIZED while relay-handshake.mjs called it
// "not parseable" and told the caller it could be replaced. r2 reuses
// relay-handshake's own isWellFormedDoneTimestamp (파싱 가능 + 초 단위) so
// both sides agree this value is malformed and eligible for the one-time
// replace.
test("finalizeDone: 검토자 실측 입력 (seconds-shaped but unparseable, e.g. month=99) -> replaced once, not ALREADY_FINALIZED", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-99-99 23:19:01 KST\n",
      "utf8",
    );
    const result = finalizeDone({
      role: "coder",
      harnessDir: dir,
      nowFn: () => Date.parse("2026-08-19T10:01:11Z"), // 2026-08-19 19:01:11 KST
    });
    assert.equal(result.ok, true);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.REPLACED_MALFORMED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-99-99 23:19:01 KST$/m,
      "original unparseable line must survive verbatim, non-column-0",
    );
    assert.match(
      content,
      />>> DONE: CODER @ 2026-08-19 19:01:11 KST/,
      "replacement must carry the machine clock, not any caller value",
    );
  });
});

// HYK-324/HYK-325 §3 시험4: already-replaced file -> refuses a 2nd replace.
test("finalizeDone: already-replaced file (superseded_done: present) -> ALREADY_REPLACED, refuses a second replace", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\nsuperseded_done: >>> DONE: CODER @ 2026-08-19 18:56 KST\n>>> DONE: CODER @ 2026-08-19 19:01:11 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const result = finalizeDone({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, FINALIZE_DONE_REASON.ALREADY_REPLACED);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      />>> DONE: CODER @ 2026-08-19 19:01:11 KST/,
      "already-replaced line must survive untouched",
    );
  });
});

test("CLI: malformed DONE line -> REPLACED_MALFORMED on stdout, replacement stamped on disk", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n",
      "utf8",
    );
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0);
    assert.match(res.stdout, /^REPLACED_MALFORMED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-08-19 18:56 KST$/m,
    );
  });
});

test("CLI: --at (or any --at=... form) is refused on sight, before any file is touched", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "coder.md"), "task_id: HYK-1\n\nbody\n", "utf8");
    const res = runCli(["coder", dir, "--at", "2020-01-01 00:00 KST"]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /rejects caller-supplied timestamps/);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.doesNotMatch(
      content,
      />>> DONE/,
      "no DONE line should have been written",
    );

    const res2 = runCli(["coder", dir, "--at=2020-01-01 00:00 KST"]);
    assert.notEqual(res2.exit, 0);
    assert.match(res2.stderr, /rejects caller-supplied timestamps/);
  });
});

// HYK-324/HYK-325 r2 §3 시험5 (검토 반려 P1 수리, production-entry-point):
// both CLIs run as REAL child processes (not the exported functions) against
// the SAME fixture directory, chained exactly as an operator would run them
// -- (1) relay-handshake.mjs sees the malformed stamp, skips first
// observation, and its stderr tells the caller "finalize-done 으로 1회
// 교체할 수 있다"; (2) finalize-done.mjs, run next against that same
// directory, actually performs that promised one-time replace. r1 only
// fixed the exported-function path (finalizeDone) and the unit-level
// malformedSingle check -- this locks the full CLI-to-CLI flow the review
// found broken, not just the library call.
function runHandshakeCli(args) {
  const res = spawnSync(process.execPath, [HANDSHAKE_CLI_PATH, ...args], {
    encoding: "utf8",
  });
  assert.equal(res.error, undefined);
  assert.notEqual(res.status, null);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("production entry point (검토자 실측 입력): relay-handshake CLI announces the 1회 교체 recovery path, finalize-done CLI actually performs it", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-1\ndropped_at: 2026-08-19 05:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-1\n\nbody\n\n>>> DONE: CODER @ 2026-99-99 23:19:01 KST\n",
      "utf8",
    );

    const handshake = runHandshakeCli(["CODER", dir]);
    assert.notEqual(handshake.exit, 0, "malformed DONE must not be consumed");
    assert.match(handshake.stderr, /not parseable/);
    assert.match(handshake.stderr, /finalize-done 으로 1회 교체할 수 있다/);

    const finalize = runCli(["coder", dir]);
    assert.equal(finalize.exit, 0);
    assert.match(finalize.stdout, /^REPLACED_MALFORMED: >>> DONE: CODER @ /);
    const content = readFileSync(join(dir, "coder.md"), "utf8");
    assert.match(
      content,
      /^superseded_done: >>> DONE: CODER @ 2026-99-99 23:19:01 KST$/m,
    );
  });
});
