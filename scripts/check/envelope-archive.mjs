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

const ARCHIVE_SUBDIR = "rounds";

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// HYK-204 §2 축3(이름): 라운드 번호는 사람이 손으로 대는 값이 아니라 이미
// 그 role의 archive 폴더에 몇 개가 쌓여 있는지를 세어 기계적으로 매긴다
// -- "동일 파일명 재사용(=덮어쓰기 재발)"을 막는 것이 이 함수의 유일한
// 계약이므로, 순번을 건너뛰거나 파일이 지워졌더라도 기존 최댓값+1을 써서
// 절대 과거 순번을 재사용하지 않는다.
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
