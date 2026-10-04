// HYK-439 2R (coder-task.md §3): static "does reverting make it red" check.
//
// The bug this guards against (HYK-439 §0-2, fixed in this same round): code
// under scripts/ that resolves a POSIX shell by literally taking the first
// line of `where`/`which bash` output (`stdout.split(/\r?\n/)...[0]`) with
// no Git-for-Windows priority and no functional check. On a machine without
// Git-for-Windows on PATH, that first line is Windows' own WSL launcher
// shim -- spawning it wakes the WSL virtual machine as a side effect. The
// fix is posix-shell-resolve.mjs's findPosixShellSafe (coder-task.md §1);
// this check makes sure the naive shape doesn't quietly come back anywhere
// under scripts/ outside that one helper.
//
// Detection is two independent signals, both required, in the SAME file:
//   Signal 1 -- a literal "where" or "which" string used as a call argument
//     (e.g. `probeBash("where")`, `execFileSync("where", ...)`). This repo
//     has many *unrelated* `where`/`which` lookups (gitleaks, codex, pwsh --
//     HYK-439 1R §2-2 catalogued several), so Signal 1 alone is not enough.
//   Signal 2 -- the specific "first line of stdout" extraction idiom:
//     `.stdout` followed (within a short window, allowing a `.map`/`.filter`
//     chain in between) by `.split(/\r?\n/)` and eventually a `[0]` index.
// Both together is exactly the shape the original hyk462-seat-config-
// injection.test.mjs had (see this check's RED-proof run in the HYK-439 2R
// result file) and is narrow enough that it did not fire anywhere else in
// this repo when this check was written (610 scripts/**/*.mjs files
// scanned, 0 offenses on the post-fix tree).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

const SIGNAL_1_WHERE_OR_WHICH_ARG = /\(\s*["'`](where|which)["'`]/;
const SIGNAL_2_STDOUT_FIRST_LINE =
  /\.stdout[\s\S]{0,20}\.split\(\/\\r\?\\n\/\)[\s\S]{0,150}\[0\]/;

// posix-shell-resolve.mjs itself legitimately probes `where`/`which` (Signal
// 1) -- it is the sanctioned place this repo does that. It does NOT have
// Signal 2's blind-first-line shape (it iterates every resolved line through
// isWslLauncherPath and functionalShellProbe rather than indexing [0]), so
// in practice this allowlist is not currently load-bearing -- it documents
// intent so a future edit that reintroduces Signal 2 there gets caught by
// review rather than silently passing "because it's the helper."
const ALLOWED_RELATIVE_PATHS = new Set([
  "scripts/check/posix-shell-resolve.mjs",
]);

// Signal 3 (HYK-439 §7, 책임자 승인 2026-09-28 ㄴ): a bare `sh` / `bash` / `zsh`
// literal given as the FIRST argument of a spawn-family call anywhere outside
// the shared resolver. Spawning a bare name lets PATH search pick Windows' WSL
// launcher shim (HYK-439 §0-2), so the sanctioned route to a shell is
// findPosixShellSafe. Signal 3 is independent of signals 1+2, which are kept as
// they were.
const SIGNAL_3_SPAWN_BARE_SHELL_LITERAL =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*["'`](?:sh|bash|zsh)["'`]/;

// File-level allowlist for signal 3. Each entry carries its reason on one line.
const SIGNAL_3_ALLOWED = new Map([
  [
    "scripts/check/posix-shell-resolve.mjs",
    "the resolver itself: the one sanctioned place that turns a bare sh/bash into a fixed path",
  ],
  [
    "scripts/check/posix-shell-resolve.test.mjs",
    "pins the resolver's own behaviour with injected fakes; it never spawns a bare name",
  ],
  [
    "scripts/check/live-harness-scratch-guard-wire.test.mjs",
    "false positive: line 22 is a comment quoting the shape; the file has no real spawn of a bare shell",
  ],
  [
    "scripts/check/no-naive-shell-first-line-adoption.test.mjs",
    "its self-test fixtures spell the spawn shape inside string literals; the detector runs on those fixtures, not on this file's code",
  ],
]);

function listMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listMjsFiles(full));
    else if (/\.mjs$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function findNaiveShellFirstLineAdoptions({
  scriptsDir = SCRIPTS_DIR,
  repoRoot = REPO_ROOT,
  allowedRelativePaths = ALLOWED_RELATIVE_PATHS,
} = {}) {
  const offenses = [];
  for (const file of listMjsFiles(scriptsDir)) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    if (allowedRelativePaths.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (
      SIGNAL_1_WHERE_OR_WHICH_ARG.test(text) &&
      SIGNAL_2_STDOUT_FIRST_LINE.test(text)
    ) {
      offenses.push(rel);
    }
  }
  return offenses;
}

export function findBareShellSpawnLiterals({
  scriptsDir = SCRIPTS_DIR,
  repoRoot = REPO_ROOT,
  allowed = SIGNAL_3_ALLOWED,
} = {}) {
  const offenses = [];
  for (const file of listMjsFiles(scriptsDir)) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    if (allowed.has(rel)) continue;
    if (SIGNAL_3_SPAWN_BARE_SHELL_LITERAL.test(readFileSync(file, "utf8"))) {
      offenses.push(rel);
    }
  }
  return offenses;
}

test("no scripts/**/*.mjs file outside the shared resolver spawns a bare sh/bash/zsh literal as its first argument (HYK-439 §7)", () => {
  const offenses = findBareShellSpawnLiterals();
  assert.deepEqual(
    offenses,
    [],
    `found a spawn-family call whose first argument is a bare shell name outside posix-shell-resolve.mjs -- resolve it with findPosixShellSafe instead (this is the HYK-439 §0 WSL-wake shape):\n${offenses.join("\n")}`,
  );
});

test("no scripts/**/*.mjs file outside posix-shell-resolve.mjs adopts where/which's raw stdout first line as a shell path (HYK-439 §3)", () => {
  const offenses = findNaiveShellFirstLineAdoptions();
  assert.deepEqual(
    offenses,
    [],
    `found the naive where/which stdout-first-line-adoption shape outside the shared helper -- route through posix-shell-resolve.mjs's findPosixShellSafe instead (this is exactly the HYK-439 §0 WSL-wake bug):\n${offenses.join("\n")}`,
  );
});

// Self-test (does not touch the real repo tree): proves the two-signal
// detector actually fires RED on a synthetic fixture shaped like the
// historic bug, and stays quiet on a synthetic fixture shaped like the fix
// -- so this check's green-ness above is backed by a detector proven able
// to fire, not by a pattern that happens to never match anything.
test("[self-test] detector fires on a synthetic naive-adoption fixture and stays quiet on a synthetic fixed-shape fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "naive-shell-check-selftest-"));
  try {
    writeFileSync(
      join(dir, "offender.mjs"),
      [
        "function probeBash(command) {",
        '  return spawnSync(command, ["bash"], { encoding: "utf8" });',
        "}",
        "function resolveBashPath() {",
        '  let bashProbe = probeBash("where");',
        "  return bashProbe.stdout",
        "    .split(/\\r?\\n/)",
        "    .map((l) => l.trim())",
        "    .filter(Boolean)[0];",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "clean.mjs"),
      [
        'import { findPosixShellSafe } from "./posix-shell-resolve.mjs";',
        "function resolveBashPath(t) {",
        "  return findPosixShellSafe();",
        "}",
      ].join("\n"),
      "utf8",
    );
    const offenses = findNaiveShellFirstLineAdoptions({
      scriptsDir: dir,
      repoRoot: dir,
    });
    assert.deepEqual(offenses, ["offender.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Self-test for signal 3 (HYK-439 §7): fires on a bare-shell spawn, stays quiet
// when the first argument is a resolved variable -- the sanctioned shape.
test("[self-test §7] bare-shell spawn detector fires on a bare-name spawn and stays quiet on a resolved-variable spawn", () => {
  const dir = mkdtempSync(join(tmpdir(), "bare-shell-spawn-selftest-"));
  try {
    writeFileSync(
      join(dir, "offender.mjs"),
      [
        'import { spawnSync } from "node:child_process";',
        'spawnSync("bash", ["-c", "true"]);',
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "clean.mjs"),
      [
        'import { spawnSync } from "node:child_process";',
        'import { findPosixShellSafe } from "./posix-shell-resolve.mjs";',
        "const sh = findPosixShellSafe();",
        'spawnSync(sh, ["-c", "true"]);',
      ].join("\n"),
      "utf8",
    );
    const offenses = findBareShellSpawnLiterals({
      scriptsDir: dir,
      repoRoot: dir,
      allowed: new Map(),
    });
    assert.deepEqual(offenses, ["offender.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
