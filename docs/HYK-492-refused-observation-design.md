# HYK-492: 거부로 끝난 관측의 지문 재기준 (②′)

- 라벨: HYK-492-refused-obs-1 · 기준: master `2a753c8a95185698dd5a4e9613ec407b6ed99251`
- 설계 정본: `D:\문서관리\하네스-관제실\PM\산출물\하네스\2026-11-04-막다른모양-첫관측-순서\막다른모양-첫관측-순서-설계.md` §(b) ②′
- 이 메모는 그 설계를 구현 레벨에서 어떻게 실현했는지(정확히 어떤 함수가
  무엇을 하는지)를 적는다 -- 설계 자체의 트레이드오프는 위 PM 산출물이
  정본이다.

## 1. 왜

`relay-handshake.mjs`는 결과 파일을 보고 "중간에 다시 쓰였는가"를
`first-observation.mjs`의 관측 원장으로 판정한다(HYK-257-done-stamp-2/3).
그런데 S = {HYK-424 base-copy guard, HYK-383 head_commit 대조} 두 게이트가
거부하면, 그 거부를 고치려고 **같은 필드(head_commit)만** 수정해도
다음 폴에서 지문이 달라져 `DONE_REWRITTEN_AFTER_FIRST_OBSERVATION`으로
다시 거부됐다(실측: HYK-424-head-label-2/3). 유일한 복구 경로는 ORCH가
작성자 HEAD의 새 워크트리 + 새 라벨로 재배달하는 것뿐이었다 -- 사람/ORCH
손이 매 거부마다 든다.

과거 시도(HYK-423):

- 1R(`229a244`): 거부 시 관측 세대를 통째로 tombstone(consume)했다 --
  2R 검토가 "거부를 일부러 유도한 뒤 DONE 줄까지 바꿔치기할 수 있다"로
  반려했다(원본이 없어지므로 재작성 가드가 비교할 기준이 사라진다).
- 2R(`452902c`): 1R을 전부 되돌리고, 대신 지문 보호 범위를 DONE 줄까지로
  좁혔다(`protectedScope`/`judgedRegion`). 거부 축의 "같은 필드만 고치면
  재소비된다"는 요구는 **의도적으로 미해결**로 남겼다("documented
  limitation").

## 2. 이번 설계(②′)와 그 경계

**DONE 줄 기준값(findFirstObservation)과 DONE 줄 비교(checkIntermediateRewrite
의 doneLineRaw 비교)는 손대지 않는다.** 바뀌는 것은 오직 "지문" 비교의
기준값이다 -- 그리고 그 재기준은 **S 두 게이트가 거부했을 때만** 일어난다.

### 2-1. `first-observation.mjs`

- `markRefused({taskId, droppedAt, role, harnessDir, reason})` (신설): 관측
  원장에 `{..., refused: true, reason}` 한 줄을 append한다. **세대를
  tombstone하지 않는다** -- `consumed`가 아니라 `refused`라는 별도
  필드를 쓰므로, `findFirstObservation`(바이트 무변)은 이 항목을 완전히
  무시한다(그 함수는 `consumed === true`만 리셋 신호로 본다). 452902c가
  반려한 모양("거부 = tombstone => 원본이 없어진다")을 다시 열지 않는
  이유가 바로 이것이다.
- `findFingerprintBaseline(...)` (신설): `findFirstObservation`과 거의
  같은 순회이지만, `refused === true` 항목도 `consumed === true`와
  똑같이 "활성 관측 리셋" 신호로 본다. 거부가 없던 세대에서는 이 함수와
  `findFirstObservation`이 항상 같은 항목을 돌려준다(오탐 0, §4 무회귀).
- `recordFirstDoneObservation`의 "이미 관측했으니 쓰지 않는다" 게이트를
  `findFirstObservation` 대신 `findFingerprintBaseline`으로 바꿨다. 거부
  표시 뒤에는 이 게이트가 다시 열려, 다음 관측이 "거부 뒤 첫 관측"으로
  새로 기록된다(자기 자신과 비교하므로 항상 일치 -- 기존 "처음 관측은
  스스로와 비교" 패턴과 동일).
- `checkIntermediateRewrite`: 지문 비교 기준값만 `findFingerprintBaseline`
  으로 바꿨다(`?? existing` fallback으로, recordFirstDoneObservation을
  거치지 않고 직접 호출하는 기존 단위 시험과의 동등성을 보장한다). DONE
  줄 비교는 여전히 `existing`(= `findFirstObservation`, 세대의 진짜 첫
  관측)과만 비교한다.

### 2-2. `relay-handshake.mjs`

- S 두 게이트의 호출부(`checkRelayHandshake` 안의 `const baseCopyVerdict
= resolveBaseCopyRejection(...)`, `const headCommitVerdict =
resolveHeadCommitBinding(...)`)는 **두 개의 기존 변이 시험에 글자
  하나까지 고정**돼 있다(`hyk355-reject-streak-isolation.test.mjs`,
  `hyk423-observation-order.test.mjs` (mut-3), `relay-handshake-base-
copy.test.mjs` (bc-9)). 그래서 `markRefused` 호출은 그 호출부가 아니라
  **거부가 확정되는 콜리(callee) 안**에 둔다:
  - `resolveBaseCopyRejection`(이미 비-exported 1회용 래퍼였다 -- 몸통만
    바꿨다, 호출부 리터럴은 무변): `verdict.ok === false`일 때
    `spawnMarkRefused({taskId: core.taskId, droppedAt:
core.droppedMatch[1].trim(), ...})`.
  - `resolveHeadCommitBinding`: 원래 몸통을 `resolveHeadCommitBindingCore`
    로 이름만 바꾸고, `export function resolveHeadCommitBinding`은 그
    core를 부른 뒤 `!verdict.ok`일 때만 best-effort로 markRefused를
    띄우는 **얇은 래퍼**가 됐다. `taskId`/`droppedAt`은 이 함수의 유일한
    입력인 `taskContent`에서 `TASK_ID_RE`/`DROPPED_AT_RE`로 다시 뽑는다
    (실제 호출 경로에서는 이미 `resolveMatchedTaskId`/`resolveDroppedAt`
    이 같은 `taskContent`로 이 값들을 검증해 통과한 뒤이므로 항상
    성공한다 -- 실패하면 best-effort라 조용히 건너뛴다).
  - `spawnMarkRefused`: `spawnMarkObservationConsumed`와 같은 house
    style(best-effort, non-fatal)로 `first-observation.mjs`를 자식
    프로세스로 스폰해 `action: "markRefused"`를 전달한다(정적 import가
    아니다 -- 격리 변이 시험 4파일 목록에 새 항목을 추가하지 않는다).
- HYK-424 거부 문구(`resolveBaseCopyGuard`)만 갱신했다: "head_commit
  줄만 고쳐라, DONE 줄은 건드리지 마라, 그러면 같은 세대 재소비가
  통과한다"를 추가하고, "DONE 줄까지 고친 경우"에 한해 기존 문구(§31
  새 워크트리 경로 안내)를 유지한다. HYK-383(`resolveHeadCommitBinding`)
  의 거부 문구는 손대지 않았다(이 라운드의 범위는 424 문구 1곳뿐).

## 3. S 밖 게이트는 왜 안전한가

STALE(`STALE_DONE_PREDATES_DROP`)·mislabel·future-skew·러너 영수증·G1은
`markRefused`를 전혀 부르지 않는다 -- 그래서 그 축들의 거부 뒤에는
`hasRefusalForGeneration`이 항상 false이고(이 세대에 `refused:true` 항목
자체가 없으므로), head_commit-only 예외(아래 §5)가 켜질 일이 없다 --
거부 전과 바이트 하나도 다르지 않게 움직인다(§6 무회귀). 구조적으로도
STALE은 `checkRewriteAndStaleness`에서 `baseCopyVerdict`/`headCommitVerdict`
보다 **먼저** 평가되므로, STALE이 거부하는 라운드는 S 게이트 함수
자체에 도달하지도 않는다.

## 5. 2R(②″) 좁히기 -- head_commit 줄 «하나만» 눈감아준다

REVIEW 1R(review.md §3 P2-4)이 반려한 폭: 1R은 S 게이트가 거부한 뒤
지문 기준값 자체를 `null`로 "리셋"했다(`findFingerprintBaseline`). 그
리셋 뒤 첫 재관측은 무엇이든 "스스로와 비교"되므로 head_commit 줄 하나만
바뀐 것인지, DONE 앞 본문 전체(REVIEW의 `verdict:` 판정 낱말 포함)가
바뀐 것인지 구별하지 못했다 -- 실측(C2b): 383 거부를 유도한 뒤
head_commit을 고치면서 `verdict: rejected`를 `approved`로 같이 바꿔도
같은 세대로 통과했다(ok:true).

②″는 "리셋" 개념을 버린다. 비교 기준값은 1R 이전과 같이 항상 세대의
진짜 첫 관측(`existing`, `findFirstObservation`, 바이트 무변)에 고정된
채다 -- 다만 그 비교 자체가 바이트 완전 일치 하나만이 아니라 **둘 중
하나**가 되었다:

1. `existing.resultFingerprint === fingerprint(resultContent)` (바이트
   완전 일치, 1R 이전과 동일), 또는
2. 다음 셋이 **모두** 참일 때만: ⓐ 위 1이 거짓이고(즉 뭔가 다르고) ⓑ
   `blankHeadCommitLine`(head_commit: 줄의 값만 지우는 정규식 치환)으로
   양쪽을 정규화한 지문이 그래도 일치하고(= head_commit 줄 «하나만»의
   값이 달랐다는 뜻, 그 줄의 위치·개수가 달라지거나 다른 줄이 단 한
   글자라도 달랐으면 이 정규화 지문도 달라진다) ⓒ 이 세대가 S 게이트에
   한 번이라도 거부된 적이 있다(`hasRefusalForGeneration`, `consumed`에만
   리셋되는 생성-전역 스위치 -- "마지막 거부 이후"로 좁히지 않는다).

DONE 줄 비교(`existing.doneLineRaw !== currentDoneLine`)는 완전히
그대로다 -- 위 두 경로 중 어느 쪽으로 본문이 "일치"하더라도 DONE 줄이
한 글자라도 다르면 여전히 거부된다(452902c가 막은 모양, mut-2/mut-5가
이 두 축을 각각 따로 고정한다).

## 6. P2-2: 거부가 고쳐지지 않은 재폴은 원장을 키우지 않는다

1R은 거부 표시 뒤 "아직 재관측이 없으면 기록한다"는 게이트만 썼다 --
내용이 전혀 바뀌지 않은 채 같은 폴이 반복돼도(워커가 아무것도 고치지
않음) 매 폴마다 관측 1줄 + refused 1줄이 새로 쌓였다(review.md §3
"growth.mjs" 실측: 4회 폴 -> 8줄). ②″는 "직전 관측과 지문이 같으면
적지 않는다"는 조건을 `recordFirstDoneObservation`과 `markRefused`
양쪽에 똑같이 추가한다 -- 관측 쪽만 막으면 refused 쪽이 계속 자라
반만 닫히므로, 두 mark 함수 모두 "거부된 적이 있고(refusedSinceLastObservation)
그 직전 관측과 지문이 같다"일 때만 조용히 건너뛴다. 내용이 실제로
달라지면(거부 뒤의 정당한 수정이든, 거부 없이 조용한 변조든) 평소처럼
기록되거나 거부된다 -- 이 중복 방지는 "똑같은 재시도"만 골라낸다.

## 7. 한계(정직)

- 거부 표시 줄은 워커가 쓸 수 있는 표면(관측 원장 = 워크트리 안)에
  있다 -- HYK-412 §5-(d)와 같은 한계(기계 신뢰 경계가 아니라 best-effort
  감사 흔적).
- S = {424, 383} 둘뿐이다. 다른 값 게이트가 같은 "거부 뒤 같은 필드만
  고치면 재소비"가 필요해지면, 그때마다 호출부에 markRefused를 추가하는
  같은 패턴을 반복해야 한다(이 라운드는 그 일반화를 하지 않는다 --
  PM 설계 §(h) 해석 확인 범위 그대로).
- DONE 줄까지 고친 경우는 여전히 같은 세대에서 재소비할 수 없다 -- 그
  경우는 관제실 ORCH70 §31(새 워크트리 + 새 라벨)로 간다.
- 손으로 위조한 `refused:true` 줄(관측 원장 = 워크트리 안의 파일이라
  워커가 쓸 수 있는 표면, 위 첫 항목과 같은 한계)은 S 밖 거부에도
  head_commit-only 눈감아주기를 켤 수 있다 -- 하지만 그 위조로 열리는
  범위는 "head_commit 줄 하나의 값"뿐이다(DONE 줄 고정은 위조로도 안
  열린다, §5). 원장을 통째로 비워 DONE까지 바꿔치기하는 기존 한계
  (HYK-412 §5-(d) 계열)보다 좁다 -- 새로운 종류의 문은 아니다.
- 라이브 실물 검증은 다음 실제 424/383 거부 1회에서 일어난다(이 라운드는
  전부 합성 fixture다, mkdtemp git 저장소).
