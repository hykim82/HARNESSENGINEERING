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
import { normalizeAbsolute } from "../../check/path-normalize.mjs";

// HYK-169-coder-1: 어댑터 B v1 -- `orca` CLI를 실제로 부르는(spawn) 코드는
// **이 파일에만** 있다(G9). 코어(relay-core.mjs)·CLI(run-step.mjs)는 이 파일이
// 내보내는 포트 4종만 호출하고, `orca` 문자열을 직접 다루지 않는다.
//
// 포트 이름은 HYK-167 pm-1 §2.1 승계: ensureSeat(실행자리) / deliverTask(배달) /
// collectCompletionSignals(감지, 비권위) / teardownSeat(생애주기).
//
// 검증 수준 (정직 요구): task-create/dispatch/check --wait의 argv 형태는
// orca-spike-runner.mjs가 ORCH의 실측(read-only 프로브 + `--help`)으로 이미
// 검증한 값이라 그대로 import해 재사용한다(재구현 금지). HYK-170 coder-1
// (2026-07-22): v1이 "미검증 가정"으로 남겼던 좌석 생성·제출·비차단 조회·
// 좌석 종료·워크트리 생성/제거 6개 함수는 ORCH의 실 CLI 프로브(`--help` +
// 사람 승인 하 합성 워크트리 1회 프로브, 관제실 산출물
// `2026-07-22-hyk170-어댑터Bv2/`)로 전부 실측 근거를 확보했다 -- 추측 argv
// 0. `--agent` 경로(`result.agentTerminalHandle`)만 이번 프로브 범위 밖이라
// 여전히 미실측이며 구현되지 않았다(정직 경계).

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
  PASTE_UNCONFIRMED: "PASTE_UNCONFIRMED",
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

// ---- HYK-169-coder-2: 좌석 위치 정책 (relay-terminal-setup.md §6, 2026-07-22
// 사람 확정) -- 어댑터가 강제한다(문서 규약이 아니라 코드). 근거=HYK-164
// 사고(REVIEW가 관제실 PM/relay 아래에 검증 워크트리를 만들어 경로 판정이
// 깨짐)+HYK-168 첫 실전(REVIEW가 메인 repo에서 실행 = ORCH와 같은 폴더).
export const LOCATION_REASON = Object.freeze({
  ROLE_UNKNOWN: "ROLE_UNKNOWN",
  PATH_REQUIRED: "PATH_REQUIRED",
  MAIN_REPO_FORBIDDEN: "MAIN_REPO_FORBIDDEN",
  CONTROL_ROOM_FORBIDDEN: "CONTROL_ROOM_FORBIDDEN",
  OUTSIDE_WORKSPACES: "OUTSIDE_WORKSPACES",
  WORKSPACES_ROOT_NOT_A_WORKTREE: "WORKSPACES_ROOT_NOT_A_WORKTREE",
  ALLOW: "ALLOW",
});

export const WORKSPACES_ROOT = "C:/Users/Administrator/orca/workspaces";
export const MAIN_REPO_PATH =
  "C:/Users/Administrator/Documents/HARNESSENGINEERING";
export const CONTROL_ROOM_PATH = "D:/문서관리/하네스-관제실";

function denyLocation(reason, detail) {
  return { ok: false, reason, detail };
}

// 대소문자·슬래시 방향·후행 슬래시·`..` 포함까지 정규화한 뒤 비교한다
// (path-normalize.mjs의 normalizeAbsolute 재사용 -- 재구현 금지, HYK-164가
// 이미 겪은 "체크아웃 위치 민감성" 계열 버그를 또 만들지 않는다). 단순
// startsWith 문자열 비교였다면
// `...\orca\workspaces\..\..\Documents\HARNESSENGINEERING`처럼 접두어만
// 맞추고 실제로는 금지 구역을 가리키는 경로가 통과해버린다 -- normalize가
// `..` 세그먼트를 먼저 해소하므로 이 우회가 불가능하다.
//
// ctx: { role, requestedPath } -- 순수 판정, 파일시스템·orca 호출 없음
// (테스트 용이성을 위해 ensureSeat에서 분리).
export function resolveSeatLocation({ role, requestedPath } = {}) {
  if (!isNonEmptyString(role) || !ENGINE_BY_ROLE[role]) {
    return denyLocation(
      LOCATION_REASON.ROLE_UNKNOWN,
      `resolveSeatLocation: unknown role ${JSON.stringify(role)}`,
    );
  }
  if (!isNonEmptyString(requestedPath)) {
    return denyLocation(
      LOCATION_REASON.PATH_REQUIRED,
      "resolveSeatLocation: requestedPath is required",
    );
  }
  const normalized = normalizeAbsolute(requestedPath);
  const lower = normalized.toLowerCase();
  const mainRepoLower = MAIN_REPO_PATH.toLowerCase();
  const controlRoomLower = CONTROL_ROOM_PATH.toLowerCase();
  const workspacesLower = WORKSPACES_ROOT.toLowerCase();

  if (lower === controlRoomLower || lower.startsWith(`${controlRoomLower}/`)) {
    return denyLocation(
      LOCATION_REASON.CONTROL_ROOM_FORBIDDEN,
      `resolveSeatLocation: '${normalized}' is under the control room (${CONTROL_ROOM_PATH}) -- forbidden for all workers`,
    );
  }
  if (lower === mainRepoLower || lower.startsWith(`${mainRepoLower}/`)) {
    return denyLocation(
      LOCATION_REASON.MAIN_REPO_FORBIDDEN,
      `resolveSeatLocation: '${normalized}' is the main repo (${MAIN_REPO_PATH}) -- ORCH-only, workers forbidden`,
    );
  }
  if (!(lower === workspacesLower || lower.startsWith(`${workspacesLower}/`))) {
    return denyLocation(
      LOCATION_REASON.OUTSIDE_WORKSPACES,
      `resolveSeatLocation: '${normalized}' is outside the workspaces root (${WORKSPACES_ROOT})`,
    );
  }
  // review-2 (coder-4): the workspaces root itself is the parent folder, not
  // a worktree -- a seat opened directly there is not tied to any issue
  // checkout at all (B15's actual shape: a seat with no real worktree under
  // it is invisible to Orca's own bookkeeping).
  if (lower === workspacesLower) {
    return denyLocation(
      LOCATION_REASON.WORKSPACES_ROOT_NOT_A_WORKTREE,
      `resolveSeatLocation: '${normalized}' is the workspaces root itself, not a worktree -- a specific issue/verification subfolder is required`,
    );
  }
  return { ok: true, reason: LOCATION_REASON.ALLOW, path: normalized };
}

// ---- HYK-169-coder-4/5 (review-2/review-3 반려 결함 수리): Orca 관리
// 워크트리 확인 ----
// review-2 반려 사유: 위치 정책은 경로 "문자열"만 검사해 `git worktree add`로
// 만든 Orca 미등록 폴더도 조건만 맞으면 통과시켰다(B15 -- Orca가 모르는
// 워크트리에 붙은 좌석은 Orca UI에서 안 보이는 유령 터미널이 된다). 좌석을
// 열기 전에 `worktree list`로 대상 경로가 실제 등록돼 있는지 대조한다.
//
// coder-5 (review-3 반려, 사람 결정 2026-07-22): coder-4가 만든
// `buildWorktreeCreateCommand`(`--path` 옵션)는 **실제 CLI에 없는 옵션을
// 지어낸 것**이었다(실 CLI는 `--name` 기반) -- "실 orca 호출 0" 제약
// 아래서는 argv를 검증할 방법이 없어 추측이 틀렸다. **생성 기능은 v1
// 범위에서 제거한다** -- 워크트리 생성은 당분간 ORCH가 손으로 하고, 실물
// CLI 검증 후 별도 이슈(후속, ORCH가 신설)로 되돌아온다. 이 어댑터는
// "관리 워크트리인지 확인하고, 아니면 거부"까지만 한다(`allowCreate` 옵션·
// `buildWorktreeCreateCommand`·생성 분기 전부 삭제 -- 조용한 삭제 방지를
// 위해 이 주석에 사유를 남긴다).
// HYK-170 coder-1 (§B): 생성 기능 복원 -- v1이 제거했던 CREATE_FAILED류를
// 다시 추가한다(실측 근거로 조용히 되살리는 것이 아니라 이 주석에 사유를
// 남긴다). 생성 후 위치/등록 검증 중 하나라도 실패하면 만든 워크트리를
// 남기지 않고 되돌린다(fail-closed, createManagedWorktree의 rollback()).
// 되돌리기 자체의 성패는 `steps`에 문자열로 기록한다(정직 요구: 삼켜서
// "성공"처럼 보이게 하지 않는다) -- worktreeReason 자체는 원래 실패 사유
// (CREATE_LOCATION_REJECTED/CREATE_NOT_MANAGED_AFTER_CREATE)를 유지한다.
export const WORKTREE_REASON = Object.freeze({
  LIST_QUERY_FAILED: "WORKTREE_LIST_QUERY_FAILED",
  NOT_ORCA_MANAGED: "WORKTREE_NOT_ORCA_MANAGED",
  CREATE_FAILED: "WORKTREE_CREATE_FAILED",
  CREATE_LOCATION_REJECTED: "WORKTREE_CREATE_LOCATION_REJECTED",
  CREATE_NOT_MANAGED_AFTER_CREATE: "WORKTREE_CREATE_NOT_MANAGED_AFTER_CREATE",
});

export function buildWorktreeListCommand() {
  return ["worktree", "list", "--json"];
}

function denyWorktree(reason, detail) {
  return { ok: false, reason, detail };
}

// 응답 파싱만 분리(테스트 용이성 -- parseRuntimeTaskId 전례와 동형).
export function parseWorktreeList(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const list = Array.isArray(response.result?.worktrees)
    ? response.result.worktrees
    : null;
  return list;
}

function queryWorktreeList(opts) {
  if (typeof opts.execFn !== "function") {
    return denyWorktree(
      WORKTREE_REASON.LIST_QUERY_FAILED,
      "checkWorktreeManaged: opts.execFn is required to query worktree list",
    );
  }
  let response;
  try {
    response = opts.execFn(buildWorktreeListCommand());
  } catch (err) {
    return denyWorktree(
      WORKTREE_REASON.LIST_QUERY_FAILED,
      `checkWorktreeManaged: worktree list query threw (${errText(err)})`,
    );
  }
  const list = parseWorktreeList(response);
  if (!list) {
    return denyWorktree(
      WORKTREE_REASON.LIST_QUERY_FAILED,
      "checkWorktreeManaged: worktree list response missing/invalid result.worktrees",
    );
  }
  return { ok: true, list };
}

// coder-5 (review-3 반려 결함 수리): 드라이브 루트("C:/")는 그대로 두고,
// 그 밖의 모든 경로는 후행 `/`(정규화 후 백슬래시는 이미 슬래시로 바뀌어
// 있다)를 제거해 canonical 형태로 맞춘다. 이게 없으면 등록 목록의 경로가
// 후행 슬래시 유무만 다를 때(예: orca가 `.../wt/`로 보고하고 요청은
// `.../wt`) 실제로 등록된 워크트리를 잘못 거부한다(review-3 실제 재현).
function stripTrailingSeparator(normalized) {
  if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

// 정규화(normalizeAbsolute 재사용, coder-2와 동일 원칙 -- 대소문자·슬래시·
// `..` 우회를 여기서도 다시 겪지 않는다) + 후행 구분자 제거 후 등록 목록과
// 대조.
function canonicalizeForComparison(rawPath) {
  return stripTrailingSeparator(normalizeAbsolute(rawPath).toLowerCase());
}

function isPathManaged(list, requestedPath) {
  const target = canonicalizeForComparison(requestedPath);
  return list.some(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.path) &&
      canonicalizeForComparison(entry.path) === target,
  );
}

// 순수 조합 함수 -- ctx: { requestedPath }, opts: { execFn }. 미등록 경로는
// **항상 거부**(coder-5: 생성 기능 v1 제거, 위 헤더 주석 참조) -- 호출자가
// 어떤 옵션을 넘겨도(예: 이전 `allowCreate`와 같은 이름의 인자) 무시되고
// 거부된다(생성 유도가 불가능함을 시험으로 고정).
export function checkWorktreeManaged({ requestedPath } = {}, opts = {}) {
  const listResult = queryWorktreeList(opts);
  if (!listResult.ok) return listResult;
  if (isPathManaged(listResult.list, requestedPath)) {
    return { ok: true, managed: true, path: requestedPath };
  }
  return denyWorktree(
    WORKTREE_REASON.NOT_ORCA_MANAGED,
    `checkWorktreeManaged: '${requestedPath}' is not a registered Orca worktree -- this port only checks registration, it does not create (see createManagedWorktree for the HYK-170 §B creation path)`,
  );
}

// ---- HYK-170 coder-1: 실측 argv (2단 라이브 프로브, 영수증 §8 대조표
// 그대로) -- v1(HYK-169)이 "미검증 가정"으로 남긴 6개 함수를 전부 실물과
// 대조해 고쳤다. 각 함수 옆 주석의 "실측"은 위 두 영수증 파일의 근거를
// 가리킨다(추측 0).
function buildSeatLauncherCommand(role, worktreePath) {
  return `pwsh -NoExit -File "${SEAT_LAUNCHER_PATH}" -Role ${role} -Worktree "${worktreePath}"`;
}
// A1(실측 §8-1): --shell/--setup 둘 다 존재하지 않는 옵션이었다. 실물은
// `terminal create --worktree <selector> --command "<cmd>" [--title <t>] --json`.
export function buildSeatCreateCommand(role, worktreePath) {
  return [
    "terminal",
    "create",
    "--worktree",
    `path:${worktreePath}`,
    "--command",
    buildSeatLauncherCommand(role, worktreePath),
    "--title",
    role,
    "--json",
  ];
}
// A2(실측 §8-2): --handle 옵션은 없다 -- 실물은 --terminal.
export function buildSeatSubmitCommand(seatHandle) {
  return ["terminal", "send", "--terminal", seatHandle, "--enter", "--json"];
}
// A4(실측 §8-4): 옵션명은 유일하게 정확했다. 단 기본 --unread는 메시지를
// 읽음 처리하므로(다른 소비자 것을 태워버림), 비권위 감지 폴링에는 --peek을
// 추가한다(1단-help.md §5).
export function buildNonBlockingCheckCommand(coordinatorHandle) {
  return [
    "orchestration",
    "check",
    "--terminal",
    coordinatorHandle,
    "--types",
    "worker_done,escalation",
    "--peek",
    "--json",
  ];
}
// A3(실측 §8-3): --handle 없음 -- 실물은 --terminal. **--tab을 붙이면
// 안 된다** -- UI 미채택 pane에서 tab_not_found(exit 1)로 실패한다(실측
// 2단 §4). teardownSeat이 이 실패를 "이미 닫힘"으로 흡수한다.
export function buildSeatCloseCommand(seatHandle) {
  return ["terminal", "close", "--terminal", seatHandle, "--json"];
}
// A6(실측 §8-6): `orchestration dispatch-cleanup` 서브커맨드 자체가 없다
// (`orchestration --help` 실측). 대체 = task-update로 실패 상태 마킹.
// 유효 status = pending/ready/dispatched/completed/failed/blocked. 인자도
// --assignee(handle)이 아니라 **task id**로 바뀐다 -- 호출부(teardownSeat)
// 시그니처를 seatHandle 기반에서 taskId 기반으로 함께 고쳤다.
export function buildTaskUpdateFailedCommand(taskId) {
  return [
    "orchestration",
    "task-update",
    "--id",
    taskId,
    "--status",
    "failed",
    "--json",
  ];
}
// A5(실측 §8-5): git 명령으로 구성해뒀던 것을 폐기 -- Orca
// `worktree rm --worktree path:<p> --force --json` 한 방이 폴더+git등록+
// 브랜치+탭을 전부 제거한다(2단 §4/§6 실측). 실행은 guardedExec을 통해
// 실제로 나간다(구성만 하고 실행 0이던 v1과 다름 -- 이 명령은 orca 명령이라
// git처럼 실행을 미룰 이유가 없다).
export function buildWorktreeRemoveCommand(worktreePath) {
  return [
    "worktree",
    "rm",
    "--worktree",
    `path:${worktreePath}`,
    "--force",
    "--json",
  ];
}

// ---- B: 워크트리 생성 복원 (2단 §1 실측, v1에서 제거됐던 기능) ----
// 비타협: 경로를 요청에 넣지 않는다(--path 옵션 부재, 실측 1단 §1). 이름만
// 주고 응답의 result.worktree.path/branch를 읽는다(추측 조립 금지).
export function buildWorktreeCreateCommand({ name, repoId, baseBranch } = {}) {
  return [
    "worktree",
    "create",
    "--name",
    name,
    "--repo",
    `id:${repoId}`,
    "--setup",
    "skip",
    "--no-parent",
    "--base-branch",
    baseBranch,
    "--json",
  ];
}
// 응답 파싱만 분리(parseWorktreeList/parseRuntimeTaskId 전례와 동형).
// 브랜치명은 런타임이 <github-user>/ 접두를 붙이므로(2단 §1 실측) 반드시
// 이 함수로 응답에서 읽어야 한다 -- 요청 name으로 조립하면 안 된다.
export function parseWorktreeCreateResponse(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const wt = isPlainObject(response.result) ? response.result.worktree : null;
  if (
    !isPlainObject(wt) ||
    !isNonEmptyString(wt.path) ||
    !isNonEmptyString(wt.branch)
  ) {
    return null;
  }
  const warnings = Array.isArray(response.result.warnings)
    ? response.result.warnings
    : [];
  return { path: wt.path, branch: wt.branch, warnings };
}

// B 순서(태스크 지시 그대로): 생성 -> 응답 경로로 resolveSeatLocation ->
// checkWorktreeManaged. 하나라도 실패하면 만든 워크트리를 fail-closed로
// 되돌린다(A5 buildWorktreeRemoveCommand, 되돌리기 실패는 steps에 기록).
// 경로/브랜치 둘 다 **요청이 아니라 응답에서만** 읽는다(변이 죽이기 요구
// -- 요청 name으로 조립하면 이 함수를 우회할 수 없다).
export function createManagedWorktree(
  { role, name, repoId, baseBranch } = {},
  opts = {},
) {
  const steps = [];
  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason: "orca-adapter: createManagedWorktree -- opts.execFn is required",
      worktreeReason: WORKTREE_REASON.CREATE_FAILED,
      steps,
    };
  }
  const created = guardedExec(
    buildWorktreeCreateCommand({ name, repoId, baseBranch }),
    opts.execFn,
    "WORKTREE_CREATE_FAILED",
  );
  if (!created.ok) {
    return {
      ok: false,
      reason: created.reason,
      worktreeReason: WORKTREE_REASON.CREATE_FAILED,
      steps,
    };
  }
  const parsed = parseWorktreeCreateResponse(created.response);
  if (!parsed) {
    return {
      ok: false,
      reason:
        "orca-adapter: WORKTREE_CREATE_FAILED -- response.result.worktree.{path,branch} missing/empty",
      worktreeReason: WORKTREE_REASON.CREATE_FAILED,
      steps,
    };
  }
  if (parsed.warnings.length > 0) {
    steps.push(`worktree-create-warnings:${JSON.stringify(parsed.warnings)}`);
  }
  steps.push("worktree-created");

  function rollback(failReason, worktreeReason, extra = {}) {
    const removal = guardedExec(
      buildWorktreeRemoveCommand(parsed.path),
      opts.execFn,
      "WORKTREE_ROLLBACK_FAILED",
    );
    steps.push(
      removal.ok
        ? "worktree-rollback-ok"
        : `worktree-rollback-failed:${removal.reason}`,
    );
    return { ok: false, reason: failReason, worktreeReason, steps, ...extra };
  }

  const location = resolveSeatLocation({ role, requestedPath: parsed.path });
  if (!location.ok) {
    return rollback(location.detail, WORKTREE_REASON.CREATE_LOCATION_REJECTED, {
      locationReason: location.reason,
    });
  }

  const managed = checkWorktreeManaged({ requestedPath: parsed.path }, opts);
  if (!managed.ok) {
    return rollback(
      managed.detail,
      WORKTREE_REASON.CREATE_NOT_MANAGED_AFTER_CREATE,
    );
  }

  return {
    ok: true,
    path: parsed.path,
    branch: parsed.branch,
    warnings: parsed.warnings,
    steps,
  };
}

// ---- D: 좌석 생사 판정 (2단 §5 실측) ----
// 제거된 워크트리에 붙어 있던 좌석은 connected:true/writable:true인 채로
// terminal list에 남는다 -- 단 worktreePath가 빈 문자열이다. 생사는
// connected/writable이 아니라 worktreePath 비어있음으로만 판정한다.
// 정직 경계: 이건 터미널 칸(pane) 수준 신호다. HYK-163 2A가 UNVERIFIED로
// 남긴 에이전트 인스턴스 수준 liveness는 이걸로 닫히지 않는다.
export function isOrphanSeat({ worktreePath } = {}) {
  return worktreePath === "";
}
// 부수 판별식(2단 §7 실측): UI 미채택 좌석("유령 터미널")의 tabId는
// `pty:`로 시작한다(UI 채택 탭은 순수 uuid).
export function isGhostTab(tabId) {
  return typeof tabId === "string" && tabId.startsWith("pty:");
}

// ---- C: 배달 도착 확인 (2단 §3 실측) ----
// preview는 원문이 아니다 -- 셸 예측입력으로 문자 단위 재그림이 섞인다.
// 완전 일치 단언은 금지, 정규화(공백 붕괴) 후 마커 부분 일치만 확인한다.
export function buildSeatShowCommand(seatHandle) {
  return ["terminal", "show", "--terminal", seatHandle, "--json"];
}
export function parseSeatPreview(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const preview = response.result?.terminal?.preview;
  return typeof preview === "string" ? preview : null;
}
export function normalizePreview(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}
export function previewContainsMarker(preview, marker) {
  if (!isNonEmptyString(marker)) return false;
  return normalizePreview(preview).includes(marker);
}

// 실측 오류 shape(2단 §4): {ok:false, error:{code, message}} -- 기존
// response.reason 우선 확인 뒤, 없으면 error.message도 본다(tab_not_found
// 판별에 필요). guardedExec에서 분리(복잡도 분산).
function extractFailureDetail(response) {
  if (!isPlainObject(response)) return "response.ok !== true";
  if (isNonEmptyString(response.reason)) return response.reason;
  if (
    isPlainObject(response.error) &&
    isNonEmptyString(response.error.message)
  ) {
    return response.error.message;
  }
  return "response.ok !== true";
}

// task-create/dispatch만 §4-2 화이트리스트를 강제한다(그 외 4종은 이
// 어댑터 자신이 유일한 발신처라 guard를 강제하지 않는다). guardedExec에서
// 분리(복잡도 분산).
function shouldEnforceWhitelist(argv) {
  return (
    Array.isArray(argv) && (argv[1] === "task-create" || argv[1] === "dispatch")
  );
}

// 화이트리스트 통과 + execFn 호출을 한곳에 묶는다(orca-spike-runner.runGuardedStep
// 전례와 동형 -- 이 어댑터 자체 receipts는 호출자가 필요 시 감싼다).
function guardedExec(argv, execFn, failReason) {
  const guard = assertAllowedOrcaCommand(argv);
  if (shouldEnforceWhitelist(argv) && !guard.ok) {
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
    return {
      ok: false,
      reason: `orca-adapter: ${failReason} -- ${extractFailureDetail(response)}`,
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

function isValidCreateSpec(create) {
  return (
    isPlainObject(create) &&
    isNonEmptyString(create.name) &&
    isNonEmptyString(create.repoId)
  );
}

// HYK-170 coder-1 (§B): worktreePath(기존 관리 워크트리 재사용)와
// create(신규 생성 -- name/repoId 필수, baseBranch 선택)는 상호 배타적
// 입력 경로다. 정확히 하나만 필요하다 -- 생성은 명시적으로 opt-in해야
// 하고(암묵적 생성 금지, coder-5 원칙 계승), 아무것도 없으면 실패.
function validateEnsureSeatInput(role, worktreePath, create) {
  if (!isNonEmptyString(role) || !ENGINE_BY_ROLE[role]) {
    return `orca-adapter: ensureSeat -- unknown role ${JSON.stringify(role)}`;
  }
  const hasPath = isNonEmptyString(worktreePath);
  const hasCreate = isValidCreateSpec(create);
  if (!hasPath && !hasCreate) {
    return "orca-adapter: ensureSeat -- worktreePath or a valid create{name,repoId} is required";
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
  // 실측 응답은 result.terminal.{handle,paneKey,surface,tabId}에 있다(2단
  // §2) -- 일부 fixture는 result에 직접 담기도 하므로 양쪽 다 허용한다.
  const terminal = isPlainObject(result.terminal) ? result.terminal : result;
  if (!isNonEmptyString(terminal.handle)) {
    return {
      ok: false,
      reason:
        "orca-adapter: SEAT_CREATE_FAILED -- response.result.terminal.handle missing/empty",
    };
  }
  // surface:"visible"이 아니면 UI가 못 받아 백그라운드 폴백으로 새어나간
  // "유령 터미널"이다(2단 §2 실측) -- fail-closed.
  if (terminal.surface !== "visible") {
    return {
      ok: false,
      reason: `orca-adapter: SEAT_CREATE_FAILED -- response surface is not 'visible' (got ${JSON.stringify(terminal.surface)}), UI did not adopt the seat`,
    };
  }
  steps.push("seat-created");
  return {
    ok: true,
    seatHandle: terminal.handle,
    paneKey: terminal.paneKey ?? null,
    created: true,
    stepsPerformed: steps,
  };
}

// ---- 포트 1: 실행자리(seat) ----
// 좌석 위치 정책(relay-terminal-setup.md §6) -- 재사용/기존 경로 전용. 생성
// 경로(§B)는 경로가 응답에서만 나오므로 createManagedWorktree 내부에서 같은
// 판정을 응답 경로에 대해 수행한다(요청 시점엔 대상 경로 자체가 없다).
// ensureSeat에서 분리(복잡도 분산).
function checkExistingSeatLocation(role, worktreePath) {
  if (!isNonEmptyString(worktreePath)) return null;
  const location = resolveSeatLocation({ role, requestedPath: worktreePath });
  if (location.ok) return null;
  return {
    ok: false,
    reason: location.detail,
    locationReason: location.reason,
  };
}

// D: worktreePath가 빈 문자열인 좌석은 "고아 좌석"이다(connected/writable만
// 으로 생사를 판단하지 않는다, 2단 §5 실측) -- 호출자가 조회해 넘긴 값을
// 순수 판정만 한다(execFn을 부르지 않는다). ensureSeat에서 분리.
function tryReuseExistingSeat(opts) {
  if (!isNonEmptyString(opts.existingSeatHandle)) return null;
  if (isOrphanSeat({ worktreePath: opts.existingSeatWorktreePath })) {
    return {
      ok: false,
      reason: `orca-adapter: ensureSeat -- existingSeatHandle '${opts.existingSeatHandle}' is an orphan seat (worktreePath is empty, HYK-170 §D)`,
    };
  }
  return {
    ok: true,
    seatHandle: opts.existingSeatHandle,
    created: false,
    stepsPerformed: [],
  };
}

// §B: worktreePath가 없고 create가 주어졌으면 새 워크트리부터 만든다(생성
// -> 위치/등록 검증 -> 실패 시 되돌림은 createManagedWorktree 몫). ensureSeat
// 에서 분리(복잡도 분산).
function ensureSeatViaCreate(c, opts) {
  const createResult = createManagedWorktree(
    {
      role: c.role,
      name: c.create.name,
      repoId: c.create.repoId,
      baseBranch: c.create.baseBranch,
    },
    opts,
  );
  if (!createResult.ok) {
    return {
      ok: false,
      reason: createResult.reason,
      worktreeReason: createResult.worktreeReason,
      locationReason: createResult.locationReason,
      stepsPerformed: createResult.steps,
    };
  }
  return createNewSeat(
    c.role,
    createResult.path,
    c.mainRepoDir,
    opts,
    defaultFsDeps(opts),
    [...createResult.steps],
  );
}

// ctx: { role, worktreePath?, create?: {name, repoId, baseBranch?}, mainRepoDir? }
// opts: { execFn, existsFn?, mkdirFn?, copyFileFn?, copyDirFn?, existingSeatHandle?,
//         existingSeatWorktreePath? }
// B2: 좌석 handle은 env에서 읽지 않는다 -- existingSeatHandle은 호출자가
// pane key 조회로 이미 확인한 값만 넘기고, 이 함수는 env를 전혀 참조하지 않는다.
export function ensureSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateEnsureSeatInput(c.role, c.worktreePath, c.create);
  if (invalid) return { ok: false, reason: invalid };

  const locationRejection = checkExistingSeatLocation(c.role, c.worktreePath);
  if (locationRejection) return locationRejection;

  const reused = tryReuseExistingSeat(opts);
  if (reused) return reused;

  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason:
        "orca-adapter: ensureSeat -- opts.execFn is required to create a new seat",
    };
  }

  if (!isNonEmptyString(c.worktreePath)) {
    return ensureSeatViaCreate(c, opts);
  }

  // review-2 (coder-4): 재사용/기존 경로에서는 Orca 관리 워크트리 여부를
  // 확인한다. 등록 확인 실패/미등록 시 A3/A5 복사·좌석 생성 호출은 전혀
  // 일어나지 않는다 -- 이 경로에서 미등록이면 (설계상 §B로 자동 전환하지
  // 않고) 그대로 거부한다(암묵적 생성 금지, coder-5 원칙 계승).
  const managed = checkWorktreeManaged({ requestedPath: c.worktreePath }, opts);
  if (!managed.ok) {
    return {
      ok: false,
      reason: managed.detail,
      worktreeReason: managed.reason,
    };
  }

  return createNewSeat(
    c.role,
    managed.path,
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

// HYK-169-coder-3 (review-1 반려 결함 수리): confirmPastedFn의 **반환값을
// 판정에 쓴다** -- 이전엔 호출만 하고 결과를 버려서 거짓 반환도 제출을
// 막지 못했다(관찰 원장 B11의 실제 사고: 붙여넣기 미완료 상태에서 Enter가
// 나가 빈 프롬프트/잘린 지시가 실행됨). `true`(엄격 동일 비교, truthy 비
// boolean 오반환 방지)만 확인으로 인정한다. 훅이 throw해도 미확인으로
// 처리(제출 없이 안전하게 실패) -- 붙여넣기 여부를 모르는 예외 상황에서
// Enter를 보내는 것보다 항상 낫다.
//
// 기본값(미주입)은 **보수적으로 false** -- "확인됨"을 기본으로 두면 이번
// 결함과 같은 구멍이 그대로 남는다(태스크 지시). 즉 codex 좌석 배달은
// confirmPastedFn을 실제로 주입한 호출자만 제출까지 도달한다.
function confirmPaste(opts) {
  const fn =
    typeof opts.confirmPastedFn === "function"
      ? opts.confirmPastedFn
      : () => false;
  try {
    return fn() === true;
  } catch {
    return false;
  }
}

// B3/B11: codex 좌석만 붙여넣기 확인 후 제출(Enter) -- 실패 시 최대 1회
// 재시도(비타협 제약: 자동 무한 재시도 금지). 붙여넣기 미확인이면 제출
// 호출 0회로 즉시 실패(재시도 상한과 무관 -- 애초에 제출 루프에 진입하지
// 않는다).
function submitWithRetry(seatHandle, runtimeTaskId, opts) {
  if (!confirmPaste(opts)) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.PASTE_UNCONFIRMED} -- confirmPastedFn did not confirm the paste; submit refused (0 terminal send calls)`,
      runtimeTaskId,
    };
  }

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
// (붙여넣기 완료를 확인한 뒤 제출) 훅. codex(REVIEW) 배달에서만 쓰이며,
// **미주입 시 기본은 미확인(false) -- 제출 거부**(coder-3, 보수적 기본값).
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
// tab_not_found(실측 2단 §4 오류 shape: {ok:false, error:{code:"runtime_error",
// message:"tab_not_found"}})는 "이미 닫힌 탭"을 의미한다 -- teardown 실패로
// 취급하지 않는다(§A3 주석 참조, --tab을 안 붙여야 이 경로에서 애초에 덜
// 발생하지만 close가 먼저 불려 이미 닫혔을 가능성은 여전히 있다).
function isTabNotFoundFailure(guardedResult) {
  return (
    !guardedResult.ok &&
    isNonEmptyString(guardedResult.reason) &&
    guardedResult.reason.includes("tab_not_found")
  );
}

function validateTeardownInput(c, opts) {
  if (typeof opts.execFn !== "function") {
    return "orca-adapter: teardownSeat -- opts.execFn is required";
  }
  if (!isNonEmptyString(c.seatHandle)) {
    return "orca-adapter: teardownSeat -- seatHandle is required";
  }
  return null;
}

// A5(실측 2단 §4/§6): worktree rm --force가 폴더+git등록+브랜치+탭을 일괄
// 제거한다 -- 실제로 실행한다(구성만 하던 v1과 다름). worktreePath가 없으면
// 생략(호출자가 워크트리 없는 좌석을 닫는 경우). teardownSeat에서 분리
// (복잡도 분산).
function removeSeatWorktree(worktreePath, execFn) {
  if (!isNonEmptyString(worktreePath)) return null;
  return guardedExec(
    buildWorktreeRemoveCommand(worktreePath),
    execFn,
    REASON.TEARDOWN_FAILED,
  );
}

// A6: 잔여 dispatch가 다음 배달을 막은 전례(태스크 지시) -- best-effort
// 정리, 종료 자체의 성패와 분리해 보고한다. taskId가 없으면(호출자가
// dispatch를 낸 적 없는 좌석) 생략. teardownSeat에서 분리(복잡도 분산).
function cleanupFailedTask(taskId, execFn) {
  if (!isNonEmptyString(taskId)) return null;
  try {
    return execFn(buildTaskUpdateFailedCommand(taskId));
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

// ctx: { seatHandle, worktreePath?, taskId? }
export function teardownSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateTeardownInput(c, opts);
  if (invalid) return { ok: false, reason: invalid };

  const closed = guardedExec(
    buildSeatCloseCommand(c.seatHandle),
    opts.execFn,
    REASON.TEARDOWN_FAILED,
  );
  const closeOk = closed.ok || isTabNotFoundFailure(closed);

  const worktreeRemove = removeSeatWorktree(c.worktreePath, opts.execFn);
  const cleanup = cleanupFailedTask(c.taskId, opts.execFn);

  const worktreeOk = worktreeRemove === null || worktreeRemove.ok;
  return {
    ok: closeOk && worktreeOk,
    reason: !closeOk
      ? closed.reason
      : !worktreeOk
        ? worktreeRemove.reason
        : null,
    cleanup,
    worktreeRemove,
  };
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
