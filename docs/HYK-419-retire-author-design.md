# HYK-419 — "은퇴 기록을 누가 쓰는가": 작성 권한 경계 + 자동화 코어 설계 (1R)

이 문서는 docs/HYK-412-stuck-retire-design.md §3("B — 이미 갇힌 라운드의 사람 서명
경로")이 이미 남긴 저자 경계 분석을 **전제로 삼아** 그 위에 "자동 작성 코어"를
설계한다. 412 문서가 확정한 사실은 다시 쓰지 않고 링크만 남긴다 — 이 문서는 그
위에 새로 얹는 부분만 다룬다.

## 0. 이 라운드의 범위 (coder-task.md §0/§2⑹)

**저장소 안 판정·자동화 코어 + 시험 + 이 설계 문서까지.** 다음은 명시적으로
범위 밖이다 (책임자 조건 ② · HYK-415 전례):

- 관제실 라이브 admission-ledger.json/dispatch-receipts.jsonl을 실제로 읽는
  어댑터(코어가 필요로 하는 사실을 실제 파일에서 조립하는 코드).
- `retirement-record-core.mjs`의 `RETIREMENT_BLOCK_REASON` 닫힌 집합에 새
  사유 코드를 추가하는 것과 `checkArchiveFacts`를 넓히는 것(§3-2 인용,
  이미 412 문서가 "별도 코더 라운드, 사람 승인 필요"로 못박았다 — 이 라운드는
  그 판단을 뒤집지 않는다).
- 배달 게이트·`dispatch-gate-decision.mjs`·`relay-handshake.mjs`에 이 라운드가
  만든 코어를 실제로 잇는 것(라이브 결선).

## 1. ★"누가 쓰는가" — 작성 권한 경계 (급소, coder-task.md §2⑴)

### 1-1. 기술적 서명 수단 — 없다

이 저장소에는 "이 기록을 누가 만들었는가"를 암호학적으로 증명할 수단이
**없다**. `retirement-record-writer.mjs`가 쓰는 JSON에는 서명 필드가 없고,
파일시스템 권한(OS ACL)도 워커 프로세스와 사람/ORCH 대리 프로세스를 구별하지
않는다(둘 다 같은 워크트리에 같은 사용자 권한으로 쓴다). docs/HYK-412-stuck-
retire-design.md §3-1이 이미 정직하게 적었다:

> "이 anchor는 기술적 강제가 아니라 절차적 관례다 ... 코드로 물리적으로 막혀
> 있지는 않다."

이 라운드는 그 사실을 뒤집지 않는다 — **뒤집을 수 있는 재료(서명 키, 별도
권한 프로세스)가 이 저장소 안에 없다.**

### 1-2. 그 부재 하에서 무엇이 최선인가 — "입력을 기계 기록으로만 한정"

서명이 없다면 남는 방어선은 하나뿐이다: **자동 작성 경로가 받아들이는 입력의
표면을 좁혀서, 사람 서술(narrative)이 그 표면을 통해 새어 들어갈 수 없게
만드는 것.** 이 라운드가 만든 `retirement-auto-author-core.mjs`는 그 원칙을
아래처럼 구현한다:

1. **판정 자체를 이미 병합된 기계 게이트에 위임한다** — `evaluateAutoAuthorAuthorization`은
   `hyk412-never-consumed-retire-core.mjs`의 `evaluateNeverConsumedRetirement`를
   **재사용**한다(새 판정 축 0, coder-task.md §2⑶). 그 게이트가 받는 사실은
   전부 admission-ledger/dispatch-receipts/`.harness/rounds/` 세 출처에서 온
   구조적 사실이지 사람의 "이 라운드는 죽었다"는 주장이 아니다.
2. **이 코어가 추가하는 세 필드(§B, 기계 앵커)도 전부 기계 사실이다** —
   `ownTaskArchivePath`(관례로 고정된 경로 문자열), `ownTaskArchiveFingerprint`
   (파일 SHA-256, caller가 실제 파일을 해시해 넘김), `recordedAt`(시계 판독).
   이 코어 자신은 그 값을 계산하지 않는다(S8 zero-import 계약 유지) — 그러나
   셋 다 "사람이 지어낸 문장"이 들어올 자리가 구조적으로 없다(문자열 존재
   여부만 검사한다, 내용의 진실성은 §6 정직 한계로 남긴다).
3. **blockReasonCode는 아예 입력받지 않는다** — 이 함수의 시그니처는
   `facts.blockReasonCode`를 **읽지도 않는다**. 호출자가 그 필드에 무엇을
   채워 넣든(`checkMachineAnchorFacts`를 통과할 필요조차 없는, 아예 무시되는
   값) `draftRecord.blockReasonCode`는 항상 하드코딩된 `null`이다
   (retirement-auto-author-core.test.mjs "GREEN: facts에 blockReasonCode를
   위조해 넣어도 ... 항상 null" 시험이 이를 직접 고정한다). ★이게 "정직한
   저자만 쓴다"는 전제에 기대지 않는 이유다 — 위조를 시도하는 저자가 있어도
   그 시도가 닿을 코드 경로 자체가 없다.

### 1-3. "워커 좌석에서 만든 파일이 인정되지 않는" 근거는 무엇인가

세 겹이다(어느 하나도 단독으로는 충분하지 않다는 것을 정직하게 인정한다):

1. **절차적**(412 §3-1 재확인): `retirement-record-writer.mjs`가 배달 게이트에
   결선돼 있지 않다 — 워커 seat에는 이 경로를 호출할 자동 트리거가 없다.
2. **정책적**: coder-task.md §0이 워커의 라이브 원장 쓰기를 명시적으로 금지한다.
3. **구조적(이 라운드가 새로 더한 것)**: 설령 ①·②를 어기고 워커가 손으로
   `writeRetirementRecord`를 호출해 완전한 JSON을 만들어도, **그 JSON의
   `blockReasonCode`가 닫힌 집합 밖(예: 워커가 지어낸 값)이거나, 이 라운드의
   자동화 코어가 만드는 초안을 그대로 베꼈다면 `null`이므로**,
   `retirement-record-core.mjs`의 `checkRetirementRecord`가 `INVALID_REASON_CODE`
   로 거부한다(아래 §4의 통합 시험이 이를 직접 증명한다). 즉 **입력 표면을
   좁혀 두면, 위조 시도가 ①·②를 뚫고 들어와도 ③에서 구조적으로 다시
   막힌다** — 이것이 "서명 없이 할 수 있는 최선"이다.

## 2. 필드별 기계-유도 가능성 표 (coder-task.md §2⑵)

| 필드                                                      | 유도 가능?                             | 출처                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `role`                                                    | ✅ 기계                                | 호출자가 이미 판정 대상으로 확정한 role 문자열(게이트 입력과 동일)                                                        |
| `harnessTaskLabel`                                        | ✅ 기계                                | 게이트 입력과 동일(라벨↔admission 1:1은 게이트가 이미 검증)                                                               |
| `archivePath`(=`ownTaskArchivePath`)                      | ✅ 기계                                | `.harness/rounds/<role>-task-r<N>.md` 관례 경로(게이트가 이미 `ownTaskArchiveExists===true`로 존재를 확인한 바로 그 파일) |
| `archiveFingerprintClaimed`(=`ownTaskArchiveFingerprint`) | ✅ 기계                                | 그 파일의 SHA-256(호출자가 실제로 해시 — 이 라운드는 해시 함수를 호출하지 않는다, S8)                                     |
| `successorLabel`                                          | ✅ 기계                                | 게이트가 이미 `successorLabelForRecord`로 요구하는 값과 동일(존재만 확인, 내용의 "다음 라벨이 맞는가"는 §6 한계)          |
| `recordedAt`                                              | ✅ 기계                                | 시계 판독(호출자가 얻어 옴)                                                                                               |
| `evidence`                                                | ✅ 기계                                | 이 코어가 스스로 채운다(`{source, gateState}`) — 사람 서술 없음                                                           |
| **`blockReasonCode`**                                     | ⛔ **유도 불가 — 사람 손이 남는 자리** | 아래 §3 참조                                                                                                              |

## 3. ★유도 불가 필드 — `blockReasonCode` (숨기지 않는다)

`retirement-record-core.mjs`의 `RETIREMENT_BLOCK_REASON` 닫힌 집합(네 값)은
전부 "DONE 타임스탬프 파싱/재작성 정책" 계열이다 — "이 라운드는 소비 시도조차
된 적 없이 방치됐다"(hyk412 게이트가 실제로 판정하는 상태, `OPEN`)를 뜻하는
값이 그 집합에 **없다**. 이 코어가 그 값을 지어내 채우는 것(예: 새 문자열을
자체적으로 만들어 넣는 것)은 §3-2(닫힌 집합에 새 값 추가)를 코드로 몰래 하는
것과 같은 효과라 금지한다 — 그래서 이 코어는 그 필드를 **비워 둔다**(`null`).

이것이 정확히 coder-task.md §2⑵가 요구한 "유도 불가한 필드 목록"이다:
**`blockReasonCode` 하나뿐**이지만, 이 하나가 §4의 통합 시험에서 보듯 전체
기록을 완성 불가능하게 만드는 병목이다 — 사람 손이 그 자리에 반드시 남는다.

## 4. 자동 작성 코어 (완료 조건 2)

`scripts/check/retirement-auto-author-core.mjs`:

- `evaluateAutoAuthorAuthorization(facts)` — hyk412 게이트를 그대로 호출해
  `OPEN`이 아니면 `GATE_CLOSED`(게이트의 실제 state를 그대로 실어 나름).
  `OPEN`이면 세 기계 앵커 필드의 존재를 확인(`MACHINE_ANCHOR_INCOMPLETE`
  없으면 거부) 후 `AUTHORIZED_DRAFT`로 `draftRecord`를 조립한다.
- `draftRecord`는 `retirement-record-core.mjs`가 기대하는 `record` 모양과
  100% 호환된다(같은 필드 이름) — 단 `blockReasonCode`는 항상 `null`.
- 새 판정 축 0: 이 코어는 OPEN/CLOSED를 스스로 재판정하지 않는다, 오직
  `evaluateNeverConsumedRetirement`의 출력을 그대로 전달한다(retirement-
  auto-author-core.test.mjs의 "이 코어가 게이트를 다시 구현하지 않았다는
  직접 증거" 시험 — 3R이 닫은 타입-위조 UNJUDGABLE 상태가 그대로
  전달되는지까지 확인한다).

### 4-1. 통합 시험 — "강제 함수" 주장의 증거

`retirement-auto-author-core.test.mjs`의 통합 시험 두 개가 §1-3③을 직접
증명한다:

1. `draftRecord`(blockReasonCode: null)를 `checkRetirementRecord`에 넣으면
   → `INVALID_REASON_CODE`로 거부(사람 손이 안 닿으면 구조적으로 미완성).
2. 사람이 `blockReasonCode`를 닫힌 집합의 실제 값(예: `DONE_REWRITE_LOCKED`)
   으로 채우면 → 나머지 필드가 전부 기계 유도값이어도 `RETIRED`까지 통과할
   수 있다(단, "그 사유가 사실인가"는 여전히 사람 책임 — retirement-record-
   core.mjs §3-4/§5-b가 이미 정직하게 남긴 한계, 이 라운드가 새로 만든 한계가
   아니다).

## 5. 위조 표면 열거 + 닫힘 시험 (완료 조건 3, coder-task.md §2⑷)

미열거 기본값은 **닫힘**(구조: 함수가 순차적 AND-체인 + 마지막 줄 외 전부
거부).

1. **hyk412 게이트가 이미 닫는 표면 전부** — docs/HYK-412-stuck-retire-
   design.md §5의 네 항목(ledgerReservation/dispatchReceiptMatchCount 구조적
   격리, rounds/ 디렉터리 위조 caveat, staleEnoughSinceAdmission 호출자 책임,
   타입 위조)을 **그대로 물려받는다** — 이 코어는 그 표면을 다시 열지도,
   다시 닫지도 않는다(위임). `retirement-auto-author-core.test.mjs`의 세
   `CLOSED: hyk412 게이트가 ...` 시험이 위임이 실제로 작동함을 직접 증명한다.
2. **ownTaskArchivePath/ownTaskArchiveFingerprint/recordedAt** — 빈 문자열,
   `undefined`, 숫자(타입 위조) 아홉 조합(3필드 × 3변종)이 전부
   `MACHINE_ANCHOR_INCOMPLETE`로 닫힌다(시험으로 고정).
3. **blockReasonCode 주입** — facts에 유효해 보이는 값을 넣어도 draftRecord에
   반영되지 않는다(시험으로 고정) — 이 표면은 "코드가 그 필드를 아예 읽지
   않는다"는 구조로 닫혀 있다, 검사 분기가 아니라 부재 자체가 방어선이다.
4. **위 셋 외의 어떤 필드 조작도** `evaluateAutoAuthorAuthorization`의
   상태 전이 표(`GATE_CLOSED`/`MACHINE_ANCHOR_INCOMPLETE`/`AUTHORIZED_DRAFT`)
   에 없는 경로로 `AUTHORIZED_DRAFT`에 도달할 수 없다 — 마지막 return 앞에
   조기 반환 두 개뿐인 단순 구조 자체가 증거다.

## 6. 되돌림 변이 (완료 조건 4)

`retirement-auto-author-core.test.mjs`에 정확히 **3건**, 문서(이 절)의 숫자와
일치한다. 각각 원본 소스 파일을 메모리에서 읽어 대상 문자열이 정확히 1회
등장함을 확인한 뒤 그 부분을 제거/변형한 사본을 임시 디렉터리에 써서
동적 임포트한다 — 실제 저장소 파일은 한 번도 쓰기 대상이 아니므로 시험
전후 바이트 동일이 구조적으로 보장된다(원복 증명은 그래도 시험 안에서
재확인한다, relay-handshake-retirement-mutation.test.mjs 선례와 동일 규율).

1. 게이트-닫힘 조기 반환 제거 → CLOSED facts가 AUTHORIZED_DRAFT로 잘못 열림.
2. 앵커-미완성 조기 반환 제거 → 텅 빈 앵커가 AUTHORIZED_DRAFT로 잘못 열림.
3. `blockReasonCode: null` 하드코딩을 `facts.blockReasonCode ?? null`로
   바꿈 → 위조된 사유 코드가 draftRecord로 새어 나감(§5-3이 "왜 구조적
   방어가 필요한가"를 주장하는 근거를 직접 시험으로 보여준다 — 이 변이가
   없으면 §5-3의 "부재 자체가 방어선"이라는 주장은 검증되지 않은 채 남는다).

## 7. ⚠️ 정직 한계 (완료 조건 6)

**이 설계로도 남는 사람 손:**

- `blockReasonCode`는 영원히 사람이 채운다(§3) — 이 코어는 그 결정을
  절대 대신하지 않는다(그렇게 설계했다, §1-2③).
- `ownTaskArchiveFingerprint`/`ownTaskArchivePath`/`recordedAt`이 caller가
  주장하는 값과 실제로 일치하는지는 이 코어가 검증하지 않는다 — S8
  zero-import 계약상 파일을 스스로 읽지 않기 때문이다. 이 거짓을 잡는 것은
  (만약 나중에 결선된다면) `retirement-record-core.mjs`의 `checkArchiveFacts`
  몫이다(아카이브 존재+지문 재대조, 그 코어가 이미 하는 일) — 이 라운드는
  그 결선을 하지 않았으므로 **오늘 이 코어 하나만 놓고 보면 거짓 앵커를
  가려내지 못한다**, 숨기지 않는다.
- `successorLabel`이 "진짜 다음 라운드로 이어지는 올바른 라벨"인지는 이
  코어도, hyk412 게이트도, retirement-record-core도 검증하지 않는다 — 존재
  여부만 본다(412 설계 문서의 기존 한계를 그대로 물려받는다).

**이 축이 못 막는 위조:**

- `.harness/rounds/` 디렉터리 자체의 위조(§5 항목 1이 물려받은 412의 caveat)
  — 워크트리 쓰기 권한을 가진 주체가 "다음 라운드가 없다"고 파일 배치로
  거짓말하면, 게이트도 이 코어도 그 거짓을 원리적으로 탐지 못한다.
- 이 코어의 소스 파일 자체를 몰래 패치하는 공격(예: §6-3 변이가 실제로
  일어나는 것) — 이 라운드가 만든 "부재 자체가 방어선"은 소스 코드 무결성이
  전제다, 코드 서명이나 배포 검증 같은 별도 계층이 필요하고 이 라운드
  범위 밖이다.
- `RETIREMENT_BLOCK_REASON`이 커버하지 않는 사유로 실제 방치가 일어난
  경우(§3-2가 이미 지적한, "사유가 사실인가"를 기계로 재현할 수 없는
  근본적 한계) — 이 라운드가 새로 만든 구멍이 아니라 retirement-record-
  core.mjs §3-4/§5-b가 이미 문서화한 한계를 그대로 물려받는다.
