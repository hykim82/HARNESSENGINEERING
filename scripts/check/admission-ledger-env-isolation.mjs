// HYK-359: closes the test-isolation gap the round measured (coder-task.md
// §1) -- a floating ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
// DISPATCH_RECEIPT_PATH left set in the invoking shell (a leftover export, a
// stale profile line) is silently inherited by every child process a test
// spawns via spawnSync/execFileSync with no explicit `env` override, and by
// every in-process call that reads process.env directly. Presence alone
// (regardless of whether the target path is valid or empty) makes
// admission-completion-adapter.mjs's autoCompleteAdmission() skip the
// HYK-312 UNISOLATED_HARNESS_DIR gate entirely (that gate only runs when
// `!ledgerPath`, i.e. env unset) and attempt a real completion against
// whatever the floating value happens to point at -- which almost always
// fails (LEDGER_MISSING or RESERVATION_NOT_FOUND), tripping HYK-344's exit 3
// for tests that never intended to exercise that path at all.
//
// This module does NOT touch admission-completion-adapter.mjs or #207/
// HYK-344's exit 3 design (coder-task.md §2-B 비타협 #1) -- it only makes a
// TEST's own child/in-process environment stop inheriting the ambient
// leak, exactly like every other fixture-based test in this suite already
// isolates itself from the real repo (mkdtemp + synthetic git init). A test
// that wants to genuinely exercise the persistent-pointer fallback (e.g.
// "linked worktree -> real completion succeeds against the SYNTHETIC main
// repo's own .harness/admission-ledger-path.json") still gets that: leaving
// these three keys unset (not setting them to some other value) is exactly
// what lets mainRepoRoot()'s git-ancestry resolution reach the synthetic
// fixture repo the test built, the same way it always did before an ambient
// var started shadowing that path.
const AMBIENT_LEDGER_ENV_KEYS = [
  "ADMISSION_LEDGER_PATH",
  "ADMISSION_LOCK_PATH",
  "DISPATCH_RECEIPT_PATH",
];

// isolatedChildEnv -- build the `env` option for a spawnSync/execFileSync
// call: a copy of `baseEnv` (defaults to this process's own env, so
// unrelated ambient vars a fixture legitimately relies on -- PATH, TEMP,
// etc. -- are preserved) with the three ambient-leak keys removed, then any
// caller-supplied `overrides` applied on top (so a test that explicitly
// wants to set one of these three for its own fixture -- e.g. pointing at
// its own mkdtemp ledger -- still can, on purpose, in its own call).
export function isolatedChildEnv(overrides = {}, baseEnv = process.env) {
  const clean = { ...baseEnv };
  for (const key of AMBIENT_LEDGER_ENV_KEYS) delete clean[key];
  return { ...clean, ...overrides };
}

// withIsolatedAmbientLedgerEnv -- for in-process callers (no child process,
// so there is no `env` option to pass) that read process.env directly.
// Saves each key's current value (or "absent"), deletes it, runs `fn`, then
// restores exactly what was there before -- even on throw.
export function withIsolatedAmbientLedgerEnv(fn) {
  const saved = new Map();
  for (const key of AMBIENT_LEDGER_ENV_KEYS) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined,
    );
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of AMBIENT_LEDGER_ENV_KEYS) {
      const prior = saved.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }
}
