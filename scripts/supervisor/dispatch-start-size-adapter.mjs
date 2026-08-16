// HYK-270-stall-visible-2 (coder-task.md §3, §4) -- 세션 기록 파일 "총
// 바이트 수"를 모은다(mtime 아님 -- §3 실측: mtime은 크기가 느는 중에도
// 갱신 안 되는 구간이 관측됐다). deriveClaudeProjectDirName은
// rate-limit-stall-adapter.mjs와 동일 관례를 그대로 재사용한다(중복
// 구현 0).
import { statSync } from "node:fs";
import path from "node:path";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

export const DISPATCH_START_SIZE_COLLECT_REASON = Object.freeze({
  DIR_LIST_FAILED: "DISPATCH_START_SIZE_DIR_LIST_FAILED",
  STAT_FAILED: "DISPATCH_START_SIZE_STAT_FAILED",
});

// collectTotalSessionBytes({repoRoot, claudeHomeDir}, {readdirFn, statFn}) ->
// {ok, totalBytes, fileCount} | {ok:false, reasonCode, detail}
//
// - 세션 로그 디렉터리 자체가 없으면(아직 이 워크트리에 세션이 하나도
//   시작 안 됨) 정상적으로 `totalBytes:0`이다(결손 아님 -- "아직 시작
//   전"과 "판정 불가"를 구별한다).
export function collectTotalSessionBytes(
  { repoRoot, claudeHomeDir },
  { readdirFn, statFn = statSync },
) {
  const projectDir = path.join(
    claudeHomeDir,
    "projects",
    deriveClaudeProjectDirName(repoRoot),
  );
  let fileNames;
  try {
    fileNames = readdirFn(projectDir).filter((n) => n.endsWith(".jsonl"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, totalBytes: 0, fileCount: 0 };
    }
    return {
      ok: false,
      reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.DIR_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }

  let totalBytes = 0;
  for (const name of fileNames) {
    try {
      totalBytes += statFn(path.join(projectDir, name)).size;
    } catch (err) {
      return {
        ok: false,
        reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
        detail: err && err.message ? err.message : String(err),
      };
    }
  }
  return { ok: true, totalBytes, fileCount: fileNames.length };
}
