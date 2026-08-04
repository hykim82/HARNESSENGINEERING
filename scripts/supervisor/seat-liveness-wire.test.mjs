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
  judgeSeatLivenessForRepo,
  runOrchStallDetect,
  SEAT_LIVENESS_WIRE_STATUS,
} from "./orch-stall-detect.mjs";
import {
  SEAT_LIVENESS_VERDICT,
  SEAT_LIVENESS_REASON,
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

// ---------------------------------------------------------------------------
// selectActiveDispatch -- droppedTaskFiles에서 "결과 파일이 아직 없는" 가장
// 최근 항목 하나만 고른다.
// ---------------------------------------------------------------------------
test("selectActiveDispatch: no items -> null (NOT_APPLICABLE upstream)", () => {
  assert.equal(selectActiveDispatch([]), null);
  assert.equal(selectActiveDispatch(undefined), null);
});

test("selectActiveDispatch: all items already have a result file -> null (nothing active)", () => {
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: true },
    },
  ];
  assert.equal(selectActiveDispatch(items), null);
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
        { handle: "term_e2e", worktreePath: dir.replace(/\\/g, "/") },
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
      { execFn },
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
// 필수 mutation 3종(coder-task.md §3-f) -- 매 실행마다 사본으로 RED를
// 자동 확인한다. 디스크의 현재 orch-stall-detect.mjs를 sibling temp
// 파일로 복사해 상대 import(./orch-progress-core.mjs 등)가 그대로
// 풀리게 한다(정직 요구: git HEAD가 아니라 현재 실제 소스를 대상으로
// 한다 -- 이유는 파일 상단 주석 참조).
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

async function importMutatedSibling(mutate, label) {
  const mutantPath = join(
    THIS_DIR,
    `orch-stall-detect.mutant-${label}-${process.pid}-${Date.now()}.mjs`,
  );
  writeFileSync(mutantPath, mutate(LIVE_SRC), "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantPath, { force: true });
  }
}

test("NC mutation/seat-wire #1 (필수): 결선 제거(코어를 부르지 않게) -> RED (활성 배달 + 무응답 좌석인데도 JUDGED가 되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const seatLiveness = judgeSeatLivenessForRepo(\n    { repoRoot, droppedTaskFiles: evidence.droppedTaskFiles, now },\n    opts,\n  );",
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
      terminals: [{ handle: "term_x", worktreePath: dir.replace(/\\/g, "/") }],
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
      { execFn },
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
