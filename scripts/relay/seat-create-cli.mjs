import {
  createRoleBoundSeat,
  createOrcaExecFn,
} from "./adapters/orca-adapter.mjs";

// HYK-213-seat-ledger (coder-task.md §3/§6, "1-B 세 요건"): 사람이 직접
// 칠 수 있는 실행 한 줄 -- 좌석을 만들면서 그 자리에서 역할을 대장에
// 적는다.
// HYK-214-seat-legacy-1 (§1-①): 이 진입점은 기본적으로 createRoleBoundSeat의
// assumeFreshWorktree를 넘기지 않는다(기본값 false) -- 레거시·혼재
// 워크트리에서도 호출될 수 있는 범용 수동 진입점이라, "생성 전 기존
// 탭 = 워커 아님" 기록을 자동으로 켤 근거가 없다(그 판단은 "방금 새
// 워크트리를 만들었다"를 구조적으로 아는 호출자만 할 수 있다). 그래서
// 이미 있던 탭은 기본적으로 이 경로로는 "워커 아님"으로 기록되지 않는다
// -- 미기록(=이후 조회 시 undetermined)으로 남는다.
// HYK-214-seat-legacy-2 (§0/§1, REVIEW 1R 반려 수리): 1R은 "구조적으로
// 아는 호출자가 assumeFreshWorktree:true를 주는 경로"를 하나도 만들지
// 않아, 새로 만든 워크트리의 표준 경로에서도 leftover 후보가 미기록으로
// 남아 이후 역할 결속 선별이 항상 ROLE_UNDETERMINED로 실패했다(검토자
// 지적, 코드 설계 자체는 부정되지 않음). 이번 라운드는 `--fresh-worktree`
// **명시 플래그**를 추가한다 -- 코드가 "방금 만들어졌는지"를 추측하지
// 않는다(이 이슈의 비타협 그대로): 플래그를 준 호출자만(예: 워크트리
// 생성 직후 이어 부르는 스크립트) assumeFreshWorktree:true가 전달되고,
// 플래그가 없으면(기본값, 지금 이 저장소의 모든 기존 호출) 그대로
// 레거시-안전 경로(미기록)를 유지한다.
//
//   node scripts/relay/seat-create-cli.mjs --role CODER --worktree "<경로>" --registry "<대장 json 경로>" [--fresh-worktree]
//
// 요건2(그때 무엇이 보여야 하는가): 새로 만든 좌석의 기록(handle 없음 --
// 이 진입점은 handle을 되돌리지 않는다, ptyId/role/paneKey 유무)과, 생성
// 전에 관측해 "워커 아님"으로 기록한 후보 목록(있으면) 둘 다 stdout에
// 사람이 읽을 수 있는 한 줄로 찍는다.
// 요건3(도달 경로): 사람이 직접 부르는 도구라 도달 경로 = 이 stdout 출력
// 자체다(별도 알림 채널 없음).
//
// G9: `orca` CLI를 spawn하는 유일한 지점은 orca-adapter.mjs의
// createOrcaExecFn이다 -- 이 파일은 그것을 그대로 가져다 쓸 뿐, 직접
// spawn하지 않는다(orca-cli-boundary.mjs가 정적으로 검사한다).
//
// role-bound-seat-select-cli.mjs(HYK-211-seat-select-3) 전례를 그대로
// 따른다: 이 파일도 환경변수를 하나도 읽지 않는다. direct-entry는 항상
// createOrcaExecFn()(실 orca spawn)을 쓴다 -- 조건 분기 자체가 없다.
// 시험은 이 파일을 자식 프로세스로 구동하고 `--require` preload로
// spawnSync를 monkeypatch해 환경을 프로그램 밖에서 제어한다(그 전례와
// 동일한 preload를 재사용한다).

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

const FLAG_TO_FIELD = Object.freeze({
  "--role": "role",
  "--worktree": "worktreePath",
  "--registry": "registryPath",
});

// HYK-214-seat-legacy-2 §1-①: 값이 아니라 존재 자체가 신호인 boolean
// 플래그 -- 뒤따르는 argv를 값으로 소비하지 않는다(값 플래그와 다른
// 처리 경로가 필요한 이유).
const BOOLEAN_FLAG_TO_FIELD = Object.freeze({
  "--fresh-worktree": "assumeFreshWorktree",
});

function classifyFlag(arg) {
  if (arg.startsWith("--") && arg.includes("=")) {
    const flagName = arg.slice(0, arg.indexOf("="));
    return {
      error: `unsupported '${flagName}=value' syntax ('${arg}') -- use '${flagName} value' (space-separated) instead`,
    };
  }
  if (BOOLEAN_FLAG_TO_FIELD[arg]) {
    return { booleanField: BOOLEAN_FLAG_TO_FIELD[arg] };
  }
  if (arg.startsWith("--") && !FLAG_TO_FIELD[arg]) {
    return { error: `unrecognized flag '${arg}'` };
  }
  return { field: FLAG_TO_FIELD[arg] };
}

export function parseSeatCreateArgs(args) {
  const parsed = { assumeFreshWorktree: false };
  for (let i = 0; i < args.length; i++) {
    const classified = classifyFlag(args[i]);
    if (classified.error) return { ok: false, reason: classified.error };
    if (classified.booleanField) {
      parsed[classified.booleanField] = true;
      continue;
    }
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
        "usage: seat-create-cli.mjs --role <CODER|REVIEW|VERIFY|PM> --worktree <path> --registry <seat-registry.json path> [--fresh-worktree]",
    };
  }
  return { ok: true, ...parsed };
}

// 관측된 "워커 아님" 후보를 사람이 읽는 조각으로 렌더링한다(요건2). 없으면
// 빈 문자열 -- 없는 정보를 지어내지 않는다.
function formatObservedNotWorkerSeats(observed) {
  if (!Array.isArray(observed) || observed.length === 0) return "";
  const rendered = observed
    .map((o) => `${o.handle}${o.skipped ? "(already-recorded)" : ""}`)
    .join(", ");
  return ` notWorkerSeatsRecorded=[${rendered}]`;
}

// 결과 -> 사람이 읽는 한 줄(요건2). ok:true는 기록된 좌석의 ptyId/role/
// paneKey 유무를, ok:false는 사유 코드와 문구를 그대로 보여준다.
export function formatSeatCreateResult(result) {
  const notWorker = formatObservedNotWorkerSeats(result.observedNotWorkerSeats);
  if (result.ok) {
    const r = result.record ?? {};
    return `CREATED ptyId=${r.ptyId ?? "null"} role=${r.role ?? "null"} paneKey=${isNonEmptyString(r.paneKey) ? "present" : "missing"}${notWorker}`;
  }
  const code = result.seatCreateLedgerReason ?? "UNKNOWN";
  return `FAILED code=${code} reason=${result.reason}${notWorker}`;
}

// opts.execFn은 이 함수를 같은 프로세스 안에서 직접 import해 부르는
// 호출자(단위 시험)를 위한 표준 DI일 뿐이다 -- direct-entry는 이 인자를
// 절대 채우지 않는다(role-bound-seat-select-cli.mjs와 동형).
export function runSeatCreateCli(argv, opts = {}) {
  const parsed = parseSeatCreateArgs(argv);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  return createRoleBoundSeat(
    {
      role: parsed.role,
      worktreePath: parsed.worktreePath,
      assumeFreshWorktree: parsed.assumeFreshWorktree,
    },
    { execFn, registryPath: parsed.registryPath, registryFs: opts.registryFs },
  );
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/seat-create-cli.mjs");
if (invokedDirectly) {
  const result = runSeatCreateCli(process.argv.slice(2));
  console.log(formatSeatCreateResult(result));
  process.exit(result.ok ? 0 : 1);
}
