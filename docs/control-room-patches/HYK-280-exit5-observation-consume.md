# HYK-280 패치 문서 — `dispatch-worker.ps1` 이 `OBSERVATION_UNAVAILABLE`(저장소 CLI exit 5)를 **이름 있는 채로** exit 4 버킷 안에서 소비하게

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` **오늘자 실측 스냅샷**(2026-09-28, CODER 직접 재계산 확인) — 라이브 SHA-256 `5c1a8f6b6ff13546f3d4a39630d2c96092365b15cd13e4c7bbc7bf5edba88962` · CRLF · 782줄. 이 문서의 fixture(`control-room-dispatch-worker-2026-09-28-hyk280-exit5-before.ps1.txt`)는 다른 20개 패치 문서와 같은 관례대로 그 라이브 스냅샷을 **CRLF→LF 정규화**한 사본이다 — SHA-256 `e323cfe3a569afb2fdbc1b9e13ccc42c7a49b44d3d9e9556bbe72bbfdccb2a2b` · LF(CRLF 0 · BOM 0) · 782줄.
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫).

## 0. 이 문서가 따로 있는 이유 — HYK-378 문서에 얹지 않는다(HYK-280-exit5-repair-2, P2-1 수리)

이 조각(2R)의 앞 라운드(1R, 커밋 `fbed3e3`)는 이 delta를 `HYK-378-ps1-exit4-consume.md`에 "HYK-280 후속" 절로 **얹었다**. 검토자 P1-1(번호 충돌, 아래 §1)과 P2-1(앵커 드리프트·중복)이 둘 다 그 얹기에서 비롯됐다:

- `HYK-378-ps1-exit4-consume.md`의 두 단위(앵커=2026-08-28 원본 648줄)는 **그 자체로 이미 오래 전에 라이브에 적용된 역사 기록**이다(그 문서 자신의 collect 시험이 여전히 그 옛 648줄 fixture 로 자기-일관성을 확인한다 — 라이브를 보지 않는다, 그 문서 §6 정직 한계 그대로). 1R 은 그 두 단위의 CONTENT 를 확장하면서 앵커는 그대로 옛 648줄 텍스트에 둔 채 새 로직을 얹었다 — **그 결과 이 라운드가 직접 실측**했듯, 오늘 라이브(782줄, HYK-378·HYK-272 를 포함해 이미 훨씬 앞서 있다)에 그 앵커가 **0회**(`ANCHOR_NOT_FOUND`, exit 3) — 그리고 `hyk378-exit4-fail-loud` 단위 하나만 떼어 "라이브에 이미 `$confirmContractViolation` 블록이 있는" 합성 소스에 적용해 보면 그 블록이 **2회**(`if ($confirmContractViolation)`·`exit 4` 모두 2회)로 **중복**된다 — 둘 다 이 CODER 가 `scripts/check/control-room-patch-apply.mjs`를 직접 구동해 값으로 확인했다(§6 재현 절차).
- ⇒ **원인**: "이미 적용되어 역사 기록이 된 문서"와 "지금부터 라이브에 적용할 새 delta"를 같은 문서, 같은 앵커 세대에 섞었기 때문이다.

**이 라운드의 설계**: `HYK-378-ps1-exit4-consume.md`는 1R 이전 상태(PR #291 이전, 커밋 `62c6d08`)로 **되돌린다**(그 문서·그 2개 시험 파일·그 applied fixture 4개) — 역사 기록으로서는 원래 옳았다(검토자도 "1R 에서 살아 있는 것 대부분 옳다"고 확인). 새 delta 는 **이 문서 하나**로 분리하고, 앵커는 **오늘 라이브 스냅샷**에서 자른다. `scripts/supervisor/dispatch-start-confirm-cli.mjs`(저장소 CLI 헤더 주석표)와 그 시험은 1R 그대로 유지한다 — 저장소 CLI 쪽 `exit 5`(OBSERVATION_UNAVAILABLE)는 §0-2(원 HYK-280 task 문서)가 명시했듯 충돌이 없는 계층이고, 이 되돌림의 대상이 아니다.

## 1. ⛔번호 원장 — 왜 «새 wrapper exit 코드»를 쓰지 않는가(coder-task.md §1-3 요구)

CODER가 라이브 782줄 전수(`grep -n "exit [0-9]"`)와 패치 문서 21개 언급을 대조한 표(coder.md 본문에 값으로 재수록):

| 번호  | 라이브 실제 종료 문장(줄)        | 뜻                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 임자                      |
| ----- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0     | (암묵, 명시 exit 없음)           | 정상 진행                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 원본                      |
| 2     | 117                              | Worktree 경로 비었음                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 원본                      |
| 3     | 121                              | terminal list 실패                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 원본                      |
| 4     | 131 · **768**(이 조각 대상)      | NOT_FOUND(좌석 없음) · 착수확인 계약 밖(4=INVALID_ARGS **및 이제 5=OBSERVATION_UNAVAILABLE도 여기**)                                                                                                                                                                                                                                                                                                                                                                                                 | 원본 · HYK-378(+ 이 문서) |
| 5     | 158 · **782**(HYK-272)           | AMBIGUOUS(좌석 후보 다수) · 착수확인 결과 미성공(1,2,3)                                                                                                                                                                                                                                                                                                                                                                                                                                              | 원본 · HYK-272            |
| 6     | 598 · 614                        | DISPATCH_FAILED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | HYK-219 계열              |
| 7     | 140 · 606 · 622                  | STALE_OR_FOREIGN_HANDLE · SEAT_PROOF_REJECTED(claude/codex)                                                                                                                                                                                                                                                                                                                                                                                                                                          | HYK-299                   |
| 8     | 557                              | (RECEIPT_CLI_MISSING 인접 — 별도 조각)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | HYK-219                   |
| 9     | 188 · 202 · 282 · 352            | ENGINE_DETECT\_\*·WRAPPER_SHAPE\_\*                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | HYK-472 · HYK-323         |
| 10    | 374                              | RECEIVER_GUARD_CLI_MISSING                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | HYK-400                   |
| **1** | **미사용(실제 `exit 1` 문장 0)** | **암묵 예약** — `$ErrorActionPreference = "Stop"`(49행)이 걸려 있어, 어떤 `Write-Error`든 뒤따르는 명시 `exit N` 없이 처리되지 않은 종료 오류로 번지면 **PowerShell 기본값 exit 1**로 끝난다(HYK-400 문서 83행이 이 사실을 인용: "가드가 존재하지만 capability를 거부하면 ... `Write-Error`의 실제 exit 1을 사용한다"). ⇒ **"미사용"이 아니라 "암묵적으로 이미 «예기치 않은 크래시»라는 뜻을 지고 있다"** — 여기 새 뜻을 얹으면 사람이 "이게 설계된 5 상당 상태인지 진짜 크래시인지" 구별할 수 없다. |

**저장소 CLI 축(별 이름공간, coder-task.md §1-3 ⓒ)**: `DISPATCH_START_CONFIRM_EXIT_CODE` = `{STARTED:0, NOT_STARTED:1, COLLECTION_FAILED:2, STALLED_AFTER_START:3, INVALID_ARGS:4, OBSERVATION_UNAVAILABLE:5}`(정본 위치 = `scripts/supervisor/dispatch-start-confirm-cli.mjs`의 그 심볼 자체 — 1R 오기 정정, §4 아래). **사람이 헷갈릴 만한 값**: 이 CLI의 `5`(OBSERVATION_UNAVAILABLE)와 관제실 자기 `5`(AMBIGUOUS/HYK-272 미성공)는 숫자만 같을 뿐 완전히 다른 계층·다른 뜻이다 — 이 문서는 관제실 wrapper 층의 `5`를 **건드리지 않음**으로써 이 혼동을 늘리지 않는다.

⇒ **결론(설계 선택)**: 관제실 자기 exit 코드 공간에 **새 번호를 minting 하지 않는다.** `1`은 암묵 예약(위), `5`는 HYK-272 선점, `2·3·4·6·7·8·9·10`은 각각 임자가 있다 — 다음 빈 번호는 `11`이지만, coder-task.md §1-3 이 명시한 두 번째 설계도("번호를 새로 쓰지 않는" 대안)를 택한다: **`OBSERVATION_UNAVAILABLE`(저장소 CLI 의 5)은 관제실 자기 exit 코드로는 계속 `4`(계약 밖 버킷)에 남되, 사람이 읽는 진단 줄에서만 5 전용으로 갈라 말한다.** 애초에 1R 이 잡으려던 실제 증상(§1-2 아래)은 "종료코드 값 자체"가 아니라 "진단 문구가 인자계약위반이라고 잘못 말해서 사람이 재배달로 오독한 것"이었으므로, 이 설계가 증상을 정확히 겨냥한다.

## 2. ⛔실제 증상(1R 원 서술 인용, CODER 재확인)

저장소 CLI(`dispatch-start-confirm-cli.mjs`)가 새 상태 `OBSERVATION_UNAVAILABLE`(exit 5, PR #291/H3)을 낼 수 있게 됐지만, 관제실 `dispatch-worker.ps1`은 `$confirmExit -notin @(0,1,2,3)` 조건으로 그 5를 "그 밖의 미지 코드"(6·99 등과 동급)로 뭉뚱그린다. 사람이 보는 최종 문구는:

```
[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반).
```

**5(관측 폴더 자체를 못 찾음)를 "인자계약위반"으로 오독시킨다** — 오독한 사람이 "인자를 고쳐서 재배달"하면 이미 기동된 워커에 중복 배달이 갈 위험이 있다(HYK-378 문서 §3-1과 동형 위험).

## 3. 불변식(HYK-378 의 P 를 계승, 새 축 추가)

> **P**(HYK-378 원문, 변경 없음): 착수 확인이 «돌지 못했다»는 사실은 호출자에게 exit 4 로 전달된다. 계약 밖 종료코드(4 = INVALID_ARGS 자신, 5 = OBSERVATION_UNAVAILABLE, 그리고 6·99 등 그 밖의 모든 미지 코드) 무엇이든 ⛔**«성공»으로 보고되지 않는다.**
>
> **P″**(이 문서 신설, 1R 의 P′ 를 대체): 5(OBSERVATION_UNAVAILABLE)는 **계약 밖 미지 코드와 같은 exit 코드(4)로 수렴하지만, 사람이 읽는 마지막 진단 줄에서는 6·99 같은 "진짜 미지 코드"와 다른 문장을 받는다** — "인자계약위반"이 아니라 "관측 경로(세션 기록 폴더) 확인, 재배달 아님"이라고 말한다. ⛔**관제실 자기 exit 코드 공간은 넓히지 않는다** — 1R 의 P′("5는 계약 밖이 아니다, 별도 exit 5")와 달리, 이 설계는 **exit 코드 자체를 4에 남긴 채 문구만 가른다.**

## 4. 패치 단위 (기계 추출 대상 · 2개, 둘 다 `replace`, 서로 겹치지 않는 정확한 단문 앵커)

```control-room-patch-unit
id: hyk280-exit5-capture
mode: replace
@@ANCHOR@@
  # HYK-378 후속(ORCH 레인 · S7): 계약 밖 종료코드는 fail-closed 로 다룬다.
  # 4 = INVALID_ARGS(저장소 CLI 의 인자 계약 위반). 그 밖의 미지 코드도 같은 취급 --
  # "모르는 코드니까 통과"가 곧 fail-open 이기 때문이다.
  $confirmContractViolation = $false
  $confirmExitObserved = $confirmExit
  if ($confirmExit -notin @(0, 1, 2, 3)) {
    Write-Warning "dispatch-start-confirm 계약 밖 종료코드=$confirmExit -- 착수 확인 결과를 신뢰할 수 없다"
    $confirmContractViolation = $true
  }
@@CONTENT@@
  # HYK-378 후속(ORCH 레인 · S7): 계약 밖 종료코드는 fail-closed 로 다룬다.
  # 4 = INVALID_ARGS(저장소 CLI 의 인자 계약 위반). 그 밖의 미지 코드도 같은 취급 --
  # "모르는 코드니까 통과"가 곧 fail-open 이기 때문이다.
  # HYK-280 후속(worker-dispatch-rule 번호 원장 §1 -- 관제실 자기 exit 5는
  # HYK-272 블록이 이미 "착수 확인 결과 미성공(1,2,3)"으로 쓰고 있어 새
  # 번호를 쓰지 않는다): 5 = OBSERVATION_UNAVAILABLE(저장소 CLI
  # dispatch-start-confirm-cli.mjs 의 DISPATCH_START_CONFIRM_EXIT_CODE 가
  # 낸 이름 있는 상태 -- 세션 기록 폴더 자체를 못 찾음)도 exit 코드
  # 자체는 여전히 이 계약-밖 버킷(4)에 남는다. 다만 사람에게 하는 말은
  # 아래 exit-4 리포트 블록에서 5 전용으로 갈라 "인자계약위반"이 아니라
  # "관측 경로 확인, 재배달 아님"이라고 말한다(불변식 P″).
  $confirmContractViolation = $false
  $confirmExitObserved = $confirmExit
  if ($confirmExit -eq 5) {
    Write-Warning "dispatch-start-confirm 관측 불가(exit=5, OBSERVATION_UNAVAILABLE) -- 세션 기록 폴더 자체를 못 찾았다(재배달이 아니라 관측 경로 확인 필요)"
    $confirmContractViolation = $true
  } elseif ($confirmExit -notin @(0, 1, 2, 3)) {
    Write-Warning "dispatch-start-confirm 계약 밖 종료코드=$confirmExit -- 착수 확인 결과를 신뢰할 수 없다"
    $confirmContractViolation = $true
  }
@@END@@
```

```control-room-patch-unit
id: hyk280-exit5-report
mode: replace
@@ANCHOR@@
# HYK-378 후속(ORCH 레인 · S7) -- 계약 밖 종료코드를 "성공"으로 보고하지 않는다.
# 이 지점은 [2/3] dispatch 뒤이므로 워커는 이미 기동됐다. 그래서 막는 것은 배달이 아니라
# "배달이 성공했다는 보고"이며, 종료코드 4를 따로 두어 "배달 실패"와 구별한다.
if ($confirmContractViolation) {
  Write-Host "[4/4] 착수 확인이 돌지 못했다 -- 관측된 종료코드=$confirmExitObserved (계약 = 0,1,2,3)"
  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."
  Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반)."
  exit 4
}
@@CONTENT@@
# HYK-378 후속(ORCH 레인 · S7) -- 계약 밖 종료코드를 "성공"으로 보고하지 않는다.
# 이 지점은 [2/3] dispatch 뒤이므로 워커는 이미 기동됐다. 그래서 막는 것은 배달이 아니라
# "배달이 성공했다는 보고"이며, 종료코드 4를 따로 두어 "배달 실패"와 구별한다.
# HYK-280 후속 -- 5(OBSERVATION_UNAVAILABLE)는 exit 코드 자체는 여전히 이
# 계약-밖 버킷(4)에 머문다(관제실 자기 exit 5는 HYK-272가 이미 다른 뜻으로
# 쓰므로 새 번호를 쓰지 않는다, 번호 원장 §1). 사람이 읽는 진단 문구만
# 5 전용으로 갈라 "인자 계약 위반"이 아니라 "관측 경로 확인"을 말한다.
if ($confirmContractViolation) {
  if ($confirmExitObserved -eq 5) {
    Write-Host "[4/4] 착수 확인 관측 불가 -- 세션 기록 폴더 자체를 끝까지 찾지 못했다(exit=5, OBSERVATION_UNAVAILABLE)."
    Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 재배달이 아니라 좌석 화면을 직접 확인하라."
  } else {
    Write-Host "[4/4] 착수 확인이 돌지 못했다 -- 관측된 종료코드=$confirmExitObserved (계약 = 0,1,2,3)"
    Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."
  }
  Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 또는 관측 불가)."
  exit 4
}
@@END@@
```

## 5. HYK-272 와 서로 알기(coder-task.md §2 요구)

`docs/control-room-patches/HYK-272-ps1-notstarted-consume.md` §2-a 절에 이 문서를 인용하는 상호 참조를 신설했다(그 문서 diff 참고) — **두 문서가 관제실의 같은 exit 코드 번호 공간을 공유한다는 사실**, 그리고 **이 문서(HYK-280)가 HYK-272 소유의 exit 5 를 의도적으로 피해 exit 4 안에 머문다는 설계 선택**을 양쪽에서 찾을 수 있게 했다.

## 6. ⚠️정직 — 재현 절차(1R 결함을 값으로 확인한 방법, 다음 라운드가 같은 실수를 반복하지 않도록)

1. `node scripts/check/control-room-patch-apply.mjs --doc <1R 시점 HYK-378-ps1-exit4-consume.md> --source <오늘 라이브 사본> --out <아무 경로>` → `REJECT reason=ANCHOR_NOT_FOUND`(§0 인용).
2. `applyPatchUnits([그 문서의 hyk378-exit4-fail-loud 단위만], <앵커 3줄 + 그 뒤에 기존 $confirmContractViolation 블록을 그대로 둔 합성 소스>)` → 결과 텍스트에 `if ($confirmContractViolation)`·`exit 4` 가 **2회씩** 나타남(코드로 직접 `.match()` 카운트, coder.md 본문에 전체 출력 원문 수록).
3. 이 문서의 두 단위는 앵커가 **각각 정확히 그 단위가 바꾸는 블록 전체**(그 앞뒤로 손대지 않는 주변 코드를 CONTENT 안에 되풀이하지 않는다)이므로, 같은 실패 모드가 구조적으로 불가능하다 — §7 의 collect/effect 시험이 이를 값으로 재확인한다.

## 7. ⚠️정직 — 이 패치가 «못» 하는 것 (HYK-378/HYK-272 문서와 동형)

- **범위 경계**: codex 분기·CLI 부재 분기는 대상이 아니다(그 두 분기는 exit 코드를 자체적으로 2로 강제해 미지의 코드가 나올 수 없다).
- **이 지점은 `[2/3] dispatch` 뒤다** — 워커는 이미 기동돼 있다. 이 패치가 막는 것은 «배달»이 아니라 «배달이 성공했다는 보고»뿐이다.
- **재배달 오독 위험**은 여전히 사람이 stdout 한 줄을 읽어야 해소된다 — 이 패치는 그 문구를 정확하게 만들 뿐, 사람이 실제로 읽는다는 보장은 이 조각 범위 밖이다.
- **관제실 live 파일과 이 저장소 fixture를 계속 같은 값으로 유지하는 것**은 시험의 책임 밖이다 — 그 동기화는 사람/ORCH가 patch-apply 절차로 수행한다(§0의 SHA-256 드리프트 감시가 그 축을 맡는다). **라이브 미적용** — 이 문서·이 CODER 라운드는 사본에만 적용해 보였을 뿐, 실제 관제실 파일은 건드리지 않았다(다음 사람/ORCH 적용 단계·PR·CI·한용 병합을 거쳐야 최종 검증된다).
- **행동 축 시험(§8)조차** PowerShell 언어 자체의 변수 스코프·`-eq`/`-notin` 연산자 의미를 검증하지 않는다 — pwsh 런타임 자체가 이미 신뢰된 전제다.

## 8. 적용 절차 (사람/ORCH 몫)

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다(도구가 `--source`를 읽기 전용으로 다룬다). ⚠️라이브는 CRLF다 — `--source`에 CRLF 원본을 그대로 넣으면 이 문서의 LF 앵커와 바이트가 달라 `ANCHOR_NOT_FOUND`가 난다. 다른 20개 문서와 같은 관례대로, 적용 직전 CRLF→LF 정규화 사본을 만들고, 적용 후 결과를 다시 LF→CRLF로 되돌려 라이브에 반영하라(둘 다 줄바꿈만 바꾸는 기계적 변환 — 내용은 바이트 동일).
2. **적용본 diff를 눈으로 확인** → 라이브 교체 → 합성 표적으로 1회 구동해 확인(⛔실제 배달로 시험하지 않는다).
3. 되돌림 = 원본 SHA-256 사본 보관(`control-room-dispatch-worker-2026-09-28-hyk280-exit5-before.ps1.txt`가 이 라운드가 남긴 사본이다).
