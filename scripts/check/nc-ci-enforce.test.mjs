// NC-3 negative-control: ci-enforce (.github/workflows/enforce.yml). The
// other of the last 2 of the 9 v1-dependent enforcement devices this track
// covers (see .harness/coder-task.md §1) -- and the "AI cannot turn this off
// by itself" device per the north-star doc's classification (task §1 table).
//
// Unlike the other 8 devices there is no exported JS module here: the
// defense IS the tracked workflow file's text, executed by GitHub Actions,
// not by anything this repo runs locally. So "contract assertion" here means
// reading the TRACKED text (`git show HEAD:.github/workflows/enforce.yml`,
// read-only, never the working-tree copy) and asserting the invariants that
// keep the CI gate fail-closed. §4-2's mutation tests apply the SAME
// contract-detector functions to a MUTATED COPY written only into an
// mkdtemp directory -- the real workflow file is never opened for writing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

const ENFORCE_YML = execFileSync(
  "git",
  ["show", "HEAD:.github/workflows/enforce.yml"],
  { cwd: ROOT, encoding: "utf8" },
);

// HYK-208 2R: the workflow's test step no longer spells out the 4 globs
// itself -- it delegates to scripts/check/isolated-suite-runner.mjs's
// TEST_DIRS (mirrors CI-canonical enforce.yml directory-for-directory).
// So "does CI still enforce all 4 directories" is now a two-part contract:
// the workflow must still invoke that exact runner, AND the tracked runner
// source must still list all 4 directories. Read the TRACKED runner text
// the same read-only way ENFORCE_YML is read above -- never the
// working-tree copy.
const ISOLATED_SUITE_RUNNER = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/isolated-suite-runner.mjs"],
  { cwd: ROOT, encoding: "utf8" },
);

// ---------------------------------------------------------------------------
// §4-1 contract detectors -- pure functions of workflow TEXT, reused
// unchanged against both the real tracked text (must hold) and mkdtemp
// mutant copies (must flip / go RED) in §4-2 below.
// ---------------------------------------------------------------------------
function hasPullRequestTrigger(text) {
  return /(^|\n)[ \t]*pull_request:[ \t]*(\n|$)/.test(text);
}
function hasPushMasterTrigger(text) {
  return /(^|\n)[ \t]*push:[ \t]*\n[ \t]*branches:[ \t]*\n[ \t]*-[ \t]*master[ \t]*(\n|$)/.test(
    text,
  );
}
const REQUIRED_TEST_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/relay/adapters",
  "scripts/supervisor",
];
// The exact `run:` line HYK-208's isolated-suite-runner installed at
// enforce.yml:31. Match the line, not a substring, so swapping back to the
// raw `node --test ...` glob (removing the isolation this whole track
// exists for) is itself a contract violation, not just a coverage gap.
const RUNNER_INVOCATION_RE =
  /^[ \t]*run:[ \t]*node scripts\/check\/isolated-suite-runner\.mjs[ \t]*$/m;
function hasRunnerInvocation(workflowText) {
  return RUNNER_INVOCATION_RE.test(workflowText);
}
function hasFullTestDirCoverage(runnerText) {
  return REQUIRED_TEST_DIRS.every((d) => runnerText.includes(`"${d}"`));
}
function hasContinueOnError(text) {
  return /continue-on-error/.test(text);
}
// Step-level YAML `if:` key only (start-of-line, optional indent, literal
// "if:"). Deliberately does NOT match embedded shell `if [ ... ]; then`
// inside a `run: |` block (no colon after "if" there) -- this repo's own
// quality_base step uses shell `if` for its base-SHA resolution, which is
// not a step-skip condition and must not trip this detector.
function hasStepLevelIf(text) {
  return /^[ \t]*if:[ \t]/m.test(text);
}
function hasGitleaksChecksumPin(text) {
  return /GITLEAKS_SHA256/.test(text);
}
function hasGitleaksChecksumVerify(text) {
  return /sha256sum -c/.test(text);
}
function hasFetchDepthZero(text) {
  return /fetch-depth:[ \t]*0/.test(text);
}
function hasQualityCheckCiStep(text) {
  return (
    /quality-check\.mjs --mode ci --base-sha/.test(text) &&
    /quality_base/.test(text)
  );
}
function hasHooksSyntaxCheck(text) {
  return (
    /sh -n hooks\/commit-msg/.test(text) && /sh -n hooks\/pre-commit/.test(text)
  );
}

test("NC-3 ci-enforce/contract: on: triggers include BOTH pull_request and push:branches:[master]", () => {
  assert.equal(
    hasPullRequestTrigger(ENFORCE_YML),
    true,
    "pull_request trigger missing",
  );
  assert.equal(
    hasPushMasterTrigger(ENFORCE_YML),
    true,
    "push:branches:[master] trigger missing",
  );
});

test("NC-3 ci-enforce/contract: workflow invokes scripts/check/isolated-suite-runner.mjs, AND that tracked runner covers all 4 required directories (scripts/check + scripts/relay + scripts/relay/adapters + scripts/supervisor)", () => {
  assert.equal(
    hasRunnerInvocation(ENFORCE_YML),
    true,
    "the test step no longer runs scripts/check/isolated-suite-runner.mjs -- CI would stop isolating the suite this whole track exists for",
  );
  assert.equal(
    hasFullTestDirCoverage(ISOLATED_SUITE_RUNNER),
    true,
    "if the runner's TEST_DIRS narrows, newly-added *.test.mjs files (including this NC track's own) silently stop being enforced by CI",
  );
});

test("NC-3 ci-enforce/contract: 'continue-on-error' does not appear anywhere in the workflow (fail-open would let a failing step still go green)", () => {
  assert.equal(hasContinueOnError(ENFORCE_YML), false);
});

test("NC-3 ci-enforce/contract: no step carries a silent step-level 'if:' skip condition", () => {
  assert.equal(
    hasStepLevelIf(ENFORCE_YML),
    false,
    "a step-level if: would let a step silently skip under some condition without failing the job",
  );
});

test("NC-3 ci-enforce/contract: gitleaks supply chain is version+SHA256 pinned AND checksum-verified before execution", () => {
  assert.equal(
    hasGitleaksChecksumPin(ENFORCE_YML),
    true,
    "GITLEAKS_SHA256 pin missing",
  );
  assert.equal(
    hasGitleaksChecksumVerify(ENFORCE_YML),
    true,
    "sha256sum -c verification missing -- without it an arbitrary binary could be executed",
  );
});

test("NC-3 ci-enforce/contract: checkout uses fetch-depth: 0 (full history -- basis for CI's history-wide gitleaks scan vs local --staged scope, gap table #6)", () => {
  assert.equal(hasFetchDepthZero(ENFORCE_YML), true);
});

test("NC-3 ci-enforce/contract: quality-check runs in --mode ci with a resolved --base-sha", () => {
  assert.equal(hasQualityCheckCiStep(ENFORCE_YML), true);
});

test("NC-3 ci-enforce/contract: hooks/commit-msg AND hooks/pre-commit are both `sh -n` syntax-checked", () => {
  assert.equal(hasHooksSyntaxCheck(ENFORCE_YML), true);
});

// ---------------------------------------------------------------------------
// §4-2 mutation ledger: at least 4 copy-mutations, RED measured. Mutants are
// written ONLY into an mkdtemp file; the tracked workflow is never modified.
// ---------------------------------------------------------------------------
function withMutantCopy(mutatedText, fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-ci-enforce-mutant-"));
  try {
    const filePath = join(dir, "enforce.mutant.yml");
    writeFileSync(filePath, mutatedText, "utf8");
    fn(mutatedText, filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NC-3 mutation/ci-enforce #1: injecting 'continue-on-error: true' into a copy -> RED (the no-continue-on-error contract detector flips)", () => {
  const mutated = ENFORCE_YML.replace(
    "      - name: check test suites (scripts/check + scripts/relay + scripts/relay/adapters + scripts/supervisor *.test.mjs)\n        run:",
    "      - name: check test suites (scripts/check + scripts/relay + scripts/relay/adapters + scripts/supervisor *.test.mjs)\n        continue-on-error: true\n        run:",
  );
  assert.notEqual(
    mutated,
    ENFORCE_YML,
    "fixture assumption: mutation must actually change the text",
  );
  withMutantCopy(mutated, (text) => {
    assert.equal(
      hasContinueOnError(text),
      true,
      "mutant contract detector must go RED (continue-on-error present) where the real file is clean",
    );
  });
});

test("NC-3 mutation/ci-enforce #2a: workflow test step reverted to the raw pre-HYK-208 node --test command (no longer invokes the runner) -> RED", () => {
  const mutated = ENFORCE_YML.replace(
    "run: node scripts/check/isolated-suite-runner.mjs",
    "run: node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs",
  );
  assert.notEqual(
    mutated,
    ENFORCE_YML,
    "fixture assumption: mutation must actually change the text",
  );
  withMutantCopy(mutated, (text) => {
    assert.equal(
      hasRunnerInvocation(text),
      false,
      "mutant contract detector must go RED (runner no longer invoked) where the real file runs the isolated runner",
    );
  });
});

test("NC-3 mutation/ci-enforce #2b: narrowing the runner's TEST_DIRS to only scripts/check -> RED", () => {
  const mutated = ISOLATED_SUITE_RUNNER.replace(
    'export const TEST_DIRS = [\n  "scripts/check",\n  "scripts/relay",\n  "scripts/relay/adapters",\n  "scripts/supervisor",\n];',
    'export const TEST_DIRS = [\n  "scripts/check",\n];',
  );
  assert.notEqual(
    mutated,
    ISOLATED_SUITE_RUNNER,
    "fixture assumption: mutation must actually change the text",
  );
  withMutantCopy(mutated, (text) => {
    assert.equal(
      hasFullTestDirCoverage(text),
      false,
      "mutant contract detector must go RED (TEST_DIRS narrowed) where the real file covers all 4 directories",
    );
  });
});

test("NC-3 mutation/ci-enforce #3: removing the gitleaks install+scan steps entirely -> RED", () => {
  const gitleaksBlockStart = ENFORCE_YML.indexOf(
    "      - name: Install gitleaks",
  );
  assert.notEqual(
    gitleaksBlockStart,
    -1,
    "fixture assumption: gitleaks install step must exist in the real file",
  );
  const mutated = ENFORCE_YML.slice(0, gitleaksBlockStart);
  assert.notEqual(
    mutated,
    ENFORCE_YML,
    "fixture assumption: mutation must actually change the text",
  );
  withMutantCopy(mutated, (text) => {
    assert.equal(
      hasGitleaksChecksumPin(text) && hasGitleaksChecksumVerify(text),
      false,
      "mutant contract detector must go RED (gitleaks supply-chain verification gone) where the real file pins+verifies",
    );
  });
});

test("NC-3 mutation/ci-enforce #4: removing only the 'sha256sum -c' checksum-verify line (keeping the version/SHA256 pin env vars) -> RED", () => {
  const mutated = ENFORCE_YML.replace(
    '          echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum -c -\n',
    "",
  );
  assert.notEqual(
    mutated,
    ENFORCE_YML,
    "fixture assumption: mutation must actually change the text",
  );
  withMutantCopy(mutated, (text) => {
    assert.equal(
      hasGitleaksChecksumPin(text),
      true,
      "pin env vars deliberately kept in this mutation",
    );
    assert.equal(
      hasGitleaksChecksumVerify(text),
      false,
      "mutant contract detector must go RED (checksum no longer actually verified before executing the downloaded binary) even though the pin constants are still present -- pinning without verifying is not verification",
    );
  });
});

// ---------------------------------------------------------------------------
// §4-3 "AI cannot turn this off by itself" -- READ-ONLY, no attempt made.
// The table below is fixed as code (not just prose) per task §4-3 point 4.
// The single network observation (task §4-3 point 2/4) was performed BY
// HAND, once, outside of any test, and is hard-coded as a fixture here --
// no test in this file makes a network call.
//
// Manual observation (2026-07-31, unauthenticated GET, this session):
//   GET https://api.github.com/repos/hykim82/HARNESSENGINEERING/branches/master
//   -> HTTP 200, body includes:
//        "protected": true,
//        "protection": { "enabled": true,
//          "required_status_checks": { "enforcement_level": "everyone",
//            "contexts": ["enforce"],
//            "checks": [{ "context": "enforce", "app_id": 15368 }] } }
//   GET https://api.github.com/repos/hykim82/HARNESSENGINEERING/branches/master/protection
//   -> HTTP 401 Unauthorized (confirms the known limitation: detailed
//      protection settings -- e.g. bypass-actor allowlists -- require auth
//      and were NOT observed; only the branches/master summary's `protected`
//      + `required_status_checks.contexts` fields were read).
// ---------------------------------------------------------------------------
const GITHUB_API_OBSERVATION = Object.freeze({
  observed_at: "2026-07-31",
  endpoint: "GET /repos/hykim82/HARNESSENGINEERING/branches/master",
  auth: "none (anonymous)",
  http_status: 200,
  protected: true,
  required_status_checks_contexts: ["enforce"],
  detail_endpoint:
    "GET /repos/hykim82/HARNESSENGINEERING/branches/master/protection",
  detail_http_status: 401,
  detail_limitation:
    "detailed protection settings (e.g. bypass-actor allowlist, admin-enforcement flag) 401 without auth -- NOT observed",
});

test("NC-3 ci-enforce/off-surfaces: the GitHub API observation fixture matches what was actually captured by hand (no live network call in this test)", () => {
  assert.equal(GITHUB_API_OBSERVATION.protected, true);
  assert.deepEqual(GITHUB_API_OBSERVATION.required_status_checks_contexts, [
    "enforce",
  ]);
  assert.equal(GITHUB_API_OBSERVATION.detail_http_status, 401);
});

// Surfaces by which "ci-enforce could be turned off", per task §4-3 point 1
// minimum candidate list (a)-(f). Fixed as code so the next person can rerun
// this assertion instead of re-reading prose. Verdict vocabulary:
//   REQUIRES_PR              -- must go through a PR merge to master
//   REQUIRES_ADMIN            -- requires repo/org admin privilege
//   UNDECIDABLE                -- cannot be confirmed or ruled out from a
//                                 read-only, unauthenticated vantage point;
//                                 "AI cannot do X" is a negative-existence
//                                 claim and is never provable this way
const TURNOFF_SURFACES = Object.freeze([
  {
    surface: "(a) edit .github/workflows/enforce.yml itself",
    permission_required:
      "write access + PR merge (branch protected, required check 'enforce')",
    ai_environment_has_it: false,
    verdict: "REQUIRES_PR",
    basis:
      "GITHUB_API_OBSERVATION: protected=true, required_status_checks.contexts includes 'enforce' -- a direct push to master is blocked by branch protection; editing this file requires a PR that itself must pass this same 'enforce' check before merge, and this AI environment has no merge-approval capability wired (§2 non-negotiable #1 forbids even attempting it)",
  },
  {
    surface: "(b) repository settings / rulesets change",
    permission_required: "repo admin",
    ai_environment_has_it: false,
    verdict: "REQUIRES_ADMIN",
    basis:
      "GitHub repo-settings writes require admin role; this AI environment's git remote access is a normal contributor credential, not admin (2026-07-31 A' scope)",
  },
  {
    surface: "(c) disable GitHub Actions for the repository",
    permission_required: "repo admin",
    ai_environment_has_it: false,
    verdict: "REQUIRES_ADMIN",
    basis: "same admin-only surface as (b)",
  },
  {
    surface: "(d) change the required-status-checks list (remove 'enforce')",
    permission_required: "repo admin (branch protection settings)",
    ai_environment_has_it: false,
    verdict: "REQUIRES_ADMIN",
    basis:
      "same admin-only surface as (b); GITHUB_API_OBSERVATION shows 'enforce' is currently the required context, but changing that list itself needs admin",
  },
  {
    surface: "(e) fork / different-branch path around the check",
    permission_required:
      "unknown (depends on org/ruleset fork policy not observable anonymously)",
    ai_environment_has_it: null,
    verdict: "UNDECIDABLE",
    basis:
      "whether a fork PR or a differently-named target branch could merge without the 'enforce' check passing depends on settings the 401'd protection-detail endpoint would show (e.g. bypass-actor list, whether protection applies repo-wide or master-only) -- not observable read-only/anonymous, so this is left honestly undecidable rather than asserted safe",
  },
  {
    surface: "(f) alternate execution path outside .github/workflows entirely",
    permission_required: "unknown",
    ai_environment_has_it: null,
    verdict: "UNDECIDABLE",
    basis:
      "cannot enumerate all possible CI/CD or org-level automation surfaces from inside this repo checkout alone -- absence of a known alternate path is not proof none exists (negative-existence claim, task §4-3 point 3)",
  },
]);

test("NC-3 ci-enforce/off-surfaces: table is fixed as code -- admin-gated surfaces (b)/(c)/(d) all report ai_environment_has_it=false, and unverifiable surfaces (e)/(f) are left UNDECIDABLE, not silently marked safe", () => {
  assert.equal(TURNOFF_SURFACES.length, 6);
  const adminSurfaces = TURNOFF_SURFACES.filter(
    (s) => s.verdict === "REQUIRES_ADMIN",
  );
  assert.equal(
    adminSurfaces.length,
    3,
    "(b)/(c)/(d) must all be REQUIRES_ADMIN",
  );
  for (const s of adminSurfaces) {
    assert.equal(
      s.ai_environment_has_it,
      false,
      `${s.surface}: this AI environment must not claim admin capability`,
    );
  }
  const undecidable = TURNOFF_SURFACES.filter(
    (s) => s.verdict === "UNDECIDABLE",
  );
  assert.equal(
    undecidable.length,
    2,
    "(e)/(f) must remain UNDECIDABLE -- not resolved to a false sense of safety",
  );
  const prSurface = TURNOFF_SURFACES.find((s) => s.surface.startsWith("(a)"));
  assert.equal(prSurface.verdict, "REQUIRES_PR");
});

test("NC-3 ci-enforce/off-surfaces: the range-limited claim this table supports (NOT 'AI cannot turn this off' -- that is an unprovable negative-existence claim, task §4-3 point 3)", () => {
  const total = TURNOFF_SURFACES.length;
  const adminGated = TURNOFF_SURFACES.filter(
    (s) => s.verdict === "REQUIRES_ADMIN",
  ).length;
  const claim = `known surfaces ${total}: 1 requires a PR merge past the 'enforce' required check, ${adminGated} require repo admin privilege this AI environment does not hold (as of the 2026-07-31 API observation), and 2 are left UNDECIDABLE (not observable read-only/anonymously) -- this is a range-limited claim about KNOWN surfaces, not a proof that no way to turn this off exists`;
  assert.match(claim, /UNDECIDABLE/);
  assert.match(claim, /range-limited claim/);
  assert.doesNotMatch(claim, /AI cannot turn this off/i);
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-ci-enforce.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-ci-enforce.test.mjs changed the tracked-file diff state -- the suite must leave whatever diff existed before it ran untouched, not force it to empty",
  );
});
