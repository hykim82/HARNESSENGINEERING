// HYK-167 사이클0 D0-1: pure aggregator over enforcement-inventory.json's
// per-entry `portability` block (schema_version 2). Computes the six B0 §4
// counts and the single `ok` verdict, and nothing else -- this module never
// reads or writes the manifest file itself (see the CLI wrapper below for
// that), so every test here drives it off in-memory fixtures.
//
// Honesty (S4, task §0): this is a data contract + counting exercise for
// cycle 0. It says nothing about whether a check's underlying behavior is
// correct, whether a REDEFINED check's future re-expression will be sound,
// or whether HUMAN_APPROVED_EXCLUSION was the right call -- only whether the
// bookkeeping around those decisions is internally consistent and honest
// about what it counts.

const CLASSIFICATION_ENUM = new Set([
  "DIRECT_A_B_PORTABLE",
  "REDEFINED",
  "ENGINE_SPECIFIC_AUXILIARY",
]);

// The fixed reporting phrase this cycle's task mandates (B0 §4) -- "11/11
// PASS" must never appear anywhere in code/comments/tests, since it would
// misrepresent the 1 approved exclusion as an engine-neutral pass.
export const ACCOUNTING_SUMMARY_PHRASE =
  "10 engine-neutral PASS + 1 approved engine-specific exclusion; 11/11 accounted";

function hasClosedClassification(entry) {
  const p = entry?.portability;
  return !!p && CLASSIFICATION_ENUM.has(p.classification);
}

// Pure counting over a manifest's `checks` array. Never mutates its input,
// never reads a file -- every count comes from the `portability` block each
// entry already carries (or its absence, for the zero-check-prevention path
// below).
export function computePortabilityAccounting(checks) {
  const entries = Array.isArray(checks) ? checks : [];

  const baseline = entries.filter(
    (e) => e?.portability?.counts_toward_baseline === true,
  );
  const baseline_count = baseline.length;

  const classified_count = entries.filter(
    (e) =>
      e?.portability?.counts_toward_baseline === true &&
      hasClosedClassification(e),
  ).length;

  const engine_neutral_required = 10;

  const engine_neutral_pass = entries.filter(
    (e) => e?.portability?.counts_toward_engine_neutral_pass === true,
  ).length;

  // An APPROVED exclusion with no human_approval_ref is not actually
  // evidenced -- it must not count, or a forged/incomplete approval would
  // silently pass as accounted (D0-1 §2.3 mutation 4).
  const approved_exclusion_count = entries.filter(
    (e) =>
      e?.portability?.completion_disposition === "HUMAN_APPROVED_EXCLUSION" &&
      e?.portability?.approval_status === "APPROVED" &&
      !!e?.portability?.human_approval_ref,
  ).length;

  const unresolved_count = entries.filter(
    (e) => e?.portability?.approval_status === "PENDING_HUMAN_APPROVAL",
  ).length;

  const overall_accounted = engine_neutral_pass + approved_exclusion_count;

  // HYK-157 zero-check prevention: an empty/portability-free manifest must
  // never read as `ok:true` by vacuously satisfying "0 == 0" arithmetic --
  // baseline_count must positively equal 11, not just equal classified_count.
  const ok =
    baseline_count === 11 &&
    classified_count === 11 &&
    overall_accounted === 11 &&
    engine_neutral_pass === engine_neutral_required &&
    approved_exclusion_count === 1 &&
    unresolved_count === 0;

  return {
    baseline_count,
    classified_count,
    engine_neutral_required,
    engine_neutral_pass,
    approved_exclusion_count,
    unresolved_count,
    overall_accounted,
    ok,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/portability-accounting.mjs");

if (invokedDirectly) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execSync } = await import("node:child_process");

  let root;
  try {
    root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    root = process.cwd();
  }
  const manifestPath = join(
    root,
    "scripts",
    "check",
    "enforcement-inventory.json",
  );

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(
      `portability-accounting: could not read/parse manifest '${manifestPath}' (${err.message})`,
    );
    process.exit(1);
  }

  const result = computePortabilityAccounting(manifest.checks);
  console.log(JSON.stringify(result, null, 2));
  console.log(ACCOUNTING_SUMMARY_PHRASE);
  process.exit(result.ok ? 0 : 1);
}
