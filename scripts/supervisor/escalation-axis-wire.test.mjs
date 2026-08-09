// HYK-173-push-wire (coder-task.md §7) -- escalation 축 결선 계약 시험.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 여기 fixture(terminal list/orchestration check --peek 응답)는 §2 S1
//    실측 필드 구성을 그대로 옮긴 것이다(id/sequence/read/payload(JSON
//    문자열)/from_handle/to_handle/subject/body/type/created_at/
//    delivered_at/sender_pane_key) -- 헤더에서 "기대 형태"를 역산해 만든
//    가짜가 아니다(§8-1 비타협).
// 2. 시험은 실제 orca를 부르지 않는다(execFn 전부 주입) -- 실 터미널·
//    실 인박스를 이 시험이 접촉하지 않는다.
// 3. §7 변조 7건의 "RED 확인"은 이 파일이 자동으로 수행하지 않는다 --
//    이 파일은 "정상 구현이 통과한다"는 회귀 고정이고, 변조→RED 확인은
//    coder.md에 기록된 수동 절차(변조 적용 -> 이 시험 실행 -> 실패 확인
//    -> 원복)다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  judgeEscalationForRepo,
  runOrchStallDetect,
} from "./orch-stall-detect.mjs";
import {
  buildLogLine,
  computeEscalationNotifications,
  runWatchOnce,
} from "./watch-run.mjs";
import { COORD_STATE } from "../relay/escalation-state.mjs";
import { AXES, parseLogLine } from "./reach-report-core.mjs";
import { scanRepoForOrcaExecCalls } from "../check/orca-cli-boundary.mjs";

const MAIN_REPO_PATH_BACKSLASH_TRAILING =
  "C:\\Users\\Administrator\\Documents\\HARNESSENGINEERING\\";

// §2 S1 실측 그대로 -- coder-task.md §2 표 그대로 옮긴 필드 구성.
function s1Message({
  id = "msg_af9ea4ada7f7",
  sequence = 529,
  taskId = "task_X",
  dispatchId = "ctx_X",
  type = "escalation",
  subject = "worker blocked",
  body = "cannot proceed without human decision",
} = {}) {
  return {
    id,
    sequence,
    read: 0,
    payload: JSON.stringify({ taskId, dispatchId }),
    from_handle: "term_worker",
    to_handle: "term_coordinator",
    subject,
    body,
    type,
    created_at: "2026-08-09T12:00:00.000Z",
    delivered_at: null,
    sender_pane_key: "pane_abcdef01:leaf_23456789",
  };
}

function fakeOrcaExecFn({
  terminals = [
    {
      handle: "term_coordinator",
      worktreePath: MAIN_REPO_PATH_BACKSLASH_TRAILING,
    },
  ],
  messages = [],
  listThrows = false,
  peekOk = true,
  peekThrows = false,
} = {}) {
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      if (listThrows) throw new Error("boom: terminal list unreachable");
      return { ok: true, result: { terminals } };
    }
    if (argv[0] === "orchestration" && argv[1] === "check") {
      if (peekThrows) throw new Error("boom: peek unreachable");
      if (!peekOk) return { ok: false };
      return { ok: true, result: { messages, count: messages.length } };
    }
    throw new Error(`fakeOrcaExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}

// ---------------------------------------------------------------------------
// judgeEscalationForRepo -- 기본 판정(§5-C 실호출 결과)
// ---------------------------------------------------------------------------

test("judgeEscalationForRepo: no escalation messages -> OK/no wake, worstCount 0 (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    { execFn: fakeOrcaExecFn({ messages: [] }) },
  );
  assert.equal(result.status, "ESCALATION_OK");
  assert.equal(result.worstCount, 0);
  assert.equal(result.totalWorktrees, 0);
  assert.deepEqual(result.scopes, []);
});

test("judgeEscalationForRepo: a live escalation message (S1 shape) -> wake via reduceCoordinatorState/shouldWakeHuman (real values, not hardcoded) (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    { execFn: fakeOrcaExecFn({ messages: [s1Message()] }) },
  );
  assert.equal(result.status, "ESCALATION_OK");
  assert.equal(result.worstCount, 1);
  assert.equal(result.totalWorktrees, 1);
  // §5-C: verdict는 reduceCoordinatorState가 실제로 계산한 state다 --
  // scopedNeedsInput=true, handshake 없음 -> NEEDS_INPUT(고정값 아님).
  assert.equal(result.verdict, COORD_STATE.NEEDS_INPUT);
  const scope = result.scopes[0];
  assert.equal(scope.state, COORD_STATE.NEEDS_INPUT);
  assert.equal(scope.wakeHuman, true);
  // S1 안정 식별자(sequence 우선)가 dedupe 재료로 그대로 실린다.
  assert.equal(scope.transitionId, "529");
  assert.equal(scope.dedupeKey, "task_X:ctx_X:NEEDS_INPUT");
});

test("judgeEscalationForRepo: non-escalation types (worker_done) are not counted as escalation (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    {
      execFn: fakeOrcaExecFn({
        messages: [s1Message({ type: "worker_done", id: "msg_wd1" })],
      }),
    },
  );
  assert.equal(result.worstCount, 0);
  assert.deepEqual(result.scopes, []);
});

test("judgeEscalationForRepo: two distinct scopes (different taskId/dispatchId) are both surfaced (worstCount denominator=2) (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    {
      execFn: fakeOrcaExecFn({
        messages: [
          s1Message({ id: "msg_1", sequence: 1, taskId: "task_A" }),
          s1Message({ id: "msg_2", sequence: 2, taskId: "task_B" }),
        ],
      }),
    },
  );
  assert.equal(result.worstCount, 2);
  assert.equal(result.totalWorktrees, 2);
});

// ---------------------------------------------------------------------------
// §5-A ★실패 삼킴 금지 -- 조회 실패(throw/ok:false)는 「신호 0 = 정상」이
// 아니라 ESCALATION_COLLECTION_FAILED로 표면화되고, verdict는
// reduceCoordinatorState({events:{supervisorFault:true}})가 실제로 계산한
// SUPERVISOR_FAULT다(고정 문자열이 아니다 -- §7 변조 2/3의 표적).
// ---------------------------------------------------------------------------

test("§5-A: terminal list query throws -> ESCALATION_COLLECTION_FAILED / SUPERVISOR_FAULT, not silent zero (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    { execFn: fakeOrcaExecFn({ listThrows: true }) },
  );
  assert.equal(result.status, "ESCALATION_COLLECTION_FAILED");
  assert.equal(result.verdict, COORD_STATE.SUPERVISOR_FAULT);
  assert.equal(typeof result.reason, "string");
});

test("§5-A: peek query throws -> ESCALATION_COLLECTION_FAILED / SUPERVISOR_FAULT (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    { execFn: fakeOrcaExecFn({ peekThrows: true }) },
  );
  assert.equal(result.status, "ESCALATION_COLLECTION_FAILED");
  assert.equal(result.verdict, COORD_STATE.SUPERVISOR_FAULT);
});

test("§5-A: peek query returns ok:false -> ESCALATION_COLLECTION_FAILED (not swallowed as signals:[]) (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    { execFn: fakeOrcaExecFn({ peekOk: false }) },
  );
  assert.equal(result.status, "ESCALATION_COLLECTION_FAILED");
});

// ---------------------------------------------------------------------------
// §5-B ★handle을 박지 않는다 -- 매 실행 terminal list에서 새로 해석하고,
// 해석한 handle이 지금 이 순간의 살아있는 좌석 목록에 실제로 있는지
// 대조한다(후보 0개/2개+는 실패). S3 비타협: 낡은 handle -> count:0을
// "정상"으로 접지 않는다.
// ---------------------------------------------------------------------------

test("§5-B: 0 seats registered at MAIN_REPO_PATH -> COLLECTION_FAILED, NOT a quiet 'no escalation' (S3 비타협) (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    { execFn: fakeOrcaExecFn({ terminals: [] }) },
  );
  assert.equal(result.status, "ESCALATION_COLLECTION_FAILED");
  assert.match(result.reason, /found 0/);
});

test("§5-B: 2+ seats registered at MAIN_REPO_PATH (ambiguous) -> COLLECTION_FAILED, refuses to guess (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    {
      execFn: fakeOrcaExecFn({
        terminals: [
          { handle: "a", worktreePath: MAIN_REPO_PATH_BACKSLASH_TRAILING },
          { handle: "b", worktreePath: MAIN_REPO_PATH_BACKSLASH_TRAILING },
        ],
      }),
    },
  );
  assert.equal(result.status, "ESCALATION_COLLECTION_FAILED");
  assert.match(result.reason, /found 2/);
});

test("§5-B: a seat at a DIFFERENT worktree (not MAIN_REPO_PATH) does not count as the coordinator seat -> COLLECTION_FAILED (0 candidates), not a false match (1/1)", () => {
  const result = judgeEscalationForRepo(
    { now: Date.parse("2026-08-09T12:00:00.000Z") },
    {
      execFn: fakeOrcaExecFn({
        terminals: [{ handle: "x", worktreePath: "C:/some/other/worktree" }],
      }),
    },
  );
  assert.equal(result.status, "ESCALATION_COLLECTION_FAILED");
});

// ---------------------------------------------------------------------------
// 생산 진입점(§1 요건1) -- runOrchStallDetect가 escalation 축을 실제로
// 조립해 result.escalation에 싣는다("배선 절단" 변조[§7-1]의 표적).
// ---------------------------------------------------------------------------

function initPlainGitRepo(dir) {
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "--quiet", "-b", "main"]);
  git([
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

test("production entry point: runOrchStallDetect includes result.escalation from the real axis assembly (repo-root argv path, --json) (1/1)", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "hyk173-orch-"));
  try {
    initPlainGitRepo(dir);
    const { result } = runOrchStallDetect(["--repo-root", dir, "--json"], {
      execFn: fakeOrcaExecFn({ messages: [s1Message()] }),
    });
    assert.ok(result.escalation, "result.escalation must be present");
    assert.equal(result.escalation.worstCount, 1);
    assert.equal(result.escalation.verdict, COORD_STATE.NEEDS_INPUT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("static: orch-stall-detect.mjs's new escalation axis still spawns 'orca' only through the adapter (G9 regression guard) (1/1)", () => {
  const violations = scanRepoForOrcaExecCalls();
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// watch-run.mjs buildLogLine -- escalation_* 4필드 관례(§4 요건2), 값은
// 실제 계산 결과다("판정값 미사용" 변조[§7-2]의 표적: 이 시험은 verdict가
// COLLECTION_FAILED 경로에서는 SUPERVISOR_FAULT, wake 경로에서는
// NEEDS_INPUT으로 서로 다르게 나오는 것을 직접 단언한다 -- 고정 문자열로
// 바꿔치기하면 이 두 시험 중 하나는 반드시 깨진다).
// ---------------------------------------------------------------------------

test("buildLogLine: escalation segment follows the 4-field axisLogSegment convention and carries the REAL computed verdict (wake case) (1/1)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      escalationStatus: "ESCALATION_OK",
      escalationVerdict: COORD_STATE.NEEDS_INPUT,
      escalationWorstCount: 1,
      escalationTotalWorktrees: 1,
      escalationScopes: [
        {
          scope: { taskId: "task_X", dispatchId: "ctx_X" },
          state: COORD_STATE.NEEDS_INPUT,
          dedupeKey: "task_X:ctx_X:NEEDS_INPUT",
          transitionId: "529",
          wakeHuman: true,
          sampleSubject: "worker blocked",
          sampleBody: "cannot proceed",
        },
      ],
    },
  });
  assert.match(line, /escalation_status=ESCALATION_OK/);
  assert.match(
    line,
    new RegExp(`escalation_verdict=${COORD_STATE.NEEDS_INPUT}`),
  );
  assert.match(line, /escalation_worst_count=1/);
  assert.match(line, /escalation_worktrees=1/);
  assert.match(line, /escalation_open=1/);
  assert.match(line, /task_X\/ctx_X:worker_blocked/);
});

test("buildLogLine: escalation segment defaults to NONE fields when detectorResult carries no escalation data (regression: old detector payloads still parse) (1/1)", () => {
  const line = buildLogLine({
    nowIso: "2026-08-09T12:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
    },
  });
  assert.match(line, /escalation_status=NONE/);
  assert.match(line, /escalation_verdict=NONE/);
  assert.equal(line.includes("escalation_open="), false);
});

// ---------------------------------------------------------------------------
// §5-D dedupe -- computeEscalationNotifications는 shouldNotify를 "실제로"
// 부른다. 같은 메시지(같은 id/sequence)가 재등장하면 통지 정확히 1회,
// 같은 스코프에 새 메시지(새 id/sequence)가 오면 다시 통지된다(N1,
// escalation-state.mjs 헤더 주석 그대로). §7-6의 표적.
// ---------------------------------------------------------------------------

test("§5-D dedupe: same message (same id/sequence) across two ticks -> notified exactly once (1/1)", () => {
  const scope1 = {
    scope: { taskId: "task_X", dispatchId: "ctx_X" },
    state: COORD_STATE.NEEDS_INPUT,
    dedupeKey: "task_X:ctx_X:NEEDS_INPUT",
    transitionId: "529",
    wakeHuman: true,
  };
  const tick1 = computeEscalationNotifications({
    scopes: [scope1],
    priorNotifiedKeys: [],
  });
  assert.equal(tick1.newlyNotified.length, 1);
  const tick2 = computeEscalationNotifications({
    scopes: [scope1],
    priorNotifiedKeys: tick1.nextKeys,
  });
  assert.equal(
    tick2.newlyNotified.length,
    0,
    "same escalation must not renotify while unchanged",
  );
});

test("§5-D dedupe: same dedupeKey but a NEW message id (recover-then-restall) -> notified again (N1, transitionId must be part of the key) (1/1)", () => {
  const scope1 = {
    scope: { taskId: "task_X", dispatchId: "ctx_X" },
    state: COORD_STATE.NEEDS_INPUT,
    dedupeKey: "task_X:ctx_X:NEEDS_INPUT",
    transitionId: "529",
    wakeHuman: true,
  };
  const tick1 = computeEscalationNotifications({
    scopes: [scope1],
    priorNotifiedKeys: [],
  });
  const scope2 = { ...scope1, transitionId: "530" };
  const tick2 = computeEscalationNotifications({
    scopes: [scope2],
    priorNotifiedKeys: tick1.nextKeys,
  });
  assert.equal(
    tick2.newlyNotified.length,
    1,
    "a genuinely new escalation instance (new id) under the same scope must notify again",
  );
});

test("§5-D dedupe: non-wake scopes are never notify candidates (1/1)", () => {
  const scope1 = {
    scope: { taskId: "task_X", dispatchId: "ctx_X" },
    state: COORD_STATE.DONE_PENDING_HANDSHAKE,
    dedupeKey: "task_X:ctx_X:DONE_PENDING_HANDSHAKE",
    transitionId: "1",
    wakeHuman: false,
  };
  const tick1 = computeEscalationNotifications({
    scopes: [scope1],
    priorNotifiedKeys: [],
  });
  assert.equal(tick1.newlyNotified.length, 0);
});

// ---------------------------------------------------------------------------
// §4 요건3 (최대 함정) -- AXES 등록 + 실제 reach-notify-*.md 생성.
// runWatchOnce 전체 결선(사람이 칠 수 있는 한 줄, §4 요건1과 동일 함수)을
// 실제로 구동해 받는함에 파일이 실제로 생기는 것을 확인한다("도달 절단"
// 변조[§7-5]의 표적).
// ---------------------------------------------------------------------------

test("static: 'escalation' is registered in reach-report-core.mjs AXES (closed array -- §4 요건3 최대 함정) (1/1)", () => {
  assert.ok(AXES.some((a) => a.key === "escalation"));
});

test("§4 요건3 end-to-end: runWatchOnce (the exact command §4 요건1 documents) with a live wake-worthy escalation actually writes a reach-notify-*.md file into notifyDir (1/1)", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk173-watch-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk173-notify-"));
  try {
    const execFn = (nodePath, args) => {
      // watch-run.mjs's runDetector spawns `node orch-stall-detect.mjs
      // --repo-root <root> --json` as a real child process in production;
      // this test injects a synthetic stdout producer instead (same shape
      // contract runWatchOnce's other tests already use) so it never
      // touches the real orca CLI or a real repo.
      void nodePath;
      void args;
      return JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        escalation: {
          status: "ESCALATION_OK",
          verdict: COORD_STATE.NEEDS_INPUT,
          worstCount: 1,
          totalWorktrees: 1,
          scopes: [
            {
              scope: { taskId: "task_X", dispatchId: "ctx_X" },
              state: COORD_STATE.NEEDS_INPUT,
              dedupeKey: "task_X:ctx_X:NEEDS_INPUT",
              transitionId: "529",
              wakeHuman: true,
              sampleSubject: "worker blocked",
              sampleBody: "cannot proceed",
            },
          ],
        },
      });
    };
    const result = runWatchOnce({
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      now: Date.parse("2026-08-09T12:00:00.000Z"),
      notifyDir,
    });
    assert.ok(
      result.reachResult.noticePath,
      "a notice file path must be returned",
    );
    assert.ok(
      fs.existsSync(result.reachResult.noticePath),
      "the reach-notify-*.md file must actually exist on disk",
    );
    const noticeText = fs.readFileSync(result.reachResult.noticePath, "utf8");
    assert.match(noticeText, new RegExp(COORD_STATE.NEEDS_INPUT));
    const noticeFiles = fs
      .readdirSync(notifyDir)
      .filter((f) => f.startsWith("reach-notify-"));
    assert.equal(noticeFiles.length, 1);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

test("§4 요건3 negative control: the SAME open escalation on a second tick does not write a second notice file (reach-report-core's own sinceMs continuity dedupe, unaffected by this axis) (1/1)", () => {
  const watchDir = fs.mkdtempSync(path.join(tmpdir(), "hyk173-watch2-"));
  const notifyDir = fs.mkdtempSync(path.join(tmpdir(), "hyk173-notify2-"));
  try {
    const stdout = JSON.stringify({
      verdict: "PROGRESSING",
      reasonCode: "OK",
      escalation: {
        status: "ESCALATION_OK",
        verdict: COORD_STATE.NEEDS_INPUT,
        worstCount: 1,
        totalWorktrees: 1,
        scopes: [
          {
            scope: { taskId: "task_X", dispatchId: "ctx_X" },
            state: COORD_STATE.NEEDS_INPUT,
            dedupeKey: "task_X:ctx_X:NEEDS_INPUT",
            transitionId: "529",
            wakeHuman: true,
            sampleSubject: "worker blocked",
            sampleBody: "cannot proceed",
          },
        ],
      },
    });
    const execFn = () => stdout;
    const opts = {
      repoRoot: process.cwd(),
      watchDir,
      execFn,
      notifyDir,
    };
    runWatchOnce({ ...opts, now: Date.parse("2026-08-09T12:00:00.000Z") });
    const second = runWatchOnce({
      ...opts,
      now: Date.parse("2026-08-09T12:05:00.000Z"),
    });
    assert.equal(
      second.reachResult.noticePath,
      null,
      "same continuously-open escalation must not fire a second notice",
    );
    const noticeFiles = fs
      .readdirSync(notifyDir)
      .filter((f) => f.startsWith("reach-notify-"));
    assert.equal(noticeFiles.length, 1);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(notifyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7-7 기존 축 회귀 0 -- 새 escalation 필드가 있어도 기존 4(+cap)축의
// 판정·로그 형식·파서는 불변이다.
// ---------------------------------------------------------------------------

test("§7-7 regression: adding escalation_* fields does not change how seat/idle/start/unconsumed/cap fields parse (existing parser unchanged) (1/1)", () => {
  const line =
    "2026-08-09T12:00:00.000Z exit=0 verdict=PROGRESSING reason=OK " +
    "seat_status=SEAT_LIVENESS_JUDGED seat_verdict=SUSPECTED_UNRESPONSIVE seat_worst_count=1 seat_worktrees=2 " +
    "idle_status=NONE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=NONE " +
    "start_status=NONE start_verdict=NONE start_worst_count=NONE start_worktrees=NONE " +
    "unconsumed_status=NONE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=NONE " +
    "cap_status=OK cap_verdict=DECIDED cap_value=2 cap_source=/x " +
    "escalation_status=ESCALATION_OK escalation_verdict=NEEDS_INPUT escalation_worst_count=1 escalation_worktrees=1";
  const parsed = parseLogLine(line);
  assert.equal(parsed.axes.seat.status, "SEAT_LIVENESS_JUDGED");
  assert.equal(parsed.axes.seat.verdict, "SUSPECTED_UNRESPONSIVE");
  assert.equal(parsed.axes.seat.worstCount, 1);
  assert.equal(parsed.axes.seat.worktrees, 2);
  assert.equal(parsed.axes.escalation.verdict, "NEEDS_INPUT");
});
