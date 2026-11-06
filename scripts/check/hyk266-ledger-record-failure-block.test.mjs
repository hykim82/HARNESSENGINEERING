// HYK-266-ledger-block-1: 소비 단계에서 `attempted:true, ok:false`로
// 떨어지는 7종(NO_VERDICT_LINE · LEDGER_READ_FAILED · LEDGER_INVALID_JSON ·
// LEDGER_INVALID_SHAPE · NO_COVER_LINE · ISSUE_ID_UNPARSEABLE ·
// LEDGER_WRITE_ERROR) + 같은 함수의 `attempted:false, blocked:true`
// UNISOLATED_HARNESS_DIR 하나 -- 이 8가지는 HYK-262 §3의 "통과 + 흔적"
// 결정 아래서 조용히 소비를 통과했다(판정이 원장에 영원히 빠질 수 있는
// 모양). 이 라운드는 그 8가지를 전부 소비 실패로 뒤집는다 -- 사유를
// «계약 위반»(결과 파일 자신의 결함) · «원장 사용 불가»(LEDGER_* 계열) ·
// UNISOLATED_HARNESS_DIR(범위 밖 발견 ⓐ, 별도 사유)로 나눈다.
//
// 설계 근거 = PM-r14(산출물 `D:\문서관리\하네스-관제실\PM\산출물\하네스\
// 2026-11-05-원장기록실패-조용통과\`) 전문 + 책임자 판정(2026-11-05 23:0x ·
// 2026-11-06 08:3x). 이 파일은 그 설계의 (g) "다음 조각" 표본 S1~S8을
// 구현한다 -- 전부 RED 먼저(이 라운드 수리 «전» 모양을 흉내 낸 mkdtemp
// 사본으로), 그다음 실 소스(수리 뒤)로 GREEN을 확인한다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 원장/영수증/git 저장소는 mkdtemp 합성
// 픽스처다 -- 실제 관제실 정본(`D:\문서관리\하네스-관제실\` · 이 저장소의
// 진짜 `.harness/`)에는 절대 쓰지 않는다. ⛔프로덕션 함수(checkRelayHandshake
// -- CLI 자식 또는 export, recordRejectStreakFromResultText, parseReviewOutcome)
// 를 직접 구동한다 -- 테스트 helper 복제 구동은 헛시험이다.
import { test } from "node:test";
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
  REJECT_STREAK_REASON_CODE,
  parseReviewOutcome,
  recordRejectStreakFromResultText,
} from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const RELAY_HANDSHAKE_SRC = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
const REJECT_STREAK_SRC = readFileSync(join(HERE, "reject-streak.mjs"), "utf8");

// ===========================================================================
// §A. 공용 헬퍼 (reject-streak-auto-record.test.mjs/hyk262-not-blocked-
// trace.test.mjs와 같은 관용구를 이 파일 안에 독립적으로 재작성한다 --
// 이 저장소의 "작은 헬퍼는 파일마다 복제한다" 관례 그대로).
// ===========================================================================

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
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
  const linkedDir = tmpDir("hyk266-blk-linked-");
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
    // DISPATCH_RECEIPT_PATH leaked from the invoking shell reach this child.
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

// null = 파일이 아예 없다. "CORRUPTED" = 파일은 있지만 JSON.parse가
// 실패한다(이 라운드의 핵심 표본들이 의도적으로 깨뜨린 원장 자체).
// 호출자는 둘 다 "유효한 원장 객체가 아니다"로 취급할 수 있지만, S4/S6
// 처럼 "원장이 아예 안 생겼다"와 "손상된 원장이 그대로 남아 있다"를
// 갈라야 하는 호출자는 이 문자열 센티널로 구분한다.
function readMainLedger(mainDir) {
  const p = join(mainDir, ".harness", "reject-streak.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return "CORRUPTED";
  }
}

// taskId/for/verdict/extraResultLines를 자유롭게 조합할 수 있는 REVIEW
// fixture 작성기. for:/verdict: 줄은 명시적으로 넘기지 않으면 쓰지 않는다
// (NO_COVER_LINE·NO_VERDICT_LINE 표본을 그대로 만들 수 있어야 한다).
function writeReviewFixture(
  harnessDir,
  { taskId, forLine, verdict, droppedAt, doneAt, extraResultLines = "" },
) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(harnessDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  const forPart = forLine !== undefined ? `for: ${forLine}\n` : "";
  const verdictPart = verdict !== undefined ? `verdict: ${verdict}\n` : "";
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\n${forPart}${verdictPart}role: REVIEW-CODEX\nhead_commit: ${headCommit}\n${extraResultLines}\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function corruptLedgerInvalidJson(mainDir) {
  writeFileSync(
    join(mainDir, ".harness", "reject-streak.json"),
    "{ not valid json",
    "utf8",
  );
}

// ===========================================================================
// §B. "수리 전" 사본 -- 이 라운드가 relay-handshake.mjs 호출부에 더한
// 3갈래 차단 블록(checkUnisolatedHarnessDirViolation/checkContractViolation/
// checkLedgerUnavailableViolation 호출)을 제거해, HYK-262 §3이 결정했던
// "통과 + 흔적(또는 UNISOLATED는 흔적도 없음)" 모양을 재현한다. 단일
// 결함 표본(S1·S2·S3·S5·S8)에서는 reject-streak.mjs의 parse/load 순서는
// 결과를 바꾸지 않으므로(§2 ⓘⓘⓘ 자신의 헤더 참조 -- 순서는 "결함이
// 둘 다 있을 때"만 어느 사유가 보이는지를 가른다), reject-streak.mjs는
// 그대로(수리된 상태) 둔다.
// ===========================================================================

const NEW_CALL_SITE_BLOCK =
  "  // HYK-266 §2: 세 갈래 추가 -- UNISOLATED_HARNESS_DIR(범위 밖 발견 ⓐ,\n" +
  "  // attempted:false/blocked:true라 위 두 함수 모두 걸러내지 못한다) ·\n" +
  "  // 계약 위반 7종 중 3종(판정 자체가 없거나 이슈 id를 못 뽑음) · 원장\n" +
  "  // 사용 불가 7종 중 4종(읽기·JSON·모양·쓰기 실패). 순서: 이 라운드가\n" +
  "  // 손대지 않는 기존 두 차단(표지 줄 수·값)이 여전히 먼저다.\n" +
  "  const unisolatedViolation = checkUnisolatedHarnessDirViolation(recordOutcome);\n" +
  "  if (unisolatedViolation) return unisolatedViolation;\n" +
  "  const contractViolation = checkContractViolation(recordOutcome);\n" +
  "  if (contractViolation) return contractViolation;\n" +
  "  const ledgerUnavailableViolation =\n" +
  "    checkLedgerUnavailableViolation(recordOutcome);\n" +
  "  if (ledgerUnavailableViolation) return ledgerUnavailableViolation;\n";

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the committed source (found ${count})`,
  );
}

assertExactlyOneMatch(
  RELAY_HANDSHAKE_SRC,
  NEW_CALL_SITE_BLOCK,
  "HYK-266 new call-site block",
);
const PRE_FIX_RELAY_SRC = RELAY_HANDSHAKE_SRC.replace(NEW_CALL_SITE_BLOCK, "");

// HYK-383 축(resolveHeadCommitBinding 호출부) -- S8(UNISOLATED_HARNESS_DIR)
// «만» 이 축을 제거한 사본이 필요하다(hyk355-reject-streak-isolation.
// test.mjs의 동일 관용구 -- harnessDir가 git worktree가 전혀 아니면 이
// 축이 UNISOLATED_HARNESS_DIR보다 먼저 거부해, 그 뒤 갈래가 생산 경로
// «밖»에서만 고립 시험 가능하다는 사실 자체를 이 파일도 그대로 물려받는다).
const HEAD_COMMIT_AXIS_CALL_TARGET =
  "  const headCommitVerdict = resolveHeadCommitBinding({\n" +
  "    role,\n" +
  "    taskContent,\n" +
  "    resultContent: judgedRegion,\n" +
  "    harnessDir,\n" +
  "  });\n" +
  "  if (!headCommitVerdict.ok) return headCommitVerdict;\n";

assertExactlyOneMatch(
  RELAY_HANDSHAKE_SRC,
  HEAD_COMMIT_AXIS_CALL_TARGET,
  "HYK-383 head_commit axis call site",
);

const LIVE_RELAY_SRC_ISOLATED = RELAY_HANDSHAKE_SRC.replace(
  HEAD_COMMIT_AXIS_CALL_TARGET,
  "",
);
const PRE_FIX_RELAY_SRC_ISOLATED = PRE_FIX_RELAY_SRC.replace(
  HEAD_COMMIT_AXIS_CALL_TARGET,
  "",
);

const SIBLING_DEPS = [
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "time-authority.mjs",
  "child-probe-timeout-policy.mjs",
  "admission-completion-adapter.mjs",
  "ledger-pointer-shared.mjs",
  "retirement-record-core.mjs",
  "retirement-block-reason-shared.mjs",
  "consumption-receipt-writer.mjs",
  "consumption-receipt-core.mjs",
];

function writeScriptsCheckCopy(rootDir, relaySrc, { streakSrc } = {}) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  writeFileSync(join(scriptsCheckDir, "relay-handshake.mjs"), relaySrc, "utf8");
  for (const dep of SIBLING_DEPS) {
    const content =
      dep === "reject-streak.mjs" && streakSrc
        ? streakSrc
        : readFileSync(join(HERE, dep), "utf8");
    writeFileSync(join(scriptsCheckDir, dep), content, "utf8");
  }
  return join(scriptsCheckDir, "relay-handshake.mjs");
}

function withRepoPair(fn) {
  const mainDir = tmpDir("hyk266-blk-main-");
  try {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      return fn({ mainDir, linkedDir, harnessDir });
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
}

// ===========================================================================
// S1: NO_VERDICT_LINE (335 모양 -- 어휘 밖 값 "changes_requested",
// verdict 정규식이 approved|rejected만 받으므로 그대로 이 코드로 접힌다).
// ===========================================================================

test("S1 NO_VERDICT_LINE: RED(수리 전) = 소비 통과(exit 0) -> GREEN(수리 후) = 계약 위반으로 거부(exit 1)", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9910-review-1",
      forLine: "HYK-9910-review-1",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
      extraResultLines: "verdict: changes_requested\n",
    });

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-s1-pre-"),
      PRE_FIX_RELAY_SRC,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);
    assert.equal(readMainLedger(mainDir), null);

    const green = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
    assert.match(
      green.stderr,
      /consumption rejected \(HYK-266\): REVIEW-family result file does not carry a resolvable, finished verdict/,
    );
    assert.equal(readMainLedger(mainDir), null);
  });
});

// ===========================================================================
// S2: ISSUE_ID_UNPARSEABLE -- task_id 값이 HYK-<숫자>로 시작하지 않는다
// (for: 줄 없음, task_id:가 직접 소스), 검토자의 지문 echo 대조는 두
// 파일(task/result)에 같은 값만 쓰면 통과하므로(값 형식 자체는 echo
// 일치 검사의 대상이 아니다) 생산 경로 전체를 그대로 탄다.
// ===========================================================================

test("S2 ISSUE_ID_UNPARSEABLE: RED(수리 전) = 소비 통과 -> GREEN(수리 후) = 계약 위반으로 거부", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    const taskId = "BOGUS-9911";
    mkdirSync(harnessDir, { recursive: true });
    const headCommit = git(linkedDir, ["rev-parse", "HEAD"]);
    writeFileSync(
      join(harnessDir, "review-task.md"),
      `task_id: ${taskId}\ndropped_at: 2026-11-06 06:00 KST\nhead_commit: ${headCommit}\n`,
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "review.md"),
      `task_id: ${taskId}\nverdict: rejected\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ 2026-11-06 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-s2-pre-"),
      PRE_FIX_RELAY_SRC,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);
    assert.equal(readMainLedger(mainDir), null);

    const green = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
    assert.match(
      green.stderr,
      /consumption rejected \(HYK-266\): REVIEW-family result file does not carry a resolvable, finished verdict/,
    );
    assert.match(green.stderr, /does not start with HYK-<digits>/);
    assert.equal(readMainLedger(mainDir), null);
  });
});

// ===========================================================================
// S3: 원장 손상(LEDGER_INVALID_JSON) + approved(정직한, 깨끗한 판정) --
// 결과 파일 자신은 완전히 정상인데 원장이 깨져서 거부되는 "원장 사용
// 불가" 축을 approved 쪽에서 보인다(S4가 rejected + 빨간 영수증 쪽).
// ===========================================================================

test("S3 LEDGER_INVALID_JSON + approved: RED(수리 전) = 소비 통과 -> GREEN(수리 후) = 원장 사용 불가로 거부(원장 바이트 불변)", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    corruptLedgerInvalidJson(mainDir);
    const ledgerBefore = readFileSync(
      join(mainDir, ".harness", "reject-streak.json"),
      "utf8",
    );
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9912-review-1",
      forLine: "HYK-9912-review-1",
      verdict: "approved",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
    });

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-s3-pre-"),
      PRE_FIX_RELAY_SRC,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);

    const green = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
    assert.match(
      green.stderr,
      /consumption deferred \(HYK-266\): reject-streak ledger unavailable/,
    );
    assert.match(green.stderr, /LEDGER_INVALID_JSON|not valid JSON/i);
    const ledgerAfter = readFileSync(
      join(mainDir, ".harness", "reject-streak.json"),
      "utf8",
    );
    assert.equal(
      ledgerAfter,
      ledgerBefore,
      "the corrupted ledger's bytes must be untouched by a blocked consumption attempt",
    );
  });
});

// ===========================================================================
// S4 (HYK-438 P2-1 부분집합): 원장 손상(LEDGER_INVALID_JSON) + rejected +
// head 일치 -- "정직한 빨간 반려"를 통과시키던 바로 그 모양. RED(수리
// 전) -> GREEN(수리 후, 거부) -> 원장 복구 -> 같은 결과를 다시 소비하면
// ok, streak=1 (판정 보존 실증, PM-r14 (b) 핵심 주장).
// ===========================================================================

test("S4 LEDGER_INVALID_JSON + rejected (HYK-438 P2-1 부분집합): RED(수리 전) = 통과 -> GREEN(수리 후) = 거부 -> 원장 복구 -> 같은 세대 재소비 ok, streak=1", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    corruptLedgerInvalidJson(mainDir);
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9913-review-1",
      forLine: "HYK-9913-review-1",
      verdict: "rejected",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
    });

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-s4-pre-"),
      PRE_FIX_RELAY_SRC,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);

    const blocked = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(blocked.exit, 1, `GREEN must block: ${blocked.stderr}`);
    assert.equal(
      readMainLedger(mainDir),
      "CORRUPTED",
      "the ledger file must still exist in its corrupted (not valid JSON) form -- nothing was overwritten with a guessed entry",
    );

    // 원장 복구 (사람 손 -- PM-r14 (b): 이 복구 손은 이미 필요했다, 배달
    // 게이트가 REJECT_LEDGER_CORRUPT로 이미 전체를 세운 상태였다).
    rmSync(join(mainDir, ".harness", "reject-streak.json"));

    const reconsumed = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(
      reconsumed.exit,
      0,
      `re-consuming the SAME result after ledger repair must succeed: ${reconsumed.stderr}`,
    );
    const ledger = readMainLedger(mainDir);
    assert.ok(ledger, "ledger must now exist");
    assert.equal(ledger.issues["HYK-9913"].streak, 1);
    assert.equal(ledger.issues["HYK-9913"].history.length, 1);
    assert.equal(ledger.issues["HYK-9913"].history[0].verdict, "rejected");
  });
});

// ===========================================================================
// S5: LEDGER_WRITE_ERROR -- 원장 경로의 부모 디렉터리(.harness) 자체가
// 없다(PM-r14가 제안한 "원장 경로를 디렉터리로"는 직접 실측 결과
// LEDGER_READ_FAILED를 낸다 -- loadLedger가 existsSync로 "있다"로 보고
// readFileSync에서 EISDIR로 먼저 죽기 때문이다; LEDGER_WRITE_ERROR를
// 실제로 내려면 읽기는 "파일 없음"으로 통과하고 쓰기에서만 죽어야
// 한다 -- 부모 디렉터리 자체가 없으면 existsSync(ledgerPath)=false로
// loadLedger를 건너뛰고, writeLedger의 writeFileSync가 ENOENT로 죽는다.
// 아래 LEDGER_READ_FAILED는 §M에서 PM-r14가 제안한 기법 그대로 다룬다).
// ===========================================================================

test("S5 LEDGER_WRITE_ERROR (parent .harness 디렉터리 부재): RED(수리 전) = 소비 통과 -> GREEN(수리 후) = 원장 사용 불가로 거부", () => {
  const mainDir = tmpDir("hyk266-blk-s5-main-");
  try {
    // ⛔initPlainGitRepo를 쓰지 않는다 -- 이 표본의 핵심이 ".harness가
    // 아예 없다"이므로 그 디렉터리를 만들지 않는다.
    git(mainDir, ["init", "--quiet", "-b", "main"]);
    git(mainDir, [
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
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9914-review-1",
        forLine: "HYK-9914-review-1",
        verdict: "rejected",
        droppedAt: "2026-11-06 06:00",
        doneAt: "2026-11-06 06:10:00",
      });

      const preFixPath = writeScriptsCheckCopy(
        tmpDir("hyk266-blk-s5-pre-"),
        PRE_FIX_RELAY_SRC,
      );
      const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
        cwd: linkedDir,
      });
      assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);
      assert.equal(existsSync(join(mainDir, ".harness")), false);

      const green = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
      assert.match(
        green.stderr,
        /consumption deferred \(HYK-266\): reject-streak ledger unavailable/,
      );
      assert.match(green.stderr, /ledger write failed unexpectedly/);
      assert.equal(
        existsSync(join(mainDir, ".harness")),
        false,
        "a blocked write must not fabricate the .harness directory either",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S6 (대조군): CODER 역할 + 손상된 원장 -- CODER는 reject-streak 기록을
// 시도조차 하지 않으므로(isReviewFamilyRole false) 이 라운드의 모든 새
// 차단 함수와 무관해야 한다. 종전대로 ok.
// ===========================================================================

test("S6 (대조군): CODER + 손상된 원장 -> 이 라운드의 변경과 무관 (종전대로 ok)", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    corruptLedgerInvalidJson(mainDir);
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(
      join(harnessDir, "coder-task.md"),
      "task_id: HYK-9915-coder-1\ndropped_at: 2026-11-06 06:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(harnessDir, "coder.md"),
      "task_id: HYK-9915-coder-1\n\n>>> DONE: CODER @ 2026-11-06 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["coder", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(result.exit, 0, `CODER must be unaffected: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /HYK-266/);
    assert.equal(
      readMainLedger(mainDir),
      "CORRUPTED",
      "CODER never touches the ledger -- the pre-existing corruption must be byte-for-byte untouched",
    );
  });
});

// ===========================================================================
// S7 (대조군): 정상 REVIEW approved/rejected, 깨끗한 원장 -- 무변.
// ===========================================================================

test("S7 (대조군): 정상 REVIEW rejected, 깨끗한 원장 -> 무변 (exit 0, streak=1)", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9916-review-1",
      forLine: "HYK-9916-review-1",
      verdict: "rejected",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(
      result.exit,
      0,
      `normal REVIEW must be unaffected: ${result.stderr}`,
    );
    const ledger = readMainLedger(mainDir);
    assert.ok(ledger);
    assert.equal(ledger.issues["HYK-9916"].streak, 1);
  });
});

test("S7b (대조군): 정상 REVIEW approved -> 무변 (exit 0, streak=0)", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9917-review-1",
      forLine: "HYK-9917-review-1",
      verdict: "approved",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(
      result.exit,
      0,
      `normal REVIEW must be unaffected: ${result.stderr}`,
    );
    const ledger = readMainLedger(mainDir);
    assert.ok(ledger);
    assert.equal(ledger.issues["HYK-9917"].streak, 0);
  });
});

// ===========================================================================
// S8: UNISOLATED_HARNESS_DIR -- harnessDir가 어떤 git worktree에도 속하지
// 않는다. 생산 경로에서는 head_commit 축(HYK-383)이 더 넓게 먼저 거부
// 하므로(hyk355-reject-streak-isolation.test.mjs (a)가 이미 고정한
// 사실 -- "REVIEW-family에 한해 사실상 도달 불가/죽은 코드"), 이 갈래
// 자체를 단독으로 보려면 그 축을 고립시킨 사본이 필요하다(같은 파일의
// (c)/(d)와 같은 defense-in-depth 격리 관용구).
// ===========================================================================

test("S8 UNISOLATED_HARNESS_DIR (head_commit 축 고립): RED(수리 전) = 소비 통과 + 흔적조차 없음 -> GREEN(수리 후) = 거부", () => {
  const mainDir = tmpDir("hyk266-blk-s8-main-");
  const probeDir = tmpDir("hyk266-blk-s8-probe-");
  try {
    initPlainGitRepo(mainDir);
    // probeDir는 절대 git init되지 않는다 -- UNISOLATED_HARNESS_DIR의
    // 정확한 모양(§0 실사고, HYK-355 자신의 재현과 같다).
    const taskId = "HYK-9918-review-1";
    writeFileSync(
      join(probeDir, "review-task.md"),
      `task_id: ${taskId}\ndropped_at: 2026-11-06 06:00 KST\n`,
      "utf8",
    );
    writeFileSync(
      join(probeDir, "review.md"),
      `task_id: ${taskId}\nfor: ${taskId}\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-11-06 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-s8-pre-"),
      PRE_FIX_RELAY_SRC_ISOLATED,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", probeDir], {
      cwd: mainDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);
    // PM-r14 (a) 실측 그대로: UNISOLATED_HARNESS_DIR은 attempted:false라
    // traceUnblockedRecordFailure조차 못 본다 -- NOT_BLOCKED 흔적도 없다.
    assert.doesNotMatch(red.stdout, /NOT_BLOCKED/);
    assert.equal(readMainLedger(mainDir), null);

    const greenIsolatedPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-s8-green-"),
      LIVE_RELAY_SRC_ISOLATED,
    );
    const green = runRelayHandshakeCli(
      greenIsolatedPath,
      ["review", probeDir],
      {
        cwd: mainDir,
      },
    );
    assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
    assert.match(
      green.stderr,
      /consumption rejected \(HYK-266, 범위 밖 발견 ⓐ\)/,
    );
    assert.match(green.stderr, /refusing mainRepoRoot\(\) default/);
    assert.equal(readMainLedger(mainDir), null);

    // 생산 경로(격리 없음)에서는 head_commit 축이 더 넓게 먼저 거부한다
    // -- 이 사실 자체가 HYK-355 (a)가 이미 고정했지만, 이 파일 자신도
    // 재확인한다(이 축 자체가 사라지지 않았는지 무회귀).
    const production = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", probeDir],
      { cwd: mainDir },
    );
    assert.equal(production.exit, 1);
    assert.match(production.stderr, /missing head_commit header/);
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// §K (보완, 전건 커버리지): NO_COVER_LINE -- ⚠️정직 한계: 생산 경로
// (checkRelayHandshake)는 이 갈래에 도달하기 «전에» 이미 task_id echo를
// 요구한다(resolveMatchedTaskId -> resolveResultTaskId, 결과 파일에
// task_id: 줄이 하나도 없으면 그 쪽이 먼저 MISSING으로 거부한다) --
// task_id: 줄이 있으면 reject-streak.mjs 자신의 TASK_ID_LINE_RE_G도 같은
// 줄을 찾아 rawTaskId가 채워지므로, NO_COVER_LINE(for:도 task_id:도 전혀
// 없음)은 이 생산 경로 "전체"로는 구조적으로 재현할 수 없다(두 파서가
// 같은 "task_id: 줄"을 같은 마스킹으로 찾기 때문). hyk357-for-line-
// diagnostics.test.mjs의 "★회귀 0" 시험이 이미 같은 방식(parseReviewOutcome
// 직접 구동)으로 이 코드를 고정한다 -- 이 시험은 그 축과 같은 production
// export를 다시 구동해 ⑴ 이 라운드가 그 코드를 CONTRACT_VIOLATION_
// REASON_CODES에 넣었다는 분류 결정과 ⑵ relay-handshake.mjs의
// checkContractViolation이 그 reasonCode를 실제로 차단으로 번역하는지
// (recordOutcome을 직접 구성해 checkRelayHandshake 자체가 아니라 그
// 내부 체인의 다음 단계인 recordRejectStreakFromResultText까지만
// 직접 구동) 함께 고정한다.
// ===========================================================================

test("§K NO_COVER_LINE (정직 한계: 생산 경로 전체로는 구조적으로 재현 불가 -- 직접 구동으로 분류만 확인): parseReviewOutcome이 NO_COVER_LINE을 내고, recordRejectStreakFromResultText도 같은 reasonCode로 attempted:true/ok:false를 낸다", () => {
  const direct = parseReviewOutcome("verdict: rejected\n");
  assert.equal(direct.ok, false);
  assert.equal(direct.reasonCode, REJECT_STREAK_REASON_CODE.NO_COVER_LINE);

  const mainDir = tmpDir("hyk266-blk-k-main-");
  try {
    initPlainGitRepo(mainDir);
    const ledgerPath = join(mainDir, ".harness", "reject-streak.json");
    const outcome = recordRejectStreakFromResultText({
      role: "review",
      resultText: "verdict: rejected\n",
      ledgerPath,
    });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, REJECT_STREAK_REASON_CODE.NO_COVER_LINE);
    assert.equal(
      readMainLedger(mainDir),
      null,
      "NO_COVER_LINE must never write the ledger (fail-open, read-only diagnosis)",
    );
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// §L (보완, 전건 커버리지): LEDGER_READ_FAILED -- 원장 경로 자체가
// 디렉터리다(실측: existsSync=true -> readFileSync가 EISDIR로 죽는다 --
// PM-r14가 S5의 기법으로 제안했던 바로 그 조작, 이 파일 §B의 S5 헤더
// 주석이 적은 실측 결과대로 LEDGER_WRITE_ERROR가 아니라 이 코드를
// 낸다). 전건 생산 경로(실 CLI)로 재현 가능하다.
// ===========================================================================

test("§L LEDGER_READ_FAILED (원장 경로 자체가 디렉터리): RED(수리 전) = 소비 통과 -> GREEN(수리 후) = 원장 사용 불가로 거부", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    rmSync(join(mainDir, ".harness", "reject-streak.json"), {
      force: true,
    });
    mkdirSync(join(mainDir, ".harness", "reject-streak.json"), {
      recursive: true,
    });
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9919-review-1",
      forLine: "HYK-9919-review-1",
      verdict: "rejected",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
    });

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-l-pre-"),
      PRE_FIX_RELAY_SRC,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);

    const green = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
    assert.match(
      green.stderr,
      /consumption deferred \(HYK-266\): reject-streak ledger unavailable/,
    );
    assert.match(green.stderr, /failed to read ledger/);
  });
});

// ===========================================================================
// §M (보완, 전건 커버리지): LEDGER_INVALID_SHAPE -- 유효한 JSON이지만
// `issues` 모양이 아니다.
// ===========================================================================

test("§M LEDGER_INVALID_SHAPE (유효한 JSON, issues 모양 위반): RED(수리 전) = 소비 통과 -> GREEN(수리 후) = 원장 사용 불가로 거부", () => {
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    writeFileSync(
      join(mainDir, ".harness", "reject-streak.json"),
      JSON.stringify({ schema_version: 1 }),
      "utf8",
    );
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9920-review-1",
      forLine: "HYK-9920-review-1",
      verdict: "rejected",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
    });

    const preFixPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-m-pre-"),
      PRE_FIX_RELAY_SRC,
    );
    const red = runRelayHandshakeCli(preFixPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(red.exit, 0, `RED precondition failed: ${red.stderr}`);

    const green = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(green.exit, 1, `GREEN must block: ${green.stderr}`);
    assert.match(
      green.stderr,
      /consumption deferred \(HYK-266\): reject-streak ledger unavailable/,
    );
    assert.match(green.stderr, /missing\/invalid 'issues' object/);
  });
});

// ===========================================================================
// §N~§Q: 변이 ≥4 (ⓓ 요구). 전부 LIVE(수리 후) 소스에서 시작해 특정
// 보호를 제거하고, 그 보호가 지키던 표본이 다시 새는지(RED) 본다.
// ===========================================================================

// ① 계약 위반 집합에서 원소 1개(NO_VERDICT_LINE) 제거 -> S1이 다시 통과.
test("변이①: CONTRACT_VIOLATION_REASON_CODES에서 NO_VERDICT_LINE 제거 -> S1 입력이 다시 통과한다(RED)", () => {
  const target =
    "const CONTRACT_VIOLATION_REASON_CODES = new Set([\n" +
    "  REJECT_STREAK_REASON_CODE.NO_VERDICT_LINE,\n" +
    "  REJECT_STREAK_REASON_CODE.NO_COVER_LINE,\n" +
    "  REJECT_STREAK_REASON_CODE.ISSUE_ID_UNPARSEABLE,\n" +
    "]);";
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_SRC,
    target,
    "CONTRACT_VIOLATION_REASON_CODES declaration",
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(
    target,
    "const CONTRACT_VIOLATION_REASON_CODES = new Set([\n" +
      "  REJECT_STREAK_REASON_CODE.NO_COVER_LINE,\n" +
      "  REJECT_STREAK_REASON_CODE.ISSUE_ID_UNPARSEABLE,\n" +
      "]);",
  );
  withRepoPair(({ mainDir, linkedDir, harnessDir }) => {
    writeReviewFixture(harnessDir, {
      taskId: "HYK-9921-review-1",
      forLine: "HYK-9921-review-1",
      droppedAt: "2026-11-06 06:00",
      doneAt: "2026-11-06 06:10:00",
      extraResultLines: "verdict: changes_requested\n",
    });
    const mutantPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-mut1-"),
      mutated,
    );
    const result = runRelayHandshakeCli(mutantPath, ["review", harnessDir], {
      cwd: linkedDir,
    });
    assert.equal(
      result.exit,
      0,
      `RED: removing NO_VERDICT_LINE from the Set must reopen S1's pass-through: ${result.stderr}`,
    );
    assert.equal(readMainLedger(mainDir), null);
  });

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(after, RELAY_HANDSHAKE_SRC, "원복 증명");
});

// ② 원장 사용 불가 집합에서 "LEDGER_WRITE_ERROR" 제거 -> S5가 다시 통과.
test("변이②: LEDGER_UNAVAILABLE_REASON_CODES에서 'LEDGER_WRITE_ERROR' 제거 -> S5 입력이 다시 통과한다(RED)", () => {
  const target =
    "const LEDGER_UNAVAILABLE_REASON_CODES = new Set([\n" +
    "  REJECT_STREAK_REASON_CODE.LEDGER_READ_FAILED,\n" +
    "  REJECT_STREAK_REASON_CODE.LEDGER_INVALID_JSON,\n" +
    "  REJECT_STREAK_REASON_CODE.LEDGER_INVALID_SHAPE,\n" +
    '  "LEDGER_WRITE_ERROR",\n' +
    "]);";
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_SRC,
    target,
    "LEDGER_UNAVAILABLE_REASON_CODES declaration",
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(
    target,
    "const LEDGER_UNAVAILABLE_REASON_CODES = new Set([\n" +
      "  REJECT_STREAK_REASON_CODE.LEDGER_READ_FAILED,\n" +
      "  REJECT_STREAK_REASON_CODE.LEDGER_INVALID_JSON,\n" +
      "  REJECT_STREAK_REASON_CODE.LEDGER_INVALID_SHAPE,\n" +
      "]);",
  );

  const mainDir = tmpDir("hyk266-blk-mut2-main-");
  try {
    git(mainDir, ["init", "--quiet", "-b", "main"]);
    git(mainDir, [
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
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      writeReviewFixture(harnessDir, {
        taskId: "HYK-9922-review-1",
        forLine: "HYK-9922-review-1",
        verdict: "rejected",
        droppedAt: "2026-11-06 06:00",
        doneAt: "2026-11-06 06:10:00",
      });
      const mutantPath = writeScriptsCheckCopy(
        tmpDir("hyk266-blk-mut2-"),
        mutated,
      );
      const result = runRelayHandshakeCli(mutantPath, ["review", harnessDir], {
        cwd: linkedDir,
      });
      assert.equal(
        result.exit,
        0,
        `RED: removing LEDGER_WRITE_ERROR from the Set must reopen S5's pass-through: ${result.stderr}`,
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(after, RELAY_HANDSHAKE_SRC, "원복 증명");
});

// ③ reject-streak.mjs의 parse/load 순서를 되돌림 -> 원장 손상 + 판정 줄
// 2개 이상(모호)이 겹친 표본의 "사유"가 LEDGER_*에서 AMBIGUOUS_VERDICT_LINE
// 으로 바뀐다(어느 쪽이 보이는지가 순서에 의존한다는 것 자체를 고정).
// 변이③ 전용: reject-streak.mjs의 parse-before-load 블록(§2 ⓘⓘⓘ 헤더
// 주석 포함)을 제거해 "load 먼저" 되돌림 사본을 만든다.
const PARSE_BEFORE_LOAD_TARGET =
  "  // HYK-266 §2 ⓘⓘⓘ: parse 먼저, load 나중 -- 위반 사유(결과 파일 자신의\n" +
  "  // 계약 위반)가 원장 사유(읽기/쓰기 실패)보다 우선한다. 되돌린 순서\n" +
  "  // (load 먼저)에서는 원장이 손상된 동안 결과 파일도 깨졌을 때 항상\n" +
  "  // LEDGER_* 사유만 보이고, 결과 파일 자신의 계약 위반(예: 표지 줄 2개\n" +
  "  // 이상, NO_VERDICT_LINE 등)은 한 번도 드러나지 않았다 -- loadLedger가\n" +
  "  // parseReviewOutcome을 부르기도 전에 먼저 ok:false로 돌아갔기 때문이다\n" +
  "  // (PM-r14 (a) 실측 원문). computeRecord 자신은 내부에서 다시\n" +
  "  // parseReviewOutcome을 부르므로(아래), 이 앞선 호출은 그 함수의 계약/\n" +
  "  // 시그니처를 하나도 바꾸지 않는다 -- 순서만 앞당긴 추가 확인이다.\n" +
  "  const outcome = parseReviewOutcome(resultText);\n" +
  "  if (!outcome.ok) {\n" +
  "    return {\n" +
  "      attempted: true,\n" +
  "      ok: false,\n" +
  "      reasonCode: outcome.reasonCode,\n" +
  "      reason: `reject-streak auto-record: UNJUDGABLE -- ${outcome.reason} (fail-open, ledger untouched)`,\n" +
  "    };\n" +
  "  }\n" +
  "\n";

function writeMutation3Fixture(linkedDir) {
  const harnessDir = join(linkedDir, ".harness");
  const taskId = "HYK-9923-review-1";
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(linkedDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: 2026-11-06 06:00 KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  // 원장도 손상 + 판정 줄도 2개(모호) -- 두 결함이 겹친 표본.
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: rejected\nverdict: approved\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ 2026-11-06 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
  return harnessDir;
}

function assertMutation3Outcomes(mutantPath, harnessDir, linkedDir) {
  const redOrder = runRelayHandshakeCli(mutantPath, ["review", harnessDir], {
    cwd: linkedDir,
  });
  assert.equal(redOrder.exit, 1, "still blocked either way");
  assert.match(
    redOrder.stderr,
    /consumption deferred \(HYK-266\): reject-streak ledger unavailable/,
    "RED: with load-first order, the LEDGER_* reason wins even though the result ALSO has an ambiguous verdict-line violation",
  );
  assert.doesNotMatch(redOrder.stderr, /AMBIGUOUS_VERDICT_LINE/);

  const liveOrder = runRelayHandshakeCli(
    RELAY_HANDSHAKE_PATH,
    ["review", harnessDir],
    { cwd: linkedDir },
  );
  assert.equal(liveOrder.exit, 1);
  assert.match(
    liveOrder.stderr,
    /consumption rejected \(HYK-262\): REVIEW-family result file violates the 표지 줄 계약/,
    "GREEN: with parse-first order, the ambiguous-verdict (contract) reason wins instead",
  );
  assert.match(liveOrder.stderr, /AMBIGUOUS_VERDICT_LINE|판정 줄이 2개/);
}

test("변이③: reject-streak.mjs의 parse/load 순서를 되돌리면(load 먼저) -- 원장 손상 + 판정 줄 2개 겹친 표본의 사유가 LEDGER_INVALID_JSON에서 AMBIGUOUS_VERDICT_LINE으로 바뀐다(RED, 순서가 load-bearing임을 증명)", () => {
  assertExactlyOneMatch(
    REJECT_STREAK_SRC,
    PARSE_BEFORE_LOAD_TARGET,
    "parse-before-load block",
  );
  const mutatedStreak = REJECT_STREAK_SRC.replace(PARSE_BEFORE_LOAD_TARGET, "");

  const mainDir = tmpDir("hyk266-blk-mut3-main-");
  try {
    initPlainGitRepo(mainDir);
    corruptLedgerInvalidJson(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = writeMutation3Fixture(linkedDir);
      const mutantPath = writeScriptsCheckCopy(
        tmpDir("hyk266-blk-mut3-"),
        RELAY_HANDSHAKE_SRC,
        { streakSrc: mutatedStreak },
      );
      assertMutation3Outcomes(mutantPath, harnessDir, linkedDir);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
  }

  const after = readFileSync(join(HERE, "reject-streak.mjs"), "utf8");
  assert.equal(after, REJECT_STREAK_SRC, "원복 증명");
});

// ④ checkUnisolatedHarnessDirViolation 호출 제거 -> S8이 다시 통과.
test("변이④: checkUnisolatedHarnessDirViolation 호출 제거 -> S8 입력이 다시 통과한다(RED)", () => {
  const target =
    "  const unisolatedViolation = checkUnisolatedHarnessDirViolation(recordOutcome);\n" +
    "  if (unisolatedViolation) return unisolatedViolation;\n";
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_SRC,
    target,
    "checkUnisolatedHarnessDirViolation call site",
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(target, "");
  const mutatedIsolated = mutated.replace(HEAD_COMMIT_AXIS_CALL_TARGET, "");

  const mainDir = tmpDir("hyk266-blk-mut4-main-");
  const probeDir = tmpDir("hyk266-blk-mut4-probe-");
  try {
    initPlainGitRepo(mainDir);
    const taskId = "HYK-9924-review-1";
    writeFileSync(
      join(probeDir, "review-task.md"),
      `task_id: ${taskId}\ndropped_at: 2026-11-06 06:00 KST\n`,
      "utf8",
    );
    writeFileSync(
      join(probeDir, "review.md"),
      `task_id: ${taskId}\nfor: ${taskId}\nverdict: rejected\nrole: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-11-06 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const mutantPath = writeScriptsCheckCopy(
      tmpDir("hyk266-blk-mut4-"),
      mutatedIsolated,
    );
    const result = runRelayHandshakeCli(mutantPath, ["review", probeDir], {
      cwd: mainDir,
    });
    assert.equal(
      result.exit,
      0,
      `RED: removing the UNISOLATED_HARNESS_DIR check must reopen S8's pass-through: ${result.stderr}`,
    );
    assert.equal(readMainLedger(mainDir), null);
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(after, RELAY_HANDSHAKE_SRC, "원복 증명");
});
