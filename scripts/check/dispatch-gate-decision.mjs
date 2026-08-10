// HYK-217-dispatch-gate-1 (coder-task.md) -- CLI shell around
// dispatch-gate-decision-core.mjs. This is the thing the delivery tool
// (관제실 `dispatch-worker.ps1`, patched per coder.md's patch text, not this
// repo) is meant to call BEFORE injecting a task: it runs BOTH
// `reject-streak.mjs gate` and `reject-streak.mjs diagnostic-gate` against
// the about-to-be-dropped task file, feeds their exit codes through the pure
// core, prints one human-readable line per gate PLUS one aggregate verdict
// line, and exits 0 (deliver) or 1 (do not deliver) -- deliberately its OWN
// exit-code contract, distinct from the underlying gates' {0,1,2}, so a
// caller never has to remember two different meanings for "1".
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideFromGateExit,
  combineGateDecisions,
} from "./dispatch-gate-decision-core.mjs";

const REJECT_STREAK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "reject-streak.mjs",
);

function runGateSubcommand(sub, taskPath, ledgerArgs) {
  try {
    const stdout = execFileSync(
      "node",
      [REJECT_STREAK_PATH, sub, taskPath, ...ledgerArgs],
      { encoding: "utf8" },
    );
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      // execFileSync throws on non-zero exit; err.status carries the real
      // code, err.status===undefined/null when the child died by signal
      // rather than exiting -- decideFromGateExit's REJECT_UNKNOWN_EXIT
      // branch is exactly for that case, so we pass it through as-is
      // rather than coercing it to a number.
      exitCode: err.status ?? null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? ""),
    };
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ledger") out.ledger = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

export function runDispatchGateDecision(argv) {
  const args = parseArgs(argv);
  const taskPath = args._[0];
  if (!taskPath) {
    return {
      allow: false,
      lines: [
        "dispatch-gate-decision: usage: node dispatch-gate-decision.mjs <task-path> [--ledger <path>]",
      ],
    };
  }
  const decisions = [];
  if (!existsSync(taskPath)) {
    // Routed through the SAME decideFromGateExit the spawned gates use
    // (exitCode:1, matching reject-streak.mjs's own "task file not found"
    // exit-1 contract) rather than a bespoke early-return -- so this path
    // and the spawned-gate exit-1 path share one mutation point (coder-task
    // §4-2's RED reproduction covers both by covering the core function).
    decisions.push(
      decideFromGateExit({
        exitCode: 1,
        stdout: "",
        stderr: `task file not found: ${taskPath}`,
        label: "dispatch-gate-decision (task file check)",
      }),
    );
  } else {
    const ledgerArgs = args.ledger ? ["--ledger", args.ledger] : [];
    const gateResult = runGateSubcommand("gate", taskPath, ledgerArgs);
    const diagResult = runGateSubcommand(
      "diagnostic-gate",
      taskPath,
      ledgerArgs,
    );
    decisions.push(
      decideFromGateExit({ ...gateResult, label: "reject-streak gate" }),
      decideFromGateExit({
        ...diagResult,
        label: "reject-streak diagnostic-gate",
      }),
    );
  }
  const combined = combineGateDecisions(decisions);

  const lines = [...combined.reasons];
  lines.push(
    combined.allow
      ? "dispatch-gate-decision: ALLOW -- 두 게이트 모두 통과, 배달 진행"
      : "dispatch-gate-decision: REJECT -- 위 사유로 배달 거부, 원인 확인 후 재시도하라",
  );
  return { allow: combined.allow, lines };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/dispatch-gate-decision.mjs");
if (invokedDirectly) {
  const { allow, lines } = runDispatchGateDecision(process.argv.slice(2));
  for (const line of lines) {
    if (allow) console.log(line);
    else console.error(line);
  }
  process.exit(allow ? 0 : 1);
}
