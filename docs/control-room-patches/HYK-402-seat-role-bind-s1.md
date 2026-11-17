# HYK-402 S1 — `dispatch-worker.ps1` 역할 결속 선별 결선 패치 문면 (S2 가 칠 줄)

## 적용 상태: ⛔**미적용(NOT APPLIED)** — S1 은 «저장소 코어 + CLI + 영수증 칸»까지다

이 문서는 **S2(관제실 배달기 결선 · S7 = ORCH 적용 · 실행 전 REVIEW)가 `dispatch-worker.ps1` 에 칠 정확한 줄**을 적어 둔다. S1 은 이 문서를 만들기만 하고 **관제실 파일을 한 글자도 건드리지 않는다.** 그래서 S1 병합만으로는 **살아 있는 배달이 하나도 바뀌지 않는다**(영수증 CLI 의 새 인자도 «없으면 지금과 똑같이» 동작한다).

앵커 행번호는 **2026-11-17 시점 관제실 `dispatch-worker.ps1`(839줄)** 기준이다 — S2 적용 때 다시 잰다.

| 앵커                                             | 행(2026-11-17) | 이 문서의 편집                                       |
| ------------------------------------------------ | -------------- | ---------------------------------------------------- |
| `$list = (orca terminal list --json …)` 대입 줄  | 120            | 편집 ①: 원본 JSON 문자열을 파일로도 남긴다           |
| `if ($Handle) {` ~ `AMBIGUOUS` 블록의 `exit 5 }` | 134~160        | 편집 ②: 선별을 CLI 로 넘긴다(이 블록 전체를 대체)    |
| `$handle = $seat.handle`                         | 162            | 편집 ②의 결과로 `$seat` 가 정해진 뒤 그대로 이어진다 |
| `Record-DispatchReceipt` 안 `$cliArgs = @(...)`  | 413            | 편집 ③: `--bound-seat-role` 한 쌍 추가               |

## 부품 계약 (이 라운드 실측)

- `scripts/relay/seat-role-bind-cli.mjs` — 입력 `--terminal-list <json 파일> --worktree <W> --role <CODER|REVIEW|VERIFY|PM> --registry-path <jsonl> [--handle <h>]`.
- stdout: `SELECTED handle=… pane=… role=… worktree=…` 또는 `REFUSED reason=… …` + 후보 좌석 줄(`  seat pane=… role=… state=… handle=…`).
- 종료코드: **0** SELECTED · **1** REFUSED · **2** 사용법 오류.
- 거부 사유(`reason=`): `MULTI_AGENT_SEAT_IN_WORKTREE` · `UNREGISTERED_AGENT` · `ROLE_MISMATCH` · `NO_SEAT_IN_WORKTREE` · `NO_AGENT_SEAT` · `HANDLE_NOT_IN_WORKTREE` · `HANDLE_SEAT_UNREGISTERED` · `HANDLE_SEAT_NOT_LIVE_AGENT` · `HANDLE_ROLE_MISMATCH` · `REGISTRY_LOAD_FAILED` · `TERMINAL_LIST_INVALID`.
- `scripts/relay/dispatch-receipt-cli.mjs` — 새 선택 인자 `--bound-seat-role <ROLE>`. 있으면 영수증에 `bound_seat_role` 칸이 덧붙고, `--role` 과 다르면(대소문자 무시) **원장에 한 줄도 쓰지 않고** 비0. **없으면 지금과 똑같다.**
- 이 CLI 두 개는 `orca` 를 실행하지 않는다 — 배달기가 이미 받은 `terminal list` 출력을 파일로 넘긴다(**orca 조회가 한 번도 늘지 않는다**).

## 편집 ① — `terminal list` 원본 JSON 을 파일로 남긴다 (120행)

교체 «전»:

```powershell
$list = (orca terminal list --json | ConvertFrom-Json)
```

교체 «후»:

```powershell
$listRaw = (orca terminal list --json | Out-String)
$list = ($listRaw | ConvertFrom-Json)
```

## 편집 ② — 선별을 저장소 CLI 로 넘긴다 (`$cands.Count -eq 0` 거부 블록 뒤 ~ `$handle = $seat.handle` 앞)

기존 `if ($Handle) { … } elseif ($cands.Count -eq 1) { … } else { …AMBIGUOUS… }` 블록(134~160행)을 **통째로** 아래로 바꾼다. 판단(역할 대조 · 2좌석 거부)은 전부 CLI 몫이고 여기는 «부르고 종료코드로 분기»만 한다.

```powershell
# HYK-402 S2: 역할 결속 좌석 선별 -- 판단은 저장소 CLI(seat-role-bind-cli.mjs), 관제실은 호출 + 종료코드 분기.
$seatBindCliPath = Join-Path $Worktree "scripts/relay/seat-role-bind-cli.mjs"
if (-not (Test-Path $seatBindCliPath)) {
  # 열쇠를 적는다 (HYK-472 ENGINE_DETECT_CLI_MISSING 관례, 09-16 전 레인 잠김 전례).
  Write-Error "SEAT_ROLE_BIND_CLI_MISSING: $seatBindCliPath 가 없다 -- 좌석 역할을 대조할 수 없으므로 배달을 계속하지 않는다(HYK-402 기계 게이트, fail-closed). 열쇠 = 이 CLI 를 master 에 넣은 PR 이 병합됐는지 확인하고, 됐다면 «대상 워크트리를 그 master 로 리베이스»하라. ⛔이 게이트를 무르게 고치지 마라."
  exit 9
}
$seatBindListPath = Join-Path $env:TEMP "hyk402-seat-bind-$Task-terminal-list.json"
Set-Content -LiteralPath $seatBindListPath -Value $listRaw -Encoding utf8 -NoNewline
$seatBindRegistryPath = Join-Path $PSScriptRoot "seat-launch-registry.jsonl"
$seatBindArgs = @($seatBindCliPath, "--terminal-list", $seatBindListPath, "--worktree", $Worktree, "--role", $Role, "--registry-path", $seatBindRegistryPath)
if ($Handle) { $seatBindArgs += @("--handle", $Handle) }
$seatBindOut = & node @seatBindArgs 2>&1
$seatBindExit = $LASTEXITCODE
foreach ($line in @($seatBindOut)) { Write-Host "      $line" }
if ($seatBindExit -ne 0) {
  Write-Error "SEAT_ROLE_BIND_REJECTED: 좌석 선별이 역할 결속에서 거부됐다(exit $seatBindExit, 위 REFUSED reason / 후보 pane=role 목록 참고) -- 자동 추정하지 않는다(오배송 방지). 같은 워크트리의 에이전트 좌석은 하나여야 한다. 빈 탭 · 남은 좌석을 정리하거나 올바른 -Handle 을 지정하라."
  exit 11   # ⚠️번호는 S2 적용 때 관제실 종료코드 번호 원장으로 확정(이 문서의 11 은 «현재 ps1 안에서 안 쓰인 다음 번호» 후보일 뿐 -- 원장 대조 못 함)
}
$seatBindSelected = @($seatBindOut | Where-Object { "$_" -match '^SELECTED ' }) | Select-Object -Last 1
if (("$seatBindSelected" -notmatch 'handle=(\S+)')) { Write-Error "SEAT_ROLE_BIND_OUTPUT_UNREADABLE: SELECTED 줄에서 handle 을 읽지 못했다"; exit 11 }
$seatBindHandle = $Matches[1]
if (("$seatBindSelected" -notmatch 'role=(\S+)')) { Write-Error "SEAT_ROLE_BIND_OUTPUT_UNREADABLE: SELECTED 줄에서 role 을 읽지 못했다"; exit 11 }
$boundSeatRole = $Matches[1]
$seat = @($cands | Where-Object { $_.handle -eq $seatBindHandle })[0]
if (-not $seat) { Write-Error "SEAT_ROLE_BIND_HANDLE_NOT_IN_CANDIDATES: CLI 가 고른 handle($seatBindHandle)이 이 워크트리 후보 목록에 없다"; exit 11 }
Write-Host "      [HYK-402] SELECTED pane=$($seat.tabId):$($seat.leafId) role=$boundSeatRole -- 등록부 역할 대조 통과"
```

⚠️ 이 블록이 들어가면 `-Handle` 의 의미가 바뀐다: **옛 동작**은 «목록에 있으면 무조건 통과(exit 7 만 있다)», **새 동작**은 «역할이 맞는 등록 좌석일 때만 통과»다. 같은 워크트리에 에이전트 좌석이 둘이면 **`-Handle` 로도 못 푼다**(불변식은 요청이 아니라 워크트리의 성질) — 사람의 탈출구(HYK-460 `seat-override.md` 를 인정할지)는 PM 설계 판단 1이며 **S1 은 결정하지 않았다**(S1 CLI 는 미등록 에이전트 좌석을 항상 거부한다).

## 편집 ③ — 영수증 호출에 `--bound-seat-role` 한 쌍 추가 (`Record-DispatchReceipt` 413행)

교체 «전»:

```powershell
  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath, "--harness-dir", (Join-Path $Worktree ".harness"))
```

교체 «후»:

```powershell
  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath, "--harness-dir", (Join-Path $Worktree ".harness"), "--bound-seat-role", $boundSeatRole)
```

(`$boundSeatRole` 은 편집 ②에서 정해진 스크립트 범위 변수다. 편집 ②를 거치지 않은 경로가 없는지 S2 적용 때 확인한다 — 빈 값이면 영수증 CLI 가 `--bound-seat-role needs a non-empty value` 로 **거부**하므로 조용히 누락되지 않는다.)

## 적용 순서 · 배포 위험 (PM 설계 §다-주의 승계)

1. **S1 병합 → S2 적용 → S3(인자 계약 등재).** S3 를 S2 보다 먼저 병합하면 «등재된 CLI 를 ps1 이 안 부른다»가 되어 모든 배달이 막힌다(`SCRIPT_PATH_ASSIGNMENT_NOT_FOUND`/`CALL_SITE_NOT_FOUND`).
2. S2 를 적용하는 순간 **S1 이전 base 의 워크트리는 «CLI 없음»(exit 9)으로 거부**된다. **열린 워크트리가 전부 S1 이후 master 일 때** 적용한다.
3. 영수증 CLI 의 새 인자는 같은 S1 PR 에 들어 있으므로, `seat-role-bind-cli.mjs` 가 있는 워크트리는 `--bound-seat-role` 도 안다(없는 워크트리는 편집 ②의 exit 9 에서 먼저 멈춘다).
4. HYK-392 의 «포인터 기록 실패 fail-open» 수리 자리(`dispatch-worker.ps1:249-258`)와 같은 ps1 이다 — 두 S7 패치는 **한 번에 하나씩** 적용한다.

## 정직 한계

- **이 문서는 적용되지 않았다.** S1 만으로는 어떤 배달도 거부되지 않고 어떤 영수증에도 `bound_seat_role` 이 찍히지 않는다(검증된 것은 «CLI 와 코어가 합성 입력에서 이렇게 판정한다»까지다).
- 위 PowerShell 블록은 **실행해 본 적이 없다**(PowerShell 파서 검증도 아직 못 했다 — S2 의 실행 전 REVIEW 몫). 문법·`$Matches` 사용·종료코드 번호는 **초안**이다.
- 등록부는 «런처가 정상적으로 기록했을 때»만 있고 죽은 pane 을 지우지 않는다. 손으로 띄운 에이전트 좌석 · 등록 실패 좌석은 **미등록 → 거부** 쪽(안전 쪽)으로 틀린다.
- `terminal list` 는 배달기가 [1/3] 에서 받은 스냅샷이다 — 그 뒤에 생긴 좌석은 보지 못한다(TOCTOU).
- ORCH 가 `-Role` 자체를 틀리게 주면 통과한다(gap#81 과 같은 한계). `orca orchestration dispatch` 를 배달기 밖에서 직접 치는 경로(gap#96)는 이 결선을 우회한다.
- 소비 쪽 재확인(영수증 `bound_seat_role` ↔ 등록부)은 S6(`relay-handshake.mjs`)이며 이 라운드·이 패치 밖이다.
