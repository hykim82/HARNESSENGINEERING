# HYK-400 1R 패치 문서 — `dispatch-worker.ps1`이 배달 전에 대상 워크트리의 수신부 능력을 확인한다

**앵커를 자른 사본** = `scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-applied.ps1.txt`(HYK-396 1R이 만든 사본을 그대로 원본으로 쓴다 — 이 패치의 앵커(`$receiptCliPath` 존재 확인 블록)는 HYK-396이 건드린 영역(`Record-DispatchReceipt` 함수 안 `$cliArgs` 줄, 이 블록보다 8줄 뒤)보다 앞이라 겹치지 않는다) · **SHA-256 `3fb935694ecb65b2e636d2ac78765232380870e05915a30b6a0bd4971b5e6a5f`**(CODER 직접 재계산 확인 · 2026-08-30) · 총 **695줄**(`wc -l` 실측) · 줄끝 **LF**(이 사본 자체가 LF로 저장돼 있다 — 라이브 파일이 CRLF일 가능성은 HYK-387/HYK-396 문서의 경고와 동일하게 남아 있다, §5 참조).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out`만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫).

## 0. 이 패치의 전제 — HYK-396의 라이브 적용 여부와 무관

이 패치의 앵커(`$receiptCliPath` 의 `Test-Path` 실패 블록, 312-315행)는 HYK-396 패치가 건드린 `Record-DispatchReceipt` 함수 본문(323행 이후, `$cliArgs` 줄)보다 **앞**이다 — 두 패치는 서로 다른 텍스트 구간을 건드리므로 어느 쪽이 먼저 라이브에 적용되든 충돌하지 않는다. 다만 오늘 실사고(coder-task.md §1)는 **HYK-396의 `--harness-dir` 인자가 이미 라이브에 적용된 뒤** 벌어졌으므로(관제실이 옛 워크트리로 그 인자를 넘겨 `unrecognized flag`로 깨짐), 이 문서의 "before" 사본도 HYK-396 "applied" 상태를 원본으로 삼는 것이 오늘 상황과 가장 가깝다.

## 1. 무엇이 문제인가 (coder-task.md §1)

관제실 배달기(`dispatch-worker.ps1`)는 **자신이 실행 중인 프로세스 기준(master)이 아니라, 배달 대상 워크트리 안의** `scripts/relay/dispatch-receipt-cli.mjs`를 자식 프로세스로 부른다(코드 실측, 배달기 312행 `$receiptCliPath = Join-Path $Worktree ...`). 오늘 HYK-396 패치(`--harness-dir` 인자 추가)를 배달기에 적용한 직후, 그 인자를 아직 모르는 옛 워크트리로 배달을 시도하자 다음과 같이 깨졌다:

```
FAILED reason=unrecognized flag '--harness-dir'
RECEIPT_FAILED
```

배달기는 대상 워크트리가 새 인자를 지원하는지 배달 **전**에는 전혀 확인하지 않는다 — 오직 파일이 "있는지"만 본다(313행 `Test-Path $receiptCliPath`). 파일은 있지만 **구버전**이면, 그 사실은 실제로 CLI를 불러 실패시켜 봐야만 드러난다 — 이미 dispatch가 만들어진 뒤다("반쪽 배달", coder-task.md §1 인용 기각 대상).

## 2. 불변식

> **P**: 배달기는 대상 워크트리의 수신부(`dispatch-receipt-cli.mjs`)가 이번 배달에 필요한 인자를 실제로 아는지, 배달 **전**에 기계로 확인한다. 모르면 명확한 사유로 **거부**(fail-closed)한다.
> ⛔조용히 인자를 빼고 진행하지 않는다(반쪽 배달 금지) · ⛔확인 자체가 실패해도(파일 없음·읽기 실패·계약 불일치) 통과시키지 않는다(fail-open 금지).
> P′(회귀 0): 이번 배달이 애초에 그 인자를 요구하지 않으면(현재는 해당 없음 — `Record-DispatchReceipt`가 `--harness-dir`를 항상 보낸다, HYK-396 §3 그대로) 확인 자체를 건너뛰고 통과한다 — "확인할 게 없음"과 "확인이 실패함"은 다른 상태다.

## 3. 왜 여기(`$receiptCliPath` 존재 확인 직후)인가

- 이 지점은 이미 "대상 워크트리에 수신부 CLI가 있는지"를 배달 전에 확인하는 자리다(HYK-219-receipts-2 §1, 313행). "있는가"와 "필요한 인자를 아는가"는 같은 축의 두 단계이며, 같은 자리에서 이어 확인하는 것이 자연스럽다 — 새 호출 지점을 따로 만들 필요가 없다.
- `Record-DispatchReceipt` 함수 자체(323행 이후)는 CODER/REVIEW/VERIFY/PM, claude/codex 두 경로 양쪽에서(513행·529행) 각각 호출된다. 각 호출 직전마다 확인을 반복하면 중복이다 — 두 호출 경로가 갈라지기 «전», 공통 지점에서 한 번만 확인하면 양쪽을 다 덮는다(ARG_CONTRACT·WRAPPER_SHAPE와 동일한 배치 원칙, 위쪽 코드 참조).
- 판정 로직(Q1, `scripts/check/hyk400-receiver-guard.mjs`)은 저장소 안에 있다 — 관제실은 그 CLI를 부르고 종료코드로만 분기하는 얇은 껍데기다(HYK-217/HYK-319/HYK-323과 동일 원칙, "판단은 저장소, 관제실은 껍데기").

**이 설계를 고른 이유(버린 대안과 비교)**:

- **"실행해 보고 실패하면 되돌린다"** — 기각. `dispatch-receipt-cli.mjs`는 성공 시 영수증을 append-only로 기록한다(부작용). 실패를 유도해 능력을 확인하려면 그 부작용이 실제로 일어날 위험을 감수해야 한다(예: 인자 조합에 따라 일부는 통과해 실제 append가 될 수 있음). Q1은 대신 **순수 함수 호출**(대상 파일을 import해 `parseDispatchReceiptArgs`만 부름, 파일시스템 접근 0)로 부작용 없이 같은 답을 얻는다 — §1-Q1 근거는 `scripts/check/hyk400-receiver-guard.mjs` 자신의 헤더 주석 참조.
- **정적 텍스트 검사(정규식으로 파일 내용에서 플래그 문자열 검색)** — 기각. 주석·문서 문자열에도 걸려 오탐한다(`dispatch-receipt-cli.mjs` 자신의 USAGE 문자열·헤더 주석이 이미 `--harness-dir`를 언급한다 — 파서가 실제로 그 플래그를 인식하는지와 무관하게 텍스트만으로는 참/거짓을 가릴 수 없다).
- **관제실(ps1) 쪽에 판정 로직을 직접 심기** — 기각. 관제실은 CI 검증 대상이 아니다(이 저장소 CI가 검증하는 것은 fixture 지문 대조뿐, HYK-217 문서와 동일 한계) — 판단 로직을 두면 그 로직 자체의 버그를 이 저장소 CI가 못 잡는다.

## 4. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk400-receiver-capability-guard
mode: insert_after
@@ANCHOR@@
if (-not (Test-Path $receiptCliPath)) {
  Write-Error "RECEIPT_CLI_MISSING: $receiptCliPath 가 없다 -- 영수증을 남길 수 없으므로 dispatch를 만들지 않는다(HYK-219 2R §1, 반쪽 배달 방지). 이 CLI를 포함한 브랜치로 워크트리를 갱신한 뒤 재시도하라."
}
@@CONTENT@@
if (-not (Test-Path $receiptCliPath)) {
  Write-Error "RECEIPT_CLI_MISSING: $receiptCliPath 가 없다 -- 영수증을 남길 수 없으므로 dispatch를 만들지 않는다(HYK-219 2R §1, 반쪽 배달 방지). 이 CLI를 포함한 브랜치로 워크트리를 갱신한 뒤 재시도하라."
}

# HYK-400(coder-task.md §1-2, 오늘 실사고 2회): 배달기는 "대상 워크트리의"
# 영수증 CLI를 부른다(바로 위 $receiptCliPath) -- 그 워크트리가 옛 커밋
# 기준이면 그 CLI는 새 인자(--harness-dir)를 모른 채로 불려 배달 «후»에야
# `unrecognized flag`로 깨진다(RECEIPT_FAILED, 오늘 실측). 배달 «전»에,
# 대상 워크트리가 이 인자를 실제로 아는지 기계로 확인한다(HYK-400 P:
# fail-closed, 부작용 없는 판정 -- scripts/check/hyk400-receiver-guard.mjs
# 자신의 정직 한계 주석 참조). ⛔확인 자체가 실패해도 통과시키지 않는다.
$receiverGuardCliPath = Join-Path $Worktree "scripts/check/hyk400-receiver-guard.mjs"
if (-not (Test-Path $receiverGuardCliPath)) {
  Write-Error "RECEIVER_GUARD_CLI_MISSING: $receiverGuardCliPath 가 없다 -- 대상 워크트리가 --harness-dir를 아는지 확인할 수 없으므로 dispatch를 만들지 않는다(HYK-400 기계 게이트, fail-closed). 이 CLI를 포함한 브랜치로 워크트리를 갱신한 뒤 재시도하라."
  exit 10
}
$receiverGuardOut = & node $receiverGuardCliPath --worktree $Worktree --flag "--harness-dir" 2>&1
$receiverGuardExit = $LASTEXITCODE
foreach ($line in @($receiverGuardOut)) { Write-Host "      $line" }
if ($receiverGuardExit -ne 0) {
  Write-Error "RECEIVER_CAPABILITY_REJECTED: 대상 워크트리의 dispatch-receipt-cli.mjs가 --harness-dir를 모른다(exit $receiverGuardExit, 위 출력의 사유 참고) -- 옛 커밋 기준 워크트리로 배달하면 배달 후에야 'unrecognized flag'로 깨진다(오늘 실사고). 실제로 부르기 전에 멈춘다(fail-closed). 워크트리를 갱신한 뒤 재시도하라."
}
@@END@@
```

## 5. 종료 코드 — 전체 목록 먼저 실측 (HYK-391 판례)

패치 전 `scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-applied.ps1.txt`에서 실측한 `exit N` 전량(⛔새 번호를 고르기 전에 먼저 셌다):

| exit code | 의미                                                                                                                                                                                                                                                        | 근거 줄                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 0         | 성공(암묵, PowerShell 기본)                                                                                                                                                                                                                                 | —                                    |
| 1         | `$ErrorActionPreference = "Stop"`(49행) 하에서 `Write-Error`가 뒤이은 명시적 `exit`문 없이 스크립트를 종료시킬 때의 **암묵 기본값**(예: `ARG_CONTRACT_REJECTED`·`GATE_REJECTED`·`CAP_REJECTED`·`WRAPPER_SHAPE_REJECTED`·`RECEIPT_CLI_MISSING` 전부 이 경로) | 234·243/248·263·280-281·313-314행 등 |
| 2         | Worktree 경로 비어 있음                                                                                                                                                                                                                                     | 96행                                 |
| 3         | `terminal list` 실패                                                                                                                                                                                                                                        | 100행                                |
| 4         | (두 곳: 조기 인자 오류류 · 후반부 별도 실패)                                                                                                                                                                                                                | 110행·681행                          |
| 5         | (두 곳: 조기 인자 오류류 · 후반부 별도 실패)                                                                                                                                                                                                                | 137행·694행                          |
| 6         | `DISPATCH_FAILED`(두 호출 경로 공통)                                                                                                                                                                                                                        | 511·527행                            |
| 7         | `SEAT_PROOF_REJECTED`(두 호출 경로 공통)                                                                                                                                                                                                                    | 119·519·535행                        |
| 8         | (별도 실패 지점)                                                                                                                                                                                                                                            | 478행                                |
| 9         | `ARG_CONTRACT_CLI_MISSING` · `WRAPPER_SHAPE_CLI_MISSING`(CLI 자체 부재, fail-closed)                                                                                                                                                                        | 228·298행                            |

⇒ **미사용**: 10 이상. 이 패치는 `RECEIVER_GUARD_CLI_MISSING`(가드 CLI 자체가 없음)에 **새 번호 `exit 10`**을 쓴다 — 9와 동일 계열("이 배달을 판정할 저장소 CLI가 아예 없다")이지만 9는 이미 두 목적(ARG_CONTRACT·WRAPPER_SHAPE)에 쓰이고 있어 재사용하면 사유 구분이 흐려진다. `RECEIVER_CAPABILITY_REJECTED`(가드는 있지만 대상이 미지원으로 판정됨)는 **새 번호를 만들지 않는다** — `ARG_CONTRACT_REJECTED`·`GATE_REJECTED`·`CAP_REJECTED`·`WRAPPER_SHAPE_REJECTED`와 같은 계열(암묵 exit 1, `Write-Error` + `$ErrorActionPreference=Stop`)을 그대로 따른다.

## 6. Q3 표본표 (`scripts/check/hyk400-receiver-guard.test.mjs`가 실증)

| 표본               | 입력                                                                                                                                                                                                                                | 기대                                                                                                                                   | 실증 테스트        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| ⓐ 지원 워크트리    | `--harness-dir`를 아는 워크트리(이 저장소 자신)                                                                                                                                                                                     | `supported:true` → 배달기 exit 0 계속                                                                                                  | `Q3-a`, `Q3-a CLI` |
| ⓑ 미지원 워크트리  | HYK-396 이전 `dispatch-receipt-cli.mjs`(커밋 `8ac19a0`, 이 문서의 자매 fixture `scripts/check/fixtures/hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt`, SHA-256 `1a5a93bb3bec01b4d3222a637de375330c7a0909b712b877b571b47486fda5ec`) | `supported:false`, 사유 문구에 `unrecognized flag '--harness-dir'`(무엇이 없는지 명시) → 배달기 `RECEIVER_CAPABILITY_REJECTED`(exit 1) | `Q3-b`, `Q3-b CLI` |
| ⓒ 확인 자체가 실패 | 수신부 CLI 파일 없음 / 구문 오류 / `parseDispatchReceiptArgs` export 없음                                                                                                                                                           | 셋 다 `ok:false, supported:false` → 거부(fail-open 금지)                                                                               | `Q3-c`(3종)        |
| ⓓ 인자 없는 배달   | 이 확인기를 `flag` 없이 부르는 호출(그 배달이 이 능력을 요구하지 않는 경우)                                                                                                                                                         | 워크트리가 없어도 무조건 통과(`NO_FLAG_REQUESTED`, 회귀 0)                                                                             | `Q3-d`             |

## 7. Q4 되돌림 변이

가드(§4 삽입 블록) 없이 미지원 워크트리로 배달했다면 어떤 오류가 났을지, 그 워크트리의 수신부 CLI를 **직접**(가드를 거치지 않고) 불러 재현했다 — `Q4` 테스트가 실제로 `node <미지원 CLI> --role CODER --task-label ... --receipt-path ... --harness-dir ...`를 실행해 stdout이 정확히 `FAILED reason=unrecognized flag '--harness-dir'`(오늘 실사고 §1 인용과 바이트 그대로 동일)임을 확인한다. 이 호출은 부작용이 없다 — `classifyFlag`가 인자 파싱 단계에서 즉시 실패해(`unrecognized flag`) `runDispatchReceiptCli`가 `appendReceiptLine`에 도달하기 전에 반환하므로(코드 실측, `dispatch-receipt-cli.mjs` 234-244행), 영수증 파일이 실제로 만들어지지 않았음도 같은 테스트가 확인한다.
`Q4 복원` 테스트는 같은 미지원 워크트리에 대해 가드(`checkReceiptCliFlagSupport`)를 거치면 위 옛 오류(`RECEIPT_FAILED`)까지 가지 않고 그보다 앞선 지점에서 더 명확한 사유로 멈춤을 확인한다.

## 8. ⚠️정직 — 이 패치가 «못» 하는 것

- **의도적 우회는 범위 밖** — 가드 CLI(`scripts/check/hyk400-receiver-guard.mjs`) 자체를 지우거나 exit code를 조작하면 이 축은 무력화된다. 이 패치가 잡는 것은 (a) 오늘 실제로 벌어진 실수형 우회(워크트리 갱신을 잊고 배달)와 (b) 능력 확인 자체가 실패하는 경우까지다. 의도형 차단은 OS 권한 분리(HYK-89) 없이는 성립하지 않는다(HYK-219 §4와 동일 한계).
- **`--harness-dir` 한 플래그만 실전 검증됨** — `checkReceiptCliFlagSupport`는 임의의 플래그를 받는 범용 함수지만(Q1), 배달기 쪽 결선(§4)은 현재 배달에 항상 필요한 `--harness-dir` 하나만 확인한다. 미래에 `Record-DispatchReceipt`가 다른 선택 인자를 추가로 항상 보내게 되면, 그 인자도 같은 자리에 확인 호출을 추가해야 한다(자동으로 덮이지 않는다).
- **줄끝(CRLF/LF) 불확실성은 HYK-387/HYK-396 문서의 경고를 그대로 물려받는다** — 이 문서의 원본 사본은 LF지만 실제 라이브 파일이 CRLF일 가능성은 배제하지 않는다(적용 절차 §9의 diff 확인이 이를 잡는다).
- **관제실 파일은 이 저장소 CI가 검증하지 않는다** — fixture 지문 대조가 유일한 드리프트 방어다(HYK-387/HYK-396 §5-6과 동일 한계).
- **동시성/경쟁**은 이 축의 범위 밖이다 — 확인과 실제 `Record-DispatchReceipt` 호출 사이에 대상 워크트리가 갱신되는 TOCTOU는 이론상 가능하지만, 이 배달기 자신이 순차 단일 프로세스로 도는 한 실제로 걸리지 않는다(HYK-396 §5 동일 가정).

## 9. 적용 절차

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 diff를 눈으로 확인**(특히 줄끝 스타일이 라이브와 같은지, `$Worktree` 변수가 이 스코프에서 이미 정의돼 있는지 — 262행 `$admissionCliPath` 정의에서 이미 쓰이므로 있다) → 라이브 교체.
3. **합성 표적으로 1회 구동**해: (a) `--harness-dir`를 아는 워크트리 → 종전과 동일하게 통과, (b) HYK-396 이전 워크트리 사본(§6 자매 fixture로 임시 워크트리 재현) → `RECEIVER_CAPABILITY_REJECTED`로 배달 자체가 만들어지지 않는지 확인(⛔실제 배달로 시험하지 않는다 — 임시/합성 워크트리로).
4. 되돌림 = 원본 SHA-256 사본 보관(이 문서 맨 위 `3fb935694ecb65b2e636d2ac78765232380870e05915a30b6a0bd4971b5e6a5f`).
