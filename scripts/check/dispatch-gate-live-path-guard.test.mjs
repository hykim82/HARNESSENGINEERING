// HYK-257-done-stamp-3 §2 범위2 -- fail-loud proof that
// bestEffortStampDroppedAt (dispatch-gate-decision.mjs) refuses to run
// against a path judged to be a LIVE file inside this repo's OWN worktree,
// exactly the shape of the 2R incident (검토자 실측: 검증 중
// `.harness/review-task.md`의 dropped_at이 12:41 -> 12:50으로 4회
// 바뀌었다).
//
// HYK-394 (3R 수리, 이 라운드): 옛 버전의 두 시험은 실제 CLI를
// `execFileSync`로 spawn하면서 taskPath를 "이 저장소 자신의 진짜
// `.harness/`" 안에 두었다 -- guardAgainstLiveTaskPathStamp의 판정①②가
// "taskPath의 저장소 == 이 CLI 소스 파일 자신이 속한 저장소"인지만
// 보므로, ⓑ 시험(정확한 --expect-repo-root 동반)은 그 판정을 «정직하게»
// 통과해 실제로 `bestEffortStampDroppedAt`이 라이브 `.harness/`에
// `writeFileSync`(dropped_at 재스탬프)와 `archiveRoundTaskFileIfNew`
// (rounds/ 아래 새 보존 사본 생성)를 그대로 실행했다 -- ⛔`--ledger`는
// reject-streak 원장만 격리했을 뿐 `.harness/` 디렉터리 자체는 격리하지
// 않았다(HYK-394 coder-task.md §1 원문). 이 파일을 포함한 전체 러너를
// 돌릴 때마다 라이브 `.harness/`에 실제 파일이 새로 생겼다(직접 재현:
// `.harness/zzz-hyk257-3r-guard-probe-prod-shape-task.md` +
// `.harness/rounds/zzz-hyk257-3r-guard-probe-prod-shape-task-r1.md`).
//
// 수리: 두 시험 모두 이제 "자기 소유의 임시 git 저장소"를 만들고, 그
// 저장소 «안에» dispatch-gate-decision.mjs(및 그 상대 경로 의존 모듈
// 전체)의 사본을 둔 뒤 그 사본을 spawn한다(buildIsolatedCliRepo 아래).
// `guardAgainstLiveTaskPathStamp`의 `self`는 스크립트 자신의
// `import.meta.url` 위치에서 구해지므로(dispatch-gate-decision.mjs의
// `selfRepoRoot` 참조), 사본을 spawn하면 `self`도 이 임시 저장소가 되고
// taskPath도 같은 임시 저장소 안에 있다 -- ①②(같은 저장소 family)가
// 여전히 "예"로 성립하고, ③(--expect-repo-root 유무/일치)만 원래 시험이
// 겨누던 축 그대로 갈린다. 즉 ⓐ«가드가 실물 경로를 거부한다»/ⓑ«프로덕션과
// 똑같은 모양의 호출은 여전히 동작한다» 두 증명 모두 "진짜 git 저장소·
// 진짜 파일"로 그대로 남고, "라이브 저장소여야 한다"는 부분만 바뀐다
// (HYK-394 §2 P2 요구사항 원문 그대로).
//
// This uses a REAL, non-mocked invocation against a path genuinely inside
// a REAL git repo (not this repo's own live worktree any more, see above --
// a fresh throwaway repo built per-test) -- still not a plain mkdtemp/`git
// init` fixture like the rest of dispatch-gate-decision.test.mjs (those
// deliberately use UNRELATED git repos, which this guard is designed to
// leave alone, see dispatch-gate-decision.mjs's own
// guardAgainstLiveTaskPathStamp header for why). This throwaway repo is
// instead engineered to BE "this repo family" from the guard's point of
// view (same mechanism, isolated instance) without ever touching the real
// checked-out worktree.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";
// HYK-404-race-1: repoRootFromHere/fingerprintDir moved to this shared,
// non-test module so dispatch-gate-live-path-guard-concurrent-race.test.mjs
// can drive the exact real fingerprinting logic without importing a
// `*.test.mjs` file's top-level `test(...)` registrations into its own
// process (node's test runner isolates each test file into its own child
// process by default; importing another test file's module would silently
// re-register and re-run that file's tests a second time).
import {
  repoRootFromHere,
  fingerprintDir,
} from "./live-harness-fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let liveHarnessDir;
let fingerprintBefore;

before(() => {
  liveHarnessDir = join(repoRootFromHere(), ".harness");
  fingerprintBefore = fingerprintDir(liveHarnessDir);
});

after(() => {
  const fingerprintAfter = fingerprintDir(liveHarnessDir);
  assert.equal(
    fingerprintAfter,
    fingerprintBefore,
    "HYK-394 P1: running this test file must not change a single byte under the LIVE .harness/ of this checked-out worktree (file list + per-file sha256 must match exactly before and after) -- if this fails, some test in this file regressed back to touching the live worktree instead of an isolated throwaway repo",
  );
});

// HYK-394 §2 P2: builds a fresh throwaway git repo and copies every
// non-test `.mjs` module from THIS directory (scripts/check) into it, so
// the copy is self-sufficient (dispatch-gate-decision.mjs's relative
// imports -- ./envelope-archive.mjs, ./reject-streak.mjs, etc. -- all
// resolve inside the copy, never reaching back into the real worktree).
// Spawning the COPY (not the original CLI file) means
// guardAgainstLiveTaskPathStamp's `self` (derived from the running script's
// own `import.meta.url`) resolves to THIS throwaway repo, not the real
// checked-out worktree -- exactly what lets both proofs below run against
// "a real git repo, real files" without the live worktree ever being that
// repo.
function buildIsolatedCliRepo() {
  const root = mkdtempSync(join(tmpdir(), "hyk394-guard-isolated-repo-"));
  // HYK-394: dispatch-gate-decision.mjs's own `invokedDirectly` self-check
  // (bottom of that file) hardcodes the suffix `scripts/check/dispatch-
  // gate-decision.mjs` -- a flat copy (e.g. `<root>/check/...`) fails that
  // suffix match, the CLI silently no-ops (loads, defines everything, exits
  // 0 with zero output), and NEITHER proof below would actually exercise
  // the guard at all (found the hard way: a first attempt using a flat
  // `check/` dir passed vacuously). Mirror the exact `scripts/check/`
  // path so the copy is indistinguishable from a real checkout to that
  // self-check.
  const checkDir = join(root, "scripts", "check");
  mkdirSync(checkDir, { recursive: true });
  for (const name of readdirSync(HERE)) {
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) {
      copyFileSync(join(HERE, name), join(checkDir, name));
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    ["commit", "-q", "-m", "isolated dispatch-gate-decision copy"],
    {
      cwd: root,
    },
  );
  return { root, cli: join(checkDir, "dispatch-gate-decision.mjs") };
}

test("HYK-257-done-stamp-3 §2 범위2: 실물 .harness/*-task.md와 같은 «자기 저장소 안의» 경로를 겨눈 호출은 --expect-repo-root 없이 실패한다 (fail-loud, 파일 무접촉)", () => {
  const { root, cli } = buildIsolatedCliRepo();
  try {
    const harnessDir = join(root, ".harness");
    mkdirSync(harnessDir, { recursive: true });

    // Throwaway probe fixture, clearly namespaced so no live role file name
    // (coder-task.md/review-task.md/verify-task.md/pm-task.md) is ever
    // touched -- and, as of HYK-394, entirely inside the isolated repo
    // built above, never the real checked-out worktree.
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
        const stdout = execFileSync("node", [cli, probePath], {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HYK-257-done-stamp-3 §2 범위2: 같은 «자기 저장소 안의» 경로라도 실제 배달과 동일하게 정확히 일치하는 --expect-repo-root를 받으면 여전히 동작한다 (프로덕션 동작 유지)", () => {
  const { root, cli } = buildIsolatedCliRepo();
  try {
    const harnessDir = join(root, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    const probePath = join(
      harnessDir,
      "zzz-hyk257-3r-guard-probe-prod-shape-task.md",
    );
    const originalContent = `task_id: HYK-9999-guard-probe-2\ndropped_at: 2026-01-01 00:00 KST\n\nprobe body (production-shaped call).\n`;
    writeFileSync(probePath, originalContent, "utf8");

    // Isolated ledger (NOT any real reject-streak.json) -- explicit
    // --ledger keeps the rest of this CLI's gate evaluation (which runs
    // AFTER the guard/stamp step) from ever touching a shared ledger,
    // exactly the isolation discipline every other fixture-based test in
    // this suite already follows.
    const isolatedLedgerDir = mkdtempSync(
      join(tmpdir(), "hyk257-3r-guard-prod-shape-ledger-"),
    );
    const ledgerPath = join(isolatedLedgerDir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    // Mirrors dispatch-worker.ps1:171's SHAPE (--expect-repo-root pointing
    // at the SAME repo the running CLI copy lives in, the one shape real
    // production always and only produces) plus an explicit --ledger
    // override. This call must NOT be refused -- otherwise real dispatch
    // itself would break (프로덕션 동작 유지 요건).
    // Wrapped in try/catch, not asserted on exit code -- this test's only
    // claim is "the stamp step itself still runs in a production-shaped
    // call" (프로덕션 동작 유지), independent of whatever the REST of the
    // gate decides for unrelated reasons.
    let stdout;
    try {
      stdout = execFileSync(
        "node",
        [cli, probePath, "--expect-repo-root", root, "--ledger", ledgerPath],
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
