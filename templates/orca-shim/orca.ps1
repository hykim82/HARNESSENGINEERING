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
if ($MyInvocation.PSCommandPath) {
  $env:HARNESS_ORCA_SHIM_CALLER = $MyInvocation.PSCommandPath
}
& node $cli @args
exit $LASTEXITCODE
