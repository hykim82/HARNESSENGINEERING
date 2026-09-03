# HYK-422 패치 «제안» 문서 — D14 stale-dispatch 정리 실패를 화면에 드러낸다

★이 문서는 **제안**이다 — 적용은 사람 게이트 + S7 강화판 검토 뒤에 한다. 이 라운드는 관제실 라이브 파일을 고치지 않는다(coder-task.md §0 "관제실 «라이브» 파일에 손대지 마라").

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` · **SHA-256 `88AEAD564559C1E7214AA8EEFBDF369EF366173C4EC0F89C42F696EF56D2C615`**(CODER 직접 `Get-FileHash` 재계산, 2026-09-03) · 줄끝 **LF**(CRLF 0 · BOM 0, `[System.IO.File]::ReadAllText` + `[regex]::Matches` 직접 실측) · 총 **725줄**(`Get-Content | Measure` 실측).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫 · S7 검토 대상).

## ⓐ 무엇이 문제인가 — 증상·기전·실측 원문 (coder-task.md §1, 2026-09-02 ORCH-52 실측)

**증상**: ORCH 교대로 **새 좌석**이 생기면 그 좌석은 `orca orchestration run-create`로 **새 Run(작업 묶음)**을 만든다. 그런데 앞 Run에 남아 있는 «좌석 배정(dispatch context)»은 **다른 Run 소유**라 지울 권한이 없다:

```
consumer_fenced: This coordinator terminal is bound to run_99c..., not run_2e4...
```

⇒ ★**교대 직후 첫 codex(REVIEW) 배달이 `DISPATCH_FAILED: … already has an active dispatch`로 거부된다.**

**⛔그런데 더 나쁜 것**: 배달기에는 이 상황용 **자동 정리(D14, `dispatch-worker.ps1` 함수 `Invoke-Dispatch`)**가 이미 있는데, 그 줄이 결과를 버린다. 라이브 파일의 실제 코드(59~77행, CODER가 `Get-Content`로 직접 재확인 — coder-task.md의 "72행 부근"이라는 근사 서술과 달리 **정확한 줄 번호는 72행**):

```powershell
# D14(2026-07-22, HYK-162 재발): 파일 핸드셰이크 완료는 Orca dispatch 컨텍스트를 안 푼다.
# 한 좌석은 active dispatch 하나만 가질 수 있어, 같은 좌석 재사용 시 이전(이미 소비된)
# dispatch가 남아 "already has an active dispatch"로 막힌다. → 그 stale task를 완료 처리 후 1회 재시도.
# 안전성: 이 워크플로는 "결과 소비 후에만" 같은 좌석에 재-dispatch하므로 걸려 있는 이전 dispatch는
# 항상 소비 완료분이다(진행 중 태스크를 죽이지 않는다). task-update는 ORCH 분류기에 안 막힘(실측).
function Invoke-Dispatch([string]$task, [string]$to, [bool]$inject) {
  $a = @("orchestration", "dispatch", "--task", $task, "--to", $to)
  if ($inject) { $a += "--inject" }
  $a += "--json"
  $out = (& orca @a | ConvertFrom-Json)
  if ((-not $out.ok) -and ($out.error.message -match 'already has an active dispatch.*for task (task_\w+)')) {
    $stale = $Matches[1]
    Write-Host "      stale active dispatch($stale) 감지 → 완료 처리 후 재시도 (D14)"
    & orca orchestration task-update --id $stale --status completed --json | Out-Null
    Start-Sleep -Milliseconds 400
    $out = (& orca @a | ConvertFrom-Json)
  }
  return $out
}
```

`| Out-Null` 때문에 **정리 실패가 조용히 삼켜지고** 재시도만 한다 ⇒ 화면에는 **두 번째 실패만** 뜨고 **진짜 사유(`consumer_fenced`)는 한 번도 안 보인다.** ORCH가 손으로 캐서야 알았다(coder-task.md §1).

## ⓑ «전/후» 대조 — 바꿀 줄을 그대로 인용

**전** (라이브 72행, 정확히 1줄):

```powershell
    & orca orchestration task-update --id $stale --status completed --json | Out-Null
```

**후** (아래 §패치 단위의 `@@CONTENT@@`와 바이트 동일):

```powershell
    $staleCleanupRaw = (& orca orchestration task-update --id $stale --status completed --json)
    try {
      $staleCleanup = $staleCleanupRaw | ConvertFrom-Json
    } catch {
      $staleCleanup = $null
    }
    if (-not $staleCleanup -or -not $staleCleanup.ok) {
      $staleCleanupReason = if ($staleCleanup) { $staleCleanup.error.message } else { $staleCleanupRaw }
      Write-Host "      stale 정리 실패(HYK-422 -- D14 무음 삼킴 수리, 이전엔 이 사유가 화면에 안 떴다): $staleCleanupReason"
      Write-Host "      다음 행동: 앞 Run 에 run-use 로 붙어 잔여 배정을 닫아라"
    }
```

바뀌는 것은 **1줄 → 9줄**, 함수 `Invoke-Dispatch`의 다른 어떤 줄도 건드리지 않는다. 그 뒤의 `Start-Sleep -Milliseconds 400`과 재시도(`$out = (& orca @a | ConvertFrom-Json)`)는 **원문 그대로** 남는다 — 정리 성공/실패와 무관하게 재시도는 계속된다(coder-task.md §2⑵ⓐ "실패해도 «중단»하지 말고 기존처럼 재시도는 계속").

## ⓒ 왜 이 방식인가 — 대안과 기각 사유

1. **왜 exit/throw로 중단하지 않는가**: 지시(coder-task.md §2⑵ⓐ)가 "동작 변경 최소, 보이게만"을 명시한다. D14의 재시도 자체는 안전하다고 이미 판정돼 있다(함수 헤더 주석: "걸려 있는 이전 dispatch는 항상 소비 완료분이다") — 이 라운드가 새로 검증하거나 뒤집을 대상이 아니다. 정리 실패를 이유로 중단하면 "정리는 실패했지만 재-dispatch는 될 수도 있는" 케이스까지 막아버려 범위 확대가 된다(⛔coder-task.md §2 "하지 말 것 -- 범위 확대").
2. **왜 `Write-Warning`이 아니라 `Write-Host`인가**: 같은 함수 안 바로 위 줄(71행)이 이미 `Write-Host`로 D14 감지 로그를 찍는다 — 같은 채널에 이어 붙여야 사람이 화면에서 "감지 → 정리 실패"를 한 화면에서 순서대로 읽는다. `Write-Warning`은 stderr 스트림이라 호출 방식에 따라 표시가 갈릴 수 있어 기존 관례(이 함수 자신의 71행)를 따른다.
3. **왜 `try/catch`로 JSON 파싱을 감싸는가**: 원래 코드는 `| Out-Null`이라 `task-update`의 stdout이 무엇이든(빈 문자열·비-JSON·크래시 메시지) 문제가 되지 않았다. `ConvertFrom-Json`을 도입하면 그 관용을 깨고 **새로운 실패 모드**(JSON 파싱 예외로 스크립트가 죽는 것)를 만들 위험이 있다 — 이는 "동작 변경 최소" 원칙 위반이다. `try/catch`로 감싸 파싱 실패 시에도 원본 stdout 문자열을 그대로 보여주고 흐름은 그대로 이어간다(⛔새 분기·새 exit 코드 없음).
4. **왜 다음 행동 안내 줄을 넣는가**: coder-task.md §2⑵ⓑ가 "가능하면" 요구했고, ORCH가 이미 이 상황의 해법을 알고 있다(§1의 실측 배경 — "앞 Run에 `run-use`로 붙어 잔여 배정을 닫아라"). 사유만 보여주고 다음 행동을 안 알려주면 사람이 다시 손으로 캐야 한다 — 이 패치가 막으려는 것과 같은 종류의 낭비다.
5. **왜 이 조각을 두 단위로 쪼개지 않는가**: 대체되는 원문이 정확히 1줄이고, 새 코드는 그 자리를 대신하는 하나의 논리 단위(정리 호출 → 파싱 → 실패 시 보고)다. 인위적으로 쪼개면 `control-room-patch-apply.mjs`의 앵커 유일성 검사만 복잡해질 뿐 이득이 없다(HYK-378 §3-3 "두 단위의 앵커가 유일한지" 교훈 — 쪼갤수록 앵커 충돌 위험이 커진다).

## ⓓ 적용 절차 (⛔적용은 이 라운드 밖 · 사람 게이트, HYK-378 §7 형식 계승)

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다(도구가 `--source`를 읽기 전용으로 다룬다).
2. **적용본 diff를 눈으로 확인**(바뀌는 것은 위 ⓑ의 1줄→9줄 뿐임을 확인) → §4 SHA-256 3자 대조(원본/적용본/라이브) → 라이브 교체.
3. 합성 표적으로 1회 구동해 "정리 실패 시 사유가 화면에 뜨는지"를 눈으로 확인(⛔실제 배달로 시험하지 않는다 — 아래 §시험이 이미 이걸 자동화해 두었다).
4. 되돌림 = 원본 SHA-256 사본 보관(이미 이 문서 상단에 지문 기재, 추가로 `scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-before.ps1.txt`가 원본 전체를 바이트 동일 보존).

## §모양 고정(shape-lock) 조사 — 이 줄이 «못 박힌 범위» 안인가 (coder-task.md §2⑶)

**조사 대상**: `scripts/check/seat-proof-wrapper-shape.mjs` / `scripts/check/seat-proof-wrapper-canonical.json` / `scripts/check/control-room-patch-canonical-sync.mjs`.

**실측**:

- `scripts/check/seat-proof-wrapper-shape.mjs:97` — `const FUNCTION_NAME = "Invoke-SeatProofGate";`. 이 상수는 파일 전체에서 함수 이름을 하드코드하는 **유일한 지점**이고(97·131·327·353·361·376·402행, CODER가 `grep -n FUNCTION_NAME`으로 직접 확인), 다른 함수 이름으로 일반화돼 있지 않다.
- `scripts/check/control-room-patch-canonical-sync.mjs:27~32`의 자체 주석: _"this module knows about exactly ONE pinned FUNCTION -- Invoke-SeatProofGate ... extractAllFunctionBodies ... is hard-coded to the name 'Invoke-SeatProofGate' ... it is not parameterizable today"_ — 저장소 자신이 "이 축은 `Invoke-SeatProofGate` 하나만 못 박는다"고 스스로 문서화하고 있다.
- `scripts/check/seat-proof-wrapper-canonical.json`도 `Invoke-SeatProofGate` 본문 하나의 SHA-256만 담는다(HYK-323 선례, `PINNED_FUNCTION_REGISTRY[0].functionName`이 그것 하나뿐).
- 이 패치가 건드리는 함수는 **`Invoke-Dispatch`**다(§ⓐ 실측) — `Invoke-SeatProofGate`가 아니다. `git grep -n "Invoke-Dispatch"`(CODER 실행)로 나온 18개 파일 중 `scripts/check/seat-proof-wrapper-shape.mjs`·`seat-proof-wrapper-canonical.json`·`control-room-patch-canonical-sync.mjs`는 **하나도 없다** — 나머지는 전부 (a) 프로즌 전체-파일 스냅샷 fixture(다른 패치들의 자기 검증용, `Invoke-Dispatch`를 부수적으로 포함할 뿐 그 함수 자체를 못 박지 않음) (b) 인벤토리 JSON 산문(`hyk389-candidate0-inventory.json`) (c) 무관 산문 언급(`orca-spike-runner.mjs`) (d) 이 함수를 부수적으로 언급하는 다른 패치 문서(HYK-299/HYK-327) 뿐이다.

**판정**: `Invoke-Dispatch`(그리고 이 패치가 바꾸는 그 안의 72행)는 **«모양 고정» 범위 밖**이다 — `control-room-patch-canonical-sync.mjs`의 `PINNED_FUNCTION_REGISTRY`에 `Invoke-Dispatch` 항목이 없으므로, 이 문서가 저장소에 커밋돼도 `checkControlRoomPatchCanonicalSync`는 이 문서에 대해 `OK_NOT_APPLICABLE`을 반환한다(문서 텍스트가 `Invoke-SeatProofGate`를 언급하지 않으므로 `judgeDocAgainstPinnedFunction`의 첫 분기에서 즉시 그렇게 판정됨, 코드 512~526행). ⇒ **저장소 정본을 먼저 갱신해야 하는 케이스가 아니다** — 이 라운드가 이 판단을 스스로 검증했다(아래 §시험 "canonical-sync는 이 문서를 OK_NOT_APPLICABLE로 본다").

## ⓔ ⚠️정직 — 이 패치가 «못» 하는 것

- **JSON 파싱이 실패하는 그 밖의 방식**(예: `orca` CLI 자체가 설치돼 있지 않거나 PATH에 없음)은 여전히 PowerShell 수준의 다른 오류(`The term 'orca' is not recognized`)로 이 함수를 죽일 수 있다 — 이 패치는 "`task-update` 호출이 뭔가를 출력했지만 그게 기대한 JSON이 아니거나 `ok:false`인 경우"만 다룬다. CLI 자체의 부재/크래시는 이 조각의 대상이 아니다(⛔범위 확대 금지).
- **정리가 실패해도 재시도는 그대로 진행**하므로, 정리 실패의 근본 원인(다른 Run 소유)이 재시도로 저절로 풀리지는 않는다 — 이 패치는 "사유를 보이게" 할 뿐 "고치는" 패치가 아니다. 근본 수리(예: Run 경계를 넘어 정리할 권한을 만드는 것)는 별건이다(coder-task.md §2가 요구하지 않음, ⛔"Run 자동 생성/삭제 로직 신설" 금지 항목과 정면으로 겹친다).
- **다음 행동 안내 줄("run-use 로 붙어라")은 이 상황(`consumer_fenced`) 전용 문구가 아니라 고정 문자열이다** — `task-update`가 다른 이유(예: 권한 없음, 네트워크 오류)로 실패해도 같은 안내가 뜬다. 사유별로 다른 안내를 골라주는 분기는 이 라운드가 만들지 않는다(범위 최소화, ⓒ-1 참조).
- **라이브 드리프트 감시 없음**: 아래 §시험의 collect 시험은 "저장소 안"의 문서·fixture만 본다 — 관제실의 살아 있는 `dispatch-worker.ps1`은 이 시험 어디서도 열지 않는다(HYK-378 §6 선례와 동일 한계). 라이브가 나중에 이 함수 주변을 바꿔도 이 시험은 계속 초록으로 남는다.
- 이 문서가 제안하는 ps1 9줄 교체는 **설계+시험까지만**이다 — 실제 diff·적용·S7 검토는 별도 라운드/사람 몫이다(coder-task.md §2⑶의 "적용은 이 라운드 밖" 그대로).

## §패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk422-stale-cleanup-visible
mode: replace
@@ANCHOR@@
    & orca orchestration task-update --id $stale --status completed --json | Out-Null
@@CONTENT@@
    $staleCleanupRaw = (& orca orchestration task-update --id $stale --status completed --json)
    try {
      $staleCleanup = $staleCleanupRaw | ConvertFrom-Json
    } catch {
      $staleCleanup = $null
    }
    if (-not $staleCleanup -or -not $staleCleanup.ok) {
      $staleCleanupReason = if ($staleCleanup) { $staleCleanup.error.message } else { $staleCleanupRaw }
      Write-Host "      stale 정리 실패(HYK-422 -- D14 무음 삼킴 수리, 이전엔 이 사유가 화면에 안 떴다): $staleCleanupReason"
      Write-Host "      다음 행동: 앞 Run 에 run-use 로 붙어 잔여 배정을 닫아라"
    }
@@END@@
```

이 문서를 --source scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-before.ps1.txt (라이브 원본 바이트 동일 사본, 위 SHA-256과 일치)에 적용하면 `scripts/check/fixtures/control-room-dispatch-worker-2026-09-03-hyk422-dispatch-run-boundary-applied.ps1.txt`와 바이트 동일 결과가 나온다 — 아래 §시험 ⓐ가 이를 기계로 고정한다.

## §시험 — 무엇을 어떻게 고정했는가 (coder-task.md §2⑷)

- **ⓐ 합성 표적 — "응답이 실패일 때 사유가 출력에 나타난다"**: `scripts/check/control-room-patch-apply-hyk422-effect.test.mjs`가 적용본에서 실제 실행되는 코드 꼬리(위 `@@CONTENT@@` 블록 + 그 뒤의 `Start-Sleep`/재시도 줄, 실제 프로덕션 텍스트를 그대로 슬라이스)를 진짜 `pwsh` 프로세스로 구동한다. 두 개의 스텁 함수(`orca`처럼 동작하는 가짜 함수, 진짜 배달기 아님)로 "`task-update`가 `{"ok":false,"error":{"message":"consumer_fenced: ..."}}`를 돌려주는 경우"와 "`{"ok":true}`를 돌려주는 경우"를 각각 합성해 stdout에 그 사유 문자열(`consumer_fenced`)이 실제로 나타나는지/안 나타나는지를 실측한다.
- **ⓑ "성공일 때 기존과 동작 동일"(회귀 0)**: 같은 행동 시험이 `{"ok":true}` 스텁일 때 "stale 정리 실패" 줄이 **찍히지 않는지**, 그리고 재시도 줄(`Start-Sleep`/재-dispatch 호출)이 정리 성공/실패와 무관하게 **항상** 실행되는지(스텁 카운터로 실측)를 함께 고정한다 — 원본이 `| Out-Null`로 무조건 넘어가던 것과 "재시도는 항상 일어난다"는 관찰 가능 동작이 같다.
- **ⓒ 패치 단위가 적용 도구의 형식 계약을 만족하는가**: `scripts/check/control-room-patch-apply-hyk422-collect.test.mjs`가 (1) 문서가 `control-room-patch-unit` 블록을 정확히 1개 선언하고 `mode: replace`인지 (2) before-fixture SHA-256이 문서 상단에 적은 값과 여전히 같은지(자기 검사) (3) 문서의 단위를 before-fixture에 적용한 결과가 applied-fixture와 **바이트 동일**한지 (4) 정방향/역방향(단위가 1개뿐이라 순서가 없지만 `applyPatchUnits` 경로 자체를 직접 호출해도 같은 결과인지)을 검사한다.
- **§모양 고정 판정의 기계 검증**: `scripts/check/control-room-patch-apply-hyk422-canonical-scope.test.mjs`가 `checkControlRoomPatchCanonicalSync`를 이 문서가 포함된 `docs/control-room-patches/` 디렉터리 전체에 대해 실행해 `OK_NOT_APPLICABLE`(또는 최소한 `CANONICAL_NOT_SYNCED`가 **아님**)을 실측한다 — 위 §모양 고정 절의 "저장소 정본 갱신이 먼저 필요 없다"는 주장이 코드로 뒷받침됨을 보인다.
- **되돌림 변이 ≥3(collect + effect 양쪽)**: 아래 §되돌림 변이 참조 — 문서/fixture 축 2개(앵커 훼손·CONTENT 삭제) + 행동 축 1개(적용본 꼬리를 원문 pre-patch 텍스트로 되돌리면 `consumer_fenced` 같은 사유 문자열이 다시 stdout에서 사라짐을 실측), 총 3개.

## §되돌림 변이 (coder-task.md §2⑸ — 각각 실제로 돌려 RED를 눈으로 봄)

1. **앵커 훼손** (collect): `@@ANCHOR@@` 블록의 `--status completed`를 `--status closed`로 한 글자 이상 바꾸면 `applyControlRoomPatch`가 `ANCHOR_NOT_FOUND`로 거부된다(실측 — 아래 §관측 참조).
2. **CONTENT 삭제** (collect): `@@CONTENT@@` 블록에서 `Write-Host "      stale 정리 실패...` 줄을 통째로 지운 문서로 적용하면, 적용 결과가 committed applied-fixture와 더 이상 바이트 동일하지 않아 collect 시험이 RED가 된다(실측).
3. **행동 축 되돌림** (effect): 적용본의 꼬리를 원문 pre-patch 텍스트(`& orca orchestration task-update --id $stale --status completed --json | Out-Null`)로 되돌린 합성 표적을 구동하면, `{"ok":false,...}` 스텁을 줘도 `consumer_fenced` 문자열이 stdout에 **나타나지 않는다**(원래 버그가 재현됨 — 실측).

★개수 = 이 절에서 밝힌 숫자(3) = 시험 파일 안의 `★되돌림 변이` 표시 테스트 개수(문서 숫자와 바이트 동일 복원 여부는 §시험 파일 참고).

## §정직 한계 — 이 문서 자체가 아는 한계

- 이 문서는 §모양 고정 조사를 **`Invoke-SeatProofGate` 축 하나만** 확인했다 — 관제실 라이브 파일에 이 문서가 모르는 **다른** 못 박기 메커니즘이 있는지는(예: 아직 이 저장소에 이식되지 않은 새 축) 이 라운드가 발견할 수 없다. `git grep -n "Invoke-Dispatch"`로 나온 18개 파일을 전부 사람이 읽었다는 것이 이 조사의 최대치다.
- `staleCleanup.error.message`가 실제로 `consumer_fenced: ...` 형태인지는 **coder-task.md §1의 인용문**(ORCH 실측)을 신뢰한 것이지, 이 라운드가 진짜 `orca orchestration task-update`를 실행해 그 정확한 스키마를 재확인한 것은 아니다(라이브 명령 실행 금지 범위 안 — 합성 표적만 허용됨).
