# HYK-494: machine-wide runner mutual-exclusion lock -- design

## 1. 왜

HYK-266 CODER 1R과 HYK-491 CODER 1R, 서로 다른 워크트리의 전건 러너가 같은
시각에 돌았다(ORCH 직접 영수증 대조: run 종료 시각 09:51:00/09:49:32 ·
10:07:46/10:07:54(둘 다 빨강) · 10:40:22/10:40:28, 실행 중 최저 free 값
동일 — 같은 머신 자원을 두 러너가 동시에 갉아먹었다는 직접 증거). 266의
빨강 2회는 이 라운드가 건드리지 않는 `hyk387-dispatch-record-required
.test.mjs`(시계·파일 경합에 민감한 시험)에서 났다. 지금껏 이 경합을 막는
것은 지시서의 `parallel_rule`(작성자 자기 측정: "직전 node 수를 재고 비면
시작")과 ORCH의 "러너 창" 순서 관리(사람 규율)뿐이었다 — 두 좌석이 같은
박자로 재면 둘 다 "0"을 보고 같이 시작할 수 있다. 이 라운드는 그 경합을
코드로(사람 규율이 아니라) 막는다.

## 2. 잠금 경로 — 저장소 밖, 머신 공용, 고정 이름

`runner-lock.mjs`의 `defaultRunnerLockPath()`는 `os.homedir()/harness-
isolated-suite-runner.lock`을 기본값으로 쓴다.

⚠️**2R 수리(P2-4)**: 1R은 `os.tmpdir()` 아래였다. REVIEW-1R이 실측으로
반증했다 — `os.tmpdir()`은 호출 프로세스의 `TEMP`/`TMP` 환경변수를
따르고, 좌석(또는 사용자 세션)마다 그 값이 다르면 서로 다른 경로를
보게 돼 "머신 전체에 하나"가 애초에 성립하지 않았다. `os.homedir()`은
OS 사용자 계정 단위로 고정이고 어떤 프로세스의 환경변수에도 좌우되지
않는다 — 이 모듈의 유일한 존재 이유(§1, "이 사용자가 돌리는 모든
워크트리/세션이 같은 파일을 본다")에 더 정확히 맞는다.

- **저장소 밖**: 이 머신의 모든 워크트리가 같은 경로를 봐야 상호 배제가
  성립한다. 저장소 안의(워크트리마다 다른) 경로는 애초에 이 문제를 풀 수
  없다.
- **`os.homedir()` 아래**: 이 사용자 계정의 모든 세션/워크트리가 공유하는
  디렉터리이고, 추가 설정(관제실 경로 등) 없이 항상 존재한다. 관제실
  경로(`D:\문서관리\하네스-관제실\`)를 저장소 코드에 박지 말라는 지시서
  `env_rule`/`live_watch_rule`과도 별개로, 이 모듈은 관제실의 존재를 전혀
  모른다 — 순수하게 "이 사용자 계정에 하나"라는 사실만 쓴다.
- **고정 이름**: 매 실행 다른 이름이면 "머신 전체에 하나"가 깨진다.
- **경로 seam**: `isolated-suite-runner.mjs`의 `runIsolatedSuite`는
  `lockPath` 파라미터로 이 기본값을 덮어쓸 수 있다 — 모든 시험(기존
  15+개 · 새 20+개)은 합성(mkdtemp) 경로 또는 완전 스텁을 쓴다("Synthetic
  lock paths only", 배달 지시).
- ⚠️여전히 남는 한계: 서로 다른 OS 사용자 계정 경계는 못 막는다(§11-2).

## 3. 원자적 획득 — `wx` 배타 생성

⚠️**3R 수리(판정 23:5x §1 ①′+③+④′)**: `wx`는 더 이상 잠금 "게시" 그 자체의
메커니즘이 아니다 — `createExclusive`가 전체 내용을 임시 파일에 먼저 다
쓴 뒤 `linkSync(tmp, lockPath)`로 "올린다"(T0 실측, 아래). `link`는 그
이름이 **없을 때만** 성공하고(원자적, `EEXIST`로 실패), 쓰는 중간의
"빈 내용" 순간이 전혀 없다(전체 내용이 이미 디스크에 있는 다른 이름을
링크로 올리는 것뿐이므로). 내용은 `{ pid, startedAtMs, procStart,
worktree, head, lockId }`(JSON) — `procStart`(§7의 신원)와
`lockId`(§8 교착 방지 토큰)가 2R 대비 신규다. **`aliveAtMs`는 더 이상
이 내용 안에 없다** — heartbeat는 별도 파일로 옮겼다(§7-5 F8 수리).

`EEXIST`는 "누가 이미 쥐고 있다"는 정상적인 경쟁 신호로 받는다(허수아비
처리). `EPERM`/`EBUSY`/`EACCES`(백신·삭제 대기 등 일시 실패)는 "busy"로
구분해 재시도하되, `BUSY_RETRY_TIMEOUT_MS`(30초) 연속을 넘기면 던진다 —
**EEXIST만 "다른 주인이 있다"는 사실**이고, 나머지는 재시도 후 bounded
throw로 흡수한다(PM 설계 (b) 영향 2-3). 그 **외의** 쓰기 실패는 그대로
던진다 — 삼키면 "상호 배제를 보장하는 척하면서 실제로는 보장 못 하는"
상태(이 모듈이 막으려는 사고의 재판)가 되기 때문이다.

### 3-1. T0 — 이 머신(Windows)에서 직접 잰 값

3R 착수 전 실측(구현 전): ① `link(tmp, L)`은 L이 있으면 `EEXIST`로
실패하고 L을 덮어쓰지 않는다(✔) ② 동시 5개 `link` 중 정확히 1명만
성공(30회 반복, 위반 0, 실제 자식 프로세스)(✔) ③ 전체 내용을 쓴 뒤
link하므로 L을 읽는 쪽이 부분 내용을 보지 않는다(✔) ④ `rename`은 대상이
있으면 덮어쓴다(✔, 판정 문면 요구 — 설계가 rename을 쓰지 않더라도
1회 실측). 네 가지 모두 PM 설계 (b)의 전제와 일치했다 — NEEDS_INPUT
없이 구현을 진행했다.

## 4. 대기 — 이름 붙은 상수 + 근거

- `LOCK_POLL_INTERVAL_MS = 1000`(1초): 이 저장소의 전건 러너는 수십 초~
  분 단위(실측 ~623초)로 걸린다 — 더 촘촘한 폴링은 CPU만 태우고 체감
  대기를 줄이지 못한다.
- `LOCK_WAIT_TIMEOUT_MS = 20분`: 실측된 가장 긴 전건 러너(~10.4분)의 약
  2배 — 정상적인 선행 실행을 기다리는 데는 충분하고, 진짜로 걸린(교착·
  매우 느린 머신) 경우를 무한정 기다리지 않는 바깥 울타리다.

- `BUSY_RETRY_TIMEOUT_MS = 30초`(3R 신규): `createExclusive`가 EPERM/EBUSY/
  EACCES를 연속으로 보는 시간의 상한 — 백신·삭제 대기 같은 일시 현상을
  흡수하는 재시도 창이되, 무한정 삼키지 않는다(§3).

셋 다 `acquireRunnerLock`의 파라미터로 오버라이드 가능(시험은 모두 ms
단위의 작은 값을 쓴다 — 실제 '몇 분 기다리는' 시험은 0개, 모두 바운드된
빠른 시험).

## 5. 상한 초과 — 시험을 돌리지 않고, 초록으로 접지 않는다

`isolated-suite-runner.mjs`의 `acquireLockForRun`이 `acquired:false`를
받으면 `reportLockTimeout`이 호출된다:

- `node --test`를 **한 번도 spawn하지 않는다**(클론도, 측정도 하지
  않는다 — `resolveConcurrencyAndFirstLine`/`setupRunDirs`/
  `cloneAndCollectFiles` 전부 이 분기 이전에 return되어 도달하지 않는다).
- exit code 1(비영 — 영수증 소비 게이트(HYK-411)의 1차 안전장치인
  `runner_exit !== 0` 검사가 그대로 이 결과를 거부한다).
- 새 `RUNNER_STATUS.LOCK_TIMEOUT`("LOCK_TIMEOUT") — 기존
  `MEASUREMENT_UNAVAILABLE_OOM`에 욱여넣지 않은 이유: 그 이름 자체가
  "OOM"을 전제하는데 이 원인은 메모리와 무관하다 — 틀린 원인을 적는 것은
  "정직 > 편의" 원칙에 반한다. `relay-handshake.mjs`는 이 값을 특별
  취급하지 않지만(grep 확인, §6), 1차 안전장치(`runner_exit`)가 이미
  거부하므로 새 enum 추가가 소비 판정을 바꾸지 않는다.
- `.harness/runner-receipt.json`(**최신본만**)에 `lock_*` 필드가 채워진
  채 쓰인다 — **번호 슬롯(`runner-receipt-run<N>.json`)은 할당하지
  않는다**: 시도 자체가 시작되지 않았으므로 "이 회차의 실행 증거"가
  없고, HYK-485의 연속-2회 게이트는 어차피 "실제로 돌았던" 번호 슬롯만
  비교하므로 이 설계는 그 게이트의 입력을 전혀 바꾸지 않는다(정직 한계
  §8-3 참조).

## 6. 영수증 — 기존 칸 무변, 새 칸만 추가

`runner-receipt-writer.mjs`의 `buildRunnerReceipt`는 1R에서 6개 칸을
추가했고, 2R(REVIEW-1R P1-2 rejected 뒤)이 다시 6개를 **더** 추가한다 —
총 12개, 기존 칸 이름·의미·순서는 바이트 단위로 그대로:

| 칸                               | 의미                                                           | 라운드 |
| -------------------------------- | -------------------------------------------------------------- | ------ |
| `lock_path`                      | 이 실행이 겨냥한 잠금 파일 경로                                | 1R     |
| `lock_wait_ms`                   | 획득까지 실제로 기다린 ms(0 = 경쟁 없이 즉시)                  | 1R     |
| `lock_poll_count`                | 폴링 횟수                                                      | 1R     |
| `lock_reclaimed_orphan`          | 이 실행이 고아 잠금을 회수했는가                               | 1R     |
| `lock_nested`                    | 중첩 우회로 통과했는가(파일을 건드리지 않음)                   | 1R     |
| `lock_timed_out`                 | 상한을 넘겨 포기했는가                                         | 1R     |
| `lock_wait_start_ms`             | 대기를 "시작"한 epoch ms                                       | 2R     |
| `lock_wait_end_ms`               | 대기를 "끝낸"(획득/타임아웃) epoch ms                          | 2R     |
| `lock_prior_owner_pid`           | 마지막으로 읽을 수 있었던 앞 소유자의 pid                      | 2R     |
| `lock_prior_owner_started_at_ms` | 앞 소유자의 시작 시각                                          | 2R     |
| `lock_prior_owner_worktree`      | 앞 소유자의 워크트리                                           | 2R     |
| `lock_nested_bypass_rejected`    | 우회 마커가 있었지만 토큰이 안 맞아 거부됐는가                 | 2R     |
| `lock_reclaim_reason`            | 이 실행이 "왜" 고아를 회수했는가(`pid-dead`·`pid-reused`·null) | 3R     |
| `lock_lost`                      | 해제 시점에 이 잠금이 더는 우리 것이 아니었는가                | 3R     |

⚠️3R 새 칸 2개(판정 23:5x §1 ⑸): `lock_reclaim_reason`은
`reclaimedOrphan`이 true일 때만 의미 있다 — `judgeOwner`가 DEAD로 판정한
이유 그대로(§7-1). `lock_lost`는 **해제**(release) 시점의 사실이다 —
`releaseRunnerLock`이 lockId 불일치/누락으로 지우지 못하면 true가 되고,
`isolated-suite-runner.mjs`는 이를 `RUNNER_STATUS.LOCK_LOST` + `exit 1`로
번역한다(기존 `LOCK_TIMEOUT`과 같은 "초록으로 안 접힘" 길, §9-2). 두 칸
모두 기존 12칸 이름·의미·순서를 바이트 단위로 그대로 두고 **덧붙이기만**
한다.

⚠️2R 새 칸은 REVIEW-1R P1-2가 명시 계약 미이행으로 반려한 바로 그
필드다(product_scope ⓘⓘ "앞 소유자(pid·시작 시각·워크트리)·대기 시작
시각·대기 끝 시각"). `priorOwner`는 `runner-lock.mjs`의 전체 잠금 내용
(`pid/startedAtMs/worktree/head/lockId/aliveAtMs`)을 들고 있지만,
영수증에는 product_scope가 명시한 세 필드만 나간다 — `lockId`/
`aliveAtMs`/`head`는 이 모듈 내부 식별 수단이지 사람이 읽는 진단
계약의 일부가 아니다.

소비 게이트(HYK-411/HYK-485, `relay-handshake.mjs`)가 이 새 칸들을
아는지 grep으로 확인했다(§1 사전 확인) — `runner_exit`/`head_commit` 등
**기존** 필드만 읽고, `schema_version`도 비교하지 않는다(기존 코멘트:
"그 쪽은 이 receipt의 schema_version 값을 전혀 비교하지 않는다"). 모르는
새 칸은 단순히 무시된다 — 판정에 영향 없음.

## 7. 고아 회수 — 3R: 세대 번호 회수권 + "낡음은 방아쇠일 뿐"

**불변식(1줄, PM 설계 (d)):** L이라는 이름을 지울 수 있는 "살아 있는"
프로세스는 언제나 1개 이하다 — 살아 있는 주인 자신이거나, 주인이 DEAD일
때 그 인스턴스의 유일한 살아 있는 회수권자다. L의 생성은 `link`로 1명만
이기므로 "두 주인"은 구조적으로 불가능하다.

⚠️**왜 3R인가(reject-streak-envelope)**: 2R의 고아 회수는 "훔친 뒤
검증·틀리면 되돌림"(낙관적 회수)이었다 — rename으로 훔친 뒤 불일치면
link로 되돌리는데, 그 되돌리는 틈에 4번째 진입자가 빈 이름을 채우면
되돌리기가 `EEXIST`로 생략되어 "살아 있는 새 주인의 잠금"이 영영
사라졌다(검토 2R 실측: 잠금 함수 15/30, 실제 러너 진입점 9/10 완전
겹침 — 이 라운드 자체 탐침 재현도 §7-6 참조). heartbeat 낡음을 "회수
판정"으로 쓴 것도 겹침을 만들었다 — 60초 넘게 기다린 뒤 잡은 주인은
잡는 순간 `aliveAtMs`가 이미 대기 시작 시각이라 곧바로 "낡음"으로 보여,
첫 heartbeat(2R 기준 30초) 전까지 다른 진입자가 "고아"로 회수했다(실측
겹침 5,005 ms).

### 7-1. `judgeOwner` — 판정은 둘, 그 중 하나만 즉시

```
judge(O):  if kill(O.pid,0)==ESRCH → DEAD("pid-dead")                 # 싼 경로, 즉시
           if age(L.alive.<O.lockId>) ≤ M → ALIVE("alive-fresh")       # 싼 경로
           s = startIdentity(O.pid)                                    # 비싼 경로, 낡았을 때만
           if s≠null and O.procStart≠null and s≠O.procStart → DEAD("pid-reused")
           else ALIVE("alive-heartbeat-stale")                         # 회수하지 않음, 기록만
```

**이탈 1(책임자 판정 23:5x §1 ⑴ 승인)**: heartbeat가 `M`(기한)을 넘겨
낡았다는 사실 **그 자체는 회수 사유가 아니다** — 신원 질의(`startIdentity`)
를 부르는 "방아쇠"일 뿐이다. 신원이 일치하거나(같은 프로세스가 계속
살아 있다) 모르면(질의 실패) **ALIVE로 본다** — 절대 "낡음"만으로
회수하지 않는다. 신원이 **다를 때만**("pid-reused") DEAD로 판정한다.
근거: 살아 있는 pid의 잠금을 뺏는 것은 그 프로세스가 재개하면 정의상
두 주인이다(사이드카 사망·절전 재개가 바로 이 모양을 만든다) — 큰
기한의 heartbeat 회수로 얻는 것이 없다(사이드카는 "멈춘(hung) 러너"를
어차피 못 본다, §12).

⚠️**HYK-494 후속 수리(P2-1)**: 이 "alive-heartbeat-stale" 판정 그
자체는 3R에서부터 이미 안전했지만(회수하지 않는다), 그 사실을 아는
사람이 없었다 — 사유가 계산 뒤 버려졌고 로그·영수증·반환값 어디에도
남지 않았다(REVIEW-3R P2-1 지적). `acquireRunnerLock`은 이제 `logFn`
(기본 no-op, `isolated-suite-runner.mjs`는 자기 `log`를 그대로 넘긴다
-- 결선 줄 1개)을 받아, 이 판정에 들어올 때 1번만 찍는다(폴마다 찍으면
홍수가 되므로 "상태가 바뀔 때"만 -- 벗어나면 다시 찍을 수 있는 상태로
돌아간다).

### 7-2. `startIdentity(pid)` — 신원 질의

- **Linux**: `/proc/<pid>/stat`의 22번째 필드(부팅 후 tick, comm 필드
  뒤 **마지막** `")"`부터 파싱 — comm 자체가 공백·괄호를 포함할 수
  있어서다). 〔못쟀다〕 실물(이 라운드는 Windows 머신) — 파싱 로직만
  주입 seam으로 결정론적으로 시험했다.
- **Windows**: `(Get-Process -Id N).StartTime.ToFileTimeUtc()`를
  PowerShell로 1회 부른다(동기, `spawnSync`). 〔직접〕 실물.
- 그 밖/실패: `null`. 비교는 항상 **원문 문자열이 같은지**로만 한다.
  **전제 A1(§13)**: 이 질의가 틀리면(같은 프로세스인데 다른 값) 거짓
  회수가 생길 수 있다 — 실패하면 `null` → ALIVE로 보수적으로 처리한다.

### 7-3. 세대 번호 회수권 — `L.reclaim.<O.lockId>.<k>`

```
k = 이미 있는 O의 권한 중 최대 번호(없으면 0)
if k>0:
  r = read(권한 k)
  if r.ok and r.content is 자기(pid, procStart) 자신:        # HYK-494 후속(followup-3) P1-1
    reread = read(L)
    if reread.ok:
      if reread.content.lockId == O.lockId: unlink L
      best-effort unlink L.alive.<O.lockId>, L.reclaim.<O.lockId>.*
      claim-again
    else: wait(bounded, 연속 상한 뒤 throw)                  # P2-2 메커니즘 재사용
  elif r.ok and judge(r.content)≠DEAD: wait                  # 이미 "남이" 회수 중
  elif r.ok==false and r.err≠ENOENT: wait(bounded, 연속 상한 뒤 throw)  # HYK-494 후속 P2-2
  # r.ok==false and r.err==ENOENT(보유자가 이미 지웠다)만 다음 줄로 진행
createExclusive(L.reclaim.<O.lockId>.<k+1>, {pid, procStart}) → EEXIST면 wait
reread = read(L)
if reread.ok:
  if reread.content.lockId == O.lockId: unlink L            # 유일한 비주인 삭제 지점
  best-effort unlink L.alive.<O.lockId>, L.reclaim.<O.lockId>.*  # L 삭제 "뒤"(reread.ok일 때만, HYK-494 후속 P2-3)
# reread.ok==false면 청소를 건너뛴다 -- L을 지웠는지 확인하지 못했다.
#   (HYK-494 후속followup-3: 다음 라운드가 바로 위 "자기 자신" 분기로
#    돌아와 재시도한다 -- 20분 LOCK_WAIT_TIMEOUT_MS 전체를 자기 자신을
#    기다리는 데 쓰지 않는다.)
```

⚠️**HYK-494 후속 수리(P2-2·P2-3, 이 의사 코드는 그 수리를 반영해 고친
문면이다 -- 원래 글자 그대로였던 "청소 무조건"은 REVIEW P2-3이 지적한
빈칸이었다)**: 회수권 k를 읽다가 ENOENT가 아닌 실패(일시적 공유 위반 등)
를 보면 "보유자가 지웠다"로 보지 않는다 -- 2R이 L 자체에 대해 닫은
"읽기 실패 ≠ 고아"(F3) 원칙을 회수권 판독에도 적용한다(bounded 재시도
뒤 throw, `BUSY_RETRY_TIMEOUT_MS`와 같은 상수). 그리고 "재확인 읽기"
자체가 실패하면(reread.ok==false) L을 지웠는지 확인할 길이 없으므로
청소를 건너뛴다(**논증 4·5의 "청소 = L 삭제 뒤" 전제를 글자대로 지킨다**)
-- 우리 회수권은 그대로 남아 "살아 있는 회수권자 ≤1"을 계속 보장한다.

⚠️**HYK-494 후속(followup-3) 수리(P1-1, 검토 1R 교착 지적)**: 바로 위
"재확인 읽기 자체가 실패하면 청소를 건너뛴다"는 맞다 — 하지만 그
회수권(k+1, 우리 자신의 것)은 다음 라운드에도 그대로 살아 있다. REVIEW
1R이 재현한 교착은 그 "다음 라운드"의 동작이었다: `judge(권한 k 보유자)`
가 "자기 자신"을 "이미 누가 회수 중"으로 오판해 `wait`로 떨어지고, 그게
`LOCK_WAIT_TIMEOUT_MS`(20분)까지 반복됐다(같은 고아를 기다리는 다른
모든 러너도 그 뒤에서 함께 멈췄다 — 실제 자식 2개로 재현, HEAD 3/3 시간
초과 · base 0/3). 수리는 "회수권 k 보유자가 자기 자신이면 기다리지
말고 재확인·삭제 단계를 그 자리에서 재시도한다"이다(PM 설계 재심이
아니다 — P2-3의 "청소 = L 삭제 뒤" 전제를 그대로 지킨다, 재시도도 같은
reread-then-cleanup 경로를 재사용할 뿐이다). 재시도의 reread가 또
실패하면 무조건 claim-again(타이트 스핀)으로 두지 않고, 이미 검증된
P2-2의 "바쁨 상한 뒤 throw" 메커니즘(`ticketReadBusySinceMs`)을
재사용한다 -- 자기 자신을 기다리는 데 20분 전체를 쓰지 않고
`BUSY_RETRY_TIMEOUT_MS`(30초)로 끊는다(선택 ②, 근거: 무조건
claim-again은 reread가 계속 실패하는 동안 sleep 없는 타이트 스핀이
되지만, 바쁨 메커니즘 재사용은 폴 간격 sleep과 상한을 둘 다 그대로
얻는다). 불변식("살아 있는 회수권자 ≤1")은 무변 -- 재시도가 새 회수권을
만들지 않고 k를 재사용하기 때문이다.

⚠️**HYK-494 후속(followup-3) 수리(P2-3 참고 칸)**: 시간 초과로 끝난
결과에 `reclaimedOrphan:true`가 남아 있던 적이 있었다(claim-again이
낙관적으로 세운 플래그가, 그 뒤 「진짜」 살아 있는 새 주인에게 졌을
때도 지워지지 않았다 — 영수증 `lock_reclaimed_orphan` 오독 소지).
`timedOut:true`인 결과는 이제 항상 `reclaimedOrphan:false`·
`reclaimReason:null`이다 — "시간 초과"는 정의상 "확정된 회수"가 아니기
때문이다.

**되돌림이 전혀 없다** — 2R의 "rename-steal → 비교 → 불일치면 link로
복원"을 완전히 버렸다. 한 번호(`k+1`)는 `link`로 정확히 1명만 얻으므로
"살아 있는 회수권자"는 O 하나당 언제나 1명 이하다. 표식이 고아가 되면
(회수권자가 죽으면) **지우지 않는다** — 다음 번호를 새로 만든다. 죽은
보유자는 되살아나지 않으므로 세대가 복제될 수 없다(2R의 "고정 이름
표식" 모양이 가진 두 주인 가능성이 구조적으로 없다). 늦게 만들어진
권한은 재확인에서 `L.lockId ≠ O.lockId`가 되어 아무것도 지우지 않는다
(L이 이미 다른 주인으로 넘어갔다는 뜻).

⚠️**범위 밖 발견(〔직접〕, 고치지 않음, deviation_rule)**: 이 라운드의
D2 시험(`hyk494-runner-lock.test.mjs`의 "D2 (scoped)")이 세 번째
삽입점("자기 회수권을 link하기 직전")을
탐색하다가 `cleanupAfterReclaim`의 접두 매칭(`reclaim.<lockId>.`)이 다른
프로세스의 **아직 link되지 않은** `reclaim.<lockId>.<k>.tmp.<suffix>`
파일에도 걸린다는 사실을 발견했다(그 tmp 이름 자체가 그 접두로 시작
하므로) -- 한 회수권자의 청소가 다른 회수권자의 진행 중인 tmp 파일을
지워 그 쪽의 `linkSync`를 ENOENT로 실패시킬 수 있다. 이것은 실재하는
좁은 틈이지만 이번 라운드가 받은 계약(P2-1~P2-7·CI-1)의 밖이라 고치지
않았다 -- 시험 파일의 D2 주석과 이 결과 파일에 그대로 남긴다(다음
라운드 후보).

### 7-4. ③ 잡는 순간 heartbeat — P1-B를 구조적으로 닫는다

acquire 루프는 **매 라운드**(폴마다) `L.alive.<me.lockId> = now`를
먼저 쓴 뒤에 `createExclusive(L, ...)`를 시도한다(`refreshOwnAliveFile`).
그래서 "이번 라운드에 실제로 이기는" 순간의 heartbeat는 **항상 최대
한 폴 간격(기본 1초)만큼만 늙어 있다** — 대기가 99초였든 0초였든 무관
하다. 2R의 버그(`aliveAtMs = startedAtMs`, 대기 시작 시각에 고정)가
사라지는 자리가 정확히 여기다.

### 7-5. F8 수리 — 사이드카는 L을 열지도 쓰지도 않는다

2R의 사이드카는 L 경로 자체를 `readFileSync`/`writeFileSync`로 직접
고쳐 썼다(PM 발견 F8) — 거짓 고아 회수 뒤 새 주인의 L을 옛 내용으로
덮거나, 지워진 L을 되살릴 수 있는 경로였다(재현은 안 됐지만 소스상
가능했다). 3R의 `HEARTBEAT_SCRIPT`/`defaultSpawnHeartbeat`는 **`lockPath`
인자 자체를 받지 않는다** — `alivePath`(`L.alive.<token>`)만 안다.
구조적으로 L을 건드릴 길이 없다(소스: `runner-lock.mjs`의
`defaultSpawnHeartbeat`/`HEARTBEAT_SCRIPT` 정의, 재현 불요 · 자동화된
동작 시험도 이 라운드에 추가됨 — "the sidecar NEVER touches the lock
file L itself").

### 7-6. 읽기 실패 ≠ 고아 (2R 수리, 무변 — 3R도 유지)

`readLockContentResult`가 실패(ENOENT · 파싱 실패 · 빈/손상 내용)하면
`{ok:false}`를 돌려주고, 호출자는 이를 **"바쁘다"로만** 본다 —
`judgeOwner`/`resolveContendedStep` 자체를 건너뛴다. 1R의 "읽기 실패 =
고아" 버그가 재발하지 않는다.

### 7-7. 이 라운드 실측 — RED(e4691d9) → GREEN(3R)

`runner-lock-race-probe.mjs`(신규 탐침, §(f) 칠 명령)로 실측:

| 칸                                                      | e4691d9(2R)                  | 3R                   |
| ------------------------------------------------------- | ---------------------------- | -------------------- |
| orphan-dead, 3 entrants, 30 trials                      | overlap 5~8/30, owners_max 3 | **overlap 0/30**     |
| long-wait(backdated startedAtMs), 2 entrants, 10 trials | overlap 10/10                | **overlap 0/10**     |
| cold-start, 3 entrants, 15 trials                       | overlap 0/15(이미 닫힘)      | overlap 0/15(무회귀) |

같은 프로세스 seam 결정론 재현(D1, hooked renameFn으로 review-2 §2
ⓐ의 정확한 5단계를 2R 코드 위에서 재생)도 RED 확인(owners_max 2) —
3R은 rename을 reclaim 경로에서 완전히 뺐으므로(§7-3) 같은 메커니즘
자체가 존재하지 않는다.

⚠️**HYK-494 후속 수리(P2-4)**: 이 탐침(`runner-lock-race-probe.mjs`)의
출력 칸 `lost`는 REVIEW-3R이 지적할 때까지 상수 `0`이었다 -- 재지 않은
값을 잰 것처럼 보였다. childScript는 이제 `releaseRunnerLock`의 실제
반환값(`lockLost`)을 담아 돌리고, `runCell`은 그 값을 모아 돌린다. 새
`lock-lost` 칸(진입자가 자기 잠금을 쥔 "뒤" 직접 다른 lockId로 덮어써
해제 시 lockLost:true가 되게 하는 자기 침입 흉내)으로 `lost`가 실제로
0이 아닌 값을 낼 수 있음을 증명했다(1 진입자 5회 실행 → `lost=5`) --
이 칸은 상호 배제 자체를 주장하지 않는다(외부가 L을 직접 덮어쓰면 당연히
성립하지 않는다, §9-2) -- "상수가 아니라 측정값"이라는 사실만 증명한다.

## 8. 중첩 실행 교착 금지

### 8-1. grep 전수 결과

`scripts/check/isolated-suite-runner.test.mjs`의 `runCli` 헬퍼(그 파일
약 33번째 줄)가 **이 러너의 CLI 진입점 자신을 자식 프로세스로 띄운다**
— 이 저장소에서 "러너가 러너를 자식으로 띄우는" 유일한 지점이다(§2
ⓐ⑵ 전수 grep, 다른 결과 없음). `hyk359-ambient-env-regression.test.mjs`
의 `runProductionSweep`도 `node --test`를 자식으로 띄우지만 **러너 CLI
자신이 아니라 일반 `node --test`를 직접 호출**하므로(이 함수를 통하지
않는다) 이 잠금을 전혀 거치지 않는다 — 교착 후보가 아니다.

### 8-2. 왜 교착인가

이 저장소의 전건 러너는 "클론 → 그 클론 안에서 `scripts/check/*.test
.mjs` 전체를 `node --test`로 실행"한다. 그 전체 안에는
`isolated-suite-runner.test.mjs` 자신도 들어 있고, 그 파일의 `runCli`
시험들은 **같은 CLI 진입점**(`isolated-suite-runner.mjs`)을 또 자식으로
띄운다. 바깥 러너가 이미 잠금을 쥔 채 `spawnSync`로 그 전체 패스가 끝날
때까지 **동기적으로 차단**돼 있으므로, 안쪽 자식이 같은 잠금을 다시
기다리면: 안쪽은 바깥이 풀 때까지 기다리고, 바깥은 안쪽(을 포함한 전체
패스)이 끝날 때까지 기다린다 — 서로가 서로를 막아 영원히 안 풀린다.

### 8-3. 해법 — env 신호 (토큰, pid 아님 — 2R P2-1 수리)

`NESTED_LOCK_BYPASS_ENV_VAR`(`HARNESS_RUNNER_LOCK_HELD_BY`). 바깥
프로세스가 잠금을 쥐면(`guardLockForRun`) 자기 `process.env`에 이 값을
심는다(해제 시 지운다). `spawnSuiteInClone`은 이미 자식 `env`를
`{...process.env, ...}`로 구성하므로, 이 값은 클론 안 `node --test`
자식에게 자동으로 전파되고, 그 자식이 추가로 띄우는 `spawnSync` 호출이
`env`를 명시하지 않으면(이 저장소의 `runCli`가 그렇다) Node는 **그
자식의** `process.env`(이미 이 값을 물려받음)를 상속한다 — 몇 단계를
거치든 체인이 끊기지 않는다.

⚠️**2R 수리(P2-1)**: 1R은 이 값에 **pid**를 심었고, `acquireRunnerLock`은
"값이 있기만 하면" 무조건 믿었다(REVIEW-1R 실측 재현: 바깥 셸이 아무
값이나 `HARNESS_RUNNER_LOCK_HELD_BY`에 켜면, 살아 있는 다른 주인이
잠금을 쥔 상태에서도 0ms로 통과했다 — 값의 진위를 전혀 검증하지
않았다). 2R은 이 값에 **lockId**(잠금을 획득할 때마다
`crypto.randomUUID()`로 새로 뽑아 잠금 파일 내용에 `lockId`로 적어
두는 난수 토큰)를 심는다. `acquireRunnerLock`은 env 값이 있으면,
**지금 그 경로의 잠금 파일을 실제로 읽어** 그 `lockId`와 env 값이
정확히 같을 때만 파일을 건드리지 않고 즉시
`{acquired:true, nested:true}`를 돌려준다(§ⓒ⑷ 시험). 같지 않으면(값이
없거나, 손으로 켠 값이거나, 이미 해제된 조상 프로세스의 묵은 값이거나)
**무시하고 평범한 획득 경로로 떨어진다** — `nestedBypassRejected:true`
가 결과와 영수증(`lock_nested_bypass_rejected`)에 남는다. 난수 토큰이라
바깥에서 손으로 맞출 수 없다 — "값이 있으면 믿는다"는 더는 통하지
않는다.

## 9. 해제 — lockId로만, 정상·예외·신호에서

⚠️**3R 수리(F11 닫힘)**: `releaseRunnerLock`은 더 이상 `pid`를 대조하지
않는다 — 파일 내용의 `lockId`가 호출자가 건넨 `lockId`와 정확히 일치할
때만 지운다(PM 설계 (d) "release: if read(L).lockId==me.lockId: unlink
L else lock_lost=true"). lockId는 획득할 때마다 새로 뽑는 난수라, pid
재사용(같은 pid가 전혀 다른 인스턴스를 가리키는 경우)에도 헷갈리지
않는다 — pid 대조보다 더 정확한 키다. 일치하지 않거나(다른 주인) 파일
자체가 없으면(이미 누가 치웠다) **지우지 않고** `{released:false,
lockLost:true}`를 돌린다.

### 9-2. LOCK_LOST — 해제 시점에 "내 것이 아니었다"는 사실의 번역

`isolated-suite-runner.mjs`의 `guardLockForRun`이 돌리는 `release()`는
**메모이즈**된다(한 번만 실제로 파일을 건드리고, 그 결과를 캐시해서
돌려준다) — `reportRunOutcome`이 영수증을 쓰기 **직전**에 한 번
부르고, 바깥 `runIsolatedSuite`의 `finally`가 예외-안전망으로 또 한 번
불러도 두 번째는 캐시된 결과만 돌아올 뿐 파일을 다시 건드리지 않는다.
`release()`가 `lockLost:true`를 돌리면 — 이 실행 "자체"의 측정 결과가
무엇이었든(`node --test`가 초록이었어도) — 최종 반환 exit code는 1,
영수증의 `runner_status`는 `RUNNER_STATUS.LOCK_LOST`로 **덮어써진다**
(기존 `LOCK_TIMEOUT`과 다른, 새 enum 값 — 저쪭은 "측정을 시작도 안 함",
이쪽은 "측정은 했지만 그 사이 잠금을 빼앗겨 결과를 믿을 수 없음",
`reportLockTimeout` 분기는 건드리지 않는다). 판정 23:5x §1 ⑶: "조용한
겹침보다 보이는 빨강이 낫다" — 이 번역이 그 선언을 코드로 만든다.

`isolated-suite-runner.mjs`는 `try { ... } finally { release(); }`로
정상 반환과 모든 예외(클론 실패, spawn 실패 등) 둘 다에서 해제를
보장한다. SIGINT/SIGTERM은 `installLockReleaseOnSignal`(`runner-lock.
mjs`)이 별도로 건다. `release()`는 heartbeat 사이드카(§12)도 함께
멈춘다 — 잠금은 풀렸는데 사이드카만 살아남아 남의(다음 주인의) 잠금을
계속 갱신하는 사고를 막는다(사이드카는 자기 소유의 `L.alive.<token>`
파일만 갱신하므로, §7-5의 구조적 보장과 맞물려 이 사고의 범위는
"쓸모없는 파일 하나가 좀 더 오래 남는다" 정도로 좁혀진다).

### 9-3. HYK-494 후속 수리(P2-7) — 포기한 대기자도 자기 heartbeat 파일을 지운다

대기자는 매 폴 `refreshOwnAliveFile`로 `L.alive.<자기 lockId>`를 쓴다
(§7-4) -- 그런데 그 대기가 시간 초과(`timedOut:true`)로 끝나거나, 바쁨
상한을 넘겨 throw로 끝나면(§3 `BUSY_RETRY_TIMEOUT_MS`, 그리고 이번
라운드가 같은 모양으로 추가한 회수권 읽기 busy의 bounded throw) 그
파일을 안 지우고 있었다 -- LOCK_TIMEOUT(또는 busy throw) 1회마다 잠금
디렉터리(운영 = 홈)에 파일 1개가 누수됐다(fix1이 "정상 해제" 경로만
고쳤고, "못 잡고 포기" 경로는 그대로 남아 있었다). `acquireRunnerLock`
은 이제 `runAcquireLoop`를 try/catch로 감싸 결과가 `acquired:false`면
(또는 catch에서 다시 던지기 전) 자기 heartbeat 파일을 best-effort로
지운다 -- 공간 누수일 뿐 불변식과는 무관하다(§7-3의 회수권 청소와 같은
근거).

### 9-1. ⚠️정직 한계 — 신호 타이밍

이 파일의 호출 그래프는 전부 동기 차단(`spawnSync`/`Atomics.wait`)이다.
Node는 블로킹 시스템 콜이 반환되기 전까지 신호 핸들러를 포함한 어떤 JS도
실행할 수 없다 — 그래서 이 핸들러는 "이벤트 루프가 다시 돌 수 있는 틈"
(블로킹 호출 사이)에 도착한 신호만 즉시 처리한다. 블로킹 호출 **도중**
도착한 신호는 그 호출이 반환된 뒤에야 처리된다(OS가 신호 자체를 들고
있다가 전달 — 잃어버리지는 않는다, 즉시성이 없을 뿐).

## 10. CI(Linux, 단일 러너) 동작 — 무변

CI는 한 번에 한 러너만 돈다 — 잠금은 항상 비어 있는 상태에서 즉시
획득되고 즉시 해제된다(`waitMs:0`). `os.homedir()`(2R, Linux에서는
`$HOME`)는 항상 쓰기 가능하므로 §3의 "쓰기 불가 → 예외" 분기도 실제로는
트리거되지 않는다 — 판정 계약(tests 총수 · fail 0 · head 일치 ·
full-2x)은 한 글자도 바뀌지 않는다.

## 12. heartbeat 사이드카 — 3R: 자기 소유 파일만, L은 열지도 쓰지도 않는다

`startLockHeartbeat`는 **별도 프로세스**(`-e` 인라인 스크립트, 이 파일의
`FREE_MEM_SAMPLER_SCRIPT`/`node-concurrency-sampler.mjs`와 같은
"in-process 타이머 아님" 근거 — 이 잠금을 쥔 프로세스는 실행 내내
`spawnSync`/`Atomics.wait`로 동기 차단돼 있어 같은 프로세스 안의
`setInterval`은 그 블로킹 "도중"에는 돌 수 없다, §9-1과 같은 제약)로
`isolated-suite-runner.mjs`의 `guardLockForRun`이 **실제로 잠금을 쥔
직후에만**(`nested`가 아닐 때만) 시작한다.

⚠️**3R 수리(F8, PM 발견)**: 2R의 `HEARTBEAT_SCRIPT`는 `lockPath`를
인자로 받아 L을 직접 `readFileSync`/`writeFileSync`로 고쳐 썼다 — 구조
상 거짓 고아 회수 뒤 새 주인의 L을 덮거나 지워진 L을 되살릴 수 있는
경로였다. 3R의 `HEARTBEAT_SCRIPT`/`defaultSpawnHeartbeat`는 **`alivePath`
(`L.alive.<token>`)만 인자로 받는다** — `lockPath` 자체를 모른다, 구조
적으로 L을 건드릴 길이 없다(§7-5).

⚠️**HYK-494 후속 수리(CI-1, master CI 541bc95 enforce 빨강 원인 ①)**:
`HEARTBEAT_SCRIPT`가 `alivePath`에 쓰는 방식 자체가 비원자적이었다 --
`fs.writeFileSync(alivePath, ...)`는 `open(O_TRUNC)`으로 먼저 비운 뒤
별도의 `write()`로 내용을 채우는 두 단계다. 그 사이에(틀림없이 아주
좁은 창이지만) 다른 프로세스가 `alivePath`를 읽으면 빈 파일을 본다 --
`hyk494-runner-lock.test.mjs:1379`의 `JSON.parse` "Unexpected end of
JSON input"이 정확히 이 모양이다(읽는 "자리"는 L이 아니라 이 alive
파일 -- F8 수리로 사이드카는 L 자체를 열지 않으므로 L이 빈 순간이 될
길은 없다, §3의 createExclusive가 이미 "전체 내용을 tmp에 다 쓴 뒤
link"로 닫은 자리와 같은 성격의 구멍이 이 파일에만 남아 있었다).
자연 타이밍 재현은 이 머신에서 50회 중 0회(창이 실재하지만 매우
좁다) -- seam으로 그 열림(open-truncate)과 닫힘(write) 사이를 인위적
으로 넓혀 결정론적으로 재현했다(4/4, 정확히 같은 오류 문자열). 수리는
createExclusive와 같은 관용구 -- tmp 이름에 전체 내용을 다 쓴 뒤
`renameSync`(대상이 있으면 덮어쓴다, §3-1 ④ 실측)로 `alivePath` 위에
교체한다 -- 빈 내용 순간이 전혀 없다. 수리 뒤 같은 seam 재현은 4/4
모두 `emptyReadObserved:false`.

- **간격·기한(판정 23:5x §1 ⑴)**: `HEARTBEAT_INTERVAL_MS`(10초, 2R의
  30초에서 교체) · `HEARTBEAT_STALE_MS`(3분, 2R의 90초에서 교체) — N·M
  모두 책임자 판정이 지정한 값. M/N=18이라 사이드카가 17번 연속 늦어야
  신원 질의 1회가 생긴다(비용만 든다, §7-1). 이 설계에서 M은 "안전값"이
  아니다 — 낡음은 신원 질의를 부를 뿐 회수하지 않기 때문이다(§7-1의
  이탈 1).
- **자기 종료 조건**: 사이드카 자신이 매 tick "주인 pid가 아직
  살아 있는가"를 확인한다 — 죽었으면 더는 갱신하지 않고 스스로
  멈춘다. 또한 `alivePath`가 가리키는 토큰이 주인이 넘겨준 그대로이므로
  (사이드카는 토큰 재검증을 하지 않는다 — 애초에 자기만 그 경로를
  쓴다, F8 수리 이후 "남의 것을 덮어쓸" 경로 자체가 없다).
- **인프라 실패는 측정 불가로 격하**: 스폰 자체가 실패해도 조용히
  no-op 핸들을 돌려준다(startConcurrencySampler/startFreeMemSampler와
  같은 자세) — heartbeat가 없어도 잠금 자체의 상호 배제(§3 link 배타
  게시)는 깨지지 않는다, 다만 pid-reused 보강(§7-1)만 못 받는다(그
  경우 heartbeat 나이는 항상 Infinity로 취급되어 매 폴 신원 질의를
  부른다 — 느려질 뿐 안전은 깨지지 않는다).
- **기본은 OFF**: 이 저장소의 기존/다른 `runIsolatedSuite` 호출 전부가
  `startHeartbeatFn`을 언급하지 않는다 — 기본값이 실제 사이드카였다면
  그 모두가 진짜 자식 프로세스를 띄웠을 것이다. `useAutoConcurrency`와
  같은 패턴으로, 이 파일 자신의 CLI 진입점(`runIsolatedSuiteCli`)만
  실제(`startLockHeartbeat`)를 켠다.
- ⚠️**사이드카는 여전히 "멈춘(hung) 러너"를 못 본다** — 주인 pid가
  `spawnSync` 안에서 영원히 멈춰 있어도 그 pid는 "살아 있다"이므로
  heartbeat는 계속 신선하다. 이 설계는 그것을 감지 대상에서 뺐다(§13).

## 13. 정직 한계 (요약, ⛔지시서 §4 필수 3줄 포함)

1. **이 잠금은 이 러너 진입점(`isolated-suite-runner.mjs`)만 덮는다** —
   다른 러너 진입점(`full-sweep-local.mjs` 등)이나 수동 `node --test`
   호출은 막지 않는다(범위 밖, §2 `deviation_rule`).
2. **머신 공용 경로라 다른 사용자·권한 경계에서는 보장이 없다** — 서로
   다른 OS 사용자 계정이 `os.homedir()`의 서로 다른 경로를 보거나,
   한쪽이 그 경로에 쓸 권한이 없으면 상호 배제가 성립하지 않는다.
   ⚠️**2R 추가**: **파일 잠금이라 네트워크 드라이브·다른 사용자
   계정은 보장 없음** — `os.homedir()`가 네트워크 공유(로밍 프로필 등)
   를 가리키면 `wx`/`rename`/`link`의 원자성 보장이 그 파일시스템
   구현에 좌우된다(로컬 NTFS/ext4만 실측, 네트워크 드라이브는
   〔못쟀다〕).
3. **라이브 실물 = 다음 병렬 레인 2개 라운드다** — 이 라운드는 합성
   (mkdtemp) 잠금 경로로 여러 "실제" 자식 프로세스를 띄워 직렬화와
   회수의 안전성을 증명했고(§ⓒ⑴, §10b, §7-7), 자기 자신의 전건
   러너를 2회 돌려 잠금이 실제로 잡히고 풀리는지 영수증으로 확인했다
   (§3 완료 조건 3) — 하지만 "서로 다른 두 워크트리의 진짜 전건 러너
   2개가 동시에 시작해도 겹치지 않는다"는 그 다음 실물 라운드가
   확인해야 할 사실이다.
4. pid 재사용 오판(§7-1, 3R은 신원 질의로 닫았지만 전제 A1 — 신원 질의
   자체가 틀릴 가능성 — 은 남는다), 신호 타이밍(§9-1) — 위에서 각각
   서술.
5. ⚠️**3R 추가(S11, 판정 23:5x §1 ⑶ "대가 수용")**: **멈춘(hung) 러너는
   살아 있으므로 회수하지 않는다.** 주인 프로세스가 `spawnSync` 안에서
   영원히 멈춰 있어도 그 pid는 "살아 있다"이고, 사이드카는 "주인 pid가
   살아 있는가"만 보므로(§12) heartbeat는 계속 신선하다 — hung을 감지할
   길이 구조적으로 없다. 뒤에 줄 선 러너들은 `LOCK_WAIT_TIMEOUT_MS`
   (20분)마다 `LOCK_TIMEOUT`(시험 0·빨강)을 받고, **사람이 그 프로세스를
   직접 끝내야** 풀린다. 이것이 "두 주인 0"(§7 불변식)의 대가다 —
   **조용한 겹침보다 보이는 빨강이 낫다**는 판정이 받아들인 trade-off다.
6. **Windows만 실측했다** — Linux CI의 `process.kill(pid, 0)`과
   `/proc/<pid>/stat` 파싱(§7-2)은 Node/커널 문서상 동일하게 명시돼
   있으나 이 라운드에서 직접 재현하지는 않았다(〔추론〕 — 파싱 로직만
   주입 seam으로 결정론적 단위 시험했다).
7. **3R도 전수 조사가 아니다** — §7-7/§10b의 real-child-process 시험은
   유한 표본(10·15·30회)이다. 0회 위반을 봤다는 것은 "이 머신, 이 시각,
   이 표본수에서" 사실이지 전칭 증명이 아니다(universal_claim_discipline).
8. **커널이 쥐는 잠금(판단 유보, 이탈 아님)** — Windows 공유 모드 0
   열기·libuv `UV_FS_O_EXLOCK` 같은 대안은 프로세스가 죽으면 OS가 풀어
   고아 회수가 아예 없다. Node가 이 플래그를 실제로 노출/통과시키는지는
   미확인이다 — 확인 전에는 채택하지 않는다(3R 밖의 리서치 항목, PM
   설계 (i)).
9. ✅**HYK-498이 수리했다(§15 참고, 더는 "범위 밖"이 아니다)** —
   `cleanupAfterReclaim`의 접두 매칭(`reclaim.<lockId>.`)이 다른
   회수권자의 **아직 link되지 않은** `reclaim.<lockId>.<k>.tmp.<suffix>`
   이름에도 걸렸다(그 tmp 이름 자체가 그 접두로 시작하므로) — 한
   회수권자의 청소가 다른 회수권자의 진행 중인 tmp 파일을 지워 그 쪽의
   `linkSync`를 ENOENT로 실패시킬 수 있었다(검토 3R `probe-prefix-gap.mjs`
   결정적 재현, 이번 라운드의 D2 시험 세 번째 삽입점("before-ticket-link")
   이 같은 모양을 production `acquireRunnerLock` 진입점으로 재확인 --
   base(#358/6d7bed1) 위에서 RED, 수리 뒤 GREEN). 이전 라운드(5R)가 받은
   계약(P2-1~P2-7·CI-1) 밖이라 그때는 고치지 않았던 항목이다 -- §15-1
   참고.
10. **HYK-494 후속(followup-3) P1-1 수리의 상한은 20분에서 30초로 줄었을
    뿐, "영원한 보장"이 아니다** — 재확인 읽기가 `BUSY_RETRY_TIMEOUT_MS`
    (30초)를 넘겨 계속 실패하면(이 머신에서는 못 재현했다, 리뷰 1R의
    실제 EBUSY도 400~2000ms 수준) 여전히 throw한다(정직 > 낙관, §7-3
    기존 posture 그대로). 다만 그 throw는 **보이는 빨강**이고,
    20분짜리 조용한 교착보다 사람이 훨씬 빨리 알아챈다.
11. **HYK-494 후속(followup-3) P2-1 수리는 best-effort다, "tmp 0 보장"이
    아니다** — 이 라운드 실측(real PowerShell sharing-violation, 40회
    충돌 유도): 수리 뒤에도 드물게(5~~8회 시도 중 0~~1개) tmp가 남는
    회차를 봤다(원인 미확인 — write 성공 뒤 아무 로그도 남기지 못한 채
    사라진 자리, 〔못쟀다〕). 되돌리면(catch에서 unlink를 빼면) 같은
    조건에서 80개 넘게 남는다(이 라운드 실측, 5회 중 81~83개) — 그래서
    새 시험(`hyk494-runner-lock.test.mjs`의 "leaks almost no tmp
    files")은 "정확히 0"이 아니라 "압도적으로 적음"(문턱 3) 을 기대값
    으로 삼는다.
12. **HYK-494 후속(followup-3) P1-1의 "다른 대기자 1명을 둔 실제 프로세스"
    칸은 실제 OS EBUSY가 아니라 주입된(synthetic) EBUSY다** — 검토 1R은
    실제 PowerShell `FileShare.None`으로 진짜 공유 위반을 일으켰지만,
    이 라운드의 실제-프로세스 회귀 칸은 (기존 단위 시험들과 같은 관례로)
    자식 스크립트 안에서 두 번째 `L` 읽기에 `err.code="EBUSY"`인 합성
    오류를 주입한다 — 실제 자식 프로세스 2개가 진짜로 경합하는 것은
    맞지만(〔직접〕), 오류 자체의 "실제 OS성"은 검토 1R만큼 실측하지
    않았다(〔못쟀다〕, universal_claim_discipline). P2-1 칸은 반대로
    실제 PowerShell 공유 위반을 쓴다(〔직접〕).

## 14. HYK-494 후속 5R — CI-② 간헐 수리(시계 · 원인 기록 · 신원) + P2-a~c

(검토 2R §2 ⓓ · §3, 책임자 판정 2026-11-09 19:0x)

### 14-1. CI-② — PR #357 master 기반 CI 3/5 빨강, 이 머신 0/690 미재현

검토 2R이 소스 판독으로 적은 원인 후보 4개(§2 ⓓ) 중 1~3을 이 라운드가
고친다(4번 좀비는 범위 밖, 기록만 — 아래 14-5).

1. **원인 후보 1(시계)**: `hyk494-runner-lock.test.mjs`의 3-way 칸들은
   자식마다 `timeoutMs: 5000`(또는 8000) 고정 상한으로 "결국 획득"을
   판정했다 — CI 중첩 스윕(`hyk359-ambient-env-regression.test.mjs:136`
   `NESTED_SWEEP_CONCURRENCY=4`)의 CPU 과포화에서 굶은 자식이 그 안에
   못 잡으면 거짓 RED다. **수리**: `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS
= 20_000`(수십 초)로 올려 cold-start · orphan(이 칸) · dead-ticket ·
   staggered-alive · pid-reuse 5개 3-way 칸에 동일 적용(2-way reclaim과
   5-way cold-start는 "3-way" 범위 밖, 손대지 않음). `wx` 배제 위반 0과
   "3자 모두 획득" 단언은 그대로(단언 약화 아님) — 상한만 "결국"의
   정의를 좁혀 거짓 RED를 줄인다. RED-first 확인(〔직접〕, 2026-11-09,
   base 20b701f 위 2-프로세스 단순화 재현): 실제 홀더가 6000ms 쥐는
   동안 고정 5000ms 획득자는 결정적으로 `timedOut:true`(`waitMs:5003`),
   20000ms로 올리면 같은 조건에서 `acquired:true`(`waitMs:5972`)로
   뒤집혔다.
2. **원인 후보 2(원인 기록 부재)**: `spawnReclaimRaceChild`가
   `stdio:"ignore"`+무던지기 않는 `error` 리스너 없이, 자식이 비정상
   종료하면(`outPath` 미생성) `exit` 처리기의 `JSON.parse(readFileSync
(...))`가 ENOENT를 그대로 던졌다(RED-first 확인: 2026-11-09, 자식을
   50ms 뒤 SIGKILL하자 처리기가 던진 ENOENT가 프로세스 전체를 크래시
   시켰다 — 원인 없는 크래시, 어느 자식이 왜인지 CI 로그에 안 남는다).
   **수리**: stderr를 파이프로 받고 `error` 이벤트를 흡수하고, 읽기
   실패를 던지지 않고 `{missingOutput:true, exitCode, signal,
spawnErrorMessage, readErrorMessage}`로 수집한다. 모든 호출(§10b/
   §10b-2 전체)이 `elapsedMs`/`stderrTail`을 결과에 함께 싣고, 실패
   단언 메시지는 `JSON.stringify(results)`로 회차별 3자 결과·경과
   ms·stderr 꼬리를 그대로 보여준다.
3. **원인 후보 3(죽은 pid 재사용)**: 3-way orphan/dead-ticket 칸이
   시드한 죽은 pid 고아 내용에 `procStart`가 없었다(`undefined`,
   `!= null` 비교에서 `null`과 동치) — CI 중첩 스윕에서 그 pid가 다른
   살아있는 프로세스로 재사용되면 `judgeOwner`/`identityIsDead`
   (`runner-lock.mjs:268-282`, §7-1)가 "신원 모름 → ALIVE"로 오판해
   아무도 회수하지 않고 3자 모두 시계 상한까지 간다. **수리**: 고아
   내용에 비-null 자리표시자 `procStart`(예: `dead-orphan-seed-${trial}`)
   를 심어, 재사용된 pid의 실제 신원과 반드시 불일치하게 만든다 →
   "pid-reused"(dead)로 떨어진다. pid가 재사용되지 않은 보통 경우는
   `isPidAliveFn`이 그보다 먼저 false를 돌려 "pid-dead"로 즉시 판정
   하므로(:306) 이 자리표시자는 그 경로에 영향이 없다 — pid-reuse-
   simulated 칸의 `"not-this-process's-real-identity"`와 같은 기법
   (fixture 현실화).
4. **이 머신에서는 CI-②를 재현하지 못했다(0/690, 검토 2R과 같은
   값)** — 위 세 수리는 모두 소스 판독 기반이고(〔추론〕), **Linux
   CI·중첩 스윕 실부하는 〔못쟀다〕**(WSL 0, universal_claim_discipline).
   증명은 다음 PR CI(책임자 판독)가 맡는다.

### 14-2. P2-a — `:544-547`(5R 라인 번호, 3R `:545-547`과 같은 칸) 오진 문구

"청소 전 호출" 필터(`p.startsWith(lockDirPrefix) && !p.includes(".tmp.")`)
는 요청자 자신의 `L.alive.<자기 lockId>` 삭제(P2-7 수리)까지 "청소"로
센다. 교착 류 변이에서도 먼저 걸리는 단언이 "P2-3 위반"이라는 엉뚱한
문구가 되어 오진을 유발한다(RED 자체는 맞다). **수리**: 필터를 그대로
두고, `acquired`/`timedOut` 단언을 먼저 두는 순서로 바꿔 진짜 결함이
먼저·정확한 문구로 드러나게 한다(review가 허용한 두 대안 중 하나).

### 14-3. P2-b — `:696`(3R 라인) "C1이 회수권을 먼저 잡았는지" 미확인

C2가 15ms 뒤에 뜨고, 주입은 "C1의 2번째 L 읽기"에 건다 — C2가 먼저
ticket #1을 잡는 회차에서는 C1의 주입이 자기-회수권-재확인이 아닌
다른 자리(경합 중 L 읽기)에 떨어져도 둘 다 결국 획득해 통과한다(헛
시험은 아니지만 "자기 분기"를 탄 회차 수를 안 세었다). **수리**: 주입
순간(`lockReadCount===2`) 자기 이름(`process.pid`)의 reclaim ticket이
이미 존재하는지 디렉터리에서 직접 확인해 `selfBranchHit`을 결과에
싣고, 바깥 시험이 `selfBranchTrials >= 1`을 단언한다.

### 14-4. P2-c — 사이드카 stop()의 kill 경합 tmp 잔존 (release 경로에서 best-effort 정리)

`startLockHeartbeat`의 `stop()`(`child.kill()`)이 `HEARTBEAT_SCRIPT`의
write(tmp)·rename(alivePath) 사이를 끊으면 `${alivePath}.tmp.*`가
남는다(SIGTERM은 그 스크립트의 catch를 거치지 않는다) — 검토 2R 실측:
동시 읽기 0·1ms 간격·50회 중 9회차에 1개. **수리**: `releaseRunnerLock`
의 기존 alive-file 청소 자리(`cleanupAliveFile`)에
`cleanupOwnAliveTmpLeftovers`를 추가해, "자기 token" 접두(
`${basename(alivePath)}.tmp.`)만 best-effort로 쓸어 담는다(남의
사이드카 tmp는 무접촉) — release는 보통 stop()보다 뒤에 불려 kill
신호가 이미 정착할 시간이 있다. **정직 한계**: 이것도 "정확히 0 보장"
이 아니다(§13 11번과 같은 posture) — RED-first는 kill-타이밍의 실제
결과물(끊긴 write가 남기는 정확히 그 모양의 tmp 파일)을 직접 심어
확인했다(주입, 〔직접〕 아님) — 실제 kill-레이스 자체는 OS 스케줄링에
좌우되는 순수한 운이라 결정론적 RED-first 재료로 쓰지 않았다.

### 14-5. 범위 밖(기록만)

- **원인 후보 4(좀비)**: `process.kill(pid,0)`은 좀비도 살아 있다고
  본다 — 고아 pid는 `spawnSync`가 회수하므로 해당 가능성은 낮다고
  추론했지만(§7-1), 이 라운드도 고치지 않았다. 다음 라운드 후보.
- `cleanupAfterReclaim` 접두 매칭 틈(§13 9번, 설계 §7-3) — 무변(이
  5R 라운드는). HYK-498이 나중에 수리했다 — §15-1 참고.
- PM 설계 (d) 불변식 재심 — 이 라운드는 시험의 시계 의존·원인 기록·
  fixture만 고쳤고, `runner-lock.mjs`의 §7 판정 로직(judgeOwner/
  identityIsDead 자체) 변경은 P2-c(release 경로 추가) 외에는 0이다.

## 15. HYK-498 — §13-9 동시 회수 크래시 수리 + 2-way/5-way 시계 + P2-1/P2-2

(책임자 판정 2026-11-09 23:5x · 상신 = "A. #358 그대로 병합 진행 +
새 조각 HYK-498" · 검토 3R §2 ⓐ-3·§3 P2-1·P2-2·"정보"(시계 칸 잔존)가
근거)

### 15-1. §13-9 수리 — `cleanupAfterReclaim`을 완성된 티켓 이름만으로 좁힌다

**틈(§13 9번 원문)**: `cleanupAfterReclaim`(`runner-lock.mjs`)은
`reclaimTicketPrefix`(접두 `<basename(L)>.reclaim.<lockId>.`)로 시작하는
이름을 전부 지웠다. 그런데 `createExclusive`가 티켓을 link하기 "전"에
쓰는 임시 이름(`<티켓 경로>.tmp.<randomSuffix>`, 예:
`r.lock.reclaim.O.1.tmp.1699999999999.ab12cd`)도 같은 접두로 시작한다
-- 티켓 번호(`1`) 뒤에 바로 `.tmp.`가 붙으므로 접두 "매칭"은 그 티켓
번호가 있든 없든 통과한다. 그래서 회수권자 A가 자기 reclaim을 끝내고
`cleanupAfterReclaim(O)`를 부르면, **다른** 회수권자 B가 "방금 쓰고
아직 link 전"인 tmp 파일까지 지워버린다 -- B의 뒤이은
`linkFn(tmp, 티켓경로)` 호출은 그 tmp가 사라졌으므로 `ENOENT`로 실패
한다. `createExclusive`의 catch는 `EEXIST`/busy(EPERM·EBUSY·EACCES)만
받고 그 밖은 그대로 `throw`하므로(헤더 주석 그대로, §(d) 불변식과
무관하게 "모르는 실패는 삼키지 않는다"는 기존 posture) 이 `ENOENT`는
호출자(러너 3개가 같은 고아를 동시에 회수하는 드문 경우, 실제 러너
진입점)까지 그대로 올라가 크래시한다. 검토 3R이 `probe-prefix-gap.mjs`
(워크트리 `runner-lock.mjs`를 file URL로 직접 import)로 결정적으로
재현했다: _"행위자 B가 회수권 tmp를 쓴 뒤 link하기 직전, 경쟁자 A가
전체 획득+해제를 끝낸다. 그러면 A의 `cleanupAfterReclaim`이 B의
`...reclaim.orph-X.1.tmp....`를 지운다 ... B의 `acquireRunnerLock`이
throw한다."_

**수리(코더-task §2 ⓘ, 두 옵션 중 전자를 택함)**: 청소 대상을
`reclaim.<O>.<k>` "정확 이름"으로 좁힌다 -- `maxReclaimTicketNumber`가
이미 같은 구분(`Number(suffix)`가 `NaN`이면 제외)을 쓰고 있었으므로,
`cleanupAfterReclaim`에도 같은 "suffix가 숫자뿐인가"(`/^\d+$/`) 검사를
추가했다. `.tmp.<suffix>` 이름은 숫자가 아닌 문자(`.`, 알파벳)를 포함
하므로 이 검사에 걸러진다 -- **완성된(link까지 끝난) 티켓만** 지운다.

**둘 중 왜 전자인가(근거 1줄, 코더-task §2 ⓘ 요구)**: link `ENOENT`를
"이번 라운드 패배(wait)"로 분류하는 대안도 성립하지만(review가 제시한
두 번째 옵션), 그러면 `createExclusive`가 "어떤 ENOENT든" 패배로
삼키게 되어 다른 자리(예: 정말로 디스크에서 사라진 tmp를 다른 버그가
만든 경우)의 ENOENT까지 조용히 가려질 위험이 있다(이 파일의 기존
posture "모르는 실패는 삼키지 않는다"와 어긋난다). 반면 접두 좁히기는
근본 원인(완성 안 된 이름까지 지운 것) 자체를 없애 그런 ENOENT가
**다시는 일어나지 않게** 한다 -- 사후 분류보다 사전 차단을 택했다.

**PM 설계 불변식 무변**: "살아 있는 회수권자 ≤1"·"회수 경로 되돌림
0"·"L이라는 이름을 지울 수 있는 살아 있는 프로세스는 언제나 1개
이하"(§7 머리말) 전부 무변 -- 이 수리는 **다른 프로세스의 아직
완성되지 않은 자원을 건드리지 않게** 좁히기만 했을 뿐, 누가 언제
무엇을 회수하는지의 판정 로직(judgeOwner/resolveContendedStep)은
한 글자도 바뀌지 않았다.

**시험(D2, §10d)**: 기존 D2(scoped) 2개 삽입점(before-reread ·
before-unlink)에 세 번째("before-ticket-link")를 추가했다 -- A의
`createExclusive`가 자기 티켓 tmp를 쓴 "직후, link 전"에 경쟁자 B가
`runActorBOnce`로 전체 획득+해제(와 그 안의 `cleanupAfterReclaim`)를
끝낸다. **base(#358/6d7bed1) 위에서 RED**: `link ENOENT`가 그대로
throw돼 테스트 자체가 실패했다(원문: `ENOENT: no such file or
directory, link '...reclaim.d2-dead-owner.1.tmp....' -> '...reclaim.
d2-dead-owner.1'`). **수리 뒤 GREEN**: A의 tmp가 B의 청소를 살아남아
A의 link가 성공한다(기존 2개 삽입점과 같은 "A가 결국 획득, L은
released" 단언 무변).

### 15-2. 2-way·5-way 시계 칸에도 3-way와 같은 넉넉한 상한을 준다

#358(5R)의 §14-1 수리는 "자식별 고정 클럭으로 결국 획득을 판정"하는
7개 칸 중 5개 3-way 칸(cold-start·orphan·dead-ticket·staggered-alive·
pid-reuse)만 `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`(20_000ms)로
올렸다 -- product_scope 문면이 "3-way 칸"으로 좁았고, 2-way
(`RECLAIM_TRIALS`, 5000ms)·5-way(`FIVE_WAY_TRIALS`, 8000ms)는 같은
모양(자식별 고정 클럭)인데도 명시적으로 범위 밖(목록 + 근거 주석만,
`deviation_rule`)으로 남겨졌다(검토 3R "정보" 항목이 이 둘의 존속을
지적). 이 라운드는 그 범위를 2-way·5-way까지 넓혀 같은 상수를 쓴다 --
"결국 획득" 판정에서 시계 의존을 완전히 제거하지 않는 이유도 #358과
동일하다(폴링 루프 자체가 무한 대기가 되면 `busyRetryTimeoutMs`
기본값과의 상호작용이 복잡해진다). `wx` 배제 위반 0 단언과 전원 획득
단언은 그대로(단언 약화 아님).

### 15-3. P2-1 — P1-1 self-branch 단언의 타이밍 의존 제거

5R이 신설한 `selfBranchTrials >= 1` 단언(P2-b)은 C2를 C1보다 고정
15ms 늦게 띄우는 타이밍에 기댔다 -- C1이 느리게 스케줄되면(부하 등)
C2가 reclaim ticket #1을 먼저 잡아 C1의 `selfBranchHit`이 구조적으로
false가 될 수 있다(검토 3R 제자리 계측: trials 3→30, hit 83/90).
**수리**: C1의 자식 스크립트가 (이미 있던) 주입 지점(`lockReadCount
===2`, 자기 티켓 #1을 막 확인한 바로 다음)에서 지워지지 않는 신호
파일(`signalPath`)을 쓰게 하고, 바깥 시험은 **그 신호가 나타난 뒤에만**
C2를 띄운다 -- C2가 존재하지도 않는 동안 C1이 ticket #1을 독점하므로
경쟁 자체가 없어진다(순서 결정화). ⚠️**실측 함정(이 라운드에서 직접
겪음)**: 처음에는 신호 대신 reclaim ticket "파일 자체"가 디스크에
나타나길 폴링했는데, 주입이 없는 평범한 경로에서 그 파일의 생존
구간이 `waitMs:6`(〔직접〕) 수준으로 짧아 10ms 간격 외부 폴로는 5초를
기다려도 "전혀" 포착하지 못했다(티켓은 같은 동기 호출 안에서 만들어
지고 곧바로 재확인·삭제된다) -- 그래서 알고리즘이 지우지 않는 **전용
신호 파일**로 바꿨다. 단언도 `>=1`에서 `=== P1_DEADLOCK_TRIALS`(모든
회차)로 강화했다(단언 약화 아님 -- 순서가 결정적이므로 매 회차 반드시
탄다).

### 15-4. P2-2 — `stderrTail`을 `close`에서 확정한다(`exit` 아님)

검토 3R 지적: `spawnReclaimRaceChild`(§10b~§10b-2 전체가 공유)가
`exit` 이벤트에서 `stderrChunks`를 잘라 썼다 -- Node 문서상 `exit`는
자식의 stdio 스트림이 아직 열려 있는 상태에서도 먼저 올 수 있어
사망 직전 stderr가 늦게 도착하면 꼬리가 비거나 잘릴 수 있다. **수리**:
`close`(모든 stdio가 닫힌 "뒤"에만 오는 이벤트)에서 확정한다 -- 콜백
시그니처(`code, signal`)는 같다. ⚠️**정직 한계(〔못쟀다〕)**: 이 라운드
도 이 머신(Windows)에서 `exit` vs `close`의 실제 차이를 재현하지
못했다(큰 stderr 페이로드(5MB) 직후 즉시 종료하는 합성 시나리오로
10회씩 비교, 둘 다 손실 0) -- 검토 3R의 "로컬 5/5는 전문이 실렸다"와
같은 결과다. Linux CI의 실제 차이는 여전히 〔못쟀다〕. `close`로 바꾼
것은 "Node 문서가 명시하는 구조적으로 더 안전한 자리"로의 방어적
전환이다(관측된 버그의 수정이 아니라 잠재적 창을 구조적으로 닫는
수리).

### 15-5. 범위 밖(기록만)

- `process.kill(pid,0)`의 좀비 오판(§14-5 원인 후보 4) — 여전히 고치지
  않았다.
- PM 설계 (d) 불변식 재심 — `runner-lock.mjs`의 §7 판정 로직 변경은
  §13-9 수리(cleanupAfterReclaim 청소 대상 좁히기) 외에는 0이다.
- `exit` vs `close`의 Linux CI 실측 — 〔못쟀다〕, 다음 라이브 CI가 맡는다.

## 16. HYK-498 2R — P2-A 메시지 진단 · P2-B tmp 대가+정리 · 남은 고정 시계 3곳

(책임자 판정 2026-11-10 상신 P2-A(1143) = "B. 같은 브랜치에 2R 덧커밋" ·
범위 = 검토 1R §3 P2-A·P2-B·정보 1~2)

### 16-1. P2-A — 2-way·5-way 실패 메시지에 자식별 진단을 싣는다

**틈**: 3-way 칸(§10b, `THREE_WAY_TRIALS` 등 5개)의 "결국 획득" 실패
메시지는 `` `trial ${trial}: all 3 must eventually acquire -- ${JSON.
stringify(results)}` `` 모양으로 자식별 결과(`spawnReclaimRaceChild`가
이미 싣는 `stderrTail`·`exitCode`·`elapsedMs`, P2-2/§15-4 그대로)를
담는다. 그런데 2-way 칸(`RECLAIM_TRIALS`)과 5-way 칸(`FIVE_WAY_TRIALS`)
은 §15-2가 같은 `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`로 시계만
맞췄을 뿐, 메시지 자체는 각각 `"... (serialized)"` / `"all 5 must
eventually acquire"`로 사유가 0이었다 — CI가 이 둘에서 빨간 것을 보면
"어느 자식이 왜"를 로그만으로 알 길이 없다(3-way와 다른 대우를 받을
이유가 없다).

**수리**: 2-way는 `a`·`b`(두 `spawnReclaimRaceChild` 결과)를, 5-way는
이미 있던 `results` 배열을 그대로 `JSON.stringify`해 메시지에 싣는다 —
3-way와 정확히 같은 모양(새 필드 추가 없음, 포맷만 통일).

### 16-2. P2-B — 죽은 회수자의 tmp가 영구히 남는 대가, 그리고 보수적 정리

**대가(문서화)**: §15-1의 §13-9 수리는 "완성된(숫자만인 suffix) 티켓
이름만" 지우고 `.tmp.<suffix>` 이름은 **전부** 건드리지 않는다 — 다른
회수자의 진행 중 tmp를 지울 위험을 원천적으로 없애려는 의도적 선택
이었다. 그 대가: 회수자가 `createExclusive`의 `writeFileFn(tmpPath,
...)` 직후, `linkFn(tmpPath, path)` 전에 죽으면(크래시·OOM-kill·강제
종료 등) 그 tmp 이름은 **아무도 다시 지우지 않는다** — `createExclusive`
자신의 catch(링크 실패 시 자기 tmp를 지우는 코드, `runner-lock.mjs`
"§(d) createExclusive" 헤더 그대로)도 죽은 프로세스에서는 실행되지
않고, §13-9 수리 이후의 `cleanupAfterReclaim`도 `.tmp.` 이름을 전부
건너뛴다. 영향은 **디스크 공간 누수뿐**(바이트 몇백 수준의 JSON 파일,
`<L>.reclaim.<O>.<k>.tmp.<suffix>` 하나당) — 아무 코드도 그 이름을
다시 읽거나 참조하지 않으므로(§13-9 설계 논증 "이 lockId를 다시 참조할
길이 없으면 누수는 harmless하다"와 같은 근거) PM 설계 불변식("살아
있는 회수권자 ≤1" 등)에는 영향이 없다. 다만 이 lockPath 디렉터리가
장기간(수개월) 같은 자리에서 반복 경합하면 이런 이름이 누적될 수
있다(측정하지 않았다, 〔못쟀다〕).

**정리(넣음, `maybeCleanupDeadReclaimerTmp`)**: `cleanupAfterReclaim`이
이미 완성된 티켓을 지우는 그 디렉터리 스캔 루프 안에서, suffix가
`/^\d+\.tmp\./` 모양(즉 "이 lockId의 어떤 티켓 번호에 대한 tmp")인
이름만 추가로 살핀다 — 그 tmp의 내용(`createExclusive`가 link 전에
이미 전부 쓴 `{pid, procStart}`)을 읽어 `identityIsDead`(이미 있는
동일 판정 로직)로 "쓴 사람이 죽었는가"를 확인한 뒤에만 지운다. **왜
이것이 §13-9를 재도입하지 않는가**: 살아 있는 회수자의 진행 중 tmp는
`isPidAliveFn(그 pid)`가 반드시 `true`를 돌리므로 `identityIsDead`가
`dead:false`로 떨어져 **절대 지워지지 않는다** — "죽었다고 확정될
때만" 지우는 규칙이라 §13-9가 금지한 "살아 있는 다른 회수자의 진행
중 tmp를 지우는 규칙"이 아니다(변이 ⑤가 이 경계를 무너뜨리면 D2
"before-ticket-link" 칸이 정확히 §13-9와 같은 크래시로 되돌아가는
것을 실측으로 확인했다 — 아래 §0 변이표). 읽기/파싱이 실패하면(쓰는
도중을 보거나, 그 사이 다른 경로로 이미 지워진 경우) 모호한 쪽은
손대지 않는다(삭제하지 않음) — "확정 전에는 손대지 않는다"는 같은
원칙의 연장이다. 새 시험 2칸(P2-B ⑴·⑵, §10b-2 바로 뒤)이 production
`acquireRunnerLock` 진입점으로 "죽은 reclaimer의 tmp는 쓸린다" /
"살아 있는(자기 자신) reclaimer의 진행 중 tmp는 살아남는다"를 각각
확인한다.

**나이 기반을 쓰지 않은 이유**: 코더-task는 "나이 기반 또는 주인 사망
확정 시만"을 후보로 줬지만, 순수 나이 기반(예: "tmp가 N초보다 오래됐으면
지운다")은 극단적인 스케줄링 지연·GC 정지·디스크 스톨 아래서 **아직
살아 있는** 회수자의 진행 중 tmp를 지울 수 있다(확률은 낮아도 0이
아니다) — 이는 §13-9가 명시적으로 금지한 "살아 있는 다른 회수자의
진행 중 tmp를 지울 수 있는 규칙"에 해당해 채택하지 않았다. 신원 확정
기반은 이 가능성 자체를 0으로 만든다(핀 포인트: pid가 죽었으면 그
프로세스는 다시는 그 tmp를 link할 수 없다 — 모순 없음).

### 16-3. 정보 1~2 — 남은 고정 시계 3곳을 같은 "결국 완료" 모양으로

**P1-1 칸의 자식별 `"6000"`과 §10 `lockRaceChildScript`의
`timeoutMs: 15000`**: 둘 다 `acquireRunnerLock` 자신의 `timeoutMs`다 —
§15-2가 2-way·5-way에 준 처방과 정확히 같은 모양(자식별 고정 클럭으로
"결국 획득"을 판정)이라, 이 라운드가 똑같이
`GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`(20_000ms)로 올렸다. RED-first
〔직접〕 측정(이 라운드, 실제 분리 프로세스 홀더가 7000ms를 쥐고 있을
때): 고정 6000ms 대기자는 `{acquired:false, timedOut:true}`로
결정적으로 졌고, 20000ms로 올리자 같은 조건에서 `{acquired:true,
timedOut:false}`(elapsed≈7.5s)로 뒤집혔다(§0 답 참고) — 1R이 3-way
칸에서 겪은 것과 정확히 같은 모양의 증거다.

**`waitForFileToExist`의 `attempts=500,delayMs=10`(명목 5초)**: 이건
`acquireRunnerLock`이 아니라 P1-1 시험 자신의 신호-파일 폴링 상한이다
— 같은 "자식별 고정 클럭 + 결국 완료 판정" 모양이라 같은 상수를
쓴다(`attempts = GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS / 10`). RED-first
〔직접〕 측정: 신호 파일 쓰기를 9초 지연시키자(C1이 부하로 늦게
스케줄되는 것을 흉내) 명목 5초 상한(이 머신에서 실측 상한은 setTimeout/
이벤트 루프 오버헤드로 ~8.5초였다 — 명목값보다 이미 관대했다는 뜰
자체가 추가 증거) 쪽은 `ready:false`였고, 20초 상한 쪽은 `ready:true`
(elapsed≈9s)로 뒤집혔다(§0 답 참고).

**"결국 완료" 판정에서 시계 의존을 완전히 제거하지 않는 이유**는
§15-2와 동일(폴링 루프가 무한 대기가 되면 `busyRetryTimeoutMs`
기본값·`LOCK_WAIT_TIMEOUT_MS`와의 상호작용이 복잡해진다) — 상한만
넉넉히 늘렸다. `GENEROUS_EVENTUAL_ACQUIRE_TIMEOUT_MS`의 정의는 이
라운드가 시험 파일 앞쪽(`freshLockDir` 바로 아래)으로 옮겼다 — 세
자리 모두 하나의 정의를 공유한다.

### 16-4. 범위 밖(기록만)

- `.harness`/이 머신 밖 Linux CI에서의 실제 부하 모양 — 〔못쟀다〕,
  완료 조건은 라이브 CI 연속 3회 hyk494 빨강 0(ORCH-135 §3 `1b_reach_path`
  그대로).
- 디스크에 수개월 누적될 수 있는 죽은-reclaimer-tmp 개수의 실측 —
  〔못쟀다〕, §16-2의 "대가" 문단은 메커니즘과 상한 없는 가능성만
  기술한다.
