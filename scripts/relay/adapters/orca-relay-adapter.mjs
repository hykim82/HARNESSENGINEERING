// HYK-153-adapter-registry-1 (coder-task.md §2 product_scope ⓘⓘ, piece D):
// the one module engine-adapter-registry.mjs's selectRelayAdapterForRole()
// dynamically imports for every role today (engine-profiles.json's
// engines.claude.adapterModule and engines.codex.adapterModule both name
// this same file -- today's live CODER/REVIEW/VERIFY/PM roles all resolve
// to the one real Orca relay implementation, unchanged from before this
// round).
//
// This module does NOT reimplement the ports -- it re-exports the exact
// same function references run-step.mjs used to import statically from
// ./orca-adapter.mjs and ./seat-candidate-adapter.mjs (the registry test
// asserts port-for-port `===` identity against those originals, so this
// file can never silently drift into a wrapper/proxy). createRelayAdapter
// itself does no I/O and spawns no process -- it only builds the frozen
// adapter object and calls createOrcaExecFn() (a closure constructor, not
// a call that starts anything).
import {
  ensureSeat,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
  createOrcaExecFn,
} from "./orca-adapter.mjs";
import { observeSeatCandidates } from "./seat-candidate-adapter.mjs";

const ADAPTER = Object.freeze({
  ensureSeat,
  observeSeatCandidates,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
});

// createRelayAdapter(selection) -- selection: { role, engine, profile,
// adapterModule, configPathUsed } (engine-adapter-registry.mjs's own
// contract, coder-task.md §2 product_scope). This adapter does not branch
// on any field of `selection` -- there is only one Orca relay
// implementation today -- but the call shape is part of the fixed contract
// every adapterModule must accept (piece C's fake-engine adapter reads
// selection.engine to decide how to fake a relay, per that piece's own
// design); this function simply does not declare the parameter it never
// reads, rather than declare-and-ignore it.
export function createRelayAdapter() {
  return { adapter: ADAPTER, execFn: createOrcaExecFn() };
}
