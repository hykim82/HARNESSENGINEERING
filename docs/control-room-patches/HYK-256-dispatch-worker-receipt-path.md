# HYK-256 — `dispatch-worker.ps1` 154~224행 교체 문면 (배달-영수증 경로 결선)

## 적용 상태: **APPLIED**

이 문면은 더 이상 «제안»이 아니다 — 관제실 `dispatch-worker.ps1`에 **실제로 적용됐다.** 아래 값은 ORCH가 관제실 파일에서 직접 실측해 이 문서로 옮긴 것이다(이 워크트리는 그 파일을 읽지 않는다 — 정직 한계 절 참조).

| 항목                        | 값                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| 적용 시각                   | 2026-08-19 15:43 KST                                                                         |
| 관제실 커밋                 | `30511d4`                                                                                    |
| 백업 파일명                 | `dispatch-worker.ps1.bak-HYK256-2026-08-19T1542`                                             |
| 적용 전 파일                | SHA-256 `e99b497af232738eadb54f266b9218749c93d8a1ffcd0d9a641968a7c725b1cf` · 32,011B · 503줄 |
| 적용 후 파일                | SHA-256 `092d28ba6c1f8053cc3f8e401d6426ed5dc38cef0fcb2814e2a1dcb93136874f` · 32,965B · 514줄 |
| 교체 전 구간(154~224행)     | SHA-256 `fb11388f66725977b97ff6f2ed9313d0824f55dfdf6b1889ddee5e48762d84fb` · 5,878B          |
| 승인 문면(= 아래 펜스 블록) | SHA-256 `ca7c3a333a71cf3b9b6c6588de528510c21f4ba9d839cb25f6a85bcc478837da` · 6,832B          |
| 문면 무변경 증명            | 적용 후 그 구간을 다시 잘라낸 지문 == 승인 문면 지문(일치)                                   |
| 범위 밖 무접촉              | head(1~~153) · tail(225~~) 지문 전/후 불변                                                   |
| 전체 파일 파싱              | `PARSE_OK` 0 errors · 2,840 tokens · 백업본도 파싱 OK                                        |
| 적용 후 실측 위치           | `$ReceiptPath` 해소 블록 = 170행 · 게이트 호출 = 191행(인자 포함) · 해소 블록 중복 0         |
| REVIEW 판정                 | `HYK-256-review-1` **approved** · P1 0건 · P2 4건(아래 «남은 것» 참조)                       |

## 결함

`dispatch-worker.ps1`의 배달 전 게이트 호출(`& node $gateScript $roleTaskFile --expect-repo-root $Worktree`)에 `--dispatch-receipt-path`가 없다. `$ReceiptPath`는 그 호출보다 **뒤**(파일 마지막 블록)에서야 정해진다. 게이트(`scripts/check/dispatch-gate-decision.mjs`)는 인자 → env(`DISPATCH_RECEIPT_PATH`) → `null` 순으로 경로를 찾는데, 인자가 안 오고 env도 비면 `null`이 되어 앞 라운드 소비 확인이 dispatchId를 못 찾고 거부한다. 첫 라운드는 부트스트랩이라 통과하고, 같은 워크트리 **두 번째 라운드부터** 이 결함이 실제로 터진다(2026-08-14 실측·2026-08-19 배달 1회 실제 거부).

저장소 쪽(`--dispatch-receipt-path` 인자 파싱, `resolveDispatchReceiptPath`)은 이미 준비돼 있다 — 수리 표면은 관제실 100%다.

## 설계

ORCH 제안(§4)을 그대로 채택했다 — 더 나은 대안이 보이지 않았다:

1. `if (-not $ReceiptPath) { ... }` 해소 블록(원래 파일 마지막, "HYK-219-receipts-2 §3-ⓐ" 주석과 함께)을 게이트 호출보다 **앞**으로 옮긴다. 이 블록은 `$Role`에 의존하지 않으므로 `if ($Role -eq "PM") {...} else {...}` 분기 **앞**(가장 위)에 두면 두 분기 모두에서 무조건 실행된다 — PM 분기가 게이트를 건너뛰어도 `$ReceiptPath` 자신은 여전히 채워진다(§4 요구사항 그대로).
2. 게이트 호출 줄에 `--dispatch-receipt-path $ReceiptPath`를 추가한다.
3. 왜 이렇게 하는지 설명하는 새 주석 13줄(HYK-256 표기·계기·불변식 요약)을 옮긴 블록 맨 앞에 단다.

바뀌지 않는 줄(HYK-217/HYK-224/HYK-219-receipts-2 §1 각 블록, PM 분기 본문, admission 블록 전체)은 **문자 그대로** 다시 적었다 — 순서 재배치와 게이트 호출 한 줄 변경, 새 주석 추가 외에는 아무것도 바꾸지 않았다.

**PM 분기가 여전히 성립하는 근거**: `if ($Role -eq "PM") {...}` 블록 자체는 손대지 않았다(내부에 `$ReceiptPath` 참조가 원래도 없다 — PM은 게이트를 아예 안 부른다). `$ReceiptPath` 해소 블록이 그 분기 앞으로 옮겨졌으므로, PM 배달이든 아니든 이 스크립트가 그 지점을 지나는 순간 `$ReceiptPath`는 이미 결정돼 있다. 영수증 CLI(`dispatch-receipt-cli.mjs`) 호출은 이 발췌 범위(154~224행) 밖에서 `$ReceiptPath`를 읽는데, PM 경로도 예외 없이 그 변수를 보게 된다 — 순서만 바뀌었을 뿐 PM 분기의 조건·본문·게이트-건너뜀 동작은 한 글자도 바뀌지 않았다.

## PowerShell 파싱 검사 (출력 원문)

교체 블록을 워크트리 안 임시 파일 `.harness/tmp-hyk256-block.ps1`에 쓰고 `[System.Management.Automation.Language.Parser]::ParseFile()`로 구문 검사했다:

```
$tokens = $null; $errors = $null
$path = "C:\Users\Administrator\orca\workspaces\HARNESSENGINEERING\hyk256-receiptpath\.harness\tmp-hyk256-block.ps1"
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { "PARSE_OK: 0 errors" } else { $errors | ForEach-Object { $_.ToString() } }
```

출력:

```
PARSE_OK: 0 errors
```

원본 재구성본(`.harness/tmp-hyk256-original.ps1`, §2 원문을 그대로 옮겨 적은 것)과 교체 블록을 `diff -u`한 결과, 차이는 정확히 ⑴새 주석 13줄 추가 ⑵`$ReceiptPath` 해소 블록(주석 포함 5줄 + 코드 3줄) 위치 이동 ⑶게이트 호출 줄에 `--dispatch-receipt-path $ReceiptPath` 추가, 이 세 가지뿐이었다 — 다른 어떤 줄도 바뀌지 않았다.

## 적용 기록

- 교체 대상 = 관제실 `D:\문서관리\하네스-관제실\dispatch-worker.ps1` **154~224행** — 위 «적용 상태»표에 실측값 그대로.
- 적용 전 원본 SHA-256(파일 전체, 503줄·32,011바이트) = `e99b497af232738eadb54f266b9218749c93d8a1ffcd0d9a641968a7c725b1cf`.
- ORCH가 실행한 검증 = ⑴아래 펜스 블록을 그 154~224행에 그대로 붙여넣었는지 문면 지문(바이트) 일치 확인(**일치 확인됨**) ⑵`dispatch-worker.ps1` 전체 파일을 PowerShell 파서로 재파싱해 구문 오류 0건 확인(**PARSE_OK, 0 errors**, 백업본도 통과).

### 정직 한계

위 «적용 상태»표와 이 절의 지문·시각·커밋 값은 **ORCH가 관제실 파일에서 직접 실측해 이 문서로 옮긴 값**이다 — 이 워크트리(레인 밖 규칙에 따라 `D:\문서관리\하네스-관제실\`를 쓰지도 읽지도 않는다)의 그 어떤 자동 검사(CI)도 관제실 파일 자체를 검증하지 않는다. 이 문서가 «APPLIED»라고 적고 있다는 사실 자체는 저장소 쪽에서 기계로 재확인할 방법이 없다 — 신뢰의 근거는 ORCH의 실측 보고뿐이다.

### 남은 것 (REVIEW `HYK-256-review-1` P2 4건)

1. 관제실 파일(`dispatch-worker.ps1`) 자체는 이 저장소의 CI·PR 강제 밖이다 — 위 정직 한계 절 그대로.
2. `--admission-ledger-path`도 같은 모양의 결함(값이 게이트 호출보다 늦게 정해진다)을 갖고 있는 것으로 보인다. 다만 이 축은 `labelInfo.kind === "MISSING"`(비정상 중단 라운드)에서만 도달해 receipt-path보다 영향 범위가 좁다. 별도 이슈 등재는 책임자 몫이다.
3. `scripts/check/dispatch-gate-receipt-path-wire.test.mjs`의 ⓐ GREEN 시험은 dispatchId 문자열 자체를 stdout으로 단언하지 못한다(`consumption-receipt-core.mjs`의 PASS→null 어댑터 계약상 ALLOW 경로가 그 값을 echo하지 않는다) — 대신 "있으면 ALLOW·지우면 REJECT" 인과쌍으로 같은 사실을 증명했다.
4. (해소됨) STATUS 행 갱신 — ORCH 정정으로 이미 처리됨.

## 교체 문면

<!-- HYK-256-REPLACEMENT-BEGIN -->

```powershell
# HYK-256(2026-08-19): dispatch-worker.ps1 154~224행 결함 수리 -- 배달 전
# 게이트 호출(아래 & node $gateScript ...)에 --dispatch-receipt-path가
# 없었고, $ReceiptPath는 그 호출보다 «뒤»에서야 정해졌다(같은 워크트리
# 두 번째 라운드부터 게이트가 dispatchId를 못 찾아 거부, 2026-08-14
# 실측·2026-08-19 실제 거부 1건). 이 블록(원래 아래쪽 "HYK-219-receipts-2
# §3-ⓐ" 주석+분기)을 게이트 호출보다 앞으로 옮기고, 그 호출에
# --dispatch-receipt-path $ReceiptPath를 추가한다 -- «영수증을 기록하는
# 경로»와 «게이트가 소비를 확인하는 경로»가 항상 같은 값을 보게 만드는
# 불변식 하나를 세운다. PM 분기는 게이트 자체를 건너뛰지만 $ReceiptPath
# 자신은 이 블록이 위로 올라오면서 무조건(분기 밖) 채워지므로 그대로
# 성립한다.
# HYK-219-receipts-2 §3-ⓐ (1R ORCH 실측: 이 값을 아무도 안 주면 배달이
# 전건 실패했다): 인자·env 둘 다 없으면 이 스크립트 자신이 놓인 위치
# 기준 기본 경로로 떨어진다 — 저장소 안에는 이 경로가 전혀 없으므로
# "절대경로 하드코딩 금지"에 걸릴 대상 자체가 없다. $PSScriptRoot는
# 설치마다 달라지는 런타임 값이지 고정 리터럴이 아니다.
if (-not $ReceiptPath) {
  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }
}

# HYK-217(2026-08-10 병합 master 68560cf): 배달 전 게이트 확인 — fail-closed.
# 계기 = 2026-08-10 실사고: 진단 게이트가 exit 2(불통과)를 냈는데 ORCH가 게이트 검사와
# 배달을 한 명령에 묶어 실행해 "불통과인데도 배달이 나갔다". 그때 방어는 "ORCH가 순서를
# 지킨다"는 약속뿐이었고 기계 앵커가 0이었다 → 배달 도구가 스스로 확인하게 만든다.
# 판단은 저장소 안(scripts/check/dispatch-gate-decision.mjs), 여기는 얇은 껍데기다
# (관제실은 CI 대상이 아니라 판단 로직을 두면 CI가 실제 수리 지점을 못 덮는다).
# ⚠️ 스크립트가 없으면 "생략"이 아니라 "거부"다(HYK-217 1R 반려 사유). 열린 구멍은
# docs/enforcement-known-gaps.md gap#96(직접 주입)·gap#97·gap#98 참조.
if ($Role -eq "PM") {
  Write-Host "[1.5/3] PM 배달: 1-B 게이트 건너뜀(HYK-241 3R 실측 -- PM 지시서(D:\문서관리\하네스-관제실\PM\relay\pm-task.md)는 관제실 자체 git 저장소에 있어, --expect-repo-root 대조가 항상 저장소 불일치로 거부하고 대조를 빼도 그 저장소엔 .harness/reject-streak.json이 없어 거부된다 -- ALLOW 도달 경로가 없음을 직접 실행해 확인함. 저장소 코드 변경 없이는 PM을 커버할 수 없다(다음 트랙 과제 = HYK-245)."
} else {
  $gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"
  $roleTaskFile = Join-Path $Worktree (".harness/" + $Role.ToLower() + "-task.md")
  if (-not (Test-Path $gateScript)) {
    Write-Error "GATE_REJECTED: gate script missing ($gateScript) -- 이 워크트리에는 아직 HYK-217 게이트가 없다. scripts/check/dispatch-gate-decision.mjs 를 포함한 브랜치(master 68560cf 이후)로 갱신한 뒤 재시도하라."
  }
  Write-Host "[1.5/3] 배달 전 게이트 확인 (HYK-217)"
  & node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath
  if ($LASTEXITCODE -ne 0) {
    Write-Error "GATE_REJECTED: 위 사유로 배달을 거부합니다(HYK-217 기계 게이트). 원인을 해소한 뒤 재시도하세요."
  }
}

$label = if ($GoLabel) { $GoLabel } else { $Task }

# HYK-224 (coder-task.md §1/§3, PM 항 4 TOCTOU): 배달 전 «원자 입장» 확인 --
# fail-closed. 판단(원장 판정)은 전부 저장소 안
# scripts/supervisor/admission-cli.mjs 몫이다(§4 "판단은 저장소, 관제실은
# 얇은 껍데기"). 이 블록은 그 CLI를 부르고 종료코드로만 분기한다.
# 원장/락 파일은 관제실 소유(전역 상태, 워크트리별이 아니다) -- 이
# 워크트리의 concurrency-cap.json을 --cap-path로 넘겨 상한값 자체는
# 여전히 저장소 커밋값이 권위다(HYK-193 S-5, 값 하드코딩 금지).
$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"
if (-not (Test-Path $admissionCliPath)) {
  Write-Error "ADMISSION_CLI_MISSING: $admissionCliPath 가 없다 -- HYK-224 원자 입장 게이트를 확인할 수 없으므로 dispatch를 만들지 않는다(fail-closed). 이 CLI를 포함한 브랜치로 워크트리를 갱신한 뒤 재시도하라."
}
$admissionLedgerPath = Join-Path $PSScriptRoot "admission-ledger.json"
$admissionLockPath = Join-Path $PSScriptRoot "admission-ledger.lock"
$capPath = Join-Path $Worktree "scripts/supervisor/concurrency-cap.json"
# HYK-224-2R §2 (REVIEW 1R 반려): seat_key로 $handle(orca terminal handle)을
# 넘기지 않는다 -- 오늘만 2회 관측된 «핸들 회전»에 그대로 노출돼, 같은
# 물리 좌석이 회전 후 다른 핸들로 나타나면 sweep의 ground truth(향후 호출자가
# 채울 liveSeatKeys)와 더 이상 일치하지 않아 «영구 미회수»가 재발한다.
# HYK-224-3R §2 (REVIEW 2R 반려): $target(정규화 워크트리 경로)도 안 된다 --
# 유일하지 않다(위 $paneKey 주석 참고). $paneKey를 쓴다.
Write-Host "[1.6/3] 동시 상한 원자 입장 확인 (HYK-224)"
$admissionOut = & node $admissionCliPath admit --ledger $admissionLedgerPath --lock $admissionLockPath --reservation-id $label --cap-path $capPath --role $Role --seat-key $paneKey 2>&1
$admissionExit = $LASTEXITCODE
Write-Host "      $admissionOut"
if ($admissionExit -ne 0) {
  Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."
}

# HYK-219-receipts-2 §1 (1R P1 반려 "반쪽 배달" 대응): 영수증 CLI가 이
# 워크트리에 없으면 dispatch 자체를 만들지 않는다 — 아래 존재 확인만
# ps1에 남는다(부트스트랩 문제: CLI가 없으면 그 CLI에게 "있냐"고 물어볼
# 수 없다). 이 확인 이후의 모든 판단(형식·필수 필드·기록·실패 사유)은
# 전부 저장소 CLI 몫이다(§1 문면 그대로, 늘리지 않았다).
$receiptCliPath = Join-Path $Worktree "scripts/relay/dispatch-receipt-cli.mjs"
if (-not (Test-Path $receiptCliPath)) {
  Write-Error "RECEIPT_CLI_MISSING: $receiptCliPath 가 없다 -- 영수증을 남길 수 없으므로 dispatch를 만들지 않는다(HYK-219 2R §1, 반쪽 배달 방지). 이 CLI를 포함한 브랜치로 워크트리를 갱신한 뒤 재시도하라."
}
```

<!-- HYK-256-REPLACEMENT-END -->
