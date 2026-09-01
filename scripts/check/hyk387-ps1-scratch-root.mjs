// HYK-404-race-1: shared, non-test module holding the scratch root that
// control-room-patch-apply-hyk387-receipt-pointer-effect.test.mjs's
// withPs1FixtureDir() builds its throwaway PowerShell fixture directories
// under.
//
// Factored out (rather than left as a local const in that test file) so
// dispatch-gate-live-path-guard-concurrent-race.test.mjs can import the
// exact real path this codebase actually uses -- not a hand-copied guess
// that could silently drift -- without importing a `*.test.mjs` file's
// top-level `test(...)` registrations into its own process (node's test
// runner isolates each test file into its own child process by default).
//
// Under `os.tmpdir()`, never under this repo's live `.harness/` -- see
// control-room-patch-apply-hyk387-receipt-pointer-effect.test.mjs's own
// header for the incident this fixes (HYK-404-race-1: nesting this under
// the live `.harness/` tree raced dispatch-gate-live-path-guard.test.mjs's
// fingerprint of that same tree whenever both test files ran concurrently).
import { join } from "node:path";
import { tmpdir } from "node:os";

export const SCRATCH_ROOT = join(tmpdir(), "hyk387-3r-ps1-scratch");
