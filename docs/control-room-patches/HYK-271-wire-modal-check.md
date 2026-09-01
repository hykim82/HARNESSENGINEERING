# HYK-271-wire — 사이드카 모달 검사기 결선 (제안 문면, 미적용)

★이 문서는 **제안**이다 — 적용은 ORCH + **S7 강화판 검토** 뒤, 사람이
한다(coder-task.md §0 "관제실 라이브 파일을 «수정»하지 마라 -- 읽기만",
§2⑶). 이 라운드는 코드로 관제실을 고치지 않았다 — 아래는 전부 **저장소
안 문서·도구·픽스처**로만 만든 "적용하면 이렇게 된다"의 기계 재현이다.

## 적용 상태: **PROPOSED** (미적용)

정본 설계는 `docs/control-room-patches/HYK-271-preflight-preview-marker.md`
§2·§2-a다 — 이 문서는 그 설계가 정한 앵커·문면을 실제 관제실 실물
텍스트에 대고 §5(HYK-327이 만든 기계 적용 도구,
`scripts/check/control-room-patch-apply.mjs`) 형식으로 옮긴 **적용
단위**다. 축 선택·조합 근거·정직 한계는 원 설계 문서를 그대로 인용하고
여기서 반복하지 않는다.

## 실측 원본 (이 라운드 CODER 좌석, 2026-09-01)

| 항목                                                       | 값                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 관제실 배달기 경로                                         | `D:\문서관리\하네스-관제실\dispatch-worker.ps1`                                                                                                                    |
| SHA-256 (읽기 전용 실측, `Get-FileHash -Algorithm SHA256`) | `4E16E2E458E98A6E9C47074D011BD5F9554412A608C8C3C6BC7116DBCD0B2482`                                                                                                 |
| 행수 (`(Get-Content ...).Count`)                           | 717줄                                                                                                                                                              |
| 측정 시각                                                  | 2026-09-01                                                                                                                                                         |
| 저장소 안 읽기 전용 사본                                   | `scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt`(위 SHA-256과 바이트 동일 — 아래 §2 실측이 이 사본을 `--source`로 썼다) |

이 문서의 적용 단위(§1)는 **이 SHA-256의 원문을 기준**으로 앵커를
잡았다. 관제실 파일이 이 값과 다르면 도구가 앵커 검색에서 자연히
fail-closed로 거부한다(§1 하단 표, 2R HYK-327 선례와 동형).

---

# §1 기계 적용 단위 (추출 대상, 정확히 1개)

design doc(`HYK-271-preflight-preview-marker.md` §2)이 정한 것: **기존
seat-proof CLI 호출 직후**, 같은 `$tsShowPath`로 새 사이드카 검사기
(`scripts/relay/dispatch-worker-modal-check.mjs`)를 호출하고, 그 결과를
기존 `$gateExit`(→ 기존 `SEAT_PROOF_REJECTED` 분기)에 그대로 접는다 —
새 exit 코드·새 분기 없음.

**앵커**: `Invoke-SeatProofGate` 함수 안, 기존 seat-proof CLI 호출의 출력
처리 줄(원문 525행 `foreach ($line in @($gateOut)) { Write-Host "      $line" }`)
직후, `return $gateExit`(원문 526행) 직전.

**앵커 유일성 실측(읽기 전용)**: 이 정확한 텍스트(`  foreach ($line in
@($gateOut)) { Write-Host "      $line" }`, 앞 공백 2칸 포함)를 파일
전체(717줄)에서 문자열 완전일치로 센 결과 — **정확히 1회**(525행). 명령:

```text
$lines = Get-Content 'D:\문서관리\하네스-관제실\dispatch-worker.ps1'
$anchorText = '  foreach ($line in @($gateOut)) { Write-Host "      $line" }'
($lines | Where-Object { $_ -eq $anchorText }).Count
```

→ `1`(2026-09-01 실측, 위 §0 원문 대조 그대로).

```control-room-patch-unit
id: hyk271-modal-check-wire
mode: insert_after
@@ANCHOR@@
  foreach ($line in @($gateOut)) { Write-Host "      $line" }
@@CONTENT@@

  # HYK-271(2026-09-01, HYK-271-wire-1 -- docs/control-room-patches/HYK-271-preflight-preview-marker.md
  # §2/§2-a): 좌석 증명 게이트가 이미 통과했을 때만(先행 게이트가 이미
  # 비0이면 그대로 그 사유로 거부되므로 여기서 또 돌 이유가 없다), 같은
  # $tsShowPath로 사이드카 모달 검사기를 부른다 -- 추가 orca 조회 0, 기존
  # $gateExit 하나에 그대로 접는다(새 exit 코드·새 분기 없음, design doc
  # "두 게이트 중 하나라도 비0이면 기존 SEAT_PROOF_REJECTED 분기에 그대로
  # 올라탄다" 그대로).
  if ($gateExit -eq 0) { & node (Join-Path $Worktree "scripts/relay/dispatch-worker-modal-check.mjs") --terminal-show $tsShowPath 2>&1 | ForEach-Object { Write-Host "      $_" }; $gateExit = $LASTEXITCODE }
@@END@@
```

**개수 확인**: 위 1개가 이 문서의 진짜 추출 대상 전부다(§0/§1 상단의
설명용 인용은 ` ```text ` 펜스라 세지 않는다 — HYK-327 §5 "naive
grep은 신뢰하지 마라" 원칙 그대로, 권위 있는 계수는 §2의 도구 실행 자체).

---

# §2 저장소 쪽 실측 — 도구로 「문서 → 적용본」을 직접 재현

## 명령 (이 라운드 CODER 좌석이 직접 실행, `--source`는 §0의 읽기 전용

저장소 사본, `--out`은 워크트리 임시 경로 — 관제실 실물은 손대지 않음)

```text
node scripts/check/control-room-patch-apply.mjs \
  --doc docs/control-room-patches/HYK-271-wire-modal-check.md \
  --source scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-before.ps1.txt \
  --out scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt
```

## 실측 결과

```text
control-room-patch-apply: OK -- wrote scripts/check/fixtures/control-room-dispatch-worker-2026-09-01-hyk271-wire-applied.ps1.txt (49319 bytes, 725 lines)
```

- 입력(717줄) → 출력(725줄): **+8줄**(추가한 CONTENT은 8개 물리줄 —
  빈 줄 1 + 주석 6 + 코드 1; 코드 자체는 "정확히 1줄"이라는 design doc
  요구를 물리적 1줄로 만족한다, 주석/빈 줄은 설명이지 결선 로직이
  아니다).
- 이후 §3의 파싱 검사(`PARSE_OK`)까지 통과한 결과만 이 문서에 「기대
  diff」로 남긴다(아래).

## 실제 diff (§2 명령 실행 후 `diff <원본> <적용본>`의 있는 그대로의 출력 -- 손으로 옮겨 적지 않았다)

```diff
525a526,533
>   # HYK-271(2026-09-01, HYK-271-wire-1 -- docs/control-room-patches/HYK-271-preflight-preview-marker.md
>   # §2/§2-a): 좌석 증명 게이트가 이미 통과했을 때만(先행 게이트가 이미
>   # 비0이면 그대로 그 사유로 거부되므로 여기서 또 돌 이유가 없다), 같은
>   # $tsShowPath로 사이드카 모달 검사기를 부른다 -- 추가 orca 조회 0, 기존
>   # $gateExit 하나에 그대로 접는다(새 exit 코드·새 분기 없음, design doc
>   # "두 게이트 중 하나라도 비0이면 기존 SEAT_PROOF_REJECTED 분기에 그대로
>   # 올라탄다" 그대로).
>   if ($gateExit -eq 0) { & node (Join-Path $Worktree "scripts/relay/dispatch-worker-modal-check.mjs") --terminal-show $tsShowPath 2>&1 | ForEach-Object { Write-Host "      $_" }; $gateExit = $LASTEXITCODE }
```

(정직 정정: 이 절의 초안은 삽입 블록 맨 앞에 빈 줄 하나가 `+`로 남을
것으로 손으로 추측해 적었으나, 실제 도구 실행 결과 그 빈 줄은 diff에
나타나지 않았다 -- 위는 §2 명령을 실제로 실행해 나온 출력 그대로다.
원본 717줄 → 적용본 **725줄**(+8줄, 전부 앵커 525행 직후 삽입) —
49319 bytes.)

---

# §3 검증 (이 라운드 직접 실행, 전부 실측 — 미실행 항목 없음)

1. **적용**: §2 명령 실행 → 실측 `control-room-patch-apply: OK -- wrote
...applied.ps1.txt (49319 bytes, 725 lines)`, exit 0.
2. **바이트 확인**: `diff <원본> <적용본>` 실행 결과가 §2의 diff와
   정확히 일치(위 §2 "실제 diff"가 바로 그 출력).
3. **파싱 검사**: `[System.Management.Automation.Language.Parser]::ParseFile(<적용본>, [ref]$tokens, [ref]$errors)`
   실행 → **`PARSE_OK`**(`$errors.Count -eq 0`, 2026-09-01 실측).
4. **앵커 유일성 재확인**: 적용본에서 `dispatch-worker-modal-check.mjs`
   문자열을 담은 줄이 **정확히 1회**(`Select-String -SimpleMatch` 실측,
   count=1) — 중복 삽입 없음.
5. **겹침 없음**: 이 문서의 추출 단위는 1개뿐이므로 `ANCHOR_OVERLAP`은
   구조적으로 발생할 수 없다(단위가 2개 이상일 때만 의미 있는 검사) —
   실행하지 않아도 참인 구조적 사실이며, 도구 자신도 실제로 `OK`를
   반환해 이 사실과 모순되지 않는다.

## 되돌리는 법 (ORCH 적용 후, 필요 시)

이 패치는 **삽입 1개**(원래 있던 줄을 지우거나 바꾸지 않는다 —
`mode: insert_after`)이므로 되돌리기는 그 삽입 블록(위 diff의 `+`로
시작하는 8줄, `$gateOut`을 Write-Host로 출력하는 기존 줄과 `return
$gateExit` 사이)만 지우면 원본과 바이트 동일로 복원된다. ORCH의 표준
절차(HYK-327 §7과 동일):

1. 적용 직전 원본을 `dispatch-worker.ps1.bak-hyk271-wire-<타임스탬프>`로
   복사(백업).
2. 위 §2 도구로 적용본을 만들고 파싱 검사까지 통과한 뒤에만 실물
   경로에 덮어쓴다.
3. 되돌릴 때는 1단계 백업 사본으로 실물을 덮어쓰거나(가장 단순), 위
   diff의 8줄 삽입 블록만 수동으로 제거해도 된다 — 두 경로 모두
   `Get-FileHash`로 원본 SHA-256(`4E16E2E4...`)과 다시 일치하는지
   확인한다.

---

# §4 이 결선이 「여전히 못 막는 것」 (design doc §3 그대로 인용, 재하향 없음)

- MODAL_MARKERS 카탈로그가 실제 사고 문구와 얼마나 일치하는지 미검증.
- 재그림 절단 위음성은 이 결선을 달아도 **여전히 놓친다**
  (`scripts/relay/dispatch-worker-modal-check.test.mjs`의 "KNOWN MISS"
  시험이 코드로 고정한 것과 정확히 같은 한계 -- 결선은 감지 로직을
  바꾸지 않았다, 호출 위치만 만들었다).
- `axis-heartbeat-absence`(2차 안전망)는 이 결선 범위 밖이다 -- 오늘도
  관측자가 없다(design doc §1-c).
- claude 경로("감지 후 중단·경보")는 이미 `dispatch --inject`로 텍스트가
  들어간 뒤다 -- 완전한 사전 차단은 claude 경로에서 구조적으로
  불가능하다(HYK-299 기존 한계, 이 라운드가 만든 제약이 아니다).
- 이 문서의 §2 실측은 **저장소 안 읽기 전용 사본**을 `--source`로 쓴
  것이다 -- 관제실 실물 파일에 실제로 이 패치가 적용된 적은 없다(그
  적용·`parse_errors` 재확인·3자 지문 대조·발동 관측은 ORCH + S7
  검토 + 사람의 몫, coder-task.md §2⑶).
