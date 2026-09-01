// HYK-415 (canonical-sync-1): tests for the new "does a control-room patch
// document ship with its pinned-fingerprint update?" axis. See
// control-room-patch-canonical-sync.mjs's module header for the incident
// this exists to catch.
//
// Three groups:
// 1. Synthetic unit tests (in-memory fixtures, no real docs/) covering
//    every REASON branch.
// 2. An integration test against the REAL docs/control-room-patches/ and
//    the REAL scripts/check/seat-proof-wrapper-canonical.json -- this is
//    the acceptance check for this round's own §1-1 update.
// 3. A required "되돌림 변이" (revert mutation, task §1-3): re-run the real
//    integration case with the OLD (pre-this-round) pinned sha256 in place
//    of the current one and confirm HYK-271-wire-modal-check.md flips back
//    to CANONICAL_NOT_SYNCED/RED -- proving this axis actually detects the
//    exact drift that caused today's incident, not just that it's green
//    now. The mutation is applied to an in-memory `canonical` object passed
//    into judgeDocAgainstPinnedFunction directly -- the real
//    seat-proof-wrapper-canonical.json file on disk is never written to,
//    so there is nothing to restore (no git status drift is possible from
//    this test by construction).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  REASON,
  resolveDocSourcePaths,
  judgeDocAgainstPinnedFunction,
  checkControlRoomPatchCanonicalSync,
  PINNED_FUNCTION_REGISTRY,
} from "./control-room-patch-canonical-sync.mjs";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// A tiny synthetic "wrapper script" with one pinned function, small enough
// to hand-verify every assertion below.
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

test("judgeDocAgainstPinnedFunction: doc never mentions the function name -> OK_NOT_APPLICABLE, no I/O attempted", () => {
  const doc = "this document is about something else entirely";
  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: "irrelevant" },
    { repoRoot, readFile: fakeReadFile({}) },
  );
  assert.equal(result.reasonCode, REASON.OK_NOT_APPLICABLE);
});

test("judgeDocAgainstPinnedFunction: mentions the function, zero resolvable --source -> SOURCE_UNRESOLVED (fail-closed, not skipped)", () => {
  const doc = `mentions ${FN} but names no real fixture: --source <원본>`;
  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: "irrelevant" },
    { repoRoot, readFile: fakeReadFile({}) },
  );
  assert.equal(result.reasonCode, REASON.SOURCE_UNRESOLVED);
});

test("judgeDocAgainstPinnedFunction: mentions the function, TWO resolvable --source fixtures -> SOURCE_UNRESOLVED (ambiguous, fail-closed)", () => {
  const doc = [
    `mentions ${FN}`,
    "--source scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt",
    "--source scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt",
  ].join("\n");
  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: "irrelevant" },
    { repoRoot, readFile: fakeReadFile({}) },
  );
  assert.equal(result.reasonCode, REASON.SOURCE_UNRESOLVED);
});

test("judgeDocAgainstPinnedFunction: source resolves, patch touches the function, canonical NOT updated -> CANONICAL_NOT_SYNCED (RED)", () => {
  const sourcePath = join(
    repoRoot,
    "scripts/check/fixtures/fake-source.ps1.txt",
  );
  const doc = [
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
  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: "stale-value-that-does-not-match-anything" },
    {
      repoRoot,
      readFile: fakeReadFile({ [sourcePath]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [sourcePath]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.CANONICAL_NOT_SYNCED);
});

test("judgeDocAgainstPinnedFunction: source resolves, patch touches the function, canonical IS updated to match -> OK_SYNCED", async () => {
  const sourcePath = join(
    repoRoot,
    "scripts/check/fixtures/fake-source.ps1.txt",
  );
  const doc = [
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
  // Compute the real expected fingerprint by actually applying the patch
  // (not hand-constructing the "after" text -- that risks the test
  // asserting its own guess rather than the module's real behavior).
  const { applyControlRoomPatch } =
    await import("./control-room-patch-apply.mjs");
  const { extractAllFunctionBodies } =
    await import("./seat-proof-wrapper-shape.mjs");
  const { createHash } = await import("node:crypto");
  const appliedResult = applyControlRoomPatch(doc, BASE_SOURCE);
  assert.equal(appliedResult.ok, true);
  const bodies = extractAllFunctionBodies(
    appliedResult.result.replace(/\r\n/g, "\n"),
  );
  const expectedSha256 = createHash("sha256")
    .update(bodies[bodies.length - 1], "utf8")
    .digest("hex");

  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: expectedSha256 },
    {
      repoRoot,
      readFile: fakeReadFile({ [sourcePath]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [sourcePath]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.OK_SYNCED);
});

test("judgeDocAgainstPinnedFunction: source resolves, patch does NOT touch the pinned function's body -> OK_UNCHANGED regardless of canonical value", () => {
  const sourcePath = join(
    repoRoot,
    "scripts/check/fixtures/fake-source.ps1.txt",
  );
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
  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: "does-not-matter-here" },
    {
      repoRoot,
      readFile: fakeReadFile({ [sourcePath]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [sourcePath]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.OK_UNCHANGED);
});

test("judgeDocAgainstPinnedFunction: source resolves but patch is malformed -> PATCH_APPLY_FAILED (RED, never silently OK)", () => {
  const sourcePath = join(
    repoRoot,
    "scripts/check/fixtures/fake-source.ps1.txt",
  );
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
  const result = judgeDocAgainstPinnedFunction(
    doc,
    "docs/control-room-patches/fake.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: "irrelevant" },
    {
      repoRoot,
      readFile: fakeReadFile({ [sourcePath]: BASE_SOURCE }),
      fileExists: fakeFileExists({ [sourcePath]: true }),
    },
  );
  assert.equal(result.reasonCode, REASON.PATCH_APPLY_FAILED);
});

test("EXEMPTIONS validation: a reason-less exemption entry throws at check time (fail-closed default cannot be silently escaped)", async () => {
  const mod = await import("./control-room-patch-canonical-sync.mjs");
  assert.throws(() => {
    mod.checkControlRoomPatchCanonicalSync({
      repoRoot,
      exemptions: [{ doc: "x.md", functionName: FN, reason: "" }],
      readdir: () => [],
    });
  }, /non-empty reason/);
});

// ---------------------------------------------------------------------
// Group 2: integration test against the REAL repo state (acceptance
// check for this round's §1-1 canonical.json update).
// ---------------------------------------------------------------------

test("REAL repo: every docs/control-room-patches/*.md that mentions Invoke-SeatProofGate is accounted for in the pinned fingerprint (0 CANONICAL_NOT_SYNCED)", () => {
  const result = checkControlRoomPatchCanonicalSync({ repoRoot });
  const notSynced = result.findings.filter(
    (f) => f.reasonCode === REASON.CANONICAL_NOT_SYNCED,
  );
  assert.deepEqual(
    notSynced,
    [],
    `expected 0 CANONICAL_NOT_SYNCED findings, got: ${JSON.stringify(notSynced, null, 2)}`,
  );
  assert.equal(result.ok, true);
  // Sanity: this suite does find and check the two docs known to mention
  // the function (HYK-271-wire-modal-check.md, HYK-327-wire-two-checkers.md)
  // -- a suite that silently found 0 docs at all would vacuously "pass."
  const checkedRealDocs = result.findings.filter(
    (f) => f.reasonCode !== REASON.OK_NOT_APPLICABLE,
  );
  assert.equal(checkedRealDocs.length, 2);
});

// ---------------------------------------------------------------------
// Group 3: required revert mutation (task §1-3) -- prove this axis
// actually catches today's exact incident shape, not just that it's
// green now. In-memory canonical object only; the real file on disk is
// never touched, so there is no restoration step needed (proven by the
// group-2 test above still passing after this one, in the same process).
// ---------------------------------------------------------------------

test("MUTATION (되돌림 변이): reverting the pinned sha256 to the pre-this-round (stale) value makes HYK-271-wire-modal-check.md RED again", () => {
  const docPath = `${repoRoot}/docs/control-room-patches/HYK-271-wire-modal-check.md`;
  const docText = readFileSync(docPath, "utf8");
  const STALE_SHA256_BEFORE_THIS_ROUND =
    "71d1f630029037d6aad5b991b07a520a1ac18b55bf8cb9f104ae0dc15de065ae";

  const result = judgeDocAgainstPinnedFunction(
    docText,
    "docs/control-room-patches/HYK-271-wire-modal-check.md",
    PINNED_FUNCTION_REGISTRY[0],
    { sha256: STALE_SHA256_BEFORE_THIS_ROUND },
    { repoRoot },
  );
  assert.equal(
    result.reasonCode,
    REASON.CANONICAL_NOT_SYNCED,
    "reverting the pinned fingerprint must reproduce today's incident detection -- if this passes with the stale value, the axis cannot actually catch the drift it exists for",
  );

  // Confirm the REAL (current, on-disk) canonical value is not the stale
  // one -- i.e. this round's actual §1-1 update is genuinely different
  // from what the mutation just proved is unsafe.
  const realCanonical = JSON.parse(
    readFileSync(
      `${repoRoot}/scripts/check/seat-proof-wrapper-canonical.json`,
      "utf8",
    ),
  );
  assert.notEqual(realCanonical.sha256, STALE_SHA256_BEFORE_THIS_ROUND);
});
