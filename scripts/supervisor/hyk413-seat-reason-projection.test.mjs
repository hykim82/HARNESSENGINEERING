// HYK-413-seat-binding-2 (2R 수리, 검토 P2-1 원문): "어댑터에서만 갈라
// 놓고 상위에서 다시 하나로 접히면 «감사에서 구별»이 아니다"는 지적에
// 대한 직접 답 -- orca-adapter.mjs의 resolveDeliveredSeat가 이제 세
// 갈래(ⓐ 원장에 기록 자체 없음/ⓑ 원장 인프라 실패로 spec 폴백까지
// 갔는데 spec도 못 찾음/ⓒ 원장이 유일하게 답했지만 좌석이 죽음·회전)를
// 서로 다른 reasonCode로 낸다는 것은 orca-adapter-receipt-ledger.test.mjs
// 가 이미 증명했다. 이 파일은 그 세 갈래가 **감시기 투영 지점**
// (scripts/supervisor/orch-stall-detect.mjs의
// resolveObservationWithDeliveredSeatFallback ->
// observationReasonForClosedCorrelation)을 통과한 뒤에도 서로 다른
// `observationReason`으로 남아 있는지를, **프로덕션 진입점**
// (judgeSeatLivenessForRepo)으로 직접 구동해 확인한다(어댑터 단위
// 시험만으로 끝내지 않는다, coder-task.md §2⑴ "투영 지점까지 확인하라").
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 os.tmpdir() 아래 mkdtemp
// 디렉터리에만 쓴다(HYK-394-test-leak-3 §2 Q1 실사고 재현 방지).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeSeatLivenessForRepo,
  SEAT_LIVENESS_WIRE_STATUS,
} from "./orch-stall-detect.mjs";
import {
  SEAT_LIVENESS_OBSERVATION_REASON,
  DELIVERED_SEAT_REASON,
} from "../relay/adapters/orca-adapter.mjs";

const SCRATCH_ROOT = join(tmpdir(), "hyk413-seat-projection-scratch");

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

const LABEL = "HYK-413-projection-fixture-1";
const NOW = Date.parse("2026-09-02T04:00:00.000Z");

const CODER_SEAT = {
  handle: "term_coder",
  tabId: "b7011967-041a-45e4-843c-0cf8e2ccd418",
  leafId: "ecdf87c2-a552-4370-9ecf-98d455404f0a",
};
function paneKeyOf(seat) {
  return `${seat.tabId}:${seat.leafId}`;
}

function receiptLine({
  runtimeTaskId,
  assigneePaneKey,
  harnessTaskLabel = LABEL,
}) {
  return (
    JSON.stringify({
      recorded_at: "2026-09-02T03:24:19.983Z",
      runtime_task_id: runtimeTaskId,
      dispatch_id: "ctx_fixture",
      assignee_pane_key: assigneePaneKey,
      dispatch_timestamp_utc: "2026-09-02 03:24:18",
      dispatch_timestamp_source: "response.dispatched_at",
      role: "CODER",
      harness_task_label: harnessTaskLabel,
    }) + "\n"
  );
}

function writePointer(harnessDir, ledgerPath) {
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "dispatch-receipt-path.txt"),
    ledgerPath,
    "utf8",
  );
}

function activeDispatch(droppedAtMs = NOW - 60_000) {
  return [
    {
      path: ".harness/coder-task.md",
      taskId: LABEL,
      droppedAtMs,
      resultFile: { exists: false },
    },
  ];
}

// ---- ⓐ: 원장에 이 라벨 기록 자체가 없다 -- execFn은 절대 불리지 않는다
// (원장이 직접 답하므로 task-list/dispatch-show/terminal 조회 전부 불필요).
test("judgeSeatLivenessForRepo (production entry point): ⓐ ledger genuinely absent -> observationReason=NO_DELIVERY_RECORD, correlation.reasonCode=NO_CANDIDATE_TASK", () => {
  withFixtureDir("proj-a-", (repoRoot) => {
    const harnessDir = join(repoRoot, ".harness");
    const ledgerPath = join(repoRoot, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        runtimeTaskId: "task_unrelated",
        assigneePaneKey: paneKeyOf(CODER_SEAT),
        harnessTaskLabel: "HYK-413-projection-fixture-UNRELATED",
      }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = () => {
      throw new Error("must not be called -- the ledger already answered ⓐ");
    };
    const r = judgeSeatLivenessForRepo(
      { repoRoot, droppedTaskFiles: activeDispatch(), now: NOW },
      { execFn },
    );
    assert.equal(r.status, SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED);
    assert.equal(
      r.observationReason,
      SEAT_LIVENESS_OBSERVATION_REASON.NO_DELIVERY_RECORD,
    );
    assert.equal(r.correlation.ok, false);
    assert.equal(
      r.correlation.reasonCode,
      DELIVERED_SEAT_REASON.NO_CANDIDATE_TASK,
    );
  });
});

// ---- ⓑ: 원장 경로 자체가 미설정(인프라 실패) -> spec 폴백까지 갔는데
// spec도 이 라벨+워크트리를 못 찾는다.
test("judgeSeatLivenessForRepo (production entry point): ⓑ ledger infra-unset + spec fallback ALSO finds nothing -> observationReason=SPEC_FALLBACK_NO_MATCH, correlation.reasonCode=SPEC_FALLBACK_NO_CANDIDATE_TASK", () => {
  withFixtureDir("proj-b-", (repoRoot) => {
    // .harness/dispatch-receipt-path.txt를 아예 안 둔다 -- RECEIPT_PATH_UNSET.
    const execFn = (argv) => {
      if (argv[0] === "orchestration" && argv[1] === "task-list") {
        return { ok: true, result: { tasks: [] } };
      }
      throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
    };
    const r = judgeSeatLivenessForRepo(
      { repoRoot, droppedTaskFiles: activeDispatch(), now: NOW },
      { execFn },
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
});

// ---- ⓒ: 원장이 유일하게 답했지만(runtimeTaskId 확보) 그 pane key가
// 살아있는 좌석 어디와도 안 맞는다(죽은 좌석/회전).
test("judgeSeatLivenessForRepo (production entry point): ⓒ ledger resolves uniquely but the seat is dead/rotated -> observationReason=DELIVERY_RECORD_NO_MATCH, correlation.reasonCode=NO_LIVE_SEAT_MATCH", () => {
  withFixtureDir("proj-c-", (repoRoot) => {
    const harnessDir = join(repoRoot, ".harness");
    const ledgerPath = join(repoRoot, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      receiptLine({
        runtimeTaskId: "task_1",
        assigneePaneKey: "dead-tab-uuid:dead-leaf-uuid",
      }),
      "utf8",
    );
    writePointer(harnessDir, ledgerPath);
    const execFn = (argv) => {
      if (argv[0] === "orchestration" && argv[1] === "dispatch-show") {
        return {
          ok: true,
          result: {
            dispatch: {
              id: "dispatch_1",
              task_id: "task_1",
              assignee_handle: "term_long_dead",
              assignee_pane_key: "dead-tab-uuid:dead-leaf-uuid",
              status: "dispatched",
            },
          },
        };
      }
      if (argv[0] === "terminal" && argv[1] === "list") {
        return {
          ok: true,
          result: {
            terminals: [
              {
                handle: CODER_SEAT.handle,
                worktreePath: repoRoot,
                tabId: CODER_SEAT.tabId,
                leafId: CODER_SEAT.leafId,
              },
            ],
          },
        };
      }
      if (argv[0] === "terminal" && argv[1] === "show") {
        return {
          ok: true,
          result: {
            terminal: { tabId: CODER_SEAT.tabId, leafId: CODER_SEAT.leafId },
          },
        };
      }
      throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
    };
    const r = judgeSeatLivenessForRepo(
      { repoRoot, droppedTaskFiles: activeDispatch(), now: NOW },
      { execFn },
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
});

// ---- ★완료조건1 (coder-task.md §3): 세 갈래가 «투영 지점에서» 서로
// 페어와이즈로 다른 값이라는 것을 한 시험에 모아 고정한다(위 세 시험이
// 이미 개별로 증명했지만, 그 문자열들이 실제로 셋 다 다르다는 것 자체를
// 별도로 못박는다 -- "우연히 두 값이 같아졌다"는 회귀를 이 시험 하나가
// 잡는다).
test("★ audit distinguishability at the SUPERVISOR PROJECTION point: ⓐ/ⓑ/ⓒ observationReason values are pairwise distinct", () => {
  const values = new Set([
    SEAT_LIVENESS_OBSERVATION_REASON.NO_DELIVERY_RECORD,
    SEAT_LIVENESS_OBSERVATION_REASON.SPEC_FALLBACK_NO_MATCH,
    SEAT_LIVENESS_OBSERVATION_REASON.DELIVERY_RECORD_NO_MATCH,
  ]);
  assert.equal(
    values.size,
    3,
    "ⓐ/ⓑ/ⓒ observationReason must be pairwise distinct",
  );
});
