// HYK-185-seat-idle-1 (coder-task.md) -- «유휴 방치 좌석» 판정 "결선"
// 계약 시험.
//
// seat-idle-core.test.mjs는 판정 코어만 시험했다 -- 이 파일은 예약
// 감시가 실제로 부르는 경로(watch-run.mjs -> orch-stall-detect.mjs)에서
// 그 코어가 실제로 호출되는지, 활성 배달이 있는 좌석은 이 축의 대상이
// 아닌지(§3-b), 관측 수집 실패가 "정상"으로 새지 않는지(§3-c), 오늘의
// 두 실제 방치 표본이 결선된 경로에서도 올바르게 갈리는지를 고정한다
// (coder-task.md §3 합격 기준 (a)(b)(c)(d)(f) 그대로).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 여기 fixture는 전부 이 시험이 `mkdtemp`로 만든 합성 표적 + 주입한
//    fake execFn이다 -- 실 `orca` 프로세스·실 `.harness/`·실 원격을
//    이 시험이 접촉하지 않는다.
// 2. mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를 읽는다
//    (seat-liveness-wire.test.mjs와 동일 이유 -- 이번 사이클에서 새로
//    추가한 결선 줄 자체가 아직 HEAD에 없다).
// 3. ★변이체는 저장소 밖 `mkdtemp`에 쓰고 상대 import는 절대 `file://`로
//    치환한다(seat-liveness-wire.test.mjs 선례 그대로 -- 저장소 안에
//    쓰면 다른 시험의 "워크트리 청결" 가드가 잔재를 본다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  judgeSeatIdleForRepo,
  judgeSeatIdleAcrossWorktrees,
  runOrchStallDetect,
  SEAT_IDLE_WIRE_STATUS,
  SEAT_IDLE_SCAN_FAILURE,
} from "./orch-stall-detect.mjs";
import { SEAT_IDLE_VERDICT, SEAT_IDLE_REASON } from "./seat-idle-core.mjs";
import { SEAT_LIVENESS_OBSERVATION_REASON } from "../relay/adapters/orca-adapter.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

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
function gitWorktreeSelfPath(dir) {
  return listWorktreePaths(dir)[0];
}
function addLinkedWorktree(mainDir) {
  const linkedDir = tmpDir("hyk185-idle-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-idle-${process.pid}-${Date.now()}`;
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
function writeTaskFile(dir, { taskId, droppedAt }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, ".harness", "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n\n본문\n`,
    "utf8",
  );
}
function writeCompletedTaskFile(dir, { taskId, droppedAt }) {
  // 결과 파일이 이미 있는 "완료된" 배달 -- selectActiveDispatch가 이걸
  // 활성으로 고르지 않는다(gap#77의 계약 그대로 재사용).
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, ".harness", "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\n\n본문\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, ".harness", "coder.md"),
    `task_id: ${taskId}\n\n완료\n`,
    "utf8",
  );
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
function throwingExecFn() {
  return () => {
    throw new Error("boom: orca unreachable");
  };
}

// ---------------------------------------------------------------------------
// judgeSeatIdleForRepo -- 4상태(NOT_APPLICABLE/NO_SEAT/JUDGED/
// COLLECTION_FAILED)와, (b) 활성 배달이 있으면 이 축의 대상이 아님(§3-b).
// ---------------------------------------------------------------------------
const ACTIVE = [
  {
    path: ".harness/coder-task.md",
    droppedAtMs: Date.parse("2026-08-04T11:23:00+09:00"),
    resultFile: { exists: false },
  },
];
const COMPLETED = [
  {
    path: ".harness/coder-task.md",
    droppedAtMs: Date.parse("2026-08-04T09:00:00+09:00"),
    resultFile: { exists: true },
  },
];

test("(b) judgeSeatIdleForRepo: active dispatch present -> NOT_APPLICABLE, zero execFn calls (이 축의 대상이 아니다, seat-liveness 축의 몫)", () => {
  const execFn = () => {
    throw new Error(
      "must not be called -- an active dispatch belongs to the liveness axis",
    );
  };
  const r = judgeSeatIdleForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: ACTIVE, now: 1_000_000_000_000 },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE);
});

test("(b) judgeSeatIdleForRepo: no active dispatch (empty task files) -> proceeds to judge, execFn is called", () => {
  const execFn = fakeOrcaExecFn({ terminals: [] });
  const r = judgeSeatIdleForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: [], now: 1_000_000_000_000 },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.NO_SEAT);
});

test("(b) judgeSeatIdleForRepo: only a completed dispatch (result file already exists) -> not active, proceeds to judge", () => {
  const execFn = fakeOrcaExecFn({ terminals: [] });
  const r = judgeSeatIdleForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: COMPLETED, now: 1_000_000_000_000 },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.NO_SEAT);
});

test("judgeSeatIdleForRepo: no active dispatch but zero seats found -> NO_SEAT (normal, not a failure)", () => {
  const execFn = fakeOrcaExecFn({ terminals: [] });
  const r = judgeSeatIdleForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [],
      now: Date.parse("2026-08-04T12:00:00+09:00"),
    },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.NO_SEAT);
});

test("(c) judgeSeatIdleForRepo: terminal-list query throws -> COLLECTION_FAILED, distinct from NO_SEAT (수집 실패가 «정상 방치 없음»으로 새지 않는다)", () => {
  const r = judgeSeatIdleForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [],
      now: Date.parse("2026-08-04T12:00:00+09:00"),
    },
    { execFn: throwingExecFn() },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
  );
  assert.notEqual(r.status, SEAT_IDLE_WIRE_STATUS.NO_SEAT);
});

// ---------------------------------------------------------------------------
// (a)(d)★ 오늘의 두 실제 방치 표본을 결선된 경로에 넣는다.
// ---------------------------------------------------------------------------
test("(a)(d) real abandoned sample: pm-lane seat idle 5.33h, through the wired path -> JUDGED/SUSPECTED_ABANDONED", () => {
  const lastOutputAt = Date.parse("2026-08-04T09:00:00+09:00");
  const now = lastOutputAt + 5.33 * 60 * 60 * 1000;
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_idle", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_idle: {
        ok: true,
        result: { terminal: { lastOutputAt, title: "pm-lane" } },
      },
    },
  });
  const r = judgeSeatIdleForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: [], now },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
  assert.equal(r.reasonCode, SEAT_IDLE_REASON.NO_OUTPUT_PAST_THRESHOLD);
});

test("(a)(d) real abandoned sample: main worktree seat idle 13.75h, through the wired path -> JUDGED/SUSPECTED_ABANDONED", () => {
  const lastOutputAt = Date.parse("2026-08-04T09:00:00+09:00");
  const now = lastOutputAt + 13.75 * 60 * 60 * 1000;
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_main", worktreePath: "C:/wt-main" }],
    showsByHandle: {
      term_main: {
        ok: true,
        result: { terminal: { lastOutputAt, title: "main" } },
      },
    },
  });
  const r = judgeSeatIdleForRepo(
    { repoRoot: "C:/wt-main", droppedTaskFiles: [], now },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
});

test("(a) real normal between-round idle 6 minutes (CODER->REVIEW handoff), through the wired path -> JUDGED/IDLE_OK (오탐 0)", () => {
  const lastOutputAt = Date.parse("2026-08-04T18:56:00+09:00");
  const now = Date.parse("2026-08-04T19:02:00+09:00");
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_normal", worktreePath: "C:/wt-normal" }],
    showsByHandle: {
      term_normal: {
        ok: true,
        result: { terminal: { lastOutputAt, title: "REVIEW" } },
      },
    },
  });
  const r = judgeSeatIdleForRepo(
    { repoRoot: "C:/wt-normal", droppedTaskFiles: [], now },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
  assert.notEqual(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
});

// ---------------------------------------------------------------------------
// (b) 배달 유무 구별을 결선된 e2e 경로에서 고정 -- 같은 좌석이 활성
// 배달일 때는 seatLiveness만 판정하고(JUDGED), 배달이 없을 때는 seatIdle
// 만 판정한다(JUDGED) -- 두 축이 같은 좌석을 두 번 세지 않는다.
// ---------------------------------------------------------------------------
test("(b)★ runOrchStallDetect e2e: active dispatch -> seatLiveness is JUDGED and seatIdle is NOT_APPLICABLE (같은 좌석을 두 번 세지 않는다)", () => {
  withTempDir("hyk185-idle-e2e-active-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-idle-1",
      droppedAt: "2026-08-04 11:23",
    });
    const now = Date.parse("2026-08-04T11:30:00+09:00");
    const execFn = fakeOrcaExecFn({
      terminals: [
        { handle: "term_e2e", worktreePath: gitWorktreeSelfPath(dir) },
      ],
      showsByHandle: {
        term_e2e: {
          ok: true,
          result: { terminal: { lastOutputAt: now - 60_000, title: "CODER" } },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn },
    );
    assert.equal(result.seatLiveness.status, "SEAT_LIVENESS_JUDGED");
    assert.equal(result.seatIdle.status, SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE);
  });
});

test("(b)★ runOrchStallDetect e2e: no active dispatch (no task file) -> seatLiveness is NOT_APPLICABLE and seatIdle is JUDGED", () => {
  withTempDir("hyk185-idle-e2e-noactive-", (dir) => {
    initPlainGitRepo(dir);
    const now = Date.parse("2026-08-04T20:00:00+09:00");
    const execFn = fakeOrcaExecFn({
      terminals: [
        { handle: "term_e2e2", worktreePath: gitWorktreeSelfPath(dir) },
      ],
      showsByHandle: {
        term_e2e2: {
          ok: true,
          result: { terminal: { lastOutputAt: now - 60_000, title: "ORCH" } },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn },
    );
    assert.equal(result.seatLiveness.status, "SEAT_LIVENESS_NOT_APPLICABLE");
    assert.equal(result.seatIdle.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
    assert.equal(result.seatIdle.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
  });
});

test("(b)★ runOrchStallDetect e2e: dispatch already completed (result file exists) -> not active -> seatIdle judges a 13.75h-idle seat as SUSPECTED_ABANDONED (오늘 메인 워크트리 사고와 동형)", () => {
  withTempDir("hyk185-idle-e2e-completed-", (dir) => {
    initPlainGitRepo(dir);
    const droppedAt = Date.parse("2026-08-04T05:00:00+09:00");
    writeCompletedTaskFile(dir, {
      taskId: "HYK-185-idle-completed",
      droppedAt: "2026-08-04 05:00",
    });
    const lastOutputAt = droppedAt;
    const now = lastOutputAt + 13.75 * 60 * 60 * 1000;
    const execFn = fakeOrcaExecFn({
      terminals: [
        { handle: "term_abandoned", worktreePath: gitWorktreeSelfPath(dir) },
      ],
      showsByHandle: {
        term_abandoned: {
          ok: true,
          result: { terminal: { lastOutputAt, title: "leftover" } },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn },
    );
    assert.equal(result.seatLiveness.status, "SEAT_LIVENESS_NOT_APPLICABLE");
    assert.equal(result.seatIdle.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
    assert.equal(
      result.seatIdle.verdict,
      SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED,
    );
  });
});

// ---------------------------------------------------------------------------
// (c) 워크트리 열거/개별 .harness 읽기 실패 -> 판정 불가(NOT_APPLICABLE로
// 접히지 않는다).
// ---------------------------------------------------------------------------
test("(c) judgeSeatIdleAcrossWorktrees: git worktree list 자체가 실패 -> WORKTREE_LIST_FAILED(판정 불가), NOT_APPLICABLE로 접히지 않는다", () => {
  const r = judgeSeatIdleAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git not found");
      },
    },
  );
  assert.equal(r.status, SEAT_IDLE_SCAN_FAILURE.WORKTREE_LIST_FAILED);
  assert.notEqual(r.status, SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE);
});

test("(c) judgeSeatIdleAcrossWorktrees: 개별 워크트리 .harness 읽기 실패 -> HARNESS_READ_FAILED(판정 불가), 좌석 조회조차 시도하지 않는다", () => {
  const r = judgeSeatIdleAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => "worktree C:/wt\n",
      harnessReaddirFn: () => {
        const err = new Error("permission denied");
        err.code = "EACCES";
        throw err;
      },
      execFn: () => {
        throw new Error("must not be called -- .harness read already failed");
      },
    },
  );
  assert.equal(r.status, SEAT_IDLE_SCAN_FAILURE.HARNESS_READ_FAILED);
  assert.notEqual(r.status, SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE);
});

// ---------------------------------------------------------------------------
// 다중 워크트리 스캔(gap#78 열거 재사용) -- 링크드 워크트리의 방치도 잡는다.
// ---------------------------------------------------------------------------
test("judgeSeatIdleAcrossWorktrees: 메인이 아니라 «링크드 워크트리»의 방치가 잡힌다", () => {
  withTempDir("hyk185-idle-scan-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const [, linkedPath] = listWorktreePaths(mainDir);
      const lastOutputAt = Date.parse("2026-08-04T05:00:00+09:00");
      const now = lastOutputAt + 13.75 * 60 * 60 * 1000;
      const execFn = fakeOrcaExecFn({
        terminals: [{ handle: "term_stuck", worktreePath: linkedPath }],
        showsByHandle: {
          term_stuck: {
            ok: true,
            result: { terminal: { lastOutputAt, title: "leftover" } },
          },
        },
      });
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn },
      );
      assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worktreePath, linkedPath);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("§ 여러 건 동시 방치: 두 워크트리가 동시에 SUSPECTED_ABANDONED -> worstCount=2, totalWorktrees=2 (건수가 사라지지 않는다)", () => {
  withTempDir("hyk185-idle-scan-multi-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      const [mainPath, linkedPath] = listWorktreePaths(mainDir);
      const lastOutputAt = Date.parse("2026-08-04T05:00:00+09:00");
      const now = lastOutputAt + 13.75 * 60 * 60 * 1000;
      const execFn = fakeOrcaExecFn({
        terminals: [
          { handle: "term_a", worktreePath: mainPath },
          { handle: "term_b", worktreePath: linkedPath },
        ],
        showsByHandle: {
          term_a: {
            ok: true,
            result: { terminal: { lastOutputAt, title: "main" } },
          },
          term_b: {
            ok: true,
            result: { terminal: { lastOutputAt, title: "linked" } },
          },
        },
      });
      const r = judgeSeatIdleAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn },
      );
      assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
      assert.equal(r.worstCount, 2);
      assert.equal(r.totalWorktrees, 2);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// production 기본값: opts를 안 주면 createOrcaExecFn()(실 spawn)이 기본값.
// ---------------------------------------------------------------------------
test("static: judgeSeatIdleForRepo defaults opts.execFn to createOrcaExecFn() when the caller doesn't override it (production wiring is live, not opt-in)", () => {
  const src = readFileSync(join(THIS_DIR, "orch-stall-detect.mjs"), "utf8");
  const idleSection = src.slice(
    src.indexOf("export function judgeSeatIdleForRepo"),
  );
  assert.match(
    idleSection.slice(
      0,
      idleSection.indexOf("export const SEAT_IDLE_SCAN_FAILURE"),
    ),
    /typeof opts\.execFn === "function" \? opts\.execFn : createOrcaExecFn\(\)/,
  );
});

// ---------------------------------------------------------------------------
// (f) 필수 mutation 4종.
// ---------------------------------------------------------------------------
const LIVE_SRC_PATH = join(THIS_DIR, "orch-stall-detect.mjs");
const LIVE_SRC = readFileSync(LIVE_SRC_PATH, "utf8");

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- stale or ambiguous target`,
  );
  return src.replace(find, replacement);
}

function rewriteRelativeImportsToAbsolute(src, baseDir) {
  return src.replace(
    /from\s+(["'])(\.\.?\/[^"']+)\1/g,
    (whole, quote, relPath) => {
      const absPath = join(baseDir, relPath).replace(/\\/g, "/");
      return `from ${quote}file://${absPath}${quote}`;
    },
  );
}

async function importMutatedSibling(mutate, label) {
  const rewritten = rewriteRelativeImportsToAbsolute(
    mutate(LIVE_SRC),
    THIS_DIR,
  );
  const mutantDir = mkdtempSync(join(tmpdir(), `hyk185-idle-mutant-${label}-`));
  const mutantPath = join(mutantDir, "orch-stall-detect.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

test("NC mutation/seat-idle #1 (필수): 결선 제거(코어를 부르지 않게) -> RED (배달 없는 13.75h 방치 좌석인데도 JUDGED가 되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const seatIdle = judgeSeatIdleAcrossWorktrees({ repoRoot, now }, opts);",
        "  const seatIdle = { status: SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE };",
      ),
    "1",
  );
  await withTempDir("hyk185-idle-mutant1-", async (dir) => {
    initPlainGitRepo(dir);
    const lastOutputAt = Date.parse("2026-08-04T05:00:00+09:00");
    const now = lastOutputAt + 13.75 * 60 * 60 * 1000;
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath: gitWorktreeSelfPath(dir) }],
      showsByHandle: {
        term_x: {
          ok: true,
          result: { terminal: { lastOutputAt, title: "leftover" } },
        },
      },
    });
    const { result } = mutant.runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn },
    );
    assert.equal(
      result.seatIdle.status,
      "SEAT_IDLE_NOT_APPLICABLE",
      "mutant must never actually judge the 13.75h real abandonment (RED signal; proves the wiring call is load-bearing)",
    );
  });
});

test("NC mutation/seat-idle #2 (필수): 수집 실패를 «조용함»(NO_SEAT)으로 접기 -> RED (조회 실패가 정상 방치 없음과 구별되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!observed.ok) {
    return {
      status: SEAT_IDLE_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
    };
  }`,
        `  if (!observed.ok) {
    return { status: SEAT_IDLE_WIRE_STATUS.NO_SEAT };
  }`,
      ),
    "2",
  );
  const r = mutant.judgeSeatIdleForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [],
      now: Date.parse("2026-08-04T12:00:00+09:00"),
    },
    { execFn: throwingExecFn() },
  );
  assert.equal(
    r.status,
    "SEAT_IDLE_NO_SEAT",
    "mutant must misjudge a real query failure as 'no seat, normal' (RED signal; proves the COLLECTION_FAILED branch is load-bearing)",
  );
});

test("NC mutation/seat-idle #3 (필수): 활성 배달 판정을 뒤집음(active dispatch가 있어도 이 축을 판정) -> RED (두 축이 같은 좌석을 두 번 센다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  const active = selectActiveDispatch(droppedTaskFiles);
  if (active) {
    return { status: SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE };
  }`,
        `  const active = selectActiveDispatch(droppedTaskFiles);
  if (!active) {
    return { status: SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE };
  }`,
      ),
    "3",
  );
  const now = Date.parse("2026-08-04T11:30:00+09:00");
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_active", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_active: {
        ok: true,
        result: { terminal: { lastOutputAt: now - 60_000, title: "CODER" } },
      },
    },
  });
  const r = mutant.judgeSeatIdleForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: ACTIVE, now },
    { execFn },
  );
  assert.notEqual(
    r.status,
    "SEAT_IDLE_NOT_APPLICABLE",
    "mutant must judge a seat with an active dispatch on the idle axis too (RED signal; proves the active-dispatch exclusion is load-bearing, coder-task.md §3-b)",
  );
});

test("NC mutation/seat-idle #4 (필수): 워크트리 열거 실패를 «조용함»(NOT_APPLICABLE)으로 접기 -> RED", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!list.ok) {
    return {
      status: SEAT_IDLE_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }`,
        `  if (!list.ok) {
    return {
      status: SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 0,
    };
  }`,
      ),
    "4",
  );
  const r = mutant.judgeSeatIdleAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git not found");
      },
    },
  );
  assert.equal(
    r.status,
    "SEAT_IDLE_NOT_APPLICABLE",
    "mutant must misreport a real enumeration failure as 'nothing to judge, normal' (RED signal; proves the WORKTREE_LIST_FAILED branch is load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #5와 동형).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "seat-idle-wire.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "seat-idle-wire.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
