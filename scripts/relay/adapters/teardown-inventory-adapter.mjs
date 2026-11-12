import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import {
  TEARDOWN_SCHEMA_VERSION,
  PATCH_EQUIVALENCE_BRANCH_CAP,
  PATCH_EQUIVALENCE_MASTER_CAP,
  PATCH_EQUIVALENCE_CAUSE,
  PM_BINDING_CAUSE,
  RETIRE_MARKER_SCHEMA,
  RETIRE_MARKER_REASON_CODES,
  RETIRE_MARKER_MAX_AGE_MS,
  RETIRE_MARKER_CAUSE,
} from "../teardown-core.mjs";

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
// HYK-491-teardown-arm-1 (coder-task.md §2 product_scope ⓘⓘ) -- 무장 실행
// 경로가 복원 때 쓸 브랜치 «이름»을 구하는 argv. `rev-parse HEAD`(위)는
// SHA만 주므로 이 argv가 따로 필요하다(워크트리가 지워지기 «전»에,
// `defaultArchiveGitFn`과 동일 cwd=worktreePath로 호출한다).
export function buildGitRevParseAbbrevRefCommand() {
  return ["rev-parse", "--abbrev-ref", "HEAD"];
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

// ---- HYK-491-teardown-arm-1 (coder-task.md §2 product_scope ⓘⓘⓘ "활성
// 예약 또는 좌석") -- 무장 실행 경로 전용 안전판. judgeArchiveEligibility
// (6축)는 이 축을 전혀 모른다(§2 비타협 "그림자 ELIGIBLE 조건을 넓히지
// 않는다" -- 이 관측은 그 판정에 섞이지 않고, 호출자(무장 실행 경로)가
// ELIGIBLE 뒤에 «추가로» 확인한다, 부분집합만 지우는 설계). `activeReferences`
// (observeActiveReferences, 위)와 다르다 -- 그 함수는 `connected:true`+
// 자기-좌석 제외만 센다(배정 판정용, HYK-171). 이 함수는 **그 워크트리를
// 가리키는 터미널이 하나라도 있으면**(연결 여부 무관) count>0으로
// 보고한다 -- 실행(worktree rm) 직전의 마지막 안전판이라 더 엄격하다.
export function observeSeatCount(worktreePath, opts) {
  const targetCanonical = canonicalizePath(worktreePath);
  if (typeof opts.execFn !== "function") return { observable: false };
  let response;
  try {
    response = opts.execFn(buildOrcaTerminalListCommand());
  } catch {
    return { observable: false };
  }
  if (!isPlainObject(response) || response.ok !== true) {
    return { observable: false };
  }
  const list = Array.isArray(response.result?.terminals)
    ? response.result.terminals
    : null;
  if (!list) return { observable: false };
  const count = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.worktreePath) &&
      canonicalizePath(entry.worktreePath) === targetCanonical,
  ).length;
  return { observable: true, count };
}

// ═══════════════════════════════════════════════════════════════════════
// HYK-464-teardown-3kinds-1 -- «무장 teardown 이 구조적으로 못 지우던 3부류»
// 중 기계 증거만으로 닫히는 둘의 관측. 이 파일은 프로세스를 실행하지 않는다
// (전부 주입형) -- git 은 opts.gitFn, patch-id 계산은 opts.patchIdFn, 관제실
// 파일은 opts.readFileFn / existsFn / readdirFn. 읽기 전용 argv 만 만든다.
// ═══════════════════════════════════════════════════════════════════════

export function buildGitMergeBaseCommand(headSha, remoteSha) {
  return ["merge-base", headSha, remoteSha];
}
export function buildGitRevListMergesCountCommand(range) {
  return ["rev-list", "--merges", "--count", range];
}
// --max-count: 상한 + 1 개까지만 읽어 «상한 초과» 를 판별한다(무제한 출력 0).
export function buildGitRevListBranchCommitsCommand(range, maxCount) {
  return ["rev-list", "--no-merges", `--max-count=${maxCount}`, range];
}
export function buildGitRevListNoMergesCountCommand(range) {
  return ["rev-list", "--no-merges", "--count", range];
}
// ⛔--binary 필수: 빼면 이진 파일 변경이 «Binary files differ» 한 줄로
// 접혀 다른 내용끼리 같은 patch-id 를 낼 수 있다(설계 §(b) ⓑ 조건 5).
// 병합 커밋은 patch 를 내지 않으므로 --no-merges (병합 커밋 0 은 따로 센다).
// 장식·서명·textconv·외부 diff 는 사용자 설정과 무관하게 끈다.
export function buildGitLogPatchCommand(range) {
  return [
    "log",
    "-p",
    "--binary",
    "--no-merges",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-decorate",
    "--no-show-signature",
    range,
  ];
}

function isSha40(v) {
  return typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
}
function readNonNegativeInt(text) {
  const trimmed = String(text).trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
// rev-list 출력 -- 한 줄에 sha 하나. 모양이 틀리면 null.
function parseShaLines(text) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!isSha40(line)) return null;
    out.push(line);
  }
  return out;
}
// `git patch-id --stable` 출력 -- «<patch-id> <commit-id>» 한 줄씩.
function parsePatchIdLines(text) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(
      line,
    );
    if (!m) return null;
    out.push({ patchId: m[1].toLowerCase(), commitId: m[2].toLowerCase() });
  }
  return out;
}

// ⓑ patch-id 동등 -- 설계 §(b) ⓑ 7조건. mergeStatus 는 observeMergeStatus 의
// 결과(조상이 «아님» 이 관측된 경우에만 부른다). git 호출이 하나라도 던지거나
// 시간 초과거나 모양이 틀리면 {observable:false}(거짓 «아니다» / «맞다» 0).
// 조건 2~7 이 거짓이면 {observable:true, equivalent:false, cause}.
function sameStringSets(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  if (setA.size !== a.length) return false;
  return b.every((x) => setA.has(x));
}

function notEquivalentResult(base, cause, extra) {
  return { ...base, equivalent: false, cause, ...extra };
}

// 조건 2~4: 범위 계수 -- 병합 커밋 0 · 브랜치 비병합 커밋 1..50 · master 쪽
// 비병합 커밋 ≤1000. 끝나면 {result}(조기 종료) 또는 {branchCommits, masterCommitCount}.
function checkPatchEquivalenceRanges(worktreePath, base, ranges, opts) {
  const run = (argv) => opts.gitFn(argv, worktreePath);
  // 조건 2: 병합 커밋 0 (git cherry / --no-merges 는 병합 커밋을 조용히 건너뛴다).
  const merges = readNonNegativeInt(
    run(buildGitRevListMergesCountCommand(ranges.branch)),
  );
  if (merges === null) return { result: { observable: false } };
  if (merges > 0) {
    const extra = { branchMergeCount: merges };
    return {
      result: notEquivalentResult(
        base,
        PATCH_EQUIVALENCE_CAUSE.HAS_MERGE,
        extra,
      ),
    };
  }
  // 조건 3: 브랜치 쪽 비병합 커밋 1개 이상 · 상한(50) 이하.
  const branchCommits = parseShaLines(
    run(
      buildGitRevListBranchCommitsCommand(
        ranges.branch,
        PATCH_EQUIVALENCE_BRANCH_CAP + 1,
      ),
    ),
  );
  if (branchCommits === null) return { result: { observable: false } };
  const emptyOrHuge =
    branchCommits.length === 0
      ? PATCH_EQUIVALENCE_CAUSE.EMPTY_RANGE
      : branchCommits.length > PATCH_EQUIVALENCE_BRANCH_CAP
        ? PATCH_EQUIVALENCE_CAUSE.RANGE_EXCEEDED
        : null;
  if (emptyOrHuge) {
    const extra = { branchMergeCount: 0 };
    return { result: notEquivalentResult(base, emptyOrHuge, extra) };
  }
  // 조건 4: master 쪽 비병합 커밋 상한(1000) 이하.
  const masterCommitCount = readNonNegativeInt(
    run(buildGitRevListNoMergesCountCommand(ranges.master)),
  );
  if (masterCommitCount === null) return { result: { observable: false } };
  if (masterCommitCount > PATCH_EQUIVALENCE_MASTER_CAP) {
    const extra = {
      branchMergeCount: 0,
      branchCommitCount: branchCommits.length,
      masterCommitCount,
    };
    return {
      result: notEquivalentResult(
        base,
        PATCH_EQUIVALENCE_CAUSE.RANGE_EXCEEDED,
        extra,
      ),
    };
  }
  return { branchCommits, masterCommitCount };
}

// 조건 5~7: 양쪽 patch-id(--binary) -- 줄 수 = 커밋 수 · 출력 커밋 집합 =
// 브랜치 커밋 집합 · 브랜치의 모든 patch-id 가 master 쪽 집합에 있다.
function comparePatchIds(worktreePath, base, ranges, bounds, opts) {
  const patchIds = (range) =>
    parsePatchIdLines(
      opts.patchIdFn(buildGitLogPatchCommand(range), worktreePath),
    );
  const branchPairs = patchIds(ranges.branch);
  const masterPairs = patchIds(ranges.master);
  if (branchPairs === null || masterPairs === null)
    return { observable: false };
  const { branchCommits, masterCommitCount } = bounds;
  const counts = {
    branchMergeCount: 0,
    branchCommitCount: branchCommits.length,
    masterCommitCount,
    patchIdLineCount: branchPairs.length,
  };
  // 조건 5: 빈 커밋은 patch-id 를 내지 않는다 -- 수가 다르면 «증명 못 함».
  const sameCommits =
    branchPairs.length === branchCommits.length &&
    sameStringSets(
      branchCommits.map((c) => c.toLowerCase()),
      branchPairs.map((p) => p.commitId),
    );
  if (!sameCommits) {
    return notEquivalentResult(
      base,
      PATCH_EQUIVALENCE_CAUSE.PATCH_ID_COUNT_MISMATCH,
      counts,
    );
  }
  // 조건 7: 미대응 0.
  const masterIds = new Set(masterPairs.map((p) => p.patchId));
  const unmatched = branchPairs
    .filter((p) => !masterIds.has(p.patchId))
    .map((p) => p.commitId);
  const matchedCount = branchPairs.length - unmatched.length;
  const result = { ...counts, matchedCount, unmatched };
  if (unmatched.length > 0) {
    return notEquivalentResult(base, PATCH_EQUIVALENCE_CAUSE.UNMATCHED, result);
  }
  return { ...base, equivalent: true, cause: null, ...result };
}

function observePatchEquivalenceUnsafe(worktreePath, mergeStatus, opts) {
  const headSha = mergeStatus.headSha;
  const remoteSha = mergeStatus.remoteMasterSha;
  const mergeBaseSha = String(
    opts.gitFn(buildGitMergeBaseCommand(headSha, remoteSha), worktreePath),
  ).trim();
  if (!isSha40(mergeBaseSha)) return { observable: false };
  const ranges = {
    branch: `${mergeBaseSha}..${headSha}`,
    master: `${mergeBaseSha}..${remoteSha}`,
  };
  const base = {
    observable: true,
    headSha,
    remoteMasterSha: remoteSha,
    mergeBaseSha,
  };
  const bounds = checkPatchEquivalenceRanges(worktreePath, base, ranges, opts);
  if (bounds.result) return bounds.result;
  return comparePatchIds(worktreePath, base, ranges, bounds, opts);
}

export function observePatchEquivalence(worktreePath, mergeStatus, opts = {}) {
  if (
    typeof opts.gitFn !== "function" ||
    typeof opts.patchIdFn !== "function"
  ) {
    return { observable: false };
  }
  if (
    !isPlainObject(mergeStatus) ||
    mergeStatus.observable !== true ||
    mergeStatus.isAncestorOfRemoteMaster !== false ||
    !isSha40(mergeStatus.headSha) ||
    !isSha40(mergeStatus.remoteMasterSha)
  ) {
    return { observable: false };
  }
  try {
    return observePatchEquivalenceUnsafe(worktreePath, mergeStatus, opts);
  } catch {
    return { observable: false };
  }
}

// ⓒ 관제실 PM 영수증 결속 -- 설계 §(b) ⓒ C1~C5. 워크트리 → 좌석 등록부
// (paneKey) → 배달 원장(harness_task_label) → PM 영수증(binding.taskId).
// ⛔번호(r<N>)로 묶지 않는다(영수증 번호와 라운드 번호는 1씩 어긋난다).
// ⛔관제실 루트 밖(예: watch/ 아래 낡은 사본)은 읽지 않는다.
// 파일 읽기 실패 · 깨진 JSON 줄 · 경로 미설정 = 모두 {observable:false}.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function parseDoneAtKstMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))? KST$/.exec(
    String(text).trim(),
  );
  if (!m) return null;
  return (
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) -
    KST_OFFSET_MS
  );
}
function parseDispatchUtcMs(text) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/.exec(
      String(text).trim(),
    );
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
function parseJsonlObjects(text) {
  if (typeof text !== "string") throw new Error("jsonl text expected");
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const row = JSON.parse(raw);
    if (!isPlainObject(row)) throw new Error("jsonl row must be an object");
    rows.push(row);
  }
  return rows;
}

function pmBindingResult(bound, cause, fields) {
  return {
    observable: true,
    bound,
    cause,
    paneCount: 0,
    dispatchCount: 0,
    consumedCount: 0,
    nonPmRowCount: 0,
    ambiguousPaneCount: 0,
    unconsumedLabels: [],
    preDispatchWindowOpen: false,
    ...fields,
  };
}

function readPmReceipts(root, opts, worktreePath) {
  const dir = `${root}/PM/relay/receipts`;
  const names = opts.readdirFn(dir);
  if (!Array.isArray(names)) throw new Error("receipts dir listing expected");
  return names
    .filter((n) => typeof n === "string" && /^PM-receipt-r\d+\.json$/.test(n))
    .map((name) => {
      const parsed = JSON.parse(
        opts.readFileFn(`${dir}/${name}`, worktreePath),
      );
      if (!isPlainObject(parsed)) throw new Error("receipt must be an object");
      const binding = isPlainObject(parsed.binding) ? parsed.binding : {};
      return {
        taskId: binding.taskId,
        role: binding.role,
        doneAt: binding.doneAt,
      };
    });
}

// C4: 한 배달에 대한 영수증 판정 -- "consumed" | 원인 문자열.
function judgeDispatchReceipt(dispatch, receipts) {
  const matches = receipts.filter(
    (r) => r.role === "PM" && r.taskId === dispatch.label,
  );
  if (matches.length === 0) return PM_BINDING_CAUSE.NO_RECEIPT;
  if (matches.length > 1) return PM_BINDING_CAUSE.AMBIGUOUS_RECEIPT;
  const doneMs = parseDoneAtKstMs(matches[0].doneAt);
  if (doneMs === null) throw new Error("unparseable receipt doneAt");
  return doneMs > dispatch.atMs
    ? "consumed"
    : PM_BINDING_CAUSE.RECEIPT_BEFORE_DISPATCH;
}

// C5: 지금 pm-task.md 가 «배달 전 구간»(영수증 없는 task_id + 이 워크트리)인가.
function isPreDispatchWindowOpen({ pmTaskText, receipts, wtCanon }) {
  const taskId = /^task_id:[ \t]*(\S+)/m.exec(pmTaskText)?.[1] ?? null;
  const hasReceipt =
    taskId !== null &&
    receipts.some((r) => r.role === "PM" && r.taskId === taskId);
  if (hasReceipt) return false;
  const wtLine = /^worktree:[ \t]*(.+)$/m.exec(pmTaskText)?.[1];
  if (!isNonEmptyString(wtLine)) return true; // 해석 못 하면 거부.
  const lineCanon = canonicalizePath(wtLine.trim());
  if (lineCanon === wtCanon) return true;
  // 경로 뒤에 괄호 산문이 붙는 모양 -- 경로 토큰 경계에서 시작하면 같은 경로.
  return (
    lineCanon.startsWith(wtCanon) &&
    /^[\s(]/.test(lineCanon.slice(wtCanon.length))
  );
}

// C1·C2: 이 워크트리의 등록부 행 -- 비어 있지 않고 «모든 행이 PM», 각
// paneKey 가 등록부 전체에서 정확히 1행. {result}(조기 종료) 또는 {panes}.
function judgePmRegistryRows(registry, wtCanon) {
  const rows = registry.filter(
    (r) =>
      isNonEmptyString(r.worktree) && canonicalizePath(r.worktree) === wtCanon,
  );
  if (rows.length === 0) {
    return {
      result: pmBindingResult(false, PM_BINDING_CAUSE.NO_REGISTRY_ROW, {}),
    };
  }
  if (rows.some((r) => !isNonEmptyString(r.paneKey))) {
    throw new Error("registry row without paneKey");
  }
  const panes = [...new Set(rows.map((r) => r.paneKey))];
  const nonPmRowCount = rows.filter((r) => r.role !== "PM").length;
  if (nonPmRowCount > 0) {
    const fields = { paneCount: panes.length, nonPmRowCount };
    return {
      result: pmBindingResult(false, PM_BINDING_CAUSE.NON_PM_ROW, fields),
    };
  }
  const ambiguousPaneCount = panes.filter(
    (pk) => registry.filter((r) => r.paneKey === pk).length !== 1,
  ).length;
  if (ambiguousPaneCount > 0) {
    const fields = { paneCount: panes.length, ambiguousPaneCount };
    return {
      result: pmBindingResult(false, PM_BINDING_CAUSE.AMBIGUOUS_PANE, fields),
    };
  }
  return { panes };
}

// C3: 배달 원장에서 이 pane 들의 행(모양이 틀린 행은 던진다 = 관측 안 됨).
function collectPmDispatches(dispatchRows, panes) {
  return dispatchRows
    .filter((d) => panes.includes(d.assignee_pane_key))
    .map((d) => {
      const atMs = parseDispatchUtcMs(d.dispatch_timestamp_utc);
      if (atMs === null || !isNonEmptyString(d.harness_task_label)) {
        throw new Error("malformed dispatch row");
      }
      return { role: d.role, label: d.harness_task_label, atMs };
    });
}

// C4: «모든» 배달에 PM 영수증이 정확히 1개 · doneAt 이 배달 뒤 (전칭).
function judgePmDispatchReceipts(dispatches, receipts, counts) {
  const verdicts = dispatches.map((d) => judgeDispatchReceipt(d, receipts));
  const consumedCount = verdicts.filter((v) => v === "consumed").length;
  if (consumedCount === dispatches.length) return { consumedCount };
  const cause =
    [
      PM_BINDING_CAUSE.NO_RECEIPT,
      PM_BINDING_CAUSE.AMBIGUOUS_RECEIPT,
      PM_BINDING_CAUSE.RECEIPT_BEFORE_DISPATCH,
    ].find((c) => verdicts.includes(c)) ?? PM_BINDING_CAUSE.NO_RECEIPT;
  return {
    result: pmBindingResult(false, cause, {
      ...counts,
      consumedCount,
      unconsumedLabels: dispatches
        .filter((_, i) => verdicts[i] !== "consumed")
        .map((d) => d.label),
    }),
  };
}

function observePmReceiptBindingUnsafe(worktreePath, root, opts) {
  const wtCanon = canonicalizePath(worktreePath);
  const read = (p) => opts.readFileFn(p, worktreePath);
  const registry = parseJsonlObjects(
    read(`${root}/seat-launch-registry.jsonl`),
  );
  const dispatchRows = parseJsonlObjects(
    read(`${root}/dispatch-receipts.jsonl`),
  );
  const receipts = readPmReceipts(root, opts, worktreePath);

  const registryJudged = judgePmRegistryRows(registry, wtCanon);
  if (registryJudged.result) return registryJudged.result;
  const dispatches = collectPmDispatches(dispatchRows, registryJudged.panes);
  const counts = {
    paneCount: registryJudged.panes.length,
    dispatchCount: dispatches.length,
  };
  if (dispatches.length === 0) {
    return pmBindingResult(false, PM_BINDING_CAUSE.NO_DISPATCH, counts);
  }
  if (dispatches.some((d) => d.role !== "PM")) {
    return pmBindingResult(false, PM_BINDING_CAUSE.NON_PM_DISPATCH, counts);
  }
  const receiptJudged = judgePmDispatchReceipts(dispatches, receipts, counts);
  if (receiptJudged.result) return receiptJudged.result;
  const { consumedCount } = receiptJudged;
  // C5: 배달 원장에 행이 생기기 전 구간(pm-task.md)을 막는다.
  const pmTaskPath = `${root}/PM/relay/pm-task.md`;
  const pmTaskExists = opts.existsFn(pmTaskPath, worktreePath);
  if (typeof pmTaskExists !== "boolean") {
    throw new Error("exists must be boolean");
  }
  const windowOpen =
    pmTaskExists &&
    isPreDispatchWindowOpen({
      pmTaskText: read(pmTaskPath),
      receipts,
      wtCanon,
    });
  if (windowOpen) {
    return pmBindingResult(false, PM_BINDING_CAUSE.PRE_DISPATCH_WINDOW, {
      ...counts,
      consumedCount,
      preDispatchWindowOpen: true,
    });
  }
  return pmBindingResult(true, null, { ...counts, consumedCount });
}

export function observePmReceiptBinding(
  worktreePath,
  controlRoomRoot,
  opts = {},
) {
  if (!isNonEmptyString(worktreePath) || !isNonEmptyString(controlRoomRoot)) {
    return { observable: false };
  }
  if (
    typeof opts.readFileFn !== "function" ||
    typeof opts.readdirFn !== "function" ||
    typeof opts.existsFn !== "function"
  ) {
    return { observable: false };
  }
  const root = String(controlRoomRoot).replace(/[\\/]+$/, "");
  if (root.length === 0) return { observable: false };
  try {
    return observePmReceiptBindingUnsafe(worktreePath, root, opts);
  } catch {
    return { observable: false };
  }
}

// ---- HYK-464-teardown-3kinds-2 -- ⓐ 사람 승인 은퇴 표지 (검사 6 전용) ----
// 관제실 `watch/teardown-retire/<워크트리 이름>.json` 한 장을 «읽기만» 한다
// (쓰는 도구는 없다 -- 쓰는 주체는 사람 또는 한용 명시 지시를 받은 ORCH).
// ⛔워크트리 안 `.harness/retirements/`(watch-run 의 기존 은퇴 기록)는 표지가
// 아니다 -- 읽지 않는다. 시각(nowMs)·파일 읽기·실경로 해석은 전부 주입.
// 표지가 어긋나면 valid:false + 닫힌 cause, 읽기 실패·JSON 깨짐·주입 부재는
// {observable:false} -- 둘 다 코어의 통과 분기에 들어가지 못한다.
const RETIRE_MARKER_DIR_REL = "watch/teardown-retire";
const RETIRE_INTERPRETER_DIR = "통역";
const RETIRE_MARKER_KEYS = Object.freeze([
  "schema",
  "worktree",
  "headSha",
  "reasonCode",
  "approvalRef",
  "confirmed_by",
  "at",
]);
const RETIRE_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function retireMarkerResult(valid, cause, fields) {
  return {
    observable: true,
    valid,
    cause,
    worktree: null,
    headSha: null,
    reasonCode: null,
    approvalRef: null,
    confirmedBy: null,
    at: null,
    markerCount: 0,
    approvalNamesWorktree: false,
    approvalNamesHeadPrefix: false,
    approvalInsideAllowedRoot: false,
    atNotFuture: false,
    atWithin14Days: false,
    ...fields,
  };
}

function retireWorktreeName(worktreePath) {
  const segs = String(worktreePath)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
  const name = segs.length > 0 ? segs[segs.length - 1] : "";
  if (name === "" || name === "." || name === "..") return null;
  return /[<>:"|?*]/.test(name) ? null : name;
}

function isCalendarTime(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ISO8601 + 오프셋(Z 포함) -- 달력에 없는 날(2월 30일)과 오프셋 없는 시각은 null.
function parseRetireAtMs(text) {
  const m = typeof text === "string" ? RETIRE_AT_RE.exec(text) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (!isCalendarTime(y, mo, d, h, mi, s)) return null;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) {
    return null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function retireMarkerShapeOk(m) {
  if (!isPlainObject(m)) return false;
  return (
    Object.keys(m).length === RETIRE_MARKER_KEYS.length &&
    RETIRE_MARKER_KEYS.every(
      (k) => Object.hasOwn(m, k) && typeof m[k] === "string",
    )
  );
}

// 이름·HEAD·사유·확인자 -- 처음 어긋난 원인 한 개(없으면 null).
function retireMarkerIdentityCause(m, name, observedHead) {
  if (m.schema !== RETIRE_MARKER_SCHEMA) {
    return RETIRE_MARKER_CAUSE.SCHEMA_MISMATCH;
  }
  if (m.worktree !== name) return RETIRE_MARKER_CAUSE.WORKTREE_MISMATCH;
  if (!/^[0-9a-f]{40}$/.test(m.headSha)) {
    return RETIRE_MARKER_CAUSE.HEAD_INVALID;
  }
  if (m.headSha !== observedHead) return RETIRE_MARKER_CAUSE.HEAD_MISMATCH;
  if (!RETIRE_MARKER_REASON_CODES.includes(m.reasonCode)) {
    return RETIRE_MARKER_CAUSE.REASON_CODE_INVALID;
  }
  if (m.confirmed_by.trim().length === 0) {
    return RETIRE_MARKER_CAUSE.CONFIRMED_BY_EMPTY;
  }
  return null;
}

// at: 미래 아님 · 14일 이내(경계 포함). {cause, flags}.
function retireMarkerTimeJudge(at, nowMs) {
  const atMs = parseRetireAtMs(at);
  if (atMs === null)
    return { cause: RETIRE_MARKER_CAUSE.AT_INVALID, flags: {} };
  const flags = {
    atNotFuture: atMs <= nowMs,
    atWithin14Days: nowMs - atMs <= RETIRE_MARKER_MAX_AGE_MS,
  };
  if (!flags.atNotFuture) {
    return { cause: RETIRE_MARKER_CAUSE.AT_FUTURE, flags };
  }
  if (!flags.atWithin14Days) {
    return { cause: RETIRE_MARKER_CAUSE.AT_STALE, flags };
  }
  return { cause: null, flags };
}

// 표지 본문 판정 -- {cause, fields}. 키 7개 -> 이름·HEAD·사유 -> 시각 순서.
function judgeRetireMarkerBody(m, name, observedHead, nowMs) {
  if (!retireMarkerShapeOk(m)) {
    return { cause: RETIRE_MARKER_CAUSE.SHAPE_MISMATCH, fields: {} };
  }
  const fields = {
    worktree: m.worktree,
    headSha: observedHead,
    reasonCode: m.reasonCode,
    approvalRef: m.approvalRef,
    confirmedBy: m.confirmed_by,
    at: m.at,
  };
  const idCause = retireMarkerIdentityCause(m, name, observedHead);
  if (idCause) return { cause: idCause, fields };
  const time = retireMarkerTimeJudge(m.at, nowMs);
  return { cause: time.cause, fields: { ...fields, ...time.flags } };
}

// «같은 워크트리에 표지 파일 1개» -- 폴더의 .json 중 worktree 필드가 이 이름인
// 파일 수. JSON 이 아닌 이웃은 표지가 될 수 없어 무시하고, 읽기 오류는 던진다.
function markerFileNamesWorktree(text, name) {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) && parsed.worktree === name;
  } catch {
    return false;
  }
}
function countRetireMarkersFor(dir, name, opts, worktreePath) {
  const names = opts.readdirFn(dir);
  if (!Array.isArray(names)) throw new Error("marker dir listing expected");
  let count = 0;
  for (const n of names) {
    if (typeof n !== "string" || !/\.json$/i.test(n)) continue;
    const text = opts.readFileFn(`${dir}/${n}`, worktreePath);
    if (markerFileNamesWorktree(text, name)) count += 1;
  }
  if (count === 0) throw new Error("own marker missing from directory listing");
  return count;
}

function realpathOf(opts, p) {
  const real = opts.realpathFn(p);
  if (!isNonEmptyString(real)) throw new Error("realpath must be a string");
  return real;
}
function isInsideCanon(baseCanon, pCanon) {
  const prefix = baseCanon.endsWith("/") ? baseCanon : `${baseCanon}/`;
  return pCanon.startsWith(prefix);
}
// 승인 근거가 설 수 있는 곳: 관제실 루트, 그 부모 아래 `통역` 형제 폴더(없으면 건너뜀).
function retireAllowedBases(root, opts) {
  const bases = [canonicalizePath(realpathOf(opts, root))];
  const sibling = posixPath.join(
    posixPath.dirname(root.replace(/\\/g, "/")),
    RETIRE_INTERPRETER_DIR,
  );
  try {
    bases.push(canonicalizePath(realpathOf(opts, sibling)));
  } catch {
    // 통역 폴더가 없다 -- 관제실 안 근거만 허용한다.
  }
  return bases;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// 이름·HEAD 앞 7자리는 «토큰 경계» 로 찾는다 -- 더 긴 이름(…-10)이나 다른 해시의
// 일부가 우연히 포함돼도 통과하지 않는다.
function bodyNamesWorktree(body, name) {
  const re = new RegExp(
    `(?<![A-Za-z0-9_.-])${escapeRegExp(name)}(?![A-Za-z0-9_.-])`,
  );
  return re.test(body);
}
function bodyNamesHeadPrefix(body, head) {
  return new RegExp(`(?<![0-9a-f])${head.slice(0, 7)}`, "i").test(body);
}

function requireBoolean(v) {
  if (typeof v !== "boolean") throw new Error("exists must be boolean");
  return v;
}

// 승인 근거 판정 -- {cause, fields}. ctx: {name, head, root, dir, worktreePath, opts}.
function judgeRetireApproval(ref, ctx) {
  const { name, head, root, dir, worktreePath, opts } = ctx;
  if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(ref)) {
    return { cause: RETIRE_MARKER_CAUSE.APPROVAL_REF_INVALID, fields: {} };
  }
  if (!requireBoolean(opts.existsFn(ref, worktreePath))) {
    return { cause: RETIRE_MARKER_CAUSE.APPROVAL_NOT_FOUND, fields: {} };
  }
  const realCanon = canonicalizePath(realpathOf(opts, ref));
  const inside = retireAllowedBases(root, opts).some((b) =>
    isInsideCanon(b, realCanon),
  );
  if (!inside) {
    return { cause: RETIRE_MARKER_CAUSE.APPROVAL_OUTSIDE_ROOT, fields: {} };
  }
  const fields = { approvalInsideAllowedRoot: true };
  // 표지 파일 자신을 승인 근거로 삼으면 «승인 문서가 따로 있다» 는 뜻이 사라진다.
  if (isInsideCanon(canonicalizePath(realpathOf(opts, dir)), realCanon)) {
    return { cause: RETIRE_MARKER_CAUSE.APPROVAL_IS_MARKER, fields };
  }
  const body = opts.readFileFn(ref, worktreePath);
  if (typeof body !== "string") throw new Error("approval body must be text");
  fields.approvalNamesWorktree = bodyNamesWorktree(body, name);
  fields.approvalNamesHeadPrefix = bodyNamesHeadPrefix(body, head);
  if (!fields.approvalNamesWorktree) {
    return { cause: RETIRE_MARKER_CAUSE.APPROVAL_MISSING_NAME, fields };
  }
  if (!fields.approvalNamesHeadPrefix) {
    return { cause: RETIRE_MARKER_CAUSE.APPROVAL_MISSING_HEAD, fields };
  }
  return { cause: null, fields };
}

function observeRetireMarkerUnsafe(worktreePath, root, mergeStatus, opts) {
  const name = retireWorktreeName(worktreePath);
  if (name === null) return { observable: false };
  const dir = `${root}/${RETIRE_MARKER_DIR_REL}`;
  const markerPath = `${dir}/${name}.json`;
  if (!requireBoolean(opts.existsFn(markerPath, worktreePath))) {
    return retireMarkerResult(false, RETIRE_MARKER_CAUSE.NO_MARKER, {});
  }
  const marker = JSON.parse(opts.readFileFn(markerPath, worktreePath));
  const body = judgeRetireMarkerBody(
    marker,
    name,
    mergeStatus.headSha,
    opts.nowMs,
  );
  if (body.cause) return retireMarkerResult(false, body.cause, body.fields);
  const markerCount = countRetireMarkersFor(dir, name, opts, worktreePath);
  const fields = { ...body.fields, markerCount };
  if (markerCount !== 1) {
    return retireMarkerResult(
      false,
      RETIRE_MARKER_CAUSE.MULTIPLE_MARKERS,
      fields,
    );
  }
  const approval = judgeRetireApproval(marker.approvalRef, {
    name,
    head: mergeStatus.headSha,
    root,
    dir,
    worktreePath,
    opts,
  });
  const all = { ...fields, ...approval.fields };
  return retireMarkerResult(approval.cause === null, approval.cause, all);
}

function retireMarkerInputsOk(worktreePath, root, mergeStatus, opts) {
  if (!isNonEmptyString(worktreePath) || !isNonEmptyString(root)) return false;
  if (!isPlainObject(mergeStatus) || mergeStatus.observable !== true) {
    return false;
  }
  if (!isNonEmptyString(mergeStatus.headSha)) return false;
  return (
    typeof opts.readFileFn === "function" &&
    typeof opts.readdirFn === "function" &&
    typeof opts.existsFn === "function" &&
    typeof opts.realpathFn === "function" &&
    Number.isFinite(opts.nowMs)
  );
}

export function observeRetireMarker(
  worktreePath,
  controlRoomRoot,
  mergeStatus,
  opts = {},
) {
  if (!retireMarkerInputsOk(worktreePath, controlRoomRoot, mergeStatus, opts)) {
    return { observable: false };
  }
  const root = String(controlRoomRoot).replace(/[\\/]+$/, "");
  if (root.length === 0) return { observable: false };
  try {
    return observeRetireMarkerUnsafe(worktreePath, root, mergeStatus, opts);
  } catch {
    return { observable: false };
  }
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
