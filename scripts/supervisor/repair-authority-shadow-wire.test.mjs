// HYK-252 -- wire tests for repair-authority-shadow.mjs. Three groups:
// (a) actually spawns the CLI (child_process.spawnSync) against a temp
//     fixture root, both success and log-path-rejection cases;
// (b) a static reference-allowlist test proving zero production file
//     references either new module (the "zero production effect" proof);
// (c) five RED-mutation proofs -- each mutates an in-memory copy of the
//     real source, writes it to a throwaway temp file, exercises the
//     mutated copy, and asserts the vulnerability it simulates actually
//     manifests (RED). The real tracked files are never written to; each
//     RED test finishes by re-reading the real file and asserting it is
//     byte-identical to a buffer captured once at module load time, above
//     any mutation.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "repair-authority-shadow.mjs");
const CORE_PATH = join(HERE, "repair-authority-core.mjs");
const THIS_FILE_PATH = fileURLToPath(import.meta.url);

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: HERE,
  encoding: "utf8",
}).trim();

// Captured once, before any test runs any mutation -- the proof-of-no-
// on-disk-mutation baseline for the RED tests below.
const ORIGINAL_CLI_SOURCE = readFileSync(CLI_PATH, "utf8");
const ORIGINAL_CORE_SOURCE = readFileSync(CORE_PATH, "utf8");

function assertRealFilesUntouched() {
  assert.equal(
    readFileSync(CLI_PATH, "utf8"),
    ORIGINAL_CLI_SOURCE,
    "repair-authority-shadow.mjs must be byte-identical after a RED-mutation test -- only a temp copy was ever mutated",
  );
  assert.equal(
    readFileSync(CORE_PATH, "utf8"),
    ORIGINAL_CORE_SOURCE,
    "repair-authority-core.mjs must be byte-identical after a RED-mutation test -- only a temp copy was ever mutated",
  );
}

function makeFixtureRoot(prefix = "hyk252-wire-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeInputFixture(dir, obj, name = "input.json") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

// HYK-252-shadow-judge-2 review fix #2: authoritative expected-* values now
// live in a SEPARATE JSON file passed via --authority, never embedded in
// --input. This mirrors writeInputFixture but with its own default name so
// a single fixture root can hold both files at once.
function writeAuthorityFixture(dir, obj, name = "authority.json") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

function runCli(cliPath, args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

// The attempt being judged -- no expected*/authoritative-reference fields
// live here anymore (see repair-authority-core.mjs's judgeRepairAuthority
// header for why: input.expected* is never read).
const VALID_SYNTHETIC_INPUT = {
  gateId: "G-DELIVER-STREAK",
  approvalSignature: {
    signerId: "sig-1",
    signatureHash: "hash-1",
    authorized: true,
  },
  failureReceipt: { digest: "d1", expectedDigest: "d1" },
  issueId: "HYK-252",
  repairTaskId: "HYK-252-r1",
  dispatchId: "disp-1",
  repoIdentity: "repo-a",
  baseIdentity: "base-a",
  policyDigest: "hyk252-frozen-policy-digest-v1",
  manifestDigest: "hyk252-frozen-manifest-digest-v1",
  materializedBoundary: ["scripts/supervisor/**"],
  permissionSeparationObserved: true,
  evidenceClass: "SYNTHETIC",
  approvedGateManifest: [{ gateId: "G-DELIVER-STREAK", approved: true }],
};

// The separate authoritative-reference context matching the attempt above
// -- what a caller (not the attempt itself) vouches is true.
const VALID_SYNTHETIC_AUTHORITY = {
  expectedApprovalSignature: { signerId: "sig-1", signatureHash: "hash-1" },
  expectedRepoIdentity: "repo-a",
  expectedBaseIdentity: "base-a",
  expectedPolicyDigest: "hyk252-frozen-policy-digest-v1",
  expectedManifestDigest: "hyk252-frozen-manifest-digest-v1",
};

const REAL_NEGATIVE_CONTROL_INPUT = {
  gateId: "G-DELIVER-CONSUME-VERDICT",
  evidenceClass: "REAL",
  sourceEvidence: "ORCH_RECORDED_PM_UNVERIFIED",
  issueId: "HYK-252",
  repairTaskId: "HYK-252-repair-1",
  dispatchId: "dispatch-2026-08-14-1822",
  repoIdentity: "hyk252-shadow-r1",
  baseIdentity: "master",
  failureReceipt: { note: "ORCH-recorded PM claim, unverified" },
  approvalSignature: { signerId: "orch", authorized: false },
  policyDigest: "unknown",
  manifestDigest: "unknown",
  materializedBoundary: [],
  permissionSeparationObserved: null,
  approvedGateManifest: [],
};

// ---------------------------------------------------------------------
// (a) wire/spawn tests
// ---------------------------------------------------------------------

// Each test body below is a standalone named function (rather than inline
// inside the describe() callback) purely to keep the describe callback's
// own line count under this repo's eslint max-lines-per-function limit --
// no behavior change from writing them inline.

function wireHappyPath() {
  const fixtureRoot = makeFixtureRoot();
  try {
    const inputPath = writeInputFixture(fixtureRoot, VALID_SYNTHETIC_INPUT);
    const authorityPath = writeAuthorityFixture(
      fixtureRoot,
      VALID_SYNTHETIC_AUTHORITY,
    );
    const logPath = join(fixtureRoot, "shadow.log");
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      logPath,
      "--fixture-root",
      fixtureRoot,
      "--authority",
      authorityPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /primaryReasonCode: null/);
    assert.match(result.stdout, /CLOSED_POLICY_INCOMPLETE/);
    assert.match(result.stdout, /authoritative=false/);
    assert.equal(existsSync(logPath), true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1));
    assert.equal(record.recordType, "NON_AUTHORITATIVE_REPAIR_SHADOW_V1");
    assert.equal(record.authoritative, false);
    assert.equal(record.eligibleForGateConsumption, false);
    assert.equal(record.gateEffect, "NONE");
    assert.equal(record.verdict.verdict, "WOULD_ISSUE_ENTRY");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function wireNegativeControl() {
  const fixtureRoot = makeFixtureRoot();
  try {
    const inputPath = writeInputFixture(
      fixtureRoot,
      REAL_NEGATIVE_CONTROL_INPUT,
    );
    const logPath = join(fixtureRoot, "shadow.log");
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      logPath,
      "--fixture-root",
      fixtureRoot,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /primaryReasonCode: GATE_SEALED_HUMAN_ONLY/);
    const record = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(record.verdict.verdict, "DENY");
    assert.equal(record.sourceEvidence, "ORCH_RECORDED_PM_UNVERIFIED");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function wireRejectOutsideFixtureRoot() {
  const fixtureRoot = makeFixtureRoot();
  const outsideRoot = makeFixtureRoot("hyk252-wire-outside-");
  try {
    const inputPath = writeInputFixture(fixtureRoot, VALID_SYNTHETIC_INPUT);
    const logPath = join(outsideRoot, "shadow.log");
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      logPath,
      "--fixture-root",
      fixtureRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside --fixture-root/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

function wireRejectHarnessSubdir() {
  const fixtureRoot = makeFixtureRoot();
  try {
    const inputPath = writeInputFixture(fixtureRoot, VALID_SYNTHETIC_INPUT);
    const logPath = join(fixtureRoot, ".harness", "shadow.log");
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      logPath,
      "--fixture-root",
      fixtureRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden production-shaped segment/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function wireRejectRepoRoot() {
  const fixtureRoot = REPO_ROOT;
  const inputFixtureRoot = makeFixtureRoot();
  const logPath = join(REPO_ROOT, "hyk252-wire-test-should-never-exist.log");
  try {
    const inputPath = writeInputFixture(
      inputFixtureRoot,
      VALID_SYNTHETIC_INPUT,
    );
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      logPath,
      "--fixture-root",
      fixtureRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(inputFixtureRoot, { recursive: true, force: true });
    if (existsSync(logPath)) rmSync(logPath, { force: true });
  }
}

function wireRejectSymlinkEscape(t) {
  const fixtureRoot = makeFixtureRoot();
  const outsideRoot = makeFixtureRoot("hyk252-wire-symlink-target-");
  const linkPath = join(fixtureRoot, "escape-link");
  try {
    symlinkSync(outsideRoot, linkPath, "junction");
  } catch (err) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    t.skip(
      `symlink/junction creation not available in this environment: ${err.message}`,
    );
    return;
  }
  try {
    const inputPath = writeInputFixture(fixtureRoot, VALID_SYNTHETIC_INPUT);
    const logPath = join(linkPath, "shadow.log");
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      logPath,
      "--fixture-root",
      fixtureRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(outsideRoot, "shadow.log")), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

// HYK-252-shadow-judge-2 review fix #1 -- direct reproduction of the exact
// reviewer finding: the FINAL --log target itself (not a directory in its
// path) already exists as a symlink pointing outside --fixture-root. Prior
// behavior (REVIEW-r1.md): resolveLogPathSafely only canonicalized the
// *parent* directory and re-joined the (unresolved) basename, so
// appendFileSync silently followed the existing symlink outside the
// fixture root. This test must now see the CLI reject it BEFORE writing.
function wireRejectExistingFileSymlink(t) {
  const fixtureRoot = makeFixtureRoot();
  const outsideRoot = makeFixtureRoot("hyk252-wire-file-symlink-target-");
  const outsideTarget = join(outsideRoot, "outside-shadow.log");
  writeFileSync(outsideTarget, "", "utf8");
  const linkPath = join(fixtureRoot, "shadow.log");
  try {
    symlinkSync(outsideTarget, linkPath, "file");
  } catch (err) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    t.skip(
      `file symlink creation not available in this environment: ${err.message}`,
    );
    return;
  }
  try {
    const inputPath = writeInputFixture(fixtureRoot, VALID_SYNTHETIC_INPUT);
    const beforeContent = readFileSync(outsideTarget, "utf8");
    const result = runCli(CLI_PATH, [
      "--input",
      inputPath,
      "--log",
      linkPath,
      "--fixture-root",
      fixtureRoot,
    ]);
    assert.notEqual(
      result.status,
      0,
      `expected non-zero exit rejecting an existing final-file symlink, got stdout=${result.stdout}`,
    );
    assert.match(result.stderr, /symlink\/junction\/reparse/);
    assert.equal(
      readFileSync(outsideTarget, "utf8"),
      beforeContent,
      "the symlink target outside --fixture-root must be byte-unchanged -- no append must have happened",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

describe("(a) wire: spawn the real CLI end-to-end", () => {
  test(
    "success: writes a shadow log record and prints the human-readable summary",
    wireHappyPath,
  );
  test(
    "success: real-world negative control input -> DENY/GATE_SEALED_HUMAN_ONLY, sourceEvidence echoed",
    wireNegativeControl,
  );
  test(
    "reject: --log outside --fixture-root -> non-zero exit, no file written",
    wireRejectOutsideFixtureRoot,
  );
  test(
    "reject: --log inside a .harness-named subdir of --fixture-root -> non-zero exit, no file written (defense in depth)",
    wireRejectHarnessSubdir,
  );
  test(
    "reject: --log points into the real git repo root -> non-zero exit, repo untouched",
    wireRejectRepoRoot,
  );
  test(
    "reject: a symlink inside --fixture-root pointing outside it is rejected via realpath canonicalization",
    wireRejectSymlinkEscape,
  );
  test(
    "reject: the final --log target itself already exists as a symlink pointing outside --fixture-root (exact reviewer reproduction, RED -> GREEN)",
    wireRejectExistingFileSymlink,
  );
});

// ---------------------------------------------------------------------
// (b) static reference-allowlist test
// ---------------------------------------------------------------------

const MODULE_NAMES = ["repair-authority-core", "repair-authority-shadow"];
const ALLOWED_REFERRERS = new Set([
  "scripts/supervisor/repair-authority-shadow.mjs",
  "scripts/supervisor/repair-authority-core.test.mjs",
  "scripts/supervisor/repair-authority-shadow-wire.test.mjs",
]);

// Reusable checker: given [{path, content}] and an allowed-referrer set,
// returns the list of paths that reference either module name but are NOT
// in the allowed set. Used both against the real tracked repo (test below)
// and against a deliberately-broadened mutation fixture (RED test ⓓ) to
// prove this logic isn't vacuously always-pass.
function findAllowlistViolations(entries, allowedReferrers) {
  const violations = [];
  for (const entry of entries) {
    if (allowedReferrers.has(entry.path)) continue;
    if (MODULE_NAMES.some((name) => entry.content.includes(name))) {
      violations.push(entry.path);
    }
  }
  return violations;
}

// --others --exclude-standard: this task's own 4 new files are not yet
// `git add`-ed at the time these tests first run (that is the orchestrating
// session's job, not this one's, per coder-task.md's absolute constraints)
// -- `git ls-files` alone would silently omit them and this allowlist test
// would never actually see repair-authority-shadow.mjs itself, which is
// supposed to be on the allowed list. Combining tracked + untracked-but-
// not-ignored gives the same file set CI will see once they are committed.
function listTrackedCandidateFiles() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.mjs",
      "*.js",
      "*.ts",
      "hooks",
      "package.json",
      ".github/workflows",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Walks the (external, read-only) control-room reference directory for
// launcher-shaped scripts, bounded to a small extension allowlist so this
// stays cheap even though the directory itself holds thousands of docs.
//
// HYK-252-shadow-judge-2 review fix #3: this path must be injected, never
// hardcoded -- previously a literal `D:\문서관리\하네스-관제실` sat here.
// Now it comes ONLY from the HYK252_CONTROL_ROOM_DIR environment variable.
// When that variable is unset, or set but unreadable, this axis is NOT
// silently skipped: a loud t.diagnostic() line is emitted (visible in test
// output/TAP, distinct from a silent early-return) so a reader of the test
// run can see this axis was not covered this run, rather than mistaking
// silence for a pass.
const CONTROL_ROOM_DIR_ENV_VAR = "HYK252_CONTROL_ROOM_DIR";
const LAUNCHER_EXT_RE = /\.(mjs|js|ts|ps1|bat|cmd)$/i;

function walkControlRoomLaunchers(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkControlRoomLaunchers(full, out);
    } else if (LAUNCHER_EXT_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

test("(b) reference-allowlist: only the 4 new files + self-import reference either module name", (t) => {
  const files = listTrackedCandidateFiles();
  const entries = files.map((relPath) => ({
    path: relPath.replace(/\\/g, "/"),
    content: readFileSync(join(REPO_ROOT, relPath), "utf8"),
  }));

  const controlRoomDir = process.env[CONTROL_ROOM_DIR_ENV_VAR];
  if (!controlRoomDir) {
    t.diagnostic(
      `${CONTROL_ROOM_DIR_ENV_VAR} not set -- control-room launcher axis explicitly NOT checked this run (loud marker, not a silent skip)`,
    );
  } else if (!existsSync(controlRoomDir)) {
    t.diagnostic(
      `${CONTROL_ROOM_DIR_ENV_VAR}=${controlRoomDir} does not exist -- control-room launcher axis explicitly NOT checked this run (loud marker, not a silent skip)`,
    );
  } else {
    const launcherFiles = [];
    walkControlRoomLaunchers(controlRoomDir, launcherFiles);
    t.diagnostic(
      `${CONTROL_ROOM_DIR_ENV_VAR}=${controlRoomDir}: scanned ${launcherFiles.length} launcher-shaped file(s)`,
    );
    for (const full of launcherFiles) {
      entries.push({ path: full, content: readFileSync(full, "utf8") });
    }
  }

  const violations = findAllowlistViolations(entries, ALLOWED_REFERRERS);
  assert.deepEqual(
    violations,
    [],
    `unexpected production/CI/hook/launcher reference(s) to the shadow modules: ${violations.join(", ")}`,
  );

  // Sanity: the CLI's own self-referential lines (its own filename in the
  // "invoked directly" check, and its import of the core module) are
  // exactly why repair-authority-shadow.mjs itself must be allowlisted --
  // confirm that file really does reference both names, so this test
  // isn't accidentally checking an empty allowlist for no reason.
  const shadowEntry = entries.find(
    (e) => e.path === "scripts/supervisor/repair-authority-shadow.mjs",
  );
  assert.ok(
    shadowEntry,
    "expected repair-authority-shadow.mjs among tracked candidates",
  );
  assert.ok(MODULE_NAMES.some((n) => shadowEntry.content.includes(n)));
});

// ---------------------------------------------------------------------
// (c) RED-mutation proofs
// ---------------------------------------------------------------------

// Each RED-mutation test body is a standalone named function for the same
// max-lines-per-function reason noted above the (a) test bodies.

async function importMutantCore(dir, mutatedSource) {
  const mutantPath = join(dir, "repair-authority-core.mutant.mjs");
  writeFileSync(mutantPath, mutatedSource, "utf8");
  return import(`${new URL(`file://${mutantPath.replace(/\\/g, "/")}`)}`);
}

async function redMutationSealedGatePassesThrough() {
  const mutated = ORIGINAL_CORE_SOURCE.replace(
    'const SEALED_GATE_IDS = Object.freeze(new Set(["G-DELIVER-CONSUME-VERDICT"]));',
    "const SEALED_GATE_IDS = Object.freeze(new Set([])); // MUTATED: sealed gate no longer sealed",
  );
  assert.notEqual(
    mutated,
    ORIGINAL_CORE_SOURCE,
    "mutation did not match expected source text",
  );

  const dir = makeFixtureRoot("hyk252-red-a-");
  try {
    const mod = await importMutantCore(dir, mutated);
    const verdict = mod.judgeRepairAuthority(
      {
        ...VALID_SYNTHETIC_INPUT,
        gateId: "G-DELIVER-CONSUME-VERDICT",
        approvedGateManifest: [
          { gateId: "G-DELIVER-CONSUME-VERDICT", approved: true },
        ],
      },
      VALID_SYNTHETIC_AUTHORITY,
    );
    assert.equal(
      verdict.verdict,
      "WOULD_ISSUE_ENTRY",
      "RED expected: mutated sealed-gate check must incorrectly allow the sealed axis through",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assertRealFilesUntouched();
}

async function redMutationDigestAlwaysMatches() {
  const needle = "function checkDigestReason(input, authority) {";
  assert.ok(
    ORIGINAL_CORE_SOURCE.includes(needle),
    "mutation anchor text not found",
  );
  const mutated = ORIGINAL_CORE_SOURCE.replace(
    needle,
    `${needle}\n  return null; // MUTATED: digests always treated as matching`,
  );
  const dir = makeFixtureRoot("hyk252-red-b-");
  try {
    const mod = await importMutantCore(dir, mutated);
    const verdict = mod.judgeRepairAuthority(
      {
        ...VALID_SYNTHETIC_INPUT,
        policyDigest: "definitely-wrong-digest",
      },
      VALID_SYNTHETIC_AUTHORITY,
    );
    assert.notEqual(
      verdict.primaryReasonCode,
      "POLICY_MANIFEST_DIGEST_MISMATCH",
      "RED expected: mutated digest check must fail to DENY a digest-mismatch input",
    );
    assert.equal(verdict.verdict, "WOULD_ISSUE_ENTRY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assertRealFilesUntouched();
}

// HYK-252-shadow-judge-3 review fix -- RED proof that reverting THIS
// round's fix (reviving a placeholder fallback for a missing authority
// digest) is actually caught. Mutates the real
// POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING hard-DENY branch back into a
// fallback-to-placeholder shape (functionally what round 2 shipped), then
// confirms that an authority omitting both digests + a placeholder-shaped
// input incorrectly reaches WOULD_ISSUE_ENTRY under the mutant -- i.e. the
// exact regression REVIEW-r2.md 축 B caught would go undetected without
// this round's fix.
async function redMutationDigestFallbackRevived() {
  const needle =
    "  if (!hasExpectedPolicy || !hasExpectedManifest) {\n    return REASON_CODE.POLICY_MANIFEST_AUTHORITY_DIGEST_MISSING;\n  }";
  assert.ok(
    ORIGINAL_CORE_SOURCE.includes(needle),
    "mutation anchor text not found",
  );
  const mutated = ORIGINAL_CORE_SOURCE.replace(
    needle,
    '  const __hyk252RevivedFallbackPolicy = "hyk252-frozen-policy-digest-v1";\n' +
      '  const __hyk252RevivedFallbackManifest = "hyk252-frozen-manifest-digest-v1";\n' +
      "  if (!hasExpectedPolicy) authority = { ...authority, expectedPolicyDigest: __hyk252RevivedFallbackPolicy }; // MUTATED: round-2 fallback revived\n" +
      "  if (!hasExpectedManifest) authority = { ...authority, expectedManifestDigest: __hyk252RevivedFallbackManifest }; // MUTATED: round-2 fallback revived",
  );
  const dir = makeFixtureRoot("hyk252-red-f-");
  try {
    const mod = await importMutantCore(dir, mutated);
    const placeholderShapedInput = {
      ...VALID_SYNTHETIC_INPUT,
      policyDigest: "hyk252-frozen-policy-digest-v1",
      manifestDigest: "hyk252-frozen-manifest-digest-v1",
    };
    const authorityMissingBothDigests = {
      ...VALID_SYNTHETIC_AUTHORITY,
      expectedPolicyDigest: undefined,
      expectedManifestDigest: undefined,
    };
    const verdict = mod.judgeRepairAuthority(
      placeholderShapedInput,
      authorityMissingBothDigests,
    );
    assert.equal(
      verdict.verdict,
      "WOULD_ISSUE_ENTRY",
      "RED expected: reviving the round-2 fallback must incorrectly let a placeholder-shaped input through with no real authority digest supplied",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assertRealFilesUntouched();
}

async function redMutationRealInputIssues() {
  const needle = "function checkEvidenceClassReason(input) {";
  assert.ok(
    ORIGINAL_CORE_SOURCE.includes(needle),
    "mutation anchor text not found",
  );
  const mutated = ORIGINAL_CORE_SOURCE.replace(
    needle,
    `${needle}\n  return null; // MUTATED: evidenceClass check disabled entirely`,
  );
  const dir = makeFixtureRoot("hyk252-red-c-");
  try {
    const mod = await importMutantCore(dir, mutated);
    const verdict = mod.judgeRepairAuthority(
      {
        ...VALID_SYNTHETIC_INPUT,
        evidenceClass: "REAL",
      },
      VALID_SYNTHETIC_AUTHORITY,
    );
    assert.equal(
      verdict.verdict,
      "WOULD_ISSUE_ENTRY",
      "RED expected: mutated evidenceClass check must incorrectly issue on a REAL (production) input",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assertRealFilesUntouched();
}

// HYK-252-shadow-judge-2 review fix #3: RED ⓓ now inserts a shadow-module
// import into a REAL production gate's TEMP COPY (dispatch-gate-decision.mjs
// -- the same gate axis A already exercises for its "output/exit code
// unchanged" comparison) and shows that doing so actually changes that
// gate's stdout, which is exactly what the axis-2 "no drift" invariant
// exists to catch. This replaces the earlier version, which only proved the
// allowlist-checker's own logic wasn't vacuous but never touched a real
// gate file at all -- the reviewer asked for the real gate.
//
// The whole scripts/check/ directory (and repair-authority-core.mjs) is
// copied into a throwaway temp root first, so the mutation never touches
// anything tracked -- dispatch-gate-decision.mjs's relative sibling imports
// (./dispatch-gate-decision-core.mjs etc.) still resolve because the
// temp copy preserves the same directory layout.
function redMutationRealGateImportsShadowModule() {
  const workRoot = makeFixtureRoot("hyk252-red-d-");
  try {
    const tempCheckDir = join(workRoot, "scripts", "check");
    const tempSupervisorDir = join(workRoot, "scripts", "supervisor");
    cpSync(join(REPO_ROOT, "scripts", "check"), tempCheckDir, {
      recursive: true,
    });
    mkdirSync(tempSupervisorDir, { recursive: true });
    writeFileSync(
      join(tempSupervisorDir, "repair-authority-core.mjs"),
      ORIGINAL_CORE_SOURCE,
      "utf8",
    );

    const baselineGatePath = join(tempCheckDir, "dispatch-gate-decision.mjs");
    const baselineSource = readFileSync(baselineGatePath, "utf8");

    // The mutation: a production gate importing the shadow core AND
    // actually consuming its result in a way that surfaces in stdout --
    // simulating exactly the "shadow module influences a real gate"
    // violation that axis 1 (reference-allowlist) and axis 2 (no-drift
    // comparison) exist to prevent.
    const mutatedSource =
      `import { judgeRepairAuthority as __hyk252ShadowJudge } from "../supervisor/repair-authority-core.mjs";\n` +
      `console.log("HYK252-MUTATION-PROBE:", __hyk252ShadowJudge({}, {}).verdict);\n` +
      baselineSource;
    const mutatedGatePath = join(
      tempCheckDir,
      "dispatch-gate-decision.hyk252-red-mutant.mjs",
    );
    writeFileSync(mutatedGatePath, mutatedSource, "utf8");

    const gateArgs = [
      ".harness/review-task.md",
      "--ledger",
      ".harness/review-temp-ledger.json",
    ];
    const baselineRun = spawnSync(
      process.execPath,
      [baselineGatePath, ...gateArgs],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const mutatedRun = spawnSync(
      process.execPath,
      [mutatedGatePath, ...gateArgs],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    assert.notEqual(
      mutatedRun.stdout,
      baselineRun.stdout,
      "RED expected: a production gate that imports+consumes the shadow module must produce different stdout than the unmutated gate -- proving the axis-2 'no drift' invariant would actually catch this if it happened for real",
    );
    assert.match(mutatedRun.stdout, /HYK252-MUTATION-PROBE:/);
    assert.doesNotMatch(
      baselineRun.stdout,
      /HYK252-MUTATION-PROBE:/,
      "sanity: the unmutated baseline copy must never print the probe line",
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
  assertRealFilesUntouched();
}

function buildRedMutationE() {
  const needle = "if (!containmentReject(resolvedLogReal, fixtureRootReal)) {";
  assert.ok(
    ORIGINAL_CLI_SOURCE.includes(needle),
    "mutation anchor text not found",
  );
  return ORIGINAL_CLI_SOURCE.replace(
    needle,
    "if (false) { // MUTATED: fixture-root containment check disabled",
  );
}

function redMutationLogPathCheckSkipped() {
  const mutated = buildRedMutationE();
  const workRoot = makeFixtureRoot("hyk252-red-e-");
  const outsideRoot = makeFixtureRoot("hyk252-red-e-outside-");
  // The CLI's own "am I the invoked entry point" check
  // (`process.argv[1]` must end with "scripts/supervisor/repair-
  // authority-shadow.mjs") requires the mutant to live at that same
  // relative path under the temp root -- otherwise its CLI block never
  // runs at all and this test would misreport RED as a false pass.
  const dir = join(workRoot, "scripts", "supervisor");
  try {
    mkdirSync(dir, { recursive: true });
    // The mutant CLI still imports "./repair-authority-core.mjs" as a
    // relative specifier -- give it the REAL (unmutated) core module
    // alongside it so only the log-path safety logic is under test.
    writeFileSync(
      join(dir, "repair-authority-core.mjs"),
      ORIGINAL_CORE_SOURCE,
      "utf8",
    );
    const mutantCliPath = join(dir, "repair-authority-shadow.mjs");
    writeFileSync(mutantCliPath, mutated, "utf8");

    const inputPath = writeInputFixture(dir, VALID_SYNTHETIC_INPUT);
    const outsideLogPath = join(outsideRoot, "shadow.log");
    const result = runCli(mutantCliPath, [
      "--input",
      inputPath,
      "--log",
      outsideLogPath,
      "--fixture-root",
      dir,
    ]);
    assert.equal(
      result.status,
      0,
      `RED expected: mutated CLI must incorrectly succeed writing outside fixture-root (stderr: ${result.stderr})`,
    );
    assert.equal(
      existsSync(outsideLogPath),
      true,
      "RED expected: mutated CLI must have written the log file outside --fixture-root",
    );
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
  assertRealFilesUntouched();
}

describe("(c) RED-mutation proofs", () => {
  test(
    "ⓐ mutated sealed-gate check lets G-DELIVER-CONSUME-VERDICT reach WOULD_ISSUE_ENTRY (RED)",
    redMutationSealedGatePassesThrough,
  );
  test(
    "ⓑ mutated digest-mismatch check always reports digests matching -> fails to DENY (RED)",
    redMutationDigestAlwaysMatches,
  );
  test(
    "ⓒ mutated evidenceClass check lets REAL inputs reach WOULD_ISSUE_ENTRY (RED)",
    redMutationRealInputIssues,
  );
  test(
    "ⓓ a real production gate (dispatch-gate-decision.mjs, temp copy) importing+consuming the shadow module changes its stdout (RED)",
    redMutationRealGateImportsShadowModule,
  );
  test(
    "ⓔ mutated log-path safety check writes outside --fixture-root (RED, spawned end-to-end)",
    redMutationLogPathCheckSkipped,
  );
  test(
    "ⓕ round-3 fix reverted: reviving the digest fallback lets a placeholder-shaped input through with no authority digest at all (RED)",
    redMutationDigestFallbackRevived,
  );
});

test("no accidental on-disk mutation: this test file itself was only ever read, never written, by the RED tests above", () => {
  assert.ok(existsSync(THIS_FILE_PATH));
  assertRealFilesUntouched();
});
