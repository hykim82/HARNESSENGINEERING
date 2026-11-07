// HYK-262 §3 (책임자 확정 2R), HYK-266로 뒤집힘: 이 파일은 원래 "표지 줄
// 계약 위반(AMBIGUOUS_*)이 아닌 두 갈래(판정 줄 0개 = NO_VERDICT_LINE,
// 원장 파일 손상 = LEDGER_INVALID_JSON 등)는 소비를 막지 않는다 -- 대신
// '그 판단 자체'가 'NOT_BLOCKED' 흔적으로 명시적으로 남는다"는 §3의
// 결정을 고정했었다.
//
// HYK-266 (PM-r14 설계)이 그 결정을 뒤집었다: 라이브 표본 전수(HYK-214·
// 218·227·335 네 라운드 전부)가 정확히 이 모양이었고, 소비를 통과시키면
// 판정이 복구 수단 없이 영원히 빠진다(PM-r14 (a)⑤·(b) 실측) -- 그래서
// 이 두 갈래(+ 나머지 5종 + UNISOLATED_HARNESS_DIR)는 이제 '통과 + 흔적'
// 이 아니라 '소비 자체를 막는다'. 이 파일은 그 뒤집힌 계약을 고정한다.
//
// ⛔모든 원장/영수증은 mkdtemp 합성 픽스처다 -- 실제 관제실 정본에는 절대
// 쓰지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { REJECT_STREAK_REASON_CODE } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const RELAY_HANDSHAKE_SRC = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");

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
  const linkedDir = tmpDir("hyk262-nb-linked-");
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

// HYK-383: REVIEW 계열 소비는 head_commit: 축(축 ⓐ+ⓑ)도 통과해야 한다 --
// 이 파일의 fixture는 이 축과 무관한(이제는 "블록" 동작) 동작을 시험하므로,
// head_commit 축이 그 관찰을 가리지 않도록 항상 실제 워크트리 HEAD로
// 채운다(harnessDir는 이미 진짜 링크드 워크트리 안이다).
function writeNoVerdictFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(harnessDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  // 판정 줄이 0개 -- NO_VERDICT_LINE.
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function writeNormalRejectFixture(harnessDir, { taskId, droppedAt, doneAt }) {
  mkdirSync(harnessDir, { recursive: true });
  const headCommit = git(harnessDir, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(harnessDir, "review-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nhead_commit: ${headCommit}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "review.md"),
    `task_id: ${taskId}\nfor: ${taskId}\nverdict: rejected\nrole: REVIEW-CODEX\nhead_commit: ${headCommit}\n\n>>> DONE: REVIEW-CODEX @ ${doneAt} KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// ① NO_VERDICT_LINE -- HYK-266 이전엔 차단하지 않고 NOT_BLOCKED 흔적만
// 남겼다. 이제는 소비 자체를 막는다(계약 위반).
// ---------------------------------------------------------------------------

test("① NO_VERDICT_LINE (HYK-266로 갱신): 판정 줄 0개는 이제 소비를 막는다 -- NOT_BLOCKED 흔적은 더 이상 남지 않는다", () => {
  withRepoAndFixture((harnessDir, linkedDir) => {
    writeNoVerdictFixture(harnessDir, {
      taskId: "HYK-9800-review-1",
      droppedAt: "2026-08-14 20:00",
      doneAt: "2026-08-14 20:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(
      result.exit,
      1,
      `HYK-266: NO_VERDICT_LINE must now block consumption: ${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stdout,
      /NOT_BLOCKED/,
      "the old 'not blocked' trace must be gone for this reasonCode -- it is now intercepted earlier",
    );
    assert.match(
      result.stderr,
      /consumption rejected \(HYK-266\): REVIEW-family result file does not carry a resolvable, finished verdict/,
      "the new HYK-266 consumption-rejected line must name the reasonCode's own diagnostic",
    );
    assert.match(result.stderr, /NO_VERDICT_LINE|UNJUDGABLE/);
  });
});

// ---------------------------------------------------------------------------
// ② LEDGER_INVALID_JSON -- 같은 뒤집힘.
// ---------------------------------------------------------------------------

test("② LEDGER_INVALID_JSON (HYK-266로 갱신): 원장 파일이 깨지면 이제 소비를 막는다 -- NOT_BLOCKED 흔적은 더 이상 남지 않는다", () => {
  withRepoAndFixture((harnessDir, linkedDir, mainDir) => {
    writeFileSync(
      join(mainDir, ".harness", "reject-streak.json"),
      "{ this is not valid JSON",
      "utf8",
    );
    writeNormalRejectFixture(harnessDir, {
      taskId: "HYK-9801-review-1",
      droppedAt: "2026-08-14 20:00",
      doneAt: "2026-08-14 20:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(
      result.exit,
      1,
      `HYK-266: ledger corruption must now block consumption: ${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stdout,
      /NOT_BLOCKED/,
      "the old 'not blocked' trace must be gone for this reasonCode -- it is now intercepted earlier",
    );
    assert.match(
      result.stderr,
      /consumption deferred \(HYK-266\): reject-streak ledger unavailable/,
      "the new HYK-266 consumption-deferred line must appear",
    );
    assert.match(result.stderr, /LEDGER_INVALID_JSON|not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// ③ (HYK-266 재작업) -- traceUnblockedRecordFailure의 호출 자체를 지운
// 변이가, 이제는 ①의 입력(NO_VERDICT_LINE)에서 '아무 관측 가능한 차이도
// 만들지 못함'을 증명한다. 이전(HYK-262 시절)에는 이 변이가 "NOT_BLOCKED
// 흔적이 사라진다"는 RED 신호였다 -- 이제는 checkContractViolation이 그
// 호출 "앞에서" 이미 막으므로, 그 호출이 있든 없든 출력이 바이트 단위로
// 같다. 이것이 바로 결과 파일 §3-4가 요구하는 "남은 갈래가 0" 증명이다
// (traceUnblockedRecordFailure 자신은 지우지 않고 fail-visible 안전망으로
// 남긴다 -- relay-handshake.mjs 자신의 새 헤더 주석 참조).
// ---------------------------------------------------------------------------

test("③ (HYK-266 재작업): NOT_BLOCKED 흔적 호출을 제거해도 ①의 입력에서 산출이 바이트 단위로 동일하다 (이제 그 호출은 이 입력에 도달하지 못하는 죽은 경로다), 원복 후 무손상", () => {
  const target = "  traceUnblockedRecordFailure(recordOutcome);\n";
  const count = RELAY_HANDSHAKE_SRC.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (the traceUnblockedRecordFailure call site) must appear exactly once (found ${count}) -- update this test if the call site legitimately moved`,
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(target, "");

  withRepoAndFixture(
    (harnessDir, linkedDir, mainDir, mutantDir) => {
      const scriptsCheckDir = join(mutantDir, "scripts", "check");
      mkdirSync(scriptsCheckDir, { recursive: true });
      writeFileSync(
        join(scriptsCheckDir, "relay-handshake.mjs"),
        mutated,
        "utf8",
      );
      for (const dep of [
        "reject-streak.mjs",
        "envelope-archive.mjs",
        "time-authority.mjs",
        "child-probe-timeout-policy.mjs",
        "admission-completion-adapter.mjs",
        // HYK-302/355 §2-A dedup: admission-completion-adapter.mjs now
        // statically imports this shared module.
        "ledger-pointer-shared.mjs",
        // HYK-398 §2-⑶: admission-completion-adapter.mjs now also
        // statically imports this zero-import core.
        "retirement-record-core.mjs",
        // HYK-457 §3-A: admission-completion-adapter.mjs now also
        // statically imports this (confirmRetirementBlockReason dedup).
        "retirement-block-reason-shared.mjs",
        "consumption-receipt-writer.mjs",
        "consumption-receipt-core.mjs",
      ]) {
        writeFileSync(
          join(scriptsCheckDir, dep),
          readFileSync(join(HERE, dep), "utf8"),
          "utf8",
        );
      }
      const mutantRelay = join(scriptsCheckDir, "relay-handshake.mjs");

      writeNoVerdictFixture(harnessDir, {
        taskId: "HYK-9802-review-1",
        droppedAt: "2026-08-14 20:00",
        doneAt: "2026-08-14 20:10:00",
      });
      const mutantResult = runRelayHandshakeCli(
        mutantRelay,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      const liveResult = runRelayHandshakeCli(
        RELAY_HANDSHAKE_PATH,
        ["review", harnessDir],
        { cwd: linkedDir },
      );
      assert.equal(
        mutantResult.exit,
        1,
        "HYK-266: still blocked -- checkContractViolation runs before the removed trace call",
      );
      // ⚠️전체 stderr를 바이트 대조하지 않는다 -- 이 mkdtemp 사본은
      // first-observation.mjs 같은 일부 형제 모듈을 복제하지 않아 그 축의
      // best-effort 경고(이 시험의 주제와 무관)가 따로 끼어든다. 이
      // 시험이 증명하려는 것은 좁다: exit code와 "소비를 막았다"는
      // 핵심 판정 문면이 트레이스 호출의 유무와 무관하게 같다는 것뿐.
      assert.equal(mutantResult.exit, liveResult.exit);
      assert.doesNotMatch(mutantResult.stdout, /NOT_BLOCKED/);
      assert.doesNotMatch(liveResult.stdout, /NOT_BLOCKED/);
      assert.match(
        mutantResult.stderr,
        /consumption rejected \(HYK-266\): REVIEW-family result file does not carry a resolvable, finished verdict/,
        "mutant (trace call removed) still produces the exact same blocking verdict line",
      );
      assert.match(
        liveResult.stderr,
        /consumption rejected \(HYK-266\): REVIEW-family result file does not carry a resolvable, finished verdict/,
      );
    },
    { withMutantDir: true },
  );

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    RELAY_HANDSHAKE_SRC,
    "원복 증명: the real relay-handshake.mjs must be byte-identical before/after this test",
  );
});

// ---------------------------------------------------------------------------
// ④ (신규) 완전성 닻: reject-streak.mjs의 REJECT_STREAK_REASON_CODE enum
// 전수(현재 정의된 모든 값) + 이 파일 로컬 리터럴 둘("LEDGER_WRITE_ERROR"
// · "UNISOLATED_HARNESS_DIR")이 relay-handshake.mjs 소스 문자열 «어딘가에»
// 등장하는지를 grep 형태로 자기 점검한다(ORCH70 §33b 사전-그렙 문자열 닻과
// 같은 정신). ⚠️정직 한계: "그 문자열이 파일에 있다"는 "분류 Set 안에
// 있다"의 약한 근사다(Set을 export하지 않으므로 더 정밀하게 집을 수
// 없다 -- 기존 AMBIGUOUS_COVER_REASON_CODES도 비공개다) -- 그러나 미래에
// reject-streak.mjs가 11번째 reasonCode를 추가하면 그 새 식별자 문자열은
// relay-handshake.mjs 어디에도 아직 없을 것이므로, 이 닻은 "완전히 새로
// 추가됐는데 통째로 안 건드렸다"는 사고는 여전히 잡는다(지금 10종 + 로컬
// 2종 = 0건 미분류라는 스냅샷만 고정한다).
// ---------------------------------------------------------------------------

test("④ (신규) 완전성 닻 (정직 한계 있음): 현재 정의된 모든 reject-streak reasonCode 문자열이 relay-handshake.mjs 소스 어딘가에 등장한다 (0건 미분류 스냅샷)", () => {
  const allReasonCodes = [
    ...Object.values(REJECT_STREAK_REASON_CODE),
    "LEDGER_WRITE_ERROR",
    "UNISOLATED_HARNESS_DIR",
  ];
  const missing = allReasonCodes.filter(
    (code) =>
      !RELAY_HANDSHAKE_SRC.includes(`"${code}"`) &&
      !RELAY_HANDSHAKE_SRC.includes(`.${code}`),
  );
  assert.deepEqual(
    missing,
    [],
    `every currently-defined reasonCode must be classified somewhere in relay-handshake.mjs (found unclassified: ${JSON.stringify(missing)}) -- a future reject-streak.mjs addition that lands here means someone forgot to add it to a blocking Set`,
  );
});

// re-confirm the real source is still GREEN (blocks, no NOT_BLOCKED trace)
// after the mutant ran against an isolated copy.
test("(원복 후 재확인) 실 소스로 ①과 같은 입력을 다시 돌리면 여전히 소비를 막고, NOT_BLOCKED 흔적은 남지 않는다", () => {
  withRepoAndFixture((harnessDir, linkedDir) => {
    writeNoVerdictFixture(harnessDir, {
      taskId: "HYK-9803-review-1",
      droppedAt: "2026-08-14 20:00",
      doneAt: "2026-08-14 20:10:00",
    });
    const result = runRelayHandshakeCli(
      RELAY_HANDSHAKE_PATH,
      ["review", harnessDir],
      { cwd: linkedDir },
    );
    assert.equal(result.exit, 1);
    assert.doesNotMatch(result.stdout, /NOT_BLOCKED/);
  });
});

function withRepoAndFixture(fn, { withMutantDir = false } = {}) {
  const mainDir = tmpDir("hyk262-nb-main-");
  const mutantDir = withMutantDir ? tmpDir("hyk262-nb-mutant-") : null;
  try {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const harnessDir = join(linkedDir, ".harness");
      return fn(harnessDir, linkedDir, mainDir, mutantDir);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(mainDir, { recursive: true, force: true });
    if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
  }
}
