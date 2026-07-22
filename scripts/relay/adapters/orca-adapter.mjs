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

// ---- HYK-170 사이클2 coder-1 (A-1): 좌석 handle 해석 -- E1/E2/E3 근거
// (ORCH 실측, 이 파일 상단 헤더 주석 참조). handle을 기억·운반하지 않고,
// 매번 {role, worktreePath}로부터 `terminal list`를 조회해 그 자리에서
// 새로 해석한다("handle 회전 면역 좌석 참조"). worktreeId는 절대 쓰지
// 않는다(E2 -- 제거된 워크트리의 죽은 좌석이 worktreeId엔 남아 되살아난다).
// 후보는 worktreePath 정규화 일치(canonicalizeForComparison 재사용, coder-2/5
// 원칙 계승) + 고아 아님(isOrphanSeat 재사용)만으로 추린다.
// lastOutputAt/title/connected/writable/배열 순서로 자동 선택하지 않는다
// (정확히 1개일 때만 통과, 0개/2개+는 거부) -- E1(한 워크트리에 좌석이
// 여럿 붙는 게 통상 형태)이 그 이유다.
export const SEAT_HANDLE_REASON = Object.freeze({
  NOT_FOUND: "SEAT_HANDLE_NOT_FOUND",
  AMBIGUOUS: "SEAT_HANDLE_AMBIGUOUS",
  LIST_QUERY_FAILED: "SEAT_HANDLE_LIST_QUERY_FAILED",
});

export function buildTerminalListCommand() {
  return ["terminal", "list", "--json"];
}

// 응답 파싱만 분리(parseWorktreeList와 동형).
export function parseTerminalList(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const list = Array.isArray(response.result?.terminals)
    ? response.result.terminals
    : null;
  return list;
}

function denySeatHandle(seatHandleReason, detail) {
  return { ok: false, seatHandleReason, reason: detail };
}

// ctx: { role, worktreePath }. opts: { execFn }. 순수 조합 -- execFn 호출은
// terminal list 조회 1건뿐, 부작용(dispatch/send/close 등) 호출은 이
// 함수에서 절대 일어나지 않는다(A5 인수조건: 0개/2개+ 실패에서도 그렇다,
// 애초에 이 함수가 그런 호출을 만들지 않으므로).
export function resolveSeatHandle({ role, worktreePath } = {}, opts = {}) {
  const location = resolveSeatLocation({ role, requestedPath: worktreePath });
  if (!location.ok) {
    return {
      ok: false,
      reason: location.detail,
      locationReason: location.reason,
    };
  }
  const managed = checkWorktreeManaged({ requestedPath: worktreePath }, opts);
  if (!managed.ok) {
    return {
      ok: false,
      reason: managed.detail,
      worktreeReason: managed.reason,
    };
  }
  if (typeof opts.execFn !== "function") {
    return denySeatHandle(
      SEAT_HANDLE_REASON.LIST_QUERY_FAILED,
      "orca-adapter: resolveSeatHandle -- opts.execFn is required to query terminal list",
    );
  }
  let response;
  try {
    response = opts.execFn(buildTerminalListCommand());
  } catch (err) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.LIST_QUERY_FAILED,
      `orca-adapter: resolveSeatHandle -- terminal list query threw (${errText(err)})`,
    );
  }
  const list = parseTerminalList(response);
  if (!list) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.LIST_QUERY_FAILED,
      "orca-adapter: resolveSeatHandle -- terminal list response missing/invalid result.terminals",
    );
  }
  const target = canonicalizeForComparison(worktreePath);
  const candidates = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeForComparison(entry.worktreePath) === target,
  );
  if (candidates.length === 0) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.NOT_FOUND,
      `orca-adapter: resolveSeatHandle -- no seat found for worktreePath '${worktreePath}'`,
    );
  }
  if (candidates.length > 1) {
    return denySeatHandle(
      SEAT_HANDLE_REASON.AMBIGUOUS,
      `orca-adapter: resolveSeatHandle -- ${candidates.length} seats found for worktreePath '${worktreePath}', refusing to guess (E1)`,
    );
  }
  return { ok: true, handle: candidates[0].handle };
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
// HYK-170 사이클2 ②-a coder-1 (D12): 이 빌더는 더 이상 createNewSeat에서
// 호출되지 않는다 -- ⓑ(새 좌석 생성 뒤 기본 탭을 close)가 pm-2에서
// 반려됐기 때문이다(D9 close 권한 변수 + D3 `--tab` 함정 + 불필요 side
// effect, 아래 createNewSeat 주석 참조). argv shape 자체는 실측값이라
// 버리지 않고 순수 빌더+단위시험만 남긴다(조용한 삭제 방지, G8).
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
// HYK-170 사이클2 ②-a coder-1 (D12): 새 워크트리의 기본 shell 탭에 런처
// 명령을 붙여넣는 용도 -- buildSeatSubmitCommand(A2, --enter만)의 argv
// shape를 그대로 확장해 --text를 추가한 것이다. **정직 한계**: `--text`
// 옵션 자체는 이번 2단 라이브 프로브 범위 밖이라 실측되지 않았다 -- fake
// execFn PASS 대상이며 라이브 검증 전에는 UNVERIFIED다(pm-2 §QB).
export function buildSeatLaunchTextCommand(seatHandle, commandText) {
  return [
    "terminal",
    "send",
    "--terminal",
    seatHandle,
    "--text",
    commandText,
    "--json",
  ];
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
// coder-2 (review-1 C1 반려 결함 수리): baseBranch가 없으면(undefined/null/
// 빈 문자열 전부) --base-branch 플래그 자체를 argv에서 생략한다 -- 이전엔
// 항상 붙였고, 미제공 시 undefined가 문자열 "undefined"가 아니라 그대로
// JS 값(null/undefined)으로 배열에 들어가 CLI에 깨진 인자가 전달됐다(실측
// §1: 생략 시 repo 기본 base 사용, 이게 정답이다).
export function buildWorktreeCreateCommand({ name, repoId, baseBranch } = {}) {
  const argv = [
    "worktree",
    "create",
    "--name",
    name,
    "--repo",
    `id:${repoId}`,
    "--setup",
    "skip",
    "--no-parent",
  ];
  if (isNonEmptyString(baseBranch)) {
    argv.push("--base-branch", baseBranch);
  }
  argv.push("--json");
  return argv;
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

// review-1 C1 반려 결함 수리: parseWorktreeCreateResponse는 path와 branch
// 둘 다 요구하지만, 롤백 대상 경로 판정은 branch 없이 path만 있어도 가능해야
// 한다(branch가 비어 있어도 워크트리는 이미 디스크에 만들어져 있다 -- 실측
// 재현: `branch:''`인데도 worktree create 응답은 ok:true). 응답-only 원칙은
// 유지(요청 name으로 경로를 만들지 않는다).
function extractCreatedWorktreePath(response) {
  if (!isPlainObject(response) || response.ok !== true) return null;
  const wt = isPlainObject(response.result) ? response.result.worktree : null;
  const path = isPlainObject(wt) ? wt.path : null;
  return isNonEmptyString(path) ? path : null;
}

// B 순서(태스크 지시 그대로): 생성 -> 응답 경로로 resolveSeatLocation ->
// checkWorktreeManaged. review-1 C1: `worktree create`가 ok:true를 반환한
// 순간부터는 이후 어느 단계에서 실패하든(응답 파싱 실패 포함) 되돌린다 --
// 이전엔 응답 파싱 실패 시 롤백을 건너뛰어 실제로 만들어진 워크트리가
// 누출됐다(재현: branch:'' 응답에서 rm 호출 0건). 롤백 대상은 항상 응답
// 경로(extractCreatedWorktreePath)이지 요청 name이 아니다(변이 죽이기 요구).
// 경로조차 없으면 롤백을 시도하지 않고 그 사실 자체를 steps에 남긴다(조용히
// 삼키지 않는다) -- 롤백 실패도 원래 실패 사유를 덮지 않고 steps에 별도로
// 남긴다.
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

  // created.ok === true 이후의 모든 실패 경로는 이 함수로 되돌린다.
  function rollback(failReason, worktreeReason, extra = {}) {
    const createdPath = extractCreatedWorktreePath(created.response);
    if (!createdPath) {
      steps.push(
        "worktree-rollback-not-possible:no-path-in-response (manual cleanup may be required)",
      );
      return { ok: false, reason: failReason, worktreeReason, steps, ...extra };
    }
    const removal = guardedExec(
      buildWorktreeRemoveCommand(createdPath),
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

  const parsed = parseWorktreeCreateResponse(created.response);
  if (!parsed) {
    return rollback(
      "orca-adapter: WORKTREE_CREATE_FAILED -- response.result.worktree.{path,branch} missing/empty",
      WORKTREE_REASON.CREATE_FAILED,
    );
  }
  if (parsed.warnings.length > 0) {
    steps.push(`worktree-create-warnings:${JSON.stringify(parsed.warnings)}`);
  }
  steps.push("worktree-created");

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

// review-1 C2: 배달 도착의 "거짓 실패" 방지(영수증 §9) -- 마커가 아직 안
// 보여도 좌석이 이미 붙여넣은 내용을 처리 중(codex의 `[Pasted Content`
// 대기 표식)이거나 여러 입력이 큐에 쌓인 상태(`Press up to edit queued
// messages`)라면 붙여넣기 자체는 성공한 것이다 -- 이 경우도 확인으로
// 인정한다.
const BUSY_SIGNALS = Object.freeze([
  "Press up to edit queued messages",
  "[Pasted Content",
]);
export function previewShowsBusySignal(preview) {
  const normalized = normalizePreview(preview);
  return BUSY_SIGNALS.some((signal) => normalized.includes(signal));
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

// HYK-170 사이클2 ②-a coder-1 (D12, pm-2 §QB 채택안 ⓐ): "새 좌석"이라는
// 이름과 달리 이 경로는 더 이상 `terminal create`를 호출하지 않는다 --
// 새 workspace의 기본 shell 탭이 정확히 1개일 때 그 탭에서 사람 소유
// 런처를 text+Enter로 기동한다. 후보 판정은 A-1(resolveSeatHandle)을 그대로
// 재사용한다 -- 0개/2개+ 실패에서도 이 함수 자신은 어떤 side effect
// 호출도 만들지 않는다(resolveSeatHandle 자체의 순수-조합 계약). marker를
// 후보 선택 근거로 쓰지 않는다는 계약도 그대로 승계된다.
//
// ⓑ(새 좌석 생성 뒤 여분 탭 close)는 pm-2에서 반려됐다 -- D9(`terminal
// close` 권한 변수)·D3(`--tab` 함정) 위에 불필요한 생성/삭제 side effect가
// 겹치고, teardown-매사이클과 결합하면 워크트리 오삭제 위험이 커진다(사유
// 보존, G8).
//
// 정직 한계: 기본 shell 탭에서 런처가 올바른 role/engine/env로 장기 실행된
// 라이브 표본은 0건이다 -- 이 경로는 fake execFn PASS 대상이지 라이브
// 준비 완료 주장이 아니다(UNVERIFIED, 실패해도 ⓑ로 자동 강등하지 않는다).
function createNewSeat(role, worktreePath, mainRepoDir, opts, fs, steps) {
  ensureSettingsCopied(mainRepoDir, worktreePath, fs, steps);
  ensureNodeModulesCopied(mainRepoDir, worktreePath, fs, steps);

  const resolved = resolveSeatHandle({ role, worktreePath }, opts);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.SEAT_CREATE_FAILED} -- ${resolved.reason}`,
      seatHandleReason: resolved.seatHandleReason,
    };
  }

  const launched = guardedExec(
    buildSeatLaunchTextCommand(
      resolved.handle,
      buildSeatLauncherCommand(role, worktreePath),
    ),
    opts.execFn,
    REASON.SEAT_CREATE_FAILED,
  );
  if (!launched.ok) return { ok: false, reason: launched.reason };

  const submitted = guardedExec(
    buildSeatSubmitCommand(resolved.handle),
    opts.execFn,
    REASON.SEAT_CREATE_FAILED,
  );
  if (!submitted.ok) return { ok: false, reason: submitted.reason };

  steps.push("seat-launched-in-default-tab");
  return {
    ok: true,
    seatHandle: resolved.handle,
    created: false,
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

// A-2 (HYK-170 사이클2): ensureSeat의 공개 출력 봉투에는 seatHandle이 없다
// -- 내부 헬퍼(tryReuseExistingSeat/createNewSeat)는 여전히 handle을
// 만들어내지만(좌석을 실제로 만들거나 재사용하려면 그 순간엔 필요하다),
// 그 값을 코어로 반환하거나 다른 포트로 운반하지 않는다. deliverTask/
// teardownSeat은 나중에 {role, worktreePath}로 resolveSeatHandle을 통해
// 스스로 다시 조회한다(A-1) -- 이 함수가 만든 handle을 기억해두지 않는다.
function stripSeatHandle(result) {
  if (!isPlainObject(result) || !("seatHandle" in result)) return result;
  const rest = { ...result };
  delete rest.seatHandle;
  return rest;
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
  if (reused) return stripSeatHandle(reused);

  if (typeof opts.execFn !== "function") {
    return {
      ok: false,
      reason:
        "orca-adapter: ensureSeat -- opts.execFn is required to create a new seat",
    };
  }

  if (!isNonEmptyString(c.worktreePath)) {
    return stripSeatHandle(ensureSeatViaCreate(c, opts));
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

  return stripSeatHandle(
    createNewSeat(
      c.role,
      managed.path,
      c.mainRepoDir,
      opts,
      defaultFsDeps(opts),
      [],
    ),
  );
}

// A-2: deliverTask는 더 이상 seatHandle을 입력으로 받지 않는다 -- worktreePath
// (+role)만 받고, 실제 handle은 이 포트 내부에서 A-1(resolveSeatHandle)로
// 그 자리에서 해석한다. opts.existingSeatHandle은 테스트 전용 override
// 경로로만 남긴다(ensureSeat의 기존 existingSeatHandle 전례와 동형) --
// production 호출부(relay-core.mjs)는 이 옵션을 넘기지 않는다.
function validateDeliverInput(c, opts) {
  if (typeof opts.execFn !== "function") {
    return "orca-adapter: deliverTask -- opts.execFn is required";
  }
  if (
    !isNonEmptyString(opts.existingSeatHandle) &&
    !isNonEmptyString(c.worktreePath)
  ) {
    return "orca-adapter: deliverTask -- worktreePath is required";
  }
  return null;
}

function resolveHandleForPort(c, opts, callerLabel) {
  if (isNonEmptyString(opts.existingSeatHandle)) {
    return { ok: true, handle: opts.existingSeatHandle };
  }
  const resolved = resolveSeatHandle(
    { role: c.role, worktreePath: c.worktreePath },
    opts,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `orca-adapter: ${callerLabel} -- ${resolved.reason}`,
      seatHandleReason: resolved.seatHandleReason,
    };
  }
  return { ok: true, handle: resolved.handle };
}

// task-create만(§4-2 검증된 argv 재사용). runtimeTaskId까지 확보 못하면 그
// 사유를 그대로 반환한다. HYK-170 사이클2: 좌석 handle 해석보다 먼저
// 실행한다 -- task-create가 실패하는 시나리오에서 불필요한 terminal-list
// 조회를 하지 않기 위함(순서 자체가 계약은 아니다, 부작용 최소화일 뿐).
function createTask(c, opts) {
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
  return { ok: true, runtimeTaskId };
}

function dispatchToSeat(runtimeTaskId, seatHandle, opts) {
  const dispatched = guardedExec(
    buildDispatchCommand(runtimeTaskId, seatHandle),
    opts.execFn,
    REASON.DISPATCH_FAILED,
  );
  if (!dispatched.ok) return dispatched;
  return { ok: true, runtimeTaskId };
}

// HYK-169-coder-3 (review-1 반려 결함 수리, 계승): confirmPastedFn이 주입된
// 경우 그 **반환값을 판정에 쓴다** -- 호출만 하고 결과를 버리지 않는다.
// `true`(엄격 동일 비교, truthy 비 boolean 오반환 방지)만 확인으로 인정한다.
// 훅이 throw해도 미확인으로 처리(제출 없이 안전하게 실패).
function confirmPasteViaInjectedHook(fn) {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}

// review-1 C2 반려 결함 수리: confirmPastedFn이 주입되지 않으면 이전엔
// 무조건 미확인(false)으로 fail-closed했다 -- 어댑터가 스스로 확인할 방법
// (buildSeatShowCommand/parseSeatPreview)을 갖고 있으면서 쓰지 않은 것이
// 결함이었다("배달 1명령" 완료기준 미달, 영수증 §9). 기본 경로는 어댑터가
// 직접 `terminal show`로 preview를 조회해 판정한다.
//
// 성공 판정은 두 갈래 중 하나만 만족해도 인정한다(영수증 §9 -- "거짓 실패"
// 방지): (a) marker(하네스 task_id)가 preview에 부분 일치로 관측되거나,
// (b) 좌석이 이미 그 내용을 처리 중임을 보여주는 busy 신호(큐 대기/codex
// Pasted-Content 대기 표식)가 보이는 경우. preview는 셸 예측입력으로 문자
// 단위 재그림이 섞이므로 완전 일치는 절대 쓰지 않는다(normalizePreview 후
// 부분 일치만).
//
// 재시도/대기는 순수 함수로 유지 -- opts.confirmMaxAttempts(기본 1)/
// opts.confirmWaitFn(attempt번호를 받는 부작용 없는 콜백, 기본 no-op)으로
// 테스트에서 시각·횟수를 주입할 수 있다. 실 orca 호출 0(전부 opts.execFn 경유).
function confirmPasteViaTerminalShow(seatHandle, marker, opts) {
  if (typeof opts.execFn !== "function") return false;
  const maxAttempts = Number.isSafeInteger(opts.confirmMaxAttempts)
    ? opts.confirmMaxAttempts
    : 1;
  const waitFn =
    typeof opts.confirmWaitFn === "function" ? opts.confirmWaitFn : () => {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) waitFn(attempt);
    let response;
    try {
      response = opts.execFn(buildSeatShowCommand(seatHandle));
    } catch {
      continue;
    }
    const preview = parseSeatPreview(response);
    if (preview === null) continue;
    if (
      previewContainsMarker(preview, marker) ||
      previewShowsBusySignal(preview)
    ) {
      return true;
    }
  }
  return false;
}

// confirmPastedFn이 주입되면 그 훅을 그대로 쓰고(테스트·특수 상황용
// override), 아니면 어댑터의 기본 자기확인 경로로 넘어간다.
function confirmPaste(seatHandle, marker, opts) {
  if (typeof opts.confirmPastedFn === "function") {
    return confirmPasteViaInjectedHook(opts.confirmPastedFn);
  }
  return confirmPasteViaTerminalShow(seatHandle, marker, opts);
}

// B3/B11: codex 좌석만 붙여넣기 확인 후 제출(Enter) -- 실패 시 최대 1회
// 재시도(비타협 제약: 자동 무한 재시도 금지). 붙여넣기 미확인이면 제출
// 호출 0회로 즉시 실패(재시도 상한과 무관 -- 애초에 제출 루프에 진입하지
// 않는다).
function submitWithRetry(seatHandle, runtimeTaskId, marker, opts) {
  if (!confirmPaste(seatHandle, marker, opts)) {
    return {
      ok: false,
      reason: `orca-adapter: ${REASON.PASTE_UNCONFIRMED} -- paste could not be confirmed (neither marker nor a busy signal was observed); submit refused (0 terminal send calls)`,
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
// ctx: { taskId, role, worktreePath, coordinatorHandle }
// opts: { execFn, existingSeatHandle?(테스트 전용 override), confirmPastedFn?,
//         maxRetries?, confirmMaxAttempts?, confirmWaitFn? }
// A-2: seatHandle을 입력으로 받지 않는다 -- {role, worktreePath}로부터
// resolveSeatHandle(A-1)이 그 자리에서 해석한다.
// confirmPastedFn: 테스트·특수 상황용 override 훅. codex(REVIEW) 배달에서만
// 쓰이며, **미주입 시 어댑터가 terminal show로 스스로 확인한다**(review-1
// C2, 이전엔 미주입=무조건 미확인이었다). marker = c.taskId(하네스
// task_id) -- dispatch --inject로 넣은 spec(`go <task_id>`)에 항상 포함된
// 값이라 별도 필드 없이 재사용한다.
export function deliverTask(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateDeliverInput(c, opts);
  if (invalid) return { ok: false, reason: invalid };

  const taskResult = createTask(c, opts);
  if (!taskResult.ok) return taskResult;

  const handleResult = resolveHandleForPort(c, opts, REASON.DISPATCH_FAILED);
  if (!handleResult.ok) return handleResult;
  const seatHandle = handleResult.handle;

  const dispatchResult = dispatchToSeat(
    taskResult.runtimeTaskId,
    seatHandle,
    opts,
  );
  if (!dispatchResult.ok) return dispatchResult;

  if (!needsExplicitSubmit(c.role)) {
    return {
      ok: true,
      runtimeTaskId: dispatchResult.runtimeTaskId,
      submitted: "auto",
      retries: 0,
    };
  }
  return submitWithRetry(
    seatHandle,
    dispatchResult.runtimeTaskId,
    c.taskId,
    opts,
  );
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

// A-2: teardownSeat도 seatHandle을 입력으로 받지 않는다 -- {role,
// worktreePath}(또는 테스트 전용 opts.existingSeatHandle override)만 받고,
// 닫을 handle은 A-1로 그 자리에서 해석한다(워크트리를 지우기 전이라 여전히
// Orca 관리 목록에 남아 있으므로 resolveSeatHandle이 통과한다).
function validateTeardownInput(c, opts) {
  if (typeof opts.execFn !== "function") {
    return "orca-adapter: teardownSeat -- opts.execFn is required";
  }
  if (
    !isNonEmptyString(opts.existingSeatHandle) &&
    !isNonEmptyString(c.worktreePath)
  ) {
    return "orca-adapter: teardownSeat -- worktreePath is required";
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

// ctx: { role, worktreePath, taskId? }
export function teardownSeat(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const invalid = validateTeardownInput(c, opts);
  if (invalid) return { ok: false, reason: invalid };

  const handleResult = resolveHandleForPort(c, opts, REASON.TEARDOWN_FAILED);
  if (!handleResult.ok) return handleResult;

  const closed = guardedExec(
    buildSeatCloseCommand(handleResult.handle),
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
