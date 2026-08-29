// HYK-272-consume-notstarted-1 (coder-task.md §3-4/§3-C) -- does the applied
// dispatch-worker.ps1 fixture ACTUALLY make the delivered script report
// confirmExit in {1,2,3} (NOT_STARTED / COLLECTION_FAILED / STALLED_AFTER_
// START) as a non-zero exit, instead of the pre-patch behavior of falling
// through to an implicit exit 0? And does it leave confirmExit=0 (still
// exit 0) and the HYK-378 exit-4 contract-violation path (still exit 4)
// completely unaffected (no regression)?
//
// Two layers, deliberately kept separate (coder-task.md §2's own honesty
// requirement and the HYK-378/HYK-330/HYK-357-352 precedent's split):
//   1. String/structure checks (doc-promise-presence, mutation-testable) --
//      "does the applied fixture's TEXT promise fail-closed handling of
//      1/2/3". Cheap, but only proves the words are there, not that
//      PowerShell actually executes that way.
//   2. ★근본: an ACTUAL PowerShell process, spawned against a synthetic
//      target extracted verbatim from the applied fixture (never a hand-
//      reimplemented stand-in) -- this is the "행동 축" coder-task.md §3
//      asks for.
//
// ⛔This never runs against a real delivery / real dispatch-worker.ps1
// invocation (coder-task.md §3 forbids that) -- the harness below defines
// its own minimal stand-ins for the free variables the extracted snippet
// references (Confirm-GetClaudeBytes, $confirmProjectDir) and drives ONLY
// the tail of the applied fixture (from the unique
// `$confirmClaudeLast = Confirm-GetClaudeBytes $confirmProjectDir` line
// through end-of-file -- verified unique below, same extraction shape as
// HYK-378's effect test).
//
// findPowerShell() is reused as-is from seat-proof-wrapper-behavior.mjs
// (HYK-323), same as the HYK-378 precedent.
//
// ⚠️정직 한계 (HYK-378 선례와 동일 형태 + coder-task.md §3 추가 요구):
// 문자열 검사(레이어 1)는 "그 문장이 있다"만 보고 "그렇게 동작한다"는 못
// 본다 -- 그 한계를 메우려고 레이어 2(행동 검사)를 넣었지만, 그마저도
// 다음은 못 본다: ⓐ 관제실의 살아 있는 dispatch-worker.ps1은 이 시험
// 어디서도 열지 않는다(라이브 드리프트를 못 잡는다) ⓑ 이 지점은
// `[2/3] dispatch` **뒤**라 워커는 이미 기동된 상태다 -- 이 패치도 이
// 시험도 막는 것은 "배달"이 아니라 "배달이 성공했다는 보고"뿐이다(패치
// 문서 §5) ⓒ codex 분기·CLI 부재 분기 각각의 판정 로직 자체는 이 시험이
// 구동하지 않는다(coder-task.md §4가 범위 밖으로 못박았다) -- 이 시험은
// 세 분기가 이미 만들어낸 $confirmExit 값을 합류 지점에서 소비하는
// 코드만 구동한다 ⓓ PowerShell 이 설치돼 있지 않은 환경(CI 등)에서는
// 레이어 2 전체가 SKIP_REASON 표지와 함께 **시끄럽게** 건너뛴다 -- 조용한
// 스킵은 없다(HYK-365 형태 방지), 그러나 그 환경에서는 레이어 1만 남는다.
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
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-applied.ps1.txt",
    import.meta.url,
  ),
);
const BEFORE_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk272-notstarted-before.ps1.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}
function loadBefore() {
  return readFileSync(BEFORE_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const NOTSTARTED_BLOCK_SNIPPET = "if ($confirmExit -in @(1, 2, 3)) {";
const EXIT5_SNIPPET =
  'Write-Host "[4/4] 이 스크립트는 5 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 · 5=착수 확인 결과 미성공)."\n  exit 5';
const NO_AUTO_REDISPATCH_SNIPPET = "자동 재전달은 하지 않는다";
const SCOPE_HONESTY_SNIPPET =
  "배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라.";

function hasNotStartedBlockPromise(text) {
  return text.includes(NOTSTARTED_BLOCK_SNIPPET);
}
function hasExit5Promise(text) {
  return text.includes(EXIT5_SNIPPET);
}
function hasNoAutoRedispatchPromise(text) {
  return text.includes(NO_AUTO_REDISPATCH_SNIPPET);
}

test("claim: applied fixture promises a new block gating on confirmExit in {1,2,3}", () => {
  assert.equal(hasNotStartedBlockPromise(loadApplied()), true);
});
test("claim: applied fixture actually contains an `exit 5` statement with the promised diagnostic", () => {
  assert.equal(hasExit5Promise(loadApplied()), true);
});
test("claim: applied fixture documents the no-auto-redispatch invariant", () => {
  assert.equal(hasNoAutoRedispatchPromise(loadApplied()), true);
});
test("claim: applied fixture is honest that this point is AFTER dispatch (same scope-honesty sentence as HYK-378's block, now also present for the new block)", () => {
  const text = loadApplied();
  const occurrences = text.split(SCOPE_HONESTY_SNIPPET).length - 1;
  assert.equal(
    occurrences,
    2,
    "expected the scope-honesty sentence twice -- once in HYK-378's exit-4 block, once in this round's new exit-5 block",
  );
});

// ---- ★anti-vacuity, both directions: RED on deletion, GREEN on restore ----

test("★anti-vacuity (양방향): deleting the confirmExit-in-{1,2,3} guard flips RED, the untouched original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(NOTSTARTED_BLOCK_SNIPPET, "");
  assert.equal(hasNotStartedBlockPromise(mutatedRed), false);
  assert.equal(hasNotStartedBlockPromise(original), true);
});

test("★anti-vacuity (양방향): deleting the exit 5 statement flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(EXIT5_SNIPPET, "# (removed)");
  assert.equal(hasExit5Promise(mutatedRed), false);
  assert.equal(hasExit5Promise(original), true);
});

// ---- 자동 재전달 0 (coder-task.md §5-6, 이슈 완료조건 4) ------------------

const REDISPATCH_CALL_PATTERNS = [
  /Start-Process/g,
  /Start-Job/g,
  /dispatch\s+--inject/g,
  /--type\s+dispatch/g,
];

function countRedispatchCalls(text) {
  return REDISPATCH_CALL_PATTERNS.reduce(
    (sum, re) => sum + (text.match(re) || []).length,
    0,
  );
}

test("★자동 재전달 0: applied fixture introduces ZERO new redispatch-shaped calls (Start-Process/Start-Job/dispatch --inject/--type dispatch) compared to the before fixture -- the new block is diagnostics + exit only", () => {
  const beforeCount = countRedispatchCalls(loadBefore());
  const appliedCount = countRedispatchCalls(loadApplied());
  assert.equal(
    appliedCount,
    beforeCount,
    `applied fixture must add no new redispatch-shaped calls; before=${beforeCount} applied=${appliedCount}`,
  );
});

test("★자동 재전달 0 (직접): the new block's own text (from its guard line to end-of-file) contains no redispatch-shaped call at all", () => {
  const applied = loadApplied();
  const newBlockStart = applied.indexOf(NOTSTARTED_BLOCK_SNIPPET);
  assert.notEqual(
    newBlockStart,
    -1,
    "sanity-check: new block guard must be present",
  );
  const newBlockText = applied.slice(newBlockStart);
  assert.equal(countRedispatchCalls(newBlockText), 0);
});

// ---------------------------------------------------------------------------
// ★근본: drive the REAL applied-fixture text (never a reimplementation) in a
// real PowerShell process, with a synthetic target standing in for the two
// free variables the tail references.
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
    "the real script's tail must end on the closing brace of the new if ($confirmExit -in @(1, 2, 3)) block",
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
    // Same "bare `{` is a script-block literal, not an executed block" trap
    // documented+caught in HYK-378's effect test -- wrap in `if ($true) {`.
    "if ($true) {",
    realTailSnippet,
    "",
    // Reaching here means neither the exit-4 nor the exit-5 block fired --
    // i.e. confirmExit=0, the only value that should fall through.
    "exit 0",
  ].join("\n");
}

function runSyntheticTarget(confirmExitValue, psExe) {
  const snippet = extractRealTailSnippet(loadApplied());
  const dir = mkdtempSync(join(tmpdir(), "hyk272-notstarted-behavior-"));
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

test("★근본 행동: real applied-fixture tail with confirmExit=0 (STARTED, in-contract) -- harness reaches exit 0 (무회귀, coder-task.md §5-4); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
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

const notStartedCodesConsumedAsExit5 = [1, 2, 3];
for (const exitCode of notStartedCodesConsumedAsExit5) {
  test(`★근본 행동: real applied-fixture tail with confirmExit=${exitCode} -- harness reaches exit 5 (착수 확인 결과 미성공, 더 이상 exit 0 이 아니다); PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      5,
      `expected exit 5 for confirmExit=${exitCode}, got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

const contractViolationCodesStayAtExit4 = [4, 99];
for (const exitCode of contractViolationCodesStayAtExit4) {
  test(`★근본 행동 (무회귀): real applied-fixture tail with confirmExit=${exitCode} (계약 밖, HYK-378) -- harness still reaches exit 4, unaffected by this round's new block; PowerShell 없으면 SKIP_REASON과 함께 skip`, (t) => {
    if (!PS_EXE) {
      t.skip(NO_PS_SKIP_REASON);
      return;
    }
    const result = runSyntheticTarget(exitCode, PS_EXE);
    assert.equal(
      result.status,
      4,
      `expected exit 4 (HYK-378, unchanged) for contract-violating confirmExit=${exitCode}, got status=${result.status} stderr=${result.stderr}`,
    );
  });
}

// ---- ★되돌림 변이 (행동 축): reverting to the pre-HYK-272 (== HYK-378
// applied) tail must make exit 5 unreachable -- confirmExit=1/2/3 then fall
// through to the harness's own exit 0. Behavioral mirror of the collect
// test's document-level revert mutation.
test("★되돌림 변이 (행동 축): replacing the applied tail's new exit-5 block with the OLD pre-HYK-272 text (== HYK-378's applied tail) flips confirmExit=2 to exit 0 (RED for the invariant, proving the GREEN result above is not vacuous); PowerShell 없으면 SKIP_REASON과 함께 skip", (t) => {
  if (!PS_EXE) {
    t.skip(NO_PS_SKIP_REASON);
    return;
  }
  const oldPreHyk272Tail = extractRealTailSnippet(loadBefore());
  const dir = mkdtempSync(join(tmpdir(), "hyk272-notstarted-behavior-revert-"));
  try {
    const harnessPath = join(dir, "harness.ps1");
    writeFileSync(harnessPath, buildHarness(oldPreHyk272Tail, 2), "utf8");
    const result = spawnSync(
      PS_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `pre-HYK-272 text must let confirmExit=2 fall through to exit 0 (that is exactly the fail-open bug this patch fixes) -- got status=${result.status}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
