// HYK-270-stall-visible-2 (coder-task.md §3, §4) -- 세션 기록 파일 "총
// 바이트 수"를 모은다(mtime 아님 -- §3 실측: mtime은 크기가 느는 중에도
// 갱신 안 되는 구간이 관측됐다). deriveClaudeProjectDirName은
// rate-limit-stall-adapter.mjs와 동일 관례를 그대로 재사용한다(중복
// 구현 0).
import { statSync, lstatSync } from "node:fs";
import path from "node:path";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

export const DISPATCH_START_SIZE_COLLECT_REASON = Object.freeze({
  DIR_LIST_FAILED: "DISPATCH_START_SIZE_DIR_LIST_FAILED",
  STAT_FAILED: "DISPATCH_START_SIZE_STAT_FAILED",
});

// ★HYK-378 2R(REVIEW P1-2 반려 수리) -- 1R은 `readdir` 실패를 코드 구분
// 없이 전부 `[]`(폴더 없음과 동형)로 삼켰다. 검토자 실측: `EACCES`를
// 주입하니 하위 전사록 200B가 있는데도 `ok:true/totalBytes:100`으로
// 정상 관측이 나왔다 -- "못 읽었다"가 "괜찮다"로 둔갑한 fail-open.
// ⇒ **부재(ENOENT)와 "경로 성분이 폴더가 아님"(ENOTDIR, entryName이
// 애초에 파일인 흔한 경우)만** 정상으로 접고, 그 밖의 모든 코드(EACCES
// 등)는 실패로 전파한다(불변식 E).
const BENIGN_SUBAGENT_ENUMERATION_CODES = new Set(["ENOENT", "ENOTDIR"]);

// ★HYK-378 -- 하위 에이전트(subagent) 전사록은 최상위 프로젝트 디렉터리에
// 바로 안 쌓이고 `<프로젝트디렉터리>/<세션UUID>/subagents/agent-*.jsonl`에
// 별도로 쌓인다(실측: HYK-337 표본 1이 실제로 남긴 레이아웃 그대로 --
// `.../84260e74-.../subagents/agent-a6bfcf6dd9c3cf211.jsonl`, coder.md
// §1 실측 절 참조). ★범위(2R, REVIEW P2 대응 -- 고정 시험 있음): 이
// `subagents` 폴더 "바로 아래"까지 **한 단계만** 본다 --
// `subagents/nested/deep.jsonl`처럼 그 아래 또 폴더가 있으면 제외한다.
// 근거: 실측된 실제 레이아웃(위 337 표본)이 정확히 이 한 단계 형태뿐이고,
// 하위 에이전트가 자신의 하위 에이전트를 스폰하는(중첩) 사례를 오늘까지
// 관측한 적이 없다 -- 관측 안 된 형태까지 선제로 재귀를 넓히는 것은
// 과설계다(§0 항목·coder-task.md 반복 지시). 그런 레이아웃이 실제로
// 나타나면 그때 재귀 깊이를 넓히고 그 근거를 여기 남긴다.
function collectSubagentJsonlPaths(projectDir, entryName, readdirFn) {
  const subagentsDir = path.join(projectDir, entryName, "subagents");
  let subNames;
  try {
    subNames = readdirFn(subagentsDir);
  } catch (err) {
    if (err && BENIGN_SUBAGENT_ENUMERATION_CODES.has(err.code)) {
      return { ok: true, paths: [] }; // 그런 서브폴더가 없다 -- 정상
      // (하위 에이전트 미가동 또는 entryName이 애초에 디렉터리가 아님).
    }
    return {
      ok: false,
      reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.DIR_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }
  return {
    ok: true,
    paths: subNames
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(subagentsDir, n)),
  };
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
    const sub = collectSubagentJsonlPaths(projectDir, name, readdirFn);
    if (!sub.ok) return sub; // ★2R -- 열거 실패를 조용히 안 삼킨다(불변식 E).
    paths.push(...sub.paths);
  }
  return { ok: true, paths };
}

// ★HYK-378 2R(REVIEW P2 대응) -- `statSync`는 심볼릭 링크를 따라간다.
// 검토자 실측: 프로젝트 "밖"을 가리키는 링크(`linked.jsonl`)가 있으면
// 그 바깥 파일의 바이트가 합계에 섞여 들어왔다(신뢰 경계 밖 데이터가
// "이 세션이 자랐다"는 증거로 둔갑). ★결정(반박 환영) -- 이 세션 기록
// 폴더는 관제실이 아니라 좌석 프로세스가 직접 쓰는 자리라 정상 운영
// 중에는 심볼릭 링크가 나타날 이유가 없다 -- 그래서 "따라가지 않는다"
// (신뢰 경계 밖은 세지 않는다, 검토자 권고 그대로): 링크로 확인되면
// 그 항목은 총합·개수 양쪽에서 제외한다(에러로 취급하지 않는다 -- 링크
// 자체는 "관측 실패"가 아니라 "이 항목은 신뢰 안 함"이라는 정책적 배제).
function isSymlink(filePath, lstatFn) {
  return lstatFn(filePath).isSymbolicLink();
}

// sumFileSizes(filePaths, {statFn, lstatFn}) -> {ok, totalBytes,
// includedCount} | {ok:false, reasonCode, detail} --
// collectTotalSessionBytes에서 분리(위와 동일 이유). 심볼릭 링크는
// 위 정책대로 조용히 건너뛴다(개수·총합 모두 제외) -- lstat 자체가
// 실패하면(파일이 그 사이 사라짐 등) 기존과 동일하게 실패로 전파한다.
function sumFileSizes(filePaths, { statFn, lstatFn }) {
  let totalBytes = 0;
  let includedCount = 0;
  for (const filePath of filePaths) {
    let linkIsSymlink;
    try {
      linkIsSymlink = isSymlink(filePath, lstatFn);
    } catch (err) {
      return {
        ok: false,
        reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
        detail: err && err.message ? err.message : String(err),
      };
    }
    if (linkIsSymlink) continue; // 신뢰 경계 밖 -- 안 세고 안 따라간다.
    try {
      totalBytes += statFn(filePath).size;
    } catch (err) {
      return {
        ok: false,
        reasonCode: DISPATCH_START_SIZE_COLLECT_REASON.STAT_FAILED,
        detail: err && err.message ? err.message : String(err),
      };
    }
    includedCount += 1;
  }
  return { ok: true, totalBytes, includedCount };
}

// collectTotalSessionBytes({repoRoot, claudeHomeDir}, {readdirFn, statFn,
// lstatFn}) -> {ok, totalBytes, fileCount} | {ok:false, reasonCode, detail}
//
// - 세션 로그 디렉터리 자체가 없으면(아직 이 워크트리에 세션이 하나도
//   시작 안 됨) 정상적으로 `totalBytes:0`이다(결손 아님 -- "아직 시작
//   전"과 "판정 불가"를 구별한다).
export function collectTotalSessionBytes(
  { repoRoot, claudeHomeDir },
  { readdirFn, statFn = statSync, lstatFn = lstatSync },
) {
  const projectDir = path.join(
    claudeHomeDir,
    "projects",
    deriveClaudeProjectDirName(repoRoot),
  );
  const listed = listAllSessionJsonlPaths(projectDir, readdirFn);
  if (!listed.ok) return listed;

  const summed = sumFileSizes(listed.paths, { statFn, lstatFn });
  if (!summed.ok) return summed;

  return {
    ok: true,
    totalBytes: summed.totalBytes,
    fileCount: summed.includedCount,
  };
}
