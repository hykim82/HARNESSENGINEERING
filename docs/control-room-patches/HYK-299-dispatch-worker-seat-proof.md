# HYK-299 — `dispatch-worker.ps1` 368~406행 교체 문면 (좌석 증명 결선, gap#55)

## 적용 상태: ✅**적용됨(APPLIED)** — 2026-08-19 17:25 KST · 집행 = ORCH 교대 27회차

⛔이 표의 값은 **전부 ORCH가 직접 실측한 것**이다(워커 보고 재인용 아님).

| 항목                              | 값                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 적용 전 파일 SHA-256              | `092d28ba6c1f8053cc3f8e401d6426ed5dc38cef0fcb2814e2a1dcb93136874f` (514줄 / 32,965B)                                                                             |
| 적용 후 파일 SHA-256              | `cff75d2fd3c965ba5a0c88e598f0f3441c426a3dca855d7fca7bcdde9a30d458` (565줄 / 37,091B)                                                                             |
| 교체 «전» 구간(368~406행) SHA-256 | `219f57f9992fa909b28bd0526935a7bf2bd514ec1cf162a393f0bbfa8a65cb3b` (3,904B) — ★**REVIEW 워커가 관제실 파일을 독립으로 직접 읽어 뜬 값과 바이트 동일**(교차 증명) |
| 교체 «후» 문면 SHA-256            | `651cd319d5752f3ea446073e25d693923a8b5cf589f9490dc4f6b5b297c840bf` (90줄 / 8,030B)                                                                               |
| 백업                              | `dispatch-worker.ps1.bak-HYK299-2026-08-19T1724` (적용 전 파일과 지문 동일 확인)                                                                                 |
| 적용부 재추출 == 승인 문면        | ✅ True (ORCH가 이 문서에서 **독립 재추출**해 대조 — 워커 임시파일을 그대로 믿지 않음)                                                                           |
| head(1~367행) 불변                | ✅ True                                                                                                                                                          |
| tail(407행~) 불변                 | ✅ True                                                                                                                                                          |
| PowerShell 파싱                   | ✅ 적용본 **0 errors / 3,065 tokens** · 백업본 **0 errors / 2,840 tokens**                                                                                       |
| `Invoke-SeatProofGate` 등장       | 3회 (정의 1 + claude 경로 1 + codex 경로 1 — 중복 해소 블록 0)                                                                                                   |

⚠️**아직 «라이브 발동 관측»은 없다** — 이 표는 «파일이 올바르게 바뀌었다»까지만 증명한다. 다음 실제 배달에서 좌석 증명 줄이 화면에 뜨는 것을 확인해야 «작동한다»가 된다(HYK-256 때와 같은 정직 한계).

### REVIEW 독립 승인 (`HYK-299-review-1`)

**verdict: approved · P1 0 · P2 3.** 변이 실증 = `buildExpected()`의 `dispatchId` 한 줄을 망가뜨리자 **10건 중 5건이 실제로 죽었다**(exit 1). 복구 후 gate 파일 SHA-256이 변이 전과 동일하고 `git status` 비어 있음을 확인.

**P2 3건(수리 안 함 — 후속 후보):** ⑴`$env:TEMP` 파일명이 고정이라 같은 task 동시 배달 시 충돌 가능 ⑵TEMP JSON에 내부 식별자가 평문으로 남고 ACL이 최소권한 아님(비밀번호·토큰은 없음을 실측) ⑶`harnessTaskId`가 non-empty 검사만 되고 대응 원천 필드와 대조되지 않음(기존 설계 한계).

## 범위(책임자 2026-08-19 16:47 확정 = «가»)

좌석 증명은 배정 기록(dispatch)이 생긴 **뒤**라야 판정할 수 있다. 배달기는 엔진마다 순서가 다르다:

- **codex 경로(REVIEW)** — 배정 기록 생성 → **(빈 창)** → `terminal send`로 "go" 전달. **이 창에서 거부하면 워커는 시작조차 안 한다 — 진짜 거부(reject-before-start).**
- **claude 경로(CODER·VERIFY)** — `dispatch --inject`가 배정 기록 생성과 워커 시작을 한 번에 한다. **막을 창이 없다 — 실패해도 이미 시작된 뒤다. 감지 후 즉시 중단·경보(detect-then-abort)만 가능하다.**

`--inject` 사용 형태(claude 경로가 계속 `--inject`를 쓰는 것)는 이 라운드에서 바꾸지 않았다(coder-task.md §1-1 비타협 — 별건 HYK-322로 기각·등재됨).

## 부품 계약 (실측)

`scripts/relay/seat-proof-cli.mjs`(HYK-294, 이미 병합됨)를 그대로 쓴다 — 이 라운드에서 그 파일을 한 글자도 고치지 않았다.

- 종료코드: **0 = PROVEN**, **2 = 그 외 전부**(거부·입력 불량·「알 수 없음」 포함, fail-closed).
- 필수 인자 3개: `--dispatch-show <path|->` · `--terminal-show <path|->` · `--expected <path|->`. `-`(stdin)는 셋 중 최대 하나에만 쓸 수 있다.
- 비타협 경고(부품 헤더): `--expected`를 `--terminal-show`에서 파생시키면 "자기 자신과 비교"하는 동어반복이 된다.

## 저장소 쪽 준비 (§4-1) — 새 파일 `scripts/relay/dispatch-worker-seat-proof-gate.mjs`

`seat-proof-cli.mjs`를 고치지 않고, 그 앞에 얇은 진입점을 하나 더 뒀다. 이 진입점이 하는 일은 **딱 하나**: ps1이 이미 알고 있는 배정 의도 다섯 필드(`--harness-task-id` / `--runtime-task-id` / `--dispatch-id` / `--worktree-id` / `--worktree-path`)를 이 프로세스 **안에서** 조립해 `seat-proof-cli.mjs`의 `--expected` 슬롯에 stdin으로 먹인다. `--dispatch-show`/`--terminal-show`는 파일 경로 그대로 넘길 뿐, 이 진입점은 그 두 파일의 **내용을 읽지 않는다** — `buildExpected()` 함수는 `fs`를 아예 import하지 않는다(구조적으로 "expected를 terminal-show에서 파생시키는" 동어반복이 이 진입점 자체에서는 발생할 수 없다).

새 CLI(요약):

```
node scripts/relay/dispatch-worker-seat-proof-gate.mjs \
  --dispatch-show <path> --terminal-show <path> \
  --harness-task-id <label> --runtime-task-id <task_...> --dispatch-id <ctx_...> \
  --worktree-id <worktreeId> --worktree-path <worktreePath>
```

종료코드는 `seat-proof-cli.mjs`와 동일(0=PROVEN, 2=그 외 전부). 인자 결손·미인식도 exit 2(`GATE_ARGS_MISSING`/`GATE_ARGS_UNRECOGNIZED`).

### ★정직 한계 — worktreeId 축은 부분 동어반복이다 (숨기지 않고 명시)

실측(`orca terminal show`): `worktreeId` = `"<세션 guid>::<워크트리 경로>"`(예: `e841ec57-d1b5-4be0-a44b-2023793e7d33::C:/Users/.../hyk299-seatproof-3`). guid 부분을 ps1이 사전에 독립적으로 알 방법이 없다(정적 레지스트리를 저장소·관제실 어디에서도 찾지 못했다 — 이 라운드에서 새로 만들지 않았다, §0 비타협9 "즉흥 수리 금지"에 준해 판단 로직을 새로 짓지 않았다). 그래서 이번 결선에서는:

- **`worktreePath` 축은 진짜 독립이다** — `$Worktree`(ps1이 스크립트 시작부터 아는 파라미터, `Norm`으로 orca의 슬래시 표기와 맞춘다)를 그대로 쓴다. `--terminal-show`에서 파생시키지 않는다.
- **`worktreeId` 축은 방금 뜬 `--terminal-show` 자신에서 취한다** — 이 축 하나는 "자기 자신과 비교"하는 동어반복이다(부분적). **판정의 진짜 힘은 다른 두 축에 있다**: ⑴신원 축(harnessTaskId=`$label` / runtimeTaskId=`$Task` / dispatchId=배정 기록 id — 셋 다 ps1이 dispatch-show/terminal-show 밖에서 이미 알고 있는 값) ⑵pane-key 축(`dispatch-show`의 `assignee_pane_key` vs **`--terminal-show`가 아니라 dispatch-show라는 별도 소스**의 `${tabId}:${leafId}` 완전 일치 — 이 축은 여전히 진짜 독립 대조다).
- 잔여: worktreeId 축을 진짜 독립으로 만들려면 "핸들→워크트리id" 정적 매핑을 관제실 또는 저장소에 새로 두어야 한다 — 이 라운드 범위 밖(다음 트랙 후보로 gap 문서에 남긴다).

## 삽입 위치

**교체 대상** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` **368~406행**(coder-task.md §3-B 발췌 원문과 100% 동일 — ORCH가 §3 원문과 대조해 위치를 재확인하라).

- **구간 시작 앵커**: `# ── 현행 [2/3] 배정 기록 생성 (dispatch) 본문은 여기서부터 그대로 유지 ──────────` 줄(교체 블록의 첫 줄이기도 하다 — 문자 그대로 다시 쓴다).
- **구간 끝 앵커**: `Write-Host "[3/3] OK — 워커가 dispatch-show로 대조 후 기동합니다."` 줄(교체 블록의 마지막 줄).
- 새로 추가된 것: ⑴새 함수 `Invoke-SeatProofGate`(구간 시작 직후, `Write-Host "[2/3] ..."` 줄 **앞**) ⑵claude 분기 안 `Record-DispatchReceipt ...` 줄 **뒤** · 기존 `[3/3]` 줄 **앞**에 `[2.5/3] 좌석 증명 확인` 블록 ⑶codex 분기 안 `Record-DispatchReceipt ...` 줄 **뒤** · 기존 `[2.5/3] codex 입력 정리...` 줄 **앞**에 `[2.4/3] 좌석 증명 확인` 블록.
- 바뀌지 않는 줄: `Invoke-Dispatch` 호출·`DISPATCH_FAILED` 처리·`Record-DispatchReceipt` 호출·codex의 `go` 텍스트 조립/terminal send·`[3/3]` 마무리 줄 — 전부 문자 그대로 유지했다(순서 재배치 없음, 새 블록을 끼워 넣기만 했다).

## codex=거부 / claude=감지-중단 의미가 어디서 나오는가

ps1 코드 자체는 두 분기 모두 **똑같은 패턴**이다(`Invoke-SeatProofGate` 호출 → 0이 아니면 `Write-Error` + `exit 7`) — **판단 로직을 분기마다 다르게 두지 않았다**(coder-task.md §3-C "관제실에 판단 로직을 넣지 마라"). 의미의 차이는 순전히 **그 호출이 어디 놓였는가**에서 나온다:

- **claude 분기**: `Invoke-Dispatch $Task $handle $true`(`--inject`, 배정+시작 한 번에) **뒤**에 검사한다 — 실패 시점엔 이미 워커가 떠 있다. 그래서 이 경로의 실패는 "감지 후 중단·경보"다(coder-task.md §1-2 문면 그대로 — 라운드 정지, 산출물 무손상, 즉흥 재배달 금지).
- **codex 분기**: `Invoke-Dispatch $Task $handle $false`(`--inject` 없음, 배정 기록만) **뒤**·`terminal send`로 "go" 텍스트를 보내기 **전**에 검사한다 — 실패하면 `terminal send` 자체가 실행되지 않으므로 워커는 시작조차 안 한다. **진짜 거부다.**

## 교체 후 exit code

- `exit 6` = `DISPATCH_FAILED`(기존, 무변경).
- `exit 7` = `SEAT_PROOF_REJECTED`(신규, HYK-299) — claude/codex 공통, 의미는 위 절 그대로 위치로 갈린다.
- `exit 8` = `SEAT_PROOF_CLI_MISSING`(신규, HYK-299) — 게이트 CLI 자체가 이 워크트리에 없으면 fail-closed(HYK-217/HYK-224/HYK-219 게이트들의 `*_CLI_MISSING`/`*_MISSING` 관례와 동일한 모양).

## PowerShell 파싱 검사 (출력 원문)

교체 블록을 워크트리 안 임시 파일 `.harness/tmp-hyk299-replacement-block.ps1`에 쓰고 `[System.Management.Automation.Language.Parser]::ParseFile()`로 구문 검사했다(이 임시 파일은 coder-task.md §0 비타협5에 따라 지우지 않고 그대로 둔다):

```
$path = ".harness\tmp-hyk299-replacement-block.ps1"
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -eq 0) { "PARSE_OK: 0 errors" } else { $errors | ForEach-Object { $_.ToString() } }
```

출력:

```
PARSE_OK: 0 errors
```

## 교체 전 원문 (368~406행, coder-task.md §3-B 그대로 — 발췌 아님)

구간 SHA-256(coder-task.md §3-B 명시) = `219f57f9992fa909b28bd0526935a7bf2bd514ec1cf162a393f0bbfa8a65cb3b`

```powershell
# ── 현행 [2/3] 배정 기록 생성 (dispatch) 본문은 여기서부터 그대로 유지 ──────────

Write-Host "[2/3] 배정 기록 생성 (dispatch)"
if ($engine -eq "claude") {
  # claude: --inject가 붙여넣기+제출 일체로 정상 동작(D6).
  $out = Invoke-Dispatch $Task $handle $true
  if (-not $out.ok) { Write-Error "DISPATCH_FAILED: $($out.error.message)"; exit 6 }
  Write-Host "      dispatch id=$($out.result.dispatch.id) injected=$($out.result.injected)"
  Record-DispatchReceipt $out $receiptCliPath $Role $label $ReceiptPath
}
else {
  # codex: --inject가 입력을 깨뜨린다(D11) → 배정 기록만 만들고(--inject 없이),
  # 텍스트는 깨끗한 terminal send로 전달한다(PM 좌석에서 검증됨).
  $out = Invoke-Dispatch $Task $handle $false
  if (-not $out.ok) { Write-Error "DISPATCH_FAILED: $($out.error.message)"; exit 6 }
  Write-Host "      dispatch id=$($out.result.dispatch.id) (inject 안 함 — codex 깨끗 배달)"
  Record-DispatchReceipt $out $receiptCliPath $Role $label $ReceiptPath

  Write-Host "[2.5/3] codex 입력 정리 후 'go' 깨끗 전달"
  # D13(2026-07-22): codex 좌석은 런처가 worker-dispatch-rule을 시스템 프롬프트로 안 싣는다
  # (claude만 --append-system-prompt). 바닐라 codex에 "go"만 가면 뜻을 몰라 idle. → 기동 규칙+
  # 역할 task 파일 포인터를 첫 입력으로 함께 전달한다(어댑터 deliverTask도 codex엔 이 지침을
  # 실어야 함 — 범위3에서 정식화). claude는 --append-system-prompt+inject preamble로 이미 받음.
  $lower = $Role.ToLower()
  if ($Role -eq "PM") {
    $goText = "너는 하네스 [PM] 기획 에이전트다(무인 좌석). 먼저 위조확인: orca orchestration dispatch-show --task $Task --json 실행해 result.dispatch.assignee_pane_key가 이 좌석 환경변수 ORCA_PANE_KEY와 일치하는지 대조하고, 결과 파일 맨 위에 3줄(dispatch_verified/task_id_from_dispatch/pane_match) 기록. 일치할 때만 진행. 지침은 오직 D:\문서관리\하네스-관제실\PM\relay\pm-task.md, 규약은 D:\문서관리\하네스-관제실\PM\PM-부팅블록.md(증거 우선·추측 금지·repo/Linear 쓰기 금지·HYK-112 재시도금지). 결과는 D:\문서관리\하네스-관제실\PM\relay\pm.md에 상단 task_id 에코 + 마지막 줄 '>>> DONE: PM @ 실제시각KST' 로 쓰고, 그다음 D:\문서관리\하네스-관제실\STATUS.md 1절 PM 행만 갱신. go $label"
  } else {
    $goText = "너는 하네스 릴레이 [$Role] 워커다. D:\문서관리\하네스-관제실\worker-dispatch-rule.md를 읽고 1절대로 위조확인하라: orca orchestration dispatch-show --task $Task --json 실행해 result.dispatch.assignee_pane_key가 이 좌석 환경변수 ORCA_PANE_KEY와 일치하는지 대조하고 결과 파일 맨 위에 3줄(dispatch_verified/task_id_from_dispatch/pane_match) 기록. 그다음 .harness/$lower-task.md 지침대로 수행(코드 수정은 그 지침 범위 내). 결과는 .harness/$lower.md에 task_id 에코 + 마지막 줄 '>>> DONE: $Role @ 실제시각KST' 로 쓰고, STATUS.md 1절 $Role 행만 갱신. go $label"
  }
  # D15: --interrupt(Ctrl-C) 제거 — idle codex에 보내면 codex가 종료된다(실측 사고). codex 경로는
  # --inject를 안 쓰므로 애초에 정리할 escape 쓰레기가 없다(D11 junk는 --inject 전용).
  & orca terminal send --terminal $handle --text $goText --json | Out-Null
  Start-Sleep -Milliseconds 500
  & orca terminal send --terminal $handle --enter --json | Out-Null
  Write-Host "      codex 기동 지침(규칙+task 포인터)+go $label 전송 + Enter"
  if (-not $GoLabel) { Write-Host "      ⚠ -GoLabel 미지정 — 런타임 id로 보냈다. 워커 §2 불일치로 거부될 수 있다." }
}

Write-Host "[3/3] OK — 워커가 dispatch-show로 대조 후 기동합니다."
```

## 교체 후 문면 (ORCH가 그대로 복사해 붙이면 되는 형태)

정본 텍스트는 워크트리 안 임시 파일 `.harness/tmp-hyk299-replacement-block.ps1`에 그대로 있다(§0 비타협5에 따라 지우지 않고 남겨뒀다 — ORCH가 이 파일을 직접 복사해 붙여도 된다). `Get-FileHash -Algorithm SHA256`으로 실측한 SHA-256 = `651CD319D5752F3EA446073E25D693923A8B5CF589F9490DC4F6B5B297C840BF`(90줄).

아래 코드 펜스는 그 파일과 **줄 단위로 완전히 동일함을 `Compare-Object`로 직접 확인했다**(`origLines=90 docLines=90`, 차이 0줄 -- `LINES_IDENTICAL`). 바이트 단위 SHA-256을 마크다운 펜스 텍스트 자체에 대해서는 별도로 고정하지 않는다 -- 마크다운 렌더링·인코딩(BOM 유무)이 원본 `.ps1` 파일과 달라질 수 있어(펜스 앞뒤 공백줄 등) 바이트 해시만으로는 "내용이 같다"를 강제하지 못하고 오히려 거짓 불일치를 만들 수 있다는 것을 이번에 직접 실측으로 확인했다(1차 계산 시 해시가 달랐다 -- 원인 추적 결과 펜스 여는 줄 뒤 빈 줄 1개 차이였고, 내용 자체는 한 글자도 다르지 않았다). **ORCH는 이 펜스가 아니라 `.harness/tmp-hyk299-replacement-block.ps1` 파일을 정본으로 복사하라** -- 그 파일의 SHA-256이 위 값이다.

<!-- HYK-299-REPLACEMENT-BEGIN -->

```powershell
# ── 현행 [2/3] 배정 기록 생성 (dispatch) 본문은 여기서부터 그대로 유지 ──────────

# HYK-299(2026-08-19, gap#55 결선): 좌석 증명(scripts/relay/
# dispatch-worker-seat-proof-gate.mjs -> seat-proof-cli.mjs 그대로 재사용)을
# 배달기에 결선한다. 판단은 전부 저장소 CLI 몫이다(관제실은 ⑴dispatch-show/
# terminal-show를 파일로 뜨고 ⑵CLI를 부르고 ⑶종료코드로만 분기하는 얇은
# 껍데기). 범위(2026-08-19 16:47 책임자 확정 «가»): codex 경로는 배정 기록
# 생성 → (빈 창) → terminal send 순서라 이 창에서 거부하면 워커는 시작조차
# 안 한다(진짜 거부). claude 경로는 dispatch --inject가 배정 기록 생성과
# 워커 시작을 한 번에 하므로 막을 창이 없다 -- 실패해도 이미 시작된 뒤이므로
# 감지 후 중단·경보만 가능하다(라운드를 더 진행하지 않는다, 이미 만들어진
# 배정 기록·영수증은 건드리지 않는다, 재배달 같은 즉흥 복구를 넣지 않는다).
function Invoke-SeatProofGate([string]$dispatchId) {
  $gateCliPath = Join-Path $Worktree "scripts/relay/dispatch-worker-seat-proof-gate.mjs"
  if (-not (Test-Path $gateCliPath)) {
    Write-Error "SEAT_PROOF_CLI_MISSING: $gateCliPath 가 없다 -- 좌석 증명을 확인할 수 없으므로 배달을 계속하지 않는다(HYK-299 gap#55 기계 게이트, fail-closed)."
    exit 8
  }
  $dsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-dispatch-show.json"
  $tsShowPath = Join-Path $env:TEMP "hyk299-seatproof-$Task-terminal-show.json"
  & orca orchestration dispatch-show --task $Task --json | Out-File -FilePath $dsShowPath -Encoding utf8
  & orca terminal show --terminal $handle --json | Out-File -FilePath $tsShowPath -Encoding utf8
  # worktreeId 축은 ps1이 사전에 독립적으로 알 수 있는 값이 아니다(실측:
  # `<세션 guid>::<경로>` 형태, guid part는 ps1이 모른다) -- 이번 결선에서는
  # 방금 뜬 terminal-show 자신에서 취한다(부분 동어반복, 알려진 한계 --
  # docs/control-room-patches/HYK-299-dispatch-worker-seat-proof.md 정직
  # 한계 절 참조). worktreePath는 $Worktree(ps1이 처음부터 아는 값, Norm으로
  # orca의 슬래시 표기와 맞춘다)를 그대로 쓴다 -- 이 축은 진짜 독립이다.
  # 배정 신원 축(harnessTaskId=$label/runtimeTaskId=$Task/dispatchId)과
  # pane-key 축(dispatch-show의 assignee_pane_key vs 이 terminal-show의
  # tabId:leafId)은 전부 진짜 독립 대조다.
  $tsShowObj = Get-Content $tsShowPath -Raw | ConvertFrom-Json
  $seatProofWorktreeId = $tsShowObj.result.terminal.worktreeId
  & node $gateCliPath --dispatch-show $dsShowPath --terminal-show $tsShowPath --harness-task-id $label --runtime-task-id $Task --dispatch-id $dispatchId --worktree-id $seatProofWorktreeId --worktree-path (Norm $Worktree)
  return $LASTEXITCODE
}

Write-Host "[2/3] 배정 기록 생성 (dispatch)"
if ($engine -eq "claude") {
  # claude: --inject가 붙여넣기+제출 일체로 정상 동작(D6).
  $out = Invoke-Dispatch $Task $handle $true
  if (-not $out.ok) { Write-Error "DISPATCH_FAILED: $($out.error.message)"; exit 6 }
  Write-Host "      dispatch id=$($out.result.dispatch.id) injected=$($out.result.injected)"
  Record-DispatchReceipt $out $receiptCliPath $Role $label $ReceiptPath

  Write-Host "[2.5/3] 좌석 증명 확인 (HYK-299 gap#55 -- claude: 감지 후 중단·경보, 이미 워커는 시작됐다)"
  $seatProofExit = Invoke-SeatProofGate $out.result.dispatch.id
  if ($seatProofExit -ne 0) {
    Write-Error "SEAT_PROOF_REJECTED: 좌석 증명 실패(exit $seatProofExit) -- claude 경로는 dispatch --inject가 배정+시작을 한 번에 하므로 이미 워커가 시작된 뒤다. 이 라운드를 더 진행하지 않는다(감지 후 중단). 이미 만들어진 배정 기록·영수증은 그대로 둔다 -- 자동 재배달을 시도하지 않는다. 원인을 사람/ORCH가 확인하라."
    exit 7
  }
  Write-Host "      좌석 증명 통과(exit 0)"
}
else {
  # codex: --inject가 입력을 깨뜨린다(D11) → 배정 기록만 만들고(--inject 없이),
  # 텍스트는 깨끗한 terminal send로 전달한다(PM 좌석에서 검증됨).
  $out = Invoke-Dispatch $Task $handle $false
  if (-not $out.ok) { Write-Error "DISPATCH_FAILED: $($out.error.message)"; exit 6 }
  Write-Host "      dispatch id=$($out.result.dispatch.id) (inject 안 함 — codex 깨끗 배달)"
  Record-DispatchReceipt $out $receiptCliPath $Role $label $ReceiptPath

  Write-Host "[2.4/3] 좌석 증명 확인 (HYK-299 gap#55 -- codex: 진짜 거부, 아직 워커는 시작 전이다)"
  $seatProofExit = Invoke-SeatProofGate $out.result.dispatch.id
  if ($seatProofExit -ne 0) {
    Write-Error "SEAT_PROOF_REJECTED: 좌석 증명 실패(exit $seatProofExit) -- codex 경로는 아직 'go' 텍스트를 보내기 전이므로 여기서 막으면 워커가 시작조차 안 한다(진짜 거부). terminal send를 실행하지 않고 배달을 중단한다."
    exit 7
  }
  Write-Host "      좌석 증명 통과(exit 0) — 'go' 전달을 계속한다"

  Write-Host "[2.5/3] codex 입력 정리 후 'go' 깨끗 전달"
  # D13(2026-07-22): codex 좌석은 런처가 worker-dispatch-rule을 시스템 프롬프트로 안 싣는다
  # (claude만 --append-system-prompt). 바닐라 codex에 "go"만 가면 뜻을 몰라 idle. → 기동 규칙+
  # 역할 task 파일 포인터를 첫 입력으로 함께 전달한다(어댑터 deliverTask도 codex엔 이 지침을
  # 실어야 함 — 범위3에서 정식화). claude는 --append-system-prompt+inject preamble로 이미 받음.
  $lower = $Role.ToLower()
  if ($Role -eq "PM") {
    $goText = "너는 하네스 [PM] 기획 에이전트다(무인 좌석). 먼저 위조확인: orca orchestration dispatch-show --task $Task --json 실행해 result.dispatch.assignee_pane_key가 이 좌석 환경변수 ORCA_PANE_KEY와 일치하는지 대조하고, 결과 파일 맨 위에 3줄(dispatch_verified/task_id_from_dispatch/pane_match) 기록. 일치할 때만 진행. 지침은 오직 D:\문서관리\하네스-관제실\PM\relay\pm-task.md, 규약은 D:\문서관리\하네스-관제실\PM\PM-부팅블록.md(증거 우선·추측 금지·repo/Linear 쓰기 금지·HYK-112 재시도금지). 결과는 D:\문서관리\하네스-관제실\PM\relay\pm.md에 상단 task_id 에코 + 마지막 줄 '>>> DONE: PM @ 실제시각KST' 로 쓰고, 그다음 D:\문서관리\하네스-관제실\STATUS.md 1절 PM 행만 갱신. go $label"
  } else {
    $goText = "너는 하네스 릴레이 [$Role] 워커다. D:\문서관리\하네스-관제실\worker-dispatch-rule.md를 읽고 1절대로 위조확인하라: orca orchestration dispatch-show --task $Task --json 실행해 result.dispatch.assignee_pane_key가 이 좌석 환경변수 ORCA_PANE_KEY와 일치하는지 대조하고 결과 파일 맨 위에 3줄(dispatch_verified/task_id_from_dispatch/pane_match) 기록. 그다음 .harness/$lower-task.md 지침대로 수행(코드 수정은 그 지침 범위 내). 결과는 .harness/$lower.md에 task_id 에코 + 마지막 줄 '>>> DONE: $Role @ 실제시각KST' 로 쓰고, STATUS.md 1절 $Role 행만 갱신. go $label"
  }
  # D15: --interrupt(Ctrl-C) 제거 — idle codex에 보내면 codex가 종료된다(실측 사고). codex 경로는
  # --inject를 안 쓰므로 애초에 정리할 escape 쓰레기가 없다(D11 junk는 --inject 전용).
  & orca terminal send --terminal $handle --text $goText --json | Out-Null
  Start-Sleep -Milliseconds 500
  & orca terminal send --terminal $handle --enter --json | Out-Null
  Write-Host "      codex 기동 지침(규칙+task 포인터)+go $label 전송 + Enter"
  if (-not $GoLabel) { Write-Host "      ⚠ -GoLabel 미지정 — 런타임 id로 보냈다. 워커 §2 불일치로 거부될 수 있다." }
}

Write-Host "[3/3] OK — 워커가 dispatch-show로 대조 후 기동합니다."
```

<!-- HYK-299-REPLACEMENT-END -->

## 남은 것 (다음 트랙 후보)

1. worktreeId 축을 진짜 독립으로 만들려면 핸들→워크트리id 정적 매핑이 필요하다(위 "정직 한계" 절) — 이 라운드 범위 밖.
2. `dispatch-worker.ps1` 자체는 이 저장소의 CI·PR 강제 밖이다(HYK-256 문서와 같은 정직 한계 — ORCH의 적용 보고가 유일한 신뢰 근거다).
3. 관제실 적용은 사람 게이트(ORCH 몫) — 이 문서는 "제안"이며, ORCH가 실제로 파일에 붙여넣고 파싱 검사한 뒤에만 "APPLIED"로 갱신돼야 한다.
