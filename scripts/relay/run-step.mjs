import { relayStep } from "./relay-core.mjs";
import {
  ensureSeat,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
  createOrcaExecFn,
} from "./adapters/orca-adapter.mjs";

// HYK-169-coder-1: CLI 진입점 -- `node scripts/relay/run-step.mjs --role CODER
// --worktree <path> --task-id <id>` 한 명령으로 좌석 준비+배달까지 끝낸다.
// 실 orca를 부르는 경로이므로 **이 태스크에서는 실행하지 않는다**(작성만,
// 비타협 제약 -- 실행은 ORCH가 이후 별도로 한다).

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

const ORCA_ADAPTER = Object.freeze({
  ensureSeat,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
});

// 플래그 -> parsed 필드 매핑(단일 지점 -- if/else 사슬 대신 lookup, 복잡도 억제).
const FLAG_TO_FIELD = Object.freeze({
  "--role": "role",
  "--worktree": "worktreePath",
  "--task-id": "taskId",
  "--harness-dir": "harnessDir",
  "--main-repo-dir": "mainRepoDir",
  "--coordinator-handle": "coordinatorHandle",
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

export function parseRunStepArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const classified = classifyFlag(args[i]);
    if (classified.error) return { ok: false, reason: classified.error };
    if (classified.field) parsed[classified.field] = args[++i];
  }
  if (
    !isNonEmptyString(parsed.role) ||
    !isNonEmptyString(parsed.worktreePath) ||
    !isNonEmptyString(parsed.taskId)
  ) {
    return {
      ok: false,
      reason:
        "usage: run-step.mjs --role <CODER|REVIEW|VERIFY> --worktree <path> --task-id <id>",
    };
  }
  return { ok: true, ...parsed };
}

export async function runStepCli(argv, opts = {}) {
  const parsed = parseRunStepArgs(argv);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  return relayStep(parsed, ORCA_ADAPTER, { ...opts, execFn });
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/relay/run-step.mjs");
if (invokedDirectly) {
  console.error(
    "run-step.mjs: 이 커밋에서는 결선되지 않는다(비타협 제약 -- 실 orca 호출 0). 실행은 ORCH가 별도로 한다.",
  );
  process.exit(1);
}
