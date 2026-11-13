# HYK-501 패치 문서 (조각 E · memory-gate 쪽) — 게이트는 스스로 해석하지 않고, 측정 «전»에 런처 `-DryRun` 으로 먼저 확인한다

**상태: PROPOSED.** 이 문서는 `HYK-501-registry-consume.md`(런처 패치 + E2 절차 전체)의 **짝**이다. 관제실 라이브 파일을 쓰지 않는다 — 적용은 E2(별도 상신 · S7 REVIEW)이며 **런처를 먼저 적용한 뒤에** 이 문서를 적용한다(⛔역순 금지 — 아래 §3).

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\memory-gate.ps1` · **SHA-256 `17219bdc58150c9e3771079c9d601d3c2a9a25764b7872f67fa2f20ecf1ade51`**(2026-11-13 08:3x KST 읽기 전용 · 바이트 복사) · 줄끝 **LF**(222줄 · CR 0) · BOM 없음 · 고정 사본(before) = `scripts/check/fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-before.ps1.txt`(저장소에 memory-gate 고정 사본이 생기는 것은 이것이 처음이다).
**적용본 SHA-256 = `c9db5cd91f7232d5c77f548b8df18700d10dfc3b199ebd85b124bcb3d98b99b9`** · 고정 사본(applied) = `…-hyk501-registry-consume-applied.ps1.txt`(도구가 만든 바이트).

**생성 명령**(이 라운드가 실제로 친 줄):

```
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-501-registry-consume-memory-gate.md --source scripts/check/fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-before.ps1.txt --out scripts/check/fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-applied.ps1.txt
```

## 1. 무엇이 문제인가

memory-gate 는 모델·effort 의 기본값을 리터럴로 들고(`:21` `claude-sonnet-5` · `:22` `high`) 런처를 부를 때마다 `-Engine claude` 를 **고정**으로 붙인다(`:210`). 그래서 ① 호출자(ORCH)가 `-Model` 을 빼먹으면 등록부와 무관한 옛 모델로 뜨고 ② `-Engine claude` 고정이 런처의 등록부 해석을 늘 가려서 REVIEW 같은 역할의 등록부 엔진이 게이트 경로에서는 한 번도 읽히지 않는다.

## 2. 패치가 세우는 것

- 게이트는 **스스로 해석하지 않는다**(해석은 런처 한 곳). `$Model` · `$Effort` 기본값을 `''` 로 바꾸고 `[string]$Engine = ''` 를 새로 둔다. 런처에는 **비지 않은 인자만** 넘긴다 — 인자가 없으면 런처가 등록부에서 정한다.
- **측정 «전»에 런처를 `-DryRun` 으로 한 번 부른다**(`pwsh -NoLogo -File <memory-gate 옆 orca-worker-seat.ps1> -Role … -Worktree … [명시 인자만] -DryRun`). 종료코드가 0 이 아니면 `CLOSED_ENGINE_PROFILE_UNRESOLVED` 로 끝낸다(상태 파일 `status=closed` · 측정 시작 없음). 이유(N11): 측정은 최대 수 분인데, 측정이 끝난 **뒤에** 좌석이 등록부를 못 읽어 BLOCKED 되면 게이트는 `OPEN_SEAT_LAUNCHED` 를 적는 «거짓 정상»이 된다.
- DryRun 호출은 `.cmd` 래퍼(`-NoExit`)가 아니라 **`.ps1` 을 직접** 부른다(래퍼는 창이 남는다). 경로는 `Join-Path $PSScriptRoot 'orca-worker-seat.ps1'` — memory-gate 와 런처가 같은 관제실 폴더에 있다는 사실에 기댄다(런처도 `$PSScriptRoot` 로 자기 옆 파일을 찾는 관례를 이미 쓴다). 실제 좌석 기동 명령(`orca-worker-seat.cmd`)은 그대로다.

## 3. 순서와 정직 한계

- ⛔**런처 → memory-gate 순.** 새 memory-gate 는 `-Engine` 을 넘기지 않으므로, 옛 런처(`:57` 리터럴)에 닿으면 REVIEW/PM 이 **codex 로 뜬다**. 또 옛 런처에는 `-DryRun` 이 없어 선확인이 «알 수 없는 매개변수» 로 실패해 게이트가 **닫힌 채로 남는다**(안전 방향이지만 그날 배달이 막힌다).
- **선확인과 실제 기동 사이의 틈**: 선확인이 통과한 뒤 측정(수 분) 중에 등록부가 바뀌면 실제 기동은 다른 값으로 뜰 수 있다 — 런처가 기동 순간에 다시 읽으므로 «읽을 수 없게 된» 경우는 BLOCKED 로 막히지만 «다른 값으로 읽힌» 경우는 막히지 않는다.
- 이 게이트는 «관례 수준 스크립트»다(원본 머리말) — 상태 파일을 읽는 장치는 F-2 이전에는 없다.
- 시험: memory-gate 의 측정 전 선확인은 **Windows 에서만** 합성 구동한다(상태 파일 기록이 `Get-CimInstance` · `Get-Counter` 를 쓴다). 그 밖에서는 정적 단언(순서 · 비지 않은 인자 · 판정 문구)만 돈다.

## 4. §패치 단위 (기계 추출 대상 · 5개)

### 4-1. `-Engine` 인자 추가 + `$Model` 리터럴 삭제 (원본 21행)

```control-room-patch-unit
id: hyk501-gate-param-engine
mode: replace
@@ANCHOR@@
  [string]$Model = 'claude-sonnet-5'
@@CONTENT@@
  [string]$Engine = '',
  [string]$Model = ''
@@END@@
```

### 4-2. `$Effort` 리터럴 삭제 (원본 22행)

```control-room-patch-unit
id: hyk501-gate-param-effort
mode: replace
@@ANCHOR@@
  [string]$Effort = 'high'
@@CONTENT@@
  [string]$Effort = ''
@@END@@
```

### 4-3. 로그 머리 — 빈 값이 «/» 로 찍히지 않게 (원본 102행 안)

```control-room-patch-unit
id: hyk501-gate-log-header
mode: replace
@@ANCHOR@@
role $Role · $Model/$Effort) ·
@@CONTENT@@
role $Role · model=$(if ($Model) { $Model } else { 'registry' }) effort=$(if ($Effort) { $Effort } else { 'registry' })) ·
@@END@@
```

### 4-4. 측정 «전» 런처 `-DryRun` 선확인 (원본 104행 — 첫 측정 단계 `$g = Get-GameCount` 바로 앞)

```control-room-patch-unit
id: hyk501-gate-dryrun-precheck
mode: replace
@@ANCHOR@@
$g = Get-GameCount
@@CONTENT@@
# HYK-501 (조각 E · 2026-11-13): 엔진·모델·effort 는 좌석 런처가 저장소 등록부에서 정한다(이 게이트는 해석하지 않는다).
# 측정(최대 수 분) «뒤»에 좌석이 등록부를 못 읽어 BLOCKED 되면 이 게이트는 OPEN_SEAT_LAUNCHED 를 적는 «거짓 정상»이 되므로,
# 측정 «전»에 런처를 -DryRun 으로 한 번 불러 해석이 되는지 먼저 본다. 런처에는 비지 않은 인자만 넘긴다.
$seatOptArr = @()
if ($Engine) { $seatOptArr += @('-Engine', $Engine) }
if ($Model) { $seatOptArr += @('-Model', $Model) }
if ($Effort) { $seatOptArr += @('-Effort', $Effort) }
$seatLauncherPs1 = Join-Path $PSScriptRoot 'orca-worker-seat.ps1'
try {
  $seatDryOut = & pwsh -NoLogo -File $seatLauncherPs1 -Role $Role -Worktree $WT @seatOptArr -DryRun 2>&1
  $seatDryRc = $LASTEXITCODE
} catch {
  $seatDryOut = $_.Exception.Message
  $seatDryRc = -1
}
$seatDryText = ($seatDryOut | Out-String).TrimEnd()
Add-Content -Path $OUT -Value "seat-dryrun rc=$seatDryRc`n$seatDryText"
Write-Host $seatDryText
if ($seatDryRc -ne 0) { Finish "CLOSED_ENGINE_PROFILE_UNRESOLVED rc=$seatDryRc (seat launcher -DryRun could not resolve engine/model/effort from the registry -- no measurement started, no seat launched)" 'closed' $null }
$g = Get-GameCount
@@END@@
```

### 4-5. 실제 기동 명령 — 비지 않은 인자만 (원본 209~210행)

```control-room-patch-unit
id: hyk501-gate-launch-args
mode: replace
@@ANCHOR@@
Log "GATE=OPEN mode=$($script:MODE) -- launching $Role seat via canonical launcher orca-worker-seat.ps1 ($Model / $Effort)"
$cmd = '& "D:\문서관리\하네스-관제실\orca-worker-seat.cmd" -Role ' + $Role + ' -Worktree "' + $WT + '" -Engine claude -Model ' + $Model + ' -Effort ' + $Effort
@@CONTENT@@
Log "GATE=OPEN mode=$($script:MODE) -- launching $Role seat via canonical launcher orca-worker-seat.ps1 (explicit args only: $($seatOptArr -join ' '); anything not given is resolved by the launcher from the registry)"
$cmd = '& "D:\문서관리\하네스-관제실\orca-worker-seat.cmd" -Role ' + $Role + ' -Worktree "' + $WT + '"'
if ($seatOptArr.Count -gt 0) { $cmd += ' ' + ($seatOptArr -join ' ') }
@@END@@
```

## 5. §E2 적용 절차 (런처 적용 «후»)

⛔**런처가 적용돼 있고 `-DryRun` 4역할이 통과한 뒤에만.** 같은 형식의 절차다(전체 설명은 `HYK-501-registry-consume.md` §4).

⛔**실행 폴더**: **1번의 `node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/…` 만 상대 경로**이므로 **이 저장소(하네스)의 «master 워크트리 루트»에서 친다**(`HYK-501-registry-consume.md` §4 와 같은 워크트리) — 관제실 폴더 `D:\문서관리\하네스-관제실` 에는 `scripts\` 가 없어(2026-11-13 폴더 목록 실측) 거기서 치면 도구를 찾지 못한다. 나머지 명령(0번 · 2번부터 5번까지)은 전부 절대 경로라 어느 폴더에서 쳐도 같다. 라이브 파일과 `.tmp\` 는 `D:\문서관리\하네스-관제실` 안에 있다(읽고 교체할 대상이지 «실행 폴더» 가 아니다). 5번의 `$wt` 도 같은 master 워크트리 경로다. 0~5번은 **같은 pwsh 세션**에서 순서대로 친다. 2번은 `$errs` 가 없는 새 셸에서 그 줄만 쳐도 거짓 `0` 이 나오지 않도록 `$errs` 를 스스로 비운다.

```
# 0. 적용 «전» 라이브 SHA-256 = before
(Get-FileHash 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Algorithm SHA256).Hash.ToLower()
#   기대값: 17219bdc58150c9e3771079c9d601d3c2a9a25764b7872f67fa2f20ecf1ade51

# 1. 적용본을 라이브가 아닌 곳에 만든다
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-501-registry-consume-memory-gate.md --source "D:\문서관리\하네스-관제실\memory-gate.ps1" --out "D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk501-applied.ps1"
(Get-FileHash 'D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk501-applied.ps1' -Algorithm SHA256).Hash.ToLower()
#   기대값: c9db5cd91f7232d5c77f548b8df18700d10dfc3b199ebd85b124bcb3d98b99b9

# 2. 파싱 검사 (오류 0 -- 앞의 `$errs = $null;` 이 없으면 새 셸에서 [ref]$errs 가 «존재하지 않는 변수» 오류로 ParseFile 을 건너뛰고도 마지막 `$errs.Count` 가 거짓 `0` 을 찍는다. 실행 결과에 빨간 오류가 함께 보이면 0 이어도 통과가 아니다)
$errs = $null; [System.Management.Automation.Language.Parser]::ParseFile('D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk501-applied.ps1', [ref]$null, [ref]$errs) | Out-Null; $errs.Count

# 3. 라이브 교체 (되돌림 사본 먼저)
Copy-Item 'D:\문서관리\하네스-관제실\memory-gate.ps1' 'D:\문서관리\하네스-관제실\.tmp\memory-gate.before.ps1'
Copy-Item 'D:\문서관리\하네스-관제실\.tmp\memory-gate.hyk501-applied.ps1' 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Force
(Get-FileHash 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Algorithm SHA256).Hash.ToLower()   # 기대값 = 위 적용본 SHA-256

# 4. 리터럴 자리 확인 (적용 후 0줄)
rg -n "claude-sonnet-5|gpt-5\.6-|\"medium\"|\"codex\" \} else|-Engine claude" D:\문서관리\하네스-관제실\orca-worker-seat.ps1 D:\문서관리\하네스-관제실\memory-gate.ps1

# 5. 적용 «후» 게이트 자체 확인 -- 새 스위치 없이 적용본이 이미 가진 -DryRun · -LogPath · -StatePath · -HistoryPath 만 쓴다.
#    -DryRun 은 좌석을 절대 띄우지 않는다. 로그·상태·이력은 스크래치 폴더로 보내 라이브 watch\ 상태 파일과 이력을 건드리지 않는다.
$s = 'D:\문서관리\하네스-관제실\.tmp\gate-selfcheck'; New-Item -ItemType Directory -Force $s | Out-Null
$wt = '<등록부가 origin/master 와 같은 master 워크트리>'
# 5-a. 음성(몇 초): 등록부 JSON 을 깨뜨린 임시 워크트리 -- 측정 «전»에 닫혀야 한다
pwsh -NoLogo -File 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Round e2-selfcheck-neg -Worktree '<등록부 JSON 을 깨뜨린 임시 워크트리>' -Role CODER -Title e2-selfcheck -OrchHandle e2-selfcheck -LogPath "$s\neg.log" -StatePath "$s\neg-state.json" -HistoryPath "$s\neg-history.jsonl" -DryRun; "rc=$LASTEXITCODE"
#   볼 것: 화면과 neg.log 에 seat-dryrun rc=3 + VERDICT=CLOSED_ENGINE_PROFILE_UNRESOLVED rc=3 · neg.log 에 mode= / ALIGN= / step1 줄이 «없다» · neg-state.json 의 status=closed + dry_run=true · 마지막 rc=0 (게이트는 판정과 무관하게 exit 0)
# 5-b. 양성: 등록부가 origin/master 와 같은 워크트리 -- 런처 선확인이 통과해 측정으로 들어가야 한다
pwsh -NoLogo -File 'D:\문서관리\하네스-관제실\memory-gate.ps1' -Round e2-selfcheck-pos -Worktree $wt -Role CODER -Title e2-selfcheck -OrchHandle e2-selfcheck -LogPath "$s\pos.log" -StatePath "$s\pos-state.json" -HistoryPath "$s\pos-history.jsonl" -DryRun; "rc=$LASTEXITCODE"
#   볼 것: pos.log 에 seat-dryrun rc=0 + [CODER seat] engine-profile: ... match=yes + DRYRUN rc=0 가 먼저 나오고 CLOSED_ENGINE_PROFILE_UNRESOLVED 는 «없다».
#   그 뒤는 실제 측정이라 수 분 걸리고 메모리·게임 사정에 따라 DRYRUN_WOULD_OPEN 이나 CLOSED_* 로 끝난다 -- 합격 기준은 위 «선확인 통과» 줄이지 OPEN 이 아니다. 위 줄을 보았으면 Ctrl+C 로 끊어도 된다(스크래치 파일만 남는다).
```

**되돌림** = `.tmp\memory-gate.before.ps1` 를 라이브 경로에 복사하고 SHA-256 이 `17219bdc…ade51` 인지 확인한다.
적용 뒤 첫 실기동(`-Model` 손 명시 없이 배달한 CODER 1회)의 좌석 화면 `engine-profile:` 1줄과 좌석 등록부 행의 `model` 이 등록부 값인지 본다.
**5번(게이트 자체 확인)이 보는 것 / 못 보는 것**: 보는 것 = 적용된 라이브 게이트가 측정 «전»에 라이브 런처를 `-DryRun` 으로 불러 결과를 판정에 쓰는 배선(음성은 측정 없이 닫힘 · 양성은 측정으로 진입). 못 보는 것 = 실제 좌석 기동(`orca terminal create`)과 선확인 뒤 등록부가 바뀌는 틈(§3) — 그건 위 «첫 실기동» 확인의 몫이다. 같은 음성 경로를 저장소 시험이 합성으로 구동한다(`control-room-patch-apply-hyk501-effect.test.mjs` 의 N11 · 런처는 스텁) — 이 시험은 라이브 게이트를 열지 않으므로 5번을 대신하지 못한다.
