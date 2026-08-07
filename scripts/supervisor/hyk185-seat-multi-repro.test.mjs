// HYK-185-seat-multi (coder-task.md 합격기준 (a)/(b)) -- 2026-08-05 21:36
// KST 예약 발화 재현.
//
// 그 발화에서 세 감시 축(seatLiveness/seatIdle/dispatchStart)이 전부
// 수집 실패로 떨어졌다(watch.log.snapshot 2026-08-05T12:36:02.051Z tick
// -- 21:36 KST): 원인은 `hyk185-gap83-3` 워크트리에 좌석이 2개(CODER+
// REVIEW, 우리 표준 구성)였고 그 워크트리를 판정하려던 세 축이 전부
// resolveSeatLivenessCandidate 하나를 공유해 "2개 이상이면 거부"에
// 동시에 걸렸기 때문이다(.harness/coder-task.md §1).
//
// ★(b) 표본은 저장소 안에 둔다 -- `.harness/증거/`는 gitignore 대상이라
// 시험이 그 경로를 읽으면 CI에서 깨진다(오늘 실사고 2회, coder-task.md
// §3-b). 이 시험은 그 원자료(terminal-list-raw.json/watch.log.snapshot)
// 에서 딱 필요한 부분만 뽑아 저장소 안에 둔 fixture
// (hyk185-seat-multi-2026-08-05-2136-sample.json)를
// `new URL(..., import.meta.url)`로 읽는다 -- 저장소 밖 절대경로(`D:\...`)
// 를 읽지 않는다.
//
// ★(a) 실물 재현 -- "수리 전"과 "수리 후"를 같은 시험 파일 안에서 직접
// 대조한다:
// - "수리 전" 관측층(collectSeatLivenessObservation, orca-adapter.mjs)은
//   이번 사이클에서 손대지 않았다 -- 그대로 남아 그대로 AMBIGUOUS를
//   낸다(비타협: "좌석이 둘일 때 추측하지 않고 실패로 드러내는 것은
//   옳은 동작"). 이 시험은 그 함수를 이 실제 표본에 직접 불러 여전히
//   거부하는 것을 고정한다 -- seatLiveness/dispatchStart 두 축은 지금도
//   이 함수를 그대로 쓰므로(§1 QUESTION 참조) 여전히 COLLECTION_FAILED로
//   떨어진다(회귀 아님 -- 의도적 보류, `.harness/coder.md` QUESTION 절).
// - "수리 후" seatIdle 축(judgeSeatIdleForRepo, orch-stall-detect.mjs)은
//   이번 사이클에서 넓힌 관측층(collectSeatObservationsForWorktree)을
//   쓴다 -- 같은 표본, 같은 워크트리인데도 더 이상 COLLECTION_FAILED가
//   아니라 JUDGED로 떨어진다(좌석 2개를 각각 판정해 가장 나쁜 쪽을
//   대표로 삼는다). "결과가 달라진다"는 합격기준을 이 대조로 보여준다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectSeatLivenessObservation,
  SEAT_LIVENESS_OBSERVATION_REASON,
} from "../relay/adapters/orca-adapter.mjs";
import {
  judgeSeatIdleForRepo,
  judgeSeatLivenessForRepo,
  judgeDispatchStartForRepo,
  SEAT_IDLE_WIRE_STATUS,
  SEAT_LIVENESS_WIRE_STATUS,
  DISPATCH_START_WIRE_STATUS,
} from "./orch-stall-detect.mjs";
import { SEAT_IDLE_VERDICT } from "./seat-idle-core.mjs";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./hyk185-seat-multi-2026-08-05-2136-sample.json", import.meta.url),
    "utf8",
  ),
);

// HYK-185-seat-corr: terminal show 응답에도 tabId/leafId를 실어야
// resolveDeliveredSeat(step③, pane key 대조)가 동작한다 -- 기존
// seatIdle/seatLiveness 관측(lastOutputAt/title)은 그대로 두고 필드만
// 추가한다(그 두 축의 계약은 바뀌지 않는다, collectSeatObservationsForWorktree/
// collectSeatLivenessObservation는 여전히 lastOutputAt/title만 읽는다).
// taskListTasks/dispatchShowByTaskId가 있을 때만(옵션) task-list/
// dispatch-show 응답도 함께 흉내낸다.
// quality-check 복잡도 상한(12) 준수 -- 경로별 핸들러로 분리.
function terminalListResponse(terminals) {
  return {
    ok: true,
    result: {
      terminals: terminals.map((t) => ({
        handle: t.handle,
        worktreePath: t.worktreePath,
        tabId: t.tabId,
        leafId: t.leafId,
        title: t.title,
        connected: true,
        writable: true,
        lastOutputAt: t.lastOutputAt,
      })),
    },
  };
}
function taskListResponse(taskListTasks) {
  return {
    ok: true,
    result: { tasks: Array.isArray(taskListTasks) ? taskListTasks : [] },
  };
}
function dispatchShowResponse(argv, dispatchShowByTaskId) {
  const taskId = argv[argv.indexOf("--task") + 1];
  const dispatch =
    dispatchShowByTaskId && dispatchShowByTaskId[taskId]
      ? dispatchShowByTaskId[taskId]
      : null;
  return { ok: true, result: { dispatch } };
}

function fakeExecFn(terminals, { taskListTasks, dispatchShowByTaskId } = {}) {
  const showsByHandle = Object.fromEntries(
    terminals.map((t) => [
      t.handle,
      {
        ok: true,
        result: {
          terminal: {
            lastOutputAt: t.lastOutputAt,
            title: t.title,
            tabId: t.tabId,
            leafId: t.leafId,
          },
        },
      },
    ]),
  );
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse(terminals);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      return showsByHandle[handle];
    }
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return taskListResponse(taskListTasks);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return dispatchShowResponse(argv, dispatchShowByTaskId);
    }
    throw new Error(`fakeExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}

// FIXTURE의 task-list/dispatch-show 표본을 함께 흉내내는 execFn(§2 대조
// 경로가 실제로 동작하는 시험 전용) -- fakeExecFn(terminals)만 쓰는 시험은
// 여전히 task-list/dispatch-show를 부르면 throw한다(호출 자체가 없어야
// 하는 경로를 검증).
function fakeExecFnWithCorrelation() {
  return fakeExecFn(FIXTURE.terminals, {
    taskListTasks: FIXTURE.taskListTasks,
    dispatchShowByTaskId: FIXTURE.dispatchShowByTaskId,
  });
}

const NOW = Date.parse(FIXTURE.nowIso);
const AMBIGUOUS_WORKTREE = FIXTURE.ambiguousWorktreePath;

// 이 워크트리에 "아직 결과 파일이 없는 활성 배달"이 있다고 가정한다 --
// 세 축이 전부 이 워크트리를 실제로 판정하려 시도하게 만드는 최소 입력
// (배달과 결부된 두 축의 NOT_APPLICABLE 조기 반환을 우회한다).
// HYK-185-seat-corr: `taskId`(하네스 라벨, orch-stall-detect.mjs가 이
// 필드를 resolveDeliveredSeat의 harnessLabel로 넘긴다)가 없는 항목은
// 여전히 대조를 시도하지 않는다(아래 "라벨 없음" 시험) -- 라벨이 있는
// 항목만 §2 대조 재시도의 입력이 된다.
const ACTIVE_DISPATCH_NO_LABEL = [
  {
    path: ".harness/coder-task.md",
    droppedAtMs: NOW - 60_000,
    resultFile: { exists: false },
  },
];
const ACTIVE_DISPATCH_WITH_LABEL = [
  {
    path: ".harness/coder-task.md",
    taskId: FIXTURE.harnessLabel,
    droppedAtMs: NOW - 60_000,
    resultFile: { exists: false },
  },
];

test("(a)(b) real 21:36 KST sample: the shared narrow observation function still refuses on the 2-seat worktree by itself (unchanged this cycle, still correct)", () => {
  const execFn = fakeExecFn(FIXTURE.terminals);
  const r = collectSeatLivenessObservation(
    { worktreePath: AMBIGUOUS_WORKTREE, now: NOW },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.observationReason, SEAT_LIVENESS_OBSERVATION_REASON.AMBIGUOUS);
});

// ★변경점(합격기준 (a)): 이 두 시험은 예전엔 "여전히 COLLECTION_FAILED"를
// 고정했다 -- 이번 사이클(HYK-185-seat-corr)이 §2 대조 재시도를
// judgeSeatLivenessForRepo/judgeDispatchStartForRepo에 실제로 얹었으므로
// (orch-stall-detect.mjs, resolveObservationWithDeliveredSeatFallback),
// 같은 표본(FIXTURE)에 task-list/dispatch-show 표본(taskListTasks/
// dispatchShowByTaskId -- 실측 shape에서 파생, 표본 파일 provenance 참조)을
// 함께 주고 활성 배달에 하네스 라벨(taskId)을 채우면 이제 JUDGED로
// 떨어진다 -- assignee_pane_key가 CODER 좌석(term_3321e179...) 하나만
// 가리키므로 그 좌석의 관측으로 판정한다.
test("(a)(b)★ real 21:36 KST sample: AFTER -- seatLiveness axis (delivery-tied) now resolves via delivered-seat correlation on the 2-seat worktree", () => {
  const execFn = fakeExecFnWithCorrelation();
  const r = judgeSeatLivenessForRepo(
    {
      repoRoot: AMBIGUOUS_WORKTREE,
      droppedTaskFiles: ACTIVE_DISPATCH_WITH_LABEL,
      now: NOW,
    },
    { execFn },
  );
  assert.notEqual(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
  assert.equal(r.correlation.ok, true);
  assert.equal(
    r.correlation.handle,
    "term_3321e179-357c-4de9-b9f9-f72e38d2d8fc",
  );
});

test("(a)(b)★ real 21:36 KST sample: AFTER -- dispatchStart axis (delivery-tied) now resolves via delivered-seat correlation on the 2-seat worktree", () => {
  const execFn = fakeExecFnWithCorrelation();
  const r = judgeDispatchStartForRepo(
    {
      repoRoot: AMBIGUOUS_WORKTREE,
      droppedTaskFiles: ACTIVE_DISPATCH_WITH_LABEL,
      now: NOW,
    },
    {
      execFn,
      // 저장소 밖 실 관제실 경로에 쓰지 않는다(§3-g) -- 이 시험 전용
      // 메모리 store로 대체.
      dispatchStartStorePath: "memory://hyk185-seat-corr-repro-test",
      dispatchStartExistsFn: () => false,
      dispatchStartReadFn: () => "{}",
      dispatchStartMkdirFn: () => {},
      dispatchStartWriteFn: () => {},
    },
  );
  assert.notEqual(r.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(r.correlation.ok, true);
  assert.equal(
    r.correlation.handle,
    "term_3321e179-357c-4de9-b9f9-f72e38d2d8fc",
  );
});

// 회귀 방지(합격기준 (e)와 별개로, 이 재시도 경로 자신의 fail-closed
// 확인): 활성 배달 항목에 하네스 라벨(taskId)이 없으면 -- 즉
// resolveDeliveredSeat를 부를 근거 자체가 없으면 -- 대조를 시도하지
// 않고 예전 그대로 COLLECTION_FAILED다(옆에서 task-list/dispatch-show
// 표본을 줘도 그렇다 -- 라벨 없이는 대조 자체를 시작하지 않는다는 것을
// 이 시험이 고정한다).
test("(a)(b) real 21:36 KST sample: still-blocked when the active dispatch has no harness label -- correlation retry never attempted", () => {
  const execFn = fakeExecFnWithCorrelation();
  const rLiveness = judgeSeatLivenessForRepo(
    {
      repoRoot: AMBIGUOUS_WORKTREE,
      droppedTaskFiles: ACTIVE_DISPATCH_NO_LABEL,
      now: NOW,
    },
    { execFn },
  );
  assert.equal(rLiveness.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(rLiveness.correlation, undefined);

  const rStart = judgeDispatchStartForRepo(
    {
      repoRoot: AMBIGUOUS_WORKTREE,
      droppedTaskFiles: ACTIVE_DISPATCH_NO_LABEL,
      now: NOW,
    },
    { execFn },
  );
  assert.equal(rStart.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(rStart.correlation, undefined);
});

test("(a)(b)★ real 21:36 KST sample: AFTER -- seatIdle axis no longer collection-fails on the same 2-seat worktree, it judges both seats", () => {
  const execFn = fakeExecFn(FIXTURE.terminals);
  const r = judgeSeatIdleForRepo(
    { repoRoot: AMBIGUOUS_WORKTREE, droppedTaskFiles: [], now: NOW },
    { execFn },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
  assert.notEqual(r.status, SEAT_IDLE_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(r.seats.length, 2);
  assert.ok(
    r.seats.every((s) => s.ok === true),
    "both real seats' terminal-show observations must have resolved",
  );
  // 실제 표본(now=orch-stall-detect-raw.json의 실측 now): CODER 좌석은
  // 최근 출력(약 11분 전), REVIEW 좌석은 더 오래됐다(약 78분 전) -- 둘
  // 다 기본 임계(4시간)보다 짧으므로 대표 판정은 IDLE_OK.
  assert.equal(r.verdict, SEAT_IDLE_VERDICT.IDLE_OK);
});

test("(a) result genuinely differs: same worktree/same fixture -- old shared path (AMBIGUOUS) vs new seatIdle path (JUDGED) disagree", () => {
  const execFn = fakeExecFn(FIXTURE.terminals);
  const before = collectSeatLivenessObservation(
    { worktreePath: AMBIGUOUS_WORKTREE, now: NOW },
    { execFn },
  );
  const after = judgeSeatIdleForRepo(
    { repoRoot: AMBIGUOUS_WORKTREE, droppedTaskFiles: [], now: NOW },
    { execFn: fakeExecFn(FIXTURE.terminals) },
  );
  assert.equal(before.ok, false);
  assert.equal(after.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
});

// 두 좌석이 서로 다른 유휴 상태일 때 "고르지 않고 가장 나쁜 쪽을
// 대표로 삼는다"는 계약을 직접 고정한다(judgeSeatIdleAcrossSeats의
// worst-wins 규칙). 실제 21:36 표본은 두 좌석 다 IDLE_OK라 이 분기를
// 건드리지 않으므로, 이 시험은 합성(synthetic) 두 번째 시나리오로
// 그 규칙 자체를 잠근다.
test("multi-seat worst-wins: one seat abandoned + one seat fine -> the worktree's representative verdict is SUSPECTED_ABANDONED (never silently picks the fine one)", () => {
  const now = Date.parse("2026-08-05T13:55:27.298Z");
  const terminals = [
    {
      handle: "term_fine",
      worktreePath: AMBIGUOUS_WORKTREE,
      tabId: "aaaaaaaa-1111-1111-1111-111111111111",
      leafId: "bbbbbbbb-2222-2222-2222-222222222222",
      title: "fine",
      lastOutputAt: now - 60_000,
    },
    {
      handle: "term_abandoned",
      worktreePath: AMBIGUOUS_WORKTREE,
      tabId: "cccccccc-3333-3333-3333-333333333333",
      leafId: "dddddddd-4444-4444-4444-444444444444",
      title: "abandoned",
      lastOutputAt: now - 20 * 60 * 60 * 1000, // 20시간 -- 기본 임계(4시간) 초과.
    },
  ];
  const r = judgeSeatIdleForRepo(
    { repoRoot: AMBIGUOUS_WORKTREE, droppedTaskFiles: [], now },
    { execFn: fakeExecFn(terminals) },
  );
  assert.equal(r.status, SEAT_IDLE_WIRE_STATUS.JUDGED);
  assert.equal(r.verdict, SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED);
  assert.equal(r.seats.length, 2);
});
