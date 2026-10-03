# HYK-472 패치 문서 — `dispatch-worker.ps1` 좌석 엔진 실측에 **짧은 기다림**을 넣는다

**상태: PROPOSED.** 이 문서는 관제실 라이브 파일을 쓰지 않는다. 적용은 ORCH/사람 몫이다(S7 검토 대상). 이 워크트리는 `D:\문서관리\하네스-관제실\` 에 쓰지 않는다.

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\dispatch-worker.ps1` · **SHA-256 `34f8f43cb7b80252e3cce41ef1a404f9dd678d2f7dc27752e8e7c0a63c687018`**(2026-10-03 22:4x KST 읽기 전용 측정 · 시작 시점) · 줄끝 **CRLF**(802행 전부) · BOM 없음.
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`. 이 도구는 라이브 경로를 쓰지 않는다 — `--source` 는 읽기, `--out` 만 쓴다.

## 1. 무엇이 문제인가

`dispatch-worker.ps1` 의 좌석 엔진 실측(HYK-472 1R, 라이브 **192~206행**)은 `orca terminal show` 를 **한 번** 찍고 `seat-engine-detect.mjs` 를 **한 번** 부른다. 갓 띄운 좌석은 부팅 중이라 배너 마커(Sonnet/Opus/gpt-5.6 등)가 아직 없을 수 있고, 그 한 번의 판독은 `unknown` 이 된다.

- 저장소 CLI 는 2R(이 라운드 ⓐ)에서 `unknown` 을 **거부(종료코드 2)** 로 바꿨다. 그래서 배달기는 이제 `unknown` 에서 멈춘다(`ENGINE_DETECT_FAILED` · exit 9) — **엔진을 추측하지 않는다**는 목표는 ⓐ만으로 성립한다.
- 그러나 ⓐ만 있으면 **부팅 직후 배달은 멈추기만 하고** 좌석이 몇 초 뒤 마커를 찍어도 그 배달은 되살아나지 않는다(사고 계기: 2026-10-03 좌석 생성 **수 초 뒤** 배달 → `measured:"unknown"` → 입력창에 문면이 남아 ORCH 가 수동 복구). 이 문서는 **거부를 덜 자주 만나게** 하는 보강이다.

## 2. 불변식

> **P**: `unknown` 은 «추측으로 메우기»도, «바로 포기»도 아니다. **상한 안에서 다시 읽고**, 상한을 넘기면 **거부**한다(기존 fail-closed 경로 · 새 종료코드 없음). 재시도 중에도 엔진은 **실측값으로만** 정해진다.

## 3. 상한과 근거

| 항목           | 값                                                           | 근거                                                                                                                         |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 시도 횟수      | **10**                                                       | 좌석 부팅에 걸리는 시간을 **미측정**이므로 넉넉히 잡되 무한대는 아니다                                                       |
| 시도 사이 간격 | **2초**                                                      | 배너가 몇 초에 걸쳐 찍히는 것을 흡수하는 최소 간격                                                                           |
| 최대 대기      | **18초**(9회 간격) + 시도별 `orca terminal show`/`node` 시간 | ⛔**30초를 넘기지 않는다** — `orca orchestration ask` 의 30초 소켓 절단(HYK-335)보다 짧아야 배달기 자체가 먼저 끊기지 않는다 |

⚠️ **정직 한계**: 좌석이 상한(18초) **안에** 마커를 찍는지는 **미측정**이다. 이 값은 실측이 아니라 설계 상한이다. 상한 안에 찍지 않으면 이 패치는 **거부로 떨어지며**, 그 사실 자체가 정보다(= 부팅이 18초보다 느리다는 신호).

## 4. 패치 단위 (기계 추출 대상)

교체 대상은 라이브 `$engineDetectExit = …` 직전까지의 **한 번짜리 판독 6줄**이다. 그 뒤의 `foreach` · `if ($engineDetectExit -ne 0) { … exit 9 }` 는 **그대로 둔다** — 상한을 넘긴 뒤의 거부는 기존 경로가 맡는다.

```control-room-patch-unit
id: hyk472-engine-wait
mode: replace
@@ANCHOR@@
& orca terminal show --terminal $handle --json | Out-File -FilePath $engineDetectShowPath -Encoding utf8
$engineDetectShowObj = Get-Content $engineDetectShowPath -Raw | ConvertFrom-Json
$engineDetectPreviewPath = Join-Path $env:TEMP "hyk472-engine-detect-$Task-preview.txt"
Set-Content -LiteralPath $engineDetectPreviewPath -Value ([string]$engineDetectShowObj.result.terminal.preview) -Encoding utf8 -NoNewline
$engineDetectOut = & node $engineDetectCliPath --preview-file $engineDetectPreviewPath --role $Role 2>&1
$engineDetectExit = $LASTEXITCODE
@@CONTENT@@
# HYK-472 대기(2026-10-03): 좌석은 부팅 중이라 배너 마커가 아직 없을 수 있다.
# unknown 이면 짧게 기다렸다 다시 읽는다 -- 상한 10회 · 간격 2초(최대 약 18초, 30초 미만).
# 상한을 넘기면 아래 기존 ENGINE_DETECT_FAILED(exit 9) 경로로 떨어진다 = 거부. 새 종료코드 없음.
# 엔진은 실측값으로만 정해지며, 재시도 중에도 역할로 추측하지 않는다.
$engineDetectMaxAttempts = 10
$engineDetectRetrySeconds = 2
for ($engineDetectAttempt = 1; $engineDetectAttempt -le $engineDetectMaxAttempts; $engineDetectAttempt++) {
  & orca terminal show --terminal $handle --json | Out-File -FilePath $engineDetectShowPath -Encoding utf8
  $engineDetectShowObj = Get-Content $engineDetectShowPath -Raw | ConvertFrom-Json
  $engineDetectPreviewPath = Join-Path $env:TEMP "hyk472-engine-detect-$Task-preview.txt"
  Set-Content -LiteralPath $engineDetectPreviewPath -Value ([string]$engineDetectShowObj.result.terminal.preview) -Encoding utf8 -NoNewline
  $engineDetectOut = & node $engineDetectCliPath --preview-file $engineDetectPreviewPath --role $Role 2>&1
  $engineDetectExit = $LASTEXITCODE
  if ($engineDetectExit -eq 0) { break }
  if ($engineDetectAttempt -lt $engineDetectMaxAttempts) {
    Write-Host "      [HYK-472 RETRY] attempt $engineDetectAttempt/$engineDetectMaxAttempts -- 좌석 엔진 미확정, $engineDetectRetrySeconds 초 뒤 다시 읽는다"
    Start-Sleep -Seconds $engineDetectRetrySeconds
  }
}
@@END@@
```

## 5. ⚠️정직 — 이 패치가 «못» 하는 것

- **재시도는 모든 nonzero 를 대상으로 한다**(`unknown` 만이 아니다). 이 CLI 는 `unknown` 과 `PREVIEW_FILE_UNREADABLE` 둘 다 비0 으로 나오고, 배달기는 둘을 구별하지 않는다 — 두 경우 모두 짧게 다시 읽는 것이 안전하다. 그 대신 **읽기 실패도 최대 18초 지연된 뒤에야 거부된다**.
- **상한 안에 마커가 찍히는지는 미측정**이다(§3).
- **이 패치는 배달을 되살리지 않는다.** 상한 뒤의 거부는 기존 `exit 9` 그대로이므로, 이미 멈춘 배달을 자동 재개하지 않는다(재시도는 하나의 배달 안에서만 돈다).
- **호출자 측 재배달 위험**은 이 패치가 해소하지 않는다 — exit 9 를 사람/ORCH 가 재배달 신호로 오독하면 중복 배달 위험이 남는다(HYK-378 §3-1과 같은 형태, 별도 조각).
- **라이브 적용 전까지 효력이 없다.** 저장소 CLI(ⓐ)의 거부는 라이브 배달기가 이미 비0 을 fail-closed 로 받으므로 **패치 없이도** 성립한다. 이 패치는 그 위에 얹는 보강이다.

## 6. ⚠️정직 — collect·effect 시험의 한계

- **collect 시험**(`control-room-patch-apply-hyk472-engine-wait-collect.test.mjs`)은 문서가 파싱되고 before/applied fixture 를 바이트 동일하게 재현하는지만 본다 — **관제실 라이브 파일을 열지 않는다.** 라이브가 나중에 바뀌면 이 시험은 알 도리가 없고 초록으로 남는다. 이 시험이 막는 것은 저장소 안의 계약 문면 변경뿐이다.
- **effect 시험**(`…-effect.test.mjs`)은 적용본에서 **추출한 재시도 블록을 실제 pwsh 로** 돌린다. 가짜 `orca` 함수(연속 호출마다 다른 배너를 돌려주는 스텁)를 쓰되, `node` 와 `seat-engine-detect.mjs` 는 **진짜**다. 그래서 "unknown 이면 다시 읽고, 측정되면 그 값을 쓰며, 상한을 넘기면 비0 으로 끝난다"를 행동으로 잰다. 다만 **실제 좌석 부팅 시간은 재지 않는다**(스텁이 시간을 정한다).
- 이 effect 시험은 **Windows PowerShell 경로**(`$env:TEMP`)를 시험 안에서 명시적으로 설정한다 — 리눅스 CI 의 pwsh 에서도 `Join-Path` 가 없는 드라이브에서 던지지 않게 하기 위해서다(HYK-378 PR #296 교훈).
- **⚠️ 리눅스 CI 에서 재지 않았다.** effect 시험은 이 워크트리(Windows)에서만 실행했다. CI 판독은 책임자 몫이다.

## 7. 적용 절차와 왕복 검증

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 = applied fixture 바이트 동일**(collect 시험이 값으로 본다).
3. **역패치 = before fixture 바이트 동일**(collect 시험이 치환 역방향으로 본다 — 적용본의 `replace` 단위를 뒤집어 다시 적용하면 원본이 나온다).
4. 라이브 교체 → 합성 표적으로 1회 구동 확인(⛔실제 배달로 시험하지 않는다).
5. 되돌림 = 시작 SHA-256 `34f8f43c…` 의 사본 보관.

## 8. 라이브 CRLF 주의 (이 라운드에서 발견)

관제실 라이브 `dispatch-worker.ps1` 은 **CRLF** 다(802행 전부). 앵커 문서는 LF 로 적었다. `control-room-patch-apply.mjs` 는 **리터럴 LF 매치가 실패하면 같은 줄들의 CRLF 형태를 한 번 더 찾고**, 그때 내용의 줄끝도 CRLF 로 맞춘다. 리터럴 매치가 성공하는 기존 경로는 바이트가 한 글자도 바뀌지 않는다(기존 HYK-379 혼합 줄끝 fixture 가 그대로 증명한다).
