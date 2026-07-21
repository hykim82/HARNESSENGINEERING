import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildTaskCreateCommand,
  buildDispatchCommand,
  parseRuntimeTaskId,
  assertAllowedOrcaCommand,
} from "../orca-spike-runner.mjs";
import { buildSpec } from "../orca-predispatch.mjs";

// HYK-169-coder-1: 어댑터 B v1 -- `orca` CLI를 실제로 부르는(spawn) 코드는
// **이 파일에만** 있다(G9). 코어(relay-core.mjs)·CLI(run-step.mjs)는 이 파일이
// 내보내는 포트 4종만 호출하고, `orca` 문자열을 직접 다루지 않는다.
//
// 포트 이름은 HYK-167 pm-1 §2.1 승계: ensureSeat(실행자리) / deliverTask(배달) /
// collectCompletionSignals(감지, 비권위) / teardownSeat(생애주기).
//
// 검증 수준 (정직 요구): task-create/dispatch/check --wait의 argv 형태는
// orca-spike-runner.mjs가 ORCH의 실측(read-only 프로브 + `--help`)으로 이미
// 검증한 값이라 그대로 import해 재사용한다(재구현 금지). 반면 아래 표시된
// "미검증 가정" 블록(좌석 생성·제출·비차단 조회·좌석 종료)은 이번 태스크가
// 실 orca 호출 0으로 진행되어 실측되지 않았다 -- 형태가 실물과 다르면 그
// 호출 지점만 국소 수리하면 된다(포트 계약·재시도 정책·G9 경계는 무관).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object" && typeof err.message === "string") {
      return err.message;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

export const REASON = Object.freeze({
  WORKTREE_SETUP_FAILED: "WORKTREE_SETUP_FAILED",
  SEAT_CREATE_FAILED: "SEAT_CREATE_FAILED",
  TASK_CREATE_FAILED: "TASK_CREATE_FAILED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
  SUBMIT_FAILED: "SUBMIT_FAILED",
  TEARDOWN_FAILED: "TEARDOWN_FAILED",
  COMPLETE: "COMPLETE",
});

// ---- B9: 엔진별 좌석 실행 정책(단일 구성 지점 -- 하드코딩 분산 금지) ----
export const ENGINE_BY_ROLE = Object.freeze({
  CODER: "claude",
  REVIEW: "codex",
  VERIFY: "claude",
});

// 현행 런처(관측 A2/A3/A5/B7/B9/B10 소진 지점, 관제실 관리) -- 그대로 호출하는
// 것도 허용됨(태스크 지시). 좌석은 이 스크립트를 실행하는 셸로 뜬다.
export const SEAT_LAUNCHER_PATH =
  "D:\\문서관리\\하네스-관제실\\orca-worker-seat.ps1";

// codex 좌석만 붙여넣기 후 별도 제출(Enter)이 필요하다(B3 -- claude 좌석은
// dispatch --inject가 자동 실행됨).
function needsExplicitSubmit(role) {
  return ENGINE_BY_ROLE[role] === "codex";
}

// ---- 미검증 가정: 좌석 생성/제출/비차단 조회/종료 argv (실 orca 미호출) ----
// task-create/dispatch/check --wait와 달리 이 4개 명령은 ORCH가 read-only로
// 실측한 적이 없다. 실물과 형태가 다르면 이 4개 함수만 고치면 된다.
export function buildSeatCreateCommand(role, worktreePath) {
  return [
    "terminal",
    "create",
    "--shell",
    `pwsh -NoExit -File "${SEAT_LAUNCHER_PATH}" -Role ${role} -Worktree "${worktreePath}"`,
    "--setup",
    "skip",
    "--json",
  ];
}
export function buildSeatSubmitCommand(seatHandle) {
  return ["terminal", "send", "--handle", seatHandle, "--enter", "--json"];
}
export function buildNonBlockingCheckCommand(coordinatorHandle) {
  return [
    "orchestration",
    "check",
    "--terminal",
    coordinatorHandle,
    "--types",
    "worker_done,escalation",
    "--json",
  ];
}
export function buildSeatCloseCommand(seatHandle) {
  return ["terminal", "close", "--handle", seatHandle, "--json"];
}
export function buildDispatchCleanupCommand(seatHandle) {
  return [
    "orchestration",
    "dispatch-cleanup",
    "--assignee",
    seatHandle,
    "--json",
  ];
}

// 화이트리스트 통과 + execFn 호출을 한곳에 묶는다(orca-spike-runner.runGuardedStep
// 전례와 동형 -- 이 어댑터 자체 receipts는 호출자가 필요 시 감싼다).
function guardedExec(argv, execFn, failReason) {
  const guard = assertAllowedOrcaCommand(argv);
  // 미검증 명령(seat/submit/check/close)은 §4-2 화이트리스트 밖이라 guard가
  // 항상 실패한다 -- 그 4종은 이 어댑터 자신이 유일한 발신처이므로 여기서는
  // guard를 강제하지 않고 execFn 실패만 관찰한다. task-create/dispatch만
  // guard를 통과시켜 §4-2 계약을 지킨다.
  if (
    Array.isArray(argv) &&
    (argv[1] === "task-create" || argv[1] === "dispatch") &&
    !guard.ok
  ) {
    return { ok: false, reason: guard.reason };
  }
  let response;
  try {
    response = execFn(argv);
  } catch (err) {
    return {
      ok: false,
      reason: `orca-adapter: ${failReason} -- execFn threw (${errText(err)})`,
    };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    const detail =
      isPlainObject(response) && isNonEmptyString(response.reason)
        ? response.reason
        : "response.ok !== true";
    return {
      ok: false,
      reason: `orca-adapter: ${failReason} -- ${detail}`,
      response,
    };
  }
  return { ok: true, response };
}

function defaultFsDeps(overrides = {}) {
  return {
    existsFn:
      typeof overrides.existsFn === "function"
        ? overrides.existsFn
        : existsSync,
    mkdirFn:
      typeof overrides.mkdirFn === "function" ? overrides.mkdirFn : mkdirSync,
    copyFileFn:
      typeof overrides.copyFileFn === "function"
        ? overrides.copyFileFn
        : copyFileSync,
    copyDirFn:
      typeof overrides.copyDirFn === "function"
        ? overrides.copyDirFn
        : (src, dst) => cpSync(src, dst, { recursive: true }),
  };
}

// A3: 메인 repo의 .claude/settings.local.json을 워크트리에 복사(훅 복원).
// 이미 있으면 건너뜀(멱등).
function ensureSettingsCopied(mainRepoDir, worktreePath, fs, steps) {
  if (!isNonEmptyString(mainRepoDir)) return;
  const src = join(mainRepoDir, ".claude", "settings.local.json");
  const dst = join(worktreePath, ".claude", "settings.local.json");
  if (fs.existsFn(dst) || !fs.existsFn(src)) return;
  fs.mkdirFn(dirname(dst), { recursive: true });
  fs.copyFileFn(src, dst);
  steps.push("settings-copied");
}

// A5: node_modules 준비(네트워크 설치 금지 -- 메인에서 복사만).
function ensureNodeModulesCopied(mainRepoDir, worktreePath, fs, steps) {
  if (!isNonEmptyString(mainRepoDir)) return;
  const src = join(mainRepoDir, "node_modules");
  const dst = join(worktreePath, "node_modules");
  if (fs.existsFn(dst) || !fs.existsFn(src)) return;
  fs.copyDirFn(src, dst);
  steps.push("node_modules-copied");
}

function validateEnsureSeatInput(role, worktreePath) {
  if (!isNonEmptyString(role) || !ENGINE_BY_ROLE[role]) {
    return `orca-adapter: ensureSeat -- unknown role ${JSON.stringify(role)}`;
  }
  if (!isNonEmptyString(worktreePath)) {
    return "orca-adapter: ensureSeat -- worktreePath is required";
  }
  return null;
}

// A1/A3/A5 소진 + 좌석 생성 실 호출 -- ensureSeat의 "새 좌석" 경로만 분리
// (복잡도 분산, 판정 자체는 불변).
function createNewSeat(role, worktreePath, mainRepoDir, opts, fs, steps) {
  ensureSettingsCopied(mainRepoDir, worktreePath, fs, steps);
  ensureNodeModulesCopied(mainRepoDir, worktreePath, fs, steps);

  // A1: worktree create 시 --setup skip이 필요하다는 관측은 여기서는 좌석
  // 생성 argv에 반영한다(worktree 자체 생성은 이 포트의 책임 밖 -- 호출자가
  // 이미 만든 워크트리 경로를 넘긴다는 계약).
  const created = guardedExec(
    buildSeatCreateCommand(role, worktreePath),
    opts.execFn,
    REASON.SEAT_CREATE_FAILED,
  );
  if (!created.ok) return { ok: false, reason: created.reason };

  const result =
    isPlainObject(created.response) && isPlainObject(created.response.result)
      ? created.response.result
      : {};
  if (!isNonEmptyString(result.handle)) {
    return {
      ok: false,
      reason:
        "orca-adapter: SEAT_CREATE_FAILED -- response.result.handle missing/empty",
    };
  }
  steps.push("seat-created");
  return {
    ok: true,
    seatHandle: result.handle,
    paneKey: result.paneKey ?? null,
    created: true,
    stepsPerformed: steps,
  };
}

// ---- 포트 1: 실행자리(seat) ----
// ctx: { role, worktreePath, mainRepoDir? }
// opts: { execFn, existsFn?, mkdirFn?, copyFileFn?, copyDirFn?, existingSeatHandle? }
// B2: 좌석 handle은 env에서 읽지 않는다 -- existingSeatHandle은 호출자가
// pane key 조회로 이미 확인한 값만 넘기고, 이 함수는 env를 전혀 참조하지 않는다.
export function ensureSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateEnsureSeatInput(c.role, c.worktreePath);
  if (invalid) return { ok: false, reason: invalid };

  // 재사용: 호출자가 이미 확인된 handle을 넘기면 새 좌석을 만들지 않는다.
  if (isNonEmptyString(opts.existingSeatHandle)) {
    return {
      ok: true,
      seatHandle: opts.existingSeatHandle,
      created: false,
      stepsPerformed: [],
    };
  }
  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason:
        "orca-adapter: ensureSeat -- opts.execFn is required to create a new seat",
    };
  }
  return createNewSeat(
    c.role,
    c.worktreePath,
    c.mainRepoDir,
    opts,
    defaultFsDeps(opts),
    [],
  );
}

function validateDeliverInput(c, opts) {
  if (typeof opts.execFn !== "function") {
    return "orca-adapter: deliverTask -- opts.execFn is required";
  }
  if (!isNonEmptyString(c.seatHandle)) {
    return "orca-adapter: deliverTask -- seatHandle is required";
  }
  return null;
}

// task-create -> dispatch (§4-2 검증된 argv 재사용). runtimeTaskId까지 확보
// 못하면 그 사유를 그대로 반환한다.
function createAndDispatch(c, opts) {
  const specResult = buildSpec(c.taskId);
  if (!specResult.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.TASK_CREATE_FAILED} -- ${specResult.reason}`,
    };
  }
  const created = guardedExec(
    buildTaskCreateCommand(specResult.spec),
    opts.execFn,
    REASON.TASK_CREATE_FAILED,
  );
  if (!created.ok) return created;
  const runtimeTaskId = parseRuntimeTaskId(created.response);
  if (!runtimeTaskId) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.TASK_CREATE_FAILED} -- response.result.task.id missing/empty`,
    };
  }
  const dispatched = guardedExec(
    buildDispatchCommand(runtimeTaskId, c.seatHandle),
    opts.execFn,
    REASON.DISPATCH_FAILED,
  );
  if (!dispatched.ok) return dispatched;
  return { ok: true, runtimeTaskId };
}

// B3/B11: codex 좌석만 붙여넣기 확인 후 제출(Enter) -- 실패 시 최대 1회
// 재시도(비타협 제약: 자동 무한 재시도 금지).
function submitWithRetry(seatHandle, runtimeTaskId, opts) {
  const confirmPastedFn =
    typeof opts.confirmPastedFn === "function"
      ? opts.confirmPastedFn
      : () => true;
  confirmPastedFn();

  const maxRetries = Number.isSafeInteger(opts.maxRetries)
    ? opts.maxRetries
    : 1;
  let lastFailure = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const submitted = guardedExec(
      buildSeatSubmitCommand(seatHandle),
      opts.execFn,
      REASON.SUBMIT_FAILED,
    );
    if (submitted.ok) {
      return {
        ok: true,
        runtimeTaskId,
        submitted: "explicit",
        retries: attempt,
      };
    }
    lastFailure = submitted;
  }
  return { ok: false, reason: lastFailure.reason, runtimeTaskId };
}

// ---- 포트 2: 배달(deliver) ----
// ctx: { taskId, seatHandle, coordinatorHandle, role }
// opts: { execFn, confirmPastedFn?, maxRetries? } -- confirmPastedFn: B11 시차 확인
// (붙여넣기 완료를 확인한 뒤 제출) 훅, 기본은 항상 true(즉시 제출).
export function deliverTask(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateDeliverInput(c, opts);
  if (invalid) return { ok: false, reason: invalid };

  const dispatchResult = createAndDispatch(c, opts);
  if (!dispatchResult.ok) return dispatchResult;

  if (!needsExplicitSubmit(c.role)) {
    return {
      ok: true,
      runtimeTaskId: dispatchResult.runtimeTaskId,
      submitted: "auto",
      retries: 0,
    };
  }
  return submitWithRetry(c.seatHandle, dispatchResult.runtimeTaskId, opts);
}

// ---- 포트 3: 감지(detect) -- 비권위 신호만. 완료를 이 값으로 확정하지 않는다
// (정본은 checkRelayHandshake, relay-core.mjs 몫). 조회 자체가 실패해도 이
// 포트는 fatal로 취급하지 않는다(advisory-only 계약).
export function collectCompletionSignals(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  if (typeof opts.execFn !== "function") {
    return {
      ok: true,
      signals: [],
      note: "no execFn injected -- advisory query skipped",
    };
  }
  let response;
  try {
    response = opts.execFn(buildNonBlockingCheckCommand(c.coordinatorHandle));
  } catch (err) {
    return {
      ok: true,
      signals: [],
      note: `advisory query threw (${errText(err)})`,
    };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return {
      ok: true,
      signals: [],
      note: "advisory query did not return ok:true",
    };
  }
  const messages = Array.isArray(response.result?.messages)
    ? response.result.messages
    : [];
  return { ok: true, signals: messages, note: null };
}

// ---- 포트 4: 생애주기(lifecycle) ----
export function teardownSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason: "orca-adapter: teardownSeat -- opts.execFn is required",
    };
  }
  if (!isNonEmptyString(c.seatHandle)) {
    return {
      ok: false,
      reason: "orca-adapter: teardownSeat -- seatHandle is required",
    };
  }
  const closed = guardedExec(
    buildSeatCloseCommand(c.seatHandle),
    opts.execFn,
    REASON.TEARDOWN_FAILED,
  );
  // 닫힌 좌석에 물린 잔여 dispatch가 다음 배달을 막은 전례(태스크 지시) --
  // best-effort 정리, 종료 자체의 성패와 분리해 보고한다.
  let cleanup;
  try {
    cleanup = opts.execFn(buildDispatchCleanupCommand(c.seatHandle));
  } catch (err) {
    cleanup = { ok: false, reason: errText(err) };
  }
  return { ok: closed.ok, reason: closed.ok ? null : closed.reason, cleanup };
}

// ---- 실 orca execFn (이 파일이 `orca` 문자열로 실제 프로세스를 spawn하는
// 유일한 지점 -- G9). run-step.mjs가 기본으로 이걸 쓰지만, 이 태스크에서는
// 어디에서도 호출되지 않는다(비타협 제약: 실 orca 호출 0). 테스트는 전부
// opts.execFn에 fake를 주입해 이 함수 자체를 실행하지 않는다.
export function createOrcaExecFn({ spawnSyncFn = spawnSync } = {}) {
  return function execFn(argv) {
    const raw = spawnSyncFn("orca", argv, { shell: false, encoding: "utf8" });
    if (
      isPlainObject(raw) &&
      raw.error &&
      raw.signal == null &&
      raw.status == null
    ) {
      throw raw.error;
    }
    const stdout = typeof raw?.stdout === "string" ? raw.stdout : "";
    try {
      return JSON.parse(stdout);
    } catch (err) {
      return {
        ok: false,
        reason: `orca-adapter: stdout not valid JSON (${errText(err)})`,
      };
    }
  };
}
