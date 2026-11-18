# orca-orch-seat.ps1 -- HYK-389 조각 2 저장소 몫: ORCH 좌석 런처 «템플릿».
#
# ⛔이 파일은 «템플릿» 이다 -- 저장소에 있다고 해서 어느 좌석에도 적용되지 않는다.
# 관제실에 복사하고 부팅줄을 이 런처로 바꾸는 일은 ORCH S7(관제실 몫 · 실행 전
# REVIEW · 책임자 승인 뒤)이다. 설치기(install.mjs)는 이 파일을 복사하지도 PATH 에
# 얹지도 않는다. 기록 단계 · OBSERVER · 앵커 아님(docs/enforcement-known-gaps.md
# gap#102).
#
# 하는 일:
#   1. 부팅 판정 CLI(orch-seat-boot.mjs)를 부른다 -- 진짜 orca 경로 · shim 파일 ·
#      shim CLI 가 실재하는지 보고, 원장에 `orch_seat_boot` 1줄을 남긴다.
#   2. 판정이 shim=enabled 이면 shim 디렉터리를 PATH «맨 앞» 에 얹고
#      HARNESS_ROLE=ORCH · HARNESS_ORCA_REAL_BIN · HARNESS_ORCA_SHIM_LEDGER ·
#      런처 표지(HARNESS_ORCA_SHIM=<런처 기동 시각>)를 «그 명령을 띄우는 동안만»
#      환경에 둔다(끝나면 이전 값으로 되돌린다).
#   3. disabled 이면 PATH 를 건드리지 않는다. 어느 쪽이든 «같은 명령을 반드시 띄운다»
#      -- 부팅 판정이 틀려도 · node 가 없어도 · 진짜 경로가 틀려도 ORCH 는 기동된다
#      (마비 금지). 판정 실패는 stderr 한 줄과 원장 부팅 줄로만 남는다.
#
# 띄우는 명령 = HARNESS_ORCH_SEAT_COMMAND(기본 `claude`) + 이 런처가 받은 인자
# «그대로»(`$args`). 시험은 가짜 명령을 주입한다.
#
# 환경 변수(전부 주입 값 · 하드코딩 0 -- 관제실 복사본은 아래 «기본값» 줄만 고친다):
#   HARNESS_ORCA_REAL_BIN       진짜 orca 바이너리(없거나 틀리면 shim 을 얹지 않는다)
#   HARNESS_ORCA_SHIM_DIR       shim 디렉터리(기본 = 이 파일이 있는 디렉터리)
#   HARNESS_ORCA_SHIM_LEDGER    원장 경로(orca-direct-ledger.jsonl)
#   HARNESS_ORCA_SHIM_CLI       shim CLI(선택 · 없으면 shim 디렉터리 기준 파생)
#   HARNESS_ORCH_SEAT_COMMAND   띄울 명령(기본 `claude`)
#   HARNESS_ORCH_SEAT_NODE      node 실행 파일(기본 `node`)
#   HARNESS_ORCH_SEAT_BOOT_CLI  부팅 판정 CLI(기본 이 파일 기준 ..\..\scripts\relay\)
#
# ⚠️정직 한계: 런처를 거치지 않은 ORCH(옛 부팅줄 폴백 · 손 실행)는 기록 밖이다 ·
# 이 템플릿은 관제실에 복사돼야 동작한다(CI 밖) · 같은 권한 행위자는 원장 · 런처 ·
# PATH 를 바꿀 수 있다. OBSERVER 이고 앵커가 아니다.
# 되돌리기 한 줄: 관제실 부팅줄을 옛 줄(`claude ...` 직접 실행)로 되돌리면 shim 은
# 얹히지 않는다(옛 줄로 뜬 세션은 기록 밖이다).

$realBin = $env:HARNESS_ORCA_REAL_BIN
$shimDir = $env:HARNESS_ORCA_SHIM_DIR
if (-not $shimDir) { $shimDir = $PSScriptRoot }
$ledger = $env:HARNESS_ORCA_SHIM_LEDGER
$shimCli = $env:HARNESS_ORCA_SHIM_CLI
$command = $env:HARNESS_ORCH_SEAT_COMMAND
if (-not $command) { $command = 'claude' }
$nodeExe = $env:HARNESS_ORCH_SEAT_NODE
if (-not $nodeExe) { $nodeExe = 'node' }
$bootCli = $env:HARNESS_ORCH_SEAT_BOOT_CLI
if (-not $bootCli) {
  $bootCli = Join-Path $PSScriptRoot '..\..\scripts\relay\orch-seat-boot.mjs'
}

# 런처 표지 = 런처 기동 시각(설계 §다). 부팅 줄과 shim 쓰기 줄을 같은 기동에 묶는다.
$launchMark = [DateTime]::UtcNow.ToString('o')

# ── 1. 부팅 판정 ─────────────────────────────────────────────────────
# 어떤 실패(node 부재 · 판정 CLI 부재 · 출력 파싱 실패)도 «disabled» 로 접고 기동을
# 계속한다. 판정 JSON 에서는 ASCII 값(shim · reason)만 읽는다 -- 경로는 이 런처가 이미
# 갖고 있는 값을 쓴다(콘솔 인코딩이 경로의 한글을 깨뜨리지 못하게).
$shimEnabled = $false
$bootReason = 'BOOT_CLI_FAILED'
try {
  $bootArgs = @($bootCli)
  if ($realBin) { $bootArgs += @('--real-bin', $realBin) }
  if ($shimDir) { $bootArgs += @('--shim-dir', $shimDir) }
  if ($shimCli) { $bootArgs += @('--shim-cli', $shimCli) }
  if ($ledger) { $bootArgs += @('--ledger', $ledger) }
  $bootArgs += @('--mark', $launchMark, '--role', 'ORCH')
  $bootText = (& $nodeExe @bootArgs | Out-String)
  $decision = $bootText | ConvertFrom-Json -ErrorAction Stop
  if ($decision.shim -eq 'enabled') {
    $shimEnabled = $true
    $bootReason = $null
  } elseif ($decision.reason) {
    $bootReason = [string]$decision.reason
  }
} catch {
  $bootReason = 'BOOT_CLI_FAILED'
}
if (-not $shimEnabled) {
  # stderr 문구는 ASCII 만 쓴다(검토 1R P2-6): Windows PowerShell 5.1 은 BOM 없는 UTF-8 파일을
  # ANSI 로 읽고 [Console]::Error 는 콘솔 코드페이지로 쓰므로 한글 리터럴은 5.1 과 pwsh 에서
  # 모두 깨질 수 있다(실측). BOM 은 읽는 쪽만 고치고 에디터가 지울 수 있어 택하지 않았다.
  [Console]::Error.WriteLine("ORCH_SEAT_SHIM_DISABLED: $bootReason -- starting without the shim (this session's orca writes are outside the record). Lookup failure is not proof of no violation.")
}

# ── 2. 환경 구성 + 3. 명령 기동(항상) ──────────────────────────────────
# 값은 «이 명령을 띄우는 동안만» 환경에 둔다. 이전 값을 저장 -> 기동 -> finally 에서
# 되돌린다(없던 값이면 제거). .ps1 은 호출한 셸과 같은 프로세스에서 돌 수 있어 되돌리지
# 않으면 뒤이은 호출이 이 값을 물려받는다.
$envNames = @(
  'PATH',
  'HARNESS_ROLE',
  'HARNESS_ORCA_REAL_BIN',
  'HARNESS_ORCA_SHIM_LEDGER',
  'HARNESS_ORCA_SHIM_CLI',
  'HARNESS_ORCA_SHIM'
)
$saved = @{}
foreach ($name in $envNames) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$code = 0
try {
  $env:HARNESS_ROLE = 'ORCH'
  if ($shimEnabled) {
    $env:PATH = $shimDir + [IO.Path]::PathSeparator + $env:PATH
    $env:HARNESS_ORCA_REAL_BIN = $realBin
    $env:HARNESS_ORCA_SHIM_LEDGER = $ledger
    if ($shimCli) { $env:HARNESS_ORCA_SHIM_CLI = $shimCli }
    $env:HARNESS_ORCA_SHIM = $launchMark
  }
  & $command @args
  $code = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("ORCH_SEAT_COMMAND_FAILED: could not start command '$command' -- $($_.Exception.Message)")
  $code = 127
} finally {
  foreach ($name in $envNames) {
    [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
  }
}
if ($null -eq $code) { $code = 0 }
exit $code
