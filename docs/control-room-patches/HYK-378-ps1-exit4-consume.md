# HYK-378 후속 패치 문서 — `dispatch-worker.ps1` 이 `INVALID_ARGS`(exit 4)를 **소비**하게

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` · **SHA-256 `c366edd32436942745321ff66c47d532fbbb216eae631e436289c95495bbaea0`**(CODER 직접 재계산 확인 · 2026-08-28) · 줄끝 **LF**(CRLF 0 · BOM 0) · 총 **648줄**(`wc -l` 실측).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫 · S7 검토 대상).
**원안** = ORCH 초안(`D:\문서관리\하네스-관제실\2026-08-28-ps1-exit4-패치-초안.md`, 2026-08-28 22:12 KST 작성) — 아래는 그 초안을 옮기되 CODER 판단으로 다듬은 것이다(내용·설계 변경 없음 — 두 단위 텍스트는 초안과 바이트 동일. 다만 §5 정직 한계 절을 신설해 초안의 «못 하는 것»을 이 문서 자체에도 못박았다).

## 1. 무엇이 문제인가 (실측 · CODER 재확인)

`dispatch-worker.ps1` **643~645**:

```powershell
  if ($confirmExit -notin @(0, 1, 2, 3)) {
    Write-Warning "dispatch-start-confirm unexpected exit=$confirmExit; delivery continues"
  }
```

- 저장소 쪽 `dispatch-start-confirm-cli.mjs` 는 **#222**(HYK-378 4R~6R, master 병합 완료)에서 **인자 계약 위반 = `INVALID_ARGS`(종료코드 4)** 로 **자력 종료**하도록 고쳐졌다.
- 그런데 **소비하는 이쪽**(관제실 `dispatch-worker.ps1`)은 그 4를 «미지의 코드»로 보고 **경고 한 줄만 찍고 계속**한다. 스크립트는 끝까지 가서 **exit 0**(명시 `exit` 없음 = 0)으로 끝난다.
- ⇒ ★**저장소 수리가 절반만 산다** — 계약 위반이 **배달 보고에 아무 영향을 못 준다**. 두 레포에 걸친 계약의 나머지 절반이 이 문서다.

## 2. 불변식

> **P**: 착수 확인이 «돌지 못했다»는 사실은 호출자에게 종료코드로 전달된다. 계약 밖 종료코드(현재 4 = `INVALID_ARGS`, 그리고 **미지의 모든 코드**)는 ⛔**«성공»으로 보고되지 않는다.**

## 3. 위험(검토자가 특히 봐 달라 · ORCH 초안 §3 그대로)

1. ★**종료코드를 4로 바꾸면 «배달 실패»로 오독될 수 있다** — 오독한 호출자가 **재배달**하면 **중복 배달**이다. 현재 알려진 호출자 = **사람/ORCH 손 실행 1곳**(관제실·저장소 grep 결과 자동 호출자 0 · `.tmp/dispatch-worker.hyk327-applied.ps1` 은 산출물 사본). **이 가정이 맞는지 독립 확인이 필요하다.**
2. `$confirmContractViolation` 이 **정의되지 않은 채** 최종 블록(단위 2 삽입 지점)에 도달하는 경로(codex 분기·CLI 부재 분기)에서 PowerShell 은 `$null` → 거짓으로 평가한다 — **의도된 설계다**(이 두 분기는 애초에 exit 코드 계약이 다르고, 이번 패치의 대상이 아니다). 이 가정이 깨지는 경로가 있는지 검토가 필요하다.
3. 두 단위의 앵커가 **유일**한지 — 특히 `[4/4] 진단:` 줄은 파일에 **3번**(611·615·647) 나온다(CODER 재실측 — 초안은 "2번"이라 적었으나 실측은 3번이다, 611은 codex 분기라 변수명이 달라 텍스트 자체가 다르다). 단위 2 앵커는 «Claude 착수 확인 종료코드» 줄 + «진단:» 줄 + `}` 까지 **3줄**을 잡아 유일성을 확보했다(CODER가 `indexOf` 전수 검사로 앵커 1·2 모두 정확히 1회만 등장함을 실측 확인 — §6 참고).

## 4. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk378-exit4-capture
mode: replace
@@ANCHOR@@
  if ($confirmExit -notin @(0, 1, 2, 3)) {
    Write-Warning "dispatch-start-confirm unexpected exit=$confirmExit; delivery continues"
  }
@@CONTENT@@
  # HYK-378 후속(ORCH 레인 · S7): 계약 밖 종료코드는 fail-closed 로 다룬다.
  # 4 = INVALID_ARGS(저장소 CLI 의 인자 계약 위반). 그 밖의 미지 코드도 같은 취급 --
  # "모르는 코드니까 통과"가 곧 fail-open 이기 때문이다.
  $confirmContractViolation = $false
  $confirmExitObserved = $confirmExit
  if ($confirmExit -notin @(0, 1, 2, 3)) {
    Write-Warning "dispatch-start-confirm 계약 밖 종료코드=$confirmExit -- 착수 확인 결과를 신뢰할 수 없다"
    $confirmContractViolation = $true
  }
@@END@@
```

```control-room-patch-unit
id: hyk378-exit4-fail-loud
mode: insert_after
@@ANCHOR@@
  Write-Host "[4/4] Claude 착수 확인 종료코드=$confirmExit (0=STARTED, 1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START)"
  Write-Host "[4/4] 진단: engine=$confirmEngine folder=$confirmProjectDir baseline=$confirmBaselineBytes baseline_at=$confirmBaselineAtMs last_observation=$confirmLastObservationBytes last_observation_at=$confirmLastObservationAtMs"
}
@@CONTENT@@

# HYK-378 후속(ORCH 레인 · S7) -- 계약 밖 종료코드를 "성공"으로 보고하지 않는다.
# 이 지점은 [2/3] dispatch 뒤이므로 워커는 이미 기동됐다. 그래서 막는 것은 배달이 아니라
# "배달이 성공했다는 보고"이며, 종료코드 4를 따로 두어 "배달 실패"와 구별한다.
if ($confirmContractViolation) {
  Write-Host "[4/4] 착수 확인이 돌지 못했다 -- 관측된 종료코드=$confirmExitObserved (계약 = 0,1,2,3)"
  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."
  Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반)."
  exit 4
}
@@END@@
```

## 5. ⚠️정직 — 이 패치가 «못» 하는 것 (ORCH 초안 §2 후단 · CODER가 이 문서에 못박음)

- **범위 경계**: 두 단위는 `else` 분기(라이브 645행 앞뒤, 실제 Claude 착수 확인을 돈 경우)에서만 `$confirmContractViolation` 을 세팅한다. **codex 분기·CLI 부재 분기는 이 패치의 대상이 아니다** — 그 두 분기는 exit 코드를 자기들이 직접 `2`로 강제 설정하는 별도 계약이라 «미지의 코드»가 애초에 나올 수 없다.
- **이 지점은 `[2/3] dispatch` 뒤다** — 이 시점에 워커는 **이미 기동됐다**. 이 패치가 막는 것은 «배달」이 아니라 **«배달이 성공했다는 보고»** 뿐이다. 인자 검증을 `dispatch` **앞**으로 옮겨 애초에 잘못된 인자로 기동되지 않게 하는 것은 **별건**이며 이 조각 범위 밖이다.
- **재배달 오독 위험**은 §3-1에 등재했을 뿐 이 패치가 해소하지 않는다 — 호출자(사람/ORCH)가 exit 4 를 "재시도하라"는 신호로 잘못 읽으면 중복 배달이 날 수 있다. 이 문서는 그 위험을 **드러낼 뿐**, 호출자 쪽 방지 장치는 별도 조각이다.

## 6. ⚠️정직 — collect·effect 시험의 한계

- **collect 시험**(`control-room-patch-apply-hyk378-exit4-collect.test.mjs`)은 "문서가 파싱되고 fixture 를 바이트 동일하게 재현하는가"만 본다 — **관제실 라이브 파일을 열지 않는다.** 라이브 파일이 나중에 이 두 앵커와 다르게 바뀌어도(또는 그 두 단위가 통째로 삭제돼도) 이 시험은 그 사실을 알 도리가 없고 계속 초록으로 남는다. 이 시험이 실제로 막는 것은 "저장소 안"의 계약 문면(패치 문서·fixture) 변경뿐이다.
- **effect 시험**(`control-room-patch-apply-hyk378-exit4-effect.test.mjs`)의 문자열/구조 검사 부분은 "그 문장이 있다"만 보고 "그렇게 동작한다"는 못 본다 — 그래서 이 문서·이 라운드는 **행동 축 시험을 함께 넣는다**: `pwsh` 로 적용본에서 실제 실행되는 코드 조각(합성 표적, 실제 배달 아님)을 구동해 `confirmExit` 값별(0·1·2·3·4·99) 실제 종료코드를 실측한다. 이 행동 축조차 **PowerShell 언어 자체의 변수 스코프·`-notin` 연산자 의미를 검증하지 않는다** — pwsh 런타임 자체가 이미 신뢰된 전제다.
- 관제실 live 파일과 이 저장소 fixture 를 계속 같은 값으로 유지하는 것은 이 시험의 책임 밖이며, 그 동기화는 사람/ORCH 가 patch-apply 절차로 수행한다(§0의 SHA-256 드리프트 감시가 그 축을 별도로 맡는다).

## 7. 적용 절차 (ORCH 초안 §5 그대로)

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다(도구가 `--source` 를 읽기 전용으로 다룬다).
2. **적용본 diff 를 눈으로 확인** → 라이브 교체 → 합성 표적으로 1회 구동해 확인(⛔실제 배달로 시험하지 않는다).
3. 되돌림 = 원본 SHA-256 사본 보관.
