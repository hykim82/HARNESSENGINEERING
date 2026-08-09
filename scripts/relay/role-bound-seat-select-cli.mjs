import { readFileSync } from "node:fs";
import {
  resolveRoleBoundSeatHandle,
  createOrcaExecFn,
} from "./adapters/orca-adapter.mjs";

// HYK-211-seat-select coder-1/2 (coder-task.md §4, "1-B 세 요건"): 사람이
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
// ---- HYK-211-seat-select-2 §2-2 P1-2 수리 ----
// 1R은 direct-entry 블록이 runRoleBoundSeatSelectCli를 부르지 않고
// parseRoleBoundSeatSelectArgs + resolveRoleBoundSeatHandle을 따로
// 재호출했다 -- 사람이 실제로 치는 그 경로가 export helper 시험으로
// 대체 증명되지 않는 헛시험이었다(검토자 반려). 이제 **direct-entry는
// runRoleBoundSeatSelectCli를 그대로 부른다** -- 경로가 하나뿐이라
// export 시험이 곧 direct-entry 시험이다. 그 사실 자체를
// role-bound-seat-select-cli.test.mjs가 **자식 프로세스로 이 파일을
// 실행**해 stdout/종료코드를 단언함으로써 증명한다(export helper
// 호출만으로 대체하지 않는다).
//
// ---- 시험 전용 seam(§2-2 요구, ⛔프로덕션 판정 변경 금지) ----
// `ROLE_BOUND_SEAT_SELECT_FIXTURE` 환경변수가 설정돼 있으면 그 경로의
// JSON 파일(`{ "worktreeList": <orca 응답>, "terminalList": <orca 응답> }`)
// 로 조립한 가짜 execFn을 쓴다 -- 이 값이 **없으면**(프로덕션 기본) 전과
// 완전히 동일하게 `createOrcaExecFn()`(실 `orca` spawn)을 쓴다. 이 env
// var는 "terminal/worktree list를 실 orca 대신 고정 fixture로 답하게"
// 하는 것뿐이고, 판정 로직(resolveRoleBoundSeatHandle) 자체는 손대지
// 않는다 -- registryPath는 **실제 파일 시스템의 실제 JSON 파일**을 그대로
// 쓴다(별도 fixture seam이 필요 없다).
function buildFixtureExecFn(fixturePath) {
  const raw = readFileSync(fixturePath, "utf8");
  const fixtures = JSON.parse(raw);
  return function fixtureExecFn(argv) {
    const key =
      argv[0] === "worktree" && argv[1] === "list"
        ? "worktreeList"
        : argv[0] === "terminal" && argv[1] === "list"
          ? "terminalList"
          : null;
    if (!key || !(key in fixtures)) {
      throw new Error(
        `role-bound-seat-select-cli fixture execFn: no stub for argv=${JSON.stringify(argv)}`,
      );
    }
    return fixtures[key];
  };
}

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
  const args = process.argv.slice(2);
  const fixturePath = process.env.ROLE_BOUND_SEAT_SELECT_FIXTURE;
  const cliOpts = isNonEmptyString(fixturePath)
    ? { execFn: buildFixtureExecFn(fixturePath) }
    : {};
  const result = runRoleBoundSeatSelectCli(args, cliOpts);
  console.log(formatRoleBoundSeatSelectResult(result));
  process.exit(result.ok ? 0 : 1);
}
