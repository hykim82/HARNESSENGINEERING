import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
export function nextArchiveFileName(role, existingNames) {
  const pattern = new RegExp(`^${escapeForRegex(role)}-r(\\d+)\\.md$`);
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

// HYK-241 §2 조각1: task 파일(`<role>-task.md`) 쪽의 같은 덮어쓰기 문제 --
// 라운드마다 ORCH가 다음 task 파일을 같은 이름으로 다시 쓰면, 지금까지
// «우리가 무엇을 지시했는가»의 원문이 그 순간 사라진다(§1 실사고: 결과
// 파일은 archiveRoundEnvelope가 보존하는데 지시서는 그 대상이 아니었다).
// 별도 이름 패턴(`<role>-task-r<N>.md`)을 써서 nextArchiveFileName의 기존
// 계약(정확히 `<role>-r<N>.md`만 셈)과 절대 충돌하지 않는다 -- 두 정규식
// 모두 상대방의 파일명을 매치하지 않는다(태그 사이에 반드시 `-task-`가
// 끼어 있어야 함).
export function nextTaskArchiveFileName(role, existingNames) {
  const pattern = new RegExp(`^${escapeForRegex(role)}-task-r(\\d+)\\.md$`);
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
    const destPath = join(archiveDir, fileName);
    const droppedAt = extractDroppedAt(taskContent);
    const header = `<!-- envelope-archive: role=${role} kind=task dropped_at=${droppedAt} -->\n`;
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
