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
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
// HYK-186: relay-handshake.mjs now also imports "./time-authority.mjs".
const TIME_AUTHORITY_PATH = join(HERE, "time-authority.mjs");
// HYK-240: review-gate.mjs now also imports "./review-approval-binding.mjs".
const REVIEW_APPROVAL_BINDING_PATH = join(HERE, "review-approval-binding.mjs");
// HYK-430 5R: relay-handshake.mjs now also statically imports
// "./child-probe-timeout-policy.mjs".
const CHILD_PROBE_TIMEOUT_POLICY_PATH = join(
  HERE,
  "child-probe-timeout-policy.mjs",
);

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

function stageRepo(dir, { reviewGateSrc, envelopeArchiveSrc }) {
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
    envelopeArchiveSrc ?? readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "time-authority.mjs"),
    readFileSync(TIME_AUTHORITY_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "child-probe-timeout-policy.mjs"),
    readFileSync(CHILD_PROBE_TIMEOUT_POLICY_PATH, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "review-approval-binding.mjs"),
    readFileSync(REVIEW_APPROVAL_BINDING_PATH, "utf8"),
    "utf8",
  );
  // HYK-240 2R: stage the harness scaffold itself -- see the identical note
  // in review-gate-unguarded-reads.test.mjs's stageRepo.
  git(dir, ["add", "-A"]);
  return join(scriptsCheckDir, "review-gate.mjs");
}

// HYK-240: fail-closed binding check needs a fingerprint matching `dir`'s
// state at CLI time -- call this AFTER staging and (if used) after the
// commit-msg file is written elsewhere (writeCommitMsgOutside below keeps
// it out of `dir` entirely, so ordering relative to it no longer matters).
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
    `for: ${issueId}\ntask_id: ${issueId}\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-08 17:00 KST\n`,
    "utf8",
  );
}

// HYK-240: production's commit-message file lives under `.git/`, outside
// the working tree `git status` scans -- writing it inside `dir` (as the
// four call sites below used to) would shift the fingerprint computed
// above. Mirror production by writing it elsewhere.
function writeCommitMsgOutside(subject) {
  const msgDir = mkdtempSync(join(tmpdir(), "hyk204-commit-msg-"));
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

// `unlinkSyncInjected` is prepended to every staged mutant/fixed copy so
// the injected `unlinkSyncInjected(reviewPath)` call resolves without
// touching review-gate.mjs's own import list (kept as a free function
// appended after the module's own imports, calling node:fs's unlinkSync
// under a name that can never collide with review-gate.mjs's real code).
function withUnlinkHelper(src) {
  return src.replace(
    'import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";\nfunction unlinkSyncInjected(p) { try { unlinkSync(p); } catch { /* already gone */ } }',
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
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9910 -- something",
    );

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
    'function archiveApprovedRound(reviewPath) {\n  try {\n    const reviewText = readFileSync(reviewPath, "utf8");\n    const outcome = archiveRoundEnvelopeIfNew({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });\n    if (outcome.ok) {\n      console.log(outcome.reason);\n    } else {\n      console.error(outcome.reason);\n    }\n  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (approval re-read failed, commit NOT blocked: ${err.message})`,\n    );\n  }\n}';
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "archiveApprovedRound guarded body",
  );
  const unguarded =
    'function archiveApprovedRound(reviewPath) {\n  const reviewText = readFileSync(reviewPath, "utf8");\n  const outcome = archiveRoundEnvelopeIfNew({\n    role: "review",\n    resultContent: reviewText,\n    harnessDir: dirname(reviewPath),\n  });\n  if (outcome.ok) {\n    console.log(outcome.reason);\n  } else {\n    console.error(outcome.reason);\n  }\n}';
  const mutated = REVIEW_GATE_SRC.replace(target, unguarded);

  const withInjection = injectDeleteAtEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk204-2r-mut-a-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9911");
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9911 -- something",
    );

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
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9912 -- something",
    );

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

test("mutation ⓒ (자유 선택): partial guard -- only wraps archiveRoundEnvelopeIfNew, not the readFileSync above it -> the original hole survives -> RED", () => {
  const target =
    'function archiveApprovedRound(reviewPath) {\n  try {\n    const reviewText = readFileSync(reviewPath, "utf8");\n    const outcome = archiveRoundEnvelopeIfNew({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });\n    if (outcome.ok) {\n      console.log(outcome.reason);\n    } else {\n      console.error(outcome.reason);\n    }\n  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (approval re-read failed, commit NOT blocked: ${err.message})`,\n    );\n  }\n}';
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "archiveApprovedRound guarded body",
  );
  const partiallyGuarded =
    'function archiveApprovedRound(reviewPath) {\n  const reviewText = readFileSync(reviewPath, "utf8");\n  try {\n    const outcome = archiveRoundEnvelopeIfNew({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });\n    if (outcome.ok) {\n      console.log(outcome.reason);\n    } else {\n      console.error(outcome.reason);\n    }\n  } catch (err) {\n    console.error(\n      `envelope-archive: failed to preserve review round (${err.message})`,\n    );\n  }\n}';
  const mutated = REVIEW_GATE_SRC.replace(target, partiallyGuarded);

  const withInjection = injectDeleteAtEntry(withUnlinkHelper(mutated));
  const dir = mkdtempSync(join(tmpdir(), "hyk204-2r-mut-c-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: withInjection });
    writeApprovedReview(dir, "HYK-9913");
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9913 -- something",
    );

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

// ---------------------------------------------------------------------------
// HYK-209-install-closure-4: archiveApprovedRound now reuses H4-3's
// identical-snapshot skip (archiveRoundEnvelopeIfNew) instead of calling
// archiveRoundEnvelope directly -- a second approval-hook firing for the
// SAME unchanged review.md (2026-10-16 11:2x 실사고 shape, 판정 1240 §3)
// must no longer write a second byte-identical rounds/review-r<N>.md.
// ---------------------------------------------------------------------------

function listReviewEnvelopes(dir) {
  const roundsDir = join(dir, ".harness", "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return [];
  }
  return names.filter((n) => /^review-r\d+\.md$/i.test(n)).sort();
}

test("§2ⓑ/ⓓ dedup: the SAME review.md approved twice via the real commit-msg hook CLI -> exactly ONE rounds/review-r<N>.md, skip visible in stdout, second commit still succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk209h44-dedup-same-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: REVIEW_GATE_SRC });
    writeApprovedReview(dir, "HYK-9920");
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9920 -- dedup same content",
    );

    const run1 = runHookLikeCli(scriptPath, commitMsgFile, dir);
    const run2 = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-209-install-closure-4 §2ⓑ/ⓓ 원문 로그] run1.exit=${run1.exit} run2.exit=${run2.exit} run2.stdout=${JSON.stringify(run2.stdout)}`,
    );
    assert.equal(run1.exit, 0, "first approval commit must succeed");
    assert.equal(
      run2.exit,
      0,
      "second firing of the SAME approved review.md must still succeed (not blocked)",
    );
    assert.match(
      run2.stdout,
      /envelope-archive: review round content already preserved \(identical snapshot exists in rounds\/\) -- skipped duplicate/,
      "the skip must be visible on stdout, not a silent no-op",
    );
    assert.deepEqual(
      listReviewEnvelopes(dir),
      ["review-r1.md"],
      "exactly one review envelope must exist after two identical-content approval firings",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§2ⓒ opposite direction: review.md body differs by 1 byte on the second approval firing -> a NEW numbered envelope is written (not skipped), commit still succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk209h44-dedup-diff-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: REVIEW_GATE_SRC });
    writeApprovedReview(dir, "HYK-9921");
    const reviewPath = join(dir, ".harness", "review.md");
    const round1Text = readFileSync(reviewPath, "utf8");
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9921 -- dedup different content",
    );

    const run1 = runHookLikeCli(scriptPath, commitMsgFile, dir);
    assert.equal(run1.exit, 0);
    assert.deepEqual(listReviewEnvelopes(dir), ["review-r1.md"]);

    // Flip exactly one byte in the DONE line's minute field -- the binding
    // block (computed once above from `dir`'s unchanged git status) still
    // validates, since review.md itself is never git-tracked/hashed.
    const round2Text = round1Text.replace("17:00 KST", "17:01 KST");
    assert.notEqual(
      round1Text,
      round2Text,
      "test setup sanity: the two review.md bodies must actually differ",
    );
    writeFileSync(reviewPath, round2Text, "utf8");

    const run2 = runHookLikeCli(scriptPath, commitMsgFile, dir);
    console.log(
      `[HYK-209-install-closure-4 §2ⓒ 원문 로그] run2.exit=${run2.exit} run2.stdout=${JSON.stringify(run2.stdout)}`,
    );
    assert.equal(
      run2.exit,
      0,
      "a genuinely different (1-byte) review.md must still succeed as its own approval commit",
    );
    assert.doesNotMatch(
      run2.stdout,
      /skipped duplicate/,
      "1바이트라도 다른 내용은 건너뛰지 않고 새 번호로 보관해야 한다",
    );
    assert.deepEqual(
      listReviewEnvelopes(dir),
      ["review-r1.md", "review-r2.md"],
      "a genuinely different review.md body must be archived under its own new round number, not skipped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation ⓔ⑴ (필수): archiveApprovedRound reverted to call archiveRoundEnvelope directly (not …IfNew) -> the SAME review.md approved twice -> the duplicate-envelope bug reappears -> RED", () => {
  const target =
    'function archiveApprovedRound(reviewPath) {\n  try {\n    const reviewText = readFileSync(reviewPath, "utf8");\n    const outcome = archiveRoundEnvelopeIfNew({\n      role: "review",\n      resultContent: reviewText,\n      harnessDir: dirname(reviewPath),\n    });';
  assertExactlyOneMatch(
    REVIEW_GATE_SRC,
    target,
    "archiveApprovedRound call site (archiveRoundEnvelopeIfNew)",
  );
  const reverted = target.replace(
    "archiveRoundEnvelopeIfNew({",
    "archiveRoundEnvelope({",
  );
  const mutated = REVIEW_GATE_SRC.replace(target, reverted).replace(
    'import { archiveRoundEnvelopeIfNew } from "./envelope-archive.mjs";',
    'import { archiveRoundEnvelope } from "./envelope-archive.mjs";',
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk209h44-mut-e1-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, { reviewGateSrc: mutated });
    writeApprovedReview(dir, "HYK-9922");
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9922 -- mutation e1",
    );

    runHookLikeCli(scriptPath, commitMsgFile, dir);
    runHookLikeCli(scriptPath, commitMsgFile, dir);
    const envelopes = listReviewEnvelopes(dir);
    console.log(
      `[HYK-209-install-closure-4 mutation ⓔ⑴ 원문 로그] envelopes=${JSON.stringify(envelopes)}`,
    );
    assert.deepEqual(
      envelopes,
      ["review-r1.md", "review-r2.md"],
      "RED: reverting the call site back to archiveRoundEnvelope reproduces the exact duplicate-envelope bug this round fixes",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation ⓔ⑵ (필수): archiveRoundEnvelopeIfNew's identical-snapshot skip judgment neutralized (staged copy only) -> the SAME review.md approved twice -> the duplicate-envelope bug reappears -> RED", () => {
  const ENVELOPE_ARCHIVE_SRC = readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8");
  const target =
    '  if (\n    typeof role === "string" &&\n    role !== "" &&\n    typeof resultContent === "string" &&\n    hasIdenticalArchivedRoundEnvelope({\n      role,\n      resultContent,\n      harnessDir,\n      readdirFn,\n      readFileFn,\n    })\n  ) {';
  assertExactlyOneMatch(
    ENVELOPE_ARCHIVE_SRC,
    target,
    "archiveRoundEnvelopeIfNew's skip-judgment condition",
  );
  const neutralized = ENVELOPE_ARCHIVE_SRC.replace(target, "  if (false) {");

  const dir = mkdtempSync(join(tmpdir(), "hyk209h44-mut-e2-"));
  try {
    initPlainGitRepo(dir);
    const scriptPath = stageRepo(dir, {
      reviewGateSrc: REVIEW_GATE_SRC,
      envelopeArchiveSrc: neutralized,
    });
    writeApprovedReview(dir, "HYK-9923");
    const commitMsgFile = writeCommitMsgOutside(
      "fix(check): HYK-9923 -- mutation e2",
    );

    runHookLikeCli(scriptPath, commitMsgFile, dir);
    runHookLikeCli(scriptPath, commitMsgFile, dir);
    const envelopes = listReviewEnvelopes(dir);
    console.log(
      `[HYK-209-install-closure-4 mutation ⓔ⑵ 원문 로그] envelopes=${JSON.stringify(envelopes)}`,
    );
    assert.deepEqual(
      envelopes,
      ["review-r1.md", "review-r2.md"],
      "RED: review-gate.mjs still calls archiveRoundEnvelopeIfNew by name, but with its internal skip judgment neutralized the duplicate reappears -- proves the fix's safety lives in the judgment, not just the call-site rename",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Restoration evidence for the §2ⓔ table: the ACTUAL production files on
// disk were never touched by the two mutation tests above (both mutate
// in-memory string copies only, staged into throwaway temp repos) -- this
// hash is the production file's sha256 at the moment this test file itself
// ran, i.e. identical before and after the mutation tests execute.
test("§2ⓔ 복원 sha256 (산문 증거): mutation 시험 실행 뒤에도 실물 review-gate.mjs/envelope-archive.mjs 바이트는 그대로다", () => {
  const reviewGateSha = createHash("sha256")
    .update(readFileSync(REVIEW_GATE_PATH, "utf8"), "utf8")
    .digest("hex");
  const envelopeArchiveSha = createHash("sha256")
    .update(readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"), "utf8")
    .digest("hex");
  console.log(
    `[HYK-209-install-closure-4 §2ⓔ 복원 sha256] review-gate.mjs=${reviewGateSha} envelope-archive.mjs=${envelopeArchiveSha}`,
  );
  assert.match(reviewGateSha, /^[0-9a-f]{64}$/);
  assert.match(envelopeArchiveSha, /^[0-9a-f]{64}$/);
});
