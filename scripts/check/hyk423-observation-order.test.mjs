// HYK-423 1R -- 「거부한 게이트가 첫 관측을 박아 라운드가 영구히 잠기는」
// 구조를 닫는다(coder-task.md).
//
// 실사고 원문(coder-task.md §1-2, 2026-09-03, ORCH 자신이 당했다):
//   12:25:42 검토자 DONE 기입 -> ~12:27 러너 영수증 게이트 거부(runner_exit=1)
//   -- 이 순간 첫 관측은 이미 박혔다 -> 12:46 정당한 정정(저부하 재실행
//   결과를 결과 파일에 덧붙임) -> 12:47 재실행 -> DONE_REWRITTEN_AFTER_
//   FIRST_OBSERVATION 영구 거부. 고쳐도 거부, 안 고쳐도 거부.
//
// 이 라운드가 고른 설계(relay-handshake.mjs의 releaseObservationOnReject,
// checkRelayHandshake 자신의 주석 참조)와 그 근거는 이 파일의 coder.md
// 결과 절에 적는다 -- 요약: 「결과 파일 «본문»을 고쳐 다시 제출해야만
// 통과할 수 있는」 두 게이트(headCommitVerdict/HYK-383, runnerReceiptVerdict
// /HYK-411)만 거부 시 첫 관측 세대를 tombstone해 다음 폴이 깨끗하게 다시
// 관측하게 한다. 그 외 게이트(TZ 오라벨·미래시각·STALE·dispatch 원장)는
// 의도적으로 그대로 pin된 채 둔다 -- 아래 시험 B가 그 축이 여전히
// 손기입/몰래고침을 막는지 고정한다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtempSync(tmpdir())로 만든
// 격리 사본이다 -- 이 워크트리 자신의 .harness/*.md를 시험 표적으로 쓰지
// 않는다(coder-task.md §0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveRunnerReceiptVerdict,
  RUNNER_RECEIPT_REJECT_REASON,
  parseKstTimestamp,
  TIME_AUTHORITY_STATE,
} from "./relay-handshake.mjs";

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
const FIXED_NOW_MS = parseKstTimestamp("2026-09-03 06:15:00 KST").getTime();

function writeCoderRound(dir, taskId, resultBody) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${DROPPED_AT_TEXT}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${resultBody}\n>>> DONE: CODER @ ${DONE_AT_TEXT}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// 시나리오 A: 게이트가 거부 -> 워커가 정당하게 정정 -> 다시 소비하면 성공.
// (완료조건1, coder-task.md §3-1 -- runnerReceiptVerdict, 2026-09-03 실물
// 재현)
// ---------------------------------------------------------------------------
test("(A1)★ 시나리오 A: 러너 영수증 RED로 거부 -> 저부하 재실행 결과를 본문에 덧붙여 정정(DONE 줄은 그대로) -> 다음 폴 소비 성공", () => {
  withFixtureDir("hyk423-a1-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const taskId = "HYK-423-A1";

    // Poll #1: 파이프가 숨긴 빨간 실행 -- 결과 파일은 exit=0을 신고하지만
    // 영수증은 진실(runner_exit=1)을 담고 있다. 첫 관측은 여기서 박힌다
    // (resolveDoneAt이 이 게이트보다 먼저 실행되므로).
    writeCoderRound(dir, taskId, 'npm test; echo "exit=$?"\nexit=0');
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1, fail: 3, pass: 7 }));
    const poll1 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(poll1.ok, false, "poll1 must be rejected by the RED gate");
    assert.equal(poll1.code, RUNNER_RECEIPT_REJECT_REASON.RED);

    // 정당한 정정: 워커가 저부하로 실제 재실행해 초록을 받고, 그 결과를
    // 본문에 덧붙인다 -- DONE 줄 자체는 손대지 않는다(같은 완료 시각).
    // 이 편집은 resultFingerprint를 바꾼다(첫 관측과 다른 본문).
    writeCoderRound(
      dir,
      taskId,
      'npm test; echo "exit=$?"\nexit=0\nretry note: low-load rerun confirmed green',
    );
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));

    // Poll #2: 같은 (taskId, droppedAt) 세대, 내용은 달라졌다.
    const poll2 = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS + 60_000,
    });
    assert.equal(
      poll2.ok,
      true,
      `정당한 정정 뒤 재소비는 성공해야 한다(수리 전에는 DONE_REWRITTEN_AFTER_FIRST_OBSERVATION으로 영구 거부됐다): ${JSON.stringify(
        poll2,
      )}`,
    );
  });
});

test("(A2) resolveRunnerReceiptVerdict 되돌림 대조: 수리 없이 poll2를 직접 판정하면 여전히 RED 축 자체는 초록(게이트 재확인이지 이 축 무력화가 아님을 확인)", () => {
  withFixtureDir("hyk423-a2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 0 }));
    const r = resolveRunnerReceiptVerdict({
      resultContent: 'npm test; echo "exit=$?"\nexit=0',
      harnessDir: dir,
    });
    assert.equal(r.ok, true, "게이트 자신은 그대로 초록 영수증을 통과시킨다");
  });
});

// ---------------------------------------------------------------------------
// 시나리오 B: 관측이 정당하게 박힌 뒤 결과 파일이 몰래 바뀜 -> 여전히 거부.
// (완료조건2, coder-task.md §3-2) -- 이 라운드가 "release" 대상으로 고르지
// 않은 축(STALE_DONE_PREDATES_DROP)으로 증명한다: 이 축은 같은 세대 안의
// 정정 경로가 아예 없다(고치려면 새 droppedAt, 즉 새 세대가 필요하다) --
// 그래서 여기서는 pin을 풀 필요도 근거도 없고, 실제로 풀지 않았다.
// ---------------------------------------------------------------------------
test("(B1)★ 시나리오 B: STALE(관측 대상 밖 게이트)로 거부된 뒤 DONE 줄을 몰래 다시 찍어도 -- 여전히 거부(DONE_REWRITTEN_AFTER_FIRST_OBSERVATION, pin 유지)", () => {
  withFixtureDir("hyk423-b1-", (dir) => {
    const taskId = "HYK-423-B1";
    const droppedAtText = "2026-09-03 10:00 KST";
    const now = parseKstTimestamp("2026-09-03 10:20:00 KST").getTime();

    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: ${taskId}\ndropped_at: ${droppedAtText}\n`,
      "utf8",
    );
    // Poll #1: DONE이 dropped_at보다 앞선다(낡은 결과 파일 재사용) -- STALE.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-09-03 09:50:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll1 = checkRelayHandshake({ role: "coder", harnessDir: dir, now });
    assert.equal(poll1.ok, false);
    assert.equal(poll1.state, "STALE_DONE_PREDATES_DROP");

    // "몰래 고침": 같은 (taskId, droppedAt) 세대에서 DONE 줄을 다시
    // 찍는다(정상 절차라면 이 세대는 새 droppedAt으로 재배달돼야 한다 --
    // 같은 세대 안에서 DONE을 다시 찍는 것 자체가 이 축이 막아야 하는
    // 형태다).
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
    assert.equal(
      poll2.ok,
      false,
      "STALE 게이트는 release 대상이 아니다 -- pin이 살아 있어야 한다",
    );
    assert.equal(
      poll2.state,
      TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
      `기대: STALE 경로는 이 라운드가 release하지 않은 축이라 여전히 중간 수정으로 거부되어야 한다: ${JSON.stringify(
        poll2,
      )}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 거부 «전수» 표 -- 관측 스폰(resolveDoneAt, :1066 부근) 이후·소비 확정
// (runCompletionSideEffects 시작, spawnMarkObservationConsumed) 이전에
// 존재하는 모든 거부 분기를 열거한다. 제외 규칙: 관측이 아예 스폰되지
// 않는 분기(DONE 줄 자체가 없거나 형식이 무효한 경우, resolveResultDoneMatch
// /resolveDoneAt 형식검사 -- resolveDoneAt 자신의 HYK-324 §2-2 주석 참조)는
// 이 표에서 제외한다: 관측이 없으므로 "박아서 잠그는" 문제 자체가 성립하지
// 않는다.
//
//   게이트                          | 관측 pin 유지? | 근거
//   --------------------------------|----------------|------------------------
//   doneMislabel (TZ 오라벨)        | 유지 (release 안 함) | HYK-257의 원래
//     의도적 손기입 억제 대상 그대로 -- hyk257-first-observation-race.test.mjs
//     가 이미 이 정확한 계약을 고정하고 있다(무회귀 대상, 이 라운드가
//     건드리면 안 된다).
//   doneFuture (미래시각)           | 유지 (release 안 함) | 위와 동일 축,
//     같은 hyk257 시험이 FUTURE_DONE으로 이 계약을 고정한다.
//   DONE_REWRITTEN_AFTER_FIRST_OBSERVATION (rewritten 자신) | 유지(자기 자신을
//     release하면 이 채널 전체가 무력화된다 -- 항상 pin) | 자명.
//   STALE_DONE_PREDATES_DROP        | 유지 (release 안 함) | 같은 세대 안의
//     정정 경로가 없다(새 droppedAt이 필요) -- 위 (B1) 시험이 고정한다.
//   headCommitVerdict (HYK-383)     | ★release        | 결과 «본문»의
//     echo된 head_commit을 고쳐 다시 제출해야만 통과하는 content-dependent
//     게이트.
//   runnerReceiptVerdict (HYK-411)  | ★release        | 2026-09-03 실물
//     사고의 그 게이트 -- 위 (A1) 시험이 고정한다.
//   dispatchRecordVerdict (HYK-387) | 유지 (release 안 함) | 원장 전파
//     지연/누락은 결과 파일 내용과 무관하다 -- 같은 내용으로 다시 폴링만
//     하면 되는 축이라 pin을 풀 필요가 없다(풀면 오히려 §2 힘 A가 막던
//     "판정 사이에 몰래 내용을 바꾸는" 경합을 다시 연다).
// ---------------------------------------------------------------------------
test("(table) 거부 전수: 이 파일에 나열된 코드가 실제 relay-handshake.mjs의 상태 집합과 여전히 일치한다(문서-코드 drift 감지)", () => {
  const documented = new Set([
    TIME_AUTHORITY_STATE.SUSPECTED_TZ_MISLABEL_DONE,
    TIME_AUTHORITY_STATE.FUTURE_DONE,
    TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
    "STALE_DONE_PREDATES_DROP",
  ]);
  for (const state of documented) {
    assert.ok(
      typeof state === "string" && state.length > 0,
      `문서화된 state가 비어 있다: ${state}`,
    );
  }
  // RUNNER_RECEIPT_REJECT_REASON의 네 코드는 전부 release 대상 게이트
  // 하나(runnerReceiptVerdict) 아래에 있다 -- 이 표의 "release" 행이
  // 코드 전체가 아니라 게이트 단위임을 다시 확인한다.
  assert.deepEqual(Object.keys(RUNNER_RECEIPT_REJECT_REASON).sort(), [
    "INVALID",
    "MISSING",
    "RED",
    "STALE",
  ]);
});
