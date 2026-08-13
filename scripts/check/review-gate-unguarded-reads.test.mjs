// HYK-205 1R: two unguarded re-reads survived the HYK-204 2R fix (that round
// only closed archiveApprovedRound's own readFileSync). §1 of the drop
// re-confirmed both, still present at base 9551635:
//   #1 checkReviewGate's own `readFileSync(reviewPath, "utf8")` (right after
//      the `existsSync` guard) -- the gate's JUDGMENT read.
//   #2 recordApprovalToLedger's `readFileSync(reviewPath, "utf8")` -- a
//      RECORD re-read, structurally identical to archiveApprovedRound's
//      already-fixed one.
// §2's decision (see the block comments left in review-gate.mjs at each
// site): #1 BLOCKS on read failure -- "the gate couldn't read the evidence"
// is indistinguishable from "there is no evidence", and this repo has
// repeatedly treated fail-open here as a defect (HYK-183's ambiguous-verdict
// handling). #2 degrades to a logged, non-blocking failure, mirroring the
// HYK-204 contract already proven for archiveApprovedRound: recording is a
// side effect of an already-decided approval, not the decision itself.
//
// This file proves both directions with real injected failures (not
// "confirmed by inspection" prose) and locks each contract with mutation
// tests that must go RED when weakened.
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
import {
  computeFingerprint,
  formatBindingBlock,
} from "./review-approval-binding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_GATE_PATH = join(HERE, "review-gate.mjs");
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");
// HYK-186: relay-handshake.mjs now also imports "./time-authority.mjs" (the
// future-skew registry) -- same MODULE_NOT_FOUND risk reject-streak.mjs's/
// envelope-archive.mjs's own copies above already exist to avoid, now for a
// third sibling.
const TIME_AUTHORITY_PATH = join(HERE, "time-authority.mjs");
// HYK-240: review-gate.mjs now also imports "./review-approval-binding.mjs"
// (approval<->code-state binding check) -- same MODULE_NOT_FOUND risk as
// the siblings above, now for a fourth.
const REVIEW_APPROVAL_BINDING_PATH = join(HERE, "review-approval-binding.mjs");

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
  writeFileSync(
    join(scriptsCheckDir, "time-authority.mjs"),
    readFileSync(TIME_AUTHORITY_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "review-approval-binding.mjs"),
    readFileSync(REVIEW_APPROVAL_BINDING_PATH, "utf8"),
    "utf8",
  );
  // HYK-240 2R: stage the harness scaffold itself -- in the real repo
  // scripts/check/ is tracked (part of HEAD), so this never shows up as an
  // "unstaged change" there. Leaving these copies untracked here would make
  // review-approval-binding.mjs's new index<->worktree sync check (F1 fix)
  // see them as desynced on every test in this file, regardless of what
  // the test itself is actually exercising.
  git(dir, ["add", "-A"]);
  return join(scriptsCheckDir, "review-gate.mjs");
}

// HYK-240: an approval with no binding-fingerprint now fails fail-closed
// ("결속 없음"), so tests exercising the SUCCESS path must record one that
// matches `dir`'s state at the moment the CLI actually runs. `writeCommitMsg`
// below writes the message file OUTSIDE `dir` specifically so calling this
// AFTER staging (and before/after writeCommitMsg, order no longer matters)
// still measures exactly what review-gate.mjs will measure at CLI time.
function writeApprovedReview(dir, issueId) {
  const fp = computeFingerprint({ cwd: dir });
  assert.equal(
    fp.ok,
    true,
    `fingerprint must be computable in ${dir}: ${fp.reason}`,
  );
  const binding = formatBindingBlock({
    fingerprint: fp.fingerprint,
    entries: fp.entries,
  });
  writeFileSync(
    join(dir, ".harness", "review.md"),
    `for: ${issueId}\ntask_id: ${issueId}\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-08 17:45 KST\n`,
    "utf8",
  );
}

// HYK-240: production's real commit-message file lives under `.git/`
// (outside the working tree `git status` scans), so mirror that here --
// writing it inside `dir` would make it show up as an untracked file and
// shift the fingerprint computed above.
function writeCommitMsg(dir, subject) {
  const msgDir = mkdtempSync(join(tmpdir(), "hyk205-commit-msg-"));
  const p = join(msgDir, "commit-msg.txt");
  writeFileSync(p, `${subject}\n`, "utf8");
  return p;
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

const REVIEW_GATE_SRC = readFileSync(REVIEW_GATE_PATH, "utf8");
const FIXED_REASON_SNIPPET =
  "the gate cannot verify approval and blocks -- fix or restore the file";

// =============================================================================
// SITE #1 -- checkReviewGate's own read (§2 judgment: BLOCKS, controlled)
// =============================================================================
//
// Real repro (no mutation needed for the fix-proof case): `existsSync`
// returns true for a DIRECTORY too, so making `.harness/review.md` a
// directory instead of a file reproduces EISDIR through the real
// existsSync-then-readFileSync race without any synthetic injection --
// exactly the reviewer's suggested method (§4: "EISDIR 유발").

function makeReviewPathADirectory(dir) {
  mkdirSync(join(dir, ".harness", "review.md"), { recursive: true });
}

test("§1 fix proof: review.md is a directory (real EISDIR) -> commit-msg hook still exits non-zero (blocks, as designed), but now with a controlled actionable reason instead of a raw uncaught stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site1-fix-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: REVIEW_GATE_SRC });
    makeReviewPathADirectory(dir);
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9920 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §1 fix 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(result.exit, 1, "unreadable evidence must block the commit");
    assert.match(
      result.stderr,
      new RegExp(FIXED_REASON_SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the block must carry the controlled, actionable reason -- not a bare Node stack trace",
    );
    assert.doesNotMatch(
      result.stderr,
      /at Object\.readFileSync|node:internal/,
      "no raw Node internals/stack-trace noise should leak to stderr once the read is guarded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§1 pre-fix behavior (원문 로그, base 9551635 unguarded read): review.md is a directory -> uncaught EISDIR crashes the hook with a raw Node stack trace, exit still non-zero but NOT the controlled reason", () => {
  const UNGUARDED_SRC = REVIEW_GATE_SRC.replace(
    `  // HYK-205: existsSync passing does not guarantee readFileSync succeeds
  // (TOCTOU race, EISDIR, permissions) -- this read is the gate's own
  // judgment of the evidence, not a side-effect record (contrast
  // recordApprovalToLedger/archiveApprovedRound below, which degrade to a
  // logged non-block). "gate couldn't read the evidence" is
  // indistinguishable from "there is no evidence" -- treating it as a pass
  // would be fail-open, which this repo has repeatedly treated as a defect
  // (HYK-183's ambiguous-verdict handling took the same stance). So this
  // blocks, same as the not-found branch just above, but through a
  // controlled return instead of letting the exception escape uncaught
  // into hooks/commit-msg's exit code.
  let content;
  try {
    content = readFileSync(reviewPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: \`review file unreadable: \${reviewPath} (\${err.message}); the gate cannot verify approval and blocks -- fix or restore the file (e.g. re-run the review step), then retry the commit\`,
    };
  }`,
    `  const content = readFileSync(reviewPath, "utf8");`,
  );
  assert.notEqual(
    UNGUARDED_SRC,
    REVIEW_GATE_SRC,
    "the guarded-read snippet must have matched and been replaced",
  );
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site1-prefix-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: UNGUARDED_SRC });
    makeReviewPathADirectory(dir);
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9921 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §1 pre-fix 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.notEqual(
      result.exit,
      0,
      "the pre-fix code also blocked (by accident, via an uncaught crash)",
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(FIXED_REASON_SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "pre-fix: no controlled reason exists -- only a raw crash",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mutation ⓐ (필수): remove the guard entirely -> back to the pre-fix raw
// crash (still blocks by accident, but loses the controlled/actionable
// message -- RED on the message assertion).
test("mutation ⓐ (필수): site #1 guard removed -> EISDIR crashes uncaught again, controlled reason is gone -> RED", () => {
  const target =
    '  // HYK-205: existsSync passing does not guarantee readFileSync succeeds\n  // (TOCTOU race, EISDIR, permissions) -- this read is the gate\'s own\n  // judgment of the evidence, not a side-effect record (contrast\n  // recordApprovalToLedger/archiveApprovedRound below, which degrade to a\n  // logged non-block). "gate couldn\'t read the evidence" is\n  // indistinguishable from "there is no evidence" -- treating it as a pass\n  // would be fail-open, which this repo has repeatedly treated as a defect\n  // (HYK-183\'s ambiguous-verdict handling took the same stance). So this\n  // blocks, same as the not-found branch just above, but through a\n  // controlled return instead of letting the exception escape uncaught\n  // into hooks/commit-msg\'s exit code.\n  let content;\n  try {\n    content = readFileSync(reviewPath, "utf8");\n  } catch (err) {\n    return {\n      ok: false,\n      reason: `review file unreadable: ${reviewPath} (${err.message}); the gate cannot verify approval and blocks -- fix or restore the file (e.g. re-run the review step), then retry the commit`,\n    };\n  }';
  assertExactlyOneMatch(REVIEW_GATE_SRC, target, "site #1 guarded read");
  const mutated = REVIEW_GATE_SRC.replace(
    target,
    '  const content = readFileSync(reviewPath, "utf8");',
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk205-site1-mut-a-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: mutated });
    makeReviewPathADirectory(dir);
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9922 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §1 mutation ⓐ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(FIXED_REASON_SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "RED: without the guard the controlled reason never appears -- only a raw crash",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mutation ⓑ (필수): the catch swallows the read failure and treats it as a
// PASS (fail-open) -- exactly the regression §2 forbids: "couldn't read the
// evidence" must never look like "evidence approved".
//
// HYK-240 2R (반려 2 수리, 검토 지적): 1R 버전은 `review.md`를 디렉터리로
// 만들어(EISDIR) checkReviewGate의 읽기를 실패시켰는데, checkApprovalBinding
// (review-approval-binding.mjs)도 **같은 경로를 같은 방식으로 다시 읽어서**
// 독립적으로 fail-closed 됐다 -- 그래서 이 변이의 "fail-open이면 exit 0"라는
// 단일 지점 증명이 binding 계층에 가려졌다(검토 반려 사유). 되살리는 방법 =
// review.md는 **정상적으로 읽히는 유효한 승인+결속 파일**로 두고(그래서
// checkApprovalBinding은 독립적으로 정상 통과한다), checkReviewGate **자기
// 자신의 읽기 호출만** 강제로 던지게 만든다(파일 상태가 아니라 소스 코드
// 변이로) -- 그러면 "읽기가 실패했을 때 그 결과를 검증 없이 통과시키는가"를
// binding 계층과 완전히 분리해서 다시 단일 변수로 시험할 수 있다.
test("mutation ⓑ (필수): site #1 catch turns fail-closed into fail-open (returns ok:true on read failure) -> unreadable evidence lets the commit through -> RED", () => {
  const catchTarget =
    "  } catch (err) {\n    return {\n      ok: false,\n      reason: `review file unreadable: ${reviewPath} (${err.message}); the gate cannot verify approval and blocks -- fix or restore the file (e.g. re-run the review step), then retry the commit`,\n    };\n  }";
  assertExactlyOneMatch(REVIEW_GATE_SRC, catchTarget, "site #1 catch block");
  const failOpen =
    "  } catch (err) {\n    return { ok: true, reason: `review file unreadable, proceeding anyway: ${err.message}` };\n  }";

  // Second, independent mutation: force checkReviewGate's OWN read to throw
  // regardless of what's actually on disk -- so the file itself can stay a
  // normal, valid, readable review.md (binding layer sees it fine) while
  // ONLY checkReviewGate's read call fails. Isolates the catch's fail-open
  // behavior from binding entirely.
  const readTarget = '    content = readFileSync(reviewPath, "utf8");\n';
  assertExactlyOneMatch(REVIEW_GATE_SRC, readTarget, "site #1 read call");
  const forcedThrow =
    '    content = (() => { throw new Error("HYK-240 2R forced read failure for mutation isolation"); })();\n';

  const mutated = REVIEW_GATE_SRC.replace(catchTarget, failOpen).replace(
    readTarget,
    forcedThrow,
  );
  assert.notEqual(
    mutated,
    REVIEW_GATE_SRC,
    "both replacements must actually have matched and applied",
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk205-site1-mut-b-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: mutated });
    // review.md is a NORMAL, valid, fully-bound approval -- checkReviewGate
    // is the only thing that (via the forced-throw mutation above) can't
    // see it.
    writeApprovedReview(dir, "HYK-9923");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9923 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-240 2R mutation ⓑ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      0,
      "RED: a review checkReviewGate could not even read (forced failure) passed anyway -- the fail-open regression, now isolated from the binding layer's own independent pass (review.md is genuinely valid, so binding legitimately says OK; checkReviewGate's own guard is the only thing standing between 'could not verify' and 'treated as approved')",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-240 2R (반려 2 수리): 되살린 증명이 진짜인지 -- 위 mutation ⓑ가 정말
// checkReviewGate의 fail-open 여부에 반응하는지, catch를 되돌린(=수리된
// 원본 그대로의) 사본으로 같은 시나리오를 돌려 exit 1(차단)임을 확인한다.
// 이게 없으면 "항상 exit 0을 내는 시험을 만들었을 뿐"일 수 있다.
test("mutation ⓑ 대조군: same forced-read-failure scenario, but with checkReviewGate's catch LEFT INTACT (not fail-open) -> still blocked (exit != 0) -- proves the RED above is caused by the catch mutation, not by some other accident", () => {
  const readTarget = '    content = readFileSync(reviewPath, "utf8");\n';
  assertExactlyOneMatch(REVIEW_GATE_SRC, readTarget, "site #1 read call");
  const forcedThrow =
    '    content = (() => { throw new Error("HYK-240 2R forced read failure for mutation isolation"); })();\n';
  const mutated = REVIEW_GATE_SRC.replace(readTarget, forcedThrow);
  assert.notEqual(mutated, REVIEW_GATE_SRC);

  const dir = mkdtempSync(join(tmpdir(), "hyk205-site1-mut-b-control-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: mutated });
    writeApprovedReview(dir, "HYK-9924");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9924 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-240 2R mutation ⓑ 대조군 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.notEqual(
      result.exit,
      0,
      "with the catch intact (fail-closed), a forced read failure must still block -- confirms the mutation ⓑ RED above is specifically caused by the catch mutation",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mutation ⓒ (자유 선택): guard catches but forgets to `return` -- execution
// falls through with `content` left `undefined`, producing a MISLEADING
// reason ("missing review evidence") instead of the correct
// "review file unreadable" diagnosis. Still blocks (exit 1), so this can
// only be caught by asserting the specific, correct reason text.
test("mutation ⓒ (자유 선택): site #1 catch logs but does not return -> falls through with undefined content -> misleading 'missing evidence' reason instead of 'unreadable' -> RED", () => {
  const target =
    "  } catch (err) {\n    return {\n      ok: false,\n      reason: `review file unreadable: ${reviewPath} (${err.message}); the gate cannot verify approval and blocks -- fix or restore the file (e.g. re-run the review step), then retry the commit`,\n    };\n  }";
  assertExactlyOneMatch(REVIEW_GATE_SRC, target, "site #1 catch block");
  const noReturn = "  } catch (err) {\n    console.error(err.message);\n  }";
  const mutated = REVIEW_GATE_SRC.replace(target, noReturn);

  const dir = mkdtempSync(join(tmpdir(), "hyk205-site1-mut-c-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: mutated });
    makeReviewPathADirectory(dir);
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9924 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §1 mutation ⓒ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(FIXED_REASON_SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "RED: without a `return` in the catch, the correct 'unreadable' reason never reaches stderr -- a misleading reason (or a further crash) does instead",
    );
    assert.match(
      result.stderr,
      /missing review evidence/,
      "the fallthrough produces a MISLEADING reason (blames missing evidence, not the real unreadable-file cause) instead of the correct diagnosis",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// SITE #2 -- recordApprovalToLedger's read (§2 record: NON-BLOCKING, logged)
// =============================================================================
//
// Same repro method already established by review-gate-archive-safety.test
// for archiveApprovedRound: inject a deterministic delete right at function
// entry to stand in for "review.md disappears between checkReviewGate's read
// and this re-read" (race-window substitute).

const RECORD_ENTRY_MARKER = "function recordApprovalToLedger(reviewPath) {\n";

function injectDeleteAtRecordEntry(src) {
  assertExactlyOneMatch(
    src,
    RECORD_ENTRY_MARKER,
    "recordApprovalToLedger entry",
  );
  return src.replace(
    RECORD_ENTRY_MARKER,
    `${RECORD_ENTRY_MARKER}  unlinkSyncInjected(reviewPath);\n`,
  );
}

function withUnlinkHelper(src) {
  return src.replace(
    'import { readFileSync, existsSync } from "node:fs";',
    'import { readFileSync, existsSync, unlinkSync } from "node:fs";\nfunction unlinkSyncInjected(p) { try { unlinkSync(p); } catch { /* already gone */ } }',
  );
}

test("§2 fix proof: review.md deleted right as recordApprovalToLedger enters -> commit-msg hook still exits 0, failure is on stderr (원문 로그)", () => {
  const fixedWithInjection = injectDeleteAtRecordEntry(
    withUnlinkHelper(REVIEW_GATE_SRC),
  );
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site2-fix-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: fixedWithInjection });
    writeApprovedReview(dir, "HYK-9925");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9925 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §2 fix 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      0,
      "the approved commit must succeed even though the ledger re-read raced a deletion",
    );
    assert.match(
      result.stderr,
      /reject-streak: failed to record approval/,
      "the failure must be visible on stderr, not silently swallowed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§2 pre-fix behavior (원문 로그, base 9551635 unguarded read): review.md deleted right as recordApprovalToLedger enters -> ENOENT propagates uncaught -> commit-msg hook exits 1, blocking an approved commit", () => {
  const UNGUARDED_SRC = REVIEW_GATE_SRC.replace(
    `  // HYK-205: this re-read (checkReviewGate already read the same file
  // earlier in the same process) is a RECORD, not a judgment -- the commit
  // is already approved by the time this runs (isGenuineReviewApproval
  // gates the call). A TOCTOU race here (file removed/replaced between
  // checkReviewGate's read and this one) must degrade to "ledger not
  // updated, visibly logged", never "commit blocked" -- same contract
  // HYK-204 established for archiveApprovedRound just below.
  let reviewText;
  try {
    reviewText = readFileSync(reviewPath, "utf8");
  } catch (err) {
    console.error(
      \`reject-streak: failed to record approval (re-read failed, commit NOT blocked: \${err.message})\`,
    );
    return;
  }`,
    `  const reviewText = readFileSync(reviewPath, "utf8");`,
  );
  assert.notEqual(
    UNGUARDED_SRC,
    REVIEW_GATE_SRC,
    "the guarded-read snippet must have matched and been replaced",
  );
  const withInjection = injectDeleteAtRecordEntry(
    withUnlinkHelper(UNGUARDED_SRC),
  );
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site2-prefix-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9926");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9926 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §2 pre-fix 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      1,
      "pre-fix: the same race blocked an already-approved commit -- the bug this fix closes",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mutation ⓐ (필수): remove the try/catch guard entirely -> the old bug is
// back -> exit 1, blocking an approved commit.
test("mutation ⓐ (필수): site #2 guard removed -> deleted review.md again propagates uncaught -> commit-msg hook exits 1 -> RED", () => {
  const target =
    '  let reviewText;\n  try {\n    reviewText = readFileSync(reviewPath, "utf8");\n  } catch (err) {\n    console.error(\n      `reject-streak: failed to record approval (re-read failed, commit NOT blocked: ${err.message})`,\n    );\n    return;\n  }';
  assertExactlyOneMatch(REVIEW_GATE_SRC, target, "site #2 guarded read");
  const unguarded = '  const reviewText = readFileSync(reviewPath, "utf8");';
  const mutated = REVIEW_GATE_SRC.replace(target, unguarded);

  const withInjection = injectDeleteAtRecordEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site2-mut-a-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9927");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9927 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §2 mutation ⓐ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      1,
      "RED: without the guard, the same race blocks an already-approved commit again",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mutation ⓑ (필수): the catch swallows the failure silently (no
// console.error) -> commit succeeds, but nobody can see the ledger record
// failed.
test("mutation ⓑ (필수): site #2 catch block silently swallows the failure (no console.error) -> commit succeeds but the failure is invisible -> RED", () => {
  const target =
    "  } catch (err) {\n    console.error(\n      `reject-streak: failed to record approval (re-read failed, commit NOT blocked: ${err.message})`,\n    );\n    return;\n  }";
  assertExactlyOneMatch(REVIEW_GATE_SRC, target, "site #2 catch block");
  const silent = "  } catch (err) {\n    return;\n  }";
  const mutated = REVIEW_GATE_SRC.replace(target, silent);

  const withInjection = injectDeleteAtRecordEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site2-mut-b-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9928");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9928 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §2 mutation ⓑ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(result.exit, 0, "commit still succeeds (that part is fine)");
    assert.doesNotMatch(
      result.stderr,
      /reject-streak: failed to record approval/,
      "RED: the failure is now invisible -- 'believed recorded but wasn't', the exact trap this fix forbids",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mutation ⓒ (자유 선택): a PARTIAL fix -- wraps only the
// recordRejectStreakFromResultText call, not the readFileSync above it
// (looks fixed, still has the hole).
test("mutation ⓒ (자유 선택): site #2 partial guard -- only wraps recordRejectStreakFromResultText, not the readFileSync above it -> the original hole survives -> RED", () => {
  const target =
    '  let reviewText;\n  try {\n    reviewText = readFileSync(reviewPath, "utf8");\n  } catch (err) {\n    console.error(\n      `reject-streak: failed to record approval (re-read failed, commit NOT blocked: ${err.message})`,\n    );\n    return;\n  }\n  const ledgerPath = join(mainRepoRoot(), ".harness", "reject-streak.json");';
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "site #2 guarded read + ledgerPath line",
  );
  const partiallyGuarded =
    '  const reviewText = readFileSync(reviewPath, "utf8");\n  const ledgerPath = join(mainRepoRoot(), ".harness", "reject-streak.json");';
  const mutated = REVIEW_GATE_SRC.replace(target, partiallyGuarded);

  const withInjection = injectDeleteAtRecordEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk205-site2-mut-c-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9929");
    const commitMsgFile = writeCommitMsg(
      dir,
      "fix(check): HYK-9929 -- something",
    );

    const result = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-205 §2 mutation ⓒ 원문 로그] exit=${result.exit} stderr=${JSON.stringify(result.stderr)}`,
    );
    assert.equal(
      result.exit,
      1,
      "RED: guarding only the inner call and leaving the outer read unguarded reproduces the exact original hole even though the function LOOKS fixed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
