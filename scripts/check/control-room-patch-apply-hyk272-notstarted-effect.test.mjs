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
//
// ⚠️2R 검토 P1 (coder-task.md §1, rejected -- STREAK 2, 게이트 2 발동): the
// 2R version of this check sliced out "the new block" by finding
// EXIT4_BLOCK_END_MARKER and scanning everything AFTER it. The reviewer
// showed that's still a POSITIONAL check in different clothes: inserting
// the redispatch call BEFORE that marker is never scanned at all --
// violation_count=0 regardless of what's hidden there. coder-task.md §2
// (책임자 판정 ㄱ) is explicit: stop using "where" language (marker/region/
// "new block") entirely. The invariant is about WHAT CHANGED, not WHERE.
//
// This round replaces position-based extraction with a before -> applied
// DIFF: every line that exists in `applied` more times than it exists in
// `before` (a per-exact-line-text multiset difference, order-independent,
// no normalization) is "newly added," no matter where in the file it
// landed -- front, middle, right before where a marker used to be, it makes
// no difference because there is no marker in this computation at all.
// coder-task.md §2 also points at the precedent already in this repo:
// control-room-patch-apply.mjs's own before/applied model. This mirrors
// that shape (whole-file compare) instead of inventing a new one.
//
// Newly-added lines are then classified: blank lines and TRUE PowerShell
// comments are inert and allowed to vary freely; everything else must
// exactly match one of the six statements this patch is documented to add.
// ⚠️2R 검토 P1 also flagged a second defect in the SAME "comment = inert"
// assumption: `#requires -Version 7.0` starts with `#` but is a PowerShell
// directive the interpreter actually acts on, not a no-op comment --
// isInertLine excludes it explicitly (coder-task.md §4).
//
// ⚠️No case/whitespace normalization is applied anywhere in this diff --
// coder-task.md §2's own warning: widening what counts as "the same line"
// only widens what a bypass can hide behind. Comparing raw, un-normalized
// line text means a whitespace or capitalization variant of an allowed
// line is simply a DIFFERENT line, present in `applied` but not `before`,
// and therefore flagged like anything else new.
function lineMultiset(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

// Lines present in `appliedText` strictly more often than in `beforeText`,
// one entry per extra occurrence -- e.g. if a line appears twice in
// `applied` and once in `before`, it contributes exactly one entry (the
// one genuinely new occurrence), not zero and not two. Position in the
// file plays no role in this computation.
function newlyAddedLines(beforeText, appliedText) {
  const beforeCounts = lineMultiset(beforeText);
  const added = [];
  for (const [line, appliedCount] of lineMultiset(appliedText)) {
    const extra = appliedCount - (beforeCounts.get(line) ?? 0);
    for (let i = 0; i < extra; i++) added.push(line);
  }
  return added;
}

// `#requires` (case-insensitive, PowerShell resolves it regardless of
// case) is a real directive the interpreter parses and acts on before the
// script runs -- it is NOT a no-op the way an ordinary `#`-prefixed
// comment is, so "starts with #" alone is not sufficient to call a line
// inert (coder-task.md §4, 2R 검토 P1's second finding).
const REQUIRES_DIRECTIVE_RE = /^#requires\b/i;

function isInertLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (!trimmed.startsWith("#")) return false;
  if (REQUIRES_DIRECTIVE_RE.test(trimmed)) return false;
  return true;
}

const ALLOWED_NEW_STATEMENT_LINES = new Set([
  "if ($confirmExit -in @(1, 2, 3)) {",
  '  Write-Host "[4/4] 착수 확인 결과가 성공이 아니다 -- 종료코드=$confirmExit (1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START)"',
  '  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."',
  '  Write-Host "[4/4] 이 스크립트는 5 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 · 5=착수 확인 결과 미성공)."',
  "  exit 5",
  "}",
]);

// The load-bearing function: any line newly added anywhere between
// `beforeText` and `appliedText` that is neither inert nor an exact member
// of the closed allowlist is a violation. No positional concept appears
// anywhere in this function's body.
function findClosedSetViolations(beforeText, appliedText) {
  return newlyAddedLines(beforeText, appliedText).filter(
    (line) => !isInertLine(line) && !ALLOWED_NEW_STATEMENT_LINES.has(line),
  );
}

test("★자동 재전달 0 (before→applied 차분, 자리 무관): the applied fixture, as committed, adds ONLY the documented statement lines relative to before -- zero violations (regression baseline, must be 0 for the RED cases below to mean anything)", () => {
  const violations = findClosedSetViolations(loadBefore(), loadApplied());
  assert.deepEqual(violations, []);
});

test("★위양성 0: running the SAME diff-based scan with applied treated as its own before (i.e. no change at all) reports zero added lines -- sanity-checking the diff primitive itself before trusting the RED cases below", () => {
  const applied = loadApplied();
  assert.deepEqual(newlyAddedLines(applied, applied), []);
});

// ---- ★검토자가 실증한 정확한 우회 + 목록 밖 모양들, «어디에 넣어도» RED
// (완료조건 1·2·5) --------------------------------------------------------

const REVIEWER_REPRO_LINE =
  "& orca orchestration dispatch --task task_fake --json";
// A different CLI surface entirely (not the orca CLI the reviewer used) --
// proves this isn't just pattern-matching "orca orchestration dispatch".
const DIFFERENT_CLI_SURFACE_LINE =
  'Invoke-Expression "node scripts/relay/dispatch-worker-cli.mjs --task task_fake"';
// A variable-obfuscated form: neither line alone contains the literal
// substring "dispatch --inject" or "--type dispatch" the original (1R)
// denylist looked for, and splitting the call across a variable assignment
// plus an invocation is exactly the shape a denylist regex is blind to.
const VARIABLE_OBFUSCATED_LINES =
  "$__reissue = 'orca'\n  & $__reissue orchestration dispatch --task task_fake --json";
// 2R 검토 P1's own whitespace/case variant -- must stay RED without any
// normalization (this design deliberately adds none, see block comment
// above).
const WHITESPACE_CASE_VARIANT_LINE =
  "& ORCA  orchestration dispatch --task task_fake --json";
// 2R 검토 P1's semicolon-chained variant -- proves this isn't line-prefix
// matching either (the malicious call rides on the SAME physical line as
// an otherwise-allowed statement).
const SEMICOLON_CHAINED_LINE =
  "  exit 5; & orca orchestration dispatch --task task_fake --json";

const REDISPATCH_FORMS = [
  ["검토자 원문 그대로(2R 재확인)", REVIEWER_REPRO_LINE],
  [
    "다른 CLI 표면(Invoke-Expression + 별도 워커 CLI)",
    DIFFERENT_CLI_SURFACE_LINE,
  ],
  ["변수로 우회한 2줄 형태", VARIABLE_OBFUSCATED_LINES],
  ["공백·대소문자 변형(3R 검토 P1 재현)", WHITESPACE_CASE_VARIANT_LINE],
  ["세미콜론으로 허용 줄에 편승(3R 검토 P1 재현)", SEMICOLON_CHAINED_LINE],
];

// Three distinct insertion points in the FULL applied fixture, chosen to
// prove the scan has no positional preference at all (완료조건 2 요구
// 그대로: 맨 앞 근처 · 중간 · 마커 앞):
//   - near the top of the file (long before anything HYK-272 added)
//   - the middle, spliced into unrelated pre-existing code
//   - immediately before where EXIT4_BLOCK_END_MARKER used to gate the
//     2R scan -- this is 2R 검토 P1's own exact repro point
const EXIT4_BLOCK_END_MARKER =
  'Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반)."\n  exit 4\n}';
// Unique, existing, unrelated-to-this-patch lines used purely as splice
// points for the mutation tests below -- NOT part of the closed-set or the
// diff computation itself (findClosedSetViolations never sees an anchor).
const FRONT_ANCHOR =
  "# 왜 사람이 실행하나 — ★2026-08-10 정정(HYK-219 리서치 + PM 교차비평 실측):";
const UNRELATED_MIDDLE_ANCHOR =
  '$confirmEngineSource = "dispatch-worker.ps1:`$engine"';

function insertLineAt(text, anchor, injected) {
  const idx = text.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      `insertLineAt: anchor not found: ${JSON.stringify(anchor)}`,
    );
  }
  return text.slice(0, idx) + injected + "\n" + text.slice(idx);
}

const INSERTION_SITES = [
  [
    "파일 맨 앞 근처",
    () => insertLineAt(loadApplied(), FRONT_ANCHOR, "PLACEHOLDER"),
  ],
  [
    "무관한 기존 코드 사이(중간)",
    () => insertLineAt(loadApplied(), UNRELATED_MIDDLE_ANCHOR, "PLACEHOLDER"),
  ],
  [
    "마커 바로 앞(2R 검토 P1 정확 재현 지점)",
    () => insertLineAt(loadApplied(), EXIT4_BLOCK_END_MARKER, "PLACEHOLDER"),
  ],
];

for (const [formLabel, injected] of REDISPATCH_FORMS) {
  for (const [siteLabel, buildMutated] of INSERTION_SITES) {
    test(`★어디에 넣어도 RED: "${formLabel}"를 "${siteLabel}"에 넣으면 before→applied 차분 스캔이 위반을 검출한다`, () => {
      const mutatedApplied = buildMutated().replace("PLACEHOLDER", injected);
      const violations = findClosedSetViolations(loadBefore(), mutatedApplied);
      assert.notEqual(
        violations.length,
        0,
        `expected a closed-set violation for form=${JSON.stringify(injected)} at site=${siteLabel}, got none`,
      );
    });
  }
}

test("sanity-check: the variable-obfuscated redispatch form matches NONE of the original (1R) four denylist patterns -- proves this specific case is genuinely new coverage, not a restatement", () => {
  const oldDenylistPatterns = [
    /Start-Process/,
    /Start-Job/,
    /dispatch\s+--inject/,
    /--type\s+dispatch/,
  ];
  const oldDenylistWouldHaveCaught = oldDenylistPatterns.some((re) =>
    re.test(VARIABLE_OBFUSCATED_LINES),
  );
  assert.equal(oldDenylistWouldHaveCaught, false);
});

// ---- ★잘라내기 기준(마커) 흔들기가 더 이상 회피가 아님 (완료조건 3) ------
//
// coder-task.md §3's exact point: the 2R defect wasn't really about the
// allowlist's line set -- it was that the scan depended on WHERE it cut.
// This round's scan (findClosedSetViolations above) takes no marker
// argument at all, so there is no "cutting criterion" left to corrupt --
// but that claim needs to be demonstrated, not just asserted. The two
// cases below tamper with the literal text that USED TO BE the 2R
// extraction marker and show the scan neither silently passes malicious
// content (case 1) nor spuriously flags benign textual drift by itself
// (case 2) -- i.e. the marker's presence or absence has zero bearing on
// the scan's correctness either way, because the scan was never told
// about it.
test("★마커 흔들기 1: corrupting the text that USED TO BE the extraction marker, together with a redispatch insertion at that exact spot, still produces a violation (RED, not a silent 0 -- 완료조건 3)", () => {
  const applied = loadApplied();
  const markerIdx = applied.indexOf(EXIT4_BLOCK_END_MARKER);
  assert.notEqual(
    markerIdx,
    -1,
    "sanity-check: marker text must be present before corrupting it",
  );
  // Corrupt one character inside the old marker text (this alone makes
  // that line differ from its `before` counterpart -- it becomes "newly
  // added" text too, which is expected and does not need to be a
  // violation by itself) AND splice the redispatch call in right there.
  const corrupted =
    applied.slice(0, markerIdx) +
    applied.slice(markerIdx).replace("exit 4", "exit 4X");
  const withRedispatch = insertLineAt(
    corrupted,
    "exit 4X",
    REVIEWER_REPRO_LINE,
  );
  const violations = findClosedSetViolations(loadBefore(), withRedispatch);
  assert.notEqual(
    violations.length,
    0,
    "expected the redispatch call to still be caught even with the old marker text corrupted around it",
  );
});

test("★마커 흔들기 2: deleting the old extraction marker text entirely, with NO malicious insertion, produces zero violations -- the scan's baseline correctness does not depend on that marker existing at all (완료조건 3, «없으면 통과»가 아니라 «있든 없든 정확»함을 보임)", () => {
  const applied = loadApplied();
  const withoutMarkerText = applied.replace(EXIT4_BLOCK_END_MARKER, "");
  // This mutation is a pure DELETION relative to applied -- deleting text
  // can only ever REDUCE occurrence counts, never add a new line, so
  // findClosedSetViolations (which only ever looks at ADDED lines) has
  // nothing to flag here. This is the deliberate contrast with test 1
  // above: the marker's fate by itself is inert to this scan either way.
  const violations = findClosedSetViolations(loadBefore(), withoutMarkerText);
  assert.deepEqual(violations, []);
});

// ---- ★#requires 오분류 수리 (완료조건 4) ---------------------------------

test('★#requires는 주석이 아니다: inserting "#requires -Version 7.0" as a new line is a violation, not silently treated as an inert comment (2R 검토 P1 두 번째 발견, coder-task.md §4)', () => {
  const applied = loadApplied();
  const mutated = insertLineAt(
    applied,
    EXIT4_BLOCK_END_MARKER,
    "#requires -Version 7.0",
  );
  const violations = findClosedSetViolations(loadBefore(), mutated);
  assert.notEqual(
    violations.length,
    0,
    "expected #requires -Version 7.0 to be flagged -- it is a real PowerShell directive, not an inert comment",
  );
});

test("★#requires 대소문자 무관: PowerShell resolves #Requires/#REQUIRES the same as #requires -- isInertLine must reject all of them equally", () => {
  for (const variant of [
    "#requires -Version 7.0",
    "#Requires -Version 7.0",
    "#REQUIRES -Version 7.0",
  ]) {
    assert.equal(
      isInertLine(variant),
      false,
      `expected ${JSON.stringify(variant)} to be non-inert`,
    );
  }
});

test("★ordinary comments stay inert: a genuinely no-op `#` comment line is still allowed to vary freely (regression -- the #requires fix must not turn every comment into a violation)", () => {
  assert.equal(
    isInertLine("# just an ordinary comment, changed wording is fine"),
    true,
  );
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
