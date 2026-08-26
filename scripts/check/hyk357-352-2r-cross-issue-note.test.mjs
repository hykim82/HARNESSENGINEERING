// HYK-357-352 2R §2 (P1-2 판정) -- 1R 검토 급소 2는 `for:`와 `task_id:`가
// 서로 다른 이슈를 가리키는 입력(`different_issues`)이 `parseReviewOutcome
// ok:true`이고 실제로 `for:`가 가리키는 이슈에 기록된다고 지적했다.
//
// ★2R 판정 = ⓑ 위반 아님(ORCH 스펙 오류 자인). 반례: 실제로 36회차에
// 쓰인 `for: HYK-344+347+350`(세 이슈를 묶은 리뷰 라운드) -- issueIdFrom은
// 첫 HYK-<n> 접두어만 뽑으므로(`reject-streak.mjs`의 ISSUE_ID_RE), 그
// 라운드의 `task_id:`가 예컨대 `HYK-347-review-1`이었다면 `for:`에서 뽑힌
// 이슈(HYK-344)와 `task_id:`의 이슈(HYK-347)가 다른 것은 «정상»이다.
// 엄격한 일치 강제(차단)는 이런 정당한 다중 이슈 묶음 라운드를 새로
// 막는다 -- ⛔정당한 거부 회귀 0을 이 방향으로도 어긴다. 그래서 2R은
// 이 갈래를 차단하지 않는다.
//
// 그래도 §2의 최소 요구는 남는다: "두 값이 다른 이슈를 가리킨다는 사실이
// 지금은 어디에도 안 남는다"(없음≠모름). reject-streak.mjs에 추가한
// `crossIssueNote`(parseReviewOutcome -> computeRecord ->
// recordRejectStreakFromResultText)가 그 사실을 비차단 진단으로
// 표면화한다 -- 이 파일은 그 진단이 실제로 나타나는지와, 그 결과
// consumption 자체는 여전히 정상 통과(회귀 0)하는지를 함께 고정한다.
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
import {
  parseReviewOutcome,
  computeRecord,
  recordRejectStreakFromResultText,
} from "./reject-streak.mjs";

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
  const linkedDir = tmpDir("hyk357-352-2r-note-linked-");
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

// ---------------------------------------------------------------------------
// 판정 근거 (반례): 진짜 다중 이슈 묶음 라운드 형태는 위반이 아니다.
// ---------------------------------------------------------------------------

test("★판정 근거: 'for: HYK-344+347+350'(다중 이슈 묶음, 36회차 실사용 형태) + 다른 이슈의 task_id: -> ok:true 유지(엄격 일치를 강제했다면 이 정당한 라운드가 막혔을 것)", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-347-review-1\nfor: HYK-344+347+350\nverdict: rejected\n",
  );
  assert.equal(
    result.ok,
    true,
    "a legitimate bundled-issue round must not be blocked by a strict for:/task_id: issue-match rule",
  );
  assert.equal(result.issueId, "HYK-344");
  assert.ok(
    result.crossIssueNote,
    "the mismatch must still be surfaced as a non-blocking diagnostic",
  );
});

// ---------------------------------------------------------------------------
// (a) 급소 2 재현 입력에서 진단이 실제로 나타난다 (parseReviewOutcome 단
// 계층).
// ---------------------------------------------------------------------------

test("(a) 급소 2 재현: for:/task_id: 가 다른 이슈 -> ok:true(회귀 0), crossIssueNote 에 두 이슈 값이 모두 드러난다", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-999-review-1\nfor: HYK-357-coder-1\nverdict: rejected\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.issueId, "HYK-357");
  assert.equal(result.taskId, "HYK-357-coder-1");
  assert.ok(result.crossIssueNote, "crossIssueNote must be present");
  assert.match(result.crossIssueNote, /HYK-357/);
  assert.match(result.crossIssueNote, /HYK-999/);
});

test("동일 이슈(정상 경우)에는 crossIssueNote 가 없다 -- 노이즈 0", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-357-review-1\nfor: HYK-357-coder-1\nverdict: rejected\n",
  );
  assert.equal(result.ok, true);
  assert.equal(
    "crossIssueNote" in result,
    false,
    "same-issue for:/task_id: must not produce a mismatch note",
  );
});

test("'for:' 없이 'task_id:' 폴백인 경우에도 crossIssueNote 가 없다 (비교 대상이 자기 자신이라 항상 동일)", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-357-review-1\nverdict: rejected\n",
  );
  assert.equal(result.ok, true);
  assert.equal("crossIssueNote" in result, false);
});

// ---------------------------------------------------------------------------
// (b) computeRecord/recordRejectStreakFromResultText 를 통과해도 진단이
// 살아남는다 (파서 계층 -> 원장 기록 계층).
// ---------------------------------------------------------------------------

test("(b) computeRecord: ok:true 결과 객체에도 crossIssueNote 가 그대로 전달된다", () => {
  const computed = computeRecord({
    reviewText:
      "task_id: HYK-999-review-1\nfor: HYK-357-coder-1\nverdict: rejected\n",
    ledger: { schema_version: 1, issues: {} },
    at: "2026-08-26 11:00 KST",
  });
  assert.equal(computed.ok, true);
  assert.equal(computed.issueId, "HYK-357");
  assert.ok(computed.crossIssueNote);
});

test("(b2) recordRejectStreakFromResultText: reason 문자열에 [NOTE: ...] 로 크로스이슈 사실이 표면화된다 -- 없음≠모름", () => {
  withTempDir("hyk357-352-2r-note-ledger-", (dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const outcome = recordRejectStreakFromResultText({
      role: "review",
      resultText:
        "task_id: HYK-999-review-1\nfor: HYK-357-coder-1\nverdict: rejected\n",
      ledgerPath,
      at: "2026-08-26 11:00 KST",
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, true);
    assert.match(
      outcome.reason,
      /\[NOTE: 'for:' issue \(HYK-357\) differs from 'task_id:' issue \(HYK-999\)/,
      "the human-facing reason line (the one every caller already console.logs) must carry the cross-issue fact",
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(
      ledger.issues["HYK-357"].streak,
      1,
      "still recorded against the for:-derived issue -- ⛔this task's §2 says do not change WHERE it records, only make the mismatch visible",
    );
    assert.equal(
      ledger.issues["HYK-999"],
      undefined,
      "must not double-record against task_id:'s issue either",
    );
  });
});

// ---------------------------------------------------------------------------
// (c) ★소비 경로까지: 급소 2의 정확한 재현 입력을 실제 checkRelayHandshake
// CLI로 태운다. 회귀 0 확인 -- 이 갈래는 «위반 아님» 판정이므로 여전히
// exit 0, 원장 기록도 정상, 그러나 stdout 에 crossIssueNote 문구가 실제로
// 찍힌다(«없음≠모름», 화면에도 실제로 남는지 직접 태워 확인).
// ---------------------------------------------------------------------------

test("(c)★ 소비 경로 실측: 급소 2 재현 입력을 실제 checkRelayHandshake 로 태우면 exit 0(회귀 0) + stdout 에 crossIssueNote 실제로 찍힘 + 원장 정상 기록", () => {
  withTempDir("hyk357-352-2r-note-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, "review-task.md"),
        "task_id: HYK-9705-review-1\ndropped_at: 2026-08-25 20:00 KST\n",
        "utf8",
      );
      writeFileSync(
        join(harnessDir, "review.md"),
        "task_id: HYK-9705-review-1\nfor: HYK-357-coder-1\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-08-25 20:10:00 KST\n",
        "utf8",
      );

      const result = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );

      assert.equal(
        result.exit,
        0,
        `★회귀 0: cross-issue for:/task_id: is NOT a violation, consumption must still succeed: stderr=${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /\[NOTE: 'for:' issue \(HYK-357\) differs from 'task_id:' issue \(HYK-9705\)/,
        "the cross-issue fact must actually reach stdout on a real consumption run, not just the unit-level reason string",
      );
      const ledger = readMainLedger(mainDir);
      assert.ok(ledger);
      assert.equal(ledger.issues["HYK-357"].streak, 1);
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
    "hyk357-352-2r-cross-issue-note.test.mjs must leave the real worktree exactly as it found it",
  );
});
