// HYK-185 seat-wire (coder-task.md) -- 좌석 무응답 판정 "결선" 계약 시험.
//
// gap#76(seat-liveness-core.mjs)은 판정 코어만 시험했다 -- 이 파일은 예약
// 감시가 실제로 부르는 경로(watch-run.mjs -> orch-stall-detect.mjs)에서
// 그 코어가 실제로 호출되는지, 관측 수집 실패가 "무응답"으로 새지
// 않는지, 오늘의 두 실제 표본이 결선된 경로에서도 올바르게 갈리는지를
// 고정한다(coder-task.md §3 합격 기준 (a)(c)(d)(f) 그대로).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 여기 fixture는 전부 이 시험이 `mkdtemp`로 만든 합성 표적 + 주입한
//    fake execFn이다 -- 실 `orca` 프로세스·실 `.harness/`·실 원격을
//    이 시험이 접촉하지 않는다.
// 2. mutation 시험은 "커밋된 HEAD"가 아니라 **디스크의 현재 소스**를
//    읽는다 -- orch-stall-detect.mjs는 이 사이클 이전부터 이미
//    git에 커밋돼 있던 파일이라(gap#69), HEAD 기준으로 읽으면 이번
//    사이클에서 새로 추가한 결선 줄 자체가 없어 mutation 표적 문자열을
//    찾을 수 없다. 디스크 현재본을 기준으로 삼는 것이 맞다(커밋 후에는
//    디스크=HEAD로 수렴한다).
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
  selectActiveDispatch,
  selectActiveDispatchForStart,
  judgeSeatLivenessForRepo,
  judgeSeatLivenessAcrossWorktrees,
  judgeSeatIdleForRepo,
  judgeDispatchStartForRepo,
  runOrchStallDetect,
  SEAT_LIVENESS_WIRE_STATUS,
  SEAT_LIVENESS_SCAN_FAILURE,
  SEAT_IDLE_WIRE_STATUS,
  DISPATCH_START_WIRE_STATUS,
} from "./orch-stall-detect.mjs";
import {
  SEAT_LIVENESS_VERDICT,
  SEAT_LIVENESS_REASON,
  DEFAULT_MAX_NO_OUTPUT_SECONDS,
} from "./seat-liveness-core.mjs";
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
// HYK-185 seat-scan: `git worktree list`가 돌려주는 경로는 mkdtemp가 준
// 경로와 글자 그대로 같지 않을 수 있다(Windows 8.3 단축 경로 vs git이
// 해석하는 실경로 등, 실측). fake terminal의 worktreePath는 이 경로와
// 일치해야 어댑터의 canonicalizeForComparison이 후보를 찾으므로, "그
// 워크트리 자신"을 가리키는 경로는 항상 이 함수로 구한다(dir을 직접
// 문자열 변환해 쓰지 않는다).
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
// HYK-185 seat-scan (§4-1 "실제 워크트리를 새로 만들지 마라"): 이 시험은
// 저장소 밖 mkdtemp 임시 디렉터리 안에 진짜 워크트리 쌍(메인+링크드)을
// 만든다 -- 이 저장소 자체의 워크트리는 건드리지 않는다.
function addLinkedWorktree(mainDir) {
  const linkedDir = tmpDir("hyk185-linked-");
  rmSync(linkedDir, { recursive: true, force: true });
  const branch = `wt-${process.pid}-${Date.now()}`;
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

// terminal list/show를 흉내내는 fake execFn -- orca-adapter.test.mjs의
// fakeExecFn과 동형 키 규칙(argv[1]로 분기)이지만, 이 파일은 orca-adapter
// 자체가 아니라 그 위의 결선을 시험하는 것이므로 최소한만 재구현한다.
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

// HYK-185-startcheck-wire 5R(coder-task.md §R5, A안) -- runOrchStallDetect는
// 호출자 의도와 무관하게 dispatchStart 축도 함께 계산한다(orch-stall-detect.mjs
// judgeDispatchStartForRepo). 이 파일은 seat-liveness만 보려는 의도지만,
// 아래 두 e2e 표본은 "활성 배달 + 실 경로 일치 좌석"이 우연히 성립해
// dispatchStart도 JUDGED까지 가므로, store를 주입하지 않으면 실 관제실
// 기본 경로(DEFAULT_DISPATCH_START_STORE_PATH)에 쓴다 -- dispatch-start-wire.test.mjs의
// fakeDispatchStartStore()와 동형(§S11-1 -- 실 fs 대신 in-memory로 흉내).
function fakeDispatchStartStore(initialText = null) {
  let stored = initialText;
  return {
    dispatchStartExistsFn: () => stored !== null,
    dispatchStartReadFn: () => stored,
    dispatchStartWriteFn: (_p, text) => {
      stored = text;
    },
    dispatchStartMkdirFn: () => {},
  };
}

// ---------------------------------------------------------------------------
// selectActiveDispatch -- droppedTaskFiles에서 "결과 파일이 아직 없는" 가장
// 최근 항목 하나만 고른다.
// ---------------------------------------------------------------------------
test("selectActiveDispatch: no items -> null (NOT_APPLICABLE upstream)", () => {
  assert.equal(selectActiveDispatch([]), null);
  assert.equal(selectActiveDispatch(undefined), null);
});

test("selectActiveDispatch: all items already have a result file AND resultFileDone -> null (nothing active)", () => {
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: true },
      resultFileDone: true,
    },
  ];
  assert.equal(selectActiveDispatch(items), null);
});

// HYK-201 §4 시험 1/2 「표지만 쓰인 구간」 -- 결과 파일이 존재하지만
// 이번 배달의 `>>> DONE:` 줄이 아직 없다(resultFileDone !== true). 예전
// selectActiveDispatch는 resultFile.exists === false만 봐서 이 구간을
// "활성 배달 없음"으로 오판했다(coder-task.md §1 -- REVIEW의 표지-먼저
// -쓰기 실측과 동형). 이제는 여전히 활성으로 본다.
test("selectActiveDispatch: 결과 파일은 있지만 이번 배달의 DONE 줄이 아직 없음(표지만 쓰인 구간) -> still active", () => {
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: true },
      resultFileDone: false,
    },
  ];
  assert.equal(selectActiveDispatch(items), items[0]);
});

// HYK-201 §4 시험 2/2 「낡은 DONE 줄」 -- 결과 파일에 DONE 줄이 있지만
// collectResultFileCompletion(taskId 대조까지 마친 값)이 그것을 "이전
// 라운드의 것"으로 판단해 resultFileDone: false를 돌려준 경우. 이번
// 라운드는 여전히 활성이어야 한다(coder-task.md §5 이어쓰기 관례).
test("selectActiveDispatch: DONE 줄은 있지만 이전 라운드 것(taskId 불일치, resultFileDone: false) -> still active", () => {
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: true },
      resultFileDone: false,
    },
  ];
  assert.equal(selectActiveDispatch(items), items[0]);
});

test("selectActiveDispatch: exactly one item without a result file -> that item", () => {
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: false },
    },
  ];
  assert.equal(selectActiveDispatch(items), items[0]);
});

test("selectActiveDispatch: multiple active items -> the most recently dropped one wins", () => {
  const older = {
    path: ".harness/coder-task.md",
    droppedAtMs: 1000,
    resultFile: { exists: false },
  };
  const newer = {
    path: ".harness/review-task.md",
    droppedAtMs: 5000,
    resultFile: { exists: false },
  };
  assert.equal(selectActiveDispatch([older, newer]), newer);
  assert.equal(selectActiveDispatch([newer, older]), newer); // 순서 무관.
});

// ---------------------------------------------------------------------------
// judgeSeatLivenessForRepo -- 4상태(NOT_APPLICABLE/NO_SEAT/JUDGED/
// COLLECTION_FAILED)와, "좌석 0개"(정상) vs "조회 실패"(판정 불가) 구별
// (coder-task.md §3-c).
// ---------------------------------------------------------------------------
const ACTIVE = [
  {
    path: ".harness/coder-task.md",
    droppedAtMs: Date.parse("2026-08-04T11:23:00+09:00"),
    resultFile: { exists: false },
  },
];

test("judgeSeatLivenessForRepo: no active dispatch -> NOT_APPLICABLE, zero execFn calls", () => {
  const execFn = () => {
    throw new Error("must not be called");
  };
  const r = judgeSeatLivenessForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: [], now: 1 },
    { execFn },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE);
});

test("judgeSeatLivenessForRepo: active dispatch but zero seats found for this worktree -> NO_SEAT (normal, not a failure)", () => {
  const execFn = fakeOrcaExecFn({ terminals: [] });
  const r = judgeSeatLivenessForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: ACTIVE,
      now: Date.parse("2026-08-04T12:00:00+09:00"),
    },
    { execFn },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.NO_SEAT);
});

test("judgeSeatLivenessForRepo: terminal-list query throws -> COLLECTION_FAILED, distinct from NO_SEAT (coder-task.md §3-c)", () => {
  const r = judgeSeatLivenessForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: ACTIVE,
      now: Date.parse("2026-08-04T12:00:00+09:00"),
    },
    { execFn: throwingExecFn() },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
  );
  assert.notEqual(r.status, SEAT_LIVENESS_WIRE_STATUS.NO_SEAT);
});

// ---------------------------------------------------------------------------
// (d)★ 오늘의 두 실제 표본을 "결선된 경로"(judgeSeatLivenessForRepo)에
// 넣는다 -- 코어 단독 시험은 gap#76에서 이미 했다(seat-liveness-core.
// test.mjs). 이번엔 어댑터 관측 + 코어 판정이 실제로 이어붙는지를 본다.
// ---------------------------------------------------------------------------
test("(d) real 2026-08-04 ~28min stall, through the wired path -> JUDGED/SUSPECTED_UNRESPONSIVE", () => {
  const dispatchedAtMs = Date.parse("2026-08-04T11:23:00+09:00");
  const frozenOutputAt = Date.parse("2026-08-04T11:36:00+09:00");
  const discoveredAt = Date.parse("2026-08-04T12:04:00+09:00");
  const active = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: dispatchedAtMs,
      resultFile: { exists: false },
    },
  ];
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_x: {
        ok: true,
        result: { terminal: { lastOutputAt: frozenOutputAt, title: "CODER" } },
      },
    },
  });
  const r = judgeSeatLivenessForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: active, now: discoveredAt },
    { execFn },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
  assert.equal(r.reasonCode, SEAT_LIVENESS_REASON.NO_OUTPUT_PAST_THRESHOLD);
});

// HYK-201 §4 「41.5시간 침묵 유형 재현」(선례 = reach-report-core.test.mjs
// :81·:109) -- 결과 파일이 존재하지만 이번 배달의 DONE 줄이 아직 없는
// (표지만 쓰인) 좌석이 41.5시간 무응답이다. 이 축의 수리 전에는
// selectActiveDispatch가 resultFile.exists === true만 보고 "활성 배달
// 없음"으로 오판해 NOT_APPLICABLE로 샜다(§1 근거) -- 수리 후에는 이
// 시나리오가 실제로 JUDGED/SUSPECTED_UNRESPONSIVE까지 발화해야 한다.
test("(d)★ HYK-201 41.5h 무응답 + «표지만 쓰인 구간»(resultFile.exists === true, resultFileDone === false), through the wired path -> JUDGED/SUSPECTED_UNRESPONSIVE (수리 전에는 NOT_APPLICABLE로 샜다)", () => {
  const dispatchedAtMs = Date.parse("2026-08-04T20:06:00.000Z"); // 05:06 KST
  const frozenOutputAt = dispatchedAtMs;
  const discoveredAt = dispatchedAtMs + 41.5 * 60 * 60 * 1000; // +41.5h.
  const active = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: dispatchedAtMs,
      resultFile: { exists: true },
      resultFileDone: false,
    },
  ];
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_silent", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_silent: {
        ok: true,
        result: {
          terminal: { lastOutputAt: frozenOutputAt, title: "CODER" },
        },
      },
    },
  });
  const r = judgeSeatLivenessForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: active, now: discoveredAt },
    { execFn },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
  assert.equal(r.reasonCode, SEAT_LIVENESS_REASON.NO_OUTPUT_PAST_THRESHOLD);
});

test("(d) real 2026-08-04 normal 15-minute silence (codex, active work), through the wired path -> JUDGED/RESPONSIVE (오탐 0)", () => {
  const dispatchedAtMs = Date.parse("2026-08-04T09:00:00+09:00");
  const lastOutputAt = Date.parse("2026-08-04T09:10:00+09:00");
  const observedAt = Date.parse("2026-08-04T09:25:00+09:00"); // +15min.
  const active = [
    {
      path: ".harness/review-task.md",
      droppedAtMs: dispatchedAtMs,
      resultFile: { exists: false },
    },
  ];
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_y", worktreePath: "C:/wt2" }],
    showsByHandle: {
      term_y: {
        ok: true,
        result: { terminal: { lastOutputAt, title: "REVIEW" } },
      },
    },
  });
  const r = judgeSeatLivenessForRepo(
    { repoRoot: "C:/wt2", droppedTaskFiles: active, now: observedAt },
    { execFn },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_LIVENESS_VERDICT.RESPONSIVE);
  assert.notEqual(r.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
});

// ---------------------------------------------------------------------------
// (a) end-to-end: runOrchStallDetect(argv, opts) -- 예약 감시가 실제로
// 부르는 진입점 함수 자체에서 seatLiveness 필드가 채워짐을 고정한다
// (opts.execFn을 주면 실 orca 대신 fake로 검증할 수 있다 -- 프로덕션은
// opts 생략 시 createOrcaExecFn()이 기본값이라는 것은 아래 별도 static
// 시험 + §4 실행 인용으로 확인한다).
// ---------------------------------------------------------------------------
test("(a) runOrchStallDetect end-to-end: an active .harness/coder-task.md + a matching real-shaped seat -> result.seatLiveness is JUDGED with a verdict (결선이 실재한다)", () => {
  withTempDir("hyk185-seat-wire-e2e-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-seat-wire-1",
      droppedAt: "2026-08-04 11:23",
    });
    const now = Date.parse("2026-08-04T11:30:00+09:00"); // 배달 7분 후, 정상.
    const execFn = fakeOrcaExecFn({
      terminals: [
        { handle: "term_e2e", worktreePath: gitWorktreeSelfPath(dir) },
      ],
      showsByHandle: {
        term_e2e: {
          ok: true,
          result: {
            terminal: {
              lastOutputAt: now - 60_000,
              title: "CODER",
            },
          },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.ok(result.seatLiveness, "result.seatLiveness must be present");
    assert.equal(
      result.seatLiveness.status,
      SEAT_LIVENESS_WIRE_STATUS.JUDGED,
      "seat-liveness-core.judgeSeatLiveness must actually have been called",
    );
    assert.equal(result.seatLiveness.verdict, SEAT_LIVENESS_VERDICT.RESPONSIVE);
  });
});

test("(a) runOrchStallDetect end-to-end: no --repo-root worktree seat at all -> result.seatLiveness.status is NO_SEAT (still surfaced, not silently omitted)", () => {
  withTempDir("hyk185-seat-wire-e2e-noseat-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-seat-wire-1",
      droppedAt: "2026-08-04 11:23",
    });
    const now = Date.parse("2026-08-04T11:30:00+09:00");
    const execFn = fakeOrcaExecFn({ terminals: [] });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn },
    );
    assert.equal(result.seatLiveness.status, SEAT_LIVENESS_WIRE_STATUS.NO_SEAT);
  });
});

test("(a) runOrchStallDetect end-to-end: repo with no active dispatch (no .harness/*-task.md) -> seatLiveness.status NOT_APPLICABLE, zero execFn calls", () => {
  withTempDir("hyk185-seat-wire-e2e-na-", (dir) => {
    initPlainGitRepo(dir);
    const execFn = () => {
      throw new Error("must not be called -- no active dispatch to check");
    };
    const { result } = runOrchStallDetect(["--repo-root", dir, "--json"], {
      execFn,
    });
    assert.equal(
      result.seatLiveness.status,
      SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE,
    );
  });
});

// ---------------------------------------------------------------------------
// production 기본값: opts를 안 주면 createOrcaExecFn()(실 spawn)이 기본
// 값이다 -- 예약 감시가 이 함수를 그대로 호출하면 실제로 orca가 나간다
// (정적 확인 -- 실행 인용은 .harness/coder.md §4-1에 별도로 남긴다).
// ---------------------------------------------------------------------------
test("static: judgeSeatLivenessForRepo defaults opts.execFn to createOrcaExecFn() when the caller doesn't override it (production wiring is live, not opt-in)", () => {
  const src = readFileSync(join(THIS_DIR, "orch-stall-detect.mjs"), "utf8");
  assert.match(
    src,
    /typeof opts\.execFn === "function" \? opts\.execFn : createOrcaExecFn\(\)/,
  );
});

// ---------------------------------------------------------------------------
// HYK-185 seat-scan (coder-task.md §1-§2, §3-a) -- 이 조각의 존재 이유:
// judgeSeatLivenessAcrossWorktrees가 --repo-root 하나의 .harness만 보던
// gap#77의 구조적 한계를 실제로 넘는지 증명한다. 메인에는 활성 배달이
// 없고, «워크트리»(git worktree add로 만든 진짜 링크드 워크트리)에만
// 활성 배달 + 무응답 좌석이 있는 형태로 구성한다 -- gap#77 코드라면
// 메인만 보고 NOT_APPLICABLE로 끝났을 것이다.
// ---------------------------------------------------------------------------
test("(a)★ 존재 이유: 메인이 아니라 «링크드 워크트리»의 무응답이 잡힌다(오늘의 28분 갇힘과 동형) -- gap#77 코드는 메인만 봐서 여기서 NOT_APPLICABLE로 끝났을 것", () => {
  withTempDir("hyk185-scan-main-", (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeTaskFile(linkedDir, {
        taskId: "HYK-185-seat-scan-1",
        droppedAt: "2026-08-04 11:23",
      });
      const frozenOutputAt = Date.parse("2026-08-04T11:36:00+09:00");
      const discoveredAt = Date.parse("2026-08-04T12:04:00+09:00");
      const [mainPath, linkedPath] = listWorktreePaths(mainDir);
      assert.notEqual(
        linkedPath,
        mainPath,
        "링크드 워크트리는 메인과 다른 경로여야 한다",
      );
      const execFn = fakeOrcaExecFn({
        terminals: [{ handle: "term_stuck", worktreePath: linkedPath }],
        showsByHandle: {
          term_stuck: {
            ok: true,
            result: {
              terminal: { lastOutputAt: frozenOutputAt, title: "CODER" },
            },
          },
        },
      });
      const r = judgeSeatLivenessAcrossWorktrees(
        { repoRoot: mainDir, now: discoveredAt },
        { execFn },
      );
      assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
      assert.equal(r.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
      assert.equal(r.worktreePath, linkedPath);
      const crossingMs = frozenOutputAt + DEFAULT_MAX_NO_OUTPUT_SECONDS * 1000;
      assert.ok(
        crossingMs < discoveredAt,
        "임계 초과 시각이 사람이 발견한 12:04보다 이르다",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("(b) 재사용(새 표본 만들지 않음): 정상 15분 침묵이 judgeSeatLivenessAcrossWorktrees(다중 워크트리 스캔 경로)에서도 오탐 0", () => {
  withTempDir("hyk185-scan-normal-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-normal",
      droppedAt: "2026-08-04 09:00",
    });
    const [selfPath] = listWorktreePaths(dir);
    const lastOutputAt = Date.parse("2026-08-04T09:10:00+09:00");
    const now = Date.parse("2026-08-04T09:25:00+09:00"); // +15min, 정상 침묵 표본 재사용.
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_y", worktreePath: selfPath }],
      showsByHandle: {
        term_y: {
          ok: true,
          result: { terminal: { lastOutputAt, title: "REVIEW" } },
        },
      },
    });
    const r = judgeSeatLivenessAcrossWorktrees(
      { repoRoot: dir, now },
      { execFn },
    );
    assert.equal(r.verdict, SEAT_LIVENESS_VERDICT.RESPONSIVE);
    assert.notEqual(r.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
  });
});

test("(c)-② judgeSeatLivenessAcrossWorktrees: git worktree list 자체가 실패 -> WORKTREE_LIST_FAILED(판정 불가), NOT_APPLICABLE로 접히지 않는다", () => {
  const r = judgeSeatLivenessAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git not found");
      },
    },
  );
  assert.equal(r.status, SEAT_LIVENESS_SCAN_FAILURE.WORKTREE_LIST_FAILED);
  assert.notEqual(r.status, SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE);
});

test("(c)-③ judgeSeatLivenessAcrossWorktrees: 개별 워크트리 .harness 읽기 실패 -> HARNESS_READ_FAILED(판정 불가), 좌석 조회조차 시도하지 않는다", () => {
  const r = judgeSeatLivenessAcrossWorktrees(
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
  assert.equal(r.status, SEAT_LIVENESS_SCAN_FAILURE.HARNESS_READ_FAILED);
  assert.notEqual(r.status, SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE);
});

test("§2-2 여러 건 동시 무응답: 두 워크트리가 동시에 SUSPECTED_UNRESPONSIVE -> worstCount=2, totalWorktrees=2 (건수가 사라지지 않는다)", () => {
  withTempDir("hyk185-scan-multi-", (mainDir) => {
    initPlainGitRepo(mainDir);
    writeTaskFile(mainDir, {
      taskId: "HYK-185-multi-a",
      droppedAt: "2026-08-04 11:00",
    });
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeTaskFile(linkedDir, {
        taskId: "HYK-185-multi-b",
        droppedAt: "2026-08-04 11:05",
      });
      const [mainPath, linkedPath] = listWorktreePaths(mainDir);
      const now = Date.parse("2026-08-04T12:00:00+09:00");
      const stale = Date.parse("2026-08-04T11:00:00+09:00");
      const execFn = fakeOrcaExecFn({
        terminals: [
          { handle: "term_a", worktreePath: mainPath },
          { handle: "term_b", worktreePath: linkedPath },
        ],
        showsByHandle: {
          term_a: {
            ok: true,
            result: { terminal: { lastOutputAt: stale, title: "CODER" } },
          },
          term_b: {
            ok: true,
            result: { terminal: { lastOutputAt: stale, title: "REVIEW" } },
          },
        },
      });
      const r = judgeSeatLivenessAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn },
      );
      assert.equal(r.verdict, SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE);
      assert.equal(r.worstCount, 2);
      assert.equal(r.totalWorktrees, 2);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 필수 mutation 6종(coder-task.md §3-f) -- 매 실행마다 사본으로 RED를
// 자동 확인한다. 디스크의 현재 orch-stall-detect.mjs를 읽어 상대 import
// (`./orch-progress-core.mjs` 등)를 그 실제 파일의 **절대 `file://`
// 경로**로 치환한 뒤, **저장소 밖 `mkdtemp`**에 쓴다(정직 요구: git HEAD가
// 아니라 현재 실제 소스를 대상으로 한다 -- 이유는 파일 상단 주석 참조).
//
// HYK-185 2R(coder-task.md §R2) -- 이전 형태는 변이체를 `THIS_DIR`(=
// `scripts/supervisor/`, 실제 저장소 안)에 썼다. `finally`로 지우긴
// 했지만, node 시험 러너가 여러 파일을 병렬로 돌리는 동안 그 찰나를
// `watch-freshness-core.test.mjs`의 "워크트리가 그대로인가" 가드가
// 실제로 붙잡았다(CI 간헐 실패, 로컬 5축은 타이밍상 못 봤을 뿐). 가드
// 자체는 제 역할을 한 것이므로 약화시키지 않고, 변이체를 애초에
// 저장소 밖으로 옮겨 이 충돌의 뿌리를 없앤다 -- 상대 import는 형제
// 위치가 아니어도 절대 경로 치환으로 그대로 풀린다(동작은 동일).
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

// 상대 import(`from "./x.mjs"`/`from "../x/y.mjs"`)를 baseDir 기준
// 절대 `file://` 경로로 치환한다 -- 변이체가 저장소 밖 mkdtemp에 있어도
// 형제 모듈(같은 실제 파일)을 그대로 가리키게 한다.
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
  const mutantDir = mkdtempSync(join(tmpdir(), `hyk185-mutant-${label}-`));
  const mutantPath = join(mutantDir, "orch-stall-detect.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

test("NC mutation/seat-wire #1 (필수): 결선 제거(코어를 부르지 않게) -> RED (활성 배달 + 무응답 좌석인데도 JUDGED가 되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const seatLiveness = judgeSeatLivenessAcrossWorktrees(\n    { repoRoot, now },\n    opts,\n  );",
        "  const seatLiveness = { status: SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE };",
      ),
    "1",
  );
  await withTempDir("hyk185-mutant1-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-seat-wire-1",
      droppedAt: "2026-08-04 11:23",
    });
    const now = Date.parse("2026-08-04T12:04:00+09:00"); // 실제 사고 발견 시각.
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath: gitWorktreeSelfPath(dir) }],
      showsByHandle: {
        term_x: {
          ok: true,
          result: {
            terminal: {
              lastOutputAt: Date.parse("2026-08-04T11:36:00+09:00"),
              title: "CODER",
            },
          },
        },
      },
    });
    const { result } = mutant.runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.equal(
      result.seatLiveness.status,
      "SEAT_LIVENESS_NOT_APPLICABLE",
      "mutant must never actually judge the 28-minute real stall (RED signal; proves the wiring call is load-bearing in the real code)",
    );
  });
});

test("NC mutation/seat-wire #2 (필수): 수집 실패를 «조용함»(NO_SEAT)으로 접기 -> RED (조회 실패가 정상 침묵과 구별되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!observed.ok) {
    return {
      status: SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
      dispatch,
      ...(correlation ? { correlation } : {}),
    };
  }`,
        `  if (!observed.ok) {
    return { status: SEAT_LIVENESS_WIRE_STATUS.NO_SEAT, dispatch };
  }`,
      ),
    "2",
  );
  const r = mutant.judgeSeatLivenessForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [
        {
          path: ".harness/coder-task.md",
          droppedAtMs: Date.parse("2026-08-04T11:23:00+09:00"),
          resultFile: { exists: false },
        },
      ],
      now: Date.parse("2026-08-04T12:00:00+09:00"),
    },
    { execFn: throwingExecFn() },
  );
  assert.equal(
    r.status,
    "SEAT_LIVENESS_NO_SEAT",
    "mutant must misjudge a real query failure as 'no seat, normal' (RED signal; proves the COLLECTION_FAILED branch is load-bearing in the real code, coder-task.md §3-c)",
  );
});

test("NC mutation/seat-wire #3 (필수): 어댑터 경유를 우회해 진입점이 직접 orca를 spawn -> RED (G9 정적 경계 시험이 이를 잡는다)", () => {
  const bypassed = applyMutation(
    LIVE_SRC,
    'import { execFileSync } from "node:child_process";',
    'import { execFileSync, spawnSync } from "node:child_process";\nconst __bypass = () => spawnSync("orca", ["terminal", "list", "--json"]);',
  );
  const codeOnly = bypassed.replace(/\/\/.*$/gm, "");
  const EXEC_CALL_RE =
    /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["'`]orca["'`]/;
  assert.equal(
    EXEC_CALL_RE.test(codeOnly),
    true,
    "mutant that bypasses the adapter and spawns 'orca' directly must be caught by the same static pattern orca-cli-boundary.mjs enforces (RED signal; proves the boundary test is load-bearing, not vacuously green)",
  );
});

// ---------------------------------------------------------------------------
// HYK-185 seat-scan 필수 mutation 3종(coder-task.md §3-f, gap#77의
// mutation #1-#3과는 다른 결함 표면 -- ①워크트리 스캔 자체 제거
// ②열거 실패를 조용함으로 흡수 ③좌석-워크트리 대응 무시).
// ---------------------------------------------------------------------------
test("NC mutation/seat-scan #1 (필수): 워크트리 스캔 제거(메인만 보게 되돌림) -> RED (링크드 워크트리의 무응답 좌석을 놓친다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const worktrees = list.worktrees.map((wt) =>\n    judgeSeatLivenessForWorktree(wt, now, opts),\n  );",
        "  const worktrees = [judgeSeatLivenessForWorktree(repoRoot, now, opts)];",
      ),
    "scan-1",
  );
  await withTempDir("hyk185-mutant-scan1-", async (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeTaskFile(linkedDir, {
        taskId: "HYK-185-seat-scan-1",
        droppedAt: "2026-08-04 11:23",
      });
      const [, linkedPath] = listWorktreePaths(mainDir);
      const now = Date.parse("2026-08-04T12:04:00+09:00");
      const execFn = fakeOrcaExecFn({
        terminals: [{ handle: "term_stuck", worktreePath: linkedPath }],
        showsByHandle: {
          term_stuck: {
            ok: true,
            result: {
              terminal: {
                lastOutputAt: Date.parse("2026-08-04T11:36:00+09:00"),
                title: "CODER",
              },
            },
          },
        },
      });
      const r = mutant.judgeSeatLivenessAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn },
      );
      assert.equal(
        r.status,
        SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE,
        "mutant must miss the linked worktree's stall entirely (RED signal; proves the worktree-scan call is load-bearing, not just repoRoot's own .harness)",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

test("NC mutation/seat-scan #2 (필수): 워크트리 열거 실패를 «조용함»(NOT_APPLICABLE)으로 접기 -> RED (열거 실패가 정상 무배달과 구별되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!list.ok) {
    return {
      status: list.reason,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }`,
        `  if (!list.ok) {
    return {
      status: SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 0,
    };
  }`,
      ),
    "scan-2",
  );
  const r = mutant.judgeSeatLivenessAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git not found");
      },
    },
  );
  assert.equal(
    r.status,
    "SEAT_LIVENESS_NOT_APPLICABLE",
    "mutant must misreport a real enumeration failure as 'nothing to judge, normal' (RED signal; proves the WORKTREE_LIST_FAILED branch is load-bearing)",
  );
});

test("NC mutation/seat-scan #3 (필수): 좌석-워크트리 대응 무시(엉뚱한 좌석으로 판정) -> RED (링크드 워크트리를 항상 존재하지 않는 경로로 조회해 매번 NO_SEAT)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const judged = judgeSeatLivenessForRepo(\n    { repoRoot: worktreePath, droppedTaskFiles: evidence.items, now },\n    opts,\n  );",
        '  const judged = judgeSeatLivenessForRepo(\n    { repoRoot: "C:/hyk185-seat-scan-mutant-wrong-worktree", droppedTaskFiles: evidence.items, now },\n    opts,\n  );',
      ),
    "scan-3",
  );
  await withTempDir("hyk185-mutant-scan3-", async (mainDir) => {
    initPlainGitRepo(mainDir);
    const linkedDir = addLinkedWorktree(mainDir);
    try {
      writeTaskFile(linkedDir, {
        taskId: "HYK-185-seat-scan-1",
        droppedAt: "2026-08-04 11:23",
      });
      const [, linkedPath] = listWorktreePaths(mainDir);
      const now = Date.parse("2026-08-04T12:04:00+09:00");
      const execFn = fakeOrcaExecFn({
        terminals: [{ handle: "term_stuck", worktreePath: linkedPath }],
        showsByHandle: {
          term_stuck: {
            ok: true,
            result: {
              terminal: {
                lastOutputAt: Date.parse("2026-08-04T11:36:00+09:00"),
                title: "CODER",
              },
            },
          },
        },
      });
      const r = mutant.judgeSeatLivenessAcrossWorktrees(
        { repoRoot: mainDir, now },
        { execFn },
      );
      const linkedEntry = r.worktrees.find(
        (w) => w.worktreePath === linkedPath,
      );
      assert.equal(
        linkedEntry.status,
        "SEAT_LIVENESS_NO_SEAT",
        "mutant must fail to match the seat to its actual worktree, misjudging a real stall as 'no seat, normal' for that worktree's own entry (RED signal; proves the worktreePath-as-repoRoot correspondence is load-bearing)",
      );
      assert.notEqual(
        r.verdict,
        SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE,
        "the aggregate must never surface the real stall either",
      );
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HYK-201 §4 필수 mutation 3종 -- isDispatchStillActive(HYK-201 신규
// 공유 판정)을 표적으로 삼는다.
// ---------------------------------------------------------------------------
test("NC mutation/HYK-201 #1 (필수 ⓐ): 새 조건을 옛 조건(resultFile.exists === false 만)으로 되돌림 -> RED (표지만 쓰인 구간을 다시 NOT_APPLICABLE로 놓친다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (item.resultFile.exists === false) return true;
  // 결과 파일은 있다 -- "이번 배달"의 DONE 줄이 있어야만 진짜로 끝난
  // 것이다(resultFileDone은 task_id 일치까지 확인된 값, 위 주석 참조).
  return item.resultFileDone !== true;`,
        `  if (item.resultFile.exists === false) return true;
  return false;`,
      ),
    "201-1",
  );
  const dispatchedAtMs = Date.parse("2026-08-04T20:06:00.000Z");
  const now = dispatchedAtMs + 41.5 * 60 * 60 * 1000;
  const active = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: dispatchedAtMs,
      resultFile: { exists: true },
      resultFileDone: false,
    },
  ];
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_silent", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_silent: {
        ok: true,
        result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
      },
    },
  });
  const r = mutant.judgeSeatLivenessForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: active, now },
    { execFn },
  );
  assert.equal(
    r.status,
    "SEAT_LIVENESS_NOT_APPLICABLE",
    "mutant must miss the still-writing (cover-only) 41.5h stall again (RED signal; proves the resultFileDone check is load-bearing)",
  );
});

test("NC mutation/HYK-201 #2 (필수 ⓑ): collectResultFileCompletion의 taskId 일치를 «아무 DONE 줄이나 인정»으로 약화 -> RED (낡은 DONE 줄이 이번 배달을 끝난 것으로 오판한다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    const sameTaskId =
      typeof taskId === "string" &&
      taskId.length > 0 &&
      resultTaskId === taskId;
    return sameTaskId && RESULT_DONE_RE.test(text);`,
        `    const sameTaskId =
      typeof taskId === "string" &&
      taskId.length > 0 &&
      resultTaskId === taskId;
    return RESULT_DONE_RE.test(text);`,
      ),
    "201-2",
  );
  await withTempDir("hyk201-mutant2-", async (dir) => {
    initPlainGitRepo(dir);
    // 이번 배달의 task_id는 HYK-201-stale-2, dropped_at은 41.5h 전이다.
    writeTaskFile(dir, {
      taskId: "HYK-201-stale-2",
      droppedAt: "2026-08-04 05:06",
    });
    // 결과 파일에는 **이전 라운드**(다른 task_id)의 표지 + DONE 줄이
    // 남아 있다(coder-task.md §5 이어쓰기 관례와 동형).
    mkdirSync(join(dir, ".harness"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "coder.md"),
      "task_id: HYK-201-stale-2-PREVIOUS-ROUND\nverdict: question\n>>> DONE: HYK-201-stale-2-PREVIOUS-ROUND @ 2026-08-03 09:00 KST\n",
      "utf8",
    );
    const now = Date.parse("2026-08-05T22:36:00+09:00"); // dropped_at + 41.5h.
    const execFn = fakeOrcaExecFn({
      terminals: [
        { handle: "term_stale", worktreePath: gitWorktreeSelfPath(dir) },
      ],
      showsByHandle: {
        term_stale: {
          ok: true,
          result: {
            terminal: {
              lastOutputAt: Date.parse("2026-08-04T05:06:00+09:00"),
              title: "CODER",
            },
          },
        },
      },
    });
    const { result } = mutant.runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.equal(
      result.seatLiveness.status,
      "SEAT_LIVENESS_NOT_APPLICABLE",
      "mutant must accept the previous round's stale DONE line as proof this round is finished (RED signal; proves the taskId-match check inside collectResultFileCompletion is load-bearing)",
    );
  });
});

test("NC mutation/HYK-201 #3 (목록 밖 자유 변조): selectActiveDispatch의 정렬 방향을 뒤집음(가장 오래된 배달이 이김) -> RED (여러 활성 배달 중 엉뚱한(낡은) 것을 대표로 고른다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `export function selectActiveDispatch(droppedTaskFiles) {
  const active = (Array.isArray(droppedTaskFiles) ? droppedTaskFiles : [])
    .filter(isDispatchStillActive)
    .sort((a, b) => b.droppedAtMs - a.droppedAtMs);
  return active.length > 0 ? active[0] : null;
}`,
        `export function selectActiveDispatch(droppedTaskFiles) {
  const active = (Array.isArray(droppedTaskFiles) ? droppedTaskFiles : [])
    .filter(isDispatchStillActive)
    .sort((a, b) => a.droppedAtMs - b.droppedAtMs);
  return active.length > 0 ? active[0] : null;
}`,
      ),
    "201-3",
  );
  const older = {
    path: ".harness/coder-task.md",
    droppedAtMs: 1000,
    resultFile: { exists: false },
  };
  const newer = {
    path: ".harness/review-task.md",
    droppedAtMs: 5000,
    resultFile: { exists: false },
  };
  const picked = mutant.selectActiveDispatch([older, newer]);
  assert.notEqual(
    picked,
    newer,
    "mutant must pick the stale older dispatch instead of the real most-recent one (RED signal; proves the sort direction is load-bearing)",
  );
});

// ---------------------------------------------------------------------------
// HYK-202 guard contract -- isDispatchStillActive(:624)의
// `Number.isFinite(item.droppedAtMs)` 가드를 시험으로 고정한다.
//
// §2 판정((나) -- 지금은 도달 불가, defense in depth): 이 가드가 실제로
// 막는 값을 만드는 생산자는 `droppedTaskFiles` 배열을 만드는
// `buildDroppedTaskFileItem`(:338) 하나뿐이다 -- 그 함수는 `Number.isNaN`인
// 경우를 이미 `null`로 접어서 내보내고(:355), `Date.parse`는 애초에
// `Infinity`를 만들 수 없다(JS Date 타임스탬프는 항상 유한하거나 NaN).
// 즉 오늘의 생산 경로는 NaN·Infinity를 이 가드까지 보내지 않는다. 이
// 계약이 고정하는 것은 "지금 막는다"가 아니라 ***"생산자가 바뀌어도 이
// 경계는 조용히 열리지 않는다"*** -- 아래 가드-제거 mutation이 그 경계
// 자체를 표적으로 삼는다.
//
// 이 계약이 보장하지 않는 것: `null`·문자열 입력은 이 가드
// (`Number.isFinite`)가 막는 게 아니라 그 **앞의** `typeof item.droppedAtMs
// !== "number"` 검사가 막는다(`typeof null === "object"`, `typeof "x" ===
// "string"`) -- 아래 두 케이스는 이름·주석에 그 사실을 명시해 어느 검사가
// 무엇을 막는지 뒤섞지 않는다.
// ---------------------------------------------------------------------------
function itemWith(droppedAtMs) {
  return {
    path: ".harness/coder-task.md",
    taskId: "HYK-202-guard-1",
    droppedAtMs,
    resultFile: { exists: false },
    resultFileDone: null,
    taskIdMismatch: false,
  };
}

test("HYK-202 guard/selectActiveDispatch: NaN droppedAtMs -> not picked (Number.isFinite(NaN) === false -- the ONLY check that blocks NaN, typeof NaN === 'number' passes the earlier typeof guard)", () => {
  assert.equal(selectActiveDispatch([itemWith(NaN)]), null);
});

test("HYK-202 guard/selectActiveDispatch: Infinity droppedAtMs -> not picked (Number.isFinite(Infinity) === false -- the ONLY check that blocks Infinity, typeof Infinity === 'number' passes the earlier typeof guard)", () => {
  assert.equal(selectActiveDispatch([itemWith(Infinity)]), null);
});

test("HYK-202 guard/selectActiveDispatch: null droppedAtMs -> not picked (blocked by the EARLIER `typeof !== 'number'` check, not by Number.isFinite -- typeof null === 'object')", () => {
  assert.equal(selectActiveDispatch([itemWith(null)]), null);
});

test("HYK-202 guard/selectActiveDispatch: string droppedAtMs -> not picked (blocked by the EARLIER `typeof !== 'number'` check, not by Number.isFinite -- typeof '2026-01-01' === 'string')", () => {
  assert.equal(selectActiveDispatch([itemWith("2026-01-01")]), null);
});

test("HYK-202 guard/selectActiveDispatch: an ordinary finite number droppedAtMs -> picked (control: the guard does not over-block valid input)", () => {
  const item = itemWith(1_754_290_000_000);
  assert.equal(selectActiveDispatch([item]), item);
});

test("HYK-202 guard/selectActiveDispatchForStart: shares the identical NaN/Infinity guard (alias of selectActiveDispatch per HYK-201)", () => {
  assert.equal(selectActiveDispatchForStart([itemWith(NaN)]), null);
  assert.equal(selectActiveDispatchForStart([itemWith(Infinity)]), null);
});

// ---------------------------------------------------------------------------
// 세 축(seat-liveness/seat-idle/dispatch-start) 각각에서 NaN·Infinity가
// "그 값이 들어오면 어떤 상태가 되는가"를 단언한다(coder-task.md §3-2).
// 셋 다 selectActiveDispatch(Start)를 공유하므로 가드가 막으면 세 축
// 모두 "활성 배달 없음"으로 수렴하지만, 그 결과로 도달하는 최종 status는
// 축마다 다르다(liveness/dispatch-start는 즉시 NOT_APPLICABLE, seat-idle은
// 반대로 "활성 배달 없음"일 때 관측을 진행한다).
// ---------------------------------------------------------------------------
for (const [label, badValue] of [
  ["NaN", NaN],
  ["Infinity", Infinity],
]) {
  test(`HYK-202 guard/three axes (${label}): seat-liveness -> NOT_APPLICABLE (guard blocks it from being "active", so this axis has nothing to judge)`, () => {
    const r = judgeSeatLivenessForRepo(
      {
        repoRoot: "C:/wt",
        droppedTaskFiles: [itemWith(badValue)],
        now: 1_000_000_000_000,
      },
      {
        execFn: () => {
          throw new Error(
            "must not be called -- guard should already have excluded this item",
          );
        },
      },
    );
    assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE);
  });

  test(`HYK-202 guard/three axes (${label}): dispatch-start -> NOT_APPLICABLE (same shared guard, same immediate short-circuit)`, () => {
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: "C:/wt",
        droppedTaskFiles: [itemWith(badValue)],
        now: 1_000_000_000_000,
      },
      {
        execFn: () => {
          throw new Error(
            "must not be called -- guard should already have excluded this item",
          );
        },
      },
    );
    assert.equal(r.status, DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE);
  });

  test(`HYK-202 guard/three axes (${label}): seat-idle -> proceeds to observe (guard blocks it from being "active", and seat-idle's contract is the mirror: no active dispatch -> this axis IS the one on point; zero real seats here -> NO_SEAT)`, () => {
    const execFn = fakeOrcaExecFn({ terminals: [] });
    const r = judgeSeatIdleForRepo(
      {
        repoRoot: "C:/wt",
        droppedTaskFiles: [itemWith(badValue)],
        now: 1_000_000_000_000,
      },
      { execFn },
    );
    assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.NO_SEAT);
  });
}

// ---------------------------------------------------------------------------
// ★★필수(coder-task.md §4) -- 가드(`Number.isFinite(item.droppedAtMs)`)를
// 제거한 사본에서 위 계약이 RED가 되는 것을 고정한다. 세 축 중
// seat-liveness를 표적으로 삼는다(가드가 없으면 NaN 항목이 "활성"으로
// 오인되어 NOT_APPLICABLE 대신 실제로 판정(JUDGED)까지 간다).
// ---------------------------------------------------------------------------
test("NC mutation/HYK-202 #1 (필수 -- 가드 제거): isDispatchStillActive에서 Number.isFinite 검사를 지움 -> RED (NaN 항목이 '활성'으로 오인되어 seat-liveness가 NOT_APPLICABLE 대신 JUDGED까지 간다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (
    !item ||
    typeof item.droppedAtMs !== "number" ||
    !Number.isFinite(item.droppedAtMs) ||
    !item.resultFile
  ) {
    return false;
  }`,
        `  if (
    !item ||
    typeof item.droppedAtMs !== "number" ||
    !item.resultFile
  ) {
    return false;
  }`,
      ),
    "202-1",
  );
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_x: {
        ok: true,
        result: { terminal: { lastOutputAt: 999_000_000_000, title: "CODER" } },
      },
    },
  });
  const r = mutant.judgeSeatLivenessForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [itemWith(NaN)],
      now: 1_000_000_000_000,
    },
    { execFn },
  );
  assert.notEqual(
    r.status,
    "SEAT_LIVENESS_NOT_APPLICABLE",
    "mutant must wrongly treat the NaN-droppedAtMs item as an active dispatch and actually judge it (RED signal; proves Number.isFinite is load-bearing)",
  );
});

// 추가 변조 #1(목록 안 -- §1 표의 +Infinity 행을 정확히 재현하는 «그럴듯한
// 실수»): `Number.isFinite`를 하한만 있는 부등식(`x > -Infinity`)으로
// 바꿔치기 -- NaN·-Infinity·null·문자열은 여전히 막히지만(직접 실측,
// `null > -Infinity`는 0 > -Infinity로 강제형변환돼 통과하지만 그 앞의
// `typeof` 검사가 여전히 막는다), **+Infinity만** 새서 통과한다.
test("NC mutation/HYK-202 #2 (목록 안 -- +Infinity만 새는 상한 누락): Number.isFinite를 'x > -Infinity'(상한 검사 없음)로 바꿔치기 -> RED (+Infinity가 가드를 통과해 활성으로 오인된다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    !Number.isFinite(item.droppedAtMs) ||`,
        `    !(item.droppedAtMs > -Infinity) ||`,
      ),
    "202-2",
  );
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_x: {
        ok: true,
        result: { terminal: { lastOutputAt: 999_000_000_000, title: "CODER" } },
      },
    },
  });
  const r = mutant.judgeSeatLivenessForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [itemWith(Infinity)],
      now: 1_000_000_000_000,
    },
    { execFn },
  );
  assert.notEqual(
    r.status,
    "SEAT_LIVENESS_NOT_APPLICABLE",
    "mutant must wrongly treat +Infinity as a valid, active droppedAtMs once the upper bound is dropped (RED signal; proves Number.isFinite's upper-bound check is load-bearing, distinct from the lower-bound mutation below)",
  );
});

// 추가 변조 #2(★목록 밖 -- 자유 변조): Number.isFinite를 부호 없는
// 유한성 검사(Number.isFinite(Math.abs(x)))로 바꿔치기 -- 언뜻 동치처럼
// 보이지만 NaN은 Math.abs(NaN)도 NaN이라 여전히 막히고 Infinity도
// 마찬가지라, 실제로는 이 변조로 아무 시험도 안 깨질 수 있다. 그래서
// 대신 "제거"가 아니라 "약화"를 시험한다: `-Infinity`(음의 무한대) 하나만
// 통과시키는 실수(부호 검사 누락)를 재현한다.
test("NC mutation/HYK-202 #3 (★목록 밖 -- 자유 변조): Number.isFinite를 'x === x && x < Infinity'(음의 무한대 누락)로 바꿔치기 -> RED (-Infinity가 가드를 통과해 활성으로 오인된다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    !Number.isFinite(item.droppedAtMs) ||`,
        `    !(item.droppedAtMs === item.droppedAtMs && item.droppedAtMs < Infinity) ||`,
      ),
    "202-3",
  );
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_x: {
        ok: true,
        result: { terminal: { lastOutputAt: 999_000_000_000, title: "CODER" } },
      },
    },
  });
  const r = mutant.judgeSeatLivenessForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: [itemWith(-Infinity)],
      now: 1_000_000_000_000,
    },
    { execFn },
  );
  assert.notEqual(
    r.status,
    "SEAT_LIVENESS_NOT_APPLICABLE",
    "mutant must wrongly treat -Infinity as a valid, active droppedAtMs (RED signal; proves the guard covers BOTH signs of Infinity, not just +Infinity)",
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
    "seat-liveness-wire.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "seat-liveness-wire.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
