# HYK-419 — "은퇴 기록을 누가 쓰는가": 작성 권한 경계 + 자동화 코어 설계 (3R 수리)

이 문서는 docs/HYK-412-stuck-retire-design.md §3("B — 이미 갇힌 라운드의 사람 서명
경로")이 이미 남긴 저자 경계 분석을 **전제로 삼아** 그 위에 "자동 작성 코어"를
설계한다. 412 문서가 확정한 사실은 다시 쓰지 않고 링크만 남긴다 — 이 문서는 그
위에 새로 얹는 부분만 다룬다.

## 2R 수리 요약 (검토 P1-1 반영)

1R은 기계 앵커(경로/지문/기록시각) 검사를 "문자열이 비어 있지 않은가"로만
했다. 검토가 정상 OPEN facts에 `ownTaskArchivePath: "rounds/DOES-NOT-
EXIST.md"` / `ownTaskArchiveFingerprint: "FORGED-FINGERPRINT"` /
`recordedAt: "not-a-time"` / `successorLabelForRecord:
"../../not-a-real-successor"`를 주입해 `AUTHORIZED_DRAFT`를 뽑아냈다(P1-1,
1b_shown 위반). 그 라운드는 §1-2②를 "실물 검증"으로 다시 쓰고(§4·§5),
§7에 "이제 무엇을 확인하고 무엇을 여전히 못 하는지"를 정정했다.

## 3R 수리 요약 (검토 P1-1 재반려 반영 — "★검토가 옳다, 범위 제외 규칙도 정확히 지켰다 — 모범")

2R의 경로 검증(`resolveSafeArchivePath`)은 **어휘적(lexical)** 검사였다 —
문자열을 `resolve()`하고 그 결과가 `harnessDir` 문자열로 시작하는지만
봤다. 검토가 `harnessDir` **밖**에 실파일을 두고 `harnessDir/rounds/
linked.md`를 그 파일을 가리키는 **심볼릭 링크**로 만든 뒤, 링크 «대상»의
진짜 SHA-256과 과거 KST 시각을 넣어 **기본(진짜 fs/crypto) 경로**로
호출했더니 `AUTHORIZED_DRAFT`가 나왔다 — 어휘적으로는 `rounds/linked.md`
가 `harnessDir` 하위이므로 통과했지만, 그 링크가 실제로 가리키는 물리
경로는 `harnessDir` 밖이었다. 이 라운드는 `fs.realpathSync`로 링크·정션을
실제로 해석한 뒤 다시 포함 관계를 확인하는 관문을 추가한다(§4·§5·§6),
§7을 "3R이 새로 닫은 것"으로 다시 정정한다.

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
2. **이 코어가 추가하는 기계 앵커 필드(§B)도 전부 기계 사실이고, ★2R부터는
   그 값이 «실물»과 일치하는지까지 이 코어가 직접 재확인한다** —
   `harnessDir`+`ownTaskArchivePath`(경로 탈출 없이 harnessDir 하위에
   실제로 존재하는 파일이어야 함), `ownTaskArchiveFingerprint`(SHA-256 hex
   형식이어야 하고, 그 파일을 이 코어가 직접 다시 읽어 재해싱한 값과
   일치해야 함), `recordedAt`(`YYYY-MM-DD HH:MM:SS KST` 형식으로 파싱되고
   미래가 아니어야 함). 이걸 위해 이 라운드는 S8 zero-import 원칙을
   **의도적으로 넓혔다** — `node:fs`/`node:crypto`/`node:path`를 직접
   import한다(1R은 "hyk412 게이트 재사용" 한 곳만 예외였다). 판정 축
   자체(hyk412 게이트)는 그대로 위임한다 — 넓어진 것은 "기계 앵커가
   실물과 일치하는가"를 확인하는 새 검증 계층이지 OPEN/CLOSED 판정
   로직이 아니다.
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

- `evaluateAutoAuthorAuthorization(facts, deps)` — hyk412 게이트를 그대로
  호출해 `OPEN`이 아니면 `GATE_CLOSED`(게이트의 실제 state를 그대로 실어
  나름). `OPEN`이면 순서대로: ①앵커 필드 존재(`MACHINE_ANCHOR_INCOMPLETE`)
  ②경로 탈출 없음(어휘적, `ARCHIVE_PATH_TRAVERSAL`) ③실제 존재
  (`ARCHIVE_PATH_NOT_FOUND`) ④★3R **realpath 재확인**(링크·정션을 실제로
  해석한 물리 경로가 harnessDir 밖이면 `ARCHIVE_PATH_TRAVERSAL`, realpath
  자체를 확인할 수 없으면 `ARCHIVE_PATH_UNRESOLVABLE`) ⑤지문 형식+재해싱
  일치(`FINGERPRINT_INVALID`, 읽기 자체 실패는 `ARCHIVE_UNREADABLE`)
  ⑥기록시각 형식+미래아님(`RECORDED_AT_INVALID`) ⑦후속 이름표 문법
  (`SUCCESSOR_LABEL_GRAMMAR_INVALID`) 일곱 관문을 전부 통과해야
  `AUTHORIZED_DRAFT`로 `draftRecord`를 조립한다. `deps`는 파일 읽기/
  존재확인/realpath해석/해싱/시계 seam(`existsFn`/`realpathFn`/
  `readFileFn`/`hashFn`/`nowFn`) — 시험은 주입하고, 실 호출자는 전부
  기본값(진짜 `fs.existsSync`/`fs.realpathSync`/`fs.readFileSync`/
  `crypto`/`Date`)을 쓴다.
- `resolveVerifiedArchivePath`(경로 탈출→실제 존재→realpath 재확인 세
  관문을 한데 묶은 내부 함수)를 `checkArchiveExists`와 `checkFingerprint`
  둘 다 호출한다 — fs에 닿는 «단일 선택 지점»이라, 이 함수 하나만
  realpath를 정확히 처리하면 두 소비자 모두가 자동으로 안전해진다
  (중복 정의 없음, 2R부터 이어온 defense-in-depth 원칙 유지).
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
2. **harnessDir/ownTaskArchivePath/ownTaskArchiveFingerprint/recordedAt
   «타입» 위조** — 빈 문자열, `undefined`, `null`, 객체(`{}`), 숫자 등
   12조합(4필드 × 3변종)이 전부 `MACHINE_ANCHOR_INCOMPLETE`로 닫힌다
   (시험으로 고정).
3. **★2R — ownTaskArchivePath 경로 탈출(어휘적)** — `..` 세그먼트·절대경로
   (`/etc/passwd`)·윈도우 드라이브 표기(`C:\Windows\...`) 전부
   `ARCHIVE_PATH_TRAVERSAL`로 닫힌다. 문자열 휴리스틱(`looksLikeTraversal`)
   과 `resolve()` 결과의 포함관계 재확인(`resolveSafeArchivePath`) 두 겹
   방어다. ⚠️★3R 정정: 이 두 겹을 함께 지우는 되돌림 변이 4/9는 이제
   "harnessDir 밖 실재 파일이 AUTHORIZED_DRAFT까지 새어 나간다"를 더
   이상 증명하지 못한다 — 아래 항목 4의 realpath 관문이 «독립적으로»
   그 경우를 여전히 막기 때문이다(2R 때는 이 관문이 없어서 새어 나갔다).
   지금 이 두 겹이 실제로 인과 기여하는 부분은 "harnessDir 밖을 가리키는
   «존재하지 않는» 경로"를 파일시스템에 닿기 전에 즉시 `ARCHIVE_PATH_
TRAVERSAL`로 진단하는 것이다 — 지우면 그 사유 코드가 `ARCHIVE_PATH_
NOT_FOUND`로 바뀐다(되돌림 변이 4/9가 그 구체적 사유 코드 변화를
   고정한다).
4. **★3R 신설 — ownTaskArchivePath의 realpath(링크·정션) 우회** — 검토
   원문 그대로: `harnessDir` 밖에 실파일을 두고 `harnessDir/rounds/
linked.md`를 그 파일을 가리키는 심볼릭 링크로 만든 뒤, 링크 대상의
   진짜 SHA-256 + 과거 KST 시각을 기본(진짜 fs/crypto) 경로로 호출해도
   `ARCHIVE_PATH_TRAVERSAL`로 닫힌다(시험 "★검토 심볼릭 표본 재현").
   `fs.realpathSync`가 harnessDir과 대상 파일 양쪽을 실제로 해석해
   포함 관계를 다시 확인한다(harnessDir 자신도 realpath로 정규화 —
   한쪽만 풀면 harnessDir 자체가 심볼릭 트리 밑에 있을 때 오탐/누락이
   생긴다). realpath 자체가 실패하면(ENOENT 제외 — 그건 "부재"로
   재분류) `ARCHIVE_PATH_UNRESOLVABLE`로 fail-closed(조용한 통과 금지,
   시험 "ARCHIVE_PATH_UNRESOLVABLE" 표본으로 고정).
5. **★2R — ownTaskArchivePath 실존 여부** — 검토 원문 `"rounds/DOES-NOT-
EXIST.md"`가 `ARCHIVE_PATH_NOT_FOUND`로 닫힌다(시험 "★검토 원문 재현 ⓐ").
6. **★2R — ownTaskArchiveFingerprint 형식+실값** — 검토 원문
   `"FORGED-FINGERPRINT"`(형식 자체가 SHA-256 hex 아님)와, 형식은 맞지만
   실제 파일과 다른 64자 hex 둘 다 `FINGERPRINT_INVALID`로 닫힌다 —
   전자는 파일을 읽지도 않고 즉시 거부, 후자는 실제로 다시 해싱해서
   비교한 뒤 거부(문자열 비교가 아니다). 대문자 hex(형식 다름)도 별도
   표본으로 닫힘을 고정했다.
7. **★2R — recordedAt 형식+달력+미래** — 검토 원문 `"not-a-time"`, 존재
   하지 않는 달력 날짜(`2026-02-30`), 미래 시각(`2099-01-01 ...`) 셋 다
   `RECORDED_AT_INVALID`로 닫힌다(Date.UTC 왕복 검증으로 형식 정규식만
   으로는 못 잡는 달력 위반까지 닫는다).
8. **★2R — successorLabelForRecord 라벨 문법** — 검토 원문
   `"../../not-a-real-successor"`와 슬래시가 섞인 다른 변형(`"HYK-1/../2"`)
   둘 다 `SUCCESSOR_LABEL_GRAMMAR_INVALID`로 닫힌다. ⚠️숫자/객체 등
   비문자열 값은 이 관문이 아니라 **hyk412 게이트 자신**이 먼저
   `SUCCESSOR_LABEL_MISSING`으로 닫는다(게이트가 `isNonEmptyString`으로
   먼저 걸러내므로 이 코어까지 도달하지 못한다 — 이중 방어가 아니라
   더 앞선 관문이 이미 있다는 뜻, 시험으로 그 경로까지 확인했다).
9. **blockReasonCode 주입** — facts에 유효해 보이는 값을 넣어도 draftRecord에
   반영되지 않는다(시험으로 고정) — 이 표면은 "코드가 그 필드를 아예 읽지
   않는다"는 구조로 닫혀 있다, 검사 분기가 아니라 부재 자체가 방어선이다.
10. **★3R 신설 — 다른 경로 형태 훑기(coder-task.md §2⑷)** — 상대경로
    조합(`./rounds/../rounds/x.md`), `.`/`..` 혼합(`../a/./b/escape.md`),
    UNC 형태(`\\server\share\escape.md`), 매우 긴 경로(4000자) 전부
    `ARCHIVE_PATH_NOT_FOUND` 또는 `ARCHIVE_PATH_TRAVERSAL` 둘 중 하나로
    닫히고 `AUTHORIZED_DRAFT`로는 절대 안 샌다(시험 "★구조적 닫힘 훑기").
11. **위 항목들 외의 어떤 필드 조작도** `evaluateAutoAuthorAuthorization`의
    순차적 관문 일곱 개(§4 참조)에 없는 경로로 `AUTHORIZED_DRAFT`에 도달할
    수 없다 — 마지막 return 앞은 전부 조기 반환이라는 단순 구조 자체가
    증거다.

## 6. 되돌림 변이 (완료 조건 4)

`retirement-auto-author-core.test.mjs`에 정확히 **9건**(2R의 8건 + 3R이
신설한 realpath 재확인 관문 되돌림 변이 1건 = 9), 문서(이 절)의 숫자와
일치한다. 각각 원본 소스 파일을 메모리에서 읽어 대상 문자열이 정확히
1회 등장함을 확인한 뒤 그 부분을 제거/변형한 사본을 임시 디렉터리에
써서 동적 임포트한다 — 실제 저장소 파일은 한 번도 쓰기 대상이 아니므로
시험 전후 바이트 동일이 구조적으로 보장된다(원복 증명은 그래도 시험
안에서 재확인한다, relay-handshake-retirement-mutation.test.mjs 선례와
동일 규율).

1. 게이트-닫힘 조기 반환 제거 → CLOSED facts가 AUTHORIZED_DRAFT로 잘못 열림.
2. 앵커-미완성(존재 확인) 조기 반환 제거 → 문자열이 아닌 harnessDir이
   구조화된 거부 대신 `TypeError`로 새어 나간다.
3. `blockReasonCode: null` 하드코딩을 `facts.blockReasonCode ?? null`로
   바꿈 → 위조된 사유 코드가 draftRecord로 새어 나감.
4. `resolveSafeArchivePath`의 경로 탈출 방어 두 겹(문자열 휴리스틱 +
   resolve 포함관계 재확인)을 통째로 제거 → ⚠️★3R 정정: 더 이상
   AUTHORIZED_DRAFT로 열리지 않는다 — 항목 5의 realpath 관문이
   독립적으로 harnessDir 밖 실재 파일을 여전히 막기 때문이다(2R 때는
   이 관문이 없어서 열렸다, 지금은 이중 방어가 실제로 작동함을 이
   변이가 오히려 증명한다). 대신 «존재하지 않는» 탈출 경로의 사유
   코드가 `ARCHIVE_PATH_TRAVERSAL`에서 `ARCHIVE_PATH_NOT_FOUND`로
   바뀌는 것으로 이 관문의 남은 인과 기여(파일시스템에 닿기 전 즉시
   진단)를 증명한다.
5. `resolveVerifiedArchivePath` 내부의 존재 확인 관문(`existsFn(full) !==
true` 분기) 제거 → 검토 원문 `"rounds/DOES-NOT-EXIST.md"`가 realpath
   재확인 단계로 넘어가지만 그 경로 자체가 존재하지 않으므로
   `fs.realpathSync`가 `ENOENT`로 던지고, `verifyRealpathContainment`는
   그 경우를 "부재"로 재분류해 조용히 통과시킨다 — 결국 지문 확인
   단계까지 넘어가 `readFileFn`이 다시 ENOENT로 실패해 `ARCHIVE_
UNREADABLE`로 거부된다. 여전히 닫히지만 검토가 지목한 그 사유 코드
   (`ARCHIVE_PATH_NOT_FOUND`)로는 더 이상 안 닫힌다는 점을 증명한다.
6. ★3R 신설 — `verifyRealpathContainment` 호출(realpath 재확인 관문)
   제거 → 검토의 심볼릭 표본(harnessDir 밖 실파일 + `rounds/linked.md`
   심볼릭 링크 + 링크 대상의 진짜 SHA-256 + 과거 KST 시각, 기본 진짜
   fs/crypto 경로)이 그대로 `AUTHORIZED_DRAFT`까지 새어 나간다 — 이번
   반려의 정확한 재현이자 이 라운드의 핵심 인과 증명. symlink 생성이
   실행 환경에서 실패하면(권한 등) 조용히 빼지 않고 `t.skip`으로
   건너뛰며 그 사실을 stderr에 남긴다(§ "심볼릭 시험을 어떻게 만들었나"
   참조).
7. 지문 확인 관문(`checkFingerprint` 호출) 제거 → 검토 원문
   `"FORGED-FINGERPRINT"`가 그대로 `AUTHORIZED_DRAFT`까지 새어 나감.
8. 기록시각 확인 관문(`checkRecordedAt` 호출) 제거 → 검토 원문
   `"not-a-time"`이 그대로 `AUTHORIZED_DRAFT`까지 새어 나감.
9. 후속 이름표 문법 확인 관문(`checkSuccessorLabelGrammar` 호출) 제거
   → 검토 원문 `"../../not-a-real-successor"`가 그대로 `AUTHORIZED_DRAFT`
   까지 새어 나감.

### 심볼릭 시험을 어떻게 만들었나 (coder-task.md §2⑵ 명시적 요구)

`fs.symlinkSync(target, link, "file")`을 이 좌석(Windows, Administrator
권한)에서 직접 스파이크로 실행해 성공을 먼저 확인했다(`realpathSync`가
링크를 실제로 해석해 대상 파일 경로를 돌려주는 것까지 확인). 그 뒤
"★검토 심볼릭 표본 재현"과 되돌림 변이 6/9 두 시험 모두 `symlinkSync`
호출이 실패하면(`EPERM` 등 권한 문제) `console.error`로 사실을 stderr에
남기고 `t.skip(...)`으로 건너뛴다 — 조용히 빠지지 않는다. 대체 수단(Windows
디렉터리 정션)은 검토하되 채택하지 않았다 — 정션은 **디렉터리 단위**만
지원해 검토 원문의 "파일을 가리키는 심볼릭 링크"를 그대로 재현할 수
없고, 굳이 디렉터리 정션으로 우회 표본을 만들면 "검토의 표본을 그대로
박아라"(coder-task.md §2⑵)라는 요구에서 멀어진다고 판단했다. 이 실행
환경에서는 실제로 symlink 생성이 성공했으므로(위 스파이크 확인) 이번
라운드의 시험은 skip 경로를 타지 않았다 — 그러나 재실행 환경이 바뀌면
skip될 수 있다는 것을 정직하게 남긴다.

## 7. ⚠️ 정직 한계 (완료 조건 6) — ★3R 정정

2R은 이 절에서 "경로가 harnessDir 하위에 존재하는지 `existsFn`으로 직접
확인한다"까지만 적고 멈췄다. **검토(P1-1 재반려)가 옳게 지적했듯, 그
문장도 정직했지만 문을 닫지 않았다** — `existsFn`(`fs.existsSync`)은
심볼릭 링크를 «따라가» 존재 여부를 판정하므로, harnessDir 하위의 링크가
harnessDir 밖의 실재 파일을 가리켜도 "존재한다"고 답한다. 이 라운드는
그 문장을 다시 아래처럼 고친다(⛔과장 없이, 실제로 남는 한계는 그대로
남겨 둔다).

### 지금 확인하는 것 (2R + ★3R이 닫은 것 누적)

- **경로(어휘적)**: `ownTaskArchivePath`가 `harnessDir` 밖을 가리키면
  (`..`·절대경로·드라이브 표기) `ARCHIVE_PATH_TRAVERSAL`로 거부한다.
- **경로(실존)**: 그 경로가 가리키는 파일이 실제로 `harnessDir` 하위에
  **존재하는지** `existsFn`(기본값 `fs.existsSync`)으로 확인한다.
- **★3R — 경로(realpath)**: `existsFn`이 심볼릭 링크를 따라가 "존재한다"
  고 답하는 것과 별개로, `realpathFn`(기본값 `fs.realpathSync`)으로
  harnessDir과 그 경로 **양쪽 다** 링크·정션을 실제로 해석한 뒤 물리
  경로끼리 다시 포함 관계를 확인한다 — `harnessDir/rounds/linked.md`가
  harnessDir 밖의 파일을 가리키는 심볼릭 링크라면, 어휘적으로는 통과해도
  이 관문에서 `ARCHIVE_PATH_TRAVERSAL`로 거부된다(검토의 정확한 침해
  시나리오).
- **지문**: `ownTaskArchiveFingerprint`가 SHA-256 hex 형식인지 정규식으로
  거르고, 그 파일을 `readFileFn`(기본값 `fs.readFileSync`)으로 실제로 다시
  읽어 `hashFn`(기본값 `crypto.createHash("sha256")`)으로 재계산한 값과
  **바이트 단위로 비교**한다 — 문자열이 그럴듯해 보이는 것만으로는
  통과하지 못한다.
- **기록시각**: `recordedAt`이 `YYYY-MM-DD HH:MM:SS KST` 형식으로 파싱
  되고(달력상 실재하는 날짜인지 `Date.UTC` 왕복 검증까지), `nowFn`
  (기본값 진짜 시계)이 가리키는 지금 시각보다 미래가 아닌지 확인한다.
- **후속 이름표**: `successorLabelForRecord`가 라벨 문법
  (`HYK-<숫자>[-슬러그...]`)에 맞는지 확인한다 — 경로 조각·임의 문자열은
  이 문법 밖이라 구조적으로 닫힌다.

### 그래도 여전히 남는 사람 손

- `blockReasonCode`는 영원히 사람이 채운다(§3) — 이 코어는 그 결정을
  절대 대신하지 않는다(그렇게 설계했다, §1-2③). 경로 실물 검증(2R·3R)은
  이 판단에 아무것도 더하지 않는다 — 애초에 이 코어가 그 필드를 읽지도
  않기 때문이다.
- `successorLabel`이 문법에 맞더라도 **"진짜 다음 라운드로 이어지는
  올바른 라벨"인지**는 이 코어도, hyk412 게이트도, retirement-record-core
  도 검증하지 않는다 — 문법만 본다(412 설계 문서의 기존 한계를 그대로
  물려받는다).

### ★3R이 새로 여는 정직 한계 — «그래도 여전히 못 막는 위조»

- **워크트리 자체를 완전히 조작하는 공격은 못 막는다**(2R부터 물려받는
  한계, 3R도 닫지 못했다) — 워크트리 쓰기 권한을 가진 주체가 `harnessDir`
  하위에 «가짜 아카이브 파일을 진짜로» 만들어 두면(예: `rounds/coder-
task-r1.md`에 조작된 내용을 실제로 써 넣고 그 파일의 진짜 지문을
  계산해 넘김), 이 코어는 "파일이 실제로 존재하고 지문이 실제로
  일치한다"까지만 확인할 뿐 **그 파일 내용 자체가 정말로 이 라운드의
  진짜 산출물인지**는 검증하지 않는다 — hyk412 게이트가 이미 §5 항목
  2에서 밝힌 "rounds/ 디렉터리 위조" caveat과 정확히 같은 근본 한계다.
  ★3R이 realpath까지 확인하게 되면서 이 한계의 «형태»가 하나 더
  구체화된다: 워크트리 쓰기 권한을 가진 주체가 harnessDir **자신을**
  다른 곳을 가리키는 심볼릭 링크로 바꿔치기할 수 있다면(예: harnessDir
  경로 자체가 symlink), `verifyRealpathContainment`가 `harnessDir`도
  realpath로 정규화하므로 그 경우 "정규화된 harnessDir 하위"라는 새
  기준점 자체가 이미 공격자가 바꾼 값이 된다 — 이건 "caller가 넘긴
  harnessDir이 진짜 이 라운드의 워크트리"라는, 코어가 검증할 수 없는
  전제 자체의 문제이지 이 라운드가 새로 만든 구멍이 아니다(§ decoy
  파일 시험 절 참조, 2R부터 이어지는 caller 신뢰 경계 한계).
- **realpath 해석 자체를 속이는 더 정교한 공격은 다루지 않았다** — 예를
  들어 OS 수준 마운트 네임스페이스 조작이나 파일시스템 드라이버 자체의
  경로 위장(이 코어가 실행되는 Node.js 프로세스보다 더 낮은 계층의
  공격)은 `fs.realpathSync`가 이미 속아 넘어간 값을 돌려줄 수 있다 —
  이건 이 코어의 몫이 아니라 OS/파일시스템 신뢰 경계의 몫이다, 명시적
  범위 밖으로 남긴다.
- **이 코어의 소스 파일 자체를 몰래 패치하는 공격**은 못 막는다(예: §6의
  9개 되돌림 변이 중 하나가 실제로 소스에 반영되는 것) — "부재 자체가
  방어선"이라는 §1-2③의 구조적 방어는 소스 코드 무결성이 전제다, 코드
  서명이나 배포 검증 같은 별도 계층이 필요하고 이 라운드 범위 밖이다.
- `RETIREMENT_BLOCK_REASON`이 커버하지 않는 사유로 실제 방치가 일어난
  경우(§3-2가 이미 지적한, "사유가 사실인가"를 기계로 재현할 수 없는
  근본적 한계) — 이 라운드가 새로 만든 구멍이 아니라 retirement-record-
  core.mjs §3-4/§5-b가 이미 문서화한 한계를 그대로 물려받는다.
- **caller가 넘긴 `harnessDir` 자체가 신뢰 경계 밖이다**: 이 코어의 안전은
  "caller가 넘긴 `harnessDir`이 실제로 이 라운드의 워크트리 harnessDir
  이다"라는 전제 위에 서 있다. 그 전제 자체가 거짓이면(예: 호출자가
  다른 워크트리의 harnessDir을 실수로/의도적으로 넘기면) 이 코어는 그
  다른 harnessDir 안에서는 여전히 "정상"으로 판정한다 — realpath
  재확인(3R)은 "caller가 준 harnessDir 경계 «안»의 링크 우회"를 닫았을
  뿐, "caller가 애초에 «어느» harnessDir을 줬는가" 자체는 검증 대상이
  아니다. §6-4의 되돌림 변이(3R 기준으로는 더 이상 문을 열지 못하는
  쪽으로 바뀌었다, §6 참조)가 처음 이 한계를 드러냈고, 3R 이후에도
  이 caller 신뢰 경계는 좁히지 못한 채 남아 있다.
