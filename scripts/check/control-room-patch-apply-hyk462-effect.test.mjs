// HYK-462 (coder-task.md §2/§3) -- does the applied orca-worker-seat.ps1
// fixture ACTUALLY carry (a) a fail-closed seat-config-inject gate that
// blocks launch on failure, exactly like the existing seat-preflight gate
// it sits next to, and (b) the model-drift fix (gpt-5.6-terra +
// reasoning_effort=xhigh for REVIEW, gpt-5.6-sol + high for PM,
// unchanged)?
//
// Two layers (HYK-378/HYK-379/HYK-422 선례와 동일 분리):
//   1. 문자열/구조 검사 -- "적용본이 그 문장을 약속하는가"만 본다.
//   2. ★근본: 적용본에서 그대로 추출한 게이트 줄을 REAL pwsh 프로세스로
//      구동해 -- 진짜 seat-config-inject.mjs를 진짜 실패 조건으로 호출했을
//      때 -- "$LASTEXITCODE -ne 0 브랜치가 실제로 타서 exit이 일어나는가"를
//      실측한다. 이건 orca를 전혀 호출하지 않는다 -- 이 워크트리 안의 진짜
//      node 스크립트를 합성 인자로 구동할 뿐이다(§0-1 비저촉).
//
// ⚠️정직 한계:
//  ⓐ 이 시험은 라이브 좌석을 실제로 기동해 "화면에 BLOCKED가 뜨고 다음
//     명령이 절대 실행되지 않는다"까지 관찰하지 않는다 -- pwsh 자체를
//     구동해 같은 제어 흐름(조건부 exit)이 실제로 발동하는지만 본다.
//  ⓑ pwsh가 이 기계(CI 포함)에 없으면 레이어 2를 SKIP_REASON과 함께
//     **시끄럽게** 건너뛴다(조용한 스킵 금지) -- 레이어 1(문자열 검사)만
//     남는다.
//  ⓒ `reasoning_effort`가 codex 내부에 실제로 먹히는지는 문자열 계약까지만
//     본다 -- 패치 문서 §5에 이미 명시.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-orca-worker-seat-2026-09-10-hyk462-seat-config-injection-applied.ps1.txt",
    import.meta.url,
  ),
);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(
  /\/$/,
  "",
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const GATE_SNIPPET =
  "node scripts/check/seat-config-inject.mjs --role $Role --worktree $Worktree";
const TERRA_SNIPPET =
  '$codexModel = if ($Role -eq "PM") { "gpt-5.6-sol" } else { "gpt-5.6-terra" }';
const XHIGH_VAR_SNIPPET =
  '$codexReasoningEffort = if ($Role -eq "PM") { "high" } else { "xhigh" }';
const CODEX_FLAG_SNIPPET =
  "codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false -c reasoning_effort=$codexReasoningEffort";

test("claim: applied fixture calls seat-config-inject.mjs with --role/--worktree", () => {
  assert.equal(loadApplied().includes(GATE_SNIPPET), true);
});
test("claim: applied fixture's non-PM model branch is gpt-5.6-terra (not luna)", () => {
  assert.equal(loadApplied().includes(TERRA_SNIPPET), true);
});
test("claim: applied fixture no longer contains the stale gpt-5.6-luna literal", () => {
  assert.equal(loadApplied().includes("gpt-5.6-luna"), false);
});
test("claim: applied fixture defines reasoning effort xhigh for REVIEW / high for PM", () => {
  assert.equal(loadApplied().includes(XHIGH_VAR_SNIPPET), true);
});
test("claim: applied fixture's codex launch line carries -c reasoning_effort=$codexReasoningEffort", () => {
  assert.equal(loadApplied().includes(CODEX_FLAG_SNIPPET), true);
});

test("★anti-vacuity (양방향): deleting the gate promise flips RED, the untouched original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(GATE_SNIPPET, "");
  assert.equal(mutatedRed.includes(GATE_SNIPPET), false);
  assert.equal(original.includes(GATE_SNIPPET), true);
});
test("★anti-vacuity (양방향): reverting terra back to luna flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace('"gpt-5.6-terra"', '"gpt-5.6-luna"');
  assert.equal(mutatedRed.includes(TERRA_SNIPPET), false);
  assert.equal(original.includes(TERRA_SNIPPET), true);
});

// ---------------------------------------------------------------------------
// ★근본: extract the gate line and run it via a REAL pwsh process against a
// REAL (but synthetic, temp-dir) seat-config-inject.mjs failure -- does the
// $LASTEXITCODE -ne 0 branch actually fire and exit non-zero, exactly the
// way the launcher's existing seat-preflight gate already does?
// ---------------------------------------------------------------------------

function findExe(name) {
  const isWin = process.platform === "win32";
  const probe = spawnSync(isWin ? "where" : "which", [name], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  const lines = probe.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!isWin) return lines[0] ?? null;
  return (
    lines.find((l) => l.toLowerCase().endsWith(".exe")) ?? lines[0] ?? null
  );
}

const PWSH_EXE = findExe("pwsh") ?? findExe("powershell");
const PWSH_SKIP_REASON =
  "SKIP_REASON: no `pwsh`/`powershell` executable found on PATH (expected on CI without PowerShell installed) -- coder-task.md §3 forbids a SILENT skip here, so this reason string is the loud marker; layer-1 string checks above still ran and still gate this file";

function extractGateLine(appliedText) {
  const line = appliedText
    .split(/\r?\n/)
    .find((l) => l.includes("seat-config-inject.mjs"));
  if (!line) {
    throw new Error(
      "extractGateLine: no seat-config-inject.mjs line found in applied fixture -- fixture drifted from what this test was written against",
    );
  }
  return line;
}

test("self-check: the extracted gate line is exactly the promised snippet", () => {
  assert.match(
    extractGateLine(loadApplied()),
    new RegExp(GATE_SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("★근본 행동: the gate line, run in real pwsh against a seat-config-inject.mjs call that FAILS (missing worker config), actually exits non-zero and never reaches the line after it", (t) => {
  if (!PWSH_EXE) {
    t.skip(PWSH_SKIP_REASON);
    return;
  }
  const worktree = mkdtempSync(join(tmpdir(), "hyk462-effect-fail-"));
  const configDir = mkdtempSync(join(tmpdir(), "hyk462-effect-fail-cfg-")); // no settings.json inside -> ensureSafetyKeys fails
  try {
    const gateLine = extractGateLine(loadApplied()).replace(
      "seat-config-inject.mjs --role $Role --worktree $Worktree",
      `seat-config-inject.mjs --role CODER --worktree "${worktree}" --config-dir "${configDir}"`,
    );
    const script = [
      `$Role = "CODER"`,
      `Set-Location "${REPO_ROOT}"`,
      gateLine,
      `Write-Host "UNREACHABLE_MARKER"`,
    ].join("\n");
    const result = spawnSync(PWSH_EXE, ["-NoProfile", "-Command", script], {
      encoding: "utf8",
    });
    assert.notEqual(
      result.status,
      0,
      `expected non-zero exit; got ${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`,
    );
    assert.equal(
      result.stdout.includes("UNREACHABLE_MARKER"),
      false,
      "fail-closed gate must exit BEFORE the next line runs",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("★근본 행동: the same gate line, run against a seat-config-inject.mjs call that SUCCEEDS, exits zero and reaches the line after it (proves the block above is not vacuous -- not every exit code blocks)", (t) => {
  if (!PWSH_EXE) {
    t.skip(PWSH_SKIP_REASON);
    return;
  }
  const worktree = mkdtempSync(join(tmpdir(), "hyk462-effect-pass-"));
  const configDir = mkdtempSync(join(tmpdir(), "hyk462-effect-pass-cfg-"));
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({}), "utf8");
  try {
    const gateLine = extractGateLine(loadApplied()).replace(
      "seat-config-inject.mjs --role $Role --worktree $Worktree",
      `seat-config-inject.mjs --role CODER --worktree "${worktree}" --config-dir "${configDir}"`,
    );
    const script = [
      `$Role = "CODER"`,
      `Set-Location "${REPO_ROOT}"`,
      gateLine,
      `Write-Host "REACHED_MARKER"`,
    ].join("\n");
    const result = spawnSync(PWSH_EXE, ["-NoProfile", "-Command", script], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `expected exit 0; got ${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`,
    );
    assert.equal(
      result.stdout.includes("REACHED_MARKER"),
      true,
      "successful injection must let the launcher continue past the gate",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});
