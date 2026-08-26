// HYK-359 §C 완료조건4: locks in "a floating ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH left set in the invoking shell
// produces the SAME result as running with those vars unset" as an
// automated, fail-red-on-regression check -- not a one-time human
// confirmation (coder-task.md §C-1: "사람이 한 번 확인하고 됐다로 닫지
// 마라 -- 어긋나면 빨간불이 켜져야 한다").
//
// HYK-359 2R P1-1 (검토자 실사고, 원문 coder-task.md §2): 1R hand-maintained
// an `ISOLATED_FILES` array naming the nine protected files. The reviewer
// deleted a file's array entry AND that file's own helper import/call in
// the SAME commit (a temp clone, `reject-streak-auto-record.test.mjs`) and
// re-ran this test directly -- it stayed green (`ℹ tests 1 / ℹ pass 1 /
// ℹ fail 0`) because the loop simply never looked at the now-unlisted file
// again. A hand-maintained "protected files" list is not a safety net if it
// can be deleted in the same commit as the protection it names.
//
// Fix (ORCH's own hint, coder-task.md §2 P1-1): stop naming files by hand.
// Enumerate the CI-canonical test directories at RUN TIME (the same
// TEST_DIRS/collectTestFiles isolated-suite-runner.mjs uses for the actual
// CI-canonical command) and sweep every `.test.mjs` file found there under
// a floating ambient value, requiring zero failures. A file's own isolation
// fix can no longer be deleted "silently" -- as long as the .test.mjs file
// itself still exists on disk (which it did in the reviewer's repro), this
// sweep discovers it every time regardless of any list, and it goes red the
// moment its protection is missing. The only files this test does NOT
// require to pass are in EXCEPTIONS below, and removing an entry from that
// list only ever makes this test STRICTER (never weaker) -- so EXCEPTIONS
// itself cannot suffer the same "delete the guard and the guarded code
// together" failure mode P1-1 found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestFiles } from "./isolated-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE_BASENAME = basename(fileURLToPath(import.meta.url));

// The ONLY file this round leaves deliberately unprotected --
// selfcheck-smoke.test.mjs is sensitive to a *valid, existing* ledger path
// specifically (not to a floating var's mere presence), a different bug
// with a different fix, out of this round's scope (coder-task.md §5
// "⛔selfcheck-smoke 손대기 0(별건)"). Shrinking this list (removing an
// entry) only makes the sweep below stricter -- never a way to hide a
// regression.
const EXCEPTIONS = new Set(["selfcheck-smoke.test.mjs"]);

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: HERE,
    encoding: "utf8",
  }).trim();
}

test("HYK-359 완료조건4 (2R): CI-canonical 시험 디렉토리 전체(예외 목록 제외)가 떠도는 ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH 아래에서도 fail 0 -- 보호 대상이 목록 없이 디스크에서 직접 발견된다", () => {
  const root = repoRoot();
  const allFiles = collectTestFiles(root); // relative paths, e.g. "scripts/check/foo.test.mjs"
  const swept = allFiles.filter((relPath) => {
    const name = basename(relPath);
    return name !== THIS_FILE_BASENAME && !EXCEPTIONS.has(name);
  });
  // Sanity floor -- if directory enumeration itself silently returned
  // almost nothing (wrong cwd, moved directories, a readdir bug), this
  // must be loud, not a vacuous "0 files swept -> trivially fail 0" pass.
  assert.ok(
    swept.length > 200,
    `expected a large CI-canonical file set, got only ${swept.length} -- directory enumeration likely broken, not a real green`,
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk359-ambient-regression-"));
  try {
    // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (set by `node --test` on THIS
    // process, since this file is itself a test) must NOT leak into the
    // spawned child below -- inherited, it makes the child's own
    // `node --test` detect "recursive test run" and silently skip running
    // any tests at all (exit 0 with zero tests executed), which would make
    // this assertion pass vacuously regardless of whether the swept files
    // are actually isolated. 실사고(1R): this exact bug hid a genuine RED
    // for a full debugging pass before being caught.
    const parentEnvWithoutTestMarkers = { ...process.env };
    delete parentEnvWithoutTestMarkers.NODE_TEST_CONTEXT;
    delete parentEnvWithoutTestMarkers.NODE_TEST_WORKER_ID;
    const floatingEnv = {
      ...parentEnvWithoutTestMarkers,
      ADMISSION_LEDGER_PATH: join(dir, "floating-ledger.json"),
      ADMISSION_LOCK_PATH: join(dir, "floating-ledger.lock"),
      DISPATCH_RECEIPT_PATH: join(dir, "floating-dispatch-receipt.json"),
    };
    // Relative paths + cwd:root, not absolute paths -- 286 absolute paths
    // (~37.5KB of argv) trip Windows's ~32KB CreateProcess command-line
    // limit (ENAMETOOLONG, 실측). Relative paths cut every entry by
    // `root.length` bytes, comfortably inside the limit.
    const res = spawnSync(process.execPath, ["--test", ...swept], {
      cwd: root,
      encoding: "utf8",
      env: floatingEnv,
    });
    const testsRun = Number(
      (res.stdout ?? "").match(/^ℹ tests (\d+)/m)?.[1] ?? 0,
    );
    const failCount = Number(
      (res.stdout ?? "").match(/^ℹ fail (\d+)/m)?.[1] ?? -1,
    );
    // Same defense as 1R's per-file version: a child that silently ran
    // zero tests still exits 0 -- require a real, sizable count, not just
    // exit 0.
    assert.ok(
      testsRun > 200,
      `child ran only ${testsRun} tests -- looks like a silent skip (exit=${res.status}), not a real sweep. stderr tail: ${(res.stderr ?? "").slice(-2000)}`,
    );
    assert.equal(
      failCount,
      0,
      `${failCount} test(s) failed under a floating ambient ledger env across the swept CI-canonical set -- isolation regressed. stdout tail: ${(res.stdout ?? "").slice(-4000)}\nstderr tail: ${(res.stderr ?? "").slice(-2000)}`,
    );
    assert.equal(
      res.status,
      0,
      `child exited ${res.status} even though the parsed summary showed fail 0 -- unexpected, investigate. stderr tail: ${(res.stderr ?? "").slice(-2000)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
