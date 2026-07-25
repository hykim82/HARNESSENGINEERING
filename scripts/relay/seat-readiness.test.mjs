import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeSeatReadiness, SEAT_READINESS_STATUS } from "./seat-readiness.mjs";

// HYK-171-cycle4a1-1 §5 mutation 원장 -- 각 테스트는 정규화 후보 관측
// 배열 -> 판정 결과(status·selectedHandle 둘 다)를 정확히 센다. 이
// 파일은 judgeSeatReadiness만 구동한다(순수 코어 직접 시험, orca 호출
// 0 -- 이 파일에 execFn/import orca-adapter 없음).

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    handle: "h1",
    state: "shell",
    occupied: undefined,
    observable: true,
    ...overrides,
  };
}

// 1. 빈 기본 셸 1개만 -> NOT_READY.
test("mutation-1: 빈 기본 셸 1개만 -> NOT_READY(빈셸을 agent로 오분류하면 RED)", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "shell-1", state: "shell" })],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.NOT_READY);
  assert.equal(result.selectedHandle, undefined);
});

// 2. 죽은 셸 1개(스크롤백에 옛 agent 마커 남음, tail=PS 프롬프트) -> NOT_READY.
// (마커 잔존을 판단하는 건 어댑터 분류 단계 몫이고, 이 코어 테스트는
// 그 분류 결과가 이미 "shell"로 나왔다는 전제 -- tail-prompt 배제 자체는
// seat-candidate-adapter.test.mjs가 별도로 고정한다.)
test("mutation-2: 죽은 셸(과거 agent 마커 잔존, state=shell) -> NOT_READY(tail-prompt 배제 안 하면 RED)", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "dead-1", state: "shell" })],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.NOT_READY);
  assert.equal(result.selectedHandle, undefined);
});

// 3. 같은 세대 starting -> ready: starting tick엔 READY 아님, ready 되면
// READY(선택 handle 정확).
test("mutation-3a: starting tick -> READY 아님", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "boot-1", state: "starting" })],
  });
  assert.notEqual(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.status, SEAT_READINESS_STATUS.NOT_READY);
});
test("mutation-3b: 같은 handle이 다음 tick에 idle-or-ready -> READY + 정확한 handle", () => {
  const result = judgeSeatReadiness({
    candidates: [
      candidate({ handle: "boot-1", state: "idle-or-ready", occupied: false }),
    ],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.selectedHandle, "boot-1");
});

// 4. 살아있는 agent 2개 -> AMBIGUOUS·자동선택 0.
test("mutation-4: 살아있는 idle agent 2개 -> AMBIGUOUS, selectedHandle undefined", () => {
  const result = judgeSeatReadiness({
    candidates: [
      candidate({ handle: "a", state: "idle-or-ready", occupied: false }),
      candidate({ handle: "b", state: "idle-or-ready", occupied: false }),
    ],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.AMBIGUOUS);
  assert.equal(result.selectedHandle, undefined);
});

// 5. detector capability 없음 / terminal show 실패 -> UNOBSERVABLE
// (fail-open이면 RED -- 즉 아래는 절대 READY/NOT_READY로 떨어지면 안 된다).
test("mutation-5a: candidate.observable=false(예: detector 미주입) -> UNOBSERVABLE", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "u1", state: "unknown", observable: false })],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.UNOBSERVABLE);
  assert.equal(result.selectedHandle, undefined);
});
test("mutation-5b: raw 관측 자체 실패(candidates=null, terminal list/show 실패) -> UNOBSERVABLE", () => {
  const result = judgeSeatReadiness({ candidates: null });
  assert.equal(result.status, SEAT_READINESS_STATUS.UNOBSERVABLE);
});
test("mutation-5c: 다른 후보가 정상 idle이어도 1개라도 unknown이면 전체 UNOBSERVABLE(fail-closed)", () => {
  const result = judgeSeatReadiness({
    candidates: [
      candidate({ handle: "ok", state: "idle-or-ready", occupied: false }),
      candidate({ handle: "bad", state: "unknown", observable: false }),
    ],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.UNOBSERVABLE);
  assert.equal(result.selectedHandle, undefined);
});

// 6. 유일한 정상 idle agent -> READY + 선택 handle 정확.
test("mutation-6: 유일한 정상 idle agent -> READY + 정확한 handle", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "only-1", state: "idle-or-ready", occupied: false })],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.selectedHandle, "only-1");
});

// 7. plain shell(state=shell, TUI 아님) -> NOT_READY (substring-only
// detector가 이걸 idle-or-ready로 잘못 올리면 RED -- 이 코어 테스트는
// 어댑터가 이미 "shell"로 분류해 넘겼다는 전제를 그대로 판정한다).
test("mutation-7: TUI 아닌 plain shell(state=shell) -> NOT_READY", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "plain-1", state: "shell" })],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.NOT_READY);
});

// 8. 정상 TUI + 이미 active dispatch/queued work(occupied:true) -> READY
// 아님("agent alive=dispatchable" mutation RED).
test("mutation-8: idle-or-ready지만 occupied:true(이미 일함) -> READY 아님(NOT_READY)", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "busy-1", state: "idle-or-ready", occupied: true })],
  });
  assert.notEqual(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.status, SEAT_READINESS_STATUS.NOT_READY);
});

// 9. 죽은/빈 셸 여러 개 + 정상 agent 1개 -> READY, 정상 handle에만 선택
// ("raw 후보수 2+면 즉시 AMBIGUOUS" mutation RED).
test("mutation-9: 죽은/빈 셸 다수 + 정상 idle agent 1개 -> READY(정상 handle만)", () => {
  const result = judgeSeatReadiness({
    candidates: [
      candidate({ handle: "dead-a", state: "shell" }),
      candidate({ handle: "dead-b", state: "shell" }),
      candidate({ handle: "boot-c", state: "starting" }),
      candidate({ handle: "good-d", state: "idle-or-ready", occupied: false }),
    ],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.selectedHandle, "good-d");
});

// 10. 정상 1 + 죽은셸 1 -> READY, 죽은 handle 선택 0.
test("mutation-10: 정상 idle 1 + 죽은셸 1 -> READY, 죽은 handle은 선택되지 않음", () => {
  const result = judgeSeatReadiness({
    candidates: [
      candidate({ handle: "dead-1", state: "shell" }),
      candidate({ handle: "good-1", state: "idle-or-ready", occupied: false }),
    ],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.selectedHandle, "good-1");
  assert.notEqual(result.selectedHandle, "dead-1");
});

// paired-good: 유일 정상 idle agent + detector 정상(observable:true) -> READY.
test("paired-good: 유일 idle agent, capability 정상 -> READY·정확 handle", () => {
  const result = judgeSeatReadiness({
    candidates: [
      candidate({ handle: "seat-x", state: "idle-or-ready", occupied: false, observable: true }),
    ],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.READY);
  assert.equal(result.selectedHandle, "seat-x");
});

// ---- 형태 방어(구조적 mutation) ----
test("빈 후보 배열 -> UNOBSERVABLE(관측 자체가 0건이면 NOT_READY로 속단하지 않는다)", () => {
  const result = judgeSeatReadiness({ candidates: [] });
  assert.equal(result.status, SEAT_READINESS_STATUS.UNOBSERVABLE);
});
test("state='agent'(alive지만 busy, idle 아님)만 있으면 READY pool에 안 들어감 -> NOT_READY", () => {
  const result = judgeSeatReadiness({
    candidates: [candidate({ handle: "busy-agent", state: "agent" })],
  });
  assert.equal(result.status, SEAT_READINESS_STATUS.NOT_READY);
});
