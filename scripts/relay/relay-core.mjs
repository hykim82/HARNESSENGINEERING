import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

// HYK-170 사이클2 ②-a coder-1 (D8, pm-2 §S2Δ): task_id 헤더 추출 -- same
// pattern as check/relay-handshake.mjs / check/reject-streak.mjs (재구현이
// 아니라 각 파일이 독립적으로 이미 들고 있는 관용구를 여기서도 반복한다).
const TASK_ID_RE = /^task_id:\s*(\S+)/im;
function extractTaskId(content) {
  const m = typeof content === "string" ? content.match(TASK_ID_RE) : null;
  return m ? m[1] : null;
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

// HYK-170 사이클2 coder-2 (review-1 실결함 수리): 코어는 특정 어댑터가
// A-2(공개 봉투에서 seatHandle 제거)를 지키는지에 기대지 않는다 -- 이
// 코어 자신의 공개 반환 봉투에서 handle류 필드를 얕은 깊이로 스스로
// 제거한다(REVIEW가 비협조 fake ensureSeat로 실측: strip 안 하면 그대로
// 샌다). 이 봉투(seat/delivery)에 중첩 객체를 담을 계약이 없으므로 얕은
// 제거로 충분하다 -- 재귀는 이 봉투 shape에 대한 과잉설계다.
function stripHandleLikeFields(obj) {
  if (!isPlainObject(obj)) return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (/handle/i.test(key)) continue;
    result[key] = value;
  }
  return result;
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

// HYK-170 사이클2 ②-a coder-1 (D8, pm-2 §S2Δ): "목적 파일 존재만 확인"하던
// 이전 검사(단순 existsFn)를 내용보존 배치+재검증으로 교체한다. mainRepoDir가
// 주어지면 그 경로의 원본을 읽어 task_id가 기대값과 결속되는지 먼저 확인한
// 뒤에만 대상 워크트리로 복사하고, 복사본을 다시 읽어 원본과 바이트 단위로
// 같은지 + task_id가 여전히 기대값과 일치하는지 재검증한다. 어느 단계든
// 실패하면 그 이후 단계(복사·이후 seat/deliver)는 진행되지 않는다(side
// effect 0). mainRepoDir가 없으면(호출자가 파일을 이미 손으로 배치한
// 레거시/수동 경로) 기존처럼 존재 여부만 확인한다 -- 이 폴백은 D8이 새로
// 요구하는 계약이 아니라 하위 호환이다.
function placeAndVerifyTaskFile(inp, harnessDir, rolePrefix, fs) {
  const destPath = join(harnessDir, `${rolePrefix}-task.md`);

  if (!isNonEmptyString(inp.mainRepoDir)) {
    if (!fs.existsFn(destPath)) {
      return fail(
        STAGE.TASK_FILE,
        `relay-core: task file not dropped: ${destPath}`,
      );
    }
    return { ok: true };
  }

  const sourcePath = join(inp.mainRepoDir, ".harness", `${rolePrefix}-task.md`);
  if (!fs.existsFn(sourcePath)) {
    return fail(
      STAGE.TASK_FILE,
      `relay-core: task file source missing: ${sourcePath}`,
    );
  }
  const sourceContent = fs.readFileFn(sourcePath, "utf8");
  const sourceTaskId = extractTaskId(sourceContent);
  if (!sourceTaskId || sourceTaskId !== inp.taskId) {
    return fail(
      STAGE.TASK_FILE,
      `relay-core: task file source task_id mismatch (expected '${inp.taskId}', source has '${sourceTaskId ?? "none"}'): ${sourcePath}`,
    );
  }

  fs.mkdirFn(dirname(destPath), { recursive: true });
  fs.copyFileFn(sourcePath, destPath);

  if (!fs.existsFn(destPath)) {
    return fail(
      STAGE.TASK_FILE,
      `relay-core: task file placement failed (destination missing after copy): ${destPath}`,
    );
  }
  const destContent = fs.readFileFn(destPath, "utf8");
  if (destContent !== sourceContent) {
    return fail(
      STAGE.TASK_FILE,
      `relay-core: task file placement verify failed (content mismatch after copy): ${destPath}`,
    );
  }
  const destTaskId = extractTaskId(destContent);
  if (!destTaskId || destTaskId !== inp.taskId) {
    return fail(
      STAGE.TASK_FILE,
      `relay-core: task file placement verify failed (task_id mismatch after copy, expected '${inp.taskId}', got '${destTaskId ?? "none"}'): ${destPath}`,
    );
  }
  return { ok: true };
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

// HYK-170 사이클2 A-2: 좌석 handle을 코어가 운반하지 않는다 -- seat 인자
// 자체를 받지 않는다(어댑터의 ensureSeat 출력 봉투에도 이제 seatHandle이
// 없다). deliverTask는 {role, worktreePath}만으로 스스로 handle을
// 재해석한다(A-1).
function runDeliverStage(adapter, inp, opts) {
  if (typeof adapter.deliverTask !== "function") {
    return fail(STAGE.DELIVER, "relay-core: adapter.deliverTask is required");
  }
  const delivery = adapter.deliverTask(
    {
      taskId: inp.taskId,
      role: inp.role,
      worktreePath: inp.worktreePath,
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
  const fsDeps = {
    existsFn: typeof opts.existsFn === "function" ? opts.existsFn : existsSync,
    readFileFn:
      typeof opts.readFileFn === "function" ? opts.readFileFn : readFileSync,
    mkdirFn: typeof opts.mkdirFn === "function" ? opts.mkdirFn : mkdirSync,
    copyFileFn:
      typeof opts.copyFileFn === "function" ? opts.copyFileFn : copyFileSync,
  };
  const harnessDir = resolveHarnessDir(inp);

  // 멱등 단락: 이전 시도가 이미 handshake까지 완주했다면 재배달하지 않는다.
  const existing = checkExistingHandshake(inp.role, harnessDir);
  if (existing.ok) {
    return { ok: true, status: STATUS.ALREADY_DONE, handshake: existing };
  }

  // D8(pm-2 §S2Δ): task_id+내용 결속 배치·재검증이 끝난 뒤에만 seat/deliver로
  // 진행한다 -- 좌석 준비보다 먼저 실행한다(원본 배치 실패는 애초에 어떤
  // seat/deliver 호출도 만들지 않아야 한다).
  const taskFileStage = placeAndVerifyTaskFile(
    inp,
    harnessDir,
    roleToFilePrefix(inp.role),
    fsDeps,
  );
  if (!taskFileStage.ok) return taskFileStage;

  const seatStage = runSeatStage(a, inp, opts);
  if (!seatStage.ok) return seatStage;

  const deliverStage = runDeliverStage(a, inp, opts);
  if (!deliverStage.ok) return deliverStage;

  const handshake = checkExistingHandshake(inp.role, harnessDir);
  return {
    ok: true,
    status: classifyHandshakeStatus(handshake),
    seat: stripHandleLikeFields(seatStage.seat),
    delivery: stripHandleLikeFields(deliverStage.delivery),
    handshake,
  };
}
