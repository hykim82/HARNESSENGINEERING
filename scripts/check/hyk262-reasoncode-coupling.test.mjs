// HYK-262 §2 (책임자 확정 2R): «결합 방식 교체» -- relay-handshake.mjs가
// reject-streak.mjs의 AMBIGUOUS-count 판정과 결합하는 값을 «사람이 읽는
// 한국어 문장을 정규식으로 맞추는 방식»에서 «안 바뀌는 사유 코드
// (REJECT_STREAK_REASON_CODE 열거형)로 맞추는 방식»으로 교체했다(1R 검토
// 실측: 문구를 한 글자 바꾸면 차단이 조용히 죽었다). 이 파일은 책임자가
// 요구한 두 변이 시험을 «둘 다» 실행해 그 교체가 실제로 효과가 있음을
// 증명한다:
//
//   ⓐ 사람이 읽는 문구만 바꾼 변이 -> 차단은 그대로 살아 있어야 한다(GREEN)
//   ⓑ 결합 값(사유 코드) 자체를 바꾼 변이 -> 빨간불(RED)
//
// ⛔변이는 mkdtemp 임시 사본에서만 만든다 -- 실 소스 파일(reject-streak.mjs/
// relay-handshake.mjs)은 이 파일 전체에서 단 한 번도 쓰기 대상이 아니고,
// 각 시험 끝에 바이트 단위 무손상을 단언한다.
import { test } from "node:test";
import assert from "node:assert/strict";
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
const RELAY_HANDSHAKE_SRC = readFileSync(
  join(HERE, "relay-handshake.mjs"),
  "utf8",
);
const REJECT_STREAK_SRC = readFileSync(join(HERE, "reject-streak.mjs"), "utf8");

// checkRelayHandshake's own dependency set for an isolated fixture (mirrors
// hyk262-consumption-reject.test.mjs test (c)'s exact list).
const SIBLING_DEPS = [
  "envelope-archive.mjs",
  "time-authority.mjs",
  "admission-completion-adapter.mjs",
  "consumption-receipt-writer.mjs",
  "consumption-receipt-core.mjs",
  // HYK-302/355 §2-A dedup: relay-handshake.mjs (spawned as this fixture's
  // real CLI entry point, unlike admission-completion-adapter.mjs which is
  // only ever spawned as a child that already tolerates MODULE_NOT_FOUND)
  // now statically imports this shared module -- its own load must succeed.
  "ledger-pointer-shared.mjs",
];

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
  const linkedDir = tmpDir("hyk262-rc-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  return linkedDir;
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

// The exact 2026-08-14 실사고 shape: `for:` appears twice, so
// parseReviewOutcome takes the AMBIGUOUS_FOR_LINE branch.
function writeDoubleForFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nfor: ORCH\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\n`,
    "utf8",
  );
}

// Builds one isolated fixture dir with a (possibly mutated) reject-streak.mjs
// and the real (unmutated) relay-handshake.mjs + its other siblings, wired
// so relay-handshake.mjs's `import ... from "./reject-streak.mjs"` resolves
// to the mutant copy sitting right next to it.
//
// relay-handshake.mjs's own CLI entry point gates on
// `process.argv[1].endsWith("scripts/check/relay-handshake.mjs")` -- the
// fixture directory tree must therefore end in that exact suffix, not just
// contain a same-named file, or the CLI block never runs at all (silently
// exits 0 with empty stdout/stderr, which looks deceptively like "the guard
// was bypassed" if this detail is missed).
function buildFixture(mutantDir, rejectStreakText) {
  const scriptsCheckDir = join(mutantDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  writeFileSync(
    join(scriptsCheckDir, "relay-handshake.mjs"),
    RELAY_HANDSHAKE_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "reject-streak.mjs"),
    rejectStreakText,
    "utf8",
  );
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(scriptsCheckDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  return join(scriptsCheckDir, "relay-handshake.mjs");
}

function runFixtureRound(relayPath) {
  return withRepoAndFixture((harnessDir, linkedDir) => {
    writeDoubleForFixture(harnessDir, {
      taskId: "HYK-9700-review-1",
      droppedAt: "2026-08-14 20:00",
      doneAt: "2026-08-14 20:10:00",
    });
    return runRelayHandshakeCli(relayPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
  });
}

function withRepoAndFixture(fn) {
  const mainDir = tmpDir("hyk262-rc-main-");
  try {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      return fn(harnessDir, linkedDir);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ⓐ 사람이 읽는 문구만 바꾼 변이 -> 차단은 그대로 살아 있어야 한다(GREEN)
// ---------------------------------------------------------------------------

test("ⓐ★GREEN: reject-streak.mjs의 사람이 읽는 한국어 문구만 바꿔도(reasonCode는 그대로) 차단은 살아 있다", () => {
  const wordingTarget =
    "reject-streak record: UNJUDGABLE -- 'for:' 줄이 ${forMatches.length}개라 어느 것이 최종인지 결정할 수 없다";
  assert.ok(
    REJECT_STREAK_SRC.includes(wordingTarget),
    "mutation target wording string must exist verbatim in the current source -- update this test if the wording legitimately changed",
  );
  // 문구만 완전히 다른 문장으로 바꾼다 -- reasonCode 필드/값은 절대 건드리지
  // 않는다(바로 이것이 "1R에서 차단을 죽였던" 변경과 이번 변이의 차이).
  const rewordedWording =
    "reject-streak record: UNJUDGABLE -- 'for:' line count is ${forMatches.length}, cannot pick a final one (REWORDED FOR TEST)";
  const mutated = REJECT_STREAK_SRC.split(wordingTarget).join(rewordedWording);
  assert.notEqual(
    mutated,
    REJECT_STREAK_SRC,
    "wording mutation must actually change the source",
  );

  const mutantDir = tmpDir("hyk262-rc-mutant-a-");
  try {
    const relayPath = buildFixture(mutantDir, mutated);
    const result = runFixtureRound(relayPath);
    assert.notEqual(
      result.exit,
      0,
      `ⓐ GREEN: wording-only mutation must NOT disarm the block (stdout=${result.stdout} stderr=${result.stderr})`,
    );
    assert.match(
      result.stderr,
      /consumption rejected \(HYK-262\)/,
      "the reasonCode-based block must still fire even though the underlying Korean sentence changed",
    );
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }

  assert.equal(
    readFileSync(join(HERE, "reject-streak.mjs"), "utf8"),
    REJECT_STREAK_SRC,
    "원복 증명: the real reject-streak.mjs must be byte-identical before/after this test",
  );
  assert.equal(
    readFileSync(join(HERE, "relay-handshake.mjs"), "utf8"),
    RELAY_HANDSHAKE_SRC,
    "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test",
  );
});

// ---------------------------------------------------------------------------
// ⓑ 결합 값(사유 코드) 자체를 바꾼 변이 -> 빨간불(RED)
// ---------------------------------------------------------------------------

test("ⓑ★RED: reject-streak.mjs의 결합 값(reasonCode) 자체를 바꾸면 차단이 깨진다", () => {
  const codeTarget =
    "reasonCode: REJECT_STREAK_REASON_CODE.AMBIGUOUS_FOR_LINE,";
  const count = REJECT_STREAK_SRC.split(codeTarget).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (the AMBIGUOUS_FOR_LINE reasonCode assignment) must appear exactly once in the current source (found ${count}) -- update this test if the source legitimately changed`,
  );
  // 오직 결합 값만 바꾼다(사람이 읽는 reason 문장은 그대로 둔다) -- 그 결과
  // relay-handshake.mjs의 AMBIGUOUS_COVER_REASON_CODES 집합과 더 이상
  // 일치하지 않아 차단이 깨져야 한다.
  const mutated = REJECT_STREAK_SRC.split(codeTarget).join(
    'reasonCode: "SOME_OTHER_CODE_NOT_IN_THE_BLOCK_SET",',
  );
  assert.notEqual(
    mutated,
    REJECT_STREAK_SRC,
    "reasonCode mutation must actually change the source",
  );

  const mutantDir = tmpDir("hyk262-rc-mutant-b-");
  try {
    const relayPath = buildFixture(mutantDir, mutated);
    const result = runFixtureRound(relayPath);
    assert.equal(
      result.exit,
      0,
      `ⓑ RED: changing the coupling value (reasonCode) breaks the block -- the exact 2026-08-14 shape silently passes again (stdout=${result.stdout} stderr=${result.stderr})`,
    );
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }

  assert.equal(
    readFileSync(join(HERE, "reject-streak.mjs"), "utf8"),
    REJECT_STREAK_SRC,
    "원복 증명: the real reject-streak.mjs must be byte-identical before/after this test",
  );
  assert.equal(
    readFileSync(join(HERE, "relay-handshake.mjs"), "utf8"),
    RELAY_HANDSHAKE_SRC,
    "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test",
  );
});

// re-confirm the real (unmutated) pair is still GREEN after both mutant
// rounds ran against isolated copies -- proves neither RED nor GREEN
// mutation test above ever touched the real files' own behavior.
test("(원복 후 초록 재확인) 실 소스로 같은 fixture를 다시 돌리면 여전히 소비 실패", () => {
  const result = runFixtureRound(join(HERE, "relay-handshake.mjs"));
  assert.notEqual(
    result.exit,
    0,
    "still GREEN on the real, unmutated source pair",
  );
});
