import { relayStep } from "./relay-core.mjs";
import { selectRelayAdapterForRole } from "./engine-adapter-registry.mjs";

// HYK-169-coder-1: CLI 진입점 -- `node scripts/relay/run-step.mjs --role CODER
// --worktree <path> --task-id <id>` 한 명령으로 좌석 준비+배달까지 끝낸다.
// 실 orca를 부르는 경로이므로 **이 태스크에서는 실행하지 않는다**(작성만,
// 비타협 제약 -- 실행은 ORCH가 이후 별도로 한다).
//
// HYK-153-adapter-registry-1 (coder-task.md §2 product_scope ⓘⓘⓘⓘ, piece D):
// this CLI no longer imports any ./adapters/*.mjs module statically, and no
// longer builds its own ORCA_ADAPTER constant -- it asks the registry which
// adapter+execFn to use for `parsed.role`, and relayStep is never called at
// all when that pick fails (fail-closed: no deliverTask, no .harness task
// file copy, since those only happen inside relayStep).

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

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
  // HYK-153-fake-engine-2 (coder-task.md §2 product_scope ⓘ "새 주입 seam
  // 0", restoring a 1R review-1 P1-1 rejection): this CLI entry point never
  // forwards its own opts to the registry -- that would let any caller
  // bypass the registry's own config/import contract (allowed-dir
  // containment, naming pattern) via this entry point. opts is still used
  // below, for relayStep's own (unrelated) opts, e.g. execFn.
  const selection = await selectRelayAdapterForRole(parsed.role);
  if (!selection.ok) {
    return {
      ok: false,
      reason: selection.reason,
      reasonCode: selection.reasonCode,
    };
  }
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : selection.execFn;
  return relayStep(parsed, selection.adapter, { ...opts, execFn });
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
