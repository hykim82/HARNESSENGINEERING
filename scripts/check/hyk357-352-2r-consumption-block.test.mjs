// HYK-357-352 2R §1/§3 (P1-1 수리 + 소비 경로 계약 시험) -- 1R은
// 'FOR_LINE_ISSUE_ID_UNPARSEABLE'을 reject-streak.mjs에 새로 만들었지만
// relay-handshake.mjs의 어떤 차단 집합에도 넣지 않았다. 그 결과 검토 1R이
// 실측한 대로 `for: ORCH` + `verdict: rejected`가 `checkRelayHandshake
// ok:true`로 조용히 통과하고, rejected 판정이 reject-streak 원장에 전혀
// 남지 않았다(HYK-357이 등재된 증상 그 자체, 게이트 2 사다리 무장 해제).
//
// 이 파일은 hyk262-consumption-reject.test.mjs와 정확히 같은 골격(같은
// mkdtemp 격리 저장소+linked worktree 관용구, 같은 CLI 구동 방식, 같은
// before/after `git status`/`git diff` 무손상 단언)을 재사용해 이번엔
// «값 규격 위반» 갈래(HYK-357, checkValueInvalidCoverViolation)를 고정한다
// -- HYK-262의 «개수 위반» 갈래(checkAmbiguousCoverViolation)와는 별개
// 함수·별개 Set·별개 사유 문구다.
//
// ⛔모든 원장/영수증은 mkdtemp 합성 픽스처다 -- 실제 관제실 정본에는
// 절대 쓰지 않는다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
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

function addLinkedWorktree(mainDir) {
  const linkedDir = tmpDir("hyk357-352-2r-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  return linkedDir;
}

function runRelayHandshakeCli(scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
    // HYK-359: never let an ambient ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
    // DISPATCH_RECEIPT_PATH leaked from the invoking shell reach this child --
    // see admission-ledger-env-isolation.mjs's header for why.
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

function readMainLedger(mainDir) {
  const p = join(mainDir, ".harness", "reject-streak.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// The exact 2026-08-25 실사고 shape (검토 1R 급소 1 원문 재현): a single
// well-formed `for:` line whose VALUE is a role name, not an issue id.
// `task_id:` is fine -- that is the whole point (검토 1R: "task_id: 은
// 멀쩡했다").
// HYK-383: REVIEW 계열 소비는 head_commit: 축(축 ⓐ+ⓑ)도 통과해야 한다 --
// 이 파일의 fixture는 그 축과 무관한('for:' 값 규격) 반려를 시험하므로,
// head_commit 축이 그 사유를 가리지 않도록 항상 실제 워크트리 HEAD로
// 채운다(harnessDir는 이미 진짜 링크드 워크트리 안이다).
function writeForRoleNameFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(harnessDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ORCH\nverdict: rejected\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

// HYK-262's existing double-'for:' shape, reproduced locally (not imported
// from hyk262-consumption-reject.test.mjs, to keep this file independently
// runnable) so this file can assert the AMBIGUOUS_* safety net is
// unblunted by today's new value-invalid gate sitting right next to it.
function writeDoubleForFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(harnessDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nfor: ORCH\nverdict: rejected\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

function writeNormalRejectFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(harnessDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: rejected\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// (a)★ P1-1 수리 확인: 'for: ORCH'(값 규격 위반, task_id:는 멀쩡) ->
// 소비 실패(0 아닌 종료코드), 원장 미생성, 보관 미실시, 사유 문구가
// «막다른 길»이 아니라(task_id: 진단이 실려 있다) 사유에 HYK-357 축임이
// 드러난다(HYK-262와 문구 구분).
// ---------------------------------------------------------------------------

test("(a)★ 2026-08-25 실사고 재현: 'for: ORCH'(값 규격 위반) -> 소비 실패, 원장 미기록, 보관 미실시, 사유에 task_id: 진단 포함", () => {
  withTempDir("hyk357-352-2r-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeForRoleNameFixture(harnessDir, {
        taskId: "HYK-9700-review-1",
        droppedAt: "2026-08-25 20:00",
        doneAt: "2026-08-25 20:10:00",
      });

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );

      assert.notEqual(
        result.exit,
        0,
        `consumption must fail (nonzero exit) on the for:-value-invalid shape: stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /consumption rejected \(HYK-357\)/,
        "the rejection reason must name the HYK-357 value-invalid gate, distinct from HYK-262's count gate",
      );
      assert.doesNotMatch(
        result.stderr,
        /consumption rejected \(HYK-262\)/,
        "must NOT be misfiled under the count-violation gate -- this is a value violation, not a count violation (검토 1R 요구사항 1)",
      );
      assert.match(
        result.stderr,
        /task_id: 은 멀쩡했다/,
        "★막다른 길 금지: the block reason must carry forward the 1R diagnostic that task_id: was itself fine",
      );
      assert.match(
        result.stderr,
        /HYK-9700-review-1/,
        "the diagnostic must show task_id:'s actual value, not just say it was fine",
      );

      assert.equal(
        readMainLedger(mainDir),
        null,
        "the ledger must never be created -- the exact HYK-357 gap (rejected verdict never reaches the ledger)",
      );
      assert.equal(
        existsSync(join(harnessDir, "rounds")),
        false,
        "보관 미실시: envelope/task-file archiving must be skipped, not just the receipt",
      );
      assert.ok(
        existsSync(join(harnessDir, "review-task.md")),
        "the live task file must remain untouched (never archived away)",
      );
      assert.ok(
        existsSync(join(harnessDir, "review.md")),
        "the live result file must remain untouched (never archived away)",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) ⛔안전망 무뎌짐 회귀 0: 기존 AMBIGUOUS_*(표지 2개 이상) 차단은
// 이 새 갈래가 옆에 생겨도 그대로 살아 있다.
// ---------------------------------------------------------------------------

test("(b)★ 회귀 0: 기존 HYK-262 AMBIGUOUS_FOR_LINE(표지 2개) 차단은 새 HYK-357 갈래가 옆에 생겨도 그대로 살아 있다", () => {
  withTempDir("hyk357-352-2r-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeDoubleForFixture(harnessDir, {
        taskId: "HYK-9701-review-1",
        droppedAt: "2026-08-25 20:00",
        doneAt: "2026-08-25 20:10:00",
      });

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );

      assert.notEqual(result.exit, 0, "AMBIGUOUS_FOR_LINE must still block");
      assert.match(result.stderr, /consumption rejected \(HYK-262\)/);
      assert.doesNotMatch(
        result.stderr,
        /consumption rejected \(HYK-357\)/,
        "a count violation must not be misfiled under the new value-invalid gate either",
      );
      assert.equal(readMainLedger(mainDir), null);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("(c) 회귀 0 대조군: 정상(단일, 규격 맞는 'for:' 줄) 반려는 여전히 소비 성공 + 원장 streak=1", () => {
  withTempDir("hyk357-352-2r-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeNormalRejectFixture(harnessDir, {
        taskId: "HYK-9702-review-1",
        droppedAt: "2026-08-25 20:00",
        doneAt: "2026-08-25 20:10:00",
      });

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );

      assert.equal(
        result.exit,
        0,
        `a genuine, unambiguous, value-valid reject must still consume normally: ${result.stderr}`,
      );
      const ledger = readMainLedger(mainDir);
      assert.ok(ledger, "main repo ledger must have been created");
      assert.equal(ledger.issues["HYK-9702"].streak, 1);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d)★ RED 시험: §3이 요구한 대로, «파서가 거부한 입력이 소비에서도
// 막히는가»를 못 잡는 시험이 되지 않게 -- checkValueInvalidCoverViolation의
// early-return 블록을 제거한 변이는 (a)와 같은 입력에서 다시 소비를
// 성공시킨다(1R의 실제 결함을 재현). 원복 증명 포함.
// ---------------------------------------------------------------------------

test("(d)★ RED: HYK-357 값-위반 차단 코드를 제거한 변이는 (a)와 같은 입력에서 소비를 성공시킨다(1R 결함 재현), 원복 후 다시 초록", () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  const valueViolation = checkValueInvalidCoverViolation(recordOutcome);\n" +
    "  if (valueViolation) return valueViolation;\n";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (the checkValueInvalidCoverViolation early-return block) must appear exactly once in the current working-tree source (found ${count}) -- if this fails after an unrelated edit, update the target string, do not skip the RED test`,
  );
  const mutated = src.replace(target, "");
  assert.notEqual(mutated, src, "mutation must actually change the source");

  withTempDir("hyk357-352-2r-red-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    const mutantDir = tmpDir("hyk357-352-2r-red-mutant-");
    try {
      const mutantRelay = join(mutantDir, "relay-handshake.mjs");
      writeFileSync(mutantRelay, mutated, "utf8");
      for (const dep of [
        "reject-streak.mjs",
        "envelope-archive.mjs",
        "time-authority.mjs",
        "admission-completion-adapter.mjs",
        // HYK-302/355 §2-A dedup: admission-completion-adapter.mjs now
        // statically imports this shared module.
        "ledger-pointer-shared.mjs",
        // HYK-398 §2-⑶: admission-completion-adapter.mjs now also
        // statically imports this zero-import core.
        "retirement-record-core.mjs",
        "consumption-receipt-writer.mjs",
        "consumption-receipt-core.mjs",
      ]) {
        writeFileSync(
          join(mutantDir, dep),
          readFileSync(join(HERE, dep), "utf8"),
          "utf8",
        );
      }

      const harnessDir = join(linkedDir, ".harness");
      writeForRoleNameFixture(harnessDir, {
        taskId: "HYK-9703-review-1",
        droppedAt: "2026-08-25 20:00",
        doneAt: "2026-08-25 20:10:00",
      });

      const redResult = runRelayHandshakeCli(
        mutantRelay,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(
        redResult.exit,
        0,
        "RED: with the HYK-357 value-invalid guard removed, 'for: ORCH' must silently pass again (exactly the 1R bug this test exists to catch)",
      );
      assert.equal(
        readMainLedger(mainDir),
        null,
        "even in the RED mutant, the ledger is still never written (reject-streak.mjs's own refusal to fall back is untouched) -- the bug is that this failure no longer blocks consumption",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
      rmSync(mutantDir, { recursive: true, force: true });
    }
  });

  const after2 = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after2,
    src,
    "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test",
  );
});

// re-running (a)'s exact shape one more time here (not inside the RED test)
// proves the real, un-mutated source is still GREEN after the RED test ran
// against a mutated COPY.
test("(e) 원복 후 초록 재확인: (a)와 동일한 입력을 실 소스로 다시 돌리면 여전히 소비 실패(RED 시험이 실 파일에 영향 없음)", () => {
  withTempDir("hyk357-352-2r-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeForRoleNameFixture(harnessDir, {
        taskId: "HYK-9704-review-1",
        droppedAt: "2026-08-25 20:00",
        doneAt: "2026-08-25 20:10:00",
      });
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.notEqual(result.exit, 0, "still GREEN on the real source");
      assert.match(result.stderr, /consumption rejected \(HYK-357\)/);
      assert.equal(readMainLedger(mainDir), null);
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
    "hyk357-352-2r-consumption-block.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "hyk357-352-2r-consumption-block.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
