# HYK-419-wire-1 — 은퇴 자동화 코어를 "그림자"로 처음 부른다

이 문서는 docs/HYK-419-retire-author-design.md(4R, #247로 병합)가 "범위 밖"으로
명시적으로 남긴 두 항목 — ⑴ 라이브 원장/영수증을 실제로 읽는 어댑터 ⑵
`relay-handshake.mjs`에 그 코어를 실제로 잇는 것 — 중 **관측만** 결선한다.
판정 로직·닫힌 상태 집합·`blockReasonCode` 정책은 이 라운드가 전혀 건드리지
않는다(4R 문서를 그대로 전제로 삼는다).

## 0. 왜 "그림자"인가 (배경 재확인)

ORCH가 실측한 사실: `retirement-auto-author-core.mjs`(4R이 만든 코어)를
저장소 안 어떤 코드도 부르지 않는다(자기 자신의 시험 파일 제외, grep 결과
0건). 코어는 있지만 아무도 부르지 않는 상태 — 이 라운드는 그 문을 처음
연다. 단, coder-task.md §0의 비타협("차단 0")에 따라 **아무것도 차단하지
않는다**: 이 라운드가 다 끝나도 배달 게이트·소비 판정·exit code 중 어느
것도 이 결선 이전과 한 글자도 다르지 않아야 한다.

## 1. 새 모듈 — `scripts/check/retirement-auto-author-facts.mjs`

`evaluateAutoAuthorAuthorization`(retirement-auto-author-core.mjs)이 요구하는
`facts` 객체를 조립하는 **순수 조립기**. 판정 0 · 쓰기 0 · 경로 하드코딩 0 ·
Never throws(retirement-record-writer.mjs와 동일 계약) — 이 넷은 이 파일의
비타협이며, 시험(retirement-auto-author-facts.test.mjs)이 각각 최소 1건씩
직접 확인한다.

### 무엇을 읽는가 (그리고 정확히 어떻게)

| 소스                                                 | 읽는 방법                                                                                                                                                                                                                                                                                       | facts로 만드는 값                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `admission-ledger.json`(경로는 `ledgerPath` 인자)    | JSON.parse 후 `reservations[harnessTaskLabel]` 조회 — reservationId가 harnessTaskLabel과 같다는 전제는 admission-completion-adapter.mjs의 verifyBlockedTerminationEvidence와 동일(이 파일이 새로 만든 가정이 아니다)                                                                            | `ledgerReservation`(exists/status/completedAt), `admittedAt`(내부용, staleEnoughSinceAdmission 계산에만 씀) |
| `dispatch-receipts.jsonl`(경로는 `receiptPath` 인자) | admission-completion-adapter.mjs의 `hasDispatchReceiptForRound`와 동일한 손상-줄-건너뜀 관례를 복제(무거운 정적 import를 늘리지 않기 위해 — 그 파일 헤더가 이미 밝힌 이유 그대로)                                                                                                               | `dispatchReceiptMatchCount`                                                                                 |
| `.harness/rounds/`(harnessDir 하위)                  | relay-handshake.mjs의 `hasArchivedRoundCopyForTaskId`와 동일한 파일명 관례(`<role>-r<N>.md`/`<role>-task-r<N>.md`, 대소문자 무관)로 이 harnessTaskLabel과 일치하는 자기 task 아카이브를 찾고, 그 다음 순번(N+1) task 아카이브 존재 여부·매칭되는 result 아카이브 존재 여부를 같은 방식으로 판정 | `ownTaskArchiveExists`, `ownTaskArchivePath`, `hasLaterRoundArchive`, `resultArchiveExists`                 |
| 자기 task 아카이브 파일 실물                         | 찾은 파일을 다시 읽어 SHA-256 재계산(core의 `defaultSha256Hex`와 동일 함수)                                                                                                                                                                                                                     | `ownTaskArchiveFingerprint`                                                                                 |

### 무엇을 읽지 않는가 (의도적)

- **`successorLabelForRecord`/`recordedAt`은 조립하지 않는다** — 호출자가
  이미 아는 값을 그대로 전달받는다(coder-task.md §2⑶ 원칙: 다른 축이 아는
  값을 이 파일이 추측하지 않는다). 그림자 결선 지점(relay-handshake.mjs)은
  `recordedAt`으로 이 라운드의 DONE 타임스탬프를 넘기고, `successorLabelForRecord`는
  넘기지 않는다(아래 §3 참조 — 그 결과 항상 `SUCCESSOR_LABEL_MISSING`으로
  닫히는 것이 이 시점의 정직한 관측이다).
- **`blockReasonCode`는 손대지 않는다** — coder-task.md §2⑶ 비타협 그대로,
  이 조립기의 facts 구조 자체에 그 필드가 없다(코어도 그 필드를 읽지 않는다,
  4R 설계 §C).
- **staleEnoughSinceAdmission의 임계치는 이 저장소 어디에도 정본이 없다**
  (아래 §5 정직 한계).

## 1-b. 왜 서브프로세스 스폰인가 — 정적 import 첫 시도가 실제로 깬 것 (수리 기록)

1R의 첫 시도는 `relay-handshake.mjs`에 `assembleAutoAuthorFacts`/
`evaluateAutoAuthorAuthorization`를 **정적 import**했다. `npm test`를 커밋
직후 돌려 실측한 결과 5819개 중 60개가 실패했다 — 원인은 이 저장소가
`relay-handshake.mjs`를 "정확히 알려진 형제 파일 목록"(주로
`time-authority.mjs`/`reject-streak.mjs`/`envelope-archive.mjs` 셋)만 복사해
격리 디렉터리에서 서브프로세스로 돌리는 시험을 **24개** 갖고 있기 때문이다
(`admission-completion-spawn.test.mjs`가 대표 사례 — 그 파일 자신의 주석이
이미 "1R의 정적 import가 정확히 이 모양을 깼었다"는 전례를 기록해 두고
있었다, `admission-completion-adapter.mjs`/`abort-record-writer.mjs`가 같은
이유로 스폰 방식을 쓰는 이유이기도 하다). 5번째 정적 import를 추가하면 그
시험들이 전부 LOAD 시점에 `MODULE_NOT_FOUND`로 깨진다 — CALL 시점에만
실패하는 스폰과 달리 try/catch로 흡수할 수 없는 지점에서 죽는다.

그래서 최종 설계는 이 저장소의 기존 관례(`spawnAbortRecordWriter`/
`spawnAdmissionCompletionProcess`와 완전히 동일한 모양)를 따라 새 CLI
진입점 `scripts/check/retirement-auto-author-shadow-cli.mjs`를 만들고,
`relay-handshake.mjs`는 그 파일을 **정적 import하지 않고 `execFileSync`로
스폰**한다. 조립기·코어를 실제로 import하는 것은 이 새 CLI 파일 하나뿐이다
— `relay-handshake.mjs`의 정적 import 그래프는 이 라운드 이전과 완전히
동일하게 남는다. `retirement-auto-author-shadow-cli.test.mjs`의 "CLI: 인자가
아예 없어도 exit 0" 시험과
`relay-handshake-retire-author-shadow-wire.test.mjs`의 (B-2) 시험(CLI 형제
파일이 격리 픽스처에 없는 정확히 같은 모양을 재현)이 이 수리를 회귀
방지로 고정한다.

## 2. 호출 지점 선택 — `relay-handshake.mjs`의 `runCompletionSideEffects`

coder-task.md §2⑵가 1순위로 지정한 "소비 경로"를 그대로 따른다. 구체적으로는
`runCompletionSideEffects`(모든 필수 후속효과 — 첫 관측 기록·reject-streak
기록·봉투/과제 아카이브·admission completion·소비 영수증 — 가 전부 끝난
직후, `return null` 직전)를 골랐다. 이유:

1. 이 함수는 `checkRelayHandshake`가 **성공(ok:true)으로 확정한** 유일한
   완료 경로다 — BLOCKED/NEEDS_INPUT 종결(`runBlockedTerminationSideEffectsIfApplicable`)이나
   STALE 은퇴 경로(`runRetirementSideEffects`)는 이 라운드가 잇지 않는다
   (아래 정직 한계).
2. 이 자리는 이미 "모든 후속효과의 결과가 나온 뒤에만 실행"이라는 관례가
   서 있다(소비 영수증 발행이 바로 그 예 — HYK-244 2R-a §2 조각2 주석
   참조). 그림자 관측도 같은 원칙(다른 효과를 방해하지 않는 최종 단계)을
   따르는 것이 일관적이다.
3. `checkRelayHandshake`의 실제 호출자가 5곳(relay-core.mjs, watch-result.mjs,
   orca-spike-runner.mjs, orca-spike-live.mjs, seat-signal-adapter.mjs)이라,
   이 자리에 심으면 다섯 호출자 전부가 자동으로 그림자 관측을 받는다(CLI
   전용 지점에 심었다면 놓쳤을 4곳).

## 3. 차단 0 — 삼중 방어선

1. **조립기 자신의 Never-throws 계약**(§1) — 어떤 I/O 실패도 예외로 새지
   않고 `{ok:false, code, reason}`으로 접는다.
2. **CLI 진입점(retirement-auto-author-shadow-cli.mjs)의 자체 try/catch** —
   조립기의 계약을 신뢰하지 않고 자신도 한 번 더 감싼다(`buildShadowLine`),
   그래서 이 CLI는 무엇을 하든 항상 정확히 한 줄을 stdout에 찍고 exit 0으로
   끝난다(`retirement-auto-author-shadow-cli.test.mjs`의 "인자가 아예 없어도
   exit 0" 시험이 이를 직접 확인한다).
3. **relay-handshake.mjs 쪽 스폰 호출의 자체 try/catch** —
   `runRetireAuthorShadowObservation`은 CLI 자신의 계약도 신뢰하지 않고 한
   번 더 감싼다(스폰 자체의 실패 — CLI 파일 부재·`node` 실행 실패 등 —
   까지 흡수). 이 함수는 `execFileFn`/`logFn`을 선택적으로 주입받을 수
   있게 만들어(기본값은 실제 `execFileSync`/`console.log`), 시험이 "스폰이
   강제로 던지는" 상황을 직접 재현해 이 바깥 방어선 자체를 증명할 수 있게
   했다(relay-handshake-retire-author-shadow-wire.test.mjs (C)).

세 방어선 모두 시험이 실제로 통과시킨다 — (B)는 실제 조립 실패
(DISPATCH_RECEIPT_PATH 미설정)가 발생한 상태에서 `checkRelayHandshake`의
`ok:true`·영수증 생성이 그대로임을, (B-2)는 CLI 형제 파일 자체가 격리
픽스처에 없어도(스폰 실패) exit 0이 유지됨을(§1-b가 기록한 수리의 회귀
방지), (C)는 스폰 함수(`execFileFn`)가 강제로 throw하도록 주입해도
`runRetireAuthorShadowObservation` 자신이 예외를 던지지 않음을 각각
증명한다.

## 4. 출력 형식

```
retire-author-shadow: <state> reason=<code> label=<harnessTaskLabel> (shadow -- 아무것도 차단하지 않음)
```

`<state>`는 이 관측이 어느 단계까지 도달했는지의 대분류다:

- `ASSEMBLE_FAILED` — 조립기가 `{ok:false}`를 돌려줬다(reason=조립기의 `code`,
  예: `LEDGER_UNREADABLE`/`RECEIPT_UNREADABLE`/`ROUNDS_DIR_UNREADABLE`/`MISSING_ARGS`/`LEDGER_MALFORMED`).
- `JUDGED` — 조립까지는 성공해 코어가 실제로 판정했다(reason=코어의 `state`,
  예: `AUTHORIZED_DRAFT`/`GATE_CLOSED`/`MACHINE_ANCHOR_INCOMPLETE`/...).
- `OBSERVATION_ERROR` — §3의 바깥 방어선이 실제로 작동한 경우(reason=예외
  메시지) — 정상 운영에서는 절대 나타나서는 안 되는 상태이지만, 나타나도
  소비를 막지 않는다.

세 경우 모두 **정확히 한 줄**이 찍힌다(coder-task.md §2⑵ "조용히 아무 줄도
안 찍는 경우가 있으면 안 된다" 요구 — 이 라운드는 그 요구를 그림자 결선
지점의 유일한 실행 경로에 무조건 진입하는 것으로 지킨다, 앞의 세 갈래가
서로 배타적이고 전부 `logFn` 호출로 끝난다).

## 5. 정직 한계

1. **`SHADOW_STALE_THRESHOLD_MS`(24시간)는 임시값이다.** 이 저장소 어디에도
   "stall-watch 임계치"의 정본 상수가 없다(hyk412-never-consumed-retire-core.mjs
   자신도 이 계산을 호출자에게 위임한다, 그 파일 §2 항목3). 그림자 관측이
   TOO_RECENT로 잘못 접히거나 잘못 통과해도 아무것도 막지 않으므로 이
   라운드 범위에서는 문제가 되지 않지만, **진짜 결선(실제 차단)으로 가기
   전에는 이 값을 정본 상수로 교체하거나, 별도 라운드에서 그 정본 자체를
   확정해야 한다.**
2. **BLOCKED/NEEDS_INPUT 종결 경로와 STALE 은퇴 경로는 이 라운드가 잇지
   않는다.** `runCompletionSideEffects` 한 곳만 결선했다(§2) — 정지
   종결이나 이미 STALE로 판정된 라운드에 대해서는 그림자 관측이 아예
   실행되지 않는다. 다음 라운드가 "1순위 소비 경로"만으로 충분한지, 이
   두 경로도 필요한지 판단해야 한다.
3. **`successorLabelForRecord`를 그림자 결선 지점이 채우지 않는다.** 실제
   운영에서 이 값을 아는 주체가 아직 없으므로(4R 문서도 이 값의 출처를
   정하지 않았다), 이 라운드의 그림자 관측은 항상 `SUCCESSOR_LABEL_MISSING`으로
   닫힐 가능성이 높다(facts 자체는 정직하게 조립되지만, 그 조립 결과가
   구조적으로 AUTHORIZED_DRAFT에 도달하기 어렵다는 뜻). retirement-auto-author-facts.test.mjs의
   "완전 성공 경로" 시험은 그 값을 시험이 직접 공급해 코어까지 도달
   가능함을 증명했을 뿐, 실제 결선 지점이 그 값을 알아낼 방법은 아직
   없다.
4. **그림자에서 진짜 결선(실제 차단)으로 갈 때 무엇이 더 필요한가**:
   - §5-1의 정본 stall-watch 임계치 확정.
   - §5-3의 successorLabelForRecord 출처 확정(어느 축이 "다음 라운드
     이름표"를 알고 있는지 — ORCH 배달 로직 쪽일 가능성이 크다).
   - `AUTHORIZED_DRAFT`가 나온 뒤 그 초안을 **누가, 언제, 어떤 트리거로**
     `retirement-record-writer.mjs`에 넘길지(사람 승인 게이트의 정확한
     모양) — 4R 문서 §A가 이미 "그 함수 자신은 파일을 쓰지 않는다"까지만
     정했고, 그 다음 단계는 아직 설계되지 않았다.
   - §2에서 다루지 않은 BLOCKED/NEEDS_INPUT·STALE 경로의 결선 여부 결정.
5. **관측 자체의 정확도는 검증하지 않았다.** 이 라운드는 "조립이 실제
   파일에서 이뤄지는가"와 "차단 0"을 시험으로 고정했지만, 조립된 facts가
   실제 운영 데이터에 대해 "옳은" 판정을 내리는지(예: 정말로 방치된
   라운드에서 정말로 AUTHORIZED_DRAFT가 나오는지)는 실 운영 트래픽으로
   아직 관찰되지 않았다 — 그림자이므로 이 라운드 범위에서는 요구되지
   않는다(coder-task.md §1b_shown: "사람이 한 줄을 눈으로 읽는다"가
   완료 조건의 전부).
