// HYK-387 3R (coder-task.md §3-3) -- does the applied dispatch-worker.ps1
// fixture ACTUALLY write the pointer file, extracted VERBATIM from the
// applied fixture (never a hand-reimplemented stand-in) and run through a
// real PowerShell process against synthetic $Worktree/$ReceiptPath values?
//
// Two layers, same split as the HYK-378 precedent:
//   1. String/structure checks (mutation-testable) -- "does the applied
//      fixture's TEXT promise to write the pointer file".
//   2. ★근본: an ACTUAL PowerShell process, driving the exact inserted
//      snippet (never hand-copied prose) -- answers "does running this
//      code really write .harness/dispatch-receipt-path.txt with the
//      resolved $ReceiptPath value", which layer 1 cannot answer.
//
// ⛔This never runs against a real delivery / real dispatch-worker.ps1
// invocation -- it drives ONLY the inserted snippet (from the unique
// `try {` line this patch added through its matching `}` after the
// `catch` block), with $Worktree/$ReceiptPath set to synthetic mkdtemp
// values.
//
// ⚠️정직 한계 (HYK-378 선례와 동일 형태): 문자열 검사(레이어 1)는 "그
// 문장이 있다"만 보고 "그렇게 동작한다"는 못 본다 -- 레이어 2로 메우지만
// 그마저도: ⓐ 관제실의 살아 있는 dispatch-worker.ps1은 이 시험 어디서도
// 열지 않는다(라이브 드리프트를 못 잡는다, sha256 드리프트 감시가 별도로
// 맡는다) ⓑ PowerShell 언어 자체(`Set-Content`, `Join-Path`, `try/catch`)의
// 의미를 검증하지 않는다 -- pwsh 런타임 자체가 이미 신뢰된 전제다 ⓒ
// PowerShell이 설치돼 있지 않은 환경(CI 등)에서는 레이어 2 전체가
// SKIP_REASON 표지와 함께 시끄럽게 건너뛴다(조용한 스킵 없음) -- 그
// 환경에서는 레이어 1만 남는다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync as readFileSync2,
  rmSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "./seat-proof-wrapper-behavior.mjs";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-dispatch-worker-2026-08-29-hyk387-receipt-pointer-applied.ps1.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------

const POINTER_WRITE_SNIPPET =
  "Set-Content -LiteralPath $receiptPointerPath -Value $ReceiptPath -Encoding utf8 -NoNewline";
const NONFATAL_CATCH_SNIPPET =
  "HYK-387 3R: dispatch-receipt-path.txt 포인터 기록 실패(비치명적, 배달은 계속)";

function hasPointerWritePromise(text) {
  return text.includes(POINTER_WRITE_SNIPPET);
}
function hasNonFatalCatchPromise(text) {
  return text.includes(NONFATAL_CATCH_SNIPPET);
}

test("layer1 (string): applied fixture promises to Set-Content the resolved $ReceiptPath into $receiptPointerPath", () => {
  assert.equal(hasPointerWritePromise(loadApplied()), true);
});

test("layer1 (string): applied fixture promises the write is non-fatal (catch, does not block delivery)", () => {
  assert.equal(hasNonFatalCatchPromise(loadApplied()), true);
});

test("★되돌림 변이(layer1): deleting the Set-Content promise flips layer1 RED -- proves the check above is not vacuous", () => {
  const mutated = loadApplied().replace(POINTER_WRITE_SNIPPET, "# removed");
  assert.notEqual(mutated, loadApplied());
  assert.equal(hasPointerWritePromise(mutated), false);
});

// ---- layer 2: extract the REAL inserted snippet verbatim, run it for real -

// HYK-387 3R: locates the exact span this patch unit inserted -- from the
// unique `try {` this unit added (right after the $ReceiptPath resolution
// block, before it existed in ANY pre-3R fixture) through its matching
// closing `}` of the `catch` block. Extracted from the APPLIED fixture
// itself (never hand-retyped) so a drift between the fixture and this
// test's assumed text fails loudly (ANCHOR-style .indexOf(-1) assertion
// below), not silently.
function extractInsertedSnippet(appliedText) {
  const startMarker =
    'try {\n  $receiptPointerDir = Join-Path $Worktree ".harness"';
  const start = appliedText.indexOf(startMarker);
  assert.notEqual(
    start,
    -1,
    "sanity-check: the real inserted try{} block must be found verbatim in the applied fixture (extraction anchor drifted)",
  );
  const endMarker =
    'Write-Warning "HYK-387 3R: dispatch-receipt-path.txt 포인터 기록 실패(비치명적, 배달은 계속): $($_.Exception.Message)"\n}';
  const endIdx = appliedText.indexOf(endMarker, start);
  assert.notEqual(
    endIdx,
    -1,
    "sanity-check: matching catch-block end must be found",
  );
  return appliedText.slice(start, endIdx + endMarker.length);
}

// HYK-387 3R (자체 발견 결함 수리, 검토자 지목 아님): `pwsh -Command -`에
// 여러 줄로 된 stdin을 먹이면(예: try/catch, if 블록처럼 `{`가 별도 줄에
// 오는 구조) 완전히 조용히(exit 0, stdout·stderr 둘 다 빈 문자열) 아무
// 것도 실행되지 않는다는 것을 3R 작업 중 직접 실측했다(한 줄짜리
// try/catch는 되지만 여러 줄로 펼치면 즉시 깨진다) -- HYK-378 선례
// (control-room-patch-apply-hyk378-exit4-effect.test.mjs)가 이미
// `-File <harness.ps1>`(임시 스크립트 파일 경로)를 쓰는 이유가 바로
// 이것이었다(그 파일에서도 stdin 방식을 쓰지 않는다). 같은 관용구를
// 따른다 -- 다만 그 선례는 harness.ps1을 시스템 `tmpdir()` 아래 뒀는데,
// 이 라운드 §0 경계("네 파일은 이 워크트리 안")를 그대로 지키기 위해
// harness.ps1도 이 워크트리 SCRATCH_ROOT 아래에 쓴다(호출자가 넘기는
// `scratchDir` 인자, withPs1FixtureDir가 만든 그 디렉터리 자체를 그대로
// 재사용 -- 별도 tmpdir 불필요).
// HYK-387 3R (자체 발견 결함 수리 #2): `JSON.stringify(windowsPath)`를
// PowerShell **큰따옴표** 문자열로 그대로 박으면 안 된다 -- JSON은
// 백슬래시를 `\\`로 이스케이프하는데, PowerShell의 큰따옴표 문자열은
// 백슬래시를 이스케이프 문자로 취급하지 않으므로(리터럴 그대로) 그
// `\\`가 실제 값 안에 «두 배로 늘어난 백슬래시»로 그대로 남는다(3R
// 작업 중 직접 실측: 원래 경로 `...\.harness\...`가 `...\\.harness\\...`
// 로 기록됨). PowerShell **작은따옴표** 문자열은 백슬래시를 전혀
// 해석하지 않으므로 안전하다 -- 작은따옴표 자체만 두 배로 이스케이프
// 한다(PS 관례).
function psSingleQuote(str) {
  return `'${str.replace(/'/g, "''")}'`;
}

function runSnippet(snippet, { worktree, receiptPath, scratchDir }) {
  const ps = findPowerShell();
  if (!ps) {
    return {
      skipped: true,
      reason: "SKIP_REASON: no PowerShell found on PATH",
    };
  }
  const harness = [
    `$Worktree = ${psSingleQuote(worktree)}`,
    `$ReceiptPath = ${psSingleQuote(receiptPath)}`,
    snippet,
  ].join("\n");
  const harnessPath = join(scratchDir, "harness.ps1");
  writeFileSync(harnessPath, harness, "utf8");
  const res = spawnSync(
    ps,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
    { encoding: "utf8" },
  );
  return {
    skipped: false,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const SCRATCH_ROOT = fileURLToPath(
  new URL("../../.harness/hyk387-3r-ps1-scratch/", import.meta.url),
);

function withPs1FixtureDir(fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, "effect-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

test("★layer2 (real pwsh): the inserted snippet, extracted verbatim from the applied fixture, actually writes .harness/dispatch-receipt-path.txt with the resolved $ReceiptPath value", (t) => {
  const ps = findPowerShell();
  if (!ps) {
    t.diagnostic(
      "SKIP_REASON: no PowerShell found on PATH -- layer2 skipped loudly",
    );
    return;
  }
  withPs1FixtureDir((worktree) => {
    const receiptPath = join(worktree, "synthetic-dispatch-receipts.jsonl");
    const snippet = extractInsertedSnippet(loadApplied());
    const out = runSnippet(snippet, {
      worktree,
      receiptPath,
      scratchDir: worktree,
    });
    assert.equal(out.status, 0, `pwsh must exit 0: ${out.stderr}`);
    const pointerPath = join(worktree, ".harness", "dispatch-receipt-path.txt");
    assert.equal(
      existsSync(pointerPath),
      true,
      `pointer file must have been written at ${pointerPath}`,
    );
    const content = readFileSync2(pointerPath, "utf8");
    assert.equal(
      content,
      receiptPath,
      "pointer file content must be exactly the resolved $ReceiptPath value (no trailing newline -- -NoNewline)",
    );
  });
});

test("★되돌림 변이(layer2): mutating the extracted snippet's Set-Content call to write a WRONG value makes the real pwsh run diverge from the true $ReceiptPath -- proves layer2 actually reads the value, not a hardcoded stand-in", (t) => {
  const ps = findPowerShell();
  if (!ps) {
    t.diagnostic(
      "SKIP_REASON: no PowerShell found on PATH -- layer2 mutation skipped loudly",
    );
    return;
  }
  withPs1FixtureDir((worktree) => {
    const receiptPath = join(worktree, "synthetic-dispatch-receipts.jsonl");
    const original = extractInsertedSnippet(loadApplied());
    const mutated = original.replace(
      "-Value $ReceiptPath",
      '-Value "MUTATED-WRONG-VALUE"',
    );
    assert.notEqual(mutated, original);
    const out = runSnippet(mutated, {
      worktree,
      receiptPath,
      scratchDir: worktree,
    });
    assert.equal(out.status, 0, `pwsh must exit 0: ${out.stderr}`);
    const pointerPath = join(worktree, ".harness", "dispatch-receipt-path.txt");
    const content = readFileSync2(pointerPath, "utf8");
    assert.equal(
      content,
      "MUTATED-WRONG-VALUE",
      "RED signal: mutated snippet writes the mutated literal, proving the original's assertion (content === receiptPath) is load-bearing, not coincidental",
    );
  });
});
