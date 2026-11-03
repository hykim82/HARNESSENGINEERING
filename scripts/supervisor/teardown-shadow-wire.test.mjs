// HYK-464-teardown-shadow-1/-2 (coder-task.md §2 product_scope ③, §2
// 1b_exec_line) -- 축C가 그림자로 구동하는 아카이브 판정(judgeArchiveEligibility)의
// watch-run.mjs 결선 시험. 프로덕션 진입점(runWatchOnce)을 fake execFn/
// git/fs로 직접 구동한다(헛시험 방지 -- 재구현/모킹 레이어를 시험 대상
// 자리에 두지 않는다, hyk464-followup-1-resource-residue.test.mjs와 동일
// 원칙).
//
// HYK-464-teardown-shadow-2(REVIEW 1R rejected 수리, 책임자 판정 1012):
// 바뀐 계약 -- 1R에는 없던 것들이 이제 있다:
//   - 모든 워크트리 목록의 인덱스 0은 "본체"로 취급된다(B1, A1과 함께).
//   - 미소비 축은 worst-list가 아니라 "이 워크트리 자신의 status/verdict"
//     (unconsumed.worktrees[])를 본다(P1-3).
//   - 은퇴 기록은 "그 라운드의 role+harnessTaskLabel"과 JSON 내용으로
//     대조해야 소비로 센다(P1-5/C1).
//   - 라운드 증거(.harness/receipts/*) 0건도 거부 사유다(B1).
//   - watch.log의 teardown_shadow_detail은 "사유별 건수 요약"이고(P2-2),
//     워크트리별 전체 상세는 이제 받는함(notifyDir) 통지 본문에만 있다.
// 이 스위트가 증명하는 것:
// 1. resourceResidue.teardownShadow를 opt-in으로 주지 않으면(resourceResidue
//    자체가 없거나, 있어도 teardownShadow가 없으면) 로그 줄에 teardown_shadow_
//    토큰이 전혀 없다(회귀 0).
// 2. opt-in으로 주면 실제 진입점을 통해 워크트리별 ELIGIBLE/거부가 판정되고
//    watch.log에 teardown_shadow_* 세그먼트(사유별 건수)로 남는다.
// 3. ELIGIBLE이 1건 이상이면 받는함(notifyDir)에 통지 파일이 생기고, 같은
//    ELIGIBLE 집합이 이어지는 다음 회차는 재통지하지 않는다(파일 개수 불변).
// 4. armed=false 고정 -- 이 축은 어떤 실행에서도 파괴적 argv를 만들지
//    않는다(gitFn/lsRemoteFn에 전달된 argv 전수 검사 + 정적 소스 확인).
// 5. B1 -- 본체(인덱스 0)는 나머지가 전부 깨끗해도 거부되고, 라운드 증거
//    (소비 영수증) 0건인 워크트리도 거부된다.
// 6. P1-3 -- 억제/수집 실패로 worst-list에서 빠진 워크트리도 "소비됨"으로
//    새지 않는다(워크트리 자신의 status를 본다).
// 7. P1-5/C1 -- 은퇴 기록은 role+harnessTaskLabel이 정확히 일치해야
//    소비로 센다(다른 라운드/깨진 JSON은 소비 아님).
// 8. P1-1 -- CLI 인자 파싱(buildResourceResidueFromArgv)이 축 C 인자만으로
//    teardownShadow 기본값을 싣고, 그 결과를 실제 진입점에 먹이면
//    watch.log에 teardown_shadow_ 칸이 생긴다(1R 결선 시험 2의 반대 재현).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runWatchOnce,
  buildResourceResidueFromArgv,
  createMemoizedDefaultLsRemoteFn,
} from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-11-02T21:50:00+09:00");

// HYK-464-teardown-shadow-2 B1: 모든 워크트리 목록의 인덱스 0은 "본체"로
// 취급된다(runTeardownShadowStep). 아래 모든 다중-워크트리 시험은 본체
// 자리를 채우는 더미(WT_MAIN)를 인덱스 0에 두어, 실제 관심 대상
// (WT_ELIGIBLE 등)이 본체 취급으로 섞여 거부되지 않게 한다.
const WT_MAIN = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
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

// HYK-464-teardown-shadow-2 P1-3 수리: 이제 이 축은 unconsumed.worktrees[]
// (워크트리 자신의 status/verdict)를 본다 -- worst-list(worstWorktreePaths)
// 만으로는 억제·수집 실패가 "0건"으로 샌다(검토 1R 실측). `rows`는
// {worktreePath, kind: "NA"|"CONSUMED"|"SUSPECTED"|"COLLECTION_FAILED", role?}
// 의 배열이다.
function unconsumedExecFn(rows) {
  const entries = rows.map(({ worktreePath, kind, role = "coder" }) => {
    if (kind === "NA") {
      return { worktreePath, status: "UNCONSUMED_NOT_APPLICABLE" };
    }
    if (kind === "COLLECTION_FAILED") {
      return { worktreePath, status: "UNCONSUMED_COLLECTION_FAILED" };
    }
    return {
      worktreePath,
      status: "UNCONSUMED_JUDGED",
      verdict: kind === "CONSUMED" ? "CONSUMED" : "SUSPECTED_UNCONSUMED",
      resultFile: { path: `.harness/${role}.md` },
    };
  });
  return () =>
    JSON.stringify({
      verdict: "PROGRESSING",
      reasonCode: "OK",
      unconsumed: {
        status: "JUDGED",
        totalWorktrees: entries.length,
        worktrees: entries,
      },
    });
}

// 라운드 증거(roundEvidence)가 1건 이상이도록 `.harness/receipts/`
// 아래 파일 하나를 항상 포함한다(B1 -- 1R에는 없던 축이라 디폴트가
// 이걸 안 주면 기존 "ELIGIBLE" 기대가 전부 NO_ROUND_EVIDENCE로 깨진다).
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
      throw new Error(
        "should not be called -- keep-reason.md absent, unconsumed is NA/CONSUMED in this fixture",
      );
    },
    listHarnessFilesFn: () => [
      ".harness/coder.md",
      ".harness/receipts/CODER-receipt-r1.json",
    ],
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

test("opt-in: 병합 완료 + keep-reason 없음 + 미소비 0 + 라운드 증거 있음인 워크트리는 ELIGIBLE, 미병합 워크트리(본체 포함 -- 본체도 이 fixture에선 merge 축에서 먼저 막힌다)는 거부 -- 전부 watch.log 건수 요약(P2-2)에 표면화된다", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      notifyDir,
      now: NOW_MS,
      execFn: unconsumedExecFn([
        { worktreePath: WT_MAIN, kind: "NA" },
        { worktreePath: WT_ELIGIBLE, kind: "CONSUMED" },
        { worktreePath: WT_NOT_MERGED, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: [WT_MAIN, WT_ELIGIBLE, WT_NOT_MERGED],
        }),
        teardownShadow: baseTeardownShadow(),
      },
    });
    assert.match(result.line, /teardown_shadow_status=OK/);
    assert.match(result.line, /teardown_shadow_total=3/);
    assert.match(result.line, /teardown_shadow_eligible=1/);
    // P2-2: 상세는 이제 "사유별 건수"다(워크트리 이름이 아니다). 이
    // fixture는 WT_MAIN도 gitFn이 WT_ELIGIBLE만 조상으로 쳐주므로
    // mergeStatus 축에서 먼저 막힌다(그래서 2건이 같은 사유를 공유한다
    // -- 본체 전용 사유 TEARDOWN_MAIN_CHECKOUT은 아래 B1 전용 시험이
    // 별도로 증명한다, mergeStatus가 먼저 막으면 mainCheckout 검사까지
    // 도달하지 않는 것이 체인 순서의 정상 동작이다).
    assert.match(result.line, /teardown_shadow_detail=/);
    assert.match(result.line, /ELIGIBLE:1/);
    assert.match(result.line, /TEARDOWN_NOT_MERGED_TO_MASTER:2/);

    // P2-2: 워크트리별 전체 상세(이름 + 사유)는 받는함 통지 본문에 있다
    // (60자 절단으로 행이 사라지지 않는다).
    const notices = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-shadow-notify-"));
    assert.equal(notices.length, 1);
    const noticeText = fs.readFileSync(join(notifyDir, notices[0]), "utf8");
    assert.match(
      noticeText,
      new RegExp(`## ${WT_ELIGIBLE}`.replace(/\//g, "\\/")),
    );
    assert.match(noticeText, /그 밖의 판정/);
    assert.match(
      noticeText,
      new RegExp(
        `${WT_MAIN}: TEARDOWN_NOT_MERGED_TO_MASTER`.replace(/\//g, "\\/"),
      ),
    );
    assert.match(
      noticeText,
      new RegExp(
        `${WT_NOT_MERGED}: TEARDOWN_NOT_MERGED_TO_MASTER`.replace(/\//g, "\\/"),
      ),
    );
    // P2-4: SHA 선기록 + 복원 줄이 둘 다 있다(검토 1R P2-4: 복원 줄 없었음).
    assert.match(noticeText, /rev-parse HEAD/);
    assert.match(noticeText, /orca worktree rm/);
    assert.match(noticeText, /git branch <branch-name>/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("HYK-464-teardown-shadow-2 B1: 본체(인덱스 0)는 나머지 전제가 전부 깨끗해도 거부된다 -- isAncestorFn/existsFn을 본체에도 '통과'로 맞춰도 TEARDOWN_MAIN_CHECKOUT이 이긴다", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: unconsumedExecFn([{ worktreePath: WT_MAIN, kind: "NA" }]),
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [WT_MAIN] }),
        teardownShadow: baseTeardownShadow({
          gitFn: () => `${SHA_HEAD}\n`, // 본체도 조상 통과하게 맞춘다.
          isAncestorFn: () => true,
        }),
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=0/);
    assert.match(result.line, /TEARDOWN_MAIN_CHECKOUT:1/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-464-teardown-shadow-2 B1: 라운드 증거(소비 영수증) 0건인 워크트리는 거부된다(막 만든 워크트리를 ELIGIBLE로 지어내지 않는다)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: unconsumedExecFn([
        { worktreePath: WT_MAIN, kind: "NA" },
        { worktreePath: WT_ELIGIBLE, kind: "NA" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [WT_MAIN, WT_ELIGIBLE] }),
        teardownShadow: baseTeardownShadow({
          listHarnessFilesFn: () => [".harness/coder.md"], // 영수증 0건.
        }),
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=0/);
    assert.match(result.line, /TEARDOWN_NO_ROUND_EVIDENCE:1/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-464-teardown-shadow-2 P1-3: 억제·수집 실패로 발화 대표값(worst-list) 밖으로 빠진 워크트리도 '소비됨'으로 새지 않는다(워크트리 자신의 status를 본다)", () => {
  const watchDir = tmpWatchDir();
  try {
    // COLLECTION_FAILED -- 이 워크트리 자신의 미소비 판정이 실패했다
    // (억제·등급 가림과 같은 성질: HYK-185가 대표값 목록에 올리지 않아도
    // "판정 불가"로 접어야 한다, ELIGIBLE로 새면 안 된다).
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: unconsumedExecFn([
        { worktreePath: WT_MAIN, kind: "NA" },
        { worktreePath: WT_ELIGIBLE, kind: "COLLECTION_FAILED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [WT_MAIN, WT_ELIGIBLE] }),
        teardownShadow: baseTeardownShadow(),
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=0/);
    assert.match(result.line, /TEARDOWN_UNCONSUMED_ROUNDS_UNKNOWN:1/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("HYK-464-teardown-shadow-2 P1-5/C1: 은퇴 기록은 role+harnessTaskLabel이 정확히 일치해야 '소비됨'으로 센다", () => {
  const watchDir = tmpWatchDir();
  const label = "HYK-464-teardown-shadow-2-coder-1";
  const resultFileText = `role: CODER\ntask_id: ${label}\n`;
  const matchingRetirement = JSON.stringify({
    role: "CODER",
    harnessTaskLabel: label,
    successorLabel: "HYK-464-teardown-shadow-2-coder-2",
  });
  const mismatchedRetirement = JSON.stringify({
    role: "REVIEW", // 다른 역할 -- 이 라운드의 은퇴가 아니다.
    harnessTaskLabel: label,
  });

  const run = ({ retirementFiles, retirementContents }) =>
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: unconsumedExecFn([
        { worktreePath: WT_MAIN, kind: "NA" },
        { worktreePath: WT_ELIGIBLE, kind: "SUSPECTED", role: "coder" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({ ok: true, worktrees: [WT_MAIN, WT_ELIGIBLE] }),
        teardownShadow: baseTeardownShadow({
          readFileFn: (fullPath) => {
            if (fullPath.endsWith(".harness/coder.md")) return resultFileText;
            if (fullPath.includes("retirements")) {
              const name = fullPath.split(/[\\/]/).pop();
              return retirementContents[name];
            }
            throw new Error(`unexpected readFileFn path: ${fullPath}`);
          },
          retirementReaddirFn: () => retirementFiles,
        }),
      },
    });

  try {
    // ⑴ 일치하는 은퇴 기록 1건 -- 소비됨 -> ELIGIBLE.
    const matched = run({
      retirementFiles: ["coder-retire-r1.json"],
      retirementContents: { "coder-retire-r1.json": matchingRetirement },
    });
    assert.match(matched.line, /teardown_shadow_eligible=1/);

    // ⑵ 다른 역할의 은퇴 기록만 있음(라벨은 같아도 역할이 다름) -- 소비
    //    아님 -> 거부(검토 1R P1-5의 반대 재현: 다른 라운드 은퇴가
    //    가리지 않는다).
    const mismatched = run({
      retirementFiles: ["review-retire-r1.json"],
      retirementContents: { "review-retire-r1.json": mismatchedRetirement },
    });
    assert.match(mismatched.line, /teardown_shadow_eligible=0/);
    assert.match(mismatched.line, /TEARDOWN_UNCONSUMED_ROUNDS_PRESENT:1/);

    // ⑶ 깨진 JSON만 있음 -- 역시 소비 증거로 쓰지 않는다(판정 불가로
    //    과소비하지 않되, ELIGIBLE로도 새지 않는다).
    const broken = run({
      retirementFiles: ["coder-retire-r1.json"],
      retirementContents: { "coder-retire-r1.json": "{not json" },
    });
    assert.match(broken.line, /teardown_shadow_eligible=0/);
    assert.match(broken.line, /TEARDOWN_UNCONSUMED_ROUNDS_PRESENT:1/);
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
        execFn: unconsumedExecFn([
          { worktreePath: WT_MAIN, kind: "NA" },
          { worktreePath: WT_ELIGIBLE, kind: "CONSUMED" },
        ]),
        resourceResidue: {
          worktreeListFn: () => ({
            ok: true,
            worktrees: [WT_MAIN, WT_ELIGIBLE],
          }),
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
        execFn: unconsumedExecFn(
          worktrees.map((worktreePath) => ({ worktreePath, kind: "CONSUMED" })),
        ),
        resourceResidue: {
          worktreeListFn: () => ({ ok: true, worktrees }),
          teardownShadow: baseTeardownShadow(),
        },
      });
    runWithWorktrees(NOW_MS, [WT_MAIN, WT_ELIGIBLE]);
    runWithWorktrees(NOW_MS + 60000, [WT_MAIN]); // ELIGIBLE 집합이 비었다.
    runWithWorktrees(NOW_MS + 120000, [WT_MAIN, WT_ELIGIBLE]); // 다시 나타났다.
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
      execFn: unconsumedExecFn([
        { worktreePath: WT_MAIN, kind: "NA" },
        { worktreePath: WT_ELIGIBLE, kind: "CONSUMED" },
        { worktreePath: WT_NOT_MERGED, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: [WT_MAIN, WT_ELIGIBLE, WT_NOT_MERGED],
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

// HYK-464-teardown-shadow-2 P2-3: 기본 lsRemoteFn만 회차당 1회로
// 메모이즈한다 -- 실 git/네트워크 호출 없이 메모이즈 로직 자체를
// 증명한다(createMemoizedDefaultLsRemoteFn을 직접 구동, underlyingFn을
// 주입해 호출 횟수를 센다).
test("HYK-464-teardown-shadow-2 P2-3: createMemoizedDefaultLsRemoteFn -- 같은 인스턴스를 여러 워크트리에 재사용해도 내부(실) 호출은 1회뿐이다", () => {
  let calls = 0;
  const fn = createMemoizedDefaultLsRemoteFn(() => {
    calls++;
    return `${SHA_REMOTE}\trefs/heads/master\n`;
  });
  const a = fn(["ls-remote"], "/wt/a");
  const b = fn(["ls-remote"], "/wt/b");
  const c = fn(["ls-remote"], "/wt/c");
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("HYK-464-teardown-shadow-2 P2-3: createMemoizedDefaultLsRemoteFn -- 실패도 메모한다(재시도로 다시 터지지 않는다)", () => {
  let calls = 0;
  const fn = createMemoizedDefaultLsRemoteFn(() => {
    calls++;
    throw new Error("network down");
  });
  assert.throws(() => fn(["ls-remote"], "/wt/a"));
  assert.throws(() => fn(["ls-remote"], "/wt/b"));
  assert.equal(calls, 1);
});

// HYK-464-teardown-shadow-2 P1-1 (책임자 판정 1012 A1): CLI 인자 파싱이
// 실제로 teardownShadow를 싣는지를 그 파싱 함수 자체로 직접 구동한다
// (1R 검토 P1-1: 결선 시험이 teardownShadow를 손으로 넣어서 CLI가 그
// 값을 실제로는 한 번도 싣지 않는 결함을 못 잡았다).
test("HYK-464-teardown-shadow-2 P1-1: buildResourceResidueFromArgv -- 축 C 인자(--resource-residue-registry-path)가 있으면 teardownShadow 기본값(빈 객체)을 싣는다, 새 CLI 플래그 0", () => {
  const r = buildResourceResidueFromArgv([
    "--repo-root",
    "/x",
    "--resource-residue-registry-path",
    "/tmp/registry.json",
  ]);
  assert.deepEqual(r, {
    registryPath: "/tmp/registry.json",
    teardownShadow: {},
  });
});

test("HYK-464-teardown-shadow-2 P1-1: buildResourceResidueFromArgv -- 축 C 인자가 없으면 resourceResidue 자체가 null(그림자도 0, 옵트인 유지)", () => {
  assert.equal(buildResourceResidueFromArgv(["--repo-root", "/x"]), null);
  assert.equal(buildResourceResidueFromArgv([]), null);
});

test("HYK-464-teardown-shadow-2 P1-1: CLI 인자 파싱 경로로 조립된 resourceResidue를 실제 runWatchOnce에 먹이면 watch.log에 teardown_shadow_ 칸이 생긴다(실 git, tmp 저장소 -- orca 실호출만 페이크)", () => {
  const tmpRepo = fs.mkdtempSync(
    join(tmpdir(), "nc-teardown-shadow-cli-repo-"),
  );
  const watchDir = tmpWatchDir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmpRepo });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "init",
      ],
      { cwd: tmpRepo },
    );

    const resourceResidue = {
      ...buildResourceResidueFromArgv([
        "--resource-residue-registry-path",
        join(tmpRepo, "fake-registry.json"),
      ]),
      // idle-seat-residue 축(이 라운드와 무관)이 실 orca를 부르지 않게
      // 페이크만 준다 -- teardownShadow 자체는 CLI 파싱이 낸 빈 객체
      // 그대로다(기본 git/fs 함수가 실제로 돈다).
      orcaExecFn: () => ({ ok: true, result: { terminals: [] } }),
    };
    assert.ok(
      resourceResidue.teardownShadow,
      "CLI 인자 파싱이 teardownShadow를 싣지 않았다(P1-1 재발 -- 1R의 결함과 동일)",
    );

    const result = runWatchOnce({
      repoRoot: tmpRepo,
      watchDir,
      now: NOW_MS,
      execFn: progressingExecFn,
      resourceResidue,
    });
    assert.match(result.line, /teardown_shadow_status=OK/);
    assert.match(result.line, /teardown_shadow_total=1/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
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
