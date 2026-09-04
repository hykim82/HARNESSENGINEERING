// HYK-428 1R -- pins the actual mechanism behind the 2026-09-04 12-ghost-
// entry incident (coder-task.md §1/§1-1): HYK-355's own isolation gate
// (`isReviewFamilyRole(role) && !isInsideGitWorktree(harnessDir)`) checks
// harnessDir, but the ledger PATH it guards used to be resolved by
// `mainRepoRoot()` called with NO argument -- a value derived purely from
// this PROCESS's own ambient cwd, completely decoupled from harnessDir.
// hyk355-reject-streak-isolation.test.mjs's own tests never exercise this
// specific divergence: test (a)'s probeDir is not a git repo at all (so the
// HYK-383 head_commit axis rejects the round before ever reaching this
// gate), and test (b) always runs with `cwd === harnessDir's own worktree`
// (so the two values coincide and can never be told apart). This file
// builds the one case those tests skip: harnessDir IS a legitimate,
// isolated git worktree (isInsideGitWorktree passes, head_commit binds) --
// while the calling process's OWN ambient cwd is a second, unrelated
// synthetic repo. Before HYK-428's fix, the ledger entry lands in the CWD
// repo (RED, mutation (c) below reproduces this exactly). After the fix
// (mainRepoRoot(harnessDir) threads harnessDir through instead of ignoring
// it), the entry lands in harnessDir's own repo regardless of cwd (GREEN).
//
// ⛔실제 .harness/reject-streak.json 무접촉 -- 모든 원장은 mkdtemp에 완전히
// 합성된 두 개의 독립 `git init` 저장소 사이에서만 오간다(hyk355 자신의
// 관용구 그대로, 이 파일 안에 독립 복제 -- 그 파일 자신의 헤더가 밝히는
// "무접촉 대상 목록에 없는 파일도 관용구는 복제한다" 관례를 따른다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");

// HYK-428: reads the LIVE working-tree file -- this round's own fix has not
// been committed yet when this file first runs, and mutation test (c) below
// must mutate the code as it actually stands on disk right now (mirrors
// hyk355-reject-streak-isolation.test.mjs's own RELAY_HANDSHAKE_LIVE_SRC).
const RELAY_HANDSHAKE_LIVE_SRC = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
const REJECT_STREAK_SRC = readFileSync(join(HERE, "reject-streak.mjs"), "utf8");
const ENVELOPE_ARCHIVE_SRC = readFileSync(
  join(HERE, "envelope-archive.mjs"),
  "utf8",
);
const TIME_AUTHORITY_SRC = readFileSync(
  join(HERE, "time-authority.mjs"),
  "utf8",
);

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A fully synthetic, independent repo -- `git init` of its own, never a
// worktree of anything else. Used for BOTH the "cwd repo" (A, plays the
// role of "whatever repo the caller's ambient process.cwd() happens to be
// in" -- the real HARNESSENGINEERING checkout in the actual incident) and
// the "harnessDir repo" (B, plays the role of the isolated fixture a
// reviewer's own probe legitimately built with `git init`).
function initPlainGitRepo(dir) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  ]);
}

// HYK-383's head_commit axis (relay-handshake.mjs) requires a REVIEW-family
// round's `head_commit:` header to match the ACTUAL `git rev-parse HEAD` at
// harnessDir -- reused byte-for-byte from hyk355-reject-streak-isolation.
// test.mjs's own writeReviewFixture (independently duplicated per this
// repo's stated "작은 헬퍼는 파일마다 복제한다" convention).
function writeReviewFixture(
  harnessDir,
  { taskId, verdict, droppedAt, doneAt },
) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommitLine = `head_commit: ${git(harnessDir, ["rev-parse", "HEAD"])}\n`;
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n${headCommitLine}`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: ${verdict}\nrole: REVIEW-CODEX\n${headCommitLine}\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function runRelayHandshakeCli(scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
    env: isolatedChildEnv(opts.env),
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

function readLedger(repoDir) {
  const p = join(repoDir, ".harness", "reject-streak.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function writeMutantRelayHandshake(mutatedSrc) {
  const rootDir = tmpDir("hyk428-mutant-");
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const mutantPath = join(scriptsCheckDir, "relay-handshake.mjs");
  writeFileSync(mutantPath, mutatedSrc, "utf8");
  writeFileSync(
    join(scriptsCheckDir, "reject-streak.mjs"),
    REJECT_STREAK_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "envelope-archive.mjs"),
    ENVELOPE_ARCHIVE_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "time-authority.mjs"),
    TIME_AUTHORITY_SRC,
    "utf8",
  );
  return { rootDir, mutantPath };
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the source (found ${count})`,
  );
}

// HYK-428: the exact call-site fix this round makes. Test (c) below reverts
// this back to the pre-HYK-428 no-arg call to prove (not assume) it is the
// load-bearing line.
const FIXED_LEDGER_PATH_TARGET =
  'ledgerPath: join(\n        mainRepoRoot(harnessDir),\n        ".harness",\n        "reject-streak.json",\n      ),';
const VULNERABLE_LEDGER_PATH_TARGET =
  'ledgerPath: join(mainRepoRoot(), ".harness", "reject-streak.json"),';

test("HYK-428 (a)★ GREEN (live code, fixed): harnessDir is a legitimate isolated fixture repo (passes isInsideGitWorktree + head_commit) while the calling process's OWN cwd is a DIFFERENT, unrelated repo -- the ledger entry must land in harnessDir's own repo, never the cwd repo", () => {
  const cwdRepo = tmpDir("hyk428-cwdrepo-");
  const fixtureRepo = tmpDir("hyk428-fixturerepo-");
  try {
    initPlainGitRepo(cwdRepo);
    initPlainGitRepo(fixtureRepo);
    const harnessDir = join(fixtureRepo, ".harness");
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9800-review-1",
      verdict: "rejected",
      droppedAt: "2026-09-04 09:00",
      doneAt: "2026-09-04 09:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: cwdRepo }, // 프로세스의 ambient cwd != harnessDir 자신의 저장소
    );
    assert.equal(result.exit, 0, `handshake must confirm ok: ${result.stderr}`);
    const fixtureLedger = readLedger(fixtureRepo);
    assert.ok(
      fixtureLedger && fixtureLedger.issues["HYK-9800"],
      "the entry must land in harnessDir's OWN repo, not the process's ambient cwd repo",
    );
    assert.equal(fixtureLedger.issues["HYK-9800"].streak, 1);
    assert.equal(
      readLedger(cwdRepo),
      null,
      "the process's ambient cwd repo must receive NOTHING -- it is not harnessDir's repo and has no business being written to",
    );
  } finally {
    rmSync(cwdRepo, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
  }
});

test("HYK-428 (b) 변이 검사 ①: 고정 줄을 되돌림 변이(pre-HYK-428, mainRepoRoot() 무인자)로 바꾸면 -> 같은 시나리오가 CWD 저장소에 기록된다 (RED, 이 줄이 실제로 막던 것이었다는 증거)", () => {
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_LIVE_SRC,
    FIXED_LEDGER_PATH_TARGET,
    "HYK-428 fixed ledgerPath call",
  );
  const mutated = RELAY_HANDSHAKE_LIVE_SRC.replace(
    FIXED_LEDGER_PATH_TARGET,
    VULNERABLE_LEDGER_PATH_TARGET,
  );
  const { rootDir, mutantPath } = writeMutantRelayHandshake(mutated);
  const cwdRepo = tmpDir("hyk428-mutant-cwdrepo-");
  const fixtureRepo = tmpDir("hyk428-mutant-fixturerepo-");
  try {
    initPlainGitRepo(cwdRepo);
    initPlainGitRepo(fixtureRepo);
    const harnessDir = join(fixtureRepo, ".harness");
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9801-review-1",
      verdict: "rejected",
      droppedAt: "2026-09-04 09:00",
      doneAt: "2026-09-04 09:10:00",
    });
    const result = runRelayHandshakeCli(mutantPath, ["review", harnessDir], {
      cwd: cwdRepo,
    });
    assert.equal(result.exit, 0, `mutant handshake: ${result.stderr}`);
    const cwdLedger = readLedger(cwdRepo);
    assert.ok(
      cwdLedger && cwdLedger.issues["HYK-9801"],
      "RED: with mainRepoRoot() reverted to no-arg (pre-HYK-428), the isolated fixture's fabricated entry lands in the UNRELATED cwd repo instead -- exactly the 2026-09-04 12-ghost-entry mechanism (coder-task.md §1-1)",
    );
    assert.equal(
      readLedger(fixtureRepo),
      null,
      "RED corollary: harnessDir's own repo receives nothing under the reverted (vulnerable) call",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(cwdRepo, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
  }
});

test("HYK-428 (c) 변이 검사 ②: 고정 줄만 원복하면 -> 같은 시나리오가 다시 harnessDir 자신의 저장소에 기록된다 (GREEN, RED와 정확히 대칭)", () => {
  const { rootDir, mutantPath } = writeMutantRelayHandshake(
    RELAY_HANDSHAKE_LIVE_SRC,
  );
  const cwdRepo = tmpDir("hyk428-restored-cwdrepo-");
  const fixtureRepo = tmpDir("hyk428-restored-fixturerepo-");
  try {
    initPlainGitRepo(cwdRepo);
    initPlainGitRepo(fixtureRepo);
    const harnessDir = join(fixtureRepo, ".harness");
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9802-review-1",
      verdict: "rejected",
      droppedAt: "2026-09-04 09:00",
      doneAt: "2026-09-04 09:10:00",
    });
    const result = runRelayHandshakeCli(mutantPath, ["review", harnessDir], {
      cwd: cwdRepo,
    });
    assert.equal(result.exit, 0, `restored handshake: ${result.stderr}`);
    const fixtureLedger = readLedger(fixtureRepo);
    assert.ok(
      fixtureLedger && fixtureLedger.issues["HYK-9802"],
      "GREEN: restoring the live (fixed) call site sends the entry back to harnessDir's own repo",
    );
    assert.equal(readLedger(cwdRepo), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(cwdRepo, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
  }
});
