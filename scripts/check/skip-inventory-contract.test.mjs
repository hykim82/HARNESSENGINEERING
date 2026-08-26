// HYK-364: locks in, BY NAME (never by count), which specific `.test.mjs`
// cases the CI-canonical suite skips depending on this environment's
// available tooling/wiring -- and requires the skip to fire ONLY when the
// underlying condition actually holds.
//
// Origin: task HYK-364 found the observed skip counts (3 in this worktree /
// 6 in a fresh isolated clone / 10 on real CI) were never caused by the
// ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH env vars
// (a controlled A/B run through the real isolated-suite-runner.mjs, same
// commit/tool/machine, produced byte-identical skip sets with those vars set
// vs unset). The actual axis is which of four local capabilities exist:
// installed .git/hooks/{commit-msg,pre-commit}, `gitleaks` on PATH, the
// control-room `dispatch-worker.ps1` script, and the git-untracked
// `.claude/settings.local.json` file. Each of the 10 known-conditional test
// cases already carries its own honest skip reason (`t.skip()`/`skip:`) --
// this file does not touch any of that production skip logic. It only adds
// an independent, exact, BY-NAME check that (a) none of the 10 silently
// vanished or got renamed, (b) each one's skip/run status matches this
// file's OWN, independently-computed capability probe, and (c, HYK-364 2R
// fix) no test OUTSIDE the known 10 is skipped either -- so if the
// production skip *condition* itself is ever mutated (e.g. inverted, or
// changed to check the wrong path), OR a brand-new conditional skip is
// introduced anywhere in the four affected files, this contract goes red
// instead of silently drifting. (c) is set equality (observed skip set vs
// expected skip set, both directions), not list traversal -- 1R's version
// only walked the known-names list, so a skip appearing OUTSIDE that list
// was invisible to it (review-1's exact repro: a real, disk-written
// `t.skip("mutation probe")` added to nc-gitleaks.test.mjs stayed green).
//
// Two of the ten (`(47)`/`(58)` in selfcheck-inventory.test.mjs) already
// expose their skip DECISION as an exported pure function
// (resolveRealRepoGuard47/58) -- reused here directly rather than
// re-implemented, so this file can never disagree with production about
// what ".claude/settings.local.json present" means.
//
// The "second real checkout" corroboration case (nc-githook-install.test.mjs
// "(additional, environment-conditional)") has a materially more complex
// skip condition (MAIN_ROOT resolution + actual hook-content divergence
// against a second real checkout on this machine) that this file does not
// re-implement -- duplicating it loosely would either drift from production
// or just re-describe it, neither of which adds a real check. This file only
// pins the ONE invariant that is cheap to state and independently true:
// that case can never RUN (never silently pass/fail for real) when installed
// hooks are absent, because "an installed hook to actually exist" is one of
// its own AND-ed preconditions. When hooks ARE installed, this file leaves
// that case's skip/run status to production's own logic (documented gap,
// not silently assumed away).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRealRepoGuard47,
  resolveRealRepoGuard58,
} from "./selfcheck-inventory.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /[\\/]$/,
  "",
);

function absoluteRealPath(cwd, rawPath) {
  return realpathSync(resolve(cwd, rawPath));
}

function repoRoot(cwd) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function commonDir(cwd) {
  return execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// Mirrors nc-githook-install.test.mjs's own INSTALLED_HOOKS_PRESENT
// computation exactly (same git-common-dir resolution, same two files) --
// independently re-derived here (not imported, since that file exports
// nothing) so a mutation to THAT file's own copy of this logic still shows
// up as a mismatch against this one.
const GIT_ROOT = absoluteRealPath(process.cwd(), repoRoot(process.cwd()));
const COMMON_DIR = absoluteRealPath(GIT_ROOT, commonDir(GIT_ROOT));
const HOOKS_DIR = join(COMMON_DIR, "hooks");
const INSTALLED_HOOKS_PRESENT =
  existsSync(join(HOOKS_DIR, "commit-msg")) &&
  existsSync(join(HOOKS_DIR, "pre-commit"));

function which(bin) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}
const GITLEAKS_ON_PATH = which("gitleaks") || which("gitleaks.exe");

const CONTROL_ROOM_SCRIPT_PATH =
  "D:\\문서관리\\하네스-관제실\\dispatch-worker.ps1";
const CONTROL_ROOM_PRESENT = existsSync(CONTROL_ROOM_SCRIPT_PATH);

const SETTINGS_LOCAL_PRESENT =
  resolveRealRepoGuard47({ repoRoot: GIT_ROOT }).outcome !== "skip";
// (47) and (58) both gate on the identical file -- resolveRealRepoGuard58
// would report the same presence/absence; asserted directly below via its
// own call so a divergence between the two guards' presence checks (a real
// bug: they should always agree) also goes red.

// Runs exactly the four affected files (never the full 286-file
// CI-canonical set -- this is a narrow, fast, targeted probe, not the
// isolated-suite-runner this task's coder-task.md §4 gates behind ORCH
// permission) inside THIS worktree with the TAP reporter pinned (HYK-359 4R
// precedent: Node's default reporter is version-dependent, TAP is not).
const AFFECTED_FILES = [
  "scripts/check/nc-githook-install.test.mjs",
  "scripts/check/nc-gitleaks.test.mjs",
  "scripts/check/seat-proof-wrapper-shape.test.mjs",
  "scripts/check/selfcheck-inventory.test.mjs",
];

function runAffectedFiles() {
  // HYK-359 1R precedent (see this repo's hyk359-ambient-env-regression.test.mjs
  // module header): this file is itself run under `node --test`, so
  // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID are already set in process.env --
  // inherited by the child below, they make the child's own `node --test`
  // detect "recursive test run" and silently skip everything (exit 0, 0
  // tests parsed as skipped/absent instead of run), which would make every
  // "test case not found" assertion below fire for the wrong reason.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const res = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...AFFECTED_FILES],
    { cwd: ROOT, encoding: "utf8", env, maxBuffer: 1024 * 1024 * 200 },
  );
  assert.equal(
    res.error,
    undefined,
    `spawning the affected-file probe failed: ${res.error?.message}`,
  );
  return res.stdout ?? "";
}

// Parses TAP's per-test line into { name, skipped }. A skipped test appears
// as `ok N - <name> # SKIP <reason>`; a run test (pass or fail) never has
// the trailing `# SKIP` directive.
function parseTapNamedResults(stdout) {
  const results = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(?:ok|not ok) \d+ - (.+?)(?: # (SKIP\b.*))?$/);
    if (!m) continue;
    const [, name, skipDirective] = m;
    results.set(name, { skipped: Boolean(skipDirective) });
  }
  return results;
}

// The exact 10 test names HYK-364 identified, each paired with the
// independently-computed boolean this file expects to decide its
// skip/run status. `null` means "this file does not pin that direction of
// the invariant" (see module header, second-checkout case).
const EXPECTATIONS = [
  {
    file: "scripts/check/nc-githook-install.test.mjs",
    name: "NC-1 install/measurement (environment-conditional): installed .git/hooks/* also exist with a sane size, when this checkout has them installed",
    expectSkipped: !INSTALLED_HOOKS_PRESENT,
  },
  {
    file: "scripts/check/nc-githook-install.test.mjs",
    name: "NC-1 install/measurement (environment-conditional): the INSTALLED copies (when present) reference the same modules as the tracked mirror",
    expectSkipped: !INSTALLED_HOOKS_PRESENT,
  },
  {
    file: "scripts/check/nc-githook-install.test.mjs",
    name: "NC-1 install/measurement (additional, environment-conditional): the same location-dependent mechanism reproduces against this machine's two REAL checkouts -- corroborates, does not replace, the synthetic proof above",
    // Necessary-condition-only pin -- see module header.
    expectSkippedWhenHooksAbsent: true,
  },
  {
    file: "scripts/check/nc-gitleaks.test.mjs",
    name: "NC-1 gitleaks/attack: a synthetic dummy secret staged for commit -> BLOCKED (protect --staged, local hook's real invocation)",
    expectSkipped: !GITLEAKS_ON_PATH,
  },
  {
    file: "scripts/check/nc-gitleaks.test.mjs",
    name: "NC-1 gitleaks/attack: no secret staged -> passes cleanly (no false positive on ordinary code)",
    expectSkipped: !GITLEAKS_ON_PATH,
  },
  {
    file: "scripts/check/nc-gitleaks.test.mjs",
    name: "NC-1 gitleaks/measurement (environment-conditional): the INSTALLED pre-commit copy (when present) also documents the fail-open branch",
    expectSkipped: !INSTALLED_HOOKS_PRESENT,
  },
  {
    file: "scripts/check/nc-gitleaks.test.mjs",
    name: "NC-1 gitleaks/gap: local `--staged` scope misses a secret that exists only in prior history (CI's `--source .` scope catches it) -> KNOWN GAP",
    expectSkipped: !GITLEAKS_ON_PATH,
  },
  {
    file: "scripts/check/seat-proof-wrapper-shape.test.mjs",
    name: "실물: 현재 관제실 dispatch-worker.ps1이 있으면 정본 지문과 일치(회귀 0); 없으면(CI) 사유와 함께 skip",
    expectSkipped: !CONTROL_ROOM_PRESENT,
  },
  {
    file: "scripts/check/selfcheck-inventory.test.mjs",
    name: "(47) real-repo regression guard: the actual enforcement-inventory.json + the actual repo .claude/settings.local.json agree (report-style-guard drift closed, HYK-160 라이더ⓐ)",
    expectSkipped: !SETTINGS_LOCAL_PRESENT,
  },
  {
    file: "scripts/check/selfcheck-inventory.test.mjs",
    name: "(58) real-repo regression guard: EXPECTED_INJECTED_HOOKS all appear in the actual repo settings.local.json + user-level settings.json (both real files, additive check against live wiring)",
    expectSkipped: !SETTINGS_LOCAL_PRESENT,
  },
];

// HYK-364 2R P1 (review-1 finding, coder-task.md §2 원문): iterating only
// EXPECTATIONS is a one-way check -- it can never notice a skip that shows
// up OUTSIDE that list (review's repro: adding a real, disk-written
// `t.skip("mutation probe")` case to nc-gitleaks.test.mjs made this file
// report `exit=0 tests=2 pass=2 fail=0`, silently green, because the new
// skip was never in EXPECTATIONS to begin with -- the exact "몰래 늘어나는
// skip" shape HYK-359 1R/2R already burned two rounds on for a different
// list). The fix is SET equality, not list traversal: compare the FULL
// observed skip set (every skipped test across the four affected files,
// not just the ones this file already knows to ask about) against the FULL
// expected skip set, in both directions --
//   expected has it, observed doesn't -> already caught below (per-name loop)
//   observed has it, expected doesn't -> NEW, ungoverned skip -> RED (the P1)
// "정당한 변화 stays green" (coder-task.md §3-3) falls out of this for free:
// adding an ordinary (non-conditional) test never adds a skip, so it never
// touches either set. Only a NEW skip -- conditional or not -- trips this.
function assertNoUngovernedSkips(results) {
  const knownNames = new Set(EXPECTATIONS.map((e) => e.name));
  const observedSkippedNames = [...results.entries()]
    .filter(([, r]) => r.skipped)
    .map(([name]) => name);
  const ungoverned = observedSkippedNames.filter((n) => !knownNames.has(n));
  assert.deepEqual(
    ungoverned,
    [],
    `${ungoverned.length} test(s) in the four affected files are skipped but are NOT in this contract's known-name set -- this is the exact "silently growing skip set" HYK-364 2R exists to catch: a new (or newly-conditional) test appeared skipped and nobody pinned why. Add it to EXPECTATIONS with an explicit, independently-probed condition, or fix the regression that made it skip. Ungoverned skipped name(s): ${JSON.stringify(ungoverned)}`,
  );
}

test("HYK-364: known environment-conditional skip set is pinned BY NAME (set equality, not list traversal) -- no member may silently vanish, misfire, or appear ungoverned", () => {
  const stdout = runAffectedFiles();
  const results = parseTapNamedResults(stdout);

  // Direction 1: nothing in the known set silently vanished, and each
  // known name's skip/run status matches this file's own independently
  // computed capability probe.
  for (const expectation of EXPECTATIONS) {
    const observed = results.get(expectation.name);
    assert.ok(
      observed,
      `expected test case not found by exact name in ${expectation.file} -- it was renamed, removed, or the TAP output shape changed (never silently drop a name from this contract): "${expectation.name}"`,
    );
    if (expectation.expectSkippedWhenHooksAbsent) {
      if (!INSTALLED_HOOKS_PRESENT) {
        assert.equal(
          observed.skipped,
          true,
          `"${expectation.name}" must be skipped when installed hooks are absent (one of its own AND-ed preconditions is false) -- got skipped=${observed.skipped}`,
        );
      }
      // Hooks present: production's own MAIN_ROOT/divergence logic decides;
      // not independently pinned here (see module header).
      continue;
    }
    assert.equal(
      observed.skipped,
      expectation.expectSkipped,
      `"${expectation.name}" skipped=${observed.skipped}, expected ${expectation.expectSkipped} given this environment's independently-probed capability -- either the production skip condition changed, or this environment's capability set changed without this contract's probe agreeing`,
    );
  }

  // Direction 2 (2R fix, the P1): nothing OUTSIDE the known set is skipped.
  assertNoUngovernedSkips(results);
});

test("HYK-364 sanity: resolveRealRepoGuard47 and resolveRealRepoGuard58 agree on whether .claude/settings.local.json is present (both gate on the identical file)", () => {
  const guard47 = resolveRealRepoGuard47({ repoRoot: GIT_ROOT });
  const guard58 = resolveRealRepoGuard58({ repoRoot: GIT_ROOT });
  assert.equal(
    guard47.outcome === "skip",
    guard58.outcome === "skip",
    `guard47 outcome=${guard47.outcome}, guard58 outcome=${guard58.outcome} -- both read the same .claude/settings.local.json path and must agree on presence`,
  );
});
