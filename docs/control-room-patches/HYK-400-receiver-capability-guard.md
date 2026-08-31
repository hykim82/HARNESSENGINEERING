# HYK-400 2R 패치 문서 — 배달 전 수신부 capability guard

앵커 원본 = `scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-applied.ps1.txt` · SHA-256 `3fb935694ecb65b2e636d2ac78765232380870e05915a30b6a0bd4971b5e6a5f` · 695줄 · LF. 적용은 `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <사본> --out <적용본>`으로만 합성 출력에 수행하며, 라이브 관제실 파일은 쓰지 않는다.

## 0. 위협 모델 (5R 확정 — 1R~4R 4연속 반려의 원인이 여기 있었다)

1R부터 4R까지 매 라운드 검토가 "더 뚫어라"는 암묵 전제로 악의적 대상을 가정해 반려했고, 검토는 그때마다 옳게 일했다(4R은 대상이 전역 `JSON.stringify`를 덮어써 러너의 정당한 `writeResult()`가 위조 응답을 `wx` 파일에 쓰게 만드는 것까지 실증했다 — child는 exit 0으로 깨끗이 끝나고 부모 판정은 `ok:true, supported:true`가 됐다). 그런데 이 가드가 실제로 막아야 하는 대상은 처음부터 **악의적 코드가 아니라 우리 저장소의 «옛 커밋» 체크아웃**이었다 — 오늘 실사고 2회의 실체는 둘 다 "워크트리 갱신을 잊고 배달"이었지, 공격이 아니었다. 이 절이 그 위협 모델을 문서에 못박는다(책임자 판단 2026-08-31, 제안 A 승인).

- **막는 것** = 낡은(stale) 워크트리로의 배달. 대상 워크트리의 `dispatch-receipt-cli.mjs`가 아직 새 인자(`--harness-dir` 등)를 모르는 옛 커밋 기준이면, 배달 전에 fail-closed로 거부한다 — 이게 이 가드의 유일한 존재 이유다(§1 "문제" 참조).
- **안 막는 것** = 대상이 **적극적으로 속이려 드는 경우**. 대상 코드는 격리 child 안에서일지언정 여전히 러너와 **같은 프로세스**에서 import된다(I1의 전제 그대로) — 전역을 오염시키거나(위 `JSON.stringify` 사례), 응답 파일 경로를 알아내 선점하거나, 그 밖의 같은-프로세스 트릭으로 판정을 속이려 드는 상대는 이 가드의 방어 범위 밖이다.
- **근거 실측(4R 독립 검토, 인용 1줄)**: "대상이 전역 `JSON.stringify`를 덮어쓰자 러너의 정당한 `writeResult()`가 위조 응답을 `wx` 파일에 썼고(child exit 0), 부모 판정이 `ok:true, supported:true`가 됐다." ⇒ 같은 프로세스에서 import하는 한 어떤 자식의 답도 완전히는 신뢰할 수 없다는 실증이다.
- ★**정직 경계(원문)**: _"악의적 대상 앞에서는 이 가드보다 더 쉬운 우회가 존재한다(가드 파일 삭제 등) — 진짜 해법은 OS 권한 분리이며 그것은 HYK-89의 범위다."_
- **이것은 결함이 아니라 범위 밖이다.** 위 `JSON.stringify` 시나리오·process.argv 사이드채널(§6 I-ROOT 정직 한계 참조)을 포함해 "같은 프로세스 안에서 대상이 스스로를 위조한다"는 부류의 공격 전부가 여기 해당한다. 1R 문서(§8, 이후 §6으로 이어짐)가 이미 "의도적 우회는 범위 밖 · 진짜 해법은 OS 권한 분리(HYK-89)"라고 적어 뒀던 그 경계를, 5R은 매 라운드 반려의 실제 원인이었음을 확인하고 명시적인 절로 승격했을 뿐이다 — 코드 동작은 4R 그대로다(이번 라운드는 문서만 바꾼다).

## 1. 문제와 2R 불변식

`dispatch-worker.ps1`은 master의 CLI가 아니라 배달 대상 워크트리의 `scripts/relay/dispatch-receipt-cli.mjs`를 자식 프로세스로 부른다. 파일이 존재한다는 사실만 확인하면 구버전 수신부가 `--harness-dir`를 거부하는 것을 실제 배달 후에야 알게 되어 `unrecognized flag`와 `RECEIPT_FAILED`가 난다.

이번 수리는 다음 불변식을 코드와 적대 테스트로 고정한다.

- **I1 격리**: 가드는 대상 코드를 자기 프로세스에서 import하지 않고, `node --permission --allow-fs-read=<worktree>`로 실행한 격리 child process에서만 import/호출한다. child crash, timeout, protocol 오류, 권한 밖 side effect는 모두 거부한다.
- **I2 의미**: `ok: true`나 문자열 언급만으로 통과하지 않는다. baseline과 실제 delivery flag 호출을 무작위 sentinel로 대조해, 넘긴 값이 응답에 실제로 반영되고 role/task-label/receipt-path의 의미도 보존되는지 확인한다.
- **I3 경계**: receiver의 realpath가 realpath된 worktree 내부여야 하며, 다른 repo로 빠지는 symlink/path escape는 거부한다.
- **I4 우회 제거**: required flag 집합은 caller가 고르는 값이 아니라 실제 배달 인자 배열에서 필수 3필드를 제외하고 유도한다. 빈/불완전한 delivery args는 거부하며 `NO_FLAG_REQUESTED` 분기는 없다.
- **I5 종료코드 도달성**: 가드 CLI 없음은 `Write-Host` 뒤 `exit 10`으로 종료한다. `$ErrorActionPreference = "Stop"`에서 `Write-Error`가 선행해 exit 10을 삼키는 형태를 쓰지 않는다.

## 2. 판단 기준

가드(`scripts/check/hyk400-receiver-guard.mjs`)는 실제 배달 인자 배열을 `--delivery-arg`로 그대로 받아, 그 안에서 선택 flag를 유도한 뒤 다음 두 합성 호출을 child에서 수행한다.

```text
parseDispatchReceiptArgs([--role, <random role>,
  --task-label, <random label>, --receipt-path, <random receipt>,
  --harness-dir, <random sentinel>],
  {}
)
```

baseline 호출과 flag 포함 호출 모두의 `role`, `harnessTaskLabel`, `receiptPath`가 무작위 기준값과 일치해야 한다. `--harness-dir` 포함 응답의 `harnessDir`가 sentinel을 정확히 운반할 때만 `supported:true`다. 따라서 다른 필드에 값을 넣은 parse-success, 문자열/주석만 있는 파일, 필수 export가 없는 파일은 capability가 아니다.

child는 worktree 읽기만 허용된 Node permission 모드로 실행되므로 대상 모듈의 top-level 쓰기/child spawn은 import 실패가 된다. child는 5초 안에 끝나야 하고, timeout/crash/비 JSON 응답은 모두 fail-closed다.

## 3. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk400-receiver-capability-guard
mode: insert_after
@@ANCHOR@@
if (-not (Test-Path $receiptCliPath)) {
  Write-Error "RECEIPT_CLI_MISSING: $receiptCliPath 가 없다 -- 영수증을 남길 수 없으므로 dispatch를 만들지 않는다(HYK-219 2R §1, 반쪽 배달 방지). 이 CLI를 포함한 브랜치로 워크트리를 갱신한 뒤 재시도하라."
}
@@CONTENT@@
# HYK-400 2R: 대상 워크트리의 수신부를 배달 전에 실제 delivery args 기준으로
# 확인한다. caller가 flag 집합을 고르거나 비워 검사를 생략할 수 없다.
$receiverGuardCliPath = Join-Path $Worktree "scripts/check/hyk400-receiver-guard.mjs"
if (-not (Test-Path $receiverGuardCliPath)) {
  Write-Host "RECEIVER_GUARD_CLI_MISSING: $receiverGuardCliPath 가 없다 -- 수신부 capability를 확인할 수 없으므로 dispatch를 만들지 않는다(HYK-400 fail-closed). 워크트리를 갱신한 뒤 재시도하라."
  exit 10
}
$receiverGuardDeliveryArgs = @(
  "--role", $Role,
  "--task-label", $label,
  "--receipt-path", $ReceiptPath,
  "--harness-dir", (Join-Path $Worktree ".harness")
)
$receiverGuardArgs = @("--worktree", $Worktree)
foreach ($deliveryArg in $receiverGuardDeliveryArgs) {
  $receiverGuardArgs += @("--delivery-arg", $deliveryArg)
}
$receiverGuardOut = & node $receiverGuardCliPath @receiverGuardArgs 2>&1
$receiverGuardExit = $LASTEXITCODE
foreach ($line in @($receiverGuardOut)) { Write-Host "      $line" }
if ($receiverGuardExit -ne 0) {
  Write-Error "RECEIVER_CAPABILITY_REJECTED: 대상 워크트리의 수신부가 --harness-dir capability를 충족하지 않는다(exit $receiverGuardExit, 위 출력의 사유 참고) -- 실제 영수증 호출 전에 멈춘다(fail-closed). 워크트리를 갱신한 뒤 재시도하라."
}
@@END@@
```

앵커 자체는 원본에 남고 `@@CONTENT@@`에는 삽입 블록만 둔다. 따라서 적용 결과에 `RECEIPT_CLI_MISSING` 블록이 두 번 생기지 않는다.

## 4. 종료코드

기존 fixture의 exit 0–9는 그대로 보존한다. 새 코드 10은 가드 CLI 자체가 없는 경우에만 쓴다. 가드가 존재하지만 capability를 거부하면 기존 `$ErrorActionPreference = "Stop"` 관례에 따라 `Write-Error`의 실제 exit 1을 사용한다. 테스트는 synthetic PowerShell에서 missing guard 블록을 실행해 exit 10이 실제로 도달하는지 먼저 확인한다.

## 5. 적대 표본과 rollback 변이

`scripts/check/hyk400-receiver-guard.test.mjs`는 다음 표본을 각각 임시 worktree에서 실행한다.

| 표본                                  | 기대 결과                                                       |
| ------------------------------------- | --------------------------------------------------------------- |
| top-level 파일 쓰기                   | child 격리 경로 side effect로 거부, 대상 worktree sentinel 부재 |
| 무한 top-level await                  | 5초 timeout으로 거부                                            |
| 다른 의미의 `--harness-dir`           | parse-success여도 semantic reject                               |
| 다른 repo를 가리키는 receiver symlink | symlink/realpath 경계 reject                                    |
| 문자열만 `--harness-dir` 언급         | semantic reject                                                 |
| syntax 오류 / export 없음 / 파일 없음 | import·contract·missing reject                                  |
| guard CLI 없음                        | synthetic exit 10                                               |

각 표본의 guard 축을 끈 상태가 통과하면 테스트가 RED가 되어야 한다. Q4 rollback 테스트는 guard를 우회해 구버전 CLI를 직접 호출하고 원래의 `FAILED reason=unrecognized flag '--harness-dir'`를 byte 단위로 재현한다. 즉 격리·의미·경계·필수 인자·종료코드 축을 임의로 되돌리면 해당 assertion이 즉시 깨지는 구조다.

## 6. 정직한 한계와 적용 절차

- child process는 OS 보안 sandbox가 아니다. 절대 경로로 의도적으로 외부에 쓰는 악성 코드는 이 축만으로 완전히 차단한다고 주장하지 않는다. 이 작업의 핵심은 guard 프로세스에서 target code를 실행하지 않고, 상대 side effect와 모든 판정 불확실성을 거부하는 것이다. `--permission` 모델은 네트워크 접근을 통제하지 않는다 -- fs 쓰기·child_process·worker는 막지만, 대상이 네트워크로 뭔가를 유출/호출하는 것은 이 축의 범위 밖이다.
- 확인과 실제 영수증 호출 사이의 TOCTOU, 라이브 관제실 파일의 CRLF 여부, 고의적인 guard CLI 삭제는 이 패치의 범위 밖이다.
- **2R이 실측으로 새로 발견한 부수 사실(이 패치의 직접 범위는 아니다)**: `$ErrorActionPreference = "Stop"` 아래에서 `Write-Error` 뒤에 오는 명시적 `exit N`은 전부 도달 불가능하다 -- 이번 라운드가 pwsh로 직접 재현해 확인했다(§4, ⓖ/I5 테스트). 이 패턴은 이 패치가 새로 만든 게 아니라 원본 fixture(`ARG_CONTRACT_CLI_MISSING` exit 9, `WRAPPER_SHAPE_CLI_MISSING` exit 9 등)에 이미 존재한다 -- 즉 그 두 자리의 실제 관측 종료코드도 문서상 9가 아니라 암묵 1일 가능성이 높다(직접 검증은 안 했다, `dispatch-worker.ps1` 다른 부분을 건드리는 것은 이 라운드 범위 밖이다). ORCH/다음 라운드가 판단할 몫으로 남긴다 -- 고쳐야 한다면 이 패치가 쓰는 `Write-Host` + `exit N` 형태로 통일하는 것을 제안한다.
- 적용자는 합성 출력의 diff와 줄끝을 확인한 뒤 라이브 교체해야 한다. 지원 receiver와 구버전 fixture를 각각 합성 표적으로 실행하고, 원본 fixture SHA-256을 보존한다.
