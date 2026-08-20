// HYK-314: 재작업 라운드에서 승인된 검토가 «이전(검토) 워크트리»에만 있어
// 커밋 검문소(review-gate.mjs)가 그것을 보지 못하던 구멍(§1)을 닫는 결선을
// 실 CLI로 검증한다. 시험 저장소는 review-gate-auto-record.test.mjs의
// initPlainGitRepo/addLinkedWorktree/writeCommitMsg/runReviewGateCli 관용구를
// 그대로(같은 패턴을 이 파일 안에 다시 작성 -- 그 파일은 무접촉 대상이라
// import하지 않는다) 재사용해, 완전히 저장소 밖 mkdtemp에 합성한 "메인
// 클론 + 링크드 워크트리 2개" 쌍 안에서만 실행한다. 실물 관제실·실물
// 원장은 전혀 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  computeFingerprint,
  formatBindingBlock,
} from "./review-approval-binding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_GATE_PATH = join(HERE, "review-gate.mjs");

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

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

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

function addLinkedWorktree(mainDir, label) {
  const linkedDir = tmpDir(`hyk314-cwb-${label}-`);
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-cwb-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  mkdirSync(join(linkedDir, ".harness"), { recursive: true });
  return linkedDir;
}

function writeReviewMd(dir, { taskId, verdict, doneAt }) {
  let binding = "";
  if (verdict === "approved") {
    const fp = computeFingerprint({ cwd: dir });
    assert.equal(
      fp.ok,
      true,
      `fingerprint must be computable in ${dir}: ${fp.reason}`,
    );
    binding = formatBindingBlock({
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
  }
  writeFileSync(
    join(dir, ".harness", "review.md"),
    `for: ${taskId}\ntask_id: ${taskId}\nrole: REVIEW-CODEX\nverdict: ${verdict}\n${binding}\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

function writeCommitMsg(subject) {
  const msgDir = mkdtempSync(join(tmpdir(), "hyk314-cwb-commit-msg-"));
  const p = join(msgDir, "commit-msg.txt");
  writeFileSync(p, `${subject}\n`, "utf8");
  return p;
}

function runReviewGateCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [REVIEW_GATE_PATH, ...args], {
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

// ---------------------------------------------------------------------------
// 시험 1: 합성 재작업 라운드 -- 승인된 검토가 «다른 워크트리»에 있어도
// skip-review 없이 커밋이 통과해야 한다.
// ---------------------------------------------------------------------------

test("(1) 합성 재작업: reviewWorktree에서 승인 -> 별도 codeWorktree에서 같은 코드 상태로 skip-review 없이 커밋 통과", () => {
  withTempDir("hyk314-cwb-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const reviewWt = addLinkedWorktree(mainDir, "review");
    const codeWt = addLinkedWorktree(mainDir, "code");
    try {
      // REVIEW 워크트리: 검토 대상 코드 변경을 재현하고 승인 기록.
      writeFileSync(join(reviewWt, "feature.js"), "FIXED\n", "utf8");
      git(reviewWt, ["add", "feature.js"]);
      writeReviewMd(reviewWt, {
        taskId: "HYK-9700-binding-1",
        verdict: "approved",
        doneAt: "2026-08-20 10:00",
      });
      const reviewCommitMsg = writeCommitMsg(
        "fix(x): HYK-9700 -- something (review round)",
      );
      const reviewRun = runReviewGateCli([reviewCommitMsg], { cwd: reviewWt });
      assert.equal(
        reviewRun.exit,
        0,
        `review-side gate run must pass: ${reviewRun.stderr}`,
      );
      assert.match(
        reviewRun.stdout,
        /shared-evidence-cache: cached approval for HYK-9700/,
      );

      const sharedCachePath = join(
        mainDir,
        ".harness",
        "approved-reviews",
        "HYK-9700.md",
      );
      assert.ok(
        existsSync(sharedCachePath),
        "shared cache file must be written to mainRepoRoot()",
      );

      // 재작업(CODER) 워크트리: review.md가 없다 -- 같은 코드 상태만 재현.
      assert.ok(
        !existsSync(join(codeWt, ".harness", "review.md")),
        "sanity: rework worktree must NOT have its own review.md",
      );
      writeFileSync(join(codeWt, "feature.js"), "FIXED\n", "utf8");
      git(codeWt, ["add", "feature.js"]);
      const reworkCommitMsg = writeCommitMsg(
        "fix(x): HYK-9700-binding-1 -- rework round, no skip-review trailer",
      );
      const reworkRun = runReviewGateCli([reworkCommitMsg], { cwd: codeWt });
      assert.equal(
        reworkRun.exit,
        0,
        `rework commit must pass WITHOUT skip-review: ${reworkRun.stderr}`,
      );
      assert.doesNotMatch(reworkRun.stdout + reworkRun.stderr, /skip-review/);
    } finally {
      rmSync(reviewWt, { recursive: true, force: true });
      rmSync(codeWt, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 시험 2 (회귀): 승인이 «아예 없는» 커밋은 여전히 차단된다.
// ---------------------------------------------------------------------------

test("(2a) 회귀: 공유 캐시도 로컬 review.md도 없는 이슈 -> 여전히 차단", () => {
  withTempDir("hyk314-cwb-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const codeWt = addLinkedWorktree(mainDir, "code-noapproval");
    try {
      writeFileSync(join(codeWt, "feature.js"), "UNREVIEWED\n", "utf8");
      const commitMsg = writeCommitMsg(
        "fix(x): HYK-9701-binding-1 -- no approval anywhere",
      );
      const run = runReviewGateCli([commitMsg], { cwd: codeWt });
      assert.equal(run.exit, 1, "commit with no approval evidence must block");
      assert.match(run.stderr, /review file not found/);
    } finally {
      rmSync(codeWt, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 시험 2b (회귀): 반려(rejected) 판정만 있는 경우도 차단 -- 그리고 반려는
// 공유 캐시에 아예 쓰이지 않는다(genuine approval 경로에서만 캐시).
// ---------------------------------------------------------------------------

test("(2b) 회귀: 반려(rejected) 판정만 있는 리뷰 -> 차단되고 공유 캐시에 남지 않는다", () => {
  withTempDir("hyk314-cwb-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const reviewWt = addLinkedWorktree(mainDir, "review-rejected");
    try {
      writeFileSync(join(reviewWt, "feature.js"), "BROKEN\n", "utf8");
      writeReviewMd(reviewWt, {
        taskId: "HYK-9702-binding-1",
        verdict: "rejected",
        doneAt: "2026-08-20 10:05",
      });
      const commitMsg = writeCommitMsg(
        "fix(x): HYK-9702-binding-1 -- rejected review",
      );
      const run = runReviewGateCli([commitMsg], { cwd: reviewWt });
      assert.equal(
        run.exit,
        1,
        "commit backed only by a rejected review must block",
      );
      assert.match(run.stderr, /review not approved/);

      const sharedCachePath = join(
        mainDir,
        ".harness",
        "approved-reviews",
        "HYK-9702.md",
      );
      assert.ok(
        !existsSync(sharedCachePath),
        "a rejected verdict must never populate the shared approved-evidence cache",
      );
    } finally {
      rmSync(reviewWt, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 시험 2c (회귀): 공유 캐시가 있어도 «다른 코드 상태»면 지문 불일치로 차단
// -- 재작업 라운드가 승인 이후 코드를 더 바꿔놓고도 통과하지 못한다.
// ---------------------------------------------------------------------------

test("(2c) 회귀: 공유 캐시 존재 + 코드 상태가 승인 시점과 다름 -> 불일치로 차단", () => {
  withTempDir("hyk314-cwb-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const reviewWt = addLinkedWorktree(mainDir, "review-mismatch");
    const codeWt = addLinkedWorktree(mainDir, "code-mismatch");
    try {
      writeFileSync(join(reviewWt, "feature.js"), "APPROVED_STATE\n", "utf8");
      git(reviewWt, ["add", "feature.js"]);
      writeReviewMd(reviewWt, {
        taskId: "HYK-9703-binding-1",
        verdict: "approved",
        doneAt: "2026-08-20 10:10",
      });
      const reviewCommitMsg = writeCommitMsg(
        "fix(x): HYK-9703 -- something (review round)",
      );
      const reviewRun = runReviewGateCli([reviewCommitMsg], { cwd: reviewWt });
      assert.equal(
        reviewRun.exit,
        0,
        `review-side gate run must pass: ${reviewRun.stderr}`,
      );

      // 재작업 워크트리: 승인된 것과 다른 내용으로 바꿔서 커밋 시도.
      writeFileSync(
        join(codeWt, "feature.js"),
        "DRIFTED_AFTER_APPROVAL\n",
        "utf8",
      );
      const reworkCommitMsg = writeCommitMsg(
        "fix(x): HYK-9703-binding-1 -- rework round diverged from approval",
      );
      const reworkRun = runReviewGateCli([reworkCommitMsg], { cwd: codeWt });
      assert.equal(
        reworkRun.exit,
        1,
        "drifted code must be blocked, not silently passed",
      );
      assert.match(reworkRun.stderr, /불일치/);
    } finally {
      rmSync(reviewWt, { recursive: true, force: true });
      rmSync(codeWt, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 시험 3: 자기 승인 차단 유지 -- 공유 캐시 경로로도 role: REVIEW가 없는
// 증거는 여전히 self-certification으로 차단된다.
// ---------------------------------------------------------------------------

test("(3) 자기 승인 차단: 공유 캐시에 role: REVIEW가 없는 승인 텍스트 -> 여전히 차단", () => {
  withTempDir("hyk314-cwb-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const codeWt = addLinkedWorktree(mainDir, "self-cert");
    try {
      writeFileSync(join(codeWt, "feature.js"), "SELF_APPROVED\n", "utf8");
      const fp = computeFingerprint({ cwd: codeWt });
      assert.equal(fp.ok, true);
      const binding = formatBindingBlock({
        fingerprint: fp.fingerprint,
        entries: fp.entries,
      });
      // A worker-forged evidence file with no independent-reviewer marker,
      // placed directly at the shared cache path (as if `--record` had run,
      // but the role line is deliberately CODER, not REVIEW-*).
      const sharedDir = join(mainDir, ".harness", "approved-reviews");
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(
        join(sharedDir, "HYK-9704.md"),
        `for: HYK-9704-binding-1\ntask_id: HYK-9704-binding-1\nrole: CODER\nverdict: approved\n${binding}\n>>> DONE: CODER @ 2026-08-20 10:20 KST\n`,
        "utf8",
      );

      const commitMsg = writeCommitMsg(
        "fix(x): HYK-9704-binding-1 -- self-certified rework, no reviewer",
      );
      const run = runReviewGateCli([commitMsg], { cwd: codeWt });
      assert.equal(
        run.exit,
        1,
        "self-certified evidence (no role: REVIEW) must still block",
      );
      assert.match(run.stderr, /self-certification blocked/);
    } finally {
      rmSync(codeWt, { recursive: true, force: true });
    }
  });
});
