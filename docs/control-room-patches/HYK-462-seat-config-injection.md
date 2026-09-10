# HYK-462 패치 문서 — 좌석 런처가 기동 «전»에 역할 훅·안전 키를 주입하고, 실패하면 좌석을 띄우지 않는다 (+ HYK-460 재정의 설계 + 모델 드리프트 수리)

★이 문서는 **제안**이다 — 적용은 사람 게이트 + S7 검토 뒤에 한다. 이 라운드는 관제실 라이브 파일을 고치지 않는다(coder-task.md §0 "관제실 «라이브» 파일에 손대지 마라").

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\orca-worker-seat.ps1` · **SHA-256 `58780A8B1F263DA0413CC8B7A016D270AD4D6038728575F85EA3DF5AF283BA5C`**(CODER 직접 `Get-FileHash` 재계산, 2026-09-10) · 줄 수 **43줄**(`Get-Content .Count` 실측) · 줄끝 **혼합**(36줄 CRLF · 7줄 LF — HYK-379 라운드가 삽입한 두 블록(주석 3줄+코드 1줄 × 2군데)이 LF로 삽입된 채 남아 있는 것이 원인, CODER가 `[regex]::Matches` 로 직접 실측·재현됨). fixture 사본 = `scripts/check/fixtures/control-room-orca-worker-seat-2026-09-10-hyk462-seat-config-injection-before.ps1.txt`(SHA-256 동일값으로 재확인됨).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫 · S7 검토 대상).

## 1. 무엇이 문제인가 (coder-task.md §1, 2026-09-10 실측 3건)

1. **1-A**: 역할 경계 훅(`role-guard.mjs`)을 켜는 `.claude/settings.local.json`은 git 전역 무시(`**/.claude/settings.local.json`) 때문에 **어떤 워크트리에도 절대 복사되지 않는다** — 파일은 있지만 아무도 부르지 않는다.
2. **1-C**: 워커 설정 폴더(`CLAUDE_CONFIG_DIR`)의 안전 키 2개(`remoteControlAtStartup`·`agentPushNotifEnabled`)가 원래 없었다 — ORCH가 임시로 손으로 넣어 둔 상태이며, 손 값은 언제든 지워질 수 있다.
3. **1-B(HYK-460)**: ORCH가 정본 런처를 쓰지 않고 손으로 좌석을 띄울 수 있다 — §3(설계)에서 다룬다.

## 2. 패치가 세우는 것 — 기동 전 주입 + fail-closed

`orca-worker-seat.ps1`이 이미 가진 `seat-preflight.mjs` fail-closed 관례(11행, exit≠0 이면 좌석을 안 띄운다)를 **그대로 재사용**해, 같은 자리 바로 다음에 **두 번째 게이트**를 추가한다: `scripts/check/seat-config-inject.mjs`(이 라운드가 새로 작성, coder-task.md §2-A). 이 게이트는

1. 그 워크트리의 `.claude/settings.local.json`에 role-guard PreToolUse 훅을 (없으면) 생성하고,
2. 워커 설정 폴더(`C:\Users\Administrator\.claude-team\settings.json`)의 두 안전 키를 (틀렸으면) 보정하고,
3. 둘 중 하나라도 실패하면 **exit 1** — 위 게이트가 exit≠0 을 그대로 `exit $LASTEXITCODE`로 넘겨 **좌석이 뜨지 않는다**.

### 왜 «복사»가 아니라 «생성»인가 (coder-task.md §2-A-1 설계 판단)

메인 저장소의 `.claude/settings.local.json`은 role-guard 말고도 `report-style-guard`·`linear-sync`·`controlroom-fresh`·`context-inject` 등 **ORCH 전용 자동화**를 함께 문다. 이걸 통째로 워크트리에 복사하면:

- 워커 좌석에 필요 없는 훅(예: `controlroom-fresh` — 관제실 프레시니스 검사는 ORCH 세션 책임)까지 실행되어 **워커의 책임 경계를 흐린다**(coder-task.md 자체가 이 조각의 계기로 삼은 "역할 경계"와 정면으로 배치).
- 메인 파일이 나중에 바뀌면(예: 새 ORCH 전용 훅 추가) **복사본도 매번 갱신해야 한다는 암묵 계약**이 생겨, 이 조각이 고치려는 "설정이 드리프트한다"는 문제를 다른 자리에서 재생산한다.

⇒ **`seat-config-inject.mjs`는 role-guard PreToolUse 훅 하나만 정확히 생성/병합**한다(기존에 그 워크트리에 다른 로컬 설정이 있으면 보존 — 덮어쓰지 않는다). 워커에 다른 훅이 필요해지면 그건 이 모듈이 명시적으로 새로 추가할 대상이지, 메인 파일을 통째로 복사해 암묵적으로 상속할 대상이 아니다.

### 안전 키 보정이 «생성»이 아니라 «수정»인 이유

`ensureSafetyKeys`는 대상 파일이 **존재하지 않으면 실패로 처리**한다(새로 만들지 않는다) — 워커 설정 폴더 자체가 없다는 것은 이 모듈이 고칠 수 있는 종류의 문제보다 훨씬 심각한 상태이고(coder-task.md §4 "네 좌석 설정을 스스로 바꾸지 마라"), 없는 걸 새로 지어내면 그 폴더의 다른 필수 설정(모델·statusLine 등, 위 §1-C 표 참조)까지 빈 값으로 만들어버릴 위험이 있다.

## 3. §패치 단위 (기계 추출 대상)

### 3-1. 게이트 삽입 (HYK-462 본체)

```control-room-patch-unit
id: hyk462-seat-config-inject-gate
mode: insert_after
@@ANCHOR@@
$global:LASTEXITCODE = 1; node scripts/check/seat-preflight.mjs; if ($LASTEXITCODE -ne 0) { Write-Host "[$Role seat] BLOCKED -- 훅 대조에 실패했습니다. 좌석을 띄우지 않습니다. 위에 뜬 «고치는 명령»을 실행한 뒤 다시 기동하십시오."; exit $LASTEXITCODE }
@@CONTENT@@

$global:LASTEXITCODE = 1; node scripts/check/seat-config-inject.mjs --role $Role --worktree $Worktree; if ($LASTEXITCODE -ne 0) { Write-Host "[$Role seat] BLOCKED -- 좌석 설정 주입(역할 훅·안전 키)에 실패했습니다(HYK-462). 좌석을 띄우지 않습니다."; exit $LASTEXITCODE }
@@END@@
```

### 3-2. HYK-460 관련 없음 — 이 문서는 3-3/3-4만 코드로 다룬다 (2-B는 §4 설계 절)

### 3-3. 모델 드리프트 수리 — 코드 (HYK-462 §2-C)

```control-room-patch-unit
id: hyk462-review-model-terra
mode: replace
@@ANCHOR@@
  $codexModel = if ($Role -eq "PM") { "gpt-5.6-sol" } else { "gpt-5.6-luna" }
@@CONTENT@@
  $codexModel = if ($Role -eq "PM") { "gpt-5.6-sol" } else { "gpt-5.6-terra" }
  $codexReasoningEffort = if ($Role -eq "PM") { "high" } else { "xhigh" }
@@END@@
```

### 3-4. 모델 드리프트 수리 — 코드 (reasoning_effort 플래그)

```control-room-patch-unit
id: hyk462-review-reasoning-effort-flag
mode: replace
@@ANCHOR@@
  codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false
@@CONTENT@@
  codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false -c reasoning_effort=$codexReasoningEffort
@@END@@
```

### 3-5. 모델 드리프트 수리 — 주석 (드리프트 이력을 지우지 않고 이어 적는다)

```control-room-patch-unit
id: hyk462-review-model-comment-fix
mode: replace
@@ANCHOR@@
  # REVIEW/PM = codex (CODER와 다른 엔진 원칙 유지). REVIEW=luna / PM=sol.
@@CONTENT@@
  # REVIEW/PM = codex (CODER와 다른 엔진 원칙 유지). REVIEW=terra / PM=sol.
@@END@@
```

```control-room-patch-unit
id: hyk462-review-model-comment-history
mode: replace
@@ANCHOR@@
  # 2026-08-28: 주석이 22일간 코드와 어긋나 있었다(주석 terra / 코드 luna). 정본 = relay-terminal-setup.md §1.5 ③(같은 날 luna 로 개정).
@@CONTENT@@
  # 2026-08-28: 주석이 22일간 코드와 어긋나 있었다(주석 terra / 코드 luna). 정본 = relay-terminal-setup.md §1.5 ③(같은 날 luna 로 개정).
  # HYK-462(2026-09-10): 2026-09-08 한용 확정으로 정본이 다시 terra 로 회귀했는데, 이 줄(코드)은 그 뒤로도 luna 로 13일 더 어긋나 있었다 -- 같은 종류의 무기록 드리프트가 재발했다(취소선 없이 이력만 이어 적는다, B-10 안전핀). 정본 = relay-terminal-setup.md §1.5(2026-09-08 갱신) -- `gpt-5.6-terra` + `reasoning_effort=xhigh`.
@@END@@
```

**왜 `reasoning_effort`를 위해 새 변수를 도입했는가(동작 변경 최소)**: `codex` 실행 줄은 REVIEW(`terra`)와 PM(`sol`) 두 역할이 공유한다. relay-terminal-setup.md §1.5는 REVIEW에 `xhigh`, PM에 `high`를 각각 다른 값으로 못 박는다(§1.5 500행 `codex -m gpt-5.6-sol -c reasoning_effort=high`) — 공유 줄에 값 하나를 그냥 얹으면 PM 쪽 정본을 임의로 바꾸는 범위 확대가 된다. `$codexModel`이 이미 역할별 삼항식으로 쪼개져 있으므로 그 옆에 같은 모양의 `$codexReasoningEffort` 변수를 하나 더 두는 것이 기존 관례와 가장 가깝다.

## 4. §설계 — `HYK-460`: 손으로 띄우는 것을 «기계로» 막을 수 있는가 (coder-task.md §2-B, 필수)

⛔**정직**: ORCH는 `orca terminal create --command "<아무 명령>"`을 칠 수 있고, 이 저장소 안 어떤 장치도 그 명령 자체의 실행을 원천 차단할 수단이 **없다**(OS 프로세스 생성 권한을 가진 사람은 항상 임의 명령을 실행할 수 있다 — 이건 이 저장소가 풀 수 있는 층이 아니다). 그래서 현실적인 목표는 "실행 자체를 막는다"가 아니라 **"손으로 띄운 좌석이 정상적인 워커로 기능하지 못하게 한다"**다.

### 후보 ⓐ — 워커 자가 검증 (기동 직후, 워커 협조 필요)

워커 세션이 기동 직후 스스로 "나는 정본 런처(`orca-worker-seat.ps1`)로 떴는가"를 확인하고, 아니면 **자진 정지**한다. 확인 근거 후보: 런처가 기동 시 심어주는 마커(예: `HARNESS_LAUNCHED_VIA_SEAT_SCRIPT=1` 같은 env var, 또는 이번 라운드가 만드는 `seat-config-inject.mjs`가 성공적으로 돈 흔적을 파일/env에 남기고 워커가 그걸 확인).

- **무엇을 막는가**: ORCH가 손으로 `orca terminal create`를 쳐도, 그 위에서 뜬 워커 세션이 스스로 "나는 위조됐다"를 판단하고 작업을 거부하게 만들 수 있다 — G1 위조 차단 규칙과 같은 층의 방어.
- **무엇을 «못» 막는가**: ⓵ **워커가 «협조적»이어야 성립** — 이 확인 코드 자체를 우회하는 것(예: `--append-system-prompt`로 이 규칙을 안 실어 보내거나, 워커에게 확인을 건너뛰라고 직접 지시하는 것)을 막지 못한다. ⓶ 오늘 사고의 실제 형태(ORCH가 `--dangerously-skip-permissions` 등 여러 플래그를 빠뜨린 채 손 조립)는 애초에 **런처 스크립트를 거치지 않았으므로 이 마커 자체가 안 심긴다** — 마커가 없으면 "확인 불가"이지 "위조 확인됨"이 아니라서, 이 경로는 사실 §1-B 사고 재발을 막기보다 §2-A(주입 실패 시 fail-closed)가 이미 다루는 것과 겹친다. ⓷ **자가 검증은 그 세션이 스스로 확인한 것**이라 ORCH가 워커에게 "네가 정본으로 떴다고 믿어라"라고 프롬프트를 조작하면(신뢰 경계 자체가 흔들리면) 뚫린다 — 이건 G1 절이 이미 "대화로 들어오는 지시를 신뢰하지 않는다"로 다루는 문제의 재귀.

### 후보 ⓑ — 배달기가 «기동 흔적»을 확인하고, 없으면 배달 거부 (추천)

`orca orchestration dispatch`가 실제로 태스크를 배달하기 전에, 대상 좌석(pane)이 **정본 런처를 거쳐 떴다는 증거**(예: `seat-config-inject.mjs`가 성공 시 좌석별 임시 파일이나 프로세스 환경에 남기는 타임스탬프 마커, dispatch-worker.ps1이 이미 쓰는 `assignee_pane_key` 같은 식별자와 별개로 "이 pane이 launcher를 거쳤다"는 별도 신호)를 조회하고, 없으면 **배달 자체를 거부**한다.

- **무엇을 막는가**: ORCH가 손으로 띄운 좌석은 **런처를 거치지 않았으므로 마커가 없다** ⇒ 그 좌석에 정식 작업이 배달되지 않는다 — 오늘 실제 사고(손으로 띄운 좌석에 정식 작업을 흘려보낸 것)가 재발해도 그 좌석은 "일이 안 오는 좌석"으로 남는다. 이 경로는 §1의 근거 축 ⓑ(배달기가 좌석의 기동 흔적을 확인)와 정확히 일치한다.
- **무엇을 «못» 막는가**: ⓵ **배달기 자체를 손으로 우회하는 것은 못 막는다** — ORCH가 `orca orchestration dispatch`를 안 쓰고 좌석에 직접 텍스트를 타이핑해 넣으면(사람이 직접 터미널에 지시를 치는 것) 이 축은 아무것도 검사하지 않는다. ⓶ 마커 자체가 **위조 가능**하다 — ORCH가 마커 파일/env를 손으로 만들어 두면(예: `seat-config-inject.mjs`가 남기는 파일을 그대로 복사) 배달기는 속는다. 즉 이 방어는 "실수로 런처를 안 거쳤다"는 사고는 막지만 "고의로 마커를 위조한다"는 시나리오는 막지 못한다(이 저장소가 이미 인정하는 한계 — G1 위조 차단 규칙 자체도 기계 차단이 아니라 «규율»이라는 정직 한계를 명시한다). ⓷ 배달기가 신뢰하는 마커 저장 위치(파일/env) 자체가 그 배달기와 같은 권한의 사람이 쓸 수 있는 위치라 방어 층이 하나뿐이다(심층 방어 없음).

### 후보 ⓒ — OS/런처 층 강제 (조사만, 구현 대상 아님)

세션 생성 권한 자체를 OS 수준에서 제한하는 것(예: 워커 세션이 도는 사용자 계정과 ORCH가 도는 계정을 분리하고, ORCH 계정에는 `orca terminal create`를 실행할 권한을 아예 주지 않는 것)은 원리적으로 가장 강한 차단이지만, 이 저장소·이 라운드가 건드릴 수 있는 층이 아니다(OS 계정 분리는 배포/운영 인프라 결정이고, coder-task.md 범위 밖 — §4 "네 좌석 설정·권한 모드를 스스로 바꾸지 마라"와 같은 이유로 이 CODER가 실측·구현할 수 없다). 한계만 적어 둔다: 계정을 분리해도 **같은 계정으로 로그인한 사람은 여전히 손으로 뭐든 칠 수 있다** — 결국 "권한을 가진 사람의 규율"이라는 바닥짐은 어느 후보에서도 완전히 사라지지 않는다.

### 추천 = 후보 ⓑ (+ 구현은 마커 존재 확인 유틸리티까지, 배달기 배선은 이 라운드 밖)

⛔**«ORCH가 규율을 지키면 된다»는 답이 아니다**라는 지시를 지키기 위해, 이 추천은 "배달기가 기계로 확인 가능한 신호"를 만든다: `seat-config-inject.mjs`가 성공적으로 끝나면(§2) `<worktree>/.harness/.seat-launch-marker.json`에 `{ launchedAt, role, viaScript: "orca-worker-seat.ps1", injectVersion }`을 남긴다(이 라운드가 구현). ★**이 라운드는 마커를 «쓰는» 부분까지만 구현한다** — dispatch-worker.ps1이 그 마커를 조회해 배달을 거부하는 배선은 §시험에서 합성으로만 검증하고, 실제 `dispatch-worker.ps1` 패치는 별도 라운드(HYK-460 후속)로 남긴다(⛔coder-task.md §2-B "구현은 추천 1개만" — 마커 생성 자체가 그 추천의 최소 구현 단위이고, 배달기 쪽 소비자는 다른 라이브 파일(`dispatch-worker.ps1`)을 패치하는 별도 패치 단위·별도 검토가 필요해 이 문서의 범위를 넘는다).

## 5. §정직 — 이 패치가 «못» 하는 것

- **후보 ⓑ가 못 막는 것**(위 §4 ⓑ 항목 그대로): 배달기 자체를 우회한 손 조작, 마커 위조. 이 문서는 그 두 구멍을 닫지 않는다.
- **좌석 설정 주입은 «해당 좌석 이번 기동 1회»만 보장한다** — 좌석이 뜬 뒤 누군가 `.claude/settings.local.json`이나 워커 설정 파일을 손으로 다시 바꾸면(예: 다음 프롬프트에서), 이 패치는 그 이후의 드리프트를 감지하지 않는다(다음 기동에서만 재보정).
- **role-guard가 막는 것은 «파일 쓰기 툴 호출»뿐**이다 — Bash로 같은 파일을 건드리는 경로(예: `Bash("echo x > .harness/review.md")`)는 role-guard의 매처(`Edit|Write|MultiEdit|NotebookEdit`)에 없어 이 패치가 막지 않는다(role-guard.mjs 자체의 기존 범위, 이 라운드가 넓히지 않음 — 범위 확대 금지).
- **라이브 드리프트 감시 없음**(HYK-378/HYK-422 선례와 동일 한계): 아래 §시험은 저장소 안의 문서·fixture만 본다. 관제실의 살아 있는 `orca-worker-seat.ps1`이 나중에 바뀌어도 이 시험은 그 사실을 모른다.
- **CI 는 리눅스 + Node 20, 이 CODER는 윈도우 + Node 26에서 돈다** — 로컬 초록은 "이 환경에서 통과했다"까지만 주장한다. CI도 초록일 것이라고 이 문서는 주장하지 않는다.
- **`reasoning_effort=$codexReasoningEffort`가 실제로 codex CLI에 먹히는지는 문자열 계약까지만 확인**했다(§시험 참고) — HYK-379 선례가 `codex doctor --all`로 `check_for_update_on_startup`을 실측 확인한 것과 달리, `codex doctor`에는 `reasoning_effort`를 되비추는 진단 필드가 없어(이 라운드가 `codex doctor --all` 출력에서 직접 확인) 그 값이 실제로 codex 내부 추론 강도를 바꾸는지는 이 라운드가 재확인하지 못했다 — 공식 CLI 플래그 문서(`-c <key>=<value>`가 임의 config override라는 것)에 대한 신뢰다.

## 6. §적용 절차

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 diff를 눈으로 확인** → SHA-256 3자 대조(원본/적용본/라이브) → 라이브 교체.
3. 합성 표적으로 1회 구동해 "설정 주입 실패 시 좌석이 안 뜨는지" 확인(⛔실제 배달로 시험하지 않는다 — 아래 §시험이 이미 이걸 자동화).
4. 되돌림 = 원본 SHA-256 사본 보관(위 §헤더의 해시, 추가로 fixture가 원본 전체를 바이트 동일 보존).

## 7. §시험 — 무엇을 어떻게 고정했는가

- `scripts/check/hyk462-seat-config-injection.test.mjs` — `seat-config-inject.mjs`의 단위/CLI 행동(양성·음성·역할 훅 실효) 15개.
- `scripts/check/control-room-patch-apply-hyk462-collect.test.mjs` — 이 문서의 5개 단위가 before-fixture에 적용되어 applied-fixture와 바이트 동일함을 고정 + 되돌림 변이 2종(앵커 훼손 → `ANCHOR_NOT_FOUND`, CONTENT 삭제 → 바이트 불일치).
- `scripts/check/control-room-patch-apply-hyk462-effect.test.mjs` — 적용본 텍스트가 실제로 (a) 새 게이트 줄을 포함하는지, (b) `gpt-5.6-terra`+`reasoning_effort=xhigh` 문자열 계약을 지키는지, (c) `seat-config-inject.mjs`를 실제로 구동해 실패 시 게이트가 `exit $LASTEXITCODE`로 좌석을 막는 pwsh 동작까지 실측.
