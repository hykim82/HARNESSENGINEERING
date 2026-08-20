# HYK-286 — 갓 생긴 codex rollout 첫 줄을 못 읽으면 «건너뛴다» (제안 문면)

## 적용 상태: **제안** — 이 문서는 아직 관제실에 적용되지 않았다. ORCH가

coder-task.md §3의 6단계 전례 절차(문면 → 독립 검토 → 기계 추출 →
지문·백업·파싱 검사 → 관제실 git 커밋 → 발동 관측)를 밟아야 발동한다.
⛔이 CODER 라운드는 관제실 파일을 고치지 않는다(coder-task.md §3
비타협 "관제실 쓰기 0").

## §0 이 조각은 «사고 방지»다 (공격 방지가 아니다)

고치는 대상은 **타이밍 사고**다 — codex 세션 rollout 파일이 막 쓰이는
중이라 첫 줄을 못 읽는 것. ⛔고의로 꾸민 rollout 파일을 막는 것은 이
조각의 범위가 아니다 — 새 위조 방어를 만들지 않았다.

## 기전 (ORCH 실측 확정, coder-task.md §1 그대로)

발화 지점 = 관제실 `dispatch-worker.ps1` 의 `Confirm-GetCodexSnapshot`.
저장소 전체에 `session_meta` 문자열은 0건 — 관제실 코드가 대상이다.

이 함수는 codex 세션 폴더(`-Recurse`) 안 모든 `rollout-*.jsonl` 을 훑어
그 파일의 **첫 줄**을 `session_meta` JSON 으로 읽고, `payload.cwd` 가
대상 워크트리와 일치하는 것만 골라 바이트 합을 낸다. 문제는 **첫 줄을
못 읽을 때의 처리** — 지금은:

1. 첫 줄이 비었거나 공백뿐이면 `throw "empty session_meta line"`.
2. 그 예외(그리고 `ConvertFrom-Json` 파싱 실패)가 바깥 `catch` 로
   전파되고, 파일이 **아직 존재**하면 (동시 삭제가 아니면) 함수 전체를
   `ok=$false` 로 즉시 반환한다 — 이미 정상 판정한 다른 파일의
   바이트까지 버려진다.

갓 생긴 rollout 파일은 codex 가 `session_meta` 줄을 다 쓰기 전 짧은
동안 **완전히 빈 상태**보다 **쓰다 만 JSON 조각**인 순간이 더 길다.
지금 코드는 전자(빈 줄)만 명시 처리하고, 후자(깨진 JSON)는 같은
`catch` 로 흘러들어가 **똑같이 전체 실패**로 이어진다 — 운영 실측
문구(2026-08-17, 3회 동일): `WARNING: Codex 세션 수집 실패; 배달은
계속합니다: empty session_meta line` → 종료코드 2.

## 왜 나쁜가

- **남의 좌석이 내 판정을 깬다** — `-Recurse` 로 이 PC 의 codex 세션
  폴더 전체(실측 170개, 증가 중)를 훑는다. 그중 아무 파일 하나가
  마침 쓰이는 중이면 **무관한 배달**의 착수확인이 깨진다.
- **순서 의존** — 실패 시 즉시 반환이라, 문제 파일이 `Get-ChildItem`
  나열 순서상 앞이냐 뒤냐에 따라 그 전에 모은 정상 데이터가 버려지는
  양이 달라진다.
- **반쪽 수리 위험** — 빈 줄과 깨진 JSON 은 같은 원인(쓰는 중)의 다른
  순간일 뿐인데 지금 코드는 전자만 명시하고 후자는 우연히 같은
  `catch` 로 떨어진다 — 새 예외 유형이 추가되면 다시 갈라질 수 있는
  구조다.

## §2 수리 방침 (coder-task.md §2, 이슈 후보 ⓑ 채택)

**첫 줄을 못 읽는 rollout 은 실패가 아니라 건너뛴다.** 근거: 첫 줄을
못 읽으면 그 파일이 대상 워크트리 것인지 알 수 없고, 대상이 아닌
파일은 이미 `continue` 로 건너뛰는 기존 규칙과 **같은 처리**다 — 새
예외를 만들지 않는다.

빈 첫 줄과 쓰다 만 JSON **둘 다** 같은 방식(건너뛰기)으로 다룬다 —
하나만 고치면 반쪽이라는 지적(coder-task.md §2 비타협1)을 그대로
따른다. `ConvertFrom-Json` 실패를 **별도의 안쪽 `try/catch`** 로
잡아 바깥 `catch` 로 전파되지 않게 분리했다 — 그래서 순서 의존성도
함께 없어진다(더 이상 이 두 사유로는 조기 반환이 일어나지 않으므로).

### 유지한 것 (완료조건 2 = 회귀, 손대지 않음)

- **열거(`Get-ChildItem`) 자체의 실패**(권한 등)는 여전히 `ok=$false`
  로 실패한다 — 이 분기는 원문 그대로다.
- **개별 파일의 그 밖의 읽기 실패**(빈 줄도 아니고 JSON 파싱 실패도
  아닌 경우, 예: `Get-Content` 자체가 예외를 던지는 권한 문제)는 원문과
  같은 바깥 `catch` 로 떨어져, 파일이 이미 삭제됐으면 건너뛰고 아니면
  여전히 전체 실패로 처리한다 — 이번 수리는 "빈 첫 줄"과 "깨진 JSON"
  두 경우만 명시적으로 건너뛰기로 옮겼을 뿐, 그 밖의 예외 처리 구조는
  바꾸지 않았다.

### ⓐ(전체 폴더 훑기 범위 축소)를 이번 조각에 넣지 않은 이유

coder-task.md §2 비타협2는 이 판단을 CODER 에게 맡겼다. 이번 조각에
**포함하지 않았다** — 이유:

1. §1 이 지목한 발화 지점은 "첫 줄을 못 읽으면 전체가 실패한다"는
   처리 방식이지, "전체 폴더를 훑는다"는 범위 자체가 아니다. 범위를
   좁히려면 이 PC 의 codex 세션 디렉터리 구조(워크트리별로 이미
   갈라져 있는지, `--Recurse` 없이 얕은 나열이 가능한지)를 관제실
   쪽에서 추가로 실측해야 하는데, coder-task.md 는 그 실측을 주지
   않았다 — 검증 없이 범위를 좁히면 §1 표에 없는 새 회귀를 만들 수
   있다.
2. 이번 수리(건너뛰기)만으로 ⓐ가 일으키는 실제 피해(남의 좌석이 내
   판정을 깨는 것)는 **이미 없어진다** — 문제 파일을 만나도 더 이상
   전체가 실패하지 않으므로, `-Recurse` 로 더 많은 파일을 보는 것
   자체는 결과에 영향이 없다(느려질 수는 있으나 정확성 문제는
   아니다). 범위 축소는 성능 최적화이지 이번 결함의 필수 수리가
   아니다.

## §3 기계 적용 단위 (추출 대상, 정확히 1개)

```control-room-patch-unit
id: hyk286-codex-first-line-tolerance
mode: replace
@@ANCHOR@@
function Confirm-GetCodexSnapshot([string]$SessionsDir, [string]$TargetWorktree) {
  $targetFiles = @{}
  [int64]$total = 0
  try {
    if (-not (Test-Path -LiteralPath $SessionsDir -PathType Container)) {
      return [pscustomobject]@{ ok = $true; totalBytes = [int64]0; files = $targetFiles; error = "" }
    }
    $rollouts = @(Get-ChildItem -LiteralPath $SessionsDir -Recurse -File -Filter "rollout-*.jsonl" -ErrorAction Stop)
  } catch {
    return [pscustomobject]@{ ok = $false; totalBytes = [int64]0; files = $targetFiles; error = $_.Exception.Message }
  }
  foreach ($rollout in $rollouts) {
    try {
      $firstLine = Get-Content -LiteralPath $rollout.FullName -TotalCount 1 -ErrorAction Stop
      if ([string]::IsNullOrWhiteSpace($firstLine)) { throw "empty session_meta line" }
      $meta = $firstLine | ConvertFrom-Json -ErrorAction Stop
      $cwd = ""
      if ($null -ne $meta.payload) { $cwd = [string]$meta.payload.cwd }
      if ([string]::IsNullOrWhiteSpace($cwd) -or (Norm $cwd) -ne (Norm $TargetWorktree)) { continue }
      [int64]$length = $rollout.Length
      $targetFiles[$rollout.FullName] = $length
      $total += $length
    } catch {
      # 동시 삭제는 다음 관측에서 다시 열거할 수 있으므로 건너뛰고, 남아 있는
      # 파일의 읽기/JSON 실패는 2(COLLECTION_FAILED)로 올린다.
      if (-not (Test-Path -LiteralPath $rollout.FullName)) { continue }
      return [pscustomobject]@{ ok = $false; totalBytes = $total; files = $targetFiles; error = $_.Exception.Message }
    }
  }
  return [pscustomobject]@{ ok = $true; totalBytes = $total; files = $targetFiles; error = "" }
}
@@CONTENT@@
function Confirm-GetCodexSnapshot([string]$SessionsDir, [string]$TargetWorktree) {
  $targetFiles = @{}
  [int64]$total = 0
  try {
    if (-not (Test-Path -LiteralPath $SessionsDir -PathType Container)) {
      return [pscustomobject]@{ ok = $true; totalBytes = [int64]0; files = $targetFiles; error = "" }
    }
    $rollouts = @(Get-ChildItem -LiteralPath $SessionsDir -Recurse -File -Filter "rollout-*.jsonl" -ErrorAction Stop)
  } catch {
    return [pscustomobject]@{ ok = $false; totalBytes = [int64]0; files = $targetFiles; error = $_.Exception.Message }
  }
  foreach ($rollout in $rollouts) {
    try {
      $firstLine = Get-Content -LiteralPath $rollout.FullName -TotalCount 1 -ErrorAction Stop
      # HYK-286(2026-08-20): 갓 생긴 rollout 파일은 codex가 session_meta 첫
      # 줄을 다 쓰기 전 짧은 동안 비어 있거나(아래) JSON이 반쯤만 쓰인
      # 상태(바로 아래 안쪽 try)일 수 있다 -- 둘 다 "아직 쓰는 중"이라는
      # 같은 타이밍 사고이지 수집 실패가 아니므로, 대상 워크트리가 아닌
      # 파일과 같은 처리(건너뛰기)로 맞춘다. 고의로 꾸민 rollout 파일을
      # 막는 것은 이 수리의 범위 밖이다(docs/control-room-patches/
      # HYK-286-codex-first-line-tolerance.md §0 정직 한계 참조).
      if ([string]::IsNullOrWhiteSpace($firstLine)) { continue }
      try {
        $meta = $firstLine | ConvertFrom-Json -ErrorAction Stop
      } catch {
        # HYK-286: 첫 줄이 JSON으로 아직 다 안 써진 조각이면(쓰다 만
        # JSON) 위 빈 줄과 같은 사유이므로 별도 안쪽 catch로 바깥
        # catch(전체 실패)로 전파되지 않게 건너뛴다.
        continue
      }
      $cwd = ""
      if ($null -ne $meta.payload) { $cwd = [string]$meta.payload.cwd }
      if ([string]::IsNullOrWhiteSpace($cwd) -or (Norm $cwd) -ne (Norm $TargetWorktree)) { continue }
      [int64]$length = $rollout.Length
      $targetFiles[$rollout.FullName] = $length
      $total += $length
    } catch {
      # 동시 삭제는 다음 관측에서 다시 열거할 수 있으므로 건너뛰고, 그 외
      # 개별 파일 읽기 실패(권한 등)는 여전히 2(COLLECTION_FAILED)로 올린다.
      if (-not (Test-Path -LiteralPath $rollout.FullName)) { continue }
      return [pscustomobject]@{ ok = $false; totalBytes = $total; files = $targetFiles; error = $_.Exception.Message }
    }
  }
  return [pscustomobject]@{ ok = $true; totalBytes = $total; files = $targetFiles; error = "" }
}
@@END@@
```

**개수 확인**: 위 1개가 이 문서의 진짜 추출 대상 전부다 — 이 문서
안의 다른 PowerShell 인용은 전부 ` ```powershell ` 태그를 쓴다
(§0/기전 절의 인용문 없음 확인: 이 문서는 함수 원문을 §3 밖에서
따로 인용하지 않는다, HYK-327 1R P2-1 반려 수리와 같은 위생).

## §4 실측 원본

| 항목                      | 값                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 이 문서 기준 원본 SHA-256 | `29fb025f23dbf8ae14f9adf81305de20975996ab0312ef1a352f67413aa707e6`                                                                                                      |
| 원본 행수                 | 634줄                                                                                                                                                                   |
| 원본 신원                 | `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt` (HYK-327 결선이 이미 적용된 관제실 스냅샷 — coder-task.md §3 "원본 지문"과 동일 값) |

이 문서의 앵커는 이 SHA-256의 원문을 기준으로 잡았다. 관제실 파일이 이
값과 다르면(예: HYK-327 적용 전이거나 그 사이 다른 변경이 있었다면)
§3의 도구가 앵커 검색에서 `ANCHOR_NOT_FOUND` 로 fail-closed 거부한다.

## §5 저장소 쪽 시험 — 「문서 → 적용본」재현 + 실제 동작 검증

### 도구로 재현

```powershell
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-286-codex-first-line-tolerance.md --source scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt --out <임시경로>
```

출력은 `scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk286-applied.ps1.txt` 와 바이트 동일해야 한다
(`scripts/check/control-room-patch-apply-hyk286-collect.test.mjs` 가 고정).

### 실제 동작으로 재현

`scripts/check/codex-snapshot-behavior.mjs` 가 적용본에서
`Confirm-GetCodexSnapshot` 함수 본문을 뽑아 실 PowerShell 프로세스에서
합성 rollout 파일을 넣어 직접 호출한다(HYK-323
`seat-proof-wrapper-behavior.mjs` 와 같은 패턴 — 지문 대조가 아니라
행동 대조).
`scripts/check/codex-snapshot-behavior.test.mjs` 가 coder-task.md §4의
표본을 각각 독립 케이스로 고정한다:

- 빈 첫 줄 rollout + 정상 rollout 1개 → 수집 성공, 정상 파일 바이트 보존.
- 공백뿐인 첫 줄 → 위와 같다.
- 쓰다 만 JSON 첫 줄 → 위와 같다.
- 문제 파일이 이름순 앞/뒤 각각 → 결과 같다(정상 파일 바이트 보존, ok=true).
- 열거 실패(`SessionsDir` 를 파일로 만들어 `Get-ChildItem -Recurse` 가
  터지게 함) → 여전히 `ok=false` (완료조건 2 회귀).

## §6 ORCH 적용 절차 (coder-task.md §3 그대로, 6단계 전례)

1. **지문 대조**: 적용 전 관제실 `dispatch-worker.ps1` 의 SHA-256이
   §4 표의 값과 같은지 확인.
2. **백업**: 타임스탬프 붙은 사본으로 복사.
3. §3 도구 실행. `exit 0` 아니면 여기서 멈춘다(`--out` 미기록이므로
   원본은 안전).
4. **파싱 검사**: `[System.Management.Automation.Language.Parser]::ParseFile` 로
   `--out` 이 유효한 PowerShell인지 확인.
5. 통과하면 `--out` 내용을 관제실 실물 경로로 덮어쓰고 git add/commit.
6. **발동 관측**: 실제 배달 1회를 관찰해, 갓 생긴(또는 합성) rollout
   이 있어도 착수확인이 exit 2 로 끝나지 않는지 확인(이 라운드 범위
   밖 — ORCH 몫).

## ⛔하지 않은 것

- 관제실 파일 수정(ORCH 몫) — 이 라운드는 저장소 안 문서·픽스처·
  도구·시험만 건드렸다.
- `dispatch-worker.ps1` 의 다른 함수·다른 검사기 결선 — 무변경.
- ⓐ(전체 폴더 훑기 범위 축소) — §2 마지막 절에 사유를 적었다: 이번
  수리만으로 그 피해는 이미 없어지고, 범위 축소는 추가 실측 없이는
  새 회귀 위험이 있어 넣지 않았다.
- 고의로 꾸민 rollout 위조 방어 — §0 정직 한계 그대로, 새로 만들지
  않았다.
