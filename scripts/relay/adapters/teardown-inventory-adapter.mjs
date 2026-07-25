import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { TEARDOWN_SCHEMA_VERSION } from "../teardown-core.mjs";

// HYK-171 사이클4b-1 (coder-task.md §2-A) -- teardown 3층(git/orca/dir) +
// 활성참조 + working tree를 **관측만** 하는 어댑터. 파괴 argv 0(worktree
// rm/terminal close 어떤 것도 이 파일에서 만들지 않는다). 전부 읽기
// 조회만: `worktree list --json`(orca 등록)/`worktree list
// --porcelain`(git 등록)/`status --porcelain`(git working tree)/existsFn
// (물리 dir)/`terminal list --json`(활성 좌석 참조).
//
// 정직 한계: `worktree list --json`/`terminal list --json`은 orca-adapter.mjs
// 가 이미 실측(2단 라이브 프로브)한 것과 동일 argv shape를 그대로 쓴다(재
// 구현이 아니라 같은 계약을 이 파일에서도 관측 전용으로 재사용). `git
// worktree list --porcelain`/`git status --porcelain`은 git 표준 CLI라
// 별도 실측이 필요 없다.
//
// 봉투는 versioned다(schemaVersion) -- teardown-core.mjs의 fail-closed
// 스키마 검사가 이 버전을 강제한다. raw handle/pane key/PID는 절대 밖으로
// 내지 않는다(활성참조는 sha256 토큰만).

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// 최소 경로 정규화(백슬래시 -> 슬래시, 소문자, 후행 구분자 제거) --
// orca-adapter.mjs의 canonicalizeForComparison과 동일 원칙이지만, 이
// 파일은 그 파일을 import하지 않는다(순환 의존 방지 -- orca-adapter.mjs가
// 이 파일을 import하는 방향으로 결선된다, §2-C).
function canonicalizePath(rawPath) {
  const posixForm = String(rawPath).replace(/\\/g, "/");
  const normalized = posixPath.normalize(posixForm);
  const lower = normalized.toLowerCase();
  if (/^[a-z]:\/$/.test(lower)) return lower;
  return lower.replace(/\/+$/, "");
}

function hashToken(raw) {
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 32);
}

// 호출자(정책 구성자·테스트)가 policy.protectedTargets를 이 어댑터와
// 동일한 방식으로 계산할 수 있도록 공개한다(재구현으로 인한 불일치 방지).
export function computeCanonicalPathDigest(rawPath) {
  return hashToken(canonicalizePath(rawPath));
}

export function buildOrcaWorktreeListCommand() {
  return ["worktree", "list", "--json"];
}
export function buildOrcaTerminalListCommand() {
  return ["terminal", "list", "--json"];
}
export function buildGitWorktreeListCommand() {
  return ["worktree", "list", "--porcelain"];
}
export function buildGitStatusCommand() {
  return ["status", "--porcelain"];
}
// HYK-171 사이클4b-1 재작업(streak 1, §P1-1 (A)): 시스템 전체 미완료
// dispatch를 관측하기 위한 두 명령. `dispatch-show`의 argv shape는
// seat-signal-adapter.mjs가 이미 실측해 쓰는 것과 동일하지만, 이 파일에서
// 직접 import하지 않는다 -- seat-signal-adapter.mjs가 orca-adapter.mjs를
// import하고 orca-adapter.mjs는 이 파일을 import하므로, 여기서 다시
// seat-signal-adapter.mjs를 끌어오면 3파일 순환 의존(A->B->C->A)이 생긴다.
// 순환을 피하려고 최소 계약(argv 2줄 + 파서)만 이 파일 안에 병렬로 둔다.
export function buildTaskListDispatchedCommand() {
  return ["orchestration", "task-list", "--status", "dispatched", "--json"];
}
export function buildDispatchShowCommand(taskId) {
  return ["orchestration", "dispatch-show", "--task", taskId, "--json"];
}

// ---- orca 등록(3층 중 orca) ----
function observeOrcaLayer(targetCanonical, opts) {
  if (typeof opts.execFn !== "function") {
    return { status: "unobservable", worktreeId: null, ok: false };
  }
  let response;
  try {
    response = opts.execFn(buildOrcaWorktreeListCommand());
  } catch {
    return { status: "unobservable", worktreeId: null, ok: false };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return { status: "unobservable", worktreeId: null, ok: false };
  }
  const list = Array.isArray(response.result?.worktrees)
    ? response.result.worktrees
    : null;
  if (!list) return { status: "unobservable", worktreeId: null, ok: false };
  const match = list.find(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.path) &&
      canonicalizePath(entry.path) === targetCanonical,
  );
  return {
    status: match ? "present" : "absent",
    worktreeId: match && isNonEmptyString(match.id) ? match.id : null,
    ok: true,
  };
}

// ---- git 등록(3층 중 git) ----
function observeGitLayer(targetCanonical, opts) {
  if (typeof opts.gitFn !== "function") {
    return { status: "unobservable", ok: false };
  }
  let output;
  try {
    output = opts.gitFn(buildGitWorktreeListCommand());
  } catch {
    return { status: "unobservable", ok: false };
  }
  if (typeof output !== "string") return { status: "unobservable", ok: false };
  const found = output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalizePath(line.slice("worktree ".length).trim()))
    .includes(targetCanonical);
  return { status: found ? "present" : "absent", ok: true };
}

// ---- 물리 dir(3층 중 dir) ----
function observeDirLayer(worktreePath, opts) {
  if (typeof opts.existsFn !== "function") {
    return { status: "unobservable", ok: false };
  }
  let exists;
  try {
    exists = opts.existsFn(worktreePath);
  } catch {
    return { status: "unobservable", ok: false };
  }
  if (typeof exists !== "boolean") return { status: "unobservable", ok: false };
  return { status: exists ? "present" : "absent", ok: true };
}

// ---- 활성참조 (HYK-171 사이클4b-1 재작업, streak 1, REVIEW review-1 P1-1
// 수리) ----
// REVIEW 실측: 실 `orca terminal list --json`에는 `activeDispatch` 필드가
// 존재하지 않는다(33개 좌석 전부 부재). 그 필드에 의존한 이전 설계는 실
// 입력에서 늘 `observable:true, count:0`으로 접혀 fail-open이었다.
//
// 새 설계는 이 파일의 헤더 주석이 요구하는 (A)+(B)+(C) 조합이다:
//
// (A) 권위 관측: `orchestration task-list --status dispatched`로 미완료
//     dispatch 태스크 id 목록을 얻고, 각각 `orchestration dispatch-show
//     --task <id>`로 그 dispatch의 `assignee_pane_key`를 얻는다. 이 저장소가
//     이미 쓰는 pane key 관용구(`buildPaneKey`, `<tabId>:<leafId>` -- 실측:
//     ORCA_PANE_KEY 환경변수 값이 이 형식과 바이트 단위로 일치함을 이 태스크
//     수행 중 라이브 조회로 재확인했다)로 좌석의 pane key를 계산해 대조한다.
//     대상 워크트리에 붙은 좌석의 pane key가 이 활성-dispatch pane key
//     집합에 있으면 무조건 ACTIVE_REFERENCE(대상 좌석 자신이어도 -- 자기
//     자신에게 아직 안 끝난 dispatch가 물려 있다면 그 자체가 위험 신호다).
// (B) 보수적 보강: 대상 워크트리의 `connected:true` 좌석 중, 호출자가
//     `opts.existingSeatHandle`로 **명시한** 좌석(소유권 증거)이 **아닌**
//     좌석은 전부 활성참조로 센다. 증거가 아예 없으면(existingSeatHandle
//     미제공) 어떤 좌석도 자기 자신이라고 추측하지 않는다 -- 대상 워크트리에
//     연결된 좌석이 하나라도 있으면 그것도 활성참조로 센다(§P1-1 (B) 문구
//     그대로: "증명되지 않으면 활성참조로 센다").
// (C) fail-closed: terminal-list/task-list/dispatch-show 중 하나라도 실패·
//     malformed면 `observable:false`(빈 카운트로 접지 않는다).
function buildPaneKey(tabId, leafId) {
  return isNonEmptyString(tabId) && isNonEmptyString(leafId)
    ? `${tabId}:${leafId}`
    : null;
}

// existingSeatHandle(호출자가 명시한 대상 좌석 식별자)을 terminal list에서
// 찾아 그 pane key를 낸다. 증거가 없거나(handle 미제공) 그 handle이 목록에
// 없으면 null(=자기 자신을 추측하지 않는다, (B) 원칙).
function resolveSelfPaneKey(list, existingSeatHandle) {
  if (!isNonEmptyString(existingSeatHandle)) return null;
  const match = list.find(
    (entry) => isPlainObject(entry) && entry.handle === existingSeatHandle,
  );
  return match ? buildPaneKey(match.tabId, match.leafId) : null;
}

// 실패 감지(FAIL 마커)만 반환하는 헬퍼 -- 호출자가 이 값이면 즉시
// fail-closed한다. 복잡도 분산(collectDispatchActivePaneKeys에서 분리).
const DISPATCH_FETCH_FAILED = Symbol("dispatch-fetch-failed");

// 태스크 id 하나의 dispatch-show를 조회해 pane key(있으면) 또는 null(정당한
// "아직 없음")을 낸다. 조회 자체가 실패/malformed면 DISPATCH_FETCH_FAILED.
function fetchDispatchPaneKey(execFn, taskId) {
  let dispatchResponse;
  try {
    dispatchResponse = execFn(buildDispatchShowCommand(taskId));
  } catch {
    return DISPATCH_FETCH_FAILED;
  }
  if (!isPlainObject(dispatchResponse) || dispatchResponse.ok !== true) {
    return DISPATCH_FETCH_FAILED;
  }
  const paneKey = dispatchResponse.result?.dispatch?.assignee_pane_key;
  return isNonEmptyString(paneKey) ? paneKey : null;
}

// (A): 시스템 전체 미완료 dispatch의 pane key 집합. 하나라도 관측 실패하면
// ok:false(파괴적으로 빈 집합으로 접지 않는다 -- 호출자가 UNOBSERVABLE로
// fail-closed한다). 복잡도 분산: 태스크별 조회는 fetchDispatchPaneKey로
// 분리했다.
function collectDispatchActivePaneKeys(execFn) {
  let response;
  try {
    response = execFn(buildTaskListDispatchedCommand());
  } catch {
    return { ok: false, paneKeys: null };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return { ok: false, paneKeys: null };
  }
  const tasks = Array.isArray(response.result?.tasks)
    ? response.result.tasks
    : null;
  if (!tasks) return { ok: false, paneKeys: null };

  const paneKeys = new Set();
  for (const task of tasks) {
    if (!isPlainObject(task) || !isNonEmptyString(task.id)) {
      return { ok: false, paneKeys: null };
    }
    const paneKey = fetchDispatchPaneKey(execFn, task.id);
    if (paneKey === DISPATCH_FETCH_FAILED) return { ok: false, paneKeys: null };
    if (paneKey !== null) paneKeys.add(paneKey);
  }
  return { ok: true, paneKeys };
}

// 읽기 전용 `terminal list --json` 조회만 분리(복잡도 분산).
function queryTerminalList(execFn) {
  let response;
  try {
    response = execFn(buildOrcaTerminalListCommand());
  } catch {
    return null;
  }
  if (!isPlainObject(response) || response.ok !== true) return null;
  return Array.isArray(response.result?.terminals)
    ? response.result.terminals
    : null;
}

// entry가 활성참조인지 판정(§P1-1 (A)+(B) 결합) -- observeActiveReferences
// 에서 분리(복잡도 분산).
function isActiveReferenceEntry(entry, selfPaneKey, dispatchPaneKeys) {
  const paneKey = buildPaneKey(entry.tabId, entry.leafId);
  const viaDispatch = paneKey !== null && dispatchPaneKeys.has(paneKey);
  const viaConnectedNotSelf =
    entry.connected === true &&
    (selfPaneKey === null || paneKey !== selfPaneKey);
  return { active: viaDispatch || viaConnectedNotSelf, paneKey };
}

function observeActiveReferences(targetCanonical, opts) {
  if (typeof opts.execFn !== "function") {
    return { count: 0, tokens: [], observable: false };
  }
  const list = queryTerminalList(opts.execFn);
  if (!list) return { count: 0, tokens: [], observable: false };

  const dispatchResult = collectDispatchActivePaneKeys(opts.execFn);
  if (!dispatchResult.ok) {
    return { count: 0, tokens: [], observable: false };
  }

  const selfPaneKey = resolveSelfPaneKey(list, opts.existingSeatHandle);
  const worktreeEntries = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      isNonEmptyString(entry.worktreePath) &&
      canonicalizePath(entry.worktreePath) === targetCanonical,
  );

  const activeByPaneKey = new Map();
  for (const entry of worktreeEntries) {
    const { active, paneKey } = isActiveReferenceEntry(
      entry,
      selfPaneKey,
      dispatchResult.paneKeys,
    );
    if (active) activeByPaneKey.set(paneKey ?? entry.handle, entry);
  }

  const active = [...activeByPaneKey.values()];
  return {
    count: active.length,
    tokens: active.map((entry) => hashToken(entry.handle)),
    observable: true,
  };
}

// ---- working tree(git status) ----
function observeWorkingTree(opts) {
  if (typeof opts.gitFn !== "function") {
    return {
      dirty: false,
      untracked: false,
      unmerged: false,
      observable: false,
    };
  }
  let output;
  try {
    output = opts.gitFn(buildGitStatusCommand());
  } catch {
    return {
      dirty: false,
      untracked: false,
      unmerged: false,
      observable: false,
    };
  }
  if (typeof output !== "string") {
    return {
      dirty: false,
      untracked: false,
      unmerged: false,
      observable: false,
    };
  }
  const lines = output.split("\n").filter((line) => line.length > 0);
  const dirty = lines.length > 0;
  const untracked = lines.some((line) => line.startsWith("??"));
  const unmerged = lines.some(
    (line) => line[0] === "U" || line[1] === "U" || line.startsWith("UU"),
  );
  return { dirty, untracked, unmerged, observable: true };
}

// ctx: { worktreePath, repoId? }
// opts: { execFn?, gitFn?, existsFn?, existingSeatHandle? } -- 전부 읽기
// 전용 주입(fake, 실 프로세스 호출 0). existingSeatHandle은 §P1-1 (B)의
// 소유권 증거(대상 좌석 자신의 handle) -- 미제공 시 어떤 좌석도 자기
// 자신이라고 추측하지 않는다.
export function observeTeardownInventory(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const worktreePath = isNonEmptyString(c.worktreePath) ? c.worktreePath : "";
  const targetCanonical = canonicalizePath(worktreePath);

  const orca = observeOrcaLayer(targetCanonical, opts);
  const git = observeGitLayer(targetCanonical, opts);
  const dir = observeDirLayer(worktreePath, opts);
  const activeReferences = observeActiveReferences(targetCanonical, opts);
  const workingTree = observeWorkingTree(opts);

  const sourceOk = {
    git: git.ok,
    orca: orca.ok,
    dir: dir.ok,
    activeReferences: activeReferences.observable,
    workingTree: workingTree.observable,
  };
  const degraded = Object.keys(sourceOk).filter((k) => sourceOk[k] !== true);

  return {
    schemaVersion: TEARDOWN_SCHEMA_VERSION,
    target: {
      canonicalPathDigest: hashToken(targetCanonical),
      worktreeId: orca.worktreeId,
      repoId: isNonEmptyString(c.repoId) ? c.repoId : null,
    },
    layers: { git: git.status, orca: orca.status, dir: dir.status },
    activeReferences: {
      count: activeReferences.count,
      tokens: activeReferences.tokens,
      observable: activeReferences.observable,
    },
    workingTree: {
      dirty: workingTree.dirty,
      untracked: workingTree.untracked,
      unmerged: workingTree.unmerged,
      observable: workingTree.observable,
    },
    observationQuality: {
      git: sourceOk.git ? "ok" : "failed",
      orca: sourceOk.orca ? "ok" : "failed",
      dir: sourceOk.dir ? "ok" : "failed",
      activeReferences: sourceOk.activeReferences ? "ok" : "failed",
      workingTree: sourceOk.workingTree ? "ok" : "failed",
      degraded,
    },
  };
}
