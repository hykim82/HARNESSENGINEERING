# HYK-271 패치 «제안» 문서 — preview 마커 대조를 기존 좌석 증명 게이트에 얹는다

★이 문서는 **제안**이다 — 적용은 ORCH + **S7 강화판 검토** 뒤, 사람이 한다. 이 라운드는 코드로 관제실을 고치지 않는다(coder-task.md §2 ⑶).

**2R 정정 고지**: 1R 문서는 §0/§3에서 "patch-unit 0개"·"ps1 한 줄도 안 바뀐다"고 썼다가 같은 문서 §3 안에서 "ps1 쪽 변경(제안)"을 다시 적어 **스스로 모순**됐다(검토 P1-1). 이번 판은 그 모순을 없애고 **정확히 무엇이 필요한지 하나로 확정**한다 — 답은 "0개"가 아니라 **"ps1에 정확히 1줄, 관제실 라이브 파일 변경 = S7 대상"**이다. 1R의 "필요 없다"는 검증하지 않은 채 강한 문장을 쓴 것이었다(coder-task.md 2R §4 "«무엇이 필요 없다»류는 검증한 것만 써라" 규율 위반 — 이번 판은 이 규율을 지킨다).

## 0. 이 문서가 답하는 질문과 답하지 않는 질문

- **답한다**: 후보 축 중 어느 것을 믿을지(§1), preview 마커 축의 위음성을 heartbeat-absence가 실제로 덮는지 «측정»한 결과(§1-c, 2R 신규), 결선에 정확히 무엇이 필요하고 그것이 S7 대상인지(§3).
- **답하지 않는다**: 실제 관제실 파일 수정. `dispatch-worker.ps1`(SHA-256 `4E16E2E458E98A6E9C47074D011BD5F9554412A608C8C3C6BC7116DBCD0B2482`, 717줄 — `Get-FileHash`/`(Get-Content).Count` 직접 실측, 2026-08-31)은 이 문서로 고치지 않는다 — **다만 실제 결선 시 그 파일이 반드시 바뀐다는 것은 이 문서가 명시한다**(§3, 1R처럼 "안 바뀐다"고 적지 않는다).

## 1. 축 선택 — «axis-orca-query-preview» + «axis-heartbeat-absence» 조합, 단독 아님

병합된 인벤토리(`scripts/check/hyk271-modal-detect-inventory.json`)의 신뢰도(3R 상태, 이 라운드가 손대지 않음 — 인벤토리 JSON 자체 수정은 별건 HYK-405 소관): 6개 축 중 **«확실»은 1개뿐**이고 그 1개(`axis-result-file-silence`)는 **"이 축은 구별 못 한다"는 부정 명제**에 «확실»이 붙은 것이다 — 즉 "모달을 긍정 검출할 수 있다" 방향으로 «확실»인 축은 지금도 0개다.

**⑴ 이 라운드가 고른 축 = `axis-orca-query-preview`(마커 부분일치)를 1차 신호로, `axis-heartbeat-absence`(부재 타임아웃)를 2차 안전망으로 쓰는 조합.** (1R 선택, 검토가 "정당"으로 인정 — 이 선택 자체는 재론하지 않는다, coder-task.md §0 "축을 다시 고르지 마라".)

### 근거 — «실측», 합성 표본 (1R 증거, 표현만 2R에서 교정)

`scripts/relay/hyk271-axis-preview-marker-synthetic.test.mjs`가 실측한 것:

- **재사용, 재구현 안 함**: `normalizePreview`/`previewContainsMarker`는 `scripts/relay/adapters/orca-adapter.mjs`(이미 병합, evidence_kind=동작코드)에서 그대로 import.
- **분류기는 boolean이다(2R 정정 — P1-3)**: `classifyPreviewForModal`은 **modal / non-modal 2분류**만 반환한다. idle과 busy는 둘 다 "모달 아님"이라는 **같은 결과**로 접힌다 — **idle과 busy를 서로 구별하는 3분류가 아니다.** 1R 문서는 "idle/busy/modal 3분류를 실행해 관찰"이라고 썼는데, 이는 표본의 *라벨*이 3종류였다는 것과 분류기의 *출력*이 3종류라는 것을 섞은 과장이었다(검토 P1-3). 이번 판은 주장을 **modal/non-modal 2분류**로 낮춘다(coder-task.md §2 ⓷ "둘 중 하나만" — 3분류 구현이 아니라 주장 하향을 택함: idle과 busy를 실제로 구별할 신호는 이 저장소에 별도로 없고, 이 축의 목적(배달 전 거부)에도 그 구별이 필요하지 않다).
- **합성 표본 9개**로 modal/non-modal 2분류를 실제로 실행해 관찰:
  - idle 셸 프롬프트, 빈 preview, "esc to interrupt" 작업중 신호, "Press up to edit queued messages" 큐 신호, 모달 낱말을 우연히 포함한 정상 대화문("Should I proceed...") → **전부 «모달 아님»으로 정확히 분류**(적대적 오탐 표본 포함, 0건 오탐 실측).
  - claude 권한모달 전문과 codex 승인모달 전문 → **정확히 «모달»로 분류**.
  - 셸 예측입력 재그림으로 공백이 흩어진 변형(정규화로 흡수됨) → **정확히 «모달»로 분류**.
- **측정된 한계(추정이 아니라 재현된 실패)**: 마커 단어 중간이 제어문자로 끊긴 표본(재그림 절단의 합성 재현) → **위음성**(모달인데 «아님»으로 분류).

⇒ **결론**: 이 축은 "마커 전문이 preview에 온전히 실릴 때"는 modal/non-modal을 확실히 구별한다(실측, 오탐 0/9). "마커가 재그림에 걸려 절단될 때"는 위음성이 난다는 것도 같은 정도로 확실히 측정됐다(합성 재현 1건).

## 1-b. ★못 고른 것 — 이번 라운드가 «검증하지 않은» 것 (정직 한계)

- 실제 claude/codex 승인모달의 **repo 추적 실물 텍스트**가 이 저장소에 없다 — MODAL_MARKERS 카탈로그는 공개적으로 알려진 형태를 손으로 지은 것이지 이 저장소가 겪은 실제 사고의 인용이 아니다.
- 재그림 절단이 **실제로 얼마나 자주** 일어나는지(빈도)는 여전히 측정하지 않았다 — §1-c는 "절단이 일어났을 때 heartbeat이 덮는가"를 측정한 것이지 "절단이 얼마나 자주 일어나는가"는 별개 질문이며 여전히 미측정이다.

## 1-c. ★조합의 실효성 «측정» (2R 신규 — 검토 P1-2 fix, 이 판의 본체)

**질문**: preview 마커 축이 절단으로 놓친 표본을, 2차 축인 `axis-heartbeat-absence`가 실제로 잡는가?

**실측(그라운드 트루스, 부정적)**: 이 저장소를 `git grep -l "last_heartbeat_at" -- scripts`로 전수 조사(2026-08-31, `scripts/relay/hyk271-axis-heartbeat-absence-synthetic.test.mjs`의 세 번째 시험이 이 grep 결과를 코드로 고정) — **결과가 스키마 선언 파일(`scripts/relay/contracts/seat-proof-contract-v1.mjs`, nullable-field 목록) 1건뿐**이다. **heartbeat를 관측하거나, 부재를 판정하거나, 경보를 울리는 프로덕션 코드는 0건.** 1R이 "heartbeat 부재로 뒤늦게라도 걸린다"고 쓴 문장은 **관측/판정/경보 셋 중 아무것도 존재하지 않는 상태에서 나온 결론이 아니라 희망**이었다는 검토 지적(P1-2)이 실측으로 확인된다.

⇒ **오늘 시점의 사실**: `axis-heartbeat-absence`는 **아무것도 잡지 않는다** — 잡을 관측자 자체가 없다.

**조건부 측정(2R 신규)**: "만약" 그 관측자가 이 저장소가 **이미 가진** 범용 신선도 판정 원시함수(`scripts/supervisor/watch-freshness-core.mjs`의 `judgeWatchFreshness` — 다른 자기생존 축을 위해 이미 병합된 코드, 이번 판은 이것을 재사용만 하고 재구현하지 않는다, 선례 준수)로 만들어진다면, "둘 다 놓치는 구간"의 크기는 **정확히 측정 가능**하다 — `judgeWatchFreshness`의 ALIVE→STALE 경계를 이진탐색으로 직접 읽어(`scripts/relay/hyk271-axis-heartbeat-absence-synthetic.test.mjs`, "both-miss gap size ..." 시험) 확인:

| 가정한 `staleAfterSeconds` (★가정, 저장소 결정 아님) | 근거                                                                                                                                                                           | 측정된 사각 크기                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 300초                                                | `worker-dispatch-rule.md`가 명시한 heartbeat 주기(5분)를 그대로 문턱으로 쓴 경우                                                                                               | ALIVE→STALE 전환 = **정확히 301초째**(0~300초는 ALIVE, 301초부터 STALE — `judgeWatchFreshness`의 경계 포함 비교 `ageSeconds<=staleAfterSeconds`가 그렇게 정의함, 반올림·추정 아님) |
| 900초                                                | 이 저장소가 **다른** 자기생존 축(`scripts/supervisor/schedule-wire.mjs`의 `DEFAULT_STALE_AFTER_SECONDS = 900`, "등록 주기의 여러 배" 관행)에 이미 쓰는 값을 그대로 가져온 경우 | ALIVE→STALE 전환 = **정확히 901초째**                                                                                                                                              |

**정직 한계(그대로 남긴다)**:

- 위 표는 "이 축이 이렇게 만들어진다면"이라는 조건부다 — **어느 문턱을 쓸지는 이 저장소가 아직 결정한 바 없다**(★가정 그대로 표기).
- `judgeWatchFreshness`가 실제로 `last_heartbeat_at`에 연결된 사례는 0건이다 — 이 측정은 "연결하면 사각이 몇 초인지"를 답할 뿐, "연결돼 있다"고 주장하지 않는다.
- heartbeat 축의 신뢰도 근거는 여전히 **"필드 존재 확인(dispatch-show 응답에 `last_heartbeat_at`이 실재)" + "비권위 조건부 계산(위 표)"뿐**이다 — 관측·판정·경보가 실배선된 **권위 있는 실측**이 아니다. 강한 문장을 만들지 않는다(coder-task.md §2 ⓶의 경고 그대로 반영).
- 절단이 일어난 뒤 "몇 초짜리 사각"이 실제로 몇 번 발생하는지(빈도 × 사각크기 = 총 위험도)는 이 판도 답하지 않는다(§1-b에 남긴 대로).

## 2. 최소 결선 설계 — 정확히 무엇이 필요한가 (2R 정정, 모순 제거)

### 2R 결론: **"patch-unit 0개"는 틀렸다** — ps1에 **정확히 1줄**이 필요하고, 이것은 **S7 대상**이다

검토가 지적한 그대로(P1-1) 인용: `Invoke-SeatProofGate` 함수는 503~505행에서 `terminal show` 캡처 경로(`$tsShowPath`)를 만들고, **523행에서 기존 seat-proof CLI 게이트 단 하나만 부른다**. 새 모달 검사기를 추가하면, **그 검사기를 호출하는 코드가 어딘가에 반드시 새로 생겨야 한다** — 그 호출은 `dispatch-worker.ps1` 자신(새 함수 호출 1줄) 아니면 그 함수가 이미 부르는 대상(`scripts/relay/dispatch-worker-seat-proof-gate.mjs`) 둘 중 하나에 들어간다. **"둘 다 안 바뀐다"는 선택지는 없다** — 1R은 이 선택을 하지 않고 "0개"라고만 썼다.

**둘 중 하나를 고른다(2R이 확정)**: **기존 게이트 확장이 아니라 ps1에 새 호출 1줄을 추가**하는 쪽을 택한다.

- **이유**: `scripts/relay/dispatch-worker-seat-proof-gate.mjs`는 스스로 "terminal-show/dispatch-show 파일의 *내용*을 열어서 읽지 않는다"는 것이 문서화된 계약이다(파일 헤더 주석 실측 확인 — `buildExpected`는 fs를 아예 import하지 않는다). 이 게이트를 확장해 preview 내용을 읽게 만드는 것은 **그 파일 자신의 계약을 깨는 것**이라 "기존 게이트 확장"은 기각한다.
- **대신**: 저장소에 **새 사이드카 스크립트**(가칭 `scripts/relay/dispatch-worker-modal-check.mjs`, 아래 §2-a)를 추가하고, **`dispatch-worker.ps1`의 `Invoke-SeatProofGate` 함수 안에** 기존 seat-proof CLI 호출 **직후 새 호출 1줄**을 추가해 같은 `$tsShowPath`를 넘긴다. 두 게이트 중 하나라도 비0이면 기존 `SEAT_PROOF_REJECTED` 분기(codex=진짜 거부/claude=감지 후 중단·경보)에 그대로 올라탄다 — **새 분기·새 exit 코드는 만들지 않는다.**

**★이것은 관제실 라이브 파일(`dispatch-worker.ps1`) 변경이다 — S7 강화판 검토 대상이다.** 필요한 절차(1R 문서가 "필요 없다"고 잘못 적었던 것과 반대): 원본 사본의 SHA-256 지문 보관, 앵커 유일성 확인(`Invoke-SeatProofGate` 함수 안에 대상 줄이 정확히 1곳뿐인지), 패치 적용 뒤 diff 육안 확인, `parse_errors=0` 확인, 사람이 라이브 교체, 3자(원본/적용본/라이브) 지문 대조 — HYK-379/HYK-396/HYK-400 선례와 동일한 절차. 이 문서 자신은 그 절차를 수행하지 않는다(제안 문서 범위, coder-task.md §2 ⑶) — **"수행이 필요 없다"고 쓰지 않는다는 것이 이번 판의 정정이다.**

### 2-a. 새 사이드카 게이트의 설계 (문서 — 구현하지 않음)

- 입력: `--terminal-show <path>`(이미 `$tsShowPath`로 존재하는 파일 — 추가 orca 조회 0).
- 로직: `readFileSync` → JSON 파싱 → `result.terminal.preview` 추출(`parseSeatPreview`와 동일 모양, 재사용) → `normalizePreview` → `MODAL_MARKERS`(§1의 카탈로그, §1-b에 밝힌 대로 잠정치) 부분일치 → **modal/non-modal 2분류만 반환**(§1의 2R 정정 그대로 — 3분류를 약속하지 않는다).
- 출력: 마커 매치 시 exit 2(DRIFT류 fail-closed 관례 계승) + 매치된 마커 문자열을 stderr에.
- `--terminal-show <path>`가 없으면(파일 없음/읽기 실패) exit 2로 fail-closed(HYK-400 워크트리 축 선례 — `seat-preflight.mjs`의 `foldEmptyComparisonToUndecidable` 패턴과 동형).
- **2차 안전망(heartbeat-absence)은 이 사이드카·ps1 어느 쪽 범위에도 들지 않는다** — §1-c가 측정한 대로, 그 축은 오늘 관측자가 없고 배달 후 감시 프로세스(pull-supervisor 계열) 몫이며 이 라운드는 그 설계를 하지 않는다(축 재탐색·재설계 금지, coder-task.md §0).

### 선례 적용 (책임자 조건 ②)

- **워크트리 축(HYK-400)**: 위 2-a에 반영(파일 없음 → exit 2 fail-closed).
- **«설치 사본» 축**: 무관 — `dispatch-worker.ps1`은 매 실행 실시간으로 `orca terminal show`를 재호출하므로 "설치된 낡은 사본" 개념 자체가 없다.

## 3. ⚠️ 정직 — 이 제안이 «못» 하는 것 (갱신)

- MODAL_MARKERS 카탈로그가 실제 사고 문구와 얼마나 일치하는지 미검증(§1-b).
- 절단 위음성의 실빈도 미측정(§1-b) — §1-c가 답한 것은 "절단이 일어났을 때 사각이 몇 초인가"이지 "절단이 얼마나 자주 일어나는가"가 아니다. 이 둘을 곱해야 진짜 위험도가 나오는데, 이 판도 곱하지 않는다.
- `axis-heartbeat-absence`는 **오늘 실배선이 0건**이다(§1-c) — §1-c의 표는 조건부 계산이지 "지금 잡고 있다"는 뜻이 아니다.
- claude 경로("감지 후 중단·경보")는 이미 `dispatch --inject`로 텍스트가 들어간 뒤다 — 완전한 사전 차단은 claude 경로에서 구조적으로 불가능하다(HYK-299 기존 한계, 이 라운드가 만든 제약이 아니다).
- 이 문서가 제안하는 ps1 1줄 변경은 **설계만**이다 — 실제 diff·적용·S7 검토는 별도 라운드/사람 몫이다.
