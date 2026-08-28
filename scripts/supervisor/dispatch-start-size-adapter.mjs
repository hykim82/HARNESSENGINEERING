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

// ★HYK-378 -- 하위 에이전트(subagent) 전사록은 최상위 프로젝트 디렉터리에
// 바로 안 쌓이고 `<프로젝트디렉터리>/<세션UUID>/subagents/agent-*.jsonl`에
// 별도로 쌓인다(실측: HYK-337 표본 1이 실제로 남긴 레이아웃 그대로 --
// `.../84260e74-.../subagents/agent-a6bfcf6dd9c3cf211.jsonl`, coder.md
// §1 실측 절 참조). 그 전까지 이 함수는 프로젝트 디렉터리 "바로 아래"
// `.jsonl`만 셌다 -- 그러면 작업이 하위 에이전트 안에서만 도는 구간에는
// 그 세션의 "본" jsonl이 정말로 안 자라서(실측: 3분 넘게 무증가), 정확히
// 그 시간 동안 실제로는 별도 파일에서 계속 자라고 있던 진행 상황이
// 통째로 안 보였다(오늘 실사고 표본 1). 한 단계만 더 내려가 이 서브폴더를
// 함께 센다(그 이상 재귀 0 -- 실측된 실제 레이아웃 그대로, 과설계 금지).
function collectSubagentJsonlPaths(projectDir, entryName, readdirFn) {
  const subagentsDir = path.join(projectDir, entryName, "subagents");
  let subNames;
  try {
    subNames = readdirFn(subagentsDir);
  } catch {
    return []; // 그런 서브폴더가 없다 -- 정상(하위 에이전트 미가동 또는
    // entryName이 애초에 디렉터리가 아님).
  }
  return subNames
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => path.join(subagentsDir, n));
}

// listAllSessionJsonlPaths(projectDir, readdirFn) -> {ok, paths} |
// {ok:false, reasonCode, detail} -- collectTotalSessionBytes에서 분리(eslint
// complexity 상한 준수, 로직은 그대로). 최상위 `.jsonl` + 그 아래
// `<entry>/subagents/*.jsonl`(위 collectSubagentJsonlPaths)을 한데 모은다.
function listAllSessionJsonlPaths(projectDir, readdirFn) {
  let entries;
  try {
    entries = readdirFn(projectDir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, paths: [] };
    }
    return {
      ok: false,
      reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.DIR_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }

  const paths = [];
  for (const name of entries) {
    if (name.endsWith(".jsonl")) {
      paths.push(path.join(projectDir, name));
      continue;
    }
    paths.push(...collectSubagentJsonlPaths(projectDir, name, readdirFn));
  }
  return { ok: true, paths };
}

// sumFileSizes(filePaths, statFn) -> {ok, totalBytes} | {ok:false,
// reasonCode, detail} -- collectTotalSessionBytes에서 분리(위와 동일 이유).
function sumFileSizes(filePaths, statFn) {
  let totalBytes = 0;
  for (const filePath of filePaths) {
    try {
      totalBytes += statFn(filePath).size;
    } catch (err) {
      return {
        ok: false,
        reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
        detail: err && err.message ? err.message : String(err),
      };
    }
  }
  return { ok: true, totalBytes };
}

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
  const listed = listAllSessionJsonlPaths(projectDir, readdirFn);
  if (!listed.ok) return listed;

  const summed = sumFileSizes(listed.paths, statFn);
  if (!summed.ok) return summed;

  return {
    ok: true,
    totalBytes: summed.totalBytes,
    fileCount: listed.paths.length,
  };
}
