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
// (`--repo-root`) 자신의 워크트리에 붙은 좌석 -- 이번 배달이 아직 끝나지
// 않은("활성 배달", HYK-201부터 결과 파일 존재가 아니라 그 배달의 실제
// 완료 여부를 본다)이 있을 때만 판정한다(§2-2 아래 `selectActiveDispatch`).
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
import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
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
import { judgeSeatIdle, SEAT_IDLE_VERDICT } from "./seat-idle-core.mjs";
import {
  judgeDispatchStart,
  DISPATCH_START_VERDICT,
} from "./dispatch-start-core.mjs";
import {
  judgeUnconsumed,
  UNCONSUMED_VERDICT,
  UNCONSUMED_SIGNAL_KIND,
} from "./unconsumed-core.mjs";
import { judgeHeaderTimeProjection } from "./header-time-projection-core.mjs";
import {
  collectSeatLivenessObservation,
  collectSeatObservationsForWorktree,
  createOrcaExecFn,
  CONTROL_ROOM_PATH,
  MAIN_REPO_PATH,
  SEAT_LIVENESS_OBSERVATION_REASON,
  resolveDeliveredSeat,
  fetchSeatLivenessShow,
  buildTerminalListCommand,
  parseTerminalList,
  buildNonBlockingCheckCommand,
  isOrphanSeat,
} from "../relay/adapters/orca-adapter.mjs";
import { normalizeAbsolute } from "../check/path-normalize.mjs";
// HYK-173-push-wire (coder-task.md §5-C) -- 판단층(escalation-state.mjs)을
// 이 축이 "실제로" 부른다. ⛔이 import는 판정 로직을 재구현하지 않는다는
// 증거 그 자체다 -- reduceCoordinatorState/shouldWakeHuman은 여기서
// 실호출되고, shouldNotify(dedupe)는 이 파일이 아니라 watch-run.mjs가
// 부른다(이 파일은 §2-3 비타협에 따라 "부작용 0(읽기 전용)"을 유지해야
// 하는데, dedupe는 상태 파일 쓰기가 필요한 부작용이라 이 파일에 두면 그
// 계약이 깨진다 -- watch-run.mjs는 이미 I/O 러너로 선언돼 있어 그 쪽이
// 자연스러운 자리다).
import {
  reduceCoordinatorState,
  shouldWakeHuman,
  COORD_STATE,
} from "../relay/escalation-state.mjs";

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
// HYK-185-startcheck-wire 2R(coder-task.md §R2, REVIEW P1 반려 수리) --
// 완료의 정본은 결과 파일의 **존재**가 아니라 그 안의 칼럼-0 `>>> DONE:`
// 줄이다(relay-handshake.mjs의 DONE_RE와 동일 관례를 이 파일 규모에 맞게
// 재사용 -- scripts/check/**는 무접촉 범위라 그 파일을 import하지 않고
// 같은 칼럼-0 패턴만 이 파일 안에서 독립적으로 재현한다). REVIEW가 실물
// 릴레이로 잡은 것: REVIEW 좌석은 시작 직후 결과 파일에 표지 3줄
// (dispatch_verified 등)을 먼저 쓰고 본문·DONE 줄은 나중에 쓴다 -- 그
// 순간의 "결과 파일 존재"만 보면 아직 진행 중인 배달을 이미 끝난 것으로
// 오판해 dispatch-start 축이 구조적으로 항상 NOT_APPLICABLE이 된다.
const RESULT_DONE_RE = /^>>>\s*DONE:/im;

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

// HYK-185-startcheck-wire 2R(coder-task.md §R2) -- 결과 파일이 "이번
// 배달"을 실제로 끝냈는지 읽는다. ★칼럼-0 `>>> DONE:` 줄 존재만으로는
// 부족하다 -- 이 워크트리 자신에서 실측한 조건: CODER가 재작업 라운드
// 도중이면 결과 파일에는 **이전 라운드의 DONE 줄이 이미 남아 있다**
// (같은 파일을 이어 쓰는 관례, coder-task.md §5). 그 낡은 DONE 줄만
// 보고 "끝났다"고 판정하면 지금 라운드가 진행 중인데도 다시
// NOT_APPLICABLE로 새어버린다(§R2가 닫으려는 바로 그 결함의 변종).
// 그래서 결과 파일 자신의 `task_id:` 표지가 **이번 배달의 taskId와
// 같을 때만** DONE 줄을 이번 배달의 완료로 인정한다.
// 파일이 없으면(아직 결과 자체가 없음) `null`(해당 없음 -- resultFile.
// exists === false 조건이 이미 이 경우를 잡는다). 읽기 자체가 실패하면
// (권한 등) **완료로 단정하지 않는다**(fail-closed -- §2-5 비타협과
// 동일 원칙) -- `false`로 안전하게 처리한다(놓치는 것보다 과대검출이 낫다).
function collectResultFileCompletion(repoRoot, resultRelPath, taskId) {
  try {
    const full = resolveRepoPath(repoRoot, resultRelPath);
    if (!existsSync(full)) return null;
    const text = readFileSync(full, "utf8");
    const resultTaskIdMatch = text.match(TASK_ID_RE);
    const resultTaskId = resultTaskIdMatch ? resultTaskIdMatch[1] : null;
    const sameTaskId =
      typeof taskId === "string" &&
      taskId.length > 0 &&
      resultTaskId === taskId;
    return sameTaskId && RESULT_DONE_RE.test(text);
  } catch {
    return false;
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
// 드롭된 태스크 파일 하나로부터 evidence item을 만든다(collectDroppedTaskFileEvidence
// 에서 분리 -- max-lines-per-function/complexity 상한 준수, HYK-185-startcheck-wire
// 2R이 resultFileDone 필드를 추가하며 분기 수가 늘어난 것뿐 로직은 그대로다).
// dropped_at 헤더가 없으면(드롭됨 흔적 자체가 없음) `null`을 돌려 호출부가
// 건너뛰게 한다.
// HYK-185-unconsumed-2 §R2 P1-1 -- `droppedAtMs`(위)는 여전히 헤더에서만
// 온다(다른 세 축이 이미 이 필드를 "배달 시각"으로 신뢰해 시험까지
// 고정돼 있으므로, 그 의미를 이 라운드에서 바꾸면 회귀가 난다). 이
// 함수는 그 옆에 **`taskFileMtimeMs`**(그 task 파일 자신의 실제 fs
// mtime)도 함께 모은다.
// ★HYK-185-unconsumed-3 §R3-1 갱신: 소비("unconsumed") 판정은 이제 이
// 함수가 만드는 `droppedAtMs`를 **전혀 보지 않는다** -- 소비 판정은
// 별도의 `collectUnconsumedCandidates`(아래, 헤더 유무와 무관하게 모든
// `*-task.md`를 본다)가 전담한다. 이 함수(및 `droppedAtMs`)는 이제
// ①seat-liveness/seat-idle/dispatch-start 세 축의 "배달 시각" ②
// header-time-projection-core.mjs를 쓰는 `scanHeaderTimeProjection`(아래,
// 헤더-실물 어긋남 탐지 -- 소비와 무관한 별개 신호)만을 위해 남아 있다.
function buildDroppedTaskFileItem(repoRoot, harnessDir, name, text) {
  const droppedMatch = text.match(DROPPED_AT_RE);
  if (!droppedMatch) return null;
  const relPath = `.harness/${name}`;
  const iso = `${droppedMatch[1]}-${droppedMatch[2]}-${droppedMatch[3]}T${droppedMatch[4]}:${droppedMatch[5]}:00+09:00`;
  const droppedAtMs = Date.parse(iso);
  const taskIdMatch = text.match(TASK_ID_RE);
  const resultName = name.replace(/-task\.md$/, ".md");
  const resultPath = `.harness/${resultName}`;
  const resultFile = collectFileMtime(repoRoot, resultPath);
  const selfFile = collectFileMtime(repoRoot, relPath);
  const taskId = taskIdMatch ? taskIdMatch[1] : null;
  const resultFileExists =
    resultFile.collected === true ? resultFile.exists : false;
  return {
    path: relPath,
    taskId,
    droppedAtMs: Number.isNaN(droppedAtMs) ? null : droppedAtMs,
    // 이 task 파일 "자신"의 실제 fs mtime(헤더가 아니라 실물) --
    // `scanHeaderTimeProjection`(아래)이 이 값을 헤더값과 대조한다. 읽기
    // 자체가 실패했거나 파일이 이미 없어졌으면 null(대조 불가 ->
    // judgeHeaderTimeProjection이 UNDECIDABLE로 닫는다).
    taskFileMtimeMs:
      selfFile.collected === true && selfFile.exists === true
        ? selfFile.mtimeMs
        : null,
    resultFile:
      resultFile.collected === true
        ? {
            path: resultPath,
            exists: resultFile.exists,
            mtimeMs: resultFile.mtimeMs,
          }
        : { path: resultPath, exists: false, mtimeMs: null },
    // HYK-185-startcheck-wire 2R: 결과 파일이 없으면 "완료 여부" 자체가
    // 해당 없음(null) -- 있을 때만 실제로 그 안에 DONE 줄이 있는지 읽는다.
    // HYK-201부터 seat-liveness/seat-idle 두 축도 이 필드를 읽는다
    // (selectActiveDispatch/isDispatchStillActive 참조, 아래 함수 헤더
    // 주석) -- 세 축이 같은 "활성 배달" 정의를 공유한다.
    resultFileDone: resultFileExists
      ? collectResultFileCompletion(repoRoot, resultPath, taskId)
      : null,
    taskIdMismatch: computeTaskIdMismatch(repoRoot, relPath, taskId),
  };
}

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
  // ★HYK-185-unconsumed-2 §R2 P1-2(REVIEW 반려 수리) -- 개별 파일
  // readFileSync 실패(예: 이름은 `*-task.md`인데 실제로는 디렉터리라
  // EISDIR)를 예전에는 `continue`로 조용히 건너뛰었다. 그러면 근거가
  // "빈 목록 + failed:false"가 되어 호출부(judge*ForWorktree 전부)가
  // "정상, 판정 대상 없음"으로 오판한다(§2-3 "판정 불가를 정상으로 접지
  // 마라"와 정면 충돌). 디렉터리 열거 실패(위 catch)와 동일하게
  // `failed:true`로 즉시 표면화한다 -- 이 함수를 부르는 네 축
  // (seat-liveness/seat-idle/dispatch-start/unconsumed) 전부가 이미
  // `evidence.failed`를 `*_HARNESS_READ_FAILED`로 옮겨 적으므로, 이
  // 한 지점을 고치면 네 축 모두에서 일관되게 수리된다.
  const items = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(path.join(harnessDir, name), "utf8");
    } catch {
      return { items: [], failed: true };
    }
    const item = buildDroppedTaskFileItem(repoRoot, harnessDir, name, text);
    if (item) items.push(item);
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

// HYK-201(coder-task.md §1-§2) -- "활성 배달"의 정본 판정. 예전에는
// seat-liveness/seat-idle 두 축(`selectActiveDispatch`)과 dispatch-start
// 축(`selectActiveDispatchForStart`)이 서로 다른 조건을 썼다: 전자는
// `resultFile.exists === false`(결과 파일이 아직 없음)만 보고, 후자는
// PR #113(HYK-185-startcheck-wire 2R)에서 이미 고친 실물 기준
// (`resultFileDone`, collectResultFileCompletion 참조)을 썼다. 그 결함의
// 자백은 이 파일에 이미 남아 있었다: REVIEW 좌석은 시작 직후 결과 파일에
// 표지 3줄부터 먼저 쓰고 본문·`>>> DONE:` 줄은 나중에 쓴다 --
// `resultFile.exists === true`만으로 "끝났다"고 보면 그 표지-먼저-쓰기
// 구간에서 활성 배달을 놓친다. 게다가 결과 파일은 **이전 라운드**의
// DONE 줄을 그대로 지닌 채 다음 라운드가 이어 쓰는 관례라(coder-task.md
// §5), DONE 줄 존재만 봐도 부족하다 -- `resultFileDone`은 그 결과 파일
// 자신의 `task_id:` 표지가 **이번 배달의 taskId와 일치할 때만** true다.
// HYK-201: 이 하나의 함수(공유 판정, ⓐ)로 두 계열의 호출자를 모두
// 수렴시킨다 -- seatLiveness/seatIdle/dispatch-start 세 축이 전용 선택자를
// 하나씩 두면(ⓑ) 같은 결함이 세 벌로 늘어날 위험이 있고, 세 축은 애초에
// "이 배달이 아직 끝나지 않았는가"라는 같은 질문을 던진다(§2 근거 상세는
// coder.md 참조).
function isDispatchStillActive(item) {
  if (
    !item ||
    typeof item.droppedAtMs !== "number" ||
    !Number.isFinite(item.droppedAtMs) ||
    !item.resultFile
  ) {
    return false;
  }
  if (item.resultFile.exists === false) return true;
  // 결과 파일은 있다 -- "이번 배달"의 DONE 줄이 있어야만 진짜로 끝난
  // 것이다(resultFileDone은 task_id 일치까지 확인된 값, 위 주석 참조).
  return item.resultFileDone !== true;
}

// droppedTaskFiles(collectPledgeDerivationEvidence가 이미 모은 배열,
// collectDroppedTaskFileEvidence 참조)에서 "아직 끝나지 않은"(위
// isDispatchStillActive) 항목 중 가장 최근에 드롭된 것 하나를 고른다.
// 여러 role의 task 파일이 동시에 있어도(coder-task.md -> review-task.md
// 순서 등) 이 저장소에는 실제로는 하나의 좌석만 붙어 있으므로, 가장
// 최근 활성 배달 하나만 판정 대상으로 삼는다. 없으면 null(NOT_APPLICABLE).
// seat-liveness(judgeSeatLivenessForRepo)/seat-idle(judgeSeatIdleForRepo)
// 두 축이 공유한다 -- "두 축이 같은 좌석을 두 번 세지 않는다"는 설계
// (:925 주석)가 이 하나의 정의를 공유해야 성립한다.
export function selectActiveDispatch(droppedTaskFiles) {
  const active = (Array.isArray(droppedTaskFiles) ? droppedTaskFiles : [])
    .filter(isDispatchStillActive)
    .sort((a, b) => b.droppedAtMs - a.droppedAtMs);
  return active.length > 0 ? active[0] : null;
}

// dispatch-start 축(judgeDispatchStartForRepo)이 쓰는 이름 -- HYK-201부터
// `selectActiveDispatch`(위)와 판정 로직이 완전히 같다(isDispatchStillActive
// 공유). 이름을 분리해 둔 이유는 호출부 각각이 "이 축은 dispatch-start
// 전용 선택자를 쓴다"는 의도를 코드로 드러내기 위함일 뿐, 판정 자체는
// 하나다(회귀 0 -- 세 축 모두 이번 배달의 실제 완료 여부를 본다).
export function selectActiveDispatchForStart(droppedTaskFiles) {
  return selectActiveDispatch(droppedTaskFiles);
}

// HYK-185-seat-corr(coder-task.md §2): seatLiveness/dispatchStart 두 축이
// 공유하던 좁은 관측(collectSeatLivenessObservation -- 좌석 2개+면
// AMBIGUOUS)이 그 이유로만 실패했을 때 한해, "그 배달이 간 좌석"을
// 실측 읽기전용 조회 3단(resolveDeliveredSeat, orca-adapter.mjs)으로
// 재시도한다. AMBIGUOUS가 아닌 다른 실패(LIST_QUERY_FAILED/
// SHOW_QUERY_FAILED/MALFORMED/INPUT_INVALID)나 harnessLabel 자체가 없으면
// 재시도하지 않는다 -- "좌석이 여럿이라 못 골랐다"는 문제가 아닌 실패까지
// 이 경로로 새로 흡수하면 그 실패들의 기존 동작(회귀 0 요구)이 바뀐다.
// 재시도도 대조가 성립하지 않으면(후보 0/2개+ · 죽은 좌석만 일치) 여전히
// COLLECTION_FAILED로 실패를 드러낸다(비타협: 못 고르면 못 고른다고
// 말한다) -- 이 함수는 재시도를 "시도했다는 사실"만 `correlation`
// 필드(부가 정보, 기존 필드 이름/모양은 그대로)에 얹는다.
function resolveObservationWithDeliveredSeatFallback(
  { worktreePath, harnessLabel, now, execFn },
  primaryObserved,
) {
  const canRetry =
    !primaryObserved.ok &&
    primaryObserved.observationReason ===
      SEAT_LIVENESS_OBSERVATION_REASON.AMBIGUOUS &&
    typeof harnessLabel === "string" &&
    harnessLabel.length > 0;
  if (!canRetry) {
    return { observed: primaryObserved, correlation: null };
  }
  const resolved = resolveDeliveredSeat(
    { harnessLabel, worktreePath },
    { execFn },
  );
  if (!resolved.ok) {
    return {
      observed: primaryObserved,
      correlation: {
        attempted: true,
        ok: false,
        reasonCode: resolved.reasonCode,
        reason: resolved.reason,
      },
    };
  }
  const show = fetchSeatLivenessShow(resolved.handle, now, { execFn });
  return {
    observed: show,
    correlation: {
      attempted: true,
      ok: true,
      handle: resolved.handle,
      runtimeTaskId: resolved.runtimeTaskId,
      // HYK-207-multiseat 2R: resolveDeliveredSeat가 성공(ok:true)해도
      // 다른(무관한) live 좌석 후보 하나 이상의 terminal-show 조회가
      // 실패했을 수 있다 -- 그 사실을 여기서도 조용히 버리지 않고 그대로
      // 얹는다(orca-adapter.mjs의 partialFailures, 단일 출처 그대로 전달).
      partialFailures: resolved.partialFailures,
    },
  };
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
  const primaryObserved = collectSeatLivenessObservation(
    { worktreePath: repoRoot, now },
    { execFn },
  );
  const { observed, correlation } = resolveObservationWithDeliveredSeatFallback(
    { worktreePath: repoRoot, harnessLabel: active.taskId, now, execFn },
    primaryObserved,
  );
  if (!observed.ok) {
    return {
      status: SEAT_LIVENESS_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
      dispatch,
      ...(correlation ? { correlation } : {}),
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
    ...(correlation ? { correlation } : {}),
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
    // HYK-265-observe-split-1 (coder-task.md §3-1 항2): judgeSeatLivenessForRepo
    // 가 COLLECTION_FAILED일 때 이미 만드는 observationReason/reason을
    // 여기서도 잃지 않고 위로 올린다 -- watch-run.mjs가 이 필드를 로그
    // 줄까지 옮겨야 사람이 "왜" 수집이 실패했는지 볼 수 있다(§2 실측).
    observationReason: worst ? worst.observationReason : undefined,
    reason: worst ? worst.reason : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// ---- HYK-185-seat-idle-1 (coder-task.md §2) -- «배달이 없는데 오래
// 남아 있는 좌석»(유휴 방치) 판정 결선 ----
//
// seat-liveness 축(위)은 «활성 배달이 있는» 좌석의 무응답을 본다. 이
// 축은 정반대 -- «활성 배달이 없는» 좌석이 오래 방치됐는지를 본다(§2-3
// (b) "두 축이 같은 좌석을 두 번 세지 않음"). selectActiveDispatch가
// non-null(활성 배달 있음)이면 이 축은 NOT_APPLICABLE이다 -- 그건
// seat-liveness 축의 몫이다.
//
// ★관측 수집은 seat-liveness 축과 동일한 어댑터 함수
// (`collectSeatLivenessObservation`)를 그대로 재사용한다(§2-1-2 비타협
// "새 orca 호출을 추가하지 마라") -- 이 함수는 활성 배달 여부와 무관하게
// "이 워크트리에 붙은 좌석의 lastOutputAt"만 묻는다. 두 축이 동시에
// execFn을 부르는 일은 없다: 활성 배달이 있으면 seat-liveness 축만
// 호출하고(이 축은 NOT_APPLICABLE로 즉시 반환, execFn 호출 0), 활성
// 배달이 없으면 이 축만 호출한다(seat-liveness 축이 이미 NOT_APPLICABLE
// 로 execFn 호출 0인 것과 대칭).
export const SEAT_IDLE_WIRE_STATUS = Object.freeze({
  // 활성 배달이 있다 -- 이 좌석은 seat-liveness 축의 대상이지 이 축의
  // 대상이 아니다(정상, 판정 불가 아님).
  NOT_APPLICABLE: "SEAT_IDLE_NOT_APPLICABLE",
  // 관측 조회는 성공했지만 이 워크트리에 붙은 좌석이 0개다(정상).
  NO_SEAT: "SEAT_IDLE_NO_SEAT",
  // 관측을 모아 judgeSeatIdle을 실제로 불렀고 verdict가 나왔다.
  JUDGED: "SEAT_IDLE_JUDGED",
  // ★관측 수집 자체가 실패했다 -- "정상 방치 없음"으로 접지 않고 여기서
  // 멈춘다(§2-3 (a) 비타협, seat-liveness 축의 COLLECTION_FAILED와 동일
  // 원칙).
  COLLECTION_FAILED: "SEAT_IDLE_COLLECTION_FAILED",
});

// HYK-185-seat-multi (coder-task.md §2 «안 1» step2, 방치 축): 워크트리에
// 좌석이 둘 이상이면 «고르지 않고» 좌석마다 독립적으로 판정한 뒤 가장
// 나쁜 것을 대표로 삼는다 -- judgeSeatIdleAcrossWorktrees(아래)가 이미
// 쓰는 "worst wins" 원칙을 워크트리 내부 좌석 수준에도 그대로 적용한다.
// 좌석 하나의 관측(`terminal show`) 실패는 그 좌석 하나만
// SEAT_COLLECTION_FAILED로 접고 나머지 좌석의 판정을 막지 않는다 --
// 예전(resolveSeatLivenessCandidate 공유)처럼 좌석 하나의 사정이 축
// 전체를 눈멀게 하지 않는다(gap#83/coder-task.md §1이 고치려는 결함).
const SEAT_IDLE_PER_SEAT_SEVERITY = Object.freeze({
  IDLE_OK: 0,
  UNDECIDABLE: 1,
  SEAT_COLLECTION_FAILED: 2,
  SUSPECTED_ABANDONED: 3,
});

function severityOfSeatIdleEntry(entry) {
  if (!entry.ok) return SEAT_IDLE_PER_SEAT_SEVERITY.SEAT_COLLECTION_FAILED;
  if (entry.verdict === SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED) {
    return SEAT_IDLE_PER_SEAT_SEVERITY.SUSPECTED_ABANDONED;
  }
  if (entry.verdict === SEAT_IDLE_VERDICT.UNDECIDABLE) {
    return SEAT_IDLE_PER_SEAT_SEVERITY.UNDECIDABLE;
  }
  return SEAT_IDLE_PER_SEAT_SEVERITY.IDLE_OK;
}

// seats: collectSeatObservationsForWorktree(orca-adapter.mjs)가 돌려주는
// [{handle, ok, observation?, observationReason?, reason?}] 배열(seatCount
// >= 1일 때만 호출된다). 각 좌석을 독립적으로 judgeSeatIdle에 넣고, 가장
// 나쁜 항목의 상태를 이 워크트리의 대표 판정으로 삼는다 -- `seats`
// (개별 좌석 판정 전부)도 함께 실어 대표값 하나만으로는 사라지는 정보를
// 보존한다(judgeSeatIdleAcrossWorktrees의 worktrees 배열과 동일 원칙).
function judgeSeatIdleAcrossSeats(seats, now) {
  const perSeat = seats.map((s) => {
    if (!s.ok) {
      return {
        handle: s.handle,
        ok: false,
        observationReason: s.observationReason,
        reason: s.reason,
      };
    }
    const judged = judgeSeatIdle({ observation: s.observation, now });
    return {
      handle: s.handle,
      ok: true,
      verdict: judged.verdict,
      reasonCode: judged.reasonCode,
      details: judged.details,
    };
  });
  const worstSeverity = perSeat.reduce(
    (acc, e) => Math.max(acc, severityOfSeatIdleEntry(e)),
    SEAT_IDLE_PER_SEAT_SEVERITY.IDLE_OK,
  );
  const worst = perSeat.find(
    (e) => severityOfSeatIdleEntry(e) === worstSeverity,
  );
  if (!worst.ok) {
    return {
      status: SEAT_IDLE_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: worst.observationReason,
      reason: worst.reason,
      seats: perSeat,
    };
  }
  return {
    status: SEAT_IDLE_WIRE_STATUS.JUDGED,
    verdict: worst.verdict,
    reasonCode: worst.reasonCode,
    details: worst.details,
    seats: perSeat,
  };
}

// judgeSeatIdleForRepo({repoRoot, droppedTaskFiles, now}, opts) -- 단일
// 저장소(워크트리) 하나에 대해 이 축을 판정한다. seat-liveness 축의
// judgeSeatLivenessForRepo와 대칭 구조이나 활성 배달 유무 분기가
// 반대다.
export function judgeSeatIdleForRepo(
  { repoRoot, droppedTaskFiles, now },
  opts = {},
) {
  const active = selectActiveDispatch(droppedTaskFiles);
  if (active) {
    return { status: SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE };
  }
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  const observed = collectSeatObservationsForWorktree(
    { worktreePath: repoRoot, now },
    { execFn },
  );
  if (!observed.ok) {
    return {
      status: SEAT_IDLE_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
    };
  }
  if (observed.seatCount === 0) {
    return { status: SEAT_IDLE_WIRE_STATUS.NO_SEAT };
  }
  return judgeSeatIdleAcrossSeats(observed.seats, now);
}

// HYK-185-seat-idle-1 §2-1-2 "gap#78 이 만든 워크트리 열거 결과를
// 재사용하라" -- 새 워크트리 열거 로직을 만들지 않고, gap#78이 이미
// export한 `collectGitWorktrees`/`collectDroppedTaskFileEvidence`를 그대로
// 다시 호출한다(둘 다 이미 존재하던 함수, 재구현 0). seat-liveness 축의
// 스캔 루프(judgeSeatLivenessAcrossWorktrees)는 이 조각이 손대지 않는다
// (§2-3 (e) 회귀 0 -- 기존 축은 이 함수가 존재하기 전과 동일한 코드
// 경로로 그대로 실행된다).
export const SEAT_IDLE_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "SEAT_IDLE_SCAN_WORKTREE_LIST_FAILED",
  HARNESS_READ_FAILED: "SEAT_IDLE_SCAN_HARNESS_READ_FAILED",
});

export const SEAT_IDLE_SCAN_SEVERITY = Object.freeze({
  NORMAL: 0, // NOT_APPLICABLE/NO_SEAT/JUDGED+IDLE_OK.
  UNDECIDABLE: 1, // JUDGED이지만 verdict가 UNDECIDABLE.
  COLLECTION_FAILURE: 2, // 워크트리 열거 실패 · .harness 읽기 실패 · 좌석 조회 실패.
  SUSPECTED_ABANDONED: 3, // 가장 나쁨.
});

function idleSeverityOf(entry) {
  if (
    entry.status === SEAT_IDLE_SCAN_FAILURE.WORKTREE_LIST_FAILED ||
    entry.status === SEAT_IDLE_SCAN_FAILURE.HARNESS_READ_FAILED ||
    entry.status === SEAT_IDLE_WIRE_STATUS.COLLECTION_FAILED
  ) {
    return SEAT_IDLE_SCAN_SEVERITY.COLLECTION_FAILURE;
  }
  if (entry.status === SEAT_IDLE_WIRE_STATUS.JUDGED) {
    if (entry.verdict === SEAT_IDLE_VERDICT.SUSPECTED_ABANDONED) {
      return SEAT_IDLE_SCAN_SEVERITY.SUSPECTED_ABANDONED;
    }
    if (entry.verdict === SEAT_IDLE_VERDICT.UNDECIDABLE) {
      return SEAT_IDLE_SCAN_SEVERITY.UNDECIDABLE;
    }
  }
  return SEAT_IDLE_SCAN_SEVERITY.NORMAL;
}

function judgeSeatIdleForWorktree(worktreePath, now, opts) {
  const evidence = collectDroppedTaskFileEvidence(worktreePath, {
    readdirFn: opts.harnessReaddirFn,
  });
  if (evidence.failed) {
    return {
      worktreePath,
      status: SEAT_IDLE_SCAN_FAILURE.HARNESS_READ_FAILED,
    };
  }
  const judged = judgeSeatIdleForRepo(
    { repoRoot: worktreePath, droppedTaskFiles: evidence.items, now },
    opts,
  );
  return { worktreePath, ...judged };
}

// judgeSeatIdleAcrossWorktrees({repoRoot, now}, opts) -- seat-liveness
// 축의 judgeSeatLivenessAcrossWorktrees와 대칭(워크트리 전부 열거 후
// 각각 개별 판정, 가장 나쁜 항목을 대표값으로 상위에 싣고 전체 목록·
// 건수도 함께 낸다).
export function judgeSeatIdleAcrossWorktrees({ repoRoot, now }, opts = {}) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: SEAT_IDLE_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeSeatIdleForWorktree(wt, now, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, idleSeverityOf(w)),
    SEAT_IDLE_SCAN_SEVERITY.NORMAL,
  );
  const worstEntries = worktrees.filter(
    (w) => idleSeverityOf(w) === worstSeverity,
  );
  const worst = worstEntries[0] ?? null;
  return {
    status: worst ? worst.status : SEAT_IDLE_WIRE_STATUS.NOT_APPLICABLE,
    verdict: worst ? worst.verdict : undefined,
    reasonCode: worst ? worst.reasonCode : undefined,
    details: worst ? worst.details : undefined,
    worktreePath: worst ? worst.worktreePath : undefined,
    // HYK-265-observe-split-1 (coder-task.md §3-1 항2): seat 축과 동일 이유
    // -- judgeSeatIdleForRepo/judgeSeatIdleAcrossSeats의 COLLECTION_FAILED
    // observationReason/reason을 잃지 않고 위로 올린다.
    observationReason: worst ? worst.observationReason : undefined,
    reason: worst ? worst.reason : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// HYK-185-seat-idle-1: 두 좌석 축(무응답/유휴 방치)을 함께 계산한다 --
// runOrchStallDetect에서 분리(max-lines-per-function, 복잡도 분산). 둘 다
// v1은 로그만(§2-3 (c)) -- exitCode에 관여하지 않는다.
// HYK-185-startcheck-wire: dispatchStart 축(«배달 후 시작됐는가»)도 같은
// 함수에서 함께 계산한다(runOrchStallDetect의 max-lines-per-function 상한
// 준수를 위해 여기로 옮긴 것뿐 -- 세 축 모두 v1은 로그만, exitCode에는
// 관여하지 않는다).
function computeSeatAxes(repoRoot, now, opts) {
  const seatLiveness = judgeSeatLivenessAcrossWorktrees(
    { repoRoot, now },
    opts,
  );
  const seatIdle = judgeSeatIdleAcrossWorktrees({ repoRoot, now }, opts);
  const dispatchStart = judgeDispatchStartAcrossWorktrees(
    { repoRoot, now },
    opts,
  );
  return { seatLiveness, seatIdle, dispatchStart };
}

// ---- HYK-185-startcheck-wire (coder-task.md §1-§2) -- «배달 직후
// 시작됐는가»(dispatch-start-core.mjs, judgeDispatchStart) 판정 결선 ----
//
// 배경(coder-task.md §1): 이 코어는 이미 있었다(gap#74) -- 그런데 ORCH 실측
// 으로 이걸 import하는 프로덕션 파일이 0개였다(자기 시험 1건뿐). 이 블록이
// 그 결선이다. ★코어(judgeDispatchStart) 자체는 한 글자도 바꾸지 않는다
// (coder-task.md §2 비타협 #2) -- 여기서 하는 일은 오직 코어가 요구하는
// 입력(`dispatch`·`observations[]`·`now`)을 모아 넣는 것뿐이다.
//
// 필드 이름은 기존 두 축(`seat_*`/`idle_*`)과 구별되도록 `start_*`를 쓴다
// (watch-run.mjs buildLogLine 참조, coder-task.md §2-1 "구별되는 필드
// 이름" 비타협).
//
// ★새 orca 호출 0(coder-task.md §2-3): 관측은 seatLiveness 축과 똑같은
// `collectSeatLivenessObservation`(terminal list/show만)을 그대로 재사용
// 한다 -- 이 축을 위한 새 `terminal`/`orchestration` 호출은 추가하지
// 않는다.
//
// ★구조적 필요악(코어 자신의 헤더 주석, dispatch-start-core.mjs 참조):
// judgeDispatchStart는 "서로 다른 두 관측 사이의 lastOutputAt 전진"만
// 본다 -- 배달 직후 붙여넣기 메아리 한 번(관측 1건)만으로는 판정이
// 성립하지 않는다(코어 자신이 UNDECIDABLE로 닫는다). 예약 감시는 15분
// 주기로 반복 호출되므로(gap#61 실측), 매 실행마다 관측 1건을 저장소
// **밖**의 고정 위치(`DEFAULT_DISPATCH_START_STORE_PATH`, 관제실 --
// 어느 git 저장소에도 속하지 않는다, §3-f "저장소 오염 0"과 충돌 없음)에
// 누적해 다음 실행이 두 번째 점으로 쓸 수 있게 한다. 이 파일의 다른 모든
// 함수는 여전히 읽기 전용이다 -- 이 축만의 예외이며, 그 이유를 이 주석에
// 명시적으로 남긴다(조용한 계약 위반 방지).
//
// ★수집 실패를 조용함으로 접지 않는다(coder-task.md §2-5, gap#61/#75/#77
// 3사이클 연속 핵심과 동일 원칙): store 읽기/쓰기 실패는 `STORE_FAILED`로
// 표면화하고, 그 실행에서는 judgeDispatchStart를 아예 부르지 않는다 --
// 이번 한 번의 관측만으로 지어낸 판정을 내지 않는다.
export const DISPATCH_START_WIRE_STATUS = Object.freeze({
  // 이 워크트리에 아직 결과 파일이 없는 "활성 배달"이 없다 -- 판정 대상
  // 자체가 없다(정상, 판정 불가 아님).
  NOT_APPLICABLE: "DISPATCH_START_NOT_APPLICABLE",
  // 관측 조회는 성공했지만 이 워크트리에 붙은 좌석이 0개다(정상).
  NO_SEAT: "DISPATCH_START_NO_SEAT",
  // 관측을 모아 judgeDispatchStart를 실제로 불렀고 verdict가 나왔다.
  JUDGED: "DISPATCH_START_JUDGED",
  // 좌석 관측 수집 자체가 실패했다 -- "시작 안 됨"으로 접지 않는다.
  COLLECTION_FAILED: "DISPATCH_START_COLLECTION_FAILED",
  // 관측 히스토리 store 읽기/쓰기가 실패했다 -- 이번 실행의 관측 1건만
  // 으로는 진행 여부를 판정할 근거가 없으므로 판정을 아예 보류한다.
  STORE_FAILED: "DISPATCH_START_STORE_FAILED",
});

export const DISPATCH_START_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "DISPATCH_START_SCAN_WORKTREE_LIST_FAILED",
  HARNESS_READ_FAILED: "DISPATCH_START_SCAN_HARNESS_READ_FAILED",
});

// 하네스-관제실은 어느 워크트리의 git 저장소도 아니다(orca-adapter.mjs
// CONTROL_ROOM_PATH 재사용) -- 이 경로에 쓰는 것은 §3-f "저장소 오염 0"과
// 무관하다.
export const DEFAULT_DISPATCH_START_STORE_PATH = `${CONTROL_ROOM_PATH}/watch/dispatch-start-observations.json`;
// 워크트리당 관측을 무한정 쌓지 않는다 -- 판정에 필요한 것은 "전진했는가"
// 뿐이므로 최근 몇 개만 있으면 충분하다(오래된 표본을 굳이 지키지 않는다).
export const MAX_STORED_DISPATCH_START_OBSERVATIONS = 5;

// opts.dispatchStartExistsFn/dispatchStartReadFn 주입 가능(시험 전용,
// 실 관제실 경로를 건드리지 않고 검증) -- 기본은 실 fs. 파일 부재는 손상이
// 아니라 "첫 실행"이므로 빈 store로 정상 취급한다(observer-store.mjs
// loadStore와 동일 원칙, 재구현이 아니라 같은 관례를 이 파일 규모에 맞게
// 재사용).
function loadDispatchStartStore(storePath, opts) {
  const existsFn =
    typeof opts.dispatchStartExistsFn === "function"
      ? opts.dispatchStartExistsFn
      : existsSync;
  const readFn =
    typeof opts.dispatchStartReadFn === "function"
      ? opts.dispatchStartReadFn
      : (p) => readFileSync(p, "utf8");
  try {
    if (!existsFn(storePath)) return { ok: true, store: {} };
    const parsed = JSON.parse(readFn(storePath));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        reason: "dispatch-start store: corrupt (not a plain object)",
      };
    }
    return { ok: true, store: parsed };
  } catch (err) {
    return {
      ok: false,
      reason: `dispatch-start store: read/parse failed (${err && err.message ? err.message : String(err)})`,
    };
  }
}

// opts.dispatchStartMkdirFn/dispatchStartWriteFn 주입 가능(시험 전용).
function saveDispatchStartStore(storePath, store, opts) {
  const mkdirFn =
    typeof opts.dispatchStartMkdirFn === "function"
      ? opts.dispatchStartMkdirFn
      : (p) => mkdirSync(p, { recursive: true });
  const writeFn =
    typeof opts.dispatchStartWriteFn === "function"
      ? opts.dispatchStartWriteFn
      : (p, text) => writeFileSync(p, text, "utf8");
  try {
    mkdirFn(path.dirname(storePath));
    writeFn(storePath, JSON.stringify(store));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `dispatch-start store: write failed (${err && err.message ? err.message : String(err)})`,
    };
  }
}

// 같은 배달(dispatchId 동일)이면 저장된 관측 뒤에 이번 관측을 이어붙이고,
// 배달이 바뀌었으면(새 태스크가 드롭됨) 히스토리를 새로 시작한다 -- 지난
// 배달의 관측이 이번 배달의 "전진" 판정에 섞이지 않게 한다.
function nextObservationsForDispatch(prevEntry, dispatch, observation) {
  const sameDispatch =
    prevEntry && prevEntry.dispatchId === dispatch.dispatchId;
  const prevObservations =
    sameDispatch && Array.isArray(prevEntry.observations)
      ? prevEntry.observations
      : [];
  const combined = [...prevObservations, observation];
  return combined.length > MAX_STORED_DISPATCH_START_OBSERVATIONS
    ? combined.slice(combined.length - MAX_STORED_DISPATCH_START_OBSERVATIONS)
    : combined;
}

// judgeDispatchStartForRepo({repoRoot, droppedTaskFiles, now}, opts) --
// judgeSeatLivenessForRepo/judgeSeatIdleForRepo와 같은 형태(이미 수집된
// droppedTaskFiles를 받는다, 이 함수 자신은 .harness를 읽지 않는다) -- 이
// 축 하나(단일 워크트리)에 대해 dispatch-start-core.mjs의 judgeDispatchStart
// 를 실제로 부른다.
// store 적재 -> 관측 이어붙이기 -> store 저장 -> judgeDispatchStart 호출까지
// (§3-e max-lines-per-function 상한 준수를 위해 judgeDispatchStartForRepo에서
// 분리 -- 로직은 그대로, 자리만 옮겼다). correlation은 부가 정보로 그대로
// 실어 나른다(있을 때만).
function persistAndJudgeDispatchStart(
  { repoRoot, dispatch, observation, now, correlation },
  opts,
) {
  const storePath =
    opts.dispatchStartStorePath ?? DEFAULT_DISPATCH_START_STORE_PATH;
  const loaded = loadDispatchStartStore(storePath, opts);
  if (!loaded.ok) {
    return {
      status: DISPATCH_START_WIRE_STATUS.STORE_FAILED,
      reason: loaded.reason,
      dispatch,
    };
  }
  const currentObservation = {
    observedAtMs: now,
    lastOutputAt: observation.lastOutputAt,
  };
  const nextObservations = nextObservationsForDispatch(
    loaded.store[repoRoot],
    dispatch,
    currentObservation,
  );
  const saved = saveDispatchStartStore(
    storePath,
    {
      ...loaded.store,
      [repoRoot]: {
        dispatchId: dispatch.dispatchId,
        observations: nextObservations,
      },
    },
    opts,
  );
  if (!saved.ok) {
    return {
      status: DISPATCH_START_WIRE_STATUS.STORE_FAILED,
      reason: saved.reason,
      dispatch,
    };
  }
  const judged = judgeDispatchStart({
    dispatch,
    observations: nextObservations,
    now,
  });
  return {
    status: DISPATCH_START_WIRE_STATUS.JUDGED,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    details: judged.details,
    dispatch,
    ...(correlation ? { correlation } : {}),
  };
}

export function judgeDispatchStartForRepo(
  { repoRoot, droppedTaskFiles, now },
  opts = {},
) {
  // HYK-201부터 selectActiveDispatchForStart는 selectActiveDispatch의
  // 별칭이다(위 함수 헤더 주석 참조) -- 세 축 모두 같은 "활성 배달"
  // 정의를 쓴다.
  const active = selectActiveDispatchForStart(droppedTaskFiles);
  if (!active) {
    return { status: DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE };
  }
  const dispatch = {
    dispatchId: active.path,
    dispatchedAtMs: active.droppedAtMs,
  };
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  const primaryObserved = collectSeatLivenessObservation(
    { worktreePath: repoRoot, now },
    { execFn },
  );
  const { observed, correlation } = resolveObservationWithDeliveredSeatFallback(
    { worktreePath: repoRoot, harnessLabel: active.taskId, now, execFn },
    primaryObserved,
  );
  if (!observed.ok) {
    return {
      status: DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED,
      observationReason: observed.observationReason,
      reason: observed.reason,
      dispatch,
      ...(correlation ? { correlation } : {}),
    };
  }
  if (observed.seatCount === 0) {
    return { status: DISPATCH_START_WIRE_STATUS.NO_SEAT, dispatch };
  }
  return persistAndJudgeDispatchStart(
    { repoRoot, dispatch, observation: observed.observation, now, correlation },
    opts,
  );
}

// 워크트리 하나를 판정한다(judgeSeatLivenessForWorktree/
// judgeSeatIdleForWorktree와 대칭 구조) -- .harness 읽기 실패는 여기서
// 별도 상태로 표면화하고, judgeDispatchStartForRepo는 그 뒤(읽기가 이미
// 성공한 뒤)만 부른다.
function judgeDispatchStartForWorktree(worktreePath, now, opts) {
  const evidence = collectDroppedTaskFileEvidence(worktreePath, {
    readdirFn: opts.harnessReaddirFn,
  });
  if (evidence.failed) {
    return {
      worktreePath,
      status: DISPATCH_START_SCAN_FAILURE.HARNESS_READ_FAILED,
    };
  }
  const judged = judgeDispatchStartForRepo(
    { repoRoot: worktreePath, droppedTaskFiles: evidence.items, now },
    opts,
  );
  return { worktreePath, ...judged };
}

export const DISPATCH_START_SCAN_SEVERITY = Object.freeze({
  NORMAL: 0, // NOT_APPLICABLE/NO_SEAT/JUDGED+STARTED/JUDGED+UNDECIDABLE 미만 대기.
  UNDECIDABLE: 1, // JUDGED이지만 verdict가 UNDECIDABLE.
  COLLECTION_FAILURE: 2, // 워크트리 열거·harness 읽기·좌석 조회·store I/O 실패.
  SUSPECTED_NOT_STARTED: 3, // 가장 나쁨.
});

function dispatchStartSeverityOf(entry) {
  if (
    entry.status === DISPATCH_START_SCAN_FAILURE.WORKTREE_LIST_FAILED ||
    entry.status === DISPATCH_START_SCAN_FAILURE.HARNESS_READ_FAILED ||
    entry.status === DISPATCH_START_WIRE_STATUS.COLLECTION_FAILED ||
    entry.status === DISPATCH_START_WIRE_STATUS.STORE_FAILED
  ) {
    return DISPATCH_START_SCAN_SEVERITY.COLLECTION_FAILURE;
  }
  if (entry.status === DISPATCH_START_WIRE_STATUS.JUDGED) {
    if (entry.verdict === DISPATCH_START_VERDICT.NOT_STARTED) {
      return DISPATCH_START_SCAN_SEVERITY.SUSPECTED_NOT_STARTED;
    }
    if (entry.verdict === DISPATCH_START_VERDICT.UNDECIDABLE) {
      return DISPATCH_START_SCAN_SEVERITY.UNDECIDABLE;
    }
  }
  return DISPATCH_START_SCAN_SEVERITY.NORMAL;
}

// judgeDispatchStartAcrossWorktrees({repoRoot, now}, opts) -- seat-liveness/
// seat-idle 축과 대칭(워크트리 전부 열거 후 각각 개별 판정, 가장 나쁜
// 항목을 대표값으로 상위에 싣고 전체 목록·건수도 함께 낸다). 새 워크트리
// 열거 로직을 만들지 않고 gap#78의 `collectGitWorktrees`를 그대로
// 재사용한다(coder-task.md §2-1-2).
export function judgeDispatchStartAcrossWorktrees(
  { repoRoot, now },
  opts = {},
) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: DISPATCH_START_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeDispatchStartForWorktree(wt, now, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, dispatchStartSeverityOf(w)),
    DISPATCH_START_SCAN_SEVERITY.NORMAL,
  );
  const worstEntries = worktrees.filter(
    (w) => dispatchStartSeverityOf(w) === worstSeverity,
  );
  const worst = worstEntries[0] ?? null;
  return {
    status: worst ? worst.status : DISPATCH_START_WIRE_STATUS.NOT_APPLICABLE,
    verdict: worst ? worst.verdict : undefined,
    reasonCode: worst ? worst.reasonCode : undefined,
    details: worst ? worst.details : undefined,
    worktreePath: worst ? worst.worktreePath : undefined,
    // HYK-265-observe-split-1 (coder-task.md §3-1 항2): seat/idle 축과 동일
    // 이유 -- judgeDispatchStartForRepo의 COLLECTION_FAILED
    // observationReason/reason을 잃지 않고 위로 올린다.
    observationReason: worst ? worst.observationReason : undefined,
    reason: worst ? worst.reason : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// ---- HYK-185-unconsumed-1 (coder-task.md §1-§2) -- «워커 결과가 갱신됐는데
// 총괄이 소비하지 않았다» 판정 결선 ----
//
// unconsumed-core.mjs(judgeUnconsumed)는 순수 판정만 한다 -- 이 블록은
// 그 코어가 요구하는 입력(`resultFile.updatedAtMs`·`signals[]`·`now`)을
// 저장소 파일 시스템 + git에서 모은다. ★새 orca 호출 0 -- 이 축은 seat-
// liveness/seat-idle/dispatch-start 세 축과 달리 좌석(터미널) 관측을 전혀
// 쓰지 않는다(coder-task.md §2 요구 그대로: 입력은 «결과 파일 갱신 시각·
// 그 뒤 소비 흔적·지금 시각» 뿐, 좌석 응답과 무관).
//
// 대상 선정: 이 워크트리에 이미 존재하는 결과 파일(`resultFile.exists ===
// true`) 중 mtime이 가장 최근인 것 하나를 판정 대상으로 삼는다(여러 role의
// 결과 파일이 동시에 있어도 "가장 최근에 나온 산출물이 소비됐는가"만
// 본다 -- 오래된 결과 파일은 이미 다음 라운드로 넘어갔을 것이므로 이
// 축의 관심사가 아니다).
export const UNCONSUMED_WIRE_STATUS = Object.freeze({
  // 이 워크트리에 아직 존재하는 결과 파일이 하나도 없다 -- 판정 대상
  // 자체가 없다(정상, 판정 불가 아님).
  NOT_APPLICABLE: "UNCONSUMED_NOT_APPLICABLE",
  // 대상 결과 파일을 찾았고 judgeUnconsumed를 실제로 불렀고 verdict가
  // 나왔다.
  JUDGED: "UNCONSUMED_JUDGED",
  // ★최신 커밋 시각 조회(git log)가 실패했다 -- "소비 없음"으로 접지
  // 않고 여기서 멈춘다(§2-3 (a)/(§5-A) 비타협, 다른 세 축의
  // COLLECTION_FAILED와 동일 원칙 -- 관측 실패를 사실로 단정하지 않는다).
  COLLECTION_FAILED: "UNCONSUMED_COLLECTION_FAILED",
  // ★HYK-185-unconsumed-3 §R3-1(A) -- task 파일이 있는데(이름은 안다)
  // 그 실제 fs mtime을 못 구했다(stat 실패 등). 헤더가 판정에서 완전히
  // 빠진 지금은 이것이 그 파일에 대해 유일하게 가진 근거이므로, 조용히
  // 버리지 않고(=신호 0건으로 새지 않고) 판정 전체를 여기서 닫는다.
  TASK_FILE_MTIME_UNAVAILABLE: "UNCONSUMED_TASK_FILE_MTIME_UNAVAILABLE",
});

export const UNCONSUMED_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "UNCONSUMED_SCAN_WORKTREE_LIST_FAILED",
  HARNESS_READ_FAILED: "UNCONSUMED_SCAN_HARNESS_READ_FAILED",
});

// taskFileCandidates(collectUnconsumedCandidates가 이미 모은 배열)에서
// "이미 존재하는" 결과 파일 중 mtime이 가장 최근인 항목 하나를 고른다.
// 없으면 null(NOT_APPLICABLE).
export function selectMostRecentConsumableResult(taskFileCandidates) {
  const candidates = (
    Array.isArray(taskFileCandidates) ? taskFileCandidates : []
  )
    .filter(
      (item) =>
        item &&
        item.resultFile &&
        item.resultFile.exists === true &&
        typeof item.resultFile.mtimeMs === "number" &&
        Number.isFinite(item.resultFile.mtimeMs),
    )
    .sort((a, b) => b.resultFile.mtimeMs - a.resultFile.mtimeMs);
  return candidates.length > 0 ? candidates[0] : null;
}

// `git log -1 --format=%cI HEAD` -- 로컬 git 객체만 본다(`git fetch` 없음,
// collectRemoteContains와 동일 원칙). opts.commitTimeExecFn 주입 가능
// (시험 전용, collectGitWorktrees의 gitWorktreeListExecFn과 동일 형태) --
// 기본은 실 git 호출.
function defaultCommitTimeExec(repoRoot) {
  return execFileSync("git", ["log", "-1", "--format=%cI", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function collectLatestCommitTimeMs(repoRoot, opts = {}) {
  const exec =
    typeof opts.commitTimeExecFn === "function"
      ? opts.commitTimeExecFn
      : defaultCommitTimeExec;
  try {
    const stdout = exec(repoRoot).trim();
    const t = Date.parse(stdout);
    if (Number.isNaN(t)) return { ok: false };
    return { ok: true, commitTimeMs: t };
  } catch {
    return { ok: false };
  }
}

// ---- HYK-185-unconsumed-3 §R3-1(A) -- 소비 판정 전용 task 파일 후보
// 수집(헤더 완전 배제) ----
//
// 기존 `collectDroppedTaskFileEvidence`(다른 세 축·아래 §R3-1(B)
// `scanHeaderTimeProjection`이 여전히 쓴다)는 `dropped_at` 헤더가 없는
// task 파일을 통째로 건너뛴다 -- 그 세 축은 헤더를 "배달 시각"으로
// 신뢰해야 하므로 옳은 동작이고, 이번 라운드에서 손대지 않는다(회귀 0).
// 그런데 소비 판정은 이제 헤더를 전혀 보지 않으므로(§R3-1(A) 비타협),
// 헤더가 없다는 이유로 후보 자체가 사라지면 안 된다(REVIEW 3R P1-4) --
// 그래서 이 축 전용으로 **헤더 유무와 무관하게** `.harness/*-task.md`
// 이름 전부와 그 실제 fs mtime만 모으는 별도의 가벼운 수집을 둔다(파일
// 내용을 읽을 필요가 없다 -- 헤더를 안 보므로 `readFileSync` 자체가
// 없다, 파일 이름과 `statSync`만).
// ★HYK-185-unconsumed-4 §R4-1/§R4-2(REVIEW 반려 수리) -- task 파일과
// 결과 파일 양쪽에 **같은** 신뢰성 검사를 적용하는 공용 헬퍼. R3에서는
// 이 검사가 task 파일 쪽에만 붙어 있었다(자체 발견 반례) -- 결과 파일은
// `collectFileMtime`에 그대로 맡겨, 결과 파일이 디렉터리일 때(REVIEW
// 4R D2 반례: `.harness/coder.md`를 디렉터리로) 그 디렉터리 mtime을
// 진짜 결과로 착각해 확정적 `SUSPECTED_UNCONSUMED`를 냈다(한용 명시
// "없는 사고를 확정적으로 고발하는 방향은 그대로 두지 마라").
//
// 네 상태를 구별한다(§R4-2 "관측 실패 ≠ 파일 없음"도 여기서 함께
// 잡는다 -- 예전에는 `collectFileMtime`의 `{collected:false}`(stat 자체
// 실패)와 `{collected:true, exists:false}`(정말 없음)이 둘 다
// `{exists:false, mtimeMs:null}`로 뭉개져 구별되지 않았다):
// - 파일이 없다 -> `{collected:true, exists:false}`(정상 -- 아직 그
//   결과가 없을 뿐, 판정 불가 아니다).
// - `existsSync`는 통과했는데 `statSync`가 던졌다(권한 등) ->
//   `{collected:false}`(신뢰 불가 -- "없다"로 뭉개지 않는다).
// - 있고 stat도 됐지만 디렉터리다 -> `{collected:true, exists:true,
//   isDirectory:true}`(신뢰 불가 -- mtime을 읽지 않는다).
// - 있고 stat도 됐고 일반 파일이다 -> `{collected:true, exists:true,
//   isDirectory:false, mtimeMs}`.
//
// ★정직 기재(§R4-2, 한용 명시 "재현했으면 고정, 못 했으면 그 사실을
// 적어라"): "existsSync는 통과, statSync만 던진다"는 상태를 실제 OS
// 메커니즘(예약 장치 이름·긴 경로)으로 이 Windows 환경에서 시도했으나
// **재현하지 못했다**(`.harness/coder.md` §R4-2에 시도 내역을 그대로
// 적었다). 그래서 opts.existsFn/opts.statFn을 주입 가능하게 열어
// 이 코드 경로 자체는 결정적으로 시험한다(실 OS 결함 재현이 아니라
// 코드 경로 시험이라는 것을 시험 이름에도 명시한다) -- 수리는 재현
// 여부와 무관하게 적용했다(한용 명시 "재현 없이도 할 수 있다면 해도
// 된다").
function statForUnconsumed(repoRoot, relPath, opts = {}) {
  const existsFn =
    typeof opts.existsFn === "function" ? opts.existsFn : existsSync;
  const statFn = typeof opts.statFn === "function" ? opts.statFn : statSync;
  const full = resolveRepoPath(repoRoot, relPath);
  if (!existsFn(full)) return { collected: true, exists: false };
  let st;
  try {
    st = statFn(full);
  } catch {
    return { collected: false };
  }
  if (st.isDirectory()) {
    return { collected: true, exists: true, isDirectory: true };
  }
  return {
    collected: true,
    exists: true,
    isDirectory: false,
    mtimeMs: st.mtimeMs,
  };
}

function buildUnconsumedCandidateItem(repoRoot, name, opts = {}) {
  const relPath = `.harness/${name}`;
  const selfInfo = statForUnconsumed(repoRoot, relPath, opts);
  if (!selfInfo.collected) return null; // stat 실패 -- 신뢰 불가(§R4-2).
  if (!selfInfo.exists) return null; // readdir엔 있었는데 방금 사라짐(레이스) -- 신뢰 불가.
  if (selfInfo.isDirectory) return null; // 디렉터리 위장(기존 자체 발견 반례, 회귀 0).
  const resultName = name.replace(/-task\.md$/, ".md");
  const resultPath = `.harness/${resultName}`;
  const resultInfo = statForUnconsumed(repoRoot, resultPath, opts);
  if (!resultInfo.collected) return null; // §R4-2: stat 실패를 "없음"으로 뭉개지 않는다.
  if (resultInfo.exists && resultInfo.isDirectory) return null; // §R4-1: 결과 파일 디렉터리 위장.
  return {
    path: relPath,
    taskFileMtimeMs: selfInfo.mtimeMs,
    resultFile: resultInfo.exists
      ? { path: resultPath, exists: true, mtimeMs: resultInfo.mtimeMs }
      : { path: resultPath, exists: false, mtimeMs: null },
  };
}

// opts.readdirFn 주입 가능(시험 전용, collectDroppedTaskFileEvidence와
// 동일 형태) -- 기본은 실 readdirSync. 개별 항목의 신뢰성 실패(§R3-1(A)
// 비타협 "조용히 버리지 마라", §R4-1/§R4-2로 결과 파일까지 확장)는
// P1-2와 동일 원칙으로 즉시 `{items: [], failed: true}`로 닫는다 --
// 부분 목록으로 새지 않는다.
export function collectUnconsumedCandidates(repoRoot, opts = {}) {
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
    const item = buildUnconsumedCandidateItem(repoRoot, name, opts);
    if (!item) return { items: [], failed: true };
    items.push(item);
  }
  return { items, failed: false };
}

// unconsumed-core.mjs가 인정하는 두 신호를 저장소 흔적에서 만든다(코어
// 헤더 주석 "«소비 흔적»의 정의" 참조). ★대상 자신의 task 파일뿐 아니라
// 이 워크트리의 taskFileCandidates 전부를 본다 -- 오늘 실측 13:44 계열
// 표본은 coder.md(대상)가 아니라 review-task.md(다음 role)가 다음 라운드를
// 드롭한 형태였다.
//
// ★HYK-185-unconsumed-3 §R3-1(A): `TASK_FILE_DROPPED_AFTER` 신호는 이제
// `item.taskFileMtimeMs`(그 task 파일의 실제 mtime) **하나로만** 정해진다
// -- 헤더(`droppedAtMs`)는 이 함수가 아예 읽지 않는다(애초에
// `collectUnconsumedCandidates`가 만드는 항목에는 그 필드가 없다).
// `taskFileMtimeMs`를 못 구한 항목(수집 단계에서 이미 실패로 닫혔어야
// 하지만, 방어적으로 이 함수도 형식을 재확인한다)은 조용히 건너뛰지
// 않고 `{ok:false}`로 함수 전체를 닫는다.
function buildUnconsumedSignals(taskFileCandidates, targetMtimeMs, commitInfo) {
  const signals = [];
  for (const item of Array.isArray(taskFileCandidates)
    ? taskFileCandidates
    : []) {
    if (!item) continue;
    if (
      typeof item.taskFileMtimeMs !== "number" ||
      !Number.isFinite(item.taskFileMtimeMs)
    ) {
      return { ok: false, unavailablePath: item.path };
    }
    if (item.taskFileMtimeMs > targetMtimeMs) {
      signals.push({
        kind: UNCONSUMED_SIGNAL_KIND.TASK_FILE_DROPPED_AFTER,
        atMs: item.taskFileMtimeMs,
      });
    }
  }
  if (
    commitInfo.ok &&
    typeof commitInfo.commitTimeMs === "number" &&
    commitInfo.commitTimeMs > targetMtimeMs
  ) {
    signals.push({
      kind: UNCONSUMED_SIGNAL_KIND.NEW_COMMIT_AFTER,
      atMs: commitInfo.commitTimeMs,
    });
  }
  return { ok: true, signals };
}

// judgeUnconsumedForRepo({repoRoot, taskFileCandidates, now}, opts) -- 단일
// 저장소(워크트리) 하나에 대해 이 축을 판정한다(다른 세 축의
// judge*ForRepo와 대칭 구조 -- 이미 수집된 taskFileCandidates를 받고, 이
// 함수 자신은 .harness를 읽지 않는다).
export function judgeUnconsumedForRepo(
  { repoRoot, taskFileCandidates, now },
  opts = {},
) {
  const target = selectMostRecentConsumableResult(taskFileCandidates);
  if (!target) {
    return { status: UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE };
  }
  const resultFileInfo = {
    path: target.resultFile.path,
    mtimeMs: target.resultFile.mtimeMs,
  };
  const commitInfo = collectLatestCommitTimeMs(repoRoot, opts);
  if (!commitInfo.ok) {
    return {
      status: UNCONSUMED_WIRE_STATUS.COLLECTION_FAILED,
      reason: "unconsumed: git log failed",
      resultFile: resultFileInfo,
    };
  }
  const signalsResult = buildUnconsumedSignals(
    taskFileCandidates,
    resultFileInfo.mtimeMs,
    commitInfo,
  );
  if (!signalsResult.ok) {
    return {
      status: UNCONSUMED_WIRE_STATUS.TASK_FILE_MTIME_UNAVAILABLE,
      reason: `unconsumed: could not determine the real mtime of a task file (${signalsResult.unavailablePath})`,
      resultFile: resultFileInfo,
    };
  }
  const judged = judgeUnconsumed({
    resultFile: { updatedAtMs: resultFileInfo.mtimeMs },
    signals: signalsResult.signals,
    now,
  });
  return {
    status: UNCONSUMED_WIRE_STATUS.JUDGED,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    details: judged.details,
    resultFile: resultFileInfo,
  };
}

function judgeUnconsumedForWorktree(worktreePath, now, opts) {
  // ★HYK-185-unconsumed-4 §R4-2: existsFn/statFn도 함께 넘긴다 -- 안
  // 그러면 시험이 주입한 stat 결함이 이 축의 실제 결선 경로까지 닿지
  // 않는다(readdirFn만 넘기던 R3 코드가 이 자리에 있었다).
  const evidence = collectUnconsumedCandidates(worktreePath, {
    readdirFn: opts.harnessReaddirFn,
    existsFn: opts.existsFn,
    statFn: opts.statFn,
  });
  if (evidence.failed) {
    return {
      worktreePath,
      status: UNCONSUMED_SCAN_FAILURE.HARNESS_READ_FAILED,
    };
  }
  const judged = judgeUnconsumedForRepo(
    { repoRoot: worktreePath, taskFileCandidates: evidence.items, now },
    opts,
  );
  return { worktreePath, ...judged };
}

export const UNCONSUMED_SCAN_SEVERITY = Object.freeze({
  NORMAL: 0, // NOT_APPLICABLE/JUDGED+CONSUMED/JUDGED+UNDECIDABLE 미만 대기.
  UNDECIDABLE: 1, // JUDGED이지만 verdict가 UNDECIDABLE.
  COLLECTION_FAILURE: 2, // 워크트리 열거·harness 읽기·git log 실패.
  SUSPECTED_UNCONSUMED: 3, // 가장 나쁨.
});

function unconsumedSeverityOf(entry) {
  if (
    entry.status === UNCONSUMED_SCAN_FAILURE.WORKTREE_LIST_FAILED ||
    entry.status === UNCONSUMED_SCAN_FAILURE.HARNESS_READ_FAILED ||
    entry.status === UNCONSUMED_WIRE_STATUS.COLLECTION_FAILED ||
    entry.status === UNCONSUMED_WIRE_STATUS.TASK_FILE_MTIME_UNAVAILABLE
  ) {
    return UNCONSUMED_SCAN_SEVERITY.COLLECTION_FAILURE;
  }
  if (entry.status === UNCONSUMED_WIRE_STATUS.JUDGED) {
    if (entry.verdict === UNCONSUMED_VERDICT.SUSPECTED_UNCONSUMED) {
      return UNCONSUMED_SCAN_SEVERITY.SUSPECTED_UNCONSUMED;
    }
    if (entry.verdict === UNCONSUMED_VERDICT.UNDECIDABLE) {
      return UNCONSUMED_SCAN_SEVERITY.UNDECIDABLE;
    }
  }
  return UNCONSUMED_SCAN_SEVERITY.NORMAL;
}

// judgeUnconsumedAcrossWorktrees({repoRoot, now}, opts) -- 다른 세 축과
// 대칭(워크트리 전부 열거 후 각각 개별 판정, 가장 나쁜 항목을 대표값으로
// 상위에 싣고 전체 목록·건수도 함께 낸다). 새 워크트리 열거 로직을 만들지
// 않고 gap#78의 `collectGitWorktrees`를 그대로 재사용한다.
export function judgeUnconsumedAcrossWorktrees({ repoRoot, now }, opts = {}) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: UNCONSUMED_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeUnconsumedForWorktree(wt, now, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, unconsumedSeverityOf(w)),
    UNCONSUMED_SCAN_SEVERITY.NORMAL,
  );
  const worstEntries = worktrees.filter(
    (w) => unconsumedSeverityOf(w) === worstSeverity,
  );
  const worst = worstEntries[0] ?? null;
  return {
    status: worst ? worst.status : UNCONSUMED_WIRE_STATUS.NOT_APPLICABLE,
    verdict: worst ? worst.verdict : undefined,
    reasonCode: worst ? worst.reasonCode : undefined,
    details: worst ? worst.details : undefined,
    worktreePath: worst ? worst.worktreePath : undefined,
    // HYK-265-observe-split-1 (coder-task.md §3-1 항2): 이 축은
    // observationReason이 없고(judgeUnconsumedForRepo 참조) reason(자유
    // 텍스트, 예: "unconsumed: git log failed")만 만든다 -- 있는 그대로
    // 위로 올린다.
    reason: worst ? worst.reason : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// ---- HYK-185-unconsumed-3 §R3-1(B) -- 헤더-실물 시각 어긋남(위조/오기)
// 탐지, 소비 판정과 완전히 분리 ----
//
// ⛔이 함수는 `judgeUnconsumedForRepo`/`buildUnconsumedSignals`/
// `judgeUnconsumedAcrossWorktrees` 어디에서도 호출되지 않는다 -- 소비
// 판정에 어떤 경로로도 기여하지 않는다(한용 명시). 헤더가 있는 task
// 파일만 대조 대상이 될 수 있으므로(헤더가 없으면 대조할 것이 없다,
// gap 등재 참조) 헤더를 여전히 담는 `collectDroppedTaskFileEvidence`를
// 그대로 재사용한다 -- 이 재사용은 다른 세 축의 동작을 하나도 바꾸지
// 않는다(그 함수 자신은 이 라운드에 손대지 않았다).
export function scanHeaderTimeProjection(repoRoot, opts = {}) {
  const evidence = collectDroppedTaskFileEvidence(repoRoot, {
    readdirFn: opts.harnessReaddirFn,
  });
  if (evidence.failed) {
    return { ok: false, reason: "HARNESS_READ_FAILED", items: [] };
  }
  const items = evidence.items
    .filter(
      (item) =>
        item &&
        typeof item.droppedAtMs === "number" &&
        Number.isFinite(item.droppedAtMs),
    )
    .map((item) => {
      const judged = judgeHeaderTimeProjection({
        headerFloorMs: item.droppedAtMs,
        taskFileMtimeMs: item.taskFileMtimeMs,
      });
      return { path: item.path, ...judged };
    });
  return { ok: true, items };
}

// ---- HYK-173-push-wire (coder-task.md §5) -- «워커 escalation 인박스
// 구독» 축 ----
//
// §6 사각을 정직하게 박아라(coder-task.md §6, 문구 그대로 코드 헤더에):
//
// 이 축이 잡는 것은 **워커가 살아서 통제된 중단 신호를 보낸 경우뿐**이다.
// ⓐ배달 레코드 미생성(`injected=true`인데 `dispatch-show`가
// `dispatch:null`) ⓑ침묵 정지·crash·kill ⓒrate-limit는 이 축의 관측
// 밖이며(`PUSH_UNOBSERVABLE`), ⓐ는 배달 사후검증(별건), ⓑⓒ는
// pull(HYK-171) 몫이다. 이 조각 병합으로 HYK-173의 요구(«어떤 사유로든
// 멈추면 반드시 전달»)가 충족됐다고 주장하지 않는다.
//
// 그리고(PM 축 7-3·S5): 감시 통지는 «아직 아무도 안 봤다»가 아니라
// «아직 안 봤을 수 있다»다 -- ORCH 세션이 일반 check로 소비하면 감시의
// peek에서 사라지고, peek은 처리 여부를 모른다.
//
// push 채널은 **어댑터 B(Orca) 전용 보강**이다. 어댑터·엔진 무관 기저는
// **결과 파일 표지**(BLOCKED/NEEDS_INPUT, `watch-result.mjs`)이며
// **어댑터 A에서 이 축은 존재하지 않는다.** 이 축의 존재로 «무인 정지
// 전달이 완결됐다»고 주장하지 않는다.
//
// ---- §5-B: handle을 박지 마라 ----
// coordinatorHandle을 설정 파일·환경변수에 저장하지 않는다. 매 실행
// `terminal list`를 조회해 "이 저장소의 메인 워크트리(MAIN_REPO_PATH,
// ORCH 자신이 앉는 자리)"라는 안정 키에서 handle을 새로 해석하고, 그
// 해석 자체가 "지금 이 순간의 살아 있는 좌석 목록"과의 대조다(목록에
// 없으면 애초에 후보가 안 나온다 -- 후보 0개/2개+는 실패로 표면화하지,
// "조용한 count:0"으로 새지 않는다, S3 비타협).
export const ESCALATION_WIRE_STATUS = Object.freeze({
  OK: "ESCALATION_OK",
  COLLECTION_FAILED: "ESCALATION_COLLECTION_FAILED",
});

function canonicalizeWorktreePath(rawPath) {
  const normalized = normalizeAbsolute(rawPath).toLowerCase();
  return /^[a-z]:\/$/.test(normalized)
    ? normalized
    : normalized.replace(/\/+$/, "");
}

// 안정 키 = MAIN_REPO_PATH(ORCH 자신의 워크트리, 코드 상수 -- 저장 상태
// 아님). 후보 0개/2개+는 거부(resolveSeatHandle A-1과 동일 원칙 재사용,
// 자동 선택 금지).
function resolveCoordinatorHandle(opts) {
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  let response;
  try {
    response = execFn(buildTerminalListCommand());
  } catch (err) {
    return {
      ok: false,
      reason: `orch-stall-detect: coordinator handle resolve -- terminal list query threw (${err && err.message ? err.message : String(err)})`,
    };
  }
  const list = parseTerminalList(response);
  if (!list) {
    return {
      ok: false,
      reason:
        "orch-stall-detect: coordinator handle resolve -- terminal list response missing/invalid result.terminals",
    };
  }
  const target = canonicalizeWorktreePath(MAIN_REPO_PATH);
  const candidates = list.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.handle === "string" &&
      entry.handle.length > 0 &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeWorktreePath(entry.worktreePath) === target,
  );
  if (candidates.length !== 1) {
    return {
      ok: false,
      reason: `orch-stall-detect: coordinator handle resolve -- expected exactly 1 seat at MAIN_REPO_PATH, found ${candidates.length} (S3 비타협: 낡은 handle을 '조용한 0건'으로 통과시키지 않는다)`,
    };
  }
  return { ok: true, handle: candidates[0].handle };
}

// §5-A: collectCompletionSignals(orca-adapter.mjs)의 advisory-only 실패
// 삼킴 계약(ok:true/signals:[]/note)을 재사용하지 않는다 -- argv 조립
// (buildNonBlockingCheckCommand)만 재사용하고, 실패는 이 함수 자신이
// ok:false로 표면화한다.
function peekEscalationMessages(handle, opts) {
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  let response;
  try {
    response = execFn(buildNonBlockingCheckCommand(handle));
  } catch (err) {
    return {
      ok: false,
      reason: `orch-stall-detect: escalation peek threw (${err && err.message ? err.message : String(err)})`,
    };
  }
  if (!response || typeof response !== "object" || response.ok !== true) {
    return {
      ok: false,
      reason: "orch-stall-detect: escalation peek did not return ok:true",
    };
  }
  const messages = Array.isArray(response.result?.messages)
    ? response.result.messages
    : null;
  if (!messages) {
    return {
      ok: false,
      reason:
        "orch-stall-detect: escalation peek response missing/invalid result.messages",
    };
  }
  return { ok: true, messages };
}

// S1 실측 payload shape: JSON 문자열 {"taskId":…,"dispatchId":…}. 파싱
// 불가/필드 결손은 그 메시지를 스코프에 못 묶는다는 뜻이라 조용히
// 건너뛴다(이 조각의 정직 한계 -- payload가 계약을 어기면 그 메시지
// 하나는 관측 밖이 된다, fabricate하지 않는다).
function parseEscalationScope(message) {
  if (!message || typeof message.payload !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(message.payload);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.dispatchId !== "string"
  ) {
    return null;
  }
  return { taskId: parsed.taskId, dispatchId: parsed.dispatchId };
}

function scopeGroupKey(scope) {
  return `${scope.taskId} ${scope.dispatchId}`;
}

// S1 실측 안정 식별자 -- sequence(단조 증가)를 우선하고 없으면 id를
// 쓴다. dedupe(§5-D, watch-run.mjs가 shouldNotify로 실호출)의 재료가
// 되는 값이라 여기서 확정해 축 결과에 실어 보낸다.
function pickTransitionId(messages) {
  let best = null;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.sequence === "number") {
      if (
        !best ||
        (typeof best.sequence === "number" && m.sequence > best.sequence)
      ) {
        best = m;
      }
    } else if (!best) {
      best = m;
    }
  }
  if (!best) return null;
  if (typeof best.sequence === "number") return String(best.sequence);
  if (typeof best.id === "string") return best.id;
  return null;
}

// §5-C 승격 기준 1~4(coder-task.md 문구 그대로) 이 함수 하나에 전부
// 반영: reduceCoordinatorState -> shouldWakeHuman을 "실제로" 부른다.
// ★4항: 이 감시기는 reason 문자열을 해석해 자동 분류하지 않는다 --
// escalation 메시지가 요구하는 사람 게이트가 정확히 무엇인지는 이 축이
// 판단할 수 없으므로(자기 신고 계열 금지), 모든 scoped escalation을
// «분류 불가 → 게이트7(상신 답변)로 승격»(3항)으로 취급해
// isHumanGateNeedsInput을 무조건 true로 준다 -- 이는 "미분류는 전부
// wake로 접는다"(4항, 과소통지보다 과대통지)를 코드로 고정한 것이다.
function judgeScopeGroup(scope, messages, now) {
  const reduced = reduceCoordinatorState({
    scope,
    events: {
      orchestrationMessages: messages.map((m) => ({
        type: "escalation",
        taskId: scope.taskId,
        dispatchId: scope.dispatchId,
        ...(m && typeof m === "object" ? m : {}),
      })),
    },
  });
  const isHumanGateNeedsInput = true;
  const wakeHuman = shouldWakeHuman(reduced.state, isHumanGateNeedsInput);
  const latest = messages[messages.length - 1];
  return {
    scope,
    state: reduced.state,
    dedupeKey: reduced.dedupeKey,
    transitionId: pickTransitionId(messages),
    wakeHuman,
    // 관측 시각(watch-run.mjs 회차의 now) -- 순수 참고용, 판정에는 쓰지
    // 않는다(reduceCoordinatorState 입력에 넣지 않음: 그 함수의 events
    // 계약에 시각 필드가 없다).
    observedAtMs: typeof now === "number" ? now : null,
    sampleSubject:
      latest && typeof latest.subject === "string" ? latest.subject : null,
    sampleBody: latest && typeof latest.body === "string" ? latest.body : null,
  };
}

// 우선순위: HUMAN_WAKE_STATES(SUPERVISOR_FAULT/INCONSISTENT/SILENT_STALL)
// > NEEDS_INPUT. 이 축이 실제로 만들어내는 wake 상태는 이 조합뿐이다
// (아래 judgeEscalationForRepo 참조 -- 수집 실패 경로는 항상
// SUPERVISOR_FAULT, 살아있는 escalation 메시지는 항상 NEEDS_INPUT).
const STATE_PRIORITY = [
  COORD_STATE.SUPERVISOR_FAULT,
  COORD_STATE.INCONSISTENT,
  COORD_STATE.SILENT_STALL,
  COORD_STATE.NEEDS_INPUT,
];

function pickWorstState(wakeScopes) {
  for (const s of STATE_PRIORITY) {
    if (wakeScopes.some((w) => w.state === s)) return s;
  }
  return wakeScopes.length > 0 ? wakeScopes[0].state : null;
}

// judgeEscalationForRepo({repoRoot, now}, opts) -- 이 저장소의 coordinator
// (ORCH 자신) 인박스를 peek해 escalation 메시지를 스코프(taskId/
// dispatchId)별로 묶고, 각 스코프를 escalation-state.mjs의 판단층에
// 넘겨 wake 여부를 얻는다. 반환 shape은 기존 4축과 같은 4필드 관례
// (status/verdict/worstCount/totalWorktrees)를 따르되, worstCount는
// "가장 나쁜 등급의 워크트리 수"가 아니라 "wake-worthy한 스코프 수"다
// (이 축에는 워크트리 스캔 개념이 없다 -- 인박스는 저장소당 1개뿐이고
// 워커별로 여러 개가 아니다. §5 판단: 필드 이름은 axisLogSegment의
// 기존 관례[prefix_worktrees]를 그대로 재사용하되 의미는 "관측된 스코프
// 수"로 재정의한다 -- cap 축이 이미 같은 형태의 선례다,
// reach-report-core.mjs AXES 주석 참조).
// ★repoRoot를 받지 않는다(호출부 시그니처는 다른 4축과 맞추려고
// {repoRoot, now}를 그대로 넘기지만, 이 축은 쓰지 않는다) -- coordinator
// 정체성은 저장소 경로가 아니라 MAIN_REPO_PATH(ORCH 자신이 앉는 고정
// 자리) 하나로 정해지므로 --repo-root가 무엇이든 같은 인박스를 본다
// (인박스는 저장소당이 아니라 ORCH 세션당 1개).
export function judgeEscalationForRepo({ now } = {}, opts = {}) {
  const handleResult = resolveCoordinatorHandle(opts);
  if (!handleResult.ok) {
    const failState = reduceCoordinatorState({
      scope: {},
      events: { supervisorFault: true },
    });
    return {
      status: ESCALATION_WIRE_STATUS.COLLECTION_FAILED,
      verdict: failState.state,
      reason: handleResult.reason,
      worstCount: 0,
      totalWorktrees: 0,
      scopes: [],
    };
  }
  const peeked = peekEscalationMessages(handleResult.handle, opts);
  if (!peeked.ok) {
    const failState = reduceCoordinatorState({
      scope: {},
      events: { supervisorFault: true },
    });
    return {
      status: ESCALATION_WIRE_STATUS.COLLECTION_FAILED,
      verdict: failState.state,
      reason: peeked.reason,
      worstCount: 0,
      totalWorktrees: 0,
      scopes: [],
    };
  }
  const escalationMsgs = peeked.messages.filter(
    (m) => m && typeof m === "object" && m.type === "escalation",
  );
  const groups = new Map();
  for (const m of escalationMsgs) {
    const scope = parseEscalationScope(m);
    if (!scope) continue;
    const key = scopeGroupKey(scope);
    if (!groups.has(key)) groups.set(key, { scope, messages: [] });
    groups.get(key).messages.push(m);
  }
  const scopes = Array.from(groups.values()).map(({ scope, messages }) =>
    judgeScopeGroup(scope, messages, now),
  );
  const wakeScopes = scopes.filter((s) => s.wakeHuman);
  return {
    status: ESCALATION_WIRE_STATUS.OK,
    verdict: wakeScopes.length > 0 ? pickWorstState(wakeScopes) : null,
    worstCount: wakeScopes.length,
    totalWorktrees: scopes.length,
    scopes,
  };
}

// ---- HYK-212-postcheck-1 (coder-task.md §2 설계 -- ⓐ+ⓑ 결합) --
// «배달 직후 재조회 사후검증»의 감시 시점 결선 ----
//
// 실제 재조회(dispatch-show)는 배달 시점(orca-adapter.mjs
// deliverToClaudeSeat, runDispatchPostcheck)에서 이미 끝나 있다 -- 그
// 시점에만 "이 배달에 쓰인 orca task id"와 "injected:true 자기신고"가
// 함께 있기 때문이다(watch 시점 .harness/*-task.md에는 harness 라벨만
// 있고 orca task id가 없어 재구성 불가). 이 축은 그래서 orca를 **다시
// 부르지 않는다**(이 파일 자신의 §2-3 부작용 0/G9 계약과 합치) --
// 배달이 워크트리에 남긴 영수증(`.harness/dispatch-postcheck.json`)을
// 읽기만 한다.
//
// 영수증이 RECORD_MISSING을 담고 있다는 것은 배달 시점에 이미 재조회로
// 확인된 사실이다(자기신고가 아니라 dispatch-show 재조회 결과) --
// 이 축은 그 사실을 조용히 UNDECIDABLE로 접지 않고 그대로 표면화해
// AXES(reach-report-core.mjs)에 태운다(§2 요구: 탐지는 배달 시점에서,
// 사람 도달은 이미 있는 AXES 등록형 파이프라인 재사용).
export const DISPATCH_POSTCHECK_WIRE_STATUS = Object.freeze({
  NOT_APPLICABLE: "NOT_APPLICABLE",
  JUDGED: "JUDGED",
  // 배달 시점 재조회 자체가 실패(execFn threw/NOT_OK/FIELDS_INCOMPLETE) --
  // §3-3: 이 상태는 절대 RECORD_MISSING(verdict)으로 접지 않는다.
  QUERY_FAILED: "DISPATCH_POSTCHECK_QUERY_FAILED",
});

export const DISPATCH_POSTCHECK_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "DISPATCH_POSTCHECK_SCAN_WORKTREE_LIST_FAILED",
  RECEIPT_READ_FAILED: "DISPATCH_POSTCHECK_SCAN_RECEIPT_READ_FAILED",
});

function isPlainObjectLocal(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 영수증 파일이 없는 것(ENOENT)은 정상이다(claude 엔진이 injected:true를
// 자기신고한 배달이 아직 없었다는 뜻) -- 그 외 읽기/파싱 실패는
// RECEIPT_READ_FAILED로 표면화한다(§2-3 "판정 불가를 조용함으로 접지
// 않는다"와 같은 원칙, collectDroppedTaskFileEvidence와 대칭).
function readDispatchPostcheckReceipt(worktreePath, opts) {
  const readFn =
    typeof opts.postcheckReadFn === "function"
      ? opts.postcheckReadFn
      : readFileSync;
  const receiptPath = path.join(
    worktreePath,
    ".harness",
    "dispatch-postcheck.json",
  );
  let text;
  try {
    text = readFn(receiptPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { present: false, failed: false };
    }
    return { present: false, failed: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: false, failed: true };
  }
  if (!isPlainObjectLocal(parsed) || typeof parsed.status !== "string") {
    return { present: false, failed: true };
  }
  return { present: true, failed: false, receipt: parsed };
}

function judgeDispatchPostcheckForWorktree(worktreePath, opts) {
  const evidence = readDispatchPostcheckReceipt(worktreePath, opts);
  if (evidence.failed) {
    return {
      worktreePath,
      status: DISPATCH_POSTCHECK_SCAN_FAILURE.RECEIPT_READ_FAILED,
    };
  }
  if (!evidence.present) {
    return {
      worktreePath,
      status: DISPATCH_POSTCHECK_WIRE_STATUS.NOT_APPLICABLE,
    };
  }
  const r = evidence.receipt;
  const runtimeTaskId =
    typeof r.runtimeTaskId === "string" ? r.runtimeTaskId : null;
  const harnessTaskId =
    typeof r.harnessTaskId === "string" ? r.harnessTaskId : null;
  const reasonCode = typeof r.reasonCode === "string" ? r.reasonCode : null;
  if (r.status === "QUERY_FAILED") {
    return {
      worktreePath,
      status: DISPATCH_POSTCHECK_WIRE_STATUS.QUERY_FAILED,
      reasonCode,
      runtimeTaskId,
      harnessTaskId,
    };
  }
  return {
    worktreePath,
    status: DISPATCH_POSTCHECK_WIRE_STATUS.JUDGED,
    verdict: typeof r.verdict === "string" ? r.verdict : null,
    reasonCode,
    runtimeTaskId,
    harnessTaskId,
  };
}

export const DISPATCH_POSTCHECK_SCAN_SEVERITY = Object.freeze({
  NORMAL: 0, // NOT_APPLICABLE / JUDGED+CONFIRMED
  QUERY_FAILURE: 1, // JUDGED이지만 영수증 자체가 QUERY_FAILED(배달 시점 재조회 실패)
  COLLECTION_FAILURE: 2, // 워크트리 열거 실패 / 영수증 파일 손상
  RECORD_MISSING: 3, // 가장 나쁨 -- 확인된 경보
});

function dispatchPostcheckSeverityOf(entry) {
  if (
    entry.status === DISPATCH_POSTCHECK_SCAN_FAILURE.WORKTREE_LIST_FAILED ||
    entry.status === DISPATCH_POSTCHECK_SCAN_FAILURE.RECEIPT_READ_FAILED
  ) {
    return DISPATCH_POSTCHECK_SCAN_SEVERITY.COLLECTION_FAILURE;
  }
  if (entry.status === DISPATCH_POSTCHECK_WIRE_STATUS.QUERY_FAILED) {
    return DISPATCH_POSTCHECK_SCAN_SEVERITY.QUERY_FAILURE;
  }
  if (
    entry.status === DISPATCH_POSTCHECK_WIRE_STATUS.JUDGED &&
    entry.verdict === "RECORD_MISSING"
  ) {
    return DISPATCH_POSTCHECK_SCAN_SEVERITY.RECORD_MISSING;
  }
  return DISPATCH_POSTCHECK_SCAN_SEVERITY.NORMAL;
}

// judgeDispatchPostcheckAcrossWorktrees({repoRoot}, opts) -- seat-liveness/
// dispatch-start 두 축과 대칭 구조(워크트리 전부 열거 -> 각각 개별 판정
// -> 가장 나쁜 항목을 대표값으로 상위에 싣는다), 단 이 축은 좌석 관측이
// 아니라 배달이 이미 남긴 영수증 파일만 읽으므로 opts.execFn을 쓰지
// 않는다(orca 재호출 0).
export function judgeDispatchPostcheckAcrossWorktrees({ repoRoot }, opts = {}) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: DISPATCH_POSTCHECK_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeDispatchPostcheckForWorktree(wt, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, dispatchPostcheckSeverityOf(w)),
    DISPATCH_POSTCHECK_SCAN_SEVERITY.NORMAL,
  );
  const worstEntries = worktrees.filter(
    (w) => dispatchPostcheckSeverityOf(w) === worstSeverity,
  );
  const worst = worstEntries[0] ?? null;
  return {
    status: worst
      ? worst.status
      : DISPATCH_POSTCHECK_WIRE_STATUS.NOT_APPLICABLE,
    verdict: worst ? worst.verdict : undefined,
    reasonCode: worst ? worst.reasonCode : undefined,
    runtimeTaskId: worst ? worst.runtimeTaskId : undefined,
    harnessTaskId: worst ? worst.harnessTaskId : undefined,
    worktreePath: worst ? worst.worktreePath : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// ---- HYK-239-chain-wire-2 (coder-task.md §1) -- «원장 해시체인 위조
// 탐지» 축의 감시 시점 결선(push 도달 경로) ----
//
// 검토 1R 반려: 1R이 만든 배달 차단(dispatch-gate-decision.mjs)은 사람이
// 다음 CODER 배달을 시도할 때만 발동한다 -- 사람이 아무 명령도 치지
// 않아도 위조를 알게 되는 경로가 아니었다. 이 축은 HYK-212-postcheck-1
// (바로 위 블록)과 완전히 같은 형태로 그 경로를 만든다: 감시 사이클이
// 매 tick마다 이 축을 "무조건" 재조회하므로, 배달이 한 건도 없어도
// 위조가 있으면 다음 tick에 표면화된다.
//
// ★scripts/check/**는 이 저장소의 무접촉 범위다(바로 위 §2 §1-3 주석과
// 동일 원칙 -- collectResultFileCompletion 헤더가 이미 "scripts/check/**
// 는 무접촉 범위라 그 파일을 import하지 않는다"고 선언한 그 경계). 그래서
// 이 축은 scripts/check/reject-streak-chain.mjs나 reject-streak.mjs의
// 함수를 import하지 않는다 -- 대신 dispatch-gate-decision.mjs가 이미
// reject-streak.mjs의 gate/diagnostic-gate CLI를 다루는 것과 동일한
// 방식으로, 각 워크트리 "자기 자신의" reject-streak-chain.mjs CLI를
// `verify-all` 서브커맨드로 스폰한다(정본 판정 로직 재구현 0 -- 이미
// 검토가 load-bearing으로 확인한 checkAppendOnlyAll을 그대로 호출).
// 워크트리마다 자기 자신의 스크립트를 부르는 이유: 워크트리가 서로 다른
// 브랜치일 수 있어(dispatch-gate-decision.mjs의 REJECT_STREAK_PATH가
// import.meta.url 기준으로 "자기 워크트리"를 쓰는 것과 동일 이유), 그
// 워크트리에 실제로 체크아웃된 버전의 판정 로직으로 그 워크트리 자신의
// 원장을 재는 것이 옳다.
export const CHAIN_WIRE_STATUS = Object.freeze({
  JUDGED: "JUDGED",
  // reject-streak-chain.mjs verify-all 자신이 UNJUDGABLE(원장/사이드카
  // 판독 불가)로 fail-open했거나, 스폰/파싱 자체가 실패한 경우. §1-5
  // 요구대로 "판정 불가"를 "정상"(CLEAN)으로도 "위조"(TAMPER_DETECTED)로도
  // 접지 않는다 -- 별도 상태.
  QUERY_FAILED: "CHAIN_QUERY_FAILED",
});

export const CHAIN_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "CHAIN_SCAN_WORKTREE_LIST_FAILED",
});

export const CHAIN_VERDICT = Object.freeze({
  CLEAN: "CLEAN",
  TAMPER_DETECTED: "TAMPER_DETECTED",
});

// runChainVerifyAll에서 분리(§6 eslint max-complexity 상한 준수) --
// execFileSync가 던지는 에러 객체를 이 함수의 결과 shape로 옮겨 적을
// 뿐, 판정 로직은 없다.
function chainVerifyErrorToResult(err) {
  const status = err && err.status !== undefined ? err.status : null;
  const stdout = err && err.stdout ? String(err.stdout) : "";
  const stderrText = err && err.stderr ? String(err.stderr) : "";
  const fallbackText = String(err?.message ?? err ?? "");
  return {
    exitCode: status,
    stdout,
    stderr: stderrText || fallbackText,
  };
}

function runChainVerifyAll(worktreePath, opts) {
  const execFn =
    typeof opts.chainExecFn === "function" ? opts.chainExecFn : execFileSync;
  const scriptPath = path.join(
    worktreePath,
    "scripts",
    "check",
    "reject-streak-chain.mjs",
  );
  const ledgerPath = path.join(worktreePath, ".harness", "reject-streak.json");
  const chainPath = path.join(
    worktreePath,
    ".harness",
    "reject-streak-chain.json",
  );
  try {
    const stdout = execFn(
      "node",
      [scriptPath, "verify-all", "--ledger", ledgerPath, "--chain", chainPath],
      { encoding: "utf8" },
    );
    return { exitCode: 0, stdout: String(stdout ?? "") };
  } catch (err) {
    return chainVerifyErrorToResult(err);
  }
}

// verify-all의 exit 2 stdout은 `  BLOCK <issueId> -- <reason>` 줄을
// 최소 1개 담는다(reject-streak-chain.mjs 자신의 CLI 포맷, 이 파일이
// 재구현하지 않고 그대로 파싱만 한다).
const CHAIN_BLOCK_LINE_RE = /^\s*BLOCK\s+(\S+)\s+--\s+(.*)$/m;

function extractTamperDetail(stdout) {
  const m = CHAIN_BLOCK_LINE_RE.exec(stdout ?? "");
  return m
    ? { issueId: m[1], reason: m[2].trim() }
    : { issueId: null, reason: null };
}

function firstLine(text) {
  const t = String(text ?? "").trim();
  const nl = t.indexOf("\n");
  return nl === -1 ? t : t.slice(0, nl);
}

function judgeChainIntegrityForWorktree(worktreePath, opts) {
  const r = runChainVerifyAll(worktreePath, opts);
  if (r.exitCode === 2) {
    const { issueId, reason } = extractTamperDetail(r.stdout);
    return {
      worktreePath,
      status: CHAIN_WIRE_STATUS.JUDGED,
      verdict: CHAIN_VERDICT.TAMPER_DETECTED,
      issueId,
      reason,
    };
  }
  if (r.exitCode === 0) {
    if (r.stdout.includes("UNJUDGABLE")) {
      return {
        worktreePath,
        status: CHAIN_WIRE_STATUS.QUERY_FAILED,
        reason: firstLine(r.stdout),
      };
    }
    return {
      worktreePath,
      status: CHAIN_WIRE_STATUS.JUDGED,
      verdict: CHAIN_VERDICT.CLEAN,
    };
  }
  return {
    worktreePath,
    status: CHAIN_WIRE_STATUS.QUERY_FAILED,
    reason: firstLine(r.stderr || r.stdout || `exit=${String(r.exitCode)}`),
  };
}

export const CHAIN_SCAN_SEVERITY = Object.freeze({
  NORMAL: 0, // JUDGED+CLEAN
  QUERY_FAILURE: 1, // 판정 불가(원장/사이드카 판독 실패, 스폰 실패)
  COLLECTION_FAILURE: 2, // 워크트리 열거 실패
  TAMPER_DETECTED: 3, // 가장 나쁨 -- 위조 확인
});

function chainSeverityOf(entry) {
  if (entry.status === CHAIN_SCAN_FAILURE.WORKTREE_LIST_FAILED) {
    return CHAIN_SCAN_SEVERITY.COLLECTION_FAILURE;
  }
  if (entry.status === CHAIN_WIRE_STATUS.QUERY_FAILED) {
    return CHAIN_SCAN_SEVERITY.QUERY_FAILURE;
  }
  if (
    entry.status === CHAIN_WIRE_STATUS.JUDGED &&
    entry.verdict === CHAIN_VERDICT.TAMPER_DETECTED
  ) {
    return CHAIN_SCAN_SEVERITY.TAMPER_DETECTED;
  }
  return CHAIN_SCAN_SEVERITY.NORMAL;
}

// judgeChainIntegrityAcrossWorktrees({repoRoot}, opts) -- postcheck 축과
// 대칭 구조(워크트리 전부 열거 -> 각각 개별 판정 -> 가장 나쁜 항목을
// 대표값으로 상위에 싣는다). postcheck와 달리 이 축은 배달이 남긴
// 영수증이 아니라 매번 원장 자체를 재검증한다 -- 배달이 0건이어도
// 다음 tick에 위조가 드러난다(§1 요건 "push 경로").
export function judgeChainIntegrityAcrossWorktrees({ repoRoot }, opts = {}) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: CHAIN_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeChainIntegrityForWorktree(wt, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, chainSeverityOf(w)),
    CHAIN_SCAN_SEVERITY.NORMAL,
  );
  const worstEntries = worktrees.filter(
    (w) => chainSeverityOf(w) === worstSeverity,
  );
  const worst = worstEntries[0] ?? null;
  return {
    status: worst ? worst.status : CHAIN_WIRE_STATUS.JUDGED,
    verdict: worst ? worst.verdict : CHAIN_VERDICT.CLEAN,
    issueId: worst ? worst.issueId : undefined,
    reason: worst ? worst.reason : undefined,
    worktreePath: worst ? worst.worktreePath : undefined,
    worktrees,
    totalWorktrees: worktrees.length,
    worstCount: worstEntries.length,
  };
}

// HYK-240 요건3 (push 경로): 승인<->코드지문 결속(scripts/check/
// review-approval-binding.mjs, commit-msg 훅이 이미 실시간으로 막는 것)이
// "커밋 시도가 있었을 때만" 사람에게 도달한다는 한계를 push 경로로 닫는다.
// chain 축(HYK-239)과 동일 구조 -- 각 워크트리 "자기 자신의"
// review-approval-binding.mjs를 스폰한다(함수 import 0, 그 워크트리에
// 실제 체크아웃된 버전으로 그 워크트리 자신의 review.md/작업트리를 잰다).
// 커밋을 아직 시도하지 않은 채 조용히 방치된 "승인 후 변경"도 다음 tick에
// 드러난다(커밋 게이트는 커밋을 "시도"해야만 발동하므로 그 사이의 침묵을
// 이 축이 메운다).
export const BINDING_WIRE_STATUS = Object.freeze({
  JUDGED: "JUDGED",
  // review-approval-binding.mjs --explain 스폰/파싱 자체가 실패했거나,
  // 그 도구가 "판정 불가"를 낸 경우. §1-5와 동일하게 "정상"으로도
  // "위조"로도 접지 않는다.
  QUERY_FAILED: "BINDING_QUERY_FAILED",
});

export const BINDING_SCAN_FAILURE = Object.freeze({
  WORKTREE_LIST_FAILED: "BINDING_SCAN_WORKTREE_LIST_FAILED",
});

export const BINDING_VERDICT = Object.freeze({
  // review.md가 아예 없거나(검토 전/무관 워크트리), 지문이 있고 일치하는
  // 경우. ⛔정직 한계: "결속 없음"(review.md는 있는데 binding-fingerprint
  // 줄이 없는 구버전 승인)도 이 축에서는 CLEAN으로 접는다 -- 이 필드가
  // 아직 없던 기존 review.md 전부를 이 축이 "열린 이상"으로 잡으면 이
  // 기능이 배포되는 순간 저장소 전체가 오경보로 뒤덮인다. 그 상태의
  // 유일한 정본 강제는 커밋 게이트 자신(fail-closed, review-gate.mjs)이다
  // -- 이 축은 "승인됐는데 그 뒤 코드가 바뀐" 조용한 사고만 잡는다.
  CLEAN: "CLEAN",
  MISMATCH: "MISMATCH",
});

const BINDING_JUDGEMENT_LINE_RE = /^3\)\s*판정:\s*(\S+)/m;

// runBindingExplain에서 분리(§6 eslint complexity 상한 준수 --
// chainVerifyErrorToResult와 동일 이유/모양).
function bindingExplainErrorToResult(err) {
  const status = err && err.status !== undefined ? err.status : null;
  const stdout = err && err.stdout ? String(err.stdout) : "";
  const stderrText = err && err.stderr ? String(err.stderr) : "";
  const fallbackText = String(err?.message ?? err ?? "");
  return { exitCode: status, stdout, stderr: stderrText || fallbackText };
}

function runBindingExplain(worktreePath, opts) {
  const execFn =
    typeof opts.bindingExecFn === "function"
      ? opts.bindingExecFn
      : execFileSync;
  const scriptPath = path.join(
    worktreePath,
    "scripts",
    "check",
    "review-approval-binding.mjs",
  );
  try {
    const stdout = execFn(
      "node",
      [scriptPath, "--explain", "--cwd", worktreePath],
      {
        encoding: "utf8",
      },
    );
    return { exitCode: 0, stdout: String(stdout ?? "") };
  } catch (err) {
    return bindingExplainErrorToResult(err);
  }
}

// review.md가 없는 워크트리는 조회조차 하지 않는다 -- 검토가 시작되지
// 않은/무관한 워크트리를 매 tick마다 스폰해 잡음을 만들 이유가 없다(§0
// 실측: 이 저장소의 정상 상태는 대부분의 워크트리가 review.md 없이 존재).
function judgeApprovalBindingForWorktree(worktreePath, opts) {
  const reviewPath = path.join(worktreePath, ".harness", "review.md");
  if (!existsSync(reviewPath)) {
    return {
      worktreePath,
      status: BINDING_WIRE_STATUS.JUDGED,
      verdict: BINDING_VERDICT.CLEAN,
    };
  }
  const r = runBindingExplain(worktreePath, opts);
  if (r.exitCode !== 0) {
    return {
      worktreePath,
      status: BINDING_WIRE_STATUS.QUERY_FAILED,
      reason: firstLine(r.stderr || r.stdout || `exit=${String(r.exitCode)}`),
    };
  }
  const judgementLine =
    r.stdout.split("\n").find((l) => l.startsWith("3)")) ?? "";
  const m = BINDING_JUDGEMENT_LINE_RE.exec(r.stdout);
  if (!m) {
    return {
      worktreePath,
      status: BINDING_WIRE_STATUS.QUERY_FAILED,
      reason: `--explain output did not match the expected format: ${firstLine(r.stdout)}`,
    };
  }
  // "판정 불가" contains a space, so the \S+ capture above only grabs
  // "판정" for it -- check the full line text instead of the capture group
  // for that one case.
  if (judgementLine.includes("판정 불가")) {
    return {
      worktreePath,
      status: BINDING_WIRE_STATUS.QUERY_FAILED,
      reason: firstLine(judgementLine),
    };
  }
  if (m[1] === "불일치") {
    return {
      worktreePath,
      status: BINDING_WIRE_STATUS.JUDGED,
      verdict: BINDING_VERDICT.MISMATCH,
      reason: firstLine(judgementLine),
    };
  }
  // "일치" or "결속 없음" -- see BINDING_VERDICT.CLEAN's honesty-limit note.
  return {
    worktreePath,
    status: BINDING_WIRE_STATUS.JUDGED,
    verdict: BINDING_VERDICT.CLEAN,
  };
}

function bindingSeverityOf(entry) {
  if (entry.status === BINDING_SCAN_FAILURE.WORKTREE_LIST_FAILED) return 2;
  if (entry.status === BINDING_WIRE_STATUS.QUERY_FAILED) return 1;
  if (
    entry.status === BINDING_WIRE_STATUS.JUDGED &&
    entry.verdict === BINDING_VERDICT.MISMATCH
  ) {
    return 3;
  }
  return 0;
}

export function judgeApprovalBindingAcrossWorktrees({ repoRoot }, opts = {}) {
  const list = collectGitWorktrees(repoRoot, opts);
  if (!list.ok) {
    return {
      status: BINDING_SCAN_FAILURE.WORKTREE_LIST_FAILED,
      detail: list.detail,
      worktrees: [],
      totalWorktrees: 0,
      worstCount: 1,
    };
  }
  const worktrees = list.worktrees.map((wt) =>
    judgeApprovalBindingForWorktree(wt, opts),
  );
  const worstSeverity = worktrees.reduce(
    (acc, w) => Math.max(acc, bindingSeverityOf(w)),
    0,
  );
  const worstEntries = worktrees.filter(
    (w) => bindingSeverityOf(w) === worstSeverity,
  );
  const worst = worstEntries[0] ?? null;
  return {
    status: worst ? worst.status : BINDING_WIRE_STATUS.JUDGED,
    verdict: worst ? worst.verdict : BINDING_VERDICT.CLEAN,
    reason: worst ? worst.reason : undefined,
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
// runOrchStallDetect에서 분리(max-lines-per-function 상한 준수). `ok:false`
// 는 `--pledges`를 줬는데 못 읽은 경우뿐이다(gap#61 -- "생략"과 "줬는데
// 못 읽음"을 구별, 헤더 주석 참조).
function resolveDeclaredPledges(cli) {
  if (!cli.pledgesPath) return { ok: true, pledges: [] };
  const loaded = readPledges(cli.pledgesPath);
  if (!loaded.ok) {
    return {
      ok: false,
      failure: {
        result: {
          ok: false,
          verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
          reasonCode: "PLEDGES_FILE_UNREADABLE",
          details: null,
        },
        exitCode: 3,
      },
    };
  }
  return { ok: true, pledges: loaded.pledges };
}

export function runOrchStallDetect(argv, opts = {}) {
  const cli = parseArgs(argv);
  const declaredResult = resolveDeclaredPledges(cli);
  if (!declaredResult.ok) return { ...declaredResult.failure, cli };
  const declaredPledges = declaredResult.pledges;
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
  // HYK-185 seat-scan/HYK-185-seat-idle-1/HYK-185-startcheck-wire: 좌석
  // 무응답·유휴 방치·«배달 후 시작됐는가» 판정을 이 저장소의 워크트리
  // 전부에 걸쳐 부른다(computeSeatAxes 참조).
  const { seatLiveness, seatIdle, dispatchStart } = computeSeatAxes(
    repoRoot,
    now,
    opts,
  );
  // HYK-185-unconsumed-1: «워커 결과가 갱신됐는데 소비되지 않았다» 판정도
  // 같은 워크트리 전부에 걸쳐 부른다. ★이 축은 좌석 관측이 아니라 파일/
  // git 관측만 쓰므로 computeSeatAxes(좌석 축 전용) 밖에 별도로 둔다.
  const unconsumed = judgeUnconsumedAcrossWorktrees({ repoRoot, now }, opts);
  // HYK-173-push-wire: escalation 축도 같은 진입점에서 실호출된다(§5-E --
  // 이 파일이 축의 조립 자리, watch-run.mjs는 옮겨 적기만 한다).
  const escalation = judgeEscalationForRepo({ repoRoot, now }, opts);
  // HYK-212-postcheck-1: «배달 직후 재조회 사후검증» 축도 같은 진입점에서
  // 조립된다 -- orca 재호출 0(영수증 파일만 읽는다), §2-3 부작용 0 계약
  // 유지.
  const postcheck = judgeDispatchPostcheckAcrossWorktrees({ repoRoot }, opts);
  // HYK-239-chain-wire-2: 원장 해시체인 위조 탐지 축도 같은 진입점에서
  // 조립된다(push 경로, §1). 언제나 맨 끝에 붙는다(§1 설계 제약 3 --
  // 기존 축의 필드·순서·값 불변).
  const chain = judgeChainIntegrityAcrossWorktrees({ repoRoot }, opts);
  // HYK-240 요건3: 승인<->코드지문 결속 위반 축도 같은 진입점에서
  // 조립된다(push 경로, coder-task.md §3 요건3). chain과 마찬가지로 언제나
  // 맨 끝에 붙는다(§1 설계 제약 3 -- 기존 축의 필드·순서·값 불변).
  const binding = judgeApprovalBindingAcrossWorktrees({ repoRoot }, opts);
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
      seatIdle,
      dispatchStart,
      unconsumed,
      escalation,
      postcheck,
      chain,
      binding,
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
