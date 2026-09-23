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

// ---- ★HYK-280 후속: exit 5(OBSERVATION_UNAVAILABLE) 등재 promise 문자열 ----
// 이 상수들 각각도 exit4 축과 같은 함정을 조심한다: applied fixture에는
// 관제실의 UNRELATED, 기존 "exit 5"가 이미 있다(모호한 좌석 선택 실패
// 경로, applied fixture 137행) -- 그래서 아래 EXIT5_SNIPPET은 그 줄
// 하나만 정확히 가리키는 여러 줄 조합이다(naive `includes("exit 5")`였다면
// 엉뚱한 자리를 지우고도 계속 초록으로 남았을 것).
const OBS_UNAVAILABLE_FLAG_INIT_SNIPPET =
  "$confirmObservationUnavailable = $false";
const OBS_UNAVAILABLE_EQ5_BRANCH_SNIPPET = "if ($confirmExit -eq 5) {";
const OBS_UNAVAILABLE_DIAGNOSTIC_LINE_SNIPPET =
  "(0=STARTED, 1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START, 4=INVALID_ARGS, 5=OBSERVATION_UNAVAILABLE)";
const EXIT5_SNIPPET =
  'Write-Host "[4/4] 이 스크립트는 5 로 끝난다(0=정상 진행 · 5=착수확인 관측 불가)."\n  exit 5';
const OBS_UNAVAILABLE_SCOPE_HONESTY_SNIPPET =
  "배달 자체는 이미 이뤄졌다(dispatch 완료) -- 재배달이 아니라 좌석 화면을 직접 확인하라.";
const OBS_UNAVAILABLE_NOT_REDISPATCH_SNIPPET =
  "재배달이 아니라 좌석 화면을 직접 확인하라";

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
function hasObsUnavailableFlagInitPromise(text) {
  return text.includes(OBS_UNAVAILABLE_FLAG_INIT_SNIPPET);
}
function hasObsUnavailableEq5BranchPromise(text) {
  return text.includes(OBS_UNAVAILABLE_EQ5_BRANCH_SNIPPET);
}
function hasObsUnavailableDiagnosticLinePromise(text) {
  return text.includes(OBS_UNAVAILABLE_DIAGNOSTIC_LINE_SNIPPET);
}
function hasExit5Promise(text) {
  return text.includes(EXIT5_SNIPPET);
}
function hasObsUnavailableScopeHonestyPromise(text) {
  return text.includes(OBS_UNAVAILABLE_SCOPE_HONESTY_SNIPPET);
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

// ---- ★HYK-280 후속: exit 5(OBSERVATION_UNAVAILABLE) 등재 promise 검사 -----

test("claim(HYK-280): applied fixture promises a $confirmObservationUnavailable flag initialized false", () => {
  assert.equal(hasObsUnavailableFlagInitPromise(loadApplied()), true);
});
test("claim(HYK-280): applied fixture branches on confirmExit -eq 5 SEPARATELY from the unknown-code elseif (5 is a named, in-contract code -- not lumped with 4/99)", () => {
  assert.equal(hasObsUnavailableEq5BranchPromise(loadApplied()), true);
});
test("claim(HYK-280): the human-readable diagnostic line now names both 4=INVALID_ARGS and 5=OBSERVATION_UNAVAILABLE (coder-task.md §1-2/§1-4 -- the line used to drop both)", () => {
  assert.equal(hasObsUnavailableDiagnosticLinePromise(loadApplied()), true);
});
test("claim(HYK-280): applied fixture actually contains a dedicated `exit 5` statement (distinct from the unrelated pre-existing ambiguous-seat `exit 5` elsewhere in the file)", () => {
  assert.equal(hasExit5Promise(loadApplied()), true);
});
test("claim(HYK-280): applied fixture tells the human this is NOT a redispatch signal for exit 5 -- '재배달이 아니라 좌석 화면을 직접 확인하라' (coder-task.md §1-2 requirement)", () => {
  assert.equal(hasObsUnavailableScopeHonestyPromise(loadApplied()), true);
  assert.equal(
    loadApplied().includes(OBS_UNAVAILABLE_NOT_REDISPATCH_SNIPPET),
    true,
  );
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

// ---- ★HYK-280 후속: exit 5 promise들의 anti-vacuity(양방향) ---------------

test("★anti-vacuity (양방향, HYK-280): deleting the $confirmObservationUnavailable flag-init promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(OBS_UNAVAILABLE_FLAG_INIT_SNIPPET, "");
  assert.equal(hasObsUnavailableFlagInitPromise(mutatedRed), false);
  assert.equal(hasObsUnavailableFlagInitPromise(original), true);
});

test("★anti-vacuity (양방향, HYK-280): deleting the `-eq 5` branch promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(OBS_UNAVAILABLE_EQ5_BRANCH_SNIPPET, "");
  assert.equal(hasObsUnavailableEq5BranchPromise(mutatedRed), false);
  assert.equal(hasObsUnavailableEq5BranchPromise(original), true);
});

test("★anti-vacuity (양방향, HYK-280): deleting the updated diagnostic-line promise (4·5 additions) flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(
    OBS_UNAVAILABLE_DIAGNOSTIC_LINE_SNIPPET,
    "",
  );
  assert.equal(hasObsUnavailableDiagnosticLinePromise(mutatedRed), false);
  assert.equal(hasObsUnavailableDiagnosticLinePromise(original), true);
});

test("★anti-vacuity (양방향, HYK-280): deleting the ONLY dedicated `exit 5` statement flips RED, original stays GREEN (does not touch the unrelated pre-existing ambiguous-seat exit 5)", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(EXIT5_SNIPPET, "# (removed)");
  assert.equal(hasExit5Promise(mutatedRed), false);
  assert.equal(hasExit5Promise(original), true);
  // ★the unrelated exit 5 (ambiguous seat selection) must survive untouched.
  assert.equal(
    (mutatedRed.match(/exit 5/g) || []).length,
    1,
    "only the dedicated OBSERVATION_UNAVAILABLE exit 5 should have been removed -- the unrelated ambiguous-seat exit 5 must remain",
  );
});

test("★anti-vacuity (양방향, HYK-280): deleting the not-a-redispatch sentence flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(
    OBS_UNAVAILABLE_SCOPE_HONESTY_SNIPPET,
    "",
  );
  assert.equal(hasObsUnavailableScopeHonestyPromise(mutatedRed), false);
  assert.equal(hasObsUnavailableScopeHonestyPromise(original), true);
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
// ★HYK-280 후속(coder-task.md §2 항1) -- 5(OBSERVATION_UNAVAILABLE)는 기존
// 두 축 어디에도 안 들어간다: "계약 밖 미지 코드"(4·99, exit 4)와도 다르고
// "성공"(0-3, exit 0)과도 다르다 -- 이름 있는 코드이지만 "성공"은 아니므로
// 세 번째 축을 새로 만든다(불변식 P′). exit 코드 자체도 4가 아니라 5로
// 갈라, 사람이 종료코드만 보고도 "이건 관측 불가지 인자 오류가 아니다"를
// 구별할 수 있게 한다.
const observationUnavailableStaysNamedAtExit5 = [5];

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

for (const exitCode of observationUnavailableStaysNamedAtExit5) {
  test(`★근본 행동(HYK-280): real applied-fixture tail with confirmExit=${exitCode} (OBSERVATION_UNAVAILABLE -- in-contract but NOT success) -- harness reaches exit 5, NOT exit 0 and NOT exit 4; PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      5,
      `expected exit 5 for confirmExit=${exitCode} (OBSERVATION_UNAVAILABLE), got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

// ★HYK-280 후속(불변식 3 "계약을 넓히지 마라") -- 5 이외의 미지 코드(예: 6)는
// 여전히 fail-closed(exit 4)로 남아야 한다. 이 테스트가 없으면 "5를 등재"가
// 실은 "그 밖의 미지 코드도 통과"로 몰래 넓혀졌는지 구별할 수 없다.
test("★근본 행동(HYK-280, 불변식 3 -- 계약을 넓히지 않는다): confirmExit=6(5도 아니고 기존 4/99도 아닌 새 미지 코드)은 여전히 exit 4로 fail-closed; PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const result = runSyntheticTarget(6, PS_EXE);
  assert.equal(
    result.status,
    4,
    `unknown code 6 must stay fail-closed at exit 4 (not silently pass, not confused with 5), got status=${result.status} stderr=${result.stderr}`,
  );
});

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

// ★HYK-280 후속(coder-task.md §2 항3 ⓐ) -- "5를 다시 계약 밖으로 되돌리면"
// 정확한 사유(계약 밖 미지 코드로 뭉개짐)와 함께 빨개지는가. 여기서는
// HYK-378까지만 적용됐던(HYK-280 이전) tail -- 즉 5를 "그 밖의 미지 코드"
// elseif 하나로만 처리하던 옛 문면 -- 을 그대로 재현해, confirmExit=5가
// exit 5가 아니라 exit 4(계약 밖 취급)로 떨어지는지 확인한다. 이것이
// 되돌아가면(=이 라운드가 없었다면) 사람은 "관측 불가"를 "인자 계약
// 위반"으로 오독하게 된다 -- 그 회귀를 이 시험이 잡는다.
test("★되돌림 변이(행동 축, HYK-280 ⓐ): 5를 다시 '계약 밖 미지 코드' elseif 하나로 되돌리면 confirmExit=5가 exit 5가 아니라 exit 4로 떨어진다(RED for the invariant, proving the exit-5 GREEN result above is not vacuous); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  // HYK-378까지의 tail(HYK-280 이전) -- $confirmObservationUnavailable도
  // -eq 5 분기도 없다. 5는 그저 "0,1,2,3에 없는 코드"로만 취급된다.
  const hyk378OnlyTail = [
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
  ].join("\n");

  const dir = mkdtempSync(
    join(tmpdir(), "hyk378-exit4-behavior-revert-hyk280-"),
  );
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(hyk378OnlyTail, 5), "utf8");
    const result = spawnSync(
      PS_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      4,
      `pre-HYK-280 text must let confirmExit=5 fall into the generic contract-violation branch (exit 4), NOT the named exit 5 this round adds -- got status=${result.status}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
