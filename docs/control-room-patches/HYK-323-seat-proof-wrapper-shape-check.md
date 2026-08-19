# HYK-323 — 관제실 `dispatch-worker.ps1` 좌석 증명 래퍼 «변경 탐지» 결선 (제안)

## 적용 상태: **PROPOSED** — ⛔이 라운드(CODER, HYK-323-wrapper-shape-4)도 이 문서를 고칠 뿐 관제실 파일을 고치지 않는다(§0 비타협2 "관제실 쓰기 0"). 적용은 사람/ORCH 몫이다.

## 종결 라운드 (wrapper-shape-4, 2026-08-20 00:02 책임자 판정 "ⓐ 범위 축소" 확정)

검토가 **세 번 연속** 검사기를 뚫었다(1R 우회 3종 · 2R 6종 · 3R = 정본 본문을
here-string 이나 죽은 `if ($false)` 블록 안에 넣으면 함수가 아예 정의되지
않는데도 지문은 같아 "변경 없음"으로 읽힘). 세 번 모두 같은 뿌리다 —
텍스트 분석(정규식이든 지문이든)은 그 텍스트가 실제로 실행되는 자리에
있는지 모른다. 이 라운드는 새 탐지 기능을 더 쫓지 않는다 — 판정 범위를
「변경 탐지」하나로 좁히고, 아래 이름 자체를 그 의미로 바꿨다:
`WRAPPER_SHAPE: OK|BROKEN`(→ "검사 통과"로 오독되기 쉬움) →
`WRAPPER_CHANGED: NO|YES`(정본과 다른지 아닌지만 말한다). 아래 "정직
한계" 절이 이 라운드의 핵심 산출물이다 — **반드시 그대로** 읽을 것.

### 위협 모형 (책임자 확정)

- **막으려는 것 = 사고성 회귀** — 사람이 관제실 파일을 고치다 오늘의
  결함을 실수로 되살리는 경우. 어떤 실제 수정이든 텍스트가 바뀌므로
  지문 비교로 반드시 걸린다.
- ⛔**막지 못하는 것 = 고의 우회** — 검사를 통과하도록 일부러 꾸민
  문면(실측: here-string · `if ($false)`). 이 층에서는 원리적으로
  불가능하다 — 관제실 파일을 고칠 수 있는 주체는 검사기 자체도 끌 수
  있다.

## 접근 전환 (wrapper-shape-3, 2026-08-19 23:12 책임자 판정)

1R·2R은 관제실 `Invoke-SeatProofGate` 함수를 **정규식으로 모양을 알아보는** 방식이었다. 검토가 두 번 연속 우회를 찾아냈다(1차 3종·2차 6종, 총 9종 — 전부 "실제 결함인데 OK 판정"). 표기법 추격전은 진 싸움이라는 판단(책임자 판정, "가+나 묶음 채택·다(현행 유지) 기각")에 따라, 이 결선이 부르는 검사기는 이제:

- **주 열쇠 = 지문(fingerprint)**: `scripts/check/seat-proof-wrapper-canonical.json`에 박아둔 SHA-256과 관제실의 살아있는(마지막) `Invoke-SeatProofGate` 함수 본문을 비교한다. 일치만 OK, 그 외 전부(우회 9종 포함, 모양 판정과 무관하게) BROKEN/`CANONICAL_MISMATCH`.
- **모양 판정은 보조 진단**으로만 남는다 — 지문 불일치의 원인을 사람이 알아보기 쉽게 돕는 정보일 뿐, 판정을 뒤집지 않는다.

CLI 자체(`node scripts/check/seat-proof-wrapper-shape.mjs --script <path> [--canonical <path>]`)는 wrapper-shape-1 때와 이름·인자 모양이 같다(`--canonical`은 선택 인자, 생략 시 저장소의 `seat-proof-wrapper-canonical.json`을 쓴다) — 관제실 결선 문면(아래)은 이 라운드에서 바뀌지 않는다.

## 무엇을 결선하는가

관제실 배달기가 **자기 자신의 `Invoke-SeatProofGate` 함수**가 오늘(2026-08-19) 실제로 발생한 결함류(`& node ...`의 stdout이 캡처 없이 함수 반환값에 섞여 `-ne 0` 비교가 PROVEN(exit 0)도 거부로 읽는 모양, 그리고 review r1/r2가 찾은 그 변형 9종 전부)와 지문이 다르지 않은지 검사하는 데 쓴다.

**왜 좌석 증명을 부르기 전인가**: 좌석 증명 게이트 자체가 「항상 거부」모양이면, 그 게이트를 부르는 순간 이미 배달이 막힌다(오늘 실제로 이 순환 교착이 발생했다 — HYK-323 비상 직수리 사유). 래퍼 검사를 좌석 증명 호출보다 **앞에** 두면, 같은 결함이 재발했을 때 좌석 증명 게이트 자체를 부르기도 전에 명확한 사유(`WRAPPER_CHANGED: YES reason=...`)로 멈춰, 「왜 모든 배달이 거부되는지 알 수 없는」 오늘과 같은 진단 공백을 없앤다.

## 정직 한계 (§2-2/§2-3, 이 검사기 자체의 한계 — 그대로 인용)

1. **이 검사기가 하는 일**: 관제실 좌석증명 래퍼 함수가 **정본과
   달라졌는지 알린다.** 그뿐이다.
2. **막는 것**: 사고성 회귀(실수로 결함 재도입) — 텍스트가 바뀌면
   반드시 걸린다.
3. ⛔**막지 못하는 것**: **고의 우회**. 실측된 예 — 정본 본문을
   **here-string** 안에 넣거나 **`if ($false)` 블록** 안에 넣으면
   **함수가 존재하지 않는데도 지문이 같다**(검토 3차 실증, `pwsh` 로
   `FUNCTION_ABSENT` 확인).
4. **왜 그 이상 못 가나**: 텍스트 분석은 실행 문맥을 모른다. 그리고
   **관제실을 고칠 수 있는 주체는 이 검사기도 끌 수 있다** — 이 층에
   「공격자 방어」를 기대하면 안 된다.
5. **CI 는 관제실을 볼 수 없다** — 이 검사는 **로컬 앵커**다(기존
   방식도 마찬가지였다). 저장소 CI가 실행하는 것은
   `seat-proof-wrapper-shape.test.mjs`(검사기 자체의 단위 시험)뿐이다 —
   「CI가 재발을 막는다」는 문장은 성립하지 않는다.
6. **정본 갱신 절차**: 관제실 함수를 정당하게 고치면 ⑴새 지문 측정
   ⑵사유 기재 ⑶**검토 라운드 경유**(HYK-306 방식). 이 검사기는 지문
   자체가 **정당한 사유 없이** 바뀌어도(검토 라운드 없이) 그 변경을 그대로
   신뢰한다 — 지문 갱신 절차(`seat-proof-wrapper-canonical.json`의
   `changeProcedure`) 자체가 사람 게이트다.

⛔「이제 안전하다」·「재발을 막는다」류의 문장은 이 문서 어디에도 쓰지
않는다. 「달라지면 알려준다」가 이 도구의 전부다.

★행동 검사(`seat-proof-wrapper-behavior.mjs`)는 지문 검사를 대체하지
않는다 — **보조 진단 도구**일 뿐이며, PowerShell이 있는 로컬에서만
돈다(같은 로컬 앵커 한계). 안전 경계라고 주장하지 않는다.

## 적용 전 지문 (ORCH가 직접 실측, wrapper-shape-1)

`D:\문서관리\하네스-관제실\dispatch-worker.ps1`을 **읽어서**(쓰기 0, §0 비타협2) 직접 측정한 값이다:

| 항목               | 값                                                                 |
| ------------------ | ------------------------------------------------------------------ |
| 측정 시각          | 2026-08-19 22:23:46 KST                                            |
| SHA-256(전체 파일) | `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58` |
| 행수               | 573줄                                                              |

이 값은 docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md HYK-323절이 기록한 "적용 후" 지문(`8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`)과 일치한다 — 즉 이 문서를 쓰는 시점까지 관제실 파일은 그 비상 직수리 이후 변경되지 않았다.

## 함수 본문 지문 (ORCH가 직접 실측, wrapper-shape-3; CODER가 wrapper-shape-4에서 재확인)

같은 실물 파일에서 `Invoke-SeatProofGate` 함수 본문만(브레이스 깊이 카운팅으로 추출, CRLF->LF 정규화) 잘라 다시 측정한 값이다 — `scripts/check/seat-proof-wrapper-canonical.json`에 그대로 저장했다:

| 항목               | 값                                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| 측정 시각          | 2026-08-19 23:22:18 KST                                                          |
| SHA-256(함수 본문) | `71d1f630029037d6aad5b991b07a520a1ac18b55bf8cb9f104ae0dc15de065ae`               |
| 근거               | 위 전체 파일 지문이 그대로였으므로(변경 없음), 그 파일에서 잘라낸 함수 본문 지문 |

**wrapper-shape-4 재측정(2026-08-20 00:10 KST)**: 전체 파일 SHA-256을
다시 떠보니 `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`로
위 표와 **완전히 동일** — 관제실 파일은 wrapper-shape-1 이후 지금까지
바뀌지 않았다. 저장소의 `node scripts/check/seat-proof-wrapper-shape.mjs
--script "D:\문서관리\하네스-관제실\dispatch-worker.ps1"` 실행 결과도
`WRAPPER_CHANGED: NO`(exit 0) — 함수 본문 지문(`71d1f6300...`)도 그대로
유효하다. 재저장 불필요.

## 어디에 넣을지 — 앵커 (행 번호 아님)

**삽입 위치**: `[1.6/3] 동시 상한 원자 입장 확인 (HYK-224)` 블록의 `if ($admissionExit -ne 0) { ... }` 닫는 줄 **뒤**, `# HYK-219-receipts-2` 주석 블록(영수증 CLI 존재 확인) **앞**. 즉 좌석 증명(`Invoke-SeatProofGate`)이 처음 호출되는 [2.5/3]/[2.4/3] 블록보다 한참 앞선, 배달 파이프라인 초입이다.

- **구간 시작 앵커**(삽입 지점 직전 마지막 기존 줄, 문자 그대로): `Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."`
- **구간 끝 앵커**(삽입 지점 직후 첫 기존 줄, 문자 그대로): `# HYK-219-receipts-2 §1 (1R P1 반려 "반쪽 배달" 대응): 영수증 CLI가 이`

새 블록은 이 두 앵커 **사이**에 그대로 끼워 넣는다 — 기존 줄은 순서·내용 전부 그대로 유지(재배치 없음).

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

- `exit 9` = `WRAPPER_SHAPE_CLI_MISSING`(신규, HYK-323) — 검사기 CLI 자체가 이 워크트리에 없으면 fail-closed(HYK-217/HYK-224/HYK-299의 `*_CLI_MISSING`/`*_MISSING` 관례와 동일한 모양).
- `WRAPPER_SHAPE_REJECTED`는 별도 exit code를 새로 쓰지 않고 `Write-Error`(관제실 관례상 이 시점에서 스크립트를 종료시킴 — 다른 `Write-Error` 호출들과 동일 패턴)로 멈춘다.

## 남은 것 (다음 트랙 후보 — 이 라운드 범위 밖)

1. 이 결선 자체를 적용하고 파싱 검사(`[System.Management.Automation.Language.Parser]::ParseFile()`)하는 것은 사람/ORCH 몫이다 — 적용 후 이 문서의 "적용 상태"를 `APPLIED`로 갱신하고 적용 전/후 SHA-256을 채워야 한다(HYK-299 문서와 동일한 정본 갱신 규약).
2. `$PSCommandPath`가 dot-sourcing 등 특수 실행 경로에서 비어 있을 가능성은 검토하지 않았다 — 이 배달기가 항상 `& dispatch-worker.ps1 ...` 형태로 직접 실행된다는 기존 관례(다른 블록들도 `$PSScriptRoot`를 같은 방식으로 신뢰한다)에 그대로 얹었다.
