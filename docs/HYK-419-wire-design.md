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

## 6. HYK-419-wire-2 (2R 수리) — «멈추지 않게» + «침묵하지 않게»

1R 리뷰가 실측으로 반증한 두 결함(§0 재확인):

- **P1-1**: `runRetireAuthorShadowObservation`의 `execFileSync` 호출에 시간
  제한이 없었다 — 격리 표적으로 1.5초 지연 자식을 실제로 실행해 부모
  probe timeout(300ms)에서 `ETIMEDOUT`/`SIGTERM`을 재현했다. 소비 경로
  안에서 동기 실행되는 호출이 시간 제한 없이 걸리면 "무엇을 하든 소비
  동작·종료코드 불변"이 깨진다.
- **P1-2**: catch의 `String(err.stderr ?? err.message).trim()`을 reason에
  원문 그대로 삽입해, 격리 자식의 stderr(2줄)·CLI 부재 Node 오류(18~19줄)·
  throw 오류(12줄)가 각각 그만큼의 물리 줄로 새어 나갔다. 게다가 **exit
  0으로 stderr만 쓴 자식**은 `out.trim()`이 빈 문자열이 되어
  `retire-author-shadow:` 줄 자체가 사라졌다(0줄 — 이 라운드의 비타협
  "침묵 0" 위반).

### 6-1. 시간 제한 (§2⑴)

`SHADOW_CLI_TIMEOUT_MS = 2000`(ms). 근거: 정상 조립+판정(rounds/ 파일
몇 개 읽기)은 이 저장소의 실측(retirement-auto-author-shadow-cli.test.mjs)에서
100ms를 넘지 않았다 — 2000ms는 정상 왕복의 20배 이상 여유를 두면서도
"무제한 대기"라는 P1-1의 실제 결함은 구조적으로 막는다(2000ms 뒤에는
반드시 끊긴다). `execFileSync`의 `timeout`/`killSignal: 'SIGKILL'` 옵션을
그대로 쓴다 — Node가 그 옵션의 시간 초과를 `err.code === 'ETIMEDOUT'`로
알려준다는 것을 이 워크트리에서 직접 재현해 확인했다(`isTimeoutError`).
`killSignal`을 기본값 `SIGTERM`이 아니라 `SIGKILL`로 명시한 이유: SIGTERM은
자식이 무시/트랩할 수 있어 "멈추지 않는다"는 비타협을 끝까지 보장하지
못한다 — SIGKILL은 무시할 수 없다.

**시간 초과도 차단 0으로 흡수한다**: catch 블록이 `isTimeoutError(err)`로
분기해 `state=TIMEOUT`인 한 줄을 만들고, 소비는 그대로 성공한다
(relay-handshake-retire-author-shadow-wire.test.mjs (E)가 **진짜 3000ms
지연 자식**을 200ms 시간 제한으로 실제로 죽여 이를 증명한다 — 흉내가
아니라 실 child_process 타이밍이다).

**좀비/핸들 정직 한계**: `execFileSync`는 동기 함수라 Node가 내부적으로
자식의 종료(정상이든 kill이든)를 확인한 뒤에만 반환한다 — 별도의 좀비
방지 코드를 이 함수가 추가로 둘 필요가 없다(호출이 반환됐다는 것 자체가
자식이 이미 죽었다는 뜻). 이 워크트리는 Windows이고, Windows에는 POSIX
시그널이 없어 Node가 `SIGKILL`을 내부적으로 `TerminateProcess`로
매핑한다 — 이 라운드는 그 매핑을 직접 관찰(실측)했을 뿐, POSIX 플랫폼에서
동일 옵션이 정말 좀비를 안 남기는지는 별도로 확인하지 않았다(정직 한계,
Node 문서상 spawnSync 계열은 두 플랫폼 모두 동기 대기를 보장한다고
명시하지만 이 라운드가 그 문서 이상을 검증하지는 않았다).

### 6-2. «정확히 한 줄» 계약 (§2⑵)

**부모(`relay-handshake.mjs`)가 보장한다**, 자식(CLI)이 아니다 — 자식의
계약이 미래에 깨지더라도(다른 도구가 실수로 stdout에 경고를 흘리는 등)
부모 쪽 한 겹이 그 사실 자체를 흡수한다.

- `toOneLine(text)`: 모든 개행(`\r\n`/`\r`/`\n`)을 공백으로 접고,
  `SHADOW_LOG_MAX_LEN = 300`자를 넘으면 잘라내고 말줄임(`…(truncated)`)을
  붙인다(자른 사실 자체를 숨기지 않는다).
- `normalizeChildStdout(out, taskId)`: 자식 stdout의 첫 줄이
  `retire-author-shadow: `로 시작하면 그 줄을 `toOneLine`으로 한 번 더
  정규화해 그대로 쓰고, 아니면(빈 문자열 포함) 부모가 `MALFORMED_OUTPUT`
  한 줄을 직접 만든다 — **줄이 0개인 경우를 구조적으로 없앤다**
  (relay-handshake-retire-author-shadow-wire.test.mjs (I)가 "exit 0 +
  빈 stdout" 정확히 그 실사고 모양을 재현해 증명한다).
- catch 분기(`OBSERVATION_ERROR`/`TIMEOUT`)도 `shadowLine(state, reason,
taskId)`를 통해 같은 `toOneLine`을 거친다 — stderr 폭주(50줄 합성
  픽스처, (F-2))도 물리적으로 정확히 한 줄, 길이 상한 안으로 접힌다.

**"정확히 한 줄"은 `console.log` 호출 횟수가 아니라 물리적 개행 개수로
잰다** — 시험은 `countPhysicalLines(str) = str.split(/\r\n|\r|\n/).length`로
직접 센다(P1-2가 실측한 결함은 "호출은 1번인데 그 안에 개행이 여러 개"인
모양이었으므로, 호출 횟수만 세면 이 결함을 놓친다).

### 6-3. 회귀 0 확인

1R의 통과분(정적 import 0 · 라이브 무접촉 · 픽스처 시각 대역 밖 ·
20개 시험 · 되돌림 변이 4건)을 이 라운드 시작 전/끝 모두 실행해 재확인했다
— 4건 전부 여전히 실제로 RED → 바이트 동일 복원(md5 대조)됨을 이 라운드가
직접 재현했다. 20개 시험도 코드 변경 후 전부 그대로 통과한다.

### 6-4. 되돌림 변이 (이 라운드 신설 2건, 총 6건)

- ⓔ(2R) `execFileFn` 호출 옵션에서 `timeout`/`killSignal`을 지운다 →
  (E) RED(진짜 3000ms 지연 자식을 끝까지 기다려 elapsed 단언이 깨지고,
  `state`도 `TIMEOUT`이 아니게 된다).
- ⓕ(2R) `normalizeChildStdout`/catch의 `shadowLine` 정규화를 지우고 1R의
  raw 삽입으로 되돌린다 → (F-2)/(G)/(I) 전부 RED(stderr 50줄이 원문 그대로
  삽입돼 물리 줄 수가 1을 넘거나, 빈 stdout이 그대로 빈 문자열로 남아
  `retire-author-shadow:` 접두어 자체가 사라진다).

전부 실제로 적용 → RED 확인(md5로 사전 스냅숏) → 원본으로 복원 →
md5 재대조로 바이트 동일 확인.

## 7. HYK-419-wire-3 (3R 수리) — CI가 잡은 격리 회귀 1건

### 7-1. CI가 잡은 것

2R 커밋(`a6f94c6b`)이 연 PR #248의 CI(`enforce.yml` step 6 "check test
suites")가 빨강이었다: `tests 5830 / pass 5817 / fail 1 / skipped 12`.
작성자·검토·ORCH 3자 로컬은 전부 초록(`5830/5824/fail 0`)이었다 — 즉 CI
전용으로 나타난 실패다. 실패한 것은 `HYK-359 완료조건4`(떠도는
`ADMISSION_LEDGER_PATH`/`ADMISSION_LOCK_PATH`/`DISPATCH_RECEIPT_PATH`
env 아래 CI-canonical 시험 디렉터리 전체를 스윕하는 시험)가 감싼 스윕
안에서 `watch-freshness-core.test.mjs:241`(그 파일 자신의 `after()` 훅 —
`git status --porcelain`이 그 파일의 시험 시작 시점과 끝 시점에 동일한지
확인) 1건이었다.

### 7-2. 재현 시도 (§3⑴)

CI와 같은 조건(`hyk359-ambient-env-regression.test.mjs`의 "HYK-359
완료조건4" 시험 자신, 떠도는 env 3개 + 격리 사본 전체 스윕)을 이
워크트리(Windows)에서 **3회** 그대로 돌렸다:

| 회차 | 결과 | 소요                  |
| ---- | ---- | --------------------- |
| 1    | PASS | 560,771ms (≈9.3분)    |
| 2    | PASS | 1,440,591ms (≈24.0분) |
| 3    | PASS | 529,710ms (≈8.8분)    |

**3회 전부 재현되지 않았다.** 소요 시간이 회차마다 크게 흔들렸다(8.8분 ~
24.0분) — 이 자체가 이 스윕이 시스템 부하/타이밍에 민감함을 시사한다
(§2가 요구한 "무관하다로 닫지 마라"의 근거이기도 하다 — 흔들리는 스윕은
"단독 실행 통과"가 무관함의 증거가 못 된다는 뜻 그대로다).

★ORCH가 준 독립 관측(다른 이슈·다른 워크트리 HYK-422, 그림자 스폰 코드
없음, master `601a4c1` 기준): 같은 커밋을 전체 러너로 두 번 돌려 "1회차
fail 2 → 2회차 fail 0"으로 갈렸고, 1회차에 깨진 두 파일 중 하나가 이
`hyk359-ambient-env-regression` 스윕 자신이었다. **이 관측이 말해주는
것**: 이 스윕은 이 라운드의 코드가 없어도 흔들린 전례가 있다.
**말해주지 않는 것**: 이번 CI 실패(내부에서 깨진 파일이
`watch-freshness-core.test.mjs:241`)가 이 라운드와 무관하다는 것 — 그
관측은 다른 파일이 깨졌고 표본도 각각 1회뿐이다. 그래서 §7-3의 인과
실험을 그대로(생략하지 않고) 수행했다.

### 7-3. 인과 실험 (§3⑵) — 급소

★**질문**: 그림자 스폰(진짜 자식 프로세스를 실제로 spawn하는 것)을 끄면
같은 스윕이 (더) 초록이 되는가?

**1차 시도(실패, 방법 교정)**: `runCompletionSideEffects`의
`runRetireAuthorShadowObservation(...)` 호출 한 줄을 통째로 지우고
스윕을 돌렸더니 — 원래 목표였던 `watch-freshness-core.test.mjs:241`이
아니라 **이 라운드 자신의 시험** 2건
(`relay-handshake-retire-author-shadow-wire.test.mjs`의 (A)/(B-2), "항상
정확히 한 줄이 찍힌다"를 확인하는 시험)이 깨졌다 — 호출 자체를 지우면
그 줄이 아예 안 찍히니 당연한 결과이지만, 이건 원래 질문("스폰이 다른
시험을 흔드는가")에 대한 신호를 자기 오염으로 흐린다. **방법을
고쳤다**: `execFileFn`의 **기본값**(프로덕션 호출이 쓰는 값)만
`causalExperimentStubExecFileFn`(진짜 자식을 스폰하지 않고 고정된 한
줄만 즉시 돌려주는 스텁)으로 바꿨다 — `execFileFn`을 스스로 주입하는
이 라운드 자신의 시험(C/D/E/F/G/H/I)은 그 주입값을 그대로 쓰므로 영향을
받지 않는다(재확인: 이 스텁 상태에서 wire 시험 11건 전부 그대로
통과). 이렇게 "진짜 서브프로세스 스폰"만 변수에서 뺐다.

이 스텁 상태로 같은 스윕을 **3회** 돌렸다:

| 조건                      | 회차 | 결과 | 소요        |
| ------------------------- | ---- | ---- | ----------- |
| 스폰 ON(§7-2와 동일 코드) | 1    | PASS | 560,771ms   |
| 스폰 ON                   | 2    | PASS | 1,440,591ms |
| 스폰 ON                   | 3    | PASS | 529,710ms   |
| 스폰 OFF(스텁)            | 1    | PASS | 506,273ms   |
| 스폰 OFF(스텁)            | 2    | PASS | 500,955ms   |
| 스폰 OFF(스텁)            | 3    | PASS | 496,509ms   |

**판정: 인과 «판정 불가».** 스폰 ON 3/3, 스폰 OFF 3/3 — 양쪽 다 6회
전부 PASS였다. 이 라운드가 재현하려던 실패(`watch-freshness-core.test.mjs:241`)가
어느 조건에서도 로컬에서 단 한 번도 재현되지 않았으므로, "스폰을 끄면
낫는다"를 검증할 «깨진 기준선» 자체가 없다 — "있음"도 "없음"도 표본이
뒷받침하지 못한다. 실험 종료 후 `scripts/check/relay-handshake.mjs`는
md5 대조로 바이트 동일 복원했다(스텁은 커밋에 없다).

### 7-4. 수리하지 않음 (§3⑷)

coder-task.md §3⑷ 원문("인과가 «없음»이면 → 고치지 말고 근거를 남겨라")과
같은 논리를 「판정 불가」에도 적용했다 — 인과의 증거가 없는데 코드를
바꾸는 것은 **근거 없는 임의 수정**이고, §2의 비타협("«무관하다»로
닫지 마라")을 반대 방향으로 어기는 것(«관련 있다고 지레짐작하고 억지로
고친다»)과 같은 실수다. 그래서 이 라운드는 **프로덕션 코드를 한 글자도
바꾸지 않았다** — §3⑸(되돌림 변이)도 새 수리가 없으므로 대상이 없다
(2R의 6건을 이 라운드 시작·끝에 재확인한 것으로 §4-4 "회귀 0"을
채운다, §6-4/§7-3 재확인 기록 참조).

### 7-5. 그럼 무엇이 원인일까 (내 주장 등급)

- ★[직접 실행 확인] 이 스윕 자체가 코드 변경과 무관하게 소요 시간이
  8.8분~24.0분으로 흔들린다(6회 실측). 스윕은 CI-canonical 전체(수천 개
  시험)를 격리 클론에서 다시 실행하므로, 시스템 자원 경합(디스크
  I/O·CPU 스케줄링·다른 동시 실행 프로세스)에 취약한 구조로 보인다.
- [내 주장] `watch-freshness-core.test.mjs:241`의 `after()` 훅(모듈
  로드 시점의 `git status --porcelain`과 시험 종료 시점의 그것을
  비교)은 **그 파일 자신의 격리가 아니라 «같은 프로세스에서 동시에
  실행되는 다른 시험이 그 사이 실제 저장소를 건드리지 않았는가»에
  의존한다** — 이 스윕처럼 수천 개 시험이 병렬로 도는 환경에서는
  타이밍에 따라 그 창이 갈릴 수 있다는 것이 구조적으로 보인다. 다만
  이것을 직접 재현/검증하지는 못했다([내 주장] 등급에 그친다).
- [내 주장] ORCH가 준 독립 관측(그림자 스폰 코드 없는 워크트리에서도
  같은 스윕이 흔들린 전례)과 이 라운드의 6/6 무재현이 함께 가리키는
  방향은 "이 스윕 자체가 시스템 부하에 민감한 flaky 시험"이라는 가설
  쪽이다 — 그러나 이는 가설이지 이 라운드가 증명한 사실이 아니다.

### 7-6. 남는 한계

- 이 라운드는 원래 CI 실패를 로컬에서 재현하지 못했다 — CI(Linux, 특정
  동시성/자원 조건)와 이 워크트리(Windows)의 실행 환경 차이가 재현
  실패의 원인일 수 있으나, 이 라운드는 그 가설도 검증하지 않았다.
- "스폰 ON/OFF 3vs3, 전부 PASS"라는 결과는 **인과가 없다는 증거가
  아니라 «표본으로는 못 가른다»는 증거**다 — 표본을 늘리거나(예: CI와
  동일한 동시성/자원 조건을 흉내) 더 정밀한 계측(프로세스 수·파일
  핸들·타이밍)을 곁들이면 다른 결론이 나올 수 있다.
- 다음에 같은 CI 실패가 다시 나면(재발), 이번 §7-3의 스텁 기법(정확히
  같은 방법)을 그대로 재사용해 표본을 더 쌓는 것이 이 라운드가 남기는
  가장 실용적인 다음 수.
