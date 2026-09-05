// HYK-183-ledger-fix §3(f): mutation coverage for the two mechanisms this
// task adds -- 축 A (done_at을 isDuplicate 판정에 더한 것) and 축 B
// (review-gate.mjs가 승인을 원장에 기록하는 것). Unlike
// reject-streak-auto-record.test.mjs's own mutation block (which reads its
// mutation target from `git show HEAD:<path>` and skips until this task's
// fix is actually committed -- a deliberate choice for THAT file, gated on
// HYK-183 §2's own already-merged wiring), these read the CURRENT WORKING
// TREE source directly: this fix has not been committed yet (§1 "⛔커밋하지
// 마라"), and gating on HEAD would make every mutation test here skip until
// after REVIEW/ORCH commits, leaving skip>0 at the exact moment this task
// needs to report skip=0. Reading the working tree instead lets these run
// (and go RED against the un-fixed logic) right now, in this session.
//
// §2-2와 동일한 비타협: 실제 원장(`.harness/reject-streak.json`)은 절대
// 건드리지 않는다 -- 모든 시험은 저장소 밖 mkdtemp에서만 CLI를 실행한다.
import { test } from "node:test";
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
import {
  computeFingerprint,
  formatBindingBlock,
} from "./review-approval-binding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const REVIEW_GATE_PATH = join(HERE, "review-gate.mjs");
// HYK-204: relay-handshake.mjs and review-gate.mjs both now import
// "./envelope-archive.mjs" (round preservation) -- the 축B mutation below
// stages copies of both alongside a mutated review-gate.mjs, so that
// import must resolve too, or the copy fails to load at all (not a real
// RED signal, just a missing file).
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

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function runCli(scriptPath, args, opts = {}) {
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

// ---------------------------------------------------------------------------
// 축 A mutation: computeRecord's isDuplicate loses the done_at component ->
// two genuinely different rounds sharing a bare (ORCH 관행) task_id collapse
// back into "duplicate", exactly today's incident (§1 축 A).
// ---------------------------------------------------------------------------

test("mutation 축A (필수): isDuplicate's done_at component removed -> two real, distinct rounds sharing the same bare task_id are wrongly deduped -> RED", () => {
  const src = readFileSync(REJECT_STREAK_PATH, "utf8");
  const target =
    "  const isDuplicate =\n    !!lastEntry &&\n    lastEntry.task_id === outcome.taskId &&\n    lastEntry.verdict === outcome.verdict &&\n    (lastEntry.done_at ?? null) === (outcome.doneAt ?? null);\n";
  assertExactlyOneMatch(src, target, "isDuplicate with done_at");
  const mutated = src.replace(
    target,
    "  const isDuplicate =\n    !!lastEntry &&\n    lastEntry.task_id === outcome.taskId &&\n    lastEntry.verdict === outcome.verdict;\n",
  );

  withTempDir("hyk183-lf-mut-a-", (dir) => {
    // The CLI's own `invokedDirectly` guard checks that `process.argv[1]`
    // ends with `scripts/check/reject-streak.mjs` -- the mutant must keep
    // that exact path suffix or the CLI block silently never runs at all
    // (indistinguishable from "no output", not a real RED signal).
    const scriptsCheckDir = join(dir, "scripts", "check");
    mkdirSync(scriptsCheckDir, { recursive: true });
    const mutantPath = join(scriptsCheckDir, "reject-streak.mjs");
    writeFileSync(mutantPath, mutated, "utf8");

    const ledgerPath = join(dir, "reject-streak.json");
    const round1Path = join(dir, "round1.md");
    const round2Path = join(dir, "round2.md");
    writeFileSync(
      round1Path,
      "for: HYK-186\ntask_id: HYK-186\nverdict: rejected\n\n>>> DONE: REVIEW-CODEX @ 2026-08-05 09:34 KST\n",
      "utf8",
    );
    writeFileSync(
      round2Path,
      "for: HYK-186\ntask_id: HYK-186\nverdict: rejected\n\n>>> DONE: REVIEW-CODEX @ 2026-08-05 11:02 KST\n",
      "utf8",
    );

    runCli(mutantPath, [
      "record",
      "--review",
      round1Path,
      "--ledger",
      ledgerPath,
    ]);
    const second = runCli(mutantPath, [
      "record",
      "--review",
      round2Path,
      "--ledger",
      ledgerPath,
    ]);

    assert.match(
      second.stdout,
      /DUPLICATE/,
      "RED: without the done_at component, the mutant wrongly reports the second, genuinely different round as a duplicate",
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      ledger.issues["HYK-186"].streak,
      1,
      "RED: the mutant's streak stays stuck at 1 instead of advancing to 2 -- exactly today's incident",
    );
  });
});

// ---------------------------------------------------------------------------
// 축 B mutation: review-gate.mjs's CLI block loses the recordApprovalToLedger
// call -> an approved, independently-reviewed commit passes the gate but
// never touches the ledger, exactly today's incident (§1 축 B).
// ---------------------------------------------------------------------------

test("mutation 축B (필수): review-gate.mjs's recordApprovalToLedger call removed from the CLI block -> an approved commit passes the gate but the ledger is never written -> RED", () => {
  const src = readFileSync(REVIEW_GATE_PATH, "utf8");
  const target = "      recordApprovalToLedger(reviewPath);\n";
  assertExactlyOneMatch(src, target, "recordApprovalToLedger call site");
  const mutated = src.replace(target, "");

  withTempDir("hyk183-lf-mut-b-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const scriptsCheckDir = join(mainDir, "scripts", "check");
    mkdirSync(scriptsCheckDir, { recursive: true });
    writeFileSync(join(scriptsCheckDir, "review-gate.mjs"), mutated, "utf8");
    writeFileSync(
      join(scriptsCheckDir, "reject-streak.mjs"),
      readFileSync(REJECT_STREAK_PATH, "utf8"),
      "utf8",
    );
    writeFileSync(
      join(scriptsCheckDir, "relay-handshake.mjs"),
      readFileSync(RELAY_HANDSHAKE_PATH, "utf8"),
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
      join(scriptsCheckDir, "child-probe-timeout-policy.mjs"),
      readFileSync(CHILD_PROBE_TIMEOUT_POLICY_PATH, "utf8"),
      "utf8",
    );
    writeFileSync(
      join(scriptsCheckDir, "review-approval-binding.mjs"),
      readFileSync(REVIEW_APPROVAL_BINDING_PATH, "utf8"),
      "utf8",
    );
    const mutantReviewGate = join(scriptsCheckDir, "review-gate.mjs");
    // HYK-240 2R: stage the harness scaffold itself -- in the real repo
    // scripts/check/ is tracked (part of HEAD), so this never shows up as
    // an unstaged change there. Leaving these copies untracked here would
    // make review-approval-binding.mjs's index<->worktree sync check (F1
    // fix) see them as desynced regardless of what this test exercises.
    git(mainDir, ["add", "-A"]);

    // HYK-240: binding-fingerprint must match `mainDir`'s state at CLI
    // time -- computed AFTER all staging above so the staged
    // scripts/check/*.mjs files are already accounted for. Production's
    // commit-message file lives under `.git/` (outside the tree `git
    // status` scans), so the message file below is written elsewhere and
    // never touches this fingerprint.
    const fp = computeFingerprint({ cwd: mainDir });
    assert.equal(
      fp.ok,
      true,
      `fingerprint must be computable in ${mainDir}: ${fp.reason}`,
    );
    const binding = formatBindingBlock({
      fingerprint: fp.fingerprint,
      entries: fp.entries,
    });
    writeFileSync(
      join(mainDir, ".harness", "review.md"),
      `for: HYK-9700\ntask_id: HYK-9700\nrole: REVIEW-CODEX\nverdict: approved\n${binding}\n>>> DONE: REVIEW-CODEX @ 2026-08-05 12:00 KST\n`,
      "utf8",
    );
    const msgDir = mkdtempSync(join(tmpdir(), "hyk183-lf-mut-b-msg-"));
    const commitMsgFile = join(msgDir, "commit-msg.txt");
    writeFileSync(commitMsgFile, "fix(check): HYK-9700 -- something\n", "utf8");

    const result = runCli(mutantReviewGate, [commitMsgFile], {
      cwd: mainDir,
    });
    assert.equal(
      result.exit,
      0,
      "the gate itself must still pass (this mutation only removes the recording side effect)",
    );
    assert.equal(
      existsSync(join(mainDir, ".harness", "reject-streak.json")),
      false,
      "RED: without the wiring, an approved+independently-reviewed commit leaves the ledger untouched -- exactly today's missing-3-approvals incident",
    );
  });
});
