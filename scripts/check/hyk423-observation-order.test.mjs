// HYK-423 2R -- 1R(«거부 사유의 종류»로 관측 release를 결속)이 검토에서
// P1으로 반려됐다: release 대상 두 게이트(head_commit/runner_receipt)는
// 둘 다 «워커가 스스로 거부를 만들어낼 수 있는» 축이었다 -- 워커가 일부러
// 그 거부를 유도해 관측을 tombstone시킨 뒤 DONE/결과를 통째로 바꿔치기하면
// rewrite 가드를 완전히 우회했다(검토자 실측 재현, coder-task.md §9 원문).
//
// 2R은 1R의 게이트-이름 결속 축을 «폐기»한다(coder.md §1⑶). 대신: 관측
// 지문(fingerprint)의 범위를 «`>>> DONE:` 줄이 끝나는 지점까지»로 좁힌다
// (relay-handshake.mjs의 resolveDoneAt, `protectedScope` 참조) -- 이 축은
// 어느 게이트가 거부했는지와 완전히 무관하다(게이트 이름을 참조하지 않는다
// -- 워커가 특정 게이트를 일부러 거부시켜도 얻는 것이 없다). DONE 줄
// 자신은 여전히, 그리고 이 지문 축과 별도로, checkIntermediateRewrite가
// 문자열로 직접 비교한다(first-observation.mjs, 1R 이전부터 있던 기존
// 메커니즘 -- 이번 라운드가 새로 만들지 않았다) -- 그래서 DONE 줄이
// 바뀌는 순간(B/B′ 둘 다의 실제 공격 형태) 게이트 무관하게 항상 거부된다.
// 이 축이 완화하는 것은 오직 DONE 줄 «뒤»의 후기(postscript)뿐이다 --
// 2026-09-03 실물 사고("결과 파일에 덧붙임")가 정확히 그 모양이었다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtempSync(tmpdir())로 만든
// 격리 사본이다(coder-task.md §0).
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
import { execFileSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveRunnerReceiptVerdict,
  RUNNER_RECEIPT_REJECT_REASON,
  parseKstTimestamp,
  TIME_AUTHORITY_STATE,
} from "./relay-handshake.mjs";

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
  "  const protectedScope = resultContent.slice(\n" +
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
  "          resultContent: protectedScope,\n" +
  "          doneLineRaw: doneMatch[0],\n" +
  "        })\n" +
  "      : { rewritten: false };\n";
const PROTECTED_SCOPE_REPLACEMENT =
  "  const observation =\n" +
  "    taskId && droppedAtRaw\n" +
  "      ? spawnObserveDoneLine({\n" +
  "          taskId,\n" +
  "          droppedAt: droppedAtRaw,\n" +
  "          role,\n" +
  "          harnessDir,\n" +
  "          resultContent,\n" +
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
