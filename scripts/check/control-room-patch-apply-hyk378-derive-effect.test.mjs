// HYK-378-ps1-derive-consume-1 (coder-task.md §3) -- does the APPLIED
// dispatch-worker.ps1 fixture ACTUALLY derive the real Claude session-folder
// name for a non-ASCII worktree path, instead of the old self-computed fold
// that pointed at a folder that does not exist (ORCH-84 measured incident)?
//
// Two layers (same split as the HYK-280-exit5 precedent):
//   A. values, no PowerShell: the #294 single-source CLI and the canonical
//      function reproduce the spec's measured literals, and the old fold
//      does not (this is what makes the layer-B comparisons discriminating).
//   B. ★근본: a real PowerShell process runs the block extracted VERBATIM from
//      the applied fixture, against a synthetic worktree whose CLI is a copy
//      of the real one (copied into a temp dir -- no junction, no live path).
//      The expected folder name is computed by the canonical function from the
//      input path inside THIS test, never read back from the fixture -- so a
//      doc+fixture+hash co-change cannot make this test green by itself.
//
// ⛔Never touches the live control-room dispatch-worker.ps1, the live ledger,
// or any real seat. Never reads the real ~/.claude-team folder.
//
// ⚠️정직 한계: 레이어 B 는 pwsh 로 블록을 실행하지만, 실제 배달의 나머지 흐름
// (launcher 읽기 · 감시 루프)은 돌리지 않는다. 그 블록이 끝난 뒤의 소비
// 로직은 HYK-280/272 시험이 맡는다. pwsh 가 없으면 SKIP_REASON 과 함께 건너뛴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "./seat-proof-wrapper-behavior.mjs";
import { deriveClaudeProjectDirName } from "../supervisor/rate-limit-stall-adapter.mjs";

const CLI_PATH = fileURLToPath(
  new URL("../supervisor/derive-claude-project-dir-cli.mjs", import.meta.url),
);
const ADAPTER_PATH = fileURLToPath(
  new URL("../supervisor/rate-limit-stall-adapter.mjs", import.meta.url),
);
const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk378-derive-applied.ps1.txt",
    import.meta.url,
  ),
);
const BEFORE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-10-03-hyk378-derive-before.ps1.txt",
    import.meta.url,
  ),
);

// Spec literals (coder-task.md §1 N-1 table, ORCH-84 measured 2026-10-03).
// Written here as LITERALS on purpose -- they are the external ground truth.
const SPEC_WORKTREE =
  "C:\\Users\\Administrator\\orca\\workspaces\\모바일마크다운에디터\\hyk304-pathname-guard-review-1";
const SPEC_OLD_FOLD =
  "C--Users-Administrator-orca-workspaces-모바일마크다운에디터-hyk304-pathname-guard-review-1";
const SPEC_REAL_FOLDER =
  "C--Users-Administrator-orca-workspaces------------hyk304-pathname-guard-review-1";

const PS_EXE = findPowerShell();
// findPowerShell() returns a bare command name ("pwsh"). B3 empties PATH on
// purpose, so it needs the ABSOLUTE path, resolved while PATH is still intact.
function resolveAbsolute(name) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const out = spawnSync(lookup, [name], { encoding: "utf8" }).stdout ?? "";
  return out.split(/\r?\n/)[0].trim() || name;
}
const PS_ABS = PS_EXE ? resolveAbsolute(PS_EXE) : null;
const NO_PS_SKIP_REASON =
  "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh) -- coder-task.md §6 forbids a SILENT skip here, so this reason string is the loud marker; layer-A value checks above still ran and still gate this file";

// The block the patch inserts, cut out of the applied fixture by its own
// opening comment and its own closing line -- NOT a hand-copied string.
const BLOCK_START = "  # HYK-378 ps1-derive(";
const BLOCK_END =
  "    $confirmClaudeBaseline = Confirm-GetClaudeBytes $confirmProjectDir\n  }\n";
const OLD_LINE =
  "  $confirmProjectName = [string]$Worktree -replace '[\\\\/:]', '-'\n";

function extractDeriveBlock(text) {
  assert.equal(
    text.split(BLOCK_START).length - 1,
    1,
    "the block's opening comment must be unique in the applied fixture",
  );
  const start = text.indexOf(BLOCK_START);
  const endAt = text.indexOf(BLOCK_END, start);
  assert.ok(endAt > start, "the block's closing line must follow its opening");
  return text.slice(start, endAt + BLOCK_END.length);
}

// Runs one PowerShell harness from the given text.
function runHarness(psExe, text, env) {
  const dir = mkdtempSync(join(tmpdir(), "hyk378-derive-behavior-"));
  try {
    const path = join(dir, "harness.ps1");
    writeFileSync(path, text, "utf8");
    return spawnSync(
      psExe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path],
      { encoding: "utf8", env: env ?? process.env },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reads one `KEY=value` line the harness printed (last one wins).
function field(stdout, key) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .filter((l) => l.startsWith(key + "="));
  return lines.length ? lines[lines.length - 1].slice(key.length + 1) : null;
}

// Console output is forced to UTF-8 so non-ASCII values come back intact
// (the default OEM code page garbled the Korean literal in the first run).
const UTF8_OUT = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8";

function harnessFor({ block, worktree, sessionHome }) {
  return [
    UTF8_OUT,
    "$ErrorActionPreference = 'Stop'",
    `$Worktree = '${worktree}'`,
    `$confirmSessionHome = '${sessionHome}'`,
    "$confirmProjectDir = 'unavailable'",
    "function Confirm-GetClaudeBytes([string]$ProjectDir) {",
    '  Write-Host "CONFIRM_CALLED=$ProjectDir"',
    "  return [pscustomobject]@{ ok = $true; totalBytes = [int64]0; files = @{}; error = '' }",
    "}",
    "if ($true) {",
    block,
    "}",
    'Write-Host "PROJECT_NAME=$confirmProjectName"',
    'Write-Host "PROJECT_DIR=$confirmProjectDir"',
    'Write-Host "BASELINE_OK=$($confirmClaudeBaseline.ok)"',
    'Write-Host "BASELINE_ERR=$($confirmClaudeBaseline.error)"',
    'Write-Host "REACHED_END=yes"',
    "exit 0",
  ].join("\n");
}

// ---- layer A: values, no PowerShell -------------------------------------

test("A1: the #294 single-source CLI reproduces the spec's measured REAL folder name for the spec's worktree path (no filesystem access needed)", () => {
  const r = spawnSync(process.execPath, [CLI_PATH, SPEC_WORKTREE], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, SPEC_REAL_FOLDER + "\n");
});

test("A2: the canonical function agrees with the spec's measured REAL folder name", () => {
  assert.equal(deriveClaudeProjectDirName(SPEC_WORKTREE), SPEC_REAL_FOLDER);
});

test("A3: the OLD fold (only separators folded) yields the spec's measured NON-EXISTENT name, and it differs from the real one (this is what makes the layer-B comparisons discriminating)", () => {
  const oldFold = SPEC_WORKTREE.replace(/[\\/:]/g, "-");
  assert.equal(oldFold, SPEC_OLD_FOLD);
  assert.notEqual(oldFold, SPEC_REAL_FOLDER);
});

// ---- layer B: real PowerShell against the applied block ------------------

const applied = readFileSync(APPLIED_PATH, "utf8");
const before = readFileSync(BEFORE_PATH, "utf8");

test("B0 (self-check): the applied block is extracted from the applied fixture and is not the old fold; the before fixture still has the old line", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const block = extractDeriveBlock(applied);
  assert.ok(block.includes("& node $deriveCliPath $Worktree 2>&1"));
  assert.equal(block.includes("-replace '[\\\\/:]'"), false);
  assert.equal(before.includes(OLD_LINE), true);
});

test("B1: ★success -- the applied block, run on a non-ASCII worktree whose CLI is present, derives the canonical folder name for THAT path and passes it to the baseline read", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "hyk378-derive-root-"));
  try {
    const wt = join(
      root,
      "모바일마크다운에디터",
      "hyk304-pathname-guard-review-1",
    );
    const supervisor = join(wt, "scripts", "supervisor");
    mkdirSync(supervisor, { recursive: true });
    copyFileSync(
      CLI_PATH,
      join(supervisor, "derive-claude-project-dir-cli.mjs"),
    );
    copyFileSync(
      ADAPTER_PATH,
      join(supervisor, "rate-limit-stall-adapter.mjs"),
    );
    const sessionHome = join(root, "claude-home");
    // The expected value is computed from the INPUT path here, never read from the fixture.
    const expectedName = deriveClaudeProjectDirName(wt);
    assert.match(
      expectedName,
      /^[A-Za-z0-9-]+$/,
      "the expected name must be ASCII-only",
    );
    const r = runHarness(
      PS_EXE,
      harnessFor({
        block: extractDeriveBlock(applied),
        worktree: wt,
        sessionHome,
      }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(field(r.stdout, "PROJECT_NAME"), expectedName);
    assert.equal(
      field(r.stdout, "PROJECT_DIR"),
      join(sessionHome, "projects", expectedName),
    );
    assert.equal(field(r.stdout, "BASELINE_OK"), "True");
    assert.equal(field(r.stdout, "REACHED_END"), "yes");
    assert.ok(
      String(r.stdout).includes(
        `CONFIRM_CALLED=${join(sessionHome, "projects", expectedName)}`,
      ),
      "the baseline read must receive the derived folder, not the old fold",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B2: ★fail-loud -- the applied block on the spec's worktree literal (which does NOT exist here, so the CLI cannot run) never returns the OLD fold; it marks the baseline unknown and skips the read", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const r = runHarness(
    PS_EXE,
    harnessFor({
      block: extractDeriveBlock(applied),
      worktree: SPEC_WORKTREE,
      sessionHome: "C:\\synthetic-claude-home",
    }),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(field(r.stdout, "PROJECT_DIR"), "unavailable");
  assert.equal(field(r.stdout, "BASELINE_OK"), "False");
  assert.ok(
    String(field(r.stdout, "BASELINE_ERR") ?? "").includes("derive CLI exit="),
    "the failure reason must name the derive CLI exit (not an empty string)",
  );
  assert.equal(
    String(r.stdout).includes("CONFIRM_CALLED="),
    false,
    "no baseline read on a failed derive",
  );
  assert.equal(
    String(r.stdout).includes(SPEC_OLD_FOLD),
    false,
    "the old fold must never leak back in",
  );
  assert.equal(field(r.stdout, "REACHED_END"), "yes");
});

test("B3: ★fail-loud -- when `node` itself cannot be launched (PATH emptied), the applied block takes the launch-failure arm instead of crashing or returning a folder", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "hyk378-derive-nonode-"));
  try {
    const wt = join(root, "모바일마크다운에디터", "nocli");
    mkdirSync(wt, { recursive: true });
    const emptyPath = join(root, "empty-path");
    mkdirSync(emptyPath);
    const r = runHarness(
      PS_ABS,
      harnessFor({
        block: extractDeriveBlock(applied),
        worktree: wt,
        sessionHome: join(root, "h"),
      }),
      { ...process.env, PATH: emptyPath },
    );
    assert.equal(
      field(r.stdout, "REACHED_END"),
      "yes",
      `harness did not reach its end: ${r.stderr}`,
    );
    assert.equal(field(r.stdout, "PROJECT_DIR"), "unavailable");
    assert.equal(field(r.stdout, "BASELINE_OK"), "False");
    assert.ok(
      String(field(r.stdout, "BASELINE_ERR") ?? "").length > 0,
      "the launch failure must leave a non-empty reason",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B4: ★discrimination -- the OLD line, run in PowerShell on the same non-ASCII input, yields the non-existent fold and NOT the real folder (so B1 would go RED on the old computation)", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const oldHarness = [
    UTF8_OUT,
    "$ErrorActionPreference = 'Stop'",
    `$Worktree = '${SPEC_WORKTREE}'`,
    OLD_LINE.trimEnd(),
    'Write-Host "PROJECT_NAME=$confirmProjectName"',
  ].join("\n");
  const r = runHarness(PS_EXE, oldHarness);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(field(r.stdout, "PROJECT_NAME"), SPEC_OLD_FOLD);
  assert.notEqual(field(r.stdout, "PROJECT_NAME"), SPEC_REAL_FOLDER);
});
