# HYK-327 — 관제실 배달기 검사기 2종 결선 + HYK-315 선행 수리 (제안 문면)

## 적용 상태: **WIRED** — ORCH가 6단계 전례 절차(문면 → 독립 검토 → 기계 추출 → 지문·백업·파싱 검사 → 관제실 git 커밋 → 발동 관측)를 실제로 집행했다(HYK-329-determinism-1 동봉 갱신, ORCH 실측 원문).

### 적용 증거

- **적용 시각**: 2026-08-20 13:33 KST · **관제실 커밋**: `e7130b6`
- **지문 대조**: 원본 SHA-256 `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`
  → 적용 후 SHA-256 `29fb025f23dbf8ae14f9adf81305de20975996ab0312ef1a352f67413aa707e6`
  (§6 실측의 「적용 후」픽스처와 **바이트 동일** — 같은 값).
- **백업**: `dispatch-worker.ps1.bak-hyk327-20260820-133120`(관제실 git 커밋
  전 되돌릴 수 있는 사본, §7 절차 2단계 그대로).
- **발동 관측 3건**(§7 6단계):
  1. 정상 경로 통과 — `ALL_OK` + `WRAPPER_CHANGED: NO`, 워커까지 실제 도달.
  2. 인자 누락 합성 주입 → `ARG_CONTRACT_REJECTED`(HYK-319 검사기가
     실제로 거부).
  3. 래퍼 위조 합성 주입 → `WRAPPER_SHAPE_REJECTED`(HYK-323 검사기가
     실제로 거부).

이 증거로 §7의 6단계 전례 절차(문면 → 독립 검토 → 기계 추출 → 지문·백업·
파싱 검사 → 관제실 git 커밋 → 발동 관측) 전부가 완료됐음을 확인한다.
⛔이 CODER 라운드(HYK-329-determinism-1) 자신은 관제실 파일을 고치지
않는다(coder-task.md §0 비타협2 "관제실 쓰기 0") — 위 적용은 ORCH가 이미
집행한 것을 이 문서에 **문서화만** 한 것이다.

## 재작업 사유 (검토 1R 반려, `.harness/review-r1-원문.md` 그대로)

1R은 **P1**(합성본 기계 재현 실패)로 반려됐다: 이 문서의 §1·§3이 각각
「HYK-315 정의를 게이트 호출 앞에 삽입」·「HYK-319 검사를 `$ReceiptPath`
블록 뒤·HYK-217 주석 블록 앞에 삽입」이라고 **따로** 적었지만, 실제
합성 픽스처는 그 둘을 **HYK-217 설명 주석 전체 뒤**에 **하나로 합쳐**
두었다 — 즉 두 조각이 **같은 앵커 구간을 공유**해, 문서의 표면 순서로
직접 적용하면 기대 합성본을 재현할 수 없었다(재현 결과
`document_order_equals_expected=false`·`shared_anchor_reversed_equals_expected=false`,
둘 다 첫 불일치 오프셋 7660). 부수적으로 **P2** 2건: 추출 대상이
5개라는 문면과 달리 실제 PowerShell 펜스는 7개였고(설명용 원문/대체문
펜스가 섞여 있었다), 합성본 행수를 635줄이라 적었지만 실제는 634줄.

이번 라운드는 **사람이 손으로 옮기는 구조 자체를 없앤다**: 저장소에
적용 도구(`scripts/check/control-room-patch-apply.mjs`)를 새로 만들고,
아래 §5의 **네 개** 기계 판독 단위(`control-room-patch-unit` 펜스,
`powershell` 펜스와 겹치지 않는 별도 언어 태그)를 그 도구에 그대로
먹이면 합성 픽스처와 **바이트 동일**한 결과가 나온다는 것을 시험으로
고정했다(§6). 검토가 통과 판정한 항목(실물 지문 대조·HYK-315 중복
정의 없음·발동 순서·fail-closed 분기·ALL_OK/WRAPPER_CHANGED: NO/
PARSE_OK·4수)은 전부 그대로 유지했다.

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
**모든 배달이 막힌다**(§6의 실측이 그대로 보여준다) — 이 수리는
HYK-327 완료 조건("정상 경로 통과 실측")의 전제다.

## 실측 원본 (ORCH, coder-task.md §1 그대로)

| 항목                  | 값                                                                 |
| --------------------- | ------------------------------------------------------------------ |
| 관제실 배달기 SHA-256 | `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58` |
| 행수                  | 573줄                                                              |
| 측정 시각             | 2026-08-20                                                         |

이 문서의 적용 단위(§5)는 **이 SHA-256의 원문을 기준**으로 앵커를
잡았다. 관제실 파일이 이 값과 다르면 §5의 도구가 앵커 검색에서
`ANCHOR_NOT_FOUND`로 fail-closed 거부한다 — 조용히 잘못된 곳에 꽂지
않는다.

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
이 인자를 이 게이트의 `hard:false` 필수 인자로 선언해 두었다(§3에서
결선하는 HYK-319 검사기가 이 누락을 실제로 잡는다 — §6 실측 참고).

값 자체(`$admissionLedgerPath = Join-Path $PSScriptRoot
"admission-ledger.json"`)는 원문에 **이미 있다** — 다만 원문 210행
부근(`admission-cli.mjs` 호출 준비 블록)에서 정의되고, 그 정의는 게이트
호출(191행 부근)**보다 뒤**다. HYK-256과 같은 모양의 순서 문제다.

## 수리 방식: **이동**(새 정의 추가가 아니다)

⛔기존 줄을 지우지 않는다 — 값 정의 자체는 그대로 두고 **위치만
옮긴다**. 게이트 호출 앞에 새로 추가하고, 원래 있던 자리(admission-cli
블록)에서는 **지워서 중복 정의가 남지 않게** 한다. 이 이동은 §5의
**세 개 단위**(`hyk315-def-and-hyk319-check`·`hyk315-gate-call-arg`·
`hyk315-dedupe-admission-def`)로 나뉘어 있다 — 정의 추가·게이트 호출
인자 추가·원래 자리 제거가 각각 하나씩이다.

★**1R 반려 수리**: 1R은 "정의 추가"를 §1의 독립된 삽입으로,
"HYK-319 검사 삽입"을 §3의 독립된 삽입으로 각각 별도 앵커에 적어,
표면상 두 개의 서로 다른 삽입처럼 보였다. 그러나 둘 다 실제로는 **같은
지점**(`# docs/enforcement-known-gaps.md gap#96 ... 참조.` 줄 뒤,
`if ($Role -eq "PM") {` 앞)에 들어간다 — 정의가 검사보다 먼저 나와야
검사가 그 값을 참조할 수 있기 때문이다(§4). 이번 라운드는 이 둘을
**하나의 단위**(`hyk315-def-and-hyk319-check`)로 합쳐, 앵커 공유로 인한
겹침 자체가 구조적으로 생기지 않게 했다 — §5·§6 참고.

---

# §2 HYK-323 — 좌석 증명 래퍼 「변경 탐지」 결선 (최종 적용본)

`docs/control-room-patches/HYK-323-seat-proof-wrapper-shape-check.md`가
이미 정의한 제안 문면을 **그대로 채택**한다(§5의
`hyk323-wrapper-check` 단위). 바뀐 것은 없다 — 그 문서가 정의한 앵커·
문면·exit code를 그대로 옮겼을 뿐이다.

## 왜 좌석 증명을 부르기 전인가

좌석 증명 게이트(`Invoke-SeatProofGate`) 자체가 「항상 거부」 모양이면,
그 게이트를 부르는 순간 이미 배달이 막힌다(2026-08-19 HYK-323 비상
직수리 사유). 래퍼 검사를 좌석 증명 호출보다 **앞**에 두면, 같은
결함이 재발했을 때 좌석 증명 게이트 자체를 부르기도 전에 명확한
사유(`WRAPPER_CHANGED: YES reason=...`)로 멈춘다.

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
정의한 제안 문면을 **그대로 채택**한다(§5의
`hyk315-def-and-hyk319-check` 단위 뒷부분). 문면 자체는 바뀌지 않았다
— **위치**만 1R의 실수(§1 참고)를 고쳐 §1의 `$admissionLedgerPath`
정의와 한 단위로 합쳤다.

## 새 exit code

- `exit 9` = `ARG_CONTRACT_CLI_MISSING`(HYK-319) — 검사기 CLI 자체가
  이 워크트리에 없으면 fail-closed.
- `ARG_CONTRACT_REJECTED`는 별도 exit code 없이 `Write-Error`로 멈춘다.

정직 한계·필수 인자 선언 표는 원 문서(HYK-319-dispatch-arg-contract.md)
그대로 유효하다 — 이 문서에서 반복하지 않는다.

---

# §4 네 단위의 발동 순서와 상호작용

네 단위를 전부 적용한 뒤, 배달기 실행 순서(위→아래)는 다음과 같다:

1. `$ReceiptPath` 해석(기존, 무변경).
2. **`hyk315-def-and-hyk319-check`** — `$admissionLedgerPath` 정의(새
   위치, 게이트 호출 앞) **다음**, HYK-319 인자 대조 검사. 이 시점에
   저장소 CLI 5개(게이트·원자 입장·영수증·좌석 증명·착수 확인) **중
   어느 것도 아직 호출되지 않았다** — 정의가 검사보다 먼저 나와야
   검사 실행 시점에 그 변수가 이미 존재한다(정의 자체는 검사 대상이
   아니라 값 준비이므로 실패하지 않는다).
3. `dispatch-gate-decision.mjs` 호출(**`hyk315-gate-call-arg`**로
   `--admission-ledger-path` 추가됨).
4. `admission-cli.mjs admit` 호출(**`hyk315-dedupe-admission-def`**로
   `$admissionLedgerPath` 재정의 없이 단계 2에서 정의한 값을 그대로
   씀).
5. **`hyk323-wrapper-check`** — admission 통과 직후, 영수증 CLI 존재
   확인보다 앞. `Invoke-SeatProofGate`가 실제로 호출되는 지점([2.5/3]/
   [2.4/3], 한참 뒤)**보다 훨씬 앞**이다.
6. 영수증 CLI 존재 확인 → `dispatch`/`Invoke-Dispatch` →
   `Record-DispatchReceipt` → `Invoke-SeatProofGate`(좌석 증명, 여기서
   비로소 호출) → (codex 경로면) `terminal send` → [4/4] 착수 확인.

## 왜 정의+인자 대조(HYK-315+HYK-319)가 래퍼 검사(HYK-323)보다 먼저인가

**근거**: 인자 대조의 보호 대상은 저장소 CLI **5개 전부**(게이트·원자
입장·영수증·좌석 증명·착수 확인)이고, 그중 첫 호출(`dispatch-gate-
decision.mjs`, 단계 3)이 가장 이르다. 5개를 전부 보호하려면 그 첫
호출보다 앞서야 한다 — 이는 HYK-319 원 문서가 이미 정한 삽입 지점과
일치한다(단계 2). `$admissionLedgerPath` 정의는 그 검사가 참조하는
값이 아니라(검사는 인자 «이름»만 보지 값을 안 본다) **게이트 호출
자체가 그 값을 필요**로 하므로, 정의는 검사와 같은 지점에 있되 반드시
게이트 호출(단계 3)보다 앞이어야 한다 — 같은 위치에 검사와 정의를
같이 두는 것이 가장 단순하고, 그것이 1R이 실수로 갈라놓았던 두 조각을
합친 이유다.

반면 래퍼 검사는 `Invoke-SeatProofGate` **단 하나**만 보호하면 되고,
그 함수의 실제 호출은 훨씬 뒤(단계 6)이므로 굳이 더 앞으로 당길 이유가
없다 — HYK-323 원 문서가 정한 삽입 지점(admission 통과 직후, 단계 5)을
그대로 쓴다. 결과적으로 두 검사는 **서로 다른 목표 시점**(각자가
보호하는 호출들 중 가장 이른 것)에 맞춰 자연스럽게 순서가 정해지며,
둘 다 자신이 보호하는 모든 호출보다 앞에 있다는 불변식을 만족한다.

## 적용 순서가 결과를 바꾸는가 — 바뀌지 않는다(도구가 보장)

§5의 네 단위는 서로 다른 앵커 구간을 겹치지 않게 잡았다(§6의 겹침
거부 시험이 이를 확인한다). `control-room-patch-apply.mjs`는 각 단위의
앵커를 **원본 소스** 기준 오프셋으로 먼저 전부 계산하고, 겹침이 없음을
확인한 뒤, **오프셋이 큰 것부터** 적용한다(`applyPatchUnits` 내부
정렬) — 그래서 단위를 문서에 어떤 순서로 나열하든, 또는 호출자가 배열
순서를 뒤집어 넘기든 결과는 항상 동일하다(§6 "순서 무관성" 시험이
문서 순서와 역순 둘 다로 검증한다).

## 한 단위가 실패하면 나머지는 어떻게 되는가

파일 최상단에 `$ErrorActionPreference = "Stop"`이 설정돼 있어(원문
49행), `Write-Error`는 **그 자리에서 스크립트 실행을 끝낸다**(다른
기존 게이트들 — HYK-217/224/299 — 과 동일한 관례). 따라서:

- **단계 2(HYK-319)가 실패**하면 게이트 호출(단계 3)부터 그 뒤 전부
  (admission·래퍼 검사·영수증·dispatch·좌석 증명) **실행되지 않는다**.
  아직 `orca orchestration dispatch`조차 안 불렸으므로 "반쪽 배달"이
  생기지 않는다.
- **단계 5(HYK-323)가 실패**하면 그 시점까지 이미 게이트(단계 3)와
  admission(단계 4)은 통과한 뒤다 — admission-cli가 이미 원자 입장을
  기록했을 수 있다는 뜻이다. 이는 **이 결선이 새로 만드는 상황이
  아니다**: 기존에도 영수증 CLI 존재 확인(단계 6 첫머리)이 admission
  통과 직후에 있어, 그 확인이 실패하면 이미 admission이 기록된 채로
  스크립트가 끝났다 — 같은 모양의 "부분 진행 후 중단"이 이미 관례다.
  이 라운드는 그 관례에 검사 하나를 더 끼워 넣을 뿐, 새로운 되돌리기
  없음(no rollback) 문제를 만들지 않는다.
- 서로 다른 단위가 **동시에** 문제를 일으키는 경우는 없다 — 한
  스크립트 실행 안에서 `Write-Error`가 첫 실패 지점에서 즉시 멈추므로,
  뒤쪽 단위는 앞쪽 단위가 통과한 뒤에만 도달한다.

---

# §5 기계 적용 단위 (추출 대상, 정확히 4개)

아래 네 블록이 이 문서의 **유일한** 기계 추출 대상이다. 언어 태그
`control-room-patch-unit`은 이 문서(그리고 이 도구가 읽는 어떤
패치 문서에서도) **오직 적용 단위만** 표시한다 — 사람이 읽기 위한
예시·설명은 다른 펜스(예: ` ```text `)를 쓰거나 펜스 없이 backtick
인용만 쓴다(1R P2-1 반려 수리: "펜스 개수 = 추출 대상 개수"가 항상
성립하도록, 설명용 펜스가 이 언어 태그를 쓰지 못하게 했다).

각 블록의 형식은 `scripts/check/control-room-patch-apply.mjs`가 그대로
파싱한다:

```text
id: <고유 슬러그>
mode: insert_after | replace
@@ANCHOR@@
<원본에서 찾을 정확한 텍스트 — 한 줄 이상, 원본 안에 정확히 1회만 나타나야 한다>
@@CONTENT@@
<insert_after면 앵커 직후에 삽입할 텍스트, replace면 앵커를 대체할 텍스트>
@@END@@
```

`anchor`는 원본에서 **정확히 1회**만 일치해야 하고(0회=`ANCHOR_NOT_FOUND`,
2회 이상=`ANCHOR_NOT_UNIQUE`, 둘 다 fail-closed), 어떤 두 단위의 앵커
구간도 서로 겹치면 안 된다(`ANCHOR_OVERLAP`, fail-closed — §4 "적용
순서가 결과를 바꾸는가" 참고).

## 단위 1/4 — `hyk315-def-and-hyk319-check` (insert_after)

§1(HYK-315 정의 이동)과 §3(HYK-319 검사)을 하나로 합친 단위다 — 정의가
검사보다 먼저 나와야 하고, 둘 다 게이트 호출(단위 2)보다 앞이어야
하므로 같은 지점에 함께 둔다(1R 반려 수리의 핵심).

```control-room-patch-unit
id: hyk315-def-and-hyk319-check
mode: insert_after
@@ANCHOR@@
# docs/enforcement-known-gaps.md gap#96(직접 주입)·gap#97·gap#98 참조.
@@CONTENT@@


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

@@END@@
```

## 단위 2/4 — `hyk315-gate-call-arg` (replace)

게이트 호출 줄에 `--admission-ledger-path $admissionLedgerPath`를
추가한다(그 외 인자·순서 동일).

```control-room-patch-unit
id: hyk315-gate-call-arg
mode: replace
@@ANCHOR@@
  & node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath
@@CONTENT@@
  & node $gateScript $roleTaskFile --expect-repo-root $Worktree --dispatch-receipt-path $ReceiptPath --admission-ledger-path $admissionLedgerPath
@@END@@
```

## 단위 3/4 — `hyk315-dedupe-admission-def` (replace)

원래 자리(admission-cli 준비 블록)의 `$admissionLedgerPath` 정의를
지우고, 지운 이유를 한 줄 주석으로 남긴다 — 단위 1이 이미 그 값을
정의했으므로 여기서 다시 정의하면 중복이 된다.

```control-room-patch-unit
id: hyk315-dedupe-admission-def
mode: replace
@@ANCHOR@@
$admissionLedgerPath = Join-Path $PSScriptRoot "admission-ledger.json"
@@CONTENT@@
# HYK-315(2026-08-20): $admissionLedgerPath 정의는 위(§1.5 게이트 호출 앞)로
# 옮겨졌다 -- 여기서는 다시 정의하지 않는다(중복 정의 없음, 위 이동 문면의
# 주석 참고).
@@END@@
```

## 단위 4/4 — `hyk323-wrapper-check` (insert_after)

admission 원자 입장 확인 통과 직후, 영수증 CLI 존재 확인보다 앞에
래퍼 변경 탐지 검사를 끼워 넣는다.

```control-room-patch-unit
id: hyk323-wrapper-check
mode: insert_after
@@ANCHOR@@
Write-Error "CAP_REJECTED: 위 사유로 배달을 거부합니다(HYK-224 원자 입장 게이트, exit $admissionExit). 원인을 해소한 뒤 재시도하세요."
}
@@CONTENT@@


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
@@END@@
```

**개수 확인**: 위 4개가 이 문서의 진짜 추출 대상 전부다(이 절 §5의
형식 설명 코드블록은 ` ```text ` 펜스라 세지 않는다). ⚠️naive한 문자열
grep(`grep -c '```control-room-patch-unit'`)은 **신뢰하지 마라** — 이
문단처럼 펜스 마커 자체를 설명하는 산문 인용도 같은 문자열을 담고
있어 과다 계수된다(자기 참조 문제, 이 문서 자체가 그 예시다). 권위
있는 계수는 실제 파서(`control-room-patch-apply.mjs`의
`parsePatchDocument`, 줄 시작에서 열리고 `@@ANCHOR@@`/`@@CONTENT@@`/
`@@END@@` 마커 시퀀스와 닫는 ` ``` `까지 구조적으로 갖춘 것만 단위로
센다)뿐이다 — §6의
`control-room-patch-apply-hyk327-wire.test.mjs`가 이 문서를 그 파서로
직접 돌려 `parsed.units.length === 4`를 시험으로 고정한다.

---

# §6 저장소 쪽 시험 — 도구로 「문서 → 적용본」을 직접 재현

## 도구

`scripts/check/control-room-patch-apply.mjs`:

```text
node scripts/check/control-room-patch-apply.mjs --doc <패치문서> --source <원본> --out <출력>
```

- `--source`는 **읽기만** 한다. 기본값이 없다 — 실물 관제실 경로를
  실수로라도 기본값으로 두지 않았다(호출자가 항상 세 경로를 명시).
- 앵커는 원본에서 **정확히 1회**만 일치해야 하며(그 외
  `ANCHOR_NOT_FOUND`/`ANCHOR_NOT_UNIQUE`로 fail-closed), 어떤 두 단위의
  앵커 구간도 겹치면 안 된다(`ANCHOR_OVERLAP`, fail-closed — 겹침을
  조용히 순서로 해결하지 않는다, 1R이 바로 이 문제였다).
- 적용은 항상 **원본 오프셋 기준**으로 계산되고 오프셋 역순으로
  스플라이스되므로, 단위를 어느 순서로 넘겨도 결과가 같다(§4 참고).

## 실측 결과 (이 라운드 CODER 좌석 직접 실행)

```text
$ node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-327-wire-two-checkers.md --source scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt --out <임시경로>
control-room-patch-apply: OK -- wrote <임시경로> (42563 bytes, 634 lines)

$ diff <임시경로> scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt
(차이 없음)

$ node scripts/check/dispatch-arg-contract.mjs --script <임시경로>
dispatch-arg-contract: ALL_OK
exit=0

$ node scripts/check/seat-proof-wrapper-shape.mjs --script <임시경로>
WRAPPER_CHANGED: NO
exit=0

$ pwsh -NoProfile -Command "... [System.Management.Automation.Language.Parser]::ParseFile(...) ..."
PARSE_OK
```

- 원본: `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt`
  (오늘 관제실 실물 스냅샷, SHA-256
  `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58`,
  573줄)
- 도구 출력 == 기존 「적용 후」픽스처
  `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt`
  (SHA-256 `29fb025f23dbf8ae14f9adf81305de20975996ab0312ef1a352f67413aa707e6`,
  **634줄** — 1R 문서의 "635줄" 표기가 오류였다, P2-2 정정. SHA-256은
  1R부터 지금까지 바뀌지 않았다.) — **바이트 동일**.
- 두 검사기 모두 통과: **ALL_OK** · **WRAPPER_CHANGED: NO** ·
  PowerShell **PARSE_OK**.
- `$admissionLedgerPath` 대입문은 도구 출력 전체에서 **정확히 1개**
  (단위 3이 원래 자리의 정의를 지우고, 단위 1이 새 자리에 하나만
  남긴다 — `rg -c '^\$admissionLedgerPath ='`로 재확인).

## 시험으로 고정 (CI 정본에 포함)

- `scripts/check/control-room-patch-apply.test.mjs` — 도구 자체의 단위
  시험: 파싱(정상/기형 블록/중복 id/잘못된 mode), 앵커 미발견/비고유
  거부, **겹침 거부**(합성 겹침 문서로 `ANCHOR_OVERLAP` 확인), 순서
  무관성(단위 배열을 뒤집어도 결과 동일), `insert_after`/`replace`
  기본 동작.
- `scripts/check/control-room-patch-apply-hyk327-wire.test.mjs` — 이
  문서 자체를 대상으로 한 통합 시험: **이 문서(§5)를 원본 스냅샷에
  적용한 결과가 기존 「적용 후」픽스처와 바이트 동일**함을 고정한다
  (P1 반려의 직접 수리 — 이 시험이 RED면 문서와 픽스처가 다시
  벌어졌다는 뜻이다). 추출 단위 개수가 정확히 4개인지도 이 시험이
  확인한다.
- `scripts/check/dispatch-arg-contract-hyk327-applied-snapshot.test.mjs`·
  `scripts/check/seat-proof-wrapper-shape-hyk327-applied-snapshot.test.mjs`
  (1R에서 이미 추가, 무변경) — 픽스처가 두 검사기를 실제로 통과함을
  고정.

⛔픽스처 자체는 이번 라운드에서 **고치지 않았다** — 도구가 그 픽스처를
재현하도록 문서 쪽(앵커/내용 분리)을 고쳤다. 문서·도구·픽스처 셋이
서로를 검증한다(하나를 다른 것에 맞춰 덮어쓰지 않았다).

## 변이 검증 (이 라운드 직접 실행, 확인 후 원상 복구)

- 단위 1의 앵커 문자열 끝에 문자 하나를 추가해 훼손 → 도구가
  `ANCHOR_NOT_FOUND`로 거부(원본에 더 이상 그 문자열이 없으므로) —
  적용이 진행되지 않아 바이트 동일 시험도 당연히 RED(도구 자체가
  먼저 막는다).
- 합성 문서에 다섯 번째 단위를 추가하되 앵커를 단위 1과 **동일**하게
  설정 → 도구가 `ANCHOR_OVERLAP`으로 거부(1R의 실제 결함과 같은
  모양을 합성 재현한 것 — 지금은 이 도구가 그 자리에서 막는다).
- 두 확인 모두 **워크트리 안 임시 파일**로만 수행했고, 저장소 추적
  파일은 건드리지 않았다 — `git status --porcelain`이 이 두 확인
  전후로 동일(깨끗).

## 갱신 절차 (문서 또는 실물이 다시 벌어지면)

관제실 실물이 바뀌면(정당한 변경이든 이 문서 적용이든) 원본 스냅샷·
합성본 픽스처·이 문서 §5의 단위·관련 시험의 SHA-256/행수 상수를 함께
갱신해야 한다 — 절차는 `dispatch-arg-contract-snapshot.test.mjs`의
"책임자 조건②"와 동일 원칙(재생성 → 헤더 SHA-256/시각/행수 갱신 →
기대 판정 갱신 → 검토 라운드 경유). 이 문서가 ORCH의 6단계 §5(관제실
git 커밋)까지 집행되면, §6의 「적용 전 미리 증명」 목적은 다한 것이므로
폐기하거나 실물 SHA-256으로 갱신할 수 있다(다음 트랙 판단, 이 라운드
범위 밖).

---

# §7 ORCH 적용 절차 — 손으로 옮기는 단계 없음

6단계 전례 절차 중 **§3(기계 추출)**에서 ORCH가 실제로 칠 명령은
다음 한 줄이다(원본을 실물 관제실 파일로, `--out`은 임시 경로로):

```text
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-327-wire-two-checkers.md --source "D:\문서관리\하네스-관제실\dispatch-worker.ps1" --out "D:\문서관리\하네스-관제실\.tmp\dispatch-worker.hyk327-applied.ps1"
```

그 뒤 이어지는 §4(지문·백업·파싱 검사)~§5(관제실 git 커밋)는:

1. **지문 대조**: 위 명령 실행 전, `Get-FileHash -Algorithm SHA256`으로
   `dispatch-worker.ps1`이 이 문서 상단 "실측 원본" 표의 SHA-256과
   같은지 먼저 확인한다 — 다르면 §5의 도구가 앵커 검색에서 자연히
   `ANCHOR_NOT_FOUND`로 막히지만, 그 전에 사람이 먼저 "원본이 이미
   바뀌었다"는 사실을 알 수 있다.
2. **백업**: `dispatch-worker.ps1`을 타임스탬프가 붙은 별도 경로로
   복사해 둔다(예: `dispatch-worker.ps1.bak-<타임스탬프>`) — 관제실
   git 커밋 전 되돌릴 수 있는 사본.
3. 위 도구 실행. `exit 0`이 아니면(어떤 `REASON_CODE`든) **여기서
   멈춘다** — `--out`이 쓰이지 않았으므로 원본은 이미 안전하다.
4. **파싱 검사**: `[System.Management.Automation.Language.Parser]::ParseFile(<--out 경로>, ...)`로
   `--out`이 유효한 PowerShell인지 확인한다(§6이 저장소 쪽에서 이미
   같은 검사를 통과시켰지만, 실물 원본이 §6의 스냅샷과 조금이라도
   다르면 다시 확인할 가치가 있다).
5. 통과하면 `--out`의 내용을 `dispatch-worker.ps1`의 실제 경로로
   옮긴다(덮어쓰기), 관제실 저장소에 git add/commit.
6. **발동 관측**은 6단계 §6(이 라운드 범위 밖) — 실제 배달 1회를
   관찰해 두 검사기 로그(`ARG_CONTRACT`/`WRAPPER_SHAPE` 접두 줄)가
   찍히는지 확인한다.

ORCH가 손으로 텍스트를 옮겨 붙이는 단계는 위 어디에도 없다 — 1단계
(지문 대조)와 4단계(파싱 검사)는 값을 **비교**할 뿐이고, 실제 텍스트
이동은 전부 2단계(파일 복사)와 3단계(도구 실행)가 기계로 한다.

---

# ⛔하지 않은 것 (coder-task.md §3)

- 관제실 파일 수정(ORCH 몫) — 이 라운드는 저장소 안 문서·도구·시험만
  건드렸다.
- 검사기 본체 변경 — `dispatch-arg-contract*.mjs`·
  `seat-proof-wrapper-shape.mjs`·레지스트리·정본 지문 전부 무변경.
- 「적용 후」 픽스처 변경 — 도구가 그 픽스처를 재현하도록 문서를
  고쳤을 뿐, 픽스처 자체는 1R 그대로다.
- 고의 우회 방어 — 두 검사기 각각의 정직 한계(HYK-319/323 원 문서)를
  그대로 인용했을 뿐 더 쫓지 않았다.
- 결선 「발동 관측」 · 실배달 — 관제실 실물에 이 문면이 실제로 적용된
  뒤의 발동 확인은 ORCH가 6단계 §6에서 한다(§7).
