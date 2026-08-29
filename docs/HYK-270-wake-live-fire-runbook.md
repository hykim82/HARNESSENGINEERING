# HYK-270 각성 배선 라이브 발화 실험 절차서

⛔**이 절차서를 CODER는 실행하지 않는다 — ORCH가 실행한다.** 이 문서는 ORCH가 그대로 칠 수 있는 명령과 기대 관측을 적은 것이지, CODER가 라이브 좌석에 무언가를 보내는 것이 아니다.

## 0. 이 실험 전에 반드시 먼저 읽을 것

`.harness/coder.md`(이 라운드 결과 파일) §2(Q2)를 먼저 읽어라. **실측 결과, 각성 배선은 이미 라이브에서 반복 발화 중이다**(2026-08-29 14:13:30 KST 포함 최근 31회 `sent:true` 기록 확인 — `D:/문서관리/하네스-관제실/watch/wake-receipts.jsonl`. ⚠️1R은 이 시각을 "18:13:30 KST"로 4시간 오기했다 — 2R 검토가 잡아 여기서 바로잡는다). 이 절차서가 겨냥하는 것은 "한 번도 안 울렸다"를 재현하는 것이 아니라, **①합성 표적으로 발화 경로 자체를 재확인** ②**실 좌석에서 관측 가능한 흔적이 무엇인지 확정**하는 것이다.

## 1. 안전 조건 (실행 전 전부 충족돼야 함)

1. **표적 = 폐기용 좌석 하나.** ORCH 자신의 라이브 세션이나 임의 CODER/REVIEW 작업 좌석에 쏘지 않는다. 이 실험 전용으로 새로 띄운, 결과가 사라져도 무해한 좌석(orca `terminal create`로 만든 임시 좌석 등)만 표적으로 삼는다.
2. **라이브 예약작업(`OrchStallWatch`) 무접촉.** 이 실험은 그 스케줄 작업을 건드리지 않는다 — `wake-wire.mjs` CLI를 손으로 한 번 돌리는 것뿐이다(스케줄 작업은 계속 자기 주기대로 돈다).
3. **문구에 게이트 신호 0.** 전송되는 문구는 `wake-wire.mjs`의 고정 상수 `WAKE_MESSAGE`뿐이다 — 이 절차서 어디에도 그 문구를 대체하거나 덧붙이는 인자가 없다(`hyk270-wake-fire.test.mjs`의 금지어 시험이 그 상수 자체를 이미 잠갔다).
4. **실 orca CLI를 실제로 호출한다** — `--fake-exec-log` 없이 돈다는 뜻이다(그래야 "발화가 실제로 좌석에 닿는가"를 검증할 수 있다). 이 절차서의 표적이 폐기용 좌석이어야 하는 이유가 바로 이것이다.

## 2. 정확히 칠 명령 한 줄 (Windows PowerShell — 그대로 붙여넣기)

ORCH가 먼저 폐기용 좌석을 하나 만들고(기존 orca 절차대로 `orca orchestration terminal create ...` 등 — 이 문서 범위 밖) 그 handle을 얻은 뒤, 워크트리 루트(`C:/Users/Administrator/orca/workspaces/HARNESSENGINEERING/hyk270-wake-fire-1-2` 또는 병합 후에는 메인 저장소)에서 아래 **한 줄**(줄바꿈 0 — PowerShell 프롬프트에 그대로 붙여넣으면 실행된다)의 `<합성 표적 좌석 handle>`만 실제 handle로 바꿔 실행한다. 이 한 줄이 하는 일 = ⓐ이 실험 전용 임시 디렉터리·`watch.log`를 새로 만들고(⛔실물 관제실 파일 무접촉 — §0 비타협) ⓑ발화 조건(연속 2 tick `SUSPECTED_UNCONSUMED`, 두 번째 tick은 "지금"에서 1분 전 — `maxTickAgeMs=2700000`=45분 이내라 `STALE_WATCH`로 안 접힘)을 충족하는 두 줄을 그 파일에 쓰고 ⓒ`wake-wire.mjs`를 `--live`로 실행한다:

```powershell
$dir = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("hyk270-livefire-" + [guid]::NewGuid().ToString("N").Substring(0,8))); $wl = Join-Path $dir.FullName "watch.log"; $t1 = (Get-Date).ToUniversalTime().AddMinutes(-20).ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); $t2 = (Get-Date).ToUniversalTime().AddMinutes(-1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); "$t1 exit=0 verdict=PROGRESSING reason=NO_PLEDGES_RECORDED unconsumed_status=UNCONSUMED_JUDGED unconsumed_verdict=SUSPECTED_UNCONSUMED unconsumed_worst_count=1 unconsumed_worktrees=1`n$t2 exit=0 verdict=PROGRESSING reason=NO_PLEDGES_RECORDED unconsumed_status=UNCONSUMED_JUDGED unconsumed_verdict=SUSPECTED_UNCONSUMED unconsumed_worst_count=1 unconsumed_worktrees=1" | Set-Content -Path $wl -Encoding utf8; node scripts/supervisor/wake-wire.mjs --watch-log $wl --active-rounds 1 --state (Join-Path $dir.FullName "state.json") --wake-log (Join-Path $dir.FullName "wake-receipts.jsonl") --live --orch-handle <합성 표적 좌석 handle> --json
```

`--orch-handle`을 명시했으므로 좌석 후보 조회 자체는 생략된다(§1-C 경로 미시험 — 조회 경로를 함께 보고 싶다면 위 한 줄에서 `--orch-handle <...>`을 빼고 실행하되, 그 경우 MAIN_REPO_PATH에 좌석이 정확히 1개만 있어야 한다는 조건이 걸린다는 것을 유의).

이 실험이 만든 임시 경로(`$dir.FullName`)는 위 한 줄이 콘솔에 그대로 남기므로 §4(되돌리기)에서 그 값을 그대로 쓰면 된다.

## 3. 기대 관측 — 무엇이 어디에 남으면 "발화했다"인가

1. **명령 종료 코드 0**, stdout JSON의 `sent: true`, `deliveryStage: "SENT"`.
2. **표적 좌석의 입력창/대화창에 `WAKE_MESSAGE` 텍스트가 실제로 도착**하고 제출까지 됐다(직접 그 좌석 화면을 확인 — 이것이 유일한 "정말 닿았다"의 증거다. §5의 정직 한계 참조: 이 절차서의 자동 관측은 orca CLI가 `ok:true`를 돌려줬다는 것뿐이지, 그 좌석에 실제로 살아있는 사람/에이전트가 그것을 봤다는 것까지는 보장하지 않는다).
3. `--wake-log`로 지정한 임시 파일에 JSONL 한 줄이 추가되고, 그 줄의 `verdict:"WAKE"`, `sent:true`, `execMode:"live"`, `deliveryStage:"SENT"`.
4. `--state`로 지정한 임시 state.json에 `{"lastWakeAtMs": <실행 시각>}`이 쓰인다.

## 4. 되돌리기 — 이 실험이 남기는 것과 지우는 법

이 실험이 만드는 파일은 전부 ORCH가 지정한 **임시 경로**뿐이다(실물 관제실 `watch.log`/`wake-state.json`/`wake-receipts.jsonl`은 절대 건드리지 않는다 — §1 명령에 그 실물 경로를 넘기지 않는 한 자동으로 안전하다).

- 표적으로 쓴 합성 좌석: 실험이 끝나면 정리한다(orca 좌석 정리 절차 — 이 문서 범위 밖, ORCH의 기존 좌석 관리 절차를 따른다).
- 이 실험이 만든 임시 `watch.log`/`state.json`/`wake-receipts.jsonl`: 삭제한다.
- 실물 관제실 파일은 애초에 건드리지 않았으므로 되돌릴 것이 없다.

## 5. 정직 한계

- 이 절차서는 **"exec이 실제로 orca CLI를 호출해 ok:true를 받았다"**까지만 자동으로 확인한다. **"그 좌석에 살아있는 관측자가 실제로 그 문구를 봤다"**는 사람이 화면을 직접 봐야 확인된다(§3-2). 이 구별은 이 라운드 Q2가 실물 `wake-receipts.jsonl`에서 찾은 관측 공백과 같은 것이다 — 영수증은 `sent`/`deliveryStage`만 남기고 **어느 handle로 보냈는지는 남기지 않는다**(코드 실측, `wake-wire.mjs` receipt 조립부 참조). 그래서 사후에 "그때 정확히 어느 좌석으로 갔는가"를 로그만으로 재구성할 수 없다 — 이 절차서의 실시간 관찰이 그 공백을 메우는 유일한 방법이다.
- 이 절차서는 §1-C(조회 경로: `--orch-handle` 생략)까지 시험하지 않는다 — 원하면 §2의 명령에서 `--orch-handle`을 빼고 MAIN_REPO_PATH에 좌석이 정확히 1개만 있는 상태를 만들어 별도로 확인해야 한다.
