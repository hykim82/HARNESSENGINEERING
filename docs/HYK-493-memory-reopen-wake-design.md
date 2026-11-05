# HYK-493 F-2: 메모리 재개 재시도 깨움

## 문제

메모리 게이트(관제실 `memory-gate.ps1`)가 닫히면, 메모리가 다시 넉넉해져도
재시도는 책임자가 매시 수동으로 깨우는 것에만 의존했다 — ORCH의 예약 대기
장치는 메모리 압박으로 reap될 수 있어 신뢰할 수 없다(HYK-493 이슈 §1 "사실"
참조). 이 조각(F-2)은 기존 15분 예약 감시(`OrchStallWatch` → `watch-run.mjs`)
tick에 "게이트가 닫혀 있는데 메모리가 다시 넉넉해졌는가"를 재는 단계를
얹어, 넉넉해졌으면 ORCH에게 재시도를 알린다 — 좌석·러너·게이트 자체는
절대 띄우지 않는다(통지만).

## 데이터 흐름

```
memory-gate.ps1 (관제실, 읽기만)
  -> watch\memory-gate-state.json (v1 스키마, status/closed_at/threshold_mb/...)
       |
       v  (매 tick)
watch-run.mjs: runMemoryReopenStep
  1. 상태 파일을 읽는다(readMemoryGateState) -- 없음/파싱 실패/스키마 불일치 ->
     사유 토큰만 남기고 끝(재측 0).
  2. status !== "closed" 또는 dry_run === true -> 사유 토큰만 남기고 끝(재측 0).
  3. free 메모리 2표본(기본 os.freemem() MB, 30초 간격 -- memory-gate.ps1
     step2 A/B와 동일 리듬)을 잰다.
  4. 두 표본 모두 threshold_mb + 200MB(여유) 이상이면 -> dedupe(같은
     closed_at 재통지 금지) -> 기존 seat-escalation 통로(buildSeatEscalation
     SendCommand + run-id.json)로 "memory reopened: gate retry" 1건 전송.
  5. 그 밖(미달)엔 사유 토큰만 남기고 끝(다음 tick 재측).
       |
       v
Run coordinator (ORCH)가 escalation을 받아 게이트 재시도를 사람 깨움 없이 판단한다.
```

## 상태 파일 2개 (둘 다 `<watchDir>` 안)

- `memory-gate-state.json` -- **읽기만**. 생산자는 관제실 `memory-gate.ps1`
  하나뿐이다. 이 라운드는 이 파일을 쓰지 않는다.
- `memory-reopen-notify-state.json` -- 이 단계가 쓴다. `{ notifiedClosedAt }`
  하나만 담는다 -- 전송에 성공했을 때만 갱신된다(전송 실패는 다음 tick 재시도,
  seat-escalation 단계의 `seat-escalation-notify-state.json`과 동일 원칙).

## 사유 토큰(watch.log 꼬리 칸 `memory_reopen_reason=`에 그대로 실린다)

| 토큰                               | 뜻                                                         |
| ---------------------------------- | ---------------------------------------------------------- |
| `MEMORY_REOPEN_STATE_MISSING`      | 상태 파일이 없다                                           |
| `MEMORY_REOPEN_STATE_INVALID_JSON` | 파싱 실패                                                  |
| `MEMORY_REOPEN_SCHEMA_MISMATCH`    | `schema` 필드가 `memory-gate-state/v1`이 아니다            |
| `MEMORY_REOPEN_STATUS_NOT_CLOSED`  | `status`가 `closed`가 아니다(open/deferred/dryrun-open 등) |
| `MEMORY_REOPEN_DRY_RUN`            | `dry_run === true`                                         |
| `MEMORY_REOPEN_BELOW_LINE`         | 두 표본 중 하나라도 threshold_mb+200MB 미달                |
| `MEMORY_REOPEN_ALREADY_NOTIFIED`   | 같은 `closed_at`에 이미 통지함(dedupe)                     |
| `MEMORY_REOPEN_NO_RUN_CONFIGURED`  | `run-id.json`이 없다                                       |
| `MEMORY_REOPEN_SEND_FAILED:<사유>` | orca 호출이 실패했다(다음 tick 재시도)                     |
| (없음, `sent=true`)                | 전송 성공                                                  |

## 한계 (정직)

1. 이 단계는 "재고 알릴" 뿐이다 -- 좌석·게이트는 여전히 ORCH가 띄운다(게이트
   재측정이 진짜 판정이다, 이 단계의 free 2표본은 "다시 깨볼 만하다"는
   가벼운 재확인일 뿐 게이트 자신의 4-샘플 안정성 절차를 대신하지 않는다).
2. 상태 파일은 ORCH가 돌리는 `memory-gate.ps1`만 쓴다 -- 게이트를 그
   스크립트 밖에서 돌리면(예: 사람이 손으로 측정) 이 깨움은 일어나지
   않는다(ORCH70 §32 규약 의존).
3. 라이브 실물(실제 게이트 닫힘 → 15분 안 escalation 도착)은 이 라운드가
   증명하지 않는다 -- 이 라운드는 합성 watchDir + 가짜 exec로만 시험했다.
   병합 뒤 다음 실제 게이트 닫힘 1회가 라이브 증거다.
4. Windows에서 `os.freemem()`은 libuv `ullAvailPhys`를 돌려주며, 게이트
   자신이 재는 `\Memory\Available MBytes`와 같은 축으로 설계됐다(PM 설계
   2026-10-31 (b)④). 두 수치가 항상 동일하다는 것은 이 라운드가 직접
   재확인하지 않았다 -- 다르면 이 단계가 "재고 알릴" 판단이 게이트 자신의
   재측정과 어긋날 수 있다(그래도 최종 판정은 게이트가 다시 하므로 거짓
   재개 통지의 대가는 "헛걸음 재시도 1회"로 제한된다).
