// HYK-423 3R -- 두 번의 반려가 같은 뿌리를 가리켰다: «관측 지문이 보호하는
// 범위»와 «각 검사기가 실제로 읽는 범위»가 서로 달랐다.
//
// 1R: 관측 해제를 «어느 게이트가 거부했는가»(게이트 이름)에 결속 -> 그
// 두 게이트가 정확히 «워커가 스스로 만들 수 있는» 축이라 거부를 유도해
// 관측을 지우고 바꿔치기 가능했다.
// 2R: 축을 «관측 지문의 범위를 DONE 줄까지로 축소»로 갈아탔다 -> 1R
// 우회는 닫혔지만, `resolveHeadCommitBinding`(HYK-383)은 여전히
// resultContent «전체»를 다시 스캔했다 -- 지문 밖(DONE 줄 뒤)에 올바른
// head_commit: 을 새로 덧붙이면 지문은 그대로인 채 그 게이트만 통과했다
// (2R 검토자 실측 재현, coder-task.md §9 원문. 이 시나리오를 B″로
// 부른다).
//
// 3R은 이 공통 뿌리를 정면으로 다룬다: `resolveDoneAt`이 계산하는
// `judgedRegion`(resultContent를 `>>> DONE:` 줄이 끝나는 지점까지 자른
// 것)을 ⓐ 관측 지문과 ⓑ resultContent의 «값»을 읽는 모든 게이트
// (headCommitVerdict/runnerReceiptVerdict의 claim 확인)에 «같은 값»으로
// 넘긴다 -- 지문이 보호하는 범위와 게이트가 읽는 범위를 하나로 통일해,
// "어느 게이트가 거부했는가"·"지문 범위를 얼마나 좁히는가"와 무관하게
// 이 범위-불일치 자체가 구조적으로 성립하지 않게 만든다. DONE 줄 자신은
// 여전히, 그리고 이 축과 별도로, checkIntermediateRewrite가 문자열로
// 직접 비교한다(first-observation.mjs, 1R 이전부터 있던 기존 메커니즘 --
// 이번에도 손대지 않았다).
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtempSync(tmpdir())로 만든
// 격리 사본이다(coder-task.md §0). ★★HYK-428 재발 방지: REVIEW-family
// fixture는 반드시 «독립 git init» 워크트리 안에서만 만든다 -- 이
// 워크트리 자신이나 그 파생 임시 워크트리를 가리키게 하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveRunnerReceiptVerdict,
  RUNNER_RECEIPT_REJECT_REASON,
  parseKstTimestamp,
  TIME_AUTHORITY_STATE,
} from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = [
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "time-authority.mjs",
  // HYK-423 2R: unlike the 1R-era mutation harnesses this file borrows the
  // pattern from, these mutants must exercise the REAL observation channel
  // across two polls (spawnObserveDoneLine execFileSync-spawns this file as
  // a sibling of the mutated relay-handshake.mjs) -- without it, the spawn
  // silently fails (non-fatal by design) and observation is never recorded
  // at all, making mut-2 pass for the wrong reason (no comparison ever
  // happens, not because protectedScope is doing its job).
  "first-observation.mjs",
];

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "hyk423 test fixture"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function writeReceipt(dir, receipt) {
  writeFileSync(
    join(dir, "runner-receipt.json"),
    JSON.stringify(receipt, null, 2),
    "utf8",
  );
}

function baseReceipt(headCommit, overrides = {}) {
  return {
    schema_version: 1,
    runner_exit: 0,
    tests: 10,
    pass: 10,
    fail: 0,
    skip: 0,
    head_commit: headCommit,
    finished_at: "2026-09-03 06:09:00 KST",
    ...overrides,
  };
}

// HYK-414/HYK-387 실측(다른 파일들이 이미 겪은 함정): `now`를 벽시계에
// 맡기면 checkTimezoneMislabel 창(픽스처 값과 정확히 9시간 ±10분)에 도는
// 순간에만 flaky해진다 -- 이 파일의 모든 픽스처는 고정 now를 쓴다.
const DROPPED_AT_TEXT = "2026-09-03 06:00 KST";
const DONE_AT_TEXT = "2026-09-03 06:10:00 KST";
const DONE_AT_TEXT_2 = "2026-09-03 06:11:00 KST"; // B′ 재현에서만 쓴다 (DONE 줄 자체를 바꾼다)
const FIXED_NOW_MS = parseKstTimestamp("2026-09-03 06:15:00 KST").getTime();

// preBody: DONE 줄보다 «앞»에 오는 본문(지문 보호 구역 안). postBody: DONE
// 줄보다 «뒤»에 붙는 후기(지문 보호 구역 밖, 1R 이전부터 있던
// done_stamped_by 마커와 같은 자리) -- 기본값 없음(""이면 그냥 마커 다음
// 줄바꿈만).
function writeCoderRound(
  dir,
  taskId,
  { preBody = "", doneAt = DONE_AT_TEXT, postBody = "" },
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${DROPPED_AT_TEXT}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${preBody}\n>>> DONE: CODER @ ${doneAt}\ndone_stamped_by: finalize-done\n${postBody}`,
    "utf8",
  );
}

// HYK-423 3R B″ fixture: REVIEW-family(headCommitVerdict가 적용되는 유일한
// role 계열)용. `headCommitLineBefore`는 DONE 줄보다 «앞»(judgedRegion
// 안), `headCommitLineAfter`는 DONE 줄보다 «뒤»(judgedRegion 밖, 2R
// 검토자가 정확히 이 자리에 붙여 우회를 재현했다)에 놓인다. task-task.md
// 의 head_commit은 항상 실제 HEAD(sha)와 같게 둬 축 ⓐ(지정 대조)가 저절로
// 통과하게 만든다 -- 이 시험이 확인하려는 것은 축 ⓑ/스캔 범위이지 축 ⓐ가
// 아니다.
// ⛔★실사고 재발 방지(HYK-428과 같은 계열, 이번엔 이 시험 자신이 냈다):
// REVIEW round가 ok:true로 소비되면 relay-handshake.mjs의
// autoRecordRejectStreak가 reject-streak.json에 기록을 «시도»한다 -- 그
// 파일의 경로는 harnessDir가 아니라 mainRepoRoot()(=이 테스트 «프로세스
// 자신»의 cwd에서 git으로 거슬러 올라간 결과)로 정해진다. 이 fixture가
// 이 워크트리 안에서 in-process로 checkRelayHandshake를 직접 부르면,
// mainRepoRoot()는 (이 워크트리가 linked worktree이므로) 실제 메인
// 클론을 가리켜 그 «라이브» reject-streak.json에 가짜 줄을 쓴다(실측
// 확인: HYK-423 streak가 13까지 오염됨, 2026-09-04). 그래서 REVIEW-family
// 검증은 반드시 `runReviewCli`로 «별도 프로세스를 이 fixture 디렉터리
// 자신을 cwd로» 스폰한다 -- mainRepoRoot()가 그 프로세스 자신의 cwd(=
// dir, 독립 git init)로 자기완결적으로 좁혀지므로 실물 원장을 건드릴
// 경로 자체가 없다. `.harness/`를 미리 만들어 두는 것도 이 이유(쓰기
// 자체가 성공해 자기 안에서 끝나야 한다, ENOENT로 죽으면 안 된다).
function writeReviewRound(
  dir,
  taskId,
  sha,
  {
    headCommitLineBefore = "",
    doneAt = DONE_AT_TEXT,
    headCommitLineAfter = "",
  },
) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${DROPPED_AT_TEXT}\nhead_commit: ${sha}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "review.md"),
    `task_id: ${taskId}\nverdict: rejected\n${headCommitLineBefore}\n>>> DONE: REVIEW @ ${doneAt}\ndone_stamped_by: finalize-done\n${headCommitLineAfter}`,
    "utf8",
  );
}

// runReviewCli: spawns relay-handshake.mjs's own CLI entry point with
// `cwd: dir` set explicitly -- see writeReviewRound's header for why this,
// not an in-process call, is the only safe way to exercise a REVIEW-family
// round in this file. `scriptPath` lets (mut-3) point this at a mutated
// clone instead of the real relay-handshake.mjs.
function runReviewCli(scriptPath, dir) {
  const res = spawnSync(process.execPath, [scriptPath, "review", dir], {
    cwd: dir,
    encoding: "utf8",
    env: isolatedChildEnv(),
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
// 시나리오 A: 게이트가 거부 -> 워커가 «DONE 뒤에» 정당하게 정정 -> 다시
// 소비하면 성공. (완료조건1, coder-task.md §3-1) -- 2026-09-03 실물 사고의
// 정정("결과 파일에 덧붙임")과 같은 모양: DONE 줄은 그대로, 그 뒤에
// 재실행 결과를 적는다.
// ---------------------------------------------------------------------------
test("(A1)★ 시나리오 A: 러너 영수증 RED로 거부 -> DONE 뒤에 재실행 결과를 덧붙여 정정(DONE 줄·그 앞 본문은 그대로) -> 다음 폴 소비 성공", () => {
  withFixtureDir("hyk423-a1-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-A1";

    // Poll #1: 파이프가 숨긴 빨간 실행 -- 결과 파일은 exit=0을 신고하지만
    // 영수증은 진실(runner_exit=1)을 담고 있다. 첫 관측은 여기서 박힌다.
    writeCoderRound(dir, taskId, {
      preBody: 'npm test; echo "exit=$?"\nexit=0',
    });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1, fail: 3, pass: 7 }));
    const poll1 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(poll1.ok, false, "poll1 must be rejected by the RED gate");
    assert.equal(poll1.code, RUNNER_RECEIPT_REJECT_REASON.RED);

    // 정당한 정정: 워커가 저부하로 실제 재실행해 초록을 받는다. DONE 줄과
    // 그 앞 본문(preBody -- exit= 주장 줄)은 «전혀 손대지 않는다» -- 오직
    // DONE 뒤(postBody)에 재실행 결과를 덧붙이고, 별도 파일인 영수증만
    // 고친다.
    writeCoderRound(dir, taskId, {
      preBody: 'npm test; echo "exit=$?"\nexit=0',
      postBody: "retry note: low-load rerun confirmed green\n",
    });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));

    const poll2 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS + 60_000,
    });
    assert.equal(
      poll2.ok,
      true,
      `DONE 뒤 정정 후 재소비는 성공해야 한다: ${JSON.stringify(poll2)}`,
    );
  });
});

test("(A2) resolveRunnerReceiptVerdict 직접 확인: 게이트 자신은 초록 영수증을 그대로 통과시킨다(게이트 로직 자체는 이 라운드가 건드리지 않았다)", () => {
  withFixtureDir("hyk423-a2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));
    const r = resolveRunnerReceiptVerdict({
      resultContent: 'npm test; echo "exit=$?"\nexit=0',
      harnessDir: dir,
    });
    assert.equal(r.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 시나리오 B: 관측이 정당하게 박힌 뒤 결과 파일이 몰래 바뀜(DONE 줄 자체가
// 바뀐다) -> 여전히 거부. (완료조건2, coder-task.md §3-2)
// ---------------------------------------------------------------------------
test("(B1)★ 시나리오 B: STALE로 거부된 뒤 DONE 줄을 몰래 다시 찍어도 -- 여전히 거부(DONE_REWRITTEN_AFTER_FIRST_OBSERVATION)", () => {
  withFixtureDir("hyk423-b1-", (dir) => {
    const taskId = "HYK-423-B1";
    const droppedAtText = "2026-09-03 10:00 KST";
    const now = parseKstTimestamp("2026-09-03 10:20:00 KST").getTime();

    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: ${droppedAtText}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-09-03 09:50:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll1 = checkRelayHandshake({ role: "coder", harnessDir: dir, now });
    assert.equal(poll1.ok, false);
    assert.equal(poll1.state, "STALE_DONE_PREDATES_DROP");

    writeFileSync(
      join(dir, "coder.md"),
      `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-09-03 10:05:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: now + 60_000,
    });
    assert.equal(poll2.ok, false);
    assert.equal(
      poll2.state,
      TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
    );
  });
});

// ---------------------------------------------------------------------------
// 시나리오 B′(2R 신설, 이번 P1의 직접 재현): 워커가 «거부를 유도»(영수증
// 부재/red) -> DONE/결과를 바꿔치기 -> 다음 poll도 여전히 거부돼야 한다.
// ★검토자가 재현에 쓴 것과 같은 모양(첫 poll RUNNER_RECEIPT_MISSING ->
// DONE 시각 변경 + 녹색 영수증 추가 -> 둘째 poll)을 그대로 재현한다.
// ---------------------------------------------------------------------------
test("(B′1)★★ 시나리오 B′ (검토자 재현과 동일 모양): 영수증 부재로 거부 유도 -> DONE 시각 변경 + 녹색 영수증 바꿔치기 -> 여전히 거부(우회 안 됨)", () => {
  withFixtureDir("hyk423-bprime1-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-BPRIME-1";

    // Poll #1: 영수증을 아예 안 만든다(워커가 «스스로» 만들 수 있는 거부
    // -- 그냥 영수증 파일을 안 쓰면 된다). DONE은 06:10:00.
    writeCoderRound(dir, taskId, {
      preBody: 'npm test; echo "exit=$?"\nexit=0',
      doneAt: DONE_AT_TEXT,
    });
    const poll1 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(poll1.ok, false);
    assert.equal(poll1.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);

    // 바꿔치기: DONE 시각을 06:10:00 -> 06:11:00으로 바꾸고(검토자 재현과
    // 동일), 녹색 영수증을 새로 추가한다.
    writeCoderRound(dir, taskId, {
      preBody: 'npm test; echo "exit=$?"\nexit=0',
      doneAt: DONE_AT_TEXT_2,
    });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));

    const poll2 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS + 120_000,
    });
    assert.equal(
      poll2.ok,
      false,
      `B′ 우회가 다시 열리면 안 된다(수리 전 검토자 재현: ok:true였다): ${JSON.stringify(
        poll2,
      )}`,
    );
    assert.equal(
      poll2.state,
      TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
      `DONE 시각이 바뀌었으므로 게이트 무관하게 rewritten으로 잡혀야 한다: ${JSON.stringify(
        poll2,
      )}`,
    );
  });
});

test("(B′2) 시나리오 B′ 변형: RED(러너 exit 조작)로 거부 유도 -> DONE 시각 변경 + 녹색 영수증 바꿔치기 -> 여전히 거부", () => {
  withFixtureDir("hyk423-bprime2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-BPRIME-2";

    // Poll #1: 워커가 자기 워크트리에서 시험을 깨서(또는 파이프로 숨겨서)
    // RED를 유도한다 -- coder-task.md §2⑴의 힌트 그대로, 워커가 스스로
    // 만들 수 있는 거부.
    writeCoderRound(dir, taskId, {
      preBody: 'npm test; echo "exit=$?"\nexit=0',
      doneAt: DONE_AT_TEXT,
    });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1, fail: 1, pass: 9 }));
    const poll1 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(poll1.ok, false);
    assert.equal(poll1.code, RUNNER_RECEIPT_REJECT_REASON.RED);

    writeCoderRound(dir, taskId, {
      preBody: 'npm test; echo "exit=$?"\nexit=0',
      doneAt: DONE_AT_TEXT_2,
    });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));

    const poll2 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS + 120_000,
    });
    assert.equal(poll2.ok, false);
    assert.equal(
      poll2.state,
      TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
    );
  });
});

// ---------------------------------------------------------------------------
// 시나리오 B″(3R 신설, 2R P1의 직접 재현): 워커가 «거부를 유도»(head_commit
// 누락) -> 관측은 손대지 않고 DONE «뒤»에 표지를 덧붙여 다른 검사기만
// 통과시키려는 시도 -> 여전히 거부돼야 한다. ★검토자가 쓴 것과 같은 모양
// (첫 poll에서 head_commit 누락 -> 거부 -> DONE 뒤에 올바른 head_commit
// 추가 -> 둘째 poll)이 반드시 표본에 포함된다.
// ---------------------------------------------------------------------------
test("(B″1)★★★ 시나리오 B″ (2R 검토자 재현과 동일 모양): head_commit 누락으로 거부 유도 -> DONE 뒤에 올바른 head_commit을 덧붙임 -> 여전히 거부(judgedRegion 밖이라 검사기가 못 본다)", () => {
  withFixtureDir("hyk423-bdprime1-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-BDPRIME-1";

    // Poll #1: head_commit 표지를 아예 쓰지 않는다(워커가 «스스로» 만들
    // 수 있는 거부 -- 그냥 그 줄을 안 쓰면 된다). DONE은 그대로 06:10:00.
    writeReviewRound(dir, taskId, sha, { doneAt: DONE_AT_TEXT });
    const poll1 = runReviewCli(RELAY_HANDSHAKE_PATH, dir);
    assert.notEqual(
      poll1.exit,
      0,
      "poll1 must be rejected by the head_commit gate",
    );
    assert.match(poll1.stderr, /missing head_commit header/);

    // 바꿔치기 시도: DONE 줄·그 앞 본문은 «전혀 손대지 않는다»(관측 지문도
    // 그대로) -- DONE «뒤»에 올바른 head_commit: 표지만 새로 덧붙인다.
    // 수리 전(2R) 코드에서는 headCommitVerdict가 resultContent 전체를
    // 다시 스캔해 이 표지를 찾아내 통과시켰다(2R 검토 재현, ok:true).
    writeReviewRound(dir, taskId, sha, {
      doneAt: DONE_AT_TEXT,
      headCommitLineAfter: `head_commit: ${sha}\n`,
    });
    const poll2 = runReviewCli(RELAY_HANDSHAKE_PATH, dir);
    assert.notEqual(
      poll2.exit,
      0,
      `B″ 우회가 다시 열리면 안 된다(수리 전 2R 검토 재현: exit 0이었다): ${JSON.stringify(
        poll2,
      )}`,
    );
    assert.match(
      poll2.stderr,
      /missing head_commit header/,
      `judgedRegion 밖(DONE 뒤)의 head_commit은 게이트가 아예 보지 못해야 한다 -- 여전히 «누락» 사유여야 한다: ${JSON.stringify(
        poll2,
      )}`,
    );
  });
});

test("(B″2) 대조군: head_commit을 DONE «앞»(judgedRegion 안)에 정당하게 두면 -- 정상 소비 성공(A가 이 축에서도 살아 있음을 확인)", () => {
  // ⚠️head_commit 게이트 자체가 judgedRegion «안»의 값은 여전히 정상
  // 인식한다는 것만 독립적으로 확인하는 단일 poll 대조군이다(B″1의
  // "누락 -> 거부 -> DONE 뒤 추가 -> 여전히 거부" 시퀀스와 달리, 첫 poll
  // 부터 정상 값을 준다 -- 첫 관측이 곧 이 값이므로 rewritten이 아예
  // 성립하지 않는다).
  withFixtureDir("hyk423-bdprime2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-BDPRIME-2";
    writeReviewRound(dir, taskId, sha, {
      doneAt: DONE_AT_TEXT,
      headCommitLineBefore: `head_commit: ${sha}\n`,
    });
    const poll = runReviewCli(RELAY_HANDSHAKE_PATH, dir);
    assert.equal(
      poll.exit,
      0,
      `judgedRegion 안(DONE 앞)의 head_commit은 정상 인식돼야 한다: ${JSON.stringify(poll)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (mut) 되돌림 변이 -- B′를 지키는 코드(관측-후-재판정 시 DONE 줄 자체를
// 비교하는 rewritten 가드)를 걷어내면 B′1이 다시 (잘못) 통과함을 증명한다.
// relay-handshake-runner-receipt.test.mjs의 (rr-e*) 되돌림 변이와 동일
// 관용구(메모리 문자열 치환 -> 격리 임시 파일에 씀 -> import, 원본은
// 절대 건드리지 않는다).
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

// HYK-423 2R: first-observation.mjs's own CLI entry point (the guard
// spawnObserveDoneLine's execFileSync actually invokes) only activates when
// `process.argv[1]` ends with the literal `scripts/check/first-observation.mjs`
// (see that file's own CLI-detection block) -- a flat copy directly inside
// mutDir silently produces NO stdout at all (the CLI guard never fires),
// which the parent's `JSON.parse(out.trim())` then fails on ("Unexpected
// end of JSON input"), swallowed as a non-fatal spawn failure -- so
// observation is NEVER recorded and a mutation test relying on the real
// observation channel passes for the wrong reason (nothing was ever
// compared). Nesting under `<mutDir>/scripts/check/` (mirroring this repo's
// real layout) is required for that CLI guard to trigger.
async function importMutatedRelayHandshake(mutatedSrc, label) {
  const mutDir = mkdtempSync(join(tmpdir(), `hyk423-mut-${label}-`));
  const scriptsCheckDir = join(mutDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(scriptsCheckDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  const mutPath = join(scriptsCheckDir, "relay-handshake.mjs");
  writeFileSync(mutPath, mutatedSrc, "utf8");
  const mod = await import(
    `file://${mutPath.replace(/\\/g, "/")}?t=${Date.now()}`
  );
  return { mod, mutDir };
}

test("(mut-1)★★ 되돌림 변이: rewritten 가드(checkRewriteAndStaleness의 observation.rewritten 분기) 자체를 제거하면 -- (B′1)의 바꿔치기가 다시 (잘못) 통과한다(RED, B′ 보호가 이 코드에 실제로 걸려 있다는 증거)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  if (observation?.rewritten) {\n" +
    "    return {\n" +
    "      ok: false,\n" +
    "      state: TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,\n" +
    "      reason: `result DONE line was rewritten between first observation and final judgment (HYK-257-done-stamp-2 §2 범위1): first observed '${observation.existing?.doneLineRaw}' (at ${observation.existing?.observedAtMs}ms), now judging '${observation.currentDoneLine}' -- 소비 직전 중간 수정이 감지되어 거부한다(즉시 거부, 경고 아님). 고치는 법: DONE을 다시 손으로 고치지 말고 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 한 번만 찍어라.`,\n" +
    "    };\n" +
    "  }\n";
  assertExactlyOneMatch(src, target, "rewritten guard block");
  const mutated = src.replace(target, "");
  assert.equal(mutated.length, src.length - target.length);

  const dir = mkdtempSync(join(tmpdir(), "hyk423-mut1-fixture-"));
  try {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-MUT1";
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: ${DROPPED_AT_TEXT}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: ${taskId}\nnpm test; echo "exit=$?"\nexit=0\n>>> DONE: CODER @ ${DONE_AT_TEXT}\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "1");
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(poll1.ok, false);
      assert.equal(poll1.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);

      writeFileSync(
        join(dir, "coder.md"),
        `task_id: ${taskId}\nnpm test; echo "exit=$?"\nexit=0\n>>> DONE: CODER @ ${DONE_AT_TEXT_2}\ndone_stamped_by: finalize-done\n`,
        "utf8",
      );
      writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));
      const poll2 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS + 120_000,
      });
      assert.equal(
        poll2.ok,
        true,
        "RED: rewritten 가드를 제거하면 B′ 바꿔치기가 (잘못) 통과해야 한다 -- 이 가드가 B′를 실제로 막고 있다는 증거",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

const PROTECTED_SCOPE_TARGET =
  "  const judgedRegion = resultContent.slice(\n" +
  "    0,\n" +
  "    doneMatch.index + doneMatch[0].length,\n" +
  "  );\n" +
  "  const observation =\n" +
  "    taskId && droppedAtRaw\n" +
  "      ? spawnObserveDoneLine({\n" +
  "          taskId,\n" +
  "          droppedAt: droppedAtRaw,\n" +
  "          role,\n" +
  "          harnessDir,\n" +
  "          resultContent: judgedRegion,\n" +
  "          doneLineRaw: doneMatch[0],\n" +
  "        })\n" +
  "      : { rewritten: false };\n";
// ⚠️단순 삭제가 아니라 `judgedRegion = resultContent`(전체, 자르지 않음)로
// 대체한다 -- `judgedRegion`은 이 블록 «뒤»(resolveDoneAt의 return문, 그리고
// mut-3이 겨냥하는 headCommitVerdict/runnerReceiptVerdict 호출부)에서도
// 참조되므로, 선언 자체를 지우면 그 참조들이 ReferenceError로 죽어 "지문만
// 원복" 대신 "모듈 자체가 깨짐"이 된다 -- 이 변이가 겨냥하는 축(지문 범위)
// 하나만 정확히 되돌리기 위한 선택이다.
const PROTECTED_SCOPE_REPLACEMENT =
  "  const judgedRegion = resultContent;\n" +
  "  const observation =\n" +
  "    taskId && droppedAtRaw\n" +
  "      ? spawnObserveDoneLine({\n" +
  "          taskId,\n" +
  "          droppedAt: droppedAtRaw,\n" +
  "          role,\n" +
  "          harnessDir,\n" +
  "          resultContent: judgedRegion,\n" +
  "          doneLineRaw: doneMatch[0],\n" +
  "        })\n" +
  "      : { rewritten: false };\n";

// HYK-423 2R: shared by (mut-2) below -- runs poll1 (RED) -> poll2 (DONE-뒤
// 정정) against a MUTATED module, and returns both verdicts for the caller
// to assert on. Extracted purely to stay under this repo's ESLint
// max-lines-per-function ceiling (HYK-148), same reason resolveHandshakeCore
// etc. were extracted in relay-handshake.mjs itself -- no behavior change.
async function runMutatedA1PollPair(mutated, label) {
  const dir = mkdtempSync(join(tmpdir(), `hyk423-mut${label}-fixture-`));
  try {
    const sha = ensureGitHeadCommit(dir);
    const taskId = `HYK-423-MUT${label}`;
    const writeRound = (postBody) =>
      writeFileSync(
        join(dir, "coder.md"),
        `task_id: ${taskId}\nnpm test; echo "exit=$?"\nexit=0\n>>> DONE: CODER @ ${DONE_AT_TEXT}\ndone_stamped_by: finalize-done\n${postBody}`,
        "utf8",
      );
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: ${DROPPED_AT_TEXT}\n`,
      "utf8",
    );
    writeRound("");
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1 }));

    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, label);
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      writeRound("retry note: low-load rerun confirmed green\n");
      writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));
      const poll2 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS + 60_000,
      });
      return { poll1, poll2 };
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(mut-2)★ 되돌림 변이: 관측 지문 범위를 DONE 줄 «전체 파일»로 되돌리면(=protectedScope를 원래 resultContent로) -- (A1)의 DONE-뒤 정당한 정정이 다시 (잘못) 영구 거부된다(RED, 지문 축소가 실제로 A1을 고치고 있다는 증거)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assertExactlyOneMatch(
    src,
    PROTECTED_SCOPE_TARGET,
    "protectedScope truncation block",
  );
  const mutated = src.replace(
    PROTECTED_SCOPE_TARGET,
    PROTECTED_SCOPE_REPLACEMENT,
  );
  assert.notEqual(mutated, src);

  const { poll1, poll2 } = await runMutatedA1PollPair(mutated, "2");
  assert.equal(poll1.ok, false);
  assert.equal(poll1.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  assert.equal(
    poll2.ok,
    false,
    "RED: protectedScope 축소가 없으면(전체 파일이 지문) DONE-뒤 정정도 다시 영구 거부돼야 한다 -- 이 축소가 A1을 실제로 고치고 있다는 증거",
  );
  assert.equal(
    poll2.state,
    TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
  );

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

// ---------------------------------------------------------------------------
// (mut-3, 3R 신설) 되돌림 변이 -- B″를 지키는 코드(headCommitVerdict가
// judgedRegion만 읽게 만든 축소)를 걷어내고 resultContent 전체를 다시
// 스캔하게 되돌리면, (B″1)의 DONE-뒤 head_commit 바꿔치기가 다시 (잘못)
// 통과함을 증명한다 -- coder-task.md §3-7이 요구하는 "B″를 지키는 코드를
// 되돌리면 B″ 시험이 RED" 변이.
// ---------------------------------------------------------------------------
const HEAD_COMMIT_JUDGED_REGION_TARGET =
  "  const headCommitVerdict = resolveHeadCommitBinding({\n" +
  "    role,\n" +
  "    taskContent,\n" +
  "    resultContent: judgedRegion,\n" +
  "    harnessDir,\n" +
  "  });\n" +
  "  if (!headCommitVerdict.ok) return headCommitVerdict;\n";
const HEAD_COMMIT_JUDGED_REGION_REPLACEMENT =
  "  const headCommitVerdict = resolveHeadCommitBinding({\n" +
  "    role,\n" +
  "    taskContent,\n" +
  "    resultContent,\n" +
  "    harnessDir,\n" +
  "  });\n" +
  "  if (!headCommitVerdict.ok) return headCommitVerdict;\n";

test("(mut-3)★★★ 되돌림 변이: headCommitVerdict가 다시 resultContent 전체를 스캔하게 되돌리면 -- (B″1)의 DONE-뒤 head_commit 바꿔치기가 다시 (잘못) 통과한다(RED, judgedRegion 통일이 이 코드에 실제로 걸려 있다는 증거)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assertExactlyOneMatch(
    src,
    HEAD_COMMIT_JUDGED_REGION_TARGET,
    "headCommitVerdict judgedRegion call site",
  );
  const mutated = src.replace(
    HEAD_COMMIT_JUDGED_REGION_TARGET,
    HEAD_COMMIT_JUDGED_REGION_REPLACEMENT,
  );
  assert.notEqual(mutated, src);

  // HYK-423 3R (실사고 재발 방지, writeReviewRound 헤더 참조): REVIEW round
  // 검증은 in-process import+호출이 아니라 CLI 스폰으로 한다 -- mut-1/mut-2
  // (CODER, autoRecordRejectStreak를 타지 않는다)와 달리 이 변이는 poll2가
  // (의도적으로) ok:true까지 가므로 reject-streak 기록을 시도한다;
  // in-process였다면 mainRepoRoot()가 이 테스트 프로세스의 cwd(=실제
  // 메인 클론)로 풀려 라이브 원장에 다시 쓴다. `importMutatedRelayHandshake`
  // 는 쓰지 않는다(그 헬퍼의 ESM import는 이 시나리오에 필요 없다) --
  // mutDir만 직접 만들고 그 안의 파일 경로를 CLI 스크립트로 스폰한다.
  const dir = mkdtempSync(join(tmpdir(), "hyk423-mut3-fixture-"));
  const mutDir = mkdtempSync(join(tmpdir(), "hyk423-mut-3-"));
  try {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-MUT3";
    writeReviewRound(dir, taskId, sha, { doneAt: DONE_AT_TEXT });

    const scriptsCheckDir = join(mutDir, "scripts", "check");
    mkdirSync(scriptsCheckDir, { recursive: true });
    for (const dep of SIBLING_DEPS) {
      writeFileSync(
        join(scriptsCheckDir, dep),
        readFileSync(join(HERE, dep), "utf8"),
        "utf8",
      );
    }
    const mutPath = join(scriptsCheckDir, "relay-handshake.mjs");
    writeFileSync(mutPath, mutated, "utf8");

    const poll1 = runReviewCli(mutPath, dir);
    assert.notEqual(poll1.exit, 0);
    assert.match(poll1.stderr, /missing head_commit header/);

    writeReviewRound(dir, taskId, sha, {
      doneAt: DONE_AT_TEXT,
      headCommitLineAfter: `head_commit: ${sha}\n`,
    });
    const poll2 = runReviewCli(mutPath, dir);
    assert.equal(
      poll2.exit,
      0,
      "RED: headCommitVerdict가 resultContent 전체를 다시 스캔하면 DONE 뒤 head_commit도 (잘못) 채택돼 통과해야 한다 -- judgedRegion 통일이 B″를 실제로 막고 있다는 증거",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});
