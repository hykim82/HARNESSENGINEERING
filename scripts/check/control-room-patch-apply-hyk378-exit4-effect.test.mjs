// HYK-378-ps1-exit4-1 (coder-task.md §3-3/§3-C) -- does the applied
// dispatch-worker.ps1 fixture ACTUALLY make the delivered script report a
// contract-violating dispatch-start-confirm-cli.mjs exit code (4 =
// INVALID_ARGS, and any other code outside {0,1,2,3}) as a non-zero exit,
// instead of the pre-patch behavior of printing one Write-Warning line and
// finishing with an implicit exit 0?
//
// Two layers, deliberately kept separate (coder-task.md §2's own honesty
// requirement and the HYK-330/HYK-357-352 precedent's split):
//   1. String/structure checks (doc-promise-presence, mutation-testable) --
//      "does the applied fixture's TEXT promise fail-closed handling of
//      contract-violating exit codes". Cheap, but only proves the words are
//      there, not that PowerShell actually executes that way.
//   2. ★근본: an ACTUAL PowerShell process, spawned against a synthetic
//      target extracted verbatim from the applied fixture (never a hand-
//      reimplemented stand-in) -- this is the "행동 축" coder-task.md §3
//      asks for. It answers "does running this code really exit 4 on a
//      contract violation and really leave 0/1/2/3 alone", which layer 1
//      cannot answer by construction.
//
// ⛔This never runs against a real delivery / real dispatch-worker.ps1
// invocation (coder-task.md §3 forbids that) -- the harness below defines
// its own minimal stand-ins for the two free variables the extracted
// snippet references (Confirm-GetClaudeBytes, $confirmProjectDir) and
// drives ONLY the tail of the applied fixture (from the unique
// `$confirmClaudeLast = Confirm-GetClaudeBytes $confirmProjectDir` line
// through end-of-file, which is exactly the real script's tail -- verified
// unique below).
//
// findPowerShell() is reused as-is from seat-proof-wrapper-behavior.mjs
// (HYK-323) rather than reimplemented -- same PATH-probing contract, same
// "PowerShell not found" shape.
//
// ⚠️정직 한계 (HYK-357-352/HYK-335 선례와 동일 형태 + coder-task.md §3 추가
// 요구): 문자열 검사(레이어 1)는 "그 문장이 있다"만 보고 "그렇게
// 동작한다"는 못 본다 -- 그 한계를 메우려고 레이어 2(행동 검사)를 넣었지만,
// 그마저도 다음은 못 본다: ⓐ 관제실의 살아 있는 dispatch-worker.ps1은 이
// 시험 어디서도 열지 않는다(라이브 드리프트를 못 잡는다, sha256 드리프트
// 감시가 별도로 맡는다) ⓑ 이 지점은 `[2/3] dispatch` **뒤**라 워커는 이미
// 기동된 상태다 -- 이 패치도 이 시험도 막는 것은 "배달"이 아니라 "배달이
// 성공했다는 보고"뿐이다(패치 문서 §5) ⓒ codex 분기·CLI 부재 분기는 이
// 조각의 대상이 아니며 이 시험도 그 두 분기를 구동하지 않는다(그 두 분기는
// 자체적으로 exit 코드를 2로 강제하므로 "미지의 코드"가 나올 수 없다) ⓓ
// PowerShell 이 설치돼 있지 않은 환경(CI 등)에서는 레이어 2 전체가
// SKIP_REASON 표지와 함께 **시끄럽게** 건너뛴다 -- 조용한 스킵은 없다(HYK-
// 365 형태 방지), 그러나 그 환경에서는 결국 레이어 1(문자열 검사)만 남는다.
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
    "./fixtures/control-room-dispatch-worker-2026-08-28-hyk378-exit4-applied.ps1.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const CONTRACT_FLAG_INIT_SNIPPET = "$confirmContractViolation = $false";
const UNKNOWN_CODE_FAIL_CLOSED_SNIPPET = "그 밖의 미지 코드도 같은 취급";
// ⚠️Deliberately scoped to the exact new statement, not the bare substring
// "exit 4" -- dispatch-worker.ps1 already has an UNRELATED, pre-existing
// "exit 4" elsewhere (NOT_FOUND: no live seat attached to the worktree,
// line 110 of the applied fixture). A naive `text.includes("exit 4")`
// mutation test would mutate/delete the WRONG occurrence and stay
// vacuously green -- caught by the collect test's own revert-mutation
// failing during this round's own verification (see .harness/coder.md).
const EXIT4_SNIPPET =
  'Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반)."\n  exit 4';
const SCOPE_HONESTY_SNIPPET =
  "배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라.";
const SUCCESS_NOT_REPORTED_SNIPPET = "이 실행을 성공으로 취급하지 마라";

function hasContractFlagPromise(text) {
  return text.includes(CONTRACT_FLAG_INIT_SNIPPET);
}
function hasUnknownCodeFailClosedPromise(text) {
  return text.includes(UNKNOWN_CODE_FAIL_CLOSED_SNIPPET);
}
function hasExit4Promise(text) {
  return text.includes(EXIT4_SNIPPET);
}
function hasScopeHonestyPromise(text) {
  return text.includes(SCOPE_HONESTY_SNIPPET);
}

test("claim: applied fixture promises a $confirmContractViolation flag initialized false", () => {
  assert.equal(hasContractFlagPromise(loadApplied()), true);
});
test("claim: applied fixture promises unknown/未知 exit codes get the SAME fail-closed treatment as 4, not just 4 itself", () => {
  assert.equal(hasUnknownCodeFailClosedPromise(loadApplied()), true);
});
test("claim: applied fixture actually contains an `exit 4` statement", () => {
  assert.equal(hasExit4Promise(loadApplied()), true);
});
test("claim: applied fixture is honest that this point is AFTER dispatch -- it does not claim to block delivery, only the false-success report", () => {
  assert.equal(hasScopeHonestyPromise(loadApplied()), true);
  assert.equal(loadApplied().includes(SUCCESS_NOT_REPORTED_SNIPPET), true);
});

// ---- ★anti-vacuity, both directions: RED on deletion, GREEN on restore ----

test("★anti-vacuity (양방향): deleting the contract-flag-init promise flips RED, the untouched original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(CONTRACT_FLAG_INIT_SNIPPET, "");
  assert.equal(hasContractFlagPromise(mutatedRed), false);
  assert.equal(hasContractFlagPromise(original), true);
});

test("★anti-vacuity (양방향): deleting the unknown-code-fail-closed promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(UNKNOWN_CODE_FAIL_CLOSED_SNIPPET, "");
  assert.equal(hasUnknownCodeFailClosedPromise(mutatedRed), false);
  assert.equal(hasUnknownCodeFailClosedPromise(original), true);
});

test("★anti-vacuity (양방향): deleting the ONLY `exit 4` statement flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(EXIT4_SNIPPET, "# (removed)");
  assert.equal(hasExit4Promise(mutatedRed), false);
  assert.equal(hasExit4Promise(original), true);
});

test("★anti-vacuity (양방향): deleting the scope-honesty sentence flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(SCOPE_HONESTY_SNIPPET, "");
  assert.equal(hasScopeHonestyPromise(mutatedRed), false);
  assert.equal(hasScopeHonestyPromise(original), true);
});

// ---------------------------------------------------------------------------
// ★근본: drive the REAL applied-fixture text (never a reimplementation) in a
// real PowerShell process, with a synthetic target standing in for the two
// free variables the tail references. This answers what coder-task.md §3
// says string-presence alone cannot: does this code, when it actually runs,
// exit 4 on a contract violation and leave 0/1/2/3 unaffected?
// ---------------------------------------------------------------------------

// The real script's tail begins at this line (verified unique below) and
// runs to end-of-file -- this IS the real production text, sliced, not a
// rewritten stand-in.
const EXTRACT_MARKER =
  "$confirmClaudeLast = Confirm-GetClaudeBytes $confirmProjectDir";

function extractRealTailSnippet(appliedText) {
  const first = appliedText.indexOf(EXTRACT_MARKER);
  if (first === -1) {
    throw new Error(
      "extractRealTailSnippet: marker not found in applied fixture -- fixture drifted from what this test was written against",
    );
  }
  const second = appliedText.indexOf(EXTRACT_MARKER, first + 1);
  if (second !== -1) {
    throw new Error(
      "extractRealTailSnippet: marker is not unique in applied fixture -- cannot slice unambiguously",
    );
  }
  return appliedText.slice(first);
}

test("self-check: the extraction marker is unique in the applied fixture and slicing from it reaches exactly end-of-file (before trusting the behavioral tests below)", () => {
  const applied = loadApplied();
  const snippet = extractRealTailSnippet(applied);
  assert.ok(snippet.startsWith(EXTRACT_MARKER));
  assert.ok(
    snippet.trimEnd().endsWith("}"),
    "the real script's tail must end on the closing brace of the new if ($confirmContractViolation) block",
  );
  assert.equal(
    applied.indexOf(snippet),
    applied.length - snippet.length,
    "the extracted snippet must be exactly the applied fixture's suffix (no trailing content after it)",
  );
});

function buildHarness(realTailSnippet, confirmExitValue) {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Stand-in for the one function the real tail calls -- signature-only,
    // matches dispatch-worker.ps1's real Confirm-GetClaudeBytes shape
    // (returns an object with an .ok field). `ok = $false` means the
    // observation branch (`if ($confirmClaudeLast.ok) { ... }`) is skipped,
    // exactly like a synthetic target with no growth observed.
    "function Confirm-GetClaudeBytes { param($dir) return @{ ok = $false } }",
    `$confirmExit = ${confirmExitValue}`,
    "$confirmEngine = 'synthetic'",
    "$confirmProjectDir = 'C:/synthetic-target'",
    "$confirmBaselineBytes = 0",
    "$confirmBaselineAtMs = 0",
    "$confirmLastObservationBytes = 0",
    "$confirmLastObservationAtMs = 0",
    "",
    // The real script's tail starts INSIDE the `else { ... }` branch's body
    // (the branch that actually runs the Claude confirm CLI) -- extraction
    // starts after that opening brace, so the extracted text's own trailing
    // "}" (which closes that else-branch in the real file) would otherwise
    // be unmatched. This restores exactly that one opening brace and
    // nothing else -- the body and its closing brace are still the
    // unmodified real production text. ⚠️A bare `{ ... }` in PowerShell is
    // a SCRIPT BLOCK LITERAL, not an executed block -- it must be wrapped
    // in `if ($true) { ... }` (or invoked with `&`) or the interior never
    // runs at all (caught in review: an earlier draft of this harness used
    // a bare `{`, which made $confirmContractViolation silently stay
    // undefined for every confirmExit value -- a false-negative "no
    // regression" that a naive reading of stdout would not have revealed).
    "if ($true) {",
    realTailSnippet,
    "",
    // The real script has no more code after this point -- reaching here
    // means the contract was NOT violated, which is an implicit exit 0 in
    // the real script. Made explicit here so the harness's own exit code is
    // unambiguous proof of "fell through" vs. "exited from inside the
    // snippet".
    "exit 0",
  ].join("\n");
}

function runSyntheticTarget(confirmExitValue, psExe) {
  const snippet = extractRealTailSnippet(loadApplied());
  const dir = mkdtempSync(join(tmpdir(), "hyk378-exit4-behavior-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(snippet, confirmExitValue), "utf8");
    const result = spawnSync(
      psExe,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PS_EXE = findPowerShell();
const NO_PS_SKIP_REASON =
  "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh) -- coder-task.md §3 forbids a SILENT skip here, so this reason string is the loud marker; layer-1 string checks above still ran and still gate this file";

const contractViolationRedirectsToExit4 = [4, 99];
const contractCompliantCodesStayAtExit0 = [0, 1, 2, 3];

for (const exitCode of contractCompliantCodesStayAtExit0) {
  test(`★근본 행동: real applied-fixture tail with confirmExit=${exitCode} (in-contract) -- harness reaches exit 0 (no regression on the 4 known codes); PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      0,
      `expected exit 0 for in-contract confirmExit=${exitCode}, got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

for (const exitCode of contractViolationRedirectsToExit4) {
  test(`★근본 행동: real applied-fixture tail with confirmExit=${exitCode} (contract violation, incl. an exit code that is NOT 4 to prove this isn't hardcoded to literal 4) -- harness reaches exit 4; PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      4,
      `expected exit 4 for contract-violating confirmExit=${exitCode}, got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

// ---- ★되돌림 변이 (행동 축): reverting the applied fixture's tail to the
// PRE-PATCH text (the before fixture's equivalent lines) must make exit 4
// unreachable -- confirmExit=4 then falls through the old
// "Write-Warning-only" path and reaches the harness's own `exit 0`. This is
// the behavioral mirror of the collect test's document-level revert
// mutation: proves the exit-4 test above is not vacuously true regardless
// of what the snippet contains.
test("★되돌림 변이 (행동 축): replacing the applied tail's fail-closed block with the OLD pre-patch Write-Warning-only text flips confirmExit=4 to exit 0 (RED for the invariant, proving the GREEN result above is not vacuous); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const oldPrePatchTail = [
    "  $confirmClaudeLast = Confirm-GetClaudeBytes $confirmProjectDir",
    "  $confirmLastObservationAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  if ($confirmClaudeLast.ok) { $confirmLastObservationBytes = [string]$confirmClaudeLast.totalBytes }",
    "  if ($confirmExit -notin @(0, 1, 2, 3)) {",
    '    Write-Warning "dispatch-start-confirm unexpected exit=$confirmExit; delivery continues"',
    "  }",
    '  Write-Host "[4/4] Claude 착수 확인 종료코드=$confirmExit (0=STARTED, 1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START)"',
    '  Write-Host "[4/4] 진단: engine=$confirmEngine folder=$confirmProjectDir baseline=$confirmBaselineBytes baseline_at=$confirmBaselineAtMs last_observation=$confirmLastObservationBytes last_observation_at=$confirmLastObservationAtMs"',
    "}",
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "hyk378-exit4-behavior-revert-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(oldPrePatchTail, 4), "utf8");
    const result = spawnSync(
      PS_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `pre-patch text must let confirmExit=4 fall through to exit 0 (that is exactly the bug this patch fixes) -- got status=${result.status}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
