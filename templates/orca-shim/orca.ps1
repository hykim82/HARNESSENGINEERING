# orca.ps1 -- HYK-389 조각 1: orca 기록 shim (PowerShell · 얇은 껍질).
#
# 이 파일을 PATH 앞에 «놓아야만» 동작한다. 설치기(install.mjs)는 이 파일을
# 복사하지도 PATH 에 얹지도 않는다 -- 좌석에 얹는 것은 조각 2(ORCH 런처)의
# 몫이다. 기록 단계 · OBSERVER · 앵커 아님(docs/enforcement-known-gaps.md
# gap#102).
#
# 하는 일은 하나: argv 를 «그대로» orca-shim-cli.mjs 에 넘기고 그 종료코드를
# 그대로 돌려준다. 분류 · 기록 · 위임 판단은 전부 CLI/코어에 있다(이 파일엔
# 판단이 없다).
#
# 환경 변수(전부 주입 값 · 하드코딩 0):
#   HARNESS_ORCA_SHIM_CLI    CLI 경로(없으면 이 파일 기준 ..\..\scripts\relay\)
#   HARNESS_ORCA_REAL_BIN    진짜 orca 바이너리(CLI 가 읽는다)
#   HARNESS_ORCA_SHIM_LEDGER 원장 경로(CLI 가 읽는다)

$cli = $env:HARNESS_ORCA_SHIM_CLI
if (-not $cli) {
  $cli = Join-Path $PSScriptRoot '..\..\scripts\relay\orca-shim-cli.mjs'
}
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  [Console]::Error.WriteLine("ORCA_SHIM_CLI_MISSING: shim CLI 를 찾지 못했다 -- 위임하지 않았다. 조회 실패 ≠ 위반 없음.")
  exit 127
}
# 호출자 스크립트 값은 «이 호출 동안만» 환경에 둔다: .ps1 은 호출한 셸과 «같은
# 프로세스» 에서 돌므로 되돌리지 않으면 뒤이은 직접 호출 · 자식 프로세스가 앞
# 스크립트 경로를 caller_script 로 단다(검토 1R P1-2). 이전 값을 저장 -> 호출 ->
# finally 에서 되돌림(없던 값이면 제거). 직접 호출이면 바깥 값도 지운다.
#
# P2-b(HYK-389 조각 2): node 가 PATH 에 없거나 시작하지 못하면 `& node` 는 예외를 던질
# 뿐 $LASTEXITCODE 를 바꾸지 않는다 -> 예전 값(없으면 $null)이 `exit $code` 로 새어
# 0 이 될 수 있었다(조용한 마비: 위임 0 인데 «성공»). 이제 그 경우는 «비0 종료 +
# stderr 사유 1줄» 이다 -- 위임하지 않았고 조회 실패 ≠ 위반 없음. $code 를 «null»
# 로 두지 않는다(마지막 방어선도 비0).
$prevCaller = $env:HARNESS_ORCA_SHIM_CALLER
$code = $null
try {
  if ($MyInvocation.PSCommandPath) {
    $env:HARNESS_ORCA_SHIM_CALLER = $MyInvocation.PSCommandPath
  } else {
    Remove-Item -Path Env:HARNESS_ORCA_SHIM_CALLER -ErrorAction SilentlyContinue
  }
  $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $nodeCmd) {
    [Console]::Error.WriteLine("ORCA_SHIM_NODE_MISSING: node 를 PATH 에서 찾지 못했다 -- 위임하지 않았다. 조회 실패 ≠ 위반 없음: 이 호출은 기록도 실행도 되지 않았다.")
    $code = 127
  } else {
    $global:LASTEXITCODE = $null
    try {
      & $nodeCmd.Source $cli @args
      $code = $LASTEXITCODE
    } catch {
      [Console]::Error.WriteLine("ORCA_SHIM_NODE_START_FAILED: node 를 시작하지 못했다 -- 위임하지 않았다. 조회 실패 ≠ 위반 없음: $($_.Exception.Message)")
      $code = 126
    }
    if ($null -eq $code) {
      [Console]::Error.WriteLine("ORCA_SHIM_NODE_START_FAILED: node 종료코드를 읽지 못했다 -- 위임 결과를 알 수 없다. 조회 실패 ≠ 위반 없음.")
      $code = 126
    }
  }
} finally {
  if ($null -eq $prevCaller) {
    Remove-Item -Path Env:HARNESS_ORCA_SHIM_CALLER -ErrorAction SilentlyContinue
  } else {
    $env:HARNESS_ORCA_SHIM_CALLER = $prevCaller
  }
}
exit $code
