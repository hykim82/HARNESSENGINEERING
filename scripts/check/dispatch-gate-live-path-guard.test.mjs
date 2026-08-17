// HYK-257-done-stamp-3 §2 범위2 -- fail-loud proof that
// bestEffortStampDroppedAt (dispatch-gate-decision.mjs) refuses to run
// against a path judged to be a LIVE file inside this repo's OWN worktree,
// exactly the shape of the 2R incident (검토자 실측: 검증 중
// `.harness/review-task.md`의 dropped_at이 12:41 -> 12:50으로 4회
// 바뀌었다).
//
// This uses a REAL, non-mocked invocation against a path genuinely inside
// THIS checked-out repo's own `.harness/` directory (not a throwaway
// mkdtemp/`git init` fixture like the rest of dispatch-gate-decision.test.mjs
// -- those deliberately use UNRELATED git repos, which this guard is
// designed to leave alone, see dispatch-gate-decision.mjs's own
// guardAgainstLiveTaskPathStamp header for why). §5 forbids deleting files,
// so the probe fixture file created here (a throwaway, clearly-named file
// that no live consumption path ever reads -- see
// relay-handshake.mjs:resolveLiveRoundFilePaths, which only ever builds
// `<role>-task.md`/`<role>.md` for the fixed role allowlist) is left in
// place; listed in the round's report, never cleaned up.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  statSync,
  mkdtempSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "dispatch-gate-decision.mjs");

function repoRootFromHere() {
  return execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

test("HYK-257-done-stamp-3 §2 범위2: 실물 .harness/*-task.md(이 저장소 자신의 워크트리)를 겨눈 호출은 --expect-repo-root 없이 실패한다 (fail-loud, 파일 무접촉)", () => {
  const root = repoRootFromHere();
  const harnessDir = join(root, ".harness");
  // HYK-257-done-stamp-ci-fix-1: `.harness/` is gitignored (repo root
  // `.gitignore` line 1) -- a fresh `git clone` of committed HEAD (exactly
  // what CI's canonical isolated-suite-runner.mjs runs against) never
  // materializes it, so the OLD `assert.ok(existsSync(harnessDir), ...)`
  // sanity check here failed 100% of the time in that environment (CI PR
  // #167 run 31997660969, reproduced locally byte-for-byte). This is not a
  // production defect -- guardAgainstLiveTaskPathStamp only cares whether
  // taskPath's git repo matches dispatch-gate-decision.mjs's own repo
  // (scripts/check/dispatch-gate-decision.mjs's own header), never whether
  // a directory happens to be named `.harness`. Creating the directory
  // here (idempotent, recursive -- a harmless no-op in the live worktree
  // where it already exists) fixes the test's own broken environmental
  // assumption without touching production code or weakening either
  // assertion below: the guard-fires / production-still-stamps checks
  // still run for real, on a real file, in a real git repo, in BOTH
  // environments.
  mkdirSync(harnessDir, { recursive: true });

  // Throwaway probe fixture, clearly namespaced so no live role file name
  // (coder-task.md/review-task.md/verify-task.md/pm-task.md) is ever
  // touched. Left in place afterward (§5: no delete commands).
  const probePath = join(harnessDir, "zzz-hyk257-3r-guard-probe-task.md");
  const originalContent = `task_id: zzz-guard-probe\ndropped_at: 2026-01-01 00:00 KST\n\nprobe body -- never consumed by any real relay path (filename not in the role allowlist).\n`;
  writeFileSync(probePath, originalContent, "utf8");
  const statBefore = statSync(probePath);

  // No --expect-repo-root at all -- the simplest, most natural shape a
  // human/agent running an ad hoc "let's see it work" verification command
  // would type (exactly the incident's likely shape). Real production
  // (dispatch-worker.ps1:171) ALWAYS passes --expect-repo-root.
  const result = (() => {
    try {
      const stdout = execFileSync("node", [CLI, probePath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { crashed: false, exitCode: 0, stdout, stderr: "" };
    } catch (err) {
      return {
        crashed: true,
        exitCode: err.status ?? null,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err.message ?? ""),
      };
    }
  })();

  console.log(
    "GUARD PROBE result:",
    JSON.stringify(result, null, 2).slice(0, 2000),
  );

  assert.equal(
    result.crashed,
    true,
    "the CLI must exit non-zero (thrown, uncaught LiveTaskPathStampRefusedError) when a live-repo-family taskPath is targeted without a validated --expect-repo-root",
  );
  assert.match(
    result.stderr,
    /LiveTaskPathStampRefusedError|REFUSING to run bestEffortStampDroppedAt/,
  );

  // The decisive proof: the guard fired BEFORE any fs access on taskPath --
  // the probe file's content and mtime must be COMPLETELY unchanged (this
  // is what "시험이 실물 경로를 만지면 그 시험이 시끄럽게 실패" cashes out
  // to mechanically -- not just "an error was printed" but "the write
  // never happened").
  const afterContent = readFileSync(probePath, "utf8");
  assert.equal(
    afterContent,
    originalContent,
    "the live-path guard must fire BEFORE any read/write -- content must be byte-identical",
  );
  const statAfter = statSync(probePath);
  assert.equal(
    statAfter.mtimeMs,
    statBefore.mtimeMs,
    "the live-path guard must fire before any write -- mtime must be unchanged",
  );
});

test("HYK-257-done-stamp-3 §2 범위2: 같은 실물 경로라도 실제 배달과 동일하게 정확히 일치하는 --expect-repo-root를 받으면 여전히 동작한다 (프로덕션 동작 유지)", () => {
  const root = repoRootFromHere();
  const harnessDir = join(root, ".harness");
  // HYK-257-done-stamp-ci-fix-1: same reason as the first test above --
  // `.harness/` does not exist in a fresh isolated clone (gitignored),
  // which previously made the writeFileSync below throw ENOENT before this
  // test's own assertions ever ran. Idempotent, harmless in the live
  // worktree.
  mkdirSync(harnessDir, { recursive: true });
  const probePath = join(
    harnessDir,
    "zzz-hyk257-3r-guard-probe-prod-shape-task.md",
  );
  const originalContent = `task_id: HYK-9999-guard-probe-2\ndropped_at: 2026-01-01 00:00 KST\n\nprobe body (production-shaped call).\n`;
  writeFileSync(probePath, originalContent, "utf8");

  // Isolated ledger (NOT this repo's own real .harness/reject-streak.json)
  // -- explicit --ledger keeps the rest of this CLI's gate evaluation
  // (which runs AFTER the guard/stamp step) from ever touching the real
  // reject-streak ledger, exactly the isolation discipline every other
  // fixture-based test in this suite already follows.
  const isolatedLedgerDir = mkdtempSync(
    join(tmpdir(), "hyk257-3r-guard-prod-shape-ledger-"),
  );
  const ledgerPath = join(isolatedLedgerDir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });

  // Mirrors dispatch-worker.ps1:171 EXACTLY (--expect-repo-root pointing at
  // this same worktree's own root, the one shape real production always
  // and only produces) plus an explicit --ledger override so the gate
  // evaluation that runs after the stamp step never reaches the real
  // ledger. This call must NOT be refused -- otherwise real dispatch
  // itself would break (프로덕션 동작 유지 요건).
  // Wrapped in try/catch, not asserted on exit code -- this test's only
  // claim is "the stamp step itself still runs in a production-shaped
  // call" (프로덕션 동작 유지), independent of whatever the REST of the
  // gate decides for unrelated reasons.
  let stdout;
  try {
    stdout = execFileSync(
      "node",
      [CLI, probePath, "--expect-repo-root", root, "--ledger", ledgerPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    stdout = err.stdout ?? "";
  }
  console.log(
    "PRODUCTION-SHAPE probe stdout (truncated):",
    stdout.slice(0, 500),
  );

  const afterContent = readFileSync(probePath, "utf8");
  assert.match(
    afterContent,
    /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/m,
    "production-shaped call must still machine-stamp dropped_at (this round must not kill 2R's real anchor wiring)",
  );
  assert.notEqual(
    afterContent,
    originalContent,
    "the dropped_at line must actually have been rewritten to a fresh machine value",
  );
});
