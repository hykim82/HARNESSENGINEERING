# HYK-378 패치 문서 — `dispatch-worker.ps1` 의 폴더 이름 계산을 저장소 단일 출처 CLI 로 바꾼다 (ps1-derive-consume-1)

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` **오늘자 라이브**(2026-10-03 · CODER 직접 재계산 확인) — 라이브 CRLF SHA-256 `34f8f43cb7b80252e3cce41ef1a404f9dd678d2f7dc27752e8e7c0a63c687018` · 56,531 바이트 · 802줄 · CRLF 802 · bare LF 0. 이 문서의 fixture(`scripts/check/fixtures/control-room-dispatch-worker-2026-10-03-hyk378-derive-before.ps1.txt`)는 그 라이브를 **CRLF→LF 정규화**한 사본이다 — SHA-256 `4a21432dcde7b924031a10ddef546daad54db3f6862bbb7e383f892d4c449091` · LF(CRLF 0) · 803 개행(끝 개행 포함, 802줄).

**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`. ⛔이 도구는 관제실 실제 경로를 절대 쓰지 않는다(`--source`/`--out` 만 쓴다, 둘 다 파일). 라이브 적용은 병합 뒤 ORCH 가 S7 로 기계 적용한다(ORCH 손편집 0).

## 0. 이 문서가 하는 일 — 한 줄

라이브 `dispatch-worker.ps1` 514행의 **자체 치환** `[string]$Worktree -replace '[\\/:]', '-'` 를 **#294 가 master 에 넣은 단일 출처 CLI** 호출로 바꾼다. 그 CLI 는 `deriveClaudeProjectDirName`(`scripts/supervisor/rate-limit-stall-adapter.mjs`)을 그대로 부르며, 이 조각은 **계산을 새로 만들지 않는다**(HYK-378 derive-single-source 와 같은 원칙: 복제가 원인이었으므로 또 하나의 복제를 만들지 않는다).

## 1. 왜 바꾸는가 — 실측 원인 (책임자 지시 A 편입 · ORCH-84 값 확정)

- **워크트리**: `C:\Users\Administrator\orca\workspaces\모바일마크다운에디터\hyk304-pathname-guard-review-1`
- **옛 자체 치환 결과**(라이브 514행): `C--Users-Administrator-orca-workspaces-모바일마크다운에디터-hyk304-pathname-guard-review-1` — **존재하지 않는 폴더**
- **실제 Claude 세션 폴더**: `C--Users-Administrator-orca-workspaces------------hyk304-pathname-guard-review-1` (비ASCII 10글자 + 구분자 2개 = 대시 12개) — 존재
- **#294 단일 출처 CLI 결과**: 위 실제 폴더 이름과 **정확히 같다** (아래 §6 에서 값으로 재현)

옛 치환은 경로 구분자만 접고 비ASCII 글자는 접지 않는다. 그래서 감시기는 없는 폴더의 바이트를 재고, 그 값은 영원히 0 증가 → **«아예 시작 못 함»이라는 거짓 통지**가 난다. 그 두 통지의 대상 라운드는 둘 다 정상 완주했다(정적 검사 CODER DONE 14:46:59 · REVIEW DONE 15:24:24 — 워커 기록 파일은 `.claude-team` 아래 1.13MB · 1.27MB 로 실제로 자랐다).

**곁가지 전수** — ps1 안에서 같은 치환(`-replace '[\\/:]'`)은 **514행 한 곳뿐**이다(`Grep` 전수). 102행 `Norm` 의 `-replace '\\', '/'` 는 경로 정규화 용도로 다르며 프로젝트 폴더 이름을 만들지 않으므로 이 패치 대상이 아니다.

## 2. 교체 문면 (before → after)

앵커는 514–516행 **3줄**이다(라인 514 를 치환하고, 바로 다음 줄이 쓰는 `$confirmProjectDir` 과 기준선 호출을 함께 묶어야 실패 시 기준선 호출이 빈 폴더를 읽지 않는다). 유일성: 세 줄 전체가 원본에 정확히 1회 나온다.

- **before**: `$confirmProjectName = [string]$Worktree -replace …` → `$confirmProjectDir = Join-Path …` → `$confirmClaudeBaseline = Confirm-GetClaudeBytes $confirmProjectDir`
- **after**: CLI 호출(`& node $deriveCliPath $Worktree`) → 성공 시 한 줄 이름을 `$confirmProjectName` 에 담고 기존과 같은 식으로 폴더·기준선을 계산 / **실패 시** 폴더를 `"unavailable"` 로 두고 `ok = $false` 인 기준선 객체를 만든다.

## 3. 실패 처리 — 「조용히 넘기지 않는다」의 기계적 근거

§1 ⓑ 요구: CLI 가 실패하면 **빈 문자열이 되어 「없는 폴더」를 보는 같은 사고가 다시 나지 않아야 한다**. 그래서 실패는 다음 경로로 드러난다.

1. `$confirmProjectName` 이 비면(= CLI 종료코드 ≠ 0, 출력 줄 수 ≠ 1, 또는 실행 자체 실패) → `Write-Warning` 로 사유를 찍는다.
2. 기준선을 `ok = $false` 로 만든다 → 기존 코드의 `$confirmBaselineKnown = $false` 가 된다.
3. 기존 경로가 그 뒤를 맡는다: `Write-Warning "배달 전 기준선 수집 실패; 착수 확인은 2(COLLECTION_FAILED)로 남기고 배달은 계속합니다"` → `$confirmExit = 2`.

⇒ **새 종료코드를 만들지 않는다**(번호 원장: 2 는 이미 COLLECTION_FAILED 로 쓰인다). 배달은 계속되지만 착수 확인은 「확인 불가」로 남고, 거짓 `STARTED`/`NOT_STARTED` 는 나지 않는다.

`$ErrorActionPreference = "Stop"`(ps1 49행) 환경에서 `2>&1` 과 함께 stderr 가 나오면 PowerShell 이 그 줄을 종료 오류로 올릴 수 있다 — 그래서 `& node` 를 `try` 안에 둔다(시험 §6 에서 이 경로를 값으로 확인한다).

## 4. node 가 PATH 에 없을 때 · 성능 (§1 ⓒⓓ)

- **node 부재**: `& node` 가 명령 탐색 실패로 던지면 `catch` 가 받아 §3 경로로 간다(= 조용한 빈 값 아님). 시험 §6-3 이 이 경로를 pwsh 로 직접 구동해 확인한다.
- **성능**: 배달마다 node 프로세스가 1개 더 뜬다. 측정치는 결과 파일 §1 ⓓ 에 기록한다(시험 값이 아니라 측정 값).

## 5. 단위 — 기계 추출 대상 (1개 · `replace`)

```control-room-patch-unit
id: hyk378-derive-consume
mode: replace
@@ANCHOR@@
  $confirmProjectName = [string]$Worktree -replace '[\\/:]', '-'
  $confirmProjectDir = Join-Path (Join-Path $confirmSessionHome "projects") $confirmProjectName
  $confirmClaudeBaseline = Confirm-GetClaudeBytes $confirmProjectDir
@@CONTENT@@
  # HYK-378 ps1-derive(책임자 A · 2026-10-03): 프로젝트 폴더 이름은 저장소 단일 출처 CLI
  # (scripts/supervisor/derive-claude-project-dir-cli.mjs -> deriveClaudeProjectDirName)가 낸다.
  # 옛 자체 치환은 비ASCII 글자를 접지 않아 「없는 폴더」를 가리켰다(거짓 「아예 시작 못 함」 통지).
  # 실패는 조용히 넘기지 않는다: 기준선을 미확인으로 두고 기존 COLLECTION_FAILED(2) 경로로 드러낸다.
  $deriveCliPath = Join-Path $Worktree "scripts/supervisor/derive-claude-project-dir-cli.mjs"
  $confirmProjectName = $null
  $deriveCliError = ""
  try {
    $deriveOut = & node $deriveCliPath $Worktree 2>&1
    $deriveExit = $LASTEXITCODE
    if ($deriveExit -eq 0 -and @($deriveOut).Count -eq 1) {
      $confirmProjectName = ([string]$deriveOut).Trim()
    } else {
      $deriveCliError = "derive CLI exit=$deriveExit output=$(@($deriveOut) -join ' ')"
    }
  } catch {
    $deriveCliError = "derive CLI launch: $($_.Exception.Message)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$confirmProjectName)) {
    Write-Warning "폴더 이름 유도 실패 -- 기준선을 잡을 수 없다(기존 COLLECTION_FAILED 경로): $deriveCliError"
    $confirmProjectDir = "unavailable"
    $confirmClaudeBaseline = [pscustomobject]@{ ok = $false; totalBytes = [int64]0; files = @{}; error = $deriveCliError }
  } else {
    $confirmProjectDir = Join-Path (Join-Path $confirmSessionHome "projects") $confirmProjectName
    $confirmClaudeBaseline = Confirm-GetClaudeBytes $confirmProjectDir
  }
@@END@@
```

## 6. 재현 절차와 값 (CODER 가 직접 구동한 결과 — 결과 파일 §4 에 원문)

- 옛 계산(`-replace`)과 #294 CLI 가 같은 입력(§1 워크트리 경로)에 대해 **다른 이름**을 낸다는 것을 값으로 본다. 두 값은 §1 표의 두 문자열 그대로다.
- 적용본은 `control-room-patch-apply.mjs` 로 before fixture 에서 만든다. 적용본 SHA-256 은 `scripts/check/fixtures/control-room-dispatch-worker-2026-10-03-hyk378-derive-applied.ps1.txt` 의 파일 해시(시험이 고정한다).
- **effect 시험**은 적용본에서 `$deriveCliPath` 부터 기준선 호출까지 조각을 **그대로 잘라** pwsh 로 구동한다. 입력은 비ASCII 워크트리 경로(§1)이고 기대 산출값은 시험 안에 **문자열로 박아 둔다**(fixture 에서 유도하지 않는다 → 문서와 fixture 를 함께 바꾸고 해시만 갱신하는 우회를 막는다, H4 검토 P2-1 과 같은 구멍).

## 7. ⚠️정직 — 이 패치가 「못」 하는 것

- **라이브 미적용**: 이 라운드는 **사본에만** 적용해 보였다. 실제 `dispatch-worker.ps1` 은 건드리지 않았다(§8 적용 절차 전까지 옛 계산이 라이브에서 계속 돈다).
- **라이브 드리프트**: 시험은 저장소에 커밋된 fixture 만 읽는다. 관제실 live 파일이 이후 바뀌면 fixture 는 다시 낡는다(§8 의 원본 sha 대조가 그 축을 맡는다).
- **CLI 자체의 정확성**은 이 패치가 보증하지 않는다 — 그 정본은 #294 의 `deriveClaudeProjectDirName` 시험(`derive-claude-project-dir-cli.test.mjs`)이다.
- **거짓 통지 자체는 이 패치로 「없어지는」 것이지, 진짜 미착수를 「더 잘 잡는」 것이 아니다** — `dispatch-start-confirm` 신호는 양방향으로 못 믿는다(ORCH70 §17 판례 그대로). 정본은 화면과 결과 파일이다.
- **codex 분기는 대상이 아니다**(`$confirmEngine -eq "claude"` 분기 안의 줄만 바꾼다).
- **pwsh 언어 자체**(변수 스코프·`$LASTEXITCODE` 의미 등)는 시험이 검증하지 않고 pwsh 를 신뢰된 전제로 둔다.

## 8. 적용 절차 (사람/ORCH 몫 · S7)

1. 이 PR 병합 뒤, 라이브 원본 SHA-256 이 `34f8f43cb7b80252e3cce41ef1a404f9dd678d2f7dc27752e8e7c0a63c687018` 인지 먼저 확인한다. **다르면 적용하지 말고** 드리프트로 보고한다(앵커를 다시 잘라야 한다).
2. CRLF→LF 정규화 사본을 만든다(fixture 와 같은 관례). `node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-378-ps1-derive-consume.md --source <정규화 사본> --out <적용본>`.
3. 적용본 diff 를 눈으로 확인 → 결과를 LF→CRLF 로 되돌려 라이브에 반영한다(줄바꿈만 바꾸는 기계적 변환).
4. 되돌림 = 원본(34f8…) 사본 보관.
