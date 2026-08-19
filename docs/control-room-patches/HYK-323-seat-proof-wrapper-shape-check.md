# HYK-323 — 관제실 `dispatch-worker.ps1` 좌석 증명 래퍼 자기 검사 결선 (제안)

## 적용 상태: **PROPOSED** — ⛔이 라운드(CODER, HYK-323-wrapper-shape-3)도 이 문서를 고칠 뿐 관제실 파일을 고치지 않는다(§0 비타협2 "관제실 쓰기 0"). 적용은 사람/ORCH 몫이다.

## 접근 전환 (wrapper-shape-3, 2026-08-19 23:12 책임자 판정)

1R·2R은 관제실 `Invoke-SeatProofGate` 함수를 **정규식으로 모양을 알아보는** 방식이었다. 검토가 두 번 연속 우회를 찾아냈다(1차 3종·2차 6종, 총 9종 — 전부 "실제 결함인데 OK 판정"). 표기법 추격전은 진 싸움이라는 판단(책임자 판정, "가+나 묶음 채택·다(현행 유지) 기각")에 따라, 이 결선이 부르는 검사기는 이제:

- **주 열쇠 = 지문(fingerprint)**: `scripts/check/seat-proof-wrapper-canonical.json`에 박아둔 SHA-256과 관제실의 살아있는(마지막) `Invoke-SeatProofGate` 함수 본문을 비교한다. 일치만 OK, 그 외 전부(우회 9종 포함, 모양 판정과 무관하게) BROKEN/`CANONICAL_MISMATCH`.
- **모양 판정은 보조 진단**으로만 남는다 — 지문 불일치의 원인을 사람이 알아보기 쉽게 돕는 정보일 뿐, 판정을 뒤집지 않는다.

CLI 자체(`node scripts/check/seat-proof-wrapper-shape.mjs --script <path> [--canonical <path>]`)는 wrapper-shape-1 때와 이름·인자 모양이 같다(`--canonical`은 선택 인자, 생략 시 저장소의 `seat-proof-wrapper-canonical.json`을 쓴다) — 관제실 결선 문면(아래)은 이 라운드에서 바뀌지 않는다.

## 무엇을 결선하는가

관제실 배달기가 **자기 자신의 `Invoke-SeatProofGate` 함수**가 오늘(2026-08-19) 실제로 발생한 결함류(`& node ...`의 stdout이 캡처 없이 함수 반환값에 섞여 `-ne 0` 비교가 PROVEN(exit 0)도 거부로 읽는 모양, 그리고 review r1/r2가 찾은 그 변형 9종 전부)와 지문이 다르지 않은지 검사하는 데 쓴다.

**왜 좌석 증명을 부르기 전인가**: 좌석 증명 게이트 자체가 「항상 거부」모양이면, 그 게이트를 부르는 순간 이미 배달이 막힌다(오늘 실제로 이 순환 교착이 발생했다 — HYK-323 비상 직수리 사유). 래퍼 검사를 좌석 증명 호출보다 **앞에** 두면, 같은 결함이 재발했을 때 좌석 증명 게이트 자체를 부르기도 전에 명확한 사유(`WRAPPER_SHAPE: BROKEN reason=...`)로 멈춰, 「왜 모든 배달이 거부되는지 알 수 없는」 오늘과 같은 진단 공백을 없앤다.

## 정직 한계 (§2-3, 이 검사기 자체의 한계 — 그대로 인용)

- **CI는 관제실을 볼 수 없다.** 저장소 CI가 실행하는 것은 `seat-proof-wrapper-shape.test.mjs`(검사기 자체의 단위 시험)뿐이다. 이 결선(관제실이 스스로를 검사하는 것)은 **로컬 배달 시점**에만 발동한다 — 「CI가 재발을 막는다」는 문장은 여전히 성립하지 않는다.
- 지문 검사는 **텍스트**만 본다 — `Invoke-SeatProofGate`를 실제로 실행해 exit 0이 진짜 통과로 읽히는지 확인하지 않는다(그건 저장소의 `seat-proof-wrapper-behavior.mjs`가 하지만, 그 행동 검사도 PowerShell이 있는 로컬에서만 돈다 — 같은 로컬 앵커 한계).
- ★**이 로컬 앵커 한계는 이번에 새로 생긴 것이 아니다** — wrapper-shape-1의 모양 검사도 똑같이 로컬 앵커였다.
- 아래 결선이 적용된 뒤에도, 정본 지문을 **정당한 사유 없이** 바꾸면(검토 라운드 없이) 이 검사기는 그 변경을 그대로 신뢰한다 — 지문 갱신 절차(`seat-proof-wrapper-canonical.json`의 `changeProcedure`) 자체가 사람 게이트다.

## 적용 전 지문 (ORCH가 직접 실측, wrapper-shape-1)

`D:\문서관리\하네스-관제실\dispatch-worker.ps1`을 **읽어서**(쓰기 0, §0 비타협2) 직접 측정한 값이다:

| 항목               | 값                                                                 |
| ------------------ | ------------------------------------------------------------------ |
| 측정 시각          | 2026-08-19 22:23:46 KST                                            |
| SHA-256(전체 파일) | `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58` |
| 행수               | 573줄                                                              |

이 값은 docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md HYK-323절이 기록한 "적용 후" 지문(`8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`)과 일치한다 — 즉 이 문서를 쓰는 시점까지 관제실 파일은 그 비상 직수리 이후 변경되지 않았다.

## 함수 본문 지문 (ORCH가 직접 실측, wrapper-shape-3)

같은 실물 파일에서 `Invoke-SeatProofGate` 함수 본문만(브레이스 깊이 카운팅으로 추출, CRLF->LF 정규화) 잘라 다시 측정한 값이다 — `scripts/check/seat-proof-wrapper-canonical.json`에 그대로 저장했다:

| 항목               | 값                                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| 측정 시각          | 2026-08-19 23:22:18 KST                                                          |
| SHA-256(함수 본문) | `71d1f630029037d6aad5b991b07a520a1ac18b55bf8cb9f104ae0dc15de065ae`               |
| 근거               | 위 전체 파일 지문이 그대로였으므로(변경 없음), 그 파일에서 잘라낸 함수 본문 지문 |

## 어디에 넣을지 — 앵커 (행 번호 아님)

**삽입 위치**: `[1.6/3] 동시 상한 원자 입장 확인 (HYK-224)` 블록의 `if ($admissionExit -ne 0) { ... }` 닫는 줄 **뒤**, `# HYK-219-receipts-2` 주석 블록(영수증 CLI 존재 확인) **앞**. 즉 좌석 증명(`Invoke-SeatProofGate`)이 처음 호출되는 [2.5/3]/[2.4/3] 블록보다 한참 앞선, 배달 파이프라인 초입이다.

- **구간 시작 앵커**(삽입 지점 직전 마지막 기존 줄, 문자 그대로): `Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."`
- **구간 끝 앵커**(삽입 지점 직후 첫 기존 줄, 문자 그대로): `# HYK-219-receipts-2 §1 (1R P1 반려 "반쪽 배달" 대응): 영수증 CLI가 이`

새 블록은 이 두 앵커 **사이**에 그대로 끼워 넣는다 — 기존 줄은 순서·내용 전부 그대로 유지(재배치 없음).

## 교체 문면 (그대로 붙일 수 있는 PowerShell)

```powershell
Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."
}

# HYK-323(2026-08-19 후속, wrapper-shape-1): 좌석 증명 게이트를 부르기
# 전에, 이 배달기 자신의 Invoke-SeatProofGate 함수가 "PROVEN(exit 0)도
# 거부로 읽는" 오늘 재발한 결함 모양이 아닌지 자기 검사한다. 판단은
# 저장소 안 scripts/check/seat-proof-wrapper-shape.mjs 몫이다(관제실은
# CLI를 부르고 종료코드로만 분기하는 얇은 껍데기). 이 검사기는 모양만
# 본다 -- 실행해서 확인하지 않는다(docs/control-room-patches/
# HYK-323-seat-proof-wrapper-shape-check.md 정직 한계 참조).
$wrapperShapeCliPath = Join-Path $Worktree "scripts/check/seat-proof-wrapper-shape.mjs"
if (-not (Test-Path $wrapperShapeCliPath)) {
  Write-Error "WRAPPER_SHAPE_CLI_MISSING: $wrapperShapeCliPath 가 없다 -- 좌석 증명 래퍼 모양을 확인할 수 없으므로 배달을 계속하지 않는다(HYK-323 기계 게이트, fail-closed)."
  exit 9
}
$wrapperShapeOut = & node $wrapperShapeCliPath --script $PSCommandPath 2>&1
$wrapperShapeExit = $LASTEXITCODE
foreach ($line in @($wrapperShapeOut)) { Write-Host "      $line" }
if ($wrapperShapeExit -ne 0) {
  Write-Error "WRAPPER_SHAPE_REJECTED: 좌석 증명 래퍼 모양 검사 실패(exit $wrapperShapeExit) -- Invoke-SeatProofGate 함수가 통과 경로 없는 모양(2026-08-19 결함류)이거나 검사기가 함수를 찾지 못했다. 좌석 증명을 부르기도 전에 멈춘다(fail-closed). 원인을 사람/ORCH가 확인하라."
}

# HYK-219-receipts-2 §1 (1R P1 반려 "반쪽 배달" 대응): 영수증 CLI가 이
```

## 새 exit code

- `exit 9` = `WRAPPER_SHAPE_CLI_MISSING`(신규, HYK-323) — 검사기 CLI 자체가 이 워크트리에 없으면 fail-closed(HYK-217/HYK-224/HYK-299의 `*_CLI_MISSING`/`*_MISSING` 관례와 동일한 모양).
- `WRAPPER_SHAPE_REJECTED`는 별도 exit code를 새로 쓰지 않고 `Write-Error`(관제실 관례상 이 시점에서 스크립트를 종료시킴 — 다른 `Write-Error` 호출들과 동일 패턴)로 멈춘다.

## 남은 것 (다음 트랙 후보 — 이 라운드 범위 밖)

1. 이 결선 자체를 적용하고 파싱 검사(`[System.Management.Automation.Language.Parser]::ParseFile()`)하는 것은 사람/ORCH 몫이다 — 적용 후 이 문서의 "적용 상태"를 `APPLIED`로 갱신하고 적용 전/후 SHA-256을 채워야 한다(HYK-299 문서와 동일한 정본 갱신 규약).
2. `$PSCommandPath`가 dot-sourcing 등 특수 실행 경로에서 비어 있을 가능성은 검토하지 않았다 — 이 배달기가 항상 `& dispatch-worker.ps1 ...` 형태로 직접 실행된다는 기존 관례(다른 블록들도 `$PSScriptRoot`를 같은 방식으로 신뢰한다)에 그대로 얹었다.
