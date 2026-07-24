// HYK-167 사이클0 D0-3 (B0 §5, H1/HG4/HG10): LIMITED/HIGH_ASSURANCE mode
// constants and the 6 low-risk bridge-gate conditions, as DATA only.
//
// H1 (signed, B0): under LIMITED mode, a high-authority unattended seat's
// `start` is 0 -- this module records that contract in a constant and a
// comment; it does NOT implement the runtime check that would actually
// refuse such a start. That enforcement is cycle 4 (task §0's explicit
// deferral list: "start-전 판정 런타임... = 사이클 4").
//
// HIGH_ASSURANCE enable is gated on HYK-89 (a separate, not-yet-landed
// dependency) -- this cycle's constant exists so later code has a name to
// reference, but no function anywhere in this diff ever sets a mode to
// HIGH_ASSURANCE or flips an "enabled" flag to true. See
// assertNoHighAssuranceEnableCalls below and its test for the "0 enable
// calls this cycle" assertion the task requires.

export const LAUNCH_MODE = Object.freeze({
  LIMITED: "LIMITED",
  HIGH_ASSURANCE: "HIGH_ASSURANCE",
});

// H1: under LIMITED, a high-authority unattended seat (no C receipt) has
// start_count == 0 by contract. This is a documented constant, not a gate --
// no code path in this cycle reads it to block anything.
export const LIMITED_MODE_HIGH_AUTHORITY_UNATTENDED_START_COUNT = 0;

// HG4: the 6 low-risk bridge-gate conditions, recorded as data (B0 §5) --
// a future cycle's runtime bridge-gate implementation is expected to check
// all 6 before allowing a LIMITED-mode seat to bridge into a higher-trust
// action. This cycle only fixes their identity and text; none is executed
// or evaluated anywhere in this diff.
export const BRIDGE_CONDITIONS = Object.freeze([
  Object.freeze({
    id: "BC1_SINGLE_REPO_SCOPE",
    description:
      "the action's target path resolves inside exactly one already-assigned worktree/repo root -- no cross-repo or shared-root write",
  }),
  Object.freeze({
    id: "BC2_NO_SECRET_SURFACE",
    description:
      "the action touches no path matching a known secret/credential pattern (.env, credentials.json, tokens/, ...)",
  }),
  Object.freeze({
    id: "BC3_REVERSIBLE_LOCAL",
    description:
      "the action is a local, reversible git operation (commit, non-force branch create) -- never a force-push, remote branch delete, or history rewrite",
  }),
  Object.freeze({
    id: "BC4_NO_EXTERNAL_PUBLISH",
    description:
      "the action does not publish to a shared/external surface (no PR create/merge, no Linear state transition, no packet signature)",
  }),
  Object.freeze({
    id: "BC5_TASK_FILE_ECHOED",
    description:
      "the seat's result file echoes the exact task_id it was dispatched against (relay-handshake contract), so the bridge action is traceable to one dispatch",
  }),
  Object.freeze({
    id: "BC6_HOOK_CHAIN_INTACT",
    description:
      "the seat's git hooks (commit-msg/pre-commit) are installed and unmodified -- no --no-verify, no hook bypass, for the duration of the bridged action",
  }),
]);

// H3 (signed, B0): 0 hooks removed this cycle (or any cycle without a full
// promotion bundle, see migration-ledger.schema.mjs). Recorded here as a
// constant next to the other cycle-0 invariants for a single place future
// code can assert against.
export const HOOKS_REMOVED_THIS_CYCLE = 0;

// Honesty check, not an enforcement gate: asserts (by construction, not by
// scanning) that this module never calls anything that would flip a mode to
// HIGH_ASSURANCE. Since no such setter exists in this file at all, the
// assertion is trivially and permanently true for this module -- the
// companion test additionally greps this file's own source to catch a
// future edit that would add one, which is the actual regression guard.
export function assertNoHighAssuranceEnableCalls() {
  return {
    ok: true,
    reason: "bridge-conditions.mjs defines no HIGH_ASSURANCE enable path",
  };
}
