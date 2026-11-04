# HYK-424-head-label-3 — base-copy 거부 뒤 재배달 복구 경로 실측

이 문서는 책임자 판정 B-prime(coder-task.md §1, 0926 상신 답)이 못 박은
실측 요구 — "ⓐ 같은 워크트리 + 새 라벨, ⓑ 새 워크트리(작성자 HEAD) + 새
라벨, 두 경로를 실 CLI `dispatch-gate-decision.mjs` 판정 + 프로덕션
`checkRelayHandshake` 소비 결과로 측정하라" — 의 결과와, 그 결과를 반영한
거부 사유 문구 정정·P2-2(레거시 `head_commit:` 폴백 CODER 한정) 수리의
근거를 적는다.

## 0. 배경 — 왜 "재배달"이 문제가 되는가

1R(head-label-1)이 만든 `resolveBaseCopyGuard`(relay-handshake.mjs)는
워커가 결과 파일의 `head_commit:`에 "이 라운드의 base"를 그대로 베껴 쓰면
(실제로는 자기 커밋을 만들었는데도) 전용 사유로 거부한다. 그 거부 사유
문구는 "네 커밋 SHA를 적어라"였다 — 검토 1R(hyk424-head-label-1-review-1/
.harness/review.md, verdict: rejected)이 P1으로 잡은 구멍: **그 문구를
그대로 따르면(같은 결과 파일의 `head_commit:` 한 줄만 고쳐 다시 소비시키면)
`DONE_REWRITTEN_AFTER_FIRST_OBSERVATION`으로 다시 거부된다** — 같은 세대
(같은 `dropped_at`)에서는 결과 파일이 최초 관측 뒤 한 글자라도 바뀌면
무조건 거부하는 축(HYK-257-done-stamp-2)이 먼저 걸리기 때문이다.

2R(head-label-2)은 책임자 판정이 지시한 다음 가설 — "ORCH가 **같은
라벨**로 새 `dropped_at:`을 찍어 재배달하면 통과한다" — 을 합성 admission
원장 + 실 CLI `dispatch-gate-decision.mjs`로 측정했고, **그것도 막힌다**는
것을 실측했다: 배달 게이트의 소비 완료 영수증 축
(`consumption-receipt-core.mjs`의 `RECEIPT_MISSING`)이 "이 라벨의 소비
완료 영수증 후보가 하나도 없음"을 이유로 거부한다 — base-copy 거부가
`runCompletionSideEffects`(relay-handshake.mjs:4140) **앞**에서 막히므로
완료 부수효과(소비 영수증 생산)가 전혀 돌지 않았기 때문이다(CODER-r2.md
§2ⓑ).

이 라운드(head-label-3)는 책임자 판정 B-prime이 추가로 지시한 두 경로를
측정한다.

## 1. 측정 설계

모든 측정은 `scripts/check/relay-handshake-base-copy-redispatch.test.mjs`
(이 라운드가 새로 만든 시험 파일, 합성 mkdtemp + 합성 git 저장소, 실물
원장·관제실 무접촉)로 고정했다. 핵심 구조:

- **실 CLI**를 스폰해서 쓴다(`spawnSync(process.execPath, [GATE_CLI, ...])`)
  — in-process 호출이 아니다. 이것이 관제실 `dispatch-worker.ps1:313`이
  실제로 모든 역할의 모든 `go`(재배달 포함) 전에 돌리는 그 CLI와 정확히
  같은 진입점이다(2R이 이미 확인한 결선 사실, CODER-r2.md §2ⓑ 인용).
- **프로덕션 `checkRelayHandshake`**를 그대로 import해서 쓴다(합성 모듈
  복제·사본 import 없음) — 완료/소비 쪽 실측.
- admission 원장은 필요한 경로(ⓑ의 2단계)에서만 실 CLI
  `runAdmissionCli(["init-cutover", ...])`/`["admit", ...]`로 ACTIVE
  예약을 만든다 — 손으로 JSON을 짜지 않는다.

## 2. 결과 표

| 경로                                 | 조작                                                                                                                                                                                             | 프로덕션 진입점                                                  | 결과                                                                                             | 근거(코드 읽기 + 직접 실측)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⓐ 같은 워크트리 + 새 라벨            | base-copy로 거부된 직전 `coder.md`(라벨 A)가 그대로 남은 같은 harnessDir에, **한 번도 배달된 적 없는 새 라벨 B**로 `coder-task.md`를 덮어쓰고 실 CLI를 돌린다                                    | `dispatch-gate-decision.mjs` → `evaluateConsumptionDecision`     | **REJECT**(exit 1, `RECEIPT_MISSING`, 사유에 라벨 A가 찍힌다 — 라벨 B는 등장하지 않는다)         | `evaluateConsumptionDecision`(dispatch-gate-decision.mjs:3113)은 `resultPath = harnessDir/coder.md`가 **존재하면**(그 라운드가 거부됐어도 그 파일은 지워지지 않는다) `harnessTaskLabel`을 **그 결과 파일 자신의 `task_id:` 에코**(`classifyAndLabel(resultText)`)에서 뽑는다(:3138) — 새로 쓴 `coder-task.md`의 내용은 이 경로에서 **전혀 읽히지 않는다**(taskPath는 오직 `role`/`harnessDir` 유도에만 쓰인다, :3114-3118). 즉 다음 라운드가 무슨 라벨을 쓰든 이 판정은 **구조적으로 바뀌지 않는다** — 2R이 "같은 라벨"로 실측한 것과 "ⓐ 같은 워크트리 + 새 라벨"이 같은 결과로 떨어지는 이유가 바로 이 지점이다. |
| ⓑ 새 워크트리(작성자 HEAD) + 새 라벨 | 직전 결과 파일이 전혀 없는 **새 harnessDir**(작성자 HEAD와 같은 커밋에서 새로 만든 worktree를 모사)에, 한 번도 배달된 적 없는 새 라벨로 `coder-task.md`만 쓰고 실 CLI를 돌린다                   | `dispatch-gate-decision.mjs` → `resolveMissingResultFileOutcome` | **ALLOW**(exit 0, "진짜 부트스트랩")                                                             | `resultPath`가 **존재하지 않으므로**(:2761 `existsSync(resultPath)` false) `resolveMissingResultFileOutcome`(:2754)이 분기한다: 영수증 로그를 확인할 수 있고(:2766-2776) `hasDispatchReceiptForCurrentRound(role, 새 라벨, receiptPath)`가 **false**(이 라벨은 정말 한 번도 배달된 적이 없다) → `{shortCircuit:true, result:null}` = ALLOW, admission 원장 조회(`isReservationActiveForRound`)까지 갈 필요조차 없다(:2782-2783).                                                                                                                                                                                  |
| ⓑ 2단계 — 소비까지 실물 경로         | ⓑ의 ALLOW 뒤, 그 새 harnessDir에서 워커가 실제 커밋을 만들고 정직한 `head_commit:`으로 결과를 썼다고 가정하고, admission 원장에 그 라벨을 실 CLI로 ACTIVE 예약한 뒤 `checkRelayHandshake`를 호출 | `checkRelayHandshake` → `runCompletionSideEffects`               | **ok:true**, 완료 부수효과 셋(`envelopeArchived`/`taskArchived`/`admissionReturned`) 전부 `true` | base-copy 축 자체가 `skipped:true`로 통과(결과가 base를 베끼지 않았으므로)하고, 그 뒤 체인이 끝까지 통과해 `consumption-receipt-writer.mjs`가 실제로 `receipts/CODER-receipt-r1.json`을 쓴다 — 시험이 그 파일을 직접 읽어 `effects`를 대조했다(합성 단언이 아니다).                                                                                                                                                                                                                                                                                                                                               |

통과한 경로는 **ⓑ 하나뿐**이다. ORCH 손이 덜 드는 근거: ⓑ는 ORCH가 이미
알고 있는 작업(새 worktree를 만들어 새 라벨로 배달하는 것 — 이는 매
라운드 레이블이 바뀔 때 ORCH가 통상 하는 일과 구조적으로 같다)이고,
배달 게이트·소비 영수증·원장 코드를 조금도 바꾸지 않고도 즉시 작동한다.
ⓐ는 (i) 직전 결과 파일을 치우거나 (ii) consumption-receipt 축에 새
면제를 추가하는 코드 수정이 있어야 하는데, 둘 다 이 라운드의
product_scope 밖이다(아래 §4).

## 3. 사유 문구 정정 (product_scope ①ⓘ)

`resolveBaseCopyGuard`의 거부 사유를 다음 세 요소로 다시 썼다
(`scripts/check/relay-handshake.mjs`, bc-13 시험이 세 요소 + "finalize-done
언급 없음"을 전부 고정한다):

1. **같은 세대 재소비 불가** — "같은 세대(같은 dropped_at)에서 결과 파일만
   고쳐 재소비할 수 없다(DONE_REWRITTEN_AFTER_FIRST_OBSERVATION으로 다시
   거부)" (검토 1R/REVIEW-1 poll2·poll3이 이미 실측).
2. **같은 라벨(워크트리) 재배달 불가** — "같은 워크트리에서 라벨만 새로
   바꿔 재배달해도 통과하지 못한다(consumption-receipt: RECEIPT_MISSING
   -- 직전 결과 파일이 그대로 남아 있는 한 라벨은 무관하다)" (이 라운드
   §2ⓐ 실측, 위 표).
3. **ⓑ에서 통과한 경로** — "실측으로 통과하는 유일한 경로는 ORCH가
   작성자 HEAD의 새 워크트리(아직 직전 결과 파일이 없는 harnessDir)에 새
   task_id(라벨)로 재배달하는 것이다" (이 라운드 §2ⓑ 실측).

⛔`finalize-done`을 복구 수단으로 안내하지 않는다 — 그것은 같은 세대
재소비를 시도하는 행동이고, 위 1번이 이미 그 경로가 작동하지 않음을
못 박았다.

## 4. P2-2 — 레거시 `head_commit:` 폴백을 CODER 한정으로

1R의 `resolveDeclaredRoundBase`는 `!isReviewFamilyRole(role)`로 레거시
폴백 조건을 걸었다 — "REVIEW가 아니면 전부"(VERIFY·PM 포함)를 base 선언
후보로 읽는다는 뜻이다. 그런데 이 사고(419-wire-2/422-dispatch-run-1,
coder-task.md §1)가 실측된 적은 **CODER 라운드뿐**이다. VERIFY·PM이 같은
이름의 `head_commit:` 필드를 다른 뜻(또는 전혀 다른 목적)으로 쓸 때까지
이 축이 base 선언으로 오인하면 과차단이 된다. 그래서 조건을
`isCoderRole(role)`(대소문자 무관, `/^coder$/i`)로 좁혔다
(relay-handshake-base-copy.test.mjs의 bc-10/bc-11이 VERIFY/PM에서
`declared:false`를 고정하고, bc-12가 CODER 무회귀를 고정한다).

## 5. 한계

1. **같은 세대 재소비 불가는 남는다** — 근본 수리는 책임자 등재 이슈
   HYK-492(첫 관측이 모든 값 게이트보다 앞선다는 구조 자체를 다시 설계하는
   일, 423·410·426·c-383과 공통 뿌리)의 몫이다. 이 라운드는 그 구조를
   바꾸지 않았다.
2. **같은 라벨 재배달은 RECEIPT_MISSING으로 막힌다(실측)** — 위 §2 ⓐ 행.
3. **라이브 실물 = 다음 실제 base 베끼기 1회**(이 라운드는 합성
   mkdtemp 2개 표본만 — reject-streak 원장도 admission 원장도 실물
   접근 0).
4. 〔못쟀다〕Linux CI·Node 20, 그리고 수백 개 레코드가 쌓인 실제 admission
   원장에서의 동작(이 기계 Node v26.2.0, 로컬 1개 레코드 표본).
5. P2-2 수리는 VERIFY·PM 라운드가 레거시 `head_commit:`을 base 선언으로
   읽히길 "의도한" 기존 사용 사례가 있는지까지는 전수 조사하지 않았다
   (이 저장소의 기존 테스트 중 resolveBaseCopyGuard/resolveDeclaredRoundBase
   를 참조하는 파일은 이 라운드 전까지 relay-handshake-base-copy.test.mjs
   하나뿐이었다 — grep 실측, 위 §2 표 범위 밖).
