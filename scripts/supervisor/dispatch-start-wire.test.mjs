// HYK-185-startcheck-wire (coder-task.md) -- «배달 후 시작됐는가» 판정
// "결선" 계약 시험.
//
// dispatch-start-core.test.mjs는 판정 코어만 시험했다(gap#74) -- ORCH 실측
// 으로 그 코어를 import하는 프로덕션 파일이 0개였다. 이 파일은 예약 감시가
// 실제로 부르는 경로(watch-run.mjs -> orch-stall-detect.mjs)에서 그 코어가
// 실제로 호출되는지, 관측 수집/저장 실패가 "시작 안 됨"으로도 "정상"으로도
// 새지 않는지, 오늘의 실제 사고(3.4시간 미시작)와 그 반대(정상 즉시 시작)
// 표본이 결선된 경로에서 실제로 갈리는지를 고정한다(coder-task.md §3 합격
// 기준 (a)(b)(c)(d)(f) 그대로).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 여기 fixture는 전부 이 시험이 `mkdtemp`로 만든 합성 표적 + 주입한 fake
//    execFn/fake store다 -- 실 `orca` 프로세스·실 `.harness/`·실 관제실
//    `watch\dispatch-start-observations.json`을 이 시험이 접촉하지 않는다.
// 2. judgeDispatchStart 코어 자신은 한 글자도 시험하지 않는다(이미
//    dispatch-start-core.test.mjs가 함) -- 이 파일은 오직 "결선"만 본다.
// 3. mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를 읽는다
//    (seat-liveness-wire.test.mjs/seat-idle-wire.test.mjs와 동일 이유).
// 4. ★변이체는 저장소 밖 `mkdtemp`에 쓰고 상대 import는 절대 `file://`로
//    치환한다(같은 선례) -- 저장소 안에 쓰면 다른 시험의 "워크트리 청결"
//    가드가 잔재를 본다.
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
  judgeDispatchStartForRepo,
  judgeDispatchStartAcrossWorktrees,
  runOrchStallDetect,
  DISPATCH_START_WIRE_STATUS,
  DISPATCH_START_SCAN_FAILURE,
} from "./orch-stall-detect.mjs";
import { DISPATCH_START_VERDICT } from "./dispatch-start-core.mjs";
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

// terminal list/show를 흉내내는 fake execFn(seat-liveness-wire.test.mjs와
// 동형) -- showsByHandle이 함수면 매 호출마다 다시 불러 값을 바꿀 수 있게
// 한다(watch tick마다 lastOutputAt이 달라지는 표본을 흉내내는 용도).
function fakeOrcaExecFn({ terminals = [], showsByHandle = {} } = {}) {
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { ok: true, result: { terminals } };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      const stub = showsByHandle[handle];
      if (!stub) throw new Error(`fakeOrcaExecFn: no show-stub for ${handle}`);
      return typeof stub === "function" ? stub() : stub;
    }
    throw new Error(`fakeOrcaExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}
function throwingExecFn() {
  return () => {
    throw new Error("boom: orca unreachable");
  };
}

// 실 fs 대신 in-memory JSON 텍스트 하나로 dispatch-start observation store를
// 흉내낸다(§S11-1 -- 실 관제실 경로를 절대 건드리지 않는다). 여러 번의
// judgeDispatchStartForRepo/AcrossWorktrees/runOrchStallDetect 호출에
// **같은 fake store 객체**를 넘기면, 실제 15분 주기 예약 감시가 여러 번
// 도는 것과 동형으로 관측이 누적된다.
function fakeDispatchStartStore(initialText = null) {
  let stored = initialText;
  return {
    dispatchStartExistsFn: () => stored !== null,
    dispatchStartReadFn: () => stored,
    dispatchStartWriteFn: (_p, text) => {
      stored = text;
    },
    dispatchStartMkdirFn: () => {},
    peek: () => (stored === null ? null : JSON.parse(stored)),
  };
}

// ---------------------------------------------------------------------------
// judgeDispatchStartForRepo -- 5상태(NOT_APPLICABLE/NO_SEAT/JUDGED/
// COLLECTION_FAILED/STORE_FAILED)와, 수집/저장 실패가 "정상"·"시작 안
// 됨" 어느 쪽으로도 새지 않는지(coder-task.md §2-5).
// ---------------------------------------------------------------------------
const ACTIVE = [
  {
    path: ".harness/coder-task.md",
    droppedAtMs: Date.parse("2026-08-05T05:41:00+09:00"),
    resultFile: { exists: false },
  },
];

test("judgeDispatchStartForRepo: no active dispatch -> NOT_APPLICABLE, zero execFn calls", () => {
  const execFn = () => {
    throw new Error("must not be called");
  };
  const r = judgeDispatchStartForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: [], now: 1 },
    { execFn },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE);
});

test("judgeDispatchStartForRepo: active dispatch but zero seats found -> NO_SEAT (normal, not a failure)", () => {
  const execFn = fakeOrcaExecFn({ terminals: [] });
  const r = judgeDispatchStartForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: ACTIVE,
      now: Date.parse("2026-08-05T06:00:00+09:00"),
    },
    { execFn },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.NO_SEAT);
});

test("judgeDispatchStartForRepo: terminal-list query throws -> COLLECTION_FAILED, distinct from NO_SEAT", () => {
  const r = judgeDispatchStartForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: ACTIVE,
      now: Date.parse("2026-08-05T06:00:00+09:00"),
    },
    { execFn: throwingExecFn() },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.LIST_QUERY_FAILED,
  );
  assert.notEqual(r.status, DISPATCH_START_WIRE_STATUS.NO_SEAT);
});

test("judgeDispatchStartForRepo: observation store read throws (corrupt) -> STORE_FAILED, judgeDispatchStart is never called (수집 실패를 조용함으로 접지 않는다)", () => {
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_x: {
        ok: true,
        result: { terminal: { lastOutputAt: 1000, title: "CODER" } },
      },
    },
  });
  const r = judgeDispatchStartForRepo(
    {
      repoRoot: "C:/wt",
      droppedTaskFiles: ACTIVE,
      now: Date.parse("2026-08-05T06:00:00+09:00"),
    },
    {
      execFn,
      dispatchStartExistsFn: () => true,
      dispatchStartReadFn: () => {
        throw new Error("disk error");
      },
    },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.STORE_FAILED);
  assert.notEqual(r.status, DISPATCH_START_WIRE_STATUS.JUDGED);
});

// ---------------------------------------------------------------------------
// §R2(coder-task.md §R2, REVIEW P1 반려 수리) -- «실제 릴레이에서 판정
// 대상이 사라진다»: REVIEW 좌석은 시작 직후 결과 파일에 표지 3줄부터
// 먼저 쓰고 본문·`>>> DONE:` 줄은 나중에 쓴다. `resultFile.exists`
// 만으로 "끝났다"고 보면 그 구간에서 dispatch-start 축이 구조적으로
// 항상 NOT_APPLICABLE이 된다(REVIEW 실행 증거, coder-task.md §R2 그대로).
// ★2R 안에서 이 워크트리 자신을 대상으로 "실물 재확인"하다 재발견한 것:
// DONE 줄 존재만 보면 여전히 부족하다 -- 같은 결과 파일이 다음 라운드로
// 이어 쓰이므로, 이전 라운드의 낡은 DONE 줄이 새 라운드를 "이미 끝남"
// 으로 오판시킬 수 있다. 그래서 `resultFileDone`은 결과 파일 자신의
// `task_id:` 표지가 이번 배달과 일치할 때만 true다.
// ---------------------------------------------------------------------------
function runOrchStallDetectImport() {
  return import("./orch-stall-detect.mjs");
}

test("§R2 (a) selectActiveDispatchForStart: 결과 파일이 있어도 DONE 줄이 없으면 여전히 활성(«표지 3줄만 쓴» REVIEW 구간과 동형)", async () => {
  const { selectActiveDispatchForStart } = await runOrchStallDetectImport();
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: true },
      resultFileDone: false, // 표지 3줄만 있고 DONE 줄은 아직 없음.
    },
  ];
  assert.equal(selectActiveDispatchForStart(items), items[0]);
});

test("§R2 (a) selectActiveDispatchForStart: 결과 파일의 task_id가 이번 배달과 일치 + DONE 줄 있음 -> 진짜로 끝남(null, NOT_APPLICABLE)", async () => {
  const { selectActiveDispatchForStart } = await runOrchStallDetectImport();
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 1000,
      resultFile: { exists: true },
      resultFileDone: true,
    },
  ];
  assert.equal(selectActiveDispatchForStart(items), null);
});

test("§R2 (a)★ 낡은 DONE 줄(이전 라운드 잔재): resultFileDone은 task_id 불일치 시 false여야 한다 -- 재작업 라운드가 이미 끝난 것으로 새지 않는다", async () => {
  const { selectActiveDispatchForStart } = await runOrchStallDetectImport();
  // collectResultFileCompletion 자신을 직접 시험하지 않고(내부 비export
  // 함수), 결선을 통해 나온 resultFileDone 계약(이전 라운드 task_id와
  // 다르면 false)을 그대로 표현한 fixture로 회귀를 고정한다.
  const items = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: 2000,
      resultFile: { exists: true },
      // 이전 라운드(HYK-185-startcheck-wire-1)의 DONE 줄은 남아 있지만
      // 이번 라운드(HYK-185-startcheck-wire-2)와 task_id가 다르므로,
      // collectResultFileCompletion은 이 경우 false를 낸다(§검증 참조).
      resultFileDone: false,
    },
  ];
  assert.equal(selectActiveDispatchForStart(items), items[0]);
});

test("§R2 (b)★ e2e: 결과 파일에 표지 3줄(REVIEW 위조 검증 규칙과 동형)만 있고 DONE 줄이 없으면, dispatchStart·seatLiveness 두 축 모두 여전히 활성으로 본다(HYK-201부터 seatLiveness도 같은 정의를 공유한다 -- coder-task.md §2)", () => {
  withTempDir("hyk185-start-r2-inflight-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-2",
      droppedAt: "2026-08-05 13:54",
    });
    // REVIEW가 시작 직후 먼저 쓰는 표지 3줄만 있고 본문·DONE 줄은 아직
    // 없다(coder-task.md §R2가 재현한 실물 형태 그대로).
    writeFileSync(
      join(dir, ".harness", "coder.md"),
      "dispatch_verified: yes\ntask_id_from_dispatch: task_x\npane_match: a == a ? 일치\n\nfor: ORCH\nrole: CODER\ntask_id: HYK-185-startcheck-wire-2\nverdict: IN_PROGRESS\n",
      "utf8",
    );
    const now = Date.parse("2026-08-05T13:56:00+09:00");
    const worktreePath = gitWorktreeSelfPath(dir);
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_inflight", worktreePath }],
      showsByHandle: {
        term_inflight: {
          ok: true,
          result: {
            terminal: { lastOutputAt: now - 30_000, title: "CODER" },
          },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.notEqual(
      result.dispatchStart.status,
      DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE,
      "결과 파일이 있어도(표지 3줄뿐) DONE 줄이 없으면 dispatch-start 축은 여전히 판정 대상이어야 한다(§R2 핵심)",
    );
    // HYK-201부터 seat-liveness 축도 같은 정의(resultFileDone)를 쓴다 --
    // 결과 파일이 있어도(표지 3줄뿐) DONE 줄이 없으면 이 축도 여전히
    // 판정 대상이다(§1-§2, PR #113이 미룬 결함을 이 라운드가 갚는다).
    assert.notEqual(
      result.seatLiveness.status,
      "SEAT_LIVENESS_NOT_APPLICABLE",
      "seat-liveness 축도 표지만 쓰인 구간에서 여전히 활성으로 판정해야 한다(HYK-201)",
    );
  });
});

test("§R2 (c)★ e2e: 결과 파일의 task_id가 이번 배달과 일치 + 실제 `>>> DONE:` 줄 존재 -> 진짜로 끝난 배달은 dispatchStart도 NOT_APPLICABLE로 정확히 접힌다(오탐 0)", () => {
  withTempDir("hyk185-start-r2-done-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-2",
      droppedAt: "2026-08-05 13:54",
    });
    writeFileSync(
      join(dir, ".harness", "coder.md"),
      "dispatch_verified: yes\ntask_id_from_dispatch: task_x\npane_match: a == a ? 일치\n\nfor: ORCH\nrole: CODER\ntask_id: HYK-185-startcheck-wire-2\nverdict: DONE\n\n>>> DONE: CODER @ 2026-08-05 14:10 KST\n",
      "utf8",
    );
    const now = Date.parse("2026-08-05T14:20:00+09:00");
    const execFn = () => {
      throw new Error("must not be called -- truly completed, not active");
    };
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn },
    );
    assert.equal(
      result.dispatchStart.status,
      DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE,
    );
  });
});

test("§R2 (d)★ e2e: 이전 라운드의 낡은 DONE 줄(다른 task_id) -- 새 라운드가 «이미 끝남»으로 오판되지 않는다", () => {
  withTempDir("hyk185-start-r2-stale-", (dir) => {
    initPlainGitRepo(dir);
    // 이번 배달(2라운드)이 드롭됐다.
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-2",
      droppedAt: "2026-08-05 13:54",
    });
    // 그런데 결과 파일에는 **1라운드**의 DONE 줄이 아직 남아 있다(같은
    // 파일을 이어 쓰는 관례, coder-task.md §5) -- task_id가 다르다.
    writeFileSync(
      join(dir, ".harness", "coder.md"),
      "dispatch_verified: yes\ntask_id_from_dispatch: task_x\npane_match: a == a ? 일치\n\nfor: ORCH\nrole: CODER\ntask_id: HYK-185-startcheck-wire-1\nverdict: DONE\n\n>>> DONE: CODER @ 2026-08-05 12:40 KST\n",
      "utf8",
    );
    const now = Date.parse("2026-08-05T13:56:00+09:00");
    const worktreePath = gitWorktreeSelfPath(dir);
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_stale", worktreePath }],
      showsByHandle: {
        term_stale: {
          ok: true,
          result: { terminal: { lastOutputAt: now - 30_000, title: "CODER" } },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.notEqual(
      result.dispatchStart.status,
      DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE,
      "낡은(다른 라운드) DONE 줄이 새 라운드를 이미 끝난 것으로 오판시키면 안 된다",
    );
  });
});

// ---------------------------------------------------------------------------
// (a)★ 오늘의 실제 사고를 표본으로: 배달 05:41 -> 첫 활동 09:10, 결과
// 파일 없음, 3.4시간(=12,600초) 경과. 두 번의 watch tick(예약 감시가
// 실제로 15분 주기로 여러 번 도는 것과 동형)을 같은 fake store로 이어
// 붙여, judgeDispatchStart가 실제로 «시작 안 됨»으로 발화하는지를 결선된
// 경로에서 본다.
// ---------------------------------------------------------------------------
test("(a)★ 오늘의 3.4시간 미시작 사고: tick1(배달 직후 붙여넣기 메아리) -> tick2(3.4시간 뒤, 여전히 무진행) -> NOT_STARTED (실제로 발화한다)", () => {
  const dispatchedAtMs = Date.parse("2026-08-05T05:41:00+09:00");
  const echoAt = dispatchedAtMs; // 배달 직후 붙여넣기 메아리(진전 아님).
  const tick1At = dispatchedAtMs + 30_000; // 배달 30초 후 -- 첫 watch tick.
  const tick2At = Date.parse("2026-08-05T09:10:00+09:00"); // 실제 첫 활동(발견) 시각.
  const active = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: dispatchedAtMs,
      resultFile: { exists: false },
    },
  ];
  const store = fakeDispatchStartStore();

  const tick1 = judgeDispatchStartForRepo(
    { repoRoot: "C:/wt-stall", droppedTaskFiles: active, now: tick1At },
    {
      execFn: fakeOrcaExecFn({
        terminals: [{ handle: "term_stall", worktreePath: "C:/wt-stall" }],
        showsByHandle: {
          term_stall: {
            ok: true,
            result: { terminal: { lastOutputAt: echoAt, title: "CODER" } },
          },
        },
      }),
      ...store,
    },
  );
  // 관측 1건뿐이라 아직 비교할 두 번째 점이 없다 -- 코어 자신의 계약
  // (dispatch-start-core.mjs)대로 UNDECIDABLE로 보류돼야 한다.
  assert.equal(tick1.status, DISPATCH_START_WIRE_STATUS.JUDGED);
  assert.equal(tick1.verdict, DISPATCH_START_VERDICT.UNDECIDABLE);

  const tick2 = judgeDispatchStartForRepo(
    { repoRoot: "C:/wt-stall", droppedTaskFiles: active, now: tick2At },
    {
      execFn: fakeOrcaExecFn({
        terminals: [{ handle: "term_stall", worktreePath: "C:/wt-stall" }],
        showsByHandle: {
          // 3.4시간 뒤에도 여전히 같은 lastOutputAt -- 무진행.
          term_stall: {
            ok: true,
            result: { terminal: { lastOutputAt: echoAt, title: "CODER" } },
          },
        },
      }),
      ...store,
    },
  );
  assert.equal(tick2.status, DISPATCH_START_WIRE_STATUS.JUDGED);
  assert.equal(tick2.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
  // 인용: coder.md §3-a 합격 기준의 근거 산출물.
  console.log(
    "HYK-185-startcheck-wire (a) quote:",
    JSON.stringify({ tick1: tick1.verdict, tick2 }),
  );
});

// ---------------------------------------------------------------------------
// (b) 반대 방향: 정상 배달(배달 직후 곧 실제 진전이 있는 좌석) -- 같은
// 입력 형태에서 경과·활동 유무만 바꿔 STARTED로 뒤집힌다(오탐 0).
// ---------------------------------------------------------------------------
test("(b) 정상 배달(같은 입력, 진전만 있음): tick1 -> tick2(짧은 경과, lastOutputAt이 실제로 전진) -> STARTED (오탐 0)", () => {
  const dispatchedAtMs = Date.parse("2026-08-05T05:41:00+09:00");
  const tick1At = dispatchedAtMs + 30_000;
  const tick2At = dispatchedAtMs + 90_000; // 배달 90초 후 -- 여전히 이른 시각.
  const active = [
    {
      path: ".harness/coder-task.md",
      droppedAtMs: dispatchedAtMs,
      resultFile: { exists: false },
    },
  ];
  const store = fakeDispatchStartStore();

  judgeDispatchStartForRepo(
    { repoRoot: "C:/wt-normal", droppedTaskFiles: active, now: tick1At },
    {
      execFn: fakeOrcaExecFn({
        terminals: [{ handle: "term_normal", worktreePath: "C:/wt-normal" }],
        showsByHandle: {
          term_normal: {
            ok: true,
            result: {
              terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" },
            },
          },
        },
      }),
      ...store,
    },
  );
  const tick2 = judgeDispatchStartForRepo(
    { repoRoot: "C:/wt-normal", droppedTaskFiles: active, now: tick2At },
    {
      execFn: fakeOrcaExecFn({
        terminals: [{ handle: "term_normal", worktreePath: "C:/wt-normal" }],
        showsByHandle: {
          // 실제로 새 출력이 있었다(전진) -- 코딩 중.
          term_normal: {
            ok: true,
            result: {
              terminal: { lastOutputAt: tick2At - 5_000, title: "CODER" },
            },
          },
        },
      }),
      ...store,
    },
  );
  assert.equal(tick2.status, DISPATCH_START_WIRE_STATUS.JUDGED);
  assert.equal(tick2.verdict, DISPATCH_START_VERDICT.STARTED);
  assert.notEqual(tick2.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
});

// ---------------------------------------------------------------------------
// (c) 결선 실증: orch-stall-detect(runOrchStallDetect)를 직접 돌려 새
// 필드(result.dispatchStart)가 채워지는 것을 출력으로 인용한다.
// ---------------------------------------------------------------------------
test("(c)★ runOrchStallDetect end-to-end: 활성 배달 + 관측 2틱 -> result.dispatchStart가 JUDGED/NOT_STARTED로 채워진다(결선이 실재한다)", () => {
  withTempDir("hyk185-start-wire-e2e-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-1",
      droppedAt: "2026-08-05 05:41",
    });
    const dispatchedAtMs = Date.parse("2026-08-05T05:41:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-08-05T09:10:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };

    runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(tick1At).toISOString(), "--json"],
      {
        execFn: fakeOrcaExecFn({
          terminals: [{ handle: "term_e2e", worktreePath }],
          showsByHandle: { term_e2e: showStub },
        }),
        ...store,
      },
    );
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(tick2At).toISOString(), "--json"],
      {
        execFn: fakeOrcaExecFn({
          terminals: [{ handle: "term_e2e", worktreePath }],
          showsByHandle: { term_e2e: showStub }, // lastOutputAt 그대로 -- 무진행.
        }),
        ...store,
      },
    );
    assert.ok(result.dispatchStart, "result.dispatchStart must be present");
    assert.equal(
      result.dispatchStart.status,
      DISPATCH_START_WIRE_STATUS.JUDGED,
      "judgeDispatchStart must actually have been called",
    );
    assert.equal(
      result.dispatchStart.verdict,
      DISPATCH_START_VERDICT.NOT_STARTED,
    );
    // 인용: coder.md §4-1 합격 기준 (c)의 근거 산출물.
    console.log(
      "HYK-185-startcheck-wire (c) quote: result.dispatchStart =",
      JSON.stringify(result.dispatchStart),
    );
  });
});

test("(c) runOrchStallDetect end-to-end: no --repo-root worktree seat at all -> result.dispatchStart.status is NO_SEAT (still surfaced, not silently omitted)", () => {
  withTempDir("hyk185-start-wire-e2e-noseat-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-1",
      droppedAt: "2026-08-05 05:41",
    });
    const now = Date.parse("2026-08-05T05:50:00+09:00");
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn: fakeOrcaExecFn({ terminals: [] }) },
    );
    assert.equal(
      result.dispatchStart.status,
      DISPATCH_START_WIRE_STATUS.NO_SEAT,
    );
  });
});

test("(c) runOrchStallDetect end-to-end: no active dispatch -> result.dispatchStart.status NOT_APPLICABLE, zero execFn calls", () => {
  withTempDir("hyk185-start-wire-e2e-na-", (dir) => {
    initPlainGitRepo(dir);
    const execFn = () => {
      throw new Error("must not be called -- no active dispatch to check");
    };
    const { result } = runOrchStallDetect(["--repo-root", dir, "--json"], {
      execFn,
    });
    assert.equal(
      result.dispatchStart.status,
      DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE,
    );
  });
});

// ---------------------------------------------------------------------------
// (d) 회귀 0: 기존 seatLiveness/seatIdle이 여전히 채워진다(이 축을
// 추가했다고 기존 두 축이 사라지거나 형태가 바뀌지 않는다).
// ---------------------------------------------------------------------------
test("(d) runOrchStallDetect end-to-end: 새 dispatchStart 축을 추가해도 기존 seatLiveness/seatIdle 필드는 그대로 채워진다(회귀 0)", () => {
  withTempDir("hyk185-start-wire-regress-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-1",
      droppedAt: "2026-08-05 05:41",
    });
    const now = Date.parse("2026-08-05T05:50:00+09:00");
    const worktreePath = gitWorktreeSelfPath(dir);
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_regress", worktreePath }],
      showsByHandle: {
        term_regress: {
          ok: true,
          result: { terminal: { lastOutputAt: now - 60_000, title: "CODER" } },
        },
      },
    });
    const { result } = runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.equal(result.seatLiveness.status, "SEAT_LIVENESS_JUDGED");
    assert.equal(result.seatIdle.status, "SEAT_IDLE_NOT_APPLICABLE");
    assert.ok(result.dispatchStart);
  });
});

// ---------------------------------------------------------------------------
// 다중 워크트리 스캔(gap#78 열거 재사용) + 워크트리 열거/harness 읽기 실패.
// ---------------------------------------------------------------------------
test("judgeDispatchStartAcrossWorktrees: git worktree list 자체가 실패 -> WORKTREE_LIST_FAILED(판정 불가), NOT_APPLICABLE로 접히지 않는다", () => {
  const r = judgeDispatchStartAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git not found");
      },
    },
  );
  assert.equal(r.status, DISPATCH_START_SCAN_FAILURE.WORKTREE_LIST_FAILED);
  assert.notEqual(r.status, DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE);
});

test("judgeDispatchStartAcrossWorktrees: 개별 워크트리 .harness 읽기 실패 -> HARNESS_READ_FAILED(판정 불가), 좌석 조회조차 시도하지 않는다", () => {
  const r = judgeDispatchStartAcrossWorktrees(
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
  assert.equal(r.status, DISPATCH_START_SCAN_FAILURE.HARNESS_READ_FAILED);
  assert.notEqual(r.status, DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE);
});

// ---------------------------------------------------------------------------
// production 기본값: opts를 안 주면 createOrcaExecFn()(실 spawn)이 기본값.
// ---------------------------------------------------------------------------
test("static: judgeDispatchStartForRepo defaults opts.execFn to createOrcaExecFn() when the caller doesn't override it (production wiring is live, not opt-in)", () => {
  const src = readFileSync(join(THIS_DIR, "orch-stall-detect.mjs"), "utf8");
  const section = src.slice(
    src.indexOf("export function judgeDispatchStartForRepo"),
    src.indexOf("export const DISPATCH_START_SCAN_SEVERITY"),
  );
  assert.match(
    section,
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
  const mutantDir = mkdtempSync(
    join(tmpdir(), `hyk185-start-mutant-${label}-`),
  );
  const mutantPath = join(mutantDir, "orch-stall-detect.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

test("NC mutation/start-wire #1 (필수): 결선 제거(코어를 부르지 않게) -> RED (오늘의 3.4시간 미시작 사고인데도 NOT_STARTED가 되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const dispatchStart = judgeDispatchStartAcrossWorktrees(\n    { repoRoot, now },\n    opts,\n  );",
        "  const dispatchStart = { status: DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE };",
      ),
    "1",
  );
  await withTempDir("hyk185-start-mutant1-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-1",
      droppedAt: "2026-08-05 05:41",
    });
    const dispatchedAtMs = Date.parse("2026-08-05T05:41:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    mutant.runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(dispatchedAtMs + 30_000).toISOString(),
        "--json",
      ],
      {
        execFn: fakeOrcaExecFn({
          terminals: [{ handle: "term_x", worktreePath }],
          showsByHandle: { term_x: showStub },
        }),
        ...store,
      },
    );
    const { result } = mutant.runOrchStallDetect(
      [
        "--repo-root",
        dir,
        "--now",
        new Date(Date.parse("2026-08-05T09:10:00+09:00")).toISOString(),
        "--json",
      ],
      {
        execFn: fakeOrcaExecFn({
          terminals: [{ handle: "term_x", worktreePath }],
          showsByHandle: { term_x: showStub },
        }),
        ...store,
      },
    );
    assert.equal(
      result.dispatchStart.status,
      "DISPATCH_START_NOT_APPLICABLE",
      "mutant must never actually judge the real 3.4h stall (RED signal; proves the wiring call is load-bearing)",
    );
  });
});

test("NC mutation/start-wire #2 (필수): 수집 실패를 «조용함»(NO_SEAT)으로 접기 -> RED (조회 실패가 정상 무좌석과 구별되지 않는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!observed.ok) {
    return {
      status: DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
      dispatch,
      ...(correlation ? { correlation } : {}),
    };
  }`,
        `  if (!observed.ok) {
    return { status: DISPATCH_START_WIRE_STATUS.NO_SEAT, dispatch };
  }`,
      ),
    "2",
  );
  const r = mutant.judgeDispatchStartForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: ACTIVE, now: 2_000_000_000_000 },
    { execFn: throwingExecFn() },
  );
  assert.equal(
    r.status,
    "DISPATCH_START_NO_SEAT",
    "mutant must misjudge a real query failure as 'no seat, normal' (RED signal; proves the COLLECTION_FAILED branch is load-bearing)",
  );
});

test("NC mutation/start-wire #3 (필수): store 저장 실패를 무시하고 그대로 판정 -> RED (누적되지 않은 관측 1건만으로 판정을 지어낸다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!saved.ok) {
    return {
      status: DISPATCH_START_WIRE_STATUS.STORE_FAILED,
      reason: saved.reason,
      dispatch,
    };
  }`,
        `  // saved.ok ignored on purpose (mutant).`,
      ),
    "3",
  );
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath: "C:/wt" }],
    showsByHandle: {
      term_x: {
        ok: true,
        result: { terminal: { lastOutputAt: 1_000_000, title: "CODER" } },
      },
    },
  });
  const r = mutant.judgeDispatchStartForRepo(
    { repoRoot: "C:/wt", droppedTaskFiles: ACTIVE, now: 2_000_000_000_000 },
    {
      execFn,
      dispatchStartExistsFn: () => false,
      dispatchStartWriteFn: () => {
        throw new Error("disk full");
      },
    },
  );
  assert.notEqual(
    r.status,
    "DISPATCH_START_STORE_FAILED",
    "mutant must silently proceed to judge despite the store write failure (RED signal; proves the STORE_FAILED branch is load-bearing, coder-task.md §2-5)",
  );
});

test("NC mutation/start-wire #4 (필수): 워크트리 열거 실패를 «조용함»(NOT_APPLICABLE)으로 접기 -> RED", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (!list.ok) {
    return {
      status: DISPATCH_START_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }`,
        `  if (!list.ok) {
    return {
      status: DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 0,
    };
  }`,
      ),
    "4",
  );
  const r = mutant.judgeDispatchStartAcrossWorktrees(
    { repoRoot: "C:/wt", now: 1000 },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("git not found");
      },
    },
  );
  assert.equal(
    r.status,
    "DISPATCH_START_NOT_APPLICABLE",
    "mutant must misreport a real enumeration failure as 'nothing to judge, normal' (RED signal; proves the WORKTREE_LIST_FAILED branch is load-bearing)",
  );
});

test("NC mutation/start-wire #5 (필수, §R2): «결과 파일 존재만으로 끝났다고 되돌리기» -> RED (표지 3줄만 있는 REVIEW 구간이 다시 NOT_APPLICABLE로 샌다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  return item.resultFileDone !== true;",
        "  return false;",
      ),
    "5",
  );
  await withTempDir("hyk185-start-mutant5-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-185-startcheck-wire-2",
      droppedAt: "2026-08-05 13:54",
    });
    // 표지 3줄만 있고 DONE 줄은 없다(REVIEW P1이 재현한 실물 형태).
    writeFileSync(
      join(dir, ".harness", "coder.md"),
      "dispatch_verified: yes\ntask_id_from_dispatch: task_x\npane_match: a == a ? 일치\n\nfor: ORCH\nrole: CODER\ntask_id: HYK-185-startcheck-wire-2\nverdict: IN_PROGRESS\n",
      "utf8",
    );
    const now = Date.parse("2026-08-05T13:56:00+09:00");
    const worktreePath = gitWorktreeSelfPath(dir);
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: {
        term_x: {
          ok: true,
          result: { terminal: { lastOutputAt: now - 30_000, title: "CODER" } },
        },
      },
    });
    const { result } = mutant.runOrchStallDetect(
      ["--repo-root", dir, "--now", new Date(now).toISOString(), "--json"],
      { execFn, ...fakeDispatchStartStore() },
    );
    assert.equal(
      result.dispatchStart.status,
      "DISPATCH_START_NOT_APPLICABLE",
      "mutant must regress to REVIEW's exact P1 repro (result-file-exists alone means 'done') -- RED signal proving the resultFileDone/task_id-match check is load-bearing (coder-task.md §R2)",
    );
  });
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
    "dispatch-start-wire.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "dispatch-start-wire.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
