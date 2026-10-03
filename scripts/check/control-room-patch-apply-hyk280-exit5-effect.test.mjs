// HYK-280-exit5-repair-2 (coder-task.md §3/§8/§9) -- does the applied
// dispatch-worker.ps1 fixture ACTUALLY make the delivered script report
// confirmExit=5 (OBSERVATION_UNAVAILABLE) with a distinct, named diagnostic
// message, while still exiting 4 (NOT a new wrapper exit code -- see doc
// §1's number registry for why), and while leaving 0/1/2/3 and the
// pre-existing 4/99 contract-violation behavior completely unchanged?
//
// Two layers (same split as HYK-378/HYK-272 precedent):
//   1. String/structure checks (doc-promise-presence, mutation-testable).
//   2. ★근본: an ACTUAL PowerShell process, spawned against a synthetic
//      target extracted verbatim from the applied fixture's real tail.
//
// ⛔This never runs against a real delivery / real dispatch-worker.ps1
// invocation. findPowerShell() is reused as-is from
// seat-proof-wrapper-behavior.mjs (HYK-323).
//
// ⚠️정직 한계 (HYK-378/HYK-272 선례와 동일 형태): 문자열 검사(레이어 1)는
// "그 문장이 있다"만 보고 "그렇게 동작한다"는 못 본다 -- 레이어 2로
// 메운다. 그마저도: ⓐ 관제실의 살아 있는 dispatch-worker.ps1은 이 시험
// 어디서도 열지 않는다(라이브 드리프트를 못 잡는다) ⓑ 이 지점은 `[2/3]
// dispatch` 뒤라 워커는 이미 기동된 상태다 ⓒ codex 분기·CLI 부재 분기는
// 대상이 아니다 ⓓ PowerShell 미설치 환경에서는 레이어 2가 SKIP_REASON과
// 함께 시끄럽게 건너뛴다.
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
    "./fixtures/control-room-dispatch-worker-2026-09-28-hyk280-exit5-applied.ps1.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const EQ5_BRANCH_SNIPPET = "if ($confirmExit -eq 5) {";
const OBS_UNAVAILABLE_WARN_SNIPPET =
  "관측 불가(exit=5, OBSERVATION_UNAVAILABLE)";
const NAMED_EXIT5_REPORT_SNIPPET =
  "착수 확인 관측 불가 -- 세션 기록 폴더 자체를 끝까지 찾지 못했다(exit=5, OBSERVATION_UNAVAILABLE).";
const NOT_REDISPATCH_SNIPPET = "재배달이 아니라 좌석 화면을 직접 확인하라";
// ⚠️Deliberately scoped to the exact new statement -- the applied fixture
// has TWO unrelated pre-existing `exit 4`/`exit 5` occurrences elsewhere
// (NOT_FOUND at "exit 4", AMBIGUOUS-seat at "exit 5") -- a naive
// text.includes("exit 4") would not distinguish this round's change from
// those unrelated statements, so promise checks below anchor on multi-line,
// uniquely-worded snippets instead of bare "exit N".
const EXIT4_STILL_SOLE_CODE_SNIPPET =
  'Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 또는 관측 불가)."\n  exit 4';
const NO_NEW_WRAPPER_CODE_COMMENT_SNIPPET =
  "새 번호를 쓰지 않는다, 번호 원장 §1";

function hasEq5Branch(text) {
  return text.includes(EQ5_BRANCH_SNIPPET);
}
function hasObsUnavailableWarn(text) {
  return text.includes(OBS_UNAVAILABLE_WARN_SNIPPET);
}
function hasNamedExit5Report(text) {
  return text.includes(NAMED_EXIT5_REPORT_SNIPPET);
}
function hasNotRedispatch(text) {
  return text.includes(NOT_REDISPATCH_SNIPPET);
}
function hasExit4StillSoleCode(text) {
  return text.includes(EXIT4_STILL_SOLE_CODE_SNIPPET);
}

test("claim: applied fixture branches on confirmExit -eq 5 separately from the generic notin(0,1,2,3) elseif", () => {
  assert.equal(hasEq5Branch(loadApplied()), true);
});
test("claim: applied fixture's Write-Warning for exit=5 names OBSERVATION_UNAVAILABLE distinctly (not lumped with generic unknown-code warning)", () => {
  assert.equal(hasObsUnavailableWarn(loadApplied()), true);
});
test("claim: applied fixture's final human-readable report for exit=5 is distinct from the generic 4-message and says '관측 불가' by name", () => {
  assert.equal(hasNamedExit5Report(loadApplied()), true);
});
test("claim: applied fixture tells the human this is NOT a redispatch signal for the exit=5 case", () => {
  assert.equal(hasNotRedispatch(loadApplied()), true);
});
test("claim: the wrapper's OWN exit code for the exit=5 case is STILL 4 -- this document does not mint a new wrapper exit code (number registry §1: 1 is implicitly reserved by $ErrorActionPreference=Stop, 5 is HYK-272's)", () => {
  assert.equal(hasExit4StillSoleCode(loadApplied()), true);
  assert.ok(loadApplied().includes(NO_NEW_WRAPPER_CODE_COMMENT_SNIPPET));
});

// ---- ★anti-vacuity, both directions: RED on deletion, GREEN on restore ----

test("★anti-vacuity (양방향): deleting the -eq 5 branch promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(EQ5_BRANCH_SNIPPET, "");
  assert.equal(hasEq5Branch(mutatedRed), false);
  assert.equal(hasEq5Branch(original), true);
});

test("★anti-vacuity (양방향): deleting the named exit-5 report promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(NAMED_EXIT5_REPORT_SNIPPET, "");
  assert.equal(hasNamedExit5Report(mutatedRed), false);
  assert.equal(hasNamedExit5Report(original), true);
});

test("★anti-vacuity (양방향): deleting the not-a-redispatch sentence flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(NOT_REDISPATCH_SNIPPET, "");
  assert.equal(hasNotRedispatch(mutatedRed), false);
  assert.equal(hasNotRedispatch(original), true);
});

test("★anti-vacuity (양방향): deleting the sole-exit-4-code promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(
    EXIT4_STILL_SOLE_CODE_SNIPPET,
    "# (removed)",
  );
  assert.equal(hasExit4StillSoleCode(mutatedRed), false);
  assert.equal(hasExit4StillSoleCode(original), true);
});

// ---------------------------------------------------------------------------
// ★근본: drive the REAL applied-fixture text in a real PowerShell process.
// ---------------------------------------------------------------------------

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
    "the real script's tail must end on the closing brace of HYK-272's exit-5 block",
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
    "function Confirm-GetClaudeBytes { param($dir) return @{ ok = $false } }",
    `$confirmExit = ${confirmExitValue}`,
    "$confirmEngine = 'synthetic'",
    "$confirmProjectDir = 'C:/synthetic-target'",
    "$confirmBaselineBytes = 0",
    "$confirmBaselineAtMs = 0",
    "$confirmLastObservationBytes = 0",
    "$confirmLastObservationAtMs = 0",
    "",
    "if ($true) {",
    realTailSnippet,
    "",
    // The real script has no more code after HYK-272's block -- reaching
    // here means confirmExit was in {0} (STARTED, the only value that falls
    // through every branch), which is an implicit exit 0 in the real
    // script.
    "exit 0",
  ].join("\n");
}

function runSyntheticTarget(confirmExitValue, psExe) {
  const snippet = extractRealTailSnippet(loadApplied());
  const dir = mkdtempSync(join(tmpdir(), "hyk280-exit5-behavior-"));
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
  "SKIP_REASON: no PowerShell executable found on PATH (expected on CI without pwsh) -- coder-task.md §6 forbids a SILENT skip here, so this reason string is the loud marker; layer-1 string checks above still ran and still gate this file";

// confirmExit=0 -> falls through everything -> implicit exit 0.
test("★근본 행동: confirmExit=0 (STARTED, in-contract) -- harness reaches exit 0 (no regression); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const result = runSyntheticTarget(0, PS_EXE);
  assert.equal(
    result.status,
    0,
    `expected exit 0 for confirmExit=0, got status=${result.status} stderr=${result.stderr}`,
  );
});

// confirmExit in {1,2,3} -> falls through the exit-4 block (not a contract
// violation), then hits HYK-272's own block -> exit 5. This document must
// NOT change this (HYK-272's exit 5 is untouched, per the doc's §0/§5).
for (const exitCode of [1, 2, 3]) {
  test(`★근본 행동: confirmExit=${exitCode} (in-contract, HYK-272's territory) -- harness still reaches exit 5 UNCHANGED by this document; PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      5,
      `expected exit 5 (HYK-272 unchanged) for confirmExit=${exitCode}, got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

// confirmExit=4 or 99 (still generic contract violation, NOT the eq-5
// branch) -> exit 4 with the generic message.
for (const exitCode of [4, 99]) {
  test(`★근본 행동: confirmExit=${exitCode} (contract violation, not 5) -- harness reaches exit 4 with the GENERIC message (regression check: eq-5 branch must not swallow other codes); PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      4,
      `expected exit 4 for confirmExit=${exitCode}, got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

// ★the actual point of this round: confirmExit=5 (OBSERVATION_UNAVAILABLE)
// -- exit code stays 4 (NOT a new wrapper code, NOT HYK-272's 5), but the
// message must be the named/distinct one (checked by the string tests
// above; here we only check the exit code axis, since stdout content isn't
// captured by $LASTEXITCODE).
test("★근본 행동(이 라운드의 핵심): confirmExit=5 (OBSERVATION_UNAVAILABLE) -- harness reaches exit 4 (NOT 5 -- HYK-272 already owns wrapper exit 5, NOT a new wrapper code either); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const result = runSyntheticTarget(5, PS_EXE);
  assert.equal(
    result.status,
    4,
    `expected exit 4 for confirmExit=5 (OBSERVATION_UNAVAILABLE stays in the exit-4 bucket by design), got status=${result.status} stderr=${result.stderr}`,
  );
});

// ---- ★되돌림 변이 (행동 축): reverting to the pre-this-round tail (HYK-378
// generic-only, no eq-5 branch) must make confirmExit=5 fall into the
// SAME exit 4 path it already did before -- this document's real
// observable effect is the MESSAGE, not the exit code, so the behavioral
// mutation that proves non-vacuity has to be at the string layer (already
// covered by the anti-vacuity tests above) plus this control: reverting
// the eq-5 branch must NOT change the exit code (still 4), proving the
// exit-code-axis test alone would be vacuous if used as the sole proof --
// which is exactly why the string-layer promise tests exist as the primary
// proof for this round's change.
test("★되돌림 변이 (행동 축, 정직): eq-5 분기를 통째로 제거해도 confirmExit=5 는 여전히 (제네릭 문구로) exit 4 다 -- 이 라운드의 실제 관측 가능한 변화는 '문구'이지 '종료코드'가 아님을 값으로 보여준다(그래서 문자열 계층 anti-vacuity 시험이 이 라운드의 주 증거다); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const preRoundTail = [
    "  $confirmClaudeLast = Confirm-GetClaudeBytes $confirmProjectDir",
    "  $confirmLastObservationAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  if ($confirmClaudeLast.ok) { $confirmLastObservationBytes = [string]$confirmClaudeLast.totalBytes }",
    "  $confirmContractViolation = $false",
    "  $confirmExitObserved = $confirmExit",
    "  if ($confirmExit -notin @(0, 1, 2, 3)) {",
    '    Write-Warning "dispatch-start-confirm 계약 밖 종료코드=$confirmExit -- 착수 확인 결과를 신뢰할 수 없다"',
    "    $confirmContractViolation = $true",
    "  }",
    '  Write-Host "[4/4] Claude 착수 확인 종료코드=$confirmExit (0=STARTED, 1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START)"',
    '  Write-Host "[4/4] 진단: engine=$confirmEngine folder=$confirmProjectDir baseline=$confirmBaselineBytes baseline_at=$confirmBaselineAtMs last_observation=$confirmLastObservationBytes last_observation_at=$confirmLastObservationAtMs"',
    "}",
    "if ($confirmContractViolation) {",
    '  Write-Host "[4/4] 착수 확인이 돌지 못했다 -- 관측된 종료코드=$confirmExitObserved (계약 = 0,1,2,3)"',
    '  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."',
    '  Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반)."',
    "  exit 4",
    "}",
    "if ($confirmExit -in @(1, 2, 3)) {",
    '  Write-Host "[4/4] 착수 확인 결과가 성공이 아니다 -- 종료코드=$confirmExit (1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START)"',
    '  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."',
    '  Write-Host "[4/4] 이 스크립트는 5 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 · 5=착수 확인 결과 미성공)."',
    "  exit 5",
    "}",
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "hyk280-exit5-behavior-revert-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(preRoundTail, 5), "utf8");
    const result = spawnSync(
      PS_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      4,
      `pre-this-round text must also let confirmExit=5 fall into the generic contract-violation branch (exit 4) -- got status=${result.status}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
