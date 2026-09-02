// HYK-408-seat-decide (coder-task.md §3 완료조건) -- 좌석 신원의 1차
// 판별을 화면(preview 한 장)에서 장부(dispatch record)로 옮긴 수리의
// 재현 시험. 세 가지를 실측 문자열로 고정한다:
//   ⓐ 스피너만 있는 실물 preview -- 수리 전(화면 후보 나열 단독)에는
//      UNKNOWN/AMBIGUOUS로 축 전체가 COLLECTION_FAILED, 수리 후
//      (judgeSeatLivenessForRepo/judgeDispatchStartForRepo, 장부 1차)는
//      같은 표본에서 JUDGED까지 간다.
//   ⓑ 죽은 마커 수리 -- 실 런처 배너(`[$Role seat] worktree=... pane=...`,
//      `D:\문서관리\하네스-관제실\orca-worker-seat.ps1:19`) 문자열로 옛
//      정규식(RED)과 새 정규식(GREEN)을 직접 대조한다.
//   ⓒ 장부 기록이 없을 때(task-list는 성공했지만 이 라벨+워크트리에
//      맞는 dispatched 항목이 없음) -- 화면으로 짐작하지 않고
//      fail-closed로 멈춘다(터미널 후보가 깨끗한 단일 AGENT라도).
//
// ★S11: 이 파일은 mkdtemp도, 실 `.harness/`도 만들지 않는다 --
// judgeSeatLivenessForRepo/judgeDispatchStartForRepo에 합성 droppedTaskFiles
// + 주입한 fake execFn만 준다(seat-liveness-wire.test.mjs/
// hyk185-seat-multi-repro.test.mjs와 동일 관례). dispatchStart 축의 관측
// 누적 store도 in-memory fake로 대체한다(저장소 밖 실 관제실 경로에
// 쓰지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySeatPreview,
  SEAT_PREVIEW_CLASSIFICATION,
  collectSeatLivenessObservation,
  SEAT_LIVENESS_OBSERVATION_REASON,
  AGENT_MARKER_RE,
  DELIVERED_SEAT_REASON,
} from "../relay/adapters/orca-adapter.mjs";
import {
  judgeSeatLivenessForRepo,
  judgeDispatchStartForRepo,
  SEAT_LIVENESS_WIRE_STATUS,
  DISPATCH_START_WIRE_STATUS,
} from "./orch-stall-detect.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// ⓐ 실측 표본: 2026-08-30 22:32~22:33 KST, 같은 좌석을 4회 연속 조회한
// preview가 스피너 재그림 프레임만 담고 있었다(coder-task.md §1 그대로
// 옮긴 원문 -- 마커가 하나도 없다).
// ---------------------------------------------------------------------------
const SPINNER_ONLY_PREVIEW = "o•Wor•Work1Worki•Workin•Working•…";

const WORKTREE =
  "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk408-repro";
const AGENT_SEAT = {
  handle: "term_hyk408_agent",
  worktreePath: WORKTREE,
  tabId: "aaaaaaaa-0000-0000-0000-000000000001",
  leafId: "bbbbbbbb-0000-0000-0000-000000000002",
};
// HYK-345 주석 실측 그대로: `orca worktree create`가 워크트리마다 만드는
// 빈 pwsh 기본 탭 -- 죽은 셸 프롬프트로 끝나 DEAD_SHELL로 확정된다.
const EMPTY_PWSH_TAB = {
  handle: "term_hyk408_emptytab",
  worktreePath: WORKTREE,
  tabId: "cccccccc-0000-0000-0000-000000000003",
  leafId: "dddddddd-0000-0000-0000-000000000004",
};
const NOW = Date.parse("2026-08-30T22:33:07+09:00"); // 실측 4회 재현 중 세 번째 시각.
const HARNESS_LABEL = "HYK-408-seat-decide-repro-1";

function terminalListResponse(terminals) {
  return {
    ok: true,
    result: {
      terminals: terminals.map((t) => ({
        handle: t.handle,
        worktreePath: t.worktreePath,
        tabId: t.tabId,
        leafId: t.leafId,
        title: t.title ?? null,
        connected: true,
        writable: true,
        lastOutputAt: t.lastOutputAt ?? NOW - 60_000,
      })),
    },
  };
}
function showResponseFor(t, preview) {
  return {
    ok: true,
    result: {
      terminal: {
        lastOutputAt: t.lastOutputAt ?? NOW - 60_000,
        title: t.title ?? null,
        tabId: t.tabId,
        leafId: t.leafId,
        preview,
      },
    },
  };
}

// 좌석 2개(에이전트 1 + 빈 pwsh 탭 1) -- 에이전트 좌석의 preview는
// SPINNER_ONLY_PREVIEW(실측), 빈 탭은 죽은 셸 프롬프트.
function fakeExecFnScreenOnly() {
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse([AGENT_SEAT, EMPTY_PWSH_TAB]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === AGENT_SEAT.handle) {
        return showResponseFor(AGENT_SEAT, SPINNER_ONLY_PREVIEW);
      }
      if (handle === EMPTY_PWSH_TAB.handle) {
        return showResponseFor(
          EMPTY_PWSH_TAB,
          "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk408-repro> ",
        );
      }
      throw new Error(`unexpected handle ${handle}`);
    }
    throw new Error(
      `fakeExecFnScreenOnly: unexpected argv ${JSON.stringify(argv)} -- ledger must not be queried when the primary path is screen-only`,
    );
  };
}

const TASK_LIST_TASKS = [
  {
    id: "task_hyk408_repro1",
    spec: `role: CODER\nharness_label: ${HARNESS_LABEL}\nworktree: ${WORKTREE.replace(/\//g, "\\")}\ntask_file: .harness/coder-task.md`,
  },
];
const DISPATCH_SHOW_BY_TASK_ID = {
  task_hyk408_repro1: {
    id: "dispatch_hyk408_repro1",
    task_id: "task_hyk408_repro1",
    assignee_handle: AGENT_SEAT.handle,
    assignee_pane_key: `${AGENT_SEAT.tabId}:${AGENT_SEAT.leafId}`,
    status: "dispatched",
  },
};
function taskListResponse(tasks) {
  return { ok: true, result: { tasks: Array.isArray(tasks) ? tasks : [] } };
}
function dispatchShowResponse(argv, byTaskId) {
  const taskId = argv[argv.indexOf("--task") + 1];
  const dispatch = byTaskId && byTaskId[taskId] ? byTaskId[taskId] : null;
  return { ok: true, result: { dispatch } };
}

// 같은 두 좌석(에이전트 preview는 여전히 SPINNER_ONLY_PREVIEW인 채로) +
// 장부 조회(task-list/dispatch-show)도 함께 답하는 execFn -- 1차 판별이
// 장부로 성립하면, 이 스피너 preview는 판정에 전혀 쓰이지 않아야 한다
// (읽더라도 무시돼야 한다).
function fakeExecFnWithLedger({
  taskListTasks = TASK_LIST_TASKS,
  dispatchShowByTaskId = DISPATCH_SHOW_BY_TASK_ID,
} = {}) {
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse([AGENT_SEAT, EMPTY_PWSH_TAB]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === AGENT_SEAT.handle) {
        return showResponseFor(AGENT_SEAT, SPINNER_ONLY_PREVIEW);
      }
      if (handle === EMPTY_PWSH_TAB.handle) {
        return showResponseFor(
          EMPTY_PWSH_TAB,
          "PS C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk408-repro> ",
        );
      }
      throw new Error(`unexpected handle ${handle}`);
    }
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return taskListResponse(taskListTasks);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return dispatchShowResponse(argv, dispatchShowByTaskId);
    }
    throw new Error(
      `fakeExecFnWithLedger: unexpected argv ${JSON.stringify(argv)}`,
    );
  };
}

function fakeDispatchStartStore() {
  let stored = null;
  return {
    dispatchStartExistsFn: () => stored !== null,
    dispatchStartReadFn: () => stored,
    dispatchStartWriteFn: (_p, text) => {
      stored = text;
    },
    dispatchStartMkdirFn: () => {},
    dispatchStartStorePath: "memory://hyk408-seat-decide-repro-test",
  };
}

const ACTIVE_NO_LABEL = [
  {
    path: ".harness/coder-task.md",
    droppedAtMs: NOW - 5 * 60_000,
    resultFile: { exists: false },
  },
];
const ACTIVE_WITH_LABEL = [
  {
    path: ".harness/coder-task.md",
    taskId: HARNESS_LABEL,
    droppedAtMs: NOW - 5 * 60_000,
    resultFile: { exists: false },
  },
];

// ---------------------------------------------------------------------------
// ⓐ-1 BEFORE: 화면 후보 나열 단독(collectSeatLivenessObservation)은
// 실측 스피너 preview에 마커가 없어 UNKNOWN -> AMBIGUOUS로 거부한다
// (이번 사이클에서 손대지 않은 함수 그대로 -- 재현일 뿐 회귀가 아니다).
// ---------------------------------------------------------------------------
test("HYK-408 ⓐ-1 BEFORE (실측 재현): 스피너만 있는 실물 preview -- classifySeatPreview는 마커를 찾지 못해 UNKNOWN이다", () => {
  assert.equal(
    classifySeatPreview(SPINNER_ONLY_PREVIEW),
    SEAT_PREVIEW_CLASSIFICATION.UNKNOWN,
  );
});

test("HYK-408 ⓐ-1 BEFORE (실측 재현): 화면 후보 나열 단독은 같은 표본(에이전트 1 + 빈탭 1)에서 AMBIGUOUS로 거부한다 -- 축 전체가 COLLECTION_FAILED로 새는 원인 그대로", () => {
  const r = collectSeatLivenessObservation(
    { worktreePath: WORKTREE, now: NOW },
    { execFn: fakeExecFnScreenOnly() },
  );
  assert.equal(r.ok, false);
  assert.equal(r.observationReason, SEAT_LIVENESS_OBSERVATION_REASON.AMBIGUOUS);
});

// ---------------------------------------------------------------------------
// ⓐ-2 AFTER: judgeSeatLivenessForRepo/judgeDispatchStartForRepo는 이제
// 장부를 1차로 쓴다 -- 같은 스피너 preview가 여전히 실려 있어도(위
// fakeExecFnWithLedger가 그대로 응답한다) 결과는 JUDGED다.
// ---------------------------------------------------------------------------
test("HYK-408 ⓐ-2 AFTER: seatLiveness -- 같은 스피너 preview 표본인데도 장부 1차 판별로 COLLECTION_FAILED 없이 JUDGED까지 간다", () => {
  const r = judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnWithLedger() },
  );
  assert.notEqual(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
  assert.equal(r.correlation.ok, true);
  assert.equal(r.correlation.handle, AGENT_SEAT.handle);
});

test("HYK-408 ⓐ-2 AFTER: dispatchStart -- 같은 스피너 preview 표본인데도 장부 1차 판별로 COLLECTION_FAILED 없이 판정까지 간다", () => {
  const r = judgeDispatchStartForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnWithLedger(), ...fakeDispatchStartStore() },
  );
  assert.notEqual(r.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(r.correlation.ok, true);
  assert.equal(r.correlation.handle, AGENT_SEAT.handle);
});

// 되돌림 변이(§4 요구): 장부 축을 끊으면(하네스 라벨을 비움 -- 장부를
// 조회할 근거 자체가 없어짐) 스피너 표본은 다시 화면 전용 경로로
// 떨어져 AMBIGUOUS -> COLLECTION_FAILED다. 판정이 진짜로 장부에 의존함을
// 이 대조로 고정한다(장부 경로를 지워도 같은 결과가 나온다면 장부가
// 애초에 아무 일도 안 한 것이다).
test("HYK-408 ⓐ-3 되돌림 변이: 활성 배달에 하네스 라벨이 없으면(장부 조회 근거 없음) -- 같은 스피너 표본이 다시 COLLECTION_FAILED로 떨어진다(장부 경로가 실제로 결과를 바꾼다는 증거)", () => {
  const r = judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_NO_LABEL, now: NOW },
    { execFn: fakeExecFnWithLedger() },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(r.observationReason, SEAT_LIVENESS_OBSERVATION_REASON.AMBIGUOUS);
  assert.equal(r.correlation, undefined);
});

// ---------------------------------------------------------------------------
// ⓑ 죽은 마커 수리 -- 실 런처 배너 원문(`orca-worker-seat.ps1:19`,
// `Write-Host "[$Role seat] worktree=$Worktree  pane=$env:ORCA_PANE_KEY"`)을
// 그대로 옮긴 문자열로 옛 정규식(RED)과 새 정규식(GREEN)을 직접 대조한다.
// ---------------------------------------------------------------------------
const REAL_LAUNCHER_BANNER =
  "[CODER seat] worktree=C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk408-repro  pane=a5251fad-2366-40e4-88da-db749b913c28:8b05257a-d323-41d8-87ae-98b45c4d77bb";
// 수리 전 정규식 원문(orca-adapter.mjs git history 그대로, 이 시험 안에서만
// 재구성 -- 프로덕션 코드는 되돌리지 않는다) -- 대조용.
const OLD_BROKEN_AGENT_MARKER_RE =
  /gpt-5\.6|Sonnet|Opus|\[CODER\]|\[REVIEW\]|bypass permissions|MCP startup|weekly \d/;

test("HYK-408 ⓑ BEFORE (실측 재현): 실 런처 배너 문자열 -- 옛 정규식(bracket CODER, 공백 없음)은 한 번도 일치한 적이 없다", () => {
  assert.equal(OLD_BROKEN_AGENT_MARKER_RE.test(REAL_LAUNCHER_BANNER), false);
});

test("HYK-408 ⓑ AFTER: 실 런처 배너 문자열 -- 새 정규식(bracket CODER space seat)이 실제로 일치한다", () => {
  assert.equal(AGENT_MARKER_RE.test(REAL_LAUNCHER_BANNER), true);
});

test("HYK-408 ⓑ AFTER: classifySeatPreview도 같은 실 배너 문자열을 AGENT로 분류한다(end-to-end pin)", () => {
  assert.equal(
    classifySeatPreview(REAL_LAUNCHER_BANNER),
    SEAT_PREVIEW_CLASSIFICATION.AGENT,
  );
});

// ---------------------------------------------------------------------------
// ⓒ 장부 기록이 없을 때 fail-closed -- task-list 조회는 성공했지만 이
// 하네스 라벨+워크트리에 맞는 dispatched 항목이 없다. 화면 쪽은 깨끗한
// 단일 AGENT 후보(실 배너 문자열)라 화면으로 넘어가면 쉽게 JUDGED가
// 나올 상황인데도, 화면으로 물러나지 않고 여기서 멈춘다(§2(1)/
// §3-완료조건2 비타협).
//
// HYK-413-seat-binding-2 (2R 수리, 검토 P2-1): 이 표본은 WORKTREE 아래
// `.harness/dispatch-receipt-path.txt` 포인터를 두지 않으므로(원장 경로
// 자체가 미해결) 원장 조회가 인프라 실패(RECEIPT_PATH_UNSET)로 spec
// 폴백까지 간 뒤 그 spec(task-list)도 0건이다 -- 이건 "원장이 직접
// 답했는데 기록이 없다"(ⓐ, NO_CANDIDATE_TASK/NO_DELIVERY_RECORD)가
// 아니라 "원장은 못 물어봤고 그 대안도 못 찾았다"(ⓑ,
// SPEC_FALLBACK_NO_CANDIDATE_TASK/SPEC_FALLBACK_NO_MATCH)다 -- 2R
// 이전엔 이 둘이 같은 코드였다(검토가 지적한 결함 그 자체). fail-closed
// 판정(COLLECTION_FAILED) 자체는 전혀 안 바뀐다.
// ---------------------------------------------------------------------------
function fakeExecFnNoDeliveryRecord() {
  const singleClearAgentSeat = { ...AGENT_SEAT };
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse([singleClearAgentSeat]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === singleClearAgentSeat.handle) {
        return showResponseFor(singleClearAgentSeat, REAL_LAUNCHER_BANNER);
      }
      throw new Error(`unexpected handle ${handle}`);
    }
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      // 장부 조회 자체는 성공했지만, 이 라벨+워크트리에 맞는 dispatched
      // 항목이 하나도 없다 -- "기록이 없다"는 확정 사실.
      return taskListResponse([]);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      throw new Error(
        "fakeExecFnNoDeliveryRecord: dispatch-show must not be called when task-list already found no candidate",
      );
    }
    throw new Error(
      `fakeExecFnNoDeliveryRecord: unexpected argv ${JSON.stringify(argv)}`,
    );
  };
}

test("HYK-408 ⓒ fail-closed: 장부에 이 배달 기록이 없다(task-list 성공, 후보 0개) -- 화면 쪽이 깨끗한 단일 AGENT 후보라도 짐작하지 않고 COLLECTION_FAILED로 멈춘다", () => {
  const r = judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnNoDeliveryRecord() },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.SPEC_FALLBACK_NO_MATCH,
  );
  assert.equal(r.correlation.ok, false);
  assert.equal(
    r.correlation.reasonCode,
    DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK,
  );
});

test("HYK-408 ⓒ fail-closed: dispatchStart 축도 동일하게 장부 기록 부재에서 화면으로 물러나지 않는다", () => {
  const r = judgeDispatchStartForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnNoDeliveryRecord(), ...fakeDispatchStartStore() },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.SPEC_FALLBACK_NO_MATCH,
  );
  assert.equal(r.correlation.ok, false);
  assert.equal(
    r.correlation.reasonCode,
    DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK,
  );
});

// 대조군: 위와 완전히 같은 단일-AGENT-후보 표본을 harnessLabel 없이(장부
// 조회 근거 자체가 없는 경우) 판정하면 -- 예전 그대로 화면 전용 경로가
// 정상적으로 JUDGED까지 간다(fail-closed가 "장부 기록 없음"에만 걸리고
// "장부를 아예 안 본다"에는 걸리지 않는다는 것을 함께 보여준다).
test("HYK-408 대조군: harnessLabel이 없으면(장부를 볼 근거가 없음) 예전 그대로 화면 전용 경로로 정상 JUDGED된다 -- fail-closed가 과잉 적용되지 않는다", () => {
  const r = judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_NO_LABEL, now: NOW },
    { execFn: fakeExecFnNoDeliveryRecord() },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.JUDGED);
  assert.equal(r.correlation, undefined);
});

// ---------------------------------------------------------------------------
// ⓓ HYK-408-seat-decide 2R (검토 P1 수리) -- stale pane key와 불일치
// pane key. 검토자가 지정한 정확한 재현 조건 그대로: **단일 [CODER seat]
// 후보가 살아있는 상태**에서 장부의 assignee_pane_key가 그 후보와
// 대조되지 않는다. 1R은 이 두 경우 다 (NO_CANDIDATE_TASK가 아니므로)
// 화면 폴백으로 흘려보내 화면 쪽 단일 AGENT 후보가 그대로 JUDGED로
// 새는 fail-open이었다(검토 P1 원문). ⛔둘 다 orca-adapter.mjs 층에서는
// 같은 사유 코드(NO_LIVE_SEAT_MATCH)로 관측된다 -- "그 좌석이 원래
// 없었다"(stale)와 "다른 좌석이 그 자리를 차지했다"(불일치)를 그 층이
// 구조적으로 구분할 근거가 없기 때문이다(위 orca-adapter.mjs 주석
// 참조). 그래서 이 시험도 같은 코드 경로를 확인하지만, 검토가 명시로
// 요구한 두 실물 시나리오를 각각 별도 표본으로 고정한다(우연히 하나만
// 막고 다른 하나는 안 막는 일이 없도록).
// ---------------------------------------------------------------------------
const SINGLE_CODER_SEAT = {
  handle: "term_hyk408_single_coder",
  worktreePath: WORKTREE,
  tabId: "eeeeeeee-0000-0000-0000-000000000005",
  leafId: "ffffffff-0000-0000-0000-000000000006",
};
// 지금 이 순간 이 워크트리에 붙은 후보는 이 하나뿐이다(검토자 재현 조건
// "단일 [CODER seat] 후보" 그대로) -- preview는 실 배너 문자열이라
// 화면 경로로 물러났다면 손쉽게 AGENT 확정 -> JUDGED가 나올 상황이다.
function fakeExecFnWithSingleCoderSeat(assigneePaneKey) {
  const taskListTasks = [
    {
      id: "task_hyk408_repro_d",
      spec: `role: CODER\nharness_label: ${HARNESS_LABEL}\nworktree: ${WORKTREE.replace(/\//g, "\\")}\ntask_file: .harness/coder-task.md`,
    },
  ];
  const dispatchShowByTaskId = {
    task_hyk408_repro_d: {
      id: "dispatch_hyk408_repro_d",
      task_id: "task_hyk408_repro_d",
      assignee_handle: "term_hyk408_gone_or_wrong",
      assignee_pane_key: assigneePaneKey,
      status: "dispatched",
    },
  };
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse([SINGLE_CODER_SEAT]);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      if (handle === SINGLE_CODER_SEAT.handle) {
        return showResponseFor(SINGLE_CODER_SEAT, REAL_LAUNCHER_BANNER);
      }
      throw new Error(`unexpected handle ${handle}`);
    }
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return taskListResponse(taskListTasks);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return dispatchShowResponse(argv, dispatchShowByTaskId);
    }
    throw new Error(
      `fakeExecFnWithSingleCoderSeat: unexpected argv ${JSON.stringify(argv)}`,
    );
  };
}

// stale: 이 라벨로 배달된 좌석이 예전엔 살아 있었지만, 그 뒤 좌석이
// 재시작돼(예: 죽었다가 다시 뜸) 지금은 그 pane key를 가진 터미널이
// 아예 존재하지 않는다 -- 장부에는 여전히 옛 값이 박혀 있다.
const STALE_ASSIGNEE_PANE_KEY =
  "99999999-dead-dead-dead-000000000009:88888888-dead-dead-dead-000000000008";

test("HYK-408 ⓓ-1 fail-closed(stale pane key): 장부의 pane key를 가진 터미널이 지금 하나도 없다(단일 [CODER seat] 후보만 살아있음) -- 화면으로 물러나지 않고 COLLECTION_FAILED", () => {
  const r = judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnWithSingleCoderSeat(STALE_ASSIGNEE_PANE_KEY) },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.DELIVERY_RECORD_NO_MATCH,
  );
  assert.notEqual(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.NO_DELIVERY_RECORD,
    "stale must stay distinguishable from absence in the reason code (coder-task.md §2⑴)",
  );
  assert.equal(r.correlation.ok, false);
  assert.equal(
    r.correlation.reasonCode,
    DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH,
  );
});

test("HYK-408 ⓓ-1 fail-closed(stale pane key): dispatchStart 축도 동일하게 거부한다", () => {
  const r = judgeDispatchStartForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    {
      execFn: fakeExecFnWithSingleCoderSeat(STALE_ASSIGNEE_PANE_KEY),
      ...fakeDispatchStartStore(),
    },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.DELIVERY_RECORD_NO_MATCH,
  );
  assert.equal(r.correlation.ok, false);
  assert.equal(
    r.correlation.reasonCode,
    DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH,
  );
});

// 불일치: 장부의 pane key가 애초에 이 좌석의 것이었던 적이 없다(다른
// 워크트리/다른 배달의 좌석 것 -- 예를 들어 §ⓑ의 실 배너 예시에 쓴
// 진짜 관측 pane key `a5251fad-...:8b05257a-...`를 그대로 재사용해도
// 이 워크트리의 SINGLE_CODER_SEAT과는 다른 값이다). stale과 orca-adapter
// 층 사유 코드는 같지만(위 헤더 주석 참조) 실물 시나리오가 다르므로
// 검토자 요구대로 별도 표본으로 고정한다.
const MISMATCHED_ASSIGNEE_PANE_KEY =
  "a5251fad-2366-40e4-88da-db749b913c28:8b05257a-d323-41d8-87ae-98b45c4d77bb";

test("HYK-408 ⓓ-2 fail-closed(불일치 pane key): 장부의 pane key가 살아있는 유일한 후보의 것과 다르다(단일 [CODER seat] 후보만 살아있음) -- 화면으로 물러나지 않고 COLLECTION_FAILED", () => {
  assert.notEqual(
    MISMATCHED_ASSIGNEE_PANE_KEY,
    `${SINGLE_CODER_SEAT.tabId}:${SINGLE_CODER_SEAT.leafId}`,
    "fixture sanity: the mismatched key must actually differ from the live candidate's real key",
  );
  const r = judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnWithSingleCoderSeat(MISMATCHED_ASSIGNEE_PANE_KEY) },
  );
  assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.DELIVERY_RECORD_NO_MATCH,
  );
  assert.equal(r.correlation.ok, false);
  assert.equal(
    r.correlation.reasonCode,
    DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH,
  );
});

test("HYK-408 ⓓ-2 fail-closed(불일치 pane key): dispatchStart 축도 동일하게 거부한다", () => {
  const r = judgeDispatchStartForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    {
      execFn: fakeExecFnWithSingleCoderSeat(MISMATCHED_ASSIGNEE_PANE_KEY),
      ...fakeDispatchStartStore(),
    },
  );
  assert.equal(r.status, DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED);
  assert.equal(
    r.observationReason,
    SEAT_LIVENESS_OBSERVATION_REASON.DELIVERY_RECORD_NO_MATCH,
  );
  assert.equal(r.correlation.ok, false);
  assert.equal(
    r.correlation.reasonCode,
    DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH,
  );
});

// ---------------------------------------------------------------------------
// ⓓ-3 되돌림 변이(§3 필수): "닫는 분기를 끊으면 다시 JUDGED로 새는가"를
// 직접 확인한다 -- orch-stall-detect.mjs의 실제 소스 문자열을 변조해
// LEDGER_QUERY_INFRA_FAILURE_REASONS 허용목록 검사를 무조건 참으로
// 바꾼(=모든 상관 실패가 다시 화면 폴백으로 새는) 변이체를 만들고, 위
// stale 표본을 그 변이체에 넣으면 다시 JUDGED가 나오는지 본다(RED
// 신호 -- 이 가드가 실제로 결과를 좌우한다는 증거). seat-liveness-wire.
// test.mjs/dispatch-start-wire.test.mjs가 이미 쓰는 것과 동일한 패턴
// (문자열 정확히 1회 치환 -> 상대경로를 절대경로로 재작성 -> 임시
// 파일로 저장 -> 동적 import)을 재사용한다(재구현 아님).
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
  const mutantDir = mkdtempSync(join(tmpdir(), `hyk408-2r-mutant-${label}-`));
  const mutantPath = join(mutantDir, "orch-stall-detect.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

test("HYK-408 ⓓ-3 되돌림 변이(필수): LEDGER_QUERY_INFRA_FAILURE_REASONS 허용목록 검사를 무력화(항상 화면 폴백 허용) -> RED (stale pane key + 단일 CODER-seat 후보가 다시 JUDGED로 샌다 -- 이 가드가 실제로 막고 있었다는 증거)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  if (LEDGER_QUERY_INFRA_FAILURE_REASONS.has(resolved.reasonCode)) {",
        "  if (true) {",
      ),
    "1",
  );
  const r = mutant.judgeSeatLivenessForRepo(
    { repoRoot: WORKTREE, droppedTaskFiles: ACTIVE_WITH_LABEL, now: NOW },
    { execFn: fakeExecFnWithSingleCoderSeat(STALE_ASSIGNEE_PANE_KEY) },
  );
  assert.equal(
    r.status,
    "SEAT_LIVENESS_JUDGED",
    "mutant must regress to the exact P1 fail-open (stale pane key + single CODER-seat candidate -> JUDGED) -- RED signal proving the closed-by-default branch is load-bearing in the real code",
  );
});
