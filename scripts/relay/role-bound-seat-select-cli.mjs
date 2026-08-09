import {
  resolveRoleBoundSeatHandle,
  createOrcaExecFn,
} from "./adapters/orca-adapter.mjs";

// HYK-211-seat-select coder-1/2/3 (coder-task.md §4, "1-B 세 요건"): 사람이
// 직접 칠 수 있는 실행 한 줄 -- 동석(CODER+REVIEW 등) 상황에서 "어느
// 좌석이 어떤 역할로 판별됐는지"를 눈으로 확인하기 위한 진입점이다.
//
//   node scripts/relay/role-bound-seat-select-cli.mjs --role CODER --worktree "<경로>" --registry "<대장 json 경로>"
//
// 요건2(그때 무엇이 보여야 하는가): 고른 handle, 또는 왜 거부했는지(사유
// 코드) -- **그리고 후보 전원의 handle -> 판별된 역할 매핑**
// (coder-task.md HYK-211-seat-select-2 §2-3 P2-3). 아래
// formatRoleBoundSeatSelectResult가 두 경우 모두 stdout에 사람이 읽을 수
// 있는 한 줄로 찍는다.
// 요건3(도달 경로): 사람이 직접 부르는 도구라 도달 경로 = 이 stdout 출력
// 자체다(별도 알림 채널 없음 -- 요건2의 출력이 곧 도달이다).
//
// G9: `orca` CLI를 spawn하는 유일한 지점은 orca-adapter.mjs의
// createOrcaExecFn이다 -- 이 파일은 그것을 그대로 가져다 쓸 뿐, 직접
// spawn하지 않는다(orca-cli-boundary.mjs가 이걸 정적으로 검사한다).
//
// ---- HYK-211-seat-select-2 §2-2 P1-2 수리 (3R에서도 유지) ----
// direct-entry는 runRoleBoundSeatSelectCli를 그대로 부른다 -- 경로가
// 하나뿐이라 export 시험이 곧 direct-entry 시험이다.
// role-bound-seat-select-cli.test.mjs가 **자식 프로세스로 이 파일을
// 실행**해 stdout/종료코드를 단언함으로써 증명한다.
//
// ---- ★HYK-211-seat-select-3 (§1~§3, 2R P1 반려 수리): 시험용 뒷문 제거 ----
// 2R은 `ROLE_BOUND_SEAT_SELECT_FIXTURE` 환경변수로 direct-entry가 가짜
// execFn을 쓰게 하는 seam을 넣었다 -- 검토자 반려: "그 변수가 없으면
// createOrcaExecFn() 그대로"였지만, **설정하면 실제 좌석 조회를 통째로
// 갈아치울 수 있는 프로덕션 우회로**였다(NODE_ENV=test 같은 단일 게이트도
// 없었다) -- "엉뚱한 좌석으로 배달되는 것을 막으려는 코드 안에 그 판단의
// 입력을 통째로 갈아치울 수 있는 문을 낸" 모순.
//
// **한용이 승인한 범위(ⓑ 권장, coder-task.md §3): 통로를 아예 없앤다.**
// 이 파일은 이제 환경변수를 하나도 읽지 않는다(`process.env` 참조 0 --
// orca-cli-boundary.mjs 전례처럼 이 사실 자체를 grep으로도 확인 가능하고,
// role-bound-seat-select-cli.test.mjs의 정적 시험이 그 grep을 고정한다).
// direct-entry는 **항상** `createOrcaExecFn()`(실 `orca` spawn)을 쓴다 --
// 조건 분기 자체가 없다.
//
// **시험은 프로그램 밖에서 환경을 제어한다**(§3 ⓑ 요구 그대로): 자식
// 프로세스로 이 파일을 구동하는 시험은 `node --require <preload.cjs>
// role-bound-seat-select-cli.mjs ...`로 실행하고, 그 preload가
// `node:child_process`의 `spawnSync`를 이 파일이 로드되기 *전에*
// monkeypatch한다 -- `createOrcaExecFn`이 호출 시점에 그 patched
// `spawnSync`를 그대로 쓰게 된다(§0 실측: Windows에서는 PATH 앞에 가짜
// `orca` 실행 파일/스크립트를 두는 방식이 Node 26의 `spawnSync(...,
// {shell:false})`에서 `.cmd`/`.bat`를 더 이상 자동 실행하지 않아 동작하지
// 않음을 직접 확인했다 -- 그래서 PATH-stub이 아니라 `--require` 모듈
// monkeypatch를 골랐다. Windows(PowerShell, 격리 PATH)·POSIX(Git Bash) 둘
// 다에서 실측 확인함, 아래 role-bound-seat-select-cli.test.mjs 헤더 주석
// 참조). 이 방식은 이 파일 자신에 **어떤 조건문도, 어떤 env var 읽기도
// 요구하지 않는다** -- 시험이 이 파일을 전혀 몰라도 되는 방식으로 환경을
// 갈아치운다.

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

const FLAG_TO_FIELD = Object.freeze({
  "--role": "role",
  "--worktree": "worktreePath",
  "--registry": "registryPath",
});

function classifyFlag(arg) {
  if (arg.startsWith("--") && arg.includes("=")) {
    const flagName = arg.slice(0, arg.indexOf("="));
    return {
      error: `unsupported '${flagName}=value' syntax ('${arg}') -- use '${flagName} value' (space-separated) instead`,
    };
  }
  if (arg.startsWith("--") && !FLAG_TO_FIELD[arg]) {
    return { error: `unrecognized flag '${arg}'` };
  }
  return { field: FLAG_TO_FIELD[arg] };
}

export function parseRoleBoundSeatSelectArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const classified = classifyFlag(args[i]);
    if (classified.error) return { ok: false, reason: classified.error };
    if (classified.field) parsed[classified.field] = args[++i];
  }
  if (
    !isNonEmptyString(parsed.role) ||
    !isNonEmptyString(parsed.worktreePath) ||
    !isNonEmptyString(parsed.registryPath)
  ) {
    return {
      ok: false,
      reason:
        "usage: role-bound-seat-select-cli.mjs --role <CODER|REVIEW|VERIFY|PM> --worktree <path> --registry <seat-registry.json path>",
    };
  }
  return { ok: true, ...parsed };
}

// 후보별 handle -> role 매핑을 사람이 읽는 조각으로 렌더링한다
// (coder-task.md HYK-211-seat-select-2 §2-3 P2-3 -- 거부/선택 양쪽에서
// "어느 좌석이 어떤 역할로 판별됐는지"가 보여야 한다). candidateRoles가
// 없으면(예: 위치/대장 단계에서 이미 거부돼 후보 조회 자체를 안 한 경우)
// 빈 문자열 -- 없는 정보를 지어내지 않는다.
function formatCandidateRoles(candidateRoles) {
  if (!Array.isArray(candidateRoles) || candidateRoles.length === 0) {
    return "";
  }
  const rendered = candidateRoles
    .map((c) => `${c.handle}=${c.role}`)
    .join(", ");
  return ` roles=[${rendered}]`;
}

// 결과 -> 사람이 읽는 한 줄(요건2). ok:true는 고른 handle을, ok:false는
// 사유 코드(roleBoundSeatReason/locationReason/worktreeReason 중 존재하는
// 것)와 reason 문구를 그대로 보여준다 -- 추측으로 문구를 다듬지 않는다.
// 양쪽 다 candidateRoles가 있으면 붙인다(P2-3).
export function formatRoleBoundSeatSelectResult(result) {
  const roles = formatCandidateRoles(result.candidateRoles);
  if (result.ok) {
    return `SELECTED handle=${result.handle}${roles}`;
  }
  const code =
    result.roleBoundSeatReason ??
    result.locationReason ??
    result.worktreeReason ??
    "UNKNOWN";
  return `REJECTED code=${code} reason=${result.reason}${roles}`;
}

// opts.execFn/opts.registryFs는 이 함수를 **같은 프로세스 안에서 직접
// import해 부르는** 호출자(단위 시험, 다른 내부 모듈)를 위한 표준 DI일
// 뿐이다 -- direct-entry(아래)는 이 인자를 절대 채우지 않는다. 이건 "외부
// 입력으로 CLI 실행 결과를 바꿀 수 있는 통로"가 아니다: 그 통로를 쓰려면
// 애초에 이 함수를 JS로 import해서 호출해야 하고, 그건 곧 "이 코드를 직접
// 호출하는 것"이지 셸에서 뜬 CLI 프로세스를 외부에서 조종하는 게 아니다.
export function runRoleBoundSeatSelectCli(argv, opts = {}) {
  const parsed = parseRoleBoundSeatSelectArgs(argv);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  const result = resolveRoleBoundSeatHandle(
    { role: parsed.role, worktreePath: parsed.worktreePath },
    { execFn, registryPath: parsed.registryPath, registryFs: opts.registryFs },
  );
  return result;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/role-bound-seat-select-cli.mjs");
if (invokedDirectly) {
  const result = runRoleBoundSeatSelectCli(process.argv.slice(2));
  console.log(formatRoleBoundSeatSelectResult(result));
  process.exit(result.ok ? 0 : 1);
}
