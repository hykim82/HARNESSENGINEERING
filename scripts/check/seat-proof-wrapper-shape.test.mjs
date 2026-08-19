import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { judgeSeatProofWrapperShape } from "./seat-proof-wrapper-shape.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./seat-proof-wrapper-shape.mjs", import.meta.url),
);

// review r1 §2-4 P2: this checker's own local anchor for the live control
// room file. Not a fixture -- read at test time, so it always reflects
// whatever the live wrapper currently says (see the live-file test below).
const CONTROL_ROOM_SCRIPT_PATH =
  "D:\\문서관리\\하네스-관제실\\dispatch-worker.ps1";

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

// ⚠️큐레이트된 사본(review r1 §2-4 P2 정리, 가안) — 2026-08-19 관제실 커밋
// 00f78f0의 부모(수리 전) `dispatch-worker.ps1` 380~405행을
// `git show 00f78f0^:dispatch-worker.ps1`으로 뜬 시점의 스냅샷을 그대로 옮긴
// 것이다(합성 아님. 다만 그 시점 이후 관제실이 바뀌었어도 이 문자열은 갱신되지
// 않는다 — «지금의 실물과 바이트 동일»이라는 주장은 하지 않는다). 이 텍스트가
// 바로 HYK-323 §1의 «오늘의 결함» 문면이다: `& node ...`의 stdout이 변수에
// 담기지 않고 그대로 `return $LASTEXITCODE`로 이어져, 함수가 실제로는
// [stdout문장, exit코드] 2요소 배열을 반환했다. 지금 살아있는 관제실 파일과의
// 실제 대조는 fixture가 아니라 아래 "실물: 현재 관제실..." 시험이 CLI 1회
// 로컬 실행(로컬 앵커)으로 담당한다.
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

// ⚠️큐레이트된 사본(review r1 §2-4 P2 정리, 가안) — HYK-323-wrapper-shape-1
// 라운드에서 그 시점의 라이브 관제실 `dispatch-worker.ps1`을 직접 읽어(§0
// 비타협2 «읽기 허용») 그대로 옮긴 스냅샷이다(합성 아님). 그 시점 이후
// 관제실이 다시 바뀌었을 수 있으므로(review r1 실측: fixture 2,129 B vs 그때의
// 실물 2,633 B로 이미 어긋나 있었다) «지금의 실물과 바이트 동일»이라는 주장은
// 하지 않는다 — 이 fixture는 "이 정형의 OK 판정"을 고정해 두는 단위 시험용일
// 뿐이다. 지금 살아있는 파일과의 실제 대조는 아래 "실물: 현재 관제실..."
// 시험이 담당한다.
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

// ---------------------------------------------------------------------
// review r1 P1 재현 시험 (§3) -- 검토자가 뚫은 세 문면이 이제 BROKEN이어야
// 한다.
// ---------------------------------------------------------------------

// P1-1: 캡처했다가 `Write-Output`으로 다시 흘려보내는 문면. return 자체는
// 여전히 `$LASTEXITCODE`를 정직하게 반환하지만(shape ⓑ만 보면 OK로 잘못
// 판정됐던 문면), 함수의 실제 파이프라인 출력에는 게이트 CLI의 stdout까지
// 섞여 나간다 -- shape ⓒ가 이걸 잡아야 한다.
const LEAK_VIA_WRITE_OUTPUT_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
  "  Write-Output $gateOut",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-1 재현a: Write-Output으로 캡처 변수를 되흘리면 -> BROKEN + LEAKED_CAPTURED_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(LEAK_VIA_WRITE_OUTPUT_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "LEAKED_CAPTURED_OUTPUT");
});

// P1-1 변형: `echo`는 `Write-Output`의 별칭이다 -- 별칭도 잡혀야 한다.
const LEAK_VIA_ECHO_ALIAS_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
  "  echo $gateOut",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-1 재현b: echo(Write-Output 별칭)로 캡처 변수를 되흘리면 -> BROKEN + LEAKED_CAPTURED_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(LEAK_VIA_ECHO_ALIAS_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "LEAKED_CAPTURED_OUTPUT");
});

// P1-1 변형: 캡처 변수를 단독 표현식으로 둔 줄 -- PowerShell에서 이 자체가
// 출력문이다.
const LEAK_VIA_BARE_EXPRESSION_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
  "  $gateExit = $LASTEXITCODE",
  "  $gateOut",
  "  return $gateExit",
  "}",
].join("\n");

test("P1-1 재현c: 캡처 변수를 단독 표현식 줄로 두면 -> BROKEN + LEAKED_CAPTURED_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(LEAK_VIA_BARE_EXPRESSION_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "LEAKED_CAPTURED_OUTPUT");
});

// P1-2: 수리된 정의 뒤에 같은 이름의 미캡처 결함 정의를 두 번 선언 --
// PowerShell은 마지막 정의만 살아있는데, 첫 정의만 보던 옛 판정기는 이걸
// 놓쳤다.
const DUPLICATE_DEFINITION_TEXT = [
  FIXED_FUNCTION_TEXT,
  "",
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  & node $gateCliPath --dispatch-show $dsShowPath",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-2 재현: 수리본 뒤에 미캡처 결함본을 중복 선언하면 -> BROKEN (첫 정의만 보지 않는다)", () => {
  const result = judgeSeatProofWrapperShape(DUPLICATE_DEFINITION_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.match(result.detail, /MULTIPLE_DEFINITIONS: 2 definitions/);
});

test("P1-2 재현b: 개별 판정이 전부 OK인 중복 정의도 -> BROKEN (모호성 자체가 결함)", () => {
  const bothOkDuplicate = [FIXED_FUNCTION_TEXT, "", FIXED_FUNCTION_TEXT].join(
    "\n",
  );
  const result = judgeSeatProofWrapperShape(bothOkDuplicate);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "MULTIPLE_DEFINITIONS");
  assert.match(result.detail, /MULTIPLE_DEFINITIONS: 2 definitions/);
});

// P1-3: 게이트 CLI 호출을 배열 splatting으로 인자를 넘기면, 옛 정규식
// (`& node $gateCliPath` 리터럴 토큰열)은 이 호출 자체를 놓쳐 OK로
// 오판했다.
const SPLATTED_UNCAPTURED_CALL_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  '  $nodeArgs = @($gateCliPath, "--dispatch-show", $dsShowPath)',
  "  & node @nodeArgs",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-3 재현: splatting(@nodeArgs)으로 인자를 넘긴 미캡처 호출 -> BROKEN + UNCAPTURED_GATE_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(SPLATTED_UNCAPTURED_CALL_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "UNCAPTURED_GATE_OUTPUT");
});

// P1-3 변형: `$node` 변수를 호출 대상으로 쓰는 표기도 놓치면 안 된다.
const NODE_VAR_UNCAPTURED_CALL_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  & $node $gateCliPath --dispatch-show $dsShowPath",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-3 재현b: `& $node ...` 변수 호출 표기의 미캡처도 -> BROKEN + UNCAPTURED_GATE_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(NODE_VAR_UNCAPTURED_CALL_TEXT);
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "UNCAPTURED_GATE_OUTPUT");
});

// P1-3 변형a: 백틱 줄바꿈 이어쓰기로 호출이 여러 줄에 걸쳐도 미캡처는
// 여전히 잡혀야 한다 -- 다만 이 표기는 첫 물리 줄에 이미 `& node`가 있어
// 줄 합치기(join) 없이도 원래 잡힌다(참고용, §4 변이 검증에서 join을
// 무력화해도 이 시험만은 GREEN으로 남는 게 정상임을 확인했다).
const BACKTICK_CONTINUED_UNCAPTURED_CALL_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  & node $gateCliPath `",
  "    --dispatch-show $dsShowPath `",
  "    --worktree-path (Norm $Worktree)",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-3 재현c: 백틱 줄바꿈 이어쓰기로 나뉜 미캡처 호출도 -> BROKEN + UNCAPTURED_GATE_OUTPUT", () => {
  const result = judgeSeatProofWrapperShape(
    BACKTICK_CONTINUED_UNCAPTURED_CALL_TEXT,
  );
  assert.equal(result.verdict, "BROKEN");
  assert.equal(result.reasonCode, "UNCAPTURED_GATE_OUTPUT");
});

// P1-3 변형b: 줄 합치기(join) 자체에 실제로 의존하는 시험 -- `| Out-Null`
// (안전 폐기 표기)이 첫 줄이 아니라 이어지는 백틱 연속 줄에 있으면, 줄을
// 합치지 않고서는 그 안전 표기를 볼 수 없어 오탐(BROKEN)이 난다. §4 변이
// 검증에서 join을 무력화하면 이 시험이 RED가 되는 것으로 join 로직의
// 존재 이유를 직접 검증했다.
const BACKTICK_CONTINUED_SAFE_OUT_NULL_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  & node $gateCliPath `",
  "    --dispatch-show $dsShowPath | Out-Null",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("P1-3 재현d: 백틱 이어쓰기 뒷줄의 | Out-Null 도 줄 합치기 덕에 안전 표기로 인식되어 OK", () => {
  const result = judgeSeatProofWrapperShape(
    BACKTICK_CONTINUED_SAFE_OUT_NULL_TEXT,
  );
  assert.deepEqual(result, { verdict: "OK" });
});

// ---------------------------------------------------------------------
// 안전 표기 대조군 (§2-2·§3) -- 과잉 차단(false positive) 0을 확인한다.
// ---------------------------------------------------------------------

const SAFE_WRITE_HOST_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  $gateOut = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
  "  $gateExit = $LASTEXITCODE",
  '  foreach ($line in @($gateOut)) { Write-Host "      $line" }',
  "  return $gateExit",
  "}",
].join("\n");

test("안전 표기a: Write-Host로 캡처 변수를 쓰는 것은 그대로 OK", () => {
  const result = judgeSeatProofWrapperShape(SAFE_WRITE_HOST_TEXT);
  assert.deepEqual(result, { verdict: "OK" });
});

const SAFE_NULL_ASSIGN_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  $null = & node $gateCliPath --dispatch-show $dsShowPath 2>&1",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("안전 표기b: $null = ... 으로 게이트 호출 출력을 버리는 것은 그대로 OK", () => {
  const result = judgeSeatProofWrapperShape(SAFE_NULL_ASSIGN_TEXT);
  assert.deepEqual(result, { verdict: "OK" });
});

const SAFE_OUT_NULL_PIPE_TEXT = [
  "function Invoke-SeatProofGate([string]$dispatchId) {",
  '  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"',
  "  & node $gateCliPath --dispatch-show $dsShowPath | Out-Null",
  "  return $LASTEXITCODE",
  "}",
].join("\n");

test("안전 표기c: | Out-Null 로 게이트 호출 출력을 버리는 것은 그대로 OK", () => {
  const result = judgeSeatProofWrapperShape(SAFE_OUT_NULL_PIPE_TEXT);
  assert.deepEqual(result, { verdict: "OK" });
});

// ---------------------------------------------------------------------
// 실물 (§3 항목5 · §2-4 P2 나안 부분 적용) -- 로컬에 관제실 경로가 있으면
// 지금 살아있는 파일 자체를 넣어 회귀 0을 확인한다. CI에는 이 경로가 없으므로
// (§2-3 정직 한계) 조용히 통과가 아니라 명시 사유와 함께 skip한다.
// ---------------------------------------------------------------------

test("실물: 현재 관제실 dispatch-worker.ps1이 있으면 OK 유지(회귀 0); 없으면(CI) 사유와 함께 skip", (t) => {
  if (!existsSync(CONTROL_ROOM_SCRIPT_PATH)) {
    t.skip(
      `SKIP_REASON: control room path not present in this environment (expected on CI) -- ${CONTROL_ROOM_SCRIPT_PATH}`,
    );
    return;
  }
  const liveText = readFileSync(CONTROL_ROOM_SCRIPT_PATH, "utf8");
  const result = judgeSeatProofWrapperShape(liveText);
  assert.deepEqual(result, { verdict: "OK" });
});
