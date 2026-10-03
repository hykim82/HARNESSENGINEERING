// HYK-472 (coder-task.md §2-ⓑ · §3 행동 축) -- does the APPLIED
// dispatch-worker.ps1 fixture's retry block ACTUALLY wait for a late engine
// marker, and give up with a non-zero exit when the marker never shows?
//
// Layer 2 only (the string-presence layer is the collect test's job):
// a real PowerShell process runs the block sliced verbatim from the applied
// fixture. Free variables are set by a synthetic harness, `orca` is a stub
// function whose banner depends on how many times it has been called, and
// `node` + seat-engine-detect.mjs are the REAL ones -- so "unknown -> wait ->
// measured" travels through the real CLI.
//
// ⚠️정직 한계: the stub decides WHEN the banner appears, so this proves the
// control flow (wait, re-read, cap, fail), not how long a real seat takes to
// print its banner. ⚠️Only exercised on Windows PowerShell here; not re-run
// on a Linux CI pwsh (see the patch doc §6). Spawns real `node` and real
// `pwsh`; if pwsh is absent the tests SKIP loudly with a reason (never silent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "./seat-proof-wrapper-behavior.mjs";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk472-engine-wait-applied.ps1.txt",
    import.meta.url,
  ),
);
const BEFORE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk472-engine-wait-before.ps1.txt",
    import.meta.url,
  ),
);
const SEAT_CLI_PATH = fileURLToPath(
  new URL("./seat-engine-detect.mjs", import.meta.url),
);

// The block starts at the cap declaration and ends right before the live
// script's own result-consumption `foreach` line (which is NOT part of the
// patch -- the rejection after the loop is the pre-existing exit-9 path).
const BLOCK_START = "$engineDetectMaxAttempts = 10";
const BLOCK_END = "foreach ($line in @($engineDetectOut))";
// The pre-patch single pass, verbatim from the before fixture (the anchor).
const ONE_PASS_START =
  "& orca terminal show --terminal $handle --json | Out-File";
const ONE_PASS_END = "foreach ($line in @($engineDetectOut))";

function sliceBetween(text, startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  const e = text.indexOf(endMarker, s + 1);
  if (s === -1 || e === -1) {
    throw new Error(
      `sliceBetween: markers not found (start=${s}, end=${e}) -- fixture drifted from what this test was written against`,
    );
  }
  return text.slice(s, e);
}

// PowerShell harness: sets the free variables the real block uses, defines
// the orca stub (banner appears on call number STUB_CLAUDE_AFTER), runs the
// sliced block, then mirrors the live script's exit-9 rejection.
function buildHarness(blockText, dir) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$env:TEMP = '${dir.replace(/'/g, "''")}'`,
    "$handle = 'term_synthetic'",
    "$Task = 'HYK-472-SYNTH'",
    "$Role = 'CODER'",
    `$engineDetectCliPath = '${SEAT_CLI_PATH.replace(/'/g, "''")}'`,
    '$engineDetectShowPath = Join-Path $env:TEMP "hyk472-engine-detect-$Task-terminal-show.json"',
    "$script:orcaCalls = 0",
    "function orca {",
    "  $script:orcaCalls++",
    "  $after = [int]$env:STUB_CLAUDE_AFTER",
    "  $preview = if ($script:orcaCalls -ge $after) { 'Opus 5 bypass permissions' } else { 'PS C:/synthetic>' }",
    '  Write-Output (\'{"result":{"terminal":{"preview":"\' + $preview + \'"}}}\')',
    "}",
    blockText,
    'Write-Output "CALLS=$script:orcaCalls EXIT=$engineDetectExit"',
    'if ($engineDetectExit -ne 0) { Write-Output "OUT=$($engineDetectOut | Out-String)"; exit 9 }',
    "$engineDetectResult = ($engineDetectOut | Select-Object -Last 1 | ConvertFrom-Json)",
    'Write-Output "ENGINE=$($engineDetectResult.engine) SOURCE=$($engineDetectResult.source)"',
    "exit 0",
    "",
  ].join("\n");
}

function runHarness(psExe, blockText, stubClaudeAfter) {
  const dir = mkdtempSync(join(tmpdir(), "hyk472-wait-effect-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(blockText, dir), "utf8");
    return spawnSync(
      psExe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      {
        encoding: "utf8",
        timeout: 120000,
        env: {
          ...process.env,
          STUB_CLAUDE_AFTER: String(stubClaudeAfter),
          // `& node` inside the block must resolve to the same node running
          // this test, so the real CLI is the one executed.
          PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PS_EXE = findPowerShell();
const NO_PS_SKIP_REASON =
  "SKIP_REASON: no PowerShell executable found on PATH -- the behavioral layer for the HYK-472 wait block cannot run here; the collect test still gates the document and fixtures";

const applied = readFileSync(APPLIED_PATH, "utf8");
const block = sliceBetween(applied, BLOCK_START, BLOCK_END);

test("self-check: the retry block is present in the applied fixture exactly once and slices to a loop, not the old single pass", () => {
  assert.equal(applied.split(BLOCK_START).length - 1, 1);
  assert.match(
    block,
    /for \(\$engineDetectAttempt = 1; \$engineDetectAttempt -le \$engineDetectMaxAttempts;/,
  );
  assert.equal(
    block.includes("Start-Sleep -Seconds $engineDetectRetrySeconds"),
    true,
  );
});

test("★behavior: banner appears on the 3rd read -> the block waits, re-reads, and ends with the MEASURED engine (exit 0, 3 reads, 2 waits)", (t) => {
  if (!PS_EXE) return t.skip(NO_PS_SKIP_REASON);
  const r = runHarness(PS_EXE, block, 3);
  assert.equal(
    r.status,
    0,
    `expected exit 0 -- got ${r.status}\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /CALLS=3 EXIT=0/);
  assert.match(r.stdout, /ENGINE=claude SOURCE=measured-preview/);
  assert.match(r.stdout, /attempt 1\/10/);
  assert.match(r.stdout, /attempt 2\/10/);
});

test("★behavior: banner shows on the 1st read -> no wait at all (exit 0, 1 read, no retry message)", (t) => {
  if (!PS_EXE) return t.skip(NO_PS_SKIP_REASON);
  const r = runHarness(PS_EXE, block, 1);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /CALLS=1 EXIT=0/);
  assert.doesNotMatch(r.stdout, /attempt 1\/10/);
});

test("★behavior: banner NEVER appears -> capped at 10 reads, then rejected (exit 9, reason UNKNOWN_SEAT_ENGINE carried through), never guessed", (t) => {
  if (!PS_EXE) return t.skip(NO_PS_SKIP_REASON);
  const r = runHarness(PS_EXE, block, 999);
  assert.equal(
    r.status,
    9,
    `expected the cap to reject with exit 9 -- got ${r.status}\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /CALLS=10 EXIT=2/);
  assert.match(r.stdout, /UNKNOWN_SEAT_ENGINE/);
  assert.doesNotMatch(r.stdout, /ENGINE=claude|ENGINE=codex/);
});

test("★anti-vacuity (행동 축): the PRE-PATCH single pass with the SAME late banner (appears on 3rd read) rejects on the first read -- so the wait, not luck, is what made the first test succeed", (t) => {
  if (!PS_EXE) return t.skip(NO_PS_SKIP_REASON);
  const beforeText = readFileSync(BEFORE_PATH, "utf8");
  const onePass = sliceBetween(beforeText, ONE_PASS_START, ONE_PASS_END);
  const r = runHarness(PS_EXE, onePass, 3);
  assert.equal(
    r.status,
    9,
    `single pass must reject on the first unknown read -- got ${r.status}\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /CALLS=1 EXIT=2/);
});
