// HYK-439 2R (coder-task.md §1): unit tests for the shared POSIX-shell
// resolution helper (posix-shell-resolve.mjs). These pin the three required
// layers -- Git-for-Windows priority, the pre-spawn WSL-launcher string
// filter, and the functional probe -- using injected fakes so the tests
// never depend on (or risk waking) any real shell, plus a handful of
// real-machine value tests that exercise the actual `where`/`which` and
// filesystem calls on whatever machine runs this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWslLauncherPath,
  resolvedNonWslCandidates,
  functionalShellProbe,
  findPosixShellSafe,
  GIT_FOR_WINDOWS_SHELLS,
} from "./posix-shell-resolve.mjs";

// --- isWslLauncherPath: the cheap, pre-spawn string filter ------------------

test("isWslLauncherPath: rejects the two real WSL launcher shim locations observed on Windows (HYK-439 §0-3)", () => {
  assert.equal(isWslLauncherPath("C:\\Windows\\System32\\bash.exe"), true);
  assert.equal(
    isWslLauncherPath(
      "C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
    ),
    true,
  );
});

test("isWslLauncherPath: is case-insensitive", () => {
  assert.equal(isWslLauncherPath("c:\\windows\\system32\\bash.exe"), true);
  assert.equal(isWslLauncherPath("C:\\WINDOWS\\SYSTEM32\\Bash.EXE"), true);
});

test("isWslLauncherPath: accepts Git-for-Windows paths and other non-System32/WindowsApps paths", () => {
  for (const p of GIT_FOR_WINDOWS_SHELLS) {
    assert.equal(isWslLauncherPath(p), false, p);
  }
  assert.equal(
    isWslLauncherPath("C:\\Program Files\\Git\\bin\\bash.exe"),
    false,
  );
});

// --- resolvedNonWslCandidates: real `where`/`which`, filtered ---------------

test("resolvedNonWslCandidates: on THIS machine, resolving bare `bash` never returns a System32/WindowsApps hit (real where/which + real filter)", () => {
  const hits = resolvedNonWslCandidates(["bash"]);
  for (const hit of hits) {
    assert.equal(
      isWslLauncherPath(hit),
      false,
      `resolvedNonWslCandidates must never return a WSL launcher path, got: ${hit}`,
    );
  }
});

test("resolvedNonWslCandidates: a name that resolves to nothing on this platform returns no hits, not a throw", () => {
  const hits = resolvedNonWslCandidates([
    "definitely-not-a-real-shell-binary-xyz",
  ]);
  assert.deepEqual(hits, []);
});

// --- functionalShellProbe: ported behavior from selfcheck-inventory.test.mjs -

test("functionalShellProbe: rejects a missing/non-shell binary", () => {
  assert.equal(
    functionalShellProbe("definitely-not-a-real-shell-binary-xyz"),
    false,
  );
});

// --- findPosixShellSafe: ordering and filtering, fully injected -------------

test("findPosixShellSafe: returns the first Git-for-Windows candidate that exists AND passes the probe, without ever calling resolveBareNames", () => {
  let resolveBareNamesCalled = false;
  const found = findPosixShellSafe({
    gitForWindowsCandidates: ["gfw-1", "gfw-2"],
    existsCheck: (p) => p === "gfw-2",
    probe: (p) => p === "gfw-2",
    resolveBareNames: () => {
      resolveBareNamesCalled = true;
      return [];
    },
  });
  assert.equal(found, "gfw-2");
  assert.equal(resolveBareNamesCalled, false);
});

test("findPosixShellSafe: an existing Git-for-Windows candidate that FAILS the functional probe is skipped, not returned", () => {
  const found = findPosixShellSafe({
    gitForWindowsCandidates: ["gfw-1"],
    existsCheck: () => true,
    probe: (p) => (p === "gfw-1" ? false : p === "bare-good"),
    resolveBareNames: () => ["bare-good"],
  });
  assert.equal(found, "bare-good");
});

test("findPosixShellSafe: falls through to resolved bare-name candidates only when no Git-for-Windows candidate exists", () => {
  const found = findPosixShellSafe({
    gitForWindowsCandidates: ["gfw-1", "gfw-2"],
    existsCheck: () => false,
    probe: (p) => p === "resolved-bash",
    resolveBareNames: (names) => {
      assert.deepEqual(names, ["sh", "bash"]);
      return ["resolved-bash"];
    },
  });
  assert.equal(found, "resolved-bash");
});

test("findPosixShellSafe: returns null (no WSL fallback) when nothing survives, even if resolveBareNames returns a WSL-shaped path -- callers, not this function, decide whether that's reachable (resolveBareNames is expected to already have filtered it, this just proves there's no separate fallback path here)", () => {
  const found = findPosixShellSafe({
    gitForWindowsCandidates: [],
    existsCheck: () => false,
    probe: () => false,
    resolveBareNames: () => [],
  });
  assert.equal(found, null);
});

// --- Real-machine oracle: documents what this exact machine resolves to ----

test("[oracle] findPosixShellSafe on THIS machine, with no overrides", () => {
  const found = findPosixShellSafe();
  console.log(`[posix-shell-resolve oracle] findPosixShellSafe -> ${found}`);
  if (found !== null) {
    assert.equal(typeof found, "string");
    assert.equal(
      isWslLauncherPath(found),
      false,
      "the real resolver must never return a WSL launcher path",
    );
  }
});
