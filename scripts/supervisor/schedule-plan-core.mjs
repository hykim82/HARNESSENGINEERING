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

function validatePaths({ repoRoot, nodePath, watchDir, runAsUser }) {
  if (!isNonEmptyString(repoRoot) || !winPath.isAbsolute(repoRoot)) {
    return SCHEDULE_PLAN_REASON.REPO_ROOT_INVALID;
  }
  if (!isNonEmptyString(nodePath) || !winPath.isAbsolute(nodePath)) {
    return SCHEDULE_PLAN_REASON.NODE_PATH_INVALID;
  }
  if (!isNonEmptyString(watchDir) || !winPath.isAbsolute(watchDir)) {
    return SCHEDULE_PLAN_REASON.WATCH_DIR_INVALID;
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

function buildCommandLine(nodePath, runnerPath, repoRoot, watchDir) {
  return `"${nodePath}" "${runnerPath}" --repo-root "${repoRoot}" --watch-dir "${watchDir}"`;
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

// buildSchedulePlan({repoRoot, nodePath, watchDir, intervalMinutes,
// expiresAt, accountMode, runAsUser, now}) -> {ok, plan, reasonCode}
export function buildSchedulePlan(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return fail(SCHEDULE_PLAN_REASON.INVALID_ARGUMENTS);
  }
  const {
    repoRoot,
    nodePath,
    watchDir,
    intervalMinutes,
    expiresAt,
    accountMode,
    runAsUser,
    now,
  } = args;
  if (!isFiniteNumber(now)) return fail(SCHEDULE_PLAN_REASON.NOW_INVALID);

  const pathReason = validatePaths({ repoRoot, nodePath, watchDir, runAsUser });
  if (pathReason) return fail(pathReason);

  const intervalReason = validateInterval(intervalMinutes);
  if (intervalReason) return fail(intervalReason);

  const accountReason = validateAccountMode(accountMode);
  if (accountReason) return fail(accountReason);

  const expires = validateExpiresAt(expiresAt, now);
  if (expires.code) return fail(expires.code);

  const runnerPath = winPath.join(
    repoRoot,
    "scripts",
    "supervisor",
    "watch-run.mjs",
  );
  const logPath = winPath.join(watchDir, "watch.log");
  const aliveRecordPath = winPath.join(watchDir, "last-run.json");
  const expiresAtDate = toSchtasksDate(expires.ms);
  const commandLine = buildCommandLine(
    nodePath,
    runnerPath,
    repoRoot,
    watchDir,
  );

  const registerArgs = buildRegisterArgs({
    intervalMinutes,
    commandLine,
    runAsUser,
    expiresAtDate,
  });
  const unregisterArgs = ["/Delete", "/TN", TASK_NAME, "/F"];

  const plan = {
    taskName: TASK_NAME,
    runnerPath,
    commandLine,
    intervalMinutes,
    accountMode,
    runAsUser,
    passwordStored: false,
    expiresAt: new Date(expires.ms).toISOString(),
    logPath,
    aliveRecordPath,
    registerArgs,
    unregisterArgs,
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
