// HYK-492-refused-obs-1: PM 1R 설계(②′, D:\문서관리\하네스-관제실\PM\
// 산출물\하네스\2026-11-04-막다른모양-첫관측-순서\막다른모양-첫관측-순서-
// 설계.md §(b))의 실 구현 고정 -- S = {HYK-424 base-copy, HYK-383
// head_commit} 거부로 끝난 관측에 한해, markRefused(append-only, 세대
// tombstone 아님)로 "거부로 끝난 관측"을 표시하고, DONE 앞 지문
// 기준값만 "마지막 거부 표시 뒤 첫 관측"으로 재기준한다. DONE 줄
// 기준값(findFirstObservation)과 finalize-done의 findFirstObservation
// 의존은 바이트 무변이다(first-observation.mjs 자신의 주석 참조).
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
  findFingerprintBaseline,
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
    `task_id: HYK-492-R\nhead_commit: ${resultHead}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
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

test("(492-6)★ 관측 원장 시퀀스(단위): 관측 -> 거부 표시 -> 재관측(지문만 재기준) -> consumed -- findFirstObservation은 세대 첫 관측에 그대로 고정된다", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "hyk492-unit-ledger-"));
  try {
    const taskId = "task_hyk492_unit";
    const droppedAt = "2026-11-04 06:00 KST";
    const role = "coder";
    const doneLineRaw = ">>> DONE: CODER @ 2026-11-04 06:10:00 KST";

    const first = observeDoneLine({
      taskId,
      droppedAt,
      role,
      harnessDir,
      resultContent: `task_id: ${taskId}\nhead_commit: AAAA\n\n${doneLineRaw}`,
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

    // 지문 기준값은 거부 표시 뒤에는 리셋된다(아직 재관측 전).
    const resetBaseline = findFingerprintBaseline({
      taskId,
      droppedAt,
      role,
      harnessDir,
    });
    assert.equal(
      resetBaseline,
      null,
      "거부 표시 뒤, 재관측 전에는 지문 기준값이 없어야 한다",
    );

    // head_commit 줄만 고친 재관측 -- DONE 줄은 동일.
    const second = observeDoneLine({
      taskId,
      droppedAt,
      role,
      harnessDir,
      resultContent: `task_id: ${taskId}\nhead_commit: BBBB\n\n${doneLineRaw}`,
      doneLineRaw,
    });
    assert.equal(
      second.rewritten,
      false,
      "거부 표시 뒤 첫 재관측은 스스로와 비교라 일치해야 한다",
    );
    assert.equal(
      second.existing.doneLineRaw,
      doneLineRaw,
      "DONE 줄 비교 기준은 여전히 세대 첫 관측(existing)이다",
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
// ⓓ 변이(제자리) -- 아래 4개는 하나씩 켜봐야 하는 변이다. 각 시험은
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
    '  if (verdict.ok) return null;\n  spawnMarkRefused({\n    taskId: core.taskId,\n    droppedAt: core.droppedMatch[1].trim(),\n    role,\n    harnessDir,\n    reason: "base_copy",\n  });\n  return verdict;\n';
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
// ② DONE 줄 기준을 지문 기준값과 합침(checkIntermediateRewrite가
// existing.doneLineRaw 대신 fingerprintBaseline.doneLineRaw로 비교) ->
// (492-3) 대조군(S 거부 뒤 DONE까지 바꿔치기)이 거짓으로 통과한다(RED,
// DONE 줄이 세대 첫 관측에 고정돼야 한다는 불변식이 load-bearing임을
// 증명 -- 452902c가 반려한 모양이 다시 열리는 경로).
// ---------------------------------------------------------------------------
test("(mut-2)★★★ 되돌림 변이: checkIntermediateRewrite의 DONE 줄 비교 기준을 지문 기준값과 합치면 -- (492-3) S거부+DONE바꿔치기 대조군이 거짓으로 통과한다(RED, 452902c가 반려한 모양이 다시 열림)", async () => {
  const firstObsSrc = readFileSync(join(HERE, "first-observation.mjs"), "utf8");
  const target =
    "    const rewritten =\n      fingerprintBaseline.resultFingerprint !== currentFingerprint ||\n      existing.doneLineRaw !== currentDoneLine;\n";
  assertExactlyOneMatch(
    firstObsSrc,
    target,
    "checkIntermediateRewrite rewritten calc",
  );
  const mutatedFirstObs = firstObsSrc.replace(
    target,
    "    const rewritten =\n      fingerprintBaseline.resultFingerprint !== currentFingerprint ||\n      fingerprintBaseline.doneLineRaw !== currentDoneLine;\n",
  );

  const relaySrc = readFileSync(CLI_PATH, "utf8");

  await withFixtureDirAsync("hyk492-mut2-fixture-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir, "worker's own commit");
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      relaySrc,
      "done-merged-with-fp",
      {
        firstObservationSrc: mutatedFirstObs,
      },
    );
    try {
      const poll1 = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: Date.now(),
      });
      assert.equal(poll1.ok, false);
      assert.match(poll1.reason, /base를 베꼈다/);

      // head_commit도 고치고 DONE 줄도 같이 바꿔치기한다.
      writeFileSync(
        join(dir, "coder.md"),
        `task_id: HYK-492-C\nhead_commit: ${ownSha}\n\n>>> DONE: CODER @ 2026-11-04 06:20:00 KST\ndone_stamped_by: finalize-done\n`,
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
        "RED: DONE 줄 비교가 지문 기준값에 합쳐지면, 거부 표시 뒤 DONE까지 바꿔치기한 값이 스스로와 비교돼 거짓으로 통과해야 한다",
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
