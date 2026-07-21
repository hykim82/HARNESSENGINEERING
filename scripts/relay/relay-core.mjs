import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";
import { classifyWatchFailure } from "./watch-result.mjs";

// HYK-169-coder-1: 엔진 무관 코어 -- 어댑터 객체를 주입받아 한 스텝을
// 진행한다: 좌석 확보 -> 태스크 파일 드롭 확인 -> 배달 -> 핸드셰이크 파일
// 판정 -> 결과 반환. 오케스트레이션 CLI 이름/문자열이 이 파일 어디에도 없다
// (G9 -- 어댑터 포트만 호출한다).
//
// 핸드셰이크 판정은 기존 checkRelayHandshake(정본, 재구현 금지)를 그대로
// 쓰고, 그 ok:false 사유의 config/pending/unjudgable 분류도 watch-result.mjs의
// classifyWatchFailure를 재사용한다(watchResult의 폴링 루프 자체는 재사용하지
// 않는다 -- 이 스텝은 "한 번 진행하고 즉시 반환"이 계약이라, 무한 대기 루프는
// 이 함수의 책임이 아니다. 반복 호출은 CLI를 감싸는 외부 supervisor의 몫).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export const STAGE = Object.freeze({
  SEAT: "seat",
  TASK_FILE: "task-file",
  DELIVER: "deliver",
  HANDSHAKE: "handshake",
});

export const STATUS = Object.freeze({
  ALREADY_DONE: "already-done",
  DELIVERED_PENDING: "delivered-pending",
  DELIVERED_CONFIG_ERROR: "delivered-config-error",
  DELIVERED_UNJUDGABLE: "delivered-unjudgable",
});

function fail(stage, reason) {
  return { ok: false, stage, reason };
}

function roleToFilePrefix(role) {
  return isNonEmptyString(role) ? role.toLowerCase() : role;
}

// 이미 이전 배달이 handshake까지 완주했으면(재실행/재시도 시나리오) 좌석·
// 배달을 다시 건드리지 않고 즉시 done을 반환한다(멱등 -- A4/B14 계열
// vacuous-pass 회피와는 별개로, 헛배달 방지).
function checkExistingHandshake(role, harnessDir) {
  return checkRelayHandshake({ role: roleToFilePrefix(role), harnessDir });
}

function resolveHarnessDir(inp) {
  return isNonEmptyString(inp.harnessDir)
    ? inp.harnessDir
    : join(inp.worktreePath ?? "", ".harness");
}

function classifyHandshakeStatus(handshake) {
  if (handshake.ok) return STATUS.ALREADY_DONE;
  const classification = classifyWatchFailure(handshake.reason);
  if (classification === "config") return STATUS.DELIVERED_CONFIG_ERROR;
  if (classification === "pending") return STATUS.DELIVERED_PENDING;
  return STATUS.DELIVERED_UNJUDGABLE;
}

function runSeatStage(adapter, inp, opts) {
  if (typeof adapter.ensureSeat !== "function") {
    return fail(STAGE.SEAT, "relay-core: adapter.ensureSeat is required");
  }
  const seat = adapter.ensureSeat(
    {
      role: inp.role,
      worktreePath: inp.worktreePath,
      mainRepoDir: inp.mainRepoDir,
    },
    opts,
  );
  return seat.ok ? { ok: true, seat } : fail(STAGE.SEAT, seat.reason);
}

function runDeliverStage(adapter, inp, seat, opts) {
  if (typeof adapter.deliverTask !== "function") {
    return fail(STAGE.DELIVER, "relay-core: adapter.deliverTask is required");
  }
  const delivery = adapter.deliverTask(
    {
      taskId: inp.taskId,
      role: inp.role,
      seatHandle: seat.seatHandle,
      coordinatorHandle: inp.coordinatorHandle,
    },
    opts,
  );
  return delivery.ok
    ? { ok: true, delivery }
    : fail(STAGE.DELIVER, delivery.reason);
}

// input: { role, worktreePath, taskId, harnessDir?, mainRepoDir?, coordinatorHandle? }
// adapter: ensureSeat/deliverTask/collectCompletionSignals/teardownSeat 4종
// (실 어댑터 구현 또는 G10용 fake).
// opts: adapter 포트에 그대로 전달되는 실행 옵션(execFn 등) + existsFn(테스트용).
export function relayStep(input, adapter, opts = {}) {
  const inp = isPlainObject(input) ? input : {};
  const a = isPlainObject(adapter) ? adapter : {};
  const existsFn =
    typeof opts.existsFn === "function" ? opts.existsFn : existsSync;
  const harnessDir = resolveHarnessDir(inp);

  // 멱등 단락: 이전 시도가 이미 handshake까지 완주했다면 재배달하지 않는다.
  const existing = checkExistingHandshake(inp.role, harnessDir);
  if (existing.ok) {
    return { ok: true, status: STATUS.ALREADY_DONE, handshake: existing };
  }

  const seatStage = runSeatStage(a, inp, opts);
  if (!seatStage.ok) return seatStage;

  const taskFilePath = join(
    harnessDir,
    `${roleToFilePrefix(inp.role)}-task.md`,
  );
  if (!existsFn(taskFilePath)) {
    return fail(
      STAGE.TASK_FILE,
      `relay-core: task file not dropped: ${taskFilePath}`,
    );
  }

  const deliverStage = runDeliverStage(a, inp, seatStage.seat, opts);
  if (!deliverStage.ok) return deliverStage;

  const handshake = checkExistingHandshake(inp.role, harnessDir);
  return {
    ok: true,
    status: classifyHandshakeStatus(handshake),
    seat: seatStage.seat,
    delivery: deliverStage.delivery,
    handshake,
  };
}
