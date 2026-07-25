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

// ---- 활성참조(터미널 목록에서 이 워크트리에 붙은, 아직 살아있는 dispatch를
// 물고 있는 좌석) ----
// "연결됨(connected)"만으로 판정하지 않는다 -- teardownSeat이 닫으려는
// 바로 그 좌석도 close 시점까지는 connected다(자기 자신을 활성참조로 잡아
// 항상 스스로를 막는 모순을 피한다). 대신 orchestration 쪽에서 그 좌석에
// "아직 끝나지 않은 dispatch"가 물려 있는지(entry.activeDispatch === true,
// 호출자가 terminal list 응답에 태워 넘기는 합성/집계 필드)로만 판정한다
// -- teardown 대상 좌석 자신은 보통 이미 작업이 끝났거나 실패한 뒤라
// activeDispatch가 없고, 여전히 일하는 *다른* 좌석/작업만 이 신호로 잡힌다.
function observeActiveReferences(targetCanonical, opts) {
  if (typeof opts.execFn !== "function") {
    return { count: 0, tokens: [], observable: false };
  }
  let response;
  try {
    response = opts.execFn(buildOrcaTerminalListCommand());
  } catch {
    return { count: 0, tokens: [], observable: false };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return { count: 0, tokens: [], observable: false };
  }
  const list = Array.isArray(response.result?.terminals)
    ? response.result.terminals
    : null;
  if (!list) return { count: 0, tokens: [], observable: false };
  const active = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      isNonEmptyString(entry.worktreePath) &&
      canonicalizePath(entry.worktreePath) === targetCanonical &&
      entry.activeDispatch === true,
  );
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
// opts: { execFn?, gitFn?, existsFn? } -- 전부 읽기 전용 주입(fake, 실
// 프로세스 호출 0).
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
