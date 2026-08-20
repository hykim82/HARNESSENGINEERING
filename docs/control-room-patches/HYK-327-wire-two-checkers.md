# HYK-327 — 관제실 배달기 검사기 2종 결선 + HYK-315 선행 수리 (제안 문면)

## 적용 상태: **PROPOSED** — ⛔이 라운드(CODER, HYK-327-wire-1)는 이 문서를 쓸 뿐 관제실 파일을 고치지 않는다(coder-task.md §0 비타협2 "관제실 쓰기 0"). 적용은 ORCH가 6단계 전례 절차(문면 → 독립 검토 → 기계 추출 → 지문·백업·파싱 검사 → 관제실 git 커밋 → 발동 관측)로 집행한다.

## 왜 이 문서인가

HYK-323(래퍼 행동검사)·HYK-319(인자 대조)는 각각 검사기 CLI를 저장소
안에 만들었지만, 관제실 배달기(`dispatch-worker.ps1`)는 **아무도 그
CLI를 부르지 않는다**("있는 장치"일 뿐 "발동하는 장치"가 아니다). 이
문서는 그 결선(=관제실이 실제로 부르게 만드는 삽입 문면) 두 개를
한곳에 최종 적용본으로 묶는다.

★**HYK-315 수리를 이 조각에 포함한다**(책임자 판정 2026-08-20 12:22
"가", 근거 = B-6 원칙: 선행 작업은 목적을 명시하고 같은 브랜치·한
PR). **목적**: HYK-315(admission 원장 경로 `--admission-ledger-path`가
게이트 호출에 안 넘어감)를 먼저 고치지 않으면, HYK-319 결선을 적용하는
순간 `dispatch-gate-decision`이 `MISSING_ARGS`로 항상 REJECT를 내고
**모든 배달이 막힌다**(§1 §2-6의 실측이 그대로 보여준다) — 이 수리는
HYK-327 완료 조건("정상 경로 통과 실측")의 전제다.

## 실측 원본 (ORCH, coder-task.md §1 그대로)

| 항목                  | 값                                                                 |
| --------------------- | ------------------------------------------------------------------ |
| 관제실 배달기 SHA-256 | `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58` |
| 행수                  | 573줄                                                              |
| 측정 시각             | 2026-08-20                                                         |

이 세 조각 각각의 삽입 앵커는 **이 SHA-256의 원문을 기준**으로 한다.
관제실 파일이 이 값과 다르면 앵커 문자열 대조부터 다시 해야 한다(ORCH
6단계 §3 "기계 추출" 단계가 이 대조를 한다).

---

# §1 HYK-315 — admission 원장 경로 선행 수리 (한 줄 + 순서)

## 무엇이 문제인가

`dispatch-gate-decision.mjs` 호출(원문 191행 부근, `& node $gateScript
$roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path
$ReceiptPath`)에 `--admission-ledger-path`가 없다. 이 인자(또는 env
`ADMISSION_LEDGER_PATH`)가 없으면 `verifyAbortRecordRecoveryMarker`가
**항상 false**로 닫혀, 이름표 없이 죽은 라운드(abort record)의 정당한
회수 표식이 실재해도 "회수 표식 없음"과 똑같이 REJECT된다(코드 실측:
`dispatch-gate-decision.mjs` 1226-1231행 `resolveAdmissionLedgerPathForAbort`·
1289-1299행 `verifyAbortRecordRecoveryMarker`). Linear HYK-315(Todo·
미수리)가 등재한 결함이고, `dispatch-arg-contract-registry.mjs`가 이미
이 인자를 이 게이트의 `hard:false` 필수 인자로 선언해 두었다(§2-4에서
결선하는 HYK-319 검사기가 이 누락을 실제로 잡는다 — §2-6 실측 참고).

값 자체(`$admissionLedgerPath = Join-Path $PSScriptRoot
"admission-ledger.json"`)는 원문에 **이미 있다** — 다만 원문 210행
부근(`admission-cli.mjs` 호출 준비 블록)에서 정의되고, 그 정의는 게이트
호출(191행 부근)**보다 뒤**다. HYK-256과 같은 모양의 순서 문제다.

## 수리 방식: **이동**(새 정의 추가가 아니다)

⛔기존 줄을 지우지 않는다 — 값 정의 자체는 그대로 두고 **위치만
옮긴다**. 게이트 호출 앞에 새로 추가하고, 원래 있던 자리(admission-cli
블록)에서는 **지워서 중복 정의가 남지 않게** 한다(아래 세 조각 각각이
그 이동의 "추가 쪽"과 "제거 쪽"을 담당한다).

## 삽입 1/3 — 정의를 게이트 호출 앞으로 (추가)

**삽입 위치**: `docs/enforcement-known-gaps.md gap#96(직접 주입)·gap#97·gap#98
참조.` 주석 줄 **뒤**, `if ($Role -eq "PM") {` **앞**.

- **구간 시작 앵커**(삽입 지점 직전 마지막 기존 줄, 문자 그대로):
  `# docs/enforcement-known-gaps.md gap#96(직접 주입)·gap#97·gap#98 참조.`
- **구간 끝 앵커**(삽입 지점 직후 첫 기존 줄, 문자 그대로):
  `if ($Role -eq "PM") {`

```powershell
# docs/enforcement-known-gaps.md gap#96(직접 주입)·gap#97·gap#98 참조.

# HYK-315(2026-08-20, HYK-327-wire-1 선행 수리 -- coder-task.md B-6): admission
# 원장 경로($admissionLedgerPath)는 원래 admission-cli 호출 근처(아래
# "[1.6/3]" 구간)에서만 정의됐다 -- 게이트 호출(바로 아래 dispatch-gate-
# decision.mjs)«보다 뒤»였다. dispatch-arg-contract-registry.mjs가 이미
# --admission-ledger-path를 이 게이트의 hard=false 필수 인자로 선언했고
# (HYK-319-argcheck-2), 이 인자가 없으면 verifyAbortRecordRecoveryMarker가
# 항상 false로 닫혀 정당한 abort record 회수 표식도 REJECT된다(Linear
# HYK-315, 코드 실측: dispatch-gate-decision.mjs 1226-1231행·1289-1299행).
# 이 정의를 게이트 호출보다 앞으로 «옮긴다»(새 정의 추가가 아니라 이동 --
# 원래 "[1.6/3]" 구간의 정의는 그 자리에서 지운다, 중복 정의 없음 -- 아래
# "[1.6/3]" 구간의 교체 문면 참고).
$admissionLedgerPath = Join-Path $PSScriptRoot "admission-ledger.json"

if ($Role -eq "PM") {
```

## 삽입 2/3 — 게이트 호출에 인자 추가 (치환)

원문의 게이트 호출 줄(문자 그대로, 치환 대상):

```powershell
  & node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath
```

를 아래로 치환한다(끝에 `--admission-ledger-path $admissionLedgerPath`
추가, 그 외 동일):

```powershell
  & node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
```

## 삽입 3/3 — 원래 자리의 정의 제거 (중복 정의 없음 확인)

원문의 admission-cli 준비 블록(문자 그대로, 치환 대상):

```powershell
}
$admissionLedgerPath = Join-Path $PSScriptRoot "admission-ledger.json"
$admissionLockPath = Join-Path $PSScriptRoot "admission-ledger.lock"
```

를 아래로 치환한다(`$admissionLedgerPath` 정의 줄을 지우고, 지운
이유를 한 줄 주석으로 남긴다 — 나머지 두 줄은 그대로 유지):

```powershell
}
# HYK-315(2026-08-20): $admissionLedgerPath 정의는 위(§1.5 게이트 호출 앞)로
# 옮겨졌다 -- 여기서는 다시 정의하지 않는다(중복 정의 없음, 위 이동 문면의
# 주석 참고).
$admissionLockPath = Join-Path $PSScriptRoot "admission-ledger.lock"
```

**확인 문면**: 위 세 조각을 순서대로 적용하면 `$admissionLedgerPath`
대입문은 파일 전체에서 **정확히 1개**(게이트 호출 앞, 새 위치)만
남는다 — §2-6 합성 표적 시험이 이를 실측으로 고정한다(파싱 검사
`PARSE_OK` + 검사기 통과로 간접 확인).

---

# §2 HYK-323 — 좌석 증명 래퍼 「변경 탐지」 결선 (최종 적용본)

`docs/control-room-patches/HYK-323-seat-proof-wrapper-shape-check.md`가
이미 정의한 제안 문면을 **그대로 채택**한다. 바뀐 것은 없다 — 그
문서가 정의한 앵커·문면·exit code를 이 문서에 최종 적용본으로 옮겨
적을 뿐이다.

## 왜 좌석 증명을 부르기 전인가

좌석 증명 게이트(`Invoke-SeatProofGate`) 자체가 「항상 거부」 모양이면,
그 게이트를 부르는 순간 이미 배달이 막힌다(2026-08-19 HYK-323 비상
직수리 사유). 래퍼 검사를 좌석 증명 호출보다 **앞**에 두면, 같은
결함이 재발했을 때 좌석 증명 게이트 자체를 부르기도 전에 명확한
사유(`WRAPPER_CHANGED: YES reason=...`)로 멈춘다.

## 삽입 위치 — 앵커 (행 번호 아님)

**삽입 위치**: `[1.6/3] 동시 상한 원자 입장 확인 (HYK-224)` 블록의
`if ($admissionExit -ne 0) { ... }` 닫는 줄 **뒤**, `# HYK-219-receipts-2`
주석 블록(영수증 CLI 존재 확인) **앞**.

- **구간 시작 앵커**(문자 그대로): `Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."`
- **구간 끝 앵커**(문자 그대로): `# HYK-219-receipts-2 §1 (1R P1 반려 "반쪽 배달" 대응): 영수증 CLI가 이`

## 교체 문면 (그대로 붙일 수 있는 PowerShell)

```powershell
  Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."
}

# HYK-323(2026-08-19 후속, wrapper-shape-1; wrapper-shape-4에서 범위
# 재확정): 좌석 증명 게이트를 부르기 전에, 이 배달기 자신의
# Invoke-SeatProofGate 함수 본문이 정본(pinned SHA-256)과 달라졌는지
# 자기 검사한다. 판단은 저장소 안
# scripts/check/seat-proof-wrapper-shape.mjs 몫이다(관제실은 CLI를
# 부르고 종료코드로만 분기하는 얇은 껍데기). ⛔이 검사는 "안전한지"를
# 판단하지 않는다 -- 텍스트가 정본과 다른지만 알려준다. 사고성 회귀는
# 반드시 걸리지만, 고의로 꾸민 문면(예: 정본 본문을 here-string이나
# 죽은 if($false) 블록에 넣는 것)은 원리적으로 잡지 못한다
# (docs/control-room-patches/HYK-323-seat-proof-wrapper-shape-check.md
# 정직 한계 6줄 참조).
$wrapperShapeCliPath = Join-Path $Worktree "scripts/check/seat-proof-wrapper-shape.mjs"
if (-not (Test-Path $wrapperShapeCliPath)) {
  Write-Error "WRAPPER_SHAPE_CLI_MISSING: $wrapperShapeCliPath 가 없다 -- 좌석 증명 래퍼가 정본과 달라졌는지 확인할 수 없으므로 배달을 계속하지 않는다(HYK-323 기계 게이트, fail-closed)."
  exit 9
}
$wrapperShapeOut = & node $wrapperShapeCliPath --script $PSCommandPath 2>&1
$wrapperShapeExit = $LASTEXITCODE
foreach ($line in @($wrapperShapeOut)) { Write-Host "      $line" }
if ($wrapperShapeExit -ne 0) {
  Write-Error "WRAPPER_SHAPE_REJECTED: 좌석 증명 래퍼가 정본 지문과 달라졌다(WRAPPER_CHANGED: YES, exit $wrapperShapeExit) -- Invoke-SeatProofGate 함수 본문이 pinned SHA-256과 다르거나 검사기가 함수를 찾지 못했다. 좌석 증명을 부르기도 전에 멈춘다(fail-closed). 원인을 사람/ORCH가 확인하라(정당한 변경이면 정본 갱신 절차를 거쳐라)."
}

# HYK-219-receipts-2 §1 (1R P1 반려 "반쪽 배달" 대응): 영수증 CLI가 이
```

## 새 exit code

- `exit 9` = `WRAPPER_SHAPE_CLI_MISSING`(HYK-323) — 검사기 CLI 자체가
  이 워크트리에 없으면 fail-closed.
- `WRAPPER_SHAPE_REJECTED`는 별도 exit code 없이 `Write-Error`로
  멈춘다.

정직 한계·위협 모형은 원 문서(HYK-323-seat-proof-wrapper-shape-check.md)
그대로 유효하다 — 이 문서에서 반복하지 않는다.

---

# §3 HYK-319 — 저장소 CLI 5개 인자 대조 결선 (최종 적용본)

`docs/control-room-patches/HYK-319-dispatch-arg-contract.md`가 이미
정의한 제안 문면을 **그대로 채택**한다. 바뀐 것은 없다.

## 삽입 위치 — 앵커 (행 번호 아님)

**삽입 위치**: `$ReceiptPath` 해석 블록(`if (-not $ReceiptPath) { ... }`)
**뒤**, `# HYK-217(2026-08-10 병합 master 68560cf): 배달 전 게이트 확인`
주석 블록 **앞**. 즉 저장소 CLI 5개 중 어느 것도 아직 호출되지 않은
지점이다.

⚠️**§1의 HYK-315 삽입 1/3과 같은 두 앵커 사이에 들어간다** — §4에서
두 삽입의 순서를 못박는다.

- **구간 시작 앵커**(문자 그대로): `  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }` 다음 줄(빈 줄) 다음.
- **구간 끝 앵커**(문자 그대로): `# HYK-217(2026-08-10 병합 master 68560cf): 배달 전 게이트 확인 — fail-closed.`

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

- `exit 9` = `ARG_CONTRACT_CLI_MISSING`(HYK-319) — 검사기 CLI 자체가
  이 워크트리에 없으면 fail-closed.
- `ARG_CONTRACT_REJECTED`는 별도 exit code 없이 `Write-Error`로 멈춘다.

정직 한계·필수 인자 선언 표는 원 문서(HYK-319-dispatch-arg-contract.md)
그대로 유효하다 — 이 문서에서 반복하지 않는다.

---

# §4 세 조각의 발동 순서와 상호작용

세 조각을 전부 적용한 뒤, 배달기 실행 순서(위→아래)는 다음과 같다:

1. `$ReceiptPath` 해석(기존).
2. **§1 삽입 1/3** — `$admissionLedgerPath` 정의(새 위치, 게이트 호출 앞). 검사가 아니라 값 준비일 뿐이므로 실패하지 않는다.
3. **§3 HYK-319 인자 대조 검사** — 삽입 1/3 바로 뒤, `if ($Role -eq "PM")` 분기 진입 **전**. 저장소 CLI 5개(게이트·원자 입장·영수증·좌석 증명·착수 확인) **중 어느 것도 아직 호출되지 않은** 최초 지점이다.
4. `dispatch-gate-decision.mjs` 호출(§1 삽입 2/3으로 `--admission-ledger-path` 추가됨).
5. `admission-cli.mjs admit` 호출(§1 삽입 3/3으로 `$admissionLedgerPath` 재정의 없이 위 2에서 정의한 값을 그대로 씀).
6. **§2 HYK-323 래퍼 변경 탐지 검사** — admission 통과 직후, 영수증 CLI 존재 확인보다 앞. `Invoke-SeatProofGate`가 실제로 호출되는 지점([2.5/3]/[2.4/3], 한참 뒤)**보다 훨씬 앞**이다.
7. 영수증 CLI 존재 확인 → `dispatch`/`Invoke-Dispatch` → `Record-DispatchReceipt` → `Invoke-SeatProofGate`(좌석 증명, 여기서 비로소 호출) → (codex 경로면) `terminal send` → [4/4] 착수 확인.

## 왜 인자 대조(HYK-319)가 래퍼 검사(HYK-323)보다 먼저인가

**근거**: 인자 대조의 보호 대상은 저장소 CLI **5개 전부**(게이트·원자
입장·영수증·좌석 증명·착수 확인)이고, 그중 첫 호출(`dispatch-gate-
decision.mjs`, 단계 4)이 가장 이르다. 5개를 전부 보호하려면 그 첫
호출보다 앞서야 한다 — 이는 HYK-319 원 문서가 이미 정한 삽입 지점과
일치한다(단계 3). 반면 래퍼 검사는 `Invoke-SeatProofGate` **단 하나**만
보호하면 되고, 그 함수의 실제 호출은 훨씬 뒤(단계 7)이므로 굳이 더
앞으로 당길 이유가 없다 — HYK-323 원 문서가 정한 삽입 지점(admission
통과 직후, 단계 6)을 그대로 쓴다. 결과적으로 두 검사는 **서로 다른
목표 시점**(각자가 보호하는 호출들 중 가장 이른 것)에 맞춰 자연스럽게
순서가 정해지며, 둘 다 자신이 보호하는 모든 호출보다 앞에 있다는
불변식을 만족한다.

## 한 조각이 실패하면 나머지는 어떻게 되는가

파일 최상단에 `$ErrorActionPreference = "Stop"`이 설정돼 있어(원문
49행), `Write-Error`는 **그 자리에서 스크립트 실행을 끝낸다**(다른
기존 게이트들 — HYK-217/224/299 — 과 동일한 관례). 따라서:

- **단계 3(HYK-319)이 실패**하면 게이트 호출(단계 4)부터 그 뒤 전부
  (admission·래퍼 검사·영수증·dispatch·좌석 증명) **실행되지 않는다**.
  아직 `orca orchestration dispatch`조차 안 불렸으므로 "반쪽 배달"이
  생기지 않는다.
- **단계 6(HYK-323)이 실패**하면 그 시점까지 이미 게이트(단계 4)와
  admission(단계 5)은 통과한 뒤다 — admission-cli가 이미 원자 입장을
  기록했을 수 있다는 뜻이다. 이는 **이 결선이 새로 만드는 상황이
  아니다**: 기존에도 영수증 CLI 존재 확인(§2 끝 앵커 블록)이 admission
  통과 직후에 있어, 그 확인이 실패하면 이미 admission이 기록된 채로
  스크립트가 끝났다 — 같은 모양의 "부분 진행 후 중단"이 이미 관례다.
  이 라운드는 그 관례에 검사 하나를 더 끼워 넣을 뿐, 새로운 되돌리기
  없음(no rollback) 문제를 만들지 않는다.
- 서로 다른 조각이 **동시에** 문제를 일으키는 경우는 없다 — 한
  스크립트 실행 안에서 `Write-Error`가 첫 실패 지점에서 즉시 멈추므로,
  뒤쪽 조각은 앞쪽 조각이 통과한 뒤에만 도달한다.

---

# §5 기계 추출 가능성

이 문서에는 **추출 대상 코드블록이 정확히 5개**다(모두 ` ```powershell ` 펜스,
앵커 문자열도 코드블록 안에 포함):

1. §1 삽입 1/3 — `$admissionLedgerPath` 정의 이동(추가 쪽)
2. §1 삽입 2/3 — 게이트 호출 줄 치환(`--admission-ledger-path` 추가)
3. §1 삽입 3/3 — admission-cli 블록 치환(중복 정의 제거)
4. §2 HYK-323 — 래퍼 변경 탐지 검사 삽입
5. §3 HYK-319 — 인자 대조 검사 삽입

적용 순서는 파일 안 등장 순서(위 5개 번호 순)와 같다 — 1·2·3은 모두
§1 관련이지만 서로 다른 위치를 건드리므로 독립적으로 적용 가능하고,
4·5는 각각 자기 앵커에만 적용한다. 서로 겹치는 앵커는 없다.

---

# §6 저장소 쪽 시험 — 「적용 후」 합성 표적

관제실 파일은 CI가 못 본다. 그러나 위 5개 블록을 오늘 스냅샷에 적용한
「적용 후」 합성본을 저장소 픽스처로 만들어, 두 검사기가 실제로
통과하는지 미리 확인했다(coder-task.md §0 비타협8 "열리지 않는 문을
만들지 마라"의 저장소 쪽 확인 축).

- 원본: `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt`(오늘 관제실 실물 스냅샷, HYK-319-argcheck-3이 이미 저장, SHA-256 `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`)
- 합성본: `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt`(위 §5의 5개 블록을 원본에 그대로 적용, SHA-256 `29fb025f23dbf8ae14f9adf81305de20975996ab0312ef1a352f67413aa707e6`, 635줄)

## 실측 결과 (이 라운드 CODER 좌석 직접 실행)

```text
$ node scripts/check/dispatch-arg-contract.mjs --script scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt
PASS  dispatch-gate-decision -- 직접 결속(변수 $gateScript) -- 필수 인자 전부 확인됨
PASS  admission-cli-admit -- 직접 결속(변수 $admissionCliPath) -- 필수 인자 전부 확인됨
PASS  dispatch-receipt-cli -- 간접 결속(시그니처 점수 3) -- 인식된 필수 인자 전부 확인됨 -- ...
PASS  dispatch-worker-seat-proof-gate -- 직접 결속(변수 $gateCliPath) -- 필수 인자 전부 확인됨
PASS  dispatch-start-confirm-cli -- 직접 결속(변수 $confirmCli) -- 필수 인자 전부 확인됨
dispatch-arg-contract: ALL_OK
exit=0

$ node scripts/check/seat-proof-wrapper-shape.mjs --script scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt
WRAPPER_SHAPE_DIAGNOSTIC: NO_KNOWN_SHAPE_DEVIATION (informational only, ...)
WRAPPER_CHANGED: NO
exit=0

$ pwsh -NoProfile -Command "... [System.Management.Automation.Language.Parser]::ParseFile(...) ..."
PARSE_OK
```

세 확인 모두 통과: **ALL_OK**(HYK-315 수리 + HYK-319 결선이 서로
막지 않는다는 증거) · **WRAPPER_CHANGED: NO**(세 조각 모두
`Invoke-SeatProofGate` 함수 본문 자체는 건드리지 않으므로 래퍼 지문이
그대로 유지된다는 증거) · **PARSE_OK**(합성본이 여전히 유효한
PowerShell이라는 증거, 삽입 과정에서 중괄호/따옴표가 깨지지 않았음을
확인).

## 시험으로 고정 (CI 정본에 포함, 이 라운드가 신규 추가)

- `scripts/check/dispatch-arg-contract-hyk327-applied-snapshot.test.mjs`
  — 픽스처 바이트 동일성 + `runContractCheck(...).ok === true`(ALL_OK) 고정.
- `scripts/check/seat-proof-wrapper-shape-hyk327-applied-snapshot.test.mjs`
  — `judgeSeatProofWrapper(...).verdict === "OK"`(WRAPPER_CHANGED: NO) 고정.

이 두 시험은 앞으로 이 문서의 제안 문면이 바뀌거나(픽스처 재생성 필요)
검사기 코어 로직이 손상되면(§2-3류 변이) CI에서 RED로 드러난다 — 다만
관제실 «실물»이 이 문면대로 고쳐졌는지는 여전히 이 저장소가 볼 수
없다(로컬 앵커 한계, HYK-319/323 문서와 동일 — §2-6은 「적용하면
막히지 않는다」를 미리 증명할 뿐, 「실제로 적용됐다」를 증명하지
않는다).

## 갱신 절차 (합성본이 실물과 다시 벌어지면)

관제실 실물이 바뀌면(정당한 변경이든 이 문서 적용이든) 원본 스냅샷·
합성본·두 시험의 SHA-256 상수를 함께 갱신해야 한다 — 절차는
`dispatch-arg-contract-snapshot.test.mjs`의 "책임자 조건②"와 동일
원칙(재생성 → 헤더 SHA-256/시각/행수 갱신 → 기대 판정 갱신 → 검토
라운드 경유). 이 문서가 ORCH의 6단계 §5(관제실 git 커밋)까지
집행되면, 이 §6 축은 "적용 전 미리 증명"이라는 목적을 다한 것이므로
폐기하거나 실물 SHA-256으로 갱신할 수 있다(다음 트랙 판단, 이 라운드
범위 밖).

---

# ⛔하지 않은 것 (coder-task.md §3)

- 관제실 파일 수정(ORCH 몫) — 이 라운드는 저장소 안 문서·픽스처·시험만
  건드렸다.
- 검사기 본체 변경 — `dispatch-arg-contract*.mjs`·
  `seat-proof-wrapper-shape.mjs`·레지스트리·정본 지문 전부 무변경(§2-6
  실측은 기존 코드를 그대로 호출했을 뿐이다).
- 고의 우회 방어 — 두 검사기 각각의 정직 한계(HYK-319/323 원 문서)를
  그대로 인용했을 뿐 더 쫓지 않았다.
- 결선 「발동 관측」 — 관제실 실물에 이 문면이 실제로 적용된 뒤의
  발동 확인은 ORCH가 6단계 §6에서 한다.
