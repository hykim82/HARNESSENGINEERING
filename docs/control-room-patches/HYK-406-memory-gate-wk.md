# HYK-406 패치 문서 (조각 B · memory-gate 쪽) — 좌석을 띄우기 «직전»에 주간 사용량을 읽고, 접기선 이상이면 새 좌석을 열지 않는다

**상태: PROPOSED.** 이 문서는 관제실 라이브 파일을 쓰지 않는다 — 적용은 별도 상신 + 책임자 판정 뒤다(판정 #20261119-1406 ②: «관제실 적용은 별도»). 이 문서가 닿는 저장소 쪽 짝 = `scripts/supervisor/usage-snapshot-read-cli.mjs`(읽기 전용 CLI) · 시험 = `scripts/supervisor/usage-snapshot-read-cli.test.mjs`(패치 단위를 합성 사본에 적용해 실제 PowerShell 로 구동).

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\memory-gate.ps1` · **SHA-256 `a7e19784e7864373ed421ae649917f863218ac8e6588d322614613ae9ea11a58`**(2026-11-19 14:18 KST 읽기 전용 · 판정 1138 적용판) · 줄끝 **LF**(274줄 · CR 0).
**적용본 SHA-256 = `161726aacec6007aa312ea91f8228e7cd63a466297d42da35cd3a21097dd84e8`**(아래 «생성 명령»을 라이브 파일을 `--source` 로 읽기만 하고 스크래치 `--out` 에 쓴 값).

**생성 명령**(이 라운드가 실제로 친 줄 · `--source` 는 읽기 전용 · `--out` 은 스크래치):

```
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-406-memory-gate-wk.md --source "D:\문서관리\하네스-관제실\memory-gate.ps1" --out "<스크래치>\memory-gate.hyk406-applied.ps1"
```

## 1. 무엇이 문제인가

ORCH 는 주간 한도에 부딪히면 일하다 중간에 끊긴다. 조각 A(예약 감시 통지)는 «90% 에 들어섰다» 를 **알릴 뿐** 새 좌석 배달을 막지 못한다 — 배달 게이트(memory-gate)는 메모리만 보고 열린다. 그래서 접기선(기본 90%)을 넘은 뒤에도 새 좌석이 계속 뜬다.

## 2. 패치가 세우는 것

- 좌석 기동 «직전»(`Assert-NoRunner 'pre-launch'` 바로 뒤 · `-DryRun` 종료 줄 «앞»)에 읽기 CLI 를 **한 번** 부른다. `-DryRun` 도 같은 판정을 보도록 DryRun 줄 앞에 둔다.
- **wk ≥ `-WkFold`(기본 90)** 이면 `Finish "CLOSED_WK_FOLD …" 'closed' $min` — 상태 파일 `status=closed` · 좌석 기동 0 · 종료 0(게이트의 기존 규칙: 판정과 무관하게 exit 0). 다른 CLOSED_* 판정과 같은 모양이라 재배달(pending_cmd) 흐름은 그대로다.
- **관측 불가 · 낡음 · CLI 실패 = «열고 사유 줄»**(fail-open · 책임자 판정 2026-11-19 · 설계 §6 :126). 사유 줄은 로그(`$OUT`)에 `WK-GATE UNOBSERVED (fail-open) status=<unavailable|stale|error> reason=<…>` 로 남는다. 이 경우를 «통과» 줄(`WK-GATE pass`)로 적지 않는다 — 0% 로 접지 않는다.
- **인자로 덮기**: `-WkFold <n>`(기본 90 · 예: 100 이면 91 은 열림 · 101 이상이면 사실상 끔) · `-UsageCli <경로>`(CLI 자리 · 기본 = `-Worktree` 아래 `scripts/supervisor/usage-snapshot-read-cli.mjs`) · `-UsageHudDir <경로>`(HUD 디렉터리 · 기본 = CLI 의 홈 `.claude/hud`) · `-UsageCliTimeoutSec <n>`(기본 15 · 넘으면 CLI 를 끊고 «열고 사유 줄»).
- 기존 판정 문구 · 종료 코드 · 여유 규칙 · 러너 중 개방(판정 1138)은 한 글자도 바꾸지 않는다 — 이 패치는 줄을 **더할** 뿐이고 기존 줄은 앵커 두 개(param 끝 줄 · 좌석 기동 직전 줄)만 다시 쓰되 원문을 그대로 포함한다.

## 3. 순서와 정직 한계 (⛔줄이지 마라)

- ⭐**OBSERVER 다 — 앵커가 아니다.** CLI 가 읽는 HUD 파일(`ratelimit-<역할>.json`)은 상태줄 생성기가 사용자 권한으로 쓰고 **ORCH 도 같은 권한으로 덮어쓸 수 있다.** 그래서 «wk 가 낮다» 는 «지갑이 안전하다» 의 증거가 아니다. 이 게이트는 «접기선에 닿은 것을 사람 눈 없이 막는» 용도지 위조를 막는 장치가 아니다.
- **낡음 60분**: HUD 는 좌석이 활동할 때만 갱신된다. 60분 넘게 갱신이 없으면 값을 믿지 않고 «열고 사유 줄» 이다 — 유휴 ORCH 의 값은 낡을 뿐 틀리지 않으므로 낡은 99 로 닫지 않는다(그 대가로, 모든 좌석이 한 시간 넘게 쉬다가 첫 좌석을 띄울 때는 값을 못 보고 열린다).
- **관측 불가면 열린다.** 책임자 판정(fail-open): 읽기 도구의 고장이 배달 전체를 멈추는 편이 더 나쁘다고 본 것이다. 그래서 이 게이트의 «닫힘» 은 «값을 읽었고 접기선 이상일 때» 만 나온다. 값이 비었거나 범위 밖(0..100 아님)이거나 문자열이거나 파일이 없거나 깨졌거나 CLI 가 없거나 죽거나 멈춰도 열린다.
- **wk 는 «값이 있는 가장 신선한 파일» 이다**(지갑은 하나). 어느 좌석 값인지 구별되지 않고, 같은 역할 좌석 둘은 같은 파일을 덮어쓴다(usage-threshold-core.mjs 머리 4 · 7항).
- **CLI 자리 가정**: 기본 경로는 `-Worktree`(좌석이 뜰 워크트리) 아래다. 이 패치가 병합되기 «전에» 만든 워크트리 · 다른 저장소 워크트리에는 CLI 가 없어 «열고 사유 줄(CLI not found)» 이 된다 — 그 경우 `-UsageCli` 에 하네스 master 워크트리의 CLI 를 주거나, 적용 때 기본값을 그 경로로 정하는 것은 ORCH/책임자 몫이다(이 문서는 정하지 않는다).
- **측정 «뒤»에 닫힌다**: 판정은 좌석 기동 직전이라 측정(최대 수 분)을 다 하고 나서 닫힌다. 측정 시간이 낭비되지만 «기동 직전 값» 을 보라는 설계 문면(조각 B 행)을 따랐다. 앞당기려면 별도 판정이 필요하다.
- **접기선 이상이어도 이미 뜬 좌석은 그대로**다(새 좌석만 막는다). 95% 유휴선 동작은 이 패치의 범위가 아니다.
- **CLI 시간 상한 15초**: 읽기 전용 파일 몇 개라 보통 100ms 안이다. 상한은 «CLI 가 멈춰도 게이트가 같이 멈추지 않게» 하는 안전장치이고, 끊으면 «열고 사유 줄(timed out)» 이다.
- 이 게이트는 «관례 수준 스크립트»다(원본 머리말) — 상태 파일을 읽는 장치는 F-2 이전에는 없다. 시험은 **합성 사본**(앵커 줄만 실물과 같게 흉내낸 ps1)에서 패치 단위를 실제 PowerShell 로 실행한다 — 실제 memory-gate.ps1(측정 · Get-Counter · orca terminal create)은 열지 않는다. 실물 앵커 적용은 아래 §5 의 적용 절차(원본 SHA-256 대조 + 도구 적용 + 파싱 검사)가 본다.

## 4. §패치 단위 (기계 추출 대상 · 2개)

### 4-1. 인자 4개 추가 (원본 :31 `[switch]$DryRun` 줄)

```control-room-patch-unit
id: hyk406-gate-params
mode: replace
@@ANCHOR@@
  [switch]$DryRun
@@CONTENT@@
  [int]$WkFold = 90,
  [string]$UsageCli = '',
  [string]$UsageHudDir = '',
  [int]$UsageCliTimeoutSec = 15,
  [switch]$DryRun
@@END@@
```

### 4-2. 좌석 기동 직전 주간 사용량 판정 (원본 :256 `Assert-NoRunner 'pre-launch'` 줄 — `-DryRun` 종료 줄 앞)

```control-room-patch-unit
id: hyk406-gate-wk-check
mode: replace
@@ANCHOR@@
Assert-NoRunner 'pre-launch'
@@CONTENT@@
Assert-NoRunner 'pre-launch'

# HYK-406 조각 B (2026-11-19 · 판정 #20261119-1406): 좌석 기동 «직전»에 주간 사용량을 한 번 읽는다.
# wk >= -WkFold(기본 90) 이면 새 좌석을 열지 않는다(CLOSED_WK_FOLD). 읽을 수 없거나 낡았거나 CLI 가 실패하면 «열고» 사유 줄을 남긴다(fail-open · 책임자 판정).
# OBSERVER -- HUD 파일은 ORCH 도 쓸 수 있다(앵커 아님). CLI = 저장소 scripts/supervisor/usage-snapshot-read-cli.mjs(읽기 전용 · 한 줄 JSON · 종료 0).
$wkSnap = $null; $wkWhy = $null; $wkVal = $null
try {
  $wkCli = if ($UsageCli) { $UsageCli } else { Join-Path $Worktree 'scripts/supervisor/usage-snapshot-read-cli.mjs' }
  if (-not (Test-Path -LiteralPath $wkCli)) { throw "usage CLI not found: $wkCli" }
  $wkPsi = New-Object System.Diagnostics.ProcessStartInfo
  $wkPsi.FileName = 'node'
  $wkPsi.UseShellExecute = $false
  $wkPsi.RedirectStandardOutput = $true
  [void]$wkPsi.ArgumentList.Add($wkCli)
  if ($UsageHudDir) { [void]$wkPsi.ArgumentList.Add('--hud-dir'); [void]$wkPsi.ArgumentList.Add($UsageHudDir) }
  $wkProc = [System.Diagnostics.Process]::Start($wkPsi)
  $wkOutTask = $wkProc.StandardOutput.ReadToEndAsync()
  if (-not $wkProc.WaitForExit($UsageCliTimeoutSec * 1000)) {
    try { $wkProc.Kill($true) } catch { }
    throw "usage CLI timed out after ${UsageCliTimeoutSec}s"
  }
  $wkProc.WaitForExit()
  if ($wkProc.ExitCode -ne 0) { throw "usage CLI exit=$($wkProc.ExitCode)" }
  $wkText = $wkOutTask.Result.Trim()
  if (-not $wkText) { throw 'usage CLI printed nothing' }
  $wkSnap = $wkText | ConvertFrom-Json
  $wkStatus = [string]$wkSnap.status
  $wkVal = $wkSnap.seven_day
  if ($wkStatus -eq 'ok') {
    if (-not ($wkVal -is [int] -or $wkVal -is [long] -or $wkVal -is [double] -or $wkVal -is [decimal])) { throw 'status=ok but seven_day is not a number' }
  } elseif ($wkStatus -eq 'stale' -or $wkStatus -eq 'unavailable') {
    $wkWhy = "status=$wkStatus reason=$(if ($wkSnap.reason) { $wkSnap.reason } else { '(none given)' })"
  } else {
    throw "unknown status '$wkStatus'"
  }
} catch {
  $wkWhy = "status=error reason=$($_.Exception.Message)"
}
if ($wkWhy) {
  Log "WK-GATE UNOBSERVED (fail-open) $wkWhy -- weekly usage not observable, seat allowed (ruling 20261119-1406 · OBSERVER, not an anchor)"
} elseif ([double]$wkVal -ge $WkFold) {
  Finish "CLOSED_WK_FOLD wk=$wkVal >= WkFold=$WkFold role=$($wkSnap.role) ageMin=$($wkSnap.ageMin) (weekly usage at or over the fold line -- no seat launched · override with -WkFold · ruling 20261119-1406)" 'closed' $min
} else {
  Log "WK-GATE pass wk=$wkVal < WkFold=$WkFold role=$($wkSnap.role) ageMin=$($wkSnap.ageMin)"
}
@@END@@
```

## 5. §적용 절차 (관제실 적용은 별도 상신 · 책임자 판정 «뒤»에만)

⛔**이 라운드는 아래를 «치지 않는다».** 적용 «뒤»의 자기 확인까지 포함한 순서만 적어 둔다. 같은 pwsh 세션에서 순서대로 친다. `node scripts/check/control-room-patch-apply.mjs --doc docs/…` 만 상대 경로이므로 **이 저장소의 master 워크트리 루트**에서 친다(관제실 폴더에는 `scripts\` 가 없다).

```
# 0. 적용 «전» 라이브 SHA-256 = before
(Get-FileHash 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Algorithm SHA256).Hash.ToLower()
#   기대값: a7e19784e7864373ed421ae649917f863218ac8e6588d322614613ae9ea11a58   (다르면 멈춘다 -- 문서의 앵커를 다시 확인할 것)

# 1. 적용본을 라이브가 아닌 곳에 만든다
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-406-memory-gate-wk.md --source "D:\문서관리\하네스-관제실\memory-gate.ps1" --out "D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk406-applied.ps1"
(Get-FileHash 'D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk406-applied.ps1' -Algorithm SHA256).Hash.ToLower()
#   기대값: 161726aacec6007aa312ea91f8228e7cd63a466297d42da35cd3a21097dd84e8

# 2. 파싱 검사 (오류 0 -- 앞의 `$errs = $null;` 이 없으면 새 셸에서 거짓 0 이 나온다)
$errs = $null; [System.Management.Automation.Language.Parser]::ParseFile('D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk406-applied.ps1', [ref]$null, [ref]$errs) | Out-Null; $errs.Count

# 3. 라이브 교체 (되돌림 사본 먼저)
Copy-Item 'D:\문서관리\하네스-관제실\memory-gate.ps1' 'D:\문서관리\하네스-관제실\.tmp\memory-gate.before-hyk406.ps1'
Copy-Item 'D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk406-applied.ps1' 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Force
(Get-FileHash 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Algorithm SHA256).Hash.ToLower()   # 기대값 = 위 적용본 SHA-256

# 4. 적용 «후» 게이트 자체 확인 -- -DryRun 은 좌석을 절대 띄우지 않는다. 로그·상태·이력은 스크래치로 보내 라이브 watch\ 를 건드리지 않는다.
#    합성 HUD 디렉터리(seven_day 91 인 ratelimit-ORCH.json, at = 방금)를 -UsageHudDir 로 준다. 측정 수 분 + 끝의 판정 줄만 본다.
#    볼 것: 로그 마지막에 VERDICT=CLOSED_WK_FOLD wk=91 >= WkFold=90  (그리고 같은 명령에 -WkFold 100 을 더하면 WK-GATE pass wk=91 < WkFold=100)
```

**되돌림** = `.tmp\memory-gate.before-hyk406.ps1` 를 라이브 경로에 복사하고 SHA-256 이 `a7e19784…1a58` 인지 확인한다.
**적용 뒤 실제 감시에서 보는 법**: 조각 A 의 «관측 불가» 통지가 실제 예약 감시(OrchStallWatch)에서 나오는지와, 게이트 로그(`WK-GATE …` 줄)에 사유가 남는지를 값으로 본다 — 이 문서의 합성 시험이 못 보는 부분이다.
