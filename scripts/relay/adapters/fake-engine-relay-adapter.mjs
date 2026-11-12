// HYK-153-fake-engine-1 (coder-task.md §2, piece C of HYK-153, built on
// piece D's registry -- engine-adapter-registry.mjs's
// selectRelayAdapterForRole() dynamically imports whatever module
// engines.<F>.adapterModule names and calls its createRelayAdapter(selection)
// (selection = { role, engine, profile, adapterModule, configPathUsed }).
// This module is a second, independent implementation of that exact
// contract -- a synthetic relay seat that never spawns Orca, a model CLI, or
// any other real engine process, so a CODER->REVIEW round can drive the
// production consumption path (checkRelayHandshake's 31 checks, admission
// return, consumption-receipt write, reject-streak record) end to end with
// zero real seats.
//
// Honesty contract (coder-task.md §2 product_scope ⓘ): no engine name
// literal appears anywhere in this file -- the only engine-identifying
// strings this module ever writes come from `selection` (closed over from
// createRelayAdapter's own argument, itself built by the registry from the
// loaded config), never from a literal written here. This file also never
// calls loadEngineProfiles/getRoleProfile/getEngineAttr itself (the registry
// already resolved everything this module needs into `selection`) and its
// static import closure names zero other adapterModule
// (orca-adapter.mjs/claude-adapter.mjs/codex-adapter.mjs/orca-relay-
// adapter.mjs) -- G9 (orca-cli-boundary.mjs)'s scanner also finds 0 calls
// here whose first argument is the string literal "orca".
//
// What this adapter actually does when picked for a role (coder-task.md §2
// product_scope ⓘⓘⓘ "완주 진입 = runStepCli", the only entry point that ever
// reaches this file in production shape): it plays BOTH sides of a round --
// the orchestration seat (ensureSeat/observeSeatCandidates, synthetic,
// always "one seat, ready now") AND the worker that seat would have run
// (deliverTask: writes the round's result file with the G1 three-line header
// + an engine_profile witness line, makes the round's git commit for CODER,
// and runs the ONE production DONE-stamping path --
// `node scripts/relay/finalize-done.mjs <role-lowercase> <harnessDir>` as a
// real child process -- rather than writing a '>>> DONE:' line itself).
// Nothing past deliverTask's return is faked: relayStep's own post-delivery
// checkExistingHandshake call, and everything checkRelayHandshake does
// inside it (G1 cross-check, head_commit binding, admission return,
// consumption-receipt write, reject-streak record), is the real production
// consumption path running against whatever files this adapter just wrote.
//
// What the caller (the test) must supply, since this module is a plain port
// implementation with no test-only state of its own: opts.fakeEngineRound,
// threaded straight through from runStepCli's own opts argument (run-
// step.mjs -> relayStep -> adapter.deliverTask(input, opts) -- opts is never
// narrowed along that path, coder-task.md §2 사전확인 ⑴). Shape:
//   { runtimeTaskId, assigneePaneKey, forTaskId?, headCommit?, injectFault? }
// forTaskId/headCommit are required for a REVIEW-family round, unused for
// CODER (REVIEW-only cover lines, see buildResultBody below).
//
// `injectFault` (optional, test-only -- fake-engine-round.test.mjs's own
// negative cells, coder-task.md §2 ⓐ "같은 흐름에서 검사를 하나씩 어기면"):
// the normal path above is the ONLY path a positive round takes; this field
// never has a value in that path. Recognized values deliberately make this
// adapter's own output violate exactly one production consumer check, so
// the test can drive the SAME runStepCli entry point and watch the SAME
// production consumption path reject it:
//   "HAND_DONE"         -- never calls finalize-done.mjs; appends a
//                          well-formed '>>> DONE:' line by hand instead
//                          (no 'done_stamped_by: finalize-done' marker --
//                          relay-handshake.mjs's HYK-418 §2-1 fail-closed
//                          rejection).
//   "VERDICT_TWO_LINES" -- REVIEW only; writes two standalone 'verdict:'
//                          lines (reject-streak.mjs's AMBIGUOUS_VERDICT_LINE).
// A mismatched G1 pane_match or REVIEW head_commit needs no adapter-side
// fault at all -- the caller just passes a `assigneePaneKey`/`headCommit`
// value that does not match what it independently recorded in the dispatch
// ledger / task file, which this adapter echoes verbatim either way.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTERS_DIR = dirname(fileURLToPath(import.meta.url));
const FINALIZE_DONE_PATH = join(ADAPTERS_DIR, "..", "finalize-done.mjs");

const REVIEW_ROLE_RE = /^review$/i;

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function harnessDirFor(worktreePath) {
  return join(worktreePath, ".harness");
}

// Every field here comes from `selection` (the registry's own resolved pick)
// or `round` (the caller's opts.fakeEngineRound) -- never a literal written
// in this file.
function buildWitnessLine(selection) {
  return `engine_profile: engine=${selection.engine} model=${selection.profile?.model ?? ""} config=${selection.configPathUsed} adapter_module=${selection.adapterModule}`;
}

// worker-dispatch-rule.md §1's exact three-line shape -- this adapter plays
// the worker side of G1, so it writes the SAME three cover lines a real
// worker would, derived from the dispatch ledger record the caller already
// wrote (round.runtimeTaskId/round.assigneePaneKey) rather than from any
// value this module invents.
function buildG1Lines(round) {
  return [
    "dispatch_verified: yes",
    `task_id_from_dispatch: ${round.runtimeTaskId}`,
    `pane_match: ${round.assigneePaneKey} == ${round.assigneePaneKey} ? 일치`,
  ].join("\n");
}

function buildResultBody({ taskId, role, selection, round }) {
  const g1 = buildG1Lines(round);
  const witness = buildWitnessLine(selection);
  if (REVIEW_ROLE_RE.test(role)) {
    if (
      !isNonEmptyString(round.forTaskId) ||
      !isNonEmptyString(round.headCommit)
    ) {
      throw new Error(
        "fake-engine-relay-adapter: REVIEW round requires opts.fakeEngineRound.forTaskId and .headCommit",
      );
    }
    const verdictBlock =
      round.injectFault === "VERDICT_TWO_LINES"
        ? "verdict: approved\nverdict: approved\n"
        : "verdict: approved\n";
    return (
      `${g1}\n` +
      `task_id: ${taskId}\n` +
      `for: ${round.forTaskId}\n` +
      `head_commit: ${round.headCommit}\n\n` +
      `${witness}\n` +
      `fake REVIEW round -- synthetic completion for HYK-153 piece C\n\n` +
      verdictBlock
    );
  }
  return (
    `${g1}\n` +
    `task_id: ${taskId}\n\n` +
    `${witness}\n` +
    `fake CODER round -- synthetic completion for HYK-153 piece C\n`
  );
}

// "HAND_DONE" fault only (see module header) -- never reused by the normal
// path, which runs finalize-done.mjs itself (real machine clock, real
// marker). Deliberately duplicates finalize-done.mjs's KST-seconds
// formatting rather than importing it: importing a producer-side helper
// into the one fixture whose entire point is to simulate a round that did
// NOT go through that producer would blur exactly the distinction the test
// is checking.
function formatKstSecondsForHandDoneFault(d) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ` +
    `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())} KST`
  );
}

// CODER's only faked side effect this module performs that a real worker
// would also perform itself: a git commit in the round's own worktree, so
// the round's handshake HEAD actually moves (the base-copy guard's
// precondition, HYK-424) -- never a file write under scripts/ or any other
// repo content, purely `--allow-empty` so this works regardless of what
// (if anything) is tracked in the synthetic repo.
function makeCoderCommit(worktreePath, taskId) {
  execFileSync(
    "git",
    ["commit", "--allow-empty", "-q", "-m", `fake CODER round ${taskId}`],
    { cwd: worktreePath },
  );
}

function runFinalizeDone(role, harnessDir) {
  const roleLower = String(role).toLowerCase();
  execFileSync(process.execPath, [FINALIZE_DONE_PATH, roleLower, harnessDir], {
    encoding: "utf8",
  });
}

function deliverFakeRound(inp, opts, selection) {
  const round = opts && opts.fakeEngineRound;
  if (
    !round ||
    !isNonEmptyString(round.runtimeTaskId) ||
    !isNonEmptyString(round.assigneePaneKey)
  ) {
    return {
      ok: false,
      reason:
        "fake-engine-relay-adapter: opts.fakeEngineRound (with runtimeTaskId + assigneePaneKey) is required",
    };
  }
  const harnessDir = harnessDirFor(inp.worktreePath);
  if (!REVIEW_ROLE_RE.test(inp.role)) {
    makeCoderCommit(inp.worktreePath, inp.taskId);
  }
  const body = buildResultBody({
    taskId: inp.taskId,
    role: inp.role,
    selection,
    round,
  });
  const resultFileName = `${String(inp.role).toLowerCase()}.md`;
  if (round.injectFault === "HAND_DONE") {
    const doneLine = `>>> DONE: ${String(inp.role).toUpperCase()} @ ${formatKstSecondsForHandDoneFault(new Date())}`;
    writeFileSync(
      join(harnessDir, resultFileName),
      `${body}\n${doneLine}\n`,
      "utf8",
    );
  } else {
    writeFileSync(join(harnessDir, resultFileName), body, "utf8");
    runFinalizeDone(inp.role, harnessDir);
  }
  return { ok: true, runtimeTaskId: round.runtimeTaskId };
}

// createRelayAdapter(selection) -- the exact export name/shape engine-
// adapter-registry.mjs requires (coder-task.md §2 product_scope, piece D
// naming rule). This adapter DOES branch on `selection.engine` in spirit
// (it IS the module a specific, test-only "F" engine name resolves to) but
// the branching inside deliverFakeRound is on `inp.role` -- a value every
// adapterModule already receives from relay-core.mjs on every call,
// production included -- never on `selection.engine`'s string value itself,
// so adding a second fake engine name later needs no new branch here.
export function createRelayAdapter(selection) {
  const adapter = Object.freeze({
    ensureSeat(inp) {
      return {
        ok: true,
        seatHandle: `term_fake_${String(inp.role ?? "role").toLowerCase()}`,
        created: true,
      };
    },
    observeSeatCandidates() {
      return [
        {
          schemaVersion: 1,
          handle: "term_fake",
          state: "idle-or-ready",
          occupied: false,
          observable: true,
        },
      ];
    },
    deliverTask(inp, opts) {
      return deliverFakeRound(inp, opts, selection);
    },
    collectCompletionSignals() {
      return { ok: true, signals: [] };
    },
    teardownSeat() {
      return { ok: true };
    },
  });

  // execFn is part of the fixed port contract (engine-adapter-
  // registry.mjs's validateAdapterContract requires it to be a function) --
  // this adapter never calls it itself (deliverFakeRound does all its I/O
  // directly), and nothing in relay-core.mjs's relayStep calls it either
  // (opts.execFn is a pass-through for the adapter's own internal use only,
  // same as orca-relay-adapter.mjs's createOrcaExecFn() closure). It throws
  // rather than silently no-op, so an accidental future call site shows up
  // immediately instead of looking like a real exec that happened to do
  // nothing.
  function execFn() {
    throw new Error(
      "fake-engine-relay-adapter: execFn must never be invoked (no real process is ever spawned by this port, G9)",
    );
  }

  return { adapter, execFn };
}
