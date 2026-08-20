// HYK-286-codex-collect-1 (coder-task.md §4) -- the fingerprint check
// (control-room-patch-apply.mjs's byte-identity test) proves the applied
// fixture's TEXT matches what the document produces, but it never proves
// that text actually BEHAVES the way §2 claims (first-line timing hiccups
// get skipped, real enumeration failures still fail). This module closes
// that gap by extracting a candidate `Confirm-GetCodexSnapshot` function
// body and invoking it in a real PowerShell process against synthetic
// rollout files on disk -- same pattern as HYK-323's
// seat-proof-wrapper-behavior.mjs (fingerprint judges what the text IS,
// this judges what it DOES).
//
// Honesty limit (same wording required in the result file): this only runs
// where PowerShell is actually installed (Windows, or pwsh elsewhere). CI
// without PowerShell must treat "not found" as an explicit skip with a
// printed reason, never a silent pass. This module also does not attempt
// to defend against a deliberately forged rollout file (coder-task.md §0:
// "고의로 꾸민 rollout 파일을 막는 것은 이 조각의 범위가 아니다") -- it
// only proves the *timing-accident* shapes (empty / whitespace / truncated
// JSON first line) are tolerated and a *real* enumeration failure still
// fails.
//
// HYK-286-codex-collect-2 (coder-task.md §1, CI PR #192 run 32347838848):
// the enumeration-failure regression case used to call the Windows-only
// `icacls` binary UNCONDITIONALLY, regardless of platform. This module's
// own comment already promised "skip with a reason if icacls is
// unavailable", but no code actually checked platform or availability --
// on ubuntu-latest (pwsh present, no icacls) that crashed the whole test
// with `spawnSync icacls ENOENT` instead of skipping. Fixed by branching on
// `platform`: Windows still uses `icacls` (guarded by an availability
// check), everywhere else uses a plain `chmodSync(dir, 0o000)` -- no
// external tool needed, and it actually verifies the regression axis for
// real on CI instead of merely not-crashing. If the permission removal
// itself turns out not to restrict access (e.g. a root-run process, where
// POSIX mode bits are not enforced), that is detected and reported as an
// explicit skip reason rather than silently passing.
//
// I/O: this module DOES touch the filesystem (temp dirs, synthetic rollout
// files) and DOES spawn a child process -- it cannot be a pure function.
// Every temp artifact is written under the OS temp dir and removed in a
// `finally`.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PS_CANDIDATES = ["pwsh", "powershell.exe", "powershell"];

// Returns the first working PowerShell executable name, or null if none is
// on PATH.
export function findPowerShell() {
  for (const candidate of PS_CANDIDATES) {
    try {
      execFileSync(
        candidate,
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// Extracts a `function <name>([params]) { ... }` block from PowerShell
// source text by brace-balance counting from the matching opening `{`.
// Returns null if the function name is not found or braces never balance
// (malformed source -- caller should treat that as a harness error, not
// silently proceed with a truncated function body).
export function extractFunctionText(sourceText, functionName) {
  const startMarker = `function ${functionName}(`;
  const startIdx = sourceText.indexOf(startMarker);
  if (startIdx === -1) return null;
  const braceOpenIdx = sourceText.indexOf("{", startIdx);
  if (braceOpenIdx === -1) return null;
  let depth = 0;
  for (let i = braceOpenIdx; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return sourceText.slice(startIdx, i + 1);
    }
  }
  return null;
}

function psQuote(path) {
  return path.replace(/`/g, "``").replace(/"/g, '`"');
}

// Writes a synthetic rollout-*.jsonl file. `firstLine` is written exactly
// as given (no trailing content assumed to be valid JSON -- callers control
// that to build each timing-accident shape); a second line is appended so
// the file is not itself empty (mirrors a real in-progress rollout, which
// already has *some* bytes on disk before the first line finishes).
function writeRollout(dir, name, firstLine) {
  const path = join(dir, name);
  writeFileSync(path, `${firstLine}\n{"type":"other"}\n`, "utf8");
  return path;
}

export function normalSessionMetaLine(worktree) {
  return JSON.stringify({
    type: "session_meta",
    payload: { cwd: worktree },
  });
}

// Runs `functionDefinitionText` (a full `function Confirm-GetCodexSnapshot
// (...) { ... }` block) in a real PowerShell process against a
// caller-built `sessionsDir`, using the SAME calling convention
// dispatch-worker.ps1 uses (`Confirm-GetCodexSnapshot $SessionsDir
// $TargetWorktree`), and returns the parsed result object `{ ok,
// totalBytes, error, fileNames, fileBytes }` (files keyed by leaf name,
// not full path, so assertions don't depend on the temp dir's location).
//
// Returns `{ ok: false, error: "ERROR:..." }`-shaped harness failure (never
// thrown) if PowerShell itself errored running the harness (e.g. a parse
// error in the candidate function text) -- callers must not mistake a
// harness failure for a real COLLECTION_FAILED result.
export function runCodexSnapshotBehavior(
  functionDefinitionText,
  sessionsDir,
  targetWorktree,
  psExe,
) {
  const exe = psExe ?? findPowerShell();
  if (!exe) {
    throw new Error(
      "runCodexSnapshotBehavior: no PowerShell executable found on PATH -- call findPowerShell() first and skip with a reason instead of calling this",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "codex-snapshot-behavior-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    const harness = [
      `$ErrorActionPreference = "Continue"`,
      // Real dispatch-worker.ps1's Norm() -- the candidate body calls
      // `(Norm $TargetWorktree)`.
      `function Norm([string]$p) {`,
      `  if ([string]::IsNullOrWhiteSpace($p)) { return "" }`,
      `  return ($p -replace '\\\\', '/').TrimEnd('/').ToLowerInvariant()`,
      `}`,
      "",
      functionDefinitionText,
      "",
      `$__result = Confirm-GetCodexSnapshot "${psQuote(sessionsDir)}" "${psQuote(targetWorktree)}"`,
      `$__out = [ordered]@{`,
      `  ok = $__result.ok`,
      `  totalBytes = $__result.totalBytes`,
      `  error = [string]$__result.error`,
      `  fileNames = @($__result.files.Keys | ForEach-Object { Split-Path $_ -Leaf })`,
      `  fileBytes = @($__result.files.Values)`,
      `}`,
      `Write-Output "BEHAVIOR_RESULT_JSON_START"`,
      `$__out | ConvertTo-Json -Compress`,
      `Write-Output "BEHAVIOR_RESULT_JSON_END"`,
    ].join("\n");
    writeFileSync(harnessPath, harness, "utf8");

    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync(
        exe,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
        { encoding: "utf8" },
      );
    } catch (err) {
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? String(err.message ?? err);
    }

    const match = stdout.match(
      /BEHAVIOR_RESULT_JSON_START\r?\n([\s\S]*?)\r?\nBEHAVIOR_RESULT_JSON_END/,
    );
    if (!match) {
      return { ok: false, error: `ERROR:${(stdout + stderr).slice(0, 1000)}` };
    }
    try {
      return JSON.parse(match[1]);
    } catch (parseErr) {
      return {
        ok: false,
        error: `ERROR:JSON_PARSE_FAILED:${parseErr.message}:${match[1].slice(0, 500)}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Creates a directory tree with rollout files matching each `{ name,
// firstLine }` spec under `sessionsDir` (flat, matching how
// Confirm-GetCodexSnapshot's `-Recurse -Filter "rollout-*.jsonl"` would see
// either a flat or nested layout -- flat is enough to exercise the
// function's own logic, which doesn't care about directory depth).
export function buildSessionsDir(baseDir, rolloutSpecs) {
  const sessionsDir = join(baseDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (const spec of rolloutSpecs) {
    writeRollout(sessionsDir, spec.name, spec.firstLine);
  }
  return sessionsDir;
}

// Returns true iff an `icacls` executable actually runs on this PATH (not
// just "the platform is Windows" -- a Windows host could still be missing
// it, e.g. a minimal container image).
export function isIcaclsAvailable() {
  try {
    execFileSync("icacls", ["/?"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// Builds a sessions dir whose enumeration (`Get-ChildItem -Recurse`) itself
// throws/fails -- a REAL collection failure, distinct from any per-file
// first-line timing accident. Returns `{ ok: true, sessionsDir }` on
// success, or `{ ok: false, sessionsDir, reason }` if a genuinely
// permission-denied directory could not be constructed on this host --
// callers MUST treat `ok:false` as an explicit skip (print `reason`), never
// silently proceed as if the case ran (HYK-286-codex-collect-2: the
// previous version threw ENOENT instead of returning this shape, which is
// exactly what crashed CI).
//
// `platform` is injectable (defaults to `process.platform`) so tests can
// force either branch's code path without needing to actually run on that
// OS -- see codex-snapshot-behavior.test.mjs's portability self-check.
export function buildUnreadableSessionsDir(
  baseDir,
  { platform = process.platform } = {},
) {
  const sessionsDir = join(baseDir, "sessions");
  const lockedDir = join(sessionsDir, "locked");
  mkdirSync(lockedDir, { recursive: true });
  writeFileSync(join(lockedDir, "rollout-locked.jsonl"), "x\n", "utf8");

  if (platform === "win32") {
    if (!isIcaclsAvailable()) {
      return {
        ok: false,
        sessionsDir,
        reason:
          "icacls not found on PATH -- cannot construct a real permission-denied directory on this Windows host (HYK-286-codex-collect-2 honesty limit: skip, do not crash)",
      };
    }
    const user = process.env.USERNAME ?? process.env.USER;
    execFileSync("icacls", [lockedDir, "/deny", `${user}:(OI)(CI)(RD)`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, sessionsDir };
  }

  // POSIX (Linux/macOS, e.g. ubuntu-latest CI): no external tool needed --
  // stripping all mode bits makes the directory unreadable/unlistable to
  // any process that does not own the permission override (root).
  chmodSync(lockedDir, 0o000);
  try {
    readdirSync(lockedDir);
    // Listing still succeeded despite chmod 000 -- POSIX mode bits are not
    // being enforced on this host (root-run process, or a filesystem that
    // does not honor them). Restore access and report the honest reason
    // instead of silently treating this as a passed/skipped case either
    // way.
    chmodSync(lockedDir, 0o755);
    return {
      ok: false,
      sessionsDir,
      reason:
        "chmod 000 did not restrict directory access on this host (running as root, or POSIX mode bits not enforced by this filesystem) -- cannot construct a real permission-denied condition",
    };
  } catch {
    return { ok: true, sessionsDir };
  }
}

export function unlockSessionsDir(
  sessionsDir,
  { platform = process.platform } = {},
) {
  const lockedDir = join(sessionsDir, "locked");
  if (platform === "win32") {
    if (!isIcaclsAvailable()) return;
    const user = process.env.USERNAME ?? process.env.USER;
    try {
      execFileSync("icacls", [lockedDir, "/remove:d", user], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // best-effort cleanup -- rmSync in the caller's finally still runs,
      // and a leftover deny ACL on a temp dir is not this module's concern
      // to guarantee against.
    }
    return;
  }
  try {
    chmodSync(lockedDir, 0o755);
  } catch {
    // same best-effort posture as the Windows branch above.
  }
}
