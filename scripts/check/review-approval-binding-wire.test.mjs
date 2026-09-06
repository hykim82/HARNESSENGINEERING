// HYK-240 §4 acceptance evidence, as real CLI/hook runs (not direct function
// calls): normal path (approve -> commit, no false positive), 3 forgery
// types (tracked-modify / new-file / delete) each independently blocked,
// fail-closed on missing binding, and a RED mutation proving the wiring in
// review-gate.mjs's CLI block is load-bearing.
//
// ⛔합성 fixture만 쓴다 -- 실제 `.harness`/`.git/hooks`는 절대 건드리지
// 않는다. §4-4a (hooks/commit-msg -> review-gate.mjs 프로덕션 결선)는 이
// 저장소의 실제 `hooks/commit-msg`를 `core.hooksPath`로 지정해 진짜 `git
// commit`을 시도하는 방식으로 증명한다 -- 헬퍼 함수 직접 호출이 아니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  computeFingerprint,
  formatBindingBlock,
} from "./review-approval-binding.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const REVIEW_GATE_CLI = join(HERE, "review-gate.mjs");
const REVIEW_APPROVAL_BINDING_CLI = join(HERE, "review-approval-binding.mjs");
const HOOKS_COMMIT_MSG = join(REPO_ROOT, "hooks", "commit-msg");

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...opts }).trim();
}

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk240-wire-"));
  try {
    git(dir, ["init", "--quiet", "-b", "main"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "base",
    ]);
    mkdirSync(join(dir, ".harness"), { recursive: true });
    // scripts/check/review-gate.mjs is invoked via its real (uncopied) path
    // below, so its sibling imports (reject-streak.mjs etc, including this
    // task's review-approval-binding.mjs) resolve normally -- no staging
    // needed for this file's scenarios.
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function approveAt(dir, { issueId, fingerprint, entries }) {
  const binding = formatBindingBlock({ fingerprint, entries });
  writeFileSync(
    join(dir, ".harness", "review.md"),
    `for: ${issueId}\ntask_id: ${issueId}\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-12 20:00 KST\n`,
    "utf8",
  );
}

function runGateCli(scriptPath, msgFile, cwd) {
  const res = spawnSync(process.execPath, [scriptPath, msgFile], {
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

function writeMsgOutside(subject) {
  const msgDir = mkdtempSync(join(tmpdir(), "hyk240-wire-msg-"));
  const p = join(msgDir, "commit-msg.txt");
  writeFileSync(p, `${subject}\n`, "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// §4-1 정상 경로 오탐 0 -- sample #1 (synthetic repo)
// ---------------------------------------------------------------------------

test("§4-1 sample #1 (synthetic repo): approve, then commit immediately with no further edits -> passes", () => {
  withRepo((dir) => {
    const fp = computeFingerprint({ cwd: dir });
    assert.equal(fp.ok, true);
    approveAt(dir, {
      issueId: "HYK-9950",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    const msgFile = writeMsgOutside("fix(check): HYK-9950 -- something");
    const result = runGateCli(REVIEW_GATE_CLI, msgFile, dir);
    assert.equal(result.exit, 0, `expected pass: ${result.stderr}`);
  });
});

// §4-1 sample #2 (this real worktree) lives in coder.md as a real-commit
// verification (§6-c: proven WITHOUT creating a lasting commit, via a
// direct hooks/commit-msg run against this worktree's own current state)
// -- see coder.md §4-1 for that evidence; it needs the real .harness/
// review.md this file must not touch, so it cannot live in this synthetic
// suite.

// ---------------------------------------------------------------------------
// §4-2 위조 3종 각각 실측 차단
// ---------------------------------------------------------------------------

test("§4-2 ⓐ 추적 파일 내용 수정: approve, then edit an already-tracked file -> BLOCKED (불일치)", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "original", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    writeFileSync(join(dir, "a.js"), "approved edit", "utf8");
    const fp = computeFingerprint({ cwd: dir });
    approveAt(dir, {
      issueId: "HYK-9951",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });

    // Tamper AFTER approval -- exactly the attack this task closes.
    writeFileSync(join(dir, "a.js"), "TAMPERED after approval", "utf8");

    const msgFile = writeMsgOutside("fix(check): HYK-9951 -- something");
    const result = runGateCli(REVIEW_GATE_CLI, msgFile, dir);
    assert.notEqual(result.exit, 0, "must block");
    assert.match(result.stderr, /불일치\(커밋 차단\)/);
  });
});

test("§4-2 ⓑ 새 파일 추가: approve, then add a brand-new file -> BLOCKED (불일치)", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "original", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    const fp = computeFingerprint({ cwd: dir });
    approveAt(dir, {
      issueId: "HYK-9952",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });

    writeFileSync(join(dir, "sneaked-in.js"), "not reviewed", "utf8");

    const msgFile = writeMsgOutside("fix(check): HYK-9952 -- something");
    const result = runGateCli(REVIEW_GATE_CLI, msgFile, dir);
    assert.notEqual(result.exit, 0, "must block");
    assert.match(result.stderr, /불일치\(커밋 차단\)/);
  });
});

test("§4-2 ⓒ 파일 삭제: approve, then delete a file that was part of the approved diff -> BLOCKED (불일치)", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "original", "utf8");
    writeFileSync(join(dir, "b.js"), "will be deleted", "utf8");
    git(dir, ["add", "a.js", "b.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a and b",
    ]);
    writeFileSync(join(dir, "a.js"), "approved edit", "utf8");
    const fp = computeFingerprint({ cwd: dir });
    approveAt(dir, {
      issueId: "HYK-9953",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });

    unlinkSync(join(dir, "b.js"));

    const msgFile = writeMsgOutside("fix(check): HYK-9953 -- something");
    const result = runGateCli(REVIEW_GATE_CLI, msgFile, dir);
    assert.notEqual(result.exit, 0, "must block");
    assert.match(result.stderr, /불일치\(커밋 차단\)/);
  });
});

// ---------------------------------------------------------------------------
// §4-3 판정 불가는 fail-closed, 사유에 만드는 법 포함
// ---------------------------------------------------------------------------

test("§4-3 fail-closed: approved review.md with no binding-fingerprint line at all -> BLOCKED (결속 없음), reason includes how-to", () => {
  withRepo((dir) => {
    writeFileSync(
      join(dir, ".harness", "review.md"),
      "for: HYK-9954\ntask_id: HYK-9954\nrole: REVIEW-CODEX\nverdict: approved\n\n>>> DONE: REVIEW-CODEX @ 2026-08-12 20:00 KST\n",
      "utf8",
    );
    const msgFile = writeMsgOutside("fix(check): HYK-9954 -- something");
    const result = runGateCli(REVIEW_GATE_CLI, msgFile, dir);
    assert.notEqual(result.exit, 0, "must block");
    assert.match(result.stderr, /결속 없음\(커밋 차단\)/);
    assert.match(
      result.stderr,
      /node scripts\/check\/review-approval-binding\.mjs --explain/,
      "reason must tell the human how to get out of the block",
    );
  });
});

// ---------------------------------------------------------------------------
// §4-4a 프로덕션 진입점 결선 실측 -- 진짜 hooks/commit-msg + 진짜 git commit
//
// A plain `git init` synthetic repo is NOT enough here: hooks/commit-msg's
// own fallback search (see its HYK-101 comment) looks for
// `<worktree-root>/scripts/check/review-gate.mjs`, and when that's missing
// falls back to the MAIN clone via `git rev-parse --git-common-dir`. In a
// standalone repo git-common-dir just points back at itself, the script is
// never found, and the hook FAILS OPEN (skips entirely, by design -- same
// posture as gitleaks-missing). Discovered by this file's first draft: both
// the pass and the block variant "passed" for the wrong reason (the gate
// never ran at all). The fix mirrors review-gate-auto-record.test.mjs's own
// addLinkedWorktree pattern: stage scripts/check/*.mjs into a synthetic
// "main clone", then `git worktree add` a linked worktree from it, so
// hooks/commit-msg's fallback resolves for real.
// ---------------------------------------------------------------------------

function stageScriptsCheck(mainDir) {
  const scriptsCheckDir = join(mainDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  for (const name of [
    "review-gate.mjs",
    "relay-handshake.mjs",
    ...RELAY_HANDSHAKE_STATIC_SIBLINGS,
    "review-approval-binding.mjs",
  ]) {
    writeFileSync(
      join(scriptsCheckDir, name),
      readFileSync(join(HERE, name), "utf8"),
      "utf8",
    );
  }
}

function addLinkedWorktree(mainDir) {
  const linkedDir = mkdtempSync(join(tmpdir(), "hyk240-wire-linked-"));
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `hyk240-wire-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  mkdirSync(join(linkedDir, ".harness"), { recursive: true });
  return linkedDir;
}

function withMainAndLinkedWorktree(fn) {
  const mainDir = mkdtempSync(join(tmpdir(), "hyk240-wire-main-"));
  try {
    git(mainDir, ["init", "--quiet", "-b", "main"]);
    git(mainDir, ["config", "user.email", "t@t"]);
    git(mainDir, ["config", "user.name", "t"]);
    // recordApprovalToLedger writes .harness/reject-streak.json under
    // mainRepoRoot() (the main clone, i.e. mainDir here) -- same
    // requirement review-gate-auto-record.test.mjs's initPlainGitRepo
    // already established.
    mkdirSync(join(mainDir, ".harness"), { recursive: true });
    stageScriptsCheck(mainDir);
    git(mainDir, ["add", "-A"]);
    git(mainDir, ["commit", "-q", "-m", "base (with scripts/check staged)"]);
    const linkedDir = addLinkedWorktree(mainDir);
    git(linkedDir, ["config", "core.hooksPath", dirname(HOOKS_COMMIT_MSG)]);
    try {
      return fn(linkedDir);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
}

test("§4-4a 프로덕션 결선: real `git commit` through the tracked hooks/commit-msg (core.hooksPath), approved+matching -> commit SUCCEEDS", () => {
  withMainAndLinkedWorktree((linkedDir) => {
    writeFileSync(
      join(linkedDir, "feature.js"),
      "console.log('feature')",
      "utf8",
    );
    const fp = computeFingerprint({ cwd: linkedDir });
    approveAt(linkedDir, {
      issueId: "HYK-9955",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    git(linkedDir, ["add", "feature.js"]);

    const res = spawnSync(
      "git",
      ["commit", "-m", "fix(check): HYK-9955 -- via real hook"],
      {
        cwd: linkedDir,
        encoding: "utf8",
      },
    );
    assert.equal(res.status, 0, `real git commit must succeed: ${res.stderr}`);
    assert.doesNotMatch(
      res.stderr,
      /harness check script not found/,
      "sanity: the gate must actually have run, not fail-open on a missing script",
    );
    const log = git(linkedDir, ["log", "-1", "--format=%s"]);
    assert.equal(log, "fix(check): HYK-9955 -- via real hook");
  });
});

test("§4-4a 프로덕션 결선: real `git commit` through hooks/commit-msg, approved but code changed after approval -> commit REFUSED by git itself", () => {
  withMainAndLinkedWorktree((linkedDir) => {
    writeFileSync(
      join(linkedDir, "feature.js"),
      "console.log('feature')",
      "utf8",
    );
    const fp = computeFingerprint({ cwd: linkedDir });
    approveAt(linkedDir, {
      issueId: "HYK-9956",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    git(linkedDir, ["add", "feature.js"]);

    // Tamper the staged content after approval was recorded.
    writeFileSync(
      join(linkedDir, "feature.js"),
      "console.log('TAMPERED')",
      "utf8",
    );
    git(linkedDir, ["add", "feature.js"]);

    const res = spawnSync(
      "git",
      ["commit", "-m", "fix(check): HYK-9956 -- via real hook"],
      {
        cwd: linkedDir,
        encoding: "utf8",
      },
    );
    assert.notEqual(res.status, 0, "git commit itself must be refused");
    assert.match(res.stderr, /불일치\(커밋 차단\)/);
    // No commit was created for this subject.
    const log = git(linkedDir, ["log", "--format=%s"]);
    assert.doesNotMatch(log, /HYK-9956/);
  });
});

// ---------------------------------------------------------------------------
// §4-4b RED 증명 (변이 시험): binding call site removed -> forgery no longer
// detected -> RED. Locks the wiring so a future edit that silently drops the
// call is caught.
// ---------------------------------------------------------------------------

test("mutation (필수): review-gate.mjs's checkApprovalBinding call removed from the CLI block -> a tampered-after-approval commit passes anyway -> RED", () => {
  const src = readFileSync(REVIEW_GATE_CLI, "utf8");
  const target =
    "      const binding = checkApprovalBinding({ reviewPath, cwd: repoRoot() });\n      if (!binding.ok) {\n        console.error(binding.reason);\n        process.exit(1);\n      }\n";
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    "mutation target must appear exactly once in the current working-tree source",
  );
  const mutated = src.replace(target, "");

  withRepo((dir) => {
    const scriptsCheckDir = join(dir, "scripts", "check");
    mkdirSync(scriptsCheckDir, { recursive: true });
    writeFileSync(join(scriptsCheckDir, "review-gate.mjs"), mutated, "utf8");
    for (const sibling of [
      "relay-handshake.mjs",
      ...RELAY_HANDSHAKE_STATIC_SIBLINGS,
      "review-approval-binding.mjs",
    ]) {
      writeFileSync(
        join(scriptsCheckDir, sibling),
        readFileSync(join(HERE, sibling), "utf8"),
        "utf8",
      );
    }
    const mutantPath = join(scriptsCheckDir, "review-gate.mjs");

    writeFileSync(join(dir, "a.js"), "original", "utf8");
    git(dir, ["add", "a.js"]);
    git(dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add a",
    ]);
    const fp = computeFingerprint({ cwd: dir });
    approveAt(dir, {
      issueId: "HYK-9957",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    // Tamper after approval -- with the wiring intact this blocks (proven
    // by §4-2 ⓐ above); with the call site removed, it must NOT block.
    writeFileSync(join(dir, "a.js"), "TAMPERED after approval", "utf8");

    const msgFile = writeMsgOutside("fix(check): HYK-9957 -- something");
    const result = runGateCli(mutantPath, msgFile, dir);
    assert.equal(
      result.exit,
      0,
      "RED: without the wiring, a tampered-after-approval commit passes the gate -- exactly the hole HYK-240 closes",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-240 2R (반려 1 수리) -- 검토의 F1 재현 절차를 그대로 옮긴 시험. §ⓐ1의
// 비타협 요건: 시험 helper 직접 호출이 아니라 진짜 `git commit`으로.
// ---------------------------------------------------------------------------

test("HYK-240 2R §F1 재현 (필수): index staged as INDEX_APPROVED, worktree edited to WORKTREE_APPROVED, fingerprint recorded from the worktree, then a real `git commit` -- MUST be refused, and HEAD must not gain the unapproved index content", () => {
  withMainAndLinkedWorktree((linkedDir) => {
    // §1 review-r1.md §축F1 그대로: 1) index에 INDEX_APPROVED를 스테이징
    writeFileSync(join(linkedDir, "feature.js"), "INDEX_APPROVED", "utf8");
    git(linkedDir, ["add", "feature.js"]);
    // 2) 작업트리 파일만 WORKTREE_APPROVED로 바꾼다(index는 그대로 둔다)
    writeFileSync(join(linkedDir, "feature.js"), "WORKTREE_APPROVED", "utf8");
    // 3) 현재(=작업트리) 지문을 계산해 승인 기록
    const fp = computeFingerprint({ cwd: linkedDir });
    approveAt(linkedDir, {
      issueId: "HYK-9958",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });

    // 4) 진짜 git commit(훅 경로로) -- 헬퍼 함수 직접 호출이 아니다.
    const res = spawnSync(
      "git",
      ["commit", "-m", "fix(check): HYK-9958 -- index gap"],
      { cwd: linkedDir, encoding: "utf8" },
    );
    assert.notEqual(
      res.status,
      0,
      "F1: git commit must be REFUSED -- approving the worktree must not silently bless whatever is already staged in the index",
    );
    assert.match(res.stderr, /불일치\(커밋 차단\)/);
    assert.match(
      res.stderr,
      /인덱스.*작업트리|작업트리.*인덱스/,
      "the reason must name the index<->worktree gap specifically, not reuse the generic worktree-fingerprint-mismatch text",
    );
    // No commit was created carrying the unapproved index snapshot.
    const log = git(linkedDir, ["log", "--format=%s"]);
    assert.doesNotMatch(log, /HYK-9958/);
  });
});

test("HYK-240 2R §F1 정상 경로 재확인: index and worktree in sync at approval AND at commit time -> commit succeeds (regression guard for the F1 fix itself)", () => {
  withMainAndLinkedWorktree((linkedDir) => {
    writeFileSync(join(linkedDir, "feature.js"), "SYNCED", "utf8");
    git(linkedDir, ["add", "feature.js"]);
    // Fingerprint recorded from the worktree, which equals what's staged.
    const fp = computeFingerprint({ cwd: linkedDir });
    approveAt(linkedDir, {
      issueId: "HYK-9959",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    const res = spawnSync(
      "git",
      ["commit", "-m", "fix(check): HYK-9959 -- synced"],
      { cwd: linkedDir, encoding: "utf8" },
    );
    assert.equal(res.status, 0, `must succeed: ${res.stderr}`);
  });
});

test("HYK-240 2R §4 요건4 (부분 스테이징): two files change, only ONE is staged before commit -> refused, reason names the unstaged file", () => {
  withMainAndLinkedWorktree((linkedDir) => {
    writeFileSync(join(linkedDir, "a.js"), "a-approved", "utf8");
    writeFileSync(join(linkedDir, "b.js"), "b-approved", "utf8");
    const fp = computeFingerprint({ cwd: linkedDir });
    approveAt(linkedDir, {
      issueId: "HYK-9960",
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    // Only stage one of the two approved files -- a genuine partial
    // staging accident, not tampering (both files still hold their
    // approved content).
    git(linkedDir, ["add", "a.js"]);

    const res = spawnSync(
      "git",
      ["commit", "-m", "fix(check): HYK-9960 -- partial stage"],
      { cwd: linkedDir, encoding: "utf8" },
    );
    assert.notEqual(
      res.status,
      0,
      "partial staging must block, not silently commit half the review",
    );
    assert.match(res.stderr, /불일치\(커밋 차단\)/);
    assert.match(
      res.stderr,
      /b\.js/,
      "reason must name the unstaged file (b.js)",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-244 gate-unblock-1 §1 조각2: --record가 이제 review.md를 절대
// 건드리지 않는지(사이드카로 분리했는지)를 실물 CLI로 증명한다. ⛔합성
// 헬퍼(approveAt)로 review.md 안에 블록을 직접 써넣는 게 아니라, 진짜
// `--record` 서브프로세스를 스폰해 그 산출물(사이드카 파일 + review.md
// 바이트)을 직접 관측한다.
// ---------------------------------------------------------------------------

test("§1 조각2 실물 증명: review-approval-binding.mjs --record 실행 전후로 review.md가 바이트 단위로 하나도 안 바뀐다 -- 결속은 사이드카 파일에만 쓰인다", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, "a.js"), "a-approved", "utf8");
    git(dir, ["add", "a.js"]);
    git(
      dir,
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "add a.js",
      ],
      {},
    );
    // 검토자가 review.md를 쓰는 시점 -- 아직 결속 블록은 없다(코더가
    // 곧이어 --record를 실행하는 것이 실제 순서 그대로).
    const reviewPath = join(dir, ".harness", "review.md");
    const beforeContent =
      "for: HYK-9970\ntask_id: HYK-9970\nrole: REVIEW-CODEX\nverdict: approved\n\n>>> DONE: REVIEW-CODEX @ 2026-08-14 14:00:00 KST\n";
    writeFileSync(reviewPath, beforeContent, "utf8");
    const beforeBytes = readFileSync(reviewPath);

    const record = spawnSync(
      process.execPath,
      [REVIEW_APPROVAL_BINDING_CLI, "--record", "--cwd", dir],
      { encoding: "utf8", cwd: dir },
    );
    assert.equal(record.status, 0, `--record must succeed: ${record.stderr}`);

    const afterBytes = readFileSync(reviewPath);
    assert.deepEqual(
      afterBytes,
      beforeBytes,
      "review.md은 --record 전후로 바이트 단위로 완전히 동일해야 한다(소비 완료 결과 파일 무수정 수칙)",
    );
    assert.equal(
      readFileSync(reviewPath, "utf8"),
      beforeContent,
      "문자열로도 재확인(바이트 비교의 보조 증거)",
    );

    const sidecarPath = join(dir, ".harness", "review-approval-binding.md");
    const sidecarContent = readFileSync(sidecarPath, "utf8");
    assert.match(
      sidecarContent,
      /^binding-fingerprint: [0-9a-f]{64}$/m,
      "결속은 review.md가 아니라 사이드카 파일에 쓰였어야 한다",
    );

    // 결선 확인: 사이드카만으로도 실제 커밋 게이트가 정상 통과하는지
    // (진짜 review-gate.mjs CLI를 그대로 spawn -- 읽는 자리가 실제로
    // 갱신됐다는 end-to-end 증거). 커밋 메시지 파일은 저장소 «밖»에
    // 둔다(실제 프로덕션 위치인 .git/ 안쪽을 흉내내는 기존 관례 그대로
    // -- writeMsgOutside) -- 저장소 안에 두면 git add -A가 그 파일까지
    // 새 untracked로 잡아 --record 시점과 게이트 시점의 지문이
    // 달라지는 시험 자신의 부작용이 생긴다.
    const commitMsgFile = writeMsgOutside("fix(check): HYK-9970 -- something");
    const gateResult = runGateCli(REVIEW_GATE_CLI, commitMsgFile, dir);
    assert.equal(
      gateResult.exit,
      0,
      `사이드카만으로 게이트가 통과해야 한다(결선 증거), 실제 stderr: ${gateResult.stderr}`,
    );
  });
});
