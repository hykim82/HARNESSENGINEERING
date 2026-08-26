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

// HYK-359 2R P1-2 (검토자 실사고, msg 원문 coder-task.md §2): 1R's
// isolatedChildEnv shallow-merged `overrides` onto the cleaned base WITHOUT
// stripping `overrides` itself. relay-handshake.test.mjs's two mutation call
// sites passed `overrides = { ...process.env, ADMISSION_LEDGER_PATH: x,
// ADMISSION_LOCK_PATH: y }` -- a common, easy-to-write shape ("just spread
// process.env and override the two keys I care about") -- which silently
// resurrected DISPATCH_RECEIPT_PATH (the one key that call site never
// mentioned) straight from the ambient shell, through `overrides`'s own
// spread, defeating the whole point of this module. 검토자가 ambient-on
// 5건 실패로 실측했다.
//
// Fix: isolatedChildEnv now strips the three protected keys from BOTH
// `baseEnv` AND `overrides`, unconditionally -- so no shape of `overrides`,
// including one built by spreading `process.env`, can ever put one of the
// three keys back. This is a deliberate CONTRACT CHANGE from 1R: a caller
// can no longer set ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
// DISPATCH_RECEIPT_PATH by putting them directly inside `overrides` at all --
// there is now exactly one sanctioned way to do that on purpose, see
// isolatedChildEnvWithLedger below.
function stripAmbientLedgerKeys(env) {
  const clean = { ...env };
  for (const key of AMBIENT_LEDGER_ENV_KEYS) delete clean[key];
  return clean;
}

// isolatedChildEnv -- build the `env` option for a spawnSync/execFileSync
// call: a copy of `baseEnv` (defaults to this process's own env, so
// unrelated ambient vars a fixture legitimately relies on -- PATH, TEMP,
// etc. -- are preserved) with the three ambient-leak keys removed from BOTH
// `baseEnv` and `overrides`, then `overrides` merged on top for every OTHER
// key. Because both sides are stripped, there is no `overrides` shape --
// not even one that spreads `...process.env` wholesale -- that can smuggle
// one of the three protected keys back in. A caller that needs to
// deliberately set one of them (e.g. pointing a child at its own mkdtemp
// ledger fixture) must use isolatedChildEnvWithLedger instead; plain
// `overrides` can no longer do it, on purpose.
export function isolatedChildEnv(overrides = {}, baseEnv = process.env) {
  return {
    ...stripAmbientLedgerKeys(baseEnv),
    ...stripAmbientLedgerKeys(overrides),
  };
}

// isolatedChildEnvWithLedger -- the ONLY sanctioned way to deliberately set
// one or more of the three protected keys on a child's env (e.g. "point
// this spawned CLI at MY OWN mkdtemp ledger so I can assert exit 3 fires").
// `ledgerEnv`'s three named fields are applied strictly AFTER
// isolatedChildEnv's stripping, so they always win regardless of what
// `overrides`/`baseEnv` contained -- including ambient noise that survived
// in `overrides` via a `...process.env` spread (the exact HYK-359 2R P1-2
// shape). A field left `undefined` is not set at all (stays absent, same as
// isolatedChildEnv's default -- it does NOT fall back to reading the
// ambient value for that key).
export function isolatedChildEnvWithLedger(
  ledgerEnv = {},
  overrides = {},
  baseEnv = process.env,
) {
  const base = isolatedChildEnv(overrides, baseEnv);
  const explicit = {};
  if (ledgerEnv.admissionLedgerPath !== undefined) {
    explicit.ADMISSION_LEDGER_PATH = ledgerEnv.admissionLedgerPath;
  }
  if (ledgerEnv.admissionLockPath !== undefined) {
    explicit.ADMISSION_LOCK_PATH = ledgerEnv.admissionLockPath;
  }
  if (ledgerEnv.dispatchReceiptPath !== undefined) {
    explicit.DISPATCH_RECEIPT_PATH = ledgerEnv.dispatchReceiptPath;
  }
  return { ...base, ...explicit };
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
