// HYK-204 2R (반려 수리): REVIEW §A-2 실주입으로 잡은 결함 -- 승인 라운드
// 보존(`archiveApprovedRound`, review-gate.mjs)이 `archiveRoundEnvelope`를
// 부르기 *전에* 자기 자신의 `readFileSync(reviewPath)`를 한 번 더 했는데,
// 그 재읽기가 try/catch 밖이라 review.md가 사라지면 ENOENT가
// `hooks/commit-msg` 밖으로 전파돼 **이미 승인된 커밋을 막았다**
// (검토자 실측: `EXIT CODE: 1`). 이 파일은 검토자가 쓴 재현 방법 그대로
// -- 변조 사본 + 실제 `git init` 워크트리 + `archiveApprovedRound` 진입
// 직후 `review.md` 삭제(동시성 경합의 결정론적 대체) -- 를 재사용해
// (1) 수리 후에는 exit 0 + 실패가 화면에 남는지 원문 로그로 확인하고,
// (2) 그 수리를 제거/약화하는 변조 3종이 전부 RED임을 고정한다.
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
const REVIEW_GATE_PATH = join(HERE, "review-gate.mjs");
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");

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

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

// Injects a deterministic stand-in for "review.md disappears between
// checkReviewGate's own read and archiveApprovedRound's entry" --
// unlinking the file as the very first statement inside the function
// reproduces the reviewer's race window without depending on real
// concurrency/timing.
const ENTRY_MARKER = "function archiveApprovedRound(reviewPath) {\n";

function injectDeleteAtEntry(src) {
  assertExactlyOneMatch(src, ENTRY_MARKER, "archiveApprovedRound entry");
  return src.replace(
    ENTRY_MARKER,
    `${ENTRY_MARKER}  unlinkSyncInjected(reviewPath);\n`,
  );
}

function stageRepo(dir, { reviewGateSrc }) {
  const scriptsCheckDir = join(dir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  writeFileSync(
    join(scriptsCheckDir, "review-gate.mjs"),
    reviewGateSrc,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "relay-handshake.mjs"),
    readFileSync(RELAY_HANDSHAKE_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "reject-streak.mjs"),
    readFileSync(REJECT_STREAK_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "envelope-archive.mjs"),
    readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    "utf8",
  );
  return join(scriptsCheckDir, "review-gate.mjs");
}

function writeApprovedReview(dir, issueId) {
  writeFileSync(
    join(dir, ".harness", "review.md"),
    `for: ${issueId}\ntask_id: ${issueId}\nrole: REVIEW-CODEX\nverdict: approved\n\n>>> DONE: REVIEW-CODEX @ 2026-08-08 17:00 KST\n`,
    "utf8",
  );
}

function runHookLikeCli(scriptPath, commitMsgFile, cwd) {
  const res = spawnSync(process.execPath, [scriptPath, commitMsgFile], {
    encoding: "utf8",
    cwd,
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

// `unlinkSyncInjected` is prepended to every staged mutant/fixed copy so
// the injected `unlinkSyncInjected(reviewPath)` call resolves without
// touching review-gate.mjs's own import list (kept as a free function
// appended after the module's own imports, calling node:fs's unlinkSync
// under a name that can never collide with review-gate.mjs's real code).
function withUnlinkHelper(src) {
  return src.replace(
    'import { readFileSync, existsSync } from "node:fs";',
    'import { readFileSync, existsSync, unlinkSync } from "node:fs";\nfunction unlinkSyncInjected(p) { try { unlinkSync(p); } catch { /* already gone */ } }',
  );
}

const REVIEW_GATE_SRC = readFileSync(REVIEW_GATE_PATH, "utf8");

// ---------------------------------------------------------------------------
// §2-1 fix proof: current (fixed) source, entry-deletion injected -> exit 0,
// failure visible on stderr.
// ---------------------------------------------------------------------------

test("§2-1 fix: review.md deleted right as archiveApprovedRound enters -> commit-msg hook still exits 0, failure is on stderr (원문 로그)", () => {
  const fixedWithInjection = injectDeleteAtEntry(
    withUnlinkHelper(REVIEW_GATE_SRC),
  );
  const dir = mkdtempSync(join(tmpdir(), "hyk204-2r-fix-proof-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: fixedWithInjection });
    writeApprovedReview(dir, "HYK-9910");
    const commitMsgFile = join(dir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9910 -- something\n", "utf8");

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    // 원문 로그 (요구사항: "확인했다" 문장 대신 실제 종료코드/출력을 남긴다)
    console.log(
      `[HYK-204 2R §2-1 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      0,
      "the approved commit must succeed even though the archive re-read raced a deletion",
    );
    assert.match(
      result.stderr,
      /envelope-archive: failed to preserve review round/,
      "the failure must be visible on stderr, not silently swallowed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mutation ⓐ (필수): remove the try/catch protection entirely -> the old
// bug is back -> exit 1, blocking an approved commit.
// ---------------------------------------------------------------------------

test("mutation ⓐ (필수): archiveApprovedRound's try/catch guard removed -> deleted review.md again propagates ENOENT -> commit-msg hook exits 1 -> RED", () => {
  const target =
    'function archiveApprovedRound(reviewPath) {\n  try {\n    const reviewText = readFileSync(reviewPath, "utf8");\n    const outcome = archiveRoundEnvelope({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });\n    if (outcome.ok) {\n      console.log(outcome.reason);\n    } else {\n      console.error(outcome.reason);\n    }\n  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (approval re-read failed, commit NOT blocked: ${err.message})`,\n    );\n  }\n}';
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "archiveApprovedRound guarded body",
  );
  const unguarded =
    'function archiveApprovedRound(reviewPath) {\n  const reviewText = readFileSync(reviewPath, "utf8");\n  const outcome = archiveRoundEnvelope({\n    role: "review",\n    resultContent: reviewText,\n    harnessDir: dirname(reviewPath),\n  });\n  if (outcome.ok) {\n    console.log(outcome.reason);\n  } else {\n    console.error(outcome.reason);\n  }\n}';
  const mutated = REVIEW_GATE_SRC.replace(target, unguarded);

  const withInjection = injectDeleteAtEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk204-2r-mut-a-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9911");
    const commitMsgFile = join(dir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9911 -- something\n", "utf8");

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-204 2R mutation ⓐ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      1,
      "RED: without the guard, the same race blocks an already-approved commit again -- exactly the incident §2-1 fixes",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mutation ⓑ (필수): the catch block swallows the failure silently (no
// console.error) -> commit succeeds, but nobody can see the archive failed.
// ---------------------------------------------------------------------------

test("mutation ⓑ (필수): archiveApprovedRound's catch block silently swallows the failure (no console.error) -> commit succeeds but the failure is invisible -> RED", () => {
  const target =
    "  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (approval re-read failed, commit NOT blocked: ${err.message})`,\n    );\n  }\n}";
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "archiveApprovedRound catch block",
  );
  const silent = "  } catch (err) {\n    // swallowed\n  }\n}";
  const mutated = REVIEW_GATE_SRC.replace(target, silent);

  const withInjection = injectDeleteAtEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk204-2r-mut-b-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9912");
    const commitMsgFile = join(dir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9912 -- something\n", "utf8");

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-204 2R mutation ⓑ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(result.exit, 0, "commit still succeeds (that part is fine)");
    assert.doesNotMatch(
      result.stderr,
      /envelope-archive/,
      "RED: the failure is now invisible -- 'believed preserved but wasn't', the exact trap §2-1 forbids",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mutation ⓒ (자유 선택): a PARTIAL fix -- wraps only the archiveRoundEnvelope
// call, not the readFileSync above it (looks fixed, still has the hole).
// ---------------------------------------------------------------------------

test("mutation ⓒ (자유 선택): partial guard -- only wraps archiveRoundEnvelope, not the readFileSync above it -> the original hole survives -> RED", () => {
  const target =
    'function archiveApprovedRound(reviewPath) {\n  try {\n    const reviewText = readFileSync(reviewPath, "utf8");\n    const outcome = archiveRoundEnvelope({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });\n    if (outcome.ok) {\n      console.log(outcome.reason);\n    } else {\n      console.error(outcome.reason);\n    }\n  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (approval re-read failed, commit NOT blocked: ${err.message})`,\n    );\n  }\n}';
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "archiveApprovedRound guarded body",
  );
  const partiallyGuarded =
    'function archiveApprovedRound(reviewPath) {\n  const reviewText = readFileSync(reviewPath, "utf8");\n  try {\n    const outcome = archiveRoundEnvelope({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });\n    if (outcome.ok) {\n      console.log(outcome.reason);\n    } else {\n      console.error(outcome.reason);\n    }\n  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (${err.message})`,\n    );\n  }\n}';
  const mutated = REVIEW_GATE_SRC.replace(target, partiallyGuarded);

  const withInjection = injectDeleteAtEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk204-2r-mut-c-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9913");
    const commitMsgFile = join(dir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9913 -- something\n", "utf8");

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-204 2R mutation ⓒ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      1,
      "RED: guarding only the inner call and leaving the outer read unguarded reproduces the exact original hole (§A-2) even though the function LOOKS fixed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
