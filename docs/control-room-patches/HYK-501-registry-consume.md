# HYK-501 패치 문서 (조각 E) — 좌석 런처가 엔진·모델·effort 를 «리터럴 기본값» 대신 «워크트리 등록부»에서 읽는다

**상태: PROPOSED.** 이 문서는 관제실 라이브 파일을 쓰지 않는다. 적용은 **E2**(별도 상신 · S7 REVIEW · ORCH/사람 몫)다 — 이 라운드(E1)는 저장소 쪽(문서 · 고정 사본 · 시험)만 만든다. 이 워크트리는 `D:\문서관리\하네스-관제실\` 에 쓰지 않는다.

이 문서는 **두 번째 문서와 한 쌍**이다: 이 문서 = `orca-worker-seat.ps1`(런처) 패치 + E2 절차 전체 · `HYK-501-registry-consume-memory-gate.md` = `memory-gate.ps1` 패치. 도구(`control-room-patch-apply.mjs`)가 문서 하나에서 **원본 파일 하나**만 받기 때문에(앵커가 그 원본에 없으면 `ANCHOR_NOT_FOUND`) 두 파일의 패치는 문서가 둘이다(저장소의 기존 문서 전부가 «문서 1 = 원본 1» 이다).

> **대체 관계**: 이 문서는 [`HYK-153-engine-profile.md`](HYK-153-engine-profile.md) 의 **§1(런처 제안문)·§3(memory-gate 제안문)을 대체**한다. 그 §1 은 CLI 호출의 `2>$null` 로 실패 사유를 버리고 §3 은 실패 시 리터럴 폴백을 남긴다 — 둘 다 이 조각이 닫으려는 결함이다. 그 파일 본문은 이 라운드에서 한 글자도 바꾸지 않았다(적용되지 않은 «제안» 으로 이력에 남는다).

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\orca-worker-seat.ps1` · **SHA-256 `2f59d12522da51fc49a5a953f7c9e41761ca287d6956435a2e9ae20dd49be4f7`**(2026-11-13 08:3x KST 읽기 전용 · 바이트 복사) · 줄끝 **LF**(130줄 · CR 0) · BOM 없음 · 고정 사본(before) = `scripts/check/fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-before.ps1.txt`.
**적용본 SHA-256 = `6e69909429962d0953502db41c3ec584c61a1bb34667cd1492e091439810ebe9`** · 고정 사본(applied) = `…-hyk501-registry-consume-applied.ps1.txt`(도구가 만든 바이트 · 손으로 쓰지 않았다).
**memory-gate** 원본 SHA-256 `17219bdc58150c9e3771079c9d601d3c2a9a25764b7872f67fa2f20ecf1ade51` · 적용본 SHA-256 `c9db5cd91f7232d5c77f548b8df18700d10dfc3b199ebd85b124bcb3d98b99b9`(그 문서 참조).

**생성 명령**(적용본 = 도구 산출물 · 이 라운드가 실제로 친 줄):

```
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-501-registry-consume.md --source scripts/check/fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-before.ps1.txt --out scripts/check/fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-applied.ps1.txt
```

## 1. 무엇이 문제인가

라이브 런처는 엔진·모델·effort 의 **기본값을 리터럴로 들고 있다**: `:57` 역할→엔진(REVIEW/PM 은 codex, 그 외 claude) · `:107` codex 모델 · `:125` claude 모델 · `:126` effort. 그래서 ① 등록부(`scripts/check/engine-profiles.json`)가 바뀌어도 좌석은 옛 값으로 뜨고(실제로 #365 가 CODER/VERIFY 모델을 고쳐도 `-Model` 을 빼먹은 기동은 옛 모델로 뜬다) ② ORCH 가 배달마다 `-Model` 을 손으로 명시해야 하며 ③ 좌석 등록부 기록(`seat-origin-registry.mjs record`)에는 기본값으로 뜬 CODER 가 `"model":""` 로 남아 실효 모델이 원장에 없다.

## 2. 패치가 세우는 것 (계약)

런처가 `seat-preflight` 바로 뒤에서 **저장소 CLI 를 한 번** 부른다: `node scripts/check/engine-profile-cli.mjs resolve --role <R> --json`. 해석(역할 → engine/model/effort)은 저장소 CLI 한 곳이 하고, 런처는 부르기만 한다.

| 규칙                 | 내용                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 읽는 곳              | **대상 워크트리**의 등록부 파일(본체 체크아웃이 아니다 — 본체에는 등록부 자체가 없을 수 있다). 런처는 이미 `Set-Location $Worktree` 뒤 seat-preflight · 규칙 블록 · 좌석 등록부 CLI 를 그 워크트리에서 부른다 — 신뢰 경계가 새로 넓어지지 않는다.                                                                                                              |
| 신뢰 기준            | 워크트리 등록부의 git blob(`git hash-object`)을 `origin/master:scripts/check/engine-profiles.json` blob 과 대조한다. 같으면 등록부 값이 기본값이다. 다르면(브랜치 수정 · 미커밋 수정 · origin 참조가 낡음 · 참조 없음 전부) **명시 인자 `-Engine` `-Model` `-Effort` 셋이 모두 있을 때만** 띄운다. 아니면 `REGISTRY_DIVERGES_FROM_ORIGIN_MASTER` · 종료코드 3. |
| 우선순위             | **명시 인자가 필드별로 이긴다**(`-Model` 만 주면 모델만 인자 · 엔진·effort 는 등록부). 명시값이 등록부와 다르면 `WARN explicit overrides registry: <필드> <명시값> (registry <등록부값>)` 한 줄씩.                                                                                                                                                             |
| 읽기 필수            | 명시 인자 3개가 다 있어도 **등록부 읽기는 반드시 성공해야 한다**(fail-closed 상시). 지금 게이트는 늘 셋을 명시하므로, 그때 읽기를 건너뛰면 기본값 경로가 실전에서 한 번도 안 돌아 조용히 썩는다.                                                                                                                                                               |
| 엔진만 바꿀 때       | `-Engine` 이 등록부의 엔진과 다르면 `-Model` 과 `-Effort` 를 함께 명시해야 한다(`ENGINE_OVERRIDE_NEEDS_MODEL`) — 다른 엔진에 등록부의 모델 이름을 그대로 넘겨 claude 에 `gpt-…` 를 주는 사고를 막는다.                                                                                                                                                         |
| codex                | 등록부 엔진이 `codex` 면 `ENGINE_CODEX_REFUSED`(10-27 codex 신규 개시 금지). 명시 `-Engine codex` 는 `-Model` 명시가 있을 때만 통과하고, 등록부 엔진이 claude 이면 `-Effort` 도 함께 명시해야 한다(바로 위 행 `ENGINE_OVERRIDE_NEEDS_MODEL` · 시험 이름과 같다 — 한용 해제 시 경로 보존 · 기계로 막지 않는다). codex 모델 리터럴은 삭제.                       |
| env                  | `HARNESS_ENGINE_PROFILES_PATH`(시험 주입용)를 CLI 호출 «전»에 지운다 — 상속되면 조용히 다른 등록부를 읽는다. 라이브 런처는 워크트리 파일만 읽는다.                                                                                                                                                                                                             |
| 출력 1줄             | `[ROLE seat] engine-profile: engine=X(arg\|registry) model=Y(…) effort=Z(…) registry_blob=<7자> origin_blob=<7자> match=yes\|no`                                                                                                                                                                                                                               |
| `-DryRun`(새 스위치) | seat-preflight + 해석 + 출력 1줄 뒤 `DRYRUN rc=0` 로 **exit 0**. 좌석 등록부 기록 · 규칙 블록 덧붙이기 · 엔진 기동은 하지 않는다.                                                                                                                                                                                                                              |
| 좌석 등록부 기록     | 해석 «뒤»에 일어난다(원래 자리 그대로 — 해석이 파일 맨 앞으로 올라왔다). 그래서 `--model` 에 실효값이 남는다.                                                                                                                                                                                                                                                  |

**실패는 전부 «좌석 화면 1줄 + 종료코드 3»**(seat-preflight 의 `BLOCKED -- …` 꼴 · 좌석 등록부 기록 «전»에 끝난다):

| #   | 조건                                                  | 줄 머리                                                                            | 사유에 보이는 것                            |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| N1  | 워크트리에 CLI 없음(옛 워크트리)                      | `BLOCKED -- ENGINE_PROFILE_CLI_MISSING`                                            | 경로 + «워크트리를 최신 master 로 리베이스» |
| N2  | 등록부 파일 없음                                      | `BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED rc=<n> reason=…`                         | CLI stderr 원문(`CONFIG_FILE_UNREADABLE`)   |
| N3  | JSON 깨짐                                             | 위와 같음                                                                          | `CONFIG_FILE_INVALID_JSON`                  |
| N4  | 스키마 위반(빈 모델 등)                               | 위와 같음                                                                          | `CONFIG_SCHEMA_INVALID`                     |
| N5  | 역할 없음                                             | 위와 같음                                                                          | `no profile for role "<R>"`                 |
| N6  | 등록부 역할 엔진 = codex                              | `BLOCKED -- ENGINE_CODEX_REFUSED`                                                  |                                             |
| N7  | 워크트리 등록부 ≠ origin/master(명시 3개 없음)        | `BLOCKED -- REGISTRY_DIVERGES_FROM_ORIGIN_MASTER`                                  | 두 blob                                     |
| N8  | `HARNESS_ENGINE_PROFILES_PATH` 상속                   | (실패가 아니다 — 지운 뒤 워크트리 파일을 읽는다)                                   | 디코이 등록부 값은 나오지 않는다            |
| N9  | 명시 `-Engine` ≠ 등록부 엔진, `-Model`·`-Effort` 없음 | `BLOCKED -- ENGINE_OVERRIDE_NEEDS_MODEL`                                           |                                             |
| N10 | CLI 출력이 JSON 아님 · 키 빠짐 · 지원하지 않는 엔진   | `BLOCKED -- ENGINE_PROFILE_OUTPUT_INVALID`                                         | CLI stdout 원문                             |
| N11 | memory-gate 측정 후 런처 실패                         | (memory-gate 문서) 측정 «전» `-DryRun` 선확인 → `CLOSED_ENGINE_PROFILE_UNRESOLVED` |                                             |

## 3. §패치 단위 (기계 추출 대상 · 5개)

원본 줄 번호는 위 SHA 의 라이브 기준이다. 다섯 앵커는 서로 겹치지 않는다(도구가 `ANCHOR_OVERLAP` 로 검사).

### 3-1. `-DryRun` 스위치 (원본 31행)

```control-room-patch-unit
id: hyk501-seat-param-dryrun
mode: replace
@@ANCHOR@@
  [string]$Effort = ""
@@CONTENT@@
  [string]$Effort = "",
  [switch]$DryRun
@@END@@
```

### 3-2. 해석 단계 (원본 35행 seat-preflight 바로 뒤)

```control-room-patch-unit
id: hyk501-seat-resolve-registry
mode: insert_after
@@ANCHOR@@
$global:LASTEXITCODE = 1; node scripts/check/seat-preflight.mjs; if ($LASTEXITCODE -ne 0) { Write-Host "[$Role seat] BLOCKED -- 훅 대조에 실패했습니다. 좌석을 띄우지 않습니다. 위에 뜬 «고치는 명령»을 실행한 뒤 다시 기동하십시오."; exit $LASTEXITCODE }
@@CONTENT@@


# HYK-501 (조각 E · 2026-11-13): 엔진·모델·effort 기본값은 이 파일의 리터럴이 아니라 «대상 워크트리의 저장소 등록부»
# (scripts/check/engine-profiles.json)가 정한다. 해석은 저장소 CLI(engine-profile-cli.mjs resolve) 한 곳이 하고 이 런처는 부르기만 한다.
# 읽기에 실패하면 좌석을 띄우지 않는다(종료코드 3 · fail-closed). 명시 인자 3개가 다 있어도 읽기는 성공해야 한다 --
# 기본값 경로가 실전에서 한 번도 안 돌아 조용히 썩는 일을 막는다. 출처 = docs/control-room-patches/HYK-501-registry-consume.md
$profileCli = Join-Path $Worktree "scripts/check/engine-profile-cli.mjs"
if (-not (Test-Path -LiteralPath $profileCli)) {
  Write-Host "[$Role seat] BLOCKED -- ENGINE_PROFILE_CLI_MISSING ($profileCli) -- 옛 워크트리입니다. 워크트리를 최신 master 로 리베이스한 뒤 다시 기동하십시오. 좌석을 띄우지 않습니다."
  exit 3
}
# 이 env 는 시험 주입용이다 -- 상속되면 조용히 다른 등록부를 읽는다. 지운 뒤 불러서 워크트리 파일만 읽게 한다.
Remove-Item Env:HARNESS_ENGINE_PROFILES_PATH -ErrorAction SilentlyContinue
# stdout 과 stderr 를 나눠 잡는다(실패 사유는 stderr 에 있다 -- 버리지 않는다).
$global:LASTEXITCODE = 1
try {
  $profOut = & node $profileCli resolve --role $Role --json 2>&1
  $profRc = $LASTEXITCODE
} catch {
  Write-Host "[$Role seat] BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED rc=-1 reason=$($_.Exception.Message) -- 좌석을 띄우지 않습니다."
  exit 3
}
$profStdout = (@($profOut | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })) -join "`n"
$profStderr = (@($profOut | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() })) -join ' | '
if ($profRc -ne 0) {
  Write-Host "[$Role seat] BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED rc=$profRc reason=$profStderr -- 좌석을 띄우지 않습니다."
  exit 3
}
$prof = $null
try { $prof = $profStdout | ConvertFrom-Json -ErrorAction Stop } catch { $prof = $null }
if ($null -eq $prof -or [string]::IsNullOrWhiteSpace([string]$prof.engine) -or [string]::IsNullOrWhiteSpace([string]$prof.model) -or [string]::IsNullOrWhiteSpace([string]$prof.effort)) {
  Write-Host "[$Role seat] BLOCKED -- ENGINE_PROFILE_OUTPUT_INVALID (등록부 해석 출력이 engine/model/effort 를 담은 JSON 이 아닙니다: $profStdout) -- 좌석을 띄우지 않습니다."
  exit 3
}
# 신뢰 기준: 워크트리 등록부 blob 과 origin/master 의 같은 파일 blob 을 대조한다(마지막 fetch 기준 -- origin 참조가 낡으면 정상 워크트리도 갈라짐으로 보인다 = 안전 방향).
$regRel = "scripts/check/engine-profiles.json"
$global:LASTEXITCODE = 1
$wtBlobOut = & git -C $Worktree hash-object -- $regRel 2>&1
$wtBlob = if ($LASTEXITCODE -eq 0) { (@($wtBlobOut | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ }) -join '').Trim() } else { '' }
$global:LASTEXITCODE = 1
$ogBlobOut = & git -C $Worktree rev-parse "origin/master:$regRel" 2>&1
$ogBlob = if ($LASTEXITCODE -eq 0) { (@($ogBlobOut | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ }) -join '').Trim() } else { '' }
$regMatch = ($wtBlob -match '^[0-9a-f]{40,64}$') -and ($wtBlob -eq $ogBlob)
$hasEngine = -not [string]::IsNullOrWhiteSpace($Engine)
$hasModel = -not [string]::IsNullOrWhiteSpace($Model)
$hasEffort = -not [string]::IsNullOrWhiteSpace($Effort)
if (-not $regMatch -and -not ($hasEngine -and $hasModel -and $hasEffort)) {
  Write-Host "[$Role seat] BLOCKED -- REGISTRY_DIVERGES_FROM_ORIGIN_MASTER (워크트리 등록부 blob=[$wtBlob] · origin/master blob=[$ogBlob]) -- 브랜치가 등록부를 바꿨거나 origin 참조가 낡았습니다. -Engine -Model -Effort 셋을 모두 명시하거나 워크트리를 origin/master 와 맞춘 뒤 다시 기동하십시오. 좌석을 띄우지 않습니다."
  exit 3
}
# 명시 인자가 필드별로 이긴다. 엔진을 등록부와 다르게 명시했는데 모델·effort 가 비면 멈춘다(다른 엔진에 등록부의 모델을 넘기는 사고 방지).
if ($hasEngine -and $Engine -ne [string]$prof.engine -and -not ($hasModel -and $hasEffort)) {
  Write-Host "[$Role seat] BLOCKED -- ENGINE_OVERRIDE_NEEDS_MODEL (-Engine $Engine 는 등록부의 엔진 $($prof.engine) 과 다릅니다 -- 다른 엔진에 등록부의 모델·effort 를 그대로 넘기지 않도록 -Model 과 -Effort 를 함께 명시하십시오) -- 좌석을 띄우지 않습니다."
  exit 3
}
$effEngine = if ($hasEngine) { $Engine } else { [string]$prof.engine }
if ($effEngine -eq 'codex') {
  if (-not $hasEngine) {
    Write-Host "[$Role seat] BLOCKED -- ENGINE_CODEX_REFUSED (등록부의 $Role 엔진이 codex 입니다 -- codex 신규 개시는 금지입니다. 명시 -Engine codex 는 -Model 과 함께일 때만 통과합니다) -- 좌석을 띄우지 않습니다."
    exit 3
  }
  if (-not $hasModel) {
    Write-Host "[$Role seat] BLOCKED -- ENGINE_OVERRIDE_NEEDS_MODEL (명시 -Engine codex 에는 -Model 이 필요합니다 -- 모델 리터럴 기본값은 없습니다) -- 좌석을 띄우지 않습니다."
    exit 3
  }
}
if ($effEngine -notin @('claude', 'codex')) {
  Write-Host "[$Role seat] BLOCKED -- ENGINE_PROFILE_OUTPUT_INVALID (이 런처가 띄울 수 없는 엔진: $effEngine) -- 좌석을 띄우지 않습니다."
  exit 3
}
$effModel = if ($hasModel) { $Model } else { [string]$prof.model }
$effEffort = if ($hasEffort) { $Effort } else { [string]$prof.effort }
$engineSrc = if ($hasEngine) { 'arg' } else { 'registry' }
$modelSrc = if ($hasModel) { 'arg' } else { 'registry' }
$effortSrc = if ($hasEffort) { 'arg' } else { 'registry' }
$regShort = if ($wtBlob.Length -ge 7) { $wtBlob.Substring(0, 7) } else { 'none' }
$ogShort = if ($ogBlob.Length -ge 7) { $ogBlob.Substring(0, 7) } else { 'none' }
$matchWord = if ($regMatch) { 'yes' } else { 'no' }
Write-Host "[$Role seat] engine-profile: engine=$effEngine($engineSrc) model=$effModel($modelSrc) effort=$effEffort($effortSrc) registry_blob=$regShort origin_blob=$ogShort match=$matchWord"
if ($hasEngine -and $Engine -ne [string]$prof.engine) { Write-Host "[$Role seat] WARN explicit overrides registry: engine $Engine (registry $($prof.engine))" }
if ($hasModel -and $Model -ne [string]$prof.model) { Write-Host "[$Role seat] WARN explicit overrides registry: model $Model (registry $($prof.model))" }
if ($hasEffort -and $Effort -ne [string]$prof.effort) { Write-Host "[$Role seat] WARN explicit overrides registry: effort $Effort (registry $($prof.effort))" }
$Engine = $effEngine
$Model = $effModel
$Effort = $effEffort
if ($DryRun) {
  Write-Host "[$Role seat] DRYRUN rc=0 -- 해석과 출력까지만 했습니다(좌석 등록부 기록 · 규칙 블록 덧붙이기 · 엔진 기동 없음)."
  exit 0
}
@@END@@
```

### 3-3. 역할→엔진 리터럴 폴백 삭제 (원본 51~58행)

```control-room-patch-unit
id: hyk501-seat-drop-engine-default
mode: replace
@@ANCHOR@@
# HYK-472: 인자 미지정 시 옛 역할 기본값 그대로(하위호환, 값 변경 없음).
# 옛 문면(취소선 보존, B-10 안전핀): ~~env $env:HARNESS_SEAT_ENGINE로 REVIEW/PM
# 분기의 codex 기본값을 claude로 덮어썼다~~ -- `orca terminal create
# --command`를 지나며 그 env가 소실돼(HYK-472 실측 2회) 신뢰할 수 없었다.
# 이제 이 인자(-Engine)는 --command 문자열 자체의 일부라 그 경로로 안 잃는다.
if ([string]::IsNullOrWhiteSpace($Engine)) {
  $Engine = if ($Role -eq "REVIEW" -or $Role -eq "PM") { "codex" } else { "claude" }
}
@@CONTENT@@
# HYK-472: 엔진은 -Engine 인자(--command 문자열 자체의 일부)로 받는다 -- 옛 env 방식은 `orca terminal create
# --command` 를 지나며 소실돼 REVIEW 좌석이 의도와 달리 codex 로 뜬 사고가 실측 2회 났다.
# HYK-501(2026-11-13): 인자가 없을 때의 «역할→엔진 리터럴 폴백»은 이 자리에서 삭제했다. 기본값은 위 해석 단계가
# 저장소 등록부에서 정한다(읽지 못하면 좌석이 안 뜬다). 이 시점의 $Engine 은 이미 실효값이다.
@@END@@
```

### 3-4. codex 모델 리터럴 삭제 (원본 107행)

```control-room-patch-unit
id: hyk501-seat-drop-codex-model-default
mode: replace
@@ANCHOR@@
  $codexModel = if ($Model) { $Model } elseif ($Role -eq "PM") { "gpt-5.6-sol" } else { "gpt-5.6-luna" }
@@CONTENT@@
  # HYK-501: 모델 리터럴 기본값 삭제 -- 해석 단계가 codex 에는 -Model 명시를 요구한다(없으면 좌석이 안 뜬다).
  $codexModel = $Model
@@END@@
```

### 3-5. claude 모델·effort 리터럴 삭제 (원본 125~126행)

```control-room-patch-unit
id: hyk501-seat-drop-claude-defaults
mode: replace
@@ANCHOR@@
  $claudeModel = if ($Model) { $Model } else { "claude-sonnet-5" }
  $claudeEffort = if ($Effort) { $Effort } else { "medium" }
@@CONTENT@@
  # HYK-501: 리터럴 기본값 삭제 -- 위 해석 단계가 모델·effort 를 명시 인자 또는 저장소 등록부 값으로 채워 둔다.
  $claudeModel = $Model
  $claudeEffort = $Effort
@@END@@
```

## 4. §E2 적용 절차 — 사람이 그대로 칠 수 있게 (E1 이 아니다 · 별도 상신 · S7 REVIEW)

⛔**순서 = 런처 먼저, memory-gate 나중. 역순 금지.** 새 memory-gate 는 `-Engine` 을 넘기지 않으므로, 옛 런처에 닿으면 `:57` 의 역할→엔진 리터럴로 REVIEW/PM 이 **codex 로 뜬다**.
전제: PR #365(등록부 CODER/VERIFY = `claude-sonnet-5-5`)가 master 에 병합돼 있고, 적용에 쓰는 «master 워크트리» 의 등록부 blob 이 `origin/master` 와 같다(`match=yes`).

⛔**실행 폴더**: 아래 명령은 경로를 두 가지로 쓴다. **1번의 `node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/…` 만 상대 경로**이므로 **이 저장소(하네스)의 «master 워크트리 루트»(위 전제의 워크트리)에서 친다** — 관제실 폴더 `D:\문서관리\하네스-관제실` 에는 `scripts\` 가 없어(2026-11-13 폴더 목록 실측) 거기서 치면 도구를 찾지 못한다. 나머지 명령(0번 · 2번부터 5번까지)은 전부 절대 경로라 어느 폴더에서 쳐도 같다. 라이브 파일과 `.tmp\` 는 `D:\문서관리\하네스-관제실` 안에 있다(읽고 교체할 대상이지 «실행 폴더» 가 아니다). 4번의 `$wt` 도 같은 master 워크트리 경로다. 0~5번은 **같은 pwsh 세션**에서 순서대로 친다(`$wt` 가 이어진다). 2번은 `$errs` 가 없는 새 셸에서 그 줄만 쳐도 거짓 `0` 이 나오지 않도록 `$errs` 를 스스로 비운다.

```
# 0. 적용 «전» 라이브 SHA-256 = before (다르면 적용 중단 -- 라이브가 문서를 자른 뒤 바뀐 것이다)
(Get-FileHash 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Algorithm SHA256).Hash.ToLower()
#   기대값: 2f59d12522da51fc49a5a953f7c9e41761ca287d6956435a2e9ae20dd49be4f7

# 1. 적용본을 «라이브가 아닌 곳»에 만든다 (도구는 --source 를 읽기만 하고 --out 에만 쓴다)
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-501-registry-consume.md --source "D:\문서관리\하네스-관제실\orca-worker-seat.ps1" --out "D:\문서관리\하네스-관제실\.tmp\orca-worker-seat.hyk501-applied.ps1"
(Get-FileHash 'D:\문서관리\하네스-관제실\.tmp\orca-worker-seat.hyk501-applied.ps1' -Algorithm SHA256).Hash.ToLower()
#   기대값: 6e69909429962d0953502db41c3ec584c61a1bb34667cd1492e091439810ebe9   (= 저장소 applied 사본의 SHA-256. 다르면 중단)

# 2. 파싱 검사 (오류 0 이어야 한다 -- 앞의 `$errs = $null;` 이 없으면 새 셸에서 [ref]$errs 가 «존재하지 않는 변수» 오류로 ParseFile 을 건너뛰고도 마지막 `$errs.Count` 가 거짓 `0` 을 찍는다. 실행 결과에 빨간 오류가 함께 보이면 0 이어도 통과가 아니다)
$errs = $null; [System.Management.Automation.Language.Parser]::ParseFile('D:\문서관리\하네스-관제실\.tmp\orca-worker-seat.hyk501-applied.ps1', [ref]$null, [ref]$errs) | Out-Null; $errs.Count

# 3. 라이브 교체 (되돌림 사본을 먼저 보관) -- 줄끝은 LF 그대로
Copy-Item 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' 'D:\문서관리\하네스-관제실\.tmp\orca-worker-seat.before.ps1'
Copy-Item 'D:\문서관리\하네스-관제실\.tmp\orca-worker-seat.hyk501-applied.ps1' 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Force
(Get-FileHash 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Algorithm SHA256).Hash.ToLower()   # 기대값 = 위 적용본 SHA-256

# 4. 적용 «후» 칠 것 -- -DryRun 은 .cmd 래퍼(-NoExit)를 거치면 창이 남는다. pwsh 로 .ps1 을 직접 부른다.
$wt = '<등록부가 origin/master 와 같은 master 워크트리>'
foreach ($r in 'CODER','REVIEW','VERIFY','PM') { pwsh -NoLogo -File 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Role $r -Worktree $wt -DryRun; "rc=$LASTEXITCODE" }
#   볼 것: 4역할 모두 [R seat] engine-profile: engine=claude(registry) model=<등록부 값>(registry) effort=high(registry) ... match=yes  +  DRYRUN rc=0  +  rc=0
pwsh -NoLogo -File 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Role CODER -Worktree $wt -Model claude-opus-5-5 -DryRun
#   볼 것: model=claude-opus-5-5(arg) + WARN explicit overrides registry: model claude-opus-5-5 (registry <등록부 값>) 1줄 + rc=0   (명시 우선)
pwsh -NoLogo -File 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Role CODER -Worktree '<등록부 JSON 을 깨뜨린 임시 워크트리>' -DryRun; "rc=$LASTEXITCODE"
#   볼 것: BLOCKED -- ENGINE_PROFILE_RESOLVE_FAILED ... CONFIG_FILE_INVALID_JSON + rc=3   (음성 N3)
pwsh -NoLogo -File 'D:\문서관리\하네스-관제실\orca-worker-seat.ps1' -Role CODER -Worktree '<등록부를 커밋 없이 고친 임시 워크트리>' -DryRun; "rc=$LASTEXITCODE"
#   볼 것: BLOCKED -- REGISTRY_DIVERGES_FROM_ORIGIN_MASTER + rc=3   (음성 N7)

# 5. 라이브 리터럴 자리 확인 (적용 후 0줄이어야 한다)
rg -n "claude-sonnet-5|gpt-5\.6-|\"medium\"|\"codex\" \} else|-Engine claude" D:\문서관리\하네스-관제실\orca-worker-seat.ps1
```

**되돌림** = `.tmp\orca-worker-seat.before.ps1`(적용 전 라이브 바이트)를 라이브 경로에 복사하고 SHA-256 이 `2f59d125…be4f7` 인지 확인한다. 저장소의 before 사본(`…-hyk501-registry-consume-before.ps1.txt`)도 같은 바이트다.
**S7 REVIEW 축**: ① 적용 전 라이브 SHA = 이 문서의 before SHA ② 산출 SHA = applied 사본 SHA ③ 라이브 전후 diff = 패치 덩어리 5개뿐 ④ `-DryRun` 4역할 출력 = 등록부 값 ⑤ 음성 `-DryRun`(N3 · N7) 비영 ⑥ 적용 후 첫 실기동의 좌석 등록부 행 `model` = 등록부 값 ⑦ 되돌림 가능.
memory-gate 적용은 **런처 적용과 4번 확인이 끝난 뒤** `HYK-501-registry-consume-memory-gate.md` 의 절차로 한다.

## 5. ⚠️정직 — 이 패치가 «못» 하는 것

- **라이브 적용 전까지 효력이 없다.** 이 라운드(E1)는 문서 · 고정 사본 · 시험뿐이다. 라이브 `orca-worker-seat.ps1` 은 0바이트 변경이다.
- **고정 사본 시험은 라이브 드리프트를 못 잡는다.** HYK-462 의 «적용본» 사본은 라이브와 두 달째 달랐고 그 시험은 초록이었다. 그래서 E2 는 «적용 전 라이브 SHA = before · 적용 후 = applied» 문턱과 라이브 `-DryRun`(위 4번)을 **둘 다** 쓴다. 이 저장소의 시험이 라이브 파일을 여는 일은 없다.
- **origin/master 대조는 «마지막 fetch 기준»이다.** origin 참조가 낡으면 정상 워크트리도 N7 로 막힌다(안전 방향이지만 마찰). 참조가 없는 워크트리도 같다.
- **모델 축 사후 감지 장치는 이 조각이 만들지 않는다.** 좌석 등록부 `.model` 의 소비자가 없다 — 모델이 틀리게 떠도 읽는 장치가 없다. 착수 차단은 이 해석 단계의 fail-closed 가 유일한 막이다.
- **codex 금지는 명시 `-Engine codex -Model …` 경로에서 기계로 막히지 않는다**(한용 해제 경로 보존).
- **`$Worktree` 를 사람이 잘못 줄 때**(엉뚱한 워크트리)는 그 워크트리의 등록부를 읽는다 — 이 조각 밖.
- **범위 밖(남는다)**: `.claude-team` 경로(`:119`) · 배달기의 에이전트 표식 정규식 · 배달기의 낡은 주석 · `orca-worker-seat.cmd`(래퍼 · 무변) · `dispatch-worker.ps1`(변경 0 — 소비할 기본값 리터럴이 없다).
- **시험은 합성 워크트리에서만 돈다.** effect 시험의 seat-preflight 는 «항상 통과하는 스텁»이다(실 preflight 는 기계의 훅 설치 상태를 읽는다) — 해석 단계는 진짜 CLI 와 진짜 git 으로 돈다. Linux CI 의 pwsh 에서는 재지 않았다(Windows 로컬 실구동만).

## 6. §시험 — 무엇을 어떻게 고정했는가

- `scripts/check/control-room-patch-apply-hyk501-collect.test.mjs` — 두 문서의 패치 단위가 before 사본에 적용되어 applied 사본과 **바이트 동일**함 · 되돌림 왕복 · before/applied SHA 고정 · 변이 2종.
- `scripts/check/control-room-patch-apply-hyk501-literal.test.mjs` — applied 두 사본에 리터럴 5종(`claude-sonnet-5` · `gpt-5.6-` · `"medium"` · `"codex" } else` · `-Engine claude`) 0 · before 사본에는 있다(탐지기 비공허) · `2>$null` 부재 · env 삭제 줄 · 해석 단계의 위치 · memory-gate 선확인 순서(N11 정적).
- `scripts/check/control-room-patch-apply-hyk501-effect.test.mjs` — 적용본 런처를 **실 pwsh** 로 mkdtemp 합성 git 워크트리(진짜 CLI · 라이브러리 바이트 복사 + 합성 등록부 + `origin/master` 참조)에서 구동: 4역할 양성 · 명시 우선 · N1~N10 · 비-DryRun 경로의 fail-closed 와 실제 기동 인자 · memory-gate 의 측정 전 선확인(N11 합성 구동, Windows). pwsh 가 없으면 이유와 함께 시끄럽게 SKIP.
