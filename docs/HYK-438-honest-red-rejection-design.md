# HYK-438: honest red-backed rejection must reach the reject-streak ledger

## 사실 (실사고, HYK-430)

HYK-430 검토 1R의 결과 파일(`verdict: rejected`)은 정당한 반려였다 -- P1 2건이
정확히 지적했고, 그 근거 자체가 러너의 정직한 빨간 실행이었다:
정본 `npm test` 1회가 `relay-handshake-retire-author-shadow-wire.test.mjs`에서
실패했고(`runner_exit: 1`, `tests 5993 / pass 5986 / fail 1 / skip 6`), 영수증
자체가 그 사실을 담고 있었다. 하지만 소비 게이트
(`resolveRunnerReceiptVerdict`, `scripts/check/relay-handshake.mjs`)는
`runner_exit != 0`을 "초록을 주장하는 결과의 거짓 자기신고"로만 해석해
무조건 거부했다 -- `verdict:` 줄이 실제로 뭐라고 말하는지는 전혀 읽지
않았다.

결과: 이 정직한 반려는 소비되지 못했고, 소비가 안 되니
`runCompletionSideEffects`(reject-streak 기록이 일어나는 자리) 자체에
도달하지 못해 reject-streak 연속반려 계수기(게이트 2)에도 전혀 오르지
못했다. **주장(rejected)과 관측(빨간 러너)이 정확히 일치하는데, 그 일치가
오히려 소비를 막았다** -- 안전장치가 실제로 일어난 반려를 못 본 것이다.

## 범위

`resolveRunnerReceiptVerdict`(HYK-411이 만든, "빨간 러너 영수증이면
소비를 거부한다"는 그 축) 안에서만: 영수증이 빨강(`runner_exit !== 0`)이고
결과가 `verdict: rejected`를 정직하게 주장하며 그 영수증의 `head_commit`이
이 워크트리의 실제 HEAD와 일치하면, "초록을 주장"하는 것이 아니므로 이
축은 더 이상 거부하지 않는다 -- 소비가 허용되고, 기존 소비 경로
(`runCompletionSideEffects` -> `autoRecordRejectStreak`)가 평소처럼 그
반려를 reject-streak에 +1 적재한다.

**바뀌지 않는 것**:

- `verdict: approved` + 빨간 영수증 -- 여전히 무조건 거부(`RUNNER_RECEIPT_RED`).
  "초록을 주장"하는 빨강은 이 라운드가 손대는 범위가 전혀 아니다.
- `verdict: rejected` + 영수증이 초록/부재/무효/head 불일치/측정 불능 --
  전부 종전 그대로(무회귀). 이 축이 새로 여는 길은 "빨강 + head 일치 +
  정직한 rejected" 딱 한 칸뿐이다.
- `runner_exit: 0` 요구 자체, HYK-398/HYK-485/HYK-477/first-observation
  (HYK-492) 어느 것도 재개봉하지 않는다.
- `verdict:` 줄이 없는 결과(CODER/VERIFY/PM)는 이 축의 영향 밖 그대로다.

## 설계

판독은 `reject-streak.mjs`의 `parseReviewOutcome`을 "재사용"한다 -- 새
정규식을 따로 만들지 않는다. 이 게이트가 "rejected"라고 읽는 방식과
reject-streak 기록기가 "rejected"라고 읽는 방식이 같은 함수에서 나오지
않으면, 둘이 갈라질 때 "소비는 됐는데 streak에는 안 오른다"는 조용한
손실이 새로운 모양으로 재발할 수 있다(이 이슈가 막으려는 것과 같은
종류의 손실). `scripts/check/hyk438-honest-red-rejection.test.mjs`의
(438-11)은 이 드리프트를 직접 겨냥한다 -- `verdict:` 줄이 2개(모호,
`parseReviewOutcome` 스스로 거부하는 모양)인 표본은, 본문에 "rejected"라는
낱말이 있어도 이 축을 통과시키지 않는다.

흐름(수정 후 `resolveRunnerReceiptVerdict`):

1. (기존) 영수증 부재/파싱 실패/필수 필드 누락 -- `MISSING`/`INVALID`.
2. (기존, HYK-477) `runner_status === MEASUREMENT_UNAVAILABLE_OOM` --
   `MEASUREMENT_UNAVAILABLE`(시험 실패 아님, 측정 불능).
3. **(신설, HYK-438)** `parseReviewOutcome(resultContent)`가
   `verdict: "rejected"`를 명확히(모호하지 않게) 읽고, 영수증이 빨강이고,
   영수증의 `head_commit`이 실제 HEAD와 일치하면 -- 즉시 `{ ok: true }`.
4. (기존, HYK-411) 영수증이 빨강이면 -- `RUNNER_RECEIPT_RED`(3번에서
   빠져나온 모든 경우: `approved`, 모호한 verdict, verdict 줄 없음,
   head 불일치 모두 여기로 떨어진다).
5. (기존, HYK-408) `head_commit` 불일치 -- `STALE`.
6. (기존) 정상 소비 -- `{ ok: true }`.

3번이 4번보다 "먼저" 오는 순서가 핵심이다 -- 그래야 기존 4번/5번의 리터럴
텍스트를 한 글자도 바꾸지 않고(이 파일의 기존 되돌림-변이 시험
`relay-handshake-runner-receipt.test.mjs`의 `(rr-e2)`/`(rr-e3)`가 그 리터럴
블록을 그대로 대상 삼는다) 새 분기를 그 "앞"에 붙일 수 있다 -- 무회귀
증명이 코드 자체의 구조에서 나온다.

## 완료 조건

- repro438 모양 합성 표본: 수리 전 코드로는 `RUNNER_RECEIPT_RED`
  (base master `af9d002`에서 직접 재현, 결과 파일 §1-1 원문 참조),
  수리 후에는 소비 ok + 합성 reject-streak +1.
- 대조군(approved+빨강)은 여전히 거부.
- 변이 ≥4(제자리, sha256 선기록-복원 대조)가 이 새 분기의 각 조건
  (verdict 판독·head 일치·rejected만 허용·판독 함수 재사용)이 전부
  하중(load-bearing)임을 증명 -- 결과 파일 §2 변이표 참조.

## 라이브 실물 (이 라운드가 하지 않는 것)

이 라운드의 증거는 전부 합성(mkdtemp 안의 새 git 저장소)이다. 실물
검증은 다음 실제 "빨간 러너를 근거로 든 `rejected`" 검토 1회가 이
수리된 게이트를 통과해 reject-streak에 실제로 오르는 것으로만 끝난다.

## HYK-438-honest-red-2 (검토 1R P1-1 수리): 역할 조건

1R이 연 "정직한 빨강 반려" 예외(`isHonestRedBackedRejection`)는 role을
전혀 읽지 않았다 -- `verdict: rejected` 줄과 자기 head와 일치하는 빨간
영수증만 있으면 CODER/VERIFY/PM 결과도 이 예외를 통과해 소비됐다. 그런데
reject-streak 기록기(`recordRejectStreakFromResultText`, reject-streak.mjs)는
`isReviewFamilyRole(role)`이 아니면 적재 자체를 건너뛴다 -- 그래서
CODER/VERIFY/PM의 그런 결과는 "소비는 되는데 reject-streak에는 아무것도
적재되지 않는" 조용한 손실을 새 모양으로 재발시켰다(이 이슈 전체가
막으려는 바로 그 손실).

수리: `isHonestRedBackedRejection`에 `isReviewFamilyRole(role)` 조건을
맨 앞에 추가한다 -- 적재 쪽이 쓰는 것과 **같은 판별 함수**(새 정규식을
만들지 않는다). `role`은 `checkRelayHandshake` -> (새로 뽑은)
`resolveRunnerContractVerdictReturn` -> `resolveRunnerContractGatedVerdict`
-> `resolveRunnerReceiptVerdict` -> `isHonestRedBackedRejection`으로
내려 보낸다. `resolveRunnerContractVerdictReturn`은 `role`을 추가로
내려보내는 호출부 변경만으로 `checkRelayHandshake`가 quality-check
max-lines-per-function(80줄) 상한을 넘었기 때문에 그 함수에서 뽑아낸
순수 분해다(판정/사유/순서 무변, resolveRunnerContractGatedVerdict 자신이
이미 같은 이유로 뽑혔던 것과 동일 선례).

이 축 자신의 적용 범위(게이트 전체)는 role 무관으로 남는다 -- 바뀌는
것은 오직 "정직한 빨강 반려" 예외 하나뿐이다: REVIEW 계열은 여전히
rejected+빨강+head일치가 소비되고(streak +1, 무회귀), CODER/VERIFY/PM은
같은 입력이라도 이제 종전처럼 `RUNNER_RECEIPT_RED`로 거부된다.

RED-first 실측(수리 "전" base `ff04491`의 scripts/check 전체를 git
archive로 뽑은 별도 샌드박스에서 production `checkRelayHandshake`를
CODER/VERIFY/PM × `verdict: rejected` + 빨강 + head일치 입력으로 직접
구동): 세 역할 모두 `{"ok":true,"reason":"relay handshake ok for ..."}`
-- 수리 전에는 소비됐다(버그 재현, 사본 import 아님). 수리 "후"(이
커밋의 production 코드)로 같은 입력을 다시 구동하면 세 역할 모두
`{"ok":false,"code":"RUNNER_RECEIPT_RED"}`로 거부된다 -- REVIEW는
그대로 `{"ok":true}` + 합성 streak +1. 고정 테스트 =
`scripts/check/hyk438-honest-red-rejection.test.mjs`의 (438-12-_)/(438-13-_).

## 한계 (검토 1R P2-1, 범위 밖)

검토 1R P2-1: REVIEW rejected + 빨강 + **원장 손상**(reject-streak.json
자체가 깨져 있거나 쓸 수 없는 경우)은 그래도 소비(`checkRelayHandshake`
ok:true)되지만 적재는 0건으로 끝난다(`recordRejectStreakFromResultText`가
`loadLedger` 실패를 삼키는 기존 `NOT_BLOCKED` 경로, HYK-262/266 갈래가
"정직한 빨강 반려" 소비까지 넓어진 모양) -- 이 갈래는 이 조각(HYK-438)의
범위 밖이며 수리하지 않는다. 책임자 판단 대상.
