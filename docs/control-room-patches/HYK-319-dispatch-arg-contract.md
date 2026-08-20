# HYK-319 — 관제실 `dispatch-worker.ps1` ↔ 저장소 CLI 5개 «필수 인자 대조» 결선 (제안)

## 적용 상태: **PROPOSED** — ⛔이 라운드(CODER, HYK-319-argcheck-1)는 이 문서를 쓸 뿐 관제실 파일을 고치지 않는다(coder-task.md §0 비타협2 "관제실 쓰기 0"). 적용은 사람/ORCH 몫이다.

★이 제안은 **HYK-327에서 적용됨** — 적용 상태는
`docs/control-room-patches/HYK-327-wire-two-checkers.md`를 보라(이 문서
자체의 "적용 상태"는 정본 갱신 규약상 `PROPOSED`로 남아 있지만, 실제
적용 여부는 HYK-327 문서가 정본이다 — 이 문서가 거짓 상태를 주장하지
않도록 남기는 한 줄).

## 왜 (coder-task.md §1, 실해 3건)

- **HYK-256** — 배달기가 게이트 호출(`dispatch-gate-decision.mjs`)에
  `--dispatch-receipt-path`를 안 넘겨, 앞 라운드 소비 확인이
  `dispatchId: null`로 거부됐다(매 재작업마다 발동).
- **HYK-315** — 같은 모양으로 원장 경로류 인자도 안 넘기는 사고가
  재발했다(비정상 중단 라운드 축, 미수리).
- **08-19 ORCH 실해 3회** — `-ReceiptPath` 오지정 2회 + `--live-seats`
  목록 오구성 1회(자리표 회수 사고).

공통 뿌리: **"어떤 인자를 반드시 넘겨야 하는가"가 사람 눈에만 있었다.**
이 검사기는 그 목록을 저장소 안 기계 판독 선언(`scripts/check/
dispatch-arg-contract-registry.mjs`)으로 옮기고, 배달기 원문을 그 선언과
정적으로 대조한다.

## 위협 모형 (coder-task.md §0 비타협7, 문면 그대로)

- **막으려는 것 = 사고 방지.** 사람이 배달기를 고치다 인자를 실수로
  빠뜨리는 것.
- ⛔**막지 못하는 것 = 고의 우회.** 텍스트 분석은 실행 문맥을 모른다.
  관제실을 고칠 수 있는 주체는 이 검사기도 끌 수 있다. 이 층에 "공격자
  방어"를 기대하면 안 된다(HYK-323 문서의 같은 문장을 그대로 재확인).

## 이 검사기의 정직 한계 (반드시 그대로 인용)

1. **하는 일**: 배달기 원문에서 저장소 CLI 5개 각각의 호출 지점을 찾아,
   저장소가 선언한 필수 인자 «이름»이 그 호출문에 등장하는지만 본다.
   값의 옳음은 범위 밖이다(`--dispatch-receipt-path $ReceiptPath`에서
   `$ReceiptPath`가 실제로 무엇을 가리키는지는 모른다).
2. **호출 지점 해석은 두 층**:
   - **직접 결속**(dispatch-gate-decision·admission-cli·seat-proof-gate·
     start-confirm, 4개): 배달기 원문의 `$var = Join-Path ...
"<이 CLI 경로>"` 대입으로 변수를 그 CLI에 결속시키고, 그 변수를
     쓰는 호출 창이 정확히 하나면 채택한다. 필수 인자가 «전부» 빠져도
     구조적으로 잡는다 — HYK-256류 사고를 잡는 경로가 바로 이것이다.
   - **간접 결속**(dispatch-receipt-cli 1개뿐 -- `Record-DispatchReceipt`
     라는 PowerShell 함수 매개변수로 이름이 바뀌어 호출됨): 시그니처
     점수(그 CLI의 인식용 플래그가 그 창에 몇 개 등장하는가) 최댓값이
     «유일»할 때만 채택한다. ⚠️이 경로는 **필수 인자가 전부 빠진 창은
     구조적으로 못 찾는다**(점수 0이면 후보 자체가 안 됨) — «일부 누락»만
     잡는다. dispatch-receipt-cli는 이 한계 아래에 있다.
3. **fail-closed**: 호출 지점을 못 찾거나(정의만 있고 안 불림, 정의 자체가
   없음) 모호하면(같은 CLI를 두 변수가 가리킴, 같은 변수를 두 번 부름)
   "통과"가 아니라 거부다(각각 다른 exit code — 아래 표).
4. **소프트 선언(§2-2 헛선언 판정)**: 아래 표의 hard=false 항목은 그
   CLI 프로세스 자신은 그 인자 없이도 안 죽는다(§2-2 결속 시험이 직접
   증명). 그런데도 선언에 남긴 이유는 각 항목마다 다르며
   `dispatch-arg-contract-registry.mjs`의 note에 있다 — 요지는 "안
   죽지만 사고로 이어지는 누락"이 이 축 전체의 존재 이유(HYK-256)이므로,
   hard=false라고 선언에서 빼면 이 검사기의 존재 이유 자체가 없어진다는
   것.
5. **CI는 관제실을 볼 수 없다** — 이 검사는 로컬 앵커다(HYK-323과 동일
   한계). 저장소 CI가 실행하는 것은 이 검사기 자신의 단위/결속 시험뿐
   이다.
6. **이 검사기는 지금 아무도 부르지 않는다** — 결선(관제실이 이 CLI를
   실제로 부르게 만드는 일)은 이 라운드 범위 밖이다. 배달 전 인자
   누락을 실제로 막으려면 이 문서의 "결선 문안"이 적용돼야 한다.
   그때까지는 "있는 장치"일 뿐 "발동하는 장치"가 아니다(HYK-323의
   검사기도 같은 상태다).

## 필수 인자 선언 표 (`dispatch-arg-contract-registry.mjs` 요약)

| CLI                                   | 필수(hard)                                                                                                                              | 필수인데 소프트(hard:false, 이유는 위 4번)      | §2-1 실측 발견(표와 다른 점)                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-gate-decision.mjs`          | 위치 인자(task 파일 경로)                                                                                                               | `--expect-repo-root`, `--dispatch-receipt-path` | —                                                                                                                                                                                                                                                                                                                 |
| `admission-cli.mjs admit`             | `--ledger` `--lock` `--reservation-id` `--cap-path`\|`--cap`(anyOf)                                                                     | `--role` `--seat-key`                           | —                                                                                                                                                                                                                                                                                                                 |
| `dispatch-receipt-cli.mjs`            | `--role` `--task-label` `--receipt-path`                                                                                                | (없음)                                          | —                                                                                                                                                                                                                                                                                                                 |
| `dispatch-worker-seat-proof-gate.mjs` | 7개 전부(`--dispatch-show` `--terminal-show` `--harness-task-id` `--runtime-task-id` `--dispatch-id` `--worktree-id` `--worktree-path`) | (없음)                                          | —                                                                                                                                                                                                                                                                                                                 |
| `dispatch-start-confirm-cli.mjs`      | `--repo-root` `--dispatched-at-ms` `--notify-dir`                                                                                       | (없음)                                          | ★coder-task.md §2-1 표는 `--claude-home`/`--baseline-bytes`/`--watch-dir`/`--task-id`까지 필수처럼 적었지만, 코드 실측(HYK-280 주석 "둘 다 선택 인자다")과 관제실 실물 Claude 분기(543-554행)가 둘 다 다르다 — `--watch-dir`는 실물 호출에 아예 없고, 나머지는 코드 자체가 선택으로 설계됐다. 필수 선언에서 뺐다. |

## exit code (검사기 CLI 자신, `dispatch-arg-contract.mjs`)

| exit | 사유                                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | 5개 CLI 전부 PASS                                                                  |
| 1    | `MISSING_ARGS`(어느 CLI가 필수 인자 일부를 빠뜨림)                                 |
| 2    | `CALL_SITE_NOT_FOUND`(변수는 정의됐는데 안 불림, 또는 시그니처로도 후보를 못 찾음) |
| 3    | `SCRIPT_PATH_ASSIGNMENT_NOT_FOUND`(그 CLI의 Join-Path 대입 자체가 없음)            |
| 4    | `MULTIPLE_SCRIPT_PATH_BINDINGS`(같은 CLI 경로가 서로 다른 변수 2개에 대입됨)       |
| 5    | `CALL_SITE_AMBIGUOUS`(간접 결속 폴백에서 동점 후보)                                |
| 6    | `MULTIPLE_INVOCATIONS`(같은 변수를 부르는 창이 2개 이상)                           |
| 9    | 검사기 CLI 자체를 못 찾음(fail-closed)                                             |

여러 CLI가 서로 다른 사유로 실패하면, `dispatch-arg-contract.mjs`는
가장 근본적인 사유(호출 지점 자체를 못 찾는 쪽)를 프로세스 전체
exit code로 낸다 — 개별 CLI별 사유는 stdout 각 줄에 전부 그대로
찍힌다(`dispatch-arg-contract-core.mjs`의 `REASON_PRIORITY`).

## §2-5 실물 대조 1회 (읽기 전용, 발견해도 수리 안 함)

`D:\문서관리\하네스-관제실\dispatch-worker.ps1`을 **읽어서**(쓰기 0)
직접 측정했다:

| 항목                                                                                                         | 값                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 측정 시각                                                                                                    | 2026-08-20 (이 라운드 실행 시각)                                                                                                          |
| SHA-256(전체 파일)                                                                                           | `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`(HYK-323 문서가 기록한 값과 동일 — 그 이후 관제실 파일이 바뀌지 않았다) |
| 행수                                                                                                         | 573줄                                                                                                                                     |
| `node scripts/check/dispatch-arg-contract.mjs --script "D:\문서관리\하네스-관제실\dispatch-worker.ps1"` 결과 | `ALL_OK`, exit 0 — 5개 CLI 전부 PASS(HYK-256/315 계기가 됐던 누락은 이 시점 실물에는 없다)                                                |

즉 이 라운드가 만든 검사기로 실제로 대조해 본 결과, **지금 이 순간의
관제실 배달기에는 §1이 나열한 실해가 재발해 있지 않다.** 이 검사기의
가치는 "지금 안전함을 증명"하는 데 있지 않다 — 앞으로 배달기를 고치다
같은 실수가 재발하면, 결선(아래) 후에는 배달 전에 기계로 잡힌다는
데 있다.

## 어디에 넣을지 — 앵커 (행 번호 아님)

**삽입 위치**: `$ReceiptPath` 해석 블록(`if (-not $ReceiptPath) { ... }`)
**뒤**, `# HYK-217(2026-08-10 병합 master 68560cf): 배달 전 게이트 확인`
주석 블록 **앞**. 즉 저장소 CLI 5개 중 어느 것도 아직 호출되지 않은,
`$Worktree`만 이미 확정된 배달 파이프라인 최초 지점이다(5개 전부를
보호하려면 그중 첫 호출보다 앞서야 한다).

- **구간 시작 앵커**(삽입 지점 직전 마지막 기존 줄, 문자 그대로):
  `  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }`
  다음 줄(빈 줄) 다음.
- **구간 끝 앵커**(삽입 지점 직후 첫 기존 줄, 문자 그대로):
  `# HYK-217(2026-08-10 병합 master 68560cf): 배달 전 게이트 확인 — fail-closed.`

새 블록은 이 두 앵커 **사이**에 그대로 끼워 넣는다 — 기존 줄은 순서·
내용 전부 그대로 유지(재배치 없음).

## 교체 문면 (그대로 붙일 수 있는 PowerShell)

```powershell
  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }
}

# HYK-319(2026-08-20): 이 배달기가 잠시 뒤 부를 저장소 CLI 5개(게이트·
# 원자 입장·영수증·좌석 증명·착수 확인) 호출문에 필수 인자가 빠지지
# 않았는지, 실제로 부르기 전에 «자기 자신»을 정적으로 대조한다(HYK-256/
# 315 재발 방지 -- 오늘까지 이 실수가 두 번 났다). 판단은 저장소 안
# scripts/check/dispatch-arg-contract.mjs 몫이다(관제실은 CLI를 부르고
# 종료코드로만 분기하는 얇은 껍데기). ⛔이 검사는 "안전한지"를 판단하지
# 않는다 -- 배달기 원문에 필수 인자 «이름»이 있는지만 본다. 값의 옳음,
# 그리고 고의로 검사를 피하려 꾸민 문면은 이 검사기의 범위 밖이다
# (docs/control-room-patches/HYK-319-dispatch-arg-contract.md 정직 한계
# 참조).
$argContractCliPath = Join-Path $Worktree "scripts/check/dispatch-arg-contract.mjs"
if (-not (Test-Path $argContractCliPath)) {
  Write-Error "ARG_CONTRACT_CLI_MISSING: $argContractCliPath 가 없다 -- 저장소 CLI 호출 인자를 대조할 수 없으므로 배달을 계속하지 않는다(HYK-319 기계 게이트, fail-closed)."
  exit 9
}
$argContractOut = & node $argContractCliPath --script $PSCommandPath 2>&1
$argContractExit = $LASTEXITCODE
foreach ($line in @($argContractOut)) { Write-Host "      $line" }
if ($argContractExit -ne 0) {
  Write-Error "ARG_CONTRACT_REJECTED: 저장소 CLI 호출 인자 대조 실패(exit $argContractExit, 위 출력의 각 CLI 줄 참고) -- 이 인자 누락은 배달 뒤에야 드러나는 경우가 많으므로(HYK-256/315), 실제로 부르기 전에 멈춘다(fail-closed). 원인을 해소한 뒤 재시도하라."
}

# HYK-217(2026-08-10 병합 master 68560cf): 배달 전 게이트 확인 — fail-closed.
```

## 새 exit code

- `exit 9` = `ARG_CONTRACT_CLI_MISSING`(신규, HYK-319) — 검사기 CLI
  자체가 이 워크트리에 없으면 fail-closed(HYK-217/HYK-224/HYK-299/
  HYK-323의 `*_CLI_MISSING`/`*_MISSING` 관례와 동일한 모양).
- `ARG_CONTRACT_REJECTED`는 별도 exit code를 새로 쓰지 않고
  `Write-Error`(다른 블록들과 동일 패턴 — 이 시점에서 스크립트를
  종료시킨다)로 멈춘다.

## 남은 것 (다음 트랙 후보 — 이 라운드 범위 밖)

1. 이 결선 자체를 적용하고 파싱 검사
   (`[System.Management.Automation.Language.Parser]::ParseFile()`)하는
   것은 사람/ORCH 몫이다 — 적용 후 이 문서의 "적용 상태"를 `APPLIED`로
   갱신해야 한다.
2. dispatch-receipt-cli.mjs의 간접 결속 한계(위 정직 한계 2번)는, 관제실이
   그 CLI를 함수 매개변수 경유가 아니라 직접 변수로 부르도록 리팩터링
   하면 없앨 수 있다 — 그러나 그건 관제실 코드 스타일을 이 검사기에
   맞추는 일이라 이 라운드에서 제안하지 않는다(관제실 코드를 이
   검사기가 좌우하면 안 된다는 판단).
3. `--worktree-path (Norm $Worktree)`처럼 값 자체가 함수 호출인 경우,
   이 검사기는 그 값이 실제로 올바른 워크트리를 가리키는지 모른다(계약
   그대로, 정직 한계 1번) -- 값 검증은 이 검사기의 자매 축(seat-proof-
   cli.mjs 자신의 판정)이 이미 맡고 있다.

```

```
