// HYK-439 2R (coder-task.md §1): shared POSIX-shell resolution helper.
//
// Why this exists: scripts/check/hyk462-seat-config-injection.test.mjs used
// to resolve a bash path by taking the literal FIRST LINE of `where bash` /
// `which bash` output, with no Git-for-Windows priority and no functional
// check. On a machine where Git-for-Windows isn't on PATH, that first line
// is Windows' own WSL launcher shim (C:\Windows\System32\bash.exe or
// ...\WindowsApps\bash.exe) -- and the test then actually spawned it
// (`spawnSync(bashPath, ["-c", command])`), which starts the WSL virtual
// machine (vmmem) as a side effect every time that test file runs (HYK-439
// §0-2).
//
// This module fixes that with three layers (coder-task.md §1, all three
// required):
//   1. Git-for-Windows candidates are tried FIRST, by fixed absolute path,
//      checked with `existsSync` (a filesystem stat, not a process launch --
//      it never risks waking anything).
//   2. A cheap, pre-spawn STRING filter (`isWslLauncherPath`) drops any
//      candidate whose resolved path sits under System32 or WindowsApps --
//      applied BEFORE a candidate is ever handed to the functional probe.
//      This matters because probing a candidate means spawning it: deciding
//      "is this WSL?" by running it and inspecting the result is already too
//      late, the VM has already woken. The filter is applied to `where`/
//      `which` output (bare `bash`/`sh` are never spawned directly -- they
//      are resolved to absolute paths first, exactly so this filter can see
//      them before anything is spawned).
//   3. A functional probe (glob expansion + clean cwd release, ported
//      verbatim from selfcheck-inventory.test.mjs's review-9-defect-1 fix)
//      is still run on every surviving candidate -- the string filter is a
//      cheap pre-filter, not a replacement for actually verifying the
//      candidate behaves like a POSIX shell on this filesystem.
//
// There is no WSL fallback: if nothing survives, callers get `null` and
// should skip honestly (see resolveBashPath in hyk462-seat-config-
// injection.test.mjs) rather than fall back to a bare name that could
// resolve to WSL and reintroduce the exact problem this module exists to
// avoid.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const GIT_FOR_WINDOWS_SHELLS = [
  "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

// Cheap, pre-spawn filter: true if `absPath` is Windows' own WSL launcher
// shim location. Both hit locations observed on this machine
// (C:\Windows\System32\bash.exe and ...\WindowsApps\bash.exe) qualify.
// String-only -- never spawns anything, so it is safe to run on every
// candidate before any of them are probed.
export function isWslLauncherPath(absPath) {
  const normalized = String(absPath).toLowerCase();
  return (
    normalized.includes("\\system32\\") ||
    normalized.includes("\\windowsapps\\")
  );
}

// Resolve bare names (e.g. "bash", "sh") to absolute paths via `where`
// (Windows) or `which` (POSIX / CI Linux runners, where `where` doesn't
// exist), dropping any hit that is a WSL launcher path per
// isWslLauncherPath above. This is the ONLY place bare names are looked up:
// the returned paths are always absolute, so nothing downstream spawns a
// bare name and lets the OS's own PATH search silently pick the WSL shim.
export function resolvedNonWslCandidates(names) {
  const found = [];
  for (const name of names) {
    for (const lookupCommand of ["where", "which"]) {
      let out;
      try {
        out = execFileSync(lookupCommand, [name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        continue; // this lookup command is missing on this platform, or found no match -- try the next one
      }
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !isWslLauncherPath(trimmed)) found.push(trimmed);
      }
      break; // this lookup command exists on this platform -- don't also run the other
    }
  }
  return found;
}

// Functional probe (ported verbatim from selfcheck-inventory.test.mjs's
// review-9-defect-1 fix): prove the candidate behaves like a POSIX shell on
// THIS filesystem -- glob expansion + clean cwd release -- rather than
// merely existing or returning exit 0. This is exactly what WSL bash fails
// (it doesn't share Windows filesystem semantics), and stays as a second
// gate even though isWslLauncherPath above should already have excluded it
// by path -- the string filter is a cheap pre-filter, not a replacement.
export function functionalShellProbe(cmd) {
  const dir = mkdtempSync(join(tmpdir(), "shell-probe-"));
  let ok;
  try {
    mkdirSync(join(dir, "scripts", "check"), { recursive: true });
    for (const f of ["a.test.mjs", "b.test.mjs"])
      writeFileSync(join(dir, "scripts", "check", f), "//\n", "utf8");
    // (1) the glob must expand POSIX-style to both fixture files in argv
    const script = `set -- scripts/check/*.test.mjs\nfor a in "$@"; do echo "ARG:$a"; done`;
    const out = execFileSync(cmd, ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const argv = out
      .split("\n")
      .filter((l) => l.startsWith("ARG:"))
      .map((l) => l.slice(4));
    ok = ["a.test.mjs", "b.test.mjs"].every((f) =>
      argv.some((a) => a.endsWith(f)),
    );
  } catch {
    ok = false; // missing binary, non-shell, or glob machinery threw
  }
  // (2) cleanup must succeed without EPERM -- WSL bash keeps a handle on the
  //     Windows cwd, so this throws and disqualifies the candidate.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    ok = false;
  }
  return ok;
}

// Resolve a POSIX-capable shell for spawning hook commands / test oracles,
// without ever spawning (and thereby waking) a WSL launcher.
//
// Order: (1) fixed Git-for-Windows paths, existence-checked (no spawn) and
// functional-probed in order; (2) bare names resolved to absolute paths via
// where/which, with WSL launcher paths already filtered out before probing.
// Returns null (never a WSL fallback) if nothing functional is found --
// callers should skip honestly rather than fall back to a name that could
// resolve to WSL.
//
// All three parameters are injectable so unit tests can pin the ordering
// and filtering logic without spawning any real shell.
export function findPosixShellSafe({
  probe = functionalShellProbe,
  gitForWindowsCandidates = GIT_FOR_WINDOWS_SHELLS,
  bareNames = ["sh", "bash"],
  resolveBareNames = resolvedNonWslCandidates,
  existsCheck = existsSync,
} = {}) {
  for (const candidate of gitForWindowsCandidates) {
    if (existsCheck(candidate) && probe(candidate)) return candidate;
  }
  for (const candidate of resolveBareNames(bareNames)) {
    if (probe(candidate)) return candidate;
  }
  return null;
}
