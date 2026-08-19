# HYK-306 — `dispatch-worker.ps1` GoLabel 조용한 대체 제거 (fail-closed)

## 적용 상태: **PROPOSED**

이 문면은 아직 관제실에 적용되지 않았다. 적용은 ORCH 몫이다(coder-task.md §0 항2 — 이 워크트리는 `D:\문서관리\하네스-관제실\`에 쓰지 않는다).

## 결함

2026-08-18 HYK-285 배달에서 ORCH가 `-GoLabel`을 빠뜨렸다. `dispatch-worker.ps1`이 **조용히** 하네스 이름표 자리에 기계 내부 런타임 id(`task_ac822047b14d`)를 채워 넣었고(`$label = if ($GoLabel) { $GoLabel } else { $Task }`), 그 값이 admission 원장·영수증·좌석 증명·codex `go` 텍스트·`--task-id`까지 흘러갔다. 소비 결속 게이트가 하네스 이름(`HYK-285-wake-1`)으로 영수증을 찾으므로 영구 불일치가 났고 2R 배달이 거부됐다(게이트 자체는 옳게 작동). REVIEW 배달에도 같은 사고가 1건 더 있었다.

이 파일에는 이미 "생략 시 런타임 id가 들어가 사실상 필수"라는 경고 주석(옛 34~39행)과 배달 막바지의 경고 전용 줄(옛 454행)이 있었지만, 둘 다 **거부하지 않고 경고만** 했다 — 그래서 사고를 막지 못했다. 문서 경고 ≠ 기계 강제.

## 설계

coder-task.md §2의 틀("판단은 저장소, 관제실은 얇은 껍데기") 그대로 적용했다:

1. **관제실 변경은 "조용한 대체 한 줄을 없애는 것"뿐이다.** `$label = if ($GoLabel) { $GoLabel } else { $Task }` → `$label = $GoLabel`. 대체가 사라지므로 `$GoLabel`이 비어 있으면 `$label`도 비게 된다 — 관제실은 그 값이 "유효한지" 스스로 판단하지 않는다.
2. **판정 로직은 전부 저장소 `scripts/supervisor/admission-cli.mjs`에 둔다** (`admit` 서브커맨드, `--reservation-id` 인자 — 이미 `$label`을 받는 기존 CLI다). 이 CLI는 `$label`이 흘러가는 지점들 중 **가장 이르다**(관제실 실측: admit 호출이 `orca orchestration dispatch` 호출보다 앞, 영수증 CLI·좌석 증명·codex `go` 텍스트보다도 앞) — 그래서 여기서 막으면 배달 자체가 생성되지 않는다(admission-cli.mjs 자신의 기존 주석대로 "exit 0은 ADMITTED 전용, BLOCKED/STATE_UNAVAILABLE/USAGE는 항상 nonzero"이고 관제실은 `$LASTEXITCODE -ne 0`만 보고 이미 멈춘다 — 새 판정 코드를 관제실에 추가할 필요가 없다).
3. `admit`의 `--reservation-id` 검사에 두 가지를 추가했다: ⑴빈 값 ⑵런타임 id 모양(`^task_[0-9a-f]+$`, 대소문자 무관 — `orca orchestration dispatch-show`가 실제로 내는 id 형식을 실측해 고정). 실패 시 사람이 읽고 바로 원인을 알 수 있는 구체적 사유를 stderr에 찍는다(기존의 뭉뚱그린 usage 문구 대신).
4. 새 판정 모듈을 만들지 않았다 — `admission-cli.mjs` 안의 순수 함수(`validateHarnessLabel`) 하나로 충분했다(§4-1 "남발 금지" 지시 따름). `dispatch-receipt-cli.mjs` 쪽은 손대지 않았다 — admit이 그보다 먼저 호출되므로(관제실 실측: admit 220행대 vs 영수증 244행대) 그 지점이 이미 배달을 막는다.

## 3-C 처리 (경고 전용 줄)

옛 454행의 `if (-not $GoLabel) { Write-Host "⚠ -GoLabel 미지정 — 런타임 id로 보냈다. 워커 §2 불일치로 거부될 수 있다." }`는 **삭제한다.**

이유: 이 줄은 스크립트 실행 순서상 admission-cli `admit` 호출(옛 220행대, 위 §설계 항2)보다 **한참 뒤**에 있다. `$GoLabel`이 비어 있으면 `$label`도 비고, 그 `$label`이 `admit --reservation-id`로 전달되는 순간 이미 usage 오류(exit 2)로 스크립트가 `Write-Error`를 거쳐 중단된다 — 실행이 옛 454행에 **도달할 수 없다.** "거부될 수 있다"는 이제 "이미 거부됐다"이므로, 도달 불가능한 경고 문구를 남겨 두면 마치 이 상태가 여전히 "선택적 위험"인 것처럼 오독을 유발한다. 조용히 지우지 않고 여기 문서에 판단 근거를 남긴다.

## 교체 대상 (coder-task.md §3 전문 그대로, ORCH 실측)

관제실 파일: `D:\문서관리\하네스-관제실\dispatch-worker.ps1` (**573줄** · SHA-256 `8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58` — **이 워크트리가 2026-08-19 21:49:47 KST에 `Get-FileHash`/`ReadAllLines`로 직접 재측정**. REVIEW r1(`.harness/review-r1-원문.md` §2 독립 기준선 실측)이 적은 값과 정확히 일치한다).

⚠️ **행 번호는 위 재측정 시점(2026-08-19 21:49 KST) 기준 참고용일 뿐이다** — 그 사이 다른 수정이 들어오면 다시 이동할 수 있다. 실제 적용 대조는 각 항의 **앵커 문자열**(3-A는 앵커 + 구간 지문)로 하라, 행 번호로 하지 마라.

**HYK-323 사실**: 이 파일은 2026-08-19 19:11 KST에 HYK-323(좌석 증명 래퍼) 비상 직수리로 한 번 변경됐다(관제실 커밋 `00f78f0`, 현재 401행부터 410행까지). 이 워크트리가 직접 읽어 확인했다 — 이 구간은 아래 교체 대상 구간(195행부터 199행까지, 462행)과 겹치지 않는다.

### 3-A · 앵커: `$label = if ($GoLabel) { $GoLabel } else { $Task }` (현재 기준 197행 · 2026-08-19 21:49 KST 실측) · 구간 SHA-256 `e0781bbe72f4a0dd8e30e2c2ad76c3873ca992df5302e4ceeb90d3641e85ad28` (재측정 일치 — 아래 참조)

앵커: 교체 대상 줄은 `$label = if ($GoLabel) { $GoLabel } else { $Task }`. 이 워크트리가 직접 grep해 파일 전체에서 **1회만 매치**함을 확인했다(197행). 실제 적용은 **행 번호가 아니라 이 앵커 문자열 + 아래 구간 지문**으로 대조하라 — 197이라는 행 번호는 위 실측 시점 기준 참고일 뿐이다. 이 워크트리가 직접 195~199행(현재 실물)을 읽어 LF·마지막 개행 포함으로 재해시한 결과 위 구간 SHA-256과 **정확히 일치**했다 — REVIEW r1이 §2에서 적은 값과도 같다. 실제 파일에는 들여쓰기가 없다 — 아래 펜스는 읽기용으로만 들여썼던 원본을 그대로 옮겼다.

**교체 전:**

```powershell
}

$label = if ($GoLabel) { $GoLabel } else { $Task }

# HYK-224 (coder-task.md §1/§3, PM 항 4 TOCTOU): 배달 전 «원자 입장» 확인 --
```

**교체 후** (SHA-256 `9ab9f147d79f018d0eba3426a22f538393b814f9dc6b1e962ff0b930d0ac5ae1`, 113B):

```powershell
}

$label = $GoLabel

# HYK-224 (coder-task.md §1/§3, PM 항 4 TOCTOU): 배달 전 «원자 입장» 확인 --
```

바뀐 것은 가운데 한 줄뿐이다 — `if (...) {...} else {...}` 조용한 대체가 사라지고 `$GoLabel`을 그대로(무조건) 대입한다.

### 3-B · `param()` 블록의 `-GoLabel` 주석 (현재 기준 35~39행 · 2026-08-19 21:49 KST 실측)

앵커: `[string]$GoLabel,` 선언 바로 위 주석 블록. 시작 앵커 문자열 = `# 워커가 받을 'go' 라벨` — 이 워크트리가 직접 grep해 파일 전체에서 1회만 매치함을 확인했다(35행). 적용은 행 번호가 아니라 이 앵커로 하라.

**교체 전:**

```powershell
    # 워커가 받을 'go' 라벨 = task 파일 첫 줄의 harness task_id(예 HYK-170-review-1). 워커 규칙 §2가
    # 전달 문구의 go <label>과 파일 task_id 일치를 요구한다. 생략 시 $Task(런타임 id)를 쓰지만,
    # 그러면 §2 불일치로 거부되므로 codex 배달에는 사실상 필수. (claude --inject는 preamble에
    # spec이 그대로 들어가 무관.)
    [string]$GoLabel,
```

**교체 후** (SHA-256 `1c5987c7211762a92291aaee79b7079a9f09540cbf1ff2895564e24415d1c03a`, 632B):

```powershell
    # 워커가 받을 'go' 라벨 = task 파일 첫 줄의 harness task_id(예 HYK-170-review-1). 워커 규칙 §2가
    # 전달 문구의 go <label>과 파일 task_id 일치를 요구한다. HYK-306(2026-08-19)부터 이 값은
    # 조용히 대체되지 않는다 -- 생략하거나 런타임 id(task_...) 모양이면 scripts/supervisor/
    # admission-cli.mjs의 admit이 배달 전에 사유를 stdout/stderr에 찍고 usage(exit 2)로 거부한다
    # (HYK-224 원자 입장 게이트를 아예 통과하지 못한다). (claude --inject는 preamble에
    # spec이 그대로 들어가 무관.)
    [string]$GoLabel,
```

### 3-C · 경고 전용 줄(옛 454행 → 현재 기준 462행 · 2026-08-19 21:49 KST 실측 — HYK-323 삽입분(401~410행)이 앞에 끼면서 8행 이동) — **삭제**

앵커: `GoLabel 미지정` 문자열. 이 워크트리가 직접 grep해 파일 전체에서 1회만 매치함을 확인했다(462행). 적용은 행 번호가 아니라 이 앵커로 하라.

**교체 전:**

```powershell
    if (-not $GoLabel) { Write-Host "      ⚠ -GoLabel 미지정 — 런타임 id로 보냈다. 워커 §2 불일치로 거부될 수 있다." }
```

**교체 후:** (없음 — 줄 자체를 삭제한다. 위 "3-C 처리" 절 참조.)

## 회귀 없음의 근거 (저장소 쪽 실측)

관제실 파일은 이 워크트리 밖이라 CI가 검증 못 한다(정직 한계). 대신 저장소 쪽 `admission-cli.mjs`의 새 게이트는 아래 시험으로 실행 증명했다(경로: `scripts/supervisor/admission-cli-golabel-fail-closed.test.mjs`, `.harness/coder.md` §결과 참조):

- 빈 이름표 → usage(exit 2) + 구체적 사유 stderr 출력.
- 런타임 id 모양(`task_ac822047b14d`) → usage(exit 2) + 구체적 사유 stderr 출력 (2026-08-18 실사고의 정확한 형태).
- 정상 하네스 이름표(`HYK-306-label-1`) → 기존과 동일하게 통과(`CAP_ADMITTED`).
- 기존 `admission-cli.test.mjs` 16건 전부 그대로 통과 — cap 판정·원장 판정·동시성 경합 등 기존 동작 불변.
- 변이 검증: `admit` 안의 새 검사 두 줄을 지우면 위 RED 두 시험이 그대로 죽는다(직접 확인, 복구 완료).

## 정직 한계

HYK-306-label-2(이 라운드)는 coder-task.md §0 항2 예외로 관제실 파일 **읽기**가 허용되어, 위 전체 지문·행수·앵커 행 번호·195~199행 구간 지문을 이 워크트리가 `Get-FileHash`/`ReadAllLines`로 **직접 재측정**했다(2026-08-19 21:49 KST) — REVIEW r1의 §2 독립 기준선 실측과 정확히 일치한다. 다만 이 워크트리는 여전히 관제실 파일에 **쓰지 않는다** — 실제로 이 문면을 적용하고 적용 전/후 지문을 대조하는 일은 ORCH 몫이다(HYK-256/HYK-299 선례와 동일한 절차). "교체 후" SHA-256(3-A `9ab9f147...`, 3-B `1c5987c7...`)은 이 워크트리가 문면 작성 시 계산한 값으로, 실제 적용 후 재대조가 필요하다.
