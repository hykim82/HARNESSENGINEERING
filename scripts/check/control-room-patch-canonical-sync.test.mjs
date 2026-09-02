// HYK-415 (canonical-sync-1/2): tests for the "does a control-room patch
// document ship with EVERY registered fingerprint copy kept in sync?"
// axis. See control-room-patch-canonical-sync.mjs's module header for the
// incident this exists to catch (1R: canonical.json alone; 2R: canonical.json
// was found to not be the only checked-in copy -- FIXED_FUNCTION_TEXT and a
// dedicated snapshot fixture also encode the same body and also drifted).
//
// Groups:
// 1. Synthetic unit tests (in-memory fixtures, no real docs/) covering
//    every REASON branch, including multi-copy sync/unsync.
// 2. Integration tests against the REAL repo state (docs, registry,
//    mention baseline) -- the acceptance check for this round's actual
//    fixes.
// 3. Required "되돌림 변이" (revert mutation) -- per-copy, not just once:
//    each of the 4 registered copies is independently reverted (in-memory
//    override for that ONE copy's getHash, the other 3 copies still
//    resolve against their REAL current file contents) and the axis must
//    go RED specifically naming that copy. A test that only ever reverts
//    canonical.json and calls it done would be exactly the "한 사본만
//    검사하고 나머지는 있다고 치는" gap this round was told to close.
// 4. Mention-registry ratchet (2R, §1-2 "미열거의 기본값은 위험" for the
//    registry itself): an unregistered file mentioning the pinned function
//    must be RED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  REASON,
  resolveDocSourcePaths,
  judgeDocAgainstPinnedFunction,
  checkControlRoomPatchCanonicalSync,
  checkMentionRegistry,
  PINNED_FUNCTION_REGISTRY,
  MENTION_BASELINE,
} from "./control-room-patch-canonical-sync.mjs";
import { applyControlRoomPatch } from "./control-room-patch-apply.mjs";
import { extractAllFunctionBodies } from "./seat-proof-wrapper-shape.mjs";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const FN = "Invoke-SeatProofGate";
function scriptWith(bodyLine) {
  return [
    "function Other() { return 1 }",
    "",
    `function ${FN}([string]$dispatchId) {`,
    `  ${bodyLine}`,
    "  return $gateExit",
    "}",
    "",
  ].join("\n");
}

const BASE_SOURCE = scriptWith("Write-Host 'base'");

function unitBlock(id, mode, anchor, content) {
  return [
    "```control-room-patch-unit",
    `id: ${id}`,
    `mode: ${mode}`,
    "@@ANCHOR@@",
    anchor,
    "@@CONTENT@@",
    content,
    "@@END@@",
    "```",
  ].join("\n");
}

function fakeReadFile(map) {
  return (p) => {
    if (!(p in map)) throw new Error(`fakeReadFile: no fixture for ${p}`);
    return map[p];
  };
}

function fakeFileExists(map) {
  return (p) => p in map;
}

// A synthetic registry entry with N synthetic copies, all resolving to a
// FIXED hash by default (`goodHash`) -- individual tests override exactly
// one copy's getHash to prove it independently gates the verdict.
function syntheticEntry(goodHash, overrides = {}) {
  return {
    functionName: FN,
    extractBodies: extractAllFunctionBodies,
    copies: ["copyA", "copyB", "copyC"].map((id) => ({
      id,
      getHash: overrides[id] ?? (() => goodHash),
    })),
  };
}

async function appliedHashOf(doc, source) {
  const applied = applyControlRoomPatch(doc, source);
  assert.equal(applied.ok, true);
  const bodies = extractAllFunctionBodies(
    applied.result.replace(/\r\n/g, "\n"),
  );
  return createHash("sha256")
    .update(bodies[bodies.length - 1], "utf8")
    .digest("hex");
}

const TOUCHING_DOC = [
  `touches ${FN}`,
  `--source scripts/check/fixtures/fake-source.ps1.txt`,
  "",
  unitBlock(
    "u1",
    "insert_after",
    "Write-Host 'base'",
    "Write-Host 'base'\n  Write-Host 'added'",
  ),
].join("\n");
const FAKE_SOURCE_PATH = join(
  repoRoot,
  "scripts/check/fixtures/fake-source.ps1.txt",
);

// ---------------------------------------------------------------------
// Group 1: synthetic unit tests
// ---------------------------------------------------------------------

test("resolveDocSourcePaths: placeholder <원본>, live D:\\ path, and missing files are all excluded", () => {
  const doc = [
    "--source <원본 사본>",
    '--source "D:\\문서관리\\하네스-관제실\\dispatch-worker.ps1"',
    "--source scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt",
    "--source scripts/check/fixtures/does-not-exist-anywhere.ps1.txt",
  ].join("\n");
  const resolved = resolveDocSourcePaths(doc, repoRoot);
  assert.equal(resolved.length, 1);
  assert.match(resolved[0], /hyk271-wire-before\.ps1\.txt$/);
});

test("judgeDocAgainstPinnedFunction: doc never mentions the function name -> OK_NOT_APPLICABLE, no I/O attempted", async () => {
  const doc = "this document is about something else entirely";
  const result = await judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    syntheticEntry("whatever"),
    { repoRoot, readFile: fakeReadFile({}) },
  );
  assert.equal(result.reasonCode, REASON.OK_NOT_APPLICABLE);
});

test("judgeDocAgainstPinnedFunction: mentions the function, zero resolvable --source -> SOURCE_UNRESOLVED (fail-closed, not skipped)", async () => {
  const doc = `mentions ${FN} but names no real fixture: --source <원본>`;
  const result = await judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    syntheticEntry("whatever"),
    { repoRoot, readFile: fakeReadFile({}) },
  );
  assert.equal(result.reasonCode, REASON.SOURCE_UNRESOLVED);
});

test("judgeDocAgainstPinnedFunction: mentions the function, TWO resolvable --source fixtures -> SOURCE_UNRESOLVED (ambiguous, fail-closed)", async () => {
  const doc = [
    `mentions ${FN}`,
    "--source scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt",
    "--source scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
  ].join("\n");
  const result = await judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    syntheticEntry("whatever"),
    { repoRoot, readFile: fakeReadFile({}) },
  );
  assert.equal(result.reasonCode, REASON.SOURCE_UNRESOLVED);
});

test("judgeDocAgainstPinnedFunction: source resolves, patch touches the function, ALL copies stale -> CANONICAL_NOT_SYNCED (RED), detail names every unsynced copy", async () => {
  const result = await judgeDocAgainstPinnedFunction(
    TOUCHING_DOC,
    "docs/control-room-patches/fake.md",
    syntheticEntry("stale-value-that-does-not-match-anything"),
    {
      repoRoot,
      readFile: fakeReadFile({ [FAKE_SOURCE_PATH]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [FAKE_SOURCE_PATH]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.CANONICAL_NOT_SYNCED);
  assert.match(result.detail, /copyA/);
  assert.match(result.detail, /copyB/);
  assert.match(result.detail, /copyC/);
  assert.match(result.detail, /3\/3/);
});

test("judgeDocAgainstPinnedFunction: source resolves, patch touches the function, ALL copies synced -> OK_SYNCED", async () => {
  const expected = await appliedHashOf(TOUCHING_DOC, BASE_SOURCE);
  const result = await judgeDocAgainstPinnedFunction(
    TOUCHING_DOC,
    "docs/control-room-patches/fake.md",
    syntheticEntry(expected),
    {
      repoRoot,
      readFile: fakeReadFile({ [FAKE_SOURCE_PATH]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [FAKE_SOURCE_PATH]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.OK_SYNCED);
});

test("judgeDocAgainstPinnedFunction: exactly ONE of three copies stale (others synced) -> still CANONICAL_NOT_SYNCED, detail names ONLY the stale one (1/3)", async () => {
  const expected = await appliedHashOf(TOUCHING_DOC, BASE_SOURCE);
  const entry = syntheticEntry(expected, {
    copyB: () => "deliberately-stale-copyB-only",
  });
  const result = await judgeDocAgainstPinnedFunction(
    TOUCHING_DOC,
    "docs/control-room-patches/fake.md",
    entry,
    {
      repoRoot,
      readFile: fakeReadFile({ [FAKE_SOURCE_PATH]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [FAKE_SOURCE_PATH]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.CANONICAL_NOT_SYNCED);
  assert.match(result.detail, /1\/3/);
  assert.match(result.detail, /copyB/);
  assert.doesNotMatch(result.detail, /copyA \(/); // copyA not listed as unsynced
  assert.doesNotMatch(result.detail, /copyC \(/);
});

test("judgeDocAgainstPinnedFunction: source resolves, patch does NOT touch the pinned function's body -> OK_UNCHANGED regardless of copy values", async () => {
  const doc = [
    `mentions ${FN} in prose only`,
    `--source scripts/check/fixtures/fake-source.ps1.txt`,
    "",
    unitBlock(
      "u1",
      "insert_after",
      "function Other() { return 1 }",
      "\nfunction Unrelated() { return 2 }",
    ),
  ].join("\n");
  const result = await judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    syntheticEntry("does-not-matter-here"),
    {
      repoRoot,
      readFile: fakeReadFile({ [FAKE_SOURCE_PATH]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [FAKE_SOURCE_PATH]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.OK_UNCHANGED);
});

test("judgeDocAgainstPinnedFunction: source resolves but patch is malformed -> PATCH_APPLY_FAILED (RED, never silently OK)", async () => {
  const doc = [
    `touches ${FN}`,
    `--source scripts/check/fixtures/fake-source.ps1.txt`,
    "",
    "```control-room-patch-unit",
    "id: broken",
    "mode: insert_after",
    "@@ANCHOR@@",
    "text that does not exist in source at all",
    "@@CONTENT@@",
    "whatever",
    "@@END@@",
    "```",
  ].join("\n");
  const result = await judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    syntheticEntry("irrelevant"),
    {
      repoRoot,
      readFile: fakeReadFile({ [FAKE_SOURCE_PATH]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [FAKE_SOURCE_PATH]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.PATCH_APPLY_FAILED);
});

test("EXEMPTIONS validation: a reason-less exemption entry throws at check time (fail-closed default cannot be silently escaped)", async () => {
  const mod = await import("./control-room-patch-canonical-sync.mjs");
  await assert.rejects(
    mod.checkControlRoomPatchCanonicalSync({
      repoRoot,
      exemptions: [{ doc: "x.md", functionName: FN, reason: "" }],
      readdir: () => [],
    }),
    /non-empty reason/,
  );
});

test("checkMentionRegistry validation: a reason-less MENTION_BASELINE reference entry throws (fail-closed)", () => {
  assert.throws(() => {
    checkMentionRegistry({
      repoRoot,
      baseline: [{ relPath: "x.mjs", role: "reference", reason: "" }],
      listTrackedFiles: () => ["x.mjs"],
      readFile: () => "no mention here",
    });
  }, /reference.*no reason|no reason/i);
});

// ---------------------------------------------------------------------
// Group 2: integration tests against the REAL repo state.
// ---------------------------------------------------------------------

test("REAL repo: every docs/control-room-patches/*.md that mentions Invoke-SeatProofGate has ALL registered copies synced (0 CANONICAL_NOT_SYNCED)", async () => {
  const result = await checkControlRoomPatchCanonicalSync({ repoRoot });
  const notSynced = result.findings.filter(
    (f) => f.reasonCode === REASON.CANONICAL_NOT_SYNCED,
  );
  assert.deepEqual(
    notSynced,
    [],
    `expected 0 CANONICAL_NOT_SYNCED findings, got: ${JSON.stringify(notSynced, null, 2)}`,
  );
  assert.equal(result.ok, true);
  const checkedRealDocs = result.findings.filter(
    (f) =>
      f.reasonCode !== REASON.OK_NOT_APPLICABLE &&
      f.functionName !== "(mention-registry)",
  );
  // HYK-422-dispatch-run-boundary.md (a patch doc for a DIFFERENT function,
  // Invoke-Dispatch) mentions Invoke-SeatProofGate only in its own §모양
  // 고정 scope-investigation prose -- that mention makes it a 3rd doc this
  // sweep judges (resolves OK_UNCHANGED, see control-room-patch-apply-
  // hyk422-canonical-scope.test.mjs), alongside the pre-existing
  // HYK-271-wire-modal-check.md and HYK-327-wire-two-checkers.md.
  assert.equal(checkedRealDocs.length, 3);
});

test("REAL repo: mention registry has 0 UNREGISTERED_MENTION findings (every git-tracked file naming Invoke-SeatProofGate is classified)", () => {
  const result = checkMentionRegistry({ repoRoot });
  assert.deepEqual(
    result.findings,
    [],
    `expected 0 unregistered mentions, got: ${JSON.stringify(result.findings, null, 2)}`,
  );
  assert.equal(result.ok, true);
});

test("REAL repo: MENTION_BASELINE's \"copy\" entries exactly match PINNED_FUNCTION_REGISTRY's registered copy paths (no drift either direction)", () => {
  const baselineCopyPaths = new Set(
    MENTION_BASELINE.filter((e) => e.role === "copy").map((e) => e.relPath),
  );
  const registryCopyPaths = new Set(
    PINNED_FUNCTION_REGISTRY.flatMap((entry) =>
      entry.copies.map((c) => c.relPath),
    ),
  );
  assert.deepEqual(
    [...baselineCopyPaths].sort(),
    [...registryCopyPaths].sort(),
  );
});

// ---------------------------------------------------------------------
// Group 3: required revert mutation, PER COPY (2R §1-2) -- each of the 4
// registered copies is independently proven load-bearing: override ONLY
// that copy's getHash to a stale value while the other 3 resolve against
// their REAL current on-disk contents (via the real ctx.readFile/
// importModule), and confirm HYK-271-wire-modal-check.md flips to
// CANONICAL_NOT_SYNCED, naming exactly that one copy. No file on disk is
// ever written in this group -- only in-memory entry overrides -- so
// there is no restoration step and no git-status risk from these tests.
// ---------------------------------------------------------------------

const REAL_DOC_TEXT = readFileSync(
  join(repoRoot, "docs/control-room-patches/HYK-271-wire-modal-check.md"),
  "utf8",
);
const STALE_SHA256_BEFORE_1R =
  "71d1f630029037d6aad5b991b07a520a1ac18b55bf8cb9f104ae0dc15de065ae";

function realEntryWithOneCopyStale(staleCopyId) {
  const real = PINNED_FUNCTION_REGISTRY[0];
  return {
    ...real,
    copies: real.copies.map((c) =>
      c.id === staleCopyId
        ? { ...c, getHash: () => STALE_SHA256_BEFORE_1R }
        : c,
    ),
  };
}

for (const copy of PINNED_FUNCTION_REGISTRY[0].copies) {
  test(`MUTATION (되돌림 변이, 사본별): reverting ONLY "${copy.id}" to the pre-1R stale value makes HYK-271-wire-modal-check.md RED, naming that copy`, async () => {
    const entry = realEntryWithOneCopyStale(copy.id);
    const result = await judgeDocAgainstPinnedFunction(
      REAL_DOC_TEXT,
      "docs/control-room-patches/HYK-271-wire-modal-check.md",
      entry,
      { repoRoot },
    );
    assert.equal(
      result.reasonCode,
      REASON.CANONICAL_NOT_SYNCED,
      `reverting only ${copy.id} must independently trip RED -- if this passes, the other copies are silently doing all the work and this one isn't load-bearing`,
    );
    assert.match(result.detail, /1\/4/);
    assert.ok(
      result.detail.includes(copy.id),
      `detail should name the specific stale copy (${copy.id}): ${result.detail}`,
    );
  });
}

test("MUTATION sanity: with NO copy reverted (real entry, real files), the same real doc is OK_SYNCED -- proves the per-copy mutations above are each a real flip, not a permanently-red fixture", async () => {
  const result = await judgeDocAgainstPinnedFunction(
    REAL_DOC_TEXT,
    "docs/control-room-patches/HYK-271-wire-modal-check.md",
    PINNED_FUNCTION_REGISTRY[0],
    { repoRoot },
  );
  assert.equal(result.reasonCode, REASON.OK_SYNCED);
});

// ---------------------------------------------------------------------
// Group 4: mention-registry ratchet mutation -- an unregistered file that
// mentions the pinned function must be caught, not silently ignored.
// ---------------------------------------------------------------------

test("MUTATION: checkMentionRegistry flags a file mentioning Invoke-SeatProofGate that ISN'T in MENTION_BASELINE", () => {
  const result = checkMentionRegistry({
    repoRoot,
    listTrackedFiles: () => ["some/new/unregistered-file.mjs"],
    readFile: () => `// this file quotes Invoke-SeatProofGate somewhere`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].reasonCode, REASON.UNREGISTERED_MENTION);
  assert.equal(result.findings[0].relPath, "some/new/unregistered-file.mjs");
});

test('MUTATION: checkMentionRegistry flags a baseline "copy" entry that no longer has a matching PINNED_FUNCTION_REGISTRY copy (registry/baseline drift)', () => {
  const result = checkMentionRegistry({
    repoRoot,
    registry: [{ functionName: FN, copies: [] }], // no copies registered at all
    baseline: [
      {
        relPath: "scripts/check/seat-proof-wrapper-canonical.json",
        role: "copy",
      },
    ],
    listTrackedFiles: () => ["scripts/check/seat-proof-wrapper-canonical.json"],
    readFile: () => `mentions ${FN}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].reasonCode, REASON.UNREGISTERED_MENTION);
});
