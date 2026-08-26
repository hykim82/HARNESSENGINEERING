// HYK-262: «표지 줄 계약 위반의 조용한 미기록» -- checkRelayHandshake가
// REVIEW-family 결과 파일의 reject-streak 원장 기록을 «시도했으나 실패»
// (attempted:true, ok:false, 사유가 정확히 "어느 것이 최종인지 결정할 수
// 없다"인 AMBIGUOUS-count 표지 줄 계약 위반 -- for:/task_id:/판정 줄이 2개
// 이상)했을 때, 소비 자체를 실패시키는지(종료코드 0 아님 · 영수증 미발행 ·
// 보관 미실시) 직접 고정한다.
//
// ⛔실사고(2026-08-14): 검토자가 `for:` 줄을 2개(그중 하나가 `for: ORCH`)
// 써서 반려가 원장에 기입되지 않았는데, 소비는 그대로 성공(exit 0)했고
// 게이트 2(연속반려)가 조용히 무장 해제됐다. 이 파일의 (a)가 그 정확한
// 재현 fixture다(완료조건 4).
//
// ⛔모든 원장/영수증은 mkdtemp 합성 픽스처다 -- 실제 관제실 정본에는
// 절대 쓰지 않는다(reject-streak-auto-record.test.mjs의 initPlainGitRepo/
// addLinkedWorktree 관용구를 그대로 재사용).
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
  const linkedDir = tmpDir("hyk262-linked-");
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

function writeDoubleForFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n`,
    "utf8",
  );
  // ★2026-08-14 실사고 그대로: `for:` 줄이 2개(하나는 `for: ORCH`) -- 어느
  // 것이 최종인지 결정할 수 없는 AMBIGUOUS-count 표지 줄 계약 위반.
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nfor: ORCH\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

function writeNormalRejectFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// (a)★ 완료조건 1+4: 2026-08-14 실사고 재현 fixture(`for:` 줄 2개, 그중
// 하나가 `for: ORCH`)가 소비를 실패시킨다 -- 종료코드 0 아님, 원장 미기록,
// 영수증 미발행, 보관 미실시(rounds/ 디렉터리 자체가 생기지 않음).
// ---------------------------------------------------------------------------

test("(a)★ 2026-08-14 실사고 재현: 'for:' 줄 2개(하나는 'for: ORCH') -> 소비 실패, 원장 미기록, 영수증 미발행, 보관 미실시", () => {
  withTempDir("hyk262-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeDoubleForFixture(harnessDir, {
        taskId: "HYK-9600-review-1",
        droppedAt: "2026-08-14 20:00",
        doneAt: "2026-08-14 20:10:00",
      });

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );

      assert.notEqual(
        result.exit,
        0,
        `consumption must fail (nonzero exit) on the ambiguous-'for:' shape: stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /consumption rejected \(HYK-262\)/,
        "the rejection reason must name this HYK-262 gate, not get lost in an unrelated failure",
      );
      assert.match(
        result.stderr,
        /어느 것이 최종인지 결정할 수 없다/,
        "the underlying reject-streak UNJUDGABLE reason must still be visible",
      );

      assert.equal(
        readMainLedger(mainDir),
        null,
        "the ledger must never be created -- the exact 2026-08-14 실사고 gap (record attempted but failed, nothing recorded)",
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
// (b) 회귀 0 대조군: 정상적인 단일 'for:' 줄 반려는 여전히 소비/원장 기록
// 둘 다 정상 동작한다(이 축은 손대지 않았다는 증거).
// ---------------------------------------------------------------------------

test("(b) 회귀 0 대조군: 정상(단일 'for:' 줄) 반려는 여전히 소비 성공 + 원장 streak=1", () => {
  withTempDir("hyk262-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeNormalRejectFixture(harnessDir, {
        taskId: "HYK-9601-review-1",
        droppedAt: "2026-08-14 20:00",
        doneAt: "2026-08-14 20:10:00",
      });

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );

      assert.equal(
        result.exit,
        0,
        `a genuine, unambiguous reject must still consume normally: ${result.stderr}`,
      );
      const ledger = readMainLedger(mainDir);
      assert.ok(ledger, "main repo ledger must have been created");
      assert.equal(ledger.issues["HYK-9601"].streak, 1);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) ★RED 시험: 완료조건 3 -- HYK-262가 추가한 early-return 차단을
// 소스에서 제거하면(변이), 바로 (a)와 똑같은 입력이 다시 «미기록인데
// 소비가 성공»으로 돌아간다는 것을 실제로 실행해 빨간불로 확인한다.
// 원복 증명: 실 소스 파일은 이 시험 내내 메모리 문자열로만 다뤄지고,
// 디스크에 쓰이는 것은 tmp 디렉터리 사본뿐이다(전후 바이트 동일 단언).
// ---------------------------------------------------------------------------

test("(c)★ RED: HYK-262 차단 코드를 제거한 변이는 (a)와 같은 입력에서 소비를 성공시킨다(회귀 재현), 원복 후 다시 초록", () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  const coverViolation = checkAmbiguousCoverViolation(recordOutcome);\n" +
    "  if (coverViolation) return coverViolation;\n";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (the isAmbiguousCoverViolation early-return block) must appear exactly once in the current working-tree source (found ${count}) -- if this fails after an unrelated edit, update the target string, do not skip the RED test`,
  );
  const mutated = src.replace(target, "");

  withTempDir("hyk262-red-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    const mutantDir = tmpDir("hyk262-red-mutant-");
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
      writeDoubleForFixture(harnessDir, {
        taskId: "HYK-9602-review-1",
        droppedAt: "2026-08-14 20:00",
        doneAt: "2026-08-14 20:10:00",
      });

      const redResult = runRelayHandshakeCli(
        mutantRelay,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(
        redResult.exit,
        0,
        "RED: with the HYK-262 guard removed, the exact 2026-08-14 shape must silently pass again (the regression this test exists to catch)",
      );
      assert.equal(
        readMainLedger(mainDir),
        null,
        "even in the RED mutant, the ledger is still never written (reject-streak.mjs itself is untouched) -- the bug is that this silent non-record no longer blocks consumption",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
      rmSync(mutantDir, { recursive: true, force: true });
    }
  });

  // 원복 증명: 실 소스 파일은 한 번도 쓰기 대상이 아니었다.
  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test",
  );
});

// re-running the (a) fixture's exact shape one more time here (not inside
// the RED test) proves the real, un-mutated source is still GREEN after the
// RED test ran against a mutated COPY -- i.e. the RED test never touched the
// real file's own behavior.
test("(d) 원복 후 초록 재확인: (a)와 동일한 입력을 실 소스로 다시 돌리면 여전히 소비 실패(RED 시험이 실 파일에 영향 없음)", () => {
  withTempDir("hyk262-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeDoubleForFixture(harnessDir, {
        taskId: "HYK-9603-review-1",
        droppedAt: "2026-08-14 20:00",
        doneAt: "2026-08-14 20:10:00",
      });
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.notEqual(result.exit, 0, "still GREEN on the real source");
      assert.equal(readMainLedger(mainDir), null);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// role-scoping 대조군: CODER/VERIFY(non-REVIEW-family)는 같은 모양의
// 'for:' 중복이 있어도 (there's no verdict/for concept for them, but this
// guards the isReviewFamilyRole gate itself) 이 축의 영향을 받지 않는다.
test("(e) role 대조군: CODER 핸드셰이크는 이 축과 무관하게 정상 통과한다(attempted:false 경로 회귀 없음)", () => {
  withTempDir("hyk262-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, "coder-task.md"),
        "task_id: HYK-9604-coder-1\ndropped_at: 2026-08-14 20:00 KST\n",
        "utf8",
      );
      writeFileSync(
        join(harnessDir, "coder.md"),
        "task_id: HYK-9604-coder-1\n\n>>> DONE: CODER @ 2026-08-14 20:10:00 KST\n",
        "utf8",
      );
      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["coder", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(
        result.exit,
        0,
        `CODER handshake must still pass: ${result.stderr}`,
      );
      assert.equal(
        readMainLedger(mainDir),
        null,
        "CODER never touches the ledger",
      );
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
    "hyk262-consumption-reject.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "hyk262-consumption-reject.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
