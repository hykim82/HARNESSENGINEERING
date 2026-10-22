// HYK-464-idle-stop-reason-1 (coder-task.md) -- 유휴 축 "정지 사유 안 A"
// (관제실 전역 파일) 결선 계약 시험.
//
// 다루는 것: seat-idle-core.mjs의 새 입력(stopReasonId, 판정 입력 1개
// 추가)이 orch-stall-detect.mjs에서 실제로 채워지는 경로(정지 사유
// 파일 읽기 -> 열린 사유 판별 -> 워크트리 매핑) + watch-run.mjs가 그
// 결과를 로그 줄·last-run.json까지 옮겨 적는 경로. seat-idle-core.mjs
// 자신의 판정 규칙(순수 함수) 시험은 seat-idle-core.test.mjs에 있다
// (이 파일의 범위 밖).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 여기 fixture는 전부 이 시험이 mkdtemp로 만든 합성 워크트리(진짜
//    `git worktree add`) + 주입한 fake execFn/stop-reasons 경로다 -- 실
//    관제실 `stop-reasons.json`·실 `orca` 프로세스를 이 시험이 접촉하지
//    않는다(product_scope 비타협 "정지 사유 파일 실물 생성 0").
// 2. ORCH가 실제로 그 파일을 언제 쓰고 지우는지는 이 시험의 범위 밖이다
//    (coder-task.md §3 요구6 "ORCH 쓰기 절차 초안"은 결과 파일에만 산문
//    으로 적는다, 코드 0).
// 3. 표본 수 -- 각 test 이름에 시나리오를 명시한다, 전칭 주장 금지.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  judgeSeatIdleAcrossWorktrees,
  SEAT_IDLE_WIRE_STATUS,
  SEAT_IDLE_SCAN_FAILURE,
  SEAT_IDLE_STOP_REASONS_STATUS,
  DEFAULT_STOP_REASONS_PATH,
} from "./orch-stall-detect.mjs";
import { SEAT_IDLE_VERDICT } from "./seat-idle-core.mjs";
import { buildLogLine, runWatchOnce } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function listWorktreePaths(dir) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  return [...out.matchAll(/^worktree\s+(.+)$/gm)].map((m) => m[1].trim());
}
function addLinkedWorktree(mainDir, tag) {
  const linkedDir = tmpDir(`hyk464-idle-stop-linked-${tag}-`);
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-idle-stop-${tag}-${process.pid}-${Date.now()}`;
  git(mainDir, ["worktree", "add", "-b", branch, linkedDir]);
  return linkedDir;
}
function initPlainGitRepo(dir) {
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
function fakeOrcaExecFn({ terminals = [], showsByHandle = {} } = {}) {
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { ok: true, result: { terminals } };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      const stub = showsByHandle[handle];
      if (!stub) throw new Error(`fakeOrcaExecFn: no show-stub for ${handle}`);
      return stub;
    }
    throw new Error(`fakeOrcaExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}
function writeStopReasonsFixture(dir, reasons) {
  const p = join(dir, "stop-reasons.json");
  writeFileSync(p, JSON.stringify({ reasons }), "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// ⓐ 기준선 재현(2291da4 판과 동일 동작) -- 워크트리 3개 중 1개가 "병합
// 대기로 남긴" 존치 워크트리인 모양. 정지 사유 파일이 없으면(이 시험의
// stopReasonsPath는 항상 존재하지 않는 경로) 지금 판정은 그대로
// SUSPECTED_ABANDONED, idle_worst_count=1 -- 아래 ⓒⓔ 새 칸들은 이 판에서
// RED다(stopReasonsStatus는 ABSENT, worstWorktreePaths는 그 1개뿐이지만
// "새 칸"으로 신설되기 전에는 undefined였다).
// ---------------------------------------------------------------------------
function buildThreeWorktreeFixture(mainDir, { now, abandonedLastOutputAt }) {
  const linked1 = addLinkedWorktree(mainDir, "b");
  const linked2 = addLinkedWorktree(mainDir, "c");
  const [mainPath, path1, path2] = listWorktreePaths(mainDir);
  // path1 = "방치형"(13.75h 유휴, 오늘 실측 표본과 동형) -- path2/mainPath
  // 는 정상 유휴(최근 좌석 응답).
  const execFn = fakeOrcaExecFn({
    terminals: [
      { handle: "term_main", worktreePath: mainPath },
      { handle: "term_b", worktreePath: path1 },
      { handle: "term_c", worktreePath: path2 },
    ],
    showsByHandle: {
      term_main: {
        ok: true,
        result: { terminal: { lastOutputAt: now - 60_000, title: "main" } },
      },
      term_b: {
        ok: true,
        result: {
          terminal: { lastOutputAt: abandonedLastOutputAt, title: "leftover" },
        },
      },
      term_c: {
        ok: true,
        result: { terminal: { lastOutputAt: now - 60_000, title: "fine" } },
      },
    },
  });
  return {
    linked1,
    linked2,
    mainPath,
    abandonedPath: path1,
    finePath: path2,
    execFn,
  };
}

test("ⓐ 기준선: 사유 파일 부재(DEFAULT_STOP_REASONS_PATH 흉내) -- 3개 중 1개 방치 -> JUDGED/SUSPECTED_ABANDONED, worstCount=1, stopReasonsStatus=ABSENT, worstWorktreePaths=[그 1개]", () => {
  withTempDir("hyk464-idle-stop-main-a-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, abandonedPath, execFn } =
      buildThreeWorktreeFixture(mainDir, { now, abandonedLastOutputAt });
    try {
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        {
          execFn,
          // 실 관제실 경로를 건드리지 않도록 존재하지 않는 경로로 못박는다
          // (product_scope 비타협 "정지 사유 파일 실물 생성 0").
          stopReasonsPath: join(mainDir, "no-such-stop-reasons.json"),
        },
      );
      assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worstCount, 1);
      assert.equal(r.totalWorktrees, 3);
      assert.equal(r.stopReasonsStatus, SEAT_IDLE_STOP_REASONS_STATUS.ABSENT);
      assert.deepEqual(r.worstWorktreePaths, [abandonedPath]);
      assert.equal(r.parkedCount, 0);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test("ⓑⓒ 열린 사유가 그 워크트리를 덮으면 SUSPECTED_ABANDONED -> PARKED_WITH_REASON로 갈리고, worst count에서 빠지되(idle_worst_count 0 or 정상 tier) parkedCount/parkedWorktreePaths/parkedReasonIds에 사유 id까지 보인다", () => {
  withTempDir("hyk464-idle-stop-main-b-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, abandonedPath, execFn } =
      buildThreeWorktreeFixture(mainDir, { now, abandonedLastOutputAt });
    try {
      const stopReasonsPath = writeStopReasonsFixture(mainDir, [
        {
          id: "HYK-464-merge-wait-1",
          openedAt: "2026-08-04T04:00:00+09:00",
          closedAt: null,
          worktrees: [abandonedPath],
          note: "PR #326 병합 대기",
        },
      ]);
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
      assert.notEqual(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.stopReasonsStatus, SEAT_IDLE_STOP_REASONS_STATUS.PRESENT);
      assert.equal(r.parkedCount, 1);
      assert.deepEqual(r.parkedWorktreePaths, [abandonedPath]);
      assert.deepEqual(r.parkedReasonIds, ["HYK-464-merge-wait-1"]);
      // 사유가 생기면 더 이상 SUSPECTED_ABANDONED가 최악이 아니므로(모든
      // 워크트리가 NORMAL 등급으로 묶인다) worst 세그먼트는 비워진다(§2ⓔ
      // "정상 회차엔 세그먼트 없음").
      assert.deepEqual(r.worstWorktreePaths, []);
      // 목록에서는 지우지 않는다(§2ⓒ) -- worktrees[] 전체에 여전히 3개가
      // 남아 있고 그중 하나는 PARKED_WITH_REASON 표시를 달고 있다.
      assert.equal(r.worktrees.length, 3);
      const parkedEntry = r.worktrees.find(
        (w) => w.worktreePath === abandonedPath,
      );
      assert.equal(parkedEntry.verdict, SEAT_IDLE_VERDICT.PARKED_WITH_REASON);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test("반대 방향(1/3) 사유 없음 -- 같은 워크트리가 덮이지 않으면(빈 reasons) 그대로 SUSPECTED_ABANDONED(회귀 0)", () => {
  withTempDir("hyk464-idle-stop-main-rev1-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, execFn } = buildThreeWorktreeFixture(mainDir, {
      now,
      abandonedLastOutputAt,
    });
    try {
      const stopReasonsPath = writeStopReasonsFixture(mainDir, []);
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worstCount, 1);
      assert.equal(r.parkedCount, 0);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test("반대 방향(2/3) 닫힌 사유 -- closedAt이 now보다 과거면 그 사유는 더 이상 열려 있지 않으므로 그대로 SUSPECTED_ABANDONED", () => {
  withTempDir("hyk464-idle-stop-main-rev2-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, abandonedPath, execFn } =
      buildThreeWorktreeFixture(mainDir, { now, abandonedLastOutputAt });
    try {
      const stopReasonsPath = writeStopReasonsFixture(mainDir, [
        {
          id: "HYK-464-already-closed-1",
          openedAt: "2026-08-04T04:00:00+09:00",
          closedAt: "2026-08-04T04:30:00+09:00", // now보다 한참 과거.
          worktrees: [abandonedPath],
        },
      ]);
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worstCount, 1);
      assert.equal(r.parkedCount, 0);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test("반대 방향(3/3) 다른 워크트리의 사유 -- 열려 있지만 방치된 워크트리가 아니라 다른(정상) 워크트리를 덮으면 방치된 쪽은 그대로 SUSPECTED_ABANDONED", () => {
  withTempDir("hyk464-idle-stop-main-rev3-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, finePath, execFn } = buildThreeWorktreeFixture(
      mainDir,
      { now, abandonedLastOutputAt },
    );
    try {
      const stopReasonsPath = writeStopReasonsFixture(mainDir, [
        {
          id: "HYK-464-wrong-worktree-1",
          openedAt: "2026-08-04T04:00:00+09:00",
          closedAt: null,
          worktrees: [finePath],
        },
      ]);
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worstCount, 1);
      assert.equal(r.parkedCount, 0);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test('"*" 와일드카드 -- worktrees가 "*"이면 어느 워크트리든 덮는다', () => {
  withTempDir("hyk464-idle-stop-main-wild-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, execFn } = buildThreeWorktreeFixture(mainDir, {
      now,
      abandonedLastOutputAt,
    });
    try {
      const stopReasonsPath = writeStopReasonsFixture(mainDir, [
        {
          id: "HYK-464-wildcard-1",
          openedAt: "2026-08-04T04:00:00+09:00",
          closedAt: null,
          worktrees: "*",
        },
      ]);
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.notEqual(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.parkedCount, 1);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ⓓ 못 읽으면(조용한 낙하 금지) -- 파일이 "있는데" 읽기/파싱/형식이
// 실패한 두 경우(칸 2) 모두 새 실패 코드로 드러나고, 그 회차는 어떤
// 워크트리도 "사유 있는 존치"로 빼지 않는다(경보 유지).
// ---------------------------------------------------------------------------
test("ⓓ(1/2) 파싱 실패 -- 깨진 JSON -> STOP_REASONS_READ_FAILED, 경보 유지(그대로 SUSPECTED_ABANDONED)", () => {
  withTempDir("hyk464-idle-stop-main-parsefail-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, execFn } = buildThreeWorktreeFixture(mainDir, {
      now,
      abandonedLastOutputAt,
    });
    try {
      const stopReasonsPath = join(mainDir, "stop-reasons.json");
      writeFileSync(stopReasonsPath, "{ not valid json", "utf8");
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.equal(
        r.stopReasonsStatus,
        SEAT_IDLE_SCAN_FAILURE.STOP_REASONS_READ_FAILED,
      );
      assert.ok(
        typeof r.stopReasonsDetail === "string" &&
          r.stopReasonsDetail.length > 0,
      );
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worstCount, 1);
      assert.equal(r.parkedCount, 0);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test("ⓓ(2/2) 형식 실패 -- {reasons:[...]} 모양이 아니거나 항목 형식이 깨짐 -> STOP_REASONS_READ_FAILED, 경보 유지", () => {
  withTempDir("hyk464-idle-stop-main-shapefail-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const now =
      Date.parse("2026-08-04T05:00:00+09:00") + 13.75 * 60 * 60 * 1000;
    const abandonedLastOutputAt = now - 13.75 * 60 * 60 * 1000;
    const { linked1, linked2, abandonedPath, execFn } =
      buildThreeWorktreeFixture(mainDir, { now, abandonedLastOutputAt });
    try {
      // openedAt이 파싱 불가능한 형식 위반 항목.
      const stopReasonsPath = writeStopReasonsFixture(mainDir, [
        { id: "x", openedAt: "not-a-date", worktrees: [abandonedPath] },
      ]);
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn, stopReasonsPath },
      );
      assert.equal(
        r.stopReasonsStatus,
        SEAT_IDLE_SCAN_FAILURE.STOP_REASONS_READ_FAILED,
      );
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.parkedCount, 0);
    } finally {
      rmSync(linked1, { recursive: true, force: true });
      rmSync(linked2, { recursive: true, force: true });
    }
  });
});

test("ⓑ 위치 상수 -- DEFAULT_STOP_REASONS_PATH는 CONTROL_ROOM_PATH 직속(watchDir의 부모)이고, opts 생략 시 이 상수를 쓴다(새 CLI 인자 0 -- opts.stopReasonsPath로만 오버라이드)", () => {
  assert.match(DEFAULT_STOP_REASONS_PATH, /\/stop-reasons\.json$/);
  assert.equal(
    DEFAULT_STOP_REASONS_PATH.endsWith("/watch/stop-reasons.json"),
    false,
  );
});

// ---------------------------------------------------------------------------
// watch-run.mjs 결선 -- 새 필드가 idle_* 접두의 상한+N_more 세그먼트로
// 로그 줄까지 옮겨진다(§2ⓒⓔ). buildLogLine은 orch-stall-detect.mjs의
// 원시 JSON이 아니라 이미 평탄화된 필드 이름(seatIdleWorstWorktrees 등)을
// 받는다(watch-run.test.mjs의 기존 buildLogLine 직접호출 관례 재사용).
// ---------------------------------------------------------------------------
test("watch-run buildLogLine: worst 워크트리가 있으면 idle_worst_worktrees/idle_worst_worktree_detail이 상한+N_more로 실린다", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatIdleStatus: "SEAT_IDLE_JUDGED",
      seatIdleVerdict: "SUSPECTED_ABANDONED",
      seatIdleWorstCount: 1,
      seatIdleTotalWorktrees: 3,
      seatIdleWorstWorktrees: ["C:/wt-main/pm-lane"],
    },
  });
  assert.match(
    line,
    /idle_worst_worktrees=1 idle_worst_worktree_detail=pm-lane/,
  );
  assert.equal(line.includes("\n"), false);
});

test("watch-run buildLogLine: worst가 비어 있으면(정상 회차) idle_worst_worktrees 세그먼트 자체가 없다(조용함 유지, §2-3 비타협)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatIdleStatus: "SEAT_IDLE_JUDGED",
      seatIdleVerdict: "IDLE_OK",
      seatIdleWorstCount: 3,
      seatIdleTotalWorktrees: 3,
      seatIdleWorstWorktrees: [],
    },
  });
  assert.equal(line.includes("idle_worst_worktrees="), false);
});

test("watch-run buildLogLine: 사유 있는 존치가 있으면 idle_parked=<N>와 '<워크트리>:<사유id>' 상세가 함께 실린다", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatIdleParkedCount: 1,
      seatIdleParkedWorktrees: ["C:/wt-main/pm-lane"],
      seatIdleParkedReasonIds: ["HYK-464-merge-wait-1"],
    },
  });
  assert.match(
    line,
    /idle_parked=1 idle_parked_detail=pm-lane:HYK-464-merge-wait-1/,
  );
});

test("watch-run buildLogLine: 정지 사유 파일 상태(idle_stop_reasons_status)가 ABSENT/PRESENT/실패 코드 그대로 실린다(조용한 낙하 금지)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatIdleStopReasonsStatus: "SEAT_IDLE_SCAN_STOP_REASONS_READ_FAILED",
      seatIdleStopReasonsDetail: "stop-reasons file: malformed reason entry",
    },
  });
  // sanitizeFailureToken이 공백을 밑줄로 접으므로(기존 reasonDetailSegment
  // 관례, watch-run.mjs 참조) 리터럴 공백이 아니라 밑줄로 실린다.
  assert.match(
    line,
    /idle_stop_reasons_status=SEAT_IDLE_SCAN_STOP_REASONS_READ_FAILED idle_stop_reasons_detail=stop-reasons_file:_malformed_reason_entry/,
  );
});

test("watch-run buildLogLine: 세 새 필드(idleWorstWorktrees/idleParked*/idleStopReasons*) 전부 미제공이면, 그 세 필드를 지원하기 전과 바이트 동일(회귀 0)", () => {
  const base = {
    runnerFailure: false,
    exitCode: 0,
    verdict: "PROGRESSING",
    reasonCode: "OK",
  };
  const withoutNewFields = buildLogLine({
    nowIso: "2026-08-03T18:00:00.000Z",
    detectorResult: base,
  });
  // 세 새 필드를 명시적으로 "없음"(null/undefined)으로 줘도 결과가
  // 같아야 한다 -- idleWorstSegment/idleParkedSegment는 null을, idle
  // StopReasonsSegment도 status가 비문자열이면 null을 돌려준다
  // (filter(Boolean)으로 로그 줄에서 완전히 빠진다).
  const withNullNewFields = buildLogLine({
    nowIso: "2026-08-03T18:00:00.000Z",
    detectorResult: {
      ...base,
      seatIdleWorstWorktrees: null,
      seatIdleParkedWorktrees: null,
      seatIdleParkedReasonIds: null,
      seatIdleStopReasonsStatus: null,
      seatIdleStopReasonsDetail: null,
    },
  });
  assert.equal(withNullNewFields, withoutNewFields);
  assert.equal(withoutNewFields.includes("idle_worst_worktrees="), false);
  assert.equal(withoutNewFields.includes("idle_parked="), false);
  assert.equal(withoutNewFields.includes("idle_stop_reasons_status="), false);
});

// ---------------------------------------------------------------------------
// end-to-end: 감지기 JSON stdout(원시 필드 이름, orch-stall-detect.mjs의
// 실제 출력 모양) -> runWatchOnce -> watch.log/last-run.json까지(watch-
// run.test.mjs의 기존 "HYK-185-seat-idle-1" 시험과 같은 층위).
// ---------------------------------------------------------------------------
test("end-to-end: 감지기 stdout의 seatIdle.{worstWorktreePaths,parkedCount,parkedWorktreePaths,parkedReasonIds,stopReasonsStatus}가 watch.log와 last-run.json 모두에 닿는다", () => {
  const watchDir = mkdtempSync(join(tmpdir(), "hyk464-idle-stop-e2e-"));
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: Date.parse("2026-08-03T18:00:00+09:00"),
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatIdle: {
            status: "SEAT_IDLE_JUDGED",
            verdict: "PARKED_WITH_REASON",
            worstCount: 0,
            totalWorktrees: 3,
            worstWorktreePaths: [],
            parkedCount: 1,
            parkedWorktreePaths: ["C:/wt-main/pm-lane"],
            parkedReasonIds: ["HYK-464-merge-wait-1"],
            stopReasonsStatus: "SEAT_IDLE_STOP_REASONS_PRESENT",
            stopReasonsDetail: null,
          },
        }),
    });
    const logText = readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /idle_parked=1 idle_parked_detail=pm-lane:HYK-464-merge-wait-1/,
    );
    assert.match(
      logText,
      /idle_stop_reasons_status=SEAT_IDLE_STOP_REASONS_PRESENT/,
    );
    // last-run.json의 record는 평탄화된 필드 이름을 쓴다(detectorResult를
    // 그대로 스프레드, finalizeWatchOnceCycle 참조) -- 중첩 seatIdle
    // 객체가 아니다.
    const record = JSON.parse(readFileSync(result.aliveRecordPath, "utf8"));
    assert.deepEqual(record.seatIdleParkedWorktrees, ["C:/wt-main/pm-lane"]);
    assert.equal(
      record.seatIdleStopReasonsStatus,
      "SEAT_IDLE_STOP_REASONS_PRESENT",
    );
  } finally {
    rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §4 상시 규율 -- 실 워크트리 접촉 0).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "hyk464-idle-stop-reason.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "hyk464-idle-stop-reason.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
