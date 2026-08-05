// HYK-183 (줄기 A): relay-handshake.mjs가 REVIEW-family 결과 파일을
// «완료»로 확인하는 시점에 reject-streak.mjs의 record를 자동으로 호출하는
// 결선 자체를 시험한다 (§2/§3의 a/b/c/d/f를 여기서 고정한다).
//
// §2-2 비타협: `.harness/reject-streak.json`(실제 원장)은 절대 건드리지
// 않는다 -- 모든 시험은 저장소 밖 mkdtemp에 «완전히 합성된» main 저장소 +
// 링크드 워크트리 쌍을 만들어 그 안에서만 CLI를 실행한다(§4-1 "실제
// 워크트리를 새로 만들지 마라"의 정신 그대로, scripts/supervisor/
// seat-liveness-wire.test.mjs의 initPlainGitRepo/addLinkedWorktree 관용구를
// 재사용 -- 그 파일 자체는 무접촉 대상이라 import하지 않고 같은 패턴을
// 이 파일 안에 다시 작성했다).
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

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");

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

// A fully synthetic bare-bones repo, entirely outside this real repo --
// this is the "main clone" half of the pair.
function initPlainGitRepo(dir) {
  // Mirrors the real main repo's actual state: `.harness/` already exists
  // (coder-task.md etc. are routinely dropped there) by the time any
  // review round ever runs -- writeLedger itself has never had to create
  // this directory in production, and this task does not add that (out of
  // scope: §2-2 forbids touching reject-streak.mjs's own gate/write logic
  // beyond what §2's wiring requires).
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
  const linkedDir = tmpDir("hyk183-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  return linkedDir;
}

function writeReviewFixture(
  harnessDir,
  { taskId, verdict, droppedAt, doneAt },
) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: ${verdict}\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

function runRelayHandshakeCli(scriptPath, args, opts = {}) {
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

function readMainLedger(mainDir) {
  const p = join(mainDir, ".harness", "reject-streak.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// ---------------------------------------------------------------------------
// (a) 결선 실증: REVIEW 결과 파일이 «완료»로 확인되면 원장이 실제로
// 갱신된다 (승인 -> streak 0 / 반려 -> +1), 실행은 실 CLI로 -- 링크드
// 워크트리 cwd에서.
// ---------------------------------------------------------------------------

test("(a)★ 결선 실증: rejected review, run from a LINKED WORKTREE cwd -> real CLI run updates the MAIN repo's ledger to streak=1, exit code unchanged (0)", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9500-review-1",
        verdict: "rejected",
        droppedAt: "2026-08-04 21:00",
        doneAt: "2026-08-04 21:10",
      });

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(
        result.exit,
        0,
        `handshake must still confirm ok: ${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /reject-streak auto-record:.*HYK-9500.*streak=1/,
      );

      const ledger = readMainLedger(mainDir);
      assert.ok(ledger, "main repo ledger must have been created");
      assert.equal(ledger.issues["HYK-9500"].streak, 1);
      assert.equal(ledger.issues["HYK-9500"].history.length, 1);
      assert.equal(ledger.issues["HYK-9500"].history[0].verdict, "rejected");
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("(a) 결선 실증: approved review after a prior reject -> streak resets to 0, history keeps both entries", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9501-review-1",
        verdict: "rejected",
        droppedAt: "2026-08-04 21:00",
        doneAt: "2026-08-04 21:10",
      });
      let result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        {
          cwd: linkedDir,
        },
      );
      assert.equal(result.exit, 0);
      assert.equal(readMainLedger(mainDir).issues["HYK-9501"].streak, 1);

      writeReviewFixture(harnessDir, {
        taskId: "HYK-9501-review-2",
        verdict: "approved",
        droppedAt: "2026-08-04 21:20",
        doneAt: "2026-08-04 21:30",
      });
      result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        {
          cwd: linkedDir,
        },
      );
      assert.equal(result.exit, 0);
      assert.match(result.stdout, /streak=0/);

      const ledger = readMainLedger(mainDir);
      assert.equal(ledger.issues["HYK-9501"].streak, 0);
      assert.equal(ledger.issues["HYK-9501"].history.length, 2);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b)★ 멱등성: 같은 결과 파일로 CLI를 두 번, 그리고 세 번 실행해도 streak과
// history가 한 번만 늘어난다.
// ---------------------------------------------------------------------------

test("(b)★ 멱등성: the exact same review.md handshake re-confirmed twice (and three times) -> streak/history increment only ONCE", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9502-review-1",
        verdict: "rejected",
        droppedAt: "2026-08-04 21:00",
        doneAt: "2026-08-04 21:10",
      });

      for (let i = 0; i < 3; i++) {
        const result = runRelayHandshakeCli(
          RELAY_HANDSHAKE_PATH,
          ["review", harnessDir],
          { cwd: linkedDir },
        );
        assert.equal(
          result.exit,
          0,
          `run #${i + 1} must still confirm the handshake`,
        );
      }

      const ledger = readMainLedger(mainDir);
      assert.equal(
        ledger.issues["HYK-9502"].streak,
        1,
        "3 identical re-confirmations must still leave streak=1, not 3",
      );
      assert.equal(ledger.issues["HYK-9502"].history.length, 1);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c)★ 원장 위치: 워크트리 cwd에서 실행해도 메인 저장소 원장에 기록되고,
// 워크트리 안에는 새 원장 파일이 생기지 않는다.
// ---------------------------------------------------------------------------

test("(c)★ 원장 위치: no reject-streak.json is EVER created inside the linked worktree's own .harness/ -- only in the main repo's", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9503-review-1",
        verdict: "rejected",
        droppedAt: "2026-08-04 21:00",
        doneAt: "2026-08-04 21:10",
      });
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(result.exit, 0);

      assert.equal(
        existsSync(join(harnessDir, "reject-streak.json")),
        false,
        "the linked worktree's own .harness/ must never get a per-worktree ledger",
      );
      assert.ok(
        readMainLedger(mainDir),
        "the main repo's .harness/reject-streak.json must exist",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d)★ 실패 가시성: 원장 읽기 실패·판정 추출 실패가 출력에 드러난다
// (조용한 성공 0), 그리고 그 실패가 checkRelayHandshake의 완료 판정 자체를
// 바꾸지 않는다 (§2-1 R5).
// ---------------------------------------------------------------------------

test("(d)★ 실패 가시성: a corrupted main-repo ledger does not silently no-op -- the failure is printed, while the handshake's own PASS/exit code stays unchanged", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    mkdirSync(join(mainDir, ".harness"), { recursive: true });
    writeFileSync(
      join(mainDir, ".harness", "reject-streak.json"),
      "{ not valid json",
      "utf8",
    );
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9504-review-1",
        verdict: "rejected",
        droppedAt: "2026-08-04 21:00",
        doneAt: "2026-08-04 21:10",
      });
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(
        result.exit,
        0,
        "a broken ledger must not flip the handshake's own confirmed-complete verdict (§2-1 R5)",
      );
      assert.match(
        result.stderr,
        /reject-streak: UNJUDGABLE.*not valid JSON/,
        "the ledger read/parse failure must be visible in the process output, not swallowed",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("(d) 실패 가시성: a REVIEW result file with no 'verdict:' line still confirms the handshake, but visibly reports the record as skipped/UNJUDGABLE", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, "review-task.md"),
        "task_id: HYK-9505-review-1\ndropped_at: 2026-08-04 21:00 KST\n",
        "utf8",
      );
      writeFileSync(
        join(harnessDir, "review.md"),
        "task_id: HYK-9505-review-1\n\n>>> DONE: REVIEW-CODEX @ 2026-08-04 21:10 KST\n",
        "utf8",
      );
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(result.exit, 0);
      assert.match(result.stderr, /UNJUDGABLE/);
      assert.equal(
        readMainLedger(mainDir),
        null,
        "no verdict line -> ledger must never be created at all",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("role scoping: a CODER handshake (no verdict possible) never touches the ledger, no extra process side effects visible either way", () => {
  withTempDir("hyk183-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, "coder-task.md"),
        "task_id: HYK-9506\ndropped_at: 2026-08-04 21:00 KST\n",
        "utf8",
      );
      writeFileSync(
        join(harnessDir, "coder.md"),
        "task_id: HYK-9506\n\n>>> DONE: CODER @ 2026-08-04 21:10 KST\n",
        "utf8",
      );
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["coder", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(result.exit, 0);
      assert.equal(
        readMainLedger(mainDir),
        null,
        "a CODER-role handshake must never create/touch the reject-streak ledger",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (f) 판별력 자동화: 사본 mutation으로 3가지 비타협 요구가 각각 RED가
// 되는지 확인한다. 대상은 이번 사이클에서 새로 추가한 코드이므로,
// skip-review-usage.test.mjs의 HYK-183 3R 선례(coder-task.md §R4가 지목한
// 정본)를 그대로 따라 `git show HEAD:`가 아니라 «작업 트리의 실제 파일»을
// readFileSync로 읽는다 -- HEAD 기준으로는 아직 커밋 전인 변경이 영원히
// skip 처리되며(REVIEW P2가 지목한 정확히 그 갭: 제출 시점 검증이 실제로는
// 한 번도 안 돈다), 작업 트리를 읽으면 지금 커밋하려는 그대로를 매번
// 검증하므로 skip이 0으로 고정된다. 변이체는 여전히 저장소 밖 mkdtemp에만
// 쓴다 -- 실제 scripts/check/{reject-streak,relay-handshake}.mjs는 쓰기용
// 으로 열리지 않는다.
// ---------------------------------------------------------------------------

const REJECT_STREAK_SRC_HEAD = readFileSync(
  join(ROOT, "scripts", "check", "reject-streak.mjs"),
  "utf8",
);
const RELAY_HANDSHAKE_SRC_HEAD = readFileSync(
  join(ROOT, "scripts", "check", "relay-handshake.mjs"),
  "utf8",
);

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the committed source (found ${count})`,
  );
}

function writeMutantPair(rootDir, { relaySrc, streakSrc }) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  writeFileSync(join(scriptsCheckDir, "relay-handshake.mjs"), relaySrc, "utf8");
  writeFileSync(join(scriptsCheckDir, "reject-streak.mjs"), streakSrc, "utf8");
  return join(scriptsCheckDir, "relay-handshake.mjs");
}

test("(f) mutation #1 (필수): computeRecord's idempotency dedupe removed -> a re-confirmed identical handshake DOUBLE-COUNTS the streak -> RED", () => {
  const target =
    "  const existing = ledger?.issues?.[outcome.issueId];\n  const lastEntry = existing?.history?.[existing.history.length - 1];\n  const isDuplicate =\n    !!lastEntry &&\n    lastEntry.task_id === outcome.taskId &&\n    lastEntry.verdict === outcome.verdict &&\n    (lastEntry.done_at ?? null) === (outcome.doneAt ?? null);\n  if (isDuplicate) {\n    return {\n      ok: true,\n      duplicate: true,\n      ledger,\n      issueId: outcome.issueId,\n      taskId: outcome.taskId,\n      verdict: outcome.verdict,\n      streak: existing.streak,\n    };\n  }\n\n";
  assertExactlyOneMatch(
    REJECT_STREAK_SRC_HEAD,
    target,
    "computeRecord dedupe block",
  );
  const mutatedStreak = REJECT_STREAK_SRC_HEAD.replace(target, "");

  withTempDir("hyk183-mutant-", (rootDir) => {
    const mutantRelay = writeMutantPair(rootDir, {
      relaySrc: RELAY_HANDSHAKE_SRC_HEAD,
      streakSrc: mutatedStreak,
    });
    withTempDir("hyk183-main-", (mainDir) => {
      initPlainGitRepo(mainDir);
      const linkedDir = addLinkedWorktree(mainDir);
      try {
        const harnessDir = join(linkedDir, ".harness");
        writeReviewFixture(harnessDir, {
          taskId: "HYK-9600-review-1",
          verdict: "rejected",
          droppedAt: "2026-08-04 21:00",
          doneAt: "2026-08-04 21:10",
        });
        for (let i = 0; i < 2; i++) {
          const r = runRelayHandshakeCli(mutantRelay, ["review", harnessDir], {
            cwd: linkedDir,
          });
          assert.equal(r.exit, 0);
        }
        const ledger = readMainLedger(mainDir);
        assert.equal(
          ledger.issues["HYK-9600"].streak,
          2,
          "mutant must double-count the identical re-confirmation (RED signal; real code keeps this at 1)",
        );
      } finally {
        rmSync(linkedDir, { recursive: true, force: true });
      }
    });
  });
});

test("(f) mutation #2 (필수): isReviewFamilyRole always returns false -> a REVIEW-family rejected round is never recorded at all -> RED", () => {
  const target =
    'export function isReviewFamilyRole(role) {\n  return typeof role === "string" && REVIEW_ROLE_RE.test(role);\n}';
  assertExactlyOneMatch(
    REJECT_STREAK_SRC_HEAD,
    target,
    "isReviewFamilyRole body",
  );
  const mutatedStreak = REJECT_STREAK_SRC_HEAD.replace(
    target,
    "export function isReviewFamilyRole(_role) {\n  return false;\n}",
  );

  withTempDir("hyk183-mutant-", (rootDir) => {
    const mutantRelay = writeMutantPair(rootDir, {
      relaySrc: RELAY_HANDSHAKE_SRC_HEAD,
      streakSrc: mutatedStreak,
    });
    withTempDir("hyk183-main-", (mainDir) => {
      initPlainGitRepo(mainDir);
      const linkedDir = addLinkedWorktree(mainDir);
      try {
        const harnessDir = join(linkedDir, ".harness");
        writeReviewFixture(harnessDir, {
          taskId: "HYK-9601-review-1",
          verdict: "rejected",
          droppedAt: "2026-08-04 21:00",
          doneAt: "2026-08-04 21:10",
        });
        const r = runRelayHandshakeCli(mutantRelay, ["review", harnessDir], {
          cwd: linkedDir,
        });
        assert.equal(
          r.exit,
          0,
          "handshake confirmation itself must be unaffected",
        );
        assert.equal(
          readMainLedger(mainDir),
          null,
          "mutant must never even attempt to record a REVIEW verdict (RED signal; real code creates the ledger here)",
        );
      } finally {
        rmSync(linkedDir, { recursive: true, force: true });
      }
    });
  });
});

test("(f) mutation #3 (필수): mainRepoRoot's --git-common-dir resolution reverted to plain repoRoot() -> the ledger lands in the WORKTREE-LOCAL .harness instead of the main repo's -> RED", () => {
  const target =
    'export function mainRepoRoot() {\n  const root = repoRoot();\n  try {\n    const commonDir = execSync("git rev-parse --git-common-dir", {\n      encoding: "utf8",\n      cwd: root,\n    }).trim();\n    const absCommonDir = /^([A-Za-z]:[\\\\/]|\\/)/.test(commonDir)\n      ? commonDir\n      : join(root, commonDir);\n    return absCommonDir.replace(/[\\\\/]\\.git$/, "");\n  } catch {\n    return root;\n  }\n}';
  assertExactlyOneMatch(RELAY_HANDSHAKE_SRC_HEAD, target, "mainRepoRoot body");
  const mutatedRelay = RELAY_HANDSHAKE_SRC_HEAD.replace(
    target,
    "export function mainRepoRoot() {\n  return repoRoot();\n}",
  );

  withTempDir("hyk183-mutant-", (rootDir) => {
    const mutantRelay = writeMutantPair(rootDir, {
      relaySrc: mutatedRelay,
      streakSrc: REJECT_STREAK_SRC_HEAD,
    });
    withTempDir("hyk183-main-", (mainDir) => {
      initPlainGitRepo(mainDir);
      const linkedDir = addLinkedWorktree(mainDir);
      try {
        const harnessDir = join(linkedDir, ".harness");
        writeReviewFixture(harnessDir, {
          taskId: "HYK-9602-review-1",
          verdict: "rejected",
          droppedAt: "2026-08-04 21:00",
          doneAt: "2026-08-04 21:10",
        });
        const r = runRelayHandshakeCli(mutantRelay, ["review", harnessDir], {
          cwd: linkedDir,
        });
        assert.equal(r.exit, 0);
        assert.equal(
          readMainLedger(mainDir),
          null,
          "mutant must NOT write the main repo's ledger (RED signal)",
        );
        assert.ok(
          existsSync(join(harnessDir, "reject-streak.json")),
          "mutant instead writes a per-worktree ledger -- exactly the 2026-07-26 실측 gap this task exists to close",
        );
      } finally {
        rmSync(linkedDir, { recursive: true, force: true });
      }
    });
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
    "reject-streak-auto-record.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "reject-streak-auto-record.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
