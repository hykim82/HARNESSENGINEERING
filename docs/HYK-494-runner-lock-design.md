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

`acquireRunnerLock`의 `tryClaim`은 `writeFileSync(lockPath, content, {
flag: "wx" })`로 잠금을 잡는다 — POSIX의 `O_CREAT|O_EXCL`, Windows의
`CreateFile CREATE_NEW`에 해당하며 양쪽 모두 원자적이다(이 저장소의
`allocateRunSlot`이 run 번호 슬롯 경쟁을 막는 데 쓰는 것과 같은 1차
근거). 내용은 `{ pid, startedAtMs, worktree, head }`(JSON) — 누가, 언제,
어느 워크트리/HEAD에서 쥐고 있는지 사람이 읽을 수 있는 진단 정보다.

`EEXIST`는 "누가 이미 쥐고 있다"는 정상적인 경쟁 신호로 받고(허수아비
처리), 그 **외의** 쓰기 실패(`ENOENT`: 디렉터리 부재, `EACCES` 등)는
**그대로 던진다** — 삼키면 "상호 배제를 보장하는 척하면서 실제로는 보장
못 하는" 상태(이 모듈이 막으려는 사고의 재판)가 되기 때문이다. 결과적으로
그런 환경에서는 전체 러너가 LOCK_TIMEOUT이 아니라 예외로 실패한다(초록
으로 접히지 않는다는 요구는 어느 쪽이든 만족).

## 4. 대기 — 이름 붙은 상수 + 근거

- `LOCK_POLL_INTERVAL_MS = 1000`(1초): 이 저장소의 전건 러너는 수십 초~
  분 단위(실측 ~623초)로 걸린다 — 더 촘촘한 폴링은 CPU만 태우고 체감
  대기를 줄이지 못한다.
- `LOCK_WAIT_TIMEOUT_MS = 20분`: 실측된 가장 긴 전건 러너(~10.4분)의 약
  2배 — 정상적인 선행 실행을 기다리는 데는 충분하고, 진짜로 걸린(교착·
  매우 느린 머신) 경우를 무한정 기다리지 않는 바깥 울타리다.

둘 다 `acquireRunnerLock`의 파라미터로 오버라이드 가능(시험은 둘 다 ms
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

| 칸                               | 의미                                           | 라운드 |
| -------------------------------- | ---------------------------------------------- | ------ |
| `lock_path`                      | 이 실행이 겨냥한 잠금 파일 경로                | 1R     |
| `lock_wait_ms`                   | 획득까지 실제로 기다린 ms(0 = 경쟁 없이 즉시)  | 1R     |
| `lock_poll_count`                | 폴링 횟수                                      | 1R     |
| `lock_reclaimed_orphan`          | 이 실행이 고아 잠금을 회수했는가               | 1R     |
| `lock_nested`                    | 중첩 우회로 통과했는가(파일을 건드리지 않음)   | 1R     |
| `lock_timed_out`                 | 상한을 넘겨 포기했는가                         | 1R     |
| `lock_wait_start_ms`             | 대기를 "시작"한 epoch ms                       | 2R     |
| `lock_wait_end_ms`               | 대기를 "끝낸"(획득/타임아웃) epoch ms          | 2R     |
| `lock_prior_owner_pid`           | 마지막으로 읽을 수 있었던 앞 소유자의 pid      | 2R     |
| `lock_prior_owner_started_at_ms` | 앞 소유자의 시작 시각                          | 2R     |
| `lock_prior_owner_worktree`      | 앞 소유자의 워크트리                           | 2R     |
| `lock_nested_bypass_rejected`    | 우회 마커가 있었지만 토큰이 안 맞아 거부됐는가 | 2R     |

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

## 7. 고아 회수 — 죽은 pid, 또는 heartbeat가 멈춘 pid

`isOrphan`은 두 축을 OR로 본다:

1. **pid**: 잠금 파일의 `pid`에 `process.kill(pid, 0)`(신호를 실제로
   보내지 않고 존재/권한만 검사 — Node 공식 동작, POSIX·Windows 모두)을
   던져본다. `ESRCH`(또는 그 대응)면 죽었다 → 고아.
2. **heartbeat**(2R 신설, §7-2): pid가 살아 있어도, 잠금 내용의
   `aliveAtMs`가 `HEARTBEAT_STALE_MS`보다 오래 멈춰 있으면 → 고아.
   `aliveAtMs`가 없는(구버전/합성 fixture) 내용은 이 축을 건너뛴다 —
   pid만으로 판단(1R 칸 무회귀).

고아로 판단되면 **무조건 지우지 않는다** — §7-3의 "비교 후 삭제"로
회수한다. 그 외(예: 권한 때문에 존재는 확인되지만 신호는 못 보내는
경우, 또는 heartbeat가 아직 신선한 경우)는 "살아있다"로 보아
**기다린다**(섣부른 회수보다 안전).

### 7-1. ⚠️정직 한계 — pid 재사용

이 신호는 "죽은 pid"는 명확히 잡는다(ESRCH는 모호하지 않다). 반대 방향
— 그 pid가 이미 **다른, 전혀 무관한 새 프로세스**에게 재사용되어
"살아있다"로 보이는 경우 — 는 pid 신호만으로는 구분할 수 없었다(1R의
한계). **2R은 §7-2 heartbeat로 이 틈을 메운다**: 진짜 주인이 죽는 순간
heartbeat 사이드카도 같은 사실을 알아채고(§12, 자기 자신의 tick에서
주인 pid를 확인) 더는 `aliveAtMs`를 갱신하지 않으며, 그 pid가 "나중에"
무관한 새 프로세스에 재사용돼도 이미 멈춰 버린 `aliveAtMs`는 바뀌지
않는다 — staleness 검사가 그 사실을 그대로 본다. `startedAtMs`를
잠금 내용에 남기는 근거도 여전히 같다(미래의 더 정밀한 대조 재료).

### 7-2. ⚠️정직 한계 — heartbeat 기한 안에 주인이 죽으면 그만큼은 기다린다

heartbeat는 staleness를 **더 빨리** 드러내는 보강일 뿐, 즉시성을
보장하지 않는다 — 주인이 `aliveAtMs`를 갱신한 바로 다음 순간 죽으면,
다른 호출자들은 `HEARTBEAT_STALE_MS`(기본 90초, §4 이름 붙은 상수)가
다 지나야 그 사실을 "고아"로 본다. 이 간격은 `LOCK_WAIT_TIMEOUT_MS`
(20분)보다 훨씬 작게 고른 것이 바로 이 한계를 실용적인 크기로 줄이기
위한 선택이다(§4).

### 7-3. 비교 후 삭제 — `tryReclaimOrphan`의 원자성 근거

1R은 "읽고 → 판단 → 무조건 `unlinkSync`"였다(REVIEW-1R P1-1: 동시
회수자가 같은 고아를 둘 다 "회수"하고 둘 다 겹쳐 돌았다, 10회 중 7회
완전 겹침). 2R은 다음 순서로 바꾼다:

1. `renameSync(lockPath, tempPath)` — **원자적 "훔치기"**: 같은 원본
   경로를 두고 경쟁하는 모든 호출 중 정확히 하나만 성공한다(파일시스템이
   보장하는 디렉터리 엔트리의 원자적 test-and-set). 성공한 쪽은 "그 순간
   그 경로에 있던 내용"을 배타적으로 손에 넣는다 — 더는 그 누구도 같은
   내용을 또 훔칠 수 없다.
2. 옮긴 내용을 읽어, 우리가 애초에 고아라고 판단했던 그 내용(pid ·
   startedAtMs · lockId)과 비교한다.
3. **같으면** 삭제(진짜 그 죽은 주인이었다) — `reclaimed:true`.
4. **다르면** — 우리가 읽은 뒤 rename하기 전 사이에 누군가 새로
   잠금을 잡았다는 뜻. 그 새 주인의 것을 지우면 안 되므로
   `linkSync(tempPath, lockPath)`로 되돌린다. `linkSync`(하드링크)를
   쓰는 이유: 그 이름이 **비어 있을 때만** 성공하고(원자적), 이미 누가
   또 새로 잡았으면 `EEXIST`로 실패한다 — 그 경우 **아무것도 하지
   않는다**(세 번째 진입자의 몫을 덮어쓰지 않는다). 리뷰의 원래 힌트
   ("되돌릴 때도 rename")는 복원하는 그 순간 세 번째 진입자의 몫을
   rename으로 덮어쓸 수 있는 구멍이 있어(rename은 목적지가 있어도
   덮어쓴다), 이 라운드가 `link`로 강화했다.
5. 어느 쪽이든 `tempPath`는 치운다(best-effort).

### 7-4. 읽기 실패 ≠ 고아 (REVIEW-1R P1-1 둘째 발견)

`readLockContentResult`가 실패(ENOENT · 파싱 실패 · 빈/손상 내용)하면
`{ok:false}`를 돌려주고, 호출자는 이를 **"바쁘다"로만** 본다 — 고아
판정 자체를 건너뛴다(`unlinkFn`을 전혀 안 부른다, 단위 시험으로 고정).
1R은 `!content -> true`(읽기 실패 = 고아)였고, 그 경로로 "방금 막 잡힌
새 주인의 잠금"을 지운 사고가 있었다(3자 경합 50회 중 3회). 2R은 그
가능성 자체를 없앤다 — 다음 바퀴의 `tryClaim`이 "파일이 진짜 사라졌는가"
를 스스로 판단한다.

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

## 9. 해제 — 자기 잠금만, 정상·예외·신호에서

`releaseRunnerLock`은 파일 내용의 `pid`가 호출자 자신의 `pid`와 일치할
때만 지운다. `isolated-suite-runner.mjs`의 `runIsolatedSuite`는
`try { ... } finally { release(); }`로 정상 반환과 모든 예외(클론 실패,
spawn 실패 등) 둘 다에서 해제를 보장한다. SIGINT/SIGTERM은
`installLockReleaseOnSignal`(`runner-lock.mjs`)이 별도로 건다. 2R부터는
이 `release()`가 heartbeat 사이드카(§12)도 함께 멈춘다 — 잠금은 풀렸는데
사이드카만 살아남아 남의(다음 주인의) 잠금을 계속 갱신하는 사고를
막는다.

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

## 12. HYK-494 2R 선택 ① — heartbeat 사이드카

`startLockHeartbeat`는 **별도 프로세스**(`-e` 인라인 스크립트, 이 파일의
`FREE_MEM_SAMPLER_SCRIPT`/`node-concurrency-sampler.mjs`와 같은
"in-process 타이머 아님" 근거 — 이 잠금을 쥔 프로세스는 실행 내내
`spawnSync`/`Atomics.wait`로 동기 차단돼 있어 같은 프로세스 안의
`setInterval`은 그 블로킹 "도중"에는 돌 수 없다, §9-1과 같은 제약)로
`isolated-suite-runner.mjs`의 `guardLockForRun`이 **실제로 잠금을 쥔
직후에만**(`nested`가 아닐 때만) 시작한다.

- **간격·기한**: `HEARTBEAT_INTERVAL_MS`(30초) — 이 저장소 전건 러너
  최장 실측(~623초)보다 훨씬 촘촘해서 정상 실행 내내 여러 번(약 20회)
  갱신한다. `HEARTBEAT_STALE_MS`(90초, 간격의 3배) — 한 번의 tick이
  일시적으로 늦어도 바로 orphan으로 오판하지 않을 여유를 주면서도,
  `LOCK_WAIT_TIMEOUT_MS`(20분)보다 훨씬 작아 pid 재사용/신호사망
  상황에서 다른 러너들이 20분을 다 기다리지 않게 한다.
- **자기 종료 조건**: 사이드카 자신이 매 tick "주인 pid가 아직
  살아 있는가"를 확인한다 — 죽었으면 더는 갱신하지 않고 스스로
  멈춘다(그 이후로 `aliveAtMs`가 "멈춘다" — pid가 나중에 재사용돼도
  바뀌지 않는다, §7-1). 또한 잠금 파일의 `lockId`가 자기 토큰과 더는
  맞지 않으면(이미 풀려서 다른 주인이 새로 잡은 경우) 역시 멈춘다 —
  남의 잠금을 갱신하지 않는다.
- **인프라 실패는 측정 불가로 격하**: 스폰 자체가 실패해도 조용히
  no-op 핸들을 돌려준다(startConcurrencySampler/startFreeMemSampler와
  같은 자세) — heartbeat가 없어도 잠금 자체의 상호 배제(§3 wx 배타
  생성)는 깨지지 않는다, 다만 pid 재사용 보강(§7-1)만 못 받는다.
- **기본은 OFF**: 이 저장소의 ~90개 이상 기존/다른 `runIsolatedSuite`
  호출 전부가 `startHeartbeatFn`을 언급하지 않는다 — 기본값이 실제
  사이드카였다면 그 모두가 진짜 자식 프로세스를 띄웠을 것이다.
  `useAutoConcurrency`와 같은 패턴으로, 이 파일 자신의 CLI 진입점
  (`runIsolatedSuiteCli`)만 실제(`startLockHeartbeat`)를 켠다.

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
   (mkdtemp) 잠금 경로로 두세 "실제" 자식 프로세스를 띄워 직렬화와
   비교-후-삭제의 안전성을 증명했고(§ⓒ⑴, §10b), 자기 자신의 전건
   러너를 2회 돌려 잠금이 실제로 잡히고 풀리는지 영수증으로 확인했다
   (§3 완료 조건 3) — 하지만 "서로 다른 두 워크트리의 진짜 전건 러너
   2개가 동시에 시작해도 겹치지 않는다"는 그 다음 실물 라운드가
   확인해야 할 사실이다.
4. pid 재사용 오판(§7-1, 2R에서 heartbeat로 보강했지만 완전히 없어지진
   않음), 신호 타이밍(§9-1) — 위에서 각각 서술. ⚠️**2R 추가**:
   **heartbeat 기한 안에 주인이 죽으면 그만큼은 기다린다**(§7-2) —
   즉시성은 보장하지 않는다.
5. **Windows만 실측했다** — Linux CI의 `process.kill(pid, 0)` 동작은
   Node 문서상 동일하게 명시돼 있으나 이 라운드에서 직접 재현하지는
   않았다(〔추론〕).
6. **2R도 전수 조사가 아니다** — §10b의 real-child-process 시험은
   유한 표본(10·15회)이다. 0회 위반을 봤다는 것은 "이 머신, 이 시각,
   이 표본수에서" 사실이지 전칭 증명이 아니다(universal_claim_discipline).
