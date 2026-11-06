# HYK-266 — 원장 기록 실패 "조용한 통과"를 소비 차단으로 뒤집는 설계 (CODER 1R)

설계 근거: PM-r14(`D:\문서관리\하네스-관제실\PM\산출물\하네스\2026-11-05-원장기록실패-조용통과\`
`원장기록실패-조용통과-설계.md` + `근거-부록.md`, 기준 master `cc6e18f`). 책임자 판정
2026-11-05 23:0x(범위 확장 1·등재 2건 수용) + 2026-11-06 08:3x §3(레인 1 = 이 라운드,
7종 소비 차단 + 범위 밖 ⓐ 포함·ⓑ 제외).

## 0. 무엇이 바뀌었는가

`scripts/check/relay-handshake.mjs`의 `autoRecordRejectStreak`이 REVIEW 계열 결과 파일의
reject-streak 기록을 시도했는데 실패한(`attempted:true, ok:false`) 경우 중, HYK-262 §3이
"통과시킨다"고 결정했던 경로가 있었다:

- 판정 줄 0개(`NO_VERDICT_LINE`, 어휘 밖 값 포함 — `verdict: changes_requested` 같은 값도
  이 코드로 접힌다)
- 표지 줄 자체가 없음(`NO_COVER_LINE`)
- 이슈 id를 못 뽑음(`ISSUE_ID_UNPARSEABLE`)
- 원장 파일 읽기/파싱/모양 실패(`LEDGER_READ_FAILED` / `LEDGER_INVALID_JSON` /
  `LEDGER_INVALID_SHAPE`)
- 원장 쓰기 실패(`LEDGER_WRITE_ERROR`, relay-handshake.mjs 자신의 try/catch가 만든다)

여기에 `attempted:false, blocked:true`로 떨어지는 `UNISOLATED_HARNESS_DIR`(harnessDir가
격리된 git worktree가 아님)까지 더하면 8가지인데, 마지막 것은 이 코드를 **읽는 곳이 아예
없어서 흔적조차 남기지 않고** 통과했다(PM-r14 (a) 실측).

이 라운드는 이 8가지를 **전부 소비 실패로** 뒤집는다. 사유는 두 집합 + 하나의 독립
사유로 나눈다:

- **계약 위반**(`CONTRACT_VIOLATION_REASON_CODES`): `NO_VERDICT_LINE` · `NO_COVER_LINE` ·
  `ISSUE_ID_UNPARSEABLE`. 결과 파일 자신이 "판정을 끝냈다"는 계약을 지키지 않았다.
- **원장 사용 불가**(`LEDGER_UNAVAILABLE_REASON_CODES`): `LEDGER_READ_FAILED` ·
  `LEDGER_INVALID_JSON` · `LEDGER_INVALID_SHAPE` · `LEDGER_WRITE_ERROR`(리터럴 문자열 —
  reject-streak.mjs의 enum에 없다, 아래 §3). 결과 파일은 멀쩡한데 원장 쪽이 문제다 — 거부
  문면은 "워커 위반 아님 · 원장 복구 후 재소비하면 판정이 보존된다"를 명시한다.
- **UNISOLATED_HARNESS_DIR**(범위 밖 발견 ⓐ, 같은 함수): 별도 `checkUnisolatedHarnessDirViolation`
  함수로 독립된 사유를 낸다 — 계약 위반도 원장 손상도 아닌, "격리되지 않은 소비 맥락"이라는
  세 번째 범주다.

## 1. 왜 "통과"가 아니라 "차단"인가 (PM-r14 (b) 요지)

- 소비를 **통과**시키면: 판정이 복구 수단 없이 **영원히 원장에서 빠진다**(§2 게이트 2 —
  연속반려 — 의 계수가 조용히 줄어든 채 남는다). 라이브 표본 4라운드(HYK-214·218·227· 335) 전부가 이 모양이었다.
- 소비를 **막으면**: 원장이 손상된 동안에는 배달 게이트가 **이미** `REJECT_LEDGER_CORRUPT`로
  PM을 뺀 모든 배달을 fail-closed로 세운다 — 그래서 소비를 막아도 "새로운 전면 교착"은
  생기지 않는다(PM-r14 (b) 핵심 주장, 전제 P3 교차비평). 소비 차단이 더하는 비용은
  "이미 끝난 REVIEW 계열 라운드가 원장 복구 때까지 좌석을 점유한 채 대기한다"는 것뿐이고,
  CODER/VERIFY 소비는 기록을 시도조차 하지 않으므로 영향이 0이다.
- **되돌리기 비용**이 낮다(분류 Set 2개를 비우면 원복) — 그래서 "일단 넓게 막고, 과차단이
  실측되면 좁힌다"는 방향이 안전하다.

## 2. `recordRejectStreakFromResultText`의 parse/load 순서 (reject-streak.mjs)

수리 전: `loadLedger`를 **먼저** 부르고, 성공해야만 `computeRecord`(내부에서
`parseReviewOutcome`을 부름)로 간다. 그래서 원장이 손상된 동안 결과 파일도 깨졌으면
(예: 표지 줄 2개 이상 + 원장 손상이 동시에) **항상 LEDGER\_\* 사유만 보이고, 결과 파일
자신의 계약 위반은 한 번도 드러나지 않았다** — `loadLedger`가 `parseReviewOutcome`을
부르기도 전에 먼저 `ok:false`로 돌아갔기 때문이다(PM-r14 (a) 실측 원문).

수리 뒤: `parseReviewOutcome(resultText)`를 **먼저** 불러 결과 파일 자신의 계약 위반을
우선 가린다. 그다음에만 `loadLedger`로 간다. `computeRecord`는 그대로 두었다(여러
다른 호출자 — `computeRecord`를 직접 구동하는 시험 5개, `consumption-receipt-core.mjs` —
가 있어 그 함수의 시그니처/내부 동작을 바꾸면 범위를 넘는다) — 그래서 `computeRecord`는
내부에서 `parseReviewOutcome`을 다시 부르는 중복 호출이 생기지만, 멱등(순수 함수, 부작용
없음)이라 안전하고, `recordRejectStreakFromResultText`만의 추가 확인으로 격리된다.

이 순서 변경의 관측 가능한 효과는 **오직** "두 결함이 동시에 있을 때 어느 사유가
보이는가"뿐이다(변이③, 아래 §4) — 단일 결함 표본(S1·S2·S3·S5·S8)에서는 순서가 결과를
바꾸지 않는다.

## 3. `LEDGER_WRITE_ERROR`는 왜 리터럴 문자열인가

`REJECT_STREAK_REASON_CODE`(reject-streak.mjs)의 enum에는 이 값이 없다 — 그 코드는
`loadLedger`가 아니라 relay-handshake.mjs 자신의 `autoRecordRejectStreak`이
`recordRejectStreakFromResultText` 호출 전체를 감싼 try/catch(HYK-428)가, `writeLedger`의
예기치 못한 예외(예: 부모 `.harness/` 디렉터리 자체가 없음)를 접을 때만 만든다. 이 범위의
`reject-streak.mjs` 변경은 "`recordRejectStreakFromResultText`의 parse/load 순서만"으로
제한돼 있어(coder-task.md §2 product_scope), enum에 새 멤버를 추가하는 것은 범위 밖이다
— 그래서 `LEDGER_UNAVAILABLE_REASON_CODES`에 리터럴 `"LEDGER_WRITE_ERROR"`로 둔다.

**정직 한계(기법 차이, 실측)**: PM-r14 (g)는 S5 표본을 "원장 경로를 디렉터리로"로
제안했지만, 직접 실측한 결과 그 조작은 `LEDGER_READ_FAILED`를 낸다 —
`loadLedger`의 `existsSync(ledgerPath)`가 디렉터리도 "있다"로 보고
`readFileSync(ledgerPath)`가 `EISDIR`로 먼저 죽기 때문이다(쓰기 단계에 도달하지 못한다).
`LEDGER_WRITE_ERROR`를 실제로 내려면 **읽기는 "파일 없음"으로 통과하고 쓰기에서만
죽어야** 한다 — 이 라운드는 그 대신 "부모 `.harness/` 디렉터리 자체가 존재하지 않음"
(`writeFileSync`가 `ENOENT`로 죽음)을 썼다. "디렉터리로" 기법은 §L(LEDGER_READ_FAILED
보완 시험)로 자리를 옮겼다 — 7종 전부가 실제로 각자의 reasonCode로 재현됐다.

## 4. 시험 설계 (`hyk266-ledger-record-failure-block.test.mjs`)

- S1 `NO_VERDICT_LINE`(335 모양, `verdict: changes_requested`) · S2 `ISSUE_ID_UNPARSEABLE`
  (task_id 값이 `HYK-<숫자>`가 아님) · S3 `LEDGER_INVALID_JSON` + `approved`(정직한 통과
  표본에서도 원장 손상이 막는다) · S4 `LEDGER_INVALID_JSON` + `rejected` + 복구 뒤 같은
  세대 재소비(streak=1, 판정 보존 실증) · S5 `LEDGER_WRITE_ERROR`(위 §3) · S6 대조군
  (CODER + 손상된 원장, 무변) · S7 대조군(정상 REVIEW approved/rejected, 무변) · S8
  `UNISOLATED_HARNESS_DIR`(head_commit 축을 고립시켜야만 단독 관측 가능 — §5 참조).
- 보완(전건 커버리지, S-번호 밖): §K `NO_COVER_LINE`(아래 §5의 구조적 이유로 production
  CLI 전체로는 재현 불가 — `parseReviewOutcome`/`recordRejectStreakFromResultText` 직접
  구동으로 분류만 확인) · §L `LEDGER_READ_FAILED`(원장 경로 자체를 디렉터리로) · §M
  `LEDGER_INVALID_SHAPE`(유효한 JSON, `issues` 모양 위반).
- 전부 **RED 먼저**(이 라운드가 relay-handshake.mjs 호출부에 더한 call-site 블록만
  제거한 mkdtemp 사본으로 "수리 전" 모양을 재현 — 단일 결함 표본에서는 reject-streak.mjs의
  parse/load 순서가 결과를 바꾸지 않으므로 그 파일은 그대로 둔다) → **GREEN**(실 소스로
  재실행, 차단 확인).
- 변이 4개(ⓓ 요구): ① `CONTRACT_VIOLATION_REASON_CODES`에서 `NO_VERDICT_LINE` 제거 →
  S1 재개방 ② `LEDGER_UNAVAILABLE_REASON_CODES`에서 `"LEDGER_WRITE_ERROR"` 제거 → S5
  재개방 ③ reject-streak.mjs의 parse/load 순서를 되돌림 → 원장 손상 + 판정 줄 2개 겹친
  표본의 사유가 `LEDGER_INVALID_JSON`에서 `AMBIGUOUS_VERDICT_LINE`으로 바뀜(순서가
  load-bearing임을 증명) ④ `checkUnisolatedHarnessDirViolation` 호출 제거 → S8 재개방.

## 5. UNISOLATED_HARNESS_DIR/NO_COVER_LINE의 도달 불가능성 (정직 한계)

`hyk355-reject-streak-isolation.test.mjs` (a)가 이미 고정한 사실: harnessDir가 어떤 git
worktree에도 속하지 않으면, `resolveHeadCommitBinding`(HYK-383 head_commit 축)이
`UNISOLATED_HARNESS_DIR` 게이트보다 **먼저** "missing head_commit header"로 라운드
전체를 거부한다 — 그래서 production `checkRelayHandshake` 경로로는 이 갈래에 **절대
도달하지 못한다**(REVIEW-family에 한해 "사실상 도달 불가/죽은 코드", hyk355 (a) 원문).
이 라운드의 S8/변이④ 시험은 head_commit 축의 호출부(`resolveHeadCommitBinding({...})`)만
제거한 격리 사본으로 이 갈래를 **단독으로** 관측한다(defense-in-depth, hyk355 (c)/(d)와
같은 관용구) — production에서 이 갈래가 실제로 발동하려면 head_commit 축 자체가 먼저
무너져야 한다는 뜻이고, 그 전제 자체는 S8 시험의 마지막 단언("production, 격리 없음")이
다시 확인한다.

`NO_COVER_LINE`은 비슷한 이유로 더 근본적으로 도달 불가능하다: production 경로는 이
갈래에 도달하기 **전에** 이미 `resolveMatchedTaskId → resolveResultTaskId`가 결과
파일에 유효한 단일 `task_id:` 줄을 요구한다 — 그 줄이 있으면 reject-streak.mjs 자신의
`TASK_ID_LINE_RE_G`도 **같은 줄**을 찾아 `rawTaskId`를 채우므로(두 파서가 같은
`maskQuotedMarkerRegions`로 같은 텍스트를 본다), `for:`도 `task_id:`도 전혀 없는
상태는 production 경로로는 구조적으로 만들 수 없다. §K 시험은 `parseReviewOutcome`/
`recordRejectStreakFromResultText`를 직접 구동해 이 코드가 여전히 올바르게 분류되고
있음을 확인하는 것으로 범위를 좁힌다(hyk357-for-line-diagnostics.test.mjs의 "★회귀 0"
시험이 이미 같은 production export를 같은 방식으로 구동한다 — 새 관용구가 아니다).

## 6. 범위 밖 (이 라운드가 닫지 않는 것)

- **ⓑ 원장 갱신 잠금 없음**(reject-streak.json의 읽기-고치기-쓰기에 잠금이 없다 — 추론,
  동시 소비 시 갱신 손실 가능성). 이 라운드는 그 함수를 전혀 건드리지 않는다 — 별도
  조각 후보로 남긴다.
- 배달 게이트 · reject-streak 배달 게이트 · 소비 영수증 형식 · HYK-438 게이트
  (`isHonestRedBackedRejection`) · first-observation · 은퇴 · `watch-run.mjs`(HYK-491이
  쓴다, 교집합 0 유지) · 관제실 생성기/지시서.

## 7. 그렙-닻 동기화 (ⓐ⑷, 범위 밖 파일에 대한 최소 동기화)

이 변경의 함수 이름/반환 모양/흔적 문면 문자열을 `scripts` 아래 시험 전체에서 그렙한
결과, product_scope가 명시한 파일들 외에 아래 파일들이 **생산 경로에서 NO_VERDICT_LINE/
LEDGER_WRITE_ERROR/UNISOLATED_HARNESS_DIR이 더 이상 조용히 통과하지 않는다는 사실**에
걸렸다(전부 "이 round의 fixture가 그 통과를 전제로 짜여 있었다" 모양 — 그 전제가 이
라운드의 목적 자체로 바뀌었으므로, 각 파일에서 **최소한의 동기화**만 했다 — fixture에
`verdict:` 줄 추가 · `.harness/` 디렉터리 선행 생성 · 단언값을 새 계약으로 뒤집기):

- `scripts/check/hyk355-reject-streak-isolation.test.mjs` (c)/(d) — exit 0 → 1
- `scripts/check/envelope-archive-mutation.test.mjs`, `envelope-archive.test.mjs` —
  fixture에 verdict 추가(+ `.harness/` 생성)
- `scripts/check/hyk492-value-refusal-observation.test.mjs`,
  `nc-codex-lane-future-block.test.mjs`, `relay-handshake-base-copy.test.mjs`,
  `relay-handshake-head-commit.test.mjs`, `relay-handshake.test.mjs` — 같은 패턴
- `scripts/relay/go-wait-pilot.test.mjs` — 같은 패턴

전부 `node --test`로 개별 재확인했다(결과 파일 §3 참조) — 단언이 약화된 곳은 없다,
표지(`.harness` 생성·verdict 추가)만 더했거나 기대값을 새 계약으로 뒤집었다.
