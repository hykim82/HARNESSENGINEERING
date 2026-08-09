import {
  resolveRoleBoundSeatHandle,
  createOrcaExecFn,
} from "./adapters/orca-adapter.mjs";

// HYK-211-seat-select coder-1 (coder-task.md §4, "1-B 세 요건"): 사람이
// 직접 칠 수 있는 실행 한 줄 -- 동석(CODER+REVIEW 등) 상황에서 "어느
// 좌석이 어떤 역할로 판별됐는지"를 눈으로 확인하기 위한 진입점이다.
//
//   node scripts/relay/role-bound-seat-select-cli.mjs --role CODER --worktree "<경로>"
//
// 요건2(그때 무엇이 보여야 하는가): 고른 handle, 또는 왜 거부했는지(사유
// 코드) -- 아래 printResult가 두 경우 모두 stdout에 사람이 읽을 수 있는
// 한 줄로 찍는다.
// 요건3(도달 경로): 사람이 직접 부르는 도구라 도달 경로 = 이 stdout 출력
// 자체다(별도 알림 채널 없음 -- 요건2의 출력이 곧 도달이다).
//
// G9: `orca` CLI를 spawn하는 유일한 지점은 orca-adapter.mjs의
// createOrcaExecFn이다 -- 이 파일은 그것을 그대로 가져다 쓸 뿐, 직접
// spawn하지 않는다(orca-cli-boundary.mjs가 이걸 정적으로 검사한다).

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

const FLAG_TO_FIELD = Object.freeze({
  "--role": "role",
  "--worktree": "worktreePath",
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
    !isNonEmptyString(parsed.worktreePath)
  ) {
    return {
      ok: false,
      reason:
        "usage: role-bound-seat-select-cli.mjs --role <CODER|REVIEW|VERIFY|PM> --worktree <path>",
    };
  }
  return { ok: true, ...parsed };
}

// 결과 -> 사람이 읽는 한 줄(요건2). ok:true는 고른 handle을, ok:false는
// 사유 코드(roleBoundSeatReason/locationReason/worktreeReason 중 존재하는
// 것)와 reason 문구를 그대로 보여준다 -- 추측으로 문구를 다듬지 않는다.
export function formatRoleBoundSeatSelectResult(result) {
  if (result.ok) {
    return `SELECTED handle=${result.handle}`;
  }
  const code =
    result.roleBoundSeatReason ??
    result.locationReason ??
    result.worktreeReason ??
    "UNKNOWN";
  return `REJECTED code=${code} reason=${result.reason}`;
}

export function runRoleBoundSeatSelectCli(argv, opts = {}) {
  const parsed = parseRoleBoundSeatSelectArgs(argv);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  const result = resolveRoleBoundSeatHandle(
    { role: parsed.role, worktreePath: parsed.worktreePath },
    { execFn },
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
  const parsed = parseRoleBoundSeatSelectArgs(args);
  if (!parsed.ok) {
    console.error(`role-bound-seat-select-cli: ${parsed.reason}`);
    process.exit(1);
  }
  const result = resolveRoleBoundSeatHandle(
    { role: parsed.role, worktreePath: parsed.worktreePath },
    { execFn: createOrcaExecFn() },
  );
  console.log(formatRoleBoundSeatSelectResult(result));
  process.exit(result.ok ? 0 : 1);
}
