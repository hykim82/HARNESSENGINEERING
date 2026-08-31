# HYK-271 1R 패치 «제안» 문서 — preview 마커 대조를 기존 좌석 증명 게이트에 얹는다

★이 문서는 **제안**이다 — 적용은 ORCH + S7 강화판 검토 뒤, 사람이 한다. 이 라운드는 코드로 관제실을 고치지 않는다(coder-task.md §2 ⑶).

## 0. 이 문서가 답하는 질문과 답하지 않는 질문

- **답한다**: 4개(+2개, 아래 §1) 후보 축 중 **어느 것을 믿을지**, 그 근거가 «실측»인지, **어디에** 꽂으면 배달 «전»에 거부되는지.
- **답하지 않는다**: 실제 관제실 파일 수정. `dispatch-worker.ps1`(SHA-256 `4E16E2E458E98A6E9C47074D011BD5F9554412A608C8C3C6BC7116DBCD0B2482`, 717줄 — `Get-FileHash`/`(Get-Content).Count` 직접 실측, 2026-08-31)은 **한 글자도** 이 문서로 고치지 않는다. 아래 §3의 결론이 실은 "이 파일은 patch-unit이 아예 필요 없다"는 것이다(이유는 §3).

## 1. 축 선택 — «axis-orca-query-preview» + «axis-heartbeat-absence» 조합, 단독 아님

병합된 인벤토리(`scripts/check/hyk271-modal-detect-inventory.json`)의 신뢰도(3R 상태, 이 라운드가 손대지 않음): 6개 축 중 **«확실»은 1개뿐**이고 그 1개(`axis-result-file-silence`)는 **"이 축은 구별 못 한다"는 부정 명제**에 «확실»이 붙은 것이다(can_indicate_modal=불가, distinguishes_idle=불가(이슈 본문이 지적하는 구멍 그 자체)) — 즉 **"모달을 긍정 검출할 수 있다"는 방향으로 «확실»인 축은 지금도 0개**다. task 파일 §2가 말한 "4개 중 확실 0개"는 이 라운드 드롭 시점 서술이 4개만 언급했을 뿐, 실제 병합본은 이미 6개다(축 목록 자체는 이 라운드가 바꾸지 않았다 — 실측 그대로 옮김).

**⑴ 이 라운드가 고른 축 = `axis-orca-query-preview`(마커 부분일치)를 1차 신호로, `axis-heartbeat-absence`(부재 타임아웃)를 2차 안전망으로 쓰는 조합.**

### 근거 — «실측», 합성 표본 (신규 이 라운드 증거)

`scripts/relay/hyk271-axis-preview-marker-synthetic.test.mjs`(이번 라운드 신설, `npm test`에 이미 편입됨 — `scripts/check/*`는 `scripts/relay/*`를 import할 수 없다는 A3 의존 방향 규칙(HYK-148, eslint `no-restricted-imports`) 때문에 `scripts/check/`가 아니라 `scripts/relay/`에 둔다)가 실측한 것:

- **재사용, 재구현 안 함**: `normalizePreview`/`previewContainsMarker`는 `scripts/relay/adapters/orca-adapter.mjs`(이미 병합, evidence_kind=동작코드)에서 그대로 import — 새 대조 로직을 쓰지 않았다(선례 준수).
- **합성 표본 9개**로 idle/busy/modal 3분류를 실제로 실행해 관찰:
  - idle 셸 프롬프트, 빈 preview, "esc to interrupt" 작업중 신호, "Press up to edit queued messages" 큐 신호, **모달 낱말을 우연히 포함한 정상 대화문**("Should I proceed...") → **전부 «모달 아님»으로 정확히 분류**(적대적 오탐 표본 포함, 0건 오탐 실측).
  - claude 권한모달 전문("Do you want to proceed? 1. Yes 2. Yes, and don't ask again...")과 codex 승인모달 전문("Allow command? [y/N] ...") → **정확히 «모달»로 분류**.
  - 셸 예측입력 재그림으로 공백이 흩어진 변형(정규화로 흡수됨) → **정확히 «모달»로 분류**(정규화가 실제로 이 흔들림을 흡수함을 실측).
- **측정된 한계(추정이 아니라 재현된 실패)**: 마커 단어 중간이 제어문자로 끊긴 표본(재그림 절단의 합성 재현) → **위음성**(모달인데 «아님»으로 분류). `normalizePreview`는 공백만 접을 뿐 단어 내부 절단은 복구하지 않는다는 것도 별도 검증(테스트 2번째 케이스).

⇒ **결론**: 이 축은 _"마커 전문이 preview에 온전히 실릴 때"_ 는 idle/busy와 확실히 구별한다(실측, 오탐 0/9). 그러나 _"마커가 재그림에 걸려 절단될 때"_ 는 위음성이 난다는 것도 같은 정도로 확실히 측정됐다(합성 재현 1건). **이 축 단독으로 confidence를 «확실»로 올리는 것은 정당화되지 않는다** — 정직하게는 "온전한 텍스트 조건부 확실, 절단 조건에서는 미해결"이다.

**⑵ 왜 조합인가**: 이 문제(HYK-271 완료조건 1 "거부되거나 경보")는 정확히 **위음성이 곧 사고**인 유형이다(모달을 놓치면 배달이 삼켜진다 — 이슈 본문 그대로). 위음성 위험이 «측정»된 축을 단독으로 fail-closed 게이트에 앉히는 것은 무책임하다. 이미 병합된 인벤토리의 `axis-heartbeat-absence`(추론, 구조설명 — orca 프로토콜에 `last_heartbeat_at` 필드가 실재함은 이 세션이 이미 실행한 `dispatch-show` 응답으로도 확인됨, §1 dispatch 검증 참조)는 **정지 원인을 모르지만 "뭔가에 멈췄다"는 것은 잡는다** — preview 마커가 절단으로 놓친 경우도 결국 워커 실행 흐름이 멈춰 있으므로 heartbeat 부재로 뒤늦게라도 걸린다. 1차(빠른 거부, 배달 전) + 2차(느린 안전망, 배달 후 타임아웃)의 **역할이 다른 조합**이지 "둘 다 확실해서 더한다"가 아니다 — 이 구분을 흐리지 않는다.

## 2. ★못 고른 것 — 이번 라운드가 «검증하지 않은» 것 (정직 한계)

- 실제 claude/codex 승인모달의 **repo 추적 실물 텍스트**가 이 저장소에 없다(HYK-379가 인용하는 사고는 _업데이트-확인_ 모달이지 _명령-승인_ 모달이 아니다 — 3R 근거가 이미 이 일반화를 금지함). §1의 MODAL_MARKERS 카탈로그는 **공개적으로 알려진 형태를 손으로 지은 것**이지 이 저장소가 겪은 실제 사고의 인용이 아니다. → **실제 마커 문구는 라이브 좌석에서 사람이 1회 목격·채증해야 확정된다**(좌석 조작 0 원칙상 이 라운드가 만들 수 없는 증거).
- 재그림 절단이 **실제로 얼마나 자주** 일어나는지(빈도) 측정하지 않았다 — 합성 표본은 "일어나면 놓친다"만 보였지 "얼마나 자주 일어나는가"는 답하지 않는다. 빈도가 낮으면 heartbeat 2차망으로 충분하고, 높으면 이 축 자체의 채택을 재고해야 한다.
- heartbeat 부재 타임아웃의 **적정 임계값**(몇 분?)은 정하지 않았다 — worker-dispatch-rule.md의 5분 주기 heartbeat 계약을 참고값으로만 언급한다.

## 3. 최소 결선 설계 (문서 — 이번 라운드는 구현하지 않음)

### 왜 `dispatch-worker.ps1`에 새 patch-unit이 «필요 없는가» (핵심 발견)

`dispatch-worker.ps1`은 이미 **모든 배달 직전에 `orca terminal show --terminal $handle --json`을 실행해 `$tsShowPath`에 저장하고**(717줄 중 505행, `Invoke-SeatProofGate` 내부), 그 파일 경로를 저장소 CLI(`scripts/relay/dispatch-worker-seat-proof-gate.mjs`)에 `--terminal-show`로 넘겨 **판정을 CLI에 위임**한 뒤 **종료코드로만 분기**한다(HYK-299 선례, "관제실은 얇은 껍데기"). codex 경로는 이 게이트가 거부하면 **`terminal send`(실제 배달)가 아예 실행되지 않는다**(556행 근처 — "진짜 거부") · claude 경로는 `dispatch --inject`가 배정+시작을 한 번에 하므로 게이트는 **감지 후 중단·경보만** 한다(이미 병합된 설계, 이 라운드가 만든 게 아니다).

⇒ 이미 있는 이 훅 지점에 **모달 마커 검사를 얹기만 하면**, `dispatch-worker.ps1`은 **한 줄도 바뀌지 않는다** — 바뀌는 것은 저장소가 추적하는 `.mjs` 파일뿐이다(이건 "관제실 라이브 파일"이 아니라 이 워크트리 자신의 코드다).

### 실제로 바뀌어야 할 지점 (저장소 파일, 코드 아님 — 설계만)

1. **새 게이트**(가칭 `scripts/relay/dispatch-worker-modal-check.mjs`) — `scripts/relay/dispatch-worker-seat-proof-gate.mjs`를 고치지 않는다(그 파일은 "terminal-show 내용을 열어서 읽지 않는다"는 것 자체가 계약 — §헤더 주석 실측 확인, 656). **별도 새 함수**로 만든다.
   - 입력: `--terminal-show <path>`(이미 `$tsShowPath`로 존재하는 바로 그 파일 — **추가 orca 조회 0**).
   - 로직: `readFileSync` → JSON 파싱 → `result.terminal.preview` 추출(`parseSeatPreview`와 **동일 모양**, 재사용) → `normalizePreview` → `MODAL_MARKERS`(§1의 카탈로그, §2에 밝힌 대로 잠정치) 부분일치.
   - 출력: 마커 매치 시 exit 2(DRIFT류 fail-closed 관례 계승, `seat-preflight.mjs`의 0/1/2 계약과 정신 일치) + 매치된 마커 문자열을 stderr에 사람이 읽을 문장으로.
2. **ps1 쪽 변경**(제안, 미적용): `Invoke-SeatProofGate` 함수 안에서, 기존 seat-proof CLI 호출 **직후** 같은 `$tsShowPath`를 인자로 새 게이트를 1회 더 호출하고, **두 게이트 중 하나라도 비0이면** 기존 `SEAT_PROOF_REJECTED` 분기를 그대로 재사용(이미 codex=진짜 거부/claude=감지 후 중단·경보로 분기돼 있다 — 이슈 완료조건 1 "거부되거나 경보"가 이미 이 두 갈래로 존재한다). **새 분기·새 exit 코드를 추가하지 않는다** — 기존 계약에 올라탄다.
3. **2차 안전망**(heartbeat-absence)은 dispatch-worker.ps1 범위 밖이다 — 배달 후 감시는 별도 감시 프로세스(pull-supervisor 계열, 이미 존재하는 감시 축) 몫이며, 이 라운드는 "그 감시가 heartbeat 부재를 이 목적으로 아직 안 쓴다"는 관찰만 남긴다(설계까지는 이 라운드 범위 밖 — 1R은 축 선택이 과제다).

### 선례 적용 (책임자 조건 ②, task §3)

- **워크트리 축(HYK-400)**: 새 게이트는 `--terminal-show <path>`가 없으면(파일 없음/읽기 실패) **exit 2로 fail-closed**해야 한다(파일이 없는 워크트리에서 자동으로 "통과"로 접히면 안 된다) — `seat-preflight.mjs`의 `foldEmptyComparisonToUndecidable` 패턴과 동형.
- **«설치 사본» 축(오늘 판례)**: 이 설계는 훅류(버전관리 vs 설치 사본 괴리)를 다루지 않는다 — `dispatch-worker.ps1`은 매 실행 항상 실시간으로 `orca terminal show`를 다시 호출하므로 "설치된 낡은 사본" 개념 자체가 없다(정직하게 무관함을 명시).

## 4. ⚠️ 정직 — 이 제안이 «못» 하는 것

- MODAL_MARKERS 카탈로그가 **실제 사고 문구와 얼마나 일치하는지 미검증**(§2).
- 절단 위음성의 **실빈도 미측정** — heartbeat 2차망이 "충분한 안전망"인지 "구색 맞추기"인지 이 라운드는 판정하지 않는다.
- claude 경로("감지 후 중단·경보")는 **이미 `dispatch --inject`로 텍스트가 들어간 뒤**다 — 이 설계는 "먼저 막는다"가 아니라 "이미 들어간 것을 감지하고 그 라운드를 더 진행하지 않는다"는 기존 HYK-299 계약을 그대로 물려받는다. 완전한 사전 차단은 claude 경로에서 구조적으로 불가능하다(HYK-299 문서가 이미 밝힌 한계, 이 라운드가 새로 만든 제약이 아니다).
