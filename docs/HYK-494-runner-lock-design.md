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
if k>0 and judge(권한 k 보유자)≠DEAD: wait                 # 이미 누가 회수 중
createExclusive(L.reclaim.<O.lockId>.<k+1>, {pid, procStart}) → EEXIST면 wait
if read(L).lockId == O.lockId: unlink L                     # 유일한 비주인 삭제 지점
best-effort unlink L.alive.<O.lockId>, L.reclaim.<O.lockId>.*  # L 삭제 "뒤"
```

**되돌림이 전혀 없다** — 2R의 "rename-steal → 비교 → 불일치면 link로
복원"을 완전히 버렸다. 한 번호(`k+1`)는 `link`로 정확히 1명만 얻으므로
"살아 있는 회수권자"는 O 하나당 언제나 1명 이하다. 표식이 고아가 되면
(회수권자가 죽으면) **지우지 않는다** — 다음 번호를 새로 만든다. 죽은
보유자는 되살아나지 않으므로 세대가 복제될 수 없다(2R의 "고정 이름
표식" 모양이 가진 두 주인 가능성이 구조적으로 없다). 늦게 만들어진
권한은 재확인에서 `L.lockId ≠ O.lockId`가 되어 아무것도 지우지 않는다
(L이 이미 다른 주인으로 넘어갔다는 뜻).

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
