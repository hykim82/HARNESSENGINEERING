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

**제안 교체문** — PM/REVIEW를 역할 리터럴로 추측하지 않고,
`engine-profile-cli.mjs`가 `engine-profiles.json`에서 읽은 값을 쓴다(PM은
아직 config.roles에 없으므로 CLI가 실패하면 **기존 리터럴 폴백**으로
떨어진다 -- 조용한 회귀가 아니라 "그 역할은 아직 config에 없다"를 그대로
보여주는 2단 방어):

```text
  $engineCliPath = Join-Path $Worktree "scripts\check\engine-profile-cli.mjs"
  $profileLine = if (Test-Path $engineCliPath) { node $engineCliPath resolve --role $Role 2>$null } else { $null }
  if ($LASTEXITCODE -eq 0 -and $profileLine) {
    $Engine = ($profileLine | Select-String '^engine=(.+)$').Matches.Groups[1].Value
  } else {
    # engine-profiles.json에 아직 없는 역할(예: PM, 또는 옛 워크트리라
    # 이 CLI가 없음) -- 옛 리터럴 폴백, 조용한 추측이 아니라 "config
    # 미해당"을 그대로 남긴다(HYK-153 patch note, 사람이 config.roles에
    # PM을 추가하면 이 분기는 더 이상 안 탄다).
    $Engine = if ($Role -eq "REVIEW" -or $Role -eq "PM") { "codex" } else { "claude" }
  }
```

**사람이 적용 전 확인할 것**: `$Role -eq "PM"` 분기는 지금
`engine-profiles.json.roles`에 PM이 없으므로(이 라운드 범위 밖, §2 ⛔
deviation_rule — PM 기본값은 바꾸지 않았다) **폴백이 그대로 적용된다** —
즉 이 패치는 PM 좌석의 동작을 바꾸지 않는다. REVIEW만 `engine-profiles.json`
의 `"claude"` 값으로 해석되어, 호출자가 `-Engine`을 빼먹어도 더 이상
codex로 떨어지지 않는다.

## §2 patch unit B — `dispatch-worker.ps1` — ⛔변경 없음(명시)

위 §0 설명대로 이 파일의 엔진 분기는 이미 측정값(seat-engine-detect.mjs)
을 쓴다. 이 라운드는 여기에 패치 단위를 내지 않는다 — 건드리면 HYK-472가
이미 닫은 사고 축을 다시 여는 중복 변경이 된다.

## §3 patch unit C — `memory-gate.ps1` 기본 모델을 프로필 CLI로

**앵커** (21행 param 블록 안, 원문 그대로):

```text
  [string]$Model = 'claude-sonnet-5',
```

**제안 교체문** — 리터럴 기본값 대신 CODER 프로필의 모델을 기본값으로
쓴다(아래 §4의 `node ... resolve --role CODER` 호출과 동일 CLI):

```text
  [string]$Model = $(
    $__p = & node "D:\문서관리\하네스-관제실\..\..\scripts\check\engine-profile-cli.mjs" resolve --role CODER 2>$null
    if ($LASTEXITCODE -eq 0) { ($__p | Select-String '^model=(.+)$').Matches.Groups[1].Value } else { 'claude-sonnet-5' }
  ),
```

**정직 한계**: param 블록의 기본값 식은 스크립트가 로드되는 모든 워크트리
경로가 아직 없을 수 있는 시점에 평가된다 — 위 식은 그래서 CLI 경로가 없거나
실패하면 **옛 리터럴로 폴백**한다(조용한 추측이 아니라 "이 CLI를 못
찾았다"의 안전한 동치). 사람이 적용할 때 실제 경로(워크트리 고정이 아니라
저장소 템플릿 설치 경로 기준)를 재확인하라 — 이 문서는 패치의 **모양**만
제안하고, 경로 상수는 적용자가 그 시점의 실제 배치를 보고 고른다.

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
