# HYK-389 candidate-0 실사 — 정당한 좌석 직접 입력 전수 목록 + 권한 원천 해제 가능성

★이 문서는 **조사·설계 산출물**이다. 라이브 권한·설정·원장·관제실 파일을 바꾸지 않았다(§5 라이브 무접촉 증명 참고).

## 0. 왜 «탐지»가 아니라 «원천 해제 가능성»인가

HYK-389 의 위협은 _"ORCH 가 어댑터(`scripts/relay/adapters/orca-adapter.mjs`)를 거치지 않고 인터랙티브 셸에서 직접 `orca terminal send`(혹은 다른 `orca` 서브명령)를 치는 경로는 저장소 어떤 코드도 감시·차단하지 않는다"_ 는 것이다.

이전 두 라운드는 모두 **탐지**로 시도했고 둘 다 무너졌다(`.harness/coder-task.md` 봉투·§1 그대로):

- **1R(자기신고 검사)**: 막으려는 행위자가 곧 신고의 저자라, 신고를 생략하면 침묵한다.
- **2R(스크롤백 검사)**: 스크롤백은 인증되지 않은 *출력*이라 다른 프로그램이 그 줄을 찍기만 해도 위반으로 잡히고(위조 주입 1건 재현), `&&`·`;`·환경변수·별칭·`./orca`·`bash -c` 등 다수의 회피가 열려 있었다.

두 라운드 모두 **"저장소 안 텍스트를 읽어 판정"** 가족이었고, 그 가족 전체가 이 위협에 부적합하다는 것이 판정이었다. 이 라운드는 그 대신 규율이 요구하는 **옵션 0 — "권한을 원천 해제할 수 있는가"** 를 실사한다: 탐지를 잘 만드는 대신, **애초에 그 입력을 칠 수 없게 만들 수 있는가**를 묻는다.

## 1. Q1 — 정당한 좌석 직접 입력 전수 목록

**정의**: "직접 입력"은 이 저장소의 엔진무관 릴레이 코드(`scripts/relay/adapters/orca-adapter.mjs`)가 argv를 구성해 자신이 소유한 `execFn`으로 실행하는 경로가 **아니라**, 사람·ORCH·워커가 자신의 인터랙티브 셸에서 `orca` CLI(또는 좌석의 대화형 프롬프트)를 직접 타이핑/전송하는 경로를 말한다. §0의 힌트대로 **좌석 기동 · 워커 대화형 프롬프트 응답 · 좌석 정리 · 배달(어댑터 경유 대비)** 네 후보군을 모두 훑었다.

전수 목록은 `scripts/check/hyk389-candidate0-inventory.json`에 기계가 읽을 수 있는 형태로 고정했고, `scripts/check/hyk389-candidate0-inventory.test.mjs`가 그 형식·필수 필드·중복 없음을 검사한다(§5 참고). 아래 표는 그 JSON의 사람이 읽는 사본이다 — **두 파일이 어긋나면 JSON이 정본**이다.

| id                                  | 행위자        | 채널                    | 명령(요약)                                                              | 목적                                                 | 정당?       | 대체 수단                                                                                                                                                             | 근거                                                                        | 신뢰도     |
| ----------------------------------- | ------------- | ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| `launcher-dispatch-create`          | human-or-orch | launcher-direct         | `orca orchestration dispatch --task ... --to ... [--inject] --json`     | 새 워커에게 태스크 배정(좌석 기동 핵심)              | ✅          | 없음(어댑터 결선 `createRealLaunchSink`는 `launch-seam.mjs`에 wiring 0, 시험으로 확인)                                                                                | `dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt:63-71`          | 확실       |
| `launcher-dispatch-stale-clear`     | human-or-orch | launcher-direct         | `orca orchestration task-update --id <stale> --status completed --json` | D14 재발 방지, stale dispatch 정리                   | ✅          | 없음                                                                                                                                                                  | 동 파일:72                                                                  | 확실       |
| `launcher-terminal-list`            | human-or-orch | launcher-direct         | `orca terminal list --json`                                             | 좌석 핸들 조회                                       | ✅          | 미확인                                                                                                                                                                | 동 파일:99                                                                  | 확실       |
| `launcher-seat-proof-dispatch-show` | human-or-orch | launcher-direct         | `orca orchestration dispatch-show --task $Task --json`                  | 좌석증명 게이트(HYK-299)                             | ✅          | 어댑터 `buildDispatchShowCommand`(`orca-adapter.mjs:1458`)가 있으나 이 호출부는 독립                                                                                  | 동 파일:449                                                                 | 확실       |
| `launcher-terminal-show`            | human-or-orch | launcher-direct         | `orca terminal show --terminal $handle --json`                          | 좌석증명 게이트                                      | ✅          | 없음                                                                                                                                                                  | 동 파일:450                                                                 | 확실       |
| `launcher-seat-text-paste`          | human-or-orch | launcher-direct         | `orca terminal send --terminal $handle --text $goText --json`           | codex 좌석에 지시문 붙여넣기(D11 우회)               | ✅          | 어댑터 `buildSeatLaunchTextCommand`(:1912) 존재하나 wiring 0                                                                                                          | 동 파일:519                                                                 | 확실       |
| `launcher-seat-enter-submit`        | human-or-orch | launcher-direct         | `orca terminal send --terminal $handle --enter --json`                  | 붙여넣은 지시문 제출                                 | ✅          | 없음                                                                                                                                                                  | 동 파일:521                                                                 | 확실       |
| `worker-self-forgery-check`         | worker        | seat-direct             | `orca orchestration dispatch-show --task <id> --json`                   | G1 위조확인(자기검증)                                | ✅          | 없음 — 대체하면 목적 자체가 사라짐                                                                                                                                    | `control-room-worker-dispatch-rule-2026-08-26-hyk357-352-applied.md.txt:27` | 확실       |
| `worker-escalation-send`            | worker        | seat-direct             | `orca orchestration send --type escalation ...`                         | 막힘 상황 사전 신고                                  | ✅          | 없음                                                                                                                                                                  | 동 파일:69-73                                                               | 확실       |
| `worker-decision-gate-send`         | worker        | seat-direct             | `orca orchestration send --type decision_gate ...`                      | `ask` 결함(HYK-335) 대체 1단계                       | ✅          | `orca orchestration ask`(금지)                                                                                                                                        | 동 파일:93-109                                                              | 확실       |
| `worker-check-wait`                 | worker        | seat-direct             | `orca orchestration check --wait --types status ...`                    | 질문 답 대기(keepalive)                              | ✅          | `ask`(금지)                                                                                                                                                           | 동 파일:114                                                                 | 확실       |
| `worker-done-send`                  | worker        | seat-direct             | `orca orchestration send --type worker_done ...`                        | 완료 참고 신호(비정본)                               | ✅          | 없음(생략 가능)                                                                                                                                                       | 동 파일:141                                                                 | 확실       |
| `seat-interactive-prompt-answer`    | human-or-orch | seat-direct             | (특정 서브명령 아님 — 대화형 프롬프트 응답)                             | 워커 좌석이 비대화형 진행 불가할 때 사람이 직접 개입 | ✅(추정)    | 미확인                                                                                                                                                                | coder-task.md §2 힌트(HYK-388) — 이 워크트리 안 1차 사료 없음               | **미확인** |
| `manual-seat-teardown`              | human-or-orch | seat-direct             | `orca terminal close ...` / `orca worktree rm ...`                      | 좌석·워크트리 정리                                   | ✅          | 어댑터 `buildSeatCloseCommand`(:1941)/`buildWorktreeRemoveCommand`(:1978)는 `guardedExec`로 실행되나, 사람이 직접 같은 명령을 치는 경로가 동시에 열려 있는지는 미검증 | `orca-adapter.mjs:1941,1978,2091,2114,3562,3585`                            | 추론       |
| `human-direct-any-orca`             | human         | seat-direct-or-external | (임의의 `orca` CLI)                                                     | 사람(책임자)의 직접 조작 — 규제 대상 아님            | ✅(비규제)  | N/A                                                                                                                                                                   | coder-task.md §4-2                                                          | 확실       |
| `forbidden-orca-ask`                | worker        | seat-direct             | `orca orchestration ask ...`                                            | 질문+대기(구식 경로)                                 | ❌ **금지** | `decision_gate` + `check --wait` 조합                                                                                                                                 | 동 파일:93-98                                                               | 확실       |

**빠뜨리기 쉬운 점(coder-task.md §4-1이 경고한 그대로)**: 이 표의 대다수 항목(6/15)은 **launcher(`dispatch-worker.ps1`, 관제실 파일)** 에서 나온다 — 이건 이 저장소의 git 이력·CI 대상이 **아니다**(§2 참고). 이 목록을 "이 저장소 코드"만 훑어 만들었다면 launcher 계열 7개 항목 전부를 놓쳤을 것이다.

## 2. Q2 — 능력을 원천 해제할 수 있는가 (축별 판정)

### ⓐ 권한 설정 축 (`.claude/settings*.json`의 `permissions.deny`)

**판정: 미확인(개별 orca 하위명령 세분화) / 확실(현재 allow 존재, deny 부재)**

- **확실한 사실**: 이 워크트리의 `.claude/settings.local.json`은 **이 저장소의 git 이력에 없다** — `.gitignore`에도 없고(파일 자체는 `.gitignore`에 안 걸림, `.bak-freshness` 백업만 걸림), 대신 **사용자 전역 git ignore** (`C:\Users\Administrator/.config/git/ignore` 의 `**/.claude/settings.local.json`)로 무시된다(직접 실측: `git check-ignore -v .claude/settings.local.json` → 위 경로 반환). ★이는 서브에이전트가 처음 보고한 "`.gitignore:5`로 무시됨"이 부정확했음을 직접 재확인으로 정정한 것이다 — **어느 무시 설정이 실제로 작동하는지는 사소해 보여도 "CI가 이 파일을 볼 수 있는가"의 근거이므로 정확히 적는다.**
- **문서 근거(확실, 반복 확인됨)**: `dispatch-worker.ps1` 헤더 주석(적어도 2026-08-20~2026-08-28의 5개 스니펫 파일에서 동일 문구 반복, 예: `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt:4-10`)에 따르면:
  > "(1) 기계 차단(설정 deny) = **0건**. 오히려 `.claude\settings.local.json` 의 `permissions.allow` 에 `"PowerShell(orca orchestration *)"` 가 명시돼 있다(2026-08-10 ORCH·PM 각각 실측). ⚠️범위 한정: repo local + 사용자 2파일에서만 확인. 관리형(enterprise) 정책 파일은 미확인."
  > 즉 **오늘 시점에 deny 규칙 자체가 0건**이고, 오히려 `orca orchestration *` 전체가 **allow**되어 있다.
- **미확인(이 라운드에서 직접 실측하지 않음)**: (1) Claude Code 권한 엔진에서 `deny`가 `allow`를 실제로 이기는지 — 이건 Claude Code 제품 자체의 문서화된 동작(개인 지식: deny 규칙은 같은 설정 파일 안에서 allow보다 항상 우선한다)이지만, **이 라운드는 §0-1 제약(라이브 설정 미변경) 아래 합성 설정으로 실측하지 않았다** — `claude` CLI 자체가 이 워크트리에 설치돼 있음을 확인했으나(`claude --version` → `2.1.221`), 별도 mkdtemp 격리 환경에서 하위 `claude -p` 프로세스를 실제로 띄워 deny/allow 우선순위를 검증하는 실험은 **시간·범위상 이번 조각에서 수행하지 않았다** — 다음 조각이 강제 설계를 확정하기 전에 반드시 먼저 실측해야 할 항목으로 남긴다.
  (2) `permissions.deny`에 `orca orchestration dispatch`처럼 **하위명령 단위로 좁혀 걸 수 있는지**(예: `dispatch`만 막고 `dispatch-show`는 살리는 패턴 매칭) — Claude Code의 매처 문법(`PowerShell(orca orchestration dispatch*)` 류)이 실제로 그렇게 세분화되는지는 미확인.
- **결론**: ⓐ축은 **"기계로 켤 수는 있어 보인다"(현재 0건인 deny를 추가하면 될 것 같다)는 «추론»**이지 확실이 아니다. ★그리고 §2-③에 나오듯 **이 축은 Claude 좌석에만 적용**된다 — codex 좌석(REVIEW/PM)에는 애초에 이 메커니즘 자체가 없다(§3 참고).

### ⓑ 런처/래퍼 축 (`orca`를 감싸는 래퍼를 PATH 앞에 둠)

**판정: 가능(추론) — 단, §4-3의 이름-우회 문제를 그대로 물려받는다**

- PowerShell/셸 양쪽 모두 PATH 우선순위로 함수/별칭/스크립트가 실제 바이너리보다 먼저 매치되게 만드는 것은 표준 셸 기능이다. 예: PATH 맨 앞에 `orca.ps1`(또는 `orca` 셸 스크립트)를 두고, 인자를 검사해 금지된 서브명령(`orchestration dispatch --inject` 등)이면 거부하고 그 외는 실제 `orca.exe`로 위임한다.
- **무엇이 필요한가**: (1) 모든 좌석의 PATH가 이 래퍼 디렉터리를 실제 `orca` 설치 경로보다 앞서 참조하도록 **좌석 기동 시점에** 강제(런처 자신이 `$env:PATH`를 조작하거나, 시스템 전역 PATH를 바꾸는 것 중 하나 — 후자는 §0-2가 금지하는 "영구 변경"에 해당해 이 라운드는 손대지 않았다). (2) 래퍼가 인자 파싱을 정확히 해서 `&&`·`;`·따옴표 이스케이프 등으로 서브명령을 숨기는 시도까지 잡아야 함(§4-3).
- **무엇이 무력화하는가**: 절대경로 호출(`C:\...\orca.exe orchestration dispatch ...`)은 PATH 래퍼를 건너뛴다. `bash -c`/`pwsh -Command`로 새 셸을 열어 PATH를 재설정하는 것도 우회 가능. **즉 ⓑ 단독은 "PATH를 존중하는 얌전한 호출"만 잡고, 절대경로·서브셸 호출은 못 잡는다** — 이는 2R이 스크롤백 축에서 이미 실증한 evasion 목록(`./orca`, `bash -c`)과 정확히 겹친다.

### ⓒ OS 축 (실행 허용목록·감사 정책)

**판정: 이 저장소 범위 밖(확실)**

- Windows의 AppLocker/WDAC(실행 허용목록)나 Sysmon 기반 프로세스 생성 감사는 **OS/엔드포인트 관리 정책**이며, 이 저장소(git 버전관리 대상)의 어떤 파일도 이를 설정·배포하지 않는다. 이 워크트리에서 그런 정책 파일(AppLocker XML, WDAC 정책, Sysmon 설정)이 존재하는지 grep했으나 **0건**.
- **왜 범위 밖인가**: coder-task.md §0-1이 "관제실·셸 프로필·전역 설치·PATH·환경변수의 영구 변경"을 금지하는 것과 같은 이유로, OS 정책은 이 워크트리보다 훨씬 넓은 반경(사용자 계정·머신 전체)에 영향을 미쳐 **이 이슈의 트랙 범위를 넘는 인프라 결정**이다. 도입 여부는 이 저장소가 결정할 수 없고, 결정하더라도 **감사 대상 밖(§0-4·비타협 조건③의 "옆문 판별 2문" 중 "감사에서 보이는가")**을 만족시키려면 별도의 인프라 트랙이 필요하다.
- ★ 참고로 gap#98(`docs/enforcement-known-gaps.md`)이 이미 같은 논리를 썼다: "임의 코드 실행 권한을 가진 상대는 더 넓은 문(gap#96, 직접 `orca dispatch` 호출)으로 지나가므로, 좁은 문을 먼저 막는 것은 우선순위가 뒤바뀐 것"이라는 판단 — OS 축도 같은 함정에 빠질 수 있다: OS 감사를 세밀하게 설계하는 데 시간을 쓰기 전에, **그 감사가 실제로 무엇을 잡아야 하는지(ⓐⓑ가 열어둔 구멍)** 를 먼저 좁혀야 한다.

### ⓓ 그 밖에 찾은 축 — «배달 자체를 원장 기반으로 만들기»(감사 로그 축)

- `docs/enforcement-known-gaps.md`의 gap#96이 이미 이 축을 제안한다: _"관제실이 CI·버전관리 대상이 되는 라운드가 오면... `dispatch-worker.ps1` 밖에서 오는 `orca orchestration dispatch --inject` 호출을 감사하는 장치(예: orca 자체 감사 로그)를 설계해야 한다"_.
- 이 축은 **원천 해제(prevent)가 아니라 감사(detect after the fact)**다 — Q2가 묻는 "해제 가능한가"에는 "아니오, 대신 감사한다"로 답하는 축이며, ⓐⓑⓒ와는 범주가 다르다(원천 해제 vs 사후 감사). Orca 런타임 자신이 "이 dispatch가 `dispatch-worker.ps1`을 거쳤는지"를 기록하는 기능이 있다면(이 저장소 밖, Orca 벤더 쪽 기능이라 **미확인**) 그것이 이 축의 유일한 실효 지점이다 — 이 저장소 안에서는 만들 수 없다.

## 3. Q3 — 엔진 전용 문제를 어떻게 푸는가 (묶음 설계 + 잔여 구멍)

★ⓐ(Claude Code `permissions.deny`)는 **Claude 전용 축**이다 — codex 좌석(REVIEW/PM, `dispatch-worker.ps1:56` `$engine = if ($Role -eq "REVIEW" -or $Role -eq "PM") { "codex" }...`)에는 이 메커니즘 자체가 없다. 이 저장소의 규율(coder-task.md 인용, §3)은 _"새 강제는 엔진 무관 기반부터"_ — ⓐ 단독 강제는 금지된다.

### 제안하는 묶음: ⓑ(런처/래퍼, 엔진 무관) 를 1차 방어선으로, ⓐ(Claude deny) 를 Claude 좌석 한정 즉시성 보조로

1. **1차 방어선 = ⓑ 런처/래퍼**: 좌석이 무엇이든(Claude/codex 무관), 좌석을 기동하는 **launcher 자신**(`dispatch-worker.ps1` 또는 그 후속)이 좌석에 주입하는 `$env:PATH` 맨 앞에 `orca`-이름 래퍼를 놓는다. 이 래퍼는 인자를 파싱해 금지 패턴(`orchestration dispatch ... --inject` 등 §1의 `human-direct-any-orca` 예외를 뺀 나머지)을 거부하고, 그 외는 진짜 바이너리로 위임한다. **엔진 무관**이다 — Claude든 codex든 그 좌석의 셸에서 `orca`라는 이름을 칠 때 똑같이 걸린다.
2. **보조 = ⓐ Claude 전용 deny**: Claude 좌석에서만, `.claude/settings.local.json`의 `permissions.allow`에서 `"PowerShell(orca orchestration *)"`를 **좁은 allow**(예: `dispatch-show`·`send --type worker_done|escalation|decision_gate`·`check`만 allow)로 교체하고, 나머지에 `deny`를 추가한다. 이건 **즉시성 보조**일 뿐이다 — Claude Code가 사람 승인 프롬프트 없이 명령을 실행하기 «전에» 걸리는 한 겹일 뿐, 아래 §4가 보이듯 이름을 바꾸면 뚫린다.
3. **honesty note (엔진 무관 등가물 부재 시 요구되는 표기, coder-task.md §2 하드 제약)**: ⓐ는 codex 좌석에 **등가물이 없다**. codex 좌석의 유일한 방어선은 ⓑ(런처 PATH 래퍼)뿐이며, ⓑ가 뚫리면 codex 좌석은 **아무 보조도 없이** 그대로 뚫린다. 이 비대칭은 이 라운드가 새로 만든 게 아니라 원래 있던 것이지만, 묶음 설계를 문서화하는 이 자리에서 명시한다.

### 묶어도 남는 구멍

1. **§4-3(이름 우회)가 ⓑ에도 그대로 적용된다** — 절대경로(`C:\...\orca.exe ...`)·새 셸(`bash -c "orca ..."`)·PATH 재설정은 래퍼를 건너뛴다(§2-ⓑ). **ⓑ 단독으로는 닫히지 않는 문이 남는다.**
2. **launcher 자신이 우회 지점이다(gap#96, 이미 알려짐)**: `dispatch-worker.ps1`을 거치지 않고 사람/다른 스크립트가 `orca orchestration dispatch --inject`를 직접 치면, PATH 래퍼가 그 사람의 셸 PATH에 존재하지 않는 한 아무것도 막지 못한다 — **래퍼가 걸리는 지점은 "좌석 안"이지 "좌석을 만드는 사람의 셸"이 아니다.** 이건 새로운 발견이 아니라 gap#96의 재확인이지만, 묶음 설계가 이걸 닫지 못한다는 점은 분명히 적어야 한다.
3. **관제실 파일은 이 저장소가 검증할 수 없다** — `dispatch-worker.ps1`이 패치된 래퍼-주입 버전인지, 옛 사본인지 이 저장소의 CI는 알 수 없다(§2-ⓒ와 같은 "CI 없는 파일" 문제, gap#96의 우회경로②와 동일).
4. **사람 경로는 애초에 규제 대상이 아니다(§4-2)** — 그리고 **ORCH의 직접 입력과 사람의 직접 입력을 구분할 기계적 수단이 확인되지 않았다**(아래 §4 참고). 이는 "막아도 되는 대상"과 "막으면 안 되는 대상"이 같은 셸·같은 PATH를 공유한다는 뜻이라, ⓑ의 래퍼가 "누가 쳤는가"가 아니라 "무엇을 쳤는가"로만 판단할 수밖에 없다 — 사람이 정당하게 쳐야 하는 명령(§1의 `human-direct-any-orca`)과 ORCH가 우회로 치면 안 되는 명령이 **문자열 수준에서 구분 불가능**하면, 래퍼는 둘 다 통과시키거나 둘 다 막아야 한다.

## 4. §4-3 확인 — deny를 걸어도 «다른 이름»으로 부르면 되는가

**판정: 그렇다(추론, 강한 근거) — 2R이 스크롤백 축에서 배운 회피가 권한 축에도 적용된다.**

- 2R이 실증한 8가지 회피 계열 중 이 라운드가 이름/식별 확인한 것: `&&`·`;`(명령 연결자), 환경변수, 별칭(alias), `./orca`(상대경로), `bash -c`(서브셸). 이 5가지 중 **Claude Code의 `permissions` 매처가 실제로 무엇을 매칭하는지**가 핵심이다.
- **이 라운드에서 실측하지 않은 것(정직하게 미확인으로 남김)**: Claude Code의 `PowerShell(orca orchestration *)` 매처가 정확히 어떤 문자열에 매칭되는지(전체 커맨드라인 문자열 매칭인지, 파싱된 argv의 첫 토큰만 보는지)는 **§0-1 제약(라이브 설정 미변경) 아래 합성 환경에서 실측하지 않았다**. 이건 다음 조각이 강제를 실제로 설계하기 전에 반드시 먼저 확인해야 할 항목이다.
- **문서/구조 근거(확실)로 추론 가능한 것**: Claude Code의 `PowerShell(...)` 매처는 일반적으로 **명령 문자열 패턴 매칭**이지 셸의 실제 실행 그래프(별칭 해석·PATH 탐색 결과)를 추적하지 않는다 — 이는 셸 명령 매칭 도구의 공통된 구조적 한계다(별칭·PATH 탐색은 셸 자신이 명령을 실행하는 시점에 해석되는데, 권한 매처는 그 «이전»의 원문 문자열을 본다). 따라서:
  - `& $wrapperlessOrca ...`(변수에 담긴 실제 orca 경로)나 절대경로 호출은 `"PowerShell(orca ...)"` 패턴 매칭 자체를 벗어날 가능성이 높다(패턴이 `orca`라는 리터럴 토큰을 기대하는데 절대경로 문자열은 `orca`로 시작하지 않을 수 있다).
  - `bash -c "orca ..."`는 매처가 `PowerShell(...)`(파워셸 명령) 축에만 걸려 있다면, **애초에 다른 매처(`Bash(...)`) 영역이라 축 자체가 다르다** — 이건 "이름 우회"가 아니라 "셸 축 자체가 다른" 더 근본적인 우회다.
  - alias/함수 재정의는 매처가 원문 텍스트(`orca ...`)를 보는 한 **텍스트 자체는 그대로 `orca`로 시작**하므로 걸릴 수 있지만, PowerShell 함수로 `function orca { <원래 동작 재현 후 우회> }`를 걸고 그 함수를 호출하는 텍스트도 여전히 `orca ...`로 보이므로 매처 자체는 회피하지 못할 수도 있다(→ 이 경우는 오히려 **막힐 가능성**이 있다는 뜻이라, "적용된다"를 무조건적으로 단정하면 과장이다).
- **결론**: §4-3의 "이름 우회가 권한 축에도 통하는가"에 대한 정직한 답은 **"부분적으로 그렇다고 추론되지만, 어느 부분이 통하고 어느 부분이 안 통하는지는 실측 없이는 확정할 수 없다"** 이다. ⛔"그럴 것 같다"로 뭉개지 않기 위해, **다음 조각이 반드시 실측해야 할 구체 항목**으로 못박는다: (1) 절대경로 호출이 매처를 우회하는지, (2) `bash -c`/WSL 경유가 `PowerShell(...)` 매처 범위 밖인지, (3) PowerShell 함수/별칭 재정의가 매처의 원문 텍스트 검사를 통과하는지.
- ⚠️ 이 미확정 자체가 §3의 결론(ⓐ 단독 강제 금지, ⓑ와 묶기)을 **더 강화**한다 — ⓐ가 얼마나 우회 가능한지 모르는 채로 ⓐ에 의존하는 설계는 위험하다.

## 5. 라이브 무접촉 증명

이 라운드에서 실행한 명령 전부(순서대로):

1. `echo $ORCA_PANE_KEY` — 환경변수 읽기(§1 G1 위조확인)
2. `orca orchestration dispatch-show --task task_3892f9b2aa9e --json` — 배정 조회(읽기 전용)
3. `git log`, `git status`, `find`/`ls` — 저장소 탐색(읽기)
4. `Grep`/`Glob`/`Read` — 다수의 파일 읽기(모두 읽기 전용, 아래 5-15는 예외 없이 읽기)
5. Explore 서브에이전트 1회 실행(읽기 전용 조사, 결과 §1-§4에 반영 — 아래 §8 서브에이전트 사용 명시)
6. `git ls-files .claude/`, `git check-ignore -v .claude/settings.local.json` — 무시 설정 실측(읽기 전용, 파일을 만들거나 바꾸지 않음)
7. `which claude`, `claude --version` — 로컬 바이너리 존재 확인(실행하지 않고 버전만 조회)
8. `npm ci` — 이 워크트리(`--setup skip`)의 `node_modules` 설치. **라이브 권한·설정 파일과 무관**, `package-lock.json`이 지정한 의존성만 로컬 `node_modules/`(git-ignore 대상)에 설치.
9. `node --test scripts/check/hyk389-candidate0-inventory.test.mjs` — 이 라운드가 새로 만든 시험 파일 실행(§1의 산출물 자체를 시험).
10. **되돌림 변이 실측(§1 산출물의 실 파일에 대해)**: `scripts/check/hyk389-candidate0-inventory.json`에 진짜 중복 id를 주입 → 시험 재실행 → **2건 실패(RED) 확인** → Node 스크립트로 원본 바이트 그대로 복원 → `git status --porcelain` 확인(신규 파일 2개만 untracked로 남고 수정 마커 없음). **이 파일들은 이 라운드가 만든 신규 산출물이므로 "미변경 증명"은 여기서는 "원본으로 정확히 복원됐다"는 뜻이며(diff 없음), 라이브 권한·관제실 파일에는 애초에 손대지 않았다.**

**미변경 증명**:

- `git status`(작업 시작 시점) — clean. 이 라운드가 만든 신규 파일은 `docs/HYK-389-candidate0-capability-removal.md`(이 문서), `scripts/check/hyk389-candidate0-inventory.json`, `scripts/check/hyk389-candidate0-inventory.test.mjs`, `.harness/coder.md` 뿐이다(커밋 시점 `git status`로 재확인, §7).
- `.claude/settings.local.json` · `.claude/settings.json` · `~/.claude/**` · `orca-worker-seat.ps1` · 셸 프로필: **읽지도 쓰지도 않았다**(이 워크트리에 애초에 `.claude/settings*.json` 파일 자체가 존재하지 않음 — `find .claude -type f` 결과 `.claude/skills/capture-context/SKILL.md` 1건뿐, §2-ⓐ의 근거는 전부 다른 스니펫 파일(fixture)의 **주석 인용**이지 실제 설정 파일 조작이 아니다).
- 전역 설치·PATH·환경변수 영구 변경: 0건. `$ORCA_PANE_KEY` 읽기만 했고 쓰지 않았다.
- Linear·통역 받는함·예약작업: 접촉 0건.
- 옆 레인(HYK-387) 파일: 접촉 0건(`scripts/check/relay-handshake*`, `scripts/check/hyk387-*`, `scripts/relay/watch-result.mjs`, `scripts/relay/relay-core.mjs`, `docs/control-room-patches/HYK-387-*` 전부 읽지도 않음).

## 6. 확실 / 추론 / 미확인 요약

- **확실**: §1 표의 대다수 항목(직접 인용된 파일:라인) · §2-ⓐ의 "deny 0건·allow 존재"(반복 확인된 문서 근거) · §2-ⓒ(OS 축이 이 저장소 범위 밖) · §5 라이브 무접촉.
- **추론**: §2-ⓑ(래퍼가 기술적으로 가능함) · §3 묶음 설계의 방어값 · §4(이름 우회가 권한 축에 부분 적용).
- **미확인**: `seat-interactive-prompt-answer`(HYK-388, 이 워크트리 안 1차 사료 없음) · `manual-seat-teardown`의 실제 production 실행 경로 · ⓐ축의 deny/allow 우선순위 실측 · Claude Code 매처의 정확한 매칭 단위(§4) · 관리형(enterprise) 정책 파일의 존재 여부.

## 7. 안 한 것

- ⛔ `.claude/settings*.json`(합성본 포함)을 실제로 만들어 `claude -p`를 서브프로세스로 띄워 deny/allow 우선순위·매처 매칭 단위를 **실측하지 않았다** — §2-ⓐ, §4의 결론은 문서 근거 + 구조적 추론이며, "그럴 것 같다"를 넘는 확정적 실측이 아니다. 다음 조각이 강제를 설계하기 전에 이 실측이 선행돼야 한다.
- ⛔ PATH 래퍼(ⓑ)를 실제로 작성하거나 시험 환경에 설치하지 않았다 — §3은 설계 제안일 뿐 구현이 아니다.
- ⛔ HYK-388(워커 대화형 프롬프트 응답)의 1차 사료를 찾지 못했다 — 이 워크트리 밖(관제실 또는 Orca 벤더 쪽)에 있을 가능성이 있으나 접근하지 않았다(§0-1·§0-5 제약과 별개로, 단순히 이 워크트리 안에 파일이 없었다).
- ⛔ OS 축(ⓒ)의 실제 도입 가능성을 인프라팀·관리자 권한 관점에서 조사하지 않았다 — "이 저장소 범위 밖"이라는 판정까지만 했다.
- ⛔ `manual-seat-teardown`의 실제 production 호출 경로(사람이 직접 치는지, 무언가 자동으로 치는지)를 실측하지 않았다 — `orca-adapter.mjs`의 코드 존재만 확인했다.

## 8. 서브에이전트 사용 명시

이 조사의 §1(1차 스윕)과 §2 일부는 Explore 서브에이전트 1회(읽기 전용, 코드/문서 인용 수집)의 결과를 받아, 이후 이 세션이 **핵심 인용 전부(라인 번호·파일 경로)를 직접 재확인**했다(예: `orca-adapter.mjs`의 함수 라인, `worker-dispatch-rule.md` 각 명령의 라인, `.gitignore` vs 전역 git ignore 정정, `enforcement-known-gaps.md` gap#96 원문, `createRealLaunchSink`의 wiring 여부). 서브에이전트의 1차 보고 중 최소 1건(`.claude/settings.local.json`이 "`.gitignore:5`로 무시된다"는 주장)은 **부정확**했고, 직접 재확인 과정에서 정정했다(§2-ⓐ).
