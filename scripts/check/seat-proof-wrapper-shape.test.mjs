import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { judgeSeatProofWrapperShape } from "./seat-proof-wrapper-shape.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./seat-proof-wrapper-shape.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-proof-wrapper-shape-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// 실물 문면 — 2026-08-19 관제실 커밋 00f78f0의 부모(수리 전) `dispatch-worker.ps1`
// 380~405행을 `git show 00f78f0^:dispatch-worker.ps1`으로 직접 떠서 그대로 옮긴
// 것이다(합성 아님). 이 텍스트가 바로 HYK-323 §1의 «오늘의 결함» 문면이다:
// `& node ...`의 stdout이 변수에 담기지 않고 그대로 `return $LASTEXITCODE`로
// 이어져, 함수가 실제로는 [stdout문장, exit코드] 2요소 배열을 반환했다.
const BROKEN_FUNCTION_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  if (-not (Test-Path $gateCliPath)) {",
  '    Write-Error "SEAT_PROOF_CLI_MISSING: $gateCliPath 가 없다 -- 좌석 증명을 확인할 수 없으므로 배달을 계속하지 않는다(HYK-299 gap#55 기계 게이트, fail-closed)."',
  "    exit 8",
  "  }",
  '  $dsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-dispatch-show.json"',
  '  $tsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-terminal-show.json"',
  "  & orca orchestration dispatch-show --task $Task --json | Out-File -FilePath $dsShowPath -Encoding utf8",
  "  & orca terminal show --terminal $handle --json | Out-File -FilePath $tsShowPath -Encoding utf8",
  "  # worktreeId 축은 ps1이 사전에 독립적으로 알 수 있는 값이 아니다(실측:",
  "  # `<세션 guid>::<경로>` 형태, guid part는 ps1이 모른다) -- 이번 결선에서는",
  "  # 방금 뜬 terminal-show 자신에서 취한다(부분 동어반복, 알려진 한계 --",
  "  # docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md 정직",
  "  # 한계 절 참조). worktreePath는 $Worktree(ps1이 처음부터 아는 값, Norm으로",
  "  # orca의 슬래시 표기와 맞춘다)를 그대로 쓴다 -- 이 축은 진짜 독립이다.",
  "  # 배정 신원 축(harnessTaskId=$label/runtimeTaskId=$Task/dispatchId)과",
  "  # pane-key 축(dispatch-show의 assignee_pane_key vs 이 terminal-show의",
  "  # tabId:leafId)은 전부 진짜 독립 대조다.",
  "  $tsShowObj = Get-Content $tsShowPath -Raw | ConvertFrom-Json",
  "  $seatProofWorktreeId = $tsShowObj.result.terminal.worktreeId",
  "  & node $gateCliPath --dispatch-show $dsShowPath --terminal-show $tsShowPath --harness-task-id $label --runtime-task-id $Task --dispatch-id $dispatchId --worktree-id $seatProofWorktreeId --worktree-path (Norm $Worktree)",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

// 실물 문면 — 지금 라이브인 관제실 `dispatch-worker.ps1`을 이 라운드에서 직접
// 읽어(§0 비타협2 «읽기 허용») 그대로 옮긴 것이다(합성 아님). 2026-08-19 19:11
// 비상 직수리(커밋 00f78f0) 이후의 현재 수리된 문면이며, docs/control-room-
// patches/HYK-299-dispatch-worker-seat-proof.md HYK-323절의 발췌와도 바이트
// 단위로 동일함을 대조했다.
const FIXED_FUNCTION_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  if (-not (Test-Path $gateCliPath)) {",
  '    Write-Error "SEAT_PROOF_CLI_MISSING: $gateCliPath 가 없다 -- 좌석 증명을 확인할 수 없으므로 배달을 계속하지 않는다(HYK-299 gap#55 기계 게이트, fail-closed)."',
  "    exit 8",
  "  }",
  '  $dsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-dispatch-show.json"',
  '  $tsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-terminal-show.json"',
  "  & orca orchestration dispatch-show --task $Task --json | Out-File -FilePath $dsShowPath -Encoding utf8",
  "  & orca terminal show --terminal $handle --json | Out-File -FilePath $tsShowPath -Encoding utf8",
  "  # worktreeId 축은 ps1이 사전에 독립적으로 알 수 있는 값이 아니다(실측:",
  "  # `<세션 guid>::<경로>` 형태, guid part는 ps1이 모른다) -- 이번 결선에서는",
  "  # 방금 뜬 terminal-show 자신에서 취한다(부분 동어반복, 알려진 한계 --",
  "  # docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md 정직",
  "  # 한계 절 참조). worktreePath는 $Worktree(ps1이 처음부터 아는 값, Norm으로",
  "  # orca의 슬래시 표기와 맞춘다)를 그대로 쓴다 -- 이 축은 진짜 독립이다.",
  "  # 배정 신원 축(harnessTaskId=$label/runtimeTaskId=$Task/dispatchId)과",
  "  # pane-key 축(dispatch-show의 assignee_pane_key vs 이 terminal-show의",
  "  # tabId:leafId)은 전부 진짜 독립 대조다.",
  "  $tsShowObj = Get-Content $tsShowPath -Raw | ConvertFrom-Json",
  "  $seatProofWorktreeId = $tsShowObj.result.terminal.worktreeId",
  "  # ★HYK-323 비상 직수리(2026-08-19, ORCH 교대 28회차 · 검토 없이 적용 -- 상신",
  "  # 통역 받는함 `2026-08-19-1906-상신-좌석증명-래퍼결함-배달전면차단.md` 5항 ⓐ 승인분).",
  "  # 결함: `& node ...` 의 stdout 한 줄이 함수 반환값에 섞여 `return $LASTEXITCODE` 와",
  "  # 함께 [문장, 코드] 배열로 나갔다 -> 호출부 `-ne 0` 이 «PROVEN(exit 0)» 도 참으로 읽어",
  "  # **모든 배달을 거부**했다(합성 재현 완료: exit 0 인데 거부). 판정 로직·검사 강도는",
  "  # 그대로이며, 화면 출력을 Write-Host 로 분리해 반환값을 종료코드 하나로 만든다.",
  "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath --terminal-show $tsShowPath --harness-task-id $label --runtime-task-id $Task --dispatch-id $dispatchId --worktree-id $seatProofWorktreeId --worktree-path (Norm $Worktree) 2>&1",
  "  $gateExit = $LASTEXITCODE",
  '  foreach ($line in @($gateOut)) { Write-Host "      $line" }',
  "  return $gateExit",
  "}",
].join("\n");

test("항목1: 오늘의 결함 실물 문면 -> BROKEN + UNCAPTURED_GATE_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(BROKEN_FUNCTION_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "UNCAPTURED_GATE_OUTPUT");
});

test("항목2: 현재 수리된 실물 문면 -> OK", () => {
  const result = judgeSeatProofWrapperShape(FIXED_FUNCTION_TEXT);
  assert.deepEqual(result, { verdict: "OK" });
});

test("항목3: 함수 자체가 없는 텍스트 -> BROKEN + FUNCTION_NOT_FOUND (fail-closed)", () => {
  const result = judgeSeatProofWrapperShape(
    "function SomeOtherFunction() {\n  return 0\n}\n",
  );
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "FUNCTION_NOT_FOUND");
});

test("항목3b: 빈 문자열 입력 -> BROKEN + FUNCTION_NOT_FOUND", () => {
  const result = judgeSeatProofWrapperShape("");
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "FUNCTION_NOT_FOUND");
});

test("항목4: 결함 모양이 주석 안에 «글자로만» 있으면 OK (주석을 코드로 오탐하지 않는다)", () => {
  const commentedDefect = [
    "function Invoke-SeatProofGate([string]$dispatchId) {",
    "  # 아래는 결함 문면 예시(설명용, 실제 코드 아님):",
    "  # & node $gateCliPath --dispatch-show $dsShowPath --worktree-path (Norm $Worktree)",
    "  # return $LASTEXITCODE",
    "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
    "  $gateExit = $LASTEXITCODE",
    "  return $gateExit",
    "}",
  ].join("\n");
  const result = judgeSeatProofWrapperShape(commentedDefect);
  assert.deepEqual(result, { verdict: "OK" });
});

test("항목5a: CRLF 줄바꿈 + 들여쓰기 흔들림에도 결함 문면은 여전히 BROKEN", () => {
  const crlfBroken = BROKEN_FUNCTION_TEXT.replace(/\n/g, "\r\n").replace(
    /^ {2}/gm,
    "\t\t",
  );
  const result = judgeSeatProofWrapperShape(crlfBroken);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "UNCAPTURED_GATE_OUTPUT");
});

test("항목5b: CRLF 줄바꿈 + 들여쓰기 흔들림에도 수리된 문면은 여전히 OK", () => {
  const crlfFixed = FIXED_FUNCTION_TEXT.replace(/\n/g, "\r\n").replace(
    /^ {2}/gm,
    "      ",
  );
  const result = judgeSeatProofWrapperShape(crlfFixed);
  assert.deepEqual(result, { verdict: "OK" });
});

test("CLI: 결함 문면 파일 -> WRAPPER_SHAPE: BROKEN + exit 2", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "broken.ps1");
    writeFileSync(path, BROKEN_FUNCTION_TEXT, "utf8");
    const result = runCli(["--script", path]);
    assert.equal(result.status, 2);
    assert.match(
      result.stdout,
      /^WRAPPER_SHAPE: BROKEN reason=UNCAPTURED_GATE_OUTPUT$/m,
    );
  });
});

test("CLI: 수리된 문면 파일 -> WRAPPER_SHAPE: OK + exit 0", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "fixed.ps1");
    writeFileSync(path, FIXED_FUNCTION_TEXT, "utf8");
    const result = runCli(["--script", path]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^WRAPPER_SHAPE: OK$/m);
  });
});

test("CLI: --script 인자 누락 -> exit 2", () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
});

test("CLI: 존재하지 않는 파일 -> exit 2 (fail-closed)", () => {
  const result = runCli([
    "--script",
    join(tmpdir(), "no-such-file-hyk323.ps1"),
  ]);
  assert.equal(result.status, 2);
});

test("BROKEN/FIXED 실물 fixture가 실제로 서로 다른 텍스트임을 확인 (동어반복 방지)", () => {
  assert.notEqual(BROKEN_FUNCTION_TEXT, FIXED_FUNCTION_TEXT);
});
