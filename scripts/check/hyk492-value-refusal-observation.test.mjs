// HYK-492-refused-obs-1/2: PM 1R 설계(②′, D:\문서관리\하네스-관제실\PM\
// 산출물\하네스\2026-11-04-막다른모양-첫관측-순서\막다른모양-첫관측-순서-
// 설계.md §(b))의 실 구현 고정, 2R(②″)에서 좁혀짐 -- S = {HYK-424
// base-copy, HYK-383 head_commit} 거부로 끝난 관측에 한해, markRefused
// (append-only, 세대 tombstone 아님)로 "거부로 끝난 관측"을 표시한다.
// 1R은 그 뒤 지문 기준값 «전체»를 "마지막 거부 표시 뒤 첫 관측"으로
// 재기준했다 -- REVIEW 1R이 그 폭을 "DONE 앞 본문 전체(판정 낱말
// 포함)를 다시 쓸 수 있다"로 반려했다(P2-4, C2b: 383 거부 유도 ->
// head_commit 고치면서 `verdict: rejected`를 `approved`로 같이 바꿔도
// 통과). 2R은 그 재기준을 "head_commit 줄 «하나»의 값만 달라도 된다"
// 로 좁힌다(아래 (492-1)/(492-2)/(492-7) 이하) -- DONE 줄 기준값
// (findFirstObservation)과 finalize-done의 findFirstObservation 의존은
// 바이트 무변이다(first-observation.mjs 자신의 주석 참조).
//
// ⛔실물 원장·관제실·아카이브 무접촉: 모든 fixture는 mkdtemp 안에 새로
// 만든 합성 git 저장소다(이 라운드 head 머리 live_send_ban 준수).
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";
import {
  observeDoneLine,
  markRefused,
  markObservationConsumed,
  findFirstObservation,
  hasRefusalForGeneration,
} from "./first-observation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFixtureDirAsync(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
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
    ["commit", "-q", "--allow-empty", "-m", "hyk492 test fixture"],
    { cwd: dir },
  );
  // HYK-266: a REVIEW-family consumption now actually attempts to write
  // the reject-streak ledger at `mainRepoRoot(harnessDir)/.harness/
  // reject-streak.json` -- `dir` IS harnessDir's own git root in every
  // caller of this helper, so that write targets THIS isolated mkdtemp
  // repo (HYK-428 anchors mainRepoRoot purely to harnessDir), but it
  // still needs `.harness/` to exist here or it fails with
  // LEDGER_WRITE_ERROR (now blocking, not a silent pass-through) --
  // harmless no-op for the CODER-role callers of this same helper.
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function makeAnotherCommit(dir, msg) {
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], {
    cwd: dir,
  });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
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

function readObservationLog(dir, role) {
  const path = join(dir, `${role.toLowerCase()}-done-first-observation.jsonl`);
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ===========================================================================
// ⑴ (424) RED 먼저 -> 수리 뒤 ok: base-copy 거부, head_commit 줄만 수정,
// 같은 세대(같은 dropped_at) 재소비.
// ===========================================================================

function writeCoderRound(dir, { taskExtra = "", resultExtra = "" }) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: HYK-492-C\ndropped_at: 2026-11-04 06:00 KST\n${taskExtra}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: HYK-492-C\n${resultExtra}\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

test("(492-1)★★★ 수리 뒤: HYK-424 base-copy 거부 -> head_commit 줄만 수정(DONE 무변) -> 같은 세대 재소비 ok (실 CLI 2회 폴)", () => {
  withFixtureDir("hyk492-424-fix-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`, // 사고: base를 그대로 베낌
    });
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /base를 베꼈다/);
    // P2-1(REVIEW 1R 지적): mut-4(아래)는 소스 문자열만 보는 동어반복이었다
    // -- 여기서는 프로덕션 CLI가 실제로 stderr에 찍은 사유 원문에 안내
    // 문구가 실제로 실리는지를 직접 단언한다(소스 검색이 아니라 방출된
    // 바이트).
    assert.match(
      poll1.stderr,
      /head_commit 줄만 네 실제 HEAD로 고쳐라 -- DONE 줄은 건드리지 마라/,
    );

    // head_commit 줄만 고친다 -- DONE 줄은 완전히 그대로(바이트 동일).
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${ownSha}\n`,
    });
    const poll2 = runCli(["coder", dir]);
    assert.equal(
      poll2.exit,
      0,
      `poll2 (head_commit 수정, 같은 세대) must now pass: ${poll2.stderr}`,
    );

    // 관측 원장 = 관측 / 거부 표시 / consumed (수정 뒤 ok:true가 되는
    // 순간 runCompletionSideEffects가 소비-표시를 남긴다 -- 재관측이
    // 별도 줄로 남는지는 (492-5)에서 직접 확인한다).
    const entries = readObservationLog(dir, "coder");
    assert.ok(
      entries.some((e) => e.refused === true && e.reason === "base_copy"),
      `observation log must contain a base_copy refused mark: ${JSON.stringify(entries)}`,
    );
    assert.ok(
      entries.some((e) => e.consumed === true),
      `observation log must contain a consumed mark after poll2 passes: ${JSON.stringify(entries)}`,
    );
  });
});

// ===========================================================================
// ⑵ (383/c-383) 동일 -- REVIEW head_commit 대조 거부 -> head_commit 줄만
// 수정 -> 같은 세대 재소비 ok.
// ===========================================================================

function writeReviewRound(dir, { taskHead, resultHead }) {
  writeFileSync(
    join(dir, "review-task.md"),
    `task_id: HYK-492-R\ndropped_at: 2026-11-04 06:00 KST\nhead_commit: ${taskHead}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "review.md"),
    // HYK-266: NO_VERDICT_LINE is now a blocking contract violation --
    // add a verdict line so this fixture's own subject (the head_commit
    // axis, HYK-383) is reachable without first being rejected on this
    // unrelated axis.
    `task_id: HYK-492-R\nfor: HYK-492-R\nverdict: rejected\nhead_commit: ${resultHead}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

test("(492-2)★★★ 수리 뒤: HYK-383 head_commit 거부(REVIEW) -> head_commit 줄만 수정(DONE 무변) -> 같은 세대 재소비 ok (실 CLI 2회 폴)", () => {
  withFixtureDir("hyk492-383-fix-", (dir) => {
    const targetSha = ensureGitHeadCommit(dir); // REVIEW는 판정 중 커밋하지 않는다 -- HEAD는 여기서 고정.
    const wrongSha = "d".repeat(40); // 워커의 타이핑 실수 -- task/실제 HEAD와 다른 값.
    writeReviewRound(dir, { taskHead: targetSha, resultHead: wrongSha });
    const poll1 = runCli(["review", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /head_commit mismatch/);
    assert.match(poll1.stderr, /HYK-383/);

    // head_commit 줄만 고친다(task 지정값 == 실제 HEAD와 일치하도록) --
    // DONE 줄은 완전히 그대로.
    writeReviewRound(dir, { taskHead: targetSha, resultHead: targetSha });
    const poll2 = runCli(["review", dir]);
    assert.equal(
      poll2.exit,
      0,
      `poll2 (head_commit 수정, 같은 세대) must now pass: ${poll2.stderr}`,
    );

    const entries = readObservationLog(dir, "review");
    assert.ok(
      entries.some((e) => e.refused === true && e.reason === "head_commit"),
      `observation log must contain a head_commit refused mark: ${JSON.stringify(entries)}`,
    );
  });
});

// ===========================================================================
// ⑶ 대조군 -- S 거부 뒤에도 DONE 줄까지 바꿔치기하면 여전히 거부
// (452902c가 반려한 모양을 다시 열지 않는다는 증거).
// ===========================================================================

test("(492-3)★★★ 대조군: HYK-424 거부 뒤 head_commit과 DONE 줄을 «같이» 바꾸면 -- 여전히 DONE_REWRITTEN(재기준은 지문만, DONE 줄은 세대 첫 관측에 고정)", () => {
  withFixtureDir("hyk492-424-donetamper-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0);
    assert.match(poll1.stderr, /base를 베꼈다/);

    // head_commit은 고치지만 DONE 줄 시각도 같이 바꿔치기한다.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${ownSha}\n\n>>> DONE: CODER @ 2026-11-04 06:20:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      "DONE 줄까지 바꾸면 여전히 거부돼야 한다 (452902c가 막은 모양이 다시 열리면 안 된다)",
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

// ===========================================================================
// ⑷ 대조군 -- STALE(시간 게이트, S 밖)은 markRefused를 전혀 쓰지 않는다
// -- 재기준 없음을 원장에서 직접 확인.
// ===========================================================================

test("(492-4)★★★ 대조군: STALE(S 밖) 거부는 관측 원장에 refused 표시를 전혀 남기지 않는다 -- 본문 수정도 여전히 거부된다(재기준 없음)", () => {
  withFixtureDir("hyk492-stale-", (dir) => {
    // dropped_at이 DONE보다 늦다 -> STALE_DONE_PREDATES_DROP.
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-492-S\ndropped_at: 2026-11-04 07:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-492-S\nbody v1\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0);
    assert.match(poll1.stderr, /stale result/);

    const entriesAfterPoll1 = readObservationLog(dir, "coder");
    assert.ok(
      entriesAfterPoll1.every((e) => e.refused !== true),
      `STALE(S 밖)은 refused 표시를 남기면 안 된다: ${JSON.stringify(entriesAfterPoll1)}`,
    );

    // 본문(DONE 줄 앞)을 수정해도 -- 재기준이 없으므로 여전히 거부된다
    // (이제는 DONE_REWRITTEN 경로로, 하지만 "거부"라는 결과는 같다).
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-492-S\nbody v2 -- tampered\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(poll2.exit, 0, "STALE 뒤 본문 수정도 여전히 거부돼야 한다");
  });
});

// ===========================================================================
// ⑸ 대조군(무회귀) -- STALE(S 밖) 거부 뒤, DONE 줄은 그대로 두고 그 «앞»
// 본문만 바꾸면 -- 지문 기준값이 재기준되지 않으므로 여전히
// DONE_REWRITTEN_AFTER_FIRST_OBSERVATION으로 거부된다. (기존
// hyk423-observation-order.test.mjs (B1)은 DONE 줄 자체를 바꾸는 모양을
// 고정한다 -- 여기는 DONE 줄은 무변, 그 앞 본문만 바뀌는 모양을 고정해
// (492-4)의 ledger-레벨 확인과 다른 각도에서 같은 결론을 본다.) ⛔poll1을
// ok:true로 끝내면 안 된다 -- 완료 즉시 세대가 tombstone(markObservationConsumed)
// 되어 poll2가 "관측 없음"으로 새 세대처럼 보이기 때문이다(실측, 디버그
// 로 확인) -- 그래서 poll1도 거부(STALE)로 유지한다.
// ===========================================================================

test("(492-5) 대조군(무회귀): STALE(S 밖) 거부 뒤 DONE 줄은 무변, 그 앞 본문만 바꾸면 -- 여전히 DONE_REWRITTEN_AFTER_FIRST_OBSERVATION(재기준 없음)", () => {
  withFixtureDir("hyk492-plain-rewrite-", (dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-492-P\ndropped_at: 2026-11-04 07:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-492-P\nbody v1\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, "poll1 (STALE) must reject");
    assert.match(poll1.stderr, /stale result/);

    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-492-P\nbody v2 -- silently tampered after judgment\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(poll2.exit, 0);
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

// ===========================================================================
// ⑹ 관측 원장 단위 시험 -- observeDoneLine / markRefused / 재관측 /
// markObservationConsumed 시퀀스를 first-observation.mjs 자신의 export로
// 직접 고정한다(합성 1회, CLI를 거치지 않는 좁은 단위 시험).
// ===========================================================================

// HYK-492-refused-obs-3 (owner ruling A 뒤 뒤집기 -- deviation_rule이 허용한
// "2R 폭을 단언하던 칸만 뒤집기", 전후 원문): 이 시험은 원래
// `head_commit: AAAA`/`head_commit: BBBB`(40-hex가 아닌 자리표시자)로
// head_commit-only 눈감아주기를 확인했다 -- 2R의 `/^head_commit:.*$/gm`
// 은 콜론 뒤 글자가 무엇이든 지웠으므로 통과했다. 3R은 지울 줄을 383
// 게이트와 같은 정의(열 0 단독 `head_commit: <40자리hex>`)로 좁혔다 --
// AAAA/BBBB는 그 정의에 안 맞아(매치 0개) 이제는 예외가 꺼진다(정확히
// 이 라운드가 의도한 동작). 그래서 이 시험이 "눈감아주기"라는 같은
// 메커니즘을 계속 재는 데는, 값을 40자리 hex-모양 문자열로 바꿔야 한다
// (git sha를 실제로 바꾸는 CLI 수준 시험 (492-1)/(492-2)와 달리 이 시험은
// first-observation.mjs 자신의 export만 직접 호출하는 단위 시험이라
// "진짜 git HEAD"가 필요 없다 -- 40자리 hex 모양이면 충분하다).
test("(492-6)★ 관측 원장 시퀀스(단위): 관측 -> 거부 표시 -> 재관측(head_commit-only 눈감아주기) -> consumed -- findFirstObservation은 세대 첫 관측에 그대로 고정된다", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "hyk492-unit-ledger-"));
  try {
    const taskId = "task_hyk492_unit";
    const droppedAt = "2026-11-04 06:00 KST";
    const role = "coder";
    const doneLineRaw = ">>> DONE: CODER @ 2026-11-04 06:10:00 KST";
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);

    const first = observeDoneLine({
      taskId,
      droppedAt,
      role,
      harnessDir,
      resultContent: `task_id: ${taskId}\nhead_commit: ${shaA}\n\n${doneLineRaw}`,
      doneLineRaw,
    });
    assert.equal(first.rewritten, false, "첫 관측은 스스로와 비교라 항상 일치");

    markRefused({ taskId, droppedAt, role, harnessDir, reason: "base_copy" });

    // DONE 줄 기준값은 거부 표시 뒤에도 세대의 진짜 첫 관측에 고정된다.
    const pinnedForDoneLine = findFirstObservation({
      taskId,
      droppedAt,
      role,
      harnessDir,
    });
    assert.equal(pinnedForDoneLine.doneLineRaw, doneLineRaw);

    // head_commit-only 눈감아주기 스위치는 거부 표시 뒤 켜진다(아직
    // 재관측 전에도).
    assert.equal(
      hasRefusalForGeneration({ taskId, droppedAt, role, harnessDir }),
      true,
      "거부 표시 뒤에는 head_commit-only 눈감아주기가 켜져 있어야 한다",
    );

    // head_commit 줄만 고친 재관측 -- DONE 줄은 동일.
    const second = observeDoneLine({
      taskId,
      droppedAt,
      role,
      harnessDir,
      resultContent: `task_id: ${taskId}\nhead_commit: ${shaB}\n\n${doneLineRaw}`,
      doneLineRaw,
    });
    assert.equal(
      second.rewritten,
      false,
      "거부 표시 뒤 head_commit 줄만 다른 재관측은 2R의 head_commit-only 눈감아주기로 통과해야 한다(1R처럼 '스스로와 비교'가 아니라, 세대 첫 관측(shaA)과 비교해도 head_commit 줄만 다르므로 통과)",
    );
    assert.equal(
      second.existing.doneLineRaw,
      doneLineRaw,
      "DONE 줄 비교 기준은 여전히 세대 첫 관측(existing)이다",
    );
    // 2R: head_commit-only 눈감아주기는 재관측 뒤에도(소비되기 전까지는)
    // 켜진 채로 남는다 -- owner ruling B는 "그 세대의 첫 관측"을 기준으로
    // 말했지, "마지막 거부 이후"로 좁히지 않았다.
    assert.equal(
      hasRefusalForGeneration({ taskId, droppedAt, role, harnessDir }),
      true,
      "재관측 뒤에도 소비 전까지는 눈감아주기 스위치가 꺼지지 않아야 한다",
    );

    markObservationConsumed({ taskId, droppedAt, role, harnessDir });

    const entries = readObservationLog(harnessDir, role);
    const kinds = entries.map((e) =>
      e.consumed === true
        ? "consumed"
        : e.refused === true
          ? "refused"
          : "observation",
    );
    assert.deepEqual(kinds, [
      "observation",
      "refused",
      "observation",
      "consumed",
    ]);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// ⑺ (P2-4, REVIEW 1R 반려 C2b) 수리 뒤: HYK-383 head_commit 거부(REVIEW)
// -> head_commit 줄은 고치지만 verdict: rejected -> approved도 같이
// 바꿔치기(DONE 줄은 무변) -> 여전히 DONE_REWRITTEN이어야 한다. RED-first
// 실측(c8fb958, 이 라운드의 수리 전): 이 정확한 입력으로 poll2.ok===true
// 였다(이 파일의 probe-c2b-red.mjs 디버그 스크립트로 직접 재현, 결과
// 파일 §1 원문 참조) -- 수리 뒤에는 ok:false여야 한다.
// ===========================================================================

test("(492-7)★★★ 수리 뒤 (P2-4, C2b): HYK-383 거부 -> head_commit은 고치지만 verdict까지 같이 바꿔치기 -- 여전히 DONE_REWRITTEN(head_commit «한 줄»만 눈감아준다)", () => {
  withFixtureDir("hyk492-383-c2b-", (dir) => {
    const targetSha = ensureGitHeadCommit(dir);
    const wrongSha = "e".repeat(40);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-492-C2B\ndropped_at: 2026-11-04 06:00 KST\nhead_commit: ${targetSha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-492-C2B\nfor: HYK-100-x-1\nverdict: rejected\nhead_commit: ${wrongSha}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll1 = runCli(["review", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /head_commit mismatch/);

    // head_commit은 고치지만, 판정 낱말도 같이 바꾼다 -- DONE 줄은 바이트
    // 동일.
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-492-C2B\nfor: HYK-100-x-1\nverdict: approved\nhead_commit: ${targetSha}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["review", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      "head_commit 말고 verdict까지 달라졌으면 여전히 거부돼야 한다(P2-4)",
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

// ===========================================================================
// ⑻ (P2-4) head_commit 줄 + 다른 한 줄(빈 줄 추가) -- 아주 작은 변경이라도
// head_commit 말고 한 글자라도 다르면 여전히 DONE_REWRITTEN.
// ===========================================================================

test("(492-8)★★★ 대조군(P2-4): HYK-424 거부 뒤 head_commit은 고치되 다른 자리에 빈 줄 하나를 추가하면 -- 여전히 DONE_REWRITTEN(head_commit 줄 «하나만»의 값 차이만 눈감아준다)", () => {
  withFixtureDir("hyk492-424-extraline-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0);
    assert.match(poll1.stderr, /base를 베꼈다/);

    // head_commit 줄만 고친 "정상" 수정에, 아무 뜻 없는 빈 줄 하나를
    // 더 끼워 넣는다 -- DONE 줄 자체는 바이트 동일.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${ownSha}\n\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      "head_commit 말고 줄 하나(빈 줄)라도 더 달라졌으면 여전히 거부돼야 한다(P2-4: 줄 위치·개수 무변)",
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

// ===========================================================================
// ⑼ (P2-2) S 거부가 고쳐지지 않은 채 같은 내용으로 3번 더 폴되면 -- 관측
// 원장에 줄을 추가하지 않는다(재관측·refused 줄 중복 0).
// ===========================================================================

test("(492-9)★★★ (P2-2) HYK-424 거부 뒤 같은 내용으로 3번 더 폴해도 -- 관측 원장은 전혀 자라지 않는다(재관측·refused 줄 중복 0)", () => {
  withFixtureDir("hyk492-424-nogrowth-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    makeAnotherCommit(dir, "worker's own commit"); // 실제 HEAD != base -- 거부가 계속 재현되게.
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`, // 고쳐지지 않는다 -- 매 폴 다시 거부.
    });
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0);
    assert.match(poll1.stderr, /base를 베꼈다/);

    const afterPoll1 = readObservationLog(dir, "coder");
    assert.equal(afterPoll1.length, 2, "poll1 뒤: 관측 1 + refused 1");

    for (let i = 0; i < 3; i += 1) {
      const pollN = runCli(["coder", dir]);
      assert.notEqual(pollN.exit, 0, `poll${i + 2}도 여전히 거부돼야 한다`);
      assert.match(pollN.stderr, /base를 베꼈다/);
    }

    const afterRepeats = readObservationLog(dir, "coder");
    assert.deepEqual(
      afterRepeats,
      afterPoll1,
      `내용이 바뀌지 않은 채 3번 더 폴해도 관측 원장은 전혀 자라면 안 된다: ${JSON.stringify(afterRepeats)}`,
    );
  });
});

// ===========================================================================
// (10)(11) HYK-492-refused-obs-3 (P2-A, owner ruling A): 2R의
// `/^head_commit:.*$/gm`은 열 0에서 "head_commit:"로 시작하는 «모든» 줄을
// 지웠다 -- 383 게이트가 표지로 세지 않는 둘째 줄(해시 아닌 메모) · 코드
// 펜스 안 줄도 함께 지워졌다(review.md §3 P2-A, SHAPE second-col0-nonhex
// / fenced-col0 = ok=true). 3R은 383 게이트와 같은 정의(HEAD_COMMIT_RE_G
// over maskQuotedMarkerRegions)로 지울 줄을 정확히 1개로 좁힌다 -- 아래
// 두 시험은 "정상 head_commit 줄은 고치면서, 그 밖의 head_commit:-모양
// 줄도 같이 고치면" 이제는 거부돼야 함을 고정한다(RED 먼저: a91d281에서
// 이 정확한 입력이 ok=true였다 -- 아래 두 함수 헤더에 재현 방법을 적는다).
// ===========================================================================

test("(492-10)★★★ 수리 뒤(P2-A ⓧ): HYK-424 거부 뒤 head_commit 줄은 고치면서, 열 0 둘째 head_commit: 줄(해시 아닌 메모)의 글자도 같이 바꾸면 -- 여전히 DONE_REWRITTEN(그 둘째 줄은 비교에 포함)", () => {
  // RED-first 재현(이 라운드의 수리 전, a91d281): first-observation.mjs를
  // `git show a91d281:scripts/check/first-observation.mjs`로 되돌린 뒤
  // 이 정확한 poll1/poll2 입력을 주면 poll2.exit===0(ok=true)이었다 --
  // 2R의 HEAD_COMMIT_LINE_RE가 둘째 줄까지 블랙아웃했기 때문이다.
  withFixtureDir("hyk492-424-second-line-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: HYK-492-C\ndropped_at: 2026-11-04 06:00 KST\nbase_commit_of_this_round: ${baseSha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${baseSha}\nhead_commit: 이전 라운드 참고(해시 아님)\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /base를 베꼈다/);

    // 정상 head_commit 줄은 실제 HEAD로 고친다 -- 그런데 둘째(해시 아닌)
    // 줄의 콜론 뒤 글자도 같이 바꾼다. DONE 줄은 바이트 동일.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${ownSha}\nhead_commit: 완전히 다른 메모로 바꿔치기\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      `수리 뒤에는 둘째(해시 아닌) head_commit: 줄도 비교에 포함돼야 한다 -- 거부돼야 하는데 통과함: ${poll2.stdout}`,
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

test("(492-11)★★★ 수리 뒤(P2-A ⓨ): HYK-424 거부 뒤 head_commit 줄은 고치면서, 코드펜스 «안» 열 0 head_commit: 줄의 글자도 같이 바꾸면 -- 여전히 DONE_REWRITTEN(펜스 안 줄도 비교에 포함)", () => {
  // RED-first 재현(a91d281): 같은 입력으로 poll2.exit===0 -- 2R의
  // HEAD_COMMIT_LINE_RE는 maskQuotedMarkerRegions를 거치지 않아 펜스
  // 안쪽 열 0 head_commit: 줄도 블랙아웃했기 때문이다.
  withFixtureDir("hyk492-424-fenced-line-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    const fencedShaA = "1".repeat(40);
    const fencedShaB = "2".repeat(40);
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: HYK-492-C\ndropped_at: 2026-11-04 06:00 KST\nbase_commit_of_this_round: ${baseSha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${baseSha}\n\n\`\`\`\nhead_commit: ${fencedShaA}\n\`\`\`\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /base를 베꼈다/);

    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${ownSha}\n\n\`\`\`\nhead_commit: ${fencedShaB}\n\`\`\`\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      `수리 뒤에는 펜스 안 head_commit: 줄도 비교에 포함돼야 한다 -- 거부돼야 하는데 통과함: ${poll2.stdout}`,
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

test("(492-12) 대조군(무회귀): 둘째(해시 아닌) head_commit: 줄과 펜스 안 head_commit: 줄이 «변경 없이» 그대로 있을 때 -- 정상 head_commit 줄만 고치면 여전히 같은 세대 재소비 ok", () => {
  withFixtureDir("hyk492-424-decoy-unchanged-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    const fencedSha = "3".repeat(40);
    const decoyLine = "head_commit: 이전 라운드 참고(해시 아님)";
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: HYK-492-C\ndropped_at: 2026-11-04 06:00 KST\nbase_commit_of_this_round: ${baseSha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${baseSha}\n${decoyLine}\n\n\`\`\`\nhead_commit: ${fencedSha}\n\`\`\`\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /base를 베꼈다/);

    // 정상 head_commit 줄만 고친다 -- 둘째 줄·펜스 안 줄은 바이트 동일.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${ownSha}\n${decoyLine}\n\n\`\`\`\nhead_commit: ${fencedSha}\n\`\`\`\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.equal(
      poll2.exit,
      0,
      `장식 줄이 변하지 않았으면 정상 head_commit 줄만의 수정은 여전히 통과해야 한다: ${poll2.stderr}`,
    );
  });
});

// ===========================================================================
// (13)(14) owner ruling A의 "0개 또는 2개 이상이면 예외 꺼짐" 경계 --
// checkRewriteAndStaleness(DONE_REWRITTEN 축)가 424/383 게이트보다 먼저
// 평가되므로(relay-handshake.mjs:4209-4248), 두 시험 모두 DONE_REWRITTEN
// 으로 거부된다(383 게이트의 "ambiguous/missing" 분기에는 도달하지 않음
// -- 아래 각 시험이 직접 관측한 state를 그대로 적는다).
// ===========================================================================

test("(492-13)★★★ 경계(0개): HYK-424 거부 뒤 head_commit 값을 40자리 hex가 아닌 값으로 바꾸면 -- 예외가 꺼지고 DONE_REWRITTEN(0개 매치는 '아무 것도 지우지 않는다')", () => {
  withFixtureDir("hyk492-424-zero-match-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /base를 베꼈다/);

    // head_commit 값을 40-hex가 아닌 값으로 바꾼다 -- HEAD_COMMIT_RE_G
    // 매치 0개.
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-492-C\nhead_commit: not-a-real-sha\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      `정의에 맞는 줄이 0개면 예외가 꺼져야 한다(거부돼야 하는데 통과함): ${poll2.stdout}`,
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

test("(492-14)★★★ 경계(2개 이상): HYK-424 거부 뒤 head_commit 줄을 고치면서 열 0에 또 하나의(펜스 밖) 40자리 hex head_commit: 줄을 추가하면 -- 예외가 꺼지고 DONE_REWRITTEN(2개 매치는 '아무 것도 지우지 않는다')", () => {
  withFixtureDir("hyk492-424-two-match-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    const secondUnfencedSha = "4".repeat(40);
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const poll1 = runCli(["coder", dir]);
    assert.notEqual(poll1.exit, 0, `poll1 must reject: ${poll1.stdout}`);
    assert.match(poll1.stderr, /base를 베꼈다/);

    // head_commit 줄은 고치지만, 펜스 밖 열 0에 또 하나의 40-hex
    // head_commit: 줄이 새로 생긴다 -- HEAD_COMMIT_RE_G 매치 2개.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${ownSha}\nhead_commit: ${secondUnfencedSha}\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const poll2 = runCli(["coder", dir]);
    assert.notEqual(
      poll2.exit,
      0,
      `정의에 맞는 줄이 2개 이상이면 예외가 꺼져야 한다(거부돼야 하는데 통과함): ${poll2.stdout}`,
    );
    assert.match(
      poll2.stderr,
      /result DONE line was rewritten between first observation and final judgment/,
    );
  });
});

// ===========================================================================
// ⓓ 변이(제자리) -- 아래 6개(①~④는 1R부터, ⑤⑥은 2R 신설)는 하나씩
// 켜봐야 하는 변이다. 각 시험은
// (1) 원본 소스에서 변이 대상 리터럴이 정확히 1회 나타나는지 확인하고,
// (2) 변이한 사본을 임시 디렉터리에 (siblings + first-observation.mjs와
// 함께) 써서 동적 import한 뒤, (3) 그 변이가 구체적으로 어떤 통제를
// 깨는지 증명한다(RED). 원본 파일은 전혀 건드리지 않는다(이 파일은
// in-memory 문자열만 변형한다 -- 디스크 원본은 읽기만).
// ===========================================================================

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

// HYK-492: first-observation.mjs의 CLI 진입점은 `process.argv[1]`이
// column-0 리터럴 접미사 "scripts/check/first-observation.mjs"로 끝날
// 때만 활성화된다(그 파일 자신의 CLI 가드, 바이트 무변 -- 건드리지
// 않는다). relay-handshake.mjs가 자기 자신의 import.meta.url 기준으로
// 옆의 first-observation.mjs를 스폰하므로, 이 고립 사본도 같은 접미사로
// 끝나는 경로에 둬야 한다 -- 그냥 평평한 mkdtemp 디렉터리에 두면(기존
// bc-8/bc-9/mut-3 패턴처럼) 그 접미사 검사에 걸려 스폰된 자식이 아무
// 출력도 내지 않고(CLI 블록 전체가 비활성), 부모(spawnObserveDoneLine/
// spawnMarkRefused)는 빈 stdout을 JSON.parse하다 "Unexpected end of
// JSON input"으로 catch돼 관측 채널 전체가 조용히 no-op된다 -- 이 라운드
// 가 겨냥하는 바로 그 채널이 죽으므로 mut-1/mut-2/mut-3이 전부 거짓
// green이 된다(실측, 디버그 스크립트로 직접 확인). 그래서 mutDir를
// `<tmp>/scripts/check/`로 한 단 더 중첩한다.
async function importMutatedRelayHandshake(
  mutatedRelaySrc,
  label,
  { firstObservationSrc } = {},
) {
  const mutRoot = mkdtempSync(join(tmpdir(), `hyk492-mut-${label}-`));
  const mutDir = join(mutRoot, "scripts", "check");
  mkdirSync(mutDir, { recursive: true });
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(mutDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  writeFileSync(
    join(mutDir, "first-observation.mjs"),
    firstObservationSrc ??
      readFileSync(join(HERE, "first-observation.mjs"), "utf8"),
    "utf8",
  );
  const mutPath = join(mutDir, "relay-handshake.mjs");
  writeFileSync(mutPath, mutatedRelaySrc, "utf8");
  const mod = await import(
    `${pathToFileURL(mutPath).href}?t=${Date.now()}-${label}`
  );
  return { mod, mutDir: mutRoot };
}

// ---------------------------------------------------------------------------
// ① markRefused 호출(base_copy 축) 제거 -> (492-1)의 head_commit-only 수정
// 경로가 다시 DONE_REWRITTEN으로 거짓 거부된다(RED, 호출이 load-bearing
// 임을 증명).
// ---------------------------------------------------------------------------
test("(mut-1)★★★ 되돌림 변이: resolveBaseCopyRejection의 markRefused 호출을 제거하면 -- (492-1)의 head_commit-only 수정 경로가 다시 DONE_REWRITTEN으로 거짓 거부된다(RED)", async () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    '  if (verdict.ok) return null;\n  spawnMarkRefused({\n    taskId: core.taskId,\n    droppedAt: core.droppedMatch[1].trim(),\n    role,\n    harnessDir,\n    reason: "base_copy",\n    resultContent: core.judgedRegion,\n  });\n  return verdict;\n';
  assertExactlyOneMatch(
    src,
    target,
    "resolveBaseCopyRejection markRefused call",
  );
  const mutated = src.replace(
    target,
    "  if (verdict.ok) return null;\n  return verdict;\n",
  );

  await withFixtureDirAsync("hyk492-mut1-fixture-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      mutated,
      "no-mark-refused",
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);

      writeCoderRound(dir, {
        taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
        resultExtra: `head_commit: ${ownSha}\n`,
      });
      const poll2 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(
        poll2.ok,
        false,
        "RED: markRefused 호출이 없으면 head_commit-only 수정도 다시 거부돼야 한다(지문 재기준이 전혀 일어나지 않으므로)",
      );
      assert.equal(poll2.state, "DONE_REWRITTEN_AFTER_FIRST_OBSERVATION");
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ② (HYK-492-refused-obs-2 product_scope ⓒ①) 2R의 좁히기 자체를 되돌림
// -- checkIntermediateRewrite의 headCommitOnlyDiffAllowed에서
// head_commit-전용 지문 대조(blankHeadCommitLine)를 빼고 "S 거부가 한
// 번이라도 있었으면 지문 불일치는 전부 눈감아준다"는 1R의 폭 넓은 모양
// 으로 되돌린다 -> REVIEW 1R이 반려한 바로 그 구멍(C2b: 383 거부 유도 ->
// head_commit 고치면서 verdict: rejected -> approved도 같이 바꿔도
// 통과)이 다시 열린다(RED, head_commit 한 줄만 눈감아줘야 한다는
// 불변식이 load-bearing임을 증명).
// ---------------------------------------------------------------------------
test("(mut-2)★★★ 되돌림 변이: head_commit-전용 대조를 빼고 'S 거부 뒤 지문 불일치는 전부 눈감아준다'로 되돌리면 -- C2b(REVIEW 383 거부 유도 뒤 verdict까지 바꿔치기)가 거짓으로 통과한다(RED, 2R 좁히기가 load-bearing임을 증명)", async () => {
  const firstObsSrc = readFileSync(join(HERE, "first-observation.mjs"), "utf8");
  const target =
    '    const headCommitOnlyDiffAllowed =\n      !exactBodyMatches &&\n      typeof existing.resultFingerprintSansHeadCommit === "string" &&\n      existing.resultFingerprintSansHeadCommit ===\n        fingerprint(blankHeadCommitLine(resultContent)) &&\n      hasRefusalForGeneration({ taskId, droppedAt, role, harnessDir });\n';
  assertExactlyOneMatch(
    firstObsSrc,
    target,
    "checkIntermediateRewrite headCommitOnlyDiffAllowed calc",
  );
  const mutatedFirstObs = firstObsSrc.replace(
    target,
    "    const headCommitOnlyDiffAllowed =\n      !exactBodyMatches &&\n      hasRefusalForGeneration({ taskId, droppedAt, role, harnessDir });\n",
  );

  const relaySrc = readFileSync(CLI_PATH, "utf8");

  await withFixtureDirAsync("hyk492-mut2-fixture-", async (dir) => {
    const targetSha = ensureGitHeadCommit(dir);
    const wrongSha = "e".repeat(40);
    // (492-2)의 writeReviewRound 헬퍼는 'for:'/'verdict:' 줄을 쓰지 않는다
    // -- C2b는 그 두 줄이 필요하므로 여기서는 직접 쓴다.
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-492-C2B\nfor: HYK-100-x-1\nverdict: rejected\nhead_commit: ${wrongSha}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-492-C2B\ndropped_at: 2026-11-04 06:00 KST\nhead_commit: ${targetSha}\n`,
      "utf8",
    );
    const { mod, mutDir } = await importMutatedRelayHandshake(
      relaySrc,
      "no-head-commit-only-narrowing",
      {
        firstObservationSrc: mutatedFirstObs,
      },
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "review",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);
      assert.match(poll1.reason, /head_commit mismatch/);

      // head_commit은 고치지만, 판정 낱말도 같이 바꿔치기한다(DONE 줄은
      // 무변) -- 2R이 막아야 하는 바로 그 모양.
      writeFileSync(
        join(dir, "review.md"),
        `task_id: HYK-492-C2B\nfor: HYK-100-x-1\nverdict: approved\nhead_commit: ${targetSha}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
        "utf8",
      );
      const poll2 = mod.checkRelayHandshake({
        role: "review",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(
        poll2.ok,
        true,
        "RED: head_commit-전용 대조 없이 'S 거부 뒤 지문 불일치는 전부 눈감아준다'로 되돌리면, verdict까지 같이 바꿔치기한 값도 거짓으로 통과해야 한다",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ③ S 판정을 "모든 거부"로 넓힘(STALE 거부도 markRefused를 띄우게 함) ->
// (492-4) 대조군의 핵심 주장("STALE은 refused 표시를 전혀 남기지 않는다")
// 이 거짓으로 뒤집힌다(RED, S가 정확히 {424, 383}로 좁혀져 있어야 한다는
// 불변식이 load-bearing임을 증명).
// ---------------------------------------------------------------------------
test("(mut-3)★★★ 되돌림 변이: checkRewriteAndStaleness의 STALE 분기에 markRefused를 추가(S를 모든 거부로 확장)하면 -- (492-4) «STALE은 refused를 남기지 않는다» 대조군이 거짓이 된다(RED)", async () => {
  const src = readFileSync(CLI_PATH, "utf8");

  const callSiteTarget =
    "  const rewriteOrStaleVerdict = checkRewriteAndStaleness({\n    observation: core.observation,\n    doneAt,\n    droppedAt,\n    doneMatch,\n    droppedMatch,\n  });\n";
  assertExactlyOneMatch(
    src,
    callSiteTarget,
    "checkRewriteAndStaleness call site",
  );

  const defTarget =
    "function checkRewriteAndStaleness({\n  observation,\n  doneAt,\n  droppedAt,\n  doneMatch,\n  droppedMatch,\n}) {\n";
  assertExactlyOneMatch(src, defTarget, "checkRewriteAndStaleness signature");

  const staleReturnTarget =
    '    return {\n      ok: false,\n      state: "STALE_DONE_PREDATES_DROP",\n      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,\n    };\n  }\n';
  assertExactlyOneMatch(src, staleReturnTarget, "STALE return block");

  let mutated = src.replace(
    callSiteTarget,
    "  const rewriteOrStaleVerdict = checkRewriteAndStaleness({\n    observation: core.observation,\n    doneAt,\n    droppedAt,\n    doneMatch,\n    droppedMatch,\n    role,\n    harnessDir,\n    taskId: core.taskId,\n  });\n",
  );
  mutated = mutated.replace(
    defTarget,
    "function checkRewriteAndStaleness({\n  observation,\n  doneAt,\n  droppedAt,\n  doneMatch,\n  droppedMatch,\n  role,\n  harnessDir,\n  taskId,\n}) {\n",
  );
  mutated = mutated.replace(
    staleReturnTarget,
    '    spawnMarkRefused({\n      taskId,\n      droppedAt: droppedMatch[1].trim(),\n      role,\n      harnessDir,\n      reason: "stale_broadened_mutation",\n    });\n    return {\n      ok: false,\n      state: "STALE_DONE_PREDATES_DROP",\n      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,\n    };\n  }\n',
  );
  assert.notEqual(mutated, src, "mutation must actually change the source");

  await withFixtureDirAsync("hyk492-mut3-fixture-", async (dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-492-S\ndropped_at: 2026-11-04 07:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-492-S\nbody v1\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const { mod, mutDir } = await importMutatedRelayHandshake(
      mutated,
      "stale-marks-refused",
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);
      assert.equal(poll1.state, "STALE_DONE_PREDATES_DROP");

      const entries = readObservationLog(dir, "coder");
      assert.ok(
        entries.some((e) => e.refused === true),
        "RED: S가 모든 거부로 넓혀지면 STALE도 refused 표시를 남겨야 한다(492-4 대조군이 깨짐을 증명)",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ④ HYK-424 거부 문구 원복(새 "head_commit 줄만 고쳐라" 안내를 제거) ->
// §2 product_scope ⑶이 요구하는 안내 문구가 더 이상 존재하지 않는다(RED,
// 문구 갱신 자체가 load-bearing임을 증명 -- 문구가 없으면 사람이 §31의
// 느린 새-워크트리 경로로 계속 빠지게 된다).
// ---------------------------------------------------------------------------
test("(mut-4)★ 되돌림 변이: HYK-424 거부 문구에서 「head_commit 줄만 고쳐라」 안내를 제거하면 -- 그 안내가 더 이상 존재하지 않는다(RED)", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "같은 세대(같은 dropped_at)에서 결과 파일의 head_commit 줄만 네 실제 HEAD로 고쳐라 -- DONE 줄은 건드리지 마라, 그러면 다음 폴에서 같은 세대 재소비가 통과한다(DONE_REWRITTEN_AFTER_FIRST_OBSERVATION 재발 없음).";
  assertExactlyOneMatch(src, target, "HYK-424 head_commit-only fix guidance");
  const mutated = src.replace(target, "");
  assert.doesNotMatch(
    mutated,
    /head_commit 줄만 네 실제 HEAD로 고쳐라/,
    "RED: 원복하면 head_commit-only 수정 안내가 더 이상 보이지 않아야 한다(이 변이 자체가 그 사라짐을 증명)",
  );
});

// ---------------------------------------------------------------------------
// ⑤ (HYK-492-refused-obs-2 product_scope ⓒ②) head_commit-전용 예외
// 자체를 완전히 제거(headCommitOnlyDiffAllowed를 항상 false로) -> (492-1)/
// (492-2)의 "head_commit 줄만 고치면 같은 세대 재소비 ok" 경로가 다시
// DONE_REWRITTEN으로 거짓 거부된다(RED, 이 예외가 load-bearing임을
// 증명 -- mut-1과 다른 지점: mut-1은 markRefused 호출 자체를 지워 예외가
// "켜질" 기회를 없앴고, 이 변이는 예외의 "판정 로직"만 지운다).
// ---------------------------------------------------------------------------
test("(mut-5)★★★ 되돌림 변이: head_commit-전용 예외(headCommitOnlyDiffAllowed)를 항상 false로 지우면 -- (492-1)/(492-2)의 head_commit-only 수정 경로가 다시 DONE_REWRITTEN으로 거짓 거부된다(RED)", async () => {
  const firstObsSrc = readFileSync(join(HERE, "first-observation.mjs"), "utf8");
  const target =
    '    const headCommitOnlyDiffAllowed =\n      !exactBodyMatches &&\n      typeof existing.resultFingerprintSansHeadCommit === "string" &&\n      existing.resultFingerprintSansHeadCommit ===\n        fingerprint(blankHeadCommitLine(resultContent)) &&\n      hasRefusalForGeneration({ taskId, droppedAt, role, harnessDir });\n';
  assertExactlyOneMatch(
    firstObsSrc,
    target,
    "checkIntermediateRewrite headCommitOnlyDiffAllowed calc (mut-5 target)",
  );
  const mutatedFirstObs = firstObsSrc.replace(
    target,
    "    const headCommitOnlyDiffAllowed = false;\n",
  );
  const relaySrc = readFileSync(CLI_PATH, "utf8");

  await withFixtureDirAsync("hyk492-mut5-fixture-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      relaySrc,
      "no-head-commit-exception",
      { firstObservationSrc: mutatedFirstObs },
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);

      writeCoderRound(dir, {
        taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
        resultExtra: `head_commit: ${ownSha}\n`,
      });
      const poll2 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(
        poll2.ok,
        false,
        "RED: head_commit-전용 예외가 없으면, 정당한 head_commit-only 수정도 다시 거부돼야 한다",
      );
      assert.equal(poll2.state, "DONE_REWRITTEN_AFTER_FIRST_OBSERVATION");
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ⑥ (HYK-492-refused-obs-2 product_scope ⓒ③) P2-2의 재폴 중복 방지를
// 제거(recordFirstDoneObservation이 내용 불변 여부를 더 이상 보지 않고
// "거부된 적이 있으면 무조건 다시 적는다") -> (492-9)의 "내용이 바뀌지
// 않으면 관측 원장이 자라지 않는다" 대조군이 거짓이 된다(RED, 중복
// 방지가 load-bearing임을 증명).
// ---------------------------------------------------------------------------
test("(mut-6)★★★ 되돌림 변이: recordFirstDoneObservation의 '내용 불변이면 적지 않는다' 중복 방지를 제거하면 -- (492-9) P2-2 대조군(같은 내용 재폴 시 원장 무증가)이 거짓이 된다(RED)", async () => {
  const firstObsSrc = readFileSync(join(HERE, "first-observation.mjs"), "utf8");
  const target =
    '    if (lastObservation) {\n      const unchanged =\n        fingerprint(resultContent) === lastObservation.resultFingerprint;\n      if (unchanged || !refusedSinceLastObservation) {\n        return {\n          recorded: false,\n          reason: "already observed",\n          existing: lastObservation,\n        };\n      }\n    }\n';
  assertExactlyOneMatch(
    firstObsSrc,
    target,
    "recordFirstDoneObservation dedup gate (mut-6 target)",
  );
  const mutatedFirstObs = firstObsSrc.replace(
    target,
    '    if (lastObservation && !refusedSinceLastObservation) {\n      return {\n        recorded: false,\n        reason: "already observed",\n        existing: lastObservation,\n      };\n    }\n',
  );
  const relaySrc = readFileSync(CLI_PATH, "utf8");

  await withFixtureDirAsync("hyk492-mut6-fixture-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`, // 고쳐지지 않는다 -- 매 폴 다시 거부.
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      relaySrc,
      "no-dedup-on-unchanged-content",
      { firstObservationSrc: mutatedFirstObs },
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);
      const afterPoll1 = readObservationLog(dir, "coder");
      assert.equal(afterPoll1.length, 2, "poll1 뒤: 관측 1 + refused 1");

      const poll2 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll2.ok, false);
      const afterPoll2 = readObservationLog(dir, "coder");
      assert.notDeepEqual(
        afterPoll2,
        afterPoll1,
        "RED: 중복 방지가 없으면, 내용이 바뀌지 않은 재폴에도 관측 원장이 자라야 한다(mut-6이 그 성장을 다시 연다)",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ⑦ (HYK-492-refused-obs-3 §2 product_scope ⓘ, 새 변이) owner ruling A의
// "정확히 1개" 조건을 제거하고 2R 폭(열 0 head_commit: 줄 전부 제외)으로
// 되돌린다 -> (492-10)/(492-13)이 다시 거짓으로 통과한다(RED, 이 좁히기가
// load-bearing임을 증명 -- P2-A가 다시 열린다).
// ---------------------------------------------------------------------------
test("(mut-7)★★★ 되돌림 변이: blankHeadCommitLine의 '정확히 1개' 조건을 지우고 2R 폭(열 0 head_commit: 줄 전부 제외)으로 되돌리면 -- (492-10)의 둘째(해시 아닌) head_commit: 줄 수정이 다시 거짓으로 통과한다(RED, P2-A가 다시 열림)", async () => {
  const firstObsSrc = readFileSync(join(HERE, "first-observation.mjs"), "utf8");
  const target =
    'function blankHeadCommitLine(resultContent) {\n  const scan = maskQuotedMarkerRegions(resultContent);\n  const matches = [...scan.matchAll(HEAD_COMMIT_RE_G)];\n  if (matches.length !== 1) return resultContent;\n  const [match] = matches;\n  const start = match.index;\n  const end = start + match[0].length;\n  return (\n    resultContent.slice(0, start) + "head_commit:" + resultContent.slice(end)\n  );\n}';
  assertExactlyOneMatch(
    firstObsSrc,
    target,
    "blankHeadCommitLine exactly-1 narrowing (mut-7 target)",
  );
  const mutatedFirstObs = firstObsSrc.replace(
    target,
    'function blankHeadCommitLine(resultContent) {\n  return resultContent.replace(/^head_commit:.*$/gm, "head_commit:");\n}',
  );
  const relaySrc = readFileSync(CLI_PATH, "utf8");

  await withFixtureDirAsync("hyk492-mut7-fixture-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeFileSync(
      join(dir, "coder-task.md"),
      `task_id: HYK-492-C\ndropped_at: 2026-11-04 06:00 KST\nbase_commit_of_this_round: ${baseSha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-492-C\nhead_commit: ${baseSha}\nhead_commit: 이전 라운드 참고(해시 아님)\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const { mod, mutDir } = await importMutatedRelayHandshake(
      relaySrc,
      "p2a-reopened",
      { firstObservationSrc: mutatedFirstObs },
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);

      writeFileSync(
        join(dir, "coder.md"),
        `task_id: HYK-492-C\nhead_commit: ${ownSha}\nhead_commit: 완전히 다른 메모로 바꿔치기\n\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
        "utf8",
      );
      const poll2 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(
        poll2.ok,
        true,
        "RED: '정확히 1개' 조건이 없으면, 둘째(해시 아닌) head_commit: 줄의 변경도 다시 눈감아줘야 한다(P2-A 재현)",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});
