# HYK-402 S2 — `dispatch-worker.ps1` 배달 순간 역할 결속 «기록만» 패치 문면

## 적용 상태: ⛔**미적용(NOT APPLIED)** — 이 문서는 «칠 줄»을 적어 둘 뿐이다

이 문서는 S1 패치 문서(`HYK-402-seat-role-bind-s1.md`)의 «거부 → exit 11» 문면을 **대신한다**(판정 2026-11-18 08:38 ⑤ = «기록만 먼저»). **S2 저장소 라운드는 관제실 파일을 한 글자도 건드리지 않았다.** 적용은 **S7 = ORCH**(검토 뒤 · 적용 전 백업 · 적용 뒤 첫 실 배달 1회에서 영수증 새 칸 확인)이며, 적용 전에는 **살아 있는 배달이 하나도 바뀌지 않는다.**

앵커 행번호는 관제실 `dispatch-worker.ps1` 을 읽기만 해서 잰 값이다 — 적용 때 다시 잰다. **줄 수 = 839줄**(2026-11-19 재측정 · 측정 방식: `[IO.File]::ReadAllLines` 의 줄 수 = LF 바이트 수 = 839, sha256 앞 12자 `7CD6785ED932`, 파일 수정 시각 2026-10-04 — 같은 값을 S1 문서가 2026-11-17 에 적었다). 이 문서의 초판 표기 «798줄» 은 **빈 줄을 뺀 줄 수**(Trim 뒤 빈 줄 제외 = 798)였고 전체 줄 수가 아니다 — 파일이 줄었던 것이 아니다. 앵커 행 631 · 413 은 2026-11-19 재측정에서도 같다.

| 앵커(줄 전체)                                                                    | 행(2026-11-18) | 이 문서의 편집                                      |
| -------------------------------------------------------------------------------- | -------------- | --------------------------------------------------- |
| `Write-Host "[2/3] 배정 기록 생성 (dispatch)"` (열 0 · 줄 전체가 이 문자열인 행) | 631            | 편집 A: 이 줄 **바로 앞**에 기록용 블록 삽입        |
| `Record-DispatchReceipt` 안 `$cliArgs = @($cliPath, …)` 줄                       | 413            | 편집 B: 이 줄 **바로 뒤**에 새 인자 3개 조건부 추가 |

(S1 문서의 편집 ①(`$listRaw`)은 **필요 없다** — 이 블록은 이미 파싱된 `$list` 를 `ConvertTo-Json` 으로 파일에 다시 쓴다. `terminal list` 호출은 **한 번도 늘지 않는다** · 120행은 무접촉.)

## 이 패치가 «하지 않는 것» (⛔ 한 줄이라도 있으면 이 문서의 위반)

- `exit` · `throw` · `Write-Error` **0** — 어떤 판정도 · 어떤 실패도 배달을 멈추지 않는다.
- 좌석 교체 **0** — 기존 [1/3] 선별(`$seat` · `$handle`)은 한 글자도 바꾸지 않는다. 이 블록은 «고른 좌석»을 **판정만** 한다.
- 영수증 기록 거부 **0** — 영수증 CLI 의 새 인자는 어떤 값이어도 줄을 남긴다(값이 `--` 로 시작해도 — 아래 «부품 계약»). 기존 `--bound-seat-role`(거부 동작)은 **이 패치가 쓰지 않는다**(차단 전환 때 재사용 여부는 별도 판정).
- 임시 목록 파일(`$seatBindListPath`)은 블록 끝에서 **지운다**(S2 후속 정리). 지우기가 실패해도 배달은 그대로다 — `try/catch` 로 `TEMP_LIST_DELETE_FAILED` 한 줄만 화면에 남기고(판정 변수 무변), 파일은 남는다.
- 관제실 절대 경로 박기 **0** — 등록부는 `$PSScriptRoot` 곁의 `seat-launch-registry.jsonl`, CLI 는 `$Worktree` 상대 경로.

## 부품 계약 (이 라운드 실측)

- `scripts/relay/seat-role-bind-cli.mjs --record-only --terminal-list <json> --worktree <W> --role <R> --registry-path <jsonl> [--handle <h>] [--delivered-at-ms <n>]`
  - **종료코드 언제나 0**(깨진 입력 · 예외도 0). stdout 한 줄 JSON: `{"seat_bind":{"verdict":…,"reason":…,"candidates":…,…}}`.
  - `--delivered-at-ms` 를 안 주면 호출 시각(= 배달 직전) — 그 시각 **뒤**에 찍힌 등록은 «아직 등록 안 됨».
- `scripts/relay/dispatch-receipt-cli.mjs` 새 선택 인자 `--seat-bind-verdict` · `--seat-bind-reason` · `--seat-bind-candidates` → 영수증 새 칸 `seat_bind_verdict` · `seat_bind_reason` · `seat_bind_candidates`. **세 인자가 전부 없으면 지금과 바이트 같은 영수증.** 판정값이 4종이 아니거나 비어도 거부하지 않고 `ERROR` 로 기록한다.
  - **`--` 로 시작하는 값**: 이 세 인자의 값 자리에 온 토큰이 **알려진 플래그 이름**(이 CLI 가 아는 `--…` 인자 · `--help`)이 아니면 그 토큰은 «값» 이다(예: `--seat-bind-reason --odd` → 사유 `--odd`). 알려진 플래그 이름이면 값이 빠진 것으로 보고(빈 값 → 판정값이면 `ERROR/SEAT_BIND_VERDICT_MISSING`) 그 토큰은 다음 인자로 읽는다. 알려진 이름과 같은 값은 `--seat-bind-reason=<값>` 모양으로만 넘길 수 있다. 이 예외는 **세 인자에만** 있다 — 다른 모르는 `--…` 인자는 지금처럼 거부한다.
  - **`ERROR` 칸의 사유 겹침**: 판정값이 인식되지 않거나 빠져 영수증 CLI 가 `ERROR` 로 바꾼 칸에는 원인 사유(`UNRECOGNIZED_VERDICT_<값>` · `SEAT_BIND_VERDICT_MISSING`)가 **먼저** 오고, 호출자가 `--seat-bind-reason` 을 같이 줬으면 `;given=<받은 사유>` 로 뒤에 보존한다(전체 120자 상한). 예전에는 받은 사유가 원인 사유를 덮어 `ERROR/ROLE_MATCH` 같은 거짓 조합이 됐다. 판정값이 4종이면 받은 사유가 그대로다(겹침 없음).

### 판정 4종 (영수증 `seat_bind_verdict`)

| 판정          | 뜻                                                    | 사유 칸(`seat_bind_reason`) 예                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCH`       | S1 선별이 이 배달을 받아들였다(등록 역할 = 요청 역할) | `ROLE_MATCH`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MISMATCH`    | 양의 증거로 어긋남                                    | `ROLE_MISMATCH` · `HANDLE_ROLE_MISMATCH` · `MULTI_AGENT_SEAT_IN_WORKTREE`(역할은 맞을 수 있으나 «한 워크트리 1 에이전트 좌석» 불변식이 깨짐 — 사유 칸으로 가른다)                                                                                                                                                                                                                                                                           |
| `UNDECIDABLE` | 판정할 근거가 없다 — **일치로 접지 않는다**           | `REGISTRY_EMPTY` · `REGISTRY_ABSENT` · `PANE_NOT_IN_REGISTRY` · `PANE_REGISTERED_AFTER_DELIVERY`(등록이 배달보다 늦음 — 읽을 수 있는 등록 시각이 모두 배달 뒤) · `PANE_LAUNCHED_AT_UNREADABLE`(그 pane 의 등록은 있으나 `launchedAt` 을 읽을 수 있는 줄이 하나도 없어 «늦다/이르다» 를 가릴 수 없음) · `UNREGISTERED_AGENT` · `NO_AGENT_SEAT` · `HANDLE_SEAT_NOT_LIVE_AGENT` · `SEAT_BIND_CLI_MISSING`(이 문서의 블록이 CLI 부재를 적은 것) |
| `ERROR`       | 판정 자체가 실패                                      | `TERMINAL_LIST_INVALID` · `INVALID_ROLE` · `REGISTRY_UNREADABLE` · `RECORD_ONLY_ARGS_*` · `BIND_CLI_TIMEOUT` · `BIND_OUTPUT_UNREADABLE` · `BIND_CALL_FAILED` · `UNRECOGNIZED_VERDICT_*`(영수증 CLI 가 4종 밖 값을 받았을 때)                                                                                                                                                                                                                |

`seat_bind_candidates` = 이 워크트리 후보 좌석을 `<paneKey>=<ROLE|UNREGISTERED|NON_AGENT>/<STATE>` 로 쉼표로 이은 문자열(사람 눈 확인용 · 판정에 안 쓰임).

## 편집 A — 배달 순간 판정 블록 (`[2/3]` 줄 바로 앞에 삽입)

앵커(이 줄 **바로 앞**에 아래 블록을 넣는다):

```powershell
Write-Host "[2/3] 배정 기록 생성 (dispatch)"
```

삽입 블록:

```powershell
# ── HYK-402 S2 (기록만): 배달 순간 역할 결속 판정 -- 배달 결과 무변(exit · 좌석 교체 · 배달 중단 0) ──
$script:seatBindVerdict = "ERROR"
$script:seatBindReason = "BIND_BLOCK_NOT_COMPLETED"
$script:seatBindCandidates = ""
$seatBindListPath = $null
try {
  $seatBindCliPath = Join-Path $Worktree "scripts/relay/seat-role-bind-cli.mjs"
  if (-not (Test-Path -LiteralPath $seatBindCliPath)) {
    # CLI 부재 = 판정할 수 없음으로 «기록» 후 계속한다(HYK-472 식 fail-closed 가 아니다 -- 기록 단계).
    $script:seatBindVerdict = "UNDECIDABLE"
    $script:seatBindReason = "SEAT_BIND_CLI_MISSING"
  }
  else {
    # 임시 폴더는 «플랫폼 중립» .NET 호출로 얻는다 -- `$env:TEMP` 는 Linux pwsh 에서 비어 있어 Join-Path 가 던진다(PR 383 CI 빨강 · BIND_CALL_FAILED).
    $seatBindListPath = Join-Path ([System.IO.Path]::GetTempPath()) "hyk402-seat-bind-$Task-terminal-list.json"
    Set-Content -LiteralPath $seatBindListPath -Value ($list | ConvertTo-Json -Depth 10 -Compress) -Encoding utf8
    $seatBindRegistryPath = Join-Path $PSScriptRoot "seat-launch-registry.jsonl"
    $seatBindArgs = @($seatBindCliPath, "--record-only", "--terminal-list", $seatBindListPath, "--worktree", $Worktree, "--role", $Role, "--registry-path", $seatBindRegistryPath, "--handle", $handle)
    $seatBindJob = Start-Job -ScriptBlock { param($a) & node @a 2>&1 } -ArgumentList (, $seatBindArgs)
    if (Wait-Job -Job $seatBindJob -Timeout 20) {
      $seatBindLine = @(@(Receive-Job -Job $seatBindJob) | ForEach-Object { "$_" } | Where-Object { $_ -like '{"seat_bind":*' }) | Select-Object -Last 1
      $seatBindObj = $null
      if ($seatBindLine) { $seatBindObj = ($seatBindLine | ConvertFrom-Json).seat_bind }
      if ($seatBindObj -and $seatBindObj.verdict) {
        $script:seatBindVerdict = [string]$seatBindObj.verdict
        $script:seatBindReason = [string]$seatBindObj.reason
        $script:seatBindCandidates = [string]$seatBindObj.candidates
      }
      else {
        $script:seatBindVerdict = "ERROR"
        $script:seatBindReason = "BIND_OUTPUT_UNREADABLE"
      }
    }
    else {
      # 시간 상한(20초) 초과 -- 기록 후 계속.
      $script:seatBindVerdict = "ERROR"
      $script:seatBindReason = "BIND_CLI_TIMEOUT"
      Stop-Job -Job $seatBindJob
    }
    Remove-Job -Job $seatBindJob -Force
  }
}
catch {
  $script:seatBindVerdict = "ERROR"
  $script:seatBindReason = "BIND_CALL_FAILED"
}
# 임시 목록 파일 정리 -- 블록 끝에서 한 번(호출이 중간에 실패한 경로도 덮는다). 삭제 실패는 «기록만»:
# 판정 변수를 건드리지 않고 배달을 막지 않는다(파일이 남을 뿐).
try {
  if ($seatBindListPath -and (Test-Path -LiteralPath $seatBindListPath)) {
    Remove-Item -LiteralPath $seatBindListPath -Force -ErrorAction Stop
  }
}
catch {
  Write-Host "      [HYK-402 기록만] TEMP_LIST_DELETE_FAILED(임시 목록 파일 삭제 실패 -- 배달 무변 · 파일만 남음): $($_.Exception.Message)"
}
Write-Host "      [HYK-402 기록만] seat_bind=$($script:seatBindVerdict) reason=$($script:seatBindReason) -- 배달 결과 무변"
```

## 편집 B — 영수증 호출에 새 인자 조건부 추가 (`Record-DispatchReceipt` 안 `$cliArgs` 줄 바로 뒤)

앵커(이 줄 **바로 뒤**에 아래 블록을 넣는다):

```powershell
  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath, "--harness-dir", (Join-Path $Worktree ".harness"))
```

삽입 블록:

```powershell
  # HYK-402 S2 (기록만): 판정을 영수증 새 칸으로 넘긴다. 새 인자를 모르는 «옛» 영수증 CLI 에는 넘기지 않는다
  # (옛 CLI 는 모르는 인자에 영수증을 거부한다 -- 배달 무변 원칙 위반이 되므로 칸 없이 기록하고 계속한다).
  if ($script:seatBindVerdict) {
    $seatBindReceiptCliKnows = $false
    try { $seatBindReceiptCliKnows = [bool](Select-String -LiteralPath $cliPath -SimpleMatch -Pattern "--seat-bind-verdict" -Quiet) } catch { $seatBindReceiptCliKnows = $false }
    if ($seatBindReceiptCliKnows) {
      $cliArgs += @("--seat-bind-verdict", $script:seatBindVerdict, "--seat-bind-reason", $script:seatBindReason)
      if ($script:seatBindCandidates) { $cliArgs += @("--seat-bind-candidates", $script:seatBindCandidates) }
    }
    else {
      Write-Host "      [HYK-402 기록만] 영수증 CLI 가 seat_bind 인자를 모른다 -- 칸 없이 기록(배달 무변)"
    }
  }
```

## 적용 순서 · 배포 위험

1. **S2 PR 병합 → 본체 ff → (열린 워크트리가 S2 이후 master 인지 확인) → S7(ORCH)이 두 편집을 적용.** 적용 전에는 아무것도 바뀌지 않는다.
2. S2 이전 base 의 워크트리에 배달해도 **배달은 계속된다**(어느 경우든 exit 0 경로 그대로). 화면 판정은 그 워크트리가 어느 base 인지에 따라 갈린다: ⓐ S1(#379) 이후 ~ S2 이전 base 의 워크트리에는 S1 판 bind CLI 가 **있고** 그 CLI 는 `--record-only` 를 모른다 → 판정 `ERROR/BIND_OUTPUT_UNREADABLE` 을 화면에 찍는다(검토 1R 합성 실행 실측). ⓑ bind CLI 자체가 없는 S1 이전 base 의 워크트리만 `UNDECIDABLE/SEAT_BIND_CLI_MISSING` 이다. 두 경우 모두 영수증 CLI 가 S1 판이면 새 인자를 몰라 영수증에는 칸이 안 생기고 «칸 없이 기록» 줄만 뜬다. ⚠️S7 첫 실 배달 확인과 `ERROR` 건수 관측 때 «S2 이전 base 의 워크트리 = `ERROR/BIND_OUTPUT_UNREADABLE` 로 찍힌다»를 알고 봐야 한다.
3. 설치기 복사 목록에 두 파일을 **넣었다**(`seat-role-bind-core.mjs` · `seat-role-bind-cli.mjs` + 짝 시험) — 설치된 워크트리에서도 판정이 CLI 부재로만 남지 않는다. 편집 A 의 `Join-Path` 한 줄은 `installer-external-path-callers.test.mjs` 가 읽는 «by-path 호출»이며 그 가드가 복사 목록 누락을 빨강으로 만든다.
4. HYK-392 의 «포인터 기록 실패 fail-open» 수리 자리와 **같은 ps1** 이다 — 두 S7 패치는 **한 번에 하나씩** 적용한다. S3(인자 계약 등재)는 이 문서의 적용 **뒤**에 병합한다(등재가 앞서면 «등재된 CLI 를 ps1 이 안 부른다»가 된다).
5. 되돌림: 편집 A·B 의 삽입 블록을 지우면 원상이다(다른 줄을 건드리지 않는다). 영수증에 이미 쓰인 새 칸은 append-only 라 남는다(읽는 쪽이 모르는 칸은 무시 — 390 그림자 대조 입력은 새 칸 이름을 읽지 않는다).

## 적용 뒤 확인 (S7 · 첫 실 배달 1회)

- 화면에 `[HYK-402 기록만] seat_bind=… reason=…` 한 줄이 뜬다.
- 영수증 줄에 `seat_bind_verdict` · `seat_bind_reason`(· `seat_bind_candidates`) 가 있다. 기존 칸 8개는 그대로다.
- 배달 결과(`dispatch id=…` · 좌석 증명 · exit 코드)가 적용 전과 같다.
- 관측 지표: **`MISMATCH` 건수(0 이어야 차단 전환 후보)** 와 **`UNDECIDABLE` 사유별 추이**(`REGISTRY_EMPTY` · `PANE_NOT_IN_REGISTRY` · `PANE_REGISTERED_AFTER_DELIVERY` 가 줄어드는가). 판정 불가는 일치가 아니다 — 차단 전환은 두 지표를 본 뒤 **한용 사전 고지 뒤** 별도 판정이다.

## 차단 전환의 선행 조건 (이 문서가 «기록만»에서 멈추는 이유)

1. **correction 키 건너뛰기 규칙 닫기** — `seat-role-bind-core.mjs` 의 `classifyReceiptBinding`(지난 영수증 집계)이 `correction*` 키가 있는 영수증을 `SKIPPED_CORRECTION` 으로 건너뛴다. 이 규칙은 **집계 전용으로 남아 있고** 배달 순간 판정(`decideSeatBindAtDelivery`)은 타지 않는다(시험으로 고정). 차단 전환 전에 이 건너뛰기의 닫기 방식을 판정받는다.
2. 관측값(불일치 0 · 판정 불가 추이).
3. 라이브 강제표면 신설이므로 한용 사전 고지.

## 정직 한계

- **이 문서는 적용되지 않았다.** 이 라운드 병합만으로는 어떤 배달도 영수증에 `seat_bind_*` 칸을 남기지 않는다(검증된 것은 «CLI 와 코어와 영수증 CLI 가 합성 입력에서 이렇게 동작하고, 패치 블록이 ps1 합성 사본에서 파서 오류 없이 돌며, 실제 CLI 에 연결된다»까지다).
- **플랫폼 가정(2026-11-18 수리 · PR 383 CI 빨강)**: 편집 A 는 원래 `Join-Path $env:TEMP …` 로 임시 파일 경로를 만들었다 — Linux pwsh 에는 `$env:TEMP` 가 없어 `Join-Path` 가 «null 경로» 로 던지고 `catch` 가 `ERROR/BIND_CALL_FAILED` 로 적었다(기록 후 계속은 설계대로). 지금은 `[System.IO.Path]::GetTempPath()`(Windows = TMP · TEMP · USERPROFILE 순 · Linux = `TMPDIR` 없으면 `/tmp`)로 바꿨다 — 편집 B 에는 같은 가정이 없다(`$env:` 변수 · 임시 폴더를 쓰지 않는다). **Linux 실행은 못 쟀다** — 시험은 Windows 에서 `$env:TEMP`·`TMP`·`TMPDIR` 을 자식 pwsh 안에서 지워 «Linux 와 같은 모양»만 흉내 낸다.
- **임시 목록 파일 정리(S2 후속 정리)**: 블록 끝의 삭제는 «이 블록이 쓴 파일 하나»만 지운다. 삭제가 실패하면(파일 잠김 · 권한 등) 파일이 남고 화면에 `TEMP_LIST_DELETE_FAILED` 한 줄뿐이다 — 쌓임을 막는 보장이 아니라 «보통 지운다» 이다. **이 정리 이전에 쌓인 파일은 지우지 않는다**(`TEMP`/`TMP` 없는 기동의 홈 루트 포함). 시험은 임시 폴더를 합성 폴더로 돌려 «남지 않음» 과 «삭제 실패 시 파일이 남고 배달은 계속됨» 을 값으로 확인했다 — Linux 실행은 못 쟀다(WSL 0).
- 관제실 **실물** `dispatch-worker.ps1` 에 이 블록을 적용해 본 적이 없다 — 합성 사본(앵커 모양만 같은 껍데기)에서만 파서·실행을 확인했다. Windows PowerShell 5.1 에서의 `Start-Job` 동작은 **못 쟀다**(시험은 이 기계에서 찾은 `pwsh` 로 돌렸다).
- `terminal list` 는 [1/3] 의 스냅샷이다(편집 A 는 그 `$list` 를 쓴다) — 그 뒤에 생긴 좌석은 보지 못한다(TOCTOU). 배달 «순간»의 것은 **등록부**(편집 A 시점에 다시 읽음)와 판정 시각뿐이다.
- 등록부는 «런처가 정상적으로 기록했을 때»만 있고 죽은 pane 을 지우지 않는다. 손으로 띄운 좌석은 미등록 → `UNDECIDABLE` 로 남는다(차단이 아니라 기록).
- ORCH 가 `-Role` 자체를 틀리게 주면 그 값으로 판정한다(gap#81 과 같은 한계). 배달기 밖에서 `orca orchestration dispatch` 를 직접 치는 경로(gap#96)는 이 결선을 우회해 **보이지 않는다**.
- `MISMATCH` 에 `MULTI_AGENT_SEAT_IN_WORKTREE` 를 넣은 것은 **S2 작성자의 분류 선택**이다(양의 증거인 «두 에이전트 좌석»을 판정 불가 소음에 묻지 않으려는 것) — 사유 칸으로 언제든 갈라 볼 수 있고, 이 분류가 틀렸다고 판정되면 코어의 매핑 표 한 줄이다.
