import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// HYK-204: 워커 봉투(`.harness/<role>.md`)는 라운드마다 덮어쓴다 -- 같은
// 트랙에서 5라운드를 돌리면 마지막 라운드 원문만 남고 앞선 4개는 다음
// 라운드가 쓰는 순간 사라진다(2026-08-08 실사례: 그날 밤 최대 산출이던
// «공허한 IN_SYNC» 반려 원문이 이렇게 소실됐다). 이 모듈은 그 원문을
// `<role>.md`가 다시 덮어쓰이기 *전에* 별도 파일로 복제해 남긴다.
//
// ⛔봉투 형식(계약)은 바꾸지 않는다: `<role>.md` 자체는 여기서 절대
// 쓰지/지우지 않는다 -- relay-handshake/review-gate/reject-streak 등 그
// 파일을 읽는 기존 소비자는 이 모듈의 존재를 몰라도 그대로 동작한다.
// 보존은 항상 "추가"(다른 경로에 사본을 하나 더 남기는 것)일 뿐이다.
//
// HYK-204 2R (검토 §C 지적, 확정 한계 -- 아직 안 덮이는 라운드 1건):
// 이 모듈은 오직 CONFIRMED 라운드만 안다 -- `checkRelayHandshake`가
// ok:true를 반환한 순간, 또는 `review-gate.mjs`의 커밋 승인 순간에만
// 호출된다. **핸드셰이크 자체가 실패한 라운드(예: 워커가 `>>> DONE:` 줄을
// 잘못 쓰거나 `task_id:` 표지가 어긋난 라운드)는 원문이 전혀 남지 않는다**
// -- archiveRoundEnvelope가 호출되는 지점 자체가 없기 때문이다
// (envelope-archive.test.mjs의 "wiring: checkRelayHandshake blocked
// (mismatch) -> no archive is written" 시험이 이 구멍을 직접 증명한다).
// 이 트랙은 이 구멍을 고치지 않는다 -- 다음 사람이 "라운드가 덮인다"를
// 과신하지 않도록 기재만 한다.

const ARCHIVE_SUBDIR = "rounds";

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyStringLocal(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-204 §2 축3(이름): 라운드 번호는 사람이 손으로 대는 값이 아니라 이미
// 그 role의 archive 폴더에 몇 개가 쌓여 있는지를 세어 기계적으로 매긴다
// -- "동일 파일명 재사용(=덮어쓰기 재발)"을 막는 것이 이 함수의 유일한
// 계약이므로, 순번을 건너뛰거나 파일이 지워졌더라도 기존 최댓값+1을 써서
// 절대 과거 순번을 재사용하지 않는다.
//
// HYK-204 2R (검토 §C 목록 밖 지적, 확정 한계 -- TOCTOU, 수리 안 함):
// 이 계산과 archiveRoundEnvelope의 실제 write 사이에 원자성이 없다 --
// readdirSync(읽기)와 writeFileSync(쓰기) 사이에 다른 프로세스가 끼어들
// 수 있는 창이 열려 있다. `checkRelayHandshake`의 실제 호출자가 5곳
// (relay-core.mjs, watch-result.mjs, orca-spike-runner.mjs,
// orca-spike-live.mjs, seat-signal-adapter.mjs)이라, 같은 role에 대해
// 이론상 두 프로세스가 거의 동시에 archiveRoundEnvelope를 부르면 둘 다
// 같은 "다음 번호"를 계산해 하나가 다른 하나를 조용히 덮어쓸 수 있다 --
// 정확히 이 모듈이 막으려던 그 사고 모양이 여기서만 재발할 수 있다는
// 뜻이다. 실제 운영에서 그런 동시 호출이 실제로 벌어지는지는 확인하지
// 못했다(좁은 위험으로만 기재). 수리하려면 파일 잠금/원자적 rename 같은
// 설계 변경이 필요해 이 트랙 범위 밖으로 남긴다.
// HYK-244 gate-unblock-1 §1 조각1 원인ⓑ 수리 (ORCH 실측 근거: envelope-
// archive.mjs 51행): 이 정규식이 role 대소문자를 정규화하지 않아서,
// 실제 생산 호출자가 어떤 호출은 "REVIEW"(대문자)로, 다른 호출은
// "review"(소문자)로 넘기면(둘 다 같은 role 개념인데 표기만 다름 --
// 2R-ci-1의 role 대소문자 분리와 같은 계열 결함) 이 함수가 기존
// `REVIEW-r1..r8.md`를 하나도 못 세고 번호를 1부터 다시 매겨
// `review-r1.md`를 만들었다. Windows는 대소문자를 구별하지 않아 그
// 새 파일이 기존 `REVIEW-r1.md`를 그대로 덮어써 보존 사본 1건이
// 실제로 소실됐다(`.gitignore`로 미추적이라 git 복구도 불가 -- 실사고,
// 되돌리지 않는다). 정규식에 `i` 플래그를 붙여 role 대소문자와 무관하게
// 기존 사본 전부를 세도록 고친다 -- "동일 파일명 재사용을 막는다"는
// 이 함수의 유일한 계약을 대소문자에도 확장할 뿐, 다른 동작은 그대로다.
export function nextArchiveFileName(role, existingNames) {
  const pattern = new RegExp(`^${escapeForRegex(role)}-r(\\d+)\\.md$`, "i");
  let maxRound = 0;
  for (const name of existingNames) {
    const m = pattern.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (n > maxRound) maxRound = n;
    }
  }
  return `${role}-r${maxRound + 1}.md`;
}

// HYK-244 gate-unblock-1 §1 조각1 비타협 안전장치: nextArchiveFileName이
// 계산한 다음 번호라도, 그 정확한 파일명이 대소문자만 다르게 이미
// 존재하면(예: 계산 결과 "review-r9.md"인데 디렉터리엔 "REVIEW-r9.md"가
// 이미 있음 -- TOCTOU 경합, 또는 위 수리 이전에 실제로 벌어졌던 것과
// 같은 계열의 불일치) 절대 조용히 덮어쓰지 않는다. ⚠️existsSync(path)
// 하나만으로는 부족하다 -- Windows는 대소문자를 구별하지 않아
// existsSync 자체가 이미 "있다"고 답해 버려 호출자가 그 판단을 신뢰할
// 수 없고, Linux(대소문자 구별, 이 결함의 진짜 반증 자리)에서는
// existsSync가 그 반대로 "없다"고 답해 이 안전장치가 있으나마나가
// 된다. 그래서 둘 다에서 동일하게 동작하도록, 이미 읽어 둔 디렉터리
// 목록(existingNames)을 대소문자 무관 문자열 비교로 직접 대조한다.
export function findCaseInsensitiveCollision(fileName, existingNames) {
  const lower = fileName.toLowerCase();
  return existingNames.find((name) => name.toLowerCase() === lower) ?? null;
}

// HYK-241 §2 조각1: task 파일(`<role>-task.md`) 쪽의 같은 덮어쓰기 문제 --
// 라운드마다 ORCH가 다음 task 파일을 같은 이름으로 다시 쓰면, 지금까지
// «우리가 무엇을 지시했는가»의 원문이 그 순간 사라진다(§1 실사고: 결과
// 파일은 archiveRoundEnvelope가 보존하는데 지시서는 그 대상이 아니었다).
// 별도 이름 패턴(`<role>-task-r<N>.md`)을 써서 nextArchiveFileName의 기존
// 계약(정확히 `<role>-r<N>.md`만 셈)과 절대 충돌하지 않는다 -- 두 정규식
// 모두 상대방의 파일명을 매치하지 않는다(태그 사이에 반드시 `-task-`가
// 끼어 있어야 함).
export function nextTaskArchiveFileName(role, existingNames) {
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-task-r(\\d+)\\.md$`,
    "i",
  );
  let maxRound = 0;
  for (const name of existingNames) {
    const m = pattern.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (n > maxRound) maxRound = n;
    }
  }
  return `${role}-task-r${maxRound + 1}.md`;
}

const DROPPED_AT_RE_G = /^dropped_at:\s*(.+)$/gim;

// Metadata-only extraction, mirrors extractDoneAt below (ambiguous -> "unknown"
// rather than guessing).
function extractDroppedAt(taskContent) {
  const matches = [...taskContent.matchAll(DROPPED_AT_RE_G)];
  return matches.length === 1 ? matches[0][1].trim() : "unknown";
}

// Writes a verbatim copy of `taskContent` under
// `<harnessDir>/rounds/<role>-task-r<N>.md` -- the TASK-file sibling of
// archiveRoundEnvelope above. ⛔봉투 형식(계약)은 여기서도 바꾸지 않는다:
// `<role>-task.md` 자체는 절대 쓰지/지우지 않는다 -- 보존은 항상 "추가"다.
// Never throws -- same contract as archiveRoundEnvelope (a failure to
// archive must not block the handshake decision that triggered it).
export function archiveRoundTaskFile({
  role,
  taskContent,
  harnessDir,
  dispatchId: providedDispatchId,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason:
        "envelope-archive: role missing -- cannot preserve round task file",
    };
  }
  if (typeof taskContent !== "string") {
    return {
      ok: false,
      reason:
        "envelope-archive: taskContent missing -- cannot preserve round task file",
    };
  }
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  try {
    if (!existsFn(archiveDir)) {
      mkdirFn(archiveDir, { recursive: true });
    }
    const existing = readdirFn(archiveDir);
    const fileName = nextTaskArchiveFileName(role, existing);
    // HYK-204 2R이 이미 기재한 TOCTOU 창(readdirSync와 writeFileSync
    // 사이, 파일 상단 주석 참조)을 좁히려고 쓰기 직전에 디렉터리를
    // 한 번 더 읽는다 -- 위 `existing`(번호 계산용 스냅샷)을 재사용하지
    // 않는다. 그 스냅샷을 그대로 대조하면 fileName은 항상 그 목록 안의
    // 무엇과도 case-insensitive로 같을 수 없어(정의상 max+1) 이 안전장치
    // 자체가 죽은 코드가 된다 -- 반드시 "새로 다시 읽은" 목록과 대조해야
    // 그 사이에 다른 프로세스가 만든 파일을 실제로 잡을 수 있다.
    const collision = findCaseInsensitiveCollision(
      fileName,
      readdirFn(archiveDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `envelope-archive: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(archiveDir, fileName);
    const droppedAt = extractDroppedAt(taskContent);
    // HYK-396 §2/§3 (Q1 실측 근거: 이 헤더는 이 라운드가 배달되는 taskContent
    // 자체를 스냅숏하는 유일한 지점인데, 여기서 dispatch_id는 원리적으로
    // 아직 모른다 -- 이 CLI(dispatch-gate-decision.mjs의
    // bestEffortSnapshotRoundTaskFile)는 실물 앵커(dispatch-worker.ps1:171)가
    // 실제 `orca orchestration dispatch`를 부르기 «전»에 돈다, dispatch_id는
    // 그 호출의 응답에만 있다. ⛔값을 지어내지 않는다(coder-task.md §3 Q2) --
    // 호출자가 안 주면 리터럴 "unknown"을 적어 "모른다"는 사실 자체를
    // 남긴다(extractDroppedAt의 기존 "unknown" 관례와 동일). 실제 값은
    // stampDispatchIdOnLatestArchivedTaskFile(아래)이 배달 «직후»(dispatch_id를
    // 실제로 아는 순간) 이 파일을 다시 열어 덮어쓴다 -- 관제실 패치 제안
    // 문서 참조(docs/control-room-patches/HYK-396-dispatch-id-stamp.md).
    const dispatchId = isNonEmptyStringLocal(providedDispatchId)
      ? providedDispatchId
      : "unknown";
    const header = `<!-- envelope-archive: role=${role} kind=task dropped_at=${droppedAt} dispatch_id=${dispatchId} -->\n`;
    writeFileFn(destPath, header + taskContent, "utf8");
    return {
      ok: true,
      reason: `envelope-archive: ${role} round TASK file preserved -> ${join(ARCHIVE_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to preserve ${role} round task file (${err.message})`,
    };
  }
}

// HYK-307-order-1 §1: archiveRoundTaskFile always assigns the NEXT
// incrementing round number and writes -- calling it twice for the SAME
// round's content (once at delivery time via the new dispatch-gate
// snapshot below, once at the normal successful-consumption archive that
// already existed before this track) would create two archive copies of
// identical content. Not a data-loss bug (nothing is overwritten -- the
// existing collision guard already refuses that), just a wasteful
// duplicate that also shifts round numbering. This header-stripping
// comparison lets a caller ask "is this exact content already preserved?"
// before calling archiveRoundTaskFile, so a second call for an unchanged
// round becomes a no-op instead of a second file.
const ARCHIVE_HEADER_LINE_RE = /^<!-- envelope-archive:[^\n]*-->\n/;

function stripArchiveHeader(fileText) {
  return fileText.replace(ARCHIVE_HEADER_LINE_RE, "");
}

// Scans `<harnessDir>/rounds/<role>-task-r*.md` (role match case-insensitive,
// same convention as nextTaskArchiveFileName/findCaseInsensitiveCollision
// above) for an existing archive whose body (header line stripped) is
// byte-identical to `taskContent`. Never throws -- an unreadable archive
// dir/file is treated as "no match found" (fail toward archiving, not
// toward silently skipping a round that in fact isn't preserved yet).
export function hasIdenticalArchivedTaskFile({
  role,
  taskContent,
  harnessDir,
  readdirFn = readdirSync,
  readFileFn = readFileSync,
}) {
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  let names;
  try {
    names = readdirFn(archiveDir);
  } catch {
    return false;
  }
  const pattern = new RegExp(
    `^${escapeForRegex(role)}-task-r(\\d+)\\.md$`,
    "i",
  );
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let body;
    try {
      body = stripArchiveHeader(readFileFn(join(archiveDir, name), "utf8"));
    } catch {
      continue;
    }
    if (body === taskContent) return true;
  }
  return false;
}

// Thin wrapper around archiveRoundTaskFile: skips the write (ok:true,
// skipped:true) when an archive with IDENTICAL content already exists for
// this role, otherwise delegates unchanged. archiveRoundTaskFile itself is
// untouched (⛔기존 계약 변경 금지) -- every existing caller/test of that
// function keeps its exact current behavior; this is a new, additive entry
// point for callers (the dispatch-gate delivery-time snapshot, §1) that
// need "preserve this round's text, but don't duplicate it" semantics.
export function archiveRoundTaskFileIfNew({
  role,
  taskContent,
  harnessDir,
  dispatchId,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
  readFileFn = readFileSync,
}) {
  if (
    typeof role === "string" &&
    role !== "" &&
    typeof taskContent === "string" &&
    hasIdenticalArchivedTaskFile({
      role,
      taskContent,
      harnessDir,
      readdirFn,
      readFileFn,
    })
  ) {
    return {
      ok: true,
      skipped: true,
      reason: `envelope-archive: ${role} round TASK file content already preserved (identical snapshot exists in ${ARCHIVE_SUBDIR}/) -- skipped duplicate`,
    };
  }
  return {
    ...archiveRoundTaskFile({
      role,
      taskContent,
      harnessDir,
      dispatchId,
      readdirFn,
      mkdirFn,
      writeFileFn,
      existsFn,
    }),
    skipped: false,
  };
}

const DONE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;

// Metadata-only extraction (never used for pass/fail decisions -- that's
// relay-handshake.mjs's job). Ambiguous (0 or >=2 matches) falls back to
// "unknown" rather than guessing which one is real; this header is a
// convenience label on the archive copy, not a second source of truth.
function extractDoneAt(resultContent) {
  const matches = [...resultContent.matchAll(DONE_RE_G)];
  return matches.length === 1 ? matches[0][1].trim() : "unknown";
}

// Writes a verbatim copy of `resultContent` under
// `<harnessDir>/rounds/<role>-r<N>.md`, N picked by nextArchiveFileName so
// two calls for the same role never land on the same file (§4 변조 ⓑ's
// exact regression). Never throws -- a failure to archive must not block
// the handshake/gate decision that triggered it; callers log `reason`.
export function archiveRoundEnvelope({
  role,
  resultContent,
  harnessDir,
  readdirFn = readdirSync,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  existsFn = existsSync,
}) {
  if (typeof role !== "string" || role === "") {
    return {
      ok: false,
      reason: "envelope-archive: role missing -- cannot preserve round",
    };
  }
  if (typeof resultContent !== "string") {
    return {
      ok: false,
      reason:
        "envelope-archive: resultContent missing -- cannot preserve round",
    };
  }
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  try {
    if (!existsFn(archiveDir)) {
      mkdirFn(archiveDir, { recursive: true });
    }
    const existing = readdirFn(archiveDir);
    const fileName = nextArchiveFileName(role, existing);
    // TOCTOU 창을 좁히려고 쓰기 직전 재확인 -- archiveRoundTaskFile 위와
    // 같은 이유(번호 계산용 스냅샷 재사용 금지).
    const collision = findCaseInsensitiveCollision(
      fileName,
      readdirFn(archiveDir),
    );
    if (collision) {
      return {
        ok: false,
        reason: `envelope-archive: refusing to overwrite -- destination '${fileName}' collides (case-insensitive) with existing '${collision}'`,
      };
    }
    const destPath = join(archiveDir, fileName);
    const doneAt = extractDoneAt(resultContent);
    const header = `<!-- envelope-archive: role=${role} archived_at=${doneAt} -->\n`;
    writeFileFn(destPath, header + resultContent, "utf8");
    return {
      ok: true,
      reason: `envelope-archive: ${role} round preserved -> ${join(ARCHIVE_SUBDIR, fileName)}`,
      path: destPath,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to preserve ${role} round (${err.message})`,
    };
  }
}

// HYK-396 §2/§3 -- the delivery-time-stamp completion HYK-394 punted here
// (그 라운드 헤더의 "완성은 HYK-396 예정" 그대로). archiveRoundTaskFile's
// header (위) is written BEFORE the actual `orca orchestration dispatch`
// call fires (dispatch-gate-decision.mjs's bestEffortSnapshotRoundTaskFile
// runs at the real anchor dispatch-worker.ps1:171, which is BEFORE the
// dispatch response that carries dispatch_id exists) -- so it can only ever
// write the literal "unknown" for dispatch_id at that instant (a real value
// there would be invented, forbidden by coder-task.md §3 Q2). This function
// is the second half: called once the real dispatch_id IS known (control
// room, right after the dispatch response returns -- see the patch proposal
// docs/control-room-patches/HYK-396-dispatch-id-stamp.md for exactly where),
// it finds THIS round's own snapshot (the highest-numbered
// `<role>-task-r<N>.md`, which is guaranteed to be the file
// bestEffortSnapshotRoundTaskFile just wrote for this exact delivery,
// because no other delivery for this role can occur between the gate call
// and the dispatch response in the real single-threaded ps1 flow) and
// rewrites its header's dispatch_id field in place -- the round-task
// snapshot's BODY (the task instructions themselves) is never touched,
// only the header line this module itself owns.
//
// One-shot: refuses (ok:false) to overwrite an already-real (non-"unknown")
// stamp with a DIFFERENT value -- a second call for the same archive file
// with a different dispatchId means either a retry raced with a new
// delivery already claiming this label's next round slot, or a forged call;
// either way, silently overwriting would erase the very binding this axis
// exists to protect (fail loud instead, never fail silent). A call carrying
// the SAME dispatchId as what's already stamped is a true no-op retry
// (ok:true, skipped:true) -- idempotent, matching archiveRoundTaskFileIfNew's
// house style.
const ARCHIVE_TASK_FILE_NAME_RE_TEMPLATE = (role) =>
  new RegExp(`^${escapeForRegex(role)}-task-r(\\d+)\\.md$`, "i");

const ARCHIVE_TASK_HEADER_LINE_RE = /^<!-- envelope-archive:[^\n]*-->\n/;
const ARCHIVE_TASK_HEADER_DISPATCH_ID_RE = /dispatch_id=(\S+)/;

function findLatestArchivedTaskFileName(role, existingNames) {
  const pattern = ARCHIVE_TASK_FILE_NAME_RE_TEMPLATE(role);
  let bestRound = -1;
  let bestName;
  for (const name of existingNames) {
    const m = pattern.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > bestRound) {
      bestRound = n;
      bestName = name;
    }
  }
  return bestName ?? null;
}

// stampDispatchIdOnLatestArchivedTaskFile 자신의 eslint max-lines/
// complexity 상한을 지키려고 뽑았다(동작 변경 없음) -- 대상 파일을
// 찾고 읽는, 순수 I/O 부분만 담당한다.
function readLatestArchivedTaskFile(role, harnessDir, readdirFn, readFileFn) {
  const archiveDir = join(harnessDir, ARCHIVE_SUBDIR);
  let names;
  try {
    names = readdirFn(archiveDir);
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: cannot list ${archiveDir} to find this round's snapshot (${err.message})`,
    };
  }
  const fileName = findLatestArchivedTaskFileName(role, names);
  if (!fileName) {
    return {
      ok: false,
      reason: `envelope-archive: no ${role}-task-r*.md snapshot found in ${archiveDir} -- nothing to stamp (delivery-time snapshot must run first)`,
    };
  }
  const destPath = join(archiveDir, fileName);
  try {
    return { ok: true, destPath, content: readFileFn(destPath, "utf8") };
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: cannot read ${destPath} to stamp dispatch_id (${err.message})`,
    };
  }
}

// stampDispatchIdOnLatestArchivedTaskFile 자신의 eslint max-lines/
// complexity 상한을 지키려고 뽑았다(동작 변경 없음) -- 헤더 판독 +
// one-shot 판정 + 새 헤더 텍스트 계산까지, 파일 I/O가 전혀 없는 순수
// 함수(시험하기 쉽게 분리). 반환 모양: {ok:false, reason} | {ok:true,
// skipped, reason} | {ok:true, skipped:false, rewritten}.
function computeStampedContent(destPath, content, dispatchId) {
  const headerMatch = content.match(ARCHIVE_TASK_HEADER_LINE_RE);
  if (!headerMatch) {
    return {
      ok: false,
      reason: `envelope-archive: ${destPath} has no envelope-archive header line -- not a file this module produced, refusing to stamp`,
    };
  }
  const headerLine = headerMatch[0];
  const idMatch = headerLine.match(ARCHIVE_TASK_HEADER_DISPATCH_ID_RE);
  const existing = idMatch ? idMatch[1] : undefined;
  if (existing === dispatchId) {
    return {
      ok: true,
      skipped: true,
      reason: `envelope-archive: ${destPath} already stamped with dispatch_id=${dispatchId} -- no-op retry`,
    };
  }
  if (existing !== undefined && existing !== "unknown") {
    return {
      ok: false,
      reason: `envelope-archive: refusing to overwrite ${destPath}'s existing dispatch_id=${existing} with a different value (${dispatchId}) -- one-shot stamp, this looks like a race or a forged call`,
    };
  }
  const newHeaderLine = idMatch
    ? headerLine.replace(
        ARCHIVE_TASK_HEADER_DISPATCH_ID_RE,
        `dispatch_id=${dispatchId}`,
      )
    : headerLine.replace(/ -->\n$/, ` dispatch_id=${dispatchId} -->\n`);
  return {
    ok: true,
    skipped: false,
    rewritten: content.replace(ARCHIVE_TASK_HEADER_LINE_RE, newHeaderLine),
  };
}

export function stampDispatchIdOnLatestArchivedTaskFile({
  role,
  harnessDir,
  dispatchId,
  readdirFn = readdirSync,
  readFileFn = readFileSync,
  writeFileFn = writeFileSync,
}) {
  if (!isNonEmptyStringLocal(role)) {
    return {
      ok: false,
      reason: "envelope-archive: role missing -- cannot stamp dispatch_id",
    };
  }
  if (!isNonEmptyStringLocal(dispatchId)) {
    return {
      ok: false,
      reason:
        "envelope-archive: dispatchId missing -- refusing to invent a value (손기입 대체값 금지)",
    };
  }
  const found = readLatestArchivedTaskFile(
    role,
    harnessDir,
    readdirFn,
    readFileFn,
  );
  if (!found.ok) return found;
  const { destPath, content } = found;
  const computed = computeStampedContent(destPath, content, dispatchId);
  if (!computed.ok || computed.skipped) {
    return computed.ok ? { ...computed, path: destPath } : computed;
  }
  try {
    writeFileFn(destPath, computed.rewritten, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `envelope-archive: failed to write stamped dispatch_id to ${destPath} (${err.message})`,
    };
  }
  return {
    ok: true,
    skipped: false,
    reason: `envelope-archive: ${destPath} stamped with dispatch_id=${dispatchId}`,
    path: destPath,
  };
}

// Extraction counterpart of the above -- reads dispatch_id back out of an
// archived round-task snapshot's header. Returns undefined for both "no
// header"/"no field" and the literal "unknown" placeholder (§2 Q2: absence
// is absence, whether it's a pre-migration archive with no field at all or
// a post-migration archive whose delivery-time snapshot hasn't been
// stamped yet) -- callers must treat both the same way (skip the axis, do
// not invent a comparison).
export function extractArchivedDispatchId(content) {
  const headerMatch = content.match(ARCHIVE_TASK_HEADER_LINE_RE);
  if (!headerMatch) return undefined;
  const idMatch = headerMatch[0].match(ARCHIVE_TASK_HEADER_DISPATCH_ID_RE);
  if (!idMatch) return undefined;
  return idMatch[1] === "unknown" ? undefined : idMatch[1];
}
