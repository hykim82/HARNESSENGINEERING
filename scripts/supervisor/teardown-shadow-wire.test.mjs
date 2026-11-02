// HYK-464-teardown-shadow-1 (coder-task.md §2 product_scope ③, §2 1b_exec_line) --
// 축C가 그림자로 구동하는 아카이브 판정(judgeArchiveEligibility)의 watch-run.mjs
// 결선 시험. 프로덕션 진입점(runWatchOnce)을 fake execFn/git/fs로 직접
// 구동한다(헛시험 방지 -- 재구현/모킹 레이어를 시험 대상 자리에 두지 않는다,
// hyk464-followup-1-resource-residue.test.mjs와 동일 원칙).
//
// 이 스위트가 증명하는 것:
// 1. resourceResidue.teardownShadow를 opt-in으로 주지 않으면(resourceResidue
//    자체가 없거나, 있어도 teardownShadow가 없으면) 로그 줄에 teardown_shadow_
//    토큰이 전혀 없다(회귀 0).
// 2. opt-in으로 주면 실제 진입점을 통해 워크트리별 ELIGIBLE/거부가 판정되고
//    watch.log에 teardown_shadow_* 세그먼트로 남는다.
// 3. ELIGIBLE이 1건 이상이면 받는함(notifyDir)에 통지 파일이 생기고, 같은
//    ELIGIBLE 집합이 이어지는 다음 회차는 재통지하지 않는다(파일 개수 불변).
// 4. armed=false 고정 -- 이 축은 어떤 실행에서도 파괴적 argv를 만들지
//    않는다(gitFn/lsRemoteFn에 전달된 argv 전수 검사 + 정적 소스 확인).
// 5. 은퇴 기록이 있으면 미소비 라운드를 "소비됨"으로 센다(§2 product_scope ①ⓑ).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWatchOnce } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-11-02T21:50:00+09:00");

const WT_ELIGIBLE = "C:/wt/archive-candidate";
const WT_NOT_MERGED = "C:/wt/still-in-progress";
const SHA_HEAD = "1".repeat(40);
const SHA_HEAD_OTHER = "2".repeat(40);
const SHA_REMOTE = "3".repeat(40);

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-teardown-shadow-"));
}
function tmpNotifyDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-teardown-shadow-notify-"));
}

function progressingExecFn() {
  return JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" });
}

// unconsumedWorstWorktrees에 아무것도 없는(= 둘 다 미소비 라운드 0) detector
// stdout.
function cleanUnconsumedExecFn() {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    unconsumed: {
      status: "JUDGED",
      verdict: "CONSUMED",
      worstWorktreePaths: [],
      worstCount: 0,
      totalWorktrees: 2,
    },
  });
}

// WT_ELIGIBLE이 "미소비 의심"으로 잡혀 있는 detector stdout(ⓑ 축 재사용
// 증명용 -- 호출자가 이미 가진 HYK-185 결과를 그대로 받는다).
function firingUnconsumedExecFn() {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    unconsumed: {
      status: "JUDGED",
      verdict: "SUSPECTED_UNCONSUMED",
      worstWorktreePaths: [WT_ELIGIBLE],
      worstCount: 1,
      totalWorktrees: 2,
    },
  });
}

function baseTeardownShadow(overrides = {}) {
  return {
    gitFn: (argv, worktreePath) => {
      if (worktreePath === WT_ELIGIBLE) return `${SHA_HEAD}\n`;
      return `${SHA_HEAD_OTHER}\n`;
    },
    lsRemoteFn: () => `${SHA_REMOTE}\trefs/heads/master\n`,
    isAncestorFn: (headSha) => headSha === SHA_HEAD, // WT_ELIGIBLE만 조상.
    existsFn: () => false, // keep-reason.md 어디에도 없음.
    readFileFn: () => {
      throw new Error("should not be called -- keep-reason.md absent");
    },
    listHarnessFilesFn: () => [".harness/coder.md"],
    readFileBufferFn: () => Buffer.from("fixture"),
    retirementReaddirFn: () => {
      throw new Error("ENOENT");
    },
    ...overrides,
  };
}

test("HYK-464-teardown-shadow-1 회귀 0: resourceResidue.teardownShadow를 opt-in으로 주지 않으면(resourceResidue 자체 없음) 로그 줄에 teardown_shadow_ 토큰이 전혀 없다", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: progressingExecFn,
    });
    assert.equal(result.line.includes("teardown_shadow_"), false);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-464-teardown-shadow-1 회귀 0: resourceResidue는 켜져 있어도 teardownShadow가 없으면 다른 세 잔재 축만 보고되고 teardown_shadow_ 토큰은 없다", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: progressingExecFn,
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [] }),
        collectEvidenceFn: () => ({ items: [], failed: false }),
        listNodeProcessRowsFn: () => [],
      },
    });
    assert.match(result.line, /residue_worktree_no_reason=0/);
    assert.equal(result.line.includes("teardown_shadow_"), false);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("opt-in: 병합 완료 + keep-reason 없음 + 미소비 0인 워크트리는 ELIGIBLE, 미병합 워크트리는 거부 -- 둘 다 watch.log에 표면화된다", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: cleanUnconsumedExecFn,
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: [WT_ELIGIBLE, WT_NOT_MERGED],
        }),
        teardownShadow: baseTeardownShadow(),
      },
    });
    assert.match(result.line, /teardown_shadow_status=OK/);
    assert.match(result.line, /teardown_shadow_total=2/);
    assert.match(result.line, /teardown_shadow_eligible=1/);
    assert.match(result.line, /archive-candidate:ELIGIBLE/);
    // 상세 요약은 MAX_PARTIAL_FAILURE_REASON_CHARS(60자)로 잘린다(다른
    // *_detail 세그먼트와 동일한 truncateToken 재사용) -- 그래서 두 번째
    // 워크트리의 전체 사유 문자열까지는 보장하지 않고, 잘린 접두만 본다.
    assert.match(result.line, /still-in-progress:TEARDOWN_NOT_ME/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("opt-in ⓑ 재사용: detector가 이미 미소비(firing)로 잡은 워크트리는 거부되지만, 은퇴 기록이 있으면(파일 존재로만) 소비됨으로 세어 ELIGIBLE이 된다", () => {
  const watchDir = tmpWatchDir();
  try {
    const blockedResult = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: firingUnconsumedExecFn,
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [WT_ELIGIBLE] }),
        teardownShadow: baseTeardownShadow(),
      },
    });
    assert.match(blockedResult.line, /teardown_shadow_eligible=0/);
    assert.match(
      blockedResult.line,
      /archive-candidate:TEARDOWN_UNCONSUMED_ROUNDS_PRESENT/,
    );

    const retiredResult = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 1000,
      execFn: firingUnconsumedExecFn,
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [WT_ELIGIBLE] }),
        teardownShadow: baseTeardownShadow({
          retirementReaddirFn: () => ["coder-retire-r1.json"],
        }),
      },
    });
    assert.match(retiredResult.line, /teardown_shadow_eligible=1/);
    assert.match(retiredResult.line, /archive-candidate:ELIGIBLE/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("opt-in: ELIGIBLE이 1건 이상이면 받는함에 통지 파일이 생기고, 같은 ELIGIBLE 집합이 이어지는 다음 회차는 재통지하지 않는다", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  try {
    const run = (nowMs) =>
      runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        notifyDir,
        now: nowMs,
        execFn: cleanUnconsumedExecFn,
        resourceResidue: {
          worktreeListFn: () => ({ ok: true, worktrees: [WT_ELIGIBLE] }),
          teardownShadow: baseTeardownShadow(),
        },
      });
    run(NOW_MS);
    const afterFirst = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-shadow-notify-"));
    assert.equal(afterFirst.length, 1);
    const noticeText = fs.readFileSync(join(notifyDir, afterFirst[0]), "utf8");
    assert.match(noticeText, /archive-candidate/);
    assert.match(noticeText, /ELIGIBLE/);
    assert.match(noticeText, /orca worktree rm/);
    assert.match(noticeText, /그림자/); // 파괴하지 않았다는 사실이 본문에 있다.

    // 같은 집합이 이어지는 다음 회차 -- 재통지 0(파일 개수 불변).
    run(NOW_MS + 60000);
    const afterSecond = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-shadow-notify-"));
    assert.equal(afterSecond.length, 1);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("opt-in: ELIGIBLE 집합이 사라졌다가(0건) 같은 집합으로 다시 나타나면 다시 통지한다(unconsumed-vanish 축과 동일 원칙 -- 무한 침묵 금지)", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  try {
    const runWithWorktrees = (nowMs, worktrees) =>
      runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        notifyDir,
        now: nowMs,
        execFn: cleanUnconsumedExecFn,
        resourceResidue: {
          worktreeListFn: () => ({ ok: true, worktrees }),
          teardownShadow: baseTeardownShadow(),
        },
      });
    runWithWorktrees(NOW_MS, [WT_ELIGIBLE]);
    runWithWorktrees(NOW_MS + 60000, []); // ELIGIBLE 집합이 비었다.
    runWithWorktrees(NOW_MS + 120000, [WT_ELIGIBLE]); // 다시 나타났다.
    const notices = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-shadow-notify-"));
    assert.equal(notices.length, 2, "사라졌다 재등장하면 재통지해야 한다");
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("armed=false 고정: 이 축이 구동하는 어떤 gitFn/lsRemoteFn 호출에도 파괴적 argv가 없다(전수 검사)", () => {
  const watchDir = tmpWatchDir();
  const calls = [];
  try {
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: cleanUnconsumedExecFn,
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: [WT_ELIGIBLE, WT_NOT_MERGED],
        }),
        teardownShadow: baseTeardownShadow({
          gitFn: (argv, worktreePath) => {
            calls.push(argv);
            if (worktreePath === WT_ELIGIBLE) return `${SHA_HEAD}\n`;
            return `${SHA_HEAD_OTHER}\n`;
          },
          lsRemoteFn: (argv) => {
            calls.push(argv);
            return `${SHA_REMOTE}\trefs/heads/master\n`;
          },
        }),
      },
    });
    assert.ok(calls.length > 0, "gitFn/lsRemoteFn이 실제로 불렸어야 한다");
    for (const argv of calls) {
      assert.equal(argv.includes("rm"), false);
      assert.equal(argv.includes("close"), false);
      assert.equal(argv.includes("push"), false);
      assert.equal(argv.includes("-D"), false);
      assert.equal(argv.includes("--force"), false);
      assert.equal(argv.includes("reset"), false);
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// 정적: 이 축 자체(judgeTeardownShadowForWorktree ~ runTeardownShadowStep)의
// 소스에 파괴적 argv 배열 리터럴이 없다(위 hyk464-followup-1-resource-
// residue.test.mjs의 동일한 정적 확인과 같은 방식 -- 보고 전용임을 소스
// 수준에서도 고정한다).
test("정적: watch-run.mjs의 teardown-shadow 섹션은 terminal close/worktree rm 같은 파괴적 argv 배열을 조립하지 않는다", () => {
  const src = fs.readFileSync(
    new URL("./watch-run.mjs", import.meta.url),
    "utf8",
  );
  const start = src.indexOf(
    "HYK-464-teardown-shadow-1 (coder-task.md §2 product_scope ③)",
  );
  assert.notEqual(start, -1, "teardown-shadow 섹션을 찾지 못했다(파일 개편?)");
  const end = src.indexOf("function resourceResidueLogSegment(result) {");
  assert.ok(end > start);
  const section = src.slice(start, end);
  assert.doesNotMatch(section, /"terminal",\s*\n?\s*"close"/);
  assert.doesNotMatch(section, /"worktree",\s*\n?\s*"rm"/);
  assert.doesNotMatch(section, /taskkill/i);
  assert.doesNotMatch(section, /Stop-Process/i);
});
