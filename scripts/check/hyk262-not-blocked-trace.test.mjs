// HYK-262 §3 (책임자 확정 2R): «막지 않는 2종에 흔적» -- attempted && !ok
// 이지만 표지 줄 계약 위반(AMBIGUOUS_*)이 «아닌» 두 갈래(판정 줄 0개 =
// NO_VERDICT_LINE, 원장 파일 손상 = LEDGER_INVALID_JSON 등)는 이 라운드에서
// 여전히 차단하지 않는다(HYK-266 별건, 이 라운드는 착수 금지) -- 하지만
// «이 경우는 차단하지 않았다»는 판단 자체가 소비 출력에 명시적으로 남아야
// 한다(화면 출력만으로는 부족하다는 근거 문장이 아니라, "그 판단 자체가
// 보여야 한다"는 §3 요구를 그대로 고정한다).
//
// ⛔모든 원장/영수증은 mkdtemp 합성 픽스처다 -- 실제 관제실 정본에는 절대
// 쓰지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const RELAY_HANDSHAKE_SRC = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
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
  const linkedDir = tmpDir("hyk262-nb-linked-");
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

function writeNoVerdictFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n`,
    "utf8",
  );
  // 판정 줄이 0개 -- NO_VERDICT_LINE.
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
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
// ① 판정 줄 0개(NO_VERDICT_LINE) -- 차단하지 않지만 NOT_BLOCKED 흔적이 남아야
// 한다.
// ---------------------------------------------------------------------------

test("① NO_VERDICT_LINE: 판정 줄 0개는 소비를 막지 않지만 'NOT_BLOCKED' 흔적이 reasonCode와 함께 남는다", () => {
  withRepoAndFixture((harnessDir, linkedDir) => {
    writeNoVerdictFixture(harnessDir, {
      taskId: "HYK-9800-review-1",
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
      `NO_VERDICT_LINE must NOT block consumption this round (HYK-266 범위): ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /NOT_BLOCKED/,
      "the explicit 'this case was not blocked' trace must appear in the consumption output",
    );
    assert.match(
      result.stdout,
      /reasonCode=NO_VERDICT_LINE/,
      "the trace must name which reasonCode class this is, not just a generic 'something failed'",
    );
  });
});

// ---------------------------------------------------------------------------
// ② 원장 파일 손상(LEDGER_INVALID_JSON) -- 차단하지 않지만 NOT_BLOCKED
// 흔적이 남아야 한다.
// ---------------------------------------------------------------------------

test("② LEDGER_INVALID_JSON: 원장 파일이 깨져도 소비를 막지 않지만 'NOT_BLOCKED' 흔적이 reasonCode와 함께 남는다", () => {
  withRepoAndFixture((harnessDir, linkedDir, mainDir) => {
    writeFileSync(
      join(mainDir, ".harness", "reject-streak.json"),
      "{ this is not valid JSON",
      "utf8",
    );
    writeNormalRejectFixture(harnessDir, {
      taskId: "HYK-9801-review-1",
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
      `ledger corruption must NOT block consumption this round (HYK-266 범위): ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /NOT_BLOCKED/,
      "the explicit 'this case was not blocked' trace must appear in the consumption output",
    );
    assert.match(
      result.stdout,
      /reasonCode=LEDGER_INVALID_JSON/,
      "the trace must name which reasonCode class this is",
    );
  });
});

// ---------------------------------------------------------------------------
// ③ ★RED: NOT_BLOCKED 흔적 문장 자체를 지운 변이는 위 시험들이 실패해야
// 한다 -- 이 시험이 "그 문장이 사라지면 RED가 된다"는 완료조건 6을
// 고정한다. 변이는 임시 사본에서만 만들고 실 소스는 무손상임을 단언한다.
// ---------------------------------------------------------------------------

test("③ ★RED: NOT_BLOCKED 흔적 호출을 제거한 변이는 ①의 입력에서 흔적이 사라진다(회귀 재현), 원복 후 무손상", () => {
  const target = "  traceUnblockedRecordFailure(recordOutcome);\n";
  const count = RELAY_HANDSHAKE_SRC.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (the traceUnblockedRecordFailure call site) must appear exactly once (found ${count}) -- update this test if the call site legitimately moved`,
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(target, "");

  withRepoAndFixture(
    (harnessDir, linkedDir, mainDir, mutantDir) => {
      const scriptsCheckDir = join(mutantDir, "scripts", "check");
      mkdirSync(scriptsCheckDir, { recursive: true });
      writeFileSync(
        join(scriptsCheckDir, "relay-handshake.mjs"),
        mutated,
        "utf8",
      );
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
          join(scriptsCheckDir, dep),
          readFileSync(join(HERE, dep), "utf8"),
          "utf8",
        );
      }
      const mutantRelay = join(scriptsCheckDir, "relay-handshake.mjs");

      writeNoVerdictFixture(harnessDir, {
        taskId: "HYK-9802-review-1",
        droppedAt: "2026-08-14 20:00",
        doneAt: "2026-08-14 20:10:00",
      });
      const result = runRelayHandshakeCli(mutantRelay, ["review", harnessDir], {
        cwd: linkedDir,
      });
      assert.equal(
        result.exit,
        0,
        "RED mutant still does not block (this axis is untouched by removing the trace call)",
      );
      assert.doesNotMatch(
        result.stdout,
        /NOT_BLOCKED/,
        "RED: with the trace call removed, the explicit 'not blocked' statement must be gone (the regression this test exists to catch)",
      );
    },
    { withMutantDir: true },
  );

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    RELAY_HANDSHAKE_SRC,
    "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test",
  );
});

// re-confirm the real source is still GREEN (trace present) after the RED
// mutant ran against an isolated copy.
test("(원복 후 재확인) 실 소스로 ①과 같은 입력을 다시 돌리면 여전히 NOT_BLOCKED 흔적이 남는다", () => {
  withRepoAndFixture((harnessDir, linkedDir) => {
    writeNoVerdictFixture(harnessDir, {
      taskId: "HYK-9803-review-1",
      droppedAt: "2026-08-14 20:00",
      doneAt: "2026-08-14 20:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(result.exit, 0);
    assert.match(result.stdout, /NOT_BLOCKED/);
  });
});

function withRepoAndFixture(fn, { withMutantDir = false } = {}) {
  const mainDir = tmpDir("hyk262-nb-main-");
  const mutantDir = withMutantDir ? tmpDir("hyk262-nb-mutant-") : null;
  try {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      return fn(harnessDir, linkedDir, mainDir, mutantDir);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
    if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
  }
}
