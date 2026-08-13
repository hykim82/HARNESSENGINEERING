// HYK-183-ledger-fix (축 B): review-gate.mjs(commit-msg 훅)가 승인된 커밋을
// 확정하는 바로 그 지점에서 reject-streak 원장에도 기록하는 결선 자체를
// 시험한다. §1 축 B의 실측 원인은 "호출 자체가 없다"였다 -- 기존
// checkRelayHandshake 쪽 자동 기록(HYK-183 §2, 37d68a1)은 ORCH가 "다음
// 라운드"의 handshake를 다시 확인할 때만 걸리는 부작용이라, 승인처럼
// 다음 라운드가 없는 종결 상태에서는 그 계기 자체가 생기지 않는다. 이
// 파일은 그 반대로 "커밋이 있으면 반드시 실행된다"를 보장하는 commit-msg
// 훅(review-gate.mjs) 쪽에 기록을 걸었을 때 실제로 원장이 갱신되는지를
// 실 CLI로 검증한다.
//
// §2-2와 동일한 비타협: `.harness/reject-streak.json`(실제 원장)은 절대
// 건드리지 않는다 -- 모든 시험은 저장소 밖 mkdtemp에 완전히 합성된 main
// 저장소 + 링크드 워크트리 쌍을 만들어 그 안에서만 CLI를 실행한다
// (reject-streak-auto-record.test.mjs의 initPlainGitRepo/addLinkedWorktree
// 관용구를 재사용 -- 그 파일 자체는 무접촉 대상이라 import하지 않고 같은
// 패턴을 이 파일 안에 다시 작성했다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
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
import {
  computeFingerprint,
  formatBindingBlock,
} from "./review-approval-binding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_GATE_PATH = join(HERE, "review-gate.mjs");

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

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

// A fully synthetic bare-bones repo, entirely outside this real repo -- the
// "main clone" half of the pair.
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

// A genuine `git worktree add` linked worktree of `mainDir`, living in its
// own separate mkdtemp directory (never nested inside mainDir, never inside
// this real repo).
function addLinkedWorktree(mainDir) {
  const linkedDir = tmpDir("hyk183-rg-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-rg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  mkdirSync(join(linkedDir, ".harness"), { recursive: true });
  return linkedDir;
}

// HYK-240: an approved review.md now needs a binding-fingerprint matching
// `linkedDir`'s state at CLI time or checkApprovalBinding fail-closes it
// ("결속 없음"). Compute it fresh here rather than hardcoding, so it stays
// correct regardless of what else is on disk. Only meaningful for
// verdict=approved -- rejected fixtures never reach the binding check.
function writeReviewMd(linkedDir, { taskId, verdict, doneAt }) {
  let binding = "";
  if (verdict === "approved") {
    const fp = computeFingerprint({ cwd: linkedDir });
    assert.equal(
      fp.ok,
      true,
      `fingerprint must be computable in ${linkedDir}: ${fp.reason}`,
    );
    binding = formatBindingBlock({
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
  }
  writeFileSync(
    join(linkedDir, ".harness", "review.md"),
    `for: ${taskId}\ntask_id: ${taskId}\nrole: REVIEW-CODEX\nverdict: ${verdict}\n${binding}\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

// HYK-240: production's commit-message file lives under `.git/`, outside
// the working tree `git status` scans -- writing it inside `dir` would shift
// the fingerprint computed above (writeReviewMd runs before this in every
// call site, but keeping the message file physically out of `dir` makes
// that ordering a non-issue either way).
function writeCommitMsg(dir, subject) {
  const msgDir = mkdtempSync(join(tmpdir(), "hyk183-rg-commit-msg-"));
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

function readMainLedger(mainDir) {
  const p = join(mainDir, ".harness", "reject-streak.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// ---------------------------------------------------------------------------
// (a)★ 결선 실증: 승인 커밋이 review-gate 훅을 통과하면 -- checkRelayHandshake
// 를 한 번도 부르지 않아도 -- 메인 저장소 원장이 streak=0으로 갱신된다.
// ---------------------------------------------------------------------------

test("(a)★ 결선 실증: approved commit (review-gate ok) from a LINKED WORKTREE -> real CLI run records the approval into the MAIN repo's ledger, exit code unchanged (0)", () => {
  withTempDir("hyk183-rg-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeReviewMd(linkedDir, {
        taskId: "HYK-9600-review-1",
        verdict: "approved",
        doneAt: "2026-08-05 12:00",
      });
      const commitMsgFile = writeCommitMsg(
        linkedDir,
        "fix(check): HYK-9600 -- something",
      );

      const result = runReviewGateCli([commitMsgFile], { cwd: linkedDir });
      assert.equal(result.exit, 0, `gate must pass: ${result.stderr}`);
      assert.match(
        result.stdout,
        /reject-streak auto-record:.*HYK-9600.*streak=0/,
      );

      const ledger = readMainLedger(mainDir);
      assert.ok(ledger, "main repo ledger must have been created");
      assert.equal(ledger.issues["HYK-9600"].streak, 0);
      assert.equal(ledger.issues["HYK-9600"].history.length, 1);
      assert.equal(ledger.issues["HYK-9600"].history[0].verdict, "approved");
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b)★ 실사고 재현: 반려 뒤 승인이 streak을 실제로 0으로 되돌린다 -- §1 축
// B가 실측한 "반려 다음의 승인이 streak을 0으로 되돌리지 못한다"의 정반대
// 동작을 고정한다.
// ---------------------------------------------------------------------------

test("(b)★ 실사고 재현: reject (streak=1) -> approve via commit-msg hook -> streak resets to 0 (§1 축 B가 실측한 결함의 정반대 동작)", () => {
  withTempDir("hyk183-rg-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      // 1) 사전 상태를 원장에 직접 심는다(반려 스트릭 1) -- 이 시험의
      // 목적은 review-gate 쪽 승인 결선만이므로, 반려 기록 경로 자체는
      // reject-streak-auto-record.test.mjs가 이미 고정한다.
      writeFileSync(
        join(mainDir, ".harness", "reject-streak.json"),
        JSON.stringify(
          {
            schema_version: 1,
            issues: {
              "HYK-9601": {
                streak: 1,
                history: [
                  {
                    task_id: "HYK-9601",
                    verdict: "rejected",
                    at: "2026-08-05 09:34 KST",
                    done_at: "2026-08-05 09:34 KST",
                  },
                ],
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      writeReviewMd(linkedDir, {
        taskId: "HYK-9601",
        verdict: "approved",
        doneAt: "2026-08-05 13:08",
      });
      const commitMsgFile = writeCommitMsg(
        linkedDir,
        "fix(check): HYK-9601 -- something",
      );

      const result = runReviewGateCli([commitMsgFile], { cwd: linkedDir });
      assert.equal(result.exit, 0, `gate must pass: ${result.stderr}`);

      const ledger = readMainLedger(mainDir);
      assert.equal(
        ledger.issues["HYK-9601"].streak,
        0,
        "승인이 streak을 0으로 되돌려야 한다",
      );
      assert.equal(ledger.issues["HYK-9601"].history.length, 2);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) skip-review/무태그 커밋은 review.md를 이 커밋의 승인으로 잘못 붙이지
// 않는다 -- review.md가 남아 있어도(다른 이슈의 잔여물일 수 있다) 기록을
// 시도조차 하지 않는다.
// ---------------------------------------------------------------------------

test("(c) skip-review commit -> review.md가 존재해도 기록을 시도하지 않는다 (이 커밋과 무관한 잔여 파일을 잘못 붙이지 않음)", () => {
  withTempDir("hyk183-rg-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeReviewMd(linkedDir, {
        taskId: "HYK-9602",
        verdict: "approved",
        doneAt: "2026-08-05 12:00",
      });
      const commitMsgFile = writeCommitMsg(
        linkedDir,
        "fix(check): HYK-9602 -- hotfix\n\nskip-review: urgent CI fix, no reviewer available",
      );

      const result = runReviewGateCli([commitMsgFile], { cwd: linkedDir });
      assert.equal(result.exit, 0);
      assert.doesNotMatch(result.stdout, /reject-streak auto-record/);
      assert.equal(
        readMainLedger(mainDir),
        null,
        "no ledger should be created for a skip-review commit",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("(d) no HYK tag in subject -> not issue work, no recording attempted", () => {
  withTempDir("hyk183-rg-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeReviewMd(linkedDir, {
        taskId: "HYK-9603",
        verdict: "approved",
        doneAt: "2026-08-05 12:00",
      });
      const commitMsgFile = writeCommitMsg(linkedDir, "chore: tidy up");

      const result = runReviewGateCli([commitMsgFile], { cwd: linkedDir });
      assert.equal(result.exit, 0);
      assert.doesNotMatch(result.stdout, /reject-streak auto-record/);
      assert.equal(readMainLedger(mainDir), null);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (e)★ 멱등성: 같은 commit-msg 훅 호출을 두 번 반복해도(예: 훅 재실행) 원장이
// 두 번 늘지 않는다 -- axis A의 done_at 기반 판정이 여기서도 그대로 적용됨을
// 확인한다.
// ---------------------------------------------------------------------------

test("(e)★ 멱등성: the same approved review.md confirmed twice via the hook -> streak/history increments only ONCE", () => {
  withTempDir("hyk183-rg-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeReviewMd(linkedDir, {
        taskId: "HYK-9604-review-1",
        verdict: "approved",
        doneAt: "2026-08-05 12:00",
      });
      const commitMsgFile = writeCommitMsg(
        linkedDir,
        "fix(check): HYK-9604 -- something",
      );

      for (let i = 0; i < 2; i++) {
        const result = runReviewGateCli([commitMsgFile], { cwd: linkedDir });
        assert.equal(result.exit, 0, `run #${i + 1} must still pass`);
      }

      const ledger = readMainLedger(mainDir);
      assert.equal(ledger.issues["HYK-9604"].history.length, 1);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "review-gate-auto-record.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "review-gate-auto-record.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
