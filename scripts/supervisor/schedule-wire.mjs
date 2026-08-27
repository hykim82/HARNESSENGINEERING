// HYK-185 gap#69 (coder-task.md §5-D) -- 주기 실행 결선 CLI.
//
// 서브명령 `plan` / `register` / `unregister` / `status`. 계획 계산은
// schedule-plan-core.mjs(순수 함수)에 전부 위임한다 -- 이 파일은 인자
// 파싱과 (register/unregister에 한해) `schtasks` 실행만 한다.
//
// S11 필수(coder-task.md §5-E, 문구 그대로):
// 1. **증명한다**: 등록되면 이 감지는 ORCH 세션·에이전트와 무관하게 OS가
//    부른다.
// 2. **증명하지 않는다**: 이 조각만으로는 아무것도 돌지 않는다 -- 실제
//    등록은 사람 손이며(아래 ★비타협), 등록됐는지 여부는 저장소 밖이라
//    우리 기계 검사가 볼 수 없다.
// 3. **오탐이 나면**: 로그에 한 줄이 남을 뿐이고 알림은 없다(watch-run.mjs
//    의 책임 -- 이 CLI는 등록/해제/조회만 한다).
// 4. **자기 생존을 알리지 못하는 감시자는 감시자가 아니다** -- 그래서
//    `status` 서브명령이 있다(사람이 "감시자가 죽었는가"를 확인하는
//    수단).
// 5. **로그온했을 때만 돈다**(비밀번호를 저장하지 않기 위한 선택) --
//    로그아웃 상태에서는 감시가 없다.
//
// ★비타협(coder-task.md §2-1, §2-2): `register`/`unregister`는 **`--confirm`
// 이 없으면 계획만 출력하고 종료**한다(exit code로 "실행하지 않았음"을
// 알린다, 아래 `EXIT_CODE.NOT_EXECUTED`). `--confirm`이 있을 때에만 실제
// `schtasks`를 실행한다. 이 저장소의 어떤 코드도 `--confirm`을 스스로
// 붙여 자신을 호출하지 않는다(grep으로 확인 가능 -- 이 파일 자신을
// 제외하고 `--confirm`을 조립하는 코드 0건).
//
// Node 20 호환(ESM 표준 API만 사용).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildSchedulePlan, ACCOUNT_MODE } from "./schedule-plan-core.mjs";
import {
  judgeWatchFreshness,
  WATCH_FRESHNESS_VERDICT,
} from "./watch-freshness-core.mjs";

const winPath = path.win32;

export const EXIT_CODE = Object.freeze({
  OK: 0,
  INVALID_ARGUMENTS: 2,
  PLAN_REJECTED: 3,
  EXEC_FAILED: 4,
  NOT_EXECUTED: 10,
});

const DEFAULT_STALE_AFTER_SECONDS = 900; // 15분(등록 주기의 여러 배 -- 호출자가 --stale-after-s로 조정 가능).

const STRING_FLAGS = Object.freeze({
  "--repo-root": "repoRoot",
  "--node-path": "nodePath",
  "--watch-dir": "watchDir",
  // HYK-369 P2-1(검토 반려): conhost.exe 경로를 코드에 하드코딩하지
  // 않는다 -- 기본값은 실제 %SystemRoot%에서 유도하고(아래
  // defaultConhostPath), 시험/비표준 설치를 위해 오버라이드만 허용한다.
  "--conhost-path": "conhostPath",
  "--expires-at": "expiresAt",
  "--run-as-user": "runAsUser",
  "--account-mode": "accountMode",
  "--now": "now",
});
const NUMBER_FLAGS = Object.freeze({
  "--interval-minutes": "intervalMinutes",
  "--stale-after-s": "staleAfterSeconds",
});
const BOOLEAN_FLAGS = Object.freeze({
  "--json": "json",
  "--confirm": "confirm",
});

// HYK-369 P2-1: schtasks 자체가 Windows 전용이라 이 파일도 실질적으로
// Windows에서만 동작하지만(schedule-plan-core.mjs와 달리 이 파일은 I/O
// 담당이라 플랫폼 순수성 비타협이 없다), `%SystemRoot%`가 없는(=
// 비Windows) 환경에서도 예외 없이 값 하나를 반환한다 -- 실제로 쓰이지
// 않을 뿐 호출 자체가 죽지는 않는다.
function defaultConhostPath() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return winPath.join(systemRoot, "System32", "conhost.exe");
}

// HYK-369 6R(CI 반려 수리): `checkConhostExists`의 기본 `existsFn`을 그냥
// `existsSync`로 두면, 비Windows에서 실제로 존재할 수 없는 win32 형태의
// 기본 경로(`defaultConhostPath()`가 항상 만드는 문자열)를 실 파일시스템에
// 대고 검사하게 된다 -- `conhost.exe`는 개념 자체가 Windows 전용이라 이
// 검사는 비Windows에서 "그 경로가 실제로 있는가"를 재는 게 아니라
// "Windows 스타일 문자열이 우연히 이 파일시스템의 실재 경로와 겹치는가"
// (항상 아니오)를 재는 것이다 -- 그래서 `--conhost-path`를 아무도 손대지
// 않은 순수 dry-run(plan/register 도움말성 시험들)까지도 비Windows에서
// 무조건 PLAN_REJECTED(CONHOST_NOT_FOUND)로 떨어뜨린다(CI ubuntu-latest에서
// 재현: PR #216, `not ok 4844`~`4847`/`4855` — 로컬 Windows에선 기본 경로가
// 실재해 통과했었다). `--conhost-path`를 **명시로 오버라이드**했을 때는
// 여전히(어느 플랫폼이든) 주입된 `existsFn`을 그대로 쓴다 -- 그건 실
// 파일시스템과 무관한 순수 로직 시험(P2-1)이라 이 분기와 무관하다. Windows
// 기본 동작은 그대로(`existsSync`) 유지 -- 로컬 초록 회귀 0.
function defaultExistsFn() {
  return process.platform === "win32" ? existsSync : () => true;
}

function parseCommonArgs(argv) {
  const parsed = {
    repoRoot: null,
    nodePath: process.execPath,
    watchDir: null,
    conhostPath: defaultConhostPath(),
    intervalMinutes: null,
    expiresAt: null,
    runAsUser: null,
    accountMode: ACCOUNT_MODE.LOGON_ONLY,
    now: null,
    json: false,
    confirm: false,
    staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in BOOLEAN_FLAGS) {
      parsed[BOOLEAN_FLAGS[a]] = true;
    } else if (a in STRING_FLAGS) {
      parsed[STRING_FLAGS[a]] = argv[++i] ?? null;
    } else if (a in NUMBER_FLAGS) {
      parsed[NUMBER_FLAGS[a]] = Number(argv[++i]);
    }
  }
  return parsed;
}

function resolveNow(cli) {
  if (!cli.now) return Date.now();
  const ms = Date.parse(cli.now);
  return Number.isNaN(ms) ? NaN : ms;
}

function planFromCli(cli) {
  const now = resolveNow(cli);
  return buildSchedulePlan({
    repoRoot: cli.repoRoot,
    nodePath: cli.nodePath,
    watchDir: cli.watchDir,
    conhostPath: cli.conhostPath,
    intervalMinutes: cli.intervalMinutes,
    expiresAt: cli.expiresAt,
    accountMode: cli.accountMode,
    runAsUser: cli.runAsUser,
    now,
  });
}

function formatPlanOutput(built, cli) {
  if (!built.ok) {
    return {
      output: `PLAN_REJECTED (${built.reasonCode})`,
      exitCode: EXIT_CODE.PLAN_REJECTED,
    };
  }
  const output = cli.json
    ? JSON.stringify(built.plan)
    : built.plan.humanSummary;
  return { output, exitCode: EXIT_CODE.OK };
}

// HYK-369 P2-1(2R 검토 반려, 3R 처리) -- `schedule-plan-core.mjs`는 "I/O
// 0" 순수 함수 계약이 있어(파일 존재 확인은 fs 호출이라 그 계약을 깬다)
// `conhostPath`가 실제로 존재하는지 검증할 수 없다 -- 그래서 여기(이미
// fs/child_process를 다루는 결선 계층)에 둔다. 기본값(%SystemRoot%\
// System32\conhost.exe)은 거의 항상 존재하지만, `--conhost-path`로
// 명시 오버라이드했을 때(검토자 재현: 존재하지 않는 경로)는 계획 단계
// (사람이 dry-run으로 미리 보는 시점)에서 바로 잡아 준다 -- 예약 등록
// 뒤에야 조용히 실패하는 것보다 이쪽이 사람에게 더 이르고 시끄럽다.
function checkConhostExists(cli, existsFn) {
  if (existsFn(cli.conhostPath)) return null;
  return {
    output: `PLAN_REJECTED (CONHOST_NOT_FOUND: ${cli.conhostPath})`,
    exitCode: EXIT_CODE.PLAN_REJECTED,
  };
}

function runPlan(cli, existsFn) {
  const built = planFromCli(cli);
  if (built.ok) {
    const conhostRejection = checkConhostExists(cli, existsFn);
    if (conhostRejection) return conhostRejection;
  }
  return formatPlanOutput(built, cli);
}

// register/unregister 공용 -- `--confirm` 없으면 계획만 출력하고 종료
// (★mutation #1 표적: 아래 `if (!cli.confirm)` 가드가 이 파일의 핵심
// 안전 장치다).
function runRegisterOrUnregister(cli, kind, exec, existsFn) {
  const built = planFromCli(cli);
  if (!built.ok) {
    return {
      output: `PLAN_REJECTED (${built.reasonCode})`,
      exitCode: EXIT_CODE.PLAN_REJECTED,
    };
  }
  const conhostRejection = checkConhostExists(cli, existsFn);
  if (conhostRejection) return conhostRejection;
  const args =
    kind === "register" ? built.plan.registerArgs : built.plan.unregisterArgs;
  if (!cli.confirm) {
    return {
      output: `DRY_RUN(${kind}): --confirm 없이는 실행하지 않는다.\nschtasks ${args.join(" ")}\n\n${built.plan.humanSummary}`,
      exitCode: EXIT_CODE.NOT_EXECUTED,
    };
  }
  try {
    const stdout = exec("schtasks", args, { encoding: "utf8" });
    return { output: stdout, exitCode: EXIT_CODE.OK };
  } catch (err) {
    return {
      output: `EXEC_FAILED: ${err && err.message ? err.message : String(err)}`,
      exitCode: EXIT_CODE.EXEC_FAILED,
    };
  }
}

function runStatus(cli, readFn) {
  const now = resolveNow(cli);
  if (Number.isNaN(now) || !cli.watchDir) {
    return {
      output: "INVALID_ARGUMENTS",
      exitCode: EXIT_CODE.INVALID_ARGUMENTS,
    };
  }
  const aliveRecordPath = path.join(cli.watchDir, "last-run.json");
  let lastRun;
  try {
    lastRun = JSON.parse(readFn(aliveRecordPath, "utf8"));
  } catch {
    lastRun = null; // 결손·형식위반 둘 다 judgeWatchFreshness가 UNKNOWN으로 접는다.
  }
  const result = judgeWatchFreshness({
    lastRun,
    now,
    staleAfterSeconds: cli.staleAfterSeconds,
  });
  const exitCode =
    result.verdict === WATCH_FRESHNESS_VERDICT.ALIVE
      ? EXIT_CODE.OK
      : EXIT_CODE.PLAN_REJECTED;
  const output = cli.json
    ? JSON.stringify(result)
    : `${result.verdict} (${result.reasonCode})`;
  return { output, exitCode };
}

// runScheduleWire(argv, deps) -> {output, exitCode} -- CLI 몸통. I/O는
// deps로 주입 가능(시험이 실제 schtasks/fs를 건드리지 않게).
export function runScheduleWire(argv, deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const readFn = deps.readFn ?? readFileSync;
  const existsFn = deps.existsFn ?? defaultExistsFn();
  const [sub, ...rest] = argv;
  const cli = parseCommonArgs(rest);
  if (sub === "plan") return runPlan(cli, existsFn);
  if (sub === "register")
    return runRegisterOrUnregister(cli, "register", exec, existsFn);
  if (sub === "unregister")
    return runRegisterOrUnregister(cli, "unregister", exec, existsFn);
  if (sub === "status") return runStatus(cli, readFn);
  return {
    output: `UNKNOWN_SUBCOMMAND: ${sub}`,
    exitCode: EXIT_CODE.INVALID_ARGUMENTS,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/schedule-wire.mjs");
if (invokedDirectly) {
  const { output, exitCode } = runScheduleWire(process.argv.slice(2));
  console.log(output);
  process.exit(exitCode);
}
