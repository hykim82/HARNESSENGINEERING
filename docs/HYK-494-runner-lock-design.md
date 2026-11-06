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

`runner-lock.mjs`의 `defaultRunnerLockPath()`는 `os.tmpdir()/harness-
isolated-suite-runner.lock`을 기본값으로 쓴다.

- **저장소 밖**: 이 머신의 모든 워크트리가 같은 경로를 봐야 상호 배제가
  성립한다. 저장소 안의(워크트리마다 다른) 경로는 애초에 이 문제를 풀 수
  없다.
- **`os.tmpdir()` 아래**: 이 머신의 모든 사용자 세션/워크트리가 공유하는
  디렉터리이고, 추가 설정(관제실 경로 등) 없이 항상 존재한다. 관제실
  경로(`D:\문서관리\하네스-관제실\`)를 저장소 코드에 박지 말라는 지시서
  `env_rule`/`live_watch_rule`과도 별개로, 이 모듈은 관제실의 존재를 전혀
  모른다 — 순수하게 "이 머신에 하나"라는 사실만 쓴다.
- **고정 이름**: 매 실행 다른 이름이면 "머신 전체에 하나"가 깨진다.
- **경로 seam**: `isolated-suite-runner.mjs`의 `runIsolatedSuite`는
  `lockPath` 파라미터로 이 기본값을 덮어쓸 수 있다 — 모든 시험(기존
  15+개 · 새 20개)은 합성(mkdtemp) 경로 또는 완전 스텁을 쓴다("Synthetic
  lock paths only", 배달 지시).

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

`runner-receipt-writer.mjs`의 `buildRunnerReceipt`는 다음 6개 칸을
**추가**한다(기존 칸 이름·의미·순서는 바이트 단위로 그대로):

| 칸                      | 의미                                          |
| ----------------------- | --------------------------------------------- |
| `lock_path`             | 이 실행이 겨냥한 잠금 파일 경로               |
| `lock_wait_ms`          | 획득까지 실제로 기다린 ms(0 = 경쟁 없이 즉시) |
| `lock_poll_count`       | 폴링 횟수                                     |
| `lock_reclaimed_orphan` | 이 실행이 고아 잠금을 회수했는가              |
| `lock_nested`           | 중첩 우회로 통과했는가(파일을 건드리지 않음)  |
| `lock_timed_out`        | 상한을 넘겨 포기했는가                        |

소비 게이트(HYK-411/HYK-485, `relay-handshake.mjs`)가 이 새 칸들을
아는지 grep으로 확인했다(§1 사전 확인) — `runner_exit`/`head_commit` 등
**기존** 필드만 읽고, `schema_version`도 비교하지 않는다(기존 코멘트:
"그 쪽은 이 receipt의 schema_version 값을 전혀 비교하지 않는다"). 모르는
새 칸은 단순히 무시된다 — 판정에 영향 없음.

## 7. 고아 회수 — 죽은 pid만, 살아있을 수 있으면 기다린다

`isOrphan`은 잠금 파일의 `pid`에 `process.kill(pid, 0)`(신호를 실제로
보내지 않고 존재/권한만 검사 — Node 공식 동작, POSIX·Windows 모두)을
던져본다. `ESRCH`(또는 그 대응)면 죽었다고 보고 회수(`unlinkSync` 후
즉시 재시도), 그 외(예: 권한 때문에 존재는 확인되지만 신호는 못 보내는
경우)는 "존재한다"로 보아 **기다린다**(섣부른 회수보다 안전).

### 7-1. ⚠️정직 한계 — pid 재사용

이 신호는 "죽은 pid"는 명확히 잡는다(ESRCH는 모호하지 않다). 반대 방향
— 그 pid가 이미 **다른, 전혀 무관한 새 프로세스**에게 재사용되어
"살아있다"로 보이는 경우 — 는 이 신호만으로 구분할 수 없다. 그 경우
이 함수는 "아직 누가 쥐고 있다"로 오판해 상한까지 기다리게 만들 뿐이다
(안전 쪽 오차) — 두 실행이 동시에 들어가는 사고(이 모듈이 막아야 하는
바로 그것)로는 이어지지 않는다. `startedAtMs`를 잠금 내용에 남기는
근거도 여기 있다: 진짜 pid 재사용을 더 정밀하게 가르고 싶어질 미래
라운드가 "그 pid가 그 시각에 실제로 떴는가"를 추가로 대조할 수 있는
재료를 남겨 둔다(이번 라운드는 그 대조 자체를 구현하지 않는다 — 범위
밖).

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

### 8-3. 해법 — env 신호

`NESTED_LOCK_BYPASS_ENV_VAR`(`HARNESS_RUNNER_LOCK_HELD_BY`). 바깥
프로세스가 잠금을 쥐면(`guardLockForRun`) 자기 `process.env`에 이 값을
심는다(해제 시 지운다). `spawnSuiteInClone`은 이미 자식 `env`를
`{...process.env, ...}`로 구성하므로, 이 값은 클론 안 `node --test`
자식에게 자동으로 전파되고, 그 자식이 추가로 띄우는 `spawnSync` 호출이
`env`를 명시하지 않으면(이 저장소의 `runCli`가 그렇다) Node는 **그
자식의** `process.env`(이미 이 값을 물려받음)를 상속한다 — 몇 단계를
거치든 체인이 끊기지 않는다. `acquireRunnerLock`은 이 env 값이 있으면
**파일을 전혀 건드리지 않고** 즉시 `{acquired:true, nested:true}`를
돌려준다(§ⓒ⑷ 시험).

## 9. 해제 — 자기 잠금만, 정상·예외·신호에서

`releaseRunnerLock`은 파일 내용의 `pid`가 호출자 자신의 `pid`와 일치할
때만 지운다. `isolated-suite-runner.mjs`의 `runIsolatedSuite`는
`try { ... } finally { release(); }`로 정상 반환과 모든 예외(클론 실패,
spawn 실패 등) 둘 다에서 해제를 보장한다. SIGINT/SIGTERM은
`installLockReleaseOnSignal`(`runner-lock.mjs`)이 별도로 건다.

### 9-1. ⚠️정직 한계 — 신호 타이밍

이 파일의 호출 그래프는 전부 동기 차단(`spawnSync`/`Atomics.wait`)이다.
Node는 블로킹 시스템 콜이 반환되기 전까지 신호 핸들러를 포함한 어떤 JS도
실행할 수 없다 — 그래서 이 핸들러는 "이벤트 루프가 다시 돌 수 있는 틈"
(블로킹 호출 사이)에 도착한 신호만 즉시 처리한다. 블로킹 호출 **도중**
도착한 신호는 그 호출이 반환된 뒤에야 처리된다(OS가 신호 자체를 들고
있다가 전달 — 잃어버리지는 않는다, 즉시성이 없을 뿐).

## 10. CI(Linux, 단일 러너) 동작 — 무변

CI는 한 번에 한 러너만 돈다 — 잠금은 항상 비어 있는 상태에서 즉시
획득되고 즉시 해제된다(`waitMs:0`). `os.tmpdir()`(Linux에서는 보통
`/tmp`)는 항상 쓰기 가능하므로 §3의 "쓰기 불가 → 예외" 분기도 실제로는
트리거되지 않는다 — 판정 계약(tests 총수 · fail 0 · head 일치 ·
full-2x)은 한 글자도 바뀌지 않는다.

## 11. 정직 한계 (요약, ⛔지시서 §4 필수 3줄 포함)

1. **이 잠금은 이 러너 진입점(`isolated-suite-runner.mjs`)만 덮는다** —
   다른 러너 진입점(`full-sweep-local.mjs` 등)이나 수동 `node --test`
   호출은 막지 않는다(범위 밖, §2 `deviation_rule`).
2. **머신 공용 경로라 다른 사용자·권한 경계에서는 보장이 없다** — 서로
   다른 OS 사용자 계정이 `os.tmpdir()`의 서로 다른 하위 경로를 보거나,
   한쪽이 그 경로에 쓸 권한이 없으면 상호 배제가 성립하지 않는다.
3. **라이브 실물 = 다음 병렬 레인 2개 라운드다** — 이 라운드는 합성
   (mkdtemp) 잠금 경로로 두 "실제" 자식 프로세스를 띄워 직렬화를
   증명했고(§ⓒ⑴), 자기 자신의 전건 러너를 2회 돌려 잠금이 실제로
   잡히고 풀리는지 영수증으로 확인했다(§3 완료 조건 3) — 하지만 "서로
   다른 두 워크트리의 진짜 전건 러너 2개가 동시에 시작해도 겹치지
   않는다"는 그 다음 실물 라운드가 확인해야 할 사실이다.
4. pid 재사용 오판(§7-1), 신호 타이밍(§9-1) — 위에서 각각 서술.
5. **Windows만 실측했다** — Linux CI의 `process.kill(pid, 0)` 동작은
   Node 문서상 동일하게 명시돼 있으나 이 라운드에서 직접 재현하지는
   않았다(〔추론〕).
