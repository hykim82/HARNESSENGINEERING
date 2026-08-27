// HYK-185 gap#69 (coder-task.md §5-A) -- 주기 실행 계획 순수 함수 코어.
//
// 배경(coder-task.md §1): gap#68까지는 "부를 수 있는" 진입점(orch-stall-
// detect.mjs)만 있었고, 그것을 OS 스케줄러에 실제로 등록해 주기적으로
// 부르는 결선이 없었다. 이 파일은 그 등록에 **필요한 계획**만 계산한다
// -- 등록 자체는 하지 않는다(등록 실행은 schedule-wire.mjs의 몫이며,
// 그 실행조차 사람 손 `--confirm` 없이는 일어나지 않는다, coder-task.md
// §2-2).
//
// S11 필수 5가지 (coder-task.md §5-E, 문구 그대로):
// 1. **증명한다**: 등록되면 이 감지는 ORCH 세션·에이전트와 무관하게 OS가
//    부른다(등록물은 `schtasks`가 관리하는 OS 스케줄러 항목이며, 어떤
//    Claude 훅·Orca API도 그 발화 경로에 없다).
// 2. **증명하지 않는다**: 이 조각만으로는 아무것도 돌지 않는다 -- 실제
//    등록은 사람 손이며, 등록됐는지 여부는 저장소 밖이라 우리 기계
//    검사가 볼 수 없다.
// 3. **오탐이 나면**: 로그에 한 줄이 남을 뿐이고 알림은 없다. 이유 =
//    시끄러운 감시는 꺼지게 되고, 꺼진 감시는 없는 것과 같다(오탐 처리
//    자체는 watch-run.mjs의 몫이며, 계획에는 알림 채널이 아예 없다).
// 4. **자기 생존을 알리지 못하는 감시자는 감시자가 아니다** -- 그래서
//    이 계획은 항상 생존 기록 경로(aliveRecordPath)를 포함한다. 단
//    "감시자의 감시자" 문제는 남는다.
// 5. **로그온했을 때만 돈다**(비밀번호를 저장하지 않기 위한 선택) --
//    로그아웃 상태에서는 감시가 없다. 이 코어는 그 밖의 실행 계정 방식을
//    **거부**하며, 다른 방식을 위한 코드 경로를 아예 만들지 않는다
//    (한용 확정 (가), coder-task.md §1).
//
// 비타협(coder-task.md §2, §3-a):
// - I/O 0 -- fs·child_process·네트워크·`orca` 호출 0. 이 코어는 문자열과
//   숫자만 조합해 계획 객체를 만든다. 현재 시각도 `now` 인자로만 받는다
//   (`Date.now()`/`new Date()`(인자 없이) 호출 0).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, plan, reasonCode}`를 반환한다.
// - `accountMode`는 `ACCOUNT_MODE.LOGON_ONLY`만 허용한다(그 밖의 값은
//   거부) -- 비밀번호 저장 경로를 코드가 아예 만들지 않는다.
// - `expiresAt`은 **필수**다(없으면 거부) -- "무기한 등록"을 만들 수
//   없게 한다(한용 확정 (다), 7일 자동 만료는 호출자가 `expiresAt`을
//   `now + 7일`로 계산해 넘기는 관례로 지킨다 -- 이 코어는 7일이라는
//   숫자를 하드코딩하지 않는다).
//
// 어휘 신규 도입 선언: `ACCOUNT_MODE`·`SCHEDULE_PLAN_REASON` 둘 다 이
// 파일이 새로 만든다.
//
// ★플랫폼 독립 선언(재작업 2R, coder-task.md §11 -- 리눅스 CI가 실제로
// 이 차이를 드러냄): 이 조각은 **Windows 작업 스케줄러(`schtasks`) 전용**
// 이며, `repoRoot`/`nodePath`/`watchDir`는 항상 Windows 경로다(예:
// `C:\Users\...`). `node:path`의 "네이티브"(호스트 OS에 따라 자동으로
// posix/win32가 바뀌는) `isAbsolute`/`join`을 쓰면 **리눅스에서 실행될
// 때 그 판정이 달라진다**(`path.isAbsolute("C:\\Users\\x")`가 리눅스
// 에서는 posix 규칙으로 `false`가 되어 유효한 Windows 경로를 거부한다
// -- 실측: `node -e` 직접 확인, 이 파일의 시험 파일에도 고정 단언으로
// 남긴다). 그래서 이 코어는 **항상 `path.win32`만** 쓴다 -- `path.win32`
// 는 정적으로 Windows 규칙을 구현하며 호스트 OS를 보지 않으므로, 이
// 코어는 **어느 플랫폼에서 시험하든 같은 결과**를 낸다.
import path from "node:path";
const winPath = path.win32;

export const ACCOUNT_MODE = Object.freeze({
  // "사용자가 로그온했을 때만 실행" -- schtasks `/IT` + `/RU <user>`,
  // `/RP` 없음(비밀번호 미저장). 실측 근거는 schedule-wire.mjs 헤더 및
  // `.harness/coder.md` §schtasks 인자 표 참조.
  LOGON_ONLY: "LOGON_ONLY",
});

export const SCHEDULE_PLAN_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  REPO_ROOT_INVALID: "REPO_ROOT_INVALID",
  NODE_PATH_INVALID: "NODE_PATH_INVALID",
  WATCH_DIR_INVALID: "WATCH_DIR_INVALID",
  CONHOST_PATH_INVALID: "CONHOST_PATH_INVALID",
  EXTRA_RUNNER_ARGS_INVALID: "EXTRA_RUNNER_ARGS_INVALID",
  RUN_AS_USER_INVALID: "RUN_AS_USER_INVALID",
  INTERVAL_MINUTES_INVALID: "INTERVAL_MINUTES_INVALID",
  ACCOUNT_MODE_INVALID: "ACCOUNT_MODE_INVALID",
  EXPIRES_AT_REQUIRED: "EXPIRES_AT_REQUIRED",
  EXPIRES_AT_UNPARSEABLE: "EXPIRES_AT_UNPARSEABLE",
  EXPIRES_AT_NOT_IN_FUTURE: "EXPIRES_AT_NOT_IN_FUTURE",
  NOW_INVALID: "NOW_INVALID",
  PLANNED: "PLANNED",
});

// schtasks 실측(coder-task.md §6-1, `.harness/coder.md` 표 참조): `/MO`
// (MINUTE 스케줄 타입)의 유효 범위는 "1 - 1439 minutes"이다.
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1439;

// `schtasks /TN` 값 -- 이 감시자 하나만 등록하는 고정 이름(path\name
// 형식, 실재 인자 표에 있는 형식 그대로).
export const TASK_NAME = "HARNESS\\OrchStallWatch";

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function fail(reasonCode) {
  return { ok: false, plan: null, reasonCode };
}

function validatePaths({
  repoRoot,
  nodePath,
  watchDir,
  conhostPath,
  runAsUser,
}) {
  if (!isNonEmptyString(repoRoot) || !winPath.isAbsolute(repoRoot)) {
    return SCHEDULE_PLAN_REASON.REPO_ROOT_INVALID;
  }
  if (!isNonEmptyString(nodePath) || !winPath.isAbsolute(nodePath)) {
    return SCHEDULE_PLAN_REASON.NODE_PATH_INVALID;
  }
  if (!isNonEmptyString(watchDir) || !winPath.isAbsolute(watchDir)) {
    return SCHEDULE_PLAN_REASON.WATCH_DIR_INVALID;
  }
  // HYK-369 P2-1(검토 반려): 이전엔 이 함수가 "C:\Windows\System32\
  // conhost.exe"를 리터럴로 하드코딩했다 -- 이 코어의 다른 모든 경로는
  // 인자인데 이것만 아니었다. 이제 호출자(schedule-wire.mjs, I/O를 이미
  // 담당하는 결선 계층)가 실제 `%SystemRoot%`로 이 경로를 만들어 넘기고,
  // 이 순수 코어는 "비어있지 않은 절대 win32 경로인가"만 검증한다 --
  // conhost.exe가 실제로 그 자리에 있는지(fs 접근)는 여전히 이 코어의
  // 일이 아니다("I/O 0" 비타협 그대로).
  if (!isNonEmptyString(conhostPath) || !winPath.isAbsolute(conhostPath)) {
    return SCHEDULE_PLAN_REASON.CONHOST_PATH_INVALID;
  }
  if (!isNonEmptyString(runAsUser)) {
    return SCHEDULE_PLAN_REASON.RUN_AS_USER_INVALID;
  }
  return null;
}

function validateInterval(intervalMinutes) {
  if (
    !isFiniteNumber(intervalMinutes) ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < MIN_INTERVAL_MINUTES ||
    intervalMinutes > MAX_INTERVAL_MINUTES
  ) {
    return SCHEDULE_PLAN_REASON.INTERVAL_MINUTES_INVALID;
  }
  return null;
}

// HYK-369 P1-1(검토 반려): 재등록 계획이 라이브 작업의 `--wake
// --admission-sweep-ledger … --wake-live` 같은 watch-run.mjs 각성/sweep
// CLI 인자를 보존하지 못해, 코드 경로로 재등록하면 그 인자들이 조용히
// 사라지는(각성이 꺼지는) 회귀였다. 이제 호출자가 라이브 인자를 그대로
// `extraRunnerArgs`로 넘기면 이 코어가 `/TR`에 그대로 이어붙인다 --
// 이름을 알아야 하는 개별 플래그로 하드코딩하지 않는다(watch-run.mjs가
// 새 플래그를 얻어도 이 코어를 다시 고칠 필요가 없다).
function validateExtraRunnerArgs(extraRunnerArgs) {
  if (extraRunnerArgs === undefined) return null; // 기본값 []는 buildSchedulePlan에서 채운다.
  if (!Array.isArray(extraRunnerArgs)) {
    return SCHEDULE_PLAN_REASON.EXTRA_RUNNER_ARGS_INVALID;
  }
  if (!extraRunnerArgs.every((a) => typeof a === "string")) {
    return SCHEDULE_PLAN_REASON.EXTRA_RUNNER_ARGS_INVALID;
  }
  return null;
}

// ★mutation #3(coder-task.md §5-F) 표적 -- 이 검사가 없으면 비밀번호
// 저장 방식(그 밖의 accountMode 값)이 그대로 통과한다.
function validateAccountMode(accountMode) {
  if (accountMode !== ACCOUNT_MODE.LOGON_ONLY) {
    return SCHEDULE_PLAN_REASON.ACCOUNT_MODE_INVALID;
  }
  return null;
}

// ★mutation #2(coder-task.md §5-F) 표적 -- 이 검사가 없으면 만료 없는
// (무기한) 등록 계획이 만들어진다.
function validateExpiresAt(expiresAt, now) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === "") {
    return { code: SCHEDULE_PLAN_REASON.EXPIRES_AT_REQUIRED, ms: null };
  }
  if (!isNonEmptyString(expiresAt)) {
    return { code: SCHEDULE_PLAN_REASON.EXPIRES_AT_UNPARSEABLE, ms: null };
  }
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) {
    return { code: SCHEDULE_PLAN_REASON.EXPIRES_AT_UNPARSEABLE, ms: null };
  }
  if (ms <= now) {
    return { code: SCHEDULE_PLAN_REASON.EXPIRES_AT_NOT_IN_FUTURE, ms: null };
  }
  return { code: null, ms };
}

function toSchtasksDate(ms) {
  // yyyy/mm/dd(schtasks `/ED` 실재 형식, 읽기 전용 도움말로 확인).
  // UTC 컴포넌트만 쓴다 -- 로컬 타임존을 읽지 않아 결정적이다.
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "/");
}

// HYK-369 (coder-task.md, ORCH 실측 -- 등록된 태스크의 `/TR`/`Execute`가
// 한용이 보고한 창 제목("C:\Program Files\nodejs\node.exe")과 글자 그대로
// 일치했다): `/IT`(대화형 세션)로 등록된 이 태스크가 콘솔 서브시스템
// 실행파일(node.exe)을 직접 `/TR`로 실행하면, Task Scheduler 가 이
// 프로세스를 콘솔 없는 컨텍스트에서 만들고 Windows 는 그 콘솔 호스팅을
// (이 기계처럼 Windows Terminal 이 기본 터미널일 때) 이미 떠 있는
// WindowsTerminal.exe 의 새 탭으로 넘긴다("터미널 핸드오프") -- 그 결과
// 이 태스크가 돌 때마다 사람 화면에 새 터미널 창이 나타난다.
//
// 고정: `/TR` 실행 대상을 `conhost.exe --headless -- <원래 커맨드라인>`
// 으로 감싼다. `conhost --headless` 는 Windows 가 기본 제공하는, 콘솔을
// **창 없이** 호스팅하는 표준 모드다(OpenSSH 서버 등이 이미 이 용도로
// 쓴다) -- node.exe 는 여전히 완전한 콘솔(표준 입출력 핸들)을 갖고 실행
// 되므로 코드 동작(watch.log/last-run.json 파일 쓰기, orca CLI 자식
// 호출 등)은 그대로다. `/IT`(대화형 세션 유지)와 `/RU`(실행 계정)는
// 손대지 않는다 -- 이 창-숨김은 오직 콘솔 "호스팅 방식"만 바꾼다.
//
// 재현 검증(HYK-369 coder.md §1-6, 2R §2): `.harness/repro/ConsoleRepro.cs`
// 헬퍼(콘솔 없는 조상을 raw CreateProcess로 시뮬레이션 -- 예약 작업의
// 실제 조건과 같다, bInheritHandles=false)로 정확히 이 커맨드라인
// 형태를 실행해 `top_level_window_count_delta=0`(창 0개, 시작~자연 종료
// 전 구간 전부)과 `watch.log`/`last-run.json` 정상 생성을 **함께**
// 확인했다.
//
// ★2R 정정(검토 P1-2 관련): 검토자는 "정확히 이 명령을 직접 돌리면
// exit 0인데 watch.log/last-run.json 둘 다 안 만들어진다"고 반려했다.
// 재현했다 -- 그러나 원인은 이 코드가 아니라 **검토자(그리고 CODER 1R
// 자신도)가 그 명령을 검증한 방식**이었다: Node의 child_process(
// spawn/execFileSync, stdio·windowsHide·detached·shell 옵션과 무관하게
// 전부)와 상호작용 콘솔에 직접 타이핑하는 방식은 둘 다 이 명령의 호출자
// 프로세스에 **상속 가능한 콘솔 핸들**을 쥐어 준 채로 `conhost.exe
// --headless`를 만든다 -- `conhost --headless`는 그 상속된 핸들과
// 충돌해 조용히 자식을 못 돌린다(관측: exit 0, 파일 0개, 재현
// 4가지 변형 전부 동일). 반면 **핸들을 상속하지 않는** 호출(.NET
// `Process.Start`를 리다이렉션 없이 쓰거나, 예약 작업이 실제로 쓰는
// raw `CreateProcess`)에서는 콘솔 존재 여부와 무관하게 **항상 성공**
// 했다 -- 콘솔 있는 호출자에서도, 콘솔 없는 호출자에서도. 예약 작업은
// 셸도 없고 상속할 콘솔 핸들 자체가 없으므로 이 실패 모드의 전제
// 조건과 만나지 않는다. coder.md 2R §2 의 2×2×2 원문에 모든 조합의
// exit/파일 유무가 있다.
function buildCommandLine(
  conhostPath,
  nodePath,
  runnerPath,
  repoRoot,
  watchDir,
  extraRunnerArgs,
) {
  const extra = extraRunnerArgs.map((a) => `"${a}"`).join(" ");
  return (
    `"${conhostPath}" --headless -- ` +
    `"${nodePath}" "${runnerPath}" --repo-root "${repoRoot}" --watch-dir "${watchDir}"` +
    (extra ? ` ${extra}` : "")
  );
}

// schtasks 실측 표(coder-task.md §6-1) 그대로 -- `/RU` + `/IT`(비밀번호
// 미저장, 로그온했을 때만 실행) + `/ED`(만료).
function buildRegisterArgs({
  intervalMinutes,
  commandLine,
  runAsUser,
  expiresAtDate,
}) {
  return [
    "/Create",
    "/SC",
    "MINUTE",
    "/MO",
    String(intervalMinutes),
    "/TN",
    TASK_NAME,
    "/TR",
    commandLine,
    "/RU",
    runAsUser,
    "/IT",
    "/ED",
    expiresAtDate,
    "/F",
  ];
}

// buildSchedulePlan({repoRoot, nodePath, watchDir, conhostPath,
// extraRunnerArgs, intervalMinutes, expiresAt, accountMode, runAsUser,
// now}) -> {ok, plan, reasonCode}. `conhostPath`는 호출자가 실제
// `%SystemRoot%\System32\conhost.exe`를 조립해 넘긴다(P2-1 수리 -- 이
// 코어는 하드코딩하지 않는다). `extraRunnerArgs`는 라이브 작업이
// 이미 쓰는 `--wake`/`--admission-sweep-*`류 watch-run.mjs 인자를
// 재등록 시에도 보존하기 위한 통로다(P1-1 수리, 생략 시 기본 `[]`).
// 위에서 아래로: 인자 하나가 잘못되면 그 자리에서 바로 reasonCode를
// 반환한다(early-return fail-closed) -- buildSchedulePlan 자체를 80줄
// 아래로 유지하기 위해 검증 단계만 여기 모았다(순서·의미는 그대로).
function validateAllArgs({
  repoRoot,
  nodePath,
  watchDir,
  conhostPath,
  extraRunnerArgs,
  intervalMinutes,
  expiresAt,
  accountMode,
  runAsUser,
  now,
}) {
  if (!isFiniteNumber(now)) return { code: SCHEDULE_PLAN_REASON.NOW_INVALID };

  const pathReason = validatePaths({
    repoRoot,
    nodePath,
    watchDir,
    conhostPath,
    runAsUser,
  });
  if (pathReason) return { code: pathReason };

  const extraArgsReason = validateExtraRunnerArgs(extraRunnerArgs);
  if (extraArgsReason) return { code: extraArgsReason };

  const intervalReason = validateInterval(intervalMinutes);
  if (intervalReason) return { code: intervalReason };

  const accountReason = validateAccountMode(accountMode);
  if (accountReason) return { code: accountReason };

  const expires = validateExpiresAt(expiresAt, now);
  if (expires.code) return { code: expires.code };

  return { code: null, expiresMs: expires.ms };
}

// 검증을 전부 통과한 뒤 계획 객체를 조립한다(순수 조립, 검증 없음).
function assemblePlan({
  repoRoot,
  nodePath,
  watchDir,
  conhostPath,
  extraRunnerArgs,
  intervalMinutes,
  accountMode,
  runAsUser,
  expiresMs,
}) {
  const runnerPath = winPath.join(
    repoRoot,
    "scripts",
    "supervisor",
    "watch-run.mjs",
  );
  const logPath = winPath.join(watchDir, "watch.log");
  const aliveRecordPath = winPath.join(watchDir, "last-run.json");
  const expiresAtDate = toSchtasksDate(expiresMs);
  const commandLine = buildCommandLine(
    conhostPath,
    nodePath,
    runnerPath,
    repoRoot,
    watchDir,
    extraRunnerArgs ?? [],
  );
  const registerArgs = buildRegisterArgs({
    intervalMinutes,
    commandLine,
    runAsUser,
    expiresAtDate,
  });

  return {
    taskName: TASK_NAME,
    runnerPath,
    commandLine,
    intervalMinutes,
    accountMode,
    runAsUser,
    passwordStored: false,
    expiresAt: new Date(expiresMs).toISOString(),
    logPath,
    aliveRecordPath,
    registerArgs,
    unregisterArgs: ["/Delete", "/TN", TASK_NAME, "/F"],
    humanSummary: buildHumanSummary({
      taskName: TASK_NAME,
      commandLine,
      intervalMinutes,
      runAsUser,
      expiresAtDate,
      logPath,
      aliveRecordPath,
    }),
  };
}

export function buildSchedulePlan(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return fail(SCHEDULE_PLAN_REASON.INVALID_ARGUMENTS);
  }
  const validated = validateAllArgs(args);
  if (validated.code) return fail(validated.code);

  const plan = assemblePlan({ ...args, expiresMs: validated.expiresMs });
  return { ok: true, plan, reasonCode: SCHEDULE_PLAN_REASON.PLANNED };
}

// §3-c 요구 항목 전부(작업 이름·실행 명령·주기·실행 계정 방식·만료
// 시점·로그·생존 기록 경로·해제 방법)를 사람이 읽을 수 있게 나열한다.
function buildHumanSummary({
  taskName,
  commandLine,
  intervalMinutes,
  runAsUser,
  expiresAtDate,
  logPath,
  aliveRecordPath,
}) {
  return [
    `작업 이름: ${taskName}`,
    `실행 명령: ${commandLine}`,
    `주기: ${intervalMinutes}분마다(MINUTE)`,
    `실행 계정: ${runAsUser} -- 로그온했을 때만 실행(/IT), 비밀번호 미저장`,
    `만료: ${expiresAtDate}(이후 스케줄러가 자동으로 실행하지 않음)`,
    `로그 경로: ${logPath}`,
    `생존 기록 경로: ${aliveRecordPath}`,
    `해제 방법: schtasks /Delete /TN "${taskName}" /F(schedule-wire.mjs unregister --confirm)`,
    `등록·해제 모두 드라이런이 기본이며, --confirm 없이는 시스템을 건드리지 않는다.`,
  ].join("\n");
}
