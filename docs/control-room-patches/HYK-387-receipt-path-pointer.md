# HYK-387 3R 패치 문서 — `dispatch-worker.ps1` 이 해석한 영수증 경로를 **포인터 파일**로 워크트리에 남긴다

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` · **SHA-256 `b62fe264ae5004448d0bf58eb921ed0efb899574560142ae6076c53dcb066596`**(CODER 직접 재계산 확인 · 2026-08-29, HYK-272 적용 후 라이브 지문 — ⚠️2026-08-28 아침 지문 `a0d40e76…`이 아니다) · 줄끝 **CRLF**(`file` 실측: "very long lines" — PowerShell CRLF 그대로) · 총 **676줄**(`wc -l` 실측).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫 · S7 검토 대상).

## 1. 무엇이 문제인가 (3R 실측)

`scripts/check/relay-handshake.mjs`의 `resolveDispatchRecordExistence`(HYK-387 1R/2R)는 "이 라운드의 배정 기록이 원장에 있는가"를 확인하지만, 그 원장 경로(`$ReceiptPath`)를 알 방법이 오늘 라이브에는 없다:

- 라이브 배달기 `dispatch-worker.ps1` 43~~46행/170~~172행은 이미 `DISPATCH_RECEIPT_PATH` 환경변수(또는 `-ReceiptPath` 인자)로 그 경로를 해석한다 — 3R은 소비 쪽 이름을 이 이름으로 맞췄다(같은 파일을 가리키는 같은 개념, 이름을 새로 만들지 않았다).
- 그런데 **이 ps1은 완료를 감시하는 쪽(`watch-result.mjs`/`checkRelayHandshake`)을 전혀 부르지 않는다** — 배달과 착수 확인(exit 0~5)까지만 하고 끝난다(CODER 직접 grep + 파일 정독 확인: 이 스크립트 안에 `watch-result`/`checkRelayHandshake` 문자열 0건). 그 감시는 사람/ORCH가 **별도 터미널**에서 손으로 돌리는 것으로 보인다.
- 환경변수 하나만으로는 그 프로세스 경계를 넘을 방법이 없다 — 자식 프로세스(`node dispatch-receipt-cli.mjs`)의 env는 부모 셸에 역전파되지 않고, Windows 영속 env(`[Environment]::SetEnvironmentVariable(..., "User")`, 레지스트리 기록)는 §0이 경계하는 "확인창 유발·시스템 뮤테이션" 위험을 새로 만든다 — 이 라운드는 그 경로를 채택하지 않는다.

## 2. 불변식

> **P**: 배달기가 실제로 해석한 영수증 파일 경로는, 그 라운드의 워크트리 안 어딘가에 **기계가 읽을 수 있는 형태로 남는다** — 사람이 손으로 env를 다시 세팅할 필요가 없어야 한다.

## 3. 설계 — 포인터 파일 (레지스트리·env 영속화 대신)

배달기가 `$ReceiptPath`를 해석한 **직후**(라이브 170~172행), 그 값을 **바로 이 라운드의 `$Worktree`**(=소비 쪽 `harnessDir`의 부모, 소비 쪽이 매 호출마다 이미 받는 유일한 앵커) 안 `.harness/dispatch-receipt-path.txt`에 한 줄로 적는다. 소비 쪽(`resolveDispatchLedgerPath`, `scripts/check/relay-handshake.mjs`)은 그 파일을 **read-only**로 참조하는 세 번째 fallback 단계를 이미 갖고 있다(명시 인자 > env `DISPATCH_RECEIPT_PATH` > 이 포인터 파일 > 스킵).

**이 설계를 고른 이유(버린 대안과 비교)**:

- **env만으로 충분한가** — 아니다(§1). 별도 터미널로 값이 전파되지 않는다.
- **Windows 영속 env(`SetEnvironmentVariable "User"`)** — 레지스트리 기록은 확인창을 띄우지 않지만 시스템 전역 상태를 바꾸는 뮤테이션이고, 이미 열려 있는 터미널에는 반영되지 않으며(새 프로세스부터 적용), 되돌리기(원상복구)도 이 저장소 시험이 검증할 수 없는 영역이다 — §0 "확인창 유발 명령 회피·실물 곁파일 무접촉"과 같은 급의 위험.
- **소비 쪽 기본 경로 자동 추정**(`mainRepoRoot()/.harness/...`류) — 2R이 이미 기각한 설계(기존 회귀 시험 수백 개가 우연히 그 경로와 충돌할 위험, coder-task.md 2R §3-1 근거 그대로).
- **포인터 파일**(채택) — 배달기와 소비 쪽이 이미 공유하는 유일한 값(`$Worktree`=`harnessDir`의 부모)에만 의존한다. 시험 격리에 새 ambient 상태가 필요 없다(mkdtemp 픽스처 디렉터리 안에 파일을 두거나 안 두는 것만으로 완전히 격리됨, §6 참조).

## 4. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk387-receipt-path-pointer
mode: insert_after
@@ANCHOR@@
if (-not $ReceiptPath) {
  $ReceiptPath = if ($env:DISPATCH_RECEIPT_PATH) { $env:DISPATCH_RECEIPT_PATH } else { Join-Path $PSScriptRoot "dispatch-receipts.jsonl" }
}
@@CONTENT@@

# HYK-387 3R(코더 레인 · S7): 소비 쪽(scripts/check/relay-handshake.mjs의
# resolveDispatchLedgerPath)이 이 라운드의 배정 기록이 원장에 실제로
# 있는지 확인하려면 방금 해석한 $ReceiptPath 값을 알아야 한다. 이
# 배달기는 완료 감시(watch-result.mjs 등)를 직접 부르지 않으므로(grep
# 실측 0건) env 하나로는 그 별도 프로세스 경계를 넘길 수 없다 -- 대신
# 이 라운드의 $Worktree(소비 쪽 harnessDir의 부모, 둘 다 이미 아는 유일한
# 공유 앵커) 안에 포인터 파일 한 줄을 남긴다. 실패해도 배달을 막지
# 않는다(비치명적) -- 이 축의 존재 여부는 소비 쪽의 fail-closed 판정
# 몫이지, 배달을 막는 새 게이트가 아니다.
try {
  $receiptPointerDir = Join-Path $Worktree ".harness"
  if (-not (Test-Path -LiteralPath $receiptPointerDir)) {
    New-Item -ItemType Directory -Path $receiptPointerDir -Force | Out-Null
  }
  $receiptPointerPath = Join-Path $receiptPointerDir "dispatch-receipt-path.txt"
  Set-Content -LiteralPath $receiptPointerPath -Value $ReceiptPath -Encoding utf8 -NoNewline
} catch {
  Write-Warning "HYK-387 3R: dispatch-receipt-path.txt 포인터 기록 실패(비치명적, 배달은 계속): $($_.Exception.Message)"
}
@@END@@
```

## 5. ⚠️정직 — 이 패치가 «못» 하는 것

- **진위(authenticity)는 여전히 범위 밖** — 이 포인터 파일도, 그것이 가리키는 원장 항목도 위조 가능하다(HYK-390 몫, 1R/2R과 동일한 의도된 범위 한계). 이 축은 "값이 어디 있는지"만 옮길 뿐 "그 값이 진짜인지"는 보지 않는다.
- **완료 감시 프로세스 자체는 여전히 자동화돼 있지 않다** — 사람/ORCH가 여전히 손으로 소비 명령을 돌려야 한다(그 명령이 이제 포인터 파일을 통해 올바른 원장을 «찾을 수 있게» 됐을 뿐, 그 명령 자체를 자동으로 트리거하지 않는다). 완전 무인화는 별건이다.
- **포인터 파일이 stale해질 수 있다** — 같은 워크트리에 여러 라운드(CODER→REVIEW→CODER…)가 이어지면, 포인터 파일은 "가장 최근 배달"의 경로만 담는다(덮어쓰기, append 아님). 여러 배달이 서로 다른 영수증 경로를 쓰는 상황(오늘은 없음, `$ReceiptPath` 해석 로직 자체가 워크트리당 하나로 수렴)이 생기면 이 설계는 재검토가 필요하다.
- **관제실 파일은 이 저장소 CI가 검증하지 않는다** — fixture 지문 대조가 유일한 드리프트 방어다(§0 급소 4, 아래 §6과 동일 한계).

## 6. ⚠️정직 — collect·effect 시험의 한계

- **collect 시험**(`control-room-patch-apply-hyk387-receipt-pointer-collect.test.mjs`)은 "문서가 파싱되고 fixture를 바이트 동일하게 재현하는가"만 본다 — 관제실 라이브 파일을 열지 않는다. 라이브 파일이 나중에 이 앵커와 다르게 바뀌어도(또는 이 단위가 통째로 삭제돼도) 이 시험은 그 사실을 알 도리가 없고 계속 초록으로 남는다.
- **effect 시험**(`control-room-patch-apply-hyk387-receipt-pointer-effect.test.mjs`)은 적용본에서 실제로 실행되는 PowerShell 코드 조각(합성 `$Worktree`/`$ReceiptPath`, 실제 배달 아님)을 `pwsh`로 구동해 포인터 파일이 실제로 쓰이는지 실측한다. 이 행동 축조차 PowerShell 언어 자체(`Set-Content`, `Join-Path`)의 의미를 검증하지 않는다 — pwsh 런타임 자체가 이미 신뢰된 전제다.
- **소비 쪽 fallback 시험**(`scripts/check/hyk387-3r-receipt-pointer.test.mjs`)은 이 패치 문서와 별개로 `resolveDispatchLedgerPath`가 포인터 파일을 실제로 읽는지 확인한다 — 두 시험을 합쳐야 "배달기가 적고 → 소비 쪽이 읽는다"는 전체 경로가 증명된다(어느 한쪽만으로는 절반이다).

## 7. 적용 절차

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 diff를 눈으로 확인** → 라이브 교체 → 합성 표적으로 1회 구동해 확인(⛔실제 배달로 시험하지 않는다).
3. 되돌림 = 원본 SHA-256 사본 보관(이 문서 맨 위 `b62fe264…`).
