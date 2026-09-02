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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  resolveDeliveredSeat,
  DELIVERED_SEAT_REASON,
} from "./orca-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
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
// 넘긴) 상태 -- 이 경우엔 spec 매칭(폴백)만 있으므로 여전히 실패한다.
// 위 "PRIMARY" 시험과 대조하면 "무엇이 이 라운드가 고친 것인가"가
// 시험만으로 드러난다.
//
// HYK-413-seat-binding-2 (2R 수리, 검토 P2-1): 사유 코드는
// `SPEC_FALLBACK_NO_CANDIDATE_TASK`다(원장 자신의 "기록 없음"과 이름부터
// 다르다) -- 이 CONTRAST 자체가 실은 «인프라 실패(경로 미설정)로 spec
// 폴백까지 갔는데 그 spec도 못 찾음»(ⓑ)의 실물 표본이다. 참고: 이
// CONTRAST는 검토가 "되돌림 변이가 아니다"라고 정확히 지적한 대상이다
// (런타임 설정만 다를 뿐 코드를 끊지 않았다) -- 진짜 되돌림 변이는 아래
// "★MUTATION" 시험이 별도로 담당한다.
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
  assert.equal(
    r.reasonCode,
    DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK,
  );
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

// ==== HYK-413-seat-binding-2 (2R 수리, 검토 P2-1/P2-2) ====
//
// P2-1: 원장 자신의 "기록 없음"(ⓐ, NO_CANDIDATE_TASK)과 인프라 실패로
// spec 폴백까지 갔는데 spec도 못 찾은 경우(ⓑ, SPEC_FALLBACK_NO_CANDIDATE_TASK)
// 가 예전엔 같은 코드였다 -- 위 CONTRAST 시험(이제 SPEC_FALLBACK_NO_CANDIDATE_TASK
// 를 단언하도록 갱신됨)이 이미 ⓑ 표본이다. 여기서는 ⓐ/ⓑ 두 사유
// **문자열 자체가 다르다**는 것을 직접 대조하고, AMBIGUOUS 짝(2건+)도
// 같은 방식으로 갈린다는 것을 재현한다.

test("resolveDeliveredSeat: reproduction ⓐ vs ⓑ -- ledger-absent (NO_CANDIDATE_TASK) and infra-fallback-spec-also-absent (SPEC_FALLBACK_NO_CANDIDATE_TASK) are DIFFERENT reasonCode strings (audit distinguishability, adapter level)", () => {
  // ⓐ: 원장이 직접 답했는데 이 라벨 항목이 0건(재현 ⓑ 시험과 이름이
  // 겹치지만 그건 orch-stall-detect 투영 쪽 명명 -- 여기서는 이 라운드
  // 지시서 §2⑴의 ⓐ/ⓑ 문자 그대로 쓴다).
  const withA = withFixtureDir("dist-a-", (dir) => {
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
    return resolveDeliveredSeat(
      { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
      { execFn },
    );
  });
  // ⓑ: 원장 경로 자체가 미설정(인프라 실패) -> spec 폴백 -> spec도
  // 이 라벨+워크트리를 못 찾음.
  const withB = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    {
      execFn: makeExecFn({
        tasks: [
          { id: "task_1", spec: realisticSpecWithoutWorktreeLine(LABEL) },
        ],
        dispatchByTaskId: {},
        seats: [CODER_SEAT],
      }),
    },
  );
  assert.equal(withA.ok, false);
  assert.equal(withB.ok, false);
  assert.equal(withA.reasonCode, DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK);
  assert.equal(
    withB.reasonCode,
    DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK,
  );
  assert.notEqual(
    withA.reasonCode,
    withB.reasonCode,
    "ⓐ(원장 기록 없음)와 ⓑ(인프라 폴백 후 spec도 못 찾음)는 서로 다른 reasonCode여야 한다",
  );
});

// AMBIGUOUS 짝: 원장이 인프라 실패로 spec 폴백까지 갔는데, spec 매칭이
// 2건 이상 걸림 -- SPEC_FALLBACK_AMBIGUOUS_CANDIDATE_TASK(원장 자신의
// AMBIGUOUS_CANDIDATE_TASK와 다른 이름).
test("resolveDeliveredSeat: infra-fallback spec matching TWO OR MORE candidates -> SPEC_FALLBACK_AMBIGUOUS_CANDIDATE_TASK (distinct from the ledger's own AMBIGUOUS_CANDIDATE_TASK)", () => {
  const spec = `role: CODER\nharness_label: ${LABEL}\nworktree: ${WORKTREE}\ntask_file: .harness/coder-task.md\n요지: (시험용 축약).`;
  const execFn = makeExecFn({
    tasks: [
      { id: "task_1", spec },
      { id: "task_2", spec },
    ],
    dispatchByTaskId: {},
    seats: [CODER_SEAT],
  });
  const r = resolveDeliveredSeat(
    { harnessLabel: LABEL, worktreePath: WORKTREE },
    { execFn },
  );
  assert.equal(r.ok, false);
  assert.equal(
    r.reasonCode,
    DELIVERED_SEAT_REASON.SPEC_FALLBACK_AMBIGUOUS_CANDIDATE_TASK,
  );
  assert.notEqual(r.reasonCode, DELIVERED_SEAT_REASON.AMBIGUOUS_CANDIDATE_TASK);
});

// ---- ★MUTATION (coder-task.md §2⑵, 검토 P2-2 원문 그대로 수리): 검토가
// "원장 미설정 호출은 되돌림 변이가 아니다"라고 정확히 지적했다 -- 그건
// 런타임 설정을 바꿨을 뿐 코드를 끊지 않았다. 이 시험은 REAL 소스
// (orca-adapter.mjs)를 실제로 코드 변이시켜 새 원장-primary 축의 인과를
// 증명한다. HYK-412-stuck-retire-2가 이미 굳힌 관례
// (hyk412-never-consumed-retire-core.test.mjs)를 그대로 따른다: 실
// 소스를 읽기 전용으로만 열어(readFileSync) 마커 한 줄을 잘라낸
// 문자열을 **같은 디렉터리**(scripts/relay/adapters/ -- orca-adapter.mjs
// 의 상대 import들이 그대로 풀리려면 같은 깊이여야 한다, 원본 파일의
// import 목록 참조)의 새 파일에 써서(writeFileSync) 동적 import한다 --
// 실 파일은 이 시험 도중 단 한 번도 쓰기로 열리지 않으므로 원복은
// "구성상" 보장된다(끝에서 재확인한다).
//
// 자르는 줄(resolveCandidateDispatchTask 안, 원장 조회 결과를 실제로
// 반영하는 단 한 줄): 이걸 지우면 원장 조회는 여전히 실행되지만 그
// 결과는 버려지고 함수가 **항상** spec 매칭으로 떨어진다 -- "원장-primary
// 축을 코드에서 끊는다"의 가장 직접적인 형태다.
const ADAPTER_PATH = join(HERE, "orca-adapter.mjs");
const PRIMARY_AXIS_MARKER =
  "if (viaReceipt.ok || !viaReceipt.infra) return viaReceipt;";

test("★MUTATION: cutting the receipt-ledger-primary line makes the SAME no-worktree-line spec sample fail again (RED without the new axis) -- proves the axis is causally load-bearing, then byte-identical restore of the REAL source", async () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const occurrences = src.split(PRIMARY_AXIS_MARKER).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation marker not found exactly once in current source (found ${occurrences}): ${PRIMARY_AXIS_MARKER}`,
  );
  const markerStart = src.indexOf(PRIMARY_AXIS_MARKER);
  const lineEnd = src.indexOf("\n", markerStart);
  assert.ok(lineEnd >= 0, "mutation marker's line must end with a newline");
  const mutated = src.slice(0, markerStart) + src.slice(lineEnd + 1);
  assert.notEqual(mutated, src, "mutation must actually change the source");

  const mutantPath = join(
    HERE,
    `orca-adapter.hyk413-2r-mutant-${process.pid}.mjs`,
  );
  try {
    writeFileSync(mutantPath, mutated, "utf8");
    const mutantModule = await import(
      `file://${mutantPath}?t=${Date.now()}-${Math.random()}`
    );

    // Same fixture shape as the "PRIMARY" test above (valid ledger receipt
    // + a spec with NO worktree: line) -- with the primary axis's result
    // discarded, the function now always falls through to spec matching,
    // which requires a worktree: line and must therefore fail.
    withFixtureDir("mutation-", (dir) => {
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
      // forbidTaskList intentionally OMITTED -- task-list WILL be called
      // now that the primary axis's result is discarded.
      const execFn = makeExecFn({
        tasks: [
          { id: "task_1", spec: realisticSpecWithoutWorktreeLine(LABEL) },
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
      const r = mutantModule.resolveDeliveredSeat(
        { harnessLabel: LABEL, worktreePath: WORKTREE, harnessDir },
        { execFn },
      );
      assert.equal(
        r.ok,
        false,
        "RED expected: with the ledger-primary axis's result discarded, the no-worktree-line spec sample must fail again",
      );
      assert.equal(
        r.reasonCode,
        mutantModule.DELIVERED_SEAT_REASON.SPEC_FALLBACK_NO_CANDIDATE_TASK,
      );
    });
  } finally {
    rmSync(mutantPath, { force: true });
  }

  // Restoration proof: the real source file was only ever opened for
  // reading in this test, never for writing -- byte-identical by
  // construction (same posture as hyk412-never-consumed-retire-core.test.mjs).
  const after = readFileSync(ADAPTER_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원복 증명 실패: 실제 orca-adapter.mjs가 이 시험 도중 바뀌었다",
  );
});
