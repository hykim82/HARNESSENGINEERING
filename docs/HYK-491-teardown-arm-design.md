# HYK-491-teardown-arm — 무장(armed) 실행 경로 설계안 (PR 2)

이 문서는 HYK-464(그림자, PR 1)가 이미 ELIGIBLE로 가린 워크트리를 실제로
치우는 "무장" 실행 경로(PR 2)의 설계 기록이다. 1R(`2063a4a`)은 REVIEW
1R에서 P1-1(커밋 안 된 변경이 있는 워크트리를 `--force`로 지워 변경을
영구히 잃음)·P1-2(무장 파일의 "이상 값"이 전부 on으로 샘) 둘 다 P1로
반려됐다 — 2R은 그 두 결함과 P2 6건(P2-1~P2-6)을 수리한다. 1R의 결과
파일(`.harness/rounds/CODER-r1.md`)이 PR 2 설계 기록을 대신했는데,
그 자체가 P2-5(설계 메모 부재)였다 — 이 문서가 그 공백을 채운다.

`docs/HYK-464-teardown-shadow-design.md`는 **이 라운드가 손대지 않는다**
— 1R이 그 문서에 넣은 내용은 착수 전 과제 ⓐ(문면 정정: "혼합 = PRESENT"
→ UNKNOWN)뿐이고, REVIEW 1R이 그 정정 자체를 "범위 안"으로 확정했다
(review-1 §3 ⑴). `git diff 01f2acad6...HEAD -- docs/HYK-464-teardown-shadow-design.md`
로 직접 대조한 결과 그 문서는 "1R 이전 문면 + ⓐ 정정"만 들어 있고
무장(armed) 관련 내용은 처음부터 없었다 — 그래서 "옮길 무장 내용" 자체가
없다(옮길 것이 없으니 되돌릴 것도 없다, §5 한계에 재확인).

## 1. 무장 파일 형식

감시 폴더(`--watch-dir`가 이미 받는 그 디렉터리) 안의 `teardown-arm.json`
하나로만 켠다 — 새 CLI 플래그·schtasks 인자 변경 0(ORCH가 그 파일을
만들거나 지우는 것만으로 켜고 끈다).

**판정 조건(단 하나)**: 파일 내용이 `JSON.parse`로 파싱되는 **객체**이고,
`armed` 필드가 정확히 불리언 `true`일 때만 무장(on)이다. 그 밖은 전부
off이고, 각 사유는 서로 다른 토큰으로 구분한다(판정에는 쓰지 않는다 —
그냥 "왜 off인지"를 기록만 한다):

| 입력                                                | 사유 토큰                             |
| --------------------------------------------------- | ------------------------------------- |
| 파일 없음                                           | `TEARDOWN_ARM_FLAG_ABSENT`            |
| 빈 파일                                             | `TEARDOWN_ARM_FLAG_EMPTY`             |
| JSON 파싱 실패                                      | `TEARDOWN_ARM_FLAG_NOT_JSON`          |
| 같은 이름의 디렉터리                                | `TEARDOWN_ARM_FLAG_IS_DIRECTORY`      |
| 최상위 값이 문자열(예: `"true"`)                    | `TEARDOWN_ARM_FLAG_VALUE_IS_STRING`   |
| 최상위 값이 숫자(예: `1`)                           | `TEARDOWN_ARM_FLAG_VALUE_IS_NUMBER`   |
| 최상위 값이 배열                                    | `TEARDOWN_ARM_FLAG_VALUE_IS_ARRAY`    |
| 객체이지만 `armed` 키 없음                          | `TEARDOWN_ARM_FLAG_ARMED_KEY_MISSING` |
| 객체이고 `armed`가 `true`가 아님(예: `false`)       | `TEARDOWN_ARM_FLAG_ARMED_NOT_TRUE`    |
| (방어적 기본값) 그 밖의 최상위 값(불리언·`null` 등) | `TEARDOWN_ARM_FLAG_NOT_OBJECT`        |

**선택 필드** `confirmed_by`(문자열)·`at`(문자열)는 **기록만** 한다 —
armed 여부 판정에는 전혀 쓰지 않는다. 있으면(둘 중 하나라도) 받는함
(`teardown-arm-notify-*.md`) 머리에 "confirmed_by=... at=..."로 그대로
옮겨 적는다(사람이 "누가·언제 승인했다"를 읽을 수 있게 — 그 값 자체의
진위는 검증하지 않는다).

디렉터리 판정은 `readFileSync`가 디렉터리에 던지는 `EISDIR`을 잡아서
낸다(별도 `statSync` 없이 — 이 저장소의 fs 주입 관례와 맞춘다, §5).

## 2. 고정 순서

ELIGIBLE 워크트리 하나당 아래 순서를 **전부** 통과해야 제거까지 간다.
어느 단계든 실패하면 그 자리에서 멈추고(그 워크트리는 "건너뜀"), 그
회차의 나머지 ELIGIBLE 워크트리도 더 진행하지 않는다(§3 "전체 중단"
근거 참조).

1. **재관측**(`observeFreshArmInventory`) — 그림자 판정 당시 캐시가 아니라
   실행 시점에 headSha·브랜치 이름·아카이브 대상 목록을 다시 읽는다.
2. **아카이브 목적지 선점 확인**(`checkArchiveDestAbsentForArm`, P2-3) —
   `<archiveRoot>/<워크트리 이름>-final`이 이미 있으면 그 자리에서
   멈춘다(덮어쓰지 않는다).
3. **SHA·브랜치 선기록**(`recordTeardownArmSha`) — `sha-record.json`에
   경로·브랜치·SHA·시각을 쓴다. 이것이 복원의 유일한 근거다.
4. **아카이브 + sha256 왕복 대조**(`archiveTeardownHarnessFiles`) —
   `.harness` 전체를 복사하고, 원본을 **다시 읽어** 사본과 sha256을
   대조한다(대조 자체가 "쓴 바이트"가 아니라 "쓴 뒤 다시 읽은 바이트"를
   본다 — 쓰기 왕복 자체를 증명).
5. **좌석 0 확인**(`checkSeatZeroForArm`) — 그 워크트리를 가리키는
   터미널이 하나라도 있으면(연결 여부 무관) 멈춘다.
6. **working tree clean 확인**(`checkWorkingTreeCleanForArm`, **P1-1
   수리**) — `git status --porcelain`이 0줄이 아니면 멈춘다. 그림자
   판정(`judgeArchiveEligibility`)은 이 축을 전혀 보지 않으므로(6개
   체크 중 dirty 축이 없다), 이 단계가 "ELIGIBLE이지만 아직 지우면 안
   되는" 워크트리를 걸러내는 마지막 안전판이다.
7. **제거**(`removeArchivedWorktree`, 어댑터 경유, G9) — **`--force`
   없이** `orca worktree rm`을 부른다(아래 §4 "--force를 뺀 근거").
8. **로컬 브랜치 없으면 복원**(`removeAndRestoreBranch`) — `orca worktree
rm`은 브랜치도 함께 지우므로, 선기록 SHA로만(`git branch <name>
<sha>`) 복원한다(추측 조립 0).
9. **재관측**(`reobserveArmedRemoval`) — 3층(git/orca/dir) 전부 absent +
   브랜치 SHA가 선기록과 일치해야 성공이다.

## 3. fail-closed 표 — "건너뜀" vs "전체 중단"

| 단계                             | 실패 시 그 워크트리                                                             | 실패 시 같은 회차의 나머지 워크트리 |
| -------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| 1~6 (재관측 ~ working tree 확인) | 그대로 둔다(제거 0)                                                             | **중단** — 더 처리하지 않는다       |
| 7 (제거)                         | 그대로 둔다(제거 0)                                                             | **중단**                            |
| 8 (브랜치 복원)                  | 워크트리는 이미 지워졌다 — SHA 선기록 파일로 손 복원 가능(받는함에 명령 그대로) | **중단**                            |
| 9 (재관측)                       | 워크트리는 지워졌고 브랜치도 복원됐지만 사후 조건이 안 맞음(의심스러운 상태)    | **중단**                            |

**기본값 = 전체 중단**(한 워크트리의 실패가 그 회차의 나머지를 멈춘다).
이것은 1R의 기존 설계를 그대로 유지한다(`runArmedRemovalLoop`의
`if (!r.ok) break;`) — 2R은 이 기본값을 바꾸지 않았다. 근거: 이 축은
파괴적 작업이고, 한 워크트리에서 예상 밖의 실패(특히 좌석·아카이브·
working-tree축처럼 "판단 자체가 흔들리는" 실패)가 나왔다면 같은 회차의
다른 ELIGIBLE 판정도 같은 종류의 오류를 공유할 가능성을 배제할 수 없다
— 다음 회차(다음 tick)에 그 워크트리부터 다시 판정·시도된다(영구
손실이 아니라 "지연"). 건너뛰고 계속하는 대안(한 워크트리 실패가
나머지에 번지지 않게)은 이 라운드가 채택하지 않았다 — 그 대안을 쓰려면
"그 실패가 다른 워크트리의 판정에 영향이 없다"를 증명해야 하는데, 이
축은 아직 그 증명을 해 본 적이 없다(라이브 실물 0회, §5 한계).

## 4. `--force`를 뺀 근거 (P1-1)

1R은 `buildWorktreeRemoveCommand`(A5, 항상 `--force`)를 그대로 재사용해
커밋 안 된 변경이 있는 워크트리도 조용히 force-제거했다. 2R은 ⑴ §2
단계 6(working tree clean 확인)이 제거 직전에 porcelain 0줄을
fail-closed로 요구하므로 `--force`가 더는 필요 없고, ⑵ 이미 HYK-171
축(`teardownSeat`)이 똑같은 이유로 만들어 둔 `buildTeardownWorktreeRemoveCommand`
(force는 `opts.force===true`일 때만 붙는다)를 `force:false`로 재사용한다
— 새 빌더를 만들지 않았고, `buildWorktreeRemoveCommand`(A5, rollback
전용) 자체는 한 글자도 바꾸지 않았다(그 함수의 유일한 다른 호출자인
`createManagedWorktree`의 rollback은 이 변경과 무관).

## 5. P2-1 대체 근거 — "활성 예약" 축을 좌석 0 + 미소비 0으로 대체

과제가 요구한 "활성 예약 또는 좌석" 축을 글자 그대로 구현하려면 전역
admission 원장(`admission-ledger.json`)을 워크트리 경로로 조회해야
한다 — 그런데 원장 행은 `seat_key`(pane key)만 갖고 **워크트리 경로가
없다**(실물 1행 원문 키: status/role/seat_key/admitted_at/…/source).
그래서 "이 워크트리를 가리키는 활성 예약이 있는가"를 원장만으로 직접
대조할 수 없다(1R이 이미 이렇게 판단했고, REVIEW 1R도 동의했다 —
review-1 P2-1).

2R은 이 공백을 두 기존 축의 **합**으로 대체한다:

- **좌석**(`observeSeatCount`) — 그 워크트리를 가리키는 터미널이 하나라도
  있으면(연결 여부 무관) count>0 — "지금 누가 그 워크트리에 붙어 있다"는
  살아 있는 예약의 가장 직접적인 증거다.
- **미소비**(`checkUnconsumedRoundsClear`, 그림자 축이 이미 본다) —
  "최근 라운드가 아직 끝나지 않았다"도 활성 작업의 증거다.

**대체의 한계**(정직하게 적는다): 좌석 없이도 활성 상태인 예약(예:
배정만 됐고 아직 터미널을 열지 않은 경우)은 이 둘 중 어느 것도 잡지
못한다 — 그런 예약이 실제로 존재하는지, 존재한다면 빈도가 얼마인지는
**이 라운드가 측정하지 않았다**(실측이 아니라 설계 해석, 책임자 재확인
권장 — review-1이 "상신 대상"으로 못박은 그대로).

## 6. 아카이브 (P2-2/P2-3/P2-4)

- **기본 위치**(P2-2): `archiveRoot`를 명시로 주지 않으면
  `<watchDir의 부모>/아카이브/<날짜>-teardown-arm/<워크트리 이름>-final/`
  에 쓴다 — ORCH 손 B-15(`관제실\아카이브\<날짜>-B76-…\<이름>-final\`)와
  같은 모양(날짜 자동 폴더 + 사람이 읽을 수 있는 `<이름>-final`). 1R의
  `computeCanonicalPathDigest`(32-hex) 기반 폴더 이름은 버렸다 — 사람이
  읽을 수 없었다(review-1 P2-2).
- **덮어쓰기 금지**(P2-3): 같은 경로가 다시 아카이브 대상이 되면(워크트리
  재사용) `<이름>-final`이 이미 있으므로 그 자리에서 건너뛴다(B-15의
  `if (Test-Path $A) { throw 'archive exists' }`와 같은 성질). 기존
  아카이브의 바이트는 무변으로 보존된다(§2 변이표 ④ 실측).
- **실제 제거 수**(P2-4): 로그 꼬리의 `teardown_arm_removed`는 "워크트리가
  실제로 없어진 수"를 센다(`r.ok===true || r.removed===true`) —
  브랜치 복원이 실패해도(워크트리는 이미 지워졌다) 센다. 1R은 `r.ok`만
  셌다(복원 실패 시 실제로는 지워졌는데도 0으로 보고됐다). 복원 실패
  시 받는함에 "로컬 브랜치 없음 -- 복원 명령: git branch <name> <sha>"
  줄을 그대로 적는다(사람이 바로 복사해서 쓸 수 있게).

## 7. 원장 경로 칸 (후속 후보)

§5의 한계를 기계로 닫는 방법 후보 1줄: admission 원장의 각 행에
`worktree_path`(정규화된 절대경로) 필드를 추가하면, "이 워크트리를
가리키는 ACTIVE 예약이 있는가"를 좌석·미소비 없이도 원장만으로 직접
조회할 수 있다 — 이 라운드는 그 원장 스키마 변경을 하지 않는다(범위
밖, 책임자 등재 후속 — coder-task.md §2 "원장 경로 칸(P2-1 후속)").

## 8. 음성(제거 0) 축 — P2-6 보강

1R의 새 시험(`hyk491-teardown-arm.test.mjs`)에는 무장 on 상태의 "본체"·
"커밋 안 된 변경" 음성이 없었다(review-1 P2-6 — 본체 제외 변이(M3)가
그 스위트는 못 잡고 기존 `teardown-shadow-wire.test.mjs`만 잡았다).
2R은 아래를 추가했다:

- 본체(main checkout)가 다른 ELIGIBLE 조건을 전부 만족해도 인덱스 0
  축이 막는다(제거 0, rm 호출에 본체 경로가 없다).
- 커밋 안 된 변경(추적 수정 1 · 미추적 1) — §2 단계 6이 막고, 변경은
  그대로 보존된다(실물로 파일 내용을 재확인).
- 무장 파일 이상 값 9종(§1 표) 각각 — off로 새고 사유 토큰이 서로
  구분된다(제거 0, orca exec 호출 0).
- 아카이브 경로 재사용(같은 워크트리 경로가 2차 대상이 됨) — 건너뜀 +
  기존 아카이브 바이트 무변.
- 아카이브 기본 위치(§6) — archiveRoot 미지정 시 실제 경로 확인.

## 9. 정직 한계

1. **무장 기본 off** — 이 PR이 병합돼도 `teardown-arm.json`을 만들지
   않으면 아무것도 지워지지 않는다. 켜는 주체는 병합 뒤 책임자 통지로
   ORCH다(이 라운드는 켜지 않는다).
2. **무장은 그림자 ELIGIBLE의 부분집합만 지운다** — 그림자 판정(6개
   체크) 자체는 이 라운드가 한 글자도 바꾸지 않았다. 이 라운드가 더한
   좌석 0·working-tree-clean 두 안전판은 그 ELIGIBLE 집합을 **더
   좁히기만** 한다.
3. **활성 예약 축은 원장에 워크트리 경로가 없어 직접 대조 불가** — 좌석
   0 + 미소비 0으로 대체했다(§5, 원장 경로 칸 = 후속 후보 §7).
4. **라이브 실물 = 무장 on 뒤 실제 병합 워크트리 1회(이 라운드는 합성만)**
   — 시험 전부가 `git init`+`git worktree add`로 만든 합성 저장소(진짜
   origin bare remote 포함) + fake orca exec뿐이다(§live_send_ban: 실
   `orca worktree rm`/`terminal close`/`git branch -D` 0회, 전부 가짜
   exec seam).
5. **같은 tick 안에서 "건너뜀 뒤 재시도" 상호작용은 완전히 검증하지
   않았다** — 예: working-tree-clean 확인(§2 단계 6)에서 막힌 워크트리는
   그 전에 이미 SHA·아카이브(§2 단계 3~4)를 써 버린다. 그 워크트리가
   다음 tick에 clean해져서 다시 ELIGIBLE로 처리되면, §2 단계 2(아카이브
   선점 확인)가 "이미 아카이브가 있다"며 막아버릴 수 있다 — 이것은 좌석
   축(1R부터 있던 순서)에도 이미 있던 동형의 상호작용이고, review-1이
   이 상호작용 자체를 P1/P2로 지적하지는 않았다(이 라운드의 범위 밖,
   책임자 재검토 후보로만 남긴다).
