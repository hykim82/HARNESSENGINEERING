// HYK-355 §2/§C: pins the isolation-default fix for the reject-streak
// ledger write inside relay-handshake.mjs's autoRecordRejectStreak.
//
// §0/§1 실사고 (2026-08-26): a worker ran a probe against this exact write
// path without `cd`-ing into an isolated fixture first -- `mainRepoRoot()`
// resolved off the probe process's own cwd (which defaulted to the real
// repo checkout), and a fabricated entry landed in the REAL
// `.harness/reject-streak.json` (HYK-357 칸 1->2). Unlike
// admission-completion-adapter.mjs (which already had HYK-312's own
// isInsideGitWorktree gate before this round), relay-handshake.mjs's own
// reject-streak write had ZERO isolation gate at all -- this file pins the
// new gate this round adds (relay-handshake.mjs's own isInsideGitWorktree +
// autoRecordRejectStreak change).
//
// §2-2 비타협 (reject-streak-auto-record.test.mjs와 동일 규율): the real
// `.harness/reject-streak.json`은 절대 건드리지 않는다 -- 모든 시험은
// 저장소 밖 mkdtemp에 완전히 합성된 main 저장소(+ 필요시 링크드 워크트리)를
// 만들어 그 안에서만 CLI를 실행한다. 이 파일 자신의 헬퍼는 그 파일의
// initPlainGitRepo/addLinkedWorktree/writeReviewFixture 관용구를 재사용하지
// 않고(무접촉 대상 목록에 없는 파일이라 import는 가능하지만, 그 파일
// 자체가 §0에서 다루는 위험한 표면과 이름이 겹치는 실수를 피하기 위해)
// 이 파일 안에 독립적으로 다시 작성했다 -- 이 저장소 전체가 이미 쓰는
// "작은 헬퍼는 파일마다 복제한다" 관례(admission-completion-adapter.mjs
// 헤더 참조) 그대로.
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

// HYK-355: reads the LIVE working-tree file (not `git show HEAD:...`, unlike
// relay-handshake.test.mjs's own M1-M3 fixtures) precisely because this
// round's own fix has not been committed yet when this file is first run --
// the mutation test below (c) must mutate the code as it actually stands on
// disk right now, not a stale committed snapshot.
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

// A fully synthetic bare-bones repo, entirely outside this real repo --
// plays the role of "the real main repo" for these tests (mainRepoRoot()
// must never resolve to anything real).
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

// A genuine `git worktree add` linked worktree of `mainDir` -- the shape a
// REAL round's own `.harness/` actually lives in.
function addLinkedWorktree(mainDir) {
  const linkedDir = tmpDir("hyk355-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  return linkedDir;
}

// HYK-383: REVIEW 계열 소비는 이제 head_commit: 축(축 ⓐ+ⓑ)도 통과해야
// 한다 -- harnessDir가 진짜 (링크드) 워크트리 안이면(test (b)) 그 실제
// HEAD를 head_commit:으로 적어 넣고, probeDir처럼 애초에 git 워크트리가
// 아니면(§0 실사고 재현, test (a)/(c)/(d)) head_commit 표지를 아예 쓰지
// 않는다 -- 그 경우는 head_commit 축 자신이 "git 조회 실패"로 이미 더
// 강하게 거부한다(아래 test (a) 참조, HYK-355의 좁은 보호를 흡수한다).
function writeReviewFixture(
  harnessDir,
  { taskId, verdict, droppedAt, doneAt },
) {
  mkdirSync(harnessDir, { recursive: true });
  let headCommitLine = "";
  try {
    headCommitLine = `head_commit: ${git(harnessDir, ["rev-parse", "HEAD"])}\n`;
  } catch {
    // probeDir 재현: 어떤 git 워크트리에도 속하지 않는다 -- 의도적으로
    // head_commit 표지를 남기지 않는다.
  }
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n${headCommitLine}`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: ${verdict}\nrole: REVIEW-CODEX\n${headCommitLine}\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
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

function writeMutantRelayHandshake(mutatedSrc) {
  const rootDir = tmpDir("hyk355-mutant-");
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

// HYK-355: byte-identical quote of the gate this round adds to
// autoRecordRejectStreak (relay-handshake.mjs) -- test (c) below deletes
// exactly this block from a disk copy to prove it (not chance) is what
// blocks the probe scenario.
const GATE_TARGET =
  "  if (isReviewFamilyRole(role) && !isInsideGitWorktree(harnessDir)) {\n" +
  "    const blocked = {\n" +
  "      attempted: false,\n" +
  "      blocked: true,\n" +
  '      reasonCode: "UNISOLATED_HARNESS_DIR",\n' +
  "      reason: `reject-streak auto-record: refusing mainRepoRoot() default -- harnessDir '${harnessDir}' is not inside a registered git worktree (probe/experiment consumption context without an isolated ledger path) -- see HYK-355`,\n" +
  "    };\n" +
  "    console.error(blocked.reason);\n" +
  "    return blocked;\n" +
  "  }\n";

test("HYK-355 (a)★ 실측 재현 고정 (HYK-383로 갱신): probe harnessDir가 어떤 git worktree에도 속하지 않으면 -- 이제 head_commit 축(HYK-383 축 ⓑ)이 라운드 자체를 거부한다(더 넓은 보호가 HYK-355의 좁은 보호를 흡수), 가짜 항목은 여전히 미착지", () => {
  const mainDir = tmpDir("hyk355-main-");
  const probeDir = tmpDir("hyk355-probe-scratch-");
  try {
    initPlainGitRepo(mainDir);
    // probeDir는 절대 `git init`되지 않는다 -- §0 실사고의 정확한 모양
    // ("워커가 cd 없이 탐침을 돌려 mainRepoRoot()가 process.cwd()로 풀림").
    writeReviewFixture(probeDir, {
      taskId: "HYK-9700-review-1",
      verdict: "rejected",
      droppedAt: "2026-08-26 09:00",
      doneAt: "2026-08-26 09:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", probeDir],
      { cwd: mainDir }, // "cd 없이" = cwd가 (합성) 실물 repo에 남아 있음
    );
    // HYK-383: probeDir가 애초에 git 워크트리가 아니므로 head_commit 표지를
    // 못 쓴다(writeReviewFixture 자신의 try/catch) -- head_commit 축이
    // "표지 부재"로 라운드 전체를 거부한다. 이 축은 REVIEW-family
    // harnessDir가 real git worktree 안인지를 항상 먼저 확인하므로(축 ⓑ),
    // reject-streak 전용이던 이 gate(HYK-355)에 도달하는 모든 경로는 이제
    // 그 전에 이미 막힌다 -- 아래 (c)/(d)는 그 사실과 별개로 HYK-355
    // 자신의 방어선이 여전히 올바른지를(head_commit 축을 함께 무력화한
    // 채로) 독립적으로 증명한다.
    assert.notEqual(
      result.exit,
      0,
      `probe harnessDir must now be rejected at the round level (HYK-383): ${result.stderr}`,
    );
    assert.match(result.stderr, /missing head_commit header/);
    assert.equal(
      readMainLedger(mainDir),
      null,
      "no fabricated entry may land in the cwd-resolved ledger",
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test("HYK-355 (b) 정당한 실물 기록 회귀 0: harnessDir가 실제로 링크드 워크트리 안에 있으면 -> 원장 기록은 이전과 동일하게 성공한다", () => {
  const mainDir = tmpDir("hyk355-main-");
  try {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9701-review-1",
        verdict: "rejected",
        droppedAt: "2026-08-26 09:00",
        doneAt: "2026-08-26 09:10:00",
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
        /reject-streak auto-record:.*HYK-9701.*streak=1/,
      );
      const ledger = readMainLedger(mainDir);
      assert.ok(
        ledger,
        "main repo ledger must have been created (legitimate consumption unaffected)",
      );
      assert.equal(ledger.issues["HYK-9701"].streak, 1);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

// HYK-383: axis ⓑ(head_commit 실물 대조)가 이제 이 GATE_TARGET(HYK-355)에
// 도달하는 모든 REVIEW-family 경로보다 앞서 harnessDir가 real git worktree
// 안인지를 이미 확인한다(더 넓은 보호, 위 test (a) 참조) -- 그 결과
// probeDir(비-워크트리) 시나리오는 GATE_TARGET에 아예 도달하지 못하게
// 됐다(HYK-355의 좁은 보호는 REVIEW-family에 한해 사실상 도달 불가/죽은
// 코드가 됐다 -- ORCH에게 별도로 보고). 아래 (c)/(d)는 그럼에도 GATE_TARGET
// 자신이 «독립적으로»(axis ⓑ 없이 격리했을 때) 여전히 올바른지를
// 증명한다(defense-in-depth) -- 그래서 GATE_TARGET과 함께 axis ⓑ의
// checkRelayHandshake 호출부도 걷어내 원래 HYK-355가 겨냥했던 정확히 그
// 격리 조건을 재현한다.
const HEAD_COMMIT_AXIS_CALL_TARGET =
  "  const headCommitVerdict = resolveHeadCommitBinding({\n" +
  "    role,\n" +
  "    taskContent,\n" +
  "    resultContent,\n" +
  "    harnessDir,\n" +
  "  });\n" +
  "  if (!headCommitVerdict.ok) return headCommitVerdict;\n";

test("HYK-355 (c) 변이 검사 ① (axis ⓑ를 격리한 채로): 게이트를 디스크에서 실제로 지우면 -> probe 시나리오가 (합성) 원장에 기록된다 (RED, HYK-355 게이트 자신이 defense-in-depth로 여전히 올바르다는 증거)", () => {
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_LIVE_SRC,
    GATE_TARGET,
    "HYK-355 isolation gate",
  );
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_LIVE_SRC,
    HEAD_COMMIT_AXIS_CALL_TARGET,
    "HYK-383 head_commit axis call site",
  );
  const mutated = RELAY_HANDSHAKE_LIVE_SRC.replace(GATE_TARGET, "").replace(
    HEAD_COMMIT_AXIS_CALL_TARGET,
    "",
  );
  const { rootDir, mutantPath } = writeMutantRelayHandshake(mutated);
  const mainDir = tmpDir("hyk355-mutant-main-");
  const probeDir = tmpDir("hyk355-mutant-probe-");
  try {
    initPlainGitRepo(mainDir);
    writeReviewFixture(probeDir, {
      taskId: "HYK-9702-review-1",
      verdict: "rejected",
      droppedAt: "2026-08-26 09:00",
      doneAt: "2026-08-26 09:10:00",
    });
    const result = runRelayHandshakeCli(mutantPath, ["review", probeDir], {
      cwd: mainDir,
    });
    assert.equal(result.exit, 0, `mutant handshake: ${result.stderr}`);
    const ledger = readMainLedger(mainDir);
    assert.ok(
      ledger && ledger.issues["HYK-9702"],
      "RED: with the gate physically removed, the probe's fabricated entry DOES land in the cwd-resolved ledger -- the live gate (test (a) above), not chance, is what protects it",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test("HYK-355 (d) 변이 검사 ② (axis ⓑ를 격리한 채로): GATE_TARGET만 원복하면 -> 같은 probe 시나리오가 다시 초록(HYK-355 게이트가 기록을 거부)이다", () => {
  // ⛔"라이브 소스 그대로"가 아니다 -- HYK-383의 axis ⓑ가 그대로면
  // probeDir는 GATE_TARGET에 도달하기도 전에 이미 거부된다(위 test (a)가
  // 바로 그것을 고정한다). 여기서는 (c)와 같은 격리(axis ⓑ 호출부 제거)를
  // 유지한 채 GATE_TARGET만 복원해 -- HYK-355 게이트 자신의 RED/GREEN
  // 대비가 여전히 유효하다는 것만 좁게 증명한다.
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_LIVE_SRC,
    HEAD_COMMIT_AXIS_CALL_TARGET,
    "HYK-383 head_commit axis call site",
  );
  const isolated = RELAY_HANDSHAKE_LIVE_SRC.replace(
    HEAD_COMMIT_AXIS_CALL_TARGET,
    "",
  );
  const { rootDir, mutantPath } = writeMutantRelayHandshake(isolated);
  const mainDir = tmpDir("hyk355-restored-main-");
  const probeDir = tmpDir("hyk355-restored-probe-");
  try {
    initPlainGitRepo(mainDir);
    writeReviewFixture(probeDir, {
      taskId: "HYK-9703-review-1",
      verdict: "rejected",
      droppedAt: "2026-08-26 09:00",
      doneAt: "2026-08-26 09:10:00",
    });
    const result = runRelayHandshakeCli(mutantPath, ["review", probeDir], {
      cwd: mainDir,
    });
    assert.equal(result.exit, 0, `restored handshake: ${result.stderr}`);
    assert.match(
      result.stderr,
      /reject-streak auto-record: refusing mainRepoRoot\(\) default/,
    );
    assert.equal(
      readMainLedger(mainDir),
      null,
      "GREEN: restoring the live (unmutated) HYK-355 gate blocks the write again",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
});
