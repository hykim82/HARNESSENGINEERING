// HYK-185 B/C (coder-task.md §5-C) -- ORCH 무진행 판정의 "부를 수 있는"
// 외부 진입점. `node scripts/supervisor/orch-stall-detect.mjs --pledges
// <path> [--now <iso>] [--threshold-s <n>] [--json]`.
//
// 하는 일 = 약속 파일을 읽고 -> 저장소 파일 시스템 + git으로 관측을
// 모으고 -> orch-progress-core.mjs(judgeOrchProgress)에 넘겨 판정하고 ->
// 사람이 읽을 한 줄 + `--json`이면 기계용 객체를 낸다. 종료 코드로
// 판정을 알린다(아래 EXIT_CODE_BY_VERDICT).
//
// S11 필수 5가지 (coder-task.md §5-D, 문구 그대로):
// 1. **증명하지 않는다**: "진행"을 산출물의 존재·시각으로 근사한다.
//    생각만 하고 산출물이 없는 정당한 구간은 무진행과 구별되지 않을 수
//    있다.
// 2. **약속을 기록하지 않으면 검사 대상이 아니다** -- 자기 신고 의존이
//    완전히 사라지지 않는다. 줄어드는 것은 "신고했는데 그 뒤 아무 일도
//    없었다" 구간이다.
// 3. **감시자 자신이 멈추면 아무도 감시하지 않는다**(감시자의 감시자
//    문제) -- 이 조각의 범위 밖이다.
// 4. ★**아직 아무도 이 진입점을 주기적으로 부르지 않는다** -- 부를 수
//    있는 것과 불리고 있는 것은 다르다. 주기 실행 결선(OS 스케줄러 등록,
//    supervisor v2 결선 등)은 별도 승인 대상이며 이번 사이클에 없다. 이
//    파일을 import하거나 실행하는 코드는 이 파일 자신의 `.test.mjs`
//    외에 저장소에 없다(실측: grep).
// 5. `orca`를 호출하지 않는다 -- 명령 문자열 조립도 하지 않는다.
//    화면 문자열·컨텍스트 %를 판정 근거로 쓰지 않는다.
//
// 부작용 0(coder-task.md §5-C): 아무것도 고치지 않고 아무 데도 보내지
// 않는다 -- 읽기 전용(약속 파일 읽기 + `git rev-parse`/`git
// merge-base --is-ancestor`만 실행, 둘 다 로컬 조회이며 상태를 바꾸지
// 않는다). 관측 수집은 저장소 안 파일 시스템 + git만 쓴다 -- `orca`·
// Claude 훅·에이전트 API·네트워크(`git fetch` 포함) 호출 0.
//
// Node 20 호환(coder-task.md §2-11) -- ESM 표준 API만 사용.
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  judgeOrchProgress,
  ARTIFACT_KIND,
  ORCH_PROGRESS_VERDICT,
} from "./orch-progress-core.mjs";

// 정지 의심과 판정 불가를 같은 코드로 접지 않는다(coder-task.md §5-C
// 비타협). WAITING_HUMAN_GATE는 "정지 의심"이 아니라 정당한 대기이므로
// 별도 코드를 준다.
export const EXIT_CODE_BY_VERDICT = Object.freeze({
  [ORCH_PROGRESS_VERDICT.PROGRESSING]: 0,
  [ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE]: 1,
  [ORCH_PROGRESS_VERDICT.STALLED]: 2,
  [ORCH_PROGRESS_VERDICT.UNDECIDABLE]: 3,
});

const DROPPED_AT_RE =
  /^dropped_at:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) KST\s*$/im;

export function parseArgs(argv) {
  const parsed = {
    pledgesPath: null,
    nowIso: null,
    thresholdSeconds: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pledges") parsed.pledgesPath = argv[++i] ?? null;
    else if (a === "--now") parsed.nowIso = argv[++i] ?? null;
    else if (a === "--threshold-s") parsed.thresholdSeconds = Number(argv[++i]);
    else if (a === "--json") parsed.json = true;
  }
  return parsed;
}

function resolveRepoPath(repoRoot, relOrAbsPath) {
  return path.isAbsolute(relOrAbsPath)
    ? relOrAbsPath
    : path.join(repoRoot, relOrAbsPath);
}

// FILE_EXISTS_AFTER / RESULT_FILE_APPEARS_AFTER 공용 -- 둘 다 "경로의
// 존재 + mtime" 관측 형태가 같다(§신규 어휘 선언 참조, orch-progress-
// core.mjs).
function collectFileMtime(repoRoot, relPath) {
  try {
    const full = resolveRepoPath(repoRoot, relPath);
    if (!existsSync(full))
      return { collected: true, exists: false, mtimeMs: null };
    const st = statSync(full);
    return { collected: true, exists: true, mtimeMs: st.mtimeMs };
  } catch {
    return { collected: false };
  }
}

// `.harness/*-task.md` 헤더의 `dropped_at`(coder-task.md §2-6 실재 필드).
// 헤더가 없거나 형식이 어긋나면 이 값은 신뢰할 수 없으므로 수집 자체를
// 실패로 접는다(collected:false -- fail-closed, 코어가 다시 UNDECIDABLE로
// 닫는다).
function collectTaskFileDropped(repoRoot, relPath) {
  try {
    const full = resolveRepoPath(repoRoot, relPath);
    if (!existsSync(full)) {
      return { collected: true, taskFileExists: false, droppedAtMs: null };
    }
    const text = readFileSync(full, "utf8");
    const m = text.match(DROPPED_AT_RE);
    if (!m) return { collected: false };
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return { collected: false };
    return { collected: true, taskFileExists: true, droppedAtMs: t };
  } catch {
    return { collected: false };
  }
}

// `git merge-base --is-ancestor <sha> <ref>` -- 로컬 git 객체만 본다
// (`git fetch` 없음). exit 0 = 포함, exit 1 = 명확히 미포함, 그 외
// (알 수 없는 revision 등)는 신뢰할 수 없으므로 수집 실패로 접는다.
function collectRemoteContains(repoRoot, commitSha, remoteRef) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commitSha, remoteRef], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return { collected: true, contains: true };
  } catch (err) {
    if (typeof err.status === "number" && err.status === 1) {
      return { collected: true, contains: false };
    }
    return { collected: false };
  }
}

// pledge 하나의 expectedArtifact.kind에 맞는 관측 하나를 모은다. 형태가
// 이상한 pledge(예: expectedArtifact 결손)는 여기서 관측을 만들지 않는다
// -- 코어가 어차피 구조 전제조건에서 그 pledge를 PLEDGE_INVALID로 닫는다.
export function collectObservationForPledge(repoRoot, pledge) {
  const ea =
    pledge && typeof pledge === "object" ? pledge.expectedArtifact : null;
  if (!ea || typeof ea !== "object") return null;
  if (ea.kind === ARTIFACT_KIND.FILE_EXISTS_AFTER) {
    return collectFileMtime(repoRoot, ea.path);
  }
  if (ea.kind === ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER) {
    return collectFileMtime(repoRoot, ea.path);
  }
  if (ea.kind === ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER) {
    return collectTaskFileDropped(repoRoot, ea.path);
  }
  if (ea.kind === ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT) {
    return collectRemoteContains(repoRoot, ea.commitSha, ea.remoteRef);
  }
  return null;
}

export function collectObservation(repoRoot, pledges) {
  const observation = {};
  const list = Array.isArray(pledges) ? pledges : [];
  for (const pledge of list) {
    if (!pledge || typeof pledge.pledgeId !== "string") continue;
    const entry = collectObservationForPledge(repoRoot, pledge);
    if (entry) observation[pledge.pledgeId] = entry;
  }
  return observation;
}

function resolveRepoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function readPledges(pledgesPath) {
  try {
    const doc = JSON.parse(readFileSync(pledgesPath, "utf8"));
    if (Array.isArray(doc)) return { ok: true, pledges: doc };
    if (Array.isArray(doc?.pledges)) return { ok: true, pledges: doc.pledges };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`${result.verdict} (${result.reasonCode})`);
}

// runOrchStallDetect(argv) -> {result, exitCode} -- CLI 몸통을 순수 함수에
// 가깝게 뽑아 시험이 process.exit 없이 호출할 수 있게 한다. I/O(파일
// 읽기·git 실행)는 그대로 하되, 프로세스 종료·stdout 출력은 하지 않는다.
export function runOrchStallDetect(argv) {
  const cli = parseArgs(argv);
  if (!cli.pledgesPath) {
    return {
      result: {
        ok: false,
        verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
        reasonCode: "USAGE_ERROR",
        details: null,
      },
      exitCode: 3,
      cli,
    };
  }
  const repoRoot = resolveRepoRoot();
  const loaded = readPledges(cli.pledgesPath);
  if (!loaded.ok) {
    return {
      result: {
        ok: false,
        verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
        reasonCode: "PLEDGES_FILE_UNREADABLE",
        details: null,
      },
      exitCode: 3,
      cli,
    };
  }
  const now = cli.nowIso ? Date.parse(cli.nowIso) : Date.now();
  if (Number.isNaN(now)) {
    return {
      result: {
        ok: false,
        verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
        reasonCode: "NOW_ARG_UNPARSEABLE",
        details: null,
      },
      exitCode: 3,
      cli,
    };
  }
  const observation = collectObservation(repoRoot, loaded.pledges);
  const result = judgeOrchProgress({
    pledges: loaded.pledges,
    observation,
    now,
    thresholdSeconds: cli.thresholdSeconds,
  });
  return { result, exitCode: EXIT_CODE_BY_VERDICT[result.verdict] ?? 3, cli };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/orch-stall-detect.mjs");
if (invokedDirectly) {
  const { result, exitCode, cli } = runOrchStallDetect(process.argv.slice(2));
  printResult(result, cli.json);
  process.exit(exitCode);
}
