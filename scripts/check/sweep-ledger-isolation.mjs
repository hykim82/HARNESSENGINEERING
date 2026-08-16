// HYK-279: closes the leak ORCH measured 2026-08-16 20:48 -- a full local
// test sweep (`node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs
// scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs`, run
// directly against a worktree checkout, NOT via isolated-suite-runner.mjs's
// disposable clone) mutated the REAL control-room admission ledger and its
// `.completion-failures.jsonl` side file with test-fixture reservation ids
// (SPIKE-LIVE-1 / SMOKE-1 / HYK-1 / HYK-000-x-1, 205 lines in one hour).
//
// Root cause (실측, not guessed): admission-completion-adapter.mjs's
// resolvePersistentLedgerPaths() (HYK-227 2R) reads
// `<mainRepoRoot>/.harness/admission-ledger-path.json` whenever
// `ADMISSION_LEDGER_PATH` is unset in the process env. `mainRepoRoot()`
// resolves via `git rev-parse --git-common-dir` off `process.cwd()` -- for
// EVERY worktree of this repo (this one included) that common dir is the
// same shared `C:/Users/Administrator/Documents/HARNESSENGINEERING/.git`,
// and that main repo's `.harness/admission-ledger-path.json` (installed by
// templates/harness-init/install.mjs, untracked, confirmed present on disk)
// points at the REAL control-room ledger
// (`D:/문서관리/하네스-관제실/admission-ledger.json`). Any test that calls
// checkRelayHandshake/spawnAdmissionCompletion/autoCompleteAdmission without
// itself pinning ADMISSION_LEDGER_PATH to an isolated fixture path inherits
// that persistent fallback and attempts a real completion for whatever
// fixture reservation id the test used -- almost always RESERVATION_NOT_FOUND,
// which durably appends to the REAL `*.completion-failures.jsonl`.
//
// This is NOT a bug in admission-completion-adapter.mjs itself: the
// persistent fallback is intentional production behavior (HYK-227 2R §2,
// "the ps1 side owns that path, not this repo" -- coder-task.md §3 of this
// round forbids touching it, and forbids changing consumption-gate/handshake
// behavior). The leak is a TEST-ISOLATION gap: tests must not let the
// worktree's ambient, machine-real persistent pointer leak into a spawned
// child's inherited env. Fixing it here (a `--import` preload for the whole
// sweep) closes the gap for every current and future test file without
// touching a single line of relay-handshake.mjs or
// admission-completion-adapter.mjs.
//
// Mechanism: admission-completion-adapter.mjs's own resolution order is
// documented (and pinned by admission-completion-persistent-source.test.mjs)
// as "env wins first, persistent pointer only when env is ABSENT." Setting
// ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH here, before any test file
// loads, makes "env present" true for the entire sweep process AND every
// child process spawned from it (execFileSync with no `env` override
// inherits process.env) -- so the persistent-pointer branch is never reached
// by a test that simply forgot to isolate. A test that needs to exercise the
// genuine "neither source present" no-op contract must still explicitly
// `delete` both vars AND move off the real repo's cwd (see
// admission-completion-persistent-source.test.mjs's buildSyntheticRepo/
// withSyntheticRepoCwd pattern) -- this preload only supplies a safe
// default, it does not (and must not) block a test from opting out.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A single directory shared by ledger + lock for this whole sweep process --
// every test that inherits this default (i.e. never overrides/deletes it)
// resolves to the SAME disposable ledger, matching how the real persistent
// pointer resolves to one shared file. mkdtempSync is synchronous and this
// module's top-level body runs exactly once (Node caches ESM module
// instances), so every test file loaded via `--import` sees the same paths.
if (!process.env.ADMISSION_LEDGER_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "hyk279-sweep-ledger-isolation-"));
  process.env.ADMISSION_LEDGER_PATH = join(dir, "sweep-ledger.json");
  process.env.ADMISSION_LOCK_PATH = join(dir, "sweep-ledger.lock");
  console.error(
    `[sweep-ledger-isolation] ADMISSION_LEDGER_PATH was unset -- defaulted to isolated sweep-scoped path: ${process.env.ADMISSION_LEDGER_PATH}`,
  );
}
