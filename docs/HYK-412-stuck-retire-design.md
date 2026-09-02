# HYK-412 — 소비된 적 없는 라운드의 정당 종결 경로 설계안 (2R — 구별축 재건)

이 문서는 1R을 대체한다(1R 본문은 git 이력에 남아 있다 — `git log -p -- docs/HYK-412-stuck-retire-design.md`).
1R은 검토에서 **P1 헛시험(vacuous-pass)** 판정을 받았다: "task 보존 사본
(`.harness/rounds/<role>-task-r<N>.md`) 개수 0건"을 "다음 라운드가 드롭된 적 없음"의
증거로 썼는데, 실측 결과 그 파일은 **이 라운드 자신이 배달되는 순간** 게이트가
스냅숏하는 것이지 "다음 라운드가 드롭될 때" 생기는 게 아니었다(아래 §0). 그래서 배달된
모든 라운드는 항상 자기 자신의 task-r<N>.md를 최소 1건 가지며, "0건" 조건은 실제
배달 경로에서 결코 참이 될 수 없었다.

이 라운드(2R)는 그 오류를 **바닥부터 다시 세운다**: 1R 설계를 방어하지 않고, off-by-one을
바로잡은 새 축을 실물 아카이버로 만든 표본에서 시험으로 고정한다.

## 0. 정정: 무엇이 실제로 언제 생기는가 (검토 원문 재확인)

`scripts/check/dispatch-gate-decision.mjs`의 `bestEffortStampDroppedAt` →
`bestEffortSnapshotRoundTaskFile` → `envelope-archive.mjs`의 `archiveRoundTaskFileIfNew`
경로는, **이 CLI가 배달 직전(`dispatch-worker.ps1:171`이 실제 `orca orchestration
dispatch`를 부르기 전) 매번 실행**되면서, **지금 배달하려는 바로 이 라운드**의 최종
task 내용을 `.harness/rounds/<role>-task-r<N>.md`로 스냅숏한다(`envelope-archive.mjs:140-205`).
즉:

- `<role>-task-r<N>.md` = **라운드 N 자신의** task 스냅숏, **라운드 N이 배달되는 순간** 생김.
- `<role>-task-r<N+1>.md` = **라운드 N+1의** task 스냅숏, **라운드 N+1이 배달될 때만** 생김 —
  이건 "라운드 N이 끝난 뒤 누군가 다음 라운드를 실제로 드롭했다"는 사실이 있어야만
  존재하는 파일이다.

1R은 이 둘을 혼동해 라운드 N 자신의 스냅숏 개수를 "다음 라운드가 드롭됐는가"의 대리
지표로 썼다 — 실제로는 **라운드 N+1의** 스냅숏 존재 여부가 그 질문에 대한 답이다.
이 하나의 off-by-one이 1R을 vacuous하게 만들었다. 2R의 새 축은 이 인덱스를 고친 것이다
(§2).

검토가 함께 확정한 사실 3건은 그대로 유효하다(coder-task.md §1):

1. `evidence-3b` 라벨은 task 보존 사본에 있으나 admission-ledger 예약은 없다 — 라벨↔admission
   1:1 전제가 표본에서 이미 깨져 있다(§4에서 fail-closed로 다룬다).
2. 소비 시도 거부의 지속 기록이 코드베이스에 없다(§3-A에서 정면으로 다룬다).
3. 되돌림 변이는 7종인데 1R 문서는 8종이라 적었다 — 2R은 변이 개수와 문서 숫자를 코드로
   강제 일치시킨다(`hyk412-never-consumed-retire-core.test.mjs`의
   `assert.equal(MUTATION_CASES.length, 10, ...)`, §5).

## 1. A(앞으로)와 B(이미 갇힌 것)를 분리한다

이 라운드가 가장 먼저 고친 것은 **두 문제를 하나의 축으로 풀려 한 1R의 구조 자체**다.

- **A — 앞으로 생길 라운드**: "다음 라운드가 한 번도 드롭된 적 없는, 완전히 방치된
  라운드"인지를 **지금 이미 있는 증거만으로** 기계가 판정할 수 있는가? → **그렇다** —
  §2의 새 축은 새 지속 기록을 요구하지 않는다.
- **B — 이미 갇힌 것**(`HYK-271-evidence-3` 등, task 보존 사본이 이미 2건 이상이라
  "재시도가 있었다"는 사실 자체가 기록된 표본): 이런 표본은 §2의 축으로 **영원히** 열리지
  않는다(설계 의도, §2 마지막 관문 `SUCCESSOR_ROUND_EXISTS`). 이 라운드는 이 경우를
  억지로 열 새 기계 축을 만들지 않는다 — 대신 §3에서 **사람 서명 경로**의 모양을 적는다.

## 2. A의 새 구별축 — `evaluateNeverConsumedRetirement`

새 코어: `scripts/check/hyk412-never-consumed-retire-core.mjs`
(`evaluateNeverConsumedRetirement`, zero-import, retirement-record-core.mjs와 동일한 S8
계약). 아래 **AND 전부**를 통과해야 `OPEN`(=은퇴 기록을 "작성할 자격"이 있다는 기계
판정, 은퇴 자체가 아니다):

1. **role/harnessTaskLabel 존재** (`LABEL_MISSING`).
2. **admission-ledger 예약이 실제로 존재**하고, **그 예약이 기록한 라벨이 요청한
   라벨과 정확히 같음** (`LEDGER_RECORD_MISSING` / `LEDGER_RECORD_LABEL_MISMATCH` —
   이게 검토 사실 1을 정면으로 다루는 관문이다, §4).
3. **status === "ACTIVE" && completedAt === null** (`LEDGER_NOT_ACTIVE` — 이미 끝난
   라운드를 "미소비"로 재주장하는 위조 방지).
4. **dispatch-receipts.jsonl 매칭이 정확히 1건** (`DISPATCH_RECEIPT_NOT_EXACTLY_ONE` —
   0건이면 배달된 적 없는 라벨, 2건 이상이면 라벨 재사용/모호).
5. **결과 아카이브(`rounds/<ROLE>-r<N>.md`)가 없음** (`RESULT_ARCHIVE_ALREADY_EXISTS` —
   있으면 애초에 이 축을 적용할 대상이 아니다).
6. **이 라운드 자신의 task 보존 사본(`rounds/<role>-task-r<N>.md`)이 있음**
   (`OWN_TASK_ARCHIVE_MISSING` — §0에 따라 실제로 배달된 라운드라면 구조적으로 항상
   참이어야 한다. 없다면 이 표본 자체가 "실제 배달 모양"이 아니라는 신호이므로
   안전측 거부).
7. **다음 순번 task 보존 사본(`rounds/<role>-task-r<N+1>.md`)이 없음**
   (`SUCCESSOR_ROUND_EXISTS` — ★1R의 오류를 고친 지점. 있으면 재시도 흔적이 실재하는
   것이므로 case B로 넘긴다).
8. **admitted_at으로부터 충분히 오래 지남**(`TOO_RECENT` — 임계값 자체는 이 라운드가
   발명하지 않는다, 어댑터가 관제실 기존 stall-watch 상수를 재사용해야 한다는 1R의
   결론을 그대로 물려받는다. [내 주장, 미확정 — 구체 상수는 검토 대상]).
9. **후속 이름표(successorLabelForRecord) 존재** (`SUCCESSOR_LABEL_MISSING`).

전부 통과하면 `OPEN`. 미열거 상태는 없다 — 함수의 마지막 return 외에는 전부 거부이므로
"판정 불가"가 조용히 "허용"으로 새는 경로가 없다(coder-task.md §2⑷ 요구).

### 2-1. 이 축이 실제 배달 라운드 모양에서 참이 될 수 있다는 증거 (완료 조건 1)

`hyk412-never-consumed-retire-core.test.mjs`의 두 "REAL SHAPE" 시험이 **실제 아카이버**
(`envelope-archive.mjs`의 `archiveRoundTaskFile`, 합성이 아니라 프로덕션이 쓰는 바로 그
함수)로 만든 표본에서 이걸 증명한다:

- 라운드 1만 배달하고 멈추면 → `archiveRoundTaskFile`이 진짜로 `coder-task-r1.md`만
  만들고 `coder-task-r2.md`는 없다 → 새 축은 `OPEN`.
- 그 뒤 라운드 2를 실제로 배달하면(`evidence-3` → `evidence-3b`의 실물 모양 그대로
  재현) → `coder-task-r2.md`가 진짜로 생김 → 같은 라벨(`evidence-3`)에 대한 판정은
  `SUCCESSOR_ROUND_EXISTS`로 뒤집힘.

이 두 상태가 **같은 아카이버 호출**로 실제로 갈린다 — 1R처럼 "이론상 가능"이 아니라
`archiveRoundTaskFile`을 두 번째 호출하기 전/후로 관측 가능한 파일 diff가 실제로 존재한다.

## 3. B — 이미 갇힌 라운드의 사람 서명 경로

`evidence-3` 같은 표본(§2⑦에서 `SUCCESSOR_ROUND_EXISTS`로 닫힌 것)은 §2의 축으로
기계가 못 연다. 이 라운드는 억지 축을 만드는 대신, 이미 존재하는 은퇴 메커니즘의
**저자 모델을 그대로 재사용**하는 경로를 적는다 — coder-task.md §6이 인용한 실물 사례
(HYK-271 마커 라운드, `DONE_PREDATES_DROPPED_AT`)가 이미 이 모델로 풀렸다:

### 3-1. 이미 있는 저자 경계 (실측)

`scripts/check/retirement-record-writer.mjs`는 **배달 게이트에 결선돼 있지 않다**
(파일 자신의 주석: "이 모듈은 배달 게이트에 결선되지 않는다"). `writeRetirementRecord`를
부르는 것은 항상 **사람(또는 그 대리인 ORCH)이 CLI를 손으로 실행하는 행위**다 — 워커는
이 경로를 알지도, 부를 자동 트리거도 없다. 이게 이미 있는 anti-forgery anchor다:
**"이 기록이 존재한다"는 사실 자체가 사람이 관여했다는 절차적 증거**다(암호서명은
아니다 — 아래 §5-(d) 정직 한계).

⚠️ 이 anchor는 **기술적 강제가 아니라 절차적 관례**다: 제어실 파일시스템에 쓰기 권한을
가진 어떤 프로세스든 이론적으로 `writeRetirementRecord`를 호출할 수 있다. 오늘의
실제 방어는 "워커 seat에는 그 경로로 갈 자동화가 없다 + 정책(coder-task.md §0)이
워커의 라이브 원장 쓰기를 명시적으로 금지한다"는 것뿐이다 — 코드로 물리적으로
막혀 있지는 않다(§5-(d)).

### 3-2. B를 위한 새 사유 코드 (닫힌 집합에 추가 제안, 이 라운드는 구현하지 않음)

`retirement-record-core.mjs`의 `RETIREMENT_BLOCK_REASON`에 새 값을 추가하는 안:

```
NEVER_CONSUMED_NO_ARCHIVE: "NEVER_CONSUMED_NO_ARCHIVE"
```

**이 사유는 `MECHANICALLY_CONFIRMABLE_BLOCK_REASONS`에 넣지 않는다** — "정말로 소비
시도가 없었는데도 재시도(evidence-3b)가 있었다"는 사실 자체를 기계가 재현할 방법이
없기 때문이다(coder-task.md §1이 인용한 검토 사실 2, 소비 거부 지속 기록 부재). 이
사유를 쓰는 은퇴 기록은 **아카이브 존재+지문 관문(retirement-record-core.mjs §3-1)을
통과하지 못한다** — 정의상 아카이브가 없는 경우이므로. 즉 이 사유를 실제로 "소비
완료로 인정"하려면 `retirement-record-core.mjs`의 `checkArchiveFacts`에 **이 사유
코드일 때만 archiveExists 요구를 건너뛰는 새 분기**가 필요하다 — 이건 기존 소비 축의
검증 로직을 바꾸는 것이므로 **이 라운드는 구현하지 않는다**(§6 범위 판단).

### 3-3. 사람이 무엇을 판단해야 하는가 (선택지, 결정은 사람 몫)

- **선택지 가**: `NEVER_CONSUMED_NO_ARCHIVE`를 추가하고 `checkArchiveFacts`에 예외
  분기를 만든다 — 얻는 것: B도 결국 기계 검증(사유는 사람이 주장, 나머지 관문은
  여전히 기계)으로 닫힌다. 포기하는 것: 아카이브+지문이라는 기존 retirement 축의
  "가장 강한 보증"(위조하려면 아카이브 파일까지 지문이 맞아야 함)이 이 사유에서는
  구조적으로 없다 — 사람의 주장을 더 신뢰해야 한다.
- **선택지 나**: 새 사유를 추가하지 않고, B는 **retirement 메커니즘 밖에서** 사람이
  직접 admission-ledger를 조작해 반납한다(현재 HYK-398 자동 반납이 우회 없이 거부하는
  상태를 그대로 유지) — 얻는 것: retirement 코어의 계약을 조금도 바꾸지 않는다. 포기
  하는 것: B가 반복될 때마다 사람이 매번 수동 개입해야 한다(HYK-419가 추적 중인 바로
  그 공백).
- 이 라운드는 **가/나 중 하나를 확정하지 않는다** — coder-task.md §2⑴B의 요구대로
  "판단은 사람이 한다"에 따라 여기서 멈춘다.

## 4. 라벨↔admission 1:1 붕괴의 fail-closed 거동

§2의 관문 2(`LEDGER_RECORD_LABEL_MISMATCH`)가 이걸 직접 담당한다: admission-ledger
예약이 **존재는 하되 그 예약이 기록한 라벨이 요청한 라벨과 다르면**(`evidence-3b`처럼
task 파일의 라벨과 원장 예약이 어긋나는 경우), **둘 중 어느 쪽도 정본으로 삼지 않고
거부**한다. `hyk412-never-consumed-retire-core.test.mjs`의 `CLOSED: LEDGER_RECORD_LABEL_MISMATCH`
와 그 mutation 짝이 이걸 시험으로 고정한다.

## 5. 위조 표면 열거 (미열거 기본값 닫힘)

`hyk412-never-consumed-retire-core.mjs` 파일 헤더 §2에 그대로 코드 주석으로도 남겼다.
요약:

1. **ledgerReservation / dispatchReceiptMatchCount** — admission-ledger.json과
   dispatch-receipts.jsonl은 어떤 워크트리의 harnessDir 안에도 없다(제어실 전역 경로).
   워커가 forge할 수 있는 표면이 **아니다**(구조적 격리 — 워커의 워크트리 쓰기 권한이
   이 파일에 닿지 않는다).
2. **hasLaterRoundArchive / ownTaskArchiveExists / resultArchiveExists** — 이 셋은
   `.harness/rounds/`(워크트리 내부)에서 읽는다. 워크트리에 쓰기 권한을 가진 주체는
   이 디렉터리를 조작해 위장할 수 있다 — **1R §2-4가 이미 밝힌 caveat을 그대로
   물려받는다, 이 라운드가 새로 발견한 구멍이 아니다.** 이 코어는 이 위조를 막지
   못한다(정직 한계, §6).
3. **staleEnoughSinceAdmission** — 호출자(어댑터)가 계산해 넘긴다. 이 코어 자신은
   그 계산을 재현하지 않는다 — 어댑터의 몫.
4. 위 넷 외의 경로로는 `evaluateNeverConsumedRetirement`가 절대 `OPEN`에 도달할 수
   없다 — 함수 자체가 순차적 AND-체인이고 마지막 줄 외에는 전부 거부다. 이건
   코드 구조 자체가 증거다(마지막 return 앞에 9개의 조기 반환, 전부 reject).

## 6. 범위 판단: 이번 라운드는 어디까지인가

**설계 + 코어 판정 함수 + 시험까지.** 관제실의 실제 배달기(`dispatch-worker.ps1`)나
라이브 admission-ledger.json/dispatch-receipts.jsonl을 읽어 위 `facts`를 실제로
조립하는 **어댑터**(예: `dispatch-gate-decision.mjs`에 새 함수 추가)는 **이 라운드
범위 밖**이다. 근거:

- 이 코어(`evaluateNeverConsumedRetirement`)가 참조하는 두 원격 사실(admission-ledger
  예약, dispatch-receipts 매칭 수)은 라이브 제어실 파일에서만 읽을 수 있다 — 이
  라운드는 `admission-ledger.json`/`.lock`을 **읽기만도** 하지 않았다(coder-task.md
  §0의 최상위 금지선). 그 파일들을 실제로 읽어 `facts`로 변환하는 어댑터 코드를
  "저장소 안 코어"로 정직하게 완성하려면 최소한 그 스키마를 검증할 표본이 필요한데,
  이 라운드는 그 표본을 라이브에서 뜰 권한이 없다(§0 정책).
- `checkArchiveFacts`에 `NEVER_CONSUMED_NO_ARCHIVE` 예외 분기를 넣는 것(§3-2)은 기존
  소비 축(consumption-receipt-core.mjs가 이미 통과시키는 정상 경로)의 검증 로직을
  바꾸는 결선이다 — 사람 승인 없이 라이브 소비 경로의 관문을 넓히는 변경이라
  coder-task.md §2⑹의 "라이브 배달기를 건드리는 결선은 범위 밖" 원칙에 정확히 해당한다.
- §3의 선택지 가/나는 사람이 정할 몫이라고 §3-3에서 이미 명시했다 — 코더가 먼저
  구현해 버리면 그 판단을 사실상 대신 내리는 셈이 된다.

## 7. 정직 한계

- **이 설계가 여전히 못 여는 경우**: (1) case B 전체(§2⑦로 닫힌, 재시도 흔적이 있는
  모든 표본) — §3의 사람 서명 경로가 결정되고 구현되기 전까지는 영원히 못 연다.
  (2) admission-ledger 자체가 삭제/손상된 경우 — §2 관문 2조차 확인할 수 없다,
  1R §3-2와 동일한 한계. (3) §5 항목 2의 워크트리 파일 위조 — 이 코어는 그 위조를
  탐지하지 못한다. (4) dispatch-receipts.jsonl의 보존 기간 정책을 이 라운드는
  확인하지 않았다(미확인, 1R §3-3과 동일).
- **이 설계가 새로 요구하는 것(사람 손 · 새 기록)**: A(§2)는 **새 기록을 요구하지
  않는다** — 이게 1R 대비 2R의 핵심 절약이다(off-by-one만 고치면 기존 아카이버가
  이미 충분한 증거를 남기고 있었다). B(§3)는 새 기록을 요구하지 않지만(기존
  retirement-record-writer.mjs 재사용), **사람의 두 가지 결정**을 새로 요구한다:
  (i) §3-3 가/나 중 어느 쪽을 택할지, (ii) 택한다면 §3-2의 `NEVER_CONSUMED_NO_ARCHIVE`
  분기를 누가·언제 `retirement-record-core.mjs`에 결선할지(별도 코더 라운드, 사람 승인
  필요).

## 8. 1R 축을 왜 버렸는가 / 새 축이 왜 vacuous하지 않은가

1R 축("이 라운드 자신의 task 보존 사본 개수 == 0")은 실제 배달 경로에서 그 개수가
**항상 ≥1**이므로(§0, 게이트가 배달 직전 매번 스냅숏함) 그 조건이 참이 되는 실물
라운드가 **존재할 수 없었다** — 열리는 문이 이론적으로만 있고 실물로는 결코 도달
불가능했다.

2R 축("다음 순번(N+1)의 task 보존 사본이 없음")은 **같은 아카이버 함수를 두 번째로
부르느냐 마느냐**에 따라 실제로 값이 갈린다 — §2-1의 두 REAL SHAPE 시험이 정확히
같은 함수(`archiveRoundTaskFile`) 호출 1회 vs 2회로 그 갈림을 재현한다. "다음 라운드가
드롭됐는가"라는 질문에 대해 이 축이 내놓는 참/거짓이 실제 관측 가능한 파일 diff와
1:1로 대응한다 — 이게 vacuous하지 않다는 것의 시험적 증거다.

## 9. 안 한 것 / 이상하다고 느낀 관측 (2R)

- **안 한 것**: 라이브 admission-ledger.json/.lock에 대한 읽기·쓰기 어떤 시도도 하지
  않았다. `admission-cli` 호출 0건.
- **안 한 것**: `retirement-record-core.mjs`/`retirement-record-writer.mjs`를 수정하지
  않았다(§3-2의 예외 분기는 제안일 뿐 구현하지 않았다) — 기존 소비 축의 동작은 이
  라운드 전후로 바이트 단위 동일하다.
- **안 한 것**: `dispatch-gate-decision.mjs`/`admission-completion-adapter.mjs`에 새
  어댑터를 추가하지 않았다(§6 범위 판단).
- **이상하다고 느낀 관측**: 1R 문서(§2-2)는 이미 "task 보존 사본이 1건 이상이면 이
  설계는 열지 않는다"고 명시적으로 적어 두었었다 — 즉 1R 저자 자신도 "0건이 아니면
  못 연다"는 조건을 세워 두고도, 그 0건이 실제로 도달 가능한지(=이 라운드 자신의
  스냅숏이 항상 존재한다는 사실)를 검증하지 않은 채 넘어갔다. 검토가 코드를 직접 읽고
  나서야 이 간극이 드러났다 — "설계 문서가 자기모순 없이 일관돼 보인다"는 것과
  "그 조건이 실물에서 참이 될 수 있다"는 것은 별개의 검증이라는 교훈으로 남긴다.
