// HYK-185 B/C/gap#61 (coder-task.md §5-C, §5-B) -- ORCH 무진행 판정의
// "부를 수 있는" 외부 진입점. `node scripts/supervisor/orch-stall-detect.mjs
// [--pledges <path>] [--now <iso>] [--threshold-s <n>] [--json]
// [--repo-root <path>]`(`--repo-root`는 생략 시 실제 저장소, 시험 전용
// 격리 오버라이드는 아래 참조).
//
// 하는 일 = (선택) 약속 파일을 읽고 + 저장소 흔적에서 약속을 유도하고 ->
// 둘을 합쳐 -> 저장소 파일 시스템 + git으로 관측을 모으고 ->
// orch-progress-core.mjs(judgeOrchProgress)에 넘겨 판정하고 -> 사람이
// 읽을 한 줄 + `--json`이면 기계용 객체를 낸다. 종료 코드로 판정을
// 알린다(아래 EXIT_CODE_BY_VERDICT).
//
// gap#61 결선(coder-task.md §5-B, ★이 사이클의 실질 성과): `--pledges`는
// 이제 **생략 가능**하다 -- 생략하면 선언된 약속 없이 유도된 약속만으로
// 판정한다(선언 파일이 아예 없어도 저장소 흔적만으로 판정이 나온다).
// `--pledges`를 줬는데 그 경로를 읽을 수 없으면(존재하지 않음·JSON
// 파싱 실패 등) 여전히 오류(UNDECIDABLE)다 -- "안 줬다"와 "줬는데
// 못 읽었다"를 구별한다.
//
// 유도 + 선언 병합 규칙(coder-task.md §5-B "선언이 유도를 조용히 덮어써
// 상태를 바꾸지 못하게 하라"): `pledgeId`가 같은 선언된 약속과 유도된
// 약속이 있으면 **유도된 쪽이 이긴다**(derivePledges가 만드는 pledgeId는
// `derived:` 접두어를 쓰므로 통상 충돌하지 않지만, ORCH가 실수로/의도적으로
// 같은 id의 약속을 선언해도 유도된 판정을 조용히 지우지 못하도록 이
// 방향으로 고정한다). pledgeId가 문자열이 아닌 항목은 dedup 없이 그대로
// 통과시켜 orch-progress-core.mjs의 구조 검사(PLEDGE_INVALID)에 맡긴다.
//
// S11 필수 5가지 (coder-task.md §5-D, 문구 그대로):
// 1. **증명하지 않는다**: "진행"을 산출물의 존재·시각으로 근사한다.
//    생각만 하고 산출물이 없는 정당한 구간은 무진행과 구별되지 않을 수
//    있다.
// 2. **약속을 기록하지 않으면 검사 대상이 아니다** -- gap#61로 이
//    의존이 줄었지만 사라지지는 않았다. 저장소에 흔적을 남기는 형태
//    (드롭된 태스크 파일 · 결과 미도착 대기 · 원격에 없는 로컬 커밋)는
//    이제 ORCH가 적지 않아도 pledge-derive-core.mjs가 유도한다. 그러나
//    **흔적을 전혀 남기지 않는 선언**("이제 X를 하겠다"만 말하고
//    산출물·커밋 어느 것도 없음)은 여전히 유도할 근거가 없다 --
//    HYK-185 §6 실제 정지 4건 중 유도 가능은 **3건**이다(★재작업 1R --
//    `.harness/coder.md` §4건 유도 가능성 판정표 참조, "전부 덮인다"고
//    말하지 않는다).
// 3. **감시자 자신이 멈추면 아무도 감시하지 않는다**(감시자의 감시자
//    문제) -- 이 조각의 범위 밖이다.
// 4. ★**아직 아무도 이 진입점을 주기적으로 부르지 않는다** -- 부를 수
//    있는 것과 불리고 있는 것은 다르다. 주기 실행 결선(OS 스케줄러 등록,
//    supervisor v2 결선 등)은 별도 승인 대상이며 이번 사이클에 없다. 이
//    파일을 import하거나 실행하는 코드는 이 파일 자신의 `.test.mjs`
//    외에 저장소에 없다(실측: grep).
// 5. ★★(HYK-185 seat-wire로 갱신, coder-task.md §2-1) 이 파일 **자신은**
//    `orca`를 spawn하지 않는다(G9 정적 검사, `node
//    scripts/check/orca-cli-boundary.mjs`가 강제) -- 명령 문자열도 이
//    파일이 조립하지 않는다. 단 **좌석 무응답(liveness) 관측만은**
//    `scripts/relay/adapters/orca-adapter.mjs`의 읽기 전용
//    `collectSeatLivenessObservation`(terminal list/show만, dispatch·
//    send·close·stop·worktree 호출 0)을 통해 **간접적으로** `orca`를
//    부른다. 무진행(pledge/observation) 축은 여전히 화면 문자열·
//    컨텍스트 %를 판정 근거로 쓰지 않는다(변경 없음).
//
// 부작용 0(coder-task.md §5-C, HYK-185 seat-wire §2-1로 갱신): 저장소
// 상태는 아무것도 고치지 않고 아무 데도 보내지 않는다 -- 읽기 전용(약속
// 파일 읽기 + `git rev-parse`/`git merge-base --is-ancestor`만 실행, 둘
// 다 로컬 조회이며 상태를 바꾸지 않는다 + 좌석 무응답 관측의 `terminal
// list`/`terminal show`도 읽기 전용 조회다). Claude 훅·네트워크(`git
// fetch` 포함) 호출은 여전히 0.
//
// ---- HYK-185 seat-wire (coder-task.md §1) -- 좌석 무응답 판정 결선 ----
// 예약 감시(`watch-run.mjs`)가 이 파일을 부르는 경로에서
// `seat-liveness-core.mjs`(gap#76, 판정만 있고 부르는 곳이 0이던 코어)의
// `judgeSeatLiveness`가 실제로 호출되게 한다. 대상 = 이 저장소
// (`--repo-root`) 자신의 워크트리에 붙은 좌석 -- 아직 결과 파일이 없는
// (`.harness/*-task.md`가 있고 대응 `.md`가 아직 없는) "활성 배달"이 있을
// 때만 판정한다(§2-2 아래 `selectActiveDispatch`).
//
// ★관측 수집 실패를 "무응답"으로 접지 않는다(§2-2 비타협, gap#61에서
// 검토자가 잡아낸 형태와 동일 -- 수집 실패가 빈 값으로 접혀 조용히 통과로
// 새는 것을 반복하지 않는다): `collectSeatLivenessObservation`이
// `ok:false`(조회 자체 실패)면 `SEAT_LIVENESS_COLLECTION_FAILED`로
// 표면화하고 `judgeSeatLiveness`를 아예 부르지 않는다 -- `seatCount:0`
// (좌석이 그냥 없음, 정상)과는 반환 형태부터 다르다(아래
// `judgeSeatLivenessForRepo`의 4상태 `SEAT_LIVENESS_WIRE_STATUS` 참조).
//
// v1은 로그만 남긴다(§2-3) -- 이 조각은 `watch-run.mjs`의 로그 한 줄에
// 실릴 필드만 만들 뿐, `orch-progress`의 `EXIT_CODE_BY_VERDICT`(종료
// 코드)에는 관여하지 않는다(종료 코드가 다른 자동 조치의 트리거가 되는
// 것을 피하기 위해 의도적으로 분리 -- 알림 0 비타협).
//
// Node 20 호환(coder-task.md §2-11) -- ESM 표준 API만 사용.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  judgeOrchProgress,
  ARTIFACT_KIND,
  ORCH_PROGRESS_VERDICT,
} from "./orch-progress-core.mjs";
import { derivePledges, PLEDGE_SOURCE } from "./pledge-derive-core.mjs";
import {
  judgeSeatLiveness,
  SEAT_LIVENESS_VERDICT,
} from "./seat-liveness-core.mjs";
import {
  collectSeatLivenessObservation,
  createOrcaExecFn,
} from "../relay/adapters/orca-adapter.mjs";

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
const TASK_ID_RE = /^task_id:\s*(\S.*?)\s*$/im;

export function parseArgs(argv) {
  const parsed = {
    pledgesPath: null,
    nowIso: null,
    thresholdSeconds: undefined,
    json: false,
    repoRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pledges") parsed.pledgesPath = argv[++i] ?? null;
    else if (a === "--now") parsed.nowIso = argv[++i] ?? null;
    else if (a === "--threshold-s") parsed.thresholdSeconds = Number(argv[++i]);
    else if (a === "--json") parsed.json = true;
    // `--repo-root` -- 생략 시 실제 저장소(`git rev-parse --show-toplevel`)를
    // 그대로 쓴다(운영 시 기본 경로). 시험이 mkdtemp 합성 저장소를 가리켜
    // gap#61 증거 수집(.harness 스캔·git 조회)을 실제 워크트리에서
    // 격리하는 용도(coder-task.md §9 비타협 #5 "시험은 mkdtemp 안에서만").
    else if (a === "--repo-root") parsed.repoRoot = argv[++i] ?? null;
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

// HYK-185-residue-rule-2(coder-task.md §R P1-1, §2-2-ㄴ) -- "짝 어긋남":
// 태스크 파일의 `task_id`와, 같은 디렉터리의 대응 결과 파일(`<role>-task.md`
// -> `<role>.md` 명명 관례)이 echo하는 `task_id`가 서로 다르면 잔재
// 신호다. **판단 불가는 항상 false(신호 없음)로 접는다** -- 관례를 벗어난
// 파일명·결과 파일 부재·어느 한쪽 task_id 헤더 결손은 이 축이 "모른다"는
// 뜻이며, 잔재를 지어내지 않는다(나이 축은 이 함수와 무관하게 derive
// 코어에서 별도로 여전히 작동한다). ★2R부터 이 값은 **증거(evidence)**로
// pledge-derive-core.mjs에 넘어간다 -- 1R에서는 관측(observation) 층에
// 잘못 놓아 판정 코어(orch-progress-core.mjs)가 사람 게이트 의미론을
// 우회하는 문제가 있었다(REVIEW P1-1 반려, coder-task.md §R 참조).
function computeTaskIdMismatch(repoRoot, taskFileRelPath, taskFileTaskId) {
  if (!taskFileTaskId) return false;
  const resultRelPath = taskFileRelPath.replace(/-task\.md$/, ".md");
  if (resultRelPath === taskFileRelPath) return false; // 명명 관례 밖 -- 판단 불가.
  try {
    const resultFull = resolveRepoPath(repoRoot, resultRelPath);
    if (!existsSync(resultFull)) return false;
    const resultText = readFileSync(resultFull, "utf8");
    const resultIdMatch = resultText.match(TASK_ID_RE);
    if (!resultIdMatch) return false;
    return taskFileTaskId !== resultIdMatch[1];
  } catch {
    return false;
  }
}

// gap#61(coder-task.md §5-B, §6 실측) -- pledge-derive-core.mjs가 소비할
// evidence를 저장소 파일 시스템 + git에서 모은다. 이 함수 자신은
// derivePledges와 달리 I/O를 한다(진입점의 몫, coder-task.md §5-B 그대로
// -- 코어는 순수 함수로 남고 수집은 여기서만).
//
// 실측 표(coder-task.md §6-1) -- 이 표에 없는 필드는 evidence에 넣지
// 않는다:
// - 드롭된 태스크 파일: `.harness/*-task.md` 각각의 `task_id`·
//   `dropped_at` 헤더(collectTaskFileDropped와 동일 정규식 재사용) +
//   대응 결과 파일(`<role>-task.md` -> `<role>.md`, 같은 디렉터리)의
//   **경로**·존재/mtime(★재작업 1R -- 경로는 결과가 아직 없을 때
//   `RESULT_FILE_APPEARS_AFTER` 약속의 `expectedArtifact.path`로 쓰인다)
//   **· taskIdMismatch**(★HYK-185-residue-rule-2 신규 -- 결과 파일이 있을
//   때만 의미가 있다, 위 `computeTaskIdMismatch` 참조).
// - 로컬 커밋 vs 원격: 현재 브랜치의 HEAD 커밋 vs 그 브랜치의 upstream(
//   `@{u}`) -- upstream이 설정돼 있지 않으면(아직 한 번도 push할 원격을
//   추적한 적 없는 브랜치) 이 계열은 수집 대상이 없다(결손이 아니라
//   "이 저장소 상태에서는 애초에 해당 없음").
// ★재작업 2R(coder-task.md §11 P1) -- "정상적으로 없음"과 "확인 못 함"을
// 구별해 `{items, failed}`로 반환한다(REVIEW가 재현한 fail-open: 이전엔
// 둘 다 `catch -> []`로 접혀 진입점이 "약속 없음"으로 오판했다).
// `ENOENT`(`.harness`가 아직 없음)는 정상(§11 ㄱ의 연장 -- harness를 아직
// 한 번도 안 쓴 저장소), 그 밖(`ENOTDIR`·`EACCES` 등 실제 읽기 실패)만
// `failed:true`(§11 ㄴ).
// HYK-185 seat-scan: opts.readdirFn 주입 가능(시험 전용) -- 기본은 실
// readdirSync. §3-c-③ "개별 워크트리 .harness 읽기 실패"를 결정적으로
// 재현하려면 실제 OS 권한 오류를 흉내내기 어려우므로, 이 지점 하나에
// 주입 지점을 둔다(다른 호출자, collectPledgeDerivationEvidence는 opts
// 없이 불러 기존 동작을 그대로 유지한다).
export function collectDroppedTaskFileEvidence(repoRoot, opts = {}) {
  const readdirFn =
    typeof opts.readdirFn === "function" ? opts.readdirFn : readdirSync;
  const harnessDir = path.join(repoRoot, ".harness");
  let names;
  try {
    names = readdirFn(harnessDir).filter((n) => n.endsWith("-task.md"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { items: [], failed: false };
    return { items: [], failed: true };
  }
  const items = [];
  for (const name of names) {
    const relPath = `.harness/${name}`;
    let text;
    try {
      text = readFileSync(path.join(harnessDir, name), "utf8");
    } catch {
      continue;
    }
    const droppedMatch = text.match(DROPPED_AT_RE);
    if (!droppedMatch) continue; // dropped_at 헤더가 아예 없음 -- "드롭됨" 흔적 자체가 없다.
    const iso = `${droppedMatch[1]}-${droppedMatch[2]}-${droppedMatch[3]}T${droppedMatch[4]}:${droppedMatch[5]}:00+09:00`;
    const droppedAtMs = Date.parse(iso);
    const taskIdMatch = text.match(TASK_ID_RE);
    const resultName = name.replace(/-task\.md$/, ".md");
    const resultPath = `.harness/${resultName}`;
    const resultFile = collectFileMtime(repoRoot, resultPath);
    const taskId = taskIdMatch ? taskIdMatch[1] : null;
    items.push({
      path: relPath,
      taskId,
      droppedAtMs: Number.isNaN(droppedAtMs) ? null : droppedAtMs,
      resultFile:
        resultFile.collected === true
          ? {
              path: resultPath,
              exists: resultFile.exists,
              mtimeMs: resultFile.mtimeMs,
            }
          : { path: resultPath, exists: false, mtimeMs: null },
      taskIdMismatch: computeTaskIdMismatch(repoRoot, relPath, taskId),
    });
  }
  return { items, failed: false };
}

// git 호출 하나 -- stdout만 캡처하고 stderr는 항상 삼킨다(★재작업 2R
// P2: "no upstream configured" 같은 정상 제어흐름의 실패가 stderr로
// 새어나가 주기 실행 시 소음이 되는 것을 막는다. 실패 자체는 여전히
// throw로 알려지므로 -- 삼키는 것은 소음뿐, 판정에 필요한 실패 신호는
// 그대로 살아있다).
function gitQuiet(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// ★재작업 2R(coder-task.md §11 P1) -- `{items, failed}`로 "정상"과
// "확인 못 함"을 구별한다.
// - 현재 브랜치 자체를 못 구한다(저장소가 아님 등) -> `failed:true`(§11 ㄹ).
// - upstream이 없다 -> 정상(§11 ㄷ, 이 브랜치는 애초에 발행 약속 대상이
//   아니다) -- P2로 이 실패의 stderr는 삼켰지만 실패 자체(catch)는
//   여전히 여기서 판정에 쓰인다(정상으로 접히는 것이지 안 보이는 게
//   아니다).
// - 그 밖(커밋 조회 등에서 예기치 못한 git 실패) -> 안전하게 `failed:true`.
function collectLocalVsRemoteEvidence(repoRoot) {
  let branch;
  try {
    branch = gitQuiet(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return { items: [], failed: true };
  }
  let upstream;
  try {
    upstream = gitQuiet(repoRoot, [
      "rev-parse",
      "--abbrev-ref",
      `${branch}@{u}`,
    ]);
  } catch {
    return { items: [], failed: false }; // upstream 미설정 -- 해당 없음(결손 아님).
  }
  try {
    const commitSha = gitQuiet(repoRoot, ["rev-parse", "HEAD"]);
    const commitTimeRaw = gitQuiet(repoRoot, [
      "show",
      "-s",
      "--format=%cI",
      "HEAD",
    ]);
    const commitTimeMs = Date.parse(commitTimeRaw);
    const containsEntry = collectRemoteContains(repoRoot, commitSha, upstream);
    return {
      items: [
        {
          commitSha,
          commitTimeMs: Number.isNaN(commitTimeMs) ? null : commitTimeMs,
          remoteRef: upstream,
          contains:
            containsEntry.collected === true ? containsEntry.contains : null,
        },
      ],
      failed: false,
    };
  } catch {
    return { items: [], failed: true };
  }
}

// 진입점이 derivePledges에 넘길 evidence 전체를 모은다(gap#61 실질
// 결선). ★재작업 2R(§11 P1) -- 두 계열 각각의 `failed` 신호를
// `evidence.collectionFailures`에 모아 derivePledges에 넘긴다.
// `derivePledges`는 이 배열이 비어있지 않으면 `ok:false`로 닫고,
// 진입점은 그것을 `UNDECIDABLE`로 표면화한다(아래 `runOrchStallDetect`
// 참조) -- "확인 못 함"이 조용히 "약속 없음"(`PROGRESSING`)으로 새지
// 않는다.
export function collectPledgeDerivationEvidence(repoRoot) {
  const droppedTaskFiles = collectDroppedTaskFileEvidence(repoRoot);
  const localVsRemote = collectLocalVsRemoteEvidence(repoRoot);
  const collectionFailures = [];
  if (droppedTaskFiles.failed) collectionFailures.push("droppedTaskFiles");
  if (localVsRemote.failed) collectionFailures.push("localVsRemote");
  return {
    droppedTaskFiles: droppedTaskFiles.items,
    localVsRemote: localVsRemote.items,
    collectionFailures,
  };
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

// gap#61 병합(coder-task.md §5-B) -- pledgeId가 같으면 유도된 약속이
// 선언된 약속을 이긴다(헤더 주석 "유도 + 선언 병합 규칙" 참조).
// pledgeId가 문자열이 아닌 항목은 dedup 없이 그대로 통과시킨다.
function mergeDeclaredAndDerivedPledges(declared, derived) {
  const byId = new Map();
  const passthrough = [];
  for (const p of declared) {
    if (p && typeof p.pledgeId === "string" && p.pledgeId) {
      byId.set(p.pledgeId, {
        ...p,
        source: p.source ?? PLEDGE_SOURCE.DECLARED,
      });
    } else {
      passthrough.push(p);
    }
  }
  for (const p of derived) {
    if (p && typeof p.pledgeId === "string" && p.pledgeId) {
      byId.set(p.pledgeId, p); // 유도가 항상 이긴다(충돌 시).
    } else {
      passthrough.push(p);
    }
  }
  return [...byId.values(), ...passthrough];
}

// ---- HYK-185 seat-wire: 좌석 무응답 판정 결선 ----
export const SEAT_LIVENESS_WIRE_STATUS = Object.freeze({
  // 이 저장소에 아직 결과 파일이 없는 "활성 배달"이 없다 -- 판정 대상
  // 자체가 없다(정상, 판정 불가 아님).
  NOT_APPLICABLE: "SEAT_LIVENESS_NOT_APPLICABLE",
  // 관측 조회는 성공했지만 이 워크트리에 붙은 좌석이 0개다(정상).
  NO_SEAT: "SEAT_LIVENESS_NO_SEAT",
  // 관측을 모아 judgeSeatLiveness를 실제로 불렀고 verdict가 나왔다.
  JUDGED: "SEAT_LIVENESS_JUDGED",
  // ★관측 수집 자체가 실패했다 -- "무응답"으로 접지 않고 여기서 멈춘다
  // (§2-2 비타협, gap#61 재발 방지와 동일 원칙).
  COLLECTION_FAILED: "SEAT_LIVENESS_COLLECTION_FAILED",
});

// droppedTaskFiles(collectPledgeDerivationEvidence가 이미 모은 배열,
// collectDroppedTaskFileEvidence 참조)에서 "아직 결과 파일이 없는" 항목
// 중 가장 최근에 드롭된 것 하나를 고른다. 여러 role의 task 파일이 동시에
// 있어도(coder-task.md -> review-task.md 순서 등) 이 저장소에는 실제로는
// 하나의 좌석만 붙어 있으므로, 가장 최근 활성 배달 하나만 판정 대상으로
// 삼는다. 없으면 null(NOT_APPLICABLE).
export function selectActiveDispatch(droppedTaskFiles) {
  const active = (Array.isArray(droppedTaskFiles) ? droppedTaskFiles : [])
    .filter(
      (item) =>
        item &&
        typeof item.droppedAtMs === "number" &&
        Number.isFinite(item.droppedAtMs) &&
        item.resultFile &&
        item.resultFile.exists === false,
    )
    .sort((a, b) => b.droppedAtMs - a.droppedAtMs);
  return active.length > 0 ? active[0] : null;
}

// 어댑터의 관측(collectSeatLivenessObservation)을 모아
// seat-liveness-core.mjs의 judgeSeatLiveness를 실제로 부른다(HYK-185
// seat-wire의 실질 결선). opts.execFn을 넘기지 않으면 orca-adapter.mjs의
// createOrcaExecFn()(실 spawn)이 기본값이다 -- 예약 감시가 이 함수를
// 거쳐 부르면 실제로 `orca terminal list`/`terminal show`가 나간다.
export function judgeSeatLivenessForRepo(
  { repoRoot, droppedTaskFiles, now },
  opts = {},
) {
  const active = selectActiveDispatch(droppedTaskFiles);
  if (!active) {
    return { status: SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE };
  }
  const dispatch = {
    dispatchId: active.path,
    dispatchedAtMs: active.droppedAtMs,
  };
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  const observed = collectSeatLivenessObservation(
    { worktreePath: repoRoot, now },
    { execFn },
  );
  if (!observed.ok) {
    return {
      status: SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
      dispatch,
    };
  }
  if (observed.seatCount === 0) {
    return { status: SEAT_LIVENESS_WIRE_STATUS.NO_SEAT, dispatch };
  }
  const judged = judgeSeatLiveness({
    dispatch,
    observation: observed.observation,
    now,
  });
  return {
    status: SEAT_LIVENESS_WIRE_STATUS.JUDGED,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    details: judged.details,
    dispatch,
  };
}

// ---- HYK-185 seat-scan (coder-task.md §1-§2) -- 워크트리 열거 ----
// gap#77의 구조적 한계: 위 judgeSeatLivenessForRepo는 주어진 --repo-root
// 하나의 `.harness`만 본다. 그런데 워커 태스크는 메인이 아니라 「워크트리」에
// 떨어지므로(coder-task.md §1 실측: 메인 `.harness`의 `*-task.md` 0개),
// 이 결선은 구조적으로 계속 NOT_APPLICABLE만 낸다. 이 블록은 그 저장소에
// 등록된 워크트리 전부를 열거해 각각 판정한다.
//
// ★스캔 범위 선언(§2-4 요구, 문서에도 동일하게 적는다):
// - 스캔 대상 = `git worktree list --porcelain`이 돌려주는 것뿐이다
//   -- 이 저장소(git이 아는 저장소 하나)에 **등록된** 워크트리 전부(메인
//   포함).
// - 스캔 대상이 아닌 것 = ①`git worktree add`로 등록된 적이 없는 폴더
//   (예: 단순 clone) ②다른 저장소의 워크트리 ③`git worktree remove`
//   없이 디스크에서만 지워졌지만 좌석(터미널)만 살아있는 경우(git이
//   "prunable"로만 표시하고 여전히 목록에 올릴 수도, 이미 빠졌을 수도
//   있다 -- 이 결선은 git의 판단을 그대로 신뢰하고 별도 검증을 하지
//   않는다) ④이 함수를 호출하는 프로세스가 애초에 다른 `--repo-root`를
//   준 경우 그 값 밖의 모든 저장소.
export const SEAT_LIVENESS_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "SEAT_LIVENESS_SCAN_WORKTREE_LIST_FAILED",
  HARNESS_READ_FAILED: "SEAT_LIVENESS_SCAN_HARNESS_READ_FAILED",
});

function parseWorktreeListPorcelain(stdout) {
  const paths = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^worktree\s+(.+)$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

function defaultGitWorktreeListExec(repoRoot) {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// opts.gitWorktreeListExecFn 주입 가능(시험 전용, 열거 실패를 결정적으로
// 재현) -- 기본은 실 `git worktree list --porcelain`(진입점이 이미 쓰는
// execFileSync("git", ...) 층 재사용, §2-1 근거).
export function collectGitWorktrees(repoRoot, opts = {}) {
  const exec =
    typeof opts.gitWorktreeListExecFn === "function"
      ? opts.gitWorktreeListExecFn
      : defaultGitWorktreeListExec;
  try {
    return { ok: true, worktrees: parseWorktreeListPorcelain(exec(repoRoot)) };
  } catch (err) {
    return {
      ok: false,
      reason: SEAT_LIVENESS_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

// "가장 나쁜 상태"를 고르는 순위(§2-2) -- 숫자가 클수록 나쁘다. 수집
// 실패(②③)는 "무응답"보다는 낮지만 정상(①④)보다는 항상 높다 -- 판정
// 불가를 조용함으로 접지 않는다(§2-3 비타협)는 원칙을 순위에도 그대로
// 반영한다.
export const SEAT_LIVENESS_SCAN_SEVERITY = Object.freeze({
  NORMAL: 0, // ① NOT_APPLICABLE/NO_SEAT ④ JUDGED+RESPONSIVE
  UNDECIDABLE: 1, // JUDGED이지만 verdict가 UNDECIDABLE(관측 형식 문제 등)
  COLLECTION_FAILURE: 2, // ② 워크트리 열거 실패 ③ .harness 읽기 실패 · 좌석 조회 실패
  SUSPECTED_UNRESPONSIVE: 3, // 가장 나쁨 -- 무응답 의심
});

function severityOf(entry) {
  if (
    entry.status === SEAT_LIVENESS_SCAN_FAILURE.WORKTREE_LIST_FAILED ||
    entry.status === SEAT_LIVENESS_SCAN_FAILURE.HARNESS_READ_FAILED ||
    entry.status === SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED
  ) {
    return SEAT_LIVENESS_SCAN_SEVERITY.COLLECTION_FAILURE;
  }
  if (entry.status === SEAT_LIVENESS_WIRE_STATUS.JUDGED) {
    if (entry.verdict === SEAT_LIVENESS_VERDICT.SUSPECTED_UNRESPONSIVE) {
      return SEAT_LIVENESS_SCAN_SEVERITY.SUSPECTED_UNRESPONSIVE;
    }
    if (entry.verdict === SEAT_LIVENESS_VERDICT.UNDECIDABLE) {
      return SEAT_LIVENESS_SCAN_SEVERITY.UNDECIDABLE;
    }
  }
  return SEAT_LIVENESS_SCAN_SEVERITY.NORMAL;
}

// 워크트리 하나를 판정한다 -- ★수집 실패(.harness 읽기 실패)를 "조용함"
// (NOT_APPLICABLE)으로 접지 않고 별도 상태로 표면화한다(§2-3 확장).
function judgeSeatLivenessForWorktree(worktreePath, now, opts) {
  const evidence = collectDroppedTaskFileEvidence(worktreePath, {
    readdirFn: opts.harnessReaddirFn,
  });
  if (evidence.failed) {
    return {
      worktreePath,
      status: SEAT_LIVENESS_SCAN_FAILURE.HARNESS_READ_FAILED,
    };
  }
  const judged = judgeSeatLivenessForRepo(
    { repoRoot: worktreePath, droppedTaskFiles: evidence.items, now },
    opts,
  );
  return { worktreePath, ...judged };
}

// judgeSeatLivenessAcrossWorktrees({repoRoot, now}, opts) -- HYK-185
// seat-scan 결선 그 자체(§1-§2). `repoRoot`가 속한 저장소에 등록된
// 워크트리 전부를 열거하고(collectGitWorktrees) 각각 개별 판정한 뒤
// (judgeSeatLivenessForWorktree), 가장 나쁜 항목을 대표값으로 상위에
// 싣고(seat_status/seat_verdict 하위호환) 전체 목록·건수도 함께 낸다
// (§2-2 "여러 건을 각각 판정하고 전부 표면화"). 여러 워크트리가 동시에
// 같은 최악 등급이어도(예: 두 좌석이 동시에 무응답 의심) worstCount로
// 건수를 알 수 있다 -- 대표 status/verdict 하나만으로는 이 정보가
// 사라지므로 로그 줄(watch-run.mjs)이 worstCount도 함께 싣는다.
export function judgeSeatLivenessAcrossWorktrees({ repoRoot, now }, opts = {}) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: list.reason,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeSeatLivenessForWorktree(wt, now, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, severityOf(w)),
    SEAT_LIVENESS_SCAN_SEVERITY.NORMAL,
  );
  const worstEntries = worktrees.filter((w) => severityOf(w) === worstSeverity);
  const worst = worstEntries[0] ?? null;
  return {
    status: worst ? worst.status : SEAT_LIVENESS_WIRE_STATUS.NOT_APPLICABLE,
    verdict: worst ? worst.verdict : undefined,
    reasonCode: worst ? worst.reasonCode : undefined,
    details: worst ? worst.details : undefined,
    worktreePath: worst ? worst.worktreePath : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// runOrchStallDetect(argv) -> {result, exitCode} -- CLI 몸통을 순수 함수에
// 가깝게 뽑아 시험이 process.exit 없이 호출할 수 있게 한다. I/O(파일
// 읽기·git 실행)는 그대로 하되, 프로세스 종료·stdout 출력은 하지 않는다.
//
// gap#61(coder-task.md §5-B): `--pledges` 생략 시 선언된 약속은 빈
// 배열(정당한 상태, 오류 아님) -- 유도된 약속만으로도 판정이 나온다.
// `--pledges`를 줬는데 못 읽으면 여전히 오류(구별, 헤더 주석 참조).
export function runOrchStallDetect(argv, opts = {}) {
  const cli = parseArgs(argv);
  let declaredPledges = [];
  if (cli.pledgesPath) {
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
    declaredPledges = loaded.pledges;
  }
  const repoRoot = cli.repoRoot ?? resolveRepoRoot();
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
  const evidence = collectPledgeDerivationEvidence(repoRoot);
  const derivation = derivePledges({ evidence, now });
  // ★재작업 2R(coder-task.md §11 P1) -- 수집 실패(derivation.ok===false)는
  // 여기서 즉시 UNDECIDABLE로 표면화한다. 병합·관측·judgeOrchProgress로
  // 넘어가면 실패가 "약속 0개"로 흡수돼 PROGRESSING으로 새기 때문에,
  // 그 파이프라인에 들어가기 전에 끊는다.
  if (!derivation.ok) {
    return {
      result: {
        ok: false,
        verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
        reasonCode: derivation.reasonCode,
        details: null,
        pledgeSources: {},
        derivationNotes: derivation.notes,
      },
      exitCode: EXIT_CODE_BY_VERDICT[ORCH_PROGRESS_VERDICT.UNDECIDABLE],
      cli,
    };
  }
  const pledges = mergeDeclaredAndDerivedPledges(
    declaredPledges,
    derivation.pledges,
  );
  const observation = collectObservation(repoRoot, pledges);
  const result = judgeOrchProgress({
    pledges,
    observation,
    now,
    thresholdSeconds: cli.thresholdSeconds,
  });
  // HYK-185 seat-scan: 좌석 무응답 판정을 이 저장소의 워크트리 전부에
  // 걸쳐 부른다(§1-§2 결선 그 자체 -- gap#77까지는 --repo-root 하나의
  // `.harness`만 봤다). v1은 로그만(§2-3) -- 이 결과는 exitCode에
  // 관여하지 않는다(위 헤더 주석 참조).
  const seatLiveness = judgeSeatLivenessAcrossWorktrees(
    { repoRoot, now },
    opts,
  );
  return {
    result: {
      ...result,
      pledgeSources: Object.fromEntries(
        pledges
          .filter((p) => p && typeof p.pledgeId === "string")
          .map((p) => [p.pledgeId, p.source ?? PLEDGE_SOURCE.DECLARED]),
      ),
      derivationNotes: derivation.notes,
      seatLiveness,
    },
    exitCode: EXIT_CODE_BY_VERDICT[result.verdict] ?? 3,
    cli,
  };
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
