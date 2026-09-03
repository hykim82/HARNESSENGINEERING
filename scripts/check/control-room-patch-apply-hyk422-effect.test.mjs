// HYK-422-dispatch-run-1 (coder-task.md §2⑷ⓐⓑ) -- does the applied
// dispatch-worker.ps1 fixture's Invoke-Dispatch function ACTUALLY surface
// the D14 stale-cleanup failure reason on screen, instead of the pre-patch
// behavior of silently discarding it via `| Out-Null`?
//
// Two layers (HYK-378-effect precedent, same split):
//   1. String/structure checks -- "does the applied fixture's TEXT promise
//      the fail-visible behavior". Cheap, mutation-testable, but only
//      proves the words are there.
//   2. ★근본: an ACTUAL PowerShell process running the REAL extracted
//      Invoke-Dispatch function body (never a hand-reimplemented stand-in)
//      against a synthetic `orca` stub (합성 표적, 진짜 배달기 아님) that
//      simulates the "stale active dispatch" retry path with a controllable
//      task-update response. Answers what layer 1 cannot: does the failure
//      reason really reach stdout, does success stay silent (회귀 0), and
//      does the retry keep happening regardless (동작 변경 최소).
//
// findPowerShell() reused as-is from seat-proof-wrapper-behavior.mjs
// (HYK-323 precedent), same as HYK-378-effect.
//
// ⚠️정직 한계: ⓐ 관제실의 살아 있는 dispatch-worker.ps1은 이 시험 어디서도
// 열지 않는다(라이브 드리프트를 못 잡는다) ⓑ 이 스텁 `orca` 함수는 실제
// orca CLI의 JSON 스키마를 coder-task.md §1이 인용한 실사고 문구
// (`consumer_fenced: ...`)를 그대로 흉내낼 뿐, 진짜 CLI를 호출해 스키마를
// 재확인하지 않는다(라이브 명령 실행 금지 범위 안) ⓒ PowerShell이 없는
// 환경(CI 등)에서는 레이어 2 전체가 SKIP_REASON 표지와 함께 시끄럽게
// 건너뛴다 -- 조용한 스킵은 없다(HYK-365 형태 방지).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "./seat-proof-wrapper-behavior.mjs";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-applied.ps1.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const NO_OUT_NULL_ON_CLEANUP_SNIPPET =
  "$staleCleanupRaw = (& orca orchestration task-update --id $stale --status completed --json)";
const FAILURE_REPORT_SNIPPET =
  'Write-Host "      stale 정리 실패(HYK-422 -- D14 무음 삼킴 수리, 이전엔 이 사유가 화면에 안 떴다): $staleCleanupReason"';
const NEXT_ACTION_SNIPPET =
  'Write-Host "      다음 행동: 앞 Run 에 run-use 로 붙어 잔여 배정을 닫아라"';
const RETRY_UNCHANGED_SNIPPET = "Start-Sleep -Milliseconds 400";

function hasCleanupCallPromise(text) {
  return text.includes(NO_OUT_NULL_ON_CLEANUP_SNIPPET);
}
function hasFailureReportPromise(text) {
  return text.includes(FAILURE_REPORT_SNIPPET);
}
function hasNextActionPromise(text) {
  return text.includes(NEXT_ACTION_SNIPPET);
}

test("claim: applied fixture's D14 cleanup call no longer pipes to Out-Null", () => {
  assert.equal(hasCleanupCallPromise(loadApplied()), true);
  assert.equal(
    loadApplied().includes("--status completed --json | Out-Null"),
    false,
  );
});
test("claim: applied fixture promises a visible failure-report line when cleanup's ok is falsy", () => {
  assert.equal(hasFailureReportPromise(loadApplied()), true);
});
test("claim: applied fixture promises a next-action hint line alongside the failure report", () => {
  assert.equal(hasNextActionPromise(loadApplied()), true);
});
test("claim: the retry (Start-Sleep + second dispatch call) is untouched -- appears exactly once, unconditionally after the cleanup block", () => {
  const text = loadApplied();
  const count = text.split(RETRY_UNCHANGED_SNIPPET).length - 1;
  assert.equal(count, 1);
});

// ---- ★anti-vacuity (양방향) ----

test("★anti-vacuity (양방향): deleting the failure-report promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(FAILURE_REPORT_SNIPPET, "");
  assert.equal(hasFailureReportPromise(mutatedRed), false);
  assert.equal(hasFailureReportPromise(original), true);
});
test("★anti-vacuity (양방향): deleting the next-action promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(NEXT_ACTION_SNIPPET, "");
  assert.equal(hasNextActionPromise(mutatedRed), false);
  assert.equal(hasNextActionPromise(original), true);
});

// ---------------------------------------------------------------------------
// ★근본: drive the REAL applied-fixture's Invoke-Dispatch function body (the
// whole function, sliced verbatim) in a real PowerShell process, with a
// synthetic `orca` function stub standing in for the external CLI. Never a
// reimplementation of Invoke-Dispatch's own logic.
// ---------------------------------------------------------------------------

const START_MARKER =
  "function Invoke-Dispatch([string]$task, [string]$to, [bool]$inject) {";
const END_MARKER = "\n\nfunction Norm([string]$p) {";

function extractInvokeDispatchFunction(appliedText) {
  const first = appliedText.indexOf(START_MARKER);
  if (first === -1) {
    throw new Error(
      "extractInvokeDispatchFunction: start marker not found -- fixture drifted from what this test was written against",
    );
  }
  const secondStart = appliedText.indexOf(START_MARKER, first + 1);
  if (secondStart !== -1) {
    throw new Error(
      "extractInvokeDispatchFunction: start marker is not unique -- cannot slice unambiguously",
    );
  }
  const end = appliedText.indexOf(END_MARKER, first);
  if (end === -1) {
    throw new Error(
      "extractInvokeDispatchFunction: end marker not found after start -- fixture drifted",
    );
  }
  return appliedText.slice(first, end);
}

test("self-check: Invoke-Dispatch's start/end markers are unique and the slice is a well-formed function (before trusting the behavioral tests below)", () => {
  const snippet = extractInvokeDispatchFunction(loadApplied());
  assert.ok(snippet.startsWith(START_MARKER));
  assert.ok(snippet.trimEnd().endsWith("}"));
  assert.equal(
    (snippet.match(/\{/g) || []).length,
    (snippet.match(/\}/g) || []).length,
    "extracted function text must have balanced braces",
  );
});

// Simulates: 1st `orchestration dispatch` call fails with the exact
// consumer_fenced-shaped "already has an active dispatch" message
// coder-task.md §1 quotes from the real incident; then a `task-update`
// call whose ok/error the test controls; then a 2nd `orchestration dispatch`
// call that always succeeds (mirrors D14's own documented safety claim --
// this round does not re-litigate that claim, see patch doc §ⓒ-1).
function buildHarness(realFunctionSnippet, taskUpdateResponseJson) {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Mirrors the live dispatch-worker.ps1's own top-of-file convention
    // (line 53-54, quoted in the patch doc §ⓐ): without this, PowerShell's
    // default console output encoding on this OS mangles the Korean text
    // in Write-Host, and Node's spawnSync (encoding:'utf8') then fails to
    // find the exact Korean substrings this test asserts on -- caught
    // during this round's own verification (see .harness/coder.md).
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$Global:OrcaCallLog = New-Object System.Collections.Generic.List[string]",
    "function orca {",
    "  $callArgs = $args",
    "  $joined = ($callArgs -join ' ')",
    "  $Global:OrcaCallLog.Add($joined)",
    "  if ($callArgs[1] -eq 'dispatch') {",
    "    $dispatchCalls = ($Global:OrcaCallLog | Where-Object { $_ -like 'orchestration dispatch*' }).Count",
    "    if ($dispatchCalls -eq 1) {",
    '      \'{"ok":false,"error":{"message":"already has an active dispatch(task_stale0fad) for task task_stale0fad"}}\'',
    "    } else {",
    "      '{\"ok\":true}'",
    "    }",
    "  } elseif ($callArgs[1] -eq 'task-update') {",
    `    '${taskUpdateResponseJson.replace(/'/g, "''")}'`,
    "  } else {",
    '    throw "unexpected orca stub call: $joined"',
    "  }",
    "}",
    "",
    realFunctionSnippet,
    "",
    "$result = Invoke-Dispatch -task 'task_x' -to 'term_y' -inject $false",
    'Write-Host "RESULT_OK=$($result.ok)"',
    "Write-Host \"DISPATCH_CALL_COUNT=$(($Global:OrcaCallLog | Where-Object { $_ -like 'orchestration dispatch*' }).Count)\"",
    "Write-Host \"TASKUPDATE_CALL_COUNT=$(($Global:OrcaCallLog | Where-Object { $_ -like 'orchestration task-update*' }).Count)\"",
    "exit 0",
  ].join("\n");
}

function runSyntheticTarget(taskUpdateResponseJson, psExe) {
  const snippet = extractInvokeDispatchFunction(loadApplied());
  const dir = mkdtempSync(join(tmpdir(), "hyk422-effect-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(
      harnessPath,
      buildHarness(snippet, taskUpdateResponseJson),
      "utf8",
    );
    return spawnSync(
      psExe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PS_EXE = findPowerShell();
const NO_PS_SKIP_REASON =
  "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh) -- coder-task.md §0.5 forbids a SILENT skip here, so this reason string is the loud marker; layer-1 string checks above still ran and still gate this file";

test("★근본 행동 ⓐ: task-update fails (consumer_fenced) -- the failure reason string reaches stdout, and the retry still runs to success; PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const failJson =
    '{"ok":false,"error":{"message":"consumer_fenced: This coordinator terminal is bound to run_99c..., not run_2e4..."}}';
  const result = runSyntheticTarget(failJson, PS_EXE);
  assert.equal(
    result.status,
    0,
    `harness itself must exit 0, got stderr=${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("consumer_fenced"),
    `expected the cleanup failure reason to reach stdout, got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes(
      "다음 행동: 앞 Run 에 run-use 로 붙어 잔여 배정을 닫아라",
    ),
    `expected the next-action hint to reach stdout, got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("DISPATCH_CALL_COUNT=2"),
    `expected the retry to still happen after a cleanup failure (2 dispatch calls total), got:\n${result.stdout}`,
  );
  assert.ok(result.stdout.includes("RESULT_OK=True"));
});

test("★근본 행동 ⓑ (회귀 0): task-update succeeds -- NO failure line appears, and the retry still runs exactly the same as the failure case; PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const okJson = '{"ok":true}';
  const result = runSyntheticTarget(okJson, PS_EXE);
  assert.equal(
    result.status,
    0,
    `harness itself must exit 0, got stderr=${result.stderr}`,
  );
  assert.ok(
    !result.stdout.includes("stale 정리 실패"),
    `expected NO failure line when cleanup succeeds, got:\n${result.stdout}`,
  );
  assert.ok(
    !result.stdout.includes("다음 행동:"),
    `expected NO next-action hint when cleanup succeeds, got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("DISPATCH_CALL_COUNT=2"),
    `expected the retry to still happen after a cleanup success (2 dispatch calls total, unchanged from the failure case), got:\n${result.stdout}`,
  );
  assert.ok(result.stdout.includes("TASKUPDATE_CALL_COUNT=1"));
});

// ---- ★되돌림 변이 3/3 (행동 축): reverting the applied fixture's cleanup
// call to the PRE-PATCH `| Out-Null` text must make the failure reason
// UNREACHABLE on stdout even when task-update fails -- the behavioral
// mirror of the collect test's document-level revert mutations.
test("★되돌림 변이 3/3 (행동 축): replacing the applied function's cleanup block with the OLD pre-patch `| Out-Null` line reproduces the original bug (failure reason never reaches stdout); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const applied = loadApplied();
  const preP = extractInvokeDispatchFunction(applied);
  const oldBlock = [
    "    $staleCleanupRaw = (& orca orchestration task-update --id $stale --status completed --json)",
    "    try {",
    "      $staleCleanup = $staleCleanupRaw | ConvertFrom-Json",
    "    } catch {",
    "      $staleCleanup = $null",
    "    }",
    "    if (-not $staleCleanup -or -not $staleCleanup.ok) {",
    "      $staleCleanupReason = if ($staleCleanup) { $staleCleanup.error.message } else { $staleCleanupRaw }",
    '      Write-Host "      stale 정리 실패(HYK-422 -- D14 무음 삼킴 수리, 이전엔 이 사유가 화면에 안 떴다): $staleCleanupReason"',
    '      Write-Host "      다음 행동: 앞 Run 에 run-use 로 붙어 잔여 배정을 닫아라"',
    "    }",
  ].join("\n");
  assert.notEqual(
    preP.indexOf(oldBlock),
    -1,
    "sanity-check: applied text must still contain the new block verbatim",
  );
  const revertedSnippet = preP.replace(
    oldBlock,
    "    & orca orchestration task-update --id $stale --status completed --json | Out-Null",
  );
  assert.notEqual(revertedSnippet, preP);

  const failJson =
    '{"ok":false,"error":{"message":"consumer_fenced: This coordinator terminal is bound to run_99c..., not run_2e4..."}}';
  const dir = mkdtempSync(join(tmpdir(), "hyk422-effect-revert-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(revertedSnippet, failJson), "utf8");
    const result = spawnSync(
      PS_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `harness itself must exit 0, got stderr=${result.stderr}`,
    );
    assert.ok(
      !result.stdout.includes("consumer_fenced"),
      `pre-patch text must NOT surface the cleanup failure reason (that is exactly the bug this patch fixes) -- got:\n${result.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
