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
// HYK-464-teardown-shadow-1 (coder-task.md §2 product_scope ①ⓐ) -- 아카이브
// 판정의 "병합 완료" 축이 쓰는 두 argv. ls-remote는 네트워크 의존이라
// 항상 주입 함수(opts.lsRemoteFn)로만 부른다(§2 비타협 "ls-remote 실물
// 호출은 수동 점검 1회까지만 · 시험은 주입 함수").
export function buildGitRevParseHeadCommand() {
  return ["rev-parse", "HEAD"];
}
export function buildGitLsRemoteMasterCommand() {
  return ["ls-remote", "origin", "refs/heads/master"];
}
// HYK-171 사이클4b-1 재작업3(사람 게이트 결정, coder-task.md §0/§1): 이전
// (스트릭1)에 있던 `buildTaskListDispatchedCommand`/`buildDispatchShowCommand`
// /`collectDispatchActivePaneKeys`/`fetchDispatchPaneKey`/`DISPATCH_FETCH_FAILED`
// /`buildPaneKey`/`resolveSelfPaneKey`를 전부 삭제했다 -- ORCH 직접 실측
// (읽기 전용 `orca terminal list --json` 라이브 조회):
//   1. terminal-list 항목에는 `paneKey` 필드가 없다. 실 필드는 정확히
//      12개(`branch, connected, handle, lastOutputAt, leafId, preview,
//      ptyId, tabId, title, worktreeId, worktreePath, writable`) -- pane
//      key는 `terminal create` 응답에서 생성 시점에 한 번만 나온다.
//   2. `${tabId}:${leafId}`는 pane key가 아니다. REVIEW 좌석 실측: tabId==
//      leafId=="pty:e841ec57-...::.../hyk171-cycle4b1-review@@027e1972"
//      (UUID가 아니라 pty 문자열, 게다가 둘이 동일값) -- 알려진
//      ORCA_PANE_KEY와 일치하는 terminal-list 항목이 **0개**였다. 이전
//      코더 좌석에서 우연히 맞았던 것은 UI가 채택한 탭이 우연히 UUID
//      tabId/leafId를 가진 표본 하나였을 뿐 일반화되지 않는다(REVIEW
//      review-2 P1-1b).
// 즉 "배정(dispatch)↔좌석(pane)" 상관은 현재 읽기 API로 증명 불가능한
// 기제였다 -- 모르는 것을 아는 척 판정하는 코드를 지우는 것이 이번
// 수리다(§2-B가 그 자리를 대신한다: 증명 불가 사실을 명시적 전제조건으로
// 표현). 관측 경로 어디에서도 `orchestration task-list`/`dispatch-show`
// argv를 만들지 않는다(테스트가 argv 부재를 전수 검사한다).

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

// ---- 활성참조 (HYK-171 사이클4b-1 재작업3, 사람 게이트 결정, coder-task.md
// §2-A) ----
// **증명 가능한 것만 판정 근거로 쓴다**: `connected`(terminal-list가 실제
// 주는 필드) + `handle` 소유권 증거(`opts.existingSeatHandle === entry.handle`
// 문자열 일치)뿐이다. `tabId`/`leafId`/`ptyId`/`title`/`preview`/`writable`
// 는 판정 근거로 쓰지 않는다(추측 분류 금지, REVIEW review-2 §3 명시 --
// 이 필드들은 관측되긴 하지만 자기-좌석 여부를 증명하지 못한다).
//
// 소유권 증거(existingSeatHandle)가 없으면 어떤 좌석도 자기 자신으로
// 추정하지 않는다 -- 대상 워크트리의 `connected:true` 좌석이 하나라도
// 있으면 ACTIVE_REFERENCE다. "배정(dispatch)이 활성인지"는 이 함수가
// 전혀 판정하지 않는다 -- 그 축은 증명 불가라 teardown-core.mjs의
// `dispatchCorrelationProven` 명시적 전제조건으로만 표현한다(§2-B, 이
// 파일 헤더의 삭제 사유 참조).
function isActiveReferenceEntry(entry, existingSeatHandle) {
  if (entry.connected !== true) return false;
  const isSelf =
    isNonEmptyString(existingSeatHandle) && entry.handle === existingSeatHandle;
  return !isSelf;
}

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

  const worktreeEntries = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      isNonEmptyString(entry.worktreePath) &&
      canonicalizePath(entry.worktreePath) === targetCanonical,
  );

  const active = worktreeEntries.filter((entry) =>
    isActiveReferenceEntry(entry, opts.existingSeatHandle),
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

// ---- HYK-464-teardown-shadow-1 (coder-task.md §2 product_scope ①) --
// 아카이브(워크트리 정리) 전제 축 4개 중 ⓐⓒⓓ의 관측(읽기 전용, 파괴
// argv 0). ⓑ(미소비 라운드 0)은 이 파일이 만들지 않는다 -- 호출자
// (watch-run.mjs)가 이미 가진 HYK-185 judgeUnconsumedAcrossWorktrees의
// 결과를 그대로 받아 봉투에 얹는다(§2 product_scope ① "같은 판정
// 함수 · 새 재구현 금지"). 그래서 이 파일은 unconsumed-core.mjs/
// orch-stall-detect.mjs 어느 것도 import하지 않는다(순환 import 자체가
// 생기지 않는다 -- orch-stall-detect.mjs는 relay/* 를 import하지
// 않는다, 사전 확인 실측).
// ---------------------------------------------------------------------

// ⓐ 병합 완료 -- 브랜치 head가 origin/master(ls-remote 값)의 조상인가.
// opts.gitFn(rev-parse HEAD) + opts.lsRemoteFn(ls-remote) + opts.isAncestorFn
// (headSha, remoteSha, worktreePath) -> boolean, 전부 주입(실 네트워크/
// git 호출 0 -- 이 파일 자신은 프로세스를 실행하지 않는다). 셋 중 하나라도
// 없거나 던지거나 모양이 틀리면 UNOBSERVABLE(판정 불가, "아니다"로
// 지어내지 않는다).
function parseLsRemoteSha(output) {
  if (typeof output !== "string") return null;
  const firstLine = output.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  const sha = firstLine.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

function observeMergeStatus(worktreePath, opts) {
  if (
    typeof opts.gitFn !== "function" ||
    typeof opts.lsRemoteFn !== "function" ||
    typeof opts.isAncestorFn !== "function"
  ) {
    return { observable: false };
  }
  let headSha;
  let remoteOutput;
  try {
    headSha = opts.gitFn(buildGitRevParseHeadCommand(), worktreePath);
    remoteOutput = opts.lsRemoteFn(
      buildGitLsRemoteMasterCommand(),
      worktreePath,
    );
  } catch {
    return { observable: false };
  }
  const remoteSha = parseLsRemoteSha(remoteOutput);
  if (
    typeof headSha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(headSha.trim()) ||
    !remoteSha
  ) {
    return { observable: false };
  }
  let isAncestor;
  try {
    isAncestor = opts.isAncestorFn(headSha.trim(), remoteSha, worktreePath);
  } catch {
    return { observable: false };
  }
  if (typeof isAncestor !== "boolean") return { observable: false };
  return {
    observable: true,
    isAncestorOfRemoteMaster: isAncestor,
    headSha: headSha.trim(),
    remoteMasterSha: remoteSha,
  };
}

// ⓒ 보존 사유 파일 .harness/keep-reason.md 존재 여부 + 첫 줄.
function firstNonEmptyLine(text) {
  const line = String(text)
    .split(/\r?\n/)
    .find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

function observeKeepReason(worktreePath, opts) {
  if (typeof opts.existsFn !== "function") return { observable: false };
  // ⛔canonicalizePath(소문자+posix 정규화)를 쓰지 않는다 -- 그건 "같은
  // 대상인지 비교"용이다(해시 토큰 재료). 실제 fs 호출은 원래 경로
  // 그대로 넘겨야 한다(existsFn/readFileFn은 실 fs로 결선될 주입구).
  const keepReasonPath = `${String(worktreePath).replace(/[\\/]+$/, "")}/.harness/keep-reason.md`;
  let exists;
  try {
    exists = opts.existsFn(keepReasonPath, worktreePath);
  } catch {
    return { observable: false };
  }
  if (typeof exists !== "boolean") return { observable: false };
  if (!exists) return { observable: true, present: false, firstLine: null };
  if (typeof opts.readFileFn !== "function") return { observable: false };
  let text;
  try {
    text = opts.readFileFn(keepReasonPath, worktreePath);
  } catch {
    // 있는데 못 읽는다 -- "없다"로 접지 않는다(판정 불가).
    return { observable: false };
  }
  if (typeof text !== "string") return { observable: false };
  return {
    observable: true,
    present: true,
    firstLine: firstNonEmptyLine(text),
  };
}

// ⓓ 아카이브 대상 목록 산출 -- `.harness` 아래 파일 상대경로·바이트·
// sha256. 복사·삭제 0 -- 목록만 읽어 evidence로 올린다. 실제 재귀
// 디렉터리 순회는 주입 함수(opts.listHarnessFilesFn)의 몫이다(이 파일은
// 그 결과만 받아 해시만 계산한다 -- fs 재귀 호출을 이 어댑터 안에
// 두지 않는 쪽이 시험하기 쉽다, 다른 observe* 함수들과 같은 "실행은
// 주입, 판단은 이 파일" 원칙).
function observeArchiveManifest(worktreePath, opts) {
  if (
    typeof opts.listHarnessFilesFn !== "function" ||
    typeof opts.readFileBufferFn !== "function"
  ) {
    return { observable: false };
  }
  let relPaths;
  try {
    relPaths = opts.listHarnessFilesFn(worktreePath);
  } catch {
    return { observable: false };
  }
  if (!Array.isArray(relPaths)) return { observable: false };
  const files = [];
  for (const relPath of relPaths) {
    if (!isNonEmptyString(relPath)) return { observable: false };
    let buffer;
    try {
      buffer = opts.readFileBufferFn(relPath, worktreePath);
    } catch {
      return { observable: false };
    }
    if (!Buffer.isBuffer(buffer)) return { observable: false };
    files.push({
      path: relPath,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { observable: true, files };
}

// observeArchiveInventory(ctx, opts) -- ⓐⓒⓓ를 한 봉투로 묶는다(ⓑ는
// 호출자가 별도로 채운다, 위 헤더 참조). ctx: {worktreePath}.
export function observeArchiveInventory(ctx, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const worktreePath = isNonEmptyString(c.worktreePath) ? c.worktreePath : "";
  return {
    mergeStatus: observeMergeStatus(worktreePath, opts),
    keepReason: observeKeepReason(worktreePath, opts),
    archiveManifest: observeArchiveManifest(worktreePath, opts),
  };
}

// ctx: { worktreePath, repoId? }
// opts: { execFn?, gitFn?, existsFn?, existingSeatHandle? } -- 전부 읽기
// 전용 주입(fake, 실 프로세스 호출 0). existingSeatHandle은 §2-A의 소유권
// 증거(대상 좌석 자신의 handle, 문자열 일치로만 판정) -- 미제공 시 어떤
// 좌석도 자기 자신이라고 추측하지 않는다.
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
