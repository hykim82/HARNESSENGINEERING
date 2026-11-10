# HYK-153-engine-profile — 런처·배달기·memory-gate 를 엔진 프로필 CLI로 (제안 문면, 미적용)

★이 문서는 **제안**이다 — 적용은 사람이 한다. 이 라운드는 관제실 파일을
직접 고치지 않았다(⛔하드 제약, coder-task.md §2 deviation_rule) — 아래는
저장소 안에 새로 만든 `scripts/check/engine-profiles.json` +
`scripts/check/engine-profile.mjs` + `scripts/check/engine-profile-cli.mjs`
(모두 이 라운드가 추가·시험한 프로덕션 export)를 관제실 PowerShell
파일이 어떻게 불러 쓸 수 있는지의 패치 원문이다.

## 적용 상태: **PROPOSED** (미적용)

## 왜 이 패치가 필요한가

`scripts/relay/adapters/orca-adapter.mjs`의 `ENGINE_BY_ROLE`은 이번 라운드
전까지 `{CODER: "claude", REVIEW: "codex", VERIFY: "claude"}`로 하드코딩돼
있었다 — REVIEW를 codex로 고정한 값이 관제실
`seat-launch-registry.jsonl`의 최근 실측(2026-11-10, 아래 §0)과 어긋나
있었다(REVIEW 좌석은 실제로 claude Opus로 뜬다). 이 라운드는 그 상수를
`scripts/check/engine-profiles.json` 한 곳에서 읽게 고쳤다(§1 1순위).

관제실 PowerShell 세 파일에도 **같은 모양의 하드코딩**이 따로, 독립적으로
남아 있다 — 코드가 아니라 **문서·사람 적용**으로만 동기화되는 지점이라
다시 벌어질 수 있다:

- `orca-worker-seat.ps1:57` — `-Engine` 인자를 안 주면 `$Role -eq "REVIEW"
-or $Role -eq "PM"` 이면 `"codex"`, 아니면 `"claude"`로 **역할만 보고**
  기본 엔진을 고른다. 주석(12행)이 명시하듯 이전 라운드가 "이 기본값은
  이 라운드가 손대지 않는다(HYK-462 범위)"로 **의도적으로 보류**해 둔
  지점이다 — 지금 실제로 REVIEW 좌석이 claude로 뜨는 것은 **호출자가
  매번 `-Engine claude -Model claude-opus-5-5`를 명시로 넘겨서**다(§0
  실측, memory-gate.ps1:210도 이 패턴). 인자를 빼먹는 호출이 하나라도
  생기면 이 기본값이 그대로 적용돼 codex 좌석이 뜬다(HYK-472가 이미
  2회 겪은 사고 모양 그대로).
- `dispatch-worker.ps1` — 배달 단계의 엔진 분기(525행
  `if ($confirmEngine -eq "claude")`, 632행 `if ($engine -eq "claude")`)는
  **이미** `seat-engine-detect.mjs`의 측정값(`$confirmEngine`/`$engine`,
  424행 `$confirmEngine = [string]$engine`)을 쓴다 — 역할 추측이 아니다.
  ⭐**이 파일은 패치 대상이 아니다** — HYK-472가 이미 고친 지점이고, 이
  라운드의 ENGINE_BY_ROLE 수정과 같은 축을 또 건드리면 중복·충돌이다.
  아래 §2는 이 사실을 "건드리지 않는다"로 명시만 한다.
- `memory-gate.ps1:21` — 기본 `$Model = 'claude-sonnet-5'`가 하드코딩,
  `:210`에서 항상 `-Engine claude`로 좌석을 띄운다(memory-gate는
  CODER류 좌석 전용이라 claude 고정 자체는 맞다 — 다만 모델 리터럴이
  `engine-profiles.json`의 CODER 항목과 별도로 손 관리된다).

## §0 실측 (이 라운드, 2026-11-10, 읽기 전용)

| 파일                   | SHA-256 (읽기 전용)                                                      | 줄수 |
| ---------------------- | ------------------------------------------------------------------------ | ---- |
| `orca-worker-seat.ps1` | `2f59d12522da51fc49a5a953f7c9e41761ca287d6956435a2e9ae20dd49be4f7`[^sha] | 130  |
| `dispatch-worker.ps1`  | `7cd6785ed9324f890930f9a0a872f556228f135289e53c16f23f7a6b3594daa3`[^sha] | 839  |
| `memory-gate.ps1`      | `17219bdc58150c9e3771079c9d601d3c2a9a25764b7872f67fa2f20ecf1ade51`[^sha] | 222  |

[^sha]: node `crypto.createHash("sha256")` 읽기 전용 실측, 2026-11-10 20:20 KST — 사람이 적용 전 `Get-FileHash -Algorithm SHA256`로 다시 재는 것을 권장(파서 구현 차이로 줄바꿈 바이트가 다를 수 있다 — 아래 패치 단위는 **내용 앵커 일치**로 거부되므로 SHA 불일치 자체가 적용을 막지는 않는다, 다만 "이 문서가 본 원문과 다르다"는 신호로 보라).

`seat-launch-registry.jsonl` 최근 행(관제실, 읽기 전용, 2026-11-10):
REVIEW 롤 전부 `"engine":"claude","model":"claude-opus-5-5"` — 지난 11-06~11-10
사이 REVIEW 기동 8건 전수 claude, codex 0건(이 라운드가 본 표본, 전칭
아님).

## §1 patch unit A — `orca-worker-seat.ps1` 기본 엔진을 프로필 CLI로

**앵커** (57행, 앞 2칸 공백 포함, 원문 그대로):

```text
  $Engine = if ($Role -eq "REVIEW" -or $Role -eq "PM") { "codex" } else { "claude" }
```

**제안 교체문 (HYK-153-engine-profile-2 정정)** — PM/REVIEW를 역할
리터럴로 추측하지 않고, `engine-profile-cli.mjs`가 `engine-profiles.json`
에서 읽은 값을 쓴다. ⛔**옛 리터럴 폴백은 뺐다**(P2-8) — 그 리터럴
(`$Role -eq "REVIEW" -or $Role -eq "PM") { "codex" }`)은 이 패치가
고치려는 바로 그 버그와 같은 모양(역할을 "추측"해서 엔진을 정함)이었고,
PM도 REVIEW와 마찬가지로 실측상 `codex`가 아니라 `claude`로 뜬다(§0 ·
seat-launch-registry.jsonl) -- 즉 그 폴백 리터럴 자체가 처음부터
틀려 있었다. config 조회가 실패하면 조용히 그 틀린 값으로 떨어지는 대신
**멈춘다**(실패 = 멈춤 + 사유, 조용한 기본값 금지):

```text
  $engineCliPath = Join-Path $Worktree "scripts\check\engine-profile-cli.mjs"
  $profileLine = if (Test-Path $engineCliPath) { node $engineCliPath resolve --role $Role 2>$null } else { $null }
  if ($LASTEXITCODE -eq 0 -and $profileLine) {
    $Engine = ($profileLine | Select-String '^engine=(.+)$').Matches.Groups[1].Value
  } else {
    Write-Error "orca-worker-seat: engine-profile-cli resolve --role $Role failed (exitcode=$LASTEXITCODE, cliPath=$engineCliPath) -- refusing to guess an engine from the role literal, seat NOT started"
    exit 1
  }
```

**사람이 적용 전 확인할 것 (정정)**: HYK-153-engine-profile-2가
`engine-profiles.json.roles`에 PM을 추가했다(engine=claude, 관제실
seat-launch-registry.jsonl의 최근 PM 행 실측과 일치) — 그래서 이 패치가
적용된 뒤에는 PM과 REVIEW 둘 다 `engine-profile-cli.mjs resolve`가
성공해서 `"claude"`로 해석되고, 위의 실패-멈춤 분기는 워크트리에
`engine-profile-cli.mjs`가 아직 없는 옛 체크아웃에서만 탄다(그 경우도
더 이상 틀린 값으로 조용히 떨어지지 않고 좌석 기동 자체를 멈춘다). 이전
문면("PM은 아직 config.roles에 없으므로 폴백이 그대로 적용된다")은
PM 추가 전 상태를 서술한 것으로, 이번 라운드로 더 이상 맞지 않는다.

## §2 patch unit B — `dispatch-worker.ps1` — ⛔변경 없음(명시)

위 §0 설명대로 이 파일의 엔진 분기는 이미 측정값(seat-engine-detect.mjs)
을 쓴다. 이 라운드는 여기에 패치 단위를 내지 않는다 — 건드리면 HYK-472가
이미 닫은 사고 축을 다시 여는 중복 변경이 된다.

## §3 patch unit C — `memory-gate.ps1` 기본 모델을 프로필 CLI로

**앵커** (21행 param 블록 안, 원문 그대로):

```text
  [string]$Model = 'claude-sonnet-5',
```

**제안 교체문 (HYK-153-engine-profile-2 경로 오류 정정)** — 리터럴
기본값 대신 CODER 프로필의 모델을 기본값으로 쓴다(아래 §4의
`node ... resolve --role CODER` 호출과 동일 CLI). ⛔**옛 문면의 경로는
수식 자체가 틀렸다** — `D:\문서관리\하네스-관제실\..\..`는 `D:\문서관리`를
두 단계 거슬러 올라가 `D:\`가 되고, 거기에 `scripts\check\...`를 붙인
`D:\scripts\check\engine-profile-cli.mjs`는 어느 체크아웃에도 존재하지
않는 경로다(관제실 디렉터리 기준으로 저장소 루트를 계산하려 한 식이지만
저장소는 관제실의 하위/상위 경로가 아니다 -- 애초에 성립할 수 없는 상대
경로였다). memory-gate.ps1은 이미 `$Worktree`를 필수 파라미터로
받는다(`param()` 블록에서 `$Model`보다 앞에 선언되어 있어 `$Model`의
기본값 식이 평가되는 시점에는 이미 바인딩돼 있다) -- unit A가
`orca-worker-seat.ps1`에서 쓰는 것과 같은 `Join-Path $Worktree
"scripts\check\engine-profile-cli.mjs"` 패턴으로 바꾼다:

```text
  [string]$Model = $(
    $__cliPath = Join-Path $Worktree "scripts\check\engine-profile-cli.mjs"
    $__p = if (Test-Path $__cliPath) { & node $__cliPath resolve --role CODER 2>$null } else { $null }
    if ($LASTEXITCODE -eq 0 -and $__p) { ($__p | Select-String '^model=(.+)$').Matches.Groups[1].Value } else { 'claude-sonnet-5' }
  ),
```

**정직 한계**: unit C는 unit A와 달리(P2-8) 폴백을 **유지한다** — 이
리터럴(`'claude-sonnet-5'`)은 unit A의 PM/REVIEW 리터럴과 달리 오늘
measured 값과 어긋나 있지 않다(config.roles.CODER.model이 정확히
`claude-sonnet-5`다, memory-gate.ps1은 CODER류 좌석 전용이라 애초에
역할을 추측하지 않는다). param 블록의 기본값 식은 스크립트가 로드되는
모든 워크트리 경로가 아직 없을 수 있는 시점에 평가되므로, CLI 경로가
없거나 실패하면 이 폴백으로 떨어진다(조용한 추측이 아니라 "이 CLI를
못 찾았다"의 안전한 동치 -- 틀린 값으로의 폴백이 아니라는 점이 unit A와
다르다). 사람이 적용할 때 `$Worktree`가 그 시점 실제로 바인딩되는지
재확인하라 -- 이 문서는 패치의 **모양**만 제안한다.

## §4 CLI 참고 (이 라운드가 새로 추가, 이미 시험됨)

```text
node scripts/check/engine-profile-cli.mjs resolve --role REVIEW --json
# -> {"engine":"claude","model":"claude-opus-5-5","effort":"high"}
node scripts/check/engine-profile-cli.mjs resolve --role CODER
# -> engine=claude
#    model=claude-sonnet-5
#    effort=high
```

exit 2 + stderr 사유 문구(설정 미존재/깨짐/role 미등록) — 조용한 기본값
없음(engine-profile.mjs 본문 참조).

## §5 관제실 잔여 리터럴 목록 (목록만, 이 라운드 범위 밖)

selfcheck 축(E5 분류, `scripts/check/selfcheck*.mjs` 등)은 "계층 밖
Claude 전용 훅"으로 분류되어 이 라운드가 config로 이관하지 않았다(PM 설계
§b E5) — 이 목록은 "다음에 볼 자리"일 뿐, 이 라운드의 완료 조건이 아니다.

- `orca-worker-seat.ps1:12,53,100,101,107,119,120,125,126,129` — codex
  모델 리터럴(`gpt-5.6-luna`/`gpt-5.6-sol`), `.claude-team` 경로,
  `claude-sonnet-5`/`medium` 기본값. §1/§3이 다루지 못한 나머지(모델
  luna/sol→terra 교정은 명시적으로 HYK-462 범위, 이 패치가 또 손대지
  않는다).
- `dispatch-worker.ps1:430` — `$confirmClaudeHome = "C:\Users\Administrator\.claude-team"`
  (engine-profiles.json의 `engines.claude.teamDirName`과 같은 값, 아직
  이 파일에서 이관 안 됨 — §2가 이 파일 전체를 손대지 않기로 한 것과
  같은 이유).
- `memory-gate.ps1`의 나머지 claude 전용 문구(이 파일은 CODER 전용이라
  애초에 엔진 분기가 없다 -- 이관 가치가 낮다고 판단, 목록만).

## §6 사람이 적용할 순서

1. 이 문서 §0의 SHA-256을 그 시점 실물과 다시 대조한다(달라졌으면 앵커
   문자열도 다시 확인).
2. §1(orca-worker-seat.ps1)을 먼저 적용 — REVIEW 좌석 1회를 실제로 띄워
   `engine=claude`가 그대로 찍히는지 확인(회귀 없음 증명).
3. §3(memory-gate.ps1)을 적용 — CODER 좌석 1회 띄워 모델 리터럴이
   `engine-profiles.json`의 CODER.model과 같은지 확인.
4. §2(dispatch-worker.ps1)는 적용하지 않는다(이미 올바름).
5. §5 목록은 별도 라운드(이관 가치를 사람이 먼저 판단)로 넘긴다.
