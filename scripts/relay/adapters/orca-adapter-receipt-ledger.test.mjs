// HYK-413-seat-binding-1 (coder-task.md §1-§2): 1차 후보 좁히기(§2 step①)
// 를 ORCH가 손으로 쓰는 spec 산문에서 배달 시점에 기계가 쓰는 영수증
// 원장(dispatch-receipts.jsonl)으로 옮긴 것을 검증한다. 원장 경로 해석은
// relay-handshake.mjs의 resolveDispatchLedgerPath/readDispatchLedgerRecords
// 를 그대로 재사용하므로(재구현 금지, HYK-387 3R), 그 함수들 자신의 시험
// (hyk387-3r-receipt-pointer.test.mjs)이 이미 고정한 "실물 파일시스템 +
// mkdtemp fixture" 관례를 그대로 따른다 -- fake execFn만으로는 fs 읽기를
// 검증할 수 없다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 os.tmpdir() 아래 mkdtemp
// 디렉터리에만 쓴다(HYK-394-test-leak-3 §2 Q1 실사고 재현 방지 -- 이
// 워크트리 자신의 라이브 .harness/ 아래는 절대 쓰지 않는다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveDeliveredSeat,
  DELIVERED_SEAT_REASON,
} from "./orca-adapter.mjs";

const SCRATCH_ROOT = join(tmpdir(), "hyk413-seat-binding-scratch");

function withFixtureDir(prefix, fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

const WORKTREE =
  "C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk413-fixture";
const LABEL = "HYK-413-fixture-1";

const CODER_SEAT = {
  handle: "term_coder",
  worktreePath: WORKTREE,
  tabId: "b7011967-041a-45e4-843c-0cf8e2ccd418",
  leafId: "ecdf87c2-a552-4370-9ecf-98d455404f0a",
};

function paneKeyOf(seat) {
  return `${seat.tabId}:${seat.leafId}`;
}

// dispatch-receipt-cli.mjs의 buildReceiptRecord와 정확히 같은 8필드
// (실물 dispatch-receipts.jsonl 표본과 동일 shape, coder-task.md §1 실측
// 인용 그대로).
function receiptLine({
  runtimeTaskId,
  dispatchId = "ctx_fixture",
  assigneePaneKey,
  role = "CODER",
  harnessTaskLabel = LABEL,
  omitRuntimeTaskId = false,
}) {
  const rec = {
    recorded_at: "2026-09-02T03:24:19.983Z",
    ...(omitRuntimeTaskId ? {} : { runtime_task_id: runtimeTaskId }),
    dispatch_id: dispatchId,
    assignee_pane_key: assigneePaneKey,
    dispatch_timestamp_utc: "2026-09-02 03:24:18",
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: harnessTaskLabel,
  };
  return JSON.stringify(rec) + "\n";
}

function writePointer(harnessDir, ledgerPath) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "dispatch-receipt-path.txt"),
    ledgerPath,
    "utf8",
  );
}

// coder-task.md §6 실측 그대로: ORCH가 harness_label:/worktree: 두 줄을
// 손으로 안 넣으면(또는 worktree만 빠뜨리면) 실물 spec은 이 모양이다.
function realisticSpecWithoutWorktreeLine(label) {
  return `role: CODER\nharness_label: ${label}\ntask_file: .harness/coder-task.md\n요지: (실측 산문, worktree 줄 없음).`;
}

// quality-check 복잡도 상한(12) 준수 -- 경로별 핸들러로 분리(makeExecFn
// 자신은 라우팅만 한다), orca-adapter-delivered-seat.test.mjs의 handle*
// 관례와 동일하게 맞춘다.
function handleTaskList(tasks, forbidTaskList) {
  if (forbidTaskList) {
    throw new Error(
      "must not be called -- the receipt ledger already answered step①, spec fallback must not fire",
    );
  }
  return { ok: true, result: { tasks: tasks ?? [] } };
}
function handleDispatchShow(argv, dispatchByTaskId) {
  const taskId = argv[argv.indexOf("--task") + 1];
  const dispatch = (dispatchByTaskId ?? {})[taskId] ?? null;
  return { ok: true, result: { dispatch } };
}
function handleTerminalList(seats) {
  return {
    ok: true,
    result: {
      terminals: (seats ?? []).map((s) => ({
        handle: s.handle,
        worktreePath: s.worktreePath,
        tabId: s.tabId,
        leafId: s.leafId,
      })),
    },
  };
}
function handleTerminalShow(argv, seats) {
  const handle = argv[argv.indexOf("--terminal") + 1];
  const seat = (seats ?? []).find((s) => s.handle === handle);
  if (!seat) return { ok: false, error: { code: "terminal_handle_stale" } };
  return {
    ok: true,
    result: { terminal: { tabId: seat.tabId, leafId: seat.leafId } },
  };
}

function makeExecFn({ tasks, dispatchByTaskId, seats, forbidTaskList }) {
  return function execFn(argv) {
    if (argv[0] === "orchestration" && argv[1] === "task-list") {
      return handleTaskList(tasks, forbidTaskList);
    }
    if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
      return handleDispatchShow(argv, dispatchByTaskId);
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return handleTerminalList(seats);
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      return handleTerminalShow(argv, seats);
    }
    throw new Error(`makeExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}

// ---- ★재현 시험 필수 ⓐ (coder-task.md §2⑷ⓐ): spec에 worktree: 줄이
// 없어도(실물 모양) 원장이 답하면 정상 판정 -- 수리 전에는 이 표본이
// NO_CANDIDATE_TASK로 막혔다(옛 ①단이 spec만 봤으므로). 수리 후에는 원장이
// 1차라 spec 내용과 무관하게 성립한다. task-list는 아예 호출되지 않는다
// (forbidTaskList -- 폴백 자체가 시도되지 않았다는 것을 직접 증명한다).
test("resolveDeliveredSeat: RECEIPT LEDGER PRIMARY -- realistic ORCH prose WITHOUT a worktree: line still resolves via the ledger (spec is never even queried)", () => {
  withFixtureDir("primary-", (dir) => {
    const harnessDir = join(dir, ".harness");
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        runtimeTaskId: "task_1",
        assigneePaneKey: paneKeyOf(CODER_SEAT),
      }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = makeExecFn({
      dispatchByTaskId: {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      },
      seats: [CODER_SEAT],
      forbidTaskList: true,
    });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, true);
    assert.equal(r.handle, CODER_SEAT.handle);
    assert.equal(r.runtimeTaskId, "task_1");
  });
});

// CONTRAST (수리 "전" 동작의 직접 재현): 같은 realistic no-worktree spec을
// task-list가 돌려주고, 원장은 아예 구성되지 않은(harnessDir 자체를 안
// 넘긴) 상태 -- 이 경우엔 spec 매칭(폴백)만 있으므로 여전히
// NO_CANDIDATE_TASK다. 위 "PRIMARY" 시험과 대조하면 "무엇이 이 라운드가
// 고친 것인가"가 시험만으로 드러난다.
test("resolveDeliveredSeat: CONTRAST -- same no-worktree-line spec but NO receipt ledger configured falls back to spec matching and still fails (proves the ledger, not a relaxed spec grammar, is what fixed test above)", () => {
  const execFn = makeExecFn({
    tasks: [{ id: "task_1", spec: realisticSpecWithoutWorktreeLine(LABEL) }],
    dispatchByTaskId: {},
    seats: [CODER_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
});

// ---- ★재현 시험 필수 ⓑ: 영수증이 아예 없는 표본(원장은 있지만 이
// harness_task_label과 일치하는 줄이 0건) -- 여전히 닫힌다. task-list는
// 호출되지 않는다("장부가 답했는데 못 찾음"은 폴백하지 않는다, §2⑵ 비타협).
test("resolveDeliveredSeat: reproduction ⓑ -- ledger exists but has ZERO entries for this harness_task_label -> still closed (NO_CANDIDATE_TASK), never falls back to spec", () => {
  withFixtureDir("noreceipt-", (dir) => {
    const harnessDir = join(dir, ".harness");
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        runtimeTaskId: "task_other",
        assigneePaneKey: paneKeyOf(CODER_SEAT),
        harnessTaskLabel: "HYK-413-fixture-UNRELATED",
      }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = makeExecFn({ forbidTaskList: true });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
  });
});

// ---- ★재현 시험 필수 ⓒ: 영수증 2건 이상(재드롭 등으로 같은 라벨이 두 번
// 기록됨) -- 어느 것도 고르지 않고 닫힌다.
test("resolveDeliveredSeat: reproduction ⓒ -- TWO OR MORE receipts match the same harness_task_label -> closed (AMBIGUOUS_CANDIDATE_TASK), never guesses, never falls back to spec", () => {
  withFixtureDir("ambiguous-", (dir) => {
    const harnessDir = join(dir, ".harness");
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        runtimeTaskId: "task_1",
        assigneePaneKey: paneKeyOf(CODER_SEAT),
      }) +
        receiptLine({
          runtimeTaskId: "task_2",
          assigneePaneKey: paneKeyOf(CODER_SEAT),
        }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = makeExecFn({ forbidTaskList: true });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.AMBIGUOUS_CANDIDATE_TASK);
  });
});

// ---- ★재현 시험 필수 ⓓ: 원장은 정확히 1건으로 답했지만(runtimeTaskId
// 확보) 그 assignee_pane_key가 살아있는 좌석 어디와도 안 맞는다(죽은
// 좌석/회전) -- ②③단은 이 라운드에서 안 바뀌었다는 것을 end-to-end로
// 확인한다.
test("resolveDeliveredSeat: reproduction ⓓ -- ledger resolves a unique runtime_task_id, but its assignee_pane_key matches no LIVE seat -> closed (NO_LIVE_SEAT_MATCH), steps②③ unchanged", () => {
  withFixtureDir("deadseat-", (dir) => {
    const harnessDir = join(dir, ".harness");
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        runtimeTaskId: "task_1",
        assigneePaneKey: "dead-tab-uuid:dead-leaf-uuid",
      }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = makeExecFn({
      dispatchByTaskId: {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: "term_long_dead",
          assignee_pane_key: "dead-tab-uuid:dead-leaf-uuid",
          status: "dispatched",
        },
      },
      seats: [CODER_SEAT], // does not match the dead pane key
      forbidTaskList: true,
    });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.NO_LIVE_SEAT_MATCH);
  });
});

// ---- 손상(coder-task.md §2⑴ "손상"): 라벨과 일치하는 줄이 정확히 1건
// 있지만 runtime_task_id 필드 자체가 없다 -- "기록 없음"과 다른 사유
// (MALFORMED_RECEIPT_RECORD)로 닫히고, 역시 spec으로 폴백하지 않는다.
test("resolveDeliveredSeat: damaged receipt -- exactly one matching line but missing runtime_task_id -> closed (MALFORMED_RECEIPT_RECORD), never falls back to spec", () => {
  withFixtureDir("malformed-", (dir) => {
    const harnessDir = join(dir, ".harness");
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        assigneePaneKey: paneKeyOf(CODER_SEAT),
        omitRuntimeTaskId: true,
      }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = makeExecFn({ forbidTaskList: true });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, DELIVERED_SEAT_REASON.MALFORMED_RECEIPT_RECORD);
  });
});

// ---- 인프라 실패만 폴백(coder-task.md §2⑵): 포인터 파일이 가리키는
// 경로가 실은 디렉터리라 읽기 자체가 실패(EISDIR) -- 이건 "조회 자체가
// 안 됨"이므로 spec 매칭으로 물러난다. 여기서는 그 폴백이 실제로 정상
// 후보를 찾아 성공까지 가는 것을 확인한다(fallback이 살아 있다는 것).
test("resolveDeliveredSeat: infra failure (ledger path points at a directory, unreadable) falls back to spec matching, and the fallback still resolves normally", () => {
  withFixtureDir("readfail-", (dir) => {
    const harnessDir = join(dir, ".harness");
    const notAFile = join(dir, "not-a-file-its-a-dir");
    mkdirSync(notAFile, { recursive: true });
    writePointer(harnessDir, notAFile);
    const execFn = makeExecFn({
      tasks: [
        {
          id: "task_1",
          spec: `role: CODER\nharness_label: ${LABEL}\nworktree: ${WORKTREE}\ntask_file: .harness/coder-task.md\n요지: (시험용 축약).`,
        },
      ],
      dispatchByTaskId: {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      },
      seats: [CODER_SEAT],
    });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, true);
    assert.equal(r.handle, CODER_SEAT.handle);
  });
});

// ---- 인프라 실패만 폴백, 그 두 번째 경로: harnessDir은 넘겼지만 포인터
// 파일 자체가 아예 없다(RECEIPT_PATH_UNSET) -- 역시 spec 폴백이 발동한다.
test("resolveDeliveredSeat: infra failure (harnessDir given but no dispatch-receipt-path.txt pointer file exists there) falls back to spec matching", () => {
  withFixtureDir("nopointer-", (dir) => {
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true }); // dir exists, pointer file does not
    const execFn = makeExecFn({
      tasks: [
        {
          id: "task_1",
          spec: `role: CODER\nharness_label: ${LABEL}\nworktree: ${WORKTREE}\ntask_file: .harness/coder-task.md\n요지: (시험용 축약).`,
        },
      ],
      dispatchByTaskId: {
        task_1: {
          id: "dispatch_1",
          task_id: "task_1",
          assignee_handle: CODER_SEAT.handle,
          assignee_pane_key: paneKeyOf(CODER_SEAT),
          status: "dispatched",
        },
      },
      seats: [CODER_SEAT],
    });
    const r = resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
    assert.equal(r.ok, true);
    assert.equal(r.handle, CODER_SEAT.handle);
  });
});

// ---- ★완료조건4 (coder-task.md §3): "미열거 실패의 기본값 = 닫힘"을
// 직접 고정한다. resolveCandidateDispatchTask는 오직 RECEIPT_PATH_UNSET/
// RECEIPT_READ_FAILED 두 코드만 infra:true로 표시한다 -- 그 목록에 없는
// 실패(여기서는 이미 존재하는 세 코드: NO_CANDIDATE_TASK/
// AMBIGUOUS_CANDIDATE_TASK/MALFORMED_RECEIPT_RECORD)는 전부 위에서 이미
// "task-list가 호출되지 않았다"로 확인했다 -- 이 시험은 그 표를 한 곳에
// 모아, 새 실패 코드가 실수로 infra 허용목록에 추가되지 않는 한 이 성질이
// 구조적으로 유지된다는 것을 보인다(허용목록이 딱 2개뿐이라는 사실 자체
// 를 목록으로 재확인).
test("resolveDeliveredSeat: unlisted-failure-defaults-closed -- only RECEIPT_PATH_UNSET/RECEIPT_READ_FAILED permit the spec fallback; every other receipt-ledger failure reason observed above already proved task-list is never called", () => {
  const INFRA_FALLBACK_ALLOWED = new Set([
    DELIVERED_SEAT_REASON.RECEIPT_PATH_UNSET,
    DELIVERED_SEAT_REASON.RECEIPT_READ_FAILED,
  ]);
  const CLOSED_NO_FALLBACK = new Set([
    DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK,
    DELIVERED_SEAT_REASON.AMBIGUOUS_CANDIDATE_TASK,
    DELIVERED_SEAT_REASON.MALFORMED_RECEIPT_RECORD,
  ]);
  for (const code of CLOSED_NO_FALLBACK) {
    assert.equal(
      INFRA_FALLBACK_ALLOWED.has(code),
      false,
      `${code} must NOT be in the infra-fallback allowlist`,
    );
  }
  assert.equal(INFRA_FALLBACK_ALLOWED.size, 2);
});
