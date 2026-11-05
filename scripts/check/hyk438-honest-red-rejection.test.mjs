// HYK-438 1R -- runner receipt gate (resolveRunnerReceiptVerdict,
// relay-handshake.mjs): a REVIEW round that honestly writes `verdict:
// rejected` and backs that claim with its OWN red runner receipt
// (runner_exit != 0, head_commit == this worktree's actual HEAD) is not
// "claiming green" -- the claim and the observation agree. Before this
// round's fix, the gate refused ANY red receipt unconditionally
// (RUNNER_RECEIPT_RED), which meant an honest, evidence-backed rejection
// could never be consumed -- and because reject-streak recording only
// happens on successful consumption (runCompletionSideEffects), that
// honest rejection never reached the reject-streak ledger either (실사고
// 원문: D:\문서관리\하네스-관제실\아카이브\2026-09-06-워크트리정리-ORCH59\
// hyk430-review-1\review.md -- `verdict: rejected` + `runner_exit: 1` +
// `tests 5993 / pass 5986 / fail 1 / skip 6`, refused by this exact gate,
// never recorded into the streak that 게이트 2 depends on).
//
// Scope (coder-task.md §2 product_scope): approved + red still refused
// (unconditional, unchanged); rejected + green/stale/missing/invalid also
// behave exactly as before (무회귀); only rejected + red + head-match is
// newly consumable. The verdict is read via reject-streak.mjs's own
// `parseReviewOutcome` (not a second regex) so this gate and the streak
// recorder it feeds can never disagree about what "rejected" means.
//
// ⛔실물 원장·관제실·아카이브 무접촉: 모든 fixture는 mkdtemp 안에 새로 만든
// 합성 git 저장소 + 그 안의 `.harness/` 서브디렉터리다(live_send_ban
// 준수) -- autoRecordRejectStreak이 쓰는 reject-streak.json도 이 합성
// `.harness/` 안에만 남는다(mainRepoRoot(harnessDir)가 이 합성 저장소
// 루트로 resolve됨, 실측 확인).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveRunnerReceiptVerdict,
  RUNNER_RECEIPT_REJECT_REASON,
} from "./relay-handshake.mjs";

function withFixtureDir(prefix, fn) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// HYK-438: unlike relay-handshake-runner-receipt.test.mjs's flat fixtures
// (dir doubles as both the git repo root AND harnessDir), this file's
// reject-streak assertions need autoRecordRejectStreak's ledger write to
// actually land somewhere -- that write targets
// join(mainRepoRoot(harnessDir), ".harness", "reject-streak.json"), which
// requires a real `.harness/` subdirectory to exist under the repo root
// (실측: a flat fixture's ledger write fails ENOENT, silently/non-fatally
// swallowed -- see runCompletionSideEffects's own header on why that
// failure never blocks the round). Mirrors real production topology
// (harnessDir IS a worktree's own `.harness/`).
function ensureGitHeadCommit(repo) {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "hyk438 test fixture"],
    { cwd: repo },
  );
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const harnessDir = join(repo, ".harness");
  mkdirSync(harnessDir, { recursive: true });
  return { sha, harnessDir };
}

// repro438 shape (coder-task.md §1-1 real-incident quote): REVIEW round,
// `for:` names the judged CODER round, `verdict: rejected`, `head_commit:`
// echoing the commit actually reviewed, DONE line + finalize-done marker.
// `runner_contract: full-1x` in the task file activates the receipt gate
// without needing the older `exit=$?` prose idiom in the result body
// (HYK-425 축, resolveRunnerContractActivation).
function writeReviewRound(
  harnessDir,
  { verdict, resultHead, taskHead, forLine = "HYK-430-review-1" },
) {
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: HYK-438-R\ndropped_at: 2026-11-05 06:00 KST\nrunner_contract: full-1x\nhead_commit: ${taskHead}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: HYK-438-R\nfor: ${forLine}\nverdict: ${verdict}\nhead_commit: ${resultHead}\n\n>>> DONE: REVIEW @ 2026-11-05 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function writeCoderRound(harnessDir, { resultExtra = "" }) {
  writeNonReviewRound(harnessDir, "coder", { resultExtra });
}

// HYK-438-honest-red-2 §2 product_scope ⓘ: generalizes writeCoderRound to
// any non-REVIEW role (coder/verify/pm) -- file names are derived from
// `role.toLowerCase()` exactly as resolveLiveRoundFilePaths does (relay-
// handshake.mjs HYK-244 2R-ci-1), so a "verify" round lands in
// verify-task.md/verify.md, not coder-task.md/coder.md.
function writeNonReviewRound(harnessDir, role, { resultExtra = "" } = {}) {
  const label = `HYK-438-${role.toUpperCase()}`;
  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${label}\ndropped_at: 2026-11-05 06:00 KST\nrunner_contract: full-1x\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${label}\n${resultExtra}\n>>> DONE: ${role.toUpperCase()} @ 2026-11-05 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function writeReceipt(harnessDir, receipt) {
  writeFileSync(
    join(harnessDir, "runner-receipt.json"),
    JSON.stringify(receipt, null, 2),
    "utf8",
  );
}

function baseReceipt(headCommit, overrides = {}) {
  return {
    schema_version: 1,
    runner_exit: 1,
    tests: 5993,
    pass: 5986,
    fail: 1,
    skip: 6,
    head_commit: headCommit,
    finished_at: "2026-11-05 06:09:00 KST",
    ...overrides,
  };
}

function readStreakLedger(harnessDir) {
  return JSON.parse(
    readFileSync(join(harnessDir, "reject-streak.json"), "utf8"),
  );
}

const FIXED_NOW_MS = new Date("2026-11-05T06:15:00+09:00").getTime();

// ===========================================================================
// ⑴ repro438 자체 -- RED-first는 수리 전 relay-handshake.mjs(base master
// af9d002, 이 파일이 들어오기 전 코드)를 scripts check 디렉터리 전체를
// base commit에서 뽑아 만든 샌드박스에서 이 정확한 입력으로 직접 구동해
// `{"ok":false,"code":"RUNNER_RECEIPT_RED", ...}`로 확인했다(결과 파일
// §1-1 원문 인용). 이 시험은 수리 "뒤"의 계약만 고정한다 -- 소비 ok +
// 합성 reject-streak +1.
// ===========================================================================
test("(438-1)★★★ repro438: verdict:rejected + 러너 자기 종료코드 영수증(runner_exit=1, head 일치) -> 소비 ok(정직한 반려는 '초록을 주장'하지 않는다) + reject-streak +1", () => {
  withFixtureDir("hyk438-repro-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: sha,
      taskHead: sha,
      forLine: "HYK-430-review-1",
    });
    writeReceipt(harnessDir, baseReceipt(sha));
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      result.ok,
      true,
      `expected the honest red-backed rejection to be consumed: ${JSON.stringify(result)}`,
    );
    const ledger = readStreakLedger(harnessDir);
    assert.equal(ledger.issues["HYK-430"]?.streak, 1);
    assert.equal(ledger.issues["HYK-430"].history.at(-1).verdict, "rejected");
  });
});

// ===========================================================================
// ⑵ 대조군: verdict:approved + 같은 빨간 영수증 -- 여전히 거부(RED 유지,
// "초록을 주장"하는 빨강은 이 라운드가 손대지 않는 범위).
// ===========================================================================
test("(438-2)★★★ 대조군: verdict:approved + runner_exit=1(head 일치) -> 여전히 거부(RUNNER_RECEIPT_RED, 종전 그대로)", () => {
  withFixtureDir("hyk438-approved-red-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReviewRound(harnessDir, {
      verdict: "approved",
      resultHead: sha,
      taskHead: sha,
    });
    writeReceipt(harnessDir, baseReceipt(sha));
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});

// ===========================================================================
// ⑶ rejected + red + head 불일치 -- 여전히 거부(사유 원문 보존, 영수증이
// 이 head를 증명하지 못한다).
// ===========================================================================
test("(438-3)★★★ rejected + runner_exit=1 + 영수증 head_commit이 다른 커밋 -> 여전히 거부(정직한 반려라도 영수증이 이 head를 증명 못하면 소비 안 됨)", () => {
  withFixtureDir("hyk438-rejected-red-stale-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    const oldSha = "f".repeat(40);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: sha,
      taskHead: sha,
    });
    writeReceipt(harnessDir, baseReceipt(oldSha));
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      result.ok,
      false,
      "head가 안 맞는 빨간 영수증은 여전히 거부돼야 한다",
    );
  });
});

// ===========================================================================
// ⑷ rejected + 영수증 없음 -> MISSING(무회귀).
// ===========================================================================
test("(438-4) rejected + runner-receipt.json 없음 -> 여전히 MISSING(무회귀)", () => {
  withFixtureDir("hyk438-rejected-missing-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: sha,
      taskHead: sha,
    });
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);
  });
});

// ===========================================================================
// ⑸ rejected + 영수증이 유효한 JSON이 아님 -> INVALID(무회귀).
// ===========================================================================
test("(438-5) rejected + runner-receipt.json이 유효한 JSON이 아님 -> 여전히 INVALID(무회귀)", () => {
  withFixtureDir("hyk438-rejected-badjson-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: sha,
      taskHead: sha,
    });
    writeFileSync(
      join(harnessDir, "runner-receipt.json"),
      "{ not json",
      "utf8",
    );
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
  });
});

// ===========================================================================
// ⑹ rejected + 초록 영수증(head 일치) -> 정상 소비(이 축이 생기기 전과
// 완전히 동일 -- 무회귀. reject-streak도 그대로 +1된다, 이건 이 라운드
// 이전부터 있던 동작).
// ===========================================================================
test("(438-6) rejected + runner_exit=0(head 일치) -> 정상 소비(무회귀, 이 라운드 이전부터의 동작) + reject-streak +1", () => {
  withFixtureDir("hyk438-rejected-green-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: sha,
      taskHead: sha,
      forLine: "HYK-999-review-1",
    });
    writeReceipt(
      harnessDir,
      baseReceipt(sha, { runner_exit: 0, fail: 0, pass: 5993 }),
    );
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      result.ok,
      true,
      `expected clean pass: ${JSON.stringify(result)}`,
    );
    const ledger = readStreakLedger(harnessDir);
    assert.equal(ledger.issues["HYK-999"]?.streak, 1);
  });
});

// ===========================================================================
// ⑺ verdict 줄이 없는 결과(CODER) + red -> 여전히 RED(무변 -- 이 라운드는
// REVIEW 계열의 verdict만 읽는다, CODER/VERIFY/PM 결과는 영향 밖).
// ===========================================================================
test("(438-7) verdict 줄이 없는 CODER 라운드 + runner_exit=1(head 일치) -> 여전히 RED(무변)", () => {
  withFixtureDir("hyk438-coder-red-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeCoderRound(harnessDir, { resultExtra: "" });
    writeReceipt(harnessDir, baseReceipt(sha));
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});

// ===========================================================================
// ⑻ 측정 불능(runner_status=MEASUREMENT_UNAVAILABLE_OOM) + rejected ->
// 여전히 MEASUREMENT_UNAVAILABLE, RED/소비ok 둘 다 아님(HYK-477 축이 이
// 새 분기보다 "먼저" 걸린다 -- 순서 무변).
// ===========================================================================
test("(438-8) rejected + runner_status=MEASUREMENT_UNAVAILABLE_OOM -> 여전히 MEASUREMENT_UNAVAILABLE(HYK-477 축이 먼저 걸린다, 소비되지 않음)", () => {
  withFixtureDir("hyk438-measurement-unavailable-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: sha,
      taskHead: sha,
    });
    writeReceipt(
      harnessDir,
      baseReceipt(sha, { runner_status: "MEASUREMENT_UNAVAILABLE_OOM" }),
    );
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE,
    );
  });
});

// ===========================================================================
// ⑼ (HYK-492 결합, 판정 문면 "거부 뒤 verdict 를 approved 로 바꿔 재소비 =
// 거부") -- head 불일치로 거부된 뒤, 같은 세대에서 head_commit은 고치고
// verdict까지 rejected->approved로 같이 바꿔 재소비하면 여전히
// DONE_REWRITTEN이다. 이 보호는 first-observation.mjs(HYK-492 코드,
// 이 라운드 범위 밖·무변)가 이미 건다 -- 이 시험은 이 라운드의 새 분기가
// 그 보호를 "우회하는 새 길"을 열지 않았음을 고정한다(무회귀 증명).
// ===========================================================================
test("(438-9)★★★ HYK-492 결합: head 불일치로 거부 -> head는 고치고 verdict도 rejected->approved로 같이 바꿔 재소비 -- 여전히 DONE_REWRITTEN(이 라운드의 새 분기가 그 보호를 우회하지 않는다)", () => {
  withFixtureDir("hyk438-492-combo-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    const wrongSha = "e".repeat(40);
    writeReviewRound(harnessDir, {
      verdict: "rejected",
      resultHead: wrongSha,
      taskHead: sha,
    });
    writeReceipt(harnessDir, baseReceipt(wrongSha));
    const poll1 = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      poll1.ok,
      false,
      `poll1 must reject: ${JSON.stringify(poll1)}`,
    );

    writeReviewRound(harnessDir, {
      verdict: "approved",
      resultHead: sha,
      taskHead: sha,
    });
    writeReceipt(harnessDir, baseReceipt(sha, { runner_exit: 0, fail: 0 }));
    const poll2 = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      poll2.ok,
      false,
      "head_commit 말고 verdict까지 달라졌으면 여전히 거부돼야 한다(HYK-492 P2-4)",
    );
    assert.match(
      String(poll2.reason),
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

// ===========================================================================
// (0) resolveRunnerReceiptVerdict 직접 확인 -- 함수 자체의 반환값(프로덕션
// export, zero-wrapper)으로 (438-1)/(438-2)의 값을 다시 고정한다.
// ===========================================================================
// ===========================================================================
// (11) 적재 경로 드리프트 방지(product_scope "같은 판독" 요건) -- `verdict:`
// 줄이 2개(모호, parseReviewOutcome 자신이 AMBIGUOUS_VERDICT_LINE으로
// 거부하는 바로 그 모양)지만 본문에 'rejected' 낱말이 섞여 있는 표본.
// 이 축이 (reject-streak.mjs와) "같은" parseReviewOutcome을 재사용하는
// 한, claimedOutcome.ok===false라 이 새 분기는 발화하지 않고 기존
// RED 검사로 떨어진다 -- 모호한 판정 줄은 "정직한 rejected"로 간주되지
// 않는다. 이 시험은 이 축이 "느슨한 별도 판독"(예: 본문에 'rejected'가
// 있는지 문자열로만 찾는 것)으로 드리프트하면 깨진다(아래 ⓓ④ 변이가
// 바로 이 드리프트를 주입해 이 시험을 RED로 만든다 -- 결과 파일 변이표
// 참조).
// ===========================================================================
test("(438-11)★★★ 적재 경로 드리프트 방지: verdict: 줄 2개(모호) + 본문에 'rejected' 낱말 포함 + red 영수증(head 일치) -> 여전히 거부(모호한 판정은 '정직한 rejected'가 아니다, 느슨한 별도 판독이면 깨지는 시험)", () => {
  withFixtureDir("hyk438-ambiguous-verdict-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeFileSync(
      join(harnessDir, "review-task.md"),
      `task_id: HYK-438-R\ndropped_at: 2026-11-05 06:00 KST\nrunner_contract: full-1x\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "review.md"),
      `task_id: HYK-438-R\nfor: HYK-430-review-1\nverdict: rejected\nverdict: approved\nhead_commit: ${sha}\n\n>>> DONE: REVIEW @ 2026-11-05 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    writeReceipt(harnessDir, baseReceipt(sha));
    const result = checkRelayHandshake({
      role: "review",
      harnessDir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      result.ok,
      false,
      `모호한 verdict 줄은 honest-rejection 소비를 열어서는 안 된다: ${JSON.stringify(result)}`,
    );
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});

// ===========================================================================
// HYK-438-honest-red-2 (검토 1R P1-1 수리): CODER/VERIFY/PM 결과가
// `verdict: rejected` 줄을 갖고(실수로든, 이 축을 노린 것이든) 자기 head와
// 일치하는 빨간 영수증까지 갖고 있어도 -- 이 역할들은 reject-streak.mjs의
// recordRejectStreakFromResultText가 쓰는 판별(isReviewFamilyRole)로
// "적재 대상"이 아니므로, 여기서 소비를 열어주면 "소비는 되는데 아무 데도
// 적재되지 않는" 조용한 손실이 재발한다 -- 이 축이 그 구멍을 닫는다.
//
// RED-first 실측(⛔사본 import 아님, 수리 "전" base ff04491의 scripts/check
// 전체를 git archive로 뽑은 별도 샌드박스에서 production checkRelayHandshake
// 를 이 정확한 입력으로 직접 구동): 세 역할 모두 `{"ok":true,"reason":
// "relay handshake ok for HYK-438-RF"}` -- 수리 전에는 소비됐다(버그
// 재현). 이 커밋 "이후"(이 파일이 보는 production 코드)로 같은 입력을
// 다시 구동하면 세 역할 모두 `{"ok":false,"code":"RUNNER_RECEIPT_RED"}`로
// 바뀐다 -- 아래 테스트가 그 "이후" 계약을 고정한다.
// ===========================================================================
for (const role of ["coder", "verify", "pm"]) {
  test(`(438-12-${role})★★★ ${role.toUpperCase()} 결과에 verdict: rejected 줄 + runner_exit=1(head 일치) -> 여전히 RUNNER_RECEIPT_RED(검토 1R P1-1 수리 -- REVIEW 계열만 '정직한 빨강 반려' 예외를 받는다)`, () => {
    withFixtureDir(`hyk438-role-${role}-`, (repo) => {
      const { sha, harnessDir } = ensureGitHeadCommit(repo);
      writeNonReviewRound(harnessDir, role, {
        resultExtra: `verdict: rejected\nhead_commit: ${sha}`,
      });
      writeReceipt(harnessDir, baseReceipt(sha));
      const result = checkRelayHandshake({
        role,
        harnessDir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        false,
        `${role} verdict:rejected + red는 여전히 거부돼야 한다: ${JSON.stringify(result)}`,
      );
      assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
    });
  });

  test(`(438-13-${role}) resolveRunnerReceiptVerdict 직접 확인: role="${role}" + verdict: rejected + red + head일치 -> RED(REVIEW 계열이 아니므로 역할 조건에서 막힌다)`, () => {
    withFixtureDir(`hyk438-role-direct-${role}-`, (repo) => {
      const { sha, harnessDir } = ensureGitHeadCommit(repo);
      writeReceipt(harnessDir, baseReceipt(sha));
      const r = resolveRunnerReceiptVerdict({
        resultContent: `task_id: HYK-438-${role.toUpperCase()}\nverdict: rejected\nhead_commit: ${sha}\n`,
        harnessDir,
        requiredRuns: 1,
        role,
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.RED);
    });
  });
}

test("(438-10) resolveRunnerReceiptVerdict 직접 확인: rejected+red+head일치 -> {ok:true}, approved+red+head일치 -> RED", () => {
  withFixtureDir("hyk438-direct-", (repo) => {
    const { sha, harnessDir } = ensureGitHeadCommit(repo);
    writeReceipt(harnessDir, baseReceipt(sha));
    const rejected = resolveRunnerReceiptVerdict({
      resultContent: `task_id: HYK-438-R\nfor: HYK-430-review-1\nverdict: rejected\nhead_commit: ${sha}\n`,
      harnessDir,
      requiredRuns: 1,
      role: "review",
    });
    assert.deepEqual(rejected, { ok: true });

    const approved = resolveRunnerReceiptVerdict({
      resultContent: `task_id: HYK-438-R\nfor: HYK-430-review-1\nverdict: approved\nhead_commit: ${sha}\n`,
      harnessDir,
      requiredRuns: 1,
      role: "review",
    });
    assert.equal(approved.ok, false);
    assert.equal(approved.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});
