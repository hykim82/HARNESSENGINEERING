# HYK-272 후속 패치 문서 — `dispatch-worker.ps1` 이 착수 확인 `1·2·3` 도 **소비**하게

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` · **SHA-256 `a0d40e760f05d139ed9fcdffa1fe99cf6291e21cba6ddc023ec2d3dd66a57dd3`**(CODER 직접 재계산 확인 · 2026-08-29 — 이 값은 HYK-378 의 `applied` fixture SHA-256 과 정확히 같다: 라이브 파일이 그 라운드 이후 손대지 않은 채 그대로다) · 줄끝 **LF**(CRLF 0 · BOM 0) · 총 **663줄**(`Get-Content` 실측).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫 · S7 검토 대상).

## 1. 무엇이 문제인가 (실측 · CODER 재확인)

`dispatch-worker.ps1` 은 HYK-378(PR #223, 어젯밤 병합)에서 **계약 밖 종료코드**(4 = `INVALID_ARGS`, 그리고 그 밖의 미지 코드)를 `exit 4`로 fail-closed 처리하게 됐다. 그런데 그 수리는 **계약 안**의 착수-실패 상태 셋 — `1`(NOT_STARTED) · `2`(COLLECTION_FAILED, 원인 3갈래) · `3`(STALLED_AFTER_START) — 은 건드리지 않았다. 라이브 **616~654행**(else 분기, Claude 엔진일 때 실제로 확인기를 돌리는 자리):

```powershell
} else {
  if ($confirmBaselineKnown) {
    ...
    try {
      & node @confirmArgs
      $confirmExit = [int]$LASTEXITCODE
    } catch {
      $confirmExit = 2
      Write-Warning "Claude 착수 확인 실행 실패; 배달은 계속합니다: $($_.Exception.Message)"
    }
  } else {
    $confirmExit = 2
  }
  ...
}
```

그리고 **612~615행**(elseif 분기, 확인기 CLI 파일 자체가 없을 때):

```powershell
} elseif (-not (Test-Path -LiteralPath $confirmCli)) {
  $confirmExit = 2
  Write-Warning "착수 확인 CLI 없음($confirmCli); 배달은 계속합니다."
  Write-Host "[4/4] 진단: engine=$confirmEngine folder=$confirmProjectDir baseline=$confirmBaselineBytes baseline_at=$confirmBaselineAtMs last_observation=$confirmLastObservationBytes last_observation_at=$confirmLastObservationAtMs"
}
```

세 branch(기준선 실패 · CLI 부재 · 실행 예외) 모두 `$confirmExit = 2` 로 수렴하고, codex 분기(`566`행부터 `611`행까지)는 `1`·`2`·`3` 을 직접 낼 수 있다. 어느 값이든 **이후 아무도 소비하지 않는다** — HYK-378 이 추가한 블록(`658`행부터 `663`행까지)은 `$confirmContractViolation` 이 참일 때만(= 계약 **밖** 코드일 때만) `exit 4` 를 낸다. `1`·`2`·`3` 은 계약 **안** 값이라 그 블록도 건너뛰고, 스크립트는 끝까지 가서 **암묵적 `exit 0`** 으로 끝난다.

⇒ ★**«착수 안 함»·«확인 못 함»·«시작 후 멈춤»이 전부 「성공」으로 보고된다.** 이것이 HYK-272 가 아직 못 닫은 지점이다.

## 2. 불변식

> **P**: 착수 확인이 `0`(STARTED) 이 아니면 — `1`(NOT_STARTED) · `2`(COLLECTION_FAILED, 원인 불문) · `3`(STALLED_AFTER_START) 무엇이든 — 이 스크립트는 ⛔**「성공」으로 보고되지 않는다.** 계약 밖 코드(HYK-378 의 `4`)와 계약 안의 이 세 실패 상태는 **서로 다른 조건이지만 둘 다 비-영 종료코드로 수렴**한다.

## 3. 설계 결정과 근거 (CODER 판단 · coder-task.md §2 의 재량 조항에 따름)

1. **`1`·`2`·`3` 을 하나의 새 종료코드 `5`로 묶는다** — 상태별로 `5`/`6`/`7` 로 더 쪼개지 않는다. 근거: 이 스크립트의 유일하게 알려진 소비자는 사람/ORCH 의 눈(§1 인용, 실사고 3건 모두 «사람이 뒤늦게 발견»)이며, 그 소비자에게 필요한 구별은 **"성공적으로 착수를 확인했다" vs "못 했다(원인은 Write-Host 진단 줄로 이미 충분히 남는다)"** 뿐이다. 원인별로 종료코드를 쪼개면 호출자 쪽에 존재하지 않는 분기를 만들 뿐이고, 오히려 "어느 코드가 재시도해도 되는 신호인가"라는 새 오독 위험을 늘린다(§3-1 아래).
2. **기존 계약을 보존한다** — `0` 은 그대로 정상 진행, `4` 는 그대로 HYK-378 의 «착수확인 인자계약 위반»이다. 새 블록은 **기존 계약-위반 블록(`if ($confirmContractViolation) { ... exit 4 }`) 바로 뒤**, if/elseif/else 삼지 분기 **밖**에 붙인다 — 이러면 codex 분기·CLI 부재 분기·Claude 실행 분기 **세 곳 중 어디서 `$confirmExit` 가 `1`/`2`/`3` 이 됐든 한곳에서 균일하게 소비**된다. 세 분기 각각의 내부 코드는 **한 글자도 건드리지 않는다** — coder-task.md §4 가 확인기 판정 로직 자체 변경을 범위 밖으로 못박았고, 이 설계는 그 경계를 자연히 지킨다(분기 안이 아니라 분기들이 합류하는 지점에 붙이므로).
3. **`4` 와의 순서** — 계약-위반 블록이 먼저 `if ($confirmContractViolation) { ... exit 4 }` 로 검사되고, 그 블록이 참이면 그 자리에서 이미 `exit 4` 로 프로세스가 끝난다. 새 블록은 그 뒤에 오지만, **`$confirmExit` 가 계약 밖 값이면 애초에 `$confirmContractViolation` 이 참이라 `exit 4` 로 이미 끝나 있고, 새 블록의 `-in @(1,2,3)` 조건 자체가 계약 밖 값을 포함하지 않으므로 두 블록이 동시에 발화하는 경로는 없다.**
4. ⛔**자동 재전달 0** — 새 블록은 `Write-Host` 진단 3줄 + `exit 5` 뿐이다. `& node`·`Start-Process`·`dispatch --inject` 류의 재호출을 **전혀 추가하지 않는다**(coder-task.md §5-6, 이슈 완료조건 4). 이 스크립트에서 실제 dispatch 는 이 지점보다 훨씬 앞(482~503행 부근, seat-proof 게이트 통과 후)에 이미 끝나 있다 — 이 지점은 그보다 한참 뒤인 `[4/4]` 구간이다.

## 4. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk272-notstarted-consume
mode: insert_after
@@ANCHOR@@
if ($confirmContractViolation) {
  Write-Host "[4/4] 착수 확인이 돌지 못했다 -- 관측된 종료코드=$confirmExitObserved (계약 = 0,1,2,3)"
  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."
  Write-Host "[4/4] 이 스크립트는 4 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반)."
  exit 4
}
@@CONTENT@@

# HYK-272 후속(CODER 레인) -- 1(NOT_STARTED)·2(COLLECTION_FAILED, 원인 불문)·
# 3(STALLED_AFTER_START)도 4(계약 밖 코드)와 마찬가지로 "성공"으로 보고하지
# 않는다. 세 상태를 원인별로 쪼개지 않고 하나의 종료코드로 묶는다 -- 이
# 스크립트의 유일한 소비자(사람/ORCH)에게 필요한 구별은 "확인됐다 vs 못
# 됐다"뿐이고, 원인은 위에서 이미 찍은 Write-Host 진단 줄로 남는다.
# ⛔자동 재전달은 하지 않는다 -- 이 블록은 진단을 찍고 비-영 종료코드로 끝날
# 뿐, 배달을 다시 시도하는 어떤 호출도 추가하지 않는다.
if ($confirmExit -in @(1, 2, 3)) {
  Write-Host "[4/4] 착수 확인 결과가 성공이 아니다 -- 종료코드=$confirmExit (1=NOT_STARTED, 2=COLLECTION_FAILED, 3=STALLED_AFTER_START)"
  Write-Host "[4/4] 배달 자체는 이미 이뤄졌다(dispatch 완료) -- 이 실행을 성공으로 취급하지 마라."
  Write-Host "[4/4] 이 스크립트는 5 로 끝난다(0=정상 진행 · 4=착수확인 인자계약 위반 · 5=착수 확인 결과 미성공)."
  exit 5
}
@@END@@
```

## 5. ⚠️정직 — 이 패치가 «못» 하는 것

- **범위 경계**: 세 분기(codex·CLI 부재·Claude 실행) 내부의 판정 로직은 손대지 않는다 — `dispatch-start-confirm-cli.mjs` 자체가 옳게 4상태를 내는 것은 이미 전제이고(coder-task.md §4), 이 패치는 오직 그 결과의 **소비**만 다룬다.
- **이 지점도 `[2/3] dispatch` 뒤다** — 워커는 **이미 기동됐다**(HYK-378 문서 §5 와 동일 논리). 이 패치가 막는 것은 «배달」이 아니라 **«배달이 성공했다는 보고»** 뿐이다.
- **`3`(STALLED_AFTER_START) 을 별도 코드로 구별하지 않는다** — §3-1 에 근거를 적었다. 이후 소비자가 "멈춤"과 "애초에 시작 안 함"을 기계적으로 구별해야 할 필요가 생기면 그때 별도 라운드로 쪼갠다.
- **재전달 오독 위험**은 HYK-378 문서 §3-1 이 이미 등재한 것과 같은 형태다 — 호출자(사람/ORCH)가 새 종료코드 `5` 를 "재시도하라"는 신호로 잘못 읽을 위험은 이 패치가 해소하지 않는다. 이 문서는 그 위험을 **드러낼 뿐**이다.
- **관제실 live 파일과 이 저장소 fixture 를 계속 같은 값으로 유지하는 것은 시험의 책임 밖**이다 — 그 동기화는 사람/ORCH 가 patch-apply 절차로 수행한다.

## 6. 적용 절차

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 diff 를 눈으로 확인** → 라이브 교체 → 합성 표적으로 1회 구동해 확인(⛔실제 배달로 시험하지 않는다).
3. 되돌림 = 원본 SHA-256 사본 보관.
